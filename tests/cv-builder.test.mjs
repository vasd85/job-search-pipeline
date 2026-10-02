import assert from "node:assert/strict";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  executeBuild as executeBuildWith,
  main,
  pageBudgetFor,
  parseArgs,
} from "../tools/cv-builder/build.mjs";
import {
  candidateConfigValue,
  candidateLanguageNames,
  candidateMarkets,
  loadCandidateConfig,
} from "../tools/candidate/load.mjs";
import { readAndRunCvPreflight, runCvPreflight } from "../tools/cv-builder/preflight.mjs";
import {
  parseCandidateConstraints,
  selectCandidateConstraints,
} from "../tools/candidate/constraints.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The page budget comes from the tracked example and is handed in, the way the CLI hands in the one
// it reads: `executeBuild` never reads a layer, so no case here can reach the operator's.
const examplePageBudget = candidateConfigValue(
  loadCandidateConfig({ root: join(repoRoot, "candidate.example") }).config,
  "cv.page_budget",
);
// The example's markets, which the brief fixture names; the CLI hands in the layer's the same way.
const exampleMarkets = candidateMarkets({ root: join(repoRoot, "candidate.example") });
const executeBuild = (options, dependencies) =>
  executeBuildWith(
    { pageBudget: examplePageBudget, markets: exampleMarkets, ...options },
    dependencies,
  );
const concreteBrief = JSON.parse(
  readFileSync(
    resolve(repoRoot, "tools/application-brief/fixtures/application-brief.v4.valid.json"),
    "utf8",
  ),
);

function makeBrief() {
  return structuredClone(concreteBrief);
}

function makeCv() {
  return {
    header: {
      name: "Candidate Name",
      contact: "UTC+2 | candidate@example.com",
      positioning: "Remote independent contractor available across European business hours.",
    },
    sections: [
      { type: "summary", heading: "Summary", text: "Senior Quality Engineer with TypeScript." },
      {
        type: "bullets",
        heading: "Selected Impact",
        bullets: ["Built a maintainable automation framework."],
      },
      {
        type: "skills",
        heading: "Skills",
        skills: [{ label: "Test Automation", body: "TypeScript Playwright" }],
      },
      {
        type: "experience",
        heading: "Experience",
        roles: [
          {
            company: "Current Company",
            bullets: ["Used LLM-based tools in a commercial QA workflow."],
          },
        ],
      },
    ],
  };
}

function makeBuildCv() {
  const cv = makeCv();
  cv.fileName = "Candidate_CV_Synthetic_Role.docx";
  cv.sections.find((section) => section.type === "experience").roles[0] = {
    company: "Current Company",
    title: "Senior QA Automation Engineer",
    dates: "2020 - Present",
    bullets: ["Used LLM-based tools in a commercial QA workflow."],
  };
  return cv;
}

function createPipelineBuildFixture(t) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "cv-builder-pipeline-"));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));

  const outputRelative = "output/synthetic-company-senior-quality-engineer";
  const outputDir = join(workspaceRoot, outputRelative);
  const stagingParent = join(outputDir, ".pipeline-tmp");
  const stagingDir = join(stagingParent, "pub-test-001");
  mkdirSync(stagingDir, { recursive: true });

  const brief = makeBrief();
  brief.process.outputDir = outputRelative;
  const briefPath = join(outputDir, "application-brief.json");
  writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`);

  const candidate = makeBuildCv();
  const candidatePath = join(stagingDir, "cv.json");
  writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);

  const canonicalCvPath = join(outputDir, "cv.json");
  const canonicalDocxPath = join(outputDir, candidate.fileName);
  writeFileSync(canonicalCvPath, "committed canonical cv source\n");
  writeFileSync(canonicalDocxPath, "committed canonical docx bytes\n");

  return {
    workspaceRoot,
    outputDir,
    stagingDir,
    briefPath,
    candidatePath,
    candidate,
    canonicalCvPath,
    canonicalDocxPath,
    canonicalCvBytes: readFileSync(canonicalCvPath),
    canonicalDocxBytes: readFileSync(canonicalDocxPath),
  };
}

function pipelineOptions(fixture, extra = []) {
  return parseArgs([
    fixture.candidatePath,
    "--brief",
    fixture.briefPath,
    "--pipeline-staging-dir",
    fixture.stagingDir,
    "--workspace-root",
    fixture.workspaceRoot,
    ...extra,
  ]);
}

function syntheticBuildDependencies({ pages = 1, buildError = null } = {}) {
  return {
    renderCv(cvPath) {
      if (buildError) throw new Error(buildError);
      const cv = JSON.parse(readFileSync(cvPath, "utf8"));
      const docxPath = join(dirname(cvPath), cv.fileName);
      writeFileSync(docxPath, "synthetic staged docx bytes\n");
      return docxPath;
    },
    inspectDocx() {
      return ["synthetic structural QA"];
    },
    renderQa(docxPath, qaDir) {
      mkdirSync(qaDir, { recursive: true });
      const qaPdf = join(qaDir, `${basename(docxPath, extname(docxPath))}.pdf`);
      const pageImages = Array.from({ length: pages }, (_, index) =>
        join(qaDir, `page-${index + 1}.png`),
      );
      writeFileSync(qaPdf, "synthetic pdf bytes\n");
      pageImages.forEach((path) => writeFileSync(path, "synthetic png bytes\n"));
      return {
        pdfPath: qaPdf,
        pages,
        pageSize: "612 x 792 pts (letter)",
        pageImages,
      };
    },
  };
}

function assertCanonicalBundleUnchanged(fixture) {
  assert.deepEqual(readFileSync(fixture.canonicalCvPath), fixture.canonicalCvBytes);
  assert.deepEqual(readFileSync(fixture.canonicalDocxPath), fixture.canonicalDocxBytes);
}

test("targeted CV content passes a brief-driven preflight", () => {
  assert.deepEqual(runCvPreflight(makeCv(), makeBrief()).errors, []);
});

test("preflight classifies every failure as a keyed conflict and honors active waivers", () => {
  const cv = makeCv();
  cv.sections.find((section) => section.type === "summary").text =
    "Senior Quality Engineer with Playwright breadth.";
  const strict = runCvPreflight(cv, makeBrief());
  assert.equal(strict.errors.length, 1);
  assert.deepEqual(strict.conflicts, [
    {
      code: "cv_ats_term",
      subject: { kind: "check", key: "cv_ats_term:TypeScript" },
      message: strict.errors[0],
    },
  ]);
  assert.deepEqual(strict.notices, []);

  const waived = runCvPreflight(cv, makeBrief(), {
    waivers: [
      {
        id: "waiver_cv_0001",
        status: "active",
        subject: { kind: "check", key: "cv_ats_term:TypeScript" },
      },
    ],
  });
  assert.deepEqual(waived.errors, [], "a waived finding leaves the hard error stream");
  assert.deepEqual(waived.conflicts, []);
  assert.equal(waived.notices.length, 1);
  assert.equal(waived.notices[0].waiver_id, "waiver_cv_0001");

  const superseded = runCvPreflight(cv, makeBrief(), {
    waivers: [
      {
        id: "waiver_cv_0001",
        status: "superseded",
        subject: { kind: "check", key: "cv_ats_term:TypeScript" },
      },
    ],
  });
  assert.equal(superseded.errors.length, 1, "a superseded waiver no longer downgrades");
});

test("conflict subject keys digest units that would trip the ledger's forbidden-shape rules", () => {
  const cv = makeCv();
  cv.sections.find((section) => section.type === "summary").text +=
    " Details at https://hostile.example.test/docs today.";
  const brief = makeBrief();
  brief.cvPlan.checks.forbiddenTerms.push({
    term: "https://hostile.example.test/docs",
    reason: "URL-shaped term taken verbatim from the JD.",
  });
  const result = runCvPreflight(cv, brief);
  const conflict = result.conflicts.find((entry) => entry.code === "cv_forbidden_term");
  assert.ok(conflict, "the URL-shaped forbidden term fires a conflict");
  assert.match(
    conflict.subject.key,
    /^cv_forbidden_term:sha256:[0-9a-f]{64}$/,
    "a shape-tripping unit is replaced by its digest so the journaled key stays valid",
  );
  const safe = runCvPreflight(
    makeCv(),
    (() => {
      const plain = makeBrief();
      plain.ats.keywords.find((entry) => entry.term === "TypeScript").placements = ["Projects"];
      return plain;
    })(),
  );
  assert.deepEqual(
    safe.conflicts.map((entry) => entry.subject.key),
    ["cv_ats_term:TypeScript"],
    "ordinary units stay literal",
  );
});

test("a build checks a brief in a configured language against the layer's languages", (t) => {
  // The CLI resolves the languages once and hands them to the build, as it does the page budget;
  // the build hands them to the brief validator. Without them only the default language passes.
  const inGreek = () => {
    const fixture = createPipelineBuildFixture(t);
    const brief = JSON.parse(readFileSync(fixture.briefPath, "utf8"));
    brief.role.vacancyLanguage = "Greek";
    writeFileSync(fixture.briefPath, `${JSON.stringify(brief, null, 2)}\n`);
    return fixture;
  };
  const languages = candidateLanguageNames({ root: join(repoRoot, "candidate.example") });
  const summary = executeBuild(
    { ...pipelineOptions(inGreek()), languages },
    syntheticBuildDependencies(),
  );
  assert.equal(summary.status, "valid");
  assert.throws(
    () => executeBuild(pipelineOptions(inGreek()), syntheticBuildDependencies()),
    /role\.vacancyLanguage must be one of: English/u,
  );
});

test("a build checks a version 4 brief's market against the layer's markets", (t) => {
  // Handed in by the CLI beside the languages; without them a brief of the current version names a
  // market the build cannot accept.
  const current = () => {
    const fixture = createPipelineBuildFixture(t);
    const brief = JSON.parse(
      readFileSync(
        resolve(repoRoot, "tools/application-brief/fixtures/application-brief.v4.valid.json"),
        "utf8",
      ),
    );
    brief.process.outputDir = JSON.parse(readFileSync(fixture.briefPath, "utf8")).process.outputDir;
    writeFileSync(fixture.briefPath, `${JSON.stringify(brief, null, 2)}\n`);
    return fixture;
  };
  const markets = exampleMarkets;
  const summary = executeBuild(
    { ...pipelineOptions(current()), markets },
    syntheticBuildDependencies(),
  );
  assert.equal(summary.status, "valid");
  assert.throws(
    () =>
      executeBuild(
        { ...pipelineOptions(current()), markets: undefined },
        syntheticBuildDependencies(),
      ),
    /role\.market must name a configured market: the candidate layer configures none/u,
  );
  // The preflight's own reader takes them the same way.
  const fixture = current();
  assert.equal(
    readAndRunCvPreflight(fixture.candidatePath, fixture.briefPath, { markets }).brief
      .schemaVersion,
    4,
  );
  assert.throws(
    () => readAndRunCvPreflight(fixture.candidatePath, fixture.briefPath),
    /role\.market must name a configured market/u,
  );
});

test("a light revision reads a brief published from an earlier profile path", (t) => {
  // A brief published before the candidate profile moved names the profile at its old path. The
  // revision reads only that brief, structurally, so the move must not make it unreadable. The
  // earlier path is made up: no real path has to be spelt here for the case to hold.
  const fixture = createPipelineBuildFixture(t);
  const earlier = "profiles/earlier-profile.md";
  const brief = JSON.parse(readFileSync(fixture.briefPath, "utf8"));
  brief.inputs.candidateProfile.path = earlier;
  for (const evidence of brief.experience.priorityEvidence) evidence.profileSource.path = earlier;
  for (const trait of brief.experience.traits) trait.profileSource.path = earlier;
  writeFileSync(fixture.briefPath, `${JSON.stringify(brief, null, 2)}\n`);

  const summary = executeBuild(
    pipelineOptions(fixture, ["--revision"]),
    syntheticBuildDependencies(),
  );
  assert.equal(summary.status, "valid");
  assert.equal(summary.revision, true);
});

test("revision mode renders despite brief-coupled findings and reports them in the summary", (t) => {
  const fixture = createPipelineBuildFixture(t);
  const conflicted = makeBuildCv();
  conflicted.sections.find((section) => section.type === "summary").text =
    "Senior Quality Engineer with Playwright breadth.";
  const restageCandidate = () => {
    rmSync(fixture.stagingDir, { recursive: true, force: true });
    mkdirSync(fixture.stagingDir, { recursive: true });
    writeFileSync(fixture.candidatePath, `${JSON.stringify(conflicted, null, 2)}\n`);
  };
  restageCandidate();

  assert.throws(
    () => executeBuild(pipelineOptions(fixture), syntheticBuildDependencies()),
    /CV content preflight failed/,
    "outside revision mode the same edit still aborts before rendering",
  );

  const summary = executeBuild(
    pipelineOptions(fixture, ["--revision"]),
    syntheticBuildDependencies(),
  );
  assert.equal(summary.status, "valid");
  assert.equal(summary.revision, true);
  assert.equal(summary.conflicts.length, 1);
  assert.deepEqual(summary.conflicts[0].subject, {
    kind: "check",
    key: "cv_ats_term:TypeScript",
  });
  assert.deepEqual(summary.notices, []);
  assert.equal(
    existsSync(join(fixture.stagingDir, conflicted.fileName)),
    true,
    "the DOCX is rendered despite the conflicting finding",
  );
  assertCanonicalBundleUnchanged(fixture);

  const waiversPath = join(fixture.workspaceRoot, "revision-waivers.json");
  writeFileSync(
    waiversPath,
    `${JSON.stringify([
      {
        id: "waiver_cv_0001",
        status: "active",
        subject: { kind: "check", key: "cv_ats_term:TypeScript" },
      },
    ])}\n`,
  );
  restageCandidate();
  const waivedSummary = executeBuild(
    pipelineOptions(fixture, ["--revision", "--revision-waivers", waiversPath]),
    syntheticBuildDependencies(),
  );
  assert.deepEqual(waivedSummary.conflicts, []);
  assert.equal(waivedSummary.notices.length, 1);
  assert.equal(waivedSummary.notices[0].waiver_id, "waiver_cv_0001");

  assert.throws(
    () => parseArgs([fixture.candidatePath, "--general", "--revision"]),
    /--revision is only valid for a targeted CV/,
  );
  assert.throws(
    () =>
      parseArgs([
        fixture.candidatePath,
        "--brief",
        fixture.briefPath,
        "--revision-waivers",
        waiversPath,
      ]),
    /--revision-waivers is only valid with --revision/,
  );

  restageCandidate();
  const tooLong = pipelineOptions(fixture, ["--revision"]);
  assert.throws(
    () => executeBuild(tooLong, syntheticBuildDependencies({ pages: 3 })),
    (error) => error.exitCode === 3,
    "the page-budget gate stays hard in revision mode",
  );
});

test("the page gate is the candidate's budget, and a build without one never starts", (t) => {
  assert.equal(examplePageBudget, 2);
  const fixture = createPipelineBuildFixture(t);
  assert.throws(
    () =>
      executeBuildWith(
        { ...pipelineOptions(fixture), markets: exampleMarkets, pageBudget: 1 },
        syntheticBuildDependencies({ pages: 2 }),
      ),
    (error) =>
      error.exitCode === 3 &&
      /CV is 2 pages \(>1\)/.test(error.message) &&
      error.summary.status === "too-long",
  );

  const roomy = createPipelineBuildFixture(t);
  const summary = executeBuildWith(
    { ...pipelineOptions(roomy), markets: exampleMarkets, pageBudget: 3 },
    syntheticBuildDependencies({ pages: 3 }),
  );
  assert.equal(summary.status, "valid");

  // No budget, no build: nothing is rendered, so nothing is left in staging.
  const bare = createPipelineBuildFixture(t);
  let rendered = false;
  assert.throws(
    () =>
      executeBuildWith(pipelineOptions(bare), {
        ...syntheticBuildDependencies(),
        renderCv() {
          rendered = true;
          throw new Error("must not render");
        },
      }),
    /needs the page budget of the candidate config/,
  );
  assert.equal(rendered, false);
});

test("the CLI reads the budget from the workspace's candidate layer and refuses without one", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cv-page-budget-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  assert.throws(() => pageBudgetFor(workspace), /candidate layer: candidate_root_invalid/);
  const layer = join(workspace, "candidate");
  mkdirSync(layer);
  assert.throws(() => pageBudgetFor(workspace), /candidate layer: candidate_config_missing/);
  const config = JSON.parse(readFileSync(join(repoRoot, "candidate.example/config.json"), "utf8"));
  config.cv.page_budget = 3;
  writeFileSync(join(layer, "config.json"), `${JSON.stringify(config)}\n`);
  assert.equal(pageBudgetFor(workspace), 3);
});

test("the CLI hands the layer's languages, markets and page budget to the build", (t) => {
  // Through `main`, not `executeBuild`: the cases above hand the build its values themselves, so
  // they would stay green if the CLI stopped passing one. A Greek version 4 brief passes the real
  // preflight only with both the layer's languages and its markets, and a budget of 3 — not the
  // example's 2 — is visible only against the rendered page count.
  const layered = () => {
    const fixture = createPipelineBuildFixture(t);
    const brief = JSON.parse(
      readFileSync(
        resolve(repoRoot, "tools/application-brief/fixtures/application-brief.v4.valid.json"),
        "utf8",
      ),
    );
    brief.process.outputDir = JSON.parse(readFileSync(fixture.briefPath, "utf8")).process.outputDir;
    brief.role.vacancyLanguage = "Greek";
    writeFileSync(fixture.briefPath, `${JSON.stringify(brief, null, 2)}\n`);
    const config = JSON.parse(
      readFileSync(join(repoRoot, "candidate.example/config.json"), "utf8"),
    );
    config.cv.page_budget = 3;
    mkdirSync(join(fixture.workspaceRoot, "candidate"));
    writeFileSync(
      join(fixture.workspaceRoot, "candidate", "config.json"),
      `${JSON.stringify(config)}\n`,
    );
    return [
      fixture.candidatePath,
      "--brief",
      fixture.briefPath,
      "--pipeline-staging-dir",
      fixture.stagingDir,
      "--workspace-root",
      fixture.workspaceRoot,
    ];
  };
  const printed = t.mock.method(console, "log", () => {});

  main(layered(), syntheticBuildDependencies({ pages: 3 }));
  assert.equal(JSON.parse(printed.mock.calls.at(-1).arguments[0]).status, "valid");

  assert.throws(
    () => main(layered(), syntheticBuildDependencies({ pages: 4 })),
    (error) => error.exitCode === 3 && /^CV is 4 pages \(>3\)\./u.test(error.message),
  );
});

test("persisted schemaVersion 4 brief passes read-and-run preflight integration", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cv-preflight-v4-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cvPath = join(directory, "cv.json");
  const briefPath = join(directory, "application-brief.json");
  writeFileSync(cvPath, `${JSON.stringify(makeCv(), null, 2)}\n`);
  writeFileSync(briefPath, `${JSON.stringify(makeBrief(), null, 2)}\n`);

  const result = readAndRunCvPreflight(cvPath, briefPath, { markets: exampleMarkets });
  assert.equal(result.brief.schemaVersion, 4);
  assert.deepEqual(result.errors, []);
});

test("term matching does not accept substrings inside larger words", async (t) => {
  const cases = [
    ["API", "capital"],
    ["Java", "JavaScript"],
  ];
  for (const [term, largerWord] of cases) {
    await t.test(`${term} is not ${largerWord}`, () => {
      const brief = makeBrief();
      brief.ats.keywords[0].term = term;
      const candidate = makeCv();
      candidate.sections.find((section) => section.type === "summary").text = largerWord;
      assert.match(
        runCvPreflight(candidate, brief).errors.join("\n"),
        new RegExp(`Required ATS term "${term}" missing`),
      );
    });
  }

  await t.test("forbidden AI is not found inside paid", () => {
    const brief = makeBrief();
    brief.cvPlan.checks.forbiddenTerms = [{ term: "AI", reason: "Synthetic boundary guard." }];
    brief.cvPlan.checks.requiredEvidence[1].anyOf = ["paid"];
    const candidate = makeCv();
    candidate.sections.find((section) => section.type === "skills").skills[0].body =
      "TypeScript Playwright paid workflow";
    candidate.sections.find((section) => section.type === "experience").roles[0].bullets = [
      "Used a paid workflow.",
    ];
    assert.doesNotMatch(runCvPreflight(candidate, brief).errors.join("\n"), /Forbidden term "AI"/);
  });
});

test("content preflight catches missing mandatory commercial LLM experience", () => {
  const candidate = makeCv();
  candidate.sections.find((section) => section.type === "experience").roles[0].bullets = [
    "Used a structured QA workflow.",
  ];
  assert.match(
    runCvPreflight(candidate, makeBrief()).errors.join("\n"),
    /commercial-llm-work.*Experience/i,
  );
});

test("Skills grouping policy comes from the brief rather than hard-coded labels", () => {
  const candidate = makeCv();
  candidate.sections
    .find((section) => section.type === "skills")
    .skills.push({
      label: "Miscellaneous Tools",
      body: "Cursor",
    });
  const errors = runCvPreflight(candidate, makeBrief()).errors.join("\n");
  assert.match(errors, /Forbidden Skills group "Miscellaneous Tools"/);
  assert.match(errors, /Forbidden term "Cursor"/);
});

test("preflight enforces the single CV structure decision", () => {
  const brief = makeBrief();
  brief.cvPlan.structure = "chronological";
  assert.match(
    runCvPreflight(makeCv(), brief).errors.join("\n"),
    /chronological.*must not contain.*Selected Impact/i,
  );
});

test("preflight enforces the exact header-positioning decision", () => {
  const brief = makeBrief();
  brief.cvPlan.headerPositioning = {
    mode: "explicit",
    text: "UTC+2 - full overlap with European business hours.",
    rationale: "The role requires a timezone signal.",
  };
  const candidate = makeCv();
  candidate.header.positioning = "A different positioning line.";
  assert.match(runCvPreflight(candidate, brief).errors.join("\n"), /must exactly match/);

  candidate.header.positioning = brief.cvPlan.headerPositioning.text;
  assert.deepEqual(runCvPreflight(candidate, brief).errors, []);
});

test("preflight enforces the selected project decision", () => {
  const brief = makeBrief();
  brief.cvPlan.projectDecision = {
    decision: "include",
    projectId: "project-alpha",
    rationale: "The project proves a role-specific capability.",
  };
  brief.experience.priorityEvidence[0].cvPlacements.push("Projects");
  brief.cvPlan.checks.requiredEvidence.push({
    id: "project-evidence",
    description: "The selected synthetic project appears in Projects.",
    evidenceIds: ["evidence-framework"],
    anyOf: ["project-alpha"],
    placements: ["Projects"],
    placementMode: "all",
  });
  const candidate = makeCv();
  assert.match(runCvPreflight(candidate, brief).errors.join("\n"), /requires a Projects section/);

  candidate.sections.push({
    type: "bullets",
    heading: "Projects",
    bullets: ["project-alpha - verified supporting evidence."],
  });
  assert.deepEqual(runCvPreflight(candidate, brief).errors, []);
});

test("default targeted build behavior still writes DOCX beside cv.json", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cv-builder-default-targeted-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cvPath = join(directory, "cv.json");
  const briefPath = join(directory, "application-brief.json");
  const qaDir = join(directory, "qa");
  writeFileSync(cvPath, `${JSON.stringify(makeBuildCv(), null, 2)}\n`);
  writeFileSync(briefPath, `${JSON.stringify(makeBrief(), null, 2)}\n`);

  const summary = executeBuild(
    parseArgs([cvPath, "--qa-dir", qaDir]),
    syntheticBuildDependencies(),
  );

  assert.equal(summary.mode, "targeted");
  assert.equal(summary.docx, join(directory, makeBuildCv().fileName));
  assert.equal(summary.qaDir, qaDir);
  assert.equal(existsSync(summary.docx), true);
});

test("pipeline mode keeps source, DOCX, and QA inside one fresh staging directory", (t) => {
  const fixture = createPipelineBuildFixture(t);
  const summary = executeBuild(pipelineOptions(fixture), syntheticBuildDependencies());

  assert.equal(summary.mode, "pipeline-staged");
  assert.equal(summary.cvJson, join(fixture.stagingDir, "cv.json"));
  assert.equal(summary.docx, join(fixture.stagingDir, fixture.candidate.fileName));
  assert.equal(summary.qaDir, join(fixture.stagingDir, "qa"));
  assert.equal(summary.qaPdf.startsWith(`${summary.qaDir}/`), true);
  assert.equal(
    summary.pageImages.every((path) => path.startsWith(`${summary.qaDir}/`)),
    true,
  );
  assertCanonicalBundleUnchanged(fixture);
});

test("pipeline validation, build, and QA failures preserve the canonical CV bundle", async (t) => {
  await t.test("content validation failure", (t) => {
    const fixture = createPipelineBuildFixture(t);
    const candidate = JSON.parse(readFileSync(fixture.candidatePath, "utf8"));
    candidate.sections.find((section) => section.type === "skills").skills[0].body = "Playwright";
    writeFileSync(fixture.candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);

    assert.throws(
      () => executeBuild(pipelineOptions(fixture), syntheticBuildDependencies()),
      /CV content preflight failed/,
    );
    assertCanonicalBundleUnchanged(fixture);
  });

  await t.test("DOCX build failure", (t) => {
    const fixture = createPipelineBuildFixture(t);
    assert.throws(
      () =>
        executeBuild(
          pipelineOptions(fixture),
          syntheticBuildDependencies({ buildError: "synthetic renderer failure" }),
        ),
      /synthetic renderer failure/,
    );
    assertCanonicalBundleUnchanged(fixture);
  });

  await t.test("page-count QA failure", (t) => {
    const fixture = createPipelineBuildFixture(t);
    assert.throws(
      () => executeBuild(pipelineOptions(fixture), syntheticBuildDependencies({ pages: 3 })),
      (error) => {
        assert.equal(error.exitCode, 3);
        assert.equal(error.summary.status, "too-long");
        assert.equal(error.summary.docx.startsWith(`${fixture.stagingDir}/`), true);
        return true;
      },
    );
    assertCanonicalBundleUnchanged(fixture);
  });
});

test("a revision rebuild needs its own outputs cleared, and the waiver file kept out of staging", (t) => {
  const fixture = createPipelineBuildFixture(t);
  const first = executeBuild(
    pipelineOptions(fixture, ["--revision"]),
    syntheticBuildDependencies(),
  );
  assert.equal(first.revision, true);

  // The mandatory rebuild of a revision runs into the freshness contract the first build's own
  // outputs broke: the procedure has to name exactly what to remove, and what never to remove.
  assert.throws(
    () => executeBuild(pipelineOptions(fixture, ["--revision"]), syntheticBuildDependencies()),
    /must be fresh and contain only candidate cv\.json/,
    "a rerun into the previous run's directory is refused",
  );
  rmSync(join(fixture.stagingDir, "qa"), { recursive: true, force: true });
  rmSync(join(fixture.stagingDir, fixture.candidate.fileName), { force: true });
  const rebuilt = executeBuild(
    pipelineOptions(fixture, ["--revision"]),
    syntheticBuildDependencies(),
  );
  assert.equal(rebuilt.status, "valid");
  assert.equal(existsSync(join(fixture.stagingDir, fixture.candidate.fileName)), true);

  // ...and the waiver file is one of those extra entries, so it lives outside the staging
  // directory rather than beside the candidate the builder is about to read.
  rmSync(join(fixture.stagingDir, "qa"), { recursive: true, force: true });
  rmSync(join(fixture.stagingDir, fixture.candidate.fileName), { force: true });
  const insideStaging = join(fixture.stagingDir, "revision-waivers.json");
  writeFileSync(insideStaging, "[]\n");
  assert.throws(
    () =>
      executeBuild(
        pipelineOptions(fixture, ["--revision", "--revision-waivers", insideStaging]),
        syntheticBuildDependencies(),
      ),
    /must be fresh and contain only candidate cv\.json/,
  );
  rmSync(insideStaging, { force: true });
  const outsideStaging = join(fixture.workspaceRoot, "revision-waivers.json");
  writeFileSync(outsideStaging, "[]\n");
  assert.equal(
    executeBuild(
      pipelineOptions(fixture, ["--revision", "--revision-waivers", outsideStaging]),
      syntheticBuildDependencies(),
    ).status,
    "valid",
  );
  assertCanonicalBundleUnchanged(fixture);
});

test("pipeline mode rejects reused and symlinked staging directories", async (t) => {
  await t.test("reused directory with an unrelated entry", (t) => {
    const fixture = createPipelineBuildFixture(t);
    writeFileSync(join(fixture.stagingDir, "leftover.tmp"), "old attempt bytes\n");
    assert.throws(
      () => executeBuild(pipelineOptions(fixture), syntheticBuildDependencies()),
      /must be fresh and contain only candidate cv\.json/,
    );
    assertCanonicalBundleUnchanged(fixture);
  });

  await t.test("symlinked publication directory", (t) => {
    const fixture = createPipelineBuildFixture(t);
    const outside = join(fixture.workspaceRoot, "outside-stage");
    mkdirSync(outside);
    writeFileSync(join(outside, "cv.json"), readFileSync(fixture.candidatePath));
    rmSync(fixture.stagingDir, { recursive: true });
    symlinkSync(outside, fixture.stagingDir, "dir");

    assert.throws(
      () => executeBuild(pipelineOptions(fixture), syntheticBuildDependencies()),
      /Pipeline staging directory must not be a symlink/,
    );
    assertCanonicalBundleUnchanged(fixture);
  });

  await t.test("symlinked output root", (t) => {
    const fixture = createPipelineBuildFixture(t);
    const outputRoot = join(fixture.workspaceRoot, "output");
    const relocatedOutputRoot = join(fixture.workspaceRoot, "relocated-output");
    renameSync(outputRoot, relocatedOutputRoot);
    symlinkSync(relocatedOutputRoot, outputRoot, "dir");

    assert.throws(
      () => executeBuild(pipelineOptions(fixture), syntheticBuildDependencies()),
      /Pipeline output root must not be a symlink/,
    );
    assertCanonicalBundleUnchanged(fixture);
  });
});

test("pipeline mode rejects a candidate directory outside the reserved output", (t) => {
  const fixture = createPipelineBuildFixture(t);
  const outsideStage = join(fixture.workspaceRoot, "outside", "pub-test-002");
  mkdirSync(outsideStage, { recursive: true });
  const outsideCv = join(outsideStage, "cv.json");
  writeFileSync(outsideCv, readFileSync(fixture.candidatePath));
  const options = parseArgs([
    outsideCv,
    "--brief",
    fixture.briefPath,
    "--pipeline-staging-dir",
    outsideStage,
    "--workspace-root",
    fixture.workspaceRoot,
  ]);

  assert.throws(
    () => executeBuild(options, syntheticBuildDependencies()),
    /must be \.pipeline-tmp\/<publication-id>/,
  );
  assertCanonicalBundleUnchanged(fixture);
});

test("pipeline mode rejects unsafe output overrides and non-canonical ownership inputs", async (t) => {
  await t.test("unsafe DOCX filename", (t) => {
    const fixture = createPipelineBuildFixture(t);
    const candidate = JSON.parse(readFileSync(fixture.candidatePath, "utf8"));
    candidate.fileName = "../escaped.docx";
    writeFileSync(fixture.candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);

    assert.throws(
      () => executeBuild(pipelineOptions(fixture), syntheticBuildDependencies()),
      /must be a non-hidden \.docx basename/,
    );
    assertCanonicalBundleUnchanged(fixture);
  });

  await t.test("QA directory outside the publication directory", (t) => {
    const fixture = createPipelineBuildFixture(t);
    assert.throws(
      () =>
        executeBuild(
          pipelineOptions(fixture, ["--qa-dir", join(fixture.workspaceRoot, "outside-qa")]),
          syntheticBuildDependencies(),
        ),
      /pipeline QA directory must be/,
    );
    assertCanonicalBundleUnchanged(fixture);
  });

  await t.test("brief copied away from its canonical path", (t) => {
    const fixture = createPipelineBuildFixture(t);
    const copiedBrief = join(fixture.workspaceRoot, "copied-brief.json");
    writeFileSync(copiedBrief, readFileSync(fixture.briefPath));
    const options = parseArgs([
      fixture.candidatePath,
      "--brief",
      copiedBrief,
      "--pipeline-staging-dir",
      fixture.stagingDir,
      "--workspace-root",
      fixture.workspaceRoot,
    ]);

    assert.throws(
      () => executeBuild(options, syntheticBuildDependencies()),
      /requires the canonical application brief/,
    );
    assertCanonicalBundleUnchanged(fixture);
  });

  await t.test("workspace override outside controlled staging mode", () => {
    assert.throws(
      () => parseArgs(["output/example/cv.json", "--workspace-root", repoRoot]),
      /--workspace-root is only valid with --pipeline-staging-dir/,
    );
  });
});

test("renderer and unified builder expose generic pagination and one entrypoint", () => {
  const renderer = readFileSync(resolve(repoRoot, "tools/cv-builder/render.js"), "utf8");
  const shellEntry = readFileSync(resolve(repoRoot, "tools/cv-builder/build.sh"), "utf8");
  const builder = readFileSync(resolve(repoRoot, "tools/cv-builder/build.mjs"), "utf8");
  assert.match(renderer, /keepNext: true/);
  assert.match(renderer, /keepLines: true/);
  assert.match(renderer, /pageBreakBefore: !!r\.pageBreakBefore/);
  // Every run is emitted by the one helper that turns a stated address into a hyperlink, so no
  // paragraph kind can render a link as plain text (backlog task 098).
  assert.match(renderer, /await import\("\.\/cv-links\.mjs"\)/);
  assert.match(renderer, /return linkSegments\(text\)\.map\(/);
  assert.match(renderer, /new ExternalHyperlink\(/);
  assert.match(renderer, /style: "Hyperlink"/);
  assert.equal(
    renderer.match(/new TextRun\(/g)?.length,
    3,
    "TextRun is constructed only inside the link helper",
  );
  assert.match(shellEntry, /build\.mjs/);
  assert.doesNotMatch(shellEntry, /check-length\.sh/);
  assert.match(builder, /qaPdf: rendered\.pdfPath/);
  assert.doesNotMatch(builder, /copyFileSync/);
  assert.match(builder, /--pipeline-staging-dir/);
  assert.match(builder, /resolveLibreOfficeBackend/);
  assert.doesNotMatch(builder, /run\("soffice"/);
  assert.doesNotMatch(builder, /\bHOME:/);
});

// ---------------------------------------------------------------------------
// The candidate layer's constraints on the CV.
//
// The preflight holds no personal policy of its own; constraints arrive as data the caller has
// already read. They return by their own channel, because the branch of the lifecycle that
// publishes a CV reads `errors` only outside a revision, and a personal ban that vanished on
// every re-publication would not be one.

function cvConstraints(entries) {
  return parseCandidateConstraints({ schema_version: 1, constraints: entries });
}

const cvScoped = { materials: ["cv"] };

test("each constraint type refuses a CV through the candidate channel", () => {
  const constraints = cvConstraints([
    {
      id: "no-name",
      type: "forbid_phrases",
      scope: cvScoped,
      phrases: ["Jordan Vale"],
      why: "A private contact asked not to be named.",
    },
    {
      id: "terms",
      type: "prefer_terms",
      scope: cvScoped,
      prefer: "regression suite",
      avoid: ["regression pack"],
      why: "Reviewers in this field call it a suite.",
    },
    {
      id: "spelling",
      type: "required_spellings",
      scope: cvScoped,
      spelling: "Kestrelvale",
      instead_of: ["Kestrelvail"],
      why: "The employer spells its own name this way.",
    },
  ]);
  assert.deepEqual(runCvPreflight(makeCv(), makeBrief(), { constraints }).candidateErrors, []);

  const cv = makeCv();
  cv.sections.find((section) => section.type === "summary").text =
    "Senior Quality Engineer with TypeScript. Jordan Vale referred me; I ran a regression pack at Kestrelvail.";
  const result = runCvPreflight(cv, makeBrief(), { constraints });
  assert.equal(result.candidateErrors.length, 3);
  // The candidate channel is not the brief's: nothing here became a waivable conflict.
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.errors, []);
  const joined = result.candidateErrors.join("\n");
  for (const secret of ["Jordan Vale", "regression pack", "Kestrelvail", "private contact"]) {
    assert.equal(joined.includes(secret), false, secret);
  }
});

test("the CV surface is the whole document, not its prose alone", () => {
  // A banned phrase is caught wherever it sits. The consequence is named in the tool README: a
  // preferred-term entry whose avoided wording also appears in a verbatim historical title will
  // fire, and such an entry is scoped to the letter instead.
  const constraints = cvConstraints([
    {
      id: "no-employer",
      type: "forbid_phrases",
      scope: cvScoped,
      phrases: ["Current Company"],
      why: "An employer this search does not name.",
    },
  ]);
  const result = runCvPreflight(makeCv(), makeBrief(), { constraints });
  assert.equal(result.candidateErrors.length, 1);
  assert.match(result.candidateErrors[0], /cv\.json breaks candidate constraint "no-employer"/u);
});

test("no waiver lifts a candidate constraint on the CV", () => {
  const constraints = cvConstraints([
    {
      id: "no-name",
      type: "forbid_phrases",
      scope: cvScoped,
      phrases: ["Candidate Name"],
      why: "A name this material does not carry.",
    },
  ]);
  const waivers = [
    { id: "w1", status: "active", subject: { kind: "check", key: "candidate_constraint:no-name" } },
    { id: "w2", status: "active", subject: { kind: "decision", key: "no-name" } },
  ];
  const result = runCvPreflight(makeCv(), makeBrief(), { constraints, waivers });
  assert.equal(result.candidateErrors.length, 1);
  assert.deepEqual(result.notices, []);
});

test("a constraint scoped to the letter does not touch the CV", () => {
  const constraints = cvConstraints([
    {
      id: "letter-only",
      type: "forbid_phrases",
      scope: { materials: ["cover_letter"] },
      phrases: ["Candidate Name"],
      why: "Only the letter is bound by this one.",
    },
  ]);
  const selected = selectCandidateConstraints(constraints, { material: "cv" });
  assert.deepEqual([...selected], []);
  assert.deepEqual(
    runCvPreflight(makeCv(), makeBrief(), { constraints: selected }).candidateErrors,
    [],
  );
});

test("the preflight CLI reads the layer and exits non-zero on a constraint", (t) => {
  // The author's own dry run of what the publication gate will do. Without it the CV renders
  // green and the publication refuses, which is the worst order to learn in.
  const root = mkdtempSync(join(tmpdir(), "cv-builder-candidate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const layer = join(root, "candidate");
  const plainLayer = join(root, "plain");
  // The dry run checks the brief's language and market against the layer's config, so the layer
  // carries one, and it reads the bans the profile derives, so the layer carries its profile too.
  for (const directory of [layer, plainLayer]) {
    mkdirSync(directory);
    copyFileSync(
      join(repoRoot, "candidate.example", "config.json"),
      join(directory, "config.json"),
    );
    copyFileSync(join(repoRoot, "candidate.example", "profile.md"), join(directory, "profile.md"));
  }
  writeFileSync(
    join(layer, "constraints.json"),
    JSON.stringify({
      schema_version: 1,
      constraints: [
        {
          id: "no-name",
          type: "forbid_phrases",
          scope: { materials: ["cv"] },
          phrases: ["Candidate Name"],
          why: "A name this material does not carry.",
        },
      ],
    }),
    "utf8",
  );
  const cvPath = join(root, "cv.json");
  const briefPath = join(root, "application-brief.json");
  writeFileSync(cvPath, JSON.stringify(makeCv()), "utf8");
  writeFileSync(briefPath, JSON.stringify(makeBrief()), "utf8");
  const cli = (args) =>
    spawnSync(
      process.execPath,
      [join(repoRoot, "tools/cv-builder/preflight.mjs"), cvPath, briefPath, ...args],
      { encoding: "utf8" },
    );

  const withoutConstraint = cli(["--candidate-root", plainLayer]);
  assert.equal(withoutConstraint.status, 0, withoutConstraint.stderr);
  assert.match(withoutConstraint.stdout, /"status": "valid"/u);

  const withLayer = cli(["--candidate-root", layer]);
  assert.equal(withLayer.status, 1);
  assert.match(withLayer.stderr, /CV content breaks the candidate layer/u);
  assert.equal(withLayer.stdout.includes('"status": "valid"'), false);
});

// Task 158. The example's Projects entry names a project of the example profile: a public one by its
// real name passes the dry run, a private one's name refuses it, whatever the brief chose. The
// layer is the tracked example copied whole, so the bans come from its profile and nowhere else.
test("the preflight CLI refuses a private project's name and passes a public one's", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cv-builder-visibility-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const layer = join(root, "candidate");
  cpSync(join(repoRoot, "candidate.example"), layer, { recursive: true });
  const run = (projectId) => {
    const brief = makeBrief();
    brief.cvPlan.projectDecision = {
      decision: "include",
      projectId,
      rationale: "The project proves a role-specific capability.",
    };
    brief.experience.priorityEvidence[0].cvPlacements.push("Projects");
    brief.cvPlan.checks.requiredEvidence.push({
      id: "project-evidence",
      description: "The selected project appears in Projects.",
      evidenceIds: ["evidence-framework"],
      anyOf: [projectId],
      placements: ["Projects"],
      placementMode: "all",
    });
    const cv = makeCv();
    cv.sections.push({
      type: "bullets",
      heading: "Projects",
      bullets: [`${projectId} - a benchmark harness.`],
    });
    const cvPath = join(root, `${projectId}-cv.json`);
    const briefPath = join(root, `${projectId}-brief.json`);
    writeFileSync(cvPath, JSON.stringify(cv), "utf8");
    writeFileSync(briefPath, JSON.stringify(brief), "utf8");
    return spawnSync(
      process.execPath,
      [
        join(repoRoot, "tools/cv-builder/preflight.mjs"),
        cvPath,
        briefPath,
        "--candidate-root",
        layer,
      ],
      { encoding: "utf8" },
    );
  };

  const publicProject = run("lindenbench");
  assert.equal(publicProject.status, 0, publicProject.stderr);
  assert.match(publicProject.stdout, /"status": "valid"/u);

  const privateProject = run("quiet-ledger");
  assert.equal(privateProject.status, 1);
  assert.match(privateProject.stderr, /CV content breaks the candidate layer/u);
  assert.match(privateProject.stderr, /"private-project-10-2" \(forbid_phrases\)/u);
  assert.equal(privateProject.stderr.includes("quiet-ledger"), false);
});
