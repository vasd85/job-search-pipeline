// The tool under test removes ignored state that Git cannot give back, so this file drives it
// over real git topologies in disposable roots: a primary worktree, a linked rehearsal worktree
// beside it, and — where the case needs one — a task worktree, a detached one and a foreign
// clone. Every behavioural case runs the CLI as a real child process, so the exit code and the
// bounded refusal on stderr are the observed contract rather than a return value.
//
// Two things are deliberately synthetic. The fixture repository carries stubs at
// `tools/bootstrap.mjs` and `tools/triage-ledger.mjs` instead of copies of the real ones: what
// this file proves about them is that the tool runs *the tree's own* copies, from the tree's own
// root, with a scrubbed environment, and the argv pin below freezes exactly that. And no case
// touches this repository's own worktrees or `.git`: a test that created a worktree of the
// repository under test would write into the shared object database it is running from.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  LOCK_STALE_AFTER_MS,
  MAX_INVENTORY_BYTES,
  MAX_LOCK_OWNER_BYTES,
  MAX_INVENTORY_DEPTH,
  MAX_INVENTORY_ENTRIES,
  REHEARSAL_BRANCH_PREFIX,
  WIPE_RULES,
  WORKSPACE_RESET_VERSION,
  WorkspaceResetError,
  confirmationToken,
  rehearsalTreeLabel,
  runWorkspaceReset,
} from "../tools/workspace-reset.mjs";
import { planBatch, readLedger, vacancyIdentity } from "../tools/lib/triage-ledger-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toolPath = join(repoRoot, "tools", "workspace-reset.mjs");

// The wipe list, frozen independently of the module that owns it. A rule silently added here
// deletes something nobody reviewed; a rule silently dropped leaves state that poisons the next
// batch. Both directions are failures, so the whole list is compared, in order.
const PINNED_WIPE_RULES = [
  "process-log",
  "process-log-lock",
  "process-log-lock-residue",
  "process-log-tmp",
  "process-log-backup",
  "triage-ledger",
  "triage-ledger-lock",
  "triage-ledger-tmp",
  "output",
  "pipeline-input",
  "playwright",
  "pkcs11",
];

// One token from fixed inputs, frozen as a literal. Re-deriving it from the module would accept
// any preimage that agrees with itself: dropping the branch, or the tree digest, would still
// round-trip.
const PINNED_TOKEN_INPUT = Object.freeze({
  branch: "rehearsal/probe",
  head: "a".repeat(40),
  rootRealPath: "/tmp/rehearsal-probe",
});
const PINNED_TREE_DIGEST = "b".repeat(64);
const PINNED_TOKEN = "dcdbc5a695395ecf3ed9b84fc36d112f361056d6b6852761d9d20177e014f486";
// The same inventory, confirmed for a run that also moves HEAD. A preimage that ignored the
// repin would produce the value above for both.
const PINNED_REPIN_SHA = "c".repeat(40);
const PINNED_REPIN_TOKEN = "65f7f05b2edb7b727b398875de3ac176c0a3d1d89c9b3cad0cd685689baa2b7e";

const IGNORE_FILE = [
  "output/",
  "/process-log.json",
  "process-log.json.lock",
  "process-log.json.lock.*",
  "process-log.json.*.tmp",
  "/process-log.backup-*.json",
  "/.pipeline-input/",
  "/.rehearsal/",
  "/triage-ledger.json",
  "triage-ledger.json.lock",
  "triage-ledger.json.*.tmp",
  ".playwright-mcp/",
  "pkcs11.txt",
  "",
].join("\n");

// Stands in for tools/bootstrap.mjs: the same "create the ledger and the output root, never
// overwrite an existing one" contract, without the schema this file is not testing.
const BOOTSTRAP_STUB = `import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const log = resolve(root, "process-log.json");
const created = !existsSync(log);
if (created) writeFileSync(log, "{}");
mkdirSync(resolve(root, "output"), { recursive: true });
console.log(JSON.stringify({ status: created ? "initialized" : "ready" }));
`;

// Stands in for tools/triage-ledger.mjs init, including its refusal to overwrite.
const LEDGER_STUB = `import { closeSync, openSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const path = resolve(root, "triage-ledger.json");
const empty = JSON.stringify({ schema_version: 1, batches: [], entries: [] }, null, 2);
try {
  const descriptor = openSync(path, "wx", 0o600);
  writeSync(descriptor, empty);
  closeSync(descriptor);
  console.log(JSON.stringify({ created: true }));
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
  console.log(JSON.stringify({ created: false }));
}
`;

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return String(result.stdout ?? "");
}

/** The ambient environment minus this project's own variables, plus whatever a case adds back. */
function cleanEnvironment(extra = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("JOB_PIPELINE_")) delete environment[key];
  }
  return { ...environment, ...extra };
}

/**
 * Primary worktree, a linked rehearsal worktree pinned to the first commit, and a second commit
 * to re-pin onto. The container is a literal prefix sibling of the primary root, the shape the
 * real machine has.
 */
function topology(t, { ignoreRehearsal = true, label = "probe" } = {}) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "workspace-reset-"));
  t.after(() => rmSync(base, { force: true, recursive: true }));
  const primary = join(base, "pipeline");
  const linked = join(base, "pipeline-worktrees", "rehearsal", label);
  mkdirSync(join(primary, "tools"), { recursive: true });
  git(primary, "init", "--quiet", ".");
  git(primary, "config", "user.email", "rehearsal@example.invalid");
  git(primary, "config", "user.name", "rehearsal");
  // Personal excludes must not decide what this fixture calls dirt: on a machine whose global
  // ignore already hides .claude/, the settings-file case below would assert nothing.
  git(primary, "config", "core.excludesFile", "/dev/null");
  writeFileSync(
    join(primary, ".gitignore"),
    ignoreRehearsal ? IGNORE_FILE : IGNORE_FILE.replace("/.rehearsal/\n", ""),
  );
  writeFileSync(join(primary, "tools", "bootstrap.mjs"), BOOTSTRAP_STUB);
  writeFileSync(join(primary, "tools", "triage-ledger.mjs"), LEDGER_STUB);
  writeFileSync(join(primary, "seed.txt"), "seed\n");
  git(primary, "add", "-A");
  git(primary, "commit", "--quiet", "-m", "seed");
  const first = git(primary, "rev-parse", "HEAD").trim();
  writeFileSync(join(primary, "second.txt"), "second\n");
  git(primary, "add", "-A");
  git(primary, "commit", "--quiet", "-m", "second");
  const second = git(primary, "rev-parse", "HEAD").trim();
  git(primary, "worktree", "add", "--quiet", "-b", `${REHEARSAL_BRANCH_PREFIX}${label}`, linked,
    first);
  return { base, first, linked, primary, second };
}

function cli(cwd, args, environment = cleanEnvironment()) {
  return spawnSync(process.execPath, [toolPath, ...args], {
    cwd,
    encoding: "utf8",
    env: environment,
  });
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

function initialize(linked, extra = []) {
  return ok(cli(linked, ["init", "--purpose", "probe run", ...extra]));
}

/** The review phase, then the confirming phase with the token it printed. */
function resetWithReview(linked, extra = []) {
  const review = ok(cli(linked, ["reset", "--dry-run", ...extra]));
  assert.equal(review.status, "review_required");
  const confirmed = ok(cli(
    linked,
    ["reset", "--confirmation-token", review.confirmation_token, ...extra],
  ));
  return { confirmed, review };
}

function ledgerWithFlaggedRow() {
  const identity = vacancyIdentity("https://boards.greenhouse.io/acme/jobs/12345");
  return {
    schema_version: 1,
    batches: [{
      batch_id: "probe-1",
      recorded_at: "2026-08-20T10:00:00Z",
      entry_count: 1,
      entries_digest: "c".repeat(64),
    }],
    entries: [{
      key: identity.key,
      source: identity.source,
      job_id: identity.jobId,
      url: identity.url,
      first_seen: "2026-08-20T10:00:00Z",
      last_checked: "2026-08-20T10:00:00Z",
      status: "open",
      batch_id: "probe-1",
      decision: "REVIEW",
      flags: ["gap.compensation"],
    }],
  };
}

function ageDirectory(path, milliseconds) {
  const seconds = (Date.now() - milliseconds) / 1000;
  utimesSync(path, seconds, seconds);
}

// The declared set. The executed one is collected at run time and compared with it, so a case
// described here but never registered fails the file.
const EXPECTED_CASE_COUNT = 22;
const EXPECTED_CASES = [
  "the wipe list, the confirmation preimage and the staleness window are the frozen ones",
  "a rehearsal tree label takes the --batch alphabet and nothing else",
  "init pins the base, locks the tree and creates the ledger and the output root",
  "init keeps an existing pin and refuses to move one",
  "init seeds a validated ledger and refuses to overwrite one",
  "preflight reports a ready tree",
  "preflight refuses a moved HEAD, a bad base, a missing ledger and a dirty tree",
  "reset reviews before it removes and refuses a token that does not match",
  "reset removes the wipe list, keeps the rehearsal evidence and re-creates the state",
  "reset --repin moves HEAD, rewrites the base and leaves a plannable ledger",
  "reset refuses a live lock and lists a stale one in the inventory",
  "reset refuses unreviewed flags and an unreadable ledger, and takes the waiver",
  "reset refuses a tracked target",
  "reset refuses a symbolic link and an unbounded tree",
  "no invocation aimed at the operational checkout gets past a guard",
  "a task branch, a detached HEAD and a foreign label are refused",
  "an ambient JOB_PIPELINE_ variable stops the tool",
  "a working directory below the root is refused and an unreadable one fails closed",
  "the argument parser refuses unknown, duplicated and mutually exclusive options",
  "the init half runs the tree's own tools with the scrubbed environment",
  "an unavailable git, a failing child and a drifting inventory are bounded refusals",
  "a repin that did not move HEAD and a worktree moved out from under its registration",
];

const executed = [];

function scenario(name, body) {
  assert.ok(EXPECTED_CASES.includes(name), `undeclared case: ${name}`);
  test(name, (t) => {
    executed.push(name);
    return body(t);
  });
}

scenario(EXPECTED_CASES[0], () => {
  assert.deepEqual(WIPE_RULES.map((rule) => rule.id), PINNED_WIPE_RULES);
  assert.equal(WIPE_RULES.length, 12);
  assert.equal(confirmationToken(PINNED_TOKEN_INPUT, PINNED_TREE_DIGEST), PINNED_TOKEN);
  assert.equal(
    confirmationToken({ ...PINNED_TOKEN_INPUT, repin: PINNED_REPIN_SHA }, PINNED_TREE_DIGEST),
    PINNED_REPIN_TOKEN,
  );
  assert.notEqual(PINNED_TOKEN, PINNED_REPIN_TOKEN);
  assert.equal(WORKSPACE_RESET_VERSION, 1);
  assert.equal(LOCK_STALE_AFTER_MS, 30_000);
  assert.equal(MAX_INVENTORY_ENTRIES, 4096);
  assert.equal(MAX_INVENTORY_DEPTH, 24);
  assert.equal(MAX_INVENTORY_BYTES, 268_435_456);
  assert.equal(MAX_LOCK_OWNER_BYTES, 4096);

  // Which rule claims which name, so a widened prefix cannot quietly swallow a neighbour and a
  // narrowed one cannot leave residue behind.
  const claim = (name) => WIPE_RULES.find((rule) => rule.match(name))?.id ?? null;
  assert.equal(claim("process-log.json"), "process-log");
  assert.equal(claim("process-log.json.lock"), "process-log-lock");
  assert.equal(claim(`process-log.json.lock.candidate-4242-${"a".repeat(32)}`),
    "process-log-lock-residue");
  assert.equal(claim(`process-log.json.lock.claim-4242-${"a".repeat(32)}`),
    "process-log-lock-residue");
  assert.equal(claim("process-log.json.4242.9f.tmp"), "process-log-tmp");
  assert.equal(claim("process-log.backup-20260818.json"), "process-log-backup");
  assert.equal(claim("triage-ledger.json"), "triage-ledger");
  assert.equal(claim("triage-ledger.json.lock"), "triage-ledger-lock");
  assert.equal(claim("triage-ledger.json.4242.9f.tmp"), "triage-ledger-tmp");
  assert.equal(claim("output"), "output");
  assert.equal(claim(".pipeline-input"), "pipeline-input");
  assert.equal(claim(".playwright-mcp"), "playwright");
  assert.equal(claim("pkcs11.txt"), "pkcs11");

  // What no rule may ever claim: the evidence directory, the source tree, the toolchain.
  for (const name of [".rehearsal", ".git", "knowledge", "tools", "docs", "package.json",
    "output.json", "process-log.json.keep", "triage-ledger.json.bak"]) {
    assert.equal(claim(name), null, name);
  }
});

scenario(EXPECTED_CASES[1], () => {
  assert.equal(rehearsalTreeLabel("rehearsal/rollout-2026-08"), "rollout-2026-08");
  assert.equal(rehearsalTreeLabel("rehearsal/a"), "a");
  assert.equal(rehearsalTreeLabel(`rehearsal/${"a".repeat(64)}`), "a".repeat(64));
  // The ledger's own identifier alphabet accepts a dot, an underscore and a capital; the fetch
  // layer does not, and the tree label follows the fetch layer so a first batch can reuse it.
  for (const branch of ["main", "ops/current", "task/042-workspace-reset-cli", "rehearsal",
    "rehearsal/", "rehearsal/Rollout", "rehearsal/roll_out", "rehearsal/roll.out",
    "rehearsal/-rollout", "rehearsal/nested/label", "not-rehearsal/probe",
    `rehearsal/${"a".repeat(65)}`]) {
    assert.equal(rehearsalTreeLabel(branch), null, branch);
  }
});

scenario(EXPECTED_CASES[2], (t) => {
  const { first, linked } = topology(t);
  const report = initialize(linked);

  assert.equal(report.status, "initialized");
  assert.equal(report.label, "probe");
  assert.equal(report.branch, "rehearsal/probe");
  assert.equal(report.head, first);
  assert.equal(report.base.sha, first);
  assert.equal(report.base.purpose, "probe run");
  assert.match(report.base.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(linked, ".rehearsal", "base.json"), "utf8")),
    report.base,
  );

  // The lock is the whole mechanical protection of the deletion policy, so it is asked of git.
  assert.equal(report.locked, "created");
  assert.match(git(linked, "worktree", "list", "--porcelain"), /locked unharvested: probe run/);

  // The two creation commands ran, and ran here.
  assert.equal(statSync(join(linked, "process-log.json")).isFile(), true);
  assert.equal(statSync(join(linked, "triage-ledger.json")).isFile(), true);
  assert.equal(statSync(join(linked, "output")).isDirectory(), true);

  // The render prerequisites a fresh worktree lacks are printed, not left to be rediscovered.
  assert.equal(report.notes.length, 2);
  assert.match(report.notes.join(" "), /settings\.local\.json/);
  assert.match(report.notes.join(" "), /cv-builder\/node_modules/);
});

scenario(EXPECTED_CASES[3], (t) => {
  const { first, linked, second } = topology(t);
  const created = initialize(linked);

  const again = initialize(linked);
  assert.equal(again.locked, "already");
  assert.equal(again.base.created_at, created.base.created_at);
  assert.equal(again.base.sha, first);

  // The runbook requires one field and lets a tree record anything else; a rewrite keeps it.
  writeFileSync(
    join(linked, ".rehearsal", "base.json"),
    JSON.stringify({ sha: first, note: "written by hand" }),
  );
  initialize(linked);
  assert.equal(
    JSON.parse(readFileSync(join(linked, ".rehearsal", "base.json"), "utf8")).note,
    "written by hand",
  );

  // Moving a pin is reset --repin's job. init refuses rather than rewriting the sha under
  // evidence that was measured against the old one.
  git(linked, "reset", "--hard", second);
  assert.equal(refusalCode(cli(linked, ["init"])), "workspace_already_initialized");
});

scenario(EXPECTED_CASES[4], (t) => {
  const { base, linked } = topology(t);
  const seedPath = join(base, "seed-ledger.json");
  writeFileSync(seedPath, `${JSON.stringify(ledgerWithFlaggedRow(), null, 2)}\n`);

  const report = initialize(linked, ["--seed-ledger", seedPath]);
  assert.equal(report.seeded.entries, 1);
  assert.equal(report.seeded.batches, 1);
  assert.deepEqual(readLedger(join(linked, "triage-ledger.json")), ledgerWithFlaggedRow());

  // Seeding is a fresh-tree choice: over an existing ledger it is a wipe under another name.
  assert.equal(
    refusalCode(cli(linked, ["init", "--seed-ledger", seedPath])),
    "workspace_seed_refused",
  );

  rmSync(join(linked, "triage-ledger.json"));
  assert.equal(
    refusalCode(cli(linked, ["init", "--seed-ledger", "triage-ledger.json"])),
    "workspace_seed_invalid",
  );
  const corrupt = join(base, "corrupt.json");
  writeFileSync(corrupt, "not a ledger at all");
  assert.equal(
    refusalCode(cli(linked, ["init", "--seed-ledger", corrupt])),
    "workspace_seed_invalid",
  );
  assert.equal(
    refusalCode(cli(linked, ["init", "--seed-ledger", join(base, "absent.json")])),
    "workspace_seed_invalid",
  );
});

scenario(EXPECTED_CASES[5], (t) => {
  const { first, linked } = topology(t);
  initialize(linked);
  const report = ok(cli(linked, ["preflight"]));

  assert.equal(report.status, "ready");
  assert.equal(report.head, first);
  assert.equal(report.base.sha, first);
  assert.equal(report.locked, true);
  assert.equal(report.lock_reason, "unharvested: probe run");
  assert.deepEqual(report.state, { process_log: true, triage_ledger: true, output_root: true });
  assert.equal(report.review.state, "clear");
  assert.equal(report.workspace_root, realpathSync(linked));

  // The one exclusion the clean-tree check carries, in the tree shape that needs it: a base sha
  // whose .gitignore does not yet know the .rehearsal line, so the directory this tool wrote
  // shows up as untracked. Without the exclusion every command would refuse its own marker.
  const early = topology(t, { ignoreRehearsal: false, label: "early-base" });
  assert.match(git(early.linked, "status", "--porcelain").trim(), /^$/);
  initialize(early.linked);
  assert.match(git(early.linked, "status", "--porcelain"), /\?\? \.rehearsal\//);
  assert.equal(ok(cli(early.linked, ["preflight"])).status, "ready");
});

scenario(EXPECTED_CASES[6], (t) => {
  const { first, linked, second } = topology(t);

  // Before init there is no pin to check against, and that is a stop rather than a default.
  assert.equal(refusalCode(cli(linked, ["preflight"])), "workspace_base_missing");
  initialize(linked);

  writeFileSync(join(linked, ".rehearsal", "base.json"), JSON.stringify({ sha: "not-a-sha" }));
  assert.equal(refusalCode(cli(linked, ["preflight"])), "workspace_base_invalid");

  // A run measures the commit it names: HEAD moved under the pin is a refusal, not a repair.
  writeFileSync(join(linked, ".rehearsal", "base.json"), JSON.stringify({ sha: first }));
  git(linked, "reset", "--hard", second);
  assert.equal(refusalCode(cli(linked, ["preflight"])), "workspace_base_mismatch");

  writeFileSync(join(linked, ".rehearsal", "base.json"), JSON.stringify({ sha: second }));
  rmSync(join(linked, "triage-ledger.json"));
  assert.equal(refusalCode(cli(linked, ["preflight"])), "workspace_ledger_missing");

  // Source is not edited in a rehearsal tree, so a dirty checkout stops every subcommand.
  const reinitialized = ok(cli(linked, ["init"]));
  // A tracked file edited in place, which is what "source is not edited here" is actually about.
  // Without this the pathspec could be widened to exclude whole source directories and every
  // case would stay green, because untracked dirt is all they ever make.
  writeFileSync(join(linked, "tools", "bootstrap.mjs"), "// edited in a rehearsal tree\n");
  assert.equal(refusalCode(cli(linked, ["preflight"])), "workspace_tree_dirty");
  git(linked, "checkout", "--", join("tools", "bootstrap.mjs"));

  writeFileSync(join(linked, "edited.txt"), "an untracked source file\n");
  assert.equal(refusalCode(cli(linked, ["preflight"])), "workspace_tree_dirty");
  assert.equal(refusalCode(cli(linked, ["reset", "--dry-run"])), "workspace_tree_dirty");
  assert.equal(refusalCode(cli(linked, ["init"])), "workspace_tree_dirty");
  rmSync(join(linked, "edited.txt"));

  // The sandbox-off settings file a CV render needs is dirt here too, because this repository
  // deliberately does not ignore it (docs/runbooks/ops-cutover.md). The pathspec this tool
  // passes is the one the rehearsal preflight prints (docs/runbooks/rehearsal-worktree.md) and
  // nothing else, so the tool cannot decide otherwise on its own —
  // and the init report says so rather than leaving it to be discovered mid-run.
  mkdirSync(join(linked, ".claude"), { recursive: true });
  writeFileSync(join(linked, ".claude", "settings.local.json"), '{"sandbox":{"enabled":false}}');
  assert.equal(refusalCode(cli(linked, ["preflight"])), "workspace_tree_dirty");
  // Which is exactly what the init report warned about, before the operator got there.
  assert.match(reinitialized.notes.join(" "), /reads the tree as dirty/);
});

scenario(EXPECTED_CASES[7], (t) => {
  const { first, linked, second } = topology(t);
  initialize(linked);
  writeFileSync(join(linked, "pkcs11.txt"), "browser residue\n");

  const review = ok(cli(linked, ["reset", "--dry-run"]));
  assert.equal(review.status, "review_required");
  assert.match(review.confirmation_token, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    review.inventory.targets.map((target) => target.name),
    ["output", "pkcs11.txt", "process-log.json", "triage-ledger.json"],
  );
  assert.equal(
    review.confirmation_token,
    confirmationToken(
      { branch: review.branch, head: review.head, rootRealPath: review.workspace_root },
      review.inventory.tree_digest,
    ),
  );
  // The review phase is read-only, and omitting the token is the same phase.
  assert.equal(statSync(join(linked, "pkcs11.txt")).isFile(), true);
  assert.equal(ok(cli(linked, ["reset"])).status, "review_required");

  assert.equal(
    refusalCode(cli(linked, ["reset", "--confirmation-token", "0".repeat(64)])),
    "workspace_confirmation_mismatch",
  );
  // A token over bytes that have since changed is refused as well: the operator confirmed an
  // inventory that no longer exists.
  writeFileSync(join(linked, "pkcs11.txt"), "browser residue, rewritten\n");
  assert.equal(
    refusalCode(cli(linked, ["reset", "--confirmation-token", review.confirmation_token])),
    "workspace_confirmation_mismatch",
  );
  assert.equal(statSync(join(linked, "pkcs11.txt")).isFile(), true);

  // The token covers the repin as well as the inventory. A review that reported no repin must
  // not confirm a run that also moves HEAD, and a token issued for one commit must not confirm
  // a repin to another: both are actions the operator never saw in what they approved.
  const unmoved = git(linked, "rev-parse", "HEAD").trim();
  const plain = ok(cli(linked, ["reset", "--dry-run"]));
  assert.equal(plain.repin, null);
  assert.equal(
    refusalCode(cli(
      linked,
      ["reset", "--repin", second, "--confirmation-token", plain.confirmation_token],
    )),
    "workspace_confirmation_mismatch",
  );
  const forSecond = ok(cli(linked, ["reset", "--repin", second, "--dry-run"]));
  assert.equal(forSecond.repin.sha, second);
  assert.notEqual(forSecond.confirmation_token, plain.confirmation_token);
  assert.equal(
    refusalCode(cli(
      linked,
      ["reset", "--repin", first, "--confirmation-token", forSecond.confirmation_token],
    )),
    "workspace_confirmation_mismatch",
  );
  assert.equal(git(linked, "rev-parse", "HEAD").trim(), unmoved);
});

scenario(EXPECTED_CASES[8], (t) => {
  const { first, linked } = topology(t);
  initialize(linked);
  mkdirSync(join(linked, "output", "acme-sdet"), { recursive: true });
  writeFileSync(join(linked, "output", "acme-sdet", "cv.json"), "{}");
  mkdirSync(join(linked, ".pipeline-input"), { recursive: true });
  writeFileSync(join(linked, ".pipeline-input", `input-${"a".repeat(32)}.json`), "{}");
  mkdirSync(join(linked, ".playwright-mcp"), { recursive: true });
  writeFileSync(join(linked, ".playwright-mcp", "trace.txt"), "trace");
  writeFileSync(join(linked, "pkcs11.txt"), "browser residue");
  writeFileSync(join(linked, "process-log.backup-20260818.json"), "{}");
  writeFileSync(join(linked, "process-log.json.4242.9f.tmp"), "{}");
  mkdirSync(join(linked, ".rehearsal", "batches", "probe-1"), { recursive: true });
  writeFileSync(join(linked, ".rehearsal", "batches", "probe-1", "plan.json"), "evidence");

  const { confirmed } = resetWithReview(linked);
  assert.equal(confirmed.status, "reset");
  assert.deepEqual(confirmed.removed, [
    ".pipeline-input",
    ".playwright-mcp",
    "output",
    "pkcs11.txt",
    "process-log.backup-20260818.json",
    "process-log.json",
    "process-log.json.4242.9f.tmp",
    "triage-ledger.json",
  ]);

  // Append-only evidence and the pin are outside the wipe list on purpose.
  assert.equal(
    readFileSync(join(linked, ".rehearsal", "batches", "probe-1", "plan.json"), "utf8"),
    "evidence",
  );
  assert.equal(confirmed.base.sha, first);

  // What the next batch needs is back, because the wipe took it away in the first place.
  assert.equal(statSync(join(linked, "triage-ledger.json")).isFile(), true);
  assert.equal(statSync(join(linked, "process-log.json")).isFile(), true);
  assert.equal(statSync(join(linked, "output")).isDirectory(), true);
  assert.equal(confirmed.reinitialized.bootstrap.status, "ok");
  assert.equal(confirmed.reinitialized.triage_ledger.status, "ok");

  // Nothing tracked moved.
  assert.equal(git(linked, "status", "--porcelain").trim(), "");
  assert.equal(statSync(join(linked, "seed.txt")).isFile(), true);
});

scenario(EXPECTED_CASES[9], (t) => {
  const { first, linked, second } = topology(t);
  initialize(linked);
  writeFileSync(join(linked, "pkcs11.txt"), "browser residue");
  assert.notEqual(first, second);

  const { confirmed } = resetWithReview(linked, ["--repin", second]);
  assert.equal(confirmed.head, second);
  assert.equal(confirmed.base.sha, second);
  assert.equal(confirmed.repin.sha, second);
  assert.equal(git(linked, "rev-parse", "HEAD").trim(), second);
  assert.equal(statSync(join(linked, "second.txt")).isFile(), true);

  // The acceptance path: batch two plans over a ledger that no longer knows last batch's links,
  // which is the whole reason a verification loop wipes it instead of carrying it over.
  const plan = planBatch(
    readLedger(join(linked, "triage-ledger.json")),
    ["https://boards.greenhouse.io/acme/jobs/12345"],
    { asOf: "2026-08-24T10:00:00Z" },
  );
  assert.equal(plan.counts.fetch_new, 1);
  assert.equal(plan.counts.skip_known, 0);
  assert.equal(ok(cli(linked, ["preflight"])).head, second);

  // A repin never re-seeds, and never takes a symbolic revision.
  assert.equal(
    refusalCode(cli(linked, ["reset", "--repin", "HEAD~1", "--dry-run"])),
    "workspace_repin_invalid",
  );
  assert.equal(
    refusalCode(cli(linked, ["reset", "--repin", "deadbeef", "--dry-run"])),
    "workspace_repin_invalid",
  );
  // A branch may be named like an abbreviated object, and rev-parse resolves the ref happily.
  // An object name is a prefix of the sha it resolves to; this ref is not.
  // An abbreviation of the commit itself stays legitimate; only a ref that looks like one goes.
  const abbreviated = ok(cli(linked, ["reset", "--repin", second.slice(0, 12), "--dry-run"]));
  assert.equal(abbreviated.repin.sha, second);
  assert.equal(abbreviated.repin.requested, second.slice(0, 12));

  git(linked, "branch", "abcdef1", first);
  const named = cli(linked, ["reset", "--repin", "abcdef1", "--dry-run"]);
  assert.equal(refusalCode(named), "workspace_repin_invalid");
  assert.match(JSON.parse(named.stderr).error.message, /which it does not name/);
});

scenario(EXPECTED_CASES[10], (t) => {
  const { linked } = topology(t);
  initialize(linked);

  const ledgerLock = join(linked, "triage-ledger.json.lock");
  mkdirSync(ledgerLock);
  assert.equal(refusalCode(cli(linked, ["reset", "--dry-run"])), "workspace_ledger_locked");

  // Past the staleness window a bare lock directory is residue, but an owner record naming a
  // live pid still means a session is inside the transaction.
  const processLock = join(linked, "process-log.json.lock");
  mkdirSync(processLock);
  writeFileSync(
    join(processLock, `${"a".repeat(32)}.json`),
    JSON.stringify({
      lock_version: 1,
      pid: process.pid,
      owner_token: "a".repeat(32),
      acquired_at: "2026-08-24T10:00:00Z",
    }),
  );
  ageDirectory(processLock, LOCK_STALE_AFTER_MS * 4);
  ageDirectory(ledgerLock, LOCK_STALE_AFTER_MS * 4);
  assert.equal(refusalCode(cli(linked, ["reset", "--dry-run"])), "workspace_ledger_locked");

  // A file the size of a log is not an owner record and is not read as one, so the pid it
  // happens to carry decides nothing and the lock falls back to its age.
  writeFileSync(join(processLock, `${"b".repeat(32)}.json`), JSON.stringify({
    lock_version: 1,
    pid: process.pid,
    owner_token: "b".repeat(32),
    acquired_at: "2026-08-24T10:00:00Z",
    padding: "x".repeat(8192),
  }));
  rmSync(join(processLock, `${"a".repeat(32)}.json`));
  ageDirectory(processLock, LOCK_STALE_AFTER_MS * 4);
  const oversized = ok(cli(linked, ["reset", "--dry-run"]));
  const oversizedLock = oversized.inventory.targets
    .find((target) => target.name === "process-log.json.lock");
  assert.equal(oversizedLock.lock.live, false);
  assert.equal(oversizedLock.lock.pid, null);

  rmSync(processLock, { recursive: true });
  const review = ok(cli(linked, ["reset", "--dry-run"]));
  const listed = review.inventory.targets
    .find((target) => target.name === "triage-ledger.json.lock");
  assert.equal(listed.lock.live, false);
  assert.equal(listed.lock.reason, "stale");

  // Removed only as a named entry of the confirmed inventory, never on the way past.
  const confirmed = ok(cli(linked, ["reset", "--confirmation-token", review.confirmation_token]));
  assert.equal(confirmed.removed.includes("triage-ledger.json.lock"), true);
});

scenario(EXPECTED_CASES[11], (t) => {
  const { linked } = topology(t);
  initialize(linked);
  writeFileSync(
    join(linked, "triage-ledger.json"),
    `${JSON.stringify(ledgerWithFlaggedRow(), null, 2)}\n`,
  );

  const refused = cli(linked, ["reset", "--dry-run"]);
  assert.equal(refusalCode(refused), "workspace_review_required");
  // "something is flagged" is not a decision, so the refusal names the group that needs one.
  assert.match(JSON.parse(refused.stderr).error.message, /gap\.compensation/);

  const waived = ok(cli(linked, ["reset", "--dry-run", "--waive-review"]));
  assert.equal(waived.review.state, "unreviewed");
  assert.equal(waived.review.flagged_open, 1);
  assert.equal(waived.review.batches, 1);
  assert.deepEqual(waived.review.groups, [{ flag: "gap.compensation", count: 1 }]);
  assert.equal(waived.review.waived, true);

  // An unreadable ledger is an unknown review state, and unknown is not reviewed.
  writeFileSync(join(linked, "triage-ledger.json"), "{ not a ledger");
  assert.equal(refusalCode(cli(linked, ["reset", "--dry-run"])), "workspace_review_required");
  assert.equal(
    ok(cli(linked, ["reset", "--dry-run", "--waive-review"])).review.state,
    "unreadable",
  );

  // A ledger whose rows carry no flag needs no waiver: there is nothing waiting for a decision.
  const unflagged = ledgerWithFlaggedRow();
  unflagged.entries[0].flags = [];
  writeFileSync(join(linked, "triage-ledger.json"), `${JSON.stringify(unflagged, null, 2)}\n`);
  const clear = ok(cli(linked, ["reset", "--dry-run"]));
  assert.equal(clear.review.state, "clear");
  assert.equal(clear.status, "review_required");
});

scenario(EXPECTED_CASES[12], (t) => {
  const { linked } = topology(t);
  initialize(linked);
  writeFileSync(join(linked, "pkcs11.txt"), "browser residue");
  git(linked, "add", "-f", "pkcs11.txt");
  git(linked, "commit", "--quiet", "-m", "tracked residue");

  const refused = cli(linked, ["reset", "--dry-run"]);
  assert.equal(refusalCode(refused), "workspace_target_tracked");
  assert.match(JSON.parse(refused.stderr).error.message, /pkcs11\.txt/);
  assert.equal(statSync(join(linked, "pkcs11.txt")).isFile(), true);

  // The same closed failure for a tracked file inside a target directory: what the wipe would
  // remove is asked of the index, not assumed from the ignore file.
  git(linked, "rm", "--quiet", "--cached", "pkcs11.txt");
  git(linked, "commit", "--quiet", "-m", "untrack the residue");
  rmSync(join(linked, "pkcs11.txt"));
  writeFileSync(join(linked, "output", "leaked.json"), "{}");
  git(linked, "add", "-f", join("output", "leaked.json"));
  git(linked, "commit", "--quiet", "-m", "leaked output");
  assert.equal(refusalCode(cli(linked, ["reset", "--dry-run"])), "workspace_target_tracked");
});

scenario(EXPECTED_CASES[13], (t) => {
  const { linked } = topology(t);
  initialize(linked);

  symlinkSync(join(linked, "seed.txt"), join(linked, "pkcs11.txt"));
  const top = cli(linked, ["reset", "--dry-run"]);
  assert.equal(refusalCode(top), "workspace_inventory_unsafe");
  // The message, not only the code: the type check standing behind this branch refuses a link
  // too, with the same code, so a test that read the code alone could not tell them apart.
  assert.match(JSON.parse(top.stderr).error.message, /symbolic link/);
  rmSync(join(linked, "pkcs11.txt"));

  // Below the top level too: a link inside a wiped directory is exactly where one would hide.
  symlinkSync(join(linked, "seed.txt"), join(linked, "output", "linked.json"));
  const nested = cli(linked, ["reset", "--dry-run"]);
  assert.equal(refusalCode(nested), "workspace_inventory_unsafe");
  assert.match(JSON.parse(nested.stderr).error.message, /output\/linked\.json is a symbolic link/);
  rmSync(join(linked, "output", "linked.json"));

  // The walk is bounded in both directions, so a runaway tree is a refusal to inspect rather
  // than an open-ended walk. Depth first.
  let deep = join(linked, "output");
  for (let level = 0; level < 26; level += 1) deep = join(deep, `level-${level}`);
  mkdirSync(deep, { recursive: true });
  assert.equal(refusalCode(cli(linked, ["reset", "--dry-run"])), "workspace_inventory_unbounded");
  rmSync(join(linked, "output", "level-0"), { recursive: true });

  // Then breadth, which is the ceiling a wide output root would meet.
  for (let entry = 0; entry < 4100; entry += 1) {
    writeFileSync(join(linked, "output", `entry-${entry}.json`), "{}");
  }
  assert.equal(refusalCode(cli(linked, ["reset", "--dry-run"])), "workspace_inventory_unbounded");
  rmSync(join(linked, "output"), { recursive: true });

  // And breadth at the root of the wipe list, where the targets themselves are counted: a
  // ceiling that only guarded the walk would let this through.
  for (let entry = 0; entry < 4100; entry += 1) {
    writeFileSync(join(linked, `process-log.backup-${entry}.json`), "{}");
  }
  assert.equal(refusalCode(cli(linked, ["reset", "--dry-run"])), "workspace_inventory_unbounded");
});

scenario(EXPECTED_CASES[14], (t) => {
  const { base, linked, primary } = topology(t);
  initialize(linked);

  // Operational state of the kind the primary checkout really holds.
  writeFileSync(join(primary, "process-log.json"), '{"schemaVersion":4}');
  writeFileSync(
    join(primary, "triage-ledger.json"),
    JSON.stringify({ schema_version: 1, batches: [], entries: [] }),
  );
  mkdirSync(join(primary, "output", "acme-sdet"), { recursive: true });
  writeFileSync(join(primary, "output", "acme-sdet", "cv.json"), '{"real":true}');

  const elsewhere = join(base, "unrelated-clone");
  mkdirSync(elsewhere, { recursive: true });
  git(elsewhere, "init", "--quiet", ".");
  const outside = join(base, "not-a-repository");
  mkdirSync(outside, { recursive: true });

  // Which guard refused is pinned, not merely that something did: a case meant to prove the
  // linked-worktree rule must not be rescued by the branch rule standing behind it.
  const expected = [
    [primary, "workspace_not_linked"],
    [join(primary, "tools"), "workspace_root_mismatch"],
    [join(primary, "output"), "workspace_root_mismatch"],
    [elsewhere, "workspace_not_linked"],
    [outside, "workspace_git_failed"],
  ];
  for (const [cwd, code] of expected) {
    for (const args of [["preflight"], ["init"], ["reset", "--dry-run"],
      ["reset", "--confirmation-token", "0".repeat(64)]]) {
      assert.equal(refusalCode(cli(cwd, args)), code, `${cwd} ${args.join(" ")}`);
    }
  }

  // The strongest form of the same rule. Put the operational checkout on a branch whose name
  // this tool accepts, give it the pin and the ledger a rehearsal tree would have, and only the
  // linked-worktree guard is left standing between the tool and the real state.
  git(primary, "switch", "--quiet", "-c", "rehearsal/ops-probe");
  mkdirSync(join(primary, ".rehearsal"), { recursive: true });
  writeFileSync(
    join(primary, ".rehearsal", "base.json"),
    JSON.stringify({ sha: git(primary, "rev-parse", "HEAD").trim() }),
  );
  for (const args of [["preflight"], ["init"], ["reset", "--dry-run"]]) {
    assert.equal(refusalCode(cli(primary, args)), "workspace_not_linked", args.join(" "));
  }

  // Not even the legitimate tree's own confirmed reset reaches across.
  resetWithReview(linked);
  assert.equal(
    readFileSync(join(primary, "output", "acme-sdet", "cv.json"), "utf8"),
    '{"real":true}',
  );
  assert.equal(readFileSync(join(primary, "process-log.json"), "utf8"), '{"schemaVersion":4}');
  assert.equal(statSync(join(primary, "triage-ledger.json")).isFile(), true);
});

scenario(EXPECTED_CASES[15], (t) => {
  const { base, first, primary } = topology(t);

  const task = join(base, "pipeline-worktrees", "tasks", "042-probe");
  git(primary, "worktree", "add", "--quiet", "-b", "task/042-probe", task, first);
  assert.equal(refusalCode(cli(task, ["preflight"])), "workspace_branch_refused");
  assert.equal(refusalCode(cli(task, ["reset", "--dry-run"])), "workspace_branch_refused");
  assert.equal(refusalCode(cli(task, ["init"])), "workspace_branch_refused");

  const detached = join(base, "pipeline-worktrees", "rehearsal", "detached");
  git(primary, "worktree", "add", "--quiet", "--detach", detached, first);
  assert.equal(refusalCode(cli(detached, ["preflight"])), "workspace_head_detached");

  // The path says rehearsal; the branch does not, and the branch is what decides.
  const foreign = join(base, "pipeline-worktrees", "rehearsal", "Foreign_Label");
  git(primary, "worktree", "add", "--quiet", "-b", "rehearsal/Foreign_Label", foreign, first);
  assert.equal(refusalCode(cli(foreign, ["init"])), "workspace_branch_refused");
});

scenario(EXPECTED_CASES[16], (t) => {
  const { linked } = topology(t);
  initialize(linked);
  for (const name of ["JOB_PIPELINE_WORKSPACE_ROOT", "JOB_PIPELINE_TRIAGE_LEDGER",
    "JOB_PIPELINE_BROWSER_BIN"]) {
    const environment = cleanEnvironment({ [name]: "/somewhere/else" });
    for (const args of [["preflight"], ["init"], ["reset", "--dry-run"]]) {
      assert.equal(
        refusalCode(cli(linked, args, environment)),
        "workspace_ambient_environment",
        `${name} ${args.join(" ")}`,
      );
    }
  }
});

scenario(EXPECTED_CASES[17], (t) => {
  const { base, linked } = topology(t);
  initialize(linked);
  assert.equal(refusalCode(cli(join(linked, "tools"), ["preflight"])), "workspace_root_mismatch");
  assert.equal(
    refusalCode(cli(join(linked, "output"), ["reset", "--dry-run"])),
    "workspace_root_mismatch",
  );

  assert.throws(
    () => runWorkspaceReset(["preflight"], {
      cwd: join(base, "never-existed"),
      environment: {},
      spawn: () => assert.fail("no child may be spawned before the root is resolved"),
    }),
    (error) => error instanceof WorkspaceResetError
      && error.code === "workspace_root_unreadable",
  );
});

scenario(EXPECTED_CASES[18], (t) => {
  const { linked } = topology(t);
  initialize(linked);
  const refusals = [
    [["nuke"], "workspace_unknown_command"],
    [[], "workspace_unknown_command"],
    [["reset", "--dry-run", "--confirmation-token", "a".repeat(64)], "workspace_invalid_arguments"],
    [["reset", "--confirmation-token", "not-a-token"], "workspace_invalid_arguments"],
    [["reset", "--purpose", "wrong subcommand"], "workspace_invalid_arguments"],
    [["preflight", "--waive-review"], "workspace_invalid_arguments"],
    [["init", "--purpose"], "workspace_invalid_arguments"],
    [["init", "--purpose", "one", "--purpose", "two"], "workspace_invalid_arguments"],
    [["init", "positional"], "workspace_invalid_arguments"],
    // Assigned through the prototype setter on a plain object, this key would never become own
    // and the unknown-option check would never see it.
    [["reset", "--dry-run", "--__proto__", "smuggled"], "workspace_invalid_arguments"],
    [["reset", "--dry-run", "--constructor", "smuggled"], "workspace_invalid_arguments"],
  ];
  for (const [args, code] of refusals) {
    assert.equal(refusalCode(cli(linked, args)), code, args.join(" "));
  }
  const helped = cli(linked, ["help"]);
  assert.equal(helped.status, 0);
  assert.match(helped.stdout, /Usage:/);
  assert.match(helped.stdout, /current working directory/);
});

scenario(EXPECTED_CASES[19], (t) => {
  const { linked } = topology(t);
  const calls = [];
  const recording = (command, args, options) => {
    calls.push({ args, command, options });
    return spawnSync(command, args, options);
  };
  // Two ambient variables that would change what a child does if they reached it.
  const environment = cleanEnvironment({
    GIT_DIR: "/elsewhere/.git",
    NODE_OPTIONS: "--test-only",
  });

  const report = runWorkspaceReset(["init", "--purpose", "argv pin"], {
    cwd: linked,
    environment,
    spawn: recording,
  });
  assert.equal(report.status, "initialized");

  // The creation half runs the tree's own copies, from the tree's own root. Which copy runs
  // decides which checkout gets a process-log.json, so the paths are frozen, not the names.
  const nodeCalls = calls.filter((call) => call.command === process.execPath);
  assert.deepEqual(nodeCalls.map((call) => call.args), [
    [join(linked, "tools", "bootstrap.mjs"), "--init"],
    [join(linked, "tools", "triage-ledger.mjs"), "init"],
  ]);
  for (const call of nodeCalls) assert.equal(call.options.cwd, linked);

  const lockCall = calls.find((call) => call.args[0] === "worktree" && call.args[1] === "lock");
  assert.deepEqual(
    lockCall.args,
    ["worktree", "lock", "--reason", "unharvested: argv pin", linked],
  );

  // No shell anywhere, and the scrub reaches every child rather than the node ones only.
  for (const call of calls) {
    assert.equal(call.options.shell, false, call.args.join(" "));
    assert.equal(call.options.env.GIT_DIR, undefined, call.args.join(" "));
    assert.equal(call.options.env.NODE_OPTIONS, undefined, call.args.join(" "));
    assert.equal(typeof call.options.env.PATH, "string");
  }
});

scenario(EXPECTED_CASES[20], (t) => {
  const { linked } = topology(t);
  initialize(linked);
  const environment = cleanEnvironment();

  assert.throws(
    () => runWorkspaceReset(["preflight"], {
      cwd: linked,
      environment,
      spawn: () => ({ error: { code: "ENOENT" }, status: null, stderr: "", stdout: "" }),
    }),
    (error) => error.code === "workspace_git_unavailable",
  );

  // A creation command that fails is reported rather than swallowed into a green init.
  const failingBootstrap = (command, args, options) => {
    if (String(args[0]).endsWith("bootstrap.mjs")) {
      return { status: 1, stderr: "bootstrap refused", stdout: "" };
    }
    return spawnSync(command, args, options);
  };
  assert.throws(
    () => runWorkspaceReset(["init"], { cwd: linked, environment, spawn: failingBootstrap }),
    (error) => error.code === "workspace_child_failed",
  );

  // The confirming phase inventories a second time. A tree that changes in between is refused
  // with nothing removed, even though the token still matched the first inventory.
  const review = ok(cli(linked, ["reset", "--dry-run"]));
  const drifting = (command, args, options) => {
    if (args[0] === "ls-files") writeFileSync(join(linked, "pkcs11.txt"), "written mid-run");
    return spawnSync(command, args, options);
  };
  assert.throws(
    () => runWorkspaceReset(
      ["reset", "--confirmation-token", review.confirmation_token],
      { cwd: linked, environment, spawn: drifting },
    ),
    (error) => error.code === "workspace_inventory_changed",
  );
  assert.equal(statSync(join(linked, "process-log.json")).isFile(), true);
  assert.equal(statSync(join(linked, "triage-ledger.json")).isFile(), true);
});

scenario(EXPECTED_CASES[21], (t) => {
  const { base, linked, second } = topology(t);
  initialize(linked);

  // A repin git reported as done but that did not move HEAD is not believed.
  const swallowedReset = (command, args, options) => {
    if (args[0] === "reset" && args[1] === "--hard") return { status: 0, stderr: "", stdout: "" };
    return spawnSync(command, args, options);
  };
  const review = ok(cli(linked, ["reset", "--repin", second, "--dry-run"]));
  assert.throws(
    () => runWorkspaceReset(
      ["reset", "--repin", second, "--confirmation-token", review.confirmation_token],
      { cwd: linked, environment: cleanEnvironment(), spawn: swallowedReset },
    ),
    (error) => error.code === "workspace_repin_failed",
  );

  // A worktree moved without `git worktree repair` still answers git, but the repository's
  // registration names a path that no longer exists. Nothing is reset in a tree git cannot name.
  const moved = join(base, "pipeline-worktrees", "rehearsal", "moved");
  renameSync(linked, moved);
  assert.equal(refusalCode(cli(moved, ["preflight"])), "workspace_not_linked");
  assert.equal(refusalCode(cli(moved, ["reset", "--dry-run"])), "workspace_not_linked");
  assert.equal(refusalCode(cli(moved, ["init"])), "workspace_not_linked");
});

// The declared set is a claim about coverage; this compares it with what actually ran.
test("every declared case ran", () => {
  assert.deepEqual(executed, EXPECTED_CASES);
  assert.equal(executed.length, EXPECTED_CASE_COUNT);
});
