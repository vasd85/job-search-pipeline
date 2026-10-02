// Whether either half of the boundary executes is a property of the RUNTIME a
// session runs under, not of this repository: docs/runbooks/write-boundary-map.md#what-measured-the-write-boundary-table owns the measured
// per-runtime map (task 45's transcript probes), and no test can assert an OS
// sandbox from inside the process it would confine. This file owns what is
// provable from a test: the shape of the tracked settings that install both
// halves, the behaviour of the file-tool hook driven as a real child process
// over synthetic git topologies inside disposable roots, and the prose pins
// that keep the runbook's claims aligned with what was actually measured.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = resolve(
  repoRoot,
  ".claude/hooks/operational-write-boundary.mjs",
);
const settingsPath = resolve(repoRoot, ".claude/settings.json");

// The aggregate gate command is assembled from two parts on purpose: a
// repository-wide scan forbids its literal spelling in every test file but the
// one that owns the runner. The expected value is still frozen here, not read
// back from the file under test.
const AGGREGATE_GATE_COMMAND = `npm run ${"ci"}`;
const EXPECTED_EXCLUDED_COMMANDS = [
  AGGREGATE_GATE_COMMAND,
  "npm run test:browser",
];
const EXPECTED_MATCHER = "Edit|Write|NotebookEdit";
const EXPECTED_HOOK_COMMAND =
  'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/operational-write-boundary.mjs"';
// The marker-file guard runs beside this one until the switch removes this one's entry.
const EXPECTED_SECOND_HOOK_COMMAND =
  'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/write-guard.mjs"';

// Pinned whole, not key by key. The runtime accepts a dozen sandbox keys, and
// several of them weaken the boundary while every individual assertion about
// the keys we happened to think of stays green.
const EXPECTED_SANDBOX = {
  allowUnsandboxedCommands: false,
  enabled: true,
  excludedCommands: EXPECTED_EXCLUDED_COMMANDS,
  failIfUnavailable: true,
  network: { allowLocalBinding: true },
};

const EXPECTED_HOOKS = {
  PreToolUse: [
    {
      hooks: [
        { command: EXPECTED_SECOND_HOOK_COMMAND, type: "command" },
      ],
      matcher: EXPECTED_MATCHER,
    },
  ],
};

function settings() {
  return JSON.parse(readFileSync(settingsPath, "utf8"));
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return String(result.stdout ?? "");
}

function initRepository(root) {
  mkdirSync(root, { recursive: true });
  git(root, "init", "--quiet", ".");
  git(root, "config", "user.email", "boundary@example.invalid");
  git(root, "config", "user.name", "boundary");
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git(root, "add", "seed.txt");
  git(root, "commit", "--quiet", "-m", "seed");
}

/**
 * Reproduces the real topology, including the one property that breaks a naive
 * prefix test: the development container is a literal prefix sibling of the
 * operational root, so `<root>-worktrees/...` starts with `<root>`.
 */
function topology(t) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "job-search-boundary-"));
  t.after(() => rmSync(base, { force: true, recursive: true }));
  const primary = join(base, "pipeline");
  const linked = join(base, "pipeline-worktrees", "tasks", "probe");
  initRepository(primary);
  git(primary, "worktree", "add", "--quiet", "-b", "probe", linked, "HEAD");
  // Three more linked worktrees, because every question the rehearsal rule asks
  // is a question about one linked worktree's branch: the rehearsal tree it
  // protects, a plain sibling it must keep leaving alone, and a detached head
  // that names no branch at all.
  const rehearsal = join(base, "pipeline-worktrees", "rehearsal", "rollout");
  git(primary, "worktree", "add", "--quiet", "-b", "rehearsal/rollout", rehearsal, "HEAD");
  const sibling = join(base, "pipeline-worktrees", "tasks", "sibling");
  git(primary, "worktree", "add", "--quiet", "-b", "sibling", sibling, "HEAD");
  const detached = join(base, "pipeline-worktrees", "tasks", "detached");
  git(primary, "worktree", "add", "--quiet", "--detach", detached, "HEAD");
  // The layout the runbook forbids and git allows: a linked worktree inside the
  // primary one. Every containment test reads it as part of the primary, which
  // is a different tree with a different branch.
  const nested = join(primary, "sub-rehearsal");
  git(primary, "worktree", "add", "--quiet", "-b", "rehearsal/nested", nested, "HEAD");
  // The near miss. `rehearsal-dash` starts with the word and is not a rehearsal
  // tree, which is the only place a prefix test and a substring test disagree —
  // and a substring test would make this task's own branch,
  // `task/043-rehearsal-write-boundary-hook`, a rehearsal tree.
  const nearMiss = join(base, "pipeline-worktrees", "tasks", "rehearsal-dash");
  git(primary, "worktree", "add", "--quiet", "-b", "rehearsal-dash", nearMiss, "HEAD");
  // The other near miss, carrying the whole word AND its slash, just not at the
  // front. It is what separates a prefix from a substring, an unanchored regex,
  // and every other spelling that would make `wip/rehearsal/x` private.
  const deepMiss = join(base, "pipeline-worktrees", "tasks", "deep-miss");
  git(primary, "worktree", "add", "--quiet", "-b", "wip/rehearsal/roll", deepMiss, "HEAD");
  const elsewhere = join(base, "unrelated-clone");
  initRepository(elsewhere);
  return {
    base, deepMiss, detached, elsewhere, linked, nearMiss, nested, primary, rehearsal,
    sibling,
  };
}

// Asked of the filesystem, not of the hook. A test that accepts either verdict
// asserts nothing, and this is exactly the property a single-token mutation of
// the resolver would break.
function isCaseInsensitive(base) {
  const probe = join(base, "CaseProbe");
  writeFileSync(probe, "probe\n");
  try {
    statSync(join(base, "caseprobe"));
    return true;
  } catch {
    return false;
  }
}

function runHook({ cwd, env, toolInput, toolName = "Edit", rawPayload }) {
  const payload = rawPayload ?? JSON.stringify({
    cwd,
    hook_event_name: "PreToolUse",
    session_id: "boundary-probe",
    tool_input: toolInput,
    tool_name: toolName,
    tool_use_id: "toolu_boundary_probe",
  });
  return spawnSync(process.execPath, [hookPath], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    input: payload,
  });
}

// Exit code 2 blocks the tool call regardless of any payload, so the boundary
// does not depend on the stdout schema-validation behaviour of one runtime
// version. Allow stays silent, which is what "no decision" means to the caller.
function assertDenied(result) {
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.equal(result.stdout, "");
}

// Both refusals mention the operational checkout, so a test that only looked for
// that phrase would pass on either. These two assert which path produced the
// refusal: a case meant to reach the boundary rule must not be rescued by the
// fail-closed branch, and vice versa.
function assertRuleDenied(result, code) {
  assertDenied(result);
  assert.match(result.stderr, /Blocked target:/);
  assert.doesNotMatch(result.stderr, /could not resolve/i);
  // Three rules now refuse through this path. Without the code, a mutation that
  // answers one of them with another rule's verdict stays green.
  assert.match(result.stderr, new RegExp(`\\[${code}\\]`));
}

function assertBoundaryDenied(result) {
  assertRuleDenied(result, "operational_root");
  assert.match(result.stderr, /operational checkout/i);
}

function assertFailedClosed(result, code) {
  assertDenied(result);
  assert.match(result.stderr, /could not resolve/i);
  assert.doesNotMatch(result.stderr, /Blocked target:/);
  // Four different conditions share this refusal. Asserting only that it
  // happened would let any of them stand in for any other.
  assert.match(result.stderr, new RegExp(`\\(${code}:`));
}

function assertAllowed(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

// The declared set. The executed set is collected at run time and compared
// against it, so a case that is described here but never runs fails the file.
const EXPECTED_CASE_COUNT = 52;
const EXPECTED_CASES = [
  "allow: an operational-cwd session writes inside the operational root",
  "allow: a development session writes inside its own linked worktree",
  "allow: a development session writes outside every repository",
  "deny: a development session writes into the operational root",
  "deny: a development session writes into the operational ledger by relative path",
  "deny: the operational root itself is the target",
  "deny: a notebook target under the operational root",
  "deny: only the second of two targets is inside the operational root",
  "deny: a differently-cased path into the operational root",
  "deny: a symlink inside the worktree that resolves into the operational root",
  "deny: a session in its own clone writes into another primary worktree",
  "deny: a nested repository inside the session's own worktree",
  "deny: an absorbed-gitdir submodule fails closed on its git layout",
  "deny: the submodule stays denied even from a session inside it",
  "deny: git fails for a reason other than an absent repository",
  "deny: an ambient git redirection cannot open a hole",
  "deny: the target sits in an unexpected git layout",
  "deny: git cannot be resolved at all",
  "deny: the payload is not readable JSON",
  "deny: the payload names no write target",
  // The rehearsal boundary, appended as one block rather than woven into the
  // list above, so the indices of the operational cases stay where they were.
  // Two denials per direction plus three allowances: the rule must not widen
  // into every cross-worktree write, and it must never make a session unable to
  // edit its own tree.
  "deny: a development session writes into a rehearsal worktree",
  "deny: a rehearsal session writes into another linked worktree",
  "deny: a rehearsal session writes outside every repository",
  "allow: a rehearsal session writes inside its own worktree",
  "allow: a development session writes into a sibling development worktree",
  "allow: a detached session writes inside its own worktree",
  "deny: a detached linked worktree cannot be shown not to be a rehearsal tree",
  "deny: a detached session cannot be shown not to be a rehearsal run",
  "deny: a rehearsal worktree nested inside the primary one is still private",
  "deny: a session in a nested rehearsal worktree writes into the primary around it",
  "allow: a development session writes into a branch that only starts like a rehearsal one",
  "allow: a session on a branch that only starts like a rehearsal one writes out of it",
  "deny: a rehearsal checkout whose git directory was moved aside is still private",
  "deny: a target inside a worktree's administrative directory fails closed",
  "allow: a development session writes into a branch carrying the word deeper in its name",
  "allow: a session on a branch carrying the word deeper in its name writes out of it",
  "deny: a worktree that reports a root not containing the target fails closed",
  "deny: a rehearsal worktree that reports the primary's own root is still private",
  "deny: a run session whose tree reports the primary's own root still writes only to itself",
  "allow: that same run session writes inside its own tree",
  "deny: a run session writes into a copy of its own worktree",
  "deny: a directory whose .git file names another repository is not that repository",
  "allow: a run session writes into such a pointer directory inside its own tree",
  "allow: a run session writes to its own tree from a subdirectory of it",
  "deny: a development session writes into the operational candidate layer",
  // The one named exception to the primary-worktree rule: the candidate layer kept as a repository
  // of its own at the root of a development worktree. Two allowances and five denials, because
  // every condition of the exception — whose tree, which session kind, exactly which directory, a
  // real directory rather than a link — must be shown to be load-bearing.
  "allow: a development session writes into the candidate repository at the root of its own worktree",
  "deny: a session in a sibling worktree writes into that candidate repository",
  "deny: a primary session writes into a candidate repository at its own root",
  "deny: a candidate repository below the root of the session's worktree stays a nested repository",
  "deny: the operational session writes into a development worktree's candidate repository",
  "deny: a candidate symlink into another repository is not the session's own layer",
  "allow: a development session writes into its candidate repository from a subdirectory",
];

test("the tracked settings install both halves of the boundary", () => {
  assert.deepEqual(settings().sandbox, EXPECTED_SANDBOX);
  assert.deepEqual(settings().hooks, EXPECTED_HOOKS);
  // The registration must point at a file that exists in the committed tree.
  assert.match(readFileSync(hookPath, "utf8"), /operational/);
});

test("the split invocations stay aligned with the exclusion list", () => {
  const { scripts } = JSON.parse(
    readFileSync(resolve(repoRoot, "package.json"), "utf8"),
  );
  // The default suite must not carry the browser file, which headless Chrome
  // cannot run inside the sandbox, and the browser invocation must be exactly
  // that file rather than a second copy of the suite.
  assert.equal(
    scripts.test,
    'node --test "tests/!(process-search-browser).test.mjs"',
  );
  assert.equal(
    scripts["test:browser"],
    "node --test tests/process-search-browser.test.mjs",
  );
  // An exclusion that names a script nobody defines is a hole with a typo in it.
  for (const command of EXPECTED_EXCLUDED_COMMANDS) {
    assert.equal(typeof scripts[command.replace(/^npm run /, "")], "string", command);
  }
});

test("no tracked deny of the operational path leaks into the settings", () => {
  // The policy is cwd-relative by construction. A literal operational path in
  // tracked settings would constrain the operational checkout itself and would
  // not survive a fresh clone on another machine.
  const raw = readFileSync(settingsPath, "utf8");
  assert.doesNotMatch(raw, /\/Users\//);
  assert.doesNotMatch(raw, /job-search-pipeline/);
  assert.equal(settings().sandbox.filesystem, undefined);
});

// A prose pin proves consistency, never correctness: it cannot observe that a
// package stopped being blocked. It exists so the demotion, and the two
// statements that keep it from contradicting the cutover gate, cannot be
// reverted silently by an edit that no other test reads.
function normalized(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8").replace(/\s+/g, " ");
}

test("the runbook demotes task comparisons without contradicting the cutover gate", () => {
  // The demotion lives in docs/runbooks/write-boundary-map.md#operational-fingerprints. The two negative guards travelled with it: they now forbid the open-coded form in the
  // file that owns the procedure, and no longer in the runbook, which owns only the pointer.
  const map = normalized("docs/runbooks/write-boundary-map.md");
  assert.equal(map.includes("For a task comparison, every leg is diagnostic"), true);
  assert.equal(
    map.includes("the package is not blocked, the measurement is not repeated"),
    true,
  );
  // Both survivors, in the same file, so a reader cannot derive a contradiction.
  assert.match(map, /version mismatch[^.]{0,160}never a `PASS`/);
  assert.equal(
    map.includes("keeps its own blocking requirement that the records match"),
    true,
  );
  // The guard that `86ced2d` silently disabled must not come back.
  assert.equal(map.includes("`git status` must be clean for this file"), false);
  assert.equal(map.includes("it is in Git and not covered by `.gitignore`"), false);
  // The gate this map defers to still exists on the other side — and since task 66 the
  // other side is another file, so this is the one assertion of this test that does not read
  // the map.
  assert.equal(
    normalized("docs/runbooks/ops-cutover.md").includes(
      "is taken before the cutover and must match",
    ),
    true,
  );
});

test("the cutover bullet offers no third exclusion entry as a remedy", () => {
  // The bullet moved to its own runbook with task 66; the development runbook keeps a pointer
  // to the measured boundary; this test reads only the cutover owner.
  const cutover = normalized("docs/runbooks/ops-cutover.md");
  // Form-based, not phrase-based: any wording that tells the cutover operator
  // to put a command INTO the exclusion list is the defect, whichever verb
  // carries it. Honestly bounded: a static scan cannot forbid arbitrary
  // paraphrase, and replacement prose must keep noun forms — a listed
  // add/append/put/insert/include/extend/enter/write verb ahead of the literal fires this pin
  // on its own prohibition.
  assert.doesNotMatch(
    cutover,
    /\b(?:add|append|put|insert|include|extend|enter|write)\w*[^.]{0,120}`sandbox\.excludedCommands`/iu,
  );
  // The surviving fallback and the stated reason, so the bullet still answers
  // a failing render instead of going silent.
  assert.equal(
    cutover.includes(
      "leaves a local `.claude/settings.local.json` with the sandbox off in the operational checkout",
    ),
    true,
  );
  assert.equal(
    cutover.includes("A third entry in `sandbox.excludedCommands` is not a workaround"),
    true,
  );
  // Three anchors, linked pairwise: the prose numeral, this file's frozen
  // literal, and the settings themselves (deep-equalled above), so a prose
  // drift to another count cannot stay green while the list stands still.
  assert.equal(cutover.includes("the list is closed at exactly two entries"), true);
  assert.equal(EXPECTED_EXCLUDED_COMMANDS.length, 2);
});



test("both owners of the rehearsal branch convention name the same prefix", () => {
  // Pins the declaration, not its use: a tool that kept the constant and stopped
  // using it would slip past. The drift this catches is the one that actually
  // happens — the convention itself moving in the tool that creates these trees.
  //
  // The hook cannot import this from `tools/workspace-reset.mjs`: that module
  // pulls in the CI runner, the fetch layer and the triage ledger, and a hook
  // that fails to start is a hook the runtime skips — an import chain would
  // turn any breakage anywhere in it into an open write boundary. So the
  // constant is copied, and this pin is what keeps the copy honest: the tool
  // creates these trees, the hook decides what is one, and a convention change
  // in the tool alone would silently unlatch the guard.
  const EXPECTED_DECLARATION = `REHEARSAL_BRANCH_PREFIX = "rehearsal/";`;
  for (const owner of [hookPath, resolve(repoRoot, "tools/workspace-reset.mjs")]) {
    assert.equal(readFileSync(owner, "utf8").includes(EXPECTED_DECLARATION), true, owner);
  }
});


test("the hook decides every declared case and nothing else", (t) => {
  const {
    base, deepMiss, detached, elsewhere, linked, nearMiss, nested, primary, rehearsal,
    sibling,
  } = topology(t);
  const executed = [];
  const run = (name, body) => {
    executed.push(name);
    body();
  };

  run(EXPECTED_CASES[0], () => {
    assertAllowed(runHook({
      cwd: primary,
      toolInput: { file_path: join(primary, "process-log.json") },
    }));
  });

  run(EXPECTED_CASES[1], () => {
    assertAllowed(runHook({
      cwd: linked,
      toolInput: { file_path: join(linked, "tools", "new.mjs") },
      toolName: "Write",
    }));
  });

  run(EXPECTED_CASES[2], () => {
    assertAllowed(runHook({
      cwd: linked,
      toolInput: { file_path: join(base, "scratch", "note.txt") },
    }));
  });

  run(EXPECTED_CASES[3], () => {
    assertBoundaryDenied(runHook({
      cwd: linked,
      toolInput: { file_path: join(primary, "output", "acme-sdet", "cv.json") },
      toolName: "Write",
    }));
  });

  run(EXPECTED_CASES[4], () => {
    assertBoundaryDenied(runHook({
      cwd: linked,
      toolInput: { file_path: "../../../pipeline/process-log.json" },
    }));
  });

  run(EXPECTED_CASES[5], () => {
    assertBoundaryDenied(runHook({ cwd: linked, toolInput: { file_path: primary } }));
  });

  run(EXPECTED_CASES[6], () => {
    assertBoundaryDenied(runHook({
      cwd: linked,
      toolInput: { notebook_path: join(primary, "analysis.ipynb") },
      toolName: "NotebookEdit",
    }));
  });

  run(EXPECTED_CASES[7], () => {
    assertBoundaryDenied(runHook({
      cwd: linked,
      toolInput: {
        file_path: join(linked, "harmless.txt"),
        notebook_path: join(primary, "analysis.ipynb"),
      },
      toolName: "NotebookEdit",
    }));
  });

  run(EXPECTED_CASES[8], () => {
    const shouted = join(dirname(primary), "PIPELINE", "process-log.json");
    const result = runHook({ cwd: linked, toolInput: { file_path: shouted } });
    // On a case-insensitive filesystem the shouted path is the operational
    // ledger; on a case-sensitive one it is an absent directory in no
    // repository, which the boundary has nothing to say about.
    if (isCaseInsensitive(base)) assertBoundaryDenied(result);
    else assertAllowed(result);
  });

  run(EXPECTED_CASES[9], () => {
    const alias = join(linked, "alias");
    symlinkSync(primary, alias);
    assertBoundaryDenied(
      runHook({ cwd: linked, toolInput: { file_path: join(alias, "process-log.json") } }),
    );
  });

  run(EXPECTED_CASES[10], () => {
    // The session is its own primary checkout, so a rule derived from the
    // session alone would exempt it from every other operational tree.
    assertBoundaryDenied(runHook({
      cwd: elsewhere,
      toolInput: { file_path: join(primary, "process-log.json") },
    }));
  });

  run(EXPECTED_CASES[11], () => {
    // A vendored repository carrying its own .git directory inside your own
    // worktree is still a primary worktree, and the boundary rule covers it.
    // The refusal is loud and explainable; a silent exception would not be.
    // The one exception the rule has is named — `candidate` at the root of the
    // session's worktree — and has its own cases at the end of this list.
    // (An absorbed-gitdir submodule never reaches this rule: the two cases
    // below land in the fail-closed layout branch.)
    const nested = join(linked, "vendor", "nested");
    initRepository(nested);
    assertBoundaryDenied(
      runHook({ cwd: linked, toolInput: { file_path: join(nested, "file.txt") } }),
    );
  });

  run(EXPECTED_CASES[12], () => {
    // A standard absorbed-gitdir submodule reports its common directory under
    // the parent's .git/modules — a layout the guard cannot claim to
    // understand, so it fails closed instead of resolving a root. Local-path
    // submodule clones need protocol.file.allow since CVE-2022-39253.
    git(
      linked,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      elsewhere,
      "vendor/absorbed",
    );
    assertFailedClosed(
      runHook({
        cwd: linked,
        toolInput: { file_path: join(linked, "vendor", "absorbed", "file.txt") },
      }),
      "unexpected_git_layout",
    );
  });

  run(EXPECTED_CASES[13], () => {
    // The same refusal from a session whose cwd IS the submodule created by
    // the previous case: the corrected runbook sentence this file pins
    // promises no inside-session rescue, and this case alone kills a mutation
    // that rescues targets the session sits inside.
    const submodule = join(linked, "vendor", "absorbed");
    assertFailedClosed(
      runHook({
        cwd: submodule,
        toolInput: { file_path: join(submodule, "file.txt") },
      }),
      "unexpected_git_layout",
    );
  });

  run(EXPECTED_CASES[14], () => {
    // git reports a broken gitdir link with the same words it uses for a path
    // in no repository at all, so a message-reading classifier would allow this.
    const broken = join(base, "broken-repository");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, ".git"), "gitdir: /nonexistent-git-directory\n");
    assertFailedClosed(
      runHook({ cwd: linked, toolInput: { file_path: join(broken, "file.txt") } }),
      "git_failed",
    );
  });

  run(EXPECTED_CASES[15], () => {
    // An inherited git redirection must not decide this guard's answer.
    assertBoundaryDenied(runHook({
      cwd: linked,
      env: { GIT_CEILING_DIRECTORIES: base, GIT_DIR: join(base, "nonexistent-gitdir") },
      toolInput: { file_path: join(primary, "process-log.json") },
    }));
  });

  run(EXPECTED_CASES[16], () => {
    const work = join(base, "separate-work");
    const gitDir = join(base, "separate-gitdir");
    git(base, "init", "--quiet", `--separate-git-dir=${gitDir}`, work);
    assertFailedClosed(
      runHook({ cwd: linked, toolInput: { file_path: join(work, "file.txt") } }),
      "unexpected_git_layout",
    );
  });

  run(EXPECTED_CASES[17], () => {
    assertFailedClosed(runHook({
      cwd: linked,
      env: { PATH: join(base, "no-tools-here") },
      toolInput: { file_path: join(primary, "process-log.json") },
    }), "git_unavailable");
  });

  run(EXPECTED_CASES[18], () => {
    assertFailedClosed(runHook({ rawPayload: "{not json" }), "unexpected_error");
  });

  run(EXPECTED_CASES[19], () => {
    assertFailedClosed(
      runHook({ cwd: linked, toolInput: { description: "no path at all" } }),
      "write_target_missing",
    );
  });

  run(EXPECTED_CASES[20], () => {
    // A rehearsal tree is the run session's private state: its ledger decides
    // what the next batch re-fetches, so a write from outside changes what the
    // run measures. Under the operational rule alone this target is an ordinary
    // linked worktree and passes.
    assertRuleDenied(runHook({
      cwd: linked,
      toolInput: { file_path: join(rehearsal, "triage-ledger.json") },
      toolName: "Write",
    }), "rehearsal_inbound");
  });

  run(EXPECTED_CASES[21], () => {
    // The worse direction: a run session editing source that the run is
    // supposed to be measuring. `main` and every task worktree are linked
    // worktrees, so the operational rule never saw this write at all.
    assertRuleDenied(runHook({
      cwd: rehearsal,
      toolInput: { file_path: join(linked, "tools", "vacancy-fetch", "batch.mjs") },
    }), "rehearsal_outbound");
  });

  run(EXPECTED_CASES[22], () => {
    // The pinned half of the decision the task left open: a run session keeps
    // no scratch surface outside its own tree. Everything the run produces
    // carries real vacancy URLs, and the deletion procedure destroys exactly
    // one directory — the tree. A file outside it survives that procedure.
    assertRuleDenied(runHook({
      cwd: rehearsal,
      toolInput: { file_path: join(base, "scratch", "note.txt") },
    }), "rehearsal_outbound");
  });

  run(EXPECTED_CASES[23], () => {
    assertAllowed(runHook({
      cwd: rehearsal,
      toolInput: { file_path: join(rehearsal, ".rehearsal", "batches", "rollout", "plan.json") },
      toolName: "Write",
    }));
  });

  run(EXPECTED_CASES[24], () => {
    // The scope boundary, pinned as an allowance: the new rule is about
    // rehearsal trees, not about every write that crosses a worktree.
    assertAllowed(runHook({
      cwd: linked,
      toolInput: { file_path: join(sibling, "tools", "new.mjs") },
      toolName: "Write",
    }));
  });

  run(EXPECTED_CASES[25], () => {
    // A session editing its own tree is answered before any branch is read.
    // Otherwise a rebase — which detaches HEAD — would deny the very edits that
    // resolve its conflicts, and the next detached head would make the guard
    // something to route around.
    assertAllowed(runHook({
      cwd: detached,
      toolInput: { file_path: join(detached, "seed.txt") },
    }));
  });

  run(EXPECTED_CASES[26], () => {
    // A detached head names no branch, so nothing here proves this tree is not
    // a rehearsal tree checked out at its pinned base.
    assertFailedClosed(runHook({
      cwd: linked,
      toolInput: { file_path: join(detached, "file.txt") },
    }), "target_head_detached");
  });

  run(EXPECTED_CASES[27], () => {
    // The same gap on the session side, and the same answer.
    assertFailedClosed(runHook({
      cwd: detached,
      toolInput: { file_path: join(linked, "file.txt") },
    }), "session_head_detached");
  });

  run(EXPECTED_CASES[28], () => {
    // Its files sit inside the primary worktree, so the operational rule would
    // hand this write to any session living in that primary — the checkout the
    // real ledger lives in. It is a different tree on a different branch.
    assertRuleDenied(runHook({
      cwd: primary,
      toolInput: { file_path: join(nested, "triage-ledger.json") },
      toolName: "Write",
    }), "rehearsal_inbound");
  });

  run(EXPECTED_CASES[29], () => {
    // And the direction that matters more: the session sits inside the primary
    // worktree by path, so every containment test says it may write the real
    // ledger. It is a run session, and it may not.
    assertRuleDenied(runHook({
      cwd: nested,
      toolInput: { file_path: join(primary, "process-log.json") },
    }), "rehearsal_outbound");
  });

  run(EXPECTED_CASES[30], () => {
    // Both directions of the near miss, because the rule reads the branch of
    // the target's tree and of the session's tree through two separate calls.
    assertAllowed(runHook({
      cwd: linked,
      toolInput: { file_path: join(nearMiss, "tools", "new.mjs") },
      toolName: "Write",
    }));
  });

  run(EXPECTED_CASES[31], () => {
    assertAllowed(runHook({
      cwd: nearMiss,
      toolInput: { file_path: join(linked, "tools", "new.mjs") },
      toolName: "Write",
    }));
  });

  run(EXPECTED_CASES[32], () => {
    // A checkout whose git directory was moved aside reports that directory as
    // both its own and the common one, so a linked-ness test that only compares
    // those two calls it a primary worktree and never reads its branch. Its
    // files are still a work tree with a branch of its own.
    const work = join(base, "displaced-work");
    const holder = join(base, "displaced-git");
    mkdirSync(holder, { recursive: true });
    git(base, "init", "--quiet", `--separate-git-dir=${join(holder, ".git")}`, work);
    git(work, "config", "user.email", "boundary@example.invalid");
    git(work, "config", "user.name", "boundary");
    writeFileSync(join(work, "seed.txt"), "seed\n");
    git(work, "add", "seed.txt");
    git(work, "commit", "--quiet", "-m", "seed");
    git(work, "symbolic-ref", "HEAD", "refs/heads/rehearsal/displaced");
    assertRuleDenied(runHook({
      cwd: linked,
      toolInput: { file_path: join(work, "triage-ledger.json") },
      toolName: "Write",
    }), "rehearsal_inbound");
  });

  run(EXPECTED_CASES[33], () => {
    // The administrative directory of a linked worktree lives under the primary
    // one but is not a work tree, so git cannot say which root it belongs to.
    // The session lives in the primary and would have been allowed here before
    // the branch question existed; refusing is the deliberate side. The code is
    // the one today's git produces: a future git that answered here would still
    // be refused, by the containment guard and its own code, and this case would
    // go red to be re-read rather than because the hook broke.
    assertFailedClosed(runHook({
      cwd: primary,
      toolInput: { file_path: join(primary, ".git", "worktrees", "probe", "gitdir") },
    }), "git_failed");
  });

  run(EXPECTED_CASES[34], () => {
    assertAllowed(runHook({
      cwd: linked,
      toolInput: { file_path: join(deepMiss, "tools", "new.mjs") },
      toolName: "Write",
    }));
  });

  run(EXPECTED_CASES[35], () => {
    assertAllowed(runHook({
      cwd: deepMiss,
      toolInput: { file_path: join(linked, "tools", "new.mjs") },
      toolName: "Write",
    }));
  });

  run(EXPECTED_CASES[36], () => {
    // `core.worktree` can point a worktree's files anywhere, including at a
    // directory that has nothing to do with the target git was asked about. The
    // guard against that answer is the only thing standing between this layout
    // and a root the rest of the rules would trust.
    //
    // This case and the next one turn on `extensions.worktreeConfig` for the
    // whole fixture repository, and the two after them reuse the tree the next
    // one builds. Every case past this line therefore inherits that setting
    // without asking for it. All of them are independent of it — none reads or
    // writes a `core.worktree`, and these two are the only ones that do — so a
    // case that would not be independent belongs above this line instead.
    const stray = join(base, "not-a-worktree");
    mkdirSync(stray, { recursive: true });
    const redirected = join(base, "pipeline-worktrees", "tasks", "redirected");
    git(primary, "worktree", "add", "--quiet", "-b", "redirected", redirected, "HEAD");
    git(primary, "config", "extensions.worktreeConfig", "true");
    git(redirected, "config", "--worktree", "core.worktree", stray);
    assertFailedClosed(runHook({
      cwd: linked,
      toolInput: { file_path: join(redirected, "file.txt") },
    }), "worktree_root_unrelated");
  });

  run(EXPECTED_CASES[37], () => {
    // The same configuration turned the other way: the tree reports the primary
    // worktree's own root, so every identity derived from a path — containment
    // or the reported root itself — says the session in the primary is already
    // standing in this tree, and the branch that would have refused is never
    // read. The git directory is what does not move.
    const inner = join(primary, "redirected-rehearsal");
    git(primary, "worktree", "add", "--quiet", "-b", "rehearsal/redirected", inner, "HEAD");
    git(primary, "config", "extensions.worktreeConfig", "true");
    git(inner, "config", "--worktree", "core.worktree", primary);
    assertRuleDenied(runHook({
      cwd: primary,
      toolInput: { file_path: join(inner, "triage-ledger.json") },
      toolName: "Write",
    }), "rehearsal_inbound");
  });

  run(EXPECTED_CASES[38], () => {
    // The outbound side of the case above, on the tree that case created: the
    // session lives in the redirected rehearsal tree, whose reported root is the
    // primary worktree. Read there, the branch is the primary's and the run
    // session is free to edit source anywhere.
    const inner = join(primary, "redirected-rehearsal");
    assertRuleDenied(runHook({
      cwd: inner,
      toolInput: { file_path: join(linked, "tools", "new.mjs") },
      toolName: "Write",
    }), "rehearsal_outbound");
  });

  run(EXPECTED_CASES[39], () => {
    // The allowance the two questions have to keep: this session's own files are
    // its own, and the reported root being the primary's is what makes the
    // containment half of the test say so.
    const inner = join(primary, "redirected-rehearsal");
    assertAllowed(runHook({
      cwd: inner,
      toolInput: { file_path: join(inner, ".rehearsal", "batches", "one", "plan.json") },
      toolName: "Write",
    }));
  });

  run(EXPECTED_CASES[40], () => {
    // A copied worktree carries a copied `.git` file, which still names the
    // original's administrative directory. The two directories then share every
    // answer git gives about identity while being different files — and this is
    // the copy a person makes by hand, not a layout git builds.
    const copy = join(base, "rehearsal-copy");
    cpSync(rehearsal, copy, { recursive: true, verbatimSymlinks: true });
    assertRuleDenied(runHook({
      cwd: rehearsal,
      toolInput: { file_path: join(copy, "captured.json") },
      toolName: "Write",
    }), "rehearsal_outbound");
  });

  run(EXPECTED_CASES[41], () => {
    // The same confusion written by hand and pointed at the operational
    // checkout: two lines of text, no git command, and identity alone would
    // call this session's directory the primary worktree itself.
    const stray = join(base, "stray-pointer");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, ".git"), `gitdir: ${join(primary, ".git")}\n`);
    assertBoundaryDenied(runHook({
      cwd: stray,
      toolInput: { file_path: join(primary, "process-log.json") },
    }));
  });

  run(EXPECTED_CASES[42], () => {
    // Which way containment is asked decides this one. The directory names the
    // same administrative directory and reports a root of its own, so asking
    // whether the session sits under the TARGET's root refuses it. It is inside
    // the rehearsal tree, it dies with the rehearsal tree, and the question that
    // gets that right is whether the target sits under the SESSION's root.
    const pointer = join(rehearsal, "inner-pointer");
    mkdirSync(pointer, { recursive: true });
    copyFileSync(join(rehearsal, ".git"), join(pointer, ".git"));
    assertAllowed(runHook({
      cwd: rehearsal,
      toolInput: { file_path: join(pointer, "captured.json") },
      toolName: "Write",
    }));
  });

  run(EXPECTED_CASES[43], () => {
    // Every other case runs its session from a worktree root, and that left the
    // containment half readable as "under the directory the session happens to
    // stand in". A session works from wherever it works: two levels down, its
    // own tree's root file is still its own.
    const deep = join(rehearsal, "deep", "nest");
    mkdirSync(deep, { recursive: true });
    assertAllowed(runHook({
      cwd: deep,
      toolInput: { file_path: join(rehearsal, "top.json") },
      toolName: "Write",
    }));
  });

  run(EXPECTED_CASES[44], () => {
    // The candidate layer is one person's profile, preferences and configured
    // values, and in the operational checkout it is the real one. Nothing about
    // it is written into this guard: it is refused because it sits inside a
    // primary worktree, the same reason the ledger and `output/` are. The case
    // is here so that a later carve-out for some subdirectory of the
    // operational root cannot take the layer with it unnoticed.
    assertBoundaryDenied(runHook({
      cwd: linked,
      toolInput: { file_path: join(primary, "candidate", "config.json") },
      toolName: "Write",
    }));
  });

  // The layer the working tree edits: a repository of its own at the root of
  // the development worktree, ignored by the engine and never a checkout of it.
  const layer = join(linked, "candidate");
  initRepository(layer);

  run(EXPECTED_CASES[45], () => {
    assertAllowed(runHook({
      cwd: linked,
      toolInput: { file_path: join(layer, "profile.md") },
      toolName: "Write",
    }));
  });

  run(EXPECTED_CASES[46], () => {
    // Stricter than the rule for sibling worktrees themselves: the layer is
    // edited from the tree it lives in, and from nowhere else.
    assertBoundaryDenied(runHook({
      cwd: sibling,
      toolInput: { file_path: join(layer, "profile.md") },
    }));
  });

  run(EXPECTED_CASES[47], () => {
    // A primary session is where an operational checkout — or a scratch clone
    // that happens to contain one — lives, so the exception is not its to use.
    const ownLayer = join(primary, "candidate");
    initRepository(ownLayer);
    assertBoundaryDenied(runHook({
      cwd: primary,
      toolInput: { file_path: join(ownLayer, "profile.md") },
    }));
  });

  run(EXPECTED_CASES[48], () => {
    const deeper = join(linked, "vendor", "candidate");
    initRepository(deeper);
    assertBoundaryDenied(runHook({
      cwd: linked,
      toolInput: { file_path: join(deeper, "profile.md") },
    }));
  });

  run(EXPECTED_CASES[49], () => {
    assertBoundaryDenied(runHook({
      cwd: primary,
      toolInput: { file_path: join(layer, "profile.md") },
    }));
  });

  run(EXPECTED_CASES[50], () => {
    // The directory is compared as spelled, not as resolved: a link named
    // `candidate` resolves into whatever repository it points at, and that
    // repository is judged by the rule, not by the name of the link.
    const link = join(sibling, "candidate");
    symlinkSync(join(primary, "candidate"), link);
    assertBoundaryDenied(runHook({
      cwd: sibling,
      toolInput: { file_path: join(link, "profile.md") },
    }));
  });

  run(EXPECTED_CASES[51], () => {
    const deep = join(linked, "tools", "nested");
    mkdirSync(deep, { recursive: true });
    assertAllowed(runHook({
      cwd: deep,
      toolInput: { file_path: join(layer, "levers.md") },
    }));
  });

  assert.deepEqual(executed, EXPECTED_CASES);
  // The literal catches a coordinated delete-and-renumber that keeps the two
  // arrays equal to each other while covering less.
  assert.equal(executed.length, EXPECTED_CASE_COUNT);
});

test("the deny message states the rule instead of only refusing", (t) => {
  const { linked, primary } = topology(t);
  const denied = runHook({
    cwd: linked,
    toolInput: { file_path: join(primary, "process-log.json") },
  });
  assert.equal(denied.status, 2);
  // A guard whose message does not say what to do instead trains its reader to
  // route around it.
  assert.match(denied.stderr, /operational checkout/i);
  assert.match(denied.stderr, /development/i);
  assert.equal(denied.stderr.includes(primary), true);
});
