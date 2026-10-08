/**
 * The pre-triage plan: what this batch will cost, decided before the expensive lane opens.
 *
 * Three inputs, none of them fetched here: the collection (`collection.mjs`), the ledger's own
 * batch-start plan (`tools/lib/triage-ledger-core.mjs#planBatch`, run by the caller so this module
 * never touches the ledger file), and - once the sweep has run - the fetch manifest. Two outputs: a
 * disposition per link, and the spend accounting that makes "measurable fetch-spend reduction" a
 * number the batch produces rather than a claim someone makes about it afterwards.
 *
 * The expensive lane is everything the pre-triage stage is trying not to spend: the rendered-page
 * browser, the full description extraction, and the scoring pass over it. A link this stage
 * disposes of never enters it.
 */
import { requestedUrl } from "../vacancy-fetch/url-rule.mjs";
import { assessCollection, collectionStaleAfterDays, orderNewestFirst } from "./freshness.mjs";
import { classifyLiveness, sweepFromManifest } from "./liveness.mjs";
import { fail } from "./errors.mjs";
import {
  sourceSetDigest,
  sourceSetMemberships,
  validateSourceSet,
} from "../triage-sources/source-set.mjs";

/** Where a link stands. The first four are decided before the sweep, the last three by it. */
export const dispositions = Object.freeze([
  "skipped_by_ledger",
  "duplicate_in_batch",
  "unreadable_link",
  "pending_sweep",
  "terminal_gone",
  "browser_rung",
  "expensive_lane",
]);
export const sourceDispositions = Object.freeze([
  "company_context",
  "source_contact",
  "source_snapshot",
  "source_summary",
]);

function countBy(rows, sourceMode) {
  const counts = Object.fromEntries(
    [...dispositions, ...(sourceMode ? sourceDispositions : [])].map((name) => [name, 0]),
  );
  for (const row of rows) counts[row.disposition] += 1;
  return counts;
}

function share(count, total) {
  return total === 0 ? 0 : Math.round((count / total) * 1000) / 1000;
}

/**
 * What the stage saved, split by what it saved and by who saved it.
 *
 * Two distinctions the first version of this function collapsed, and both of them mattered:
 *
 * - **A fetch and the expensive lane are not the same spend.** The adapter-layer run *is* the
 *   liveness sweep, so a swept-dead link was fetched exactly like every other. What it avoids is
 *   the browser load, the description extraction and the scoring pass — everything but the one
 *   closure quote. Only a link never handed to the fetch layer at all avoids the request too, and
 *   `never_fetched` is that number.
 * - **The ledger's saving is the ledger's.** `skip_closed` and `skip_known` come from
 *   `planBatch`, which is task 29's work and would remove those links with or without this stage.
 *   Reporting the sum as "what pre-triage saved" would credit this stage with it, so the two are
 *   named separately and `avoided_by_pretriage` counts only what this stage itself removed.
 *
 * An unreadable link is nobody's saving — it was never spendable — so it is in neither.
 */
function accountSpend(rows, { sourceMode = false } = {}) {
  const counts = countBy(rows, sourceMode);
  const supplied = rows.length;
  const byLedger = counts.skipped_by_ledger;
  const context =
    (counts.company_context ?? 0) + (counts.source_contact ?? 0) + (counts.source_summary ?? 0);
  const byPretriage = counts.duplicate_in_batch + counts.terminal_gone + context;
  const avoided = byLedger + byPretriage + counts.unreadable_link;
  return {
    supplied,
    ...counts,
    never_fetched:
      byLedger +
      counts.duplicate_in_batch +
      counts.unreadable_link +
      context +
      (counts.source_snapshot ?? 0),
    avoided_by_ledger: byLedger,
    avoided_by_pretriage: byPretriage,
    avoided_expensive_lane: avoided,
    avoided_share: share(avoided, supplied),
  };
}

/**
 * Plan a batch before the sweep.
 *
 * `ledgerPlan` is the object `planBatch` returned for the same links, in the same order. Its items
 * are matched by `input_index`, not by position, so a caller that reordered them cannot silently
 * shift the mapping.
 *
 * The returned `sweep.links` are the links to hand the fetch layer, **in that exact order**: the
 * manifest indexes its records by request position, and `applyLivenessSweep` re-checks that
 * agreement rather than trusting it.
 */
export function planPreTriage({
  collection,
  ledgerPlan,
  asOf,
  staleAfterDays = collectionStaleAfterDays,
  refetchKnown = false,
  sourcePlan,
} = {}) {
  if (collection === null || typeof collection !== "object" || !Array.isArray(collection.links)) {
    fail("pretriage_invalid_collection", "The collection must carry an array of links.");
  }
  if (ledgerPlan === null || typeof ledgerPlan !== "object" || !Array.isArray(ledgerPlan.items)) {
    fail("pretriage_invalid_ledger_plan", "The ledger plan must carry an array of items.");
  }
  if (ledgerPlan.items.length !== collection.links.length) {
    fail(
      "pretriage_ledger_plan_mismatch",
      "The ledger plan does not cover exactly the collection's links.",
    );
  }
  const freshness = assessCollection({
    collectedAt: collection.collected_at ?? null,
    asOf,
    staleAfterDays,
  });
  const byIndex = new Map(ledgerPlan.items.map((item) => [item.input_index, item]));
  const sourceSet =
    collection.source_set === undefined
      ? null
      : validateSourceSet(collection.source_set, { collectionText: collection.collection_text });
  if (
    sourceSet !== null &&
    (sourcePlan?.schema_version !== 2 ||
      sourcePlan.source_set_sha256 !== sourceSetDigest(sourceSet) ||
      !Array.isArray(sourcePlan.items))
  )
    fail(
      "pretriage_invalid_source_plan",
      "A source collection requires its validated logical ledger plan.",
    );
  const selectedRefs =
    collection.source_selection?.card_refs ?? sourceSet?.cards.map((card) => card.card_ref) ?? [];

  const rows = collection.links.map((link, position) => {
    const inputIndex = position + 1;
    const item = byIndex.get(inputIndex);
    if (item === undefined) {
      fail("pretriage_ledger_plan_mismatch", `The ledger plan has no item for link ${inputIndex}.`);
    }
    // The plan echoes the link it classified, so the join is checked rather than assumed: two lists
    // of equal length are otherwise indistinguishable, and a plan built from a different collection
    // would attach one vacancy's ledger answer to another's link.
    if (typeof item.link === "string" && item.link !== link.url) {
      fail(
        "pretriage_ledger_plan_mismatch",
        `The ledger plan item ${inputIndex} is about another link.`,
      );
    }
    const base = {
      input_index: inputIndex,
      url: link.url,
      // Carried, not dropped: the ordering reads it from the row, so a caller that has posting
      // instants gets the newest-first sort through the plan rather than only by calling
      // `orderNewestFirst` directly. No reader in this repository produces the field today.
      posted_at: link.posted_at ?? null,
      ledger_action: item.action,
      ledger_reason: item.reason ?? null,
    };
    if (sourceSet !== null) {
      const memberships = sourceSetMemberships(sourceSet, link.url);
      const active = memberships.filter((member) => selectedRefs.includes(member.card_ref));
      const sourceBase = { ...base, memberships, ledger_action: null, ledger_reason: null };
      if (!active.length && !memberships.length)
        fail("pretriage_invalid_source_plan", "A source URL has no explicit membership.");
      if (active.length === 0 || active.every((member) => member.role === "company_context"))
        return { ...sourceBase, disposition: "company_context", reason: "source_membership" };
      if (active.every((member) => member.role === "contact"))
        return { ...sourceBase, disposition: "source_contact", reason: "source_membership" };
      const jobs = active.filter((member) => !["company_context", "contact"].includes(member.role));
      if (!jobs.length)
        return { ...sourceBase, disposition: "source_contact", reason: "source_membership" };
      const actions = jobs.map((member) => {
        const matches = sourcePlan.items
          .flatMap((row) => row.sources ?? [])
          .filter(
            (source) =>
              source.card_ref === member.card_ref &&
              source.snapshot_ref === member.snapshot_ref &&
              source.anchor === member.anchor &&
              source.role === member.role &&
              source.url === member.url,
          );
        return matches.length === 1 ? matches[0].action : undefined;
      });
      if (actions.some((action) => action === undefined))
        fail(
          "pretriage_invalid_source_plan",
          "Logical source plan does not cover each active card.",
        );
      if (
        actions.length &&
        actions.every(
          (action) => action === "skip_closed" || (action === "skip_known" && !refetchKnown),
        )
      )
        return {
          ...sourceBase,
          disposition: "skipped_by_ledger",
          reason: "logical_baseline",
          logical_actions: actions,
        };
      if (jobs.every((member) => member.role === "original_post") && !freshness.sweep_required) {
        const full = jobs.some(
          (member) =>
            sourceSet.cards.find((card) => card.card_ref === member.card_ref).description_kind ===
            "full_description",
        );
        return {
          ...sourceBase,
          disposition: full ? "source_snapshot" : "source_summary",
          reason: "verified_collector_snapshot",
        };
      }
      // A legacy URL cache hit cannot decide a different card or suppress a new source snapshot.
      return { ...sourceBase, disposition: "pending_sweep", reason: null };
    }
    if (item.action === null) {
      return { ...base, disposition: "unreadable_link", reason: item.reason ?? "unreadable" };
    }
    // The ledger's own answer is read first, and only then the duplicate flag. Either way the link
    // costs no request, so the order changes nothing operationally - it decides *attribution*. A
    // second spelling of a link the ledger already reports closed would otherwise be credited to
    // this stage, which is the self-flattery the split accounting exists to prevent.
    if (item.action === "skip_closed") {
      return { ...base, disposition: "skipped_by_ledger", reason: item.action };
    }
    if (item.action === "skip_known" && refetchKnown !== true) {
      return { ...base, disposition: "skipped_by_ledger", reason: item.action };
    }
    // `planBatch` collapses the spellings the ledger's identity collapses - LinkedIn slugs, `utm_`
    // parameters, a trailing slash - which the skill's own dedup by full URL does not.
    if (item.duplicate_in_batch === true) {
      return { ...base, disposition: "duplicate_in_batch", reason: "duplicate_in_batch" };
    }
    return { ...base, disposition: "pending_sweep", reason: null };
  });

  const pending = rows.filter((row) => row.disposition === "pending_sweep");
  const ordering = orderNewestFirst(pending, { declaredOrder: collection.declared_order ?? null });

  return {
    ...(sourceSet === null
      ? {}
      : {
          schema_version: 2,
          source_set_sha256: sourceSetDigest(sourceSet),
          source_plan: sourcePlan,
          logical: { supplied: selectedRefs.length, cards: selectedRefs },
        }),
    as_of: asOf,
    freshness,
    ordering: {
      basis: ordering.basis,
      links: ordering.links.map((row, position) => ({
        order_position: position + 1,
        input_index: row.input_index,
      })),
    },
    sweep: {
      required: freshness.sweep_required,
      applied: false,
      links: ordering.links.map((row) => row.url),
    },
    links: rows,
    spend: accountSpend(rows, { sourceMode: sourceSet !== null }),
    // The freshness policy, enforced rather than advised: a collection that cannot prove it is
    // current does not get browser or model budget until a sweep has re-established liveness. A
    // fresh collection is free to proceed without one - under the current skill the adapter layer
    // sweeps every batch anyway, and this gate is what makes the old collection the exception.
    gate: {
      expensive_lane_open: !freshness.sweep_required,
      blocked_by: freshness.sweep_required ? ["sweep_required"] : [],
    },
  };
}

function observationsFrom({ manifest, manifests }) {
  if (manifest !== undefined && manifests !== undefined) {
    fail("pretriage_invalid_manifest_input", "Pass either one manifest or a list, not both.");
  }
  const list = manifests ?? (manifest === undefined ? undefined : [manifest]);
  if (!Array.isArray(list) || list.length === 0) {
    fail("pretriage_invalid_manifest_input", "The sweep needs at least one fetch manifest.");
  }
  // A batch longer than one invocation's 256-link ceiling arrives as several manifests, each
  // indexing its own records from 1. They are concatenated in invocation order, and the per-record
  // index is checked inside its own manifest - which is the only place it means anything.
  return list.flatMap((entry) => {
    const observations = sweepFromManifest(entry);
    return observations.map((observation, position) => {
      if (observation.index !== position + 1) {
        fail(
          "pretriage_manifest_link_mismatch",
          `A manifest record at position ${position + 1} carries index ${observation.index}.`,
        );
      }
      return observation;
    });
  });
}

/**
 * Fold the sweep's manifests into a plan, turning every `pending_sweep` row into its verdict.
 *
 * Pure: a new plan is returned and the argument is untouched, so a caller keeps the pre-sweep plan
 * as evidence of what the batch intended.
 *
 * The manifests are checked against the plan rather than trusted. Their records must cover exactly
 * the swept links, in that order, and each record's requested URL must be the same URL under the
 * same ADR 0012 rule; a manifest from another batch fails loudly here instead of quietly
 * re-labelling one vacancy with another's liveness.
 */
export function applyLivenessSweep(plan, { manifest, manifests } = {}) {
  if (plan === null || typeof plan !== "object" || !Array.isArray(plan.links)) {
    fail("pretriage_invalid_plan", "The plan must carry an array of links.");
  }
  if (plan.sweep?.applied === true) {
    fail("pretriage_sweep_already_applied", "This plan already carries a sweep.");
  }
  const observations = observationsFrom({ manifest, manifests });
  const swept = plan.ordering.links;
  if (observations.length !== swept.length) {
    fail(
      "pretriage_manifest_link_mismatch",
      `The sweep holds ${observations.length} records for ${swept.length} links.`,
    );
  }
  const byInputIndex = new Map();
  for (let position = 0; position < swept.length; position += 1) {
    const observation = observations[position];
    const row = plan.links.find((entry) => entry.input_index === swept[position].input_index);
    if (row === undefined || row.disposition !== "pending_sweep") {
      fail(
        "pretriage_manifest_link_mismatch",
        `Swept position ${position + 1} has no pending link.`,
      );
    }
    // The identity check has no escape for a record that carries no requested URL. Every link this
    // plan sweeps parsed as http(s) on the way in, so the layer records a requested URL for each of
    // them; a record without one is not a link this plan asked about, and treating the absence as
    // "nothing to compare" would make the whole join opt-out by omission.
    const expected = requestedUrl(row.url);
    if (typeof observation.url !== "string" || observation.url !== expected) {
      fail(
        "pretriage_manifest_link_mismatch",
        `The sweep record at position ${position + 1} is about another link.`,
      );
    }
    byInputIndex.set(row.input_index, classifyLiveness(observation));
  }

  const links = plan.links.map((row) => {
    const classified = byInputIndex.get(row.input_index);
    if (classified === undefined) return { ...row };
    if (classified.verdict === "gone") {
      return {
        ...row,
        disposition: "terminal_gone",
        reason: classified.reason,
        liveness: classified,
      };
    }
    return {
      ...row,
      disposition: classified.verdict === "live" ? "expensive_lane" : "browser_rung",
      reason: classified.reason,
      liveness: classified,
    };
  });

  // A sweep that left links unattempted - a rate-limit stop, a batch that died - established no
  // liveness for them, so it does not open the gate a stale collection is held behind. The way
  // forward is another sweep of those links, which is the policy the gate exists to state.
  const unattempted = links.some((row) => row.reason === "unattempted");
  const blockedBy = plan.freshness.sweep_required && unattempted ? ["sweep_incomplete"] : [];
  return {
    ...plan,
    sweep: { ...plan.sweep, applied: true },
    links,
    spend: accountSpend(links, { sourceMode: plan.schema_version === 2 }),
    gate: { expensive_lane_open: blockedBy.length === 0, blocked_by: blockedBy },
  };
}
