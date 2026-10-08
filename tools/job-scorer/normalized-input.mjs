/**
 * Strict input epochs: 9 for triage-policy-v8-2026-10-01 and 10 for source context.
 * Stack observations carry their scope and exact evidence. Independent prices are snapshotted.
 * Earlier inputs are refused, not migrated. Historical batches use their historical checkout;
 * triage verification reports policy_drift before reading them under a different mechanism.
 */
import { isCountryCode } from "./iso-3166.mjs";
import { CandidateError, validateCandidateScoring } from "../candidate/load.mjs";
import { DEFAULT_LANGUAGE } from "../candidate/default-language.mjs";
import { DOMAIN_FIT_DOMAINS, REFERENCE_RATE_PROVIDER } from "../candidate/scoring.mjs";
import {
  resolveLanguageName,
  resolveToolName,
  frameworkClassFor,
  isSupportingName,
  normalizeToolName,
} from "./tool-taxonomy.mjs";

export const NORMALIZED_INPUT_SCHEMA_VERSION = 10;
export const SUPPORTED_INPUT_SCHEMA_VERSIONS = Object.freeze([9, 10]);
export const LEGACY_TRIAGE_POLICY_ID = "triage-policy-v8-2026-10-01";
export const TRIAGE_POLICY_ID = "triage-policy-v9-2026-10-08";

export function inputPolicyId(version) {
  return version === 9 ? LEGACY_TRIAGE_POLICY_ID : version === 10 ? TRIAGE_POLICY_ID : null;
}

export function isSupportedInputEpoch(input) {
  return (
    inputPolicyId(input?.schemaVersion) !== null &&
    input.policyId === inputPolicyId(input.schemaVersion)
  );
}

const ACCESS_OUTCOMES = new Set(["usable", "technical_unavailable", "closed"]);
// `role.language` names the language of the description, as the candidate layer names its
// languages, or says it is none of them (`unsupported`) or unread (`unknown`). The names are the
// caller's `languages` — the default language and the configured ones; a caller that passes none
// gets the default language alone, which refuses more rather than less.
const LANGUAGE_VERDICTS = Object.freeze(["unsupported", "unknown"]);

function roleLanguages(languages = [DEFAULT_LANGUAGE.name]) {
  return new Set([...languages, ...LANGUAGE_VERDICTS]);
}
const ROLE_FAMILIES = new Set(["qa_testing", "other", "unknown"]);
const AUTOMATION_LEVELS = new Set([
  "primary",
  "major",
  "limited",
  "manual_only",
  "manager_only",
  "unknown",
]);
const SENIORITY_LEVELS = new Set(["senior", "mid", "lower", "junior", "unknown"]);
// knowledge/job-match-rules.md#34-d--domain-fit: a domain the candidate places, or one of the two the engine scores itself. Built from the
// config's own vocabulary, so a name the input accepts is always a name the scoring values place.
const DOMAIN_NAMES = new Set([...DOMAIN_FIT_DOMAINS, "irrelevant", "unclear"]);
const WORK_FORMATS = new Set(["Remote", "Hybrid", "On-site", "Unknown"]);
// HOME is the candidate's home region, the countries `candidate.config.mobility.home_region` names:
// it carries its own engagement paths and floors, and the engagement-path default table cannot be
// keyed without it (knowledge/job-match-rules.md#31-m--mobility--work-feasibility).
const COMPANY_REGIONS = new Set(["WEST", "HOME", "OTHER", "UNKNOWN"]);
const WEST_REGIONS = new Set(["US_CANADA", "EU_UK"]);
const TIMEZONES = new Set(["tz_any", "tz_local", "tz_home", "tz_unknown"]);
const TIMEZONE_DISTANCES = new Set(["near", "far", "unknown"]);
const SPONSORSHIP = new Set(["available", "unavailable", "unknown"]);
const WORK_AUTHORIZATION = new Set([
  "eligible",
  "required_existing",
  "explicitly_ineligible",
  "unknown",
]);
const RESIDENCE_RESTRICTIONS = new Set(["none", "compatible", "incompatible", "unknown"]);
const CONTRACTOR_ELIGIBILITY = new Set(["eligible", "ineligible", "unknown"]);
const RELOCATION_SUPPORT = new Set(["available", "unavailable", "unknown"]);
// `null` is a listing silent on its hiring model: knowledge/job-match-rules.md#22-accepted-triage-decision-record's default table is total over (format class,
// region), so the scorer supplies the default.
const ENGAGEMENT_PATHS = new Set([
  "outside_home_contractor",
  "home_employment",
  "home_contractor",
  "comparable_cost_employment",
  "relocation_employment",
]);
const COMPENSATION_MARKETS = new Set(["US", "UK", "Canada", "other", "unknown"]);
const SALARY_KINDS = new Set(["value", "range"]);
const BASIS_VALUES = new Set(["gross", "net", "unknown"]);
const PERIODS = new Set(["monthly", "annual", "hourly", "unknown"]);
const REQUIREMENTS = new Set(["required", "optional", "observed"]);
// knowledge/job-match-rules.md#7-decision-trace-contract: what the description says about AI, one axis for the company's product and one for the
// tester's own work. `none` is a read description that ties AI to that axis nowhere; `unknown` is a
// description the rubric does not read.
const AI_PRODUCT_VALUES = new Set(["tested_by_role", "in_product", "none", "unknown"]);
const AI_WORK_VALUES = new Set(["required", "optional", "observed", "none", "unknown"]);
const AI_SILENT_VALUES = new Set(["none", "unknown"]);
const STACK_SCOPES = new Set(["main", "optional", "product", "ambiguous"]);
const TOOL_KINDS = new Set(["framework", "supporting", "ambiguous"]);

const SOURCE_KEYS = [
  "accessOutcome",
  "accessReason",
  "company",
  "evidenceQuote",
  "finalUrl",
  "jobTitle",
  "locationRaw",
  "salaryRaw",
  "sourceRef",
  "workFormatRaw",
];
const ROLE_KEYS = [
  "ai",
  "automation",
  "domain",
  "evidence",
  "family",
  "language",
  "observedTools",
  "observedLanguages",
  "seniority",
];
const ROLE_EVIDENCE_KEYS = [
  "aiProduct",
  "aiWork",
  "automation",
  "domain",
  "language",
  "role",
  "seniority",
  "tools",
];
const AI_KEYS = ["product", "work"];
// The country name stays beside its code: knowledge/job-match-rules.md#7-decision-trace-contract records the country the listing named, and the code is
// the same observation at the precision the three readings need.
const OFFER_KEYS = [
  "companyRegion",
  "compensationMarket",
  "contractorEligibility",
  "engagementPath",
  "evidenceQuote",
  "relocationCountry",
  "relocationCountryCode",
  "relocationSupport",
  "residenceRequirementCountry",
  "residenceRequirementCountryCode",
  "residenceRestriction",
  "sponsorship",
  "timezone",
  "timezoneDistance",
  "westRegion",
  "workAuthorization",
  "workFormat",
];
const STACK_KEYS = [
  "evidenceQuote",
  "name",
  "requirement",
  "requirementPhrase",
  "scope",
  "scopeReason",
];
const OBSERVED_TOOL_KEYS = [...STACK_KEYS, "kind"];
const SALARY_KEYS = ["basis", "currency", "evidenceQuote", "kind", "maximum", "minimum", "period"];
const FX_KEYS = ["provider", "rateDate", "sourceCurrency", "targetCurrency", "targetPerSource"];
const OVERRIDE_KEYS = ["amount", "basis", "currency", "period", "scope"];
const ROOT_KEYS = [
  "candidateScoring",
  "compensation",
  "explicitOverride",
  "fx",
  "inputIndex",
  "offerPairing",
  "offers",
  "policyId",
  "role",
  "schemaVersion",
  "scoringDate",
  "source",
];

export class ScorerInputError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = "ScorerInputError";
    this.code = "invalid_scorer_input";
    this.path = path;
  }
}

function fail(path, message) {
  throw new ScorerInputError(path, message);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys, path) {
  if (!isRecord(value)) fail(path, "must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(path, `must have exact keys ${expected.join(",")}`);
  }
}

function enumValue(value, values, path) {
  if (!values.has(value)) fail(path, `unsupported value ${String(value)}`);
  return value;
}

function nullableEnumValue(value, values, path) {
  if (value === null) return null;
  return enumValue(value, values, path);
}

function nullableString(value, path) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0)
    fail(path, "must be null or a non-empty string");
  return value;
}

/**
 * A destination code is an ISO 3166-1 alpha-2 code or `null`, and never a two-letter string of the
 * extractor's own invention. `null` is a real answer - "a country was named and I could not identify
 * it" - which knowledge/job-match-rules.md#31-m--mobility--work-feasibility reads as an undecidable destination; a code the table does not carry is not an
 * answer at all, so it fails here rather than being paid the relocation lane's middle downstream.
 */
function nullableCountryCode(value, path) {
  if (value === null) return null;
  if (!isCountryCode(value)) fail(path, "must be null or an ISO 3166-1 alpha-2 country code");
  return value;
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string");
  return value;
}

function currency(value, path) {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) {
    fail(path, "must be a three-letter uppercase currency code");
  }
  return value;
}

function finiteNonNegative(value, path, { positive = false } = {}) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (positive && value === 0)
  ) {
    fail(
      path,
      positive ? "must be a positive finite number" : "must be a non-negative finite number",
    );
  }
  return value;
}

function calendarDate(value, path) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(path, "must be a real YYYY-MM-DD calendar date");
  }
  const [year, month, day] = value.split("-").map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [0, 31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month]) {
    fail(path, "must be a real YYYY-MM-DD calendar date");
  }
  return value;
}

function normalizeSource(source) {
  exactKeys(source, SOURCE_KEYS, "source");
  const accessOutcome = enumValue(source.accessOutcome, ACCESS_OUTCOMES, "source.accessOutcome");
  const accessReason = nullableString(source.accessReason, "source.accessReason");
  const evidenceQuote = nullableString(source.evidenceQuote, "source.evidenceQuote");
  if (accessOutcome !== "usable" && accessReason === null) {
    fail("source.accessReason", `required for ${accessOutcome}`);
  }
  if (
    accessOutcome === "closed" &&
    evidenceQuote === null &&
    accessReason !== "HTTP 404 after retry"
  ) {
    fail("source.evidenceQuote", "required for closed unless symptom is HTTP 404");
  }
  return {
    accessOutcome,
    accessReason,
    company: nullableString(source.company, "source.company"),
    evidenceQuote,
    finalUrl: nullableString(source.finalUrl, "source.finalUrl"),
    jobTitle: nullableString(source.jobTitle, "source.jobTitle"),
    locationRaw: nullableString(source.locationRaw, "source.locationRaw"),
    salaryRaw: nullableString(source.salaryRaw, "source.salaryRaw"),
    sourceRef: requiredString(source.sourceRef, "source.sourceRef"),
    workFormatRaw: nullableString(source.workFormatRaw, "source.workFormatRaw"),
  };
}

function normalizeRoleEvidence(role, keys = ROLE_EVIDENCE_KEYS) {
  exactKeys(role.evidence, keys, "role.evidence");
  return Object.fromEntries(
    keys.map((key) => [key, nullableString(role.evidence[key], `role.evidence.${key}`)]),
  );
}

function requireTerminalEvidence(role, evidence) {
  if (role.family === "other" && evidence.role === null) {
    fail("role.evidence.role", "required for not_qa_or_testing_role");
  }
  if (role.language === "unsupported" && evidence.language === null) {
    fail("role.evidence.language", "required for language_not_supported");
  }
  if (role.automation === "manager_only" && evidence.automation === null) {
    fail("role.evidence.automation", "required for manager_role");
  }
  if (role.automation === "manual_only" && evidence.automation === null) {
    fail("role.evidence.automation", "required for manual_role");
  }
  if (role.seniority === "junior" && evidence.seniority === null) {
    fail("role.evidence.seniority", "required for junior_role");
  }
}

/** Observations only: exact quotes and scope, never a model-supplied price or outcome. */
function stackText(value, path) {
  const text = requiredString(value, path);
  if (text.trim().length === 0) fail(path, "must be a non-empty string");
  return text;
}
function normalizeStackObservation(item, index, language) {
  const path = `role.${language ? "observedLanguages" : "observedTools"}[${index}]`;
  exactKeys(item, language ? STACK_KEYS : OBSERVED_TOOL_KEYS, path);
  const name = requiredString(item.name, `${path}.name`);
  const requirement = enumValue(item.requirement, REQUIREMENTS, `${path}.requirement`);
  const scope = enumValue(item.scope, STACK_SCOPES, `${path}.scope`);
  if (requirement === "optional" && scope === "main")
    fail(`${path}.scope`, "optional observations cannot be main stack");
  if (scope === "optional" && requirement !== "optional")
    fail(`${path}.requirement`, "optional scope requires optional wording");
  if (language && resolveToolName(name) !== null && resolveLanguageName(name) === null)
    fail(
      `${path}.name`,
      "recognised framework/supporting names must be tool observations, not test languages",
    );
  if (!language && resolveLanguageName(name) !== null)
    fail(`${path}.name`, "programming languages must be language observations");
  let kind;
  if (!language) {
    kind = enumValue(item.kind, TOOL_KINDS, `${path}.kind`);
    const canonical = resolveToolName(name);
    const expectedKind =
      frameworkClassFor(canonical) !== null
        ? "framework"
        : isSupportingName(name)
          ? "supporting"
          : null;
    if (expectedKind !== null && kind !== expectedKind)
      fail(`${path}.kind`, `recognised name must be ${expectedKind}`);
  }
  return {
    name,
    requirement,
    scope,
    evidenceQuote: stackText(item.evidenceQuote, `${path}.evidenceQuote`),
    scopeReason: stackText(item.scopeReason, `${path}.scopeReason`),
    requirementPhrase: nullableString(item.requirementPhrase, `${path}.requirementPhrase`),
    ...(language ? {} : { kind }),
  };
}
function normalizeStackList(value, language) {
  const path = `role.${language ? "observedLanguages" : "observedTools"}`;
  if (!Array.isArray(value) || value.length > 200)
    fail(path, "must be an array of at most 200 observations");
  const items = value.map((item, index) => normalizeStackObservation(item, index, language));
  const identities = items.map((item) => JSON.stringify(item));
  if (new Set(identities).size !== items.length)
    fail(path, "must not contain duplicate observations");
  return items;
}

function normalizeRole(
  role,
  { keys = ROLE_KEYS, evidenceKeys = ROLE_EVIDENCE_KEYS, languages } = {},
) {
  exactKeys(role, keys, "role");
  const evidence = normalizeRoleEvidence(role, evidenceKeys);
  const automation = enumValue(role.automation, AUTOMATION_LEVELS, "role.automation");
  const family = enumValue(role.family, ROLE_FAMILIES, "role.family");
  const language = enumValue(role.language, roleLanguages(languages), "role.language");
  const seniority = enumValue(role.seniority, SENIORITY_LEVELS, "role.seniority");
  requireTerminalEvidence({ automation, family, language, seniority }, evidence);
  const observedTools = normalizeStackList(role.observedTools, false);
  const observedLanguages = normalizeStackList(role.observedLanguages, true);
  return {
    automation,
    domain: enumValue(role.domain, DOMAIN_NAMES, "role.domain"),
    evidence,
    family,
    language,
    observedTools,
    observedLanguages,
    seniority,
  };
}

/**
 * knowledge/job-match-rules.md#7-decision-trace-contract's AI observation. A value that says something carries the quote it rests on, and a silent one
 * carries none. `unknown` belongs to a description the rubric does not read and to nothing else: an
 * input that is not usable was never read, so it must say `unknown`; a usable one says it only when
 * the rubric stops at the title or the language, and an ambiguous mention in a read description is
 * `none` on the axis the text does not tie it to.
 */
function normalizeAi(role, evidence, source) {
  exactKeys(role.ai, AI_KEYS, "role.ai");
  const ai = {
    product: enumValue(role.ai.product, AI_PRODUCT_VALUES, "role.ai.product"),
    work: enumValue(role.ai.work, AI_WORK_VALUES, "role.ai.work"),
  };
  const unread = source.accessOutcome !== "usable";
  const readable = !unread && role.family !== "other" && role.language !== "unsupported";
  for (const [axis, evidenceKey] of [
    ["product", "aiProduct"],
    ["work", "aiWork"],
  ]) {
    const value = ai[axis];
    const quote = evidence[evidenceKey];
    if (AI_SILENT_VALUES.has(value) && quote !== null) {
      fail(`role.evidence.${evidenceKey}`, `must be null for role.ai.${axis} ${value}`);
    }
    if (!AI_SILENT_VALUES.has(value) && quote === null) {
      fail(`role.evidence.${evidenceKey}`, `required for role.ai.${axis} ${value}`);
    }
    if (unread && value !== "unknown") {
      fail(
        `role.ai.${axis}`,
        `must be unknown for ${source.accessOutcome}: the description was not read`,
      );
    }
    if (readable && value === "unknown") {
      fail(`role.ai.${axis}`, "must not be unknown for a description the rubric reads");
    }
  }
  return ai;
}

/** One offered path: the observations, then the destination codes beside the names they identify. */
function normalizeOfferBody(offer, path) {
  const companyRegion = enumValue(offer.companyRegion, COMPANY_REGIONS, `${path}.companyRegion`);
  const westRegion =
    offer.westRegion === null
      ? null
      : enumValue(offer.westRegion, WEST_REGIONS, `${path}.westRegion`);
  if ((companyRegion === "WEST") !== (westRegion !== null)) {
    fail(`${path}.westRegion`, "must be present exactly for WEST offers");
  }
  const residenceRestriction = enumValue(
    offer.residenceRestriction,
    RESIDENCE_RESTRICTIONS,
    `${path}.residenceRestriction`,
  );
  const residenceRequirementCountry = nullableString(
    offer.residenceRequirementCountry,
    `${path}.residenceRequirementCountry`,
  );
  // The field exists for hard-SKIP rule 4, which reads "any country a stated residence requirement
  // can be satisfied only by living in". Without a stated restriction there is no such country.
  if (
    residenceRequirementCountry !== null &&
    !["compatible", "incompatible"].includes(residenceRestriction)
  ) {
    fail(`${path}.residenceRequirementCountry`, "requires an observed residence restriction");
  }
  return {
    companyRegion,
    compensationMarket: enumValue(
      offer.compensationMarket,
      COMPENSATION_MARKETS,
      `${path}.compensationMarket`,
    ),
    contractorEligibility: enumValue(
      offer.contractorEligibility,
      CONTRACTOR_ELIGIBILITY,
      `${path}.contractorEligibility`,
    ),
    engagementPath: nullableEnumValue(
      offer.engagementPath,
      ENGAGEMENT_PATHS,
      `${path}.engagementPath`,
    ),
    evidenceQuote: requiredString(offer.evidenceQuote, `${path}.evidenceQuote`),
    relocationCountry: nullableString(offer.relocationCountry, `${path}.relocationCountry`),
    relocationSupport: enumValue(
      offer.relocationSupport,
      RELOCATION_SUPPORT,
      `${path}.relocationSupport`,
    ),
    residenceRequirementCountry,
    residenceRestriction,
    sponsorship: enumValue(offer.sponsorship, SPONSORSHIP, `${path}.sponsorship`),
    timezone: enumValue(offer.timezone, TIMEZONES, `${path}.timezone`),
    timezoneDistance: enumValue(
      offer.timezoneDistance,
      TIMEZONE_DISTANCES,
      `${path}.timezoneDistance`,
    ),
    westRegion,
    workAuthorization: enumValue(
      offer.workAuthorization,
      WORK_AUTHORIZATION,
      `${path}.workAuthorization`,
    ),
    workFormat: enumValue(offer.workFormat, WORK_FORMATS, `${path}.workFormat`),
  };
}

function normalizeOffer(offer, index) {
  const path = `offers[${index}]`;
  exactKeys(offer, OFFER_KEYS, path);
  const body = normalizeOfferBody(offer, path);
  const relocationCountryCode = nullableCountryCode(
    offer.relocationCountryCode,
    `${path}.relocationCountryCode`,
  );
  const residenceRequirementCountryCode = nullableCountryCode(
    offer.residenceRequirementCountryCode,
    `${path}.residenceRequirementCountryCode`,
  );
  // A code is the identification of a name the listing carried, so it cannot arrive without one:
  // knowledge/job-match-rules.md#7-decision-trace-contract records what the listing named, and a code with no name would decide three readings on an
  // observation the trace cannot show. The reverse is allowed - a named destination nobody could
  // identify keeps its name and takes an annotated middle.
  if (relocationCountryCode !== null && body.relocationCountry === null) {
    fail(`${path}.relocationCountryCode`, "requires the country name the listing used");
  }
  if (residenceRequirementCountryCode !== null && body.residenceRequirementCountry === null) {
    fail(`${path}.residenceRequirementCountryCode`, "requires the country name the listing used");
  }
  return { ...body, relocationCountryCode, residenceRequirementCountryCode };
}

function normalizeCompensation(value) {
  if (value === null) return null;
  exactKeys(value, SALARY_KEYS, "compensation");
  const kind = enumValue(value.kind, SALARY_KINDS, "compensation.kind");
  const minimum = finiteNonNegative(value.minimum, "compensation.minimum", { positive: true });
  const maximum = finiteNonNegative(value.maximum, "compensation.maximum", { positive: true });
  if (minimum > maximum) fail("compensation", "minimum must not exceed maximum");
  if (kind === "value" && minimum !== maximum) {
    fail("compensation", "a value must use identical minimum and maximum");
  }
  if (kind === "range" && minimum === maximum) {
    fail("compensation", "a range must have distinct bounds");
  }
  return {
    basis: enumValue(value.basis, BASIS_VALUES, "compensation.basis"),
    currency: currency(value.currency, "compensation.currency"),
    evidenceQuote: requiredString(value.evidenceQuote, "compensation.evidenceQuote"),
    kind,
    maximum,
    minimum,
    period: enumValue(value.period, PERIODS, "compensation.period"),
  };
}

/**
 * The official rate record. Its provider is the reference provider or the one the candidate names
 * for the home currency; which of the two a given pair needs is the scorer's question, and a record
 * from the wrong one takes the C middle there rather than failing here.
 */
function normalizeFx(value, homeRateProvider) {
  if (value === null) return null;
  exactKeys(value, FX_KEYS, "fx");
  const rateDate = calendarDate(value.rateDate, "fx.rateDate");
  const sourceCurrency = currency(value.sourceCurrency, "fx.sourceCurrency");
  const targetCurrency = currency(value.targetCurrency, "fx.targetCurrency");
  if (sourceCurrency === targetCurrency) fail("fx", "must convert between different currencies");
  return {
    provider: enumValue(
      value.provider,
      new Set([REFERENCE_RATE_PROVIDER, homeRateProvider]),
      "fx.provider",
    ),
    rateDate,
    sourceCurrency,
    targetCurrency,
    targetPerSource: finiteNonNegative(value.targetPerSource, "fx.targetPerSource", {
      positive: true,
    }),
  };
}

function normalizeOverride(value) {
  if (value === null) return null;
  exactKeys(value, OVERRIDE_KEYS, "explicitOverride");
  if (value.scope !== "batch") fail("explicitOverride.scope", "must be exact batch");
  return {
    amount: finiteNonNegative(value.amount, "explicitOverride.amount", { positive: true }),
    basis: enumValue(value.basis, BASIS_VALUES, "explicitOverride.basis"),
    currency: currency(value.currency, "explicitOverride.currency"),
    period: enumValue(value.period, PERIODS, "explicitOverride.period"),
    scope: "batch",
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function normalizeSourceContext(value, source) {
  if (value === null) return null;
  exactKeys(
    value,
    [
      "sourceSetSha256",
      "cardRef",
      "snapshotRef",
      "primarySourceRef",
      "primaryCaptureSha256",
      "startLine",
      "endLine",
    ],
    "sourceContext",
  );
  for (const key of ["sourceSetSha256", "primaryCaptureSha256"]) {
    if (key === "primaryCaptureSha256" && value[key] === null && source.accessOutcome !== "usable")
      continue;
    if (typeof value[key] !== "string" || !/^[a-f0-9]{64}$/u.test(value[key]))
      fail(`sourceContext.${key}`, "must be a SHA-256 digest");
  }
  for (const key of ["cardRef", "snapshotRef"]) {
    const pattern =
      key === "cardRef" ? /^tg-card:sha256:[a-f0-9]{64}$/u : /^tg-snapshot:sha256:[a-f0-9]{64}$/u;
    if (typeof value[key] !== "string" || !pattern.test(value[key]))
      fail(`sourceContext.${key}`, "must be a bounded source reference");
  }
  if (value.primarySourceRef !== source.sourceRef)
    fail("sourceContext.primarySourceRef", "must identify the input's own primary source");
  if (value.primaryCaptureSha256 === null) {
    if (value.startLine !== null || value.endLine !== null || source.evidenceQuote !== null)
      fail("sourceContext", "a body-less failure must have no line range or source quote");
    return { ...value };
  }
  if (
    !Number.isSafeInteger(value.startLine) ||
    !Number.isSafeInteger(value.endLine) ||
    value.startLine < 1 ||
    value.endLine < value.startLine
  )
    fail("sourceContext", "must identify a non-empty inclusive line range");
  return { ...value };
}

function normalizeCommonRoot(input, { homeRateProvider, policyId, schemaVersion }) {
  if (!Number.isInteger(input.inputIndex) || input.inputIndex < 1) {
    fail("inputIndex", "must be a positive integer");
  }
  const scoringDate = calendarDate(input.scoringDate, "scoringDate");
  if (!Array.isArray(input.offers)) fail("offers", "must be an array");
  if (!new Set(["clear", "unclear"]).has(input.offerPairing)) {
    fail("offerPairing", "must be clear or unclear");
  }
  return {
    compensation: normalizeCompensation(input.compensation),
    explicitOverride: normalizeOverride(input.explicitOverride),
    fx: normalizeFx(input.fx, homeRateProvider),
    inputIndex: input.inputIndex,
    offerPairing: input.offerPairing,
    policyId,
    schemaVersion,
    scoringDate,
    source: normalizeSource(input.source),
  };
}

function checkCrossFieldRules(normalized) {
  if (normalized.fx && normalized.fx.rateDate > normalized.scoringDate) {
    fail("fx.rateDate", "must not be later than scoringDate");
  }
  const offerKeys = normalized.offers.map((offer) => JSON.stringify(offer));
  if (new Set(offerKeys).size !== offerKeys.length)
    fail("offers", "must not contain duplicate offers");
}

/**
 * The candidate's scoring values, checked by the rules the candidate configuration is checked by. A
 * caller that passes the layer's own values (`candidateScoringValues` of
 * `tools/candidate/load.mjs`) also gets them compared: `/score-jobs` passes them, so an input whose
 * values were typed rather than copied is refused before it is scored. Batch verification passes
 * none and recomputes on the values the input recorded.
 */
function normalizeCandidateScoring(value, expected) {
  let scoring;
  try {
    scoring = validateCandidateScoring(value);
  } catch (error) {
    if (error instanceof CandidateError) fail("candidateScoring", error.message);
    throw error;
  }
  if (expected !== undefined && canonicalJson(scoring) !== canonicalJson(expected)) {
    fail("candidateScoring", "must equal the scoring values of the candidate layer");
  }
  return scoring;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The strict normalized object, or a `ScorerInputError`. `languages` is the set `role.language` may
 * name besides `unsupported` and `unknown`: the names of the candidate layer's languages
 * (`candidateLanguageNames` in `tools/candidate/load.mjs`). `scoring`, when passed, is the value
 * `candidateScoring` must equal.
 */
export function normalizeScorerInput(input, { languages, scoring } = {}) {
  if (!isRecord(input)) fail("input", "must be an object");
  if (!SUPPORTED_INPUT_SCHEMA_VERSIONS.includes(input.schemaVersion)) {
    fail("schemaVersion", "must be 9 or 10; earlier versions are no longer read");
  }
  exactKeys(
    input,
    input.schemaVersion === 10 ? [...ROOT_KEYS, "sourceContext"] : ROOT_KEYS,
    "input",
  );
  const policyId = inputPolicyId(input.schemaVersion);
  if (input.policyId !== policyId) fail("policyId", `must be ${policyId}`);
  const candidateScoring = normalizeCandidateScoring(input.candidateScoring, scoring);
  const common = normalizeCommonRoot(input, {
    homeRateProvider: candidateScoring.compensation.home_rate_provider,
    policyId,
    schemaVersion: input.schemaVersion,
  });
  const role = normalizeRole(input.role, { languages });
  if (
    common.source.accessOutcome !== "usable" &&
    (role.observedTools.length !== 0 || role.observedLanguages.length !== 0)
  ) {
    fail("role", "unread descriptions must carry no concrete stack observations");
  }
  const normalized = {
    ...common,
    ...(input.schemaVersion === 10
      ? { sourceContext: normalizeSourceContext(input.sourceContext, common.source) }
      : {}),
    candidateScoring,
    offers: input.offers.map(normalizeOffer),
    role: { ...role, ai: normalizeAi(input.role, role.evidence, common.source) },
  };
  checkCrossFieldRules(normalized);
  return deepFreeze(normalized);
}
