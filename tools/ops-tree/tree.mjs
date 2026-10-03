/**
 * Building, replacing and restoring the operational folder: `export`, `cutover`, `rollback`.
 *
 * `tools/ops-tree/README.md` owns the procedure and the codes; this header states the four
 * properties the code is built around.
 *
 * - **Nothing in the folder moves before the new pair has passed.** Both tags are exported into an
 *   image under `.ops-tree/staging/<stamp>/`, the dependencies are installed there, and the new
 *   engine's own checks run against the image and a copy of the state. Any refusal up to that
 *   point removes the image and leaves every file of the folder where it was.
 * - **The swap is a journal of renames, and every rename can be undone.** Old top-level entries go
 *   to `.ops-tree/previous/<stamp>/`, new ones come in from the image, pair by pair, with `tools/`
 *   and `package.json` last so the tool stays runnable from the root for as long as possible. The
 *   journal is written and synced before the first rename; an exception reverses it in the same
 *   process, and a process killed outright is reversed by `rollback` — run from the copy of the
 *   tool that the journal names when the root has no `tools/` left.
 * - **No argument names the folder a cutover changes.** It changes the folder its own code lives
 *   in. The one exception is `export`, whose folder does not exist yet, and the recovery copy,
 *   whose folder is derived from where it lies and accepted only when that folder's journal names
 *   the copy's stamp.
 * - **git is asked for bytes, never trusted with them.** Every export is compared with
 *   `git ls-tree` of the same commit, so an attribute that rewrote or dropped a file is a refusal
 *   rather than a quiet difference between the tag and the folder.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  linkSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname as osHostname, uptime as osUptime } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { withLogV3Lock } from "../lib/process-log-core.mjs";
import { validateProcessLogV3Deep } from "../lib/process-log-v3-lifecycle.mjs";
import { readSafeCliInput } from "../lib/safe-cli-input.mjs";
import {
  CANDIDATE_DIRECTORY_NAME,
  JOURNAL_FILE_NAME,
  MANIFEST_FILE_NAME,
  MANIFEST_SCHEMA,
  MANIFEST_SCHEMA_VERSION,
  OpsTreeError,
  SERVICE_DIRECTORY_NAME,
  compareFiles,
  digestTree,
  fail,
  journalPath,
  parseManifest,
  readManifest,
  serializeManifest,
  sha256Hex,
  writeFileAtomic,
  zoneOf,
  zoneTableFor,
} from "./manifest.mjs";

export const RELEASE_TAG_PATTERN = /^release-\d{8}(?:\.\d+)?$/;
export const CANDIDATE_TAG_PATTERN = /^candidate-\d{8}(?:\.\d+)?$/;
export const STAMP_PATTERN = /^\d{8}T\d{6}\.\d{3}Z$/;
export const JOURNAL_SCHEMA = "job-search-pipeline/ops-tree-journal";
export const JOURNAL_SCHEMA_VERSION = 1;
export const RETAINED_TREES = 3;
/** A step started less than this long ago is taken to be running; an older one is reported. */
export const RUNNING_WINDOW_MS = 24 * 60 * 60 * 1000;
export const LAST_ENTRIES = Object.freeze(["package.json", "tools"]);

const STAGING_DIRECTORY_NAME = "staging";
const PREVIOUS_DIRECTORY_NAME = "previous";
const CUTOVERS_DIRECTORY_NAME = "cutovers";
const LOCK_FILE_NAME = "lock";
const LEDGER_FILE_NAME = "process-log.json";
const OUTPUT_DIRECTORY_NAME = "output";
const TRIAGE_LOCK_NAME = "triage-ledger.json.lock";
const GIT_MAX_BUFFER = 512 * 1024 * 1024;

export const OVERRIDE_SCHEMAS = Object.freeze({
  cutover: Object.freeze({ required: ["overrideReason"], optional: [] }),
  rollback: Object.freeze({ required: ["overrideReason"], optional: [] }),
});

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/** Every environment variable a child of this tool must not inherit. */
function childEnvironment(extra = {}) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("GIT_") || key.startsWith("JOB_PIPELINE_")) continue;
    environment[key] = value;
  }
  return { ...environment, ...extra };
}

function defaultInstall(directory) {
  const result = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: directory,
    encoding: "utf8",
    env: childEnvironment(),
    shell: false,
  });
  if (result.error || result.status !== 0) {
    fail(
      "ops_tree_install_failed",
      `npm ci failed in ${directory}: ${lastLine(result.stderr) || result.error?.code || "unknown"}`,
    );
  }
}

export function defaultContext() {
  return {
    bootTime: () => Date.now() - osUptime() * 1000,
    beforeRename: null,
    hostname: () => osHostname(),
    install: defaultInstall,
    node: process.execPath,
    now: () => new Date(),
    processAlive: defaultProcessAlive,
    spawn: spawnSync,
  };
}

function withDefaults(context) {
  return { ...defaultContext(), ...(context ?? {}) };
}

function lastLine(text) {
  return (
    String(text ?? "")
      .trim()
      .split("\n")
      .pop()
      ?.slice(0, 300) ?? ""
  );
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function lexists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isRealDirectory(path) {
  try {
    const stats = lstatSync(path);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function syncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // A directory that cannot be synced on this platform is still written; nothing to recover.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeSyncedFile(path, text, mode = 0o644) {
  const descriptor = openSync(path, "wx", mode);
  try {
    writeSync(descriptor, text);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  syncDirectory(dirname(path));
}

export function stampFor(date) {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}.${iso.slice(20, 23)}Z`;
}

function serviceDirectory(root) {
  return join(root, SERVICE_DIRECTORY_NAME);
}

function stagingRoot(root) {
  return join(serviceDirectory(root), STAGING_DIRECTORY_NAME);
}

function previousRoot(root) {
  return join(serviceDirectory(root), PREVIOUS_DIRECTORY_NAME);
}

// ---------------------------------------------------------------------------------------------
// git

function runGit(context, repository, args) {
  const result = context.spawn(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.autocrlf=false",
      "--no-pager",
      "-C",
      repository,
      ...args,
    ],
    {
      encoding: "buffer",
      env: childEnvironment(),
      maxBuffer: GIT_MAX_BUFFER,
      shell: false,
    },
  );
  if (result.error || result.signal) {
    fail(
      "ops_tree_git_failed",
      `git ${args[0]} could not run (${result.error?.code ?? result.signal})`,
    );
  }
  return result;
}

function gitText(context, repository, args, code, message) {
  const result = runGit(context, repository, args);
  if (result.status !== 0) fail(code, message);
  return result.stdout.toString("utf8").trim();
}

function requireRepository(path, flag) {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    fail("ops_tree_invalid_arguments", `${flag} takes an absolute path`);
  }
  if (!isRealDirectory(path))
    fail("ops_tree_repository_missing", `${flag} is not a directory: ${path}`);
  return realpathSync(path);
}

/** The commit and tree a tag names, refused unless the name has the expected shape and is a tag. */
export function resolveTag(context, repository, tag, pattern, flag) {
  if (typeof tag !== "string" || !pattern.test(tag)) {
    fail("ops_tree_invalid_tag", `${flag} must look like ${pattern.source}`);
  }
  const commit = gitText(
    context,
    repository,
    ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`],
    "ops_tree_tag_missing",
    `${tag} is not a tag of ${repository}`,
  );
  const tree = gitText(
    context,
    repository,
    ["rev-parse", "--verify", "--quiet", `${commit}^{tree}`],
    "ops_tree_tag_missing",
    `${tag} has no tree in ${repository}`,
  );
  const format =
    gitText(
      context,
      repository,
      ["rev-parse", "--show-object-format"],
      "ops_tree_git_failed",
      `git could not name the object format of ${repository}`,
    ) || "sha1";
  return { commit, format, repository, tag, tree };
}

function listTree(context, pin) {
  const result = runGit(context, pin.repository, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    pin.commit,
  ]);
  if (result.status !== 0) fail("ops_tree_git_failed", `git ls-tree failed for ${pin.tag}`);
  const entries = [];
  for (const record of result.stdout.toString("utf8").split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode, type, id] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (type !== "blob") {
      fail(
        "ops_tree_export_mismatch",
        `${pin.tag} carries a ${type} at ${path}; only files are exported`,
      );
    }
    entries.push({ id, mode, path });
  }
  return entries;
}

function gitObjectId(format, bytes) {
  return createHash(format === "sha256" ? "sha256" : "sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");
}

/** What was extracted, in the terms `git ls-tree` uses: mode and object id per path. */
function extractedEntries(directory, format) {
  const entries = new Map();
  const walk = (relativeDirectory) => {
    const absolute = relativeDirectory === "" ? directory : join(directory, relativeDirectory);
    for (const name of readdirSync(absolute).sort()) {
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const path = join(absolute, name);
      const stats = lstatSync(path);
      if (stats.isDirectory()) {
        walk(relativePath);
      } else if (stats.isSymbolicLink()) {
        entries.set(relativePath, {
          id: gitObjectId(format, Buffer.from(readlinkSync(path))),
          mode: "120000",
        });
      } else if (stats.isFile()) {
        const mode = (stats.mode & 0o100) !== 0 ? "100755" : "100644";
        entries.set(relativePath, { id: gitObjectId(format, readFileSync(path)), mode });
      } else {
        entries.set(relativePath, { id: "", mode: "other" });
      }
    }
  };
  walk("");
  return entries;
}

function topSegment(path) {
  return path.split("/")[0];
}

/**
 * Exports one tag into `destination`, drops the excluded top-level paths, and proves the result
 * equals `git ls-tree` of the commit minus the same paths. Returns the tracked paths.
 */
export function exportTag(context, pin, destination, excludes = []) {
  mkdirSync(destination, { recursive: true });
  const archive = `${destination}.tar`;
  const archived = runGit(context, pin.repository, [
    "archive",
    "--format=tar",
    "-o",
    archive,
    pin.commit,
  ]);
  if (archived.status !== 0) fail("ops_tree_git_failed", `git archive failed for ${pin.tag}`);
  const extracted = context.spawn("tar", ["-xf", archive, "-C", destination], {
    encoding: "utf8",
    env: childEnvironment(),
    shell: false,
  });
  rmSync(archive, { force: true });
  if (extracted.error || extracted.status !== 0) {
    fail(
      "ops_tree_extract_failed",
      `tar could not extract ${pin.tag}: ${lastLine(extracted.stderr)}`,
    );
  }
  for (const name of excludes) rmSync(join(destination, name), { force: true, recursive: true });

  const expected = listTree(context, pin).filter(
    (entry) => !excludes.includes(topSegment(entry.path)),
  );
  const observed = extractedEntries(destination, pin.format);
  const expectedPaths = new Set(expected.map((entry) => entry.path));
  for (const entry of expected) {
    const actual = observed.get(entry.path);
    if (!actual)
      fail("ops_tree_export_mismatch", `${pin.tag}: ${entry.path} is tracked but was not exported`);
    const mode = entry.mode === "100755" ? "100755" : entry.mode === "120000" ? "120000" : "100644";
    if (actual.mode !== mode || actual.id !== entry.id) {
      fail("ops_tree_export_mismatch", `${pin.tag}: ${entry.path} differs from the tagged blob`);
    }
  }
  for (const path of observed.keys()) {
    if (!expectedPaths.has(path))
      fail("ops_tree_export_mismatch", `${pin.tag}: ${path} is not tracked by the tag`);
  }
  return [...expectedPaths].sort();
}

// ---------------------------------------------------------------------------------------------
// the image

function requireZone(zones, path, expected, tag) {
  const zone = zoneOf(zones, path);
  if (zone !== expected) {
    fail(
      "ops_tree_image_overlaps_state",
      `${tag} carries ${path}, which the zone table reads as ${zone}, not ${expected}`,
    );
  }
}

function lockfileNamesPackages(path) {
  try {
    const lock = JSON.parse(readFileSync(path, "utf8"));
    return Object.keys(lock?.packages ?? {}).some((key) => key !== "");
  } catch {
    fail("ops_tree_install_failed", `${path} is not a readable lockfile`);
  }
}

/**
 * Exports both tags into `image`, installs dependencies, and returns the manifest the image would
 * carry. The manifest is also written into the image, so the new engine's preflight checks the
 * image exactly as it will later check the folder.
 */
export function buildImage(context, { candidatePin, enginePin, image, kind, previous }) {
  const zones = zoneTableFor(kind);
  const enginePaths = exportTag(context, enginePin, image);
  for (const path of enginePaths) requireZone(zones, path, "engine", enginePin.tag);
  const candidatePaths = exportTag(
    context,
    candidatePin,
    join(image, CANDIDATE_DIRECTORY_NAME),
    zones.candidateExcludes,
  );
  for (const path of candidatePaths) {
    requireZone(zones, `${CANDIDATE_DIRECTORY_NAME}/${path}`, "candidate", candidatePin.tag);
  }
  for (const path of enginePaths) {
    if (path.split("/").pop() !== "package-lock.json") continue;
    if (lockfileNamesPackages(join(image, path))) context.install(dirname(join(image, path)));
  }
  const manifest = {
    schema: MANIFEST_SCHEMA,
    schema_version: MANIFEST_SCHEMA_VERSION,
    kind,
    state: "ready",
    built_at: context.now().toISOString(),
    previous,
    engine: pinRecord(enginePin),
    candidate: pinRecord(candidatePin),
    zones,
    files: digestTree(image, zones),
  };
  writeFileAtomic(join(image, MANIFEST_FILE_NAME), serializeManifest(manifest));
  return manifest;
}

function pinRecord(pin) {
  return { commit: pin.commit, repository: pin.repository, tag: pin.tag, tree: pin.tree };
}

/** Runs one script of the image's engine against the image, with a clean environment. */
function runImageScript(context, image, script, args) {
  const imageRoot = realpathSync(image);
  return context.spawn(context.node, [join(imageRoot, script), ...args], {
    cwd: imageRoot,
    encoding: "utf8",
    env: childEnvironment({ JOB_PIPELINE_WORKSPACE_ROOT: imageRoot }),
    shell: false,
  });
}

function childErrorCode(result) {
  for (const stream of [result.stderr, result.stdout]) {
    try {
      const parsed = JSON.parse(String(stream ?? "").trim());
      if (typeof parsed?.error?.code === "string") return parsed.error.code;
    } catch {
      // not a JSON report; fall through
    }
  }
  return result.error?.code ?? `exit ${result.status}`;
}

/** The new engine's own verdict on the new layer (and, with a ledger, on its toolchain too). */
function checkPair(context, image, { withLedger }) {
  const script = withLedger ? "tools/bootstrap.mjs" : "tools/candidate/cli.mjs";
  const result = runImageScript(context, image, script, ["--check"]);
  if (result.error || result.status !== 0) {
    fail(
      "ops_tree_pair_check_failed",
      `the new engine refused the new pair in the image: ${script} --check answered ${childErrorCode(result)}`,
    );
  }
}

function newEngineDeepReport(context, image) {
  const result = runImageScript(context, image, "tools/process-log.mjs", ["validate", "--deep"]);
  if (result.error || (result.status !== 0 && result.status !== 2)) {
    fail(
      "cutover_ledger_unreadable",
      `the new engine could not read the process log: ${childErrorCode(result)}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail("cutover_ledger_unreadable", "the new engine's validate --deep printed no report");
  }
}

function issueKeys(report) {
  const keys = new Map();
  for (const entry of report?.processes ?? []) {
    const set = new Set();
    if (entry.output?.code) set.add(`output:${entry.output.code}`);
    if (entry.staging?.health === "attention") set.add("staging:attention");
    for (const step of entry.steps ?? []) {
      for (const issue of step.issues ?? []) set.add(`${step.name}:${issue}`);
    }
    keys.set(entry.process_id, set);
  }
  return keys;
}

/** What the new engine reports that the current one does not: the processes the swap will stop. */
export function newlyReported(baseline, predicted) {
  const before = issueKeys(baseline);
  const after = issueKeys(predicted);
  const rows = [];
  for (const [processId, issues] of after) {
    const known = before.get(processId) ?? new Set();
    const added = [...issues].filter((issue) => !known.has(issue)).sort();
    if (added.length > 0) rows.push({ issues: added, process_id: processId });
  }
  return rows.sort((left, right) => left.process_id.localeCompare(right.process_id));
}

/**
 * Copies the ledger and `output/` into the image under the ledger's own lock, then reads the
 * current engine's deep report of the live folder. The report takes that lock itself, so the two
 * cannot share one hold; the ledger's digest proves both saw the same bytes, with one retry.
 */
function copyStateAndBaseline(root, image) {
  const logPath = join(root, LEDGER_FILE_NAME);
  const outputPath = join(root, OUTPUT_DIRECTORY_NAME);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    rmSync(join(image, LEDGER_FILE_NAME), { force: true });
    rmSync(join(image, OUTPUT_DIRECTORY_NAME), { force: true, recursive: true });
    const copied = withLogV3Lock(logPath, () => {
      copyFileSync(logPath, join(image, LEDGER_FILE_NAME));
      if (existsSync(outputPath)) {
        cpSync(outputPath, join(image, OUTPUT_DIRECTORY_NAME), {
          errorOnExist: true,
          force: false,
          recursive: true,
          verbatimSymlinks: true,
        });
      } else {
        mkdirSync(join(image, OUTPUT_DIRECTORY_NAME));
      }
      return sha256Hex(readFileSync(join(image, LEDGER_FILE_NAME)));
    });
    const baseline = validateProcessLogV3Deep(logPath, {
      outputRoot: outputPath,
      workspaceRoot: root,
    });
    if (sha256Hex(readFileSync(logPath)) === copied) return baseline;
  }
  fail(
    "cutover_ledger_moving",
    "the process log changed while the cutover copied it, twice; retry when no session writes",
  );
}

// ---------------------------------------------------------------------------------------------
// gates and the override

export function readGates(context, root) {
  const now = context.now().getTime();
  const gates = { prepared: [], running: [], stale: [], triage_locked: false };
  const logPath = join(root, LEDGER_FILE_NAME);
  if (existsSync(logPath)) {
    withLogV3Lock(logPath, ({ log }) => {
      for (const record of log.processes) {
        if (!record.steps) continue;
        for (const [name, step] of Object.entries(record.steps)) {
          if (step.publication_transaction) {
            gates.prepared.push({
              process_id: record.id,
              publication_id: step.publication_transaction.id,
              step: name,
            });
          } else if (step.active_attempt) {
            const startedAt = step.active_attempt.started_at;
            const age = now - Date.parse(startedAt);
            const row = { process_id: record.id, started_at: startedAt, step: name };
            if (Number.isFinite(age) && age < RUNNING_WINDOW_MS) gates.running.push(row);
            else gates.stale.push(row);
          }
        }
      }
    });
  }
  gates.triage_locked = existsSync(join(root, TRIAGE_LOCK_NAME));
  return gates;
}

function gateRefusals(gates) {
  const refusals = [];
  if (gates.running.length > 0) {
    refusals.push({
      code: "cutover_step_running",
      message:
        `${gates.running.length} step(s) started less than 24 hours ago: ` +
        gates.running.map((row) => `${row.process_id} ${row.step}`).join(", "),
    });
  }
  if (gates.prepared.length > 0) {
    refusals.push({
      code: "cutover_publication_prepared",
      message:
        `${gates.prepared.length} publication(s) were prepared and not finished; finish each with ` +
        "node tools/process-log.mjs reconcile-step before the cutover: " +
        gates.prepared
          .map((row) => `${row.process_id} ${row.step} ${row.publication_id}`)
          .join(", "),
    });
  }
  if (gates.triage_locked) {
    refusals.push({
      code: "cutover_triage_locked",
      message: `${TRIAGE_LOCK_NAME} exists: a triage batch is being recorded, or a dead run left the lock`,
    });
  }
  return refusals;
}

function readOverride(root, command, inputFile) {
  if (inputFile === undefined) return null;
  const input = readSafeCliInput({
    basename: inputFile,
    command,
    inputRoot: join(root, ".pipeline-input"),
    schemas: OVERRIDE_SCHEMAS,
  });
  const reason = input.values.overrideReason.trim();
  if (reason.length === 0) fail("ops_tree_invalid_arguments", "overrideReason must not be empty");
  return reason;
}

function applyGates(gates, override) {
  const refusals = gateRefusals(gates);
  if (refusals.length > 0 && override === null) {
    fail(refusals[0].code, refusals.map((refusal) => refusal.message).join("; "), { refusals });
  }
  return refusals;
}

// ---------------------------------------------------------------------------------------------
// the lock

function lockPath(root) {
  return join(serviceDirectory(root), LOCK_FILE_NAME);
}

/**
 * Takes `.ops-tree/lock`. A lock of this machine whose process is gone, or which is older than the
 * last boot, was abandoned: it is moved aside under a unique name — of two takers only one move
 * succeeds — checked against the bytes that were read, and the lock is created afresh.
 */
export function acquireLock(context, root) {
  mkdirSync(serviceDirectory(root), { recursive: true });
  const path = lockPath(root);
  const token = randomBytes(16).toString("hex");
  const body = `${JSON.stringify({
    acquired_at: context.now().toISOString(),
    hostname: context.hostname(),
    pid: process.pid,
    token,
  })}\n`;
  const create = () => {
    try {
      writeSyncedFile(path, body, 0o600);
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      throw error;
    }
  };
  if (create()) return { takeover: null, token };

  let observed;
  try {
    observed = readFileSync(path);
  } catch (error) {
    if (error?.code === "ENOENT" && create()) return { takeover: null, token };
    fail("ops_tree_locked", "another ops-tree run holds the folder's lock");
  }
  let owner = null;
  try {
    owner = JSON.parse(observed.toString("utf8"));
  } catch {
    owner = null;
  }
  const manual = `check that no ops-tree run is alive, then remove ${SERVICE_DIRECTORY_NAME}/${LOCK_FILE_NAME}`;
  if (owner === null || typeof owner.pid !== "number" || typeof owner.hostname !== "string") {
    fail("ops_tree_locked", `the folder's lock is unreadable; ${manual}`);
  }
  if (owner.hostname !== context.hostname()) {
    fail(
      "ops_tree_locked",
      `the folder's lock belongs to another machine (${owner.hostname}); ${manual}`,
    );
  }
  const acquiredAt = Date.parse(owner.acquired_at);
  const abandoned =
    !context.processAlive(owner.pid) ||
    (Number.isFinite(acquiredAt) && acquiredAt < context.bootTime());
  if (!abandoned) {
    fail(
      "ops_tree_locked",
      `process ${owner.pid} holds the folder's lock; if ps -p ${owner.pid} is not ops-tree, ${manual}`,
    );
  }
  const aside = `${path}.stale-${token}`;
  context.beforeLockTakeover?.();
  try {
    renameSync(path, aside);
  } catch (error) {
    if (error?.code === "ENOENT")
      fail("ops_tree_locked", "another run took over the abandoned lock first");
    throw error;
  }
  const moved = readFileSync(aside);
  if (!moved.equals(observed)) {
    // What was moved is somebody's live lock, taken between the read and the move. It goes back
    // without overwriting anything; if a third lock appeared meanwhile, the moved one stays aside.
    try {
      linkSync(aside, path);
    } catch {
      fail(
        "ops_tree_locked",
        `the lock changed while it was taken over; it is kept at ${relative(root, aside)}`,
      );
    }
    rmSync(aside, { force: true });
    fail("ops_tree_locked", "another run took over the abandoned lock first");
  }
  unlinkSync(aside);
  if (!create())
    fail("ops_tree_locked", "another run took the lock while the abandoned one was cleared");
  return { takeover: { acquired_at: owner.acquired_at, pid: owner.pid }, token };
}

export function releaseLock(root, lock) {
  const path = lockPath(root);
  try {
    const owner = JSON.parse(readFileSync(path, "utf8"));
    if (owner?.token === lock.token) unlinkSync(path);
  } catch {
    // The lock is gone or is not ours; either way it is not ours to remove.
  }
}

// ---------------------------------------------------------------------------------------------
// the swap and its journal

function topLevelNames(directory) {
  return isRealDirectory(directory) ? readdirSync(directory).sort() : [];
}

function swappable(zones, name) {
  const zone = zoneOf(zones, name);
  return zone === "engine" || zone === "candidate";
}

function orderedNames(names) {
  const first = names.filter((name) => !LAST_ENTRIES.includes(name)).sort();
  return [...first, ...LAST_ENTRIES.filter((name) => names.includes(name))];
}

/**
 * The renames of one swap, relative to the root: the state children inside swapped directories go
 * into the image first (so they come back last), then every swapped entry pairwise — old out, new
 * in — with `tools/` and `package.json` last.
 */
function planPairs(root, { image, liveZones, imageZones, target }) {
  const imageRelative = toPosix(relative(root, image));
  const targetRelative = toPosix(relative(root, target));
  const pairs = [];
  const nested = [...new Set([...liveZones.stateNested, ...imageZones.stateNested])].sort();
  for (const child of nested) {
    if (!lexists(join(root, child))) continue;
    if (!swappable(liveZones, topSegment(child))) continue;
    if (lexists(join(image, child))) {
      fail("ops_tree_image_overlaps_state", `the incoming tree already holds ${child}`);
    }
    mkdirSync(dirname(join(image, child)), { recursive: true });
    pairs.push({ from: child, to: `${imageRelative}/${child}` });
  }
  const names = new Set();
  for (const name of topLevelNames(root)) if (swappable(liveZones, name)) names.add(name);
  for (const name of topLevelNames(image)) {
    if (!swappable(imageZones, name)) continue;
    const liveZone = zoneOf(liveZones, name);
    if (liveZone !== "engine" && liveZone !== "candidate") {
      fail(
        "ops_tree_image_overlaps_state",
        `the incoming ${name} is ${liveZone} in the live folder`,
      );
    }
    names.add(name);
  }
  for (const name of orderedNames([...names])) {
    if (lexists(join(root, name))) pairs.push({ from: name, to: `${targetRelative}/${name}` });
    if (lexists(join(image, name))) pairs.push({ from: `${imageRelative}/${name}`, to: name });
  }
  return pairs;
}

function readJournal(root) {
  let journal;
  try {
    journal = JSON.parse(readFileSync(journalPath(root), "utf8"));
  } catch {
    fail(
      "ops_tree_journal_unknown",
      `${SERVICE_DIRECTORY_NAME}/${JOURNAL_FILE_NAME} is not readable`,
    );
  }
  const pairs = Array.isArray(journal?.pairs) ? journal.pairs : [];
  if (journal?.schema !== JOURNAL_SCHEMA || journal?.schema_version !== JOURNAL_SCHEMA_VERSION) {
    const manual = [...pairs].reverse().map((pair) => `mv ${pair.to} ${pair.from}`);
    fail(
      "ops_tree_journal_unknown",
      "the swap journal has a schema this engine does not know; reverse it by hand, from the folder root, in this order",
      { manual },
    );
  }
  return journal;
}

function safeRelative(root, path) {
  if (typeof path !== "string" || isAbsolute(path) || path.split("/").includes("..")) {
    fail("ops_tree_journal_unknown", "the swap journal names a path outside the folder");
  }
  return join(root, path);
}

/** Reverses a journal, idempotently: a pair is undone only when its move is observably done. */
export function reverseJournal(root, journal) {
  for (const pair of [...journal.pairs].reverse()) {
    const from = safeRelative(root, pair.from);
    const to = safeRelative(root, pair.to);
    if (lexists(to) && !lexists(from)) renameSync(to, from);
  }
  const target = safeRelative(root, journal.target);
  const savedManifest = join(target, MANIFEST_FILE_NAME);
  if (lexists(savedManifest)) {
    writeFileAtomic(join(root, MANIFEST_FILE_NAME), readFileSync(savedManifest, "utf8"));
    if (journal.operation === "cutover") {
      rmSync(savedManifest, { force: true });
      try {
        rmdirSync(target);
      } catch {
        // Something else is still in the retained directory; it is kept and reported by verify.
      }
    }
  }
  if (journal.operation === "rollback") {
    rmSync(join(safeRelative(root, journal.target), MANIFEST_FILE_NAME), { force: true });
    try {
      rmdirSync(safeRelative(root, journal.target));
    } catch {
      // kept, as above
    }
  }
  let keptImage = null;
  if (journal.operation === "cutover") {
    const image = safeRelative(root, journal.image);
    const zones = readManifest(root)?.zones;
    const offending = zones ? stagingOffenders(image, zones) : ["an unreadable zone table"];
    if (offending.length === 0) rmSync(image, { force: true, recursive: true });
    else keptImage = { image: journal.image, holds: offending };
  }
  rmSync(journalPath(root), { force: true });
  syncDirectory(serviceDirectory(root));
  return keptImage;
}

/**
 * The swap itself. SIGINT, SIGTERM and SIGHUP are ignored for its duration: a signal that arrives
 * mid-swap is dropped and the run completes, so an interruption by signal leaves a whole folder,
 * never half of one. Only SIGKILL and power loss can stop it midway, and `rollback` owns those.
 */
function swap(
  context,
  root,
  { image, liveManifest, newManifest, operation, progress, stamp, target },
) {
  const pairs = planPairs(root, {
    image,
    imageZones: newManifest.zones,
    liveZones: liveManifest.zones,
    target,
  });
  const journal = {
    schema: JOURNAL_SCHEMA,
    schema_version: JOURNAL_SCHEMA_VERSION,
    operation,
    stamp,
    image: toPosix(relative(root, image)),
    target: toPosix(relative(root, target)),
    pairs,
  };
  mkdirSync(target, { recursive: false });
  try {
    writeSyncedFile(join(target, MANIFEST_FILE_NAME), serializeManifest(liveManifest));
    writeSyncedFile(journalPath(root), serializeManifest(journal));
    if (progress) progress.journaled = true;
  } catch (error) {
    if (!existsSync(journalPath(root))) rmSync(target, { force: true, recursive: true });
    throw error;
  }
  writeFileAtomic(
    join(root, MANIFEST_FILE_NAME),
    serializeManifest({ ...liveManifest, state: "building" }),
  );

  const held = [];
  const hold = () => {};
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, hold);
    held.push(signal);
  }
  try {
    try {
      pairs.forEach((pair, index) => {
        context.beforeRename?.(index, pair);
        renameSync(join(root, pair.from), join(root, pair.to));
      });
    } catch (error) {
      const keptImage = reverseJournal(root, journal);
      if (keptImage !== null && error !== null && typeof error === "object") {
        error.details = { ...(error.details ?? {}), kept_image: keptImage };
      }
      throw error;
    }
    writeFileAtomic(join(root, MANIFEST_FILE_NAME), serializeManifest(newManifest));
    rmSync(journalPath(root), { force: true });
    syncDirectory(serviceDirectory(root));
  } finally {
    for (const signal of held) process.removeListener(signal, hold);
  }
  return pairs;
}

// ---------------------------------------------------------------------------------------------
// retained trees

/** Keeps the newest retained trees; an older one is removed only if it still matches itself. */
export function pruneRetained(root, keep = RETAINED_TREES) {
  const directory = previousRoot(root);
  const stamps = topLevelNames(directory).filter(
    (name) => STAMP_PATTERN.test(name) && isRealDirectory(join(directory, name)),
  );
  const removed = [];
  const kept = [];
  for (const stamp of stamps.slice(0, Math.max(0, stamps.length - keep))) {
    const tree = join(directory, stamp);
    const manifest = parseManifest(readSafely(join(tree, MANIFEST_FILE_NAME)));
    if (
      manifest !== null &&
      compareFiles(manifest.files, digestTree(tree, manifest.zones)).length === 0
    ) {
      rmSync(tree, { force: true, recursive: true });
      removed.push(stamp);
    } else {
      kept.push(stamp);
    }
  }
  return { kept_unmatched: kept, removed };
}

function readSafely(path) {
  try {
    const stats = lstatSync(path);
    return stats.isFile() ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------------------------
// staging leftovers

/**
 * The state an image still holds beyond the copies of the ledger and `output/`: a state child that
 * a reversal could not move back because the folder already had a new one.
 */
function stagingOffenders(image, zones) {
  const offending = [];
  for (const entry of topLevelNames(image)) {
    if (zoneOf(zones, entry) !== "state") continue;
    if (entry.startsWith(LEDGER_FILE_NAME) || entry === OUTPUT_DIRECTORY_NAME) continue;
    offending.push(entry);
  }
  for (const nested of zones.stateNested) if (lexists(join(image, nested))) offending.push(nested);
  return offending;
}

/**
 * Removes images of earlier interrupted runs. A leftover may hold the copy of the ledger (with its
 * lock and temporary siblings) and of `output/`; one that holds any other state was never finished
 * by a journal reversal and is refused, not deleted.
 */
function clearStaging(root, zones) {
  const directory = stagingRoot(root);
  for (const name of topLevelNames(directory)) {
    const leftover = join(directory, name);
    if (!isRealDirectory(leftover)) {
      rmSync(leftover, { force: true });
      continue;
    }
    const offending = stagingOffenders(leftover, zones);
    if (offending.length > 0) {
      fail(
        "ops_tree_staging_holds_state",
        `${SERVICE_DIRECTORY_NAME}/${STAGING_DIRECTORY_NAME}/${name} holds ${offending.join(", ")}; move each back into the folder, then delete that directory`,
      );
    }
    rmSync(leftover, { force: true, recursive: true });
  }
}

// ---------------------------------------------------------------------------------------------
// commands

function requireNoRepositoryAround(root) {
  let current = root;
  for (;;) {
    if (lexists(join(current, ".git"))) {
      fail(
        "ops_tree_root_inside_repository",
        `${root} is inside a git repository (${join(current, ".git")})`,
      );
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function writeEvidence(root, stamp, evidence) {
  const directory = join(serviceDirectory(root), CUTOVERS_DIRECTORY_NAME);
  mkdirSync(directory, { recursive: true });
  writeFileAtomic(join(directory, `${stamp}.json`), serializeManifest(evidence));
}

/** Builds a new folder at `root` from two tags. `root` must not exist or be empty. */
export function exportFolder(input, suppliedContext) {
  const context = withDefaults(suppliedContext);
  const kind = input.kind ?? "operational";
  if (typeof input.root !== "string" || !isAbsolute(input.root)) {
    fail("ops_tree_invalid_arguments", "--root takes an absolute path");
  }
  const enginePin = resolveTag(
    context,
    requireRepository(input.engineRepo, "--engine-repo"),
    input.release,
    RELEASE_TAG_PATTERN,
    "--release",
  );
  const candidatePin = resolveTag(
    context,
    requireRepository(input.candidateRepo, "--candidate-repo"),
    input.candidate,
    CANDIDATE_TAG_PATTERN,
    "--candidate",
  );
  if (lexists(input.root)) {
    if (!isRealDirectory(input.root) || readdirSync(input.root).length > 0) {
      fail("ops_tree_root_not_empty", `${input.root} exists and is not an empty directory`);
    }
    requireNoRepositoryAround(realpathSync(input.root));
  } else {
    requireNoRepositoryAround(resolve(input.root));
    mkdirSync(input.root, { recursive: true });
  }
  const root = realpathSync(input.root);
  const stamp = stampFor(context.now());
  const image = join(stagingRoot(root), stamp);
  mkdirSync(stagingRoot(root), { recursive: true });
  let manifest;
  try {
    manifest = buildImage(context, { candidatePin, enginePin, image, kind, previous: null });
    checkPair(context, image, { withLedger: false });
  } catch (error) {
    rmSync(image, { force: true, recursive: true });
    throw error;
  }
  for (const name of topLevelNames(image)) {
    if (name === MANIFEST_FILE_NAME) continue;
    renameSync(join(image, name), join(root, name));
  }
  writeFileAtomic(join(root, MANIFEST_FILE_NAME), serializeManifest(manifest));
  rmSync(image, { force: true, recursive: true });
  return {
    status: "exported",
    candidate: manifest.candidate,
    engine: manifest.engine,
    files: Object.fromEntries(
      Object.entries(manifest.files).map(([zone, files]) => [zone, Object.keys(files).length]),
    ),
    kind,
    root,
  };
}

function requireReadyFolder(root) {
  const manifest = readManifest(root);
  if (manifest === null)
    fail(
      "ops_manifest_missing",
      `${root} is not an operational folder: it has no ${MANIFEST_FILE_NAME}`,
    );
  if (existsSync(journalPath(root)) || manifest.state !== "ready") {
    fail(
      "ops_tree_building",
      "a cutover or rollback of this folder did not finish; complete it with node tools/ops-tree/cli.mjs rollback",
    );
  }
  return manifest;
}

/**
 * Replaces the engine and candidate zones of the folder at `root` with a new pair of tags. With
 * `dryRun` it stops after the pair check and reports what the swap would do.
 */
export function cutoverFolder(input, suppliedContext) {
  const context = withDefaults(suppliedContext);
  const root = realpathSync(input.root);
  const lock = acquireLock(context, root);
  let image = null;
  const progress = { journaled: false };
  try {
    const liveManifest = requireReadyFolder(root);
    clearStaging(root, liveManifest.zones);
    const drift = compareFiles(liveManifest.files, digestTree(root, liveManifest.zones));
    const override = readOverride(root, "cutover", input.inputFile);
    const gates = readGates(context, root);
    const lifted = applyGates(gates, override);

    const enginePin = resolveTag(
      context,
      requireRepository(input.engineRepo ?? liveManifest.engine.repository, "--engine-repo"),
      input.release,
      RELEASE_TAG_PATTERN,
      "--release",
    );
    const candidatePin = resolveTag(
      context,
      requireRepository(
        input.candidateRepo ?? liveManifest.candidate.repository,
        "--candidate-repo",
      ),
      input.candidate,
      CANDIDATE_TAG_PATTERN,
      "--candidate",
    );
    const stamp = stampFor(context.now());
    image = join(stagingRoot(root), stamp);
    mkdirSync(stagingRoot(root), { recursive: true });
    const newManifest = buildImage(context, {
      candidatePin,
      enginePin,
      image,
      kind: liveManifest.kind,
      previous: stamp,
    });
    const withLedger = existsSync(join(root, LEDGER_FILE_NAME));
    let baseline = null;
    let predicted = null;
    if (withLedger) baseline = copyStateAndBaseline(root, image);
    checkPair(context, image, { withLedger });
    if (withLedger) predicted = newEngineDeepReport(context, image);

    const report = {
      candidate: { from: liveManifest.candidate.tag, to: candidatePin.tag },
      drift,
      engine: { from: liveManifest.engine.tag, to: enginePin.tag },
      gates,
      lock_takeover: lock.takeover,
      override:
        override === null
          ? null
          : { lifted: lifted.map((refusal) => refusal.code), reason: override },
      stopped_by_swap: withLedger ? newlyReported(baseline, predicted) : [],
    };
    if (input.dryRun) {
      rmSync(image, { force: true, recursive: true });
      image = null;
      return { status: "dry_run", ...report };
    }

    const target = join(previousRoot(root), stamp);
    mkdirSync(previousRoot(root), { recursive: true });
    swap(context, root, {
      image,
      liveManifest,
      newManifest,
      operation: "cutover",
      progress,
      stamp,
      target,
    });
    rmSync(image, { force: true, recursive: true });
    image = null;

    let after = null;
    if (withLedger) {
      const result = context.spawn(
        context.node,
        [join(root, "tools/process-log.mjs"), "validate", "--deep"],
        {
          cwd: root,
          encoding: "utf8",
          env: childEnvironment(),
          shell: false,
        },
      );
      try {
        after = JSON.parse(result.stdout);
      } catch {
        after = { error: childErrorCode(result) };
      }
    }
    const prune = pruneRetained(root);
    const evidence = {
      operation: "cutover",
      stamp,
      finished_at: context.now().toISOString(),
      ...report,
      stopped_after_swap: withLedger && !after?.error ? newlyReported(baseline, after) : null,
      retained: prune,
    };
    writeEvidence(root, stamp, evidence);
    return { status: "cut_over", ...evidence };
  } catch (error) {
    if (
      image !== null &&
      !progress.journaled &&
      !existsSync(journalPath(root)) &&
      existsSync(image)
    ) {
      rmSync(image, { force: true, recursive: true });
    } else if (image !== null && !existsSync(journalPath(root)) && existsSync(image)) {
      // A reversal ran; the image is deleted only if nothing of the folder's state is left in it.
      let zones = null;
      try {
        zones = readManifest(root)?.zones ?? null;
      } catch {
        zones = null;
      }
      if (zones !== null && stagingOffenders(image, zones).length === 0) {
        rmSync(image, { force: true, recursive: true });
      }
    }
    throw error;
  } finally {
    releaseLock(root, lock);
  }
}

/**
 * Finishes an interrupted swap by reversing its journal, or swaps the folder back to a retained
 * tree (`to`, or the manifest's `previous`).
 */
export function rollbackFolder(input, suppliedContext) {
  const context = withDefaults(suppliedContext);
  const root = realpathSync(input.root);
  const lock = acquireLock(context, root);
  try {
    if (existsSync(journalPath(root))) {
      const journal = readJournal(root);
      if (input.expectedStamp !== undefined && journal.stamp !== input.expectedStamp) {
        fail(
          "ops_tree_recovery_refused",
          `this copy belongs to ${input.expectedStamp}, the journal to ${journal.stamp}`,
        );
      }
      const keptImage = reverseJournal(root, journal);
      return {
        kept_image: keptImage,
        lock_takeover: lock.takeover,
        operation: journal.operation,
        stamp: journal.stamp,
        status: "recovered",
      };
    }
    if (input.expectedStamp !== undefined) {
      fail(
        "ops_tree_recovery_refused",
        "a copy of the tool may only reverse an interrupted swap, and there is none",
      );
    }
    const liveManifest = requireReadyFolder(root);
    const stamp = input.to ?? liveManifest.previous;
    if (typeof stamp !== "string" || !STAMP_PATTERN.test(stamp)) {
      fail("ops_tree_nothing_to_roll_back", "the folder names no retained tree to roll back to");
    }
    const source = join(previousRoot(root), stamp);
    if (!isRealDirectory(source))
      fail("ops_tree_nothing_to_roll_back", `no retained tree ${stamp}`);
    const sourceManifest = parseManifest(readSafely(join(source, MANIFEST_FILE_NAME)));
    if (sourceManifest === null)
      fail("ops_manifest_invalid", `the retained tree ${stamp} has no valid manifest`);
    const drift = compareFiles(sourceManifest.files, digestTree(source, sourceManifest.zones));
    if (drift.length > 0) {
      fail(
        "ops_tree_rollback_target_drift",
        `the retained tree ${stamp} no longer matches its manifest`,
        { drift },
      );
    }
    clearStaging(root, liveManifest.zones);
    const override = readOverride(root, "rollback", input.inputFile);
    const gates = readGates(context, root);
    const lifted = applyGates(gates, override);

    const newStamp = stampFor(context.now());
    const target = join(previousRoot(root), newStamp);
    const newManifest = { ...sourceManifest, previous: newStamp, state: "ready" };
    swap(context, root, {
      image: source,
      liveManifest,
      newManifest,
      operation: "rollback",
      stamp: newStamp,
      target,
    });
    rmSync(join(source, MANIFEST_FILE_NAME), { force: true });
    const leftover = topLevelNames(source);
    if (leftover.length === 0) rmdirSync(source);
    const prune = pruneRetained(root);
    const evidence = {
      operation: "rollback",
      stamp: newStamp,
      finished_at: context.now().toISOString(),
      engine: { from: liveManifest.engine.tag, to: sourceManifest.engine.tag },
      candidate: { from: liveManifest.candidate.tag, to: sourceManifest.candidate.tag },
      gates,
      lock_takeover: lock.takeover,
      override:
        override === null
          ? null
          : { lifted: lifted.map((refusal) => refusal.code), reason: override },
      restored_from: stamp,
      retained: prune,
      source_leftover: leftover,
    };
    writeEvidence(root, newStamp, evidence);
    return { status: "rolled_back", ...evidence };
  } finally {
    releaseLock(root, lock);
  }
}

export { OpsTreeError };
