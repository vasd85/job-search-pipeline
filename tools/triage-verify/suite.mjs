// The suite: one context, seven checks, one report.
//
// Two cadences, because the 2026-08-18 run measured that they are not worth the same. The per-batch
// set is cheap and always runs. The periodic set is what only pays off when the transport or the
// policy moved - a blind double extraction over a stable transport found zero outcome flips, and
// its one catch was an error in the blind extractor itself. `docs/runbooks/triage-verification.md`
// owns when `full` runs.
//
// The report carries no timestamp and reads no clock. Two runs over the same directory produce
// byte-identical bytes, which is what makes a report worth attaching to a batch.

import { discoverEvidence } from "./evidence.mjs";
import { fail } from "./errors.mjs";
import { loadBatchArtifacts } from "./artifacts.mjs";
import { loadVocabulary } from "./vocabulary.mjs";
import { captureProvenance, captureProvenanceClasses, readManifestRecords } from "./manifest.mjs";
import { normalizeVacancyUrl, readLedger } from "../lib/triage-ledger-core.mjs";
import { readLinksFile, sliceRange } from "./links.mjs";
import { sha256 } from "./text-scan.mjs";
import { TRIAGE_POLICY_ID } from "../job-scorer/normalized-input.mjs";
import { verifyCaptureFile } from "../vacancy-fetch/persist.mjs";
import * as baselineDiff from "./checks/baseline-diff.mjs";
import * as chainOfCustody from "./checks/chain-of-custody.mjs";
import * as completeness from "./checks/completeness.mjs";
import * as crossTransport from "./checks/cross-transport.mjs";
import * as negativeSpace from "./checks/negative-space.mjs";
import * as blindExtraction from "./checks/blind-extraction.mjs";
import * as periodicAttestation from "./checks/periodic-attestation.mjs";
import * as quoteIntegrity from "./checks/quote-integrity.mjs";

export const reportVersion = 1;

export const cadences = Object.freeze(["per-batch", "full"]);

/** Declaration order is report order. A check is added here and in the runbook, never only here. */
export const checks = Object.freeze([
  chainOfCustody,
  quoteIntegrity,
  completeness,
  crossTransport,
  negativeSpace,
  baselineDiff,
  blindExtraction,
  periodicAttestation,
]);

export function checksFor(cadence) {
  if (!cadences.includes(cadence)) fail("cadence_invalid", `Unknown cadence ${String(cadence)}.`);
  return checks.filter((check) => cadence === "full" || check.cadence === "per-batch");
}

function safeNormalizeUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return normalizeVacancyUrl(value);
  } catch {
    return null;
  }
}

function buildRecords(batch, manifestRecords) {
  return batch.indices.map((index) => {
    const inputEntry = batch.inputs.get(index) ?? null;
    const traceEntry = batch.traces.get(index) ?? null;
    const input =
      inputEntry !== null && inputEntry.error === null && inputEntry.value !== null
        ? inputEntry.value
        : null;
    const trace =
      traceEntry !== null && traceEntry.error === null && traceEntry.value !== null
        ? traceEntry.value
        : null;
    const evidence = input === null ? { paths: [], quotes: [] } : discoverEvidence(input);
    const evidenceDigests = new Map(
      evidence.quotes.map((quote) => [quote.path, sha256(quote.value)]),
    );
    return {
      index,
      captures: batch.captures
        .filter((capture) => capture.index === index)
        .map((capture) => {
          const verified = capture.text === null ? null : verifyCaptureFile(capture.text);
          const withVerification = { ...capture, verified };
          return {
            ...withVerification,
            provenance: captureProvenance(withVerification, manifestRecords?.get(index) ?? null),
          };
        }),
      evidence,
      evidenceDigests,
      input,
      inputError: inputEntry?.error ?? null,
      inputPresent: inputEntry !== null,
      sourceRef: input === null ? null : safeNormalizeUrl(input?.source?.sourceRef),
      trace,
      traceError: traceEntry?.error ?? null,
      tracePresent: traceEntry !== null,
    };
  });
}

/**
 * Assemble everything the checks read. Every input is loaded once, so two checks can never disagree
 * about what the batch contained.
 */
/*
 * `languages` are the language names a persisted input may carry — the candidate layer's, which the
 * CLI resolves. They are what the recomputed trace is built with, so a batch is verified against the
 * same set it was scored against. Without them only the default language is accepted.
 */
export function buildContext({
  artifactsDir,
  linksFile,
  from,
  to,
  vocabularyPath,
  ledgerPath,
  languages,
}) {
  const links = sliceRange(readLinksFile(linksFile), from, to);
  const batch = loadBatchArtifacts(artifactsDir);
  const vocabulary = loadVocabulary(vocabularyPath);
  let ledger = null;
  if (typeof ledgerPath === "string" && ledgerPath.length > 0) {
    try {
      ledger = readLedger(ledgerPath);
    } catch (error) {
      fail(
        "ledger_unreadable",
        `The triage ledger could not be read (${error?.code ?? "unknown"}).`,
      );
    }
  }
  const manifest = readManifestRecords(batch);
  return {
    batch,
    languages,
    ledger,
    links,
    manifest,
    normalizeUrl: safeNormalizeUrl,
    range: { from, to },
    records: buildRecords(batch, manifest.records),
    vocabulary,
  };
}

/** Per outcome class, so the class that owes neither a capture nor a quote stays visible. */
function countAccessOutcomes(records) {
  const counts = { usable: 0, closed: 0, technical_unavailable: 0, unreadable: 0 };
  for (const record of records) {
    const outcome = record.input?.source?.accessOutcome;
    if (outcome !== undefined && Object.hasOwn(counts, outcome)) counts[outcome] += 1;
    else counts.unreadable += 1;
  }
  return counts;
}

function findingSortKey(finding) {
  return [
    finding.code ?? "",
    String(finding.index ?? finding.indices?.[0] ?? ""),
    finding.file ?? "",
    finding.path ?? finding.family ?? finding.probe ?? "",
    String(finding.position ?? ""),
  ].join(" ");
}

function stableSort(entries) {
  return [...entries].sort((left, right) =>
    findingSortKey(left).localeCompare(findingSortKey(right)),
  );
}

/** Run one cadence over one prepared context and return the report object. */
export function runSuite(context, cadence) {
  const selected = checksFor(cadence);
  const results = selected.map((check) => {
    const outcome = check.run(context);
    const findings = stableSort(outcome.findings ?? []);
    return {
      id: check.id,
      cadence: check.cadence,
      kind: check.kind,
      status: findings.length === 0 ? "pass" : "fail",
      counts: outcome.counts ?? {},
      findings,
      diffs: stableSort(outcome.diffs ?? []),
    };
  });
  const codes = [
    ...new Set(results.flatMap((result) => result.findings.map((finding) => finding.code))),
  ].sort();
  return {
    reportVersion,
    suite: "triage-verify",
    cadence,
    policyId: TRIAGE_POLICY_ID,
    vocabularyId: context.vocabulary.vocabularyId,
    range: context.range,
    counts: {
      linksInRange: context.links.length,
      records: context.records.length,
      captures: context.batch.captures.length,
      capturesByProvenance: Object.fromEntries(
        captureProvenanceClasses.map((entry) => [
          entry,
          context.records.reduce(
            (total, record) =>
              total + record.captures.filter((capture) => capture.provenance === entry).length,
            0,
          ),
        ]),
      ),
      accessOutcomes: countAccessOutcomes(context.records),
    },
    checks: results,
    findingCodes: codes,
    status: results.every((result) => result.status === "pass") ? "pass" : "fail",
  };
}

/** The bounded summary a model may read: counts and codes, never a quote, a URL or a page line. */
export function summarize(report) {
  return {
    suite: report.suite,
    cadence: report.cadence,
    status: report.status,
    vocabularyId: report.vocabularyId,
    policyId: report.policyId,
    range: report.range,
    counts: report.counts,
    checks: report.checks.map((check) => ({
      id: check.id,
      status: check.status,
      findings: check.findings.length,
      diffs: check.diffs.length,
      // Counts are bounded numbers and repository-owned ids. They travel with the summary because a
      // check can be silent and still be telling you something - a sweep whose zone was truncated
      // reports a pass and a count, and a count nobody reads is not a report.
      counts: check.counts,
    })),
    findingCodes: report.findingCodes,
  };
}
