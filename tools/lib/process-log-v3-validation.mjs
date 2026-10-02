import {
  validateArray,
  validateBoolean,
  validateEnum,
  validateInteger,
  validateIsoTimestamp,
  validateNullableString,
  validateOutputDir,
  validateRepoRelativePath,
  validateSha256,
  validateStrictObject,
  validateString,
  validateStringArray,
} from "../pipeline-artifacts/validation.mjs";
import {
  processLogDiagnosticLimits,
  processLogDiagnosticProblems,
  processLogStableDiagnosticCodePattern,
} from "./process-log-diagnostics.mjs";

export const PROCESS_LOG_FUTURE_SKEW_MS = 300_000;

const trustedValidationErrorEvidence = new WeakMap();

export class ProcessLogV3ValidationError extends Error {
  constructor(errors) {
    super(`Invalid process log v3:\n- ${errors.join("\n- ")}`);
    this.name = "ProcessLogV3ValidationError";
    this.code = "process_log_validation_failed";
    this.context = "operation=validate_process_log";
    this.recoveryAction = "repair_process_log_schema";
  }
}

class TrustedProcessLogV3ValidationError extends ProcessLogV3ValidationError {
  constructor(errors) {
    super(errors);
    trustedValidationErrorEvidence.set(
      this,
      Object.freeze({
        code: this.code,
        context: this.context,
        recoveryAction: this.recoveryAction,
      }),
    );
  }
}

export function processLogV3ValidationErrorEvidence(error) {
  const evidence = trustedValidationErrorEvidence.get(error);
  return evidence === undefined ? null : { ...evidence };
}

export const fileBackedStepNames = Object.freeze([
  "get_vacancy",
  "research_company",
  "map_experience",
  "generate_cv",
  "write_cover_letter",
]);

export const fileBackedStepDependencies = Object.freeze({
  get_vacancy: Object.freeze([]),
  research_company: Object.freeze(["get_vacancy"]),
  map_experience: Object.freeze(["research_company"]),
  generate_cv: Object.freeze(["map_experience"]),
  write_cover_letter: Object.freeze(["map_experience"]),
});

export const fileBackedStepStates = Object.freeze([
  "pending",
  "running",
  "blocked",
  "failed",
  "completed",
  "stale",
]);

export const fileBackedMaterialStepNames = Object.freeze(["generate_cv", "write_cover_letter"]);

export const fileBackedRevisionChannels = Object.freeze([
  "chat_command",
  "manual_file",
  "docx_sync",
]);

export const fileBackedRevisionSubjectKinds = Object.freeze(["check", "decision"]);

export const fileBackedWaiverStatuses = Object.freeze(["active", "superseded"]);

export const fileBackedAttemptOperations = Object.freeze(["reopen", "retry", "revise"]);

export const fileBackedAdoptionPhases = Object.freeze(["journaled", "staged", "archived"]);

export const PROCESS_LOG_WAIVER_KEY_MAX_BYTES = processLogDiagnosticLimits.detailMaxBytes;
export const PROCESS_LOG_WAIVER_NOTE_MAX_BYTES = processLogDiagnosticLimits.messageMaxBytes;

const TOP_LEVEL_KEYS = [
  "schema_version",
  "duplicate_policy",
  "updated_at",
  "companies",
  "processes",
];
const COMPANY_KEYS = ["id", "display_name", "search_terms", "domains"];
const HISTORICAL_PROCESS_KEYS = [
  "id",
  "started_at",
  "source_ref",
  "source_key",
  "company_id",
  "company_observed",
  "company_hint",
  "role",
  "runner",
  "output_dir",
  "status",
  "duplicate_of",
];
const FILE_BACKED_PROCESS_KEYS = [
  "id",
  "started_at",
  "updated_at",
  "source_ref",
  "source_key",
  "company_id",
  "company_observed",
  "company_hint",
  "role",
  "runner",
  "output_dir",
  "artifact_mode",
  "steps",
  "duplicate_of",
];
const STEP_KEYS = [
  "state",
  "attempt",
  "revision",
  "started_at",
  "updated_at",
  "finished_at",
  "published_inputs",
  "artifacts",
  "active_attempt",
  "publication_transaction",
  "attempt_history",
  "error",
  "blocker",
];
const BUNDLE_ENTRY_KEYS = ["kind", "path", "schema_version", "sha256", "bytes"];
const ACTIVE_ATTEMPT_KEYS = [
  "id",
  "started_at",
  "expected_revision",
  "expected_artifacts",
  "input_snapshot",
];
const ATTEMPT_HISTORY_KEYS = [
  "attempt",
  "outcome",
  "started_at",
  "finished_at",
  "input_snapshot",
  "error_code",
  "publication_id",
];
const MATERIAL_STEP_EXTRA_KEYS = ["waivers", "adoption_base"];
const MATERIAL_ACTIVE_ATTEMPT_EXTRA_KEYS = [
  "operation",
  "channel",
  "pre_attempt_state",
  "pending_waivers",
];
const MATERIAL_ATTEMPT_HISTORY_EXTRA_KEYS = [
  "operation",
  "channel",
  "pre_attempt_state",
  "open_conflicts",
  "archived_artifacts",
];
const MATERIAL_PUBLICATION_TRANSACTION_EXTRA_KEYS = ["operation", "adopted_artifacts"];
const WAIVER_KEYS = ["id", "created_at", "brief_digest", "subject", "status", "note"];
const PENDING_WAIVER_KEYS = ["id", "brief_digest", "subject", "note"];
const WAIVER_SUBJECT_KEYS = ["kind", "key"];
const OPEN_CONFLICT_KEYS = ["subject", "code"];
const ADOPTION_BASE_KEYS = ["id", "created_at", "attempt_id", "publication_id", "phase", "entries"];
const ADOPTION_ENTRY_KEYS = ["kind", "sha256", "bytes"];
const DIAGNOSTIC_KEYS = ["code", "message", "at", "retryable", "details"];
const PUBLICATION_TRANSACTION_KEYS = [
  "id",
  "attempt_id",
  "intended_outcome",
  "prepared_at",
  "old_revision",
  "old_artifacts",
  "new_artifacts",
  "input_snapshot",
  "blocker",
  "files",
];
const PUBLICATION_FILE_KEYS = ["kind", "canonical_path", "candidate_path", "backup_path"];
const ATTEMPT_OUTCOMES = ["completed", "blocked", "failed"];
const PUBLICATION_OUTCOMES = ["completed", "blocked"];
const STABLE_CODE_PATTERN = processLogStableDiagnosticCodePattern;
const KIND_PATTERN = processLogStableDiagnosticCodePattern;
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// `schemaVersion` is the version a publication records; `acceptedSchemaVersions`, when present,
// also admits the older versions already recorded, which a revision may raise to the current one.
const stepArtifactContracts = Object.freeze({
  get_vacancy: new Map([
    ["job_description", { path: "job-description.txt", schemaVersion: null }],
    ["vacancy", { path: "vacancy.json", schemaVersion: 2 }],
  ]),
  research_company: new Map([
    ["company_research", { path: "company-research.json", schemaVersion: 2 }],
  ]),
  map_experience: new Map([
    ["application_brief", { path: "application-brief.json", schemaVersion: 4 }],
  ]),
  generate_cv: new Map([
    ["cv_source", { path: "cv.json", schemaVersion: null }],
    ["cv_docx", { path: null, schemaVersion: null }],
  ]),
  write_cover_letter: new Map([
    ["cover_letter", { path: "cover-letter.txt", schemaVersion: null }],
  ]),
});

export function fileBackedArtifactContractsForStep(stepName) {
  const contracts = stepArtifactContracts[stepName];
  if (!contracts) return [];
  return [...contracts.entries()].map(([kind, contract]) => ({
    kind,
    path: contract.path,
    schema_version: contract.schemaVersion,
  }));
}

function acceptedSchemaVersions(contract) {
  return contract.acceptedSchemaVersions ?? [contract.schemaVersion];
}

/*
 * A revision republishes a kind at the contract's current version, so the committed entry it
 * replaces may carry an older accepted version but never a newer one.
 */
export function fileBackedArtifactSchemaVersionMayBecome(stepName, kind, fromVersion, toVersion) {
  const contract = stepArtifactContracts[stepName]?.get(kind);
  if (!contract) return fromVersion === toVersion;
  if (fromVersion === toVersion) return true;
  return (
    toVersion === contract.schemaVersion && acceptedSchemaVersions(contract).includes(fromVersion)
  );
}

export function isValidProcessLogV3TransactionId(value) {
  return typeof value === "string" && TRANSACTION_ID_PATTERN.test(value);
}

function hasOwn(value, key) {
  return value !== null && typeof value === "object" && Object.hasOwn(value, key);
}

function validateNullableTimestamp(value, path, errors) {
  if (value === null) return null;
  return validateIsoTimestamp(value, path, errors);
}

function validateNullableReferenceId(value, path, errors) {
  if (value === null) return null;
  return validateString(value, path, errors);
}

function validateStableCode(value, path, errors, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  const code = validateString(value, path, errors);
  if (code && !STABLE_CODE_PATTERN.test(code)) {
    errors.push(`${path} must be a lowercase snake_case stable code`);
  }
  if (code && Buffer.byteLength(code, "utf8") > processLogDiagnosticLimits.codeMaxBytes) {
    errors.push(`${path} must be at most ${processLogDiagnosticLimits.codeMaxBytes} UTF-8 bytes`);
  }
  return code;
}

function validateKind(value, path, errors) {
  const kind = validateString(value, path, errors);
  if (kind && !KIND_PATTERN.test(kind)) {
    errors.push(`${path} must be a lowercase snake_case artifact/input kind`);
  }
  return kind;
}

function validateTransactionId(value, path, errors) {
  const id = validateString(value, path, errors);
  if (id && !isValidProcessLogV3TransactionId(id)) {
    errors.push(`${path} must contain only letters, numbers, underscores, and hyphens`);
  }
  return id;
}

function validateNullableTransactionId(value, path, errors) {
  if (value === null) return null;
  return validateTransactionId(value, path, errors);
}

function validateSchemaVersion(value, path, errors) {
  if (value === null) return null;
  return validateInteger(value, path, errors, { min: 1 });
}

function validateBundleEntry(value, path, errors, { artifact = false, stepName = null } = {}) {
  const entry = validateStrictObject(value, path, errors, BUNDLE_ENTRY_KEYS);
  const kind = validateKind(entry.kind, `${path}.kind`, errors);
  const entryPath = validateRepoRelativePath(entry.path, `${path}.path`, errors);
  const schemaVersion = validateSchemaVersion(
    entry.schema_version,
    `${path}.schema_version`,
    errors,
  );
  validateSha256(entry.sha256, `${path}.sha256`, errors);
  validateInteger(entry.bytes, `${path}.bytes`, errors, { min: 1 });

  if (artifact && stepName && stepArtifactContracts[stepName]) {
    const contract = stepArtifactContracts[stepName].get(kind);
    if (!contract) {
      errors.push(`${path}.kind is not owned by step ${stepName}`);
    } else {
      if (contract.path !== null && entryPath !== contract.path) {
        errors.push(`${path}.path must equal ${contract.path} for ${kind}`);
      }
      if (kind === "cv_docx") {
        if (
          typeof entryPath !== "string" ||
          entryPath.includes("/") ||
          entryPath.startsWith(".") ||
          !entryPath.endsWith(".docx")
        ) {
          errors.push(`${path}.path must be a non-hidden .docx basename for cv_docx`);
        }
        const reservedPaths = new Set([
          "job-description.txt",
          "vacancy.json",
          "company-research.json",
          "application-brief.json",
          "cv.json",
          "cover-letter.txt",
        ]);
        if (reservedPaths.has(entryPath)) {
          errors.push(`${path}.path collides with a fixed canonical artifact path`);
        }
      }
      const accepted = acceptedSchemaVersions(contract);
      if (!accepted.includes(schemaVersion)) {
        errors.push(
          accepted.length === 1
            ? `${path}.schema_version must equal ${JSON.stringify(contract.schemaVersion)} for ${kind}`
            : `${path}.schema_version must be one of ${accepted.join(", ")} for ${kind}`,
        );
      }
    }
  }
  return entry;
}

function validateBundleEntries(value, path, errors, options = {}) {
  const entries = validateArray(value, path, errors);
  const kindOwners = new Map();
  const pathOwners = new Map();
  for (const [index, candidate] of entries.entries()) {
    const entryPath = `${path}[${index}]`;
    const entry = validateBundleEntry(candidate, entryPath, errors, options);
    if (typeof entry.kind === "string") {
      const owner = kindOwners.get(entry.kind);
      if (owner !== undefined) errors.push(`${entryPath}.kind duplicates ${path}[${owner}].kind`);
      else kindOwners.set(entry.kind, index);
    }
    if (typeof entry.path === "string") {
      const owner = pathOwners.get(entry.path);
      if (owner !== undefined) errors.push(`${entryPath}.path duplicates ${path}[${owner}].path`);
      else pathOwners.set(entry.path, index);
    }
  }
  return entries;
}

function bundleIdentity(entries) {
  if (!Array.isArray(entries)) return "";
  return JSON.stringify(
    entries
      .map((entry) => ({
        kind: entry?.kind,
        path: entry?.path,
        schema_version: entry?.schema_version,
        sha256: entry?.sha256,
        bytes: entry?.bytes,
      }))
      .sort((left, right) => String(left.kind).localeCompare(String(right.kind))),
  );
}

function validateDiagnostic(value, path, errors) {
  const diagnostic = validateStrictObject(value, path, errors, DIAGNOSTIC_KEYS);
  validateStableCode(diagnostic.code, `${path}.code`, errors);
  const message = validateString(diagnostic.message, `${path}.message`, errors);
  // Same rule as the lifecycle input gate: an explanation, not the code again.
  if (message && message === diagnostic.code) {
    errors.push(`${path}.message must explain the diagnostic, not repeat ${path}.code`);
  }
  validateIsoTimestamp(diagnostic.at, `${path}.at`, errors);
  validateBoolean(diagnostic.retryable, `${path}.retryable`, errors);
  validateStringArray(diagnostic.details, `${path}.details`, errors);
  errors.push(...processLogDiagnosticProblems(diagnostic, path));
  return diagnostic;
}

function validateNullableDiagnostic(value, path, errors) {
  if (value === null) return null;
  return validateDiagnostic(value, path, errors);
}

/*
 * Waiver subject keys and notes reuse the frozen diagnostic text bounds: a key is bounded like a
 * diagnostic detail, a note like a diagnostic message. The remap keeps error paths addressed at
 * the actual field instead of the borrowed diagnostic slot.
 */
function validateWaiverKeyText(value, path, errors) {
  const text = validateString(value, path, errors);
  if (typeof text !== "string" || text.length === 0) return text;
  errors.push(
    ...processLogDiagnosticProblems({ code: "waiver", details: [text] }, path).map((problem) =>
      problem.replace(`${path}.details[0]`, path),
    ),
  );
  return text;
}

function validateWaiverNoteText(value, path, errors) {
  const text = validateString(value, path, errors);
  if (typeof text !== "string" || text.length === 0) return text;
  errors.push(
    ...processLogDiagnosticProblems({ code: "waiver", message: text }, path).map((problem) =>
      problem.replace(`${path}.message`, path),
    ),
  );
  return text;
}

function validateRevisionSubject(value, path, errors) {
  const subject = validateStrictObject(value, path, errors, WAIVER_SUBJECT_KEYS);
  validateEnum(subject.kind, `${path}.kind`, errors, [...fileBackedRevisionSubjectKinds]);
  validateWaiverKeyText(subject.key, `${path}.key`, errors);
  return subject;
}

function validateWaivers(value, path, errors) {
  const waivers = validateArray(value, path, errors);
  const ids = new Set();
  for (const [index, candidate] of waivers.entries()) {
    const itemPath = `${path}[${index}]`;
    const waiver = validateStrictObject(candidate, itemPath, errors, WAIVER_KEYS);
    const id = validateTransactionId(waiver.id, `${itemPath}.id`, errors);
    if (typeof id === "string") {
      if (ids.has(id)) errors.push(`${itemPath}.id is duplicated`);
      ids.add(id);
    }
    validateIsoTimestamp(waiver.created_at, `${itemPath}.created_at`, errors);
    validateSha256(waiver.brief_digest, `${itemPath}.brief_digest`, errors);
    validateRevisionSubject(waiver.subject, `${itemPath}.subject`, errors);
    validateEnum(waiver.status, `${itemPath}.status`, errors, [...fileBackedWaiverStatuses]);
    if (hasOwn(waiver, "note")) {
      validateWaiverNoteText(waiver.note, `${itemPath}.note`, errors);
    }
  }
  return waivers;
}

function validatePendingWaivers(value, path, errors) {
  const waivers = validateArray(value, path, errors);
  const ids = new Set();
  for (const [index, candidate] of waivers.entries()) {
    const itemPath = `${path}[${index}]`;
    const waiver = validateStrictObject(candidate, itemPath, errors, PENDING_WAIVER_KEYS);
    const id = validateTransactionId(waiver.id, `${itemPath}.id`, errors);
    if (typeof id === "string") {
      if (ids.has(id)) errors.push(`${itemPath}.id is duplicated`);
      ids.add(id);
    }
    validateSha256(waiver.brief_digest, `${itemPath}.brief_digest`, errors);
    validateRevisionSubject(waiver.subject, `${itemPath}.subject`, errors);
    if (hasOwn(waiver, "note")) {
      validateWaiverNoteText(waiver.note, `${itemPath}.note`, errors);
    }
  }
  return waivers;
}

function validateOpenConflicts(value, path, errors) {
  const conflicts = validateArray(value, path, errors);
  for (const [index, candidate] of conflicts.entries()) {
    const itemPath = `${path}[${index}]`;
    const conflict = validateStrictObject(candidate, itemPath, errors, OPEN_CONFLICT_KEYS);
    validateRevisionSubject(conflict.subject, `${itemPath}.subject`, errors);
    validateStableCode(conflict.code, `${itemPath}.code`, errors);
  }
  return conflicts;
}

function validateAdoptedArtifactEntries(value, path, errors, stepName) {
  const entries = validateArray(value, path, errors, { min: 1 });
  const kinds = new Set();
  for (const [index, candidate] of entries.entries()) {
    const entryPath = `${path}[${index}]`;
    const entry = validateStrictObject(candidate, entryPath, errors, ADOPTION_ENTRY_KEYS);
    const kind = validateKind(entry.kind, `${entryPath}.kind`, errors);
    if (typeof kind === "string") {
      if (kinds.has(kind)) errors.push(`${entryPath}.kind is duplicated`);
      kinds.add(kind);
      if (stepArtifactContracts[stepName] && !stepArtifactContracts[stepName].has(kind)) {
        errors.push(`${entryPath}.kind is not owned by step ${stepName}`);
      }
    }
    validateSha256(entry.sha256, `${entryPath}.sha256`, errors);
    validateInteger(entry.bytes, `${entryPath}.bytes`, errors, { min: 1 });
  }
  return entries;
}

function validateAdoptionBase(value, path, errors, stepName) {
  if (value === null) return null;
  const base = validateStrictObject(value, path, errors, ADOPTION_BASE_KEYS);
  validateTransactionId(base.id, `${path}.id`, errors);
  validateIsoTimestamp(base.created_at, `${path}.created_at`, errors);
  validateTransactionId(base.attempt_id, `${path}.attempt_id`, errors);
  validateNullableTransactionId(base.publication_id, `${path}.publication_id`, errors);
  validateEnum(base.phase, `${path}.phase`, errors, [...fileBackedAdoptionPhases]);
  validateAdoptedArtifactEntries(base.entries, `${path}.entries`, errors, stepName);
  return base;
}

function validateAttemptHistory(value, path, errors, stepName) {
  const history = validateArray(value, path, errors);
  const material = fileBackedMaterialStepNames.includes(stepName);
  const allowedKeys = material
    ? [...ATTEMPT_HISTORY_KEYS, ...MATERIAL_ATTEMPT_HISTORY_EXTRA_KEYS]
    : ATTEMPT_HISTORY_KEYS;
  for (const [index, candidate] of history.entries()) {
    const itemPath = `${path}[${index}]`;
    const item = validateStrictObject(candidate, itemPath, errors, allowedKeys);
    const attempt = validateInteger(item.attempt, `${itemPath}.attempt`, errors, { min: 1 });
    if (attempt !== index + 1) {
      errors.push(`${itemPath}.attempt must form a contiguous sequence starting at 1`);
    }
    const outcome = validateEnum(item.outcome, `${itemPath}.outcome`, errors, ATTEMPT_OUTCOMES);
    validateIsoTimestamp(item.started_at, `${itemPath}.started_at`, errors);
    validateIsoTimestamp(item.finished_at, `${itemPath}.finished_at`, errors);
    validateBundleEntries(item.input_snapshot, `${itemPath}.input_snapshot`, errors);
    validateStableCode(item.error_code, `${itemPath}.error_code`, errors, { nullable: true });
    const publicationId = validateNullableTransactionId(
      item.publication_id,
      `${itemPath}.publication_id`,
      errors,
    );
    if (outcome === "completed" && item.error_code !== null) {
      errors.push(`${itemPath}.error_code must be null for a completed attempt`);
    }
    if (["blocked", "failed"].includes(outcome) && item.error_code === null) {
      errors.push(`${itemPath}.error_code is required for a ${outcome} attempt`);
    }
    if (["completed", "blocked"].includes(outcome) && publicationId === null) {
      errors.push(`${itemPath}.publication_id is required for a committed ${outcome} attempt`);
    }
    if (outcome === "failed" && publicationId !== null) {
      errors.push(`${itemPath}.publication_id must be null for a failed attempt`);
    }
    if (material) {
      const revising = item.operation === "revise";
      if (hasOwn(item, "operation")) {
        validateEnum(item.operation, `${itemPath}.operation`, errors, [
          ...fileBackedAttemptOperations,
        ]);
      }
      if (revising) {
        validateEnum(item.channel, `${itemPath}.channel`, errors, [...fileBackedRevisionChannels]);
        validateEnum(item.pre_attempt_state, `${itemPath}.pre_attempt_state`, errors, [
          "completed",
          "stale",
        ]);
        if (publicationId !== null && !hasOwn(item, "open_conflicts")) {
          errors.push(
            `${itemPath}.open_conflicts is required for a committed revision publication`,
          );
        }
      } else {
        for (const key of ["channel", "pre_attempt_state", "open_conflicts"]) {
          if (hasOwn(item, key)) {
            errors.push(`${itemPath}.${key} requires operation "revise"`);
          }
        }
      }
      if (hasOwn(item, "open_conflicts")) {
        validateOpenConflicts(item.open_conflicts, `${itemPath}.open_conflicts`, errors);
      }
      if (hasOwn(item, "archived_artifacts")) {
        if (publicationId === null) {
          errors.push(`${itemPath}.archived_artifacts requires a committed publication`);
        }
        const archived = validateBundleEntries(
          item.archived_artifacts,
          `${itemPath}.archived_artifacts`,
          errors,
          { artifact: true, stepName },
        );
        validateCompleteArtifactSet(archived, `${itemPath}.archived_artifacts`, errors, stepName);
      }
    }
  }
  return history;
}

function validateActiveAttempt(value, path, errors, stepName) {
  if (value === null) return null;
  const material = fileBackedMaterialStepNames.includes(stepName);
  const allowedKeys = material
    ? [...ACTIVE_ATTEMPT_KEYS, ...MATERIAL_ACTIVE_ATTEMPT_EXTRA_KEYS]
    : ACTIVE_ATTEMPT_KEYS;
  const active = validateStrictObject(value, path, errors, allowedKeys);
  validateTransactionId(active.id, `${path}.id`, errors);
  validateIsoTimestamp(active.started_at, `${path}.started_at`, errors);
  validateInteger(active.expected_revision, `${path}.expected_revision`, errors, { min: 0 });
  validateBundleEntries(active.expected_artifacts, `${path}.expected_artifacts`, errors);
  validateBundleEntries(active.input_snapshot, `${path}.input_snapshot`, errors);
  if (material) {
    if (hasOwn(active, "operation")) {
      validateEnum(active.operation, `${path}.operation`, errors, [...fileBackedAttemptOperations]);
    }
    if (active.operation === "revise") {
      validateEnum(active.channel, `${path}.channel`, errors, [...fileBackedRevisionChannels]);
      validateEnum(active.pre_attempt_state, `${path}.pre_attempt_state`, errors, [
        "completed",
        "stale",
      ]);
      if (active.expected_revision === 0) {
        errors.push(`${path}.expected_revision must be at least 1 for a revision attempt`);
      }
    } else {
      for (const key of ["channel", "pre_attempt_state"]) {
        if (hasOwn(active, key)) {
          errors.push(`${path}.${key} requires operation "revise"`);
        }
      }
    }
    /*
     * Pending waivers belong to the attempt, not to the revision operation: a first publication of
     * the letter carries the word-limit approval the same way (task 145). The edit channel and the
     * pre-attempt mark above stay revision-only, because only a revision has them.
     */
    if (hasOwn(active, "pending_waivers")) {
      validatePendingWaivers(active.pending_waivers, `${path}.pending_waivers`, errors);
    }
  }
  return active;
}

function validatePublicationFile(value, path, errors, transactionId) {
  const file = validateStrictObject(value, path, errors, PUBLICATION_FILE_KEYS);
  validateKind(file.kind, `${path}.kind`, errors);
  validateRepoRelativePath(file.canonical_path, `${path}.canonical_path`, errors);
  const candidatePath = validateRepoRelativePath(
    file.candidate_path,
    `${path}.candidate_path`,
    errors,
  );
  if (
    transactionId &&
    typeof candidatePath === "string" &&
    !candidatePath.startsWith(`.pipeline-tmp/${transactionId}/`)
  ) {
    errors.push(`${path}.candidate_path must belong to .pipeline-tmp/${transactionId}/`);
  }
  if (file.backup_path !== null) {
    const backupPath = validateRepoRelativePath(file.backup_path, `${path}.backup_path`, errors);
    if (
      transactionId &&
      typeof backupPath === "string" &&
      !backupPath.startsWith(`.pipeline-tmp/${transactionId}/`)
    ) {
      errors.push(`${path}.backup_path must belong to .pipeline-tmp/${transactionId}/`);
    }
  }
  return file;
}

function validatePublicationTransaction(value, path, errors, stepName) {
  if (value === null) return null;
  const material = fileBackedMaterialStepNames.includes(stepName);
  const transaction = validateStrictObject(
    value,
    path,
    errors,
    material
      ? [...PUBLICATION_TRANSACTION_KEYS, ...MATERIAL_PUBLICATION_TRANSACTION_EXTRA_KEYS]
      : PUBLICATION_TRANSACTION_KEYS,
  );
  if (material) {
    if (hasOwn(transaction, "operation")) {
      validateEnum(transaction.operation, `${path}.operation`, errors, ["revise"]);
    }
    if (hasOwn(transaction, "adopted_artifacts")) {
      validateAdoptedArtifactEntries(
        transaction.adopted_artifacts,
        `${path}.adopted_artifacts`,
        errors,
        stepName,
      );
    }
  }
  const id = validateTransactionId(transaction.id, `${path}.id`, errors);
  validateTransactionId(transaction.attempt_id, `${path}.attempt_id`, errors);
  validateEnum(
    transaction.intended_outcome,
    `${path}.intended_outcome`,
    errors,
    PUBLICATION_OUTCOMES,
  );
  validateIsoTimestamp(transaction.prepared_at, `${path}.prepared_at`, errors);
  validateInteger(transaction.old_revision, `${path}.old_revision`, errors, { min: 0 });
  const oldArtifacts = validateBundleEntries(
    transaction.old_artifacts,
    `${path}.old_artifacts`,
    errors,
    { artifact: true, stepName },
  );
  const newArtifacts = validateBundleEntries(
    transaction.new_artifacts,
    `${path}.new_artifacts`,
    errors,
    { artifact: true, stepName },
  );
  if (newArtifacts.length === 0) {
    errors.push(`${path}.new_artifacts must contain at least one artifact`);
  }
  validateBundleEntries(transaction.input_snapshot, `${path}.input_snapshot`, errors);
  const blocker = validateNullableDiagnostic(transaction.blocker, `${path}.blocker`, errors);
  if (transaction.intended_outcome === "blocked" && blocker === null) {
    errors.push(`${path}.blocker is required for a blocked publication`);
  }
  if (transaction.intended_outcome === "completed" && blocker !== null) {
    errors.push(`${path}.blocker must be null for a completed publication`);
  }
  if (blocker !== null && blocker.at !== transaction.prepared_at) {
    errors.push(`${path}.blocker.at must equal prepared_at`);
  }
  const files = validateArray(transaction.files, `${path}.files`, errors, { min: 1 });
  const fileKinds = new Set();
  for (const [index, candidate] of files.entries()) {
    const filePath = `${path}.files[${index}]`;
    const file = validatePublicationFile(candidate, filePath, errors, id);
    if (fileKinds.has(file.kind)) errors.push(`${filePath}.kind is duplicated`);
    fileKinds.add(file.kind);
    const artifact = newArtifacts.find((entry) => entry.kind === file.kind);
    if (!artifact) {
      errors.push(`${filePath}.kind does not resolve to new_artifacts`);
    } else if (file.canonical_path !== artifact.path) {
      errors.push(`${filePath}.canonical_path must match the new artifact path`);
    }
    const oldArtifact = oldArtifacts.find((entry) => entry.kind === file.kind);
    if (oldArtifact && file.backup_path === null) {
      errors.push(`${filePath}.backup_path is required for an existing canonical artifact`);
    } else if (!oldArtifact && file.backup_path !== null) {
      errors.push(`${filePath}.backup_path must be null for a first publication`);
    }
  }
  for (const artifact of newArtifacts) {
    if (!fileKinds.has(artifact.kind)) {
      errors.push(`${path}.files is missing kind ${artifact.kind}`);
    }
  }
  return transaction;
}

function validateCompleteArtifactSet(artifacts, path, errors, stepName) {
  const expectedKinds = [...stepArtifactContracts[stepName].keys()].sort();
  const actualKinds = artifacts.map((entry) => entry.kind).sort();
  if (JSON.stringify(actualKinds) !== JSON.stringify(expectedKinds)) {
    errors.push(`${path} must contain the complete ${stepName} artifact bundle`);
  }
}

function validateStep(value, path, errors, stepName) {
  const material = fileBackedMaterialStepNames.includes(stepName);
  const step = validateStrictObject(
    value,
    path,
    errors,
    material ? [...STEP_KEYS, ...MATERIAL_STEP_EXTRA_KEYS] : STEP_KEYS,
  );
  const state = validateEnum(step.state, `${path}.state`, errors, fileBackedStepStates);
  const attempt = validateInteger(step.attempt, `${path}.attempt`, errors, { min: 0 });
  const revision = validateInteger(step.revision, `${path}.revision`, errors, { min: 0 });
  validateNullableTimestamp(step.started_at, `${path}.started_at`, errors);
  validateNullableTimestamp(step.updated_at, `${path}.updated_at`, errors);
  validateNullableTimestamp(step.finished_at, `${path}.finished_at`, errors);
  const publishedInputs = validateBundleEntries(
    step.published_inputs,
    `${path}.published_inputs`,
    errors,
  );
  const artifacts = validateBundleEntries(step.artifacts, `${path}.artifacts`, errors, {
    artifact: true,
    stepName,
  });
  const activeAttempt = validateActiveAttempt(
    step.active_attempt,
    `${path}.active_attempt`,
    errors,
    stepName,
  );
  const publicationTransaction = validatePublicationTransaction(
    step.publication_transaction,
    `${path}.publication_transaction`,
    errors,
    stepName,
  );
  const history = validateAttemptHistory(
    step.attempt_history,
    `${path}.attempt_history`,
    errors,
    stepName,
  );
  const error = validateNullableDiagnostic(step.error, `${path}.error`, errors);
  const blocker = validateNullableDiagnostic(step.blocker, `${path}.blocker`, errors);
  const waivers =
    material && hasOwn(step, "waivers")
      ? validateWaivers(step.waivers, `${path}.waivers`, errors)
      : [];
  if (material && hasOwn(step, "adoption_base")) {
    validateAdoptionBase(step.adoption_base, `${path}.adoption_base`, errors, stepName);
  }

  if (revision === 0 && artifacts.length > 0) {
    errors.push(`${path}.artifacts must be empty while revision is 0`);
  }
  if (revision > 0 && artifacts.length === 0) {
    errors.push(`${path}.artifacts must be non-empty when revision is greater than 0`);
  }
  if (revision === 0 && publishedInputs.length > 0) {
    errors.push(`${path}.published_inputs must be empty while revision is 0`);
  }
  if (revision > attempt) {
    errors.push(`${path}.revision cannot exceed the attempt number`);
  }
  if (["completed", "stale"].includes(state)) {
    if (revision < 1) errors.push(`${path}.revision must be at least 1 for state ${state}`);
    validateCompleteArtifactSet(artifacts, `${path}.artifacts`, errors, stepName);
  }

  const expectedAttemptCount = history.length + (activeAttempt ? 1 : 0);
  if (attempt !== expectedAttemptCount) {
    errors.push(`${path}.attempt must equal closed attempt history plus the active attempt`);
  }

  if (state === "pending") {
    if (attempt !== 0 || revision !== 0) {
      errors.push(`${path} pending state requires attempt 0 and revision 0`);
    }
    if (
      step.started_at !== null ||
      step.updated_at !== null ||
      step.finished_at !== null ||
      activeAttempt !== null ||
      publicationTransaction !== null ||
      history.length > 0 ||
      error !== null ||
      blocker !== null ||
      (material && (hasOwn(step, "waivers") || hasOwn(step, "adoption_base")))
    ) {
      errors.push(`${path} pending state must be pristine`);
    }
  } else if (state === "running") {
    if (activeAttempt === null) errors.push(`${path}.active_attempt is required while running`);
    if (step.started_at === null || step.updated_at === null) {
      errors.push(`${path} running state requires started_at and updated_at`);
    }
    if (step.finished_at !== null) errors.push(`${path}.finished_at must be null while running`);
    if (error !== null || blocker !== null) {
      errors.push(`${path} running state cannot expose a current error or blocker`);
    }
  } else {
    if (activeAttempt !== null) errors.push(`${path}.active_attempt must be null unless running`);
    if (publicationTransaction !== null) {
      errors.push(`${path}.publication_transaction must be null unless running`);
    }
    if (step.started_at === null || step.updated_at === null || step.finished_at === null) {
      errors.push(`${path} ${state} state requires all step timestamps`);
    }
  }

  if (publicationTransaction !== null && activeAttempt !== null) {
    if (publicationTransaction.attempt_id !== activeAttempt.id) {
      errors.push(`${path}.publication_transaction.attempt_id must match active_attempt.id`);
    }
    if (publicationTransaction.old_revision !== activeAttempt.expected_revision) {
      errors.push(`${path}.publication_transaction.old_revision must match the active baseline`);
    }
    if (
      bundleIdentity(publicationTransaction.old_artifacts) !==
      bundleIdentity(activeAttempt.expected_artifacts)
    ) {
      errors.push(`${path}.publication_transaction.old_artifacts must match the active baseline`);
    }
    if (
      bundleIdentity(publicationTransaction.input_snapshot) !==
      bundleIdentity(activeAttempt.input_snapshot)
    ) {
      errors.push(`${path}.publication_transaction.input_snapshot must match active_attempt`);
    }
  }
  if (activeAttempt !== null) {
    if (activeAttempt.expected_revision !== revision) {
      errors.push(`${path}.active_attempt.expected_revision must match the committed revision`);
    }
    if (bundleIdentity(activeAttempt.expected_artifacts) !== bundleIdentity(artifacts)) {
      errors.push(`${path}.active_attempt.expected_artifacts must match committed artifacts`);
    }
    if (Array.isArray(activeAttempt.pending_waivers) && waivers.length > 0) {
      const journaledWaiverIds = new Set(waivers.map((waiver) => waiver?.id));
      for (const [index, pending] of activeAttempt.pending_waivers.entries()) {
        if (journaledWaiverIds.has(pending?.id)) {
          errors.push(
            `${path}.active_attempt.pending_waivers[${index}].id duplicates a journaled waiver id`,
          );
        }
      }
    }
  }

  if (state === "blocked") {
    if (blocker === null || error !== null) {
      errors.push(`${path} blocked state requires blocker and forbids error`);
    }
  } else if (state === "failed") {
    if (error === null || blocker !== null) {
      errors.push(`${path} failed state requires error and forbids blocker`);
    }
  } else if (state !== "running" && (error !== null || blocker !== null)) {
    errors.push(`${path} ${state} state cannot expose a current error or blocker`);
  }

  const lastHistory = history.at(-1);
  const expectedLastOutcome = {
    blocked: "blocked",
    completed: "completed",
    failed: "failed",
    stale: "completed",
  }[state];
  // A failed revision attempt restores the committed mark, so a completed/stale material step may
  // legally end its history with that attempt's failed entry (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#1-a-new-lifecycle-operation-revise-step-steps-45-only) — but only when an
  // earlier committed publication anchors the restored mark. The restored mark is frozen into the
  // entry, while the step's state may still degrade afterwards: `reopen-step` on an ancestor and
  // `reconcile-step` on proven input drift both mark a `completed` step `stale` without any attempt
  // of its own. So the carve-out admits that one-way transition and nothing else — a step whose
  // restored mark was `stale` can only reach `completed` through a publication, which would replace
  // this trailing entry.
  const restoredRevisionMark =
    lastHistory?.outcome === "failed" &&
    lastHistory?.operation === "revise" &&
    ((lastHistory.pre_attempt_state === "completed" && ["completed", "stale"].includes(state)) ||
      (lastHistory.pre_attempt_state === "stale" && state === "stale")) &&
    history.some((entry) => entry?.publication_id !== null);
  if (
    expectedLastOutcome &&
    lastHistory?.outcome !== expectedLastOutcome &&
    !restoredRevisionMark
  ) {
    errors.push(
      `${path}.attempt_history must end with outcome ${expectedLastOutcome} for state ${state}`,
    );
  }
  if (state === "blocked" && blocker && lastHistory?.error_code !== blocker.code) {
    errors.push(`${path}.blocker.code must match the latest attempt_history error_code`);
  }
  if (state === "failed" && error && lastHistory?.error_code !== error.code) {
    errors.push(`${path}.error.code must match the latest attempt_history error_code`);
  }
  return step;
}

function validateSteps(value, path, errors) {
  const steps = validateStrictObject(value, path, errors, fileBackedStepNames);
  for (const stepName of fileBackedStepNames) {
    validateStep(steps[stepName], `${path}.${stepName}`, errors, stepName);
  }
  return steps;
}

function validateCompany(value, path, errors, dependencies) {
  const company = validateStrictObject(value, path, errors, COMPANY_KEYS);
  validateString(company.id, `${path}.id`, errors);
  const displayName = validateString(company.display_name, `${path}.display_name`, errors);
  const terms = validateStringArray(company.search_terms, `${path}.search_terms`, errors, {
    min: 1,
  });
  const normalizedTerms = terms.map(dependencies.normalizeSearchText);
  if (normalizedTerms.some((term) => !term)) {
    errors.push(`${path}.search_terms contains an empty normalized term`);
  }
  if (new Set(normalizedTerms).size !== normalizedTerms.length) {
    errors.push(`${path}.search_terms contains normalized duplicates`);
  }
  if (displayName && !normalizedTerms.includes(dependencies.normalizeSearchText(displayName))) {
    errors.push(`${path}.search_terms must include display_name`);
  }
  const domains = validateStringArray(company.domains, `${path}.domains`, errors);
  const normalizedDomains = [];
  for (const [index, domain] of domains.entries()) {
    try {
      const normalized = dependencies.normalizeDomain(domain);
      normalizedDomains.push(normalized);
      if (domain !== normalized) errors.push(`${path}.domains[${index}] must be canonical`);
    } catch (error) {
      errors.push(`${path}.domains[${index}]: ${error.message}`);
    }
  }
  if (new Set(normalizedDomains).size !== normalizedDomains.length) {
    errors.push(`${path}.domains contains duplicates`);
  }
  return company;
}

function validateCommonProcessFields(record, path, errors, dependencies) {
  validateString(record.id, `${path}.id`, errors);
  validateIsoTimestamp(record.started_at, `${path}.started_at`, errors);
  const sourceRef = validateString(record.source_ref, `${path}.source_ref`, errors);
  validateString(record.source_key, `${path}.source_key`, errors);
  if (sourceRef && !dependencies.sourceKeyIsCanonical(record.source_key, sourceRef)) {
    errors.push(`${path}.source_key is not canonical`);
  }
  validateNullableReferenceId(record.company_id, `${path}.company_id`, errors);
  validateNullableString(record.company_observed, `${path}.company_observed`, errors);
  validateNullableString(record.company_hint, `${path}.company_hint`, errors);
  validateNullableString(record.role, `${path}.role`, errors);
  validateEnum(record.runner, `${path}.runner`, errors, [...dependencies.allowedRunners]);
  validateNullableReferenceId(record.duplicate_of, `${path}.duplicate_of`, errors);
}

function validateHistoricalProcess(value, path, errors, dependencies) {
  const record = validateStrictObject(value, path, errors, HISTORICAL_PROCESS_KEYS);
  validateCommonProcessFields(record, path, errors, dependencies);
  validateEnum(record.status, `${path}.status`, errors, [
    ...dependencies.allowedHistoricalStatuses,
  ]);
  if (record.output_dir !== null) {
    try {
      dependencies.normalizeHistoricalOutputDir(record.output_dir);
    } catch (error) {
      errors.push(`${path}.output_dir: ${error.message}`);
    }
    if (record.status !== "output_created") {
      errors.push(`${path}.status must be output_created when output_dir is present`);
    }
  } else if (record.status === "output_created") {
    errors.push(`${path}.output_dir is required for output_created status`);
  }
  return record;
}

function validateFileBackedProcess(value, path, errors, dependencies) {
  const record = validateStrictObject(value, path, errors, FILE_BACKED_PROCESS_KEYS);
  validateCommonProcessFields(record, path, errors, dependencies);
  if (record.runner === "claude-ai-web") {
    errors.push(`${path}.runner claude-ai-web is reserved for historical provenance`);
  }
  validateIsoTimestamp(record.updated_at, `${path}.updated_at`, errors);
  if (record.artifact_mode !== "file-backed") {
    errors.push(`${path}.artifact_mode must equal "file-backed"`);
  }
  if (record.output_dir !== null) {
    validateOutputDir(record.output_dir, `${path}.output_dir`, errors);
    if (record.company_observed === null || record.role === null) {
      errors.push(`${path}.output_dir requires exact company_observed and role`);
    }
  }
  const steps = validateSteps(record.steps, `${path}.steps`, errors);
  const hasCommittedBundle = fileBackedStepNames.some((stepName) => steps[stepName]?.revision > 0);
  if (hasCommittedBundle && record.output_dir === null) {
    errors.push(`${path}.output_dir is required once an artifact bundle is committed`);
  }
  return record;
}

function parsedTimestamp(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function assertTimestampNotAfter(left, leftPath, right, rightPath, errors) {
  const leftMs = parsedTimestamp(left);
  const rightMs = parsedTimestamp(right);
  if (leftMs !== null && rightMs !== null && leftMs > rightMs) {
    errors.push(`${leftPath} must not be after ${rightPath}`);
  }
}

function assertTimestampNotBefore(left, leftPath, right, rightPath, errors) {
  const leftMs = parsedTimestamp(left);
  const rightMs = parsedTimestamp(right);
  if (leftMs !== null && rightMs !== null && leftMs < rightMs) {
    errors.push(`${leftPath} must not be before ${rightPath}`);
  }
}

function assertTimestampEqual(left, leftPath, right, rightPath, errors) {
  const leftMs = parsedTimestamp(left);
  const rightMs = parsedTimestamp(right);
  if (leftMs !== null && rightMs !== null && leftMs !== rightMs) {
    errors.push(`${leftPath} must equal ${rightPath}`);
  }
}

function validateTimestampCeiling(value, path, errors, nowMs) {
  const timestamp = parsedTimestamp(value);
  if (timestamp !== null && timestamp > nowMs + PROCESS_LOG_FUTURE_SKEW_MS) {
    errors.push(`${path} must not be more than ${PROCESS_LOG_FUTURE_SKEW_MS} ms in the future`);
  }
}

function validateDiagnosticChronology(diagnostic, path, errors, nowMs) {
  if (diagnostic === null || typeof diagnostic !== "object") return;
  validateTimestampCeiling(diagnostic.at, `${path}.at`, errors, nowMs);
}

function validateStepChronology(step, path, errors, { nowMs, processStartedAt, processUpdatedAt }) {
  if (step === null || typeof step !== "object") return;
  for (const key of ["started_at", "updated_at", "finished_at"]) {
    if (step[key] !== null) {
      validateTimestampCeiling(step[key], `${path}.${key}`, errors, nowMs);
      assertTimestampNotBefore(
        step[key],
        `${path}.${key}`,
        processStartedAt,
        `${path.split(".steps.")[0]}.started_at`,
        errors,
      );
      assertTimestampNotAfter(
        step[key],
        `${path}.${key}`,
        processUpdatedAt,
        `${path.split(".steps.")[0]}.updated_at`,
        errors,
      );
    }
  }
  assertTimestampNotAfter(
    step.started_at,
    `${path}.started_at`,
    step.updated_at,
    `${path}.updated_at`,
    errors,
  );
  assertTimestampNotAfter(
    step.finished_at,
    `${path}.finished_at`,
    step.updated_at,
    `${path}.updated_at`,
    errors,
  );
  assertTimestampNotAfter(
    step.started_at,
    `${path}.started_at`,
    step.finished_at,
    `${path}.finished_at`,
    errors,
  );

  const history = Array.isArray(step.attempt_history) ? step.attempt_history : [];
  for (const [index, attempt] of history.entries()) {
    const attemptPath = `${path}.attempt_history[${index}]`;
    if (attempt === null || typeof attempt !== "object") continue;
    for (const key of ["started_at", "finished_at"]) {
      validateTimestampCeiling(attempt[key], `${attemptPath}.${key}`, errors, nowMs);
      assertTimestampNotBefore(
        attempt[key],
        `${attemptPath}.${key}`,
        processStartedAt,
        `${path.split(".steps.")[0]}.started_at`,
        errors,
      );
      assertTimestampNotAfter(
        attempt[key],
        `${attemptPath}.${key}`,
        processUpdatedAt,
        `${path.split(".steps.")[0]}.updated_at`,
        errors,
      );
    }
    assertTimestampNotAfter(
      attempt.started_at,
      `${attemptPath}.started_at`,
      attempt.finished_at,
      `${attemptPath}.finished_at`,
      errors,
    );
    if (index > 0) {
      const previousPath = `${path}.attempt_history[${index - 1}]`;
      assertTimestampNotBefore(
        attempt.started_at,
        `${attemptPath}.started_at`,
        history[index - 1]?.finished_at,
        `${previousPath}.finished_at`,
        errors,
      );
    }
  }

  const active = step.active_attempt;
  if (active !== null && typeof active === "object") {
    validateTimestampCeiling(active.started_at, `${path}.active_attempt.started_at`, errors, nowMs);
    assertTimestampEqual(
      active.started_at,
      `${path}.active_attempt.started_at`,
      step.started_at,
      `${path}.started_at`,
      errors,
    );
    assertTimestampNotAfter(
      active.started_at,
      `${path}.active_attempt.started_at`,
      step.updated_at,
      `${path}.updated_at`,
      errors,
    );
    const previousAttempt = history.at(-1);
    if (previousAttempt) {
      assertTimestampNotBefore(
        active.started_at,
        `${path}.active_attempt.started_at`,
        previousAttempt.finished_at,
        `${path}.attempt_history[${history.length - 1}].finished_at`,
        errors,
      );
    }
  }

  const transaction = step.publication_transaction;
  if (transaction !== null && typeof transaction === "object") {
    validateTimestampCeiling(
      transaction.prepared_at,
      `${path}.publication_transaction.prepared_at`,
      errors,
      nowMs,
    );
    if (active !== null && typeof active === "object") {
      assertTimestampNotBefore(
        transaction.prepared_at,
        `${path}.publication_transaction.prepared_at`,
        active.started_at,
        `${path}.active_attempt.started_at`,
        errors,
      );
    }
    assertTimestampNotAfter(
      transaction.prepared_at,
      `${path}.publication_transaction.prepared_at`,
      processUpdatedAt,
      `${path.split(".steps.")[0]}.updated_at`,
      errors,
    );
    validateDiagnosticChronology(
      transaction.blocker,
      `${path}.publication_transaction.blocker`,
      errors,
      nowMs,
    );
    if (transaction.blocker !== null && typeof transaction.blocker === "object") {
      assertTimestampEqual(
        transaction.blocker.at,
        `${path}.publication_transaction.blocker.at`,
        transaction.prepared_at,
        `${path}.publication_transaction.prepared_at`,
        errors,
      );
    }
  }

  validateDiagnosticChronology(step.error, `${path}.error`, errors, nowMs);
  validateDiagnosticChronology(step.blocker, `${path}.blocker`, errors, nowMs);

  if (Array.isArray(step.waivers)) {
    for (const [index, waiver] of step.waivers.entries()) {
      if (waiver === null || typeof waiver !== "object") continue;
      const waiverPath = `${path}.waivers[${index}].created_at`;
      validateTimestampCeiling(waiver.created_at, waiverPath, errors, nowMs);
      assertTimestampNotBefore(
        waiver.created_at,
        waiverPath,
        processStartedAt,
        `${path.split(".steps.")[0]}.started_at`,
        errors,
      );
      assertTimestampNotAfter(
        waiver.created_at,
        waiverPath,
        processUpdatedAt,
        `${path.split(".steps.")[0]}.updated_at`,
        errors,
      );
    }
  }
  if (step.adoption_base !== null && typeof step.adoption_base === "object") {
    const adoptionPath = `${path}.adoption_base.created_at`;
    validateTimestampCeiling(step.adoption_base?.created_at, adoptionPath, errors, nowMs);
    assertTimestampNotBefore(
      step.adoption_base?.created_at,
      adoptionPath,
      processStartedAt,
      `${path.split(".steps.")[0]}.started_at`,
      errors,
    );
    assertTimestampNotAfter(
      step.adoption_base?.created_at,
      adoptionPath,
      processUpdatedAt,
      `${path.split(".steps.")[0]}.updated_at`,
      errors,
    );
  }

  const lastHistory = history.at(-1);
  if (lastHistory && ["blocked", "completed", "failed", "stale"].includes(step.state)) {
    assertTimestampEqual(
      step.started_at,
      `${path}.started_at`,
      lastHistory.started_at,
      `${path}.attempt_history[${history.length - 1}].started_at`,
      errors,
    );
    assertTimestampEqual(
      step.finished_at,
      `${path}.finished_at`,
      lastHistory.finished_at,
      `${path}.attempt_history[${history.length - 1}].finished_at`,
      errors,
    );
  }
  if (step.error !== null) {
    assertTimestampEqual(
      step.error.at,
      `${path}.error.at`,
      step.finished_at,
      `${path}.finished_at`,
      errors,
    );
  }
  if (step.blocker !== null) {
    assertTimestampEqual(
      step.blocker.at,
      `${path}.blocker.at`,
      step.finished_at,
      `${path}.finished_at`,
      errors,
    );
  }
}

function validateChronology(log, errors, nowMs) {
  validateTimestampCeiling(log.updated_at, "updated_at", errors, nowMs);
  for (const [index, record] of log.processes.entries()) {
    const path = `processes[${index}]`;
    validateTimestampCeiling(record?.started_at, `${path}.started_at`, errors, nowMs);
    assertTimestampNotAfter(
      record?.started_at,
      `${path}.started_at`,
      log.updated_at,
      "updated_at",
      errors,
    );
    if (classifyProcessRecord(record) !== "file-backed") continue;
    validateTimestampCeiling(record.updated_at, `${path}.updated_at`, errors, nowMs);
    assertTimestampNotAfter(
      record.started_at,
      `${path}.started_at`,
      record.updated_at,
      `${path}.updated_at`,
      errors,
    );
    assertTimestampNotAfter(
      record.updated_at,
      `${path}.updated_at`,
      log.updated_at,
      "updated_at",
      errors,
    );
    for (const stepName of fileBackedStepNames) {
      validateStepChronology(record.steps?.[stepName], `${path}.steps.${stepName}`, errors, {
        nowMs,
        processStartedAt: record.started_at,
        processUpdatedAt: record.updated_at,
      });
      const step = record.steps?.[stepName];
      if (
        step === null ||
        typeof step !== "object" ||
        step.started_at === null ||
        ["pending", "stale"].includes(step.state)
      )
        continue;
      for (const dependencyName of fileBackedStepDependencies[stepName]) {
        const dependency = record.steps?.[dependencyName];
        if (dependency?.state === "completed") {
          assertTimestampNotBefore(
            step.started_at,
            `${path}.steps.${stepName}.started_at`,
            dependency.finished_at,
            `${path}.steps.${dependencyName}.finished_at`,
            errors,
          );
        } else {
          const stepStartMs = parsedTimestamp(step.started_at);
          const completedAttempt = Array.isArray(dependency?.attempt_history)
            ? dependency.attempt_history.findLast(
                (attempt) =>
                  attempt?.outcome === "completed" &&
                  parsedTimestamp(attempt.finished_at) !== null &&
                  stepStartMs !== null &&
                  parsedTimestamp(attempt.finished_at) <= stepStartMs,
              )
            : null;
          if (!completedAttempt) {
            errors.push(
              `${path}.steps.${dependencyName}.attempt_history must contain a completed attempt no later than ${path}.steps.${stepName}.started_at`,
            );
          }
        }
      }
    }
  }
}

export function classifyProcessRecord(value) {
  if (hasOwn(value, "artifact_mode") || hasOwn(value, "steps") || hasOwn(value, "updated_at")) {
    return "file-backed";
  }
  return "historical";
}

export function outputDirEquivalenceKey(value) {
  return String(value).replaceAll("\\", "/").normalize("NFC").toLowerCase().normalize("NFC");
}

// Records that share a key must be linked by `duplicate_of` (ADR 0013 rows 15-16). Two things move
// at the cutover, and the matrix cell only names one of them.
//
// The **grouping** moves to the computed key, exactly as the row says. The **link target** test
// cannot move with it. A refinement only ever shrinks a group, and a shrunken group can leave a
// non-first member pointing at a record that stayed outside — that is precisely the "broken
// duplicate link" the census reports, and it exists in ledgers that are valid today. Refusing it
// here would fail the whole file on load, permanently for a historical group, because historical
// records are immutable by rule (row 27) and could never be repaired. So a link is accepted when
// its two ends share the computed key *or* the stored key: sharing the stored key means they were
// one group under the policy version that wrote the link.
//
// The clause is wider than the case that forces it, and its bound is stated by construction rather
// than by how it looks: it decides something only when the link's two ends share the stored key and
// not the computed one — the shape a split creates, and the only shape it exists for. Only, not
// exactly: the loop reaches it solely for a non-first member of a computed group that still has at
// least two, so the canonical split of one pair into two singletons never consults it at all. Two
// records written after the cutover can never be that shape either, because stored equals computed
// for both, so sharing one is sharing the other; two legacy records can, and that is the case the
// ledger already contains.
//
// The writers keep that width unreachable rather than the check narrowing it: `start` constrains
// `duplicate_of` to the computed-key match set, and the historical importer writes a link only where
// the reader would otherwise refuse the group. The requirement itself — every non-first member must
// be linked to *something* it shares a key with — is untouched, and an unlinked duplicate is still
// an error.
function computedSourceKeyEntries(processes, computeSourceKey) {
  const entries = [];
  for (const record of processes) {
    if (typeof record?.source_key !== "string" || typeof record?.source_ref !== "string") {
      continue;
    }
    let computedSourceKey;
    try {
      computedSourceKey = computeSourceKey(record.source_ref);
    } catch {
      // A reference the normalizer refuses is already a structural error on its own record.
      continue;
    }
    entries.push({ computedSourceKey, record });
  }
  return entries;
}

function groupByComputedSourceKey(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const group = groups.get(entry.computedSourceKey) ?? [];
    group.push(entry);
    groups.set(entry.computedSourceKey, group);
  }
  return groups;
}

export function duplicateSourceKeyGroupErrors(processes, computeSourceKey) {
  const entries = computedSourceKeyEntries(processes, computeSourceKey);

  const storedKeyById = new Map(entries.map(({ record }) => [record.id, record.source_key]));
  const groups = groupByComputedSourceKey(entries);

  const errors = [];
  for (const [sourceKey, group] of groups) {
    if (group.length < 2) continue;
    const groupIds = new Set(group.map(({ record }) => record.id));
    for (const { record } of group.slice(1)) {
      const linkedInsideGroup = Boolean(record.duplicate_of) && groupIds.has(record.duplicate_of);
      const linkedUnderStoredKey =
        Boolean(record.duplicate_of) &&
        storedKeyById.get(record.duplicate_of) === record.source_key;
      if (linkedInsideGroup || linkedUnderStoredKey) continue;
      errors.push(`duplicate source_key ${sourceKey} must be linked with duplicate_of`);
    }
  }
  return errors;
}

// The writer's half of the rule above, and it is deliberately stricter than the reader's (task 010).
//
// The reader accepts a link whose two ends share the computed key *or* the stored key, because a
// policy split left such links in ledgers that are already valid and historical records can never
// be repaired. That second clause describes the past; a writer creating a link today has no reason
// to reach it, and ADR 0013 recorded that the writers keep it unreachable. So this check asks only
// the first question: a record that shares its computed key with an earlier record must name a
// member of that computed group.
//
// A record that is alone in its computed group, or first in it, is free to name any existing
// process — that is what makes an explicitly declared cross-source duplicate possible at all, and
// it is the direction a group whose first member predates the cross-source copy is repaired from.
//
// `recordId` is `null` when the record does not exist yet, which is the `start` case: a new record
// sorts last by `started_at`, so every peer sharing its key is an earlier one. Existence of the
// target and non-self-reference are a different rule (ADR 0013 row 17) and are not checked here.
export function duplicateLinkWriteError(
  processes,
  computeSourceKey,
  { duplicateOf, recordId = null, sourceRef },
) {
  let computedSourceKey;
  try {
    computedSourceKey = computeSourceKey(sourceRef);
  } catch {
    return null;
  }
  const index =
    recordId === null ? processes.length : processes.findIndex((record) => record?.id === recordId);
  if (index === -1) return null;

  const entries = computedSourceKeyEntries(processes, computeSourceKey);
  const group = groupByComputedSourceKey(entries).get(computedSourceKey) ?? [];
  const peers = group.filter(({ record }) => record.id !== recordId);
  const hasEarlierPeer = peers.some(
    ({ record }) => processes.findIndex((candidate) => candidate?.id === record.id) < index,
  );
  if (!hasEarlierPeer) return null;

  const allowedIds = peers.map(({ record }) => record.id).sort();
  if (duplicateOf !== null && allowedIds.includes(duplicateOf)) return null;
  return (
    `a record sharing source_key ${computedSourceKey} with an earlier process must name one of ` +
    `${allowedIds.join(", ")} as duplicate_of`
  );
}

function validateCrossReferences(log, errors, dependencies) {
  const companyIds = new Set();
  for (const [index, company] of log.companies.entries()) {
    if (typeof company?.id !== "string") continue;
    if (companyIds.has(company.id))
      errors.push(`companies[${index}].id is duplicated: ${company.id}`);
    companyIds.add(company.id);
  }

  const processIds = new Set();
  for (const [index, record] of log.processes.entries()) {
    if (typeof record?.id !== "string") continue;
    if (processIds.has(record.id))
      errors.push(`processes[${index}].id is duplicated: ${record.id}`);
    processIds.add(record.id);
    if (record.company_id !== null && !companyIds.has(record.company_id)) {
      errors.push(`processes[${index}].company_id references an unknown company`);
    }
  }

  const outputOwners = new Map();
  for (const [index, record] of log.processes.entries()) {
    if (typeof record?.output_dir !== "string") continue;
    const key = outputDirEquivalenceKey(record.output_dir);
    const owner = outputOwners.get(key);
    if (owner) {
      errors.push(
        `processes[${index}].output_dir is Unicode/case-equivalent to the path owned by ${owner}`,
      );
    } else {
      outputOwners.set(key, record.id);
    }
  }

  const publicationOwners = new Map();
  for (const [processIndex, record] of log.processes.entries()) {
    if (classifyProcessRecord(record) !== "file-backed") continue;
    for (const stepName of fileBackedStepNames) {
      const step = record.steps?.[stepName];
      const candidates = [
        ...(step?.attempt_history ?? []).map((entry, historyIndex) => ({
          id: entry?.publication_id,
          path: `processes[${processIndex}].steps.${stepName}.attempt_history[${historyIndex}].publication_id`,
        })),
        {
          id: step?.publication_transaction?.id,
          path: `processes[${processIndex}].steps.${stepName}.publication_transaction.id`,
        },
        // The adoption base reserves its staging id; when this step's prepared transaction is
        // consuming that exact reservation, the pair is the intended hand-off, not a duplicate.
        ...(step?.adoption_base?.publication_id &&
        step.adoption_base.publication_id !== step?.publication_transaction?.id
          ? [
              {
                id: step.adoption_base.publication_id,
                path: `processes[${processIndex}].steps.${stepName}.adoption_base.publication_id`,
              },
            ]
          : []),
      ];
      for (const candidate of candidates) {
        if (typeof candidate.id !== "string") continue;
        const owner = publicationOwners.get(candidate.id);
        if (owner) {
          errors.push(`${candidate.path} duplicates publication id owned by ${owner}`);
        } else {
          publicationOwners.set(candidate.id, candidate.path);
        }
      }
    }
  }

  for (const [index, record] of log.processes.entries()) {
    if (record.duplicate_of !== null && !processIds.has(record.duplicate_of)) {
      errors.push(`processes[${index}].duplicate_of references an unknown id`);
    }
    if (record.duplicate_of === record.id) {
      errors.push(`processes[${index}].duplicate_of cannot reference itself`);
    }
  }

  errors.push(...duplicateSourceKeyGroupErrors(log.processes, dependencies.normalizeSourceRef));
}

export function validateProcessLogV3(log, dependencies) {
  const errors = [];
  const root = validateStrictObject(log, "root", errors, TOP_LEVEL_KEYS);
  if (root.schema_version !== 4) {
    errors.push("schema_version must be 4; schema_version 3 is unsupported by the v4 ledger");
  }
  validateEnum(root.duplicate_policy, "duplicate_policy", errors, [
    "prompt",
    "resume",
    "new-attempt",
  ]);
  validateIsoTimestamp(root.updated_at, "updated_at", errors);
  const companies = validateArray(root.companies, "companies", errors);
  const processes = validateArray(root.processes, "processes", errors);
  companies.forEach((company, index) =>
    validateCompany(company, `companies[${index}]`, errors, dependencies),
  );
  processes.forEach((record, index) => {
    const path = `processes[${index}]`;
    if (classifyProcessRecord(record) === "file-backed") {
      validateFileBackedProcess(record, path, errors, dependencies);
    } else {
      validateHistoricalProcess(record, path, errors, dependencies);
    }
  });
  validateCrossReferences({ companies, processes }, errors, dependencies);
  validateChronology({ ...root, companies, processes }, errors, Date.now());
  if (errors.length) throw new TrustedProcessLogV3ValidationError(errors);
  return log;
}
