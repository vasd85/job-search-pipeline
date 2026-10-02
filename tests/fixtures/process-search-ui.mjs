import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fileBackedProtectedInputs,
  validateProcessLogV3Deep,
} from "../../tools/lib/process-log-v3-lifecycle.mjs";
import { sha256Hex } from "../../tools/pipeline-artifacts/validation.mjs";
import { assertDisposableWorkspace } from "./disposable-workspace.mjs";
import { protectedInputSource, seedCandidateConfig } from "./protected-inputs.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const processId = "proc_fixture_step1_completed";
const sourceRef = "https://example.test/jobs/senior-quality-engineer";
const outputDir = "output/example-labs-senior-quality-engineer";
const outputSegment = outputDir.slice("output/".length);
const timestamps = Object.freeze({
  historical: "2026-07-20T08:00:00.000Z",
  process: "2026-07-23T10:00:00.000Z",
  vacancy: "2026-07-23T10:10:00.000Z",
  research: "2026-07-23T10:40:00.000Z",
  map: "2026-07-23T11:20:00.000Z",
  cv: "2026-07-23T11:40:00.000Z",
  letter: "2026-07-23T11:50:00.000Z",
});
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
    attempt_history: [{
      attempt: 1,
      outcome: "completed",
      started_at: startedAt,
      finished_at: finishedAt,
      input_snapshot: structuredClone(inputs),
      error_code: null,
      publication_id: publicationId,
    }],
    error: null,
    blocker: null,
  };
}

function copyFixture(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function makeValidCv(fileName) {
  return {
    fileName,
    header: {
      name: "Candidate Name",
      contact: "UTC+2 | candidate@example.com",
      positioning:
        "Remote independent contractor available across European business hours.",
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
        skills: [{
          label: "Test Automation",
          body: "TypeScript Playwright",
        }],
      },
      {
        type: "experience",
        heading: "Experience",
        roles: [{
          company: "Current Company",
          title: "Senior QA Automation Engineer",
          dates: "2020 - Present",
          bullets: ["Used LLM-based tools in a commercial QA workflow."],
        }],
      },
    ],
  };
}

export function createProcessSearchUiFixture(environment) {
  assertDisposableWorkspace(environment, { requireLedger: false });
  const { ledgerPath, outputRoot, workspaceRoot } = environment;
  const selectedOutputPath = join(outputRoot, outputSegment);
  mkdirSync(selectedOutputPath, { recursive: true });
  for (const [fileName, source] of Object.entries(artifactSources)) {
    copyFixture(source, join(selectedOutputPath, fileName));
  }

  const protectedContracts = [...new Map(
    Object.values(fileBackedProtectedInputs)
      .flat()
      .map((contract) => [contract.kind, contract]),
  ).values()];
  for (const contract of protectedContracts) {
    copyFixture(
      protectedInputSource(repoRoot, contract.path),
      resolve(workspaceRoot, contract.path),
    );
  }
  // Steps 1-3 read the language names from the layer's config, and a present layer has one.
  seedCandidateConfig(repoRoot, workspaceRoot);
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

  const cvDocxName = "Candidate_Name_UI_Fixture.docx";
  const cvPath = join(selectedOutputPath, "cv.json");
  const cvDocxPath = join(selectedOutputPath, cvDocxName);
  const letterPath = join(selectedOutputPath, "cover-letter.txt");
  writeFileSync(
    cvPath,
    `${JSON.stringify(makeValidCv(cvDocxName), null, 2)}\n`,
    "utf8",
  );
  writeFileSync(cvDocxPath, "synthetic UI fixture DOCX\n", "utf8");
  writeFileSync(
    letterPath,
    "Senior Quality Engineer\n\nSynthetic cover letter for the local UI fixture.\n",
    "utf8",
  );

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
  const cvArtifacts = [
    artifactMetadata("cv_source", "cv.json", null, cvPath),
    artifactMetadata("cv_docx", cvDocxName, null, cvDocxPath),
  ];
  const letter = artifactMetadata(
    "cover_letter",
    "cover-letter.txt",
    null,
    letterPath,
  );
  const step1Artifacts = [jobDescription, vacancy];
  const step2Artifacts = [research];
  const step3Artifacts = [brief];
  const steps = {
    get_vacancy: completedStep({
      artifacts: step1Artifacts,
      finishedAt: timestamps.vacancy,
      inputs: [],
      publicationId: "publication_ui_vacancy",
      startedAt: timestamps.process,
    }),
    research_company: completedStep({
      artifacts: step2Artifacts,
      finishedAt: timestamps.research,
      inputs: step1Artifacts,
      publicationId: "publication_ui_research",
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
      publicationId: "publication_ui_map",
      startedAt: "2026-07-23T11:00:00.000Z",
    }),
    generate_cv: completedStep({
      artifacts: cvArtifacts,
      finishedAt: timestamps.cv,
      inputs: [...step3Artifacts, ...protectedByStep.generate_cv],
      publicationId: "publication_ui_cv",
      startedAt: "2026-07-23T11:30:00.000Z",
    }),
    write_cover_letter: completedStep({
      artifacts: [letter],
      finishedAt: timestamps.letter,
      inputs: [...step3Artifacts, ...protectedByStep.write_cover_letter],
      publicationId: "publication_ui_letter",
      startedAt: "2026-07-23T11:35:00.000Z",
    }),
  };
  const log = {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: timestamps.letter,
    companies: [{
      id: "company_example",
      display_name: "Example Labs",
      search_terms: ["Example Labs", "Пример"],
      domains: ["example.test"],
    }],
    processes: [
      {
        id: "proc_historical_ui",
        started_at: timestamps.historical,
        source_ref: "historical-fixture:ui",
        source_key: "historical-fixture:ui",
        company_id: "company_example",
        company_observed: "Example Labs",
        company_hint: null,
        role: "QA Engineer",
        runner: "claude-ai-web",
        output_dir: "output/historical-ui-must-not-be-read",
        status: "output_created",
        duplicate_of: null,
      },
      {
        id: processId,
        started_at: timestamps.process,
        updated_at: timestamps.letter,
        source_ref: sourceRef,
        source_key: sourceRef,
        company_id: "company_example",
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
  const logPath = ledgerPath;
  writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  const report = validateProcessLogV3Deep(logPath, {
    outputRoot,
    workspaceRoot,
  });
  if (report.health !== "current") {
    throw new Error(`UI fixture health must be current: ${JSON.stringify(report)}`);
  }
  return {
    ...environment,
    logPath,
    outputRoot,
    processId,
    selectedOutputPath,
    workspaceRoot,
  };
}
