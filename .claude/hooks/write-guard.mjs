/**
 * Write guard for file tools, keyed on the operational folder's marker file.
 *
 * The operational folder is not a git checkout: it is an export of two pinned
 * tags beside the run's own state, recognised by `ops-manifest.json` at its
 * root, whose zone table says which part of the folder is which. This guard
 * reads that marker and nothing else. It never runs git, and a tree without a
 * marker — a development clone, a task tree, a scratch directory — is open to
 * it.
 *
 * Two rules, one per direction:
 *
 * 1. A target under a marked folder is refused to every session whose
 *    directory is not under that same folder. Development sessions do not
 *    write the run's artifacts, its handover outbox included: the board tool
 *    that collects drafts works through the shell, not through a file tool.
 * 2. A session whose directory is under a marked folder writes only under it.
 *    That keeps a run out of the development clone, the live board and the
 *    live candidate data, all of which sit on the same disk. The one exception
 *    belongs to an operational folder (never a rehearsal one): Claude Code's
 *    memory folder of the folder's own project, its plans folder, and the
 *    system temporary directories, when the target lies under no marked
 *    folder.
 *
 * Inside its own folder a session writes the `state` and `handover` zones of
 * the folder's zone table. The `engine`, `candidate` and `dependencies` zones,
 * the service entries and metadata files are read-only to everyone, and a
 * path the table does not name is `engine`. `.claude/settings.local.json` is a
 * state path in the table but is refused to every session: the runtime reads
 * hooks and `disableAllHooks` from it, so one allowed write would remove this
 * guard.
 *
 * Seven decisions are deliberate:
 *
 * - **Deny is exit code 2 with the reason on standard error.** Exit 2 blocks
 *   the tool call regardless of payload.
 * - **It fails closed.** An unreadable payload, a missing target, an
 *   unreadable directory on the way up, a marker whose manifest is missing or
 *   malformed, and a path through a link into nothing all refuse and say
 *   which one it was.
 * - **Either half of the marker marks the folder.** The manifest, or the
 *   `.ops-tree` service directory the folder tool never removes, so deleting
 *   the manifest alone does not open the folder.
 * - **A marker inside another folder is refused.** The folder tool keeps
 *   manifests of its images and retained trees under its own `.ops-tree`;
 *   there the outer folder decides, and that is its service zone. Any other
 *   pair of markers on one path is a folder built inside another, and taking
 *   either one's rules would hand its session the other's state.
 * - **Every target is judged twice** — as written (parents resolved) and where
 *   it lands (fully resolved) — and a refusal of either refuses. A link whose
 *   target does not exist is refused on any tree, marked or not: where such a
 *   write lands cannot be known without following the link, and following it
 *   as text gets `..` behind a live link wrong.
 * - **Nothing is imported from the engine's tools.** The zone function and the
 *   marker constants are copies of the folder tool's, held equal by a test: a
 *   guard whose import breaks does not start, and a runtime reads a hook that
 *   did not start as "allow".
 * - **The session is `payload.cwd`.** A `cd` in the shell moves it.
 *
 * What it does not close: the shell channel (open in the desktop runtime),
 * Codex and any other agent that does not run this hook, file-writing tools
 * outside the `Edit|Write|NotebookEdit` matcher, hard links, deleting the
 * marker through the shell, and every checkout whose settings do not register
 * this file. Whether the desktop runtime fires a project hook in a folder
 * without `.git` has been measured only in the terminal CLI.
 *
 * The tracked settings register this guard. The rights matrix and registration
 * are checked by the surviving runtime suites.
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

// Copies of the folder tool's constants; a test holds them equal to the originals.
export const MANIFEST_FILE_NAME = "ops-manifest.json";
export const SERVICE_DIRECTORY_NAME = ".ops-tree";
export const MANIFEST_SCHEMA = "job-search-pipeline/ops-manifest";
export const MANIFEST_SCHEMA_VERSION = 1;
export const FOLDER_KINDS = Object.freeze(["operational", "rehearsal"]);
export const FOLDER_STATES = Object.freeze(["ready", "building"]);

export const WRITABLE_ZONES = Object.freeze(["handover", "state"]);
export const LOCAL_SETTINGS_PATH = ".claude/settings.local.json";

const ZONE_LISTS = Object.freeze([
  "candidateExcludes",
  "dependencies",
  "handover",
  "metadataBasenames",
  "service",
  "servicePrefixes",
  "stateNames",
  "stateNested",
  "statePrefixes",
]);

export class GuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GuardError";
    this.code = code;
  }
}

function isMissing(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

/**
 * Resolves links on the deepest existing ancestor and re-attaches the part
 * that does not exist yet, so a write to a new file is judged by the real
 * directory it would land in. A component that cannot be resolved but still
 * exists is a link into nothing, or a path through one; that is refused rather
 * than re-attached as if it were missing.
 */
export function resolvePath(target) {
  let current = resolve(target);
  const missing = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.slice().reverse());
    } catch (error) {
      if (!isMissing(error)) {
        throw new GuardError("path_unresolvable", `${current}: ${error?.code ?? "unknown error"}`);
      }
    }
    let entry = null;
    try {
      entry = lstatSync(current);
    } catch (error) {
      if (!isMissing(error)) {
        throw new GuardError("path_unresolvable", `${current}: ${error?.code ?? "unknown error"}`);
      }
    }
    if (entry !== null) {
      throw new GuardError("dangling_symlink", `${current} is a link whose target does not exist`);
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new GuardError("path_unresolvable", `${target}: no existing ancestor`);
    }
    missing.push(basename(current));
    current = parent;
  }
}

/** The two readings of one absolute target: as written, and where it lands. */
export function readingsOf(absolute) {
  const normalized = resolve(absolute);
  const asWritten = join(resolvePath(dirname(normalized)), basename(normalized));
  const landing = resolvePath(normalized);
  return asWritten === landing ? [landing] : [asWritten, landing];
}

/** Containment on segment boundaries: `<root>-worktrees/x` is not inside `<root>`. */
export function isInside(root, target) {
  if (target === root) return true;
  const step = relative(root, target);
  return step !== "" && !step.startsWith("..") && !isAbsolute(step);
}

function entryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw new GuardError("marker_unreadable", `${path}: ${error?.code ?? "unknown error"}`);
  }
}

function hasMarker(directory) {
  return (
    entryExists(join(directory, MANIFEST_FILE_NAME)) ||
    entryExists(join(directory, SERVICE_DIRECTORY_NAME))
  );
}

/** Every directory from `path` up to the filesystem root that carries a marker, innermost first. */
function markedAncestors(path) {
  const found = [];
  let current = path;
  for (;;) {
    if (hasMarker(current)) found.push(current);
    const parent = dirname(current);
    if (parent === current) return found;
    current = parent;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validZones(zones) {
  return (
    isRecord(zones) &&
    typeof zones.candidate === "string" &&
    ZONE_LISTS.every(
      (key) => Array.isArray(zones[key]) && zones[key].every((item) => typeof item === "string"),
    )
  );
}

/** The kind and zone table of a marked folder; anything that is not a readable manifest refuses. */
export function loadFolder(root) {
  const path = join(root, MANIFEST_FILE_NAME);
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (isMissing(error)) {
      throw new GuardError(
        "ops_manifest_missing",
        `${root} carries ${SERVICE_DIRECTORY_NAME}/ but no ${MANIFEST_FILE_NAME}`,
      );
    }
    throw new GuardError("ops_manifest_invalid", `${path}: ${error?.code ?? "unknown error"}`);
  }
  if (!stats.isFile()) {
    throw new GuardError("ops_manifest_invalid", `${path} is not a regular file`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new GuardError(
      "ops_manifest_invalid",
      `${path} is not readable JSON (${error?.code ?? error?.name})`,
    );
  }
  if (
    !isRecord(manifest) ||
    manifest.schema !== MANIFEST_SCHEMA ||
    manifest.schema_version !== MANIFEST_SCHEMA_VERSION ||
    !FOLDER_KINDS.includes(manifest.kind) ||
    !FOLDER_STATES.includes(manifest.state) ||
    !validZones(manifest.zones)
  ) {
    throw new GuardError("ops_manifest_invalid", `${path} is not an ops manifest this guard reads`);
  }
  return { kind: manifest.kind, root, zones: manifest.zones };
}

/**
 * The marked folder a resolved path lies in, or `null`. Several markers on one
 * path are accepted only in the layout the folder tool writes itself — images
 * and retained trees under the outer folder's service directory — and then the
 * outer folder decides.
 */
export function folderOf(path, cache = new Map()) {
  const marked = markedAncestors(path);
  if (marked.length === 0) return null;
  const outer = marked[marked.length - 1];
  const service = join(outer, SERVICE_DIRECTORY_NAME);
  const inner = marked.slice(0, -1);
  if (inner.some((directory) => !isInside(service, directory))) {
    throw new GuardError(
      "nested_marker",
      `${inner[0]} is a marked folder inside the marked folder ${outer}`,
    );
  }
  if (!cache.has(outer)) cache.set(outer, loadFolder(outer));
  return cache.get(outer);
}

/**
 * The zone of one root-relative POSIX path under a zone table. A copy of the
 * folder tool's function; a test holds the two equal.
 */
export function zoneOf(zones, relativePath) {
  const segments = relativePath.split("/");
  const name = segments[segments.length - 1];
  if (zones.metadataBasenames.includes(name)) return "metadata";
  const top = segments[0];
  if (zones.service.includes(top)) return "service";
  if (zones.servicePrefixes.some((prefix) => top.startsWith(prefix))) return "service";
  if (zones.handover.includes(top)) return "handover";
  if (zones.stateNames.includes(top)) return "state";
  if (zones.statePrefixes.some((prefix) => top.startsWith(prefix))) return "state";
  if (
    zones.stateNested.some(
      (nested) => relativePath === nested || relativePath.startsWith(`${nested}/`),
    )
  ) {
    return "state";
  }
  if (
    zones.dependencies.some(
      (dependency) => relativePath === dependency || relativePath.startsWith(`${dependency}/`),
    )
  ) {
    return "dependencies";
  }
  if (relativePath === zones.candidate || relativePath.startsWith(`${zones.candidate}/`)) {
    return "candidate";
  }
  return "engine";
}

function posixRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

/** The name Claude Code gives a project's directory under `~/.claude/projects`. */
export function projectDirectoryName(root) {
  return root.replace(/[^A-Za-z0-9]/g, "-");
}

function resolvedIfPresent(path) {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new GuardError("path_unresolvable", `${path}: ${error?.code ?? "unknown error"}`);
  }
}

/** The four roots an operational session may write outside its folder, resolved. */
export function outsideRoots(
  folderRoot,
  { home = homedir(), temporaryDirectories = [tmpdir(), "/tmp"] } = {},
) {
  const claude = join(home, ".claude");
  const roots = [
    resolvePath(join(claude, "projects", projectDirectoryName(folderRoot), "memory")),
    resolvePath(join(claude, "plans")),
  ];
  for (const directory of temporaryDirectories) {
    const resolved = resolvedIfPresent(directory);
    if (resolved !== null) roots.push(resolved);
  }
  return roots;
}

export function writeTargets(payload) {
  const input = payload?.tool_input;
  const candidates = [input?.file_path, input?.notebook_path];
  return candidates.filter((value) => typeof value === "string" && value.trim() !== "");
}

/**
 * The two rules of the header, per reading of every target:
 *
 * 1. a session living in a marked folder writes nothing outside it, except the
 *    operational exception;
 * 2. a target outside every marked folder is allowed;
 * 3. `.claude/settings.local.json` of a marked folder is refused to everyone;
 * 4. a session outside the target's folder is refused;
 * 5. the folder's own session writes the `state` and `handover` zones only.
 *
 * `options.home` and `options.temporaryDirectories` replace the machine's own
 * values in tests; the hook's entry point never passes them.
 */
export function decide(payload, options = {}) {
  const cwd = payload?.cwd;
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new GuardError("session_cwd_missing", "the payload carries no session directory");
  }
  const targets = writeTargets(payload);
  if (targets.length === 0) {
    throw new GuardError("write_target_missing", "the payload names no write target");
  }
  const cache = new Map();
  const sessionDirectory = resolvePath(cwd);
  const session = folderOf(sessionDirectory, cache);
  let exceptionRoots;
  for (const target of targets) {
    const absolute = resolve(cwd, target);
    for (const path of readingsOf(absolute)) {
      const folder = folderOf(path, cache);
      if (session !== null && folder?.root !== session.root) {
        if (folder === null && session.kind === "operational") {
          exceptionRoots ??= outsideRoots(session.root, options);
          if (exceptionRoots.some((root) => isInside(root, path))) continue;
        }
        return { allowed: false, reason: "outbound", root: session.root, target: path };
      }
      if (folder === null) continue;
      const relativePath = posixRelative(folder.root, path);
      if (relativePath.toLowerCase() === LOCAL_SETTINGS_PATH) {
        return { allowed: false, reason: "settings_local", root: folder.root, target: path };
      }
      if (session === null) {
        return { allowed: false, reason: "inbound", root: folder.root, target: path };
      }
      const zone = zoneOf(folder.zones, relativePath);
      if (!WRITABLE_ZONES.includes(zone)) {
        return { allowed: false, reason: "read_only_zone", root: folder.root, target: path, zone };
      }
    }
  }
  return { allowed: true };
}

export function denyMessage({ reason, root, target, zone }) {
  switch (reason) {
    case "outbound":
      return (
        `write guard [outbound]: this session lives in the marked folder ${root}, and a session ` +
        `there writes only under it. Blocked target: ${target}. Source, board and candidate changes ` +
        `belong to a development session; a task for the board is a draft in the folder's outbox.`
      );
    case "inbound":
      return (
        `write guard [inbound]: ${root} is a marked folder, and only a session living in it ` +
        `writes there; its outbox is collected by the board tool, not by file tools. Blocked ` +
        `target: ${target}. Read the folder by absolute path, and write under your own tree.`
      );
    case "read_only_zone":
      return (
        `write guard [read_only_zone]: ${target} is in the ${zone} zone of the marked folder ` +
        `${root}, which no session writes; the folder changes only through its tool. Blocked ` +
        `target: ${target}. The run writes its state and its outbox.`
      );
    case "settings_local":
      return (
        `write guard [settings_local]: the runtime reads hooks and disableAllHooks from ` +
        `${LOCAL_SETTINGS_PATH}, so no session writes it with a file tool. Blocked target: ` +
        `${target}. It is rendered by the machine setup script.`
      );
    default:
      return (
        `write guard [unclassified]: this write was refused by a rule this message cannot ` +
        `name, which is itself a defect in the guard. Blocked target: ${target}.`
      );
  }
}

export function failClosedMessage(error) {
  const code = error instanceof GuardError ? error.code : "unexpected_error";
  const detail = error instanceof GuardError ? error.message : "internal failure";
  return (
    `write guard: could not resolve whether this write is allowed (${code}: ${detail}). ` +
    `Denying, because this guard fails closed.`
  );
}

export function main(
  read = () => readFileSync(0, "utf8"),
  write = (text) => process.stderr.write(text),
) {
  let text;
  try {
    const raw = read();
    if (raw.length > MAX_PAYLOAD_BYTES) {
      throw new GuardError("payload_too_large", `${raw.length} bytes`);
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new GuardError("payload_unreadable", "the payload is not JSON");
    }
    const decision = decide(payload);
    if (decision.allowed) return;
    text = denyMessage(decision);
  } catch (error) {
    text = failClosedMessage(error);
  }
  write(`${text}\n`);
  process.exitCode = 2;
}

function isDirectInvocation() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  }
}

if (isDirectInvocation()) main();
