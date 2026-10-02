/**
 * The operational folder's marker file, its zone table, and the drift check every pipeline step
 * runs.
 *
 * The operational folder is not a git checkout. It is an export of two pinned tags — the engine's
 * `release-<date>` and the private layer's `candidate-<date>` — beside the run's own state, and
 * `ops-manifest.json` at its root records which tags, a digest of every file of the two read-only
 * zones, and the zone table itself. `tools/ops-tree/README.md` owns the schema and the codes; this
 * module owns the one question every caller asks: is the tree the code runs from still the tree
 * that was built?
 *
 * Two choices carry the design.
 *
 * - **The tree checked is the tree the code lives in.** Callers pass their own `repoRoot`, never a
 *   directory taken from `JOB_PIPELINE_WORKSPACE_ROOT`: that variable isolates tests, and a check
 *   it could point elsewhere would be a check anybody could aim at a clean copy.
 * - **Everything not named is engine.** The table lists the state, handover and service zones by
 *   name; whatever else sits in the folder belongs to the engine zone, so a file dropped at the
 *   root is an added engine file and the check refuses it. A list of the engine's own paths would
 *   have let exactly that file through.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export const MANIFEST_FILE_NAME = "ops-manifest.json";
export const MANIFEST_SCHEMA = "job-search-pipeline/ops-manifest";
export const MANIFEST_SCHEMA_VERSION = 1;
export const SERVICE_DIRECTORY_NAME = ".ops-tree";
export const JOURNAL_FILE_NAME = "journal.json";
export const FOLDER_KINDS = Object.freeze(["operational", "rehearsal"]);
export const CANDIDATE_DIRECTORY_NAME = "candidate";

/**
 * Paths of the private repository that never enter the folder. The board, the personal decision
 * records, the archive, the research and the machine templates are not read by any run, and
 * corrections written by a run live in `records/`.
 * The list is the engine's, not the private repository's `.gitattributes`: that file lives in each
 * commit separately, and a tag cut from a commit without it would bring the whole board silently.
 */
export const CANDIDATE_EXPORT_EXCLUDES = Object.freeze([
  "archive",
  "board",
  "decisions",
  "machine",
  "research",
]);

/**
 * The zone table this engine builds folders with. It is written into every manifest, and a folder
 * is always checked against the table in its own manifest — the one its files were digested
 * under — rather than against whatever the running engine would build today.
 *
 * `stateNames` match a root entry exactly, `statePrefixes` match a root entry that starts with the
 * prefix (a ledger and its `.lock`, `.lock.claim-*`, `.candidate-*` and `.tmp` siblings), and
 * `stateNested` are state paths inside a directory of another zone.
 */
export const ZONE_TABLE = Object.freeze({
  candidate: CANDIDATE_DIRECTORY_NAME,
  candidateExcludes: CANDIDATE_EXPORT_EXCLUDES,
  dependencies: Object.freeze(["tools/cv-builder/node_modules"]),
  handover: Object.freeze(["outbox"]),
  metadataBasenames: Object.freeze([".DS_Store"]),
  service: Object.freeze([SERVICE_DIRECTORY_NAME]),
  servicePrefixes: Object.freeze([MANIFEST_FILE_NAME]),
  stateNames: Object.freeze([
    ".idea",
    ".pipeline-input",
    ".playwright-mcp",
    ".temp-docs",
    ".vscode",
    "output",
    "pkcs11.txt",
    "records",
    "telegram-sources.json",
    "telegram-sweeps",
    "triage-batches",
  ]),
  stateNested: Object.freeze([
    ".claude/.cc-writes",
    ".claude/settings.local.json",
  ]),
  statePrefixes: Object.freeze([
    "process-log.backup-",
    "process-log.json",
    "telegram-sweep-state.json",
    "triage-ledger.json",
  ]),
});

/**
 * The rehearsal folder writes its batch store and sweeps under `.rehearsal/`, as the rehearsal
 * runbooks direct; in an operational folder that directory is foreign and reads as engine drift.
 */
const REHEARSAL_STATE_NAMES = Object.freeze([".rehearsal"]);

export class OpsTreeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "OpsTreeError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function fail(code, message, details) {
  throw new OpsTreeError(code, message, details);
}

/** The zone table a folder of this kind is built with. */
export function zoneTableFor(kind) {
  if (!FOLDER_KINDS.includes(kind)) fail("ops_tree_invalid_arguments", `unknown folder kind: ${kind}`);
  const table = structuredClone(ZONE_TABLE);
  if (kind === "rehearsal") table.stateNames = [...table.stateNames, ...REHEARSAL_STATE_NAMES].sort();
  return table;
}

function isWithin(path, base) {
  return path === base || path.startsWith(`${base}/`);
}

/**
 * The zone of one root-relative POSIX path. A directory that is itself a state, handover, service
 * or dependencies root answers for everything below it, so the walk never descends into it.
 */
export function zoneOf(zones, relativePath) {
  const segments = relativePath.split("/");
  const basename = segments[segments.length - 1];
  if (zones.metadataBasenames.includes(basename)) return "metadata";
  const top = segments[0];
  if (zones.service.includes(top)) return "service";
  if (zones.servicePrefixes.some((prefix) => top.startsWith(prefix))) return "service";
  if (zones.handover.includes(top)) return "handover";
  if (zones.stateNames.includes(top)) return "state";
  if (zones.statePrefixes.some((prefix) => top.startsWith(prefix))) return "state";
  if (zones.stateNested.some((nested) => isWithin(relativePath, nested))) return "state";
  if (zones.dependencies.some((dependency) => isWithin(relativePath, dependency))) {
    return "dependencies";
  }
  if (isWithin(relativePath, zones.candidate)) return "candidate";
  return "engine";
}

const DIGESTED_ZONES = Object.freeze(["engine", "dependencies", "candidate"]);

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** One entry as the manifest records it; directories are not recorded, only walked. */
function describe(path, stats) {
  if (stats.isSymbolicLink()) return { symlink: readlinkSync(path) };
  if (stats.isFile()) {
    return {
      executable: (stats.mode & 0o111) !== 0,
      sha256: sha256Hex(readFileSync(path)),
    };
  }
  return { other: true };
}

/**
 * Every digested entry under `root`, grouped by zone. The walk never follows a symbolic link and
 * never descends into a zone it does not digest.
 */
export function digestTree(root, zones) {
  const files = { candidate: {}, dependencies: {}, engine: {} };
  const walk = (relativeDirectory) => {
    const absolute = relativeDirectory === "" ? root : join(root, relativeDirectory);
    for (const name of readdirSync(absolute).sort()) {
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const zone = zoneOf(zones, relativePath);
      if (!DIGESTED_ZONES.includes(zone)) continue;
      const path = join(absolute, name);
      const stats = lstatSync(path);
      if (stats.isDirectory()) {
        walk(relativePath);
        continue;
      }
      files[zone][relativePath] = describe(path, stats);
    }
  };
  walk("");
  return files;
}

function sameEntry(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function entryKindName(entry) {
  if (entry.symlink !== undefined) return "symlink";
  if (entry.other) return "other";
  return "file";
}

/** Differences between what a manifest recorded and what is on disk, one row per path. */
export function compareFiles(recorded, observed) {
  const drift = [];
  for (const zone of DIGESTED_ZONES) {
    const before = recorded[zone] ?? {};
    const after = observed[zone] ?? {};
    const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const path of paths) {
      if (!Object.hasOwn(after, path)) {
        drift.push({ kind: "removed", path, zone });
      } else if (!Object.hasOwn(before, path)) {
        drift.push({ kind: "added", path, zone });
      } else if (entryKindName(before[path]) !== entryKindName(after[path])) {
        drift.push({ kind: "type_changed", path, zone });
      } else if (!sameEntry(before[path], after[path])) {
        drift.push({ kind: "modified", path, zone });
      }
    }
  }
  return drift;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A git object id in either object format the repository may use. */
export const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function validPin(pin) {
  return isRecord(pin)
    && typeof pin.tag === "string"
    && OBJECT_ID_PATTERN.test(pin.commit ?? "")
    && OBJECT_ID_PATTERN.test(pin.tree ?? "")
    && typeof pin.repository === "string";
}

function validZones(zones) {
  if (!isRecord(zones)) return false;
  const lists = [
    "candidateExcludes", "dependencies", "handover", "metadataBasenames", "service",
    "servicePrefixes", "stateNames", "stateNested", "statePrefixes",
  ];
  return typeof zones.candidate === "string"
    && lists.every((key) => Array.isArray(zones[key]) && zones[key].every((item) => typeof item === "string"));
}

/** Parses and shape-checks a manifest; `null` for bytes that are not one. */
export function parseManifest(bytes) {
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    return null;
  }
  if (
    !isRecord(value)
    || value.schema !== MANIFEST_SCHEMA
    || value.schema_version !== MANIFEST_SCHEMA_VERSION
    || !FOLDER_KINDS.includes(value.kind)
    || !["ready", "building"].includes(value.state)
    || !validPin(value.engine)
    || !validPin(value.candidate)
    || typeof value.built_at !== "string"
    || !(value.previous === null || typeof value.previous === "string")
    || !validZones(value.zones)
    || !isRecord(value.files)
    || !DIGESTED_ZONES.every((zone) => isRecord(value.files[zone]))
  ) {
    return null;
  }
  return value;
}

export function manifestPath(root) {
  return join(root, MANIFEST_FILE_NAME);
}

/**
 * The manifest of a folder, or `null` when the directory is not an operational folder at all.
 * A folder is recognised by either half of its marker: the manifest, or the service directory the
 * tool never removes. So deleting the manifest alone does not switch the check off.
 */
export function readManifest(root) {
  const path = manifestPath(root);
  let stats = null;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") fail("ops_manifest_invalid", "the folder's manifest is not readable");
  }
  if (stats === null) {
    if (existsSync(join(root, SERVICE_DIRECTORY_NAME))) {
      fail(
        "ops_manifest_missing",
        `the folder carries ${SERVICE_DIRECTORY_NAME}/ but no ${MANIFEST_FILE_NAME}; rebuild it with a cutover onto its tags`,
      );
    }
    return null;
  }
  if (!stats.isFile()) fail("ops_manifest_invalid", `${MANIFEST_FILE_NAME} is not a regular file`);
  const manifest = parseManifest(readFileSync(path, "utf8"));
  if (manifest === null) fail("ops_manifest_invalid", `${MANIFEST_FILE_NAME} is not a valid ops manifest`);
  return manifest;
}

export function journalPath(root) {
  return join(root, SERVICE_DIRECTORY_NAME, JOURNAL_FILE_NAME);
}

/** Writes a file through a sibling temporary name, synced, then renamed into place. */
export function writeFileAtomic(path, text) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o644);
  try {
    writeSync(descriptor, text);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Keeps a path printable inside a bounded one-line diagnostic. */
function printablePath(path) {
  const cleaned = path.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, "?");
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
}

/**
 * The one-line message of a drift refusal: the first few paths, each with its zone and kind, and
 * the command that rebuilds both zones. It stays inside the process log's diagnostic bounds —
 * relative paths only, at most 512 bytes — so the CLI does not replace it with a generic line.
 */
export function driftMessage(drift, manifest) {
  const shown = drift.slice(0, 3)
    .map((row) => `${row.kind} ${row.zone} ${printablePath(row.path)}`)
    .join("; ");
  const more = drift.length > 3 ? ` and ${drift.length - 3} more` : "";
  const repair = `npm run ops:cutover -- --release ${manifest.engine.tag} --candidate ${manifest.candidate.tag}`;
  const message = `the folder drifted from its manifest: ${shown}${more}; list every path with npm run ops:verify, rebuild with ${repair}`;
  return Buffer.byteLength(message, "utf8") <= 512
    ? message
    : `the folder drifted from its manifest in ${drift.length} path(s); list them with npm run ops:verify`;
}

/**
 * The drift check. Returns `{status: "not_operational"}` for a tree without the marker — a
 * development tree, a disposable root, today's `ops/current` — and `{status: "clean", manifest}`
 * for a folder that matches its manifest; throws otherwise.
 */
export function verifyFolder(root) {
  const manifest = readManifest(root);
  if (manifest === null) return { status: "not_operational" };
  if (manifest.state !== "ready" || existsSync(journalPath(root))) {
    fail(
      "ops_tree_building",
      "a cutover or rollback of this folder did not finish; complete it with node tools/ops-tree/cli.mjs rollback",
    );
  }
  const drift = compareFiles(manifest.files, digestTree(root, manifest.zones));
  if (drift.length > 0) {
    const engineDrift = drift.some((row) => row.zone !== "candidate");
    fail(
      engineDrift ? "engine_tree_drift" : "candidate_snapshot_drift",
      driftMessage(drift, manifest),
      { drift },
    );
  }
  return { status: "clean", manifest };
}

/** The short summary a preflight report carries. */
export function manifestSummary(manifest) {
  return {
    built_at: manifest.built_at,
    candidate: manifest.candidate.tag,
    kind: manifest.kind,
    release: manifest.engine.tag,
  };
}
