import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const completedFixture = JSON.parse(readFileSync(
  resolve(fixtureRoot, "research-v2-over-vacancy-v2/company-research.json"),
  "utf8",
));

export const COMPANY_RESEARCH_SCENARIOS = [
  "completed-pass",
  "coverage-blocked-pass",
  "verify-blocked",
  "russian-na-pass",
  "invalid",
];

export function makeCompanyResearchScenario(name) {
  const research = structuredClone(completedFixture);
  if (name === "completed-pass") return research;

  if (name === "coverage-blocked-pass") {
    const reviews = research.sourceCoverage.find((row) => row.category === "reviews_default_language");
    Object.assign(reviews, {
      status: "blocked",
      sourceIds: [],
      openedPrimaryUrls: [],
      queries: [
        "\"Example Labs\" employee reviews",
      ],
      nameVariants: [
        "Example Labs",
        "Example Labs Ltd.",
      ],
      fallbackAttempted: "Проверена raw company review page без authenticated session.",
      confidence: "none",
      details: "Review platform вернула access wall; primary reviews не были доступны.",
    });
    research.sources = research.sources.filter((source) => source.id !== "S09");
    return research;
  }

  if (name === "verify-blocked") {
    research.verifyGate.status = "blocked";
    research.verifyGate.checkedInvariants.find(
      (invariant) => invariant.id === "analysis_and_handoffs",
    ).status = "blocked";
    research.verifyGate.unrecoverableGaps = [
      {
        code: "payment_counterparty_unknown",
        invariantId: "analysis_and_handoffs",
        description: "Paying entity и допустимость contract через ИП кандидата требуют ответа recruiter.",
      },
    ];
    return research;
  }

  if (name === "russian-na-pass") {
    research.process = {
      id: "proc_fixture_step1_russian",
      sourceRef: "https://example.test/ru/jobs/senior-quality-engineer",
      outputDir: "output/example-labs-senior-quality-engineer-ru",
    };
    research.inputs = {
      vacancy: {
        path: "vacancy.json",
        schemaVersion: 2,
        sha256: "e14d34a9a4fa12b2d844075a9a3d551e0bde1188267d3fcef9e19b7bc245782b",
        bytes: 1600,
      },
      jobDescription: {
        path: "job-description.txt",
        schemaVersion: null,
        sha256: "075f795116b3383d8d227f5324485809669b3c8c3b7281fa3202886b9973f58b",
        bytes: 497,
      },
    };
    const logistics = research.sourceCoverage.find(
      (row) => row.category === "contractor_payment_logistics",
    );
    Object.assign(logistics, {
      status: "n/a",
      sourceIds: [],
      openedPrimaryUrls: [],
      queries: [],
      nameVariants: [],
      fallbackAttempted: null,
      confidence: "not-applicable",
      details: "На домашнем рынке contractor/payment logistics структурно не применимы.",
    });
    research.sources = research.sources.filter((source) => source.id !== "S11");
    research.analysis.contractorPaymentFacts = {
      summary: "На домашнем рынке contractor/payment logistics не применимы.",
      claims: [],
    };
    research.openQuestions = research.openQuestions.filter((question) => question.id !== "Q01");
    return research;
  }

  if (name === "invalid") {
    research.unexpected = true;
    research.sourceCoverage = research.sourceCoverage.filter(
      (row) => row.category !== "compensation",
    );
    research.sourceCoverage.find((row) => row.category === "engineering_content").queries = [];
    research.sources[1].id = "S01";
    research.analysis.companyOverview.claims[0].sourceIds = ["S99"];
    research.tailoringHooks[0].sourceIds = ["S99"];
    return research;
  }

  throw new Error(`Unknown company research fixture scenario: ${name}`);
}
