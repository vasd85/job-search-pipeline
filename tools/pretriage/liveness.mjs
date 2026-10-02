/**
 * The liveness sweep: what a batch already knows about each link before a model reads a word of it.
 *
 * `tools/vacancy-fetch` fetches the batch disk-to-disk and writes one manifest record per link.
 * That record already says whether the posting is gone - a LinkedIn closure banner found in a page
 * whose structural checks held is the source speaking about the vacancy - and nothing about
 * reaching that conclusion needs a model. This module turns the manifest into the two things a
 * batch does with it: a per-link verdict, and the `source` fragment the pure scorer needs for the
 * links whose story is already over.
 *
 * **Transport-agnostic on purpose.** The manifest is one producer of liveness observations, not the
 * definition of one. `sweepFromManifest` is the adapter; everything downstream works on the bounded
 * observation shape, so the browser transport - or whatever replaces the layer the rollout of
 * `docs/runbooks/vacancy-fetch-experiment.md` made the default - feeds the same stage without a
 * second design.
 *
 * **Three verdicts, and `gone` is the narrow one.** A verdict of `gone` means this stage is willing
 * to end the link's life without the expensive lane. Everything short of that is `unresolved`,
 * which costs the batch a browser open and never a false terminal state. In particular an `absent`
 * record is *not* `gone` here: `instructions/skills/score-jobs.md` requires one browser confirmation
 * load before knowledge/job-match-rules.md#6-terminal-decision-codes classifies it, because the layer observed that 404 exactly once.
 */
import { fail } from "./errors.mjs";

/** What the sweep concluded about one link. */
export const livenessVerdicts = Object.freeze(["live", "gone", "unresolved"]);

/** The whole vocabulary a caller may branch on. An adapter that emits anything else throws. */
export const livenessReasons = Object.freeze([
  "active_body_usable",
  "closed_banner_observed",
  "absent_awaiting_confirmation",
  "private_listing_reported",
  "structural_checks_failed",
  "access_failed",
  "unattempted",
]);

const MANIFEST_OUTCOMES = new Set(["active", "absent", "closed", "private", "access_failure"]);
const KNOWN_MANIFEST_VERSIONS = new Set([1, 2]);

/**
 * Read a parsed `fetch-manifest.json` into ordered, bounded liveness observations.
 *
 * Only the fields a liveness decision rests on are carried forward. The manifest keeps the rest,
 * and the batch's verification suite is what reads it; copying it all into a second shape would
 * make this module a partial mirror of a file it does not own.
 */
export function sweepFromManifest(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("pretriage_manifest_unrecognized", "The fetch manifest must be an object.");
  }
  // Both manifest versions are read the same way, and deliberately so: version 2 renamed the
  // block naming the batch and flipped the transport's promotion state, neither of which this
  // module reads. Refusing version 1 would strand every batch captured before the promotion.
  if (
    !KNOWN_MANIFEST_VERSIONS.has(manifest.schemaVersion)
    || manifest.tool !== "vacancy-fetch"
    || !Array.isArray(manifest.records)
  ) {
    fail("pretriage_manifest_unrecognized", "The fetch manifest is not a vacancy-fetch manifest of a known version.");
  }
  const seen = new Set();
  return manifest.records.map((record, position) => {
    if (record === null || typeof record !== "object") {
      fail("pretriage_manifest_record_invalid", `Manifest record at position ${position + 1} is not an object.`);
    }
    if (!Number.isSafeInteger(record.index) || record.index < 1) {
      fail("pretriage_manifest_record_invalid", `Manifest record at position ${position + 1} has no index.`);
    }
    if (seen.has(record.index)) {
      fail("pretriage_manifest_record_invalid", `Manifest index ${record.index} appears twice.`);
    }
    seen.add(record.index);
    if (!MANIFEST_OUTCOMES.has(record.outcome)) {
      fail("pretriage_manifest_record_invalid", `Manifest record ${record.index} carries an unknown outcome.`);
    }
    return {
      index: record.index,
      url: typeof record.requestedUrl === "string" ? record.requestedUrl : null,
      final_url: typeof record.finalUrl === "string" ? record.finalUrl : null,
      outcome: record.outcome,
      access_barrier: record.accessBarrier ?? null,
      http_status: Number.isSafeInteger(record.httpStatus) ? record.httpStatus : null,
      reasons: Array.isArray(record.reasons) ? [...record.reasons] : [],
      usable: record.usable === true,
      skipped: record.skipped === true,
    };
  });
}

/**
 * Classify one liveness observation.
 *
 * The branch order is the rule, so it is written in one place and read top to bottom:
 *
 * | observation | verdict | why |
 * | --- | --- | --- |
 * | never attempted | `unresolved` | a stopped batch says nothing about the posting |
 * | `absent` | `unresolved` | owes one browser confirmation load before knowledge/job-match-rules.md#6-terminal-decision-codes classifies it |
 * | `access_failure` | `unresolved` | a technical failure is never the vacancy's own state |
 * | not usable | `unresolved` | a status word read out of a layout the adapter no longer recognizes |
 * | `closed` | `gone` | the source's own closure statement, in a page that checked out |
 * | `private` | `unresolved` | not expired, removed or closed; knowledge/job-match-rules.md#6-terminal-decision-codes has no row for it |
 * | `active` | `live` | the expensive lane opens |
 *
 * A `gone` verdict carries the `source` half of the scorer's normalized input, so the caller builds
 * no vocabulary of its own. `evidence_required` says the rubric still owes one short quote: knowledge/job-match-rules.md#5-evidence-and-uncertainty
 * requires it, and `normalizeScorerInput` refuses a `closed` outcome without one unless the symptom
 * is exactly `HTTP 404 after retry`. Reading one banner line off a capture already on disk is not
 * the full extraction this stage exists to avoid.
 */
export function classifyLiveness(observation) {
  if (observation === null || typeof observation !== "object") {
    fail("pretriage_observation_invalid", "A liveness observation must be an object.");
  }
  if (!MANIFEST_OUTCOMES.has(observation.outcome)) {
    fail("pretriage_observation_invalid", "A liveness observation carries an unknown outcome.");
  }
  // No index is carried out of here. A record's index means its position inside its own manifest,
  // and a batch split across several invocations has several manifests each starting at 1; copying
  // that number into the verdict would put the same index on two different links. The plan row's
  // `input_index` is the identity, and it is the only one.
  const base = { source: null, evidence_required: false };
  if (observation.skipped === true) {
    return { ...base, verdict: "unresolved", reason: "unattempted" };
  }
  if (observation.outcome === "absent") {
    return { ...base, verdict: "unresolved", reason: "absent_awaiting_confirmation" };
  }
  if (observation.outcome === "access_failure") {
    return { ...base, verdict: "unresolved", reason: "access_failed" };
  }
  if (observation.usable !== true) {
    return { ...base, verdict: "unresolved", reason: "structural_checks_failed" };
  }
  if (observation.outcome === "closed") {
    return {
      ...base,
      verdict: "gone",
      reason: "closed_banner_observed",
      evidence_required: true,
      source: { accessOutcome: "closed", accessReason: "closure banner in the fetched page" },
    };
  }
  if (observation.outcome === "private") {
    return { ...base, verdict: "unresolved", reason: "private_listing_reported" };
  }
  return { ...base, verdict: "live", reason: "active_body_usable" };
}

/**
 * The `source` fragment of a normalized scorer input for a link the sweep found gone.
 *
 * It exists so the caller never assembles that vocabulary by hand for a page nobody read. The
 * quote is required and taken from the capture the layer already wrote; passing `null` is refused
 * rather than quietly producing an input `normalizeScorerInput` will reject two calls later.
 */
export function goneScorerSource(classified, { sourceRef, finalUrl = null, evidenceQuote }) {
  if (classified?.verdict !== "gone") {
    fail("pretriage_not_gone", "Only a gone verdict carries a terminal source fragment.");
  }
  if (typeof sourceRef !== "string" || sourceRef.length === 0) {
    fail("pretriage_source_ref_missing", "The terminal source fragment needs the input link.");
  }
  if (typeof evidenceQuote !== "string" || evidenceQuote.trim().length === 0) {
    fail(
      "pretriage_evidence_missing",
      "A closed vacancy needs the one short quote the rubric requires.",
    );
  }
  return {
    accessOutcome: classified.source.accessOutcome,
    accessReason: classified.source.accessReason,
    company: null,
    evidenceQuote,
    finalUrl,
    jobTitle: null,
    locationRaw: null,
    salaryRaw: null,
    sourceRef,
    workFormatRaw: null,
  };
}
