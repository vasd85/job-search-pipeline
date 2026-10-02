// The pre-commit hook is a git hook, so every case commits for real: a disposable repository whose
// `core.hooksPath` is the absolute path of this repository's own `tools/git-hooks`. What a case
// observes is git's own verdict — the commit refused or made, and where `HEAD` stands afterwards.
//
// Git reads a throwaway global config written below.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const HOOKS = join(repoRoot, "tools", "git-hooks");

const configRoot = mkdtempSync(join(tmpdir(), "git-hooks-gitconfig-"));
const globalConfig = join(configRoot, "gitconfig");
writeFileSync(globalConfig, [
  "[user]", "\tname = Hook Probe", "\temail = probe@example.com",
  "[init]", "\tdefaultBranch = main",
  "[commit]", "\tgpgsign = false", "",
].join("\n"));
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete process.env[key];
test.after(() => rmSync(configRoot, { force: true, recursive: true }));

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

function head(root) {
  return tryGit(root, "rev-parse", "--verify", "--quiet", "HEAD").stdout.trim();
}

/** A repository with the engine's hooks installed and, unless `seeded` is false, one commit. */
function repository(t, { seeded = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "git-hooks-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  git(root, "init", "-q");
  git(root, "config", "core.hooksPath", HOOKS);
  if (seeded) {
    write(root, "notes.md", "first\n");
    git(root, "add", "notes.md");
    git(root, "commit", "-q", "-m", "seed");
  }
  return root;
}

function assertRefused(result, root, before, location) {
  assert.notEqual(result.status, 0);
  assert.equal(head(root), before);
  assert.match(result.stderr, new RegExp(`^${location}: `, "mu"));
  assert.match(result.stderr, /^pre-commit: whitespace errors in the staged changes/mu);
}

test("a clean staged change is committed", (t) => {
  const root = repository(t);
  const before = head(root);
  write(root, "notes.md", "first\nsecond\n");
  git(root, "add", "notes.md");
  const result = tryGit(root, "commit", "-q", "-m", "clean");
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(head(root), before);
});

test("a blank line staged at the end of a file refuses the commit", (t) => {
  const root = repository(t);
  const before = head(root);
  write(root, "notes.md", "first\n\n");
  git(root, "add", "notes.md");
  assertRefused(tryGit(root, "commit", "-q", "-m", "eof"), root, before, "notes.md:2");
});

test("trailing whitespace staged on a line refuses the commit", (t) => {
  const root = repository(t);
  const before = head(root);
  write(root, "notes.md", "first\nsecond \n");
  git(root, "add", "notes.md");
  assertRefused(tryGit(root, "commit", "-q", "-m", "eol"), root, before, "notes.md:2");
});

test("a defect left unstaged in the working tree does not stop a clean staged change", (t) => {
  const root = repository(t);
  const before = head(root);
  write(root, "other.md", "clean\n");
  git(root, "add", "other.md");
  write(root, "notes.md", "first\n\n");
  const result = tryGit(root, "commit", "-q", "-m", "staged only");
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(head(root), before);
});

test("a commit naming its paths is checked on what it commits, not on the index", (t) => {
  const root = repository(t);
  const before = head(root);
  write(root, "notes.md", "first\n\n");
  assertRefused(tryGit(root, "commit", "-q", "-m", "pathspec", "--", "notes.md"), root, before, "notes.md:2");
  assert.equal(git(root, "diff", "--cached", "--name-only"), "");
});

test("the first commit of an empty repository is checked too", (t) => {
  const root = repository(t, { seeded: false });
  write(root, "notes.md", "first\n\n");
  git(root, "add", "notes.md");
  assertRefused(tryGit(root, "commit", "-q", "-m", "unborn"), root, "", "notes.md:2");
  write(root, "notes.md", "first\n");
  git(root, "add", "notes.md");
  const result = tryGit(root, "commit", "-q", "-m", "unborn clean");
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(head(root), "");
});
