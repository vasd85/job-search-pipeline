/**
 * The two markets of the candidate layer: the home market and the market outside home.
 *
 * The engine knows the distinction and nothing else. Which countries make the home market, what
 * each market is called in the artifacts, which location and timezone the materials state, and
 * the working hours in the home timezone are the candidate's, set by the `markets.*` keys of the
 * config. A vacancy and a brief carry one of the two names; the side it names is what decides
 * whether a material states positioning and whether the company's contractor logistics are
 * researched.
 *
 * Only the config is read, as for the language names: a step that classifies a market needs no
 * pack and no document of the layer.
 */

import { acceptsSingleLine } from "./languages.mjs";

const MARKET_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const MAX_MARKET_NAME = 40;
const MAX_HOME_COUNTRIES = 50;
// `UTC`, or a whole-hour offset from -14 to +14 with an optional half or three-quarter hour. The
// sign is the keyboard hyphen: a material states the value as it is written here, and rule 21
// keeps every other dash out of a material.
const TIMEZONE = /^UTC(?:[+-](?:[0-9]|1[0-4])(?::(?:30|45))?)?$/u;
// Two clock times, `HH:MM-HH:MM`, joined by the keyboard hyphen. The end may be `24:00`, the end
// of the day; an end earlier than the start is a window across midnight.
const CLOCK = "(?:[01][0-9]|2[0-3]):[0-5][0-9]";
const WORKING_HOURS = new RegExp(`^(${CLOCK})-(${CLOCK}|24:00)$`, "u");

/** The two sides a market name can stand for. */
export const MARKET_SIDES = Object.freeze({ home: "home", outsideHome: "outside_home" });

/** The config bound of a market name: lowercase words joined by single hyphens, from a letter. */
export function acceptsMarketName(value) {
  return value.length <= MAX_MARKET_NAME && MARKET_NAME.test(value);
}

/** The config bound of a stated timezone. */
export function acceptsTimezone(value) {
  return TIMEZONE.test(value);
}

/**
 * The config bound of the working hours: two clock times that differ. A window of no length would
 * make every overlap window fail to fit, and `00:00-24:00` is how the whole day is written.
 */
export function acceptsWorkingHours(value) {
  const match = WORKING_HOURS.exec(value);
  return match !== null && match[1] !== match[2];
}

/** The config bound of the home countries: at least one, distinct, each a one-line name. */
export function acceptsHomeCountries(value) {
  return (
    value.length > 0 &&
    value.length <= MAX_HOME_COUNTRIES &&
    value.every(acceptsSingleLine) &&
    new Set(value).size === value.length
  );
}

/** The markets of a validated config. */
export function candidateMarketsFrom(config) {
  const { home, outside_home: outsideHome } = config.markets;
  return Object.freeze({
    home: Object.freeze({
      countries: Object.freeze([...home.countries]),
      name: home.name,
      timezone: home.timezone,
      workingHours: home.working_hours,
    }),
    outsideHome: Object.freeze({
      location: outsideHome.location,
      name: outsideHome.name,
      timezone: outsideHome.timezone,
    }),
  });
}

/**
 * The side a market name stands for under `markets`, or `null` when it names neither market — and
 * always `null` without markets, which is what a checkout without a layer configures.
 */
export function marketSide(markets, name) {
  if (markets === null || markets === undefined) return null;
  if (name === markets.home.name) return MARKET_SIDES.home;
  if (name === markets.outsideHome.name) return MARKET_SIDES.outsideHome;
  return null;
}

/** The configured market names, the home one first; none without markets. */
export function marketNames(markets) {
  if (markets === null || markets === undefined) return Object.freeze([]);
  return Object.freeze([markets.home.name, markets.outsideHome.name]);
}
