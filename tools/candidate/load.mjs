/**
 * Reading the candidate layer: the private directory that holds everything specific to one
 * person, and the tracked example beside it that the test suite runs on.
 *
 * The root is always a parameter and never resolved from a default here. A loader that knew where
 * the layer lives would read the operator's real candidate from a test, and the suite runs only
 * on injected disposable roots. The callers that do have a default — the bootstrap CLI, this
 * tool's own CLI and the CV builder's CLI — derive it from their workspace root with
 * `candidateRootFor` and pass it in.
 *
 * Every refusal is an exception with a bounded code. A version the engine does not read is one of
 * them and never a warning: a config written for another schema is not a config with an extra
 * field, it is a file whose meaning this code does not know.
 *
 * The root is refused when it is itself a symbolic link, the same `lstat` rule the output root
 * carries. The ancestor rule of `tools/lib/output-root.mjs` is deliberately not copied: it
 * compares `realpath` against a canonical path with a named carve-out for a symlinked `tmpdir`,
 * and without that carve-out it would refuse every disposable root the suite creates.
 */

import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  candidateDocumentErrorCodes,
  candidateLetterSamplesBasename,
  candidateLeversBasename,
  candidateProfileBasename,
  candidateRulesBasename,
  validateCandidateLetterSamples,
  validateCandidateLevers,
  validateCandidateProfile,
  validateCandidateRules,
} from "./documents.mjs";
import { CandidateError } from "./errors.mjs";
import {
  candidateConfigDisjoint,
  candidateConfigDistinct,
  candidateConfigKeys,
  candidateConfigKeyTypes,
  candidateConfigRelations,
  candidateConfigSchemaVersion,
  candidateConfigSubsets,
  candidateSchemaVersionKey,
} from "./schema.mjs";
import { candidateScoringFrom, isScoringInputPath, validateScoringPoints } from "./scoring.mjs";
import {
  DEFAULT_LANGUAGE,
  candidateLanguageErrorCodes,
  candidateLanguageNamesFrom,
  readCandidateLanguages,
} from "./languages.mjs";
import { candidateMarketsFrom } from "./markets.mjs";
import { candidatePrioritiesFrom } from "./priorities.mjs";
import {
  candidateManifestErrorCodes,
  checkCandidateLayerParity,
  checkCandidateLayerSections,
  loadCandidateManifest,
} from "./manifest.mjs";

export const candidateDirectoryName = "candidate";
export const candidateExampleDirectoryName = "candidate.example";
export const candidateConfigBasename = "config.json";

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_DOCUMENT_BYTES = 1024 * 1024;

export { CandidateError };

export const candidateErrorCodes = Object.freeze(
  [
    ...candidateDocumentErrorCodes,
    ...candidateLanguageErrorCodes,
    ...candidateManifestErrorCodes,
    "candidate_config_invalid_json",
    "candidate_config_key_missing",
    "candidate_config_key_type_invalid",
    "candidate_config_missing",
    "candidate_config_shape_invalid",
    "candidate_config_unknown_key",
    "candidate_config_unreadable",
    "candidate_config_value_invalid",
    "candidate_constraint_conflicts_with_engine",
    "candidate_constraint_id_duplicate",
    "candidate_constraint_id_invalid",
    "candidate_constraint_payload_invalid",
    "candidate_constraint_scope_invalid",
    "candidate_constraint_type_unknown",
    "candidate_constraint_unknown_field",
    "candidate_constraint_why_invalid",
    "candidate_constraints_invalid_json",
    "candidate_constraints_schema_version_missing",
    "candidate_constraints_schema_version_unsupported",
    "candidate_constraints_shape_invalid",
    "candidate_constraints_unreadable",
    "candidate_key_root_invalid",
    "candidate_root_invalid",
    "candidate_schema_key_type_unknown",
    "candidate_schema_relation_invalid",
    "candidate_schema_version_missing",
    "candidate_schema_version_unsupported",
  ].sort(),
);

function fail(code, message) {
  throw new CandidateError(code, message);
}

export function candidateRootFor(workspaceRoot) {
  return join(workspaceRoot, candidateDirectoryName);
}

/**
 * The layer a command-line entry point reads when it is not handed one: `candidate/` of the
 * workspace named by `JOB_PIPELINE_WORKSPACE_ROOT`, or of the checkout the command belongs to.
 * Only an entry point calls this; a function a test can reach takes its root as a parameter.
 */
export function candidateRootForCommand(checkoutRoot, environment = process.env) {
  return candidateRootFor(resolve(environment.JOB_PIPELINE_WORKSPACE_ROOT ?? checkoutRoot));
}

export function candidateExampleRootFor(repositoryRoot) {
  return join(repositoryRoot, candidateExampleDirectoryName);
}

function requireExactRootPath(root) {
  if (typeof root !== "string" || root.length === 0) {
    fail("candidate_root_invalid", "candidate root must be a non-empty string");
  }
  if (!isAbsolute(root) || root !== resolve(root)) {
    fail("candidate_root_invalid", "candidate root must be an absolute normalized path");
  }
  return root;
}

/**
 * The root as a directory, or `null` when it is not there at all.
 *
 * Absence is an answer, not a failure: a development worktree legitimately has no candidate layer.
 * Everything else about the root — a file, a symbolic link, an unreadable entry — is a refusal,
 * because each of them is a root that looks present and is not the one this tool would read.
 */
function inspectRoot(root) {
  let stats;
  try {
    stats = lstatSync(root);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    fail("candidate_root_invalid", `candidate root is unavailable (${error?.code ?? "unknown"})`);
  }
  if (stats.isSymbolicLink()) {
    fail("candidate_root_invalid", "candidate root must not be a symbolic link");
  }
  if (!stats.isDirectory()) {
    fail("candidate_root_invalid", "candidate root must be a directory");
  }
  return stats;
}

// An empty object is registered as a path of its own rather than recursed into. Without that, a
// key the schema never declared hides behind `{}`: the recursion finds no leaf below it, and the
// unknown-key check has nothing to reject.
function collectPaths(value, prefix, found) {
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      Object.keys(entry).length > 0
    ) {
      collectPaths(entry, path, found);
      continue;
    }
    found.set(path, entry);
  }
}

function hasType(value, type) {
  switch (type) {
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isSafeInteger(value);
    case "string":
      return typeof value === "string";
    case "integer[]":
      return Array.isArray(value) && value.every(Number.isSafeInteger);
    case "record[]":
      return (
        Array.isArray(value) &&
        value.every((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry))
      );
    case "string[]":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string");
    default:
      return false;
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

/**
 * The parsed config against the schema. Returns the deeply frozen value; every disagreement
 * throws.
 *
 * Both directions are checked, then each value against its own bound, then the orderings between
 * keys, then the pairs that must differ, then the lists that must nest or stay apart. The relations,
 * the pairs and the lists follow the key table they belong to: a caller that injects its own table
 * gets none of them unless it passes them too, and an ordering naming a key its table does not
 * declare as an integer, a pair naming one it does not declare as a string, or a list relation
 * naming one it does not declare as a list, is a fault of the schema, not of the config.
 */
export function validateCandidateConfig(
  value,
  keys = candidateConfigKeys,
  relations = keys === candidateConfigKeys ? candidateConfigRelations : [],
  distinct = keys === candidateConfigKeys ? candidateConfigDistinct : [],
  {
    subsets = keys === candidateConfigKeys ? candidateConfigSubsets : [],
    disjoint = keys === candidateConfigKeys ? candidateConfigDisjoint : [],
  } = {},
) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("candidate_config_shape_invalid", "candidate config must be a JSON object");
  }
  if (!Object.hasOwn(value, candidateSchemaVersionKey)) {
    fail(
      "candidate_schema_version_missing",
      `candidate config must carry ${candidateSchemaVersionKey}`,
    );
  }
  if (value[candidateSchemaVersionKey] !== candidateConfigSchemaVersion) {
    fail(
      "candidate_schema_version_unsupported",
      `candidate config declares a schema this engine does not read; it reads ${candidateConfigSchemaVersion}`,
    );
  }
  const found = new Map();
  collectPaths(value, "", found);
  found.delete(candidateSchemaVersionKey);
  const declared = new Map(keys.map((key) => [key.path, key.type]));
  for (const [path, type] of declared) {
    if (!candidateConfigKeyTypes.includes(type)) {
      fail(
        "candidate_schema_key_type_unknown",
        `the schema declares ${path} with a type this reader does not know: ${type}`,
      );
    }
  }
  for (const path of found.keys()) {
    if (!declared.has(path)) {
      fail(
        "candidate_config_unknown_key",
        `candidate config declares a key the schema does not: ${path}`,
      );
    }
  }
  for (const relation of relations) {
    for (const path of [relation.lower, relation.upper]) {
      if (declared.get(path) !== "integer") {
        fail(
          "candidate_schema_relation_invalid",
          `the schema relates ${path}, which it does not declare as an integer`,
        );
      }
    }
  }
  for (const pair of distinct) {
    for (const path of [pair.one, pair.other]) {
      if (declared.get(path) !== "string") {
        fail(
          "candidate_schema_relation_invalid",
          `the schema requires ${path} to differ, which it does not declare as a string`,
        );
      }
    }
  }
  for (const pair of [
    ...subsets.map(({ subset, superset }) => [subset, superset]),
    ...disjoint.map(({ one, other }) => [one, other]),
  ]) {
    for (const path of pair) {
      if (declared.get(path) !== "string[]") {
        fail(
          "candidate_schema_relation_invalid",
          `the schema relates the members of ${path}, which it does not declare as a list`,
        );
      }
    }
  }
  for (const [path, type] of declared) {
    if (!found.has(path)) {
      fail("candidate_config_key_missing", `candidate config omits a declared key: ${path}`);
    }
    if (!hasType(found.get(path), type)) {
      fail("candidate_config_key_type_invalid", `candidate config key ${path} must be ${type}`);
    }
  }
  for (const key of keys) {
    const entry = found.get(key.path);
    if (key.minimum !== undefined && entry < key.minimum) {
      fail(
        "candidate_config_value_invalid",
        `candidate config key ${key.path} must be at least ${key.minimum}`,
      );
    }
    // The value is not quoted: it is the candidate's own, and a refusal travels into transcripts.
    if (key.accepts !== undefined && !key.accepts(entry)) {
      fail(
        "candidate_config_value_invalid",
        `candidate config key ${key.path} must be ${key.expected}`,
      );
    }
  }
  for (const { lower, strict, upper } of relations) {
    if (
      strict === true ? found.get(lower) >= found.get(upper) : found.get(lower) > found.get(upper)
    ) {
      fail(
        "candidate_config_value_invalid",
        `candidate config key ${lower} must ${strict === true ? "stay below" : "not exceed"} ${upper}`,
      );
    }
  }
  for (const { one, other } of distinct) {
    if (found.get(one) === found.get(other)) {
      fail(
        "candidate_config_value_invalid",
        `candidate config keys ${one} and ${other} must differ`,
      );
    }
  }
  for (const { subset, superset } of subsets) {
    const members = new Set(found.get(superset));
    if (!found.get(subset).every((entry) => members.has(entry))) {
      fail(
        "candidate_config_value_invalid",
        `every member of candidate config key ${subset} must also be in ${superset}`,
      );
    }
  }
  for (const { one, other } of disjoint) {
    const members = new Set(found.get(one));
    if (found.get(other).some((entry) => members.has(entry))) {
      fail(
        "candidate_config_value_invalid",
        `candidate config keys ${one} and ${other} must share no member`,
      );
    }
  }
  if (keys.some((key) => key.path === "scoring.m.max")) {
    validateScoringPoints(value, (message) => fail("candidate_config_value_invalid", message));
  }
  return deepFreeze(value);
}

/**
 * The value at a declared dotted path of an already validated config. A path the config does not
 * hold is a programming error of the caller, never a default.
 */
export function candidateConfigValue(config, path) {
  let entry = config;
  for (const segment of path.split(".")) {
    if (entry === null || typeof entry !== "object" || !Object.hasOwn(entry, segment)) {
      throw new TypeError(`candidate config holds no value at ${path}`);
    }
    entry = entry[segment];
  }
  return entry;
}

export function candidateConfigPathFor(root) {
  return join(root, candidateConfigBasename);
}

function readConfigBytes(configPath) {
  let bytes;
  try {
    bytes = readFileSync(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("candidate_config_missing", `candidate config is missing: ${candidateConfigBasename}`);
    }
    fail(
      "candidate_config_unreadable",
      `candidate config is not readable (${error?.code ?? "unknown"})`,
    );
  }
  if (bytes.length > MAX_CONFIG_BYTES) {
    fail("candidate_config_unreadable", "candidate config is larger than this reader accepts");
  }
  return bytes;
}

/**
 * The validated config of the layer rooted at `root`. The root must exist: a caller that wants
 * absence to be an answer asks `inspectCandidateLayer` instead.
 */
export function loadCandidateConfig({ root, keys = candidateConfigKeys } = {}) {
  const exact = requireExactRootPath(root);
  if (inspectRoot(exact) === null) {
    fail("candidate_root_invalid", "candidate root does not exist");
  }
  const configPath = candidateConfigPathFor(exact);
  let parsed;
  try {
    parsed = JSON.parse(readConfigBytes(configPath));
  } catch (error) {
    if (error instanceof CandidateError) throw error;
    fail("candidate_config_invalid_json", "candidate config is not valid JSON");
  }
  return Object.freeze({
    config: validateCandidateConfig(parsed, keys),
    configPath,
    root: exact,
    schemaVersion: candidateConfigSchemaVersion,
  });
}

function readDocument(root, basename, { required }) {
  const path = join(root, basename);
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (!required) return null;
      fail("candidate_document_missing", `the candidate layer is missing ${basename}`);
    }
    fail(
      "candidate_document_unreadable",
      `${basename} is not readable (${error?.code ?? "unknown"})`,
    );
  }
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    fail("candidate_document_unreadable", `${basename} is larger than this reader accepts`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("candidate_document_unreadable", `${basename} is not UTF-8 text`);
  }
  return { path, text };
}

/**
 * The four documents of the layer rooted at `root`, each checked against its form. The profile,
 * the lever bank and the rules are required; the letter samples are not — a candidate without an
 * accepted letter has none, and the letter step then goes without them. The rules are required
 * although a candidate may have none: a missing file would read the same as an empty one, and a
 * layer that lost its rules would run without them unnoticed.
 */
export function loadCandidateDocuments({ root } = {}) {
  const exact = requireExactRootPath(root);
  if (inspectRoot(exact) === null) {
    fail("candidate_root_invalid", "candidate root does not exist");
  }
  const profile = readDocument(exact, candidateProfileBasename, { required: true });
  const levers = readDocument(exact, candidateLeversBasename, { required: true });
  const rules = readDocument(exact, candidateRulesBasename, { required: true });
  const samples = readDocument(exact, candidateLetterSamplesBasename, { required: false });
  return Object.freeze({
    letterSamples:
      samples === null
        ? null
        : Object.freeze({ path: samples.path, ...validateCandidateLetterSamples(samples.text) }),
    levers: Object.freeze({ path: levers.path, ...validateCandidateLevers(levers.text) }),
    profile: Object.freeze({ path: profile.path, ...validateCandidateProfile(profile.text) }),
    rules: Object.freeze({ path: rules.path, ...validateCandidateRules(rules.text) }),
  });
}

/**
 * The profile of the layer rooted at `root`, checked against the section map, or `null` when the
 * layer is not there. Only the profile is read: a caller that needs the projects' visibility must
 * not start refusing over a broken lever bank it never reads. A present layer without a readable
 * profile is a refusal — the profile is required wherever the layer is.
 */
export function loadCandidateProfile({ root } = {}) {
  const exact = requireExactRootPath(root);
  if (inspectRoot(exact) === null) return null;
  const profile = readDocument(exact, candidateProfileBasename, { required: true });
  return Object.freeze({ path: profile.path, ...validateCandidateProfile(profile.text) });
}

/**
 * The names of the languages an artifact of this layer may carry: the default language, then the
 * ones the config adds. Only the config is read, so a broken pack does not stop a step that never
 * reads one — the checks of the layer refuse it instead. A layer that is not there answers with the
 * default language alone: that is what a checkout without a layer supports, not a value standing
 * in for a missing one.
 */
export function candidateLanguageNames({ root } = {}) {
  const exact = requireExactRootPath(root);
  if (inspectRoot(exact) === null) return Object.freeze([DEFAULT_LANGUAGE.name]);
  return candidateLanguageNamesFrom(loadCandidateConfig({ root: exact }).config);
}

/**
 * The two markets of the layer rooted at `root`, or `null` when the layer is not there: a checkout
 * without a layer configures no market, so an artifact there can name none. Only the config is
 * read, as for the language names.
 */
export function candidateMarkets({ root } = {}) {
  const exact = requireExactRootPath(root);
  if (inspectRoot(exact) === null) return null;
  return candidateMarketsFrom(loadCandidateConfig({ root: exact }).config);
}

/**
 * The priority classes of the layer rooted at `root`, in the shape the pre-triage stage takes them,
 * or `null` when the layer is not there: a checkout without a layer ranks nothing. Only the config
 * is read, as for the language names.
 */
export function candidatePriorities({ root } = {}) {
  const exact = requireExactRootPath(root);
  if (inspectRoot(exact) === null) return null;
  return candidatePrioritiesFrom(loadCandidateConfig({ root: exact }).config);
}

/**
 * The scoring values of the layer rooted at `root`, in the shape the scorer input carries them as
 * `candidateScoring`, or `null` when the layer is not there: a checkout without a layer configures
 * nothing to score against. Only the config is read, as for the language names.
 */
export function candidateScoringValues({ root } = {}) {
  const exact = requireExactRootPath(root);
  if (inspectRoot(exact) === null) return null;
  return deepFreeze(candidateScoringFrom(loadCandidateConfig({ root: exact }).config));
}

const scoringKeys = Object.freeze(
  candidateConfigKeys.filter((key) => isScoringInputPath(key.path)),
);
const onScoringKeys = (paths) => paths.every(isScoringInputPath);

/**
 * The scoring values a scorer input carries, checked by the rules the config is: the same keys,
 * bounds, orderings and list relations, restricted to the part the input holds. Returns the deeply
 * frozen values; every disagreement throws the config's own refusal.
 */
export function validateCandidateScoring(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("candidate_config_shape_invalid", "scoring values must be a JSON object");
  }
  const checked = validateCandidateConfig(
    {
      ...JSON.parse(JSON.stringify(value)),
      [candidateSchemaVersionKey]: candidateConfigSchemaVersion,
    },
    scoringKeys,
    candidateConfigRelations.filter(({ lower, upper }) => onScoringKeys([lower, upper])),
    [],
    {
      disjoint: candidateConfigDisjoint.filter(({ one, other }) => onScoringKeys([one, other])),
      subsets: candidateConfigSubsets.filter(({ subset, superset }) =>
        onScoringKeys([subset, superset]),
      ),
    },
  );
  const { [candidateSchemaVersionKey]: _version, ...values } = checked;
  return deepFreeze(values);
}

/**
 * Every language of the layer rooted at `root`, each with what a letter in it is checked by: the
 * default language with the configured signature, then one pack per configured language. The root
 * must exist — a letter is never published without a layer.
 */
export function candidateLanguages({ root } = {}) {
  const loaded = loadCandidateConfig({ root });
  return readCandidateLanguages({ config: loaded.config, root: loaded.root });
}

/**
 * The state of the layer for a caller that must report rather than fail on absence: `absent` when
 * the directory is not there, `ready` when it is there and valid. A present but broken layer
 * still throws — reporting "checked" over a config nobody could read is the one outcome a check
 * must not have. The config is read first, the documents after it and the language packs after
 * them, so a layer broken in several places names the config. The layer manifest comes last
 * (`manifest.mjs`): a gap an earlier check already refuses keeps that check's code, and the
 * manifest adds a refusal only for what nothing else reads. `manifest` replaces the tracked one,
 * as `keys` replaces the key table.
 *
 * `languages` holds the names the layer supports, the default first. The letter samples may cover
 * only those: a sample in a language nobody configured is a sample no letter step reads.
 */
export function inspectCandidateLayer({ root, keys = candidateConfigKeys, manifest } = {}) {
  const exact = requireExactRootPath(root);
  if (inspectRoot(exact) === null) {
    return Object.freeze({
      configPath: null,
      documents: null,
      languages: null,
      root: exact,
      schemaVersion: null,
      status: "absent",
    });
  }
  const loaded = loadCandidateConfig({ keys, root: exact });
  const documents = loadCandidateDocuments({ root: exact });
  // A caller that injects its own key table has no language keys to read the packs by.
  const languages =
    keys === candidateConfigKeys
      ? Object.freeze(
          readCandidateLanguages({ config: loaded.config, root: exact }).map(
            (language) => language.name,
          ),
        )
      : null;
  const uncovered =
    languages === null || documents.letterSamples === null
      ? undefined
      : documents.letterSamples.languages.find((language) => !languages.includes(language));
  if (uncovered !== undefined) {
    fail(
      "candidate_letter_samples_invalid",
      `Covered languages names ${uncovered}, which is neither the default language nor a configured one`,
    );
  }
  const packLanguages =
    languages === null ? null : languages.filter((name) => name !== DEFAULT_LANGUAGE.name);
  checkCandidateLayerParity({
    languages: packLanguages,
    manifest: manifest ?? loadCandidateManifest(),
    root: exact,
  });
  checkCandidateLayerSections({ languages: packLanguages, root: exact });
  return Object.freeze({
    configPath: loaded.configPath,
    documents: Object.freeze({
      letterSamples: documents.letterSamples === null ? 0 : documents.letterSamples.samples.length,
      levers: documents.levers.levers.length,
      projects: documents.profile.projects.length,
      rules: documents.rules.rules.length,
    }),
    languages,
    root: loaded.root,
    schemaVersion: loaded.schemaVersion,
    status: "ready",
  });
}
