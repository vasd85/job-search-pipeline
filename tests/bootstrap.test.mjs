import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readLogV3 } from "../tools/lib/process-log-core.mjs";
import {
  startFileBackedProcessV3,
  updateFileBackedProcessV3,
} from "../tools/lib/process-log-v3-lifecycle.mjs";
import { createDisposableWorkspace } from "./fixtures/disposable-workspace.mjs";
import {
  GIT_REDIRECTION_VARIABLES,
  candidateSeedPlacement,
  checkOperationalFolder,
} from "../tools/bootstrap.mjs";
import { digestTree, zoneTableFor } from "../tools/ops-tree/manifest.mjs";
import { candidateRootFor } from "../tools/candidate/load.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bootstrapPath = join(repoRoot, "tools/bootstrap.mjs");
const processLogPath = join(repoRoot, "tools/process-log.mjs");

function emptyV3Log() {
  return {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: "2026-07-31T08:00:00.000Z",
    companies: [],
    processes: [],
  };
}

const EXPECTED_LEDGER_SCENARIOS = Object.freeze([
  "missing-ledger-check-read-only",
  "cli-missing-ledger-fails-loud",
  "missing-ledger-init-create",
  "exclusive-ledger-publication-barrier",
  "existing-ledger-byte-stable",
  "invalid-ledger-byte-stable",
  "wrong-ledger-path",
  "direct-ledger-symlink",
  "dangling-ledger-symlink",
  "ledger-directory",
  "hardlinked-ledger",
  "bootstrap-publication-residue",
  "publication-residue-disappears-after-lstat",
  "publication-residue-replacement-rejected",
  "publication-residue-invalid-transition-rejected",
  "publication-residue-access-change-rejected",
  "unwritable-ledger",
  "invalid-ledger-prevents-output",
  "invalid-output-prevents-ledger",
]);

function parseSuccess(result) {
  assert.equal(result.status ?? result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function assertCreated(report, outputRoot, processLog, processLogRecovered = false) {
  assert.deepEqual(report.created, {
    output_root: outputRoot,
    process_log: processLog,
  });
  assert.deepEqual(report.recovered, {
    process_log: processLogRecovered,
  });
  assert.equal(
    report.status,
    outputRoot || processLog || processLogRecovered ? "initialized" : "ready",
  );
}

function assertFreshEmptyV3Log(log) {
  assert.deepEqual(Object.keys(log), [
    "schema_version",
    "duplicate_policy",
    "updated_at",
    "companies",
    "processes",
  ]);
  assert.equal(log.schema_version, 4);
  assert.equal(log.duplicate_policy, "prompt");
  assert.match(log.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(log.updated_at).toISOString(), log.updated_at);
  assert.deepEqual(log.companies, []);
  assert.deepEqual(log.processes, []);
}

function assertFreshLedgerFile(path) {
  const stats = lstatSync(path);
  assert.equal(stats.isFile(), true);
  assert.equal(stats.isSymbolicLink(), false);
  assert.equal(stats.nlink, 1);
  assert.equal(stats.mode & 0o777, 0o600);
  assertFreshEmptyV3Log(JSON.parse(readFileSync(path, "utf8")));
}

function rawEnvironment(environment, overrides = {}) {
  return {
    ...process.env,
    JOB_PIPELINE_DISPOSABLE_ROOT_TOKEN: environment.markerToken,
    JOB_PIPELINE_OUTPUT_ROOT: environment.outputRoot,
    JOB_PIPELINE_PROCESS_LOG: environment.ledgerPath,
    JOB_PIPELINE_WORKSPACE_ROOT: environment.workspaceRoot,
    ...overrides,
  };
}

function runNode(scriptPath, args, environment, options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: rawEnvironment(environment, options.env),
  });
}

function runBootstrap(environment, ...args) {
  return runNode(bootstrapPath, args, environment);
}

function runBootstrapAsync(environment, ...args) {
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [bootstrapPath, ...args],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: rawEnvironment(environment),
      },
      (error, stdout, stderr) => {
        resolveRun({ code: error?.code ?? 0, stderr, stdout });
      },
    );
  });
}

function runBootstrapAsyncWithEnv(environment, env, ...args) {
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [bootstrapPath, ...args],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: rawEnvironment(environment, env),
      },
      (error, stdout, stderr) => {
        resolveRun({ code: error?.code ?? 0, stderr, stdout });
      },
    );
  });
}

function parseError(result) {
  assert.notEqual(result.status ?? result.code, 0, result.stdout);
  return JSON.parse(result.stderr).error;
}

function startReadyProcess(environment, processId) {
  startFileBackedProcessV3(
    environment.ledgerPath,
    {
      runner: "codex",
      sourceRef: `https://fresh.example.test/jobs/${processId}`,
    },
    {
      attemptIdFactory: () => `attempt_${processId}`,
      clock: () => "2026-07-31T08:01:00.000Z",
      processIdFactory: () => processId,
    },
  );
  updateFileBackedProcessV3(
    environment.ledgerPath,
    {
      processId,
      companyObserved: "Fresh Example",
      role: "Quality Engineer",
    },
    { clock: () => "2026-07-31T08:02:00.000Z" },
  );
}

test("bootstrap CLI grammar fails closed without filesystem writes", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    ledger: emptyV3Log(),
    prefix: "job-search-bootstrap-grammar-",
  });
  const beforeEntries = readdirSync(environment.workspaceRoot).sort();
  const beforeLedger = readFileSync(environment.ledgerPath, "utf8");

  for (const args of [[], ["--init", "--check"], ["--unknown"]]) {
    const error = parseError(runBootstrap(environment, ...args));
    assert.equal(error.code, "invalid_bootstrap_arguments");
  }

  assert.deepEqual(readdirSync(environment.workspaceRoot).sort(), beforeEntries);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeLedger);
  assert.equal(existsSync(environment.outputRoot), false);
});

test("README records explicit bootstrap creation and fail-loud CLI policy", () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  assert.match(
    readme,
    /`bootstrap:init` may only create the missing exact `output\/` root, an\s+absent exact `process-log\.json` containing an empty schema-v4 ledger, and — in a disposable root or\s+a rehearsal worktree only — an absent `candidate\/` copied from `candidate\.example\/`\./,
  );
  assert.match(
    readme,
    /It reports each\s+creation and never overwrites, repairs, or merges an existing ledger\./,
  );
  assert.match(
    readme,
    /Only `bootstrap:init` may finish an\s+exact validated interrupted bootstrap publication;/,
  );
  assert.match(readme, /the CLI read path never creates one implicitly\./);
});

test("check is read-only and init creates only missing exact roots idempotently", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    ledger: emptyV3Log(),
    prefix: "job-search-bootstrap-init-",
  });
  const beforeEntries = readdirSync(environment.workspaceRoot).sort();
  const beforeLedger = readFileSync(environment.ledgerPath, "utf8");

  const missing = parseError(runBootstrap(environment, "--check"));
  assert.deepEqual(missing, {
    code: "bootstrap_required",
    message: "output root is missing; run npm run bootstrap:init",
  });
  assert.deepEqual(readdirSync(environment.workspaceRoot).sort(), beforeEntries);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeLedger);

  const initialized = parseSuccess(runBootstrap(environment, "--init"));
  assertCreated(initialized, true, false);
  const outputStats = lstatSync(environment.outputRoot);
  assert.equal(outputStats.isDirectory(), true);
  assert.equal(outputStats.isSymbolicLink(), false);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeLedger);

  const readyEntries = readdirSync(environment.workspaceRoot).sort();
  const checked = parseSuccess(runBootstrap(environment, "--check"));
  assertCreated(checked, false, false);
  assert.deepEqual(readdirSync(environment.workspaceRoot).sort(), readyEntries);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeLedger);

  const repeated = parseSuccess(runBootstrap(environment, "--init"));
  assertCreated(repeated, false, false);
  assert.deepEqual(readdirSync(environment.workspaceRoot).sort(), readyEntries);
});

test("ledger bootstrap scenario inventory is exact and every case executes", async (t) => {
  const scenarios = [
    {
      id: "missing-ledger-check-read-only",
      run() {
        const environment = createDisposableWorkspace(t, {
          prefix: "job-search-bootstrap-ledger-check-",
        });
        assert.deepEqual(parseError(runBootstrap(environment, "--check")), {
          code: "bootstrap_required",
          message: "process log is missing; run npm run bootstrap:init",
        });
        assert.equal(existsSync(environment.ledgerPath), false);
      },
    },
    {
      id: "cli-missing-ledger-fails-loud",
      run() {
        const environment = createDisposableWorkspace(t, {
          prefix: "job-search-bootstrap-cli-missing-ledger-",
        });
        const beforeEntries = readdirSync(environment.workspaceRoot).sort();
        const result = runNode(
          processLogPath,
          [
            "start",
            "--source-ref",
            `https://missing-ledger.example.test/jobs/${randomUUID()}`,
            "--runner",
            "codex",
          ],
          environment,
        );
        const error = parseError(result);
        assert.deepEqual(error, {
          code: "process_log_read_failed",
          message: "Process log could not be read.",
          context: "operation=read_process_log",
          cause_code: "ENOENT",
          recovery_action: "run_bootstrap_init",
        });
        assert.equal(existsSync(environment.ledgerPath), false);
        assert.deepEqual(readdirSync(environment.workspaceRoot).sort(), beforeEntries);
      },
    },
    {
      id: "missing-ledger-init-create",
      run() {
        const environment = createDisposableWorkspace(t, {
          prefix: "job-search-bootstrap-ledger-create-",
        });
        const report = parseSuccess(runBootstrap(environment, "--init"));
        assertCreated(report, false, true);
        assert.equal(report.process_log, environment.ledgerPath);
        assertFreshLedgerFile(environment.ledgerPath);
        const before = readFileSync(environment.ledgerPath, "utf8");
        assertCreated(parseSuccess(runBootstrap(environment, "--init")), false, false);
        assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
      },
    },
    {
      id: "exclusive-ledger-publication-barrier",
      async run() {
        const environment = createDisposableWorkspace(t, {
          prefix: "job-search-bootstrap-ledger-exclusive-barrier-",
        });
        const barrierPath = join(environment.workspaceRoot, "publication-barrier");
        const preloadPath = join(environment.workspaceRoot, "barrier-after-ledger-temp-write.cjs");
        mkdirSync(barrierPath);
        writeFileSync(
          preloadPath,
          `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const originalWriteFileSync = fs.writeFileSync;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
fs.writeFileSync = function patchedWriteFileSync(path, ...args) {
  const result = originalWriteFileSync.call(fs, path, ...args);
  const ledgerPath = process.env.JOB_PIPELINE_PROCESS_LOG;
  if (
    typeof path === "string"
    && path.startsWith(\`\${ledgerPath}.\`)
    && path.endsWith(".tmp")
  ) {
    originalWriteFileSync.call(
      fs,
      require("node:path").join(
        process.env.R1_07G_PUBLICATION_BARRIER_PATH,
        \`ready-\${process.pid}\`,
      ),
      "ready\\n",
      { flag: "wx", mode: 0o600 },
    );
    const deadline = Date.now() + 5000;
    while (
      fs.readdirSync(process.env.R1_07G_PUBLICATION_BARRIER_PATH)
        .filter((name) => name.startsWith("ready-")).length < 2
    ) {
      if (Date.now() >= deadline) throw new Error("publication barrier timed out");
      Atomics.wait(waitBuffer, 0, 0, 5);
    }
  }
  return result;
};
syncBuiltinESMExports();
`,
          { encoding: "utf8", mode: 0o600 },
        );

        const results = await Promise.all(
          Array.from({ length: 2 }, () =>
            runBootstrapAsyncWithEnv(
              environment,
              {
                NODE_OPTIONS: `--require=${preloadPath}`,
                R1_07G_PUBLICATION_BARRIER_PATH: barrierPath,
              },
              "--init",
            ),
          ),
        );
        assert.deepEqual(
          results.map((result) => result.code),
          [0, 0],
        );
        const reports = results.map((result) => JSON.parse(result.stdout));
        assert.equal(reports.filter((report) => report.created.process_log).length, 1);
        for (const report of reports) {
          assertCreated(report, false, report.created.process_log, report.recovered.process_log);
        }
        assertFreshLedgerFile(environment.ledgerPath);
      },
    },
    {
      id: "existing-ledger-byte-stable",
      run() {
        const environment = createDisposableWorkspace(t, {
          ledger: emptyV3Log(),
          prefix: "job-search-bootstrap-ledger-existing-",
        });
        const before = readFileSync(environment.ledgerPath, "utf8");
        assertCreated(parseSuccess(runBootstrap(environment, "--init")), false, false);
        assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
      },
    },
    {
      id: "invalid-ledger-byte-stable",
      run() {
        for (const [suffix, ledger] of [
          ["json", "{\n"],
          ["schema", { ...emptyV3Log(), schema_version: 2 }],
          ["key", { ...emptyV3Log(), unexpected: true }],
        ]) {
          const environment = createDisposableWorkspace(t, {
            ledger,
            prefix: `job-search-bootstrap-ledger-invalid-${suffix}-`,
          });
          const before = readFileSync(environment.ledgerPath, "utf8");
          assert.deepEqual(parseError(runBootstrap(environment, "--init")), {
            code: "invalid_process_log_environment",
            message: "process log must be a valid schema-v4 ledger",
          });
          assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
        }
      },
    },
    {
      id: "wrong-ledger-path",
      run() {
        const environment = createDisposableWorkspace(t, {
          createOutput: false,
          prefix: "job-search-bootstrap-ledger-wrong-path-",
        });
        const wrongPath = join(environment.workspaceRoot, "nested", "process-log.json");
        const result = runNode(bootstrapPath, ["--init"], environment, {
          env: { JOB_PIPELINE_PROCESS_LOG: wrongPath },
        });
        assert.deepEqual(parseError(result), {
          code: "invalid_process_log_environment",
          message: "process log must be the exact workspaceRoot/process-log.json file",
        });
        assert.equal(existsSync(wrongPath), false);
        assert.equal(existsSync(environment.outputRoot), false);
      },
    },
    {
      id: "direct-ledger-symlink",
      run() {
        const environment = createDisposableWorkspace(t, {
          prefix: "job-search-bootstrap-ledger-symlink-",
        });
        const target = join(environment.workspaceRoot, "ledger-target.json");
        const targetBytes = `${JSON.stringify(emptyV3Log(), null, 2)}\n`;
        writeFileSync(target, targetBytes, { encoding: "utf8", mode: 0o600 });
        symlinkSync("ledger-target.json", environment.ledgerPath);
        assert.deepEqual(parseError(runBootstrap(environment, "--init")), {
          code: "invalid_process_log_environment",
          message: "process log must be a single-link regular file",
        });
        assert.equal(readFileSync(target, "utf8"), targetBytes);
        assert.equal(lstatSync(environment.ledgerPath).isSymbolicLink(), true);
      },
    },
    {
      id: "dangling-ledger-symlink",
      run() {
        const environment = createDisposableWorkspace(t, {
          prefix: "job-search-bootstrap-ledger-dangling-",
        });
        symlinkSync("missing-ledger.json", environment.ledgerPath);
        assert.deepEqual(parseError(runBootstrap(environment, "--init")), {
          code: "invalid_process_log_environment",
          message: "process log must be a single-link regular file",
        });
        assert.equal(lstatSync(environment.ledgerPath).isSymbolicLink(), true);
      },
    },
    {
      id: "ledger-directory",
      run() {
        const environment = createDisposableWorkspace(t, {
          prefix: "job-search-bootstrap-ledger-directory-",
        });
        mkdirSync(environment.ledgerPath);
        assert.deepEqual(parseError(runBootstrap(environment, "--init")), {
          code: "invalid_process_log_environment",
          message: "process log must be a single-link regular file",
        });
        assert.equal(lstatSync(environment.ledgerPath).isDirectory(), true);
      },
    },
    {
      id: "hardlinked-ledger",
      run() {
        const environment = createDisposableWorkspace(t, {
          prefix: "job-search-bootstrap-ledger-hardlink-",
        });
        const target = join(environment.workspaceRoot, "ledger-target.json");
        writeFileSync(target, `${JSON.stringify(emptyV3Log(), null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        linkSync(target, environment.ledgerPath);
        const before = readFileSync(target, "utf8");
        assert.deepEqual(parseError(runBootstrap(environment, "--init")), {
          code: "invalid_process_log_environment",
          message: "process log must be a single-link regular file",
        });
        assert.equal(readFileSync(target, "utf8"), before);
        assert.equal(lstatSync(target).nlink, 2);
      },
    },
    {
      id: "bootstrap-publication-residue",
      run() {
        const environment = createDisposableWorkspace(t, {
          ledger: emptyV3Log(),
          prefix: "job-search-bootstrap-ledger-residue-",
        });
        const residuePath = `${environment.ledgerPath}.4242.${randomUUID()}.tmp`;
        const before = readFileSync(environment.ledgerPath, "utf8");
        linkSync(environment.ledgerPath, residuePath);

        assert.deepEqual(parseError(runBootstrap(environment, "--check")), {
          code: "invalid_process_log_environment",
          message: "process log must be a single-link regular file",
        });
        assert.equal(existsSync(residuePath), true);
        assert.equal(lstatSync(environment.ledgerPath).nlink, 2);

        const recovered = parseSuccess(runBootstrap(environment, "--init"));
        assert.equal(recovered.status, "initialized");
        assert.deepEqual(recovered.created, {
          output_root: false,
          process_log: false,
        });
        assert.deepEqual(recovered.recovered, { process_log: true });
        assert.equal(existsSync(residuePath), false);
        assert.equal(lstatSync(environment.ledgerPath).nlink, 1);
        assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);

        const invalid = createDisposableWorkspace(t, {
          ledger: "{\n",
          prefix: "job-search-bootstrap-ledger-invalid-residue-",
        });
        const invalidResidue = `${invalid.ledgerPath}.4243.${randomUUID()}.tmp`;
        linkSync(invalid.ledgerPath, invalidResidue);
        assert.deepEqual(parseError(runBootstrap(invalid, "--init")), {
          code: "invalid_process_log_environment",
          message: "process log must be a valid schema-v4 ledger",
        });
        assert.equal(existsSync(invalidResidue), true);
        assert.equal(lstatSync(invalid.ledgerPath).nlink, 2);
        assert.equal(readFileSync(invalid.ledgerPath, "utf8"), "{\n");

        const unwritable = createDisposableWorkspace(t, {
          createOutput: false,
          ledger: emptyV3Log(),
          prefix: "job-search-bootstrap-ledger-unwritable-residue-",
        });
        const unwritableResidue = `${unwritable.ledgerPath}.4244.${randomUUID()}.tmp`;
        const unwritableBytes = readFileSync(unwritable.ledgerPath, "utf8");
        linkSync(unwritable.ledgerPath, unwritableResidue);
        chmodSync(unwritable.ledgerPath, 0o400);
        try {
          assert.deepEqual(parseError(runBootstrap(unwritable, "--init")), {
            code: "invalid_process_log_environment",
            message: "process log must be readable and writable",
          });
          assert.equal(existsSync(unwritable.outputRoot), false);
          assert.equal(existsSync(unwritableResidue), true);
          assert.equal(lstatSync(unwritable.ledgerPath).nlink, 2);
          assert.equal(readFileSync(unwritable.ledgerPath, "utf8"), unwritableBytes);
        } finally {
          chmodSync(unwritable.ledgerPath, 0o600);
        }
      },
    },
    {
      id: "publication-residue-disappears-after-lstat",
      run() {
        const environment = createDisposableWorkspace(t, {
          ledger: emptyV3Log(),
          prefix: "job-search-bootstrap-ledger-residue-transition-",
        });
        const residuePath = `${environment.ledgerPath}.4245.${randomUUID()}.tmp`;
        const preloadPath = join(
          environment.workspaceRoot,
          "unlink-bootstrap-residue-after-lstat.cjs",
        );
        const before = readFileSync(environment.ledgerPath, "utf8");
        linkSync(environment.ledgerPath, residuePath);
        writeFileSync(
          preloadPath,
          `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const originalLstatSync = fs.lstatSync;
let armed = true;
fs.lstatSync = function patchedLstatSync(path, ...args) {
  const stats = originalLstatSync.call(fs, path, ...args);
  if (
    armed
    && path === process.env.JOB_PIPELINE_PROCESS_LOG
    && stats.nlink === 2
  ) {
    armed = false;
    fs.unlinkSync(process.env.R1_07G_BOOTSTRAP_RESIDUE_PATH);
  }
  return stats;
};
syncBuiltinESMExports();
`,
          { encoding: "utf8", mode: 0o600 },
        );

        const report = parseSuccess(
          runNode(bootstrapPath, ["--init"], environment, {
            env: {
              NODE_OPTIONS: `--require=${preloadPath}`,
              R1_07G_BOOTSTRAP_RESIDUE_PATH: residuePath,
            },
          }),
        );
        assertCreated(report, false, false);
        assert.equal(existsSync(residuePath), false);
        assert.equal(lstatSync(environment.ledgerPath).nlink, 1);
        assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
      },
    },
    {
      id: "publication-residue-replacement-rejected",
      run() {
        const environment = createDisposableWorkspace(t, {
          createOutput: false,
          ledger: emptyV3Log(),
          prefix: "job-search-bootstrap-ledger-residue-replacement-",
        });
        const residuePath = `${environment.ledgerPath}.4246.${randomUUID()}.tmp`;
        const heldPath = join(environment.workspaceRoot, "held-original-ledger.json");
        const preloadPath = join(environment.workspaceRoot, "replace-ledger-after-lstat.cjs");
        const before = readFileSync(environment.ledgerPath, "utf8");
        linkSync(environment.ledgerPath, residuePath);
        writeFileSync(
          preloadPath,
          `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const originalLstatSync = fs.lstatSync;
let armed = true;
fs.lstatSync = function patchedLstatSync(path, ...args) {
  const stats = originalLstatSync.call(fs, path, ...args);
  if (
    armed
    && path === process.env.JOB_PIPELINE_PROCESS_LOG
    && stats.nlink === 2
  ) {
    armed = false;
    const bytes = fs.readFileSync(path);
    fs.linkSync(path, process.env.R1_07G_HELD_LEDGER_PATH);
    fs.unlinkSync(process.env.R1_07G_BOOTSTRAP_RESIDUE_PATH);
    fs.unlinkSync(path);
    fs.writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  }
  return stats;
};
syncBuiltinESMExports();
`,
          { encoding: "utf8", mode: 0o600 },
        );

        assert.deepEqual(
          parseError(
            runNode(bootstrapPath, ["--init"], environment, {
              env: {
                NODE_OPTIONS: `--require=${preloadPath}`,
                R1_07G_BOOTSTRAP_RESIDUE_PATH: residuePath,
                R1_07G_HELD_LEDGER_PATH: heldPath,
              },
            }),
          ),
          {
            code: "invalid_process_log_environment",
            message: "process log must be a single-link regular file",
          },
        );
        assert.equal(existsSync(environment.outputRoot), false);
        assert.equal(existsSync(residuePath), false);
        assert.equal(lstatSync(environment.ledgerPath).nlink, 1);
        assert.equal(lstatSync(heldPath).nlink, 1);
        assert.notEqual(lstatSync(environment.ledgerPath).ino, lstatSync(heldPath).ino);
        assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
        assert.equal(readFileSync(heldPath, "utf8"), before);
      },
    },
    {
      id: "publication-residue-invalid-transition-rejected",
      run() {
        const environment = createDisposableWorkspace(t, {
          createOutput: false,
          ledger: emptyV3Log(),
          prefix: "job-search-bootstrap-ledger-residue-invalid-transition-",
        });
        const residuePath = `${environment.ledgerPath}.4247.${randomUUID()}.tmp`;
        const preloadPath = join(environment.workspaceRoot, "invalidate-ledger-after-lstat.cjs");
        linkSync(environment.ledgerPath, residuePath);
        writeFileSync(
          preloadPath,
          `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const originalLstatSync = fs.lstatSync;
let armed = true;
fs.lstatSync = function patchedLstatSync(path, ...args) {
  const stats = originalLstatSync.call(fs, path, ...args);
  if (
    armed
    && path === process.env.JOB_PIPELINE_PROCESS_LOG
    && stats.nlink === 2
  ) {
    armed = false;
    fs.unlinkSync(process.env.R1_07G_BOOTSTRAP_RESIDUE_PATH);
    fs.writeFileSync(path, "{\\n", { encoding: "utf8", flag: "w" });
  }
  return stats;
};
syncBuiltinESMExports();
`,
          { encoding: "utf8", mode: 0o600 },
        );

        assert.deepEqual(
          parseError(
            runNode(bootstrapPath, ["--init"], environment, {
              env: {
                NODE_OPTIONS: `--require=${preloadPath}`,
                R1_07G_BOOTSTRAP_RESIDUE_PATH: residuePath,
              },
            }),
          ),
          {
            code: "invalid_process_log_environment",
            message: "process log must be a valid schema-v4 ledger",
          },
        );
        assert.equal(existsSync(environment.outputRoot), false);
        assert.equal(existsSync(residuePath), false);
        assert.equal(lstatSync(environment.ledgerPath).nlink, 1);
        assert.equal(readFileSync(environment.ledgerPath, "utf8"), "{\n");
      },
    },
    {
      id: "publication-residue-access-change-rejected",
      run() {
        const environment = createDisposableWorkspace(t, {
          createOutput: false,
          ledger: emptyV3Log(),
          prefix: "job-search-bootstrap-ledger-residue-access-transition-",
        });
        const residuePath = `${environment.ledgerPath}.4248.${randomUUID()}.tmp`;
        const preloadPath = join(environment.workspaceRoot, "restrict-ledger-during-readdir.cjs");
        const before = readFileSync(environment.ledgerPath, "utf8");
        linkSync(environment.ledgerPath, residuePath);
        writeFileSync(
          preloadPath,
          `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const originalReaddirSync = fs.readdirSync;
let armed = true;
fs.readdirSync = function patchedReaddirSync(path, ...args) {
  const entries = originalReaddirSync.call(fs, path, ...args);
  if (
    armed
    && path === process.env.JOB_PIPELINE_WORKSPACE_ROOT
  ) {
    armed = false;
    fs.unlinkSync(process.env.R1_07G_BOOTSTRAP_RESIDUE_PATH);
    fs.chmodSync(process.env.JOB_PIPELINE_PROCESS_LOG, 0o400);
  }
  return entries;
};
syncBuiltinESMExports();
`,
          { encoding: "utf8", mode: 0o600 },
        );

        try {
          assert.deepEqual(
            parseError(
              runNode(bootstrapPath, ["--init"], environment, {
                env: {
                  NODE_OPTIONS: `--require=${preloadPath}`,
                  R1_07G_BOOTSTRAP_RESIDUE_PATH: residuePath,
                },
              }),
            ),
            {
              code: "invalid_process_log_environment",
              message: "process log must be readable and writable",
            },
          );
          assert.equal(existsSync(environment.outputRoot), false);
          assert.equal(existsSync(residuePath), false);
          assert.equal(lstatSync(environment.ledgerPath).nlink, 1);
          assert.equal(lstatSync(environment.ledgerPath).mode & 0o777, 0o400);
          assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
        } finally {
          chmodSync(environment.ledgerPath, 0o600);
        }
      },
    },
    {
      id: "unwritable-ledger",
      run() {
        const environment = createDisposableWorkspace(t, {
          ledger: emptyV3Log(),
          prefix: "job-search-bootstrap-ledger-mode-",
        });
        const before = readFileSync(environment.ledgerPath, "utf8");
        chmodSync(environment.ledgerPath, 0o400);
        try {
          assert.deepEqual(parseError(runBootstrap(environment, "--init")), {
            code: "invalid_process_log_environment",
            message: "process log must be readable and writable",
          });
          assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
        } finally {
          chmodSync(environment.ledgerPath, 0o600);
        }
      },
    },
    {
      id: "invalid-ledger-prevents-output",
      run() {
        const environment = createDisposableWorkspace(t, {
          createOutput: false,
          ledger: "{\n",
          prefix: "job-search-bootstrap-ledger-before-output-",
        });
        assert.equal(
          parseError(runBootstrap(environment, "--init")).code,
          "invalid_process_log_environment",
        );
        assert.equal(existsSync(environment.outputRoot), false);
        assert.equal(readFileSync(environment.ledgerPath, "utf8"), "{\n");
      },
    },
    {
      id: "invalid-output-prevents-ledger",
      run() {
        const environment = createDisposableWorkspace(t, {
          createOutput: false,
          prefix: "job-search-bootstrap-output-before-ledger-",
        });
        writeFileSync(environment.outputRoot, "not a directory\n", "utf8");
        assert.equal(
          parseError(runBootstrap(environment, "--init")).code,
          "invalid_output_environment",
        );
        assert.equal(existsSync(environment.ledgerPath), false);
        assert.equal(readFileSync(environment.outputRoot, "utf8"), "not a directory\n");
      },
    },
  ];
  const declared = scenarios.map((scenario) => scenario.id);
  assert.deepEqual(
    EXPECTED_LEDGER_SCENARIOS.filter((id) => !declared.includes(id)),
    [],
    "every expected ledger scenario must be declared",
  );
  assert.deepEqual(
    declared.filter((id) => !EXPECTED_LEDGER_SCENARIOS.includes(id)),
    [],
    "every declared ledger scenario must be expected",
  );

  const executed = [];
  for (const scenario of scenarios) {
    await t.test(scenario.id, () => {
      executed.push(scenario.id);
      return scenario.run();
    });
  }
  assert.deepEqual(executed, [...EXPECTED_LEDGER_SCENARIOS]);
});

test("bootstrap deterministically rejects wrong file, symlink, root, realpath, and permissions", async (t) => {
  await t.test("regular file", () => {
    const environment = createDisposableWorkspace(t, {
      createOutput: false,
      ledger: emptyV3Log(),
      prefix: "job-search-bootstrap-file-",
    });
    writeFileSync(environment.outputRoot, "not a directory\n", "utf8");
    assert.equal(
      parseError(runBootstrap(environment, "--init")).code,
      "invalid_output_environment",
    );
  });

  await t.test("direct symlink", () => {
    const environment = createDisposableWorkspace(t, {
      createOutput: false,
      ledger: emptyV3Log(),
      prefix: "job-search-bootstrap-symlink-",
    });
    mkdirSync(join(environment.workspaceRoot, "real-output"));
    symlinkSync("real-output", environment.outputRoot);
    assert.equal(
      parseError(runBootstrap(environment, "--check")).code,
      "invalid_output_environment",
    );
  });

  await t.test("dangling symlink", () => {
    const environment = createDisposableWorkspace(t, {
      createOutput: false,
      ledger: emptyV3Log(),
      prefix: "job-search-bootstrap-dangling-",
    });
    symlinkSync("missing-output", environment.outputRoot);
    assert.equal(
      parseError(runBootstrap(environment, "--init")).code,
      "invalid_output_environment",
    );
  });

  await t.test("wrong lexical output root", () => {
    const environment = createDisposableWorkspace(t, {
      createOutput: false,
      ledger: emptyV3Log(),
      prefix: "job-search-bootstrap-wrong-root-",
    });
    const wrongRoot = join(environment.workspaceRoot, "artifacts");
    mkdirSync(wrongRoot);
    const result = runBootstrap(environment, "--check");
    const error = parseError({
      ...result,
      stderr: result.stderr,
    });
    assert.equal(error.code, "bootstrap_required");
    const explicitWrong = runNode(bootstrapPath, ["--check"], environment, {
      env: { JOB_PIPELINE_OUTPUT_ROOT: wrongRoot },
    });
    assert.equal(parseError(explicitWrong).code, "invalid_output_environment");
    assert.equal(existsSync(environment.outputRoot), false);
  });

  await t.test("symlinked workspace ancestor", () => {
    const environment = createDisposableWorkspace(t, {
      ledger: emptyV3Log(),
      prefix: "job-search-bootstrap-realpath-",
    });
    const holder = mkdtempSync(join(tmpdir(), "job-search-bootstrap-alias-"));
    t.after(() => rmSync(holder, { force: true, recursive: true }));
    const aliasParent = join(holder, "workspace-parent-alias");
    symlinkSync(dirname(environment.workspaceRoot), aliasParent);
    const aliasRoot = join(aliasParent, basename(environment.workspaceRoot));
    assert.equal(lstatSync(aliasRoot).isSymbolicLink(), false);
    const result = runNode(bootstrapPath, ["--check"], environment, {
      env: {
        JOB_PIPELINE_OUTPUT_ROOT: join(aliasRoot, "output"),
        JOB_PIPELINE_WORKSPACE_ROOT: aliasRoot,
      },
    });
    assert.deepEqual(parseError(result), {
      code: "invalid_output_environment",
      message: "workspaceRoot must not use a symlinked path or ancestor",
    });
  });

  await t.test("unwritable output root", () => {
    const environment = createDisposableWorkspace(t, {
      ledger: emptyV3Log(),
      prefix: "job-search-bootstrap-mode-",
    });
    chmodSync(environment.outputRoot, 0o555);
    try {
      assert.equal(
        parseError(runBootstrap(environment, "--check")).code,
        "invalid_output_environment",
      );
    } finally {
      chmodSync(environment.outputRoot, 0o700);
    }
  });
});

test("concurrent init publishes each missing root once with deterministic followers", async (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-bootstrap-concurrent-",
  });
  const results = await Promise.all(
    Array.from({ length: 16 }, () => runBootstrapAsync(environment, "--init")),
  );
  assert.deepEqual(
    results.map((result) => result.code),
    Array(16).fill(0),
  );
  const reports = results.map((result) => JSON.parse(result.stdout));
  assert.equal(reports.filter((report) => report.created.output_root).length, 1);
  assert.equal(reports.filter((report) => report.created.process_log).length, 1);
  for (const report of reports) {
    assert.equal(typeof report.recovered.process_log, "boolean");
    assertCreated(
      report,
      report.created.output_root,
      report.created.process_log,
      report.recovered.process_log,
    );
  }
  assert.equal(lstatSync(environment.outputRoot).isDirectory(), true);
  assertFreshLedgerFile(environment.ledgerPath);
});

test("init and reservation race has a stable retry path", async (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    ledger: emptyV3Log(),
    prefix: "job-search-bootstrap-reserve-race-",
  });
  const processId = "proc_bootstrap_reserve_race";
  startReadyProcess(environment, processId);

  const reservePromise = new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [processLogPath, "reserve-output", "--id", processId],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: rawEnvironment(environment),
      },
      (error, stdout, stderr) => {
        resolveRun({ code: error?.code ?? 0, stderr, stdout });
      },
    );
  });
  const [initialized, racedReserve] = await Promise.all([
    runBootstrapAsync(environment, "--init"),
    reservePromise,
  ]);
  assert.equal(initialized.code, 0, initialized.stderr);
  if (racedReserve.code === 0) {
    assert.equal(JSON.parse(racedReserve.stdout).status, "reserved");
  } else {
    assert.equal(JSON.parse(racedReserve.stderr).error.code, "bootstrap_required");
  }

  const retried = runNode(processLogPath, ["reserve-output", "--id", processId], environment);
  assert.equal(retried.status, 0, retried.stderr);
  assert.match(JSON.parse(retried.stdout).status, /^(reserved|unchanged)$/);
  const record = readLogV3(environment.ledgerPath).processes[0];
  assert.equal(record.output_dir, "output/fresh-example-quality-engineer");
  assert.equal(existsSync(join(environment.workspaceRoot, record.output_dir)), true);
});

test("fresh git archive initializes and reserves without install, then preflight reports missing dependencies", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-bootstrap-archive-",
  });
  const archivePath = join(tmpdir(), `job-search-bootstrap-${randomUUID()}.tar`);
  t.after(() => rmSync(archivePath, { force: true }));
  execFileSync("git", ["archive", "--format=tar", "-o", archivePath, "HEAD"], {
    cwd: repoRoot,
  });
  execFileSync("tar", ["-xf", archivePath, "-C", environment.workspaceRoot]);
  assert.equal(existsSync(environment.outputRoot), false);
  assert.equal(existsSync(join(environment.workspaceRoot, "node_modules")), false);
  assert.equal(existsSync(join(environment.workspaceRoot, "package-lock.json")), true);
  assert.equal(
    existsSync(join(environment.workspaceRoot, "tools/cv-builder/package-lock.json")),
    true,
  );

  const archivedCli = join(environment.workspaceRoot, "tools/process-log.mjs");
  const sourceRef = `https://fresh-archive.example.test/jobs/${randomUUID()}`;
  const beforeInit = runNode(
    archivedCli,
    ["start", "--source-ref", sourceRef, "--runner", "codex"],
    environment,
    { cwd: environment.workspaceRoot },
  );
  const beforeInitError = parseError(beforeInit);
  assert.deepEqual(beforeInitError, {
    code: "process_log_read_failed",
    message: "Process log could not be read.",
    context: "operation=read_process_log",
    cause_code: "ENOENT",
    recovery_action: "run_bootstrap_init",
  });
  assert.equal(existsSync(environment.ledgerPath), false);

  const init = spawnSync("npm", ["run", "bootstrap:init", "--silent"], {
    cwd: environment.workspaceRoot,
    encoding: "utf8",
    env: rawEnvironment(environment),
  });
  const initReport = parseSuccess(init);
  assertCreated(initReport, true, true);
  assert.equal(initReport.process_log, environment.ledgerPath);
  assertFreshLedgerFile(environment.ledgerPath);

  const started = runNode(
    archivedCli,
    ["start", "--source-ref", sourceRef, "--runner", "codex"],
    environment,
    { cwd: environment.workspaceRoot },
  );
  assert.equal(started.status, 0, started.stderr);
  const processId = JSON.parse(started.stdout).process.id;
  const updated = runNode(
    archivedCli,
    [
      "update",
      "--id",
      processId,
      "--company-observed",
      "Archive Example",
      "--role",
      "Quality Engineer",
    ],
    environment,
    { cwd: environment.workspaceRoot },
  );
  assert.equal(updated.status, 0, updated.stderr);
  const reserved = runNode(archivedCli, ["reserve-output", "--id", processId], environment, {
    cwd: environment.workspaceRoot,
  });
  assert.equal(reserved.status, 0, reserved.stderr);
  assert.equal(JSON.parse(reserved.stdout).output_dir, "output/archive-example-quality-engineer");
  assert.equal(existsSync(join(environment.workspaceRoot, "node_modules")), false);

  const preflight = spawnSync("npm", ["run", "preflight", "--silent"], {
    cwd: environment.workspaceRoot,
    encoding: "utf8",
    env: rawEnvironment(environment),
  });
  assert.notEqual(preflight.status, 0, preflight.stdout);
  assert.deepEqual(JSON.parse(preflight.stderr).error, {
    code: "toolchain_dependencies_missing",
    message: "locked dependency is missing: node_modules/@types/node",
  });
  assert.equal(existsSync(join(environment.workspaceRoot, "tools/cv-builder/node_modules")), false);
});

// The candidate layer: the private directory one person's profile and configured values live in.
//
// `--init` may create it from the tracked example only where a fictional candidate belongs — a
// disposable root and a rehearsal worktree. The operational checkout is the one place that must
// never receive it: a fictional profile that arrived there by accident would end up under a real
// cover letter. Every other refusal direction is named too, because the dangerous default is the
// silent one: an unresolvable topology is never read as "then it is not the operational checkout".

function gitIn(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return String(result.stdout ?? "");
}

function seedRepository(root) {
  mkdirSync(root, { recursive: true });
  gitIn(root, "init", "--quiet", ".");
  gitIn(root, "config", "user.email", "candidate@example.invalid");
  gitIn(root, "config", "user.name", "candidate");
  writeFileSync(join(root, "seed.txt"), "seed\n", "utf8");
  gitIn(root, "add", "seed.txt");
  gitIn(root, "commit", "--quiet", "-m", "seed");
}

function stagingResidue(workspaceRoot) {
  return readdirSync(workspaceRoot).filter((name) => name.startsWith(".candidate-seed-"));
}

test("init seeds the candidate layer from the example in a disposable root", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-bootstrap-candidate-seed-",
  });
  const root = candidateRootFor(environment.workspaceRoot);

  const initialized = parseSuccess(runBootstrap(environment, "--init"));
  // The candidate report is its own key: the frozen shape of created/recovered/status is what
  // every other case in this file asserts, and it must not move.
  assertCreated(initialized, true, true);
  assert.deepEqual(initialized.candidate, { created: true, path: root, status: "ready" });
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, "config.json"), "utf8")),
    JSON.parse(readFileSync(join(repoRoot, "candidate.example/config.json"), "utf8")),
  );
  assert.deepEqual(stagingResidue(environment.workspaceRoot), []);

  const repeated = parseSuccess(runBootstrap(environment, "--init"));
  assert.deepEqual(repeated.candidate, { created: false, path: root, status: "ready" });

  const checked = parseSuccess(runBootstrap(environment, "--check"));
  assert.deepEqual(checked.candidate, { created: false, path: root, status: "ready" });
});

test("check reports an absent candidate and refuses a broken one", (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-bootstrap-candidate-check-",
  });
  const root = candidateRootFor(environment.workspaceRoot);
  const absent = parseSuccess(runBootstrap(environment, "--check"));
  assert.deepEqual(absent.candidate, { created: false, path: root, status: "absent" });

  mkdirSync(root);
  writeFileSync(join(root, "config.json"), '{"schema_version": 99}\n', "utf8");
  assert.equal(
    parseError(runBootstrap(environment, "--check")).code,
    "candidate_schema_version_unsupported",
  );
  // init still has an output root and a ledger to create, so it reports the same layer instead of
  // failing the documented setup command.
  const initialized = parseSuccess(runBootstrap(environment, "--init"));
  assert.deepEqual(initialized.candidate, {
    created: false,
    error: "candidate_schema_version_unsupported",
    path: root,
    status: "invalid",
  });
});

test("a broken constraints file is refused the same way a broken config is", (t) => {
  // Both halves of the layer are read, because a `constraints.json` the run would refuse later is
  // exactly what a check must not report as checked. The report keeps its shape: the two readers
  // fail the same way, so `--check` is loud and `--init` turns the refusal into a coded field.
  const environment = createDisposableWorkspace(t, {
    ledger: emptyV3Log(),
    prefix: "job-search-bootstrap-candidate-constraints-",
  });
  const root = candidateRootFor(environment.workspaceRoot);
  mkdirSync(root);
  for (const document of ["config.json", "profile.md", "levers.md", "rules.md"]) {
    copyFileSync(join(repoRoot, "candidate.example", document), join(root, document));
  }
  cpSync(join(repoRoot, "candidate.example", "languages"), join(root, "languages"), {
    recursive: true,
  });
  // A layer with no constraints file at all is a layer, not a fault: one written before the file
  // existed constrains nothing.
  assert.deepEqual(parseSuccess(runBootstrap(environment, "--check")).candidate, {
    created: false,
    path: root,
    status: "ready",
  });

  writeFileSync(join(root, "constraints.json"), "{ not json\n", "utf8");
  assert.equal(
    parseError(runBootstrap(environment, "--check")).code,
    "candidate_constraints_invalid_json",
  );
  const initialized = parseSuccess(runBootstrap(environment, "--init"));
  assert.deepEqual(initialized.candidate, {
    created: false,
    error: "candidate_constraints_invalid_json",
    path: root,
    status: "invalid",
  });
});

test("init refuses to seed a candidate into a primary worktree", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-bootstrap-candidate-primary-",
  });
  seedRepository(environment.workspaceRoot);
  const root = candidateRootFor(environment.workspaceRoot);

  const initialized = parseSuccess(runBootstrap(environment, "--init"));
  assert.deepEqual(initialized.candidate, {
    created: false,
    path: root,
    refused: "candidate_seed_refused_in_operational_checkout",
    status: "absent",
  });
  assert.equal(existsSync(root), false);
  assert.deepEqual(stagingResidue(environment.workspaceRoot), []);
  // The refusal is loud in the report and never in the exit code: the rest of init still ran.
  assertCreated(initialized, true, true);
});

/** The marker `tools/ops-tree/` leaves: a manifest digesting whatever the folder holds now. */
function markOperationalFolder(root) {
  const zones = zoneTableFor("operational");
  const pin = (tag) => ({
    commit: "a".repeat(40),
    repository: "/fixture/repository",
    tag,
    tree: "b".repeat(40),
  });
  writeFileSync(
    join(root, "ops-manifest.json"),
    `${JSON.stringify(
      {
        schema: "job-search-pipeline/ops-manifest",
        schema_version: 1,
        kind: "operational",
        state: "ready",
        built_at: "2026-09-24T12:00:00.000Z",
        previous: null,
        engine: pin("release-20260924"),
        candidate: pin("candidate-20260924"),
        zones,
        files: digestTree(root, zones),
      },
      null,
      2,
    )}\n`,
  );
}

test("init never seeds the example into an operational folder, whichever half of its marker is left", (t) => {
  for (const mark of [markOperationalFolder, (root) => mkdirSync(join(root, ".ops-tree"))]) {
    const environment = createDisposableWorkspace(t, {
      createOutput: false,
      prefix: "job-search-bootstrap-candidate-folder-",
    });
    mark(environment.workspaceRoot);
    const root = candidateRootFor(environment.workspaceRoot);
    const initialized = parseSuccess(runBootstrap(environment, "--init"));
    assert.deepEqual(initialized.candidate, {
      created: false,
      path: root,
      refused: "candidate_seed_refused_in_operational_folder",
      status: "absent",
    });
    assert.equal(existsSync(root), false);
    assert.deepEqual(stagingResidue(environment.workspaceRoot), []);
  }
});

test("the preflight's folder check reports a clean folder and refuses drift with the folder's code", (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "job-search-bootstrap-folder-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  assert.equal(checkOperationalFolder(root), null, "a tree without the marker reports nothing");
  mkdirSync(join(root, "tools"));
  writeFileSync(join(root, "tools/entry.mjs"), "export {};\n");
  markOperationalFolder(root);
  assert.deepEqual(checkOperationalFolder(root), {
    built_at: "2026-09-24T12:00:00.000Z",
    candidate: "candidate-20260924",
    kind: "operational",
    release: "release-20260924",
  });
  writeFileSync(join(root, "tools/entry.mjs"), "export const changed = true;\n");
  assert.throws(
    () => checkOperationalFolder(root),
    (error) => {
      assert.equal(error.name, "BootstrapCliError");
      assert.equal(error.code, "engine_tree_drift");
      return true;
    },
  );
});

test("seed placement names every refusal direction and never guesses", (t) => {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "job-search-bootstrap-placement-"));
  t.after(() => rmSync(base, { force: true, recursive: true }));

  // Outside every repository: a disposable root, where the example belongs.
  const loose = join(base, "loose");
  mkdirSync(loose);
  assert.deepEqual(candidateSeedPlacement(loose), { allowed: true });

  const primary = join(base, "pipeline");
  seedRepository(primary);
  assert.deepEqual(candidateSeedPlacement(primary), {
    allowed: false,
    code: "candidate_seed_refused_in_operational_checkout",
  });

  const development = join(base, "pipeline-worktrees", "tasks", "probe");
  gitIn(primary, "worktree", "add", "--quiet", "-b", "task/probe", development, "HEAD");
  assert.deepEqual(candidateSeedPlacement(development), {
    allowed: false,
    code: "candidate_seed_refused_in_development_worktree",
  });

  const rehearsal = join(base, "pipeline-worktrees", "rehearsal", "rollout");
  gitIn(primary, "worktree", "add", "--quiet", "-b", "rehearsal/rollout", rehearsal, "HEAD");
  assert.deepEqual(candidateSeedPlacement(rehearsal), { allowed: true });

  // A detached head names no branch, so a rehearsal tree sitting at its pinned base is
  // indistinguishable from any other checkout. That is an unresolved topology, not a permission.
  const detached = join(base, "pipeline-worktrees", "tasks", "detached");
  gitIn(primary, "worktree", "add", "--quiet", "--detach", detached, "HEAD");
  assert.deepEqual(candidateSeedPlacement(detached), {
    allowed: false,
    code: "candidate_seed_refused_unresolved_topology",
  });

  // A redirection variable must not be able to choose the answer. The whole list is frozen
  // below, because only two of its seven names are exercisable here and the other five would be
  // removable with every test still green.
  try {
    process.env.GIT_DIR = join(primary, ".git");
    process.env.GIT_COMMON_DIR = join(primary, ".git");
    assert.deepEqual(candidateSeedPlacement(rehearsal), { allowed: true });
  } finally {
    delete process.env.GIT_DIR;
    delete process.env.GIT_COMMON_DIR;
  }

  // Git that does not run at all is the case a fail-open detector would read as "not the
  // operational checkout" and seed straight into it.
  const path = process.env.PATH;
  try {
    process.env.PATH = join(base, "no-tools");
    assert.deepEqual(candidateSeedPlacement(primary), {
      allowed: false,
      code: "candidate_seed_refused_unresolved_topology",
    });
  } finally {
    process.env.PATH = path;
  }
});

test("the seed detector scrubs the pinned git redirection variables", () => {
  // Frozen as a literal rather than read back out of the module under test. The list is the
  // seed detector's, not the CI runner's: `GIT_COMMON_DIR` is what the primary-worktree check compares,
  // and the runner's list does not carry it.
  assert.deepEqual(
    [...GIT_REDIRECTION_VARIABLES],
    [
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_CEILING_DIRECTORIES",
      "GIT_COMMON_DIR",
      "GIT_DIR",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_WORK_TREE",
    ],
  );
});

test("init seeds the candidate layer in a rehearsal worktree", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-bootstrap-candidate-rehearsal-",
  });
  // The placement verdicts are proved one by one above; this is the one end-to-end run that
  // shows the allowed verdict actually produces a layer.
  const repository = join(environment.workspaceRoot, "pipeline");
  seedRepository(repository);
  const rehearsal = join(environment.workspaceRoot, "rehearsal");
  gitIn(repository, "worktree", "add", "--quiet", "-b", "rehearsal/probe", rehearsal, "HEAD");

  const report = JSON.parse(
    spawnSync(process.execPath, [bootstrapPath, "--init"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: rawEnvironment(environment, {
        JOB_PIPELINE_OUTPUT_ROOT: join(rehearsal, "output"),
        JOB_PIPELINE_PROCESS_LOG: join(rehearsal, "process-log.json"),
        JOB_PIPELINE_WORKSPACE_ROOT: rehearsal,
      }),
    }).stdout,
  );
  assert.deepEqual(report.candidate, {
    created: true,
    path: candidateRootFor(rehearsal),
    status: "ready",
  });
  assert.deepEqual(
    JSON.parse(readFileSync(join(candidateRootFor(rehearsal), "config.json"), "utf8")),
    JSON.parse(readFileSync(join(repoRoot, "candidate.example/config.json"), "utf8")),
  );
});

test("concurrent init publishes one candidate layer and leaves no staging residue", async (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-bootstrap-candidate-race-",
  });
  const results = await Promise.all(
    Array.from({ length: 16 }, () => runBootstrapAsync(environment, "--init")),
  );
  assert.deepEqual(
    results.map((result) => result.code),
    Array(16).fill(0),
  );
  const reports = results.map((result) => JSON.parse(result.stdout));
  const root = candidateRootFor(environment.workspaceRoot);
  for (const report of reports) {
    assert.equal(report.candidate.status, "ready");
    assert.equal(report.candidate.path, root);
  }
  assert.equal(reports.filter((report) => report.candidate.created).length, 1);
  assert.deepEqual(stagingResidue(environment.workspaceRoot), []);
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, "config.json"), "utf8")),
    JSON.parse(readFileSync(join(repoRoot, "candidate.example/config.json"), "utf8")),
  );
});
