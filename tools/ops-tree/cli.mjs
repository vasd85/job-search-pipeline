#!/usr/bin/env node

/**
 * ops-tree — the shell-facing entry point of the operational-folder tool.
 *
 * `export` builds a folder at the root it is given; every other command acts on the folder this
 * file lies in. The one place that rule bends is recovery: a copy of the tool kept under
 * `<folder>/.ops-tree/previous/<stamp>/` or `.ops-tree/staging/<stamp>/` may run `rollback` on
 * `<folder>`, and only while `<folder>`'s swap journal names that same stamp — the case where the
 * folder has no `tools/` of its own left to run. `tools/ops-tree/README.md` owns the commands and
 * codes.
 */

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { OpsTreeError, verifyFolder, compareFiles, digestTree, readManifest } from "./manifest.mjs";
import { cutoverFolder, exportFolder, rollbackFolder } from "./tree.mjs";

const codeRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const COPY_PATTERN = /^(.*)\/\.ops-tree\/(?:previous|staging)\/(\d{8}T\d{6}\.\d{3}Z)$/;

const BOOLEAN_FLAGS = new Set(["dry-run", "help"]);
const COMMAND_FLAGS = Object.freeze({
  cutover: ["release", "candidate", "engine-repo", "candidate-repo", "input-file", "dry-run"],
  export: ["release", "candidate", "engine-repo", "candidate-repo", "root", "kind"],
  rollback: ["to", "input-file"],
  verify: [],
});

function usage() {
  process.stdout.write(`ops-tree — the operational folder: two tags, a manifest, a checked swap

Usage:
  node tools/ops-tree/cli.mjs export --release <release-YYYYMMDD[.N]> --candidate <candidate-YYYYMMDD[.N]> \\
    --engine-repo <absolute path> --candidate-repo <absolute path> --root <absolute path> [--kind operational|rehearsal]
  node tools/ops-tree/cli.mjs cutover --release <tag> --candidate <tag> [--engine-repo <path>] \\
    [--candidate-repo <path>] [--input-file input-<32 hex>.json] [--dry-run]
  node tools/ops-tree/cli.mjs rollback [--to <stamp>] [--input-file input-<32 hex>.json]
  node tools/ops-tree/cli.mjs verify

cutover, rollback and verify act on the folder this file lies in. The override reason of a gate is
passed only through --input-file (instructions/pipeline-artifacts.md transport).
`);
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length;) {
    const flag = rest[index];
    if (!flag?.startsWith("--"))
      fail("ops_tree_invalid_arguments", `unexpected argument near ${flag}`);
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) fail("ops_tree_invalid_arguments", `duplicate --${key}`);
    if (BOOLEAN_FLAGS.has(key)) {
      options[key] = true;
      index += 1;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--"))
      fail("ops_tree_invalid_arguments", `--${key} takes a value`);
    options[key] = value;
    index += 2;
  }
  return { command, options };
}

function fail(code, message) {
  throw new OpsTreeError(code, message);
}

function allow(command, options) {
  for (const key of Object.keys(options)) {
    if (!COMMAND_FLAGS[command].includes(key))
      fail("ops_tree_invalid_arguments", `${command} does not take --${key}`);
  }
}

/** Where this copy of the tool may act: its own tree, or the folder it is a recovery copy of. */
function actingRoot(command) {
  const match = COPY_PATTERN.exec(codeRoot);
  if (match === null) return { root: codeRoot };
  if (command !== "rollback") {
    fail(
      "ops_tree_recovery_refused",
      "this copy lies inside a folder's .ops-tree/; from here only rollback of an interrupted swap runs",
    );
  }
  return { expectedStamp: match[2], root: match[1] };
}

function verify() {
  const manifest = readManifest(codeRoot);
  if (manifest === null) return { status: "not_operational", root: codeRoot };
  const drift = compareFiles(manifest.files, digestTree(codeRoot, manifest.zones));
  const result = verifyFolderSafely();
  return { ...result, drift };
}

function verifyFolderSafely() {
  try {
    const { status, manifest } = verifyFolder(codeRoot);
    return {
      status,
      release: manifest.engine.tag,
      candidate: manifest.candidate.tag,
      kind: manifest.kind,
    };
  } catch (error) {
    if (!(error instanceof OpsTreeError)) throw error;
    return { status: "refused", code: error.code, message: error.message };
  }
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { command, options } = parse(argv);
    if (command === undefined || command === "help" || command === "--help" || options.help) {
      usage();
      return;
    }
    if (!Object.hasOwn(COMMAND_FLAGS, command))
      fail("ops_tree_invalid_arguments", `unknown command: ${command}`);
    allow(command, options);
    let result;
    if (command === "export") {
      result = exportFolder({
        candidate: options.candidate,
        candidateRepo: options["candidate-repo"],
        engineRepo: options["engine-repo"],
        kind: options.kind,
        release: options.release,
        root: options.root,
      });
    } else if (command === "verify") {
      actingRoot(command);
      result = verify();
      if (result.status === "refused") process.exitCode = 1;
    } else if (command === "cutover") {
      const { root } = actingRoot(command);
      result = cutoverFolder({
        candidate: options.candidate,
        candidateRepo: options["candidate-repo"],
        dryRun: options["dry-run"] === true,
        engineRepo: options["engine-repo"],
        inputFile: options["input-file"],
        release: options.release,
        root,
      });
    } else {
      const { expectedStamp, root } = actingRoot(command);
      result = rollbackFolder({
        expectedStamp,
        inputFile: options["input-file"],
        root,
        to: options.to,
      });
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const known = error instanceof OpsTreeError || typeof error?.code === "string";
    process.stderr.write(
      `${JSON.stringify(
        {
          status: "error",
          error: {
            code:
              known && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : "ops_tree_failed",
            message: known ? error.message : "ops-tree failed unexpectedly",
            ...(error?.details ? { details: error.details } : {}),
          },
        },
        null,
        2,
      )}\n`,
    );
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
