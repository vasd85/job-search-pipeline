// LinkedIn guest adapter.
//
// The route is not invented here: `instructions/skills/get-vacancy.md` already declares the
// guest endpoint `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{JOB_ID}` with browser
// headers and ~2 s between requests, and that recipe is pinned by
// tests/instruction-contracts.test.mjs. This adapter is that recipe made executable for the
// triage lane; it adds no second route and no fallback route.
//
// Like every route fact in this repository, the endpoint is vendor-documented and
// audit-observed, not verified by this repository. A green fixture here proves the parsing
// contract, never live LinkedIn behaviour.

import {
  collectText,
  findElement,
  genericChromeTags,
  hasClassContaining,
  parseHtml,
} from "../html-text.mjs";
import {
  adapterReading,
  htmlMediaTypes,
  matchedMarker,
  mediaType,
  meetsMinimumContent,
  requestHeaders,
} from "./contract.mjs";
import { parseHttpUrl } from "../url-rule.mjs";

export const linkedinGuestRoute = Object.freeze({
  sourceId: "linkedin",
  urlTemplate: "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{JOB_ID}",
  method: "GET",
  verification: "vendor-documented and audit-observed; not verified by this repository",
});

// LinkedIn's own bot-block status. It is not a standard status and no status table row covers
// it, which is exactly why it is read as a block page rather than as an unknown status.
const ANTI_BOT_STATUS = 999;

// LinkedIn's own wall paths. Exported because a LinkedIn page this adapter does not serve - a company
// feed, a post - reaches the generic adapter, and LinkedIn walls it with the same redirect; the
// generic adapter reads these lists rather than keeping a copy that could drift.
export const linkedinAntiBotPathPrefixes = Object.freeze(["/checkpoint"]);
export const linkedinAuthWallPathPrefixes = Object.freeze([
  "/authwall", "/login", "/signup", "/uas/login",
]);

// First-party closure statements observed in guest HTML. The list is bounded and ratchets: a
// newly observed phrasing is appended here in its own change, never inferred at run time.
export const closedBannerMarkers = Object.freeze([
  "no longer accepting applications",
  "this job is no longer available",
  "this job has been closed",
]);

// Ordered description-container predicates. The first match wins; nothing else is treated as a
// description, so a missing container is reported rather than approximated by a neighbouring
// block.
const DESCRIPTION_CLASS_FRAGMENTS = Object.freeze([
  "show-more-less-html__markup",
  "description__text",
  "jobs-description",
]);

/**
 * Extract the numeric LinkedIn job id from a posting URL.
 * Accepts the canonical `/jobs/view/...` posting path and the collection page's
 * `currentJobId` parameter; anything else fails closed rather than guessing which path segment
 * is an id.
 */
export function extractJobId(value) {
  const url = parseHttpUrl(value);
  if (url === null) return null;
  const host = url.hostname.toLowerCase().replace(/\.+$/u, "");
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;

  const current = url.searchParams.get("currentJobId");
  if (current !== null && /^[0-9]{1,20}$/u.test(current)) return current;

  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const viewIndex = segments.indexOf("view");
  if (viewIndex === -1 || segments[viewIndex - 1] !== "jobs") return null;
  const slug = segments[viewIndex + 1];
  if (typeof slug !== "string") return null;
  // The posting segment is either the bare id or `<title-slug>-<id>`.
  const match = slug.match(/^(?:.*-)?([0-9]{1,20})$/u);
  return match ? match[1] : null;
}

function isAntiBot(status, finalPath) {
  if (status === ANTI_BOT_STATUS) return true;
  return linkedinAntiBotPathPrefixes.some((prefix) => finalPath.startsWith(prefix));
}

function isAuthWall(finalPath) {
  return linkedinAuthWallPathPrefixes.some((prefix) => finalPath.startsWith(prefix));
}

export const linkedinGuestAdapter = Object.freeze({
  id: "linkedin-guest",
  version: 1,
  sourceId: "linkedin",

  matches(value) {
    return extractJobId(value) !== null;
  },

  route(value, { userAgent } = {}) {
    const jobId = extractJobId(value);
    if (jobId === null) return null;
    return {
      url: linkedinGuestRoute.urlTemplate.replace("{JOB_ID}", jobId),
      method: linkedinGuestRoute.method,
      headers: requestHeaders(userAgent),
      context: { jobId },
    };
  },

  interpret({ transportFailure, status, finalUrl, contentType, body, context }) {
    const reasons = [];
    const jobId = context?.jobId ?? null;
    const finalPath = (() => {
      const parsed = parseHttpUrl(finalUrl ?? "");
      return parsed === null ? "" : parsed.pathname;
    })();

    if (transportFailure !== null) {
      reasons.push("transport_failed");
      return adapterReading({
        reasons,
        structural: { jobIdPresent: null, descriptionContainerFound: null },
        structuralOk: false,
      });
    }

    const antiBot = isAntiBot(status, finalPath);
    if (antiBot) reasons.push("anti_bot_page");
    const authWall = !antiBot && isAuthWall(finalPath);
    if (authWall) reasons.push("auth_wall");
    if (status === 429) reasons.push("rate_limited");

    const type = mediaType(contentType);
    // The guest endpoint answers with an HTML fragment. A missing content type is tolerated,
    // because the fragment route has been observed without one; a declared non-HTML type is
    // not, because parsing JSON as markup silently produces plausible nonsense.
    if (type !== null && !htmlMediaTypes.includes(type)) {
      reasons.push("unsupported_content_type");
      return adapterReading({
        antiBot,
        authWall,
        reasons,
        structural: { jobIdPresent: null, descriptionContainerFound: null },
        structuralOk: false,
      });
    }

    const { root, nodeCeilingHit, depthCeilingHit } = parseHtml(body ?? "");
    const container = findElement(root, (node) =>
      DESCRIPTION_CLASS_FRAGMENTS.some((fragment) =>
        hasClassContaining(node, fragment)));
    const descriptionContainerFound = container !== null;
    if (!descriptionContainerFound) reasons.push("description_container_absent");

    // The whole fragment is persisted, not only the description container: the guest card also
    // carries title, company and location, which triage needs and which no later step can
    // recover from a description-only file. The container check stays a structural check.
    const text = collectText(root, { skipTags: genericChromeTags });
    const minimumContentMet = meetsMinimumContent(text);
    if (!minimumContentMet) reasons.push("content_below_minimum");

    // Identity guard: the requested job id must be present in the response as a standalone
    // number. `jobId` is validated as digits before it reaches this expression, so the pattern
    // is built from a bounded literal and cannot be steered by source text.
    const jobIdPresent = jobId === null
      ? null
      : new RegExp(`(?<![0-9])${jobId}(?![0-9])`, "u").test(body ?? "");
    if (jobIdPresent === false) reasons.push("identity_unconfirmed");

    const statusWord = matchedMarker(text, closedBannerMarkers) === null ? null : "closed";

    return adapterReading({
      antiBot,
      authWall,
      statusWord,
      reasons,
      text: text.length > 0 ? text : null,
      // Every check this adapter claims must hold. The description container is part of that on
      // purpose: the 2026-08-18 run watched LinkedIn's selectors break mid-batch, so a fragment
      // whose container is gone is a degraded adapter reporting a usable capture. It still gets
      // persisted as evidence, and it still routes the vacancy to the browser fallback.
      structuralOk: descriptionContainerFound && jobIdPresent !== false && minimumContentMet,
      structural: {
        jobIdPresent,
        descriptionContainerFound,
        descriptionChars: container === null
          ? 0
          : collectText(container, { skipTags: genericChromeTags }).length,
        minimumContentMet,
        nodeCeilingHit,
        depthCeilingHit,
      },
    });
  },
});
