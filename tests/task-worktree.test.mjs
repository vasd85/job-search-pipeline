// The tool under test creates git worktrees, so this file drives it over real git topologies in
// disposable roots: a primary checkout standing in for the operational one, a linked `main`
// worktree beside it, and the task tree the tool is asked to create. Every behavioural case runs
// the CLI as a real child process, so the exit code and the bounded refusal on stderr are the
// observed contract rather than a return value.
//
// No case touches this repository's own worktrees, its object database or its dependency tree.
// That discipline is stated here because the tripwire in the gate's own suite catches only
// `mkdirSync`/`writeFileSync`/`rmSync` aimed at `repoRoot`; a git child pointed at the real
// repository would slip past it, and a worktree created there would write into the shared object
// database this file is running from. Every fixture path below comes from `mkdtemp`.
//
// The cv-builder tree in each fixture is synthetic — a manifest, a lockfile and one package named
// `docx` — but the checker run against it is the real one, so what the cases prove about
// provisioning is proved through the oracle the tool actually uses.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DEPENDENCY_TYPES,
  INTEGRATION_BRANCH,
  PREFLIGHT_CHECKS,
  SESSION_OWES_SELF_REPORT,
  SESSION_OWES_START_CONFIRMATION,
  TASK_BRANCH_PREFIX,
  TASK_ID_WIDTH,
  WORKTREE_LANES,
  npmInstallArgs,
  parseDependencies,
  parseTaskDocument,
  runTaskWorktree,
} from "../tools/task-worktree.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toolPath = join(repoRoot, "tools", "task-worktree.mjs");

// The eight read-only commands of runbook the pre-switch development procedure, in its order, frozen independently of the
// module that owns them. A check silently dropped here would leave the tool reporting a preflight
// it never ran; one silently added would report a check the runbook does not ask for.
const PINNED_PREFLIGHT_CHECKS = [
  "pwd",
  "repository-root",
  "branch",
  "head",
  "status",
  "worktree-list",
  "rehearsal-branches",
  "task-file",
];

// The install spelling, frozen as a literal rather than derived from the module: the three flags
// are the point of the pin. Without `--ignore-scripts` the fallback runs dependency lifecycle
// scripts, because npm reads project config from `${prefix}/.npmrc` and the builder has none.
const PINNED_INSTALL_ARGS = [
  "ci",
  "--prefix",
  "/probe/tools/cv-builder",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
];

// The three link types of `docs/backlog/README.md`, frozen independently of the module that
// exports them. A fourth type added to the tool would accept a `depends` entry the README does not
// define; one removed would refuse an entry the board already carries.
const PINNED_DEPENDENCY_TYPES = ["blocker", "epic", "related"];

const DEPENDENCIES = { docx: "9.9.9" };
const ENGINES = { node: "24.18.0", npm: "11.16.0" };
const IGNORE_FILE = ["node_modules/", "output/", ""].join("\n");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** A minimal well-formed board file: the frontmatter the guard reads, and nothing else. */
function boardTask({ depends = "[]", id, status, type }) {
  return `---
id: ${id}
type: ${type}
title: probe ${id}
status: ${status}
priority: p2
created: 2026-08-31
depends: ${depends}
---

## Acceptance

None.
`;
}

/**
 * The board every dependency case resolves against, written into the fixture before its seed
 * commit because the guard reads `main:`, not the working tree.
 */
const BOARD = [
  ["docs/backlog", "070-feat-open.md", boardTask({ id: 70, status: "open", type: "feat" })],
  ["docs/archive/backlog", "071-feat-unfinished.md",
    boardTask({ id: 71, status: "in-progress", type: "feat" })],
  ["docs/archive/backlog", "072-feat-closed.md", boardTask({ id: 72, status: "done", type: "feat" })],
  ["docs/backlog", "073-epic-open.md",
    boardTask({ depends: "[{blocker: 72}]", id: 73, status: "open", type: "epic" })],
  ["docs/archive/backlog", "074-epic-closed.md",
    boardTask({ id: 74, status: "done", type: "epic" })],
  // Two blockers, the met one first: a walk that stopped after the first entry would pass this.
  ["docs/backlog", "075-epic-waiting.md",
    boardTask({ depends: "[{blocker: 72}, {blocker: 70}]", id: 75, status: "open", type: "epic" })],
  ["docs/backlog", "076-epic-gated.md",
    boardTask({ depends: '[{blocker: "PD open question: a policy"}]', id: 76, status: "open", type: "epic" })],
  // 077's own epic entry points at 075, whose blocker is unmet: the walk passes only because it
  // stops at one level, so a tool that recursed one step further would refuse this fixture.
  ["docs/backlog", "077-epic-chained.md",
    boardTask({ depends: "[{epic: 75}, {blocker: 72}]", id: 77, status: "open", type: "epic" })],
].map(([dir, name, text]) => ({ dir, name, text }));

/** A source tree the real dependency checker accepts, minus the installed packages. */
function seedBuilderSource(root) {
  const builder = join(root, "tools", "cv-builder");
  mkdirSync(builder, { recursive: true });
  writeFileSync(join(builder, "package.json"), JSON.stringify({
    name: "cv-builder",
    private: true,
    type: "commonjs",
    engines: ENGINES,
    dependencies: DEPENDENCIES,
  }, null, 2));
  writeFileSync(join(builder, "package-lock.json"), JSON.stringify({
    name: "cv-builder",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "cv-builder", engines: ENGINES, dependencies: DEPENDENCIES },
      "node_modules/docx": { version: DEPENDENCIES.docx },
    },
  }, null, 2));
  writeFileSync(join(builder, "render.js"), "module.exports = {};\n");
}

/** The installed half, including the relative link the verbatim copy has to preserve. */
function seedDependencies(root, { version = DEPENDENCIES.docx } = {}) {
  const modules = join(root, "tools", "cv-builder", "node_modules");
  mkdirSync(join(modules, "docx"), { recursive: true });
  mkdirSync(join(modules, ".bin"), { recursive: true });
  writeFileSync(
    join(modules, "docx", "package.json"),
    JSON.stringify({ name: "docx", version, main: "index.js" }),
  );
  writeFileSync(join(modules, "docx", "index.js"), "module.exports = {};\n");
  symlinkSync("../docx/index.js", join(modules, ".bin", "docx-probe"));
}

function taskDocument({ claim, depends, plan, status }) {
  const claimBlock = claim === null
    ? ""
    : `claim:\n${Object.entries(claim).map(([key, value]) => `  ${key}: ${value}`).join("\n")}\n`;
  const planBlock = plan === "none"
    ? ""
    : `\n## Plan\n\n${plan === "confirmed" ? "### Start confirmation\n\nGiven.\n" : "Approach.\n"}`;
  return `---
id: 68
type: feat
title: probe
status: ${status}
priority: p2
created: 2026-08-31
depends: ${depends}
${claimBlock}---
${planBlock}`;
}

/**
 * Primary checkout on `ops/current` — the shape of the real machine, where the operational
 * tree is the primary one — with `main` in a linked worktree beside it and the dependency tree
 * installed there, because `git worktree add` does not carry an ignored directory.
 */
function topology(t, {
  boardFiles = [],
  claim = {},
  claimBlock = true,
  dependencies = true,
  depends = "[]",
  extraTaskFiles = [],
  plan = "confirmed",
  status = "in-progress",
} = {}) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "task-worktree-"));
  t.after(() => rmSync(base, { force: true, recursive: true }));
  const primary = join(base, "pipeline");
  const linkedMain = join(base, "pipeline-worktrees", INTEGRATION_BRANCH);
  const worktree = join(base, "pipeline-worktrees", "tasks", "068-probe");

  mkdirSync(join(primary, "docs", "backlog"), { recursive: true });
  writeFileSync(join(primary, ".gitignore"), IGNORE_FILE);
  seedBuilderSource(primary);
  const taskFile = "068-feat-probe.md";
  writeFileSync(join(primary, "docs", "backlog", taskFile), taskDocument({
    claim: claimBlock
      ? {
        runner: "claude-code",
        branch: `${TASK_BRANCH_PREFIX}068-probe`,
        worktree,
        lane: WORKTREE_LANES[0],
        ...claim,
      }
      : null,
    depends,
    plan,
    status,
  }));
  for (const file of boardFiles) {
    mkdirSync(join(primary, file.dir), { recursive: true });
    writeFileSync(join(primary, file.dir, file.name), file.text);
  }
  for (const extra of extraTaskFiles) {
    writeFileSync(join(primary, "docs", "backlog", extra), "---\nid: 68\n---\n");
  }

  git(primary, "init", "--quiet", "--initial-branch", INTEGRATION_BRANCH, ".");
  git(primary, "config", "user.email", "probe@example.invalid");
  git(primary, "config", "user.name", "probe");
  // A personal global ignore must not decide what these fixtures call dirt.
  git(primary, "config", "core.excludesFile", "/dev/null");
  git(primary, "add", "-A");
  git(primary, "commit", "--quiet", "-m", "seed");
  git(primary, "checkout", "--quiet", "-b", "ops/current");
  git(primary, "worktree", "add", "--quiet", linkedMain, INTEGRATION_BRANCH);
  if (dependencies) seedDependencies(linkedMain);

  return { base, linkedMain, primary, taskFile, worktree };
}

function cli(cwd, args) {
  return spawnSync(process.execPath, [toolPath, ...args], { cwd, encoding: "utf8" });
}

function ok(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

/** A refusal is an exit code of 1 and one bounded code on stderr, never a stack trace. */
function refusalCode(result) {
  assert.equal(result.status, 1, result.stdout || result.stderr);
  assert.equal(result.stdout, "");
  let parsed;
  try {
    parsed = JSON.parse(result.stderr);
  } catch {
    return assert.fail(`refusal is not bounded JSON: ${result.stderr}`);
  }
  assert.equal(typeof parsed.error.message, "string");
  return parsed.error.code;
}

function refusalMessage(result) {
  assert.equal(result.status, 1, result.stdout || result.stderr);
  return JSON.parse(result.stderr).error.message;
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function branchExists(cwd, branch) {
  return spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd })
    .status === 0;
}

/**
 * Real `spawnSync` for every child except `npm`, which is recorded and answered by `handle`. The
 * install path is the one case that would otherwise reach the network.
 */
function recordingSpawn(handle) {
  const calls = [];
  const spawn = (command, args, options) => {
    if (command !== "npm") return spawnSync(command, args, options);
    calls.push({ args, command, env: options.env });
    return handle(args, options);
  };
  return { calls, spawn };
}

// The declared set. The executed one is collected at run time and compared with it, so a case
// described here but never registered fails the file.
const EXPECTED_CASE_COUNT = 20;
const EXPECTED_CASES = [
  "the preflight command list and the install spelling are the frozen ones",
  "the happy path creates the tree, provisions it and reports a ready preflight",
  "path, branch and lane come from the claim block and from nowhere else",
  "a target inside a registered worktree, behind a symlink, or relative is refused",
  "a task not in-progress, with no claim block, or in lane D is refused",
  "an unknown id, an ambiguous id and a malformed id are refused",
  "an existing branch and an existing target path are refused",
  "a checkout off the integration branch, and a subdirectory, are refused",
  "missing and drifted source dependencies are refused before anything is created",
  "--install runs the pinned npm spelling with a scrubbed environment",
  "rehearsal residue blocks nothing, and the session is told what it still owes",
  "the argument parser refuses unknown, duplicated and value-less options",
  "a claim branch that does not name the task is refused",
  "the copy preserves the dependency tree's relative symlinks",
  "a provisioning failure after the tree exists leaves it and says how to undo it",
  "a task with no plan is refused, and a missing confirmation is only reported",
  "an unmet blocker — open id, text, unknown id — is refused before anything is created",
  "a met blocker, an open epic and a related entry pass and are reported",
  "an epic target that is archived, not an epic, or itself blocked is refused",
  "the dependency grammar is the frozen one, wrapped lines included",
];

const executed = [];

function scenario(name, body) {
  assert.ok(EXPECTED_CASES.includes(name), `undeclared case: ${name}`);
  test(name, (t) => {
    executed.push(name);
    return body(t);
  });
}

scenario("the preflight command list and the install spelling are the frozen ones", () => {
  assert.deepEqual(PREFLIGHT_CHECKS.map((check) => check.id), PINNED_PREFLIGHT_CHECKS);
  assert.equal(PREFLIGHT_CHECKS.length, 8);
  // `pwd` and the task file are answered by the tool; the other six are git children.
  assert.deepEqual(
    PREFLIGHT_CHECKS.filter((check) => check.args === null).map((check) => check.id),
    ["pwd", "task-file"],
  );
  // The checks whose expectation is a stop, named rather than implied. `pwd` is not among
  // them and must not be: the tool hands every other command that directory, so comparing it
  // with itself would report a passed check that tested nothing.
  assert.deepEqual(
    PREFLIGHT_CHECKS.filter((check) => check.required).map((check) => check.id),
    ["repository-root", "branch", "task-file"],
  );
  assert.deepEqual(npmInstallArgs("/probe/tools/cv-builder"), PINNED_INSTALL_ARGS);
  assert.equal(TASK_ID_WIDTH, 3);
  assert.deepEqual([...WORKTREE_LANES], ["C", "T"]);
});

scenario("the happy path creates the tree, provisions it and reports a ready preflight", (t) => {
  const fixture = topology(t);
  const report = ok(cli(fixture.linkedMain, ["--task", "68"]));

  assert.equal(report.status, "ready");
  assert.equal(report.created.worktree, fixture.worktree);
  assert.equal(report.created.branch, `${TASK_BRANCH_PREFIX}068-probe`);
  assert.equal(report.created.base.ref, INTEGRATION_BRANCH);
  assert.equal(report.created.base.head, git(fixture.linkedMain, "rev-parse", "HEAD").trim());
  assert.equal(report.task.file, `docs/backlog/${fixture.taskFile}`);
  assert.equal(report.task.lane, "C");
  assert.equal(report.task.start_confirmation, "recorded");

  assert.equal(report.dependencies.method, "copy");
  assert.equal(report.dependencies.packages, 1);
  const installed = join(fixture.worktree, "tools", "cv-builder", "node_modules", "docx");
  assert.equal(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version, "9.9.9");

  // The report is the runbook's eight commands, in its order, each with what it observed.
  assert.deepEqual(report.preflight.checks.map((check) => check.id), PINNED_PREFLIGHT_CHECKS);
  assert.equal(report.preflight.status, "ready");
  for (const check of report.preflight.checks) {
    assert.equal(check.outcome, "pass", check.id);
    assert.equal(typeof check.command, "string");
    assert.equal(typeof check.expected, "string");
  }
  assert.equal(
    report.preflight.checks.find((check) => check.id === "branch").output,
    `${TASK_BRANCH_PREFIX}068-probe`,
  );
  assert.equal(report.preflight.checks.find((check) => check.id === "status").output, "");
  assert.equal(
    git(fixture.worktree, "branch", "--show-current").trim(),
    `${TASK_BRANCH_PREFIX}068-probe`,
  );
});

scenario("path, branch and lane come from the claim block and from nowhere else", (t) => {
  const fixture = topology(t, { claim: { lane: "T" } });
  const elsewhere = join(fixture.base, "pipeline-worktrees", "tasks", "068-elsewhere");
  // Rewrite the claim in place: the tool reads the committed file, so the change must be a commit.
  const taskPath = join(fixture.primary, "docs", "backlog", fixture.taskFile);
  writeFileSync(
    taskPath,
    readFileSync(taskPath, "utf8")
      .replace(fixture.worktree, elsewhere)
      .replace(`${TASK_BRANCH_PREFIX}068-probe`, `${TASK_BRANCH_PREFIX}068-elsewhere`),
  );
  git(fixture.primary, "add", "-A");
  git(fixture.primary, "commit", "--quiet", "-m", "repoint");
  git(fixture.linkedMain, "merge", "--quiet", "--ff-only", "ops/current");

  const report = ok(cli(fixture.linkedMain, ["--task", "68"]));
  assert.equal(report.created.worktree, elsewhere);
  assert.equal(report.created.branch, `${TASK_BRANCH_PREFIX}068-elsewhere`);
  assert.equal(report.task.lane, "T");
  assert.equal(exists(elsewhere), true);
  assert.equal(exists(fixture.worktree), false);
});

scenario("a target inside a registered worktree, behind a symlink, or relative is refused", (t) => {
  for (const [target, code] of [
    ["<primary>", "task_worktree_target_refused"],
    ["<link>", "task_worktree_target_refused"],
    ["<inside-main>", "task_worktree_target_refused"],
    ["../tasks/068-probe", "task_worktree_claim_invalid"],
    ["/a/b/../c", "task_worktree_claim_invalid"],
  ]) {
    const fixture = topology(t);
    const link = join(fixture.base, "operational-link");
    symlinkSync(fixture.primary, link, "dir");
    const claimed = target
      .replace("<primary>", join(fixture.primary, "output", "stolen"))
      .replace("<link>", join(link, "output", "stolen"))
      .replace("<inside-main>", join(fixture.linkedMain, "tools", "stolen"));
    const taskPath = join(fixture.primary, "docs", "backlog", fixture.taskFile);
    writeFileSync(taskPath, readFileSync(taskPath, "utf8").replace(fixture.worktree, claimed));
    git(fixture.primary, "add", "-A");
    git(fixture.primary, "commit", "--quiet", "-m", "repoint");
    git(fixture.linkedMain, "merge", "--quiet", "--ff-only", "ops/current");

    assert.equal(refusalCode(cli(fixture.linkedMain, ["--task", "68"])), code, claimed);
    assert.equal(branchExists(fixture.linkedMain, `${TASK_BRANCH_PREFIX}068-probe`), false);
  }
});

scenario("a task not in-progress, with no claim block, or in lane D is refused", (t) => {
  assert.equal(
    refusalCode(cli(topology(t, { status: "open" }).linkedMain, ["--task", "68"])),
    "task_worktree_task_not_claimed",
  );
  assert.equal(
    refusalCode(cli(topology(t, { claimBlock: false }).linkedMain, ["--task", "68"])),
    "task_worktree_task_not_claimed",
  );
  const laneD = topology(t, { claim: { lane: "D" } });
  const message = refusalMessage(cli(laneD.linkedMain, ["--task", "68"]));
  assert.equal(
    refusalCode(cli(laneD.linkedMain, ["--task", "68"])),
    "task_worktree_lane_without_tree",
  );
  assert.match(message, /lane D/);
  // A Cyrillic lookalike is not the Latin lane letter, and must not be read as one.
  assert.equal(
    refusalCode(cli(topology(t, { claim: { lane: "С" } }).linkedMain, ["--task", "68"])),
    "task_worktree_lane_invalid",
  );
});

scenario("an unknown id, an ambiguous id and a malformed id are refused", (t) => {
  const fixture = topology(t);
  assert.equal(
    refusalCode(cli(fixture.linkedMain, ["--task", "99"])),
    "task_worktree_task_not_found",
  );
  const twin = topology(t, { extraTaskFiles: ["068-bug-twin.md"] });
  assert.equal(refusalCode(cli(twin.linkedMain, ["--task", "68"])), "task_worktree_task_not_found");
  for (const bad of ["abc", "1234", "", "-1", "6 8"]) {
    assert.equal(
      refusalCode(cli(fixture.linkedMain, ["--task", bad])),
      "task_worktree_invalid_arguments",
      bad,
    );
  }
  // The id is zero-padded to the backlog's own width, so both spellings find the same file.
  assert.equal(ok(cli(fixture.linkedMain, ["--task", "068"])).task.id, 68);
});

scenario("an existing branch and an existing target path are refused", (t) => {
  const fixture = topology(t);
  ok(cli(fixture.linkedMain, ["--task", "68"]));
  assert.equal(
    refusalCode(cli(fixture.linkedMain, ["--task", "68"])),
    "task_worktree_branch_exists",
  );

  const second = topology(t);
  mkdirSync(second.worktree, { recursive: true });
  assert.equal(
    refusalCode(cli(second.linkedMain, ["--task", "68"])),
    "task_worktree_target_exists",
  );

  // A dangling symlink is an entry too: `existsSync` would answer false and let the tree be made.
  const third = topology(t);
  mkdirSync(dirname(third.worktree), { recursive: true });
  symlinkSync(join(third.base, "nothing-here"), third.worktree);
  assert.equal(
    refusalCode(cli(third.linkedMain, ["--task", "68"])),
    "task_worktree_target_exists",
  );
});

scenario("a checkout off the integration branch, and a subdirectory, are refused", (t) => {
  const fixture = topology(t);
  assert.equal(
    refusalCode(cli(fixture.primary, ["--task", "68"])),
    "task_worktree_branch_refused",
  );
  assert.equal(
    refusalCode(cli(join(fixture.linkedMain, "tools"), ["--task", "68"])),
    "task_worktree_root_mismatch",
  );
  // A detached HEAD names no branch, and is refused by the same check rather than by a default.
  const detached = topology(t);
  git(detached.linkedMain, "checkout", "--quiet", "--detach");
  assert.equal(
    refusalCode(cli(detached.linkedMain, ["--task", "68"])),
    "task_worktree_branch_refused",
  );
});

scenario("missing and drifted source dependencies are refused before anything is created", (t) => {
  const missing = topology(t, { dependencies: false });
  assert.equal(
    refusalCode(cli(missing.linkedMain, ["--task", "68"])),
    "task_worktree_dependencies_unavailable",
  );
  assert.equal(exists(missing.worktree), false);
  assert.equal(branchExists(missing.linkedMain, `${TASK_BRANCH_PREFIX}068-probe`), false);

  // A source tree that carries a version its own lockfile does not name would copy a stale graph.
  const drifted = topology(t, { dependencies: false });
  seedDependencies(drifted.linkedMain, { version: "9.9.8" });
  const message = refusalMessage(cli(drifted.linkedMain, ["--task", "68"]));
  assert.match(message, /toolchain_dependency_version_mismatch/);
  assert.match(message, /--install/);
  assert.equal(exists(drifted.worktree), false);
});

scenario("--install runs the pinned npm spelling with a scrubbed environment", (t) => {
  const fixture = topology(t, { dependencies: false });
  const recorder = recordingSpawn((args) => {
    // Stand in for a successful install: the prefix is the last thing npm would populate.
    seedDependencies(dirname(dirname(args[2])));
    return { status: 0, stderr: "", stdout: "" };
  });
  const report = runTaskWorktree(["--task", "68", "--install"], {
    cwd: fixture.linkedMain,
    environment: {
      GIT_DIR: "/hostile/.git",
      NODE_OPTIONS: "--require /hostile.js",
      PATH: process.env.PATH,
      npm_config_prefix: "/hostile",
      npm_lifecycle_event: "task:worktree",
    },
    spawn: recorder.spawn,
  });

  assert.equal(report.dependencies.method, "npm-ci");
  assert.equal(report.dependencies.source, null);
  assert.equal(recorder.calls.length, 1);
  assert.deepEqual(
    recorder.calls[0].args,
    npmInstallArgs(join(fixture.worktree, "tools", "cv-builder")),
  );
  // The outer invocation's npm variables describe that invocation, not this install.
  assert.deepEqual(Object.keys(recorder.calls[0].env).filter((key) => key.startsWith("npm_")), []);
  assert.equal(recorder.calls[0].env.GIT_DIR, undefined);
  assert.equal(recorder.calls[0].env.NODE_OPTIONS, undefined);
  assert.equal(recorder.calls[0].env.PATH, process.env.PATH);
});

scenario("rehearsal residue blocks nothing, and the session is told what it still owes", (t) => {
  const fixture = topology(t, { plan: "unconfirmed" });
  const live = join(fixture.base, "pipeline-worktrees", "rehearsal", "probe");
  git(fixture.linkedMain, "worktree", "add", "--quiet", "-b", "rehearsal/probe", live);
  // A rehearsal branch whose tree is gone: the porcelain listing cannot show it at all.
  git(fixture.linkedMain, "branch", "rehearsal/orphan", INTEGRATION_BRANCH);

  const report = ok(cli(fixture.linkedMain, ["--task", "68"]));
  assert.equal(report.status, "ready");
  assert.equal(report.preflight.status, "ready");
  assert.equal(report.preflight.rehearsal_residue.blocking, false);
  assert.deepEqual(report.preflight.rehearsal_residue.branches, [
    "rehearsal/orphan",
    "rehearsal/probe",
  ]);
  assert.deepEqual(report.preflight.rehearsal_residue.worktrees, ["rehearsal/probe"]);

  assert.equal(report.task.start_confirmation, "absent");
  assert.deepEqual(report.preflight.session_owes, [
    SESSION_OWES_SELF_REPORT,
    SESSION_OWES_START_CONFIRMATION,
  ]);
  // With the record present the tool owes the session only the line it cannot know.
  const confirmed = topology(t);
  assert.deepEqual(
    ok(cli(confirmed.linkedMain, ["--task", "68"])).preflight.session_owes,
    [SESSION_OWES_SELF_REPORT],
  );
});

scenario("the argument parser refuses unknown, duplicated and value-less options", (t) => {
  const fixture = topology(t);
  for (const args of [
    [],
    ["--install"],
    ["--task"],
    ["--task", "--install"],
    ["--task", "68", "--task", "68"],
    ["--task", "68", "--path", "/tmp/elsewhere"],
    ["--task", "68", "--branch", "task/068-other"],
    ["--task", "68", "--lane", "D"],
    ["--task", "68", "--install", "--install"],
    ["68"],
    ["--task", "68", "--__proto__", "x"],
  ]) {
    assert.equal(
      refusalCode(cli(fixture.linkedMain, args)),
      "task_worktree_invalid_arguments",
      args.join(" "),
    );
  }
  assert.equal(branchExists(fixture.linkedMain, `${TASK_BRANCH_PREFIX}068-probe`), false);
});

scenario("a claim branch that does not name the task is refused", (t) => {
  for (const branch of [
    `${TASK_BRANCH_PREFIX}069-probe`,
    "task/68-probe",
    "feature/068-probe",
    `${TASK_BRANCH_PREFIX}068-Probe`,
    `${TASK_BRANCH_PREFIX}068-probe--twice`,
  ]) {
    const fixture = topology(t, { claim: { branch } });
    assert.equal(
      refusalCode(cli(fixture.linkedMain, ["--task", "68"])),
      "task_worktree_claim_invalid",
      branch,
    );
    assert.equal(exists(fixture.worktree), false);
  }
});

scenario("the copy preserves the dependency tree's relative symlinks", (t) => {
  const fixture = topology(t);
  ok(cli(fixture.linkedMain, ["--task", "68"]));
  const link = join(
    fixture.worktree,
    "tools",
    "cv-builder",
    "node_modules",
    ".bin",
    "docx-probe",
  );
  // Dereferencing would leave a regular file here, and a relative link that still resolves is the
  // only outcome that keeps the copied tree behaving like the one it came from.
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readlinkSync(link), "../docx/index.js");
  assert.equal(readFileSync(link, "utf8"), "module.exports = {};\n");
});

scenario("a provisioning failure after the tree exists leaves it and says how to undo it", (t) => {
  const failing = topology(t, { dependencies: false });
  const refused = recordingSpawn(() => ({ status: 1, stderr: "ENOTFOUND registry", stdout: "" }));
  assert.throws(
    () => runTaskWorktree(["--task", "68", "--install"], {
      cwd: failing.linkedMain,
      environment: { PATH: process.env.PATH },
      spawn: refused.spawn,
    }),
    (error) => {
      assert.equal(error.code, "task_worktree_provisioning_failed");
      assert.match(error.message, /git worktree remove/);
      assert.match(error.message, new RegExp(failing.worktree.replaceAll("/", "\\/")));
      return true;
    },
  );
  // The tree is left standing on purpose: a destructive rollback for an install error would be
  // worse than the state it cleans, so the remedy is named and not run.
  assert.equal(exists(failing.worktree), true);
  assert.equal(branchExists(failing.linkedMain, `${TASK_BRANCH_PREFIX}068-probe`), true);

  // An install that reports success and provisions nothing is caught by the destination check.
  const empty = topology(t, { dependencies: false });
  const silent = recordingSpawn(() => ({ status: 0, stderr: "", stdout: "" }));
  assert.throws(
    () => runTaskWorktree(["--task", "68", "--install"], {
      cwd: empty.linkedMain,
      environment: { PATH: process.env.PATH },
      spawn: silent.spawn,
    }),
    (error) => {
      assert.equal(error.code, "task_worktree_provisioning_failed");
      assert.match(error.message, /do not check out/);
      return true;
    },
  );
  assert.equal(exists(empty.worktree), true);
});

scenario("a task with no plan is refused, and a missing confirmation is only reported", (t) => {
  const planless = topology(t, { plan: "none" });
  const message = refusalMessage(cli(planless.linkedMain, ["--task", "68"]));
  assert.equal(
    refusalCode(cli(planless.linkedMain, ["--task", "68"])),
    "task_worktree_plan_missing",
  );
  assert.match(message, /## Plan/);
  assert.equal(exists(planless.worktree), false);

  // The gate of the pre-switch development procedure step 1a can be waived by a user decision this tool cannot read, so the
  // missing record is reported and never enforced.
  const unconfirmed = topology(t, { plan: "unconfirmed" });
  const report = ok(cli(unconfirmed.linkedMain, ["--task", "68"]));
  assert.equal(report.status, "ready");
  assert.equal(report.task.start_confirmation, "absent");

  // The parser reads the record only inside `## Plan`, never from a later section.
  const strayed = parseTaskDocument(
    "---\nid: 68\n---\n\n## Plan\n\nA.\n\n## Review\n\n### Start confirmation\n\nB.\n",
  );
  assert.equal(strayed.plan.present, true);
  assert.equal(strayed.plan.startConfirmation, false);
});

scenario("an unmet blocker — open id, text, unknown id — is refused before anything is created", (t) => {
  // The met entry comes first in the two-entry case: a guard that stopped at the first resolved
  // entry would build the tree for a task whose second blocker is still open.
  for (const [depends, code] of [
    ["[{blocker: 70}]", "task_worktree_dependency_unmet"],
    ["[{blocker: 71}]", "task_worktree_dependency_unmet"],
    ['[{blocker: "the cutover carries task 56 to ops/current"}]', "task_worktree_dependency_unmet"],
    ["[{blocker: 72}, {blocker: 70}]", "task_worktree_dependency_unmet"],
    ["[{blocker: 99}]", "task_worktree_dependency_invalid"],
    ["[{blocker: 70}", "task_worktree_dependency_invalid"],
  ]) {
    const fixture = topology(t, { boardFiles: BOARD, depends });
    assert.equal(refusalCode(cli(fixture.linkedMain, ["--task", "68"])), code, depends);
    assert.equal(exists(fixture.worktree), false);
    assert.equal(branchExists(fixture.linkedMain, `${TASK_BRANCH_PREFIX}068-probe`), false);
  }
  // The refusal names the entry, not just the field: a claim block lists many of them.
  const message = refusalMessage(cli(
    topology(t, { boardFiles: BOARD, depends: "[{blocker: 70}]" }).linkedMain,
    ["--task", "68"],
  ));
  assert.match(message, /blocker: 70/);
});

scenario("a met blocker, an open epic and a related entry pass and are reported", (t) => {
  const fixture = topology(t, {
    boardFiles: BOARD,
    depends: '[{blocker: 72}, {epic: 73}, {related: 70}, {related: "a note, with a comma"}]',
  });
  const report = ok(cli(fixture.linkedMain, ["--task", "68"]));
  assert.equal(report.status, "ready");
  // The whole shape, frozen: a resolution silently dropped would leave the report claiming a check
  // it never ran, and `informational` is what tells a reader the entry was seen and required
  // nothing.
  assert.deepEqual(report.task.depends, [
    { type: "blocker", target: 72, resolution: "done" },
    { type: "epic", target: 73, resolution: "open-epic" },
    { type: "related", target: 70, resolution: "informational" },
    { type: "related", target: "a note, with a comma", resolution: "informational" },
  ]);
  assert.deepEqual(ok(cli(topology(t).linkedMain, ["--task", "68"])).task.depends, []);
});

scenario("an epic target that is archived, not an epic, or itself blocked is refused", (t) => {
  for (const [depends, code] of [
    ["[{epic: 74}]", "task_worktree_dependency_invalid"],
    ["[{epic: 70}]", "task_worktree_dependency_invalid"],
    ["[{epic: 99}]", "task_worktree_dependency_invalid"],
    ['[{epic: "the brief epic"}]', "task_worktree_dependency_invalid"],
    ["[{epic: 75}]", "task_worktree_dependency_unmet"],
    ["[{epic: 76}]", "task_worktree_dependency_unmet"],
  ]) {
    const fixture = topology(t, { boardFiles: BOARD, depends });
    assert.equal(refusalCode(cli(fixture.linkedMain, ["--task", "68"])), code, depends);
    assert.equal(exists(fixture.worktree), false);
    assert.equal(branchExists(fixture.linkedMain, `${TASK_BRANCH_PREFIX}068-probe`), false);
  }
  // One level and no further: 77's own `epic` entry names 075, whose blocker is unmet, so this
  // passes only while the walk stops after one hop — remove that stop and the fixture refuses.
  const chained = topology(t, { boardFiles: BOARD, depends: "[{epic: 77}]" });
  assert.equal(ok(cli(chained.linkedMain, ["--task", "68"])).task.depends[0].resolution, "open-epic");

  // The claiming task is named in a refusal that came from a walk, and so is the entry that
  // started it: without both, the operator reads two file names they never typed.
  const walked = refusalMessage(cli(
    topology(t, { boardFiles: BOARD, depends: "[{epic: 75}]" }).linkedMain,
    ["--task", "68"],
  ));
  assert.match(walked, /068-feat-probe\.md carries \{epic: 75\}, and its epic/);
  assert.match(walked, /075-epic-waiting\.md carries \{blocker: 70\}/);
});

scenario("the dependency grammar is the frozen one, wrapped lines included", () => {
  assert.deepEqual([...DEPENDENCY_TYPES], PINNED_DEPENDENCY_TYPES);
  for (const [raw, entries] of [
    ["[]", []],
    ["[ ]", []],
    ["[{blocker: 56}]", [{ type: "blocker", target: 56 }]],
    ["[{epic: 7}]", [{ type: "epic", target: 7 }]],
    ["[{related: 999}]", [{ type: "related", target: 999 }]],
    [
      '[{blocker: 33}, {blocker: "user decision on the two questions in ## Открытые вопросы"}]',
      [
        { type: "blocker", target: 33 },
        { type: "blocker", target: "user decision on the two questions in ## Открытые вопросы" },
      ],
    ],
    // The board's own hard cases: an apostrophe, a colon, parentheses and a comma inside one text.
    [
      '[{blocker: "004\'s R2-02A lands (register: R2-03P depends on R2-02A)"}, {related: 4}]',
      [
        { type: "blocker", target: "004's R2-02A lands (register: R2-03P depends on R2-02A)" },
        { type: "related", target: 4 },
      ],
    ],
  ]) {
    assert.deepEqual(parseDependencies(raw), entries, raw);
  }
  for (const raw of [
    "",
    "[",
    "[]]",
    "56",
    "[56]",
    "[blocker: 56]",
    "[{blocker: '56'}]",
    "[{blocker: 56, epic: 3}]",
    "[{unknown: 56}]",
    "[{blocker: 1234}]",
    "[{blocker: }]",
    "[{blocker: 56}] # a note",
    '[{epic: "the brief epic"}]',
    '[{blocker: "a\\"b"}]',
    '[{blocker: "a\\b"}]',
    '[{blocker: "a""b"}]',
    "[{blocker: 56},]",
    "[{blocker: 56}{blocker: 57}]",
  ]) {
    assert.throws(
      () => parseDependencies(raw),
      (error) => {
        assert.equal(error.code, "task_worktree_dependency_invalid", raw);
        return true;
      },
      raw,
    );
  }

  // A wrapped list is one value. Without this the document parser hands the guard the first line
  // alone — unbalanced, and so refused as malformed while the file is perfectly well formed.
  const wrapped = parseTaskDocument(
    '---\nid: 68\ndepends: [{blocker: 56},\n  {related: "a, b"}]\nstatus: open\n---\n',
  );
  assert.equal(wrapped.frontmatter.status, "open");
  assert.deepEqual(parseDependencies(wrapped.frontmatter.depends), [
    { type: "blocker", target: 56 },
    { type: "related", target: "a, b" },
  ]);
  // The continuation opens only on a value that starts an unclosed flow sequence, so the claim
  // block below a balanced `depends` is still parsed as a claim block and not swallowed.
  const beside = parseTaskDocument(
    "---\nid: 68\ndepends: []\nclaim:\n  lane: C\n  expected-files: [a.md,\n    b.md]\n---\n",
  );
  assert.equal(beside.frontmatter.depends, "[]");
  assert.equal(beside.claim.lane, "C");
});

test("every declared case ran", () => {
  assert.equal(EXPECTED_CASES.length, EXPECTED_CASE_COUNT);
  assert.deepEqual([...executed].sort(), [...EXPECTED_CASES].sort());
});
