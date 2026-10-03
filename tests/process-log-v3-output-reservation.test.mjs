import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { readLogV3 } from "../tools/lib/process-log-core.mjs";
import { initializeOutputRoot } from "../tools/lib/output-root.mjs";
import {
  createCanonicalOutputSegment,
  reserveFileBackedOutputV3,
  startFileBackedProcessV3,
  updateFileBackedProcessV3,
} from "../tools/lib/process-log-v3-lifecycle.mjs";
import {
  createDisposableWorkspace,
  disposableWorkspaceEnv,
} from "./fixtures/disposable-workspace.mjs";

const startedAt = "2026-07-23T13:00:00.000Z";
const identifiedAt = "2026-07-23T13:05:00.000Z";
const reservedAt = "2026-07-23T13:10:00.000Z";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lifecycleModuleUrl = pathToFileURL(
  resolve(repoRoot, "tools/lib/process-log-v3-lifecycle.mjs"),
).href;
const disposableModuleUrl = pathToFileURL(
  resolve(repoRoot, "tests/fixtures/disposable-workspace.mjs"),
).href;

function emptyV3Log() {
  return {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: "2026-07-23T12:00:00.000Z",
    companies: [],
    processes: [],
  };
}

function tempEnvironment(t, log = emptyV3Log()) {
  return createDisposableWorkspace(t, {
    ledger: log,
    prefix: "job-search-output-reservation-",
  });
}

function createReadyProcess(
  environment,
  {
    companyObserved = "Example Labs",
    identifiedAt: processIdentifiedAt = identifiedAt,
    processId = "proc_output_reservation_001",
    role = "Senior SDET",
    sourceRef = "https://example.test/jobs/sdet",
    startedAt: processStartedAt = startedAt,
  } = {},
) {
  startFileBackedProcessV3(
    environment.ledgerPath,
    {
      runner: "codex",
      sourceRef,
    },
    {
      attemptIdFactory: () => `attempt_${processId}`,
      clock: () => processStartedAt,
      processIdFactory: () => processId,
    },
  );
  updateFileBackedProcessV3(
    environment.ledgerPath,
    {
      processId,
      companyObserved,
      role,
    },
    { clock: () => processIdentifiedAt },
  );
  return processId;
}

function reserve(environment, processId, options = {}) {
  return reserveFileBackedOutputV3(
    environment.ledgerPath,
    { processId },
    {
      clock: () => reservedAt,
      outputRoot: environment.outputRoot,
      workspaceRoot: environment.workspaceRoot,
      ...options,
    },
  );
}

function historicalOwner(outputDir) {
  return {
    id: "proc_historical_output_owner",
    started_at: "2026-07-20T08:00:00.000Z",
    source_ref: "historical-fixture:output-owner",
    source_key: "historical-fixture:output-owner",
    company_id: null,
    company_observed: "Example Labs",
    company_hint: null,
    role: "Senior SDET",
    runner: "codex",
    output_dir: outputDir,
    status: "output_created",
    duplicate_of: null,
  };
}

function runReservationChild(environment, processId) {
  const script = `
    import { readDisposableWorkspaceEnv } from ${JSON.stringify(disposableModuleUrl)};
    import { reserveFileBackedOutputV3 } from ${JSON.stringify(lifecycleModuleUrl)};
    const environment = readDisposableWorkspaceEnv();
    const result = reserveFileBackedOutputV3(
      environment.ledgerPath,
      { processId: process.env.TEST_V3_PROCESS_ID },
      {
        outputRoot: environment.outputRoot,
        workspaceRoot: environment.workspaceRoot,
      },
    );
    process.stdout.write(JSON.stringify({
      output_dir: result.output_dir,
      status: result.status,
    }));
  `;
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          ...disposableWorkspaceEnv(environment),
          TEST_V3_PROCESS_ID: processId,
        },
      },
      (error, stdout, stderr) => {
        resolveRun({ code: error?.code ?? 0, stderr, stdout });
      },
    );
  });
}

test("canonical output segment follows the ADR Unicode and separator algorithm", () => {
  assert.equal(
    createCanonicalOutputSegment("  Café & QA  ", "Senior / SDET"),
    "café-qa-senior-sdet",
  );
  assert.equal(createCanonicalOutputSegment("CAFE\u0301", "QA—Automation"), "café-qa-automation");
  assert.equal(createCanonicalOutputSegment("Компания 42", "QA"), "компания-42-qa");
  assert.throws(
    () => createCanonicalOutputSegment("---", "///"),
    (error) => error.code === "invalid_output_identity",
  );
});

test("reserve-output records ownership before creating the canonical directory", (t) => {
  const environment = tempEnvironment(t);
  const processId = createReadyProcess(environment, {
    companyObserved: "Café Labs",
    role: "Senior SDET",
  });
  let ledgerAlreadyOwned = false;

  const result = reserve(environment, processId, {
    mkdirDirectory: (directory) => {
      ledgerAlreadyOwned =
        readLogV3(environment.ledgerPath).processes[0].output_dir ===
        "output/café-labs-senior-sdet";
      mkdirSync(directory);
    },
  });
  const log = readLogV3(environment.ledgerPath);
  const processRecord = log.processes[0];

  assert.equal(ledgerAlreadyOwned, true);
  assert.equal(result.status, "reserved");
  assert.equal(result.output_dir, "output/café-labs-senior-sdet");
  assert.equal(processRecord.output_dir, result.output_dir);
  assert.equal(processRecord.updated_at, reservedAt);
  assert.equal(log.updated_at, reservedAt);
  assert.equal(processRecord.steps.get_vacancy.state, "running");
  assert.equal(existsSync(join(environment.outputRoot, "café-labs-senior-sdet")), true);
});

test("an existing same-process directory is byte-idempotent", (t) => {
  const environment = tempEnvironment(t);
  const processId = createReadyProcess(environment);
  reserve(environment, processId);
  const before = readFileSync(environment.ledgerPath, "utf8");

  const repeated = reserve(environment, processId, {
    clock: () => {
      throw new Error("idempotent reservation must not request a timestamp");
    },
    mkdirDirectory: () => {
      throw new Error("idempotent reservation must not call mkdir");
    },
  });

  assert.equal(repeated.status, "unchanged");
  assert.equal(repeated.output_dir, "output/example-labs-senior-sdet");
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

test("reservation selects the first suffix free across historical owners and every entry type", (t) => {
  const log = emptyV3Log();
  log.processes.push(historicalOwner("output/example-labs-senior-sdet"));
  const environment = tempEnvironment(t, log);
  writeFileSync(
    join(environment.outputRoot, "example-labs-senior-sdet-2"),
    "occupied file\n",
    "utf8",
  );
  mkdirSync(join(environment.outputRoot, "example-labs-senior-sdet-3"));
  writeFileSync(
    join(environment.outputRoot, "example-labs-senior-sdet-3", "kept.txt"),
    "non-empty directory\n",
    "utf8",
  );
  symlinkSync("missing-target", join(environment.outputRoot, "example-labs-senior-sdet-4"));
  const processId = createReadyProcess(environment, {
    processId: "proc_output_reservation_suffix",
    sourceRef: "https://example.test/jobs/sdet-new",
  });

  const result = reserve(environment, processId);

  assert.equal(result.output_dir, "output/example-labs-senior-sdet-5");
  assert.equal(existsSync(join(environment.outputRoot, "example-labs-senior-sdet-5")), true);
  assert.equal(
    readFileSync(join(environment.outputRoot, "example-labs-senior-sdet-3", "kept.txt"), "utf8"),
    "non-empty directory\n",
  );
});

test("filesystem case and Unicode equivalents occupy the canonical base", (t) => {
  const environment = tempEnvironment(t);
  mkdirSync(join(environment.outputRoot, "CAFE\u0301-LABS-SENIOR-SDET"));
  const processId = createReadyProcess(environment, {
    companyObserved: "Café Labs",
  });

  const result = reserve(environment, processId);

  assert.equal(result.output_dir, "output/café-labs-senior-sdet-2");
});

test("parallel reservations serialize suffix selection through the shared ledger lock", async (t) => {
  const environment = tempEnvironment(t);
  const firstProcessId = createReadyProcess(environment, {
    processId: "proc_output_parallel_001",
    sourceRef: "https://example.test/jobs/parallel-1",
  });
  const secondProcessId = createReadyProcess(environment, {
    identifiedAt: "2026-07-23T13:07:00.000Z",
    processId: "proc_output_parallel_002",
    sourceRef: "https://example.test/jobs/parallel-2",
    startedAt: "2026-07-23T13:06:00.000Z",
  });

  const results = await Promise.all([
    runReservationChild(environment, firstProcessId),
    runReservationChild(environment, secondProcessId),
  ]);
  assert.deepEqual(
    results.map((result) => result.code),
    [0, 0],
  );
  assert.deepEqual(results.map((result) => JSON.parse(result.stdout).output_dir).sort(), [
    "output/example-labs-senior-sdet",
    "output/example-labs-senior-sdet-2",
  ]);
  assert.deepEqual(
    readLogV3(environment.ledgerPath)
      .processes.map((record) => record.output_dir)
      .sort(),
    ["output/example-labs-senior-sdet", "output/example-labs-senior-sdet-2"],
  );
});

test("a missing already-reserved directory is recovered only for the same running process", (t) => {
  const environment = tempEnvironment(t);
  const processId = createReadyProcess(environment);
  const log = readLogV3(environment.ledgerPath);
  log.processes[0].output_dir = "output/example-labs-senior-sdet";
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  const before = readFileSync(environment.ledgerPath, "utf8");

  const result = reserve(environment, processId);

  assert.equal(result.status, "recovered");
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
  assert.equal(existsSync(join(environment.outputRoot, "example-labs-senior-sdet")), true);
});

test("same-process recovery rejects an equivalent unowned entry instead of adopting it", (t) => {
  const environment = tempEnvironment(t);
  const processId = createReadyProcess(environment, {
    companyObserved: "Café Labs",
  });
  const log = readLogV3(environment.ledgerPath);
  log.processes[0].output_dir = "output/café-labs-senior-sdet";
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  mkdirSync(join(environment.outputRoot, "CAFE\u0301-LABS-SENIOR-SDET"));
  const before = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => reserve(environment, processId),
    (error) => error.code === "output_path_conflict",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
  assert.deepEqual(readdirSync(environment.outputRoot), ["CAFE\u0301-LABS-SENIOR-SDET"]);
});

test("mkdir failure keeps ownership reserved and closes the active Step 1 attempt", (t) => {
  const environment = tempEnvironment(t);
  const processId = createReadyProcess(environment);
  const companiesBefore = structuredClone(readLogV3(environment.ledgerPath).companies);
  const setupError = new Error("synthetic permission failure");
  setupError.code = "EACCES";

  assert.throws(
    () =>
      reserve(environment, processId, {
        mkdirDirectory: () => {
          throw setupError;
        },
      }),
    (error) => error.code === "output_setup_failed",
  );
  const log = readLogV3(environment.ledgerPath);
  const processRecord = log.processes[0];
  const step = processRecord.steps.get_vacancy;

  assert.equal(processRecord.output_dir, "output/example-labs-senior-sdet");
  assert.equal(existsSync(join(environment.outputRoot, "example-labs-senior-sdet")), false);
  assert.equal(step.state, "failed");
  assert.equal(step.active_attempt, null);
  assert.equal(step.finished_at, reservedAt);
  assert.equal(step.error.code, "output_setup_failed");
  assert.equal(step.error.retryable, true);
  assert.deepEqual(step.error.details, ["filesystem error code: EACCES"]);
  assert.deepEqual(step.attempt_history, [
    {
      attempt: 1,
      outcome: "failed",
      started_at: startedAt,
      finished_at: reservedAt,
      input_snapshot: [],
      error_code: "output_setup_failed",
      publication_id: null,
    },
  ]);
  assert.deepEqual(log.companies, companiesBefore);
  assert.equal(
    readFileSync(environment.ledgerPath, "utf8").includes(environment.workspaceRoot),
    false,
  );
});

test("reserve-output rejects historical targets and incomplete identity without filesystem writes", (t) => {
  const historicalLog = emptyV3Log();
  historicalLog.processes.push(historicalOwner("output/example-labs-senior-sdet"));
  const historicalEnvironment = tempEnvironment(t, historicalLog);
  const historicalBytes = readFileSync(historicalEnvironment.ledgerPath, "utf8");

  assert.throws(
    () => reserve(historicalEnvironment, "proc_historical_output_owner"),
    (error) => error.code === "historical_process_read_only",
  );
  assert.equal(readFileSync(historicalEnvironment.ledgerPath, "utf8"), historicalBytes);

  const incompleteEnvironment = tempEnvironment(t);
  startFileBackedProcessV3(
    incompleteEnvironment.ledgerPath,
    {
      runner: "codex",
      sourceRef: "https://example.test/jobs/incomplete",
    },
    {
      attemptIdFactory: () => "attempt_incomplete_identity",
      clock: () => startedAt,
      processIdFactory: () => "proc_incomplete_identity",
    },
  );
  const incompleteBytes = readFileSync(incompleteEnvironment.ledgerPath, "utf8");
  assert.throws(
    () => reserve(incompleteEnvironment, "proc_incomplete_identity"),
    (error) => error.code === "output_identity_incomplete",
  );
  assert.equal(readFileSync(incompleteEnvironment.ledgerPath, "utf8"), incompleteBytes);
});

test("reservation requires explicit matching temporary workspace and output roots", (t) => {
  const environment = tempEnvironment(t);
  const processId = createReadyProcess(environment);
  const otherEnvironment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-wrong-output-root-",
  });
  const before = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () =>
      reserveFileBackedOutputV3(
        environment.ledgerPath,
        { processId },
        {
          outputRoot: otherEnvironment.outputRoot,
          workspaceRoot: environment.workspaceRoot,
        },
      ),
    (error) => error.code === "invalid_output_environment",
  );
  assert.throws(
    () => reserveFileBackedOutputV3(environment.ledgerPath, { processId }),
    (error) => error.code === "invalid_output_environment",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

test("missing output root returns bootstrap_required without ledger mutation and recovers", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    ledger: emptyV3Log(),
    prefix: "job-search-reservation-bootstrap-",
  });
  const processId = createReadyProcess(environment, {
    processId: "proc_output_bootstrap_required",
    sourceRef: "https://example.test/jobs/bootstrap-required",
  });
  const before = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => reserve(environment, processId),
    (error) => {
      assert.equal(error.code, "bootstrap_required");
      assert.equal(
        error.message,
        "bootstrap_required: output root is missing; run npm run bootstrap:init",
      );
      return true;
    },
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
  assert.equal(existsSync(environment.outputRoot), false);
  assert.equal(existsSync(`${environment.ledgerPath}.lock`), false);

  assert.equal(initializeOutputRoot(environment).status, "initialized");
  const reserved = reserve(environment, processId);
  assert.equal(reserved.status, "reserved");
  assert.equal(existsSync(join(environment.workspaceRoot, reserved.output_dir)), true);
});

test("bootstrap restores stale recorded reservation without changing ledger bytes", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    ledger: emptyV3Log(),
    prefix: "job-search-reservation-stale-bootstrap-",
  });
  const processId = createReadyProcess(environment, {
    processId: "proc_output_stale_bootstrap",
    sourceRef: "https://example.test/jobs/stale-bootstrap",
  });
  const log = readLogV3(environment.ledgerPath);
  log.processes[0].output_dir = "output/example-labs-senior-sdet";
  writeFileSync(environment.ledgerPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  const before = readFileSync(environment.ledgerPath, "utf8");

  assert.throws(
    () => reserve(environment, processId),
    (error) => error.code === "bootstrap_required",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
  initializeOutputRoot(environment);

  const recovered = reserve(environment, processId);
  assert.equal(recovered.status, "recovered");
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
  assert.equal(existsSync(join(environment.outputRoot, "example-labs-senior-sdet")), true);
});
