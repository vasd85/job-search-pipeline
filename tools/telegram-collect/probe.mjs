// Probe: one fetch, no state - the "should I add this source to the config" card.
//
// With a message id the probe reads one `?embed=1` message page of a group instead of the channel
// preview: the card says whether the message is readable, whether it has text, whether its author
// carries a user name, and when it was sent - the facts "Add a group" needs before `start_id` goes
// into the config.
//
// The card is counts and bounded codes only. It prints no post title, no link and no contact: it is
// read by a model, and a probe is run against a channel nobody has looked at yet.
//
// What the probe cannot tell is the one thing the config needs: whether the source is a THEMATIC
// one, or a general one that goes into the config with `thematic: false` and is read through the
// reader stage. The card carries that reminder as a bounded code, `sources_rule`.

import { defaultRequestHeaders } from "../vacancy-fetch/adapters/contract.mjs";
import { fetchDocument } from "../vacancy-fetch/transport.mjs";
import { embedUrl } from "./cards.mjs";
import { isValidHandle } from "./config.mjs";
import { detectMessagePage, detectPage } from "./detect.mjs";
import { fail } from "./errors.mjs";
import { linksOf } from "./links.mjs";
import { channelUrl } from "./sweep.mjs";
import { hasText } from "./text.mjs";

const DAY_MS = 86_400_000;

export const sourcesRule = "thematic_or_reader";

function share(count, total) {
  return total === 0 ? null : Math.round((count / total) * 100) / 100;
}

export function isValidMessageId(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000_000_000;
}

/** One message of a group: the card of `probe <handle> <id>`. Counts and codes, no text and no name. */
export async function probeMessage({ handle, messageId, fetchImpl }) {
  if (!isValidHandle(handle))
    fail("handle_invalid", "The handle does not match the handle pattern.");
  if (!isValidMessageId(messageId))
    fail("argv_invalid", "The message id must be a positive integer.");
  const record = await fetchDocument({
    url: embedUrl(handle, messageId),
    headers: defaultRequestHeaders,
    fetchImpl,
  });
  const { outcome, post } = detectMessagePage(record, { handle });
  if (outcome !== "message_ok") return { handle, message_id: messageId, outcome };
  if (post.id !== messageId) return { handle, message_id: messageId, outcome: "unrecognized_page" };
  const entries = linksOf(post);
  return {
    handle,
    message_id: messageId,
    outcome,
    sources_rule: sourcesRule,
    instant: post.instant,
    has_text: hasText(post),
    author_named: post.author !== null,
    author_has_username: (post.author?.username ?? null) !== null,
    links: entries.filter((entry) => entry.type === "url").length,
    contacts: entries.filter((entry) => entry.type === "tg" || entry.type === "email").length,
  };
}

export async function probeChannel({ handle, fetchImpl }) {
  if (!isValidHandle(handle))
    fail("handle_invalid", "The handle does not match the handle pattern.");
  const record = await fetchDocument({
    url: channelUrl(handle, null),
    headers: defaultRequestHeaders,
    fetchImpl,
  });
  const { outcome, page } = detectPage(record, { handle });
  if (outcome !== "channel_ok") return { handle, outcome };

  const posts = page.posts;
  const instants = posts.map((post) => Date.parse(post.instant));
  const spanDays =
    posts.length < 2 ? null : (Math.max(...instants) - Math.min(...instants)) / DAY_MS;
  let withUrl = 0;
  let withContact = 0;
  let withoutText = 0;
  let cyrillic = 0;
  for (const post of posts) {
    const entries = linksOf(post);
    if (entries.some((entry) => entry.type === "url" && entry.marks.length === 0)) withUrl += 1;
    if (entries.some((entry) => entry.type === "tg" || entry.type === "email")) withContact += 1;
    if (!hasText(post)) withoutText += 1;
    if (/\p{Script=Cyrillic}/u.test(post.lines.join(" "))) cyrillic += 1;
  }
  return {
    handle,
    outcome,
    sources_rule: sourcesRule,
    audience: page.channelInfo?.counters ?? [],
    posts_on_page: posts.length,
    // A bot that posts a page within seconds makes the page span meaningless as a rate: under a
    // day of span the card gives the span and no rate (live 2026-09-17: 20 posts in 24 seconds).
    page_span_hours: spanDays === null ? null : Math.round(spanDays * 24 * 10) / 10,
    posts_per_day:
      spanDays === null || spanDays < 1 ? null : Math.round((posts.length / spanDays) * 10) / 10,
    share_with_links: share(withUrl, posts.length),
    share_with_contact: share(withContact, posts.length),
    share_without_text: share(withoutText, posts.length),
    share_cyrillic: share(cyrillic, posts.length),
    has_older_pages: page.hasOlder,
  };
}
