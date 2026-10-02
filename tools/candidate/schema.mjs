/**
 * The candidate configuration schema: the version the engine reads and the keys it declares.
 *
 * Every value that sat inside a rule moves here as its own task; the table below holds the ones
 * moved so far. The coverage check compares the keys declared here with the keys the rules name.
 *
 * A key is declared as a dotted path with a type, and the prose of a rule names it as
 * `candidate.config.` followed by that path. Nothing else makes a key exist: a path this table
 * does not declare is refused as an unknown key, and a declared key that the config omits is
 * refused as a missing one. Both directions are deliberate — the value a run uses is the value
 * the file shows, never a default hidden in code.
 */

import { acceptsAdditionalLanguages, acceptsSingleLine, isLanguageName } from "./languages.mjs";
import { acceptsHomeCountries, acceptsMarketName, acceptsTimezone, acceptsWorkingHours } from "./markets.mjs";
import { acceptsCompanyRegions } from "./priorities.mjs";
import {
  DOMAIN_FIT_DOMAINS,
  scoringPointPaths, scoringTablePaths, acceptsPoints, acceptsPointTable,
  FLOOR_PATHS,
  RELOCATION_TIER_NAMES,
  acceptsBasis,
  acceptsCountryCodes,
  acceptsCurrencyCode,
  acceptsCurrencyCodes,
  acceptsDomainFitStep,
  acceptsNonWestCountryCodes,
  acceptsLanguagePrices,
  acceptsFrameworkPrices,
  acceptsRateProvider,
  acceptsSomeNonWestCountryCodes,
  acceptsTierName,
  acceptsWestSubregion,
} from "./scoring.mjs";

export const candidateConfigSchemaVersion = 3;

/**
 * The reserved meta key. It carries the schema version rather than a candidate value, so the
 * coverage check never expects a rule to name it and the unknown-key check never rejects it.
 */
export const candidateSchemaVersionKey = "schema_version";

/**
 * Every declared key: the dotted path a rule names, the type its value must have, and — where a
 * type alone would accept a value no reader can use — a bound on the value itself.
 *
 * A key added here without a rule naming it turns the coverage check red, which is what keeps the
 * config from growing settings nothing reads.
 *
 * `minimum` bounds an integer. `accepts` bounds a value of any type and travels with `expected`, the
 * words a refusal uses: the value itself is the candidate's and is never quoted back.
 */
const cvFileNamePlaceholders = Object.freeze(["<Company>", "<Role>"]);

function acceptsCvFileNamePattern(value) {
  if (!value.endsWith(".docx") || value.startsWith(".") || /[/\\\n\r]/u.test(value)) return false;
  return cvFileNamePlaceholders.every((placeholder) => value.split(placeholder).length === 2);
}

const marketNameExpected = "lowercase letters and digits in words joined by single hyphens, "
  + "starting with a letter, at most 40 characters";
const timezoneExpected = "UTC, or UTC followed by + or - and 0 to 14 hours, optionally :30 or :45";
const countryCodesExpected = "distinct ISO 3166-1 alpha-2 country codes";
const nonWestExpected = `${countryCodesExpected}, none of them a WEST country`;
const someNonWestExpected = `one or more ${nonWestExpected}`;
const floorKeys = [...FLOOR_PATHS].sort().flatMap((path) => [
  Object.freeze({ path: `compensation.floors.${path}.amount`, type: "integer", minimum: 1 }),
  Object.freeze({ path: `compensation.floors.${path}.basis`, type: "string", accepts: acceptsBasis,
    expected: "gross or net" }),
  Object.freeze({ path: `compensation.floors.${path}.currencies`, type: "string[]", accepts: acceptsCurrencyCodes,
    expected: "one or more distinct three-letter uppercase currency codes" }),
]);

// One key per domain the engine names: a key the config omits is a domain left unplaced, and one it
// adds is a domain the engine does not know, and the checks every key gets refuse both.
const domainFitKeys = DOMAIN_FIT_DOMAINS.map((name) => Object.freeze({
  path: `domain_fit.${name}`, type: "integer", accepts: acceptsDomainFitStep,
  expected: "an integer from 0 to 100; membership is checked against the configured domain steps",
}));

const tierKeys = [...RELOCATION_TIER_NAMES].sort().map((tier) => Object.freeze({
  path: `mobility.relocation_tiers.${tier}`, type: "string[]", accepts: acceptsNonWestCountryCodes,
  expected: nonWestExpected,
}));

export const candidateConfigKeys = Object.freeze([
  ...scoringPointPaths.map(path => Object.freeze({ path, type: "integer", accepts: acceptsPoints, expected: "an integer from 0 to 100" })),
  ...scoringTablePaths.map(path => Object.freeze({ path, type: "integer[]", accepts: acceptsPointTable, expected: "one to 101 integer points from 0 to 100" })),
  ...floorKeys,
  Object.freeze({ path: "compensation.home_currency", type: "string", accepts: acceptsCurrencyCode,
    expected: "a three-letter uppercase currency code" }),
  Object.freeze({ path: "compensation.home_rate_provider", type: "string", accepts: acceptsRateProvider,
    expected: "an uppercase provider name of 2 to 16 letters and digits, not ECB" }),
  Object.freeze({ path: "compensation.target", type: "integer", minimum: 1 }),
  Object.freeze({ path: "cv.file_name_pattern", type: "string", accepts: acceptsCvFileNamePattern,
    expected: "a .docx basename naming <Company> and <Role> once each" }),
  Object.freeze({ path: "cv.page_budget", type: "integer", minimum: 1 }),
  ...domainFitKeys,
  Object.freeze({ path: "languages.additional", type: "string[]", accepts: acceptsAdditionalLanguages,
    expected: "distinct language names, each one capitalized word, none of them the default language" }),
  Object.freeze({ path: "languages.working", type: "string", accepts: isLanguageName,
    expected: "a language name: one capitalized word" }),
  Object.freeze({ path: "letter.body_paragraphs.max", type: "integer", minimum: 1 }),
  Object.freeze({ path: "letter.body_paragraphs.min", type: "integer", minimum: 1 }),
  Object.freeze({ path: "letter.body_words.approved_max", type: "integer", minimum: 1 }),
  Object.freeze({ path: "letter.body_words.max", type: "integer", minimum: 1 }),
  Object.freeze({ path: "letter.body_words.min", type: "integer", minimum: 1 }),
  Object.freeze({ path: "letter.body_words.target", type: "integer", minimum: 1 }),
  Object.freeze({ path: "letter.signature", type: "string", accepts: acceptsSingleLine,
    expected: "one line of text" }),
  Object.freeze({ path: "markets.home.countries", type: "string[]", accepts: acceptsHomeCountries,
    expected: "one or more distinct country names, each one line of text" }),
  Object.freeze({ path: "markets.home.name", type: "string", accepts: acceptsMarketName,
    expected: marketNameExpected }),
  Object.freeze({ path: "markets.home.timezone", type: "string", accepts: acceptsTimezone,
    expected: timezoneExpected }),
  Object.freeze({ path: "markets.home.working_hours", type: "string", accepts: acceptsWorkingHours,
    expected: "two different clock times HH:MM-HH:MM, the end 24:00 at the latest; an end before the start crosses midnight" }),
  Object.freeze({ path: "markets.outside_home.location", type: "string", accepts: acceptsSingleLine,
    expected: "one line of text" }),
  Object.freeze({ path: "markets.outside_home.name", type: "string", accepts: acceptsMarketName,
    expected: marketNameExpected }),
  Object.freeze({ path: "markets.outside_home.timezone", type: "string", accepts: acceptsTimezone,
    expected: timezoneExpected }),
  Object.freeze({ path: "mobility.excluded_destinations", type: "string[]", accepts: acceptsCountryCodes,
    expected: countryCodesExpected }),
  Object.freeze({ path: "mobility.feasible_residences", type: "string[]", accepts: acceptsSomeNonWestCountryCodes,
    expected: someNonWestExpected }),
  Object.freeze({ path: "mobility.home_region", type: "string[]", accepts: acceptsSomeNonWestCountryCodes,
    expected: someNonWestExpected }),
  ...tierKeys,
  Object.freeze({ path: "mobility.self_relocation", type: "string[]", accepts: acceptsNonWestCountryCodes,
    expected: nonWestExpected }),
  Object.freeze({ path: "mobility.west_near_subregion", type: "string", accepts: acceptsWestSubregion,
    expected: "EU_UK or US_CANADA" }),
  Object.freeze({ path: "mobility.west_tier", type: "string", accepts: acceptsTierName,
    expected: "high, middle or low" }),
  Object.freeze({ path: "priorities.relocation_destinations", type: "string[]", accepts: acceptsCountryCodes,
    expected: countryCodesExpected }),
  Object.freeze({ path: "priorities.relocation_west", type: "boolean" }),
  Object.freeze({ path: "priorities.remote_company_regions", type: "string[]", accepts: acceptsCompanyRegions,
    expected: "distinct company regions, each WEST, HOME or OTHER" }),
  Object.freeze({ path: "tool_match.languages", type: "record[]", accepts: acceptsLanguagePrices,
    expected: "distinct canonical language records with points 0-5 and direct/transferable/none/unknown experience; none/unknown require zero points" }),
  Object.freeze({ path: "tool_match.frameworks", type: "record[]", accepts: acceptsFrameworkPrices,
    expected: "distinct canonical framework records with points 0-5 and direct/transferable/none/unknown experience; none/unknown require zero points" }),
]);

/**
 * Orderings between declared integer keys, each read as `lower <= upper`, or as `lower < upper`
 * where the entry says `strict`. A type check cannot see
 * them, and each one breaks a reader silently when it is violated: an approved maximum below the
 * default maximum would make every length approval unparseable, and a target above the maximum
 * would ask the author for a letter the gate refuses. An approved maximum equal to the default one
 * is allowed — it is how a candidate switches length approvals off.
 */
export const candidateConfigRelations = Object.freeze([
  Object.freeze({ lower: "letter.body_paragraphs.min", upper: "letter.body_paragraphs.max" }),
  Object.freeze({ lower: "letter.body_words.min", upper: "letter.body_words.target" }),
  Object.freeze({ lower: "letter.body_words.target", upper: "letter.body_words.max" }),
  Object.freeze({ lower: "letter.body_words.max", upper: "letter.body_words.approved_max" }),
  // The two ends of the outside-home contractor curve: a target at the floor would leave its bands
  // no width to divide by.
  Object.freeze({
    lower: "compensation.floors.outside_home_contractor.amount",
    strict: true,
    upper: "compensation.target",
  }),
]);

/**
 * Pairs of declared string keys whose values must differ. An ordering cannot say it, and a pair
 * that coincides breaks a reader silently: two markets with one name would make every market in an
 * artifact both the home market and the one outside it.
 */
export const candidateConfigDistinct = Object.freeze([
  Object.freeze({ one: "markets.home.name", other: "markets.outside_home.name" }),
]);

/**
 * Pairs of declared country-list keys where every member of `subset` must also be in `superset`.
 * The scorer reads a home-region listing as inside the feasible-residence set, and the candidate
 * reaches a self-relocation destination without sponsorship, which is what the set means.
 */
export const candidateConfigSubsets = Object.freeze([
  Object.freeze({ subset: "mobility.home_region", superset: "mobility.feasible_residences" }),
  Object.freeze({ subset: "mobility.self_relocation", superset: "mobility.feasible_residences" }),
]);

/**
 * Pairs of declared list keys that may share no member. An excluded destination ends a vacancy
 * before any tier is read, so pricing it would be a value nothing reads, and listing it as a
 * residence would contradict it; a country in two tiers has no one score.
 */
export const candidateConfigDisjoint = Object.freeze([
  Object.freeze({ one: "mobility.excluded_destinations", other: "mobility.feasible_residences" }),
  // An excluded destination is never a ranked one: the profile is not interested in it at all.
  Object.freeze({ one: "mobility.excluded_destinations", other: "priorities.relocation_destinations" }),
  ...RELOCATION_TIER_NAMES.map((tier) => Object.freeze({
    one: "mobility.excluded_destinations",
    other: `mobility.relocation_tiers.${tier}`,
  })),
  Object.freeze({ one: "mobility.relocation_tiers.high", other: "mobility.relocation_tiers.middle" }),
  Object.freeze({ one: "mobility.relocation_tiers.high", other: "mobility.relocation_tiers.low" }),
  Object.freeze({ one: "mobility.relocation_tiers.middle", other: "mobility.relocation_tiers.low" }),

]);

export const candidateConfigKeyTypes = Object.freeze(["boolean", "integer", "integer[]", "string", "string[]", "record[]"]);

export function declaredCandidateKeyPaths(keys = candidateConfigKeys) {
  return Object.freeze(keys.map((key) => key.path).sort());
}
