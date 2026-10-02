import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import * as nodeFileSystem from "node:fs";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  SafeCliInputError,
  hydrateSafeCliOptions,
  readSafeCliInput,
  safeCliInputMaxBytes,
  safeCliInputStringListDefaults,
} from "../tools/lib/safe-cli-input.mjs";
import {
  processLogDiagnosticLimits,
  processLogDiagnosticProblems,
} from "../tools/lib/process-log-diagnostics.mjs";
import {
  createDisposableWorkspace,
  disposableWorkspaceEnv,
} from "./fixtures/disposable-workspace.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(repoRoot, "tests/fixtures/process-log-cli-child.mjs");
const lockChildPath = resolve(repoRoot, "tests/fixtures/process-log-lock-child.mjs");
const expectedSafeInputModes = Object.freeze([
  "safe-blocked-contender",
  "safe-direct-successor",
  "safe-release-owner",
  "safe-supervisor-kill",
  "safe-supervisor-term",
]);
const expectedReceiptKeys = Object.freeze([
  "barriers",
  "children",
  "command",
  "head",
  "schemaVersion",
  "supervisor",
  "task",
]);
const expectedReceiptChildKeys = Object.freeze([
  "argv",
  "boundedStderrCode",
  "index",
  "numericExitCode",
  "role",
  "signal",
  "spawnErrorCode",
  "stdoutErrorCode",
  "stdoutStatus",
]);
const expectedReceiptCommand = Object.freeze([
  process.execPath,
  "--test",
  "tests/process-log-concurrency.test.mjs",
  "tests/safe-cli-input.test.mjs",
]);
const supervisorPhaseDeadlineMilliseconds = 5_000;
const supervisorTerminationGraceMilliseconds = 1_000;
const executedSafeInputModes = new Set();

test("safe transport and persisted diagnostics share one frozen numeric owner", () => {
  assert.deepEqual(processLogDiagnosticLimits, {
    codeMaxBytes: 64,
    detailMaxBytes: 256,
    detailsMaxItems: 8,
    messageMaxBytes: 512,
  });
  assert.deepEqual(processLogDiagnosticProblems({
    code: "a".repeat(64),
    message: "safe diagnostic",
    details: [],
  }, "diagnostic"), []);
  assert.deepEqual(processLogDiagnosticProblems({
    code: "a".repeat(65),
    message: "safe diagnostic",
    details: [],
  }, "diagnostic"), ["diagnostic.code must be at most 64 UTF-8 bytes"]);
});
const blockedVacancyFixturePath = resolve(
  repoRoot,
  "tools/pipeline-artifacts/fixtures/vacancy-blocked/vacancy.json",
);
const blockedJobDescriptionFixturePath = resolve(
  repoRoot,
  "tools/pipeline-artifacts/fixtures/vacancy-blocked/job-description.txt",
);

function emptyV3Log() {
  return {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: "2026-07-31T08:00:00.000Z",
    companies: [],
    processes: [],
  };
}

function ensureInputRoot(environment, name = ".pipeline-input") {
  const inputRoot = join(environment.workspaceRoot, name);
  if (!existsSync(inputRoot)) mkdirSync(inputRoot, { mode: 0o700 });
  chmodSync(inputRoot, 0o700);
  return realpathSync(inputRoot);
}

function createSafeInput(
  environment,
  command,
  values,
  {
    inputRoot = ensureInputRoot(environment),
    nonce = randomBytes(16).toString("hex"),
    source,
  } = {},
) {
  const basename = `input-${nonce}.json`;
  const path = join(inputRoot, basename);
  const contents = source === undefined
    ? `${JSON.stringify({
      schemaVersion: 1,
      command,
      nonce,
      values,
    })}\n`
    : typeof source === "function"
      ? source(nonce)
      : source;
  writeFileSync(path, contents, {
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(path, 0o600);
  return {
    basename,
    inputRoot,
    nonce,
    path,
  };
}

function cliEnvironment(environment, inputRoot) {
  return {
    ...process.env,
    ...disposableWorkspaceEnv(environment),
    JOB_PIPELINE_INPUT_ROOT: inputRoot,
  };
}

function runCli(environment, inputRoot, ...args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: cliEnvironment(environment, inputRoot),
  });
}

function requireCliSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function stageBlockedVacancy(environment, processRecord, publicationId) {
  const outputPath = resolve(
    environment.workspaceRoot,
    processRecord.output_dir,
  );
  const stagingPath = join(outputPath, ".pipeline-tmp", publicationId);
  mkdirSync(stagingPath, { recursive: true });
  copyFileSync(
    blockedJobDescriptionFixturePath,
    join(stagingPath, "job-description.txt"),
  );
  const vacancy = JSON.parse(
    readFileSync(blockedVacancyFixturePath, "utf8"),
  );
  // A publication writes the current version. A blocked vacancy names no market, so the workspace
  // needs no candidate layer for it.
  vacancy.schemaVersion = 2;
  vacancy.process.id = processRecord.id;
  vacancy.process.sourceRef = processRecord.source_ref;
  vacancy.process.outputDir = processRecord.output_dir;
  vacancy.role.company = processRecord.company_observed;
  vacancy.role.title = processRecord.role;
  writeFileSync(
    join(stagingPath, "vacancy.json"),
    `${JSON.stringify(vacancy, null, 2)}\n`,
    "utf8",
  );
}

function classifyNativeChildOutcome(error) {
  return {
    numericExitCode: Number.isInteger(error?.code) ? error.code : error ? null : 0,
    signal: error?.signal ?? null,
    spawnErrorCode: typeof error?.code === "string" ? error.code : null,
  };
}

function runCliAsync(environment, inputRoot, ...args) {
  return new Promise((resolveRun) => {
    execFile(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: cliEnvironment(environment, inputRoot),
    }, (error, stdout, stderr) => {
      resolveRun({
        code: error?.code ?? 0,
        argv: [process.execPath, cliPath, ...args],
        ...classifyNativeChildOutcome(error),
        stderr,
        stdout,
      });
    });
  });
}

function launchLockCliAtExecutable(
  executable,
  environment,
  inputRoot,
  index,
  role,
  scenario,
  args,
) {
  const argv = [executable, lockChildPath, scenario, ...args];
  let resolveRun;
  const run = {
    argv,
    child: null,
    index,
    promise: new Promise((resolvePromise) => {
      resolveRun = resolvePromise;
    }),
    result: null,
    role,
    scenario,
  };
  run.child = execFile(executable, [lockChildPath, scenario, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: cliEnvironment(environment, inputRoot),
  }, (error, stdout, stderr) => {
    run.result = {
      argv,
      ...classifyNativeChildOutcome(error),
      stderr,
      stdout,
    };
    resolveRun(run.result);
  });
  return run;
}

function launchLockCli(environment, inputRoot, index, role, scenario, ...args) {
  return launchLockCliAtExecutable(
    process.execPath,
    environment,
    inputRoot,
    index,
    role,
    scenario,
    args,
  );
}

function fixtureMarkerPath(environment, marker) {
  return join(environment.workspaceRoot, `.lock-fixture-${marker}`);
}

function publishFixtureMarker(environment, marker) {
  writeFileSync(fixtureMarkerPath(environment, marker), `${process.pid}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function publishFixtureMarkerOnce(environment, marker) {
  const path = fixtureMarkerPath(environment, marker);
  if (existsSync(path)) return false;
  publishFixtureMarker(environment, marker);
  return true;
}

async function waitForFixtureMarker(environment, marker, signal) {
  const path = fixtureMarkerPath(environment, marker);
  while (!existsSync(path)) {
    if (signal.aborted) throw signal.reason;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

async function supervisePhase(phase, operation) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`oracle supervisor timed out during ${phase}`);
          error.code = "oracle_supervisor_timeout";
          error.phase = phase;
          controller.abort(error);
          reject(error);
        }, supervisorPhaseDeadlineMilliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parsedJsonOrNull(source) {
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

function boundedStderrCode(stderr) {
  if (typeof stderr !== "string") return "unparseable_stderr";
  if (stderr.trim() === "") return null;
  const parsed = parsedJsonOrNull(stderr);
  const code = parsed?.error?.code ?? parsed?.code ?? "unparseable_stderr";
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code)
    ? code
    : "invalid_stderr_code";
}

function boundedOutputCode(value, fallback) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value)
    ? value
    : fallback;
}

function observedChild(result, index, role) {
  const stdoutPayload = parsedJsonOrNull(result.stdout);
  return {
    argv: result.argv,
    boundedStderrCode: boundedStderrCode(result.stderr),
    index,
    numericExitCode: result.numericExitCode,
    role,
    signal: result.signal,
    spawnErrorCode: result.spawnErrorCode,
    stdoutErrorCode: boundedOutputCode(
      stdoutPayload?.error?.code,
      "invalid_stdout_error_code",
    ),
    stdoutStatus: boundedOutputCode(stdoutPayload?.status, "invalid_stdout_status"),
  };
}

function receiptError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertExactReceiptKeys(value, expected, code) {
  const actual = value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw receiptError(code, `${code}: unexpected keys`);
  }
}

function validNormalizedCode(value) {
  return value === null || (typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value));
}

function validateReceiptContract(receipt) {
  assertExactReceiptKeys(receipt, expectedReceiptKeys, "oracle_receipt_shape_invalid");
  if (receipt.schemaVersion !== 1 || receipt.task !== "R1-03E") {
    throw receiptError("oracle_receipt_shape_invalid", "receipt identity is invalid");
  }
  if (typeof receipt.head !== "string" || !/^[0-9a-f]{40}$/.test(receipt.head)) {
    throw receiptError("oracle_receipt_head_invalid", "receipt HEAD is invalid");
  }
  if (JSON.stringify(receipt.command) !== JSON.stringify(expectedReceiptCommand)) {
    throw receiptError("oracle_receipt_command_invalid", "receipt command is invalid");
  }
  if (receipt.barriers === null || typeof receipt.barriers !== "object") {
    throw receiptError("oracle_receipt_shape_invalid", "receipt barriers are invalid");
  }
  if (receipt.supervisor === null || typeof receipt.supervisor !== "object") {
    throw receiptError("oracle_receipt_shape_invalid", "receipt supervisor is invalid");
  }
  if (!Array.isArray(receipt.children)) {
    throw receiptError("oracle_receipt_shape_invalid", "receipt children are invalid");
  }
  for (const [expectedIndex, child] of receipt.children.entries()) {
    assertExactReceiptKeys(child, expectedReceiptChildKeys, "oracle_receipt_child_invalid");
    if (child.index !== expectedIndex || typeof child.role !== "string") {
      throw receiptError("oracle_receipt_child_invalid", "receipt child identity is invalid");
    }
    if (!Array.isArray(child.argv) || child.argv.length > 16) {
      throw receiptError("oracle_receipt_argv_invalid", "receipt child argv count is invalid");
    }
    for (const argument of child.argv) {
      if (typeof argument !== "string" || Buffer.byteLength(argument, "utf8") > 1_024) {
        throw receiptError("oracle_receipt_argv_invalid", "receipt child argv value is invalid");
      }
    }
    if (
      child.spawnErrorCode !== null
      && (
        typeof child.spawnErrorCode !== "string"
        || !/^[A-Z][A-Z0-9_]{0,63}$/.test(child.spawnErrorCode)
      )
    ) {
      throw receiptError("oracle_receipt_spawn_code_invalid", "native spawn code is invalid");
    }
    if (child.numericExitCode !== null && !Number.isInteger(child.numericExitCode)) {
      throw receiptError("oracle_receipt_exit_invalid", "numeric exit code is invalid");
    }
    if (
      child.signal !== null
      && (typeof child.signal !== "string" || !/^SIG[A-Z0-9]{1,29}$/.test(child.signal))
    ) {
      throw receiptError("oracle_receipt_signal_invalid", "child signal is invalid");
    }
    if (
      !validNormalizedCode(child.stdoutStatus)
      || !validNormalizedCode(child.stdoutErrorCode)
      || !validNormalizedCode(child.boundedStderrCode)
    ) {
      throw receiptError("oracle_receipt_code_invalid", "normalized child code is invalid");
    }
  }
  return receipt;
}

function serializeReceipt(receipt) {
  validateReceiptContract(receipt);
  const source = `${JSON.stringify(receipt, null, 2)}\n`;
  if (Buffer.byteLength(source, "utf8") > 32_768) {
    throw receiptError("oracle_receipt_too_large", "receipt exceeds 32768 UTF-8 bytes");
  }
  return source;
}

function receiptPathFor(environment, variant) {
  if (variant === "accepted" && process.env.R1_03E_RECEIPT_PATH !== undefined) {
    return process.env.R1_03E_RECEIPT_PATH;
  }
  return join(environment.workspaceRoot, `r1-03e-${variant}-receipt.json`);
}

function writeR103eReceipt(environment, variant, receipt) {
  const receiptPath = receiptPathFor(environment, variant);
  if (resolve(receiptPath) !== receiptPath) {
    throw receiptError("oracle_receipt_path_invalid", "receipt path must be absolute");
  }
  const receiptParent = realpathSync(dirname(receiptPath));
  const systemTemporaryRoot = realpathSync(tmpdir());
  if (dirname(receiptParent) !== systemTemporaryRoot) {
    throw receiptError(
      "oracle_receipt_path_invalid",
      "receipt evidence directory must be a direct child of the system temporary root",
    );
  }
  const source = serializeReceipt(receipt);
  writeFileSync(receiptPath, source, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return { path: receiptPath, source };
}

function currentHead() {
  const headResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (headResult.status !== 0) {
    throw receiptError("oracle_receipt_head_invalid", "cannot resolve receipt HEAD");
  }
  return headResult.stdout.trim();
}

function buildR103eReceipt({ barriers, children, head, supervisor }) {
  return {
    schemaVersion: 1,
    task: "R1-03E",
    head,
    command: [...expectedReceiptCommand],
    barriers,
    supervisor,
    children,
  };
}

function captureLockDirectory(lockPath) {
  const directoryStats = nodeFileSystem.lstatSync(lockPath);
  const entries = nodeFileSystem.readdirSync(lockPath).sort();
  const evidence = {
    directory: { dev: directoryStats.dev, ino: directoryStats.ino },
    entry: null,
    entryCount: entries.length,
  };
  let rawOwnerSource = null;
  if (entries.length === 1) {
    const entryPath = join(lockPath, entries[0]);
    const entryStats = nodeFileSystem.lstatSync(entryPath);
    const ownerBytes = readFileSync(entryPath);
    rawOwnerSource = ownerBytes.toString("utf8");
    evidence.entry = {
      bytes: ownerBytes.length,
      dev: entryStats.dev,
      ino: entryStats.ino,
      name: entries[0],
      ownerSha256: createHash("sha256").update(ownerBytes).digest("hex"),
      ownerToken: /^([0-9a-f]{32})\.json$/.exec(entries[0])?.[1] ?? null,
    };
  }
  return { evidence, rawOwnerSource };
}

function receiptChildrenFromRuns(runs) {
  return runs.map((run) => observedChild(run.result ?? {
    argv: run.argv,
    numericExitCode: null,
    signal: null,
    spawnErrorCode: "UNREAPED_CHILD",
    stderr: "",
    stdout: "",
  }, run.index, run.role));
}

async function waitAtMostOneSecondForChildren(runs) {
  return new Promise((resolveWait) => {
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolveWait(value);
    };
    const timer = setTimeout(() => finish(false), supervisorTerminationGraceMilliseconds);
    Promise.allSettled(runs.map(({ promise }) => promise)).then(() => finish(true));
  });
}

async function terminateAndReap(environment, runs, supervisor) {
  const releasePublished = publishFixtureMarkerOnce(environment, "safe-owner-release");
  supervisor.actions.push({ action: "release_owner", published: releasePublished });
  const runningBeforeTerm = runs.filter(({ result }) => result === null);
  const termIndexes = runningBeforeTerm.map(({ index }) => index);
  for (const run of runningBeforeTerm) run.child.kill("SIGTERM");
  supervisor.actions.push({ action: "signal", indexes: termIndexes, signal: "SIGTERM" });
  const allSettledAfterTerm = await waitAtMostOneSecondForChildren(runs);
  supervisor.actions.push({
    action: "wait_after_sigterm",
    allSettled: allSettledAfterTerm,
    milliseconds: supervisorTerminationGraceMilliseconds,
  });
  const runningBeforeKill = runs.filter(({ result }) => result === null);
  const killIndexes = runningBeforeKill.map(({ index }) => index);
  for (const run of runningBeforeKill) run.child.kill("SIGKILL");
  supervisor.actions.push({ action: "signal", indexes: killIndexes, signal: "SIGKILL" });
  await Promise.allSettled(runs.map(({ promise }) => promise));
  supervisor.reapedChildIndexes = runs
    .filter(({ result }) => result !== null)
    .map(({ index }) => index);
  supervisor.actions.push({ action: "reap", indexes: supervisor.reapedChildIndexes });
}

async function runSafeInputHandoffSchedule(environment, input, cliArgs) {
  const head = currentHead();
  const runs = [];
  const lockPath = `${environment.ledgerPath}.lock`;
  const barriers = {
    blockedContenderIndexes: [],
    childrenSettled: false,
    completed: [],
    enteredContenderIndexes: [],
    oldDirectory: null,
    ownerReleaseCode: null,
    successorAfterOldRelease: null,
    successorBeforeOldRelease: null,
  };
  const supervisor = {
    actions: [],
    outcome: "completed",
    phaseDeadlineMilliseconds: supervisorPhaseDeadlineMilliseconds,
    reapedChildIndexes: [],
    terminationGraceMilliseconds: supervisorTerminationGraceMilliseconds,
    timedOutPhase: null,
  };
  const snapshots = {
    oldDirectory: null,
    successorAfterOldRelease: null,
    successorBeforeOldRelease: null,
  };
  let scheduleError = null;
  let receiptFile;

  try {
    const owner = launchLockCli(
      environment,
      input.inputRoot,
      0,
      "owner",
      "safe-release-owner",
      ...cliArgs,
    );
    runs.push(owner);
    await supervisePhase("owner-empty", (signal) =>
      waitForFixtureMarker(environment, "safe-owner-empty", signal));
    barriers.completed.push("owner_empty");
    snapshots.oldDirectory = captureLockDirectory(lockPath);
    barriers.oldDirectory = snapshots.oldDirectory.evidence;

    const successor = launchLockCli(
      environment,
      input.inputRoot,
      1,
      "successor",
      "safe-direct-successor",
      ...cliArgs,
    );
    runs.push(successor);
    await supervisePhase("successor-direct-replacement", (signal) =>
      waitForFixtureMarker(environment, "safe-successor-replaced", signal));
    barriers.completed.push("successor_direct_replacement");
    await supervisePhase("successor-critical-section", (signal) =>
      waitForFixtureMarker(environment, "safe-successor-entered", signal));
    barriers.completed.push("successor_critical_section");
    snapshots.successorBeforeOldRelease = captureLockDirectory(lockPath);
    barriers.successorBeforeOldRelease = snapshots.successorBeforeOldRelease.evidence;

    const contenders = Array.from({ length: 10 }, (_, contenderIndex) => {
      const contenderId = String(contenderIndex).padStart(2, "0");
      const run = launchLockCli(
        environment,
        input.inputRoot,
        contenderIndex + 2,
        "ordinary-contender",
        "safe-blocked-contender",
        contenderId,
        ...cliArgs,
      );
      runs.push(run);
      return { contenderId, run };
    });
    await supervisePhase("contenders-blocked", (signal) => Promise.all(
      contenders.map(({ contenderId }) => waitForFixtureMarker(
        environment,
        `safe-contender-${contenderId}-blocked`,
        signal,
      )),
    ));
    barriers.blockedContenderIndexes = contenders.map(({ run }) => run.index);
    barriers.completed.push("contenders_blocked");
    barriers.enteredContenderIndexes = contenders
      .filter(({ contenderId }) => existsSync(
        fixtureMarkerPath(environment, `safe-contender-${contenderId}-entered`),
      ))
      .map(({ run }) => run.index);

    const ownerReleasePublished = publishFixtureMarkerOnce(environment, "safe-owner-release");
    supervisor.actions.push({ action: "release_owner", published: ownerReleasePublished });
    await supervisePhase("owner-release-blocked", async (signal) => {
      while (true) {
        const releaseCode = ["EEXIST", "ENOTEMPTY"].find((code) => existsSync(
          fixtureMarkerPath(environment, `safe-owner-release-blocked-${code.toLowerCase()}`),
        ));
        if (releaseCode !== undefined) {
          barriers.ownerReleaseCode = releaseCode;
          return;
        }
        if (signal.aborted) throw signal.reason;
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
    });
    barriers.completed.push("owner_release_blocked");
    snapshots.successorAfterOldRelease = captureLockDirectory(lockPath);
    barriers.successorAfterOldRelease = snapshots.successorAfterOldRelease.evidence;
    barriers.enteredContenderIndexes = contenders
      .filter(({ contenderId }) => existsSync(
        fixtureMarkerPath(environment, `safe-contender-${contenderId}-entered`),
      ))
      .map(({ run }) => run.index);

    const successorReleasePublished = publishFixtureMarkerOnce(
      environment,
      "safe-successor-release",
    );
    supervisor.actions.push({ action: "release_successor", published: successorReleasePublished });
    await supervisePhase("child-settle", () => Promise.all(runs.map(({ promise }) => promise)));
    barriers.childrenSettled = true;
    barriers.completed.push("children_settled");
    supervisor.reapedChildIndexes = runs.map(({ index }) => index);
  } catch (error) {
    scheduleError = error;
    supervisor.outcome = error.code ?? "oracle_schedule_failed";
    supervisor.timedOutPhase = error.code === "oracle_supervisor_timeout"
      ? error.phase
      : null;
    await terminateAndReap(environment, runs, supervisor);
    barriers.childrenSettled = runs.every(({ result }) => result !== null);
  } finally {
    const receipt = buildR103eReceipt({
      barriers,
      children: receiptChildrenFromRuns(runs),
      head,
      supervisor,
    });
    receiptFile = writeR103eReceipt(environment, "accepted", receipt);
  }
  return { barriers, head, receiptFile, runs, scheduleError, snapshots, supervisor };
}

async function runSupervisorFaultOracle(environment, inputRoot) {
  const head = currentHead();
  const runs = [
    launchLockCli(environment, inputRoot, 0, "supervisor-term", "safe-supervisor-term"),
    launchLockCli(environment, inputRoot, 1, "supervisor-kill", "safe-supervisor-kill"),
  ];
  const barriers = {
    childrenSettled: false,
    completed: [],
    ownerReleasePublished: false,
  };
  const supervisor = {
    actions: [],
    outcome: "completed",
    phaseDeadlineMilliseconds: supervisorPhaseDeadlineMilliseconds,
    reapedChildIndexes: [],
    terminationGraceMilliseconds: supervisorTerminationGraceMilliseconds,
    timedOutPhase: null,
  };
  let scheduleError = null;
  let receiptFile;
  try {
    await supervisePhase("fault-children-ready", (signal) => Promise.all([
      waitForFixtureMarker(environment, "safe-supervisor-term-ready", signal),
      waitForFixtureMarker(environment, "safe-supervisor-kill-ready", signal),
    ]));
    barriers.completed.push("fault_children_ready");
    await supervisePhase("fault-child-settle", (signal) =>
      waitForFixtureMarker(environment, "safe-supervisor-never", signal));
  } catch (error) {
    scheduleError = error;
    supervisor.outcome = error.code ?? "oracle_schedule_failed";
    supervisor.timedOutPhase = error.code === "oracle_supervisor_timeout"
      ? error.phase
      : null;
    await terminateAndReap(environment, runs, supervisor);
    barriers.ownerReleasePublished = existsSync(
      fixtureMarkerPath(environment, "safe-owner-release"),
    );
    barriers.childrenSettled = runs.every(({ result }) => result !== null);
  } finally {
    const receipt = buildR103eReceipt({
      barriers,
      children: receiptChildrenFromRuns(runs),
      head,
      supervisor,
    });
    receiptFile = writeR103eReceipt(environment, "supervisor-timeout", receipt);
  }
  return { barriers, head, receiptFile, runs, scheduleError, supervisor };
}

function minimalReceiptChild(overrides = {}) {
  return {
    argv: ["x"],
    boundedStderrCode: null,
    index: 0,
    numericExitCode: 0,
    role: "boundary",
    signal: null,
    spawnErrorCode: null,
    stdoutErrorCode: null,
    stdoutStatus: "created",
    ...overrides,
  };
}

function minimalReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    task: "R1-03E",
    head: "0".repeat(40),
    command: [...expectedReceiptCommand],
    barriers: {},
    supervisor: {},
    children: [minimalReceiptChild()],
    ...overrides,
  };
}

function receiptAtExactBytes(targetBytes) {
  const receipt = minimalReceipt({ children: [], supervisor: { padding: "" } });
  const emptySource = `${JSON.stringify(receipt, null, 2)}\n`;
  const paddingBytes = targetBytes - Buffer.byteLength(emptySource, "utf8");
  if (paddingBytes < 0) throw new Error("target receipt size is too small");
  receipt.supervisor.padding = "x".repeat(paddingBytes);
  return receipt;
}

function expectReceiptError(code, operation) {
  assert.throws(operation, (error) => error?.code === code);
}

function expectSafeError(code, operation) {
  assert.throws(
    operation,
    (error) => error instanceof SafeCliInputError && error.code === code,
  );
}

function withStatFields(stats, fields) {
  return new Proxy(stats, {
    get(target, property) {
      if (Object.hasOwn(fields, property)) return fields[property];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("shell-facing input-file keeps hostile source text literal", (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-shell-",
  });
  const dollarMarker = join(environment.workspaceRoot, "dollar-marker");
  const backtickMarker = join(environment.workspaceRoot, "backtick-marker");
  const sourceRef = [
    "direct-outreach:--literal",
    `$(touch ${dollarMarker})`,
    `\`touch ${backtickMarker}\``,
    "\"double\" 'single'",
    "line-one\nline-two",
    "; | < >",
    "Cafe\u0301 Café",
  ].join(" ");
  const input = createSafeInput(environment, "start", { sourceRef });
  const command = [
    "node tests/fixtures/process-log-cli-child.mjs start",
    `--input-file ${input.basename}`,
    "--runner codex",
  ].join(" ");
  const result = spawnSync("/bin/sh", ["-c", command], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...disposableWorkspaceEnv(environment),
      JOB_PIPELINE_INPUT_ROOT: input.inputRoot,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(dollarMarker), false);
  assert.equal(existsSync(backtickMarker), false);
  assert.equal(existsSync(input.path), true);
  const log = JSON.parse(readFileSync(environment.ledgerPath, "utf8"));
  assert.equal(log.processes.length, 1);
  assert.equal(log.processes[0].source_ref, sourceRef);
});

test("command envelopes map only external fields and preserve machine flags", (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-map-",
  });
  const cases = [
    {
      command: "start",
      machine: { runner: "codex" },
      values: { sourceRef: "direct-outreach:start", companyHint: "Start Co" },
      expected: { "source-ref": "direct-outreach:start", "company-hint": "Start Co" },
    },
    {
      command: "update",
      machine: { id: "proc_test" },
      values: { companyObserved: "Observed", role: "Role" },
      expected: { "company-observed": "Observed", role: "Role" },
    },
    {
      command: "resolve",
      machine: {},
      values: { sourceRef: "direct-outreach:resolve" },
      expected: { "source-ref": "direct-outreach:resolve" },
    },
    {
      command: "find-company",
      machine: {},
      values: { query: "Find Co" },
      expected: { query: "Find Co" },
    },
    {
      command: "create-company",
      machine: {},
      values: { displayName: "Create Co", term: "Variant", domain: "example.test" },
      expected: {
        "display-name": "Create Co",
        term: "Variant",
        domain: "example.test",
      },
    },
    {
      command: "rename-company",
      machine: { id: "company_test" },
      values: { displayName: "Renamed Co" },
      expected: { "display-name": "Renamed Co" },
    },
    {
      command: "add-company-term",
      machine: { id: "company_test" },
      values: { term: "Added Term" },
      expected: { term: "Added Term" },
    },
    {
      command: "remove-company-term",
      machine: { id: "company_test" },
      values: { term: "Removed Term" },
      expected: { term: "Removed Term" },
    },
    {
      command: "add-company-domain",
      machine: { id: "company_test" },
      values: { domain: "add.example.test" },
      expected: { domain: "add.example.test" },
    },
    {
      command: "remove-company-domain",
      machine: { id: "company_test" },
      values: { domain: "remove.example.test" },
      expected: { domain: "remove.example.test" },
    },
    {
      command: "publish-step",
      machine: {
        id: "proc_test",
        step: "get_vacancy",
        "attempt-id": "attempt_test",
        "publication-id": "publication_test",
        outcome: "blocked",
      },
      values: {
        blocker: {
          code: "market_ambiguous",
          message: "A market must be chosen.",
          retryable: true,
          details: ["safe detail"],
        },
      },
      objectOption: "blocker-json",
    },
    {
      command: "fail-step",
      machine: {
        id: "proc_test",
        step: "get_vacancy",
        "attempt-id": "attempt_test",
      },
      values: {
        error: {
          code: "vacancy_fetch_failed",
          message: "The vacancy could not be fetched.",
          retryable: true,
          details: [],
        },
      },
      objectOption: "error-json",
    },
    {
      command: "revise-step",
      machine: {
        id: "proc_test",
        step: "write_cover_letter",
        channel: "chat_command",
      },
      values: {
        waivers: [
          {
            subject: { kind: "check", key: "letter_keyword:0" },
            note: "Пользователь осознанно принял отсутствие термина в письме.",
          },
          { subject: { kind: "decision", key: "evidence-links:closing-bullet" } },
        ],
      },
      waiverOption: "waivers-json",
    },
  ];

  for (const fixture of cases) {
    const input = createSafeInput(
      environment,
      fixture.command,
      fixture.values,
    );
    const hydrated = hydrateSafeCliOptions({
      command: fixture.command,
      inputRoot: input.inputRoot,
      options: {
        ...fixture.machine,
        "input-file": input.basename,
      },
    });
    assert.equal(hydrated.transported, true);
    assert.equal(Object.hasOwn(hydrated.options, "input-file"), false);
    for (const [key, value] of Object.entries(fixture.machine)) {
      assert.equal(hydrated.options[key], value);
    }
    if (fixture.objectOption) {
      const [value] = Object.values(fixture.values);
      assert.deepEqual(
        JSON.parse(hydrated.options[fixture.objectOption]),
        {
          code: value.code,
          message: fixture.objectOption === "blocker-json"
            ? "The operation stopped on a controlled blocker."
            : "The operation ended with a controlled error.",
          retryable: value.retryable,
          details: [],
        },
      );
    } else if (fixture.waiverOption) {
      // Unlike the diagnostic classes, waiver records carry the user-owned note verbatim as
      // bounded data: the note is a journaled record (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#5-edit-channels-and-transports(a)).
      assert.deepEqual(
        JSON.parse(hydrated.options[fixture.waiverOption]),
        fixture.values.waivers,
      );
    } else {
      for (const [key, value] of Object.entries(fixture.expected)) {
        assert.equal(hydrated.options[key], value);
      }
    }
  }
});

test("revise-step waiver records are bounded and shape-checked at the transport", (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-waivers-",
  });
  const hydrate = (waivers) => {
    const input = createSafeInput(environment, "revise-step", { waivers });
    return () =>
      hydrateSafeCliOptions({
        command: "revise-step",
        inputRoot: input.inputRoot,
        options: {
          id: "proc_test",
          step: "write_cover_letter",
          channel: "chat_command",
          "input-file": input.basename,
        },
      });
  };

  expectSafeError("safe_input_schema_mismatch", hydrate([
    { subject: { kind: "veto", key: "letter_keyword:0" } },
  ]));
  expectSafeError("safe_input_schema_mismatch", hydrate([
    { subject: { kind: "check", key: "" } },
  ]));
  expectSafeError("safe_input_schema_mismatch", hydrate([
    { subject: { kind: "check", key: "x".repeat(257) } },
  ]));
  expectSafeError("safe_input_schema_mismatch", hydrate([
    {
      subject: { kind: "check", key: "letter_keyword:0" },
      note: "х".repeat(300),
    },
  ]));
  expectSafeError("safe_input_schema_mismatch", hydrate([
    {
      subject: { kind: "check", key: "letter_keyword:0" },
      unexpected: "field",
    },
  ]));
  expectSafeError("safe_input_schema_mismatch", hydrate(
    [...Array(17).keys()].map((index) => ({
      subject: { kind: "check", key: `letter_keyword:${index}` },
    })),
  ));

  const accepted = hydrate([
    { subject: { kind: "check", key: "letter_keyword:0" }, note: "Осознанное отклонение." },
  ])();
  assert.equal(accepted.transported, true);
  assert.deepEqual(JSON.parse(accepted.options["waivers-json"]), [
    { subject: { kind: "check", key: "letter_keyword:0" }, note: "Осознанное отклонение." },
  ]);
});

test("publish-step carries the letter word-limit approval through the same waiver transport", (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-publish-waivers-",
  });
  const hydrate = (values) => {
    const input = createSafeInput(environment, "publish-step", values);
    return () =>
      hydrateSafeCliOptions({
        command: "publish-step",
        inputRoot: input.inputRoot,
        options: {
          id: "proc_test",
          step: "write_cover_letter",
          "attempt-id": "attempt_test",
          "publication-id": "publication_test",
          outcome: "completed",
          "input-file": input.basename,
        },
      });
  };

  expectSafeError("safe_input_schema_mismatch", hydrate({
    waivers: [{ subject: { kind: "veto", key: "letter_body_words_max:280" } }],
  }));
  expectSafeError("safe_input_schema_mismatch", hydrate({
    waivers: [{ subject: { kind: "check", key: "letter_body_words_max:280" }, unexpected: "f" }],
  }));

  const accepted = hydrate({
    waivers: [{
      subject: { kind: "check", key: "letter_body_words_max:280" },
      note: "Пользователь: публикуй как есть.",
    }],
  })();
  assert.equal(accepted.transported, true);
  assert.deepEqual(JSON.parse(accepted.options["waivers-json"]), [{
    subject: { kind: "check", key: "letter_body_words_max:280" },
    note: "Пользователь: публикуй как есть.",
  }]);

  const withBlocker = hydrate({
    blocker: {
      code: "source_unreadable",
      message: "A synthetic blocker.",
      retryable: true,
    },
  })();
  assert.equal(withBlocker.transported, true);
  assert.equal(
    "waivers-json" in withBlocker.options,
    false,
    "the blocker envelope publish-step already accepted is unchanged",
  );
});

test("transport conflicts fail before root or ledger access", () => {
  const missingRoot = "/definitely/missing/job-pipeline-input-root";
  expectSafeError("safe_input_conflicting_flags", () =>
    hydrateSafeCliOptions({
      command: "start",
      inputRoot: missingRoot,
      options: {
        "input-file": "input-0123456789abcdef0123456789abcdef.json",
        "source-ref": "hostile-sentinel",
        runner: "codex",
      },
    }));
  expectSafeError("safe_input_conflicting_flags", () =>
    hydrateSafeCliOptions({
      command: "resolve",
      inputRoot: missingRoot,
      options: {
        id: "proc_test",
        "input-file": "input-0123456789abcdef0123456789abcdef.json",
      },
    }));
  expectSafeError("safe_input_command_mismatch", () =>
    hydrateSafeCliOptions({
      command: "begin-step",
      inputRoot: missingRoot,
      options: {
        id: "proc_test",
        "input-file": "input-0123456789abcdef0123456789abcdef.json",
      },
    }));
});

test("update companyHint conflicts with clear-company-hint", (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-clear-",
  });
  const input = createSafeInput(environment, "update", {
    companyHint: "Do not clear",
  });
  expectSafeError("safe_input_conflicting_flags", () =>
    hydrateSafeCliOptions({
      command: "update",
      inputRoot: input.inputRoot,
      options: {
        "clear-company-hint": true,
        id: "proc_test",
        "input-file": input.basename,
      },
    }));
});

test("strict JSON rejects duplicate, trailing, injected, and mismatched envelopes", (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-json-",
  });
  const fixtures = [
    {
      code: "safe_input_invalid_json",
      source: (nonce) =>
        `{"schemaVersion":1,"schema\\u0056ersion":1,"command":"start","nonce":"${nonce}","values":{"sourceRef":"one"}}`,
    },
    {
      code: "safe_input_invalid_json",
      source: (nonce) =>
        `{"schemaVersion":1,"command":"start","nonce":"${nonce}","values":{"sourceRef":"one","source\\u0052ef":"two"}}`,
    },
    {
      command: "fail-step",
      code: "safe_input_invalid_json",
      source: (nonce) =>
        `{"schemaVersion":1,"command":"fail-step","nonce":"${nonce}","values":{"error":{"code":"one","c\\u006fde":"two","message":"A failure.","retryable":true}}}`,
    },
    {
      command: "fail-step",
      code: "safe_input_schema_mismatch",
      source: (nonce) => JSON.stringify({
        schemaVersion: 1,
        command: "fail-step",
        nonce,
        values: {
          error: {
            code: "bounded_message",
            message: "я".repeat(257),
            retryable: true,
          },
        },
      }),
    },
    {
      command: "fail-step",
      code: "safe_input_schema_mismatch",
      source: (nonce) => JSON.stringify({
        schemaVersion: 1,
        command: "fail-step",
        nonce,
        values: {
          error: {
            code: "NOT_A_STABLE_CODE",
            message: "A failure.",
            retryable: true,
          },
        },
      }),
    },
    {
      command: "fail-step",
      code: "safe_input_schema_mismatch",
      source: (nonce) => JSON.stringify({
        schemaVersion: 1,
        command: "fail-step",
        nonce,
        values: {
          error: {
            code: `a_${"x".repeat(64)}`,
            message: "A failure.",
            retryable: true,
          },
        },
      }),
    },
    {
      command: "fail-step",
      code: "safe_input_schema_mismatch",
      source: (nonce) => JSON.stringify({
        schemaVersion: 1,
        command: "fail-step",
        nonce,
        values: {
          error: {
            code: "bounded_details",
            message: "A failure.",
            retryable: true,
            details: Array.from({ length: 9 }, () => "detail"),
          },
        },
      }),
    },
    {
      command: "fail-step",
      code: "safe_input_schema_mismatch",
      source: (nonce) => JSON.stringify({
        schemaVersion: 1,
        command: "fail-step",
        nonce,
        values: {
          error: {
            code: "bounded_detail",
            message: "A failure.",
            retryable: true,
            details: ["x".repeat(257)],
          },
        },
      }),
    },
    {
      code: "safe_input_invalid_json",
      source: (nonce) =>
        `{"schemaVersion":1,"command":"start","nonce":"${nonce}","values":{"sourceRef":"one"}} trailing`,
    },
    {
      code: "safe_input_schema_mismatch",
      source: (nonce) =>
        `{"schemaVersion":1,"command":"start","nonce":"${nonce}","values":{"sourceRef":"one"},"unknown":true}`,
    },
    {
      code: "safe_input_schema_mismatch",
      source: (nonce) =>
        `{"schemaVersion":1,"command":"start","nonce":"${nonce}","values":{"sourceRef":"one","runner":"codex"}}`,
    },
    {
      code: "safe_input_schema_mismatch",
      source: (nonce) =>
        `{"schemaVersion":1,"command":"start","nonce":"${nonce}","values":{"sourceRef":1}}`,
    },
    {
      code: "safe_input_schema_mismatch",
      source: (nonce) =>
        `{"schemaVersion":1,"command":"start","nonce":"${nonce}","values":{"sourceRef":"\\u0000"}}`,
    },
    {
      code: "safe_input_schema_mismatch",
      source: (nonce) =>
        `{"schemaVersion":1,"command":"start","nonce":"${nonce}","values":{"sourceRef":"\\ud800"}}`,
    },
    {
      code: "safe_input_schema_mismatch",
      source: (nonce) =>
        `{"schemaVersion":1,"command":"start","nonce":"${nonce}","values":{"__proto__":"nope","sourceRef":"one"}}`,
    },
    {
      code: "safe_input_command_mismatch",
      source: (nonce) =>
        `{"schemaVersion":1,"command":"update","nonce":"${nonce}","values":{"role":"one"}}`,
    },
    {
      code: "safe_input_nonce_mismatch",
      source: () =>
        `{"schemaVersion":1,"command":"start","nonce":"ffffffffffffffffffffffffffffffff","values":{"sourceRef":"one"}}`,
    },
  ];

  for (const fixture of fixtures) {
    const command = fixture.command ?? "start";
    const input = createSafeInput(environment, command, {}, {
      source: fixture.source,
    });
    expectSafeError(fixture.code, () =>
      readSafeCliInput({
        basename: input.basename,
        command,
        inputRoot: input.inputRoot,
      }));
  }
});

test("UTF-8, BOM, NUL, surrogate, and exact size boundaries fail closed", (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-bytes-",
  });
  const valid = createSafeInput(environment, "find-company", {
    query: "emoji 😀",
  });
  assert.equal(
    readSafeCliInput({
      basename: valid.basename,
      command: "find-company",
      inputRoot: valid.inputRoot,
    }).values.query,
    "emoji 😀",
  );

  const exact = createSafeInput(environment, "find-company", {}, {
    source: (nonce) => {
      const bytes = Buffer.from(
        `{"schemaVersion":1,"command":"find-company","nonce":"${nonce}","values":{"query":"exact"}}`,
      );
      assert.ok(bytes.length < safeCliInputMaxBytes);
      return Buffer.concat([
        bytes,
        Buffer.alloc(safeCliInputMaxBytes - bytes.length, 0x20),
      ]);
    },
  });
  assert.equal(
    readSafeCliInput({
      basename: exact.basename,
      command: "find-company",
      inputRoot: exact.inputRoot,
    }).values.query,
    "exact",
  );

  const oversize = createSafeInput(environment, "find-company", {}, {
    source: (nonce) => {
      const bytes = Buffer.from(
        `{"schemaVersion":1,"command":"find-company","nonce":"${nonce}","values":{"query":"large"}}`,
      );
      return Buffer.concat([
        bytes,
        Buffer.alloc(safeCliInputMaxBytes + 1 - bytes.length, 0x20),
      ]);
    },
  });
  expectSafeError("safe_input_oversize", () =>
    readSafeCliInput({
      basename: oversize.basename,
      command: "find-company",
      inputRoot: oversize.inputRoot,
    }));

  const validSource = (nonce) => Buffer.from(
    `{"schemaVersion":1,"command":"find-company","nonce":"${nonce}","values":{"query":"bytes"}}`,
  );
  const invalidUtf8 = createSafeInput(environment, "find-company", {}, {
    source: Buffer.from([0xc3, 0x28]),
  });
  const bom = createSafeInput(environment, "find-company", {}, {
    source: (nonce) => Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      validSource(nonce),
    ]),
  });
  const rawNul = createSafeInput(environment, "find-company", {}, {
    source: (nonce) => Buffer.concat([
      validSource(nonce),
      Buffer.from([0]),
    ]),
  });
  for (const input of [invalidUtf8, bom, rawNul]) {
    expectSafeError("safe_input_invalid_utf8", () =>
      readSafeCliInput({
        basename: input.basename,
        command: "find-company",
        inputRoot: input.inputRoot,
      }));
  }
});

test("unsafe paths, roots, file types, modes, ownership, and links are rejected", (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-fs-",
  });
  const root = ensureInputRoot(environment);
  for (const basename of [
    "../input-0123456789abcdef0123456789abcdef.json",
    "/tmp/input-0123456789abcdef0123456789abcdef.json",
    "nested/input-0123456789abcdef0123456789abcdef.json",
    "nested\\input-0123456789abcdef0123456789abcdef.json",
    "input-%2f23456789abcdef0123456789abcdef.json",
    "input-ABCDEF0123456789ABCDEF0123456789.json",
    "input-short.json",
  ]) {
    expectSafeError("safe_input_unsafe_path", () =>
      readSafeCliInput({
        basename,
        command: "start",
        inputRoot: root,
      }));
  }

  expectSafeError("safe_input_root_invalid", () =>
    readSafeCliInput({
      basename: "input-0123456789abcdef0123456789abcdef.json",
      command: "start",
      inputRoot: join(environment.workspaceRoot, "missing-input-root"),
    }));

  const wideRoot = join(environment.workspaceRoot, "wide-input-root");
  mkdirSync(wideRoot, { mode: 0o755 });
  chmodSync(wideRoot, 0o755);
  expectSafeError("safe_input_root_invalid", () =>
    readSafeCliInput({
      basename: "input-0123456789abcdef0123456789abcdef.json",
      command: "start",
      inputRoot: wideRoot,
    }));

  const specialRoot = join(environment.workspaceRoot, "special-input-root");
  mkdirSync(specialRoot, { mode: 0o700 });
  chmodSync(specialRoot, 0o1700);
  expectSafeError("safe_input_root_invalid", () =>
    readSafeCliInput({
      basename: "input-0123456789abcdef0123456789abcdef.json",
      command: "start",
      inputRoot: specialRoot,
    }));

  const realRoot = join(environment.workspaceRoot, "real-input-root");
  mkdirSync(realRoot, { mode: 0o700 });
  chmodSync(realRoot, 0o700);
  const linkedRoot = join(environment.workspaceRoot, "linked-input-root");
  symlinkSync(realRoot, linkedRoot);
  expectSafeError("safe_input_root_invalid", () =>
    readSafeCliInput({
      basename: "input-0123456789abcdef0123456789abcdef.json",
      command: "start",
      inputRoot: linkedRoot,
    }));

  const wrongMode = createSafeInput(environment, "start", {
    sourceRef: "direct-outreach:wrong-mode",
  });
  chmodSync(wrongMode.path, 0o644);
  expectSafeError("safe_input_file_invalid", () =>
    readSafeCliInput({
      basename: wrongMode.basename,
      command: "start",
      inputRoot: wrongMode.inputRoot,
    }));

  const specialMode = createSafeInput(environment, "start", {
    sourceRef: "direct-outreach:special-mode",
  });
  const specialModeFs = new Proxy(nodeFileSystem, {
    get(target, property, receiver) {
      if (property === "lstatSync") {
        return (path, options) => {
          const stats = target.lstatSync(path, options);
          return path === specialMode.path
            ? withStatFields(stats, {
              mode: (stats.mode & ~0o7777n) | 0o4600n,
            })
            : stats;
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  expectSafeError("safe_input_file_invalid", () =>
    readSafeCliInput({
      basename: specialMode.basename,
      command: "start",
      fileSystem: specialModeFs,
      inputRoot: specialMode.inputRoot,
    }));

  const hardlinked = createSafeInput(environment, "start", {
    sourceRef: "direct-outreach:hardlink",
  });
  linkSync(hardlinked.path, join(hardlinked.inputRoot, "hardlink-alias"));
  expectSafeError("safe_input_file_invalid", () =>
    readSafeCliInput({
      basename: hardlinked.basename,
      command: "start",
      inputRoot: hardlinked.inputRoot,
    }));

  const directoryNonce = randomBytes(16).toString("hex");
  const directoryBasename = `input-${directoryNonce}.json`;
  mkdirSync(join(root, directoryBasename), { mode: 0o700 });
  expectSafeError("safe_input_file_invalid", () =>
    readSafeCliInput({
      basename: directoryBasename,
      command: "start",
      inputRoot: root,
    }));

  const symlinkNonce = randomBytes(16).toString("hex");
  const symlinkBasename = `input-${symlinkNonce}.json`;
  const symlinkTarget = join(environment.workspaceRoot, "symlink-target.json");
  writeFileSync(symlinkTarget, "{}", { mode: 0o600 });
  chmodSync(symlinkTarget, 0o600);
  symlinkSync(symlinkTarget, join(root, symlinkBasename));
  expectSafeError("safe_input_file_invalid", () =>
    readSafeCliInput({
      basename: symlinkBasename,
      command: "start",
      inputRoot: root,
    }));

  expectSafeError("safe_input_root_invalid", () =>
    readSafeCliInput({
      basename: "input-0123456789abcdef0123456789abcdef.json",
      command: "start",
      inputRoot: root,
      uid: process.getuid() + 1,
    }));

  const wrongPathOwner = createSafeInput(environment, "start", {
    sourceRef: "direct-outreach:wrong-path-owner",
  });
  const pathOwnerFs = new Proxy(nodeFileSystem, {
    get(target, property, receiver) {
      if (property === "lstatSync") {
        return (path, options) => {
          const stats = target.lstatSync(path, options);
          return path === wrongPathOwner.path
            ? withStatFields(stats, {
              uid: BigInt(process.getuid() + 1),
            })
            : stats;
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  expectSafeError("safe_input_file_invalid", () =>
    readSafeCliInput({
      basename: wrongPathOwner.basename,
      command: "start",
      fileSystem: pathOwnerFs,
      inputRoot: wrongPathOwner.inputRoot,
    }));

  const wrongDescriptorOwner = createSafeInput(environment, "start", {
    sourceRef: "direct-outreach:wrong-descriptor-owner",
  });
  let descriptorOwnerCloseCount = 0;
  const descriptorOwnerFs = new Proxy(nodeFileSystem, {
    get(target, property, receiver) {
      if (property === "fstatSync") {
        return (descriptor, options) =>
          withStatFields(
            target.fstatSync(descriptor, options),
            { uid: BigInt(process.getuid() + 1) },
          );
      }
      if (property === "closeSync") {
        return (descriptor) => {
          descriptorOwnerCloseCount += 1;
          return target.closeSync(descriptor);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  expectSafeError("safe_input_file_invalid", () =>
    readSafeCliInput({
      basename: wrongDescriptorOwner.basename,
      command: "start",
      fileSystem: descriptorOwnerFs,
      inputRoot: wrongDescriptorOwner.inputRoot,
    }));
  assert.equal(descriptorOwnerCloseCount, 1);

  const noNoFollowFs = new Proxy(nodeFileSystem, {
    get(target, property, receiver) {
      if (property === "constants") {
        return { ...target.constants, O_NOFOLLOW: undefined };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  expectSafeError("safe_input_unsupported_platform", () =>
    readSafeCliInput({
      basename: wrongDescriptorOwner.basename,
      command: "start",
      fileSystem: noNoFollowFs,
      inputRoot: wrongDescriptorOwner.inputRoot,
    }));

  expectSafeError("safe_input_unsupported_platform", () =>
    readSafeCliInput({
      basename: "input-0123456789abcdef0123456789abcdef.json",
      command: "start",
      inputRoot: root,
      platform: "win32",
    }));
});

test("descriptor identity and mutation checks reject replacements and always close", (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-race-",
  });
  const replaced = createSafeInput(environment, "start", {
    sourceRef: "direct-outreach:original",
  });
  const replacementPath = join(replaced.inputRoot, "replacement.json");
  writeFileSync(replacementPath, readFileSync(replaced.path), {
    mode: 0o600,
  });
  chmodSync(replacementPath, 0o600);
  let replacementCloseCount = 0;
  let replacedPath = false;
  const replacementFs = new Proxy(nodeFileSystem, {
    get(target, property, receiver) {
      if (property === "openSync") {
        return (path, flags) => {
          if (!replacedPath) {
            replacedPath = true;
            renameSync(replacementPath, path);
          }
          return target.openSync(path, flags);
        };
      }
      if (property === "closeSync") {
        return (descriptor) => {
          replacementCloseCount += 1;
          return target.closeSync(descriptor);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  expectSafeError("safe_input_replaced", () =>
    readSafeCliInput({
      basename: replaced.basename,
      command: "start",
      fileSystem: replacementFs,
      inputRoot: replaced.inputRoot,
    }));
  assert.equal(replacementCloseCount, 1);

  const mutated = createSafeInput(environment, "start", {
    sourceRef: "direct-outreach:mutated",
  });
  let mutationCloseCount = 0;
  let mutatedPath = false;
  const mutationFs = new Proxy(nodeFileSystem, {
    get(target, property, receiver) {
      if (property === "readSync") {
        return (...args) => {
          const count = target.readSync(...args);
          if (!mutatedPath) {
            mutatedPath = true;
            writeFileSync(mutated.path, " ", { flag: "a" });
          }
          return count;
        };
      }
      if (property === "closeSync") {
        return (descriptor) => {
          mutationCloseCount += 1;
          return target.closeSync(descriptor);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  expectSafeError("safe_input_replaced", () =>
    readSafeCliInput({
      basename: mutated.basename,
      command: "start",
      fileSystem: mutationFs,
      inputRoot: mutated.inputRoot,
    }));
  assert.equal(mutationCloseCount, 1);
});

test("transported downstream failures are stable, redacted, and byte-stable", (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-redact-",
  });
  const sentinel = "RAW_HOSTILE_SENTINEL_4d0fd632";
  const invalidDomain = createSafeInput(environment, "create-company", {
    displayName: "Example",
    domain: `bad domain ${sentinel}`,
  });
  const before = readFileSync(environment.ledgerPath, "utf8");
  const rejected = runCli(
    environment,
    invalidDomain.inputRoot,
    "create-company",
    "--input-file",
    invalidDomain.basename,
  );
  assert.equal(rejected.status, 1);
  assert.equal(
    JSON.parse(rejected.stderr).error.code,
    "safe_input_value_invalid",
  );
  assert.doesNotMatch(rejected.stderr, new RegExp(sentinel));
  assert.doesNotMatch(rejected.stderr, new RegExp(invalidDomain.inputRoot));
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
  assert.equal(existsSync(invalidDomain.path), true);

  const missing = createSafeInput(environment, "resolve", {
    sourceRef: `https://${sentinel}.invalid/jobs/1`,
  });
  const notFound = runCli(
    environment,
    missing.inputRoot,
    "resolve",
    "--input-file",
    missing.basename,
  );
  assert.equal(notFound.status, 1);
  assert.deepEqual(JSON.parse(notFound.stderr).error, {
    code: "process_not_found",
    message: "The command rejected safely transported input.",
  });
  assert.doesNotMatch(notFound.stderr, new RegExp(sentinel));
  assert.doesNotMatch(notFound.stderr, /https?:\/\//);
  assert.equal(existsSync(missing.path), true);

  const malformedLegacy = runCli(
    environment,
    missing.inputRoot,
    "fail-step",
    "--id",
    "proc_missing",
    "--step",
    "get_vacancy",
    "--attempt-id",
    "attempt_missing",
    "--error-json",
    `{"${sentinel}`,
  );
  assert.equal(malformedLegacy.status, 1);
  assert.equal(
    JSON.parse(malformedLegacy.stderr).error.code,
    "invalid_cli_json",
  );
  assert.doesNotMatch(malformedLegacy.stderr, new RegExp(sentinel));
  assert.doesNotMatch(malformedLegacy.stderr, /position|column|Unexpected/i);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

test("transported commands preserve repository-owned lock and validation recovery", async (t) => {
  await t.test("lock failure", () => {
    const environment = createDisposableWorkspace(t, {
      ledger: emptyV3Log(),
      prefix: "job-search-safe-input-lock-recovery-",
    });
    const input = createSafeInput(environment, "start", {
      sourceRef: "fixture:transported-lock-recovery",
    });
    const before = readFileSync(environment.ledgerPath, "utf8");
    let result;
    chmodSync(environment.workspaceRoot, 0o500);
    try {
      result = runCli(
        environment,
        input.inputRoot,
        "start",
        "--input-file",
        input.basename,
        "--runner",
        "codex",
      );
    } finally {
      chmodSync(environment.workspaceRoot, 0o700);
    }

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr).error, {
      code: "process_log_lock_failed",
      message: "Process log lock could not be acquired.",
      context: "operation=acquire_process_log_lock",
      cause_code: "EACCES",
      recovery_action: "repair_process_log_access",
    });
    assert.doesNotMatch(result.stderr, new RegExp(environment.workspaceRoot));
    assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
    assert.equal(existsSync(input.path), true);
  });

  await t.test("structural validation failure", () => {
    const environment = createDisposableWorkspace(t, {
      ledger: emptyV3Log(),
      prefix: "job-search-safe-input-validation-recovery-",
    });
    const input = createSafeInput(environment, "start", {
      sourceRef: "fixture:transported-validation-recovery",
    });
    const invalid = emptyV3Log();
    invalid.schema_version = 2;
    const before = `${JSON.stringify(invalid, null, 2)}\n`;
    writeFileSync(environment.ledgerPath, before, "utf8");

    const result = runCli(
      environment,
      input.inputRoot,
      "start",
      "--input-file",
      input.basename,
      "--runner",
      "codex",
    );

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr).error, {
      code: "process_log_validation_failed",
      message: "Process log failed structural validation.",
      context: "operation=validate_process_log",
      recovery_action: "repair_process_log_schema",
    });
    assert.doesNotMatch(result.stderr, new RegExp(environment.workspaceRoot));
    assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
    assert.equal(existsSync(input.path), true);
  });
});

test("transported company-domain policy denial is redacted and byte-stable", (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-domain-policy-",
  });
  const create = createSafeInput(environment, "create-company", {
    displayName: "Safe Domain Company",
  });
  const company = requireCliSuccess(runCli(
    environment,
    create.inputRoot,
    "create-company",
    "--input-file",
    create.basename,
  )).company;
  const forbiddenDomain = "https://ＴＥＮＡＮＴ．ＰＩＮＰＯＩＮＴＨＱ．ＣＯＭ.:443/postings/1";
  const add = createSafeInput(environment, "add-company-domain", {
    domain: forbiddenDomain,
  });
  const before = readFileSync(environment.ledgerPath, "utf8");
  const rejected = runCli(
    environment,
    add.inputRoot,
    "add-company-domain",
    "--id",
    company.id,
    "--input-file",
    add.basename,
  );
  assert.equal(rejected.status, 1);
  assert.equal(
    JSON.parse(rejected.stderr).error.code,
    "company_domain_forbidden",
  );
  assert.doesNotMatch(rejected.stderr, /pinpointhq|https?:|postings/i);
  assert.doesNotMatch(rejected.stderr, new RegExp(add.inputRoot));
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
  assert.equal(existsSync(add.path), true);
});

test("transported create-company denies a forbidden domain before any company exists", (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-create-domain-policy-",
  });
  const forbiddenDomain = "https://ＴＥＮＡＮＴ．ＧＲＥＥＮＨＯＵＳＥ．ＩＯ.:443/jobs/1";
  const create = createSafeInput(environment, "create-company", {
    displayName: "Transported Domain Company",
    domain: forbiddenDomain,
  });
  const before = readFileSync(environment.ledgerPath, "utf8");
  const rejected = runCli(
    environment,
    create.inputRoot,
    "create-company",
    "--input-file",
    create.basename,
  );
  assert.equal(rejected.status, 1);
  assert.equal(
    JSON.parse(rejected.stderr).error.code,
    "company_domain_forbidden",
  );
  assert.doesNotMatch(rejected.stderr, /greenhouse|https?:|jobs/i);
  assert.doesNotMatch(rejected.stderr, new RegExp(create.inputRoot));
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
  assert.equal(existsSync(create.path), true);
  assert.deepEqual(
    JSON.parse(readFileSync(environment.ledgerPath, "utf8")).companies,
    [],
  );
});

test("transported diagnostics replace hostile prose before ledger publication", (t) => {
  const sentinel = "RAW_HOSTILE_SECRET_47f7";
  const hostileUrl = "https://secret.invalid/token";

  const failureEnvironment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-failure-prose-",
  });
  const failureStartInput = createSafeInput(
    failureEnvironment,
    "start",
    { sourceRef: "direct-outreach:safe-diagnostic-failure" },
  );
  const failureStarted = requireCliSuccess(runCli(
    failureEnvironment,
    failureStartInput.inputRoot,
    "start",
    "--input-file",
    failureStartInput.basename,
    "--runner",
    "codex",
  ));
  const failureInput = createSafeInput(
    failureEnvironment,
    "fail-step",
    {
      error: {
        code: "vacancy_fetch_failed",
        message: `A failure ${sentinel} ${hostileUrl}`,
        retryable: true,
        details: [`detail ${sentinel}`, hostileUrl],
      },
    },
  );
  const failedResult = runCli(
    failureEnvironment,
    failureInput.inputRoot,
    "fail-step",
    "--id",
    failureStarted.process.id,
    "--step",
    "get_vacancy",
    "--attempt-id",
    failureStarted.process.steps.get_vacancy.active_attempt.id,
    "--input-file",
    failureInput.basename,
  );
  const failed = requireCliSuccess(failedResult);
  assert.equal(failed.status, "failed");
  assert.doesNotMatch(failedResult.stdout, new RegExp(sentinel));
  assert.doesNotMatch(failedResult.stdout, /secret\.invalid/);
  const failureLedgerSource = readFileSync(
    failureEnvironment.ledgerPath,
    "utf8",
  );
  assert.doesNotMatch(failureLedgerSource, new RegExp(sentinel));
  assert.doesNotMatch(failureLedgerSource, /secret\.invalid/);
  const failureStep = JSON.parse(failureLedgerSource)
    .processes[0].steps.get_vacancy;
  assert.equal(failureStep.error.code, "vacancy_fetch_failed");
  assert.equal(
    failureStep.error.message,
    "The operation ended with a controlled error.",
  );
  assert.deepEqual(failureStep.error.details, []);
  assert.equal(existsSync(failureInput.path), true);

  const blockerEnvironment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-blocker-prose-",
  });
  const blockerStartInput = createSafeInput(
    blockerEnvironment,
    "start",
    { sourceRef: "fixture:quality-platform-engineer" },
  );
  const blockerStarted = requireCliSuccess(runCli(
    blockerEnvironment,
    blockerStartInput.inputRoot,
    "start",
    "--input-file",
    blockerStartInput.basename,
    "--runner",
    "codex",
  ));
  const updateInput = createSafeInput(blockerEnvironment, "update", {
    companyObserved: "Fixture Systems",
    role: "Quality Platform Engineer",
  });
  requireCliSuccess(runCli(
    blockerEnvironment,
    updateInput.inputRoot,
    "update",
    "--id",
    blockerStarted.process.id,
    "--input-file",
    updateInput.basename,
  ));
  requireCliSuccess(runCli(
    blockerEnvironment,
    updateInput.inputRoot,
    "reserve-output",
    "--id",
    blockerStarted.process.id,
  ));
  const blockerProcess = JSON.parse(
    readFileSync(blockerEnvironment.ledgerPath, "utf8"),
  ).processes[0];
  const publicationId = "publication_safe_blocker_prose";
  stageBlockedVacancy(
    blockerEnvironment,
    blockerProcess,
    publicationId,
  );
  const blockerInput = createSafeInput(
    blockerEnvironment,
    "publish-step",
    {
      blocker: {
        code: "market_ambiguous",
        message: `A blocker ${sentinel} ${hostileUrl}`,
        retryable: true,
        details: [`detail ${sentinel}`, hostileUrl],
      },
    },
  );
  const blockedResult = runCli(
    blockerEnvironment,
    blockerInput.inputRoot,
    "publish-step",
    "--id",
    blockerStarted.process.id,
    "--step",
    "get_vacancy",
    "--attempt-id",
    blockerStarted.process.steps.get_vacancy.active_attempt.id,
    "--publication-id",
    publicationId,
    "--outcome",
    "blocked",
    "--input-file",
    blockerInput.basename,
  );
  const blocked = requireCliSuccess(blockedResult);
  assert.equal(blocked.status, "blocked");
  assert.doesNotMatch(blockedResult.stdout, new RegExp(sentinel));
  assert.doesNotMatch(blockedResult.stdout, /secret\.invalid/);
  const blockerLedgerSource = readFileSync(
    blockerEnvironment.ledgerPath,
    "utf8",
  );
  assert.doesNotMatch(blockerLedgerSource, new RegExp(sentinel));
  assert.doesNotMatch(blockerLedgerSource, /secret\.invalid/);
  const blockerStep = JSON.parse(blockerLedgerSource)
    .processes[0].steps.get_vacancy;
  assert.equal(blockerStep.blocker.code, "market_ambiguous");
  assert.equal(
    blockerStep.blocker.message,
    "The operation stopped on a controlled blocker.",
  );
  assert.deepEqual(blockerStep.blocker.details, []);
  assert.equal(existsSync(blockerInput.path), true);
});

test("same immutable payload supports retry and concurrent duplicate semantics", async (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-replay-",
  });
  const input = createSafeInput(environment, "start", {
    sourceRef: "direct-outreach:same-safe-payload",
  });
  const attempts = 12;
  const results = await Promise.all(
    Array.from({ length: attempts }, () =>
      runCliAsync(
        environment,
        input.inputRoot,
        "start",
        "--input-file",
        input.basename,
        "--runner",
        "codex",
      )),
  );
  assert.equal(results.filter((result) => result.code === 0).length, 1);
  assert.equal(results.filter((result) => result.code === 2).length, attempts - 1);
  const payloads = results.map((result) => JSON.parse(result.stdout));
  assert.deepEqual(
    payloads.map(({ status }) => status).sort(),
    ["created", ...Array(attempts - 1).fill("duplicate")].sort(),
  );
  assert.equal(existsSync(input.path), true);
  const log = JSON.parse(readFileSync(environment.ledgerPath, "utf8"));
  assert.equal(log.processes.length, 1);
  const payloadRecords = payloads.flatMap((payload) =>
    payload.status === "created" ? [payload.process] : payload.matches);
  assert.deepEqual(new Set(payloadRecords.map(({ id }) => id)), new Set([log.processes[0].id]));
  assert.deepEqual(
    new Set(payloadRecords.map(({ source_ref }) => source_ref)),
    new Set(["direct-outreach:same-safe-payload"]),
  );
  for (const payload of payloads.filter(({ status }) => status === "duplicate")) {
    assert.equal(payload.matches.length, 1);
    assert.deepEqual(payload.matches[0], log.processes[0]);
  }
  assert.equal(log.processes[0].source_key, "direct-outreach:same-safe-payload");
  assert.equal(log.processes[0].runner, "codex");
  assert.equal(log.processes[0].artifact_mode, "file-backed");
  assert.equal(log.processes[0].steps.get_vacancy.state, "running");
});

test("POSIX direct replacement preserves exact same-payload child outcomes", async (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-handoff-",
  });
  const input = createSafeInput(environment, "start", {
    sourceRef: "direct-outreach:same-handoff-payload",
  });
  const cliArgs = [
    "start",
    "--input-file",
    input.basename,
    "--runner",
    "codex",
  ];
  const outcome = await runSafeInputHandoffSchedule(environment, input, cliArgs);
  const receipt = JSON.parse(outcome.receiptFile.source);
  const children = receipt.children;
  const results = outcome.runs.map(({ result }) => result);

  if (outcome.scheduleError !== null) throw outcome.scheduleError;
  assert.equal(existsSync(outcome.receiptFile.path), true);
  assert.equal(readFileSync(outcome.receiptFile.path, "utf8"), outcome.receiptFile.source);
  assert.equal(Buffer.byteLength(outcome.receiptFile.source, "utf8") <= 32_768, true);
  assert.equal(dirname(realpathSync(dirname(outcome.receiptFile.path))), realpathSync(tmpdir()));
  assert.deepEqual(Object.keys(receipt).sort(), expectedReceiptKeys);
  assert.equal(receipt.head, outcome.head);
  assert.deepEqual(receipt.barriers, outcome.barriers);
  assert.deepEqual(receipt.supervisor, outcome.supervisor);
  assert.equal(outcome.supervisor.outcome, "completed");
  assert.equal(outcome.supervisor.timedOutPhase, null);
  assert.deepEqual(outcome.supervisor.reapedChildIndexes, Array.from({ length: 12 }, (_, i) => i));
  assert.deepEqual(outcome.supervisor.actions, [
    { action: "release_owner", published: true },
    { action: "release_successor", published: true },
  ]);
  assert.deepEqual(outcome.barriers.completed, [
    "owner_empty",
    "successor_direct_replacement",
    "successor_critical_section",
    "contenders_blocked",
    "owner_release_blocked",
    "children_settled",
  ]);
  assert.deepEqual(outcome.barriers.blockedContenderIndexes, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(outcome.barriers.enteredContenderIndexes, []);
  assert.equal(outcome.barriers.childrenSettled, true);

  const oldDirectory = outcome.snapshots.oldDirectory;
  const successorBefore = outcome.snapshots.successorBeforeOldRelease;
  const successorAfter = outcome.snapshots.successorAfterOldRelease;
  assert.equal(oldDirectory.evidence.entryCount, 0);
  assert.equal(oldDirectory.evidence.entry, null);
  assert.equal(successorBefore.evidence.entryCount, 1);
  assert.notDeepEqual(successorBefore.evidence.directory, oldDirectory.evidence.directory);
  assert.match(successorBefore.evidence.entry.ownerToken, /^[0-9a-f]{32}$/);
  assert.equal(
    JSON.parse(successorBefore.rawOwnerSource).owner_token,
    successorBefore.evidence.entry.ownerToken,
  );
  assert.deepEqual(successorAfter.evidence, successorBefore.evidence);
  assert.equal(successorAfter.rawOwnerSource, successorBefore.rawOwnerSource);
  assert.equal(["EEXIST", "ENOTEMPTY"].includes(outcome.barriers.ownerReleaseCode), true);
  assert.equal(
    existsSync(fixtureMarkerPath(
      environment,
      `safe-owner-release-blocked-${outcome.barriers.ownerReleaseCode.toLowerCase()}`,
    )),
    true,
  );
  for (let contenderIndex = 0; contenderIndex < 10; contenderIndex += 1) {
    const contenderId = String(contenderIndex).padStart(2, "0");
    assert.equal(
      existsSync(fixtureMarkerPath(environment, `safe-contender-${contenderId}-blocked`)),
      true,
    );
    assert.equal(
      existsSync(fixtureMarkerPath(environment, `safe-contender-${contenderId}-entered`)),
      true,
      "each contender must enter only after the successor release",
    );
  }

  assert.equal(existsSync(input.path), true);
  const log = JSON.parse(readFileSync(environment.ledgerPath, "utf8"));
  assert.equal(log.processes.length, 1);
  const [finalRecord] = log.processes;
  assert.deepEqual(new Set(log.processes.map(({ id }) => id)), new Set([finalRecord.id]));
  assert.deepEqual(
    new Set(log.processes.map(({ source_ref }) => source_ref)),
    new Set(["direct-outreach:same-handoff-payload"]),
  );
  assert.deepEqual(
    new Set(log.processes.map(({ source_key }) => source_key)),
    new Set(["direct-outreach:same-handoff-payload"]),
  );
  assert.deepEqual(new Set(log.processes.map(({ runner }) => runner)), new Set(["codex"]));
  assert.deepEqual(
    new Set(log.processes.map(({ artifact_mode }) => artifact_mode)),
    new Set(["file-backed"]),
  );
  assert.deepEqual(
    new Set(log.processes.map((record) => record.steps.get_vacancy.state)),
    new Set(["running"]),
  );

  const expectedOutcomes = [
    "0:0:created",
    ...Array.from({ length: 11 }, (_, index) => `${index + 1}:2:duplicate`),
  ];
  assert.deepEqual(
    children.map(({ index, numericExitCode, stdoutStatus }) =>
      `${index}:${numericExitCode}:${stdoutStatus}`),
    expectedOutcomes,
  );
  assert.deepEqual(children.map(({ spawnErrorCode }) => spawnErrorCode), Array(12).fill(null));
  assert.deepEqual(children.map(({ signal }) => signal), Array(12).fill(null));
  assert.deepEqual(children.map(({ boundedStderrCode }) => boundedStderrCode), Array(12).fill(null));
  assert.deepEqual(children.map(({ stdoutErrorCode }) => stdoutErrorCode), Array(12).fill(null));
  const payloads = results.map(({ stdout }) => JSON.parse(stdout));
  assert.equal(children.length, outcome.runs.length);
  for (const [index, run] of outcome.runs.entries()) {
    const child = children[index];
    const rawPayload = JSON.parse(run.result.stdout);
    assert.equal(run.result.stderr, "");
    assert.equal(child.index, run.index);
    assert.equal(child.role, run.role);
    assert.deepEqual(child.argv, run.argv);
    assert.equal(child.numericExitCode, run.result.numericExitCode);
    assert.equal(child.signal, run.result.signal);
    assert.equal(child.spawnErrorCode, run.result.spawnErrorCode);
    assert.equal(child.stdoutStatus, rawPayload.status ?? null);
    assert.equal(child.stdoutErrorCode, rawPayload.error?.code ?? null);
    assert.equal(child.boundedStderrCode, null);
  }
  assert.deepEqual(payloads.map(({ status }) => status), [
    "created",
    ...Array(11).fill("duplicate"),
  ]);
  assert.deepEqual(payloads[0].process, finalRecord);
  for (const payload of payloads.slice(1)) {
    assert.equal(payload.matches.length, 1);
    assert.deepEqual(payload.matches[0], finalRecord);
  }
  const payloadRecords = payloads.flatMap((payload) =>
    payload.status === "created" ? [payload.process] : payload.matches);
  assert.equal(payloadRecords.length, 12);
  assert.equal(
    payloadRecords.every((record) => JSON.stringify(record) === JSON.stringify(finalRecord)),
    true,
  );

  executedSafeInputModes.add("safe-release-owner");
  executedSafeInputModes.add("safe-direct-successor");
  executedSafeInputModes.add("safe-blocked-contender");
});

test("oracle supervisor times out, signals, reaps, and receipts before failure", async (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-supervisor-",
  });
  const inputRoot = ensureInputRoot(environment);
  const outcome = await runSupervisorFaultOracle(environment, inputRoot);
  const receipt = JSON.parse(outcome.receiptFile.source);

  assert.equal(existsSync(outcome.receiptFile.path), true);
  assert.equal(readFileSync(outcome.receiptFile.path, "utf8"), outcome.receiptFile.source);
  assert.equal(Buffer.byteLength(outcome.receiptFile.source, "utf8") <= 32_768, true);
  assert.deepEqual(Object.keys(receipt).sort(), expectedReceiptKeys);
  assert.equal(receipt.head, outcome.head);
  assert.deepEqual(receipt.barriers, outcome.barriers);
  assert.deepEqual(receipt.supervisor, outcome.supervisor);
  assert.equal(outcome.scheduleError?.code, "oracle_supervisor_timeout");
  assert.equal(outcome.scheduleError?.phase, "fault-child-settle");
  assert.equal(outcome.supervisor.outcome, "oracle_supervisor_timeout");
  assert.equal(supervisorPhaseDeadlineMilliseconds, 5_000);
  assert.equal(outcome.supervisor.phaseDeadlineMilliseconds, 5_000);
  assert.equal(supervisorTerminationGraceMilliseconds, 1_000);
  assert.equal(outcome.supervisor.terminationGraceMilliseconds, 1_000);
  assert.equal(outcome.supervisor.timedOutPhase, "fault-child-settle");
  assert.deepEqual(outcome.supervisor.reapedChildIndexes, [0, 1]);
  assert.equal(outcome.barriers.ownerReleasePublished, true);
  assert.equal(outcome.barriers.childrenSettled, true);
  assert.deepEqual(outcome.barriers.completed, ["fault_children_ready"]);
  assert.deepEqual(
    outcome.supervisor.actions.map(({ action }) => action),
    ["release_owner", "signal", "wait_after_sigterm", "signal", "reap"],
  );
  assert.deepEqual(outcome.supervisor.actions[0], {
    action: "release_owner",
    published: true,
  });
  assert.deepEqual(outcome.supervisor.actions[1], {
    action: "signal",
    indexes: [0, 1],
    signal: "SIGTERM",
  });
  assert.deepEqual(outcome.supervisor.actions[2], {
    action: "wait_after_sigterm",
    allSettled: false,
    milliseconds: 1_000,
  });
  assert.deepEqual(outcome.supervisor.actions[3], {
    action: "signal",
    indexes: [1],
    signal: "SIGKILL",
  });
  assert.deepEqual(outcome.supervisor.actions[4], {
    action: "reap",
    indexes: [0, 1],
  });
  assert.deepEqual(receipt.children.map(({ numericExitCode }) => numericExitCode), [null, null]);
  assert.deepEqual(receipt.children.map(({ signal }) => signal), ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(receipt.children.map(({ spawnErrorCode }) => spawnErrorCode), [null, null]);
  assert.deepEqual(receipt.children.map(({ stdoutStatus }) => stdoutStatus), [null, null]);
  assert.deepEqual(receipt.children.map(({ stdoutErrorCode }) => stdoutErrorCode), [null, null]);
  assert.deepEqual(receipt.children.map(({ boundedStderrCode }) => boundedStderrCode), [null, null]);
  assert.equal(receipt.children.length, outcome.runs.length);
  for (const [index, run] of outcome.runs.entries()) {
    const child = receipt.children[index];
    assert.equal(run.result.stdout, "");
    assert.equal(run.result.stderr, "");
    assert.equal(child.index, run.index);
    assert.equal(child.role, run.role);
    assert.deepEqual(child.argv, run.argv);
    assert.equal(child.numericExitCode, run.result.numericExitCode);
    assert.equal(child.signal, run.result.signal);
    assert.equal(child.spawnErrorCode, run.result.spawnErrorCode);
    assert.equal(child.stdoutStatus, null);
    assert.equal(child.stdoutErrorCode, null);
    assert.equal(child.boundedStderrCode, null);
  }

  executedSafeInputModes.add("safe-supervisor-term");
  executedSafeInputModes.add("safe-supervisor-kill");
});

test("real native spawn errors persist while EAGAIN identity stays exact", async (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-native-spawn-",
  });
  const inputRoot = ensureInputRoot(environment);
  const head = currentHead();
  const missingExecutable = join(environment.workspaceRoot, "missing-node-executable");
  const run = launchLockCliAtExecutable(
    missingExecutable,
    environment,
    inputRoot,
    0,
    "native-spawn-error",
    "safe-supervisor-term",
    [],
  );
  const result = await run.promise;
  const [child] = receiptChildrenFromRuns([run]);
  const barriers = { completed: [] };
  const supervisor = { outcome: "native_spawn_error" };
  const receipt = buildR103eReceipt({ barriers, children: [child], head, supervisor });
  const receiptFile = writeR103eReceipt(environment, "native-spawn-error", receipt);
  const persisted = JSON.parse(receiptFile.source);

  assert.equal(result.numericExitCode, null);
  assert.equal(result.signal, null);
  assert.equal(result.spawnErrorCode, "ENOENT");
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(child, {
    argv: [missingExecutable, lockChildPath, "safe-supervisor-term"],
    boundedStderrCode: null,
    index: 0,
    numericExitCode: null,
    role: "native-spawn-error",
    signal: null,
    spawnErrorCode: "ENOENT",
    stdoutErrorCode: null,
    stdoutStatus: null,
  });
  assert.equal(readFileSync(receiptFile.path, "utf8"), receiptFile.source);
  assert.equal(persisted.head, head);
  assert.deepEqual(persisted.barriers, barriers);
  assert.deepEqual(persisted.supervisor, supervisor);
  assert.deepEqual(persisted.children, [child]);
  assert.equal(persisted.children[0].spawnErrorCode, "ENOENT");
  assert.deepEqual(classifyNativeChildOutcome({ code: "EAGAIN" }), {
    numericExitCode: null,
    signal: null,
    spawnErrorCode: "EAGAIN",
  });
});

test("receipt contract pins exact keys and UTF-8 field boundaries", (t) => {
  assert.equal(Buffer.byteLength(serializeReceipt(receiptAtExactBytes(32_768)), "utf8"), 32_768);
  expectReceiptError(
    "oracle_receipt_too_large",
    () => serializeReceipt(receiptAtExactBytes(32_769)),
  );

  validateReceiptContract(minimalReceipt());
  expectReceiptError(
    "oracle_receipt_shape_invalid",
    () => validateReceiptContract({ ...minimalReceipt(), extra: true }),
  );
  const missingTopKey = minimalReceipt();
  delete missingTopKey.barriers;
  expectReceiptError(
    "oracle_receipt_shape_invalid",
    () => validateReceiptContract(missingTopKey),
  );
  expectReceiptError(
    "oracle_receipt_child_invalid",
    () => validateReceiptContract(minimalReceipt({
      children: [{ ...minimalReceiptChild(), extra: true }],
    })),
  );

  validateReceiptContract(minimalReceipt({ head: "f".repeat(40) }));
  for (const head of ["f".repeat(39), "f".repeat(41), "F".repeat(40)]) {
    expectReceiptError(
      "oracle_receipt_head_invalid",
      () => validateReceiptContract(minimalReceipt({ head })),
    );
  }
  expectReceiptError(
    "oracle_receipt_command_invalid",
    () => validateReceiptContract(minimalReceipt({ command: [process.execPath, "--test"] })),
  );

  for (const argv of [[], [""], Array(16).fill("é".repeat(512))]) {
    validateReceiptContract(minimalReceipt({ children: [minimalReceiptChild({ argv })] }));
  }
  expectReceiptError(
    "oracle_receipt_argv_invalid",
    () => validateReceiptContract(minimalReceipt({
      children: [minimalReceiptChild({ argv: Array(17).fill("x") })],
    })),
  );
  expectReceiptError(
    "oracle_receipt_argv_invalid",
    () => validateReceiptContract(minimalReceipt({
      children: [minimalReceiptChild({ argv: ["x".repeat(1_025)] })],
    })),
  );

  for (const spawnErrorCode of ["E", "EAGAIN", `E${"A".repeat(63)}`]) {
    const source = serializeReceipt(minimalReceipt({
      children: [minimalReceiptChild({ numericExitCode: null, spawnErrorCode })],
    }));
    assert.equal(JSON.parse(source).children[0].spawnErrorCode, spawnErrorCode);
  }
  for (const spawnErrorCode of ["eagain", `E${"A".repeat(64)}`]) {
    expectReceiptError(
      "oracle_receipt_spawn_code_invalid",
      () => validateReceiptContract(minimalReceipt({
        children: [minimalReceiptChild({ spawnErrorCode })],
      })),
    );
  }

  for (const signal of ["SIGA", `SIG${"A".repeat(29)}`]) {
    validateReceiptContract(minimalReceipt({
      children: [minimalReceiptChild({ numericExitCode: null, signal })],
    }));
  }
  expectReceiptError(
    "oracle_receipt_signal_invalid",
    () => validateReceiptContract(minimalReceipt({
      children: [minimalReceiptChild({ signal: `SIG${"A".repeat(30)}` })],
    })),
  );
  expectReceiptError(
    "oracle_receipt_signal_invalid",
    () => validateReceiptContract(minimalReceipt({
      children: [minimalReceiptChild({ signal: "SIG" })],
    })),
  );
  for (const field of ["stdoutStatus", "stdoutErrorCode", "boundedStderrCode"]) {
    for (const valid of ["a", "a".repeat(64)]) {
      validateReceiptContract(minimalReceipt({
        children: [minimalReceiptChild({ [field]: valid })],
      }));
    }
    for (const invalid of ["", "A", "a".repeat(65)]) {
      expectReceiptError(
        "oracle_receipt_code_invalid",
        () => validateReceiptContract(minimalReceipt({
          children: [minimalReceiptChild({ [field]: invalid })],
        })),
      );
    }
  }

  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-receipt-path-",
  });
  const nestedEvidenceDirectory = join(environment.workspaceRoot, "nested-evidence");
  mkdirSync(nestedEvidenceDirectory, { mode: 0o700 });
  const previousReceiptPath = process.env.R1_03E_RECEIPT_PATH;
  process.env.R1_03E_RECEIPT_PATH = join(nestedEvidenceDirectory, "receipt.json");
  try {
    expectReceiptError(
      "oracle_receipt_path_invalid",
      () => writeR103eReceipt(environment, "accepted", minimalReceipt()),
    );
  } finally {
    if (previousReceiptPath === undefined) {
      delete process.env.R1_03E_RECEIPT_PATH;
    } else {
      process.env.R1_03E_RECEIPT_PATH = previousReceiptPath;
    }
  }
});

test("different nonce payloads preserve independent concurrent starts", async (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-concurrent-",
  });
  const inputs = Array.from({ length: 10 }, (_, index) =>
    createSafeInput(environment, "start", {
      sourceRef: `direct-outreach:safe-concurrent-${index}`,
    }));
  const results = await Promise.all(inputs.map((input) =>
    runCliAsync(
      environment,
      input.inputRoot,
      "start",
      "--input-file",
      input.basename,
      "--runner",
      "codex",
    )));
  assert.deepEqual(results.map((result) => result.code), Array(10).fill(0));
  const payloads = results.map((result) => JSON.parse(result.stdout));
  assert.deepEqual(payloads.map(({ status }) => status), Array(10).fill("created"));
  const log = JSON.parse(readFileSync(environment.ledgerPath, "utf8"));
  const expectedSources = Array.from(
    { length: inputs.length },
    (_, index) => `direct-outreach:safe-concurrent-${index}`,
  ).sort();
  assert.equal(log.processes.length, 10);
  assert.deepEqual(
    log.processes.map(({ source_ref }) => source_ref).sort(),
    expectedSources,
  );
  assert.deepEqual(
    log.processes.map(({ source_key }) => source_key).sort(),
    expectedSources,
  );
  assert.deepEqual(
    payloads.map(({ process }) => process.id).sort(),
    log.processes.map(({ id }) => id).sort(),
  );
  assert.deepEqual(new Set(log.processes.map(({ runner }) => runner)), new Set(["codex"]));
  assert.deepEqual(
    new Set(log.processes.map(({ artifact_mode }) => artifact_mode)),
    new Set(["file-backed"]),
  );
  assert.deepEqual(
    new Set(log.processes.map((record) => record.steps.get_vacancy.state)),
    new Set(["running"]),
  );
  assert.equal(inputs.every((input) => existsSync(input.path)), true);
});

test("safe-input handoff inventory matches expected, declared, and executed modes", () => {
  const inventoryResult = spawnSync(process.execPath, [lockChildPath, "--inventory"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(inventoryResult.status, 0, inventoryResult.stderr);
  const declared = JSON.parse(inventoryResult.stdout);
  assert.deepEqual(declared.safe_input_modes, expectedSafeInputModes);
  assert.deepEqual([...executedSafeInputModes].sort(), [...expectedSafeInputModes].sort());
});

// The reader is shared with a second CLI; the command vocabulary is not. These pins hold that
// line: the default map is exactly the process-log commands, and an injected map cannot reach
// process-log behaviour or widen the envelope's own bounds.
test("the default command map is the process-log vocabulary and nothing else", (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-schema-map-",
  });
  const inputRoot = ensureInputRoot(environment);
  const basename = createSafeInput(environment, "start", { sourceRef: "https://example.com/1" }, {
    inputRoot,
  }).basename;

  // A command from another CLI is refused by the default map, so the two vocabularies cannot
  // merge by accident.
  assert.throws(
    () => readSafeCliInput({ basename, command: "fetch", inputRoot }),
    (error) => {
      assert.ok(error instanceof SafeCliInputError);
      assert.equal(error.code, "safe_input_command_mismatch");
      return true;
    },
  );
  // An inherited property name is not a command. The envelope must declare the same name, or the
  // envelope/CLI command comparison fires first and the schema lookup is never reached — which is
  // exactly the hole that lets a bare index lookup resolve `toString` to a function and enter the
  // field loop with no key sets at all.
  for (const inherited of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
    const inheritedInput = createSafeInput(environment, inherited, {}, { inputRoot });
    assert.throws(
      () => readSafeCliInput({
        basename: inheritedInput.basename,
        command: inherited,
        inputRoot,
      }),
      (error) => {
        assert.ok(
          error instanceof SafeCliInputError,
          `${inherited} produced ${error?.constructor?.name}: ${error?.message}`,
        );
        assert.equal(error.code, "safe_input_command_mismatch");
        return true;
      },
      inherited,
    );
  }
});

test("an injected command map validates a bounded list of strings", (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-safe-input-string-list-",
  });
  const inputRoot = ensureInputRoot(environment);
  const schemas = Object.freeze({
    fetch: Object.freeze({
      required: ["urls"],
      optional: ["userAgent"],
      stringListFields: Object.freeze(["urls"]),
      stringListLimits: Object.freeze({
        urls: Object.freeze({ maxItems: 3, itemMaxBytes: 32 }),
      }),
    }),
  });
  const read = (values) => {
    const { basename } = createSafeInput(environment, "fetch", values, { inputRoot });
    return () => readSafeCliInput({ basename, command: "fetch", inputRoot, schemas });
  };

  const accepted = read({ urls: ["https://a.example/1", "https://b.example/2"] })();
  assert.deepEqual(accepted.values.urls, ["https://a.example/1", "https://b.example/2"]);

  for (const values of [
    { urls: [] },
    { urls: ["a", "b", "c", "d"] },
    { urls: ["a", 2] },
    { urls: ["a", ""] },
    { urls: ["a", "b".repeat(33)] },
    { urls: "https://a.example/1" },
    { urls: ["a"], unexpected: "x" },
    { userAgent: "agent/1" },
  ]) {
    assert.throws(read(values), (error) => {
      assert.ok(error instanceof SafeCliInputError);
      assert.equal(error.code, "safe_input_schema_mismatch", JSON.stringify(values));
      return true;
    }, JSON.stringify(values));
  }

  // The declared defaults are frozen literals, not values derived from the module under test.
  assert.deepEqual(safeCliInputStringListDefaults, { maxItems: 512, itemMaxBytes: 4096 });
});
