// Machine-owned fetch-route facts for the two job sources repaired by R1-04B. The canonical
// Step 1 recipes in instructions/skills/get-vacancy.md must agree with the literals exported
// here; tests/instruction-contracts.test.mjs pins that agreement so recipe prose and machine
// data cannot diverge again.
//
// Source identification is never repeated here: detectJobSource from ./registry.mjs stays the
// single domain matcher, so the fail-closed company-domain policy and route selection cannot
// drift apart.
//
// Deliberate non-goals: no network access, no HTML or JD normalization, no heading ordering, no
// typed extractor result, no vacancy schema field and no change to ./registry.mjs. The route
// templates are vendor-documented and were observed by the 2026-07-28 audit; this repository
// cannot verify them against the live world, so live-route verification stays with the Step 1
// release gate and the versioned per-source adapters remain future work.

import { detectJobSource } from "./registry.mjs";

const ROUTE_METHOD = "GET";
const SAFE_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const TRAVERSAL_SEGMENT = /(?:^|\/)\.\.?(?:\/|$)/;
const ASHBY_POSTING_HOST = "jobs.ashbyhq.com";
const PINPOINT_SUFFIX = ".pinpointhq.com";
const UNVERIFIED =
  "vendor-documented and audit-observed; not verified by this repository";

export const sourceRouteInventory = Object.freeze({
  ashby: Object.freeze({
    sourceId: "ashby",
    primaryRoute: "board_aggregate",
    urlTemplate:
      "https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true",
    aggregateKeys: Object.freeze(["jobs"]),
    compensationFields: Object.freeze(["compensation", "compensationTierSummary"]),
    statusFields: Object.freeze(["status"]),
    unlistedFlags: Object.freeze(["isListed"]),
    observedAt: "2026-07-28",
    verification: UNVERIFIED,
  }),
  pinpoint: Object.freeze({
    sourceId: "pinpoint",
    primaryRoute: "tenant_aggregate",
    urlTemplate: "https://{tenant}.pinpointhq.com/postings.json",
    aggregateKeys: Object.freeze(["data"]),
    compensationFields: Object.freeze([]),
    statusFields: Object.freeze(["status"]),
    unlistedFlags: Object.freeze([]),
    observedAt: "2026-07-28",
    verification: UNVERIFIED,
  }),
});

// Exact literals that the canonical Step 1 recipes must never carry again.
export const retiredRouteMarkers = Object.freeze([
  "append `.json` to the posting URL",
  "https://jobs.ashbyhq.com/api/non-user-graphql",
  "non-user-graphql",
]);

// Retryability of each bounded failure outcome. This is the only outcome property the lifecycle
// actually enforces; the pipeline-wide access taxonomy belongs to
// docs/adr/0012-versioned-extraction-and-vacancy-v2.md, which inherits these names unchanged and
// puts its orthogonal barrier axis in the extractor rather than here.
export const failureRetryability = Object.freeze({
  absent: false,
  closed: false,
  private: false,
  access_failure: true,
});

// Bounded status vocabulary. A status outside it stays active on purpose: refusing an unknown
// status would turn a live vacancy into a failure, which is the defect this task repairs. The
// consequence is recorded rather than hidden — an unlisted-but-present posting is only detected
// through a declared unlistedFlag, never inferred from prose.
export const statusVocabulary = Object.freeze({
  closed: Object.freeze([
    "archived",
    "closed",
    "deleted",
    "draft",
    "expired",
    "filled",
    "removed",
    "unpublished",
  ]),
  // `unlisted` lives here and not under closed: it is the same real-world condition an unlisted
  // flag describes, and one condition must not carry two bounded names.
  private: Object.freeze([
    "confidential",
    "internal",
    "private",
    "restricted",
    "unlisted",
  ]),
});

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usableSegment(value) {
  return (
    typeof value === "string" &&
    value !== "." &&
    value !== ".." &&
    SAFE_SEGMENT.test(value)
  );
}

function hasTraversal(sourceRef) {
  if (TRAVERSAL_SEGMENT.test(sourceRef)) return true;
  // URL parsing normalizes percent-encoded dot segments away before the path is inspected, so
  // the decoded form has to be checked too.
  let decoded = sourceRef;
  try {
    decoded = decodeURIComponent(sourceRef);
  } catch {
    return true;
  }
  return TRAVERSAL_SEGMENT.test(decoded);
}

function parsedUrl(sourceRef) {
  if (typeof sourceRef !== "string" || hasTraversal(sourceRef)) return null;
  let url;
  try {
    url = new URL(sourceRef);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url;
}

function segmentsOf(url) {
  return url.pathname.split("/").filter((segment) => segment !== "");
}

function route(sourceId, url, board, postingId) {
  return Object.freeze({ sourceId, method: ROUTE_METHOD, url, board, postingId });
}

function pinpointRoute(url) {
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host.endsWith(PINPOINT_SUFFIX)) return null;

  const segments = segmentsOf(url);
  // The last `postings` segment owns the id, so a tenant path that itself contains `postings`
  // cannot shift the identifier onto a locale or section segment.
  const postingsIndex = segments.lastIndexOf("postings");
  if (postingsIndex === -1) return null;

  const postingId = segments[postingsIndex + 1];
  if (!usableSegment(postingId) || segments.length !== postingsIndex + 2) return null;

  return route("pinpoint", `https://${host}/postings.json`, null, postingId);
}

function ashbyRoute(url) {
  if (url.hostname.toLowerCase().replace(/\.+$/, "") !== ASHBY_POSTING_HOST) return null;

  // A public Ashby posting reference is board plus posting id, optionally followed by Ashby's
  // own `application` step. Anything else fails closed rather than guessing which segment is
  // the board.
  const segments = segmentsOf(url);
  const shape =
    segments.length === 2 ||
    (segments.length === 3 && segments[2] === "application");
  if (!shape) return null;
  const [board, postingId] = segments;
  if (!usableSegment(board) || !usableSegment(postingId)) return null;

  const aggregate = new URL(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`,
  );
  aggregate.searchParams.set("includeCompensation", "true");
  if (
    aggregate.origin !== "https://api.ashbyhq.com" ||
    !aggregate.pathname.startsWith("/posting-api/job-board/")
  ) {
    return null;
  }

  return route("ashby", aggregate.toString(), board, postingId);
}

/**
 * Resolve the supported primary fetch route for one posting reference.
 * Returns null when the reference does not identify exactly one posting on a source whose
 * route is machine-owned here.
 */
export function resolveSourceRoute(sourceRef) {
  const source = detectJobSource(sourceRef);
  if (source === null || !Object.hasOwn(sourceRouteInventory, source.id)) return null;

  const url = parsedUrl(sourceRef);
  if (url === null) return null;

  return source.id === "pinpoint" ? pinpointRoute(url) : ashbyRoute(url);
}

function outcome(name, posting) {
  return Object.freeze({
    outcome: name,
    retryable: Object.hasOwn(failureRetryability, name)
      ? failureRetryability[name]
      : false,
    posting,
  });
}

function postingsOf(routeFacts, payload) {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? routeFacts.aggregateKeys
          .map((key) => payload[key])
          .find((value) => Array.isArray(value)) ?? null
      : null;
  if (list === null) return null;
  // A non-empty list without a single posting object is an unusable body, not an empty board.
  if (list.length > 0 && !list.some((entry) => isRecord(entry))) return null;
  return list;
}

function matchesPostingId(entry, postingId) {
  if (!isRecord(entry) || !Object.hasOwn(entry, "id")) return false;
  const id = entry.id;
  if (typeof id !== "string" && typeof id !== "number") return false;
  // Exact and case-sensitive: a prefix or case-folded match would silently hand back a
  // neighbouring posting.
  return String(id) === postingId;
}

function classify(routeFacts, posting) {
  for (const flag of routeFacts.unlistedFlags) {
    if (posting[flag] === false) return "private";
  }
  for (const field of routeFacts.statusFields) {
    const value = posting[field];
    const status = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (statusVocabulary.private.includes(status)) return "private";
    if (statusVocabulary.closed.includes(status)) return "closed";
  }
  return "active";
}

/**
 * Locate one posting inside an aggregate response body and classify the bounded outcome.
 * `body` is either the raw response text or an already parsed value; nothing is fetched here.
 * The returned `posting` is the payload's own object, so callers treat it as read-only source
 * data: it is untrusted content and is never mutated or normalized here.
 */
export function selectPostingFromAggregate(sourceId, body, postingId) {
  const routeFacts = Object.hasOwn(sourceRouteInventory, sourceId ?? "")
    ? sourceRouteInventory[sourceId]
    : null;
  if (routeFacts === null) return outcome("access_failure", null);
  if (typeof postingId !== "string" || postingId === "") {
    return outcome("access_failure", null);
  }

  let payload = body;
  if (typeof body === "string") {
    try {
      payload = JSON.parse(body);
    } catch {
      return outcome("access_failure", null);
    }
  }

  const postings = postingsOf(routeFacts, payload);
  if (postings === null) return outcome("access_failure", null);
  // An aggregate carrying no postings at all proves nothing about one posting, and a live
  // posting behind an empty aggregate is exactly the shape of a wrong or blocked route. It is a
  // retryable access failure, never a permanent absence.
  if (postings.length === 0) return outcome("access_failure", null);

  const posting =
    postings.find((entry) => matchesPostingId(entry, postingId)) ?? null;
  if (posting === null) return outcome("absent", null);

  return outcome(classify(routeFacts, posting), posting);
}

/**
 * Read compensation strictly from the bounded compensation fields of one posting object.
 * Description text is never parsed, so an absent compensation stays unspecified instead of
 * becoming an invented figure.
 */
export function readCompensation(sourceId, posting) {
  const unspecified = Object.freeze({
    status: "unspecified",
    field: null,
    compensation: null,
  });

  const routeFacts = Object.hasOwn(sourceRouteInventory, sourceId ?? "")
    ? sourceRouteInventory[sourceId]
    : null;
  if (routeFacts === null || !isRecord(posting)) return unspecified;

  for (const field of routeFacts.compensationFields) {
    const value = posting[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (isRecord(value) && Object.keys(value).length === 0) continue;
    return Object.freeze({ status: "explicit", field, compensation: value });
  }

  return unspecified;
}
