import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  candidateExampleRootFor,
  candidateLanguageNames,
  candidateMarkets,
} from "../tools/candidate/load.mjs";
import {
  readAndValidateApplicationBriefBundle as readAndValidateBundleWith,
  validateApplicationBrief as validateWith,
} from "../tools/application-brief/validate.mjs";

import { seedCandidateConfig } from "./fixtures/protected-inputs.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The brief fixture names one of the example's markets, so every check here reads the example's
// two; a case about a checkout without markets passes `markets: undefined`.
const exampleMarkets = candidateMarkets({ root: candidateExampleRootFor(repoRoot) });
const validateApplicationBrief = (brief, options = {}) =>
  validateWith(brief, { markets: exampleMarkets, ...options });
const readAndValidateApplicationBriefBundle = (...paths) => {
  const options = typeof paths.at(-1) === "object" ? paths.pop() : {};
  return readAndValidateBundleWith(...paths, { markets: exampleMarkets, ...options });
};
const fixturePath = resolve(
  repoRoot,
  "tools/application-brief/fixtures/application-brief.v4.valid.json",
);
const shapeExamplePath = resolve(repoRoot, "tools/application-brief/shape-example.json");
const concreteFixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const vacancyPath = resolve(
  repoRoot,
  "tools/pipeline-artifacts/fixtures/vacancy-v2-completed/vacancy.json",
);
const jobDescriptionPath = resolve(
  repoRoot,
  "tools/pipeline-artifacts/fixtures/vacancy-v2-completed/job-description.txt",
);
const companyResearchPath = resolve(
  repoRoot,
  "tools/pipeline-artifacts/fixtures/research-v2-over-vacancy-v2/company-research.json",
);
// The layer's documents come from the tracked example; the suite never reads a real layer.
const candidateProfilePath = resolve(repoRoot, "candidate.example/profile.md");
const candidateLeversPath = resolve(repoRoot, "candidate.example/levers.md");
const inputBytes = {
  vacancyBytes: readFileSync(vacancyPath),
  jobDescriptionBytes: readFileSync(jobDescriptionPath),
  companyResearchBytes: readFileSync(companyResearchPath),
  candidateProfileBytes: readFileSync(candidateProfilePath),
  candidateLeversBytes: readFileSync(candidateLeversPath),
  requireInputBytes: true,
};

function makeValidBrief() {
  return structuredClone(concreteFixture);
}

function addSyntheticEvidence(brief, id, cvPlacements) {
  const evidence = structuredClone(brief.experience.priorityEvidence[0]);
  evidence.id = id;
  evidence.cvPlacements = cvPlacements;
  brief.experience.priorityEvidence.push(evidence);
}

function addSyntheticCheck(brief, { id, evidenceIds, placements, placementMode }) {
  brief.cvPlan.checks.requiredEvidence.push({
    id,
    description: `Synthetic executable check ${id}.`,
    evidenceIds,
    anyOf: ["synthetic supported evidence"],
    placements,
    placementMode,
  });
}

test("complete schemaVersion 4 fixture is bundle-valid and separate from the abstract shape", () => {
  assert.equal(concreteFixture.schemaVersion, 4);
  assert.doesNotMatch(JSON.stringify(concreteFixture), /<[^>]+>/);
  assert.deepEqual(validateApplicationBrief(makeValidBrief()), []);
  const shapeExample = JSON.parse(readFileSync(shapeExamplePath, "utf8"));
  assert.match(JSON.stringify(shapeExample), /<current|<selected|<exact|<new local/);
  const shapeErrors = validateApplicationBrief(shapeExample).join("\n");
  assert.match(shapeErrors, /ats\.keywords must contain at least 15/);
  assert.match(shapeErrors, /sha256 must be a lowercase hexadecimal SHA-256 digest/);
  const bundle = readAndValidateApplicationBriefBundle(
    fixturePath,
    vacancyPath,
    jobDescriptionPath,
    companyResearchPath,
    candidateProfilePath,
    candidateLeversPath,
  );
  assert.equal(bundle.brief.schemaVersion, 4);
});

test("a brief names one of the layer's two markets and follows its side", async (t) => {
  const markets = exampleMarkets;
  const fixture = (name) => resolve(repoRoot, "tools/pipeline-artifacts/fixtures", name);
  const v4Path = resolve(
    repoRoot,
    "tools/application-brief/fixtures/application-brief.v4.valid.json",
  );
  const v4 = () => JSON.parse(readFileSync(v4Path, "utf8"));
  const v2Inputs = {
    ...inputBytes,
    vacancyBytes: readFileSync(fixture("vacancy-v2-completed/vacancy.json")),
    jobDescriptionBytes: readFileSync(fixture("vacancy-v2-completed/job-description.txt")),
    companyResearchBytes: readFileSync(
      fixture("research-v2-over-vacancy-v2/company-research.json"),
    ),
  };

  await t.test("the fixture is bundle-valid over the version 2 vacancy and its research", () => {
    assert.equal(v4().schemaVersion, 4);
    assert.deepEqual(validateApplicationBrief(v4(), { ...v2Inputs, markets }), []);
    assert.deepEqual(
      validateApplicationBrief(v4(), { ...v2Inputs, markets, expectedSchemaVersion: 4 }),
      [],
    );
    const bundle = readAndValidateApplicationBriefBundle(
      v4Path,
      fixture("vacancy-v2-completed/vacancy.json"),
      fixture("vacancy-v2-completed/job-description.txt"),
      fixture("research-v2-over-vacancy-v2/company-research.json"),
      candidateProfilePath,
      candidateLeversPath,
      { markets },
    );
    assert.equal(bundle.brief.role.market, markets.outsideHome.name);
    // Version 3 and the ones before it are refused, whatever a caller expects.
    for (const version of [1, 2, 3]) {
      const older = v4();
      older.schemaVersion = version;
      for (const options of [
        { ...v2Inputs, markets },
        { ...v2Inputs, markets, expectedSchemaVersion: version },
      ]) {
        assert.match(
          validateApplicationBrief(older, options).join("\n"),
          new RegExp(`schemaVersion ${version} is unsupported; rerun map-experience`),
        );
      }
    }
  });

  await t.test("the header follows the side: omitted at home, explicit outside it", () => {
    const home = v4();
    home.role.market = markets.home.name;
    assert.match(
      validateApplicationBrief(home, { markets }).join("\n"),
      /role\.market on the home market requires cvPlan\.headerPositioning\.mode omit/,
    );
    home.cvPlan.headerPositioning = { mode: "omit", text: null, rationale: "Home market." };
    assert.deepEqual(validateApplicationBrief(home, { markets }), []);
    const outside = v4();
    outside.cvPlan.headerPositioning = {
      mode: "omit",
      text: null,
      rationale: "Synthetic inconsistent decision.",
    };
    assert.match(
      validateApplicationBrief(outside, { markets }).join("\n"),
      /role\.market outside the home market requires cvPlan\.headerPositioning\.mode explicit/,
    );
  });

  await t.test(
    "a name the layer does not configure is refused, and without markets every name is",
    () => {
      for (const value of ["elsewhere", "foreign-market"]) {
        const brief = v4();
        brief.role.market = value;
        assert.match(
          validateApplicationBrief(brief, { markets }).join("\n"),
          /role\.market must be one of: domestic, international/,
          value,
        );
      }
      assert.match(
        validateApplicationBrief(v4(), { markets: undefined }).join("\n"),
        /role\.market must name a configured market: the candidate layer configures none/,
      );
    },
  );

  await t.test("the vacancy reference names the current version of the vacancy", () => {
    for (const version of [1, 3]) {
      const brief = v4();
      brief.inputs.vacancy.schemaVersion = version;
      assert.match(
        validateApplicationBrief(brief, { ...v2Inputs, markets }).join("\n"),
        /inputs\.vacancy\.schemaVersion must be one of: 2$/m,
      );
    }
    // A vacancy of version 1 under the brief is refused as the vacancy's own content.
    const vacancy = JSON.parse(v2Inputs.vacancyBytes.toString("utf8"));
    vacancy.schemaVersion = 1;
    assert.match(
      validateApplicationBrief(v4(), {
        ...v2Inputs,
        markets,
        vacancyBytes: Buffer.from(`${JSON.stringify(vacancy, null, 2)}\n`, "utf8"),
      }).join("\n"),
      /inputs\.vacancy content: schemaVersion must be one of: 2$/m,
    );
  });
});

test("the brief self-check reads the markets of the workspace's layer", (t) => {
  // The options this command builds are invisible to the static pin on callers, so its reading of
  // the markets is held here.
  const run = (workspaceRoot) =>
    spawnSync(
      process.execPath,
      [
        resolve(repoRoot, "tools/application-brief/validate.mjs"),
        resolve(repoRoot, "tools/application-brief/fixtures/application-brief.v4.valid.json"),
      ],
      { encoding: "utf8", env: { ...process.env, JOB_PIPELINE_WORKSPACE_ROOT: workspaceRoot } },
    );
  const withLayer = mkdtempSync(join(tmpdir(), "job-search-brief-cli-"));
  const withoutLayer = mkdtempSync(join(tmpdir(), "job-search-brief-cli-bare-"));
  t.after(() => {
    rmSync(withLayer, { force: true, recursive: true });
    rmSync(withoutLayer, { force: true, recursive: true });
  });
  seedCandidateConfig(repoRoot, withLayer);
  const valid = run(withLayer);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).schemaVersion, 4);
  const refused = run(withoutLayer);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /role\.market must name a configured market/);
});

test("the research reference names the only research version", () => {
  for (const version of [1, 3]) {
    const brief = makeValidBrief();
    brief.inputs.companyResearch.schemaVersion = version;
    assert.match(
      validateApplicationBrief(brief, inputBytes).join("\n"),
      /^inputs\.companyResearch\.schemaVersion must be one of: 2$/m,
    );
  }
});

test("bundle validation detects stale input digests and process disagreement", () => {
  const stale = makeValidBrief();
  stale.inputs.companyResearch.sha256 = "0".repeat(64);
  assert.match(
    validateApplicationBrief(stale, inputBytes).join("\n"),
    /inputs\.companyResearch\.sha256 does not match/,
  );

  const wrongProcess = makeValidBrief();
  assert.match(
    validateApplicationBrief(wrongProcess, {
      ...inputBytes,
      expectedProcess: {
        id: "proc_other",
        sourceRef: wrongProcess.process.sourceRef,
        outputDir: wrongProcess.process.outputDir,
      },
    }).join("\n"),
    /process\.id does not match the selected ledger process/,
  );
});

test("bundle validation preserves vacancy facts and research provenance", () => {
  const feasibilityDrift = makeValidBrief();
  feasibilityDrift.role.feasibility.salary = "€100,000";
  assert.match(
    validateApplicationBrief(feasibilityDrift, inputBytes).join("\n"),
    /role\.feasibility must exactly preserve vacancy\.json/,
  );

  const missingClaim = makeValidBrief();
  missingClaim.company.values[0].claimIds = ["C99"];
  assert.match(
    validateApplicationBrief(missingClaim, inputBytes).join("\n"),
    /company\.values\[0\]\.claimIds reference does not exist/,
  );

  const mismatchedHook = makeValidBrief();
  mismatchedHook.company.tailoringHooks[0].evidence = "A rewritten unsupported fact.";
  assert.match(
    validateApplicationBrief(mismatchedHook, inputBytes).join("\n"),
    /tailoringHooks\[0\]\.evidence must match the referenced research hook fact/,
  );

  const inventedKeyword = makeValidBrief();
  inventedKeyword.ats.keywords[14].term = "Synthetic term absent from the JD";
  assert.match(
    validateApplicationBrief(inventedKeyword, inputBytes).join("\n"),
    /ats\.keywords\[14\]\.term must exactly occur in job-description\.txt/,
  );
});

test("profile pointers and lever rationale are mandatory", () => {
  const missingTraitPointer = makeValidBrief();
  delete missingTraitPointer.experience.traits[0].profileSource;
  assert.match(
    validateApplicationBrief(missingTraitPointer).join("\n"),
    /experience\.traits\[0\]\.profileSource must be an object/,
  );

  const unknownProfileSection = makeValidBrief();
  unknownProfileSection.experience.traits[0].profileSource.section = "## Missing profile section";
  assert.match(
    validateApplicationBrief(unknownProfileSection, inputBytes).join("\n"),
    /profileSource\.section does not exist/,
  );

  const missingRationale = makeValidBrief();
  delete missingRationale.positioning.selectedLevers[0].rationale;
  assert.match(
    validateApplicationBrief(missingRationale).join("\n"),
    /selectedLevers\[0\]\.rationale must be a non-empty string/,
  );
});

test("hard-gap keywords require an honest gap reference and no placement", () => {
  const brief = makeValidBrief();
  // Index the pushed gap instead of assuming it is the first one: the canonical fixture carries
  // its own gaps, so a hardcoded [0] would mutate fixture data and pass for the wrong reason.
  const gapIndex =
    brief.experience.gaps.push({
      id: "gap-synthetic-unsupported",
      requirement: "Synthetic unsupported requirement",
      classification: "hard",
      transferableSupport: {
        status: "none",
        evidenceIds: [],
      },
      framing: "Do not claim this requirement as met.",
    }) - 1;
  brief.ats.keywords[8] = {
    term: "Synthetic unsupported requirement",
    expanded: null,
    support: {
      status: "gap",
      gapId: "gap-synthetic-unsupported",
    },
    placements: [],
    required: false,
    placementMode: "any",
  };
  brief.coverLetterPlan.keywordTerms = ["TypeScript", "Playwright", "API testing"];
  assert.deepEqual(validateApplicationBrief(brief), []);

  brief.experience.gaps[gapIndex].requirement = "A different unsupported requirement";
  assert.match(
    validateApplicationBrief(brief).join("\n"),
    /term must occur in the linked gap requirement/,
  );
  brief.experience.gaps[gapIndex].requirement = "Synthetic unsupported requirement";
  brief.ats.keywords[8].placements = ["Summary"];
  brief.ats.keywords[8].required = true;
  const errors = validateApplicationBrief(brief).join("\n");
  assert.match(errors, /placements must be empty when support\.status is gap/);
  assert.match(errors, /required must be false when support\.status is gap/);
});

test("gap transferable support is evidence-backed or explicitly absent", () => {
  const missingSupport = makeValidBrief();
  const missingSupportIndex =
    missingSupport.experience.gaps.push({
      id: "gap-01",
      requirement: "A synthetic adjacent requirement",
      classification: "adjacent",
      framing: "Use only transferable evidence.",
    }) - 1;
  assert.match(
    validateApplicationBrief(missingSupport).join("\n"),
    new RegExp(`gaps\\[${missingSupportIndex}\\]\\.transferableSupport must be an object`),
  );

  const danglingSupport = makeValidBrief();
  danglingSupport.experience.gaps.push({
    id: "gap-01",
    requirement: "A synthetic adjacent requirement",
    classification: "adjacent",
    transferableSupport: {
      status: "evidence",
      evidenceIds: ["missing-evidence"],
    },
    framing: "Use only transferable evidence.",
  });
  assert.match(
    validateApplicationBrief(danglingSupport).join("\n"),
    /transferableSupport\.evidenceIds reference does not exist/,
  );
});

test("every ATS keyword requires placementMode and resolvable support", () => {
  const missingMode = makeValidBrief();
  delete missingMode.ats.keywords[0].placementMode;
  assert.match(
    validateApplicationBrief(missingMode).join("\n"),
    /ats\.keywords\[0\]\.placementMode must be any or all/,
  );

  const danglingEvidence = makeValidBrief();
  danglingEvidence.ats.keywords[0].support.evidenceIds = ["missing-evidence"];
  assert.match(
    validateApplicationBrief(danglingEvidence).join("\n"),
    /ats\.keywords\[0\]\.support\.evidenceIds reference does not exist/,
  );
});

test("required ATS evidence must close into an executable check and can recover", () => {
  const brief = makeValidBrief();
  addSyntheticEvidence(brief, "E05", ["Summary"]);
  brief.ats.keywords[0].support.evidenceIds = ["E05"];

  assert.match(
    validateApplicationBrief(brief).join("\n"),
    /ats\.keywords\[0\].*required evidence.*cvPlan\.checks\.requiredEvidence.*Summary/,
  );

  addSyntheticCheck(brief, {
    id: "ats-e05-summary",
    evidenceIds: ["E05"],
    placements: ["Summary"],
    placementMode: "all",
  });
  assert.deepEqual(validateApplicationBrief(brief), []);
});

test("required ATS evidence placement coverage respects both placement modes", () => {
  const partialAll = makeValidBrief();
  addSyntheticEvidence(partialAll, "E05", ["Summary", "Skills"]);
  partialAll.ats.keywords[0].support.evidenceIds = ["E05"];
  partialAll.ats.keywords[0].placements = ["Summary", "Skills"];
  partialAll.ats.keywords[0].placementMode = "all";
  addSyntheticCheck(partialAll, {
    id: "ats-e05-summary-only",
    evidenceIds: ["E05"],
    placements: ["Summary"],
    placementMode: "all",
  });
  assert.match(
    validateApplicationBrief(partialAll).join("\n"),
    /ats\.keywords\[0\].*placementMode all.*Skills/,
  );

  const flexibleAll = makeValidBrief();
  addSyntheticEvidence(flexibleAll, "E05", ["Summary", "Skills"]);
  flexibleAll.ats.keywords[0].support.evidenceIds = ["E05"];
  flexibleAll.ats.keywords[0].placements = ["Summary", "Skills"];
  flexibleAll.ats.keywords[0].placementMode = "all";
  addSyntheticCheck(flexibleAll, {
    id: "ats-e05-flexible",
    evidenceIds: ["E05"],
    placements: ["Summary", "Skills"],
    placementMode: "any",
  });
  assert.match(
    validateApplicationBrief(flexibleAll).join("\n"),
    /ats\.keywords\[0\].*placementMode all.*Summary, Skills/,
  );

  const escapingAny = makeValidBrief();
  addSyntheticEvidence(escapingAny, "E05", ["Summary", "Skills", "Education"]);
  escapingAny.ats.keywords[0].support.evidenceIds = ["E05"];
  escapingAny.ats.keywords[0].placements = ["Summary", "Skills"];
  escapingAny.ats.keywords[0].placementMode = "any";
  addSyntheticCheck(escapingAny, {
    id: "ats-e05-can-escape",
    evidenceIds: ["E05"],
    placements: ["Skills", "Education"],
    placementMode: "any",
  });
  assert.match(
    validateApplicationBrief(escapingAny).join("\n"),
    /ats\.keywords\[0\].*placementMode any.*Summary, Skills/,
  );
});

test("valid collective, flexible, optional, and gap ATS combinations remain accepted", () => {
  const collectiveAll = makeValidBrief();
  addSyntheticEvidence(collectiveAll, "E05", ["Summary", "Skills"]);
  collectiveAll.ats.keywords[0].support.evidenceIds = ["E05"];
  collectiveAll.ats.keywords[0].placements = [" Summary ", "SKILLS"];
  collectiveAll.ats.keywords[0].placementMode = "all";
  addSyntheticCheck(collectiveAll, {
    id: "ats-e05-summary",
    evidenceIds: ["E05"],
    placements: ["summary"],
    placementMode: "all",
  });
  addSyntheticCheck(collectiveAll, {
    id: "ats-e05-skills",
    evidenceIds: ["E05"],
    placements: ["Skills"],
    placementMode: "any",
  });
  assert.deepEqual(validateApplicationBrief(collectiveAll), []);

  const containedAny = makeValidBrief();
  addSyntheticEvidence(containedAny, "E05", ["Summary", "Skills"]);
  containedAny.ats.keywords[0].support.evidenceIds = ["E05", "evidence-logistics"];
  containedAny.ats.keywords[0].placements = ["Summary", "Skills"];
  containedAny.ats.keywords[0].placementMode = "any";
  addSyntheticCheck(containedAny, {
    id: "ats-e05-contained",
    evidenceIds: ["E05"],
    placements: ["Summary", "Skills"],
    placementMode: "any",
  });
  assert.deepEqual(validateApplicationBrief(containedAny), []);

  const intersectingAll = makeValidBrief();
  addSyntheticEvidence(intersectingAll, "E05", ["Summary", "Skills", "Education"]);
  intersectingAll.ats.keywords[0].support.evidenceIds = ["E05"];
  intersectingAll.ats.keywords[0].placements = ["Summary", "Skills"];
  intersectingAll.ats.keywords[0].placementMode = "any";
  addSyntheticCheck(intersectingAll, {
    id: "ats-e05-intersection",
    evidenceIds: ["E05"],
    placements: ["Skills", "Education"],
    placementMode: "all",
  });
  assert.deepEqual(validateApplicationBrief(intersectingAll), []);

  const optional = makeValidBrief();
  addSyntheticEvidence(optional, "E05", ["Summary"]);
  optional.ats.keywords[0].support.evidenceIds = ["E05"];
  optional.ats.keywords[0].required = false;
  assert.deepEqual(validateApplicationBrief(optional), []);
});

test("AI-relevant contract outside the home market is valid", () => {
  const brief = makeValidBrief();
  brief.role.market = exampleMarkets.outsideHome.name;
  brief.role.feasibility = {
    workModel: {
      normalized: "remote",
      sourceText: "Europe (remote)",
    },
    locations: ["Europe"],
    employmentType: "Independent contractor",
    timezoneOverlap: "European business hours",
    workAuthorizationResidency: null,
    relocationVisaSupport: null,
    salary: null,
  };
  brief.positioning.aiRegister = "relevance-link";
  brief.positioning.supportingSignals[0].decision = "include";
  brief.positioning.supportingSignals[0].cvEvidenceCheckId = "primary-lever-evidence";
  brief.cvPlan.headerPositioning = {
    mode: "explicit",
    text: "Remote independent contractor available across European business hours.",
    rationale: "The application outside the home market needs an explicit feasibility signal.",
  };
  brief.cvPlan.projectDecision = {
    decision: "include",
    projectId: "synthetic-agentic-project",
    rationale: "The role explicitly values the project's transferable evidence.",
  };
  brief.experience.priorityEvidence[0].cvPlacements.push("Projects");
  brief.cvPlan.checks.requiredEvidence.push({
    id: "project-evidence",
    description: "The selected synthetic project appears in Projects.",
    evidenceIds: ["evidence-framework"],
    anyOf: ["synthetic-agentic-project"],
    placements: ["Projects"],
    placementMode: "all",
  });
  assert.deepEqual(validateApplicationBrief(brief), []);
});

test("non-AI contract on the home market is valid", () => {
  const brief = makeValidBrief();
  brief.role.market = exampleMarkets.home.name;
  brief.role.feasibility = {
    workModel: {
      normalized: "unspecified",
      sourceText: null,
    },
    locations: [],
    employmentType: null,
    timezoneOverlap: null,
    workAuthorizationResidency: null,
    relocationVisaSupport: null,
    salary: null,
  };
  brief.positioning.aiRegister = "work-only";
  brief.positioning.supportingSignals[0].decision = "exclude";
  delete brief.positioning.supportingSignals[0].cvEvidenceCheckId;
  brief.cvPlan.headerPositioning = {
    mode: "omit",
    text: null,
    rationale: "Russian-market applications omit market-specific positioning.",
  };
  brief.cvPlan.projectDecision = {
    decision: "exclude",
    projectId: null,
    rationale: "No project is relevant enough to displace commercial evidence.",
  };
  assert.deepEqual(validateApplicationBrief(brief), []);
});

test("the brief refuses a vacancy language outside the layer's set on its own", async (t) => {
  // The cross-file equality check below only says the brief agrees with vacancy.json; it says
  // nothing when the brief is validated alone, which is how the standalone command runs it. The
  // set is the example's: the default language and Greek.
  const languages = candidateLanguageNames({ root: candidateExampleRootFor(repoRoot) });
  for (const value of ["en", "english", "German"]) {
    await t.test(`refuses ${JSON.stringify(value)}`, () => {
      const brief = makeValidBrief();
      brief.role.vacancyLanguage = value;
      assert.match(
        validateApplicationBrief(brief, { languages }).join("\n"),
        /role\.vacancyLanguage must be one of: English, Greek/,
      );
    });
  }

  await t.test("accepts the default language and a configured one", () => {
    for (const value of languages) {
      const brief = makeValidBrief();
      brief.role.vacancyLanguage = value;
      assert.equal(
        validateApplicationBrief(brief, { languages }).some((error) =>
          error.startsWith("role.vacancyLanguage must be one of"),
        ),
        false,
      );
    }
  });

  await t.test("without the layer's set only the default language is accepted", () => {
    const brief = makeValidBrief();
    brief.role.vacancyLanguage = "Greek";
    assert.ok(
      validateApplicationBrief(brief).includes("role.vacancyLanguage must be one of: English"),
    );
  });
});

test("old application-brief versions are rejected with a schemaVersion 4 instruction", () => {
  for (const version of [1, 2]) {
    const brief = makeValidBrief();
    brief.schemaVersion = version;
    assert.deepEqual(validateApplicationBrief(brief), [
      `schemaVersion ${version} is unsupported; rerun map-experience to create application-brief.json with schemaVersion 4`,
    ]);
  }
});

test("schemaVersion 4 requires every downstream decision block", async (t) => {
  const cases = [
    {
      name: "role.feasibility",
      path: /role\.feasibility must be an object/,
      remove: (brief) => delete brief.role.feasibility,
    },
    {
      name: "positioning.aiRegister",
      path: /positioning\.aiRegister must be one of/,
      remove: (brief) => delete brief.positioning.aiRegister,
    },
    {
      name: "cvPlan",
      path: /cvPlan must be an object/,
      remove: (brief) => delete brief.cvPlan,
    },
    {
      name: "cvPlan.llmWorkSignal",
      path: /cvPlan\.llmWorkSignal must be an object/,
      remove: (brief) => delete brief.cvPlan.llmWorkSignal,
    },
    {
      name: "coverLetterPlan",
      path: /coverLetterPlan must be an object/,
      remove: (brief) => delete brief.coverLetterPlan,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const brief = makeValidBrief();
      scenario.remove(brief);
      assert.match(validateApplicationBrief(brief).join("\n"), scenario.path);
    });
  }
});

test("application brief requires an explicit AI decision compatible with aiRegister", () => {
  const missingDecision = makeValidBrief();
  missingDecision.positioning.supportingSignals = [
    {
      id: "test-data",
      topic: "Test data",
      decision: "include",
      evidence: "A relevant evidence anchor.",
      constraints: ["Do not overclaim ownership."],
      cvEvidenceCheckId: "primary-lever-evidence",
    },
  ];
  assert.match(validateApplicationBrief(missingDecision).join("\n"), /explicit AI\/LLM/);

  const includedAi = makeValidBrief();
  includedAi.positioning.aiRegister = "broad";
  includedAi.positioning.supportingSignals[0].decision = "include";
  includedAi.positioning.supportingSignals[0].cvEvidenceCheckId = "primary-lever-evidence";
  assert.deepEqual(validateApplicationBrief(includedAi), []);

  includedAi.positioning.aiRegister = "work-only";
  assert.match(validateApplicationBrief(includedAi).join("\n"), /aiRegister work-only.*exclude/);
});

test("supporting-signal evidence checks exist only for included signals", () => {
  const missingIncludedCheck = makeValidBrief();
  delete missingIncludedCheck.positioning.supportingSignals[0].cvEvidenceCheckId;
  assert.match(
    validateApplicationBrief(missingIncludedCheck).join("\n"),
    /cvEvidenceCheckId must be a non-empty string/,
  );

  const excludedSignal = makeValidBrief();
  excludedSignal.positioning.aiRegister = "work-only";
  excludedSignal.positioning.supportingSignals[0].decision = "exclude";
  assert.match(
    validateApplicationBrief(excludedSignal).join("\n"),
    /cvEvidenceCheckId is allowed only when decision is include/,
  );

  const optionalSignal = makeValidBrief();
  optionalSignal.positioning.supportingSignals.push({
    id: "open-source",
    topic: "Open-source signal",
    decision: "optional",
    evidence: "A non-AI optional signal.",
    constraints: ["Use only when space permits."],
    cvEvidenceCheckId: "primary-lever-evidence",
  });
  assert.match(
    validateApplicationBrief(optionalSignal).join("\n"),
    /cvEvidenceCheckId is allowed only when decision is include/,
  );
});

// The register rules read the properties of the selected levers from the candidate's bank. The
// example's bank carries ai-practice on lever 3 and ai-infrastructure on lever 5, so these cases
// fail if a rule still keys on the numbers a real bank happens to use.
const withBank = { candidateLeversBytes: inputBytes.candidateLeversBytes };

test("the deep register requires a selected lever with the ai-infrastructure property", () => {
  const brief = makeValidBrief();
  brief.positioning.aiRegister = "deep";
  brief.positioning.supportingSignals[0].decision = "include";
  brief.positioning.supportingSignals[0].cvEvidenceCheckId = "primary-lever-evidence";
  assert.match(
    validateApplicationBrief(brief, withBank).join("\n"),
    /deep requires a selected lever with the ai-infrastructure property/,
  );
  brief.positioning.selectedLevers[0].id = 5;
  assert.deepEqual(validateApplicationBrief(brief, withBank), []);
});

test("a lever with the ai-infrastructure property requires the deep register", () => {
  for (const register of ["broad", "relevance-link"]) {
    const brief = makeValidBrief();
    brief.positioning.aiRegister = register;
    brief.positioning.selectedLevers[0].id = 5;
    assert.match(
      validateApplicationBrief(brief, withBank).join("\n"),
      /a selected lever with the ai-infrastructure property requires positioning\.aiRegister deep/,
    );
  }
});

test("the work-only register cannot select a lever with an AI property, and a number means nothing", () => {
  const workOnly = (leverId) => {
    const brief = makeValidBrief();
    brief.positioning.aiRegister = "work-only";
    brief.positioning.supportingSignals[0].decision = "exclude";
    delete brief.positioning.supportingSignals[0].cvEvidenceCheckId;
    brief.positioning.selectedLevers[0].id = leverId;
    return validateApplicationBrief(brief, withBank).join("\n");
  };
  for (const leverId of [3, 5]) {
    assert.match(
      workOnly(leverId),
      /work-only is incompatible with a selected lever with the ai-practice or ai-infrastructure property/,
    );
  }
  // Lever 2 of this bank carries no AI property, so work-only may select it.
  assert.equal(workOnly(2), "");
});

test("a lever id is checked against the candidate's bank, and structurally only as a positive integer", () => {
  const brief = makeValidBrief();
  brief.positioning.selectedLevers[0].id = 9;
  assert.match(
    validateApplicationBrief(brief, withBank).join("\n"),
    /selectedLevers\[0\]\.id names no lever of candidate\/levers\.md/,
  );
  assert.deepEqual(validateApplicationBrief(brief), []);
  brief.positioning.selectedLevers[0].id = 0;
  assert.match(
    validateApplicationBrief(brief).join("\n"),
    /selectedLevers\[0\]\.id must be a positive integer/,
  );

  // Bundle validation needs the bank, and a bank that breaks its own form is reported as such.
  const { candidateLeversBytes, ...withoutBank } = inputBytes;
  assert.match(
    validateApplicationBrief(makeValidBrief(), withoutBank).join("\n"),
    /candidate\/levers\.md bytes are required for application-brief bundle validation/,
  );
  assert.match(
    validateApplicationBrief(makeValidBrief(), {
      candidateLeversBytes: Buffer.from("# Levers\n\n## Positioning\n"),
    }).join("\n"),
    /^candidate\/levers\.md: /mu,
  );
});

test("a brief published from an earlier profile path stays structurally valid and never bundle-valid", () => {
  // A made-up earlier path: the check must not depend on any real path being spelt anywhere.
  const earlier = "profiles/earlier-profile.md";
  const brief = makeValidBrief();
  brief.inputs.candidateProfile.path = earlier;
  for (const evidence of brief.experience.priorityEvidence) evidence.profileSource.path = earlier;
  for (const trait of brief.experience.traits) trait.profileSource.path = earlier;
  assert.deepEqual(validateApplicationBrief(brief), []);
  assert.match(
    validateApplicationBrief(brief, inputBytes).join("\n"),
    /inputs\.candidateProfile\.path must equal candidate\/profile\.md/,
  );

  // One brief reads one profile: a source naming another file is refused in either mode.
  brief.experience.traits[0].profileSource.path = "candidate/profile.md";
  assert.match(
    validateApplicationBrief(brief).join("\n"),
    /experience\.traits\[0\]\.profileSource\.path must equal profiles\/earlier-profile\.md/,
  );
});

test("application brief rejects dangling CV evidence-check references", () => {
  const leverBrief = makeValidBrief();
  leverBrief.positioning.selectedLevers[0].cvEvidenceCheckIds = ["missing-lever-check"];
  assert.match(
    validateApplicationBrief(leverBrief).join("\n"),
    /does not exist: missing-lever-check/,
  );

  const signalBrief = makeValidBrief();
  signalBrief.positioning.aiRegister = "broad";
  signalBrief.positioning.supportingSignals[0].decision = "include";
  signalBrief.positioning.supportingSignals[0].cvEvidenceCheckId = "missing-signal-check";
  assert.match(
    validateApplicationBrief(signalBrief).join("\n"),
    /does not exist: missing-signal-check/,
  );

  const disconnectedLever = makeValidBrief();
  disconnectedLever.cvPlan.checks.requiredEvidence[0].evidenceIds = ["evidence-llm-work"];
  disconnectedLever.cvPlan.checks.requiredEvidence[0].placements = ["Experience:Current Company"];
  assert.match(
    validateApplicationBrief(disconnectedLever).join("\n"),
    /must link at least one selected lever evidence anchor/,
  );
});

test("required evidence checks link to canonical priority evidence", () => {
  const missingLinks = makeValidBrief();
  delete missingLinks.cvPlan.checks.requiredEvidence[0].evidenceIds;
  assert.match(
    validateApplicationBrief(missingLinks).join("\n"),
    /requiredEvidence\[0\]\.evidenceIds must be an array/,
  );

  const danglingLink = makeValidBrief();
  danglingLink.cvPlan.checks.requiredEvidence[0].evidenceIds = ["missing-evidence"];
  assert.match(
    validateApplicationBrief(danglingLink).join("\n"),
    /evidenceIds reference does not exist: missing-evidence/,
  );
});

test("every CV has a linked commercial LLM work signal in Experience", () => {
  const missingSignal = makeValidBrief();
  delete missingSignal.cvPlan.llmWorkSignal;
  assert.match(
    validateApplicationBrief(missingSignal).join("\n"),
    /cvPlan\.llmWorkSignal must be an object/,
  );

  const danglingEvidence = makeValidBrief();
  danglingEvidence.cvPlan.llmWorkSignal.evidenceId = "missing-llm-evidence";
  assert.match(
    validateApplicationBrief(danglingEvidence).join("\n"),
    /llmWorkSignal\.evidenceId reference does not exist/,
  );

  const danglingCheck = makeValidBrief();
  danglingCheck.cvPlan.llmWorkSignal.checkId = "missing-llm-check";
  assert.match(
    validateApplicationBrief(danglingCheck).join("\n"),
    /llmWorkSignal\.checkId reference does not exist/,
  );

  const unlinkedEvidence = makeValidBrief();
  unlinkedEvidence.cvPlan.llmWorkSignal.evidenceId = "evidence-framework";
  assert.match(
    validateApplicationBrief(unlinkedEvidence).join("\n"),
    /checkId must link its evidenceId/,
  );

  const noExperience = makeValidBrief();
  noExperience.cvPlan.checks.requiredEvidence[1].placements = ["Skills"];
  assert.match(
    validateApplicationBrief(noExperience).join("\n"),
    /llmWorkSignal check must target an Experience placement/,
  );

  const flexiblePlacement = makeValidBrief();
  flexiblePlacement.cvPlan.checks.requiredEvidence[1].placementMode = "any";
  assert.match(
    validateApplicationBrief(flexiblePlacement).join("\n"),
    /llmWorkSignal check must use placementMode all/,
  );

  const vagueWording = makeValidBrief();
  vagueWording.cvPlan.checks.requiredEvidence[1].anyOf = ["AI-assisted workflow"];
  assert.match(
    validateApplicationBrief(vagueWording).join("\n"),
    /anyOf alternative must explicitly contain LLM/,
  );
});

test("CV plan conditionals are validated", () => {
  const headerBrief = makeValidBrief();
  headerBrief.cvPlan.headerPositioning = {
    mode: "explicit",
    text: null,
    rationale: "The target market requires an explicit work-model note.",
  };
  assert.match(
    validateApplicationBrief(headerBrief).join("\n"),
    /headerPositioning\.text must be a non-empty string/,
  );

  const projectBrief = makeValidBrief();
  projectBrief.cvPlan.projectDecision = {
    decision: "include",
    projectId: null,
    rationale: "The role values this project evidence.",
  };
  assert.match(
    validateApplicationBrief(projectBrief).join("\n"),
    /projectDecision\.projectId must be a non-empty string/,
  );
});

test("market and header-positioning decisions stay consistent", () => {
  const foreignBrief = makeValidBrief();
  foreignBrief.cvPlan.headerPositioning = {
    mode: "omit",
    text: null,
    rationale: "Synthetic inconsistent decision.",
  };
  assert.match(
    validateApplicationBrief(foreignBrief).join("\n"),
    /outside the home market requires.*mode explicit/,
  );

  const homeBrief = makeValidBrief();
  homeBrief.role.market = exampleMarkets.home.name;
  assert.match(
    validateApplicationBrief(homeBrief).join("\n"),
    /on the home market requires.*mode omit/,
  );
});

test("included projects require a linked required-evidence check in Projects", () => {
  const brief = makeValidBrief();
  brief.cvPlan.projectDecision = {
    decision: "include",
    projectId: "synthetic-project",
    rationale: "The project is relevant to the synthetic role.",
  };
  brief.experience.priorityEvidence[0].cvPlacements.push("Projects");
  assert.match(
    validateApplicationBrief(brief).join("\n"),
    /projectDecision include requires at least one.*targeting Projects/,
  );
});

test("required-evidence placements must be allowed by linked evidence", () => {
  const allBrief = makeValidBrief();
  allBrief.cvPlan.checks.requiredEvidence[0].placements = ["Selected Impact", "Education"];
  assert.match(
    validateApplicationBrief(allBrief).join("\n"),
    /placements not allowed by linked evidence cvPlacements: Education/,
  );

  const anyBrief = makeValidBrief();
  anyBrief.cvPlan.checks.requiredEvidence[0].placementMode = "any";
  anyBrief.cvPlan.checks.requiredEvidence[0].placements = [" selected impact ", "Summary"];
  assert.deepEqual(validateApplicationBrief(anyBrief), []);

  anyBrief.cvPlan.checks.requiredEvidence[0].placements = ["Education", "Header"];
  assert.match(
    validateApplicationBrief(anyBrief).join("\n"),
    /placements has no placement allowed by linked evidence/,
  );
});

test("chronological plans reject Selected Impact placements and multiple variants", () => {
  const brief = makeValidBrief();
  brief.cvPlan.structure = "chronological";
  let errors = validateApplicationBrief(brief).join("\n");
  assert.match(
    errors,
    /experience\.priorityEvidence\[0\]\.cvPlacements cannot target Selected Impact/,
  );
  assert.match(
    errors,
    /cvPlan\.checks\.requiredEvidence\[0\]\.placements cannot target Selected Impact/,
  );

  brief.experience.priorityEvidence[0].cvPlacements = ["Experience:<company>"];
  brief.cvPlan.checks.requiredEvidence[0].placements = ["Experience:<company>"];
  brief.ats.keywords[0].placements = ["Selected Impact"];
  errors = validateApplicationBrief(brief).join("\n");
  assert.match(errors, /ats\.keywords\[0\]\.placements cannot target Selected Impact/);

  brief.ats.keywords[0].placements = ["Experience"];
  brief.cvPlan.variants = ["remote", "relocation"];
  assert.match(validateApplicationBrief(brief).join("\n"), /one targeted CV only/);
});

test("an excluded Projects section cannot remain a planned placement", () => {
  const brief = makeValidBrief();
  brief.experience.priorityEvidence[0].cvPlacements.push("Projects");
  brief.ats.keywords[0].placements.push(" projects ");
  brief.cvPlan.checks.requiredEvidence[0].placements.push("PROJECTS");
  const errors = validateApplicationBrief(brief).join("\n");
  assert.match(errors, /experience\.priorityEvidence\[0\]\.cvPlacements cannot target Projects/);
  assert.match(errors, /ats\.keywords\[0\]\.placements cannot target Projects/);
  assert.match(errors, /cvPlan\.checks\.requiredEvidence\[0\]\.placements cannot target Projects/);
});

test("required content cannot conflict with forbidden terms", () => {
  const keywordBrief = makeValidBrief();
  keywordBrief.cvPlan.checks.forbiddenTerms.push({
    term: "  typescript  ",
    reason: "Synthetic contradiction.",
  });
  assert.match(
    validateApplicationBrief(keywordBrief).join("\n"),
    /ats\.keywords\[0\]\.term conflicts/,
  );

  const compoundKeywordBrief = makeValidBrief();
  compoundKeywordBrief.ats.keywords[0].term = "AI-assisted";
  compoundKeywordBrief.coverLetterPlan.keywordTerms[0] = "AI-assisted";
  compoundKeywordBrief.cvPlan.checks.forbiddenTerms.push({
    term: "AI",
    reason: "Synthetic contradiction.",
  });
  assert.match(
    validateApplicationBrief(compoundKeywordBrief).join("\n"),
    /ats\.keywords\[0\]\.term conflicts/,
  );

  const evidenceBrief = makeValidBrief();
  evidenceBrief.cvPlan.checks.forbiddenTerms.push({
    term: "AI",
    reason: "Synthetic contradiction.",
  });
  evidenceBrief.cvPlan.checks.requiredEvidence[1].anyOf = [
    "AI-powered LLM",
    "AI-assisted LLM workflow",
  ];
  assert.match(
    validateApplicationBrief(evidenceBrief).join("\n"),
    /requiredEvidence\[1\]\.anyOf is unsatisfiable/,
  );

  evidenceBrief.cvPlan.checks.requiredEvidence[1].anyOf.push("LLM with human review");
  assert.doesNotMatch(
    validateApplicationBrief(evidenceBrief).join("\n"),
    /requiredEvidence\[1\]\.anyOf is unsatisfiable/,
  );
});

test("cover-letter plan references canonical evidence IDs and exact ATS terms", () => {
  const evidenceBrief = makeValidBrief();
  evidenceBrief.coverLetterPlan.evidenceIds = ["missing-evidence"];
  assert.match(
    validateApplicationBrief(evidenceBrief).join("\n"),
    /evidenceIds reference does not exist: missing-evidence/,
  );

  const keywordBrief = makeValidBrief();
  keywordBrief.coverLetterPlan.keywordTerms[0] = "Keyword-1";
  assert.match(
    validateApplicationBrief(keywordBrief).join("\n"),
    /exact reference does not exist: Keyword-1/,
  );
});

test("legacy top-level contentChecks cannot coexist with cvPlan.checks", () => {
  const brief = makeValidBrief();
  brief.contentChecks = structuredClone(brief.cvPlan.checks);
  assert.match(
    validateApplicationBrief(brief).join("\n"),
    /contentChecks is obsolete.*cvPlan\.checks/,
  );
});

test("schemaVersion 4 rejects unknown keys throughout decision containers", async (t) => {
  const cases = [
    [
      "cvPlans",
      (brief) => {
        brief.cvPlans = {};
      },
      /unknown top-level key: cvPlans/,
    ],
    [
      "top-level alternatives",
      (brief) => {
        brief.alternatives = [];
      },
      /unknown top-level key: alternatives/,
    ],
    [
      "unknown top-level key",
      (brief) => {
        brief.unexpected = true;
      },
      /unknown top-level key: unexpected/,
    ],
    [
      "process",
      (brief) => {
        brief.process.unexpected = true;
      },
      /process contains unknown key: unexpected/,
    ],
    [
      "inputs",
      (brief) => {
        brief.inputs.unexpected = true;
      },
      /inputs contains unknown key: unexpected/,
    ],
    [
      "input reference",
      (brief) => {
        brief.inputs.vacancy.unexpected = true;
      },
      /inputs\.vacancy contains unknown key: unexpected/,
    ],
    [
      "role",
      (brief) => {
        brief.role.unexpected = true;
      },
      /role contains unknown key: unexpected/,
    ],
    [
      "feasibility",
      (brief) => {
        brief.role.feasibility.unexpected = true;
      },
      /role\.feasibility contains unknown key: unexpected/,
    ],
    [
      "work model",
      (brief) => {
        brief.role.feasibility.workModel.unexpected = true;
      },
      /workModel contains unknown key: unexpected/,
    ],
    [
      "company",
      (brief) => {
        brief.company.unexpected = true;
      },
      /company contains unknown key: unexpected/,
    ],
    [
      "challenge evidence",
      (brief) => {
        brief.company.challengeEvidence.unexpected = true;
      },
      /challengeEvidence contains unknown key: unexpected/,
    ],
    [
      "company value",
      (brief) => {
        brief.company.values[0].unexpected = true;
      },
      /company\.values\[0\] contains unknown key: unexpected/,
    ],
    [
      "company hook",
      (brief) => {
        brief.company.tailoringHooks[0].unexpected = true;
      },
      /tailoringHooks\[0\] contains unknown key: unexpected/,
    ],
    [
      "positioning",
      (brief) => {
        brief.positioning.unexpected = true;
      },
      /positioning contains unknown key: unexpected/,
    ],
    [
      "selected lever",
      (brief) => {
        brief.positioning.selectedLevers[0].unexpected = true;
      },
      /selectedLevers\[0\] contains unknown key: unexpected/,
    ],
    [
      "supporting signal",
      (brief) => {
        brief.positioning.supportingSignals[0].unexpected = true;
      },
      /supportingSignals\[0\] contains unknown key: unexpected/,
    ],
    [
      "experience",
      (brief) => {
        brief.experience.unexpected = true;
      },
      /experience contains unknown key: unexpected/,
    ],
    [
      "priority evidence",
      (brief) => {
        brief.experience.priorityEvidence[0].unexpected = true;
      },
      /priorityEvidence\[0\] contains unknown key: unexpected/,
    ],
    [
      "profile pointer",
      (brief) => {
        brief.experience.traits[0].profileSource.unexpected = true;
      },
      /profileSource contains unknown key: unexpected/,
    ],
    [
      "trait",
      (brief) => {
        brief.experience.traits[0].unexpected = true;
      },
      /experience\.traits\[0\] contains unknown key: unexpected/,
    ],
    [
      "gap",
      (brief) => {
        const index =
          brief.experience.gaps.push({
            id: "gap-01",
            requirement: "Synthetic requirement",
            classification: "hard",
            transferableSupport: { status: "none", evidenceIds: [] },
            framing: "Do not claim it.",
            unexpected: true,
          }) - 1;
        return new RegExp(`experience\\.gaps\\[${index}\\] contains unknown key: unexpected`);
      },
      null,
    ],
    [
      "gap support",
      (brief) => {
        brief.experience.gaps.push({
          id: "gap-01",
          requirement: "Synthetic requirement",
          classification: "hard",
          transferableSupport: { status: "none", evidenceIds: [], unexpected: true },
          framing: "Do not claim it.",
        });
      },
      /transferableSupport contains unknown key: unexpected/,
    ],
    [
      "ATS",
      (brief) => {
        brief.ats.unexpected = true;
      },
      /ats contains unknown key: unexpected/,
    ],
    [
      "keyword",
      (brief) => {
        brief.ats.keywords[0].unexpected = true;
      },
      /ats\.keywords\[0\] contains unknown key: unexpected/,
    ],
    [
      "keyword support",
      (brief) => {
        brief.ats.keywords[0].support.unexpected = true;
      },
      /support contains unknown key: unexpected/,
    ],
    [
      "cvPlan alternatives",
      (brief) => {
        brief.cvPlan.alternatives = [];
      },
      /cvPlan contains unknown key: alternatives/,
    ],
    [
      "unknown cvPlan key",
      (brief) => {
        brief.cvPlan.unexpected = true;
      },
      /cvPlan contains unknown key: unexpected/,
    ],
    [
      "header positioning",
      (brief) => {
        brief.cvPlan.headerPositioning.unexpected = true;
      },
      /headerPositioning contains unknown key: unexpected/,
    ],
    [
      "project decision",
      (brief) => {
        brief.cvPlan.projectDecision.unexpected = true;
      },
      /projectDecision contains unknown key: unexpected/,
    ],
    [
      "CV checks",
      (brief) => {
        brief.cvPlan.checks.unexpected = true;
      },
      /cvPlan\.checks contains unknown key: unexpected/,
    ],
    [
      "required evidence check",
      (brief) => {
        brief.cvPlan.checks.requiredEvidence[0].unexpected = true;
      },
      /requiredEvidence\[0\] contains unknown key: unexpected/,
    ],
    [
      "forbidden term",
      (brief) => {
        brief.cvPlan.checks.forbiddenTerms[0].unexpected = true;
      },
      /forbiddenTerms\[0\] contains unknown key: unexpected/,
    ],
    [
      "skill group",
      (brief) => {
        brief.cvPlan.checks.skillGroups[0].unexpected = true;
      },
      /skillGroups\[0\] contains unknown key: unexpected/,
    ],
    [
      "LLM work signal",
      (brief) => {
        brief.cvPlan.llmWorkSignal.unexpected = true;
      },
      /llmWorkSignal contains unknown key: unexpected/,
    ],
    [
      "cover-letter plan",
      (brief) => {
        brief.coverLetterPlan.unexpected = true;
      },
      /coverLetterPlan contains unknown key: unexpected/,
    ],
  ];

  // A mutation that appends to a contract array cannot pin an index the fixture owns, so it
  // returns the exact index-bearing pattern instead of declaring a static one. Dropping the index
  // from such a pin would let it match a neighbouring node and pass for the wrong reason.
  for (const [name, mutate, expected] of cases) {
    await t.test(name, () => {
      const brief = makeValidBrief();
      const pattern = mutate(brief) ?? expected;
      assert.match(validateApplicationBrief(brief).join("\n"), pattern);
    });
  }
});
