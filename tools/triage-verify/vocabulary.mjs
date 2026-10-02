// The negative-space vocabulary: a versioned data file, not prose in a session.
//
// The 2026-08-18 run kept its keyword families in the run document. They missed the batch's most
// important line, and the supplementary pattern that caught it died with the session. A file that
// carries a version, an id per phrase and the batch each phrase came from is what makes the
// vocabulary ratchet instead of being re-derived every time.
//
// Loading is strict. A vocabulary that fails validation is a caller error, never a silent
// fall-back to a smaller phrase set: a sweep run against half a vocabulary is exactly the
// rubber-stamp this suite exists to remove.

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "./errors.mjs";
import { phraseTokens } from "./text-scan.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** The vocabulary this repository currently sweeps with. A bump is a deliberate edit here. */
export const currentVocabularyFile = join(here, "vocabulary", "negative-space.v1.json");

export const vocabularySchemaVersion = 1;

const MAX_PHRASE_CHARS = 120;
const MAX_NOTE_CHARS = 600;
const ENTRY_KEYS = Object.freeze(["addedIn", "id", "note", "source", "text"]);
const REQUIRED_ENTRY_KEYS = Object.freeze(["addedIn", "id", "source", "text"]);
const FAMILY_KEYS = Object.freeze(["id", "note", "phrases", "title"]);
const REQUIRED_FAMILY_KEYS = Object.freeze(["id", "phrases", "title"]);
const ROOT_KEYS = Object.freeze(["families", "note", "schemaVersion", "vocabularyId", "zoneTerminators"]);
const REQUIRED_ROOT_KEYS = Object.freeze(["families", "schemaVersion", "vocabularyId", "zoneTerminators"]);
const ID_PATTERN = /^[a-z][a-z0-9_]*$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkKeys(value, allowed, required, label) {
  if (!isRecord(value)) fail("vocabulary_invalid", `${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail("vocabulary_invalid", `${label} has an unknown key ${key}`);
  }
  for (const key of required) {
    if (!(key in value)) fail("vocabulary_invalid", `${label} is missing ${key}`);
  }
}

function checkText(value, label, limit = MAX_PHRASE_CHARS) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("vocabulary_invalid", `${label} must be a non-empty string`);
  }
  if (value.length > limit) {
    fail("vocabulary_invalid", `${label} exceeds ${limit} characters`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    fail("vocabulary_invalid", `${label} must not carry control characters`);
  }
  return value;
}

function checkEntry(entry, label, expectedPrefix, seen) {
  checkKeys(entry, ENTRY_KEYS, REQUIRED_ENTRY_KEYS, label);
  const { id } = entry;
  if (typeof id !== "string" || !id.startsWith(`${expectedPrefix}.`)) {
    fail("vocabulary_invalid", `${label}.id must start with ${expectedPrefix}.`);
  }
  const slug = id.slice(expectedPrefix.length + 1);
  if (!ID_PATTERN.test(slug)) fail("vocabulary_invalid", `${label}.id has an unusable slug`);
  if (seen.has(id)) fail("vocabulary_invalid", `duplicate phrase id ${id}`);
  seen.add(id);
  checkText(entry.text, `${label}.text`);
  if (phraseTokens(entry.text).length === 0) {
    fail("vocabulary_invalid", `${label}.text has no tokens`);
  }
  if (typeof entry.addedIn !== "string" || !DATE_PATTERN.test(entry.addedIn)) {
    fail("vocabulary_invalid", `${label}.addedIn must be a YYYY-MM-DD date`);
  }
  checkText(entry.source, `${label}.source`);
  if ("note" in entry) checkText(entry.note, `${label}.note`, MAX_NOTE_CHARS);
  return Object.freeze({ ...entry });
}

/** Validate a parsed vocabulary and return the frozen shape the sweep consumes. */
export function validateVocabulary(raw) {
  checkKeys(raw, ROOT_KEYS, REQUIRED_ROOT_KEYS, "vocabulary");
  if (raw.schemaVersion !== vocabularySchemaVersion) {
    fail("vocabulary_invalid", `vocabulary.schemaVersion must be ${vocabularySchemaVersion}`);
  }
  checkText(raw.vocabularyId, "vocabulary.vocabularyId");
  if ("note" in raw) checkText(raw.note, "vocabulary.note", MAX_NOTE_CHARS);
  if (!Array.isArray(raw.zoneTerminators)) {
    fail("vocabulary_invalid", "vocabulary.zoneTerminators must be an array");
  }
  if (!Array.isArray(raw.families) || raw.families.length === 0) {
    fail("vocabulary_invalid", "vocabulary.families must be a non-empty array");
  }
  const ids = new Set();
  const zoneTerminators = raw.zoneTerminators.map((entry, index) =>
    checkEntry(entry, `vocabulary.zoneTerminators[${index}]`, "zone", ids));
  const familyIds = new Set();
  const families = raw.families.map((family, index) => {
    const label = `vocabulary.families[${index}]`;
    checkKeys(family, FAMILY_KEYS, REQUIRED_FAMILY_KEYS, label);
    if (typeof family.id !== "string" || !ID_PATTERN.test(family.id)) {
      fail("vocabulary_invalid", `${label}.id must be a lowercase identifier`);
    }
    if (familyIds.has(family.id)) fail("vocabulary_invalid", `duplicate family id ${family.id}`);
    familyIds.add(family.id);
    checkText(family.title, `${label}.title`);
    if ("note" in family) checkText(family.note, `${label}.note`, MAX_NOTE_CHARS);
    if (!Array.isArray(family.phrases) || family.phrases.length === 0) {
      fail("vocabulary_invalid", `${label}.phrases must be a non-empty array`);
    }
    const phrases = family.phrases.map((entry, phraseIndex) =>
      checkEntry(entry, `${label}.phrases[${phraseIndex}]`, family.id, ids));
    return Object.freeze({ ...family, phrases: Object.freeze(phrases) });
  });
  return Object.freeze({
    ...raw,
    families: Object.freeze(families),
    zoneTerminators: Object.freeze(zoneTerminators),
  });
}

/** Every phrase across every family, flattened with its family id. */
export function vocabularyPhrases(vocabulary) {
  return vocabulary.families.flatMap((family) =>
    family.phrases.map((phrase) => ({ family: family.id, id: phrase.id, text: phrase.text })));
}

export function loadVocabulary(path = currentVocabularyFile) {
  const resolved = isAbsolute(path) ? path : resolve(path);
  let bytes;
  try {
    bytes = readFileSync(resolved, "utf8");
  } catch {
    fail("vocabulary_unreadable", "The negative-space vocabulary could not be read.");
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    fail("vocabulary_unreadable", "The negative-space vocabulary is not valid JSON.");
  }
  return validateVocabulary(parsed);
}
