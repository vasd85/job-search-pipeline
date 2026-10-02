// Structural parse of one `t.me/s/<handle>` page - posts, their text lines, their anchors - and of
// one `t.me/<handle>/<id>?embed=1` message page, which carries the same post widget plus an author.
//
// This module extracts and decides nothing. What type a link is and what a post offers to scoring
// are `links.mjs` and `cards.mjs`; keeping the parse free of policy is what lets a markup change be
// fixed in one place with one fixture.
//
// Everything read here is untrusted page content. The only values that leave this module as
// identifiers are the numeric message id and the re-serialised instant; hrefs leave as raw strings
// and are never emitted anywhere until `links.mjs` has rebuilt them from a parsed URL.

import { attributeOf, classList, parseHtml } from "../vacancy-fetch/html-text.mjs";

const DATA_POST = /^([A-Za-z][A-Za-z0-9_]{3,31})\/(\d{1,12})$/u;
const COUNTER_VALUE = /^[\d.,\s]{1,12}[KkMm]?$/u;
const COUNTER_TYPE = /^[a-z]{1,16}$/u;
const BLOCK_BREAK_TAGS = new Set(["br", "div", "p", "blockquote", "pre", "li", "ul", "ol"]);

const CLASS_MESSAGE = "tgme_widget_message";
const CLASS_TEXT = "tgme_widget_message_text";
const CLASS_REPLY = "tgme_widget_message_reply";
const CLASS_BUTTON = "tgme_widget_message_inline_button";
const CLASS_PREVIEW = "tgme_widget_message_link_preview";
const CLASS_DATE = "tgme_widget_message_date";
const CLASS_MORE = "tme_messages_more";
const CLASS_CHANNEL_INFO = "tgme_channel_info";
const CLASS_COUNTER = "tgme_channel_info_counter";
const CLASS_AUTHOR = "tgme_widget_message_author_name";
const CLASS_FORWARDED = "tgme_widget_message_forwarded_from";
const CLASS_ERROR = "tgme_widget_message_error";
const CLASS_ERROR_WIDGET = "err_message";
const AUTHOR_HOSTS = new Set(["t.me", "telegram.me", "telegram.dog"]);
const HANDLE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/u;

// What a post without text usually is: a picture, a video, a file, a poll, a voice note, a sticker.
const ATTACHMENT_CLASSES = Object.freeze([
  "tgme_widget_message_document_wrap",
  "tgme_widget_message_grouped_wrap",
  "tgme_widget_message_location_wrap",
  "tgme_widget_message_photo_wrap",
  "tgme_widget_message_poll",
  "tgme_widget_message_roundvideo_player",
  "tgme_widget_message_sticker_wrap",
  "tgme_widget_message_video_player",
  "tgme_widget_message_video_wrap",
  "tgme_widget_message_voice_player",
]);

function hasClass(node, name) {
  return node.type === "element" && classList(node).includes(name);
}

function collapse(value) {
  return value.replace(/\s+/gu, " ").trim();
}

function plainText(node) {
  if (node.type === "text") return node.value;
  return node.children.map(plainText).join("");
}

/**
 * Walk one message-text element into lines, recording for every anchor the line it starts on.
 * `collectText` cannot do this: it returns a flat string, and the anchor-to-line pairing is the
 * whole point for a digest post.
 */
function readTextElement(element, lines, anchors) {
  const visit = (node) => {
    if (node.type === "text") {
      lines[lines.length - 1] += node.value;
      return;
    }
    if (node.type !== "element") return;
    if (BLOCK_BREAK_TAGS.has(node.tag)) lines.push("");
    if (node.tag === "a") {
      const href = attributeOf(node, "href");
      if (href !== null) {
        anchors.push({
          container: "text",
          href,
          lineIndex: lines.length - 1,
          text: collapse(plainText(node)),
        });
      }
    }
    for (const child of node.children) visit(child);
    if (BLOCK_BREAK_TAGS.has(node.tag) && node.tag !== "br") lines.push("");
  };
  lines.push("");
  visit(element);
}

function readPost(element, requestedHandle, counters) {
  const dataPost = attributeOf(element, "data-post") ?? "";
  const match = dataPost.match(DATA_POST);
  if (match === null) {
    counters.unparsed_post += 1;
    return null;
  }
  if (match[1].toLowerCase() !== requestedHandle.toLowerCase()) {
    counters.foreign_post += 1;
    return null;
  }
  const lines = [];
  const anchors = [];
  let datetime = null;
  let hasAttachment = false;

  const visit = (node, inReply) => {
    if (node.type !== "element") return;
    if (hasClass(node, CLASS_REPLY)) inReply = true;
    if (!inReply && ATTACHMENT_CLASSES.some((name) => hasClass(node, name))) hasAttachment = true;
    if (!inReply && hasClass(node, CLASS_TEXT)) {
      readTextElement(node, lines, anchors);
      return;
    }
    if (node.tag === "a") {
      const href = attributeOf(node, "href");
      if (href !== null && hasClass(node, CLASS_BUTTON)) {
        anchors.push({ container: "button", href, lineIndex: null, text: collapse(plainText(node)) });
      } else if (href !== null && hasClass(node, CLASS_PREVIEW)) {
        anchors.push({ container: "preview", href, lineIndex: null, text: "" });
      }
      if (hasClass(node, CLASS_DATE) && datetime === null) {
        const time = node.children.find((child) => child.type === "element" && child.tag === "time");
        datetime = time === undefined ? null : attributeOf(time, "datetime");
      }
    }
    for (const child of node.children) visit(child, inReply);
  };
  for (const child of element.children) visit(child, false);

  const parsedInstant = datetime === null ? Number.NaN : Date.parse(datetime);
  if (!Number.isFinite(parsedInstant)) {
    counters.unparsed_post += 1;
    return null;
  }
  return {
    id: Number(match[2]),
    instant: new Date(parsedInstant).toISOString(),
    lines: lines.map(collapse),
    anchors,
    hasAttachment,
  };
}

function readCounters(infoElement) {
  const found = [];
  const visit = (node) => {
    if (node.type !== "element") return;
    if (hasClass(node, CLASS_COUNTER)) {
      const value = node.children.find((child) => hasClass(child, "counter_value"));
      const type = node.children.find((child) => hasClass(child, "counter_type"));
      const valueText = value === undefined ? "" : collapse(plainText(value));
      const typeText = type === undefined ? "" : collapse(plainText(type)).toLowerCase();
      if (COUNTER_VALUE.test(valueText) && COUNTER_TYPE.test(typeText)) {
        found.push({ type: typeText, value: valueText });
      }
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(infoElement);
  return found;
}

/**
 * Parse one page.
 *
 * `truncated` is true when the HTML scanner hit one of its ceilings: a partial tree must never be
 * read as the whole page, because the posts it lost would look like posts that do not exist.
 */
export function parsePage(html, { handle }) {
  const { root, nodeCeilingHit, depthCeilingHit } = parseHtml(html);
  const counters = { foreign_post: 0, unparsed_post: 0 };
  const posts = [];
  let hasOlder = false;
  let channelInfo = null;
  let messageElements = 0;

  const visit = (node) => {
    if (node.type !== "element") return;
    if (hasClass(node, CLASS_MESSAGE) && attributeOf(node, "data-post") !== null) {
      messageElements += 1;
      const post = readPost(node, handle, counters);
      if (post !== null) posts.push(post);
      return;
    }
    if (hasClass(node, CLASS_MORE) && /^\d{1,12}$/u.test(attributeOf(node, "data-before") ?? "")) {
      hasOlder = true;
    }
    if (channelInfo === null && hasClass(node, CLASS_CHANNEL_INFO)) {
      channelInfo = { counters: readCounters(node) };
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of root.children) visit(child);

  return {
    truncated: nodeCeilingHit || depthCeilingHit,
    posts,
    counters,
    hasOlder,
    channelInfo,
    messageElements,
  };
}

/** The user name a profile link names, or null: not a Telegram host, a route, a bot deep link. */
function usernameOf(href) {
  if (typeof href !== "string") return null;
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!AUTHOR_HOSTS.has(url.hostname.toLowerCase())) return null;
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  return segments.length === 1 && HANDLE.test(segments[0]) ? segments[0] : null;
}

/**
 * The author block of a message page, read OUTSIDE the quoted reply and the forwarded-from header:
 * both carry an author name of their own, and that is someone else's. `username` is null when the
 * author has no public user name (a deleted account, a hidden name), and the whole value is null
 * when the page names no author at all - a channel post.
 */
function readAuthor(element) {
  let author = null;
  const visit = (node, inQuote) => {
    if (node.type !== "element" || author !== null) return;
    if (hasClass(node, CLASS_REPLY) || hasClass(node, CLASS_FORWARDED)) inQuote = true;
    if (!inQuote && hasClass(node, CLASS_AUTHOR)) {
      author = { username: node.tag === "a" ? usernameOf(attributeOf(node, "href")) : null };
      return;
    }
    for (const child of node.children) visit(child, inQuote);
  };
  for (const child of element.children) visit(child, false);
  return author;
}

/**
 * Parse one `?embed=1` message page. `kind` is `message` (with `post`, the author attached),
 * `error` (with the widget's error text: "Post not found", "Channel with username ... not found"),
 * `foreign` (the widget's `data-post` names another handle), `unparsed` (a widget without a readable
 * id or date) or `none` (no message widget at all). `truncated` as in `parsePage`.
 */
export function parseMessagePage(html, { handle }) {
  const { root, nodeCeilingHit, depthCeilingHit } = parseHtml(html);
  const truncated = nodeCeilingHit || depthCeilingHit;
  let widget = null;
  const find = (node) => {
    if (node.type !== "element" || widget !== null) return;
    if (hasClass(node, CLASS_MESSAGE)) {
      widget = node;
      return;
    }
    for (const child of node.children) find(child);
  };
  for (const child of root.children) find(child);
  if (widget === null) return { truncated, kind: "none" };

  let error = null;
  const findError = (node) => {
    if (node.type !== "element" || error !== null) return;
    if (hasClass(node, CLASS_ERROR)) {
      error = node;
      return;
    }
    for (const child of node.children) findError(child);
  };
  findError(widget);
  if (error !== null || hasClass(widget, CLASS_ERROR_WIDGET)) {
    return { truncated, kind: "error", errorText: collapse(plainText(error ?? widget)) };
  }
  const match = (attributeOf(widget, "data-post") ?? "").match(DATA_POST);
  if (match === null) return { truncated, kind: "unparsed" };
  if (match[1].toLowerCase() !== handle.toLowerCase()) return { truncated, kind: "foreign" };
  const post = readPost(widget, handle, { foreign_post: 0, unparsed_post: 0 });
  if (post === null) return { truncated, kind: "unparsed" };
  return { truncated, kind: "message", post: { ...post, author: readAuthor(widget) } };
}

/** The facts `detect.mjs` needs from a page that is not a channel preview. */
export function parseCard(html) {
  const { root } = parseHtml(html);
  let hasPage = false;
  let extraText = "";
  const visit = (node) => {
    if (node.type !== "element") return;
    if (hasClass(node, "tgme_page")) hasPage = true;
    if (hasClass(node, "tgme_page_extra")) extraText += ` ${plainText(node)}`;
    for (const child of node.children) visit(child);
  };
  for (const child of root.children) visit(child);
  return { hasPage, hasAudienceCounters: /\b(members?|subscribers?|online)\b/iu.test(extraText) };
}
