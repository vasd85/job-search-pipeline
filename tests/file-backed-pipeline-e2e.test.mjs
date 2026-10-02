import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readLogV3 } from "../tools/lib/process-log-core.mjs";
import {
  beginFileBackedStepV3,
  fileBackedProtectedInputs,
  linkFileBackedProcessDuplicateV3,
  publishFileBackedStepV3,
  reconcileFileBackedStepV3,
  reopenFileBackedStepV3,
  reserveFileBackedOutputV3,
  startFileBackedProcessV3,
  updateFileBackedProcessV3,
  validateProcessLogV3Deep,
} from "../tools/lib/process-log-v3-lifecycle.mjs";
import { sha256Hex } from "../tools/pipeline-artifacts/validation.mjs";
import {
  createDisposableWorkspace,
  disposableWorkspaceEnv,
} from "./fixtures/disposable-workspace.mjs";
import { runFixtureStep } from "./fixtures/file-backed-pipeline-producer.mjs";
import { protectedInputSource, seedCandidateConfig } from "./fixtures/protected-inputs.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const producerPath = resolve(
  repoRoot,
  "tests/fixtures/file-backed-pipeline-producer.mjs",
);
const processId = "proc_fixture_step1_completed";
const sourceRef = "https://example.test/jobs/senior-quality-engineer";
const outputDir = "output/example-labs-senior-quality-engineer";
const stepNames = Object.freeze([
  "get_vacancy",
  "research_company",
  "map_experience",
  "generate_cv",
  "write_cover_letter",
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

function createEnvironment(t, prefix = "file-backed-pipeline-e2e-") {
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

  const started = startFileBackedProcessV3(
    ledgerPath,
    {
      sourceRef,
      runner: "codex",
    },
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
    {
      clock: () => "2026-07-27T08:05:00.000Z",
    },
  );
  const reserved = reserveFileBackedOutputV3(
    ledgerPath,
    { processId },
    {
      ...lifecycleEnvironment({ outputRoot, workspaceRoot }),
      clock: () => "2026-07-27T08:06:00.000Z",
    },
  );
  assert.equal(started.status, "created");
  assert.equal(reserved.output_dir, outputDir);
  return {
    ...disposable,
    ledgerPath,
    outputRoot,
    selectedOutputPath: resolve(workspaceRoot, outputDir),
    workspaceRoot,
  };
}

function runChild(environment, stepName, selector = { id: processId }) {
  return spawnSync(process.execPath, [producerPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      FILE_BACKED_FIXTURE_SELECTOR: JSON.stringify(selector),
      FILE_BACKED_FIXTURE_STEP: stepName,
      ...disposableWorkspaceEnv(environment),
    },
  });
}

function runChildSuccess(environment, stepName, selector = { id: processId }) {
  const result = runChild(environment, stepName, selector);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(
    result.stdout,
    /Responsibilities|application-brief|company-research/,
    "fixture child must return only a compact result, never an upstream artifact body",
  );
  return JSON.parse(result.stdout);
}

function runChildFailure(environment, stepName, selector = { id: processId }) {
  const result = runChild(environment, stepName, selector);
  assert.notEqual(result.status, 0, result.stdout);
  return JSON.parse(result.stderr);
}

function runThrough(environment, finalStep) {
  const finalIndex = stepNames.indexOf(finalStep);
  for (const stepName of stepNames.slice(0, finalIndex + 1)) {
    runFixtureStep(environment, stepName, { id: processId });
  }
}

function completedSnapshot(environment) {
  const report = validateProcessLogV3Deep(
    environment.ledgerPath,
    lifecycleEnvironment(environment),
  );
  assert.equal(report.health, "current");
  const processRecord = readLogV3(environment.ledgerPath).processes.find(
    (record) => record.id === processId,
  );
  assert.deepEqual(
    stepNames.map((stepName) => processRecord.steps[stepName].state),
    stepNames.map(() => "completed"),
  );
  const artifacts = Object.fromEntries(
    stepNames.flatMap((stepName) =>
      processRecord.steps[stepName].artifacts.map((artifact) => [
        artifact.kind,
        {
          metadata: artifact,
          bytes: readFileSync(
            join(environment.selectedOutputPath, artifact.path),
          ).toString("base64"),
        },
      ])),
  );
  return {
    artifacts,
    steps: processRecord.steps,
  };
}

function startAdditionalProcess(environment, {
  company = "Other Labs",
  duplicateOf = null,
  id,
  role = "Senior Quality Engineer",
  source,
}) {
  const started = startFileBackedProcessV3(
    environment.ledgerPath,
    {
      sourceRef: source,
      runner: "codex",
      duplicateOf,
    },
    {
      attemptIdFactory: () => `attempt_${id}_get_vacancy_001`,
      clock: () => "2026-07-27T10:00:00.000Z",
      processIdFactory: () => id,
    },
  );
  if (started.status !== "created") return started;
  updateFileBackedProcessV3(
    environment.ledgerPath,
    {
      processId: id,
      companyObserved: company,
      role,
    },
    { clock: () => "2026-07-27T10:01:00.000Z" },
  );
  return reserveFileBackedOutputV3(
    environment.ledgerPath,
    { processId: id },
    {
      ...lifecycleEnvironment(environment),
      clock: () => "2026-07-27T10:02:00.000Z",
    },
  );
}

test("selector-only child processes and one sequential parent publish identical complete bundles", (t) => {
  const crossProcess = createEnvironment(t, "file-backed-cross-process-");
  for (const stepName of stepNames) {
    const result = runChildSuccess(crossProcess, stepName);
    assert.equal(result.process_id, processId);
    assert.equal(result.step_name, stepName);
    assert.equal(result.status, "completed");
  }

  const sequential = createEnvironment(t, "file-backed-sequential-");
  for (const stepName of stepNames) {
    const result = runFixtureStep(sequential, stepName, { id: processId });
    assert.equal(result.status, "completed");
  }

  assert.deepEqual(
    completedSnapshot(crossProcess),
    completedSnapshot(sequential),
  );
});

test("a linked process publishes its own complete bundle, and linking leaves its steps untouched", (t) => {
  // Task 010, the two criteria that need a whole run to show: a process linked to a predecessor
  // that arrived through a different source publishes exactly what an unlinked one publishes, and
  // declaring the link afterwards does not redo or disturb a step that already finished.
  const unlinked = createEnvironment(t, "file-backed-duplicate-unlinked-");
  for (const stepName of stepNames) {
    assert.equal(runFixtureStep(unlinked, stepName, { id: processId }).status, "completed");
  }

  const linked = createEnvironment(t, "file-backed-duplicate-linked-");
  for (const stepName of stepNames) {
    assert.equal(runFixtureStep(linked, stepName, { id: processId }).status, "completed");
  }
  const snapshotBeforeLink = completedSnapshot(linked);
  const predecessor = startAdditionalProcess(linked, {
    id: "proc_fixture_dead_posting",
    source: "https://apply.example.test/gone/j/ABC",
  });
  const predecessorBefore = JSON.stringify(
    readLogV3(linked.ledgerPath).processes
      .find((candidate) => candidate.id === predecessor.process.id),
  );

  const link = linkFileBackedProcessDuplicateV3(linked.ledgerPath, {
    processId,
    duplicateOf: predecessor.process.id,
  });
  assert.equal(link.status, "linked");
  assert.equal(link.cross_source_link.code, "cross_source_duplicate_link");

  assert.deepEqual(completedSnapshot(linked), snapshotBeforeLink);
  assert.deepEqual(completedSnapshot(linked), completedSnapshot(unlinked));

  const log = readLogV3(linked.ledgerPath);
  const record = log.processes.find((candidate) => candidate.id === processId);
  assert.equal(record.duplicate_of, predecessor.process.id);
  assert.notEqual(record.output_dir, null);
  // Provenance only: the predecessor is not touched at all, and the two keep separate outputs.
  const predecessorRecord = log.processes
    .find((candidate) => candidate.id === predecessor.process.id);
  assert.equal(JSON.stringify(predecessorRecord), predecessorBefore);
  assert.notEqual(predecessorRecord.output_dir, record.output_dir);
});

test("missing, changed, and temp-only upstream artifacts fail before Step 2 starts", async (t) => {
  await t.test("missing committed file", (subtest) => {
    const environment = createEnvironment(subtest, "file-backed-missing-");
    runThrough(environment, "get_vacancy");
    unlinkSync(join(environment.selectedOutputPath, "job-description.txt"));
    const before = readFileSync(environment.ledgerPath, "utf8");

    assert.equal(
      runChildFailure(environment, "research_company").code,
      "artifact_missing",
    );
    assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
  });

  await t.test("digest-changing edit", (subtest) => {
    const environment = createEnvironment(subtest, "file-backed-corrupt-");
    runThrough(environment, "get_vacancy");
    appendFileSync(
      join(environment.selectedOutputPath, "job-description.txt"),
      "\nchanged outside the publisher\n",
      "utf8",
    );
    const before = readFileSync(environment.ledgerPath, "utf8");

    assert.equal(
      runChildFailure(environment, "research_company").code,
      "artifact_corrupt",
    );
    assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
  });

  await t.test("only transaction-owned temporary bytes remain", (subtest) => {
    const environment = createEnvironment(subtest, "file-backed-temp-only-");
    runThrough(environment, "get_vacancy");
    const temporary = join(
      environment.selectedOutputPath,
      ".pipeline-tmp",
      "orphan",
    );
    mkdirSync(temporary, { recursive: true });
    copyFileSync(
      join(environment.selectedOutputPath, "vacancy.json"),
      join(temporary, "vacancy.json"),
    );
    unlinkSync(join(environment.selectedOutputPath, "vacancy.json"));
    const before = readFileSync(environment.ledgerPath, "utf8");

    assert.equal(
      runChildFailure(environment, "research_company").code,
      "artifact_missing",
    );
    assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
  });
});

test("cross-process artifact reuse and an ambiguous selector fail closed", async (t) => {
  await t.test("another process cannot publish the first process artifact", (subtest) => {
    const environment = createEnvironment(subtest, "file-backed-cross-owner-");
    runThrough(environment, "get_vacancy");
    const otherId = "proc_fixture_other_owner";
    const other = startAdditionalProcess(environment, {
      id: otherId,
      source: "https://other.example.test/jobs/senior-quality-engineer",
    });
    const publicationId = "publication_fixture_cross_owner_001";
    const staging = join(
      environment.workspaceRoot,
      other.output_dir,
      ".pipeline-tmp",
      publicationId,
    );
    mkdirSync(staging, { recursive: true });
    copyFileSync(
      join(environment.selectedOutputPath, "job-description.txt"),
      join(staging, "job-description.txt"),
    );
    copyFileSync(
      join(environment.selectedOutputPath, "vacancy.json"),
      join(staging, "vacancy.json"),
    );
    const otherRecord = readLogV3(environment.ledgerPath).processes.find(
      (record) => record.id === otherId,
    );
    const before = readFileSync(environment.ledgerPath, "utf8");

    assert.throws(
      () => publishFileBackedStepV3(
        environment.ledgerPath,
        {
          selector: { id: otherId },
          stepName: "get_vacancy",
          attemptId: otherRecord.steps.get_vacancy.active_attempt.id,
          publicationId,
          outcome: "completed",
          blocker: null,
        },
        lifecycleEnvironment(environment),
      ),
      (error) => error.code === "candidate_bundle_invalid",
    );
    assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
  });

  await t.test("source selector with two file-backed attempts is ambiguous", (subtest) => {
    const environment = createEnvironment(subtest, "file-backed-ambiguous-");
    const duplicateId = "proc_fixture_duplicate_source";
    startFileBackedProcessV3(
      environment.ledgerPath,
      {
        sourceRef,
        runner: "codex",
        duplicateOf: processId,
      },
      {
        attemptIdFactory: () => "attempt_fixture_duplicate_source_001",
        clock: () => "2026-07-27T10:10:00.000Z",
        processIdFactory: () => duplicateId,
      },
    );
    const before = readFileSync(environment.ledgerPath, "utf8");

    assert.equal(
      runChildFailure(
        environment,
        "get_vacancy",
        { sourceRef },
      ).code,
      "process_ambiguous",
    );
    assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
  });
});

test("a reopened Step 1 rejects mismatched company/title before replacing canonical bytes", (t) => {
  const environment = createEnvironment(t, "file-backed-identity-mismatch-");
  runThrough(environment, "get_vacancy");
  const attemptId = "attempt_fixture_get_vacancy_identity_reopen";
  const publicationId = "publication_fixture_get_vacancy_identity_mismatch";
  reopenFileBackedStepV3(
    environment.ledgerPath,
    {
      selector: { id: processId },
      stepName: "get_vacancy",
    },
    {
      attemptIdFactory: () => attemptId,
      clock: () => "2026-07-27T10:20:00.000Z",
      ...lifecycleEnvironment(environment),
    },
  );
  const staging = join(
    environment.selectedOutputPath,
    ".pipeline-tmp",
    publicationId,
  );
  mkdirSync(staging, { recursive: true });
  copyFileSync(
    join(environment.selectedOutputPath, "job-description.txt"),
    join(staging, "job-description.txt"),
  );
  const vacancy = JSON.parse(
    readFileSync(join(environment.selectedOutputPath, "vacancy.json"), "utf8"),
  );
  vacancy.role.company = "Mismatched Candidate Company";
  vacancy.role.title = "Mismatched Candidate Role";
  writeFileSync(
    join(staging, "vacancy.json"),
    `${JSON.stringify(vacancy, null, 2)}\n`,
    "utf8",
  );
  const beforeLedger = readFileSync(environment.ledgerPath, "utf8");
  const beforeJobDescription = readFileSync(
    join(environment.selectedOutputPath, "job-description.txt"),
  );
  const beforeVacancy = readFileSync(
    join(environment.selectedOutputPath, "vacancy.json"),
  );

  assert.throws(
    () => publishFileBackedStepV3(
      environment.ledgerPath,
      {
        selector: { id: processId },
        stepName: "get_vacancy",
        attemptId,
        publicationId,
        outcome: "completed",
        blocker: null,
      },
      lifecycleEnvironment(environment),
    ),
    (error) =>
      error.code === "candidate_bundle_invalid"
      && error.message.includes(
        "role.company does not match the selected ledger process",
      )
      && error.message.includes(
        "role.title does not match the selected ledger process",
      ),
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeLedger);
  assert.deepEqual(
    readFileSync(join(environment.selectedOutputPath, "job-description.txt")),
    beforeJobDescription,
  );
  assert.deepEqual(
    readFileSync(join(environment.selectedOutputPath, "vacancy.json")),
    beforeVacancy,
  );
});

test("protected profile drift after Step 3 blocks both fresh generation consumers", (t) => {
  const environment = createEnvironment(t, "file-backed-profile-drift-");
  runThrough(environment, "map_experience");
  appendFileSync(
    resolve(environment.workspaceRoot, "candidate/profile.md"),
    "\nSynthetic post-Step-3 profile drift.\n",
    "utf8",
  );
  const before = readFileSync(environment.ledgerPath, "utf8");

  assert.equal(
    runChildFailure(environment, "generate_cv").code,
    "prerequisite_stale",
  );
  assert.equal(
    runChildFailure(environment, "write_cover_letter").code,
    "prerequisite_stale",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

// The brief of this fixture selects lever 1 under the broad register. Giving lever 1 the
// ai-infrastructure property makes that brief break a register rule the validator reads from the
// bank, so the case tells a stale prerequisite from a corrupt brief: the bank is compared with the
// one Step 3 published from before the brief is validated against it.
function giveLeverOneTheInfrastructureProperty(environment) {
  const path = resolve(environment.workspaceRoot, "candidate/levers.md");
  const bank = readFileSync(path, "utf8");
  const edited = bank.replace(
    "## Lever 1\n\nStatement: A test framework run as a maintained product.\nWeight: 5\nCondition: broad\n",
    "## Lever 1\n\nStatement: A test framework run as a maintained product.\nWeight: 5\nCondition: broad\nProperties: ai-infrastructure\n",
  );
  assert.notEqual(edited, bank, "the example bank must still open lever 1 with these fields");
  writeFileSync(path, edited, "utf8");
}

test("a lever-bank edit after Step 3 is a stale prerequisite, never a corrupt brief", (t) => {
  const environment = createEnvironment(t, "file-backed-levers-drift-");
  runThrough(environment, "map_experience");
  giveLeverOneTheInfrastructureProperty(environment);
  const before = readFileSync(environment.ledgerPath, "utf8");

  for (const stepName of ["generate_cv", "write_cover_letter"]) {
    const failure = runChildFailure(environment, stepName);
    assert.equal(failure.code, "prerequisite_stale", JSON.stringify(failure));
    assert.match(failure.message, /candidate_levers/);
  }
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

test("a Step 3 published before the lever bank was an input reads as stale", (t) => {
  const environment = createEnvironment(t, "file-backed-levers-legacy-");
  runThrough(environment, "map_experience");
  // A record written before this input existed has no entry for it. The bank is edited as well, so
  // the brief would fail validation if the missing entry were skipped rather than read as stale.
  const log = JSON.parse(readFileSync(environment.ledgerPath, "utf8"));
  const step = log.processes.find((record) => record.id === processId).steps.map_experience;
  step.published_inputs = step.published_inputs.filter((entry) => entry.kind !== "candidate_levers");
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  giveLeverOneTheInfrastructureProperty(environment);

  const failure = runChildFailure(environment, "generate_cv");
  assert.equal(failure.code, "prerequisite_stale", JSON.stringify(failure));
  assert.match(failure.message, /candidate_levers/);
});

// The candidate's rules are read by Steps 3 to 5 and fingerprinted as a whole file, so a rule
// edited between two steps stops the process the way a canon edit does.
function editCandidateRules(environment) {
  const path = resolve(environment.workspaceRoot, "candidate/rules.md");
  writeFileSync(path, `${readFileSync(path, "utf8")}\n## late-rule\n\nScope: generate-cv\nWhy: Added after Step 3.\n\nText.\n`, "utf8");
}

test("a rules edit after Step 3 is a stale prerequisite for both materials", (t) => {
  const environment = createEnvironment(t, "file-backed-rules-drift-");
  runThrough(environment, "map_experience");
  editCandidateRules(environment);
  const before = readFileSync(environment.ledgerPath, "utf8");

  for (const stepName of ["generate_cv", "write_cover_letter"]) {
    const failure = runChildFailure(environment, stepName);
    assert.equal(failure.code, "prerequisite_stale", JSON.stringify(failure));
  }
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

test("a Step 3 published before the rules were an input reads as stale, not corrupt", (t) => {
  const environment = createEnvironment(t, "file-backed-rules-legacy-");
  runThrough(environment, "map_experience");
  const log = JSON.parse(readFileSync(environment.ledgerPath, "utf8"));
  const step = log.processes.find((record) => record.id === processId).steps.map_experience;
  assert.equal(step.published_inputs.some((entry) => entry.kind === "candidate_rules"), true);
  step.published_inputs = step.published_inputs.filter((entry) => entry.kind !== "candidate_rules");
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");

  const failure = runChildFailure(environment, "generate_cv");
  assert.equal(failure.code, "prerequisite_stale", JSON.stringify(failure));
});

// The layer files Steps 4 and 5 pin beyond the profile and the rules, each with the steps that read
// it. The three pack roles are read for a letter in a configured language, so their cases run a
// Greek process.
const materialLayerInputs = Object.freeze([
  Object.freeze({
    kind: "candidate_config",
    language: null,
    path: "candidate/config.json",
    steps: Object.freeze(["generate_cv", "write_cover_letter"]),
  }),
  Object.freeze({
    kind: "candidate_constraints",
    language: null,
    path: "candidate/constraints.json",
    steps: Object.freeze(["generate_cv", "write_cover_letter"]),
  }),
  Object.freeze({
    kind: "candidate_letter_samples",
    language: null,
    path: "candidate/letter-samples.md",
    steps: Object.freeze(["write_cover_letter"]),
  }),
  Object.freeze({
    kind: "candidate_language_pack",
    language: "Greek",
    path: "candidate/languages/Greek/pack.json",
    steps: Object.freeze(["write_cover_letter"]),
  }),
  Object.freeze({
    kind: "candidate_language_constraints",
    language: "Greek",
    path: "candidate/languages/Greek/constraints.json",
    steps: Object.freeze(["write_cover_letter"]),
  }),
  Object.freeze({
    kind: "candidate_language_rules",
    language: "Greek",
    path: "candidate/languages/Greek/language-rules.md",
    steps: Object.freeze(["write_cover_letter"]),
  }),
]);
const materialStepNames = Object.freeze(["generate_cv", "write_cover_letter"]);
const layerKindsAddedWithTheLayer = Object.freeze(materialLayerInputs.map((input) => input.kind));

function runSteps(environment, names, language = null, options = {}) {
  for (const stepName of names) {
    runFixtureStep(environment, stepName, { id: processId }, { language, ...options[stepName] });
  }
}

// A trailing newline: new bytes, the same content to every reader of the file.
function touchLayerFile(environment, path) {
  appendFileSync(resolve(environment.workspaceRoot, path), "\n", "utf8");
}

function deepStepReport(environment, stepName) {
  const report = validateProcessLogV3Deep(environment.ledgerPath, lifecycleEnvironment(environment));
  return report.processes
    .find((entry) => entry.process_id === processId)
    .steps.find((step) => step.name === stepName);
}

function publishedInputs(environment, stepName) {
  return readLogV3(environment.ledgerPath).processes
    .find((record) => record.id === processId)
    .steps[stepName].published_inputs;
}

function editLedgerStep(environment, stepName, edit) {
  const log = JSON.parse(readFileSync(environment.ledgerPath, "utf8"));
  edit(log.processes.find((record) => record.id === processId).steps[stepName]);
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
}

function withoutLayerKinds(snapshot) {
  return snapshot.filter((entry) => !layerKindsAddedWithTheLayer.includes(entry.kind));
}

test("Steps 4 and 5 publish the digest of every layer file they read, the letter's pack by its language", (t) => {
  for (const language of [null, "Greek"]) {
    const environment = createEnvironment(t, `file-backed-layer-snapshot-${(language ?? "default").toLowerCase()}-`);
    runSteps(environment, stepNames, language);
    for (const stepName of materialStepNames) {
      const inputs = new Map(publishedInputs(environment, stepName).map((entry) => [entry.kind, entry]));
      for (const input of materialLayerInputs) {
        const pinned = input.steps.includes(stepName) && (input.language === null || input.language === language);
        assert.equal(inputs.has(input.kind), pinned, `${language}: ${stepName} ${input.kind}`);
        if (!pinned) continue;
        const bytes = readFileSync(resolve(environment.workspaceRoot, input.path));
        assert.equal(inputs.get(input.kind).path, input.path);
        assert.equal(inputs.get(input.kind).sha256, sha256Hex(bytes));
        assert.equal(inputs.get(input.kind).bytes, bytes.byteLength);
      }
    }
  }
});

test("a layer file a material step reads, changed while the step is open, refuses its publication", (t) => {
  for (const input of materialLayerInputs) {
    for (const stepName of input.steps) {
      const environment = createEnvironment(t, `file-backed-layer-during-${input.kind.replaceAll("_", "-")}-`);
      runSteps(environment, stepNames.slice(0, stepNames.indexOf("map_experience") + 1), input.language);
      assert.throws(
        () => runSteps(environment, [stepName], input.language, {
          [stepName]: { beforePublish: () => touchLayerFile(environment, input.path) },
        }),
        (error) => error.code === "inputs_changed",
        `${input.kind} under ${stepName}`,
      );
    }
  }
});

test("a layer file changed after publication marks the steps that read it, and stops nothing", (t) => {
  for (const input of materialLayerInputs) {
    const environment = createEnvironment(t, `file-backed-layer-after-${input.kind.replaceAll("_", "-")}-`);
    runSteps(environment, stepNames, input.language);
    touchLayerFile(environment, input.path);
    for (const stepName of materialStepNames) {
      const issues = deepStepReport(environment, stepName).issues;
      const marked = input.steps.includes(stepName);
      assert.equal(issues.includes("published_inputs_stale"), marked, `${input.kind}: ${stepName}`);
      assert.equal(issues.includes("candidate_layer_drift"), marked, `${input.kind}: ${stepName}`);
      assert.equal(issues.includes("protected_input_drift"), marked, `${input.kind}: ${stepName}`);
    }
    // The brief was not written from these files, so it stays current.
    assert.deepEqual(deepStepReport(environment, "map_experience").issues, [], input.kind);
  }
});

test("an optional layer file is pinned only while it holds bytes", (t) => {
  const environment = createEnvironment(t, "file-backed-layer-optional-");
  const samples = resolve(environment.workspaceRoot, "candidate/letter-samples.md");
  const bytes = readFileSync(samples);
  unlinkSync(samples);
  runSteps(environment, stepNames);
  assert.equal(
    publishedInputs(environment, "write_cover_letter").some((entry) => entry.kind === "candidate_letter_samples"),
    false,
  );
  // An empty file holds nothing, as an absent one does.
  writeFileSync(samples, "");
  assert.deepEqual(deepStepReport(environment, "write_cover_letter").issues, []);
  writeFileSync(samples, bytes);
  const issues = deepStepReport(environment, "write_cover_letter").issues;
  assert.equal(issues.includes("published_inputs_stale"), true);
  assert.equal(issues.includes("candidate_layer_drift"), true);
});

test("a file no step pins changes nothing: memory, the reader's examples, pins, another language's pack, the config for Step 3", (t) => {
  const environment = createEnvironment(t, "file-backed-layer-live-");
  runSteps(environment, stepNames.slice(0, stepNames.indexOf("map_experience") + 1));
  // Step 3 does not pin the config, so its edit lets both materials start from the brief.
  touchLayerFile(environment, "candidate/config.json");
  runSteps(environment, materialStepNames);
  writeFileSync(resolve(environment.workspaceRoot, "candidate/memory.md"), "# Memory\n\n## Open questions\n", "utf8");
  writeFileSync(resolve(environment.workspaceRoot, "candidate/letter-reader-examples.md"), "# Letter Reader Examples\n\n## reread\n\n## unclear_reference\n\n## missing_link\n\n## translated\n", "utf8");
  touchLayerFile(environment, "candidate/languages/Greek/pins.json");
  touchLayerFile(environment, "candidate/languages/Greek/pack.json");
  const report = validateProcessLogV3Deep(environment.ledgerPath, lifecycleEnvironment(environment));
  assert.equal(report.health, "current", JSON.stringify(report.processes[0].steps));
});

test("a material step published before the layer inputs reads as it did, and one after it does not", (t) => {
  const legacy = createEnvironment(t, "file-backed-layer-legacy-");
  runSteps(legacy, stepNames);
  for (const stepName of materialStepNames) {
    editLedgerStep(legacy, stepName, (step) => {
      step.published_inputs = withoutLayerKinds(step.published_inputs);
    });
  }
  touchLayerFile(legacy, "candidate/config.json");
  touchLayerFile(legacy, "candidate/letter-samples.md");
  for (const stepName of materialStepNames) {
    assert.deepEqual(deepStepReport(legacy, stepName).issues, [], stepName);
    const reconciled = reconcileFileBackedStepV3(
      legacy.ledgerPath,
      { selector: { id: processId }, stepName, attemptId: null, publicationId: null },
      lifecycleEnvironment(legacy),
    );
    assert.equal(reconciled.status, "unchanged", stepName);
  }
  // The inputs it did pin still count: a canon file of Step 5 marks it.
  touchLayerFile(legacy, "knowledge/cover-letter-playbook.md");
  assert.equal(deepStepReport(legacy, "write_cover_letter").issues.includes("published_inputs_stale"), true);

  const current = createEnvironment(t, "file-backed-layer-new-record-");
  runSteps(current, stepNames);
  touchLayerFile(current, "candidate/config.json");
  for (const stepName of materialStepNames) {
    const reconciled = reconcileFileBackedStepV3(
      current.ledgerPath,
      { selector: { id: processId }, stepName, attemptId: null, publicationId: null },
      lifecycleEnvironment(current),
    );
    assert.equal(reconciled.status, "stale", stepName);
  }
});

function reconcileWithoutToken(environment, stepName) {
  return reconcileFileBackedStepV3(
    environment.ledgerPath,
    { selector: { id: processId }, stepName, attemptId: null, publicationId: null },
    lifecycleEnvironment(environment),
  );
}

function withoutLayerKindsInMaterialSteps(environment) {
  for (const stepName of materialStepNames) {
    editLedgerStep(environment, stepName, (step) => {
      step.published_inputs = withoutLayerKinds(step.published_inputs);
    });
  }
}

test("an old letter in a configured language reads as it did without its pack, and a new one does not", (t) => {
  const packPath = "candidate/languages/Greek/pack.json";
  for (const damage of ["missing", "empty"]) {
    const legacy = createEnvironment(t, `file-backed-layer-legacy-pack-${damage}-`);
    runSteps(legacy, stepNames, "Greek");
    withoutLayerKindsInMaterialSteps(legacy);
    if (damage === "missing") unlinkSync(resolve(legacy.workspaceRoot, packPath));
    else writeFileSync(resolve(legacy.workspaceRoot, packPath), "");
    const report = deepStepReport(legacy, "write_cover_letter");
    assert.equal(report.input_health, "current", damage);
    assert.deepEqual(report.issues, [], damage);
    assert.equal(reconcileWithoutToken(legacy, "write_cover_letter").status, "unchanged", damage);
  }

  // A letter that pinned its pack still needs it.
  const current = createEnvironment(t, "file-backed-layer-new-record-pack-missing-");
  runSteps(current, stepNames, "Greek");
  unlinkSync(resolve(current.workspaceRoot, packPath));
  assert.deepEqual(deepStepReport(current, "write_cover_letter").issues, ["input_missing"]);
  assert.throws(
    () => reconcileWithoutToken(current, "write_cover_letter"),
    (error) => error.code === "input_missing",
  );
});

test("an old material step reads as it did when a layer file it never pinned holds broken bytes", (t) => {
  const brokenInputs = [
    { path: "candidate/constraints.json", steps: ["generate_cv", "write_cover_letter"] },
    { path: "candidate/letter-samples.md", steps: ["write_cover_letter"] },
  ];
  for (const input of brokenInputs) {
    const legacy = createEnvironment(t, "file-backed-layer-legacy-broken-bytes-");
    runSteps(legacy, stepNames);
    withoutLayerKindsInMaterialSteps(legacy);
    writeFileSync(resolve(legacy.workspaceRoot, input.path), Buffer.from([0xff, 0xfe, 0x41]));
    for (const stepName of input.steps) {
      const report = deepStepReport(legacy, stepName);
      assert.equal(report.input_health, "current", `${input.path}: ${stepName}`);
      assert.deepEqual(report.issues, [], `${input.path}: ${stepName}`);
      assert.equal(
        reconcileWithoutToken(legacy, stepName).status,
        "unchanged",
        `${input.path}: ${stepName}`,
      );
    }
  }
});

test("an attempt opened before the layer inputs publishes after them", (t) => {
  const environment = createEnvironment(t, "file-backed-layer-spanning-attempt-");
  runSteps(environment, stepNames.slice(0, stepNames.indexOf("map_experience") + 1));
  // The attempt's snapshot as a release without the layer inputs wrote it.
  runSteps(environment, ["write_cover_letter"], null, {
    write_cover_letter: {
      beforePublish: () => editLedgerStep(environment, "write_cover_letter", (step) => {
        step.active_attempt.input_snapshot = withoutLayerKinds(step.active_attempt.input_snapshot);
      }),
    },
  });
  const step = readLogV3(environment.ledgerPath).processes[0].steps.write_cover_letter;
  assert.equal(step.state, "completed");
  assert.deepEqual(withoutLayerKinds(step.published_inputs), step.published_inputs);
});

test("Step 5 rejects an arbitrary non-empty string before first publication", (t) => {
  const environment = createEnvironment(t, "file-backed-invalid-letter-");
  runThrough(environment, "map_experience");
  const begun = beginFileBackedStepV3(
    environment.ledgerPath,
    { selector: { id: processId }, stepName: "write_cover_letter" },
    {
      ...lifecycleEnvironment(environment),
      attemptIdFactory: () => "attempt_invalid_cover_letter_001",
      clock: () => "2026-07-27T09:20:00.000Z",
    },
  );
  const publicationId = "publication_invalid_cover_letter_001";
  const staging = join(
    environment.selectedOutputPath,
    ".pipeline-tmp",
    publicationId,
  );
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "cover-letter.txt"), "x", "utf8");
  const beforeLedger = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => publishFileBackedStepV3(
      environment.ledgerPath,
      {
        selector: { id: processId },
        stepName: "write_cover_letter",
        attemptId: begun.attempt_id,
        publicationId,
        outcome: "completed",
        blocker: null,
      },
      lifecycleEnvironment(environment),
    ),
    (error) =>
      error.code === "candidate_bundle_invalid"
      && error.message.includes("cover-letter.txt"),
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeLedger);
  assert.equal(
    existsSync(join(environment.selectedOutputPath, "cover-letter.txt")),
    false,
  );
});

test("a rejected Step 5 revision preserves the committed letter bytes", (t) => {
  const environment = createEnvironment(t, "file-backed-invalid-letter-revision-");
  runThrough(environment, "write_cover_letter");
  const canonicalPath = join(environment.selectedOutputPath, "cover-letter.txt");
  const committedBytes = readFileSync(canonicalPath);
  const attemptId = "attempt_invalid_cover_letter_revision_002";
  const publicationId = "publication_invalid_cover_letter_revision_002";
  reopenFileBackedStepV3(
    environment.ledgerPath,
    { selector: { id: processId }, stepName: "write_cover_letter" },
    {
      ...lifecycleEnvironment(environment),
      attemptIdFactory: () => attemptId,
      clock: () => "2026-07-27T10:20:00.000Z",
    },
  );
  const staging = join(
    environment.selectedOutputPath,
    ".pipeline-tmp",
    publicationId,
  );
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "cover-letter.txt"), "x", "utf8");
  const beforeLedger = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => publishFileBackedStepV3(
      environment.ledgerPath,
      {
        selector: { id: processId },
        stepName: "write_cover_letter",
        attemptId,
        publicationId,
        outcome: "completed",
        blocker: null,
      },
      lifecycleEnvironment(environment),
    ),
    (error) =>
      error.code === "candidate_bundle_invalid"
      && error.message.includes("body must contain 4 to 5 paragraphs"),
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeLedger);
  assert.deepEqual(readFileSync(canonicalPath), committedBytes);
});

test("Step 5 recovery revalidates prepared canonical bytes and rolls invalid bytes back", (t) => {
  const environment = createEnvironment(t, "file-backed-invalid-letter-recovery-");
  runThrough(environment, "write_cover_letter");
  const canonicalPath = join(environment.selectedOutputPath, "cover-letter.txt");
  const committedBytes = readFileSync(canonicalPath);
  const committedStep = readLogV3(environment.ledgerPath).processes
    .find((record) => record.id === processId).steps.write_cover_letter;
  const committedRevision = committedStep.revision;
  const committedArtifacts = structuredClone(committedStep.artifacts);
  const attemptId = "attempt_invalid_cover_letter_recovery_002";
  const publicationId = "publication_invalid_cover_letter_recovery_002";
  reopenFileBackedStepV3(
    environment.ledgerPath,
    { selector: { id: processId }, stepName: "write_cover_letter" },
    {
      ...lifecycleEnvironment(environment),
      attemptIdFactory: () => attemptId,
      clock: () => "2026-07-27T10:30:00.000Z",
    },
  );
  const staging = join(
    environment.selectedOutputPath,
    ".pipeline-tmp",
    publicationId,
  );
  mkdirSync(staging, { recursive: true });
  copyFileSync(canonicalPath, join(staging, "cover-letter.txt"));

  assert.throws(
    () => publishFileBackedStepV3(
      environment.ledgerPath,
      {
        selector: { id: processId },
        stepName: "write_cover_letter",
        attemptId,
        publicationId,
        outcome: "completed",
        blocker: null,
      },
      {
        ...lifecycleEnvironment(environment),
        clock: () => "2026-07-27T10:35:00.000Z",
        failAt: "after_candidate:cover_letter",
      },
    ),
    (error) => error.code === "simulated_publication_crash",
  );

  const invalidBytes = Buffer.from("x", "utf8");
  writeFileSync(canonicalPath, invalidBytes);
  const preparedLog = readLogV3(environment.ledgerPath);
  const preparedStep = preparedLog.processes.find((record) => record.id === processId)
    .steps.write_cover_letter;
  const preparedArtifact = preparedStep.publication_transaction.new_artifacts.find(
    (artifact) => artifact.kind === "cover_letter",
  );
  preparedArtifact.bytes = invalidBytes.byteLength;
  preparedArtifact.sha256 = sha256Hex(invalidBytes);
  writeFileSync(
    environment.ledgerPath,
    `${JSON.stringify(preparedLog, null, 2)}\n`,
    "utf8",
  );

  const recovered = reconcileFileBackedStepV3(
    environment.ledgerPath,
    {
      selector: { id: processId },
      stepName: "write_cover_letter",
      attemptId,
      publicationId,
    },
    {
      ...lifecycleEnvironment(environment),
      clock: () => "2026-07-27T10:40:00.000Z",
    },
  );
  assert.equal(recovered.status, "rolled_back");
  assert.deepEqual(readFileSync(canonicalPath), committedBytes);
  const recoveredStep = readLogV3(environment.ledgerPath).processes
    .find((record) => record.id === processId).steps.write_cover_letter;
  assert.equal(recoveredStep.state, "failed");
  assert.equal(recoveredStep.error.code, "publication_validation_failed");
  assert.equal(recoveredStep.revision, committedRevision);
  assert.deepEqual(recoveredStep.artifacts, committedArtifacts);
});

// The candidate layer reaches the publication gate.
//
// Everything else about constraints is proved on injected values; this is the only place that
// shows the wiring is live — that a layer sitting in the workspace root is found, read and
// applied by the publisher, rather than being a parameter nothing passes. The layer used is the
// tracked example itself, copied whole, so the entries in `candidate.example/constraints.json`
// are a fixture of this test and not decoration.
function seedCandidateExample(environment) {
  const root = join(environment.workspaceRoot, "candidate");
  mkdirSync(root, { recursive: true });
  for (const name of ["config.json", "constraints.json"]) {
    copyFileSync(resolve(repoRoot, "candidate.example", name), join(root, name));
  }
  cpSync(resolve(repoRoot, "candidate.example/languages"), join(root, "languages"), { recursive: true });
  return root;
}

test("a letter is not published when the candidate layer cannot supply its limits", (t) => {
  const environment = createEnvironment(t, "file-backed-candidate-limits-");
  runThrough(environment, "write_cover_letter");
  const published = join(environment.selectedOutputPath, "cover-letter.txt");
  const beforeBytes = readFileSync(published);

  const attemptId = "attempt_fixture_cover_letter_limits_reopen";
  const publicationId = "publication_fixture_cover_letter_limits";
  reopenFileBackedStepV3(
    environment.ledgerPath,
    { selector: { id: processId }, stepName: "write_cover_letter" },
    {
      attemptIdFactory: () => attemptId,
      clock: () => "2026-07-27T11:40:00.000Z",
      ...lifecycleEnvironment(environment),
    },
  );
  const staging = join(environment.selectedOutputPath, ".pipeline-tmp", publicationId);
  mkdirSync(staging, { recursive: true });
  // The letter that just published, unchanged: the only difference is the missing config.
  writeFileSync(join(staging, "cover-letter.txt"), beforeBytes);
  unlinkSync(join(environment.workspaceRoot, "candidate", "config.json"));
  const beforeLedger = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => publishFileBackedStepV3(
      environment.ledgerPath,
      {
        selector: { id: processId },
        stepName: "write_cover_letter",
        attemptId,
        publicationId,
        outcome: "completed",
        blocker: null,
      },
      lifecycleEnvironment(environment),
    ),
    // Refused under the layer's own code, before the attempt or the ledger is touched.
    (error) =>
      error.code === "candidate_config_missing"
      && error.message.includes("candidate layer:"),
  );
  assert.deepEqual(readFileSync(published), beforeBytes);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeLedger);
});

test("a candidate constraint refuses the letter at the publication gate", (t) => {
  const environment = createEnvironment(t, "file-backed-candidate-constraint-");
  seedCandidateExample(environment);
  // A letter that breaks nothing publishes with the layer in place: the gate is applying the
  // constraints, not merely failing whenever a layer exists.
  runThrough(environment, "write_cover_letter");
  const published = join(environment.selectedOutputPath, "cover-letter.txt");
  const beforeBytes = readFileSync(published);

  const attemptId = "attempt_fixture_cover_letter_constraint_reopen";
  const publicationId = "publication_fixture_cover_letter_constraint";
  reopenFileBackedStepV3(
    environment.ledgerPath,
    { selector: { id: processId }, stepName: "write_cover_letter" },
    {
      attemptIdFactory: () => attemptId,
      clock: () => "2026-07-27T11:40:00.000Z",
      ...lifecycleEnvironment(environment),
    },
  );
  const staging = join(environment.selectedOutputPath, ".pipeline-tmp", publicationId);
  mkdirSync(staging, { recursive: true });
  // The name the example forbids, added to the first body paragraph so the letter stays valid in
  // every other respect and the constraint is the only thing standing between it and publication.
  const lines = readFileSync(published, "utf8").split("\n");
  const firstBody = lines.findIndex((line, index) => index >= 2 && line !== "");
  lines[firstBody] = `Jordan Vale wrote first. ${lines[firstBody]}`;
  writeFileSync(join(staging, "cover-letter.txt"), lines.join("\n"), "utf8");
  const beforeLedger = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => publishFileBackedStepV3(
      environment.ledgerPath,
      {
        selector: { id: processId },
        stepName: "write_cover_letter",
        attemptId,
        publicationId,
        outcome: "completed",
        blocker: null,
      },
      lifecycleEnvironment(environment),
    ),
    (error) =>
      error.code === "candidate_bundle_invalid"
      && error.message.includes('candidate constraint "no-introducer-name"')
      // The forbidden name is not repeated in the refusal that forbids it.
      && !error.message.includes("Jordan Vale"),
  );
  assert.deepEqual(readFileSync(published), beforeBytes);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeLedger);
});

test("a process in a configured language runs every step, and its pack's constraint refuses its letter", (t) => {
  // The example configures Greek: the vacancy and the brief are in it, the letter is a Greek one
  // signed from its pack, and the committed process stays current under the deep check, which reads
  // the layer's languages for every step it re-validates.
  const environment = createEnvironment(t, "file-backed-configured-language-");
  for (const stepName of stepNames) {
    runFixtureStep(environment, stepName, { id: processId }, { language: "Greek" });
  }
  const published = join(environment.selectedOutputPath, "cover-letter.txt");
  const beforeBytes = readFileSync(published);
  assert.match(beforeBytes.toString("utf8"), /\p{Script=Greek}/u);
  assert.equal(
    validateProcessLogV3Deep(environment.ledgerPath, lifecycleEnvironment(environment)).health,
    "current",
  );

  const attemptId = "attempt_fixture_cover_letter_pack_reopen";
  const publicationId = "publication_fixture_cover_letter_pack";
  reopenFileBackedStepV3(
    environment.ledgerPath,
    { selector: { id: processId }, stepName: "write_cover_letter" },
    {
      attemptIdFactory: () => attemptId,
      clock: () => "2026-07-27T11:50:00.000Z",
      ...lifecycleEnvironment(environment),
    },
  );
  const staging = join(environment.selectedOutputPath, ".pipeline-tmp", publicationId);
  mkdirSync(staging, { recursive: true });
  // The pack's required spelling broken in the first body paragraph; everything else stays valid.
  const lines = beforeBytes.toString("utf8").split("\n");
  const firstBody = lines.findIndex((line, index) => index >= 2 && line !== "");
  lines[firstBody] = `Οι δοκιμες μετράνε. ${lines[firstBody]}`;
  writeFileSync(join(staging, "cover-letter.txt"), lines.join("\n"), "utf8");
  const beforeLedger = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => publishFileBackedStepV3(
      environment.ledgerPath,
      {
        selector: { id: processId },
        stepName: "write_cover_letter",
        attemptId,
        publicationId,
        outcome: "completed",
        blocker: null,
      },
      lifecycleEnvironment(environment),
    ),
    // The whole message, so the constraint is the refusal's only finding: the validator joins
    // findings with "; ", and any other one would ride along unnoticed under a substring check.
    {
      code: "candidate_bundle_invalid",
      message: "candidate_bundle_invalid: write_cover_letter candidate bundle validation failed: "
        + 'cover-letter.txt breaks candidate constraint "tonos-dokimes" (required_spellings): '
        + 'spell it "δοκιμές"',
    },
  );
  assert.deepEqual(readFileSync(published), beforeBytes);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeLedger);
});

test("a broken constraints file stops the publication instead of being skipped", (t) => {
  const environment = createEnvironment(t, "file-backed-candidate-broken-");
  const root = seedCandidateExample(environment);
  runThrough(environment, "map_experience");
  writeFileSync(join(root, "constraints.json"), "{ not json\n", "utf8");
  // The fixture step publishes through the same gate, so a layer that cannot be read fails the
  // step rather than being read as "no constraints".
  assert.throws(
    () => runFixtureStep(environment, "write_cover_letter", { id: processId }),
    (error) =>
      error.code === "candidate_bundle_invalid"
      && error.message.includes("candidate_constraints_invalid_json"),
  );
});

test("without a constraints file the publication gate behaves exactly as before", (t) => {
  const environment = createEnvironment(t, "file-backed-candidate-absent-");
  unlinkSync(resolve(environment.workspaceRoot, "candidate/constraints.json"));
  runThrough(environment, "write_cover_letter");
  assert.equal(
    existsSync(join(environment.selectedOutputPath, "cover-letter.txt")),
    true,
  );
});
