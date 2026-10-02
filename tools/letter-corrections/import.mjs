#!/usr/bin/env node

/**
 * Copy the letter-correction records a run wrote into the private repository.
 *
 * A run keeps its corpus in `records/letter-corrections/` of its own root, beside the process log:
 * a run artifact, copied by the daily backup and never deleted by this command. The private
 * repository keeps the versioned copy in `research/letter-corrections/`. This command, run in a
 * development clone, adds to that copy every record it does not hold yet and commits exactly those
 * files (ADR 0024, decision 6).
 *
 * A record is identified by its `record_id`, which is also its file name. A record the copy
 * already holds with the same bytes is skipped. One it holds with other bytes is kept as the copy
 * has it and reported: the `teach` mark is set in the private repository, so there the copy is
 * newer than the run's, never older.
 *
 * Nothing is written before both sides have been read and validated, so a broken record — on
 * either side — refuses the whole import with the file named. Each file lands through a temporary
 * sibling and a rename, so an interrupted run leaves whole files or none; a repeated run commits
 * what an interrupted one copied and did not commit.
 *
 * The private clone is shared by every development session on the machine, so the command commits
 * with an explicit path list and `--only`, and never touches what another session staged. With an
 * upstream it pulls `--ff-only` first and pushes after; a refused push takes its own commit back.
 * An import commit an earlier run left ahead of the upstream — its take-back failed, or it was
 * interrupted before the push — is pushed before the import when nothing else is ahead, and named
 * in `unpushed` when another session's commit is: that session's own push carries it.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BoardError, lastLines, mustGit, privateRootFor, runGit, samePath } from "../board/git.mjs";
import { CandidateError, candidateLanguageNames } from "../candidate/load.mjs";
import { MANIFEST_FILE_NAME } from "../ops-tree/manifest.mjs";
import {
  LAYER_CORPUS_DIRECTORY,
  LetterCorrectionError,
  RECORDS_DIRECTORY,
  RUN_CORPUS_DIRECTORY,
  isRunRoot,
  readCorpusEntries,
} from "./corpus.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every refusal of this command beyond the corpus codes it shares; the README names the same set. */
export const IMPORT_ERROR_CODES = Object.freeze([
  "records_import_failed",
  "records_import_git_failed",
  "records_import_invalid_arguments",
  "records_import_needs_repair",
  "records_import_pull_refused",
  "records_import_push_refused",
  "records_import_rehearsal_root",
  "records_import_root_not_a_clone",
]);

export const USAGE = "use --ops-root <absolute path> [--candidate-root <absolute path>]";

const TARGET_RECORDS = `${LAYER_CORPUS_DIRECTORY}/${RECORDS_DIRECTORY}`;
const GIT_FAILED = "records_import_git_failed";

function fail(code, message) {
  throw new LetterCorrectionError(code, message);
}

export function parseArguments(argv) {
  const parsed = { candidateRoot: null, opsRoot: null };
  const flags = { "--candidate-root": "candidateRoot", "--ops-root": "opsRoot" };
  for (let index = 0; index < argv.length; index += 2) {
    const key = flags[argv[index]];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || value.startsWith("--") || parsed[key] !== null) {
      fail("records_import_invalid_arguments", USAGE);
    }
    parsed[key] = value;
  }
  if (parsed.opsRoot === null) fail("records_import_invalid_arguments", USAGE);
  for (const key of ["candidateRoot", "opsRoot"]) {
    if (parsed[key] !== null && !isAbsolute(parsed[key])) {
      fail("records_import_invalid_arguments", `${key} must be an absolute path.`);
    }
  }
  return parsed;
}

/**
 * A rehearsal folder is a run too, but not production: its letters die with it, and a record of
 * one entering the real corpus would count a correction nobody sent. It is refused by either
 * mark — the rehearsal directory of a rehearsal worktree, or the manifest of a sealed folder. A
 * manifest that cannot be read cannot say which it is, so it refuses as well.
 */
function assertNotRehearsal(opsRoot) {
  if (existsSync(join(opsRoot, ".rehearsal"))) {
    fail("records_import_rehearsal_root", "--ops-root is a rehearsal worktree; its records are not imported.");
  }
  const manifest = join(opsRoot, MANIFEST_FILE_NAME);
  if (!existsSync(manifest)) return;
  let kind;
  try {
    kind = JSON.parse(readFileSync(manifest, "utf8"))?.kind;
  } catch {
    fail("records_import_rehearsal_root", `${MANIFEST_FILE_NAME} of --ops-root is unreadable, so whether it is a rehearsal folder is unknown.`);
  }
  if (kind === "rehearsal") {
    fail("records_import_rehearsal_root", "--ops-root is a rehearsal folder; its records are not imported.");
  }
}

function upstreamOf(root) {
  const branch = runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { failCode: GIT_FAILED });
  if (branch.status !== 0) return null;
  const name = branch.stdout.trim();
  const out = mustGit(root, [
    "for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)", `refs/heads/${name}`,
  ], { failCode: GIT_FAILED }).trim();
  const [remote, ref, tracking] = out.split("\0");
  return remote && ref && tracking ? { ref, remote, tracking } : null;
}

/**
 * Whether a commit is an import commit: it adds record files and changes nothing else. The import
 * only ever adds files, so a commit that modifies a record — a `teach` mark, say — is someone
 * else's work, and so is a merge, which lists no paths here.
 */
function isImportCommit(root, commit) {
  const fields = mustGit(root, ["diff-tree", "--no-commit-id", "--no-renames", "-r", "-z", "--name-status", commit], {
    failCode: GIT_FAILED,
  }).split("\0").filter(Boolean);
  if (fields.length === 0) return false;
  for (let index = 0; index < fields.length; index += 2) {
    if (fields[index] !== "A" || !fields[index + 1]?.startsWith(`${TARGET_RECORDS}/`)) return false;
  }
  return true;
}

/** The commits of the branch its upstream does not hold, oldest first. */
function aheadOf(root, upstream) {
  return mustGit(root, ["rev-list", "--reverse", `${upstream.tracking}..HEAD`], { failCode: GIT_FAILED })
    .split("\n")
    .filter(Boolean)
    .map((sha) => ({ imported: isImportCommit(root, sha), sha }));
}

function importCommitsAhead(root, upstream) {
  return aheadOf(root, upstream).filter((commit) => commit.imported).map((commit) => commit.sha);
}

function pull(root, upstream) {
  const result = runGit(root, ["pull", "--quiet", "--ff-only"], { failCode: GIT_FAILED });
  if (result.status === 0) return;
  let stranded = [];
  try {
    stranded = importCommitsAhead(root, upstream);
  } catch {
    // Naming them is a courtesy of the refusal; a missing upstream branch has nothing to name.
  }
  const named = stranded.length > 0 ? `; import commits not on the upstream: ${stranded.join(", ")}` : "";
  fail("records_import_pull_refused", `git pull --ff-only refused: ${lastLines(result.stderr)}${named}`);
}

/**
 * Push the import commits an earlier run left ahead of the upstream, when nothing else is ahead.
 * The checked tip is pushed, not HEAD, so a commit made in between is not pushed unchecked. A
 * refusal takes nothing back: the commits are not this run's, and their files are records.
 */
function pushStranded(root, upstream) {
  const ahead = aheadOf(root, upstream);
  if (ahead.length === 0 || !ahead.every((commit) => commit.imported)) return false;
  const result = runGit(root, ["push", "--quiet", upstream.remote, `${ahead.at(-1).sha}:${upstream.ref}`], {
    failCode: GIT_FAILED,
  });
  if (result.status !== 0) {
    fail("records_import_push_refused", `the import commits ${ahead.map((commit) => commit.sha).join(", ")} are ahead of the upstream and their push was refused (${lastLines(result.stderr, 2)}); nothing was taken back. Run the import again.`);
  }
  return true;
}

/** Paths under the target records directory that the last commit holds; none without a commit. */
function committedPaths(root) {
  if (runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"], { failCode: GIT_FAILED }).status !== 0) {
    return new Set();
  }
  const out = mustGit(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", `${TARGET_RECORDS}/`], {
    failCode: GIT_FAILED,
  });
  return new Set(out.split("\0").filter(Boolean));
}

function readSide(directory, languages) {
  if (!existsSync(join(directory, RECORDS_DIRECTORY))) return [];
  return readCorpusEntries(directory, { languages });
}

/**
 * Whole or nothing: a reader of the directory never sees half a record. The temporary name is
 * random, so a file a killed run left behind never stands in the next run's way; one this run
 * created and could not finish is removed.
 */
function place(directory, name, bytes) {
  const temporary = join(directory, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    renameSync(temporary, join(directory, name));
  } catch (error) {
    if (error?.code !== "EEXIST") rmSync(temporary, { force: true });
    throw error;
  }
}

function withPaths(root, args, paths) {
  return mustGit(root, [...args, "--pathspec-from-file=-", "--pathspec-file-nul"], {
    failCode: GIT_FAILED,
    input: `${paths.join("\0")}\0`,
  });
}

export function importRecords({ candidateRoot = null, opsRoot }) {
  const source = resolve(opsRoot);
  if (!isRunRoot(source)) {
    fail("corpus_no_run_root", "--ops-root holds no process-log.json, so it is not a run root.");
  }
  assertNotRehearsal(source);

  const root = resolve(candidateRoot ?? privateRootFor(repoRoot));
  const top = runGit(root, ["rev-parse", "--show-toplevel"], { failCode: GIT_FAILED });
  if (top.status !== 0 || !samePath(top.stdout.trim(), root)) {
    fail("records_import_root_not_a_clone", `${root} is not the root of the private repository's clone; pass --candidate-root.`);
  }

  const languages = candidateLanguageNames({ root });
  const incoming = readSide(join(source, RUN_CORPUS_DIRECTORY), languages);
  if (incoming.length === 0) {
    return { committed: 0, imported: 0, source_records: 0, status: "nothing_to_import" };
  }

  const upstream = upstreamOf(root);
  let pushed = null;
  if (upstream !== null) {
    mustGit(root, ["fetch", "--quiet", upstream.remote], { failCode: GIT_FAILED });
    pull(root, upstream);
    if (pushStranded(root, upstream)) pushed = true;
  }

  const targetDirectory = join(root, LAYER_CORPUS_DIRECTORY);
  const present = new Map(readSide(targetDirectory, languages).map((entry) => [entry.name, entry.bytes]));
  const recordsDirectory = join(targetDirectory, RECORDS_DIRECTORY);
  const imported = [];
  const alreadyPresent = [];
  const keptDiffering = [];
  for (const entry of incoming) {
    const held = present.get(entry.name);
    if (held === undefined) {
      // A first import creates the corpus directory together with its records directory.
      mkdirSync(recordsDirectory, { recursive: true });
      place(recordsDirectory, entry.name, entry.bytes);
      imported.push(entry.name);
    } else if (held.equals(entry.bytes)) {
      alreadyPresent.push(entry.name);
    } else {
      keptDiffering.push(entry.record.record_id);
    }
  }

  // What this run copied, and what an interrupted run copied and never committed.
  const committed = committedPaths(root);
  const toCommit = [...imported, ...alreadyPresent]
    .map((name) => `${TARGET_RECORDS}/${name}`)
    .filter((path) => !committed.has(path))
    .sort();

  let commit = null;
  if (toCommit.length > 0) {
    withPaths(root, ["add"], toCommit);
    withPaths(root, ["commit", "--quiet", "--only", "-m", `research: import ${toCommit.length} letter-correction records`], toCommit);
    commit = mustGit(root, ["rev-parse", "HEAD"], { failCode: GIT_FAILED }).trim();
    if (upstream !== null) {
      const result = runGit(root, ["push", "--quiet", upstream.remote, `${commit}:${upstream.ref}`], { failCode: GIT_FAILED });
      if (result.status !== 0) takeBack(root, commit, toCommit, result.stderr);
      pushed = true;
    }
  }

  return {
    already_present: alreadyPresent.length,
    commit,
    committed: toCommit.length,
    imported: imported.length,
    kept_differing: keptDiffering,
    pushed,
    source_records: incoming.length,
    status: "imported",
    unpushed: upstream === null ? null : importCommitsAhead(root, upstream),
  };
}

/**
 * Take back this command's own commit after a refused push: the branch moves one step, the paths
 * are unstaged and their files removed, and whatever another session staged stays staged. The
 * records are still in the run's `records/`, so a repeated run copies them again.
 */
function takeBack(root, commit, paths, stderr) {
  const head = mustGit(root, ["rev-parse", "HEAD"], { failCode: GIT_FAILED }).trim();
  if (head !== commit) {
    fail("records_import_needs_repair", `the push was refused and HEAD moved since; nothing was taken back (${lastLines(stderr, 2)}).`);
  }
  mustGit(root, ["reset", "--quiet", "--soft", "HEAD~1"], { failCode: GIT_FAILED });
  withPaths(root, ["rm", "--quiet", "--cached"], paths);
  for (const path of paths) rmSync(join(root, path), { force: true });
  fail("records_import_push_refused", `the push was refused (${lastLines(stderr, 2)}); the commit was taken back. Run the import again.`);
}

export function main(argv = process.argv.slice(2)) {
  try {
    process.stdout.write(`${JSON.stringify(importRecords(parseArguments(argv)))}\n`);
  } catch (error) {
    const known = error instanceof LetterCorrectionError
      || error instanceof BoardError
      || error instanceof CandidateError;
    process.stderr.write(`${JSON.stringify({
      error: {
        code: known ? error.code : "records_import_failed",
        message: known ? error.message : `the command failed unexpectedly: ${error?.message ?? error}`,
      },
      status: "error",
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
