import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertDisposableWorkspace,
  createDisposableWorkspace,
  disposableMarkerFileName,
  disposableWorkspaceEnv,
  readDisposableWorkspaceEnv,
} from "./fixtures/disposable-workspace.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliChildPath = resolve(
  repoRoot,
  "tests/fixtures/process-log-cli-child.mjs",
);

function emptyLog() {
  return {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: "2026-07-30T12:00:00.000Z",
    companies: [],
    processes: [],
  };
}

test("CLI child rejects an unmarked synthetic root before mutation", (t) => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "disposable-root-red-"));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  const outputRoot = join(workspaceRoot, "output");
  const ledgerPath = join(workspaceRoot, "process-log.json");
  mkdirSync(outputRoot);
  writeFileSync(ledgerPath, `${JSON.stringify(emptyLog(), null, 2)}\n`);
  const before = readFileSync(ledgerPath, "utf8");

  const result = spawnSync(
    process.execPath,
    [
      cliChildPath,
      "start",
      "--source-ref",
      "synthetic:red-before-green",
      "--runner",
      "codex",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        JOB_PIPELINE_OUTPUT_ROOT: outputRoot,
        JOB_PIPELINE_PROCESS_LOG: ledgerPath,
        JOB_PIPELINE_WORKSPACE_ROOT: workspaceRoot,
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.equal(
    JSON.parse(result.stderr).code,
    "invalid_disposable_environment",
  );
  assert.equal(readFileSync(ledgerPath, "utf8"), before);
  assert.equal(existsSync(`${ledgerPath}.lock`), false);
  assert.deepEqual(readdirSync(outputRoot), []);
});

test("factory-created roots pass direct and child validation with hooks disabled", (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyLog(),
    prefix: "disposable-root-positive-",
  });
  assert.equal(assertDisposableWorkspace(environment), environment);
  assert.equal(
    readDisposableWorkspaceEnv(disposableWorkspaceEnv(environment)).workspaceRoot,
    environment.workspaceRoot,
  );

  const result = spawnSync(
    process.execPath,
    [
      cliChildPath,
      "start",
      "--source-ref",
      "synthetic:marked-child",
      "--runner",
      "codex",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ...disposableWorkspaceEnv(environment),
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(readFileSync(environment.ledgerPath, "utf8")).processes.length,
    1,
  );
  assert.equal(existsSync(resolve(repoRoot, ".codex/hooks.json")), false);
  // The property this test carries is that disposable-root enforcement holds
  // without any runtime hook helping it. Tracked settings now register the
  // operational write boundary, so the property is asserted directly instead of
  // through the old proxy "no hook is registered at all": every registered hook
  // observes file tools only and none of them can see the CLI child above,
  // which this test spawns itself.
  const claudeHooks = JSON.parse(
    readFileSync(resolve(repoRoot, ".claude/settings.json"), "utf8"),
  ).hooks ?? {};
  // Pinned whole. A key list would let a second command be added under the
  // approved matcher — including one that writes, or one that returns before
  // the boundary hook runs — without this contract noticing.
  assert.deepEqual(claudeHooks, {
    PreToolUse: [
      {
        hooks: [
          {
            command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/write-guard.mjs"',
            type: "command",
          },
        ],
        matcher: "Edit|Write|NotebookEdit",
      },
    ],
  });
});

test("real repository root and mismatched direct children fail closed", (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyLog(),
    prefix: "disposable-root-binding-",
  });
  assert.throws(
    () => assertDisposableWorkspace({
      ledgerPath: resolve(repoRoot, "process-log.json"),
      markerToken: environment.markerToken,
      outputRoot: resolve(repoRoot, "output"),
      workspaceRoot: repoRoot,
    }),
    (error) => error.code === "invalid_disposable_marker",
  );
  assert.throws(
    () => assertDisposableWorkspace({
      ...environment,
      ledgerPath: resolve(repoRoot, "process-log.json"),
    }),
    (error) => error.code === "invalid_disposable_ledger",
  );
  assert.throws(
    () => assertDisposableWorkspace({
      ...environment,
      outputRoot: join(environment.workspaceRoot, "other-output"),
    }),
    (error) => error.code === "invalid_disposable_output",
  );
  assert.throws(
    () => assertDisposableWorkspace({
      ...environment,
      markerToken: "wrong-token-with-sufficient-length",
    }),
    (error) => error.code === "invalid_disposable_marker",
  );
});

test("marker identity rejects missing, malformed, linked, and copied markers", async (t) => {
  await t.test("missing marker", (t) => {
    const environment = createDisposableWorkspace(t, {
      ledger: emptyLog(),
      prefix: "disposable-root-missing-",
    });
    unlinkSync(join(environment.workspaceRoot, disposableMarkerFileName));
    assert.throws(
      () => assertDisposableWorkspace(environment),
      (error) => error.code === "invalid_disposable_marker",
    );
  });

  await t.test("malformed marker", (t) => {
    const environment = createDisposableWorkspace(t, {
      ledger: emptyLog(),
      prefix: "disposable-root-malformed-",
    });
    writeFileSync(
      join(environment.workspaceRoot, disposableMarkerFileName),
      "{not-json\n",
    );
    assert.throws(
      () => assertDisposableWorkspace(environment),
      (error) => error.code === "invalid_disposable_marker",
    );
  });

  await t.test("symlink marker", (t) => {
    const environment = createDisposableWorkspace(t, {
      ledger: emptyLog(),
      prefix: "disposable-root-marker-link-",
    });
    const markerPath = join(
      environment.workspaceRoot,
      disposableMarkerFileName,
    );
    unlinkSync(markerPath);
    symlinkSync(environment.ledgerPath, markerPath);
    assert.throws(
      () => assertDisposableWorkspace(environment),
      (error) => error.code === "invalid_disposable_marker",
    );
  });

  await t.test("hardlink marker", (t) => {
    const environment = createDisposableWorkspace(t, {
      ledger: emptyLog(),
      prefix: "disposable-root-marker-hardlink-",
    });
    linkSync(
      join(environment.workspaceRoot, disposableMarkerFileName),
      join(environment.workspaceRoot, "marker-hardlink"),
    );
    assert.throws(
      () => assertDisposableWorkspace(environment),
      (error) => error.code === "invalid_disposable_marker",
    );
  });

  await t.test("copied marker", (t) => {
    const source = createDisposableWorkspace(t, {
      ledger: emptyLog(),
      prefix: "disposable-root-marker-source-",
    });
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "disposable-root-marker-copy-"),
    );
    t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
    const outputRoot = join(workspaceRoot, "output");
    const ledgerPath = join(workspaceRoot, "process-log.json");
    mkdirSync(outputRoot);
    writeFileSync(ledgerPath, `${JSON.stringify(emptyLog())}\n`);
    copyFileSync(
      join(source.workspaceRoot, disposableMarkerFileName),
      join(workspaceRoot, disposableMarkerFileName),
    );
    assert.throws(
      () => assertDisposableWorkspace({
        ledgerPath,
        markerToken: source.markerToken,
        outputRoot,
        workspaceRoot,
      }),
      (error) => error.code === "disposable_workspace_alias",
    );
  });
});

test("workspace aliases fail while the creator lexical path remains valid", async (t) => {
  const environment = createDisposableWorkspace(t, {
    ledger: emptyLog(),
    prefix: "disposable-root-alias-target-",
  });
  assert.equal(assertDisposableWorkspace(environment), environment);

  await t.test("final symlink", (t) => {
    const holder = mkdtempSync(join(tmpdir(), "disposable-alias-final-"));
    t.after(() => rmSync(holder, { recursive: true, force: true }));
    const alias = join(holder, "workspace");
    symlinkSync(environment.workspaceRoot, alias, "dir");
    assert.throws(
      () => assertDisposableWorkspace({
        ledgerPath: join(alias, "process-log.json"),
        markerToken: environment.markerToken,
        outputRoot: join(alias, "output"),
        workspaceRoot: alias,
      }),
      (error) => error.code === "invalid_disposable_workspace",
    );
  });

  await t.test("symlinked ancestor", (t) => {
    const holder = mkdtempSync(join(tmpdir(), "disposable-alias-parent-"));
    t.after(() => rmSync(holder, { recursive: true, force: true }));
    const parentAlias = join(holder, "parent");
    symlinkSync(dirname(environment.workspaceRoot), parentAlias, "dir");
    const alias = join(parentAlias, basename(environment.workspaceRoot));
    assert.throws(
      () => assertDisposableWorkspace({
        ledgerPath: join(alias, "process-log.json"),
        markerToken: environment.markerToken,
        outputRoot: join(alias, "output"),
        workspaceRoot: alias,
      }),
      (error) => error.code === "disposable_workspace_alias",
    );
  });
});

test("covered lifecycle, CLI-child, and server roots cannot bypass the shared factory", () => {
  const covered = [
    "tests/file-backed-pipeline-e2e.test.mjs",
    "tests/fixtures/file-backed-pipeline-producer.mjs",
    "tests/fixtures/process-search-ui-server.mjs",
    "tests/fixtures/process-search-ui.mjs",
    "tests/process-log-concurrency.test.mjs",
    "tests/process-log-core.test.mjs",
    "tests/process-log-v3-cli.test.mjs",
    "tests/process-log-v3-deep-validation.test.mjs",
    "tests/process-log-v3-identity-resolver.test.mjs",
    "tests/process-log-v3-lifecycle-start.test.mjs",
    "tests/process-log-v3-output-reservation.test.mjs",
    "tests/process-log-v3-preflight-begin.test.mjs",
    "tests/process-log-v3-validation.test.mjs",
    "tests/process-search-server.test.mjs",
  ];
  for (const path of covered) {
    const source = readFileSync(resolve(repoRoot, path), "utf8");
    assert.doesNotMatch(
      source,
      /\bmkdtempSync\b/,
      `${path} must use the shared disposable workspace factory`,
    );
  }
  assert.match(
    readFileSync(
      resolve(repoRoot, "tests/fixtures/file-backed-pipeline-producer.mjs"),
      "utf8",
    ),
    /readDisposableWorkspaceEnv/,
  );
  assert.match(
    readFileSync(
      resolve(repoRoot, "tests/fixtures/process-log-cli-child.mjs"),
      "utf8",
    ),
    /readDisposableWorkspaceEnv/,
  );
});
