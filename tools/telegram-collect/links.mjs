// From a parsed post to its typed list of links. Pure, fixture-driven, no model call.
//
// Every anchor of a post gets exactly one entry here, so the report can account for each of them.
// An entry either carries a `type` - it is in the typed list - or a `skipped` reason: a hashtag, a
// scheme that is not the web, a preview card folded into the text link it was born from.
//
// A link leaves this module rebuilt from a parsed URL, never as the raw href. A `url` link is
// `http(s)` only, userinfo and fragment cut, and accepted by the same normaliser the links-file
// readers apply: `readLinksFile` fails the WHOLE file on one link the normaliser refuses, so a
// single oversized tracking URL would cost `/score-jobs` the collection. A `tg` name and an `email`
// address leave as pattern-gated tokens.
//
// A mark never removes a link from the list. It keeps the link out of the scoring addresses and
// names it in the report, so a wrong mark is visible and is fixed from the report, not from code.

import { normalizeVacancyUrl } from "../lib/triage-ledger-core.mjs";
import { handlePattern } from "./config.mjs";
import { normalizedText } from "./text.mjs";

export const linkTypes = Object.freeze(["url", "tg", "tg_other", "email", "unusable"]);
export const linkMarks = Object.freeze(["social", "boilerplate", "excluded", "autolink"]);
export const skipReasons = Object.freeze(["hashtag", "non_web", "preview_folded"]);
export const unusableReasons = Object.freeze([
  "bad_email",
  "local_host",
  "normalizer_refused",
  "too_long",
]);

const MAX_HREF_LENGTH = 2048;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}$/u;

// A repeated address is boilerplate when it stands under this many different texts AND under this
// share of the posts walked. Three alone is not enough: a vacancy in its own post and in two weekly
// digests is three different texts, while a real channel footer stands in nearly every post.
export const BOILERPLATE_MIN_POSTS = 3;
export const BOILERPLATE_MIN_SHARE = 0.25;

const telegramHosts = Object.freeze(["t.me", "telegram.dog", "telegram.me"]);

// First path segments of t.me that are routes, not user names, though they match the name pattern.
const telegramRoutes = Object.freeze([
  "addemoji",
  "addlist",
  "addstickers",
  "addtheme",
  "boost",
  "confirmphone",
  "contact",
  "giftcode",
  "invoice",
  "joinchat",
  "login",
  "proxy",
  "setlanguage",
  "share",
  "socks",
]);

// Social self-promotion. Matched by hostname suffix, so a subdomain is covered and a lookalike
// (`not-x.com`) is not. Telegram is not here: a `t.me` link is a contact, not self-promotion.
export const socialHosts = Object.freeze([
  "discord.com",
  "discord.gg",
  "facebook.com",
  "instagram.com",
  "linktr.ee",
  "telegram.org",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "youtu.be",
  "youtube.com",
]);

function hostOf(url) {
  return url.hostname.toLowerCase().replace(/\.+$/u, "");
}

function matchesHost(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function isLocalOrLiteralHost(host) {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.startsWith("[") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)
  );
}

function pathKey(url) {
  return `${hostOf(url)}${url.pathname.replace(/\/+$/u, "")}`;
}

function telegramLink(url) {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (
    segments.length === 1 &&
    handlePattern.test(segments[0]) &&
    !telegramRoutes.includes(segments[0].toLowerCase())
  ) {
    return { type: "tg", name: segments[0] };
  }
  return { type: "tg_other" };
}

function emailLink(url) {
  let address = url.pathname;
  try {
    address = decodeURIComponent(address);
  } catch {
    return { type: "unusable", reason: "bad_email", host: null };
  }
  if (!EMAIL.test(address)) return { type: "unusable", reason: "bad_email", host: null };
  return { type: "email", address: address.toLowerCase() };
}

function webLink(url) {
  url.username = "";
  url.password = "";
  url.hash = "";
  const host = hostOf(url);
  const clean = url.href;
  if (clean.length > MAX_HREF_LENGTH) return { type: "unusable", reason: "too_long", host };
  if (isLocalOrLiteralHost(host)) return { type: "unusable", reason: "local_host", host };
  let key;
  try {
    key = normalizeVacancyUrl(clean);
  } catch {
    return { type: "unusable", reason: "normalizer_refused", host };
  }
  return {
    type: "url",
    url: clean,
    key,
    host,
    path: url.pathname,
    query: url.search,
    pathKey: pathKey(url),
  };
}

/** One raw href to `{ type, ... }` or `{ skipped }`. */
function readHref(href) {
  if (typeof href !== "string" || href.length === 0) return { skipped: "non_web" };
  let url;
  try {
    // The preview page escapes the ampersands of a query twice, so one HTML decode leaves
    // `&amp;utm_medium=...`. Left alone, the parameter is named `amp;utm_medium`: the ledger's
    // normaliser does not take it for tracking, and one vacancy gets two ledger keys.
    url = new URL(href.replaceAll("&amp;", "&"));
  } catch {
    // Telegram renders a hashtag as a relative search link, `?q=%23tag`.
    return { skipped: /^\?q=/u.test(href) ? "hashtag" : "non_web" };
  }
  if (url.protocol === "mailto:") return emailLink(url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return { skipped: "non_web" };
  if (telegramHosts.some((domain) => matchesHost(hostOf(url), domain))) return telegramLink(url);
  return webLink(url);
}

/** Telegram turns `ASP.NET` and `Node.js` in a requirements list into links to those "sites". */
function isAutolink(entry) {
  const text = entry.anchorText.trim().toLowerCase().replace(/\/+$/u, "");
  return (
    !text.includes("://") &&
    text === entry.host &&
    (entry.path === "/" || entry.path === "") &&
    entry.query === ""
  );
}

function isExcluded(entry, exclusions) {
  // The config lower-cases a rule, so the path is compared without case as well.
  const path = entry.path.toLowerCase();
  return exclusions.some(
    (rule) =>
      matchesHost(entry.host, rule.host) &&
      (rule.pathPrefix === null ||
        path === rule.pathPrefix ||
        path.startsWith(`${rule.pathPrefix}/`)),
  );
}

/**
 * The entries of one post, one per anchor, in post order. Marks that need nothing but the link
 * itself - `social`, `excluded`, `autolink` - are set here; `boilerplate` needs the whole walk and
 * is added by `markBoilerplate`.
 */
export function linksOf(post, { exclusions = [] } = {}) {
  const entries = post.anchors.map((anchor) => ({
    container: anchor.container,
    lineIndex: anchor.lineIndex,
    anchorText: anchor.text,
    marks: [],
    ...readHref(anchor.href),
  }));
  // A preview card is born from a link in the text and repeats it. Its address is compared by host
  // and path only: on live pages the text address keeps a tracking query the card has dropped.
  const textPaths = new Set(
    entries
      .filter((entry) => entry.type === "url" && entry.container !== "preview")
      .map((entry) => entry.pathKey),
  );
  return entries.map((entry) => {
    if (entry.type !== "url") return entry;
    if (entry.container === "preview" && textPaths.has(entry.pathKey)) {
      return {
        container: entry.container,
        lineIndex: null,
        anchorText: "",
        marks: [],
        skipped: "preview_folded",
      };
    }
    const marks = [];
    if (socialHosts.some((domain) => matchesHost(entry.host, domain))) marks.push("social");
    if (isExcluded(entry, exclusions)) marks.push("excluded");
    if (isAutolink(entry)) marks.push("autolink");
    return { ...entry, marks };
  });
}

/**
 * The boilerplate addresses of one source: a Map of normalised address to the number of different
 * texts it stands under. Counted over EVERY post of the pages walked - the ones at or below the
 * cursor and the ones without text included in the base - because a quiet channel brings one new
 * post and its footer is recognisable only against the posts around it.
 *
 * Only `url` links are counted. A `tg` name is never boilerplate: a recruiter runs many vacancies,
 * and their name under ten different texts is ten ways to apply, not a footer.
 */
export function boilerplateOf(walked) {
  const textsPerKey = new Map();
  for (const { post, entries } of walked) {
    const text = normalizedText(post);
    if (text.length === 0) continue;
    for (const key of new Set(
      entries.filter((entry) => entry.type === "url").map((entry) => entry.key),
    )) {
      if (!textsPerKey.has(key)) textsPerKey.set(key, new Set());
      textsPerKey.get(key).add(text);
    }
  }
  const floor = Math.max(BOILERPLATE_MIN_POSTS, walked.length * BOILERPLATE_MIN_SHARE);
  return new Map(
    [...textsPerKey].map(([key, texts]) => [key, texts.size]).filter(([, posts]) => posts >= floor),
  );
}

export function markBoilerplate(entries, boilerplateKeys) {
  return entries.map((entry) =>
    entry.type === "url" && boilerplateKeys.has(entry.key)
      ? { ...entry, marks: [...entry.marks, "boilerplate"] }
      : entry,
  );
}
