#!/usr/bin/env node

/**
 * Clean-slate lifecycle of a rehearsal worktree: `init`, `preflight`, `reset`.
 *
 * A rehearsal worktree is the linked, throwaway checkout where a run against real vacancy URLs
 * happens without being production — its role, preflight and deletion policy live in
 * `docs/runbooks/rehearsal-worktree.md`, which stays the authority on every rule this file
 * mechanizes. Everything such a run produces is ignored by
 * Git, so the object database holds none of it and a hand-run `rm` is the only alternative to
 * this tool. That is what it replaces: the wipe becomes a reviewed mechanism with a fixed list.
 *
 * **The operational checkout is refused by construction, not by comparing paths.** Three
 * properties do it together, and none of them is a blocklist:
 *
 * - the tool operates on its own current working directory and offers no flag to point it
 *   somewhere else, so "which tree" is never a value anybody types;
 * - that directory must be the repository root of a LINKED worktree — its git directory has to
 *   sit under `<git-common-dir>/worktrees/`. The primary worktree, the one that owns the real
 *   `process-log.json` and `output/`, fails this check under every name and on every branch,
 *   because its git directory *is* the common directory;
 * - the branch must be `rehearsal/<label>`, and `<label>` must satisfy the `--batch`
 *   alphabet of `tools/vacancy-fetch/batch.mjs` (imported here rather than copied). `ops/current`
 *   and every `task/*` branch are refused by the same check.
 *
 * Two smaller guards close the remaining ways a wipe could hit something it must not:
 *
 * - **Everything deleted must be untracked.** The list is asked of `git ls-files`, not assumed
 *   from `.gitignore`, so a drifted ignore file that let `output/` into the index turns the reset
 *   into a refusal instead of a data loss.
 * - **A live lock stops the run.** A ledger lock whose owner pid is alive, or that is younger
 *   than the staleness window the ledger writers use, means a session is mid-transaction. Dead
 *   residue is different: it is named in the reviewed inventory and removed only by the confirmed
 *   phase, never silently — this tool takes no lock of its own and steals none.
 *
 * Every child process is spawned without a shell, with an argv array, and with the environment
 * scrubbed by the one owner of that policy (`tools/ci.mjs`): no value assembled here reaches a
 * shell, and no ambient variable reaches a child.
 *
 * The tree label is not the batch label. `<label>` names the tree and outlives every batch in it;
 * each batch takes its own `<batch-label>` for `--batch`, the ledger `batch_id` and its
 * output directory (`docs/runbooks/rehearsal-worktree.md`). No subcommand here derives a batch
 * id or an output directory name from the branch.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { childEnvironment } from "./ci.mjs";
import { batchLabelPattern } from "./vacancy-fetch/batch.mjs";
import { TriageLedgerError, readLedger, reviewLedger } from "./lib/triage-ledger-core.mjs";

/**
 * Part of the confirmation preimage. It moves when that preimage changes shape for a tool that
 * is already in use, so a token minted by the older shape stops matching instead of confirming
 * something it does not describe.
 */
export const WORKSPACE_RESET_VERSION = 1;

export const REHEARSAL_BRANCH_PREFIX = "rehearsal/";

/**
 * Mirrors the `staleAfterMs` default of `tools/lib/process-log-core.mjs`. Frozen as a literal
 * rather than imported, because that value is a lock-acquisition timeout parameter there, not an
 * exported policy; if the two ever diverge, this tool is the conservative side — it only ever
 * refuses to act.
 */
export const LOCK_STALE_AFTER_MS = 30_000;

export const MAX_INVENTORY_ENTRIES = 4096;
export const MAX_INVENTORY_DEPTH = 24;
export const MAX_INVENTORY_BYTES = 256 * 1024 * 1024;
const MAX_PURPOSE_BYTES = 200;
const MAX_CHILD_OUTPUT = 2048;
/** An owner record is one small JSON document; anything larger is not one and is not read. */
export const MAX_LOCK_OWNER_BYTES = 4096;
const CONFIRMATION_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** `git ls-files -z` separator, built rather than written, so this file carries no raw NUL. */
const NUL = String.fromCharCode(0);

/**
 * The wipe list, fixed and complete. Nothing outside it is ever removed, and the list is a
 * literal rather than a pattern over the ignore file: `.gitignore` is a statement about what Git
 * shows, not a licence to delete.
 *
 * `.rehearsal/` is deliberately absent. `.rehearsal/batches/` is append-only evidence of runs
 * that already happened (`docs/runbooks/rehearsal-worktree.md`), and `base.json` is rewritten
 * by `init` and `reset --repin`, never deleted.
 *
 * The last two entries are browser residue rather than pipeline state; they are here because a
 * counter-run through the in-app browser writes them, and leaving them would carry one batch's
 * browser state into the next.
 */
export const WIPE_RULES = Object.freeze([
  Object.freeze({ id: "process-log", match: (name) => name === "process-log.json" }),
  Object.freeze({ id: "process-log-lock", match: (name) => name === "process-log.json.lock" }),
  Object.freeze({
    id: "process-log-lock-residue",
    match: (name) => name.startsWith("process-log.json.lock."),
  }),
  Object.freeze({
    id: "process-log-tmp",
    match: (name) => name.startsWith("process-log.json.") && name.endsWith(".tmp"),
  }),
  Object.freeze({
    id: "process-log-backup",
    match: (name) => name.startsWith("process-log.backup-") && name.endsWith(".json"),
  }),
  Object.freeze({ id: "triage-ledger", match: (name) => name === "triage-ledger.json" }),
  Object.freeze({ id: "triage-ledger-lock", match: (name) => name === "triage-ledger.json.lock" }),
  Object.freeze({
    id: "triage-ledger-tmp",
    match: (name) => name.startsWith("triage-ledger.json.") && name.endsWith(".tmp"),
  }),
  Object.freeze({ id: "output", match: (name) => name === "output" }),
  Object.freeze({ id: "pipeline-input", match: (name) => name === ".pipeline-input" }),
  Object.freeze({ id: "playwright", match: (name) => name === ".playwright-mcp" }),
  Object.freeze({ id: "pkcs11", match: (name) => name === "pkcs11.txt" }),
]);

/** Every rule whose match is a lock or its crash residue, and therefore needs a liveness answer. */
const LOCK_RULE_IDS = Object.freeze([
  "process-log-lock",
  "process-log-lock-residue",
  "triage-ledger-lock",
]);

const BOOLEAN_FLAGS = Object.freeze(["dry-run", "waive-review"]);

export class WorkspaceResetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkspaceResetError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkspaceResetError(code, message);
}

function usage() {
  return `Usage:
  node tools/workspace-reset.mjs preflight
  node tools/workspace-reset.mjs init [--purpose <text>] [--seed-ledger <absolute path>]
  node tools/workspace-reset.mjs reset [--repin <sha>] [--waive-review]
                                       [--dry-run | --confirmation-token <sha256>]

Operates on the current working directory and takes no path argument: the tree it resets is the
tree you are standing in. It must be the root of a linked worktree on a rehearsal/<label> branch,
so the operational (primary) checkout cannot be reached from any invocation.

reset is two-phase. Without --confirmation-token it changes nothing and prints the exact
inventory plus a token over (root realpath, branch, HEAD, tree digest); --dry-run is the explicit
spelling of that same review phase. The confirming run re-inventories and refuses on any drift.

Wiped, and nothing else: process-log.json with its lock, lock residue and .tmp files,
process-log.backup-*.json, triage-ledger.json with its lock and .tmp files, output/,
.pipeline-input/, .playwright-mcp/ and pkcs11.txt. .rehearsal/batches/ is append-only evidence and
is never touched; .rehearsal/base.json is rewritten, never deleted.

The procedure these commands mechanize is docs/runbooks/rehearsal-worktree.md,
which stays the authority.`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  // Null-prototype: on a plain object `--__proto__ x` assigns through the inherited setter, so
  // the key never becomes own and the unknown-option check below never sees it.
  const options = Object.create(null);
  for (let index = 0; index < rest.length;) {
    const flag = rest[index];
    if (!flag?.startsWith("--")) {
      fail("workspace_invalid_arguments", `Invalid argument near ${flag ?? "<end>"}`);
    }
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) {
      fail("workspace_invalid_arguments", `Duplicate option: --${key}`);
    }
    if (BOOLEAN_FLAGS.includes(key)) {
      options[key] = true;
      index += 1;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("workspace_invalid_arguments", `Missing value for --${key}`);
    }
    options[key] = value;
    index += 2;
  }
  return { command, options };
}

function assertAllowed(options, allowed) {
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    fail(
      "workspace_invalid_arguments",
      `Unknown option(s): ${unknown.map((key) => `--${key}`).join(", ")}`,
    );
  }
}

/** Written as a code-point test rather than a character class, so no raw control byte is here. */
function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function boundedText(value, label, limit = MAX_PURPOSE_BYTES) {
  if (typeof value !== "string" || value.length === 0) {
    fail("workspace_invalid_arguments", `${label} must be a non-empty string.`);
  }
  if (Buffer.byteLength(value, "utf8") > limit) {
    fail("workspace_invalid_arguments", `${label} exceeds ${limit} bytes.`);
  }
  if (hasControlCharacter(value)) {
    fail("workspace_invalid_arguments", `${label} carries a control character.`);
  }
  return value;
}

function tail(text) {
  const value = String(text ?? "").trim();
  return value.length > MAX_CHILD_OUTPUT ? `...${value.slice(-MAX_CHILD_OUTPUT)}` : value;
}

/**
 * The tree label of a rehearsal branch, or null for every other branch.
 *
 * The alphabet is the `--batch` validator's, imported from its owner. the pre-switch branch and worktree procedure of the
 * runbook binds the two on purpose: a tree's first batch usually reuses the tree name, so a dot,
 * an underscore or a capital in the branch would be rejected by the fetch layer with
 * `batch_invalid` before the first request — a failure the operator would meet hours later.
 */
export function rehearsalTreeLabel(branch) {
  if (typeof branch !== "string" || !branch.startsWith(REHEARSAL_BRANCH_PREFIX)) return null;
  const label = branch.slice(REHEARSAL_BRANCH_PREFIX.length);
  return batchLabelPattern.test(label) ? label : null;
}

function runGit(context, args, { allowFailure = false } = {}) {
  const result = context.spawn("git", args, {
    cwd: context.cwd,
    encoding: "utf8",
    env: context.childEnv,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (result.error) {
    fail("workspace_git_unavailable", `git could not run (${result.error.code ?? "unknown"}).`);
  }
  if (result.status !== 0) {
    if (allowFailure) return { ok: false, stdout: "", stderr: tail(result.stderr) };
    fail(
      "workspace_git_failed",
      `git ${args[0]} failed with status ${result.status}: ${tail(result.stderr)}`,
    );
  }
  return { ok: true, stdout: String(result.stdout ?? ""), stderr: tail(result.stderr) };
}

function gitLine(context, args) {
  return runGit(context, args).stdout.trim();
}

function realPathOf(path, code, label) {
  try {
    return realpathSync(path);
  } catch (error) {
    return fail(code, `${label} could not be resolved (${error?.code ?? "unknown error"}).`);
  }
}

/**
 * Every structural guard, in one place and in a fixed order, so that no subcommand can be reached
 * without them and no subcommand can reorder them into a hole.
 */
function resolveWorkspace(context) {
  for (const key of Object.keys(context.environment)) {
    if (key.startsWith("JOB_PIPELINE_")) {
      fail(
        "workspace_ambient_environment",
        `${key} is set. A rehearsal session runs with no JOB_PIPELINE_* variable: an ambient one `
          + "would silently redirect the run to another workspace, ledger or output root.",
      );
    }
  }

  const cwdRealPath = realPathOf(context.cwd, "workspace_root_unreadable", "the working directory");
  const toplevel = gitLine(context, ["rev-parse", "--show-toplevel"]);
  const rootRealPath = realPathOf(toplevel, "workspace_root_unreadable", "the repository root");
  if (cwdRealPath !== rootRealPath) {
    fail(
      "workspace_root_mismatch",
      `The working directory ${cwdRealPath} is not the repository root ${rootRealPath}.`,
    );
  }

  const gitDir = realPathOf(
    gitLine(context, ["rev-parse", "--absolute-git-dir"]),
    "workspace_root_unreadable",
    "the git directory",
  );
  const commonDir = realPathOf(
    resolve(toplevel, gitLine(context, ["rev-parse", "--git-common-dir"])),
    "workspace_root_unreadable",
    "the git common directory",
  );
  const linkedRoot = join(commonDir, "worktrees");
  if (gitDir === commonDir || resolve(gitDir, "..") !== linkedRoot) {
    fail(
      "workspace_not_linked",
      `${rootRealPath} is not a linked worktree: its git directory ${gitDir} does not live under `
        + `${linkedRoot}. The operational checkout is refused here by construction.`,
    );
  }

  const branch = gitLine(context, ["branch", "--show-current"]);
  if (branch === "") {
    fail(
      "workspace_head_detached",
      "HEAD is detached. A rehearsal tree carries the branch that names it.",
    );
  }
  const label = rehearsalTreeLabel(branch);
  if (label === null) {
    fail(
      "workspace_branch_refused",
      `Branch ${branch} is not a rehearsal tree. Expected ${REHEARSAL_BRANCH_PREFIX}<label> with `
        + "<label> in the --batch alphabet: lower-case letters, digits and hyphens, not "
        + "starting with a hyphen, at most 64 characters.",
    );
  }

  const head = gitLine(context, ["rev-parse", "HEAD"]);
  const worktree = worktreeEntry(context, rootRealPath);
  return { branch, commonDir, gitDir, head, label, root: toplevel, rootRealPath, worktree };
}

/** The tree's own row of `git worktree list --porcelain`, matched by realpath, never by name. */
function worktreeEntry(context, rootRealPath) {
  const records = runGit(context, ["worktree", "list", "--porcelain"]).stdout.split("\n\n");
  for (const record of records) {
    const lines = record.split("\n").filter((line) => line.length > 0);
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (path === undefined) continue;
    let resolved;
    try {
      resolved = realpathSync(path);
    } catch {
      continue;
    }
    if (resolved !== rootRealPath) continue;
    const lockLine = lines.find((line) => line === "locked" || line.startsWith("locked "));
    return {
      locked: lockLine !== undefined,
      lockReason: lockLine === undefined || lockLine === "locked"
        ? null
        : lockLine.slice("locked ".length),
      registeredPath: path,
    };
  }
  return fail(
    "workspace_not_linked",
    `${rootRealPath} is not registered as a worktree of this repository.`,
  );
}

/**
 * Tracked modifications and untracked-not-ignored files, with `.rehearsal/` excluded — it may
 * predate the ignore line at the pinned sha (the rehearsal preflight). That one exclusion, and
 * no other: the pathspec here is exactly the one `docs/runbooks/rehearsal-worktree.md` prints,
 * and what counts as a dirty rehearsal tree is that runbook's rule, not this tool's.
 *
 * A consequence worth knowing rather than hiding: the sandbox-off `.claude/settings.local.json`
 * a CV render needs is deliberately not ignored by this repository
 * (`docs/runbooks/ops-cutover.md` keeps it visible so a cutover has to name it), so a tree
 * carrying one reads as dirty here. The init report says so; changing that is a runbook
 * decision, not a flag.
 */
function dirtyPaths(context) {
  const output = runGit(context, ["status", "--porcelain", "--", ":(exclude).rehearsal"]).stdout;
  return output.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

function assertCleanTree(context) {
  const dirty = dirtyPaths(context);
  if (dirty.length > 0) {
    const listed = `${dirty.slice(0, 10).join("; ")}${dirty.length > 10 ? " ..." : ""}`;
    fail(
      "workspace_tree_dirty",
      `The checkout is not clean: ${listed}. Source is not edited in a rehearsal tree `
        + "(docs/runbooks/rehearsal-worktree.md).",
    );
  }
}

function statIdentity(stats) {
  return {
    ctime_ns: stats.ctimeNs.toString(),
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    mode: stats.mode.toString(),
    mtime_ns: stats.mtimeNs.toString(),
    nlink: stats.nlink.toString(),
    size: stats.size.toString(),
  };
}

function lstatBig(path, { allowMissing = false } = {}) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    return fail(
      "workspace_inventory_unsafe",
      `${path} could not be inspected (${error?.code ?? "unknown error"}).`,
    );
  }
}

/**
 * Liveness of a lock or of its crash residue.
 *
 * Two signals, and the answer is "live" if either says so. The process log writes an owner record
 * carrying a pid into its lock directory, so that pid can be asked directly; the ledger lock is a
 * bare directory with no owner record at all, so only its age can be. Residue names carry the pid
 * of the session that created them. Anything younger than the staleness window counts as live
 * whatever the pid says.
 *
 * The window is the process log's: `tools/lib/process-log-core.mjs` waits that long before it
 * treats a lock as abandoned. The ledger writer has no such notion — it retries for about a
 * second and then fails loudly — so for a bare ledger lock this is this tool's own rule, not a
 * mirror of anybody's. A ledger transaction that somehow held its lock for longer than the
 * window would be read here as residue, which is why the inventory names every lock it found
 * and the operator confirms the list before anything is removed.
 */
function lockLiveness(path, name, stats, now) {
  const ageMs = now - Number(stats.mtimeNs / 1_000_000n);
  if (ageMs <= LOCK_STALE_AFTER_MS) {
    return { live: true, reason: "recent", age_ms: ageMs, pid: null };
  }
  const pid = lockOwnerPid(path, name, stats);
  if (pid !== null && processIsAlive(pid)) {
    return { live: true, reason: "owner_alive", age_ms: ageMs, pid };
  }
  return { live: false, reason: "stale", age_ms: ageMs, pid };
}

function lockOwnerPid(path, name, stats) {
  const fromName = /[.-](?:candidate|claim)-(\d{1,10})-[0-9a-f]{32}$/.exec(name);
  if (fromName) return Number(fromName[1]);
  if (!stats.isDirectory()) return null;
  let entries;
  try {
    entries = readdirSync(path).sort();
  } catch {
    return null;
  }
  for (const entry of entries.slice(0, 8)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const ownerPath = join(path, entry);
      if (Number(lstatSync(ownerPath, { bigint: true }).size) > MAX_LOCK_OWNER_BYTES) continue;
      const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) return owner.pid;
    } catch {
      continue;
    }
  }
  return null;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to somebody else; only ESRCH proves it is gone.
    return error?.code === "EPERM";
  }
}

/**
 * The wipe inventory: every present target, walked, with a stat identity per entry.
 *
 * The identity is what makes the two phases safe. The digest over it is the "nothing moved
 * between review and confirmation" proof, and it is deliberately sensitive: a rewritten file with
 * identical bytes still changes its inode timestamps, so the confirming run refuses rather than
 * deleting something the operator never saw.
 *
 * A hard-linked file is recorded, not refused. The lock recovery path of the process log creates
 * exactly that — `...lock.claim-<pid>-<token>` is a second link to the lock file — so refusing
 * multiply-linked files would refuse the crash residue this list exists to clear.
 */
function inventory(context, workspace, now) {
  const names = readdirSync(workspace.root, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();
  const targets = [];
  const digestEntries = [];
  let totalBytes = 0;
  let entryCount = 0;

  for (const name of names) {
    const rule = WIPE_RULES.find((candidate) => candidate.match(name));
    if (rule === undefined) continue;
    const path = join(workspace.root, name);
    const stats = lstatBig(path);
    if (stats.isSymbolicLink()) {
      fail("workspace_inventory_unsafe", `${name} is a symbolic link; refusing to remove it.`);
    }
    if (!stats.isDirectory() && !stats.isFile()) {
      fail("workspace_inventory_unsafe", `${name} is neither a regular file nor a directory.`);
    }
    const resolved = realPathOf(path, "workspace_inventory_unsafe", name);
    if (resolved !== join(workspace.rootRealPath, name)) {
      fail("workspace_inventory_unsafe", `${name} resolves outside the workspace root.`);
    }

    const target = {
      name,
      rule: rule.id,
      type: stats.isDirectory() ? "directory" : "file",
      entry_count: 0,
      total_bytes: stats.isDirectory() ? 0 : Number(stats.size),
    };
    if (LOCK_RULE_IDS.includes(rule.id)) {
      target.lock = lockLiveness(path, name, stats, now);
    }
    if (entryCount >= MAX_INVENTORY_ENTRIES) {
      fail(
        "workspace_inventory_unbounded",
        `The inventory exceeds ${MAX_INVENTORY_ENTRIES} entries. Inspect the tree by hand.`,
      );
    }
    digestEntries.push({ path: name, type: target.type, ...statIdentity(stats) });
    entryCount += 1;
    totalBytes += target.total_bytes;
    if (totalBytes > MAX_INVENTORY_BYTES) {
      fail(
        "workspace_inventory_unbounded",
        `The inventory exceeds ${MAX_INVENTORY_BYTES} bytes. Inspect the tree by hand.`,
      );
    }

    if (stats.isDirectory()) {
      const walked = walk(path, name, 1, digestEntries, entryCount, totalBytes);
      target.entry_count = walked.entryCount - entryCount;
      target.total_bytes = walked.totalBytes - totalBytes;
      entryCount = walked.entryCount;
      totalBytes = walked.totalBytes;
    }
    targets.push(target);
  }

  const treeDigest = createHash("sha256").update(JSON.stringify(digestEntries)).digest("hex");
  return { entry_count: entryCount, targets, total_bytes: totalBytes, tree_digest: treeDigest };
}

function walk(directoryPath, relativeDirectory, depth, digestEntries, entryCount, totalBytes) {
  if (depth > MAX_INVENTORY_DEPTH) {
    fail("workspace_inventory_unbounded", `The inventory exceeds depth ${MAX_INVENTORY_DEPTH}.`);
  }
  let entries;
  try {
    entries = readdirSync(directoryPath, { withFileTypes: true });
  } catch (error) {
    return fail(
      "workspace_inventory_unsafe",
      `${relativeDirectory} could not be read (${error?.code ?? "unknown error"}).`,
    );
  }
  let count = entryCount;
  let bytes = totalBytes;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (count >= MAX_INVENTORY_ENTRIES) {
      fail(
        "workspace_inventory_unbounded",
        `The inventory exceeds ${MAX_INVENTORY_ENTRIES} entries. Inspect the tree by hand.`,
      );
    }
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const absolutePath = join(directoryPath, entry.name);
    const stats = lstatBig(absolutePath);
    if (stats.isSymbolicLink()) {
      fail("workspace_inventory_unsafe", `${relativePath} is a symbolic link.`);
    }
    if (!stats.isDirectory() && !stats.isFile()) {
      fail(
        "workspace_inventory_unsafe",
        `${relativePath} is neither a regular file nor a directory.`,
      );
    }
    count += 1;
    if (stats.isFile()) {
      bytes += Number(stats.size);
      if (bytes > MAX_INVENTORY_BYTES) {
        fail(
          "workspace_inventory_unbounded",
          `The inventory exceeds ${MAX_INVENTORY_BYTES} bytes. Inspect the tree by hand.`,
        );
      }
    }
    digestEntries.push({
      path: relativePath,
      type: stats.isDirectory() ? "directory" : "file",
      ...statIdentity(stats),
    });
    if (stats.isDirectory()) {
      const walked = walk(absolutePath, relativePath, depth + 1, digestEntries, count, bytes);
      count = walked.entryCount;
      bytes = walked.totalBytes;
    }
  }
  return { entryCount: count, totalBytes: bytes };
}

/**
 * Fails closed when the ignore file drifted. `git ls-files` is asked which of these names the
 * index knows; `--error-unmatch` would answer the same question one path at a time and through an
 * exit code, which is harder to report and easy to read backwards.
 */
function assertUntracked(context, targets) {
  if (targets.length === 0) return;
  const tracked = runGit(context, [
    "ls-files",
    "-z",
    "--cached",
    "--",
    ...targets.map((target) => target.name),
  ]).stdout.split(NUL).filter((entry) => entry.length > 0);
  if (tracked.length > 0) {
    const listed = `${tracked.slice(0, 5).join(", ")}${tracked.length > 5 ? " ..." : ""}`;
    fail(
      "workspace_target_tracked",
      `Git tracks ${listed}. Nothing tracked is ever removed here: fix the ignore rules or the `
        + "index first.",
    );
  }
}

function assertNoLiveLock(targets) {
  const live = targets.filter((target) => target.lock?.live);
  if (live.length > 0) {
    const names = live.map((target) => `${target.name} (${target.lock.reason})`).join(", ");
    fail(
      "workspace_ledger_locked",
      `A live lock is present: ${names}. A session is mid-transaction, or one has just finished. `
        + "No live lock is ever removed here; a dead one is removed only as a named entry of a "
        + "reviewed inventory. Wait, then look at the lock by hand.",
    );
  }
}

/**
 * The confirmation token: sha-256 over the identity of the tree, of what is about to be removed,
 * and of the commit the run would re-pin to. The repin belongs in the preimage because it is an
 * action the review phase reports and the confirming phase performs: without it a token issued
 * for a plain wipe would confirm a run that also moves HEAD.
 *
 * Exported so a test can freeze one value from fixed inputs — a preimage that quietly loses a
 * field would otherwise still produce a token that round-trips with itself.
 */
export function confirmationToken({ branch, head, repin = null, rootRealPath }, treeDigest) {
  const preimage = {
    branch,
    head,
    repin,
    root_identity: rootRealPath,
    tool: "workspace-reset",
    tree_digest: treeDigest,
    version: WORKSPACE_RESET_VERSION,
  };
  return createHash("sha256").update(JSON.stringify(preimage)).digest("hex");
}

const BASE_RELATIVE_PATH = ".rehearsal/base.json";

function basePath(workspace) {
  return join(workspace.root, ".rehearsal", "base.json");
}

function readBase(workspace, { allowMissing = false } = {}) {
  let bytes;
  try {
    bytes = readFileSync(basePath(workspace), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" && allowMissing) return null;
    fail(
      "workspace_base_missing",
      `${BASE_RELATIVE_PATH} could not be read (${error?.code ?? "unknown error"}). A rehearsal `
        + 'tree is created with "workspace-reset init".',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    fail("workspace_base_invalid", `${BASE_RELATIVE_PATH} is not valid JSON.`);
  }
  if (
    parsed === null
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || !FULL_SHA_PATTERN.test(parsed.sha ?? "")
  ) {
    fail(
      "workspace_base_invalid",
      `${BASE_RELATIVE_PATH} must be an object carrying a 40-character sha.`,
    );
  }
  return parsed;
}

/**
 * `sha` is the one field the runbook requires; a tree may record anything else about itself, so
 * unknown keys are carried through a rewrite untouched rather than dropped or refused.
 */
function writeBase(workspace, base) {
  const { sha, created_at: createdAt, purpose, ...rest } = base;
  const document = { sha, created_at: createdAt, purpose, ...rest };
  mkdirSync(join(workspace.root, ".rehearsal"), { recursive: true });
  writeFileSync(basePath(workspace), `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return document;
}

function isoInstant(milliseconds) {
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * What a reset would destroy that nobody has looked at yet.
 *
 * The ledger stores observations, never approvals, so there is no "reviewed" bit to read: a
 * flagged open row is by definition a decision still waiting for its consumer
 * (`docs/runbooks/triage-review.md`). An unreadable ledger is treated the same way, because an
 * unknown review state is not a reviewed one. Either way the operator can override with
 * --waive-review, which is the point: this refuses to be silent, not to be overruled.
 */
function reviewState(workspace, now) {
  const path = join(workspace.root, "triage-ledger.json");
  if (!existsSync(path)) return { state: "absent", batches: 0, flagged_open: 0, groups: [] };
  let ledger;
  try {
    ledger = readLedger(path);
  } catch (error) {
    return {
      state: "unreadable",
      batches: 0,
      flagged_open: 0,
      groups: [],
      detail: error instanceof TriageLedgerError ? error.code : "triage_ledger_unreadable",
    };
  }
  const report = reviewLedger(ledger, { asOf: isoInstant(now) });
  return {
    state: report.totals.flagged_open > 0 ? "unreviewed" : "clear",
    batches: ledger.batches.length,
    flagged_open: report.totals.flagged_open,
    groups: report.groups.map((group) => ({ flag: group.flag, count: group.count })),
  };
}

function assertReviewed(review, waived) {
  if (waived) return;
  if (review.state === "unreviewed") {
    const groups = review.groups.map((group) => `${group.flag} x${group.count}`).join(", ");
    fail(
      "workspace_review_required",
      `The ledger carries ${review.flagged_open} flagged open row(s) in ${groups}. Their consumer `
        + "is docs/runbooks/triage-review.md; a wipe destroys them. Re-run with --waive-review "
        + "once you have decided to lose them.",
    );
  }
  if (review.state === "unreadable") {
    fail(
      "workspace_review_required",
      `The ledger could not be read (${review.detail}), so whether it holds unreviewed flags is `
        + "unknown. Inspect it, then re-run with --waive-review.",
    );
  }
}

function runChild(context, workspace, label, args) {
  const result = context.spawn(process.execPath, args, {
    cwd: workspace.root,
    encoding: "utf8",
    env: context.childEnv,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (result.error) {
    fail("workspace_child_failed", `${label} could not run (${result.error.code ?? "unknown"}).`);
  }
  if (result.status !== 0) {
    fail(
      "workspace_child_failed",
      `${label} failed with status ${result.status}: ${tail(result.stderr)}`,
    );
  }
  return { status: "ok", stdout: tail(result.stdout) };
}

/**
 * The two creation commands of `docs/runbooks/rehearsal-worktree.md`, run as the tree's own
 * copies and from the tree's own root. That is not a detail: `tools/bootstrap.mjs` derives the
 * workspace from its own location, so the copy that runs decides which checkout gets a
 * `process-log.json`. Spelled with
 * this interpreter rather than through `npm run`, which is the same program by a longer path.
 */
function runInitHalf(context, workspace) {
  return {
    bootstrap: runChild(context, workspace, "bootstrap --init", [
      join(workspace.root, "tools", "bootstrap.mjs"),
      "--init",
    ]),
    triage_ledger: runChild(context, workspace, "triage-ledger init", [
      join(workspace.root, "tools", "triage-ledger.mjs"),
      "init",
    ]),
  };
}

const STEP_FOUR_NOTES = Object.freeze([
  "A Step 4 (CV render) run needs a local .claude/settings.local.json with the sandbox disabled: "
    + "under the tracked settings soffice does not fail, it hangs "
    + "(docs/runbooks/ops-cutover.md). This repository does not ignore that file, so unless your "
    + "global git excludes hide it, every command here reads the tree as dirty while it is there.",
  "A Step 4 (CV render) run also needs a copy of tools/cv-builder/node_modules; a fresh worktree "
    + "has none, and bootstrap does not install it.",
]);

function preflight(context, options) {
  assertAllowed(options, []);
  const workspace = resolveWorkspace(context);
  assertCleanTree(context);
  const base = readBase(workspace);
  if (base.sha !== workspace.head) {
    fail(
      "workspace_base_mismatch",
      `HEAD ${workspace.head} is not the pinned base ${base.sha}. A run measures the commit it `
        + 'names; re-pin deliberately with "workspace-reset reset --repin <sha>".',
    );
  }
  if (!existsSync(join(workspace.root, "triage-ledger.json"))) {
    fail(
      "workspace_ledger_missing",
      "triage-ledger.json does not exist. A missing ledger is a stop and an explicit init "
        + "(docs/runbooks/rehearsal-worktree.md), never an implicit creation on the way past.",
    );
  }
  return {
    command: "preflight",
    status: "ready",
    workspace_root: workspace.rootRealPath,
    branch: workspace.branch,
    label: workspace.label,
    head: workspace.head,
    base,
    locked: workspace.worktree.locked,
    lock_reason: workspace.worktree.lockReason,
    state: {
      process_log: existsSync(join(workspace.root, "process-log.json")),
      triage_ledger: true,
      output_root: existsSync(join(workspace.root, "output")),
    },
    review: reviewState(workspace, context.now().getTime()),
  };
}

function init(context, options) {
  assertAllowed(options, ["purpose", "seed-ledger"]);
  const workspace = resolveWorkspace(context);
  assertCleanTree(context);

  const existing = readBase(workspace, { allowMissing: true });
  if (existing !== null && existing.sha !== workspace.head) {
    fail(
      "workspace_already_initialized",
      `${BASE_RELATIVE_PATH} pins ${existing.sha} and HEAD is ${workspace.head}. init never moves `
        + 'a pin; "workspace-reset reset --repin <sha>" is the reviewed way to move one.',
    );
  }
  const purpose = Object.hasOwn(options, "purpose")
    ? boundedText(options.purpose, "--purpose")
    : existing?.purpose ?? workspace.branch;
  const base = writeBase(workspace, {
    ...(existing ?? {}),
    sha: workspace.head,
    created_at: existing?.created_at ?? isoInstant(context.now().getTime()),
    purpose,
  });

  // Worktree lifecycle commands write into the shared .git, outside this session's cwd.
  // docs/runbooks/rehearsal-worktree.md names that exception explicitly, and its deletion
  // section explains why the lock is set at creation: without it the tree, whose whole content
  // is ignored, is removed by a plain
  // `git worktree remove` with no question asked and no `--force` needed.
  let locked = "already";
  if (!workspace.worktree.locked) {
    runGit(context, [
      "worktree",
      "lock",
      "--reason",
      `unharvested: ${purpose}`,
      workspace.worktree.registeredPath,
    ]);
    locked = "created";
  }

  const seeded = Object.hasOwn(options, "seed-ledger")
    ? seedLedger(workspace, options["seed-ledger"])
    : null;

  return {
    command: "init",
    status: "initialized",
    workspace_root: workspace.rootRealPath,
    branch: workspace.branch,
    label: workspace.label,
    head: workspace.head,
    base,
    locked,
    seeded,
    ...runInitHalf(context, workspace),
    notes: [...STEP_FOUR_NOTES],
  };
}

/**
 * A byte copy of an existing ledger, so a fresh tree can start from a real baseline instead of
 * re-measuring links somebody already triaged. Validated before it is copied — a corrupt seed
 * would fail at the next batch, in the middle of a run — and refused once the tree has a ledger
 * of its own, because overwriting one is a wipe wearing a different name.
 */
function seedLedger(workspace, rawPath) {
  const source = boundedText(rawPath, "--seed-ledger", 4096);
  if (!source.startsWith("/")) {
    fail("workspace_seed_invalid", "--seed-ledger takes an absolute path.");
  }
  const destination = join(workspace.root, "triage-ledger.json");
  if (existsSync(destination)) {
    fail(
      "workspace_seed_refused",
      "triage-ledger.json already exists here. Seeding is a fresh-tree choice; it never "
        + "overwrites a ledger that already holds batches.",
    );
  }
  let ledger;
  try {
    ledger = readLedger(source);
  } catch (error) {
    fail(
      "workspace_seed_invalid",
      `${source} is not a readable triage ledger `
        + `(${error instanceof TriageLedgerError ? error.code : "unreadable"}).`,
    );
  }
  try {
    copyFileSync(source, destination);
  } catch (error) {
    fail("workspace_seed_invalid", `${source} could not be copied (${error?.code ?? "unknown"}).`);
  }
  return { from: source, entries: ledger.entries.length, batches: ledger.batches.length };
}

function reset(context, options) {
  assertAllowed(options, ["repin", "dry-run", "confirmation-token", "waive-review"]);
  if (options["dry-run"] && Object.hasOwn(options, "confirmation-token")) {
    fail(
      "workspace_invalid_arguments",
      "--dry-run and --confirmation-token are mutually exclusive.",
    );
  }
  const token = Object.hasOwn(options, "confirmation-token") ? options["confirmation-token"] : null;
  if (token !== null && !CONFIRMATION_PATTERN.test(token)) {
    fail("workspace_invalid_arguments", "--confirmation-token must be a lower-case sha-256 token.");
  }

  const workspace = resolveWorkspace(context);
  assertCleanTree(context);
  readBase(workspace);

  const repin = Object.hasOwn(options, "repin") ? resolveRepin(context, options.repin) : null;
  const now = context.now().getTime();
  const review = reviewState(workspace, now);
  assertReviewed(review, options["waive-review"] === true);

  const inspected = inventory(context, workspace, now);
  assertUntracked(context, inspected.targets);
  assertNoLiveLock(inspected.targets);

  const expectedToken = confirmationToken(
    { ...workspace, repin: repin?.sha ?? null },
    inspected.tree_digest,
  );
  const result = {
    command: "reset",
    workspace_root: workspace.rootRealPath,
    branch: workspace.branch,
    label: workspace.label,
    head: workspace.head,
    repin,
    review: { ...review, waived: options["waive-review"] === true },
    inventory: inspected,
    confirmation_token: expectedToken,
  };
  if (token === null) {
    return { status: "review_required", ...result };
  }
  if (token !== expectedToken) {
    fail(
      "workspace_confirmation_mismatch",
      "The confirmation token does not match this inventory. Re-run the review phase and confirm "
        + "exactly what it prints.",
    );
  }
  if (inventory(context, workspace, now).tree_digest !== inspected.tree_digest) {
    fail(
      "workspace_inventory_changed",
      "The inventory changed between review and confirmation; nothing was removed.",
    );
  }

  const removed = [];
  for (const target of inspected.targets) {
    const path = join(workspace.root, target.name);
    try {
      rmSync(path, { recursive: true });
    } catch (error) {
      fail(
        "workspace_remove_failed",
        `${target.name} could not be removed (${error?.code ?? "unknown error"}).`,
      );
    }
    if (lstatBig(path, { allowMissing: true }) !== null) {
      fail("workspace_remove_failed", `${target.name} survived removal.`);
    }
    removed.push(target.name);
  }

  let base = readBase(workspace);
  if (repin !== null) {
    runGit(context, ["reset", "--hard", repin.sha]);
    const head = gitLine(context, ["rev-parse", "HEAD"]);
    if (head !== repin.sha) {
      fail("workspace_repin_failed", `HEAD is ${head} after the repin to ${repin.sha}.`);
    }
    base = writeBase(workspace, { ...base, sha: repin.sha });
    result.head = head;
  }

  // Always, not only after a repin: the wipe is what removed the untracked ledger and output
  // root, so without this the next batch dies on bootstrap_required or a missing ledger either
  // way. Both children refuse to overwrite what already exists, so re-running them is safe.
  const reinitialized = runInitHalf(context, workspace);

  return { status: "reset", ...result, base, removed, reinitialized, notes: [...STEP_FOUR_NOTES] };
}

function resolveRepin(context, raw) {
  const value = boundedText(raw, "--repin", 64);
  if (!COMMIT_PATTERN.test(value)) {
    fail(
      "workspace_repin_invalid",
      "--repin takes an object name in hexadecimal, 7 to 40 characters. A rehearsal tree is "
        + "re-pinned to a named commit, never to a symbolic revision.",
    );
  }
  const resolved = runGit(context, ["rev-parse", "--verify", "--quiet", `${value}^{commit}`], {
    allowFailure: true,
  });
  const sha = resolved.stdout.trim();
  if (!resolved.ok || !FULL_SHA_PATTERN.test(sha)) {
    fail("workspace_repin_invalid", `${value} does not name a commit in this repository.`);
  }
  // A branch may be named like an abbreviated object, and rev-parse would resolve the ref. An
  // object name is a prefix of what it resolves to; a ref almost never is.
  if (!sha.startsWith(value)) {
    fail(
      "workspace_repin_invalid",
      `${value} resolves to commit ${sha}, which it does not name. --repin takes the object name `
        + "of the commit itself, not a branch or a tag that points at one.",
    );
  }
  return { requested: value, sha };
}

const COMMANDS = Object.freeze({ init, preflight, reset });

export function runWorkspaceReset(argv, {
  cwd = process.cwd(),
  environment = process.env,
  spawn = spawnSync,
  now = () => new Date(),
} = {}) {
  const { command, options } = parseArgs(argv);
  if (!command || !Object.hasOwn(COMMANDS, command)) {
    fail("workspace_unknown_command", `Unknown command: ${command ?? "<none>"}`);
  }
  return COMMANDS[command]({
    childEnv: childEnvironment(environment),
    cwd,
    environment,
    now,
    spawn,
  }, options);
}

export function main(argv = process.argv.slice(2)) {
  try {
    if (argv[0] === "help" || argv[0] === "--help") {
      console.log(usage());
      return;
    }
    console.log(JSON.stringify(runWorkspaceReset(argv), null, 2));
  } catch (error) {
    const code = error instanceof WorkspaceResetError ? error.code : "workspace_reset_failed";
    console.error(JSON.stringify({
      error: { code, message: error?.message ?? "unknown error" },
    }));
    process.exitCode = 1;
  }
}

function isDirectInvocation() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  }
}

if (isDirectInvocation()) main();
