#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { candidateLanguageNames, candidateMarkets, candidateRootForCommand } from "../candidate/load.mjs";
import { MARKET_SIDES } from "../candidate/markets.mjs";
import {
  parseJsonBytes,
  validateArray,
  validateEnum,
  validateFileReference,
  validateHttpUrl,
  validateIsoTimestamp,
  validateNullableString,
  validateOutputDir,
  validateStrictObject,
  validateString,
  validateStringArray,
} from "./validation.mjs";
import {
  VACANCY_SCHEMA_VERSIONS,
  vacancyMarketSide,
  validateVacancy,
} from "./validate-vacancy.mjs";

export const RESEARCH_SCHEMA_VERSION = 2;

export const RESEARCH_CATEGORIES = Object.freeze([
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

export const RESEARCH_SCHEMA_VERSIONS = Object.freeze([RESEARCH_SCHEMA_VERSION]);

export const ANALYSIS_BLOCKS = [
  "companyOverview",
  "productTechnicalComplexity",
  "engineeringCultureSignals",
  "companyValuesCulture",
  "keyPeople",
  "aiLiteracyEvidence",
  "compensationFacts",
  "contractorPaymentFacts",
  "interviewProcessFacts",
  "riskSignals",
  "whatCompanyValuesInEngineers",
];

const COVERAGE_STATUSES = ["checked", "not-found", "blocked", "n/a"];
const CONFIDENCE_VALUES = ["high", "medium", "low", "none", "not-applicable"];
const SOURCE_TYPES = [
  "company_website",
  "company_values",
  "company_engineering",
  "company_careers",
  "job_board",
  "source_code_host",
  "leadership_profile",
  "employee_profile",
  "review_platform",
  "compensation_platform",
  "news_media",
  "conference_media",
  "payment_or_legal",
  "other_primary",
];
const EVIDENCE_STATUSES = ["verified", "unverified", "inferred"];
const AI_CLASSIFICATIONS = ["AI-literate", "AI-adjacent", "not-AI", "unknown"];
const DECISION_WEIGHTS = ["high", "medium", "low"];
const GATE_STATUSES = ["pass", "blocked"];
const INVARIANT_IDS = [
  "source_coverage",
  "evidence_integrity",
  "analysis_and_handoffs",
  "responsibility_boundary",
];
const OUTCOME_VALUES = ["completed", "blocked"];

function validateIdentifier(value, path, errors, pattern, description) {
  const identifier = validateString(value, path, errors);
  if (identifier && !pattern.test(identifier)) errors.push(`${path} must be ${description}`);
  return identifier;
}

function validateUniqueStrings(items, path, errors) {
  const seen = new Set();
  for (const item of items) {
    if (typeof item !== "string" || !item.trim()) continue;
    if (seen.has(item)) errors.push(`${path} contains duplicate value: ${item}`);
    seen.add(item);
  }
  return seen;
}

function requireEmpty(items, path, status, errors) {
  if (items.length) errors.push(`${path} must be empty when status is ${status}`);
}

function validateExpectedProcess(process, expectedProcess, errors) {
  if (expectedProcess === undefined) return;
  for (const key of ["id", "sourceRef", "outputDir"]) {
    if (expectedProcess[key] !== undefined && process[key] !== expectedProcess[key]) {
      errors.push(`process.${key} does not match the selected ledger process`);
    }
  }
}

function validateCoverage(value, companyVariants, market, errors) {
  const rows = validateArray(value, "sourceCoverage", errors);
  const coverageByCategory = new Map();

  rows.forEach((entry, index) => {
    const path = `sourceCoverage[${index}]`;
    const row = validateStrictObject(
      entry,
      path,
      errors,
      [
        "category",
        "status",
        "sourceIds",
        "openedPrimaryUrls",
        "queries",
        "nameVariants",
        "fallbackAttempted",
        "confidence",
        "details",
      ],
    );
    validateEnum(row.category, `${path}.category`, errors, RESEARCH_CATEGORIES);
    let storesCategory = false;
    if (RESEARCH_CATEGORIES.includes(row.category)) {
      if (coverageByCategory.has(row.category)) {
        errors.push(`duplicate sourceCoverage category: ${row.category}`);
      } else {
        storesCategory = true;
      }
    }
    validateEnum(row.status, `${path}.status`, errors, COVERAGE_STATUSES);
    const sourceIds = validateStringArray(row.sourceIds, `${path}.sourceIds`, errors);
    const openedUrls = validateStringArray(row.openedPrimaryUrls, `${path}.openedPrimaryUrls`, errors);
    openedUrls.forEach((url, urlIndex) => {
      validateHttpUrl(url, `${path}.openedPrimaryUrls[${urlIndex}]`, errors);
    });
    const queries = validateStringArray(row.queries, `${path}.queries`, errors);
    const nameVariants = validateStringArray(row.nameVariants, `${path}.nameVariants`, errors);
    validateUniqueStrings(sourceIds, `${path}.sourceIds`, errors);
    validateUniqueStrings(openedUrls, `${path}.openedPrimaryUrls`, errors);
    validateUniqueStrings(queries, `${path}.queries`, errors);
    validateUniqueStrings(nameVariants, `${path}.nameVariants`, errors);
    for (const nameVariant of nameVariants) {
      if (!companyVariants.has(nameVariant)) {
        errors.push(`${path}.nameVariants reference is missing from companyNameVariants: ${nameVariant}`);
      }
    }
    validateNullableString(row.fallbackAttempted, `${path}.fallbackAttempted`, errors);
    validateEnum(row.confidence, `${path}.confidence`, errors, CONFIDENCE_VALUES);
    validateString(row.details, `${path}.details`, errors);

    if (row.status === "checked") {
      if (!sourceIds.length) errors.push(`${path}.sourceIds must contain primary sources when checked`);
      if (!openedUrls.length) errors.push(`${path}.openedPrimaryUrls must contain primary URLs when checked`);
      if (row.fallbackAttempted !== null) errors.push(`${path}.fallbackAttempted must be null when checked`);
      if (row.confidence === "not-applicable") {
        errors.push(`${path}.confidence cannot be not-applicable when checked`);
      }
    } else if (row.status === "not-found") {
      requireEmpty(sourceIds, `${path}.sourceIds`, row.status, errors);
      requireEmpty(openedUrls, `${path}.openedPrimaryUrls`, row.status, errors);
      if (!queries.length) errors.push(`${path}.queries must document exact searches when not-found`);
      if (!nameVariants.length) errors.push(`${path}.nameVariants must document searched names when not-found`);
      if (row.fallbackAttempted !== null) errors.push(`${path}.fallbackAttempted must be null when not-found`);
      if (row.confidence === "not-applicable") {
        errors.push(`${path}.confidence cannot be not-applicable when not-found`);
      }
    } else if (row.status === "blocked") {
      requireEmpty(sourceIds, `${path}.sourceIds`, row.status, errors);
      requireEmpty(openedUrls, `${path}.openedPrimaryUrls`, row.status, errors);
      if (!queries.length) errors.push(`${path}.queries must document the blocked discovery route`);
      if (!nameVariants.length) errors.push(`${path}.nameVariants must document names tried when blocked`);
      if (row.fallbackAttempted === null) errors.push(`${path}.fallbackAttempted is required when blocked`);
      if (row.confidence === "not-applicable") {
        errors.push(`${path}.confidence cannot be not-applicable when blocked`);
      }
    } else if (row.status === "n/a") {
      requireEmpty(sourceIds, `${path}.sourceIds`, row.status, errors);
      requireEmpty(openedUrls, `${path}.openedPrimaryUrls`, row.status, errors);
      requireEmpty(queries, `${path}.queries`, row.status, errors);
      requireEmpty(nameVariants, `${path}.nameVariants`, row.status, errors);
      if (row.fallbackAttempted !== null) errors.push(`${path}.fallbackAttempted must be null when n/a`);
      if (row.confidence !== "not-applicable") {
        errors.push(`${path}.confidence must be not-applicable when n/a`);
      }
      if (row.category !== "contractor_payment_logistics" || market.side !== MARKET_SIDES.home) {
        errors.push(`${path}.status n/a is allowed only for contractor_payment_logistics on the home market`);
      }
    }
    if (storesCategory) {
      coverageByCategory.set(row.category, {
        ...row,
        sourceIds,
        openedPrimaryUrls: openedUrls,
        queries,
        nameVariants,
      });
    }
  });

  for (const category of RESEARCH_CATEGORIES) {
    if (!coverageByCategory.has(category)) {
      errors.push(`sourceCoverage is missing category: ${category}`);
    }
  }
  if (rows.length !== RESEARCH_CATEGORIES.length) {
    errors.push(`sourceCoverage must contain exactly ${RESEARCH_CATEGORIES.length} rows`);
  }

  const logistics = coverageByCategory.get("contractor_payment_logistics");
  if (market.side === MARKET_SIDES.home && logistics?.status !== "n/a") {
    errors.push("contractor_payment_logistics must be n/a for the home market");
  }
  if (market.side === MARKET_SIDES.outsideHome && logistics?.status === "n/a") {
    errors.push("contractor_payment_logistics must be researched for a market outside home");
  }

  return coverageByCategory;
}

function validateSources(value, coverageByCategory, errors) {
  const entries = validateArray(value, "sources", errors);
  const sourcesById = new Map();
  const sourceIdsByUrl = new Map();

  entries.forEach((entry, index) => {
    const path = `sources[${index}]`;
    const source = validateStrictObject(
      entry,
      path,
      errors,
      ["id", "category", "url", "title", "owner", "observedAt", "sourceType", "quotes", "notes"],
    );
    const id = validateIdentifier(source.id, `${path}.id`, errors, /^S\d{2,}$/, "an id such as S01");
    if (id && sourcesById.has(id)) errors.push(`duplicate source id: ${id}`);
    if (id && !sourcesById.has(id)) sourcesById.set(id, source);
    validateEnum(source.category, `${path}.category`, errors, RESEARCH_CATEGORIES);
    const url = validateHttpUrl(source.url, `${path}.url`, errors);
    if (url && sourceIdsByUrl.has(url)) {
      errors.push(`${path}.url duplicates source ${sourceIdsByUrl.get(url)}: ${url}`);
    } else if (url) {
      sourceIdsByUrl.set(url, id);
    }
    validateString(source.title, `${path}.title`, errors);
    validateString(source.owner, `${path}.owner`, errors);
    validateIsoTimestamp(source.observedAt, `${path}.observedAt`, errors);
    validateEnum(source.sourceType, `${path}.sourceType`, errors, SOURCE_TYPES);
    const quotes = validateArray(source.quotes, `${path}.quotes`, errors);
    quotes.forEach((entryQuote, quoteIndex) => {
      const quotePath = `${path}.quotes[${quoteIndex}]`;
      const quote = validateStrictObject(
        entryQuote,
        quotePath,
        errors,
        ["original", "translation"],
      );
      validateString(quote.original, `${quotePath}.original`, errors);
      validateString(quote.translation, `${quotePath}.translation`, errors);
    });
    validateNullableString(source.notes, `${path}.notes`, errors);

    const coverage = coverageByCategory.get(source.category);
    if (coverage?.status !== "checked") {
      errors.push(`${path} must belong to a checked sourceCoverage category`);
    }
    if (id && !coverage?.sourceIds?.includes(id)) {
      errors.push(`${path}.id is not listed by its sourceCoverage row: ${id}`);
    }
    if (url && !coverage?.openedPrimaryUrls?.includes(url)) {
      errors.push(`${path}.url is not listed by its sourceCoverage row: ${url}`);
    }
  });

  for (const [category, coverage] of coverageByCategory) {
    if (coverage.status !== "checked") continue;
    const coverageSourceIds = coverage.sourceIds ?? [];
    const coverageUrls = coverage.openedPrimaryUrls ?? [];
    for (const sourceId of coverageSourceIds) {
      const source = sourcesById.get(sourceId);
      if (!source) {
        errors.push(`sourceCoverage.${category}.sourceIds reference does not exist: ${sourceId}`);
      }
    }
    const expectedUrls = new Set(
      coverageSourceIds.map((sourceId) => sourcesById.get(sourceId)?.url).filter(Boolean),
    );
    for (const url of coverageUrls) {
      if (!expectedUrls.has(url)) {
        errors.push(`sourceCoverage.${category}.openedPrimaryUrls has no matching source record: ${url}`);
      }
    }
    if (category === "stated_values") {
      const hasQuote = coverageSourceIds.some((sourceId) => {
        const quotes = sourcesById.get(sourceId)?.quotes;
        return Array.isArray(quotes) && quotes.length > 0;
      });
      if (!hasQuote) errors.push("checked stated_values coverage requires an original quote and its translation");
    }
    if (category === "other_vacancies" && coverageSourceIds.length < 2) {
      errors.push("checked other_vacancies coverage requires at least two primary board sources");
    }
    if (
      category === "employee_profiles"
      && (coverageSourceIds.length < 2 || coverageSourceIds.length > 4)
    ) {
      errors.push("checked employee_profiles coverage requires two to four current profiles");
    }
  }

  return sourcesById;
}

function validateClaim(
  entry,
  path,
  errors,
  state,
) {
  const claim = validateStrictObject(
    entry,
    path,
    errors,
    ["id", "text", "evidenceStatus", "sourceIds", "inferenceBasis", "scope"],
  );
  const id = validateIdentifier(claim.id, `${path}.id`, errors, /^C\d{2,}$/, "an id such as C01");
  if (id && state.claimsById.has(id)) errors.push(`duplicate claim id: ${id}`);
  if (id && !state.claimsById.has(id)) state.claimsById.set(id, claim);
  validateString(claim.text, `${path}.text`, errors);
  validateEnum(claim.evidenceStatus, `${path}.evidenceStatus`, errors, EVIDENCE_STATUSES);
  const sourceIds = validateStringArray(claim.sourceIds, `${path}.sourceIds`, errors);
  validateUniqueStrings(sourceIds, `${path}.sourceIds`, errors);
  validateNullableString(claim.inferenceBasis, `${path}.inferenceBasis`, errors);
  validateNullableString(claim.scope, `${path}.scope`, errors);

  for (const sourceId of sourceIds) {
    const source = state.sourcesById.get(sourceId);
    if (!source) {
      errors.push(`${path}.sourceIds reference does not exist: ${sourceId}`);
    } else if (
      claim.evidenceStatus === "verified"
      && state.coverageByCategory.get(source.category)?.status !== "checked"
    ) {
      errors.push(`${path} verified claim must resolve to a checked primary source: ${sourceId}`);
    }
  }
  if (claim.evidenceStatus === "verified" && !sourceIds.length) {
    errors.push(`${path}.sourceIds must contain at least one checked primary source when verified`);
  }
  if (claim.evidenceStatus === "inferred" && claim.inferenceBasis === null) {
    errors.push(`${path}.inferenceBasis is required when inferred`);
  }
  if (claim.evidenceStatus !== "inferred" && claim.inferenceBasis !== null) {
    errors.push(`${path}.inferenceBasis must be null unless inferred`);
  }
  return claim;
}

function validateAnalysis(value, coverageByCategory, sourcesById, errors) {
  const analysis = validateStrictObject(value, "analysis", errors, ANALYSIS_BLOCKS);
  const state = {
    claimsById: new Map(),
    coverageByCategory,
    sourcesById,
  };

  for (const blockName of ANALYSIS_BLOCKS) {
    const path = `analysis.${blockName}`;
    const allowedKeys = blockName === "aiLiteracyEvidence"
      ? ["summary", "classification", "claims"]
      : ["summary", "claims"];
    const block = validateStrictObject(analysis[blockName], path, errors, allowedKeys);
    validateString(block.summary, `${path}.summary`, errors);
    if (blockName === "aiLiteracyEvidence") {
      validateEnum(block.classification, `${path}.classification`, errors, AI_CLASSIFICATIONS);
    }
    const claims = validateArray(block.claims, `${path}.claims`, errors);
    const validatedClaims = claims.map((claim, index) => validateClaim(
      claim,
      `${path}.claims[${index}]`,
      errors,
      state,
    ));
    if (
      blockName === "aiLiteracyEvidence"
      && block.classification !== "unknown"
      && !validatedClaims.some((claim) => claim.evidenceStatus === "verified")
    ) {
      errors.push(`${path}.classification ${block.classification} requires a verified claim`);
    }
    if (blockName === "whatCompanyValuesInEngineers") {
      validatedClaims.forEach((claim, index) => {
        if (claim.evidenceStatus !== "verified") {
          errors.push(`${path}.claims[${index}] must be source-backed and verified`);
        }
      });
    }
  }

  return state.claimsById;
}

function validateTailoringHooks(value, claimsById, sourcesById, errors) {
  const hooks = validateArray(value, "tailoringHooks", errors, { max: 5 });
  const hookIds = new Set();
  hooks.forEach((entry, index) => {
    const path = `tailoringHooks[${index}]`;
    const hook = validateStrictObject(
      entry,
      path,
      errors,
      ["id", "challengeType", "fact", "claimIds", "sourceIds"],
    );
    const id = validateIdentifier(hook.id, `${path}.id`, errors, /^H\d{2,}$/, "an id such as H01");
    if (id && hookIds.has(id)) errors.push(`duplicate tailoring hook id: ${id}`);
    if (id) hookIds.add(id);
    validateString(hook.challengeType, `${path}.challengeType`, errors);
    validateString(hook.fact, `${path}.fact`, errors);
    const claimIds = validateStringArray(hook.claimIds, `${path}.claimIds`, errors, { min: 1 });
    const sourceIds = validateStringArray(hook.sourceIds, `${path}.sourceIds`, errors, { min: 1 });
    validateUniqueStrings(claimIds, `${path}.claimIds`, errors);
    validateUniqueStrings(sourceIds, `${path}.sourceIds`, errors);
    const linkedClaimSourceIds = new Set();
    for (const claimId of claimIds) {
      const claim = claimsById.get(claimId);
      if (!claim) {
        errors.push(`${path}.claimIds reference does not exist: ${claimId}`);
      } else {
        for (const sourceId of claim.sourceIds ?? []) linkedClaimSourceIds.add(sourceId);
      }
    }
    for (const sourceId of sourceIds) {
      if (!sourcesById.has(sourceId)) {
        errors.push(`${path}.sourceIds reference does not exist: ${sourceId}`);
      } else if (!linkedClaimSourceIds.has(sourceId)) {
        errors.push(`${path}.sourceIds must be supported by a linked claim: ${sourceId}`);
      }
    }
  });
  return hooks;
}

function validateOpenQuestions(value, errors) {
  const questions = validateArray(value, "openQuestions", errors);
  const questionIds = new Set();
  let priorWeight = -1;
  questions.forEach((entry, index) => {
    const path = `openQuestions[${index}]`;
    const question = validateStrictObject(
      entry,
      path,
      errors,
      ["id", "decisionWeight", "question"],
    );
    const id = validateIdentifier(question.id, `${path}.id`, errors, /^Q\d{2,}$/, "an id such as Q01");
    if (id && questionIds.has(id)) errors.push(`duplicate open question id: ${id}`);
    if (id) questionIds.add(id);
    validateEnum(question.decisionWeight, `${path}.decisionWeight`, errors, DECISION_WEIGHTS);
    validateString(question.question, `${path}.question`, errors);
    const weight = DECISION_WEIGHTS.indexOf(question.decisionWeight);
    if (weight !== -1 && weight < priorWeight) {
      errors.push("openQuestions must be ordered by decision weight: high, medium, low");
    }
    if (weight !== -1) priorWeight = weight;
  });
}

function validateVerifyGate(value, errors) {
  const gate = validateStrictObject(
    value,
    "verifyGate",
    errors,
    ["status", "checkedInvariants", "unrecoverableGaps"],
  );
  validateEnum(gate.status, "verifyGate.status", errors, GATE_STATUSES);
  const invariants = validateArray(gate.checkedInvariants, "verifyGate.checkedInvariants", errors);
  const invariantStates = new Map();
  invariants.forEach((entry, index) => {
    const path = `verifyGate.checkedInvariants[${index}]`;
    const invariant = validateStrictObject(entry, path, errors, ["id", "status"]);
    validateEnum(invariant.id, `${path}.id`, errors, INVARIANT_IDS);
    validateEnum(invariant.status, `${path}.status`, errors, GATE_STATUSES);
    if (INVARIANT_IDS.includes(invariant.id)) {
      if (invariantStates.has(invariant.id)) {
        errors.push(`duplicate verifyGate invariant: ${invariant.id}`);
      } else {
        invariantStates.set(invariant.id, invariant.status);
      }
    }
  });
  for (const invariantId of INVARIANT_IDS) {
    if (!invariantStates.has(invariantId)) {
      errors.push(`verifyGate.checkedInvariants is missing invariant: ${invariantId}`);
    }
  }
  if (invariants.length !== INVARIANT_IDS.length) {
    errors.push(`verifyGate.checkedInvariants must contain exactly ${INVARIANT_IDS.length} rows`);
  }

  const gaps = validateArray(gate.unrecoverableGaps, "verifyGate.unrecoverableGaps", errors);
  const gapCodes = new Set();
  gaps.forEach((entry, index) => {
    const path = `verifyGate.unrecoverableGaps[${index}]`;
    const gap = validateStrictObject(entry, path, errors, ["code", "invariantId", "description"]);
    const code = validateIdentifier(
      gap.code,
      `${path}.code`,
      errors,
      /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
      "a stable snake_case code",
    );
    if (code && gapCodes.has(code)) errors.push(`duplicate verifyGate gap code: ${code}`);
    if (code) gapCodes.add(code);
    validateEnum(gap.invariantId, `${path}.invariantId`, errors, INVARIANT_IDS);
    validateString(gap.description, `${path}.description`, errors);
    if (invariantStates.get(gap.invariantId) !== "blocked") {
      errors.push(`${path}.invariantId must reference a blocked checked invariant`);
    }
  });

  const blockedInvariants = [...invariantStates.values()].filter((status) => status === "blocked");
  if (gate.status === "pass") {
    if (blockedInvariants.length) errors.push("verifyGate.status pass requires every invariant to pass");
    if (gaps.length) errors.push("verifyGate.unrecoverableGaps must be empty when status is pass");
  } else if (gate.status === "blocked") {
    if (!blockedInvariants.length) errors.push("verifyGate.status blocked requires a blocked invariant");
    if (!gaps.length) errors.push("verifyGate.status blocked requires at least one unrecoverable gap");
  }
  return gate;
}

export function validateCompanyResearch(
  research,
  {
    vacancyBytes,
    jobDescriptionBytes,
    expectedProcess,
    expectedSchemaVersion,
    languages,
    markets,
    outcome,
  } = {},
) {
  const errors = [];
  const root = validateStrictObject(
    research,
    "companyResearch",
    errors,
    [
      "schemaVersion",
      "createdAt",
      "process",
      "inputs",
      "companyNameVariants",
      "sourceCoverage",
      "sources",
      "analysis",
      "tailoringHooks",
      "openQuestions",
      "verifyGate",
    ],
  );
  if (!RESEARCH_SCHEMA_VERSIONS.includes(root.schemaVersion)) {
    errors.push(`schemaVersion must be one of: ${RESEARCH_SCHEMA_VERSIONS.join(", ")}`);
  } else if (expectedSchemaVersion !== undefined && root.schemaVersion !== expectedSchemaVersion) {
    errors.push(`schemaVersion must equal ${JSON.stringify(expectedSchemaVersion)}`);
  }
  validateIsoTimestamp(root.createdAt, "createdAt", errors);

  const process = validateStrictObject(
    root.process,
    "process",
    errors,
    ["id", "sourceRef", "outputDir"],
  );
  validateString(process.id, "process.id", errors);
  validateString(process.sourceRef, "process.sourceRef", errors);
  validateOutputDir(process.outputDir, "process.outputDir", errors);
  validateExpectedProcess(process, expectedProcess, errors);

  const inputs = validateStrictObject(root.inputs, "inputs", errors, ["vacancy", "jobDescription"]);
  if (vacancyBytes === undefined) errors.push("vacancy.json bytes are required for bundle validation");
  if (jobDescriptionBytes === undefined) {
    errors.push("job-description.txt bytes are required for bundle validation");
  }
  // The research names the version of the vacancy it was written over, checked against the bytes
  // below.
  validateFileReference(inputs.vacancy, "inputs.vacancy", errors, {
    expectedPath: "vacancy.json",
    contentBytes: vacancyBytes,
  });
  validateFileReference(inputs.jobDescription, "inputs.jobDescription", errors, {
    expectedPath: "job-description.txt",
    expectedSchemaVersion: null,
    contentBytes: jobDescriptionBytes,
  });

  const parsedVacancy = vacancyBytes === undefined
    ? undefined
    : parseJsonBytes(vacancyBytes, "vacancy.json", errors);
  const referenceVersion = inputs.vacancy?.schemaVersion;
  if (!VACANCY_SCHEMA_VERSIONS.includes(referenceVersion)) {
    errors.push(`inputs.vacancy.schemaVersion must be one of: ${VACANCY_SCHEMA_VERSIONS.join(", ")}`);
  } else if (
    VACANCY_SCHEMA_VERSIONS.includes(parsedVacancy?.schemaVersion)
    && referenceVersion !== parsedVacancy.schemaVersion
  ) {
    errors.push(
      "inputs.vacancy.schemaVersion must equal "
      + `${parsedVacancy.schemaVersion}, the schemaVersion of vacancy.json`,
    );
  }
  if (parsedVacancy !== undefined) {
    const vacancyErrors = validateVacancy(parsedVacancy, {
      jobDescriptionBytes,
      expectedProcess: process,
      languages,
      markets,
      outcome: "completed",
    });
    errors.push(...vacancyErrors.map((error) => `inputs.vacancy content: ${error}`));
  }
  const market = Object.freeze({ side: vacancyMarketSide(parsedVacancy, markets) });

  const companyVariants = validateStringArray(
    root.companyNameVariants,
    "companyNameVariants",
    errors,
    { min: 1 },
  );
  const companyVariantSet = validateUniqueStrings(
    companyVariants,
    "companyNameVariants",
    errors,
  );
  const observedCompany = parsedVacancy?.role?.company;
  if (observedCompany && !companyVariantSet.has(observedCompany)) {
    errors.push(`companyNameVariants must include the observed vacancy company: ${observedCompany}`);
  }

  const coverageByCategory = validateCoverage(
    root.sourceCoverage,
    companyVariantSet,
    market,
    errors,
  );
  const sourcesById = validateSources(root.sources, coverageByCategory, errors);
  const claimsById = validateAnalysis(root.analysis, coverageByCategory, sourcesById, errors);
  const hooks = validateTailoringHooks(root.tailoringHooks, claimsById, sourcesById, errors);
  validateOpenQuestions(root.openQuestions, errors);
  const gate = validateVerifyGate(root.verifyGate, errors);

  if (gate.status === "pass" && hooks.length < 3) {
    errors.push("tailoringHooks must contain three to five factual hooks when verifyGate passes");
  }
  if (outcome !== undefined && !OUTCOME_VALUES.includes(outcome)) {
    errors.push(`outcome must be one of: ${OUTCOME_VALUES.join(", ")}`);
  } else if (outcome === "completed" && gate.status !== "pass") {
    errors.push("completed company research requires verifyGate.status pass");
  } else if (outcome === "blocked" && gate.status !== "blocked") {
    errors.push("blocked company research requires verifyGate.status blocked");
  }

  return errors;
}

export function readAndValidateCompanyResearchBundle(
  researchPath,
  vacancyPath,
  jobDescriptionPath,
  options = {},
) {
  const research = JSON.parse(readFileSync(researchPath, "utf8"));
  const vacancyBytes = readFileSync(vacancyPath);
  const jobDescriptionBytes = readFileSync(jobDescriptionPath);
  const errors = validateCompanyResearch(research, {
    ...options,
    vacancyBytes,
    jobDescriptionBytes,
  });
  if (errors.length) {
    throw new Error(`company research artifact validation failed:\n- ${errors.join("\n- ")}`);
  }
  return { research, vacancyBytes, jobDescriptionBytes };
}

function main() {
  const args = process.argv.slice(2);
  const outcomeIndex = args.indexOf("--outcome");
  let outcome;
  if (outcomeIndex !== -1) {
    outcome = args[outcomeIndex + 1];
    args.splice(outcomeIndex, 2);
  }
  if (args.length !== 3 || (outcomeIndex !== -1 && outcome === undefined)) {
    throw new Error(
      "Usage: node tools/pipeline-artifacts/validate-company-research.mjs "
      + "<company-research.json> <vacancy.json> <job-description.txt> "
      + "[--outcome completed|blocked]",
    );
  }

  const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const candidateRoot = candidateRootForCommand(checkoutRoot);
  const languages = candidateLanguageNames({ root: candidateRoot });
  const markets = candidateMarkets({ root: candidateRoot });
  const { research } = readAndValidateCompanyResearchBundle(
    args[0],
    args[1],
    args[2],
    { languages, markets, outcome },
  );
  const coverageCounts = Object.fromEntries(
    COVERAGE_STATUSES.map((status) => [
      status,
      research.sourceCoverage.filter((row) => row.status === status).length,
    ]),
  );
  console.log(JSON.stringify({
    status: "valid",
    schemaVersion: research.schemaVersion,
    processId: research.process.id,
    outputDir: research.process.outputDir,
    outcome: outcome ?? "capture",
    verifyGate: research.verifyGate.status,
    coverage: coverageCounts,
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
