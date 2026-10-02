/**
 * What the collection actually contains, measured against the candidate's own priority classes.
 *
 * Measured basis (2026-08-18 verified run): 1 link of 10 matched the priority-1 class and 8 were
 * on-site relocation outside it. Nothing in the run said so until every link had been through the
 * full pipeline, so the shape of the collection was discovered by paying for it. This module is
 * what lets the user see that shape from the cheap header facts and decide whether to keep
 * spending - the decision is theirs, and the report exists to inform it, not to skip anything.
 *
 * **Where the classes come from.** The engine keeps their form: 1 is remote work for a company of
 * a ranked region, 2 is any other remote work with a known region, and 3 is a relocation with visa
 * sponsorship to a ranked destination. Which regions and destinations are ranked is the
 * candidate's, set by the `priorities.*` keys of the config and handed in by the caller as
 * `candidate/load.mjs#candidatePriorities` returns them. docs/runbooks/triage-review.md#21-pre-triage-freshness-order-composition
 * states the mapping from observations to the classes, and this module implements it once.
 *
 * **This module names no country.** A destination is an ISO 3166-1 alpha-2 code, the vocabulary the
 * scorer's extraction already records one in, and the ranked set arrives spelled out as codes. The
 * one table read here is the engine's own list of the WEST region's countries, which the rubric's
 * knowledge/job-match-rules.md#31-m--mobility--work-feasibility already owns.
 */
import { WEST_COUNTRY_CODES, isCountryCode } from "../job-scorer/iso-3166.mjs";
import { fail } from "./errors.mjs";

/** The three ranked classes, plus the two answers that are not a class. */
export const compositionBuckets = Object.freeze(["1", "2", "3", "outside", "unknown"]);

const WORK_FORMATS = Object.freeze(["Remote", "Hybrid", "On-site", "Unknown"]);
const COMPANY_REGIONS = Object.freeze(["WEST", "HOME", "OTHER", "UNKNOWN"]);
const KNOWN_COMPANY_REGIONS = Object.freeze(COMPANY_REGIONS.filter((region) => region !== "UNKNOWN"));
const SPONSORSHIP = Object.freeze(["available", "unavailable", "unknown"]);
const west = new Set(WEST_COUNTRY_CODES);

function enumValue(value, allowed, field) {
  if (!allowed.includes(value)) {
    fail("pretriage_observation_invalid", `The observation field ${field} carries an unknown value.`);
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function distinctList(value, accepts) {
  return Array.isArray(value) && value.every(accepts) && new Set(value).size === value.length;
}

/**
 * The priorities as `candidatePriorities` returns them, checked before any observation is read: a
 * missing or malformed set would otherwise answer every class as if nothing were ranked.
 */
function checkedPriorities(options) {
  const priorities = isPlainObject(options) ? options.priorities : undefined;
  if (
    !isPlainObject(priorities)
    || !distinctList(priorities.remoteCompanyRegions, (region) => KNOWN_COMPANY_REGIONS.includes(region))
    || typeof priorities.relocationWest !== "boolean"
    || !distinctList(priorities.relocationCountries, isCountryCode)
  ) {
    fail("pretriage_priorities_invalid", "The priorities must be the candidate layer's, as candidatePriorities returns them.");
  }
  return priorities;
}

/**
 * Is the offered relocation destination a ranked one?
 * Returns `true`, `false`, or `null` when the observation cannot answer.
 *
 * A destination code decides on its own: the ranked set is spelled out, and a destination the
 * candidate excludes is never in it, whichever region the company is in. Without a code only the
 * company region is left, at lower precision: a WEST company is ranked when the whole region is,
 * and answers `null` when only some WEST countries are; a HOME or OTHER company is `false`, which is
 * what makes the report's main signal work - a collection of on-site postings outside the ranked
 * regions lands in `outside` rather than in `unknown`. The price of the missing code is named
 * twice: a ranked country outside WEST is not recognised in a HOME or OTHER company's posting, and
 * with the whole region ranked an excluded WEST country is ranked on its company's region.
 */
function destinationRanked(observation, priorities, companyRegion) {
  // Nothing ranked at all: no observation can place a destination inside an empty set.
  if (!priorities.relocationWest && priorities.relocationCountries.length === 0) return false;
  const code = observation.relocation_destination_code ?? null;
  if (code !== null) return priorities.relocationCountries.includes(code);
  if (companyRegion === "WEST") {
    if (priorities.relocationWest) return true;
    return priorities.relocationCountries.some((country) => west.has(country)) ? null : false;
  }
  if (companyRegion === "UNKNOWN") return null;
  return false;
}

/**
 * The class of remote work: by the company region, and without one only where the region cannot
 * matter - no ranked region makes it `2`, every region ranked makes it `1`.
 */
function remoteClass(companyRegion, priorities) {
  const ranked = priorities.remoteCompanyRegions;
  if (companyRegion !== "UNKNOWN") return ranked.includes(companyRegion) ? "1" : "2";
  if (ranked.length === 0) return "2";
  if (ranked.length === KNOWN_COMPANY_REGIONS.length) return "1";
  return "unknown";
}

/**
 * The priority class of one observation under the candidate's priorities.
 *
 * The **values** are the scorer's own vocabulary; the **field names** are this stage's, because the
 * scorer spells its normalized offer in camelCase and its trace with a `selected_` prefix, and this
 * observation is neither of those - it is header facts read before anything was scored.
 * docs/runbooks/triage-review.md#21-pre-triage-freshness-order-composition states the accepted shape. `outside` means the vacancy is
 * genuinely outside the three ranked classes - such a role is still acceptable, only not ranked -
 * and `unknown` means the source did not carry what the class needs.
 */
export function priorityClassFor(observation, options) {
  const priorities = checkedPriorities(options);
  if (!isPlainObject(observation)) {
    fail("pretriage_observation_invalid", "A composition observation must be an object.");
  }
  if (Object.hasOwn(observation, "relocation_destination")) {
    // The field that named the country by name. A caller still writing it would have its
    // destination silently ignored, so it is refused and the refusal names the field that replaced it.
    fail("pretriage_observation_invalid", "The observation names its relocation country by code, in relocation_destination_code.");
  }
  const workFormat = enumValue(observation.work_format, WORK_FORMATS, "work_format");
  const companyRegion = enumValue(observation.company_region, COMPANY_REGIONS, "company_region");
  const sponsorship = enumValue(
    observation.sponsorship ?? "unknown",
    SPONSORSHIP,
    "sponsorship",
  );
  const code = observation.relocation_destination_code;
  if (code !== undefined && code !== null && !isCountryCode(code)) {
    fail("pretriage_observation_invalid", "The observation field relocation_destination_code must be an ISO 3166-1 alpha-2 code or null.");
  }

  if (workFormat === "Unknown") return "unknown";
  if (workFormat === "Remote") return remoteClass(companyRegion, priorities);
  // Hybrid and On-site: the only ranked class left is a sponsored relocation, and the class says
  // "with visa sponsorship". Paying for the move is a different fact - the rubric keeps
  // `relocationSupport` and `sponsorship` apart for exactly that reason - so it does not qualify.
  const ranked = destinationRanked(observation, priorities, companyRegion);
  if (ranked === false) return "outside";
  if (ranked === null) return "unknown";
  if (sponsorship === "available") return "3";
  if (sponsorship === "unavailable") return "outside";
  return "unknown";
}

/**
 * The same class in the shape `triage-ledger.json` stores: `1`, `2`, `3`, or `null` for a row that
 * carries no `priority_class` field at all.
 *
 * This is the seam that makes "implemented once" true rather than claimed. The ledger's schema
 * accepts the numbers 1, 2 and 3 and nothing else — `outside` and `unknown` have no representation
 * there, and a ledger row that omits the field is exactly the statement that the class is not
 * known. `tests/pretriage.test.mjs` writes the result of this function through `recordBatch` so the
 * agreement is proved against the real validator rather than asserted here.
 */
export function priorityClassForLedger(observation, options) {
  const bucket = priorityClassFor(observation, options);
  return bucket === "outside" || bucket === "unknown" ? null : Number(bucket);
}

function tally(values, keys) {
  const counts = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const value of values) counts[value] += 1;
  return counts;
}

function share(count, total) {
  return total === 0 ? 0 : Math.round((count / total) * 1000) / 1000;
}

/**
 * The batch composition report: counts and shares, per class and per observed axis.
 *
 * Shares are ratios of the observations supplied, not of the links the batch was handed: a link
 * whose page was never read has no header facts and belongs to the spend accounting instead.
 */
export function composeBatch(observations, options) {
  const priorities = checkedPriorities(options);
  if (!Array.isArray(observations)) {
    fail("pretriage_observation_invalid", "Composition observations must be an array.");
  }
  const classes = observations.map((observation) => priorityClassFor(observation, { priorities }));
  const total = observations.length;
  const byClass = tally(classes, compositionBuckets);
  return {
    total,
    by_priority_class: byClass,
    priority_class_shares: Object.fromEntries(
      compositionBuckets.map((bucket) => [bucket, share(byClass[bucket], total)]),
    ),
    priority_one_share: share(byClass["1"], total),
    by_work_format: tally(
      observations.map((observation) => observation.work_format),
      WORK_FORMATS,
    ),
    by_company_region: tally(
      observations.map((observation) => observation.company_region),
      COMPANY_REGIONS,
    ),
  };
}
