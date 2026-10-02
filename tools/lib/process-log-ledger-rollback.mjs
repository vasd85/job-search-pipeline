import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  normalizeSourceRefForVersion,
  validateLogV3,
  withLogV3Lock,
} from "./process-log-core.mjs";
import { ProcessLogLifecycleError } from "./process-log-v3-lifecycle.mjs";

// Rollback of the source-key cutover, as ADR 0013 defines it: not a release revert. The affected
// artifact is the single ledger, and once one record carries a version 2 key, reverting to code
// whose canonicality is an equality against version 1 makes that record non-canonical — which fails
// the whole file at load rather than degrading one record. So the order is: stop, restore the ledger
// from a backup taken immediately before the computed version changed, then revert the code.
//
// The ADR states the precondition in prose. This module is where it is measured, because a
// precondition nobody can check is a sentence rather than a gate.
export const ledgerBackupBasenamePattern =
  /^process-log\.backup-[0-9a-zA-Z][0-9a-zA-Z._-]{0,63}\.json$/;
const restoreConfirmationPattern = /^[0-9a-f]{64}$/;

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// The backup lives beside the ledger and is named, not chosen: a caller-supplied path would be one
// more place a rollback could write, and the operational root is the only place this belongs.
function resolveBackupPath(logPath, backupFile) {
  const name = String(backupFile ?? "").trim();
  if (
    !name
    || name !== basename(name)
    || !ledgerBackupBasenamePattern.test(name)
  ) {
    throw new ProcessLogLifecycleError(
      "invalid_ledger_backup_name",
      "backup file must be a basename matching process-log.backup-<label>.json",
    );
  }
  return resolve(dirname(resolve(logPath)), name);
}

function boundedFileErrorCode(error) {
  const code = error?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code)
    ? code
    : "UNKNOWN";
}

// Reported by `backup-ledger` as well as by the restore review, and that is the point rather than a
// convenience: the cutover takes its backup after the source update, because the command does not
// exist on the release it leaves. What makes that moment equivalent is that no process has started
// under version 2 yet — and an operator who was interrupted between the two steps has no way to
// know that from a digest. So the backup says, at the moment it is taken, whether the code a
// rollback reverts to could read it back. It reports rather than refuses: the file is written
// either way, and after the first post-cutover `start` no backup can be a rollback target at all.
function versionOneReadability(log) {
  const problems = versionOneReadabilityProblems(log);
  return {
    backup_readable_by_version_1_code: problems.length === 0,
    backup_version_1_problem_count: problems.length,
    backup_version_1_problems: problems.slice(0, versionOneProblemLimit),
  };
}

export function backupProcessLogV3(logPath, { backupFile }, { lockOptions } = {}) {
  const backupPath = resolveBackupPath(logPath, backupFile);
  return withLogV3Lock(logPath, ({ log }) => {
    // The lock has already read and validated the ledger, so a file that does not load never
    // becomes a rollback target: that is a second problem, not a backup. Re-reading the bytes under
    // the same lock is safe because the lock serialises every writer.
    const bytes = readFileSync(logPath);
    try {
      writeFileSync(backupPath, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      const causeCode = boundedFileErrorCode(error);
      if (causeCode !== "EEXIST") {
        // A half-written backup that stays on disk makes the retry fail with "already exists" and
        // leaves the operator holding an unusable rollback target under a reassuring name.
        try {
          unlinkSync(backupPath);
        } catch {
          // Nothing to clean up, or nothing that can be cleaned up; the throw below is the report.
        }
      }
      throw new ProcessLogLifecycleError(
        causeCode === "EEXIST"
          ? "ledger_backup_exists"
          : "ledger_backup_write_failed",
        causeCode === "EEXIST"
          ? "a backup with this name already exists and is never overwritten"
          : `the ledger backup could not be written (${causeCode})`,
      );
    }
    return {
      status: "backed_up",
      backup_file: basename(backupPath),
      backup_bytes: bytes.byteLength,
      backup_sha256: sha256Hex(bytes),
      record_count: log.processes.length,
      ...versionOneReadability(log),
    };
  }, lockOptions);
}

function readBackupLog(backupPath) {
  let bytes;
  let descriptor = null;
  try {
    // O_NOFOLLOW, for the same reason the input-file transport uses it: the write path is confined
    // to the ledger directory by a basename pattern, and a symlink planted under a matching name
    // would otherwise let the read path restore bytes from outside the operational root while the
    // payload still reports an in-root basename.
    descriptor = openSync(backupPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    bytes = readFileSync(descriptor);
  } catch (error) {
    throw new ProcessLogLifecycleError(
      "ledger_backup_read_failed",
      `the ledger backup could not be read (${boundedFileErrorCode(error)})`,
    );
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // The bytes are already read; a failing close is not a rollback decision.
      }
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ProcessLogLifecycleError(
      "ledger_backup_invalid_json",
      "the ledger backup is not valid JSON",
    );
  }
  try {
    validateLogV3(parsed);
  } catch {
    throw new ProcessLogLifecycleError(
      "ledger_backup_invalid",
      "the ledger backup does not load under the current reader",
    );
  }
  return { bytes, log: parsed };
}

// Whether the code this rollback reverts to can read the backup. That code enforces **two** rules
// this one no longer does, and a backup can satisfy either alone:
//
//   1. canonicality as an equality against version 1 — every stored key is its version 1 key;
//   2. the duplicate-group invariant over the **stored** key, with no grandfather clause.
//
// The second is not theoretical after the cutover. Duplicate lookup now compares computed keys, so
// `start` on a reference whose version 2 key differs from a legacy record's computed key writes an
// unlinked record that nevertheless shares that record's stored key. Every stored key in such a
// ledger is still its own version 1 key, so rule 1 alone reports it readable while the reverted
// code fails the whole file on load — the exact outage this procedure exists to prevent, delivered
// through its own gate.
//
// The stored-key grouping below is a deliberate copy of what the reverted code does, not a call
// into `duplicateSourceKeyGroupErrors`: that function groups by the computed key and carries the
// clause this repository added at the cutover, and the code being reverted to has neither.
const versionOneProblemLimit = 20;

function versionOneReadabilityProblems(backupLog) {
  const problems = [];
  const records = backupLog.processes;
  for (const record of records) {
    let versionOneKey;
    try {
      versionOneKey = normalizeSourceRefForVersion(record.source_ref, 1);
    } catch {
      problems.push(`${record.id}: source_ref does not normalize`);
      continue;
    }
    if (record.source_key !== versionOneKey) {
      problems.push(`${record.id}: stored key is not the version 1 key`);
    }
  }

  const byStoredKey = new Map();
  for (const record of records) {
    if (typeof record?.source_key !== "string") continue;
    const group = byStoredKey.get(record.source_key) ?? [];
    group.push(record);
    byStoredKey.set(record.source_key, group);
  }
  for (const [storedKey, group] of byStoredKey) {
    if (group.length < 2) continue;
    const groupIds = new Set(group.map((record) => record.id));
    for (const record of group.slice(1)) {
      if (!record.duplicate_of || !groupIds.has(record.duplicate_of)) {
        problems.push(
          `${record.id}: stored key ${storedKey} would need a duplicate_of inside its stored-key group`,
        );
      }
    }
  }
  return problems;
}

// A rollback discards every change made after the backup, not only the records that were added. A
// step that advanced, a publication that committed, a company term that was learned: all of them go
// back too, and an operator who is only told about new records is being told half of it. The ledger
// is the company search registry as well as the process ledger, and `write` replaces the whole root.
function compareById(current, backup) {
  const currentById = new Map(current.map((record) => [record.id, record]));
  const backupById = new Map(backup.map((record) => [record.id, record]));
  return {
    dropped: [...currentById.keys()].filter((id) => !backupById.has(id)).sort(),
    modified: [...currentById.keys()]
      .filter((id) => backupById.has(id)
        && JSON.stringify(currentById.get(id)) !== JSON.stringify(backupById.get(id)))
      .sort(),
    reappearing: [...backupById.keys()].filter((id) => !currentById.has(id)).sort(),
  };
}

// `updated_at` is deliberately not compared: it moves with every write, so every restore would be
// divergent on it and the word would stop meaning anything. Every other root field is a decision
// somebody made — `duplicate_policy` most of all — and the restore replaces it.
const comparedRootFields = Object.freeze(["duplicate_policy", "schema_version"]);

function buildRestorePlan(log, backup) {
  const processes = compareById(log.processes, backup.log.processes);
  const companies = compareById(log.companies, backup.log.companies);
  const changedRootFields = comparedRootFields.filter(
    (field) => JSON.stringify(log[field]) !== JSON.stringify(backup.log[field]),
  );
  const readability = versionOneReadability(backup.log);
  const versionOneProblems = versionOneReadabilityProblems(backup.log);
  const divergence = [
    processes.dropped,
    processes.modified,
    processes.reappearing,
    companies.dropped,
    companies.modified,
    companies.reappearing,
    changedRootFields,
    versionOneProblems,
  ];
  return {
    backup_sha256: sha256Hex(backup.bytes),
    backup_bytes: backup.bytes.byteLength,
    backup_record_count: backup.log.processes.length,
    ledger_record_count: log.processes.length,
    // Bounded output, with the count beside it: a truncated list that did not say it was truncated
    // could hide the only leg that mattered.
    ...readability,
    dropped_processes: processes.dropped,
    modified_processes: processes.modified,
    reappearing_processes: processes.reappearing,
    dropped_companies: companies.dropped,
    modified_companies: companies.modified,
    reappearing_companies: companies.reappearing,
    changed_root_fields: changedRootFields,
    // Every divergence counts, including records the backup brings back: a restore that resurrects
    // what the ledger no longer has is still a change nobody asked for by name. The word is
    // `divergent` rather than `lossy` because one of the legs loses nothing — a backup the reverted
    // code cannot read is a bad rollback target even when the two files hold the same records.
    rollback: divergence.every((entries) => entries.length === 0) ? "clean" : "divergent",
  };
}

function restoreConfirmationTokenFor(plan, ledgerSha256) {
  return createHash("sha256").update(JSON.stringify({
    backup_sha256: plan.backup_sha256,
    dropped_companies: plan.dropped_companies,
    dropped_processes: plan.dropped_processes,
    ledger_sha256: ledgerSha256,
    modified_companies: plan.modified_companies,
    modified_processes: plan.modified_processes,
    changed_root_fields: plan.changed_root_fields,
    reappearing_companies: plan.reappearing_companies,
    reappearing_processes: plan.reappearing_processes,
    rollback: plan.rollback,
    version_1_problems: plan.backup_version_1_problems,
  })).digest("hex");
}

export function restoreProcessLogV3(
  logPath,
  { backupFile, confirmationToken = null },
  { lockOptions } = {},
) {
  const backupPath = resolveBackupPath(logPath, backupFile);
  if (
    confirmationToken !== null
    && (
      typeof confirmationToken !== "string"
      || !restoreConfirmationPattern.test(confirmationToken)
    )
  ) {
    throw new ProcessLogLifecycleError(
      "invalid_ledger_restore_input",
      "confirmationToken must be null or a lowercase SHA-256 token",
    );
  }

  return withLogV3Lock(logPath, ({ log, write }) => {
    const backup = readBackupLog(backupPath);
    const ledgerSha256 = sha256Hex(readFileSync(logPath));
    const plan = buildRestorePlan(log, backup);
    const token = restoreConfirmationTokenFor(plan, ledgerSha256);
    const result = {
      backup_file: basename(backupPath),
      ledger_sha256: ledgerSha256,
      ...plan,
      confirmation_token: token,
    };
    if (confirmationToken === null) {
      return { status: "review_required", ...result };
    }
    if (confirmationToken !== token) {
      // Fail closed on the exact pair of files the review saw. A token that survived a change to
      // either side would confirm a plan nobody read.
      throw new ProcessLogLifecycleError(
        "ledger_restore_confirmation_mismatch",
        "the confirmation no longer matches this ledger and backup",
      );
    }
    write(backup.log);
    // The writer validates what it writes and re-serializes it, so the content is the backup's by
    // construction and only the formatting can differ — a backup in any other JSON layout restores
    // to equal content in different bytes. Report which of the two happened instead of printing a
    // digest nobody compares. There is deliberately no post-write content check: it could only fire
    // after the ledger was already replaced, so it would report a failure it could not prevent.
    const restoredSha256 = sha256Hex(readFileSync(logPath));
    return {
      status: "restored",
      ...result,
      restored_sha256: restoredSha256,
      restored_bytes_match_backup: restoredSha256 === plan.backup_sha256,
    };
  }, lockOptions);
}
