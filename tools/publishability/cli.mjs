#!/usr/bin/env node

/**
 * Is this tree ready to be published, and by how much is it not.
 *
 * Report mode is the default and prints counts without refusing findings. `--blocking` adds a
 * verdict, and the aggregate gate uses that verdict for every tracked public path.
 *
 * The candidate root is an explicit argument with no default. A reader that resolved the layer by
 * itself would read the operator's real candidate from a check, which is the rule
 * `tools/candidate/load.mjs` already carries. The consequence is stated in the report rather than
 * hidden: with no root, the personal markers are not loaded and the class is empty because nothing
 * was looked for, not because nothing is there.
 *
 * The file list comes from `git ls-files -z`, spawned with an argv array, no shell, and the
 * environment this repository's runner scrubs. Every tracked path of the public repository is scanned.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { childEnvironment } from "../ci.mjs";
import {
  PUBLIC_ALLOWANCES,
  PUBLIC_MARKERS,
  PUBLIC_TEXT_ALLOWANCES,
  PublishabilityError,
  loadCandidateMarkers,
} from "./markers.mjs";
import { scanText, scanTree } from "./scan.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The tree this run scans. `JOB_PIPELINE_WORKSPACE_ROOT` is honoured the way `tools/candidate`
 * honours it, so the suite can drive the shipped entry point against a disposable tree. It cannot
 * redirect the gate: the runner scrubs every `JOB_PIPELINE_` name out of a stage's child.
 */
export function defaultRoot(environment = process.env) {
  return resolve(environment.JOB_PIPELINE_WORKSPACE_ROOT ?? repoRoot);
}

/** How many files the roll-up prints before it says how many it left out. */
export const REPORTED_FILE_LIMIT = 20;

const MAX_MESSAGE_BYTES = 1024 * 1024;

class PublishabilityCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PublishabilityCliError";
    this.code = code;
  }
}

function invalid(message) {
  throw new PublishabilityCliError("invalid_publishability_arguments", message);
}

export const USAGE = "use [--blocking] [--list] [--candidate-root <absolute path>]"
  + " [--data-root <absolute path>] [--commit-msg <path>]";

export function parseArguments(argv) {
  const parsed = { blocking: false, candidateRoot: null, dataRoot: null, commitMessage: null, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--blocking") {
      parsed.blocking = true;
    } else if (argument === "--list") {
      parsed.list = true;
    } else if (argument === "--candidate-root" || argument === "--data-root" || argument === "--commit-msg") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) invalid(USAGE);
      if (argument === "--candidate-root" || argument === "--data-root") {
        if (!isAbsolute(value) || value !== resolve(value)) {
          invalid(`${argument} must be an absolute normalized path`);
        }
        if (argument === "--candidate-root") parsed.candidateRoot = value;
        else parsed.dataRoot = value;
      } else {
        parsed.commitMessage = value;
      }
      index += 1;
    } else {
      invalid(USAGE);
    }
  }
  if (parsed.candidateRoot !== null && parsed.dataRoot !== null) invalid("Use either personal markers or data-only allowances, never both roots.");
  if (parsed.dataRoot !== null && parsed.commitMessage !== null) invalid("Data-only allowances are for tree scans only.");
  return parsed;
}

/**
 * Every tracked path, from git and nothing else.
 *
 * One state this does not special-case: during an unfinished merge `git ls-files` prints an
 * unmerged path once per stage, so such a file would be read and counted more than once. The three
 * counters still account for exactly what git printed, and a tree mid-conflict is not a tree
 * anyone is publishing from.
 */
export function trackedPaths({ root, spawn = spawnSync }) {
  const result = spawn("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    env: childEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new PublishabilityError(
      "publishability_tracked_paths_unavailable",
      `git ls-files failed (${result.error?.code ?? `exit ${result.status}`}).`,
    );
  }
  // Built rather than written, so this file carries no raw NUL of its own.
  return String(result.stdout ?? "").split(String.fromCharCode(0)).filter(Boolean);
}

/**
 * The markers, allowances and data paths of one run, and where they came from.
 *
 * `personalSource` is null when no candidate root was given, and the report prints that instead of
 * a zero: a count of what was never searched for is not a count.
 */
export function assembleContract({ candidateRoot, dataRoot = null }) {
  if (candidateRoot === null) {
    const data = dataRoot === null ? null : loadCandidateMarkers({ root: dataRoot });
    return {
      allow: PUBLIC_ALLOWANCES,
      cyrillicData: data?.cyrillicData ?? [],
      dataAllowancesLoaded: data !== null,
      markers: PUBLIC_MARKERS,
      personalCount: null,
      personalSource: null,
    };
  }
  const layer = loadCandidateMarkers({ root: candidateRoot });
  return {
    allow: [...PUBLIC_ALLOWANCES, ...layer.allow],
    cyrillicData: layer.cyrillicData,
    dataAllowancesLoaded: true,
    markers: [...PUBLIC_MARKERS, ...layer.markers],
    personalCount: layer.markers.length,
    personalSource: candidateRoot,
  };
}

function treeReport({ candidateRoot, dataRoot, list, root, spawn }) {
  const contract = assembleContract({ candidateRoot, dataRoot });
  const paths = trackedPaths({ root, spawn });
  const scan = scanTree({
    allow: contract.allow,
    cyrillicData: contract.cyrillicData,
    markers: contract.markers,
    paths,
    root,
  });
  const exportedFiles = scan.files.filter((entry) => entry.exported);
  return {
    // Counted and printed, not swallowed. A checkout that lists paths git knows and has no files
    // on disk — a sparse checkout, a half-applied change — would otherwise report zero findings
    // over zero files and read exactly like a clean tree.
    absent: scan.absent.length,
    by_class: scan.byClass,
    by_marker: scan.byMarker,
    data_allowances: contract.dataAllowancesLoaded ? contract.cyrillicData.length : null,
    files: exportedFiles.slice(0, REPORTED_FILE_LIMIT),
    files_omitted: Math.max(0, exportedFiles.length - REPORTED_FILE_LIMIT),
    files_with_findings: exportedFiles.length,
    markers: {
      personal: contract.personalCount,
      personal_source: contract.personalSource,
      public: PUBLIC_MARKERS.length,
    },
    mode: "tree",
    places: scan.places,
    places_exported: scan.placesExported,
    scanned: scan.scanned,
    // Stepped over before reading, so counted neither as absent nor as scanned; printed so the
    // three numbers add up to the paths git listed.
    skipped: scan.skipped,
    ...(list ? { findings: scan.findings.filter((entry) => entry.exported) } : {}),
  };
}

function messageReport({ candidateRoot, commitMessage, list, root }) {
  const contract = assembleContract({ candidateRoot });
  const file = resolve(root, commitMessage);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new PublishabilityError(
      "publishability_message_unreadable",
      `${commitMessage}: ${error?.message ?? error}`,
    );
  }
  if (text.length > MAX_MESSAGE_BYTES) {
    throw new PublishabilityError("publishability_message_unreadable", `${commitMessage}: too large.`);
  }
  const scan = scanText({
    markers: contract.markers,
    text,
    textAllow: PUBLIC_TEXT_ALLOWANCES,
  });
  return {
    by_class: scan.byClass,
    by_marker: scan.byMarker,
    markers: {
      personal: contract.personalCount,
      personal_source: contract.personalSource,
      public: PUBLIC_MARKERS.length,
    },
    mode: "commit-message",
    // Lines carrying at least one match, the same meaning the tree scan gives this field: the
    // second consumer of the text scan reads it, and one name must not mean two things.
    places: scan.places,
    // A commit message has no area: every line of it reaches the history as written.
    places_exported: scan.places,
    ...(list ? { findings: scan.findings } : {}),
  };
}

export function run({ argv, root = repoRoot, spawn = spawnSync }) {
  const parsed = parseArguments(argv);
  const report = parsed.commitMessage === null
    ? treeReport({ ...parsed, root, spawn })
    : messageReport({ ...parsed, root });
  return { parsed, report };
}

export function main(argv = process.argv.slice(2), { root = defaultRoot(), spawn = spawnSync } = {}) {
  try {
    const { parsed, report } = run({ argv, root, spawn });
    // The verdict keys on the exported part alone. A finding in a file the export leaves behind
    // is worth reporting and must never refuse a commit.
    const blocked = parsed.blocking && (report.places_exported > 0 || (report.absent ?? 0) > 0);
    process.stdout.write(`${JSON.stringify({
      ...report,
      status: blocked ? "findings" : "reported",
    })}\n`);
    if (blocked) process.exitCode = 1;
  } catch (error) {
    const known = error instanceof PublishabilityCliError || error instanceof PublishabilityError;
    process.stderr.write(`${JSON.stringify({
      error: {
        code: known ? error.code : "publishability_failed",
        message: known ? error.message : "the publishability scan failed unexpectedly",
      },
      status: "error",
    })}\n`);
    process.exitCode = 1;
  }
}

function isDirectInvocation() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  }
}

if (isDirectInvocation()) main();
