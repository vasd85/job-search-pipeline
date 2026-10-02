/**
 * The constraints of the candidate layer: the personal rules a machine can check.
 *
 * Some of what one person wants held in every CV and cover letter is not a value and not prose a
 * reader has to remember — it is a phrase that must never appear, a term to be preferred over
 * another, a word that has one correct spelling. Those three shapes are this vocabulary, and the
 * file that carries them is `constraints.json` beside `config.json` in the layer.
 *
 * A constraint cannot be a config key: the config schema declares a flat table of dotted paths
 * with scalar types, and a constraint is a record with a scope and a payload. Hence a second file,
 * a second version, and this reader.
 *
 * The candidate adds and never subtracts. There is no shape here for removing an engine
 * constraint — an unknown field is a refusal — and the one remaining way to work around one,
 * making required what the engine forbids, is refused where it is written by
 * `assertCandidateConstraintsCompatible`. What an engine constraint forbids, and how it decides a
 * match, is passed in by whoever owns that list; nothing about it is copied here, because a copy
 * would drift from the original and refuse a layer the engine itself would accept.
 *
 * A finding names what the material is allowed to contain and nothing else: the constraint id, its
 * type, and — for the two types that have one — the word the author is supposed to write. The
 * forbidden phrase is never quoted, and neither is `why`. A refusal message travels into the
 * publication error, into stderr and into the session transcript, and the usual reason for
 * forbidding a name is that it should not be repeated.
 *
 * One kind of entry is not written in the file at all. A project whose profile entry says
 * `**Visibility:** private` never appears in a material by name (`generation-rules.md` rule 16),
 * and that ban is keyed to the visibility line and nothing else: the engine derives one
 * `forbid_phrases` entry per private project from the profile, for both materials, and a project
 * turned public loses its entry with the same edit. The ids of derived entries carry a prefix no
 * entry of a file may use, so the two sources never collide.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CandidateError, candidateLanguageNames, loadCandidateProfile } from "./load.mjs";
import { DEFAULT_LANGUAGE, candidateLanguagePackPathFor, isLanguageName } from "./languages.mjs";

export const candidateConstraintsSchemaVersion = 1;
export const candidateConstraintsBasename = "constraints.json";

/** The three shapes a machine-checkable personal rule can take. */
export const candidateConstraintTypes = Object.freeze([
  "forbid_phrases",
  "prefer_terms",
  "required_spellings",
]);

/** The materials a constraint can be scoped to: the two this engine validates. */
export const candidateConstraintMaterials = Object.freeze(["cover_letter", "cv"]);

/** The id prefix of the entries derived from the profile; an entry of a file may not use it. */
export const candidatePrivateProjectIdPrefix = "private-project-";

const MAX_CONSTRAINTS_BYTES = 256 * 1024;
const MAX_ENTRIES = 200;
const MAX_TERM_LENGTH = 100;
const MAX_TERMS_PER_ENTRY = 50;
const MAX_WHY_LENGTH = 200;
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const WHITESPACE = /\p{White_Space}/u;

const PAYLOAD_FIELDS = Object.freeze({
  forbid_phrases: Object.freeze({ list: "phrases", required: null }),
  prefer_terms: Object.freeze({ list: "avoid", required: "prefer" }),
  required_spellings: Object.freeze({ list: "instead_of", required: "spelling" }),
});

const ENTRY_FIELDS = Object.freeze(["id", "scope", "type", "why"]);

function fail(code, message) {
  throw new CandidateError(code, message);
}

function escapeForPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizeWhitespace(value) {
  return value.replace(/\p{White_Space}+/gu, " ").trim();
}

/**
 * Whether `text` contains `term` as a whole term.
 *
 * One predicate for all three types and both materials, so the same constraint means the same
 * thing wherever it is applied. Word boundaries are letters and digits, and a multi-word term
 * matches across any run of whitespace, so a phrase broken over two lines is still found.
 *
 * `caseSensitive` is what separates a spelling from a term: a spelling is about the exact
 * characters of a word, a term is a term however it is capitalized.
 */
export function containsCandidateTerm(text, term, { caseSensitive = false } = {}) {
  const haystack = normalizeWhitespace(String(text));
  const needle = normalizeWhitespace(String(term));
  if (!haystack || !needle) return false;
  const phrase = needle.split(" ").map(escapeForPattern).join("\\s+");
  const flags = caseSensitive ? "u" : "iu";
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${phrase}(?=$|[^\\p{L}\\p{N}])`, flags).test(haystack);
}

function requireTerm(value, { entryId, field, singleWord }) {
  if (typeof value !== "string" || normalizeWhitespace(value).length === 0) {
    fail(
      "candidate_constraint_payload_invalid",
      `constraint ${entryId}: ${field} must be a non-empty string`,
    );
  }
  if (value.length > MAX_TERM_LENGTH) {
    fail(
      "candidate_constraint_payload_invalid",
      `constraint ${entryId}: ${field} must be at most ${MAX_TERM_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTER.test(value)) {
    fail(
      "candidate_constraint_payload_invalid",
      `constraint ${entryId}: ${field} must not contain control characters`,
    );
  }
  // A spelling is one word by definition. Refusing a phrase here is what keeps the two
  // replacement types apart mechanically rather than by the author's intention.
  if (singleWord && WHITESPACE.test(value.trim())) {
    fail(
      "candidate_constraint_payload_invalid",
      `constraint ${entryId}: ${field} must be a single word; a phrase belongs to prefer_terms`,
    );
  }
  return value;
}

function requireTermList(value, { entryId, field, singleWord }) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(
      "candidate_constraint_payload_invalid",
      `constraint ${entryId}: ${field} must be a non-empty array`,
    );
  }
  if (value.length > MAX_TERMS_PER_ENTRY) {
    fail(
      "candidate_constraint_payload_invalid",
      `constraint ${entryId}: ${field} must hold at most ${MAX_TERMS_PER_ENTRY} entries`,
    );
  }
  return Object.freeze(value.map((entry, index) =>
    requireTerm(entry, { entryId, field: `${field}[${index}]`, singleWord })));
}

function requireScope(value, entryId) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("candidate_constraint_scope_invalid", `constraint ${entryId}: scope must be an object`);
  }
  const unknown = Object.keys(value).find((key) => key !== "materials");
  if (unknown !== undefined) {
    fail(
      "candidate_constraint_scope_invalid",
      `constraint ${entryId}: scope declares a field this reader does not know: ${unknown}`,
    );
  }
  const { materials } = value;
  if (!Array.isArray(materials) || materials.length === 0) {
    fail(
      "candidate_constraint_scope_invalid",
      `constraint ${entryId}: scope.materials must be a non-empty array`,
    );
  }
  const seen = new Set();
  for (const material of materials) {
    if (!candidateConstraintMaterials.includes(material)) {
      fail(
        "candidate_constraint_scope_invalid",
        `constraint ${entryId}: scope.materials must name only ${candidateConstraintMaterials.join(" or ")}`,
      );
    }
    if (seen.has(material)) {
      fail(
        "candidate_constraint_scope_invalid",
        `constraint ${entryId}: scope.materials repeats ${material}`,
      );
    }
    seen.add(material);
  }
  return Object.freeze({ materials: Object.freeze([...materials]) });
}

function requireWhy(value, entryId) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("candidate_constraint_why_invalid", `constraint ${entryId}: why must be a non-empty string`);
  }
  if (value.length > MAX_WHY_LENGTH) {
    fail(
      "candidate_constraint_why_invalid",
      `constraint ${entryId}: why must be at most ${MAX_WHY_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTER.test(value)) {
    fail("candidate_constraint_why_invalid", `constraint ${entryId}: why must be a single line`);
  }
  return value;
}

function parseEntry(value, index, seenIds) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("candidate_constraints_shape_invalid", `constraint at index ${index} must be an object`);
  }
  const { id } = value;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    fail(
      "candidate_constraint_id_invalid",
      `constraint at index ${index}: id must be lowercase letters, digits and hyphens, starting with a letter`,
    );
  }
  if (id.startsWith(candidatePrivateProjectIdPrefix)) {
    fail(
      "candidate_constraint_id_invalid",
      `constraint ${id}: ids starting with ${candidatePrivateProjectIdPrefix} are derived from the profile's private projects`,
    );
  }
  if (seenIds.has(id)) {
    fail("candidate_constraint_id_duplicate", `constraints declare ${id} twice`);
  }
  seenIds.add(id);
  const { type } = value;
  if (!candidateConstraintTypes.includes(type)) {
    fail(
      "candidate_constraint_type_unknown",
      `constraint ${id}: type must be one of ${candidateConstraintTypes.join(", ")}`,
    );
  }
  const fields = PAYLOAD_FIELDS[type];
  const known = new Set([...ENTRY_FIELDS, fields.list, ...(fields.required ? [fields.required] : [])]);
  // An unknown field is a refusal rather than something ignored. This is where an attempt to
  // switch an engine constraint off would land: the file has no shape for subtraction, and a
  // field invented to express one is refused by name.
  const unknown = Object.keys(value).find((key) => !known.has(key));
  if (unknown !== undefined) {
    fail(
      "candidate_constraint_unknown_field",
      `constraint ${id}: field ${unknown} is not part of ${type}; no field of this file removes an engine constraint`,
    );
  }
  const singleWord = type === "required_spellings";
  const entry = {
    id,
    scope: requireScope(value.scope, id),
    terms: requireTermList(value[fields.list], { entryId: id, field: fields.list, singleWord }),
    type,
    why: requireWhy(value.why, id),
  };
  if (fields.required) {
    entry.required = requireTerm(value[fields.required], {
      entryId: id,
      field: fields.required,
      singleWord,
    });
    entry.requiredField = fields.required;
  } else {
    entry.required = null;
    entry.requiredField = null;
  }
  entry.caseSensitive = singleWord;
  // An entry that refuses its own required wording is unsatisfiable on its own, and the author
  // would get a finding telling them to write what they already wrote. It is the same pair the
  // engine check refuses, with both halves inside one record.
  if (entry.required !== null) {
    const selfRefusing = entry.terms.find((term) =>
      containsCandidateTerm(entry.required, term, { caseSensitive: entry.caseSensitive }));
    if (selfRefusing !== undefined) {
      fail(
        "candidate_constraint_payload_invalid",
        `constraint ${id}: ${entry.requiredField} contains wording the entry itself refuses`,
      );
    }
  }
  return Object.freeze(entry);
}

/**
 * The parsed constraints of one already-read value. Every disagreement throws with a bounded code.
 */
export function parseCandidateConstraints(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("candidate_constraints_shape_invalid", "candidate constraints must be a JSON object");
  }
  if (!Object.hasOwn(value, "schema_version")) {
    fail("candidate_constraints_schema_version_missing", "candidate constraints must carry schema_version");
  }
  if (value.schema_version !== candidateConstraintsSchemaVersion) {
    fail(
      "candidate_constraints_schema_version_unsupported",
      `candidate constraints declare a schema this engine does not read; it reads ${candidateConstraintsSchemaVersion}`,
    );
  }
  const unknown = Object.keys(value).find((key) => key !== "constraints" && key !== "schema_version");
  if (unknown !== undefined) {
    fail(
      "candidate_constraints_shape_invalid",
      `candidate constraints declare a field this reader does not know: ${unknown}`,
    );
  }
  const { constraints } = value;
  if (!Array.isArray(constraints)) {
    fail("candidate_constraints_shape_invalid", "candidate constraints must carry a constraints array");
  }
  if (constraints.length > MAX_ENTRIES) {
    fail(
      "candidate_constraints_shape_invalid",
      `candidate constraints must hold at most ${MAX_ENTRIES} entries`,
    );
  }
  const seenIds = new Set();
  return Object.freeze(constraints.map((entry, index) => parseEntry(entry, index, seenIds)));
}

export function candidateConstraintsPathFor(root) {
  return join(root, candidateConstraintsBasename);
}

function requireExactRootPath(root) {
  if (typeof root !== "string" || root.length === 0 || !isAbsolute(root) || root !== resolve(root)) {
    fail("candidate_root_invalid", "candidate root must be an absolute normalized path");
  }
  return root;
}

/**
 * The constraints of the layer rooted at `root`.
 *
 * Absence is an answer, not a failure, and it is an answer twice over: a checkout with no layer at
 * all, and a layer written before this file existed, both report `absent` and constrain nothing.
 * The config reader refuses a missing root; this one must not, because it is read unconditionally
 * wherever the layer is checked, and a development worktree has no layer by construction.
 *
 * A present but unreadable file is a refusal. Saying "checked" over a file nobody could read is
 * the one outcome a check must not have.
 */
export function loadCandidateConstraints({ root } = {}) {
  const exact = requireExactRootPath(root);
  const path = candidateConstraintsPathFor(exact);
  let bytes;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) {
      fail("candidate_constraints_unreadable", "candidate constraints must be a regular file");
    }
    if (stats.size > MAX_CONSTRAINTS_BYTES) {
      fail("candidate_constraints_unreadable", "candidate constraints are larger than this reader accepts");
    }
    bytes = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof CandidateError) throw error;
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return Object.freeze({ constraints: Object.freeze([]), path: null, status: "absent" });
    }
    fail(
      "candidate_constraints_unreadable",
      `candidate constraints are not readable (${error?.code ?? "unknown"})`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    fail("candidate_constraints_invalid_json", "candidate constraints are not valid JSON");
  }
  return Object.freeze({
    constraints: parseCandidateConstraints(parsed),
    path,
    status: "ready",
  });
}

/**
 * The entries derived from a profile: one `forbid_phrases` per project whose visibility is
 * `private`, its phrase the project's name, bound to both materials. A public project derives
 * nothing, and so does a layer that is not there (`profile` is `null`).
 *
 * The name skips the length limit of a written term on purpose: a long project heading must not
 * make the whole layer unreadable.
 */
export function candidatePrivateProjectConstraints(profile) {
  if (profile === null) return Object.freeze([]);
  return Object.freeze(profile.projects
    .filter((project) => project.visibility === "private")
    .map((project) => Object.freeze({
      caseSensitive: false,
      id: `${candidatePrivateProjectIdPrefix}${project.number.replace(".", "-")}`,
      required: null,
      requiredField: null,
      scope: Object.freeze({ materials: candidateConstraintMaterials }),
      terms: Object.freeze([project.name]),
      type: "forbid_phrases",
      why: `project ${project.number.split(".")[1]} of candidate/profile.md#10-personal-projects is private, and a private project is never named (generation-rules.md rule 16)`,
    })));
}

// The layer's own entries and the ones its profile derives, as one list. The profile is read on
// its own: a present layer without a readable profile refuses here, as it does everywhere else.
function layerConstraints(root, fileConstraints) {
  const derived = candidatePrivateProjectConstraints(loadCandidateProfile({ root }));
  return Object.freeze([...fileConstraints, ...derived]);
}

/** The constraints that apply to one material. */
export function selectCandidateConstraints(constraints, { material } = {}) {
  if (!candidateConstraintMaterials.includes(material)) {
    fail(
      "candidate_constraint_scope_invalid",
      `material must be one of ${candidateConstraintMaterials.join(", ")}`,
    );
  }
  return Object.freeze(constraints.filter((entry) => entry.scope.materials.includes(material)));
}

/**
 * Refuse a candidate entry that makes required what an engine constraint forbids.
 *
 * This is not what keeps an engine constraint in force — nothing in the candidate file can lift
 * one, because the engine's own check runs whether or not a layer is present. What it does is
 * refuse an unsatisfiable pair where it is written, instead of handing it back later as two
 * refusals on a finished material that contradict each other.
 *
 * `engineForbidden` is a list of `{ terms, matches }` supplied by the owner of each engine list,
 * `matches(text, term)` being that list's own predicate. Nothing is copied: a copy would part ways
 * with the original and refuse a layer the engine would have accepted.
 */
export function assertCandidateConstraintsCompatible(constraints, { engineForbidden = [] } = {}) {
  for (const entry of constraints) {
    if (entry.required === null) continue;
    for (const { terms, matches } of engineForbidden) {
      for (const term of terms) {
        if (matches(entry.required, term)) {
          fail(
            "candidate_constraint_conflicts_with_engine",
            `constraint ${entry.id}: ${entry.requiredField} requires wording this engine forbids: ${term}`,
          );
        }
      }
    }
  }
  return constraints;
}

/**
 * Every constraint one material breaks, as the messages a validator reports.
 *
 * The message carries the constraint id, its type and — for the two types that name a replacement
 * — the wording the author is expected to use. It never carries the matched text or `why`; see the
 * note at the top of this file.
 */
export function candidateConstraintFindings(constraints, text, { artifact } = {}) {
  const findings = [];
  for (const entry of constraints) {
    const broken = entry.terms.some((term) =>
      containsCandidateTerm(text, term, { caseSensitive: entry.caseSensitive }));
    if (!broken) continue;
    if (entry.type === "forbid_phrases") {
      findings.push(`${artifact} breaks candidate constraint "${entry.id}" (forbid_phrases)`);
    } else if (entry.type === "prefer_terms") {
      findings.push(
        `${artifact} breaks candidate constraint "${entry.id}" (prefer_terms): write "${entry.required}"`,
      );
    } else {
      findings.push(
        `${artifact} breaks candidate constraint "${entry.id}" (required_spellings): spell it "${entry.required}"`,
      );
    }
  }
  return findings;
}

/**
 * The constraints one material must satisfy, loaded, narrowed to that material and then checked
 * against that material's own engine lists — the single call a validator's caller makes.
 *
 * The order matters and is not the obvious one. Each material has its own engine list, so a
 * constraint is compared only with the list of the material it binds: the letter forbids
 * typography the CV has no opinion about, and an entry requiring an employer's name spelled with a
 * typographic apostrophe is legitimate on the CV. Checking before narrowing would let that entry
 * refuse every letter publication in the checkout, over a pair that does not exist.
 *
 * A letter in a configured language also carries the constraints of that language's pack. They
 * are added after the narrowing and checked with the layer's own entries as one list, so the
 * publication, its dry run and the pins of a pack all see the same set.
 */
export function candidateConstraintsFor({ engineForbidden = [], language = null, material, root } = {}) {
  const loaded = loadCandidateConstraints({ root });
  const selected = selectCandidateConstraints(layerConstraints(root, loaded.constraints), { material });
  const merged = material === "cover_letter" && isLanguageName(language) && language !== DEFAULT_LANGUAGE.name
    ? mergePackConstraints(selected, loadCandidatePackConstraints({ language, root }).constraints, language)
    : selected;
  assertCandidateConstraintsCompatible(merged, { engineForbidden });
  return merged;
}

/**
 * The constraints of one language pack: `constraints.json` in `candidate/languages/<language>/`,
 * the same vocabulary and the same reader as the layer's own file. A pack binds only letters —
 * the CV is always in the default language, so a pack entry naming it could never apply. The file
 * is optional, and its absence constrains nothing.
 */
export function loadCandidatePackConstraints({ language, root } = {}) {
  const exact = requireExactRootPath(root);
  const label = `languages/${language}/${candidateConstraintsBasename}`;
  let loaded;
  try {
    loaded = loadCandidateConstraints({ root: candidateLanguagePackPathFor(exact, language) });
  } catch (error) {
    if (error instanceof CandidateError) fail(error.code, `${label}: ${error.message}`);
    throw error;
  }
  for (const entry of loaded.constraints) {
    if (entry.scope.materials.length !== 1 || entry.scope.materials[0] !== "cover_letter") {
      fail(
        "candidate_constraint_scope_invalid",
        `${label}: constraint ${entry.id}: a pack's constraint binds cover_letter alone`,
      );
    }
  }
  return loaded;
}

function mergePackConstraints(layer, pack, language) {
  const ids = new Set(layer.map((entry) => entry.id));
  const repeated = pack.find((entry) => ids.has(entry.id));
  if (repeated !== undefined) {
    fail(
      "candidate_constraint_id_duplicate",
      `constraints of the layer and of languages/${language}/ both declare ${repeated.id}`,
    );
  }
  return Object.freeze([...layer, ...pack]);
}

/**
 * Every constraint file of the layer rooted at `root`, read for a check rather than for one
 * material: the layer's own file and the file of every configured pack, each id unique within the
 * layer's file and one pack together. A layer that is not there has none. `count` also holds the
 * entries the profile derives; `status` speaks of the layer's own file alone.
 */
export function loadAllCandidateConstraints({ root } = {}) {
  const layer = loadCandidateConstraints({ root });
  const entries = layerConstraints(root, layer.constraints);
  const names = candidateLanguageNames({ root }).filter((name) => name !== DEFAULT_LANGUAGE.name);
  let count = entries.length;
  for (const language of names) {
    const pack = loadCandidatePackConstraints({ language, root }).constraints;
    mergePackConstraints(entries, pack, language);
    count += pack.length;
  }
  return Object.freeze({ count, status: layer.status });
}
