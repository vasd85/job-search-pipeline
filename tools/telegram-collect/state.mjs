// Sweep state: per channel, the newest message id a completed sweep has seen; per group, the
// highest live message id read and what the last pass ended with; plus two memories
// that fold what the cursor cannot - the fingerprints of emitted posts (a vacancy raised again is a
// new id) and the addresses already emitted (a weekly digest repeats the links of earlier posts).
// Both memories hold digests, handles, ids and normalised addresses, never a word of a post. Losing
// them with the state breaks nothing: the triage ledger knows the emitted addresses anyway, and the
// memories only keep the collection clean.
//
// The file is untracked operational state and lives beside the triage ledger. This module takes
// its path as a parameter and resolves nothing: path resolution belongs to `cli.mjs`, so a test
// can never reach a real checkout through a default.
//
// A sweep without an initialised state is a bounded refusal, never a silent full backfill. An entry
// for a channel no longer in the config is inert and is kept: removing a channel needs no cleanup,
// and re-adding one is safe because an ancient cursor is bounded by the backfill window.
//
// Schema version 2 adds group entries under the same `channels` key: `{ kind: "group", ... }`. A
// version 1 file holds no group entry and is read as it is; a write always carries version 2. An
// entry whose kind differs from the config's is a refusal before any request (`state_kind_mismatch`):
// a channel's cursor and a group's position are different numbers, and one is never read as the other.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isValidHandle } from "./config.mjs";
import { fail } from "./errors.mjs";

export const stateSchemaVersion = 2;
export const readableStateSchemaVersions = Object.freeze([1, 2]);
export const groupStopReasons = Object.freeze(["tip", "request_cap"]);
export const stateBasename = "telegram-sweep-state.json";

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DIGEST = /^[0-9a-f]{16}$/u;
const LINE_DIGEST = /^[0-9a-f]{8}$/u;
const MAX_FINGERPRINTS = 20_000;
const MAX_EMITTED_URLS = 50_000;
const MAX_LINE_DIGESTS = 80;
const MINHASH_SIZE = 64;

const isInstant = (value) => typeof value === "string" && INSTANT.test(value);
const isPostId = (value) => Number.isSafeInteger(value) && value >= 0;
const isUint32 = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

function isFingerprint(entry) {
  if (typeof entry !== "object" || entry === null) return false;
  const shortText = entry.text !== null;
  return isValidHandle(entry.handle)
    && isPostId(entry.post_id)
    && isInstant(entry.instant)
    && isInstant(entry.last_seen)
    && DIGEST.test(entry.head ?? "")
    && DIGEST.test(entry.urls ?? "")
    && (shortText
      ? DIGEST.test(entry.text ?? "") && entry.minhash === null
      : Array.isArray(entry.minhash) && entry.minhash.length === MINHASH_SIZE && entry.minhash.every(isUint32))
    && Array.isArray(entry.lines)
    && entry.lines.length <= MAX_LINE_DIGESTS
    && entry.lines.every((line) => LINE_DIGEST.test(line));
}

function isEmittedUrl(key, entry) {
  if (typeof entry !== "object" || entry === null) return false;
  let parsed;
  try {
    parsed = new URL(key);
  } catch {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:")
    && isValidHandle(entry.handle)
    && isPostId(entry.post_id)
    && isInstant(entry.first_at)
    && isInstant(entry.last_seen);
}

export function writeFileAtomic(path, contents) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, { flag: "wx" });
  renameSync(temporary, path);
}

function isChannelEntry(entry) {
  return Object.keys(entry).sort().join() === "last_message_id,last_sweep_at"
    && isPostId(entry.last_message_id)
    && isInstant(entry.last_sweep_at);
}

function isGroupEntry(entry) {
  return Object.keys(entry).sort().join()
      === "kind,last_live_at,last_live_id,last_stop,last_stop_after,last_sweep_at,longest_gap"
    && entry.kind === "group"
    && (entry.last_live_id === null || (isPostId(entry.last_live_id) && entry.last_live_id >= 1))
    && (entry.last_live_at === null || isInstant(entry.last_live_at))
    && (entry.last_live_id === null) === (entry.last_live_at === null)
    && isInstant(entry.last_sweep_at)
    && groupStopReasons.includes(entry.last_stop)
    && Number.isSafeInteger(entry.last_stop_after) && entry.last_stop_after >= 1
    && isPostId(entry.longest_gap);
}

/** The kind an entry stands for; the caller checks it against the config's kind for the handle. */
export function entryKind(entry) {
  return entry.kind === "group" ? "group" : "channel";
}

function validateState(state) {
  if (
    typeof state !== "object" || state === null || Array.isArray(state)
    || !readableStateSchemaVersions.includes(state.schema_version)
    || typeof state.channels !== "object" || state.channels === null
    || Array.isArray(state.channels)
    || !Array.isArray(state.fingerprints) || state.fingerprints.length > MAX_FINGERPRINTS
    || typeof state.emitted_urls !== "object" || state.emitted_urls === null
    || Array.isArray(state.emitted_urls)
    || Object.keys(state.emitted_urls).length > MAX_EMITTED_URLS
  ) {
    fail("state_invalid", "The sweep state does not match its schema.");
  }
  if (!state.fingerprints.every(isFingerprint)) {
    fail("state_invalid", "A post fingerprint of the sweep state does not match its schema.");
  }
  for (const [key, entry] of Object.entries(state.emitted_urls)) {
    if (!isEmittedUrl(key, entry)) {
      fail("state_invalid", "An emitted-address entry of the sweep state does not match its schema.");
    }
  }
  for (const [key, entry] of Object.entries(state.channels)) {
    if (
      !isValidHandle(key) || key !== key.toLowerCase()
      || typeof entry !== "object" || entry === null || Array.isArray(entry)
      || !(isChannelEntry(entry) || isGroupEntry(entry))
    ) {
      fail("state_invalid", "A sweep state entry does not match its schema.");
    }
  }
  return state;
}

/**
 * Refuse a config whose source kind differs from the state entry under the same handle: a group
 * position is never read as a channel cursor or the other way round. Runs before any request.
 */
export function assertSourceKinds(state, config) {
  for (const source of config.channels) {
    const entry = state.channels[source.handle.toLowerCase()];
    if (entry !== undefined && entryKind(entry) !== source.kind) {
      fail("state_kind_mismatch", "A source changed its kind under a handle the state remembers; run reset-cursor first.");
    }
  }
}

export function initState(path) {
  if (existsSync(path)) fail("state_exists", "The sweep state already exists.");
  const state = { schema_version: stateSchemaVersion, channels: {}, fingerprints: [], emitted_urls: {} };
  writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function readState(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("state_missing", "The sweep state was never initialised; run init first.");
    }
    fail("state_invalid", "The sweep state could not be read.");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("state_invalid", "The sweep state is not valid JSON.");
  }
  return validateState(parsed);
}

export function writeState(path, state) {
  const current = { ...validateState(state), schema_version: stateSchemaVersion };
  writeFileAtomic(path, `${JSON.stringify(current, null, 2)}\n`);
}

/**
 * Forget one channel, for a deliberate re-sweep: its cursor and what the two memories hold under its
 * handle. Without the second half a re-sweep would emit nothing - every post would fold into its own
 * fingerprint. Returns whether a cursor entry existed.
 */
export function resetCursor(path, handle) {
  if (!isValidHandle(handle)) fail("handle_invalid", "The handle does not match the handle pattern.");
  const state = readState(path);
  const key = handle.toLowerCase();
  const existed = Object.hasOwn(state.channels, key);
  const foreign = (entry) => entry.handle.toLowerCase() !== key;
  const channels = { ...state.channels };
  delete channels[key];
  writeState(path, {
    ...state,
    channels,
    fingerprints: state.fingerprints.filter(foreign),
    emitted_urls: Object.fromEntries(Object.entries(state.emitted_urls).filter(([, entry]) => foreign(entry))),
  });
  return existed;
}
