import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fileSystem, {
  existsSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { backupProcessLogV3 } from "../tools/lib/process-log-ledger-rollback.mjs";
import {
  normalizeSourceRefForVersion,
  sourceKeyPolicyVersions,
  validateLog,
  validateLogV3,
} from "../tools/lib/process-log-core.mjs";
import {
  createHistoricalV2Log,
  createValidV3Log,
} from "./fixtures/process-log-v3.mjs";
import {
  createDisposableWorkspace,
  disposableWorkspaceEnv,
} from "./fixtures/disposable-workspace.mjs";

// The cutover ADR 0013 decided, exercised where the audit reproduced the defect: through the
// production CLI rather than through a unit call. A unit call proves the normalizer; only the CLI
// proves that starting the second posting no longer collides with the first.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(repoRoot, "tests/fixtures/process-log-cli-child.mjs");

function emptyLedger() {
  return {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: "2026-08-01T08:00:00.000Z",
    companies: [],
    processes: [],
  };
}

function createEnvironment(t, ledger = emptyLedger()) {
  return createDisposableWorkspace(t, {
    ledger,
    prefix: "job-search-source-key-v2-",
  });
}

function runCli(environment, ...args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...disposableWorkspaceEnv(environment),
    },
  });
}

function startProcess(environment, sourceRef) {
  const result = runCli(environment, "start", "--source-ref", sourceRef, "--runner", "claude-code");
  return { ...result, payload: JSON.parse(result.stdout) };
}

test("two postings that differ only in a meaningful parameter start as two processes", (t) => {
  // CORE-03, reproduced by ADR 0013 on the frozen base: `query`, `refid`, `source` and `tab` are how
  // several job boards address a posting, and version 1 stripped all four. The second start exited 2
  // with `status: "duplicate"` and the only way forward recorded two different vacancies as
  // duplicates of each other.
  for (const parameter of ["query", "refid", "source", "tab"]) {
    const environment = createEnvironment(t);
    const first = startProcess(
      environment,
      `https://boards.example.test/jobs/1?${parameter}=alpha`,
    );
    assert.equal(first.status, 0, `${parameter}: ${first.stderr}`);
    assert.equal(first.payload.status, "created", parameter);

    const second = startProcess(
      environment,
      `https://boards.example.test/jobs/1?${parameter}=beta`,
    );
    assert.equal(second.status, 0, `${parameter}: ${second.stderr}`);
    assert.equal(second.payload.status, "created", parameter);
    assert.notEqual(second.payload.process.id, first.payload.process.id, parameter);
    assert.equal(
      second.payload.process.source_key,
      `https://boards.example.test/jobs/1?${parameter}=beta`,
      parameter,
    );
    assert.equal(
      first.payload.process.source_key,
      `https://boards.example.test/jobs/1?${parameter}=alpha`,
      parameter,
    );
    // No collision evidence either: the two references are not a collision after the cutover, they
    // are two postings.
    assert.equal(second.payload.collision, undefined, parameter);
  }
});

test("a tracking parameter still collapses onto one key, and the control stays a duplicate", (t) => {
  // The other half of the reproduction. Version 2 is a refinement, not a retreat: everything it
  // still strips must still collide, or the census's merge leg and the duplicate guard would both
  // be arguing about a policy nobody applies.
  for (const parameter of ["utm_source", "trk", "trackingid", "hhtmfrom", "alternatechannel"]) {
    const environment = createEnvironment(t);
    const first = startProcess(
      environment,
      `https://boards.example.test/jobs/2?${parameter}=alpha`,
    );
    assert.equal(first.status, 0, `${parameter}: ${first.stderr}`);
    assert.equal(first.payload.status, "created", parameter);
    assert.equal(
      first.payload.process.source_key,
      "https://boards.example.test/jobs/2",
      parameter,
    );

    const second = startProcess(
      environment,
      `https://boards.example.test/jobs/2?${parameter}=beta`,
    );
    assert.equal(second.status, 2, `${parameter}: ${second.stderr}`);
    assert.equal(second.payload.status, "duplicate", parameter);
    assert.deepEqual(
      second.payload.matches.map((record) => record.id),
      [first.payload.process.id],
      parameter,
    );
  }
});

// A reference whose two policy keys differ: version 1 strips `query` and `trk`, version 2 strips
// only `trk`. Every membership case below rests on that difference, so it is asserted rather than
// assumed.
const splitReference = "https://boards.example.test/jobs/7?query=sdet&trk=abc";

function historicalRecordWithReference(log, { sourceKey, sourceRef }) {
  const record = log.processes.find((candidate) => candidate.id === "proc_historical_001");
  record.source_ref = sourceRef;
  record.source_key = sourceKey;
  return log;
}

test("a stored key is canonical when any accepted policy version derives it, and only then", () => {
  const versionOneKey = normalizeSourceRefForVersion(splitReference, 1);
  const versionTwoKey = normalizeSourceRefForVersion(splitReference, 2);
  // Non-vacuity: if the two versions agreed on this reference, every case below would pass while
  // proving that canonicality is still an equality.
  assert.equal(versionOneKey, "https://boards.example.test/jobs/7");
  assert.equal(versionTwoKey, "https://boards.example.test/jobs/7?query=sdet");
  assert.deepEqual([...sourceKeyPolicyVersions], [1, 2]);

  for (const storedKey of [versionOneKey, versionTwoKey]) {
    assert.doesNotThrow(
      () => validateLogV3(historicalRecordWithReference(createValidV3Log(), {
        sourceKey: storedKey,
        sourceRef: splitReference,
      })),
      storedKey,
    );
    assert.doesNotThrow(
      () => validateLog(historicalRecordWithReference(createHistoricalV2Log(), {
        sourceKey: storedKey,
        sourceRef: splitReference,
      })),
      storedKey,
    );
  }

  // Membership over the accepted versions, not over any plausible normalization: a key that no
  // accepted version produces is still refused by both readers. The verbatim reference is exactly
  // such a key — it is what a policy that stripped nothing would store.
  assert.throws(
    () => validateLogV3(historicalRecordWithReference(createValidV3Log(), {
      sourceKey: splitReference,
      sourceRef: splitReference,
    })),
    /processes\[0\]\.source_key is not canonical/,
  );
  assert.throws(
    () => validateLog(historicalRecordWithReference(createHistoricalV2Log(), {
      sourceKey: splitReference,
      sourceRef: splitReference,
    })),
    /processes\[0\]\.source_key is not canonical/,
  );
});

test("two records that share a key must still be linked, whichever version wrote the key", () => {
  for (const storedKey of [
    normalizeSourceRefForVersion(splitReference, 1),
    normalizeSourceRefForVersion(splitReference, 2),
  ]) {
    const unlinked = historicalRecordWithReference(createValidV3Log(), {
      sourceKey: storedKey,
      sourceRef: splitReference,
    });
    const twin = structuredClone(unlinked.processes[0]);
    twin.id = "proc_historical_002";
    twin.output_dir = "output/example-labs-qa-twin";
    twin.duplicate_of = null;
    unlinked.processes.splice(1, 0, twin);
    assert.throws(
      () => validateLogV3(unlinked),
      /duplicate source_key .* must be linked with duplicate_of/,
      storedKey,
    );

    const linked = structuredClone(unlinked);
    linked.processes[1].duplicate_of = "proc_historical_001";
    assert.doesNotThrow(() => validateLogV3(linked), storedKey);
  }
});

function legacyHistoricalRecord({ id, sourceRef, sourceKey, duplicateOf = null }) {
  return {
    id,
    started_at: "2026-08-01T07:00:00.000Z",
    source_ref: sourceRef,
    source_key: sourceKey,
    company_id: null,
    company_observed: null,
    company_hint: null,
    role: null,
    runner: "claude-ai-web",
    output_dir: null,
    status: "started",
    duplicate_of: duplicateOf,
  };
}

function splitHistoricalGroup() {
  // One stored key, three references, and the links the historical importer builds: every member
  // points at the group's first record. Under version 2 the group separates into `alpha` alone and
  // `beta` twice, so the `beta` that is not first in its new group points outside it.
  const storedKey = "https://boards.example.test/jobs/9";
  return {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: "2026-08-01T08:00:00.000Z",
    companies: [],
    processes: [
      legacyHistoricalRecord({
        id: "proc_group_alpha",
        sourceRef: `${storedKey}?query=alpha`,
        sourceKey: storedKey,
      }),
      legacyHistoricalRecord({
        id: "proc_group_beta_first",
        sourceRef: `${storedKey}?query=beta`,
        sourceKey: storedKey,
        duplicateOf: "proc_group_alpha",
      }),
      legacyHistoricalRecord({
        id: "proc_group_beta_second",
        sourceRef: `${storedKey}?query=beta`,
        sourceKey: storedKey,
        duplicateOf: "proc_group_alpha",
      }),
    ],
  };
}

test("a link the split leaves pointing outside its new group keeps the ledger loading", () => {
  // The case the ADR's row 15 does not state and the census does report as a broken link. Refusing
  // it would fail the whole file on load, and for a historical corpus — immutable by rule — nothing
  // could ever repair it.
  const log = splitHistoricalGroup();
  assert.doesNotThrow(() => validateLogV3(log));

  // Non-vacuity: the members really do separate, and the pair that stays together really is a group
  // of two whose second member points at a record outside it.
  const projected = log.processes.map(
    (record) => normalizeSourceRefForVersion(record.source_ref, 2),
  );
  assert.deepEqual(projected, [
    "https://boards.example.test/jobs/9?query=alpha",
    "https://boards.example.test/jobs/9?query=beta",
    "https://boards.example.test/jobs/9?query=beta",
  ]);

  // The grandfather clause is a clause, not an exemption: an unlinked member of the same group is
  // still refused, and so is a link to a record that shares neither key.
  const unlinked = splitHistoricalGroup();
  unlinked.processes[2].duplicate_of = null;
  assert.throws(
    () => validateLogV3(unlinked),
    /duplicate source_key https:\/\/boards\.example\.test\/jobs\/9\?query=beta must be linked/,
  );

  const strangerLink = splitHistoricalGroup();
  strangerLink.processes.unshift(legacyHistoricalRecord({
    id: "proc_group_stranger",
    sourceRef: "https://boards.example.test/jobs/10",
    sourceKey: "https://boards.example.test/jobs/10",
  }));
  strangerLink.processes[3].duplicate_of = "proc_group_stranger";
  assert.throws(
    () => validateLogV3(strangerLink),
    /duplicate source_key https:\/\/boards\.example\.test\/jobs\/9\?query=beta must be linked/,
  );

  // The legacy reader enforces the same invariant on the old shape, and the migrator reads old
  // shapes through it. It moved with the same edit and would otherwise be pinned by nothing.
  const asSchemaTwo = (log) => ({ ...structuredClone(log), schema_version: 2 });
  assert.doesNotThrow(() => validateLog(asSchemaTwo(splitHistoricalGroup())));
  assert.throws(
    () => validateLog(asSchemaTwo(unlinked)),
    /duplicate source_key https:\/\/boards\.example\.test\/jobs\/9\?query=beta must be linked/,
  );
  assert.throws(
    () => validateLog(asSchemaTwo(strangerLink)),
    /duplicate source_key https:\/\/boards\.example\.test\/jobs\/9\?query=beta must be linked/,
  );
});

function ledgerWithLegacyGroup() {
  const log = splitHistoricalGroup();
  log.processes = log.processes.slice(0, 2);
  return log;
}

function backupPathFor(environment, name) {
  return resolve(environment.workspaceRoot, name);
}

test("backup-ledger copies the exact bytes once and refuses to overwrite", (t) => {
  const environment = createEnvironment(t, ledgerWithLegacyGroup());
  const ledgerBefore = readFileSync(environment.ledgerPath);
  const name = "process-log.backup-before-source-key-v2.json";

  const backup = runCli(environment, "backup-ledger", "--backup-file", name);
  assert.equal(backup.status, 0, backup.stderr);
  const payload = JSON.parse(backup.stdout);
  assert.equal(payload.status, "backed_up");
  assert.equal(payload.backup_file, name);
  assert.equal(payload.record_count, 2);
  // The backup is the ledger, byte for byte, and the ledger is untouched by taking one.
  const copied = readFileSync(backupPathFor(environment, name));
  assert.equal(copied.equals(ledgerBefore), true);
  assert.equal(payload.backup_sha256, createHash("sha256").update(ledgerBefore).digest("hex"));
  assert.equal(readFileSync(environment.ledgerPath).equals(ledgerBefore), true);

  // A second backup under the same name would silently replace the only rollback target there is.
  const repeated = runCli(environment, "backup-ledger", "--backup-file", name);
  assert.equal(repeated.status, 1);
  assert.equal(JSON.parse(repeated.stderr).error.code, "ledger_backup_exists");
  assert.equal(readFileSync(backupPathFor(environment, name)).equals(ledgerBefore), true);

  for (const rejected of [
    "backup.json",
    "../process-log.backup-escape.json",
    "process-log.backup-nested/../../escape.json",
  ]) {
    const result = runCli(environment, "backup-ledger", "--backup-file", rejected);
    assert.equal(result.status, 1, rejected);
    assert.equal(
      JSON.parse(result.stderr).error.code,
      "invalid_ledger_backup_name",
      rejected,
    );
  }
});

test("restore-ledger reviews a clean rollback before it performs one", (t) => {
  const environment = createEnvironment(t, ledgerWithLegacyGroup());
  const name = "process-log.backup-clean.json";
  const taken = runCli(environment, "backup-ledger", "--backup-file", name);
  // The positive direction of the same signal: a ledger that still holds only version 1 keys is a
  // rollback target, and the command says so before anything depends on it.
  assert.equal(taken.status, 0, taken.stderr);
  assert.equal(JSON.parse(taken.stdout).backup_readable_by_version_1_code, true);
  assert.equal(JSON.parse(taken.stdout).backup_version_1_problem_count, 0);
  const ledgerBefore = readFileSync(environment.ledgerPath);

  const review = runCli(environment, "restore-ledger", "--backup-file", name, "--dry-run");
  assert.equal(review.status, 0, review.stderr);
  const plan = JSON.parse(review.stdout);
  assert.equal(plan.status, "review_required");
  assert.equal(plan.rollback, "clean");
  // Both halves of the ADR's precondition, measured rather than asserted: nothing is lost, and the
  // code this rollback reverts to can read what it restores.
  assert.deepEqual(plan.dropped_processes, []);
  assert.deepEqual(plan.modified_processes, []);
  assert.equal(plan.backup_readable_by_version_1_code, true);
  assert.match(plan.confirmation_token, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(environment.ledgerPath).equals(ledgerBefore), true);

  const wrongToken = runCli(
    environment,
    "restore-ledger",
    "--backup-file",
    name,
    "--confirmation-token",
    "f".repeat(64),
  );
  assert.equal(wrongToken.status, 1);
  assert.equal(
    JSON.parse(wrongToken.stderr).error.code,
    "ledger_restore_confirmation_mismatch",
  );
  assert.equal(readFileSync(environment.ledgerPath).equals(ledgerBefore), true);

  const restored = runCli(
    environment,
    "restore-ledger",
    "--backup-file",
    name,
    "--confirmation-token",
    plan.confirmation_token,
  );
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).status, "restored");
  assert.equal(readFileSync(environment.ledgerPath).equals(ledgerBefore), true);
});

test("restore-ledger names every record a rollback would discard, and fails the stale token", (t) => {
  const environment = createEnvironment(t, ledgerWithLegacyGroup());
  const name = "process-log.backup-lossy.json";
  assert.equal(runCli(environment, "backup-ledger", "--backup-file", name).status, 0);

  // The case the ADR names: a process started against the new version after the backup was taken.
  // Restoring without removing it is not a rollback but data loss, so it has to be confirmed by
  // name rather than waved through.
  const started = startProcess(environment, "https://boards.example.test/jobs/after-backup?query=x");
  assert.equal(started.payload.status, "created");
  assert.equal(
    started.payload.process.source_key,
    "https://boards.example.test/jobs/after-backup?query=x",
  );

  const review = runCli(environment, "restore-ledger", "--backup-file", name, "--dry-run");
  assert.equal(review.status, 2, review.stderr);
  const plan = JSON.parse(review.stdout);
  assert.equal(plan.rollback, "divergent");
  assert.deepEqual(plan.dropped_processes, [started.payload.process.id]);
  assert.equal(plan.backup_readable_by_version_1_code, true);

  // Anything that moves between the review and the confirmation invalidates the token: the plan the
  // operator read is not the plan that would be executed.
  const secondStart = startProcess(
    environment,
    "https://boards.example.test/jobs/after-review?query=y",
  );
  assert.equal(secondStart.payload.status, "created");
  const stale = runCli(
    environment,
    "restore-ledger",
    "--backup-file",
    name,
    "--confirmation-token",
    plan.confirmation_token,
  );
  assert.equal(stale.status, 1);
  assert.equal(
    JSON.parse(stale.stderr).error.code,
    "ledger_restore_confirmation_mismatch",
  );

  const secondReview = JSON.parse(
    runCli(environment, "restore-ledger", "--backup-file", name, "--dry-run").stdout,
  );
  assert.deepEqual(secondReview.dropped_processes, [
    started.payload.process.id,
    secondStart.payload.process.id,
  ].sort());
  const restored = runCli(
    environment,
    "restore-ledger",
    "--backup-file",
    name,
    "--confirmation-token",
    secondReview.confirmation_token,
  );
  assert.equal(restored.status, 0, restored.stderr);
  const afterRollback = JSON.parse(readFileSync(environment.ledgerPath, "utf8"));
  assert.deepEqual(
    afterRollback.processes.map((record) => record.id),
    ["proc_group_alpha", "proc_group_beta_first"],
  );
  // The whole point of the precondition: every stored key that survives the rollback is a version 1
  // key, so the code the operator reverts to next can still load the file.
  for (const record of afterRollback.processes) {
    assert.equal(
      record.source_key,
      normalizeSourceRefForVersion(record.source_ref, 1),
      record.id,
    );
  }
});

test("a backup taken after the cutover is reported as one the reverted code cannot read", (t) => {
  const environment = createEnvironment(t);
  const started = startProcess(environment, "https://boards.example.test/jobs/post?query=z");
  assert.equal(started.payload.status, "created");
  const name = "process-log.backup-too-late.json";
  // The backup command says so at the moment it is taken, which is the only moment the operator can
  // still act on it: the file is written (status stays `backed_up`), and the exit code carries the
  // condition.
  const taken = runCli(environment, "backup-ledger", "--backup-file", name);
  assert.equal(taken.status, 2, taken.stderr);
  const takenPayload = JSON.parse(taken.stdout);
  assert.equal(takenPayload.status, "backed_up");
  assert.equal(takenPayload.backup_readable_by_version_1_code, false);
  assert.equal(takenPayload.backup_version_1_problem_count, 1);

  const review = runCli(environment, "restore-ledger", "--backup-file", name, "--dry-run");
  // Nothing is dropped and nothing is modified — this backup is the ledger — and it is still not a
  // rollback target, because restoring it and then reverting the code leaves a file that no longer
  // loads. Reporting it as clean is the exact failure the ADR calls the most likely to be waved
  // through.
  assert.equal(review.status, 2, review.stderr);
  const plan = JSON.parse(review.stdout);
  assert.equal(plan.rollback, "divergent");
  assert.deepEqual(plan.dropped_processes, []);
  assert.deepEqual(plan.modified_processes, []);
  assert.equal(plan.backup_readable_by_version_1_code, false);
});

test("restore-ledger refuses a backup that does not load, and never touches the ledger", (t) => {
  const environment = createEnvironment(t, ledgerWithLegacyGroup());
  const ledgerBefore = readFileSync(environment.ledgerPath);
  const broken = "process-log.backup-broken.json";
  writeFileSync(backupPathFor(environment, broken), "{ not json", "utf8");
  const missing = "process-log.backup-missing.json";
  const invalid = "process-log.backup-invalid.json";
  const invalidLog = ledgerWithLegacyGroup();
  invalidLog.processes[0].source_key = "https://boards.example.test/jobs/not-derived";
  writeFileSync(
    backupPathFor(environment, invalid),
    `${JSON.stringify(invalidLog, null, 2)}\n`,
    "utf8",
  );

  for (const [name, code] of [
    [broken, "ledger_backup_invalid_json"],
    [missing, "ledger_backup_read_failed"],
    [invalid, "ledger_backup_invalid"],
  ]) {
    const result = runCli(environment, "restore-ledger", "--backup-file", name, "--dry-run");
    assert.equal(result.status, 1, name);
    assert.equal(JSON.parse(result.stderr).error.code, code, name);
  }
  assert.equal(readFileSync(environment.ledgerPath).equals(ledgerBefore), true);

  const conflicting = runCli(
    environment,
    "restore-ledger",
    "--backup-file",
    broken,
    "--dry-run",
    "--confirmation-token",
    "a".repeat(64),
  );
  assert.equal(conflicting.status, 1);
  assert.equal(JSON.parse(conflicting.stderr).error.code, "invalid_cli_arguments");
});

test("a rollback names the records it would rewind and the ones it would bring back", (t) => {
  // A rollback discards more than the records that were added. This ledger has one record whose
  // role was set after the backup was taken, and the backup itself carries a record the ledger no
  // longer has, so both directions of the comparison are exercised.
  const environment = createEnvironment(t, ledgerWithLegacyGroup());
  const name = "process-log.backup-divergent.json";
  const withExtra = ledgerWithLegacyGroup();
  withExtra.processes.push(legacyHistoricalRecord({
    id: "proc_group_removed",
    sourceRef: "https://boards.example.test/jobs/removed?query=gone",
    sourceKey: "https://boards.example.test/jobs/removed",
  }));
  writeFileSync(
    backupPathFor(environment, name),
    `${JSON.stringify(withExtra, null, 2)}\n`,
    "utf8",
  );

  const started = startProcess(environment, "https://boards.example.test/jobs/live?query=now");
  assert.equal(started.payload.status, "created");
  const updated = runCli(
    environment,
    "update",
    "--id",
    started.payload.process.id,
    "--role",
    "Senior SDET",
  );
  assert.equal(updated.status, 0, updated.stderr);

  const secondBackup = "process-log.backup-divergent-2.json";
  // Taken after a post-cutover start, so it is deliberately not a rollback target: exit 2 with the
  // file written. This case is about what the restore review says, not about that.
  assert.equal(runCli(environment, "backup-ledger", "--backup-file", secondBackup).status, 2);
  const roleChange = runCli(
    environment,
    "update",
    "--id",
    started.payload.process.id,
    "--role",
    "Staff SDET",
  );
  assert.equal(roleChange.status, 0, roleChange.stderr);

  const divergent = JSON.parse(
    runCli(environment, "restore-ledger", "--backup-file", name, "--dry-run").stdout,
  );
  assert.equal(divergent.rollback, "divergent");
  assert.deepEqual(divergent.dropped_processes, [started.payload.process.id]);
  assert.deepEqual(divergent.reappearing_processes, ["proc_group_removed"]);
  assert.deepEqual(divergent.modified_processes, []);

  const rewound = JSON.parse(
    runCli(environment, "restore-ledger", "--backup-file", secondBackup, "--dry-run").stdout,
  );
  assert.deepEqual(rewound.modified_processes, [started.payload.process.id]);
  assert.deepEqual(rewound.dropped_processes, []);
  assert.deepEqual(rewound.reappearing_processes, []);
  // A record whose step state moved is still the same record: only `modified_processes` can say
  // that the rollback rewinds it, and a plan that reported nothing here would read as clean.
  assert.equal(rewound.rollback, "divergent");
});

test("a backup the reverted code could not group is not reported as a rollback target", (t) => {
  // The class a canonicality-only precondition misses. After the cutover, duplicate lookup compares
  // computed keys, so starting a reference whose version 2 key differs from a legacy record's
  // computed key writes an unlinked record that still shares that record's *stored* key. Every
  // stored key here is its own version 1 key, so the canonicality leg passes — and the code this
  // rollback reverts to groups by the stored key without the cutover's grandfather clause, fails
  // that group, and refuses to load the whole file.
  const environment = createEnvironment(t, {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: "2026-08-01T08:00:00.000Z",
    companies: [],
    processes: [
      legacyHistoricalRecord({
        id: "proc_legacy_meaningful",
        sourceRef: "https://boards.example.test/jobs/11?query=z",
        sourceKey: "https://boards.example.test/jobs/11",
      }),
    ],
  });
  const started = startProcess(environment, "https://boards.example.test/jobs/11?utm_source=a");
  assert.equal(started.payload.status, "created");
  assert.equal(started.payload.process.duplicate_of, null);
  assert.equal(
    started.payload.process.source_key,
    "https://boards.example.test/jobs/11",
    "the new record shares the legacy record's stored key without sharing its computed key",
  );

  const name = "process-log.backup-ungroupable.json";
  const taken = runCli(environment, "backup-ledger", "--backup-file", name);
  assert.equal(taken.status, 2, taken.stderr);
  assert.equal(JSON.parse(taken.stdout).backup_readable_by_version_1_code, false);
  const review = runCli(environment, "restore-ledger", "--backup-file", name, "--dry-run");
  assert.equal(review.status, 2, review.stderr);
  const plan = JSON.parse(review.stdout);
  assert.equal(plan.rollback, "divergent");
  assert.equal(plan.backup_readable_by_version_1_code, false);
  // Every stored key really is its version 1 key: the verdict comes from the group rule alone, and
  // a precondition that only compared keys would have said "clean".
  assert.deepEqual(plan.dropped_processes, []);
  assert.deepEqual(plan.modified_processes, []);
  assert.equal(plan.backup_version_1_problem_count, 1);
  assert.deepEqual(plan.backup_version_1_problems, [
    `${started.payload.process.id}: stored key https://boards.example.test/jobs/11`
    + " would need a duplicate_of inside its stored-key group",
  ]);
});

test("a long list of version 1 problems is bounded, and says how many it did not print", (t) => {
  // Truncation that does not announce itself is how the one entry that mattered disappears. The
  // records below share a version 1 key and no computed key, so they load here and would fail the
  // reverted code's grouping twenty-one times over.
  const sharedStoredKey = "https://boards.example.test/jobs/13";
  const environment = createEnvironment(t, {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: "2026-08-01T08:00:00.000Z",
    companies: [],
    processes: Array.from({ length: 22 }, (_, index) => legacyHistoricalRecord({
      id: `proc_legacy_bulk_${String(index).padStart(2, "0")}`,
      sourceRef: `${sharedStoredKey}?query=${index}`,
      sourceKey: sharedStoredKey,
    })),
  });
  const name = "process-log.backup-many-problems.json";
  const taken = runCli(environment, "backup-ledger", "--backup-file", name);
  assert.equal(taken.status, 2, taken.stderr);
  assert.equal(JSON.parse(taken.stdout).backup_version_1_problem_count, 21);
  assert.equal(JSON.parse(taken.stdout).backup_version_1_problems.length, 20);

  const plan = JSON.parse(
    runCli(environment, "restore-ledger", "--backup-file", name, "--dry-run").stdout,
  );
  assert.equal(plan.backup_readable_by_version_1_code, false);
  assert.equal(plan.backup_version_1_problem_count, 21);
  assert.equal(plan.backup_version_1_problems.length, 20);
  assert.equal(plan.rollback, "divergent");
});

test("a rollback that only changes the company registry is not reported as clean", (t) => {
  // The ledger is the company search registry as well as the process ledger, and a restore replaces
  // the whole root. A plan that only reads `processes` would call this rollback clean and destroy
  // the terms and domains learned since the backup without naming one of them.
  const environment = createEnvironment(t, ledgerWithLegacyGroup());
  const name = "process-log.backup-companies.json";
  assert.equal(runCli(environment, "backup-ledger", "--backup-file", name).status, 0);

  const created = runCli(
    environment,
    "create-company",
    "--display-name",
    "Example Labs",
    "--domain",
    "example-labs.test",
  );
  assert.equal(created.status, 0, created.stderr);
  const companyId = JSON.parse(created.stdout).company.id;

  const afterCreate = JSON.parse(
    runCli(environment, "restore-ledger", "--backup-file", name, "--dry-run").stdout,
  );
  assert.equal(afterCreate.rollback, "divergent");
  assert.deepEqual(afterCreate.dropped_companies, [companyId]);
  assert.deepEqual(afterCreate.dropped_processes, []);

  const second = "process-log.backup-companies-2.json";
  assert.equal(runCli(environment, "backup-ledger", "--backup-file", second).status, 0);
  const termed = runCli(
    environment,
    "add-company-term",
    "--id",
    companyId,
    "--term",
    "ExampleLabs GmbH",
  );
  assert.equal(termed.status, 0, termed.stderr);
  const afterTerm = JSON.parse(
    runCli(environment, "restore-ledger", "--backup-file", second, "--dry-run").stdout,
  );
  assert.equal(afterTerm.rollback, "divergent");
  assert.deepEqual(afterTerm.modified_companies, [companyId]);
  assert.deepEqual(afterTerm.dropped_companies, []);
  assert.deepEqual(afterTerm.modified_processes, []);
});

test("a restore whose backup carries a record the ledger lost is confirmed, not assumed", (t) => {
  const environment = createEnvironment(t, ledgerWithLegacyGroup());
  const name = "process-log.backup-reappearing-only.json";
  const withExtra = ledgerWithLegacyGroup();
  withExtra.processes.push(legacyHistoricalRecord({
    id: "proc_group_extra",
    sourceRef: "https://boards.example.test/jobs/12?query=extra",
    sourceKey: "https://boards.example.test/jobs/12",
  }));
  writeFileSync(
    backupPathFor(environment, name),
    `${JSON.stringify(withExtra, null, 2)}\n`,
    "utf8",
  );

  const review = runCli(environment, "restore-ledger", "--backup-file", name, "--dry-run");
  assert.equal(review.status, 2, review.stderr);
  const plan = JSON.parse(review.stdout);
  assert.deepEqual(plan.dropped_processes, []);
  assert.deepEqual(plan.modified_processes, []);
  assert.deepEqual(plan.reappearing_processes, ["proc_group_extra"]);
  assert.equal(plan.rollback, "divergent");

  const restored = runCli(
    environment,
    "restore-ledger",
    "--backup-file",
    name,
    "--confirmation-token",
    plan.confirmation_token,
  );
  assert.equal(restored.status, 0, restored.stderr);
  const payload = JSON.parse(restored.stdout);
  assert.equal(payload.status, "restored");
  // The backup was hand-written rather than produced by `backup-ledger`, so the writer's own
  // serialization is what lands on disk. The content survives; the bytes need not, and the payload
  // says which of the two happened instead of printing a digest nobody compares.
  assert.equal(payload.restored_bytes_match_backup, true);
  assert.deepEqual(
    JSON.parse(readFileSync(environment.ledgerPath, "utf8")).processes.map((record) => record.id),
    ["proc_group_alpha", "proc_group_beta_first", "proc_group_extra"],
  );
});

test("a symlinked backup name is refused rather than read through", (t) => {
  const environment = createEnvironment(t, ledgerWithLegacyGroup());
  const outside = resolve(environment.workspaceRoot, "outside-the-root.json");
  writeFileSync(outside, `${JSON.stringify(ledgerWithLegacyGroup(), null, 2)}\n`, "utf8");
  const name = "process-log.backup-symlinked.json";
  symlinkSync(outside, backupPathFor(environment, name));

  const review = runCli(environment, "restore-ledger", "--backup-file", name, "--dry-run");
  assert.equal(review.status, 1, review.stdout);
  assert.equal(JSON.parse(review.stderr).error.code, "ledger_backup_read_failed");
});

test("identity lookup finds a pre-cutover process by the reference, not by its stored key", (t) => {
  // The record class that matters operationally: an in-flight file-backed process started before
  // the cutover. It is built the only way a real one exists — started by the CLI, then re-keyed in
  // the fixture to the version 1 key the pre-cutover module would have written.
  const environment = createEnvironment(t);
  const started = startProcess(environment, "https://boards.example.test/jobs/probe?query=alpha");
  assert.equal(started.payload.status, "created");
  const ledger = JSON.parse(readFileSync(environment.ledgerPath, "utf8"));
  const record = ledger.processes.find(
    (candidate) => candidate.id === started.payload.process.id,
  );
  record.source_key = normalizeSourceRefForVersion(record.source_ref, 1);
  assert.equal(record.source_key, "https://boards.example.test/jobs/probe");
  assert.notEqual(record.source_key, normalizeSourceRefForVersion(record.source_ref, 2));
  writeFileSync(environment.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  // Mixed-version ledgers load: this record's stored key is canonical by membership even though the
  // module computes the other version.
  assert.equal(runCli(environment, "validate").status, 0);

  // Duplicate lookup: the same posting must be recognised through the reference the caller holds,
  // even though the stored key no longer equals the key that reference computes.
  const restarted = startProcess(environment, "https://boards.example.test/jobs/probe?query=alpha");
  assert.equal(restarted.status, 2, restarted.stderr);
  assert.equal(restarted.payload.status, "duplicate");
  assert.deepEqual(
    restarted.payload.matches.map((match) => match.id),
    [record.id],
  );

  // Selector resolution: the reference resolves, the stored key on its own does not — it is the key
  // of a posting nobody is holding any more.
  const resolvedByReference = runCli(
    environment,
    "resolve",
    "--source-ref",
    "https://boards.example.test/jobs/probe?query=alpha",
  );
  assert.equal(resolvedByReference.status, 0, resolvedByReference.stderr);
  assert.equal(JSON.parse(resolvedByReference.stdout).process.id, record.id);

  const resolvedByStoredKey = runCli(
    environment,
    "resolve",
    "--source-ref",
    "https://boards.example.test/jobs/probe",
  );
  assert.equal(resolvedByStoredKey.status, 1, resolvedByStoredKey.stdout);
  assert.equal(JSON.parse(resolvedByStoredKey.stderr).error.code, "process_not_found");

  // And a different posting on the same path is neither a duplicate of it nor resolvable to it.
  const sibling = startProcess(environment, "https://boards.example.test/jobs/probe?query=beta");
  assert.equal(sibling.status, 0, sibling.stderr);
  assert.equal(sibling.payload.status, "created");
  assert.equal(runCli(environment, "validate", "--deep").status, 0);
});

test("a company the backup would bring back is named, and counts as divergence", (t) => {
  const environment = createEnvironment(t, ledgerWithLegacyGroup());
  const name = "process-log.backup-company-reappearing.json";
  const withCompany = ledgerWithLegacyGroup();
  withCompany.companies.push({
    id: "company_removed_example",
    display_name: "Removed Example",
    search_terms: ["Removed Example"],
    domains: ["removed-example.test"],
  });
  writeFileSync(
    backupPathFor(environment, name),
    `${JSON.stringify(withCompany, null, 2)}\n`,
    "utf8",
  );

  const review = runCli(environment, "restore-ledger", "--backup-file", name, "--dry-run");
  assert.equal(review.status, 2, review.stderr);
  const plan = JSON.parse(review.stdout);
  assert.deepEqual(plan.reappearing_companies, ["company_removed_example"]);
  assert.deepEqual(plan.dropped_companies, []);
  assert.deepEqual(plan.dropped_processes, []);
  assert.deepEqual(plan.modified_processes, []);
  assert.equal(plan.rollback, "divergent");
});

test("backup-ledger reports a write it could not perform, and leaves nothing behind", (t) => {
  // The one path the disposable filesystem cannot produce on its own: the write itself failing for
  // a reason other than the name already existing. Both halves matter — the typed code, and that a
  // half-written file is removed rather than left to make the retry say "already exists".
  const environment = createEnvironment(t, ledgerWithLegacyGroup());
  const name = "process-log.backup-write-fails.json";
  const backupPath = backupPathFor(environment, name);
  const originalWriteFileSync = fileSystem.writeFileSync.bind(fileSystem);
  t.mock.method(
    fileSystem,
    "writeFileSync",
    (targetPath, ...rest) => {
      if (targetPath === backupPath) {
        originalWriteFileSync(targetPath, "partial", "utf8");
        throw Object.assign(new Error("synthetic storage failure"), { code: "ENOSPC" });
      }
      return originalWriteFileSync(targetPath, ...rest);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => backupProcessLogV3(environment.ledgerPath, { backupFile: name }),
      (error) => error.code === "ledger_backup_write_failed",
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(existsSync(backupPath), false, "a partial backup must not survive its own failure");

  // And the name is free again, so the retry is a backup rather than a report about the last one.
  const retried = runCli(environment, "backup-ledger", "--backup-file", name);
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(JSON.parse(retried.stdout).status, "backed_up");
});

test("a root field the rollback would revert is named, and counts as divergence", (t) => {
  // `restore-ledger` replaces the whole root, not only its two arrays. `duplicate_policy` is a
  // decision somebody made; reverting it under `clean` would be the same silence the company legs
  // were fixed for.
  const environment = createEnvironment(t, ledgerWithLegacyGroup());
  const name = "process-log.backup-root-fields.json";
  const withOtherPolicy = ledgerWithLegacyGroup();
  withOtherPolicy.duplicate_policy = "new-attempt";
  writeFileSync(
    backupPathFor(environment, name),
    `${JSON.stringify(withOtherPolicy, null, 2)}\n`,
    "utf8",
  );

  const plan = JSON.parse(
    runCli(environment, "restore-ledger", "--backup-file", name, "--dry-run").stdout,
  );
  assert.deepEqual(plan.changed_root_fields, ["duplicate_policy"]);
  assert.deepEqual(plan.dropped_processes, []);
  assert.deepEqual(plan.modified_processes, []);
  assert.deepEqual(plan.dropped_companies, []);
  assert.equal(plan.rollback, "divergent");

  // `updated_at` moves with every write, so comparing it would make every restore divergent and the
  // word would stop meaning anything.
  const timestampOnly = "process-log.backup-timestamp-only.json";
  const withOtherTimestamp = ledgerWithLegacyGroup();
  withOtherTimestamp.updated_at = "2026-08-01T09:30:00.000Z";
  writeFileSync(
    backupPathFor(environment, timestampOnly),
    `${JSON.stringify(withOtherTimestamp, null, 2)}\n`,
    "utf8",
  );
  const timestampPlan = JSON.parse(
    runCli(environment, "restore-ledger", "--backup-file", timestampOnly, "--dry-run").stdout,
  );
  assert.deepEqual(timestampPlan.changed_root_fields, []);
  assert.equal(timestampPlan.rollback, "clean");
});
