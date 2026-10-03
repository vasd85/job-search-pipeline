/**
 * The candidate's scoring values: where the candidate can live and move, which destinations they
 * exclude, how desirable each relocation country is, the pay floors and target of each engagement
 * path, what each tool of the ToolMatch table is worth to the candidate, and where each product
 * domain sits on the Domain Fit scale.
 *
 * The engine keeps the branch selection, salary boundaries, tool taxonomy and domain names.
 * The config holds component maxima, point tables, unknown values, bonuses and limits. `job-match-rules.md` names each key; the scorer
 * reads the values from its own input, where `/score-jobs` copies them from the config at scoring
 * time, so a batch is recomputed on the values it was scored with and not on today's config.
 *
 * Countries are ISO 3166-1 alpha-2 codes, the vocabulary the extractor already records a
 * destination in. None of the lists that describe where the candidate lives or relocates may name
 * a WEST country: the record prices `WEST` on the premise that the candidate needs permission to
 * work in each of its countries, and a configuration that contradicts it would be scored wrongly in
 * silence. The excluded destinations may name one — excluding a country asks nothing of that
 * premise.
 */

import { WEST_COUNTRY_CODES, isCountryCode } from "../job-scorer/iso-3166.mjs";
import { LANGUAGE_NAMES, frameworkClassFor } from "../job-scorer/tool-taxonomy.mjs";

/** The relocation tiers of knowledge/job-match-rules.md#31-m--mobility--work-feasibility branch D, as the config names them. */
export const RELOCATION_TIER_NAMES = Object.freeze(["high", "middle", "low"]);

/** The two WEST sub-regions branch B tells apart. */
export const WEST_SUBREGIONS = Object.freeze(["EU_UK", "US_CANADA"]);

/** The engagement paths that carry a floor, as the config and the scorer input name them. */
export const FLOOR_PATHS = Object.freeze([
  "outside_home_contractor",
  "home_employment",
  "home_contractor",
  "comparable_cost_employment",
]);

export const FLOOR_BASES = Object.freeze(["gross", "net"]);

/** The rate the engine uses for every currency pair that does not involve the home currency. */
export const REFERENCE_RATE_PROVIDER = "ECB";

/**
 * The product domains of the Domain Fit scale (knowledge/job-match-rules.md#34-d--domain-fit) the candidate places, as the scorer input and
 * the config name them: one config key each. The scorer input accepts these and the two names the
 * engine scores itself, `irrelevant` and `unclear`, and nothing else - there is no second list.
 */
export const DOMAIN_FIT_DOMAINS = Object.freeze([
  "agency_outsourcing_vendor",
  "complex_saas_b2b",
  "data_platforms",
  "developer_tools",
  "distributed_systems",
  "fintech_payments_trading",
  "healthcare_biotech",
  "infra_platforms",
  "marketplaces",
  "media_entertainment",
  "other_complex",
  "security_tooling",
  "telecom",
  "web3",
]);

const MAX_COUNTRIES = 249;
const MAX_CURRENCIES = 10;
const CURRENCY = /^[A-Z]{3}$/u;
const PROVIDER = /^[A-Z][A-Z0-9]{1,15}$/u;
const west = new Set(WEST_COUNTRY_CODES);

function distinctCountryCodes(value) {
  return (
    value.length <= MAX_COUNTRIES &&
    value.every(isCountryCode) &&
    new Set(value).size === value.length
  );
}

/** Distinct assigned country codes; the list may be empty. */
export function acceptsCountryCodes(value) {
  return distinctCountryCodes(value);
}

/** Distinct assigned country codes, none of them a WEST country; the list may be empty. */
export function acceptsNonWestCountryCodes(value) {
  return distinctCountryCodes(value) && value.every((code) => !west.has(code));
}

/** As above, and at least one. */
export function acceptsSomeNonWestCountryCodes(value) {
  return value.length > 0 && acceptsNonWestCountryCodes(value);
}

export function acceptsTierName(value) {
  return RELOCATION_TIER_NAMES.includes(value);
}

export function acceptsWestSubregion(value) {
  return WEST_SUBREGIONS.includes(value);
}

export function acceptsCurrencyCode(value) {
  return CURRENCY.test(value);
}

/** Distinct three-letter currency codes, at least one; the first is the one a comparison falls back to. */
export function acceptsCurrencyCodes(value) {
  return (
    value.length > 0 &&
    value.length <= MAX_CURRENCIES &&
    value.every((code) => CURRENCY.test(code)) &&
    new Set(value).size === value.length
  );
}

export function acceptsBasis(value) {
  return FLOOR_BASES.includes(value);
}

/** The name the trace records for the home currency's official rate; never the reference provider. */
export function acceptsRateProvider(value) {
  return PROVIDER.test(value) && value !== REFERENCE_RATE_PROVIDER;
}

/** Strict independent price records. Missing entries mean zero with unknown experience. */
function acceptsStackPrices(value, isName) {
  if (value.length > 200) return false;
  const names = new Set();
  return value.every((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    if (Object.keys(entry).sort().join(",") !== "experience,name,points") return false;
    if (!isName(entry.name) || names.has(entry.name)) return false;
    names.add(entry.name);
    return (
      Number.isSafeInteger(entry.points) &&
      entry.points >= 0 &&
      entry.points <= 5 &&
      ["direct", "transferable", "none", "unknown"].includes(entry.experience) &&
      (entry.points === 0 || ["direct", "transferable"].includes(entry.experience))
    );
  });
}
export function acceptsLanguagePrices(value) {
  return acceptsStackPrices(value, (name) => LANGUAGE_NAMES.includes(name));
}
export function acceptsFrameworkPrices(value) {
  return acceptsStackPrices(value, (name) => frameworkClassFor(name) !== null);
}

/** One step of the Domain Fit scale. */
export function acceptsDomainFitStep(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100;
}

/**
 * The config paths the scorer input carries. `mobility.self_relocation` is not among them: the
 * scorer's code never reads it — rule 10 and the definition of an engagement path do.
 */
export function isScoringInputPath(path) {
  return (
    (path.startsWith("scoring.") ||
      path.startsWith("mobility.") ||
      path.startsWith("compensation.") ||
      path.startsWith("tool_match.") ||
      path.startsWith("domain_fit.")) &&
    path !== "mobility.self_relocation"
  );
}

/**
 * The part of a validated config the scorer input carries, as a plain deep copy in the config's own
 * shape: `scoring`, `mobility` without `self_relocation`, `compensation`, `tool_match`, and `domain_fit`.
 */
export function candidateScoringFrom(config) {
  const { self_relocation: _selfRelocation, ...mobility } = config.mobility;
  return JSON.parse(
    JSON.stringify({
      scoring: config.scoring,
      compensation: config.compensation,
      domain_fit: config.domain_fit,
      mobility,
      tool_match: config.tool_match,
    }),
  );
}

/** Integer point settings, shared by the full config and scorer snapshot. */
export const scoringPointPaths = Object.freeze([
  "scoring.m.max",
  "scoring.m.unknown",
  "scoring.m.sponsored",
  "scoring.m.remote.broad_open",
  "scoring.m.remote.broad_restricted",
  "scoring.m.remote.far_local_open",
  "scoring.m.remote.far_local_restricted",
  "scoring.m.remote.near_local_open",
  "scoring.m.remote.near_local_restricted",
  "scoring.m.remote.far_unknown_open",
  "scoring.m.remote.far_unknown_restricted",
  "scoring.m.remote.near_unknown_open",
  "scoring.m.remote.near_unknown_restricted",
  "scoring.m.remote.other_near",
  "scoring.m.remote.other_unknown",
  "scoring.m.remote.other_far_unknown",
  "scoring.m.remote.other_far_local",
  "scoring.m.relocation.high",
  "scoring.m.relocation.middle",
  "scoring.m.relocation.low",
  "scoring.m.relocation.unknown",
  "scoring.m.relocation.bonus",
  "scoring.m.relocation.max",
  "scoring.c.max",
  "scoring.c.unknown",
  "scoring.c.local",
  "scoring.c.start",
  "scoring.c.target",
  "scoring.s.max",
  "scoring.s.automation.max",
  "scoring.s.automation.primary",
  "scoring.s.automation.major",
  "scoring.s.automation.limited",
  "scoring.s.automation.unknown",
  "scoring.s.seniority.max",
  "scoring.s.seniority.senior",
  "scoring.s.seniority.mid",
  "scoring.s.seniority.lower",
  "scoring.s.seniority.unknown",
  "scoring.s.tools.max",
  "scoring.d.max",
  "scoring.d.unknown",
]);
export const scoringTablePaths = Object.freeze([
  "scoring.m.cap_scores",
  "scoring.m.cap_limits",
  "scoring.c.below_floor",
  "scoring.c.reference",
  "scoring.d.steps",
]);
export function acceptsPoints(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100;
}
export function acceptsPointTable(value) {
  return value.length > 0 && value.length <= 101 && value.every(acceptsPoints);
}

/** Cross-field checks after all declared fields have passed type and point bounds. */
export function validateScoringPoints(config, refuse) {
  const { m, c, s, d } = config.scoring;
  const check = (ok, message) => {
    if (!ok) refuse(message);
  };
  const bounded = (values, max, name) =>
    check(
      values.every((v) => v <= max),
      `${name} points must not exceed their maximum`,
    );
  const ascending = (values) => values.every((v, i) => i === 0 || values[i - 1] <= v);
  check(m.max + c.max + s.max + d.max === 100, "component maxima must sum to 100");
  bounded(
    [m.unknown, m.sponsored, ...Object.values(m.remote), ...Object.values(m.relocation)],
    m.max,
    "mobility",
  );
  check(
    m.relocation.low <= m.relocation.middle && m.relocation.middle <= m.relocation.high,
    "relocation tiers must be ordered",
  );
  bounded(
    [
      m.relocation.low,
      m.relocation.middle,
      m.relocation.high,
      m.relocation.unknown,
      m.relocation.bonus,
    ],
    m.relocation.max,
    "relocation",
  );
  check(
    m.cap_scores.length === m.cap_limits.length &&
      m.cap_scores.at(-1) === m.max &&
      m.cap_scores.every((v, i) => v <= m.max && (i === 0 || m.cap_scores[i - 1] < v)) &&
      ascending(m.cap_limits),
    "mobility cap must have ordered boundaries ending at the mobility maximum and nondecreasing limits",
  );
  bounded(
    [c.unknown, c.local, c.start, c.target, ...c.below_floor, ...c.reference],
    c.max,
    "compensation",
  );
  check(c.start <= c.target, "compensation curve anchors must be ordered");
  check(
    c.below_floor.length === 5 && c.reference.length === 5,
    "compensation tables must price every engine band",
  );
  check(
    ascending([...c.below_floor].reverse()) && ascending([...c.reference].reverse()),
    "compensation band points must be ordered",
  );
  check(c.below_floor[0] <= c.start, "below-floor points must not exceed the curve start");
  check(
    s.automation.max + s.tools.max + s.seniority.max === s.max,
    "skill subcomponent maxima must sum to the skills maximum",
  );
  for (const [name, part] of Object.entries({
    automation: s.automation,
    seniority: s.seniority,
    tools: s.tools,
  })) {
    bounded(Object.values(part), part.max, `skills ${name}`);
  }
  check(
    s.automation.limited <= s.automation.major && s.automation.major <= s.automation.primary,
    "automation points must be ordered",
  );
  check(
    s.seniority.lower <= s.seniority.mid && s.seniority.mid <= s.seniority.senior,
    "seniority points must be ordered",
  );
  check(s.tools.max === 10, "ToolMatch maximum must be 10 for the independent 0-10 scale");
  check(
    d.steps[0] === 0 &&
      d.steps.at(-1) === d.max &&
      d.steps.every((v, i) => i === 0 || d.steps[i - 1] < v),
    "domain steps must increase from zero to the domain maximum",
  );
  check(
    [d.unknown, ...Object.values(config.domain_fit)].every((v) => d.steps.includes(v)),
    "domain points must be declared domain steps",
  );
}
