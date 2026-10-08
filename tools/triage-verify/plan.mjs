// The batch plan, read once and believed about nothing.
//
// `plan.json` is the snapshot `planBatch` took before the first fetch. It is also written by the
// session under verification, and five review rounds found the same defect five times because two
// checks read it separately and each believed a different field of it: the declared identity key
// chose which ledger row corroborated a dropped link; the `duplicate_in_batch` flag dropped a
// vacancy from coverage on one boolean, and separately let a decoy row overwrite the row the ledger
// was asked about; a declared re-check window would have made every recency claim supportable; and
// `action` bought silence in the cadence that always runs.
//
// So there is one reading, here, under one rule: **a field the plan writes about itself is either
// derived from something the plan did not choose, or corroborated by an artifact the plan did not
// write, or it fails to verify.** There is no fourth branch.
//
// - `key` is derived from `link`. A declared key that disagrees is a finding.
// - duplication is derived from the plan's own earlier rows, with four outcomes and a code for each
//   that needs one: a repeat of the identical link is a copied row (`plan_item_duplicate`) and
//   accounts for nothing; a different spelling that normalizes onto the same link is one link as far
//   as the range is concerned, so it is dropped silently; a different spelling of the same posting is
//   the honest duplicate, and one the plan did not mark is `plan_item_duplicate_undeclared`; a first
//   sighting that calls itself a duplicate is `plan_item_duplicate_unclaimed`.
// - `action` cannot be derived from anything - it is a claim about the ledger - so it is
//   corroborated by the ledger or it is not verifiable, and a batch that dropped links without
//   presenting the ledger those drops rest on is a batch nobody can check.
// - `policy_id` is the same shape of claim as `status`, `decision` and `flags`: a statement about
//   the ledger row this plan snapshotted, so `baseline-diff` compares it against that row and a
//   plan that declares a policy the ledger does not carry is `plan_disagrees_with_ledger`.

import { dirname, join } from "node:path";
import {
  triageRetryDecision,
  vacancyIdentity,
  planSourceBatch,
  ledgerSnapshotDigest,
  readSourcePlanPriorResolution,
  inspectTerminalSourceObservations,
  triageBatchIdPattern,
} from "../lib/triage-ledger-core.mjs";
import { normalizeVacancyUrl } from "../lib/triage-ledger-core.mjs";
import { deepEqual } from "./source-verification.mjs";
import { usableInstant } from "./instants.mjs";

export const SKIP_PLAN_ACTIONS = new Set(["skip_closed", "skip_known"]);
export const TERMINAL_PLAN_ACTIONS = new Set(["skip_closed"]);

function safeUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return normalizeVacancyUrl(value);
  } catch {
    return null;
  }
}

/**
 * Read the plan into rows keyed by derived identity, plus the problems the reading found.
 *
 * Returns `null` rows when there is no usable plan at all; the caller decides what that means for
 * its own cadence.
 */
export function readPlan(batch) {
  const file = batch.plan;
  if (!file.present) return { present: false, rows: null, problems: [] };
  if (file.error !== null || file.value === null || !Array.isArray(file.value.items)) {
    return {
      present: true,
      rows: null,
      problems: [{ code: "plan_unreadable", reason: file.error ?? "plan_shape_unexpected" }],
    };
  }
  const problems = [];

  const rows = [];
  const firstByKey = new Map();
  for (const item of file.value.items) {
    const planPosition = Number.isSafeInteger(item?.input_index) ? item.input_index : null;
    const rawLink = typeof item?.link === "string" ? item.link.trim() : null;
    const url = safeUrl(item?.link);
    if (url === null) {
      problems.push({ code: "plan_item_unusable", planPosition });
      continue;
    }
    const key = vacancyIdentity(url).key;
    if (typeof item?.key === "string" && item.key !== key) {
      problems.push({ code: "plan_item_key_mismatch", planPosition });
    }
    const declaredDuplicate = item?.duplicate_in_batch === true;
    const first = firstByKey.get(key) ?? null;
    const row = {
      action: typeof item?.action === "string" ? item.action : null,
      decision: item?.decision,
      flags: item?.flags,
      key,
      lastChecked: item?.last_checked,
      planPosition,
      // The policy the baseline decision was taken under. Like `decision` and `flags` this is a
      // field the plan writes about itself, so it verifies the way they do — the ledger
      // corroborates it in `baseline-diff` — and it is read rather than derived because nothing
      // in the artifacts directory can derive a policy id that is already in the past.
      policyId: item?.policy_id,
      priorityClass: item?.priority_class,
      rawLink,
      repeatsSpelling: false,
      status: item?.status,
      url,
    };
    // A first sighting. Calling itself a duplicate is a claim about rows that are not there.
    if (first === null) {
      if (declaredDuplicate) {
        problems.push({ code: "plan_item_duplicate_unclaimed", planPosition });
      }
      rows.push(row);
      // The first row for a key always wins: letting a later one replace it is how the plan chose
      // which of its own rows the ledger was asked about.
      firstByKey.set(key, row);
      continue;
    }
    // The same line twice. The links file deduplicates, so this is a copied row rather than
    // anything a batch observed, and copying a line must not become a way to satisfy coverage.
    if (rawLink !== null && rawLink === first.rawLink) {
      problems.push({ code: "plan_item_duplicate", planPosition });
      continue;
    }
    // A different spelling that normalizes onto the same link. There is one link here as far as the
    // range is concerned, so it accounts for nothing and needs no finding: coverage decides both
    // together.
    if (url === first.url) continue;
    // A different spelling of the same posting - the honest case the flag exists for. A plan that
    // did not mark it is not what `planBatch` writes, and says so under its own code: the copied-row
    // code has one meaning and keeps it.
    if (!declaredDuplicate) {
      problems.push({ code: "plan_item_duplicate_undeclared", planPosition });
    }
    rows.push({ ...row, repeatsSpelling: true });
  }
  return { present: true, rows, problems };
}

/** The rows a ledger lookup should be made for, first-row-per-key. */
export function rowsByKey(plan) {
  const byKey = new Map();
  for (const row of plan.rows ?? []) {
    if (!byKey.has(row.key)) byKey.set(row.key, row);
  }
  return byKey;
}

/**
 * Does the ledger row actually support the reason the plan gave for dropping the link?
 *
 * Existence is not support. A `skip_closed` needs a row that is not open. A `skip_known` needs an
 * open row that was triaged: one whose last fetch failed is the row the ledger retries, so the plan
 * may not drop it. No date enters either answer.
 */
export function skipSupported(action, row, fetchedAt) {
  const lastChecked = usableInstant(row.last_checked);
  // Both undecidable cases are answered before the action is looked at, and that order is the whole
  // point: the first version of this guard sat below the `skip_closed` branch, so the terminal
  // action - the one that removes a vacancy from the pipeline for good - reached neither. Without a
  // fetch instant nothing separates a baseline row from this batch's own write-back, and a row
  // observed at or after the fetch *is* that write-back. Neither supports anything.
  if (fetchedAt === null) return { decided: false, supported: false };
  if (lastChecked !== null && lastChecked >= fetchedAt) {
    return { decided: false, supported: false };
  }
  if (action === "skip_closed") return { decided: true, supported: row.status !== "open" };
  if (row.status !== "open") return { decided: true, supported: false };
  if (lastChecked === null) return { decided: false, supported: false };
  return { decided: true, supported: row.decision !== triageRetryDecision };
}

/**
 * When this batch began, as early as anything in the directory says.
 *
 * The fetch manifest's `startedAt` first: the transport takes it before the request loop, so it
 * precedes every capture and every per-record instant, and a ledger row has to predate *that* to be
 * a baseline rather than this batch's own write-back. Then the captures' own headers, then the
 * manifest's per-record instants - a batch whose only fetched link 404s persists nothing but still
 * recorded when it asked. Without any of the three there is genuinely nothing to date the batch by,
 * and the callers treat that as undecidable rather than as permission.
 */
export function batchInstant(records, manifest = null) {
  const candidates = [];
  const started = usableInstant(manifest?.startedAt);
  if (started !== null) candidates.push(started);
  for (const record of records) {
    for (const capture of record.captures) {
      if (capture.verified?.ok !== true) continue;
      const parsed = usableInstant(capture.verified.header["fetched-at"]);
      if (parsed !== null) candidates.push(parsed);
    }
  }
  for (const record of manifest?.records?.values() ?? []) {
    const parsed = usableInstant(record?.fetchedAt);
    if (parsed !== null) candidates.push(parsed);
  }
  return candidates.length === 0 ? null : Math.min(...candidates);
}

function priorResolutionOptions(context, source, value) {
  const reference = value.prior_resolution;
  if (
    reference === null ||
    typeof reference !== "object" ||
    Array.isArray(reference) ||
    !deepEqual(Object.keys(reference).sort(), [
      "batch_id",
      "entries_digest",
      "record_sha256",
      "source_resolution_sha256",
      "source_set_sha256",
    ]) ||
    typeof reference.batch_id !== "string" ||
    !triageBatchIdPattern.test(reference.batch_id) ||
    ["entries_digest", "record_sha256", "source_set_sha256", "source_resolution_sha256"].some(
      (key) => typeof reference[key] !== "string" || !/^[a-f0-9]{64}$/u.test(reference[key]),
    )
  )
    return null;
  // A plan cannot choose an arbitrary filesystem root. Its bounded batch id names exactly one
  // sibling archive, whose index, immutable record and retained source captures prove the past.
  const captureRoot = join(dirname(context.batch.dir), reference.batch_id);
  try {
    const prior = readSourcePlanPriorResolution(context.ledger, source.sourceSet, {
      asOf: value.as_of,
      collectionText: context.batch.collection.text,
      captureRoot,
      validation: { languages: context.languages },
    });
    if (prior === null || !deepEqual(prior.reference, reference)) return null;
    return { resolution: prior.resolution, captureRoot };
  } catch {
    return null;
  }
}

/** New plans keep the immutable card guard in front of every baseline lookup.
 * The initial per-card plan and a later plan made with a verified resolution are both legitimate;
 * a final merge/split cannot inherit another card's baseline merely by sharing an ordinal or URL.
 */
export function readSourcePlan(context) {
  const file = context.batch.plan;
  if (!file.present) return { present: false, rows: null, problems: [] };
  const problems = [];
  const source = context.sourceVerification;
  const value = file.value?.source_plan ?? file.value;
  if (
    file.error !== null ||
    value?.schema_version !== 2 ||
    !Array.isArray(value.items) ||
    value.items.some(
      (item) =>
        item === null ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        !Array.isArray(item.card_refs) ||
        !Array.isArray(item.sources) ||
        (item.baseline !== null &&
          (typeof item.baseline !== "object" || Array.isArray(item.baseline))),
    )
  ) {
    return {
      present: true,
      rows: null,
      problems: [
        {
          code: "source_plan_unreadable",
          reason: file.error ?? "shape_unexpected",
        },
      ],
    };
  }
  if (!source?.valid || source.resolution === null) {
    return {
      present: true,
      rows: null,
      problems: [{ code: "source_plan_unverifiable" }],
    };
  }
  if (context.ledger?.schema_version !== 2) {
    return {
      present: true,
      rows: null,
      problems: [{ code: "source_plan_unverifiable", reason: "source_ledger_absent" }],
    };
  }
  if (
    value.source_set_sha256 !== source.digest ||
    (file.value?.source_plan !== undefined && file.value.source_set_sha256 !== source.digest)
  ) {
    problems.push({ code: "source_plan_set_mismatch" });
  }
  if (value.ledger_snapshot_sha256 !== ledgerSnapshotDigest(context.ledger)) {
    problems.push({ code: "source_plan_snapshot_mismatch" });
  }
  const refs = value.items.flatMap((item) => (Array.isArray(item.card_refs) ? item.card_refs : []));
  const known = new Set(source.sourceSet.cards.map((card) => card.card_ref));
  if (
    refs.some((ref) => !known.has(ref)) ||
    source.resolution.selection.card_refs.some((ref) => !refs.includes(ref))
  ) {
    problems.push({ code: "source_plan_card_coverage_incomplete" });
  }
  const candidates = [];
  const hasPrior = Object.hasOwn(value, "prior_resolution");
  const prior = hasPrior ? priorResolutionOptions(context, source, value) : null;
  const options = hasPrior
    ? prior === null
      ? []
      : [prior]
    : [{ resolution: source.resolution }, { selection: { card_refs: [...new Set(refs)] } }];
  for (const candidateOptions of options) {
    try {
      candidates.push(
        planSourceBatch(context.ledger, source.sourceSet, {
          asOf: value.as_of,
          collectionText: context.batch.collection.text,
          captureRoot: context.batch.dir,
          validation: { languages: context.languages },
          ...candidateOptions,
        }),
      );
    } catch {
      /* An invalid claimed shape cannot produce an admissible candidate. */
    }
  }
  if (!candidates.some((candidate) => deepEqual(candidate, value)))
    problems.push({ code: "source_plan_uncorroborated" });
  const terminal = inspectTerminalSourceObservations(
    context.ledger,
    source.sourceSet,
    source.resolution,
    {
      asOf: value.as_of,
      collectionText: context.batch.collection.text,
      artifactsDir: context.batch.dir,
      validation: { languages: context.languages },
    },
  );
  for (const member of terminal.violations)
    problems.push({
      code: "refetched_closed_vacancy",
      ...(member.index === undefined ? {} : { index: member.index }),
    });
  const plannedAt = usableInstant(value.as_of);
  for (const [at, item] of value.items.entries()) {
    if (item.baseline === null || item.baseline === undefined) continue;
    const observedAt = usableInstant(item.baseline.last_checked);
    if (plannedAt === null || observedAt === null || observedAt >= plannedAt) {
      problems.push({ code: "source_plan_baseline_not_prior", planPosition: at + 1 });
    }
  }
  const rows = value.items.map((item, at) => ({
    action: item.action,
    key: item.group_key,
    logicalKey: item.logical_key,
    cardRefs: item.card_refs,
    identityStatus: item.identity_status,
    sources: item.sources,
    baseline: item.baseline,
    planPosition: at + 1,
  }));
  for (const group of source.resolution.groups) {
    const row = rows.find(
      (item) =>
        item.key === group.logical_key &&
        deepEqual([...item.cardRefs].sort(), [...group.card_refs].sort()),
    );
    const prior = context.ledger.logical_entries.find((entry) => entry.key === group.logical_key);
    if (prior !== undefined && (row === undefined || row.baseline === null)) {
      problems.push({ code: "source_plan_baseline_missing" });
    }
  }
  return { present: true, rows: problems.length === 0 ? rows : null, problems };
}
