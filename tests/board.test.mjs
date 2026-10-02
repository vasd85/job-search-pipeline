// The board tools create and write git repositories, so every case here runs them over real git
// in disposable roots: an old repository to move from, an engine clone to nest the private one
// in, a bare repository standing in for the private remote, and clones of it standing in for two
// machines. No case points git at this repository except the one read-only listing that proves
// the layout covers every path its export list leaves behind. Every fixture path comes from
// `mkdtemp`.
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
import { isExcluded, loadExportExclusions } from "../tools/export-exclusions.mjs";
import { BOARD_README_TEMPLATE, LAYOUT, placeOf } from "../tools/board/init.mjs";
import { importDrafts } from "../tools/board/import.mjs";
import { BoardError } from "../tools/board/git.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INIT = join(repoRoot, "tools", "board", "init.mjs");
const IMPORT = join(repoRoot, "tools", "board", "import.mjs");

const configRoot = mkdtempSync(join(tmpdir(), "board-gitconfig-"));
const globalConfig = join(configRoot, "gitconfig");
writeFileSync(globalConfig, [
  "[user]", "\tname = Board Probe", "\temail = probe@example.com",
  "[init]", "\tdefaultBranch = main",
  "[commit]", "\tgpgsign = false",
  "[tag]", "\tgpgsign = false", "",
].join("\n"));
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
  "board_init_engine_not_a_checkout",
  "board_init_engine_sees_layer",
  "board_init_exclusions_unreadable",
  "board_init_git_failed",
  "board_init_layer_not_ignored",
  "board_init_path_collision",
  "board_init_push_failed",
  "board_init_source_unreadable",
  "board_init_target_not_empty",
  "board_init_unmapped_path",
  "board_init_unsupported_entry",
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
  return `---\nid: ${id}\ntype: ${type}\ntitle: ${title}\nstatus: open\npriority: p2\ncreated: 2026-09-01\n`
    + `source: probe\ndepends: []\n${extra}---\n\n## Acceptance\n\nNone.\n`;
}

const FIXTURE_EXCLUSIONS = {
  schema_version: 1,
  purpose: "probe",
  exclude: [
    { path: "docs/backlog/", kind: "directory", why: "probe" },
    { path: "docs/archive/", kind: "directory", why: "probe" },
    { path: "docs/research/", kind: "directory", why: "probe" },
    { path: "docs/audits/", kind: "directory", why: "probe" },
    { path: "docs/product-decisions.md", kind: "file", why: "probe" },
    { path: "reference/", kind: "directory", why: "probe" },
    { path: "docs/adr/0004-private.md", kind: "file", why: "probe" },
  ],
  keep: [{ path: "docs/backlog/README.md", why: "probe" }],
};

/** An old repository with one file in every area the layout places, and public files beside. */
function oldRepository(root, { exclusions = FIXTURE_EXCLUSIONS, extra = {} } = {}) {
  const files = {
    "README.md": "public\n",
    "config/export-exclusions.json": `${JSON.stringify(exclusions, null, 2)}\n`,
    "docs/adr/0001-public.md": "public decision\n",
    "docs/adr/0004-private.md": "private decision\n",
    "docs/archive/backlog/005-bug-closed.md": task(5, "bug", "closed"),
    "docs/archive/plans/plan.md": "old plan\n",
    "docs/audits/audit.md": "audit\n",
    "docs/backlog/007-feat-open.md": task(7, "feat", "open"),
    "docs/backlog/README.md": "old format\n",
    "docs/product-decisions.md": "directions\n",
    "docs/research/study.md": "study\n",
    "reference/report.md": "report\n",
    ...extra,
  };
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "old");
  return root;
}

function engineClone(root, { ignore = "/candidate/\n" } = {}) {
  git(root, "init", "-q");
  write(root, "README.md", "engine\n");
  if (ignore !== null) write(root, ".gitignore", ignore);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "engine");
  return root;
}

function fixture(t, options = {}) {
  const base = temporary(t, "init");
  const source = oldRepository(join(base, "old"), options);
  mkdirSync(join(base, "engine"));
  const engine = engineClone(join(base, "engine"), options);
  const layer = join(base, "layer");
  write(layer, "config.json", "{\"schema_version\": 1}\n");
  write(layer, "research/letter.md", "corpus\n");
  for (const [path, text] of Object.entries(options.layerExtra ?? {})) write(layer, path, text);
  return { base, engine, layer, source };
}

test("board:init nests the private repository, places every excluded path and the engine does not see it", (t) => {
  const { base, engine, layer, source } = fixture(t);
  const bare = join(base, "private.git");
  git(base, "init", "-q", "--bare", bare);
  const result = run(INIT, ["--source", source, "--engine", engine, "--layer", layer, "--remote", bare]);
  assert.equal(result.status, 0, JSON.stringify(result.err));
  assert.equal(result.out.status, "created");
  assert.equal(result.out.pushed, true);

  const target = join(engine, "candidate");
  const expected = {
    ".gitignore": ".DS_Store\n",
    "archive/plans/plan.md": "old plan\n",
    "board/007-feat-open.md": task(7, "feat", "open"),
    "board/done/005-bug-closed.md": task(5, "bug", "closed"),
    "config.json": "{\"schema_version\": 1}\n",
    "decisions/0004-private.md": "private decision\n",
    "decisions/product-decisions.md": "directions\n",
    "research/audits/audit.md": "audit\n",
    "research/letter.md": "corpus\n",
    "research/reference/report.md": "report\n",
    "research/study.md": "study\n",
  };
  for (const [path, text] of Object.entries(expected)) {
    assert.equal(readFileSync(join(target, path), "utf8"), text, path);
  }
  assert.equal(readFileSync(join(target, "board", "README.md"), "utf8"), readFileSync(BOARD_README_TEMPLATE, "utf8"));
  // What the export keeps is public and stays where it is.
  for (const path of ["README.md", "decisions/0001-public.md", "docs"]) {
    assert.equal(existsSync(join(target, path)), false, path);
  }
  const tracked = git(target, "ls-files").trim().split("\n").sort();
  assert.deepEqual(tracked, [...Object.keys(expected), "board/README.md"].sort());
  assert.equal(git(target, "rev-list", "--count", "main").trim(), "1");
  assert.match(git(target, "log", "-1", "--format=%B"), new RegExp(`Source commit: ${git(source, "rev-parse", "HEAD").trim()}`));
  assert.equal(git(bare, "rev-parse", "main").trim(), result.out.commit);

  // The engine does not see it: a clean status, and an archive of the engine without it.
  assert.equal(git(engine, "status", "--porcelain", "--untracked-files=all"), "");
  const archive = spawnSync("git", ["archive", "--format=tar", "HEAD"], { cwd: engine });
  const listing = spawnSync("tar", ["-t"], { input: archive.stdout, encoding: "utf8" }).stdout.split("\n");
  assert.deepEqual(listing.filter(Boolean).sort(), [".gitignore", "README.md"]);
});

test("board:init refuses before writing anything", async (t) => {
  await t.test("the engine does not ignore candidate/", (tt) => {
    const { engine, source } = fixture(tt, { ignore: null });
    const result = run(INIT, ["--source", source, "--engine", engine]);
    assert.equal(result.err.error.code, "board_init_layer_not_ignored");
    assert.equal(existsSync(join(engine, "candidate")), false);
  });
  await t.test("candidate/ is not empty", (tt) => {
    const { engine, source } = fixture(tt);
    write(engine, "candidate/keep.md", "mine\n");
    const result = run(INIT, ["--source", source, "--engine", engine]);
    assert.equal(result.err.error.code, "board_init_target_not_empty");
    assert.equal(readFileSync(join(engine, "candidate", "keep.md"), "utf8"), "mine\n");
  });
  await t.test("an excluded path has no place", (tt) => {
    const exclusions = {
      ...FIXTURE_EXCLUSIONS,
      exclude: [...FIXTURE_EXCLUSIONS.exclude, { path: "docs/runbooks/", kind: "directory", why: "probe" }],
    };
    const { engine, source } = fixture(tt, { exclusions, extra: { "docs/runbooks/flow.md": "flow\n" } });
    const result = run(INIT, ["--source", source, "--engine", engine]);
    assert.equal(result.err.error.code, "board_init_unmapped_path");
    assert.match(result.err.error.message, /docs\/runbooks\/flow\.md/u);
    assert.equal(existsSync(join(engine, "candidate")), false);
  });
  await t.test("two sources land on one path", (tt) => {
    const { engine, layer, source } = fixture(tt, { layerExtra: { "research/study.md": "other\n" } });
    const result = run(INIT, ["--source", source, "--engine", engine, "--layer", layer]);
    assert.equal(result.err.error.code, "board_init_path_collision");
    assert.equal(existsSync(join(engine, "candidate")), false);
  });
  await t.test("the commit does not exist", (tt) => {
    const { engine, source } = fixture(tt);
    const result = run(INIT, ["--source", source, "--rev", "no-such-commit", "--engine", engine]);
    assert.equal(result.err.error.code, "board_init_source_unreadable");
  });
  await t.test("only committed content moves", (tt) => {
    const { engine, source } = fixture(tt);
    write(source, "docs/backlog/007-feat-open.md", "uncommitted edit\n");
    const result = run(INIT, ["--source", source, "--engine", engine]);
    assert.equal(result.status, 0, JSON.stringify(result.err));
    assert.equal(readFileSync(join(engine, "candidate", "board", "007-feat-open.md"), "utf8"), task(7, "feat", "open"));
  });
});

test("the layout places every path this repository's export list leaves behind", () => {
  // Read-only over this repository: its tracked list and its own exclusion file. A path added to
  // the list without a row here would stay in a repository nobody publishes.
  const exclusions = loadExportExclusions({ root: repoRoot });
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(listed.status, 0);
  const excluded = listed.stdout.split("\0").filter(Boolean).filter((path) => isExcluded(path, exclusions));
  for (const path of excluded) assert.notEqual(placeOf(path), null, path);
  // The rows themselves, frozen: where each area lands is the private repository's layout.
  assert.deepEqual(LAYOUT.map((row) => [row.from, row.to]), [
    ["config/section-link-source-exceptions.json", "archive/pre-switch/section-link-source-exceptions.json"],
    ["docs/backlog/README.md", "archive/pre-switch/backlog-README.md"],
    ["docs/runbooks/development-gitflow.md", "archive/pre-switch/development-gitflow.md"],
    ["tests/legacy-governance.test.mjs", "archive/pre-switch/legacy-governance.test.mjs"],
    ["config/source-layout.json", "archive/pre-switch/source-layout.json"],
    ["docs/archive/backlog/", "board/done/"],
    ["docs/backlog/", "board/"],
    ["docs/archive/", "archive/"],
    ["docs/adr/", "decisions/"],
    ["docs/product-decisions.md", "decisions/product-decisions.md"],
    ["docs/audits/", "research/audits/"],
    ["docs/research/", "research/"],
    ["reference/", "research/reference/"],
  ]);
});

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
  return `---\ntype: ${type}\ntitle: ${title}\nstatus: open\npriority: p2\ncreated: 2026-09-23\n`
    + `source: a run\ndepends: []\ndraft_id: ${draftId}\n${extra}---\n\n## Facts\n\nObserved.\n`;
}

function putDraft(ops, name, text) {
  writeFileSync(join(ops, "outbox", "tasks", name), text);
}

function pairs(ops) {
  return JSON.parse(readFileSync(join(ops, "outbox", "tasks", ".imported.json"), "utf8")).imported;
}

function staged(root) {
  return git(root, "status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean).sort();
}

test("board:import numbers the draft, commits only its file, pushes, records the pair and deletes the draft", (t) => {
  const { a, bare, ops } = importFixture(t);
  putDraft(ops, "new-thing.md", draft());
  // Another session's work in progress in the shared clone: staged, not ours to commit.
  write(a, "board/scratch.md", "half done\n");
  git(a, "add", "board/scratch.md");

  const result = run(IMPORT, ["--ops-root", ops, "--board-root", a]);
  assert.equal(result.status, 0, JSON.stringify(result.err));
  assert.deepEqual(result.out.imported, [{ draft_id: "20260923-a1", file: "board/003-feat-new-thing.md", id: 3 }]);

  const text = readFileSync(join(a, "board", "003-feat-new-thing.md"), "utf8");
  assert.equal(text, `---\nid: 3\n${draft().slice(4)}`);
  assert.deepEqual(git(a, "show", "--name-only", "--format=", "HEAD").trim().split("\n"), ["board/003-feat-new-thing.md"]);
  assert.match(git(a, "log", "-1", "--format=%B"), /Board-Import-Draft: 20260923-a1/u);
  assert.deepEqual(staged(a), ["A  board/scratch.md"]);
  assert.equal(git(bare, "rev-parse", "main").trim(), git(a, "rev-parse", "HEAD").trim());
  assert.deepEqual(pairs(ops), [{ draft_id: "20260923-a1", file: "board/003-feat-new-thing.md", id: 3 }]);
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
  assert.throws(() => importDrafts({
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
  }), (error) => error instanceof BoardError && error.code === "board_import_push_refused");
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
  assert.throws(() => importDrafts({
    boardRoot: a,
    hooks: { beforePush: () => { throw new Error("interrupted"); } },
    opsRoot: ops,
  }), /interrupted/u);
  assert.notEqual(git(bare, "rev-parse", "main").trim(), git(a, "rev-parse", "HEAD").trim());

  const again = run(IMPORT, ["--ops-root", ops, "--board-root", a]);
  assert.equal(again.status, 0, JSON.stringify(again.err));
  assert.deepEqual(again.out.imported, [{ draft_id: "20260923-a1", file: "board/003-feat-new-thing.md", id: 3 }]);
  assert.equal(git(bare, "rev-parse", "main").trim(), git(a, "rev-parse", "HEAD").trim());
  assert.equal(git(bare, "ls-tree", "--name-only", "main", "board/").split("\n").filter((line) => line.includes("new-thing")).length, 1);
  assert.equal(existsSync(join(ops, "outbox", "tasks", "new-thing.md")), false);
});

test("a run interrupted before its push, then overtaken, is taken back and refused, and the next run imports", (t) => {
  const { a, b, ops } = importFixture(t);
  putDraft(ops, "new-thing.md", draft());
  const before = git(a, "rev-parse", "HEAD").trim();
  assert.throws(() => importDrafts({
    boardRoot: a,
    hooks: { beforePush: () => { throw new Error("interrupted"); } },
    opsRoot: ops,
  }), /interrupted/u);
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
  writeFileSync(join(ops, "outbox", "tasks", ".imported.json"),
    `${JSON.stringify({ imported: [{ draft_id: "20260923-a1", file: "board/003-feat-new-thing.md", id: 3 }], schema_version: 1 })}\n`);
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
  const sources = ["init.mjs", "import.mjs", "git.mjs", "draft.mjs"]
    .map((name) => readFileSync(join(repoRoot, "tools", "board", name), "utf8")).join("\n");
  const thrown = [...new Set([...sources.matchAll(/"(board_[a-z_]+)"/gu)].map((match) => match[1]))].sort();
  assert.deepEqual(thrown, PINNED_CODES);
});

test("migration preserves old owners separately from the generated board README", (t) => {
  const base = temporary(t, "pre-switch");
  const paths = ["docs/runbooks/development-gitflow.md", "tests/legacy-governance.test.mjs", "config/source-layout.json", "config/section-link-source-exceptions.json"];
  const exclusions = { ...FIXTURE_EXCLUSIONS, keep: [], exclude: [...FIXTURE_EXCLUSIONS.exclude, ...paths.map(path => ({path, kind:"file", why:"Source-only fixture."}))] };
  const source = oldRepository(join(base, "source"), { exclusions, extra: Object.fromEntries(paths.map(path => [path, `Saved ${path}\n`])) });
  mkdirSync(join(base, "engine"));
  const engine = engineClone(join(base, "engine"));
  const result = run(INIT, ["--source", source, "--engine", engine]);
  assert.equal(result.status, 0, JSON.stringify(result.err));
  assert.equal(readFileSync(join(engine, "candidate/archive/pre-switch/backlog-README.md"), "utf8"), "old format\n");
  assert.equal(readFileSync(join(engine, "candidate/board/README.md"), "utf8"), readFileSync(BOARD_README_TEMPLATE, "utf8"));
  for (const name of ["development-gitflow.md", "legacy-governance.test.mjs", "source-layout.json", "section-link-source-exceptions.json"]) assert.ok(existsSync(join(engine, "candidate/archive/pre-switch", name)));
});
