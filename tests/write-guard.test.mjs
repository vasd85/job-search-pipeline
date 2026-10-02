// The write guard keyed on the operational folder's marker file. Whether the runtime fires a
// project hook at all is a property of the runtime, not of this repository; this file owns what a
// test can prove: the guard's decision for every cell of the rights matrix over synthetic layouts
// inside disposable roots, its failures closed, its independence from git, and the copies it keeps
// of the folder tool's constants.
//
// Two ways of running it. A child process with a payload on stdin and a PATH that holds no git is
// the hook as the runtime runs it. But the layouts live in the system temporary directory, which the
// guard opens to an operational session as one of its exceptions, so every case where an
// operational session writes outside its folder runs `decide` in process with the exception's roots
// replaced by directories of the layout.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as guard from "../.claude/hooks/write-guard.mjs";
import * as folderTool from "../tools/ops-tree/manifest.mjs";
import { IMPORTED_FILE, OUTBOX_DIRECTORY } from "../tools/board/import.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = resolve(repoRoot, ".claude/hooks/write-guard.mjs");
const settingsPath = resolve(repoRoot, ".claude/settings.json");

// Frozen literally rather than read back from the module under test.
const EXPECTED_V2_COMMAND = 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/write-guard.mjs"';

// A directory that exists and holds no executables: the hook runs with it as its whole PATH.
function emptyPathDirectory(base) {
  const directory = join(base, "empty-path");
  mkdirSync(directory, { recursive: true });
  return directory;
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return String(result.stdout ?? "");
}

function initRepository(root) {
  mkdirSync(root, { recursive: true });
  git(root, "init", "--quiet", ".");
  git(root, "config", "user.email", "guard@example.invalid");
  git(root, "config", "user.name", "guard");
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git(root, "add", "seed.txt");
  git(root, "commit", "--quiet", "-m", "seed");
}

function write(path, text = "x\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const PIN = Object.freeze({
  commit: "a".repeat(40),
  repository: "/nonexistent/repository",
  tag: "release-20260101",
  tree: "b".repeat(40),
});

function manifestFor(kind, overrides = {}) {
  return {
    built_at: "2026-01-01T00:00:00.000Z",
    candidate: { ...PIN, tag: "candidate-20260101" },
    engine: PIN,
    files: { candidate: {}, dependencies: {}, engine: {} },
    kind,
    previous: null,
    schema: folderTool.MANIFEST_SCHEMA,
    schema_version: folderTool.MANIFEST_SCHEMA_VERSION,
    state: "ready",
    zones: folderTool.zoneTableFor(kind),
    ...overrides,
  };
}

/** An exported folder: engine files, a candidate snapshot, state, the outbox and the marker. */
function buildFolder(root, kind) {
  write(join(root, "tools", "process-log.mjs"));
  write(join(root, ".claude", "settings.json"), "{}\n");
  write(join(root, ".claude", "settings.local.json"), "{}\n");
  write(join(root, "tools", "cv-builder", "node_modules", "pkg", "index.js"));
  write(join(root, "candidate", "profile.md"));
  mkdirSync(join(root, "candidate", "research"), { recursive: true });
  write(join(root, "process-log.json"), "{}\n");
  mkdirSync(join(root, "output"), { recursive: true });
  mkdirSync(join(root, "records"), { recursive: true });
  mkdirSync(join(root, ".temp-docs"), { recursive: true });
  write(join(root, "outbox", "tasks", "draft.md"), "---\ndraft_id: d1\n---\n");
  mkdirSync(join(root, ".ops-tree"), { recursive: true });
  const manifest = manifestFor(kind);
  // The fixture is only realistic if the folder tool itself would read it.
  assert.notEqual(folderTool.parseManifest(JSON.stringify(manifest)), null);
  writeFileSync(
    join(root, folderTool.MANIFEST_FILE_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

/**
 * The machine after the switch, in one disposable root: a development clone with the private
 * repository nested as `candidate/` and a linked task tree, an operational folder and a rehearsal
 * folder without `.git`, a home directory with Claude Code's folders, a stand-in for the system
 * temporary directory, and a directory outside everything.
 */
function layout(t) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "job-search-write-guard-"));
  t.after(() => {
    spawnSync("chmod", ["-R", "u+rwx", base]);
    rmSync(base, { force: true, recursive: true });
  });
  const engine = join(base, "engine");
  initRepository(engine);
  write(join(engine, "tools", "build.mjs"));
  const candidate = join(engine, "candidate");
  initRepository(candidate);
  write(join(candidate, "board", "README.md"));
  write(join(candidate, "profile.md"));
  const task = join(base, "engine-tasks", "174-probe");
  git(engine, "worktree", "add", "--quiet", "-b", "task/174-probe", task, "HEAD");
  const ops = join(base, "job-search-pipeline");
  buildFolder(ops, "operational");
  const rehearsal = join(base, "engine-rehearsal-probe");
  buildFolder(rehearsal, "rehearsal");
  const home = join(base, "home");
  const memory = join(home, ".claude", "projects", guard.projectDirectoryName(ops), "memory");
  mkdirSync(memory, { recursive: true });
  mkdirSync(join(home, ".claude", "plans"), { recursive: true });
  const temporary = join(base, "temporary");
  mkdirSync(temporary, { recursive: true });
  const outside = join(base, "outside");
  mkdirSync(outside, { recursive: true });
  return {
    base,
    candidate,
    emptyPath: emptyPathDirectory(base),
    engine,
    home,
    memory,
    ops,
    outside,
    rehearsal,
    task,
    temporary,
  };
}

function payloadFor(cwd, target, toolName = "Write") {
  const key = toolName === "NotebookEdit" ? "notebook_path" : "file_path";
  return {
    cwd,
    hook_event_name: "PreToolUse",
    session_id: "write-guard-probe",
    tool_input: { [key]: target },
    tool_name: toolName,
  };
}

function runHook(env, { cwd, target, toolName, raw }) {
  const input = raw ?? JSON.stringify(payloadFor(cwd, target, toolName));
  return spawnSync(process.execPath, [hookPath], {
    encoding: "utf8",
    env: { HOME: env.home, PATH: env.emptyPath },
    input,
  });
}

/** `decide` in this process, with the exception's roots taken from the layout and PATH emptied. */
function decideIn(env, cwd, target) {
  const saved = process.env.PATH;
  process.env.PATH = env.emptyPath;
  try {
    return guard.decide(payloadFor(cwd, target), {
      home: env.home,
      temporaryDirectories: [env.temporary],
    });
  } catch (error) {
    if (error instanceof guard.GuardError) return { allowed: false, failed: error.code };
    throw error;
  } finally {
    process.env.PATH = saved;
  }
}

function verdictOf(decision) {
  if (decision.allowed) return "allow";
  return decision.failed ?? decision.reason;
}

function assertInProcess(env, cwd, target, expected) {
  assert.equal(verdictOf(decideIn(env, cwd, target)), expected, `${cwd} -> ${target}`);
}

function assertAllowed(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

// A refusal by a rule names its code in brackets and never reads as a failure to resolve; a
// failure closed names its code in parentheses and never names a blocked target. Asserting only
// the exit code would let either stand in for the other.
function assertRuleDenied(result, code) {
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, new RegExp(`\\[${code}\\]`));
  assert.match(result.stderr, /Blocked target:/);
  assert.doesNotMatch(result.stderr, /could not resolve/);
}

function assertFailedClosed(result, code) {
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /could not resolve/);
  assert.match(result.stderr, new RegExp(`\\(${code}:`));
  assert.doesNotMatch(result.stderr, /Blocked target:/);
}

// ---------------------------------------------------------------------------------------------
// The rights matrix, cell by cell. Each test name states the cell, its outcome and the paths the
// guard does not close; the cases are the evidence for the outcome.

const SHELL_AND_CODEX = "the shell channel (open in the desktop runtime) and Codex";

test(`run -> its own artifacts: allowed; not closed: nothing, this is the permitted cell`, (t) => {
  const env = layout(t);
  for (const path of [
    "output/acme/cv.docx",
    "process-log.json",
    "process-log.json.lock",
    "records/letter-corrections/r1.json",
    ".temp-docs/page.txt",
    "outbox/tasks/new-draft.md",
    "triage-batches/b1/plan.json",
  ]) {
    assertAllowed(runHook(env, { cwd: env.ops, target: join(env.ops, path) }));
  }
  // A path relative to the session directory lands in the same place.
  assertAllowed(runHook(env, { cwd: env.ops, target: "output/relative.md" }));
});

test(
  `run -> engine sources: refused; not closed: ${SHELL_AND_CODEX}, hard links, ` +
    `file-writing tools outside the matcher, until the first drift check`,
  (t) => {
    const env = layout(t);
    const own = {
      "tools/process-log.mjs": "read_only_zone",
      ".claude/settings.json": "read_only_zone",
      "ops-manifest.json": "read_only_zone",
      ".ops-tree/lock": "read_only_zone",
      "tools/cv-builder/node_modules/pkg/index.js": "read_only_zone",
      "stray-file-at-root.md": "read_only_zone",
      "candidate/research/new.json": "read_only_zone",
      ".DS_Store": "read_only_zone",
      ".claude/settings.local.json": "settings_local",
    };
    for (const [path, code] of Object.entries(own)) {
      assertRuleDenied(runHook(env, { cwd: env.ops, target: join(env.ops, path) }), code);
    }
    // The development clone and a task tree lie outside the folder: rule 2.
    assertInProcess(env, env.ops, join(env.engine, "tools", "build.mjs"), "outbound");
    assertInProcess(env, env.ops, join(env.task, "tools", "new.mjs"), "outbound");
  },
);

test(
  `run -> the board: refused; not closed: ${SHELL_AND_CODEX}, which reach the live board on ` +
    `the same disk`,
  (t) => {
    const env = layout(t);
    assertInProcess(env, env.ops, join(env.candidate, "board", "README.md"), "outbound");
    assertInProcess(env, env.ops, join(env.candidate, "board", "200-feat-new.md"), "outbound");
  },
);

test(
  `run -> candidate data: refused; not closed: ${SHELL_AND_CODEX}, into the snapshot before ` +
    `the first step and into the live clone at any time`,
  (t) => {
    const env = layout(t);
    assertRuleDenied(
      runHook(env, { cwd: env.ops, target: join(env.ops, "candidate", "profile.md") }),
      "read_only_zone",
    );
    assertInProcess(env, env.ops, join(env.candidate, "profile.md"), "outbound");
  },
);

test(
  `development -> the run's artifacts: refused, the outbox included; not closed: ` +
    `${SHELL_AND_CODEX}, the board tool's two outbox actions, sessions whose checkout does not ` +
    `register this guard, hard links`,
  (t) => {
    const env = layout(t);
    const targets = [
      "process-log.json",
      "output/acme/cv.docx",
      "records/letter-corrections/r1.json",
      "candidate/research/r.json",
      ".temp-docs/page.txt",
      "outbox/tasks/draft.md",
      "outbox/tasks/new-draft.md",
      join(OUTBOX_DIRECTORY, IMPORTED_FILE),
      "outbox/other.txt",
    ];
    for (const session of [env.engine, env.task, env.outside, env.candidate]) {
      for (const path of targets) {
        assertRuleDenied(runHook(env, { cwd: session, target: join(env.ops, path) }), "inbound");
      }
    }
    assertRuleDenied(
      runHook(env, { cwd: env.outside, target: join(env.ops, ".claude", "settings.local.json") }),
      "settings_local",
    );
    assertRuleDenied(
      runHook(env, { cwd: env.engine, target: "../job-search-pipeline/output/relative.md" }),
      "inbound",
    );
  },
);

test("development -> engine sources, the board, candidate data: allowed; not closed: nothing", (t) => {
  const env = layout(t);
  for (const session of [env.engine, env.task, env.candidate]) {
    for (const target of [
      join(env.engine, "tools", "build.mjs"),
      join(env.task, "tools", "new.mjs"),
      join(env.candidate, "board", "200-feat-new.md"),
      join(env.candidate, "profile.md"),
    ]) {
      assertAllowed(runHook(env, { cwd: session, target }));
    }
  }
});

// ---------------------------------------------------------------------------------------------
// The mirror rule and the two folder kinds.

test("mirror rule: the run writes neither the development clone's candidate nor engine sources", (t) => {
  const env = layout(t);
  for (const target of [
    join(env.candidate, "profile.md"),
    join(env.candidate, "board", "x.md"),
    join(env.engine, "tools", "build.mjs"),
    join(env.engine, "new-file.md"),
    join(env.outside, "notes.md"),
  ]) {
    assertInProcess(env, env.ops, target, "outbound");
    // A session in a subdirectory of the folder is the folder's session.
    assertInProcess(env, join(env.ops, "output"), target, "outbound");
  }
});

test("mirror rule: a session outside writes no state zone of the folder", (t) => {
  const env = layout(t);
  for (const zone of folderTool.ZONE_TABLE.stateNames) {
    assertRuleDenied(
      runHook(env, { cwd: env.engine, target: join(env.ops, zone, "x") }),
      "inbound",
    );
  }
  for (const prefix of folderTool.ZONE_TABLE.statePrefixes) {
    assertRuleDenied(
      runHook(env, { cwd: env.engine, target: join(env.ops, `${prefix}.tmp`) }),
      "inbound",
    );
  }
});

test("mirror rule: an operational and a rehearsal folder do not write into each other", (t) => {
  const env = layout(t);
  assertRuleDenied(
    runHook(env, { cwd: env.rehearsal, target: join(env.ops, "output", "x.md") }),
    "outbound",
  );
  assertRuleDenied(
    runHook(env, { cwd: env.ops, target: join(env.rehearsal, "output", "x.md") }),
    "outbound",
  );
  // `.rehearsal/` is state only where the folder is a rehearsal one.
  assertAllowed(
    runHook(env, { cwd: env.rehearsal, target: join(env.rehearsal, ".rehearsal", "b.json") }),
  );
  assertRuleDenied(
    runHook(env, { cwd: env.ops, target: join(env.ops, ".rehearsal", "b.json") }),
    "read_only_zone",
  );
});

test("the operational exception: memory of its own project, plans and temporary files only", (t) => {
  const env = layout(t);
  assertInProcess(env, env.ops, join(env.memory, "note.md"), "allow");
  assertInProcess(env, env.ops, join(env.memory, "MEMORY.md"), "allow");
  assertInProcess(env, env.ops, join(env.home, ".claude", "plans", "plan.md"), "allow");
  assertInProcess(env, env.ops, join(env.temporary, "scratch", "x.txt"), "allow");
  // Everything else in the home directory's Claude folder stays closed.
  assertInProcess(env, env.ops, join(env.home, ".claude", "settings.json"), "outbound");
  assertInProcess(env, env.ops, join(env.home, ".claude", "hooks", "x.mjs"), "outbound");
  // The development project's memory is loaded into development sessions: closed.
  const developmentMemory = join(
    env.home,
    ".claude",
    "projects",
    guard.projectDirectoryName(env.engine),
    "memory",
    "x.md",
  );
  assertInProcess(env, env.ops, developmentMemory, "outbound");
  // A link inside the memory folder is judged where it lands.
  symlinkSync(env.engine, join(env.memory, "into-engine"));
  assertInProcess(env, env.ops, join(env.memory, "into-engine", "tools", "x.mjs"), "outbound");
  // A marked folder inside the temporary directory is still a marked folder.
  buildFolder(join(env.temporary, "other-folder"), "operational");
  assertInProcess(env, env.ops, join(env.temporary, "other-folder", "output", "x"), "outbound");
  // A rehearsal session has no exception.
  const rehearsalMemory = join(
    env.home,
    ".claude",
    "projects",
    guard.projectDirectoryName(env.rehearsal),
    "memory",
  );
  mkdirSync(rehearsalMemory, { recursive: true });
  assertInProcess(env, env.rehearsal, join(rehearsalMemory, "note.md"), "outbound");
  assertInProcess(env, env.rehearsal, join(env.temporary, "x.txt"), "outbound");
});

test("the exception's roots: its own project's memory and plans by name, the temporary directories", () => {
  const roots = guard.outsideRoots("/srv/some.one/job_search-pipeline", {
    home: "/nonexistent-home",
    temporaryDirectories: [],
  });
  assert.deepEqual(roots, [
    "/nonexistent-home/.claude/projects/-srv-some-one-job-search-pipeline/memory",
    "/nonexistent-home/.claude/plans",
  ]);
  // Without options the machine's own home directory and both temporary directories are used.
  const machine = guard.outsideRoots("/srv/folder");
  assert.equal(machine.includes(guard.resolvePath(join(homedir(), ".claude", "plans"))), true);
  assert.equal(machine.includes(realpathSync(tmpdir())), true);
  assert.equal(machine.includes(realpathSync("/tmp")), true);
  assert.equal(
    guard.projectDirectoryName("/private/tmp/claude-501/-Users-x/scratchpad"),
    "-private-tmp-claude-501--Users-x-scratchpad",
  );
});

// ---------------------------------------------------------------------------------------------
// Without a marker nothing is refused, and git is never asked.

test("a tree without a marker is open, whatever git says about it", (t) => {
  const env = layout(t);
  const sessions = [env.engine, env.task, env.candidate, env.outside, env.base];
  const targets = [
    join(env.engine, "tools", "build.mjs"),
    join(env.engine, ".git", "config"),
    join(env.task, "tools", "new.mjs"),
    join(env.candidate, "board", "README.md"),
    join(env.outside, "new", "deep", "file.md"),
  ];
  for (const cwd of sessions) {
    for (const target of targets) assertAllowed(runHook(env, { cwd, target }));
  }
});

test("the guard runs no git: no process module in its source and no git on its PATH", (t) => {
  const source = readFileSync(hookPath, "utf8");
  assert.equal(source.includes("child_process"), false);
  assert.equal(/\b(spawn|exec|fork)\w*\s*\(/.test(source), false);
  const env = layout(t);
  // A folder that is also a git repository is judged by its marker alone.
  initRepository(join(env.ops, "output", "nested-repository"));
  assertAllowed(
    runHook(env, { cwd: env.ops, target: join(env.ops, "output", "nested-repository", "x") }),
  );
  // Outside its folder an operational session is judged in process: the layout sits in the
  // temporary directory, which the child's default exception would open.
  assertInProcess(
    env,
    join(env.ops, "output", "nested-repository"),
    join(env.engine, "x"),
    "outbound",
  );
});

// ---------------------------------------------------------------------------------------------
// Links, and markers inside markers.

test("links are judged where they land, and a link into nothing is refused on any tree", (t) => {
  const env = layout(t);
  // A live link from the folder's state into its engine zone, and one the other way round.
  symlinkSync(join(env.ops, "tools"), join(env.ops, "output", "to-tools"));
  assertRuleDenied(
    runHook(env, { cwd: env.ops, target: join(env.ops, "output", "to-tools", "x.mjs") }),
    "read_only_zone",
  );
  symlinkSync(join(env.ops, "output", "real.md"), join(env.ops, "tools", "to-output.md"));
  write(join(env.ops, "output", "real.md"));
  assertRuleDenied(
    runHook(env, { cwd: env.ops, target: join(env.ops, "tools", "to-output.md") }),
    "read_only_zone",
  );
  // A live link from the development clone into the folder's state.
  symlinkSync(join(env.ops, "output"), join(env.engine, "to-output"));
  assertRuleDenied(
    runHook(env, { cwd: env.engine, target: join(env.engine, "to-output", "a.md") }),
    "inbound",
  );
  // A live link as the last component: as written it is a file of the clone, where it lands is state.
  symlinkSync(join(env.ops, "output", "real.md"), join(env.engine, "to-real.md"));
  assertRuleDenied(
    runHook(env, { cwd: env.engine, target: join(env.engine, "to-real.md") }),
    "inbound",
  );
  // A link into nothing, both directions; a chain; a missing directory; `..` behind a live link.
  symlinkSync(join(env.ops, "records", "new.json"), join(env.engine, "dangling"));
  assertFailedClosed(
    runHook(env, { cwd: env.engine, target: join(env.engine, "dangling") }),
    "dangling_symlink",
  );
  symlinkSync(join(env.engine, "escaped.json"), join(env.ops, "records", "out"));
  assertFailedClosed(
    runHook(env, { cwd: env.ops, target: join(env.ops, "records", "out") }),
    "dangling_symlink",
  );
  symlinkSync(join(env.engine, "dangling"), join(env.engine, "chain"));
  assertFailedClosed(
    runHook(env, { cwd: env.engine, target: join(env.engine, "chain") }),
    "dangling_symlink",
  );
  symlinkSync(join(env.ops, "records", "missing-dir"), join(env.engine, "dangling-dir"));
  assertFailedClosed(
    runHook(env, { cwd: env.engine, target: join(env.engine, "dangling-dir", "x.json") }),
    "dangling_symlink",
  );
  mkdirSync(join(env.ops, ".temp-docs", "x", "y"), { recursive: true });
  symlinkSync(join(env.ops, ".temp-docs", "x", "y"), join(env.engine, "deep"));
  symlinkSync("deep/../z.txt", join(env.engine, "behind-live"));
  assertFailedClosed(
    runHook(env, { cwd: env.engine, target: join(env.engine, "behind-live") }),
    "dangling_symlink",
  );
  // The one refusal on a tree without a marker is a link into nothing, even to another unmarked place.
  symlinkSync(join(env.outside, "not-yet.md"), join(env.engine, "dangling-local"));
  assertFailedClosed(
    runHook(env, { cwd: env.engine, target: join(env.engine, "dangling-local") }),
    "dangling_symlink",
  );
  // A loop cannot be resolved at all.
  symlinkSync(join(env.engine, "loop-b"), join(env.engine, "loop-a"));
  symlinkSync(join(env.engine, "loop-a"), join(env.engine, "loop-b"));
  assertFailedClosed(
    runHook(env, { cwd: env.engine, target: join(env.engine, "loop-a") }),
    "path_unresolvable",
  );
  // A live link on a tree without a marker is simply followed.
  symlinkSync(join(env.engine, "tools"), join(env.engine, "live"));
  assertAllowed(runHook(env, { cwd: env.engine, target: join(env.engine, "live", "new.mjs") }));
});

test("a differently spelled local settings file is still the local settings file", (t) => {
  const env = layout(t);
  assertRuleDenied(
    runHook(env, { cwd: env.ops, target: join(env.ops, ".claude", "Settings.Local.JSON") }),
    "settings_local",
  );
});

test("markers inside markers: the folder tool's own images decide nothing, any other nesting is refused", (t) => {
  const env = layout(t);
  const retained = join(env.ops, ".ops-tree", "previous", "20260101T000000Z");
  buildFolder(retained, "operational");
  assertRuleDenied(
    runHook(env, { cwd: env.ops, target: join(retained, "output", "x.md") }),
    "read_only_zone",
  );
  assertRuleDenied(
    runHook(env, { cwd: env.engine, target: join(retained, "output", "x.md") }),
    "inbound",
  );
  // The folder's own writes elsewhere are unaffected by the images.
  assertAllowed(runHook(env, { cwd: env.ops, target: join(env.ops, "output", "y.md") }));
  const nested = join(env.ops, ".temp-docs", "rehearsal");
  buildFolder(nested, "rehearsal");
  assertFailedClosed(
    runHook(env, { cwd: nested, target: join(nested, "output", "x.md") }),
    "nested_marker",
  );
  assertFailedClosed(
    runHook(env, { cwd: env.ops, target: join(nested, "output", "x.md") }),
    "nested_marker",
  );
});

// ---------------------------------------------------------------------------------------------
// Failures closed.

test("every failure to decide refuses and names itself", (t) => {
  const env = layout(t);
  assertFailedClosed(runHook(env, { raw: "" }), "payload_unreadable");
  assertFailedClosed(runHook(env, { raw: "{not json" }), "payload_unreadable");
  assertFailedClosed(runHook(env, { raw: " ".repeat(4 * 1024 * 1024 + 1) }), "payload_too_large");
  assertFailedClosed(
    runHook(env, { raw: JSON.stringify({ tool_input: { file_path: join(env.ops, "x") } }) }),
    "session_cwd_missing",
  );
  assertFailedClosed(
    runHook(env, { raw: JSON.stringify({ cwd: env.ops, tool_input: {} }) }),
    "write_target_missing",
  );

  const broken = (name, mutate) => {
    const root = join(env.base, name);
    buildFolder(root, "operational");
    mutate(root);
    return root;
  };
  const manifestPath = (root) => join(root, folderTool.MANIFEST_FILE_NAME);
  const rewrite = (overrides) => (root) => {
    writeFileSync(manifestPath(root), JSON.stringify(manifestFor("operational", overrides)));
  };
  const cases = {
    "only-service-directory": [(root) => rmSync(manifestPath(root)), "ops_manifest_missing"],
    "manifest-is-a-directory": [
      (root) => {
        rmSync(manifestPath(root));
        mkdirSync(manifestPath(root));
      },
      "ops_manifest_invalid",
    ],
    "manifest-is-a-link": [
      (root) => {
        const elsewhere = join(root, "output", "valid-manifest.json");
        writeFileSync(elsewhere, JSON.stringify(manifestFor("operational")));
        rmSync(manifestPath(root));
        symlinkSync(elsewhere, manifestPath(root));
      },
      "ops_manifest_invalid",
    ],
    "manifest-not-json": [(root) => writeFileSync(manifestPath(root), "{"), "ops_manifest_invalid"],
    "foreign-schema": [rewrite({ schema: "someone/else" }), "ops_manifest_invalid"],
    "version-two": [rewrite({ schema_version: 2 }), "ops_manifest_invalid"],
    "unknown-kind": [rewrite({ kind: "staging" }), "ops_manifest_invalid"],
    "unknown-state": [rewrite({ state: "half" }), "ops_manifest_invalid"],
    "broken-zones": [rewrite({ zones: { candidate: "candidate" } }), "ops_manifest_invalid"],
  };
  for (const [name, [mutate, code]] of Object.entries(cases)) {
    const root = broken(name, mutate);
    // Both directions refuse: the folder's own session and a session from outside.
    assertFailedClosed(runHook(env, { cwd: root, target: join(root, "output", "x") }), code);
    assertFailedClosed(runHook(env, { cwd: env.engine, target: join(root, "output", "x") }), code);
  }
  // Only the manifest half of the marker, with no service directory, marks the folder too.
  const manifestOnly = join(env.base, "manifest-only");
  buildFolder(manifestOnly, "operational");
  rmSync(join(manifestOnly, ".ops-tree"), { recursive: true });
  assertRuleDenied(
    runHook(env, { cwd: env.engine, target: join(manifestOnly, "output", "x") }),
    "inbound",
  );
  // A building folder is already a marked one.
  const building = broken("building", rewrite({ state: "building" }));
  assertRuleDenied(
    runHook(env, { cwd: env.engine, target: join(building, "output", "x") }),
    "inbound",
  );

  // A directory on the way up that cannot be searched.
  const locked = join(env.base, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  assertFailedClosed(
    runHook(env, { cwd: locked, target: join(env.outside, "x") }),
    "marker_unreadable",
  );
});

test("a notebook target and a second target are judged like the first", (t) => {
  const env = layout(t);
  assertRuleDenied(
    runHook(env, {
      cwd: env.engine,
      target: join(env.ops, "output", "n.ipynb"),
      toolName: "NotebookEdit",
    }),
    "inbound",
  );
  const both = payloadFor(env.engine, join(env.engine, "fine.md"));
  both.tool_input.notebook_path = join(env.ops, "output", "n.ipynb");
  assertRuleDenied(runHook(env, { raw: JSON.stringify(both) }), "inbound");
});

// ---------------------------------------------------------------------------------------------
// The copies the guard keeps, and its registration.

test("the guard's zone function and marker constants equal the folder tool's", () => {
  assert.equal(guard.MANIFEST_FILE_NAME, folderTool.MANIFEST_FILE_NAME);
  assert.equal(guard.SERVICE_DIRECTORY_NAME, folderTool.SERVICE_DIRECTORY_NAME);
  assert.equal(guard.MANIFEST_SCHEMA, folderTool.MANIFEST_SCHEMA);
  assert.equal(guard.MANIFEST_SCHEMA_VERSION, folderTool.MANIFEST_SCHEMA_VERSION);
  assert.deepEqual([...guard.FOLDER_KINDS], [...folderTool.FOLDER_KINDS]);
  // The folder tool states its two states only inside its parser; frozen here instead.
  assert.deepEqual([...guard.FOLDER_STATES], ["ready", "building"]);
  const paths = [
    "",
    "tools/process-log.mjs",
    "candidate",
    "candidate/profile.md",
    "candidate/research",
    "candidate/research/x/y.json",
    "candidate-other/x",
    "output",
    "output/a/b.docx",
    "process-log.json",
    "process-log.json.lock",
    "process-log.backup-20260101.json",
    "triage-ledger.json.tmp",
    "telegram-sweep-state.json",
    "outbox",
    "outbox/tasks/.imported.json",
    "ops-manifest.json",
    "ops-manifest.json.123.abc.tmp",
    ".ops-tree",
    ".ops-tree/lock",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/.cc-writes/x",
    "tools/cv-builder/node_modules/pkg/index.js",
    "tools/cv-builder/package.json",
    ".DS_Store",
    "output/.DS_Store",
    ".rehearsal/b.json",
    "records",
    "pkcs11.txt",
    ".temp-docs/x",
    "recordsx/y",
  ];
  for (const kind of folderTool.FOLDER_KINDS) {
    const zones = folderTool.zoneTableFor(kind);
    for (const path of paths) {
      assert.equal(guard.zoneOf(zones, path), folderTool.zoneOf(zones, path), `${kind}: ${path}`);
    }
  }
});

test("the local settings path the guard refuses is a state path of the zone table", () => {
  assert.equal(guard.LOCAL_SETTINGS_PATH, ".claude/settings.local.json");
  assert.equal(folderTool.ZONE_TABLE.stateNested.includes(guard.LOCAL_SETTINGS_PATH), true);
  assert.deepEqual([...guard.WRITABLE_ZONES], ["handover", "state"]);
});

test("the tracked settings register only the current guard", () => {
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const commands = settings.hooks.PreToolUse.flatMap((entry) =>
    entry.hooks.map((hook) => hook.command),
  );
  assert.deepEqual(commands, [EXPECTED_V2_COMMAND]);
});

test("runtime sandbox and test invocations retain the current boundary", () => {
  const raw = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(raw);
  assert.deepEqual(settings.sandbox, {
    allowUnsandboxedCommands: false,
    enabled: true,
    excludedCommands: ["npm run " + "ci", "npm run test:browser"],
    failIfUnavailable: true,
    network: { allowLocalBinding: true },
  });
  assert.doesNotMatch(raw, /\/Users\//);
  assert.doesNotMatch(raw, /job-search-pipeline/);
  assert.equal(settings.sandbox.filesystem, undefined);
  const { scripts } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(scripts.test, 'node --test "tests/!(process-search-browser).test.mjs"');
  assert.equal(scripts["test:browser"], "node --test tests/process-search-browser.test.mjs");
  for (const command of ["ci", "test:browser"]) assert.equal(typeof scripts[command], "string");
});

test("historical manifest retains its research write zone", (t) => {
  const env = layout(t);
  const marker = JSON.parse(readFileSync(join(env.ops, "ops-manifest.json"), "utf8"));
  marker.zones.stateNested.push("candidate/research");
  writeFileSync(join(env.ops, "ops-manifest.json"), JSON.stringify(marker));
  assertAllowed(
    runHook(env, { cwd: env.ops, target: join(env.ops, "candidate/research/note.json") }),
  );
});
