#!/usr/bin/env node

/*
 * Validate the compact, persistent boundary between pipeline Steps 1-3 and Steps 4-5.
 * The brief stores application-specific decisions, not the candidate canon itself. Validation is
 * intentionally semantic as well as structural so downstream generation can run without chat history.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  parseJsonBytes,
  validateFileReference,
  validateIsoTimestamp,
  validateOutputDir,
  validateRepoRelativePath,
  validateUtf8TextBytes,
} from "../pipeline-artifacts/validation.mjs";
import {
  candidateLeversSourcePath,
  candidateProfileSourcePath,
  validateCandidateLevers,
} from "../candidate/documents.mjs";
import { CandidateError } from "../candidate/errors.mjs";
import {
  candidateLanguageNames,
  candidateMarkets,
  candidateRootForCommand,
} from "../candidate/load.mjs";
import { MARKET_SIDES, marketNames, marketSide } from "../candidate/markets.mjs";
import {
  RESEARCH_SCHEMA_VERSIONS,
  validateCompanyResearch,
} from "../pipeline-artifacts/validate-company-research.mjs";
import {
  VACANCY_SCHEMA_VERSIONS,
  vacancyLanguagesOption,
  validateVacancy,
} from "../pipeline-artifacts/validate-vacancy.mjs";

/**
 * The version Step 3 writes, and every version a recorded brief may carry. In version 4
 * `role.market` names one of the two markets the candidate layer configures.
 */
export const APPLICATION_BRIEF_SCHEMA_VERSION = 4;
export const APPLICATION_BRIEF_SCHEMA_VERSIONS = Object.freeze([4]);
const DECISION_VALUES = new Set(["include", "exclude", "optional"]);
const GAP_VALUES = new Set(["hard", "soft", "adjacent"]);
const PLACEMENT_MODES = new Set(["any", "all"]);
const WORK_MODE_VALUES = new Set(["remote", "hybrid", "onsite", "unspecified"]);
const AI_REGISTER_VALUES = new Set(["work-only", "broad", "relevance-link", "deep"]);
const CV_STRUCTURE_VALUES = new Set(["chronological", "hybrid"]);
const HEADER_POSITIONING_VALUES = new Set(["omit", "explicit"]);
const PROJECT_DECISION_VALUES = new Set(["include", "exclude"]);
const SUPPORT_VALUES = new Set(["evidence", "gap"]);
const TRANSFERABLE_SUPPORT_VALUES = new Set(["evidence", "none"]);
const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "createdAt",
  "process",
  "inputs",
  "role",
  "company",
  "positioning",
  "experience",
  "ats",
  "cvPlan",
  "coverLetterPlan",
]);
const CV_PLAN_KEYS = new Set([
  "structure",
  "llmWorkSignal",
  "headerPositioning",
  "projectDecision",
  "checks",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, path, errors) {
  if (!isObject(value)) errors.push(`${path} must be an object`);
  return isObject(value) ? value : {};
}

function requireArray(value, path, errors, { min = 0, max = Infinity } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  if (value.length < min) errors.push(`${path} must contain at least ${min} item(s)`);
  if (value.length > max) errors.push(`${path} must contain at most ${max} item(s)`);
  return value;
}

function requireString(value, path, errors) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} must be a non-empty string`);
    return "";
  }
  return value.trim();
}

function requireNullableString(value, path, errors) {
  if (value === null) return null;
  return requireString(value, path, errors);
}

function requireStringArray(value, path, errors, options = {}) {
  const items = requireArray(value, path, errors, options);
  items.forEach((item, index) => requireString(item, `${path}[${index}]`, errors));
  return items;
}

function rejectUnknownKeys(value, path, errors, allowedKeys) {
  if (!isObject(value)) return;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path} contains unknown key: ${key}`);
  }
}

function requireUniqueStrings(value, path, errors, options = {}) {
  const items = requireStringArray(value, path, errors, options);
  const seen = new Set();
  items.forEach((item) => {
    if (typeof item !== "string" || !item.trim()) return;
    if (seen.has(item)) errors.push(`${path} contains duplicate value: ${item}`);
    seen.add(item);
  });
  return items;
}

function sameStringMembers(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((item, index) => item === sortedRight[index]);
}

function validateExpectedProcess(process, expectedProcess, errors) {
  if (expectedProcess === undefined) return;
  for (const key of ["id", "sourceRef", "outputDir"]) {
    if (expectedProcess[key] !== undefined && process[key] !== expectedProcess[key]) {
      errors.push(`process.${key} does not match the selected ledger process`);
    }
  }
}

// Every profile source names the file the brief's own `inputs.candidateProfile` names: one brief
// reads one profile, so a second path inside it is an error whichever mode checks it.
function validateProfileSource(value, path, errors, { profileText, profilePath }) {
  const source = requireObject(value, path, errors);
  rejectUnknownKeys(source, path, errors, ["path", "section"]);
  validateRepoRelativePath(source.path, `${path}.path`, errors, { expectedPath: profilePath });
  const section = requireString(source.section, `${path}.section`, errors);
  if (profileText && section && !profileText.includes(section)) {
    errors.push(`${path}.section does not exist in the candidate profile`);
  }
  return source;
}

// The candidate's lever bank when its bytes were supplied, or `null`. A bank that fails its own
// form is an error of this validation too: the brief's lever rules cannot be checked against it.
function readLeverBank(bytes, errors) {
  if (bytes === undefined) return null;
  const text = validateUtf8TextBytes(bytes, candidateLeversSourcePath, errors);
  if (!text) return null;
  try {
    return validateCandidateLevers(text);
  } catch (error) {
    if (!(error instanceof CandidateError)) throw error;
    errors.push(`${candidateLeversSourcePath}: ${error.message}`);
    return null;
  }
}

function normalizeComparable(value) {
  return typeof value === "string"
    ? value.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim()
    : "";
}

function uniqueNormalizedPlacements(value) {
  const placements = new Map();
  if (!Array.isArray(value)) return [];
  for (const placement of value) {
    const normalized = normalizeComparable(placement);
    if (normalized && !placements.has(normalized)) {
      placements.set(normalized, {
        normalized,
        label: typeof placement === "string" ? placement.trim() : "",
      });
    }
  }
  return [...placements.values()];
}

function requiredAtsEvidenceCoverage(keyword, requiredEvidence) {
  const keywordPlacements = uniqueNormalizedPlacements(keyword?.placements);
  const keywordPlacementSet = new Set(keywordPlacements.map(({ normalized }) => normalized));
  const supportEvidenceIds = new Set(
    Array.isArray(keyword?.support?.evidenceIds)
      ? keyword.support.evidenceIds.filter((id) => typeof id === "string" && id.trim())
      : [],
  );
  const linkedChecks = requiredEvidence.filter(
    (check) =>
      Array.isArray(check?.evidenceIds) &&
      check.evidenceIds.some((evidenceId) => supportEvidenceIds.has(evidenceId)),
  );

  if (keyword?.placementMode === "all") {
    const missing = keywordPlacements.filter(
      ({ normalized }) =>
        !linkedChecks.some((check) => {
          const checkPlacements = uniqueNormalizedPlacements(check?.placements);
          if (check?.placementMode === "all") {
            return checkPlacements.some((placement) => placement.normalized === normalized);
          }
          return (
            check?.placementMode === "any" &&
            checkPlacements.length === 1 &&
            checkPlacements[0].normalized === normalized
          );
        }),
    );
    return {
      covered: missing.length === 0 && keywordPlacements.length > 0 && linkedChecks.length > 0,
      uncovered: missing.map(({ label }) => label),
    };
  }

  const covered =
    keyword?.placementMode === "any" &&
    linkedChecks.some((check) => {
      const checkPlacements = uniqueNormalizedPlacements(check?.placements);
      if (check?.placementMode === "all") {
        return checkPlacements.some(({ normalized }) => keywordPlacementSet.has(normalized));
      }
      return (
        check?.placementMode === "any" &&
        checkPlacements.length > 0 &&
        checkPlacements.every(({ normalized }) => keywordPlacementSet.has(normalized))
      );
    });
  return {
    covered,
    uncovered: keywordPlacements.map(({ label }) => label),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match a term as a token or phrase, not as an arbitrary substring of a larger word. */
export function containsWholeTerm(value, term) {
  const text = normalizeComparable(value);
  const normalizedTerm = normalizeComparable(term);
  if (!text || !normalizedTerm) return false;
  const phrase = normalizedTerm.split(" ").map(escapeRegExp).join("\\s+");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${phrase}(?=$|[^\\p{L}\\p{N}])`, "iu").test(text);
}

function validateResearchReferences(
  record,
  path,
  errors,
  researchIndex,
  { requireClaims = true, requireSources = true } = {},
) {
  const claimIds = requireUniqueStrings(record.claimIds, `${path}.claimIds`, errors, {
    min: requireClaims ? 1 : 0,
  });
  const sourceIds = requireUniqueStrings(record.sourceIds, `${path}.sourceIds`, errors, {
    min: requireSources ? 1 : 0,
  });
  if (!researchIndex) return;

  const linkedSourceIds = new Set();
  for (const claimId of claimIds) {
    const claim = researchIndex.claimsById.get(claimId);
    if (!claim) {
      errors.push(`${path}.claimIds reference does not exist in company-research.json: ${claimId}`);
      continue;
    }
    for (const sourceId of claim.sourceIds ?? []) linkedSourceIds.add(sourceId);
  }
  for (const sourceId of sourceIds) {
    if (!researchIndex.sourcesById.has(sourceId)) {
      errors.push(
        `${path}.sourceIds reference does not exist in company-research.json: ${sourceId}`,
      );
    } else if (!linkedSourceIds.has(sourceId)) {
      errors.push(`${path}.sourceIds must be supported by a linked research claim: ${sourceId}`);
    }
  }
}

function indexResearch(research) {
  if (!isObject(research)) return null;
  const sourcesById = new Map(
    Array.isArray(research.sources)
      ? research.sources.filter((source) => isObject(source)).map((source) => [source.id, source])
      : [],
  );
  const claimsById = new Map();
  if (isObject(research.analysis)) {
    for (const block of Object.values(research.analysis)) {
      if (!Array.isArray(block?.claims)) continue;
      for (const claim of block.claims) {
        if (isObject(claim) && typeof claim.id === "string") claimsById.set(claim.id, claim);
      }
    }
  }
  const hooksById = new Map(
    Array.isArray(research.tailoringHooks)
      ? research.tailoringHooks.filter((hook) => isObject(hook)).map((hook) => [hook.id, hook])
      : [],
  );
  return { sourcesById, claimsById, hooksById };
}

function hasPlacement(item, field, expected) {
  const target = normalizeComparable(expected);
  return (
    Array.isArray(item?.[field]) &&
    item[field].some((placement) => normalizeComparable(placement) === target)
  );
}

/**
 * Collect all contract violations instead of failing at the first field. map-experience can then
 * repair the handoff in one pass before CV and cover-letter work begins.
 */
export function validateApplicationBrief(
  brief,
  {
    vacancyBytes,
    jobDescriptionBytes,
    companyResearchBytes,
    candidateProfileBytes,
    candidateLeversBytes,
    expectedProcess,
    expectedSchemaVersion,
    languages,
    markets,
    requireInputBytes = false,
  } = {},
) {
  const errors = [];
  const vacancyLanguages = vacancyLanguagesOption(languages);
  if (!isObject(brief)) return ["application brief must be a JSON object"];
  if ([1, 2, 3].includes(brief.schemaVersion)) {
    return [
      `schemaVersion ${brief.schemaVersion} is unsupported; rerun map-experience to create application-brief.json with schemaVersion ${APPLICATION_BRIEF_SCHEMA_VERSION}`,
    ];
  }
  // A publication names the version it writes; a recorded brief is read under the version its
  // ledger entry records. Without either, the file is read under the version it declares.
  if (expectedSchemaVersion !== undefined) {
    if (brief.schemaVersion !== expectedSchemaVersion) {
      errors.push(`schemaVersion must equal ${expectedSchemaVersion}`);
    }
  } else if (!APPLICATION_BRIEF_SCHEMA_VERSIONS.includes(brief.schemaVersion)) {
    errors.push(`schemaVersion must be one of: ${APPLICATION_BRIEF_SCHEMA_VERSIONS.join(", ")}`);
  }
  for (const key of Object.keys(brief)) {
    if (key === "contentChecks") {
      errors.push(
        "contentChecks is obsolete in schemaVersion 3; move it to cvPlan.checks and rerun map-experience",
      );
    } else if (!TOP_LEVEL_KEYS.has(key)) {
      errors.push(`application brief contains unknown top-level key: ${key}`);
    }
  }
  validateIsoTimestamp(brief.createdAt, "createdAt", errors);

  const process = requireObject(brief.process, "process", errors);
  rejectUnknownKeys(process, "process", errors, ["id", "sourceRef", "outputDir"]);
  requireString(process.id, "process.id", errors);
  requireString(process.sourceRef, "process.sourceRef", errors);
  validateOutputDir(process.outputDir, "process.outputDir", errors);
  validateExpectedProcess(process, expectedProcess, errors);

  const inputs = requireObject(brief.inputs, "inputs", errors);
  rejectUnknownKeys(inputs, "inputs", errors, [
    "vacancy",
    "jobDescription",
    "companyResearch",
    "candidateProfile",
  ]);
  // Without the profile's bytes nothing here can tell which profile a path names, so a structural
  // check accepts any normalized path: a brief published before the profile moved stays readable
  // to a light CV revision. With the bytes the path is the layer's, and a brief that names another
  // one never reaches this far in the lifecycle, which compares its protected inputs first.
  const structuralProfile = candidateProfileBytes === undefined && !requireInputBytes;
  const inputSpecs = [
    // The vacancy version is checked below against the vacancy bytes.
    ["vacancy", "vacancy.json", undefined, vacancyBytes],
    ["jobDescription", "job-description.txt", null, jobDescriptionBytes],
    // The research version is checked below against the research bytes.
    ["companyResearch", "company-research.json", undefined, companyResearchBytes],
    [
      "candidateProfile",
      structuralProfile ? undefined : candidateProfileSourcePath,
      null,
      candidateProfileBytes,
    ],
  ];
  for (const [key, expectedPath, expectedSchemaVersion, contentBytes] of inputSpecs) {
    if (requireInputBytes && contentBytes === undefined) {
      errors.push(
        `${expectedPath ?? key} bytes are required for application-brief bundle validation`,
      );
    }
    validateFileReference(inputs[key], `inputs.${key}`, errors, {
      expectedPath,
      expectedSchemaVersion,
      contentBytes,
    });
  }
  const jobDescriptionText =
    jobDescriptionBytes === undefined
      ? ""
      : validateUtf8TextBytes(jobDescriptionBytes, "job-description.txt", errors);
  const candidateProfileText =
    candidateProfileBytes === undefined
      ? ""
      : validateUtf8TextBytes(candidateProfileBytes, candidateProfileSourcePath, errors);
  const profileSourceOptions = {
    profilePath:
      typeof inputs.candidateProfile?.path === "string"
        ? inputs.candidateProfile.path
        : candidateProfileSourcePath,
    profileText: candidateProfileText,
  };
  if (requireInputBytes && candidateLeversBytes === undefined) {
    errors.push(
      `${candidateLeversSourcePath} bytes are required for application-brief bundle validation`,
    );
  }
  const leverBank = readLeverBank(candidateLeversBytes, errors);

  const vacancy =
    vacancyBytes === undefined ? undefined : parseJsonBytes(vacancyBytes, "vacancy.json", errors);
  const vacancyReferenceVersion = inputs.vacancy?.schemaVersion;
  if (!VACANCY_SCHEMA_VERSIONS.includes(vacancyReferenceVersion)) {
    errors.push(
      `inputs.vacancy.schemaVersion must be one of: ${VACANCY_SCHEMA_VERSIONS.join(", ")}`,
    );
  } else if (
    VACANCY_SCHEMA_VERSIONS.includes(vacancy?.schemaVersion) &&
    vacancyReferenceVersion !== vacancy.schemaVersion
  ) {
    errors.push(
      "inputs.vacancy.schemaVersion must equal " +
        `${vacancy.schemaVersion}, the schemaVersion of vacancy.json`,
    );
  }
  if (vacancy !== undefined && jobDescriptionBytes !== undefined) {
    const vacancyErrors = validateVacancy(vacancy, {
      jobDescriptionBytes,
      expectedProcess: process,
      languages: vacancyLanguages,
      markets,
      outcome: "completed",
    });
    errors.push(...vacancyErrors.map((error) => `inputs.vacancy content: ${error}`));
  }

  const research =
    companyResearchBytes === undefined
      ? undefined
      : parseJsonBytes(companyResearchBytes, "company-research.json", errors);
  const researchReferenceVersion = inputs.companyResearch?.schemaVersion;
  if (!RESEARCH_SCHEMA_VERSIONS.includes(researchReferenceVersion)) {
    errors.push(
      `inputs.companyResearch.schemaVersion must be one of: ${RESEARCH_SCHEMA_VERSIONS.join(", ")}`,
    );
  } else if (
    RESEARCH_SCHEMA_VERSIONS.includes(research?.schemaVersion) &&
    researchReferenceVersion !== research.schemaVersion
  ) {
    errors.push(
      "inputs.companyResearch.schemaVersion must equal " +
        `${research.schemaVersion}, the schemaVersion of company-research.json`,
    );
  }
  if (research !== undefined && vacancyBytes !== undefined && jobDescriptionBytes !== undefined) {
    const researchErrors = validateCompanyResearch(research, {
      vacancyBytes,
      jobDescriptionBytes,
      expectedProcess: process,
      languages: vacancyLanguages,
      markets,
      outcome: "completed",
    });
    errors.push(...researchErrors.map((error) => `inputs.companyResearch content: ${error}`));
  }
  const researchIndex = indexResearch(research);

  const role = requireObject(brief.role, "role", errors);
  rejectUnknownKeys(role, "role", errors, [
    "company",
    "title",
    "ats",
    "vacancyLanguage",
    "market",
    "feasibility",
  ]);
  requireString(role.company, "role.company", errors);
  requireString(role.title, "role.title", errors);
  requireString(role.ats, "role.ats", errors);
  if (!vacancyLanguages.includes(role.vacancyLanguage)) {
    errors.push(`role.vacancyLanguage must be one of: ${vacancyLanguages.join(", ")}`);
  }
  const briefMarkets = marketNames(markets);
  if (briefMarkets.length === 0) {
    errors.push("role.market must name a configured market: the candidate layer configures none");
  } else if (!briefMarkets.includes(role.market)) {
    errors.push(`role.market must be one of: ${briefMarkets.join(", ")}`);
  }
  const briefMarketSide = marketSide(markets, role.market);
  const feasibility = requireObject(role.feasibility, "role.feasibility", errors);
  rejectUnknownKeys(feasibility, "role.feasibility", errors, [
    "workModel",
    "locations",
    "employmentType",
    "timezoneOverlap",
    "workAuthorizationResidency",
    "relocationVisaSupport",
    "salary",
  ]);
  const workModel = requireObject(feasibility.workModel, "role.feasibility.workModel", errors);
  rejectUnknownKeys(workModel, "role.feasibility.workModel", errors, ["normalized", "sourceText"]);
  if (!WORK_MODE_VALUES.has(workModel.normalized)) {
    errors.push(
      `role.feasibility.workModel.normalized must be one of: ${[...WORK_MODE_VALUES].join(", ")}`,
    );
  }
  requireNullableString(workModel.sourceText, "role.feasibility.workModel.sourceText", errors);
  requireStringArray(feasibility.locations, "role.feasibility.locations", errors);
  for (const field of [
    "employmentType",
    "timezoneOverlap",
    "workAuthorizationResidency",
    "relocationVisaSupport",
    "salary",
  ]) {
    requireNullableString(feasibility[field], `role.feasibility.${field}`, errors);
  }

  if (vacancy) {
    for (const key of ["company", "title", "ats", "vacancyLanguage"]) {
      if (role[key] !== vacancy.role?.[key]) {
        errors.push(`role.${key} must match vacancy.json`);
      }
    }
    if (role.market !== vacancy.role?.market?.value) {
      errors.push("role.market must match vacancy.json role.market.value");
    }
    if (!isDeepStrictEqual(role.feasibility, vacancy.role?.feasibility)) {
      errors.push("role.feasibility must exactly preserve vacancy.json feasibility facts");
    }
  }

  const company = requireObject(brief.company, "company", errors);
  rejectUnknownKeys(company, "company", errors, [
    "challengeType",
    "challengeEvidence",
    "values",
    "tailoringHooks",
  ]);
  requireString(company.challengeType, "company.challengeType", errors);
  const challengeEvidence = requireObject(
    company.challengeEvidence,
    "company.challengeEvidence",
    errors,
  );
  rejectUnknownKeys(challengeEvidence, "company.challengeEvidence", errors, [
    "hookId",
    "fact",
    "claimIds",
    "sourceIds",
  ]);
  const challengeHookId = requireString(
    challengeEvidence.hookId,
    "company.challengeEvidence.hookId",
    errors,
  );
  requireString(challengeEvidence.fact, "company.challengeEvidence.fact", errors);
  validateResearchReferences(challengeEvidence, "company.challengeEvidence", errors, researchIndex);
  const researchChallengeHook = researchIndex?.hooksById.get(challengeHookId);
  if (researchIndex && !researchChallengeHook) {
    errors.push(`company.challengeEvidence.hookId reference does not exist: ${challengeHookId}`);
  } else if (researchChallengeHook) {
    if (company.challengeType !== researchChallengeHook.challengeType) {
      errors.push("company.challengeType must match the referenced research hook challengeType");
    }
    if (challengeEvidence.fact !== researchChallengeHook.fact) {
      errors.push("company.challengeEvidence.fact must match the referenced research hook fact");
    }
    if (!sameStringMembers(challengeEvidence.claimIds, researchChallengeHook.claimIds)) {
      errors.push("company.challengeEvidence.claimIds must match the referenced research hook");
    }
    if (!sameStringMembers(challengeEvidence.sourceIds, researchChallengeHook.sourceIds)) {
      errors.push("company.challengeEvidence.sourceIds must match the referenced research hook");
    }
  }

  const values = requireArray(company.values, "company.values", errors, { min: 1 });
  values.forEach((value, index) => {
    const path = `company.values[${index}]`;
    const item = requireObject(value, path, errors);
    rejectUnknownKeys(item, path, errors, ["text", "claimIds", "sourceIds"]);
    const text = requireString(item.text, `${path}.text`, errors);
    validateResearchReferences(item, path, errors, researchIndex);
    if (researchIndex) {
      const linkedClaims = (Array.isArray(item.claimIds) ? item.claimIds : [])
        .map((claimId) => researchIndex.claimsById.get(claimId))
        .filter(Boolean);
      if (linkedClaims.length && !linkedClaims.some((claim) => claim.text === text)) {
        errors.push(`${path}.text must exactly match one linked research claim`);
      }
      if (linkedClaims.some((claim) => claim.evidenceStatus !== "verified")) {
        errors.push(`${path}.claimIds must reference verified research claims`);
      }
    }
  });

  const hooks = requireArray(company.tailoringHooks, "company.tailoringHooks", errors, { min: 1 });
  hooks.forEach((hook, index) => {
    const path = `company.tailoringHooks[${index}]`;
    const item = requireObject(hook, path, errors);
    rejectUnknownKeys(item, path, errors, ["hookId", "topic", "evidence", "claimIds", "sourceIds"]);
    const hookId = requireString(item.hookId, `${path}.hookId`, errors);
    requireString(item.topic, `${path}.topic`, errors);
    requireString(item.evidence, `${path}.evidence`, errors);
    validateResearchReferences(item, path, errors, researchIndex);
    const researchHook = researchIndex?.hooksById.get(hookId);
    if (researchIndex && !researchHook) {
      errors.push(`${path}.hookId reference does not exist: ${hookId}`);
    } else if (researchHook) {
      if (item.topic !== researchHook.challengeType) {
        errors.push(`${path}.topic must match the referenced research hook challengeType`);
      }
      if (item.evidence !== researchHook.fact) {
        errors.push(`${path}.evidence must match the referenced research hook fact`);
      }
      if (!sameStringMembers(item.claimIds, researchHook.claimIds)) {
        errors.push(`${path}.claimIds must match the referenced research hook`);
      }
      if (!sameStringMembers(item.sourceIds, researchHook.sourceIds)) {
        errors.push(`${path}.sourceIds must match the referenced research hook`);
      }
    }
  });

  const positioning = requireObject(brief.positioning, "positioning", errors);
  rejectUnknownKeys(positioning, "positioning", errors, [
    "selectedLevers",
    "angleHint",
    "aiRegister",
    "supportingSignals",
  ]);
  const selectedLevers = requireArray(
    positioning.selectedLevers,
    "positioning.selectedLevers",
    errors,
    { min: 1, max: 2 },
  );
  // Levers and included supporting signals must point to executable content checks. This turns a
  // positioning choice into a downstream requirement instead of leaving it as advisory prose.
  const referencedCheckIds = [];
  selectedLevers.forEach((lever, index) => {
    const path = `positioning.selectedLevers[${index}]`;
    const item = requireObject(lever, path, errors);
    rejectUnknownKeys(item, path, errors, [
      "id",
      "wording",
      "rationale",
      "evidenceAnchors",
      "cvEvidenceCheckIds",
    ]);
    if (!Number.isInteger(item.id) || item.id < 1) {
      errors.push(`positioning.selectedLevers[${index}].id must be a positive integer`);
    } else if (leverBank && !leverBank.levers.some((entry) => entry.id === item.id)) {
      errors.push(
        `positioning.selectedLevers[${index}].id names no lever of ${candidateLeversSourcePath}`,
      );
    }
    requireString(item.wording, `positioning.selectedLevers[${index}].wording`, errors);
    requireString(item.rationale, `positioning.selectedLevers[${index}].rationale`, errors);
    requireUniqueStrings(
      item.evidenceAnchors,
      `positioning.selectedLevers[${index}].evidenceAnchors`,
      errors,
      { min: 1 },
    );
    referencedCheckIds.push(
      ...requireUniqueStrings(
        item.cvEvidenceCheckIds,
        `positioning.selectedLevers[${index}].cvEvidenceCheckIds`,
        errors,
        { min: 1 },
      ),
    );
  });
  requireString(positioning.angleHint, "positioning.angleHint", errors);
  if (!AI_REGISTER_VALUES.has(positioning.aiRegister)) {
    errors.push(`positioning.aiRegister must be one of: ${[...AI_REGISTER_VALUES].join(", ")}`);
  }
  // The register rules read the properties of the selected levers, which only the candidate's
  // bank knows; without its bytes they are not checked here, and bundle validation requires them.
  if (leverBank) {
    const selectedWith = (property) =>
      selectedLevers.some((lever) =>
        leverBank.levers.some(
          (entry) => entry.id === lever?.id && entry.properties.includes(property),
        ),
      );
    if (positioning.aiRegister === "deep" && !selectedWith("ai-infrastructure")) {
      errors.push(
        "positioning.aiRegister deep requires a selected lever with the ai-infrastructure property",
      );
    }
    if (selectedWith("ai-infrastructure") && positioning.aiRegister !== "deep") {
      errors.push(
        "a selected lever with the ai-infrastructure property requires positioning.aiRegister deep",
      );
    }
    if (
      positioning.aiRegister === "work-only" &&
      (selectedWith("ai-practice") || selectedWith("ai-infrastructure"))
    ) {
      errors.push(
        "positioning.aiRegister work-only is incompatible with a selected lever with the ai-practice or ai-infrastructure property",
      );
    }
  }

  const supportingSignals = requireArray(
    positioning.supportingSignals,
    "positioning.supportingSignals",
    errors,
    { min: 1 },
  );
  const aiSignalDecisions = [];
  supportingSignals.forEach((signal, index) => {
    const path = `positioning.supportingSignals[${index}]`;
    const item = requireObject(signal, path, errors);
    rejectUnknownKeys(item, path, errors, [
      "id",
      "topic",
      "decision",
      "evidence",
      "claimIds",
      "sourceIds",
      "constraints",
      "cvEvidenceCheckId",
    ]);
    const id = requireString(item.id, `positioning.supportingSignals[${index}].id`, errors);
    const topic = requireString(
      item.topic,
      `positioning.supportingSignals[${index}].topic`,
      errors,
    );
    if (/\b(?:AI|LLM)\b/i.test(`${id} ${topic}`)) aiSignalDecisions.push(item.decision);
    if (!DECISION_VALUES.has(item.decision)) {
      errors.push(
        `positioning.supportingSignals[${index}].decision must be include, exclude, or optional`,
      );
    }
    requireString(item.evidence, `positioning.supportingSignals[${index}].evidence`, errors);
    validateResearchReferences(item, path, errors, researchIndex, {
      requireClaims: item.decision === "include",
      requireSources: item.decision === "include",
    });
    requireUniqueStrings(
      item.constraints,
      `positioning.supportingSignals[${index}].constraints`,
      errors,
      { min: 1 },
    );
    if (item.decision === "include") {
      referencedCheckIds.push(
        requireString(
          item.cvEvidenceCheckId,
          `positioning.supportingSignals[${index}].cvEvidenceCheckId`,
          errors,
        ),
      );
    } else if (item.cvEvidenceCheckId !== undefined) {
      errors.push(
        `positioning.supportingSignals[${index}].cvEvidenceCheckId is allowed only when decision is include`,
      );
    }
  });
  if (!aiSignalDecisions.length) {
    // Explicitly recording exclusion is valuable: it prevents a downstream writer from silently
    // omitting a relevant signal or inventing an AI angle merely because the source chat is absent.
    errors.push(
      "positioning.supportingSignals must record an explicit AI/LLM include or exclude decision",
    );
  } else {
    if (aiSignalDecisions.includes("optional")) {
      errors.push("AI/LLM supportingSignals decision must be include or exclude, not optional");
    }
    if (
      positioning.aiRegister === "work-only" &&
      aiSignalDecisions.some((decision) => decision !== "exclude")
    ) {
      errors.push(
        "positioning.aiRegister work-only requires every role-specific AI/LLM supporting signal decision to be exclude",
      );
    }
    if (
      positioning.aiRegister !== "work-only" &&
      AI_REGISTER_VALUES.has(positioning.aiRegister) &&
      !aiSignalDecisions.includes("include")
    ) {
      errors.push(
        `positioning.aiRegister ${positioning.aiRegister} requires an included AI/LLM supporting signal`,
      );
    }
  }

  const experience = requireObject(brief.experience, "experience", errors);
  rejectUnknownKeys(experience, "experience", errors, ["priorityEvidence", "traits", "gaps"]);
  const evidence = requireArray(
    experience.priorityEvidence,
    "experience.priorityEvidence",
    errors,
    { min: 1 },
  );
  const evidenceIds = new Set();
  const evidenceById = new Map();
  evidence.forEach((entry, index) => {
    const path = `experience.priorityEvidence[${index}]`;
    const item = requireObject(entry, path, errors);
    rejectUnknownKeys(item, path, errors, [
      "id",
      "priority",
      "category",
      "claim",
      "profileSource",
      "proof",
      "cvPlacements",
    ]);
    const id = requireString(item.id, `${path}.id`, errors);
    if (id && evidenceIds.has(id)) errors.push(`duplicate experience.priorityEvidence id: ${id}`);
    if (id) {
      evidenceIds.add(id);
      evidenceById.set(id, item);
    }
    requireString(item.priority, `${path}.priority`, errors);
    requireString(item.category, `${path}.category`, errors);
    requireString(item.claim, `${path}.claim`, errors);
    validateProfileSource(
      item.profileSource,
      `${path}.profileSource`,
      errors,
      profileSourceOptions,
    );
    requireUniqueStrings(item.proof, `${path}.proof`, errors, { min: 1 });
    requireUniqueStrings(item.cvPlacements, `${path}.cvPlacements`, errors, { min: 1 });
  });

  selectedLevers.forEach((lever, leverIndex) => {
    if (!Array.isArray(lever?.evidenceAnchors)) return;
    for (const evidenceId of lever.evidenceAnchors) {
      if (typeof evidenceId === "string" && evidenceId.trim() && !evidenceIds.has(evidenceId)) {
        errors.push(
          `positioning.selectedLevers[${leverIndex}].evidenceAnchors reference does not exist: ${evidenceId}`,
        );
      }
    }
  });

  const traits = requireArray(experience.traits, "experience.traits", errors, { min: 1 });
  const traitIds = new Set();
  traits.forEach((trait, index) => {
    const path = `experience.traits[${index}]`;
    const item = requireObject(trait, path, errors);
    rejectUnknownKeys(item, path, errors, ["id", "trait", "behavior", "profileSource"]);
    const id = requireString(item.id, `${path}.id`, errors);
    if (id && traitIds.has(id)) errors.push(`duplicate experience.traits id: ${id}`);
    if (id) traitIds.add(id);
    requireString(item.trait, `${path}.trait`, errors);
    requireString(item.behavior, `${path}.behavior`, errors);
    validateProfileSource(
      item.profileSource,
      `${path}.profileSource`,
      errors,
      profileSourceOptions,
    );
  });

  const gaps = requireArray(experience.gaps, "experience.gaps", errors);
  const gapIds = new Set();
  const gapById = new Map();
  gaps.forEach((gap, index) => {
    const path = `experience.gaps[${index}]`;
    const item = requireObject(gap, path, errors);
    rejectUnknownKeys(item, path, errors, [
      "id",
      "requirement",
      "classification",
      "transferableSupport",
      "framing",
    ]);
    const id = requireString(item.id, `${path}.id`, errors);
    if (id && gapIds.has(id)) errors.push(`duplicate experience.gaps id: ${id}`);
    if (id) {
      gapIds.add(id);
      gapById.set(id, item);
    }
    requireString(item.requirement, `${path}.requirement`, errors);
    if (!GAP_VALUES.has(item.classification)) {
      errors.push(`${path}.classification must be hard, soft, or adjacent`);
    }
    const support = requireObject(item.transferableSupport, `${path}.transferableSupport`, errors);
    rejectUnknownKeys(support, `${path}.transferableSupport`, errors, ["status", "evidenceIds"]);
    if (!TRANSFERABLE_SUPPORT_VALUES.has(support.status)) {
      errors.push(`${path}.transferableSupport.status must be evidence or none`);
    }
    const transferableEvidenceIds = requireUniqueStrings(
      support.evidenceIds,
      `${path}.transferableSupport.evidenceIds`,
      errors,
      { min: support.status === "evidence" ? 1 : 0 },
    );
    if (support.status === "none" && transferableEvidenceIds.length) {
      errors.push(`${path}.transferableSupport.evidenceIds must be empty when status is none`);
    }
    for (const evidenceId of transferableEvidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        errors.push(
          `${path}.transferableSupport.evidenceIds reference does not exist: ${evidenceId}`,
        );
      }
    }
    requireString(item.framing, `${path}.framing`, errors);
  });

  const ats = requireObject(brief.ats, "ats", errors);
  rejectUnknownKeys(ats, "ats", errors, ["keywords"]);
  const keywords = requireArray(ats.keywords, "ats.keywords", errors, { min: 15, max: 25 });
  const keywordTerms = new Set();
  keywords.forEach((keyword, index) => {
    const path = `ats.keywords[${index}]`;
    const item = requireObject(keyword, path, errors);
    rejectUnknownKeys(item, path, errors, [
      "term",
      "expanded",
      "support",
      "placements",
      "required",
      "placementMode",
    ]);
    const term = requireString(item.term, `${path}.term`, errors);
    if (term && keywordTerms.has(term)) errors.push(`duplicate ats.keywords term: ${term}`);
    if (term) keywordTerms.add(term);
    if (jobDescriptionText && term && !containsWholeTerm(jobDescriptionText, term)) {
      errors.push(`${path}.term must exactly occur in job-description.txt`);
    }
    requireNullableString(item.expanded, `${path}.expanded`, errors);
    const support = requireObject(item.support, `${path}.support`, errors);
    rejectUnknownKeys(support, `${path}.support`, errors, ["status", "evidenceIds", "gapId"]);
    if (!SUPPORT_VALUES.has(support.status)) {
      errors.push(`${path}.support.status must be evidence or gap`);
    }
    const placements = requireUniqueStrings(item.placements, `${path}.placements`, errors, {
      min: support.status === "evidence" ? 1 : 0,
    });
    if (typeof item.required !== "boolean") errors.push(`${path}.required must be boolean`);
    if (!PLACEMENT_MODES.has(item.placementMode)) {
      errors.push(`${path}.placementMode must be any or all`);
    }
    if (support.status === "evidence") {
      const supportEvidenceIds = requireUniqueStrings(
        support.evidenceIds,
        `${path}.support.evidenceIds`,
        errors,
        { min: 1 },
      );
      if (support.gapId !== undefined) {
        errors.push(`${path}.support.gapId is allowed only when support.status is gap`);
      }
      for (const evidenceId of supportEvidenceIds) {
        if (!evidenceIds.has(evidenceId)) {
          errors.push(`${path}.support.evidenceIds reference does not exist: ${evidenceId}`);
        }
      }
    } else if (support.status === "gap") {
      if (support.evidenceIds !== undefined) {
        errors.push(`${path}.support.evidenceIds is allowed only when support.status is evidence`);
      }
      const gapId = requireString(support.gapId, `${path}.support.gapId`, errors);
      if (gapId && !gapById.has(gapId)) {
        errors.push(`${path}.support.gapId reference does not exist: ${gapId}`);
      } else if (gapId && term && !containsWholeTerm(gapById.get(gapId)?.requirement ?? "", term)) {
        errors.push(`${path}.term must occur in the linked gap requirement`);
      }
      if (placements.length)
        errors.push(`${path}.placements must be empty when support.status is gap`);
      if (item.required === true)
        errors.push(`${path}.required must be false when support.status is gap`);
    }
  });

  const cvPlan = requireObject(brief.cvPlan, "cvPlan", errors);
  for (const key of Object.keys(cvPlan)) {
    if (key === "variants") {
      errors.push(
        "cvPlan.variants is not supported; application-brief.json defines one targeted CV only",
      );
    } else if (!CV_PLAN_KEYS.has(key)) {
      errors.push(`cvPlan contains unknown key: ${key}`);
    }
  }
  if (!CV_STRUCTURE_VALUES.has(cvPlan.structure)) {
    errors.push(`cvPlan.structure must be one of: ${[...CV_STRUCTURE_VALUES].join(", ")}`);
  }

  const headerPositioning = requireObject(
    cvPlan.headerPositioning,
    "cvPlan.headerPositioning",
    errors,
  );
  rejectUnknownKeys(headerPositioning, "cvPlan.headerPositioning", errors, [
    "mode",
    "text",
    "rationale",
  ]);
  if (!HEADER_POSITIONING_VALUES.has(headerPositioning.mode)) {
    errors.push(
      `cvPlan.headerPositioning.mode must be one of: ${[...HEADER_POSITIONING_VALUES].join(", ")}`,
    );
  } else if (headerPositioning.mode === "omit") {
    if (headerPositioning.text !== null)
      errors.push("cvPlan.headerPositioning.text must be null when mode is omit");
  } else {
    requireString(headerPositioning.text, "cvPlan.headerPositioning.text", errors);
  }
  requireString(headerPositioning.rationale, "cvPlan.headerPositioning.rationale", errors);
  if (briefMarketSide === MARKET_SIDES.home && headerPositioning.mode !== "omit") {
    errors.push("role.market on the home market requires cvPlan.headerPositioning.mode omit");
  }
  if (briefMarketSide === MARKET_SIDES.outsideHome && headerPositioning.mode !== "explicit") {
    errors.push(
      "role.market outside the home market requires cvPlan.headerPositioning.mode explicit",
    );
  }

  const projectDecision = requireObject(cvPlan.projectDecision, "cvPlan.projectDecision", errors);
  rejectUnknownKeys(projectDecision, "cvPlan.projectDecision", errors, [
    "decision",
    "projectId",
    "rationale",
  ]);
  if (!PROJECT_DECISION_VALUES.has(projectDecision.decision)) {
    errors.push(
      `cvPlan.projectDecision.decision must be one of: ${[...PROJECT_DECISION_VALUES].join(", ")}`,
    );
  } else if (projectDecision.decision === "include") {
    requireString(projectDecision.projectId, "cvPlan.projectDecision.projectId", errors);
  } else if (projectDecision.projectId !== null) {
    errors.push("cvPlan.projectDecision.projectId must be null when decision is exclude");
  }
  requireString(projectDecision.rationale, "cvPlan.projectDecision.rationale", errors);

  // cvPlan.checks is the machine-enforceable editorial plan consumed by cv-builder/preflight.mjs.
  const checks = requireObject(cvPlan.checks, "cvPlan.checks", errors);
  rejectUnknownKeys(checks, "cvPlan.checks", errors, [
    "requiredEvidence",
    "forbiddenTerms",
    "skillGroups",
  ]);
  const requiredEvidence = requireArray(
    checks.requiredEvidence,
    "cvPlan.checks.requiredEvidence",
    errors,
    { min: 1 },
  );
  const checkIds = new Set();
  const checkById = new Map();
  requiredEvidence.forEach((check, index) => {
    const path = `cvPlan.checks.requiredEvidence[${index}]`;
    const item = requireObject(check, path, errors);
    rejectUnknownKeys(item, path, errors, [
      "id",
      "description",
      "evidenceIds",
      "anyOf",
      "placements",
      "placementMode",
    ]);
    const id = requireString(item.id, `${path}.id`, errors);
    if (id && checkIds.has(id)) errors.push(`duplicate cvPlan.checks.requiredEvidence id: ${id}`);
    if (id) {
      checkIds.add(id);
      checkById.set(id, item);
    }
    requireString(item.description, `cvPlan.checks.requiredEvidence[${index}].description`, errors);
    const linkedEvidenceIds = requireStringArray(
      item.evidenceIds,
      `cvPlan.checks.requiredEvidence[${index}].evidenceIds`,
      errors,
      { min: 1 },
    );
    const seenEvidenceLinks = new Set();
    linkedEvidenceIds.forEach((evidenceId) => {
      if (typeof evidenceId !== "string" || !evidenceId.trim()) return;
      if (seenEvidenceLinks.has(evidenceId)) {
        errors.push(
          `duplicate cvPlan.checks.requiredEvidence[${index}].evidenceIds reference: ${evidenceId}`,
        );
      }
      seenEvidenceLinks.add(evidenceId);
      if (!evidenceIds.has(evidenceId)) {
        errors.push(
          `cvPlan.checks.requiredEvidence[${index}].evidenceIds reference does not exist: ${evidenceId}`,
        );
      }
    });
    requireStringArray(item.anyOf, `cvPlan.checks.requiredEvidence[${index}].anyOf`, errors, {
      min: 1,
    });
    const checkPlacements = requireStringArray(
      item.placements,
      `cvPlan.checks.requiredEvidence[${index}].placements`,
      errors,
      { min: 1 },
    );
    if (!PLACEMENT_MODES.has(item.placementMode)) {
      errors.push(`cvPlan.checks.requiredEvidence[${index}].placementMode must be any or all`);
    } else {
      const allowedPlacements = new Set(
        linkedEvidenceIds.flatMap((evidenceId) => {
          const linkedEvidence = evidenceById.get(evidenceId);
          return Array.isArray(linkedEvidence?.cvPlacements)
            ? linkedEvidence.cvPlacements.map(normalizeComparable)
            : [];
        }),
      );
      const placementCoverage = checkPlacements.map((placement) =>
        allowedPlacements.has(normalizeComparable(placement)),
      );
      if (item.placementMode === "all" && placementCoverage.some((covered) => !covered)) {
        const unsupported = checkPlacements.filter(
          (_, placementIndex) => !placementCoverage[placementIndex],
        );
        errors.push(
          `cvPlan.checks.requiredEvidence[${index}].placements not allowed by linked evidence cvPlacements: ${unsupported.join(", ")}`,
        );
      }
      if (item.placementMode === "any" && !placementCoverage.some(Boolean)) {
        errors.push(
          `cvPlan.checks.requiredEvidence[${index}].placements has no placement allowed by linked evidence cvPlacements`,
        );
      }
    }
  });

  keywords.forEach((keyword, index) => {
    if (
      keyword?.required !== true ||
      keyword?.support?.status !== "evidence" ||
      !PLACEMENT_MODES.has(keyword?.placementMode) ||
      !Array.isArray(keyword?.support?.evidenceIds) ||
      keyword.support.evidenceIds.length === 0 ||
      !Array.isArray(keyword?.placements) ||
      keyword.placements.length === 0
    ) {
      return;
    }
    const coverage = requiredAtsEvidenceCoverage(keyword, requiredEvidence);
    if (!coverage.covered) {
      errors.push(
        `ats.keywords[${index}] required evidence is not covered by ` +
          `cvPlan.checks.requiredEvidence for placementMode ${keyword.placementMode}: ` +
          coverage.uncovered.join(", "),
      );
    }
  });

  // Every targeted CV carries one commercially grounded LLM-work signal. The dedicated references
  // keep that invariant independent from role-specific AI positioning and cover-letter decisions.
  const llmWorkSignal = requireObject(cvPlan.llmWorkSignal, "cvPlan.llmWorkSignal", errors);
  rejectUnknownKeys(llmWorkSignal, "cvPlan.llmWorkSignal", errors, ["evidenceId", "checkId"]);
  const llmEvidenceId = requireString(
    llmWorkSignal.evidenceId,
    "cvPlan.llmWorkSignal.evidenceId",
    errors,
  );
  const llmCheckId = requireString(llmWorkSignal.checkId, "cvPlan.llmWorkSignal.checkId", errors);
  if (llmEvidenceId && !evidenceIds.has(llmEvidenceId)) {
    errors.push(`cvPlan.llmWorkSignal.evidenceId reference does not exist: ${llmEvidenceId}`);
  }
  if (llmCheckId && !checkIds.has(llmCheckId)) {
    errors.push(`cvPlan.llmWorkSignal.checkId reference does not exist: ${llmCheckId}`);
  }
  const llmCheck = checkById.get(llmCheckId);
  if (llmCheck) {
    if (!Array.isArray(llmCheck.evidenceIds) || !llmCheck.evidenceIds.includes(llmEvidenceId)) {
      errors.push(
        "cvPlan.llmWorkSignal.checkId must link its evidenceId in requiredEvidence.evidenceIds",
      );
    }
    const hasExperiencePlacement =
      Array.isArray(llmCheck.placements) &&
      llmCheck.placements.some((placement) => {
        const normalized = normalizeComparable(placement);
        return normalized === "experience" || normalized.startsWith("experience:");
      });
    if (!hasExperiencePlacement) {
      errors.push("cvPlan.llmWorkSignal check must target an Experience placement");
    }
    if (llmCheck.placementMode !== "all") {
      errors.push("cvPlan.llmWorkSignal check must use placementMode all");
    }
    const alternatives = Array.isArray(llmCheck.anyOf)
      ? llmCheck.anyOf.filter((term) => typeof term === "string" && term.trim())
      : [];
    if (
      alternatives.length &&
      alternatives.some((alternative) => !containsWholeTerm(alternative, "LLM"))
    ) {
      errors.push("every cvPlan.llmWorkSignal check anyOf alternative must explicitly contain LLM");
    }
  }
  const forbiddenTerms = requireArray(
    checks.forbiddenTerms,
    "cvPlan.checks.forbiddenTerms",
    errors,
  );
  const forbiddenTermValues = [];
  forbiddenTerms.forEach((entry, index) => {
    const path = `cvPlan.checks.forbiddenTerms[${index}]`;
    const item = requireObject(entry, path, errors);
    rejectUnknownKeys(item, path, errors, ["term", "reason"]);
    const term = requireString(item.term, `cvPlan.checks.forbiddenTerms[${index}].term`, errors);
    if (term) forbiddenTermValues.push(term);
    requireString(item.reason, `cvPlan.checks.forbiddenTerms[${index}].reason`, errors);
  });
  const skillGroups = requireArray(checks.skillGroups, "cvPlan.checks.skillGroups", errors);
  skillGroups.forEach((group, index) => {
    const path = `cvPlan.checks.skillGroups[${index}]`;
    const item = requireObject(group, path, errors);
    rejectUnknownKeys(item, path, errors, ["label", "mustContain", "forbiddenLabels"]);
    requireString(item.label, `cvPlan.checks.skillGroups[${index}].label`, errors);
    requireStringArray(
      item.mustContain,
      `cvPlan.checks.skillGroups[${index}].mustContain`,
      errors,
      { min: 1 },
    );
    requireStringArray(
      item.forbiddenLabels,
      `cvPlan.checks.skillGroups[${index}].forbiddenLabels`,
      errors,
    );
  });

  const rejectPlacement = (items, field, path, placement, reason) => {
    items.forEach((item, index) => {
      if (hasPlacement(item, field, placement)) {
        errors.push(`${path}[${index}].${field} cannot target ${placement} ${reason}`);
      }
    });
  };
  if (cvPlan.structure === "chronological") {
    const reason = "when cvPlan.structure is chronological";
    rejectPlacement(
      evidence,
      "cvPlacements",
      "experience.priorityEvidence",
      "Selected Impact",
      reason,
    );
    rejectPlacement(keywords, "placements", "ats.keywords", "Selected Impact", reason);
    rejectPlacement(
      requiredEvidence,
      "placements",
      "cvPlan.checks.requiredEvidence",
      "Selected Impact",
      reason,
    );
  }
  if (projectDecision.decision === "exclude") {
    const reason = "when cvPlan.projectDecision is exclude";
    rejectPlacement(evidence, "cvPlacements", "experience.priorityEvidence", "Projects", reason);
    rejectPlacement(keywords, "placements", "ats.keywords", "Projects", reason);
    rejectPlacement(
      requiredEvidence,
      "placements",
      "cvPlan.checks.requiredEvidence",
      "Projects",
      reason,
    );
  } else if (
    projectDecision.decision === "include" &&
    !requiredEvidence.some((check) => hasPlacement(check, "placements", "Projects"))
  ) {
    errors.push(
      "cvPlan.projectDecision include requires at least one cvPlan.checks.requiredEvidence check targeting Projects",
    );
  }

  keywords.forEach((keyword, index) => {
    if (
      keyword?.required &&
      forbiddenTermValues.some((forbiddenTerm) => containsWholeTerm(keyword.term, forbiddenTerm))
    ) {
      errors.push(
        `ats.keywords[${index}].term conflicts with cvPlan.checks.forbiddenTerms: ${keyword.term}`,
      );
    }
  });
  requiredEvidence.forEach((check, index) => {
    const alternatives = Array.isArray(check?.anyOf)
      ? check.anyOf.filter((term) => typeof term === "string" && term.trim())
      : [];
    if (
      alternatives.length &&
      alternatives.every((alternative) =>
        forbiddenTermValues.some((forbiddenTerm) => containsWholeTerm(alternative, forbiddenTerm)),
      )
    ) {
      errors.push(
        `cvPlan.checks.requiredEvidence[${index}].anyOf is unsatisfiable because every alternative conflicts with forbiddenTerms`,
      );
    }
  });

  // All plans use IDs/terms from their canonical arrays rather than copying evidence or keyword text.
  // Rejecting dangling references keeps the compact handoff deterministic for isolated consumers.
  for (const id of referencedCheckIds.filter(Boolean)) {
    if (!checkIds.has(id)) errors.push(`referenced cvEvidenceCheckId does not exist: ${id}`);
  }
  selectedLevers.forEach((lever, leverIndex) => {
    const anchorIds = new Set(Array.isArray(lever?.evidenceAnchors) ? lever.evidenceAnchors : []);
    for (const checkId of Array.isArray(lever?.cvEvidenceCheckIds)
      ? lever.cvEvidenceCheckIds
      : []) {
      const check = checkById.get(checkId);
      if (
        check &&
        Array.isArray(check.evidenceIds) &&
        !check.evidenceIds.some((evidenceId) => anchorIds.has(evidenceId))
      ) {
        errors.push(
          `positioning.selectedLevers[${leverIndex}].cvEvidenceCheckIds ${checkId} ` +
            "must link at least one selected lever evidence anchor",
        );
      }
    }
  });

  const coverLetterPlan = requireObject(brief.coverLetterPlan, "coverLetterPlan", errors);
  rejectUnknownKeys(coverLetterPlan, "coverLetterPlan", errors, ["evidenceIds", "keywordTerms"]);
  const coverEvidenceIds = requireStringArray(
    coverLetterPlan.evidenceIds,
    "coverLetterPlan.evidenceIds",
    errors,
    { min: 1, max: 2 },
  );
  const seenCoverEvidenceIds = new Set();
  for (const id of coverEvidenceIds.filter((value) => typeof value === "string" && value.trim())) {
    if (seenCoverEvidenceIds.has(id))
      errors.push(`duplicate coverLetterPlan.evidenceIds reference: ${id}`);
    seenCoverEvidenceIds.add(id);
    if (!evidenceIds.has(id))
      errors.push(`coverLetterPlan.evidenceIds reference does not exist: ${id}`);
  }

  const coverKeywordTerms = requireStringArray(
    coverLetterPlan.keywordTerms,
    "coverLetterPlan.keywordTerms",
    errors,
    { min: 3, max: 5 },
  );
  const seenCoverKeywordTerms = new Set();
  for (const term of coverKeywordTerms.filter(
    (value) => typeof value === "string" && value.trim(),
  )) {
    if (seenCoverKeywordTerms.has(term))
      errors.push(`duplicate coverLetterPlan.keywordTerms reference: ${term}`);
    seenCoverKeywordTerms.add(term);
    if (!keywordTerms.has(term))
      errors.push(`coverLetterPlan.keywordTerms exact reference does not exist: ${term}`);
  }

  return errors;
}

export function readAndValidateApplicationBrief(path, options = {}) {
  const brief = JSON.parse(readFileSync(path, "utf8"));
  const errors = validateApplicationBrief(brief, options);
  if (errors.length)
    throw new Error(`application brief validation failed:\n- ${errors.join("\n- ")}`);
  return brief;
}

export function readAndValidateApplicationBriefBundle(
  briefPath,
  vacancyPath,
  jobDescriptionPath,
  companyResearchPath,
  candidateProfilePath,
  candidateLeversPath,
  options = {},
) {
  const vacancyBytes = readFileSync(vacancyPath);
  const jobDescriptionBytes = readFileSync(jobDescriptionPath);
  const companyResearchBytes = readFileSync(companyResearchPath);
  const candidateProfileBytes = readFileSync(candidateProfilePath);
  const candidateLeversBytes = readFileSync(candidateLeversPath);
  const brief = readAndValidateApplicationBrief(briefPath, {
    ...options,
    vacancyBytes,
    jobDescriptionBytes,
    companyResearchBytes,
    candidateProfileBytes,
    candidateLeversBytes,
    requireInputBytes: true,
  });
  return {
    brief,
    vacancyBytes,
    jobDescriptionBytes,
    companyResearchBytes,
    candidateProfileBytes,
    candidateLeversBytes,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 && args.length !== 6) {
    throw new Error(
      "Usage: node tools/application-brief/validate.mjs <application-brief.json> " +
        "[<vacancy.json> <job-description.txt> <company-research.json> <candidate-profile.md> " +
        "<candidate-levers.md>]",
    );
  }
  const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const candidateRoot = candidateRootForCommand(checkoutRoot);
  const options = {
    languages: candidateLanguageNames({ root: candidateRoot }),
    markets: candidateMarkets({ root: candidateRoot }),
  };
  const brief =
    args.length === 1
      ? readAndValidateApplicationBrief(args[0], options)
      : readAndValidateApplicationBriefBundle(...args, options).brief;
  console.log(
    JSON.stringify(
      {
        status: "valid",
        schemaVersion: brief.schemaVersion,
        processId: brief.process.id,
        outputDir: brief.process.outputDir,
        keywords: brief.ats.keywords.length,
        selectedLevers: brief.positioning.selectedLevers.map((lever) => lever.id),
        cvStructure: brief.cvPlan.structure,
        llmWorkCheck: brief.cvPlan.llmWorkSignal.checkId,
        validationMode: args.length === 1 ? "structural" : "bundle",
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
