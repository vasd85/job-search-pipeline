import assert from "node:assert/strict";
import {
  appendFileSync,
  copyFileSync,
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
  createPendingFileBackedStep,
  failFileBackedStepV3,
  fileBackedProtectedInputs,
  preflightFileBackedStepV3,
  ProcessLogLifecycleError,
  publishFileBackedStepV3,
  reconcileFileBackedStepV3,
  reopenFileBackedStepV3,
  retryFileBackedStepV3,
  startFileBackedProcessV3,
  updateFileBackedProcessV3,
  validateProcessLogV3Deep,
} from "../tools/lib/process-log-v3-lifecycle.mjs";
import { sha256Hex } from "../tools/pipeline-artifacts/validation.mjs";
import { createDisposableWorkspace } from "./fixtures/disposable-workspace.mjs";
import {
  createDocxBytes,
  createDocumentXml,
  MAIN_DOCUMENT_PART,
} from "./fixtures/minimal-docx.mjs";
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
  failedCv: "2026-07-23T11:35:00.000Z",
  begin: "2026-07-23T13:00:00.000Z",
  fail: "2026-07-23T13:10:00.000Z",
  retry: "2026-07-23T13:20:00.000Z",
  reopen: "2026-07-23T13:30:00.000Z",
  publish: "2026-07-23T13:40:00.000Z",
  reconcile: "2026-07-23T13:50:00.000Z",
});

const EXPECTED_FIRST_CV_RECOVERY_CASES = Object.freeze([
  "after_bundle_validation=>completed",
  "after_candidate:cv_docx=>completed",
  "after_candidate:cv_source=>rolled_back",
  "after_cleanup=>unchanged",
  "after_journal_write=>rolled_back",
  "after_ledger_commit=>cleaned",
  "before_bundle_validation=>completed",
  "before_ledger_commit=>completed",
]);
const DECLARED_FIRST_CV_RECOVERY_CASES = Object.freeze([
  ["after_journal_write", "rolled_back"],
  ["after_candidate:cv_source", "rolled_back"],
  ["after_candidate:cv_docx", "completed"],
  ["before_bundle_validation", "completed"],
  ["after_bundle_validation", "completed"],
  ["before_ledger_commit", "completed"],
  ["after_ledger_commit", "cleaned"],
  ["after_cleanup", "unchanged"],
]);
const EXPECTED_REVISION_CV_RECOVERY_CASES = Object.freeze([
  "after_backup:cv_docx=>rolled_back",
  "after_backup:cv_source=>rolled_back",
  "after_candidate:cv_docx=>completed",
  "after_candidate:cv_source=>rolled_back",
]);
const DECLARED_REVISION_CV_RECOVERY_CASES = Object.freeze([
  ["after_backup:cv_source", "rolled_back"],
  ["after_backup:cv_docx", "rolled_back"],
  ["after_candidate:cv_source", "rolled_back"],
  ["after_candidate:cv_docx", "completed"],
]);
const executedFirstCvRecoveryCases = new Set();
const executedRevisionCvRecoveryCases = new Set();

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

const currentResearchSource = artifactSources["company-research.json"];

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

function completedStep({ artifacts, finishedAt, inputs, startedAt }) {
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
        publication_id: `publication_fixture_${startedAt.replaceAll(/[^0-9A-Za-z]/g, "_")}`,
      },
    ],
    error: null,
    blocker: null,
  };
}

function failedCvStep(inputSnapshot) {
  return {
    state: "failed",
    attempt: 1,
    revision: 0,
    started_at: "2026-07-23T11:30:00.000Z",
    updated_at: timestamps.failedCv,
    finished_at: timestamps.failedCv,
    published_inputs: [],
    artifacts: [],
    active_attempt: null,
    publication_transaction: null,
    attempt_history: [
      {
        attempt: 1,
        outcome: "failed",
        started_at: "2026-07-23T11:30:00.000Z",
        finished_at: timestamps.failedCv,
        input_snapshot: structuredClone(inputSnapshot),
        error_code: "render_failed",
        publication_id: null,
      },
    ],
    error: {
      code: "render_failed",
      message: "The test document could not be rendered.",
      at: timestamps.failedCv,
      retryable: true,
      details: ["synthetic renderer failure"],
    },
    blocker: null,
  };
}

function copyFixtureFile(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function createEnvironment(t, {
  completedThrough = "get_vacancy",
  failedCv = false,
} = {}) {
  const disposable = createDisposableWorkspace(t, {
    prefix: "job-search-v3-preflight-",
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
  const step1Inputs = [];
  const step1Artifacts = [jobDescription, vacancy];
  const step2Inputs = step1Artifacts;
  const step2Artifacts = [research];
  const step3Inputs = [
    ...step1Artifacts,
    ...step2Artifacts,
    ...protectedByStep.map_experience,
  ];
  const step3Artifacts = [brief];
  const steps = {
    get_vacancy: completedStep({
      artifacts: step1Artifacts,
      finishedAt: timestamps.vacancy,
      inputs: step1Inputs,
      startedAt: timestamps.process,
    }),
    research_company: createPendingFileBackedStep(),
    map_experience: createPendingFileBackedStep(),
    generate_cv: createPendingFileBackedStep(),
    write_cover_letter: createPendingFileBackedStep(),
  };
  if (["research_company", "map_experience"].includes(completedThrough)) {
    steps.research_company = completedStep({
      artifacts: step2Artifacts,
      finishedAt: timestamps.research,
      inputs: step2Inputs,
      startedAt: "2026-07-23T10:20:00.000Z",
    });
  }
  if (completedThrough === "map_experience") {
    steps.map_experience = completedStep({
      artifacts: step3Artifacts,
      finishedAt: timestamps.map,
      inputs: step3Inputs,
      startedAt: "2026-07-23T11:00:00.000Z",
    });
  }
  if (failedCv) {
    steps.generate_cv = failedCvStep([
      ...step3Artifacts,
      ...protectedByStep.generate_cv,
    ]);
  }

  const fixtureUpdatedAt = failedCv
    ? timestamps.failedCv
    : completedThrough === "map_experience"
      ? timestamps.map
      : completedThrough === "research_company"
        ? timestamps.research
        : timestamps.vacancy;

  const log = {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: fixtureUpdatedAt,
    companies: [],
    processes: [
      {
        id: processId,
        started_at: timestamps.process,
        updated_at: fixtureUpdatedAt,
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
      },
    ],
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

function preflight(environment, stepName, selector = { id: processId }) {
  return preflightFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName },
    {
      outputRoot: environment.outputRoot,
      workspaceRoot: environment.workspaceRoot,
    },
  );
}

function causalFixtureTimestamp(environment, preferredTimestamp) {
  const updatedAt = readLogV3(environment.ledgerPath).updated_at;
  if (Date.parse(preferredTimestamp) >= Date.parse(updatedAt)) return preferredTimestamp;
  return new Date(Date.parse(updatedAt) + 1).toISOString();
}

function begin(environment, stepName, options = {}) {
  const timestamp = options.timestamp
    ?? causalFixtureTimestamp(environment, timestamps.begin);
  return beginFileBackedStepV3(
    environment.ledgerPath,
    {
      selector: options.selector ?? { id: processId },
      stepName,
    },
    {
      attemptIdFactory: () => options.attemptId ?? `attempt_${stepName}_001`,
      clock: () => timestamp,
      outputRoot: environment.outputRoot,
      workspaceRoot: environment.workspaceRoot,
    },
  );
}

function fail(environment, stepName, attemptId, options = {}) {
  const timestamp = options.timestamp
    ?? causalFixtureTimestamp(environment, timestamps.fail);
  return failFileBackedStepV3(
    environment.ledgerPath,
    {
      selector: options.selector ?? { id: processId },
      stepName,
      attemptId,
      error: options.error ?? {
        code: "synthetic_failure",
        message: "A synthetic step failure for the lifecycle checks.",
        retryable: true,
        details: ["deterministic fixture failure"],
      },
    },
    {
      clock: () => timestamp,
    },
  );
}

function retry(environment, stepName, options = {}) {
  const timestamp = options.timestamp
    ?? causalFixtureTimestamp(environment, timestamps.retry);
  return retryFileBackedStepV3(
    environment.ledgerPath,
    {
      selector: options.selector ?? { id: processId },
      stepName,
    },
    {
      attemptIdFactory: () => options.attemptId ?? `attempt_${stepName}_retry_002`,
      clock: () => timestamp,
      outputRoot: environment.outputRoot,
      workspaceRoot: environment.workspaceRoot,
    },
  );
}

function reopen(environment, stepName, options = {}) {
  const timestamp = options.timestamp
    ?? causalFixtureTimestamp(environment, timestamps.reopen);
  return reopenFileBackedStepV3(
    environment.ledgerPath,
    {
      selector: options.selector ?? { id: processId },
      stepName,
    },
    {
      attemptIdFactory: () => options.attemptId ?? `attempt_${stepName}_reopen_002`,
      clock: () => timestamp,
      outputRoot: environment.outputRoot,
      workspaceRoot: environment.workspaceRoot,
    },
  );
}

function makeValidCv(fileName = "Candidate_CV_Synthetic_Role.docx") {
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

function stageResearchPublication(environment, publicationId, source) {
  const stagingDirectory = join(
    environment.selectedOutputPath,
    ".pipeline-tmp",
    publicationId,
  );
  mkdirSync(stagingDirectory, { recursive: true });
  copyFixtureFile(source, join(stagingDirectory, "company-research.json"));
}

// The publisher inspects the DOCX package, so staged bytes must be a real package rendered from
// this exact cv. The marker keeps successive revisions byte-distinct, which the mixed-pair and
// backup oracles below depend on.
function stageCvPublication(environment, publicationId, {
  marker = "initial",
  docxBytes = null,
} = {}) {
  const stagingDirectory = join(
    environment.selectedOutputPath,
    ".pipeline-tmp",
    publicationId,
  );
  mkdirSync(stagingDirectory, { recursive: true });
  const cv = makeValidCv();
  cv.sections[0].text += ` ${marker}.`;
  const cvBytes = Buffer.from(`${JSON.stringify(cv, null, 2)}\n`, "utf8");
  const stagedDocxBytes = docxBytes ?? createDocxBytes({ cv, marker });
  writeFileSync(join(stagingDirectory, "cv.json"), cvBytes);
  writeFileSync(join(stagingDirectory, cv.fileName), stagedDocxBytes);
  return {
    cv,
    cvBytes,
    docxBytes: stagedDocxBytes,
    stagingDirectory,
  };
}

function createMalformedCvDocxBytes(cv) {
  const malformed = createDocumentXml(cv).replace(
    "<w:body>",
    "<w:body><w:p><w:r><w:t>&undefined;</w:t></w:r></w:p>",
  );
  return createDocxBytes({
    cv,
    replace: { [MAIN_DOCUMENT_PART]: malformed },
  });
}

function stageBlockedVacancyPublication(environment, publicationId) {
  const stagingDirectory = join(
    environment.selectedOutputPath,
    ".pipeline-tmp",
    publicationId,
  );
  mkdirSync(stagingDirectory, { recursive: true });
  copyFileSync(
    join(environment.selectedOutputPath, "job-description.txt"),
    join(stagingDirectory, "job-description.txt"),
  );
  const vacancy = JSON.parse(
    readFileSync(join(environment.selectedOutputPath, "vacancy.json"), "utf8"),
  );
  vacancy.role.market = { value: null, evidence: null };
  vacancy.ambiguities = [
    {
      code: "market_ambiguous",
      question: "Which employment market governs this vacancy?",
      blocking: true,
    },
  ];
  writeFileSync(
    join(stagingDirectory, "vacancy.json"),
    `${JSON.stringify(vacancy, null, 2)}\n`,
    "utf8",
  );
  return stagingDirectory;
}

function publish(environment, stepName, attemptId, publicationId, options = {}) {
  const timestamp = options.timestamp
    ?? causalFixtureTimestamp(environment, timestamps.publish);
  return publishFileBackedStepV3(
    environment.ledgerPath,
    {
      selector: options.selector ?? { id: processId },
      stepName,
      attemptId,
      publicationId,
      outcome: options.outcome ?? "completed",
      blocker: options.blocker ?? null,
    },
    {
      clock: options.clock ?? (() => timestamp),
      failAt: options.failAt ?? null,
      outputRoot: environment.outputRoot,
      workspaceRoot: environment.workspaceRoot,
    },
  );
}

function reconcile(environment, stepName, attemptId, publicationId, options = {}) {
  const timestamp = options.timestamp
    ?? causalFixtureTimestamp(environment, timestamps.reconcile);
  return reconcileFileBackedStepV3(
    environment.ledgerPath,
    {
      selector: options.selector ?? { id: processId },
      stepName,
      attemptId,
      publicationId,
    },
    {
      clock: () => timestamp,
      failAt: options.failAt ?? null,
      outputRoot: environment.outputRoot,
      workspaceRoot: environment.workspaceRoot,
    },
  );
}

function completeGenerationSteps(environment, {
  completeCv = true,
  completeLetter = true,
} = {}) {
  const cvSourcePath = join(environment.selectedOutputPath, "cv.json");
  const cvDocxPath = join(
    environment.selectedOutputPath,
    "Candidate_Test.docx",
  );
  const coverLetterPath = join(environment.selectedOutputPath, "cover-letter.txt");
  writeFileSync(cvSourcePath, "{\"fixture\":\"cv\"}\n", "utf8");
  writeFileSync(cvDocxPath, "synthetic docx bytes", "utf8");
  writeFileSync(
    coverLetterPath,
    "Senior Quality Engineer\n\nSynthetic cover letter.\n",
    "utf8",
  );

  const log = readLogV3(environment.ledgerPath);
  const process = log.processes[0];
  const briefArtifacts = process.steps.map_experience.artifacts;
  if (completeCv) {
    process.steps.generate_cv = completedStep({
      artifacts: [
        artifactMetadata("cv_source", "cv.json", null, cvSourcePath),
        artifactMetadata(
          "cv_docx",
          "Candidate_Test.docx",
          null,
          cvDocxPath,
        ),
      ],
      finishedAt: "2026-07-23T11:50:00.000Z",
      inputs: [
        ...briefArtifacts,
        ...environment.protectedByStep.generate_cv,
      ],
      startedAt: "2026-07-23T11:30:00.000Z",
    });
  }
  if (completeLetter) {
    process.steps.write_cover_letter = completedStep({
      artifacts: [
        artifactMetadata(
          "cover_letter",
          "cover-letter.txt",
          null,
          coverLetterPath,
        ),
      ],
      finishedAt: "2026-07-23T12:00:00.000Z",
      inputs: [
        ...briefArtifacts,
        ...environment.protectedByStep.write_cover_letter,
      ],
      startedAt: "2026-07-23T11:40:00.000Z",
    });
  }
  const latestFinishedAt = [
    process.steps.generate_cv.finished_at,
    process.steps.write_cover_letter.finished_at,
  ].filter(Boolean).sort().at(-1);
  if (latestFinishedAt) {
    process.updated_at = latestFinishedAt;
    log.updated_at = latestFinishedAt;
  }
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  readLogV3(environment.ledgerPath);
}

function createUnreservedStep1Environment(t) {
  const disposable = createDisposableWorkspace(t, {
    ledger: {
      schema_version: 4,
      duplicate_policy: "prompt",
      updated_at: timestamps.process,
      companies: [],
      processes: [],
    },
    prefix: "job-search-v3-retry-step1-",
  });
  const { ledgerPath, outputRoot, workspaceRoot } = disposable;
  const started = startFileBackedProcessV3(
    ledgerPath,
    {
      runner: "codex",
      sourceRef: "https://example.test/jobs/unreserved-step-1",
    },
    {
      attemptIdFactory: () => "attempt_get_vacancy_initial",
      clock: () => timestamps.process,
      processIdFactory: () => "proc_unreserved_step_1",
    },
  );
  return {
    ...disposable,
    ledgerPath,
    outputRoot,
    processId: started.process.id,
    workspaceRoot,
  };
}

test("preflight validates Step 1 bytes and returns an exact read-only Step 2 snapshot", (t) => {
  const environment = createEnvironment(t);
  const before = readFileSync(environment.ledgerPath, "utf8");

  const result = preflight(environment, "research_company");

  assert.equal(result.step_name, "research_company");
  assert.deepEqual(result.prerequisites, ["get_vacancy"]);
  assert.deepEqual(
    result.input_snapshot.map((entry) => entry.kind),
    ["job_description", "vacancy"],
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
  assert.ok(result.input_snapshot.every((entry) => !entry.path.startsWith("/")));
});

test("begin-step snapshots all Step 3 artifacts and protected canon before pending -> running", (t) => {
  const environment = createEnvironment(t, { completedThrough: "research_company" });

  const result = begin(environment, "map_experience");
  const log = readLogV3(environment.ledgerPath);
  const step = log.processes[0].steps.map_experience;

  assert.equal(result.status, "started");
  assert.equal(result.attempt_id, "attempt_map_experience_001");
  assert.equal(step.state, "running");
  assert.equal(step.attempt, 1);
  assert.equal(step.started_at, timestamps.begin);
  assert.equal(step.updated_at, timestamps.begin);
  assert.equal(step.finished_at, null);
  assert.deepEqual(step.active_attempt.expected_artifacts, []);
  assert.equal(step.active_attempt.expected_revision, 0);
  assert.deepEqual(step.active_attempt.input_snapshot, result.input_snapshot);
  assert.deepEqual(
    result.input_snapshot.map((entry) => entry.kind),
    [
      "candidate_levers",
      "candidate_profile",
      "candidate_rules",
      "company_research",
      "generation_rules",
      "impact_levers",
      "job_description",
      "precedence",
      "vacancy",
    ],
  );
  assert.equal(log.processes[0].updated_at, timestamps.begin);
  assert.equal(log.updated_at, timestamps.begin);
});

test("missing and byte-modified committed artifacts fail closed without ledger mutation", (t) => {
  const missing = createEnvironment(t);
  unlinkSync(join(missing.selectedOutputPath, "job-description.txt"));
  const missingBefore = readFileSync(missing.ledgerPath, "utf8");
  assert.throws(
    () => preflight(missing, "research_company"),
    (error) => error.code === "artifact_missing",
  );
  assert.equal(readFileSync(missing.ledgerPath, "utf8"), missingBefore);

  const corrupt = createEnvironment(t);
  appendFileSync(join(corrupt.selectedOutputPath, "job-description.txt"), "drift\n", "utf8");
  const corruptBefore = readFileSync(corrupt.ledgerPath, "utf8");
  assert.throws(
    () => preflight(corrupt, "research_company"),
    (error) => error.code === "artifact_corrupt",
  );
  assert.equal(readFileSync(corrupt.ledgerPath, "utf8"), corruptBefore);
});

test("missing protected canon and stale prerequisite snapshots are distinguished", (t) => {
  const missingInput = createEnvironment(t, { completedThrough: "research_company" });
  unlinkSync(resolve(missingInput.workspaceRoot, "knowledge/impact-levers.md"));
  assert.throws(
    () => preflight(missingInput, "map_experience"),
    (error) => error.code === "input_missing",
  );

  const stale = createEnvironment(t, { completedThrough: "research_company" });
  const staleLog = readLogV3(stale.ledgerPath);
  staleLog.processes[0].steps.research_company.published_inputs[0].sha256 = "f".repeat(64);
  writeFileSync(stale.ledgerPath, `${JSON.stringify(staleLog, null, 2)}\n`, "utf8");
  const staleBefore = readFileSync(stale.ledgerPath, "utf8");
  assert.throws(
    () => preflight(stale, "map_experience"),
    (error) => error.code === "prerequisite_stale",
  );
  assert.equal(readFileSync(stale.ledgerPath, "utf8"), staleBefore);
});

test("preflight rejects an ambiguous stable selector before reading another process output", (t) => {
  const environment = createEnvironment(t);
  const log = readLogV3(environment.ledgerPath);
  const duplicate = structuredClone(log.processes[0]);
  duplicate.id = "proc_fixture_duplicate";
  duplicate.output_dir = "output/example-labs-senior-quality-engineer-2";
  duplicate.duplicate_of = processId;
  for (const step of Object.values(duplicate.steps)) {
    for (const history of step.attempt_history) {
      if (history.publication_id !== null) {
        history.publication_id = `${history.publication_id}_duplicate`;
      }
    }
  }
  log.processes.push(duplicate);
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  const before = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => preflight(
      environment,
      "research_company",
      { sourceRef },
    ),
    (error) => error.code === "process_ambiguous",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

test("begin-step rejects missing prerequisites and non-pending transitions byte-stably", (t) => {
  const notReady = createEnvironment(t);
  const notReadyBefore = readFileSync(notReady.ledgerPath, "utf8");
  assert.throws(
    () => begin(notReady, "map_experience"),
    (error) => error.code === "prerequisite_not_ready",
  );
  assert.equal(readFileSync(notReady.ledgerPath, "utf8"), notReadyBefore);

  const completed = createEnvironment(t, { completedThrough: "research_company" });
  const completedBefore = readFileSync(completed.ledgerPath, "utf8");
  assert.throws(
    () => begin(completed, "research_company"),
    (error) => error.code === "invalid_step_transition",
  );
  assert.equal(readFileSync(completed.ledgerPath, "utf8"), completedBefore);
});

test("Step 5 can begin from current Step 3 while failed Step 4 remains untouched", (t) => {
  const environment = createEnvironment(t, {
    completedThrough: "map_experience",
    failedCv: true,
  });
  const failedCvBefore = structuredClone(
    readLogV3(environment.ledgerPath).processes[0].steps.generate_cv,
  );

  const result = begin(environment, "write_cover_letter");
  const process = readLogV3(environment.ledgerPath).processes[0];

  assert.equal(result.status, "started");
  assert.equal(process.steps.write_cover_letter.state, "running");
  assert.deepEqual(process.steps.generate_cv, failedCvBefore);
  assert.deepEqual(
    result.input_snapshot.map((entry) => entry.kind),
    [
      "application_brief",
      "candidate_config",
      "candidate_constraints",
      "candidate_letter_samples",
      "candidate_profile",
      "candidate_rules",
      "cover_letter_playbook",
      "generation_rules",
      "precedence",
    ],
  );
});

test("protected canon drift makes a completed Step 3 stale before either sibling begins", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  appendFileSync(
    resolve(environment.workspaceRoot, "knowledge/generation-rules.md"),
    "\nSynthetic protected drift.\n",
    "utf8",
  );
  const before = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => preflight(environment, "generate_cv"),
    (error) => error.code === "prerequisite_stale",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

test("fail-step closes only the matching active attempt and preserves a compact diagnostic", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  const begun = begin(environment, "generate_cv", {
    attemptId: "attempt_generate_cv_failure_001",
  });
  const beforeWrongToken = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => fail(environment, "generate_cv", begun.attempt_id, {
      error: {
        code: "synthetic_failure",
        message: "A synthetic failure carrying a forbidden field.",
        retryable: true,
        details: [],
        stack: "must not enter the ledger",
      },
    }),
    (error) => error.code === "invalid_fail_step_input",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeWrongToken);

  // The message is the explanation; repeating the code explains nothing. Until this task that was
  // forbidden only by accident - the message had to carry a Cyrillic letter and a code cannot - so
  // the rule is now stated outright and this is what holds it.
  assert.throws(
    () => fail(environment, "generate_cv", begun.attempt_id, {
      error: { code: "synthetic_failure", message: "synthetic_failure", retryable: true, details: [] },
    }),
    (error) => error.code === "invalid_fail_step_input"
      && /error\.message must explain the diagnostic, not repeat fail-step error\.code/.test(error.message),
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeWrongToken);

  assert.throws(
    () => fail(environment, "generate_cv", "attempt_generate_cv_stale"),
    (error) => error.code === "stale_attempt",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeWrongToken);

  const result = fail(environment, "generate_cv", begun.attempt_id);
  const log = readLogV3(environment.ledgerPath);
  const step = log.processes[0].steps.generate_cv;

  assert.equal(result.status, "failed");
  assert.equal(step.state, "failed");
  assert.equal(step.active_attempt, null);
  assert.equal(step.finished_at, timestamps.fail);
  assert.deepEqual(step.attempt_history, [
    {
      attempt: 1,
      outcome: "failed",
      started_at: timestamps.begin,
      finished_at: timestamps.fail,
      input_snapshot: begun.input_snapshot,
      error_code: "synthetic_failure",
      publication_id: null,
    },
  ]);
  assert.deepEqual(step.error, {
    code: "synthetic_failure",
    message: "A synthetic step failure for the lifecycle checks.",
    at: timestamps.fail,
    retryable: true,
    details: ["deterministic fixture failure"],
  });
  assert.equal(step.blocker, null);

  const afterClose = readFileSync(environment.ledgerPath, "utf8");
  assert.throws(
    () => fail(environment, "generate_cv", begun.attempt_id),
    (error) => error.code === "stale_attempt",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), afterClose);
});

test("direct lifecycle diagnostics reject unsafe persisted content before any ledger write", (t) => {
  const failedEnvironment = createEnvironment(t, { completedThrough: "map_experience" });
  const begun = begin(failedEnvironment, "generate_cv", {
    attemptId: "attempt_direct_unsafe_failure",
  });
  const failureBefore = readFileSync(failedEnvironment.ledgerPath, "utf8");
  assert.throws(
    () => fail(failedEnvironment, "generate_cv", begun.attempt_id, {
      error: {
        code: "unsafe_failure",
        message: "The failure carries https://secret.example.test/raw-value",
        retryable: true,
        details: [],
      },
    }),
    (error) =>
      error instanceof ProcessLogLifecycleError
      && error.code === "invalid_fail_step_input"
      && !error.message.includes("secret.example.test"),
  );
  assert.equal(readFileSync(failedEnvironment.ledgerPath, "utf8"), failureBefore);

  const blockedEnvironment = createEnvironment(t, { completedThrough: "get_vacancy" });
  const reopened = reopen(blockedEnvironment, "get_vacancy", {
    attemptId: "attempt_direct_unsafe_blocker",
  });
  const publicationId = "publication_direct_unsafe_blocker";
  stageBlockedVacancyPublication(blockedEnvironment, publicationId);
  const blockerBefore = readFileSync(blockedEnvironment.ledgerPath, "utf8");
  assert.throws(
    () => publish(
      blockedEnvironment,
      "get_vacancy",
      reopened.attempt_id,
      publicationId,
      {
        outcome: "blocked",
        blocker: {
          code: "unsafe_blocker",
          message: "The blocker carries a value that is safely refused.",
          retryable: true,
          details: ["api_key=synthetic-secret-value"],
        },
      },
    ),
    (error) =>
      error instanceof ProcessLogLifecycleError
      && error.code === "invalid_publish_step_input"
      && !error.message.includes("synthetic-secret-value"),
  );
  assert.equal(readFileSync(blockedEnvironment.ledgerPath, "utf8"), blockerBefore);
});

test("mutation clocks reject backward and future instants byte-stably with one exact code", (t) => {
  const startEnvironment = createDisposableWorkspace(t, {
    ledger: {
      schema_version: 4,
      duplicate_policy: "prompt",
      updated_at: "2026-07-23T10:00:00.000Z",
      companies: [],
      processes: [],
    },
    prefix: "job-search-v3-clock-start-",
  });
  const startBefore = readFileSync(startEnvironment.ledgerPath, "utf8");
  assert.throws(
    () => startFileBackedProcessV3(
      startEnvironment.ledgerPath,
      { runner: "codex", sourceRef: "clock-fixture:backward-start" },
      { clock: () => "2026-07-23T09:59:59.999Z" },
    ),
    (error) => error.code === "invalid_mutation_timestamp",
  );
  assert.equal(readFileSync(startEnvironment.ledgerPath, "utf8"), startBefore);

  for (const [id, clockValue] of [
    ["empty", ""],
    ["non_string", 1_721_738_000_000],
    ["parseable_non_contract", "2026-07-23 13:00:00Z"],
  ]) {
    assert.throws(
      () => startFileBackedProcessV3(
        startEnvironment.ledgerPath,
        { runner: "codex", sourceRef: `clock-fixture:${id}` },
        { clock: () => clockValue },
      ),
      (error) => error.code === "invalid_mutation_timestamp",
    );
    assert.equal(readFileSync(startEnvironment.ledgerPath, "utf8"), startBefore);
  }

  let hostileClockCoercions = 0;
  const hostileClockValue = {
    toString() {
      hostileClockCoercions += 1;
      throw new Error("HOSTILE_CLOCK_COERCION_SECRET");
    },
  };
  assert.throws(
    () => startFileBackedProcessV3(
      startEnvironment.ledgerPath,
      { runner: "codex", sourceRef: "clock-fixture:hostile-non-string" },
      { clock: () => hostileClockValue },
    ),
    (error) => {
      assert.equal(error.code, "invalid_mutation_timestamp");
      assert.doesNotMatch(error.message, /HOSTILE|SECRET/);
      return true;
    },
  );
  assert.equal(hostileClockCoercions, 0);
  assert.equal(readFileSync(startEnvironment.ledgerPath, "utf8"), startBefore);

  const beginEnvironment = createEnvironment(t, { completedThrough: "get_vacancy" });
  const beginBefore = readFileSync(beginEnvironment.ledgerPath, "utf8");
  assert.throws(
    () => begin(beginEnvironment, "research_company", {
      timestamp: "2026-07-23T10:09:59.999Z",
    }),
    (error) => error.code === "invalid_mutation_timestamp",
  );
  assert.equal(readFileSync(beginEnvironment.ledgerPath, "utf8"), beginBefore);

  const failEnvironment = createEnvironment(t, { completedThrough: "get_vacancy" });
  const active = begin(failEnvironment, "research_company", {
    attemptId: "attempt_clock_failure",
    timestamp: "2026-07-23T13:00:00.000Z",
  });
  const failBefore = readFileSync(failEnvironment.ledgerPath, "utf8");
  assert.throws(
    () => fail(failEnvironment, "research_company", active.attempt_id, {
      timestamp: "2026-07-23T12:59:59.999Z",
    }),
    (error) => error.code === "invalid_mutation_timestamp",
  );
  assert.equal(readFileSync(failEnvironment.ledgerPath, "utf8"), failBefore);

  const nowMs = Date.parse("2026-07-23T15:00:00.000Z");
  t.mock.method(Date, "now", () => nowMs);
  const exactEnvironment = createDisposableWorkspace(t, {
    ledger: {
      schema_version: 4,
      duplicate_policy: "prompt",
      updated_at: "2026-07-23T15:00:00.000Z",
      companies: [],
      processes: [],
    },
    prefix: "job-search-v3-clock-exact-future-",
  });
  const exact = startFileBackedProcessV3(
    exactEnvironment.ledgerPath,
    { runner: "codex", sourceRef: "clock-fixture:exact-future-start" },
    { clock: () => "2026-07-23T15:05:00.000Z" },
  );
  assert.equal(exact.process.started_at, "2026-07-23T15:05:00.000Z");

  const futureEnvironment = createDisposableWorkspace(t, {
    ledger: {
      schema_version: 4,
      duplicate_policy: "prompt",
      updated_at: "2026-07-23T15:00:00.000Z",
      companies: [],
      processes: [],
    },
    prefix: "job-search-v3-clock-future-",
  });
  const futureBefore = readFileSync(futureEnvironment.ledgerPath, "utf8");
  assert.throws(
    () => startFileBackedProcessV3(
      futureEnvironment.ledgerPath,
      { runner: "codex", sourceRef: "clock-fixture:future-start" },
      { clock: () => "2026-07-23T15:05:00.001Z" },
    ),
    (error) => error.code === "invalid_mutation_timestamp",
  );
  assert.equal(readFileSync(futureEnvironment.ledgerPath, "utf8"), futureBefore);
});

test("retry-step refreshes exact inputs, retains history, and leaves a running sibling untouched", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  begin(environment, "write_cover_letter", {
    attemptId: "attempt_write_cover_letter_running",
  });
  const runningSibling = structuredClone(
    readLogV3(environment.ledgerPath).processes[0].steps.write_cover_letter,
  );
  const begun = begin(environment, "generate_cv", {
    attemptId: "attempt_generate_cv_initial",
  });
  fail(environment, "generate_cv", begun.attempt_id);
  appendFileSync(
    resolve(environment.workspaceRoot, "knowledge/targeted-cv-playbook.md"),
    "\nSynthetic Step 4-only policy drift.\n",
    "utf8",
  );

  const result = retry(environment, "generate_cv", {
    attemptId: "attempt_generate_cv_retry",
  });
  const process = readLogV3(environment.ledgerPath).processes[0];
  const step = process.steps.generate_cv;

  assert.equal(result.status, "retried");
  assert.equal(step.state, "running");
  assert.equal(step.attempt, 2);
  assert.equal(step.revision, 0);
  assert.equal(step.active_attempt.id, "attempt_generate_cv_retry");
  assert.equal(step.active_attempt.expected_revision, 0);
  assert.deepEqual(step.active_attempt.expected_artifacts, []);
  assert.notDeepEqual(step.active_attempt.input_snapshot, begun.input_snapshot);
  assert.deepEqual(step.active_attempt.input_snapshot, result.input_snapshot);
  assert.equal(step.attempt_history.length, 1);
  assert.equal(step.attempt_history[0].error_code, "synthetic_failure");
  assert.equal(step.error, null);
  assert.equal(step.blocker, null);
  assert.deepEqual(process.steps.write_cover_letter, runningSibling);
});

test("retry-step retains a blocked step's committed revision and artifact baseline", (t) => {
  const environment = createEnvironment(t, { completedThrough: "research_company" });
  const log = readLogV3(environment.ledgerPath);
  const step = log.processes[0].steps.research_company;
  const expectedArtifacts = structuredClone(step.artifacts);
  step.state = "blocked";
  step.attempt_history[0].outcome = "blocked";
  step.attempt_history[0].error_code = "research_decision_required";
  step.blocker = {
    code: "research_decision_required",
    message: "A synthetic fact must be settled before continuing.",
    at: timestamps.research,
    retryable: true,
    details: ["deterministic blocker"],
  };
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  readLogV3(environment.ledgerPath);

  const result = retry(environment, "research_company", {
    attemptId: "attempt_research_company_retry",
  });
  const retried = readLogV3(environment.ledgerPath)
    .processes[0].steps.research_company;

  assert.equal(result.status, "retried");
  assert.equal(retried.state, "running");
  assert.equal(retried.attempt, 2);
  assert.equal(retried.revision, 1);
  assert.deepEqual(retried.artifacts, expectedArtifacts);
  assert.equal(retried.active_attempt.expected_revision, 1);
  assert.deepEqual(retried.active_attempt.expected_artifacts, expectedArtifacts);
  assert.equal(retried.attempt_history[0].outcome, "blocked");
  assert.equal(retried.attempt_history[0].error_code, "research_decision_required");
});

test("retry-step rejects non-retryable diagnostics and stale prerequisites byte-stably", (t) => {
  const nonRetryable = createEnvironment(t, { completedThrough: "map_experience" });
  const nonRetryableAttempt = begin(nonRetryable, "generate_cv");
  fail(nonRetryable, "generate_cv", nonRetryableAttempt.attempt_id, {
    error: {
      code: "policy_violation",
      message: "A policy violation was found and there is no automatic retry.",
      retryable: false,
      details: [],
    },
  });
  const nonRetryableBefore = readFileSync(nonRetryable.ledgerPath, "utf8");
  assert.throws(
    () => retry(nonRetryable, "generate_cv"),
    (error) => error.code === "step_not_retryable",
  );
  assert.equal(readFileSync(nonRetryable.ledgerPath, "utf8"), nonRetryableBefore);

  const stale = createEnvironment(t, { completedThrough: "map_experience" });
  const staleAttempt = begin(stale, "generate_cv");
  fail(stale, "generate_cv", staleAttempt.attempt_id);
  appendFileSync(
    resolve(stale.workspaceRoot, "knowledge/generation-rules.md"),
    "\nSynthetic upstream policy drift.\n",
    "utf8",
  );
  const staleBefore = readFileSync(stale.ledgerPath, "utf8");
  assert.throws(
    () => retry(stale, "generate_cv"),
    (error) => error.code === "prerequisite_stale",
  );
  assert.equal(readFileSync(stale.ledgerPath, "utf8"), staleBefore);
});

test("Step 1 can fail and retry before output reservation", (t) => {
  const environment = createUnreservedStep1Environment(t);
  const selector = { id: environment.processId };
  failFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName: "get_vacancy",
      attemptId: "attempt_get_vacancy_initial",
      error: {
        code: "vacancy_fetch_failed",
        message: "The synthetic vacancy could not be fetched.",
        retryable: true,
        details: ["fixture fetch failure"],
      },
    },
    { clock: () => timestamps.fail },
  );
  const failedBytes = readFileSync(environment.ledgerPath, "utf8");
  assert.throws(
    () => updateFileBackedProcessV3(
      environment.ledgerPath,
      {
        processId: environment.processId,
        companyObserved: "Unauthorized Failed Identity",
      },
    ),
    (error) => error.code === "identity_update_not_authorized",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), failedBytes);

  const result = retryFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName: "get_vacancy" },
    {
      attemptIdFactory: () => "attempt_get_vacancy_retry",
      clock: () => timestamps.retry,
      outputRoot: environment.outputRoot,
      workspaceRoot: environment.workspaceRoot,
    },
  );
  const updated = updateFileBackedProcessV3(
    environment.ledgerPath,
    {
      processId: environment.processId,
      companyObserved: "Retried Identity Labs",
      role: "Retried Quality Engineer",
    },
    { clock: () => timestamps.reopen },
  );
  const process = readLogV3(environment.ledgerPath).processes[0];

  assert.equal(result.status, "retried");
  assert.deepEqual(result.input_snapshot, []);
  assert.equal(process.output_dir, null);
  assert.equal(process.steps.get_vacancy.state, "running");
  assert.equal(process.steps.get_vacancy.attempt, 2);
  assert.equal(
    process.steps.get_vacancy.active_attempt.id,
    "attempt_get_vacancy_retry",
  );
  assert.equal(updated.process.company_observed, "Retried Identity Labs");
  assert.equal(updated.process.role, "Retried Quality Engineer");
});

test("reopen-step snapshots the committed baseline and stales every completed transitive descendant", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  completeGenerationSteps(environment);
  const before = readLogV3(environment.ledgerPath).processes[0];
  const descendantFinishedAt = Object.fromEntries(
    [
      "research_company",
      "map_experience",
      "generate_cv",
      "write_cover_letter",
    ].map((stepName) => [stepName, before.steps[stepName].finished_at]),
  );

  const result = reopen(environment, "get_vacancy", {
    attemptId: "attempt_get_vacancy_reopen",
  });
  const process = readLogV3(environment.ledgerPath).processes[0];
  const step = process.steps.get_vacancy;

  assert.equal(result.status, "reopened");
  assert.equal(result.attempt_id, "attempt_get_vacancy_reopen");
  assert.deepEqual(result.input_snapshot, []);
  assert.deepEqual(result.invalidated_steps, [
    "research_company",
    "map_experience",
    "generate_cv",
    "write_cover_letter",
  ]);
  assert.equal(step.state, "running");
  assert.equal(step.attempt, 2);
  assert.equal(step.revision, 1);
  assert.equal(step.finished_at, null);
  assert.equal(step.active_attempt.expected_revision, 1);
  assert.deepEqual(step.active_attempt.expected_artifacts, before.steps.get_vacancy.artifacts);
  assert.equal(step.attempt_history.length, 1);
  for (const stepName of result.invalidated_steps) {
    assert.equal(process.steps[stepName].state, "stale");
    assert.equal(process.steps[stepName].updated_at, timestamps.reopen);
    assert.equal(
      process.steps[stepName].finished_at,
      descendantFinishedAt[stepName],
    );
    assert.equal(process.steps[stepName].attempt, 1);
    assert.equal(process.steps[stepName].attempt_history.at(-1).outcome, "completed");
  }

  const originalOutputDir = process.output_dir;
  const updated = updateFileBackedProcessV3(
    environment.ledgerPath,
    {
      processId,
      companyObserved: "Revised Example Labs",
      role: "Principal Quality Engineer",
    },
    { clock: () => "2026-07-23T13:35:00.000Z" },
  ).process;
  assert.equal(updated.company_observed, "Revised Example Labs");
  assert.equal(updated.role, "Principal Quality Engineer");
  assert.equal(updated.output_dir, originalOutputDir);
  for (const stepName of result.invalidated_steps) {
    assert.equal(updated.steps[stepName].state, "stale");
  }
});

test("reopen-step follows the Step 2/3 graph and never invalidates a generation sibling", (t) => {
  const fromResearch = createEnvironment(t, { completedThrough: "map_experience" });
  completeGenerationSteps(fromResearch);
  const researchResult = reopen(fromResearch, "research_company");
  const researchProcess = readLogV3(fromResearch.ledgerPath).processes[0];

  assert.deepEqual(researchResult.invalidated_steps, [
    "map_experience",
    "generate_cv",
    "write_cover_letter",
  ]);
  assert.equal(researchProcess.steps.get_vacancy.state, "completed");

  const fromMap = createEnvironment(t, { completedThrough: "map_experience" });
  completeGenerationSteps(fromMap);
  const mapResult = reopen(fromMap, "map_experience");
  const mapProcess = readLogV3(fromMap.ledgerPath).processes[0];

  assert.deepEqual(mapResult.invalidated_steps, [
    "generate_cv",
    "write_cover_letter",
  ]);
  assert.equal(mapProcess.steps.research_company.state, "completed");

  const sibling = createEnvironment(t, { completedThrough: "map_experience" });
  completeGenerationSteps(sibling, { completeLetter: false });
  begin(sibling, "write_cover_letter", {
    attemptId: "attempt_write_cover_letter_sibling",
  });
  const runningLetter = structuredClone(
    readLogV3(sibling.ledgerPath).processes[0].steps.write_cover_letter,
  );

  const cvResult = reopen(sibling, "generate_cv", {
    attemptId: "attempt_generate_cv_reopen",
  });
  const siblingProcess = readLogV3(sibling.ledgerPath).processes[0];

  assert.deepEqual(cvResult.invalidated_steps, []);
  assert.equal(siblingProcess.steps.generate_cv.state, "running");
  assert.deepEqual(siblingProcess.steps.write_cover_letter, runningLetter);
});

test("a first research publication records the current version and refuses an older file", (t) => {
  const environment = createEnvironment(t);
  const active = begin(environment, "research_company");
  stageResearchPublication(environment, "publication_research_first_v1", currentResearchSource);
  const stagedPath = join(
    environment.selectedOutputPath,
    ".pipeline-tmp",
    "publication_research_first_v1",
    "company-research.json",
  );
  const older = JSON.parse(readFileSync(stagedPath, "utf8"));
  older.schemaVersion = 1;
  writeFileSync(stagedPath, `${JSON.stringify(older, null, 2)}\n`, "utf8");
  assert.throws(
    () => publish(
      environment,
      "research_company",
      active.attempt_id,
      "publication_research_first_v1",
    ),
    (error) => error.code === "candidate_bundle_invalid"
      && /schemaVersion must be one of: 2/.test(error.message),
  );
});

test("a Step 3 publication refuses a brief of version 3 and records version 4", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  const reopened = reopen(environment, "map_experience", {
    attemptId: "attempt_map_experience_upgrade",
  });
  const stageBrief = (publicationId, schemaVersion) => {
    const stagingDirectory = join(environment.selectedOutputPath, ".pipeline-tmp", publicationId);
    mkdirSync(stagingDirectory, { recursive: true });
    const brief = JSON.parse(readFileSync(artifactSources["application-brief.json"], "utf8"));
    brief.schemaVersion = schemaVersion;
    writeFileSync(
      join(stagingDirectory, "application-brief.json"),
      `${JSON.stringify(brief, null, 2)}\n`,
      "utf8",
    );
  };
  stageBrief("publication_brief_v3", 3);
  assert.throws(
    () => publish(environment, "map_experience", reopened.attempt_id, "publication_brief_v3"),
    (error) => error.code === "candidate_bundle_invalid"
      && /schemaVersion 3 is unsupported/.test(error.message),
  );
  stageBrief("publication_brief_v4", 4);
  publish(environment, "map_experience", reopened.attempt_id, "publication_brief_v4");
  const process = readLogV3(environment.ledgerPath).processes[0];
  assert.equal(process.steps.map_experience.state, "completed");
  assert.deepEqual(
    process.steps.map_experience.artifacts.map((entry) => [entry.kind, entry.schema_version]),
    [["application_brief", 4]],
  );
});

test("authorized reopen can recover legacy ledger identity drift without moving output", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  const driftedLog = readLogV3(environment.ledgerPath);
  driftedLog.processes[0].company_observed = "Legacy Drifted Company";
  driftedLog.processes[0].role = "Legacy Drifted Role";
  writeFileSync(
    environment.ledgerPath,
    `${JSON.stringify(driftedLog, null, 2)}\n`,
    "utf8",
  );
  readLogV3(environment.ledgerPath);

  const reopened = reopen(environment, "get_vacancy", {
    attemptId: "attempt_get_vacancy_legacy_identity_recovery",
  });
  assert.deepEqual(reopened.invalidated_steps, [
    "research_company",
    "map_experience",
  ]);
  const restored = updateFileBackedProcessV3(
    environment.ledgerPath,
    {
      processId,
      companyObserved: "Example Labs",
      role: "Senior Quality Engineer",
    },
    { clock: () => "2026-07-23T13:35:00.000Z" },
  ).process;

  assert.equal(restored.company_observed, "Example Labs");
  assert.equal(restored.role, "Senior Quality Engineer");
  assert.equal(restored.output_dir, outputDir);
  assert.equal(restored.steps.get_vacancy.state, "running");
  assert.equal(restored.steps.research_company.state, "stale");
  assert.equal(restored.steps.map_experience.state, "stale");
});

test("reopen-step rejects an upstream revision while a transitive descendant is running", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  begin(environment, "write_cover_letter", {
    attemptId: "attempt_write_cover_letter_running_descendant",
  });
  const before = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => reopen(environment, "research_company"),
    (error) =>
      error.code === "dependent_step_running"
      && error.message.includes("write_cover_letter"),
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

test("reopen-step changes only completed descendants while preserving pending and diagnostics", (t) => {
  const pending = createEnvironment(t, { completedThrough: "research_company" });
  const pendingBefore = structuredClone(
    readLogV3(pending.ledgerPath).processes[0].steps,
  );
  const pendingResult = reopen(pending, "research_company");
  const pendingAfter = readLogV3(pending.ledgerPath).processes[0].steps;

  assert.deepEqual(pendingResult.invalidated_steps, []);
  for (const stepName of [
    "map_experience",
    "generate_cv",
    "write_cover_letter",
  ]) {
    assert.deepEqual(pendingAfter[stepName], pendingBefore[stepName]);
  }

  const diagnostics = createEnvironment(t, {
    completedThrough: "map_experience",
    failedCv: true,
  });
  const diagnosticsLog = readLogV3(diagnostics.ledgerPath);
  const diagnosticProcess = diagnosticsLog.processes[0];
  const letterInputs = [
    ...diagnosticProcess.steps.map_experience.artifacts,
    ...diagnostics.protectedByStep.write_cover_letter,
  ];
  diagnosticProcess.steps.write_cover_letter = {
    state: "blocked",
    attempt: 1,
    revision: 0,
    started_at: "2026-07-23T11:40:00.000Z",
    updated_at: "2026-07-23T11:45:00.000Z",
    finished_at: "2026-07-23T11:45:00.000Z",
    published_inputs: [],
    artifacts: [],
    active_attempt: null,
    publication_transaction: null,
    attempt_history: [
      {
        attempt: 1,
        outcome: "blocked",
        started_at: "2026-07-23T11:40:00.000Z",
        finished_at: "2026-07-23T11:45:00.000Z",
        input_snapshot: letterInputs,
        error_code: "letter_decision_required",
        publication_id: "publication_fixture_blocked_letter_001",
      },
    ],
    error: null,
    blocker: {
      code: "letter_decision_required",
      message: "The letter's synthetic salutation must be settled.",
      at: "2026-07-23T11:45:00.000Z",
      retryable: true,
      details: ["deterministic blocker"],
    },
  };
  diagnosticProcess.updated_at = "2026-07-23T11:45:00.000Z";
  diagnosticsLog.updated_at = diagnosticProcess.updated_at;
  writeFileSync(
    diagnostics.ledgerPath,
    `${JSON.stringify(diagnosticsLog, null, 2)}\n`,
    "utf8",
  );
  readLogV3(diagnostics.ledgerPath);
  const diagnosticBefore = structuredClone(
    readLogV3(diagnostics.ledgerPath).processes[0].steps,
  );

  const diagnosticResult = reopen(diagnostics, "research_company");
  const diagnosticAfter = readLogV3(diagnostics.ledgerPath).processes[0].steps;

  assert.deepEqual(diagnosticResult.invalidated_steps, ["map_experience"]);
  assert.equal(diagnosticAfter.map_experience.state, "stale");
  assert.deepEqual(diagnosticAfter.generate_cv, diagnosticBefore.generate_cv);
  assert.deepEqual(
    diagnosticAfter.write_cover_letter,
    diagnosticBefore.write_cover_letter,
  );
});

test("reopen-step accepts a stale target and refreshes its exact protected-input snapshot", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  completeGenerationSteps(environment);
  const log = readLogV3(environment.ledgerPath);
  const step = log.processes[0].steps.map_experience;
  const oldPublishedInputs = structuredClone(step.published_inputs);
  const expectedArtifacts = structuredClone(step.artifacts);
  step.state = "stale";
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  appendFileSync(
    resolve(environment.workspaceRoot, "knowledge/impact-levers.md"),
    "\nSynthetic deliberate policy revision.\n",
    "utf8",
  );

  const result = reopen(environment, "map_experience", {
    attemptId: "attempt_map_experience_from_stale",
  });
  const reopened = readLogV3(environment.ledgerPath)
    .processes[0].steps.map_experience;

  assert.equal(reopened.state, "running");
  assert.equal(reopened.attempt, 2);
  assert.equal(reopened.revision, 1);
  assert.equal(reopened.active_attempt.expected_revision, 1);
  assert.deepEqual(reopened.active_attempt.expected_artifacts, expectedArtifacts);
  assert.deepEqual(reopened.active_attempt.input_snapshot, result.input_snapshot);
  assert.notDeepEqual(reopened.active_attempt.input_snapshot, oldPublishedInputs);
  assert.deepEqual(result.invalidated_steps, [
    "generate_cv",
    "write_cover_letter",
  ]);
});

test("reopen-step rejects invalid state, corrupt baseline, and stale prerequisite byte-stably", (t) => {
  const pending = createEnvironment(t);
  const pendingBefore = readFileSync(pending.ledgerPath, "utf8");
  assert.throws(
    () => reopen(pending, "map_experience"),
    (error) => error.code === "invalid_step_transition",
  );
  assert.equal(readFileSync(pending.ledgerPath, "utf8"), pendingBefore);

  const corrupt = createEnvironment(t, { completedThrough: "research_company" });
  appendFileSync(
    join(corrupt.selectedOutputPath, "company-research.json"),
    "\n",
    "utf8",
  );
  const corruptBefore = readFileSync(corrupt.ledgerPath, "utf8");
  assert.throws(
    () => reopen(corrupt, "research_company"),
    (error) => error.code === "artifact_corrupt",
  );
  assert.equal(readFileSync(corrupt.ledgerPath, "utf8"), corruptBefore);

  const stale = createEnvironment(t, { completedThrough: "map_experience" });
  const staleLog = readLogV3(stale.ledgerPath);
  staleLog.processes[0].steps.research_company.published_inputs[0].sha256 =
    "f".repeat(64);
  writeFileSync(stale.ledgerPath, `${JSON.stringify(staleLog, null, 2)}\n`, "utf8");
  const staleBefore = readFileSync(stale.ledgerPath, "utf8");
  assert.throws(
    () => reopen(stale, "map_experience"),
    (error) => error.code === "prerequisite_stale",
  );
  assert.equal(readFileSync(stale.ledgerPath, "utf8"), staleBefore);
});

test("reopen-step rejects duplicate and stale attempt tokens without changing the ledger", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  completeGenerationSteps(environment, { completeLetter: false });
  begin(environment, "write_cover_letter", {
    attemptId: "attempt_shared_collision",
  });
  const beforeCollision = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => reopen(environment, "generate_cv", {
      attemptId: "attempt_shared_collision",
    }),
    (error) => error.code === "active_attempt_id_conflict",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeCollision);

  const result = reopen(environment, "generate_cv", {
    attemptId: "attempt_generate_cv_current",
  });
  const beforeStaleToken = readFileSync(environment.ledgerPath, "utf8");
  assert.throws(
    () => fail(
      environment,
      "generate_cv",
      "attempt_generate_cv_superseded",
    ),
    (error) => error.code === "stale_attempt",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeStaleToken);
  assert.equal(result.attempt_id, "attempt_generate_cv_current");
});

test("fail-step, retry-step, and reopen-step reject a historical selector without changing the ledger", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  const log = readLogV3(environment.ledgerPath);
  log.processes.push({
    id: "proc_historical_retry_target",
    started_at: "2026-07-20T08:00:00.000Z",
    source_ref: "historical-fixture:retry-target",
    source_key: "historical-fixture:retry-target",
    company_id: null,
    company_observed: "Historical Example",
    company_hint: null,
    role: "QA Engineer",
    runner: "claude-ai-web",
    output_dir: "output/historical-example-qa-engineer",
    status: "output_created",
    duplicate_of: null,
  });
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  const before = readFileSync(environment.ledgerPath, "utf8");
  const selector = { id: "proc_historical_retry_target" };

  assert.throws(
    () => fail(environment, "generate_cv", "attempt_missing", { selector }),
    (error) => error.code === "historical_process_read_only",
  );
  assert.throws(
    () => retry(environment, "generate_cv", { selector }),
    (error) => error.code === "historical_process_read_only",
  );
  assert.throws(
    () => reopen(environment, "generate_cv", { selector }),
    (error) => error.code === "historical_process_read_only",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

test("publish-step commits a validated first CV pair and removes transaction-owned staging", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  const attemptId = "attempt_generate_cv_publish_001";
  const publicationId = "publication_generate_cv_publish_001";
  begin(environment, "generate_cv", { attemptId });
  const staged = stageCvPublication(environment, publicationId);

  const result = publish(
    environment,
    "generate_cv",
    attemptId,
    publicationId,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.revision, 1);
  assert.deepEqual(
    readFileSync(join(environment.selectedOutputPath, "cv.json")),
    staged.cvBytes,
  );
  assert.deepEqual(
    readFileSync(join(environment.selectedOutputPath, staged.cv.fileName)),
    staged.docxBytes,
  );
  assert.equal(existsSync(staged.stagingDirectory), false);
  const step = readLogV3(environment.ledgerPath)
    .processes[0].steps.generate_cv;
  assert.equal(step.state, "completed");
  assert.equal(step.revision, 1);
  assert.equal(step.publication_transaction, null);
  assert.equal(step.attempt_history.at(-1).publication_id, publicationId);
  assert.deepEqual(
    step.artifacts.map((artifact) => artifact.kind),
    ["cv_docx", "cv_source"],
  );
});

test("publish-step rejects an invalid CV DOCX before it journals anything", async (t) => {
  const cases = [
    ["plain text", () => Buffer.from("synthetic staged DOCX initial\n", "utf8")],
    ["truncated package", (cv) => createDocxBytes({ cv }).subarray(0, 120)],
    ["corrupted part checksum", (cv) => createDocxBytes({ cv, corruptCrcFor: "word/document.xml" })],
    ["malformed required XML", (cv) => createMalformedCvDocxBytes(cv)],
    ["missing content types", (cv) => createDocxBytes({ cv, omit: ["[Content_Types].xml"] })],
    ["missing root relationships", (cv) => createDocxBytes({ cv, omit: ["_rels/.rels"] })],
    ["missing main document", (cv) => createDocxBytes({ cv, omit: ["word/document.xml"] })],
    [
      "missing document relationships",
      (cv) => createDocxBytes({ cv, omit: ["word/_rels/document.xml.rels"] }),
    ],
    [
      "unopenable main document",
      (cv) => createDocxBytes({ cv, replace: { "word/document.xml": "not a document\n" } }),
    ],
    [
      "package rendered from a different cv",
      () => createDocxBytes({ cv: { header: { name: "Someone Else" }, sections: [] } }),
    ],
  ];

  for (const [label, makeDocxBytes] of cases) {
    await t.test(label, (subtest) => {
      const environment = createEnvironment(subtest, { completedThrough: "map_experience" });
      const attemptId = "attempt_generate_cv_invalid_docx_001";
      const publicationId = "publication_generate_cv_invalid_docx_001";
      begin(environment, "generate_cv", { attemptId });
      const staged = stageCvPublication(environment, publicationId, {
        docxBytes: makeDocxBytes(makeValidCv()),
      });
      const ledgerBefore = readFileSync(environment.ledgerPath);

      assert.throws(
        () => publish(environment, "generate_cv", attemptId, publicationId),
        (error) => {
          assert.equal(error.code, "candidate_bundle_invalid");
          assert.match(error.message, /DOCX structural QA failed/);
          assert.match(error.message, new RegExp(staged.cv.fileName.replaceAll(".", "\\.")));
          return true;
        },
      );

      // Nothing was journaled, nothing was moved, and the staged candidate survives for a retry.
      assert.deepEqual(readFileSync(environment.ledgerPath), ledgerBefore);
      assert.equal(existsSync(join(environment.selectedOutputPath, "cv.json")), false);
      assert.equal(
        existsSync(join(environment.selectedOutputPath, staged.cv.fileName)),
        false,
      );
      assert.equal(existsSync(staged.stagingDirectory), true);

      const step = readLogV3(environment.ledgerPath).processes[0].steps.generate_cv;
      assert.equal(step.state, "running");
      assert.equal(step.revision, 0);
      assert.equal(step.publication_transaction, null);
      assert.equal(step.active_attempt.id, attemptId);

      // The rejected publication id was never burned: rebuilding and republishing with the same
      // attempt and publication ids succeeds.
      const repaired = stageCvPublication(environment, publicationId);
      const result = publish(environment, "generate_cv", attemptId, publicationId);
      assert.equal(result.status, "completed");
      assert.equal(result.revision, 1);
      assert.deepEqual(
        readFileSync(join(environment.selectedOutputPath, repaired.cv.fileName)),
        repaired.docxBytes,
      );
    });
  }
});

test("an invalid CV revision leaves the committed pair byte-for-byte unchanged", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  const firstAttemptId = "attempt_generate_cv_valid_revision_001";
  const firstPublicationId = "publication_generate_cv_valid_revision_001";
  begin(environment, "generate_cv", { attemptId: firstAttemptId });
  const committed = stageCvPublication(environment, firstPublicationId, { marker: "committed" });
  publish(environment, "generate_cv", firstAttemptId, firstPublicationId);

  const cvPath = join(environment.selectedOutputPath, "cv.json");
  const docxPath = join(environment.selectedOutputPath, committed.cv.fileName);
  const committedCvBytes = readFileSync(cvPath);
  const committedDocxBytes = readFileSync(docxPath);
  assert.deepEqual(committedDocxBytes, committed.docxBytes);
  const committedArtifacts = structuredClone(
    readLogV3(environment.ledgerPath).processes[0].steps.generate_cv.artifacts,
  );

  const attemptId = "attempt_generate_cv_invalid_revision_002";
  const publicationId = "publication_generate_cv_invalid_revision_002";
  reopen(environment, "generate_cv", { attemptId });
  const revision = stageCvPublication(environment, publicationId, {
    marker: "revision",
    docxBytes: createMalformedCvDocxBytes(makeValidCv()),
  });
  // The revision is a genuinely different document, so a pass would have been observable.
  assert.notDeepEqual(revision.cvBytes, committed.cvBytes);
  const ledgerBefore = readFileSync(environment.ledgerPath);

  assert.throws(
    () => publish(environment, "generate_cv", attemptId, publicationId),
    (error) => error.code === "candidate_bundle_invalid",
  );

  assert.deepEqual(readFileSync(environment.ledgerPath), ledgerBefore);
  assert.deepEqual(readFileSync(cvPath), committedCvBytes);
  assert.deepEqual(readFileSync(docxPath), committedDocxBytes);
  const step = readLogV3(environment.ledgerPath).processes[0].steps.generate_cv;
  assert.equal(step.revision, 1);
  assert.equal(step.publication_transaction, null);
  assert.equal(step.state, "running");
  assert.equal(step.active_attempt.id, attemptId);
  assert.deepEqual(step.artifacts, committedArtifacts);
  assert.equal(existsSync(revision.stagingDirectory), true);

  const repaired = stageCvPublication(environment, publicationId, { marker: "revision repaired" });
  const result = publish(environment, "generate_cv", attemptId, publicationId);
  assert.equal(result.status, "completed");
  assert.equal(result.revision, 2);
  assert.deepEqual(readFileSync(cvPath), repaired.cvBytes);
  assert.deepEqual(readFileSync(docxPath), repaired.docxBytes);
});

test("same-digest CV revalidation closes a new attempt without increasing revision", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  const firstAttemptId = "attempt_generate_cv_same_digest_001";
  const firstPublicationId = "publication_generate_cv_same_digest_001";
  begin(environment, "generate_cv", { attemptId: firstAttemptId });
  stageCvPublication(environment, firstPublicationId, { marker: "same bytes" });
  publish(
    environment,
    "generate_cv",
    firstAttemptId,
    firstPublicationId,
  );

  const secondAttemptId = "attempt_generate_cv_same_digest_002";
  const secondPublicationId = "publication_generate_cv_same_digest_002";
  reopen(environment, "generate_cv", { attemptId: secondAttemptId });
  stageCvPublication(environment, secondPublicationId, { marker: "same bytes" });
  const result = publish(
    environment,
    "generate_cv",
    secondAttemptId,
    secondPublicationId,
  );

  assert.equal(result.revision, 1);
  const step = readLogV3(environment.ledgerPath)
    .processes[0].steps.generate_cv;
  assert.equal(step.attempt, 2);
  assert.equal(step.revision, 1);
  assert.equal(step.attempt_history.length, 2);
  assert.equal(step.attempt_history.at(-1).publication_id, secondPublicationId);
});

test("blocked Step 1 capture commits its artifacts and journaled blocker atomically", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  const attemptId = "attempt_get_vacancy_blocked_002";
  const publicationId = "publication_get_vacancy_blocked_002";
  const preparedAt = "2026-07-23T13:40:00.000Z";
  const finishedAt = "2026-07-23T13:41:00.000Z";
  let clockCalls = 0;
  reopen(environment, "get_vacancy", { attemptId });
  stageBlockedVacancyPublication(environment, publicationId);

  const result = publish(
    environment,
    "get_vacancy",
    attemptId,
    publicationId,
    {
      outcome: "blocked",
      blocker: {
        code: "market_ambiguous",
        message: "The employment market for this vacancy must be chosen.",
        retryable: true,
        details: ["market value is unresolved"],
      },
      clock: () => clockCalls++ === 0 ? preparedAt : finishedAt,
    },
  );

  assert.equal(result.status, "blocked");
  const step = readLogV3(environment.ledgerPath)
    .processes[0].steps.get_vacancy;
  assert.equal(step.state, "blocked");
  assert.equal(step.revision, 2);
  assert.equal(step.blocker.code, "market_ambiguous");
  assert.equal(step.blocker.at, finishedAt);
  assert.equal(step.finished_at, finishedAt);
  assert.equal(step.attempt_history.at(-1).outcome, "blocked");
  assert.equal(step.attempt_history.at(-1).finished_at, finishedAt);
  assert.equal(step.attempt_history.at(-1).publication_id, publicationId);
  assert.equal(step.publication_transaction, null);
  assert.equal(clockCalls, 2);
});

test("publish and reconcile reject stale attempt tokens without mutating prepared state", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  const attemptId = "attempt_generate_cv_token_guard";
  const publicationId = "publication_generate_cv_token_guard";
  begin(environment, "generate_cv", { attemptId });
  stageCvPublication(environment, publicationId);
  const beforePublish = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => publish(
      environment,
      "generate_cv",
      "attempt_generate_cv_stale_worker",
      publicationId,
    ),
    (error) => error.code === "stale_attempt",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforePublish);

  assert.throws(
    () => publish(
      environment,
      "generate_cv",
      attemptId,
      publicationId,
      { failAt: "after_journal_write" },
    ),
    (error) => error.code === "simulated_publication_crash",
  );
  const beforeReconcile = readFileSync(environment.ledgerPath, "utf8");
  assert.throws(
    () => reconcile(
      environment,
      "generate_cv",
      "attempt_generate_cv_stale_worker",
      publicationId,
    ),
    (error) => error.code === "stale_attempt",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeReconcile);
});

test("a Step 1 publication refuses a vacancy of the older version", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  assert.equal(preflight(environment, "generate_cv").step_name, "generate_cv");
  const attemptId = "attempt_get_vacancy_old_version";
  const publicationId = "publication_get_vacancy_old_version";
  reopen(environment, "get_vacancy", { attemptId });
  const staging = stageBlockedVacancyPublication(environment, publicationId);
  const vacancyPath = join(staging, "vacancy.json");
  const vacancy = JSON.parse(readFileSync(vacancyPath, "utf8"));
  vacancy.schemaVersion = 1;
  writeFileSync(vacancyPath, `${JSON.stringify(vacancy, null, 2)}\n`, "utf8");
  assert.throws(
    () => publish(environment, "get_vacancy", attemptId, publicationId, {
      outcome: "blocked",
      blocker: {
        code: "market_ambiguous",
        message: "The employment market for this vacancy must be chosen.",
        retryable: true,
        details: ["market value is unresolved"],
      },
    }),
    (error) => error.code === "candidate_bundle_invalid"
      && /schemaVersion must equal 2/.test(error.message),
  );
});

test("a Step 1 recorded at version 1 is refused by the ledger, and its bytes under version 2 are corrupt", (t) => {
  const environment = createEnvironment(t);
  const attemptId = "attempt_get_vacancy_blocked_v1";
  const publicationId = "publication_get_vacancy_blocked_v1";
  reopen(environment, "get_vacancy", { attemptId });
  stageBlockedVacancyPublication(environment, publicationId);
  publish(environment, "get_vacancy", attemptId, publicationId, {
    outcome: "blocked",
    blocker: {
      code: "market_ambiguous",
      message: "The employment market for this vacancy must be chosen.",
      retryable: true,
      details: ["market value is unresolved"],
    },
  });
  // The same capture as a release before the migration recorded it: the file declares version 1 and
  // the ledger entry records version 1 with its digest. The ledger no longer accepts that version.
  const vacancyPath = join(environment.selectedOutputPath, "vacancy.json");
  const vacancy = JSON.parse(readFileSync(vacancyPath, "utf8"));
  vacancy.schemaVersion = 1;
  const bytes = Buffer.from(`${JSON.stringify(vacancy, null, 2)}\n`, "utf8");
  writeFileSync(vacancyPath, bytes);
  const log = readLogV3(environment.ledgerPath);
  const entry = log.processes[0].steps.get_vacancy.artifacts.find((artifact) => artifact.kind === "vacancy");
  Object.assign(entry, { bytes: bytes.byteLength, schema_version: 1, sha256: sha256Hex(bytes) });
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");

  assert.throws(
    () => validateProcessLogV3Deep(environment.ledgerPath, {
      outputRoot: environment.outputRoot,
      workspaceRoot: environment.workspaceRoot,
    }),
    (error) => error.code === "process_log_validation_failed"
      && /schema_version must equal 2 for vacancy/.test(error.message),
  );

  // The version is the ledger's, not the file's: the same bytes recorded under the current version
  // are a file that does not match its record.
  entry.schema_version = 2;
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  const mismatched = validateProcessLogV3Deep(environment.ledgerPath, {
    outputRoot: environment.outputRoot,
    workspaceRoot: environment.workspaceRoot,
  }).processes.find((entry_) => entry_.process_id === processId)
    .steps.find((entry_) => entry_.name === "get_vacancy");
  assert.equal(mismatched.artifact_health, "corrupt");
});

test("a prepared Step 1 publication blocks identity drift until recovery", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  const attemptId = "attempt_get_vacancy_prepared_identity";
  const publicationId = "publication_get_vacancy_prepared_identity";
  reopen(environment, "get_vacancy", { attemptId });
  stageBlockedVacancyPublication(environment, publicationId);

  assert.throws(
    () => publish(
      environment,
      "get_vacancy",
      attemptId,
      publicationId,
      {
        outcome: "blocked",
        blocker: {
          code: "market_ambiguous",
          message: "The employment market for this vacancy must be chosen.",
          retryable: true,
          details: ["market value is unresolved"],
        },
        failAt: "after_journal_write",
      },
    ),
    (error) => error.code === "simulated_publication_crash",
  );
  const beforeUpdate = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => updateFileBackedProcessV3(
      environment.ledgerPath,
      {
        processId,
        companyObserved: "Prepared Drift",
      },
    ),
    (error) => error.code === "publication_recovery_required",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeUpdate);
});

test("a crash before the prepared journal leaves the running attempt and ledger byte-stable", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  const attemptId = "attempt_generate_cv_before_journal";
  const publicationId = "publication_generate_cv_before_journal";
  begin(environment, "generate_cv", { attemptId });
  stageCvPublication(environment, publicationId);
  const before = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => publish(
      environment,
      "generate_cv",
      attemptId,
      publicationId,
      { failAt: "before_journal_write" },
    ),
    (error) => error.code === "simulated_publication_crash",
  );

  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
  assert.equal(
    readLogV3(environment.ledgerPath).processes[0].steps.generate_cv.state,
    "running",
  );
});

for (const [boundary, expectedRecovery] of DECLARED_FIRST_CV_RECOVERY_CASES) {
  test(`first CV publication reconciles ${boundary} to ${expectedRecovery}`, (t) => {
    const environment = createEnvironment(t, { completedThrough: "map_experience" });
    const suffix = boundary.replaceAll(/[^0-9A-Za-z]/g, "_");
    const attemptId = `attempt_generate_cv_${suffix}`;
    const publicationId = `publication_generate_cv_${suffix}`;
    begin(environment, "generate_cv", { attemptId });
    const staged = stageCvPublication(environment, publicationId, {
      marker: boundary,
    });

    assert.throws(
      () => publish(
        environment,
        "generate_cv",
        attemptId,
        publicationId,
        { failAt: boundary },
      ),
      (error) => error.code === "simulated_publication_crash",
    );

    const recovered = reconcile(
      environment,
      "generate_cv",
      attemptId,
      publicationId,
    );
    assert.equal(recovered.status, expectedRecovery);
    const step = readLogV3(environment.ledgerPath)
      .processes[0].steps.generate_cv;
    if (expectedRecovery === "rolled_back") {
      assert.equal(step.state, "failed");
      assert.equal(step.revision, 0);
      assert.equal(existsSync(join(environment.selectedOutputPath, "cv.json")), false);
      assert.equal(
        existsSync(join(environment.selectedOutputPath, staged.cv.fileName)),
        false,
      );
    } else {
      assert.equal(step.state, "completed");
      assert.equal(step.revision, 1);
      assert.deepEqual(
        readFileSync(join(environment.selectedOutputPath, "cv.json")),
        staged.cvBytes,
      );
      assert.deepEqual(
        readFileSync(join(environment.selectedOutputPath, staged.cv.fileName)),
        staged.docxBytes,
      );
    }
    assert.equal(existsSync(staged.stagingDirectory), false);
    executedFirstCvRecoveryCases.add(`${boundary}=>${expectedRecovery}`);
  });
}

test("first CV recovery inventory matches expected, declared, and executed cases", () => {
  const declared = DECLARED_FIRST_CV_RECOVERY_CASES
    .map(([boundary, recovery]) => `${boundary}=>${recovery}`)
    .sort();
  assert.deepEqual(declared, [...EXPECTED_FIRST_CV_RECOVERY_CASES].sort());
  assert.deepEqual(
    [...executedFirstCvRecoveryCases].sort(),
    [...EXPECTED_FIRST_CV_RECOVERY_CASES].sort(),
  );
});

test("a synchronous filesystem-boundary failure rolls back before releasing the ledger lock", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  const attemptId = "attempt_generate_cv_synchronous_failure";
  const publicationId = "publication_generate_cv_synchronous_failure";
  begin(environment, "generate_cv", { attemptId });
  const staged = stageCvPublication(environment, publicationId);

  assert.throws(
    () => publish(
      environment,
      "generate_cv",
      attemptId,
      publicationId,
      {
        failAt: {
          boundary: "after_candidate:cv_source",
          crash: false,
        },
      },
    ),
    (error) => error.code === "publication_failed",
  );

  const step = readLogV3(environment.ledgerPath)
    .processes[0].steps.generate_cv;
  assert.equal(step.state, "failed");
  assert.equal(step.revision, 0);
  assert.equal(step.publication_transaction, null);
  assert.equal(existsSync(join(environment.selectedOutputPath, "cv.json")), false);
  assert.equal(
    existsSync(join(environment.selectedOutputPath, staged.cv.fileName)),
    false,
  );
  assert.equal(existsSync(staged.stagingDirectory), false);
});

function assertFinalLedgerWriteFailure(error) {
  assert.ok(error instanceof ProcessLogLifecycleError);
  assert.equal(error.code, "publication_ledger_write_failed");
  assert.equal(
    error.message,
    "publication_ledger_write_failed: publication ledger commit failed; run tokened reconcile",
  );
  return true;
}

test("a final ledger-write failure preserves an initial publication for tokened reconcile", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  const attemptId = "attempt_generate_cv_final_write_initial";
  const publicationId = "publication_generate_cv_final_write_initial";
  begin(environment, "generate_cv", { attemptId });
  const staged = stageCvPublication(environment, publicationId, {
    marker: "final ledger write initial",
  });

  assert.throws(
    () => publish(
      environment,
      "generate_cv",
      attemptId,
      publicationId,
      {
        failAt: {
          boundary: "during_ledger_commit_write",
          crash: false,
        },
      },
    ),
    assertFinalLedgerWriteFailure,
  );

  const preparedStep = readLogV3(environment.ledgerPath)
    .processes[0].steps.generate_cv;
  assert.equal(preparedStep.state, "running");
  assert.equal(preparedStep.revision, 0);
  assert.equal(preparedStep.active_attempt.id, attemptId);
  assert.equal(preparedStep.publication_transaction.id, publicationId);
  assert.deepEqual(
    readFileSync(join(environment.selectedOutputPath, "cv.json")),
    staged.cvBytes,
  );
  assert.deepEqual(
    readFileSync(join(environment.selectedOutputPath, staged.cv.fileName)),
    staged.docxBytes,
  );
  assert.equal(existsSync(staged.stagingDirectory), true);

  const recovered = reconcile(
    environment,
    "generate_cv",
    attemptId,
    publicationId,
  );
  assert.equal(recovered.status, "completed");
  const completedStep = readLogV3(environment.ledgerPath)
    .processes[0].steps.generate_cv;
  assert.equal(completedStep.revision, 1);
  assert.equal(completedStep.attempt_history.length, 1);
  assert.equal(completedStep.publication_transaction, null);
  assert.equal(existsSync(staged.stagingDirectory), false);
});

test("a final ledger-write failure preserves a complete CV revision without a mixed pair", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  const firstAttemptId = "attempt_generate_cv_final_write_revision_initial";
  const firstPublicationId = "publication_generate_cv_final_write_revision_initial";
  begin(environment, "generate_cv", { attemptId: firstAttemptId });
  const original = stageCvPublication(environment, firstPublicationId, {
    marker: "committed before final write fault",
  });
  publish(
    environment,
    "generate_cv",
    firstAttemptId,
    firstPublicationId,
  );

  const attemptId = "attempt_generate_cv_final_write_revision";
  const publicationId = "publication_generate_cv_final_write_revision";
  reopen(environment, "generate_cv", { attemptId });
  const revised = stageCvPublication(environment, publicationId, {
    marker: "complete revision at final write fault",
  });

  assert.throws(
    () => publish(
      environment,
      "generate_cv",
      attemptId,
      publicationId,
      {
        failAt: {
          boundary: "during_ledger_commit_write",
          crash: false,
        },
      },
    ),
    assertFinalLedgerWriteFailure,
  );

  const preparedStep = readLogV3(environment.ledgerPath)
    .processes[0].steps.generate_cv;
  assert.equal(preparedStep.state, "running");
  assert.equal(preparedStep.revision, 1);
  assert.equal(preparedStep.publication_transaction.id, publicationId);
  assert.deepEqual(
    readFileSync(join(environment.selectedOutputPath, "cv.json")),
    revised.cvBytes,
  );
  assert.deepEqual(
    readFileSync(join(environment.selectedOutputPath, revised.cv.fileName)),
    revised.docxBytes,
  );
  assert.deepEqual(
    readFileSync(join(revised.stagingDirectory, ".backup-cv_source")),
    original.cvBytes,
  );
  assert.deepEqual(
    readFileSync(join(revised.stagingDirectory, ".backup-cv_docx")),
    original.docxBytes,
  );

  const recovered = reconcile(
    environment,
    "generate_cv",
    attemptId,
    publicationId,
  );
  assert.equal(recovered.status, "completed");
  const completedStep = readLogV3(environment.ledgerPath)
    .processes[0].steps.generate_cv;
  assert.equal(completedStep.revision, 2);
  assert.equal(completedStep.attempt_history.length, 2);
  assert.equal(existsSync(revised.stagingDirectory), false);
});

test("a final ledger-write failure during reconcile preserves the prepared journal for retry", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  const attemptId = "attempt_generate_cv_final_write_reconcile";
  const publicationId = "publication_generate_cv_final_write_reconcile";
  begin(environment, "generate_cv", { attemptId });
  const staged = stageCvPublication(environment, publicationId, {
    marker: "final ledger write during reconcile",
  });
  assert.throws(
    () => publish(
      environment,
      "generate_cv",
      attemptId,
      publicationId,
      { failAt: "before_ledger_commit" },
    ),
    (error) => error.code === "simulated_publication_crash",
  );
  const preparedLedger = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => reconcile(
      environment,
      "generate_cv",
      attemptId,
      publicationId,
      {
        failAt: {
          boundary: "during_ledger_commit_write",
          crash: false,
        },
      },
    ),
    assertFinalLedgerWriteFailure,
  );

  assert.equal(readFileSync(environment.ledgerPath, "utf8"), preparedLedger);
  assert.deepEqual(
    readFileSync(join(environment.selectedOutputPath, "cv.json")),
    staged.cvBytes,
  );
  assert.deepEqual(
    readFileSync(join(environment.selectedOutputPath, staged.cv.fileName)),
    staged.docxBytes,
  );
  assert.equal(existsSync(staged.stagingDirectory), true);

  const recovered = reconcile(
    environment,
    "generate_cv",
    attemptId,
    publicationId,
  );
  assert.equal(recovered.status, "completed");
  const completedStep = readLogV3(environment.ledgerPath)
    .processes[0].steps.generate_cv;
  assert.equal(completedStep.revision, 1);
  assert.equal(completedStep.attempt_history.length, 1);
  assert.equal(existsSync(staged.stagingDirectory), false);
});

for (const [boundary, expectedRecovery] of DECLARED_REVISION_CV_RECOVERY_CASES) {
  test(`CV revision reconciles ${boundary} without exposing a mixed pair`, (t) => {
    const environment = createEnvironment(t, { completedThrough: "map_experience" });
    const firstAttemptId = `attempt_generate_cv_initial_${boundary.replaceAll(/[^0-9A-Za-z]/g, "_")}`;
    const firstPublicationId = `publication_generate_cv_initial_${boundary.replaceAll(/[^0-9A-Za-z]/g, "_")}`;
    begin(environment, "generate_cv", { attemptId: firstAttemptId });
    const original = stageCvPublication(environment, firstPublicationId, {
      marker: "committed original",
    });
    publish(
      environment,
      "generate_cv",
      firstAttemptId,
      firstPublicationId,
    );

    const attemptId = `attempt_generate_cv_revision_${boundary.replaceAll(/[^0-9A-Za-z]/g, "_")}`;
    const publicationId = `publication_generate_cv_revision_${boundary.replaceAll(/[^0-9A-Za-z]/g, "_")}`;
    reopen(environment, "generate_cv", { attemptId });
    const revised = stageCvPublication(environment, publicationId, {
      marker: "candidate revision",
    });

    assert.throws(
      () => publish(
        environment,
        "generate_cv",
        attemptId,
        publicationId,
        { failAt: boundary },
      ),
      (error) => error.code === "simulated_publication_crash",
    );
    const recovered = reconcile(
      environment,
      "generate_cv",
      attemptId,
      publicationId,
    );
    assert.equal(recovered.status, expectedRecovery);

    const expected = expectedRecovery === "completed" ? revised : original;
    assert.deepEqual(
      readFileSync(join(environment.selectedOutputPath, "cv.json")),
      expected.cvBytes,
    );
    assert.deepEqual(
      readFileSync(join(environment.selectedOutputPath, expected.cv.fileName)),
      expected.docxBytes,
    );
    const step = readLogV3(environment.ledgerPath)
      .processes[0].steps.generate_cv;
    assert.equal(
      step.revision,
      expectedRecovery === "completed" ? 2 : 1,
    );
    assert.equal(step.state, expectedRecovery === "completed" ? "completed" : "failed");
    assert.equal(existsSync(revised.stagingDirectory), false);
    executedRevisionCvRecoveryCases.add(`${boundary}=>${expectedRecovery}`);
  });
}

test("revision CV recovery inventory matches expected, declared, and executed cases", () => {
  const declared = DECLARED_REVISION_CV_RECOVERY_CASES
    .map(([boundary, recovery]) => `${boundary}=>${recovery}`)
    .sort();
  assert.deepEqual(declared, [...EXPECTED_REVISION_CV_RECOVERY_CASES].sort());
  assert.deepEqual(
    [...executedRevisionCvRecoveryCases].sort(),
    [...EXPECTED_REVISION_CV_RECOVERY_CASES].sort(),
  );
});

test("reconcile rejects unprovable candidate bytes and preserves the prepared journal", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  const attemptId = "attempt_generate_cv_recovery_conflict";
  const publicationId = "publication_generate_cv_recovery_conflict";
  begin(environment, "generate_cv", { attemptId });
  const staged = stageCvPublication(environment, publicationId);
  assert.throws(
    () => publish(
      environment,
      "generate_cv",
      attemptId,
      publicationId,
      { failAt: "after_journal_write" },
    ),
    (error) => error.code === "simulated_publication_crash",
  );
  writeFileSync(join(staged.stagingDirectory, "cv.json"), "unowned bytes\n", "utf8");
  const before = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => reconcile(
      environment,
      "generate_cv",
      attemptId,
      publicationId,
    ),
    (error) => error.code === "publication_recovery_conflict",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
  assert.equal(existsSync(staged.stagingDirectory), true);
});

test("input drift after journal preparation rolls recovery back with inputs_changed", (t) => {
  const environment = createEnvironment(t, { completedThrough: "map_experience" });
  const attemptId = "attempt_generate_cv_inputs_changed";
  const publicationId = "publication_generate_cv_inputs_changed";
  begin(environment, "generate_cv", { attemptId });
  stageCvPublication(environment, publicationId);
  assert.throws(
    () => publish(
      environment,
      "generate_cv",
      attemptId,
      publicationId,
      { failAt: "after_candidate:cv_docx" },
    ),
    (error) => error.code === "simulated_publication_crash",
  );
  appendFileSync(
    resolve(environment.workspaceRoot, "knowledge/targeted-cv-playbook.md"),
    "\nsynthetic drift\n",
  );

  const recovered = reconcile(
    environment,
    "generate_cv",
    attemptId,
    publicationId,
  );
  assert.equal(recovered.status, "rolled_back");
  const step = readLogV3(environment.ledgerPath)
    .processes[0].steps.generate_cv;
  assert.equal(step.state, "failed");
  assert.equal(step.error.code, "inputs_changed");
  assert.equal(step.revision, 0);
});
