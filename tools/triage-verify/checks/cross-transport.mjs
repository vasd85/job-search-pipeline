// Cross-transport invariants.
//
// The session checks these replace asserted literal expected sets - one of them asserted that the
// closed set equals `[5,7,8]`, which is a check that rubber-stamps the batch it was written from
// and can never fail on another. Everything here is an implication between two things the batch
// itself produced: the fetch manifest, the capture files, the normalized inputs and the traces. No
// expected value is written down, so the check keeps meaning something on the next batch.
//
// Both directions are checked, and the second one matters more than it looks. A record that
// declares itself `closed` or `technical_unavailable` owes no capture and no evidence quote -
// legitimately, because a 404 has no page to quote. That exemption is also the cheapest route to a
// green report: relabel a vacancy nobody wants to process as unavailable and every per-batch check
// has nothing left to hold. So where a manifest exists it has to corroborate the declaration, and
// where it does not the report carries the per-outcome counts and the residual is named rather than
// implied.

import { presentButUnusable, usableInstant } from "../instants.mjs";
import { readManifestRecords } from "../manifest.mjs";

export const id = "cross-transport";
export const cadence = "per-batch";
export const kind = "assert";

// `private` belongs here on ADR 0012's own mapping - a delisted posting is closed, with the observed
// status quoted - and `instructions/skills/get-vacancy.md` closes an absent, closed or private
// posting the same way. No adapter on the manifest-writing path emits it today; the row exists so
// the fourth outcome name is decided rather than invisible.
const TERMINAL_MANIFEST_OUTCOMES = new Set(["absent", "closed", "private"]);

/** The stamps that are a verdict about the posting rather than about the fetch. */
const VERDICT_OUTCOMES = new Set(["active", "absent", "closed", "private"]);

/**
 * Does a capture that rescued this record contradict what the record declares?
 *
 * A rescue that says something has to be read rather than counted - the shape a review round
 * rejected one artifact over, where a ledger row corroborated by existing. Three details are each
 * a door a reviewer walked through before they were closed: the rescues are selected by derived
 * provenance and not by filename, so renaming a capture to the primary name cannot hide its stamp;
 * one contradicting stamp is a contradiction, so adding a second capture cannot average it away;
 * and only a verdict about the posting contradicts anything, so an `access_failure` stamp - which
 * says the fetch failed and nothing about the vacancy - leaves the declaration alone.
 */
function rescueContradicts(record, declared) {
  const stamps = record.captures
    .filter((capture) => capture.provenance !== "http_fetch" && capture.verified?.ok === true)
    .map((capture) => capture.verified.header.outcome)
    .filter((outcome) => typeof outcome === "string" && VERDICT_OUTCOMES.has(outcome));
  if (stamps.length === 0) return false;
  if (declared === "closed") return stamps.some((outcome) => outcome === "active");
  if (declared === "technical_unavailable") return stamps.length > 0;
  return false;
}

/**
 * Did the fetch transport reach a verdict about this posting?
 *
 * `usable` and the two terminal outcomes are verdicts. An `access_failure`, or anything the fetcher
 * routed to the browser, is not: it says the fetch did not work, and nothing about the vacancy.
 */
function resolvedByManifest(record) {
  if (record.outcome === "access_failure") return false;
  if (record.usable !== true && record.fallback === "browser") return false;
  return record.usable === true || TERMINAL_MANIFEST_OUTCOMES.has(record.outcome);
}

/**
 * Did the browser retry this procedure owes the record meet a wall?
 *
 * Two manifest verdicts owe one: an `active`, usable record whose body turned out not to be the
 * posting - a sign-in form in a language the adapter's markers miss - and an `absent` record, whose
 * confirmation load is that retry. `closed` and `private` owe none, so nothing is read for them. The
 * witness is a verified capture that is not the record's own fetch and is stamped `access_failure`:
 * the stamp is the browser's own account of what it met, and a silent or verdict stamp says nothing
 * of the kind. It is a transcript the session wrote, so every record it corroborates is named in a
 * difference rather than passing quietly.
 */
function walledOnRetry(record, manifestRecord) {
  const retryOwed = (manifestRecord.outcome === "active" && manifestRecord.usable === true)
    || manifestRecord.outcome === "absent";
  if (!retryOwed) return false;
  return record.captures.some((capture) => capture.provenance !== "http_fetch"
    && capture.verified?.ok === true
    && capture.verified.header.outcome === "access_failure");
}

export function run(context) {
  const findings = [];
  const diffs = [];
  const unresolved = [];
  const walledByBrowser = [];
  const manifest = context.manifest ?? readManifestRecords(context.batch);
  if (manifest.problem !== null) {
    findings.push({ code: "manifest_unreadable", reason: manifest.problem });
  }
  // The instant the write-back guard rests on. It is the field this suite introduced, and leaving it
  // unchecked would put the same asymmetry back one field over: deleting it is silent, and silence
  // dates the batch by its first request again.
  if (manifest.records !== null && usableInstant(manifest.startedAt) === null) {
    findings.push({ code: "manifest_started_at_unusable" });
  }
  const byIndex = manifest.records;

  for (const record of context.records) {
    const verifiedCaptures = record.captures.filter((capture) => capture.verified?.ok === true);
    const urls = new Set(verifiedCaptures
      .map((capture) => context.normalizeUrl(capture.verified.header["requested-url"]))
      .filter((url) => url !== null));
    if (urls.size > 1) {
      findings.push({ code: "capture_url_disagreement", index: record.index });
    }
    const declared = record.input?.source?.accessOutcome ?? null;
    const rescued = record.captures.some((capture) => capture.verified?.ok === true);
    if (record.sourceRef !== null) {
      for (const capture of verifiedCaptures) {
        const url = context.normalizeUrl(capture.verified.header["requested-url"]);
        if (url !== null && url !== record.sourceRef) {
          findings.push({
            code: "capture_source_ref_mismatch",
            index: record.index,
            file: capture.file,
          });
        }
      }
    }

    // The rescue reads the record's own captures and its own declaration, so it needs no manifest -
    // and on the browser transport, which writes none, this is the only thing in the check that can
    // still speak. Raised before the manifest section for exactly that reason.
    if (rescueContradicts(record, declared)) {
      findings.push({ code: "rescue_contradicts_declaration", index: record.index, declared });
    }

    if (byIndex === null) continue;
    const manifestRecord = byIndex.get(record.index);
    if (manifestRecord === undefined) {
      findings.push({ code: "manifest_record_missing", index: record.index });
      continue;
    }
    const manifestUrl = context.normalizeUrl(manifestRecord.requestedUrl);
    if (record.sourceRef !== null && manifestUrl !== null && manifestUrl !== record.sourceRef) {
      findings.push({ code: "manifest_source_ref_mismatch", index: record.index });
    }
    const primary = record.captures.find((capture) => capture.primary === true) ?? null;
    if (manifestRecord.usable === true) {
      if (primary === null || primary.verified?.ok !== true) {
        findings.push({ code: "manifest_capture_missing", index: record.index });
      } else {
        const header = primary.verified.header;
        if (manifestRecord.persisted?.file !== primary.file) {
          findings.push({ code: "manifest_capture_file_mismatch", index: record.index });
        }
        if (header["normalized-sha256"] !== manifestRecord.persisted?.sha256) {
          findings.push({ code: "manifest_capture_digest_mismatch", index: record.index });
        }
        if (header["response-sha256"] !== manifestRecord.response?.sha256) {
          findings.push({ code: "manifest_response_digest_mismatch", index: record.index });
        }
        // The capture header is not covered by the digest `verifyCaptureFile` recomputes, and two
        // time gates lean on `fetched-at`. Where the manifest names this capture it also states
        // when it was fetched, so the two are compared exactly as the digests are.
        if (header["fetched-at"] !== manifestRecord.fetchedAt) {
          findings.push({ code: "manifest_capture_fetched_at_mismatch", index: record.index });
        }
        if (usableInstant(manifestRecord.fetchedAt) === null) {
          findings.push({ code: "manifest_fetched_at_unusable", index: record.index });
        }
      }
    } else if (record.input?.source?.accessOutcome === "usable") {
      const fallbackCapture = record.captures.some((capture) =>
        capture.primary === false && capture.verified?.ok === true);
      if (!fallbackCapture) {
        findings.push({ code: "fallback_not_honoured", index: record.index });
      }
    }

    // An `absent` verdict is the one the batch procedure does not accept as final: a posting the
    // rubric may record as gone owes one confirmation load in the browser before it is classified
    // (`instructions/skills/score-jobs.md`, transport rung 2). When that load happened and produced
    // a verified body, the posting was live and scoring it is right - the rescue is the newer and
    // richer observation, and the quote walk holds every one of its evidence strings against that
    // body. `closed` and `private` are read out of a body whose structural checks held and owe no
    // such confirmation, so scoring one of those is still the contradiction this catches.
    const confirmedLive = manifestRecord.outcome === "absent" && rescued;
    if (TERMINAL_MANIFEST_OUTCOMES.has(manifestRecord.outcome) && declared !== null
      && declared !== "closed" && !confirmedLive) {
      findings.push({ code: "closed_source_scored", index: record.index });
    }
    // The direction that closes the cheap exit: a declared unavailability has to be something the
    // independent transport also saw.
    //
    // Only where that transport reached a verdict, and only where something else did instead. A
    // record the fetcher handed to the browser carries no opinion about the vacancy -
    // `access_failure` is a statement about the fetch, not about the posting - so asserting against
    // it would red the batch that did the right thing: fetch failed, browser fell back, browser
    // found the posting closed. But the exemption belongs to the rescue, not to the failure: a
    // record with no verified capture at all had nothing look at it, and letting that through would
    // hand back the cheap exit this pair of assertions exists to close.
    const exempt = !resolvedByManifest(manifestRecord) && rescued;
    // The two gates are separate. The residual list means "the fetch transport reached no verdict
    // here" and has to keep meaning that, so a contradicting rescue does not delete the record from
    // it - the contradiction is a finding of its own, and the batch that earns more suspicion must
    // not produce the quieter report.
    if (exempt) {
      unresolved.push(record.index);
    } else {
      if (declared === "closed" && !TERMINAL_MANIFEST_OUTCOMES.has(manifestRecord.outcome)) {
        findings.push({ code: "closure_not_corroborated", index: record.index });
      }
      if (declared === "technical_unavailable" && manifestRecord.outcome !== "access_failure") {
        if (walledOnRetry(record, manifestRecord)) {
          walledByBrowser.push(record.index);
        } else {
          findings.push({ code: "unavailability_not_corroborated", index: record.index });
        }
      }
    }
  }

  let manifestClosed = 0;
  if (byIndex !== null) {
    // The manifest is the one file in the directory the session did not write about itself, so it
    // is also the only place a vacancy that was fetched and then dropped still shows. A row the
    // batch has no record for is that drop: `link_uncovered` cannot see it when the plan claims the
    // link was skipped, and the plan is the session's own word. A row the fetcher never attempted
    // is left to `link_uncovered`, which owns that case and says it better.
    const recorded = new Set(context.records.map((record) => record.index));
    for (const [index, manifestRecord] of byIndex) {
      if (recorded.has(index) || manifestRecord.skipped === true) continue;
      findings.push({ code: "manifest_record_unaccounted", index });
    }
    const closedByManifest = new Set(context.records
      .filter((record) => TERMINAL_MANIFEST_OUTCOMES.has(byIndex.get(record.index)?.outcome))
      .map((record) => record.index));
    manifestClosed = closedByManifest.size;
    const skippedUnavailable = context.records
      .filter((record) => record.trace?.decision === "SKIP"
        && record.trace?.skip_code === "vacancy_unavailable")
      .map((record) => record.index);
    const beyond = skippedUnavailable.filter((index) => !closedByManifest.has(index));
    if (beyond.length > 0) diffs.push({ code: "closed_beyond_manifest", indices: beyond });
    const stopped = context.batch.manifest.value?.stoppedEarly ?? null;
    if (stopped !== null) diffs.push({ code: "manifest_stopped_early", reason: String(stopped) });
    if (unresolved.length > 0) {
      diffs.push({ code: "manifest_did_not_resolve", indices: unresolved.sort((a, b) => a - b) });
    }
    if (walledByBrowser.length > 0) {
      diffs.push({
        code: "unavailability_from_browser_retry",
        indices: walledByBrowser.sort((a, b) => a - b),
      });
    }
  } else {
    // Named rather than implied: with no manifest, a declared unavailability has no independent
    // corroboration in this directory at all. The counts in the report are what keeps the class
    // visible, and the runbook says what a batch of them is worth.
    const uncorroborated = context.records
      .filter((record) => record.input?.source?.accessOutcome !== undefined
        && record.input.source.accessOutcome !== "usable"
        && record.captures.every((capture) => capture.verified?.ok !== true))
      .map((record) => record.index);
    if (uncorroborated.length > 0) {
      diffs.push({ code: "unavailability_uncorroborated_no_manifest", indices: uncorroborated });
    }
  }

  return {
    findings,
    diffs,
    counts: {
      records: context.records.length,
      manifestPresent: context.batch.manifest.present,
      manifestClosed,
      manifestUnresolved: unresolved.length,
    },
  };
}
