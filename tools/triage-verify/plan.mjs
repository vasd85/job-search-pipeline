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

import { triageRetryDecision, vacancyIdentity } from "../lib/triage-ledger-core.mjs";
import { normalizeVacancyUrl } from "../lib/triage-ledger-core.mjs";
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
