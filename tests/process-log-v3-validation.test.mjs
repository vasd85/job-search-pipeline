import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyProcessRecord,
  fileBackedStepNames,
  processLogV3ValidationErrorEvidence,
  readLogV3,
  validateLogV3,
} from "../tools/lib/process-log-core.mjs";
import {
  processLogDiagnosticForbiddenShapeIds,
  processLogDiagnosticLimits,
  processLogStableDiagnosticCodePattern,
  processLogUppercaseCauseCodePattern,
} from "../tools/lib/process-log-diagnostics.mjs";
import {
  fileBackedStepDependencies,
  PROCESS_LOG_FUTURE_SKEW_MS,
} from "../tools/lib/process-log-v3-validation.mjs";
import {
  createHistoricalV2Log,
  createPendingStep,
  createRunningPublicationStep,
  createValidV3Log,
} from "./fixtures/process-log-v3.mjs";
import { createDisposableWorkspace } from "./fixtures/disposable-workspace.mjs";

function tempLedger(t, log) {
  return createDisposableWorkspace(t, {
    ledger: log,
    prefix: "job-search-process-log-v3-",
  }).ledgerPath;
}

function assertInvalid(log, pattern) {
  assert.throws(() => validateLogV3(log), pattern);
}

test("trusted validation evidence is an immutable private snapshot", () => {
  let caught = null;
  try {
    validateLogV3({});
  } catch (error) {
    caught = error;
  }
  assert.notEqual(caught, null);
  const expected = {
    code: "process_log_validation_failed",
    context: "operation=validate_process_log",
    recoveryAction: "repair_process_log_schema",
  };
  const firstEvidence = processLogV3ValidationErrorEvidence(caught);
  const secondEvidence = processLogV3ValidationErrorEvidence(caught);
  assert.notEqual(firstEvidence, secondEvidence);
  assert.deepEqual(firstEvidence, expected);
  firstEvidence.code = "mutated_public_copy";
  assert.deepEqual(secondEvidence, expected);
  caught.code = "hostile_code";
  caught.context = "/private/tmp/hostile-validation-context";
  caught.recoveryAction = "Bearer synthetic-hostile-recovery";
  assert.deepEqual(processLogV3ValidationErrorEvidence(caught), expected);
  assert.doesNotMatch(
    JSON.stringify(processLogV3ValidationErrorEvidence(caught)),
    /hostile|private\/tmp|Bearer/,
  );
});

function fileBackedProcess(log) {
  return log.processes.find((record) => record.artifact_mode === "file-backed");
}

function utf8StringAtBytes(byteLength, prefix = "Я") {
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  assert.ok(prefixBytes <= byteLength);
  return `${prefix}${"a".repeat(byteLength - prefixBytes)}`;
}

const EXPECTED_DIAGNOSTIC_FORBIDDEN_SHAPES = Object.freeze([
  "bearer_token",
  "credential_assignment",
  "posix_absolute_path",
  "private_key_marker",
  "stack_frame",
  "stack_frame_bare",
  "token_prefix_aws",
  "token_prefix_github",
  "token_prefix_openai",
  "token_prefix_slack",
  "unc_path",
  "url",
  "windows_absolute_path",
]);

const DECLARED_DIAGNOSTIC_FORBIDDEN_SHAPES = Object.freeze([
  ["url", "https://secret.example.test/private"],
  ["posix_absolute_path", "/private/tmp/process-log-secret.txt"],
  ["windows_absolute_path", "C:\\Users\\fixture\\secret.txt"],
  ["unc_path", "\\\\server\\share\\secret.txt"],
  ["stack_frame", "at publishStep (/private/tmp/tool.mjs:10:3)"],
  ["stack_frame_bare", "at node:internal/modules/run_main:123:45"],
  ["credential_assignment", "api_key=synthetic-secret-value"],
  ["bearer_token", "Bearer synthetic-token-value-12345"],
  ["private_key_marker", "-----BEGIN PRIVATE KEY-----"],
  ["token_prefix_openai", "sk-syntheticOpenAiToken123"],
  ["token_prefix_github", "ghp_syntheticGithubToken123"],
  ["token_prefix_slack", "xoxb-synthetic-slack-token-123"],
  ["token_prefix_aws", "AKIAIOSFODNN7EXAMPLE"],
]);
const EXPECTED_DIAGNOSTIC_FORBIDDEN_VARIANTS = Object.freeze([
  "aws_asia",
  "aws_minimum",
  "bearer_minimum",
  "bearer_special_characters",
  "credential_access_token",
  "credential_access_hyphen_token",
  "credential_accesstoken",
  "credential_api_hyphen_key",
  "credential_apikey",
  "credential_case",
  "credential_colon",
  "credential_double_quote",
  "credential_passwd",
  "credential_password",
  "credential_secret",
  "credential_single_quote",
  "credential_whitespace",
  "credential_minimum",
  "github_gho",
  "github_ghr",
  "github_ghs",
  "github_ghu",
  "github_github_pat",
  "github_minimum",
  "github_underscore_character",
  "openai_minimum",
  "openai_underscore_hyphen_characters",
  "private_key_algorithm",
  "posix_single_character",
  "posix_prefix_left_paren",
  "posix_prefix_equal",
  "posix_prefix_bracket",
  "posix_prefix_brace",
  "posix_prefix_double_quote",
  "posix_prefix_single_quote",
  "slack_xoxa",
  "slack_xoxp",
  "slack_xoxr",
  "slack_xoxs",
  "slack_minimum",
  "stack_async",
  "stack_bare_async",
  "stack_functionless_parenthesized",
  "unc_prefix_left_paren",
  "unc_prefix_equal",
  "unc_prefix_bracket",
  "unc_prefix_brace",
  "unc_prefix_double_quote",
  "unc_prefix_single_quote",
  "unc_single_character",
  "url_case",
  "url_file",
  "url_file_case",
  "url_http",
  "url_http_case",
  "url_single_character",
  "windows_forward_slash",
  "windows_lowercase_drive",
  "windows_prefix_left_paren",
  "windows_prefix_equal",
  "windows_prefix_bracket",
  "windows_prefix_brace",
  "windows_prefix_double_quote",
  "windows_prefix_single_quote",
  "windows_single_character",
]);
const DECLARED_DIAGNOSTIC_FORBIDDEN_VARIANTS = Object.freeze([
  ["credential_case", "credential_assignment", "API_KEY=syntheticValue123"],
  ["credential_apikey", "credential_assignment", "apikey=syntheticValue123"],
  ["credential_api_hyphen_key", "credential_assignment", "api-key=syntheticValue123"],
  ["credential_access_token", "credential_assignment", "access_token=syntheticValue123"],
  ["credential_accesstoken", "credential_assignment", "accesstoken=syntheticValue123"],
  ["credential_access_hyphen_token", "credential_assignment", "access-token=syntheticValue123"],
  ["credential_password", "credential_assignment", "password=syntheticValue123"],
  ["credential_passwd", "credential_assignment", "passwd=syntheticValue123"],
  ["credential_secret", "credential_assignment", "secret=syntheticValue123"],
  ["credential_colon", "credential_assignment", "api_key: syntheticValue123"],
  ["credential_double_quote", "credential_assignment", "api_key=\"syntheticValue123"],
  ["credential_single_quote", "credential_assignment", "api_key='syntheticValue123"],
  ["credential_whitespace", "credential_assignment", "api_key = syntheticValue123"],
  ["url_case", "url", "HTTPS://example.test/private"],
  ["url_http", "url", "http://example.test/private"],
  ["url_http_case", "url", "HTTP://example.test/private"],
  ["url_file", "url", "file://example.test/private"],
  ["url_file_case", "url", "FILE://example.test/private"],
  ["aws_asia", "token_prefix_aws", "ASIAIOSFODNN7EXAMPLE"],
  ["aws_minimum", "token_prefix_aws", "ASIAABCDEFGHIJKL"],
  ["bearer_minimum", "bearer_token", "Bearer abcdefgh"],
  ["bearer_special_characters", "bearer_token", "Bearer a._~+/=-"],
  ["credential_minimum", "credential_assignment", "secret=abcd"],
  ["github_gho", "token_prefix_github", "gho_syntheticToken123"],
  ["github_ghu", "token_prefix_github", "ghu_syntheticToken123"],
  ["github_ghs", "token_prefix_github", "ghs_syntheticToken123"],
  ["github_ghr", "token_prefix_github", "ghr_syntheticToken123"],
  ["github_github_pat", "token_prefix_github", "github_pat_syntheticToken123"],
  ["github_minimum", "token_prefix_github", "ghp_abcdefgh"],
  ["github_underscore_character", "token_prefix_github", "ghp_a_bcdefg"],
  ["openai_minimum", "token_prefix_openai", "sk-abcdefgh"],
  ["openai_underscore_hyphen_characters", "token_prefix_openai", "sk-a_b-cdef"],
  ["slack_xoxa", "token_prefix_slack", "xoxa-synthetic-token-123"],
  ["slack_xoxp", "token_prefix_slack", "xoxp-synthetic-token-123"],
  ["slack_xoxr", "token_prefix_slack", "xoxr-synthetic-token-123"],
  ["slack_xoxs", "token_prefix_slack", "xoxs-synthetic-token-123"],
  ["slack_minimum", "token_prefix_slack", "xoxb-abcdefgh"],
  ["private_key_algorithm", "private_key_marker", "-----BEGIN RSA PRIVATE KEY-----"],
  ["posix_single_character", "posix_absolute_path", "/x"],
  ["posix_prefix_left_paren", "posix_absolute_path", "(/private/tmp/secret.txt"],
  ["posix_prefix_equal", "posix_absolute_path", "=/private/tmp/secret.txt"],
  ["posix_prefix_bracket", "posix_absolute_path", "[/private/tmp/secret.txt"],
  ["posix_prefix_brace", "posix_absolute_path", "{/private/tmp/secret.txt"],
  ["posix_prefix_double_quote", "posix_absolute_path", "\"/private/tmp/secret.txt"],
  ["posix_prefix_single_quote", "posix_absolute_path", "'/private/tmp/secret.txt"],
  ["unc_prefix_left_paren", "unc_path", "(\\\\server\\share\\secret.txt"],
  ["unc_prefix_equal", "unc_path", "=\\\\server\\share\\secret.txt"],
  ["unc_prefix_bracket", "unc_path", "[\\\\server\\share\\secret.txt"],
  ["unc_prefix_brace", "unc_path", "{\\\\server\\share\\secret.txt"],
  ["unc_prefix_double_quote", "unc_path", "\"\\\\server\\share\\secret.txt"],
  ["unc_prefix_single_quote", "unc_path", "'\\\\server\\share\\secret.txt"],
  ["unc_single_character", "unc_path", "\\\\s\\x"],
  ["windows_prefix_left_paren", "windows_absolute_path", "(C:\\Users\\fixture\\secret.txt"],
  ["windows_prefix_equal", "windows_absolute_path", "=C:\\Users\\fixture\\secret.txt"],
  ["windows_prefix_bracket", "windows_absolute_path", "[C:\\Users\\fixture\\secret.txt"],
  ["windows_prefix_brace", "windows_absolute_path", "{C:\\Users\\fixture\\secret.txt"],
  ["windows_prefix_double_quote", "windows_absolute_path", "\"C:\\Users\\fixture\\secret.txt"],
  ["windows_prefix_single_quote", "windows_absolute_path", "'C:\\Users\\fixture\\secret.txt"],
  ["windows_lowercase_drive", "windows_absolute_path", "c:\\Users\\fixture\\secret.txt"],
  ["windows_forward_slash", "windows_absolute_path", "C:/Users/fixture/secret.txt"],
  ["windows_single_character", "windows_absolute_path", "C:\\x"],
  ["stack_async", "stack_frame", "at async publishStep (tool.mjs:10:3)"],
  ["stack_bare_async", "stack_frame_bare", "at async node:internal/modules/run_main:123:45"],
  ["stack_functionless_parenthesized", "stack_frame", "at (node:internal/module:10:3)"],
  ["url_single_character", "url", "http://x"],
]);

const EXPECTED_CHRONOLOGY_CASES = Object.freeze([
  "active_after_previous_attempt",
  "active_matches_step_start",
  "blocker_matches_finish",
  "diagnostic_matches_finish",
  "historical_start_after_root",
  "history_attempt_order",
  "history_start_within_process",
  "history_start_before_finish",
  "prepared_after_active",
  "prepared_blocker_matches_prepare",
  "prepared_within_process",
  "process_start_before_step",
  "process_start_before_update",
  "root_after_process_update",
  "step_finish_before_update",
  "step_start_before_finish",
  "step_start_before_update",
  "step_updated_within_process",
  "terminal_history_finish_matches_step",
  "terminal_history_matches_step",
  "terminal_history_matches_step_blocked",
  "terminal_history_matches_step_completed",
  "terminal_history_matches_step_stale",
]);

const EXPECTED_FUTURE_TIMESTAMP_PATHS = Object.freeze([
  "active_attempt.started_at",
  "attempt_history.finished_at",
  "attempt_history.started_at",
  "diagnostic.blocker.at",
  "diagnostic.error.at",
  "historical.started_at",
  "process.started_at",
  "process.updated_at",
  "publication_transaction.prepared_at",
  "publication_transaction.blocker.at",
  "root.updated_at",
  "step.finished_at",
  "step.started_at",
  "step.updated_at",
]);

const EXPECTED_DEPENDENCY_EDGES = Object.freeze([
  "get_vacancy=>research_company",
  "map_experience=>generate_cv",
  "map_experience=>write_cover_letter",
  "research_company=>map_experience",
]);

const executedDiagnosticShapes = new Set();
const executedDiagnosticVariants = new Set();
const executedChronologyCases = new Set();
const executedFutureTimestampPaths = new Set();
const executedDependencyEdges = new Set();

test("v3 validation accepts a strict mixed historical/file-backed union from a temporary ledger", (t) => {
  const log = createValidV3Log();
  const ledgerPath = tempLedger(t, log);
  const validated = readLogV3(ledgerPath);

  assert.deepEqual(validated, log);
  assert.equal(classifyProcessRecord(validated.processes[0]), "historical");
  assert.equal(classifyProcessRecord(validated.processes[1]), "file-backed");
  assert.deepEqual(Object.keys(validated.processes[1].steps), fileBackedStepNames);
});

test("v3 validation is non-mutating", () => {
  const log = createValidV3Log();
  const before = structuredClone(log);
  assert.equal(validateLogV3(log), log);
  assert.deepEqual(log, before);
});

test("the top-level v2 ledger is rejected with an explicit unsupported-version error", (t) => {
  const ledgerPath = tempLedger(t, createHistoricalV2Log());
  assert.throws(
    () => readLogV3(ledgerPath),
    /schema_version must be 4; schema_version 3 is unsupported by the v4 ledger/,
  );
});

test("a historical-only cutover preserves company and process records byte-for-byte in memory", () => {
  const v2 = createHistoricalV2Log();
  const companiesBefore = JSON.stringify(v2.companies);
  const processesBefore = JSON.stringify(v2.processes);
  const v3 = { ...structuredClone(v2), schema_version: 4 };

  validateLogV3(v3);

  assert.equal(JSON.stringify(v3.companies), companiesBefore);
  assert.equal(JSON.stringify(v3.processes), processesBefore);
  assert.equal(v2.schema_version, 2);
});

test("v3 rejects unknown top-level and company keys", () => {
  const topLevel = createValidV3Log();
  topLevel.internal = "not allowed";
  assertInvalid(topLevel, /root contains unknown key: internal/);

  const company = createValidV3Log();
  company.companies[0].secret = "not allowed";
  assertInvalid(company, /companies\[0\] contains unknown key: secret/);
});

test("historical records keep exactly the old read-only shape", () => {
  const unknownKey = createValidV3Log();
  unknownKey.processes[0].steps_inferred = {};
  assertInvalid(unknownKey, /processes\[0\] contains unknown key: steps_inferred/);

  const lifecycleMarker = createValidV3Log();
  lifecycleMarker.processes[0].steps = {};
  assertInvalid(lifecycleMarker, /processes\[0\]\.artifact_mode must equal "file-backed"/);
});

test("file-backed records reject the historical status field", () => {
  const log = createValidV3Log();
  fileBackedProcess(log).status = "started";
  assertInvalid(log, /processes\[1\] contains unknown key: status/);
});

test("a stored source key must stay canonical, and a stored key version is a schema event", () => {
  // The canonicality check is what makes a normalization change total rather than gradual: it runs
  // on load for every record of both classes, so one non-canonical record fails the whole ledger.
  // docs/adr/0013 derives its cutover ordering from exactly this, and until now the invariant had
  // no negative test at all.
  const historical = createValidV3Log();
  historical.processes[0].source_key = `${historical.processes[0].source_key}?query=drifted`;
  assertInvalid(historical, /processes\[0\]\.source_key is not canonical/);

  const fileBacked = createValidV3Log();
  fileBackedProcess(fileBacked).source_key = "https://example.test/not-derived-from-the-reference";
  assertInvalid(fileBacked, /processes\[1\]\.source_key is not canonical/);

  // The two probes behind docs/adr/0013's rejection of a stored `source_key_version`: a reader that
  // predates the field refuses the record outright rather than ignoring it, and the ledger number
  // is pinned, so per-record versioning cannot be added without a schema event.
  const versionedFileBacked = createValidV3Log();
  fileBackedProcess(versionedFileBacked).source_key_version = 2;
  assertInvalid(
    versionedFileBacked,
    /processes\[1\] contains unknown key: source_key_version/,
  );

  const versionedHistorical = createValidV3Log();
  versionedHistorical.processes[0].source_key_version = 2;
  assertInvalid(
    versionedHistorical,
    /processes\[0\] contains unknown key: source_key_version/,
  );

  const bumped = createValidV3Log();
  bumped.schema_version = 3;
  assertInvalid(bumped, /schema_version must be 4/);
});

test("claude-ai-web remains historical provenance and cannot own a file-backed record", () => {
  const log = createValidV3Log();
  fileBackedProcess(log).runner = "claude-ai-web";
  assertInvalid(log, /runner claude-ai-web is reserved for historical provenance/);
});

test("file-backed records require exactly the five fixed step keys", () => {
  const missing = createValidV3Log();
  delete fileBackedProcess(missing).steps.write_cover_letter;
  assertInvalid(
    missing,
    /processes\[1\]\.steps\.write_cover_letter must be an object/,
  );

  const extra = createValidV3Log();
  fileBackedProcess(extra).steps.submit_application = createPendingStep();
  assertInvalid(
    extra,
    /processes\[1\]\.steps contains unknown key: submit_application/,
  );
});

test("unknown fields are rejected inside step and bundle metadata", () => {
  const step = createValidV3Log();
  fileBackedProcess(step).steps.get_vacancy.cache = true;
  assertInvalid(step, /steps\.get_vacancy contains unknown key: cache/);

  const artifact = createValidV3Log();
  fileBackedProcess(artifact).steps.get_vacancy.artifacts[0].absolute_path = "/tmp/leak";
  assertInvalid(artifact, /artifacts\[0\] contains unknown key: absolute_path/);
});

test("publication ids remain globally unique across committed history and prepared recovery", () => {
  const historyDuplicate = createValidV3Log();
  const historyProcess = fileBackedProcess(historyDuplicate);
  historyProcess.steps.write_cover_letter.attempt_history[0].publication_id =
    historyProcess.steps.get_vacancy.attempt_history[0].publication_id;
  assertInvalid(
    historyDuplicate,
    /steps\.write_cover_letter\.attempt_history\[0\]\.publication_id duplicates publication id owned by processes\[1\]\.steps\.get_vacancy\.attempt_history\[0\]\.publication_id/,
  );

  const preparedDuplicate = createValidV3Log();
  const preparedProcess = fileBackedProcess(preparedDuplicate);
  preparedProcess.steps.generate_cv = createRunningPublicationStep();
  preparedProcess.steps.generate_cv.publication_transaction.id =
    preparedProcess.steps.map_experience.attempt_history[0].publication_id;
  assertInvalid(
    preparedDuplicate,
    /steps\.generate_cv\.publication_transaction\.id duplicates publication id owned by processes\[1\]\.steps\.map_experience\.attempt_history\[0\]\.publication_id/,
  );

  validateLogV3(createValidV3Log());
});

test("step state invariants reject non-pristine pending and incomplete completed records", () => {
  const pending = createValidV3Log();
  const pendingStep = createPendingStep();
  pendingStep.updated_at = "2026-07-23T12:00:00.000Z";
  fileBackedProcess(pending).steps.generate_cv = pendingStep;
  assertInvalid(pending, /pending state must be pristine/);

  const completed = createValidV3Log();
  fileBackedProcess(completed).steps.get_vacancy.artifacts.pop();
  assertInvalid(completed, /must contain the complete get_vacancy artifact bundle/);

  const impossibleRevision = createValidV3Log();
  fileBackedProcess(impossibleRevision).steps.map_experience.revision = 2;
  assertInvalid(impossibleRevision, /revision cannot exceed the attempt number/);
});

test("artifact kind, canonical path, and schema version stay step-owned", () => {
  const wrongOwner = createValidV3Log();
  fileBackedProcess(wrongOwner).steps.research_company.artifacts[0].kind = "vacancy";
  assertInvalid(wrongOwner, /kind is not owned by step research_company/);

  const wrongPath = createValidV3Log();
  fileBackedProcess(wrongPath).steps.get_vacancy.artifacts[1].path = "renamed-vacancy.json";
  assertInvalid(wrongPath, /path must equal vacancy\.json for vacancy/);

  const wrongSchema = createValidV3Log();
  fileBackedProcess(wrongSchema).steps.map_experience.artifacts[0].schema_version = 2;
  assertInvalid(wrongSchema, /schema_version must equal 4 for application_brief/);
});

test("a vacancy entry records version 2 only and a brief entry version 4 only", () => {
  for (const version of [1, 3]) {
    const refused = createValidV3Log();
    fileBackedProcess(refused).steps.get_vacancy.artifacts[1].schema_version = version;
    assertInvalid(refused, /schema_version must equal 2 for vacancy/);
  }
  for (const version of [3, 5]) {
    const refused = createValidV3Log();
    fileBackedProcess(refused).steps.map_experience.artifacts[0].schema_version = version;
    assertInvalid(refused, /schema_version must equal 4 for application_brief/);
  }
});

test("a research entry records version 2 only", () => {
  for (const version of [1, 3]) {
    const refused = createValidV3Log();
    fileBackedProcess(refused).steps.research_company.artifacts[0].schema_version = version;
    assertInvalid(refused, /schema_version must equal 2 for company_research/);
  }
});

test("a closed attempt keeps the versions it read", () => {
  const log = createValidV3Log();
  const { steps } = fileBackedProcess(log);
  const [mapAttempt] = steps.map_experience.attempt_history;
  mapAttempt.input_snapshot.find((entry) => entry.kind === "company_research").schema_version = 1;
  mapAttempt.input_snapshot.find((entry) => entry.kind === "vacancy").schema_version = 1;
  const [cvAttempt] = steps.generate_cv.attempt_history;
  cvAttempt.input_snapshot.find((entry) => entry.kind === "application_brief").schema_version = 3;
  assert.deepEqual(validateLogV3(log), log);
});

test("a prepared running publication validates with its active-attempt baseline", () => {
  const log = createValidV3Log();
  fileBackedProcess(log).steps.generate_cv = createRunningPublicationStep();
  validateLogV3(log);
});

test("prepared publication metadata cannot drift from the active attempt", () => {
  const log = createValidV3Log();
  const running = createRunningPublicationStep();
  running.publication_transaction.attempt_id = "attempt_from_another_worker";
  fileBackedProcess(log).steps.generate_cv = running;
  assertInvalid(log, /publication_transaction\.attempt_id must match active_attempt\.id/);
});

test("file-backed committed bundles require a reserved output directory", () => {
  const log = createValidV3Log();
  fileBackedProcess(log).output_dir = null;
  assertInvalid(log, /output_dir is required once an artifact bundle is committed/);
});

test("output ownership rejects case- and Unicode-equivalent paths", () => {
  const log = createValidV3Log();
  log.processes[0].output_dir = "output/example-labs-senior-sdet";
  assertInvalid(log, /output_dir is Unicode\/case-equivalent/);
});

test("temporary-ledger validation never rewrites ledger bytes", (t) => {
  const ledgerPath = tempLedger(t, createValidV3Log());
  const before = readFileSync(ledgerPath, "utf8");
  readLogV3(ledgerPath);
  assert.equal(readFileSync(ledgerPath, "utf8"), before);
});

test("persisted diagnostics enforce exact UTF-8 bounds and one-line content", async (t) => {
  assert.equal(Object.isFrozen(processLogDiagnosticLimits), true);
  for (const pattern of [
    processLogStableDiagnosticCodePattern,
    processLogUppercaseCauseCodePattern,
  ]) {
    assert.equal(Object.isFrozen(pattern), true);
    assert.throws(() => pattern.compile(".*", "u"), TypeError);
  }
  assert.equal(processLogStableDiagnosticCodePattern.test("1code"), false);
  assert.equal(processLogUppercaseCauseCodePattern.test("eacces"), false);
  const exact = createValidV3Log();
  const exactStep = fileBackedProcess(exact).steps.generate_cv;
  const exactDiagnostic = exactStep.error;
  exactDiagnostic.code = "a".repeat(64);
  exactStep.attempt_history[0].error_code = exactDiagnostic.code;
  exactDiagnostic.message = utf8StringAtBytes(512);
  exactDiagnostic.details = Array.from(
    { length: 8 },
    (_, index) => utf8StringAtBytes(256, `Я${index}`),
  );
  validateLogV3(exact);
  const singleCharacterCode = createValidV3Log();
  const singleCodeStep = fileBackedProcess(singleCharacterCode).steps.generate_cv;
  singleCodeStep.error.code = "a";
  singleCodeStep.attempt_history[0].error_code = "a";
  validateLogV3(singleCharacterCode);
  for (const code of ["a1", "a_1"]) {
    const digitCode = createValidV3Log();
    const digitCodeStep = fileBackedProcess(digitCode).steps.generate_cv;
    digitCodeStep.error.code = code;
    digitCodeStep.attempt_history[0].error_code = code;
    validateLogV3(digitCode);
  }
  const validUnicode = createValidV3Log();
  fileBackedProcess(validUnicode).steps.generate_cv.error.details = [
    "valid pair 😀",
    "low minimum \ud800\udc00",
    "low maximum \ud800\udfff",
    "high maximum low minimum \udbff\udc00",
    "high maximum low maximum \udbff\udfff",
  ];
  validateLogV3(validUnicode);

  const cases = [
    {
      id: "code_65_bytes",
      mutate: (diagnostic, step) => {
        diagnostic.code = "a".repeat(65);
        step.attempt_history[0].error_code = diagnostic.code;
      },
      pattern: /processes\[1\]\.steps\.generate_cv\.error\.code must be at most 64 UTF-8 bytes/,
    },
    ...[
      ["code_leading_digit", "1code"],
      ["code_trailing_underscore", "code_"],
      ["code_double_underscore", "code__part"],
      ["code_uppercase_body", "aB"],
      ["code_uppercase_segment", "a_B"],
    ].map(([id, value]) => ({
      id,
      mutate: (diagnostic, step) => {
        diagnostic.code = value;
        step.attempt_history[0].error_code = value;
      },
      pattern: /processes\[1\]\.steps\.generate_cv\.error\.code must be a lowercase snake_case stable code/,
    })),
    {
      id: "history_error_code_65_bytes",
      mutate: (_diagnostic, step) => {
        step.attempt_history[0].error_code = "a".repeat(65);
      },
      pattern: /processes\[1\]\.steps\.generate_cv\.attempt_history\[0\]\.error_code must be at most 64 UTF-8 bytes/,
    },
    {
      id: "history_error_code_100_kib",
      mutate: (_diagnostic, step) => {
        step.attempt_history[0].error_code = "a".repeat(100 * 1024);
      },
      pattern: /processes\[1\]\.steps\.generate_cv\.attempt_history\[0\]\.error_code must be at most 64 UTF-8 bytes/,
    },
    {
      id: "message_513_bytes",
      mutate: (diagnostic) => { diagnostic.message = utf8StringAtBytes(513); },
      pattern: /processes\[1\]\.steps\.generate_cv\.error\.message must be at most 512 UTF-8 bytes/,
    },
    {
      id: "message_100_kib",
      mutate: (diagnostic) => { diagnostic.message = `Ошибка ${"x".repeat(100 * 1024)}`; },
      pattern: /processes\[1\]\.steps\.generate_cv\.error\.message must be at most 512 UTF-8 bytes/,
    },
    {
      id: "details_9_items",
      mutate: (diagnostic) => { diagnostic.details = Array(9).fill("bounded detail"); },
      pattern: /processes\[1\]\.steps\.generate_cv\.error\.details must contain at most 8 item\(s\)/,
    },
    {
      id: "detail_257_bytes",
      mutate: (diagnostic) => { diagnostic.details = ["a".repeat(257)]; },
      pattern: /processes\[1\]\.steps\.generate_cv\.error\.details\[0\] must be at most 256 UTF-8 bytes/,
    },
    {
      id: "message_multiline",
      mutate: (diagnostic) => { diagnostic.message = "Ошибка содержит\nвторую строку."; },
      pattern: /processes\[1\]\.steps\.generate_cv\.error\.message must be one-line text without control characters/,
    },
    {
      id: "detail_control_character",
      mutate: (diagnostic) => { diagnostic.details = ["synthetic\u0000detail"]; },
      pattern: /processes\[1\]\.steps\.generate_cv\.error\.details\[0\] must be one-line text without control characters/,
    },
    ...[
      ["message_carriage_return", "Ошибка\rвозврата."],
      ["message_c0_upper_boundary", "Ошибка\u001fпродолжения."],
      ["message_del_boundary", "Ошибка\u007fпродолжения."],
      ["message_c1_control", "Ошибка\u0085продолжения."],
      ["message_c1_upper_boundary", "Ошибка\u009fпродолжения."],
      ["message_line_separator", "Ошибка\u2028продолжения."],
      ["message_paragraph_separator", "Ошибка\u2029продолжения."],
    ].map(([id, value]) => ({
      id,
      mutate: (diagnostic) => { diagnostic.message = value; },
      pattern: /processes\[1\]\.steps\.generate_cv\.error\.message must be one-line text without control characters/,
    })),
    {
      id: "message_unpaired_high_surrogate",
      mutate: (diagnostic) => { diagnostic.message = "Ошибка \ud800"; },
      pattern: /processes\[1\]\.steps\.generate_cv\.error\.message must contain valid Unicode scalar text/,
    },
    {
      id: "message_unpaired_low_surrogate",
      mutate: (diagnostic) => { diagnostic.message = "Ошибка \udc00"; },
      pattern: /processes\[1\]\.steps\.generate_cv\.error\.message must contain valid Unicode scalar text/,
    },
    {
      id: "message_unpaired_high_surrogate_max",
      mutate: (diagnostic) => { diagnostic.message = "Ошибка \udbff"; },
      pattern: /processes\[1\]\.steps\.generate_cv\.error\.message must contain valid Unicode scalar text/,
    },
    {
      id: "message_unpaired_low_surrogate_max",
      mutate: (diagnostic) => { diagnostic.message = "Ошибка \udfff"; },
      pattern: /processes\[1\]\.steps\.generate_cv\.error\.message must contain valid Unicode scalar text/,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.id, () => {
      const log = createValidV3Log();
      const step = fileBackedProcess(log).steps.generate_cv;
      fixture.mutate(step.error, step);
      assertInvalid(log, fixture.pattern);
    });
  }
});

test("a persisted message explains rather than repeating the code, in any script", () => {
  // The engine writes its messages in the default language, so a Latin-only message is ordinary
  // and must validate. It could not before: the validator demanded a Cyrillic letter.
  const english = createValidV3Log();
  const englishStep = fileBackedProcess(english).steps.generate_cv;
  englishStep.error.code = "render_failed";
  englishStep.attempt_history[0].error_code = "render_failed";
  englishStep.error.message = "The renderer could not produce the document.";
  validateLogV3(english);

  // An already-recorded row keeps validating whatever script it was written in: the constraint was
  // widened, not inverted, so no ledger needs rewriting.
  const legacy = createValidV3Log();
  fileBackedProcess(legacy).steps.generate_cv.error.message = "Не удалось отрисовать документ.";
  validateLogV3(legacy);

  // What the old rule forbade only by accident - a code is ASCII, so a Cyrillic message could never
  // equal it - is now said outright. A message that is the code again explains nothing.
  const echo = createValidV3Log();
  const echoStep = fileBackedProcess(echo).steps.generate_cv;
  echoStep.error.code = "render_failed";
  echoStep.attempt_history[0].error_code = "render_failed";
  echoStep.error.message = "render_failed";
  assertInvalid(
    echo,
    /processes\[1\]\.steps\.generate_cv\.error\.message must explain the diagnostic, not repeat processes\[1\]\.steps\.generate_cv\.error\.code/,
  );
});

test("persisted diagnostics reject every frozen forbidden shape and preserve safe near-misses", async (t) => {
  assert.deepEqual(
    processLogDiagnosticForbiddenShapeIds,
    EXPECTED_DIAGNOSTIC_FORBIDDEN_SHAPES,
  );
  assert.deepEqual(
    DECLARED_DIAGNOSTIC_FORBIDDEN_SHAPES.map(([id]) => id).sort(),
    [...EXPECTED_DIAGNOSTIC_FORBIDDEN_SHAPES].sort(),
  );

  for (const [id, value] of DECLARED_DIAGNOSTIC_FORBIDDEN_SHAPES) {
    await t.test(id, async (shapeTest) => {
      let executedFields = 0;
      for (const field of ["message", "details[0]"]) {
        await shapeTest.test(field, () => {
          const log = createValidV3Log();
          const diagnostic = fileBackedProcess(log).steps.generate_cv.error;
          if (field === "message") diagnostic.message = `Ошибка: ${value}`;
          else diagnostic.details = [value];
          assertInvalid(
            log,
            new RegExp(
              `processes\\[1\\]\\.steps\\.generate_cv\\.error\\.${field === "message" ? "message" : "details\\[0\\]"}.*${id}`,
            ),
          );
          executedFields += 1;
        });
      }
      if (executedFields === 2) executedDiagnosticShapes.add(id);
    });
  }

  for (const [variantId, shapeId, value] of DECLARED_DIAGNOSTIC_FORBIDDEN_VARIANTS) {
    await t.test(variantId, async (variantTest) => {
      let executedFields = 0;
      for (const field of ["message", "details[0]"]) {
        await variantTest.test(field, () => {
          const log = createValidV3Log();
          const diagnostic = fileBackedProcess(log).steps.generate_cv.error;
          if (field === "message") diagnostic.message = `Ошибка: ${value}`;
          else diagnostic.details = [value];
          assertInvalid(
            log,
            new RegExp(
              `processes\\[1\\]\\.steps\\.generate_cv\\.error\\.${field === "message" ? "message" : "details\\[0\\]"}.*${shapeId}`,
            ),
          );
          executedFields += 1;
        });
      }
      if (executedFields === 2) executedDiagnosticVariants.add(variantId);
    });
  }

  const nearMisses = [
    "protocol https is unavailable",
    "output/example-labs-senior-sdet",
    "drive C is unavailable",
    "network share unavailable",
    "at operator checkpoint",
    "api key is configured",
    "Bearer auth disabled",
    "private key marker absent",
    "sk prefix documented",
    "ghp prefix documented",
    "xoxb prefix documented",
    "AKIA prefix documented",
    "filesystem error code: EACCES",
    "publication_fixture_0123456789",
    "operator token confirmed",
    "Bearer abcdefg",
    "secret=abc",
    "ASIAABCDEFGHIJK",
    "ghp_abcdefg",
    "sk-abcdefg",
    "xoxb-abcdefg",
    "http://",
    "/",
    "\\\\server\\",
    "C:\\",
  ];
  for (const value of nearMisses) {
    for (const field of ["message", "details"]) {
      const log = createValidV3Log();
      const diagnostic = fileBackedProcess(log).steps.generate_cv.error;
      if (field === "message") diagnostic.message = `Ошибка: ${value}`;
      else diagnostic.details = [value];
      validateLogV3(log);
    }
  }

  const laterDetail = createValidV3Log();
  fileBackedProcess(laterDetail).steps.generate_cv.error.details = [
    "safe first diagnostic detail",
    "Bearer abcdefgh",
  ];
  assertInvalid(
    laterDetail,
    /error\.details\[1\].*bearer_token/,
  );
});

test("diagnostic forbidden-shape inventory matches expected, declared, and executed cases", () => {
  const declaredIds = DECLARED_DIAGNOSTIC_FORBIDDEN_SHAPES.map(([id]) => id);
  const declaredSet = new Set(declaredIds);
  assert.equal(declaredSet.size, declaredIds.length);
  assert.deepEqual(
    EXPECTED_DIAGNOSTIC_FORBIDDEN_SHAPES.filter((id) => !declaredSet.has(id)),
    [],
  );
  assert.deepEqual(
    declaredIds.filter((id) => !EXPECTED_DIAGNOSTIC_FORBIDDEN_SHAPES.includes(id)),
    [],
  );
  assert.deepEqual(
    [...executedDiagnosticShapes].sort(),
    [...declaredSet].sort(),
  );
  const declaredVariantIds = DECLARED_DIAGNOSTIC_FORBIDDEN_VARIANTS.map(([id]) => id);
  const declaredVariantSet = new Set(declaredVariantIds);
  assert.equal(declaredVariantSet.size, declaredVariantIds.length);
  assert.deepEqual(
    [...EXPECTED_DIAGNOSTIC_FORBIDDEN_VARIANTS].sort(),
    [...declaredVariantSet].sort(),
  );
  assert.deepEqual(
    [...executedDiagnosticVariants].sort(),
    [...declaredVariantSet].sort(),
  );
});

test("future-skew ceiling accepts exactly five minutes and rejects the next millisecond", (t) => {
  assert.equal(PROCESS_LOG_FUTURE_SKEW_MS, 300_000);
  const nowMs = Date.parse("2026-07-23T12:30:00.000Z");
  t.mock.method(Date, "now", () => nowMs);
  const exact = createValidV3Log();
  exact.updated_at = "2026-07-23T12:35:00.000Z";
  validateLogV3(exact);

  const beyond = createValidV3Log();
  beyond.updated_at = "2026-07-23T12:35:00.001Z";
  assert.throws(
    () => validateLogV3(beyond),
    /updated_at must not be more than 300000 ms in the future/,
  );
  assert.throws(
    () => validateLogV3(beyond, { nowMs: Date.parse("2030-01-01T00:00:00.000Z") }),
    /updated_at must not be more than 300000 ms in the future/,
  );
});

test("future-skew validation covers every declared timestamp owner", async (t) => {
  const nowMs = Date.parse("2026-07-23T12:30:00.000Z");
  const future = "2026-07-23T12:35:00.001Z";
  t.mock.method(Date, "now", () => nowMs);
  const cases = [
    {
      id: "root.updated_at",
      mutate(log) { log.updated_at = future; },
      path: "updated_at",
    },
    {
      id: "historical.started_at",
      mutate(log) { log.processes[0].started_at = future; },
      path: "processes[0].started_at",
    },
    {
      id: "process.started_at",
      mutate(log) { fileBackedProcess(log).started_at = future; },
      path: "processes[1].started_at",
    },
    {
      id: "process.updated_at",
      mutate(log) { fileBackedProcess(log).updated_at = future; },
      path: "processes[1].updated_at",
    },
    {
      id: "step.started_at",
      mutate(log) { fileBackedProcess(log).steps.generate_cv.started_at = future; },
      path: "processes[1].steps.generate_cv.started_at",
    },
    {
      id: "step.updated_at",
      mutate(log) { fileBackedProcess(log).steps.generate_cv.updated_at = future; },
      path: "processes[1].steps.generate_cv.updated_at",
    },
    {
      id: "step.finished_at",
      mutate(log) { fileBackedProcess(log).steps.generate_cv.finished_at = future; },
      path: "processes[1].steps.generate_cv.finished_at",
    },
    {
      id: "attempt_history.started_at",
      mutate(log) {
        fileBackedProcess(log).steps.generate_cv.attempt_history[0].started_at = future;
      },
      path: "processes[1].steps.generate_cv.attempt_history[0].started_at",
    },
    {
      id: "attempt_history.finished_at",
      mutate(log) {
        fileBackedProcess(log).steps.generate_cv.attempt_history[0].finished_at = future;
      },
      path: "processes[1].steps.generate_cv.attempt_history[0].finished_at",
    },
    {
      id: "active_attempt.started_at",
      mutate(log) {
        const running = createRunningPublicationStep();
        running.active_attempt.started_at = future;
        fileBackedProcess(log).steps.generate_cv = running;
      },
      path: "processes[1].steps.generate_cv.active_attempt.started_at",
    },
    {
      id: "publication_transaction.prepared_at",
      mutate(log) {
        const running = createRunningPublicationStep();
        running.publication_transaction.prepared_at = future;
        fileBackedProcess(log).steps.generate_cv = running;
      },
      path: "processes[1].steps.generate_cv.publication_transaction.prepared_at",
    },
    {
      id: "publication_transaction.blocker.at",
      mutate(log) {
        const running = createRunningPublicationStep();
        running.publication_transaction.intended_outcome = "blocked";
        running.publication_transaction.blocker = {
          code: "future_prepared_blocker",
          message: "A future blocker on a prepared publication is refused.",
          at: future,
          retryable: true,
          details: [],
        };
        fileBackedProcess(log).steps.generate_cv = running;
      },
      path: "processes[1].steps.generate_cv.publication_transaction.blocker.at",
    },
    {
      id: "diagnostic.error.at",
      mutate(log) { fileBackedProcess(log).steps.generate_cv.error.at = future; },
      path: "processes[1].steps.generate_cv.error.at",
    },
    {
      id: "diagnostic.blocker.at",
      mutate(log) {
        fileBackedProcess(log).steps.get_vacancy.blocker = {
          code: "future_blocker",
          message: "A future blocker instant is refused.",
          at: future,
          retryable: true,
          details: [],
        };
      },
      path: "processes[1].steps.get_vacancy.blocker.at",
    },
  ];
  const declaredIds = cases.map(({ id }) => id);
  const declaredSet = new Set(declaredIds);
  assert.equal(declaredSet.size, declaredIds.length);
  assert.deepEqual(
    EXPECTED_FUTURE_TIMESTAMP_PATHS.filter((id) => !declaredSet.has(id)),
    [],
  );
  assert.deepEqual(
    declaredIds.filter((id) => !EXPECTED_FUTURE_TIMESTAMP_PATHS.includes(id)),
    [],
  );

  for (const fixture of cases) {
    await t.test(fixture.id, () => {
      const log = createValidV3Log();
      fixture.mutate(log);
      assert.throws(
        () => validateLogV3(log),
        new RegExp(`${fixture.path.replaceAll(/[.\[\]]/g, "\\$&")} must not be more than 300000 ms in the future`),
      );
      executedFutureTimestampPaths.add(fixture.id);
    });
  }
});

test("future timestamp inventory matches expected, declared, and executed legs", () => {
  assert.deepEqual(
    [...executedFutureTimestampPaths].sort(),
    [...EXPECTED_FUTURE_TIMESTAMP_PATHS].sort(),
  );
});

test("file-backed chronology rejects every frozen causal-edge violation", async (t) => {
  function runningRetry(log) {
    const step = fileBackedProcess(log).steps.generate_cv;
    step.state = "running";
    step.attempt = 2;
    step.started_at = "2026-07-23T11:40:00.000Z";
    step.updated_at = step.started_at;
    step.finished_at = null;
    step.active_attempt = {
      id: "attempt_generate_cv_retry_002",
      started_at: step.started_at,
      expected_revision: 0,
      expected_artifacts: [],
      input_snapshot: structuredClone(step.attempt_history[0].input_snapshot),
    };
    step.error = null;
    return step;
  }

  function blockedTerminal(log) {
    const step = fileBackedProcess(log).steps.generate_cv;
    step.state = "blocked";
    step.attempt_history[0].outcome = "blocked";
    step.attempt_history[0].error_code = "render_blocked";
    step.error = null;
    step.blocker = {
      code: "render_blocked",
      message: "The publication is blocked by a synthetic check.",
      at: step.finished_at,
      retryable: true,
      details: [],
    };
    return step;
  }

  const cases = [
    {
      id: "historical_start_after_root",
      mutate(log) { log.processes[0].started_at = "2026-07-23T12:30:00.001Z"; },
      pattern: /processes\[0\]\.started_at must not be after updated_at/,
    },
    {
      id: "process_start_before_update",
      mutate(log) { fileBackedProcess(log).started_at = "2026-07-23T12:31:00.000Z"; },
      pattern: /processes\[1\]\.started_at must not be after processes\[1\]\.updated_at/,
    },
    {
      id: "root_after_process_update",
      mutate(log) { log.updated_at = "2026-07-23T12:29:59.999Z"; },
      pattern: /processes\[1\]\.updated_at must not be after updated_at/,
    },
    {
      id: "process_start_before_step",
      mutate(log) {
        const step = fileBackedProcess(log).steps.get_vacancy;
        step.started_at = "2026-07-23T09:59:59.999Z";
        step.attempt_history[0].started_at = step.started_at;
      },
      pattern: /steps\.get_vacancy\.started_at must not be before processes\[1\]\.started_at/,
    },
    {
      id: "step_start_before_update",
      mutate(log) {
        const step = fileBackedProcess(log).steps.generate_cv;
        step.started_at = "2026-07-23T11:36:00.000Z";
      },
      pattern: /steps\.generate_cv\.started_at must not be after processes\[1\]\.steps\.generate_cv\.updated_at/,
    },
    {
      id: "step_updated_within_process",
      mutate(log) {
        const process = fileBackedProcess(log);
        process.steps.generate_cv.updated_at =
          new Date(Date.parse(process.updated_at) + 1).toISOString();
      },
      pattern: /steps\.generate_cv\.updated_at must not be after processes\[1\]\.updated_at/,
    },
    {
      id: "step_finish_before_update",
      mutate(log) {
        fileBackedProcess(log).steps.generate_cv.updated_at = "2026-07-23T11:34:59.999Z";
      },
      pattern: /steps\.generate_cv\.finished_at must not be after processes\[1\]\.steps\.generate_cv\.updated_at/,
    },
    {
      id: "step_start_before_finish",
      mutate(log) {
        fileBackedProcess(log).steps.generate_cv.started_at = "2026-07-23T11:36:00.000Z";
      },
      pattern: /steps\.generate_cv\.started_at must not be after processes\[1\]\.steps\.generate_cv\.finished_at/,
    },
    {
      id: "history_start_before_finish",
      mutate(log) {
        fileBackedProcess(log).steps.generate_cv.attempt_history[0].started_at =
          "2026-07-23T11:36:00.000Z";
      },
      pattern: /attempt_history\[0\]\.started_at must not be after .*attempt_history\[0\]\.finished_at/,
    },
    {
      id: "history_start_within_process",
      mutate(log) {
        const process = fileBackedProcess(log);
        const step = process.steps.generate_cv;
        const second = structuredClone(step.attempt_history[0]);
        second.attempt = 2;
        step.attempt = 2;
        step.attempt_history.push(second);
        step.attempt_history[0].started_at =
          new Date(Date.parse(process.started_at) - 1).toISOString();
        step.attempt_history[0].finished_at = process.started_at;
      },
      pattern: /attempt_history\[0\]\.started_at must not be before processes\[1\]\.started_at/,
    },
    {
      id: "history_attempt_order",
      mutate(log) {
        const step = fileBackedProcess(log).steps.generate_cv;
        const second = structuredClone(step.attempt_history[0]);
        second.attempt = 2;
        second.started_at = "2026-07-23T11:34:00.000Z";
        second.finished_at = "2026-07-23T11:36:00.000Z";
        step.attempt = 2;
        step.started_at = second.started_at;
        step.updated_at = second.finished_at;
        step.finished_at = second.finished_at;
        step.attempt_history.push(second);
        step.error.at = second.finished_at;
      },
      pattern: /attempt_history\[1\]\.started_at must not be before .*attempt_history\[0\]\.finished_at/,
    },
    {
      id: "active_after_previous_attempt",
      mutate(log) {
        const step = runningRetry(log);
        step.started_at = "2026-07-23T11:34:00.000Z";
        step.updated_at = step.started_at;
        step.active_attempt.started_at = step.started_at;
      },
      pattern: /active_attempt\.started_at must not be before .*attempt_history\[0\]\.finished_at/,
    },
    {
      id: "active_matches_step_start",
      mutate(log) {
        const step = runningRetry(log);
        step.active_attempt.started_at = "2026-07-23T11:39:59.999Z";
      },
      pattern: /active_attempt\.started_at must equal processes\[1\]\.steps\.generate_cv\.started_at/,
    },
    {
      id: "prepared_after_active",
      mutate(log) {
        const step = createRunningPublicationStep();
        step.publication_transaction.prepared_at = "2026-07-23T11:29:59.999Z";
        fileBackedProcess(log).steps.generate_cv = step;
      },
      pattern: /publication_transaction\.prepared_at must not be before .*active_attempt\.started_at/,
    },
    {
      id: "prepared_within_process",
      mutate(log) {
        const step = createRunningPublicationStep();
        step.publication_transaction.prepared_at = "2026-07-23T12:30:00.001Z";
        fileBackedProcess(log).steps.generate_cv = step;
      },
      pattern: /publication_transaction\.prepared_at must not be after processes\[1\]\.updated_at/,
    },
    {
      id: "prepared_blocker_matches_prepare",
      mutate(log) {
        const step = createRunningPublicationStep();
        step.publication_transaction.intended_outcome = "blocked";
        step.publication_transaction.blocker = {
          code: "prepared_blocker",
          message: "The prepared publication's blocker carries an exact instant.",
          at: "2026-07-23T11:31:59.999Z",
          retryable: true,
          details: [],
        };
        fileBackedProcess(log).steps.generate_cv = step;
      },
      pattern: /publication_transaction\.blocker\.at must equal .*publication_transaction\.prepared_at/,
    },
    {
      id: "diagnostic_matches_finish",
      mutate(log) {
        fileBackedProcess(log).steps.generate_cv.error.at = "2026-07-23T11:34:59.999Z";
      },
      pattern: /steps\.generate_cv\.error\.at must equal processes\[1\]\.steps\.generate_cv\.finished_at/,
    },
    {
      id: "blocker_matches_finish",
      mutate(log) {
        const step = blockedTerminal(log);
        step.blocker.at = "2026-07-23T11:34:59.999Z";
      },
      pattern: /steps\.generate_cv\.blocker\.at must equal processes\[1\]\.steps\.generate_cv\.finished_at/,
    },
    {
      id: "terminal_history_matches_step",
      mutate(log) {
        fileBackedProcess(log).steps.generate_cv.started_at = "2026-07-23T11:30:00.001Z";
      },
      pattern: /steps\.generate_cv\.started_at must equal .*attempt_history\[0\]\.started_at/,
    },
    {
      id: "terminal_history_finish_matches_step",
      mutate(log) {
        fileBackedProcess(log).steps.generate_cv.finished_at = "2026-07-23T11:35:00.001Z";
        fileBackedProcess(log).steps.generate_cv.updated_at = "2026-07-23T11:35:00.001Z";
        fileBackedProcess(log).steps.generate_cv.error.at = "2026-07-23T11:35:00.001Z";
      },
      pattern: /steps\.generate_cv\.finished_at must equal .*attempt_history\[0\]\.finished_at/,
    },
    {
      id: "terminal_history_matches_step_blocked",
      mutate(log) {
        const step = blockedTerminal(log);
        step.started_at = "2026-07-23T11:30:00.001Z";
      },
      pattern: /steps\.generate_cv\.started_at must equal .*attempt_history\[0\]\.started_at/,
    },
    {
      id: "terminal_history_matches_step_completed",
      mutate(log) {
        fileBackedProcess(log).steps.write_cover_letter.started_at =
          "2026-07-23T12:00:00.001Z";
      },
      pattern: /steps\.write_cover_letter\.started_at must equal .*attempt_history\[0\]\.started_at/,
    },
    {
      id: "terminal_history_matches_step_stale",
      mutate(log) {
        const step = fileBackedProcess(log).steps.write_cover_letter;
        step.state = "stale";
        step.started_at = "2026-07-23T12:00:00.001Z";
      },
      pattern: /steps\.write_cover_letter\.started_at must equal .*attempt_history\[0\]\.started_at/,
    },
  ];

  const declaredIds = cases.map(({ id }) => id);
  const declaredSet = new Set(declaredIds);
  assert.equal(declaredSet.size, declaredIds.length);
  assert.deepEqual(
    EXPECTED_CHRONOLOGY_CASES.filter((id) => !declaredSet.has(id)),
    [],
  );
  assert.deepEqual(
    declaredIds.filter((id) => !EXPECTED_CHRONOLOGY_CASES.includes(id)),
    [],
  );
  for (const fixture of cases) {
    await t.test(fixture.id, () => {
      executedChronologyCases.add(fixture.id);
      const log = createValidV3Log();
      fixture.mutate(log);
      assertInvalid(log, fixture.pattern);
    });
  }
});

test("current dependency edges require upstream completion before downstream start", async (t) => {
  assert.equal(Object.isFrozen(fileBackedStepDependencies), true);
  assert.deepEqual(Object.keys(fileBackedStepDependencies), fileBackedStepNames);
  for (const dependencies of Object.values(fileBackedStepDependencies)) {
    assert.equal(Object.isFrozen(dependencies), true);
  }
  const cases = [
    {
      id: "get_vacancy=>research_company",
      downstream: "research_company",
      upstream: "get_vacancy",
      startedAt: "2026-07-23T10:09:59.999Z",
    },
    {
      id: "research_company=>map_experience",
      downstream: "map_experience",
      upstream: "research_company",
      startedAt: "2026-07-23T10:39:59.999Z",
    },
    {
      id: "map_experience=>generate_cv",
      downstream: "generate_cv",
      upstream: "map_experience",
      startedAt: "2026-07-23T11:19:59.999Z",
    },
    {
      id: "map_experience=>write_cover_letter",
      downstream: "write_cover_letter",
      upstream: "map_experience",
      startedAt: "2026-07-23T11:19:59.999Z",
    },
  ];
  const declaredIds = cases.map(({ id }) => id);
  const declaredSet = new Set(declaredIds);
  assert.equal(declaredSet.size, declaredIds.length);
  assert.deepEqual(
    EXPECTED_DEPENDENCY_EDGES.filter((id) => !declaredSet.has(id)),
    [],
  );
  assert.deepEqual(
    declaredIds.filter((id) => !EXPECTED_DEPENDENCY_EDGES.includes(id)),
    [],
  );
  for (const fixture of cases) {
    await t.test(fixture.id, () => {
      const log = createValidV3Log();
      const steps = fileBackedProcess(log).steps;
      steps[fixture.downstream].started_at = fixture.startedAt;
      steps[fixture.downstream].attempt_history[0].started_at = fixture.startedAt;
      assertInvalid(
        log,
        new RegExp(
          `steps\\.${fixture.downstream}\\.started_at must not be before processes\\[1\\]\\.steps\\.${fixture.upstream}\\.finished_at`,
        ),
      );
      const incomplete = createValidV3Log();
      const incompleteDependency =
        fileBackedProcess(incomplete).steps[fixture.upstream];
      incompleteDependency.state = "failed";
      incompleteDependency.revision = 0;
      incompleteDependency.published_inputs = [];
      incompleteDependency.artifacts = [];
      incompleteDependency.attempt_history[0].outcome = "failed";
      incompleteDependency.attempt_history[0].error_code = "synthetic_failure";
      incompleteDependency.attempt_history[0].publication_id = null;
      incompleteDependency.error = {
        code: "synthetic_failure",
        message: "A synthetic dependency was never completed.",
        at: incompleteDependency.finished_at,
        retryable: true,
        details: [],
      };
      assertInvalid(
        incomplete,
        new RegExp(
          `steps\.${fixture.upstream}\.attempt_history must contain a completed attempt no later than processes\\[1\\]\.steps\.${fixture.downstream}\.started_at`,
        ),
      );

      const historicalGreen = createValidV3Log();
      fileBackedProcess(historicalGreen).steps[fixture.upstream].state = "stale";
      validateLogV3(historicalGreen);

      const historicalBoundary = createValidV3Log();
      const boundarySteps = fileBackedProcess(historicalBoundary).steps;
      boundarySteps[fixture.upstream].state = "stale";
      const dependencyFinishedAt =
        boundarySteps[fixture.upstream].attempt_history.at(-1).finished_at;
      boundarySteps[fixture.downstream].started_at = dependencyFinishedAt;
      boundarySteps[fixture.downstream].attempt_history[0].started_at = dependencyFinishedAt;
      validateLogV3(historicalBoundary);

      const historicalLate = createValidV3Log();
      const historicalSteps = fileBackedProcess(historicalLate).steps;
      historicalSteps[fixture.upstream].state = "stale";
      historicalSteps[fixture.downstream].started_at = fixture.startedAt;
      historicalSteps[fixture.downstream].attempt_history[0].started_at = fixture.startedAt;
      assertInvalid(
        historicalLate,
        new RegExp(
          `steps\.${fixture.upstream}\.attempt_history must contain a completed attempt no later than processes\\[1\\]\.steps\.${fixture.downstream}\.started_at`,
        ),
      );
      executedDependencyEdges.add(fixture.id);
    });
  }
});

test("dependency-edge inventory matches expected, declared, and executed legs", () => {
  assert.deepEqual(
    [...executedDependencyEdges].sort(),
    [...EXPECTED_DEPENDENCY_EDGES].sort(),
  );
});

test("chronology compares ISO offsets by instant instead of lexicographically", () => {
  const log = createValidV3Log();
  const step = fileBackedProcess(log).steps.generate_cv;
  step.started_at = "2026-07-23T13:30:00.000+02:00";
  step.attempt_history[0].started_at = "2026-07-23T13:30:00.000+02:00";
  validateLogV3(log);

  const invalid = createValidV3Log();
  const invalidStep = fileBackedProcess(invalid).steps.generate_cv;
  invalidStep.started_at = "2026-07-23T10:36:00.000-01:00";
  invalidStep.attempt_history[0].started_at = "2026-07-23T10:36:00.000-01:00";
  assertInvalid(
    invalid,
    /steps\.generate_cv\.started_at must not be after processes\[1\]\.steps\.generate_cv\.finished_at/,
  );
});

test("chronology inventory matches expected, declared, and executed cases", () => {
  assert.deepEqual(
    [...executedChronologyCases].sort(),
    [...EXPECTED_CHRONOLOGY_CASES].sort(),
  );
});

function letterStep(log) {
  return fileBackedProcess(log).steps.write_cover_letter;
}

/*
 * Turns the fixture's completed letter step into one with an open, non-revision attempt — the
 * shape a first publication of the letter has while it is running.
 */
function openRunningLetterAttempt(log) {
  const step = letterStep(log);
  const committed = step.attempt_history.at(-1);
  step.state = "running";
  step.attempt += 1;
  step.finished_at = null;
  step.error = null;
  step.blocker = null;
  step.started_at = committed.finished_at;
  step.updated_at = committed.finished_at;
  step.active_attempt = {
    id: "attempt_first_publication",
    started_at: committed.finished_at,
    expected_revision: step.revision,
    expected_artifacts: structuredClone(step.artifacts),
    input_snapshot: structuredClone(step.published_inputs),
  };
  return step.active_attempt;
}

function validWaiver(overrides = {}) {
  return {
    id: "waiver_0001",
    created_at: "2026-07-23T12:00:00.000Z",
    brief_digest: "1".repeat(64),
    subject: { kind: "check", key: "letter_keyword:0" },
    status: "active",
    ...overrides,
  };
}

test("v4 revision fields are material-step-only and shape-checked", () => {
  const valid = createValidV3Log();
  const validLetter = letterStep(valid);
  validLetter.waivers = [
    validWaiver(),
    validWaiver({
      id: "waiver_0002",
      status: "superseded",
      note: "Пользователь принял риск после ревью.",
    }),
  ];
  validLetter.attempt_history.at(-1).archived_artifacts =
    structuredClone(validLetter.artifacts);
  validateLogV3(valid);

  const nonMaterialWaivers = createValidV3Log();
  fileBackedProcess(nonMaterialWaivers).steps.map_experience.waivers = [];
  assertInvalid(
    nonMaterialWaivers,
    /steps\.map_experience contains unknown key: waivers/,
  );

  const nonMaterialAdoption = createValidV3Log();
  fileBackedProcess(nonMaterialAdoption).steps.map_experience.adoption_base = null;
  assertInvalid(
    nonMaterialAdoption,
    /steps\.map_experience contains unknown key: adoption_base/,
  );

  const badStatus = createValidV3Log();
  letterStep(badStatus).waivers = [validWaiver({ status: "revoked" })];
  assertInvalid(badStatus, /waivers\[0\]\.status must be one of/);

  const badKind = createValidV3Log();
  letterStep(badKind).waivers = [
    validWaiver({ subject: { kind: "veto", key: "letter_keyword:0" } }),
  ];
  assertInvalid(badKind, /waivers\[0\]\.subject\.kind must be one of/);

  const duplicateIds = createValidV3Log();
  letterStep(duplicateIds).waivers = [validWaiver(), validWaiver()];
  assertInvalid(duplicateIds, /waivers\[1\]\.id is duplicated/);

  const oversizedKey = createValidV3Log();
  letterStep(oversizedKey).waivers = [
    validWaiver({ subject: { kind: "check", key: "x".repeat(300) } }),
  ];
  assertInvalid(
    oversizedKey,
    /waivers\[0\]\.subject\.key must be at most 256 UTF-8 bytes/,
  );

  const hostileNote = createValidV3Log();
  letterStep(hostileNote).waivers = [
    validWaiver({ note: "see https://hostile.example.test/leak" }),
  ];
  assertInvalid(
    hostileNote,
    /waivers\[0\]\.note contains forbidden diagnostic shape: url/,
  );

  const conflictWithoutOperation = createValidV3Log();
  letterStep(conflictWithoutOperation).attempt_history.at(-1).open_conflicts = [];
  assertInvalid(
    conflictWithoutOperation,
    /open_conflicts requires operation "revise"/,
  );

  /*
   * The edit channel and the pre-attempt mark belong to the revision operation; the pending waiver
   * set belongs to the attempt, because a first publication of the letter carries the word-limit
   * approval the same way (task 145).
   */
  const plainAttempt = createValidV3Log();
  const plainLetter = openRunningLetterAttempt(plainAttempt);
  plainLetter.pending_waivers = [{
    id: "waiver_0002",
    brief_digest: "2".repeat(64),
    subject: { kind: "check", key: "letter_body_words_max:280" },
  }];
  validateLogV3(plainAttempt);
  plainLetter.pending_waivers[0].brief_digest = "not-a-digest";
  assertInvalid(plainAttempt, /pending_waivers\[0\]\.brief_digest must be a lowercase hexadecimal SHA-256 digest/);
  plainLetter.pending_waivers[0].brief_digest = "2".repeat(64);
  plainLetter.channel = "chat_command";
  assertInvalid(plainAttempt, /channel requires operation "revise"/);
  delete plainLetter.channel;
  plainLetter.pre_attempt_state = "completed";
  assertInvalid(plainAttempt, /pre_attempt_state requires operation "revise"/);

  // The relaxation is scoped to the two generation steps: the pending set is still an unknown
  // key on every other step's attempt.
  const pendingOnUpstream = createValidV3Log();
  fileBackedProcess(pendingOnUpstream).steps.get_vacancy.active_attempt = {
    id: "attempt_upstream",
    started_at: "2026-07-23T12:00:00.000Z",
    expected_revision: 1,
    expected_artifacts: [],
    input_snapshot: [],
    pending_waivers: [],
  };
  assertInvalid(
    pendingOnUpstream,
    /get_vacancy\.active_attempt contains unknown key: pending_waivers/,
  );

  const archiveWithoutPublication = createValidV3Log();
  const failedCv = fileBackedProcess(archiveWithoutPublication).steps.generate_cv;
  failedCv.attempt_history.at(-1).archived_artifacts = [];
  assertInvalid(
    archiveWithoutPublication,
    /archived_artifacts requires a committed publication/,
  );

  const incompleteArchive = createValidV3Log();
  letterStep(incompleteArchive).attempt_history.at(-1).archived_artifacts = [];
  assertInvalid(
    incompleteArchive,
    /archived_artifacts must contain the complete write_cover_letter artifact bundle/,
  );

  const pendingClash = createValidV3Log();
  const clashLetter = letterStep(pendingClash);
  clashLetter.waivers = [validWaiver()];
  const clashCommitted = clashLetter.attempt_history.at(-1);
  clashLetter.state = "running";
  clashLetter.attempt += 1;
  clashLetter.finished_at = null;
  clashLetter.error = null;
  clashLetter.blocker = null;
  clashLetter.started_at = clashCommitted.finished_at;
  clashLetter.updated_at = clashCommitted.finished_at;
  clashLetter.active_attempt = {
    id: "attempt_pending_clash",
    started_at: clashCommitted.finished_at,
    expected_revision: clashLetter.revision,
    expected_artifacts: structuredClone(clashLetter.artifacts),
    input_snapshot: structuredClone(clashLetter.published_inputs),
    operation: "revise",
    channel: "chat_command",
    pre_attempt_state: "completed",
    pending_waivers: [{
      id: "waiver_0001",
      brief_digest: "1".repeat(64),
      subject: { kind: "check", key: "letter_keyword:1" },
    }],
  };
  const pendingDistinct = structuredClone(pendingClash);
  letterStep(pendingDistinct).active_attempt.pending_waivers[0].id = "waiver_0009";
  validateLogV3(pendingDistinct);
  assertInvalid(
    pendingClash,
    /pending_waivers\[0\]\.id duplicates a journaled waiver id/,
  );

  const unanchoredWaiver = createValidV3Log();
  letterStep(unanchoredWaiver).waivers = [
    validWaiver({ created_at: "2026-07-01T00:00:00.000Z" }),
  ];
  assertInvalid(
    unanchoredWaiver,
    /waivers\[0\]\.created_at must not be before processes\[1\]\.started_at/,
  );

  const futureWaiver = createValidV3Log();
  letterStep(futureWaiver).waivers = [
    validWaiver({ created_at: "2026-07-24T23:59:00.000Z" }),
  ];
  assertInvalid(
    futureWaiver,
    /waivers\[0\]\.created_at must not be after processes\[1\]\.updated_at/,
  );

  const duplicatedAdoptionId = createValidV3Log();
  const adoptionLetter = letterStep(duplicatedAdoptionId);
  adoptionLetter.adoption_base = {
    id: "adoption_dup_0001",
    created_at: adoptionLetter.finished_at,
    attempt_id: "attempt_adoption_dup",
    publication_id: "publication_brief_001",
    phase: "staged",
    entries: [{ kind: "cover_letter", sha256: "2".repeat(64), bytes: 10 }],
  };
  assertInvalid(
    duplicatedAdoptionId,
    /adoption_base\.publication_id duplicates publication id owned by/,
  );
});

test("a restored revision mark must be anchored to a committed publication", () => {
  const unanchored = createValidV3Log();
  const letter = letterStep(unanchored);
  const committed = letter.attempt_history.at(-1);
  letter.attempt_history = [{
    attempt: 1,
    outcome: "failed",
    started_at: committed.started_at,
    finished_at: committed.finished_at,
    input_snapshot: structuredClone(committed.input_snapshot),
    error_code: "revision_abandoned",
    publication_id: null,
    operation: "revise",
    channel: "chat_command",
    pre_attempt_state: "completed",
  }];
  assertInvalid(
    unanchored,
    /attempt_history must end with outcome completed for state completed/,
  );
});

test("a completed material step may end with a failed revise attempt that restored its mark", () => {
  const restored = createValidV3Log();
  const letter = letterStep(restored);
  const committed = letter.attempt_history.at(-1);
  const revisionEntry = {
    attempt: committed.attempt + 1,
    outcome: "failed",
    started_at: committed.finished_at,
    finished_at: committed.finished_at,
    input_snapshot: structuredClone(committed.input_snapshot),
    error_code: "revision_abandoned",
    publication_id: null,
    operation: "revise",
    channel: "chat_command",
    pre_attempt_state: "completed",
  };
  letter.attempt_history.push(revisionEntry);
  letter.attempt += 1;
  letter.started_at = revisionEntry.started_at;
  letter.updated_at = revisionEntry.finished_at;
  letter.finished_at = revisionEntry.finished_at;
  validateLogV3(restored);

  const wrongMark = structuredClone(restored);
  letterStep(wrongMark).attempt_history.at(-1).pre_attempt_state = "stale";
  assertInvalid(
    wrongMark,
    /attempt_history must end with outcome completed for state completed/,
  );

  const plainFailure = structuredClone(restored);
  delete letterStep(plainFailure).attempt_history.at(-1).operation;
  delete letterStep(plainFailure).attempt_history.at(-1).channel;
  delete letterStep(plainFailure).attempt_history.at(-1).pre_attempt_state;
  assertInvalid(
    plainFailure,
    /attempt_history must end with outcome completed for state completed/,
  );
});

test("a restored revision mark survives the later stale transition it cannot see", () => {
  // `reopen-step` on an ancestor and `reconcile-step` on proven input drift both mark a completed
  // step stale without an attempt of its own, long after the revision entry froze its restored mark.
  const restored = createValidV3Log();
  const letter = letterStep(restored);
  const committed = letter.attempt_history.at(-1);
  letter.attempt_history.push({
    attempt: committed.attempt + 1,
    outcome: "failed",
    started_at: committed.finished_at,
    finished_at: committed.finished_at,
    input_snapshot: structuredClone(committed.input_snapshot),
    error_code: "revision_abandoned",
    publication_id: null,
    operation: "revise",
    channel: "chat_command",
    pre_attempt_state: "completed",
  });
  letter.attempt += 1;
  letter.started_at = committed.finished_at;
  letter.updated_at = committed.finished_at;
  letter.finished_at = committed.finished_at;
  letter.state = "stale";
  validateLogV3(restored);

  const staleMark = structuredClone(restored);
  letterStep(staleMark).attempt_history.at(-1).pre_attempt_state = "stale";
  validateLogV3(staleMark);

  const unanchored = structuredClone(restored);
  const unanchoredLetter = letterStep(unanchored);
  unanchoredLetter.attempt_history = unanchoredLetter.attempt_history.slice(-1);
  unanchoredLetter.attempt_history[0].attempt = 1;
  unanchoredLetter.attempt = 1;
  assertInvalid(
    unanchored,
    /attempt_history must end with outcome completed for state stale/,
  );

  const plainFailure = structuredClone(restored);
  delete letterStep(plainFailure).attempt_history.at(-1).operation;
  delete letterStep(plainFailure).attempt_history.at(-1).channel;
  delete letterStep(plainFailure).attempt_history.at(-1).pre_attempt_state;
  assertInvalid(
    plainFailure,
    /attempt_history must end with outcome completed for state stale/,
  );

  // The carve-out reaches only the two marks a revision can restore: `blocked` and `failed` are
  // never one of them, so an abandoned revision entry may not stand as a blocked step's tail.
  const blockedStep = structuredClone(restored);
  const blockedLetter = letterStep(blockedStep);
  blockedLetter.state = "blocked";
  blockedLetter.blocker = {
    code: "revision_abandoned",
    message: "The revision was stopped by the operator.",
    at: blockedLetter.finished_at,
    retryable: true,
    details: [],
  };
  assertInvalid(
    blockedStep,
    /attempt_history must end with outcome blocked for state blocked/,
  );

  // Only a close without a committed publication restores a mark, and a `blocked` entry is a
  // committed one — it carries a publication id. The lifecycle cannot emit this shape anyway:
  // `loadCandidatePublicationBundle` refuses a `blocked` outcome for every step but `get_vacancy`
  // and `research_company`, before any transaction is built.
  const blockedOutcome = structuredClone(restored);
  const blockedOutcomeEntry = letterStep(blockedOutcome).attempt_history.at(-1);
  blockedOutcomeEntry.outcome = "blocked";
  blockedOutcomeEntry.publication_id = "publication_revise_blocked_0001";
  blockedOutcomeEntry.error_code = "human_qa_pending";
  blockedOutcomeEntry.open_conflicts = [];
  assertInvalid(
    blockedOutcome,
    /attempt_history must end with outcome completed for state stale/,
  );
});
