// Blind double extraction, computed rather than attested.
//
// The 2026-08-18 run did this by hand: a second agent, shown only the raw page, extracted one or
// two vacancies again, and the two normalized objects were compared. It found zero outcome flips on
// a stable transport, which is why it is periodic rather than per-batch - and its one catch was an
// error in the blind agent itself, which is why the comparison must be a diff a person reads, not a
// verdict a check declares.
//
// What makes it a check and not a promise is that the blind extraction lands on disk as its own
// normalized input under `blind/`, built by an agent that saw only that record's capture. The suite
// then scores it with the same scorer and compares the outcome fields. A disagreement means one of
// the two extractions is wrong; the suite says which fields moved and stops there.
//
// Its evidence is verified the same way the primary evidence is: a blind quote that is not in the
// capture is a defect in the blind extraction, and reporting the disagreement without checking that
// would let a careless second pass discredit a correct first one.

import { evidenceBodies } from "./quote-integrity.mjs";
import { deepEqual } from "../source-verification.mjs";
import { buildDecisionTrace } from "../../job-scorer/trace.mjs";
import { discoverEvidence } from "../evidence.mjs";
import { findLiteralOccurrences } from "../text-scan.mjs";

export const id = "blind-extraction";
export const cadence = "periodic";
export const kind = "assert";

export const minimumSamples = 1;
export const maximumSamples = 2;

/**
 * The fields a flip has to move. Frozen as a literal: this is the run's own measure - an outcome
 * flip - and not "the two objects are identical", which two honest extractions never are.
 */
export const comparedFields = Object.freeze([
  "decision",
  "skip_code",
  "blocker_code",
  "review_code",
  "bucket",
  "selected_work_format",
  "residenceRestriction",
  "sponsorship",
  "workAuthorization",
  "relocation_destination",
  "engagement_path",
]);

export function run(context) {
  const findings = [];
  const blind = context.batch.blind;
  if (blind.size === 0) {
    return { findings: [{ code: "blind_extraction_absent" }], counts: { samples: 0 } };
  }
  if (blind.size > maximumSamples) {
    findings.push({ code: "blind_extraction_sample_count", samples: blind.size });
  }

  let compared = 0;
  let disagreements = 0;
  for (const [index, entry] of [...blind.entries()].sort((left, right) => left[0] - right[0])) {
    if (entry.error !== null || entry.value === null) {
      findings.push({ code: "blind_input_unreadable", index, reason: entry.error ?? "empty" });
      continue;
    }
    const record = context.records.find((candidate) => candidate.index === index) ?? null;
    if (record === null) {
      findings.push({ code: "blind_index_unknown", index });
      continue;
    }
    if (record.input === null || record.trace === null) {
      findings.push({ code: "blind_index_unusable", index });
      continue;
    }
    const bodies = evidenceBodies(record, context).map((entry) => entry.body);
    if (
      context.sourceVerification?.active &&
      !deepEqual(entry.value.sourceContext, record.input.sourceContext)
    ) {
      findings.push({ code: "blind_source_binding_mismatch", index });
      continue;
    }
    if (bodies.length === 0) {
      findings.push({ code: "blind_index_unusable", index });
      continue;
    }
    const blindQuotes = discoverEvidence(entry.value).quotes;
    for (const quote of blindQuotes) {
      if (!bodies.some((body) => findLiteralOccurrences(body, quote.value).length > 0)) {
        findings.push({ code: "blind_quote_absent", index, path: quote.path });
      }
    }
    // Independence is checked over the evidence, not over the file's bytes. Two honest extractions
    // of one page do not quote every field identically - the fixture's own blind input differs on
    // three - while a copy with one unrelated field edited, or with its keys written in another
    // order, is still a copy and byte comparison would let it through.
    const primaryQuotes = record.evidence.quotes;
    const sameEvidence =
      blindQuotes.length === primaryQuotes.length &&
      blindQuotes.every(
        (quote, position) =>
          quote.path === primaryQuotes[position].path &&
          quote.value === primaryQuotes[position].value,
      );
    if (sameEvidence) {
      findings.push({ code: "blind_extraction_not_independent", index });
      continue;
    }
    let blindTrace;
    let primaryTrace;
    try {
      blindTrace = buildDecisionTrace(entry.value, { languages: context.languages });
      primaryTrace = buildDecisionTrace(record.input, { languages: context.languages });
    } catch (error) {
      findings.push({
        code: "blind_input_not_scoreable",
        index,
        reason: typeof error?.code === "string" ? error.code : "throw",
      });
      continue;
    }
    compared += 1;
    const moved = comparedFields.filter(
      (field) => (blindTrace[field] ?? null) !== (primaryTrace[field] ?? null),
    );
    if (moved.length > 0) {
      disagreements += 1;
      findings.push({ code: "blind_extraction_disagrees", index, fields: moved });
    }
  }

  return { findings, counts: { samples: blind.size, compared, disagreements } };
}
