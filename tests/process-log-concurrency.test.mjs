import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fileSystem, {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ProcessLogCoreError,
  processLogCorePrimaryEvidence,
  processLogCoreSecondaryEvidence,
  updateLogV3Atomic,
} from "../tools/lib/process-log-core.mjs";
import {
  createInitialFileBackedProcess,
} from "../tools/lib/process-log-v3-lifecycle.mjs";
import {
  createDisposableWorkspace,
  disposableWorkspaceEnv,
} from "./fixtures/disposable-workspace.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockChildPath = resolve(repoRoot, "tests/fixtures/process-log-lock-child.mjs");
const disposableByLedgerPath = new Map();
const expectedChildModes = Object.freeze([
  "cli-barrier",
  "hold-owner",
  "hold-successor",
  "publish-owner",
  "recover-inode",
  "recover-raw",
  "recover-validated-first",
  "recover-validated-second",
  "release-owner",
]);
const expectedSafeInputModes = Object.freeze([
  "safe-blocked-contender",
  "safe-direct-successor",
  "safe-release-owner",
  "safe-supervisor-kill",
  "safe-supervisor-term",
]);
const expectedLockScenarios = Object.freeze([
  "atomic-publication",
  "bounded-timeout",
  "boundary-255",
  "boundary-256",
  "boundary-257",
  "dead-owner",
  "empty-directory",
  "extra-key",
  "hard-link-inode",
  "hard-link-raw",
  "live-owner",
  "malformed-json",
  "missing-acquired-at",
  "missing-lock-version",
  "missing-owner-token",
  "missing-pid",
  "old-release",
  "orphan-candidate",
  "owner-record",
  "partial-json",
  "successor-aba",
  "token-length-31",
  "token-length-33",
  "token-uppercase",
  "two-recoverer",
  "wrong-lock-version",
]);
const executedChildModes = new Set();
const executedLockScenarios = new Set();

function emptyLog() {
  return {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: "2026-07-20T10:00:00.000Z",
    companies: [],
    processes: [],
  };
}

function tempLog(t, log = emptyLog()) {
  const environment = createDisposableWorkspace(t, {
    ledger: log,
    prefix: "job-search-concurrency-test-",
  });
  disposableByLedgerPath.set(environment.ledgerPath, environment);
  t.after(() => disposableByLedgerPath.delete(environment.ledgerPath));
  return environment.ledgerPath;
}

function childFailureDetails(results) {
  return results
    .map((result, index) => ({
      code: result.code,
      index,
      stderr: result.stderr,
      stdout: result.stdout,
    }))
    .filter(({ code }) => code !== 0);
}

function markerPath(environment, marker) {
  return join(environment.workspaceRoot, `.lock-fixture-${marker}`);
}

function publishMarker(environment, marker) {
  writeFileSync(markerPath(environment, marker), `${process.pid}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function waitForMarker(environment, marker, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  const path = markerPath(environment, marker);
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for lock fixture marker: ${marker}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

async function waitForEitherMarker(environment, markers, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const observed = markers.find((marker) => existsSync(markerPath(environment, marker)));
    if (observed) return observed;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for one of: ${markers.join(", ")}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

function runLockChild(environment, scenario, ...scenarioArgs) {
  return new Promise((resolveRun) => {
    execFile(process.execPath, [lockChildPath, scenario, ...scenarioArgs], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ...disposableWorkspaceEnv(environment),
      },
    }, (error, stdout, stderr) => {
      resolveRun({
        code: error?.code ?? 0,
        scenario,
        stderr,
        stdout,
      });
    });
  });
}

async function runCliBatch(path, batchId, commands) {
  const environment = disposableByLedgerPath.get(path);
  assert.ok(environment, "CLI test ledger must come from the disposable factory");
  assert.match(batchId, /^[a-z][a-z0-9-]*$/);
  const releaseMarker = `cli-${batchId}-release`;
  const runs = commands.map((args, index) => {
    const readyMarker = `cli-${batchId}-${index}-ready`;
    return {
      promise: runLockChild(
        environment,
        "cli-barrier",
        readyMarker,
        releaseMarker,
        ...args,
      ),
      readyMarker,
    };
  });
  await Promise.all(runs.map(({ readyMarker }) => waitForMarker(environment, readyMarker)));
  executedChildModes.add("cli-barrier");
  publishMarker(environment, releaseMarker);
  return Promise.all(runs.map(({ promise }) => promise));
}

function readLockSnapshot(lockPath) {
  const stats = lstatSync(lockPath);
  if (stats.isFile()) {
    return {
      entries: [],
      identity: {
        lock: { dev: stats.dev, ino: stats.ino },
      },
      kind: "file",
      ownerSource: readFileSync(lockPath, "utf8"),
    };
  }
  assert.equal(stats.isDirectory(), true);
  const entries = readdirSync(lockPath).sort();
  assert.equal(entries.length, 1);
  const entryStats = lstatSync(join(lockPath, entries[0]));
  return {
    entries,
    identity: {
      entry: { dev: entryStats.dev, ino: entryStats.ino },
      lock: { dev: stats.dev, ino: stats.ino },
    },
    kind: "directory",
    ownerSource: readFileSync(join(lockPath, entries[0]), "utf8"),
  };
}

function ownerSource({
  acquiredAt = "2026-08-04T09:00:00.000Z",
  lockVersion = 1,
  ownerToken = "0123456789abcdef0123456789abcdef",
  pid = process.pid,
  targetBytes,
} = {}) {
  const serialized = JSON.stringify({
    lock_version: lockVersion,
    pid,
    owner_token: ownerToken,
    acquired_at: acquiredAt,
  });
  const baseBytes = Buffer.byteLength(`${serialized}\n`, "utf8");
  if (targetBytes === undefined) return `${serialized}\n`;
  assert.ok(targetBytes >= baseBytes);
  return `${serialized}${" ".repeat(targetBytes - baseBytes)}\n`;
}

function recordsFromStartPayload(payload) {
  if (payload.status === "created") return [payload.process];
  assert.equal(payload.status, "duplicate");
  return payload.matches;
}

function writeLegacyLock(path, source, { stale = false } = {}) {
  const lockPath = `${path}.lock`;
  writeFileSync(lockPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
  if (stale) utimesSync(lockPath, new Date(0), new Date(0));
  return lockPath;
}

function mutateTimestamp(path, updatedAt, options) {
  return updateLogV3Atomic(path, (log) => {
    log.updated_at = updatedAt;
    return { result: "updated" };
  }, options);
}

function processRecord(index) {
  return createInitialFileBackedProcess({
    attemptId: `attempt_parallel_${index}`,
    processId: `proc_parallel_${index}`,
    runner: "codex",
    sourceRef: `parallel-fixture:${index}`,
    startedAt: `2026-07-20T10:${String(index).padStart(2, "0")}:00.000Z`,
  });
}

test("parallel starts for different vacancies preserve every process", async (t) => {
  const path = tempLog(t);
  const attempts = 32;
  const results = await runCliBatch(
    path,
    "different-starts",
    Array.from({ length: attempts }, (_, index) => [
      "start",
      "--source-ref",
      `parallel-start:${index}`,
      "--runner",
      index % 2 ? "claude-code" : "codex",
      "--company-hint",
      `Company ${index}`,
    ]),
  );
  assert.deepEqual(
    results.map((result) => result.code),
    Array(attempts).fill(0),
    `start child failures: ${JSON.stringify(childFailureDetails(results))}`,
  );
  const payloads = results.map((result) => JSON.parse(result.stdout));
  assert.deepEqual(payloads.map(({ status }) => status), Array(attempts).fill("created"));
  const log = JSON.parse(readFileSync(path, "utf8"));
  const expectedSources = Array.from(
    { length: attempts },
    (_, index) => `parallel-start:${index}`,
  ).sort();
  assert.equal(log.processes.length, attempts);
  assert.equal(new Set(log.processes.map((record) => record.id)).size, attempts);
  assert.equal(new Set(log.processes.map((record) => record.source_key)).size, attempts);
  assert.deepEqual(log.processes.map(({ source_ref }) => source_ref).sort(), expectedSources);
  assert.deepEqual(log.processes.map(({ source_key }) => source_key).sort(), expectedSources);
  assert.deepEqual(
    payloads.map(({ process }) => process.id).sort(),
    log.processes.map(({ id }) => id).sort(),
  );
  for (const record of log.processes) {
    const index = Number.parseInt(record.source_ref.split(":").at(-1), 10);
    assert.equal(record.runner, index % 2 ? "claude-code" : "codex");
    assert.equal(record.company_hint, `Company ${index}`);
    assert.equal(record.artifact_mode, "file-backed");
    assert.equal(record.steps.get_vacancy.state, "running");
  }
});

test("parallel starts for one source create once and report duplicates", async (t) => {
  const path = tempLog(t);
  const attempts = 20;
  const results = await runCliBatch(
    path,
    "duplicate-starts",
    Array.from({ length: attempts }, () => [
      "start",
      "--source-ref",
      "parallel-duplicate:same",
      "--runner",
      "codex",
    ]),
  );
  assert.equal(results.filter((result) => result.code === 0).length, 1);
  assert.equal(results.filter((result) => result.code === 2).length, attempts - 1);
  const payloads = results.map((result) => JSON.parse(result.stdout));
  for (const result of results) {
    assert.equal(JSON.parse(result.stdout).status, result.code === 0 ? "created" : "duplicate");
  }
  const log = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(log.processes.length, 1);
  assert.deepEqual(
    new Set(payloads.flatMap(recordsFromStartPayload).map(({ id }) => id)),
    new Set([log.processes[0].id]),
  );
  assert.deepEqual(
    new Set(payloads.flatMap(recordsFromStartPayload).map(({ source_ref }) => source_ref)),
    new Set(["parallel-duplicate:same"]),
  );
  for (const payload of payloads.filter(({ status }) => status === "duplicate")) {
    assert.equal(payload.matches.length, 1);
    assert.deepEqual(payload.matches[0], log.processes[0]);
  }
  assert.equal(log.processes[0].source_key, "parallel-duplicate:same");
  assert.equal(log.processes[0].runner, "codex");
  assert.equal(log.processes[0].artifact_mode, "file-backed");
  assert.equal(log.processes[0].steps.get_vacancy.state, "running");
});

test("parallel updates and output reservations preserve independent fields", async (t) => {
  const log = emptyLog();
  log.processes = Array.from({ length: 16 }, (_, index) => processRecord(index));
  log.updated_at = log.processes.at(-1).started_at;
  const path = tempLog(t, log);
  const updateCommands = log.processes.map((record, index) => [
      "update",
      "--id",
      record.id,
      "--company-observed",
      `Company ${index}`,
      "--role",
      `Role ${index}`,
    ]);
  const updateResults = await runCliBatch(path, "updates", updateCommands);
  assert.deepEqual(
    updateResults.map((result) => result.code),
    Array(updateCommands.length).fill(0),
    `update child failures: ${JSON.stringify(childFailureDetails(updateResults))}`,
  );
  const reservationCommands = log.processes.map((record) => [
    "reserve-output",
    "--id",
    record.id,
  ]);
  const reservationResults = await runCliBatch(path, "reservations", reservationCommands);
  assert.deepEqual(
    reservationResults.map((result) => result.code),
    Array(reservationCommands.length).fill(0),
    `reserve-output child failures: ${JSON.stringify(childFailureDetails(reservationResults))}`,
  );
  const finalLog = JSON.parse(readFileSync(path, "utf8"));
  for (const [index, record] of finalLog.processes.entries()) {
    assert.equal(record.company_observed, `Company ${index}`);
    assert.equal(record.role, `Role ${index}`);
    assert.equal(record.output_dir, `output/company-${index}-role-${index}`);
    assert.equal(record.steps.get_vacancy.state, "running");
  }
});

test("parallel company creation is idempotent", async (t) => {
  const path = tempLog(t);
  const attempts = 20;
  const results = await runCliBatch(
    path,
    "company-creation",
    Array.from({ length: attempts }, () => [
      "create-company",
      "--display-name",
      "Parallel Company",
    ]),
  );
  assert.deepEqual(results.map((result) => result.code), Array(attempts).fill(0));
  const statuses = results.map((result) => JSON.parse(result.stdout).status);
  assert.equal(statuses.filter((status) => status === "created").length, 1);
  assert.equal(statuses.filter((status) => status === "existing").length, attempts - 1);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).companies.length, 1);
});

test("parallel equivalent output reservations choose deterministic unique suffixes", async (t) => {
  const log = emptyLog();
  log.processes = [processRecord(0), processRecord(1)];
  log.updated_at = log.processes.at(-1).started_at;
  const path = tempLog(t, log);
  const updates = await runCliBatch(
    path,
    "equivalent-updates",
    log.processes.map((record) => [
      "update",
      "--id",
      record.id,
      "--company-observed",
      "Shared Company",
      "--role",
      "Shared Role",
    ]),
  );
  assert.deepEqual(updates.map((result) => result.code), [0, 0]);
  const results = await runCliBatch(
    path,
    "equivalent-reservations",
    log.processes.map((record) => ["reserve-output", "--id", record.id]),
  );
  assert.deepEqual(results.map((result) => result.code), [0, 0]);
  const finalLog = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(
    finalLog.processes.map((record) => record.output_dir).sort(),
    ["output/shared-company-shared-role", "output/shared-company-shared-role-2"],
  );
});

test("a lock abandoned by a terminated writer is recovered", (t) => {
  const path = tempLog(t);
  const lockPath = `${path}.lock`;
  writeFileSync(lockPath, `${JSON.stringify({
    pid: 2_147_483_647,
    acquired_at: "2026-07-20T10:00:00.000Z",
  })}\n`, "utf8");

  const result = updateLogV3Atomic(path, (log) => {
    log.updated_at = "2026-07-20T11:00:00.000Z";
    return { result: "updated" };
  });

  assert.equal(result, "updated");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).updated_at, "2026-07-20T11:00:00.000Z");
  assert.equal(existsSync(lockPath), false);
});

test("a live writer lock is never removed as stale", (t) => {
  const path = tempLog(t);
  const lockPath = `${path}.lock`;
  writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    acquired_at: "2026-07-20T10:00:00.000Z",
  })}\n`, "utf8");

  assert.throws(
    () => updateLogV3Atomic(
      path,
      () => ({ result: "unexpected" }),
      { timeoutMs: 40, staleAfterMs: 1 },
    ),
    (error) => {
      assert.equal(error instanceof ProcessLogCoreError, true);
      assert.equal(error.code, "process_log_lock_timeout");
      assert.equal(error.causeCode, "LOCK_TIMEOUT");
      assert.equal(error.context, "operation=acquire_process_log_lock");
      assert.equal(error.recoveryAction, "retry_process_log_command");
      assert.match(error.message, /Timed out after 40ms waiting for the process log lock/);
      return true;
    },
  );
  assert.equal(existsSync(lockPath), true);
  rmSync(lockPath);
});

test("published owner record has bounded exact identity", async (t) => {
  const path = tempLog(t);
  const environment = disposableByLedgerPath.get(path);
  const lockPath = `${path}.lock`;
  const holderPromise = runLockChild(environment, "hold-owner");
  await waitForMarker(environment, "owner-acquired");
  let snapshot;
  let entryStats;
  try {
    snapshot = readLockSnapshot(lockPath);
    if (snapshot.kind === "directory") {
      entryStats = statSync(join(lockPath, snapshot.entries[0]));
    }
  } finally {
    publishMarker(environment, "owner-write");
  }
  const holder = await holderPromise;
  executedChildModes.add(holder.scenario);
  executedLockScenarios.add("owner-record");

  assert.equal(holder.code, 0, holder.stderr);
  const holderPayload = JSON.parse(holder.stdout);
  assert.deepEqual(holderPayload, {
    pid: holderPayload.pid,
    scenario: "hold-owner",
    status: "completed",
  });
  assert.equal(Number.isSafeInteger(holderPayload.pid) && holderPayload.pid > 0, true);
  assert.equal(snapshot.kind, "directory");
  assert.match(snapshot.entries[0], /^[0-9a-f]{32}\.json$/);
  const owner = JSON.parse(snapshot.ownerSource);
  assert.deepEqual(Object.keys(owner).sort(), [
    "acquired_at",
    "lock_version",
    "owner_token",
    "pid",
  ]);
  assert.equal(owner.lock_version, 1);
  assert.equal(owner.pid, holderPayload.pid);
  assert.match(owner.owner_token, /^[0-9a-f]{32}$/);
  assert.equal(snapshot.entries[0], `${owner.owner_token}.json`);
  assert.equal(Number.isFinite(Date.parse(owner.acquired_at)), true);
  assert.equal(entryStats.size, Buffer.byteLength(snapshot.ownerSource, "utf8"));
  assert.ok(entryStats.size <= 256, `owner record is ${entryStats.size} bytes`);
});

test("owner publication is atomic only after the bounded record is complete", async (t) => {
  const path = tempLog(t);
  const environment = disposableByLedgerPath.get(path);
  const lockPath = `${path}.lock`;
  const publisherPromise = runLockChild(environment, "publish-owner");
  await waitForMarker(environment, "owner-before-record");
  const authoritativeExistedBeforeRecord = existsSync(lockPath);
  publishMarker(environment, "owner-record-continue");
  await waitForMarker(environment, "publisher-entered");
  const publishedSnapshot = readLockSnapshot(lockPath);
  publishMarker(environment, "publisher-write");
  const publisher = await publisherPromise;
  executedChildModes.add(publisher.scenario);
  executedLockScenarios.add("atomic-publication");

  assert.equal(publisher.code, 0, publisher.stderr);
  assert.equal(authoritativeExistedBeforeRecord, false);
  assert.equal(publishedSnapshot.kind, "directory");
  assert.equal(publishedSnapshot.entries.length, 1);
});

test("legacy owner classification covers dead, live, malformed, and byte boundaries", (t) => {
  const caseFailures = [];
  const exerciseCase = (id, exercise) => {
    executedLockScenarios.add(id);
    try {
      exercise();
    } catch (error) {
      caseFailures.push(`${id}: ${error.message}`);
    }
  };
  const successfulCases = [
    {
      id: "dead-owner",
      source: ownerSource({ pid: 2_147_483_647 }),
      stale: false,
    },
    {
      id: "partial-json",
      source: '{"lock_version":1,"pid":',
      stale: true,
    },
    {
      id: "malformed-json",
      source: "not-json\n",
      stale: true,
    },
    {
      id: "missing-lock-version",
      source: `${JSON.stringify({
        pid: process.pid,
        owner_token: "0123456789abcdef0123456789abcdef",
        acquired_at: "2026-08-04T09:00:00.000Z",
      })}\n`,
      stale: true,
    },
    {
      id: "missing-pid",
      source: `${JSON.stringify({
        lock_version: 1,
        owner_token: "0123456789abcdef0123456789abcdef",
        acquired_at: "2026-08-04T09:00:00.000Z",
      })}\n`,
      stale: true,
    },
    {
      id: "missing-owner-token",
      source: `${JSON.stringify({
        lock_version: 1,
        pid: process.pid,
        acquired_at: "2026-08-04T09:00:00.000Z",
      })}\n`,
      stale: true,
    },
    {
      id: "missing-acquired-at",
      source: `${JSON.stringify({
        lock_version: 1,
        pid: process.pid,
        owner_token: "0123456789abcdef0123456789abcdef",
      })}\n`,
      stale: true,
    },
    {
      id: "extra-key",
      source: `${JSON.stringify({
        lock_version: 1,
        pid: process.pid,
        owner_token: "0123456789abcdef0123456789abcdef",
        acquired_at: "2026-08-04T09:00:00.000Z",
        extra: true,
      })}\n`,
      stale: true,
    },
    {
      id: "wrong-lock-version",
      source: ownerSource({ lockVersion: 2 }),
      stale: true,
    },
    {
      id: "token-uppercase",
      source: ownerSource({ ownerToken: "ABCDEF0123456789ABCDEF0123456789" }),
      stale: true,
    },
    {
      id: "token-length-31",
      source: ownerSource({ ownerToken: "0123456789abcdef0123456789abcde" }),
      stale: true,
    },
    {
      id: "token-length-33",
      source: ownerSource({ ownerToken: "0123456789abcdef0123456789abcdef0" }),
      stale: true,
    },
    {
      id: "boundary-257",
      source: ownerSource({ targetBytes: 257 }),
      stale: true,
    },
  ];
  for (const [index, fixture] of successfulCases.entries()) {
    exerciseCase(fixture.id, () => {
      const path = tempLog(t);
      const lockPath = writeLegacyLock(path, fixture.source, { stale: fixture.stale });
      assert.equal(
        mutateTimestamp(path, `2026-08-04T11:00:${String(index).padStart(2, "0")}.000Z`, {
          timeoutMs: 80,
          staleAfterMs: 1,
        }),
        "updated",
      );
      assert.equal(existsSync(lockPath), false);
    });
  }

  for (const targetBytes of [255, 256]) {
    const id = `boundary-${targetBytes}`;
    exerciseCase(id, () => {
      const path = tempLog(t);
      const source = ownerSource({ targetBytes });
      const lockPath = writeLegacyLock(path, source, { stale: true });
      assert.throws(
        () => mutateTimestamp(path, "2026-08-04T11:01:00.000Z", {
          timeoutMs: 35,
          staleAfterMs: 1,
        }),
        /Timed out after 35ms waiting for the process log lock/,
      );
      assert.equal(readFileSync(lockPath, "utf8"), source);
      rmSync(lockPath);
    });
  }

  exerciseCase("live-owner", () => {
    const livePath = tempLog(t);
    const liveSource = ownerSource();
    const liveLockPath = writeLegacyLock(livePath, liveSource, { stale: true });
    assert.throws(
      () => mutateTimestamp(livePath, "2026-08-04T11:02:00.000Z", {
        timeoutMs: 35,
        staleAfterMs: 1,
      }),
      /Timed out after 35ms waiting for the process log lock/,
    );
    assert.equal(readFileSync(liveLockPath, "utf8"), liveSource);
    rmSync(liveLockPath);
  });

  exerciseCase("bounded-timeout", () => {
    const freshPath = tempLog(t);
    const freshLockPath = writeLegacyLock(freshPath, "{\n");
    const startedAt = Date.now();
    assert.throws(
      () => mutateTimestamp(freshPath, "2026-08-04T11:03:00.000Z", {
        timeoutMs: 30,
        staleAfterMs: 60_000,
      }),
      /Timed out after 30ms waiting for the process log lock/,
    );
    assert.ok(Date.now() - startedAt < 1_000);
    assert.equal(readFileSync(freshLockPath, "utf8"), "{\n");
    rmSync(freshLockPath);
  });

  assert.deepEqual(caseFailures, []);
});

test("empty authoritative directory recovers while candidate orphans stay inert", (t) => {
  const failures = [];
  try {
    const emptyPath = tempLog(t);
    const emptyLockPath = `${emptyPath}.lock`;
    mkdirSync(emptyLockPath, { mode: 0o700 });
    utimesSync(emptyLockPath, new Date(0), new Date(0));
    assert.equal(
      mutateTimestamp(emptyPath, "2026-08-04T11:04:00.000Z", {
        timeoutMs: 80,
        staleAfterMs: 1,
      }),
      "updated",
    );
    assert.equal(existsSync(emptyLockPath), false);
  } catch (error) {
    failures.push(`empty-directory: ${error.message}`);
  }
  executedLockScenarios.add("empty-directory");

  try {
    const orphanPath = tempLog(t);
    const orphanLockPath = `${orphanPath}.lock`;
    const orphanCandidate = `${orphanLockPath}.candidate-orphan`;
    mkdirSync(orphanCandidate, { mode: 0o700 });
    writeFileSync(join(orphanCandidate, "orphan.json"), "{}\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    assert.equal(
      mutateTimestamp(orphanPath, "2026-08-04T11:05:00.000Z"),
      "updated",
    );
    assert.equal(existsSync(orphanCandidate), true);
    assert.equal(existsSync(orphanLockPath), false);
  } catch (error) {
    failures.push(`orphan-candidate: ${error.message}`);
  }
  executedLockScenarios.add("orphan-candidate");
  assert.deepEqual(failures, []);
});

async function exerciseLegacyIdentitySwap(t, identity) {
  const path = tempLog(t);
  const environment = disposableByLedgerPath.get(path);
  const originalSource = ownerSource({ pid: 2_147_483_647 });
  const lockPath = writeLegacyLock(path, originalSource);
  const ledgerBefore = readFileSync(path, "utf8");
  const recovererPromise = runLockChild(environment, `recover-${identity}`);
  await waitForMarker(environment, `${identity}-claimed`);

  if (identity === "inode") {
    unlinkSync(lockPath);
    writeFileSync(lockPath, originalSource, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } else {
    writeFileSync(lockPath, ownerSource({ pid: process.pid }), {
      encoding: "utf8",
      flag: "w",
      mode: 0o600,
    });
  }
  const replacementSnapshot = readLockSnapshot(lockPath);
  publishMarker(environment, `${identity}-continue`);
  publishMarker(environment, `${identity}-write`);
  const recoverer = await recovererPromise;
  executedChildModes.add(recoverer.scenario);
  executedLockScenarios.add(`hard-link-${identity}`);

  const evidence = {
    identity,
    ledgerUnchanged: readFileSync(path, "utf8") === ledgerBefore,
    recoverer,
    replacementPreserved: existsSync(lockPath)
      && JSON.stringify(readLockSnapshot(lockPath)) === JSON.stringify(replacementSnapshot),
    unsafeUnlink: existsSync(markerPath(environment, `${identity}-unsafe-unlink`)),
  };
  if (existsSync(lockPath)) rmSync(lockPath);
  return evidence;
}

test("legacy hard-link recovery verifies inode and raw identity before unlink", async (t) => {
  const evidence = [];
  for (const identity of ["inode", "raw"]) {
    evidence.push(await exerciseLegacyIdentitySwap(t, identity));
  }
  for (const result of evidence) {
    assert.notEqual(
      result.recoverer.code,
      0,
      `${result.identity} mismatch unexpectedly entered the critical section`,
    );
    assert.match(
      result.recoverer.stderr,
      /Timed out after 800ms waiting for the process log lock/,
    );
    assert.equal(result.unsafeUnlink, false);
    assert.equal(result.replacementPreserved, true);
    assert.equal(result.ledgerUnchanged, true);
  }
});

test("an old release cannot delete a successor owner", async (t) => {
  const path = tempLog(t);
  const environment = disposableByLedgerPath.get(path);
  const lockPath = `${path}.lock`;
  const detachedPath = `${lockPath}.detached-old`;
  const oldOwnerPromise = runLockChild(environment, "release-owner");
  await waitForMarker(environment, "release-observed");
  renameSync(lockPath, detachedPath);

  const successorPromise = runLockChild(environment, "hold-successor");
  await waitForMarker(environment, "successor-acquired");
  const successorSnapshot = readLockSnapshot(lockPath);
  publishMarker(environment, "release-continue");
  const oldOwner = await oldOwnerPromise;
  const successorAfterOldRelease = existsSync(lockPath)
    ? readLockSnapshot(lockPath)
    : null;
  publishMarker(environment, "successor-write");
  const successor = await successorPromise;
  for (const result of [oldOwner, successor]) {
    executedChildModes.add(result.scenario);
    assert.equal(result.code, 0, result.stderr);
  }
  executedLockScenarios.add("old-release");

  assert.deepEqual(successorAfterOldRelease, successorSnapshot);
  assert.equal(existsSync(lockPath), false);
});

test("two recoverers cannot steal a successor lock or overlap its owner", async (t) => {
  const path = tempLog(t);
  const environment = disposableByLedgerPath.get(path);
  const lockPath = writeLegacyLock(path, ownerSource({ pid: 2_147_483_647 }));
  const firstPromise = runLockChild(environment, "recover-validated-first");
  const secondPromise = runLockChild(environment, "recover-validated-second");
  await Promise.all([
    waitForMarker(environment, "first-validated"),
    waitForMarker(environment, "second-validated"),
  ]);
  const ledgerBefore = readFileSync(path, "utf8");
  publishMarker(environment, "first-unlink");
  await waitForMarker(environment, "first-acquired");
  const successorSnapshot = readLockSnapshot(lockPath);
  publishMarker(environment, "second-unlink");
  const secondOutcome = await waitForEitherMarker(environment, [
    "second-blocked-after-unlink",
    "second-acquired",
  ]);
  const lockAfterSecondUnlink = existsSync(lockPath) ? readLockSnapshot(lockPath) : null;
  const ledgerAfterSecondUnlink = readFileSync(path, "utf8");

  publishMarker(environment, "first-write");
  publishMarker(environment, "second-write");
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  for (const result of [first, second]) {
    executedChildModes.add(result.scenario);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload, {
      pid: payload.pid,
      scenario: result.scenario,
      status: "completed",
    });
    assert.equal(Number.isSafeInteger(payload.pid) && payload.pid > 0, true);
  }
  for (const scenario of ["successor-aba", "two-recoverer"]) {
    executedLockScenarios.add(scenario);
  }

  assert.equal(
    secondOutcome,
    "second-blocked-after-unlink",
    "second validated recoverer entered before the successor owner wrote",
  );
  assert.deepEqual(lockAfterSecondUnlink, successorSnapshot);
  assert.equal(ledgerAfterSecondUnlink, ledgerBefore);
  assert.equal(existsSync(lockPath), false);
  assert.equal(
    JSON.parse(readFileSync(path, "utf8")).updated_at,
    "2026-08-04T10:00:07.000Z",
  );
});

test("atomic writer reports a typed bounded storage failure and preserves ledger bytes", (t) => {
  const path = tempLog(t);
  const ledgerBefore = readFileSync(path, "utf8");
  const originalWriteFileSync = fileSystem.writeFileSync.bind(fileSystem);
  const mockedWriteFileSync = t.mock.method(
    fileSystem,
    "writeFileSync",
    (targetPath, ...args) => {
      if (
        typeof targetPath === "string"
        && targetPath.startsWith(`${path}.`)
        && targetPath.endsWith(".tmp")
      ) {
        throw Object.assign(new Error("synthetic storage failure"), { code: "ENOSPC" });
      }
      return originalWriteFileSync(targetPath, ...args);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => updateLogV3Atomic(path, (log) => {
        log.updated_at = "2026-07-20T10:01:00.000Z";
        return { result: "unreachable" };
      }),
      (error) => {
        assert.equal(error instanceof ProcessLogCoreError, true);
        assert.deepEqual({
          causeCode: error.causeCode,
          code: error.code,
          context: error.context,
          message: error.message,
          recoveryAction: error.recoveryAction,
        }, {
          causeCode: "ENOSPC",
          code: "process_log_write_failed",
          context: "operation=write_process_log",
          message: "Process log could not be written.",
          recoveryAction: "free_process_log_storage",
        });
        return true;
      },
    );
  } finally {
    mockedWriteFileSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(path, "utf8"), ledgerBefore);
  assert.equal(existsSync(`${path}.lock`), false);
});

test("atomic writer never mistakes a thrown null value for successful persistence", (t) => {
  const path = tempLog(t);
  const ledgerBefore = readFileSync(path, "utf8");
  const originalWriteFileSync = fileSystem.writeFileSync.bind(fileSystem);
  const mockedWriteFileSync = t.mock.method(
    fileSystem,
    "writeFileSync",
    (targetPath, ...args) => {
      if (
        typeof targetPath === "string"
        && targetPath.startsWith(`${path}.`)
        && targetPath.endsWith(".tmp")
      ) {
        throw null;
      }
      return originalWriteFileSync(targetPath, ...args);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => updateLogV3Atomic(path, (log) => {
        log.updated_at = "2026-07-20T10:01:00.000Z";
        return { result: "unreachable" };
      }),
      (error) => {
        assert.equal(error instanceof ProcessLogCoreError, true);
        assert.deepEqual({
          causeCode: error.causeCode,
          code: error.code,
          context: error.context,
          message: error.message,
          recoveryAction: error.recoveryAction,
        }, {
          causeCode: "UNKNOWN",
          code: "process_log_write_failed",
          context: "operation=write_process_log",
          message: "Process log could not be written.",
          recoveryAction: "inspect_process_log_write_path",
        });
        return true;
      },
    );
  } finally {
    mockedWriteFileSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(path, "utf8"), ledgerBefore);
  assert.equal(existsSync(`${path}.lock`), false);
});

test("lock publication rejects a non-directory candidate identity", (t) => {
  const path = tempLog(t);
  const ledgerBefore = readFileSync(path, "utf8");
  const originalLstatSync = fileSystem.lstatSync.bind(fileSystem);
  let candidateObserved = false;
  const mockedLstatSync = t.mock.method(fileSystem, "lstatSync", (targetPath, ...args) => {
    const stats = originalLstatSync(targetPath, ...args);
    if (
      typeof targetPath === "string"
      && targetPath.startsWith(`${path}.lock.candidate-`)
    ) {
      candidateObserved = true;
      return new Proxy(stats, {
        get(target, property, receiver) {
          if (property === "isDirectory") return () => false;
          return Reflect.get(target, property, receiver);
        },
      });
    }
    return stats;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => updateLogV3Atomic(path, () => ({ changed: false, result: "unreachable" })),
      (error) => {
        assert.equal(error instanceof ProcessLogCoreError, true);
        assert.deepEqual({
          causeCode: error.causeCode,
          code: error.code,
          context: error.context,
          message: error.message,
          recoveryAction: error.recoveryAction,
        }, {
          causeCode: "LOCK_IDENTITY_INVALID",
          code: "process_log_lock_failed",
          context: "operation=acquire_process_log_lock",
          message: "Process log lock could not be acquired.",
          recoveryAction: "inspect_process_log_lock",
        });
        return true;
      },
    );
  } finally {
    mockedLstatSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(candidateObserved, true);
  assert.equal(readFileSync(path, "utf8"), ledgerBefore);
  assert.equal(existsSync(`${path}.lock`), false);
});

test("checked lock release reports a typed failure instead of returning success", (t) => {
  const path = tempLog(t);
  const ledgerBefore = readFileSync(path, "utf8");
  const originalUnlinkSync = fileSystem.unlinkSync.bind(fileSystem);
  const mockedUnlinkSync = t.mock.method(fileSystem, "unlinkSync", (targetPath, ...args) => {
    if (typeof targetPath === "string" && targetPath.startsWith(`${path}.lock/`)) {
      throw Object.assign(new Error("synthetic release failure"), { code: "EACCES" });
    }
    return originalUnlinkSync(targetPath, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => updateLogV3Atomic(path, () => ({ changed: false, result: "unreachable" })),
      (error) => {
        assert.equal(error instanceof ProcessLogCoreError, true);
        assert.deepEqual({
          causeCode: error.causeCode,
          code: error.code,
          context: error.context,
          message: error.message,
          recoveryAction: error.recoveryAction,
        }, {
          causeCode: "EACCES",
          code: "process_log_lock_release_failed",
          context: "operation=release_process_log_lock",
          message: "Process log lock could not be released.",
          recoveryAction: "repair_process_log_access",
        });
        return true;
      },
    );
  } finally {
    mockedUnlinkSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(path, "utf8"), ledgerBefore);
  assert.equal(existsSync(`${path}.lock`), true);
  rmSync(`${path}.lock`, { recursive: true });
});

test("checked lock release bounds a hostile owner-unlink cause getter", (t) => {
  const path = tempLog(t);
  const lockPath = `${path}.lock`;
  const ledgerBefore = readFileSync(path, "utf8");
  const originalUnlinkSync = fileSystem.unlinkSync.bind(fileSystem);
  const mockedUnlinkSync = t.mock.method(fileSystem, "unlinkSync", (targetPath, ...args) => {
    if (typeof targetPath === "string" && targetPath.startsWith(`${lockPath}/`)) {
      throw new Proxy(new Error("synthetic hostile release failure"), {
        get(target, property, receiver) {
          if (property === "code") throw new Error("HOSTILE_RELEASE_CODE_GETTER_SECRET");
          return Reflect.get(target, property, receiver);
        },
      });
    }
    return originalUnlinkSync(targetPath, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => updateLogV3Atomic(path, () => ({ changed: false, result: "unreachable" })),
      (error) => {
        assert.equal(error instanceof ProcessLogCoreError, true);
        assert.equal(error.code, "process_log_lock_release_failed");
        assert.equal(error.causeCode, "UNKNOWN");
        assert.equal(error.context, "operation=release_process_log_lock");
        assert.equal(error.recoveryAction, "inspect_process_log_lock");
        assert.doesNotMatch(error.message, /HOSTILE|SECRET/);
        return true;
      },
    );
  } finally {
    mockedUnlinkSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(path, "utf8"), ledgerBefore);
  assert.equal(existsSync(lockPath), true);
  rmSync(lockPath, { recursive: true });
});

test("lock release accepts an already absent directory after owner removal", (t) => {
  const path = tempLog(t);
  const lockPath = `${path}.lock`;
  const ledgerBefore = readFileSync(path, "utf8");
  const originalRmdirSync = fileSystem.rmdirSync.bind(fileSystem);
  let lockRmdirCalls = 0;
  const mockedRmdirSync = t.mock.method(fileSystem, "rmdirSync", (targetPath, ...args) => {
    if (targetPath === lockPath) {
      lockRmdirCalls += 1;
      originalRmdirSync(targetPath, ...args);
      throw Object.assign(new Error("synthetic already absent lock"), { code: "ENOENT" });
    }
    return originalRmdirSync(targetPath, ...args);
  });
  syncBuiltinESMExports();
  let result;
  try {
    result = updateLogV3Atomic(path, () => ({ changed: false, result: "released" }));
  } finally {
    mockedRmdirSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(result, "released");
  assert.equal(lockRmdirCalls, 1);
  assert.equal(readFileSync(path, "utf8"), ledgerBefore);
  assert.equal(existsSync(lockPath), false);
});

test("lock release accepts disappearance during either identity recheck", async (t) => {
  for (const phase of ["owner_entry", "rmdir_contention"]) {
    await t.test(phase, (subtest) => {
      const path = tempLog(subtest);
      const lockPath = `${path}.lock`;
      const ledgerBefore = readFileSync(path, "utf8");
      const originalUnlinkSync = fileSystem.unlinkSync.bind(fileSystem);
      const originalRmdirSync = fileSystem.rmdirSync.bind(fileSystem);
      let injected = 0;
      const mockedUnlinkSync = subtest.mock.method(
        fileSystem,
        "unlinkSync",
        (targetPath, ...args) => {
          if (
            phase === "owner_entry"
            && typeof targetPath === "string"
            && targetPath.startsWith(`${lockPath}/`)
          ) {
            injected += 1;
            originalUnlinkSync(targetPath, ...args);
            originalRmdirSync(lockPath);
            throw Object.assign(new Error("synthetic disappeared owner directory"), {
              code: "ENOENT",
            });
          }
          return originalUnlinkSync(targetPath, ...args);
        },
      );
      const mockedRmdirSync = subtest.mock.method(
        fileSystem,
        "rmdirSync",
        (targetPath, ...args) => {
          if (phase === "rmdir_contention" && targetPath === lockPath) {
            injected += 1;
            originalRmdirSync(targetPath, ...args);
            throw Object.assign(new Error("synthetic disappeared contention directory"), {
              code: "EEXIST",
            });
          }
          return originalRmdirSync(targetPath, ...args);
        },
      );
      syncBuiltinESMExports();
      let result;
      try {
        result = updateLogV3Atomic(path, () => ({ changed: false, result: phase }));
      } finally {
        mockedUnlinkSync.mock.restore();
        mockedRmdirSync.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(result, phase);
      assert.equal(injected, 1);
      assert.equal(readFileSync(path, "utf8"), ledgerBefore);
      assert.equal(existsSync(lockPath), false);
    });
  }
});

test("lock release reports typed identity-inspection failures in both recheck branches", async (t) => {
  for (const branch of ["owner_entry", "rmdir_contention"]) {
    await t.test(branch, (subtest) => {
      const path = tempLog(subtest);
      const lockPath = `${path}.lock`;
      const ledgerBefore = readFileSync(path, "utf8");
      const originalUnlinkSync = fileSystem.unlinkSync.bind(fileSystem);
      const originalRmdirSync = fileSystem.rmdirSync.bind(fileSystem);
      const originalLstatSync = fileSystem.lstatSync.bind(fileSystem);
      let identityFailureArmed = false;
      const mockedUnlinkSync = subtest.mock.method(
        fileSystem,
        "unlinkSync",
        (targetPath, ...args) => {
          if (
            branch === "owner_entry"
            && typeof targetPath === "string"
            && targetPath.startsWith(`${lockPath}/`)
          ) {
            originalUnlinkSync(targetPath, ...args);
            identityFailureArmed = true;
            throw Object.assign(new Error("synthetic missing owner entry"), { code: "ENOENT" });
          }
          return originalUnlinkSync(targetPath, ...args);
        },
      );
      const mockedRmdirSync = subtest.mock.method(
        fileSystem,
        "rmdirSync",
        (targetPath, ...args) => {
          if (branch === "rmdir_contention" && targetPath === lockPath) {
            identityFailureArmed = true;
            throw Object.assign(new Error("synthetic release contention"), { code: "ENOTEMPTY" });
          }
          return originalRmdirSync(targetPath, ...args);
        },
      );
      const mockedLstatSync = subtest.mock.method(
        fileSystem,
        "lstatSync",
        (targetPath, ...args) => {
          if (identityFailureArmed && targetPath === lockPath) {
            throw Object.assign(new Error("synthetic identity inspection failure"), {
              code: "EACCES",
            });
          }
          return originalLstatSync(targetPath, ...args);
        },
      );
      syncBuiltinESMExports();
      try {
        assert.throws(
          () => updateLogV3Atomic(path, () => ({ changed: false, result: "unreachable" })),
          (error) => {
            assert.equal(error instanceof ProcessLogCoreError, true);
            assert.deepEqual({
              causeCode: error.causeCode,
              code: error.code,
              context: error.context,
              message: error.message,
              recoveryAction: error.recoveryAction,
            }, {
              causeCode: "EACCES",
              code: "process_log_lock_release_failed",
              context: "operation=release_process_log_lock",
              message: "Process log lock could not be released.",
              recoveryAction: "repair_process_log_access",
            });
            return true;
          },
        );
      } finally {
        mockedLstatSync.mock.restore();
        mockedRmdirSync.mock.restore();
        mockedUnlinkSync.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(readFileSync(path, "utf8"), ledgerBefore);
      assert.equal(existsSync(lockPath), true);
      rmSync(lockPath, { recursive: true });
    });
  }
});

test("missing owner entry fails when the same lock directory remains", (t) => {
  const path = tempLog(t);
  const lockPath = `${path}.lock`;
  const ledgerBefore = readFileSync(path, "utf8");
  const originalUnlinkSync = fileSystem.unlinkSync.bind(fileSystem);
  const mockedUnlinkSync = t.mock.method(fileSystem, "unlinkSync", (targetPath, ...args) => {
    if (typeof targetPath === "string" && targetPath.startsWith(`${lockPath}/`)) {
      originalUnlinkSync(targetPath, ...args);
      throw Object.assign(new Error("synthetic missing owner entry"), { code: "ENOENT" });
    }
    return originalUnlinkSync(targetPath, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => updateLogV3Atomic(path, () => ({ changed: false, result: "unreachable" })),
      (error) => {
        assert.equal(error instanceof ProcessLogCoreError, true);
        assert.deepEqual({
          causeCode: error.causeCode,
          code: error.code,
          context: error.context,
          message: error.message,
          recoveryAction: error.recoveryAction,
        }, {
          causeCode: "LOCK_OWNER_ENTRY_MISSING",
          code: "process_log_lock_release_failed",
          context: "operation=release_process_log_lock",
          message: "Process log lock could not be released.",
          recoveryAction: "inspect_process_log_lock",
        });
        return true;
      },
    );
  } finally {
    mockedUnlinkSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(path, "utf8"), ledgerBefore);
  assert.equal(existsSync(lockPath), true);
  assert.deepEqual(readdirSync(lockPath), []);
  rmSync(lockPath, { recursive: true });
});

test("lock release fails after bounded same-identity directory retries", async (t) => {
  for (const causeCode of ["EEXIST", "ENOTEMPTY"]) {
    await t.test(causeCode, (subtest) => {
      const path = tempLog(subtest);
      const lockPath = `${path}.lock`;
      const ledgerBefore = readFileSync(path, "utf8");
      const originalRmdirSync = fileSystem.rmdirSync.bind(fileSystem);
      let attempts = 0;
      const mockedRmdirSync = subtest.mock.method(
        fileSystem,
        "rmdirSync",
        (targetPath, ...args) => {
          if (targetPath === lockPath) {
            attempts += 1;
            throw Object.assign(new Error("synthetic persistent successor race"), {
              code: causeCode,
            });
          }
          return originalRmdirSync(targetPath, ...args);
        },
      );
      syncBuiltinESMExports();
      try {
        assert.throws(
          () => updateLogV3Atomic(
            path,
            () => ({ changed: false, result: "unreachable" }),
          ),
          (error) => {
            assert.equal(error instanceof ProcessLogCoreError, true);
            assert.equal(error.code, "process_log_lock_release_failed");
            assert.equal(error.causeCode, causeCode);
            assert.equal(error.context, "operation=release_process_log_lock");
            assert.equal(error.message, "Process log lock could not be released.");
            assert.equal(error.recoveryAction, "inspect_process_log_lock");
            return true;
          },
        );
      } finally {
        mockedRmdirSync.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(attempts, 20);
      assert.equal(readFileSync(path, "utf8"), ledgerBefore);
      assert.equal(existsSync(lockPath), true);
      rmSync(lockPath, { recursive: true });
    });
  }
});

test("a primary write failure retains bounded lock-release evidence", (t) => {
  const path = tempLog(t);
  const ledgerBefore = readFileSync(path, "utf8");
  const originalWriteFileSync = fileSystem.writeFileSync.bind(fileSystem);
  const originalUnlinkSync = fileSystem.unlinkSync.bind(fileSystem);
  const mockedWriteFileSync = t.mock.method(
    fileSystem,
    "writeFileSync",
    (targetPath, ...args) => {
      if (
        typeof targetPath === "string"
        && targetPath.startsWith(`${path}.`)
        && targetPath.endsWith(".tmp")
      ) {
        throw Object.assign(new Error("synthetic storage failure"), { code: "ENOSPC" });
      }
      return originalWriteFileSync(targetPath, ...args);
    },
  );
  const mockedUnlinkSync = t.mock.method(fileSystem, "unlinkSync", (targetPath, ...args) => {
    if (typeof targetPath === "string" && targetPath.startsWith(`${path}.lock/`)) {
      throw Object.assign(new Error("synthetic release failure"), { code: "EACCES" });
    }
    return originalUnlinkSync(targetPath, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => updateLogV3Atomic(path, (log) => {
        log.updated_at = "2026-07-20T10:01:00.000Z";
      }),
      (error) => {
        assert.equal(error instanceof ProcessLogCoreError, true);
        assert.equal(error.code, "process_log_write_failed");
        assert.equal(error.causeCode, "ENOSPC");
        assert.equal(error.recoveryAction, "free_process_log_storage");
        const firstEvidence = processLogCoreSecondaryEvidence(error);
        const secondEvidence = processLogCoreSecondaryEvidence(error);
        assert.notEqual(firstEvidence, secondEvidence);
        assert.notEqual(firstEvidence[0], secondEvidence[0]);
        assert.deepEqual(firstEvidence, [{
          causeCode: "EACCES",
          code: "process_log_lock_release_failed",
          context: "operation=release_process_log_lock",
          recoveryAction: "repair_process_log_access",
        }]);
        firstEvidence[0].code = "mutated_public_copy";
        assert.equal(secondEvidence[0].code, "process_log_lock_release_failed");
        return true;
      },
    );
  } finally {
    mockedWriteFileSync.mock.restore();
    mockedUnlinkSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(path, "utf8"), ledgerBefore);
  assert.equal(existsSync(`${path}.lock`), true);
  rmSync(`${path}.lock`, { recursive: true });
});

test("a non-Error primary survives a simultaneous trusted release failure", (t) => {
  const path = tempLog(t);
  const lockPath = `${path}.lock`;
  const ledgerBefore = readFileSync(path, "utf8");
  const primary = null;
  const originalUnlinkSync = fileSystem.unlinkSync.bind(fileSystem);
  const mockedUnlinkSync = t.mock.method(fileSystem, "unlinkSync", (targetPath, ...args) => {
    if (typeof targetPath === "string" && targetPath.startsWith(`${lockPath}/`)) {
      throw Object.assign(new Error("synthetic release failure"), { code: "EACCES" });
    }
    return originalUnlinkSync(targetPath, ...args);
  });
  syncBuiltinESMExports();
  let caught = Symbol("no error caught");
  try {
    updateLogV3Atomic(path, () => {
      throw primary;
    });
  } catch (error) {
    caught = error;
  } finally {
    mockedUnlinkSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(caught, primary);
  assert.equal(readFileSync(path, "utf8"), ledgerBefore);
  assert.equal(existsSync(lockPath), true);
  rmSync(lockPath, { recursive: true });
});

test("a prototype-hostile primary survives a simultaneous trusted release failure", (t) => {
  const path = tempLog(t);
  const lockPath = `${path}.lock`;
  const ledgerBefore = readFileSync(path, "utf8");
  const primary = new Proxy(new Error("safe primary placeholder"), {
    getPrototypeOf() {
      throw new Error("HOSTILE_PRIMARY_PROTOTYPE_SECRET");
    },
  });
  const originalUnlinkSync = fileSystem.unlinkSync.bind(fileSystem);
  const mockedUnlinkSync = t.mock.method(fileSystem, "unlinkSync", (targetPath, ...args) => {
    if (typeof targetPath === "string" && targetPath.startsWith(`${lockPath}/`)) {
      throw Object.assign(new Error("synthetic release failure"), { code: "EACCES" });
    }
    return originalUnlinkSync(targetPath, ...args);
  });
  syncBuiltinESMExports();
  let caught = Symbol("no error caught");
  try {
    updateLogV3Atomic(path, () => {
      throw primary;
    });
  } catch (error) {
    caught = error;
  } finally {
    mockedUnlinkSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(caught, primary);
  assert.equal(readFileSync(path, "utf8"), ledgerBefore);
  assert.equal(existsSync(lockPath), true);
  rmSync(lockPath, { recursive: true });
});

test("a failed atomic rename reports bounded temporary-file cleanup evidence", (t) => {
  const path = tempLog(t);
  const ledgerBefore = readFileSync(path, "utf8");
  const originalRenameSync = fileSystem.renameSync.bind(fileSystem);
  const originalUnlinkSync = fileSystem.unlinkSync.bind(fileSystem);
  const mockedRenameSync = t.mock.method(fileSystem, "renameSync", (from, to) => {
    if (typeof from === "string" && from.endsWith(".tmp") && to === path) {
      throw Object.assign(new Error("synthetic rename failure"), { code: "EIO" });
    }
    return originalRenameSync(from, to);
  });
  const mockedUnlinkSync = t.mock.method(fileSystem, "unlinkSync", (targetPath, ...args) => {
    if (
      typeof targetPath === "string"
      && targetPath.startsWith(`${path}.`)
      && targetPath.endsWith(".tmp")
    ) {
      throw Object.assign(new Error("synthetic cleanup failure"), { code: "EACCES" });
    }
    return originalUnlinkSync(targetPath, ...args);
  });
  syncBuiltinESMExports();
  let residue;
  try {
    assert.throws(
      () => updateLogV3Atomic(path, (log) => {
        log.updated_at = "2026-07-20T10:01:00.000Z";
      }),
      (error) => {
        assert.equal(error.code, "process_log_write_failed");
        assert.equal(error.causeCode, "EIO");
        assert.deepEqual(processLogCoreSecondaryEvidence(error), [{
          causeCode: "EACCES",
          code: "process_log_temp_cleanup_failed",
          context: "operation=cleanup_process_log_temp",
          recoveryAction: "repair_process_log_access",
        }]);
        return true;
      },
    );
    residue = readdirSync(dirname(path)).find(
      (name) => name.startsWith("process-log.json.") && name.endsWith(".tmp"),
    );
    assert.equal(typeof residue, "string");
  } finally {
    mockedRenameSync.mock.restore();
    mockedUnlinkSync.mock.restore();
    syncBuiltinESMExports();
  }
  if (residue) unlinkSync(join(dirname(path), residue));
  assert.equal(readFileSync(path, "utf8"), ledgerBefore);
  assert.equal(existsSync(`${path}.lock`), false);
});

test("a cleanup-only temporary-file failure reports after the ledger commit", (t) => {
  const path = tempLog(t);
  const committedAt = "2026-07-20T10:01:00.000Z";
  const expectedLog = emptyLog();
  expectedLog.updated_at = committedAt;
  const expectedBytes = `${JSON.stringify(expectedLog, null, 2)}\n`;
  const originalUnlinkSync = fileSystem.unlinkSync.bind(fileSystem);
  let tempPath = null;
  const mockedUnlinkSync = t.mock.method(fileSystem, "unlinkSync", (targetPath, ...args) => {
    if (
      typeof targetPath === "string"
      && targetPath.startsWith(`${path}.`)
      && targetPath.endsWith(".tmp")
    ) {
      tempPath = targetPath;
      throw Object.assign(new Error("synthetic cleanup-only failure"), { code: "EACCES" });
    }
    return originalUnlinkSync(targetPath, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => updateLogV3Atomic(path, (log) => {
        log.updated_at = committedAt;
        return { result: "unexpected_success" };
      }),
      (error) => {
        assert.equal(error instanceof ProcessLogCoreError, true);
        assert.deepEqual({
          causeCode: error.causeCode,
          code: error.code,
          context: error.context,
          message: error.message,
          recoveryAction: error.recoveryAction,
        }, {
          causeCode: "EACCES",
          code: "process_log_temp_cleanup_failed",
          context: "operation=cleanup_process_log_temp",
          message: "Process log temporary file could not be cleaned.",
          recoveryAction: "repair_process_log_access",
        });
        assert.deepEqual(processLogCoreSecondaryEvidence(error), []);
        return true;
      },
    );
  } finally {
    mockedUnlinkSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(typeof tempPath, "string");
  assert.equal(readFileSync(path, "utf8"), expectedBytes);
  assert.equal(existsSync(tempPath), false);
  assert.deepEqual(
    readdirSync(dirname(path)).filter(
      (name) => name.startsWith("process-log.json.") && name.endsWith(".tmp"),
    ),
    [],
  );
  assert.equal(existsSync(`${path}.lock`), false);
});

test("a cleanup-only thrown null still reports after the ledger commit", (t) => {
  const path = tempLog(t);
  const committedAt = "2026-07-20T10:01:00.000Z";
  const expectedLog = emptyLog();
  expectedLog.updated_at = committedAt;
  const expectedBytes = `${JSON.stringify(expectedLog, null, 2)}\n`;
  const originalUnlinkSync = fileSystem.unlinkSync.bind(fileSystem);
  let tempPath = null;
  const mockedUnlinkSync = t.mock.method(fileSystem, "unlinkSync", (targetPath, ...args) => {
    if (
      typeof targetPath === "string"
      && targetPath.startsWith(`${path}.`)
      && targetPath.endsWith(".tmp")
    ) {
      tempPath = targetPath;
      throw null;
    }
    return originalUnlinkSync(targetPath, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => updateLogV3Atomic(path, (log) => {
        log.updated_at = committedAt;
      }),
      (error) => {
        assert.equal(error instanceof ProcessLogCoreError, true);
        assert.equal(error.code, "process_log_temp_cleanup_failed");
        assert.equal(error.causeCode, "UNKNOWN");
        assert.equal(error.context, "operation=cleanup_process_log_temp");
        assert.equal(error.recoveryAction, "inspect_process_log_temp");
        return true;
      },
    );
  } finally {
    mockedUnlinkSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(typeof tempPath, "string");
  assert.equal(readFileSync(path, "utf8"), expectedBytes);
  assert.equal(existsSync(tempPath), false);
  assert.equal(existsSync(`${path}.lock`), false);
});

test("a cleanup-only hostile cause getter stays typed and bounded", (t) => {
  const path = tempLog(t);
  const committedAt = "2026-07-20T10:01:00.000Z";
  const originalUnlinkSync = fileSystem.unlinkSync.bind(fileSystem);
  const mockedUnlinkSync = t.mock.method(fileSystem, "unlinkSync", (targetPath, ...args) => {
    if (
      typeof targetPath === "string"
      && targetPath.startsWith(`${path}.`)
      && targetPath.endsWith(".tmp")
    ) {
      throw new Proxy(new Error("synthetic hostile cleanup failure"), {
        get(target, property, receiver) {
          if (property === "code") throw new Error("HOSTILE_CLEANUP_CODE_GETTER_SECRET");
          return Reflect.get(target, property, receiver);
        },
      });
    }
    return originalUnlinkSync(targetPath, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => updateLogV3Atomic(path, (log) => {
        log.updated_at = committedAt;
      }),
      (error) => {
        assert.equal(error instanceof ProcessLogCoreError, true);
        assert.equal(error.code, "process_log_temp_cleanup_failed");
        assert.equal(error.causeCode, "UNKNOWN");
        assert.equal(error.context, "operation=cleanup_process_log_temp");
        assert.equal(error.recoveryAction, "inspect_process_log_temp");
        assert.doesNotMatch(error.message, /HOSTILE|SECRET/);
        return true;
      },
    );
  } finally {
    mockedUnlinkSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(JSON.parse(readFileSync(path, "utf8")).updated_at, committedAt);
  assert.equal(existsSync(`${path}.lock`), false);
});

test("trusted core primary evidence is an immutable private snapshot", (t) => {
  const path = tempLog(t);
  const originalWriteFileSync = fileSystem.writeFileSync.bind(fileSystem);
  const mockedWriteFileSync = t.mock.method(fileSystem, "writeFileSync", (targetPath, ...args) => {
    if (
      typeof targetPath === "string"
      && targetPath.startsWith(`${path}.`)
      && targetPath.endsWith(".tmp")
    ) {
      throw Object.assign(new Error("synthetic storage failure"), { code: "ENOSPC" });
    }
    return originalWriteFileSync(targetPath, ...args);
  });
  syncBuiltinESMExports();
  let caught = null;
  try {
    updateLogV3Atomic(path, (log) => {
      log.updated_at = "2026-07-20T10:01:00.000Z";
    });
  } catch (error) {
    caught = error;
  } finally {
    mockedWriteFileSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.notEqual(caught, null);
  const expected = {
    causeCode: "ENOSPC",
    code: "process_log_write_failed",
    context: "operation=write_process_log",
    message: "Process log could not be written.",
    recoveryAction: "free_process_log_storage",
  };
  const firstEvidence = processLogCorePrimaryEvidence(caught);
  const secondEvidence = processLogCorePrimaryEvidence(caught);
  assert.notEqual(firstEvidence, secondEvidence);
  assert.deepEqual(firstEvidence, expected);
  firstEvidence.code = "mutated_public_copy";
  assert.deepEqual(secondEvidence, expected);
  caught.causeCode = "HOSTILE_CAUSE";
  caught.code = "hostile_code";
  caught.context = "/private/tmp/hostile-core-context";
  caught.message = "https://secret.invalid/hostile-core-message";
  caught.recoveryAction = "Bearer synthetic-hostile-recovery";
  assert.deepEqual(processLogCorePrimaryEvidence(caught), expected);
  assert.doesNotMatch(
    JSON.stringify(processLogCorePrimaryEvidence(caught)),
    /HOSTILE|hostile|private\/tmp|secret\.invalid|Bearer/,
  );
});

test("a primary write failure retains two ordered trusted cleanup errors", (t) => {
  const path = tempLog(t);
  const lockPath = `${path}.lock`;
  const ledgerBefore = readFileSync(path, "utf8");
  const originalRenameSync = fileSystem.renameSync.bind(fileSystem);
  const originalUnlinkSync = fileSystem.unlinkSync.bind(fileSystem);
  const mockedRenameSync = t.mock.method(fileSystem, "renameSync", (from, to) => {
    if (typeof from === "string" && from.endsWith(".tmp") && to === path) {
      throw Object.assign(new Error("synthetic rename failure"), { code: "EIO" });
    }
    return originalRenameSync(from, to);
  });
  const mockedUnlinkSync = t.mock.method(fileSystem, "unlinkSync", (targetPath, ...args) => {
    if (
      typeof targetPath === "string"
      && targetPath.startsWith(`${path}.`)
      && targetPath.endsWith(".tmp")
    ) {
      throw Object.assign(new Error("synthetic cleanup failure"), { code: "EACCES" });
    }
    if (typeof targetPath === "string" && targetPath.startsWith(`${lockPath}/`)) {
      throw Object.assign(new Error("synthetic release failure"), { code: "EPERM" });
    }
    return originalUnlinkSync(targetPath, ...args);
  });
  syncBuiltinESMExports();
  let residue;
  try {
    assert.throws(
      () => updateLogV3Atomic(path, (log) => {
        log.updated_at = "2026-07-20T10:01:00.000Z";
      }),
      (error) => {
        assert.equal(error.code, "process_log_write_failed");
        assert.equal(error.causeCode, "EIO");
        assert.deepEqual(processLogCoreSecondaryEvidence(error), [
          {
            causeCode: "EACCES",
            code: "process_log_temp_cleanup_failed",
            context: "operation=cleanup_process_log_temp",
            recoveryAction: "repair_process_log_access",
          },
          {
            causeCode: "EPERM",
            code: "process_log_lock_release_failed",
            context: "operation=release_process_log_lock",
            recoveryAction: "repair_process_log_access",
          },
        ]);
        return true;
      },
    );
    residue = readdirSync(dirname(path)).find(
      (name) => name.startsWith("process-log.json.") && name.endsWith(".tmp"),
    );
    assert.equal(typeof residue, "string");
  } finally {
    mockedRenameSync.mock.restore();
    mockedUnlinkSync.mock.restore();
    syncBuiltinESMExports();
  }
  if (residue) unlinkSync(join(dirname(path), residue));
  rmSync(lockPath, { recursive: true });
  assert.equal(readFileSync(path, "utf8"), ledgerBefore);
});

test("release recognizes either changed successor directory identity field", async (t) => {
  for (const identityField of ["ino", "dev"]) {
    await t.test(identityField, (subtest) => {
      const path = tempLog(subtest);
      const lockPath = `${path}.lock`;
      const ledgerBefore = readFileSync(path, "utf8");
      const originalLstatSync = fileSystem.lstatSync.bind(fileSystem);
      const originalRmdirSync = fileSystem.rmdirSync.bind(fileSystem);
      let successorPublished = false;
      const mockedRmdirSync = subtest.mock.method(
        fileSystem,
        "rmdirSync",
        (targetPath) => {
          if (targetPath === lockPath) {
            successorPublished = true;
            throw Object.assign(new Error("synthetic successor replacement"), {
              code: "ENOTEMPTY",
            });
          }
          return originalRmdirSync(targetPath);
        },
      );
      const mockedLstatSync = subtest.mock.method(
        fileSystem,
        "lstatSync",
        (targetPath, ...args) => {
          const stats = originalLstatSync(targetPath, ...args);
          if (successorPublished && targetPath === lockPath) {
            return new Proxy(stats, {
              get(target, property, receiver) {
                if (property === identityField) return target[identityField] + 1;
                return Reflect.get(target, property, receiver);
              },
            });
          }
          return stats;
        },
      );
      syncBuiltinESMExports();
      let result;
      try {
        result = updateLogV3Atomic(path, () => ({
          changed: false,
          result: "successor_preserved",
        }));
      } finally {
        mockedRmdirSync.mock.restore();
        mockedLstatSync.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(result, "successor_preserved");
      assert.equal(successorPublished, true);
      assert.equal(readFileSync(path, "utf8"), ledgerBefore);
      assert.equal(existsSync(lockPath), true);
      rmSync(lockPath, { recursive: true });
    });
  }
});

test("every trusted core filesystem diagnostic routes through the bounded cause owner", () => {
  const source = readFileSync(
    resolve(repoRoot, "tools/lib/process-log-core.mjs"),
    "utf8",
  );
  const boundedRoutes = source.match(/boundedCoreCauseCode\((?:error|identityError)\)/g)
    ?? [];
  assert.equal(boundedRoutes.length, 14);
  assert.doesNotMatch(
    source,
    /causeCode\s*=\s*(?:error|identityError)\?*\.code/,
  );
  const releaseOwner = source.match(
    /function releaseLock\(lock\) \{[\s\S]*?\n\}\n\nfunction processLogWriteError/,
  )?.[0] ?? "";
  const writeOwner = source.match(
    /function writeLogWithinLock\(logPath, log, validator = validateLog\) \{[\s\S]*?\n\}\n\nfunction operateWithAcquiredLock/,
  )?.[0] ?? "";
  assert.doesNotMatch(releaseOwner, /(?:error|identityError)\?*\.code/);
  assert.doesNotMatch(writeOwner, /error\?*\.code/);
});

test("secondary evidence accepts only Error primaries and private trusted secondaries", () => {
  const source = readFileSync(
    resolve(repoRoot, "tools/lib/process-log-core.mjs"),
    "utf8",
  );
  assert.match(
    source,
    /function appendSecondaryCoreError\(primaryError, secondaryError\) \{\s*try \{\s*if \(!\(primaryError instanceof Error\)\) return;\s*\} catch \{\s*return;\s*\}\s*const secondaryEvidence = trustedPrimaryErrorEvidence\.get\(secondaryError\);\s*if \(secondaryEvidence === undefined\) return;/,
  );
  assert.match(source, /\.\.\.existing\.slice\(0, 1\),/);
});

test("both lock release successor branches compare exact device and inode identity", () => {
  const source = readFileSync(
    resolve(repoRoot, "tools/lib/process-log-core.mjs"),
    "utf8",
  );
  const identityComparisons = source.match(
    /currentStats\.dev !== lock\.directoryIdentity\.dev\s*\|\|\s*currentStats\.ino !== lock\.directoryIdentity\.ino/g,
  ) ?? [];
  assert.equal(identityComparisons.length, 2);
});

test("legacy and stale lock recovery compare exact device and inode identity", () => {
  const source = readFileSync(
    resolve(repoRoot, "tools/lib/process-log-core.mjs"),
    "utf8",
  );
  assert.match(
    source,
    /return left\.stats\.dev === right\.stats\.dev\s*&& left\.stats\.ino === right\.stats\.ino/,
  );
  assert.match(
    source,
    /currentDirectory\.dev !== directoryStats\.dev\s*\|\|\s*currentDirectory\.ino !== directoryStats\.ino/,
  );
});

test("lock test inventory matches expected, declared, and executed scenarios", () => {
  const inventoryResult = spawnSync(process.execPath, [lockChildPath, "--inventory"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(inventoryResult.status, 0, inventoryResult.stderr);
  const declared = JSON.parse(inventoryResult.stdout);
  assert.deepEqual(declared.child_modes, expectedChildModes);
  assert.deepEqual(declared.lock_scenarios, expectedLockScenarios);
  assert.deepEqual(declared.safe_input_modes, expectedSafeInputModes);
  assert.deepEqual([...executedChildModes].sort(), [...expectedChildModes].sort());
  assert.deepEqual([...executedLockScenarios].sort(), [...expectedLockScenarios].sort());
});
