#!/usr/bin/env node

/**
 * The engine's pre-push guard: nothing personal leaves this machine for the public repository.
 *
 * Git runs `tools/git-hooks/pre-push`, which hands over to this file with the remote's name and
 * address as arguments and one line per ref on stdin: `<local ref> <local sha> <remote ref>
 * <remote sha>`. For every line the guard scans what would become public — the message and the
 * added lines and file names of every commit the remote does not have yet, the message of an
 * annotated tag, and both ref names — with the public markers of `tools/publishability/` and the
 * personal markers of the candidate layer. One finding refuses the whole push.
 *
 * The guard follows the sha, never the ref name. The first design this project measured checked
 * names, and `git push origin <sha>:refs/heads/x` walked past it: for that spelling the local ref
 * field carries the sha itself.
 *
 * It refuses rather than passes whenever it cannot do its job: `core.hooksPath` not absolute (in
 * some working copies a relative one resolves to a directory with no hook, and a hook that does
 * not run cannot refuse anything), no personal markers (a guard without them finds nothing and
 * looks like protection), a binary file in the diff (content this scan did not read is not clean).
 * A finding names its marker, commit, path and line, never the matched text.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BoardError, privateRootFor, runGit } from "../board/git.mjs";
import {
  CANDIDATE_MARKERS_FILE,
  PUBLIC_ALLOWANCES,
  PUBLIC_MARKERS,
  PUBLIC_TEXT_ALLOWANCES,
  PublishabilityError,
  coversPath,
  isMarkerSource,
  loadCandidateMarkers,
} from "../publishability/markers.mjs";
import { scanText } from "../publishability/scan.mjs";

class PushGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new PushGuardError(code, message);
}

const ZERO = /^0+$/u;

function git(cwd, args, failCode = "push_guard_git_failed") {
  const result = runGit(cwd, args, { failCode });
  if (result.status !== 0) fail(failCode, `git ${args[0]} failed: ${result.stderr.trim().split("\n").pop()}`);
  return result.stdout;
}

/** The markers, allowances and data paths the scan uses, from the public list and the layer. */
export function assembleGuard(checkout) {
  const layerRoot = privateRootFor(checkout);
  if (!existsSync(join(layerRoot, CANDIDATE_MARKERS_FILE))) {
    fail("push_guard_layer_missing", `no ${CANDIDATE_MARKERS_FILE} in the private repository beside this clone.`);
  }
  const layer = loadCandidateMarkers({ root: layerRoot });
  return {
    allow: [...PUBLIC_ALLOWANCES, ...layer.allow],
    cyrillicData: layer.cyrillicData.map((entry) => entry.path),
    markers: [...PUBLIC_MARKERS, ...layer.markers],
    personal: new Set(layer.markers.map((marker) => marker.id)),
  };
}

/**
 * The markers that apply to one path. A marker source is skipped by the public markers, which it
 * carries by design, but never by the personal ones: a real markers file copied over the example
 * would otherwise leave unread.
 */
function markersFor(guard, path) {
  const allowed = new Set(guard.allow.filter((entry) => coversPath(entry.path, path)).map((entry) => entry.marker));
  const isData = guard.cyrillicData.some((entry) => coversPath(entry, path));
  const source = isMarkerSource(path);
  return guard.markers.filter((marker) => !allowed.has(marker.id)
    && !(isData && marker.class === "cyrillic_prose")
    && !(source && !guard.personal.has(marker.id)));
}

/**
 * Added lines of one commit, by path, with their line numbers in the new file.
 *
 * The hunk header's counts decide which lines are content. Without them an added line that
 * itself begins with `++ ` would read as a file header, and the scan would lose track of the path.
 */
export function addedLines(diff) {
  const files = new Map();
  let current = null;
  let line = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const text of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (text.startsWith("\\")) continue;
      if (text.startsWith("-") && oldLeft > 0) {
        oldLeft -= 1;
      } else if (text.startsWith("+") && newLeft > 0) {
        if (current !== null) files.get(current).push({ line, text: text.slice(1) });
        line += 1;
        newLeft -= 1;
      } else {
        fail("push_guard_diff_unreadable", "a hunk ended before its header said it would.");
      }
      continue;
    }
    if (text.startsWith("diff --git ")) {
      current = null;
      continue;
    }
    if (text.startsWith("Binary files ") || text.startsWith("GIT binary patch")) {
      fail("push_guard_binary", "a binary file is in the push, and this guard reads only text.");
    }
    if (text.startsWith("+++ ")) {
      const target = text.slice(4);
      current = target === "/dev/null" ? null : target.replace(/^b\//u, "");
      if (current !== null && !files.has(current)) files.set(current, []);
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(text);
    if (hunk !== null) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      line = Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
    }
  }
  return files;
}

function scan(markers, text, textAllow = []) {
  return markers.length === 0 ? [] : scanText({ markers, text, textAllow }).findings;
}

function commitsToScan(checkout, remote, localSha, remoteSha) {
  const args = ["rev-list", "--reverse", localSha, "--not", `--remotes=${remote}`];
  if (!ZERO.test(remoteSha) && runGit(checkout, ["cat-file", "-e", `${remoteSha}^{commit}`]).status === 0) {
    args.push(remoteSha);
  }
  return git(checkout, args).split("\n").filter(Boolean);
}

export function guardPush({ checkout, remote, refs }) {
  const hooksPath = runGit(checkout, ["config", "--get", "core.hooksPath"]).stdout.trim();
  if (!isAbsolute(hooksPath)) {
    fail("push_guard_hooks_path_not_absolute", "core.hooksPath must be an absolute path to tools/git-hooks.");
  }
  const guard = assembleGuard(checkout);
  const empty = git(checkout, ["hash-object", "-t", "tree", "--stdin"]).trim();
  const findings = [];
  const note = (where, list) => {
    for (const finding of list) findings.push({ ...where, line: finding.line, marker: finding.marker });
  };

  for (const { localRef, localSha, remoteRef, remoteSha } of refs) {
    note({ where: "ref names" }, scan(guard.markers, `${localRef}\n${remoteRef}`));
    if (ZERO.test(localSha)) continue;
    let tip = localSha;
    if (git(checkout, ["cat-file", "-t", localSha]).trim() === "tag") {
      // The message only: the header's tagger line is an identity, the same kind of field the
      // guard leaves alone on a commit.
      const tag = git(checkout, ["cat-file", "tag", localSha]);
      const message = tag.includes("\n\n") ? tag.slice(tag.indexOf("\n\n") + 2) : "";
      note({ where: `tag ${localSha.slice(0, 12)} message` }, scan(guard.markers, message, PUBLIC_TEXT_ALLOWANCES));
      tip = git(checkout, ["rev-parse", `${localSha}^{commit}`]).trim();
    }
    for (const commit of commitsToScan(checkout, remote, tip, remoteSha)) {
      const at = commit.slice(0, 12);
      note({ where: `commit ${at} message` }, scan(guard.markers, git(checkout, ["log", "-1", "--format=%B", commit]), PUBLIC_TEXT_ALLOWANCES));
      const parent = runGit(checkout, ["rev-parse", "--verify", "--quiet", `${commit}^1`]);
      const base = parent.status === 0 ? parent.stdout.trim() : empty;
      const diff = git(checkout, [
        "-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv",
        "--no-renames", "--unified=0", base, commit,
      ]);
      for (const [path, lines] of addedLines(diff)) {
        const markers = markersFor(guard, path);
        note({ commit: at, path, where: "file name" }, scan(markers, path));
        for (const finding of scan(markers, lines.map((entry) => entry.text).join("\n"))) {
          findings.push({ commit: at, line: lines[finding.line - 1].line, marker: finding.marker, path });
        }
      }
    }
  }
  return findings;
}

export function parseRefs(stdin) {
  return stdin.split("\n").filter((line) => line.trim().length > 0).map((line) => {
    const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(" ");
    if (!remoteSha) fail("push_guard_input_invalid", "a pre-push line has four fields.");
    return { localRef, localSha, remoteRef, remoteSha };
  });
}

export function main(argv = process.argv.slice(2), { cwd = process.cwd(), stdin = null } = {}) {
  try {
    const remote = argv[0];
    if (!remote) fail("push_guard_input_invalid", "git passes the remote's name as the first argument.");
    const refs = parseRefs(stdin ?? readFileSync(0, "utf8"));
    const findings = guardPush({ checkout: cwd, remote, refs });
    if (findings.length > 0) {
      process.stderr.write(`${JSON.stringify({ findings, status: "refused" })}\n`);
      process.stderr.write("pre-push: personal or private content in the push; nothing was sent.\n");
      process.exitCode = 1;
    }
  } catch (error) {
    const known = error instanceof PushGuardError || error instanceof BoardError || error instanceof PublishabilityError;
    process.stderr.write(`${JSON.stringify({
      error: {
        code: known ? error.code : "push_guard_failed",
        message: known ? error.message : `the guard failed unexpectedly: ${error?.message ?? error}`,
      },
      status: "error",
    })}\n`);
    process.stderr.write("pre-push: the guard could not run; nothing was sent.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
