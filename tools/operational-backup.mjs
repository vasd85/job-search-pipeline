#!/usr/bin/env node

/**
 * Rotating local backup of the operational state: `run`, `verify`, `print-plist`.
 *
 * The mutable state is single-copy by design. Independent off-machine backup remains an
 * explicit operator decision. docs/runbooks/operational-backup.md#1-what-this-protects-against-and-what-not
 * owns what the local rotation protects against; it narrows the durability gap without closing it.
 *
 * Five properties carry the design.
 *
 * - **The tree it copies is the tree it lives in, and no argument can say otherwise.** An earlier
 *   version took the checkout as `--source` and guarded it by requiring a `process-log.json`
 *   there. That guard proved a tree *has* a ledger, not that it is *the* one: pointed at a scratch
 *   directory somebody had run `bootstrap --init` in, it archived it and reported success, and a
 *   rehearsal worktree legitimately holds both ledgers too. `requireOperationalRoot` below states
 *   what replaced it: the operational folder's marker, with no checkout fallback.
 * - **A snapshot is consistent or refused, never a plausible-looking corrupt copy.** Each member
 *   pair is copied while holding the very lock its writers take: `withLogV3Lock` for
 *   `process-log.json` together with `output/`, `withLedgerLock` for `triage-ledger.json`
 *   together with `triage-batches/`. Both wrappers validate what they lock, so an unreadable
 *   ledger refuses here instead of being archived as a rollback target — the same choice
 *   `backupProcessLogV3` already makes for the cutover copy. The members no lock covers follow
 *   the same rule: a JSON member that does not parse refuses the snapshot. Rotation runs only
 *   after a snapshot succeeds, so a refusing day keeps every older good copy rather than ageing
 *   one out.
 * - **The locks are borrowed, never reimplemented, and never held together.** No writer in this
 *   repository takes both, and the two stores do not reference each other, so a sequential hold
 *   is enough and a simultaneous one would invent a lock order nothing else obeys.
 * - **Deletion can only reach what this tool wrote.** Rotation keeps the newest `--keep`
 *   directories among those whose name is a stamp *and* whose `manifest.json` this tool wrote,
 *   and removes nothing else, ever. A foreign directory in the destination is invisible to it —
 *   the rule the repository already applies to the ADR 0011 input files, for the same reason.
 * - **Every filesystem step is synchronous, and that is load-bearing.** A signal handler is a
 *   callback: it cannot run while a synchronous copy holds a lock, because the event loop only
 *   turns after the wrapper's `finally` has released it. So interruption while holding a lock is
 *   not a window this code has to close by hand — SIGTERM lands at a phase boundary, where the
 *   handler removes the partial directory and exits. SIGKILL and power loss remain; the runbook
 *   owns the ledger lock left behind by those, because that lock has no staleness recovery of
 *   its own (the process log's does, at 30 seconds).
 *
 * What is deliberately not copied: `output/<company-role>/.pipeline-tmp/` staging, which has live
 * writers holding no log lock (`tools/cv-builder/build.mjs` renders, skill-staged JSON) and is
 * rebuildable working state rather than published evidence; the ledgers' lock and `.tmp`
 * siblings, which under the held lock are either absent or ours; `process-log.backup-*.json`,
 * owned by the cutover rollback commands; `telegram-sweeps/`, whose addresses the triage ledger
 * already holds and whose page captures would soon outgrow `MAX_ENTRIES`; `.ops-tree/`;
 * `.pipeline-input/` and `.rehearsal/`.
 */

import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withLogV3Lock } from "./lib/process-log-core.mjs";
import { withLedgerLock } from "./lib/triage-ledger-core.mjs";
import { OpsTreeError, readManifest as readFolderManifest } from "./ops-tree/manifest.mjs";

/**
 * The manifest's identity, and with it the tool's claim of ownership over a directory. Rotation
 * deletes nothing that does not carry these two values, so a change here makes older snapshots
 * foreign — which is a retention decision, not a formatting one.
 */
export const MANIFEST_SCHEMA = "job-search-pipeline/operational-backup-manifest";
export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_FILE_NAME = "manifest.json";

export const LAUNCH_AGENT_LABEL = "com.job-search-pipeline.backup";
export const DEFAULT_KEEP = 7;
/** The process-log lock's own default wait, mirrored so `--lock-timeout-ms` has a stated basis. */
export const DEFAULT_LOCK_TIMEOUT_MS = 35_000;
/**
 * A partial directory is removed only when it is this old: a younger one may belong to a run that
 * is still copying. The sweep is confined to this tool's own name shape in its own destination.
 */
export const PARTIAL_SWEEP_AFTER_MS = 24 * 60 * 60 * 1000;

/** Bounds on one snapshot. Exceeding either refuses rather than copying half a tree. */
export const MAX_ENTRIES = 100_000;
export const MAX_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_DEPTH = 32;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

const STAMP_PATTERN = /^\d{8}T\d{6}Z$/;
const PARTIAL_PATTERN = /^\d{8}T\d{6}Z\.partial-\d+$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const STAGING_DIRECTORY_NAME = ".pipeline-tmp";
const BATCH_RECORD_FILE_NAME = "ledger-record.json";
const BOOLEAN_FLAGS = ["help"];

/**
 * The members, in copy order, each with the lock that makes it consistent. `process-log.json` is
 * the required one: its presence proves that the marked folder carries operational state;
 * development trees carry no such ledger
 * (docs/runbooks/development-flow.md#3-rules-that-do-not-bend).
 *
 * The members with `lock: "none"` are written by nobody who takes either lock, so holding one
 * while copying them would buy nothing. `telegram-sweep-state.json` and `ops-manifest.json` are
 * written through a temporary file and a rename, so a copy never sees half of one;
 * `telegram-sources.json` is edited by hand; a corpus record in `records/` is written once; a
 * draft in `outbox/` is written by a session and removed by `board:import`. A record or a draft
 * caught mid-write is the remainder, and the next night's copy replaces it. `json: true` members
 * are parsed after the copy, the way their owners parse them.
 */
export const MEMBERS = Object.freeze([
  Object.freeze({ id: "process-log.json", kind: "file", lock: "process-log", required: true }),
  Object.freeze({ id: "output", kind: "tree", lock: "process-log", required: false }),
  Object.freeze({ id: "triage-ledger.json", kind: "file", lock: "triage-ledger", required: false }),
  Object.freeze({ id: "triage-batches", kind: "tree", lock: "triage-ledger", required: false }),
  Object.freeze({ id: "telegram-sources.json", kind: "file", lock: "none", required: false, json: true }),
  Object.freeze({ id: "telegram-sweep-state.json", kind: "file", lock: "none", required: false, json: true }),
  Object.freeze({ id: "records", kind: "tree", lock: "none", required: false }),
  Object.freeze({ id: "outbox", kind: "tree", lock: "none", required: false }),
  Object.freeze({ id: "ops-manifest.json", kind: "file", lock: "none", required: false, json: true }),
]);

export class OperationalBackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OperationalBackupError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new OperationalBackupError(code, message);
}

/**
 * The two lock wrappers refuse with their own bounded codes — `triage_ledger_locked`,
 * `process_log_lock_timeout`, `triage_ledger_unreadable` — and those codes are the whole
 * diagnosis. Re-wrapping them under one code of this tool's own would tell an operator that the
 * backup failed while hiding which of "someone is writing" and "the state is corrupt" it was, and
 * the runbook's repair steps differ between the two.
 */
function reportedErrorCode(error) {
  if (error instanceof OperationalBackupError) return error.code;
  const code = error?.code;
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "backup_failed";
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requirePath(value, flag) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    fail("backup_invalid_arguments", `${flag} takes a non-empty path.`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    fail("backup_invalid_arguments", `${flag} must not contain control characters.`);
  }
  return resolve(value);
}

function requireAbsolutePath(value, flag) {
  const resolved = requirePath(value, flag);
  if (!existsSync(resolved)) fail("backup_path_missing", `${flag} does not exist: ${resolved}`);
  return realpathSync(resolved);
}

/**
 * For the one flag that must accept a path which does not exist yet. Absoluteness is checked
 * rather than manufactured: `requirePath` resolves against the working directory, which for an
 * existing path is caught by the existence check and for this one would silently invent a
 * plausible-looking path out of a typo.
 */
function requireAbsentablePath(value, flag) {
  const resolved = requirePath(value, flag);
  if (!isAbsolute(value)) {
    fail(
      "backup_path_not_absolute",
      `${flag} takes an absolute path; ${value} would be read as ${resolved}, relative to `
        + "wherever this command happened to run.",
    );
  }
  return resolved;
}

function requireInstant(value, flag) {
  if (!INSTANT_PATTERN.test(value ?? "")) {
    fail("backup_invalid_arguments", `${flag} takes a UTC instant like 2026-09-01T11:00:00Z.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    fail("backup_invalid_arguments", `${flag} is not a real instant: ${value}`);
  }
  return parsed;
}

function requireCount(value, flag, { min, max }) {
  if (!/^\d{1,9}$/.test(value ?? "")) {
    fail("backup_invalid_arguments", `${flag} takes a whole number.`);
  }
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    fail("backup_invalid_arguments", `${flag} must be between ${min} and ${max}.`);
  }
  return parsed;
}

/** `2026-09-01T11:00:00.000Z` → `20260901T110000Z`. The stamp is the directory name. */
export function stampOf(instant) {
  return `${instant.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}

function containsPath(outer, inner) {
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
}

/**
 * One sorted inventory of a directory tree: the same function builds the manifest at snapshot
 * time and rebuilds it at verify time, so a comparison covers content, symlink targets, empty
 * directories and unexpected additions in one deep-equal rather than in four checks that could
 * each be forgotten.
 */
export function inventoryTree(root, { prefix = "", state = { entries: 0, bytes: 0 } } = {}) {
  const files = [];
  const walk = (absolute, relativePath, depth) => {
    if (depth > MAX_DEPTH) {
      fail("backup_tree_too_deep", `${relativePath} is deeper than ${MAX_DEPTH} levels.`);
    }
    const names = readdirSync(absolute).sort();
    for (const name of names) {
      const childAbsolute = join(absolute, name);
      const childRelative = relativePath === "" ? name : `${relativePath}/${name}`;
      const stats = lstatSync(childAbsolute);
      state.entries += 1;
      if (state.entries > MAX_ENTRIES) {
        fail("backup_tree_too_large", `${root} holds more than ${MAX_ENTRIES} entries.`);
      }
      if (stats.isSymbolicLink()) {
        files.push({ path: childRelative, kind: "symlink", target: readlinkSync(childAbsolute) });
        continue;
      }
      if (stats.isDirectory()) {
        files.push({ path: childRelative, kind: "dir" });
        walk(childAbsolute, childRelative, depth + 1);
        continue;
      }
      if (!stats.isFile()) {
        fail("backup_unsupported_entry", `${childRelative} is neither a file, a link nor a dir.`);
      }
      state.bytes += stats.size;
      if (state.bytes > MAX_BYTES) {
        fail("backup_tree_too_large", `${root} holds more than ${MAX_BYTES} bytes.`);
      }
      files.push({
        path: childRelative,
        kind: "file",
        bytes: stats.size,
        sha256: sha256Hex(readFileSync(childAbsolute)),
      });
    }
  };
  walk(root, "", 1);
  return prefix === ""
    ? files
    : files.map((entry) => ({ ...entry, path: `${prefix}/${entry.path}` }));
}

function inventoryFile(root, relativePath, state) {
  const absolute = join(root, relativePath);
  const stats = lstatSync(absolute);
  if (!stats.isFile()) fail("backup_unsupported_entry", `${relativePath} is not a regular file.`);
  state.entries += 1;
  state.bytes += stats.size;
  return {
    path: relativePath,
    kind: "file",
    bytes: stats.size,
    sha256: sha256Hex(readFileSync(absolute)),
  };
}

function copyFileMember(sourcePath, targetPath) {
  cpSync(sourcePath, targetPath, {
    errorOnExist: true,
    force: false,
    mode: fsConstants.COPYFILE_FICLONE,
    preserveTimestamps: true,
  });
}

/**
 * Copies a tree, skipping what `skip` names. The skipped paths are collected rather than dropped:
 * a snapshot that silently omits part of a tree reads later as a tree that was empty.
 */
function copyTreeMember(sourcePath, targetPath, skip = () => false) {
  const skipped = [];
  cpSync(sourcePath, targetPath, {
    dereference: false,
    errorOnExist: true,
    filter: (from) => {
      const relativePath = relative(sourcePath, from);
      if (relativePath !== "" && skip(from, relativePath)) {
        skipped.push(relativePath.split(sep).join("/"));
        return false;
      }
      return true;
    },
    force: false,
    mode: fsConstants.COPYFILE_FICLONE,
    preserveTimestamps: true,
    recursive: true,
  });
  return skipped.sort();
}

/**
 * A batch directory is copied only once its `ledger-record.json` exists. The record is written
 * under the ledger lock this phase holds, and the store's contract makes a written record
 * immutable (docs/runbooks/triage-review.md#11-batch-store-the-history-beside-the-index), so "has a record" is exactly "is
 * consistent by construction". A directory without one is a run still building — the fetch
 * transport writes into it holding no lock — and it is named in the manifest rather than copied,
 * to be picked up on the night after its record lands.
 */
function copyBatchStore(sourcePath, targetPath) {
  const skippedBatches = [];
  mkdirSync(targetPath, { mode: 0o700, recursive: true });
  for (const name of readdirSync(sourcePath).sort()) {
    const batchPath = join(sourcePath, name);
    if (!lstatSync(batchPath).isDirectory() || !existsSync(join(batchPath, BATCH_RECORD_FILE_NAME))) {
      skippedBatches.push(name);
      continue;
    }
    copyTreeMember(batchPath, join(targetPath, name));
  }
  return skippedBatches;
}

function memberReport(member, extra = {}) {
  return { member: member.id, kind: member.kind, lock: member.lock, ...extra };
}

/**
 * Phase A. `output/` is copied inside the process-log lock because every canonical file in it
 * appears or changes inside a publication transaction that holds the same lock
 * (`publishFileBackedStepV3`), which is what makes the ledger and the artifacts it points at one
 * consistent set. Staging is excluded: it has writers that hold no lock at all.
 */
function copyProcessLogPair(source, target, { lockTimeoutMs }) {
  const logPath = join(source, "process-log.json");
  const outputPath = join(source, "output");
  return withLogV3Lock(logPath, ({ log }) => {
    copyFileMember(logPath, join(target, "process-log.json"));
    const reports = [memberReport(MEMBERS[0], { status: "copied", records: log.processes.length })];
    if (!existsSync(outputPath)) {
      reports.push(memberReport(MEMBERS[1], { status: "absent" }));
      return reports;
    }
    const skipped = copyTreeMember(
      outputPath,
      join(target, "output"),
      (from) => basename(from) === STAGING_DIRECTORY_NAME,
    );
    reports.push(memberReport(MEMBERS[1], { status: "copied", excluded_paths: skipped }));
    return reports;
  }, { timeoutMs: lockTimeoutMs });
}

/**
 * Phase B, skipped whole when the ledger file is absent — `withLedgerLock` reads the ledger under
 * the lock and refuses a missing one, so entering it would turn "this checkout has no triage
 * state yet" into a failed backup. That is today's operational shape: the batch store reaches
 * `ops/current` only with the next cutover.
 */
function copyTriagePair(source, target) {
  const ledgerPath = join(source, "triage-ledger.json");
  const storePath = join(source, "triage-batches");
  if (!existsSync(ledgerPath)) {
    const reports = [memberReport(MEMBERS[2], { status: "absent" })];
    reports.push(memberReport(MEMBERS[3], {
      status: existsSync(storePath) ? "skipped_without_ledger" : "absent",
    }));
    return reports;
  }
  // `changed: false` is what keeps this a read: the wrapper writes the ledger back only when the
  // callback does not say so, and this one never mutates what it was handed.
  return withLedgerLock(ledgerPath, (ledger) => {
    copyFileMember(ledgerPath, join(target, "triage-ledger.json"));
    const reports = [memberReport(MEMBERS[2], { status: "copied", rows: ledger.entries.length })];
    if (existsSync(storePath)) {
      reports.push(memberReport(MEMBERS[3], {
        status: "copied",
        skipped_batches: copyBatchStore(storePath, join(target, "triage-batches")),
      }));
    } else {
      reports.push(memberReport(MEMBERS[3], { status: "absent" }));
    }
    return { changed: false, result: reports };
  });
}

/**
 * Phase C, outside both locks. A member that is present but of the wrong kind — a file where a
 * directory belongs, a symbolic link at the member's own path — refuses before anything of it is
 * copied: a link would archive a pointer rather than the state, and a directory walk into it
 * would archive whatever it happens to point at.
 */
function copyUnlockedMembers(source, target) {
  const reports = [];
  for (const member of MEMBERS.filter((candidate) => candidate.lock === "none")) {
    const from = join(source, member.id);
    let stats;
    try {
      stats = lstatSync(from);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      reports.push(memberReport(member, { status: "absent" }));
      continue;
    }
    const expected = member.kind === "file" ? stats.isFile() : stats.isDirectory();
    if (!expected) {
      fail(
        "backup_unsupported_entry",
        `${member.id} is expected to be a ${member.kind === "file" ? "regular file" : "directory"}.`,
      );
    }
    const to = join(target, member.id);
    mkdirSync(dirname(to), { mode: 0o700, recursive: true });
    if (member.kind === "file") {
      copyFileMember(from, to);
      if (member.json) requireReadableJson(member, to);
      reports.push(memberReport(member, { status: "copied" }));
    } else {
      copyTreeMember(from, to);
      reports.push(memberReport(member, { status: "copied" }));
    }
  }
  return reports;
}

/**
 * Parsed from the copy, since the copy is what a restore would put back, and parsed the way the
 * owners parse — `tools/telegram-collect/config.mjs` strips a byte order mark first — so a file
 * its owner reads is never refused here.
 */
function requireReadableJson(member, path) {
  try {
    JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""));
  } catch {
    fail(
      "backup_member_unreadable",
      `${member.id} is not readable JSON. The snapshot is refused rather than archiving it: a `
        + "copy of a damaged file would take a rotation slot from a good one.",
    );
  }
}

/**
 * The inventory of every member present under `root`, in member order. The snapshot's manifest
 * and `verify --backup` both build their file lists here, so a member added to `MEMBERS` is
 * copied, recorded and verified alike, and cannot be forgotten in one of them.
 */
function inventoryMembers(root, state) {
  const files = [];
  for (const member of MEMBERS) {
    const path = join(root, member.id);
    if (!existsSync(path)) continue;
    if (member.kind === "file") {
      files.push(inventoryFile(root, member.id, state));
    } else {
      files.push(...inventoryTree(path, { prefix: member.id, state }));
    }
  }
  return files;
}

function readManifest(directory) {
  const manifestPath = join(directory, MANIFEST_FILE_NAME);
  try {
    if (!lstatSync(manifestPath).isFile()) return null;
    if (statSync(manifestPath).size > MAX_MANIFEST_BYTES) return null;
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (parsed?.schema !== MANIFEST_SCHEMA) return null;
    if (parsed?.schema_version !== MANIFEST_SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    // Unreadable, unparseable or foreign: not ours, therefore never ours to delete.
    return null;
  }
}

/**
 * The tree this tool copies, and what makes it the right one.
 *
 * Nothing here is a value anybody types. The root is the directory the tool itself lives in, derived from the
 * script's own resolved location rather than from `process.cwd()`, because a scheduled job's
 * working directory is whatever the scheduler hands it and the installed job declares none.
 *
 * The source is recognised by its marker first. The operational folder built by `tools/ops-tree/`
 * is not a checkout: `ops-manifest.json` at its root names its kind, and only `operational`
 * qualifies. A rehearsal folder is refused: its disposable rows die with it,
 * so archiving them would contradict that and spend rotation slots on state meant to be thrown
 * away. A folder whose swap is still `building` is accepted and marked: the swap never moves the
 * members, and the snapshot after an interrupted cutover is the one most worth having. A marker
 * decides even in a git checkout: the marker is what the folder says it is.
 *
 * An unmarked tree is refused, regardless of git topology.
 *
 * The tree must hold `process-log.json`: a tree that carries no operational state is
 * refused rather than archived, because in a development worktree the absence of that file is the
 * protection itself.
 */
function requireOperationalRoot(root) {
  let manifest = null;
  try {
    manifest = readFolderManifest(root);
  } catch (error) {
    if (!(error instanceof OpsTreeError)) throw error;
    fail("backup_root_manifest_invalid", `${root} carries an unreadable operational-folder marker: ${error.message}`);
  }
  let folder = null;
  let identity;
  if (manifest !== null) {
    if (manifest.kind !== "operational") {
      fail(
        "backup_root_rehearsal",
        `${root} is a ${manifest.kind} folder; its state dies with it and is never backed up.`,
      );
    }
    folder = { kind: manifest.kind, state: manifest.state };
    identity = "marker";
  } else {
    fail(
      "backup_root_unmarked",
      `${root} carries no operational-folder marker (ops-manifest.json). `
        + "The backup copies only the marked operational folder it lives in; "
        + "development and rehearsal trees are never backed up.",
    );
  }
  if (!existsSync(join(root, "process-log.json"))) {
    fail(
      "backup_root_not_operational",
      `${root} holds no process-log.json. The backup refuses rather than archiving a checkout `
        + "that carries no operational state, where the absence of that file is the protection "
        + "itself.",
    );
  }
  return { folder, identity, root };
}


/** Every snapshot this tool owns in a destination, newest first. Nothing else is ever listed. */
export function ownedSnapshots(destination) {
  const owned = [];
  for (const name of readdirSync(destination).sort()) {
    if (!STAMP_PATTERN.test(name)) continue;
    const directory = join(destination, name);
    if (!lstatSync(directory).isDirectory()) continue;
    const manifest = readManifest(directory);
    if (manifest === null) continue;
    owned.push({ stamp: name, path: directory, created_at: manifest.created_at });
  }
  return owned.reverse();
}

function sweepPartials(destination, now, currentPartial) {
  const removed = [];
  for (const name of readdirSync(destination).sort()) {
    if (!PARTIAL_PATTERN.test(name)) continue;
    const directory = join(destination, name);
    if (directory === currentPartial) continue;
    let stats;
    try {
      stats = lstatSync(directory);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    if (now.getTime() - stats.mtimeMs < PARTIAL_SWEEP_AFTER_MS) continue;
    rmSync(directory, { force: true, recursive: true });
    removed.push(name);
  }
  return removed;
}

function rotate(destination, keep, now, currentPartial) {
  const owned = ownedSnapshots(destination);
  const removed = [];
  for (const snapshot of owned.slice(keep)) {
    rmSync(snapshot.path, { force: true, recursive: true });
    removed.push(snapshot.stamp);
  }
  return {
    kept: owned.slice(0, keep).map((snapshot) => snapshot.stamp),
    removed_snapshots: removed,
    removed_partials: sweepPartials(destination, now, currentPartial),
  };
}

export function run(options, { now, root }) {
  assertAllowed(options, ["dest", "keep", "lock-timeout-ms", "now"]);
  const { folder, identity, root: source } = requireOperationalRoot(root);
  const destination = resolveDestination(requireOption(options, "dest"));
  const keep = "keep" in options
    ? requireCount(options.keep, "--keep", { min: 1, max: 365 })
    : DEFAULT_KEEP;
  const lockTimeoutMs = "lock-timeout-ms" in options
    ? requireCount(options["lock-timeout-ms"], "--lock-timeout-ms", { min: 1, max: 600_000 })
    : DEFAULT_LOCK_TIMEOUT_MS;
  const instant = "now" in options ? requireInstant(options.now, "--now") : now();

  if (containsPath(source, destination) || containsPath(destination, source)) {
    fail(
      "backup_destination_inside_source",
      "the destination and the source must not contain each other; a destination inside the "
        + "checkout would be copied into itself and would also be operational state.",
    );
  }
  const stamp = stampOf(instant);
  const target = join(destination, stamp);
  if (existsSync(target)) {
    fail("backup_snapshot_exists", `${target} already exists and is never overwritten.`);
  }
  const partial = `${target}.partial-${process.pid}`;
  if (existsSync(partial)) {
    fail("backup_partial_exists", `${partial} already exists; remove it before retrying.`);
  }

  const cleanup = () => rmSync(partial, { force: true, recursive: true });
  const handler = () => {
    cleanup();
    process.exit(1);
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
  let members;
  try {
    mkdirSync(partial, { mode: 0o700, recursive: true });
    members = [
      ...copyProcessLogPair(source, partial, { lockTimeoutMs }),
      ...copyTriagePair(source, partial),
      ...copyUnlockedMembers(source, partial),
    ];
  } catch (error) {
    cleanup();
    throw error;
  } finally {
    process.off("SIGTERM", handler);
    process.off("SIGINT", handler);
  }

  // Outside both locks: the bytes are already this tool's own copy, so hashing them holds nothing
  // up. What the digests attest is the copy against its manifest, never the copy against a source
  // that is free to move on the moment the lock is released.
  const state = { bytes: 0, entries: 0 };
  const files = inventoryMembers(partial, state);
  const manifest = {
    schema: MANIFEST_SCHEMA,
    schema_version: MANIFEST_SCHEMA_VERSION,
    stamp,
    created_at: instant.toISOString(),
    source,
    excluded: [STAGING_DIRECTORY_NAME],
    members,
    entry_count: files.length,
    byte_count: state.bytes,
    files,
  };
  writeFileSync(join(partial, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  // Checked, then renamed: `rename` succeeds onto an empty directory, so the guard cannot be the
  // rename itself. A snapshot directory therefore exists complete or not at all.
  if (existsSync(target)) {
    cleanup();
    fail("backup_snapshot_exists", `${target} appeared while this snapshot was being built.`);
  }
  renameSync(partial, target);

  return {
    status: "backed_up",
    stamp,
    destination,
    source,
    source_identity: identity,
    ...(folder ? { operational_folder: folder } : {}),
    snapshot: target,
    entry_count: files.length,
    byte_count: state.bytes,
    members,
    rotation: rotate(destination, keep, instant, partial),
  };
}

function resolveDestination(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    fail("backup_invalid_arguments", "--dest takes a non-empty path.");
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    fail("backup_invalid_arguments", "--dest must not contain control characters.");
  }
  const resolved = resolve(value);
  mkdirSync(resolved, { mode: 0o700, recursive: true });
  return realpathSync(resolved);
}

/**
 * Two modes, one command. `--backup` re-reads a snapshot against its own manifest; `--dest` with
 * `--max-age-hours` answers the only question a scheduled job cannot answer for itself — is it
 * still running at all. Every failure mode of this tool looks identical from outside (a missing
 * dated directory and a log line nobody reads), so the freshness check is the liveness signal the
 * runbook prescribes.
 */
export function verify(options, { now }) {
  assertAllowed(options, ["backup", "dest", "max-age-hours", "now"]);
  const instant = "now" in options ? requireInstant(options.now, "--now") : now();
  const readsSnapshot = Object.hasOwn(options, "backup");
  const readsDestination = Object.hasOwn(options, "dest");
  if (readsSnapshot === readsDestination) {
    fail("backup_invalid_arguments", "verify takes either --backup or --dest, and not both.");
  }
  if (readsDestination) return verifyFreshness(options, instant);

  const snapshot = requireAbsolutePath(options.backup, "--backup");
  const manifest = readManifest(snapshot);
  if (manifest === null) {
    fail(
      "backup_manifest_unreadable",
      `${snapshot} carries no readable manifest of this tool; it is not a snapshot it wrote.`,
    );
  }
  const state = { bytes: 0, entries: 0 };
  const observed = inventoryMembers(snapshot, state);
  const expected = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const seen = new Set();
  const mismatched = [];
  const unexpected = [];
  for (const entry of observed) {
    seen.add(entry.path);
    const known = expected.get(entry.path);
    if (known === undefined) {
      unexpected.push(entry.path);
      continue;
    }
    if (JSON.stringify(known) !== JSON.stringify(entry)) mismatched.push(entry.path);
  }
  const missing = manifest.files
    .map((entry) => entry.path)
    .filter((path) => !seen.has(path));
  const ok = mismatched.length === 0 && missing.length === 0 && unexpected.length === 0;
  return {
    status: ok ? "verified" : "mismatch",
    ok,
    snapshot,
    stamp: manifest.stamp,
    created_at: manifest.created_at,
    checked_at: instant.toISOString(),
    entry_count: observed.length,
    mismatched,
    missing,
    unexpected,
  };
}

function verifyFreshness(options, instant) {
  // Deliberately not `requireAbsolutePath`: a destination that does not exist is the extreme case
  // of the question this mode asks — are there backups — and reporting it as a bad argument would
  // hide the answer inside a usage error. It is also not created here, because a check that
  // creates what it is checking for can never report its absence twice.
  const destination = requirePath(options.dest, "--dest");
  const maxAgeHours = requireCount(
    requireOption(options, "max-age-hours"),
    "--max-age-hours",
    { min: 1, max: 8760 },
  );
  if (!existsSync(destination)) {
    return {
      status: "empty",
      ok: false,
      destination,
      checked_at: instant.toISOString(),
      max_age_hours: maxAgeHours,
      snapshot_count: 0,
      newest: null,
      age_hours: null,
      note: "the destination does not exist",
    };
  }
  const owned = ownedSnapshots(realpathSync(destination));
  const newest = owned[0] ?? null;
  const ageMs = newest === null
    ? null
    : instant.getTime() - new Date(newest.created_at).getTime();
  const ok = ageMs !== null && ageMs <= maxAgeHours * 3_600_000;
  return {
    status: ok ? "fresh" : (newest === null ? "empty" : "stale"),
    ok,
    destination,
    checked_at: instant.toISOString(),
    max_age_hours: maxAgeHours,
    snapshot_count: owned.length,
    newest: newest === null ? null : { stamp: newest.stamp, created_at: newest.created_at },
    age_hours: ageMs === null ? null : Math.round((ageMs / 3_600_000) * 100) / 100,
  };
}

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Emits the LaunchAgent; it never installs one. Creating standing configuration on a user's
 * machine is the user's action, and the plist is printed so it can be read before it is saved.
 *
 * launchd rather than cron for one measured reason: a calendar job missed while the machine slept
 * runs on wake, and cron simply skips it. The host is a laptop, so "skipped" would be the common
 * case. Both interpreter and script are absolute — a scheduled job inherits no useful PATH — which
 * makes a Node upgrade a two-place edit, named in the runbook and caught by the freshness check.
 *
 * `--script` is required and may name a file that does not exist yet. Both halves are deliberate.
 * The scheduled job's script path *is* its target now, so a defaulted one would quietly schedule
 * whichever copy rendered the plist — a copy that refuses itself every night and reports nothing
 * worth reading. And the operational copy arrives only with a cutover, so the command that renders
 * the plist has to be able to name a file that is not there yet; the report says when it is
 * missing rather than refusing. That relaxation is why the path is checked for being absolute
 * here: `resolve()` would otherwise turn a mistyped relative path into a plausible absolute one,
 * and the "missing file" line an operator is expecting before the cutover is exactly what would
 * make that typo look normal.
 */
export function printPlist(options, { nodePath }) {
  assertAllowed(options, ["dest", "hour", "minute", "script", "node"]);
  const destination = requireAbsolutePath(requireOption(options, "dest"), "--dest");
  const hour = "hour" in options ? requireCount(options.hour, "--hour", { min: 0, max: 23 }) : 11;
  const minute = "minute" in options
    ? requireCount(options.minute, "--minute", { min: 0, max: 59 })
    : 0;
  const script = requireAbsentablePath(requireOption(options, "script"), "--script");
  const node = "node" in options ? requireAbsolutePath(options.node, "--node") : nodePath;
  const logPath = join(destination, "backup.log");
  const argv = [node, script, "run", "--dest", destination];
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
      + '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(LAUNCH_AGENT_LABEL)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...argv.map((entry) => `    <string>${xmlEscape(entry)}</string>`),
    "  </array>",
    "  <key>StartCalendarInterval</key>",
    "  <dict>",
    "    <key>Hour</key>",
    `    <integer>${hour}</integer>`,
    "    <key>Minute</key>",
    `    <integer>${minute}</integer>`,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <false/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(logPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
  return {
    status: "rendered",
    label: LAUNCH_AGENT_LABEL,
    argv,
    log: logPath,
    // Reported rather than refused: before a cutover the operational copy is legitimately absent,
    // and an operator installing the agent then should see that fact stated instead of inferring
    // it from silence.
    script_present: existsSync(script),
    plist,
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  // Null-prototype: on a plain object
  // `--__proto__ x` assigns through an inherited setter and the unknown-option check never sees it.
  const options = Object.create(null);
  for (let index = 0; index < rest.length;) {
    const flag = rest[index];
    if (!flag?.startsWith("--")) {
      fail("backup_invalid_arguments", `Invalid argument near ${flag ?? "<end>"}`);
    }
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) {
      fail("backup_invalid_arguments", `Duplicate option: --${key}`);
    }
    if (BOOLEAN_FLAGS.includes(key)) {
      options[key] = true;
      index += 1;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("backup_invalid_arguments", `Missing value for --${key}`);
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
      "backup_invalid_arguments",
      `Unknown option(s): ${unknown.map((key) => `--${key}`).join(", ")}`,
    );
  }
}

function requireOption(options, key) {
  if (!Object.hasOwn(options, key)) {
    fail("backup_invalid_arguments", `Missing required option: --${key}`);
  }
  return options[key];
}

export function usage() {
  return `Usage:
  node tools/operational-backup.mjs run --dest <dir>
                                        [--keep ${DEFAULT_KEEP}] [--lock-timeout-ms ${DEFAULT_LOCK_TIMEOUT_MS}] [--now <iso>]
  node tools/operational-backup.mjs verify --backup <snapshot> [--now <iso>]
  node tools/operational-backup.mjs verify --dest <dir> --max-age-hours <n> [--now <iso>]
  node tools/operational-backup.mjs print-plist --script <path> --dest <dir>
                                        [--hour 11] [--minute 0] [--node <path>]

run backs up THE TREE THIS FILE LIVES IN, and no flag can point it elsewhere: which tree gets
copied is never a value anybody types. The tree is taken by its marker, an ops-manifest.json of
kind operational. It must also hold process-log.json,
so the integration tree, a task tree, a rehearsal tree and a rehearsal folder are all refused.

It copies process-log.json with output/ under the process log lock, and triage-ledger.json with
the recorded batches of triage-batches/ under the triage ledger lock. Then, under no lock,
telegram-sources.json, telegram-sweep-state.json, records/, outbox/ and
ops-manifest.json, each when present. A held lock, an unreadable ledger or a JSON member that does
not parse refuses the whole snapshot, and rotation runs only after one succeeds, so a refusing day
keeps the older copies instead of ageing one out. Rotation removes only dated directories carrying
this tool's own manifest, and nothing else in the destination, ever.

Not copied: output/<company-role>/.pipeline-tmp/ staging, the ledgers' lock and .tmp siblings,
process-log.backup-*.json, telegram-sweeps/, .ops-tree/, .pipeline-input/ and .rehearsal/.

verify --backup re-reads a snapshot against its own manifest. verify --dest --max-age-hours is the
liveness check: it fails when the newest snapshot is older than the given age.

print-plist writes nothing; it renders the LaunchAgent for review before you save it. --script is
required and names the copy the schedule should run, which is the copy inside the operational
checkout. It may name a file that does not exist yet -- before a cutover delivers the tool there,
it will not -- and the report says whether it is present.

The procedure, including the restore it is worth having, is docs/runbooks/operational-backup.md.
`;
}

const COMMANDS = Object.freeze({ "print-plist": printPlist, run, verify });

/**
 * The root this tool backs up: the checkout holding the running copy of this file, at
 * `<checkout>/tools/operational-backup.mjs`. Resolved through `realpathSync` so a symlinked entry
 * names the tree the file really lives in, and derived here rather than from `process.cwd()`
 * because a scheduled job's working directory belongs to the scheduler.
 */
export function rootOfThisTool(scriptPath = fileURLToPath(import.meta.url)) {
  return resolve(dirname(realpathSync(scriptPath)), "..");
}

export function runOperationalBackup(argv, {
  now = () => new Date(),
  nodePath = process.execPath,
  root = rootOfThisTool(),
} = {}) {
  const { command, options } = parseArgs(argv);
  if (!command || !Object.hasOwn(COMMANDS, command)) {
    fail("backup_unknown_command", `Unknown command: ${command ?? "<none>"}`);
  }
  return COMMANDS[command](options, { nodePath, now, root });
}

export function main(argv = process.argv.slice(2)) {
  try {
    if (argv[0] === "help" || argv[0] === "--help" || argv.length === 0) {
      console.log(usage());
      return;
    }
    const result = runOperationalBackup(argv);
    if (typeof result.plist === "string") {
      console.log(result.plist);
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({
      error: { code: reportedErrorCode(error), message: error?.message ?? "unknown error" },
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
