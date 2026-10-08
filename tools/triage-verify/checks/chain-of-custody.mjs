// Chain of custody: the raw files say what they are, and they can be re-checked without trusting
// whoever wrote them.
//
// This check is where the 2026-08-18 session's copy-fidelity probing goes to retire. That probe
// compared a copy against the page by eye because the raw files carried no stamp and the
// normalization pass that rewrote their mtimes went unrecorded. Task 27 made the capture file
// carry its own digest, byte count and normalization log, so the successor check is arithmetic:
// recompute the digest from the file's own bytes and compare.
//
// What it still does not prove is authorship - an actor able to write into the working directory
// can write a self-consistent header beside fabricated text. That is ADR 0011's same-UID
// filesystem residual, named in `tools/vacancy-fetch/persist.mjs` and unchanged here.
//
// And the retirement is conditional, exactly as the task wrote it: copy-fidelity retires *for the
// records task 27's transport actually fetched*. `tools/vacancy-fetch/` is the first rung of the
// ladder and the default transport now, and the browser still serves every record it does not
// deliver, so a capture the manifest does not name is a model transcript whose digest
// begins after the transcription. Those records are counted separately in the report under
// `capturesByProvenance` instead of being reported as if a hash anchored them.

import { presentButUnusable } from "../instants.mjs";

export const id = "chain-of-custody";
export const cadence = "per-batch";
export const kind = "assert";

/**
 * A record legitimately has no capture only when it claims nothing about a page body: no usable
 * access outcome and no evidence quote anywhere. A `404` after retry is the case that exists.
 */
function requiresCapture(record) {
  if (record.input === null) return true;
  if (record.input?.source?.accessOutcome === "usable") return true;
  return record.evidence.quotes.length > 0;
}

export function run(context) {
  const findings = [...(context.sourceVerification?.chainFindings ?? [])];
  let capturesVerified = 0;
  let recordsWithCapture = 0;
  let httpFetched = 0;
  let transcribed = 0;

  for (const record of context.records) {
    if (record.captures.length === 0) {
      if (record.sourceScope?.original === true) {
        recordsWithCapture += 1;
        continue;
      }
      if (requiresCapture(record)) {
        findings.push({ code: "capture_absent", index: record.index });
      }
      continue;
    }
    recordsWithCapture += 1;
    for (const capture of record.captures) {
      if (capture.text === null) {
        findings.push({
          code: "capture_unreadable",
          index: record.index,
          file: capture.file,
          reason: capture.error,
        });
        continue;
      }
      for (const problem of capture.verified.problems) {
        findings.push({ code: problem, index: record.index, file: capture.file });
      }
      if (!capture.verified.ok) continue;
      capturesVerified += 1;
      if (capture.provenance === "http_fetch") httpFetched += 1;
      else transcribed += 1;
      const header = capture.verified.header ?? {};
      if (Number(header.index) !== (record.transportIndex ?? record.index)) {
        findings.push({ code: "capture_index_mismatch", index: record.index, file: capture.file });
      }
      if (
        typeof header.normalization !== "string" ||
        header.normalization.length === 0 ||
        header.normalization === "-"
      ) {
        findings.push({
          code: "capture_normalization_unrecorded",
          index: record.index,
          file: capture.file,
        });
      }
      for (const [field, code] of [
        ["requested-url", "capture_requested_url_absent"],
        ["adapter", "capture_adapter_absent"],
        ["fetched-at", "capture_fetched_at_absent"],
      ]) {
        if (
          typeof header[field] !== "string" ||
          header[field] === "-" ||
          header[field].length === 0
        ) {
          findings.push({ code, index: record.index, file: capture.file });
        }
      }
      // Present but unreadable is not the same as absent, and until this check existed it was
      // quieter: every reader of a fetch instant treats an unparseable stamp as no instant at all,
      // so writing the time in any other notation switched four gates off without a word. A stamp
      // the batch declined to write fails the batch; one it wrote unreadably now does too.
      if (presentButUnusable(header["fetched-at"])) {
        findings.push({
          code: "capture_fetched_at_unusable",
          index: record.index,
          file: capture.file,
        });
      }
    }
  }

  return {
    findings,
    counts: {
      records: context.records.length,
      recordsWithCapture,
      capturesVerified,
      capturesSeen: context.batch.captures.length,
      httpFetched,
      transcribed,
      ...(context.sourceVerification?.active
        ? { htmlCapturesVerified: context.sourceVerification.htmlCaptures }
        : {}),
    },
  };
}
