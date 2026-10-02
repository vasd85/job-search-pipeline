// Every evidence quote is a literal substring of a raw file this batch actually captured.
//
// The session check this replaces walked six hardcoded paths. This one walks the object, so a
// field added to the normalized-input schema is covered the day it is added (see `evidence.mjs`),
// and it fails rather than passes when there is nothing to walk: a record scored on a page body
// with no evidence at all, or with no verified body to compare against, is the shape a
// rubber-stamp check reports green.
//
// Only a capture that passed its own digest check is admissible. Comparing a quote against a body
// that failed chain of custody would prove that two unverified things agree.

import { collapseWhitespace, findLiteralOccurrences } from "../text-scan.mjs";

export const id = "quote-integrity";
export const cadence = "per-batch";
export const kind = "assert";

export function run(context) {
  const findings = [];
  let quotesChecked = 0;
  let quotesMatched = 0;

  for (const record of context.records) {
    if (record.input === null) {
      findings.push({ code: "record_not_verifiable", index: record.index, reason: "input_unavailable" });
      continue;
    }
    const { quotes } = record.evidence;
    if (quotes.length === 0) {
      if (record.input?.source?.accessOutcome === "usable") {
        findings.push({ code: "no_evidence_recorded", index: record.index });
      }
      continue;
    }
    const bodies = record.captures
      .filter((capture) => capture.verified !== null && capture.verified.ok)
      .map((capture) => ({ file: capture.file, body: capture.verified.body }));
    if (bodies.length === 0) {
      findings.push({ code: "record_not_verifiable", index: record.index, reason: "no_verified_capture" });
      continue;
    }
    for (const quote of quotes) {
      quotesChecked += 1;
      const exact = bodies.some((entry) => findLiteralOccurrences(entry.body, quote.value).length > 0);
      if (exact) {
        quotesMatched += 1;
        continue;
      }
      const collapsed = collapseWhitespace(quote.value);
      const nearMatch = collapsed.length > 0
        && bodies.some((entry) => collapseWhitespace(entry.body).includes(collapsed));
      findings.push({
        code: nearMatch ? "quote_whitespace_variant" : "quote_absent",
        index: record.index,
        path: quote.path,
        quoteSha256: record.evidenceDigests.get(quote.path),
        quoteChars: quote.value.length,
      });
    }
  }

  return {
    findings,
    counts: { records: context.records.length, quotesChecked, quotesMatched },
  };
}
