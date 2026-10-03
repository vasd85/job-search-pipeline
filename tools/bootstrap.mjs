#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkOutputRoot, initializeOutputRoot, OutputRootError } from "./lib/output-root.mjs";
import {
  checkCvBuilderDependencies,
  CvBuilderDependencyError,
} from "./cv-builder/check-dependencies.mjs";
import { resolveLibreOfficeBackend } from "./cv-builder/libreoffice-backend.mjs";
import { validateLogV3 } from "./lib/process-log-core.mjs";
import { loadAllCandidateConstraints } from "./candidate/constraints.mjs";
import {
  CandidateError,
  candidateExampleRootFor,
  candidateRootFor,
  inspectCandidateLayer,
} from "./candidate/load.mjs";
import {
  MANIFEST_FILE_NAME,
  OpsTreeError,
  SERVICE_DIRECTORY_NAME,
  manifestSummary,
  verifyFolder,
} from "./ops-tree/manifest.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class BootstrapCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BootstrapCliError";
    this.code = code;
  }
}

export class ToolchainPreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ToolchainPreflightError";
    this.code = code;
  }
}

function toolchainFail(code, message) {
  throw new ToolchainPreflightError(code, message);
}

function readText(path, missingCode, label) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") toolchainFail(missingCode, `${label} is missing`);
    toolchainFail("toolchain_metadata_invalid", `${label} is not readable`);
  }
}

function readJson(path, missingCode, label) {
  const bytes = readText(path, missingCode, label);
  try {
    return JSON.parse(bytes);
  } catch {
    toolchainFail("toolchain_metadata_invalid", `${label} is not valid JSON`);
  }
}

function exactNpmVersion(packageManager) {
  const match = /^npm@(\d+\.\d+\.\d+)$/.exec(packageManager ?? "");
  if (!match) {
    toolchainFail("toolchain_policy_invalid", "packageManager must pin one exact npm version");
  }
  return match[1];
}

function commandPath(command, env = process.env) {
  for (const entry of String(env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)) {
    const candidate = join(entry, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue through PATH without invoking a shell or mutating the environment.
    }
  }
  return null;
}

function packageManagerVersion(env = process.env) {
  const result = spawnSync("npm", ["--version"], {
    encoding: "utf8",
    env,
  });
  if (result.error?.code === "ENOENT") return null;
  if (result.status !== 0) return null;
  const version = result.stdout.trim();
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

function requireCommand(command, env = process.env) {
  const path = commandPath(command, env);
  if (!path) {
    toolchainFail("required_tool_missing", `required tool is unavailable: ${command}`);
  }
  return path;
}

function rendererContext(env = process.env, platform = process.platform) {
  const isExecutable = (path) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  };
  return {
    env,
    platform,
    pathEntries: String(env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean),
    isExecutable,
    isDirectory(path) {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    readText(path) {
      try {
        const stats = statSync(path);
        if (!stats.isFile() || stats.size > 64 * 1024) return "";
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    },
  };
}

function defaultToolchainContext() {
  return {
    nodeVersion: process.versions.node,
    packageManagerVersion: () => packageManagerVersion(process.env),
    requireCommand: (command) => requireCommand(command, process.env),
    resolveRenderer: () =>
      resolveLibreOfficeBackend({}, rendererContext(process.env, process.platform)),
  };
}

function assertMatchingObject(left, right, code, message) {
  if (JSON.stringify(left) !== JSON.stringify(right)) toolchainFail(code, message);
}

export function checkToolchain({
  context = defaultToolchainContext(),
  workspaceRoot = repoRoot,
} = {}) {
  const sourceRoot = resolve(workspaceRoot);
  const builderRoot = join(sourceRoot, "tools", "cv-builder");
  const rootPackage = readJson(
    join(sourceRoot, "package.json"),
    "toolchain_metadata_invalid",
    "root package manifest",
  );
  const builderPackage = readJson(
    join(builderRoot, "package.json"),
    "toolchain_metadata_invalid",
    "cv-builder package manifest",
  );
  const pinnedNode = String(rootPackage.engines?.node ?? "");
  const pinnedNpm = exactNpmVersion(rootPackage.packageManager);
  if (!/^\d+\.\d+\.\d+$/.test(pinnedNode)) {
    toolchainFail("toolchain_policy_invalid", "engines.node must pin one exact version");
  }
  if (rootPackage.engines?.npm !== pinnedNpm) {
    toolchainFail("toolchain_policy_invalid", "root npm engine and packageManager pins differ");
  }
  if (
    builderPackage.packageManager !== rootPackage.packageManager ||
    builderPackage.engines?.node !== pinnedNode ||
    builderPackage.engines?.npm !== pinnedNpm
  ) {
    toolchainFail("toolchain_policy_invalid", "root and cv-builder toolchain pins differ");
  }
  if (
    readText(join(sourceRoot, ".nvmrc"), "toolchain_policy_invalid", ".nvmrc").trim() !== pinnedNode
  ) {
    toolchainFail("toolchain_policy_invalid", ".nvmrc and engines.node pins differ");
  }

  if (context.nodeVersion !== pinnedNode) {
    toolchainFail(
      "unsupported_node_version",
      `Node ${pinnedNode} is required by the repository toolchain policy`,
    );
  }
  const actualNpm = context.packageManagerVersion();
  if (!actualNpm) {
    toolchainFail("package_manager_missing", "npm is required by the repository toolchain policy");
  }
  if (actualNpm !== pinnedNpm) {
    toolchainFail(
      "unsupported_package_manager",
      `npm ${pinnedNpm} is required by the repository toolchain policy`,
    );
  }

  const rootLock = readJson(
    join(sourceRoot, "package-lock.json"),
    "toolchain_lockfile_missing",
    "root lockfile",
  );
  if (rootLock.lockfileVersion !== 3 || !rootLock.packages?.[""]) {
    toolchainFail("toolchain_lockfile_mismatch", "root lockfile must use lockfileVersion 3");
  }
  assertMatchingObject(
    rootLock.packages[""].engines,
    rootPackage.engines,
    "toolchain_lockfile_mismatch",
    "root manifest and lockfile engines differ",
  );

  const dependencies = checkCvBuilderDependencies(builderRoot);
  const tools = {
    unzip: context.requireCommand("unzip"),
  };
  let backend;
  try {
    backend = context.resolveRenderer();
  } catch {
    toolchainFail("renderer_unavailable", "no safe CV renderer backend is available");
  }
  if (backend.kind === "headless-soffice" && backend.command === "soffice") {
    context.requireCommand("soffice");
  }
  tools.pdfinfo = context.requireCommand("pdfinfo");
  tools.pdftoppm = context.requireCommand("pdftoppm");

  return {
    node: pinnedNode,
    packageManager: `npm@${pinnedNpm}`,
    dependencies,
    renderer: backend.kind,
    tools,
  };
}

function environment() {
  const workspaceRoot = process.env.JOB_PIPELINE_WORKSPACE_ROOT ?? repoRoot;
  return {
    outputRoot: process.env.JOB_PIPELINE_OUTPUT_ROOT ?? resolve(workspaceRoot, "output"),
    processLogPath:
      process.env.JOB_PIPELINE_PROCESS_LOG ?? resolve(workspaceRoot, "process-log.json"),
    workspaceRoot,
  };
}

function processLogFail(code, message) {
  throw new BootstrapCliError(code, message);
}

function exactProcessLogPath({ processLogPath, workspaceRoot }) {
  const expectedPath = resolve(workspaceRoot, "process-log.json");
  if (typeof processLogPath !== "string" || processLogPath !== expectedPath) {
    processLogFail(
      "invalid_process_log_environment",
      "process log must be the exact workspaceRoot/process-log.json file",
    );
  }
  return expectedPath;
}

function validateProcessLogBytes(bytes) {
  let log;
  try {
    log = JSON.parse(bytes);
    validateLogV3(log);
  } catch {
    processLogFail(
      "invalid_process_log_environment",
      "process log must be a valid schema-v4 ledger",
    );
  }
  return log;
}

function processLogFileFail() {
  processLogFail(
    "invalid_process_log_environment",
    "process log must be a single-link regular file",
  );
}

function readValidatedProcessLog(processLogPath) {
  let bytes;
  try {
    bytes = readFileSync(processLogPath, "utf8");
  } catch {
    processLogFail("invalid_process_log_environment", "process log is not readable");
  }
  validateProcessLogBytes(bytes);
  return bytes;
}

function requireProcessLogAccess(processLogPath, stats) {
  if ((stats.mode & 0o444) === 0 || (stats.mode & 0o222) === 0) {
    processLogFail("invalid_process_log_environment", "process log must be readable and writable");
  }
  try {
    accessSync(processLogPath, constants.R_OK | constants.W_OK);
  } catch {
    processLogFail("invalid_process_log_environment", "process log must be readable and writable");
  }
}

function inspectCompletedProcessLogPublication(processLogPath, expectedStats) {
  let completedStats;
  try {
    completedStats = lstatSync(processLogPath);
  } catch {
    processLogFileFail();
  }
  if (
    completedStats.isSymbolicLink() ||
    !completedStats.isFile() ||
    completedStats.dev !== expectedStats.dev ||
    completedStats.ino !== expectedStats.ino ||
    completedStats.nlink !== 1
  ) {
    processLogFileFail();
  }
  requireProcessLogAccess(processLogPath, completedStats);
  readValidatedProcessLog(processLogPath);
  try {
    completedStats = lstatSync(processLogPath);
  } catch {
    processLogFileFail();
  }
  if (
    completedStats.isSymbolicLink() ||
    !completedStats.isFile() ||
    completedStats.dev !== expectedStats.dev ||
    completedStats.ino !== expectedStats.ino ||
    completedStats.nlink !== 1
  ) {
    processLogFileFail();
  }
  return Object.freeze({
    created: false,
    path: processLogPath,
    recovered: false,
    status: "ready",
  });
}

function inspectProcessLogPublicationResidue(input, processLogPath, stats) {
  if (stats.nlink !== 2) processLogFileFail();
  const residuePattern =
    /^process-log\.json\.[1-9]\d*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
  let names;
  try {
    names = readdirSync(input.workspaceRoot);
  } catch {
    processLogFail(
      "invalid_process_log_environment",
      "process log publication residue is unavailable",
    );
  }
  const aliases = [];
  for (const name of names) {
    if (!residuePattern.test(name)) continue;
    const path = join(input.workspaceRoot, name);
    let candidate;
    try {
      candidate = lstatSync(path);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      processLogFail(
        "invalid_process_log_environment",
        "process log publication residue is unavailable",
      );
    }
    if (
      !candidate.isSymbolicLink() &&
      candidate.isFile() &&
      candidate.dev === stats.dev &&
      candidate.ino === stats.ino
    ) {
      aliases.push(path);
    }
  }
  if (aliases.length === 0) {
    return inspectCompletedProcessLogPublication(processLogPath, stats);
  }
  if (aliases.length !== 1) processLogFileFail();
  readValidatedProcessLog(processLogPath);
  return Object.freeze({
    created: false,
    device: stats.dev,
    inode: stats.ino,
    path: processLogPath,
    recovered: false,
    residuePath: aliases[0],
    status: "publication_residue",
  });
}

function inspectProcessLog(
  input,
  { missingAllowed = false, publicationResidueAllowed = false } = {},
) {
  const processLogPath = exactProcessLogPath(input);
  let stats;
  try {
    stats = lstatSync(processLogPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (missingAllowed) {
        return Object.freeze({
          created: false,
          path: processLogPath,
          recovered: false,
          status: "missing",
        });
      }
      processLogFail("bootstrap_required", "process log is missing; run npm run bootstrap:init");
    }
    processLogFail("invalid_process_log_environment", "process log is unavailable");
  }
  if (stats.isSymbolicLink() || !stats.isFile()) processLogFileFail();
  requireProcessLogAccess(processLogPath, stats);
  if (stats.nlink !== 1) {
    if (publicationResidueAllowed) {
      return inspectProcessLogPublicationResidue(input, processLogPath, stats);
    }
    processLogFileFail();
  }
  readValidatedProcessLog(processLogPath);
  return Object.freeze({
    created: false,
    path: processLogPath,
    recovered: false,
    status: "ready",
  });
}

function finishProcessLogPublication(input) {
  const inspected = inspectProcessLog(input, {
    publicationResidueAllowed: true,
  });
  if (inspected.status !== "publication_residue") return inspected;

  let finalStats;
  let residueStats;
  try {
    finalStats = lstatSync(inspected.path);
    residueStats = lstatSync(inspected.residuePath);
  } catch (error) {
    if (error?.code === "ENOENT") return inspectProcessLog(input);
    processLogFail(
      "invalid_process_log_environment",
      "process log publication residue is unavailable",
    );
  }
  if (
    finalStats.isSymbolicLink() ||
    !finalStats.isFile() ||
    finalStats.dev !== inspected.device ||
    finalStats.ino !== inspected.inode ||
    finalStats.nlink !== 2 ||
    residueStats.isSymbolicLink() ||
    !residueStats.isFile() ||
    residueStats.dev !== inspected.device ||
    residueStats.ino !== inspected.inode ||
    residueStats.nlink !== 2
  ) {
    processLogFileFail();
  }
  requireProcessLogAccess(inspected.path, finalStats);
  readValidatedProcessLog(inspected.path);
  try {
    finalStats = lstatSync(inspected.path);
    residueStats = lstatSync(inspected.residuePath);
  } catch (error) {
    if (error?.code === "ENOENT") return inspectProcessLog(input);
    processLogFail(
      "invalid_process_log_environment",
      "process log publication residue is unavailable",
    );
  }
  if (
    finalStats.isSymbolicLink() ||
    !finalStats.isFile() ||
    finalStats.dev !== inspected.device ||
    finalStats.ino !== inspected.inode ||
    finalStats.nlink !== 2 ||
    residueStats.isSymbolicLink() ||
    !residueStats.isFile() ||
    residueStats.dev !== inspected.device ||
    residueStats.ino !== inspected.inode ||
    residueStats.nlink !== 2
  ) {
    processLogFileFail();
  }
  try {
    unlinkSync(inspected.residuePath);
  } catch (error) {
    if (error?.code === "ENOENT") return inspectProcessLog(input);
    processLogFail("invalid_process_log_environment", "cannot finish process log publication");
  }
  return Object.freeze({
    ...inspectProcessLog(input),
    recovered: true,
  });
}

function emptyProcessLogBytes(clock = () => new Date().toISOString()) {
  const log = {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: clock(),
    companies: [],
    processes: [],
  };
  validateLogV3(log);
  return `${JSON.stringify(log, null, 2)}\n`;
}

function removeTemporaryProcessLog(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function initializeProcessLog(input) {
  const processLogPath = exactProcessLogPath(input);
  const temporaryPath = `${processLogPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    try {
      writeFileSync(temporaryPath, emptyProcessLogBytes(), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      processLogFail(
        "invalid_process_log_environment",
        `cannot prepare process log (${error?.code ?? "unknown"})`,
      );
    }
    try {
      linkSync(temporaryPath, processLogPath);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        processLogFail(
          "invalid_process_log_environment",
          `cannot initialize process log (${error?.code ?? "unknown"})`,
        );
      }
      return finishProcessLogPublication(input);
    }
  } finally {
    removeTemporaryProcessLog(temporaryPath);
  }
  return Object.freeze({
    ...inspectProcessLog(input),
    created: true,
  });
}

const GIT_TIMEOUT_MS = 5_000;

// Every variable that can point git at another repository or stop its upward search early. The
// list is the hook's, not the CI runner's: `GIT_COMMON_DIR` is what the check below compares
// against, and the runner's list does not carry it.
export const GIT_REDIRECTION_VARIABLES = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
]);

const REHEARSAL_BRANCH_PREFIX = "rehearsal/";

function gitEnvironment(environment = process.env) {
  const child = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || GIT_REDIRECTION_VARIABLES.includes(key)) continue;
    child[key] = value;
  }
  return child;
}

function gitLines(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(),
    shell: false,
    timeout: GIT_TIMEOUT_MS,
  });
  if (result.error || result.signal || result.status !== 0) return null;
  return String(result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim());
}

function repositoryMarkerAbove(directory) {
  let current = directory;
  for (;;) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Whether this workspace root is a place where a fictional candidate belongs.
 *
 * Two places qualify, and they are two of the three where `bootstrap --init` runs legally at all:
 * a disposable root, which lies outside every repository, and a rehearsal worktree, which is a
 * linked worktree on a `rehearsal/` branch. The third legal place is the operational checkout,
 * and it is exactly the one that must never receive the example: a fictional profile that arrived
 * there by accident would end up under a real cover letter. A development worktree is not on the
 * list either — the runbook forbids `--init` there, and a task tree is not meant to hold the
 * private layer at all.
 *
 * Every direction of refusal is named, because the dangerous default is the silent one: an
 * unresolvable topology is never read as "then it is not the operational checkout".
 *
 * The operational folder that `tools/ops-tree/` builds lies outside every repository, so the
 * topology alone would read it as a disposable root. Its marker — the manifest, or the service
 * directory the tool never removes — is checked first: the real layer there comes from a tag, and
 * the example never does.
 */
export function candidateSeedPlacement(workspaceRoot) {
  if (
    existsSync(join(workspaceRoot, MANIFEST_FILE_NAME)) ||
    existsSync(join(workspaceRoot, SERVICE_DIRECTORY_NAME))
  ) {
    return { allowed: false, code: "candidate_seed_refused_in_operational_folder" };
  }
  if (!repositoryMarkerAbove(workspaceRoot)) return { allowed: true };
  const directories = gitLines(workspaceRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
  ]);
  if (!directories) {
    return { allowed: false, code: "candidate_seed_refused_unresolved_topology" };
  }
  const [gitDir, commonDir] = directories;
  if (!gitDir || !commonDir || !isAbsolute(gitDir) || !isAbsolute(commonDir)) {
    return { allowed: false, code: "candidate_seed_refused_unresolved_topology" };
  }
  if (gitDir === commonDir) {
    return { allowed: false, code: "candidate_seed_refused_in_operational_checkout" };
  }
  const branch = gitLines(workspaceRoot, ["branch", "--show-current"]);
  if (!branch || branch[0] === "") {
    return { allowed: false, code: "candidate_seed_refused_unresolved_topology" };
  }
  if (!branch[0].startsWith(REHEARSAL_BRANCH_PREFIX)) {
    return { allowed: false, code: "candidate_seed_refused_in_development_worktree" };
  }
  return { allowed: true };
}

/**
 * Copies the example into place under a name nobody else is using, then publishes it with one
 * rename. Sixteen `--init` runs may race here, and the pin that says so requires every one of
 * them to exit zero: the loser sees `EEXIST` or `ENOTEMPTY`, reads it as "already there", and
 * reports the layer rather than failing. The staging directory is unique per attempt — a shared
 * name would let one run's cleanup delete another run's half-written copy — and it is removed in
 * `finally`, because a leaked one is a path the operational checkout would then carry.
 */
function seedCandidate(destination, exampleRoot, workspaceRoot) {
  if (!existsSync(exampleRoot)) {
    return { code: "candidate_seed_example_missing", created: false };
  }
  let staging;
  try {
    staging = mkdtempSync(join(workspaceRoot, ".candidate-seed-"));
    const staged = join(staging, "candidate");
    cpSync(exampleRoot, staged, { dereference: false, force: false, recursive: true });
    renameSync(staged, destination);
    return { created: true };
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") return { created: false };
    return { code: "candidate_seed_failed", created: false };
  } finally {
    if (staging) rmSync(staging, { force: true, recursive: true });
  }
}

/**
 * The candidate section of the report.
 *
 * `--check` is loud about a present but broken layer: saying "checked" over a config nobody could
 * read is the one outcome a check must not have. `--init` is never loud — it still has an output
 * root and a ledger to create, and the documented setup command has to stay usable — so every
 * refusal it meets becomes a field with a code.
 *
 * Both halves of the layer are read, the config and the constraints, and for the same reason: a
 * broken `constraints.json` is a file the run would refuse later, so a check that stayed silent
 * about it would be reporting "checked" over exactly what it could not read. The report keeps its
 * shape — `status` and, for `--init`, a code — because the two readers fail the same way.
 */
function readCandidateLayer(root) {
  const inspected = inspectCandidateLayer({ root });
  loadAllCandidateConstraints({ root });
  return inspected;
}

function prepareCandidate(input, { seed }) {
  const root = candidateRootFor(input.workspaceRoot);
  if (!seed) {
    const inspected = readCandidateLayer(root);
    return Object.freeze({ created: false, path: root, status: inspected.status });
  }
  let inspected;
  try {
    inspected = readCandidateLayer(root);
  } catch (error) {
    if (!(error instanceof CandidateError)) throw error;
    return Object.freeze({ created: false, error: error.code, path: root, status: "invalid" });
  }
  if (inspected.status === "ready") {
    return Object.freeze({ created: false, path: root, status: "ready" });
  }
  const placement = candidateSeedPlacement(input.workspaceRoot);
  if (!placement.allowed) {
    return Object.freeze({
      created: false,
      path: root,
      refused: placement.code,
      status: "absent",
    });
  }
  const seeded = seedCandidate(root, candidateExampleRootFor(repoRoot), input.workspaceRoot);
  if (seeded.code) {
    return Object.freeze({ created: false, path: root, refused: seeded.code, status: "absent" });
  }
  try {
    return Object.freeze({
      created: seeded.created,
      path: root,
      status: readCandidateLayer(root).status,
    });
  } catch (error) {
    if (!(error instanceof CandidateError)) throw error;
    return Object.freeze({
      created: seeded.created,
      error: error.code,
      path: root,
      status: "invalid",
    });
  }
}

/**
 * The operational folder's drift check, run first so a drifted folder is refused before anything
 * else is read. It checks the tree this file lies in; a tree without the marker reports nothing.
 */
export function checkOperationalFolder(root = repoRoot) {
  let verified;
  try {
    verified = verifyFolder(root);
  } catch (error) {
    if (error instanceof OpsTreeError) throw new BootstrapCliError(error.code, error.message);
    throw error;
  }
  return verified.status === "clean" ? manifestSummary(verified.manifest) : null;
}

function parseMode(argv) {
  if (argv.length !== 1 || (argv[0] !== "--init" && argv[0] !== "--check")) {
    throw new BootstrapCliError(
      "invalid_bootstrap_arguments",
      "use exactly one of --init or --check",
    );
  }
  return argv[0];
}

function printResult(
  status,
  result,
  processLog,
  toolchain = null,
  candidate = null,
  opsTree = null,
) {
  process.stdout.write(
    `${JSON.stringify({
      status,
      created: {
        output_root: result.status === "initialized",
        process_log: processLog.created,
      },
      recovered: {
        process_log: processLog.recovered,
      },
      ...(candidate ? { candidate } : {}),
      ...(opsTree ? { ops_tree: opsTree } : {}),
      output_root: result.outputPath,
      process_log: processLog.path,
      workspace_root: result.workspacePath,
      ...(toolchain ? { toolchain } : {}),
    })}\n`,
  );
}

function printError(error) {
  const known =
    error instanceof BootstrapCliError ||
    error instanceof CandidateError ||
    error instanceof OutputRootError ||
    error instanceof ToolchainPreflightError ||
    error instanceof CvBuilderDependencyError;
  process.stderr.write(
    `${JSON.stringify({
      status: "error",
      error: {
        code: known ? error.code : "bootstrap_failed",
        message: known ? error.message : "bootstrap failed unexpectedly",
      },
    })}\n`,
  );
}

export function main(argv = process.argv.slice(2)) {
  try {
    const mode = parseMode(argv);
    const input = environment();
    if (mode === "--init") {
      const inspectedProcessLog = inspectProcessLog(input, {
        missingAllowed: true,
        publicationResidueAllowed: true,
      });
      const result = initializeOutputRoot(input);
      let processLog;
      if (inspectedProcessLog.status === "missing") {
        processLog = initializeProcessLog(input);
      } else if (inspectedProcessLog.status === "publication_residue") {
        processLog = finishProcessLogPublication(input);
      } else {
        processLog = inspectProcessLog(input);
      }
      const candidate = prepareCandidate(input, { seed: true });
      const status =
        result.status === "initialized" || processLog.created || processLog.recovered
          ? "initialized"
          : "ready";
      printResult(status, result, processLog, null, candidate);
    } else {
      const opsTree = checkOperationalFolder();
      const result = checkOutputRoot(input);
      const processLog = inspectProcessLog(input);
      const candidate = prepareCandidate(input, { seed: false });
      const toolchain = checkToolchain();
      printResult("ready", result, processLog, toolchain, candidate, opsTree);
    }
  } catch (error) {
    printError(error);
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
