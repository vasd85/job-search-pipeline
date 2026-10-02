// Completeness and sanity: the batch covered what it was asked to cover, and every trace is the
// one its own input produces.
//
// The strongest part is the recomputation. A persisted trace is compared against
// `buildDecisionTrace(persisted input)`, so a trace that was edited, re-ordered, copied from a
// neighbour or written from memory fails here without the check needing to know a single expected
// value. Scorer determinism is not re-tested: task 26 put that in the repository unit suite, and
// this check would only repeat it.
//
// The comparison is only meaningful under the policy the input was scored with, so an input
// carrying a superseded `policyId` is a finding rather than something to re-score silently.

import { buildDecisionTrace } from "../../job-scorer/trace.mjs";
import {
  TRIAGE_POLICY_ID,
  NORMALIZED_INPUT_SCHEMA_VERSION,
} from "../../job-scorer/normalized-input.mjs";
import { TOOLMATCH_TAXONOMY_ID } from "../../job-scorer/tool-taxonomy.mjs";
import { normalizeVacancyUrl } from "../../lib/triage-ledger-core.mjs";
import {
  SKIP_PLAN_ACTIONS,
  TERMINAL_PLAN_ACTIONS,
  batchInstant,
  readPlan,
  skipSupported,
} from "../plan.mjs";

export const id = "completeness";
export const cadence = "per-batch";
export const kind = "assert";

function deepEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (left === null || right === null) return false;
  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  if (leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => deepEqual(left[key], right[key]));
}

function safeNormalizedUrl(value) {
  if (typeof value !== "string") return null;
  try {
    return normalizeVacancyUrl(value);
  } catch {
    return null;
  }
}

/** One-based position of a record's link inside the verified range, or `null` when it is not there. */
function rangePosition(links, sourceRef) {
  if (sourceRef === null || links.length === 0) return null;
  const link = links.find((candidate) => candidate.normalizedUrl === sourceRef);
  return link === undefined ? null : link.position - links[0].position + 1;
}

/**
 * Which links of the range the plan legitimately accounts for without a record.
 *
 * Two ways, and both are checked rather than believed. A second spelling of a posting already
 * planned collapses to one record, which is derivable from the plan's own rows. And a link the plan
 * dropped needs the ledger row the drop rests on - `action` is a claim about the ledger and nothing
 * in the artifacts directory can derive it, so a batch that dropped links without presenting that
 * ledger is one nobody can check, and says so instead of passing.
 */
function planAccountedLinks(context, findings, claimedByUrl) {
  const plan = readPlan(context.batch);
  if (!plan.present) return null;
  findings.push(...plan.problems);
  if (plan.rows === null) return null;

  const rangeUrls = new Set(context.links.map((link) => link.normalizedUrl));
  const planned = new Set(plan.rows.map((row) => row.url));
  const sameSet =
    planned.size === rangeUrls.size && [...planned].every((url) => rangeUrls.has(url));
  if (!sameSet) findings.push({ code: "plan_range_mismatch" });

  const accounted = new Set();
  // A skip the batch did not take is not a drop: a known link the user asked to re-check keeps its
  // `skip_known` row and has a record, and that record answers for the link on its own. The
  // terminal action is never read that way.
  const skips = plan.rows.filter(
    (row) =>
      SKIP_PLAN_ACTIONS.has(row.action) &&
      (TERMINAL_PLAN_ACTIONS.has(row.action) || !claimedByUrl.has(row.url)),
  );
  for (const row of plan.rows) {
    if (row.repeatsSpelling) accounted.add(row.url);
  }
  if (skips.length === 0) return accounted;
  if (context.ledger === null) {
    findings.push({
      code: "plan_skips_unverifiable",
      planPositions: skips.map((row) => row.planPosition).filter((value) => value !== null),
    });
    return accounted;
  }
  const ledgerRows = new Map(context.ledger.entries.map((entry) => [entry.key, entry]));
  const fetchedAt = batchInstant(context.records, context.manifest ?? null);
  const unverifiable = [];
  for (const row of skips) {
    const ledgerRow = ledgerRows.get(row.key);
    if (ledgerRow === undefined) continue;
    const support = skipSupported(row.action, ledgerRow, fetchedAt);
    // Undecidable is not supported. A window nothing can evaluate - a batch with no verified
    // capture to date it against, or a row already carrying this batch's own observation - leaves
    // the drop unchecked, and an unchecked drop is reported rather than granted.
    if (support.supported) accounted.add(row.url);
    else if (!support.decided) unverifiable.push(row.planPosition);
  }
  if (unverifiable.length > 0) {
    findings.push({
      code: "plan_skips_unverifiable",
      planPositions: unverifiable.filter((value) => value !== null),
    });
  }
  return accounted;
}

export function run(context) {
  const findings = [];
  for (const name of context.batch.unexpected) {
    findings.push({ code: "unexpected_artifact", file: name });
  }

  let tracesRecomputed = 0;
  const claimedByUrl = new Map();

  for (const record of context.records) {
    if (record.input === null) {
      findings.push({
        code: record.inputPresent ? "input_unreadable" : "input_absent",
        index: record.index,
        ...(record.inputError === null ? {} : { reason: record.inputError }),
      });
    }
    if (record.trace === null) {
      findings.push({
        code: record.tracePresent ? "trace_unreadable" : "trace_absent",
        index: record.index,
        ...(record.traceError === null ? {} : { reason: record.traceError }),
      });
    }
    if (record.input === null) continue;

    // `NNN` is the transport's own dense record number and is joined to nothing. What a record
    // claims about its place is `inputIndex`, and that is checked against the links file - which
    // the session under verification does not write - through the record's URL: the one-based
    // position of its link inside the verified range, the first occurrence where two raw lines
    // normalize to one URL. A record outside the range has its own finding below.
    const expectedIndex = rangePosition(context.links, record.sourceRef);
    if (expectedIndex !== null && record.input.inputIndex !== expectedIndex) {
      findings.push({ code: "input_index_mismatch", index: record.index });
    }
    if (record.sourceRef === null) {
      findings.push({ code: "record_source_ref_unusable", index: record.index });
    } else {
      const existing = claimedByUrl.get(record.sourceRef);
      if (existing === undefined) claimedByUrl.set(record.sourceRef, [record.index]);
      else existing.push(record.index);
    }
    if (
      record.input.policyId !== TRIAGE_POLICY_ID ||
      record.input.schemaVersion !== NORMALIZED_INPUT_SCHEMA_VERSION ||
      (record.trace !== null &&
        (record.trace.policy_id !== TRIAGE_POLICY_ID ||
          (record.trace.decision === "EVALUATED" &&
            typeof record.trace.toolmatch_taxonomy_id === "string" &&
            record.trace.toolmatch_taxonomy_id !== TOOLMATCH_TAXONOMY_ID)))
    ) {
      findings.push({ code: "policy_drift", index: record.index });
      continue;
    }
    if (record.trace === null) continue;
    if (expectedIndex !== null && record.trace.input_index !== expectedIndex) {
      findings.push({ code: "trace_index_mismatch", index: record.index });
    }
    let recomputed;
    try {
      recomputed = JSON.parse(
        JSON.stringify(buildDecisionTrace(record.input, { languages: context.languages })),
      );
    } catch (error) {
      findings.push({
        code: "input_not_scoreable",
        index: record.index,
        reason: typeof error?.code === "string" ? error.code : "throw",
      });
      continue;
    }
    tracesRecomputed += 1;
    if (!deepEqual(recomputed, record.trace)) {
      findings.push({ code: "trace_mismatch", index: record.index });
    }
  }

  for (const [url, indices] of claimedByUrl) {
    if (indices.length > 1) {
      findings.push({
        code: "duplicate_record_for_link",
        indices: [...indices].sort((a, b) => a - b),
      });
    }
    if (!context.links.some((link) => link.normalizedUrl === url)) {
      findings.push({ code: "record_outside_range", indices: [...indices].sort((a, b) => a - b) });
    }
  }

  const accounted = planAccountedLinks(context, findings, claimedByUrl);
  let covered = 0;
  for (const link of context.links) {
    if (claimedByUrl.has(link.normalizedUrl)) {
      covered += 1;
      continue;
    }
    if (accounted !== null && accounted.has(link.normalizedUrl)) continue;
    findings.push({ code: "link_uncovered", position: link.position, line: link.line });
  }

  return {
    findings,
    counts: {
      linksInRange: context.links.length,
      linksCovered: covered,
      records: context.records.length,
      tracesRecomputed,
      planPresent: context.batch.plan.present,
    },
  };
}
