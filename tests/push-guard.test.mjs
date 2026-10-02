// The push guard is a git hook, so every case pushes for real: a disposable engine clone whose
// `core.hooksPath` is the absolute path of this repository's own `tools/git-hooks`, a bare
// repository standing in for the public remote, and a `candidate/` beside the clone carrying the
// fictional candidate's markers. What a case observes is git's own verdict — the push refused or
// accepted, and what the remote holds afterwards.
//
// The markers searched for are those of `candidate.example/`. Git reads a throwaway global config
// written below.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { addedLines } from "../tools/push-guard/cli.mjs";

const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const HOOKS = join(repoRoot, "tools", "git-hooks");
const GUARD = join(repoRoot, "tools", "push-guard", "cli.mjs");
const EXAMPLE_MARKERS = join(repoRoot, "candidate.example", "publishability-markers.json");

const configRoot = mkdtempSync(join(tmpdir(), "push-guard-gitconfig-"));
const globalConfig = join(configRoot, "gitconfig");
writeFileSync(
  globalConfig,
  [
    "[user]",
    "\tname = Guard Probe",
    "\temail = probe@example.com",
    "[init]",
    "\tdefaultBranch = main",
    "[commit]",
    "\tgpgsign = false",
    "",
  ].join("\n"),
);
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete process.env[key];
test.after(() => rmSync(configRoot, { force: true, recursive: true }));

// Frozen here rather than read from the module; the README names the same set.
const PINNED_CODES = [
  "push_guard_binary",
  "push_guard_diff_unreadable",
  "push_guard_failed",
  "push_guard_git_failed",
  "push_guard_hooks_path_not_absolute",
  "push_guard_input_invalid",
  "push_guard_layer_missing",
];

// Fictional candidate, from the example layer: an employer and an account handle. Read from the
// layer rather than written here, because the publishability suite pins that no tracked file
// matches the example's markers — the example is fictional only while nothing in the tree is it.
// Both patterns are plain literals, so the pattern text is also a string it matches.
const exampleMarkers = JSON.parse(readFileSync(EXAMPLE_MARKERS, "utf8")).markers;
const patternOf = (id) => exampleMarkers.find((marker) => marker.id === id).pattern;
const EMPLOYER = patternOf("employer.1");
const HANDLE = patternOf("identity.handle");
assert.match(EMPLOYER, /^[A-Za-z ]+$/u);
assert.match(HANDLE, /^[a-z0-9]+$/u);

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function tryGit(cwd, ...args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function commit(root, path, content, message = "change") {
  write(root, path, content);
  git(root, "add", "--", path);
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD").trim();
}

/** An engine clone with one pushed commit, the layer's markers beside it and the guard installed. */
function engine(t, { hooksPath = HOOKS, seeded = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "push-guard-"));
  t.after(() => rmSync(base, { force: true, recursive: true }));
  const remote = join(base, "public.git");
  git(base, "init", "-q", "--bare", remote);
  const clone = join(base, "engine");
  mkdirSync(clone);
  git(clone, "init", "-q");
  git(clone, "remote", "add", "origin", remote);
  write(clone, ".gitignore", "/candidate/\n");
  mkdirSync(join(clone, "candidate"));
  copyFileSync(EXAMPLE_MARKERS, join(clone, "candidate", "publishability-markers.json"));
  if (seeded) {
    commit(clone, "README.md", "engine\n", "seed");
    git(clone, "add", ".gitignore");
    git(clone, "commit", "-q", "-m", "ignore the layer");
    git(clone, "push", "-q", "origin", "main");
  }
  git(clone, "config", "core.hooksPath", hooksPath);
  return { base, clone, remote };
}

function remoteHas(remote, ref) {
  return tryGit(remote, "rev-parse", "--verify", "--quiet", ref).status === 0;
}

function refusal(result) {
  const line = result.stderr.split("\n").find((text) => text.startsWith("{"));
  return line ? JSON.parse(line) : null;
}

test("a clean push goes through", (t) => {
  const { clone, remote } = engine(t);
  const sha = commit(clone, "docs/guide.md", "How the engine works.\n");
  const result = tryGit(clone, "push", "origin", "main");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(remote, "rev-parse", "main").trim(), sha);
});

test("a personal marker in an added line refuses the push and names where, not what", (t) => {
  const { clone, remote } = engine(t);
  const before = git(remote, "rev-parse", "main").trim();
  commit(clone, "docs/notes.md", `line one\nworked at ${EMPLOYER}\n`);
  const result = tryGit(clone, "push", "origin", "main");
  assert.notEqual(result.status, 0);
  const report = refusal(result);
  assert.equal(report.status, "refused");
  assert.deepEqual(
    report.findings.map((finding) => [finding.marker, finding.path, finding.line]),
    [["employer.1", "docs/notes.md", 2]],
  );
  assert.doesNotMatch(result.stderr, new RegExp(EMPLOYER, "u"));
  assert.equal(git(remote, "rev-parse", "main").trim(), before);
});

test("a marker in a commit message alone refuses the push", (t) => {
  const { clone } = engine(t);
  commit(clone, "docs/guide.md", "neutral\n", `docs: notes for ${EMPLOYER}`);
  const result = tryGit(clone, "push", "origin", "main");
  assert.notEqual(result.status, 0);
  assert.match(refusal(result).findings[0].where, /message/u);
});

test("a marker in a branch name refuses the push", (t) => {
  const { clone, remote } = engine(t);
  git(clone, "switch", "-q", "-c", `fix-${HANDLE}`);
  commit(clone, "docs/guide.md", "neutral\n");
  const result = tryGit(clone, "push", "origin", `fix-${HANDLE}`);
  assert.notEqual(result.status, 0);
  assert.equal(refusal(result).findings[0].where, "ref names");
  assert.equal(remoteHas(remote, `fix-${HANDLE}`), false);
});

test("pushing a sha instead of a branch does not get past it", (t) => {
  const { clone, remote } = engine(t);
  const sha = commit(clone, "docs/notes.md", `${EMPLOYER}\n`);
  git(clone, "reset", "-q", "--hard", "HEAD~1");
  const result = tryGit(clone, "push", "origin", `${sha}:refs/heads/side`);
  assert.notEqual(result.status, 0);
  assert.equal(refusal(result).findings[0].marker, "employer.1");
  assert.equal(remoteHas(remote, "side"), false);
});

test("a root commit is read against the empty tree", (t) => {
  const { clone } = engine(t, { seeded: false });
  commit(clone, "README.md", `${EMPLOYER}\n`, "first");
  const result = tryGit(clone, "push", "origin", "main");
  assert.notEqual(result.status, 0);
  assert.equal(refusal(result).findings[0].path, "README.md");
});

test("a copy of a markers file is read by the personal markers", (t) => {
  const { clone } = engine(t);
  commit(clone, "candidate.example/publishability-markers.json", `{"pattern": "${EMPLOYER}"}\n`);
  const result = tryGit(clone, "push", "origin", "main");
  assert.notEqual(result.status, 0);
  assert.equal(refusal(result).findings[0].marker, "employer.1");
});

test("a binary file refuses the push", (t) => {
  const { clone } = engine(t);
  commit(clone, "assets/blob.bin", Buffer.from([0, 1, 2, 0, 255]));
  const result = tryGit(clone, "push", "origin", "main");
  assert.notEqual(result.status, 0);
  assert.equal(refusal(result).error.code, "push_guard_binary");
});

test("without the personal markers the guard refuses instead of passing", (t) => {
  const { clone } = engine(t);
  rmSync(join(clone, "candidate", "publishability-markers.json"));
  commit(clone, "docs/guide.md", "neutral\n");
  const result = tryGit(clone, "push", "origin", "main");
  assert.notEqual(result.status, 0);
  assert.equal(refusal(result).error.code, "push_guard_layer_missing");
});

test("a hooks directory without the guard refuses the push", (t) => {
  const { base, clone } = engine(t);
  const bare = join(base, "hooks-only");
  mkdirSync(bare);
  copyFileSync(join(HOOKS, "pre-push"), join(bare, "pre-push"));
  git(clone, "config", "core.hooksPath", bare);
  commit(clone, "docs/guide.md", "neutral\n");
  const result = tryGit(clone, "push", "origin", "main");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /push guard is missing/u);
});

test("a relative core.hooksPath is refused by the guard itself", (t) => {
  const { clone } = engine(t, { hooksPath: "relative-hooks" });
  write(clone, "relative-hooks/pre-push", `#!/bin/sh\nexec node "${GUARD}" "$@"\n`);
  spawnSync("chmod", ["+x", join(clone, "relative-hooks", "pre-push")]);
  commit(clone, "docs/guide.md", "neutral\n");
  const result = tryGit(clone, "push", "origin", "main");
  assert.notEqual(result.status, 0);
  assert.equal(refusal(result).error.code, "push_guard_hooks_path_not_absolute");
});

test("an added line that begins like a file header stays content", () => {
  const diff = [
    "diff --git a/x b/x",
    "--- a/x",
    "+++ b/x",
    "@@ -1,0 +1,2 @@",
    "+++ looks like a header",
    "+plain",
    "",
  ].join("\n");
  assert.deepEqual(
    [...addedLines(diff)],
    [
      [
        "x",
        [
          { line: 1, text: "++ looks like a header" },
          { line: 2, text: "plain" },
        ],
      ],
    ],
  );
});

test("the refusal codes are the ones the README lists and the guard throws", () => {
  const readme = readFileSync(join(repoRoot, "tools", "push-guard", "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("## Refusal codes"));
  assert.deepEqual(
    [...section.matchAll(/`(push_guard_[a-z_]+)`/gu)].map((match) => match[1]).sort(),
    PINNED_CODES,
  );
  const source = readFileSync(GUARD, "utf8");
  assert.deepEqual(
    [...new Set([...source.matchAll(/"(push_guard_[a-z_]+)"/gu)].map((match) => match[1]))].sort(),
    PINNED_CODES,
  );
});
