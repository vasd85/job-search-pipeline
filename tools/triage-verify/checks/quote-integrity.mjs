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

/** Version 10 binds every evidence string to the one selected source and vacancy.
 * Historical inputs retain their original any-own-capture interpretation.
 */
export function evidenceBodies(record, context = {}) {
  if (context.sourceVerification?.active) {
    return typeof record.sourceScope?.body === "string"
      ? [{ file: record.sourceScope.file, body: record.sourceScope.body }]
      : [];
  }
  const verified = record.captures.filter((capture) => capture.verified?.ok === true);
  if (record.input?.schemaVersion !== 10 || record.input?.sourceContext == null) {
    return verified.map((capture) => ({ file: capture.file, body: capture.verified.body }));
  }
  const binding = record.input?.sourceContext;
  if (
    binding === null ||
    typeof binding !== "object" ||
    !Number.isSafeInteger(binding.startLine) ||
    !Number.isSafeInteger(binding.endLine) ||
    binding.startLine < 1 ||
    binding.endLine < binding.startLine ||
    typeof binding.primaryCaptureSha256 !== "string"
  )
    return [];
  const normalize = context.normalizeUrl ?? ((value) => value);
  return verified.flatMap((capture) => {
    const { body, header } = capture.verified;
    if (header["normalized-sha256"] !== binding.primaryCaptureSha256) return [];
    if (
      typeof binding.primarySourceRef === "string" &&
      normalize(header["requested-url"]) !== normalize(binding.primarySourceRef)
    )
      return [];
    const lines = body.split("\n");
    if (binding.endLine > lines.length) return [];
    return [
      { file: capture.file, body: lines.slice(binding.startLine - 1, binding.endLine).join("\n") },
    ];
  });
}

export function run(context) {
  const findings = [];
  let quotesChecked = 0;
  let quotesMatched = 0;

  for (const record of context.records) {
    if (record.input === null) {
      findings.push({
        code: "record_not_verifiable",
        index: record.index,
        reason: "input_unavailable",
      });
      continue;
    }
    const { quotes } = record.evidence;
    if (quotes.length === 0) {
      if (record.input?.source?.accessOutcome === "usable") {
        findings.push({ code: "no_evidence_recorded", index: record.index });
      }
      continue;
    }
    const bodies = evidenceBodies(record, context);
    if (bodies.length === 0) {
      findings.push({
        code: "record_not_verifiable",
        index: record.index,
        reason: "no_verified_capture",
      });
      continue;
    }
    for (const quote of quotes) {
      quotesChecked += 1;
      const exact = bodies.some(
        (entry) => findLiteralOccurrences(entry.body, quote.value).length > 0,
      );
      if (exact) {
        quotesMatched += 1;
        continue;
      }
      const collapsed = collapseWhitespace(quote.value);
      const nearMatch =
        collapsed.length > 0 &&
        bodies.some((entry) => collapseWhitespace(entry.body).includes(collapsed));
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
