// Baseline diff against the batch's own pre-fetch snapshot.
//
// The baseline is `plan.json`, not the live ledger, and that is the whole design of this check. The
// task-29 ledger keeps one mutable row per vacancy: `recordBatch` upserts it, `ledger.batches`
// stores a digest and not a history, so the moment the batch is recorded its own baseline is gone.
// Reading the ledger for the comparison therefore gives a diff that is either premature or empty
// depending on run order, and a permanently empty diff section in a green report reads as evidence
// that nothing changed. `planBatch` already snapshots exactly what is needed - `key`, `status`,
// `decision`, `flags`, `last_checked` per link, taken before the first fetch - and it sits inside
// the artifacts directory, so the comparison is reproducible for as long as the batch exists.
//
// What the plan says about itself is `plan.mjs`'s business, not this file's: the rows arrive already
// derived, and the problems that reading found are reported by `completeness`, which runs at every
// cadence. Here the plan is only ever the *baseline*, and the ledger is what checks it.
//
// The assert half is the batch obeying its own plan: a link it fetched that the plan called
// terminal, a link the plan never mentions, and a link the plan dropped on a claim the ledger does
// not support.
//
// The diff half is deliberately not a verdict: a decision that moved between two batches can mean
// the page changed, the policy changed or the extractor changed, and choosing between those is
// `docs/runbooks/triage-review.md`'s job. It is given one fact that used to be missing, though:
// each moved row carries the policy on both ends, so "the policy changed" stops being a
// possibility the reader has to reconstruct and becomes something the row states.
//
// Nothing here reports a ledger key. For a source with no id in its URL the key *is* the normalized
// URL, and a report that named a plan row by its key would carry vacancy URLs into a file this
// suite promises keeps none. A row is named by its position in the plan and, where one exists, by
// the record index.

import { usableInstant } from "../instants.mjs";
import { vacancyIdentity } from "../../lib/triage-ledger-core.mjs";
import {
  SKIP_PLAN_ACTIONS,
  TERMINAL_PLAN_ACTIONS,
  batchInstant,
  readPlan,
  readSourcePlan,
  rowsByKey,
  skipSupported,
} from "../plan.mjs";

export const id = "baseline-diff";
export const cadence = "periodic";
export const kind = "assert+diff";

function sortedFlags(value) {
  return Array.isArray(value) ? [...value].map(String).sort() : [];
}

/** Element-wise, not a joined string: two flag lists must not collide on a separator. */
function equalFlags(left, right) {
  return left.length === right.length && left.every((flag, index) => flag === right[index]);
}

/**
 * The flags a ledger row carries for this trace, as docs/runbooks/triage-review.md#1-ledger
 * lists them: the `gap:` annotations and, for a reviewed or blocked trace, its code; a skip's reason
 * stays in `decision` and is never a flag. `assumptions` stay in the trace - an
 * applied default is class C of the rubric's annotation classes and never a flag - so a baseline
 * row that still carries one reports it as `removed`. That diff, which appears only at the `full`
 * cadence, is the only signal: the section is the only enforcement, because the next batch's plan
 * is the ledger row copied, and the two halves of this check agree with each other whatever the
 * row holds.
 */
function traceFlags(trace) {
  return sortedFlags([
    ...(trace?.data_gaps ?? []),
    ...(trace?.review_code === undefined ? [] : [trace.review_code]),
    ...(trace?.blocker_code === undefined ? [] : [trace.blocker_code]),
  ]);
}

function runSource(context) {
  const findings = [];
  const diffs = [];
  const plan = readSourcePlan(context);
  if (!plan.present) findings.push({ code: "plan_absent" });
  // Plan shape, snapshot and card coverage failures are already per-batch completeness findings.
  const rows = plan.rows ?? [];
  let known = 0;
  let fresh = 0;
  let ledgerChecked = 0;
  let skipsCorroborated = 0;
  for (const group of context.sourceVerification.resolution?.groups ?? []) {
    const item = rows.find(
      (row) =>
        row.key === group.logical_key &&
        equalFlags([...row.cardRefs].sort(), [...group.card_refs].sort()),
    );
    if (item === undefined) {
      fresh += 1;
      continue;
    }
    const primary = context.sourceVerification.resolution.observations.find(
      (observation) => observation.observation_ref === group.primary,
    );
    const index = primary?.input?.inputIndex;
    if (item.action === "skip_closed" && primary?.input !== null && primary?.input !== undefined) {
      findings.push({
        code: "refetched_closed_vacancy",
        ...(index === undefined ? {} : { index }),
        planPosition: item.planPosition,
      });
    }
    if (item.action === "skip_known" || item.action === "skip_closed") skipsCorroborated += 1;
    const prior = item.baseline;
    if (prior === null || prior === undefined) {
      fresh += 1;
      continue;
    }
    known += 1;
    ledgerChecked += 1;
    const policyStamp = {
      fromPolicyId: prior.policy_id,
      toPolicyId: context.sourceVerification.resolution.policy_id,
    };
    if (group.result?.decision !== undefined && prior.decision !== group.result.decision) {
      diffs.push({
        code: "decision_changed",
        ...(index === undefined ? {} : { index }),
        planPosition: item.planPosition,
        from: prior.decision,
        to: group.result.decision,
        ...policyStamp,
      });
    }
    const previous = sortedFlags(prior.flags);
    const current = traceFlags(group.result);
    const added = current.filter((flag) => !previous.includes(flag));
    const removed = previous.filter((flag) => !current.includes(flag));
    if (added.length || removed.length)
      diffs.push({
        code: "flags_changed",
        ...(index === undefined ? {} : { index }),
        planPosition: item.planPosition,
        added,
        removed,
        ...policyStamp,
      });
  }
  return {
    findings,
    diffs,
    counts: {
      records: context.records.length,
      known,
      fresh,
      ledgerChecked,
      plannedSkips: rows.filter((row) => SKIP_PLAN_ACTIONS.has(row.action)).length,
      skipsCorroborated,
      skipsUndecidable: 0,
      ledgerSupplied: context.ledger !== null,
      logicalVacancies: context.sourceVerification.resolution?.groups.length ?? 0,
    },
  };
}

export function run(context) {
  if (context.sourceVerification?.active) return runSource(context);
  const findings = [];
  const diffs = [];
  const plan = readPlan(context.batch);
  // The plan's own problems are reported once, by `completeness`, which runs at every cadence.
  const rows = plan.rows === null ? null : rowsByKey(plan);
  const fetchedAt = batchInstant(context.records, context.manifest ?? null);
  const ledgerRows =
    context.ledger === null
      ? new Map()
      : new Map(context.ledger.entries.map((entry) => [entry.key, entry]));
  /**
   * The ledger row that can serve as a baseline: one observed before this batch fetched. A row
   * carrying this batch's own write-back is not a baseline, and a batch with no instant at all
   * cannot tell the two apart.
   */
  const baselineRow = (key) => {
    const row = ledgerRows.get(key);
    if (row === undefined || fetchedAt === null) return null;
    const lastChecked = usableInstant(row.last_checked);
    return lastChecked !== null && lastChecked < fetchedAt ? row : null;
  };
  let known = 0;
  let fresh = 0;
  // A skip the batch did not take is not a skip: a known link the user asked to re-check keeps its
  // `skip_known` row and has a record, so the row is a baseline here and not a dropped link. The
  // terminal action gets no such reading - a record under `skip_closed` is a finding of its own,
  // and the row still has to support what the plan said.
  const recordedKeys = new Set();
  const dropped = (key, row) =>
    SKIP_PLAN_ACTIONS.has(row.action) &&
    (TERMINAL_PLAN_ACTIONS.has(row.action) || !recordedKeys.has(key));

  for (const record of context.records) {
    if (record.sourceRef === null) {
      findings.push({ code: "record_key_underivable", index: record.index });
      continue;
    }
    let key;
    try {
      key = vacancyIdentity(record.sourceRef).key;
    } catch {
      findings.push({ code: "record_key_underivable", index: record.index });
      continue;
    }
    recordedKeys.add(key);
    if (rows === null) continue;
    const item = rows.get(key);
    if (item === undefined) {
      findings.push({ code: "record_absent_from_plan", index: record.index });
      continue;
    }
    if (TERMINAL_PLAN_ACTIONS.has(item.action)) {
      findings.push({
        code: "refetched_closed_vacancy",
        index: record.index,
        planPosition: item.planPosition,
        status: typeof item.status === "string" ? item.status : null,
      });
      continue;
    }
    // A plan row that states its baseline is the baseline. A row that omits one is not evidence
    // that none existed: writing less must not be safer than writing the truth, so where the ledger
    // holds a pre-batch row for that key it is used instead. Omission then buys nothing.
    //
    // One source, never a mixture. The prior decision, its flags and the policy it was taken
    // under are read off the same object: a `from` decision paired with a `fromPolicyId` taken
    // from somewhere else would attribute that decision to a policy which did not produce it,
    // which is the confusion this stamp exists to end rather than to reproduce.
    const declared = item.decision !== undefined;
    const fallback = declared ? null : baselineRow(key);
    const priorDecision = declared ? item.decision : fallback?.decision;
    const priorFlagList = declared ? item.flags : fallback?.flags;
    const priorPolicyId = declared ? item.policyId : fallback?.policy_id;
    if (priorDecision === undefined) {
      fresh += 1;
      continue;
    }
    known += 1;
    // The policy of the batch under verification. `completeness` has already refused any input
    // whose policy is not the live one, so a trace that reaches this check states the policy its
    // own decision was produced under.
    const currentPolicyId =
      typeof record.trace?.policy_id === "string" ? record.trace.policy_id : null;
    /** Both ends of a move, so no reader has to guess which policy either side belongs to. */
    const policyStamp = {
      ...(typeof priorPolicyId === "string" ? { fromPolicyId: priorPolicyId } : {}),
      ...(currentPolicyId === null ? {} : { toPolicyId: currentPolicyId }),
    };
    const decision = record.trace?.decision ?? null;
    if (decision !== null && priorDecision !== decision) {
      diffs.push({
        code: "decision_changed",
        index: record.index,
        planPosition: item.planPosition,
        from: priorDecision,
        to: decision,
        ...policyStamp,
      });
    }
    const priorFlags = sortedFlags(priorFlagList);
    const currentFlags = traceFlags(record.trace);
    const added = currentFlags.filter((flag) => !priorFlags.includes(flag));
    const removed = priorFlags.filter((flag) => !currentFlags.includes(flag));
    if (added.length > 0 || removed.length > 0) {
      diffs.push({
        code: "flags_changed",
        index: record.index,
        planPosition: item.planPosition,
        added,
        removed,
        ...policyStamp,
      });
    }
  }

  if (!plan.present) findings.push({ code: "plan_absent" });

  let ledgerChecked = 0;
  let skipsCorroborated = 0;
  let skipsUndecidable = 0;
  const skips =
    rows === null
      ? []
      : [...rows.entries()].filter(([key, row]) => dropped(key, row)).map(([, row]) => row);
  if (context.ledger !== null && rows !== null) {
    for (const [key, item] of rows) {
      const row = ledgerRows.get(key);
      if (row === undefined) {
        // A plan may legitimately have no row for a new link. It may not have none for a link it
        // removed *because of* a row.
        if (SKIP_PLAN_ACTIONS.has(item.action)) {
          findings.push({
            code: "plan_skip_uncorroborated",
            planPosition: item.planPosition,
            action: item.action,
          });
        }
        continue;
      }
      const lastChecked = usableInstant(row.last_checked);
      if (fetchedAt !== null && lastChecked !== null && lastChecked >= fetchedAt) {
        findings.push({ code: "ledger_already_recorded", planPosition: item.planPosition });
        continue;
      }
      ledgerChecked += 1;
      if (dropped(key, item)) {
        const support = skipSupported(item.action, row, fetchedAt);
        if (!support.decided) skipsUndecidable += 1;
        else if (support.supported) skipsCorroborated += 1;
        else {
          findings.push({
            code: "plan_skip_uncorroborated",
            planPosition: item.planPosition,
            action: item.action,
          });
          continue;
        }
      }
      const sameStatus = item.status === undefined || item.status === row.status;
      const sameDecision = item.decision === undefined || item.decision === row.decision;
      const sameFlags =
        item.flags === undefined || equalFlags(sortedFlags(item.flags), sortedFlags(row.flags));
      // `policy_id` is corroborated on the same terms as the three above, which is what keeps it
      // out of the fourth branch `plan.mjs` forbids: a declared policy the ledger row does not
      // carry is the plan describing a baseline that never existed.
      const samePolicy =
        item.policyId === undefined ||
        item.policyId === (Object.hasOwn(row, "policy_id") ? row.policy_id : undefined);
      if (!sameStatus || !sameDecision || !sameFlags || !samePolicy) {
        findings.push({ code: "plan_disagrees_with_ledger", planPosition: item.planPosition });
      }
    }
  }

  return {
    findings,
    diffs,
    counts: {
      records: context.records.length,
      known,
      fresh,
      ledgerChecked,
      plannedSkips: skips.length,
      skipsCorroborated,
      skipsUndecidable,
      ledgerSupplied: context.ledger !== null,
    },
  };
}
