/**
 * The languages of the candidate layer: the one the engine knows, and the ones a candidate adds.
 *
 * The engine knows one language by name — its default, English. Every further language is
 * configured: `languages.additional` in the config names it, and a pack in
 * `candidate/languages/<name>/` carries everything about it that a check needs — the script a text
 * in it is written in, the locale words are counted by, the word a subject line opens with, the
 * signature of a letter, the machine-checkable wording rules and the letters its checks must accept
 * or refuse. Nothing here names a second language: the set is read, never written down.
 *
 * The name of a language is spelled the way the artifacts spell it — `vacancyLanguage` of a vacancy
 * and a brief, `role.language` of a scorer input, `language` of a correction record — and the pack
 * directory carries the same name, so one string ties the config, the pack and every artifact
 * together.
 *
 * Every function here is pure or reads only below the root it is given. Resolving a root from a
 * workspace, and the config itself, are `load.mjs`; this module imports neither, so the loader can
 * check the packs without an import cycle.
 */

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LANGUAGE } from "./default-language.mjs";
import { CandidateError } from "./errors.mjs";

export { DEFAULT_LANGUAGE };

export const candidateLanguagesDirectoryName = "languages";
export const candidateLanguagePackBasename = "pack.json";
export const candidateLanguageRulesBasename = "language-rules.md";
export const candidatePinsBasename = "pins.json";
export const candidatePinsDirectoryName = "pins";
export const candidateLanguagePackSchemaVersion = 1;
export const candidatePinsSchemaVersion = 1;

// `constraints.json` of a pack is read by `constraints.mjs`; the name is repeated here only to know
// that a file of that name belongs in a pack.
const PACK_CONSTRAINTS_BASENAME = "constraints.json";

export const candidateLanguageErrorCodes = Object.freeze([
  "candidate_language_pack_invalid",
  "candidate_language_pack_invalid_json",
  "candidate_language_pack_missing",
  "candidate_language_pack_unconfigured",
  "candidate_language_pack_unreadable",
  "candidate_pin_failed",
  "candidate_pins_invalid",
]);

const LANGUAGE_NAME = /^[A-Z][a-z]+$/u;
const SCRIPT_NAME = /^[A-Z][a-z]+(?:_[A-Z][a-z]+)*$/u;
const PIN_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MAX_ADDITIONAL_LANGUAGES = 20;
const MAX_PACK_BYTES = 64 * 1024;
const MAX_RULES_BYTES = 1024 * 1024;
const MAX_PIN_BYTES = 64 * 1024;
const MAX_PINS = 50;
const MAX_LINE = 200;
const PACK_FIELDS = Object.freeze([
  "admits_scripts",
  "locale",
  "schema_version",
  "script",
  "signature",
  "subject_prefix",
]);
const PIN_FIELDS = Object.freeze(["expect", "finding", "id", "keyword_terms", "why"]);
const PIN_EXPECTATIONS = Object.freeze(["accept", "reject"]);

function fail(code, message) {
  throw new CandidateError(code, message);
}

/** Whether a string is spelled as a language name: one word with a capital first letter. */
export function isLanguageName(value) {
  return typeof value === "string" && LANGUAGE_NAME.test(value);
}

/** The config bound of `languages.additional`: distinct names, none of them the default. */
export function acceptsAdditionalLanguages(value) {
  return (
    value.length <= MAX_ADDITIONAL_LANGUAGES &&
    value.every(isLanguageName) &&
    new Set(value).size === value.length &&
    !value.includes(DEFAULT_LANGUAGE.name)
  );
}

/** The config bound of a one-line text value: not empty, no surrounding space, no line break. */
export function acceptsSingleLine(value) {
  return (
    value.length > 0 &&
    value.length <= MAX_LINE &&
    value === value.trim() &&
    !CONTROL_CHARACTER.test(value)
  );
}

/**
 * The names of the languages of a validated config: the default first, then the configured ones
 * in the order the config lists them.
 */
export function candidateLanguageNamesFrom(config) {
  return Object.freeze([DEFAULT_LANGUAGE.name, ...config.languages.additional]);
}

/** The pack directory of one language under the layer rooted at `root`. */
export function candidateLanguagePackPathFor(root, name) {
  return join(root, candidateLanguagesDirectoryName, name);
}

/**
 * A compiled `\p{Script=…}` class for a script name, or `null` when the name is not one this
 * runtime knows. The name comes from a file, so it is checked by form first and then compiled
 * inside a `try`: the form keeps anything but a script name out of the pattern.
 */
export function scriptPattern(script) {
  if (typeof script !== "string" || !SCRIPT_NAME.test(script)) return null;
  try {
    return new RegExp(`\\p{Script=${script}}`, "u");
  } catch {
    return null;
  }
}

function isSupportedLocale(locale) {
  if (typeof locale !== "string" || locale.length === 0 || locale.length > 35) return false;
  try {
    const [canonical] = Intl.getCanonicalLocales(locale);
    // A locale the segmenter does not support falls back silently and counts words by another
    // language's rules, so an unsupported one is refused rather than accepted with a different
    // count.
    return canonical === locale && Intl.Segmenter.supportedLocalesOf([locale]).length === 1;
  } catch {
    return false;
  }
}

function entryKind(path) {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return "link";
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    return "unreadable";
  }
}

// A name beginning with a dot is the file system's, not the candidate's — a desktop's folder index
// above all — and is neither read nor refused.
function visibleEntries(path) {
  try {
    return readdirSync(path)
      .filter((entry) => !entry.startsWith("."))
      .sort();
  } catch (error) {
    fail(
      "candidate_language_pack_unreadable",
      `${path} is not readable (${error?.code ?? "unknown"})`,
    );
  }
}

function readText(path, label, { code, maximum }) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    fail(code, `${label} is not readable (${error?.code ?? "unknown"})`);
  }
  if (bytes.length > maximum) fail(code, `${label} is larger than this reader accepts`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(code, `${label} is not UTF-8 text`);
  }
}

function requireLine(value, label, code) {
  if (typeof value !== "string" || !acceptsSingleLine(value)) {
    fail(code, `${label} must be one line of text of at most ${MAX_LINE} characters`);
  }
  return value;
}

function parsePack(name, text) {
  const label = `languages/${name}/${candidateLanguagePackBasename}`;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("candidate_language_pack_invalid_json", `${label} is not valid JSON`);
  }
  const invalid = (message) => fail("candidate_language_pack_invalid", `${label}: ${message}`);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid("must be a JSON object");
  const unknown = Object.keys(value).find((key) => !PACK_FIELDS.includes(key));
  if (unknown !== undefined) invalid(`declares a field this reader does not know: ${unknown}`);
  const missing = PACK_FIELDS.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) invalid(`omits ${missing}`);
  if (value.schema_version !== candidateLanguagePackSchemaVersion) {
    invalid(
      `declares a schema this engine does not read; it reads ${candidateLanguagePackSchemaVersion}`,
    );
  }
  if (!isSupportedLocale(value.locale))
    invalid("locale must be a canonical locale the word counter supports");
  if (scriptPattern(value.script) === null) invalid("script must name a Unicode script");
  if (!Array.isArray(value.admits_scripts)) invalid("admits_scripts must be an array");
  for (const script of value.admits_scripts) {
    if (scriptPattern(script) === null) invalid("admits_scripts must name Unicode scripts");
  }
  if (new Set(value.admits_scripts).size !== value.admits_scripts.length)
    invalid("admits_scripts repeats a script");
  if (value.admits_scripts.includes(value.script))
    invalid("admits_scripts must not name the pack's own script");
  requireLine(value.signature, `${label}: signature`, "candidate_language_pack_invalid");
  requireLine(value.subject_prefix, `${label}: subject_prefix`, "candidate_language_pack_invalid");
  if (value.subject_prefix.includes(":"))
    invalid("subject_prefix is the word alone, without a colon");
  return Object.freeze({
    admitsScripts: Object.freeze([...value.admits_scripts]),
    locale: value.locale,
    name,
    script: value.script,
    signature: value.signature,
    subjectPrefix: value.subject_prefix,
  });
}

function parsePins(name, packPath, text) {
  const label = `languages/${name}/${candidatePinsBasename}`;
  const invalid = (message) => fail("candidate_pins_invalid", `${label}: ${message}`);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    invalid("is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid("must be a JSON object");
  const unknown = Object.keys(value).find((key) => key !== "pins" && key !== "schema_version");
  if (unknown !== undefined) invalid(`declares a field this reader does not know: ${unknown}`);
  if (value.schema_version !== candidatePinsSchemaVersion) {
    invalid(`declares a schema this engine does not read; it reads ${candidatePinsSchemaVersion}`);
  }
  if (!Array.isArray(value.pins) || value.pins.length === 0 || value.pins.length > MAX_PINS) {
    invalid(`pins must be an array of 1 to ${MAX_PINS} entries`);
  }
  const seen = new Set();
  const pins = value.pins.map((pin, index) => {
    if (pin === null || typeof pin !== "object" || Array.isArray(pin))
      invalid(`pin at index ${index} must be an object`);
    // The id is also the name of the letter's file, so its form is what keeps a pin inside `pins/`.
    if (typeof pin.id !== "string" || !PIN_ID.test(pin.id)) {
      invalid(
        `pin at index ${index}: id must be lowercase letters, digits and hyphens, starting with a letter`,
      );
    }
    if (seen.has(pin.id)) invalid(`declares pin ${pin.id} twice`);
    seen.add(pin.id);
    const field = Object.keys(pin).find((key) => !PIN_FIELDS.includes(key));
    if (field !== undefined) invalid(`pin ${pin.id}: field ${field} is not part of a pin`);
    if (!PIN_EXPECTATIONS.includes(pin.expect))
      invalid(`pin ${pin.id}: expect must be accept or reject`);
    const rejecting = pin.expect === "reject";
    if (rejecting !== Object.hasOwn(pin, "finding")) {
      invalid(`pin ${pin.id}: a reject pin names its finding, and an accept pin names none`);
    }
    if (rejecting)
      requireLine(pin.finding, `${label}: pin ${pin.id}: finding`, "candidate_pins_invalid");
    requireLine(pin.why, `${label}: pin ${pin.id}: why`, "candidate_pins_invalid");
    const terms = pin.keyword_terms;
    if (
      !Array.isArray(terms) ||
      terms.length === 0 ||
      terms.some((term) => typeof term !== "string" || term.trim() === "")
    ) {
      invalid(`pin ${pin.id}: keyword_terms must be a non-empty array of non-empty strings`);
    }
    const path = join(packPath, candidatePinsDirectoryName, `${pin.id}.txt`);
    if (entryKind(path) !== "file")
      invalid(`pin ${pin.id}: ${candidatePinsDirectoryName}/${pin.id}.txt is not a file`);
    return Object.freeze({
      expect: pin.expect,
      finding: rejecting ? pin.finding : null,
      id: pin.id,
      keywordTerms: Object.freeze([...terms]),
      path,
      why: pin.why,
    });
  });
  const declared = new Set(pins.map((pin) => `${pin.id}.txt`));
  const stray = visibleEntries(join(packPath, candidatePinsDirectoryName)).find(
    (entry) => !declared.has(entry),
  );
  if (stray !== undefined) invalid(`${candidatePinsDirectoryName}/${stray} is not a declared pin`);
  return Object.freeze(pins);
}

/** The letter of one pin, as bytes. */
export function readCandidatePinLetter(pin) {
  const text = readText(pin.path, `pin ${pin.id}`, {
    code: "candidate_pins_invalid",
    maximum: MAX_PIN_BYTES,
  });
  return new TextEncoder().encode(text);
}

function readPack(root, name) {
  const packPath = candidateLanguagePackPathFor(root, name);
  const kind = entryKind(packPath);
  if (kind === null) {
    fail(
      "candidate_language_pack_missing",
      `the config names ${name}, and languages/${name}/ is not there`,
    );
  }
  if (kind !== "directory") {
    fail("candidate_language_pack_unreadable", `languages/${name} must be a directory`);
  }
  const allowed = new Set([
    candidateLanguagePackBasename,
    PACK_CONSTRAINTS_BASENAME,
    candidateLanguageRulesBasename,
    candidatePinsBasename,
    candidatePinsDirectoryName,
  ]);
  for (const entry of visibleEntries(packPath)) {
    if (!allowed.has(entry)) {
      fail(
        "candidate_language_pack_invalid",
        `languages/${name}/${entry} is not a file a pack holds`,
      );
    }
    const expected = entry === candidatePinsDirectoryName ? "directory" : "file";
    if (entryKind(join(packPath, entry)) !== expected) {
      fail("candidate_language_pack_invalid", `languages/${name}/${entry} must be a ${expected}`);
    }
  }
  const packFile = join(packPath, candidateLanguagePackBasename);
  if (entryKind(packFile) === null) {
    fail(
      "candidate_language_pack_missing",
      `languages/${name}/${candidateLanguagePackBasename} is not there`,
    );
  }
  const pack = parsePack(
    name,
    readText(packFile, `languages/${name}/${candidateLanguagePackBasename}`, {
      code: "candidate_language_pack_unreadable",
      maximum: MAX_PACK_BYTES,
    }),
  );
  const rulesPath = join(packPath, candidateLanguageRulesBasename);
  const hasRules = entryKind(rulesPath) !== null;
  if (hasRules) {
    readText(rulesPath, `languages/${name}/${candidateLanguageRulesBasename}`, {
      code: "candidate_language_pack_unreadable",
      maximum: MAX_RULES_BYTES,
    });
  }
  const pinsPath = join(packPath, candidatePinsBasename);
  const hasPins = entryKind(pinsPath) !== null;
  const hasPinsDirectory = entryKind(join(packPath, candidatePinsDirectoryName)) !== null;
  if (hasPinsDirectory && !hasPins) {
    fail(
      "candidate_pins_invalid",
      `languages/${name}/${candidatePinsDirectoryName}/ is there without ${candidatePinsBasename}`,
    );
  }
  const pins = hasPins
    ? parsePins(
        name,
        packPath,
        readText(pinsPath, `languages/${name}/${candidatePinsBasename}`, {
          code: "candidate_pins_invalid",
          maximum: MAX_PACK_BYTES,
        }),
      )
    : Object.freeze([]);
  return Object.freeze({
    ...pack,
    path: packPath,
    pins,
    rulesPath: hasRules ? rulesPath : null,
  });
}

/**
 * Every language of a validated config with what a letter in it is checked by, the packs read from
 * the layer rooted at `root`: the default first, then one entry per configured language.
 *
 * Both directions are refused. A configured language without a pack has nothing to check a letter
 * by; a pack no config names is a pack nobody reads, and its pins would never run.
 */
export function readCandidateLanguages({ root, config }) {
  const names = candidateLanguageNamesFrom(config);
  const directory = join(root, candidateLanguagesDirectoryName);
  const kind = entryKind(directory);
  if (kind !== null && kind !== "directory") {
    fail(
      "candidate_language_pack_unreadable",
      `${candidateLanguagesDirectoryName} must be a directory`,
    );
  }
  if (kind === "directory") {
    const stray = visibleEntries(directory).find((entry) => !names.slice(1).includes(entry));
    if (stray !== undefined) {
      fail(
        "candidate_language_pack_unconfigured",
        `languages/${stray} is a pack the config does not name`,
      );
    }
  }
  const packs = names.slice(1).map((name) => readPack(root, name));
  return Object.freeze([
    Object.freeze({
      ...DEFAULT_LANGUAGE,
      path: null,
      pins: Object.freeze([]),
      rulesPath: null,
      signature: config.letter.signature,
    }),
    ...packs,
  ]);
}
