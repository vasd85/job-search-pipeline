// Reposts: a vacancy raised again is a new message id, and neither the cursor nor the triage ledger
// catches it when the address offered to scoring is the post's own address.
//
// A post is a repost of an earlier one when ALL THREE hold:
//   1. the first two lines that carry a word are equal after normalisation;
//   2. the texts are near-equal - a Jaccard estimate of at least 0.6 over 64 min-hashes of five-word
//      shingles; a text shorter than 25 words is compared for equality instead;
//   3. the sets of ALL unmarked `url` links are equal, the new and the known ones together.
// Any one leg alone swallows a different vacancy: a recruiter's template changes one role line, and
// one careers page serves many roles.
//
// A fingerprint stores digests, never text: the state file holds no word of a post. The per-line
// digests exist for one purpose - naming, in the report, the first line in which a repost differs
// from its original, so a wrong fold is visible.

import { sha256Utf8 } from "../vacancy-fetch/digest.mjs";
import { normalizeLine, normalizedLines, wordsOf } from "./text.mjs";

export const MINHASH_SIZE = 64;
export const SHINGLE_WORDS = 5;
export const SHORT_TEXT_WORDS = 25;
export const JACCARD_THRESHOLD = 0.6;
export const MAX_LINE_DIGESTS = 80;

const DAY_MS = 86_400_000;

const short = (text, length = 16) => sha256Utf8(text).slice(0, length);

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mix(value, seed) {
  let hash = (value ^ Math.imul(seed + 1, 0x9e3779b1)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function minhashOf(words) {
  const mins = new Array(MINHASH_SIZE).fill(0xffffffff);
  for (let start = 0; start + SHINGLE_WORDS <= words.length; start += 1) {
    const base = fnv1a(words.slice(start, start + SHINGLE_WORDS).join(" "));
    for (let seed = 0; seed < MINHASH_SIZE; seed += 1) {
      const value = mix(base, seed);
      if (value < mins[seed]) mins[seed] = value;
    }
  }
  return mins;
}

/**
 * The fingerprint of one post with text. `urlKeys` are the normalised addresses of all its unmarked
 * `url` links.
 */
export function fingerprintOf(post, { handle, urlKeys, seenAt }) {
  const lines = normalizedLines(post);
  const wordLines = lines.map((line) => wordsOf(line).join(" ")).filter((line) => line.length > 0);
  const words = wordLines.flatMap((line) => line.split(" "));
  const isShort = words.length < SHORT_TEXT_WORDS;
  return {
    handle,
    post_id: post.id,
    instant: post.instant,
    last_seen: seenAt,
    head: short(wordLines.slice(0, 2).join("\n")),
    urls: short([...new Set(urlKeys)].sort().join("\n")),
    text: isShort ? short(words.join(" ")) : null,
    minhash: isShort ? null : minhashOf(words),
    lines: wordLines.slice(0, MAX_LINE_DIGESTS).map((line) => short(line, 8)),
  };
}

function similarText(a, b) {
  if (a.text !== null || b.text !== null) return a.text !== null && a.text === b.text;
  let equal = 0;
  for (let index = 0; index < MINHASH_SIZE; index += 1) if (a.minhash[index] === b.minhash[index]) equal += 1;
  return equal / MINHASH_SIZE >= JACCARD_THRESHOLD;
}

export function isRepostOf(candidate, original) {
  return candidate.head === original.head
    && candidate.urls === original.urls
    && similarText(candidate, original);
}

/** The first line of `post` that the original does not carry, or null when every line is there. */
export function firstDifferingLine(post, original) {
  const known = new Set(original.lines);
  for (const line of post.lines) {
    const words = wordsOf(normalizeLine(line)).join(" ");
    if (words.length > 0 && !known.has(short(words, 8))) return line;
  }
  return null;
}

export function isExpired(lastSeen, nowMs, memoryDays) {
  return Date.parse(lastSeen) < nowMs - memoryDays * DAY_MS;
}

/**
 * An index of fingerprints for one sweep: the unexpired ones of earlier sweeps plus the ones this
 * sweep adds as it goes, oldest post first. `find` returns the original of a repost; `touch`
 * prolongs an original's term, which is what keeps a vacancy raised every week folded; `remove`
 * forgets a fingerprint added this sweep, for a post that ended up no card.
 */
export function repostIndex(stored, { nowMs, memoryDays }) {
  const byLegs = new Map();
  const all = [];
  const legs = (fingerprint) => `${fingerprint.head} ${fingerprint.urls}`;
  const add = (fingerprint) => {
    all.push(fingerprint);
    if (!byLegs.has(legs(fingerprint))) byLegs.set(legs(fingerprint), []);
    byLegs.get(legs(fingerprint)).push(fingerprint);
  };
  for (const fingerprint of stored) {
    if (!isExpired(fingerprint.last_seen, nowMs, memoryDays)) add({ ...fingerprint });
  }
  return {
    add,
    find(candidate) {
      return (byLegs.get(legs(candidate)) ?? []).find((original) => isRepostOf(candidate, original)) ?? null;
    },
    touch(original, seenAt) {
      original.last_seen = seenAt;
    },
    // A post the reader found no vacancy in keeps no fingerprint: its repost next sweep is read anew.
    remove(fingerprint) {
      const at = all.indexOf(fingerprint);
      if (at >= 0) all.splice(at, 1);
      const bucket = byLegs.get(legs(fingerprint)) ?? [];
      const inBucket = bucket.indexOf(fingerprint);
      if (inBucket >= 0) bucket.splice(inBucket, 1);
    },
    all: () => all,
  };
}
