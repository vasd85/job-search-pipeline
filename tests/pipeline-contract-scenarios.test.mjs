import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  containsWholeTerm,
  readAndValidateApplicationBrief,
} from "../tools/application-brief/validate.mjs";
import { candidateLanguageNames, candidateMarkets } from "../tools/candidate/load.mjs";
import {
  coverLetterLanguagesFor,
  coverLetterLimitsFor,
  validateCoverLetter,
} from "../tools/cover-letter/validate.mjs";
import { readAndRunCvPreflight } from "../tools/cv-builder/preflight.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// From the tracked example, never from `candidate/` of the working tree: the suite reads no real
// layer. The example configures Greek beside the default language.
const exampleRoot = join(repoRoot, "candidate.example");
const exampleLanguageNames = candidateLanguageNames({ root: exampleRoot });
const exampleMarkets = candidateMarkets({ root: exampleRoot });
const baseBrief = JSON.parse(readFileSync(
  resolve(repoRoot, "tools/application-brief/fixtures/application-brief.v4.valid.json"),
  "utf8",
));

function makeAiInternationalBrief() {
  const brief = structuredClone(baseBrief);
  brief.process.id = "00000000-0000-4000-8000-000000000101";
  brief.process.outputDir = "output/synthetic-ai-international";
  brief.role.company = "Synthetic AI Labs";
  brief.role.title = "Senior Quality Engineer";
  brief.role.vacancyLanguage = "English";
  brief.role.market = exampleMarkets.outsideHome.name;
  brief.positioning.aiRegister = "relevance-link";
  brief.positioning.supportingSignals[0] = {
    id: "ai-assisted-qa",
    topic: "AI-assisted QA with project continuity",
    decision: "include",
    evidence: "Applied an AI-assisted QA workflow and linked it to synthetic-agentic-project.",
    claimIds: ["C07"],
    sourceIds: ["S10"],
    constraints: ["Keep commercial practice and personal-project evidence explicitly distinct."],
    cvEvidenceCheckId: "selected-project-evidence",
  };
  brief.cvPlan.headerPositioning = {
    mode: "explicit",
    text: "Remote independent contractor available across European business hours.",
    rationale: "The scenario outside the home market requires an explicit feasibility line.",
  };
  brief.cvPlan.projectDecision = {
    decision: "include",
    projectId: "synthetic-agentic-project",
    rationale: "The AI-relevant scenario uses one selected supporting project.",
  };
  brief.experience.priorityEvidence[0].cvPlacements.push("Projects");
  brief.cvPlan.checks.requiredEvidence.push({
    id: "selected-project-evidence",
    description: "The selected project is present in Projects.",
    evidenceIds: ["evidence-framework"],
    anyOf: ["synthetic-agentic-project"],
    placements: ["Projects"],
    placementMode: "all",
  });
  return brief;
}

function makeNonAiGreekBrief() {
  const brief = structuredClone(baseBrief);
  brief.process.id = "00000000-0000-4000-8000-000000000102";
  brief.process.outputDir = "output/synthetic-greek-non-ai";
  brief.role.company = "Συνθετική εταιρεία";
  brief.role.title = "Μηχανικός αυτοματισμού δοκιμών";
  brief.role.vacancyLanguage = "Greek";
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
  brief.positioning.supportingSignals[0] = {
    id: "ai-assisted-qa",
    topic: "AI/LLM relevance decision",
    decision: "exclude",
    evidence: "The synthetic Greek vacancy contains no role-relevant AI signal.",
    claimIds: [],
    sourceIds: [],
    constraints: ["Do not introduce AI content."],
  };
  brief.cvPlan.structure = "chronological";
  brief.cvPlan.headerPositioning = {
    mode: "omit",
    text: null,
    rationale: "Positioning on the home market is intentionally omitted.",
  };
  brief.cvPlan.projectDecision = {
    decision: "exclude",
    projectId: null,
    rationale: "Commercial evidence is sufficient for the non-AI scenario.",
  };
  brief.experience.priorityEvidence[0].cvPlacements = [
    "Summary",
    "Skills",
    "Experience:Current Company",
  ];
  brief.experience.priorityEvidence[0].claim = "Έχτισα ένα συντηρήσιμο πλαίσιο αυτοματισμού για την ομάδα προϊόντος.";
  brief.experience.priorityEvidence[0].proof = ["Πέτυχα μετρήσιμο αποτέλεσμα και αξιόπιστο σήμα ανατροφοδότησης."];
  brief.ats.keywords.forEach((keyword) => {
    keyword.placements = keyword.placements.map((placement) => (
      placement === "Selected Impact" ? "Experience:Current Company" : placement
    ));
  });
  const greekTerms = ["αυτοματισμός δοκιμών", "δοκιμές API", "στρατηγική δοκιμών"];
  greekTerms.forEach((term, index) => {
    brief.ats.keywords[index + 2].term = term;
    brief.ats.keywords[index + 2].expanded = term;
  });
  brief.coverLetterPlan.keywordTerms = greekTerms;
  const primaryLeverCheck = brief.cvPlan.checks.requiredEvidence
    .find((check) => check.id === "primary-lever-evidence");
  Object.assign(primaryLeverCheck, {
    description: "The selected lever is present in the first relevant Experience entry.",
    placements: ["Experience:Current Company"],
  });
  return brief;
}

function phrasesForPlacement(brief, placement) {
  return brief.cvPlan.checks.requiredEvidence
    .filter((check) => check.placements.includes(placement))
    .map((check) => check.anyOf[0]);
}

function requiredTermsForPlacement(brief, placement) {
  return brief.ats.keywords
    .filter((keyword) => keyword.required && keyword.placements.includes(placement))
    .map((keyword) => keyword.term);
}

// This deterministic consumer deliberately accepts only the persisted brief. It proves that all
// role-specific CV choices needed by preflight survive the Step 3 handoff.
function authorCvFromBrief(brief) {
  const summaryText = requiredTermsForPlacement(brief, "Summary").join(" ");
  const skillsText = [
    ...brief.cvPlan.checks.skillGroups.flatMap((group) => group.mustContain),
    ...requiredTermsForPlacement(brief, "Skills"),
    ...phrasesForPlacement(brief, "Skills"),
  ].join(" ");
  const experiencePlacement = "Experience:Current Company";
  const experienceText = [
    ...requiredTermsForPlacement(brief, "Experience"),
    ...requiredTermsForPlacement(brief, experiencePlacement),
    ...phrasesForPlacement(brief, "Experience"),
    ...phrasesForPlacement(brief, experiencePlacement),
  ].join(" ");
  const sections = [{ type: "summary", heading: "Summary", text: summaryText }];

  if (brief.cvPlan.structure === "hybrid") {
    sections.push({
      type: "bullets",
      heading: "Selected Impact",
      bullets: phrasesForPlacement(brief, "Selected Impact"),
    });
  }

  sections.push(
    {
      type: "skills",
      heading: "Skills",
      skills: brief.cvPlan.checks.skillGroups.map((group, index) => ({
        label: group.label,
        body: index === 0 ? skillsText : group.mustContain.join(" "),
      })),
    },
    {
      type: "experience",
      heading: "Experience",
      roles: [{ company: "Current Company", bullets: [experienceText] }],
    },
  );

  if (brief.cvPlan.projectDecision.decision === "include") {
    sections.push({
      type: "bullets",
      heading: "Projects",
      bullets: [
        brief.cvPlan.projectDecision.projectId,
        ...phrasesForPlacement(brief, "Projects"),
      ],
    });
  }

  return {
    header: {
      name: "Synthetic Candidate",
      contact: "candidate@example.test",
      ...(brief.cvPlan.headerPositioning.mode === "explicit"
        ? { positioning: brief.cvPlan.headerPositioning.text }
        : {}),
    },
    sections,
  };
}

// Cover-letter prose is synthetic; the assertions test the persisted selection contract rather
// than editorial style, which remains the playbook's responsibility.
function authorCoverLetterFromBrief(brief) {
  const evidence = brief.coverLetterPlan.evidenceIds.map((id) => (
    brief.experience.priorityEvidence.find((entry) => entry.id === id)
  ));
  const evidenceText = evidence.map((entry) => `${entry.claim} ${entry.proof.join(" ")}`).join(" ");
  const keywordText = brief.coverLetterPlan.keywordTerms.join(", ");
  const aiEvidence = brief.positioning.supportingSignals
    .filter((signal) => signal.decision === "include")
    .map((signal) => signal.evidence)
    .join(" ");
  const greek = brief.role.vacancyLanguage === "Greek";
  const title = greek
    ? `Αξιόπιστη μηχανική ποιότητας για την ${brief.role.company}`
    : `Reliable Quality Engineering for ${brief.role.company}`;
  const paragraphs = greek
    ? [
        "Η αξιόπιστη ανατροφοδότηση βοηθά την ομάδα προϊόντος να παίρνει συνειδητές αποφάσεις έγκαιρα.",
        `Η σχετική εμπειρία μου είναι συγκεκριμένη: ${evidenceText}`,
        `Οι απαιτήσεις του ρόλου ανήκουν φυσικά σε αυτή τη δουλειά: ${keywordText}. Συνδέω τον αυτοματισμό, τη διερεύνηση κινδύνων και τη σαφή επικοινωνία με ένα ορατό αποτέλεσμα.`,
        "Θα φέρω στην ομάδα ήρεμη μηχανική κρίση, διαφανείς ελέγχους και σταθερή προσοχή στην ποιότητα της ανατροφοδότησης.",
      ]
    : [
        "Reliable feedback helps a product team make deliberate decisions while useful change remains inexpensive.",
        `My relevant experience is specific: ${evidenceText}`,
        `The role terms belong naturally in that work: ${keywordText}. I connect automation, risk exploration, and clear communication to an observable result. ${aiEvidence}`.trim(),
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
  assert.equal(countWords(), 240, "synthetic letter must meet its exact word target");
  const signature = exampleLetterLanguages.find((language) => language.name === brief.role.vacancyLanguage).signature;
  return `${title}\n\n${paragraphs.join("\n\n")}\n\n${signature}\n`;
}

const exampleLetterLimits = coverLetterLimitsFor({ root: exampleRoot });
const exampleLetterLanguages = coverLetterLanguagesFor({ root: exampleRoot });

function assertCoverLetterContract(letter, brief) {
  assert.deepEqual(
    validateCoverLetter(new TextEncoder().encode(letter), brief, {
      languages: exampleLetterLanguages,
      limits: exampleLetterLimits,
    }),
    [],
  );
  const firstLine = letter.split("\n", 1)[0];
  assert.ok(firstLine.length > 0);
  assert.doesNotMatch(firstLine, /^\s*(?:#|\*|-)/, "plain-text title must not use Markdown");
  assert.ok(brief.coverLetterPlan.evidenceIds.length >= 1 && brief.coverLetterPlan.evidenceIds.length <= 2);
  assert.ok(brief.coverLetterPlan.keywordTerms.length >= 3 && brief.coverLetterPlan.keywordTerms.length <= 5);

  for (const evidenceId of brief.coverLetterPlan.evidenceIds) {
    const evidence = brief.experience.priorityEvidence.find((entry) => entry.id === evidenceId);
    assert.ok(evidence, `missing selected evidence ${evidenceId}`);
    assert.ok(letter.includes(evidence.claim), `letter omitted selected evidence ${evidenceId}`);
  }
  for (const term of brief.coverLetterPlan.keywordTerms) {
    assert.ok(containsWholeTerm(letter, term), `letter omitted selected keyword ${term}`);
  }

  const includedSignals = brief.positioning.supportingSignals.filter((signal) => signal.decision === "include");
  if (brief.positioning.aiRegister === "work-only") {
    assert.equal(includedSignals.length, 0);
    assert.doesNotMatch(letter, /AI-assisted/i);
  } else {
    assert.ok(includedSignals.length > 0, "included AI register requires a supporting signal");
    for (const signal of includedSignals) {
      assert.ok(letter.includes(signal.evidence), `letter omitted supporting signal ${signal.id}`);
    }
  }

  if (brief.role.vacancyLanguage === "Greek") {
    assert.match(letter, /\p{Script=Greek}/u);
    const proseWithoutSelectedTerms = brief.coverLetterPlan.keywordTerms
      .reduce((text, term) => text.replaceAll(term, ""), letter);
    assert.doesNotMatch(
      proseWithoutSelectedTerms,
      /[A-Za-z]/,
      "Greek cover letter contains untranslated Latin prose outside selected technical terms",
    );
  }
  if (brief.role.vacancyLanguage === "English") assert.doesNotMatch(letter, /\p{Script=Greek}/u);
}

for (const scenario of [
  ["AI-relevant international application", makeAiInternationalBrief],
  ["non-AI Greek application", makeNonAiGreekBrief],
]) {
  test(`persisted Step 3 -> CV -> cover letter: ${scenario[0]}`, (t) => {
    const brief = scenario[1]();
    const runRoot = mkdtempSync(join(tmpdir(), "pipeline-contract-e2e-"));
    t.after(() => rmSync(runRoot, { recursive: true, force: true }));
    const outputDirectory = join(runRoot, brief.process.outputDir);
    mkdirSync(outputDirectory, { recursive: true });

    const briefPath = join(outputDirectory, "application-brief.json");
    const cvPath = join(outputDirectory, "cv.json");
    const coverLetterPath = join(outputDirectory, "cover-letter.txt");
    writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`);

    const persistedBrief = readAndValidateApplicationBrief(briefPath, {
      languages: exampleLanguageNames,
      markets: exampleMarkets,
    });
    const cv = authorCvFromBrief(persistedBrief);
    writeFileSync(cvPath, `${JSON.stringify(cv, null, 2)}\n`);
    assert.deepEqual(readAndRunCvPreflight(cvPath, briefPath, {
      languages: exampleLanguageNames,
      markets: exampleMarkets,
    }).errors, []);

    const coverLetter = authorCoverLetterFromBrief(persistedBrief);
    writeFileSync(coverLetterPath, coverLetter);
    assertCoverLetterContract(readFileSync(coverLetterPath, "utf8"), persistedBrief);

    const projects = cv.sections.find((section) => section.heading === "Projects");
    assert.equal(Boolean(projects), persistedBrief.cvPlan.projectDecision.decision === "include");
    assert.equal(
      cv.header.positioning ?? null,
      persistedBrief.cvPlan.headerPositioning.mode === "explicit"
        ? persistedBrief.cvPlan.headerPositioning.text
        : null,
    );
    assert.doesNotMatch(JSON.stringify(cv), /\p{Script=Greek}/u, "targeted CV must remain in the default language");
    assert.ok(containsWholeTerm(JSON.stringify(cv), "LLM"), "every targeted CV must contain commercial LLM work evidence");
  });
}
