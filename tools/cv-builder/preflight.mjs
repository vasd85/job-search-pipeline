#!/usr/bin/env node

/*
 * Enforce the role-specific editorial decisions stored by map-experience before layout starts.
 * This module deliberately hard-codes no candidate-, company-, or label-specific policy: required
 * wording, exclusions, placements, and Skills group constraints all come from the application
 * brief, and the standing personal constraints of the candidate layer arrive the same way, as
 * `constraints` the caller has already read. Nothing personal is written here.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { containsWholeTerm, readAndValidateApplicationBrief } from "../application-brief/validate.mjs";
import { candidateConstraintFindings, candidateConstraintsFor } from "../candidate/constraints.mjs";
import { candidateLanguageNames, candidateMarkets } from "../candidate/load.mjs";
import { processLogDiagnosticProblems } from "../lib/process-log-diagnostics.mjs";

function flattenText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenText).join(" ");
  if (value && typeof value === "object") return Object.values(value).map(flattenText).join(" ");
  return "";
}

function normalize(value) {
  return flattenText(value).toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

function includesTerm(value, term) {
  return containsWholeTerm(flattenText(value), term);
}

function findSection(cv, heading) {
  const expected = normalize(heading);
  return (cv.sections || []).find((section) => normalize(section.heading) === expected) ?? null;
}

// Placements form a small contract language shared with application-brief.json. A check can target
// a standard section, all Experience, one exact employer entry, or the complete CV.
function placementText(cv, placement) {
  if (normalize(placement) === "any") return flattenText(cv);
  const [kind, detail] = placement.split(":", 2);
  if (normalize(kind) === "experience" && detail) {
    const experience = (cv.sections || []).find((section) => section.type === "experience");
    const role = (experience?.roles || []).find((entry) => normalize(entry.company) === normalize(detail));
    return role ? flattenText(role) : "";
  }
  if (normalize(kind) === "experience") {
    return flattenText((cv.sections || []).find((section) => section.type === "experience") ?? "");
  }
  return flattenText(findSection(cv, kind) ?? "");
}

// "any" supports wording alternatives and flexible placement; "all" protects evidence that must
// survive in several recruiter-visible locations after editing.
function placementsPass(cv, placements, mode, predicate) {
  const results = placements.map((placement) => ({
    placement,
    passes: predicate(placementText(cv, placement)),
  }));
  return {
    passes: mode === "all" ? results.every((result) => result.passes) : results.some((result) => result.passes),
    results,
  };
}

/*
 * A conflict subject key addresses one brief decision unit (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#3-conflicts-and-waivers): `<family>` alone for
 * the three structural decisions, `<family>:<unit>` for term/id/label checks. The composed key
 * must survive the ledger's bounded-text rules — including the frozen forbidden-shape detector
 * that waiver subjects are validated with — so an oversized, multi-line, or shape-tripping unit
 * (for example a URL-shaped ATS term taken verbatim from a JD) is replaced by its digest. The
 * same composed key is what the user waives, so the substitution stays consistent end to end.
 */
function conflictSubjectKey(code, unit) {
  if (unit === null) return code;
  const text = String(unit).trim();
  const candidate = `${code}:${text}`;
  if (
    text.length > 0
    && Buffer.byteLength(text, "utf8") <= 200
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(text)
    && processLogDiagnosticProblems({ code: "waiver", details: [candidate] }, "conflict").length === 0
  ) {
    return candidate;
  }
  return `${code}:sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function matchWaiver(waivers, subject) {
  return waivers.find((waiver) =>
    waiver?.status === "active"
    && waiver?.subject?.kind === subject.kind
    && waiver?.subject?.key === subject.key) ?? null;
}

/**
 * Compare authored CV content with the decisions made in Step 3. Return every issue in one pass so
 * the author can correct content once before paying the cost of DOCX rendering and visual QA.
 *
 * Every deterministic check here is brief-coupled, so each failure is also returned as a
 * classified conflict; an active waiver on a conflict's exact subject downgrades it to a notice
 * naming the waiver id and removes it from `errors` (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#3-conflicts-and-waivers).
 */
export function runCvPreflight(cv, brief, { constraints = [], waivers = [] } = {}) {
  const errors = [];
  const warnings = [];
  const conflicts = [];
  const notices = [];
  // Candidate-layer findings are returned separately and are never waivable: a conflict does not
  // block a revision publication (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#3-conflicts-and-waivers), and this branch of the lifecycle reads `errors`
  // only outside a revision, so a personal ban placed there would vanish on every re-publication.
  // The surface is the whole flattened CV, the same one the brief's own exclusions are matched
  // against, so a banned phrase is caught wherever it sits, including a header or a company name.
  const candidateErrors = candidateConstraintFindings(constraints, flattenText(cv), {
    artifact: "cv.json",
  });
  const findConflict = (code, unit, message) => {
    const finding = {
      code,
      subject: { kind: "check", key: conflictSubjectKey(code, unit) },
      message,
    };
    const waiver = matchWaiver(waivers, finding.subject);
    if (waiver) {
      notices.push({ ...finding, waiver_id: waiver.id });
    } else {
      errors.push(message);
      conflicts.push(finding);
    }
  };
  const checks = brief.cvPlan.checks;

  const skills = (cv.sections || []).find((section) => section.type === "skills");
  const skillEntries = skills?.skills || [];

  // Structure, header positioning, and project inclusion are application decisions made while raw
  // vacancy/company context is available. Enforce them here so CV generation never re-derives them.
  const selectedImpact = findSection(cv, "Selected Impact");
  if (brief.cvPlan.structure === "hybrid" && !selectedImpact) {
    findConflict("cv_structure", null, "cvPlan.structure hybrid requires a Selected Impact section.");
  }
  if (brief.cvPlan.structure === "chronological" && selectedImpact) {
    findConflict("cv_structure", null, "cvPlan.structure chronological must not contain a Selected Impact section.");
  }

  const authoredPositioning = cv.header?.positioning;
  const headerPlan = brief.cvPlan.headerPositioning;
  if (headerPlan.mode === "omit" && normalize(authoredPositioning)) {
    findConflict("cv_header_positioning", null, "cvPlan.headerPositioning mode omit requires the CV header positioning line to be absent.");
  }
  if (headerPlan.mode === "explicit" && authoredPositioning !== headerPlan.text) {
    findConflict("cv_header_positioning", null, `CV header positioning must exactly match cvPlan.headerPositioning.text: "${headerPlan.text}"`);
  }

  const projects = findSection(cv, "Projects");
  const projectPlan = brief.cvPlan.projectDecision;
  if (projectPlan.decision === "exclude" && projects) {
    findConflict("cv_project_decision", null, "cvPlan.projectDecision exclude requires the Projects section to be absent.");
  }
  if (projectPlan.decision === "include") {
    if (!projects) {
      findConflict("cv_project_decision", null, `cvPlan.projectDecision include requires a Projects section containing "${projectPlan.projectId}".`);
    } else if (!includesTerm(projects, projectPlan.projectId)) {
      findConflict("cv_project_decision", null, `Projects section must contain the selected project "${projectPlan.projectId}".`);
    }
  }

  // Required ATS terms are checked only where Step 3 decided they should appear. This avoids both
  // keyword stuffing and accidental loss of a high-value exact match during later compression.
  for (const keyword of brief.ats.keywords.filter((entry) => entry.required)) {
    const outcome = placementsPass(
      cv,
      keyword.placements,
      keyword.placementMode,
      (text) => includesTerm(text, keyword.term),
    );
    if (!outcome.passes) {
      const missing = outcome.results.filter((result) => !result.passes).map((result) => result.placement);
      findConflict("cv_ats_term", keyword.term, `Required ATS term "${keyword.term}" missing for placement mode ${keyword.placementMode}: ${missing.join(", ")}`);
    }
  }

  // Evidence checks connect selected levers and supporting signals to concrete CV wording. They are
  // stronger than a global substring check because the intended recruiter-facing placement matters.
  for (const check of checks.requiredEvidence) {
    const outcome = placementsPass(
      cv,
      check.placements,
      check.placementMode,
      (text) => check.anyOf.some((term) => includesTerm(text, term)),
    );
    if (!outcome.passes) {
      const missing = outcome.results.filter((result) => !result.passes).map((result) => result.placement);
      findConflict("cv_required_evidence", check.id, `Required evidence "${check.id}" missing (${check.anyOf.join(" OR ")}) in: ${missing.join(", ")}`);
    }
  }

  // Exclusions are role-specific honesty and relevance gates assembled by map-experience.
  for (const forbidden of checks.forbiddenTerms) {
    if (includesTerm(cv, forbidden.term)) {
      findConflict("cv_forbidden_term", forbidden.term, `Forbidden term "${forbidden.term}" found: ${forbidden.reason}`);
    }
  }

  // Skills taxonomy is data-driven: the brief defines stable capability groups and, when useful,
  // labels whose content must be consolidated rather than emitted as ad hoc overflow categories.
  for (const group of checks.skillGroups) {
    const entry = skillEntries.find((candidate) => normalize(candidate.label) === normalize(group.label));
    if (!entry) {
      findConflict("cv_skill_group", group.label, `Required Skills group "${group.label}" is missing.`);
      continue;
    }
    for (const term of group.mustContain) {
      if (!includesTerm(entry.body, term)) {
        findConflict("cv_skill_group", group.label, `Skills group "${group.label}" must contain "${term}".`);
      }
    }
    for (const label of group.forbiddenLabels) {
      if (skillEntries.some((candidate) => normalize(candidate.label) === normalize(label))) {
        findConflict("cv_skill_group", group.label, `Forbidden Skills group "${label}" found; merge its content into "${group.label}".`);
      }
    }
  }

  const optionalKeywords = brief.ats.keywords.filter((entry) => !entry.required);
  const absentOptional = optionalKeywords.filter((keyword) => !includesTerm(cv, keyword.term)).map((keyword) => keyword.term);
  if (absentOptional.length) warnings.push(`Optional ATS terms not used: ${absentOptional.join(", ")}`);

  return { candidateErrors, errors, warnings, conflicts, notices };
}

/*
 * `languages` is the set the brief's vacancy language is checked against — the names of the
 * candidate layer's languages — and `markets` the two markets its market is checked against.
 * Without them only the default language is accepted and no market, so a caller that forgets
 * either refuses a brief rather than passing one.
 */
export function readAndRunCvPreflight(cvPath, briefPath, { languages, markets, ...options } = {}) {
  const cv = JSON.parse(readFileSync(cvPath, "utf8"));
  const brief = readAndValidateApplicationBrief(briefPath, { languages, markets });
  return { cv, brief, ...runCvPreflight(cv, brief, options) };
}

function main() {
  const [cvPath, briefPath, ...extra] = process.argv.slice(2);
  const usage =
    "Usage: node tools/cv-builder/preflight.mjs <cv.json> <application-brief.json> [--revision] [--waivers <waivers.json>] [--candidate-root <absolute path>]\n"
    + "Without --candidate-root the brief is checked against the default language alone.";
  if (!cvPath || !briefPath) throw new Error(usage);
  let revision = false;
  let waiversPath = null;
  let candidateRoot = null;
  for (let index = 0; index < extra.length;) {
    if (extra[index] === "--revision") {
      revision = true;
      index += 1;
    } else if (extra[index] === "--waivers") {
      waiversPath = extra[index + 1];
      if (!waiversPath || waiversPath.startsWith("--")) throw new Error(usage);
      index += 2;
    } else if (extra[index] === "--candidate-root") {
      candidateRoot = extra[index + 1];
      if (!candidateRoot || candidateRoot.startsWith("--")) throw new Error(usage);
      index += 2;
    } else {
      throw new Error(usage);
    }
  }
  if (waiversPath !== null && !revision) throw new Error(usage);
  const waivers = waiversPath === null
    ? []
    : JSON.parse(readFileSync(waiversPath, "utf8"));
  // Reading the layer is the author's own dry run of what the publication gate will do. Without
  // it the CV renders green and the publication refuses, which is the worst order to learn in.
  const constraints = candidateRoot === null
    ? []
    : candidateConstraintsFor({ material: "cv", root: candidateRoot });
  const languages = candidateRoot === null ? undefined : candidateLanguageNames({ root: candidateRoot });
  const markets = candidateRoot === null ? undefined : candidateMarkets({ root: candidateRoot });
  const result = readAndRunCvPreflight(
    cvPath,
    briefPath,
    revision ? { constraints, languages, markets, waivers } : { constraints, languages, markets },
  );
  // A candidate constraint refuses in both modes, unlike a brief-coupled finding: it is not a
  // brief decision, so a revision does not get to classify it and publish anyway.
  if (result.candidateErrors.length) {
    throw new Error(`CV content breaks the candidate layer:\n- ${result.candidateErrors.join("\n- ")}`);
  }
  if (!revision && result.errors.length) {
    throw new Error(`CV content preflight failed:\n- ${result.errors.join("\n- ")}`);
  }
  console.log(JSON.stringify(
    revision
      ? {
          status: "revision-checked",
          conflicts: result.conflicts,
          notices: result.notices,
          warnings: result.warnings,
        }
      : { status: "valid", warnings: result.warnings },
    null,
    2,
  ));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
