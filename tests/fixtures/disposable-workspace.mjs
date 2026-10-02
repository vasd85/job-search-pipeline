import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

export const disposableMarkerFileName =
  ".job-pipeline-disposable-workspace.json";
export const disposableTokenEnvironmentVariable =
  "JOB_PIPELINE_DISPOSABLE_ROOT_TOKEN";

const markerKind = "job-search-pipeline-disposable-workspace";
const markerSchemaVersion = 1;
const markerKeys = Object.freeze([
  "kind",
  "nonce",
  "schema_version",
  "workspace_lexical_path",
  "workspace_real_path",
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertAbsoluteNormalizedPath(value, field) {
  if (
    typeof value !== "string"
    || !isAbsolute(value)
    || value !== resolve(value)
  ) {
    fail(
      "invalid_disposable_path",
      `${field} must be an absolute normalized path`,
    );
  }
  return value;
}

function assertExactKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_disposable_marker", "disposable marker must be an object");
  }
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(markerKeys)) {
    fail(
      "invalid_disposable_marker",
      "disposable marker has unexpected fields",
    );
  }
}

function inspectDirectory(path, code, message) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    fail(code, message);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) fail(code, message);
  return stats;
}

function inspectRegularFile(path, code, message, {
  singleLink = false,
  resampleUnlinked = false,
} = {}) {
  let stats;
  for (let sample = 0; sample < (resampleUnlinked ? 4 : 1); sample += 1) {
    try {
      stats = lstatSync(path);
    } catch {
      fail(code, message);
    }
    // An atomic ledger replacement can unlink the inode lstat just looked up.
    // Resample that transient snapshot; never accept a zero-link file itself.
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 0) break;
  }
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
    || (singleLink && stats.nlink !== 1)
  ) {
    fail(code, message);
  }
  return stats;
}

function assertRealPath(path, expected, code, message) {
  let actual;
  try {
    actual = realpathSync(path);
  } catch {
    fail(code, message);
  }
  if (actual !== expected) fail(code, message);
}

function markerPathFor(workspaceRoot) {
  return join(workspaceRoot, disposableMarkerFileName);
}

function parseMarker(markerPath) {
  const markerStats = inspectRegularFile(
    markerPath,
    "invalid_disposable_marker",
    "disposable marker must be a single-link regular file",
    { singleLink: true },
  );
  if ((markerStats.mode & 0o077) !== 0) {
    fail(
      "invalid_disposable_marker",
      "disposable marker permissions are too broad",
    );
  }
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    fail("invalid_disposable_marker", "disposable marker must be valid JSON");
  }
  assertExactKeys(marker);
  return marker;
}

export function assertDisposableWorkspace(
  environment,
  {
    requireLedger = true,
    requireOutput = true,
  } = {},
) {
  if (!environment || typeof environment !== "object") {
    fail(
      "invalid_disposable_environment",
      "disposable environment must be an object",
    );
  }
  const workspaceRoot = assertAbsoluteNormalizedPath(
    environment.workspaceRoot,
    "workspaceRoot",
  );
  const outputRoot = assertAbsoluteNormalizedPath(
    environment.outputRoot,
    "outputRoot",
  );
  const ledgerPath = assertAbsoluteNormalizedPath(
    environment.ledgerPath,
    "ledgerPath",
  );
  if (
    typeof environment.markerToken !== "string"
    || environment.markerToken.length < 20
  ) {
    fail(
      "invalid_disposable_token",
      "disposable marker token is missing or invalid",
    );
  }

  inspectDirectory(
    workspaceRoot,
    "invalid_disposable_workspace",
    "disposable workspace must be a non-symlink directory",
  );
  const markerPath = markerPathFor(workspaceRoot);
  const marker = parseMarker(markerPath);
  if (
    marker.kind !== markerKind
    || marker.schema_version !== markerSchemaVersion
    || marker.nonce !== environment.markerToken
  ) {
    fail(
      "invalid_disposable_marker",
      "disposable marker identity does not match",
    );
  }
  if (marker.workspace_lexical_path !== workspaceRoot) {
    fail(
      "disposable_workspace_alias",
      "disposable workspace lexical identity does not match",
    );
  }
  assertRealPath(
    workspaceRoot,
    marker.workspace_real_path,
    "disposable_workspace_alias",
    "disposable workspace real identity does not match",
  );
  const temporaryRootRealPath = realpathSync(tmpdir());
  if (dirname(marker.workspace_real_path) !== temporaryRootRealPath) {
    fail(
      "invalid_disposable_workspace",
      "disposable workspace must be created directly under the system temporary root",
    );
  }

  const expectedOutputRoot = join(workspaceRoot, "output");
  const expectedLedgerPath = join(workspaceRoot, "process-log.json");
  if (outputRoot !== expectedOutputRoot) {
    fail(
      "invalid_disposable_output",
      "outputRoot must be the exact disposable workspace output directory",
    );
  }
  if (ledgerPath !== expectedLedgerPath) {
    fail(
      "invalid_disposable_ledger",
      "ledgerPath must be the exact disposable workspace process log",
    );
  }

  if (requireOutput || existsSync(outputRoot)) {
    inspectDirectory(
      outputRoot,
      "invalid_disposable_output",
      "disposable output root must be a non-symlink directory",
    );
    assertRealPath(
      outputRoot,
      join(marker.workspace_real_path, "output"),
      "invalid_disposable_output",
      "disposable output root real identity does not match",
    );
  }
  if (requireLedger || existsSync(ledgerPath)) {
    inspectRegularFile(
      ledgerPath,
      "invalid_disposable_ledger",
      "disposable ledger must be a single-link regular file",
      { singleLink: true, resampleUnlinked: true },
    );
    assertRealPath(
      ledgerPath,
      join(marker.workspace_real_path, "process-log.json"),
      "invalid_disposable_ledger",
      "disposable ledger real identity does not match",
    );
  }

  return environment;
}

function safeCleanup(workspaceRoot, workspaceRealPath, identity) {
  if (!existsSync(workspaceRoot)) return;
  const current = inspectDirectory(
    workspaceRoot,
    "unsafe_disposable_cleanup",
    "refusing to clean a replaced disposable workspace",
  );
  if (current.dev !== identity.dev || current.ino !== identity.ino) {
    fail(
      "unsafe_disposable_cleanup",
      "refusing to clean a replaced disposable workspace",
    );
  }
  assertRealPath(
    workspaceRoot,
    workspaceRealPath,
    "unsafe_disposable_cleanup",
    "refusing to clean a replaced disposable workspace",
  );
  rmSync(workspaceRoot, { recursive: true, force: true });
}

export function createDisposableWorkspace(
  t,
  {
    createOutput = true,
    ledger,
    prefix = "job-search-disposable-",
  } = {},
) {
  if (
    typeof prefix !== "string"
    || !/^[a-z0-9][a-z0-9-]*-$/.test(prefix)
  ) {
    fail(
      "invalid_disposable_prefix",
      "disposable prefix must be lowercase alphanumeric with hyphens and end in a hyphen",
    );
  }
  const workspaceRoot = resolve(mkdtempSync(join(tmpdir(), prefix)));
  const workspaceRealPath = realpathSync(workspaceRoot);
  const identity = statSync(workspaceRoot);
  const markerToken = randomUUID();
  const markerPath = markerPathFor(workspaceRoot);
  const marker = {
    kind: markerKind,
    nonce: markerToken,
    schema_version: markerSchemaVersion,
    workspace_lexical_path: workspaceRoot,
    workspace_real_path: workspaceRealPath,
  };
  const markerDescriptor = openSync(markerPath, "wx", 0o600);
  try {
    writeFileSync(markerDescriptor, `${JSON.stringify(marker)}\n`, "utf8");
  } finally {
    closeSync(markerDescriptor);
  }
  if (createOutput) mkdirSync(join(workspaceRoot, "output"));
  if (ledger !== undefined) {
    const contents = typeof ledger === "string"
      ? ledger
      : `${JSON.stringify(ledger, null, 2)}\n`;
    writeFileSync(
      join(workspaceRoot, "process-log.json"),
      contents,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  }
  const environment = Object.freeze({
    ledgerPath: join(workspaceRoot, "process-log.json"),
    markerToken,
    outputRoot: join(workspaceRoot, "output"),
    workspaceRoot,
  });
  const cleanup = () =>
    safeCleanup(workspaceRoot, workspaceRealPath, identity);
  if (t?.after) t.after(cleanup);
  assertDisposableWorkspace(environment, {
    requireLedger: ledger !== undefined,
    requireOutput: createOutput,
  });
  return Object.freeze({ ...environment, cleanup });
}

export function disposableWorkspaceEnv(environment) {
  assertDisposableWorkspace(environment);
  return Object.freeze({
    JOB_PIPELINE_DISPOSABLE_ROOT_TOKEN: environment.markerToken,
    JOB_PIPELINE_OUTPUT_ROOT: environment.outputRoot,
    JOB_PIPELINE_PROCESS_LOG: environment.ledgerPath,
    JOB_PIPELINE_WORKSPACE_ROOT: environment.workspaceRoot,
  });
}

function requiredEnvironmentVariable(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    fail(
      "invalid_disposable_environment",
      "disposable child environment is incomplete",
    );
  }
  return value;
}

export function readDisposableWorkspaceEnv(environment = process.env) {
  return assertDisposableWorkspace({
    ledgerPath: requiredEnvironmentVariable(
      environment,
      "JOB_PIPELINE_PROCESS_LOG",
    ),
    markerToken: requiredEnvironmentVariable(
      environment,
      disposableTokenEnvironmentVariable,
    ),
    outputRoot: requiredEnvironmentVariable(
      environment,
      "JOB_PIPELINE_OUTPUT_ROOT",
    ),
    workspaceRoot: requiredEnvironmentVariable(
      environment,
      "JOB_PIPELINE_WORKSPACE_ROOT",
    ),
  });
}
