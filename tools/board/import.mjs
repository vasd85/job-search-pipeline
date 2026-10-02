#!/usr/bin/env node

/**
 * Turn the drafts of the operational folder into numbered tasks on the private board.
 *
 * A run in the operational folder has neither git nor the private repository, so it files a task
 * as `outbox/tasks/<slug>.md` with a `draft_id` and no number. This command, run in a development
 * clone, gives each draft the next id, commits that one file, pushes it, records the pair
 * `draft_id → id` in `outbox/tasks/.imported.json` and deletes the draft. Importing a draft does
 * not start the task.
 *
 * The private clone is shared by every development session on the machine, so the command never
 * touches what it did not write: it commits one path with `--only`, and when it has to take its
 * own commit back it moves the branch and unstages that one path, leaving another session's index
 * as it was. Two machines racing for one number is a refusal with the draft left in place, never a
 * rebase and never a renumbering.
 *
 * The task keeps its `draft_id`. That is what lets a run interrupted anywhere between the commit
 * and the deletion of the draft be repeated without filing the task twice.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  TASK_FILE_PATTERN,
  nextTaskId,
  numberedText,
  parseDraft,
  readFrontmatter,
  taskFileName,
} from "./draft.mjs";
import { BoardError, lastLines, mustGit, privateRootFor, runGit, samePath } from "./git.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const OUTBOX_DIRECTORY = join("outbox", "tasks");
export const IMPORTED_FILE = ".imported.json";
export const IMPORTED_SCHEMA_VERSION = 1;
export const LOCK_FILE = "board-import.lock";
/** The trailer that marks a commit as this command's own, so it can recognise it later. */
export const DRAFT_TRAILER = "Board-Import-Draft";

export const USAGE =
  "use --ops-root <absolute path> [--draft <file name>] [--board-root <absolute path>]";

function fail(code, message) {
  throw new BoardError(code, message);
}

export function parseArguments(argv) {
  const parsed = { boardRoot: null, draft: null, opsRoot: null };
  const flags = { "--board-root": "boardRoot", "--draft": "draft", "--ops-root": "opsRoot" };
  for (let index = 0; index < argv.length; index += 2) {
    const key = flags[argv[index]];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || value.startsWith("--"))
      fail("board_invalid_arguments", USAGE);
    parsed[key] = value;
  }
  if (parsed.opsRoot === null) fail("board_invalid_arguments", USAGE);
  for (const key of ["boardRoot", "opsRoot"]) {
    if (parsed[key] !== null && !isAbsolute(parsed[key]))
      fail("board_invalid_arguments", `${key} must be an absolute path.`);
  }
  if (parsed.draft !== null && parsed.draft.includes("/"))
    fail("board_invalid_arguments", "--draft takes a file name.");
  return parsed;
}

function readImported(outbox) {
  const file = join(outbox, IMPORTED_FILE);
  if (!existsSync(file)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail("board_import_imported_unreadable", `${IMPORTED_FILE}: ${error?.message ?? error}`);
  }
  const valid =
    parsed?.schema_version === IMPORTED_SCHEMA_VERSION &&
    Array.isArray(parsed.imported) &&
    parsed.imported.every(
      (entry) =>
        typeof entry?.draft_id === "string" &&
        Number.isInteger(entry?.id) &&
        typeof entry?.file === "string",
    );
  if (!valid)
    fail(
      "board_import_imported_unreadable",
      `${IMPORTED_FILE} is not a schema ${IMPORTED_SCHEMA_VERSION} record.`,
    );
  return parsed.imported;
}

/** Written beside itself and renamed over, so a reader never sees half a file. */
function writeImported(outbox, imported) {
  const file = join(outbox, IMPORTED_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ imported, schema_version: IMPORTED_SCHEMA_VERSION }, null, 2)}\n`,
  );
  renameSync(temporary, file);
}

function taskFiles(boardRoot) {
  const files = [];
  for (const directory of ["board", join("board", "done")]) {
    const absolute = join(boardRoot, directory);
    if (!existsSync(absolute)) continue;
    for (const name of readdirSync(absolute)) {
      if (TASK_FILE_PATTERN.test(name))
        files.push({ name, path: `${directory.split("\\").join("/")}/${name}` });
    }
  }
  return files;
}

function findByDraftId(boardRoot, draftId) {
  for (const file of taskFiles(boardRoot)) {
    const front = readFrontmatter(readFileSync(join(boardRoot, file.path), "utf8"));
    if (front?.keys.get("draft_id") === draftId) return { ...file, front };
  }
  return null;
}

function upstreamOf(boardRoot) {
  const branch = runGit(boardRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.status !== 0)
    fail("board_import_no_upstream", "the private clone is not on a branch.");
  const name = branch.stdout.trim();
  const out = mustGit(
    boardRoot,
    [
      "for-each-ref",
      "--format=%(upstream:remotename)%00%(upstream:remoteref)",
      `refs/heads/${name}`,
    ],
    { failCode: "board_import_git_failed" },
  ).trim();
  const [remote, ref] = out.split("\0");
  if (!remote || !ref) fail("board_import_no_upstream", `${name} has no upstream to push to.`);
  return { ref, remote, tracking: `refs/remotes/${remote}/${ref.replace(/^refs\/heads\//u, "")}` };
}

function isAncestor(boardRoot, older, newer) {
  return runGit(boardRoot, ["merge-base", "--is-ancestor", older, newer]).status === 0;
}

/** The draft id this command recorded in a commit's trailer, or null for anyone else's commit. */
function importTrailer(boardRoot, commit) {
  const out = runGit(boardRoot, [
    "log",
    "-1",
    `--format=%(trailers:key=${DRAFT_TRAILER},valueonly)`,
    commit,
  ]);
  const value = out.stdout.trim();
  return out.status === 0 && value.length > 0 ? value : null;
}

/** Paths a commit changed; this command's own commit changes exactly one. */
function changedPaths(boardRoot, commit) {
  return mustGit(boardRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit], {
    failCode: "board_import_git_failed",
  })
    .split("\0")
    .filter(Boolean);
}

/**
 * Take back this command's own last commit: move the branch one step, unstage its one path and
 * delete the file. Whatever another session had staged stays staged.
 */
function takeBack(boardRoot, path) {
  mustGit(boardRoot, ["reset", "--quiet", "--soft", "HEAD~1"], {
    failCode: "board_import_git_failed",
  });
  mustGit(boardRoot, ["rm", "--quiet", "--cached", "--", path], {
    failCode: "board_import_git_failed",
  });
  rmSync(join(boardRoot, path), { force: true });
}

function push(boardRoot, upstream) {
  return runGit(boardRoot, ["push", "--quiet", upstream.remote, `HEAD:${upstream.ref}`]);
}

/**
 * Before the pull: a commit of this command left unpushed by an interrupted run. Ahead of the
 * upstream it is pushed now; diverged from it — another machine pushed in between, possibly the
 * same number — it is taken back and the run refuses, so the next run starts from a clean pull.
 */
function settleStranded(boardRoot, upstream) {
  const head = mustGit(boardRoot, ["rev-parse", "HEAD"], {
    failCode: "board_import_git_failed",
  }).trim();
  if (isAncestor(boardRoot, head, upstream.tracking)) return;
  if (importTrailer(boardRoot, head) === null) return;
  const paths = changedPaths(boardRoot, head);
  if (paths.length !== 1) return;
  if (isAncestor(boardRoot, upstream.tracking, head)) {
    const pushed = push(boardRoot, upstream);
    if (pushed.status === 0) return;
  }
  takeBack(boardRoot, paths[0]);
  fail(
    "board_import_diverged",
    `an interrupted import of ${paths[0]} met a newer board; it was taken back and its draft is still in the outbox. Run the import again.`,
  );
}

function pull(boardRoot) {
  const result = runGit(boardRoot, ["pull", "--quiet", "--ff-only"]);
  if (result.status === 0) return;
  // Git names the files it would overwrite, one per line after a tab. Those, not the whole status:
  // a file another session left dirty that the pull does not touch is no obstacle.
  const named = result.stderr
    .split("\n")
    .filter((line) => line.startsWith("\t"))
    .map((line) => line.trim());
  fail(
    "board_import_pull_refused",
    named.length > 0
      ? `the pull would overwrite uncommitted changes in: ${named.join(", ")}.`
      : `git pull --ff-only refused: ${lastLines(result.stderr)}`,
  );
}

function lock(boardRoot) {
  const common = mustGit(boardRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    failCode: "board_import_git_failed",
  }).trim();
  const file = join(common, LOCK_FILE);
  try {
    closeSync(openSync(file, "wx"));
  } catch (error) {
    if (error?.code === "EEXIST")
      fail(
        "board_import_locked",
        `another import holds ${file}; remove it only if no import is running.`,
      );
    throw error;
  }
  return () => rmSync(file, { force: true });
}

function readDrafts(outbox, only) {
  if (!existsSync(outbox)) return [];
  const names = readdirSync(outbox)
    .filter((name) => name.endsWith(".md") && !name.startsWith("."))
    .sort();
  if (only !== null && !names.includes(only))
    fail("board_import_draft_invalid", `${only} is not in the outbox.`);
  const drafts = (only === null ? names : [only]).map((name) =>
    parseDraft(name, readFileSync(join(outbox, name), "utf8")),
  );
  const seen = new Map();
  for (const draft of drafts) {
    if (seen.has(draft.draftId)) {
      fail(
        "board_import_draft_duplicate",
        `${draft.fileName} and ${seen.get(draft.draftId)} carry one draft_id.`,
      );
    }
    seen.set(draft.draftId, draft.fileName);
  }
  return drafts;
}

export function importDrafts({ boardRoot = null, draft = null, opsRoot, hooks = {} }) {
  const root = boardRoot ?? privateRootFor(repoRoot);
  const top = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (!existsSync(join(root, "board")) || top.status !== 0 || !samePath(top.stdout.trim(), root)) {
    fail(
      "board_import_root_not_a_clone",
      `${root} is not the root of the private repository's clone.`,
    );
  }
  const outbox = join(opsRoot, OUTBOX_DIRECTORY);
  const drafts = readDrafts(outbox, draft);
  const imported = readImported(outbox);
  if (drafts.length === 0) return { imported: [], status: "nothing_to_import" };

  const release = lock(root);
  const done = [];
  try {
    const upstream = upstreamOf(root);
    mustGit(root, ["fetch", "--quiet", upstream.remote], { failCode: "board_import_git_failed" });
    settleStranded(root, upstream);
    pull(root);

    for (const item of drafts) {
      const draftFile = join(outbox, item.fileName);
      const known = imported.find((entry) => entry.draft_id === item.draftId);
      if (known !== undefined) {
        unlinkSync(draftFile);
        done.push({
          draft_id: item.draftId,
          file: known.file,
          id: known.id,
          note: "already imported",
        });
        continue;
      }

      const existing = findByDraftId(root, item.draftId);
      let record;
      if (existing !== null) {
        if (existing.front.keys.get("title") !== item.title) {
          fail(
            "board_import_draft_conflict",
            `${existing.path} carries the draft_id of ${item.fileName} with another title.`,
          );
        }
        if (
          runGit(root, ["cat-file", "-e", `${upstream.tracking}:${existing.path}`]).status !== 0
        ) {
          fail(
            "board_import_needs_repair",
            `${existing.path} is on the board but not on the upstream; push or remove it by hand.`,
          );
        }
        record = {
          draft_id: item.draftId,
          file: existing.path,
          id: Number(existing.front.keys.get("id")),
        };
      } else {
        const id = nextTaskId(taskFiles(root).map((file) => file.name));
        const path = `board/${taskFileName(id, item.type, item.slug)}`;
        if (existsSync(join(root, path)))
          fail("board_import_target_exists", `${path} already exists.`);
        writeFileSync(join(root, path), numberedText(item.text, id));
        mustGit(root, ["add", "--", path], { failCode: "board_import_git_failed" });
        mustGit(
          root,
          [
            "commit",
            "--quiet",
            "--only",
            "-m",
            `board: import ${path.slice("board/".length)}`,
            "--trailer",
            `${DRAFT_TRAILER}: ${item.draftId}`,
            "--",
            path,
          ],
          { failCode: "board_import_git_failed" },
        );
        const ours = mustGit(root, ["rev-parse", "HEAD"], {
          failCode: "board_import_git_failed",
        }).trim();
        hooks.beforePush?.({ path, root });
        const pushed = push(root, upstream);
        if (pushed.status !== 0) {
          const head = mustGit(root, ["rev-parse", "HEAD"], {
            failCode: "board_import_git_failed",
          }).trim();
          if (head !== ours) {
            fail(
              "board_import_needs_repair",
              `the push of ${path} was refused and HEAD moved since; nothing was taken back.`,
            );
          }
          takeBack(root, path);
          fail(
            "board_import_push_refused",
            `the push of ${path} was refused (${lastLines(pushed.stderr, 2)}); the commit was taken back and ${item.fileName} is still in the outbox. Run the import again.`,
          );
        }
        record = { draft_id: item.draftId, file: path, id };
      }
      imported.push(record);
      writeImported(outbox, imported);
      unlinkSync(draftFile);
      done.push(record);
    }
  } finally {
    release();
  }
  return { imported: done, status: "imported" };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const result = importDrafts(parseArguments(argv));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const known = error instanceof BoardError;
    process.stderr.write(
      `${JSON.stringify({
        error: {
          code: known ? error.code : "board_failed",
          message: known
            ? error.message
            : `the command failed unexpectedly: ${error?.message ?? error}`,
        },
        status: "error",
      })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
