// Board imports run over disposable git roots and remotes.
//
// Git reads a throwaway global config written below, so neither the operator's identity nor a
// signing or hook setting of theirs changes what a case observes.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { importDrafts } from "../tools/board/import.mjs";
import { BoardError } from "../tools/board/git.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMPORT = join(repoRoot, "tools", "board", "import.mjs");

const configRoot = mkdtempSync(join(tmpdir(), "board-gitconfig-"));
const globalConfig = join(configRoot, "gitconfig");
writeFileSync(
  globalConfig,
  [
    "[user]",
    "\tname = Board Probe",
    "\temail = probe@example.com",
    "[init]",
    "\tdefaultBranch = main",
    "[commit]",
    "\tgpgsign = false",
    "[tag]",
    "\tgpgsign = false",
    "",
  ].join("\n"),
);
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete process.env[key];
test.after(() => rmSync(configRoot, { force: true, recursive: true }));

// The refusal codes of both commands, frozen here as a literal rather than read from the module:
// the README names the same set, and every code the sources can throw is in it.
const PINNED_CODES = [
  "board_failed",
  "board_git_failed",
  "board_import_diverged",
  "board_import_draft_conflict",
  "board_import_draft_duplicate",
  "board_import_draft_invalid",
  "board_import_git_failed",
  "board_import_imported_unreadable",
  "board_import_locked",
  "board_import_needs_repair",
  "board_import_no_upstream",
  "board_import_pull_refused",
  "board_import_push_refused",
  "board_import_root_not_a_clone",
  "board_import_target_exists",
  "board_invalid_arguments",
  "board_not_in_a_checkout",
];

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const parse = (text) => (text.trim() ? JSON.parse(text.trim().split("\n").pop()) : null);
  return { err: parse(result.stderr), out: parse(result.stdout), status: result.status };
}

function temporary(t, label) {
  const root = mkdtempSync(join(tmpdir(), `board-${label}-`));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

function task(id, type, title, extra = "") {
  return (
    `---\nid: ${id}\ntype: ${type}\ntitle: ${title}\nstatus: open\npriority: p2\ncreated: 2026-09-01\n` +
    `source: probe\ndepends: []\n${extra}---\n\n## Acceptance\n\nNone.\n`
  );
}

// --- board:import ---------------------------------------------------------------------------

const README = "# Board\n";

/** A private remote with a board, one clone per machine, and an operational folder. */
function importFixture(t) {
  const base = temporary(t, "import");
  const bare = join(base, "private.git");
  git(base, "init", "-q", "--bare", bare);
  const seed = join(base, "seed");
  git(base, "clone", "-q", bare, seed);
  write(seed, "board/README.md", README);
  write(seed, "board/001-feat-first.md", task(1, "feat", "first"));
  write(seed, "board/done/002-bug-second.md", task(2, "bug", "second"));
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "main");
  const a = join(base, "a");
  const b = join(base, "b");
  git(base, "clone", "-q", bare, a);
  git(base, "clone", "-q", bare, b);
  const ops = join(base, "ops");
  mkdirSync(join(ops, "outbox", "tasks"), { recursive: true });
  return { a, b, bare, base, ops };
}

function draft({ draftId = "20260923-a1", title = "new thing", type = "feat", extra = "" } = {}) {
  return (
    `---\ntype: ${type}\ntitle: ${title}\nstatus: open\npriority: p2\ncreated: 2026-09-23\n` +
    `source: a run\ndepends: []\ndraft_id: ${draftId}\n${extra}---\n\n## Facts\n\nObserved.\n`
  );
}

function putDraft(ops, name, text) {
  writeFileSync(join(ops, "outbox", "tasks", name), text);
}

function pairs(ops) {
  return JSON.parse(readFileSync(join(ops, "outbox", "tasks", ".imported.json"), "utf8")).imported;
}

function staged(root) {
  return git(root, "status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .filter(Boolean)
    .sort();
}

test("board:import numbers the draft, commits only its file, pushes, records the pair and deletes the draft", (t) => {
  const { a, bare, ops } = importFixture(t);
  putDraft(ops, "new-thing.md", draft());
  // Another session's work in progress in the shared clone: staged, not ours to commit.
  write(a, "board/scratch.md", "half done\n");
  git(a, "add", "board/scratch.md");

  const result = run(IMPORT, ["--ops-root", ops, "--board-root", a]);
  assert.equal(result.status, 0, JSON.stringify(result.err));
  assert.deepEqual(result.out.imported, [
    { draft_id: "20260923-a1", file: "board/003-feat-new-thing.md", id: 3 },
  ]);

  const text = readFileSync(join(a, "board", "003-feat-new-thing.md"), "utf8");
  assert.equal(text, `---\nid: 3\n${draft().slice(4)}`);
  assert.deepEqual(git(a, "show", "--name-only", "--format=", "HEAD").trim().split("\n"), [
    "board/003-feat-new-thing.md",
  ]);
  assert.match(git(a, "log", "-1", "--format=%B"), /Board-Import-Draft: 20260923-a1/u);
  assert.deepEqual(staged(a), ["A  board/scratch.md"]);
  assert.equal(git(bare, "rev-parse", "main").trim(), git(a, "rev-parse", "HEAD").trim());
  assert.deepEqual(pairs(ops), [
    { draft_id: "20260923-a1", file: "board/003-feat-new-thing.md", id: 3 },
  ]);
  assert.equal(existsSync(join(ops, "outbox", "tasks", "new-thing.md")), false);
});

test("board:import takes the number above every task, open or done", (t) => {
  const { a, b, ops } = importFixture(t);
  write(b, "board/done/040-feat-late.md", task(40, "feat", "late"));
  git(b, "add", "-A");
  git(b, "commit", "-q", "-m", "late");
  git(b, "push", "-q", "origin", "main");
  putDraft(ops, "new-thing.md", draft());
  const result = run(IMPORT, ["--ops-root", ops, "--board-root", a]);
  assert.equal(result.status, 0, JSON.stringify(result.err));
  assert.equal(result.out.imported[0].file, "board/041-feat-new-thing.md");
});

test("a pull refused on a dirty clone names the file git named, and the draft stays", (t) => {
  const { a, b, ops } = importFixture(t);
  write(b, "board/README.md", `${README}changed\n`);
  git(b, "commit", "-q", "-am", "readme");
  git(b, "push", "-q", "origin", "main");
  write(a, "board/README.md", `${README}mine\n`);
  write(a, "board/other.md", "unrelated and dirty\n");
  putDraft(ops, "new-thing.md", draft());
  const result = run(IMPORT, ["--ops-root", ops, "--board-root", a]);
  assert.equal(result.err.error.code, "board_import_pull_refused");
  assert.match(result.err.error.message, /board\/README\.md/u);
  assert.doesNotMatch(result.err.error.message, /other\.md/u);
  assert.equal(existsSync(join(ops, "outbox", "tasks", "new-thing.md")), true);
});

test("another machine taking the number first is a refusal: the commit is taken back, the draft and the index stay", (t) => {
  const { a, b, ops } = importFixture(t);
  putDraft(ops, "new-thing.md", draft());
  write(a, "board/scratch.md", "half done\n");
  git(a, "add", "board/scratch.md");
  const before = git(a, "rev-parse", "HEAD").trim();
  assert.throws(
    () =>
      importDrafts({
        boardRoot: a,
        hooks: {
          beforePush: () => {
            write(b, "board/003-feat-rival.md", task(3, "feat", "rival"));
            git(b, "add", "-A");
            git(b, "commit", "-q", "-m", "rival");
            git(b, "push", "-q", "origin", "main");
          },
        },
        opsRoot: ops,
      }),
    (error) => error instanceof BoardError && error.code === "board_import_push_refused",
  );
  assert.equal(git(a, "rev-parse", "HEAD").trim(), before);
  assert.equal(existsSync(join(a, "board", "003-feat-new-thing.md")), false);
  assert.deepEqual(staged(a), ["A  board/scratch.md"]);
  assert.equal(existsSync(join(ops, "outbox", "tasks", "new-thing.md")), true);

  // The next run pulls the rival and takes the next number.
  const again = run(IMPORT, ["--ops-root", ops, "--board-root", a]);
  assert.equal(again.status, 0, JSON.stringify(again.err));
  assert.equal(again.out.imported[0].file, "board/004-feat-new-thing.md");
});

test("a run interrupted before its push is finished by the next one, not filed twice", (t) => {
  const { a, bare, ops } = importFixture(t);
  putDraft(ops, "new-thing.md", draft());
  assert.throws(
    () =>
      importDrafts({
        boardRoot: a,
        hooks: {
          beforePush: () => {
            throw new Error("interrupted");
          },
        },
        opsRoot: ops,
      }),
    /interrupted/u,
  );
  assert.notEqual(git(bare, "rev-parse", "main").trim(), git(a, "rev-parse", "HEAD").trim());

  const again = run(IMPORT, ["--ops-root", ops, "--board-root", a]);
  assert.equal(again.status, 0, JSON.stringify(again.err));
  assert.deepEqual(again.out.imported, [
    { draft_id: "20260923-a1", file: "board/003-feat-new-thing.md", id: 3 },
  ]);
  assert.equal(git(bare, "rev-parse", "main").trim(), git(a, "rev-parse", "HEAD").trim());
  assert.equal(
    git(bare, "ls-tree", "--name-only", "main", "board/")
      .split("\n")
      .filter((line) => line.includes("new-thing")).length,
    1,
  );
  assert.equal(existsSync(join(ops, "outbox", "tasks", "new-thing.md")), false);
});

test("a run interrupted before its push, then overtaken, is taken back and refused, and the next run imports", (t) => {
  const { a, b, ops } = importFixture(t);
  putDraft(ops, "new-thing.md", draft());
  const before = git(a, "rev-parse", "HEAD").trim();
  assert.throws(
    () =>
      importDrafts({
        boardRoot: a,
        hooks: {
          beforePush: () => {
            throw new Error("interrupted");
          },
        },
        opsRoot: ops,
      }),
    /interrupted/u,
  );
  write(b, "board/003-feat-rival.md", task(3, "feat", "rival"));
  git(b, "add", "-A");
  git(b, "commit", "-q", "-m", "rival");
  git(b, "push", "-q", "origin", "main");

  const refused = run(IMPORT, ["--ops-root", ops, "--board-root", a]);
  assert.equal(refused.err.error.code, "board_import_diverged");
  assert.equal(git(a, "rev-parse", "HEAD").trim(), before);
  assert.equal(existsSync(join(ops, "outbox", "tasks", "new-thing.md")), true);

  const again = run(IMPORT, ["--ops-root", ops, "--board-root", a]);
  assert.equal(again.status, 0, JSON.stringify(again.err));
  assert.equal(again.out.imported[0].file, "board/004-feat-new-thing.md");
});

test("a draft already recorded is only deleted", (t) => {
  const { a, ops } = importFixture(t);
  putDraft(ops, "new-thing.md", draft());
  writeFileSync(
    join(ops, "outbox", "tasks", ".imported.json"),
    `${JSON.stringify({ imported: [{ draft_id: "20260923-a1", file: "board/003-feat-new-thing.md", id: 3 }], schema_version: 1 })}\n`,
  );
  const head = git(a, "rev-parse", "HEAD").trim();
  const result = run(IMPORT, ["--ops-root", ops, "--board-root", a]);
  assert.equal(result.status, 0, JSON.stringify(result.err));
  assert.equal(git(a, "rev-parse", "HEAD").trim(), head);
  assert.equal(existsSync(join(ops, "outbox", "tasks", "new-thing.md")), false);
});

test("board:import refuses a draft it cannot file", async (t) => {
  const cases = [
    ["a draft with a number", "numbered.md", draft({ extra: "id: 9\n" })],
    ["a draft without a draft_id", "anonymous.md", draft().replace("draft_id: 20260923-a1\n", "")],
    ["a draft of an unknown type", "odd.md", draft({ type: "chore" })],
    ["a draft named outside kebab-case", "Not_Kebab.md", draft()],
    ["a draft already claimed", "claimed.md", draft({ extra: "claim:\n  runner: probe\n" })],
  ];
  for (const [label, name, text] of cases) {
    await t.test(label, (tt) => {
      const { a, ops } = importFixture(tt);
      putDraft(ops, name, text);
      const result = run(IMPORT, ["--ops-root", ops, "--board-root", a]);
      assert.equal(result.err.error.code, "board_import_draft_invalid");
      assert.equal(existsSync(join(ops, "outbox", "tasks", name)), true);
    });
  }
  await t.test("two drafts with one draft_id", (tt) => {
    const { a, ops } = importFixture(tt);
    putDraft(ops, "one.md", draft());
    putDraft(ops, "two.md", draft());
    const result = run(IMPORT, ["--ops-root", ops, "--board-root", a]);
    assert.equal(result.err.error.code, "board_import_draft_duplicate");
  });
  await t.test("a board root that is not the root of its own clone", (tt) => {
    const { a, ops } = importFixture(tt);
    putDraft(ops, "new-thing.md", draft());
    mkdirSync(join(a, "nested", "board"), { recursive: true });
    const result = run(IMPORT, ["--ops-root", ops, "--board-root", join(a, "nested")]);
    assert.equal(result.err.error.code, "board_import_root_not_a_clone");
  });
});

test("the refusal codes are the ones the README lists and the sources throw", () => {
  const readme = readFileSync(join(repoRoot, "tools", "board", "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("## Refusal codes"));
  const listed = [...section.matchAll(/`(board_[a-z_]+)`/gu)].map((match) => match[1]).sort();
  assert.deepEqual(listed, PINNED_CODES);
  const sources = ["import.mjs", "git.mjs", "draft.mjs"]
    .map((name) => readFileSync(join(repoRoot, "tools", "board", name), "utf8"))
    .join("\n");
  const thrown = [
    ...new Set([...sources.matchAll(/"(board_[a-z_]+)"/gu)].map((match) => match[1])),
  ].sort();
  assert.deepEqual(thrown, PINNED_CODES);
});
