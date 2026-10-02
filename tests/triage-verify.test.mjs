// The permanent triage verification suite, driven the way an operator drives it: a replayed batch
// written into a disposable root, one mutation per case, and the codes the suite is supposed to
// produce. Nothing here can see an operational artifacts directory, a real links file or the
// operational ledger.
//
// Every expectation is a frozen literal. A pin that read its expectation back out of the module it
// checks would pass on a suite that stopped checking.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { TriageVerifyError } from "../tools/triage-verify/errors.mjs";
import { presentButUnusable, usableInstant } from "../tools/triage-verify/instants.mjs";
import {
  buildContext,
  cadences,
  checksFor,
  runSuite,
  summarize,
} from "../tools/triage-verify/suite.mjs";
import {
  discoverEvidence,
  genericEvidencePaths,
  genericPath,
} from "../tools/triage-verify/evidence.mjs";
import { ledgerRecordFileName, loadBatchArtifacts } from "../tools/triage-verify/artifacts.mjs";
import { recordBatch } from "../tools/lib/triage-ledger-core.mjs";
import {
  loadVocabulary,
  validateVocabulary,
  vocabularyPhrases,
} from "../tools/triage-verify/vocabulary.mjs";
import { familyClaimRules } from "../tools/triage-verify/checks/negative-space.mjs";
import { readLinksFile, sliceRange } from "../tools/triage-verify/links.mjs";
import {
  enclosingLines,
  findLiteralOccurrences,
  findPhraseOccurrences,
  foldCase,
  lineDigest,
} from "../tools/triage-verify/text-scan.mjs";
import { buildDecisionTrace } from "../tools/job-scorer/trace.mjs";
import { manifestSchemaVersion } from "../tools/vacancy-fetch/batch.mjs";
import { renderCaptureFile, verifyCaptureFile } from "../tools/vacancy-fetch/persist.mjs";
import { sha256Utf8 } from "../tools/vacancy-fetch/digest.mjs";
import { candidateExampleRootFor, candidateScoringValues } from "../tools/candidate/load.mjs";
import {
  batchId,
  buildRecords,
  links,
  priorObservedAt,
  skippedLinkPosition,
  writePriorLedger,
  writeReplayBatch,
} from "./fixtures/triage-verify/replay-batch.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "tools", "triage-verify", "cli.mjs");

// Frozen literals. None of these is read back out of the code under test.
const EXPECTED_CADENCES = ["per-batch", "full"];
const EXPECTED_PER_BATCH_CHECKS = [
  "chain-of-custody",
  "quote-integrity",
  "completeness",
  "cross-transport",
  "negative-space",
];
const EXPECTED_FULL_CHECKS = [
  ...EXPECTED_PER_BATCH_CHECKS,
  "baseline-diff",
  "blind-extraction",
  "periodic-attestation",
];
const EXPECTED_VOCABULARY_FAMILIES = ["residence", "contract", "work_format"];
const EXPECTED_EVIDENCE_PATHS = [
  "compensation.evidenceQuote",
  "offers[].evidenceQuote",
  "role.evidence.aiProduct",
  "role.evidence.aiWork",
  "role.evidence.automation",
  "role.evidence.domain",
  "role.evidence.language",
  "role.evidence.role",
  "role.evidence.seniority",
  "role.evidence.tools",
  "role.observedLanguages[].evidenceQuote",
  "role.observedTools[].evidenceQuote",
  "source.evidenceQuote",
];
const RESIDENCE_MISS_PHRASE = "currently based in";
const INPUT_ONE = join("inputs", "001.input.json");
const INPUT_TWO = join("inputs", "002.input.json");
const TRACE_ONE = join("traces", "001.trace.json");
const TRACE_TWO = join("traces", "002.trace.json");
const CAPTURE_ONE = "001.capture.txt";
const CAPTURE_FIVE = "005.browser.capture.txt";

function disposableRoot(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "triage-verify-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

function editJson(files, name, edit) {
  const value = JSON.parse(files.get(name));
  const next = edit(value) ?? value;
  files.set(name, `${JSON.stringify(next, null, 2)}\n`);
}

/** Rewrite a capture body and restamp its header, so a body edit is not masked by a digest finding. */
function rewriteCaptureBody(files, name, transform) {
  const parsed = verifyCaptureFile(files.get(name));
  const body = transform(parsed.body);
  files.set(
    name,
    renderCaptureFile({
      header: {
        ...parsed.header,
        "normalized-sha256": sha256Utf8(body),
        "body-bytes": Buffer.byteLength(body, "utf8"),
      },
      body,
    }),
  );
}

function prepare(t, { mutate = null, ledger = false } = {}) {
  const root = disposableRoot(t);
  const batch = writeReplayBatch(root, mutate);
  return { ...batch, ledgerPath: ledger ? writePriorLedger(root) : null, root };
}

// The ledger is supplied at both cadences, as the runbook's own invocation does: a batch whose plan
// dropped links cannot be checked without the ledger those drops rest on.
function verify(t, { mutate = null, cadence = "per-batch", ledger = true, to = null } = {}) {
  const prepared = prepare(t, { mutate, ledger });
  const context = buildContext({
    artifactsDir: prepared.artifactsDir,
    from: prepared.from,
    ledgerPath: prepared.ledgerPath,
    linksFile: prepared.linksFile,
    to: to ?? prepared.to,
  });
  return { prepared, report: runSuite(context, cadence) };
}

function codes(report) {
  return report.findingCodes;
}

function checkOf(report, id) {
  const found = report.checks.find((check) => check.id === id);
  assert.ok(found !== undefined, `report has no check ${id}`);
  return found;
}

function errorCode(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof TriageVerifyError, `expected a TriageVerifyError, got ${error}`);
    return error.code;
  }
  return null;
}

// ---------------------------------------------------------------------------
// text-scan

test("case folding never moves an offset", () => {
  const text = "İstanbul based in Berlin";
  assert.equal(foldCase(text).length, text.length);
  assert.equal(foldCase("MUST BE"), "must be");
});

test("a phrase matches regardless of case", () => {
  const body = "Candidates MUST BE Currently Based In Singapore.";
  assert.deepEqual(
    findPhraseOccurrences(body, "currently based in").map((span) =>
      body.slice(span.start, span.end),
    ),
    ["Currently Based In"],
  );
});

test("a phrase matches across one line break and not across a blank line", () => {
  assert.equal(
    findPhraseOccurrences("you must be\ncurrently based in Berlin", "must be currently").length,
    1,
  );
  assert.equal(
    findPhraseOccurrences("you must be\n\ncurrently based in Berlin", "must be currently").length,
    0,
  );
});

test("a phrase is guarded by word boundaries at both ends", () => {
  // Two cases, because one guard alone catches the obvious sentence: the first is refused only by
  // the leading guard, the second only by the trailing one.
  assert.equal(findPhraseOccurrences("unbased in the office", "based in").length, 0);
  assert.equal(findPhraseOccurrences("we are based inside", "based in").length, 0);
  assert.equal(findPhraseOccurrences("we are based in Berlin", "based in").length, 1);
});

test("every occurrence of a phrase is returned, in body coordinates", () => {
  const body = "work from home. Also work from home.";
  const spans = findPhraseOccurrences(body, "work from home");
  assert.equal(spans.length, 2);
  assert.equal(body.slice(spans[1].start, spans[1].end), "work from home");
});

test("a literal quote match is byte-exact, not whitespace-tolerant", () => {
  assert.equal(findLiteralOccurrences("we are  fully remote", "fully remote").length, 1);
  assert.equal(findLiteralOccurrences("we are  fully remote", "are fully").length, 0);
});

test("the enclosing lines of a span cover the whole span", () => {
  const body = "alpha\nbeta gamma\ndelta";
  assert.deepEqual(enclosingLines(body, { start: 6, end: 10 }), { start: 6, end: 16 });
  assert.deepEqual(enclosingLines(body, { start: 0, end: 5 }), { start: 0, end: 5 });
});

test("a line digest survives spacing and case, and dies with the wording", () => {
  const one = lineDigest("You must  reside in Spain", { start: 4, end: 15 });
  const two = lineDigest("you MUST reside in Spain", { start: 4, end: 15 });
  const three = lineDigest("you must reside in Portugal", { start: 4, end: 15 });
  assert.equal(one, two);
  assert.notEqual(one, three);
});

// ---------------------------------------------------------------------------
// vocabulary

test("the shipped vocabulary loads and every phrase carries its family prefix", () => {
  const vocabulary = loadVocabulary();
  const phrases = vocabularyPhrases(vocabulary);
  assert.ok(phrases.length >= 20);
  for (const phrase of phrases) {
    assert.ok(phrase.id.startsWith(`${phrase.family}.`), phrase.id);
  }
});

test("the shipped vocabulary carries the phrase the 2026-08-18 run missed", () => {
  const phrases = vocabularyPhrases(loadVocabulary());
  const residence = phrases.filter((phrase) => phrase.family === "residence");
  assert.ok(residence.some((phrase) => phrase.text === RESIDENCE_MISS_PHRASE));
});

test("a vocabulary is refused rather than half-loaded", () => {
  const base = JSON.parse(readFileSync(loadVocabularyPath(), "utf8"));
  const mutate = (edit) => {
    const copy = structuredClone(base);
    edit(copy);
    return errorCode(() => validateVocabulary(copy));
  };
  assert.equal(
    mutate((v) => {
      v.schemaVersion = 2;
    }),
    "vocabulary_invalid",
  );
  assert.equal(
    mutate((v) => {
      v.families[0].phrases[1].id = v.families[0].phrases[0].id;
    }),
    "vocabulary_invalid",
  );
  assert.equal(
    mutate((v) => {
      v.families[0].phrases[0].id = "contract.stolen";
    }),
    "vocabulary_invalid",
  );
  assert.equal(
    mutate((v) => {
      v.families[0].phrases[0].text = "must\u0007reside";
    }),
    "vocabulary_invalid",
  );
  assert.equal(
    mutate((v) => {
      v.families[0].phrases[0].surprise = true;
    }),
    "vocabulary_invalid",
  );
  assert.equal(
    mutate((v) => {
      v.families[0].phrases[0].addedIn = "yesterday";
    }),
    "vocabulary_invalid",
  );
  assert.equal(
    mutate((v) => {
      delete v.families[0].phrases[0].source;
    }),
    "vocabulary_invalid",
  );
});

function readRepoFile(relative) {
  return readFileSync(join(repoRoot, relative), "utf8");
}

function loadVocabularyPath() {
  return join(repoRoot, "tools", "triage-verify", "vocabulary", "negative-space.v1.json");
}

// ---------------------------------------------------------------------------
// evidence discovery

test("evidence discovery finds the schema's evidence fields without naming them", (t) => {
  const prepared = prepare(t);
  const input = JSON.parse(readFileSync(join(prepared.artifactsDir, INPUT_TWO), "utf8"));
  assert.deepEqual(genericEvidencePaths(input), EXPECTED_EVIDENCE_PATHS);
});

test("a null evidence field is a discovered path but not a quote", () => {
  const input = { role: { evidence: { automation: null, domain: "seen" } } };
  const found = discoverEvidence(input);
  assert.deepEqual(found.paths, ["role.evidence.automation", "role.evidence.domain"]);
  assert.deepEqual(found.quotes, [{ path: "role.evidence.domain", value: "seen" }]);
});

test("generic paths collapse array indices", () => {
  assert.equal(genericPath("offers[3].evidenceQuote"), "offers[].evidenceQuote");
});

// ---------------------------------------------------------------------------
// links file and range

test("the links file is deduplicated by full URL with order preserved", (t) => {
  const root = disposableRoot(t);
  const path = join(root, "links.txt");
  writeFileSync(path, ["# header", "", links[1], links[0], links[1], ""].join("\n"), "utf8");
  assert.deepEqual(
    readLinksFile(path).map((link) => link.url),
    [links[1], links[0]],
  );
});

test("a links file line that is not an http URL is a caller error naming the line only", (t) => {
  const root = disposableRoot(t);
  const path = join(root, "links.txt");
  writeFileSync(path, ["ftp://example.test/job"].join("\n"), "utf8");
  let message = "";
  const code = errorCodeWith(
    () => readLinksFile(path),
    (error) => {
      message = error.message;
    },
  );
  assert.equal(code, "links_invalid");
  assert.match(message, /Line 1/u);
  assert.ok(!message.includes("example.test"), message);
});

function errorCodeWith(fn, capture) {
  try {
    fn();
  } catch (error) {
    capture(error);
    return error.code;
  }
  return null;
}

test("a batch range must be 1-based and inside the file", (t) => {
  const root = disposableRoot(t);
  const path = join(root, "links.txt");
  writeFileSync(path, links.join("\n"), "utf8");
  const all = readLinksFile(path);
  assert.deepEqual(
    sliceRange(all, 2, 3).map((link) => link.position),
    [2, 3],
  );
  assert.equal(
    errorCode(() => sliceRange(all, 0, 3)),
    "range_invalid",
  );
  assert.equal(
    errorCode(() => sliceRange(all, 3, 2)),
    "range_invalid",
  );
  assert.equal(
    errorCode(() => sliceRange(all, 1, all.length + 1)),
    "range_invalid",
  );
});

// ---------------------------------------------------------------------------
// artifacts loading

test("the artifacts loader reports a defective batch instead of throwing on it", (t) => {
  const prepared = prepare(t, {
    mutate: (payload) => {
      payload.files.set(INPUT_ONE, "{ not json");
      payload.files.set("stray-note.txt", "left over");
    },
  });
  const batch = loadBatchArtifacts(prepared.artifactsDir);
  assert.deepEqual(batch.indices, [1, 2, 3, 4, 5]);
  assert.equal(batch.inputs.get(1).error, "json_malformed");
  assert.deepEqual(batch.unexpected, ["stray-note.txt"]);
});

test("an artifacts path that is not a readable directory is a caller error", (t) => {
  const root = disposableRoot(t);
  assert.equal(
    errorCode(() => loadBatchArtifacts(join(root, "absent"))),
    "artifacts_unreadable",
  );
  assert.equal(
    errorCode(() => loadBatchArtifacts("relative/path")),
    "artifacts_path_invalid",
  );
});

// ---------------------------------------------------------------------------
// acceptance: the replayed batch

test("the suite passes on the replayed batch and actually checked something", (t) => {
  const { report } = verify(t);
  assert.equal(report.status, "pass");
  assert.deepEqual(codes(report), []);
  assert.deepEqual(
    report.checks.map((check) => check.id),
    EXPECTED_PER_BATCH_CHECKS,
  );
  assert.equal(checkOf(report, "quote-integrity").counts.quotesChecked, 26);
  assert.equal(checkOf(report, "quote-integrity").counts.quotesMatched, 26);
  assert.equal(checkOf(report, "completeness").counts.tracesRecomputed, 5);
  const sweep = checkOf(report, "negative-space").counts;
  assert.equal(sweep.hits, 6);
  assert.equal(sweep.claimed, 4);
  assert.equal(sweep.disposed, 2);
});

test("the full cadence passes and adds exactly the periodic checks", (t) => {
  const { report } = verify(t, { cadence: "full" });
  assert.equal(report.status, "pass");
  assert.deepEqual(
    report.checks.map((check) => check.id),
    EXPECTED_FULL_CHECKS,
  );
  assert.deepEqual(
    checksFor("per-batch").map((check) => check.id),
    EXPECTED_PER_BATCH_CHECKS,
  );
  assert.deepEqual(
    checksFor("full").map((check) => check.id),
    EXPECTED_FULL_CHECKS,
  );
  assert.deepEqual([...cadences], EXPECTED_CADENCES);
});

test("the baseline diff reports the change it can see and asserts the plan was obeyed", (t) => {
  const { report } = verify(t, { cadence: "full" });
  const diff = checkOf(report, "baseline-diff");
  assert.equal(diff.status, "pass");
  assert.deepEqual(
    diff.diffs.map((entry) => `${entry.code}:${entry.index}`),
    ["decision_changed:1", "flags_changed:1", "flags_changed:2"],
  );
  assert.equal(diff.counts.known, 2);
  assert.equal(diff.counts.fresh, 3);
});

test("two runs over the same directory produce byte-identical reports", (t) => {
  const prepared = prepare(t, { ledger: true });
  const once = runSuite(
    buildContext({
      artifactsDir: prepared.artifactsDir,
      from: prepared.from,
      ledgerPath: prepared.ledgerPath,
      linksFile: prepared.linksFile,
      to: prepared.to,
    }),
    "full",
  );
  const twice = runSuite(
    buildContext({
      artifactsDir: prepared.artifactsDir,
      from: prepared.from,
      ledgerPath: prepared.ledgerPath,
      linksFile: prepared.linksFile,
      to: prepared.to,
    }),
    "full",
  );
  assert.equal(JSON.stringify(once), JSON.stringify(twice));
});

test("the bounded summary carries no page text, quote or URL", (t) => {
  const { report } = verify(t, { cadence: "full" });
  const text = JSON.stringify(summarize(report));
  assert.ok(!text.includes("linkedin.com"), text);
  assert.ok(!text.includes("Singapore"), text);
  assert.ok(!text.includes("currently based in"), text);
});

// ---------------------------------------------------------------------------
// chain of custody

test("a tampered capture body fails its own digest", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      payload.files.set(
        CAPTURE_ONE,
        payload.files.get(CAPTURE_ONE).replace("Singapore office", "Berlin office"),
      );
    },
  });
  assert.ok(codes(report).includes("capture_digest_mismatch"), codes(report).join(","));
});

test("a capture stamped with another record's index is caught", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      rewriteCaptureBodyHeader(payload.files, CAPTURE_ONE, (header) => ({ ...header, index: "7" }));
    },
  });
  assert.ok(codes(report).includes("capture_index_mismatch"), codes(report).join(","));
});

test("a capture that lost its normalization record is caught", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      rewriteCaptureBodyHeader(payload.files, CAPTURE_ONE, (header) => ({
        ...header,
        normalization: "-",
      }));
    },
  });
  assert.ok(codes(report).includes("capture_normalization_unrecorded"), codes(report).join(","));
});

function rewriteCaptureBodyHeader(files, name, transform) {
  const parsed = verifyCaptureFile(files.get(name));
  files.set(name, renderCaptureFile({ header: transform(parsed.header), body: parsed.body }));
}

test("a scored record with no capture at all is caught", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      payload.files.delete(CAPTURE_ONE);
    },
  });
  assert.ok(codes(report).includes("capture_absent"), codes(report).join(","));
});

test("a usable record with no capture is reported even when it recorded no evidence", (t) => {
  // The other half of the exemption: a record that claims a page body owes a capture whether or not
  // its evidence walk found anything, so the two conditions are pinned apart.
  const { report } = verify(t, {
    mutate: (payload) => {
      payload.files.delete(CAPTURE_ONE);
      editJson(payload.files, INPUT_ONE, (input) => {
        input.offers = [];
        input.role = {
          ai: { product: "none", work: "none" },
          automation: "unknown",
          domain: "unclear",
          evidence: {
            aiProduct: null,
            aiWork: null,
            automation: null,
            domain: null,
            language: null,
            role: null,
            seniority: null,
            tools: null,
          },
          family: "unknown",
          language: "unknown",
          observedTools: [],
          observedLanguages: [],
          seniority: "unknown",
        };
        input.source.evidenceQuote = null;
      });
      rebuildTrace(payload.files, INPUT_ONE, TRACE_ONE);
    },
  });
  const finding = checkOf(report, "chain-of-custody").findings.find(
    (entry) => entry.code === "capture_absent",
  );
  assert.ok(finding !== undefined, codes(report).join(","));
  assert.equal(finding.index, 1);
});

test("the record that legitimately has no capture is not reported", (t) => {
  const { report } = verify(t);
  assert.equal(checkOf(report, "chain-of-custody").counts.recordsWithCapture, 4);
  assert.equal(checkOf(report, "chain-of-custody").status, "pass");
});

// ---------------------------------------------------------------------------
// quote integrity

test("a fabricated evidence quote is caught", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, INPUT_ONE, (input) => {
        input.role.evidence.domain = "Acme Robotics is hiring for our Berlin office.";
      });
      rebuildTrace(payload.files, INPUT_ONE, TRACE_ONE);
    },
  });
  const finding = checkOf(report, "quote-integrity").findings.find(
    (entry) => entry.code === "quote_absent",
  );
  assert.ok(finding !== undefined, JSON.stringify(codes(report)));
  assert.equal(finding.path, "role.evidence.domain");
  assert.equal(finding.quoteChars, 46);
  assert.match(finding.quoteSha256, /^[0-9a-f]{64}$/u);
});

test("a fabricated AI quote is caught like any other evidence", (t) => {
  // knowledge/job-match-rules.md#7-decision-trace-contract's AI observation rests on its quote, and the walk reaches it without being told: a statement
  // the page never made fails the check that holds every quote against the capture.
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, INPUT_ONE, (input) => {
        input.role.ai.work = "required";
        input.role.evidence.aiWork = "Hands-on experience with LLM evaluation";
      });
      rebuildTrace(payload.files, INPUT_ONE, TRACE_ONE);
    },
  });
  const finding = checkOf(report, "quote-integrity").findings.find(
    (entry) => entry.code === "quote_absent",
  );
  assert.ok(finding !== undefined, JSON.stringify(codes(report)));
  assert.equal(finding.path, "role.evidence.aiWork");
});

test("a quote that differs only in whitespace still fails, under its own code", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, INPUT_ONE, (input) => {
        input.role.evidence.tools = "TypeScript  and Playwright";
      });
      rebuildTrace(payload.files, INPUT_ONE, TRACE_ONE);
    },
  });
  assert.ok(codes(report).includes("quote_whitespace_variant"), codes(report).join(","));
  assert.ok(!codes(report).includes("quote_absent"), codes(report).join(","));
});

test("a scored record with no evidence at all fails instead of passing quietly", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, INPUT_ONE, (input) => {
        input.offers = [];
        input.role = {
          ai: { product: "none", work: "none" },
          automation: "unknown",
          domain: "unclear",
          evidence: {
            aiProduct: null,
            aiWork: null,
            automation: null,
            domain: null,
            language: null,
            role: null,
            seniority: null,
            tools: null,
          },
          family: "unknown",
          language: "unknown",
          observedTools: [],
          observedLanguages: [],
          seniority: "unknown",
        };
        input.source.evidenceQuote = null;
      });
      rebuildTrace(payload.files, INPUT_ONE, TRACE_ONE);
    },
  });
  assert.ok(codes(report).includes("no_evidence_recorded"), codes(report).join(","));
});

test("a record whose input cannot be read is never silently skipped", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      payload.files.set(INPUT_ONE, "{ broken");
    },
  });
  assert.ok(codes(report).includes("record_not_verifiable"), codes(report).join(","));
  assert.ok(codes(report).includes("input_unreadable"), codes(report).join(","));
});

function rebuildTrace(files, inputName, traceName) {
  // The trace has to follow the input, or every quote case would also report a trace mismatch and
  // stop proving anything about quotes.
  const input = JSON.parse(files.get(inputName));
  files.set(traceName, `${JSON.stringify(buildDecisionTrace(input), null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// completeness

test("an edited trace no longer matches the input that produced it", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, TRACE_ONE, (trace) => {
        trace.decision = "EVALUATED";
      });
    },
  });
  assert.ok(codes(report).includes("trace_mismatch"), codes(report).join(","));
});

test("a missing trace is reported", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      payload.files.delete(TRACE_ONE);
    },
  });
  assert.ok(codes(report).includes("trace_absent"), codes(report).join(","));
});

test("an input scored under a superseded policy is reported, not re-scored", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, INPUT_ONE, (input) => {
        input.policyId = "triage-r1-05a-2026-08-04";
      });
    },
  });
  assert.ok(codes(report).includes("policy_drift"), codes(report).join(","));
  assert.ok(!codes(report).includes("trace_mismatch"), codes(report).join(","));
});

test("an input filed under the wrong index is reported", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, INPUT_ONE, (input) => {
        input.inputIndex = 9;
      });
    },
  });
  assert.ok(codes(report).includes("input_index_mismatch"), codes(report).join(","));
});

test("a record's index is its link's place in the list, not its file number", (t) => {
  // The plan withheld position 3, so record 003 is the fourth link. The dense number - what the
  // transport named the file - is exactly the wrong answer, in the input and in the trace.
  const INPUT_THREE = join("inputs", "003.input.json");
  const TRACE_THREE = join("traces", "003.trace.json");
  const healthy = verify(t);
  assert.equal(healthy.report.status, "pass", codes(healthy.report).join(","));
  const third = healthy.prepared.records.find((record) => record.index === 3);
  assert.equal(third.input.inputIndex, 4);

  const denseInput = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, INPUT_THREE, (input) => {
        input.inputIndex = 3;
      });
    },
  });
  assert.deepEqual(
    checkOf(denseInput.report, "completeness").findings.filter(
      (entry) => entry.code === "input_index_mismatch",
    ),
    [{ code: "input_index_mismatch", index: 3 }],
  );
  const denseTrace = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, TRACE_THREE, (trace) => {
        trace.input_index = 3;
      });
    },
  });
  assert.deepEqual(
    checkOf(denseTrace.report, "completeness").findings.filter(
      (entry) => entry.code === "trace_index_mismatch",
    ),
    [{ code: "trace_index_mismatch", index: 3 }],
  );
});

test("the index is counted from the start of the verified range, and from a link's first line", (t) => {
  // Two leading lines the batch does not cover push the range to 3..8; the records still say 1..6.
  const shifted = prepare(t, {
    ledger: true,
    mutate: (payload) => {
      payload.links = [
        "https://www.linkedin.com/jobs/view/4599999991/",
        "https://www.linkedin.com/jobs/view/4599999992/",
        payload.links,
      ].join("\n");
    },
  });
  const report = runSuite(
    buildContext({
      artifactsDir: shifted.artifactsDir,
      from: 3,
      ledgerPath: shifted.ledgerPath,
      linksFile: shifted.linksFile,
      to: 8,
    }),
    "per-batch",
  );
  assert.equal(report.status, "pass", codes(report).join(","));

  // A second raw line that normalizes onto the first link sits at position 7. The record is judged
  // by the first line, so it stays healthy.
  const respelled = verify(t, {
    mutate: (payload) => {
      payload.links = `${payload.links}${links[0]}?utm_source=share\n`;
    },
    to: 7,
  });
  assert.ok(
    !codes(respelled.report).includes("input_index_mismatch"),
    codes(respelled.report).join(","),
  );
});

test("a batch that withheld a closed link and a known one verifies green at the cheap cadence", (t) => {
  // Acceptance of task 061: one `skip_closed` (position 3, the fixture's own) and one `skip_known`
  // (position 1, whose record this variant removes) against a pre-populated ledger.
  const { report, prepared } = verify(t, {
    mutate: (payload) => {
      payload.files.delete(CAPTURE_ONE);
      payload.files.delete(INPUT_ONE);
      payload.files.delete(TRACE_ONE);
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records = manifest.records.filter((record) => record.index !== 1);
      });
      editJson(payload.files, "disposition.json", (file) => {
        file.dispositions = file.dispositions.filter((entry) => entry.recordIndex !== 1);
      });
    },
  });
  assert.equal(report.status, "pass", codes(report).join(","));
  const counts = checkOf(report, "completeness").counts;
  assert.equal(counts.linksInRange, 6);
  assert.equal(counts.linksCovered, 4);
  assert.equal(counts.records, 4);
  const plan = JSON.parse(readFileSync(join(prepared.artifactsDir, "plan.json"), "utf8"));
  assert.deepEqual(
    plan.items.filter((item) => [1, 3].includes(item.input_index)).map((item) => item.action),
    ["skip_known", "skip_closed"],
  );
});

test("a link of the range with no record and no plan entry is uncovered", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      payload.files.delete(INPUT_TWO);
      payload.files.delete(join("traces", "002.trace.json"));
      payload.files.delete("002.capture.txt");
      editJson(payload.files, "plan.json", (plan) => {
        plan.items = plan.items.filter((item) => item.input_index !== 2);
      });
    },
  });
  const finding = checkOf(report, "completeness").findings.find(
    (entry) => entry.code === "link_uncovered",
  );
  assert.ok(finding !== undefined, codes(report).join(","));
  assert.equal(finding.position, 2);
});

test("the link the plan skipped is not reported as uncovered", (t) => {
  const { report } = verify(t);
  assert.equal(checkOf(report, "completeness").counts.linksCovered, 5);
  assert.equal(checkOf(report, "completeness").status, "pass");
});

test("without a plan every link of the range must have a record", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      payload.files.delete("plan.json");
    },
  });
  const finding = checkOf(report, "completeness").findings.find(
    (entry) => entry.code === "link_uncovered",
  );
  assert.ok(finding !== undefined, codes(report).join(","));
  assert.equal(finding.position, 3);
});

test("a record claiming a link outside the range is reported", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, INPUT_TWO, (input) => {
        input.source.sourceRef = "https://www.linkedin.com/jobs/view/4599999999/";
      });
      rebuildTrace(payload.files, INPUT_TWO, join("traces", "002.trace.json"));
    },
  });
  assert.ok(codes(report).includes("record_outside_range"), codes(report).join(","));
});

test("two records claiming one link are reported", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, INPUT_TWO, (input) => {
        input.source.sourceRef = links[0];
      });
      rebuildTrace(payload.files, INPUT_TWO, join("traces", "002.trace.json"));
    },
  });
  assert.ok(codes(report).includes("duplicate_record_for_link"), codes(report).join(","));
});

test("a stray file in the artifacts directory is reported", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      payload.files.set("notes.md", "scratch");
    },
  });
  assert.ok(codes(report).includes("unexpected_artifact"), codes(report).join(","));
});

// ---------------------------------------------------------------------------
// cross-transport

test("a manifest digest that disagrees with the capture is caught", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[0].persisted.sha256 = "0".repeat(64);
      });
    },
  });
  assert.ok(codes(report).includes("manifest_capture_digest_mismatch"), codes(report).join(","));
});

test("a manifest link that disagrees with the recorded source ref is caught", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[1].requestedUrl = "https://www.linkedin.com/jobs/view/4588888888/";
      });
    },
  });
  assert.ok(codes(report).includes("manifest_source_ref_mismatch"), codes(report).join(","));
});

test("a capture stamped with another vacancy's URL is caught", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      rewriteCaptureBodyHeader(payload.files, CAPTURE_ONE, (header) => ({
        ...header,
        "requested-url": "https://www.linkedin.com/jobs/view/4577777777/",
      }));
    },
  });
  assert.ok(codes(report).includes("capture_source_ref_mismatch"), codes(report).join(","));
});

test("scoring a vacancy the primary transport handed to the browser needs the browser capture", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      payload.files.delete(CAPTURE_FIVE);
    },
  });
  assert.ok(codes(report).includes("fallback_not_honoured"), codes(report).join(","));
});

test("scoring a vacancy the source calls closed is caught", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, join("inputs", "003.input.json"), (input) => {
        input.source.accessOutcome = "usable";
        input.source.accessReason = null;
        input.role.ai = { product: "none", work: "none" };
        input.offers = [
          {
            companyRegion: "OTHER",
            compensationMarket: "unknown",
            contractorEligibility: "unknown",
            engagementPath: null,
            evidenceQuote: "Globex Payments was hiring a Senior QA Engineer for its Berlin office.",
            relocationCountry: null,
            relocationCountryCode: null,
            relocationSupport: "unknown",
            residenceRequirementCountry: null,
            residenceRequirementCountryCode: null,
            residenceRestriction: "unknown",
            sponsorship: "unknown",
            timezone: "tz_unknown",
            timezoneDistance: "unknown",
            westRegion: null,
            workAuthorization: "unknown",
            workFormat: "Unknown",
          },
        ];
      });
      rebuildTrace(
        payload.files,
        join("inputs", "003.input.json"),
        join("traces", "003.trace.json"),
      );
    },
  });
  assert.ok(codes(report).includes("closed_source_scored"), codes(report).join(","));
});

test("a batch with no manifest still runs the transport-independent invariants", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      payload.files.delete("fetch-manifest.json");
    },
  });
  assert.equal(checkOf(report, "cross-transport").counts.manifestPresent, false);
  assert.equal(report.status, "pass");
});

// ---------------------------------------------------------------------------
// negative space

test("a hard residence line nobody quoted fails the sweep", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      rewriteCaptureBody(payload.files, "002.capture.txt", (body) =>
        body.replace(
          "You will own the end-to-end automation framework",
          "You must be based in Germany for this role.\n\nYou will own the end-to-end automation framework",
        ),
      );
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[1].persisted = null;
        manifest.records[1].usable = false;
        manifest.records[1].outcome = "access_failure";
        manifest.records[1].fallback = "browser";
      });
    },
  });
  const finding = checkOf(report, "negative-space").findings.find(
    (entry) => entry.code === "negative_space_unclaimed",
  );
  assert.ok(finding !== undefined, codes(report).join(","));
  assert.equal(finding.family, "residence");
  assert.deepEqual(finding.phraseIds, ["residence.must_be_based_in"]);
  assert.match(finding.lineSha256, /^[0-9a-f]{64}$/u);
});

test("a hit in page chrome is reported under its own code, not dropped", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      rewriteCaptureBody(
        payload.files,
        "002.capture.txt",
        (body) => `${body}\nPeople also viewed\n\nYou must be based in Germany for this role.\n`,
      );
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[1].persisted = null;
        manifest.records[1].usable = false;
        manifest.records[1].outcome = "access_failure";
        manifest.records[1].fallback = "browser";
      });
    },
  });
  const finding = checkOf(report, "negative-space").findings.find(
    (entry) => entry.code === "negative_space_outside_main_zone",
  );
  assert.ok(finding !== undefined, codes(report).join(","));
  assert.equal(finding.family, "residence");
  assert.equal(finding.terminator, "zone.people_also_viewed");
  assert.equal(checkOf(report, "negative-space").counts.outsideMainZone, 1);
});

test("removing a disposition brings its hit back", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, "disposition.json", (file) => {
        file.dispositions = file.dispositions.slice(0, 1);
      });
    },
  });
  assert.ok(codes(report).includes("negative_space_unclaimed"), codes(report).join(","));
});

test("a disposition whose line changed goes stale rather than covering the new line", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, "disposition.json", (file) => {
        file.dispositions[1].lineSha256 = "a".repeat(64);
      });
    },
  });
  assert.ok(codes(report).includes("disposition_stale"), codes(report).join(","));
  assert.ok(codes(report).includes("negative_space_unclaimed"), codes(report).join(","));
});

test("a disposition file is validated rather than trusted", (t) => {
  const cases = [
    [
      "disposition_unknown_family",
      (file) => {
        file.dispositions[0].family = "invented";
      },
    ],
    [
      "disposition_unknown_value",
      (file) => {
        file.dispositions[0].disposition = "fine";
      },
    ],
    [
      "disposition_duplicate",
      (file) => {
        file.dispositions.push({ ...file.dispositions[0] });
      },
    ],
    [
      "disposition_invalid",
      (file) => {
        file.dispositions[0].surprise = 1;
      },
    ],
  ];
  for (const [expected, edit] of cases) {
    const { report } = verify(t, {
      mutate: (payload) => {
        editJson(payload.files, "disposition.json", edit);
      },
    });
    assert.ok(codes(report).includes(expected), `${expected} not in ${codes(report).join(",")}`);
  }
});

// ---------------------------------------------------------------------------
// baseline diff

test("refetching a vacancy the ledger already closed is a finding", (t) => {
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      editJson(payload.files, INPUT_ONE, (input) => {
        input.source.sourceRef = links[2];
        input.source.finalUrl = links[2];
      });
      rebuildTrace(payload.files, INPUT_ONE, TRACE_ONE);
      rewriteCaptureBodyHeader(payload.files, CAPTURE_ONE, (header) => ({
        ...header,
        "requested-url": links[2],
        "final-url": links[2],
      }));
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[0].requestedUrl = links[2];
      });
    },
  });
  assert.ok(codes(report).includes("refetched_closed_vacancy"), codes(report).join(","));
});

test("a ledger that already carries this batch makes the diff inconclusive, loudly", (t) => {
  const prepared = prepare(t, { ledger: true });
  const ledgerPath = prepared.ledgerPath;
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  for (const entry of ledger.entries) entry.last_checked = "2026-08-24T00:00:00.000Z";
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  const report = runSuite(
    buildContext({
      artifactsDir: prepared.artifactsDir,
      from: prepared.from,
      ledgerPath,
      linksFile: prepared.linksFile,
      to: prepared.to,
    }),
    "full",
  );
  const rows = checkOf(report, "baseline-diff").findings.filter(
    (entry) => entry.code === "ledger_already_recorded",
  );
  assert.ok(rows.length > 0, codes(report).join(","));
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ["code", "planPosition"]);
  }
});

// ---------------------------------------------------------------------------
// periodic attestation

test("the full cadence needs an attestation and checks every probe", (t) => {
  const cases = [
    [
      "attestation_absent",
      (payload) => {
        payload.files.delete("attestation.json");
      },
    ],
    [
      "probe_missing",
      (payload) => {
        editJson(payload.files, "attestation.json", (file) => {
          file.probes = file.probes.slice(0, 1);
        });
      },
    ],
    [
      "probe_failed",
      (payload) => {
        editJson(payload.files, "attestation.json", (file) => {
          file.probes[0].verdict = "failed";
        });
      },
    ],
    [
      "probe_unknown",
      (payload) => {
        editJson(payload.files, "attestation.json", (file) => {
          file.probes[0].probe = "vibes";
        });
      },
    ],
    [
      "probe_stale",
      (payload) => {
        editJson(payload.files, "attestation.json", (file) => {
          file.probes[1].ranAt = "2026-07-01T00:00:00.000Z";
        });
      },
    ],
  ];
  for (const [expected, mutate] of cases) {
    const { report } = verify(t, { cadence: "full", mutate });
    assert.ok(codes(report).includes(expected), `${expected} not in ${codes(report).join(",")}`);
  }
});

test("the periodic checks do not run at the per-batch cadence", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      payload.files.delete("attestation.json");
    },
  });
  assert.equal(report.status, "pass");
  assert.equal(
    report.checks.some((check) => check.id === "periodic-attestation"),
    false,
  );
});

// ---------------------------------------------------------------------------
// the CLI

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
}

test("the CLI exits 0 on a pass, 2 on findings and 1 on a caller mistake", (t) => {
  const prepared = prepare(t, { ledger: true });
  const base = [
    "--artifacts-dir",
    prepared.artifactsDir,
    "--links-file",
    prepared.linksFile,
    "--from",
    String(prepared.from),
    "--to",
    String(prepared.to),
    "--ledger",
    prepared.ledgerPath,
  ];
  const pass = runCli(base);
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(JSON.parse(pass.stdout).status, "pass");

  writeFileSync(join(prepared.artifactsDir, "traces", "001.trace.json"), "{}\n", "utf8");
  const fail = runCli(base);
  assert.equal(fail.status, 2, fail.stderr);
  assert.equal(JSON.parse(fail.stdout).status, "fail");

  const bad = runCli([...base, "--surprise", "1"]);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr.split("\n")[0]).error, "argument_unknown");
});

test("the CLI refuses relative paths and repeated or empty flags", (t) => {
  const prepared = prepare(t);
  const base = [
    "--artifacts-dir",
    prepared.artifactsDir,
    "--links-file",
    prepared.linksFile,
    "--from",
    "1",
    "--to",
    "6",
  ];
  const cases = [
    [
      [
        "--artifacts-dir",
        "artifacts",
        "--links-file",
        prepared.linksFile,
        "--from",
        "1",
        "--to",
        "6",
      ],
      "argument_invalid",
    ],
    [[...base, "--from", "2"], "argument_repeated"],
    [[...base, "--cadence"], "argument_value_missing"],
    [[...base, "--cadence", "sometimes"], "argument_invalid"],
    [["--links-file", prepared.linksFile, "--from", "1", "--to", "6"], "argument_missing"],
  ];
  for (const [args, expected] of cases) {
    const result = runCli(args);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(JSON.parse(result.stderr.split("\n")[0]).error, expected, args.join(" "));
  }
});

test("the CLI writes the report beside the batch, and none when asked for none", (t) => {
  const prepared = prepare(t, { ledger: true });
  const base = [
    "--artifacts-dir",
    prepared.artifactsDir,
    "--links-file",
    prepared.linksFile,
    "--from",
    "1",
    "--to",
    "6",
    "--ledger",
    prepared.ledgerPath,
  ];
  const reportPath = join(prepared.artifactsDir, "verification-report.json");
  assert.equal(existsSync(reportPath), false);
  assert.equal(runCli(base).status, 0);
  assert.equal(existsSync(reportPath), true);

  const other = join(prepared.root, "elsewhere.json");
  assert.equal(runCli([...base, "--report", other]).status, 0);
  assert.equal(existsSync(other), true);

  rmSync(reportPath);
  assert.equal(runCli([...base, "--report", "none"]).status, 0);
  assert.equal(existsSync(reportPath), false);
});

test("the CLI never prints a vacancy URL or a page line", (t) => {
  const prepared = prepare(t, {
    mutate: (payload) => {
      editJson(payload.files, INPUT_ONE, (input) => {
        input.role.evidence.domain = "Fabricated line about Singapore that the page never carried.";
      });
    },
  });
  const result = runCli([
    "--artifacts-dir",
    prepared.artifactsDir,
    "--links-file",
    prepared.linksFile,
    "--from",
    "1",
    "--to",
    "6",
  ]);
  assert.equal(result.status, 2);
  assert.ok(!result.stdout.includes("linkedin.com"), result.stdout);
  assert.ok(!result.stdout.includes("Fabricated line"), result.stdout);
  assert.ok(!result.stdout.includes("Acme Robotics"), result.stdout);

  // Stdout is the summary, not the report: per-finding detail is a count here and a file there.
  const printed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(printed).sort(), [
    "cadence",
    "checks",
    "counts",
    "findingCodes",
    "policyId",
    "range",
    "status",
    "suite",
    "vocabularyId",
  ]);
  for (const check of printed.checks) {
    assert.equal(typeof check.findings, "number");
    assert.deepEqual(Object.keys(check).sort(), ["counts", "diffs", "findings", "id", "status"]);
  }
});

test("an artifacts directory the suite cannot read is a caller error, not a pass", (t) => {
  const root = disposableRoot(t);
  const linksFile = join(root, "links.txt");
  writeFileSync(linksFile, links.join("\n"), "utf8");
  mkdirSync(join(root, "empty"));
  const result = runCli([
    "--artifacts-dir",
    join(root, "missing"),
    "--links-file",
    linksFile,
    "--from",
    "1",
    "--to",
    "6",
  ]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr.split("\n")[0]).error, "artifacts_unreadable");
});

// ---------------------------------------------------------------------------
// claiming is bound to the field that decided something

test("every shipped vocabulary family has a claim rule", () => {
  const families = loadVocabulary().families.map((family) => family.id);
  assert.deepEqual(families, EXPECTED_VOCABULARY_FAMILIES);
  for (const family of families) {
    assert.equal(typeof familyClaimRules[family], "function", family);
  }
});

test("a quote that covers the residence line claims nothing when the offer recorded no restriction", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, INPUT_ONE, (input) => {
        input.offers[0].residenceRestriction = "none";
        input.offers[0].residenceRequirementCountry = null;
        input.offers[0].residenceRequirementCountryCode = null;
      });
      rebuildTrace(payload.files, INPUT_ONE, TRACE_ONE);
    },
  });
  const finding = checkOf(report, "negative-space").findings.find(
    (entry) => entry.code === "negative_space_unclaimed" && entry.family === "residence",
  );
  assert.ok(finding !== undefined, codes(report).join(","));
  assert.deepEqual(finding.phraseIds, ["residence.currently_based_in"]);
});

test("a work-format hit is not claimed by an offer that recorded no format", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, INPUT_TWO, (input) => {
        input.offers[0].workFormat = "Unknown";
        input.offers[0].contractorEligibility = "unknown";
        input.offers[0].engagementPath = null;
      });
      rebuildTrace(payload.files, INPUT_TWO, join("traces", "002.trace.json"));
    },
  });
  const families = checkOf(report, "negative-space")
    .findings.filter((entry) => entry.code === "negative_space_unclaimed")
    .map((entry) => entry.family)
    .sort();
  assert.deepEqual([...new Set(families)], ["contract", "work_format"]);
});

// ---------------------------------------------------------------------------
// provenance and the unavailable class

test("a capture the manifest did not fetch is counted as a transcript, not as an anchored one", (t) => {
  const { report } = verify(t);
  assert.deepEqual(report.counts.capturesByProvenance, {
    http_fetch: 3,
    transcript: 1,
    unverified: 0,
  });
  assert.equal(checkOf(report, "chain-of-custody").counts.httpFetched, 3);
  assert.equal(checkOf(report, "chain-of-custody").counts.transcribed, 1);
});

test("the report counts the outcome class that owes neither a capture nor a quote", (t) => {
  const { report } = verify(t);
  assert.deepEqual(report.counts.accessOutcomes, {
    usable: 3,
    closed: 2,
    technical_unavailable: 0,
    unreadable: 0,
  });
});

test("a declared closure the manifest does not corroborate is a finding", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[2].outcome = "active";
      });
    },
  });
  assert.ok(codes(report).includes("closure_not_corroborated"), codes(report).join(","));
});

test("a declared technical unavailability the manifest does not corroborate is a finding", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      const name = join("inputs", "004.input.json");
      editJson(payload.files, name, (input) => {
        input.source.accessOutcome = "technical_unavailable";
        input.source.accessReason = "no response after retry";
      });
      rebuildTrace(payload.files, name, join("traces", "004.trace.json"));
    },
  });
  assert.ok(codes(report).includes("unavailability_not_corroborated"), codes(report).join(","));
});

test("without a manifest an uncorroborated unavailability is reported as a difference", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      payload.files.delete("fetch-manifest.json");
    },
  });
  const diff = checkOf(report, "cross-transport").diffs.find(
    (entry) => entry.code === "unavailability_uncorroborated_no_manifest",
  );
  assert.ok(diff !== undefined, JSON.stringify(checkOf(report, "cross-transport").diffs));
  assert.deepEqual(diff.indices, [4]);
});

// A record the manifest called a live, usable posting, whose body was not the posting: the shape of
// a sign-in form in a language the adapter's markers do not cover. Record 2's primary capture becomes
// that form (the manifest names it, with its digest, so it stays the record's own fetch), its input
// declares a technical unavailability, and - unless `stamp` is null - the browser retry left a
// capture of the same wall stamped with what it saw.
const SIGN_IN_FORM = "Aanmelden\n\nNieuw op LinkedIn?\n\nWord nu lid.\n";
const BROWSER_WALL = "Sign in\n\nNew to LinkedIn?\n\nJoin now\n";

function declareUnavailable(payload, nnn) {
  const name = join("inputs", `${nnn}.input.json`);
  const template = JSON.parse(payload.files.get(join("inputs", "004.input.json")));
  editJson(payload.files, name, (input) => ({
    ...template,
    inputIndex: input.inputIndex,
    source: {
      ...template.source,
      accessOutcome: "technical_unavailable",
      accessReason: "the adapter body and the browser retry both rendered a sign-in wall",
      finalUrl: input.source.finalUrl,
      sourceRef: input.source.sourceRef,
    },
  }));
  rebuildTrace(payload.files, name, join("traces", `${nnn}.trace.json`));
}

function browserRetry(
  payload,
  nnn,
  { stamp = "access_failure", primaryFile = "002.capture.txt" } = {},
) {
  const input = JSON.parse(payload.files.get(join("inputs", `${nnn}.input.json`)));
  const primary = verifyCaptureFile(payload.files.get(primaryFile));
  payload.files.set(
    `${nnn}.browser.capture.txt`,
    renderCaptureFile({
      header: {
        ...primary.header,
        index: Number(nnn),
        adapter: "in-app-browser@1",
        "requested-url": input.source.sourceRef,
        "final-url": input.source.sourceRef,
        "http-status": null,
        outcome: stamp,
        "access-barrier": stamp === "access_failure" ? "authentication" : null,
        "normalized-sha256": sha256Utf8(BROWSER_WALL),
        "body-bytes": Buffer.byteLength(BROWSER_WALL, "utf8"),
      },
      body: BROWSER_WALL,
    }),
  );
}

function usableButWalled(payload, { stamp = "access_failure" } = {}) {
  rewriteCaptureBody(payload.files, "002.capture.txt", () => SIGN_IN_FORM);
  editJson(payload.files, "fetch-manifest.json", (manifest) => {
    manifest.records[1].persisted.sha256 = sha256Utf8(SIGN_IN_FORM);
    manifest.records[1].persisted.bytes = Buffer.byteLength(SIGN_IN_FORM, "utf8");
  });
  // The disposition of the old body's benefit line has no line left to stand on.
  editJson(payload.files, "disposition.json", (file) => {
    file.dispositions = file.dispositions.filter((entry) => entry.recordIndex !== 2);
  });
  declareUnavailable(payload, "002");
  if (stamp !== null) browserRetry(payload, "002", { stamp });
}

test("a usable record the browser retry found walled is recorded as unavailable and named", (t) => {
  const { report } = verify(t, { mutate: (payload) => usableButWalled(payload) });
  assert.equal(report.status, "pass", codes(report).join(","));
  const check = checkOf(report, "cross-transport");
  assert.deepEqual(
    check.diffs.find((entry) => entry.code === "unavailability_from_browser_retry"),
    { code: "unavailability_from_browser_retry", indices: [2] },
  );
  // The manifest did reach a verdict here, so the record is not in the unresolved residual.
  assert.equal(check.counts.manifestUnresolved, 1);
});

test("an absent record whose confirmation load met a wall is recorded as unavailable", (t) => {
  // The confirmation load is the retry the procedure owes an `absent` record; a wall on it is a
  // technical failure, not the posting being gone.
  const { report } = verify(t, {
    mutate: (payload) => {
      declareUnavailable(payload, "004");
      browserRetry(payload, "004");
    },
  });
  assert.equal(report.status, "pass", codes(report).join(","));
  assert.deepEqual(
    checkOf(report, "cross-transport").diffs.find(
      (entry) => entry.code === "unavailability_from_browser_retry",
    ),
    { code: "unavailability_from_browser_retry", indices: [4] },
  );
});

test("only a verified browser capture stamped access_failure corroborates a usable record's wall", (t) => {
  const stillAFinding = (mutate, label) => {
    const { report } = verify(t, { mutate });
    assert.ok(
      codes(report).includes("unavailability_not_corroborated"),
      `${label}: ${codes(report).join(",")}`,
    );
    assert.equal(
      checkOf(report, "cross-transport").diffs.some(
        (entry) => entry.code === "unavailability_from_browser_retry",
      ),
      false,
      label,
    );
  };
  // Nothing looked at it again.
  stillAFinding((payload) => usableButWalled(payload, { stamp: null }), "no retry");
  // A silent stamp says nothing about what the browser saw.
  stillAFinding((payload) => usableButWalled(payload, { stamp: "-" }), "silent stamp");
  // A capture whose bytes no longer match its own stamp is not evidence of anything.
  stillAFinding((payload) => {
    usableButWalled(payload);
    const file = payload.files.get("002.browser.capture.txt");
    payload.files.set("002.browser.capture.txt", file.replace("Join now", "Join n0w"));
  }, "broken digest");
  // The fetch's own capture restamped as a wall is not a retry: the manifest still names it, with
  // its digest, so it stays the record's fetch however its header reads.
  stillAFinding((payload) => {
    usableButWalled(payload, { stamp: null });
    const primary = verifyCaptureFile(payload.files.get("002.capture.txt"));
    payload.files.set(
      "002.capture.txt",
      renderCaptureFile({
        header: {
          ...primary.header,
          outcome: "access_failure",
          "access-barrier": "authentication",
        },
        body: primary.body,
      }),
    );
  }, "restamped fetch capture");
});

test("a closure the source stated is not reopened by a browser wall", (t) => {
  // `closed` is read out of a body whose structural checks held and owes no retry, so a wall stamp
  // beside it corroborates nothing. The code itself is asserted: `closed_source_scored` fires here
  // too, so a status assertion would pass on the wrong finding.
  const { report } = verify(t, {
    mutate: (payload) => {
      declareUnavailable(payload, "003");
      browserRetry(payload, "003", { primaryFile: "003.capture.txt" });
    },
  });
  assert.ok(codes(report).includes("unavailability_not_corroborated"), codes(report).join(","));
});

// ---------------------------------------------------------------------------
// blind extraction

test("the full cadence needs a blind extraction and compares its outcome", (t) => {
  const blindFile = join("blind", "002.input.json");
  const absent = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      payload.files.delete(blindFile);
    },
  });
  assert.ok(
    codes(absent.report).includes("blind_extraction_absent"),
    codes(absent.report).join(","),
  );

  const disagrees = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      editJson(payload.files, blindFile, (input) => {
        input.offers[0].workFormat = "On-site";
      });
    },
  });
  const finding = checkOf(disagrees.report, "blind-extraction").findings.find(
    (entry) => entry.code === "blind_extraction_disagrees",
  );
  assert.ok(finding !== undefined, codes(disagrees.report).join(","));
  assert.ok(finding.fields.includes("selected_work_format"), JSON.stringify(finding.fields));

  const fabricated = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      editJson(payload.files, blindFile, (input) => {
        input.source.evidenceQuote = "A line the blind agent invented.";
      });
    },
  });
  assert.ok(
    codes(fabricated.report).includes("blind_quote_absent"),
    codes(fabricated.report).join(","),
  );

  const unknown = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      payload.files.set(join("blind", "009.input.json"), payload.files.get(blindFile));
      payload.files.delete(blindFile);
    },
  });
  assert.ok(codes(unknown.report).includes("blind_index_unknown"), codes(unknown.report).join(","));
});

// ---------------------------------------------------------------------------
// the plan is the baseline, and the ledger checks the plan

test("a plan that disagrees with the ledger it claims to come from is a finding", (t) => {
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      editJson(payload.files, "plan.json", (plan) => {
        plan.items[0].decision = "EVALUATED";
      });
    },
  });
  assert.ok(codes(report).includes("plan_disagrees_with_ledger"), codes(report).join(","));
});

test("a record the plan never mentioned is a finding", (t) => {
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      editJson(payload.files, "plan.json", (plan) => {
        plan.items = plan.items.filter((item) => item.input_index !== 2);
      });
    },
  });
  assert.ok(codes(report).includes("record_absent_from_plan"), codes(report).join(","));
});

test("the periodic diff needs the plan, and says so when it is missing", (t) => {
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      payload.files.delete("plan.json");
    },
  });
  assert.ok(codes(report).includes("plan_absent"), codes(report).join(","));
});

// ---------------------------------------------------------------------------
// the wiring

// The verification suite is an operator action over an artifacts directory no test can reach, so
// what a suite can hold is the same three things it holds for the cutover: the procedure exists, it
// is reachable from the documents that send an operator to it, and it names the boundary that makes
// it enforceable rather than optional.
test("the batch-triage verification procedure is reachable and states its own ordering", () => {
  const runbook = readRepoFile("docs/runbooks/triage-verification.md");
  const contract = readRepoFile("instructions/operating-contract.md");
  const review = readRepoFile("docs/runbooks/triage-review.md");
  const precedence = readRepoFile("knowledge/precedence.md");

  for (const [label, source] of [
    ["operating contract", contract],
    ["review runbook", review],
    ["precedence", precedence],
  ]) {
    assert.equal(
      source.includes("docs/runbooks/triage-verification.md") ||
        source.includes("triage-verification.md"),
      true,
      `${label} must name the verification runbook`,
    );
  }
  assert.equal(
    contract.includes("tools/triage-verify/"),
    true,
    "the operating contract must name the suite that verifies a batch",
  );
  // The ordering is what keeps the baseline comparison meaningful and stops an unverified batch from
  // being recorded; both documents that own a half of it have to say so.
  assert.match(runbook, /recordBatch/);
  assert.match(review, /triage-verification\.md/);
  for (const cadence of ["per-batch", "full"]) {
    assert.equal(runbook.includes(cadence), true, `runbook: ${cadence}`);
  }
  // Single ownership of the periodic figure: the runbook states it, the contract points at the
  // runbook, and the contract keeps no copy that could drift away from it.
  assert.match(runbook, /every 5th batch/u);
  const pipelineRun = readRepoFile("instructions/pipeline-run.md");
  // A one-argument slice from a missing anchor yields the last character, and the negative
  // assertion below then cannot fail. The guard is what makes a moved anchor loud.
  const verificationAt = pipelineRun.indexOf("A batch is verified before it");
  assert.notEqual(verificationAt, -1, "the pipeline-run contract keeps the verification paragraph");
  const verificationParagraph = pipelineRun.slice(verificationAt);
  assert.equal(
    /(every (fifth|\d+(st|nd|rd|th)?) batch)/iu.test(verificationParagraph.slice(0, 1200)),
    false,
    "the pipeline-run contract must not carry its own copy of the periodic cadence",
  );
  // Every check the suite ships is named by the runbook that owns its cadence.
  for (const check of [
    "chain-of-custody",
    "quote-integrity",
    "completeness",
    "cross-transport",
    "negative-space",
    "baseline-diff",
    "blind-extraction",
    "periodic-attestation",
  ]) {
    assert.equal(runbook.includes(check), true, `runbook: ${check}`);
  }
});

// ---------------------------------------------------------------------------
// the main zone is bounded by the page, so the page must not be able to move it

/** Rewrite record 2's capture and keep the manifest honest about the new digest. */
function rewriteRecordTwo(payload, transform) {
  rewriteCaptureBody(payload.files, "002.capture.txt", transform);
  const capture = verifyCaptureFile(payload.files.get("002.capture.txt"));
  editJson(payload.files, "fetch-manifest.json", (manifest) => {
    manifest.records[1].persisted.sha256 = capture.header["normalized-sha256"];
    manifest.records[1].persisted.bytes = Number(capture.header["body-bytes"]);
  });
}

test("page chrome above the description does not silence the sweep below it", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      rewriteRecordTwo(
        payload,
        (body) =>
          `People also viewed\n\n${body.replace(
            "You will own the end-to-end automation framework",
            "You must be based in Germany for this role.\n\nYou will own the end-to-end automation framework",
          )}`,
      );
    },
  });
  const finding = checkOf(report, "negative-space").findings.find(
    (entry) => entry.code === "negative_space_unclaimed" && entry.family === "residence",
  );
  assert.ok(finding !== undefined, codes(report).join(","));
  assert.equal(checkOf(report, "negative-space").counts.outsideMainZone, 0);
});

test("a terminator phrase inside a sentence does not end the main zone", (t) => {
  // The phrase sits mid-line and after everything the record quoted, so only the line anchor can
  // refuse it. Without that anchor the requirement two lines below would be swept out of scope.
  const { report } = verify(t, {
    mutate: (payload) => {
      rewriteRecordTwo(
        payload,
        (body) =>
          `${body}We also list similar jobs on our careers page.\n\nYou must be based in Germany for this role.\n`,
      );
    },
  });
  const finding = checkOf(report, "negative-space").findings.find(
    (entry) => entry.code === "negative_space_unclaimed" && entry.family === "residence",
  );
  assert.ok(finding !== undefined, codes(report).join(","));
  assert.equal(checkOf(report, "negative-space").counts.outsideMainZone, 0);
});

test("a body that is nothing but chrome still has to answer for what is in it", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      rewriteRecordTwo(payload, () => "People also viewed\n\nYou must be based in Germany.\n");
    },
  });
  const finding = checkOf(report, "negative-space").findings.find(
    (entry) => entry.code === "negative_space_outside_main_zone",
  );
  assert.ok(finding !== undefined, codes(report).join(","));
  assert.equal(finding.family, "residence");
});

test("a line one capture quoted is answered for the record even where another does not", (t) => {
  // Two observations of one page. The record's quote spans two lines of the primary capture, so it
  // is not a substring of the degraded one - the same line is claimed there and unclaimed here, and
  // the record owes one answer, not one per capture.
  const twoLineQuote = [
    "- Candidates MUST BE currently based in Singapore; we do not sponsor relocation.",
    "- Experience with REST API testing.",
  ].join("\n");
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, INPUT_ONE, (input) => {
        input.offers[0].evidenceQuote = twoLineQuote;
      });
      rebuildTrace(payload.files, INPUT_ONE, TRACE_ONE);
      const primary = verifyCaptureFile(payload.files.get(CAPTURE_ONE));
      const body =
        "- Candidates MUST BE currently based in Singapore; we do not sponsor relocation.\n";
      payload.files.set(
        "001.degraded.capture.txt",
        renderCaptureFile({
          header: {
            ...primary.header,
            "normalized-sha256": sha256Utf8(body),
            "body-bytes": Buffer.byteLength(body, "utf8"),
          },
          body,
        }),
      );
    },
  });
  assert.equal(checkOf(report, "negative-space").status, "pass", codes(report).join(","));
  assert.equal(checkOf(report, "negative-space").counts.claimed, 4);
});

// ---------------------------------------------------------------------------
// the manifest cross-checks

test("every manifest cross-check reports the disagreement it is named for", (t) => {
  const cases = [
    [
      "manifest_capture_file_mismatch",
      (payload) => {
        editJson(payload.files, "fetch-manifest.json", (manifest) => {
          manifest.records[0].persisted.file = "099.capture.txt";
        });
      },
    ],
    [
      "manifest_response_digest_mismatch",
      (payload) => {
        editJson(payload.files, "fetch-manifest.json", (manifest) => {
          manifest.records[0].response.sha256 = "1".repeat(64);
        });
      },
    ],
    [
      "manifest_record_missing",
      (payload) => {
        editJson(payload.files, "fetch-manifest.json", (manifest) => {
          manifest.records = manifest.records.filter((record) => record.index !== 1);
        });
      },
    ],
    [
      "manifest_capture_missing",
      (payload) => {
        payload.files.delete(CAPTURE_ONE);
      },
    ],
    [
      "manifest_unreadable",
      (payload) => {
        editJson(payload.files, "fetch-manifest.json", (manifest) => {
          manifest.tool = "something";
        });
      },
    ],
    [
      "manifest_unreadable",
      (payload) => {
        editJson(payload.files, "fetch-manifest.json", (manifest) => {
          manifest.schemaVersion = 3;
        });
      },
    ],
    [
      "plan_range_mismatch",
      (payload) => {
        editJson(payload.files, "plan.json", (plan) => {
          plan.items[5].link = "https://boards.example.test/other/role";
        });
      },
    ],
  ];
  for (const [expected, mutate] of cases) {
    const { report } = verify(t, { mutate });
    assert.ok(codes(report).includes(expected), `${expected} not in ${codes(report).join(",")}`);
  }
});

// The replay batch writes the version the promoted tool writes. A batch captured before the
// promotion carries the older one, and this reader takes `records` and `startedAt` — neither of
// which the version changed — so refusing it would strand evidence for no reason. Both versions
// are frozen as one literal here; the third case above proves an unknown version is still refused.
const ACCEPTED_MANIFEST_VERSIONS = Object.freeze([1, 2]);

test("a manifest from before the promotion is still read", (t) => {
  for (const schemaVersion of ACCEPTED_MANIFEST_VERSIONS) {
    const { report } = verify(t, {
      mutate: (payload) => {
        editJson(payload.files, "fetch-manifest.json", (manifest) => {
          manifest.schemaVersion = schemaVersion;
        });
      },
    });
    assert.ok(
      !codes(report).includes("manifest_unreadable"),
      `schemaVersion ${schemaVersion}: ${codes(report).join(",")}`,
    );
  }
  // The replay batch writes a literal, so a bump in the fetch layer would leave this reader
  // refusing every real batch while the suite stayed green. The set the loop just exercised is the
  // set compared here, so widening it to silence this line also exercises the reader at that
  // version — one literal, not two that can drift three lines apart.
  assert.ok(
    ACCEPTED_MANIFEST_VERSIONS.includes(manifestSchemaVersion),
    `the fetch layer writes schemaVersion ${manifestSchemaVersion}, which this reader refuses`,
  );
});

test("two captures of one record that disagree about the vacancy are caught", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      const primary = verifyCaptureFile(payload.files.get(CAPTURE_ONE));
      const body = "A second observation of a different posting.\n";
      payload.files.set(
        "001.second.capture.txt",
        renderCaptureFile({
          header: {
            ...primary.header,
            "requested-url": "https://www.linkedin.com/jobs/view/4566666666/",
            "normalized-sha256": sha256Utf8(body),
            "body-bytes": Buffer.byteLength(body, "utf8"),
          },
          body,
        }),
      );
    },
  });
  assert.ok(codes(report).includes("capture_url_disagreement"), codes(report).join(","));
});

test("a manifest record the fetcher never resolved carries no verdict to contradict", (t) => {
  // The measured shape: the fetch fails, the browser falls back, and the browser finds the posting
  // closed. The manifest says `access_failure`, which is a statement about the fetch and not about
  // the vacancy, so it must not be read as contradicting the closure.
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[2].outcome = "access_failure";
        manifest.records[2].usable = false;
        manifest.records[2].fallback = "browser";
        manifest.records[2].persisted = null;
      });
      const primary = verifyCaptureFile(payload.files.get("003.capture.txt"));
      payload.files.set(
        "003.browser.capture.txt",
        renderCaptureFile({
          header: { ...primary.header, adapter: "in-app-browser@1" },
          body: primary.body,
        }),
      );
      payload.files.delete("003.capture.txt");
    },
  });
  assert.ok(!codes(report).includes("closure_not_corroborated"), codes(report).join(","));
  const diff = checkOf(report, "cross-transport").diffs.find(
    (entry) => entry.code === "manifest_did_not_resolve",
  );
  assert.ok(diff !== undefined, JSON.stringify(checkOf(report, "cross-transport").diffs));
  // Record 5 is unresolved in the fixture already - its fetch failed and the browser served it -
  // so the closed posting joins it rather than replacing it.
  assert.deepEqual(diff.indices, [3, 5]);
});

test("provenance moves a capture out of http_fetch on every discriminator", (t) => {
  const cases = [
    (payload) => {
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[0].persisted.sha256 = "2".repeat(64);
      });
    },
    (payload) => {
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[0].persisted.file = "099.capture.txt";
      });
    },
    (payload) => {
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records = manifest.records.filter((record) => record.index !== 1);
      });
    },
    (payload) => {
      payload.files.delete("fetch-manifest.json");
    },
  ];
  for (const mutate of cases) {
    const { report } = verify(t, { mutate });
    assert.ok(report.counts.capturesByProvenance.http_fetch < 3, JSON.stringify(report.counts));
  }
});

// ---------------------------------------------------------------------------
// the plan's own claims

test("a link the plan dropped on a ledger claim needs the ledger row it rests on", (t) => {
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      editJson(payload.files, "plan.json", (plan) => {
        // Position 6 has a record, so moving the skip to a link the ledger never saw is the exact
        // shape of a vacancy dropped on an invented reason.
        plan.items[2].link = "https://www.linkedin.com/jobs/view/4544444444/";
        plan.items[2].key = "linkedin:4544444444";
        plan.items[2].url = plan.items[2].link;
      });
    },
  });
  // The other of the two paths that raise this code: the ledger has no row at all for the link the
  // plan says it dropped on a ledger reason.
  const finding = checkOf(report, "baseline-diff").findings.find(
    (entry) => entry.code === "plan_skip_uncorroborated",
  );
  assert.deepEqual(finding, {
    code: "plan_skip_uncorroborated",
    planPosition: 3,
    action: "skip_closed",
  });
});

test("a batch whose plan dropped links cannot be checked without that ledger", (t) => {
  const prepared = prepare(t);
  const report = runSuite(
    buildContext({
      artifactsDir: prepared.artifactsDir,
      from: prepared.from,
      ledgerPath: null,
      linksFile: prepared.linksFile,
      to: prepared.to,
    }),
    "per-batch",
  );
  const finding = checkOf(report, "completeness").findings.find(
    (entry) => entry.code === "plan_skips_unverifiable",
  );
  assert.deepEqual(finding, { code: "plan_skips_unverifiable", planPositions: [3] });
  assert.equal(report.status, "fail");
});

test("the plan-versus-ledger comparison covers status, decision, flags and policy", (t) => {
  const cases = [
    (plan) => {
      plan.items[0].status = "expired";
    },
    (plan) => {
      plan.items[0].decision = "EVALUATED";
    },
    (plan) => {
      plan.items[0].flags = ["invented_flag"];
    },
    // The policy the plan claims its baseline was taken under is a statement about the same ledger
    // row as the three above, so it is corroborated on the same terms. Without this the field
    // would be the one thing in `plan.json` that verifies against nothing.
    (plan) => {
      plan.items[0].policy_id = "triage-policy-v9-2030-01-01";
    },
  ];
  for (const edit of cases) {
    const { report } = verify(t, {
      cadence: "full",
      mutate: (payload) => {
        editJson(payload.files, "plan.json", edit);
      },
    });
    const finding = checkOf(report, "baseline-diff").findings.find(
      (entry) => entry.code === "plan_disagrees_with_ledger",
    );
    assert.deepEqual(finding, { code: "plan_disagrees_with_ledger", planPosition: 1 });
  }
});

test("the baseline diff reports the payload, not only the code", (t) => {
  const { report } = verify(t, { cadence: "full" });
  const diffs = checkOf(report, "baseline-diff").diffs;
  const decision = diffs.find((entry) => entry.code === "decision_changed");
  assert.deepEqual(
    {
      code: decision.code,
      index: decision.index,
      planPosition: decision.planPosition,
      from: decision.from,
      to: decision.to,
    },
    { code: "decision_changed", index: 1, planPosition: 1, from: "MANUAL_REVIEW", to: "SKIP" },
  );
  const flags = diffs.find((entry) => entry.code === "flags_changed" && entry.index === 1);
  assert.deepEqual(flags.added, []);
  assert.deepEqual(flags.removed, ["relocation_floor_missing"]);
  assert.equal(flags.planPosition, 1);
  // The other known link moved the other way, so both halves of the comparison are exercised.
  const gained = diffs.find((entry) => entry.code === "flags_changed" && entry.index === 2);
  assert.deepEqual(gained.added, ["gap:compensation_fx_unavailable"]);
  assert.deepEqual(gained.removed, ["work_format_unknown"]);
  // No finding, no diff and no count carries a vacancy URL - including the source whose ledger key
  // *is* the normalized URL, which is what makes this worth asserting over the report file and not
  // only over the stdout summary.
  const written = JSON.stringify(report);
  assert.ok(!written.includes("linkedin.com"), "the report must carry no URL");
  assert.ok(!written.includes("boards.example.test"), "the report must carry no URL");
});

test("a moved decision names the policy on both ends, so a policy move is not a plain difference", (t) => {
  const { report } = verify(t, { cadence: "full" });
  const diffs = checkOf(report, "baseline-diff").diffs;
  // The fixture's prior batch ran under the superseded policy and this one runs under the live
  // one. Before the stamp, epic 007's residual was exactly this: the reader could not tell a
  // decision that moved because the policy moved from one that moved because the page did.
  for (const code of ["decision_changed", "flags_changed"]) {
    const moved = diffs.find((entry) => entry.code === code);
    assert.ok(moved !== undefined, code);
    assert.equal(moved.fromPolicyId, "triage-r1-05a-2026-08-04", code);
    assert.equal(moved.toPolicyId, "triage-policy-v8-2026-10-01", code);
  }
});

test("an applied default is a trace annotation and never a ledger flag", (t) => {
  // Record 5 (Initech) is the one replay trace with an applied default: a Remote WEST posting that
  // states no hiring model. Its baseline is written the way a batch under the retired convention
  // wrote it — the assumption token inside `flags` — both as a prior ledger row and as the plan's
  // snapshot of that row, so the corroboration half of `baseline-diff` runs over the row and the
  // diff half has both ends. The review runbook's docs/runbooks/triage-review.md#1-ledger is the owner of what a flag is; this
  // check is what keeps the projection honest, and it is the only place a trace becomes flags.
  const defaultToken = "assumption:engagement_path.outside_home_contractor";
  const baselineFlags = [defaultToken, "gap:compensation_absent"];
  const prepared = prepare(t, {
    ledger: true,
    mutate: (payload) => {
      editJson(payload.files, "plan.json", (plan) => {
        const item = plan.items[5];
        assert.equal(item.link, links[5]);
        Object.assign(item, {
          status: "open",
          decision: "EVALUATED",
          flags: baselineFlags,
          policy_id: "triage-policy-v2-2026-08-21",
          last_checked: priorObservedAt,
          action: "skip_known",
          reason: "already triaged",
        });
      });
    },
  });
  recordBatch(
    prepared.ledgerPath,
    {
      batch_id: "2026-08-16-prior-2",
      observed_at: priorObservedAt,
      policy_id: "triage-policy-v2-2026-08-21",
      entries: [{ url: links[5], status: "open", decision: "EVALUATED", flags: baselineFlags }],
    },
    { artifactsDir: null },
  );
  // Not vacuous: the persisted trace really carries the default and the gap.
  const trace = JSON.parse(
    readFileSync(join(prepared.artifactsDir, "traces", "005.trace.json"), "utf8"),
  );
  assert.deepEqual(trace.assumptions, [defaultToken]);
  assert.deepEqual(trace.data_gaps, ["gap:compensation_absent"]);

  const report = runSuite(
    buildContext({
      artifactsDir: prepared.artifactsDir,
      from: prepared.from,
      ledgerPath: prepared.ledgerPath,
      linksFile: prepared.linksFile,
      to: prepared.to,
    }),
    "full",
  );
  const check = checkOf(report, "baseline-diff");
  // The row still carrying the default is a legacy row, not a finding: the plan and the ledger
  // agree with each other, the batch stays recordable, and the only signal is the diff.
  assert.equal(report.status, "pass");
  assert.deepEqual(check.findings, []);
  assert.equal(check.counts.known, 3);
  assert.equal(check.counts.ledgerChecked, 4);
  const moved = check.diffs.find((entry) => entry.code === "flags_changed" && entry.index === 5);
  assert.deepEqual(
    { added: moved?.added, removed: moved?.removed, planPosition: moved?.planPosition },
    { added: [], removed: [defaultToken], planPosition: 6 },
  );
});

test("a plan written before the policy field says nothing rather than guessing one", (t) => {
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      editJson(payload.files, "plan.json", (plan) => {
        for (const item of plan.items) delete item.policy_id;
      });
    },
  });
  const diffs = checkOf(report, "baseline-diff").diffs;
  const moved = diffs.find((entry) => entry.code === "decision_changed");
  // The plan declares its own decision, so that decision is the baseline and the policy is read
  // off the same object — which here has none. Reaching into the ledger for a policy while taking
  // the decision from the plan would pair a decision with a policy that did not produce it.
  assert.equal(Object.hasOwn(moved, "fromPolicyId"), false);
  assert.equal(moved.toPolicyId, "triage-policy-v8-2026-10-01");
  assert.equal(
    checkOf(report, "baseline-diff").findings.some(
      (entry) => entry.code === "plan_disagrees_with_ledger",
    ),
    false,
    "an older plan is silent, not wrong",
  );
});

test("a recorded batch's own history is a member of the directory, not a stray file", (t) => {
  const prepared = prepare(t, { ledger: true });
  // The closing order of a real batch: verify, then record. Recording writes the batch's history
  // into the same directory the suite just read, so the next run over that directory has to know
  // the file rather than report it.
  const scored = links.filter((_, position) => position + 1 !== skippedLinkPosition);
  const outcome = recordBatch(
    prepared.ledgerPath,
    {
      batch_id: batchId,
      observed_at: "2026-08-23T11:00:00Z",
      policy_id: "triage-policy-v2-2026-08-21",
      // Row values are the shape of a batch-end write; what this case asserts is the directory
      // contract, and no check here reads a decision out of the record.
      entries: scored.map((url) => ({ url, status: "open", decision: "EVALUATED", flags: [] })),
    },
    { artifactsDir: prepared.artifactsDir },
  );
  assert.equal(outcome.record.path, join(prepared.artifactsDir, "ledger-record.json"));

  const context = buildContext({
    artifactsDir: prepared.artifactsDir,
    from: prepared.from,
    ledgerPath: prepared.ledgerPath,
    linksFile: prepared.linksFile,
    to: prepared.to,
  });
  const report = runSuite(context, "per-batch");
  assert.equal(
    report.findingCodes.includes("unexpected_artifact"),
    false,
    report.findingCodes.join(","),
  );
  assert.equal(report.status, "pass");
  // And the loader names the file from the module that writes it, so the two cannot drift.
  assert.equal(ledgerRecordFileName, "ledger-record.json");
});

test("a fresh process replays a persisted batch from its own files, fetching nothing", (t) => {
  const prepared = prepare(t, { ledger: false });
  const replayPath = join(prepared.root, "replay.mjs");
  // A separate process, given only the batch directory: it holds none of this session's state, so
  // what it recomputes comes from the persisted files or from nowhere. That is the acceptance
  // criterion - a fresh session replays a persisted batch without re-fetching any page and
  // without starting Step 1 - expressed as something a machine can fail.
  writeFileSync(
    replayPath,
    [
      'import { readFileSync, readdirSync } from "node:fs";',
      'import { join } from "node:path";',
      `import { buildDecisionTrace } from ${JSON.stringify(join(repoRoot, "tools/job-scorer/trace.mjs"))};`,
      "const [dir] = process.argv.slice(2);",
      'const read = (...parts) => JSON.parse(readFileSync(join(dir, ...parts), "utf8"));',
      "let recomputed = 0;",
      'for (const name of readdirSync(join(dir, "inputs")).sort()) {',
      "  const index = name.slice(0, 3);",
      '  const input = read("inputs", name);',
      '  const persisted = read("traces", `${index}.trace.json`);',
      "  const rebuilt = JSON.parse(JSON.stringify(buildDecisionTrace(input)));",
      "  if (JSON.stringify(rebuilt) !== JSON.stringify(persisted)) {",
      "    throw new Error(`trace ${index} does not match its own input`);",
      "  }",
      "  recomputed += 1;",
      "}",
      "console.log(JSON.stringify({ recomputed }));",
      "",
    ].join("\n"),
  );

  // Every root a pipeline write could resolve to is pointed at the disposable directory, because
  // that is the only lever that decides them: `process-log.json` and `output/` resolve from
  // `JOB_PIPELINE_*` or from a module-relative repository root, never from the process cwd. With
  // them injected, a replay that started Step 1 would leave its evidence where the two assertions
  // below look.
  const replayed = spawnSync(process.execPath, [replayPath, prepared.artifactsDir], {
    encoding: "utf8",
    env: {
      ...process.env,
      JOB_PIPELINE_WORKSPACE_ROOT: prepared.root,
      JOB_PIPELINE_OUTPUT_ROOT: join(prepared.root, "output"),
      JOB_PIPELINE_PROCESS_LOG: join(prepared.root, "process-log.json"),
    },
  });
  assert.equal(replayed.status, 0, replayed.stderr);
  assert.equal(JSON.parse(replayed.stdout).recomputed, 5, "every persisted trace was recomputed");
  // Nothing about a replay is a pipeline run: no per-role process was started and no output
  // directory was reserved. What carries most of this guarantee is narrower than the assertions
  // and is worth naming: the replay's whole import graph is the pure scorer, so there is no writer
  // to reach. The injected roots are what would make these two fail if one were ever added.
  assert.equal(existsSync(join(prepared.root, "process-log.json")), false);
  assert.equal(existsSync(join(prepared.root, "output")), false);
});

// ---------------------------------------------------------------------------
// the periodic set

test("a blind extraction that is a copy of the primary is refused", (t) => {
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      payload.files.set(join("blind", "002.input.json"), payload.files.get(INPUT_TWO));
    },
  });
  assert.ok(codes(report).includes("blind_extraction_not_independent"), codes(report).join(","));
});

test("a probe dated after the batch closed is outside its window too", (t) => {
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      editJson(payload.files, "attestation.json", (file) => {
        file.probes[0].ranAt = "2026-09-30T00:00:00.000Z";
      });
    },
  });
  assert.ok(codes(report).includes("probe_out_of_window"), codes(report).join(","));
  assert.ok(!codes(report).includes("probe_stale"), codes(report).join(","));
});

test("a vacancy the fetcher reached and the batch then dropped is caught at the cheap cadence", (t) => {
  // The exact shape a reviewer reproduced: delete the record, leave the manifest row that fetched
  // it, and let the plan claim the link was skipped. The plan is the session's own word; the
  // manifest is not.
  const { report } = verify(t, {
    mutate: (payload) => {
      payload.files.delete(join("inputs", "003.input.json"));
      payload.files.delete(join("traces", "003.trace.json"));
      payload.files.delete("003.capture.txt");
      editJson(payload.files, "plan.json", (plan) => {
        plan.items[3].action = "skip_known";
        plan.items[3].status = "open";
        plan.items[3].decision = "EVALUATED";
        plan.items[3].flags = [];
        plan.items[3].last_checked = "2026-08-22T10:00:00.000Z";
      });
    },
  });
  const finding = checkOf(report, "cross-transport").findings.find(
    (entry) => entry.code === "manifest_record_unaccounted",
  );
  assert.ok(finding !== undefined, codes(report).join(","));
  assert.equal(finding.index, 3);
});

test("a link the fetcher never attempted is left to the coverage check", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      payload.files.delete(join("inputs", "003.input.json"));
      payload.files.delete(join("traces", "003.trace.json"));
      payload.files.delete("003.capture.txt");
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[2].skipped = true;
        manifest.records[2].usable = false;
        manifest.records[2].persisted = null;
        manifest.records[2].outcome = "access_failure";
      });
    },
  });
  assert.ok(!codes(report).includes("manifest_record_unaccounted"), codes(report).join(","));
  assert.ok(codes(report).includes("link_uncovered"), codes(report).join(","));
});

test("a browser-only batch passes on its own", (t) => {
  // One vacancy, browser transcript, no fetch manifest and no plan: nothing in that batch is
  // corroborated by a second party, and none of it is a finding either. What the report says about
  // it is the provenance count.
  const { report } = verify(t, {
    mutate: (payload) => {
      for (const name of [...payload.files.keys()]) {
        if (
          name === "fetch-manifest.json" ||
          name === "plan.json" ||
          name.startsWith("blind/") ||
          /^00[2-5]\./u.test(name) ||
          /^(inputs|traces)\/00[2-5]\./u.test(name)
        ) {
          payload.files.delete(name);
        }
      }
      editJson(payload.files, "disposition.json", (file) => {
        file.dispositions = file.dispositions.filter((entry) => entry.recordIndex === 1);
      });
      payload.links = `${links[0]}\n`;
    },
    to: 1,
  });
  assert.equal(report.status, "pass", codes(report).join(","));
  assert.deepEqual(report.counts.capturesByProvenance, {
    http_fetch: 0,
    transcript: 1,
    unverified: 0,
  });
});

test("a links file that repeats its last line and ends without a newline is read the same", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      payload.links = `${payload.links.trimEnd()}\n${links[0]}`;
    },
  });
  assert.equal(report.status, "pass", codes(report).join(","));
  assert.equal(report.counts.linksInRange, 6);
});

test("a report row for the source whose ledger key is its URL carries no URL", (t) => {
  // The fixture's non-LinkedIn link keys as `url:<the whole normalized URL>`, so a row naming it by
  // key would put a vacancy URL in the report file. Dropping its plan item is the cheapest way to
  // make that row exist, which is what makes the two `includes` assertions below able to fail.
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      editJson(payload.files, "plan.json", (plan) => {
        plan.items = plan.items.filter((item) => item.input_index !== 6);
      });
    },
  });
  const row = checkOf(report, "baseline-diff").findings.find(
    (entry) => entry.code === "record_absent_from_plan",
  );
  assert.deepEqual(row, { code: "record_absent_from_plan", index: 5 });
  const written = JSON.stringify(report);
  assert.ok(!written.includes("boards.example.test"), "the report must carry no URL");
  assert.ok(!written.includes("url:https"), "the report must carry no ledger key");
});

test("the plan-obedience findings carry a position, not a ledger key", (t) => {
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      editJson(payload.files, INPUT_ONE, (input) => {
        input.source.sourceRef = links[2];
        input.source.finalUrl = links[2];
      });
      rebuildTrace(payload.files, INPUT_ONE, TRACE_ONE);
      rewriteCaptureBodyHeader(payload.files, CAPTURE_ONE, (header) => ({
        ...header,
        "requested-url": links[2],
        "final-url": links[2],
      }));
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[0].requestedUrl = links[2];
      });
    },
  });
  const row = checkOf(report, "baseline-diff").findings.find(
    (entry) => entry.code === "refetched_closed_vacancy",
  );
  assert.deepEqual(row, {
    code: "refetched_closed_vacancy",
    index: 1,
    planPosition: 3,
    status: "closed",
  });
});

test("each half of the manifest-resolved test kills on its own", (t) => {
  // Two shapes, two guards, both on a record the browser actually rescued. The first is what a
  // degraded adapter writes when it read a closure banner but could not meet its own content floor;
  // the second only a hand-written manifest can produce, and the guard is kept for exactly that.
  // The rescue's own stamp is silent, which is what a browser transport that reads no first-party
  // status word writes - and what leaves the exemption to the two discriminators under test.
  const rescue = (payload) => {
    const primary = verifyCaptureFile(payload.files.get("003.capture.txt"));
    payload.files.set(
      "003.browser.capture.txt",
      renderCaptureFile({
        header: { ...primary.header, adapter: "in-app-browser@1", outcome: "-" },
        body: primary.body,
      }),
    );
  };
  const closedButUnresolved = verify(t, {
    mutate: (payload) => {
      rescue(payload);
      const name = join("inputs", "003.input.json");
      editJson(payload.files, name, (input) => {
        input.source.accessOutcome = "technical_unavailable";
        input.source.accessReason = "no response after retry";
      });
      rebuildTrace(payload.files, name, join("traces", "003.trace.json"));
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[2].usable = false;
        manifest.records[2].fallback = "browser";
      });
    },
  });
  assert.ok(
    !codes(closedButUnresolved.report).includes("unavailability_not_corroborated"),
    codes(closedButUnresolved.report).join(","),
  );

  const usableAccessFailure = verify(t, {
    mutate: (payload) => {
      rescue(payload);
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[2].outcome = "access_failure";
        manifest.records[2].usable = true;
        manifest.records[2].fallback = null;
      });
    },
  });
  assert.ok(
    !codes(usableAccessFailure.report).includes("closure_not_corroborated"),
    codes(usableAccessFailure.report).join(","),
  );
});

test("a declared closure nothing looked at is not excused by a failed fetch", (t) => {
  // The exemption belongs to the rescue, not to the failure. Record 4 has no capture at all, so
  // nothing in the directory ever saw the posting it declares closed.
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[3].outcome = "access_failure";
        manifest.records[3].usable = false;
        manifest.records[3].fallback = "browser";
      });
    },
  });
  assert.ok(codes(report).includes("closure_not_corroborated"), codes(report).join(","));
});

test("a requirement below a rail is reported, wherever the rail sits", (t) => {
  // Both shapes a reviewer used against the previous zone rule. Neither can pass now: the zone
  // chooses the finding's code and nothing else.
  const belowTheDeepestQuote = verify(t, {
    mutate: (payload) => {
      rewriteRecordTwo(
        payload,
        (body) =>
          `${body}\nMore jobs from Northwind Analytics\n\n` +
          "Senior Backend Engineer - Northwind Analytics\n\n" +
          "Note: successful candidates must reside in the European Union for payroll reasons.\n",
      );
    },
  });
  const tail = checkOf(belowTheDeepestQuote.report, "negative-space").findings.find(
    (entry) => entry.family === "residence",
  );
  assert.ok(tail !== undefined, codes(belowTheDeepestQuote.report).join(","));
  assert.equal(tail.code, "negative_space_outside_main_zone");

  const inABodyWithNoQuote = verify(t, {
    mutate: (payload) => {
      const primary = verifyCaptureFile(payload.files.get("002.capture.txt"));
      const body =
        "Job details\n\nPeople also viewed\n\nSenior QA Engineer - Contoso\n\n" +
        "You must be based in Germany for this role.\n";
      payload.files.set(
        "002.browser.capture.txt",
        renderCaptureFile({
          header: {
            ...primary.header,
            adapter: "in-app-browser@1",
            "normalized-sha256": sha256Utf8(body),
            "body-bytes": Buffer.byteLength(body, "utf8"),
          },
          body,
        }),
      );
    },
  });
  assert.ok(
    checkOf(inABodyWithNoQuote.report, "negative-space").findings.some(
      (entry) => entry.family === "residence",
    ),
    codes(inABodyWithNoQuote.report).join(","),
  );
});

test("a dropped link is corroborated by what the ledger row says, not by its existence", (t) => {
  // The row is open, but its last fetch failed: that is the row the ledger retries, so `skip_known`
  // is not something the ledger said about it.
  const prepared = prepare(t, {
    ledger: true,
    mutate: (payload) => {
      payload.files.delete("002.capture.txt");
      payload.files.delete(INPUT_TWO);
      payload.files.delete(join("traces", "002.trace.json"));
      payload.files.delete(join("blind", "002.input.json"));
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records = manifest.records.filter((record) => record.index !== 2);
      });
    },
  });
  recordBatch(
    prepared.ledgerPath,
    {
      batch_id: "2026-08-16-prior-2",
      observed_at: priorObservedAt,
      entries: [
        { url: links[1], status: "open", decision: "BLOCKED", flags: ["vacancy_unavailable"] },
      ],
    },
    { artifactsDir: null },
  );
  const blockedRow = runSuite(
    buildContext({
      artifactsDir: prepared.artifactsDir,
      from: prepared.from,
      ledgerPath: prepared.ledgerPath,
      linksFile: prepared.linksFile,
      to: prepared.to,
    }),
    "full",
  );
  const finding = checkOf(blockedRow, "baseline-diff").findings.find(
    (entry) => entry.code === "plan_skip_uncorroborated",
  );
  assert.deepEqual(finding, {
    code: "plan_skip_uncorroborated",
    planPosition: 2,
    action: "skip_known",
  });
  // The cheap cadence leaves the link uncovered for the same reason.
  assert.ok(blockedRow.findingCodes.includes("link_uncovered"), blockedRow.findingCodes.join(","));

  // And a link called closed whose row is open.
  const openRow = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      editJson(payload.files, "plan.json", (plan) => {
        plan.items[0].action = "skip_closed";
      });
    },
  });
  const closed = checkOf(openRow.report, "baseline-diff").findings.find(
    (entry) => entry.code === "plan_skip_uncorroborated",
  );
  assert.ok(closed !== undefined, codes(openRow.report).join(","));
  assert.equal(closed.action, "skip_closed");
});

test("a blind extraction that only renamed a field around the same quotes is refused", (t) => {
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      const copy = JSON.parse(payload.files.get(INPUT_TWO));
      copy.offers[0].timezoneDistance = "far";
      payload.files.set(join("blind", "002.input.json"), `${JSON.stringify(copy, null, 2)}\n`);
    },
  });
  assert.ok(codes(report).includes("blind_extraction_not_independent"), codes(report).join(","));
});

test("a rescue that says the posting is live does not excuse a declared closure", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      const primary = verifyCaptureFile(payload.files.get("003.capture.txt"));
      payload.files.set(
        "003.browser.capture.txt",
        renderCaptureFile({
          header: { ...primary.header, adapter: "in-app-browser@1", outcome: "active" },
          body: primary.body,
        }),
      );
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[2].outcome = "access_failure";
        manifest.records[2].usable = false;
        manifest.records[2].fallback = "browser";
        manifest.records[2].persisted = null;
      });
      payload.files.delete("003.capture.txt");
    },
  });
  const finding = checkOf(report, "cross-transport").findings.find(
    (entry) => entry.code === "rescue_contradicts_declaration",
  );
  assert.deepEqual(finding, {
    code: "rescue_contradicts_declaration",
    index: 3,
    declared: "closed",
  });
  // And the record still counts as one the fetch transport reached no verdict about.
  assert.equal(checkOf(report, "cross-transport").counts.manifestUnresolved, 2);
});

test("a delisted posting corroborates a closure and cannot be scored as live", (t) => {
  const corroborates = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[2].outcome = "private";
      });
    },
  });
  assert.equal(corroborates.report.status, "pass", codes(corroborates.report).join(","));

  const scoredAsLive = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[1].outcome = "private";
      });
    },
  });
  assert.ok(
    codes(scoredAsLive.report).includes("closed_source_scored"),
    codes(scoredAsLive.report).join(","),
  );
});

test("a plan row cannot choose which ledger row corroborates it", (t) => {
  // The reviewer's attack: drop the last vacancy from the batch, keep its plan row so coverage
  // accounts for it, and point that row's declared key at an unrelated vacancy the ledger has as
  // closed. The key is derived from the link now, so the decoy is what gets reported.
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      payload.files.delete("005.browser.capture.txt");
      payload.files.delete(join("inputs", "005.input.json"));
      payload.files.delete(join("traces", "005.trace.json"));
      payload.files.delete(join("blind", "002.input.json"));
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records = manifest.records.filter((record) => record.index !== 5);
      });
      editJson(payload.files, "plan.json", (plan) => {
        plan.items[5].action = "skip_closed";
        plan.items[5].status = "closed";
        plan.items[5].decision = "SKIP";
        plan.items[5].flags = [];
        plan.items[5].key = "linkedin:4500000003";
      });
    },
  });
  assert.equal(report.status, "fail");
  assert.ok(codes(report).includes("plan_item_key_mismatch"), codes(report).join(","));
  assert.ok(codes(report).includes("plan_skip_uncorroborated"), codes(report).join(","));
});

test("two plan rows about one vacancy do not collapse into one corroboration", (t) => {
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      editJson(payload.files, "plan.json", (plan) => {
        plan.items[5].link = plan.items[2].link;
        plan.items[5].key = plan.items[2].key;
        plan.items[5].url = plan.items[2].url;
      });
    },
  });
  assert.ok(codes(report).includes("plan_item_duplicate"), codes(report).join(","));
});

// ---------------------------------------------------------------------------
// the plan's duplicate flag is derived, not obeyed

const LINKEDIN_SLUG_SPELLING =
  "https://www.linkedin.com/jobs/view/senior-qa-automation-engineer-at-acme-robotics-4500000001/";

test("a second spelling of a link the plan already saw needs no record of its own", (t) => {
  // The honest case the flag exists for: two LinkedIn spellings collapse to one identity, so the
  // batch really does produce one record for two range links. Run at the full cadence because both
  // checks that read the flag have to accept it.
  const { report } = verify(t, {
    cadence: "full",
    to: 7,
    mutate: (payload) => {
      payload.links = `${payload.links.trimEnd()}\n${LINKEDIN_SLUG_SPELLING}\n`;
      editJson(payload.files, "plan.json", (plan) => {
        plan.items.push({
          input_index: 7,
          link: LINKEDIN_SLUG_SPELLING,
          key: "linkedin:4500000001",
          source: "linkedin",
          url: LINKEDIN_SLUG_SPELLING,
          duplicate_in_batch: true,
          action: "fetch_new",
          reason: "duplicate of an earlier link",
        });
      });
    },
  });
  assert.equal(report.status, "pass", codes(report).join(","));
  assert.equal(checkOf(report, "completeness").counts.linksInRange, 7);
});

test("a second spelling the plan did not mark is not what planBatch writes", (t) => {
  const { report } = verify(t, {
    cadence: "full",
    to: 7,
    mutate: (payload) => {
      payload.links = `${payload.links.trimEnd()}\n${LINKEDIN_SLUG_SPELLING}\n`;
      editJson(payload.files, "plan.json", (plan) => {
        plan.items.push({
          input_index: 7,
          link: LINKEDIN_SLUG_SPELLING,
          key: "linkedin:4500000001",
          source: "linkedin",
          url: LINKEDIN_SLUG_SPELLING,
          duplicate_in_batch: false,
          action: "fetch_new",
          reason: "not in the ledger",
        });
      });
    },
  });
  const finding = checkOf(report, "completeness").findings.find(
    (entry) => entry.code === "plan_item_duplicate_undeclared",
  );
  assert.deepEqual(finding, { code: "plan_item_duplicate_undeclared", planPosition: 7 });
});

test("a vacancy cannot be dropped by calling it a duplicate of nothing", (t) => {
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      payload.files.delete("005.browser.capture.txt");
      payload.files.delete(join("inputs", "005.input.json"));
      payload.files.delete(join("traces", "005.trace.json"));
      payload.files.delete(join("blind", "002.input.json"));
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records = manifest.records.filter((record) => record.index !== 5);
      });
      editJson(payload.files, "plan.json", (plan) => {
        plan.items[5].duplicate_in_batch = true;
      });
    },
  });
  assert.equal(report.status, "fail");
  // One reading of the plan, so one report of what that reading found.
  const finding = checkOf(report, "completeness").findings.find(
    (entry) => entry.code === "plan_item_duplicate_unclaimed",
  );
  assert.deepEqual(finding, { code: "plan_item_duplicate_unclaimed", planPosition: 6 });
  assert.equal(
    checkOf(report, "baseline-diff").findings.some(
      (entry) => entry.code === "plan_item_duplicate_unclaimed",
    ),
    false,
    "the plan's problems are reported once",
  );
  assert.ok(codes(report).includes("link_uncovered"), codes(report).join(","));
});

test("an appended duplicate row cannot displace the row the ledger is asked about", (t) => {
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      editJson(payload.files, "plan.json", (plan) => {
        plan.items[0].action = "skip_closed";
        plan.items.push({
          ...plan.items[0],
          input_index: 7,
          action: "fetch_new",
          duplicate_in_batch: true,
        });
      });
    },
  });
  assert.ok(codes(report).includes("plan_skip_uncorroborated"), codes(report).join(","));
});

// ---------------------------------------------------------------------------
// the rescue's stamp cannot be hidden or averaged away

test("a rescue stamped live is read whatever its filename", (t) => {
  // Selected by derived provenance, not by the `NNN.<part>` naming: the manifest does not name this
  // file as its own persisted capture, so it is a rescue however it is called.
  const { report } = verify(t, {
    mutate: (payload) => {
      const primary = verifyCaptureFile(payload.files.get("003.capture.txt"));
      payload.files.set(
        "003.capture.txt",
        renderCaptureFile({
          header: { ...primary.header, adapter: "in-app-browser@1", outcome: "active" },
          body: primary.body,
        }),
      );
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[2].outcome = "access_failure";
        manifest.records[2].usable = false;
        manifest.records[2].fallback = "browser";
        manifest.records[2].persisted = null;
      });
    },
  });
  assert.ok(codes(report).includes("rescue_contradicts_declaration"), codes(report).join(","));
});

test("one contradicting rescue is a contradiction, however many agree with the record", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      const primary = verifyCaptureFile(payload.files.get("003.capture.txt"));
      for (const [part, outcome] of [
        ["browser", "active"],
        ["second", "closed"],
      ]) {
        payload.files.set(
          `003.${part}.capture.txt`,
          renderCaptureFile({
            header: { ...primary.header, adapter: "in-app-browser@1", outcome },
            body: primary.body,
          }),
        );
      }
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[2].outcome = "access_failure";
        manifest.records[2].usable = false;
        manifest.records[2].fallback = "browser";
        manifest.records[2].persisted = null;
      });
      payload.files.delete("003.capture.txt");
    },
  });
  assert.ok(codes(report).includes("rescue_contradicts_declaration"), codes(report).join(","));
});

test("a rescue that only says the fetch failed contradicts nothing", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      const name = join("inputs", "003.input.json");
      editJson(payload.files, name, (input) => {
        input.source.accessOutcome = "technical_unavailable";
        input.source.accessReason = "no response after retry";
      });
      rebuildTrace(payload.files, name, join("traces", "003.trace.json"));
      const primary = verifyCaptureFile(payload.files.get("003.capture.txt"));
      payload.files.set(
        "003.browser.capture.txt",
        renderCaptureFile({
          header: { ...primary.header, adapter: "in-app-browser@1", outcome: "access_failure" },
          body: primary.body,
        }),
      );
      payload.files.delete("003.capture.txt");
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[2].outcome = "access_failure";
        manifest.records[2].usable = false;
        manifest.records[2].fallback = "browser";
        manifest.records[2].persisted = null;
      });
    },
  });
  assert.ok(!codes(report).includes("rescue_contradicts_declaration"), codes(report).join(","));
});

test("a plan written before the re-check windows went still reads, and its window buys nothing", (t) => {
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      editJson(payload.files, "plan.json", (plan) => {
        plan.cadence_days = { fast_lane: 3650, standard: 3650 };
        for (const item of plan.items) item.recheck_due_on = "2036-01-01T00:00:00.000Z";
      });
    },
  });
  assert.equal(report.status, "pass", codes(report).join(","));
});

test("an action name this build does not plan is not a skip", (t) => {
  // `skip_recent` is what a plan written before the rename calls a known link. It accounts for
  // nothing here: the batch is re-planned, which is cheap, rather than read through an alias.
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, "plan.json", (plan) => {
        plan.items[2].action = "skip_recent";
      });
    },
  });
  assert.ok(codes(report).includes("link_uncovered"), codes(report).join(","));
});

test("a vacancy cannot be dropped by calling it skipped either", (t) => {
  // The sibling of the duplicate flag: `action` is a claim about the ledger, so the ledger decides
  // whether it accounts for anything. With no row behind it the link is simply uncovered.
  const { report } = verify(t, {
    mutate: (payload) => {
      payload.files.delete("005.browser.capture.txt");
      payload.files.delete(join("inputs", "005.input.json"));
      payload.files.delete(join("traces", "005.trace.json"));
      payload.files.delete(join("blind", "002.input.json"));
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records = manifest.records.filter((record) => record.index !== 5);
      });
      editJson(payload.files, "plan.json", (plan) => {
        plan.items[5].action = "skip_known";
        plan.items[5].status = "open";
        plan.items[5].last_checked = "2026-08-22T10:00:00.000Z";
      });
    },
  });
  assert.equal(report.status, "fail");
  const uncovered = checkOf(report, "completeness").findings.find(
    (entry) => entry.code === "link_uncovered",
  );
  assert.ok(uncovered !== undefined, codes(report).join(","));
  assert.equal(uncovered.position, 6);
});

test("a plan row repeating the identical link accounts for nothing", (t) => {
  // The links file deduplicates, so a repeated link only ever exists in the plan - where copying a
  // line must not become a way to satisfy coverage.
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, "plan.json", (plan) => {
        plan.items.push({ ...plan.items[5], input_index: 7, duplicate_in_batch: true });
      });
    },
  });
  const finding = checkOf(report, "completeness").findings.find(
    (entry) => entry.code === "plan_item_duplicate",
  );
  assert.deepEqual(finding, { code: "plan_item_duplicate", planPosition: 7 });
});

test("a legitimate known-link skip is corroborated and counted", (t) => {
  // links[0] is open and was triaged, so the plan's `skip_known` stands whatever the dates say. The
  // fixture's own skip_closed makes two; links[1] is `skip_known` too, but the batch fetched it on
  // the user's request, and a skip the batch did not take is not counted as one.
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      payload.files.delete(CAPTURE_ONE);
      payload.files.delete(INPUT_ONE);
      payload.files.delete(TRACE_ONE);
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records = manifest.records.filter((record) => record.index !== 1);
      });
      editJson(payload.files, "plan.json", (plan) => {
        plan.items[0].action = "skip_known";
      });
    },
  });
  assert.ok(!codes(report).includes("plan_skip_uncorroborated"), codes(report).join(","));
  assert.ok(!codes(report).includes("link_uncovered"), codes(report).join(","));
  assert.equal(checkOf(report, "baseline-diff").counts.skipsCorroborated, 2);
});

test("a capture stamped at another time than the manifest fetched it is caught", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      rewriteCaptureBodyHeader(payload.files, CAPTURE_ONE, (header) => ({
        ...header,
        "fetched-at": "2026-08-19T09:15:00.000Z",
      }));
    },
  });
  assert.ok(
    codes(report).includes("manifest_capture_fetched_at_mismatch"),
    codes(report).join(","),
  );
});

test("a manifest cannot launder a transcript into a fetched capture", (t) => {
  // The manifest names the browser's own capture as its persisted file, with a matching digest.
  // Provenance still says transcript, because the record's primary file is what a fetch writes.
  const { report } = verify(t, {
    mutate: (payload) => {
      const browser = verifyCaptureFile(payload.files.get(CAPTURE_FIVE));
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[4].usable = true;
        manifest.records[4].outcome = "active";
        manifest.records[4].fallback = null;
        manifest.records[4].persisted = {
          file: CAPTURE_FIVE,
          sha256: browser.header["normalized-sha256"],
          bytes: Number(browser.header["body-bytes"]),
        };
      });
    },
  });
  assert.equal(report.counts.capturesByProvenance.transcript, 1);
  assert.equal(report.counts.capturesByProvenance.http_fetch, 3);
});

test("a manifest row that reached no usable body names no fetched capture", (t) => {
  // The other half of the same guard: a row the transport itself calls unusable cannot be the one
  // that anchors a capture's provenance, whatever it points at.
  const { report } = verify(t, {
    mutate: (payload) => {
      const primary = verifyCaptureFile(payload.files.get(CAPTURE_ONE));
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.records[0].usable = false;
        manifest.records[0].fallback = "browser";
        manifest.records[0].persisted = {
          file: CAPTURE_ONE,
          sha256: primary.header["normalized-sha256"],
          bytes: Number(primary.header["body-bytes"]),
        };
      });
    },
  });
  assert.equal(report.counts.capturesByProvenance.http_fetch, 2);
  assert.equal(report.counts.capturesByProvenance.transcript, 2);
});

test("a skip the ledger row does not support accounts for nothing", (t) => {
  // The row exists and is closed, so `skip_known` is not what the ledger said - and the link it
  // removed has no record of its own.
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, "plan.json", (plan) => {
        plan.items[2].action = "skip_known";
      });
    },
  });
  const uncovered = checkOf(report, "completeness").findings.find(
    (entry) => entry.code === "link_uncovered",
  );
  assert.ok(uncovered !== undefined, codes(report).join(","));
  assert.equal(uncovered.position, 3);
});

test("the first row for a key stays the first however many follow it", (t) => {
  // Three rows for one posting: the original, a second spelling, and the original again. The last
  // is a repeat of the first, not of the spelling before it, so it accounts for nothing.
  const { report } = verify(t, {
    to: 7,
    mutate: (payload) => {
      payload.links = `${payload.links.trimEnd()}\n${LINKEDIN_SLUG_SPELLING}\n`;
      editJson(payload.files, "plan.json", (plan) => {
        plan.items.push({
          ...plan.items[0],
          input_index: 7,
          link: LINKEDIN_SLUG_SPELLING,
          url: LINKEDIN_SLUG_SPELLING,
          key: "linkedin:4500000001",
          action: "fetch_new",
          duplicate_in_batch: true,
        });
        plan.items.push({ ...plan.items[0], input_index: 8, duplicate_in_batch: true });
      });
    },
  });
  const finding = checkOf(report, "completeness").findings.find(
    (entry) => entry.code === "plan_item_duplicate",
  );
  assert.deepEqual(finding, { code: "plan_item_duplicate", planPosition: 8 });
});

test("a batch that fetched nothing cannot skip its way to a pass", (t) => {
  // No verified capture means no instant to tell a baseline row from the batch's own write-back by
  // - and a drop nothing can check is reported, not granted.
  const { report } = verify(t, {
    mutate: (payload) => {
      for (const name of [...payload.files.keys()]) {
        if (
          /^\d{3}[.]/u.test(name) ||
          /^(inputs|traces|blind)\//u.test(name) ||
          name === "fetch-manifest.json" ||
          name === "disposition.json"
        ) {
          payload.files.delete(name);
        }
      }
      editJson(payload.files, "plan.json", (plan) => {
        for (const item of plan.items) {
          item.action = "skip_known";
          item.status = "open";
          item.last_checked = priorObservedAt;
        }
      });
    },
  });
  assert.equal(report.status, "fail");
  const finding = checkOf(report, "completeness").findings.find(
    (entry) => entry.code === "plan_skips_unverifiable",
  );
  assert.ok(finding !== undefined, codes(report).join(","));
  assert.ok(finding.planPositions.length > 0, JSON.stringify(finding));
});

test("a ledger row this batch already wrote cannot support its own skip", (t) => {
  const prepared = prepare(t, { ledger: true });
  const ledger = JSON.parse(readFileSync(prepared.ledgerPath, "utf8"));
  for (const entry of ledger.entries) entry.last_checked = "2026-08-24T00:00:00.000Z";
  writeFileSync(prepared.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  const report = runSuite(
    buildContext({
      artifactsDir: prepared.artifactsDir,
      from: prepared.from,
      ledgerPath: prepared.ledgerPath,
      linksFile: prepared.linksFile,
      to: prepared.to,
    }),
    "per-batch",
  );
  assert.ok(codes(report).includes("plan_skips_unverifiable"), codes(report).join(","));
});

test("a contradicting rescue is reported on a batch with no manifest at all", (t) => {
  // The browser transport writes no manifest, so this is the only thing in the check that can still
  // speak there - and it has to.
  const { report } = verify(t, {
    mutate: (payload) => {
      payload.files.delete("fetch-manifest.json");
      const primary = verifyCaptureFile(payload.files.get("003.capture.txt"));
      payload.files.set(
        "003.capture.txt",
        renderCaptureFile({
          header: { ...primary.header, adapter: "in-app-browser@1", outcome: "active" },
          body: primary.body,
        }),
      );
    },
  });
  const finding = checkOf(report, "cross-transport").findings.find(
    (entry) => entry.code === "rescue_contradicts_declaration",
  );
  assert.deepEqual(finding, {
    code: "rescue_contradicts_declaration",
    index: 3,
    declared: "closed",
  });
});

test("two spellings of one link that normalize alike are one link, not a copied row", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, "plan.json", (plan) => {
        plan.items.push({
          ...plan.items[0],
          input_index: 7,
          link: `${plan.items[0].link}?utm_source=newsletter`,
          duplicate_in_batch: true,
        });
      });
    },
  });
  assert.ok(!codes(report).includes("plan_item_duplicate"), codes(report).join(","));
  assert.ok(!codes(report).includes("plan_item_duplicate_unclaimed"), codes(report).join(","));
});

test("a terminal skip is unverifiable too when nothing dates the ledger row", (t) => {
  // The sibling of the recency case, and the one that matters more: `skip_closed` is the terminal
  // action, so a vacancy dropped by it leaves the pipeline for good. With no verified capture
  // nothing separates a baseline row from this batch's own write-back.
  const { report } = verify(t, {
    mutate: (payload) => {
      for (const name of [...payload.files.keys()]) {
        if (
          /^\d{3}[.]/u.test(name) ||
          /^(inputs|traces|blind)\//u.test(name) ||
          name === "fetch-manifest.json" ||
          name === "disposition.json"
        ) {
          payload.files.delete(name);
        }
      }
      editJson(payload.files, "plan.json", (plan) => {
        for (const item of plan.items) {
          item.action = "skip_closed";
          item.status = "closed";
          item.last_checked = "2026-08-24T00:00:00.000Z";
        }
      });
    },
  });
  assert.equal(report.status, "fail");
  assert.ok(codes(report).includes("plan_skips_unverifiable"), codes(report).join(","));
});

test("a plan that omits its baseline does not buy a quieter report", (t) => {
  // The stated lie already failed. The withheld one used to pass: strip the baseline fields and the
  // decision change disappeared with them. The ledger row answers for the plan that would not.
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      editJson(payload.files, "plan.json", (plan) => {
        for (const item of plan.items) {
          delete item.status;
          delete item.decision;
          delete item.flags;
          delete item.priority_class;
          if (item.action === "skip_known") {
            item.action = "fetch_new";
            item.reason = "not in the ledger";
          }
        }
      });
    },
  });
  const diff = checkOf(report, "baseline-diff").diffs.find(
    (entry) => entry.code === "decision_changed" && entry.index === 1,
  );
  assert.deepEqual(
    { from: diff?.from, to: diff?.to },
    { from: "MANUAL_REVIEW", to: "SKIP" },
    JSON.stringify(checkOf(report, "baseline-diff").diffs),
  );
  assert.equal(checkOf(report, "baseline-diff").counts.known, 2);
});

test("the manifest can date a batch whose captures cannot", (t) => {
  // One 404 and nothing else persisted: no capture verifies, but the transport still recorded when
  // it asked. That is an artifact the plan did not write, so the skip stays checkable.
  const withManifest = verify(t, {
    mutate: (payload) => {
      for (const name of [...payload.files.keys()]) {
        if (/^\d{3}[.]/u.test(name) || name === "disposition.json") payload.files.delete(name);
      }
      editJson(payload.files, "plan.json", (plan) => {
        plan.items[2].action = "skip_closed";
      });
    },
  });
  assert.ok(
    !codes(withManifest.report).includes("plan_skips_unverifiable"),
    codes(withManifest.report).join(","),
  );

  const withoutManifest = verify(t, {
    mutate: (payload) => {
      for (const name of [...payload.files.keys()]) {
        if (/^\d{3}[.]/u.test(name) || name === "disposition.json") payload.files.delete(name);
      }
      payload.files.delete("fetch-manifest.json");
    },
  });
  assert.ok(
    codes(withoutManifest.report).includes("plan_skips_unverifiable"),
    codes(withoutManifest.report).join(","),
  );
});

test("a ledger row this batch wrote is not a baseline to fall back on either", (t) => {
  // Same omission, but every ledger row now carries an observation from after the fetch. That is
  // this batch's own write-back, so there is no baseline and the records are simply new.
  const prepared = prepare(t, {
    ledger: true,
    mutate: (payload) => {
      editJson(payload.files, "plan.json", (plan) => {
        for (const item of plan.items) {
          delete item.status;
          delete item.decision;
          delete item.flags;
          if (item.action === "skip_known") item.action = "fetch_new";
        }
      });
    },
  });
  const ledger = JSON.parse(readFileSync(prepared.ledgerPath, "utf8"));
  for (const entry of ledger.entries) entry.last_checked = "2026-08-24T00:00:00.000Z";
  writeFileSync(prepared.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  const report = runSuite(
    buildContext({
      artifactsDir: prepared.artifactsDir,
      from: prepared.from,
      ledgerPath: prepared.ledgerPath,
      linksFile: prepared.linksFile,
      to: prepared.to,
    }),
    "full",
  );
  const diff = checkOf(report, "baseline-diff");
  assert.equal(diff.counts.known, 0);
  assert.deepEqual(diff.diffs, []);
});

// ---------------------------------------------------------------------------
// the artifacts a batch can present broken rather than absent

test("a malformed artifact is a bounded finding, never a crash", (t) => {
  const cases = [
    [
      "plan_unreadable",
      (payload) => {
        payload.files.set("plan.json", "{ not json");
      },
    ],
    [
      "disposition_unreadable",
      (payload) => {
        payload.files.set("disposition.json", "{ not json");
      },
    ],
    [
      "attestation_unreadable",
      (payload) => {
        payload.files.set("attestation.json", "{ not json");
      },
    ],
    [
      "attestation_invalid",
      (payload) => {
        editJson(payload.files, "attestation.json", (file) => {
          file.schemaVersion = 9;
        });
      },
    ],
    [
      "manifest_unreadable",
      (payload) => {
        payload.files.set("fetch-manifest.json", "{ not json");
      },
    ],
    [
      "input_absent",
      (payload) => {
        payload.files.delete(INPUT_ONE);
      },
    ],
    [
      "trace_unreadable",
      (payload) => {
        payload.files.set(TRACE_ONE, "{ not json");
      },
    ],
    [
      "input_not_scoreable",
      (payload) => {
        editJson(payload.files, INPUT_ONE, (input) => {
          input.offers[0].workFormat = "Sideways";
        });
      },
    ],
    [
      "trace_index_mismatch",
      (payload) => {
        editJson(payload.files, TRACE_ONE, (trace) => {
          trace.input_index = 9;
        });
      },
    ],
    [
      "capture_empty",
      (payload) => {
        payload.files.set(CAPTURE_ONE, "");
      },
    ],
    [
      "capture_delimiter_absent",
      (payload) => {
        payload.files.set(CAPTURE_ONE, "# vacancy-fetch capture v1\n");
      },
    ],
    [
      "capture_header_absent",
      (payload) => {
        const parsed = verifyCaptureFile(payload.files.get(CAPTURE_ONE));
        const rendered = renderCaptureFile({ header: parsed.header, body: parsed.body });
        payload.files.set(CAPTURE_ONE, rendered.slice(rendered.indexOf("\n") + 1));
      },
    ],
    [
      "blind_index_unusable",
      (payload) => {
        payload.files.set(join("blind", "004.input.json"), payload.files.get(INPUT_TWO));
        payload.files.delete(join("blind", "002.input.json"));
      },
    ],
    [
      "blind_input_not_scoreable",
      (payload) => {
        editJson(payload.files, join("blind", "002.input.json"), (input) => {
          input.policyId = "triage-r1-05a-2026-08-04";
        });
      },
    ],
    // The blind extractor copies the scoring values of the primary input; an object without them
    // is not one the scorer reads.
    [
      "blind_input_not_scoreable",
      (payload) => {
        editJson(payload.files, join("blind", "002.input.json"), (input) => {
          delete input.candidateScoring;
        });
      },
    ],
    [
      "capture_size_mismatch",
      (payload) => {
        const parsed = verifyCaptureFile(payload.files.get(CAPTURE_ONE));
        payload.files.set(
          CAPTURE_ONE,
          renderCaptureFile({
            header: { ...parsed.header, "body-bytes": "1" },
            body: parsed.body,
          }),
        );
      },
    ],
    [
      "blind_input_unreadable",
      (payload) => {
        payload.files.set(join("blind", "002.input.json"), "{ not json");
      },
    ],
    [
      "blind_extraction_sample_count",
      (payload) => {
        for (const index of ["001", "003", "004"]) {
          payload.files.set(join("blind", `${index}.input.json`), payload.files.get(INPUT_TWO));
        }
      },
    ],
    [
      "probe_duplicate",
      (payload) => {
        editJson(payload.files, "attestation.json", (file) => {
          file.probes.push({ ...file.probes[0] });
        });
      },
    ],
    [
      "record_source_ref_unusable",
      (payload) => {
        editJson(payload.files, INPUT_ONE, (input) => {
          input.source.sourceRef = "not a url";
        });
      },
    ],
  ];
  for (const [expected, mutate] of cases) {
    const { report } = verify(t, { cadence: "full", mutate });
    assert.ok(codes(report).includes(expected), `${expected} not in ${codes(report).join(",")}`);
  }
});

test("a record whose input cannot be read is not swept as if it could", (t) => {
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      payload.files.set(INPUT_TWO, "{ not json");
    },
  });
  assert.ok(codes(report).includes("record_not_sweepable"), codes(report).join(","));
  assert.ok(codes(report).includes("record_key_underivable"), codes(report).join(","));
});

test("a plan item with an unusable link is reported, not skipped over", (t) => {
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      editJson(payload.files, "plan.json", (plan) => {
        plan.items[2].link = "ftp://example.test/job";
      });
    },
  });
  assert.ok(codes(report).includes("plan_item_unusable"), codes(report).join(","));
});

test("a manifest that stopped early and a closure only the browser saw are differences", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.stoppedEarly = "rate_limited";
        manifest.records[2].outcome = "active";
      });
    },
  });
  const diffCodes = checkOf(report, "cross-transport").diffs.map((entry) => entry.code);
  assert.ok(diffCodes.includes("manifest_stopped_early"), diffCodes.join(","));
  assert.ok(diffCodes.includes("closed_beyond_manifest"), diffCodes.join(","));
});

test("a fetch stamp written unreadably fails as loudly as one left out", (t) => {
  // Until this check existed, garbling the timestamp was quieter than omitting it: every reader of
  // a fetch instant treats an unparseable stamp as no instant, so four gates switched off silently.
  const { report } = verify(t, {
    cadence: "full",
    mutate: (payload) => {
      for (const name of ["001.capture.txt", "002.capture.txt", "003.capture.txt", CAPTURE_FIVE]) {
        rewriteCaptureBodyHeader(payload.files, name, (header) => ({
          ...header,
          "fetched-at": "2026-08-23 09:15 SGT",
        }));
      }
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.startedAt = "2026-08-23 09:15 SGT";
        for (const record of manifest.records) record.fetchedAt = "2026-08-23 09:15 SGT";
      });
    },
  });
  assert.equal(report.status, "fail");
  assert.ok(codes(report).includes("capture_fetched_at_unusable"), codes(report).join(","));
  assert.ok(codes(report).includes("manifest_fetched_at_unusable"), codes(report).join(","));
});

test("the batch is dated by the instant the transport took before it started", (t) => {
  // A write-back recorded between the manifest's own start and the first capture is still this
  // batch's own observation, and must not become the baseline it is compared against.
  const prepared = prepare(t, {
    ledger: true,
    mutate: (payload) => {
      editJson(payload.files, "plan.json", (plan) => {
        for (const item of plan.items) {
          delete item.status;
          delete item.decision;
          delete item.flags;
          if (item.action === "skip_known") item.action = "fetch_new";
        }
      });
      editJson(payload.files, "fetch-manifest.json", (manifest) => {
        manifest.startedAt = "2026-08-23T09:00:00.000Z";
      });
    },
  });
  const ledger = JSON.parse(readFileSync(prepared.ledgerPath, "utf8"));
  for (const entry of ledger.entries) entry.last_checked = "2026-08-23T09:05:00.000Z";
  writeFileSync(prepared.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  const report = runSuite(
    buildContext({
      artifactsDir: prepared.artifactsDir,
      from: prepared.from,
      ledgerPath: prepared.ledgerPath,
      linksFile: prepared.linksFile,
      to: prepared.to,
    }),
    "full",
  );
  assert.equal(checkOf(report, "baseline-diff").counts.known, 0);
});

test("a usable instant is one that carries its own zone", () => {
  // `Date.parse` reads a zoneless ISO stamp in the host's timezone, so the same directory would
  // date differently on two machines - and later, which is the permissive direction.
  assert.equal(usableInstant("2026-08-23T09:15:00.000Z"), Date.parse("2026-08-23T09:15:00.000Z"));
  assert.equal(
    usableInstant("2026-08-23T09:15:00.000+08:00"),
    Date.parse("2026-08-23T01:15:00.000Z"),
  );
  assert.equal(usableInstant("2026-08-23T09:15:00.000"), null);
  assert.equal(usableInstant("2026-08-23"), null);
  assert.equal(usableInstant("2026-08-23 09:15 SGT"), null);
  assert.equal(usableInstant(""), null);
  assert.equal(usableInstant(17874756e5), null);
  assert.equal(presentButUnusable("-"), false);
  assert.equal(presentButUnusable(""), false);
  assert.equal(presentButUnusable("2026-08-23T09:15:00.000"), true);
});

test("the instant the write-back guard rests on is itself checked", (t) => {
  const cases = [
    (manifest) => {
      delete manifest.startedAt;
    },
    (manifest) => {
      manifest.startedAt = "2026-08-23 09:00 SGT";
    },
    (manifest) => {
      manifest.startedAt = "2026-08-23T09:00:00.000";
    },
    (manifest) => {
      manifest.startedAt = null;
    },
  ];
  for (const edit of cases) {
    const { report } = verify(t, {
      mutate: (payload) => {
        editJson(payload.files, "fetch-manifest.json", edit);
      },
    });
    const finding = checkOf(report, "cross-transport").findings.find(
      (entry) => entry.code === "manifest_started_at_unusable",
    );
    assert.deepEqual(finding, { code: "manifest_started_at_unusable" });
  }
});

test("a capture stamped without its zone is not a usable stamp", (t) => {
  const { report } = verify(t, {
    mutate: (payload) => {
      rewriteCaptureBodyHeader(payload.files, CAPTURE_ONE, (header) => ({
        ...header,
        "fetched-at": "2026-08-23T09:15:00.000",
      }));
    },
  });
  assert.ok(codes(report).includes("capture_fetched_at_unusable"), codes(report).join(","));
});

test("an absent record the confirmation load found live is scored, not contradicted", (t) => {
  // `instructions/skills/score-jobs.md` transport rung 2: a posting the rubric may record as gone
  // owes one confirmation load in the browser before it is classified. When that load finds it
  // live, scoring it is the procedure working - and the quote walk holds the evidence against the
  // body the load produced.
  const live = [
    "Senior QA Engineer",
    "",
    "Umbrella Systems is hiring a Senior QA Engineer for a remote role.",
    "",
    "We are fully remote across the EU and hire contractors.",
    "",
  ].join("\n");
  const scoreTheLiveRecord = (payload) => {
    const primary = verifyCaptureFile(payload.files.get(CAPTURE_ONE));
    const name = join("inputs", "004.input.json");
    const input = JSON.parse(payload.files.get(name));
    payload.files.set(
      "004.browser.capture.txt",
      renderCaptureFile({
        header: {
          ...primary.header,
          index: 4,
          adapter: "in-app-browser@1",
          outcome: "-",
          "requested-url": input.source.sourceRef,
          "final-url": input.source.sourceRef,
          "normalized-sha256": sha256Utf8(live),
          "body-bytes": Buffer.byteLength(live, "utf8"),
        },
        body: live,
      }),
    );
    editJson(payload.files, name, (value) => {
      value.source.accessOutcome = "usable";
      value.source.accessReason = null;
      value.source.evidenceQuote = "Senior QA Engineer";
      value.offers = [
        {
          companyRegion: "WEST",
          compensationMarket: "other",
          contractorEligibility: "eligible",
          engagementPath: "outside_home_contractor",
          evidenceQuote: "We are fully remote across the EU and hire contractors.",
          relocationCountry: null,
          relocationCountryCode: null,
          relocationSupport: "unknown",
          residenceRequirementCountry: null,
          residenceRequirementCountryCode: null,
          residenceRestriction: "none",
          sponsorship: "unknown",
          timezone: "tz_any",
          timezoneDistance: "near",
          westRegion: "EU_UK",
          workAuthorization: "unknown",
          workFormat: "Remote",
        },
      ];
      value.role = {
        ai: { product: "none", work: "none" },
        automation: "primary",
        domain: "other_complex",
        evidence: {
          aiProduct: null,
          aiWork: null,
          automation: null,
          domain: "Umbrella Systems is hiring a Senior QA Engineer for a remote role.",
          language: null,
          role: "Senior QA Engineer",
          seniority: null,
          tools: null,
        },
        family: "qa_testing",
        language: "English",
        observedTools: [],
        observedLanguages: [],
        seniority: "senior",
      };
    });
    rebuildTrace(payload.files, name, join("traces", "004.trace.json"));
  };

  const confirmed = verify(t, { mutate: scoreTheLiveRecord });
  assert.equal(confirmed.report.status, "pass", codes(confirmed.report).join(","));

  // Without the load nothing looked at the posting, so the contradiction stands.
  const unconfirmed = verify(t, {
    mutate: (payload) => {
      scoreTheLiveRecord(payload);
      payload.files.delete("004.browser.capture.txt");
    },
  });
  assert.ok(
    codes(unconfirmed.report).includes("closed_source_scored"),
    codes(unconfirmed.report).join(","),
  );

  // And a first-party closure banner owes no confirmation, so scoring one is still caught.
  const banner = verify(t, {
    mutate: (payload) => {
      const name = join("inputs", "003.input.json");
      editJson(payload.files, name, (value) => {
        value.source.accessOutcome = "usable";
        value.source.accessReason = null;
        value.role.ai = { product: "none", work: "none" };
        value.offers = [
          {
            companyRegion: "OTHER",
            compensationMarket: "unknown",
            contractorEligibility: "unknown",
            engagementPath: null,
            evidenceQuote: "Globex Payments was hiring a Senior QA Engineer for its Berlin office.",
            relocationCountry: null,
            relocationCountryCode: null,
            relocationSupport: "unknown",
            residenceRequirementCountry: null,
            residenceRequirementCountryCode: null,
            residenceRestriction: "unknown",
            sponsorship: "unknown",
            timezone: "tz_unknown",
            timezoneDistance: "unknown",
            westRegion: null,
            workAuthorization: "unknown",
            workFormat: "Unknown",
          },
        ];
      });
      rebuildTrace(payload.files, name, join("traces", "003.trace.json"));
    },
  });
  assert.ok(codes(banner.report).includes("closed_source_scored"), codes(banner.report).join(","));
});

test("a batch is recomputed on the scoring values its inputs recorded, not on the configuration's", (t) => {
  // The replayed inputs carry values the example configuration does not hold, so a check that read
  // the configuration to score them would recompute other traces than the batch recorded.
  const configured = candidateScoringValues({ root: candidateExampleRootFor(repoRoot) });
  for (const record of buildRecords()) {
    assert.notDeepEqual(record.input.candidateScoring, JSON.parse(JSON.stringify(configured)));
  }
  const { report } = verify(t, { cadence: "full" });
  for (const code of ["trace_mismatch", "input_not_scoreable", "blind_input_not_scoreable"]) {
    assert.equal(codes(report).includes(code), false, code);
  }
  assert.equal(checkOf(report, "completeness").counts.tracesRecomputed, 5);
});

for (const scope of ["main", "optional", "product", "ambiguous"]) {
  test(`quote-integrity verifies concrete ${scope} stack evidence`, (t) => {
    const { report } = verify(t, {
      mutate: (payload) => {
        editJson(payload.files, INPUT_TWO, (input) => {
          for (const key of ["observedLanguages", "observedTools"]) {
            const item = input.role[key][0];
            item.scope = scope;
            item.requirement = scope === "optional" ? "optional" : "required";
            item.evidenceQuote = "A fabricated QA technology requirement absent from the capture.";
          }
        });
      },
    });
    const findings = checkOf(report, "quote-integrity").findings;
    assert.ok(findings.some((item) => item.path === "role.observedLanguages[0].evidenceQuote"));
    assert.ok(findings.some((item) => item.path === "role.observedTools[0].evidenceQuote"));
  });
}

test("earlier input schemas and trace taxonomies report policy_drift without recomputation", (t) => {
  for (const target of ["schema", "taxonomy", "policy"]) {
    const { report } = verify(t, {
      mutate: (payload) => {
        if (target === "schema")
          editJson(payload.files, INPUT_TWO, (input) => (input.schemaVersion = 8));
        else
          editJson(payload.files, TRACE_TWO, (trace) => {
            if (target === "taxonomy")
              trace.toolmatch_taxonomy_id = "toolmatch-taxonomy-v5-2026-10-01";
            else trace.policy_id = "triage-policy-v7-2026-10-01";
          });
      },
    });
    assert.ok(codes(report).includes("policy_drift"));
    assert.equal(checkOf(report, "completeness").counts.tracesRecomputed, 4);
  }
});
