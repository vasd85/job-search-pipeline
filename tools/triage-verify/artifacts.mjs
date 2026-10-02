// Reading one batch's artifacts directory.
//
// The loader is deliberately tolerant of a defective batch and intolerant of an unreadable one.
// A missing trace, a truncated capture or a malformed JSON file is something true about the batch,
// so it is loaded as a bounded problem and reported by a check; a directory that does not exist is
// a caller error, because nothing was verified at all.
//
// Nothing here interprets a file's contents. Interpretation belongs to the checks, and keeping the
// two apart is what stops the loader from quietly repairing what it is supposed to expose.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fail } from "./errors.mjs";
import {
  triageBatchPlanFileName,
  triageBatchRecordFileName,
  triageBatchTraceFilePattern,
  triageBatchTracesDirName,
} from "../lib/triage-ledger-core.mjs";

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_INDEX = 999;

export const inputsDirName = "inputs";
export const blindDirName = "blind";
/**
 * Named from `tools/lib/triage-ledger-core.mjs`, like the record file below: its record-time guard
 * reads the same directory, and two literals are how the two layouts would drift apart.
 */
export const tracesDirName = triageBatchTracesDirName;
export const manifestFileName = "fetch-manifest.json";
/**
 * Also named from the core: its record-time guard reads the plan back from the same directory, so
 * the file this suite checks against the range and the file the ledger checks its rows against
 * are one file by construction.
 */
export const planFileName = triageBatchPlanFileName;
export const dispositionFileName = "disposition.json";
export const attestationFileName = "attestation.json";
export const reportFileName = "verification-report.json";
/**
 * The batch record `tools/lib/triage-ledger-core.mjs` writes when the batch is recorded, named
 * from that module so the two cannot drift. It is a member of this contract rather than an
 * ignored name: it appears only after verification has already passed, so no check here reads it,
 * and listing it is what stops a recorded batch's own history from being reported as an
 * unexpected artifact on the next run over the same directory.
 */
export const ledgerRecordFileName = triageBatchRecordFileName;

const PRIMARY_CAPTURE = /^(\d{3})\.capture\.txt$/u;
const PART_CAPTURE = /^(\d{3})\.([a-z0-9][a-z0-9-]{0,31})\.capture\.txt$/u;
const INPUT_FILE = /^(\d{3})\.input\.json$/u;
const TRACE_FILE = triageBatchTraceFilePattern;

function parseIndex(digits) {
  const index = Number(digits);
  if (!Number.isSafeInteger(index) || index < 1 || index > MAX_RECORD_INDEX) return null;
  return index;
}

function readTextFile(path, limit) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return { text: null, error: "file_unreadable" };
  }
  if (!stats.isFile()) return { text: null, error: "not_a_regular_file" };
  if (stats.size > limit) return { text: null, error: "file_too_large" };
  try {
    return { text: readFileSync(path, "utf8"), error: null };
  } catch {
    return { text: null, error: "file_unreadable" };
  }
}

function readJsonFile(path) {
  const { text, error } = readTextFile(path, MAX_JSON_BYTES);
  if (error !== null) return { value: null, error };
  try {
    return { value: JSON.parse(text), error: null };
  } catch {
    return { value: null, error: "json_malformed" };
  }
}

function optionalJsonFile(dir, name) {
  let stats;
  try {
    stats = statSync(join(dir, name));
  } catch {
    return { present: false, value: null, error: null };
  }
  if (!stats.isFile()) return { present: true, value: null, error: "not_a_regular_file" };
  const { value, error } = readJsonFile(join(dir, name));
  return { present: true, value, error };
}

function listDirectory(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

const OPTIONAL_FILE_NAMES = Object.freeze([
  manifestFileName,
  planFileName,
  dispositionFileName,
  attestationFileName,
  reportFileName,
  ledgerRecordFileName,
]);

/**
 * Load an artifacts directory.
 *
 * The returned shape is flat on purpose: every check reads the same record list, so a check cannot
 * accidentally verify a different subset of the batch than its neighbour.
 */
export function loadBatchArtifacts(artifactsDir) {
  if (typeof artifactsDir !== "string" || !isAbsolute(artifactsDir)) {
    fail("artifacts_path_invalid", "The artifacts directory must be given as an absolute path.");
  }
  let stats;
  try {
    stats = statSync(artifactsDir);
  } catch {
    fail("artifacts_unreadable", "The artifacts directory does not exist.");
  }
  if (!stats.isDirectory()) fail("artifacts_unreadable", "The artifacts path is not a directory.");
  const entries = listDirectory(artifactsDir);
  if (entries === null) fail("artifacts_unreadable", "The artifacts directory could not be listed.");

  const captures = [];
  const unexpected = [];
  for (const entry of entries) {
    const { name } = entry;
    if (entry.isDirectory()) {
      if (![inputsDirName, tracesDirName, blindDirName].includes(name)) unexpected.push(`${name}/`);
      continue;
    }
    if (!entry.isFile()) {
      unexpected.push(name);
      continue;
    }
    const primary = name.match(PRIMARY_CAPTURE);
    const part = primary === null ? name.match(PART_CAPTURE) : null;
    if (primary !== null || part !== null) {
      const index = parseIndex((primary ?? part)[1]);
      if (index === null) {
        unexpected.push(name);
        continue;
      }
      const { text, error } = readTextFile(join(artifactsDir, name), MAX_CAPTURE_BYTES);
      captures.push({
        index,
        file: name,
        part: part === null ? null : part[2],
        primary: primary !== null,
        text,
        error,
      });
      continue;
    }
    if (OPTIONAL_FILE_NAMES.includes(name)) continue;
    unexpected.push(name);
  }

  const inputs = new Map();
  const traces = new Map();
  const blind = new Map();
  const scan = (dirName, pattern, target) => {
    const dirEntries = listDirectory(join(artifactsDir, dirName));
    if (dirEntries === null) return;
    for (const entry of dirEntries) {
      if (!entry.isFile()) {
        unexpected.push(`${dirName}/${entry.name}`);
        continue;
      }
      const matched = entry.name.match(pattern);
      const index = matched === null ? null : parseIndex(matched[1]);
      if (index === null) {
        unexpected.push(`${dirName}/${entry.name}`);
        continue;
      }
      const { value, error } = readJsonFile(join(artifactsDir, dirName, entry.name));
      target.set(index, { file: `${dirName}/${entry.name}`, value, error });
    }
  };
  scan(inputsDirName, INPUT_FILE, inputs);
  scan(tracesDirName, TRACE_FILE, traces);
  scan(blindDirName, INPUT_FILE, blind);

  const indices = [...new Set([
    ...captures.map((capture) => capture.index),
    ...inputs.keys(),
    ...traces.keys(),
  ])].sort((left, right) => left - right);

  return {
    blind,
    dir: artifactsDir,
    indices,
    captures: captures.sort((left, right) =>
      left.index - right.index || left.file.localeCompare(right.file)),
    inputs,
    traces,
    manifest: optionalJsonFile(artifactsDir, manifestFileName),
    plan: optionalJsonFile(artifactsDir, planFileName),
    disposition: optionalJsonFile(artifactsDir, dispositionFileName),
    attestation: optionalJsonFile(artifactsDir, attestationFileName),
    unexpected: unexpected.sort(),
  };
}
