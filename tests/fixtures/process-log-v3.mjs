const timestamps = Object.freeze({
  ledger: "2026-07-23T12:30:00.000Z",
  historicalStart: "2026-07-20T08:00:00.000Z",
  processStart: "2026-07-23T10:00:00.000Z",
  vacancyFinish: "2026-07-23T10:10:00.000Z",
  researchStart: "2026-07-23T10:20:00.000Z",
  researchFinish: "2026-07-23T10:40:00.000Z",
  mapStart: "2026-07-23T11:00:00.000Z",
  mapFinish: "2026-07-23T11:20:00.000Z",
  cvStart: "2026-07-23T11:30:00.000Z",
  cvFinish: "2026-07-23T11:35:00.000Z",
  letterStart: "2026-07-23T12:00:00.000Z",
  letterFinish: "2026-07-23T12:20:00.000Z",
});

function bundleEntry(kind, path, schemaVersion, digestCharacter, bytes) {
  return {
    kind,
    path,
    schema_version: schemaVersion,
    sha256: digestCharacter.repeat(64),
    bytes,
  };
}

const jobDescription = bundleEntry(
  "job_description",
  "job-description.txt",
  null,
  "1",
  1_024,
);
const vacancy = bundleEntry("vacancy", "vacancy.json", 2, "2", 2_048);
const companyResearch = bundleEntry(
  "company_research",
  "company-research.json",
  2,
  "3",
  4_096,
);
const candidateProfile = bundleEntry(
  "candidate_profile",
  "candidate/profile.md",
  null,
  "a",
  8_192,
);
const applicationBrief = bundleEntry(
  "application_brief",
  "application-brief.json",
  4,
  "4",
  3_072,
);
const coverLetter = bundleEntry(
  "cover_letter",
  "cover-letter.txt",
  null,
  "5",
  1_536,
);
const cvSource = bundleEntry("cv_source", "cv.json", null, "6", 5_120);
const cvDocx = bundleEntry(
  "cv_docx",
  "Candidate_CV_Example_Labs_SDET.docx",
  null,
  "7",
  32_768,
);

function completedStep({
  artifacts,
  finishedAt,
  inputs = [],
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

function failedStep({ finishedAt, inputs, startedAt }) {
  return {
    state: "failed",
    attempt: 1,
    revision: 0,
    started_at: startedAt,
    updated_at: finishedAt,
    finished_at: finishedAt,
    published_inputs: [],
    artifacts: [],
    active_attempt: null,
    publication_transaction: null,
    attempt_history: [
      {
        attempt: 1,
        outcome: "failed",
        started_at: startedAt,
        finished_at: finishedAt,
        input_snapshot: structuredClone(inputs),
        error_code: "render_failed",
        publication_id: null,
      },
    ],
    error: {
      code: "render_failed",
      message: "Не удалось отрисовать тестовый документ.",
      at: finishedAt,
      retryable: true,
      details: ["synthetic renderer failure"],
    },
    blocker: null,
  };
}

export function createPendingStep() {
  return {
    state: "pending",
    attempt: 0,
    revision: 0,
    started_at: null,
    updated_at: null,
    finished_at: null,
    published_inputs: [],
    artifacts: [],
    active_attempt: null,
    publication_transaction: null,
    attempt_history: [],
    error: null,
    blocker: null,
  };
}

export function createRunningPublicationStep() {
  const attemptId = "attempt_generate_cv_001";
  const publicationId = "publication_generate_cv_001";
  const inputs = [applicationBrief];
  const newArtifacts = [cvSource, cvDocx];
  return {
    state: "running",
    attempt: 1,
    revision: 0,
    started_at: timestamps.cvStart,
    updated_at: timestamps.cvStart,
    finished_at: null,
    published_inputs: [],
    artifacts: [],
    active_attempt: {
      id: attemptId,
      started_at: timestamps.cvStart,
      expected_revision: 0,
      expected_artifacts: [],
      input_snapshot: structuredClone(inputs),
    },
    publication_transaction: {
      id: publicationId,
      attempt_id: attemptId,
      intended_outcome: "completed",
      prepared_at: "2026-07-23T11:32:00.000Z",
      old_revision: 0,
      old_artifacts: [],
      new_artifacts: structuredClone(newArtifacts),
      input_snapshot: structuredClone(inputs),
      blocker: null,
      files: [
        {
          kind: "cv_source",
          canonical_path: "cv.json",
          candidate_path: `.pipeline-tmp/${publicationId}/cv.json`,
          backup_path: null,
        },
        {
          kind: "cv_docx",
          canonical_path: "Candidate_CV_Example_Labs_SDET.docx",
          candidate_path:
            `.pipeline-tmp/${publicationId}/Candidate_CV_Example_Labs_SDET.docx`,
          backup_path: null,
        },
      ],
    },
    attempt_history: [],
    error: null,
    blocker: null,
  };
}

export function createValidV3Log() {
  return {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: timestamps.ledger,
    companies: [
      {
        id: "company_example_labs",
        display_name: "Example Labs",
        search_terms: ["Example Labs", "Экзампл"],
        domains: ["example.test"],
      },
    ],
    processes: [
      {
        id: "proc_historical_001",
        started_at: timestamps.historicalStart,
        source_ref: "historical-fixture:example",
        source_key: "historical-fixture:example",
        company_id: "company_example_labs",
        company_observed: "Example Labs",
        company_hint: null,
        role: "QA Engineer",
        runner: "claude-ai-web",
        output_dir: "output/example-labs-qa",
        status: "output_created",
        duplicate_of: null,
      },
      {
        id: "proc_file_backed_001",
        started_at: timestamps.processStart,
        updated_at: timestamps.ledger,
        source_ref: "https://example.test/careers/sdet",
        source_key: "https://example.test/careers/sdet",
        company_id: "company_example_labs",
        company_observed: "Example Labs",
        company_hint: "Example",
        role: "Senior SDET",
        runner: "codex",
        output_dir: "output/example-labs-senior-sdet",
        artifact_mode: "file-backed",
        steps: {
          get_vacancy: completedStep({
            artifacts: [jobDescription, vacancy],
            publicationId: "publication_vacancy_001",
            startedAt: timestamps.processStart,
            finishedAt: timestamps.vacancyFinish,
          }),
          research_company: completedStep({
            artifacts: [companyResearch],
            inputs: [jobDescription, vacancy],
            publicationId: "publication_research_001",
            startedAt: timestamps.researchStart,
            finishedAt: timestamps.researchFinish,
          }),
          map_experience: completedStep({
            artifacts: [applicationBrief],
            inputs: [vacancy, companyResearch, candidateProfile],
            publicationId: "publication_brief_001",
            startedAt: timestamps.mapStart,
            finishedAt: timestamps.mapFinish,
          }),
          generate_cv: failedStep({
            inputs: [applicationBrief],
            startedAt: timestamps.cvStart,
            finishedAt: timestamps.cvFinish,
          }),
          write_cover_letter: completedStep({
            artifacts: [coverLetter],
            inputs: [applicationBrief],
            publicationId: "publication_letter_001",
            startedAt: timestamps.letterStart,
            finishedAt: timestamps.letterFinish,
          }),
        },
        duplicate_of: null,
      },
    ],
  };
}

export function createHistoricalV2Log() {
  const log = createValidV3Log();
  log.schema_version = 2;
  log.processes = log.processes.filter((record) => Object.hasOwn(record, "status"));
  return log;
}
