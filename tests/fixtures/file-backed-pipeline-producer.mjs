import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readLogV3 } from "../../tools/lib/process-log-core.mjs";
import {
  beginFileBackedStepV3,
  preflightFileBackedStepV3,
  publishFileBackedStepV3,
  resolveFileBackedProcessV3,
} from "../../tools/lib/process-log-v3-lifecycle.mjs";
import {
  assertDisposableWorkspace,
  readDisposableWorkspaceEnv,
} from "./disposable-workspace.mjs";
import { createDocxBytes } from "./minimal-docx.mjs";
import { candidateLanguages } from "../../tools/candidate/load.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// The signatures are the tracked example's, read from its layer: a fixture never quotes the
// example's name, which the publishability scan treats as a personal marker.
const exampleSignatures = Object.fromEntries(
  candidateLanguages({ root: join(repoRoot, "candidate.example") })
    .map((language) => [language.name, language.signature]),
);
const stepNames = Object.freeze([
  "get_vacancy",
  "research_company",
  "map_experience",
  "generate_cv",
  "write_cover_letter",
]);
// The versions a publication writes today: a vacancy naming one of the example's two markets, the
// research over it, and the brief over both.
const fixturePaths = Object.freeze({
  applicationBrief: resolve(
    repoRoot,
    "tools/application-brief/fixtures/application-brief.v4.valid.json",
  ),
  companyResearch: resolve(
    repoRoot,
    "tools/pipeline-artifacts/fixtures/research-v2-over-vacancy-v2/company-research.json",
  ),
  jobDescription: resolve(
    repoRoot,
    "tools/pipeline-artifacts/fixtures/vacancy-v2-completed/job-description.txt",
  ),
  vacancy: resolve(
    repoRoot,
    "tools/pipeline-artifacts/fixtures/vacancy-v2-completed/vacancy.json",
  ),
});
const attemptIds = Object.freeze({
  research_company: "attempt_fixture_research_company_001",
  map_experience: "attempt_fixture_map_experience_001",
  generate_cv: "attempt_fixture_generate_cv_001",
  write_cover_letter: "attempt_fixture_write_cover_letter_001",
});
const publicationIds = Object.freeze({
  get_vacancy: "publication_fixture_get_vacancy_001",
  research_company: "publication_fixture_research_company_001",
  map_experience: "publication_fixture_map_experience_001",
  generate_cv: "publication_fixture_generate_cv_001",
  write_cover_letter: "publication_fixture_write_cover_letter_001",
});
const stepTimestamps = Object.freeze({
  get_vacancy: Object.freeze({
    publish: "2026-07-27T08:10:00.000Z",
  }),
  research_company: Object.freeze({
    begin: "2026-07-27T08:20:00.000Z",
    publish: "2026-07-27T08:30:00.000Z",
  }),
  map_experience: Object.freeze({
    begin: "2026-07-27T08:40:00.000Z",
    publish: "2026-07-27T08:50:00.000Z",
  }),
  generate_cv: Object.freeze({
    begin: "2026-07-27T09:00:00.000Z",
    publish: "2026-07-27T09:10:00.000Z",
  }),
  write_cover_letter: Object.freeze({
    begin: "2026-07-27T09:20:00.000Z",
    publish: "2026-07-27T09:30:00.000Z",
  }),
});

function lifecycleEnvironment(environment) {
  return {
    outputRoot: environment.outputRoot,
    workspaceRoot: environment.workspaceRoot,
  };
}

function outputDirectory(environment, processRecord) {
  return resolve(
    environment.workspaceRoot,
    ...processRecord.output_dir.split("/"),
  );
}

function stagingDirectory(environment, processRecord, publicationId) {
  const directory = join(
    outputDirectory(environment, processRecord),
    ".pipeline-tmp",
    publicationId,
  );
  mkdirSync(directory, { recursive: true });
  return directory;
}

function makeValidCv() {
  return {
    fileName: "Candidate_CV_Synthetic_Role.docx",
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

export function makeCoverLetter(brief) {
  const selectedEvidence = brief.coverLetterPlan.evidenceIds.map((evidenceId) => {
    const evidence = brief.experience.priorityEvidence.find(
      (entry) => entry.id === evidenceId,
    );
    return `${evidence.claim} ${evidence.proof.join(" ")}`;
  });
  // The second language of the tracked example is Greek, so a letter in a configured language is
  // a Greek one here; its signature is the example pack's.
  const greek = brief.role.vacancyLanguage === "Greek";
  const title = greek
    ? `Αξιόπιστη μηχανική ποιότητας για την ${brief.role.company}`
    : `Reliable Quality Engineering for ${brief.role.company}`;
  const paragraphs = greek
    ? [
        "Η αξιόπιστη ανατροφοδότηση βοηθά την ομάδα να παίρνει αποφάσεις για το προϊόν συνειδητά και έγκαιρα.",
        `Η επιλεγμένη απόδειξη της εμπειρίας μου: ${selectedEvidence.join(" ")}`,
        `Στη δουλειά μου εφαρμόζω φυσικά τις απαιτήσεις του ρόλου: ${brief.coverLetterPlan.keywordTerms.join(", ")}. Αυτή η προσέγγιση συνδέει τον αυτοματισμό, τη διερεύνηση κινδύνων και τη σαφή επικοινωνία με ένα ορατό αποτέλεσμα.`,
        "Θα φέρω στην ομάδα ήρεμη μηχανική κρίση, διαφανείς ελέγχους και προσοχή στην ποιότητα της ανατροφοδότησης.",
      ]
    : [
        "Reliable feedback helps a product team make deliberate decisions while useful change is still inexpensive.",
        `My selected experience evidence is specific: ${selectedEvidence.join(" ")}`,
        `I use the role terms naturally in that work: ${brief.coverLetterPlan.keywordTerms.join(", ")}. This approach connects automation, risk exploration, and clear communication to an observable result.`,
        "I would bring calm engineering judgment, transparent checks, and sustained attention to the quality of feedback.",
      ];
  const segmenter = new Intl.Segmenter(greek ? "el" : "en", { granularity: "word" });
  const countWords = () => [...segmenter.segment(paragraphs.join("\n"))]
    .filter((segment) => segment.isWordLike).length;
  const filler = greek ? "ποιότητα" : "quality";
  let paragraphIndex = 0;
  while (countWords() < 240) {
    paragraphs[paragraphIndex] += ` ${filler}`;
    paragraphIndex = (paragraphIndex + 1) % paragraphs.length;
  }
  if (countWords() !== 240) {
    throw new Error("synthetic cover-letter fixture exceeded its 240-word target");
  }
  return [
    title,
    "",
    ...paragraphs.flatMap((paragraph, index) => (
      index === paragraphs.length - 1 ? [paragraph] : [paragraph, ""]
    )),
    "",
    exampleSignatures[greek ? "Greek" : "English"],
    "",
  ].join("\n");
}

// The upstream fixtures are written in the default language. A process in a configured language
// carries that language in its vacancy and its brief alike, which is all a language changes upstream;
// the research and the brief then reference the changed bytes by their new digests.
function reference(entry, text) {
  entry.sha256 = createHash("sha256").update(text).digest("hex");
  entry.bytes = Buffer.byteLength(text);
}

function artifactsInLanguage(language) {
  const vacancy = JSON.parse(readFileSync(fixturePaths.vacancy, "utf8"));
  vacancy.role.vacancyLanguage = language;
  const vacancyText = `${JSON.stringify(vacancy, null, 2)}\n`;
  const research = JSON.parse(readFileSync(fixturePaths.companyResearch, "utf8"));
  reference(research.inputs.vacancy, vacancyText);
  const researchText = `${JSON.stringify(research, null, 2)}\n`;
  const brief = JSON.parse(readFileSync(fixturePaths.applicationBrief, "utf8"));
  brief.role.vacancyLanguage = language;
  reference(brief.inputs.vacancy, vacancyText);
  reference(brief.inputs.companyResearch, researchText);
  return { briefText: `${JSON.stringify(brief, null, 2)}\n`, researchText, vacancyText };
}

function stageCandidate(environment, processRecord, stepName, publicationId, language) {
  const staging = stagingDirectory(
    environment,
    processRecord,
    publicationId,
  );
  if (stepName === "get_vacancy") {
    copyFileSync(
      fixturePaths.jobDescription,
      join(staging, "job-description.txt"),
    );
    if (language === null) copyFileSync(fixturePaths.vacancy, join(staging, "vacancy.json"));
    else writeFileSync(join(staging, "vacancy.json"), artifactsInLanguage(language).vacancyText, "utf8");
    return;
  }
  if (stepName === "research_company") {
    if (language === null) {
      copyFileSync(fixturePaths.companyResearch, join(staging, "company-research.json"));
    } else {
      writeFileSync(join(staging, "company-research.json"), artifactsInLanguage(language).researchText, "utf8");
    }
    return;
  }
  if (stepName === "map_experience") {
    if (language === null) {
      copyFileSync(fixturePaths.applicationBrief, join(staging, "application-brief.json"));
    } else {
      writeFileSync(join(staging, "application-brief.json"), artifactsInLanguage(language).briefText, "utf8");
    }
    return;
  }

  const brief = JSON.parse(readFileSync(
    join(outputDirectory(environment, processRecord), "application-brief.json"),
    "utf8",
  ));
  if (stepName === "generate_cv") {
    const cv = makeValidCv();
    writeFileSync(
      join(staging, "cv.json"),
      `${JSON.stringify(cv, null, 2)}\n`,
      "utf8",
    );
    // A real, deterministic OOXML package: the publisher inspects these bytes, and both the
    // cross-process and sequential runs must produce byte-identical bundles.
    writeFileSync(join(staging, cv.fileName), createDocxBytes({ cv }));
    return;
  }
  writeFileSync(
    join(staging, "cover-letter.txt"),
    makeCoverLetter(brief),
    "utf8",
  );
}

// `beforePublish` runs after the candidate is staged and before it is published: the window in which
// a test changes an input under an open attempt.
export function runFixtureStep(
  environment,
  stepName,
  selector,
  { beforePublish = null, language = null } = {},
) {
  assertDisposableWorkspace(environment);
  if (!stepNames.includes(stepName)) {
    throw new Error(`unsupported fixture step: ${stepName}`);
  }
  const lifecycle = lifecycleEnvironment(environment);
  preflightFileBackedStepV3(
    environment.ledgerPath,
    { selector, stepName },
    lifecycle,
  );
  let processRecord = resolveFileBackedProcessV3(
    readLogV3(environment.ledgerPath),
    selector,
  );
  let attemptId;
  if (stepName === "get_vacancy") {
    attemptId = processRecord.steps.get_vacancy.active_attempt.id;
  } else {
    const begun = beginFileBackedStepV3(
      environment.ledgerPath,
      { selector, stepName },
      {
        ...lifecycle,
        attemptIdFactory: () => attemptIds[stepName],
        clock: () => stepTimestamps[stepName].begin,
      },
    );
    attemptId = begun.attempt_id;
    processRecord = begun.process;
  }

  const publicationId = publicationIds[stepName];
  stageCandidate(
    environment,
    processRecord,
    stepName,
    publicationId,
    language,
  );
  beforePublish?.();
  const published = publishFileBackedStepV3(
    environment.ledgerPath,
    {
      selector,
      stepName,
      attemptId,
      publicationId,
      outcome: "completed",
      blocker: null,
    },
    {
      ...lifecycle,
      clock: () => stepTimestamps[stepName].publish,
    },
  );
  return {
    artifact_kinds: published.process.steps[stepName].artifacts.map(
      (artifact) => artifact.kind,
    ),
    process_id: published.process.id,
    status: published.status,
    step_name: stepName,
  };
}

function requiredEnvironmentVariable(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing environment variable: ${name}`);
  return value;
}

function runFromCommandLine() {
  const environment = readDisposableWorkspaceEnv();
  const stepName = requiredEnvironmentVariable("FILE_BACKED_FIXTURE_STEP");
  const selector = JSON.parse(
    requiredEnvironmentVariable("FILE_BACKED_FIXTURE_SELECTOR"),
  );
  const result = runFixtureStep(environment, stepName, selector);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runFromCommandLine();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      code: error.code ?? "fixture_producer_failed",
      message: error.message,
    })}\n`);
    process.exitCode = 1;
  }
}
