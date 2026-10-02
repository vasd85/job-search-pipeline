/**
 * The candidate's priority classes: which remote work and which relocation the profile ranks.
 *
 * The engine keeps the form of the classes — 1 is remote work for a company of a ranked region,
 * 2 is any other remote work with a known region, 3 is a sponsored relocation to a ranked
 * destination — and the `priorities.*` keys of the config say which regions and destinations are
 * ranked. Nothing here is a scoring value: the scorer never reads a class, so none of these keys
 * travels in the scorer input.
 *
 * WEST is a flag of its own rather than a member of the destination list, as `mobility.west_tier`
 * is beside the tier lists: the list stays a list of country codes, and a country the candidate
 * excludes is taken out of the ranked set whether it came in through the flag or through the list.
 */

import { WEST_COUNTRY_CODES } from "../job-scorer/iso-3166.mjs";

/** The company regions a remote class can name: the scorer's region vocabulary, less UNKNOWN. */
export const PRIORITY_COMPANY_REGIONS = Object.freeze(["WEST", "HOME", "OTHER"]);

/** Distinct company regions of the vocabulary above; the list may be empty. */
export function acceptsCompanyRegions(value) {
  return value.every((region) => PRIORITY_COMPANY_REGIONS.includes(region))
    && new Set(value).size === value.length;
}

/**
 * The priorities of a validated config, in the shape the pre-triage stage takes them:
 * `relocationCountries` is the whole ranked destination set, spelled out — every WEST country when
 * the flag is set, plus the listed countries, less every excluded destination.
 */
export function candidatePrioritiesFrom(config) {
  const { priorities, mobility } = config;
  const excluded = new Set(mobility.excluded_destinations);
  const ranked = new Set([
    ...(priorities.relocation_west ? WEST_COUNTRY_CODES : []),
    ...priorities.relocation_destinations,
  ]);
  return Object.freeze({
    remoteCompanyRegions: Object.freeze([...priorities.remote_company_regions]),
    relocationWest: priorities.relocation_west,
    relocationCountries: Object.freeze([...ranked].filter((code) => !excluded.has(code)).sort()),
  });
}
