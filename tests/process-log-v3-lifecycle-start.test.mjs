import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  buildDuplicateChain,
  fileBackedStepNames,
  readLogV3,
  searchCompaniesV3,
  searchProcessesV3,
} from "../tools/lib/process-log-core.mjs";
import {
  createInitialFileBackedProcess,
  createPendingFileBackedStep,
  getFileBackedProcessForMutation,
  historicalProcessMutationOperations,
  linkFileBackedProcessDuplicateV3,
  startFileBackedProcessV3,
} from "../tools/lib/process-log-v3-lifecycle.mjs";
import {
  createHistoricalV2Log,
  createRunningPublicationStep,
  createValidV3Log,
} from "./fixtures/process-log-v3.mjs";
import {
  createDisposableWorkspace,
  disposableWorkspaceEnv,
} from "./fixtures/disposable-workspace.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const disposableModuleUrl = pathToFileURL(
  resolve(repoRoot, "tests/fixtures/disposable-workspace.mjs"),
).href;
const lifecycleModuleUrl = pathToFileURL(
  resolve(repoRoot, "tools/lib/process-log-v3-lifecycle.mjs"),
).href;
const disposableByLedgerPath = new Map();
const EXPECTED_HISTORICAL_MUTATION_OPERATIONS = Object.freeze([
  "update",
  "link-company",
  "link-duplicate",
  "reserve-output",
  "begin-step",
  "publish-step",
  "block-step",
  "fail-step",
  "retry-step",
  "reopen-step",
  "revise-step",
  "reconcile-step",
  "cleanup-staging",
  "set-output",
  "mark-failed",
]);

function emptyV3Log() {
  return {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: "2026-07-23T12:00:00.000Z",
    companies: [],
    processes: [],
  };
}

function historicalOnlyV3Log() {
  const log = createHistoricalV2Log();
  log.schema_version = 4;
  return log;
}

function tempLedger(t, log = emptyV3Log()) {
  const environment = createDisposableWorkspace(t, {
    ledger: log,
    prefix: "job-search-process-log-v3-start-",
  });
  disposableByLedgerPath.set(environment.ledgerPath, environment);
  t.after(() => disposableByLedgerPath.delete(environment.ledgerPath));
  return environment.ledgerPath;
}

function deterministicStartOptions({
  attemptId = "attempt_get_vacancy_new_001",
  processId = "proc_file_backed_new_001",
  timestamp = "2026-07-23T13:00:00.000Z",
} = {}) {
  return {
    attemptIdFactory: () => attemptId,
    clock: () => timestamp,
    processIdFactory: () => processId,
  };
}

function runV3StartChild(ledgerPath, sourceRef) {
  const environment = disposableByLedgerPath.get(ledgerPath);
  assert.ok(environment, "child ledger must come from the disposable factory");
  const script = `
    import { readDisposableWorkspaceEnv } from ${JSON.stringify(disposableModuleUrl)};
    import { startFileBackedProcessV3 } from ${JSON.stringify(lifecycleModuleUrl)};
    const environment = readDisposableWorkspaceEnv();
    const result = startFileBackedProcessV3(
      environment.ledgerPath,
      { sourceRef: process.env.TEST_V3_SOURCE, runner: "codex" },
    );
    process.stdout.write(JSON.stringify(result));
  `;
  return runStartChildScript(script, {
    ...process.env,
    ...disposableWorkspaceEnv(environment),
    TEST_V3_SOURCE: sourceRef,
  });
}

function runStartChildScript(script, env = process.env) {
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env,
      },
      (error, stdout, stderr) => {
        resolveRun({
          code: error ? (error.code ?? null) : 0,
          signal: error?.signal ?? null,
          stderr,
          stdout,
        });
      },
    );
  });
}

function assertStartChildrenSucceeded(results) {
  const failures = results.flatMap((result, index) =>
    result.code === 0 && !result.signal
      ? []
      : [
          {
            index,
            code: result.code,
            signal: result.signal ?? null,
            stdout: result.stdout.slice(-1_024),
            stderr: result.stderr.slice(-1_024),
          },
        ],
  );
  assert.deepEqual(
    results.map((result) => result.signal ?? result.code),
    Array(results.length).fill(0),
    `parallel start child failures (output tails): ${JSON.stringify(failures)}`,
  );
}

test("parallel start failures report bounded child output, index and signal", () => {
  assert.throws(
    () =>
      assertStartChildrenSucceeded([
        { code: 0, stdout: "success output", stderr: "" },
        {
          code: 1,
          signal: "SIGTERM",
          stdout: "x".repeat(10_000),
          stderr: "y".repeat(10_000) + "failure-tail",
        },
      ]),
    (error) => {
      assert.match(error.message, /"index":1/);
      assert.match(error.message, /"code":1/);
      assert.match(error.message, /SIGTERM/);
      assert.match(error.message, /failure-tail/);
      assert.doesNotMatch(error.message, /success output/);
      assert.ok(error.message.length < 4_000);
      return true;
    },
  );
});

test("parallel start diagnostics reject a real signal-terminated child", async () => {
  const result = await runStartChildScript(
    'process.stdout.write("before-signal"); process.stderr.write("signal-failure", () => process.kill(process.pid, "SIGTERM"));',
  );
  assert.throws(
    () => assertStartChildrenSucceeded([result]),
    (error) => {
      assert.match(error.message, /"index":0/);
      assert.match(error.message, /SIGTERM/);
      assert.match(error.message, /before-signal/);
      assert.match(error.message, /signal-failure/);
      return true;
    },
  );
});

test("deterministic constructors create one running Step 1 and four independent pristine steps", () => {
  const pending = createPendingFileBackedStep();
  const processRecord = createInitialFileBackedProcess({
    attemptId: "attempt_get_vacancy_constructor_001",
    companyHint: "Constructor Company",
    duplicateOf: null,
    processId: "proc_constructor_001",
    runner: "codex",
    sourceRef: "fixture:constructor",
    startedAt: "2026-07-23T12:10:00.000Z",
  });

  assert.deepEqual(Object.keys(processRecord.steps), fileBackedStepNames);
  assert.equal(processRecord.steps.get_vacancy.state, "running");
  assert.equal(processRecord.steps.get_vacancy.attempt, 1);
  assert.equal(
    processRecord.steps.get_vacancy.active_attempt.id,
    "attempt_get_vacancy_constructor_001",
  );
  for (const stepName of fileBackedStepNames.slice(1)) {
    assert.deepEqual(processRecord.steps[stepName], pending);
    assert.notEqual(processRecord.steps[stepName], pending);
  }
  assert.notEqual(processRecord.steps.research_company, processRecord.steps.map_experience);
});

test("v3 start atomically writes a complete file-backed process to a temporary ledger", (t) => {
  const ledgerPath = tempLedger(t);
  const result = startFileBackedProcessV3(
    ledgerPath,
    {
      companyHint: "Example",
      runner: "codex",
      sourceRef: "https://EXAMPLE.test/jobs/1?utm_source=fixture",
    },
    deterministicStartOptions(),
  );
  const log = readLogV3(ledgerPath);
  const processRecord = log.processes[0];

  assert.equal(result.status, "created");
  assert.deepEqual(result.process, processRecord);
  assert.equal(processRecord.id, "proc_file_backed_new_001");
  assert.equal(processRecord.source_ref, "https://EXAMPLE.test/jobs/1?utm_source=fixture");
  assert.equal(processRecord.source_key, "https://example.test/jobs/1");
  assert.equal(processRecord.company_hint, "Example");
  assert.equal(processRecord.output_dir, null);
  assert.equal(processRecord.artifact_mode, "file-backed");
  assert.equal(processRecord.steps.get_vacancy.state, "running");
  assert.equal(processRecord.steps.get_vacancy.revision, 0);
  assert.deepEqual(processRecord.steps.get_vacancy.active_attempt.input_snapshot, []);
  assert.deepEqual(processRecord.steps.get_vacancy.active_attempt.expected_artifacts, []);
  assert.equal(log.updated_at, "2026-07-23T13:00:00.000Z");
});

test("v3 start reports a duplicate without changing temporary ledger bytes", (t) => {
  const ledgerPath = tempLedger(t, historicalOnlyV3Log());
  const before = readFileSync(ledgerPath, "utf8");
  const result = startFileBackedProcessV3(
    ledgerPath,
    {
      runner: "codex",
      sourceRef: "historical-fixture:example",
    },
    deterministicStartOptions(),
  );

  assert.equal(result.status, "duplicate");
  assert.deepEqual(
    result.matches.map((record) => record.id),
    ["proc_historical_001"],
  );
  assert.equal(readFileSync(ledgerPath, "utf8"), before);
});

test("v3 start reports a collision witness for the parameters version 2 still strips", (t) => {
  // Before the cutover this case read `query`, `source`, `tab` and `refid` — the four CORE-03
  // reproduced as meaningful. They no longer collide at all, which is the defect closing rather than
  // the witness machinery weakening: the machinery is pinned here on the parameters version 2 does
  // still strip, and the four meaningful ones are pinned as non-collisions by the case below.
  for (const parameter of ["trk", "trackingid", "hhtmfrom", "alternatechannel"]) {
    const ledgerPath = tempLedger(t);
    const first = startFileBackedProcessV3(
      ledgerPath,
      {
        runner: "codex",
        sourceRef: `https://example.test/jobs/collision?${parameter}=alpha`,
      },
      deterministicStartOptions(),
    );
    const before = readFileSync(ledgerPath, "utf8");
    const duplicate = startFileBackedProcessV3(
      ledgerPath,
      {
        runner: "codex",
        sourceRef: `https://example.test/jobs/collision?${parameter}=beta`,
      },
      deterministicStartOptions({
        attemptId: `attempt_${parameter}_must_not_allocate`,
        processId: `proc_${parameter}_must_not_allocate`,
      }),
    );

    assert.equal(first.status, "created");
    assert.equal(duplicate.status, "duplicate");
    assert.deepEqual(duplicate.collision, {
      code: "legacy_source_key_collision",
      status: "ambiguous",
      requested_source_ref: `https://example.test/jobs/collision?${parameter}=beta`,
      matches: [
        {
          process_id: first.process.id,
          source_ref: first.process.source_ref,
          duplicate_of: null,
          witnesses: [parameter],
        },
      ],
      source_key: "https://example.test/jobs/collision",
      requires_final_url_check: true,
      requires_explicit_duplicate_of: true,
    });
    assert.equal(readFileSync(ledgerPath, "utf8"), before);
  }
});

test("v3 start creates a second process for each parameter version 2 preserves", (t) => {
  // CORE-03 at the lifecycle boundary. `duplicate_of` is never offered because there is no
  // duplicate: the two references are two postings, and no collision evidence is attached.
  for (const parameter of ["query", "source", "tab", "refid"]) {
    const ledgerPath = tempLedger(t);
    const first = startFileBackedProcessV3(
      ledgerPath,
      {
        runner: "codex",
        sourceRef: `https://example.test/jobs/meaningful?${parameter}=alpha`,
      },
      deterministicStartOptions(),
    );
    const second = startFileBackedProcessV3(
      ledgerPath,
      {
        runner: "codex",
        sourceRef: `https://example.test/jobs/meaningful?${parameter}=beta`,
      },
      deterministicStartOptions({
        attemptId: `attempt_${parameter}_second`,
        processId: `proc_${parameter}_second`,
        timestamp: "2026-07-23T13:05:00.000Z",
      }),
    );

    assert.equal(first.status, "created", parameter);
    assert.equal(second.status, "created", parameter);
    assert.equal(second.collision, undefined, parameter);
    assert.equal(
      second.process.source_key,
      `https://example.test/jobs/meaningful?${parameter}=beta`,
      parameter,
    );
    assert.equal(readLogV3(ledgerPath).processes.length, 2, parameter);
  }
});

test("explicit duplicate containment appends a linked attempt without rewriting the legacy record", (t) => {
  const ledgerPath = tempLedger(t);
  const first = startFileBackedProcessV3(
    ledgerPath,
    {
      runner: "codex",
      sourceRef: "https://example.test/jobs/contained?trk=alpha",
    },
    deterministicStartOptions(),
  );
  const originalBefore = JSON.stringify(first.process);
  const companiesBefore = JSON.stringify(readLogV3(ledgerPath).companies);
  const contained = startFileBackedProcessV3(
    ledgerPath,
    {
      duplicateOf: first.process.id,
      runner: "codex",
      sourceRef: "https://example.test/jobs/contained?trk=beta",
    },
    deterministicStartOptions({
      attemptId: "attempt_get_vacancy_contained_002",
      processId: "proc_file_backed_contained_002",
      timestamp: "2026-07-23T13:01:00.000Z",
    }),
  );
  const log = readLogV3(ledgerPath);

  assert.equal(contained.status, "created");
  assert.equal(contained.process.duplicate_of, first.process.id);
  assert.equal(contained.collision.code, "legacy_source_key_collision");
  assert.equal(contained.collision.status, "ambiguous");
  assert.equal(contained.collision.source_key, "https://example.test/jobs/contained");
  assert.equal(contained.collision.requires_final_url_check, true);
  assert.equal(contained.collision.requires_explicit_duplicate_of, false);
  assert.deepEqual(contained.collision.matches[0].witnesses, ["trk"]);
  assert.equal(JSON.stringify(log.processes[0]), originalBefore);
  assert.equal(JSON.stringify(log.companies), companiesBefore);
});

test("a link to a predecessor the cutover separated is accepted and reported, not refused", (t) => {
  // Task 010 reverses what ADR 0013 row 20 enforced. That refusal was the system deciding, from the
  // two references alone, that these are two vacancies — and sameness across sources is the user's
  // call. The signal the refusal carried is kept: the result names both keys, and refuses nothing.
  const ledgerPath = tempLedger(t);
  const first = startFileBackedProcessV3(
    ledgerPath,
    {
      runner: "codex",
      sourceRef: "https://example.test/jobs/separated?query=alpha",
    },
    deterministicStartOptions(),
  );
  const second = startFileBackedProcessV3(
    ledgerPath,
    {
      duplicateOf: first.process.id,
      runner: "codex",
      sourceRef: "https://example.test/jobs/separated?query=beta",
    },
    deterministicStartOptions({
      attemptId: "attempt_separated_002",
      processId: "proc_separated_002",
      timestamp: "2026-07-23T13:02:00.000Z",
    }),
  );

  assert.equal(second.status, "created");
  assert.equal(second.process.duplicate_of, first.process.id);
  assert.deepEqual(second.cross_source_link, {
    code: "cross_source_duplicate_link",
    source_key: "https://example.test/jobs/separated?query=beta",
    duplicate_of: first.process.id,
    duplicate_of_source_key: "https://example.test/jobs/separated?query=alpha",
  });
  assert.equal(
    readLogV3(ledgerPath).processes.find((record) => record.id === "proc_separated_002")
      .duplicate_of,
    first.process.id,
  );
});

test("the motivating case: a local JD is linked to a historical posting that arrived another way", (t) => {
  // Task 010. The July posting is gone and the JD came back as a file, so the two references never
  // normalize to one key. The link is the user's explicit call, and the historical record is
  // provenance only: it is not resumed, not adopted and not touched.
  const initial = historicalOnlyV3Log();
  const historicalBefore = JSON.stringify(initial.processes[0]);
  const ledgerPath = tempLedger(t, initial);
  const result = startFileBackedProcessV3(
    ledgerPath,
    {
      duplicateOf: "proc_historical_001",
      runner: "codex",
      sourceRef: "local-file:JD Example Labs QA.pdf",
    },
    deterministicStartOptions(),
  );
  const log = readLogV3(ledgerPath);
  const created = log.processes.find((record) => record.id === result.process.id);

  assert.equal(result.status, "created");
  assert.equal(created.duplicate_of, "proc_historical_001");
  assert.equal(
    JSON.stringify(log.processes.find((record) => record.id === "proc_historical_001")),
    historicalBefore,
  );
});

test("an explicit new attempt duplicates a historical source without mutating history or companies", (t) => {
  const initial = historicalOnlyV3Log();
  const historicalBefore = JSON.stringify(initial.processes[0]);
  const companiesBefore = JSON.stringify(initial.companies);
  const ledgerPath = tempLedger(t, initial);
  const result = startFileBackedProcessV3(
    ledgerPath,
    {
      companyHint: "Example Labs",
      duplicateOf: "proc_historical_001",
      runner: "codex",
      sourceRef: "historical-fixture:example",
    },
    deterministicStartOptions(),
  );
  const log = readLogV3(ledgerPath);
  const created = log.processes.find((record) => record.id === result.process.id);

  assert.equal(result.status, "created");
  assert.equal(created.duplicate_of, "proc_historical_001");
  assert.equal(created.artifact_mode, "file-backed");
  assert.equal(JSON.stringify(log.processes[0]), historicalBefore);
  assert.equal(JSON.stringify(log.companies), companiesBefore);
});

test("late linking records the same provenance without redoing any step", (t) => {
  // Task 010: sameness became known after the process already existed. Only the link and the
  // timestamps move; the steps the process already ran are byte-identical afterwards.
  const ledgerPath = tempLedger(t, createValidV3Log());
  const before = readLogV3(ledgerPath).processes.find(
    (record) => record.id === "proc_file_backed_001",
  );
  const stepsBefore = JSON.stringify(before.steps);
  const outputDirBefore = before.output_dir;

  const result = linkFileBackedProcessDuplicateV3(ledgerPath, {
    processId: "proc_file_backed_001",
    duplicateOf: "proc_historical_001",
  });
  const after = readLogV3(ledgerPath).processes.find(
    (record) => record.id === "proc_file_backed_001",
  );

  assert.equal(result.status, "linked");
  assert.equal(after.duplicate_of, "proc_historical_001");
  assert.equal(JSON.stringify(after.steps), stepsBefore);
  assert.equal(after.output_dir, outputDirBefore);
  assert.deepEqual(result.cross_source_link, {
    code: "cross_source_duplicate_link",
    source_key: "https://example.test/careers/sdet",
    duplicate_of: "proc_historical_001",
    duplicate_of_source_key: "historical-fixture:example",
  });
});

test("a declared link is cleared again, and re-declaring the same link changes nothing", (t) => {
  const ledgerPath = tempLedger(t, createValidV3Log());
  linkFileBackedProcessDuplicateV3(ledgerPath, {
    processId: "proc_file_backed_001",
    duplicateOf: "proc_historical_001",
  });
  const repeated = linkFileBackedProcessDuplicateV3(ledgerPath, {
    processId: "proc_file_backed_001",
    duplicateOf: "proc_historical_001",
  });
  assert.equal(repeated.status, "unchanged");

  const cleared = linkFileBackedProcessDuplicateV3(ledgerPath, {
    processId: "proc_file_backed_001",
    duplicateOf: null,
  });
  assert.equal(cleared.status, "cleared");
  assert.equal(
    readLogV3(ledgerPath).processes.find((record) => record.id === "proc_file_backed_001")
      .duplicate_of,
    null,
  );
});

test("late linking refuses an unknown target, itself, a cycle, and a historical record", (t) => {
  const ledgerPath = tempLedger(t, createValidV3Log());
  const before = readFileSync(ledgerPath, "utf8");

  for (const [duplicateOf, processId] of [
    ["proc_typo_999", "proc_file_backed_001"],
    ["proc_file_backed_001", "proc_file_backed_001"],
  ]) {
    assert.throws(
      () => linkFileBackedProcessDuplicateV3(ledgerPath, { processId, duplicateOf }),
      (error) => error.code === "invalid_duplicate_reference",
    );
  }
  assert.throws(
    () =>
      linkFileBackedProcessDuplicateV3(ledgerPath, {
        processId: "proc_historical_001",
        duplicateOf: "proc_file_backed_001",
      }),
    (error) => error.code === "historical_process_read_only",
  );
  assert.equal(readFileSync(ledgerPath, "utf8"), before);

  // A cycle needs two file-backed records, so build one and close the loop through it.
  const cycleLedger = tempLedger(t);
  const first = startFileBackedProcessV3(
    cycleLedger,
    { runner: "codex", sourceRef: "local-file:one" },
    deterministicStartOptions({ processId: "proc_cycle_001" }),
  );
  const second = startFileBackedProcessV3(
    cycleLedger,
    { runner: "codex", sourceRef: "local-file:two", duplicateOf: "proc_cycle_001" },
    deterministicStartOptions({
      attemptId: "attempt_cycle_002",
      processId: "proc_cycle_002",
      timestamp: "2026-07-23T13:05:00.000Z",
    }),
  );
  assert.equal(second.process.duplicate_of, first.process.id);
  assert.throws(
    () =>
      linkFileBackedProcessDuplicateV3(cycleLedger, {
        processId: "proc_cycle_001",
        duplicateOf: "proc_cycle_002",
      }),
    (error) => error.code === "invalid_duplicate_reference" && /close a cycle/.test(error.message),
  );
});

test("a record sharing a key with an earlier one stays inside its group, whichever writer asks", (t) => {
  // The identical-source case does not get weaker: the reader's group invariant runs on every load,
  // so a non-first member pointing outside its group would make the ledger unreadable. The group's
  // first record is exempt, and that is the end a cross-source predecessor is linked from.
  const ledgerPath = tempLedger(t);
  const outsider = startFileBackedProcessV3(
    ledgerPath,
    { runner: "codex", sourceRef: "https://example.test/jobs/outside" },
    deterministicStartOptions({ processId: "proc_outside_001" }),
  );
  const groupFirst = startFileBackedProcessV3(
    ledgerPath,
    { runner: "codex", sourceRef: "local-file:shared" },
    deterministicStartOptions({
      attemptId: "attempt_shared_001",
      processId: "proc_shared_001",
      timestamp: "2026-07-23T13:01:00.000Z",
    }),
  );

  // `start` refuses a second member of the group that names anything outside it.
  assert.throws(
    () =>
      startFileBackedProcessV3(
        ledgerPath,
        {
          runner: "codex",
          sourceRef: "local-file:shared",
          duplicateOf: outsider.process.id,
        },
        deterministicStartOptions({
          attemptId: "attempt_shared_002",
          processId: "proc_shared_002",
          timestamp: "2026-07-23T13:02:00.000Z",
        }),
      ),
    (error) =>
      error.code === "invalid_duplicate_reference" && error.message.includes(groupFirst.process.id),
  );

  // Accept it the legal way, so the group really holds two, and check the same rule on the other
  // writer: the first record may link out, and the second may neither follow it nor let go.
  const groupSecond = startFileBackedProcessV3(
    ledgerPath,
    {
      runner: "codex",
      sourceRef: "local-file:shared",
      duplicateOf: groupFirst.process.id,
    },
    deterministicStartOptions({
      attemptId: "attempt_shared_002",
      processId: "proc_shared_002",
      timestamp: "2026-07-23T13:02:00.000Z",
    }),
  );
  assert.equal(groupSecond.status, "created");

  const linked = linkFileBackedProcessDuplicateV3(ledgerPath, {
    processId: groupFirst.process.id,
    duplicateOf: outsider.process.id,
  });
  assert.equal(linked.status, "linked");

  for (const duplicateOf of [outsider.process.id, null]) {
    assert.throws(
      () =>
        linkFileBackedProcessDuplicateV3(ledgerPath, {
          processId: groupSecond.process.id,
          duplicateOf,
        }),
      (error) =>
        error.code === "invalid_duplicate_reference" &&
        error.message.includes(groupFirst.process.id),
    );
  }

  // And the chain still reaches the cross-source predecessor, transitively through the first.
  assert.deepEqual(
    buildDuplicateChain(readLogV3(ledgerPath), groupSecond.process.id).members.map(
      (member) => member.process_id,
    ),
    [outsider.process.id, groupFirst.process.id, groupSecond.process.id],
  );
});

test("an invalid duplicate reference and an active-attempt id collision leave the ledger unchanged", (t) => {
  const invalidDuplicatePath = tempLedger(t, historicalOnlyV3Log());
  const invalidDuplicateBefore = readFileSync(invalidDuplicatePath, "utf8");
  assert.throws(
    () =>
      startFileBackedProcessV3(
        invalidDuplicatePath,
        {
          duplicateOf: "proc_other_source",
          runner: "codex",
          sourceRef: "historical-fixture:example",
        },
        deterministicStartOptions(),
      ),
    (error) => error.code === "invalid_duplicate_reference",
  );
  assert.equal(readFileSync(invalidDuplicatePath, "utf8"), invalidDuplicateBefore);

  const collisionLog = createValidV3Log();
  collisionLog.processes[1].steps.generate_cv = createRunningPublicationStep();
  const collisionPath = tempLedger(t, collisionLog);
  const collisionBefore = readFileSync(collisionPath, "utf8");
  assert.throws(
    () =>
      startFileBackedProcessV3(
        collisionPath,
        {
          runner: "codex",
          sourceRef: "fixture:attempt-id-collision",
        },
        deterministicStartOptions({
          attemptId: "attempt_generate_cv_001",
          processId: "proc_attempt_id_collision",
        }),
      ),
    (error) => error.code === "active_attempt_id_conflict",
  );
  assert.equal(readFileSync(collisionPath, "utf8"), collisionBefore);
});

test("v3 company/process search preserves hint, domain, and reverse-chronology behavior", (t) => {
  const log = emptyV3Log();
  log.companies.push({
    id: "company_example",
    display_name: "Example Labs",
    search_terms: ["Example Labs", "Экзампл"],
    domains: ["example.test"],
  });
  const ledgerPath = tempLedger(t, log);
  startFileBackedProcessV3(
    ledgerPath,
    {
      companyHint: "Needle Systems",
      runner: "codex",
      sourceRef: "https://careers.example.test/jobs/first",
    },
    deterministicStartOptions({
      attemptId: "attempt_first",
      processId: "proc_first",
      timestamp: "2026-07-23T13:00:00.000Z",
    }),
  );
  startFileBackedProcessV3(
    ledgerPath,
    {
      companyHint: "Later Company",
      runner: "codex",
      sourceRef: "fixture:later",
    },
    deterministicStartOptions({
      attemptId: "attempt_later",
      processId: "proc_later",
      timestamp: "2026-07-23T13:10:00.000Z",
    }),
  );
  const finalLog = readLogV3(ledgerPath);

  assert.equal(searchProcessesV3(finalLog, "Needle")[0].process.id, "proc_first");
  assert.equal(
    searchProcessesV3(finalLog, "https://www.example.test/about")[0].process.id,
    "proc_first",
  );
  assert.deepEqual(
    searchProcessesV3(finalLog, "").map((result) => result.process.id),
    ["proc_later", "proc_first"],
  );
  assert.equal(searchCompaniesV3(finalLog, "Экзампл")[0].company.id, "company_example");
});

test("v3 start stores processes in ascending instant order across ISO offsets", (t) => {
  const log = emptyV3Log();
  log.updated_at = "2026-07-23T07:00:00.000Z";
  const ledgerPath = tempLedger(t, log);

  startFileBackedProcessV3(
    ledgerPath,
    {
      runner: "codex",
      sourceRef: "fixture:offset-first",
    },
    deterministicStartOptions({
      attemptId: "attempt_offset_first",
      processId: "proc_offset_first",
      timestamp: "2026-07-23T10:00:00.000+02:00",
    }),
  );
  startFileBackedProcessV3(
    ledgerPath,
    {
      runner: "codex",
      sourceRef: "fixture:offset-second",
    },
    deterministicStartOptions({
      attemptId: "attempt_offset_second",
      processId: "proc_offset_second",
      timestamp: "2026-07-23T09:00:00.000Z",
    }),
  );

  assert.deepEqual(
    readLogV3(ledgerPath).processes.map(({ id }) => id),
    ["proc_offset_first", "proc_offset_second"],
  );
});

test("v3 start breaks equal-instant process ordering ties by stable id", (t) => {
  const ledgerPath = tempLedger(t);
  const timestamp = "2026-07-23T13:00:00.000Z";
  for (const [processId, suffix] of [
    ["proc_z", "z"],
    ["proc_a", "a"],
  ]) {
    startFileBackedProcessV3(
      ledgerPath,
      {
        runner: "codex",
        sourceRef: `fixture:equal-instant-${suffix}`,
      },
      deterministicStartOptions({
        attemptId: `attempt_equal_instant_${suffix}`,
        processId,
        timestamp,
      }),
    );
  }
  const log = readLogV3(ledgerPath);
  assert.deepEqual(
    log.processes.map(({ id }) => id),
    ["proc_a", "proc_z"],
  );
  assert.deepEqual(
    searchProcessesV3(log, "").map(({ process }) => process.id),
    ["proc_z", "proc_a"],
  );
});

test("every record mutation routes through the shared root-monotonic clock guard", () => {
  const source = readFileSync(resolve(repoRoot, "tools/lib/process-log-v3-lifecycle.mjs"), "utf8");
  const routedCalls =
    source.match(/(?<!function )recordMutationTimestamp\(clock, log, record\)/g) ?? [];
  assert.equal(routedCalls.length, 16);
  assert.equal(source.match(/mutationTimestamp\(clock, log\.updated_at\)/g)?.length, 1);
  assert.doesNotMatch(source, /mutationTimestamp\(clock, record\.updated_at\)/);
  assert.match(
    source,
    /function recordMutationTimestamp\(clock, log, record\) \{\s*return mutationTimestamp\(clock, log\.updated_at, record\.updated_at\);\s*\}/,
  );
});

test("the shared guard rejects every historical process mutation and permits file-backed targets", () => {
  const log = createValidV3Log();
  const before = structuredClone(log);

  assert.deepEqual(historicalProcessMutationOperations, EXPECTED_HISTORICAL_MUTATION_OPERATIONS);

  for (const operation of historicalProcessMutationOperations) {
    assert.throws(
      () => getFileBackedProcessForMutation(log, "proc_historical_001", operation),
      (error) => error.code === "historical_process_read_only" && error.message.includes(operation),
    );
  }
  assert.equal(
    getFileBackedProcessForMutation(log, "proc_file_backed_001", "update").id,
    "proc_file_backed_001",
  );
  assert.deepEqual(log, before);
});

test("parallel v3 starts share the locked writer and preserve every temporary-ledger process", async (t) => {
  const ledgerPath = tempLedger(t);
  const attempts = 12;
  const results = await Promise.all(
    Array.from({ length: attempts }, (_, index) =>
      runV3StartChild(ledgerPath, `parallel-v3-start:${index}`),
    ),
  );

  assertStartChildrenSucceeded(results);
  const log = readLogV3(ledgerPath);
  assert.equal(log.processes.length, attempts);
  assert.equal(new Set(log.processes.map((record) => record.id)).size, attempts);
  assert.equal(
    new Set(log.processes.map((record) => record.steps.get_vacancy.active_attempt.id)).size,
    attempts,
  );
  assert.ok(results.every((result) => JSON.parse(result.stdout).status === "created"));
});

test("parallel v3 starts for one source create once and return duplicate metadata", async (t) => {
  const ledgerPath = tempLedger(t);
  const attempts = 10;
  const results = await Promise.all(
    Array.from({ length: attempts }, () =>
      runV3StartChild(ledgerPath, "parallel-v3-duplicate:same"),
    ),
  );

  assertStartChildrenSucceeded(results);
  const statuses = results.map((result) => JSON.parse(result.stdout).status);
  assert.equal(statuses.filter((status) => status === "created").length, 1);
  assert.equal(statuses.filter((status) => status === "duplicate").length, attempts - 1);
  assert.equal(readLogV3(ledgerPath).processes.length, 1);
});

test("parallel starts with colliding tracking identities create once and report every loser ambiguous", async (t) => {
  // The parameter is one version 2 still strips. With a meaningful one these ten references are ten
  // postings after the cutover, which is the case the sibling below pins.
  const ledgerPath = tempLedger(t);
  const attempts = 10;
  const results = await Promise.all(
    Array.from({ length: attempts }, (_, index) =>
      runV3StartChild(ledgerPath, `https://example.test/jobs/parallel-collision?trk=${index}`),
    ),
  );

  assertStartChildrenSucceeded(results);
  const payloads = results.map((result) => JSON.parse(result.stdout));
  assert.equal(payloads.filter((result) => result.status === "created").length, 1);
  const duplicates = payloads.filter((result) => result.status === "duplicate");
  assert.equal(duplicates.length, attempts - 1);
  assert.ok(
    duplicates.every(
      (result) =>
        result.collision?.status === "ambiguous" &&
        result.collision.matches[0].witnesses.includes("trk"),
    ),
  );
  assert.equal(readLogV3(ledgerPath).processes.length, 1);
});

test("parallel starts with distinct meaningful identities create one process each", async (t) => {
  const ledgerPath = tempLedger(t);
  const attempts = 10;
  const results = await Promise.all(
    Array.from({ length: attempts }, (_, index) =>
      runV3StartChild(ledgerPath, `https://example.test/jobs/parallel-meaningful?query=${index}`),
    ),
  );

  assertStartChildrenSucceeded(results);
  const payloads = results.map((result) => JSON.parse(result.stdout));
  assert.equal(payloads.filter((result) => result.status === "created").length, attempts);
  assert.equal(readLogV3(ledgerPath).processes.length, attempts);
});
