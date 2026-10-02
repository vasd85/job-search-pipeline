// The pre-commit hook is a git hook, so every case commits for real: a disposable repository whose
// `core.hooksPath` is the absolute path of this repository's own `tools/git-hooks`. What a case
// observes is git's own verdict — the commit refused or made, and where `HEAD` stands afterwards.
//
// Git reads a throwaway global config written below.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const HOOKS = join(repoRoot, "tools", "git-hooks");

const configRoot = mkdtempSync(join(tmpdir(), "git-hooks-gitconfig-"));
const globalConfig = join(configRoot, "gitconfig");
writeFileSync(
  globalConfig,
  [
    "[user]",
    "\tname = Hook Probe",
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
  write(root, ".prettierrc.json", readFileSync(join(repoRoot, ".prettierrc.json")));
  write(root, ".prettierignore", readFileSync(join(repoRoot, ".prettierignore")));
  git(root, "add", ".prettierrc.json", ".prettierignore");
  if (seeded) {
    write(root, "notes.txt", "first\n");
    git(root, "add", "notes.txt");
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
  write(root, "notes.txt", "first\nsecond\n");
  git(root, "add", "notes.txt");
  const result = tryGit(root, "commit", "-q", "-m", "clean");
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(head(root), before);
});

test("a blank line staged at the end of a file refuses the commit", (t) => {
  const root = repository(t);
  const before = head(root);
  write(root, "notes.txt", "first\n\n");
  git(root, "add", "notes.txt");
  assertRefused(tryGit(root, "commit", "-q", "-m", "eof"), root, before, "notes.txt:2");
});

test("trailing whitespace staged on a line refuses the commit", (t) => {
  const root = repository(t);
  const before = head(root);
  write(root, "notes.txt", "first\nsecond \n");
  git(root, "add", "notes.txt");
  assertRefused(tryGit(root, "commit", "-q", "-m", "eol"), root, before, "notes.txt:2");
});

test("a defect left unstaged in the working tree does not stop a clean staged change", (t) => {
  const root = repository(t);
  const before = head(root);
  write(root, "other.md", "clean\n");
  git(root, "add", "other.md");
  write(root, "notes.txt", "first\n\n");
  const result = tryGit(root, "commit", "-q", "-m", "staged only");
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(head(root), before);
});

test("a commit naming its paths is checked on what it commits, not on the index", (t) => {
  const root = repository(t);
  const before = head(root);
  write(root, "notes.txt", "first\n\n");
  assertRefused(
    tryGit(root, "commit", "-q", "-m", "pathspec", "--", "notes.txt"),
    root,
    before,
    "notes.txt:2",
  );
  assert.equal(git(root, "diff", "--cached", "--name-only"), "");
});

test("the first commit of an empty repository is checked too", (t) => {
  const root = repository(t, { seeded: false });
  write(root, "notes.txt", "first\n\n");
  git(root, "add", "notes.txt");
  assertRefused(tryGit(root, "commit", "-q", "-m", "unborn"), root, "", "notes.txt:2");
  write(root, "notes.txt", "first\n");
  git(root, "add", "notes.txt");
  const result = tryGit(root, "commit", "-q", "-m", "unborn clean");
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(head(root), "");
});

// A real commit is the regression boundary: checking alone does not satisfy this contract.
test("pre-commit formats staged code before Git creates the commit", (t) => {
  const root = repository(t);
  write(root, "code.mjs", "export const value={answer:42}\n");
  git(root, "add", "code.mjs");
  git(root, "commit", "-q", "-m", "format code");
  assert.equal(git(root, "show", "HEAD:code.mjs"), "export const value = { answer: 42 };\n");
  assert.equal(
    readFileSync(join(root, "code.mjs"), "utf8"),
    "export const value = { answer: 42 };\n",
  );
});

const rawCode = "export const value={answer:42}\n";
const cleanCode = "export const value = { answer: 42 };\n";

test("partial staging preserves unstaged bytes and does not stage unrelated work", (t) => {
  const root = repository(t);
  write(root, "code.mjs", rawCode);
  git(root, "add", "code.mjs");
  const unstaged = `${rawCode}// an unfinished edit\n`;
  write(root, "code.mjs", unstaged);
  write(root, "other.mjs", "unfinished syntax {\n");
  git(root, "commit", "-q", "-m", "partial");
  assert.equal(git(root, "show", "HEAD:code.mjs"), cleanCode);
  assert.equal(readFileSync(join(root, "code.mjs"), "utf8"), unstaged);
  assert.equal(tryGit(root, "show", "HEAD:other.mjs").status, 128);
});

test("pathspec commits format the active index and leave other staged paths alone", (t) => {
  const root = repository(t);
  write(root, "code.mjs", cleanCode);
  git(root, "add", "code.mjs");
  git(root, "commit", "-q", "-m", "seed code");
  write(root, "other.mjs", rawCode);
  git(root, "add", "other.mjs");
  write(root, "code.mjs", rawCode);
  git(root, "commit", "-q", "-m", "selected", "--", "code.mjs");
  assert.equal(git(root, "show", "HEAD:code.mjs"), cleanCode);
  assert.equal(git(root, "show", ":other.mjs"), rawCode);
  assert.equal(tryGit(root, "show", "HEAD:other.mjs").status, 128);
  assert.equal(readFileSync(join(root, "code.mjs"), "utf8"), cleanCode);
});

test("unborn commits format code and Markdown, using staged configuration and ignore policy", (t) => {
  const root = repository(t, { seeded: false });
  write(root, ".prettierrc.json", '{"singleQuote":true}\n');
  write(root, ".prettierignore", "ignored.mjs\n");
  write(root, "code.mjs", 'export const value="answer"\n');
  write(root, "guide.md", "#   Guide\n\n\nText.\n\n");
  write(root, "ignored.mjs", rawCode);
  git(root, "add", ".prettierrc.json", ".prettierignore", "code.mjs", "guide.md", "ignored.mjs");
  // The working policies must have no influence on the committed snapshot.
  write(root, ".prettierrc.json", '{"singleQuote":false}\n');
  write(root, ".prettierignore", "code.mjs\n");
  git(root, "commit", "-q", "-m", "first");
  assert.equal(git(root, "show", "HEAD:code.mjs"), "export const value = 'answer';\n");
  assert.equal(git(root, "show", "HEAD:guide.md"), "# Guide\n\nText.\n");
  assert.equal(git(root, "show", "HEAD:ignored.mjs"), rawCode);
  assert.equal(readFileSync(join(root, ".prettierrc.json"), "utf8"), '{"singleQuote":false}\n');
  assert.equal(readFileSync(join(root, ".prettierignore"), "utf8"), "code.mjs\n");
});

test("excluded fixtures and generated files retain their bytes", (t) => {
  const root = repository(t);
  for (const path of [
    "tests/fixtures/pin.json",
    "candidate.example/profile.md",
    ".agents/skills/demo/SKILL.md",
    "package-lock.json",
  ]) {
    write(root, path, path.endsWith("json") ? '{"pin":42}\n' : "#   Pin\n");
    git(root, "add", "--", path);
  }
  git(root, "commit", "-q", "-m", "byte pins");
  for (const path of [
    "tests/fixtures/pin.json",
    "candidate.example/profile.md",
    ".agents/skills/demo/SKILL.md",
    "package-lock.json",
  ]) {
    assert.equal(
      git(root, "show", `HEAD:${path}`),
      path.endsWith("json") ? '{"pin":42}\n' : "#   Pin\n",
    );
  }
});

test("rename, deletion, executable mode and unusual filenames survive formatting", (t) => {
  const root = repository(t);
  write(root, "old.mjs", cleanCode);
  git(root, "add", "old.mjs");
  git(root, "commit", "-q", "-m", "old path");
  const path = "new name\nwith tab\t.mjs";
  git(root, "mv", "old.mjs", path);
  write(root, path, rawCode);
  git(root, "add", "--", path);
  git(root, "update-index", "--chmod=+x", "--", path);
  git(root, "rm", "notes.txt");
  git(root, "commit", "-q", "-m", "rename and delete");
  assert.equal(git(root, "show", `HEAD:${path}`), cleanCode);
  assert.match(git(root, "ls-tree", "HEAD", "--", path), /^100755 /u);
  assert.equal(tryGit(root, "show", "HEAD:old.mjs").status, 128);
  assert.equal(tryGit(root, "show", "HEAD:notes.txt").status, 128);
});

test("a parser failure leaves all staged and working bytes untouched", (t) => {
  const root = repository(t);
  write(root, "a.mjs", rawCode);
  write(root, "z.mjs", "const broken = {\n");
  git(root, "add", "a.mjs", "z.mjs");
  const before = head(root);
  const index = git(root, "ls-files", "--stage");
  const result = tryGit(root, "commit", "-q", "-m", "bad syntax");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pre-commit: unable to format staged files/u);
  assert.equal(head(root), before);
  assert.equal(git(root, "ls-files", "--stage"), index);
  assert.equal(readFileSync(join(root, "a.mjs"), "utf8"), rawCode);
});

test("missing or malformed staged policy refuses the commit", (t) => {
  for (const path of [".prettierrc.json", ".prettierignore"]) {
    const root = repository(t);
    const before = head(root);
    git(root, "rm", path);
    write(root, "code.mjs", rawCode);
    git(root, "add", "code.mjs");
    const result = tryGit(root, "commit", "-q", "-m", "missing policy");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing staged/u);
    assert.equal(head(root), before);
    assert.equal(git(root, "show", ":code.mjs"), rawCode);
  }
  const root = repository(t);
  write(root, ".prettierrc.json", "{invalid\n");
  git(root, "add", ".prettierrc.json");
  assert.notEqual(tryGit(root, "commit", "-q", "-m", "bad config").status, 0);
});

test("a missing formatter or dependency fails closed", (t) => {
  for (const tool of [false, true]) {
    const root = repository(t);
    const installation = mkdtempSync(join(tmpdir(), "hook-install-"));
    t.after(() => rmSync(installation, { force: true, recursive: true }));
    write(installation, "git-hooks/pre-commit", readFileSync(join(HOOKS, "pre-commit")));
    chmodSync(join(installation, "git-hooks/pre-commit"), 0o755);
    if (tool)
      write(
        installation,
        "format-staged.mjs",
        readFileSync(join(repoRoot, "tools/format-staged.mjs")),
      );
    git(root, "config", "core.hooksPath", join(installation, "git-hooks"));
    write(root, "code.mjs", rawCode);
    git(root, "add", "code.mjs");
    const before = head(root);
    const result = tryGit(root, "commit", "-q", "-m", "missing installation");
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      tool ? /unable to format staged files/u : /staged formatter is missing/u,
    );
    assert.equal(head(root), before);
    assert.equal(git(root, "show", ":code.mjs"), rawCode);
  }
});

test("symlinks and gitlinks are not dereferenced", (t) => {
  const root = repository(t);
  write(root, "untouched.txt", rawCode);
  symlinkSync("untouched.txt", join(root, "link.mjs"));
  git(root, "add", "link.mjs");
  git(root, "update-index", "--add", "--cacheinfo", `160000,${head(root)},nested.mjs`);
  git(root, "commit", "-q", "-m", "special modes");
  assert.equal(git(root, "show", "HEAD:link.mjs"), "untouched.txt");
  assert.equal(readFileSync(join(root, "untouched.txt"), "utf8"), rawCode);
  assert.match(git(root, "ls-tree", "HEAD", "nested.mjs"), /^160000 commit/u);
});

test("two worktrees commit independently without stash or shared index changes", (t) => {
  const root = repository(t);
  const linked = `${root}-linked`;
  t.after(() => rmSync(linked, { force: true, recursive: true }));
  git(root, "worktree", "add", "-q", "-b", "linked", linked);
  write(root, "code.mjs", rawCode);
  git(root, "add", "code.mjs");
  write(linked, "other.mjs", rawCode);
  git(linked, "add", "other.mjs");
  git(linked, "commit", "-q", "-m", "linked");
  assert.equal(git(root, "show", ":code.mjs"), rawCode);
  git(root, "commit", "-q", "-m", "primary");
  assert.equal(git(root, "show", "HEAD:code.mjs"), cleanCode);
  assert.equal(git(linked, "show", "HEAD:other.mjs"), cleanCode);
  assert.equal(git(root, "stash", "list"), "");
});

function failingGit(t, root, failure) {
  const directory = mkdtempSync(join(tmpdir(), "format-git-shim-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  write(
    directory,
    "git",
    `#!${process.execPath}
const {spawnSync} = require("node:child_process");
const {renameSync} = require("node:fs");
const {join} = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "update-index" && process.env.FORMAT_TEST_FAILURE === "index") process.exit(1);
const result = spawnSync(process.env.FORMAT_TEST_REAL_GIT, args, {stdio:"inherit"});
if (args[0] === "update-index" && result.status === 0 && process.env.FORMAT_TEST_FAILURE === "sync") {
 renameSync(join(process.cwd(), "src"), join(process.cwd(), "retained"));
}
process.exit(result.status ?? 1);
`,
  );
  chmodSync(join(directory, "git"), 0o755);
  write(
    directory,
    "pre-commit",
    '#!/bin/sh\nPATH="$FORMAT_TEST_SHIM:$PATH"\nexport PATH\nexec "$FORMAT_TEST_HOOK"\n',
  );
  chmodSync(join(directory, "pre-commit"), 0o755);
  git(root, "config", "core.hooksPath", directory);
  return spawnSync(realGit, ["commit", "-q", "-m", "injected failure"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      FORMAT_TEST_REAL_GIT: realGit,
      FORMAT_TEST_FAILURE: failure,
      FORMAT_TEST_SHIM: directory,
      FORMAT_TEST_HOOK: join(HOOKS, "pre-commit"),
    },
  });
}

test("index and worktree sync failures refuse the commit and preserve user content", (t) => {
  for (const failure of ["index", "sync"]) {
    const root = repository(t);
    write(root, "src/code.mjs", rawCode);
    git(root, "add", "src/code.mjs");
    const before = head(root);
    const result = failingGit(t, root, failure);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unable to format staged files/u);
    assert.equal(head(root), before);
    assert.equal(
      readFileSync(join(root, failure === "sync" ? "retained/code.mjs" : "src/code.mjs"), "utf8"),
      rawCode,
    );
    assert.equal(git(root, "show", ":src/code.mjs"), failure === "index" ? rawCode : cleanCode);
    assert.equal(git(root, "stash", "list"), "");
  }
});

test("the formatter rejects an unmerged active index without changing it", (t) => {
  const root = repository(t);
  const oid = git(root, "rev-parse", "HEAD:notes.txt").trim();
  const result = spawnSync("git", ["update-index", "--index-info"], {
    cwd: root,
    encoding: "utf8",
    input: `100644 ${oid} 1\tconflict.mjs\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  const before = git(root, "ls-files", "--stage");
  const check = spawnSync(process.execPath, [join(repoRoot, "tools/format-staged.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(check.status, 0);
  assert.match(check.stderr, /unmerged entries/u);
  assert.equal(git(root, "ls-files", "--stage"), before);
});

test("a real formatting commit leaves instruction and source-reference pins green", async (t) => {
  const { format } = await import("prettier");
  const { checkSectionLinks, loadSectionExceptions } = await import("../tools/section-links.mjs");
  const root = repository(t);
  const files = git(repoRoot, "ls-files", "-z").split("\0").filter(Boolean);
  for (const path of files) write(root, path, readFileSync(join(repoRoot, path)));
  git(root, "add", "--", ...files);
  git(root, "commit", "-q", "-m", "pin snapshot");
  const path = "tools/section-links.mjs";
  const source = readFileSync(join(root, path), "utf8");
  write(
    root,
    path,
    `${await format(source, { filepath: path, singleQuote: true, printWidth: 45 })}\n// Format regression.\n`,
  );
  write(
    root,
    "README.md",
    `${readFileSync(join(root, "README.md"), "utf8")}\n\nFormat regression.\n\n`,
  );
  git(root, "add", "--", path, "README.md");
  git(root, "commit", "-q", "-m", "pin-safe formatting");
  assert.deepEqual(checkSectionLinks({ root, exceptions: loadSectionExceptions(root) }), []);
  const pins = spawnSync(process.execPath, ["--test", "tests/instruction-contracts.test.mjs"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(pins.status, 0, `${pins.stdout}\n${pins.stderr}`);
});
