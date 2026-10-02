// Generic rendered-HTML adapter.
//
// This is the adapter that makes an arbitrary vacancy URL scoreable: any link with a job
// description, not only the sources that have a dedicated route. It is also the weakest one,
// and it says so in its own record rather than in a footnote — it has no first-party status
// vocabulary, so it can never conclude that a posting is closed or private. Its terminal
// verdicts are exactly the ones a route that answers for one page can support: `absent` from a
// 404/410, `active` from a page that yielded enough content, and `access_failure` otherwise.
//
// ADR 0012 leaves one branch of the generic fallback open for the user: whether a run served
// only by the generic path may publish a completed Step 1 outcome, or must be blocked until an
// adapter exists. That question is about Step 1 publication and is untouched here — this layer
// publishes nothing into a reserved output directory and reserves no process.

import {
  collectText,
  genericChromeTags,
  parseHtml,
  textLength,
  walkElements,
} from "../html-text.mjs";
import {
  deferredContentSuspected,
  measureJsonIslandProse,
} from "../deferred-content.mjs";
import { detectJobSource } from "../../job-sources/registry.mjs";
import { parseHttpUrl } from "../url-rule.mjs";
import {
  linkedinAntiBotPathPrefixes,
  linkedinAuthWallPathPrefixes,
} from "./linkedin-guest.mjs";
import {
  adapterReading,
  htmlMediaTypes,
  matchedMarker,
  mediaType,
  meetsMinimumContent,
  requestHeaders,
} from "./contract.mjs";

// Bounded challenge/interstitial markers. Every entry is a phrase a challenge page prints
// instead of the posting; none of them is a phrase a job description would carry.
export const antiBotMarkers = Object.freeze([
  "attention required! | cloudflare",
  "checking your browser before accessing",
  "enable javascript and cookies to continue",
  "just a moment...",
  "please enable cookies.",
  "please verify you are a human",
  "request unsuccessful. incapsula incident id",
  "verifying you are human",
]);

export const authWallMarkers = Object.freeze([
  "sign in to continue reading",
  "you must be logged in to view this page",
]);

const MAIN_CONTENT_TAGS = new Set(["article", "main"]);

/**
 * Which LinkedIn wall the final URL names, read from the URL rather than the page's language.
 * A LinkedIn page no dedicated adapter serves - a company feed, a post - is walled by a redirect to
 * LinkedIn's own sign-in or checkpoint path, and the form it lands on is in whatever language
 * LinkedIn chose. The host is identified by the registry, never by a second domain matcher here.
 */
function linkedinWallAt(finalUrl) {
  if (detectJobSource(finalUrl)?.id !== "linkedin") return null;
  const path = parseHttpUrl(finalUrl)?.pathname ?? "";
  if (linkedinAntiBotPathPrefixes.some((prefix) => path.startsWith(prefix))) return "anti_bot";
  if (linkedinAuthWallPathPrefixes.some((prefix) => path.startsWith(prefix))) return "auth_wall";
  return null;
}

function isMainContent(node) {
  if (MAIN_CONTENT_TAGS.has(node.tag)) return true;
  const role = Object.hasOwn(node.attributes, "role")
    ? node.attributes.role.trim().toLowerCase()
    : "";
  return role === "main";
}

/**
 * Choose the container to extract from.
 * Semantic containers only: `<main>`, `<article>` and `role="main"`. When several exist the
 * longest wins; when none exists the whole document is used with page chrome dropped. No
 * scoring heuristic over arbitrary `<div>` elements, because a heuristic that picks the wrong
 * block produces a confident, wrong job description instead of a visible failure.
 */
export function selectContentContainer(root) {
  const candidates = walkElements(root).filter((node) => isMainContent(node));
  if (candidates.length === 0) return { container: root, semantic: false };
  let best = candidates[0];
  let bestLength = textLength(best, { skipTags: genericChromeTags });
  for (const candidate of candidates.slice(1)) {
    const length = textLength(candidate, { skipTags: genericChromeTags });
    if (length > bestLength) {
      best = candidate;
      bestLength = length;
    }
  }
  return { container: best, semantic: true };
}

export const genericHtmlAdapter = Object.freeze({
  id: "generic-html",
  version: 1,
  // Serves whatever no dedicated adapter claims, so it declares no registry source id.
  sourceId: null,

  matches() {
    return true;
  },

  route(value, { userAgent } = {}) {
    return {
      url: value,
      method: "GET",
      headers: requestHeaders(userAgent),
      context: {},
    };
  },

  // Every reading this adapter builds leaves `statusWord` null and `unlisted` false, because it
  // reads no first-party status vocabulary and no listing flag. That is what makes `closed` and
  // `private` unreachable through the generic path, and it is a property, not an oversight.
  interpret({ transportFailure, status, finalUrl, contentType, body }) {
    const reasons = [];
    if (transportFailure !== null) {
      reasons.push("transport_failed");
      return adapterReading({ reasons, structural: { semanticContainer: null } });
    }
    if (status === 429) reasons.push("rate_limited");

    const type = mediaType(contentType);
    const plainText = type === "text/plain";
    if (type !== null && !plainText && !htmlMediaTypes.includes(type)) {
      // A JSON or PDF body parsed as markup yields plausible nonsense. An ATS JSON route is a
      // dedicated adapter's job, not this one's.
      reasons.push("unsupported_content_type");
      return adapterReading({ reasons, structural: { semanticContainer: null } });
    }

    let text;
    let structural;
    if (plainText) {
      text = body ?? "";
      structural = {
        semanticContainer: false,
        nodeCeilingHit: false,
        depthCeilingHit: false,
        bodyChars: text.length,
        jsonProseChars: 0,
        jsonIslandUnparsed: false,
        jsonWalkBudgetHit: false,
      };
    } else {
      const { root, nodeCeilingHit, depthCeilingHit } = parseHtml(body ?? "");
      const { container, semantic } = selectContentContainer(root);
      text = collectText(container, { skipTags: genericChromeTags });
      const deferred = measureJsonIslandProse(body ?? "");
      structural = {
        semanticContainer: semantic,
        nodeCeilingHit,
        depthCeilingHit,
        bodyChars: (body ?? "").length,
        jsonProseChars: deferred.jsonProseChars,
        jsonIslandUnparsed: deferred.jsonIslandUnparsed,
        jsonWalkBudgetHit: deferred.jsonWalkBudgetHit,
      };
    }

    const wallAt = linkedinWallAt(finalUrl);
    const antiBot = wallAt === "anti_bot" || matchedMarker(text, antiBotMarkers) !== null;
    if (antiBot) reasons.push("anti_bot_page");
    const authWall = !antiBot
      && (wallAt === "auth_wall" || matchedMarker(text, authWallMarkers) !== null);
    if (authWall) reasons.push("auth_wall");

    const minimumContentMet = meetsMinimumContent(text);
    if (!minimumContentMet) reasons.push("content_below_minimum");

    // The architecture signal, advisory by design: the record stays usable, and the caller's
    // policy owns what a fired signal costs. The verdict itself lives in deferred-content.mjs.
    if (deferredContentSuspected(structural, text.length)) {
      reasons.push("deferred_content_suspected");
    }

    return adapterReading({
      antiBot,
      authWall,
      reasons,
      text: text.length > 0 ? text : null,
      // A career page without a semantic container is ordinary, so the body fallback is not a
      // failed check — it is recorded as a fact and nothing more. The only check this adapter
      // claims is that it extracted enough content to be a job description at all.
      structuralOk: minimumContentMet,
      structural: { ...structural, minimumContentMet },
    });
  },
});
