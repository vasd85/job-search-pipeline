// The sources config: which channels and public groups are swept, which addresses are never
// offered to scoring, how far back a first sweep reaches, how long a post and an address are
// remembered.
//
// A source is a channel (read through the `t.me/s/<handle>` preview) or a group (read message by
// message over `t.me/<handle>/<id>?embed=1`). A group names where its walk starts (`start_id`), how
// many empty ids in a row end a pass (`stop_after`) and how many requests one pass may spend
// (`request_cap`); a channel carries none of the three. The stop threshold is a property of the
// group, not of the collector: the longest hole seen differs tenfold between groups.
//
// A source is thematic by default: everything but advertising fits, and there is no filter. A source
// marked `thematic: false` is a general one, whose posts reach the collection only through the
// reader stage: `role_words` chooses the candidates the reader sees, `strong_role_words` marks the
// lines the report doubts a "no" over, `resume_hints` marks a post that looks like a résumé. The
// three lists are required like every top-level key - a config of thematic sources only carries them
// and does not use them. The retired `role_tokens` of the
// token filter is still refused as an unknown key.
//
// The file is the operator's own and is edited by hand, so every refusal names the entry it is
// about by index and never quotes the value: the value may be a typo today and a pasted post
// tomorrow. A handle that fails the pattern is refused here, at read, which is what makes it true
// that no request is ever built from an unvalidated handle.

import { readFileSync, statSync } from "node:fs";
import { parseResumeHints, parseRoleWords } from "./candidates.mjs";
import { fail } from "./errors.mjs";

export const configSchemaVersion = 4;
export const sourceKinds = Object.freeze(["channel", "group"]);
export const handlePattern = /^[A-Za-z][A-Za-z0-9_]{3,31}$/u;

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_CHANNELS = 100;
const MAX_EXCLUSIONS = 200;
const MAX_NOTE_LENGTH = 200;
const MAX_START_ID = 1_000_000_000_000;
// Every key is required and the code holds no default - a missing key fails its own type check: the
// value a sweep runs with is the one the working file shows.
const TOP_LEVEL_KEYS = Object.freeze([
  "backfill_days",
  "channels",
  "delay_ms",
  "exclusions",
  "page_cap",
  "repost_memory_days",
  "resume_hints",
  "role_words",
  "schema_version",
  "strong_role_words",
]);
const EXCLUSION = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(\/[^\s?#]*)?$/u;
const CHANNEL_KEYS = Object.freeze(["enabled", "handle", "kind", "note", "request_cap", "start_id", "stop_after", "thematic"]);
const GROUP_ONLY_KEYS = Object.freeze(["request_cap", "start_id", "stop_after"]);
const BOUNDS = Object.freeze({
  backfill_days: [1, 90],
  delay_ms: [500, 60_000],
  page_cap: [1, 50],
  repost_memory_days: [1, 365],
  request_cap: [1, 10_000],
  stop_after: [1, 5000],
});

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidHandle(value) {
  return typeof value === "string" && handlePattern.test(value);
}

function parseChannel(entry, index) {
  const channel = typeof entry === "string" ? { handle: entry } : entry;
  if (!isPlainObject(channel)) {
    fail("config_invalid", `channels[${index}] must be a handle string or an object.`);
  }
  for (const key of Object.keys(channel)) {
    if (!CHANNEL_KEYS.includes(key)) {
      fail("config_invalid", `channels[${index}] carries a key this schema does not know.`);
    }
  }
  if (!isValidHandle(channel.handle)) {
    fail("config_invalid", `channels[${index}].handle does not match the handle pattern.`);
  }
  const note = channel.note ?? "";
  if (typeof note !== "string" || note.length > MAX_NOTE_LENGTH) {
    fail("config_invalid", `channels[${index}].note must be a string of at most ${MAX_NOTE_LENGTH}.`);
  }
  const enabled = channel.enabled ?? true;
  if (typeof enabled !== "boolean") {
    fail("config_invalid", `channels[${index}].enabled must be true or false.`);
  }
  const kind = channel.kind ?? "channel";
  if (!sourceKinds.includes(kind)) {
    fail("config_invalid", `channels[${index}].kind must be channel or group.`);
  }
  const thematic = channel.thematic ?? true;
  if (typeof thematic !== "boolean") {
    fail("config_invalid", `channels[${index}].thematic must be true or false.`);
  }
  if (kind === "channel") {
    for (const key of GROUP_ONLY_KEYS) {
      if (Object.hasOwn(channel, key)) {
        fail("config_invalid", `channels[${index}].${key} belongs to a group source only.`);
      }
    }
    return { handle: channel.handle, note, enabled, kind, thematic, startId: null, stopAfter: null, requestCap: null };
  }
  const startId = channel.start_id;
  if (!Number.isSafeInteger(startId) || startId < 1 || startId > MAX_START_ID) {
    fail("config_invalid", `channels[${index}].start_id must be an integer from 1 to ${MAX_START_ID}.`);
  }
  const stopAfter = parseBounded(channel, "stop_after", `channels[${index}].`);
  const requestCap = parseBounded(channel, "request_cap", `channels[${index}].`);
  if (requestCap < stopAfter) {
    fail("config_invalid", `channels[${index}].request_cap must not be less than stop_after.`);
  }
  return { handle: channel.handle, note, enabled, kind, thematic, startId, stopAfter, requestCap };
}

/**
 * One exclusion: a host, or a host with a path prefix - `example.com`, `example.com/careers`. A host
 * covers its subdomains; a prefix covers the path itself and everything under it.
 */
function parseExclusion(value, index) {
  const match = typeof value === "string" ? value.trim().toLowerCase().match(EXCLUSION) : null;
  if (match === null) {
    fail("config_invalid", `exclusions[${index}] must be a host or a host with a path prefix.`);
  }
  const prefix = (match[2] ?? "").replace(/\/+$/u, "");
  return Object.freeze({ host: match[1], pathPrefix: prefix.length === 0 ? null : prefix });
}

function parseExclusions(value) {
  if (!Array.isArray(value) || value.length > MAX_EXCLUSIONS) {
    fail("config_invalid", `exclusions must be a list of at most ${MAX_EXCLUSIONS} entries.`);
  }
  return value.map(parseExclusion);
}

function parseBounded(config, key, prefix = "") {
  const [low, high] = BOUNDS[key];
  const value = config[key];
  if (!Number.isSafeInteger(value) || value < low || value > high) {
    fail("config_invalid", `${prefix}${key} must be an integer from ${low} to ${high}.`);
  }
  return value;
}

/** Validate a parsed config object. Split from the read so the rules are testable without a file. */
export function parseConfig(config) {
  if (!isPlainObject(config)) fail("config_invalid", "The config must be a JSON object.");
  for (const key of Object.keys(config)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      fail("config_invalid", "The config carries a top-level key this schema does not know.");
    }
  }
  if (config.schema_version !== configSchemaVersion) {
    fail("config_invalid", `schema_version must be ${configSchemaVersion}.`);
  }
  if (!Array.isArray(config.channels) || config.channels.length > MAX_CHANNELS) {
    fail("config_invalid", `channels must be a list of at most ${MAX_CHANNELS} entries.`);
  }
  const channels = config.channels.map(parseChannel);
  const seen = new Set();
  channels.forEach((channel, index) => {
    const key = channel.handle.toLowerCase();
    if (seen.has(key)) fail("config_invalid", `channels[${index}] repeats an earlier handle.`);
    seen.add(key);
  });
  return Object.freeze({
    channels: Object.freeze(channels.map((channel) => Object.freeze(channel))),
    exclusions: Object.freeze(parseExclusions(config.exclusions)),
    roleWords: parseRoleWords(config.role_words, "role_words"),
    strongRoleWords: parseRoleWords(config.strong_role_words, "strong_role_words"),
    resumeHints: parseResumeHints(config.resume_hints, "resume_hints"),
    repostMemoryDays: parseBounded(config, "repost_memory_days"),
    backfillDays: parseBounded(config, "backfill_days"),
    pageCap: parseBounded(config, "page_cap"),
    delayMs: parseBounded(config, "delay_ms"),
  });
}

export function readConfig(path) {
  let text;
  try {
    if (statSync(path).size > MAX_CONFIG_BYTES) {
      fail("config_unreadable", "The config file is larger than the collector reads.");
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.name === "TelegramCollectError") throw error;
    if (error?.code === "ENOENT") fail("config_missing", "The sources config does not exist.");
    fail("config_unreadable", "The sources config could not be read.");
  }
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^﻿/u, ""));
  } catch {
    fail("config_invalid", "The sources config is not valid JSON.");
  }
  return parseConfig(parsed);
}
