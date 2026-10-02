// The shared adapter contract for the triage fetch layer.
//
// An adapter answers three questions about one source and nothing else: does it serve this URL,
// which route does it request, and what did the response contain. It never decides an outcome
// name — it reports observations, and tools/vacancy-fetch/outcome.mjs resolves them through the
// single ADR 0012 status table. It never fetches, never writes a file, never sleeps and never
// reads the clock, so every adapter is exercised offline against frozen fixtures.
//
// Adding an adapter is therefore a bounded change: one module exporting one object of this
// shape, one line in ./index.mjs, and one fixture per behaviour it claims. It cannot disable
// another adapter, because the registry selects exactly one and none of them share state.

/**
 * @typedef {object} AdapterObservation
 * @property {?string} transportFailure bounded transport code, or null when a response arrived
 * @property {?number} status           HTTP status of the final response
 * @property {?string} finalUrl         final URL, already narrowed by the URL rule
 * @property {?string} contentType      lowercased media type without parameters
 * @property {string}  body             decoded response body
 * @property {object}  context          whatever `route` recorded about the request
 *
 * @typedef {object} AdapterReading
 * @property {?string} text          extracted visible text, or null when nothing was extracted
 * @property {object}  structural    named structural checks; every key is a boolean or a number
 * @property {boolean} structuralOk  every structural check this adapter claims actually held
 * @property {boolean} antiBot       a challenge, interstitial or block page was served
 * @property {boolean} authWall      a credential, consent or membership wall was served
 * @property {?string} statusWord    a first-party status word the source stated
 * @property {boolean} unlisted      a first-party listing flag said the posting is not listed
 * @property {string[]} reasons      bounded reason codes, never source text
 */

// Every reason code a record may carry. Bounded on purpose: a reason is a machine signal the
// caller branches on, never prose and never a quotation from an untrusted page.
export const adapterReasonCodes = Object.freeze([
  "anti_bot_page",
  "auth_wall",
  "content_below_minimum",
  "deferred_content_suspected",
  "description_container_absent",
  "identity_unconfirmed",
  "rate_limited",
  "route_unresolved",
  "transport_failed",
  "unsupported_content_type",
  "unknown_shape",
]);

// The one code a module outside the adapters branches on by name. The deferred-content signal
// carries a rule of its own - one browser completeness check per usable record that fires it -
// and tools/vacancy-fetch/batch.mjs counts that demand, so the code is a constant here rather
// than a string literal over there that a rename would silently leave behind. It is a member of
// the list above, and the suite holds it to that.
export const deferredContentReason = "deferred_content_suspected";

// The canonical Step 1 recipes fetch LinkedIn and Lever "with browser headers". The same
// headers are used here so the triage transport and the per-role transport ask for the same
// representation of a page; a request that identifies itself differently is a different
// measurement, and the rollout runbook says so explicitly.
export const defaultRequestHeaders = Object.freeze({
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
});

export function requestHeaders(userAgent) {
  return typeof userAgent === "string" && userAgent.length > 0
    ? Object.freeze({ ...defaultRequestHeaders, "user-agent": userAgent })
    : defaultRequestHeaders;
}

/** Minimum usable extraction, shared by every adapter so one source cannot lower the bar. */
export const minimumContent = Object.freeze({ characters: 400, words: 60 });

export function meetsMinimumContent(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length < minimumContent.characters) return false;
  return trimmed.split(/\s+/u).filter((word) => word.length > 0).length
    >= minimumContent.words;
}

/** Case-insensitive containment against a bounded marker list; markers are repository-owned. */
export function matchedMarker(text, markers) {
  if (typeof text !== "string" || text.length === 0) return null;
  const haystack = text.toLowerCase();
  return markers.find((marker) => haystack.includes(marker)) ?? null;
}

/** Media type without parameters, lowercased. */
export function mediaType(contentType) {
  if (typeof contentType !== "string") return null;
  const value = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return value.length === 0 ? null : value;
}

export const htmlMediaTypes = Object.freeze([
  "text/html", "application/xhtml+xml", "application/xml", "text/xml",
]);

/**
 * Build one adapter reading.
 *
 * Shared by every adapter so the shape cannot drift per source, and so the bounded reason
 * vocabulary above is load-bearing rather than decoration: an unknown code throws here. That is a
 * programming error, not source data — a caller branches on the bounded set, and an unrecognized
 * code would fall through every branch silently.
 */
export function adapterReading({
  antiBot = false,
  authWall = false,
  statusWord = null,
  unlisted = false,
  reasons = [],
  structural = {},
  structuralOk = false,
  text = null,
} = {}) {
  const unique = [...new Set(reasons)];
  for (const reason of unique) {
    if (!adapterReasonCodes.includes(reason)) {
      throw new Error(`unknown adapter reason code: ${reason}`);
    }
  }
  return { antiBot, authWall, statusWord, unlisted, reasons: unique, structural, structuralOk, text };
}
