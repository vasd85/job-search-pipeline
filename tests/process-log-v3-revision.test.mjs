import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readLogV3 } from "../tools/lib/process-log-core.mjs";
import {
  beginFileBackedStepV3,
  failFileBackedStepV3,
  fileBackedProtectedInputs,
  preflightFileBackedStepV3,
  publishFileBackedStepV3,
  reconcileFileBackedStepV3,
  reopenFileBackedStepV3,
  reserveFileBackedOutputV3,
  retryFileBackedStepV3,
  reviseFileBackedStepV3,
  startFileBackedProcessV3,
  updateFileBackedProcessV3,
  validateProcessLogV3Deep,
} from "../tools/lib/process-log-v3-lifecycle.mjs";
import { sha256Hex } from "../tools/pipeline-artifacts/validation.mjs";
import {
  createDisposableWorkspace,
  disposableWorkspaceEnv,
} from "./fixtures/disposable-workspace.mjs";
import { makeCoverLetter, runFixtureStep } from "./fixtures/file-backed-pipeline-producer.mjs";
import { createDocxBytes } from "./fixtures/minimal-docx.mjs";
import { protectedInputSource, seedCandidateConfig } from "./fixtures/protected-inputs.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const processId = "proc_fixture_step1_completed";
const sourceRef = "https://example.test/jobs/senior-quality-engineer";
const outputDir = "output/example-labs-senior-quality-engineer";
const selector = Object.freeze({ id: processId });
const stepNames = Object.freeze([
  "get_vacancy",
  "research_company",
  "map_experience",
  "generate_cv",
  "write_cover_letter",
]);
const upstreamStepNames = Object.freeze([
  "get_vacancy",
  "research_company",
  "map_experience",
]);

function emptyLog() {
  return {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: "2026-07-27T08:00:00.000Z",
    companies: [],
    processes: [],
  };
}

function lifecycleEnvironment(environment) {
  return {
    outputRoot: environment.outputRoot,
    workspaceRoot: environment.workspaceRoot,
  };
}

function createEnvironment(t, prefix = "process-log-v3-revision-") {
  const disposable = createDisposableWorkspace(t, {
    ledger: emptyLog(),
    prefix,
  });
  const { ledgerPath, outputRoot, workspaceRoot } = disposable;

  const protectedPaths = new Set(
    Object.values(fileBackedProtectedInputs)
      .flat()
      .map((contract) => contract.path),
  );
  for (const path of protectedPaths) {
    const destination = resolve(workspaceRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(protectedInputSource(repoRoot, path), destination);
  }
  seedCandidateConfig(repoRoot, workspaceRoot);

  startFileBackedProcessV3(
    ledgerPath,
    { sourceRef, runner: "codex" },
    {
      attemptIdFactory: () => "attempt_fixture_get_vacancy_001",
      clock: () => "2026-07-27T08:00:00.000Z",
      processIdFactory: () => processId,
    },
  );
  updateFileBackedProcessV3(
    ledgerPath,
    {
      processId,
      companyObserved: "Example Labs",
      role: "Senior Quality Engineer",
    },
    { clock: () => "2026-07-27T08:05:00.000Z" },
  );
  reserveFileBackedOutputV3(
    ledgerPath,
    { processId },
    {
      ...lifecycleEnvironment({ outputRoot, workspaceRoot }),
      clock: () => "2026-07-27T08:06:00.000Z",
    },
  );
  return {
    ...disposable,
    selectedOutputPath: resolve(workspaceRoot, outputDir),
  };
}

function runThrough(environment, finalStep) {
  const finalIndex = stepNames.indexOf(finalStep);
  for (const stepName of stepNames.slice(0, finalIndex + 1)) {
    runFixtureStep(environment, stepName, { id: processId });
  }
}

function readProcess(environment) {
  return readLogV3(environment.ledgerPath).processes.find(
    (record) => record.id === processId,
  );
}

function readStep(environment, stepName) {
  return readProcess(environment).steps[stepName];
}

let clockMs = Date.parse("2026-07-27T10:00:00.000Z");
function nextTimestamp() {
  clockMs += 60_000;
  return new Date(clockMs).toISOString();
}

function revise(environment, stepName, {
  adopt = false,
  attemptId = `attempt_revise_${stepName}_${clockMs}`,
  channel = "chat_command",
  publicationIdFactory,
  waivers = [],
} = {}) {
  return reviseFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName, channel, adopt, waivers },
    {
      ...lifecycleEnvironment(environment),
      attemptIdFactory: () => attemptId,
      clock: () => nextTimestamp(),
      ...(publicationIdFactory ? { publicationIdFactory } : {}),
    },
  );
}

function publish(environment, stepName, attemptId, publicationId, options = {}) {
  const { waivers = [], ...lifecycleOptions } = options;
  return publishFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName,
      attemptId,
      publicationId,
      outcome: "completed",
      blocker: null,
      waivers,
    },
    {
      ...lifecycleEnvironment(environment),
      clock: () => nextTimestamp(),
      ...lifecycleOptions,
    },
  );
}

/*
 * The letter's own first publication, which `runFixtureStep` performs in one call: opened here by
 * hand so a test can stage a draft of its own length before publishing it.
 */
function beginLetter(environment, attemptId) {
  preflightFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName: "write_cover_letter" },
    lifecycleEnvironment(environment),
  );
  return beginFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName: "write_cover_letter" },
    {
      ...lifecycleEnvironment(environment),
      attemptIdFactory: () => attemptId,
      clock: () => nextTimestamp(),
    },
  );
}

function stageFirstLetter(environment, publicationId, mutate = (text) => text) {
  const brief = JSON.parse(readFileSync(
    join(environment.selectedOutputPath, "application-brief.json"),
    "utf8",
  ));
  const staged = mutate(makeCoverLetter(brief));
  writeFileSync(
    join(stageDirectory(environment, publicationId), "cover-letter.txt"),
    staged,
    "utf8",
  );
  return staged;
}

function stageDirectory(environment, publicationId) {
  const directory = join(
    environment.selectedOutputPath,
    ".pipeline-tmp",
    publicationId,
  );
  mkdirSync(directory, { recursive: true });
  return directory;
}

function committedLetterText(environment) {
  return readFileSync(
    join(environment.selectedOutputPath, "cover-letter.txt"),
    "utf8",
  );
}

function stageLetter(environment, publicationId, mutate = (text) => text) {
  const staged = mutate(committedLetterText(environment));
  writeFileSync(
    join(stageDirectory(environment, publicationId), "cover-letter.txt"),
    staged,
    "utf8",
  );
  return staged;
}

function committedCv(environment) {
  return JSON.parse(
    readFileSync(join(environment.selectedOutputPath, "cv.json"), "utf8"),
  );
}

function stageCv(environment, publicationId, mutate = (cv) => cv) {
  const cv = mutate(committedCv(environment));
  const staging = stageDirectory(environment, publicationId);
  writeFileSync(join(staging, "cv.json"), `${JSON.stringify(cv, null, 2)}\n`, "utf8");
  writeFileSync(join(staging, cv.fileName), createDocxBytes({ cv }));
  return cv;
}

function briefKeywordTerms(environment) {
  return JSON.parse(readFileSync(
    join(environment.selectedOutputPath, "application-brief.json"),
    "utf8",
  )).coverLetterPlan.keywordTerms;
}

function upstreamEvidence(environment) {
  const record = readProcess(environment);
  const steps = JSON.stringify(
    upstreamStepNames.map((stepName) => record.steps[stepName]),
  );
  const bytes = upstreamStepNames.flatMap((stepName) =>
    record.steps[stepName].artifacts.map((artifact) =>
      sha256Hex(readFileSync(join(environment.selectedOutputPath, artifact.path)))));
  return { steps, bytes: JSON.stringify(bytes) };
}

function deepReport(environment) {
  return validateProcessLogV3Deep(
    environment.ledgerPath,
    lifecycleEnvironment(environment),
  );
}

function deepStep(report, stepName) {
  return report.processes
    .find((entry) => entry.process_id === processId)
    .steps.find((entry) => entry.name === stepName);
}

function archivePath(environment, publicationId, basename) {
  return join(environment.selectedOutputPath, ".revisions", publicationId, basename);
}

function assertArchivedPublication(environment, stepName, publicationId) {
  const step = readStep(environment, stepName);
  const entry = step.attempt_history.findLast(
    (attempt) => attempt.publication_id === publicationId,
  );
  assert.ok(entry, `history entry for ${publicationId}`);
  assert.ok(Array.isArray(entry.archived_artifacts));
  assert.equal(entry.archived_artifacts.length, step.artifacts.length);
  for (const archived of entry.archived_artifacts) {
    const bytes = readFileSync(archivePath(environment, publicationId, archived.path));
    assert.equal(sha256Hex(bytes), archived.sha256);
    assert.equal(bytes.byteLength, archived.bytes);
  }
  return entry;
}

test("a one-word cover-letter revision publishes without reopening step 3 or touching steps 1-2", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const before = upstreamEvidence(environment);
  const committedBefore = committedLetterText(environment);

  const opened = revise(environment, "write_cover_letter", {
    attemptId: "attempt_revise_letter_001",
  });
  assert.equal(opened.status, "revision_opened");
  assert.equal(opened.operation, "revise");
  assert.equal(opened.channel, "chat_command");
  assert.equal(opened.pre_attempt_state, "completed");
  assert.deepEqual(opened.open_conflicts, []);
  const step = readStep(environment, "write_cover_letter");
  assert.equal(step.state, "running");
  assert.equal(step.active_attempt.operation, "revise");
  assert.deepEqual(
    step.active_attempt.input_snapshot,
    step.published_inputs,
    "a revision attempt pins the step's own published input snapshot",
  );

  const publicationId = "publication_revise_letter_001";
  const staged = stageLetter(environment, publicationId, (text) =>
    text.replace("calm engineering judgment", "calm engineering rigor"));
  assert.notEqual(staged, committedBefore);
  const published = publish(
    environment,
    "write_cover_letter",
    "attempt_revise_letter_001",
    publicationId,
  );
  assert.equal(published.status, "completed");
  assert.equal(published.state, "completed");
  assert.equal(published.revision, 2);
  assert.deepEqual(published.open_conflicts, []);

  const after = upstreamEvidence(environment);
  assert.equal(after.steps, before.steps, "steps 1-3 ledger records unchanged");
  assert.equal(after.bytes, before.bytes, "steps 1-2 artifacts byte-identical");
  const finalStep = readStep(environment, "write_cover_letter");
  assert.equal(finalStep.state, "completed");
  const lastEntry = finalStep.attempt_history.at(-1);
  assert.equal(lastEntry.operation, "revise");
  assert.equal(lastEntry.channel, "chat_command");
  assert.equal(lastEntry.pre_attempt_state, "completed");
  assert.deepEqual(lastEntry.open_conflicts, []);
  assertArchivedPublication(environment, "write_cover_letter", publicationId);
  assert.equal(
    readFileSync(archivePath(environment, publicationId, "cover-letter.txt"), "utf8"),
    staged,
  );
  assert.equal(deepReport(environment).health, "current");
});

test("every steps-4/5 publication archives its committed bundle under .revisions", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const letterEntry = assertArchivedPublication(
    environment,
    "write_cover_letter",
    "publication_fixture_write_cover_letter_001",
  );
  assert.equal(letterEntry.outcome, "completed");
  assertArchivedPublication(
    environment,
    "generate_cv",
    "publication_fixture_generate_cv_001",
  );
  const upstream = readStep(environment, "map_experience").attempt_history.at(-1);
  assert.equal(
    upstream.archived_artifacts,
    undefined,
    "steps 1-3 publications do not grow an archive",
  );
  assert.equal(
    existsSync(join(environment.selectedOutputPath, ".revisions", "publication_fixture_map_experience_001")),
    false,
  );
});

test("an unwaived required keyword edit publishes with the conflict journaled and re-surfaced", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const [firstTerm] = briefKeywordTerms(environment);

  revise(environment, "write_cover_letter", { attemptId: "attempt_revise_letter_010" });
  const publicationId = "publication_revise_letter_010";
  stageLetter(environment, publicationId, (text) =>
    text.replaceAll(firstTerm, "redacted-term"));
  const published = publish(
    environment,
    "write_cover_letter",
    "attempt_revise_letter_010",
    publicationId,
  );
  assert.equal(published.status, "completed");
  assert.equal(published.open_conflicts.length, 1);
  assert.deepEqual(published.open_conflicts[0].subject, {
    kind: "check",
    key: "letter_keyword:0",
  });
  assert.equal(published.open_conflicts[0].code, "letter_keyword");

  const entry = readStep(environment, "write_cover_letter").attempt_history.at(-1);
  assert.deepEqual(entry.open_conflicts, [
    { subject: { kind: "check", key: "letter_keyword:0" }, code: "letter_keyword" },
  ]);

  const report = deepReport(environment);
  assert.equal(report.health, "attention");
  assert.ok(deepStep(report, "write_cover_letter").issues.includes("open_conflicts"));

  const reopened = revise(environment, "write_cover_letter", {
    attemptId: "attempt_revise_letter_011",
  });
  assert.deepEqual(reopened.open_conflicts, entry.open_conflicts,
    "unresolved conflicts re-surface on the next revision");
});

test("a waived required keyword survives publication with the waiver journaled", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const [firstTerm] = briefKeywordTerms(environment);
  const briefDigest = readStep(environment, "write_cover_letter")
    .published_inputs.find((entry) => entry.kind === "application_brief").sha256;

  const opened = revise(environment, "write_cover_letter", {
    attemptId: "attempt_revise_letter_020",
    waivers: [{
      subject: { kind: "check", key: "letter_keyword:0" },
      note: "Term reads unnaturally in the closing paragraph; user accepts the ATS risk.",
    }],
  });
  assert.equal(opened.status, "revision_opened");

  const publicationId = "publication_revise_letter_020";
  stageLetter(environment, publicationId, (text) =>
    text.replaceAll(firstTerm, "redacted-term"));
  const published = publish(
    environment,
    "write_cover_letter",
    "attempt_revise_letter_020",
    publicationId,
  );
  assert.equal(published.status, "completed");
  assert.deepEqual(published.open_conflicts, []);
  assert.equal(published.notices.length, 1);
  assert.equal(published.notices[0].code, "letter_keyword");

  const step = readStep(environment, "write_cover_letter");
  assert.equal(step.waivers.length, 1);
  const [waiver] = step.waivers;
  assert.equal(waiver.status, "active");
  assert.equal(waiver.brief_digest, briefDigest);
  assert.deepEqual(waiver.subject, { kind: "check", key: "letter_keyword:0" });
  assert.match(waiver.note, /accepts the ATS risk/);
  assert.equal(published.notices[0].waiver_id, waiver.id);
  assert.equal(published.waivers_recorded.length, 1);
  assert.equal(published.waivers_recorded[0].id, waiver.id);
  assert.deepEqual(step.attempt_history.at(-1).open_conflicts, []);
  assert.equal(deepReport(environment).health, "current");
});

test("the waiver chosen after a conflict rides a same-bytes revision and holds for later ones", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const [firstTerm] = briefKeywordTerms(environment);

  // PD-003 point 4 (docs/adr/0015-lightweight-post-review-revision.md#pd-003-the-product-decision-this-record-implements) order: the edit publishes first and the user chooses afterwards, so the waiver can
  // only be carried by a later revision — which has no bytes of its own to change.
  revise(environment, "write_cover_letter", { attemptId: "attempt_revise_letter_050" });
  stageLetter(environment, "publication_revise_letter_050", (text) =>
    text.replaceAll(firstTerm, "redacted-term"));
  const conflicted = publish(
    environment,
    "write_cover_letter",
    "attempt_revise_letter_050",
    "publication_revise_letter_050",
  );
  assert.equal(conflicted.open_conflicts.length, 1);
  // Frozen literals, not a comparison of two module outputs: the initial publication is revision 1
  // and this edit changed the bundle.
  assert.equal(conflicted.revision, 2);

  const committedBeforeWaiver = committedLetterText(environment);
  revise(environment, "write_cover_letter", {
    attemptId: "attempt_revise_letter_051",
    waivers: [{
      subject: { kind: "check", key: "letter_keyword:0" },
      note: "User accepts the ATS risk for this term.",
    }],
  });
  stageLetter(environment, "publication_revise_letter_051");
  assert.equal(
    readFileSync(
      join(
        environment.selectedOutputPath,
        ".pipeline-tmp",
        "publication_revise_letter_051",
        "cover-letter.txt",
      ),
      "utf8",
    ),
    committedBeforeWaiver,
    "the waiver-only revision stages the committed bytes unchanged",
  );
  const waived = publish(
    environment,
    "write_cover_letter",
    "attempt_revise_letter_051",
    "publication_revise_letter_051",
  );
  assert.deepEqual(waived.open_conflicts, []);
  assert.equal(waived.notices.length, 1);
  assert.equal(waived.waivers_recorded.length, 1);
  assert.equal(
    waived.revision,
    2,
    "republishing identical bytes records the decision without a content revision",
  );
  assert.equal(deepReport(environment).health, "current");

  // ...and the decision holds for the next edit, which still lacks the same term.
  revise(environment, "write_cover_letter", { attemptId: "attempt_revise_letter_052" });
  const editedBytes = stageLetter(environment, "publication_revise_letter_052", (text) =>
    text.replace("calm engineering judgment", "calm engineering rigor"));
  assert.notEqual(
    editedBytes,
    committedLetterText(environment),
    "the third leg must be a real edit, or its revision assertion proves nothing",
  );
  const later = publish(
    environment,
    "write_cover_letter",
    "attempt_revise_letter_052",
    "publication_revise_letter_052",
  );
  assert.deepEqual(later.open_conflicts, []);
  assert.equal(later.notices.length, 1);
  assert.deepEqual(later.waivers_recorded, []);
  assert.equal(later.revision, 3, "a changed bundle advances the content revision");
  assert.equal(readStep(environment, "write_cover_letter").waivers.length, 1);
});

test("the same edit without a waiver still fails through the normal reopen path exactly as today", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const [firstTerm] = briefKeywordTerms(environment);
  const committedBytes = readFileSync(
    join(environment.selectedOutputPath, "cover-letter.txt"),
  );

  const reopened = reopenFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName: "write_cover_letter" },
    {
      ...lifecycleEnvironment(environment),
      attemptIdFactory: () => "attempt_reopen_letter_001",
      clock: () => nextTimestamp(),
    },
  );
  const publicationId = "publication_reopen_letter_001";
  stageLetter(environment, publicationId, (text) =>
    text.replaceAll(firstTerm, "redacted-term"));
  assert.throws(
    () => publish(
      environment,
      "write_cover_letter",
      reopened.attempt_id,
      publicationId,
    ),
    (error) => error.code === "candidate_bundle_invalid",
  );
  assert.deepEqual(
    readFileSync(join(environment.selectedOutputPath, "cover-letter.txt")),
    committedBytes,
  );
});

// A light revision of the letter, a one-word edit published under the letter's pinned snapshot.
function reviseLetter(environment, suffix) {
  const attemptId = `attempt_revise_letter_layer_${suffix}`;
  const publicationId = `publication_revise_letter_layer_${suffix}`;
  revise(environment, "write_cover_letter", { attemptId });
  stageLetter(environment, publicationId, (text) =>
    text.replace("calm engineering judgment", "calm engineering rigor"));
  return publish(environment, "write_cover_letter", attemptId, publicationId);
}

test("a revision under a changed layer file finalizes stale, and so does one under a layer file that appeared", (t) => {
  const samplesPath = "candidate/letter-samples.md";
  const edited = createEnvironment(t);
  runThrough(edited, "write_cover_letter");
  appendFileSync(resolve(edited.workspaceRoot, samplesPath), "\n");
  assert.equal(reviseLetter(edited, "edited").state, "stale");

  // Absent at publication, so the snapshot has no entry that could differ.
  const appeared = createEnvironment(t);
  const samples = readFileSync(resolve(appeared.workspaceRoot, samplesPath));
  unlinkSync(resolve(appeared.workspaceRoot, samplesPath));
  runThrough(appeared, "write_cover_letter");
  writeFileSync(resolve(appeared.workspaceRoot, samplesPath), samples);
  assert.equal(reviseLetter(appeared, "appeared").state, "stale");
});

test("a revision finalizes completed under an empty optional file, and on a record older than the layer inputs", (t) => {
  const samplesPath = "candidate/letter-samples.md";
  const empty = createEnvironment(t);
  unlinkSync(resolve(empty.workspaceRoot, samplesPath));
  runThrough(empty, "write_cover_letter");
  writeFileSync(resolve(empty.workspaceRoot, samplesPath), "");
  assert.equal(reviseLetter(empty, "empty").state, "completed");

  // A record written before the steps pinned the layer files: none of them, present or not, counts.
  const legacy = createEnvironment(t);
  const samples = readFileSync(resolve(legacy.workspaceRoot, samplesPath));
  unlinkSync(resolve(legacy.workspaceRoot, samplesPath));
  runThrough(legacy, "write_cover_letter");
  const log = JSON.parse(readFileSync(legacy.ledgerPath, "utf8"));
  const step = log.processes.find((record) => record.id === processId).steps.write_cover_letter;
  step.published_inputs = step.published_inputs.filter(
    (entry) => !["candidate_config", "candidate_constraints"].includes(entry.kind),
  );
  writeFileSync(legacy.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  writeFileSync(resolve(legacy.workspaceRoot, samplesPath), samples);
  assert.equal(reviseLetter(legacy, "legacy").state, "completed");
});

test("knowledge drift neither blocks a revision nor is cleared by it, and deep validation still reports staleness", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const playbookPath = resolve(
    environment.workspaceRoot,
    "knowledge/cover-letter-playbook.md",
  );
  const originalPlaybook = readFileSync(playbookPath);
  appendFileSync(playbookPath, "\nDrifted guidance line for the revision test.\n");

  const opened = revise(environment, "write_cover_letter", {
    attemptId: "attempt_revise_letter_030",
  });
  assert.equal(opened.status, "revision_opened");
  const publicationId = "publication_revise_letter_030";
  stageLetter(environment, publicationId, (text) =>
    text.replace("calm engineering judgment", "calm engineering rigor"));
  const published = publish(
    environment,
    "write_cover_letter",
    "attempt_revise_letter_030",
    publicationId,
  );
  assert.equal(published.status, "completed");
  assert.equal(published.state, "stale",
    "persisting protected-input drift finalizes the revision stale");
  assert.equal(readStep(environment, "write_cover_letter").state, "stale");

  const report = deepReport(environment);
  const letter = deepStep(report, "write_cover_letter");
  assert.equal(letter.input_health, "stale");
  assert.ok(letter.issues.includes("lifecycle_stale"));

  writeFileSync(playbookPath, originalPlaybook);
  revise(environment, "write_cover_letter", { attemptId: "attempt_revise_letter_031" });
  const healedId = "publication_revise_letter_031";
  stageLetter(environment, healedId, (text) =>
    text.replace("calm engineering rigor", "calm engineering judgment"));
  const healed = publish(
    environment,
    "write_cover_letter",
    "attempt_revise_letter_031",
    healedId,
  );
  assert.equal(healed.state, "completed",
    "healed drift finalizes the next revision completed");
  assert.equal(readStep(environment, "write_cover_letter").state, "completed");
});

test("shared-canon drift refuses the authoring preflight while the revision still opens", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  // Both files are protected inputs of map_experience and write_cover_letter alike, so this is
  // the ordinary canon-drift shape. They take different refusal routes inside the preflight —
  // the generic published-snapshot comparison and the candidate-profile check — and the
  // procedure's "a revision does not run preflight-step" rule has to hold on both.
  const drifts = [
    ["knowledge/generation-rules.md", "attempt_revise_letter_060"],
    ["candidate/profile.md", "attempt_revise_letter_061"],
  ];

  for (const [relativePath, attemptId] of drifts) {
    const path = resolve(environment.workspaceRoot, relativePath);
    const original = readFileSync(path);
    appendFileSync(path, `\nDrifted canonical line for ${attemptId}.\n`);

    assert.throws(
      () => preflightFileBackedStepV3(
        environment.ledgerPath,
        { selector, stepName: "write_cover_letter" },
        lifecycleEnvironment(environment),
      ),
      (error) => error.code === "prerequisite_stale",
      `preflight must refuse the drift in ${relativePath}`,
    );

    const opened = revise(environment, "write_cover_letter", { attemptId });
    assert.equal(opened.status, "revision_opened");
    assert.equal(opened.pre_attempt_state, "completed");
    assert.equal(readStep(environment, "write_cover_letter").state, "running");

    failFileBackedStepV3(
      environment.ledgerPath,
      {
        selector,
        stepName: "write_cover_letter",
        attemptId,
        error: {
          code: "revision_abandoned",
          message: "The user cancelled the revision.",
          retryable: true,
        },
      },
      { ...lifecycleEnvironment(environment), clock: () => nextTimestamp() },
    );
    assert.equal(readStep(environment, "write_cover_letter").state, "completed");
    writeFileSync(path, original);
  }
});

test("a one-word cv.json revision publishes with a rebuilt DOCX and untouched upstream bundle", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const before = upstreamEvidence(environment);

  revise(environment, "generate_cv", { attemptId: "attempt_revise_cv_001" });
  const publicationId = "publication_revise_cv_001";
  stageCv(environment, publicationId, (cv) => {
    cv.sections[0].text = "Senior Quality Engineer with TypeScript depth.";
    return cv;
  });
  const published = publish(
    environment,
    "generate_cv",
    "attempt_revise_cv_001",
    publicationId,
  );
  assert.equal(published.status, "completed");
  assert.equal(published.state, "completed");
  assert.equal(published.revision, 2);
  const after = upstreamEvidence(environment);
  assert.equal(after.steps, before.steps);
  assert.equal(after.bytes, before.bytes);
  assertArchivedPublication(environment, "generate_cv", publicationId);
  assert.equal(deepReport(environment).health, "current");
});

test("a waived required ATS term survives a cv revision; unwaived it journals a conflict", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");

  revise(environment, "generate_cv", { attemptId: "attempt_revise_cv_010" });
  const unwaivedId = "publication_revise_cv_010";
  stageCv(environment, unwaivedId, (cv) => {
    cv.sections[0].text = "Senior Quality Engineer with Playwright breadth.";
    return cv;
  });
  const unwaived = publish(
    environment,
    "generate_cv",
    "attempt_revise_cv_010",
    unwaivedId,
  );
  assert.equal(unwaived.status, "completed");
  assert.equal(unwaived.open_conflicts.length, 1);
  assert.deepEqual(unwaived.open_conflicts[0].subject, {
    kind: "check",
    key: "cv_ats_term:TypeScript",
  });
  assert.equal(unwaived.open_conflicts[0].code, "cv_ats_term");

  const opened = revise(environment, "generate_cv", {
    attemptId: "attempt_revise_cv_011",
    waivers: [{ subject: { kind: "check", key: "cv_ats_term:TypeScript" } }],
  });
  assert.equal(opened.status, "revision_opened");
  const waivedId = "publication_revise_cv_011";
  stageCv(environment, waivedId, (cv) => {
    cv.sections[0].text = "Senior Quality Engineer with sustained Playwright breadth.";
    return cv;
  });
  const waived = publish(
    environment,
    "generate_cv",
    "attempt_revise_cv_011",
    waivedId,
  );
  assert.deepEqual(waived.open_conflicts, []);
  assert.equal(waived.notices.length, 1);
  const step = readStep(environment, "generate_cv");
  assert.equal(step.waivers.length, 1);
  assert.equal(step.waivers[0].status, "active");
  assert.equal(waived.notices[0].waiver_id, step.waivers[0].id);
  assert.equal(deepReport(environment).health, "current");
});

test("failing a revision attempt restores the committed mark instead of failing the step", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const committedBytes = readFileSync(
    join(environment.selectedOutputPath, "cover-letter.txt"),
  );

  revise(environment, "write_cover_letter", {
    attemptId: "attempt_revise_letter_040",
    waivers: [{ subject: { kind: "check", key: "letter_keyword:0" } }],
  });
  const failed = failFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName: "write_cover_letter",
      attemptId: "attempt_revise_letter_040",
      error: {
        code: "revision_abandoned",
        message: "The user cancelled the revision.",
        retryable: true,
        details: [],
      },
    },
    { clock: () => nextTimestamp() },
  );
  assert.equal(failed.status, "reverted");
  assert.equal(failed.state, "completed");

  const step = readStep(environment, "write_cover_letter");
  assert.equal(step.state, "completed");
  assert.equal(step.error, null);
  const entry = step.attempt_history.at(-1);
  assert.equal(entry.outcome, "failed");
  assert.equal(entry.operation, "revise");
  assert.equal(entry.pre_attempt_state, "completed");
  assert.equal(entry.error_code, "revision_abandoned");
  assert.ok(
    !step.waivers || step.waivers.length === 0,
    "pending waivers are dropped with the attempt, never journaled",
  );
  assert.deepEqual(
    readFileSync(join(environment.selectedOutputPath, "cover-letter.txt")),
    committedBytes,
  );
  assert.equal(deepReport(environment).health, "current");
});

function abandonRevision(environment, stepName, attemptId) {
  revise(environment, stepName, { attemptId });
  const reverted = failFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName,
      attemptId,
      error: {
        code: "revision_abandoned",
        message: "The user cancelled the revision.",
        retryable: true,
        details: [],
      },
    },
    { clock: () => nextTimestamp() },
  );
  assert.equal(reverted.state, "completed");
  const entry = readStep(environment, stepName).attempt_history.at(-1);
  assert.equal(entry.outcome, "failed");
  assert.equal(entry.operation, "revise");
  assert.equal(entry.pre_attempt_state, "completed");
  return entry;
}

test("an abandoned revision on both material steps still admits the upstream reopen", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const abandoned = new Map([
    ["generate_cv", abandonRevision(environment, "generate_cv", "attempt_revise_cv_070")],
    [
      "write_cover_letter",
      abandonRevision(environment, "write_cover_letter", "attempt_revise_letter_070"),
    ],
  ]);

  const reopened = reopenFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName: "map_experience" },
    {
      ...lifecycleEnvironment(environment),
      attemptIdFactory: () => "attempt_reopen_brief_070",
      clock: () => nextTimestamp(),
    },
  );
  assert.deepEqual(
    reopened.invalidated_steps,
    ["generate_cv", "write_cover_letter"],
    "the explicit Step 3 reopen both revision loops name must stale the abandoned material steps",
  );

  for (const [stepName, entry] of abandoned) {
    const step = readStep(environment, stepName);
    assert.equal(step.state, "stale");
    assert.equal(step.error, null);
    assert.deepEqual(
      step.attempt_history.at(-1),
      entry,
      "staling a reverted revision rewrites no history",
    );
  }
  const report = deepReport(environment);
  for (const stepName of ["generate_cv", "write_cover_letter"]) {
    assert.ok(deepStep(report, stepName).issues.includes("lifecycle_stale"));
  }
});

test("a tokenless reconcile stales a material step that reverted a revision", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const entry = abandonRevision(
    environment,
    "write_cover_letter",
    "attempt_revise_letter_071",
  );

  const playbookPath = resolve(
    environment.workspaceRoot,
    "knowledge/cover-letter-playbook.md",
  );
  appendFileSync(playbookPath, "\nDrifted guidance line for the reconcile test.\n");
  const reconciled = reconcileFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName: "write_cover_letter",
      attemptId: null,
      publicationId: null,
    },
    { ...lifecycleEnvironment(environment), clock: () => nextTimestamp() },
  );
  assert.equal(reconciled.status, "stale");

  const step = readStep(environment, "write_cover_letter");
  assert.equal(step.state, "stale");
  assert.deepEqual(
    step.attempt_history.at(-1),
    entry,
    "persisting proven drift rewrites no history",
  );
  assert.equal(deepStep(deepReport(environment), "write_cover_letter").input_health, "stale");

  // The staled step is not a dead end: a fresh revision opens against the stale mark, and
  // abandoning that one restores `stale` on a `stale` step — the carve-out's other leg.
  const reopenedEntry = revise(environment, "write_cover_letter", {
    attemptId: "attempt_revise_letter_072",
  });
  assert.equal(reopenedEntry.pre_attempt_state, "stale");
  failFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName: "write_cover_letter",
      attemptId: "attempt_revise_letter_072",
      error: {
        code: "revision_abandoned",
        message: "The user cancelled the revision.",
        retryable: true,
        details: [],
      },
    },
    { clock: () => nextTimestamp() },
  );
  const staleAgain = readStep(environment, "write_cover_letter");
  assert.equal(staleAgain.state, "stale");
  assert.equal(staleAgain.attempt_history.at(-1).pre_attempt_state, "stale");
});

test("a tokenless reconcile on the brief stales material steps that reverted a revision", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const abandoned = new Map([
    ["generate_cv", abandonRevision(environment, "generate_cv", "attempt_revise_cv_073")],
    [
      "write_cover_letter",
      abandonRevision(environment, "write_cover_letter", "attempt_revise_letter_073"),
    ],
  ]);

  // A map_experience-only protected input: the drift is proven upstream while both material steps
  // keep byte-identical inputs of their own, so only the descendant staling loop can mark them.
  appendFileSync(
    resolve(environment.workspaceRoot, "knowledge/impact-levers.md"),
    "\nDrifted lever line for the descendant reconcile test.\n",
  );
  const reconciled = reconcileFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName: "map_experience",
      attemptId: null,
      publicationId: null,
    },
    { ...lifecycleEnvironment(environment), clock: () => nextTimestamp() },
  );
  assert.equal(reconciled.status, "stale");
  assert.deepEqual(reconciled.invalidated_steps, ["generate_cv", "write_cover_letter"]);

  for (const [stepName, entry] of abandoned) {
    const step = readStep(environment, stepName);
    assert.equal(step.state, "stale");
    assert.deepEqual(
      step.attempt_history.at(-1),
      entry,
      "descendant staling rewrites no history",
    );
  }
});

test("revise-step refuses non-material steps, pending steps, and superseded briefs", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "map_experience");

  assert.throws(
    () => revise(environment, "map_experience"),
    (error) => error.code === "revise_step_unsupported",
  );
  assert.throws(
    () => revise(environment, "write_cover_letter"),
    (error) => error.code === "invalid_step_transition",
  );

  runFixtureStep(environment, "generate_cv", { id: processId });
  runFixtureStep(environment, "write_cover_letter", { id: processId });
  const reopenedBrief = reopenFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName: "map_experience" },
    {
      ...lifecycleEnvironment(environment),
      attemptIdFactory: () => "attempt_reopen_brief_001",
      clock: () => nextTimestamp(),
    },
  );
  assert.throws(
    () => revise(environment, "write_cover_letter"),
    (error) => error.code === "brief_attempt_active",
    "revise-step is refused while map_experience has an active attempt",
  );

  const briefPath = join(environment.selectedOutputPath, "application-brief.json");
  const brief = JSON.parse(readFileSync(briefPath, "utf8"));
  const stagingDir = stageDirectory(environment, "publication_reopen_brief_001");
  writeFileSync(
    join(stagingDir, "application-brief.json"),
    `${JSON.stringify(brief, null, 4)}\n`,
    "utf8",
  );
  publish(
    environment,
    "map_experience",
    reopenedBrief.attempt_id,
    "publication_reopen_brief_001",
  );
  assert.throws(
    () => revise(environment, "write_cover_letter"),
    (error) => error.code === "brief_superseded",
    "a step-3 republication with different bytes makes the material a regeneration case",
  );
});

test("waivers survive an identical step-3 republication and are superseded by a different one", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const [firstTerm] = briefKeywordTerms(environment);
  const briefBytes = readFileSync(
    join(environment.selectedOutputPath, "application-brief.json"),
  );

  revise(environment, "write_cover_letter", {
    attemptId: "attempt_revise_letter_050",
    waivers: [{ subject: { kind: "check", key: "letter_keyword:0" } }],
  });
  const waivedId = "publication_revise_letter_050";
  stageLetter(environment, waivedId, (text) =>
    text.replaceAll(firstTerm, "redacted-term"));
  publish(environment, "write_cover_letter", "attempt_revise_letter_050", waivedId);
  assert.equal(readStep(environment, "write_cover_letter").waivers[0].status, "active");

  const reopenedIdentical = reopenFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName: "map_experience" },
    {
      ...lifecycleEnvironment(environment),
      attemptIdFactory: () => "attempt_reopen_brief_010",
      clock: () => nextTimestamp(),
    },
  );
  writeFileSync(
    join(stageDirectory(environment, "publication_reopen_brief_010"), "application-brief.json"),
    briefBytes,
  );
  publish(
    environment,
    "map_experience",
    reopenedIdentical.attempt_id,
    "publication_reopen_brief_010",
  );
  assert.equal(
    readStep(environment, "write_cover_letter").waivers[0].status,
    "active",
    "a byte-identical step-3 republication preserves active waivers",
  );
  assert.equal(readStep(environment, "write_cover_letter").state, "stale");

  const healed = revise(environment, "write_cover_letter", {
    attemptId: "attempt_revise_letter_051",
  });
  assert.equal(healed.pre_attempt_state, "stale");
  const healedId = "publication_revise_letter_051";
  stageLetter(environment, healedId);
  const republished = publish(
    environment,
    "write_cover_letter",
    "attempt_revise_letter_051",
    healedId,
  );
  assert.equal(republished.state, "completed",
    "an upstream identical-bytes republication heals through digest finalization");
  assert.equal(republished.revision, 2, "same-digest revision keeps the counter");

  const reopenedChanged = reopenFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName: "map_experience" },
    {
      ...lifecycleEnvironment(environment),
      attemptIdFactory: () => "attempt_reopen_brief_011",
      clock: () => nextTimestamp(),
    },
  );
  const changedBrief = JSON.parse(briefBytes.toString("utf8"));
  writeFileSync(
    join(stageDirectory(environment, "publication_reopen_brief_011"), "application-brief.json"),
    `${JSON.stringify(changedBrief, null, 4)}\n`,
    "utf8",
  );
  publish(
    environment,
    "map_experience",
    reopenedChanged.attempt_id,
    "publication_reopen_brief_011",
  );
  assert.equal(
    readStep(environment, "write_cover_letter").waivers[0].status,
    "superseded",
    "a different committed brief supersedes active waivers",
  );
});

test("a manual cover-letter edit is adoptable only through the explicit journaled preamble", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const canonicalPath = join(environment.selectedOutputPath, "cover-letter.txt");
  const editedText = committedLetterText(environment).replace(
    "calm engineering judgment",
    "calm engineering rigor",
  );
  writeFileSync(canonicalPath, editedText, "utf8");
  const editedDigest = sha256Hex(readFileSync(canonicalPath));

  assert.throws(
    () => revise(environment, "write_cover_letter", { channel: "manual_file" }),
    (error) => error.code === "artifact_corrupt",
    "divergence outside an explicit adoption remains corruption",
  );

  const adopted = revise(environment, "write_cover_letter", {
    adopt: true,
    attemptId: "attempt_revise_letter_060",
    channel: "manual_file",
    publicationIdFactory: () => "publication_adopt_letter_001",
  });
  assert.equal(adopted.status, "revision_opened");
  assert.equal(adopted.adoption.phase, "staged");
  assert.equal(adopted.adoption.publication_id, "publication_adopt_letter_001");
  assert.deepEqual(
    adopted.adoption.entries.map((entry) => [entry.kind, entry.sha256]),
    [["cover_letter", editedDigest]],
  );
  assert.equal(
    readFileSync(canonicalPath, "utf8"),
    editedText,
    "adoption copies, never moves: the canonical slot keeps the user's bytes",
  );
  assert.equal(
    readFileSync(
      join(
        environment.selectedOutputPath,
        ".pipeline-tmp",
        "publication_adopt_letter_001",
        "cover-letter.txt",
      ),
      "utf8",
    ),
    editedText,
  );

  const published = publish(
    environment,
    "write_cover_letter",
    "attempt_revise_letter_060",
    "publication_adopt_letter_001",
  );
  assert.equal(published.status, "completed");
  assert.equal(published.state, "completed");
  const step = readStep(environment, "write_cover_letter");
  assert.ok(!step.adoption_base, "the adoption base is cleared at publication");
  assert.equal(
    readFileSync(
      archivePath(environment, "publication_fixture_write_cover_letter_001", "cover-letter.txt"),
      "utf8",
    ).includes("calm engineering judgment"),
    true,
    "the overwritten pre-edit version stays recoverable from the previous publication's archive",
  );
  assert.equal(deepReport(environment).health, "current");
});

test("re-entering an adoption without closing its running attempt is refused", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const canonicalPath = join(environment.selectedOutputPath, "cover-letter.txt");
  writeFileSync(
    canonicalPath,
    committedLetterText(environment).replace(
      "calm engineering judgment",
      "calm engineering rigor",
    ),
    "utf8",
  );

  revise(environment, "write_cover_letter", {
    adopt: true,
    attemptId: "attempt_revise_letter_080",
    channel: "manual_file",
    publicationIdFactory: () => "publication_adopt_letter_020",
  });
  // The journal write that creates the resting state also left the step running, so the retry the
  // procedure documents has to close that attempt first — re-running --adopt straight away is a
  // hard refusal, not an idempotent re-entry.
  assert.equal(readStep(environment, "write_cover_letter").state, "running");
  assert.throws(
    () => revise(environment, "write_cover_letter", {
      adopt: true,
      attemptId: "attempt_revise_letter_081",
      channel: "manual_file",
    }),
    (error) => error.code === "invalid_step_transition",
  );
  assert.equal(
    readFileSync(canonicalPath, "utf8").includes("calm engineering rigor"),
    true,
    "the refusal leaves the user's bytes in the canonical slot",
  );
});

test("an interrupted adoption has a defined resting state and re-enters idempotently by digest", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const canonicalPath = join(environment.selectedOutputPath, "cover-letter.txt");
  const editedText = committedLetterText(environment).replace(
    "calm engineering judgment",
    "calm engineering rigor",
  );
  writeFileSync(canonicalPath, editedText, "utf8");

  revise(environment, "write_cover_letter", {
    adopt: true,
    attemptId: "attempt_revise_letter_070",
    channel: "manual_file",
    publicationIdFactory: () => "publication_adopt_letter_010",
  });
  failFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName: "write_cover_letter",
      attemptId: "attempt_revise_letter_070",
      error: {
        code: "revision_abandoned",
        message: "The session was interrupted before publication.",
        retryable: true,
        details: [],
      },
    },
    { clock: () => nextTimestamp() },
  );

  const step = readStep(environment, "write_cover_letter");
  assert.equal(step.state, "completed");
  assert.ok(step.adoption_base, "the adoption base survives the closed attempt");
  const report = deepReport(environment);
  const letter = deepStep(report, "write_cover_letter");
  assert.equal(letter.artifact_health, "adoption_pending");
  assert.ok(letter.issues.includes("adoption_pending"));
  assert.ok(
    !letter.issues.includes("artifact_corrupt"),
    "an open adoption base reports adoption pending rather than corruption",
  );

  const reentered = revise(environment, "write_cover_letter", {
    adopt: true,
    attemptId: "attempt_revise_letter_071",
    channel: "manual_file",
  });
  assert.equal(reentered.adoption.publication_id, "publication_adopt_letter_010",
    "an adoption retry re-enters the same journaled base by digest match");

  const published = publish(
    environment,
    "write_cover_letter",
    "attempt_revise_letter_071",
    "publication_adopt_letter_010",
  );
  assert.equal(published.state, "completed");
  assert.ok(!readStep(environment, "write_cover_letter").adoption_base);
});

test("the production CLI drives a waived revision through the safe input-file transport", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const [firstTerm] = briefKeywordTerms(environment);

  mkdirSync(join(environment.workspaceRoot, ".pipeline-input"), { mode: 0o700 });
  const inputRoot = realpathSync(join(environment.workspaceRoot, ".pipeline-input"));
  const nonce = "0123456789abcdef0123456789abcdef";
  const basename = `input-${nonce}.json`;
  writeFileSync(
    join(inputRoot, basename),
    `${JSON.stringify({
      schemaVersion: 1,
      command: "revise-step",
      nonce,
      values: {
        waivers: [{
          subject: { kind: "check", key: "letter_keyword:0" },
          note: "Пользователь принял риск ATS.",
        }],
      },
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );

  const cliChildPath = resolve(repoRoot, "tests/fixtures/process-log-cli-child.mjs");
  const runCli = (...args) => spawnSync(process.execPath, [cliChildPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...disposableWorkspaceEnv(environment),
      JOB_PIPELINE_INPUT_ROOT: inputRoot,
    },
  });

  const revised = runCli(
    "revise-step",
    "--id", processId,
    "--step", "write_cover_letter",
    "--channel", "chat_command",
    "--input-file", basename,
  );
  assert.equal(revised.status, 0, revised.stderr);
  const opened = JSON.parse(revised.stdout);
  assert.equal(opened.status, "revision_opened");
  assert.equal(opened.operation, "revise");
  assert.equal(
    opened.pending_waivers[0].note,
    "Пользователь принял риск ATS.",
    "the waiver note travels the transport verbatim as bounded data",
  );

  stageLetter(environment, "publication_cli_revise_001", (text) =>
    text.replaceAll(firstTerm, "redacted-term"));
  const published = runCli(
    "publish-step",
    "--id", processId,
    "--step", "write_cover_letter",
    "--attempt-id", opened.attempt_id,
    "--publication-id", "publication_cli_revise_001",
    "--outcome", "completed",
  );
  assert.equal(published.status, 0, published.stderr);
  const result = JSON.parse(published.stdout);
  assert.equal(result.state, "completed");
  assert.deepEqual(result.open_conflicts, []);
  assert.equal(result.notices.length, 1);
  const step = readStep(environment, "write_cover_letter");
  assert.equal(step.waivers.length, 1);
  assert.equal(step.waivers[0].note, "Пользователь принял риск ATS.");
});

function letterBodyLineRange(lines) {
  let signatureIndex = lines.length - 1;
  while (signatureIndex >= 0 && lines[signatureIndex].trim() === "") signatureIndex -= 1;
  return { bodyStart: 2, bodyEnd: signatureIndex - 1 };
}

function bodyWordCount(letterText) {
  const lines = letterText.split("\n");
  const { bodyStart, bodyEnd } = letterBodyLineRange(lines);
  const body = lines.slice(bodyStart, bodyEnd).join("\n");
  const segmenter = new Intl.Segmenter("en", { granularity: "word" });
  return [...segmenter.segment(body)].filter((segment) => segment.isWordLike).length;
}

function padLetterBodyTo(letterText, targetWords) {
  const extra = targetWords - bodyWordCount(letterText);
  assert.ok(extra > 0, "the fixture letter must sit below the target");
  const lines = letterText.split("\n");
  let lastBodyIndex = letterBodyLineRange(lines).bodyEnd - 1;
  while (lines[lastBodyIndex].trim() === "") lastBodyIndex -= 1;
  lines[lastBodyIndex] = `${lines[lastBodyIndex]} ${Array.from({ length: extra }, () => "more").join(" ")}`;
  const padded = lines.join("\n");
  assert.equal(bodyWordCount(padded), targetWords);
  return padded;
}

test("a length approval is bounded by the candidate's config, and a broken layer refuses under its own code", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const configPath = join(environment.workspaceRoot, "candidate", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));

  // The range is the layer's: with the approval cap lowered to 270, an approval of 280 is out of it.
  writeFileSync(configPath, `${JSON.stringify({
    ...config,
    letter: { ...config.letter, body_words: { ...config.letter.body_words, approved_max: 270 } },
  })}\n`);
  assert.throws(
    () => revise(environment, "write_cover_letter", {
      attemptId: "attempt_revise_words_capped",
      waivers: [{ subject: { kind: "check", key: "letter_body_words_max:280" } }],
    }),
    (error) => error.code === "invalid_waiver_input" && /at most 270/.test(error.message),
  );

  // Without the config the number cannot be judged at all, and the refusal says why: a broken
  // layer is not a wrong number, so it is never reported under the input's code.
  rmSync(configPath);
  assert.throws(
    () => revise(environment, "write_cover_letter", {
      attemptId: "attempt_revise_words_no_layer",
      waivers: [{ subject: { kind: "check", key: "letter_body_words_max:280" } }],
    }),
    { code: "candidate_config_missing" },
  );
  assert.equal(readStep(environment, "write_cover_letter").active_attempt, null);
});

test("a journaled word-limit approval lets a longer letter publish and holds for later revisions", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");

  for (const key of [
    "letter_body_words_max:260",
    "letter_body_words_max:301",
    "letter_body_words_max:+20",
    "letter_body_words_max:10%",
  ]) {
    assert.throws(
      () => revise(environment, "write_cover_letter", {
        attemptId: `attempt_revise_words_refused_${key.length}`,
        waivers: [{ subject: { kind: "check", key } }],
      }),
      { code: "invalid_waiver_input" },
      `${key} is not a bounded absolute approval`,
    );
  }
  assert.equal(readStep(environment, "write_cover_letter").active_attempt, null);

  const opened = revise(environment, "write_cover_letter", {
    attemptId: "attempt_revise_words_001",
    waivers: [{
      subject: { kind: "check", key: "letter_body_words_max:280" },
      note: "Пользователь: пусть будет длиннее, до 280 слов.",
    }],
  });
  assert.equal(opened.status, "revision_opened");
  assert.deepEqual(opened.sibling_decision_waivers, []);

  stageLetter(environment, "publication_words_001", (text) => padLetterBodyTo(text, 275));
  const published = publish(
    environment,
    "write_cover_letter",
    "attempt_revise_words_001",
    "publication_words_001",
  );
  assert.equal(published.status, "completed");
  assert.deepEqual(published.open_conflicts, []);
  assert.equal(published.notices.length, 1);
  assert.equal(published.notices[0].code, "letter_body_words");
  assert.deepEqual(published.notices[0].subject, {
    kind: "check",
    key: "letter_body_words_max:280",
  });
  const [approval] = readStep(environment, "write_cover_letter").waivers;
  assert.equal(published.notices[0].waiver_id, approval.id);
  assert.equal(bodyWordCount(committedLetterText(environment)), 275);

  const again = revise(environment, "write_cover_letter", {
    attemptId: "attempt_revise_words_002",
  });
  assert.deepEqual(
    again.active_waivers.map((waiver) => waiver.subject.key),
    ["letter_body_words_max:280"],
    "the approval holds for the next revision of the same letter",
  );
  stageLetter(environment, "publication_words_002", (text) => padLetterBodyTo(text, 281));
  assert.throws(
    () => publish(environment, "write_cover_letter", "attempt_revise_words_002", "publication_words_002"),
    { code: "candidate_bundle_invalid" },
    "281 words exceed the approved 280 and stay a hard error",
  );
});

test("a decision waiver on one material is visible to the other before authoring and at revision, scoped to the brief digest", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const preflightOf = (stepName) => preflightFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName },
    lifecycleEnvironment(environment),
  );
  assert.deepEqual(preflightOf("generate_cv").sibling_decision_waivers, []);
  assert.deepEqual(preflightOf("write_cover_letter").sibling_decision_waivers, []);
  assert.equal(
    "sibling_decision_waivers" in preflightOf("map_experience"),
    false,
    "only the two material steps carry the field",
  );

  // CV -> letter: a decision waiver recorded on the CV step is what the letter reads.
  const cvOpened = revise(environment, "generate_cv", {
    attemptId: "attempt_revise_sibling_cv_000",
    waivers: [{ subject: { kind: "decision", key: "positioning.selectedLevers" } }],
  });
  stageCv(environment, "publication_sibling_cv_000");
  publish(environment, "generate_cv", cvOpened.attempt_id, "publication_sibling_cv_000");
  const [cvWaiver] = readStep(environment, "generate_cv").waivers;
  const fromCv = [{ id: cvWaiver.id, key: "positioning.selectedLevers", step: "generate_cv" }];
  assert.deepEqual(preflightOf("write_cover_letter").sibling_decision_waivers, fromCv);
  assert.deepEqual(preflightOf("generate_cv").sibling_decision_waivers, []);

  // letter -> CV: and the other way round, with the note carried.
  const opened = revise(environment, "write_cover_letter", {
    attemptId: "attempt_revise_sibling_001",
    waivers: [{
      subject: { kind: "decision", key: "positioning.angleHint" },
      note: "Угол про варианты поставки убран как догадка о задачах команды.",
    }],
  });
  stageLetter(environment, "publication_sibling_001");
  publish(environment, "write_cover_letter", opened.attempt_id, "publication_sibling_001");
  const [letterWaiver] = readStep(environment, "write_cover_letter").waivers;

  const expected = [{
    id: letterWaiver.id,
    key: "positioning.angleHint",
    note: "Угол про варианты поставки убран как догадка о задачах команды.",
    step: "write_cover_letter",
  }];
  assert.deepEqual(opened.sibling_decision_waivers, fromCv, "the letter's revision reads the CV's waiver at open");
  assert.deepEqual(preflightOf("generate_cv").sibling_decision_waivers, expected);
  assert.deepEqual(
    preflightOf("write_cover_letter").sibling_decision_waivers,
    fromCv,
    "a step never sees its own waivers as sibling ones",
  );
  const cvRevision = revise(environment, "generate_cv", { attemptId: "attempt_revise_sibling_cv_001" });
  assert.deepEqual(cvRevision.sibling_decision_waivers, expected);
  assert.deepEqual(
    cvRevision.active_waivers.map((waiver) => waiver.id),
    [cvWaiver.id],
    "the sibling's waiver is read, not copied into this step's own waiver set",
  );
  failFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName: "generate_cv",
      attemptId: "attempt_revise_sibling_cv_001",
      error: { code: "abandoned", message: "Cancelled by the user.", retryable: true, details: [] },
    },
    { ...lifecycleEnvironment(environment), clock: () => nextTimestamp() },
  );

  const reopened = reopenFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName: "write_cover_letter" },
    {
      ...lifecycleEnvironment(environment),
      attemptIdFactory: () => "attempt_reopen_sibling_letter_001",
      clock: () => nextTimestamp(),
    },
  );
  assert.equal(reopened.status, "reopened");
  assert.deepEqual(
    preflightOf("generate_cv").sibling_decision_waivers,
    expected,
    "an open re-authoring has not superseded anything yet",
  );
  stageLetter(environment, "publication_sibling_reauthored_001");
  publish(
    environment,
    "write_cover_letter",
    "attempt_reopen_sibling_letter_001",
    "publication_sibling_reauthored_001",
  );
  assert.equal(readStep(environment, "write_cover_letter").waivers[0].status, "superseded");
  assert.deepEqual(
    preflightOf("generate_cv").sibling_decision_waivers,
    [],
    "a superseded record is no longer visible",
  );
  assert.deepEqual(
    preflightOf("write_cover_letter").sibling_decision_waivers,
    fromCv,
    "re-authoring the letter leaves the CV's own record active",
  );
});

test("a crash between ledger commit and archive heals through reconcile and through the next open", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");

  revise(environment, "write_cover_letter", { attemptId: "attempt_revise_letter_080" });
  const firstId = "publication_revise_letter_080";
  stageLetter(environment, firstId, (text) =>
    text.replace("calm engineering judgment", "calm engineering rigor"));
  assert.throws(
    () => publish(environment, "write_cover_letter", "attempt_revise_letter_080", firstId, {
      failAt: "after_ledger_commit",
    }),
    (error) => error.code === "simulated_publication_crash",
  );
  const committed = readStep(environment, "write_cover_letter");
  assert.equal(committed.state, "completed");
  assert.equal(committed.attempt_history.at(-1).publication_id, firstId);
  assert.equal(existsSync(archivePath(environment, firstId, "cover-letter.txt")), false);
  assert.ok(
    deepStep(deepReport(environment), "write_cover_letter")
      .issues.includes("revision_archive_missing"),
  );

  const reconciled = reconcileFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName: "write_cover_letter",
      attemptId: "attempt_revise_letter_080",
      publicationId: firstId,
    },
    { ...lifecycleEnvironment(environment), clock: () => nextTimestamp() },
  );
  assert.equal(reconciled.status, "cleaned");
  assert.equal(
    readFileSync(archivePath(environment, firstId, "cover-letter.txt"), "utf8")
      .includes("calm engineering rigor"),
    true,
    "reconcile completes the archive before removing the transaction directory",
  );
  assert.equal(
    existsSync(join(environment.selectedOutputPath, ".pipeline-tmp", firstId)),
    false,
  );
  assert.equal(deepReport(environment).health, "current");

  revise(environment, "write_cover_letter", { attemptId: "attempt_revise_letter_081" });
  const secondId = "publication_revise_letter_081";
  stageLetter(environment, secondId, (text) =>
    text.replace("calm engineering rigor", "calm engineering judgment"));
  assert.throws(
    () => publish(environment, "write_cover_letter", "attempt_revise_letter_081", secondId, {
      failAt: "after_ledger_commit",
    }),
    (error) => error.code === "simulated_publication_crash",
  );
  assert.equal(existsSync(archivePath(environment, secondId, "cover-letter.txt")), false);

  // No reconcile this time: the next revise-step open completes the interrupted archive while
  // the committed bytes still exist on disk, so a subsequent publication cannot orphan them.
  revise(environment, "write_cover_letter", { attemptId: "attempt_revise_letter_082" });
  assert.equal(
    readFileSync(archivePath(environment, secondId, "cover-letter.txt"), "utf8")
      .includes("calm engineering judgment"),
    true,
    "the next revision open completes the previous publication's archive",
  );
  const thirdId = "publication_revise_letter_082";
  stageLetter(environment, thirdId, (text) =>
    text.replace("calm engineering judgment", "calm engineering rigor"));
  const republished = publish(
    environment,
    "write_cover_letter",
    "attempt_revise_letter_082",
    thirdId,
  );
  assert.equal(republished.state, "completed");
  assert.equal(
    existsSync(archivePath(environment, secondId, "cover-letter.txt")),
    true,
    "every published version stays recoverable",
  );
});

test("a prepared revise transaction recovers through tokened reconcile with waivers journaled", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const [firstTerm] = briefKeywordTerms(environment);

  revise(environment, "write_cover_letter", {
    attemptId: "attempt_revise_letter_090",
    waivers: [{ subject: { kind: "check", key: "letter_keyword:0" } }],
  });
  const publicationId = "publication_revise_letter_090";
  stageLetter(environment, publicationId, (text) =>
    text.replaceAll(firstTerm, "redacted-term"));
  assert.throws(
    () => publish(environment, "write_cover_letter", "attempt_revise_letter_090", publicationId, {
      failAt: "before_ledger_commit",
    }),
    (error) => error.code === "simulated_publication_crash",
  );
  assert.ok(
    readStep(environment, "write_cover_letter").publication_transaction,
    "the crash leaves a prepared revise transaction",
  );

  const recovered = reconcileFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName: "write_cover_letter",
      attemptId: "attempt_revise_letter_090",
      publicationId,
    },
    { ...lifecycleEnvironment(environment), clock: () => nextTimestamp() },
  );
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.state, "completed");
  const step = readStep(environment, "write_cover_letter");
  assert.equal(step.state, "completed");
  assert.equal(step.waivers.length, 1);
  assert.equal(step.waivers[0].status, "active");
  assert.deepEqual(step.attempt_history.at(-1).open_conflicts, []);
  assertArchivedPublication(environment, "write_cover_letter", publicationId);
  assert.equal(deepReport(environment).health, "current");
});

test("a failed revise publication rolls back to the adopted bytes and keeps the resting state", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const canonicalPath = join(environment.selectedOutputPath, "cover-letter.txt");
  const editedText = committedLetterText(environment).replace(
    "calm engineering judgment",
    "calm engineering rigor",
  );
  writeFileSync(canonicalPath, editedText, "utf8");

  revise(environment, "write_cover_letter", {
    adopt: true,
    attemptId: "attempt_revise_letter_100",
    channel: "manual_file",
    publicationIdFactory: () => "publication_adopt_letter_100",
  });
  assert.throws(
    () => publish(
      environment,
      "write_cover_letter",
      "attempt_revise_letter_100",
      "publication_adopt_letter_100",
      { failAt: { boundary: "after_backup:cover_letter", crash: false } },
    ),
    (error) => error.code === "publication_failed",
  );

  const step = readStep(environment, "write_cover_letter");
  assert.equal(step.state, "completed", "rollback restores the pre-attempt mark");
  assert.equal(
    readFileSync(canonicalPath, "utf8"),
    editedText,
    "rollback restores the user's adopted bytes, proven by the journaled divergent digest",
  );
  assert.ok(step.adoption_base, "the adoption base survives the rolled-back publication");
  const report = deepStep(deepReport(environment), "write_cover_letter");
  assert.equal(report.artifact_health, "adoption_pending");
});

test("a brief tampered after revise-step open is refused at publication and restores the mark", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const briefPath = join(environment.selectedOutputPath, "application-brief.json");
  const briefBytes = readFileSync(briefPath);
  const committedBytes = readFileSync(
    join(environment.selectedOutputPath, "cover-letter.txt"),
  );

  revise(environment, "write_cover_letter", { attemptId: "attempt_revise_letter_110" });
  const publicationId = "publication_revise_letter_110";
  stageLetter(environment, publicationId, (text) =>
    text.replace("calm engineering judgment", "calm engineering rigor"));
  writeFileSync(briefPath, `${JSON.stringify(JSON.parse(briefBytes.toString("utf8")), null, 4)}\n`);
  assert.throws(
    () => publish(environment, "write_cover_letter", "attempt_revise_letter_110", publicationId),
    (error) => error.code === "brief_superseded",
    "the brief coherence guard is re-verified under the ledger lock at publication",
  );
  const step = readStep(environment, "write_cover_letter");
  assert.equal(step.state, "completed");
  assert.equal(step.error, null);
  const entry = step.attempt_history.at(-1);
  assert.equal(entry.outcome, "failed");
  assert.equal(entry.operation, "revise");
  assert.equal(entry.error_code, "brief_superseded");
  assert.deepEqual(
    readFileSync(join(environment.selectedOutputPath, "cover-letter.txt")),
    committedBytes,
  );
  writeFileSync(briefPath, briefBytes);
  rmSync(join(environment.selectedOutputPath, ".pipeline-tmp", publicationId), {
    force: true,
    recursive: true,
  });
  assert.equal(deepReport(environment).health, "current");
});

test("reopen --adopt archives the divergent bytes and a failed adopted re-authoring exits through retry", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const briefPath = join(environment.selectedOutputPath, "application-brief.json");
  const briefBytes = readFileSync(briefPath);
  const canonicalPath = join(environment.selectedOutputPath, "cover-letter.txt");
  const editedText = committedLetterText(environment).replace(
    "calm engineering judgment",
    "calm engineering rigor",
  );

  const reopenedBrief = reopenFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName: "map_experience" },
    {
      ...lifecycleEnvironment(environment),
      attemptIdFactory: () => "attempt_reopen_brief_120",
      clock: () => nextTimestamp(),
    },
  );
  writeFileSync(
    join(stageDirectory(environment, "publication_reopen_brief_120"), "application-brief.json"),
    `${JSON.stringify(JSON.parse(briefBytes.toString("utf8")), null, 4)}\n`,
  );
  publish(environment, "map_experience", reopenedBrief.attempt_id, "publication_reopen_brief_120");
  writeFileSync(canonicalPath, editedText, "utf8");

  assert.throws(
    () => revise(environment, "write_cover_letter", { adopt: true, channel: "manual_file" }),
    (error) => error.code === "brief_superseded",
    "a light revision is refused against a superseded brief",
  );
  assert.throws(
    () => reopenFileBackedStepV3(
      environment.ledgerPath,
      { selector, stepName: "write_cover_letter" },
      {
        ...lifecycleEnvironment(environment),
        attemptIdFactory: () => "attempt_reopen_letter_120",
        clock: () => nextTimestamp(),
      },
    ),
    (error) => error.code === "artifact_corrupt",
    "a plain reopen still reports the divergence as corruption",
  );

  const adopted = reopenFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName: "write_cover_letter", adopt: true },
    {
      ...lifecycleEnvironment(environment),
      adoptionIdFactory: () => "adoption_letter_120",
      attemptIdFactory: () => "attempt_reopen_letter_121",
      clock: () => nextTimestamp(),
    },
  );
  assert.equal(adopted.status, "reopened");
  assert.equal(adopted.adoption.phase, "archived");
  assert.equal(
    readFileSync(archivePath(environment, "adoption_letter_120", "cover-letter.txt"), "utf8"),
    editedText,
    "the reopen adoption archives the user's bytes before the re-authoring can discard them",
  );

  failFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName: "write_cover_letter",
      attemptId: "attempt_reopen_letter_121",
      error: {
        code: "render_failed",
        message: "A synthetic re-authoring failure.",
        retryable: true,
        details: [],
      },
    },
    { clock: () => nextTimestamp() },
  );
  const failedStep = readStep(environment, "write_cover_letter");
  assert.equal(failedStep.state, "failed");
  assert.ok(failedStep.adoption_base, "the adoption base survives the failed re-authoring");

  const retried = retryFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName: "write_cover_letter" },
    {
      ...lifecycleEnvironment(environment),
      attemptIdFactory: () => "attempt_retry_letter_122",
      clock: () => nextTimestamp(),
    },
  );
  assert.equal(retried.status, "retried",
    "retry re-enters the journaled adoption instead of reporting corruption");
  assert.equal(
    readStep(environment, "write_cover_letter").adoption_base.attempt_id,
    "attempt_retry_letter_122",
    "the adoption base is rebound to the retry attempt",
  );

  const publicationId = "publication_retry_letter_122";
  writeFileSync(
    join(stageDirectory(environment, publicationId), "cover-letter.txt"),
    editedText,
    "utf8",
  );
  const published = publish(
    environment,
    "write_cover_letter",
    "attempt_retry_letter_122",
    publicationId,
  );
  assert.equal(published.status, "completed");
  assert.ok(!readStep(environment, "write_cover_letter").adoption_base);
  const letterReport = deepStep(deepReport(environment), "write_cover_letter");
  assert.equal(letterReport.state, "completed");
  assert.deepEqual(
    letterReport.issues,
    [],
    "the re-authored letter is healthy; the sibling generate_cv legitimately stays stale",
  );
});

test("a material re-authoring supersedes waivers even when it republishes identical bytes", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const [firstTerm] = briefKeywordTerms(environment);

  revise(environment, "write_cover_letter", {
    attemptId: "attempt_revise_letter_130",
    waivers: [{ subject: { kind: "check", key: "letter_keyword:0" } }],
  });
  const waivedId = "publication_revise_letter_130";
  stageLetter(environment, waivedId, (text) =>
    text.replaceAll(firstTerm, "redacted-term"));
  publish(environment, "write_cover_letter", "attempt_revise_letter_130", waivedId);
  assert.equal(readStep(environment, "write_cover_letter").waivers[0].status, "active");

  const reopened = reopenFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName: "write_cover_letter" },
    {
      ...lifecycleEnvironment(environment),
      attemptIdFactory: () => "attempt_reopen_letter_130",
      clock: () => nextTimestamp(),
    },
  );
  const republishId = "publication_reopen_letter_130";
  stageLetter(environment, republishId);
  assert.throws(
    () => publish(environment, "write_cover_letter", reopened.attempt_id, republishId),
    (error) => error.code === "candidate_bundle_invalid",
    "a reopened publication no longer honors the waiver",
  );
  failFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName: "write_cover_letter",
      attemptId: reopened.attempt_id,
      error: {
        code: "render_failed",
        message: "A synthetic re-authoring failure, for the retry.",
        retryable: true,
        details: [],
      },
    },
    { clock: () => nextTimestamp() },
  );

  const retried = retryFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName: "write_cover_letter" },
    {
      ...lifecycleEnvironment(environment),
      attemptIdFactory: () => "attempt_retry_letter_131",
      clock: () => nextTimestamp(),
    },
  );
  assert.equal(retried.status, "retried");
  const restoredId = "publication_retry_letter_131";
  stageLetter(environment, restoredId, (text) =>
    text.replaceAll("redacted-term", firstTerm));
  const restored = publish(
    environment,
    "write_cover_letter",
    "attempt_retry_letter_131",
    restoredId,
  );
  assert.equal(restored.status, "completed");
  assert.equal(
    readStep(environment, "write_cover_letter").waivers[0].status,
    "superseded",
    "a changed-bytes re-authoring supersedes the waiver",
  );

  const compliant = revise(environment, "write_cover_letter", {
    attemptId: "attempt_revise_letter_132",
    waivers: [{ subject: { kind: "check", key: "letter_keyword:1" } }],
  });
  assert.equal(compliant.status, "revision_opened");
  const compliantId = "publication_revise_letter_132";
  stageLetter(environment, compliantId);
  publish(environment, "write_cover_letter", "attempt_revise_letter_132", compliantId);
  const waivers = readStep(environment, "write_cover_letter").waivers;
  assert.equal(waivers.at(-1).status, "active");

  const reopenedIdentical = reopenFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName: "write_cover_letter" },
    {
      ...lifecycleEnvironment(environment),
      attemptIdFactory: () => "attempt_reopen_letter_133",
      clock: () => nextTimestamp(),
    },
  );
  const identicalId = "publication_reopen_letter_133";
  stageLetter(environment, identicalId);
  const republished = publish(
    environment,
    "write_cover_letter",
    reopenedIdentical.attempt_id,
    identicalId,
  );
  assert.equal(
    republished.revision,
    readStep(environment, "write_cover_letter").revision,
    "identical bytes keep the revision counter",
  );
  assert.equal(
    readStep(environment, "write_cover_letter").waivers.at(-1).status,
    "superseded",
    "an explicit re-authoring supersedes waivers regardless of the resulting bytes",
  );
});

test("deep validation reports a corrupted or missing revision archive entry", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const archived = archivePath(
    environment,
    "publication_fixture_write_cover_letter_001",
    "cover-letter.txt",
  );
  const archivedBytes = readFileSync(archived);

  writeFileSync(archived, "tampered archive bytes\n", "utf8");
  let report = deepStep(deepReport(environment), "write_cover_letter");
  assert.ok(report.issues.includes("revision_archive_corrupt"));

  const opened = revise(environment, "write_cover_letter", {
    attemptId: "attempt_revise_letter_160",
  });
  assert.equal(
    opened.status,
    "revision_opened",
    "a tampered archive copy degrades deep health but never wedges an attempt open",
  );
  assert.equal(
    readFileSync(archived, "utf8"),
    "tampered archive bytes\n",
    "the completion pass skips the mismatched entry for deep validation to report",
  );
  failFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName: "write_cover_letter",
      attemptId: "attempt_revise_letter_160",
      error: {
        code: "revision_abandoned",
        message: "A synthetic close after the archive check.",
        retryable: true,
        details: [],
      },
    },
    { clock: () => nextTimestamp() },
  );

  rmSync(archived);
  report = deepStep(deepReport(environment), "write_cover_letter");
  assert.ok(report.issues.includes("revision_archive_missing"));

  writeFileSync(archived, archivedBytes);
  assert.equal(deepReport(environment).health, "current");
});

test("a divergent DOCX adopts with its bytes archived and a deliberate rebuild publishes", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const cv = committedCv(environment);
  const canonicalDocxPath = join(environment.selectedOutputPath, cv.fileName);
  const userDocxBytes = Buffer.from("user-edited docx bytes, the only copy\n");
  writeFileSync(canonicalDocxPath, userDocxBytes);

  const adopted = revise(environment, "generate_cv", {
    adopt: true,
    attemptId: "attempt_revise_cv_140",
    channel: "manual_file",
    publicationIdFactory: () => "publication_adopt_cv_140",
  });
  assert.deepEqual(
    adopted.adoption.entries.map((entry) => entry.kind),
    ["cv_docx"],
  );
  assert.deepEqual(
    readFileSync(archivePath(environment, adopted.adoption.id, cv.fileName)),
    userDocxBytes,
    "the user's DOCX bytes are archived before the rebuild can discard them",
  );

  const staging = join(
    environment.selectedOutputPath,
    ".pipeline-tmp",
    "publication_adopt_cv_140",
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(staging, "cv.json"), "utf8")),
    cv,
    "the staging copy carries the committed cv.json for the deliberate rebuild",
  );
  writeFileSync(join(staging, cv.fileName), createDocxBytes({ cv }));
  const published = publish(
    environment,
    "generate_cv",
    "attempt_revise_cv_140",
    "publication_adopt_cv_140",
  );
  assert.equal(published.status, "completed");
  assert.ok(!readStep(environment, "generate_cv").adoption_base);
  assert.equal(deepReport(environment).health, "current");
});

test("the docx_sync channel binds to the CV bundle and to an adoption, and journals its own name", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const cv = committedCv(environment);
  const canonicalDocxPath = join(environment.selectedOutputPath, cv.fileName);

  // The letter bundle has no document, so the channel that addresses one is refused there rather
  // than journaling a channel that cannot describe what was edited (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#5-edit-channels-and-transports(c)).
  assert.throws(
    () => revise(environment, "write_cover_letter", {
      adopt: true,
      attemptId: "attempt_revise_letter_docx",
      channel: "docx_sync",
    }),
    (error) => error.code === "invalid_revise_step_input"
      && /docx_sync channel is defined only for generate_cv/.test(error.message),
  );
  // A DOCX edit is divergence by definition: an attempt opened without an adoption would journal
  // `docx_sync` over an edit that never came out of a document.
  assert.throws(
    () => revise(environment, "generate_cv", {
      attemptId: "attempt_revise_cv_docx_unadopted",
      channel: "docx_sync",
    }),
    (error) => error.code === "invalid_revise_step_input"
      && /docx_sync channel requires adopt/.test(error.message),
  );
  // Chat directs an edit this step authors; there are no divergent bytes for it to adopt.
  assert.throws(
    () => revise(environment, "generate_cv", {
      adopt: true,
      attemptId: "attempt_revise_cv_chat_adopt",
      channel: "chat_command",
    }),
    (error) => error.code === "invalid_revise_step_input"
      && /adopt requires the manual_file or docx_sync channel/.test(error.message),
  );
  const untouched = readStep(environment, "generate_cv");
  assert.equal(untouched.state, "completed");
  assert.equal(untouched.active_attempt, null);
  assert.ok(!untouched.adoption_base, "a refused revision journals no adoption base");

  const userDocxBytes = Buffer.from("user-edited docx bytes, the only copy\n");
  writeFileSync(canonicalDocxPath, userDocxBytes);
  const adopted = revise(environment, "generate_cv", {
    adopt: true,
    attemptId: "attempt_revise_cv_160",
    channel: "docx_sync",
    publicationIdFactory: () => "publication_docx_sync_160",
  });
  assert.equal(adopted.channel, "docx_sync");
  assert.deepEqual(adopted.adoption.entries.map((entry) => entry.kind), ["cv_docx"]);
  // The two inputs the reverse sync needs: the user's document, archived and digest-bound, and the
  // committed source in staging as the base the extractor aligns it against.
  assert.deepEqual(adopted.adoption.staged_paths, ["cv.json"]);
  assert.deepEqual(
    readFileSync(archivePath(environment, adopted.adoption.id, cv.fileName)),
    userDocxBytes,
  );
  const staging = join(
    environment.selectedOutputPath,
    ".pipeline-tmp",
    "publication_docx_sync_160",
  );
  assert.deepEqual(JSON.parse(readFileSync(join(staging, "cv.json"), "utf8")), cv);

  writeFileSync(join(staging, cv.fileName), createDocxBytes({ cv, marker: "docx-sync" }));
  const published = publish(
    environment,
    "generate_cv",
    "attempt_revise_cv_160",
    "publication_docx_sync_160",
  );
  assert.equal(published.status, "completed");
  const journaled = readStep(environment, "generate_cv").attempt_history.at(-1);
  assert.equal(journaled.operation, "revise");
  assert.equal(journaled.channel, "docx_sync");
  assert.equal(deepReport(environment).health, "current");
});

test("the reverse sync refuses a divergence it cannot align the document against", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const cv = committedCv(environment);
  const canonicalCvPath = join(environment.selectedOutputPath, "cv.json");
  const canonicalDocxPath = join(environment.selectedOutputPath, cv.fileName);
  const committedCvBytes = readFileSync(canonicalCvPath);

  // Only cv.json diverged. `adoption_target_unchanged` does not fire — something did diverge — so
  // without this refusal the channel would open on a document nobody edited, journal `docx_sync`
  // for an edit that never came out of one, and leave the procedure without an archived document
  // to read.
  const editedCv = committedCv(environment);
  editedCv.sections[0].text = "Hand-edited summary line.";
  writeFileSync(canonicalCvPath, `${JSON.stringify(editedCv, null, 2)}\n`, "utf8");
  assert.throws(
    () => revise(environment, "generate_cv", {
      adopt: true,
      attemptId: "attempt_revise_cv_170",
      channel: "docx_sync",
    }),
    (error) => error.code === "docx_sync_target_unchanged",
  );

  // Both files diverged. Staging would carry the user's own cv.json while the document was rendered
  // from the committed one, so every edit they made in cv.json would read as a difference the
  // document does not have — and the sync would write it back out. Refusing keeps both halves of
  // their work; choosing between them is the user's call, not this command's.
  writeFileSync(canonicalDocxPath, Buffer.from("user-edited docx bytes\n"));
  assert.throws(
    () => revise(environment, "generate_cv", {
      adopt: true,
      attemptId: "attempt_revise_cv_171",
      channel: "docx_sync",
    }),
    (error) => error.code === "docx_sync_source_diverged",
  );

  const untouched = readStep(environment, "generate_cv");
  assert.equal(untouched.state, "completed");
  assert.equal(untouched.active_attempt, null);
  assert.ok(!untouched.adoption_base, "a refused scope journals no adoption base");
  assert.deepEqual(
    readFileSync(canonicalCvPath, "utf8"),
    `${JSON.stringify(editedCv, null, 2)}\n`,
    "the user's own edits stay exactly where they left them",
  );
  assert.notDeepEqual(readFileSync(canonicalCvPath), committedCvBytes);

  // The manual_file channel still adopts the same state, which is the exit the procedure names.
  const adopted = revise(environment, "generate_cv", {
    adopt: true,
    attemptId: "attempt_revise_cv_172",
    channel: "manual_file",
    publicationIdFactory: () => "publication_adopt_cv_172",
  });
  assert.deepEqual(
    adopted.adoption.entries.map((entry) => entry.kind).sort(),
    ["cv_docx", "cv_source"],
  );
});

test("an adoption interrupted before the staging copy re-enters from the journaled phase", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const canonicalPath = join(environment.selectedOutputPath, "cover-letter.txt");
  const editedText = committedLetterText(environment).replace(
    "calm engineering judgment",
    "calm engineering rigor",
  );
  writeFileSync(canonicalPath, editedText, "utf8");

  const firstAdoption = revise(environment, "write_cover_letter", {
    adopt: true,
    attemptId: "attempt_revise_letter_150",
    channel: "manual_file",
    publicationIdFactory: () => "publication_adopt_letter_150",
  });
  failFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName: "write_cover_letter",
      attemptId: "attempt_revise_letter_150",
      error: {
        code: "revision_abandoned",
        message: "A synthetic interruption before the copy.",
        retryable: true,
        details: [],
      },
    },
    { clock: () => nextTimestamp() },
  );

  // Reconstruct the pre-copy crash window: the journal write landed, the copy did not.
  const ledger = JSON.parse(readFileSync(environment.ledgerPath, "utf8"));
  const letter = ledger.processes.find((record) => record.id === processId)
    .steps.write_cover_letter;
  letter.adoption_base.phase = "journaled";
  writeFileSync(environment.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  rmSync(
    join(environment.selectedOutputPath, ".pipeline-tmp", "publication_adopt_letter_150"),
    { recursive: true, force: true },
  );
  const adoptionArchivePath = archivePath(
    environment,
    firstAdoption.adoption.id,
    "cover-letter.txt",
  );
  writeFileSync(adoptionArchivePath, "tampered adoption archive bytes\n", "utf8");

  const reentered = revise(environment, "write_cover_letter", {
    adopt: true,
    attemptId: "attempt_revise_letter_151",
    channel: "manual_file",
  });
  assert.equal(reentered.adoption.publication_id, "publication_adopt_letter_150");
  assert.equal(reentered.adoption.phase, "staged");
  assert.equal(
    readFileSync(adoptionArchivePath, "utf8"),
    editedText,
    "re-entry repairs a tampered adoption archive copy from the digest-proven canonical bytes",
  );
  assert.equal(
    readFileSync(
      join(
        environment.selectedOutputPath,
        ".pipeline-tmp",
        "publication_adopt_letter_150",
        "cover-letter.txt",
      ),
      "utf8",
    ),
    editedText,
    "re-entry from the journaled phase completes the staging copy",
  );
});

test("a manually edited cv.json adopts, rebuilds the DOCX, and publishes", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const canonicalCvPath = join(environment.selectedOutputPath, "cv.json");
  const editedCv = committedCv(environment);
  editedCv.sections[0].text = "Senior Quality Engineer with TypeScript depth.";
  writeFileSync(canonicalCvPath, `${JSON.stringify(editedCv, null, 2)}\n`, "utf8");

  const adopted = revise(environment, "generate_cv", {
    adopt: true,
    attemptId: "attempt_revise_cv_020",
    channel: "manual_file",
    publicationIdFactory: () => "publication_adopt_cv_001",
  });
  assert.deepEqual(
    adopted.adoption.entries.map((entry) => entry.kind),
    ["cv_source"],
  );
  const staging = join(
    environment.selectedOutputPath,
    ".pipeline-tmp",
    "publication_adopt_cv_001",
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(staging, "cv.json"), "utf8")),
    editedCv,
  );
  writeFileSync(join(staging, editedCv.fileName), createDocxBytes({ cv: editedCv }));

  const published = publish(
    environment,
    "generate_cv",
    "attempt_revise_cv_020",
    "publication_adopt_cv_001",
  );
  assert.equal(published.state, "completed");
  assert.ok(!readStep(environment, "generate_cv").adoption_base);
  assert.equal(deepReport(environment).health, "current");
});

test("the CV routing the procedure documents holds: unchanged bytes refuse adoption, a hand-edited DOCX refuses the chat channel", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const cv = committedCv(environment);
  const canonicalCvPath = join(environment.selectedOutputPath, "cv.json");
  const canonicalDocxPath = join(environment.selectedOutputPath, cv.fileName);
  const committedCvBytes = readFileSync(canonicalCvPath);

  // "The user says they edited the file" is not evidence that they did: a re-save of identical
  // bytes has nothing to adopt, and the procedure routes that back to the chat-command channel
  // instead of opening an adoption that would journal a base with no divergence in it.
  assert.throws(
    () => revise(environment, "generate_cv", {
      adopt: true,
      attemptId: "attempt_revise_cv_200",
      channel: "manual_file",
    }),
    (error) => error.code === "adoption_target_unchanged",
  );
  const untouched = readStep(environment, "generate_cv");
  assert.equal(untouched.state, "completed");
  assert.equal(untouched.active_attempt, null);
  assert.ok(!untouched.adoption_base, "a refused adoption journals no base");

  // A DOCX edited in place is divergence like any other, so the chat-command channel — which
  // verifies the committed baseline of every artifact in the bundle — refuses it. Without this
  // the procedure's "run --adopt instead" instruction would have no machine behind it.
  writeFileSync(canonicalDocxPath, Buffer.from("hand-edited docx bytes\n"));
  assert.throws(
    () => revise(environment, "generate_cv", {
      attemptId: "attempt_revise_cv_201",
      channel: "chat_command",
    }),
    (error) => error.code === "artifact_corrupt",
  );
  assert.deepEqual(
    readFileSync(canonicalCvPath),
    committedCvBytes,
    "the refusal leaves the committed source exactly where it was",
  );
  assert.equal(readStep(environment, "generate_cv").state, "completed");
});

test("an open adoption whose divergence healed opens an ordinary revision with no adoption", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const canonicalCvPath = join(environment.selectedOutputPath, "cv.json");
  const committedBytes = readFileSync(canonicalCvPath);
  const edited = committedCv(environment);
  edited.sections[0].text = "Hand-edited summary line.";
  writeFileSync(canonicalCvPath, `${JSON.stringify(edited, null, 2)}\n`, "utf8");

  revise(environment, "generate_cv", {
    adopt: true,
    attemptId: "attempt_revise_cv_210",
    channel: "manual_file",
    publicationIdFactory: () => "publication_adopt_cv_210",
  });
  failFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName: "generate_cv",
      attemptId: "attempt_revise_cv_210",
      error: {
        code: "revision_abandoned",
        message: "The user cancelled the revision.",
        retryable: true,
        details: [],
      },
    },
    { clock: () => nextTimestamp() },
  );
  assert.ok(readStep(environment, "generate_cv").adoption_base, "the base survives the close");

  // The user puts the committed bytes back before the documented re-entry. `adoption_target_
  // unchanged` is the no-base branch only: with a base open, the command drops it and opens a
  // plain revision — no adoption, no publication id, and no staging copy written for you.
  writeFileSync(canonicalCvPath, committedBytes);
  const reopened = revise(environment, "generate_cv", {
    adopt: true,
    attemptId: "attempt_revise_cv_211",
    channel: "manual_file",
  });
  assert.equal(reopened.status, "revision_opened");
  assert.equal(reopened.adoption, undefined);
  assert.ok(!readStep(environment, "generate_cv").adoption_base);
});

test("a revision that renames the published document is refused at publication", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  const committedBytes = readFileSync(join(environment.selectedOutputPath, "cv.json"));
  const committedDocx = committedCv(environment).fileName;

  revise(environment, "generate_cv", { attemptId: "attempt_revise_cv_220" });
  // A "rename the CV file" review remark is a canonical-path change, which a revision may not
  // make: the procedure routes it to reopen-step because of exactly this refusal.
  stageCv(environment, "publication_revise_cv_220", (cv) => ({
    ...cv,
    fileName: cv.fileName.replace(".docx", "_v2.docx"),
  }));
  assert.throws(
    () => publish(
      environment,
      "generate_cv",
      "attempt_revise_cv_220",
      "publication_revise_cv_220",
    ),
    (error) => error.code === "artifact_path_revision_conflict",
  );
  assert.deepEqual(
    readFileSync(join(environment.selectedOutputPath, "cv.json")),
    committedBytes,
    "the refused rename leaves the committed pair alone",
  );
  assert.equal(
    existsSync(join(environment.selectedOutputPath, committedDocx)),
    true,
  );

  // The guard is keyed to the content revision, not to the operation, so the re-authoring
  // entrypoint is refused in exactly the same way: after the first publication the bundle's
  // canonical paths are fixed and the rename has no lifecycle route at all.
  failFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName: "generate_cv",
      attemptId: "attempt_revise_cv_220",
      error: {
        code: "revision_abandoned",
        message: "The user cancelled the revision.",
        retryable: true,
        details: [],
      },
    },
    { clock: () => nextTimestamp() },
  );
  reopenFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName: "generate_cv", adopt: false },
    {
      ...lifecycleEnvironment(environment),
      attemptIdFactory: () => "attempt_reopen_cv_220",
      clock: () => nextTimestamp(),
    },
  );
  stageCv(environment, "publication_reopen_cv_220", (cv) => ({
    ...cv,
    fileName: cv.fileName.replace(".docx", "_v2.docx"),
  }));
  assert.throws(
    () => publish(
      environment,
      "generate_cv",
      "attempt_reopen_cv_220",
      "publication_reopen_cv_220",
    ),
    (error) => error.code === "artifact_path_revision_conflict",
    "a re-authoring cannot rename the published document either",
  );
});

test("the word-limit approval is available at a first publication and journals like a revision's", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "generate_cv");
  const begun = beginLetter(environment, "attempt_first_letter_145");
  assert.equal(begun.status, "started");
  const staged = stageFirstLetter(environment, "publication_first_letter_145", (text) =>
    padLetterBodyTo(text, 275));
  assert.equal(bodyWordCount(staged), 275);

  assert.throws(
    () => publish(
      environment,
      "write_cover_letter",
      "attempt_first_letter_145",
      "publication_first_letter_145",
    ),
    { code: "candidate_bundle_invalid" },
    "without the approval a 275-word first publication is still refused",
  );
  assert.throws(
    () => publish(
      environment,
      "write_cover_letter",
      "attempt_first_letter_145",
      "publication_first_letter_145",
      { waivers: [{ subject: { kind: "check", key: "letter_body_words_max:270" } }] },
    ),
    { code: "candidate_bundle_invalid" },
    "275 words exceed an approval of 270",
  );
  const refusedStep = readStep(environment, "write_cover_letter");
  assert.equal(refusedStep.state, "running");
  assert.equal("pending_waivers" in refusedStep.active_attempt, false, "a refusal journals nothing");
  assert.equal("waivers" in refusedStep, false);

  const published = publish(
    environment,
    "write_cover_letter",
    "attempt_first_letter_145",
    "publication_first_letter_145",
    {
      waivers: [{
        subject: { kind: "check", key: "letter_body_words_max:280" },
        note: "Пользователь: прочитал черновик, публикуй как есть.",
      }],
    },
  );
  assert.equal(published.status, "completed");
  assert.equal(published.revision, 1);
  assert.equal("open_conflicts" in published, false, "open conflicts stay a revision's report");
  assert.equal(published.notices.length, 1);
  assert.equal(published.notices[0].code, "letter_body_words");
  assert.equal(published.waivers_recorded.length, 1);

  const step = readStep(environment, "write_cover_letter");
  assert.equal(step.active_attempt, null);
  const [approval] = step.waivers;
  assert.equal(approval.status, "active");
  assert.equal(approval.subject.key, "letter_body_words_max:280");
  assert.equal(approval.note, "Пользователь: прочитал черновик, публикуй как есть.");
  assert.equal(published.notices[0].waiver_id, approval.id);
  assert.equal(
    approval.brief_digest,
    step.published_inputs.find((entry) => entry.kind === "application_brief").sha256,
    "the approval is pinned to the brief the attempt published from",
  );
  assert.equal(bodyWordCount(committedLetterText(environment)), 275);
  assert.equal(deepReport(environment).health, "current");

  const later = revise(environment, "write_cover_letter", {
    attemptId: "attempt_revise_after_first_145",
  });
  assert.deepEqual(
    later.active_waivers.map((waiver) => waiver.subject.key),
    ["letter_body_words_max:280"],
    "the approval holds for later revisions, exactly as one journaled at a revision's open",
  );
});

test("publish-step takes the word-limit approval and nothing else", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "generate_cv");
  beginLetter(environment, "attempt_first_letter_146");
  stageFirstLetter(environment, "publication_first_letter_146", (text) =>
    padLetterBodyTo(text, 275));
  const attempt = (waivers) => publish(
    environment,
    "write_cover_letter",
    "attempt_first_letter_146",
    "publication_first_letter_146",
    { waivers },
  );

  assert.throws(
    () => attempt([{ subject: { kind: "check", key: "letter_keyword:0" } }]),
    { code: "invalid_publish_step_input" },
    "a keyword finding of a first publication is not waivable",
  );
  assert.throws(
    () => attempt([{ subject: { kind: "decision", key: "coverLetterPlan.evidenceIds" } }]),
    { code: "invalid_publish_step_input" },
    "a brief decision travels through revise-step",
  );
  assert.throws(
    () => attempt([
      { subject: { kind: "check", key: "letter_body_words_max:275" } },
      { subject: { kind: "check", key: "letter_body_words_max:280" } },
    ]),
    { code: "invalid_publish_step_input" },
    "one approval, not a set",
  );
  for (const key of [
    "letter_body_words_max:260",
    "letter_body_words_max:301",
    "letter_body_words_max:+20",
    "letter_body_words_max:10%",
  ]) {
    assert.throws(
      () => attempt([{ subject: { kind: "check", key } }]),
      { code: "invalid_waiver_input" },
      `${key} is not a bounded absolute approval`,
    );
  }
  const step = readStep(environment, "write_cover_letter");
  assert.equal(step.state, "running");
  assert.equal("pending_waivers" in step.active_attempt, false);
});

test("a first publication of the CV, and a revision of either material, refuse a publish-step waiver", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "map_experience");
  const begunCv = beginFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName: "generate_cv" },
    {
      ...lifecycleEnvironment(environment),
      attemptIdFactory: () => "attempt_first_cv_147",
      clock: () => nextTimestamp(),
    },
  );
  assert.throws(
    () => publish(environment, "generate_cv", begunCv.attempt_id, "publication_first_cv_147", {
      waivers: [{ subject: { kind: "check", key: "letter_body_words_max:280" } }],
    }),
    { code: "invalid_publish_step_input" },
    "the approval is the letter's, and only the letter's",
  );
  failFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName: "generate_cv",
      attemptId: begunCv.attempt_id,
      error: {
        code: "render_failed",
        message: "A synthetic failure that closes the attempt.",
        retryable: true,
        details: [],
      },
    },
    { clock: () => nextTimestamp() },
  );

  const fresh = createEnvironment(t, "process-log-v3-revision-147b-");
  runThrough(fresh, "write_cover_letter");
  revise(fresh, "write_cover_letter", { attemptId: "attempt_revise_letter_147" });
  stageLetter(fresh, "publication_revise_letter_147", (text) => padLetterBodyTo(text, 275));
  assert.throws(
    () => publish(fresh, "write_cover_letter", "attempt_revise_letter_147", "publication_revise_letter_147", {
      waivers: [{ subject: { kind: "check", key: "letter_body_words_max:280" } }],
    }),
    { code: "invalid_publish_step_input" },
    "a revision supplies its waivers at its own open",
  );
});

test("an approval the published bytes did not need is refused instead of journaled", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "generate_cv");
  beginLetter(environment, "attempt_first_letter_148");
  stageFirstLetter(environment, "publication_first_letter_148");

  assert.throws(
    () => publish(
      environment,
      "write_cover_letter",
      "attempt_first_letter_148",
      "publication_first_letter_148",
      { waivers: [{ subject: { kind: "check", key: "letter_body_words_max:280" } }] },
    ),
    { code: "waiver_not_applicable" },
    "a draft inside the default limit does not raise the ceiling of every later revision",
  );

  const published = publish(
    environment,
    "write_cover_letter",
    "attempt_first_letter_148",
    "publication_first_letter_148",
  );
  assert.equal(published.status, "completed");
  assert.equal("waivers_recorded" in published, false);
  const step = readStep(environment, "write_cover_letter");
  assert.equal("waivers" in step, false);
});

test("a first publication interrupted after its journal write recovers with the approval intact", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "generate_cv");
  beginLetter(environment, "attempt_first_letter_149");
  const publicationId = "publication_first_letter_149";
  stageFirstLetter(environment, publicationId, (text) => padLetterBodyTo(text, 275));

  assert.throws(
    () => publish(environment, "write_cover_letter", "attempt_first_letter_149", publicationId, {
      failAt: "before_ledger_commit",
      waivers: [{ subject: { kind: "check", key: "letter_body_words_max:280" } }],
    }),
    (error) => error.code === "simulated_publication_crash",
  );
  const interrupted = readStep(environment, "write_cover_letter");
  assert.ok(interrupted.publication_transaction, "the crash leaves a prepared transaction");
  assert.equal(
    interrupted.active_attempt.pending_waivers[0].subject.key,
    "letter_body_words_max:280",
    "the approval is journaled with the transaction, or recovery would roll a valid publication back",
  );

  const recovered = reconcileFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName: "write_cover_letter",
      attemptId: "attempt_first_letter_149",
      publicationId,
    },
    { ...lifecycleEnvironment(environment), clock: () => nextTimestamp() },
  );
  assert.equal(recovered.status, "completed");
  const step = readStep(environment, "write_cover_letter");
  assert.equal(step.state, "completed");
  assert.equal(step.waivers.length, 1, "the approval is journaled exactly once");
  assert.equal(step.waivers[0].subject.key, "letter_body_words_max:280");
  assert.equal(step.waivers[0].status, "active");
  assert.equal(
    "pending_waivers" in (step.active_attempt ?? {}),
    false,
    "the attempt-scoped copy does not outlive the publication that journaled it",
  );
  assert.equal(bodyWordCount(committedLetterText(environment)), 275);
  assert.equal(deepReport(environment).health, "current");
});

test("the production CLI carries the length approval into a first publication", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "generate_cv");
  const begun = beginLetter(environment, "attempt_cli_first_letter_150");
  const publicationId = "publication_cli_first_letter_150";
  stageFirstLetter(environment, publicationId, (text) => padLetterBodyTo(text, 275));

  mkdirSync(join(environment.workspaceRoot, ".pipeline-input"), { mode: 0o700 });
  const inputRoot = realpathSync(join(environment.workspaceRoot, ".pipeline-input"));
  const nonce = "89abcdef0123456789abcdef01234567";
  const basename = `input-${nonce}.json`;
  writeFileSync(
    join(inputRoot, basename),
    `${JSON.stringify({
      schemaVersion: 1,
      command: "publish-step",
      nonce,
      values: {
        waivers: [{
          subject: { kind: "check", key: "letter_body_words_max:280" },
          note: "Пользователь: прочитал черновик, публикуй как есть.",
        }],
      },
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );

  const cliChildPath = resolve(repoRoot, "tests/fixtures/process-log-cli-child.mjs");
  const published = spawnSync(
    process.execPath,
    [
      cliChildPath,
      "publish-step",
      "--id", processId,
      "--step", "write_cover_letter",
      "--attempt-id", begun.attempt_id,
      "--publication-id", publicationId,
      "--outcome", "completed",
      "--input-file", basename,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ...disposableWorkspaceEnv(environment),
        JOB_PIPELINE_INPUT_ROOT: inputRoot,
      },
    },
  );
  assert.equal(published.status, 0, published.stderr);
  const result = JSON.parse(published.stdout);
  assert.equal(result.status, "completed");
  assert.equal(result.waivers_recorded.length, 1);
  assert.equal(result.notices[0].code, "letter_body_words");
  const step = readStep(environment, "write_cover_letter");
  assert.equal(step.waivers.length, 1);
  assert.equal(
    step.waivers[0].note,
    "Пользователь: прочитал черновик, публикуй как есть.",
    "the approval note travels the transport verbatim as bounded data",
  );
  assert.equal(bodyWordCount(committedLetterText(environment)), 275);
});

test("a first publication still refuses a brief-coupled finding, and says which one", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "generate_cv");
  beginLetter(environment, "attempt_first_letter_151");
  const [firstTerm] = briefKeywordTerms(environment);
  stageFirstLetter(environment, "publication_first_letter_151", (text) =>
    text.replaceAll(firstTerm, "redacted-term"));

  assert.throws(
    () => publish(
      environment,
      "write_cover_letter",
      "attempt_first_letter_151",
      "publication_first_letter_151",
    ),
    (error) => {
      assert.equal(error.code, "candidate_bundle_invalid");
      assert.match(
        error.message,
        /cover-letter\.txt body must contain planned keyword at index 0/,
        "outside a revision the finding is an error, and it reads as the sentence it is",
      );
      return true;
    },
  );
});

test("a reopen-step re-authoring carries its own approval and inherits none", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "generate_cv");
  beginLetter(environment, "attempt_first_letter_152");
  stageFirstLetter(environment, "publication_first_letter_152", (text) =>
    padLetterBodyTo(text, 270));
  publish(
    environment,
    "write_cover_letter",
    "attempt_first_letter_152",
    "publication_first_letter_152",
    { waivers: [{ subject: { kind: "check", key: "letter_body_words_max:270" } }] },
  );
  const [firstApproval] = readStep(environment, "write_cover_letter").waivers;
  assert.equal(firstApproval.status, "active");

  const reopened = reopenFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName: "write_cover_letter" },
    {
      ...lifecycleEnvironment(environment),
      attemptIdFactory: () => "attempt_reopen_letter_152",
      clock: () => nextTimestamp(),
    },
  );
  // 265 words sit above the default 260 and below the 270 the previous publication approved, so
  // this refusal happens only because the re-authoring does not inherit that approval.
  stageFirstLetter(environment, "publication_reopen_letter_152", (text) =>
    padLetterBodyTo(text, 265));
  assert.throws(
    () => publish(
      environment,
      "write_cover_letter",
      reopened.attempt_id,
      "publication_reopen_letter_152",
    ),
    { code: "candidate_bundle_invalid" },
    "the previous publication's approval is not inherited by a re-authoring",
  );

  const republished = publish(
    environment,
    "write_cover_letter",
    reopened.attempt_id,
    "publication_reopen_letter_152",
    { waivers: [{ subject: { kind: "check", key: "letter_body_words_max:280" } }] },
  );
  assert.equal(republished.status, "completed");
  assert.equal(republished.waivers_recorded.length, 1);

  const waivers = readStep(environment, "write_cover_letter").waivers;
  assert.equal(waivers.length, 2);
  assert.equal(waivers[0].status, "superseded", "the re-authoring supersedes the old approval");
  assert.equal(waivers[1].status, "active", "and never supersedes the one it was just given");
  assert.equal(waivers[1].subject.key, "letter_body_words_max:280");
  assert.equal(bodyWordCount(committedLetterText(environment)), 265);
  assert.equal(deepReport(environment).health, "current");
});

// A candidate constraint holds on a revision, which is the whole reason it does not travel as a
// conflict. ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#3-conflicts-and-waivers says a brief-coupled deterministic failure does not block a revision
// publication, and the branches above show it: on a revision the CV's findings become reported
// conflicts and `errors` is never read. A personal ban filed there would refuse the first
// publication and wave through every re-publication after it.
function seedCandidateConstraint(environment, constraint) {
  const root = join(environment.workspaceRoot, "candidate");
  mkdirSync(root, { recursive: true });
  copyFileSync(resolve(repoRoot, "candidate.example/config.json"), join(root, "config.json"));
  cpSync(resolve(repoRoot, "candidate.example/languages"), join(root, "languages"), { recursive: true });
  writeFileSync(
    join(root, "constraints.json"),
    JSON.stringify({ schema_version: 1, constraints: [constraint] }),
    "utf8",
  );
}

test("a candidate constraint refuses a cv revision, where a conflict would not", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  seedCandidateConstraint(environment, {
    id: "no-introducer-name",
    type: "forbid_phrases",
    scope: { materials: ["cv"] },
    phrases: ["Jordan Vale"],
    why: "A private contact asked not to be named.",
  });

  revise(environment, "generate_cv", { attemptId: "attempt_revise_cv_constraint" });
  const publicationId = "publication_revise_cv_constraint";
  stageCv(environment, publicationId, (cv) => {
    cv.sections[0].text = "Senior Quality Engineer introduced by Jordan Vale.";
    return cv;
  });
  const beforeLedger = readFileSync(environment.ledgerPath, "utf8");
  assert.throws(
    () => publish(environment, "generate_cv", "attempt_revise_cv_constraint", publicationId),
    (error) =>
      error.code === "candidate_bundle_invalid"
      && error.message.includes('candidate constraint "no-introducer-name"')
      && !error.message.includes("Jordan Vale"),
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeLedger);
});

test("a candidate constraint refuses a cover-letter revision too", (t) => {
  const environment = createEnvironment(t);
  runThrough(environment, "write_cover_letter");
  seedCandidateConstraint(environment, {
    id: "no-introducer-name",
    type: "forbid_phrases",
    scope: { materials: ["cover_letter"] },
    phrases: ["Jordan Vale"],
    why: "A private contact asked not to be named.",
  });

  revise(environment, "write_cover_letter", { attemptId: "attempt_revise_letter_constraint" });
  const publicationId = "publication_revise_letter_constraint";
  const staging = stageDirectory(environment, publicationId);
  const lines = readFileSync(
    join(environment.selectedOutputPath, "cover-letter.txt"),
    "utf8",
  ).split("\n");
  const firstBody = lines.findIndex((line, index) => index >= 2 && line !== "");
  lines[firstBody] = `Jordan Vale wrote first. ${lines[firstBody]}`;
  writeFileSync(join(staging, "cover-letter.txt"), lines.join("\n"), "utf8");
  assert.throws(
    () => publish(environment, "write_cover_letter", "attempt_revise_letter_constraint", publicationId),
    (error) =>
      error.code === "candidate_bundle_invalid"
      && error.message.includes('candidate constraint "no-introducer-name"'),
  );
});
