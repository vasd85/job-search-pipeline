// A post becomes a vacancy card. Pure. A post of a thematic source is a card as it is - everything
// but advertising fits there. A post of a general source becomes a card only through the reader's
// answer: one card per vacancy the reader named, the title taken by line NUMBER from the post, the
// links by number from the list the reader was shown - no word of the reader's own reaches a card.
//
// `score_urls` is what the card offers to scoring: its NEW unmarked `url` links in post order, plus
// the post's own address when there is no new link or when the post names a contact. A digest
// offers all its new links; a card with one link offers one; a full text with a contact offers the
// post address and, on top of it, its own new links. A post whose links are all marked offers the
// post address, and the marked links are named in the report.
//
// A link whose address an earlier sweep already emitted is KNOWN: it stays in the card as
// `known_urls`, is listed in the report, and is not offered again - so a weekly digest does not
// re-emit the vacancies that had posts of their own.
//
// A group message names its author. The author's user name is a contact of the card (`author_tg`
// and, unless the text names it already, `contacts.tg`): in a group "write me" is the usual way to
// apply, and the page is the only place that user name exists. An author without a user name - a
// deleted account, a hidden name - is `author_tg: null` and adds no contact; the source counts such
// messages. A channel post has no author and is `author_tg: null` too.

import { applyVias } from "./answers.mjs";
import { numberedLines } from "./candidates.mjs";
import { titleLineOf } from "./text.mjs";
import { normalizeVacancyUrl } from "../lib/triage-ledger-core.mjs";
import {
  cardRef,
  cardRefPattern,
  descriptionKinds,
  mappingStatuses,
  snapshotOf,
  snapshotRefPattern,
  sourceAnchorUrl,
  sourceRoles,
} from "../triage-sources/source-set.mjs";

export const cardSchemaVersion = 4;
export const acceptedCardSchemaVersions = Object.freeze([3, 4]);
export const cardsBasename = "vacancies.jsonl";
export const readers = Object.freeze(["code", "reader"]);
// A way to apply that is a person, not a page: such a card offers the post address too.
export const contactVias = Object.freeze(["tg", "email", "phone", "dm_author"]);

const MAX_TITLE = 160;
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** The post address, built from the validated config handle and the numeric id - never copied. */
export function embedUrl(handle, postId) {
  return `https://t.me/${handle}/${postId}?embed=1`;
}

/** One untrusted line flattened and bounded to `max` characters; a batch line is bounded wider than a title. */
export function flatLine(value, max) {
  const flat = String(value ?? "")
    .replace(UNSAFE, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** One untrusted line flattened and bounded; the report wraps it, the card stores it as is. */
export function flatTitle(value) {
  return flatLine(value, MAX_TITLE);
}

function uniqueBy(items, keyOf) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Build the card of one post with text. `entries` are the post's link entries with every mark set;
 * `knownUrls` is the memory of emitted addresses as it stood when the sweep started.
 *
 * Every entry gets a provisional `fate`; `emit` is settled later, when the whole sweep is known and
 * an address met twice is placed once (`sweep.mjs`).
 */
export function cardOf(post, { handle, entries, knownUrls }) {
  const decided = [];
  const newKeys = new Set();
  for (const entry of entries) {
    let fate;
    if (entry.skipped !== undefined) fate = entry.skipped;
    else if (entry.type === "tg_other") fate = "tg_other";
    else if (entry.type === "tg" || entry.type === "email") fate = "contact";
    else if (entry.type === "unusable") fate = "unusable";
    else if (entry.marks.length > 0) fate = "marked";
    else if (knownUrls.has(entry.key)) fate = "known";
    else if (newKeys.has(entry.key)) fate = "repeat_in_sweep";
    else {
      fate = "emit";
      newKeys.add(entry.key);
    }
    decided.push({ ...entry, fate });
  }

  const of = (fate) => decided.filter((entry) => entry.fate === fate);
  const tg = uniqueBy(
    of("contact").filter((entry) => entry.type === "tg"),
    (entry) => entry.name.toLowerCase(),
  ).map((entry) => entry.name);
  const email = uniqueBy(
    of("contact").filter((entry) => entry.type === "email"),
    (entry) => entry.address,
  ).map((entry) => entry.address);
  const authorTg = post.author?.username ?? null;
  if (authorTg !== null && !tg.some((name) => name.toLowerCase() === authorTg.toLowerCase()))
    tg.push(authorTg);
  const newUrls = of("emit").map((entry) => ({ url: entry.url, key: entry.key }));
  const hasContact = tg.length > 0 || email.length > 0;
  const postAddress = newUrls.length === 0 || hasContact ? embedUrl(handle, post.id) : null;

  return {
    handle,
    postId: post.id,
    instant: post.instant,
    title: flatTitle(titleLineOf(post)),
    readBy: "code",
    vacancyNo: 1,
    applyVia: [],
    entries: decided,
    contacts: { tg, email },
    authorTg,
    newUrls,
    postAddress,
    knownUrls: uniqueBy(of("known"), (entry) => entry.key).map((entry) => ({
      url: entry.url,
      key: entry.key,
      first: knownUrls.get(entry.key),
    })),
    marked: of("marked").map((entry) => ({ url: entry.url, marks: entry.marks })),
    unusable: of("unusable").map((entry) => ({ host: entry.host, reason: entry.reason })),
  };
}

function contactsOf(decided, post) {
  const of = (fate) => decided.filter((entry) => entry.fate === fate);
  const tg = uniqueBy(
    of("contact").filter((entry) => entry.type === "tg"),
    (entry) => entry.name.toLowerCase(),
  ).map((entry) => entry.name);
  const email = uniqueBy(
    of("contact").filter((entry) => entry.type === "email"),
    (entry) => entry.address,
  ).map((entry) => entry.address);
  const authorTg = post.author?.username ?? null;
  if (authorTg !== null && !tg.some((name) => name.toLowerCase() === authorTg.toLowerCase()))
    tg.push(authorTg);
  return { contacts: { tg, email }, authorTg };
}

/**
 * The fates of every anchor of a post the reader read, decided once per POST: a `url` link the
 * reader named in any vacancy of the post is emitted, known or marked as a code card's would be; a
 * `url` link it named in none is `not_cited` - counted, never offered. Contacts stay contacts: the
 * code extracts them, the reader only says how one applies.
 */
export function readerPostFates(entries, { citedEntries, knownUrls }) {
  const decided = [];
  const newKeys = new Set();
  entries.forEach((entry, index) => {
    let fate;
    if (entry.skipped !== undefined) fate = entry.skipped;
    else if (entry.type === "tg_other") fate = "tg_other";
    else if (entry.type === "tg" || entry.type === "email") fate = "contact";
    else if (entry.type === "unusable") fate = "unusable";
    else if (entry.marks.length > 0) fate = "marked";
    else if (knownUrls.has(entry.key)) fate = "known";
    else if (!citedEntries.has(index)) fate = "not_cited";
    else if (newKeys.has(entry.key)) fate = "repeat_in_sweep";
    else {
      fate = "emit";
      newKeys.add(entry.key);
    }
    decided.push({ ...entry, fate });
  });
  return decided;
}

/** The entry indexes one vacancy of an answer names, through the batch descriptor's link list. */
export function citedEntriesOf(vacancy, descriptor) {
  const indexes = new Set();
  const cite = (j) => {
    if (j !== null) indexes.add(descriptor.links[j - 1].entryIndex);
  };
  if (vacancy.links !== undefined) for (const mapping of vacancy.links) cite(mapping.anchor);
  else cite(vacancy.details_link);
  for (const apply of vacancy.apply) cite(apply.link);
  return indexes;
}

/**
 * The card of one vacancy the reader named in a post. `decided` are the
 * post's entries with their post-level fates; `cited` the entry indexes this vacancy names. The
 * card offers the links it names that are new and unmarked, plus the post address when it names
 * none or applies through a person; a named marked link is not offered and is listed. A mapped
 * summary needs its original post unless an offered URL positions its own job source.
 */
export function readerCardOf(
  post,
  { handle, decided, knownUrls, vacancy, cited, vacancyNo, first, descriptor },
) {
  const lines = numberedLines(post);
  const named = [...decided.keys()]
    .filter((index) => cited.has(index))
    .map((index) => decided[index]);
  const of = (fate) => named.filter((entry) => entry.fate === fate);
  const newUrls = uniqueBy(of("emit"), (entry) => entry.key).map((entry) => ({
    url: entry.url,
    key: entry.key,
  }));
  if (vacancy.links !== undefined) {
    for (const mapping of vacancy.links) {
      const at = descriptor.links[mapping.anchor - 1].entryIndex;
      if (decided[at].type !== "tg_other") continue;
      const url = sourceAnchorUrl(post.anchors[at]);
      const key = normalizeVacancyUrl(url);
      if (!knownUrls.has(key) && !newUrls.some((entry) => entry.key === key))
        newUrls.push({ url, key });
    }
  }
  const applyVia = [...new Set(vacancy.apply.map((apply) => apply.via))];
  const byPerson = applyVia.some((via) => contactVias.includes(via));
  const mapped = vacancy.links !== undefined;
  const offeredKeys = new Set(newUrls.map((entry) => entry.key));
  const hasOfferedJobUrl =
    mapped &&
    vacancy.links.some((mapping) => {
      if (["company_context", "contact"].includes(mapping.role)) return false;
      const at = descriptor.links[mapping.anchor - 1].entryIndex;
      return offeredKeys.has(normalizeVacancyUrl(sourceAnchorUrl(post.anchors[at])));
    });
  const needsPostAddress = mapped
    ? !hasOfferedJobUrl || vacancy.description_kind !== "summary"
    : newUrls.length === 0;
  const postAddress = needsPostAddress || byPerson ? embedUrl(handle, post.id) : null;
  const contactEntries = mapped
    ? decided.filter((entry, at) => {
        const explicit = vacancy.links.some(
          (link) => descriptor.links[link.anchor - 1].entryIndex === at && link.role === "contact",
        );
        const line = numberedLines(post).find((item) => item.lineIndex === entry.lineIndex)?.n;
        return (
          explicit || (line !== undefined && line >= vacancy.start_line && line <= vacancy.end_line)
        );
      })
    : decided;
  const card = {
    handle,
    postId: post.id,
    instant: post.instant,
    title: flatTitle(lines[vacancy.title_line - 1].text),
    readBy: "reader",
    vacancyNo,
    applyVia,
    // The fates are accounted once per post: the first card of a post carries them.
    entries: first ? decided : [],
    ...contactsOf(contactEntries, post),
    newUrls,
    postAddress,
    knownUrls: uniqueBy(of("known"), (entry) => entry.key).map((entry) => ({
      url: entry.url,
      key: entry.key,
      first: knownUrls.get(entry.key),
    })),
    marked: uniqueBy(of("marked"), (entry) => entry.key).map((entry) => ({
      url: entry.url,
      marks: entry.marks,
    })),
    unusable: first
      ? decided
          .filter((entry) => entry.fate === "unusable")
          .map((entry) => ({ host: entry.host, reason: entry.reason }))
      : [],
  };
  if (mapped) {
    card.sourceSnapshot = snapshotOf(post, { handle });
    card.titleLine = vacancy.title_line;
    card.startLine = vacancy.start_line;
    card.endLine = vacancy.end_line;
    card.descriptionKind = vacancy.description_kind;
    card.mappingStatus = vacancy.mapping_status ?? "resolved";
    card.sourceLinks = [...vacancy.links]
      .sort((a, b) => a.anchor - b.anchor)
      .map((mapping) => {
        const anchor = descriptor.links[mapping.anchor - 1].entryIndex + 1;
        return {
          anchor,
          role: mapping.role,
          url: sourceAnchorUrl(card.sourceSnapshot.anchors[anchor - 1]),
        };
      });
    card.sourceLinks.push({
      anchor: null,
      role: "original_post",
      url: card.sourceSnapshot.original_url,
    });
    card.cardRef = cardRef({
      snapshot_ref: card.sourceSnapshot.snapshot_ref,
      title_line: card.titleLine,
      start_line: card.startLine,
      end_line: card.endLine,
    });
  }
  return card;
}

/** The addresses a card offers to scoring, as `{ url, key }`; the post address is its own key. */
export function scoreUrlsOf(card) {
  const own = card.postAddress === null ? [] : [{ url: card.postAddress, key: card.postAddress }];
  return [...card.newUrls, ...own];
}

/** The `vacancies.jsonl` record of one card. `held` names the newer posts that carry its addresses. */
export function cardRecord(card, { held }) {
  return {
    schema_version: card.sourceSnapshot ? 4 : 3,
    handle: card.handle,
    post_id: card.postId,
    instant: card.instant,
    title: card.title,
    score_urls: scoreUrlsOf(card).map((entry) => entry.url),
    known_urls: card.knownUrls.map((entry) => ({
      url: entry.url,
      first: { handle: entry.first.handle, post_id: entry.first.post_id, at: entry.first.first_at },
    })),
    contacts: card.contacts,
    author_tg: card.authorTg,
    vacancy_no: card.vacancyNo,
    apply_via: card.applyVia,
    marked_urls: card.marked,
    unusable_links: card.unusable,
    held_by: held.map((entry) => ({ url: entry.url, handle: entry.handle, post_id: entry.postId })),
    ...(card.sourceSnapshot
      ? {
          source_snapshot_ref: card.sourceSnapshot.snapshot_ref,
          card_ref: card.cardRef,
          title_line: card.titleLine,
          start_line: card.startLine,
          end_line: card.endLine,
          description_kind: card.descriptionKind,
          mapping_status: card.mappingStatus,
          source_links: card.sourceLinks,
        }
      : {}),
  };
}

const isString = (value) => typeof value === "string";
const isStringList = (value) => Array.isArray(value) && value.every(isString);
const isRef = (value) =>
  typeof value === "object" &&
  value !== null &&
  isString(value.handle) &&
  Number.isSafeInteger(value.post_id);

/** The card schema, as a predicate with a reason: the end-to-end test reads every line through it. */
export function cardProblem(record) {
  if (typeof record !== "object" || record === null || Array.isArray(record))
    return "not an object";
  const keys = [
    "apply_via",
    "author_tg",
    "contacts",
    "handle",
    "held_by",
    "instant",
    "known_urls",
    "marked_urls",
    "post_id",
    "schema_version",
    "score_urls",
    "title",
    "unusable_links",
    "vacancy_no",
  ];
  if (record.schema_version === 4)
    keys.push(
      "source_snapshot_ref",
      "card_ref",
      "title_line",
      "start_line",
      "end_line",
      "description_kind",
      "mapping_status",
      "source_links",
    );
  if (Object.keys(record).sort().join() !== keys.sort().join()) return "unexpected key set";
  if (!acceptedCardSchemaVersions.includes(record.schema_version)) return "schema_version";
  if (record.schema_version === 4) {
    if (
      !snapshotRefPattern.test(record.source_snapshot_ref) ||
      !cardRefPattern.test(record.card_ref) ||
      ![record.title_line, record.start_line, record.end_line].every(
        (line) => Number.isSafeInteger(line) && line > 0,
      ) ||
      record.start_line > record.title_line ||
      record.title_line > record.end_line ||
      !descriptionKinds.includes(record.description_kind) ||
      !mappingStatuses.includes(record.mapping_status)
    )
      return "source identity";
    if (
      !Array.isArray(record.source_links) ||
      !record.source_links.every(
        (link) =>
          typeof link === "object" &&
          link !== null &&
          Object.keys(link).sort().join() === "anchor,role,url" &&
          (link.anchor === null || (Number.isSafeInteger(link.anchor) && link.anchor > 0)) &&
          sourceRoles.includes(link.role) &&
          isString(link.url),
      )
    )
      return "source_links";
    if (
      record.card_ref !==
      cardRef({
        snapshot_ref: record.source_snapshot_ref,
        title_line: record.title_line,
        start_line: record.start_line,
        end_line: record.end_line,
      })
    )
      return "source identity";
  }
  if (!isRef(record)) return "handle or post_id";
  if (!isString(record.instant) || Number.isNaN(Date.parse(record.instant))) return "instant";
  if (!isString(record.title) || record.title.length > MAX_TITLE + 1) return "title";
  if (!isStringList(record.score_urls) || record.score_urls.length === 0) return "score_urls";
  if (
    typeof record.contacts !== "object" ||
    record.contacts === null ||
    !isStringList(record.contacts.tg) ||
    !isStringList(record.contacts.email)
  )
    return "contacts";
  if (record.author_tg !== null && !isString(record.author_tg)) return "author_tg";
  if (!Number.isSafeInteger(record.vacancy_no) || record.vacancy_no < 1) return "vacancy_no";
  if (!isStringList(record.apply_via) || !record.apply_via.every((via) => applyVias.includes(via)))
    return "apply_via";
  if (
    !Array.isArray(record.known_urls) ||
    !record.known_urls.every(
      (entry) => isString(entry?.url) && isRef(entry.first) && isString(entry.first.at),
    )
  ) {
    return "known_urls";
  }
  if (
    !Array.isArray(record.marked_urls) ||
    !record.marked_urls.every((entry) => isString(entry?.url) && isStringList(entry.marks))
  ) {
    return "marked_urls";
  }
  if (
    !Array.isArray(record.unusable_links) ||
    !record.unusable_links.every((entry) => isString(entry?.reason))
  ) {
    return "unusable_links";
  }
  if (
    !Array.isArray(record.held_by) ||
    !record.held_by.every((entry) => isString(entry?.url) && isRef(entry))
  ) {
    return "held_by";
  }
  return null;
}
