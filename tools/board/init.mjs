#!/usr/bin/env node

/**
 * Create the private repository inside an engine clone and fill it from the old repository.
 *
 * One run, on the day of the switch. What moves is decided by the export-exclusion list of the
 * source commit — everything the public export leaves behind — and where it lands is decided by
 * `LAYOUT` below. An excluded path no row places is a refusal naming it, so a path added to the
 * list later cannot stay behind unnoticed: nothing private exists in the new public repository,
 * so a file this run does not carry is a file lost.
 *
 * The run writes only into `<engine>/candidate/`, which must be ignored by the engine and empty.
 * The source is read through git at a named commit, never from its working tree, so an
 * uncommitted edit there cannot leak into the private history or be silently dropped from it.
 *
 * This is a transition tool. After the switch the old paths it names no longer exist anywhere,
 * and the task that removes the old flow's tools removes it too.
 */

import { mkdirSync, mkdtempSync, readdirSync, lstatSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ExportExclusionsError, isExcluded, loadExportExclusions, EXPORT_EXCLUSIONS_FILE } from "../export-exclusions.mjs";
import { BoardError, PRIVATE_DIRECTORY_NAME, mustGit, runGit, samePath } from "./git.mjs";

const toolRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Where each excluded path of the old repository lands in the private one; the first row whose
 * `from` covers the path wins. A `from` ending in a slash is a directory and keeps the rest of the
 * path; one without is a single file.
 */
export const LAYOUT = Object.freeze([
  Object.freeze({ from: "config/section-link-source-exceptions.json", to: "archive/pre-switch/section-link-source-exceptions.json" }),
  Object.freeze({ from: "docs/backlog/README.md", to: "archive/pre-switch/backlog-README.md" }),
  Object.freeze({ from: "docs/runbooks/development-gitflow.md", to: "archive/pre-switch/development-gitflow.md" }),
  Object.freeze({ from: "tests/legacy-governance.test.mjs", to: "archive/pre-switch/legacy-governance.test.mjs" }),
  Object.freeze({ from: "config/source-layout.json", to: "archive/pre-switch/source-layout.json" }),
  Object.freeze({ from: "docs/archive/backlog/", to: "board/done/" }),
  Object.freeze({ from: "docs/backlog/", to: "board/" }),
  Object.freeze({ from: "docs/archive/", to: "archive/" }),
  Object.freeze({ from: "docs/adr/", to: "decisions/" }),
  Object.freeze({ from: "docs/product-decisions.md", to: "decisions/product-decisions.md" }),
  Object.freeze({ from: "docs/audits/", to: "research/audits/" }),
  Object.freeze({ from: "docs/research/", to: "research/" }),
  Object.freeze({ from: "reference/", to: "research/reference/" }),
]);

/** Files this run writes itself; a moved or copied file landing on one is a collision. */
export const GENERATED_FILES = Object.freeze({
  ".gitignore": ".DS_Store\n",
  "board/README.md": null,
});

export const BOARD_README_TEMPLATE = join(toolRoot, "board-readme.md");

export const USAGE = "use --source <absolute path> [--rev <commit>] --engine <absolute path>"
  + " [--layer <absolute path>] [--remote <url>]";

function fail(code, message) {
  throw new BoardError(code, message);
}

/** The private path of one excluded path, or null when no row places it. */
export function placeOf(path) {
  for (const row of LAYOUT) {
    if (row.from.endsWith("/")) {
      if (path.startsWith(row.from)) return row.to + path.slice(row.from.length);
    } else if (path === row.from) {
      return row.to;
    }
  }
  return null;
}

export function parseArguments(argv) {
  const parsed = { engine: null, layer: null, remote: null, rev: "HEAD", source: null };
  const flags = { "--engine": "engine", "--layer": "layer", "--remote": "remote", "--rev": "rev", "--source": "source" };
  for (let index = 0; index < argv.length; index += 2) {
    const key = flags[argv[index]];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || value.startsWith("--")) fail("board_invalid_arguments", USAGE);
    parsed[key] = value;
  }
  if (parsed.source === null || parsed.engine === null) fail("board_invalid_arguments", USAGE);
  for (const key of ["engine", "layer", "source"]) {
    if (parsed[key] !== null && !isAbsolute(parsed[key])) {
      fail("board_invalid_arguments", `--${key} must be an absolute path.`);
    }
  }
  return parsed;
}

/** The list of the source commit, read by the list's own reader from a temporary root. */
function exclusionsAt(source, commit) {
  const text = runGit(source, ["show", `${commit}:${EXPORT_EXCLUSIONS_FILE}`]);
  if (text.status !== 0) {
    fail("board_init_exclusions_unreadable", `${EXPORT_EXCLUSIONS_FILE} is not in ${commit}.`);
  }
  const root = mkdtempSync(join(tmpdir(), "board-init-exclusions-"));
  try {
    mkdirSync(join(root, dirname(EXPORT_EXCLUSIONS_FILE)), { recursive: true });
    writeFileSync(join(root, EXPORT_EXCLUSIONS_FILE), text.stdout);
    return loadExportExclusions({ root });
  } catch (error) {
    if (error instanceof ExportExclusionsError) {
      fail("board_init_exclusions_unreadable", `${error.code}: ${error.message}`);
    }
    throw error;
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

/** Every tracked entry of the commit: mode, object and path. */
function treeEntries(source, commit) {
  const out = mustGit(source, ["-c", "core.quotePath=false", "ls-tree", "-r", "-z", "--full-tree", commit], {
    failCode: "board_init_source_unreadable",
  });
  return out.split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    const [mode, , object] = line.slice(0, tab).split(" ");
    return { mode, object, path: line.slice(tab + 1) };
  });
}

/** Files of the layer directory, relative, refusing anything that is not a plain file. */
function layerFiles(layer) {
  const files = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const stat = lstatSync(absolute);
      const path = relative(layer, absolute).split(sep).join("/");
      if (stat.isSymbolicLink()) fail("board_init_unsupported_entry", `${path} in the layer is a symbolic link.`);
      if (stat.isDirectory()) {
        if (name === ".git") fail("board_init_unsupported_entry", `the layer is already a repository (${path}).`);
        walk(absolute);
      } else if (stat.isFile()) {
        files.push(path);
      } else {
        fail("board_init_unsupported_entry", `${path} in the layer is not a file.`);
      }
    }
  };
  walk(layer);
  return files;
}

/** Porcelain status as a sorted list, so a before and an after compare as values. */
function engineStatus(engine) {
  const out = mustGit(engine, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no"], {
    failCode: "board_init_git_failed",
  });
  return out.split("\0").filter(Boolean).sort();
}

export function initBoard({ engine, layer = null, remote = null, rev = "HEAD", source }) {
  // Everything that can refuse is checked before the first write.
  const top = runGit(engine, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || !samePath(top.stdout.trim(), engine)) {
    fail("board_init_engine_not_a_checkout", `${engine} is not the root of a git checkout.`);
  }
  if (runGit(engine, ["check-ignore", "-q", `${PRIVATE_DIRECTORY_NAME}/`]).status !== 0) {
    fail("board_init_layer_not_ignored", `${PRIVATE_DIRECTORY_NAME}/ is not ignored by the engine checkout.`);
  }
  const target = join(engine, PRIVATE_DIRECTORY_NAME);
  let existed = false;
  try {
    const stat = lstatSync(target);
    if (!stat.isDirectory() || readdirSync(target).length > 0) {
      fail("board_init_target_not_empty", `${PRIVATE_DIRECTORY_NAME}/ already exists and is not an empty directory.`);
    }
    existed = true;
  } catch (error) {
    if (error instanceof BoardError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }

  const commit = runGit(source, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  if (commit.status !== 0) fail("board_init_source_unreadable", `${rev} is not a commit of ${source}.`);
  const sha = commit.stdout.trim();
  const exclusions = exclusionsAt(source, sha);

  const moves = [];
  const placed = new Map();
  for (const path of Object.keys(GENERATED_FILES)) placed.set(path, "written by this run");
  for (const entry of treeEntries(source, sha)) {
    if (!isExcluded(entry.path, exclusions)) continue;
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      fail("board_init_unsupported_entry", `${entry.path} is not a regular file (mode ${entry.mode}).`);
    }
    const to = placeOf(entry.path);
    if (to === null) fail("board_init_unmapped_path", `${entry.path} is excluded from the export and has no place.`);
    if (placed.has(to)) fail("board_init_path_collision", `${to}: ${entry.path} and ${placed.get(to)}.`);
    placed.set(to, entry.path);
    moves.push({ ...entry, to });
  }
  const copies = layer === null ? [] : layerFiles(layer);
  for (const path of copies) {
    if (placed.has(path)) fail("board_init_path_collision", `${path}: the layer and ${placed.get(path)}.`);
    placed.set(path, "the layer");
  }

  const before = engineStatus(engine);
  let committed = false;
  try {
    mkdirSync(target, { recursive: true });
    for (const move of moves) {
      const bytes = mustGit(source, ["cat-file", "blob", move.object], { binary: true, failCode: "board_init_source_unreadable" });
      mkdirSync(dirname(join(target, move.to)), { recursive: true });
      writeFileSync(join(target, move.to), bytes, { mode: move.mode === "100755" ? 0o755 : 0o644 });
    }
    for (const path of copies) {
      mkdirSync(dirname(join(target, path)), { recursive: true });
      copyFileSync(join(layer, path), join(target, path));
    }
    mkdirSync(join(target, "board", "done"), { recursive: true });
    writeFileSync(join(target, ".gitignore"), GENERATED_FILES[".gitignore"]);
    writeFileSync(join(target, "board", "README.md"), readFileSync(BOARD_README_TEMPLATE));

    mustGit(target, ["init", "--quiet", "-b", "main"], { failCode: "board_init_git_failed" });
    mustGit(target, ["add", "-A"], { failCode: "board_init_git_failed" });
    mustGit(target, ["commit", "--quiet", "-m", `Initial import of the board, decisions and research\n\nSource commit: ${sha}`], {
      failCode: "board_init_git_failed",
    });
    committed = true;
  } finally {
    // A half-written directory is worse than none: the next run would refuse it as not empty.
    if (!committed) {
      rmSync(target, { force: true, recursive: true });
      if (existed) mkdirSync(target);
    }
  }

  const after = engineStatus(engine);
  if (JSON.stringify(before) !== JSON.stringify(after)
    || after.some((line) => line.slice(3).startsWith(`${PRIVATE_DIRECTORY_NAME}/`))) {
    fail("board_init_engine_sees_layer", "the engine's status changed when the private repository appeared.");
  }

  let pushed = false;
  if (remote !== null) {
    mustGit(target, ["remote", "add", "origin", remote], { failCode: "board_init_push_failed" });
    mustGit(target, ["push", "--quiet", "-u", "origin", "main"], { failCode: "board_init_push_failed" });
    pushed = true;
  }

  const counts = {};
  for (const path of placed.keys()) {
    const top = path.includes("/") ? path.slice(0, path.indexOf("/")) : path;
    counts[top] = (counts[top] ?? 0) + 1;
  }
  return {
    commit: mustGit(target, ["rev-parse", "HEAD"]).trim(),
    files: Object.fromEntries(Object.entries(counts).sort()),
    pushed,
    root: target,
    source_commit: sha,
    status: "created",
  };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const result = initBoard(parseArguments(argv));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const known = error instanceof BoardError;
    process.stderr.write(`${JSON.stringify({
      error: {
        code: known ? error.code : "board_failed",
        message: known ? error.message : `the command failed unexpectedly: ${error?.message ?? error}`,
      },
      status: "error",
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
