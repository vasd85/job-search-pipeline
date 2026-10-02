import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  COMPANY_RESEARCH_SCENARIOS,
  makeCompanyResearchScenario,
} from "../tools/pipeline-artifacts/fixtures/company-research-scenarios.mjs";
import {
  ANALYSIS_BLOCKS,
  RESEARCH_CATEGORIES,
  RESEARCH_SCHEMA_VERSION,
  RESEARCH_SCHEMA_VERSIONS,
  readAndValidateCompanyResearchBundle,
  validateCompanyResearch,
} from "../tools/pipeline-artifacts/validate-company-research.mjs";
import { sha256Hex } from "../tools/pipeline-artifacts/validation.mjs";
import { candidateExampleRootFor, candidateMarkets } from "../tools/candidate/load.mjs";

import { seedCandidateConfig } from "./fixtures/protected-inputs.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The example's two markets: the fixture vacancies name one of them each.
const exampleMarkets = candidateMarkets({ root: candidateExampleRootFor(repoRoot) });
const fixtureRoot = resolve(repoRoot, "tools/pipeline-artifacts/fixtures");
const researchPath = resolve(fixtureRoot, "research-v2-over-vacancy-v2/company-research.json");
const foreignVacancyPath = resolve(fixtureRoot, "vacancy-v2-completed/vacancy.json");
const foreignJobDescriptionPath = resolve(
  fixtureRoot,
  "vacancy-v2-completed/job-description.txt",
);
const russianVacancyPath = resolve(
  fixtureRoot,
  "vacancy-russian-completed/vacancy.json",
);
const russianJobDescriptionPath = resolve(
  fixtureRoot,
  "vacancy-russian-completed/job-description.txt",
);

function readInputBytes(name = "completed-pass") {
  const russian = name === "russian-na-pass";
  const vacancyBytes = readFileSync(russian ? russianVacancyPath : foreignVacancyPath);
  return {
    vacancyBytes,
    jobDescriptionBytes: readFileSync(
      russian ? russianJobDescriptionPath : foreignJobDescriptionPath,
    ),
    // The language set configures the fixture's own language beside the default one: these cases
    // are about the market, and a vacancy the set refused would fail them for another reason.
    languages: ["English", JSON.parse(vacancyBytes.toString("utf8")).role.vacancyLanguage],
    markets: exampleMarkets,
  };
}

function validateScenario(name, options = {}) {
  return validateCompanyResearch(
    makeCompanyResearchScenario(name),
    {
      ...readInputBytes(name),
      ...options,
    },
  );
}

function coverageRow(research, category) {
  return research.sourceCoverage.find((row) => row.category === category);
}

test("company research fixture catalog exposes every deterministic scenario", () => {
  assert.deepEqual(COMPANY_RESEARCH_SCENARIOS, [
    "completed-pass",
    "coverage-blocked-pass",
    "verify-blocked",
    "russian-na-pass",
    "invalid",
  ]);
});

test("completed research outside the home market validates exact Step 1 inputs", () => {
  assert.deepEqual(validateScenario("completed-pass", {
    outcome: "completed",
    expectedProcess: {
      id: "proc_fixture_step1_completed",
      sourceRef: "https://example.test/jobs/senior-quality-engineer",
      outputDir: "output/example-labs-senior-quality-engineer",
    },
  }), []);

  const result = readAndValidateCompanyResearchBundle(
    researchPath,
    foreignVacancyPath,
    foreignJobDescriptionPath,
    { markets: exampleMarkets, outcome: "completed" },
  );
  assert.equal(result.research.verifyGate.status, "pass");
  assert.equal(result.research.sourceCoverage.length, 12);
});

test("coverage-blocked is an evidence result and does not force lifecycle blocking", () => {
  const research = makeCompanyResearchScenario("coverage-blocked-pass");
  assert.equal(coverageRow(research, "reviews_default_language").status, "blocked");
  assert.equal(research.verifyGate.status, "pass");
  assert.deepEqual(validateCompanyResearch(research, {
    ...readInputBytes(),
    outcome: "completed",
  }), []);
});

test("Verify Gate blocked is valid capture but cannot complete Step 2", () => {
  assert.deepEqual(validateScenario("verify-blocked", { outcome: "blocked" }), []);
  assert.match(
    validateScenario("verify-blocked", { outcome: "completed" }).join("\n"),
    /completed company research requires verifyGate\.status pass/,
  );
  assert.match(
    validateScenario("completed-pass", { outcome: "blocked" }).join("\n"),
    /blocked company research requires verifyGate\.status blocked/,
  );
});

test("the home market accepts only contractor/payment n/a with a rationale", () => {
  assert.deepEqual(validateScenario("russian-na-pass", { outcome: "completed" }), []);

  const foreign = makeCompanyResearchScenario("completed-pass");
  const logistics = coverageRow(foreign, "contractor_payment_logistics");
  Object.assign(logistics, {
    status: "n/a",
    sourceIds: [],
    openedPrimaryUrls: [],
    queries: [],
    nameVariants: [],
    fallbackAttempted: null,
    confidence: "not-applicable",
    details: "Synthetic invalid n/a outside the home market.",
  });
  foreign.sources = foreign.sources.filter((source) => source.id !== "S11");
  foreign.analysis.contractorPaymentFacts.claims = [];
  const foreignErrors = validateCompanyResearch(foreign, {
    ...readInputBytes(),
  }).join("\n");
  assert.match(
    foreignErrors,
    /status n\/a is allowed only for contractor_payment_logistics on the home market/,
  );
  assert.match(
    foreignErrors,
    /contractor_payment_logistics must be researched for a market outside home/,
  );

  const wrongCategory = makeCompanyResearchScenario("completed-pass");
  Object.assign(coverageRow(wrongCategory, "compensation"), {
    status: "n/a",
    sourceIds: [],
    openedPrimaryUrls: [],
    queries: [],
    nameVariants: [],
    fallbackAttempted: null,
    confidence: "not-applicable",
    details: "Synthetic invalid category n/a.",
  });
  assert.match(
    validateCompanyResearch(wrongCategory, readInputBytes()).join("\n"),
    /status n\/a is allowed only for contractor_payment_logistics on the home market/,
  );
});

test("the logistics follow the side of the layer's market", async (t) => {
  const markets = exampleMarkets;
  const vacancyDirectory = resolve(fixtureRoot, "vacancy-v2-completed");
  const jobDescriptionBytes = readFileSync(resolve(vacancyDirectory, "job-description.txt"));
  const research = () => JSON.parse(
    readFileSync(resolve(fixtureRoot, "research-v2-over-vacancy-v2/company-research.json"), "utf8"),
  );
  // The vacancy with its market set to `value`, and the research re-referenced to its bytes.
  const over = (value, mutateResearch = () => {}) => {
    const vacancy = JSON.parse(readFileSync(resolve(vacancyDirectory, "vacancy.json"), "utf8"));
    vacancy.role.market.value = value;
    const vacancyBytes = Buffer.from(`${JSON.stringify(vacancy, null, 2)}\n`, "utf8");
    const value_ = research();
    value_.inputs.vacancy.sha256 = sha256Hex(vacancyBytes);
    value_.inputs.vacancy.bytes = vacancyBytes.byteLength;
    mutateResearch(value_);
    return validateCompanyResearch(value_, {
      vacancyBytes,
      jobDescriptionBytes,
      markets,
      outcome: "completed",
    }).join("\n");
  };
  const withoutLogistics = (value) => {
    Object.assign(coverageRow(value, "contractor_payment_logistics"), {
      status: "n/a",
      sourceIds: [],
      openedPrimaryUrls: [],
      queries: [],
      nameVariants: [],
      fallbackAttempted: null,
      confidence: "not-applicable",
      details: "Synthetic n/a.",
    });
    value.sources = value.sources.filter((source) => source.id !== "S11");
    value.analysis.contractorPaymentFacts.claims = [];
  };

  await t.test("outside home the logistics are researched, and n/a is refused", () => {
    assert.equal(over(markets.outsideHome.name), "");
    const errors = over(markets.outsideHome.name, withoutLogistics);
    assert.match(errors, /contractor_payment_logistics must be researched for a market outside home/);
    assert.match(errors, /status n\/a is allowed only for contractor_payment_logistics on the home market/);
  });

  await t.test("on the home market the logistics must be n/a", () => {
    assert.match(over(markets.home.name), /contractor_payment_logistics must be n\/a for the home market/);
    assert.equal(over(markets.home.name, withoutLogistics), "");
  });

  await t.test("the reference names the current version of the vacancy", () => {
    for (const version of [1, 3]) {
      assert.match(
        over(markets.outsideHome.name, (value) => { value.inputs.vacancy.schemaVersion = version; }),
        /inputs\.vacancy\.schemaVersion must be one of: 2$/m,
      );
    }
  });
});

test("source coverage has exactly the 12 canonical categories", () => {
  const research = makeCompanyResearchScenario("completed-pass");
  assert.deepEqual(
    research.sourceCoverage.map((row) => row.category),
    RESEARCH_CATEGORIES,
  );

  research.sourceCoverage.pop();
  let errors = validateCompanyResearch(research, readInputBytes()).join("\n");
  assert.match(errors, /sourceCoverage is missing category: contractor_payment_logistics/);
  assert.match(errors, /sourceCoverage must contain exactly 12 rows/);

  const duplicate = makeCompanyResearchScenario("completed-pass");
  duplicate.sourceCoverage[11].category = "stated_values";
  errors = validateCompanyResearch(duplicate, readInputBytes()).join("\n");
  assert.match(errors, /duplicate sourceCoverage category: stated_values/);
  assert.match(errors, /sourceCoverage is missing category: contractor_payment_logistics/);
});

test("the current schema freezes the 12 category names and the quote keys", () => {
  assert.deepEqual(RESEARCH_CATEGORIES, [
    "stated_values",
    "products_technical_complexity",
    "engineering_content",
    "other_vacancies",
    "source_code_organizations",
    "engineering_leadership",
    "employee_profiles",
    "reviews_default_language",
    "reviews_additional_languages",
    "compensation",
    "recent_news_ai_direction",
    "contractor_payment_logistics",
  ]);
  assert.equal(RESEARCH_SCHEMA_VERSION, 2);
  assert.deepEqual(RESEARCH_SCHEMA_VERSIONS, [2]);

  const research = makeCompanyResearchScenario("completed-pass");
  assert.equal(research.schemaVersion, 2);
  delete research.sources[0].quotes[0].translation;
  assert.match(
    validateCompanyResearch(research, readInputBytes()).join("\n"),
    /sources\[0\]\.quotes\[0\]\.translation must be a string/,
  );

  const extraKey = makeCompanyResearchScenario("completed-pass");
  extraKey.sources[0].quotes[0].paraphrase = "An extra field beside the translation.";
  assert.match(
    validateCompanyResearch(extraKey, readInputBytes()).join("\n"),
    /sources\[0\]\.quotes\[0\] contains unknown key: paraphrase/,
  );
});

test("an older or unknown schema version and a version other than the recorded one are refused", () => {
  for (const version of [1, 3]) {
    const other = makeCompanyResearchScenario("completed-pass");
    other.schemaVersion = version;
    assert.match(
      validateCompanyResearch(other, readInputBytes()).join("\n"),
      /^schemaVersion must be one of: 2$/m,
    );
  }
  assert.match(
    validateCompanyResearch(makeCompanyResearchScenario("completed-pass"), {
      ...readInputBytes(),
      expectedSchemaVersion: 1,
    }).join("\n"),
    /^schemaVersion must equal 1$/m,
  );
});

test("not-found and blocked coverage preserve exact discovery diagnostics", () => {
  const notFound = makeCompanyResearchScenario("completed-pass");
  coverageRow(notFound, "engineering_content").queries = [];
  assert.match(
    validateCompanyResearch(notFound, readInputBytes()).join("\n"),
    /queries must document exact searches when not-found/,
  );

  const blocked = makeCompanyResearchScenario("coverage-blocked-pass");
  coverageRow(blocked, "reviews_default_language").fallbackAttempted = null;
  assert.match(
    validateCompanyResearch(blocked, readInputBytes()).join("\n"),
    /fallbackAttempted is required when blocked/,
  );

  const unknownVariant = makeCompanyResearchScenario("completed-pass");
  coverageRow(unknownVariant, "compensation").nameVariants.push("Missing Legal Name");
  assert.match(
    validateCompanyResearch(unknownVariant, readInputBytes()).join("\n"),
    /nameVariants reference is missing from companyNameVariants: Missing Legal Name/,
  );
});

test("checked categories resolve to opened primary source records", async (t) => {
  const scenarios = [
    {
      name: "search result source type",
      mutate: (research) => { research.sources[0].sourceType = "search_result"; },
      expected: /sources\[0\]\.sourceType must be one of/,
    },
    {
      name: "missing source record",
      mutate: (research) => {
        research.sources = research.sources.filter((source) => source.id !== "S02");
      },
      expected: /sourceCoverage\.products_technical_complexity\.sourceIds reference does not exist: S02/,
    },
    {
      name: "source absent from its primary category",
      mutate: (research) => { research.sources[1].category = "stated_values"; },
      expected: /sources\[1\]\.id is not listed by its sourceCoverage row: S02/,
    },
    {
      name: "unlisted source URL",
      mutate: (research) => { research.sources[1].url = "https://example.test/product-v2"; },
      expected: /url is not listed by its sourceCoverage row/,
    },
    {
      name: "missing values quote",
      mutate: (research) => { research.sources[0].quotes = []; },
      expected: /checked stated_values coverage requires an original quote and its translation/,
    },
    {
      name: "one vacancy board",
      mutate: (research) => {
        const row = coverageRow(research, "other_vacancies");
        row.sourceIds = ["S03"];
        row.openedPrimaryUrls = ["https://example.test/careers"];
        research.sources = research.sources.filter((source) => source.id !== "S04");
      },
      expected: /checked other_vacancies coverage requires at least two primary board sources/,
    },
    {
      name: "one employee profile",
      mutate: (research) => {
        const row = coverageRow(research, "employee_profiles");
        row.sourceIds = ["S07"];
        row.openedPrimaryUrls = ["https://profiles.example.test/alex-qa"];
        research.sources = research.sources.filter((source) => source.id !== "S08");
        for (const block of Object.values(research.analysis)) {
          for (const claim of block.claims) {
            claim.sourceIds = claim.sourceIds.filter((sourceId) => sourceId !== "S08");
          }
        }
      },
      expected: /checked employee_profiles coverage requires two to four current profiles/,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, () => {
      const research = makeCompanyResearchScenario("completed-pass");
      scenario.mutate(research);
      assert.match(
        validateCompanyResearch(research, readInputBytes()).join("\n"),
        scenario.expected,
      );
    });
  }
});

test("claims preserve honest evidence states and checked-source provenance", async (t) => {
  const scenarios = [
    {
      name: "verified without source",
      mutate: (claim) => { claim.sourceIds = []; },
      expected: /sourceIds must contain at least one checked primary source when verified/,
    },
    {
      name: "dangling source",
      mutate: (claim) => { claim.sourceIds = ["S99"]; },
      expected: /sourceIds reference does not exist: S99/,
    },
    {
      name: "inference without basis",
      mutate: (claim) => {
        claim.evidenceStatus = "inferred";
        claim.inferenceBasis = null;
      },
      expected: /inferenceBasis is required when inferred/,
    },
    {
      name: "verified with inference basis",
      mutate: (claim) => { claim.inferenceBasis = "Synthetic forbidden basis."; },
      expected: /inferenceBasis must be null unless inferred/,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, () => {
      const research = makeCompanyResearchScenario("completed-pass");
      scenario.mutate(research.analysis.companyOverview.claims[0]);
      assert.match(
        validateCompanyResearch(research, readInputBytes()).join("\n"),
        scenario.expected,
      );
    });
  }
});

test("all named Analysis blocks are strict and AI classification stays factual", () => {
  const research = makeCompanyResearchScenario("completed-pass");
  assert.deepEqual(Object.keys(research.analysis), ANALYSIS_BLOCKS);

  delete research.analysis.riskSignals;
  let errors = validateCompanyResearch(research, readInputBytes()).join("\n");
  assert.match(errors, /analysis\.riskSignals must be an object/);

  const aiDecision = makeCompanyResearchScenario("completed-pass");
  aiDecision.analysis.aiLiteracyEvidence.aiRegister = "deep";
  errors = validateCompanyResearch(aiDecision, readInputBytes()).join("\n");
  assert.match(errors, /aiLiteracyEvidence contains unknown key: aiRegister/);

  const unsupportedAi = makeCompanyResearchScenario("completed-pass");
  unsupportedAi.analysis.aiLiteracyEvidence.claims[0].evidenceStatus = "unverified";
  errors = validateCompanyResearch(unsupportedAi, readInputBytes()).join("\n");
  assert.match(errors, /classification AI-adjacent requires a verified claim/);
});

test("tailoring hooks resolve both claim and primary-source ids", () => {
  const missingClaim = makeCompanyResearchScenario("completed-pass");
  missingClaim.tailoringHooks[0].claimIds = ["C99"];
  assert.match(
    validateCompanyResearch(missingClaim, readInputBytes()).join("\n"),
    /claimIds reference does not exist: C99/,
  );

  const missingSource = makeCompanyResearchScenario("completed-pass");
  missingSource.tailoringHooks[0].sourceIds = ["S99"];
  assert.match(
    validateCompanyResearch(missingSource, readInputBytes()).join("\n"),
    /sourceIds reference does not exist: S99/,
  );

  const tooFew = makeCompanyResearchScenario("completed-pass");
  tooFew.tailoringHooks = tooFew.tailoringHooks.slice(0, 2);
  assert.match(
    validateCompanyResearch(tooFew, readInputBytes()).join("\n"),
    /tailoringHooks must contain three to five factual hooks when verifyGate passes/,
  );
});

test("open questions are ordered by decision weight", () => {
  const research = makeCompanyResearchScenario("completed-pass");
  research.openQuestions.reverse();
  assert.match(
    validateCompanyResearch(research, readInputBytes()).join("\n"),
    /openQuestions must be ordered by decision weight: high, medium, low/,
  );
});

test("Verify Gate contains exactly four consistent machine-owned invariants", () => {
  const missing = makeCompanyResearchScenario("completed-pass");
  missing.verifyGate.checkedInvariants.pop();
  let errors = validateCompanyResearch(missing, readInputBytes()).join("\n");
  assert.match(errors, /checkedInvariants is missing invariant: responsibility_boundary/);
  assert.match(errors, /checkedInvariants must contain exactly 4 rows/);

  const inconsistent = makeCompanyResearchScenario("completed-pass");
  inconsistent.verifyGate.checkedInvariants[0].status = "blocked";
  errors = validateCompanyResearch(inconsistent, readInputBytes()).join("\n");
  assert.match(errors, /verifyGate\.status pass requires every invariant to pass/);

  const unboundGap = makeCompanyResearchScenario("verify-blocked");
  unboundGap.verifyGate.unrecoverableGaps[0].invariantId = "source_coverage";
  errors = validateCompanyResearch(unboundGap, readInputBytes()).join("\n");
  assert.match(errors, /invariantId must reference a blocked checked invariant/);
});

test("input references detect byte drift and cross-process reuse", () => {
  const wrongDigest = makeCompanyResearchScenario("completed-pass");
  wrongDigest.inputs.vacancy.sha256 = "f".repeat(64);
  let errors = validateCompanyResearch(wrongDigest, readInputBytes()).join("\n");
  assert.match(errors, /inputs\.vacancy\.sha256 does not match/);

  const wrongJobSize = makeCompanyResearchScenario("completed-pass");
  wrongJobSize.inputs.jobDescription.bytes += 1;
  errors = validateCompanyResearch(wrongJobSize, readInputBytes()).join("\n");
  assert.match(errors, /inputs\.jobDescription\.bytes does not match/);

  const wrongProcess = makeCompanyResearchScenario("completed-pass");
  wrongProcess.process.id = "proc_other";
  errors = validateCompanyResearch(wrongProcess, readInputBytes()).join("\n");
  assert.match(errors, /inputs\.vacancy content: process\.id does not match/);

  errors = validateCompanyResearch(
    makeCompanyResearchScenario("completed-pass"),
    readInputBytes("russian-na-pass"),
  ).join("\n");
  assert.match(errors, /inputs\.vacancy\.sha256 does not match/);
  assert.match(errors, /inputs\.vacancy content: process\.id does not match/);

  errors = validateCompanyResearch(
    makeCompanyResearchScenario("completed-pass"),
  ).join("\n");
  assert.match(errors, /vacancy\.json bytes are required for bundle validation/);
  assert.match(errors, /job-description\.txt bytes are required for bundle validation/);

  const nullVacancy = makeCompanyResearchScenario("completed-pass");
  const nullVacancyBytes = Buffer.from("null\n", "utf8");
  nullVacancy.inputs.vacancy.sha256 = sha256Hex(nullVacancyBytes);
  nullVacancy.inputs.vacancy.bytes = nullVacancyBytes.byteLength;
  errors = validateCompanyResearch(nullVacancy, {
    vacancyBytes: nullVacancyBytes,
    jobDescriptionBytes: readInputBytes().jobDescriptionBytes,
  }).join("\n");
  assert.match(errors, /inputs\.vacancy content: vacancy must be an object/);
});

test("strict schemas reject copied vacancy data and unknown nested containers", () => {
  const copiedVacancy = makeCompanyResearchScenario("completed-pass");
  copiedVacancy.role = { company: "Example Labs" };
  let errors = validateCompanyResearch(copiedVacancy, readInputBytes()).join("\n");
  assert.match(errors, /companyResearch contains unknown key: role/);

  const unknownSourceField = makeCompanyResearchScenario("completed-pass");
  unknownSourceField.sources[0].rawPage = "forbidden";
  errors = validateCompanyResearch(unknownSourceField, readInputBytes()).join("\n");
  assert.match(errors, /sources\[0\] contains unknown key: rawPage/);
});

test("invalid deterministic scenario exposes structural and reference failures", () => {
  const errors = validateScenario("invalid").join("\n");
  assert.match(errors, /companyResearch contains unknown key: unexpected/);
  assert.match(errors, /sourceCoverage is missing category: compensation/);
  assert.match(errors, /queries must document exact searches when not-found/);
  assert.match(errors, /duplicate source id: S01/);
  assert.match(errors, /sourceIds reference does not exist: S99/);
});

test("the research self-check reads the markets of the workspace's layer", (t) => {
  const validatorPath = resolve(repoRoot, "tools/pipeline-artifacts/validate-company-research.mjs");
  const run = (workspaceRoot) => spawnSync(process.execPath, [
    validatorPath,
    resolve(fixtureRoot, "research-v2-over-vacancy-v2/company-research.json"),
    resolve(fixtureRoot, "vacancy-v2-completed/vacancy.json"),
    resolve(fixtureRoot, "vacancy-v2-completed/job-description.txt"),
    "--outcome",
    "completed",
  ], { encoding: "utf8", env: { ...process.env, JOB_PIPELINE_WORKSPACE_ROOT: workspaceRoot } });
  const withLayer = mkdtempSync(join(tmpdir(), "job-search-research-cli-"));
  const withoutLayer = mkdtempSync(join(tmpdir(), "job-search-research-cli-bare-"));
  t.after(() => {
    rmSync(withLayer, { force: true, recursive: true });
    rmSync(withoutLayer, { force: true, recursive: true });
  });
  seedCandidateConfig(repoRoot, withLayer);
  const valid = run(withLayer);
  assert.equal(valid.status, 0, valid.stderr);
  const refused = run(withoutLayer);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /the candidate layer configures no market/);
});

test("company research CLI validates the complete artifact bundle", (t) => {
  const validatorPath = resolve(
    repoRoot,
    "tools/pipeline-artifacts/validate-company-research.mjs",
  );
  // The vacancy names one of the example's markets, which the CLI reads from the workspace's layer.
  const workspaceRoot = mkdtempSync(join(tmpdir(), "job-search-research-cli-"));
  t.after(() => rmSync(workspaceRoot, { force: true, recursive: true }));
  seedCandidateConfig(repoRoot, workspaceRoot);
  const result = spawnSync(process.execPath, [
    validatorPath,
    researchPath,
    foreignVacancyPath,
    foreignJobDescriptionPath,
    "--outcome",
    "completed",
  ], { encoding: "utf8", env: { ...process.env, JOB_PIPELINE_WORKSPACE_ROOT: workspaceRoot } });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "valid");
  assert.equal(summary.verifyGate, "pass");
  assert.deepEqual(summary.coverage, {
    checked: 9,
    "not-found": 3,
    blocked: 0,
    "n/a": 0,
  });
});
