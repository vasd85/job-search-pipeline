import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import {
  readLogV3,
  validateLogV3,
} from "../tools/lib/process-log-core.mjs";
import {
  linkFileBackedProcessCompanyV3,
  resolveFileBackedProcessV3,
  startFileBackedProcessV3,
  updateFileBackedProcessV3,
} from "../tools/lib/process-log-v3-lifecycle.mjs";
import {
  createHistoricalV2Log,
  createValidV3Log,
} from "./fixtures/process-log-v3.mjs";
import { createDisposableWorkspace } from "./fixtures/disposable-workspace.mjs";

const mutationTimestamp = "2026-07-23T14:00:00.000Z";

function emptyV3Log() {
  return {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: "2026-07-23T12:00:00.000Z",
    companies: [
      {
        id: "company_identity_fixture",
        display_name: "Identity Fixture",
        search_terms: ["Identity Fixture"],
        domains: ["identity.test"],
      },
    ],
    processes: [],
  };
}

function historicalOnlyV3Log() {
  const log = createHistoricalV2Log();
  log.schema_version = 4;
  return log;
}

function tempLedger(t, log = emptyV3Log()) {
  return createDisposableWorkspace(t, {
    ledger: log,
    prefix: "job-search-process-log-v3-identity-",
  }).ledgerPath;
}

function createRunningProcess(ledgerPath, {
  companyHint = "Initial Hint",
  processId = "proc_identity_001",
  sourceRef = "https://identity.test/jobs/sdet",
} = {}) {
  return startFileBackedProcessV3(
    ledgerPath,
    {
      companyHint,
      runner: "codex",
      sourceRef,
    },
    {
      attemptIdFactory: () => `attempt_${processId}`,
      clock: () => "2026-07-23T13:00:00.000Z",
      processIdFactory: () => processId,
    },
  ).process;
}

test("guarded v3 update writes exact identity fields and both update timestamps", (t) => {
  const ledgerPath = tempLedger(t);
  const created = createRunningProcess(ledgerPath);
  const stepsBefore = structuredClone(created.steps);
  const companiesBefore = structuredClone(readLogV3(ledgerPath).companies);
  const result = updateFileBackedProcessV3(
    ledgerPath,
    {
      processId: created.id,
      companyObserved: "Observed Company",
      companyHint: "Search Hint",
      role: "Senior SDET",
    },
    { clock: () => mutationTimestamp },
  );
  const log = readLogV3(ledgerPath);
  const updated = log.processes[0];

  assert.equal(result.status, "updated");
  assert.equal(updated.company_observed, "Observed Company");
  assert.equal(updated.company_hint, "Search Hint");
  assert.equal(updated.role, "Senior SDET");
  assert.equal(updated.updated_at, mutationTimestamp);
  assert.equal(log.updated_at, mutationTimestamp);
  assert.deepEqual(updated.steps, stepsBefore);
  assert.deepEqual(log.companies, companiesBefore);
});

test("record mutation cannot move the ledger root clock backward", (t) => {
  const log = emptyV3Log();
  const ledgerPath = tempLedger(t, log);
  const created = createRunningProcess(ledgerPath);
  const advanced = readLogV3(ledgerPath);
  advanced.updated_at = "2026-07-23T13:30:00.000Z";
  advanced.processes[0].updated_at = "2026-07-23T13:25:00.000Z";
  writeFileSync(ledgerPath, `${JSON.stringify(advanced, null, 2)}\n`, "utf8");
  const before = readFileSync(ledgerPath, "utf8");

  assert.throws(
    () => updateFileBackedProcessV3(
      ledgerPath,
      { processId: created.id, companyHint: "Later hint" },
      { clock: () => "2026-07-23T13:27:00.000Z" },
    ),
    (error) => error.code === "invalid_mutation_timestamp",
  );
  assert.equal(readFileSync(ledgerPath, "utf8"), before);

  const equalBoundary = updateFileBackedProcessV3(
    ledgerPath,
    { processId: created.id, companyHint: "Exact boundary hint" },
    { clock: () => "2026-07-23T13:30:00.000Z" },
  );
  assert.equal(equalBoundary.status, "updated");
  const after = readLogV3(ledgerPath);
  assert.equal(after.updated_at, "2026-07-23T13:30:00.000Z");
  assert.equal(after.processes[0].updated_at, "2026-07-23T13:30:00.000Z");
});

test("v3 update supports explicit hint clearing and same-value byte idempotency", (t) => {
  const ledgerPath = tempLedger(t);
  const created = createRunningProcess(ledgerPath);
  updateFileBackedProcessV3(
    ledgerPath,
    {
      processId: created.id,
      companyHint: null,
      role: "Senior SDET",
    },
    { clock: () => mutationTimestamp },
  );
  const before = readFileSync(ledgerPath, "utf8");
  const result = updateFileBackedProcessV3(
    ledgerPath,
    {
      processId: created.id,
      companyHint: null,
      role: "Senior SDET",
    },
    {
      clock: () => {
        throw new Error("idempotent update must not request a timestamp");
      },
    },
  );

  assert.equal(result.status, "unchanged");
  assert.equal(result.process.company_hint, null);
  assert.equal(readFileSync(ledgerPath, "utf8"), before);
});

test("published identity is frozen while exact no-ops and hint-only updates remain allowed", (t) => {
  const ledgerPath = tempLedger(t, createValidV3Log());
  const processId = "proc_file_backed_001";
  const initialBytes = readFileSync(ledgerPath, "utf8");

  assert.throws(
    () => updateFileBackedProcessV3(
      ledgerPath,
      {
        processId,
        companyObserved: "Drifted Company",
        role: "Drifted Role",
      },
    ),
    (error) => error.code === "identity_update_not_authorized",
  );
  assert.equal(readFileSync(ledgerPath, "utf8"), initialBytes);

  const unchanged = updateFileBackedProcessV3(
    ledgerPath,
    {
      processId,
      companyObserved: "Example Labs",
      role: "Senior SDET",
    },
    {
      clock: () => {
        throw new Error("exact identity no-op must not request a timestamp");
      },
    },
  );
  assert.equal(unchanged.status, "unchanged");
  assert.equal(readFileSync(ledgerPath, "utf8"), initialBytes);

  const hintOnly = updateFileBackedProcessV3(
    ledgerPath,
    {
      processId,
      companyObserved: "Example Labs",
      companyHint: "Updated Search Hint",
    },
    { clock: () => mutationTimestamp },
  );
  assert.equal(hintOnly.status, "updated");
  assert.equal(hintOnly.process.company_hint, "Updated Search Hint");

  const beforeMixed = readFileSync(ledgerPath, "utf8");
  assert.throws(
    () => updateFileBackedProcessV3(
      ledgerPath,
      {
        processId,
        companyHint: "Must Not Commit",
        role: "Drifted Role",
      },
    ),
    (error) => error.code === "identity_update_not_authorized",
  );
  assert.equal(readFileSync(ledgerPath, "utf8"), beforeMixed);
});

test("v3 update rejects invalid, missing, and historical targets without changing bytes", (t) => {
  const ledgerPath = tempLedger(t, historicalOnlyV3Log());
  const before = readFileSync(ledgerPath, "utf8");

  assert.throws(
    () => updateFileBackedProcessV3(
      ledgerPath,
      {
        processId: "proc_historical_001",
        role: "Changed Role",
      },
    ),
    (error) => error.code === "historical_process_read_only",
  );
  assert.throws(
    () => updateFileBackedProcessV3(
      ledgerPath,
      {
        processId: "proc_missing",
        role: "Changed Role",
      },
    ),
    (error) => error.code === "process_not_found",
  );
  assert.throws(
    () => updateFileBackedProcessV3(
      ledgerPath,
      {
        processId: "proc_historical_001",
        unsupported: "value",
      },
    ),
    (error) => error.code === "invalid_update_input",
  );
  assert.equal(readFileSync(ledgerPath, "utf8"), before);
});

test("guarded v3 company linking is atomic, idempotent, and preserves the registry", (t) => {
  const ledgerPath = tempLedger(t);
  const created = createRunningProcess(ledgerPath);
  const companyBefore = structuredClone(readLogV3(ledgerPath).companies[0]);
  const result = linkFileBackedProcessCompanyV3(
    ledgerPath,
    {
      processId: created.id,
      companyId: companyBefore.id,
    },
    { clock: () => mutationTimestamp },
  );
  const linkedLog = readLogV3(ledgerPath);

  assert.equal(result.status, "linked");
  assert.equal(linkedLog.processes[0].company_id, companyBefore.id);
  assert.equal(linkedLog.processes[0].updated_at, mutationTimestamp);
  assert.equal(linkedLog.updated_at, mutationTimestamp);
  assert.deepEqual(linkedLog.companies[0], companyBefore);

  const beforeIdempotentLink = readFileSync(ledgerPath, "utf8");
  const repeated = linkFileBackedProcessCompanyV3(
    ledgerPath,
    {
      processId: created.id,
      companyId: companyBefore.id,
    },
    {
      clock: () => {
        throw new Error("idempotent link must not request a timestamp");
      },
    },
  );
  assert.equal(repeated.status, "unchanged");
  assert.equal(readFileSync(ledgerPath, "utf8"), beforeIdempotentLink);
});

test("v3 company linking rejects unknown companies and historical processes byte-safely", (t) => {
  const fileBackedPath = tempLedger(t);
  const created = createRunningProcess(fileBackedPath);
  const fileBackedBefore = readFileSync(fileBackedPath, "utf8");
  assert.throws(
    () => linkFileBackedProcessCompanyV3(
      fileBackedPath,
      {
        processId: created.id,
        companyId: "company_missing",
      },
    ),
    (error) => error.code === "company_not_found",
  );
  assert.equal(readFileSync(fileBackedPath, "utf8"), fileBackedBefore);

  const historicalPath = tempLedger(t, historicalOnlyV3Log());
  const historicalBefore = readFileSync(historicalPath, "utf8");
  assert.throws(
    () => linkFileBackedProcessCompanyV3(
      historicalPath,
      {
        processId: "proc_historical_001",
        companyId: "company_example_labs",
      },
    ),
    (error) => error.code === "historical_process_read_only",
  );
  assert.equal(readFileSync(historicalPath, "utf8"), historicalBefore);
});

test("resolver returns one file-backed process by exact id or normalized source/output selector", () => {
  const log = createValidV3Log();
  const fileBacked = log.processes.find(
    (record) => record.id === "proc_file_backed_001",
  );
  fileBacked.output_dir = "output/café-senior-sdet";
  validateLogV3(log);
  const before = structuredClone(log);

  assert.equal(
    resolveFileBackedProcessV3(log, { id: fileBacked.id }).id,
    fileBacked.id,
  );
  assert.equal(
    resolveFileBackedProcessV3(log, {
      sourceRef: "https://EXAMPLE.test/careers/sdet/?utm_source=fixture",
    }).id,
    fileBacked.id,
  );
  assert.equal(
    resolveFileBackedProcessV3(log, {
      outputDir: "output/cafe\u0301-senior-sdet",
    }).id,
    fileBacked.id,
  );
  assert.deepEqual(log, before);
});

test("resolver fails closed when one key match differs by a parameter version 2 still strips", () => {
  const log = createValidV3Log();
  const fileBacked = log.processes.find((record) => record.id === "proc_file_backed_001");
  const before = structuredClone(log);

  assert.throws(
    () => resolveFileBackedProcessV3(log, {
      sourceRef: "https://example.test/careers/sdet?trk=different-campaign",
    }),
    (error) => error.code === "process_ambiguous"
      && error.message === "process_ambiguous: legacy source-key collision makes sourceRef ambiguous; use an exact process id",
  );
  // A meaningful parameter is not a collision after the cutover, it is a different posting — so the
  // selector reports that it matches nothing rather than resolving onto, or being confused by, the
  // vacancy next to it. Fail-closed in both directions: neither answer is the wrong record.
  assert.throws(
    () => resolveFileBackedProcessV3(log, {
      sourceRef: "https://example.test/careers/sdet?query=different-vacancy",
    }),
    (error) => error.code === "process_not_found",
  );
  assert.equal(
    resolveFileBackedProcessV3(log, {
      sourceRef: "https://EXAMPLE.test/careers/sdet/?utm_source=benign",
    }).id,
    fileBacked.id,
  );
  assert.equal(resolveFileBackedProcessV3(log, { id: fileBacked.id }).id, fileBacked.id);
  assert.equal(
    resolveFileBackedProcessV3(log, { outputDir: fileBacked.output_dir }).id,
    fileBacked.id,
  );
  assert.deepEqual(log, before);
});

test("resolver emits stable selector-conflict, not-found, and ambiguous errors", () => {
  const log = createValidV3Log();
  const fileBacked = log.processes.find((record) => record.id === "proc_file_backed_001");
  const duplicate = structuredClone(fileBacked);
  duplicate.id = "proc_file_backed_002";
  duplicate.started_at = fileBacked.started_at;
  duplicate.updated_at = "2026-07-23T12:40:00.000Z";
  duplicate.output_dir = "output/example-labs-senior-sdet-2";
  duplicate.duplicate_of = "proc_file_backed_001";
  for (const step of Object.values(duplicate.steps)) {
    for (const history of step.attempt_history) {
      if (history.publication_id !== null) {
        history.publication_id = `${history.publication_id}_duplicate`;
      }
    }
  }
  log.processes.push(duplicate);
  log.updated_at = "2026-07-23T12:40:00.000Z";
  validateLogV3(log);

  for (const selector of [
    {},
    {
      id: "proc_file_backed_001",
      outputDir: "output/example-labs-senior-sdet",
    },
    { id: "proc_file_backed_001", unknown: "value" },
  ]) {
    assert.throws(
      () => resolveFileBackedProcessV3(log, selector),
      (error) => error.code === "process_selector_conflict",
    );
  }
  assert.throws(
    () => resolveFileBackedProcessV3(log, { id: "proc_missing" }),
    (error) => error.code === "process_not_found",
  );
  assert.throws(
    () => resolveFileBackedProcessV3(log, {
      sourceRef: "https://example.test/careers/sdet?utm_medium=fixture",
    }),
    (error) => error.code === "process_ambiguous",
  );
});

test("resolver rejects a uniquely selected historical process with the shared read-only code", () => {
  const log = createValidV3Log();

  for (const selector of [
    { id: "proc_historical_001" },
    { sourceRef: "historical-fixture:example" },
    { outputDir: "output/EXAMPLE-LABS-QA" },
  ]) {
    assert.throws(
      () => resolveFileBackedProcessV3(log, selector),
      (error) => error.code === "historical_process_read_only",
    );
  }
});
