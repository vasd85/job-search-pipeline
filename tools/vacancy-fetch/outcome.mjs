// The direct-route status table of ADR 0012, implemented once.
//
// Six adapters resolving the same HTTP status independently is how one real condition acquires
// six names, so the table lives here and every adapter reports observations rather than
// verdicts. The bounded outcome names and their retryability are not redefined here either:
// they are imported from tools/job-sources/routes.mjs, which owns them.
//
// Two properties are the point of the table and are preserved literally: a terminal
// unavailability verdict is reachable only from what the source states in its own words or from
// a 404/410 on a route that answers for exactly one posting, and every uncertain observation
// lands on the retryable `access_failure`.

import { failureRetryability, statusVocabulary } from "../job-sources/routes.mjs";

export const outcomeNames = Object.freeze([
  "active", "absent", "closed", "private", "access_failure",
]);

// The orthogonal barrier axis. Every value is retryable, because a barrier describes why a
// fetch did not complete and never asserts that a posting is gone.
export const accessBarriers = Object.freeze([
  "network", "http_status", "unparseable", "authentication", "anti_bot", "rate_limit",
]);

// Transport code to barrier. Every code tools/vacancy-fetch/transport.mjs can return has a
// row; an unrecognized code falls back to `network`, which is retryable and therefore safe.
const transportBarriers = new Map([
  ["aborted", "network"],
  ["invalid_redirect", "unparseable"],
  ["network_error", "network"],
  ["oversize", "unparseable"],
  ["redirect_ceiling", "unparseable"],
  ["timeout", "network"],
]);

function result(outcome, accessBarrier) {
  return Object.freeze({
    outcome,
    accessBarrier,
    retryable: Object.hasOwn(failureRetryability, outcome)
      ? failureRetryability[outcome]
      : false,
  });
}

/**
 * Map one first-party status word onto the bounded vocabulary.
 * Returns null when the word is outside it — an unknown status stays active on purpose,
 * because refusing an unknown status turns a live vacancy into a failure.
 */
export function classifyStatusWord(word) {
  const value = typeof word === "string" ? word.trim().toLowerCase() : "";
  if (value === "") return null;
  if (statusVocabulary.private.includes(value)) return "private";
  if (statusVocabulary.closed.includes(value)) return "closed";
  return null;
}

/**
 * Resolve one direct posting-route observation.
 *
 * `observation` carries only what an adapter saw:
 *   transportFailure  — a bounded transport code, or null when the response arrived
 *   status            — the HTTP status of the final response
 *   antiBot           — a challenge, interstitial or block page was served instead of a posting
 *   authWall          — a credential, consent or membership wall was served
 *   statusWord        — a first-party status word the source stated about the posting
 *   unlisted          — a first-party listing flag said the posting is not listed
 *   hasPostingBody    — a usable posting body was extracted
 *
 * The rows are ordered and the first match wins, so no observation resolves twice.
 */
export function classifyDirectRoute(observation) {
  const {
    transportFailure = null,
    status = null,
    antiBot = false,
    authWall = false,
    statusWord = null,
    unlisted = false,
    hasPostingBody = false,
  } = observation ?? {};

  // A block page is not a posting, and the status it arrives under says nothing about the
  // posting — so this row precedes every status row, including 200 and 404.
  if (antiBot) return result("access_failure", "anti_bot");

  if (transportFailure !== null) {
    // A transport that never completed is `network`; a transport that completed into something
    // this layer cannot read is `unparseable`. Both are retryable, so the distinction is
    // diagnostic rather than a branch the caller has to act on differently.
    return result("access_failure", transportBarriers.get(transportFailure) ?? "network");
  }

  // A wall states what this reader may see, never whether the posting exists.
  //
  // The ADR reaches this verdict from a 401/403 status. A wall page served under some other
  // status is read here under the reasoning of the anti-bot row rather than the 404 row: row 2
  // is "the posting is gone from a route that answers for exactly one posting", and a wall page
  // is not that route answering — it is a different page, arriving under whatever status the
  // wall chose. The ADR calls the fail-safe direction mandatory for exactly this case ("a live
  // posting behind a sign-in or bot wall is a case this repository has already observed"), so a
  // wall never produces a terminal verdict here.
  if (authWall) return result("access_failure", "authentication");

  if (status === 404 || status === 410) return result("absent", null);
  if (status === 401 || status === 403) return result("access_failure", "authentication");
  if (status === 429) return result("access_failure", "rate_limit");
  if (typeof status === "number" && status >= 500 && status <= 599) {
    return result("access_failure", "http_status");
  }

  if (status === 200) {
    // Row order is the ADR's: a stated closed word wins over a listing flag, so a posting that
    // is both archived and unlisted is closed rather than private. One condition keeps one name.
    const stated = classifyStatusWord(statusWord);
    if (stated === "closed") return result("closed", null);
    if (stated === "private" || unlisted) return result("private", null);
    if (hasPostingBody) return result("active", null);
  }

  return result("access_failure", "unparseable");
}
