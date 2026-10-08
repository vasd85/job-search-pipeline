// The sweep: strictly sequential, one channel after another, newest page first.
//
// This module does no file I/O of its own. It asks for pages through an injected `fetchImpl`,
// waits through an injected `sleep`, reads the clock once through an injected `now`, and hands
// every fetched page to an injected `capture` - so every test drives it offline and the one `now`
// taken at the start gives the window edge, the collection stamp and `last_sweep_at` alike.
//
// Walk-stop rule: a channel's backward walk stops at the FIRST of the stored cursor, the
// backfill-window edge, the page cap, the end of history. Every stop except reaching the cursor is
// printed with its reason. The id range that entered nothing is printed for a window stop, a
// page-cap stop, and a cursor stop whose page also held a post older than the window.
//
// A group has no page: its walk goes UP, one message id at a time, from the id above the highest
// live message ever read (`last_live_id`; the config's `start_id` on the first pass). An empty id
// above the tip is a message not written yet, so the position never moves over empty ids and every
// pass rereads the empty ids above the tip. The pass ends at the FIRST of: `stop_after` empty ids
// in a row (`tip`), `request_cap` requests (`request_cap`) - checked in that order after every
// answer, so a silent group with `request_cap = stop_after` ends with `tip`. The backfill window
// binds what a group EMITS, not what it walks: a message older than the window is read, counted and
// moves the position, and becomes no card - which is what keeps `reset-cursor` from re-emitting a
// group's history from `start_id`.
//
// The verdict on the previous stop: a live message above the previous position and older than the
// previous pass (by more than the clock tolerance) existed then and was answered "Post not found".
// Within the previous `stop_after` that is a transient miss; beyond it the previous pass stood at a
// hole at least as long as its threshold - a class reached only after the threshold was raised,
// because with the same threshold the pass stands at the same hole again and reads nothing.
//
// A channel interrupted mid-walk - a 429, a transport failure, a page that is not the channel, a
// page that brought no older id - emits nothing, enters no count and no repost comparison, and keeps
// its state entry untouched, `last_sweep_at` included. Emitting the pages already walked was
// rejected: the cursor cannot move (an unwalked tail remains below), and without moving it the same
// addresses would be emitted again next time. Channels completed before a 429 emit and advance as
// usual.
//
// The sweep is two halves. `walkSources` fetches and walks and returns the new posts with their
// links; `resolveSweep` is pure over that walk, the config, the state and the reader's answers -
// buckets, reposts, cards, the collection, the memory. A general source's candidates are read by
// the reader between the halves: `resolveSweep` without answers returns the posts to read, and with
// them the finished sweep. A thematic-only sweep has nothing to read and runs both halves at once.

import { defaultRequestHeaders } from "../vacancy-fetch/adapters/contract.mjs";
import { fetchDocument } from "../vacancy-fetch/transport.mjs";
import {
  cardOf,
  citedEntriesOf,
  embedUrl,
  flatTitle,
  readerCardOf,
  readerPostFates,
  scoreUrlsOf,
} from "./cards.mjs";
import { isCandidate, resumeHint, strongHits } from "./candidates.mjs";
import { detectMessagePage, detectPage } from "./detect.mjs";
import { boilerplateOf, linksOf, markBoilerplate } from "./links.mjs";
import { fingerprintOf, firstDifferingLine, isExpired, repostIndex } from "./reposts.mjs";
import { hasText, titleLineOf } from "./text.mjs";
import { renderPost } from "./batches.mjs";

const DAY_MS = 86_400_000;
// A message whose time lies this far before the previous pass began is taken to have existed then.
export const VERDICT_TOLERANCE_MS = 15 * 60_000;

export const channelOutcomes = Object.freeze([
  "completed",
  "disabled",
  "empty_page",
  "group_not_found",
  "handle_mismatch",
  "http_error",
  "not_a_channel",
  "not_found",
  "page_truncated",
  "pagination_stalled",
  "rate_limited",
  "transport_failure",
  "unattempted",
  "unrecognized_page",
]);

export const stopReasons = Object.freeze([
  "cursor",
  "window",
  "page_cap",
  "end_of_history",
  "tip",
  "request_cap",
]);
export const verdictKinds = Object.freeze([
  "no_position",
  "none",
  "confirmed",
  "transient_miss",
  "hole",
]);

export function channelUrl(handle, before) {
  return before === null ? `https://t.me/s/${handle}` : `https://t.me/s/${handle}?before=${before}`;
}

// Every new post lies in exactly one. A thematic source fills only the first three.
export const buckets = Object.freeze([
  "empty",
  "not_candidate",
  "repost",
  "card",
  "no_vacancy",
  "answer_invalid",
]);
export const readOutcomes = Object.freeze(["vacancy", "no_vacancy", "answer_invalid"]);
export const discrepancyKinds = Object.freeze(["no_vacancy", "answer_invalid", "card", "repost"]);

// What happened to one anchor of a card post, the first that applies in this order. Every anchor has
// exactly one, which is what the report's accounting rests on.
export const linkFates = Object.freeze([
  "preview_folded",
  "hashtag",
  "non_web",
  "tg_other",
  "contact",
  "marked",
  "unusable",
  "known",
  "not_cited",
  "repeat_in_sweep",
  "emit",
]);

async function walkChannel({
  handle,
  cursor,
  windowEdgeMs,
  config,
  fetchImpl,
  sleep,
  capture,
  first,
}) {
  const seenIds = new Set();
  const newPosts = [];
  const walkedPosts = [];
  const counters = { foreign_post: 0, unparsed_post: 0 };
  let before = null;
  let pages = 0;
  let postsSeen = 0;
  let minWalked = null;
  let firstPageMax = null;

  for (;;) {
    if (!(first && pages === 0)) await sleep(config.delayMs);
    const url = channelUrl(handle, before);
    const record = await fetchDocument({ url, headers: defaultRequestHeaders, fetchImpl });
    pages += 1;
    await capture({ handle, page: pages, before, record });
    const { outcome, page } = detectPage(record, { handle });
    if (outcome !== "channel_ok") return { outcome, pages, postsSeen };
    counters.foreign_post += page.counters.foreign_post;
    counters.unparsed_post += page.counters.unparsed_post;
    if (page.posts.length === 0) return { outcome: "empty_page", pages, postsSeen };

    const ids = page.posts.map((post) => post.id);
    const pageMin = Math.min(...ids);
    if (minWalked !== null && !(pageMin < minWalked)) {
      return { outcome: "pagination_stalled", pages, postsSeen };
    }
    if (firstPageMax === null) firstPageMax = Math.max(...ids);
    minWalked = pageMin;

    let reachedCursor = false;
    let reachedWindow = false;
    for (const post of [...page.posts].sort((a, b) => b.id - a.id)) {
      if (seenIds.has(post.id)) continue;
      seenIds.add(post.id);
      postsSeen += 1;
      walkedPosts.push(post);
      if (cursor !== null && post.id <= cursor) reachedCursor = true;
      else if (Date.parse(post.instant) < windowEdgeMs) reachedWindow = true;
      else newPosts.push(post);
    }

    let stop = null;
    if (reachedCursor) stop = "cursor";
    else if (reachedWindow) stop = "window";
    else if (!page.hasOlder) stop = "end_of_history";
    else if (pages >= config.pageCap) stop = "page_cap";
    if (stop !== null) {
      return {
        outcome: "completed",
        stop,
        pages,
        postsSeen,
        newPosts,
        walkedPosts,
        counters,
        minWalked,
        firstPageMax,
        // A post above the cursor and older than the window was met. When it shares a page with the
        // cursor the stop is "cursor", and only this flag says that something entered nothing.
        oldAboveCursor: reachedWindow,
      };
    }
    before = pageMin;
  }
}

async function walkGroup({ handle, source, entry, delayMs, fetchImpl, sleep, capture, first }) {
  const from = entry?.last_live_id == null ? source.startId : entry.last_live_id + 1;
  let lastLive = entry?.last_live_id ?? null;
  let lastLiveAt = entry?.last_live_at ?? null;
  let longestGap = entry?.longest_gap ?? 0;
  const posts = [];
  let id = from;
  let requests = 0;
  let deadRun = 0;

  for (;;) {
    if (!(first && requests === 0)) await sleep(delayMs);
    const record = await fetchDocument({
      url: embedUrl(handle, id),
      headers: defaultRequestHeaders,
      fetchImpl,
    });
    requests += 1;
    await capture({ handle, page: requests, before: null, messageId: id, record });
    const { outcome, post } = detectMessagePage(record, { handle });
    if (outcome === "message_ok") {
      // The page must be the message that was asked for. The probe of task 125 saw no page whose
      // `data-post` id differed from the requested one in 1 115 live pages; if one ever does, the
      // position and the card would drift apart silently, so it is a loud stop like a markup change.
      if (post.id !== id) return { outcome: "unrecognized_page", requests, posts, from, to: id };
      // A hole is measured between two live ids only: `start_id` may itself be a deleted message.
      if (lastLive !== null) longestGap = Math.max(longestGap, id - lastLive - 1);
      lastLive = id;
      lastLiveAt = post.instant;
      deadRun = 0;
      posts.push(post);
    } else if (outcome === "post_not_found") {
      deadRun += 1;
    } else {
      return { outcome, requests, posts, from, to: id };
    }
    let stop = null;
    if (deadRun >= source.stopAfter) stop = "tip";
    else if (requests >= source.requestCap) stop = "request_cap";
    if (stop !== null) {
      return {
        outcome: "completed",
        stop,
        requests,
        posts,
        from,
        to: id,
        lastLive,
        lastLiveAt,
        longestGap,
        deadRun,
      };
    }
    id += 1;
  }
}

/**
 * What this pass says about the previous one; null when the previous pass ended at the request cap
 * and so left nothing to judge, or when there was no previous pass. A previous pass that read no live
 * message has no position to judge from - the config's `start_id` may have moved since - and gets
 * `no_position` instead of a verdict.
 */
function verdictOf(entry, posts) {
  if (entry === undefined || entry.last_stop !== "tip") return null;
  if (entry.last_live_id === null) return { kind: "no_position" };
  const base = entry.last_live_id;
  const existedBefore = Date.parse(entry.last_sweep_at) - VERDICT_TOLERANCE_MS;
  const older = posts.filter((post) => post.id > base && Date.parse(post.instant) < existedBefore);
  if (older.length === 0) return { kind: posts.length === 0 ? "none" : "confirmed" };
  const within = older.filter((post) => post.id <= base + entry.last_stop_after);
  const beyond = older.filter((post) => post.id > base + entry.last_stop_after);
  if (beyond.length === 0) return { kind: "transient_miss", posts: within.length };
  // The hole is the run of "not found" answers the previous pass saw above its position - the
  // messages within its threshold it was told "not found" about lie inside that run and are named.
  return {
    kind: "hole",
    posts: older.length,
    within: within.length,
    hole_length: Math.min(...beyond.map((post) => post.id)) - base - 1,
    previous_stop_after: entry.last_stop_after,
  };
}

function newestFirst(channelOrder) {
  return (a, b) => {
    if (a.instant !== b.instant) return a.instant < b.instant ? 1 : -1;
    const order = channelOrder.get(a.handle) - channelOrder.get(b.handle);
    if (order !== 0) return order;
    if (a.postId !== b.postId) return b.postId - a.postId;
    // Two cards of one post: the lower vacancy number holds the post address.
    return (a.vacancyNo ?? 1) - (b.vacancyNo ?? 1);
  };
}

const zeroed = (names) => Object.fromEntries(names.map((name) => [name, 0]));
const keyOf = (item) => `${item.handle}/${item.postId}`;

/**
 * The first half: fetch and walk every source. Returns the new posts with their links, one
 * record per source, and the stamps of the sweep. Nothing here reads the reader's answers or the
 * memories of the state beyond the cursors.
 */
export async function walkSources({
  config,
  state,
  now,
  sleep,
  fetchImpl,
  capture = async () => {},
}) {
  const startedMs = now();
  const startedAt = new Date(startedMs).toISOString();
  const windowEdgeMs = startedMs - config.backfillDays * DAY_MS;
  const channels = [];
  const fresh = [];
  const nextChannels = {};
  let rateLimited = false;
  let first = true;

  for (const source of config.channels) {
    const { handle, enabled, kind, thematic } = source;
    const stateKey = handle.toLowerCase();
    const entry = state.channels[stateKey];

    if (kind === "group") {
      const positionBefore = entry?.last_live_id ?? null;
      if (!enabled) {
        channels.push({
          handle,
          kind,
          thematic,
          outcome: "disabled",
          position_before: positionBefore,
        });
        continue;
      }
      if (rateLimited) {
        channels.push({
          handle,
          kind,
          thematic,
          outcome: "unattempted",
          position_before: positionBefore,
        });
        continue;
      }
      const walk = await walkGroup({
        handle,
        source,
        entry,
        delayMs: config.delayMs,
        fetchImpl,
        sleep,
        capture,
        first,
      });
      first = false;
      if (walk.outcome !== "completed") {
        if (walk.outcome === "rate_limited") rateLimited = true;
        channels.push({
          handle,
          kind,
          thematic,
          outcome: walk.outcome,
          requests: walk.requests,
          checked: { from: walk.from, to: walk.to },
          posts_seen: walk.posts.length,
          position_before: positionBefore,
        });
        continue;
      }
      const walked = walk.posts.map((post) => ({
        post,
        entries: linksOf(post, { exclusions: config.exclusions }),
      }));
      const boilerplate = boilerplateOf(walked);
      const boilerplateKeys = new Set(boilerplate.keys());
      const inWindow = (post) => Date.parse(post.instant) >= windowEdgeMs;
      let postsNew = 0;
      for (const { post, entries } of walked) {
        if (!inWindow(post)) continue;
        postsNew += 1;
        fresh.push({
          handle,
          postId: post.id,
          instant: post.instant,
          post,
          entries: markBoilerplate(entries, boilerplateKeys),
        });
      }
      nextChannels[stateKey] = {
        kind: "group",
        last_live_id: walk.lastLive,
        last_live_at: walk.lastLiveAt,
        last_sweep_at: startedAt,
        last_stop: walk.stop,
        last_stop_after: source.stopAfter,
        longest_gap: walk.longestGap,
      };
      channels.push({
        handle,
        kind,
        thematic,
        outcome: "completed",
        stop: walk.stop,
        checked: { from: walk.from, to: walk.to },
        requests: walk.requests,
        dead_run: walk.deadRun,
        stop_after: source.stopAfter,
        request_cap: source.requestCap,
        posts_seen: walk.posts.length,
        posts_new: postsNew,
        older_than_window: walk.posts.length - postsNew,
        counters: {
          author_without_username: walk.posts.filter(
            (post) => (post.author?.username ?? null) === null,
          ).length,
        },
        boilerplate: [...boilerplate].map(([key, posts]) => ({ key, posts })),
        first_pass: entry === undefined,
        position_before: positionBefore,
        position_after: walk.lastLive,
        last_live_at: walk.lastLiveAt,
        longest_gap: walk.longestGap,
        verdict: verdictOf(entry, walk.posts),
      });
      continue;
    }

    const cursor = entry?.last_message_id ?? null;
    if (!enabled) {
      channels.push({ handle, kind, thematic, outcome: "disabled", cursor_before: cursor });
      continue;
    }
    if (rateLimited) {
      channels.push({ handle, kind, thematic, outcome: "unattempted", cursor_before: cursor });
      continue;
    }
    const walk = await walkChannel({
      handle,
      cursor,
      windowEdgeMs,
      config,
      fetchImpl,
      sleep,
      capture,
      first,
    });
    first = false;
    if (walk.outcome !== "completed") {
      if (walk.outcome === "rate_limited") rateLimited = true;
      channels.push({
        handle,
        kind,
        thematic,
        outcome: walk.outcome,
        pages: walk.pages,
        posts_seen: walk.postsSeen,
        cursor_before: cursor,
      });
      continue;
    }

    const walked = walk.walkedPosts.map((post) => ({
      post,
      entries: linksOf(post, { exclusions: config.exclusions }),
    }));
    const boilerplate = boilerplateOf(walked);
    const boilerplateKeys = new Set(boilerplate.keys());
    const newIds = new Set(walk.newPosts.map((post) => post.id));
    for (const { post, entries } of walked) {
      if (newIds.has(post.id)) {
        fresh.push({
          handle,
          postId: post.id,
          instant: post.instant,
          post,
          entries: markBoilerplate(entries, boilerplateKeys),
        });
      }
    }
    const cursorAfter = Math.max(walk.firstPageMax, cursor ?? 0);
    nextChannels[stateKey] = { last_message_id: cursorAfter, last_sweep_at: startedAt };
    // The range that entered nothing starts right below the smallest NEW post: on a window stop the
    // posts walked but older than the window lie in it too - they are newer than the cursor, and a
    // range counted from the smallest walked id would leave them in no list at all.
    const smallestNew =
      walk.newPosts.length === 0
        ? walk.firstPageMax + 1
        : Math.min(...walk.newPosts.map((post) => post.id));
    const leftSomething = walk.stop === "window" || walk.stop === "page_cap" || walk.oldAboveCursor;
    // An empty range is no range: the page cap can fall exactly on the post above the cursor.
    const gap =
      leftSomething && (cursor === null || smallestNew - 1 >= cursor + 1)
        ? { after_id: cursor, below_id: smallestNew }
        : null;
    channels.push({
      handle,
      kind,
      thematic,
      outcome: "completed",
      stop: walk.stop,
      gap,
      pages: walk.pages,
      posts_seen: walk.postsSeen,
      posts_new: walk.newPosts.length,
      counters: walk.counters,
      boilerplate: [...boilerplate].map(([key, posts]) => ({ key, posts })),
      cursor_before: cursor,
      cursor_after: cursorAfter,
    });
  }

  return {
    started_at: startedAt,
    window_edge: new Date(windowEdgeMs).toISOString(),
    rate_limited: rateLimited,
    channels,
    next_channels: nextChannels,
    fresh,
  };
}

/**
 * The second half, pure. `answers` is a Map of `handle/postId` to the checked answer of the
 * reader (`answers.mjs`) together with the descriptor it was checked against; null before the
 * reader ran. With posts to read and no answers the result is `{ awaiting: true, pending }`.
 *
 * Order of computation per post: normalised text, link marks, the split into new and known
 * addresses, the scoring addresses, the fingerprint. Posts of thematic sources are indexed before
 * the candidates of general ones, oldest first within each: a repost group that holds a thematic
 * post is never read, and its original is that post even when a candidate of the group is older.
 */
export function resolveSweep({ config, state, walk, answers = null, readerVersion = 2 }) {
  const startedAt = walk.started_at;
  const startedMs = Date.parse(startedAt);
  const memoryDays = config.repostMemoryDays;
  const channelOrder = new Map(config.channels.map((channel, index) => [channel.handle, index]));
  const thematicOf = new Map(config.channels.map((channel) => [channel.handle, channel.thematic]));
  const channels = walk.channels.map((channel) => ({ ...channel }));

  // The memory of emitted addresses is read here, once: an address this sweep emits does not become
  // known to the other posts of the same sweep.
  const knownUrls = new Map(
    Object.entries(state.emitted_urls).filter(
      ([, entry]) => !isExpired(entry.last_seen, startedMs, memoryDays),
    ),
  );
  const seenKnown = new Set();
  const index = repostIndex(state.fingerprints, {
    nowMs: startedMs,
    memoryDays,
    exactSource: readerVersion === 2,
  });
  const empties = [];
  const notCandidates = [];
  const reposts = [];
  const cards = [];
  const pending = [];
  const noVacancy = [];
  const answerInvalid = [];
  const discrepancies = [];
  const readerMarked = [];
  const titleLineRepaired = [];

  const oldestFirst = [...walk.fresh].sort(newestFirst(channelOrder)).reverse();
  const ordered = [
    ...oldestFirst.filter((item) => thematicOf.get(item.handle) === true),
    ...oldestFirst.filter((item) => thematicOf.get(item.handle) !== true),
  ];
  for (const item of ordered) {
    const { handle, post, entries } = item;
    const thematic = thematicOf.get(handle) === true;
    if (!hasText(post)) {
      empties.push({
        handle,
        postId: post.id,
        instant: post.instant,
        hasAttachment: post.hasAttachment === true,
      });
      continue;
    }
    if (!thematic && !isCandidate(post, entries, config.roleWords)) {
      notCandidates.push({ handle, postId: post.id });
      continue;
    }
    const urlKeys = entries
      .filter((entry) => entry.type === "url" && entry.marks.length === 0)
      .map((entry) => entry.key);
    for (const key of urlKeys) if (knownUrls.has(key)) seenKnown.add(key);
    const fingerprint = fingerprintOf(post, {
      handle,
      urlKeys,
      seenAt: startedAt,
      sourceMapping: readerVersion === 2,
    });
    const original = index.find(fingerprint);
    if (original !== null) {
      index.touch(original, startedAt);
      reposts.push({
        handle,
        postId: post.id,
        instant: post.instant,
        title: flatTitle(titleLineOf(post)),
        original: { handle: original.handle, postId: original.post_id },
        originalOutcome: null,
        post,
        entries,
        differs: firstDifferingLine(post, original),
      });
      continue;
    }
    index.add(fingerprint);
    if (thematic && readerVersion === 1) {
      cards.push(cardOf(post, { handle, entries, knownUrls }));
      continue;
    }
    pending.push({ handle, postId: post.id, instant: post.instant, post, entries, fingerprint });
  }

  if (pending.length > 0 && answers === null) {
    return {
      awaiting: true,
      started_at: startedAt,
      window_edge: walk.window_edge,
      rate_limited: walk.rate_limited,
      channels,
      pending,
    };
  }

  const readOutcome = new Map();
  const strong = config.strongRoleWords;
  const hint = (post) => resumeHint(post, config.resumeHints);
  const note = (kind, item, hits) => {
    for (const hit of hits) {
      discrepancies.push({
        kind,
        handle: item.handle,
        postId: item.postId,
        token: hit.token,
        where: hit.where,
        n: hit.n,
        text: hit.text,
        resumeHint: hint(item.post),
      });
    }
  };
  for (const item of pending) {
    const { handle, post, entries, fingerprint } = item;
    const key = keyOf(item);
    let answer = answers.get(key) ?? { kind: "invalid", code: "post_missing" };
    if (readerVersion === 2 && answer.descriptor?.complete === false) {
      const descriptor = renderPost(item, 1, config.roleWords, { sourceMapping: true }).descriptor;
      answer = {
        kind: "vacancy",
        descriptor,
        repairs: [],
        vacancies: [
          {
            title_line: 1,
            start_line: 1,
            end_line: descriptor.shown.length,
            description_kind: "unknown",
            mapping_status: "unresolved_oversize",
            links: descriptor.links.map((link) => ({ anchor: link.j, role: "unknown" })),
            apply: [],
          },
        ],
      };
    }
    if (answer.kind === "vacancy") {
      const citedEntries = new Set();
      const citedLines = new Set();
      for (const vacancy of answer.vacancies) {
        for (const at of citedEntriesOf(vacancy, answer.descriptor)) citedEntries.add(at);
        citedLines.add(vacancy.title_line);
      }
      const decided = readerPostFates(entries, { citedEntries, knownUrls });
      const vacancies =
        readerVersion === 2
          ? [...answer.vacancies].sort(
              (a, b) => a.start_line - b.start_line || a.title_line - b.title_line,
            )
          : answer.vacancies;
      vacancies.forEach((vacancy, at) => {
        const cited = citedEntriesOf(vacancy, answer.descriptor);
        const card = readerCardOf(post, {
          handle,
          decided,
          knownUrls,
          vacancy,
          cited,
          vacancyNo: at + 1,
          first: at === 0,
          descriptor: answer.descriptor,
        });
        cards.push(card);
        for (const entry of card.marked)
          readerMarked.push({ card, url: entry.url, marks: entry.marks });
      });
      readOutcome.set(key, "vacancy");
      // The answer named a line the post does not have, and the post showed one line: the code took
      // the title from it (`answers.mjs`). The post is a card like any other, and the correction is
      // printed, because a reader corrected in silence is a reader nobody can check.
      if ((answer.repairs ?? []).length > 0) {
        titleLineRepaired.push({
          handle,
          postId: post.id,
          instant: post.instant,
          title: flatTitle(titleLineOf(post)),
          named: answer.repairs,
        });
      }
      note(
        "card",
        item,
        strongHits(post, entries, strong, { citedLines, citedEntries, skipTagRows: true }),
      );
      continue;
    }
    index.remove(fingerprint);
    const listed = {
      handle,
      postId: post.id,
      instant: post.instant,
      title: flatTitle(titleLineOf(post)),
      resumeHint: hint(post),
    };
    if (answer.kind === "none") {
      noVacancy.push(listed);
      readOutcome.set(key, "no_vacancy");
      note("no_vacancy", item, strongHits(post, entries, strong));
    } else {
      answerInvalid.push({ ...listed, code: answer.code });
      readOutcome.set(key, "answer_invalid");
      note("answer_invalid", item, strongHits(post, entries, strong));
    }
  }
  for (const repost of reposts) {
    const outcome = readOutcome.get(keyOf(repost.original)) ?? null;
    repost.originalOutcome = outcome;
    if (outcome !== null && outcome !== "vacancy")
      note("repost", repost, strongHits(repost.post, repost.entries, strong));
    delete repost.post;
    delete repost.entries;
  }

  // One address stands in the collection once, at the newest card that offers it.
  cards.sort(newestFirst(channelOrder));
  const holders = new Map();
  for (const card of cards) {
    for (const { key } of scoreUrlsOf(card)) if (!holders.has(key)) holders.set(key, card);
  }
  const collection = [];
  // The keys a post's cards offer that a card of ANOTHER post holds; the fates live on one card of
  // the post, so the translation is gathered per post and applied where the entries are.
  const heldByOthers = new Map();
  for (const card of cards) {
    card.own = [];
    card.held = [];
    for (const { url, key } of scoreUrlsOf(card)) {
      const holder = holders.get(key);
      if (holder === card) card.own.push({ url, key });
      else {
        card.held.push({
          url,
          key,
          handle: holder.handle,
          postId: holder.postId,
          vacancyNo: holder.vacancyNo,
        });
        if (holder.handle !== card.handle || holder.postId !== card.postId) {
          if (!heldByOthers.has(keyOf(card))) heldByOthers.set(keyOf(card), new Set());
          heldByOthers.get(keyOf(card)).add(key);
        }
      }
    }
    for (const { url } of card.own) {
      collection.push({ handle: card.handle, postId: card.postId, instant: card.instant, url });
    }
  }
  for (const card of cards) {
    const heldKeys = heldByOthers.get(keyOf(card)) ?? new Set();
    card.entries = card.entries.map((entry) =>
      entry.fate === "emit" && heldKeys.has(entry.key)
        ? { ...entry, fate: "repeat_in_sweep" }
        : entry,
    );
  }

  for (const channel of channels) {
    if (channel.outcome !== "completed") continue;
    const mine = (item) => item.handle === channel.handle;
    const ownCards = cards.filter(mine);
    channel.buckets = {
      empty: empties.filter(mine).length,
      not_candidate: notCandidates.filter(mine).length,
      repost: reposts.filter(mine).length,
      card: new Set(ownCards.map((card) => card.postId)).size,
      no_vacancy: noVacancy.filter(mine).length,
      answer_invalid: answerInvalid.filter(mine).length,
    };
    channel.cards = ownCards.length;
    channel.read = pending.filter(mine).length;
    channel.discrepancies = discrepancies.filter(mine).length;
    channel.addresses = collection.filter(mine).length;
    channel.cards_held = ownCards.filter((card) => card.own.length === 0).length;
    channel.fates = zeroed(linkFates);
    for (const card of ownCards) for (const entry of card.entries) channel.fates[entry.fate] += 1;
  }

  const emittedUrls = {};
  for (const [key, entry] of knownUrls) {
    emittedUrls[key] = seenKnown.has(key) ? { ...entry, last_seen: startedAt } : entry;
  }
  for (const card of cards) {
    for (const { key } of card.own) {
      if (key === card.postAddress) continue;
      emittedUrls[key] = {
        handle: card.handle,
        post_id: card.postId,
        first_at: startedAt,
        last_seen: startedAt,
      };
    }
  }

  return {
    awaiting: false,
    started_at: startedAt,
    window_edge: walk.window_edge,
    rate_limited: walk.rate_limited,
    channels,
    cards,
    reposts,
    empties,
    not_candidates: notCandidates,
    no_vacancy: noVacancy,
    answer_invalid: answerInvalid,
    discrepancies,
    reader_marked: readerMarked,
    title_line_repaired: titleLineRepaired,
    read: pending.length,
    collection,
    nextState: {
      ...state,
      ...(readerVersion === 2 ? { schema_version: 3 } : {}),
      channels: { ...state.channels, ...walk.next_channels },
      fingerprints: index.all(),
      emitted_urls: emittedUrls,
    },
  };
}

/**
 * Both halves at once. With posts to read and no `answers` the result is awaiting; a thematic-only
 * config finishes here, as before the reader stage.
 */
export async function runSweep({
  config,
  state,
  now,
  sleep,
  fetchImpl,
  capture = async () => {},
  answers = null,
  readerVersion = 2,
}) {
  const walk = await walkSources({ config, state, now, sleep, fetchImpl, capture });
  return { ...resolveSweep({ config, state, walk, answers, readerVersion }), walk };
}

/**
 * The accounting of one sweep: every new post lies in exactly one bucket, and every anchor of a
 * card post has exactly one fate.
 */
export function sweepTotals(result) {
  const totals = {
    posts_new: 0,
    buckets: zeroed(buckets),
    cards: 0,
    read: 0,
    discrepancies: 0,
    addresses: result.collection.length,
    cards_held: 0,
    fates: zeroed(linkFates),
  };
  for (const channel of result.channels) {
    if (channel.outcome !== "completed") continue;
    totals.posts_new += channel.posts_new;
    totals.cards += channel.cards;
    totals.read += channel.read;
    totals.discrepancies += channel.discrepancies;
    totals.cards_held += channel.cards_held;
    for (const name of buckets) totals.buckets[name] += channel.buckets[name];
    for (const name of linkFates) totals.fates[name] += channel.fates[name];
  }
  return totals;
}
