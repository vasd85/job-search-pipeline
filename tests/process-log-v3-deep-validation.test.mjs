import assert from "node:assert/strict";
import fileSystem, {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  fileBackedStepNames,
  readLogV3,
} from "../tools/lib/process-log-core.mjs";
import {
  beginFileBackedStepV3,
  cleanupFileBackedStagingV3,
  createInitialFileBackedProcess,
  createPendingFileBackedStep,
  fileBackedProtectedInputs,
  reconcileFileBackedStepV3,
  validateProcessLogV3Deep,
} from "../tools/lib/process-log-v3-lifecycle.mjs";
import { sha256Hex } from "../tools/pipeline-artifacts/validation.mjs";
import { createDisposableWorkspace } from "./fixtures/disposable-workspace.mjs";
import { createRunningPublicationStep } from "./fixtures/process-log-v3.mjs";
import { protectedInputSource, seedCandidateConfig } from "./fixtures/protected-inputs.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const processId = "proc_fixture_step1_completed";
const sourceRef = "https://example.test/jobs/senior-quality-engineer";
const outputDir = "output/example-labs-senior-quality-engineer";
const outputSegment = outputDir.slice("output/".length);
const timestamps = Object.freeze({
  process: "2026-07-23T10:00:00.000Z",
  vacancy: "2026-07-23T10:10:00.000Z",
  research: "2026-07-23T10:40:00.000Z",
  map: "2026-07-23T11:20:00.000Z",
  cv: "2026-07-23T11:40:00.000Z",
  letter: "2026-07-23T11:50:00.000Z",
  reconcile: "2026-07-23T14:00:00.000Z",
});
const EXPECTED_FILE_BACKED_STEP_NAMES = Object.freeze([
  "get_vacancy",
  "research_company",
  "map_experience",
  "generate_cv",
  "write_cover_letter",
]);

const EXPECTED_STAGING_SCENARIOS = Object.freeze([
  "active_unassigned",
  "active_unsafe",
  "age_evidence",
  "direct_file",
  "directory_metadata_token",
  "dry_run",
  "cleanup_exact_keys",
  "cleanup_process_id",
  "empty_root_inode_replacement",
  "empty_parent_clear",
  "exact_confirm",
  "foreign_owned",
  "foreign_active_precedence",
  "foreign_prepared_cleanup",
  "final_directory_race",
  "final_realpath_race",
  "final_symlink_race",
  "hardlink_inventory",
  "history_owned",
  "history_active_precedence",
  "historical_cleanup_guard",
  "inode_replacement",
  "invalid_transaction_name",
  "invalid_confirmation",
  "metadata_only",
  "missing_parent",
  "no_output_not_evaluated",
  "no_parent_clear",
  "missing_repeat",
  "nested_symlink",
  "nested_nonregular",
  "nested_route_metadata",
  "orphan_deep",
  "owner_direct_unsafe",
  "owner_foreign_direct_unsafe",
  "owner_foreign_nested_unsafe",
  "owner_nested_unsafe",
  "owner_prepared_direct_unsafe",
  "owner_prepared_nested_unsafe",
  "parent_entry_boundary",
  "parent_dirent_symlink",
  "parent_entry_overflow",
  "parent_lstat_error",
  "parent_open_error",
  "parent_read_error",
  "parent_realpath_error",
  "prepared_owned",
  "process_id_token",
  "process_update_token",
  "publication_id_token",
  "root_identity_race",
  "root_file",
  "root_realpath_mismatch",
  "root_symlink",
  "same_size_rewrite_token",
  "remove_error",
  "remove_postcondition",
  "second_snapshot_race",
  "second_snapshot_digest",
  "second_snapshot_root_identity",
  "sibling_preserved",
  "tree_byte_boundary",
  "tree_byte_overflow",
  "tree_close_error",
  "tree_depth_boundary",
  "tree_depth_overflow",
  "tree_hostile_error",
  "tree_lstat_error",
  "tree_open_error",
  "tree_order",
  "tree_read_error",
  "tree_read_close_error",
  "tree_realpath_error",
  "stale_content_token",
  "target_realpath_mismatch",
  "target_symlink",
  "tree_entry_boundary",
  "tree_entry_overflow",
  "unbounded_depth",
]);
const DECLARED_STAGING_SCENARIOS = Object.freeze([
  "orphan_deep",
  "no_output_not_evaluated",
  "no_parent_clear",
  "empty_parent_clear",
  "parent_entry_boundary",
  "parent_dirent_symlink",
  "parent_entry_overflow",
  "parent_lstat_error",
  "parent_open_error",
  "parent_read_error",
  "parent_realpath_error",
  "active_unassigned",
  "active_unsafe",
  "age_evidence",
  "history_owned",
  "history_active_precedence",
  "historical_cleanup_guard",
  "prepared_owned",
  "foreign_owned",
  "foreign_active_precedence",
  "foreign_prepared_cleanup",
  "final_directory_race",
  "final_realpath_race",
  "final_symlink_race",
  "direct_file",
  "directory_metadata_token",
  "root_file",
  "root_realpath_mismatch",
  "root_symlink",
  "target_realpath_mismatch",
  "target_symlink",
  "nested_symlink",
  "nested_nonregular",
  "nested_route_metadata",
  "owner_direct_unsafe",
  "owner_foreign_direct_unsafe",
  "owner_foreign_nested_unsafe",
  "owner_nested_unsafe",
  "owner_prepared_direct_unsafe",
  "owner_prepared_nested_unsafe",
  "hardlink_inventory",
  "invalid_transaction_name",
  "tree_entry_boundary",
  "tree_entry_overflow",
  "tree_byte_boundary",
  "tree_byte_overflow",
  "tree_close_error",
  "tree_hostile_error",
  "tree_lstat_error",
  "tree_open_error",
  "tree_order",
  "tree_read_error",
  "tree_read_close_error",
  "tree_realpath_error",
  "tree_depth_boundary",
  "tree_depth_overflow",
  "unbounded_depth",
  "dry_run",
  "cleanup_exact_keys",
  "cleanup_process_id",
  "stale_content_token",
  "same_size_rewrite_token",
  "inode_replacement",
  "empty_root_inode_replacement",
  "invalid_confirmation",
  "metadata_only",
  "missing_parent",
  "process_id_token",
  "process_update_token",
  "publication_id_token",
  "root_identity_race",
  "second_snapshot_race",
  "second_snapshot_digest",
  "second_snapshot_root_identity",
  "remove_error",
  "remove_postcondition",
  "exact_confirm",
  "missing_repeat",
  "sibling_preserved",
]);
const executedStagingScenarios = new Set();

const artifactSources = Object.freeze({
  "application-brief.json": resolve(
    repoRoot,
    "tools/application-brief/fixtures/application-brief.v4.valid.json",
  ),
  "company-research.json": resolve(
    repoRoot,
    "tools/pipeline-artifacts/fixtures/research-v2-over-vacancy-v2/company-research.json",
  ),
  "job-description.txt": resolve(
    repoRoot,
    "tools/pipeline-artifacts/fixtures/vacancy-v2-completed/job-description.txt",
  ),
  "vacancy.json": resolve(
    repoRoot,
    "tools/pipeline-artifacts/fixtures/vacancy-v2-completed/vacancy.json",
  ),
});

const protectedContracts = Object.freeze(
  [...new Map(
    Object.values(fileBackedProtectedInputs)
      .flat()
      .map((contract) => [contract.kind, contract]),
  ).values()],
);

function artifactMetadata(kind, path, schemaVersion, absolutePath) {
  const bytes = readFileSync(absolutePath);
  return {
    kind,
    path,
    schema_version: schemaVersion,
    sha256: sha256Hex(bytes),
    bytes: bytes.byteLength,
  };
}

function completedStep({
  artifacts,
  finishedAt,
  inputs,
  publicationId,
  startedAt,
}) {
  return {
    state: "completed",
    attempt: 1,
    revision: 1,
    started_at: startedAt,
    updated_at: finishedAt,
    finished_at: finishedAt,
    published_inputs: structuredClone(inputs),
    artifacts: structuredClone(artifacts),
    active_attempt: null,
    publication_transaction: null,
    attempt_history: [
      {
        attempt: 1,
        outcome: "completed",
        started_at: startedAt,
        finished_at: finishedAt,
        input_snapshot: structuredClone(inputs),
        error_code: null,
        publication_id: publicationId,
      },
    ],
    error: null,
    blocker: null,
  };
}

function copyFixtureFile(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function createCompletedEnvironment(t, { includeHistorical = true } = {}) {
  const disposable = createDisposableWorkspace(t, {
    prefix: "job-search-v3-deep-",
  });
  const { ledgerPath, outputRoot, workspaceRoot } = disposable;
  const selectedOutputPath = join(outputRoot, outputSegment);
  mkdirSync(selectedOutputPath, { recursive: true });

  for (const [path, source] of Object.entries(artifactSources)) {
    copyFixtureFile(source, join(selectedOutputPath, path));
  }
  for (const contract of protectedContracts) {
    copyFixtureFile(
      protectedInputSource(repoRoot, contract.path),
      resolve(workspaceRoot, contract.path),
    );
  }
  // Steps 1-3 read the language names from the layer's config, and a present layer has one.
  seedCandidateConfig(repoRoot, workspaceRoot);

  const jobDescription = artifactMetadata(
    "job_description",
    "job-description.txt",
    null,
    join(selectedOutputPath, "job-description.txt"),
  );
  const vacancy = artifactMetadata(
    "vacancy",
    "vacancy.json",
    2,
    join(selectedOutputPath, "vacancy.json"),
  );
  const research = artifactMetadata(
    "company_research",
    "company-research.json",
    2,
    join(selectedOutputPath, "company-research.json"),
  );
  const brief = artifactMetadata(
    "application_brief",
    "application-brief.json",
    4,
    join(selectedOutputPath, "application-brief.json"),
  );
  const protectedByStep = Object.fromEntries(
    Object.entries(fileBackedProtectedInputs).map(([stepName, contracts]) => [
      stepName,
      contracts.map((contract) =>
        artifactMetadata(
          contract.kind,
          contract.path,
          null,
          resolve(workspaceRoot, contract.path),
        )),
    ]),
  );
  const step1Artifacts = [jobDescription, vacancy];
  const step2Artifacts = [research];
  const step3Artifacts = [brief];
  const steps = {
    get_vacancy: completedStep({
      artifacts: step1Artifacts,
      finishedAt: timestamps.vacancy,
      inputs: [],
      publicationId: "publication_deep_vacancy",
      startedAt: timestamps.process,
    }),
    research_company: completedStep({
      artifacts: step2Artifacts,
      finishedAt: timestamps.research,
      inputs: step1Artifacts,
      publicationId: "publication_deep_research",
      startedAt: "2026-07-23T10:20:00.000Z",
    }),
    map_experience: completedStep({
      artifacts: step3Artifacts,
      finishedAt: timestamps.map,
      inputs: [
        ...step1Artifacts,
        ...step2Artifacts,
        ...protectedByStep.map_experience,
      ],
      publicationId: "publication_deep_map",
      startedAt: "2026-07-23T11:00:00.000Z",
    }),
    generate_cv: createPendingFileBackedStep(),
    write_cover_letter: createPendingFileBackedStep(),
  };
  const fileBackedProcess = {
    id: processId,
    started_at: timestamps.process,
    updated_at: timestamps.map,
    source_ref: sourceRef,
    source_key: sourceRef,
    company_id: null,
    company_observed: "Example Labs",
    company_hint: null,
    role: "Senior Quality Engineer",
    runner: "codex",
    output_dir: outputDir,
    artifact_mode: "file-backed",
    steps,
    duplicate_of: null,
  };
  const historicalProcess = {
    id: "proc_historical_deep",
    started_at: "2026-07-20T08:00:00.000Z",
    source_ref: "historical:deep-fixture",
    source_key: "historical:deep-fixture",
    company_id: null,
    company_observed: "Historical Example",
    company_hint: null,
    role: "QA Engineer",
    runner: "claude-ai-web",
    output_dir: "output/historical-must-not-be-read",
    status: "output_created",
    duplicate_of: null,
  };
  const log = {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: timestamps.map,
    companies: [],
    processes: includeHistorical
      ? [historicalProcess, fileBackedProcess]
      : [fileBackedProcess],
  };
  writeFileSync(ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  readLogV3(ledgerPath);
  return {
    ...disposable,
    ledgerPath,
    outputRoot,
    protectedByStep,
    selectedOutputPath,
    workspaceRoot,
  };
}

function deepValidate(environment) {
  return validateProcessLogV3Deep(
    environment.ledgerPath,
    {
      outputRoot: environment.outputRoot,
      workspaceRoot: environment.workspaceRoot,
    },
  );
}

const SAFE_STAGING_ENTRY_KEYS = Object.freeze([
  "action",
  "age_ms",
  "classification",
  "entry_count",
  "inventory_health",
  "max_depth",
  "modified_at",
  "publication_id",
  "total_bytes",
]);

function assertSafeStagingDto(staging, environment) {
  assert.deepEqual(Object.keys(staging).sort(), ["entries", "health", "issues"]);
  for (const entry of staging.entries) {
    assert.equal(entry.inventory_health, "safe");
    assert.deepEqual(Object.keys(entry).sort(), SAFE_STAGING_ENTRY_KEYS);
  }
  const serialized = JSON.stringify(staging);
  assert.equal(serialized.includes(environment.workspaceRoot), false);
  assert.equal(serialized.includes(environment.selectedOutputPath), false);
}

function cleanupStaging(environment, publicationId, confirmationToken = null, options = {}) {
  return cleanupFileBackedStagingV3(
    environment.ledgerPath,
    {
      processId: options.processId ?? processId,
      publicationId,
      confirmationToken,
    },
    {
      outputRoot: environment.outputRoot,
      workspaceRoot: environment.workspaceRoot,
    },
  );
}

function stagingPath(environment, publicationId) {
  return join(environment.selectedOutputPath, ".pipeline-tmp", publicationId);
}

function createStagingDirectory(environment, publicationId, value = "synthetic staging bytes\n") {
  const path = stagingPath(environment, publicationId);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "candidate.bin"), value, "utf8");
  return path;
}

function expectedStagingEntry(path, type, absolutePath) {
  const stats = fileSystem.lstatSync(absolutePath, { bigint: true });
  return {
    path,
    type,
    ctime_ns: stats.ctimeNs.toString(),
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    mode: stats.mode.toString(),
    mtime_ns: stats.mtimeNs.toString(),
    nlink: stats.nlink.toString(),
    size: stats.size.toString(),
  };
}

function deepStep(report, stepName) {
  const process = report.processes.find((entry) => entry.process_id === processId);
  return process.steps.find((step) => step.name === stepName);
}

function reconcileHealth(environment, stepName, options = {}) {
  return reconcileFileBackedStepV3(
    environment.ledgerPath,
    {
      selector: { id: options.processId ?? processId },
      stepName,
      attemptId: null,
      publicationId: null,
    },
    {
      clock: () => timestamps.reconcile,
      outputRoot: environment.outputRoot,
      workspaceRoot: environment.workspaceRoot,
    },
  );
}

function makeValidCv(fileName) {
  return {
    fileName,
    header: {
      name: "Candidate Name",
      contact: "UTC+2 | candidate@example.com",
      positioning: "Remote independent contractor available across European business hours.",
    },
    sections: [
      {
        type: "summary",
        heading: "Summary",
        text: "Senior Quality Engineer with TypeScript.",
      },
      {
        type: "bullets",
        heading: "Selected Impact",
        bullets: ["Built a maintainable automation framework."],
      },
      {
        type: "skills",
        heading: "Skills",
        skills: [
          { label: "Test Automation", body: "TypeScript Playwright" },
        ],
      },
      {
        type: "experience",
        heading: "Experience",
        roles: [
          {
            company: "Current Company",
            title: "Senior QA Automation Engineer",
            dates: "2020 - Present",
            bullets: ["Used LLM-based tools in a commercial QA workflow."],
          },
        ],
      },
    ],
  };
}

function addCompletedGenerationSteps(environment) {
  const cvPath = join(environment.selectedOutputPath, "cv.json");
  const docxName = "Candidate_Deep_Fixture.docx";
  const docxPath = join(environment.selectedOutputPath, docxName);
  const letterPath = join(environment.selectedOutputPath, "cover-letter.txt");
  writeFileSync(
    cvPath,
    `${JSON.stringify(makeValidCv(docxName), null, 2)}\n`,
    "utf8",
  );
  writeFileSync(docxPath, "synthetic deep-validation DOCX\n", "utf8");
  writeFileSync(
    letterPath,
    "Senior Quality Engineer\n\nSynthetic cover letter.\n",
    "utf8",
  );

  const log = readLogV3(environment.ledgerPath);
  const process = log.processes.find((record) => record.id === processId);
  const briefArtifacts = process.steps.map_experience.artifacts;
  process.steps.generate_cv = completedStep({
    artifacts: [
      artifactMetadata("cv_source", "cv.json", null, cvPath),
      artifactMetadata("cv_docx", docxName, null, docxPath),
    ],
    finishedAt: timestamps.cv,
    inputs: [
      ...briefArtifacts,
      ...environment.protectedByStep.generate_cv,
    ],
    publicationId: "publication_deep_cv",
    startedAt: "2026-07-23T11:30:00.000Z",
  });
  process.steps.write_cover_letter = completedStep({
    artifacts: [
      artifactMetadata("cover_letter", "cover-letter.txt", null, letterPath),
    ],
    finishedAt: timestamps.letter,
    inputs: [
      ...briefArtifacts,
      ...environment.protectedByStep.write_cover_letter,
    ],
    publicationId: "publication_deep_letter",
    startedAt: "2026-07-23T11:35:00.000Z",
  });
  process.updated_at = timestamps.letter;
  log.updated_at = timestamps.letter;
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  readLogV3(environment.ledgerPath);
}

function createMissingReservationEnvironment(t) {
  const disposable = createDisposableWorkspace(t, {
    prefix: "job-search-v3-deep-missing-",
  });
  const { ledgerPath, outputRoot, workspaceRoot } = disposable;
  const process = createInitialFileBackedProcess({
    attemptId: "attempt_missing_output",
    processId: "proc_missing_output",
    runner: "codex",
    sourceRef: "https://example.test/jobs/missing-output",
    startedAt: timestamps.process,
  });
  process.company_observed = "Missing Output Labs";
  process.role = "Senior SDET";
  process.output_dir = "output/missing-output-labs-senior-sdet";
  const log = {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: timestamps.process,
    companies: [],
    processes: [process],
  };
  writeFileSync(ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  readLogV3(ledgerPath);
  return {
    ...disposable,
    ledgerPath,
    outputRoot,
    outputDir: process.output_dir,
    processId: process.id,
    workspaceRoot,
  };
}

test("deep validation reports current file-backed data and never inspects historical output", (t) => {
  const environment = createCompletedEnvironment(t);
  const before = readFileSync(environment.ledgerPath, "utf8");

  const report = deepValidate(environment);

  assert.equal(report.health, "current");
  const historical = report.processes.find((entry) => entry.mode === "historical");
  assert.deepEqual(historical.output, {
    health: "not_evaluated",
    code: null,
  });
  assert.deepEqual(historical.steps, []);
  const current = report.processes.find((entry) => entry.process_id === processId);
  assert.deepEqual(current.staging, {
    health: "clear",
    issues: [],
    entries: [],
  });
  executedStagingScenarios.add("no_parent_clear");
  mkdirSync(join(environment.selectedOutputPath, ".pipeline-tmp"));
  const emptyParent = deepValidate(environment).processes
    .find((entry) => entry.process_id === processId);
  assert.deepEqual(emptyParent.staging, {
    health: "clear",
    issues: [],
    entries: [],
  });
  executedStagingScenarios.add("empty_parent_clear");
  for (const stepName of [
    "get_vacancy",
    "research_company",
    "map_experience",
  ]) {
    assert.equal(deepStep(report, stepName).artifact_health, "current");
    assert.equal(deepStep(report, stepName).input_health, "current");
    assert.deepEqual(deepStep(report, stepName).issues, []);
  }
  assert.equal(deepStep(report, "generate_cv").artifact_health, "not_published");
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

test("deep validation distinguishes an unreserved output from an inspected empty staging root", (t) => {
  const environment = createMissingReservationEnvironment(t);
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");

  const process = deepValidate(environment).processes[0];

  assert.deepEqual(process.staging, {
    health: "not_evaluated",
    issues: [],
    entries: [],
  });
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  executedStagingScenarios.add("no_output_not_evaluated");
});

test("deep validation reports an unowned staging directory read-only", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const orphanPath = join(
    environment.selectedOutputPath,
    ".pipeline-tmp",
    "publication_orphan_fixture_001",
  );
  mkdirSync(orphanPath, { recursive: true });
  writeFileSync(join(orphanPath, "candidate.bin"), "synthetic orphan bytes\n", "utf8");
  const modifiedAt = "2026-07-23T14:59:00.000Z";
  fileSystem.utimesSync(orphanPath, new Date(modifiedAt), new Date(modifiedAt));
  t.mock.method(Date, "now", () => Date.parse("2026-07-23T15:00:00.000Z"));
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");

  const report = deepValidate(environment);
  const process = report.processes[0];

  assert.equal(report.health, "attention");
  assert.equal(process.health, "attention");
  assert.deepEqual(Object.keys(process.staging).sort(), ["entries", "health", "issues"]);
  assert.deepEqual(process.staging.issues, ["staging_orphan"]);
  assert.deepEqual(process.staging.entries, [{
    publication_id: "publication_orphan_fixture_001",
    classification: "orphan",
    action: "review_cleanup_staging",
    inventory_health: "safe",
    age_ms: 60_000,
    entry_count: 1,
    max_depth: 0,
    modified_at: modifiedAt,
    total_bytes: Buffer.byteLength("synthetic orphan bytes\n"),
  }]);
  assert.doesNotMatch(
    JSON.stringify(process.staging),
    new RegExp(environment.workspaceRoot),
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  assert.equal(existsSync(orphanPath), true);
  executedStagingScenarios.add("orphan_deep");
});

test("staging ownership containment distinguishes active, prepared, and committed evidence", async (t) => {
  await t.test("active_unassigned", () => {
    const environment = createCompletedEnvironment(t, { includeHistorical: false });
    const publicationId = "publication_active_unassigned_001";
    createStagingDirectory(environment, publicationId);
    beginFileBackedStepV3(
      environment.ledgerPath,
      { selector: { id: processId }, stepName: "generate_cv" },
      {
        attemptIdFactory: () => "attempt_active_unassigned_001",
        clock: () => "2026-07-23T11:30:00.000Z",
        outputRoot: environment.outputRoot,
        workspaceRoot: environment.workspaceRoot,
      },
    );
    const before = readFileSync(environment.ledgerPath, "utf8");
    const process = deepValidate(environment).processes[0];
    assertSafeStagingDto(process.staging, environment);
    assert.deepEqual(process.staging.entries[0], {
      ...process.staging.entries[0],
      classification: "active_unassigned",
      action: "wait_for_active_attempt",
    });
    assert.equal(process.staging.health, "current");
    assert.deepEqual(process.staging.issues, []);
    assert.throws(
      () => cleanupStaging(environment, publicationId),
      (error) => error.code === "staging_cleanup_active_attempt",
    );
    assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
    assert.equal(existsSync(stagingPath(environment, publicationId)), true);
    executedStagingScenarios.add("active_unassigned");

    rmSync(stagingPath(environment, publicationId), { recursive: true });
    writeFileSync(stagingPath(environment, publicationId), "unsafe active entry\n", "utf8");
    const unsafe = deepValidate(environment).processes[0].staging;
    assert.equal(unsafe.health, "attention");
    assert.deepEqual(unsafe.issues, ["staging_invalid_entry"]);
    assert.equal(unsafe.entries[0].classification, "invalid_entry");
    assert.equal(unsafe.entries[0].inventory_health, "unsafe");
    assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);

    unlinkSync(stagingPath(environment, publicationId));
    mkdirSync(stagingPath(environment, publicationId));
    symlinkSync(
      "candidate.bin",
      join(stagingPath(environment, publicationId), "nested-link"),
    );
    const nestedUnsafe = deepValidate(environment).processes[0].staging;
    assert.equal(nestedUnsafe.health, "attention");
    assert.deepEqual(nestedUnsafe.issues, ["staging_invalid_entry"]);
    assert.equal(nestedUnsafe.entries[0].classification, "invalid_entry");
    assert.equal(nestedUnsafe.entries[0].inventory_health, "unsafe");
    assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
    assert.equal(existsSync(stagingPath(environment, publicationId)), true);
    executedStagingScenarios.add("active_unsafe");
  });

  await t.test("history_owned", () => {
    const environment = createCompletedEnvironment(t, { includeHistorical: false });
    const publicationId = "publication_deep_map";
    createStagingDirectory(environment, publicationId);
    beginFileBackedStepV3(
      environment.ledgerPath,
      { selector: { id: processId }, stepName: "generate_cv" },
      {
        attemptIdFactory: () => "attempt_history_active_precedence_001",
        clock: () => "2026-07-23T11:30:00.000Z",
        outputRoot: environment.outputRoot,
        workspaceRoot: environment.workspaceRoot,
      },
    );
    const before = readFileSync(environment.ledgerPath, "utf8");
    const process = deepValidate(environment).processes[0];
    assertSafeStagingDto(process.staging, environment);
    assert.equal(process.staging.entries[0].classification, "history_owned");
    assert.equal(
      process.staging.entries[0].action,
      "inspect_committed_history_residue",
    );
    assert.equal(process.staging.health, "attention");
    assert.deepEqual(process.staging.issues, ["staging_history_residue"]);
    assert.throws(
      () => cleanupStaging(environment, publicationId),
      (error) => error.code === "staging_cleanup_history_owned",
    );
    assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
    assert.equal(existsSync(stagingPath(environment, publicationId)), true);
    executedStagingScenarios.add("history_owned");
    executedStagingScenarios.add("history_active_precedence");
  });

  await t.test("prepared_owned", () => {
    const environment = createCompletedEnvironment(t, { includeHistorical: false });
    const log = readLogV3(environment.ledgerPath);
    const process = log.processes[0];
    const running = createRunningPublicationStep();
    process.steps.generate_cv = running;
    process.updated_at = running.publication_transaction.prepared_at;
    log.updated_at = process.updated_at;
    writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
    createStagingDirectory(environment, running.publication_transaction.id);
    const before = readFileSync(environment.ledgerPath, "utf8");
    const reportProcess = deepValidate(environment).processes[0];
    assertSafeStagingDto(reportProcess.staging, environment);
    assert.equal(reportProcess.staging.entries[0].classification, "prepared_recovery");
    assert.equal(reportProcess.staging.entries[0].action, "use_reconcile_step");
    assert.equal(reportProcess.staging.health, "attention");
    assert.deepEqual(reportProcess.staging.issues, ["staging_prepared_recovery"]);
    assert.throws(
      () => cleanupStaging(environment, running.publication_transaction.id),
      (error) => error.code === "staging_cleanup_prepared_owned",
    );
    assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
    assert.equal(
      existsSync(stagingPath(environment, running.publication_transaction.id)),
      true,
    );
    executedStagingScenarios.add("prepared_owned");
  });

  await t.test("foreign_owned", () => {
    const environment = createCompletedEnvironment(t, { includeHistorical: false });
    const log = readLogV3(environment.ledgerPath);
    const foreign = structuredClone(log.processes[0]);
    foreign.id = "proc_foreign_staging_owner";
    foreign.source_ref = "https://example.test/jobs/foreign-staging-owner";
    foreign.source_key = foreign.source_ref;
    foreign.output_dir = "output/foreign-staging-owner";
    for (const [stepName, step] of Object.entries(foreign.steps)) {
      for (const attempt of step.attempt_history) {
        if (attempt.publication_id !== null) {
          attempt.publication_id = `publication_foreign_${stepName}`;
        }
      }
    }
    const publicationId = "publication_foreign_map_experience";
    log.processes.push(foreign);
    writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
    beginFileBackedStepV3(
      environment.ledgerPath,
      { selector: { id: processId }, stepName: "generate_cv" },
      {
        attemptIdFactory: () => "attempt_foreign_active_precedence_001",
        clock: () => "2026-07-23T11:30:00.000Z",
        outputRoot: environment.outputRoot,
        workspaceRoot: environment.workspaceRoot,
      },
    );
    createStagingDirectory(environment, publicationId);
    const before = readFileSync(environment.ledgerPath, "utf8");

    const selected = deepValidate(environment).processes
      .find((entry) => entry.process_id === processId);
    assertSafeStagingDto(selected.staging, environment);
    assert.equal(selected.staging.entries[0].classification, "foreign_owned");
    assert.equal(selected.staging.entries[0].action, "inspect_foreign_publication_owner");
    assert.equal(selected.staging.health, "attention");
    assert.deepEqual(selected.staging.issues, ["staging_foreign_owner"]);
    assert.throws(
      () => cleanupStaging(environment, publicationId),
      (error) => error.code === "staging_cleanup_history_owned",
    );
    assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
    assert.equal(existsSync(stagingPath(environment, publicationId)), true);
    executedStagingScenarios.add("foreign_owned");
    executedStagingScenarios.add("foreign_active_precedence");
  });
});

test("known publication ownership never masks an unsafe staging filesystem shape", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_deep_map";
  const parent = join(environment.selectedOutputPath, ".pipeline-tmp");
  mkdirSync(parent, { recursive: true });
  const target = stagingPath(environment, publicationId);
  writeFileSync(target, "unsafe direct entry\n", "utf8");
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");

  let staging = deepValidate(environment).processes[0].staging;
  assert.equal(staging.health, "attention");
  assert.deepEqual(staging.issues, ["staging_invalid_entry"]);
  assert.deepEqual(staging.entries.map(({ classification, inventory_health }) => ({
    classification,
    inventory_health,
  })), [{ classification: "invalid_entry", inventory_health: "unsafe" }]);
  executedStagingScenarios.add("owner_direct_unsafe");

  unlinkSync(target);
  mkdirSync(target);
  symlinkSync("candidate.bin", join(target, "nested-link"));
  staging = deepValidate(environment).processes[0].staging;
  assert.equal(staging.health, "attention");
  assert.deepEqual(staging.issues, ["staging_invalid_entry"]);
  assert.equal(staging.entries[0].classification, "invalid_entry");
  assert.equal(staging.entries[0].inventory_health, "unsafe");
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  assert.equal(existsSync(target), true);
  executedStagingScenarios.add("owner_nested_unsafe");
});

test("foreign and prepared ownership never mask either unsafe staging route", async (t) => {
  const cases = [
    { ownerKind: "foreign", route: "direct" },
    { ownerKind: "foreign", route: "nested" },
    { ownerKind: "prepared", route: "direct" },
    { ownerKind: "prepared", route: "nested" },
  ];

  for (const fixture of cases) {
    await t.test(`${fixture.ownerKind}_${fixture.route}`, (subtest) => {
      const environment = createCompletedEnvironment(subtest, { includeHistorical: false });
      const log = readLogV3(environment.ledgerPath);
      let publicationId;
      if (fixture.ownerKind === "foreign") {
        const foreign = structuredClone(log.processes[0]);
        foreign.id = `proc_foreign_unsafe_${fixture.route}`;
        foreign.source_ref = `https://example.test/jobs/foreign-unsafe-${fixture.route}`;
        foreign.source_key = foreign.source_ref;
        foreign.output_dir = `output/foreign-unsafe-${fixture.route}`;
        for (const [stepName, step] of Object.entries(foreign.steps)) {
          for (const attempt of step.attempt_history) {
            if (attempt.publication_id !== null) {
              attempt.publication_id = `publication_foreign_unsafe_${fixture.route}_${stepName}`;
            }
          }
        }
        publicationId = `publication_foreign_unsafe_${fixture.route}_map_experience`;
        log.processes.push(foreign);
      } else {
        const running = createRunningPublicationStep();
        const originalPublicationId = running.publication_transaction.id;
        running.publication_transaction.id = `publication_prepared_unsafe_${fixture.route}`;
        for (const file of running.publication_transaction.files) {
          file.candidate_path = file.candidate_path.replace(
            originalPublicationId,
            running.publication_transaction.id,
          );
        }
        log.processes[0].steps.generate_cv = running;
        log.processes[0].updated_at = running.publication_transaction.prepared_at;
        log.updated_at = running.publication_transaction.prepared_at;
        publicationId = running.publication_transaction.id;
      }
      writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
      const target = stagingPath(environment, publicationId);
      mkdirSync(dirname(target), { recursive: true });
      if (fixture.route === "direct") {
        writeFileSync(target, "unsafe owned direct entry\n", "utf8");
      } else {
        mkdirSync(target);
        symlinkSync("candidate.bin", join(target, "nested-link"));
      }
      const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");

      const staging = deepValidate(environment).processes
        .find((entry) => entry.process_id === processId).staging;
      assert.equal(staging.health, "attention");
      assert.deepEqual(staging.issues, ["staging_invalid_entry"]);
      assert.equal(staging.entries[0].classification, "invalid_entry");
      assert.equal(staging.entries[0].inventory_health, "unsafe");
      assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
      assert.equal(existsSync(target), true);
      executedStagingScenarios.add(
        `owner_${fixture.ownerKind}_${fixture.route}_unsafe`,
      );
    });
  }
});

test("cleanup-staging preserves a foreign prepared publication with its exact recovery code", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const log = readLogV3(environment.ledgerPath);
  const foreign = structuredClone(log.processes[0]);
  foreign.id = "proc_foreign_prepared_owner";
  foreign.source_ref = "https://example.test/jobs/foreign-prepared-owner";
  foreign.source_key = foreign.source_ref;
  foreign.output_dir = "output/foreign-prepared-owner";
  for (const [stepName, step] of Object.entries(foreign.steps)) {
    for (const attempt of step.attempt_history) {
      if (attempt.publication_id !== null) {
        attempt.publication_id = `publication_foreign_prepared_${stepName}`;
      }
    }
  }
  const running = createRunningPublicationStep();
  foreign.steps.generate_cv = running;
  foreign.updated_at = running.publication_transaction.prepared_at;
  log.processes.push(foreign);
  log.updated_at = foreign.updated_at;
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  const publicationId = running.publication_transaction.id;
  const target = createStagingDirectory(environment, publicationId);
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => cleanupStaging(environment, publicationId),
    (error) => {
      assert.equal(error.code, "staging_cleanup_prepared_owned");
      assert.equal(
        error.message,
        "staging_cleanup_prepared_owned: cleanup-staging cannot remove prepared or committed recovery evidence",
      );
      return true;
    },
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  assert.equal(existsSync(target), true);
  executedStagingScenarios.add("foreign_prepared_cleanup");
});

test("unsafe and unbounded staging inventories stay visible but never become deletable", async (t) => {
  const cases = [
    {
      id: "direct_file",
      expectedCode: "staging_inventory_unsafe",
      expectedMessage: "staging target must be a non-symlink directory",
      arrange(environment, publicationId) {
        const parent = join(environment.selectedOutputPath, ".pipeline-tmp");
        mkdirSync(parent, { recursive: true });
        writeFileSync(join(parent, publicationId), "not a directory\n", "utf8");
      },
    },
    {
      id: "root_file",
      expectedCode: "staging_inventory_unsafe",
      expectedMessage: "staging root must be an exact non-symlink directory",
      targetExists: false,
      arrange(environment) {
        writeFileSync(
          join(environment.selectedOutputPath, ".pipeline-tmp"),
          "not a staging directory\n",
          "utf8",
        );
      },
    },
    {
      id: "root_symlink",
      expectedCode: "staging_inventory_unsafe",
      expectedMessage: "staging root must be an exact non-symlink directory",
      arrange(environment, publicationId) {
        const outside = join(environment.workspaceRoot, "synthetic-staging-root");
        const target = join(outside, publicationId);
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, "candidate.bin"), "root symlink bytes\n", "utf8");
        symlinkSync(outside, join(environment.selectedOutputPath, ".pipeline-tmp"));
      },
    },
    {
      id: "target_symlink",
      expectedCode: "staging_inventory_unsafe",
      expectedMessage: "staging target must be a non-symlink directory",
      arrange(environment, publicationId) {
        const parent = join(environment.selectedOutputPath, ".pipeline-tmp");
        const outside = join(environment.workspaceRoot, "synthetic-staging-target");
        mkdirSync(parent, { recursive: true });
        mkdirSync(outside, { recursive: true });
        writeFileSync(join(outside, "candidate.bin"), "target symlink bytes\n", "utf8");
        symlinkSync(outside, join(parent, publicationId));
      },
    },
    {
      id: "nested_symlink",
      expectedCode: "staging_inventory_unsafe",
      expectedMessage: "staging inventory contains a symbolic link",
      arrange(environment, publicationId) {
        const target = createStagingDirectory(environment, publicationId);
        const outside = join(environment.selectedOutputPath, "symlink-target.bin");
        writeFileSync(outside, "outside bytes\n", "utf8");
        symlinkSync(outside, join(target, "nested-link"));
      },
    },
    {
      id: "hardlink_inventory",
      expectedCode: "staging_inventory_unsafe",
      expectedMessage: "staging inventory contains a non-regular or multiply-linked file",
      arrange(environment, publicationId) {
        const target = createStagingDirectory(environment, publicationId);
        linkSync(join(target, "candidate.bin"), join(target, "candidate-hardlink.bin"));
      },
    },
    {
      id: "unbounded_depth",
      expectedCode: "staging_inventory_unbounded",
      expectedMessage: "staging inventory exceeds depth 16",
      arrange(environment, publicationId) {
        let target = createStagingDirectory(environment, publicationId);
        for (let depth = 0; depth < 18; depth += 1) {
          target = join(target, `depth-${depth}`);
          mkdirSync(target);
        }
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.id, () => {
      const environment = createCompletedEnvironment(t, { includeHistorical: false });
      const publicationId = `publication_${fixture.id}_001`;
      fixture.arrange(environment, publicationId);
      const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
      const process = deepValidate(environment).processes[0];
      assert.equal(process.staging.health, "attention");
      assert.equal(process.staging.entries[0].classification, "invalid_entry");
      assert.equal(process.staging.entries[0].inventory_health, "unsafe");
      assert.throws(
        () => cleanupStaging(environment, publicationId),
        (error) => {
          assert.equal(error.code, fixture.expectedCode);
          assert.equal(
            error.message,
            `${fixture.expectedCode}: ${fixture.expectedMessage}`,
          );
          return true;
        },
      );
      assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
      assert.equal(
        existsSync(stagingPath(environment, publicationId)),
        fixture.targetExists ?? true,
      );
      executedStagingScenarios.add(fixture.id);
    });
  }
});

test("staging parent realpath must remain inside the selected output", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_root_realpath_mismatch_001";
  const target = createStagingDirectory(environment, publicationId);
  const parent = join(environment.selectedOutputPath, ".pipeline-tmp");
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  const originalRealpathSync = fileSystem.realpathSync.bind(fileSystem);
  const mockedRealpathSync = t.mock.method(fileSystem, "realpathSync", (path, ...args) =>
    path === parent
      ? join(environment.workspaceRoot, "synthetic-outside-staging")
      : originalRealpathSync(path, ...args));
  syncBuiltinESMExports();
  try {
    const staging = deepValidate(environment).processes[0].staging;
    assert.equal(staging.health, "attention");
    assert.deepEqual(staging.issues, ["staging_inventory_unsafe"]);
    assert.equal(staging.entries[0].classification, "invalid_entry");
    assert.throws(
      () => cleanupStaging(environment, publicationId),
      (error) => {
        assert.equal(error.code, "staging_inventory_unsafe");
        assert.equal(
          error.message,
          "staging_inventory_unsafe: staging root must be an exact non-symlink directory",
        );
        return true;
      },
    );
  } finally {
    mockedRealpathSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  executedStagingScenarios.add("root_realpath_mismatch");
});

test("staging target realpath is contained before tree inspection", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_target_realpath_mismatch_001";
  const target = createStagingDirectory(environment, publicationId);
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  const originalOpendirSync = fileSystem.opendirSync.bind(fileSystem);
  const originalRealpathSync = fileSystem.realpathSync.bind(fileSystem);
  let targetOpenCalls = 0;
  const mockedOpendirSync = t.mock.method(fileSystem, "opendirSync", (path, ...args) => {
    if (path === target) targetOpenCalls += 1;
    return originalOpendirSync(path, ...args);
  });
  const mockedRealpathSync = t.mock.method(fileSystem, "realpathSync", (path, ...args) =>
    path === target
      ? join(environment.workspaceRoot, "synthetic-outside-target")
      : originalRealpathSync(path, ...args));
  syncBuiltinESMExports();
  try {
    const staging = deepValidate(environment).processes[0].staging;
    assert.equal(staging.health, "attention");
    assert.deepEqual(staging.issues, ["staging_invalid_entry"]);
    assert.equal(staging.entries[0].classification, "invalid_entry");
    assert.throws(
      () => cleanupStaging(environment, publicationId),
      (error) => {
        assert.equal(error.code, "staging_inventory_unsafe");
        assert.equal(
          error.message,
          "staging_inventory_unsafe: staging target realpath is outside its owned output directory",
        );
        return true;
      },
    );
  } finally {
    mockedOpendirSync.mock.restore();
    mockedRealpathSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(targetOpenCalls, 0);
  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  executedStagingScenarios.add("target_realpath_mismatch");
});

test("invalid transaction names stay visible without becoming cleanup selectors", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "invalid.name";
  const target = createStagingDirectory(environment, publicationId);
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");

  const staging = deepValidate(environment).processes[0].staging;
  assert.equal(staging.health, "attention");
  assert.deepEqual(staging.issues, ["staging_invalid_entry"]);
  assert.deepEqual(staging.entries.map((entry) => ({
    action: entry.action,
    classification: entry.classification,
    publication_id: entry.publication_id,
  })), [{
    action: "inspect_staging_inventory",
    classification: "invalid_entry",
    publication_id: null,
  }]);
  assert.throws(
    () => cleanupStaging(environment, publicationId),
    (error) => error.code === "invalid_cleanup_staging_input",
  );
  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  executedStagingScenarios.add("invalid_transaction_name");
});

test("nested non-regular staging entries stay visible and non-deletable", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_nested_nonregular_001";
  const target = createStagingDirectory(environment, publicationId);
  const candidatePath = join(target, "candidate.bin");
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  const originalLstatSync = fileSystem.lstatSync.bind(fileSystem);
  const mockedLstatSync = t.mock.method(fileSystem, "lstatSync", (path, ...args) => {
    const stats = originalLstatSync(path, ...args);
    if (path !== candidatePath) return stats;
    return new Proxy(stats, {
      get(value, property, receiver) {
        if (property === "isFile") return () => false;
        return Reflect.get(value, property, receiver);
      },
    });
  });
  syncBuiltinESMExports();
  try {
    const staging = deepValidate(environment).processes[0].staging;
    assert.equal(staging.health, "attention");
    assert.deepEqual(staging.issues, ["staging_invalid_entry"]);
    assert.equal(staging.entries[0].classification, "invalid_entry");
    assert.equal(staging.entries[0].inventory_health, "unsafe");
    assert.throws(
      () => cleanupStaging(environment, publicationId),
      (error) => error.code === "staging_inventory_unsafe",
    );
  } finally {
    mockedLstatSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  executedStagingScenarios.add("nested_nonregular");
});

test("cleanup-staging requires a fresh identity-bound token and removes only one exact child", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_cleanup_target_001";
  const siblingId = "publication_cleanup_sibling_001";
  const target = createStagingDirectory(environment, publicationId);
  const sibling = createStagingDirectory(environment, siblingId, "sibling bytes\n");
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  const canonicalBefore = Object.fromEntries(
    ["job-description.txt", "vacancy.json", "company-research.json", "application-brief.json"]
      .map((name) => [name, readFileSync(join(environment.selectedOutputPath, name))]),
  );

  const dryRun = cleanupStaging(environment, publicationId);
  assert.equal(dryRun.status, "review_required");
  assert.match(dryRun.confirmation_token, /^[a-f0-9]{64}$/);
  assert.equal(dryRun.process_id, processId);
  assert.equal(dryRun.publication_id, publicationId);
  assert.equal(dryRun.entry_count, 1);
  assert.match(dryRun.tree_digest, /^[a-f0-9]{64}$/);
  assert.equal(Number.isInteger(dryRun.age_ms), true);
  assert.equal(dryRun.age_ms >= 0, true);
  assert.equal(Number.isFinite(Date.parse(dryRun.modified_at)), true);
  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  executedStagingScenarios.add("dry_run");

  appendFileSync(join(target, "candidate.bin"), "changed after review\n", "utf8");
  assert.throws(
    () => cleanupStaging(environment, publicationId, dryRun.confirmation_token),
    (error) => error.code === "staging_cleanup_confirmation_mismatch",
  );
  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  executedStagingScenarios.add("stale_content_token");

  const sameSize = cleanupStaging(environment, publicationId);
  const candidatePath = join(target, "candidate.bin");
  const sizeBeforeRewrite = fileSystem.lstatSync(candidatePath).size;
  writeFileSync(candidatePath, "x".repeat(sizeBeforeRewrite), "utf8");
  fileSystem.utimesSync(candidatePath, new Date(0), new Date(0));
  assert.equal(fileSystem.lstatSync(candidatePath).size, sizeBeforeRewrite);
  const rewritten = cleanupStaging(environment, publicationId);
  assert.deepEqual(
    {
      entry_count: rewritten.entry_count,
      max_depth: rewritten.max_depth,
      modified_at: rewritten.modified_at,
      total_bytes: rewritten.total_bytes,
    },
    {
      entry_count: sameSize.entry_count,
      max_depth: sameSize.max_depth,
      modified_at: sameSize.modified_at,
      total_bytes: sameSize.total_bytes,
    },
  );
  assert.notEqual(rewritten.tree_digest, sameSize.tree_digest);
  assert.notEqual(rewritten.confirmation_token, sameSize.confirmation_token);
  assert.throws(
    () => cleanupStaging(environment, publicationId, sameSize.confirmation_token),
    (error) => {
      assert.equal(error.code, "staging_cleanup_confirmation_mismatch");
      assert.equal(
        error.message,
        "staging_cleanup_confirmation_mismatch: cleanup-staging confirmation no longer matches the exact inventory",
      );
      return true;
    },
  );
  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  executedStagingScenarios.add("same_size_rewrite_token");

  const fresh = cleanupStaging(environment, publicationId);
  const cleaned = cleanupStaging(environment, publicationId, fresh.confirmation_token);
  assert.equal(cleaned.status, "cleaned");
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(sibling), true);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  for (const [name, bytes] of Object.entries(canonicalBefore)) {
    assert.deepEqual(readFileSync(join(environment.selectedOutputPath, name)), bytes);
  }
  executedStagingScenarios.add("exact_confirm");
  executedStagingScenarios.add("sibling_preserved");

  assert.throws(
    () => cleanupStaging(environment, publicationId, fresh.confirmation_token),
    (error) => error.code === "staging_cleanup_target_missing",
  );
  executedStagingScenarios.add("missing_repeat");
});

test("cleanup-staging rejects malformed confirmation and a token stale by process update", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_process_update_token_001";
  const target = createStagingDirectory(environment, publicationId);
  const review = cleanupStaging(environment, publicationId);

  for (const invalidToken of [
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    `${"a".repeat(63)}g`,
    42,
    new String("a".repeat(64)),
  ]) {
    assert.throws(
      () => cleanupStaging(environment, publicationId, invalidToken),
      (error) => {
        assert.equal(error.code, "invalid_cleanup_staging_input");
        assert.equal(
          error.message,
          "invalid_cleanup_staging_input: confirmationToken must be null or a lowercase SHA-256 token",
        );
        return true;
      },
    );
  }
  assert.equal(existsSync(target), true);
  executedStagingScenarios.add("invalid_confirmation");

  const log = readLogV3(environment.ledgerPath);
  const record = log.processes[0];
  record.company_hint = "Synthetic reviewed identity update";
  record.updated_at = "2026-07-23T12:00:00.000Z";
  log.updated_at = record.updated_at;
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  const updatedLedger = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => cleanupStaging(environment, publicationId, review.confirmation_token),
    (error) => error.code === "staging_cleanup_confirmation_mismatch",
  );
  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), updatedLedger);
  executedStagingScenarios.add("process_update_token");
});

test("cleanup-staging rejects unknown input keys and an empty process id byte-stably", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_cleanup_input_contract_001";
  const target = createStagingDirectory(environment, publicationId);
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  const dependencies = {
    outputRoot: environment.outputRoot,
    workspaceRoot: environment.workspaceRoot,
  };

  assert.throws(
    () => cleanupFileBackedStagingV3(
      environment.ledgerPath,
      {
        processId,
        publicationId,
        confirmationToken: null,
        unexpected: true,
      },
      dependencies,
    ),
    (error) => {
      assert.equal(error.code, "invalid_cleanup_staging_input");
      assert.equal(
        error.message,
        "invalid_cleanup_staging_input: cleanup-staging input contains unknown key(s): unexpected",
      );
      return true;
    },
  );
  executedStagingScenarios.add("cleanup_exact_keys");

  assert.throws(
    () => cleanupFileBackedStagingV3(
      environment.ledgerPath,
      { processId: "", publicationId, confirmationToken: null },
      dependencies,
    ),
    (error) => {
      assert.equal(error.code, "invalid_cleanup_staging_input");
      assert.equal(
        error.message,
        "invalid_cleanup_staging_input: processId must not be empty",
      );
      return true;
    },
  );
  executedStagingScenarios.add("cleanup_process_id");
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  assert.equal(existsSync(target), true);
});

test("cleanup-staging reports its exact operation when rejecting a historical process", (t) => {
  const environment = createCompletedEnvironment(t);
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => cleanupFileBackedStagingV3(
      environment.ledgerPath,
      {
        processId: "proc_historical_deep",
        publicationId: "publication_historical_cleanup_001",
        confirmationToken: null,
      },
      {
        outputRoot: environment.outputRoot,
        workspaceRoot: environment.workspaceRoot,
      },
    ),
    (error) => {
      assert.equal(error.code, "historical_process_read_only");
      assert.equal(
        error.message,
        "historical_process_read_only: historical process proc_historical_deep is read-only and cannot run cleanup-staging",
      );
      return true;
    },
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  executedStagingScenarios.add("historical_cleanup_guard");
});

test("cleanup-staging rejects a missing exact staging parent byte-stably", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_missing_parent_001";
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  assert.equal(existsSync(join(environment.selectedOutputPath, ".pipeline-tmp")), false);

  assert.throws(
    () => cleanupStaging(environment, publicationId),
    (error) => {
      assert.equal(error.code, "staging_inventory_unreadable");
      assert.equal(
        error.message,
        "staging_inventory_unreadable: staging inventory could not be inspected (ENOENT)",
      );
      return true;
    },
  );
  assert.equal(existsSync(join(environment.selectedOutputPath, ".pipeline-tmp")), false);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  executedStagingScenarios.add("missing_parent");
});

test("staging age evidence is exact, clamped, and not itself token authority", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_age_evidence_001";
  const target = createStagingDirectory(environment, publicationId);
  const modifiedAt = "2026-07-23T11:30:00.000Z";
  fileSystem.utimesSync(target, new Date(modifiedAt), new Date(modifiedAt));
  let nowMs = Date.parse("2026-07-23T11:40:00.000Z");
  t.mock.method(Date, "now", () => nowMs);

  const review = cleanupStaging(environment, publicationId);
  assert.equal(review.modified_at, modifiedAt);
  assert.equal(review.age_ms, 600_000);
  nowMs += 120_000;
  const cleaned = cleanupStaging(
    environment,
    publicationId,
    review.confirmation_token,
  );
  assert.equal(cleaned.status, "cleaned");
  assert.equal(cleaned.age_ms, 720_000);
  assert.equal(cleaned.modified_at, modifiedAt);
  assert.equal(cleaned.confirmation_token, review.confirmation_token);

  const futureId = "publication_future_age_evidence_001";
  const futureTarget = createStagingDirectory(environment, futureId);
  const futureModifiedAt = new Date(nowMs + 60_000).toISOString();
  fileSystem.utimesSync(
    futureTarget,
    new Date(futureModifiedAt),
    new Date(futureModifiedAt),
  );
  const futureReview = cleanupStaging(environment, futureId);
  assert.equal(futureReview.modified_at, futureModifiedAt);
  assert.equal(futureReview.age_ms, 0);
  assert.equal(existsSync(futureTarget), true);
  executedStagingScenarios.add("age_evidence");
});

test("cleanup token binds the selected process id independently of its timestamp", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_process_id_token_001";
  const target = createStagingDirectory(environment, publicationId);
  const review = cleanupStaging(environment, publicationId);
  const reboundId = "proc_fixture_step1_completed_rebound";
  const log = readLogV3(environment.ledgerPath);
  log.processes[0].id = reboundId;
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  const reboundBytes = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => cleanupStaging(
      environment,
      publicationId,
      review.confirmation_token,
      { processId: reboundId },
    ),
    (error) => error.code === "staging_cleanup_confirmation_mismatch",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), reboundBytes);
  assert.equal(existsSync(target), true);
  executedStagingScenarios.add("process_id_token");
});

test("cleanup token binds publication id even for identical mocked snapshots", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const firstId = "publication_scope_token_first_001";
  const secondId = "publication_scope_token_second_001";
  const firstTarget = createStagingDirectory(environment, firstId);
  const secondTarget = createStagingDirectory(environment, secondId);
  const firstCandidate = join(firstTarget, "candidate.bin");
  const secondCandidate = join(secondTarget, "candidate.bin");
  const firstReview = cleanupStaging(environment, firstId);
  const originalLstatSync = fileSystem.lstatSync.bind(fileSystem);
  const firstRootStats = originalLstatSync(firstTarget, { bigint: true });
  const firstCandidateStats = originalLstatSync(firstCandidate, { bigint: true });
  const mockedLstatSync = t.mock.method(fileSystem, "lstatSync", (path, ...args) => {
    if (path === secondTarget) return firstRootStats;
    if (path === secondCandidate) return firstCandidateStats;
    return originalLstatSync(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    const secondReview = cleanupStaging(environment, secondId);
    assert.equal(secondReview.tree_digest, firstReview.tree_digest);
    assert.notEqual(secondReview.confirmation_token, firstReview.confirmation_token);
    assert.throws(
      () => cleanupStaging(
        environment,
        secondId,
        firstReview.confirmation_token,
      ),
      (error) => error.code === "staging_cleanup_confirmation_mismatch",
    );
  } finally {
    mockedLstatSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(existsSync(firstTarget), true);
  assert.equal(existsSync(secondTarget), true);
  executedStagingScenarios.add("publication_id_token");
});

test("staging inventory failures stay typed, bounded, and byte-stable", async (t) => {
  const cases = [
    {
      id: "tree_open_error",
      method: "opendirSync",
      causeCode: "EACCES",
      message: "staging directory could not be opened (EACCES)",
    },
    {
      id: "tree_read_error",
      method: "readSync",
      causeCode: "EIO",
      message: "staging directory could not be listed (EIO)",
      expectedCloseCount: 2,
    },
    {
      id: "tree_lstat_error",
      method: "lstatSync",
      causeCode: "EPERM",
      message: "staging inventory could not be inspected (EPERM)",
    },
    {
      id: "tree_realpath_error",
      method: "realpathSync",
      causeCode: "EACCES",
      message: "staging inventory realpath could not be inspected (EACCES)",
    },
    {
      id: "tree_hostile_error_getter",
      scenarioId: "tree_hostile_error",
      method: "lstatSync",
      hostileGetter: true,
      message: "staging inventory could not be inspected (UNKNOWN)",
    },
    {
      id: "tree_hostile_error_exact_64",
      scenarioId: "tree_hostile_error",
      method: "lstatSync",
      causeCode: "E".repeat(64),
      message: `staging inventory could not be inspected (${"E".repeat(64)})`,
    },
    {
      id: "tree_hostile_error_oversize",
      scenarioId: "tree_hostile_error",
      method: "lstatSync",
      causeCode: "E".repeat(65),
      message: "staging inventory could not be inspected (UNKNOWN)",
    },
    {
      id: "tree_hostile_error_lowercase",
      scenarioId: "tree_hostile_error",
      method: "lstatSync",
      causeCode: "eacces",
      message: "staging inventory could not be inspected (UNKNOWN)",
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.id, (subtest) => {
      const environment = createCompletedEnvironment(subtest, { includeHistorical: false });
      const publicationId = `publication_${fixture.id}_001`;
      const target = createStagingDirectory(environment, publicationId);
      const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
      const originalOpendirSync = fileSystem.opendirSync.bind(fileSystem);
      const originalLstatSync = fileSystem.lstatSync.bind(fileSystem);
      const originalRealpathSync = fileSystem.realpathSync.bind(fileSystem);
      let closeCount = 0;
      let mocked;
      if (fixture.method === "opendirSync") {
        mocked = subtest.mock.method(fileSystem, "opendirSync", (path, ...args) => {
          if (path === target) {
            throw Object.assign(new Error("synthetic open failure"), {
              code: fixture.causeCode,
            });
          }
          return originalOpendirSync(path, ...args);
        });
      } else if (fixture.method === "readSync") {
        mocked = subtest.mock.method(fileSystem, "opendirSync", (path, ...args) => {
          const directory = originalOpendirSync(path, ...args);
          if (path !== target) return directory;
          const originalCloseSync = directory.closeSync.bind(directory);
          directory.readSync = () => {
            throw Object.assign(new Error("synthetic read failure"), {
              code: fixture.causeCode,
            });
          };
          directory.closeSync = () => {
            closeCount += 1;
            return originalCloseSync();
          };
          return directory;
        });
      } else if (fixture.method === "lstatSync") {
        mocked = subtest.mock.method(fileSystem, "lstatSync", (path, ...args) => {
          if (path !== target) return originalLstatSync(path, ...args);
          const error = new Error("synthetic metadata failure");
          if (!fixture.hostileGetter) {
            throw Object.assign(error, { code: fixture.causeCode });
          }
          throw new Proxy(error, {
            get(value, property, receiver) {
              if (property === "code") throw new Error("hostile code getter");
              return Reflect.get(value, property, receiver);
            },
          });
        });
      } else {
        mocked = subtest.mock.method(fileSystem, "realpathSync", (path, ...args) => {
          if (path === target) {
            throw Object.assign(new Error("synthetic realpath failure"), {
              code: fixture.causeCode,
            });
          }
          return originalRealpathSync(path, ...args);
        });
      }
      syncBuiltinESMExports();
      try {
        const staging = deepValidate(environment).processes[0].staging;
        assert.equal(staging.health, "attention");
        assert.deepEqual(staging.issues, ["staging_invalid_entry"]);
        assert.equal(staging.entries[0].classification, "invalid_entry");
        assert.throws(
          () => cleanupStaging(environment, publicationId),
          (error) => {
            assert.equal(error.code, "staging_inventory_unreadable");
            assert.equal(
              error.message,
              `staging_inventory_unreadable: ${fixture.message}`,
            );
            return true;
          },
        );
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(closeCount, fixture.expectedCloseCount ?? 0);
      assert.equal(existsSync(target), true);
      assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
      executedStagingScenarios.add(fixture.scenarioId ?? fixture.id);
    });
  }
});

test("cleanup-staging rejects an inode replacement even when replacement bytes are equal", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_inode_replacement_001";
  const target = createStagingDirectory(environment, publicationId);
  const dryRun = cleanupStaging(environment, publicationId);
  rmSync(target, { recursive: true });
  createStagingDirectory(environment, publicationId);

  assert.throws(
    () => cleanupStaging(environment, publicationId, dryRun.confirmation_token),
    (error) => error.code === "staging_cleanup_confirmation_mismatch",
  );
  assert.equal(existsSync(target), true);
  executedStagingScenarios.add("inode_replacement");
});

test("cleanup-staging token binds an empty staging root identity", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_empty_root_inode_replacement_001";
  const target = createStagingDirectory(environment, publicationId);
  unlinkSync(join(target, "candidate.bin"));
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  const dryRun = cleanupStaging(environment, publicationId);
  assert.equal(dryRun.entry_count, 0);

  rmSync(target, { recursive: true });
  mkdirSync(target);
  assert.throws(
    () => cleanupStaging(environment, publicationId, dryRun.confirmation_token),
    (error) => error.code === "staging_cleanup_confirmation_mismatch",
  );
  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  executedStagingScenarios.add("empty_root_inode_replacement");
});

test("cleanup-staging token binds empty nested-directory metadata", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_directory_metadata_token_001";
  const target = createStagingDirectory(environment, publicationId);
  const nestedDirectory = join(target, "empty-nested-directory");
  mkdirSync(nestedDirectory, { mode: 0o755 });
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  const dryRun = cleanupStaging(environment, publicationId);

  chmodSync(nestedDirectory, 0o700);
  assert.throws(
    () => cleanupStaging(environment, publicationId, dryRun.confirmation_token),
    (error) => {
      assert.equal(error.code, "staging_cleanup_confirmation_mismatch");
      assert.equal(
        error.message,
        "staging_cleanup_confirmation_mismatch: cleanup-staging confirmation no longer matches the exact inventory",
      );
      return true;
    },
  );
  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  executedStagingScenarios.add("directory_metadata_token");
});

test("staging inventory detects a root identity change during one snapshot", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_root_identity_race_001";
  const target = createStagingDirectory(environment, publicationId);
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  const originalLstatSync = fileSystem.lstatSync;
  let targetLstatCalls = 0;
  const mockedLstatSync = t.mock.method(
    fileSystem,
    "lstatSync",
    (path, options) => {
      if (path === target) {
        targetLstatCalls += 1;
        if (targetLstatCalls === 2) fileSystem.chmodSync(target, 0o700);
      }
      return originalLstatSync(path, options);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => cleanupStaging(environment, publicationId),
      (error) => error.code === "staging_inventory_changed",
    );
  } finally {
    mockedLstatSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(targetLstatCalls, 2);
  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  executedStagingScenarios.add("root_identity_race");
});

test("staging inventory rechecks every root predicate after the tree walk", async (t) => {
  const cases = [
    { id: "final_directory_race", finalProperty: "isDirectory" },
    { id: "final_symlink_race", finalProperty: "isSymbolicLink" },
    { id: "final_realpath_race", finalProperty: "realpath" },
  ];
  for (const fixture of cases) {
    await t.test(fixture.id, (subtest) => {
      const environment = createCompletedEnvironment(subtest, { includeHistorical: false });
      const publicationId = `publication_${fixture.id}_001`;
      const target = createStagingDirectory(environment, publicationId);
      const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
      const originalLstatSync = fileSystem.lstatSync.bind(fileSystem);
      const originalRealpathSync = fileSystem.realpathSync.bind(fileSystem);
      let targetLstatCalls = 0;
      let targetRealpathCalls = 0;
      const mockedLstatSync = subtest.mock.method(
        fileSystem,
        "lstatSync",
        (path, ...args) => {
          const stats = originalLstatSync(path, ...args);
          if (path !== target) return stats;
          targetLstatCalls += 1;
          if (targetLstatCalls !== 2 || fixture.finalProperty === "realpath") return stats;
          return new Proxy(stats, {
            get(value, property, receiver) {
              if (property === fixture.finalProperty) {
                return () => fixture.finalProperty === "isSymbolicLink";
              }
              return Reflect.get(value, property, receiver);
            },
          });
        },
      );
      const mockedRealpathSync = subtest.mock.method(
        fileSystem,
        "realpathSync",
        (path, ...args) => {
          const realPath = originalRealpathSync(path, ...args);
          if (path !== target) return realPath;
          targetRealpathCalls += 1;
          return fixture.finalProperty === "realpath" && targetRealpathCalls === 2
            ? join(environment.workspaceRoot, "synthetic-raced-target")
            : realPath;
        },
      );
      syncBuiltinESMExports();
      try {
        assert.throws(
          () => cleanupStaging(environment, publicationId),
          (error) => {
            assert.equal(error.code, "staging_inventory_changed");
            assert.equal(
              error.message,
              "staging_inventory_changed: staging root identity changed while it was inspected",
            );
            return true;
          },
        );
      } finally {
        mockedLstatSync.mock.restore();
        mockedRealpathSync.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(targetLstatCalls, 2);
      assert.equal(targetRealpathCalls, fixture.finalProperty === "realpath" ? 2 : 1);
      assert.equal(existsSync(target), true);
      assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
      executedStagingScenarios.add(fixture.id);
    });
  }
});

test("cleanup-staging repeats the complete inventory immediately before removal", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_second_snapshot_race_001";
  const target = createStagingDirectory(environment, publicationId);
  const review = cleanupStaging(environment, publicationId);
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  const originalLstatSync = fileSystem.lstatSync;
  const originalRmSync = fileSystem.rmSync.bind(fileSystem);
  let targetLstatCalls = 0;
  let removeCalls = 0;
  const mockedLstatSync = t.mock.method(
    fileSystem,
    "lstatSync",
    (path, options) => {
      const stats = originalLstatSync(path, options);
      if (path === target) {
        targetLstatCalls += 1;
        if (targetLstatCalls === 2) {
          writeFileSync(join(target, "raced-candidate.bin"), "raced bytes\n", "utf8");
        }
      }
      return stats;
    },
  );
  const mockedRmSync = t.mock.method(fileSystem, "rmSync", (...args) => {
    removeCalls += 1;
    return originalRmSync(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => cleanupStaging(environment, publicationId, review.confirmation_token),
      (error) => error.code === "staging_inventory_changed",
    );
  } finally {
    mockedLstatSync.mock.restore();
    mockedRmSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(targetLstatCalls >= 3, true);
  assert.equal(removeCalls, 0);
  assert.equal(existsSync(target), true);
  assert.equal(existsSync(join(target, "raced-candidate.bin")), true);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  executedStagingScenarios.add("second_snapshot_race");
});

test("cleanup-staging binds digest and root identity independently across snapshots", async (t) => {
  const cases = [
    { id: "second_snapshot_digest", mutation: "digest" },
    { id: "second_snapshot_root_identity", mutation: "root_identity" },
  ];
  for (const fixture of cases) {
    await t.test(fixture.id, (subtest) => {
      const environment = createCompletedEnvironment(subtest, { includeHistorical: false });
      const publicationId = `publication_${fixture.id}_001`;
      const target = createStagingDirectory(environment, publicationId);
      const candidatePath = join(target, "candidate.bin");
      const review = cleanupStaging(environment, publicationId);
      const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
      const originalLstatSync = fileSystem.lstatSync.bind(fileSystem);
      const originalRmSync = fileSystem.rmSync.bind(fileSystem);
      let targetLstatCalls = 0;
      let removeCalls = 0;
      const mockedLstatSync = subtest.mock.method(
        fileSystem,
        "lstatSync",
        (path, ...args) => {
          const stats = originalLstatSync(path, ...args);
          if (path === target) {
            targetLstatCalls += 1;
            if (targetLstatCalls === 2) {
              if (fixture.mutation === "root_identity") {
                chmodSync(target, 0o700);
              } else {
                const size = originalLstatSync(candidatePath).size;
                writeFileSync(candidatePath, "x".repeat(size), "utf8");
              }
            }
          }
          return stats;
        },
      );
      const mockedRmSync = subtest.mock.method(fileSystem, "rmSync", (...args) => {
        removeCalls += 1;
        return originalRmSync(...args);
      });
      syncBuiltinESMExports();
      try {
        assert.throws(
          () => cleanupStaging(environment, publicationId, review.confirmation_token),
          (error) => {
            assert.equal(error.code, "staging_inventory_changed");
            assert.equal(
              error.message,
              "staging_inventory_changed: staging inventory changed before cleanup",
            );
            return true;
          },
        );
      } finally {
        mockedLstatSync.mock.restore();
        mockedRmSync.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(targetLstatCalls, 4);
      assert.equal(removeCalls, 0);
      assert.equal(existsSync(target), true);
      assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
      executedStagingScenarios.add(fixture.id);
    });
  }
});

test("cleanup-staging reports removal errors and a surviving postcondition", async (t) => {
  const cases = [
    {
      id: "remove_error",
      message: "staging_cleanup_remove_failed: staging cleanup could not remove the reviewed target (EACCES)",
      remove(targetPath) {
        throw Object.assign(new Error(`synthetic remove failure for ${targetPath}`), {
          code: "EACCES",
        });
      },
    },
    {
      id: "remove_postcondition",
      message: "staging_cleanup_remove_failed: staging cleanup did not remove the reviewed target",
      remove() {},
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.id, () => {
      const environment = createCompletedEnvironment(t, { includeHistorical: false });
      const publicationId = `publication_${fixture.id}_001`;
      const target = createStagingDirectory(environment, publicationId);
      const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
      const review = cleanupStaging(environment, publicationId);
      const originalRmSync = fileSystem.rmSync.bind(fileSystem);
      const mockedRmSync = t.mock.method(fileSystem, "rmSync", (targetPath, ...args) => {
        if (targetPath === target) return fixture.remove(targetPath);
        return originalRmSync(targetPath, ...args);
      });
      syncBuiltinESMExports();
      try {
        assert.throws(
          () => cleanupStaging(environment, publicationId, review.confirmation_token),
          (error) => {
            assert.equal(error.code, "staging_cleanup_remove_failed");
            assert.equal(error.message, fixture.message);
            return true;
          },
        );
      } finally {
        mockedRmSync.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(existsSync(target), true);
      assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
      executedStagingScenarios.add(fixture.id);
    });
  }
});

test("staging inspection and cleanup use bounded metadata without reading candidate bytes", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_metadata_only_001";
  const target = createStagingDirectory(environment, publicationId);
  chmodSync(join(target, "candidate.bin"), 0o000);
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");

  const entry = deepValidate(environment).processes[0].staging.entries[0];
  assert.equal(entry.classification, "orphan");
  assert.equal(entry.inventory_health, "safe");
  const review = cleanupStaging(environment, publicationId);
  assert.equal(review.status, "review_required");
  assert.equal(
    cleanupStaging(environment, publicationId, review.confirmation_token).status,
    "cleaned",
  );
  assert.equal(existsSync(target), false);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  executedStagingScenarios.add("metadata_only");
});

test("deep staging reports parent open and read failures without inventing overflow", async (t) => {
  const cases = [
    {
      id: "parent_open_error",
      causeCode: "EACCES",
      mode: "open",
      expectedCloseCount: 0,
    },
    {
      id: "parent_read_error",
      causeCode: "EIO",
      mode: "read",
      expectedCloseCount: 1,
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.id, (subtest) => {
      const environment = createCompletedEnvironment(subtest, { includeHistorical: false });
      const publicationId = `publication_${fixture.id}_001`;
      const target = createStagingDirectory(environment, publicationId);
      const parent = join(environment.selectedOutputPath, ".pipeline-tmp");
      const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
      const originalOpendirSync = fileSystem.opendirSync.bind(fileSystem);
      let closeCount = 0;
      const mockedOpendirSync = subtest.mock.method(
        fileSystem,
        "opendirSync",
        (path, ...args) => {
          if (path !== parent) return originalOpendirSync(path, ...args);
          if (fixture.mode === "open") {
            throw Object.assign(new Error("synthetic parent open failure"), {
              code: fixture.causeCode,
            });
          }
          const directory = originalOpendirSync(path, ...args);
          const originalCloseSync = directory.closeSync.bind(directory);
          directory.readSync = () => {
            throw Object.assign(new Error("synthetic parent read failure"), {
              code: fixture.causeCode,
            });
          };
          directory.closeSync = () => {
            closeCount += 1;
            return originalCloseSync();
          };
          return directory;
        },
      );
      syncBuiltinESMExports();
      try {
        const staging = deepValidate(environment).processes[0].staging;
        assert.equal(staging.health, "attention");
        assert.deepEqual(staging.issues, ["staging_inventory_unreadable"]);
        assert.deepEqual(staging.entries, []);
      } finally {
        mockedOpendirSync.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(closeCount, fixture.expectedCloseCount);
      assert.equal(existsSync(target), true);
      assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
      executedStagingScenarios.add(fixture.id);
    });
  }
});

test("deep staging preserves typed parent metadata failures", async (t) => {
  const cases = [
    { id: "parent_lstat_error", method: "lstatSync", causeCode: "EACCES" },
    { id: "parent_realpath_error", method: "realpathSync", causeCode: "EIO" },
  ];
  for (const fixture of cases) {
    await t.test(fixture.id, (subtest) => {
      const environment = createCompletedEnvironment(subtest, { includeHistorical: false });
      const publicationId = `publication_${fixture.id}_001`;
      const target = createStagingDirectory(environment, publicationId);
      const parent = join(environment.selectedOutputPath, ".pipeline-tmp");
      const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
      const originalMethod = fileSystem[fixture.method].bind(fileSystem);
      const mocked = subtest.mock.method(
        fileSystem,
        fixture.method,
        (path, ...args) => {
          if (path === parent) {
            throw Object.assign(new Error("synthetic parent metadata failure"), {
              code: fixture.causeCode,
            });
          }
          return originalMethod(path, ...args);
        },
      );
      syncBuiltinESMExports();
      try {
        const staging = deepValidate(environment).processes[0].staging;
        assert.equal(staging.health, "attention");
        assert.deepEqual(staging.issues, ["staging_inventory_unreadable"]);
        assert.deepEqual(staging.entries, [{
          publication_id: null,
          classification: "invalid_entry",
          action: "inspect_staging_inventory",
          inventory_health: "unsafe",
        }]);
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(existsSync(target), true);
      assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
      executedStagingScenarios.add(fixture.id);
    });
  }
});

test("staging tree digest is byte-ordered and independent of enumeration order", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_tree_order_001";
  const target = createStagingDirectory(environment, publicationId);
  writeFileSync(join(target, "z.bin"), "z\n", "utf8");
  writeFileSync(join(target, "ä.bin"), "umlaut\n", "utf8");
  const names = ["candidate.bin", "z.bin", "ä.bin"].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  const expectedEntries = names.map((name) => {
    const stats = fileSystem.lstatSync(join(target, name), { bigint: true });
    return {
      path: name,
      type: "file",
      ctime_ns: stats.ctimeNs.toString(),
      dev: stats.dev.toString(),
      ino: stats.ino.toString(),
      mode: stats.mode.toString(),
      mtime_ns: stats.mtimeNs.toString(),
      nlink: stats.nlink.toString(),
      size: stats.size.toString(),
    };
  });
  const expectedDigest = sha256Hex(JSON.stringify(expectedEntries));
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  const originalOpendirSync = fileSystem.opendirSync.bind(fileSystem);
  let targetReadCount = 0;
  const mockedOpendirSync = t.mock.method(fileSystem, "opendirSync", (path, ...args) => {
    const directory = originalOpendirSync(path, ...args);
    if (path !== target) return directory;
    const entries = [];
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      entries.push(entry);
    }
    if (targetReadCount % 2 === 1) entries.reverse();
    targetReadCount += 1;
    let index = 0;
    return {
      readSync() {
        return entries[index++] ?? null;
      },
      closeSync() {
        return directory.closeSync();
      },
    };
  });
  syncBuiltinESMExports();
  try {
    const review = cleanupStaging(environment, publicationId);
    assert.equal(review.tree_digest, expectedDigest);
    const cleaned = cleanupStaging(
      environment,
      publicationId,
      review.confirmation_token,
    );
    assert.equal(cleaned.status, "cleaned");
    assert.equal(cleaned.tree_digest, expectedDigest);
  } finally {
    mockedOpendirSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(targetReadCount, 3);
  assert.equal(existsSync(target), false);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  executedStagingScenarios.add("tree_order");
});

test("staging digest preserves nested routes, directory types, and maximum depth", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_nested_route_metadata_001";
  const target = createStagingDirectory(environment, publicationId);
  const alpha = join(target, "alpha");
  const deep = join(alpha, "deep");
  const deepLeaf = join(deep, "shared.bin");
  const beta = join(target, "beta");
  const shallowLeaf = join(beta, "shared.bin");
  mkdirSync(deep, { recursive: true });
  mkdirSync(beta);
  writeFileSync(deepLeaf, "same leaf bytes\n", "utf8");
  writeFileSync(shallowLeaf, "same leaf bytes\n", "utf8");
  const expectedEntries = [
    expectedStagingEntry("alpha", "directory", alpha),
    expectedStagingEntry("alpha/deep", "directory", deep),
    expectedStagingEntry("alpha/deep/shared.bin", "file", deepLeaf),
    expectedStagingEntry("beta", "directory", beta),
    expectedStagingEntry("beta/shared.bin", "file", shallowLeaf),
    expectedStagingEntry("candidate.bin", "file", join(target, "candidate.bin")),
  ];
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");

  const review = cleanupStaging(environment, publicationId);
  assert.equal(review.entry_count, 6);
  assert.equal(review.max_depth, 2);
  assert.equal(
    review.total_bytes,
    Number(fileSystem.lstatSync(deepLeaf).size)
      + Number(fileSystem.lstatSync(shallowLeaf).size)
      + Number(fileSystem.lstatSync(join(target, "candidate.bin")).size),
  );
  assert.equal(review.tree_digest, sha256Hex(JSON.stringify(expectedEntries)));
  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  executedStagingScenarios.add("nested_route_metadata");
});

test("deep staging rejects a symlink-marked parent entry before target inspection", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_parent_dirent_symlink_001";
  const target = createStagingDirectory(environment, publicationId);
  const parent = dirname(target);
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  const originalOpendirSync = fileSystem.opendirSync.bind(fileSystem);
  let targetOpenCalls = 0;
  const mockedOpendirSync = t.mock.method(fileSystem, "opendirSync", (path, ...args) => {
    const directory = originalOpendirSync(path, ...args);
    if (path === target) {
      targetOpenCalls += 1;
      return directory;
    }
    if (path !== parent) return directory;
    return {
      readSync() {
        const entry = directory.readSync();
        if (entry?.name !== publicationId) return entry;
        return new Proxy(entry, {
          get(value, property, receiver) {
            if (property === "isDirectory" || property === "isSymbolicLink") {
              return () => true;
            }
            return Reflect.get(value, property, receiver);
          },
        });
      },
      closeSync() {
        return directory.closeSync();
      },
    };
  });
  syncBuiltinESMExports();
  let staging;
  try {
    staging = deepValidate(environment).processes[0].staging;
  } finally {
    mockedOpendirSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(targetOpenCalls, 0);
  assert.equal(staging.health, "attention");
  assert.deepEqual(staging.issues, ["staging_invalid_entry"]);
  assert.deepEqual(staging.entries, [{
    publication_id: publicationId,
    classification: "invalid_entry",
    action: "inspect_staging_inventory",
    inventory_health: "unsafe",
  }]);
  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  executedStagingScenarios.add("parent_dirent_symlink");
});

test("deep staging inspection bounds the direct publication inventory", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  const parent = join(environment.selectedOutputPath, ".pipeline-tmp");
  mkdirSync(parent, { recursive: true });

  for (let index = 0; index < 64; index += 1) {
    mkdirSync(join(parent, `publication_parent_budget_${index}`));
  }
  const boundary = deepValidate(environment).processes[0].staging;
  assert.equal(boundary.entries.length, 64);
  assert.equal(boundary.entries.every(({ classification }) => classification === "orphan"), true);
  assert.deepEqual(boundary.issues, ["staging_orphan"]);
  executedStagingScenarios.add("parent_entry_boundary");

  mkdirSync(join(parent, "publication_parent_budget_64"));
  const overflow = deepValidate(environment).processes[0].staging;
  assert.equal(overflow.health, "attention");
  assert.deepEqual(overflow.issues, ["staging_inventory_unbounded"]);
  assert.deepEqual(overflow.entries, []);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  assert.equal(existsSync(join(parent, "publication_parent_budget_64")), true);
  executedStagingScenarios.add("parent_entry_overflow");
});

test("staging tree inventory streams its exact entry budget and closes descriptors", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_tree_entry_budget_001";
  const target = createStagingDirectory(environment, publicationId);
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  for (let index = 1; index < 1_024; index += 1) {
    writeFileSync(join(target, `candidate-${index}.bin`), "", "utf8");
  }

  const originalOpendirSync = fileSystem.opendirSync.bind(fileSystem);
  let opened = 0;
  let closed = 0;
  const mockedOpendirSync = t.mock.method(fileSystem, "opendirSync", (...args) => {
    const directory = originalOpendirSync(...args);
    const originalCloseSync = directory.closeSync.bind(directory);
    directory.closeSync = () => {
      closed += 1;
      return originalCloseSync();
    };
    opened += 1;
    return directory;
  });
  syncBuiltinESMExports();
  try {
    const boundary = deepValidate(environment).processes[0].staging.entries[0];
    assert.equal(boundary.classification, "orphan");
    assert.equal(boundary.inventory_health, "safe");
    assert.equal(boundary.entry_count, 1_024);
    executedStagingScenarios.add("tree_entry_boundary");

    writeFileSync(join(target, "candidate-1024.bin"), "", "utf8");
    const overflow = deepValidate(environment).processes[0].staging;
    assert.equal(overflow.health, "attention");
    assert.deepEqual(overflow.issues, ["staging_invalid_entry"]);
    assert.equal(overflow.entries[0].classification, "invalid_entry");
    assert.equal(overflow.entries[0].inventory_health, "unsafe");
    assert.throws(
      () => cleanupStaging(environment, publicationId),
      (error) => error.code === "staging_inventory_unbounded",
    );
    executedStagingScenarios.add("tree_entry_overflow");
  } finally {
    mockedOpendirSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(opened >= 5, true);
  assert.equal(closed, opened);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  assert.equal(existsSync(target), true);
});

test("staging tree inventory enforces its exact depth budget", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_tree_depth_budget_001";
  const target = createStagingDirectory(environment, publicationId);
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  let nested = target;
  for (let depth = 0; depth < 16; depth += 1) {
    nested = join(nested, `depth-${depth}`);
    mkdirSync(nested);
  }

  const boundary = deepValidate(environment).processes[0].staging.entries[0];
  assert.equal(boundary.classification, "orphan");
  assert.equal(boundary.inventory_health, "safe");
  assert.equal(boundary.max_depth, 16);
  executedStagingScenarios.add("tree_depth_boundary");

  nested = join(nested, "depth-16");
  mkdirSync(nested);
  const overflow = deepValidate(environment).processes[0].staging;
  assert.equal(overflow.health, "attention");
  assert.deepEqual(overflow.issues, ["staging_invalid_entry"]);
  assert.equal(overflow.entries[0].classification, "invalid_entry");
  assert.equal(overflow.entries[0].inventory_health, "unsafe");
  assert.throws(
    () => cleanupStaging(environment, publicationId),
    (error) => error.code === "staging_inventory_unbounded",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  assert.equal(existsSync(target), true);
  executedStagingScenarios.add("tree_depth_overflow");
});

test("staging tree inventory enforces the exact sparse-byte budget", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_tree_byte_budget_001";
  const target = createStagingDirectory(environment, publicationId);
  const candidatePath = join(target, "candidate.bin");
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  const exactBytes = 64 * 1024 * 1024;

  fileSystem.truncateSync(candidatePath, exactBytes);
  const boundary = deepValidate(environment).processes[0].staging.entries[0];
  assert.equal(boundary.classification, "orphan");
  assert.equal(boundary.inventory_health, "safe");
  assert.equal(boundary.total_bytes, exactBytes);
  assert.equal(cleanupStaging(environment, publicationId).total_bytes, exactBytes);
  executedStagingScenarios.add("tree_byte_boundary");

  fileSystem.truncateSync(candidatePath, exactBytes + 1);
  const overflow = deepValidate(environment).processes[0].staging;
  assert.equal(overflow.health, "attention");
  assert.deepEqual(overflow.issues, ["staging_invalid_entry"]);
  assert.equal(overflow.entries[0].classification, "invalid_entry");
  assert.equal(overflow.entries[0].inventory_health, "unsafe");
  assert.throws(
    () => cleanupStaging(environment, publicationId),
    (error) => error.code === "staging_inventory_unbounded",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  assert.equal(existsSync(target), true);
  executedStagingScenarios.add("tree_byte_overflow");
});

test("staging tree inventory surfaces close failure after closing the descriptor", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_tree_close_failure_001";
  const target = createStagingDirectory(environment, publicationId);
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  const originalOpendirSync = fileSystem.opendirSync.bind(fileSystem);
  let closed = 0;
  const mockedOpendirSync = t.mock.method(fileSystem, "opendirSync", (...args) => {
    const directory = originalOpendirSync(...args);
    if (args[0] === target) {
      const originalCloseSync = directory.closeSync.bind(directory);
      directory.closeSync = () => {
        originalCloseSync();
        closed += 1;
        throw Object.assign(new Error("synthetic close failure"), { code: "EIO" });
      };
    }
    return directory;
  });
  syncBuiltinESMExports();
  try {
    const staging = deepValidate(environment).processes[0].staging;
    assert.equal(staging.health, "attention");
    assert.deepEqual(staging.issues, ["staging_invalid_entry"]);
    assert.equal(staging.entries[0].classification, "invalid_entry");
    assert.throws(
      () => cleanupStaging(environment, publicationId),
      (error) => {
        assert.equal(error.code, "staging_inventory_unreadable");
        assert.equal(
          error.message,
          "staging_inventory_unreadable: staging directory could not be closed (EIO)",
        );
        return true;
      },
    );
  } finally {
    mockedOpendirSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(closed, 2);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  assert.equal(existsSync(target), true);
  executedStagingScenarios.add("tree_close_error");
});

test("staging tree inventory preserves a read failure ahead of close failure", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  const publicationId = "publication_tree_read_close_failure_001";
  const target = createStagingDirectory(environment, publicationId);
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  const originalOpendirSync = fileSystem.opendirSync.bind(fileSystem);
  let closed = 0;
  const mockedOpendirSync = t.mock.method(fileSystem, "opendirSync", (...args) => {
    const directory = originalOpendirSync(...args);
    if (args[0] === target) {
      const originalCloseSync = directory.closeSync.bind(directory);
      directory.readSync = () => {
        throw Object.assign(new Error("synthetic read failure"), { code: "EIO" });
      };
      directory.closeSync = () => {
        originalCloseSync();
        closed += 1;
        throw Object.assign(new Error("synthetic close failure"), { code: "EACCES" });
      };
    }
    return directory;
  });
  syncBuiltinESMExports();
  try {
    const staging = deepValidate(environment).processes[0].staging;
    assert.equal(staging.health, "attention");
    assert.deepEqual(staging.issues, ["staging_invalid_entry"]);
    assert.equal(staging.entries[0].classification, "invalid_entry");
    assert.throws(
      () => cleanupStaging(environment, publicationId),
      (error) => {
        assert.equal(error.code, "staging_inventory_unreadable");
        assert.equal(
          error.message,
          "staging_inventory_unreadable: staging directory could not be listed (EIO)",
        );
        return true;
      },
    );
  } finally {
    mockedOpendirSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(closed, 2);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  assert.equal(existsSync(target), true);
  executedStagingScenarios.add("tree_read_close_error");
});

test("staging scenario inventory matches expected, declared, and executed legs", () => {
  const declaredSet = new Set(DECLARED_STAGING_SCENARIOS);
  assert.equal(declaredSet.size, DECLARED_STAGING_SCENARIOS.length);
  assert.deepEqual(
    EXPECTED_STAGING_SCENARIOS.filter((id) => !declaredSet.has(id)),
    [],
  );
  assert.deepEqual(
    DECLARED_STAGING_SCENARIOS.filter((id) => !EXPECTED_STAGING_SCENARIOS.includes(id)),
    [],
  );
  assert.deepEqual(
    [...executedStagingScenarios].sort(),
    [...declaredSet].sort(),
  );
});

test("every staging filesystem diagnostic routes through the bounded cause owner", () => {
  const source = readFileSync(
    resolve(repoRoot, "tools/lib/process-log-v3-lifecycle.mjs"),
    "utf8",
  );
  const boundedRoutes = source.match(/boundedStagingCauseCode\(error\)/g) ?? [];
  assert.equal(boundedRoutes.length, 7);
  assert.doesNotMatch(
    source,
    /(?:could not be opened|could not be listed|could not be closed|could not be inspected|could not remove)[^\n]*error\?\.code/,
  );
  assert.match(
    source,
    /readBoundedStagingDirectory\(\s*directoryPath,\s*STAGING_MAX_ENTRIES - entries\.length,/,
  );
  assert.match(source, /if \(entries\.length >= STAGING_MAX_ENTRIES\) \{/);
  assert.equal(
    source.match(/const stats = stagingLstat\(absolutePath\);/g)?.length,
    1,
  );
  assert.equal(
    source.match(/const finalRootStats = stagingLstat\(targetPath\);/g)?.length,
    1,
  );
});

test("staging ownership and active-attempt guards route through all five steps", () => {
  assert.deepEqual(fileBackedStepNames, EXPECTED_FILE_BACKED_STEP_NAMES);
  const source = readFileSync(
    resolve(repoRoot, "tools/lib/process-log-v3-lifecycle.mjs"),
    "utf8",
  );
  const ownershipOwner = source.match(
    /function publicationOwnershipIndex\(log\) \{[\s\S]*?\n\}\n\nfunction processHasActiveAttempt/,
  )?.[0] ?? "";
  const activeOwner = source.match(
    /function processHasActiveAttempt\(record\) \{[\s\S]*?\n\}/,
  )?.[0] ?? "";
  assert.match(ownershipOwner, /for \(const stepName of fileBackedStepNames\)/);
  assert.match(
    activeOwner,
    /return fileBackedStepNames\.some\(\s*\(stepName\) => record\.steps\[stepName\]\.active_attempt !== null,\s*\);/,
  );
  for (const stepName of EXPECTED_FILE_BACKED_STEP_NAMES) {
    assert.doesNotMatch(ownershipOwner, new RegExp(`\\b${stepName}\\b`));
    assert.doesNotMatch(activeOwner, new RegExp(`\\b${stepName}\\b`));
  }
});

test("non-publication reconcile is byte-idempotent when completed inputs are current", (t) => {
  const environment = createCompletedEnvironment(t);
  const before = readFileSync(environment.ledgerPath, "utf8");

  const result = reconcileFileBackedStepV3(
    environment.ledgerPath,
    {
      selector: { id: processId },
      stepName: "map_experience",
      attemptId: null,
      publicationId: null,
    },
    {
      clock: () => {
        throw new Error("clock must not be read for an unchanged reconciliation");
      },
      outputRoot: environment.outputRoot,
      workspaceRoot: environment.workspaceRoot,
    },
  );

  assert.equal(result.status, "unchanged");
  assert.deepEqual(result.invalidated_steps, []);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

test("deep validation distinguishes missing and corrupt committed artifact bytes read-only", (t) => {
  const missing = createCompletedEnvironment(t);
  unlinkSync(join(missing.selectedOutputPath, "vacancy.json"));
  const missingBefore = readFileSync(missing.ledgerPath, "utf8");

  const missingReport = deepValidate(missing);

  assert.equal(deepStep(missingReport, "get_vacancy").artifact_health, "missing");
  assert.ok(deepStep(missingReport, "get_vacancy").issues.includes("artifact_missing"));
  assert.equal(
    deepStep(missingReport, "research_company").input_health,
    "unavailable",
  );
  assert.equal(readFileSync(missing.ledgerPath, "utf8"), missingBefore);

  const corrupt = createCompletedEnvironment(t);
  appendFileSync(
    join(corrupt.selectedOutputPath, "job-description.txt"),
    "\ncorrupt bytes\n",
    "utf8",
  );
  const corruptBefore = readFileSync(corrupt.ledgerPath, "utf8");

  const corruptReport = deepValidate(corrupt);

  assert.equal(deepStep(corruptReport, "get_vacancy").artifact_health, "corrupt");
  assert.ok(deepStep(corruptReport, "get_vacancy").issues.includes("artifact_corrupt"));
  assert.equal(readFileSync(corrupt.ledgerPath, "utf8"), corruptBefore);
});

test("deep validation surfaces a committed vacancy language outside the legal set", (t) => {
  const environment = createCompletedEnvironment(t);
  const vacancyPath = join(environment.selectedOutputPath, "vacancy.json");
  const vacancy = JSON.parse(readFileSync(vacancyPath, "utf8"));
  vacancy.role.vacancyLanguage = "en";
  const bytes = Buffer.from(`${JSON.stringify(vacancy, null, 2)}\n`, "utf8");
  writeFileSync(vacancyPath, bytes);

  // Re-pin the digest everywhere the ledger records it — the committed entry, and every consumer's
  // published_inputs and input_snapshot. A record genuinely published with "en" is self-consistent,
  // so leaving a stale digest behind would make the report attention for the wrong reason and the
  // case would stop discriminating.
  const log = readLogV3(environment.ledgerPath);
  const repin = (node) => {
    if (Array.isArray(node)) {
      node.forEach(repin);
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (node.kind === "vacancy" && typeof node.sha256 === "string") {
      node.sha256 = sha256Hex(bytes);
      node.bytes = bytes.byteLength;
      return;
    }
    Object.values(node).forEach(repin);
  };
  repin(log);
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  readLogV3(environment.ledgerPath);
  const before = readFileSync(environment.ledgerPath, "utf8");

  const report = deepValidate(environment);

  // The discriminating pair: without the Step 1 enum both of these read "current" and [].
  assert.equal(deepStep(report, "get_vacancy").artifact_health, "corrupt");
  assert.ok(deepStep(report, "get_vacancy").issues.includes("artifact_corrupt"));

  assert.equal(report.health, "attention");
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

test("deep validation reports ledger-to-vacancy identity drift without mutating bytes", (t) => {
  const environment = createCompletedEnvironment(t);
  const log = readLogV3(environment.ledgerPath);
  const process = log.processes.find((record) => record.id === processId);
  process.company_observed = "Drifted Ledger Company";
  process.role = "Drifted Ledger Role";
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  readLogV3(environment.ledgerPath);
  const before = readFileSync(environment.ledgerPath, "utf8");

  const report = deepValidate(environment);
  const processReport = report.processes.find(
    (entry) => entry.process_id === processId,
  );

  assert.equal(report.health, "attention");
  assert.equal(processReport.health, "attention");
  assert.equal(deepStep(report, "get_vacancy").artifact_health, "corrupt");
  assert.ok(
    deepStep(report, "get_vacancy").issues.includes("artifact_corrupt"),
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

test("protected-input drift is reported and reconcile stales both completed generation siblings", (t) => {
  const environment = createCompletedEnvironment(t);
  addCompletedGenerationSteps(environment);
  const currentReport = deepValidate(environment);
  assert.equal(deepStep(currentReport, "generate_cv").artifact_health, "current");
  assert.equal(deepStep(currentReport, "generate_cv").input_health, "current");
  assert.equal(
    deepStep(currentReport, "write_cover_letter").artifact_health,
    "current",
  );
  appendFileSync(
    resolve(environment.workspaceRoot, "knowledge/impact-levers.md"),
    "\nSynthetic protected drift.\n",
    "utf8",
  );
  const beforeDeep = readFileSync(environment.ledgerPath, "utf8");

  const report = deepValidate(environment);

  assert.equal(deepStep(report, "map_experience").input_health, "stale");
  assert.ok(
    deepStep(report, "map_experience").issues.includes("protected_input_drift"),
  );
  assert.equal(deepStep(report, "generate_cv").input_health, "stale");
  assert.ok(
    deepStep(report, "generate_cv").issues.includes("prerequisite_stale"),
  );
  assert.equal(deepStep(report, "write_cover_letter").input_health, "stale");
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeDeep);

  const result = reconcileHealth(environment, "map_experience");
  const process = readLogV3(environment.ledgerPath).processes.find(
    (record) => record.id === processId,
  );

  assert.equal(result.status, "stale");
  assert.deepEqual(result.invalidated_steps, [
    "generate_cv",
    "write_cover_letter",
  ]);
  assert.equal(process.steps.map_experience.state, "stale");
  assert.equal(process.steps.generate_cv.state, "stale");
  assert.equal(process.steps.write_cover_letter.state, "stale");
  assert.equal(process.steps.map_experience.finished_at, timestamps.map);
});

test("non-publication reconcile rejects upstream staling while a descendant is running", (t) => {
  const environment = createCompletedEnvironment(t);
  beginFileBackedStepV3(
    environment.ledgerPath,
    {
      selector: { id: processId },
      stepName: "generate_cv",
    },
    {
      attemptIdFactory: () => "attempt_deep_running_cv",
      clock: () => "2026-07-23T13:30:00.000Z",
      outputRoot: environment.outputRoot,
      workspaceRoot: environment.workspaceRoot,
    },
  );
  appendFileSync(
    resolve(environment.workspaceRoot, "knowledge/impact-levers.md"),
    "\nSynthetic protected drift with running descendant.\n",
    "utf8",
  );
  const before = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => reconcileHealth(environment, "map_experience"),
    (error) => error.code === "dependent_step_running",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

test("deep validation reports a prepared publication without changing its journal", (t) => {
  const environment = createCompletedEnvironment(t);
  const log = readLogV3(environment.ledgerPath);
  const process = log.processes.find((record) => record.id === processId);
  process.steps.generate_cv = createRunningPublicationStep();
  process.updated_at = process.steps.generate_cv.publication_transaction.prepared_at;
  log.updated_at = process.updated_at;
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  readLogV3(environment.ledgerPath);
  const before = readFileSync(environment.ledgerPath, "utf8");

  const report = deepValidate(environment);

  assert.equal(
    deepStep(report, "generate_cv").artifact_health,
    "recovery_required",
  );
  assert.ok(
    deepStep(report, "generate_cv").issues.includes(
      "publication_recovery_required",
    ),
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

test("reconcile safely recreates only a missing reservation-before-mkdir directory", (t) => {
  const environment = createMissingReservationEnvironment(t);
  const before = readFileSync(environment.ledgerPath, "utf8");
  const report = validateProcessLogV3Deep(
    environment.ledgerPath,
    {
      outputRoot: environment.outputRoot,
      workspaceRoot: environment.workspaceRoot,
    },
  );

  assert.deepEqual(report.processes[0].output, {
    health: "missing",
    code: "output_missing",
  });
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);

  const result = reconcileFileBackedStepV3(
    environment.ledgerPath,
    {
      selector: { id: environment.processId },
      stepName: "get_vacancy",
      attemptId: null,
      publicationId: null,
    },
    {
      clock: () => timestamps.reconcile,
      outputRoot: environment.outputRoot,
      workspaceRoot: environment.workspaceRoot,
    },
  );

  assert.equal(result.status, "output_recovered");
  assert.ok(
    existsSync(join(
      environment.outputRoot,
      environment.outputDir.slice("output/".length),
    )),
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

test("deep validation reports symlink output as invalid and reconcile never adopts it", (t) => {
  const environment = createMissingReservationEnvironment(t);
  const outside = join(environment.workspaceRoot, "outside-output");
  mkdirSync(outside);
  symlinkSync(
    outside,
    join(environment.outputRoot, environment.outputDir.slice("output/".length)),
  );
  const before = readFileSync(environment.ledgerPath, "utf8");

  const report = validateProcessLogV3Deep(
    environment.ledgerPath,
    {
      outputRoot: environment.outputRoot,
      workspaceRoot: environment.workspaceRoot,
    },
  );

  assert.deepEqual(report.processes[0].output, {
    health: "invalid",
    code: "output_path_invalid",
  });
  assert.throws(
    () => reconcileFileBackedStepV3(
      environment.ledgerPath,
      {
        selector: { id: environment.processId },
        stepName: "get_vacancy",
        attemptId: null,
        publicationId: null,
      },
      {
        outputRoot: environment.outputRoot,
        workspaceRoot: environment.workspaceRoot,
      },
    ),
    (error) => error.code === "output_path_invalid",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

test("reconcile never recreates an empty output directory over a missing committed bundle", (t) => {
  const environment = createCompletedEnvironment(t, { includeHistorical: false });
  rmSync(environment.selectedOutputPath, { recursive: true });
  const before = readFileSync(environment.ledgerPath, "utf8");

  const report = deepValidate(environment);
  assert.deepEqual(report.processes[0].output, {
    health: "missing",
    code: "output_missing",
  });
  assert.equal(deepStep(report, "get_vacancy").artifact_health, "missing");
  assert.throws(
    () => reconcileHealth(environment, "get_vacancy"),
    (error) => error.code === "publication_recovery_conflict",
  );
  assert.equal(existsSync(environment.selectedOutputPath), false);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});
