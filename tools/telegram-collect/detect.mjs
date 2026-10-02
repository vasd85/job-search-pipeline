// What one fetched page is, as a bounded code.
//
// `t.me/s/<handle>` answers a readable channel in place. Anything else - a group, a channel with
// the preview switched off, a handle nobody owns - is redirected to `t.me/<handle>`, so a final URL
// that lost `/s/` is never a readable channel whatever the body looks like. The two cards behind
// that redirect are told apart by the audience counters a real group or channel card carries.
//
// A page matching none of the rules is `unrecognized_page`: a refusal, not a guess. A markup change
// then stops the channel loudly instead of turning every post into silence.
//
// A group is read one message at a time through `t.me/<handle>/<id>?embed=1`. The status code says
// nothing there - every answer is 200 - and the body decides: a message widget with the handle's
// `data-post` is the message; an error widget says "Post not found" (an empty id: deleted, a service
// record, or not issued yet - the three are one answer) or names an unknown handle; a widget whose
// `data-post` carries another handle means the address leads elsewhere and stops the source.

import { parseCard, parseMessagePage, parsePage } from "./parse.mjs";

export const pageOutcomes = Object.freeze([
  "channel_ok",
  "group_not_found",
  "handle_mismatch",
  "http_error",
  "message_ok",
  "not_a_channel",
  "not_found",
  "page_truncated",
  "post_not_found",
  "rate_limited",
  "transport_failure",
  "unrecognized_page",
]);

const POST_NOT_FOUND = /^post not found$/iu;
const GROUP_NOT_FOUND = /^channel with username \S+ not found$/iu;

function transportOutcome(record) {
  if (record.transportFailure !== null) return "transport_failure";
  if (record.status === 429) return "rate_limited";
  if (record.status !== 200) return "http_error";
  return null;
}

function lostPreviewPath(finalUrl, handle) {
  if (typeof finalUrl !== "string") return true;
  let url;
  try {
    url = new URL(finalUrl);
  } catch {
    return true;
  }
  return url.pathname.toLowerCase() !== `/s/${handle.toLowerCase()}`;
}

/**
 * Classify one transport record. Returns `{ outcome, page }`, where `page` is the parsed page for
 * `channel_ok` and null otherwise.
 */
export function detectPage(record, { handle }) {
  const failed = transportOutcome(record);
  if (failed !== null) return { outcome: failed, page: null };
  if (lostPreviewPath(record.finalUrl, handle)) {
    const card = parseCard(record.body);
    if (!card.hasPage) return { outcome: "unrecognized_page", page: null };
    return { outcome: card.hasAudienceCounters ? "not_a_channel" : "not_found", page: null };
  }
  const page = parsePage(record.body, { handle });
  if (page.truncated) return { outcome: "page_truncated", page: null };
  if (page.channelInfo === null && page.messageElements === 0) {
    return { outcome: "unrecognized_page", page: null };
  }
  return { outcome: "channel_ok", page };
}

/**
 * Classify one message-page transport record. Returns `{ outcome, post }`, where `post` is the
 * parsed post with its author for `message_ok` and null otherwise.
 */
export function detectMessagePage(record, { handle }) {
  const failed = transportOutcome(record);
  if (failed !== null) return { outcome: failed, post: null };
  const page = parseMessagePage(record.body, { handle });
  if (page.truncated) return { outcome: "page_truncated", post: null };
  if (page.kind === "error") {
    if (POST_NOT_FOUND.test(page.errorText)) return { outcome: "post_not_found", post: null };
    if (GROUP_NOT_FOUND.test(page.errorText)) return { outcome: "group_not_found", post: null };
    return { outcome: "unrecognized_page", post: null };
  }
  if (page.kind === "foreign") return { outcome: "handle_mismatch", post: null };
  if (page.kind === "message") return { outcome: "message_ok", post: page.post };
  return { outcome: "unrecognized_page", post: null };
}
