import { accessSync, constants, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class OutputRootError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OutputRootError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new OutputRootError(code, message);
}

function requireExactAbsolutePath(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid_output_environment", `${field} must be a non-empty string`);
  }
  if (!isAbsolute(value) || value !== resolve(value)) {
    fail("invalid_output_environment", `${field} must be an absolute normalized path`);
  }
  return value;
}

function expectedCanonicalPath(path) {
  const temporaryPath = resolve(tmpdir());
  const temporaryRealPath = realpathSync(temporaryPath);
  if (
    temporaryPath !== temporaryRealPath &&
    (path === temporaryPath || path.startsWith(`${temporaryPath}${sep}`))
  ) {
    return resolve(temporaryRealPath, relative(temporaryPath, path));
  }
  return path;
}

function inspectDirectory(path, field, { missingIsBootstrap = false } = {}) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (missingIsBootstrap && error.code === "ENOENT") {
      fail("bootstrap_required", "output root is missing; run npm run bootstrap:init");
    }
    fail("invalid_output_environment", `${field} is unavailable (${error.code ?? "unknown"})`);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("invalid_output_environment", `${field} must be a non-symlink directory`);
  }

  let realPath;
  try {
    realPath = realpathSync(path);
  } catch (error) {
    fail(
      "invalid_output_environment",
      `${field} realpath is unavailable (${error.code ?? "unknown"})`,
    );
  }
  if (realPath !== expectedCanonicalPath(path)) {
    fail("invalid_output_environment", `${field} must not use a symlinked path or ancestor`);
  }
  return { realPath, stats };
}

function requireDirectoryAccess(path, stats, field) {
  const hasRead = (stats.mode & 0o444) !== 0;
  const hasWrite = (stats.mode & 0o222) !== 0;
  const hasExecute = (stats.mode & 0o111) !== 0;
  if (!hasRead || !hasWrite || !hasExecute) {
    fail("invalid_output_environment", `${field} must be readable, writable, and searchable`);
  }
  try {
    accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (error) {
    fail(
      "invalid_output_environment",
      `${field} is not readable, writable, and searchable (${error.code ?? "unknown"})`,
    );
  }
}

function requireOutputPaths({ outputRoot, workspaceRoot }) {
  const workspacePath = requireExactAbsolutePath(workspaceRoot, "workspaceRoot");
  const outputPath = requireExactAbsolutePath(outputRoot, "outputRoot");
  if (outputPath !== resolve(workspacePath, "output")) {
    fail(
      "invalid_output_environment",
      "outputRoot must be the exact workspaceRoot/output directory",
    );
  }
  return { outputPath, workspacePath };
}

export function checkOutputRoot(input) {
  const { outputPath, workspacePath } = requireOutputPaths(input);
  const workspace = inspectDirectory(workspacePath, "workspaceRoot");
  requireDirectoryAccess(workspacePath, workspace.stats, "workspaceRoot");
  const output = inspectDirectory(outputPath, "outputRoot", { missingIsBootstrap: true });
  requireDirectoryAccess(outputPath, output.stats, "outputRoot");
  if (output.realPath !== resolve(workspace.realPath, "output")) {
    fail(
      "invalid_output_environment",
      "outputRoot realpath must be the exact workspaceRoot/output directory",
    );
  }
  return Object.freeze({
    outputPath,
    outputRealPath: output.realPath,
    workspacePath,
    workspaceRealPath: workspace.realPath,
  });
}

export function initializeOutputRoot(input) {
  const paths = requireOutputPaths(input);
  const normalizedInput = {
    outputRoot: paths.outputPath,
    workspaceRoot: paths.workspacePath,
  };
  try {
    return Object.freeze({
      ...checkOutputRoot(normalizedInput),
      status: "ready",
    });
  } catch (error) {
    if (!(error instanceof OutputRootError) || error.code !== "bootstrap_required") {
      throw error;
    }
  }

  try {
    mkdirSync(paths.outputPath, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") {
      fail(
        "invalid_output_environment",
        `cannot initialize outputRoot (${error.code ?? "unknown"})`,
      );
    }
    return Object.freeze({
      ...checkOutputRoot(normalizedInput),
      status: "ready",
    });
  }

  return Object.freeze({
    ...checkOutputRoot(normalizedInput),
    status: "initialized",
  });
}
