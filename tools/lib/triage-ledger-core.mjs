/**
 * Batch-triage ledger — the state `/score-jobs` carries between batches.
 *
 * Why this exists as its own file rather than as another `process-log.json` section: batch triage
 * is deliberately not a per-role process (`instructions/pipeline-run.md`), so the schema-v3
 * lifecycle has nothing to hang a triaged link on. Without a ledger the whole batch — liveness,
 * decisions, gap flags — lives in one session's scratchpad and dies with it, which is what the
 * 2026-08-18 verified run measured: known-closed vacancies were re-fetched at full cost and the
 * batch's only priority-1 match survived only in chat.
 *
 * Three properties are load-bearing:
 *
 * - **No vacancy value ever reaches argv.** Every mutating entry point here is an in-process
 *   module API, called the way `score-jobs` already calls the pure scorer. That is the strongest
 *   form of the ADR 0011 boundary: there is no shell, so there is nothing to escape. The operator
 *   CLI on top of this module is read-only and accepts machine tokens only.
 * - **Flags and decisions are opaque bounded strings, not enums.** `knowledge/job-match-rules.md`
 *   owns the terminal vocabulary, and policy v2 extended it with gap and assumption annotations
 *   without touching this file; a second copy of that vocabulary here would have gone stale that
 *   day. Only `status` — the ledger's own liveness concept — is closed, and the plan compares
 *   `decision` with exactly one value, `triageRetryDecision`.
 * - **The core reads no clock.** Every timestamp is supplied by the caller, so a batch replay and
 *   a test produce byte-identical ledgers.
 *
 * The ledger is the operational index: version 1 retains URL observations, and version 2 adds
 * logical vacancy rows and card-scoped source memberships to that same index. The history beside
 * it is the batch store: each recorder writes one immutable
 * `ledger-record.json` into the batch's own directory, and a re-score of the same vacancy adds a
 * record under a new batch id rather than replacing the first. `docs/runbooks/triage-review.md`
 * docs/runbooks/triage-review.md#11-batch-store-the-history-beside-the-index owns where that store lives and what happens to it over time; this file owns the
 * record's schema and the discipline of writing it.
 */

import {
  closeSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectJobSource } from "../job-sources/registry.mjs";
import { OpsTreeError, verifyFolder } from "../ops-tree/manifest.mjs";
import {
  cardRefPattern,
  readSourceSet,
  snapshotRefPattern,
  sourceRoles,
  sourceSetDigest,
  validateSourceSet,
} from "../triage-sources/source-set.mjs";
import { sourceResolutionDigest, validateSourceResolution } from "../triage-sources/reconcile.mjs";
import { verifyCaptureFile } from "../vacancy-fetch/persist.mjs";

export const triageLedgerSchemaVersion = 2;
export const triageLegacyLedgerSchemaVersion = 1;
export const triageSourceBatchRecordSchemaVersion = 2;
export const triageSourceSetFileName = "source-set.json";
export const triageSourceResolutionFileName = "source-resolution.json";

/** Schema of the immutable per-batch record this module writes into a batch's own directory. */
export const triageBatchRecordSchemaVersion = 1;

/**
 * The record's file name inside a batch directory.
 *
 * `tools/triage-verify/artifacts.mjs` imports this rather than repeating it: the name is a member
 * of that suite's directory contract, and a second literal is how the two would drift into
 * reporting a legitimate record as an unexpected artifact.
 */
export const triageBatchRecordFileName = "ledger-record.json";

/** Liveness of a known vacancy. Closed and expired are terminal: they are never re-fetched. */
export const triageLedgerStatuses = Object.freeze(["open", "closed", "expired"]);

/** Batch-start dispositions. Only the two `skip_*` values suppress a fetch. */
export const triagePlanActions = Object.freeze([
  "fetch_new",
  "retry_blocked",
  "skip_known",
  "skip_closed",
]);

/**
 * The one decision the plan reads. A row whose last fetch failed was never triaged, so it is the
 * only known row fetched again without the user asking. knowledge/job-match-rules.md#6-terminal-decision-codes owns the
 * word; `tests/triage-ledger.test.mjs` freezes it against what `tools/job-scorer/decide.mjs` emits.
 */
export const triageRetryDecision = "BLOCKED";

/**
 * Where a batch directory keeps its Decision Traces, and how a trace file is named.
 * `tools/triage-verify/artifacts.mjs` imports both rather than repeating them, for the reason
 * `triageBatchRecordFileName` gives: the record-time guard below and that suite's loader must read
 * one layout.
 */
export const triageBatchTracesDirName = "traces";
export const triageBatchTraceFilePattern = /^(\d{3})\.trace\.json$/u;

/**
 * The batch's own plan — the `planBatch` result the skill writes into the batch directory before
 * the first fetch — under the name `tools/triage-verify/` reads it by. The record-time guard below
 * reads it back from the directory rather than taking a plan object as an argument: the file is
 * the one plan the batch demonstrably had, while an object handed over at record time could have
 * been taken a moment earlier and would show every row as already known.
 * `tools/triage-verify/artifacts.mjs` imports the name for the reason the two names above give.
 */
export const triageBatchPlanFileName = "plan.json";

const maxEntries = 4096;
const maxFlagsPerEntry = 32;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * What a `batch_id` may look like. Exported so a caller that derives a label —
 * `tools/pretriage/groups.mjs` builds one per collection group — refuses a bad one before a batch
 * is fetched under it, rather than at record time when the fetch is already spent.
 */
export const triageBatchIdPattern = identifierPattern;
const decisionPattern = /^[A-Z][A-Z_]{0,31}$/;
const flagPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const digestPattern = /^[0-9a-f]{64}$/;
const linkedInJobIdPattern = /^\d{5,20}$/;
const linkedInViewSegmentPattern = /\/jobs\/view\/([^/]+)/;
const linkedInTrailingIdPattern = /(?:^|[-/])(\d{5,20})$/;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/;
const maxTextBytes = 512;
/**
 * Read ceiling for a record file. A batch caps at `maxEntries` rows and every string field of a
 * row is itself capped, so a legitimate record cannot approach this; what it bounds is the read of
 * a file some other writer put there.
 */
const maxRecordBytes = 32 * 1024 * 1024;
const lockRetries = 50;
const lockRetryDelayMs = 20;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

export class TriageLedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TriageLedgerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new TriageLedgerError(code, message);
}

// The operational folder's drift check, run by both ends of a batch before anything else. It reads
// the manifest of the tree this module lies in, never of the environment's workspace; a tree
// without the marker passes untouched.
const moduleTreeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function verifyOperationalFolder() {
  try {
    verifyFolder(moduleTreeRoot);
  } catch (error) {
    if (error instanceof OpsTreeError) throw new TriageLedgerError(error.code, error.message);
    throw error;
  }
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, required, optional, code, label) {
  if (!isRecord(value)) fail(code, `${label} must be an object.`);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(code, `${label} is missing "${key}".`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code, `${label} carries the unknown key "${key}".`);
  }
}

function assertBoundedText(value, key, code, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(code, `${label} "${key}" must be a non-empty string.`);
  }
  if (Buffer.byteLength(value, "utf8") > maxTextBytes) {
    fail(code, `${label} "${key}" exceeds ${maxTextBytes} bytes.`);
  }
  if (controlCharacterPattern.test(value)) {
    fail(code, `${label} "${key}" carries a control character.`);
  }
}

export function parseInstant(value, code = "triage_ledger_invalid_instant") {
  if (typeof value !== "string" || !instantPattern.test(value)) {
    fail(code, "Timestamps must be UTC ISO-8601 instants, for example 2026-08-18T12:40:00Z.");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(code, "Timestamp is not a real instant.");
  return parsed;
}

/**
 * Canonical spelling of a vacancy URL for identity purposes.
 *
 * Deliberately *not* `normalizeSourceRef` from the process-log core: that key carries a policy
 * version of its own (ADR 0013 — version 2 since the cutover, and nothing says it is the last), and
 * a triage identity that silently changed shape with it would re-fetch the whole ledger as new. The
 * rules here are the stable subset — case-folded host, no fragment, no `utm_*`, sorted query, no
 * trailing slash — and they are deliberately not kept in step with that policy.
 */
export function normalizeVacancyUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("triage_ledger_invalid_url", "A vacancy URL is required.");
  }
  const raw = value.trim();
  if (controlCharacterPattern.test(raw)) {
    fail("triage_ledger_invalid_url", "A vacancy URL must not carry control characters.");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("triage_ledger_invalid_url", `Not a URL: ${raw.slice(0, 120)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail("triage_ledger_invalid_url", "Only http and https vacancy URLs are supported.");
  }
  url.hash = "";
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  const normalized = url.toString();
  if (Buffer.byteLength(normalized, "utf8") > maxTextBytes) {
    fail("triage_ledger_invalid_url", `A vacancy URL exceeds ${maxTextBytes} bytes.`);
  }
  return normalized;
}

/**
 * LinkedIn spells one posting several ways: the bare `/jobs/view/<id>`, the share/copy-link slug
 * `/jobs/view/<title>-at-<company>-<id>`, a percent-encoded trailing slash, and the collection
 * view's `?currentJobId=`. All of them must collapse to the same ledger row, or the ledger
 * re-fetches a vacancy it already knows is closed — the exact cost this file exists to remove.
 */
function linkedInJobId(url) {
  const segment = url.pathname.match(linkedInViewSegmentPattern)?.[1];
  if (segment !== undefined) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // A malformed escape is not a reason to lose the id that may still be readable raw.
    }
    const trailing = decoded.replace(/\/+$/, "").match(linkedInTrailingIdPattern);
    if (trailing) return trailing[1];
  }
  const currentJobId = url.searchParams.get("currentJobId");
  if (currentJobId !== null && linkedInJobIdPattern.test(currentJobId)) return currentJobId;
  return null;
}

/**
 * Ledger identity: source plus job id, exactly as the task states it.
 *
 * A source whose id cannot be read from the URL keeps the normalized URL as its job id. That is
 * what makes the ledger source-agnostic ahead of tasks 27/30 without inventing an id scheme per
 * ATS: two spellings of one posting collapse when the URL collapses, and never otherwise.
 */
export function vacancyIdentity(value) {
  const normalized = normalizeVacancyUrl(value);
  const url = new URL(normalized);
  const detected = detectJobSource(normalized);
  const source = detected?.id ?? "url";
  const jobId = source === "linkedin" ? (linkedInJobId(url) ?? normalized) : normalized;
  return { source, jobId, url: normalized, key: `${source}:${jobId}` };
}

export function emptyLedger({ schemaVersion = triageLegacyLedgerSchemaVersion } = {}) {
  if (![1, 2].includes(schemaVersion))
    fail("triage_ledger_schema_version", "This build reads ledger versions 1 and 2.");
  return {
    schema_version: schemaVersion,
    batches: [],
    entries: [],
    ...(schemaVersion === 2
      ? { logical_entries: [], source_records: [], aliases: [], corrections: [] }
      : {}),
  };
}

function validateEntry(entry, index) {
  const label = `entries[${index}]`;
  assertExactKeys(
    entry,
    [
      "key",
      "source",
      "job_id",
      "url",
      "first_seen",
      "last_checked",
      "status",
      "batch_id",
      "decision",
      "flags",
    ],
    ["title", "company", "priority_class", "policy_id"],
    "triage_ledger_invalid_entry",
    label,
  );
  for (const key of ["key", "source", "job_id", "url", "batch_id"]) {
    assertBoundedText(entry[key], key, "triage_ledger_invalid_entry", label);
  }
  if (!identifierPattern.test(entry.source)) {
    fail("triage_ledger_invalid_entry", `${label}.source is not a source identifier.`);
  }
  if (!identifierPattern.test(entry.batch_id)) {
    fail("triage_ledger_invalid_entry", `${label}.batch_id is not an identifier.`);
  }
  if (entry.key !== `${entry.source}:${entry.job_id}`) {
    fail("triage_ledger_invalid_entry", `${label}.key does not match source and job_id.`);
  }
  if (entry.url !== normalizeVacancyUrl(entry.url)) {
    fail("triage_ledger_invalid_entry", `${label}.url is not stored in its normalized spelling.`);
  }
  if (!triageLedgerStatuses.includes(entry.status)) {
    fail(
      "triage_ledger_invalid_entry",
      `${label}.status is not one of ${triageLedgerStatuses.join(", ")}.`,
    );
  }
  if (typeof entry.decision !== "string" || !decisionPattern.test(entry.decision)) {
    fail("triage_ledger_invalid_entry", `${label}.decision must be an upper-case terminal code.`);
  }
  if (!Array.isArray(entry.flags) || entry.flags.length > maxFlagsPerEntry) {
    fail(
      "triage_ledger_invalid_entry",
      `${label}.flags must be an array of at most ${maxFlagsPerEntry} strings.`,
    );
  }
  for (const flag of entry.flags) {
    if (typeof flag !== "string" || !flagPattern.test(flag)) {
      fail(
        "triage_ledger_invalid_entry",
        `${label}.flags carries a value that is not a flag token.`,
      );
    }
  }
  if (new Set(entry.flags).size !== entry.flags.length) {
    fail("triage_ledger_invalid_entry", `${label}.flags repeats a flag.`);
  }
  parseInstant(entry.first_seen, "triage_ledger_invalid_entry");
  parseInstant(entry.last_checked, "triage_ledger_invalid_entry");
  if (parseInstant(entry.first_seen) > parseInstant(entry.last_checked)) {
    fail("triage_ledger_invalid_entry", `${label}.first_seen is later than last_checked.`);
  }
  for (const key of ["title", "company", "policy_id"]) {
    if (Object.hasOwn(entry, key)) {
      assertBoundedText(entry[key], key, "triage_ledger_invalid_entry", label);
    }
  }
  if (Object.hasOwn(entry, "priority_class") && ![1, 2, 3].includes(entry.priority_class)) {
    fail("triage_ledger_invalid_entry", `${label}.priority_class must be 1, 2 or 3 when present.`);
  }
}

export function validateLedger(raw) {
  assertExactKeys(
    raw,
    [
      "schema_version",
      "batches",
      "entries",
      ...(raw?.schema_version === 2
        ? ["logical_entries", "source_records", "aliases", "corrections"]
        : []),
    ],
    [],
    "triage_ledger_invalid",
    "The ledger",
  );
  if (![1, 2].includes(raw.schema_version)) {
    fail(
      "triage_ledger_schema_version",
      `The ledger declares schema_version ${String(raw.schema_version)}; this build reads 1 and 2.`,
    );
  }
  if (!Array.isArray(raw.batches) || !Array.isArray(raw.entries)) {
    fail("triage_ledger_invalid", "The ledger must carry array batches and entries.");
  }
  if (raw.entries.length > maxEntries) {
    fail("triage_ledger_invalid", `The ledger holds more than ${maxEntries} entries.`);
  }
  raw.batches.forEach((batch, index) => {
    const label = `batches[${index}]`;
    assertExactKeys(
      batch,
      ["batch_id", "recorded_at", "entry_count", "entries_digest"],
      [
        "policy_id",
        ...(raw.schema_version === 2
          ? [
              "record_schema_version",
              "source_set_sha256",
              "source_resolution_sha256",
              "plan_sha256",
            ]
          : []),
      ],
      "triage_ledger_invalid",
      label,
    );
    assertBoundedText(batch.batch_id, "batch_id", "triage_ledger_invalid", label);
    if (!identifierPattern.test(batch.batch_id)) {
      fail("triage_ledger_invalid", `${label}.batch_id is not an identifier.`);
    }
    parseInstant(batch.recorded_at, "triage_ledger_invalid");
    if (!Number.isSafeInteger(batch.entry_count) || batch.entry_count < 0) {
      fail("triage_ledger_invalid", `${label}.entry_count must be a non-negative integer.`);
    }
    if (typeof batch.entries_digest !== "string" || !digestPattern.test(batch.entries_digest)) {
      fail("triage_ledger_invalid", `${label}.entries_digest must be a sha-256 hex digest.`);
    }
    if (Object.hasOwn(batch, "policy_id")) {
      assertBoundedText(batch.policy_id, "policy_id", "triage_ledger_invalid", label);
    }
    if (Object.hasOwn(batch, "record_schema_version")) {
      if (batch.record_schema_version !== 2)
        fail("triage_ledger_invalid", `${label} declares an unsupported record version.`);
      for (const key of ["source_set_sha256", "source_resolution_sha256", "plan_sha256"])
        assertDigest(batch[key], "triage_ledger_invalid", `${label}.${key}`);
    } else if (
      ["source_set_sha256", "source_resolution_sha256", "plan_sha256"].some((key) =>
        Object.hasOwn(batch, key),
      )
    ) {
      fail("triage_ledger_invalid", `${label} has source digests without a version 2 record.`);
    }
  });
  raw.entries.forEach(validateEntry);
  const keys = new Set();
  for (const entry of raw.entries) {
    if (keys.has(entry.key)) fail("triage_ledger_invalid", `Duplicate ledger key ${entry.key}.`);
    keys.add(entry.key);
  }
  if (raw.schema_version === 2) validateSourceLedgerCollections(raw);
  return raw;
}

function parseLedgerBytes(bytes, path) {
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    fail("triage_ledger_unreadable", `${path} is not valid JSON.`);
  }
  return validateLedger(parsed);
}

/**
 * Reads the ledger. A missing file is a loud failure, never an implicit empty ledger — the same
 * reason `bootstrap --init` is the only creator of `process-log.json`: a read path that
 * materializes the file turns "this session is in the wrong checkout" into a silent success.
 */
export function readLedger(path) {
  let bytes;
  try {
    bytes = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(
        "triage_ledger_missing",
        `${path} does not exist. Create it explicitly with "node tools/triage-ledger.mjs init".`,
      );
    }
    fail(
      "triage_ledger_unreadable",
      `${path} could not be read (${error?.code ?? "unknown error"}).`,
    );
  }
  return parseLedgerBytes(bytes, path);
}

function serializeLedger(ledger) {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

export function initLedger(path, options = {}) {
  const initial = emptyLedger(options);
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") return { created: false, path };
    fail(
      "triage_ledger_unwritable",
      `${path} could not be created (${error?.code ?? "unknown error"}).`,
    );
  }
  try {
    writeSync(descriptor, serializeLedger(initial));
  } finally {
    closeSync(descriptor);
  }
  return { created: true, path };
}

function acquireLock(path) {
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt <= lockRetries; attempt += 1) {
    try {
      mkdirSync(lockPath);
      return lockPath;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        fail(
          "triage_ledger_unwritable",
          `${lockPath} could not be created (${error?.code ?? "unknown error"}).`,
        );
      }
      if (attempt === lockRetries) break;
      Atomics.wait(lockWaitBuffer, 0, 0, lockRetryDelayMs);
    }
  }
  fail(
    "triage_ledger_locked",
    `${lockPath} is held by another writer. Inspect it before removing it by hand; this tool ` +
      "never removes a lock it did not create.",
  );
}

function writeWithinLock(path, ledger) {
  const temporaryPath = join(
    dirname(path),
    `${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const bytes = serializeLedger(validateLedger(ledger));
  try {
    writeFileSync(temporaryPath, bytes, { mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    // A partial temp file is worse than no temp file: it survives every future run as a
    // truncated look-alike of the ledger, so it goes even when the write itself failed.
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The write failure is the reportable one; an unremovable temp file is diagnostic.
    }
    fail(
      "triage_ledger_unwritable",
      `${path} could not be replaced (${error?.code ?? "unknown error"}).`,
    );
  }
}

export function withLedgerLock(path, operate) {
  const lockPath = acquireLock(path);
  try {
    const ledger = readLedger(path);
    const outcome = operate(ledger) ?? {};
    if (outcome.changed !== false) writeWithinLock(path, outcome.ledger ?? ledger);
    return outcome.result;
  } finally {
    try {
      rmdirSync(lockPath);
    } catch {
      // A lock we cannot release is reported by the next writer, which is the actor that cares.
    }
  }
}

function validateBatch(batch) {
  assertExactKeys(
    batch,
    ["batch_id", "observed_at", "entries"],
    ["policy_id"],
    "triage_ledger_invalid_batch",
    "The batch",
  );
  assertBoundedText(batch.batch_id, "batch_id", "triage_ledger_invalid_batch", "The batch");
  if (!identifierPattern.test(batch.batch_id)) {
    fail("triage_ledger_invalid_batch", "batch_id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}.");
  }
  parseInstant(batch.observed_at, "triage_ledger_invalid_batch");
  if (Object.hasOwn(batch, "policy_id")) {
    assertBoundedText(batch.policy_id, "policy_id", "triage_ledger_invalid_batch", "The batch");
  }
  if (!Array.isArray(batch.entries) || batch.entries.length === 0) {
    fail("triage_ledger_invalid_batch", "A batch must carry at least one entry.");
  }
  if (batch.entries.length > maxEntries) {
    fail("triage_ledger_invalid_batch", `A batch carries at most ${maxEntries} entries.`);
  }
}

function normalizeBatchEntry(raw, index, batch) {
  const label = `batch entry ${index}`;
  assertExactKeys(
    raw,
    ["url", "status", "decision", "flags"],
    ["title", "company", "priority_class"],
    "triage_ledger_invalid_batch",
    label,
  );
  // Identity is derived, never supplied. `planBatch` can only ever look a row up by the identity
  // its URL produces, so a caller-chosen key would write a row batch-start could never find — and
  // could park it on another vacancy's key, which would silently skip a vacancy nobody triaged.
  const identity = vacancyIdentity(raw.url);
  const entry = {
    key: identity.key,
    source: identity.source,
    job_id: identity.jobId,
    url: identity.url,
    first_seen: batch.observed_at,
    last_checked: batch.observed_at,
    status: raw.status,
    batch_id: batch.batch_id,
    decision: raw.decision,
    flags: Array.isArray(raw.flags) ? [...raw.flags].sort() : raw.flags,
  };
  for (const key of ["title", "company", "priority_class"]) {
    if (Object.hasOwn(raw, key)) entry[key] = raw[key];
  }
  if (Object.hasOwn(batch, "policy_id")) entry.policy_id = batch.policy_id;
  validateEntry(entry, index);
  return entry;
}

/**
 * The digest of a batch's rows, in the order the ledger itself stores them rather than the order
 * the caller happened to assemble: a retry that rebuilds the same batch from concurrent fetches
 * may hand the entries over shuffled, and that is the same batch, not a different one.
 *
 * One function, two readers: it stamps `ledger.batches[]` and it stamps the batch record, so a
 * caller holding both can compare them without either side recomputing the other's arithmetic
 * differently.
 */
function digestEntries(entries) {
  return createHash("sha256")
    .update(JSON.stringify([...entries].sort((left, right) => left.key.localeCompare(right.key))))
    .digest("hex");
}

/**
 * Shape check for a batch record read back off disk.
 *
 * The digest is recomputed rather than believed: a record whose `entries_digest` does not describe
 * its own `entries` is not a record of anything, and it is the shape a torn write leaves behind.
 */
export function validateBatchRecord(raw) {
  if (raw?.schema_version === 2) return validateSourceBatchRecord(raw);
  assertExactKeys(
    raw,
    ["schema_version", "batch_id", "observed_at", "policy_id", "entries_digest", "entries"],
    [],
    "triage_ledger_record_unreadable",
    "The batch record",
  );
  if (raw.schema_version !== triageBatchRecordSchemaVersion) {
    fail(
      "triage_ledger_record_schema_version",
      `The batch record declares schema_version ${String(raw.schema_version)}; this build reads ` +
        `${triageBatchRecordSchemaVersion}.`,
    );
  }
  const label = "The batch record";
  for (const key of ["batch_id", "policy_id"]) {
    assertBoundedText(raw[key], key, "triage_ledger_record_unreadable", label);
  }
  if (!identifierPattern.test(raw.batch_id)) {
    fail("triage_ledger_record_unreadable", `${label} batch_id is not an identifier.`);
  }
  parseInstant(raw.observed_at, "triage_ledger_record_unreadable");
  if (typeof raw.entries_digest !== "string" || !digestPattern.test(raw.entries_digest)) {
    fail("triage_ledger_record_unreadable", `${label} entries_digest is not a sha-256 hex digest.`);
  }
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) {
    fail("triage_ledger_record_unreadable", `${label} must carry at least one entry.`);
  }
  if (raw.entries.length > maxEntries) {
    fail("triage_ledger_record_unreadable", `${label} holds more than ${maxEntries} entries.`);
  }
  // A row that is not a valid ledger row makes the record unreadable *as a record*, so it is
  // reported that way rather than in the ledger's own entry vocabulary: the repair table an
  // operator reads is keyed by the record codes, and a hand-edited row is exactly the case that
  // table exists for.
  raw.entries.forEach((entry, index) => {
    try {
      validateEntry(entry, index);
    } catch (error) {
      // Only a verdict about the data is translated. Anything else is a defect in this code, and
      // relabelling it would hand the operator a code whose repair is "delete the file" for a file
      // that is intact — the mirror of the guard `readBatchRecord` puts on its own read.
      if (!(error instanceof TriageLedgerError)) throw error;
      fail(
        "triage_ledger_record_unreadable",
        `${label} carries a row that is not a valid ledger row: ${error.message}`,
      );
    }
  });
  for (const entry of raw.entries) {
    if (entry.batch_id !== raw.batch_id) {
      fail("triage_ledger_record_unreadable", `${label} carries a row of another batch.`);
    }
  }
  if (digestEntries(raw.entries) !== raw.entries_digest) {
    fail(
      "triage_ledger_record_unreadable",
      `${label} does not match its own entries_digest; it is not a record of the rows it holds.`,
    );
  }
  return raw;
}

/**
 * Read one batch's record out of its directory.
 *
 * Self-validation is all this does: shape, and the digest against its own rows. Whether that
 * digest also matches `ledger.batches[]` is a question only a caller holding both can ask, and it
 * is left to that caller rather than answered here with a ledger path this function does not have.
 */
export function readBatchRecord(artifactsDir) {
  const recordPath = join(artifactsDir, triageBatchRecordFileName);
  let bytes;
  try {
    const stats = statSync(recordPath);
    if (!stats.isFile()) {
      fail("triage_ledger_record_unreadable", `${recordPath} is not a regular file.`);
    }
    if (stats.size > maxRecordBytes) {
      fail("triage_ledger_record_unreadable", `${recordPath} exceeds ${maxRecordBytes} bytes.`);
    }
    bytes = readFileSync(recordPath, "utf8");
  } catch (error) {
    if (error instanceof TriageLedgerError) throw error;
    if (error?.code === "ENOENT") {
      fail("triage_ledger_record_absent", `${recordPath} does not exist.`);
    }
    fail(
      "triage_ledger_record_unreadable",
      `${recordPath} could not be read (${error?.code ?? "unknown error"}).`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    fail("triage_ledger_record_unreadable", `${recordPath} is not valid JSON.`);
  }
  return validateBatchRecord(parsed);
}

/**
 * Where this write keeps its history, declared rather than defaulted.
 *
 * The argument is required and its two forms are both explicit: a directory archives the batch,
 * and `null` states on purpose that this write keeps none — synthetic prior state, a disposable
 * test root. An omitted argument used to mean the second silently, which is how the batch of
 * 2026-08-26 lost fifteen traces: the store cannot rest on a caller remembering it.
 */
function resolveArchiveTarget(batch, options) {
  if (!isRecord(options) || !Object.hasOwn(options, "artifactsDir")) {
    fail(
      "triage_ledger_record_undeclared",
      "recordBatch needs its history declared: pass {artifactsDir: <absolute batch directory>} to " +
        "archive this batch, or {artifactsDir: null} to state that this write keeps none.",
    );
  }
  assertExactKeys(options, ["artifactsDir"], [], "triage_ledger_record_undeclared", "The options");
  const target = options.artifactsDir;
  if (target === null) return null;
  if (typeof target !== "string" || !isAbsolute(target)) {
    fail(
      "triage_ledger_record_dir_invalid",
      "artifactsDir must be an absolute path to the batch's own directory, or null.",
    );
  }
  // An archived decision that cannot say which policy produced it is not readable beside a later
  // one, which is the whole point of keeping both.
  if (!Object.hasOwn(batch, "policy_id")) {
    fail(
      "triage_ledger_record_missing_policy",
      "An archived batch records the policy its decisions were taken under: batch.policy_id is " +
        "required whenever artifactsDir names a directory.",
    );
  }
  return target;
}

/**
 * Write the batch record, or accept the one already there.
 *
 * Exclusive create at the final name, deliberately not the ledger's own temp-and-rename: rename
 * overwrites unconditionally, and a store whose whole promise is that a record survives its
 * session must have no writer that can replace one. The cost is that a crash can leave a
 * truncated file; it is answered rather than avoided — such a file fails its own digest and is
 * reported as unreadable, which is a different remediation from a digest that disagrees.
 */
function persistBatchRecord(artifactsDir, record) {
  const recordPath = join(artifactsDir, triageBatchRecordFileName);
  let descriptor;
  try {
    descriptor = openSync(recordPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      const existing = readBatchRecord(artifactsDir);
      if (
        existing.entries_digest !== record.entries_digest ||
        existing.batch_id !== record.batch_id
      ) {
        fail(
          "triage_ledger_record_conflict",
          `${recordPath} already records different entries. Replaying the same batch is allowed; ` +
            "a different one belongs in its own batch directory under its own batch_id, or the " +
            "record would stop describing the batch it is named for.",
        );
      }
      return { path: recordPath, written: false };
    }
    if (error?.code === "ENOENT") {
      fail(
        "triage_ledger_record_dir_missing",
        `${artifactsDir} does not exist. The batch's own directory is where its record belongs; ` +
          "this tool never creates it, because a directory it invented would hold no batch.",
      );
    }
    fail(
      "triage_ledger_record_unwritable",
      `${recordPath} could not be created (${error?.code ?? "unknown error"}).`,
    );
  }
  try {
    writeSync(descriptor, `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    // Every other exit of this module carries a code; a full disk here would otherwise escape as a
    // raw fs error. The file it leaves behind is the torn case the runbook's repair table answers.
    fail(
      "triage_ledger_record_unwritable",
      `${recordPath} could not be written (${error?.code ?? "unknown error"}).`,
    );
  } finally {
    closeSync(descriptor);
  }
  return { path: recordPath, written: true };
}

/**
 * The vacancy identities the batch directory holds a Decision Trace for.
 *
 * An entry is a statement that this batch observed a vacancy, and the trace is that observation.
 * A link the plan withheld has neither, so an entry for it would move `last_checked` and
 * `batch_id` of a row nobody looked at. A trace that cannot be read, or whose `source_ref` yields
 * no identity, stands for nothing and throws nothing: the verification suite owns trace quality,
 * and this guard only asks whether an observation exists.
 *
 * A missing batch directory is answered here with the code the archive write gives it, because
 * this read comes first; a directory without `traces/` is a batch that observed nothing.
 */
function tracedKeys(artifactsDir) {
  try {
    if (!statSync(artifactsDir).isDirectory()) throw Object.assign(new Error(), { code: "ENOENT" });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      fail(
        "triage_ledger_record_dir_missing",
        `${artifactsDir} does not exist. The batch's own directory is where its record belongs; ` +
          "this tool never creates it, because a directory it invented would hold no batch.",
      );
    }
    throw error;
  }
  const keys = new Set();
  let names;
  try {
    names = readdirSync(join(artifactsDir, triageBatchTracesDirName));
  } catch {
    return keys;
  }
  for (const name of names) {
    if (!triageBatchTraceFilePattern.test(name)) continue;
    try {
      const path = join(artifactsDir, triageBatchTracesDirName, name);
      if (statSync(path).size > maxRecordBytes) continue;
      const trace = JSON.parse(readFileSync(path, "utf8"));
      keys.add(vacancyIdentity(trace?.source_ref).key);
    } catch {
      // Stands for nothing.
    }
  }
  return keys;
}

/**
 * Whether the batch directory already holds this batch's own record.
 *
 * `matching` is the orphan the review runbook docs/runbooks/triage-review.md#11-batch-store-the-history-beside-the-index names — a record whose ledger write failed —
 * and the replay that finishes it must not be judged against a plan that predates the rows other
 * batches wrote in between. A record of another batch, or of this id with other entries, is the
 * store's conflict and is refused with the store's code, exactly as `persistBatchRecord` would
 * refuse it a step later; a torn or foreign file is unreadable, as `readBatchRecord` says.
 */
function persistedRecordState(artifactsDir, batchId, entriesDigest) {
  const recordPath = join(artifactsDir, triageBatchRecordFileName);
  try {
    statSync(recordPath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "absent";
    fail(
      "triage_ledger_record_unreadable",
      `${recordPath} could not be read (${error?.code ?? "unknown error"}).`,
    );
  }
  const existing = readBatchRecord(artifactsDir);
  if (existing.entries_digest !== entriesDigest || existing.batch_id !== batchId) {
    fail(
      "triage_ledger_record_conflict",
      `${recordPath} already records different entries. Replaying the same batch is allowed; ` +
        "a different one belongs in its own batch directory under its own batch_id, or the " +
        "record would stop describing the batch it is named for.",
    );
  }
  return "matching";
}

/**
 * The batch's plan, read back from its directory as rows keyed by derived identity.
 *
 * The key is derived from each item's `link`, never read from the item: the plan is a file the
 * batch wrote about itself, and `tools/triage-verify/plan.mjs` states the rule this shares — no
 * field of it is believed that the reader cannot derive or corroborate. An item whose link yields
 * no identity is one `planBatch` returned with `action: null`, and no entry can exist for it. The
 * first row per key wins, as it does there: a second spelling of one posting is the same vacancy.
 */
function readBatchPlan(artifactsDir) {
  const planPath = join(artifactsDir, triageBatchPlanFileName);
  let bytes;
  try {
    const stats = statSync(planPath);
    if (!stats.isFile()) fail("triage_ledger_plan_invalid", `${planPath} is not a regular file.`);
    if (stats.size > maxRecordBytes) {
      fail("triage_ledger_plan_invalid", `${planPath} exceeds ${maxRecordBytes} bytes.`);
    }
    bytes = readFileSync(planPath, "utf8");
  } catch (error) {
    if (error instanceof TriageLedgerError) throw error;
    if (error?.code === "ENOENT") {
      fail(
        "triage_ledger_plan_undeclared",
        `${planPath} does not exist. A recorded batch names the plan it ran on: the planBatch ` +
          "result written into its directory before its first fetch, which is what the record " +
          "write checks its rows against. Without it a row another session wrote in between " +
          "would be replaced silently.",
      );
    }
    fail(
      "triage_ledger_plan_invalid",
      `${planPath} could not be read (${error?.code ?? "unknown error"}).`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    fail("triage_ledger_plan_invalid", `${planPath} is not valid JSON.`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
    fail("triage_ledger_plan_invalid", `${planPath} is not the shape planBatch writes.`);
  }
  const byKey = new Map();
  for (const item of parsed.items) {
    if (!isRecord(item) || typeof item.link !== "string" || typeof item.action !== "string")
      continue;
    let key;
    try {
      // Trimmed as `tools/triage-verify/plan.mjs#readPlan` trims it, so the two readers of this file
      // agree on which items are rows.
      key = vacancyIdentity(item.link.trim()).key;
    } catch {
      continue;
    }
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return byKey;
}

function sameFlags(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((flag, index) => flag === sortedRight[index]);
}

/**
 * The optimistic check behind a concurrent batch: every row an entry replaces is the row the plan
 * saw. A `fetch_new` item saw no row, so a row now is another batch's observation taken since; a
 * known item saw the five fields the plan carries about a row, and any of them moving since is the
 * same. Only the ledger's own fields are compared — `batch_id` is deliberately not one of them,
 * because a row that differs in nothing but which batch wrote it is the same observation for every
 * purpose the ledger serves, and the plan carries no such field for the verify suite to corroborate.
 *
 * An entry the plan has no item for is a link this batch was never asked about: it is refused on
 * its own code rather than checked against nothing.
 */
function assertRowsUnmovedSincePlan(planByKey, entries, ledgerEntries) {
  const byKey = new Map(ledgerEntries.map((entry) => [entry.key, entry]));
  const unplanned = [];
  const moved = [];
  for (const entry of entries) {
    const item = planByKey.get(entry.key);
    if (item === undefined) {
      unplanned.push(entry.key);
      continue;
    }
    const known = byKey.get(entry.key);
    if (item.action === "fetch_new") {
      if (known !== undefined) moved.push(entry.key);
      continue;
    }
    const unmoved =
      known !== undefined &&
      known.status === item.status &&
      known.decision === item.decision &&
      sameFlags(known.flags, item.flags) &&
      known.last_checked === item.last_checked &&
      (Object.hasOwn(known, "policy_id")
        ? known.policy_id === item.policy_id
        : !Object.hasOwn(item, "policy_id"));
    if (!unmoved) moved.push(entry.key);
  }
  if (unplanned.length > 0) {
    fail(
      "triage_ledger_entry_unplanned",
      `${unplanned.length} of ${entries.length} entries are not in the batch's plan: ` +
        `${unplanned.sort().join(", ")}. A batch records only links it planned; a link outside ` +
        "the plan belongs to another batch.",
    );
  }
  if (moved.length > 0) {
    fail(
      "triage_ledger_concurrent_observation",
      `${moved.length} of ${entries.length} entries replace a row another batch wrote after this ` +
        `batch planned: ${moved.sort().join(", ")}. The row stays with the batch that recorded ` +
        "first; drop these entries and record again — their traces stay in this batch's " +
        "directory as what it observed.",
    );
  }
}

/**
 * Batch-end write. Upsert by `source:job_id`: `first_seen` is the one field a re-triage may never
 * move forward, `last_checked` never moves backward, and every other field is replaced by the
 * newer observation. The returned summary is what the skill reports in chat, so it names both
 * halves — what the batch added and what it refreshed.
 *
 * The upsert is why the store exists. The row it leaves behind is the current state of a vacancy
 * and nothing else: the decision it replaced is gone from the ledger the moment this returns. So
 * before the ledger is written, the batch's own immutable record goes into the batch directory,
 * and the two are ordered on purpose — a record without its ledger row is a batch to replay,
 * while a ledger row without its record would be history already lost.
 */
export function recordBatch(path, batch, options) {
  verifyOperationalFolder();
  validateBatch(batch);
  const archiveDir = resolveArchiveTarget(batch, options);
  const entries = batch.entries.map((raw, index) => normalizeBatchEntry(raw, index, batch));
  const keys = new Set();
  for (const entry of entries) {
    if (keys.has(entry.key)) {
      fail(
        "triage_ledger_invalid_batch",
        `The batch repeats ${entry.key}; deduplicate before recording.`,
      );
    }
    keys.add(entry.key);
  }
  const entriesDigest = digestEntries(entries);
  return withLedgerLock(path, (ledger) => {
    const previous = ledger.batches.find((known) => known.batch_id === batch.batch_id);
    if (previous !== undefined && previous.entries_digest !== entriesDigest) {
      fail(
        "triage_ledger_batch_id_reused",
        `Batch ${batch.batch_id} is already recorded with different entries. Replaying the same ` +
          "batch is allowed; recording a different one needs its own batch_id, or the batch " +
          "record would stop describing the rows that carry its id.",
      );
    }
    // One entry per published trace. A replay of a batch this ledger already holds is exempt: it
    // was checked when it was first recorded, and the repair a refusal asks for — drop the entry —
    // would change its digest and turn an allowed replay into a reused id.
    if (archiveDir !== null && previous === undefined) {
      const traced = tracedKeys(archiveDir);
      const untraced = entries.filter((entry) => !traced.has(entry.key)).map((entry) => entry.key);
      if (untraced.length > 0) {
        fail(
          "triage_ledger_entry_without_trace",
          `${untraced.length} of ${entries.length} entries have no Decision Trace under ` +
            `${join(archiveDir, triageBatchTracesDirName)}. A batch records one entry per trace ` +
            "it published; a link its plan withheld gets no entry and its row stays as it is.",
        );
      }
    }
    // The rows this batch replaces must be the rows its plan saw. A batch whose record is already
    // on disk — the orphan of a ledger write that failed after the record — has committed its
    // observation and is only finishing the ledger half, so the guard does not run for it; a
    // directory holding another batch's record is the store's own conflict, reported here in the
    // store's own vocabulary before the guard could name it something else.
    if (archiveDir !== null && previous === undefined) {
      const existing = persistedRecordState(archiveDir, batch.batch_id, entriesDigest);
      if (existing === "absent") {
        assertRowsUnmovedSincePlan(readBatchPlan(archiveDir), entries, ledger.entries);
      }
    }
    // After the reuse guard and before the ledger write, in that order: a batch this ledger
    // already knows under different entries is refused before anything reaches the store, and a
    // record that fails to persist stops the ledger write with it.
    const archived =
      archiveDir === null
        ? null
        : persistBatchRecord(archiveDir, {
            schema_version: triageBatchRecordSchemaVersion,
            batch_id: batch.batch_id,
            observed_at: batch.observed_at,
            policy_id: batch.policy_id,
            entries_digest: entriesDigest,
            entries,
          });
    const byKey = new Map(ledger.entries.map((entry) => [entry.key, entry]));
    const added = [];
    const updated = [];
    for (const entry of entries) {
      const known = byKey.get(entry.key);
      if (known === undefined) {
        added.push(entry.key);
        byKey.set(entry.key, entry);
        continue;
      }
      updated.push(entry.key);
      // Vacancy-scoped facts (title, company, priority_class) survive a batch that did not
      // observe them: a fetch that failed must not silently delete the class the review report
      // orders by. Decision-scoped fields — status, decision, flags, batch_id and
      // policy_id — are always the newer observation, so a stale policy_id can never end up
      // attached to a fresh decision.
      const carried = {};
      for (const key of ["title", "company", "priority_class"]) {
        if (!Object.hasOwn(entry, key) && Object.hasOwn(known, key)) carried[key] = known[key];
      }
      byKey.set(entry.key, {
        ...entry,
        ...carried,
        first_seen:
          parseInstant(known.first_seen) <= parseInstant(entry.first_seen)
            ? known.first_seen
            : entry.first_seen,
        last_checked:
          parseInstant(known.last_checked) >= parseInstant(entry.last_checked)
            ? known.last_checked
            : entry.last_checked,
      });
    }
    const nextEntries = [...byKey.values()].sort((left, right) =>
      left.key.localeCompare(right.key),
    );
    const batchRecord = {
      batch_id: batch.batch_id,
      recorded_at: batch.observed_at,
      entry_count: entries.length,
      entries_digest: entriesDigest,
      ...(Object.hasOwn(batch, "policy_id") ? { policy_id: batch.policy_id } : {}),
    };
    const batches = [
      ...ledger.batches.filter((known) => known.batch_id !== batch.batch_id),
      batchRecord,
    ].sort(
      (left, right) =>
        parseInstant(left.recorded_at) - parseInstant(right.recorded_at) ||
        left.batch_id.localeCompare(right.batch_id),
    );
    return {
      ledger: { ...ledger, batches, entries: nextEntries },
      result: {
        batch_id: batch.batch_id,
        added: added.sort(),
        updated: updated.sort(),
        ledger_entries: nextEntries.length,
        // An operator-owned path and two booleans: where this batch's history went, and whether
        // this call wrote it or found a replay's record already there. No vacancy value.
        record: archived === null ? null : { path: archived.path, written: archived.written },
      },
    };
  });
}

/**
 * Batch-start read. Every supplied link is classified against the ledger before a byte is fetched,
 * by what the ledger holds and never by a date: closed and expired links are never fetched again,
 * a row whose last fetch failed is retried, and every other known link is reported as known
 * instead of being silently re-spent. `asOf` stamps the plan and decides nothing. Input order is
 * preserved — the plan is advice with a reason attached, never a rewritten batch.
 */
export function planBatch(ledger, links, { asOf } = {}) {
  verifyOperationalFolder();
  validateLedger(ledger);
  if (!Array.isArray(links)) fail("triage_ledger_invalid_links", "Links must be an array.");
  if (links.length > maxEntries) {
    fail("triage_ledger_invalid_links", `At most ${maxEntries} links can be planned at once.`);
  }
  parseInstant(asOf, "triage_ledger_invalid_instant");
  const byKey = new Map(ledger.entries.map((entry) => [entry.key, entry]));
  const seen = new Set();
  const items = links.map((link, index) => {
    let identity;
    try {
      identity = vacancyIdentity(link);
    } catch (error) {
      return {
        input_index: index + 1,
        link: typeof link === "string" ? link.slice(0, 200) : null,
        action: null,
        reason: error instanceof TriageLedgerError ? error.code : "triage_ledger_invalid_url",
      };
    }
    const duplicate = seen.has(identity.key);
    seen.add(identity.key);
    const known = byKey.get(identity.key);
    const base = {
      input_index: index + 1,
      link,
      key: identity.key,
      source: identity.source,
      url: identity.url,
      duplicate_in_batch: duplicate,
    };
    if (known === undefined) return { ...base, action: "fetch_new", reason: "not in the ledger" };
    const shared = {
      ...base,
      status: known.status,
      decision: known.decision,
      flags: known.flags,
      // The policy the baseline decision was taken under, carried beside the decision it belongs
      // to. Without it a decision that moved because the policy moved is indistinguishable from
      // one that moved because the page did — epic 007's named residual, and the reason the two
      // travel together rather than as separate lookups.
      ...(Object.hasOwn(known, "policy_id") ? { policy_id: known.policy_id } : {}),
      last_checked: known.last_checked,
      ...(Object.hasOwn(known, "priority_class") ? { priority_class: known.priority_class } : {}),
    };
    if (known.status !== "open") {
      return { ...shared, action: "skip_closed", reason: `ledger status ${known.status}` };
    }
    if (known.decision === triageRetryDecision) {
      return { ...shared, action: "retry_blocked", reason: "last fetch failed" };
    }
    return { ...shared, action: "skip_known", reason: "already triaged" };
  });
  const counts = Object.fromEntries(
    triagePlanActions.map((action) => [
      action,
      items.filter((item) => item.action === action).length,
    ]),
  );
  return {
    as_of: asOf,
    links_in: links.length,
    counts: { ...counts, invalid: items.filter((item) => item.action === null).length },
    fetch: items.filter((item) => item.action === "fetch_new" || item.action === "retry_blocked")
      .length,
    items,
  };
}

// Version 2 adds card identities alongside the unchanged URL observations. It never rewrites a
// URL key, gives vacancy_no identity semantics, or infers a contextual role from a bare URL.
const logicalKeyPattern = /^logical:[0-9a-f]{64}$/u;
const maxSourceRecords = 16384;
const identityStatuses = ["confirmed", "linked_unconfirmed", "different"];

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertDigest(value, code, label) {
  if (typeof value !== "string" || !digestPattern.test(value))
    fail(code, `${label} must be a sha-256 hex digest.`);
}

/** Also accepts the explicit card + source seed used for separately identified publications. */
export function logicalVacancyKey(cardRef) {
  if (typeof cardRef !== "string" || cardRef.length === 0 || Buffer.byteLength(cardRef) > 8192) {
    fail("triage_ledger_source_identity", "A bounded immutable card identity is required.");
  }
  return `logical:${hashBytes(cardRef)}`;
}

function assertCardReference(value, code, label) {
  if (typeof value !== "string" || !cardRefPattern.test(value))
    fail(code, `${label} is not an immutable card reference.`);
}

function validateLogicalEntry(entry, index, code = "triage_ledger_invalid") {
  const label = `logical_entries[${index}]`;
  assertExactKeys(
    entry,
    [
      "key",
      "card_refs",
      "identity_status",
      "primary_ref",
      "first_seen",
      "last_checked",
      "status",
      "batch_id",
      "decision",
      "flags",
      "policy_id",
    ],
    ["title", "company", "priority_class"],
    code,
    label,
  );
  if (!logicalKeyPattern.test(entry.key ?? "") || !identityStatuses.includes(entry.identity_status))
    fail(code, `${label} has an invalid logical identity.`);
  if (
    !Array.isArray(entry.card_refs) ||
    entry.card_refs.length === 0 ||
    entry.card_refs.length > maxEntries ||
    new Set(entry.card_refs).size !== entry.card_refs.length
  )
    fail(code, `${label} must name unique immutable cards.`);
  for (const ref of entry.card_refs) assertCardReference(ref, code, label);
  if (entry.primary_ref !== null) assertBoundedText(entry.primary_ref, "primary_ref", code, label);
  // The liveness/decision contract is shared with URL observations, but its identity is not.
  const url = "https://ledger.example/validation";
  const legacy = { key: `url:${url}`, source: "url", job_id: url, url };
  for (const key of [
    "first_seen",
    "last_checked",
    "status",
    "batch_id",
    "decision",
    "flags",
    "policy_id",
    "title",
    "company",
    "priority_class",
  ]) {
    if (Object.hasOwn(entry, key)) legacy[key] = entry[key];
  }
  try {
    validateEntry(legacy, index);
  } catch (error) {
    if (!(error instanceof TriageLedgerError)) throw error;
    fail(code, `${label} has an invalid observation: ${error.message}`);
  }
}

function membershipKey(record) {
  return hashBytes(
    JSON.stringify([record.logical_key, record.card_ref, record.anchor, record.role, record.url]),
  );
}

function validateSourceRecord(record, index, code = "triage_ledger_invalid") {
  const label = `source_records[${index}]`;
  assertExactKeys(
    record,
    [
      "membership_key",
      "logical_key",
      "card_ref",
      "snapshot_ref",
      "anchor",
      "role",
      "url",
      "disposition",
      "observation_ref",
      "batch_id",
      "observed_at",
    ],
    ["observation_decision", "observation_status"],
    code,
    label,
  );
  assertCardReference(record.card_ref, code, label);
  if (
    !logicalKeyPattern.test(record.logical_key ?? "") ||
    !snapshotRefPattern.test(record.snapshot_ref ?? "") ||
    !sourceRoles.includes(record.role) ||
    (record.anchor !== null && (!Number.isSafeInteger(record.anchor) || record.anchor < 1))
  )
    fail(code, `${label} has invalid membership fields.`);
  for (const key of ["url", "disposition", "batch_id"])
    assertBoundedText(record[key], key, code, label);
  if (!record.url.startsWith("mailto:")) {
    try {
      normalizeVacancyUrl(record.url);
    } catch (error) {
      if (!(error instanceof TriageLedgerError)) throw error;
      fail(code, `${label} has an unsupported source URL.`);
    }
  }
  if (!identifierPattern.test(record.batch_id) || !flagPattern.test(record.disposition))
    fail(code, `${label} has invalid bounded tokens.`);
  if (record.observation_ref !== null)
    assertBoundedText(record.observation_ref, "observation_ref", code, label);
  const decision = record.observation_decision;
  const status = record.observation_status;
  if (Object.hasOwn(record, "observation_decision") !== Object.hasOwn(record, "observation_status"))
    fail(code, `${label} has an incomplete source observation.`);
  if (Object.hasOwn(record, "observation_decision")) {
    if (
      (decision === null) !== (status === null) ||
      (decision !== null &&
        (typeof decision !== "string" ||
          !decisionPattern.test(decision) ||
          !["open", "closed"].includes(status) ||
          record.observation_ref === null ||
          ["company_context", "contact"].includes(record.role)))
    )
      fail(code, `${label} has invalid source decision or liveness.`);
    if (
      decision === triageRetryDecision &&
      (status !== "open" || record.disposition !== "technical_unavailable")
    )
      fail(code, `${label} cannot claim a BLOCKED source without a typed technical failure.`);
    if (status === "closed" && (decision !== "SKIP" || record.disposition !== "closed"))
      fail(code, `${label} cannot claim a closed source without its terminal disposition.`);
  }
  parseInstant(record.observed_at, code);
  if (record.membership_key !== membershipKey(record))
    fail(code, `${label} does not match its own membership key.`);
}

function validateAlias(alias, index, code = "triage_ledger_invalid") {
  const label = `aliases[${index}]`;
  assertExactKeys(
    alias,
    [
      "card_ref",
      "logical_key",
      "batch_id",
      "parent_batch_id",
      "parent_entries_digest",
      "parent_record_sha256",
      "observation_ref",
      "parent_observation_ref",
    ],
    [],
    code,
    label,
  );
  assertCardReference(alias.card_ref, code, label);
  if (!logicalKeyPattern.test(alias.logical_key ?? ""))
    fail(code, `${label} has an invalid logical key.`);
  for (const key of ["batch_id", "parent_batch_id", "observation_ref", "parent_observation_ref"])
    assertBoundedText(alias[key], key, code, label);
  if (!identifierPattern.test(alias.batch_id) || !identifierPattern.test(alias.parent_batch_id))
    fail(code, `${label} has an invalid batch reference.`);
  for (const key of ["parent_entries_digest", "parent_record_sha256"])
    assertDigest(alias[key], code, `${label}.${key}`);
}

function correctionKey(record) {
  return hashBytes(
    JSON.stringify([
      record.entry_key,
      record.parent_batch_id,
      record.parent_entries_digest,
      record.card_ref,
      record.anchor,
    ]),
  );
}

function validateCorrection(correction, index, code = "triage_ledger_invalid") {
  const label = `corrections[${index}]`;
  assertExactKeys(
    correction,
    [
      "correction_key",
      "entry_key",
      "parent_batch_id",
      "parent_entries_digest",
      "parent_record_sha256",
      "parent_last_checked",
      "card_ref",
      "logical_key",
      "snapshot_ref",
      "anchor",
      "url",
      "batch_id",
      "recorded_at",
    ],
    [],
    code,
    label,
  );
  assertCardReference(correction.card_ref, code, label);
  if (
    !snapshotRefPattern.test(correction.snapshot_ref ?? "") ||
    !logicalKeyPattern.test(correction.logical_key ?? "") ||
    !Number.isSafeInteger(correction.anchor) ||
    correction.anchor < 1
  )
    fail(code, `${label} has invalid source evidence.`);
  for (const key of ["entry_key", "url", "batch_id", "parent_batch_id"])
    assertBoundedText(correction[key], key, code, label);
  if (
    !identifierPattern.test(correction.batch_id) ||
    !identifierPattern.test(correction.parent_batch_id) ||
    correction.entry_key !== vacancyIdentity(correction.url).key
  )
    fail(code, `${label} has an invalid parent observation identity.`);
  for (const key of ["parent_entries_digest", "parent_record_sha256"])
    assertDigest(correction[key], code, `${label}.${key}`);
  parseInstant(correction.parent_last_checked, code);
  parseInstant(correction.recorded_at, code);
  if (correction.correction_key !== correctionKey(correction))
    fail(code, `${label} does not match its own correction key.`);
}

function assertUnique(records, key, code, label) {
  const values = new Set();
  for (const record of records) {
    if (values.has(record[key])) fail(code, `${label} repeats ${key}.`);
    values.add(record[key]);
  }
}

function validateSourceLedgerCollections(raw, code = "triage_ledger_invalid") {
  for (const [key, validator, limit, unique] of [
    ["logical_entries", validateLogicalEntry, maxEntries, "key"],
    ["source_records", validateSourceRecord, maxSourceRecords, "membership_key"],
    ["aliases", validateAlias, maxSourceRecords, "card_ref"],
    ["corrections", validateCorrection, maxSourceRecords, "correction_key"],
  ]) {
    if (!Array.isArray(raw[key]) || raw[key].length > limit)
      fail(code, `${key} must be an array of at most ${limit} records.`);
    raw[key].forEach((item, index) => validator(item, index, code));
    assertUnique(raw[key], unique, code, key);
  }
}

/** An explicit contract upgrade. Every v1 URL row and batch digest remains byte-for-byte data. */
export function upgradeLedger(path) {
  verifyOperationalFolder();
  return withLedgerLock(path, (ledger) => {
    if (ledger.schema_version === 2)
      return { changed: false, result: { upgraded: false, schema_version: 2 } };
    return {
      ledger: {
        ...ledger,
        schema_version: 2,
        logical_entries: [],
        source_records: [],
        aliases: [],
        corrections: [],
      },
      result: { upgraded: true, schema_version: 2, retained_url_entries: ledger.entries.length },
    };
  });
}

function requireSourceLedger(ledger) {
  validateLedger(ledger);
  if (ledger.schema_version !== 2)
    fail(
      "triage_ledger_upgrade_required",
      "Source-aware triage requires an explicit upgradeLedger(path) from ledger version 1 to 2.",
    );
  return ledger;
}

function checkedSourceSet(set, options) {
  try {
    return validateSourceSet(set, options);
  } catch (error) {
    if (!error?.code) throw error;
    fail(
      "triage_ledger_source_identity",
      `The source identity guard refused the source set: ${error.message}`,
    );
  }
}

function checkedResolution(resolution, sourceSet, options = {}) {
  try {
    return validateSourceResolution(resolution, { sourceSet, ...options });
  } catch (error) {
    if (!error?.code) throw error;
    fail(
      "triage_ledger_source_resolution_invalid",
      `The source-resolution guard refused the artifact: ${error.message}`,
    );
  }
}

export function ledgerSnapshotDigest(ledger) {
  return hashBytes(serializeLedger(validateLedger(ledger)));
}

/**
 * A prior resolution is evidence only through its immutable, indexed batch. The returned
 * reference carries machine tokens and digests; a later verifier locates that batch as a sibling
 * in the same store, without believing a path supplied by the plan.
 */
export function readSourcePlanPriorResolution(
  ledger,
  sourceSet,
  { asOf, collectionText, captureRoot, validation = {} } = {},
) {
  checkedSourceSet(sourceSet, { collectionText });
  requireSourceLedger(ledger);
  if (captureRoot === undefined) return null;
  const code = "triage_ledger_source_plan_prior_invalid";
  if (typeof captureRoot !== "string" || captureRoot.length === 0)
    fail(code, "The prior resolution requires a real batch directory.");
  const root = resolve(captureRoot);
  try {
    for (let path = root; ; path = dirname(path)) {
      const stats = lstatSync(path);
      if (!stats.isDirectory() || stats.isSymbolicLink())
        fail(code, "The prior batch path must contain real directories without symlinks.");
      if (dirname(path) === path) break;
    }
  } catch (error) {
    if (error instanceof TriageLedgerError) throw error;
    fail(code, "The prior batch directory cannot be read.");
  }
  const recordPath = join(root, triageBatchRecordFileName);
  try {
    lstatSync(recordPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail(code, "The prior batch record cannot be read.");
  }
  const archived = readArtifact(recordPath, code);
  let record;
  let stored;
  try {
    record = validateSourceBatchRecord(archived.value);
    stored = loadSourceArtifacts(root, record, validation);
  } catch (error) {
    if (!(error instanceof TriageLedgerError)) throw error;
    fail(code, "The prior batch record or its bound source artifacts are invalid.");
  }
  const indexed = ledger.batches.filter((batch) => batch.batch_id === record.batch_id);
  if (
    basename(root) !== record.batch_id ||
    indexed.length !== 1 ||
    indexed[0].record_schema_version !== 2 ||
    indexed[0].recorded_at !== record.observed_at ||
    indexed[0].entry_count !== record.logical_entries.length ||
    indexed[0].policy_id !== record.policy_id ||
    ["entries_digest", "source_set_sha256", "source_resolution_sha256", "plan_sha256"].some(
      (key) => indexed[0][key] !== record[key],
    ) ||
    parseInstant(record.observed_at, code) >= parseInstant(asOf, code) ||
    record.source_set_sha256 !== sourceSetDigest(sourceSet) ||
    typeof collectionText !== "string" ||
    hashBytes(collectionText) !== stored.sourceSet.collection_sha256
  )
    fail(code, "The prior resolution is not a matching indexed batch from before this plan.");
  return {
    resolution: stored.resolution,
    reference: {
      batch_id: record.batch_id,
      entries_digest: record.entries_digest,
      record_sha256: archived.digest,
      source_set_sha256: record.source_set_sha256,
      source_resolution_sha256: record.source_resolution_sha256,
    },
  };
}

function cardGroups(sourceSet, resolution) {
  if (resolution !== undefined) return resolution.groups;
  return sourceSet.cards.map((card) => ({
    logical_key: logicalVacancyKey(card.card_ref),
    card_refs: [card.card_ref],
    identity_status: "linked_unconfirmed",
    primary: null,
    conflicts: [],
    result: null,
    sources: card.links.map((link) => ({
      card_ref: card.card_ref,
      anchor: link.anchor,
      source_ref: link.url,
      role: link.role,
      disposition: link.role,
      observation_ref: null,
    })),
  }));
}

function sourceBaseline(ledger, member) {
  const matches = ledger.source_records.filter(
    (record) =>
      record.card_ref === member.card_ref &&
      record.snapshot_ref === member.snapshot_ref &&
      record.anchor === member.anchor &&
      record.role === member.role &&
      record.url === member.url,
  );
  matches.sort(
    (left, right) =>
      parseInstant(right.observed_at) - parseInstant(left.observed_at) ||
      left.membership_key.localeCompare(right.membership_key),
  );
  return matches[0] ?? null;
}

function sourcePlanItem(group, ledger, sourceSet) {
  const byCard = new Map(sourceSet.cards.map((card) => [card.card_ref, card]));
  const aliasKeys =
    group.identity_status !== "different"
      ? [
          ...new Set(
            ledger.aliases
              .filter((alias) => group.card_refs.includes(alias.card_ref))
              .map((alias) => alias.logical_key),
          ),
        ]
      : [];
  const key = aliasKeys.length === 1 ? aliasKeys[0] : group.logical_key;
  const baseline = ledger.logical_entries.find((entry) => entry.key === key);
  // A supplied group key is never enough: the immutable cards must still be the cards this row
  // observed or aliases the lifecycle independently confirmed. Posting URL/ordinal are irrelevant.
  const guarded =
    baseline !== undefined &&
    group.card_refs.every(
      (ref) =>
        baseline.card_refs.includes(ref) ||
        ledger.aliases.some(
          (alias) => alias.card_ref === ref && alias.logical_key === baseline.key,
        ),
    );
  let action = "fetch_new";
  let reason = "The immutable card has no confirmed logical baseline.";
  if (aliasKeys.length > 1 || (baseline !== undefined && !guarded)) {
    action = "source_review";
    reason = "The card boundaries or snapshot do not match the logical baseline.";
  } else if (guarded && baseline.status === "open" && baseline.decision === triageRetryDecision) {
    action = "retry_blocked";
    reason = "The last guarded source observation was blocked.";
  } else if (
    guarded &&
    group.identity_status === "confirmed" &&
    baseline.identity_status === "confirmed"
  ) {
    action =
      baseline.status !== "open"
        ? "skip_closed"
        : baseline.decision === triageRetryDecision
          ? "retry_blocked"
          : "skip_known";
    reason =
      action === "skip_closed"
        ? `Ledger status ${baseline.status}.`
        : action === "retry_blocked"
          ? "The last confirmed observation was blocked."
          : "The confirmed logical vacancy was already triaged.";
  } else if (baseline !== undefined) {
    action = "source_review";
    reason = "The linked sources have not confirmed one vacancy identity.";
  }
  const sources = group.sources.map((source) => {
    const card = byCard.get(source.card_ref);
    const link = card?.links.find(
      (item) =>
        item.url === source.source_ref &&
        item.role === source.role &&
        item.anchor === source.anchor,
    );
    if (link === undefined)
      fail(
        "triage_ledger_source_identity",
        "A group source does not belong to its immutable card.",
      );
    const member = {
      card_ref: card.card_ref,
      snapshot_ref: card.snapshot_ref,
      anchor: link.anchor,
      source_ref: link.url,
      url: link.url,
      role: link.role,
    };
    const sourceKnown = sourceBaseline(ledger, member);
    return {
      ...member,
      baseline: sourceKnown,
      action:
        link.role === "company_context"
          ? "company_context"
          : link.role === "contact"
            ? "contact"
            : sourceKnown?.observation_decision === "SKIP" &&
                sourceKnown.observation_status === "closed"
              ? "skip_closed"
              : sourceKnown?.observation_decision === triageRetryDecision &&
                  sourceKnown.observation_status === "open"
                ? "retry_blocked"
                : action,
    };
  });
  return {
    group_key: group.logical_key,
    logical_key: key,
    card_refs: [...group.card_refs],
    identity_status: group.identity_status,
    action,
    reason,
    baseline: guarded ? baseline : null,
    sources,
  };
}

/** Source-set validation runs before the ledger is read or any cached decision is inspected. */
export function planSourceBatch(
  ledgerOrPath,
  sourceSet,
  { asOf, resolution, collectionText, captureRoot, selection, validation = {} } = {},
) {
  verifyOperationalFolder();
  checkedSourceSet(sourceSet, { collectionText, captureRoot });
  if (resolution !== undefined)
    checkedResolution(resolution, sourceSet, { collectionText, captureRoot, ...validation });
  parseInstant(asOf);
  const ledger = requireSourceLedger(
    typeof ledgerOrPath === "string" ? readLedger(ledgerOrPath) : ledgerOrPath,
  );
  const prior =
    resolution === undefined
      ? null
      : readSourcePlanPriorResolution(ledger, sourceSet, {
          asOf,
          collectionText,
          captureRoot,
          validation,
        });
  if (
    prior !== null &&
    sourceResolutionDigest(resolution) !== prior.reference.source_resolution_sha256
  )
    fail(
      "triage_ledger_source_plan_prior_invalid",
      "The supplied planning resolution differs from its immutable prior batch.",
    );
  let groups = cardGroups(sourceSet, resolution);
  if (resolution === undefined && selection !== undefined) {
    if (
      !isRecord(selection) ||
      !Array.isArray(selection.card_refs) ||
      new Set(selection.card_refs).size !== selection.card_refs.length ||
      selection.card_refs.some((ref) => !sourceSet.cards.some((card) => card.card_ref === ref))
    )
      fail(
        "triage_ledger_source_identity",
        "The source selection names an unknown or repeated immutable card.",
      );
    groups = groups.filter((group) => selection.card_refs.includes(group.card_refs[0]));
  }
  if (groups.length > maxEntries)
    fail(
      "triage_ledger_invalid_links",
      `At most ${maxEntries} logical vacancies can be planned at once.`,
    );
  const items = groups.map((group) => sourcePlanItem(group, ledger, sourceSet));
  const actions = [...triagePlanActions, "source_review"];
  return {
    schema_version: 2,
    as_of: asOf,
    source_set_sha256: sourceSetDigest(sourceSet),
    ledger_snapshot_sha256: ledgerSnapshotDigest(ledger),
    ...(prior === null ? {} : { prior_resolution: prior.reference }),
    counts: Object.fromEntries(
      actions.map((action) => [action, items.filter((item) => item.action === action).length]),
    ),
    items,
  };
}

function sourceRecordDigest(record) {
  const { entries_digest: ignored, ...payload } = record;
  return hashBytes(JSON.stringify(payload));
}

function validateSourceBatchRecord(record) {
  const code = "triage_ledger_record_unreadable";
  assertExactKeys(
    record,
    [
      "schema_version",
      "batch_id",
      "observed_at",
      "policy_id",
      "entries_digest",
      "source_set_sha256",
      "source_resolution_sha256",
      "plan_sha256",
      "entries",
      "logical_entries",
      "source_records",
      "aliases",
      "corrections",
      "parents",
    ],
    [],
    code,
    "The version 2 batch record",
  );
  for (const key of ["batch_id", "policy_id"])
    assertBoundedText(record[key], key, code, "The version 2 batch record");
  if (!identifierPattern.test(record.batch_id))
    fail(code, "The version 2 batch record has an invalid batch id.");
  parseInstant(record.observed_at, code);
  for (const key of [
    "entries_digest",
    "source_set_sha256",
    "source_resolution_sha256",
    "plan_sha256",
  ])
    assertDigest(record[key], code, key);
  if (!Array.isArray(record.entries) || record.entries.length > maxEntries)
    fail(code, "The version 2 batch record has invalid URL observations.");
  record.entries.forEach((entry, index) => {
    try {
      validateEntry(entry, index);
    } catch (error) {
      if (!(error instanceof TriageLedgerError)) throw error;
      fail(code, error.message);
    }
  });
  assertUnique(record.entries, "key", code, "entries");
  validateSourceLedgerCollections(record, code);
  if (!Array.isArray(record.parents) || record.parents.length > maxEntries)
    fail(code, "The version 2 batch record has invalid parent references.");
  for (const parent of record.parents) {
    assertExactKeys(
      parent,
      ["batch_id", "entries_digest", "record_sha256"],
      [],
      code,
      "The parent batch reference",
    );
    if (!identifierPattern.test(parent.batch_id ?? "")) fail(code, "A parent batch id is invalid.");
    assertDigest(parent.entries_digest, code, "parent.entries_digest");
    assertDigest(parent.record_sha256, code, "parent.record_sha256");
  }
  assertUnique(record.parents, "batch_id", code, "parents");
  for (const key of ["entries", "logical_entries", "source_records", "aliases", "corrections"]) {
    for (const item of record[key])
      if (item.batch_id !== record.batch_id)
        fail(code, "The record carries an observation from another batch.");
  }
  if (sourceRecordDigest(record) !== record.entries_digest)
    fail(code, "The version 2 record does not match its own entries_digest.");
  return record;
}

function readArtifact(path, code) {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxRecordBytes)
      fail(code, `${path} is not a bounded regular artifact.`);
    const bytes = readFileSync(path);
    return { value: JSON.parse(bytes.toString("utf8")), digest: hashBytes(bytes), bytes };
  } catch (error) {
    if (error instanceof TriageLedgerError) throw error;
    fail(code, `${path} could not be read as a bounded JSON artifact.`);
  }
}

function loadSourceArtifacts(artifactsDir, batch, validation) {
  let collectionText;
  try {
    const collectionPath = join(artifactsDir, "collection.links.txt");
    const stats = lstatSync(collectionPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxRecordBytes)
      fail(
        "triage_ledger_source_identity",
        "The collection must be a bounded regular file without a symlink.",
      );
    collectionText = readFileSync(collectionPath, "utf8");
  } catch (error) {
    if (error instanceof TriageLedgerError) throw error;
    fail(
      "triage_ledger_source_identity",
      "The source batch has no readable exact collection bytes.",
    );
  }
  let stored;
  try {
    stored = readSourceSet(join(artifactsDir, triageSourceSetFileName), {
      captureRoot: artifactsDir,
      collectionText,
    });
  } catch (error) {
    if (!error?.code) throw error;
    fail("triage_ledger_source_identity", error.message);
  }
  const resolved = readArtifact(
    join(artifactsDir, triageSourceResolutionFileName),
    "triage_ledger_source_resolution_invalid",
  );
  const planned = readArtifact(
    join(artifactsDir, triageBatchPlanFileName),
    "triage_ledger_plan_invalid",
  );
  for (const [actual, expected, label] of [
    [stored.digest, batch.source_set_sha256, "source set"],
    [resolved.digest, batch.source_resolution_sha256, "source resolution"],
    [planned.digest, batch.plan_sha256, "plan"],
  ]) {
    if (actual !== expected)
      fail(
        "triage_ledger_source_artifact_digest",
        `The ${label} bytes differ from the declared batch digest.`,
      );
  }
  checkedResolution(resolved.value, stored.sourceSet, {
    captureRoot: artifactsDir,
    collectionText,
    ...validation,
  });
  if (resolved.value.policy_id !== batch.policy_id)
    fail(
      "triage_ledger_source_resolution_invalid",
      "The declared source batch policy differs from its validated resolution epoch.",
    );
  const plan = planned.value.source_plan ?? planned.value;
  if (
    !isRecord(plan) ||
    plan.schema_version !== 2 ||
    plan.source_set_sha256 !== stored.digest ||
    !Array.isArray(plan.items)
  )
    fail("triage_ledger_plan_invalid", "The source plan does not bind this immutable source set.");
  assertDigest(
    plan.ledger_snapshot_sha256,
    "triage_ledger_plan_invalid",
    "The plan's ledger snapshot",
  );
  if (parseInstant(plan.as_of, "triage_ledger_plan_invalid") > parseInstant(batch.observed_at))
    fail("triage_ledger_plan_invalid", "The source plan postdates this observation.");
  return { sourceSet: stored.sourceSet, resolution: resolved.value, plan, collectionText };
}

function flagsOfResult(result) {
  const flags = [...(Array.isArray(result.data_gaps) ? result.data_gaps : [])];
  const reason = result.review_code ?? result.review_reason ?? result.blocker_code;
  if (typeof reason === "string" && reason.length > 0) flags.push(reason);
  return [...new Set(flags)].sort();
}

function logicalStatus(group, observations) {
  if (group.result?.decision !== "SKIP" || group.result.skip_code !== "vacancy_unavailable")
    return "open";
  const sourceRefs = new Set(
    group.sources
      .filter((source) => !["company_context", "contact"].includes(source.role))
      .map((source) => source.observation_ref),
  );
  const scoped = observations.filter((observation) => sourceRefs.has(observation.observation_ref));
  if (scoped.some((observation) => observation.input?.source.accessOutcome === "usable"))
    return "open";
  return scoped.some(
    (observation) =>
      observation.input?.source.accessOutcome === "closed" &&
      JSON.stringify(observation.trace) === JSON.stringify(group.result),
  )
    ? "closed"
    : "open";
}

function logicalGroupKey(group, aliases) {
  const keys = [
    ...new Set(
      group.identity_status === "different"
        ? []
        : aliases
            .filter((alias) => group.card_refs.includes(alias.card_ref))
            .map((alias) => alias.logical_key),
    ),
  ];
  if (keys.length > 1)
    fail(
      "triage_ledger_source_identity",
      "One confirmed group cannot alias two logical vacancies.",
    );
  return keys[0] ?? group.logical_key;
}

function normalizeLogicalGroups(resolution, batch, aliases) {
  return resolution.groups
    .filter((group) => group.result !== null)
    .map((group, index) => {
      const result = group.result;
      const entry = {
        key: logicalGroupKey(group, aliases),
        card_refs: [...group.card_refs].sort(),
        identity_status: group.identity_status,
        primary_ref: group.primary,
        first_seen: batch.observed_at,
        last_checked: batch.observed_at,
        status: logicalStatus(group, resolution.observations),
        batch_id: batch.batch_id,
        decision: result.decision,
        flags: flagsOfResult(result),
        policy_id: batch.policy_id,
      };
      for (const [target, source] of [
        ["title", "job_title"],
        ["company", "company"],
      ]) {
        if (typeof result[source] === "string" && result[source].length > 0)
          entry[target] = result[source];
      }
      validateLogicalEntry(entry, index, "triage_ledger_invalid_batch");
      return entry;
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

function normalizeSourceMemberships(sourceSet, resolution, batch, aliases, carried = []) {
  const cards = new Map(sourceSet.cards.map((card) => [card.card_ref, card]));
  return resolution.groups
    .flatMap((group) =>
      group.sources.map((source) => {
        const card = cards.get(source.card_ref);
        const link = card.links.find(
          (item) =>
            item.role === source.role &&
            item.url === source.source_ref &&
            item.anchor === source.anchor,
        );
        if (link === undefined)
          fail(
            "triage_ledger_source_identity",
            "A source disposition does not match its immutable membership.",
          );
        const observation = resolution.observations.find(
          (item) => item.observation_ref === source.observation_ref,
        );
        const result = !["company_context", "contact"].includes(link.role)
          ? observation?.trace
          : undefined;
        const record = {
          membership_key: "",
          logical_key: logicalGroupKey(group, aliases),
          card_ref: card.card_ref,
          snapshot_ref: card.snapshot_ref,
          anchor: link.anchor,
          role: link.role,
          url: link.url,
          disposition: source.disposition,
          observation_ref: source.observation_ref,
          batch_id: batch.batch_id,
          observed_at:
            carried.find((reuse) =>
              sameSourceScope(reuse.baseline, {
                card_ref: card.card_ref,
                snapshot_ref: card.snapshot_ref,
                anchor: link.anchor,
                role: link.role,
                url: link.url,
              }),
            )?.baseline.observed_at ?? batch.observed_at,
          observation_decision: result?.decision ?? null,
          observation_status:
            result === undefined || result === null
              ? null
              : observation.input.source.accessOutcome === "closed"
                ? "closed"
                : "open",
        };
        record.membership_key = membershipKey(record);
        validateSourceRecord(record, 0, "triage_ledger_invalid_batch");
        return record;
      }),
    )
    .sort((a, b) => a.membership_key.localeCompare(b.membership_key));
}

function sameSourceScope(left, right) {
  return ["card_ref", "snapshot_ref", "anchor", "role", "url"].every(
    (key) => left?.[key] === right?.[key],
  );
}

function sourceEvidenceBytes(root, file) {
  const code = "triage_ledger_refetched_closed_source";
  if (
    typeof file !== "string" ||
    file.length > 256 ||
    isAbsolute(file) ||
    !/^[A-Za-z0-9._/-]+$/u.test(file) ||
    file.split("/").some((part) => ["", ".", ".."].includes(part))
  )
    fail(code, "A carried source has an invalid evidence path.");
  try {
    let path = resolve(root);
    for (const part of file.split("/")) {
      path = join(path, part);
      if (lstatSync(path).isSymbolicLink())
        fail(code, "Carried source evidence cannot contain a symlink.");
    }
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > maxRecordBytes)
      fail(code, "Carried source evidence must be a bounded regular file.");
    return readFileSync(path);
  } catch (error) {
    if (error instanceof TriageLedgerError) throw error;
    fail(code, "The carried source evidence cannot be read.");
  }
}

function carriedClosureProof(ledger, sourceSet, baseline, observation, options) {
  const parentDir = join(dirname(options.artifactsDir), baseline.batch_id);
  if (!identifierPattern.test(baseline.batch_id ?? "")) return null;
  const prior = readSourcePlanPriorResolution(ledger, sourceSet, {
    asOf: options.asOf,
    collectionText: options.collectionText,
    captureRoot: parentDir,
    validation: options.validation,
  });
  if (prior === null || observation.observation_ref !== baseline.observation_ref) return null;
  const parentBytes = readArtifact(
    join(parentDir, triageBatchRecordFileName),
    "triage_ledger_refetched_closed_source",
  );
  const parentRecord = validateBatchRecord(parentBytes.value);
  if (parentBytes.digest !== prior.reference.record_sha256) return null;
  if (
    !parentRecord.source_records.some(
      (record) => JSON.stringify(record) === JSON.stringify(baseline),
    )
  )
    return null;
  const archived = prior.resolution.observations.find(
    (item) => item.observation_ref === baseline.observation_ref,
  );
  if (JSON.stringify(archived) !== JSON.stringify(observation)) return null;
  for (const binding of [observation.capture, observation.transport]) {
    if (binding === null || binding === undefined) continue;
    const bytes = sourceEvidenceBytes(options.artifactsDir, binding.file);
    if (!bytes.equals(sourceEvidenceBytes(parentDir, binding.file))) return null;
    if (binding === observation.capture) {
      const snapshot = sourceSet.snapshots.find(
        (item) => item.snapshot_ref === baseline.snapshot_ref,
      );
      const observedAt =
        binding.file === snapshot.capture.file
          ? snapshot.capture.captured_at
          : verifyCaptureFile(bytes.toString("utf8")).header?.["fetched-at"];
      if (parseInstant(observedAt) > parseInstant(baseline.observed_at)) return null;
    }
  }
  // A fetch manifest may bind the observation implicitly. A new manifest is not the old fetch,
  // even when it points to a byte-identical body, so presence and complete bytes must agree.
  const manifests = [options.artifactsDir, parentDir].map((root) => {
    try {
      lstatSync(join(root, "fetch-manifest.json"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    return sourceEvidenceBytes(root, "fetch-manifest.json");
  });
  if (
    manifests[0] === null
      ? manifests[1] !== null
      : manifests[1] === null || !manifests[0].equals(manifests[1])
  )
    return null;
  const { batch_id, entries_digest, record_sha256 } = prior.reference;
  return { batch_id, entries_digest, record_sha256 };
}

function terminalSourceResults(ledger, sourceSet, resolution, options, baselineFor) {
  const reused = [];
  const violations = [];
  for (const group of resolution.groups)
    for (const source of group.sources) {
      if (["company_context", "contact"].includes(source.role) || source.observation_ref === null)
        continue;
      const card = sourceSet.cards.find((item) => item.card_ref === source.card_ref);
      const member = {
        card_ref: source.card_ref,
        snapshot_ref: card.snapshot_ref,
        anchor: source.anchor,
        role: source.role,
        url: source.source_ref,
      };
      const baseline = baselineFor(member);
      if (baseline?.observation_decision !== "SKIP" || baseline.observation_status !== "closed")
        continue;
      const observation = resolution.observations.find(
        (item) => item.observation_ref === source.observation_ref,
      );
      let parent = null;
      try {
        parent = carriedClosureProof(ledger, sourceSet, baseline, observation, options);
      } catch {
        /* A missing or changed archive never proves historical reuse. */
      }
      if (parent === null)
        violations.push({
          ...member,
          ...(observation?.input?.inputIndex === undefined
            ? {}
            : { index: observation.input.inputIndex }),
        });
      else reused.push({ baseline, parent });
    }
  return { reused, violations };
}

/** Terminal job sources can only carry proven historical evidence, never a new fetch. */
export function inspectTerminalSourceObservations(ledger, sourceSet, resolution, options) {
  checkedSourceSet(sourceSet, { collectionText: options.collectionText });
  requireSourceLedger(ledger);
  return terminalSourceResults(ledger, sourceSet, resolution, options, (member) =>
    sourceBaseline(ledger, member),
  );
}

function readParent(artifactsDir, batchId, expectedDigest, parents) {
  if (!identifierPattern.test(batchId ?? ""))
    fail(
      "triage_ledger_source_parent_invalid",
      "A parent batch id must be a bounded machine token.",
    );
  const parentDir = join(dirname(artifactsDir), batchId);
  try {
    const stats = lstatSync(parentDir);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      fail(
        "triage_ledger_source_parent_invalid",
        "A parent batch must be a real directory in the same store.",
      );
  } catch (error) {
    if (error instanceof TriageLedgerError) throw error;
    fail("triage_ledger_source_parent_invalid", "The parent batch directory cannot be read.");
  }
  const record = readBatchRecord(parentDir);
  if (record.batch_id !== batchId || record.entries_digest !== expectedDigest)
    fail(
      "triage_ledger_source_parent_invalid",
      "The parent reference differs from its immutable batch record.",
    );
  const reference = {
    batch_id: batchId,
    entries_digest: expectedDigest,
    record_sha256: hashBytes(readFileSync(join(parentDir, triageBatchRecordFileName))),
  };
  parents.set(batchId, reference);
  return { record, parentDir, reference };
}

function normalizeCorrections(rawCorrections, sourceSet, resolution, batch, artifactsDir, parents) {
  return rawCorrections
    .map((raw, index) => {
      assertExactKeys(
        raw,
        ["parent_batch_id", "parent_entries_digest", "card_ref", "url"],
        [],
        "triage_ledger_source_correction_invalid",
        `corrections[${index}]`,
      );
      const card = sourceSet.cards.find((item) => item.card_ref === raw.card_ref);
      const link = card?.links.find(
        (item) =>
          item.role === "company_context" &&
          normalizeVacancyUrl(item.url) === normalizeVacancyUrl(raw.url),
      );
      const group = resolution.groups.find((item) =>
        item.sources.some(
          (source) =>
            source.card_ref === raw.card_ref &&
            source.role === "company_context" &&
            source.source_ref === link?.url &&
            source.disposition === "company_context",
        ),
      );
      if (!card || !link || !group || card.mapping_status !== "resolved")
        fail(
          "triage_ledger_source_correction_invalid",
          "A context correction needs verified company_context evidence in its own immutable card.",
        );
      const parent = readParent(
        artifactsDir,
        raw.parent_batch_id,
        raw.parent_entries_digest,
        parents,
      );
      const key = vacancyIdentity(raw.url).key;
      const observed = parent.record.entries.find((item) => item.key === key);
      if (!observed || observed.decision !== triageRetryDecision || observed.status !== "open")
        fail(
          "triage_ledger_source_correction_invalid",
          "The referenced parent did not record this open BLOCKED URL observation.",
        );
      const correction = {
        correction_key: "",
        entry_key: key,
        parent_batch_id: raw.parent_batch_id,
        parent_entries_digest: raw.parent_entries_digest,
        parent_record_sha256: parent.reference.record_sha256,
        parent_last_checked: observed.last_checked,
        card_ref: card.card_ref,
        logical_key: group.logical_key,
        snapshot_ref: card.snapshot_ref,
        anchor: link.anchor,
        url: observed.url,
        batch_id: batch.batch_id,
        recorded_at: batch.observed_at,
      };
      correction.correction_key = correctionKey(correction);
      validateCorrection(correction, index, "triage_ledger_source_correction_invalid");
      return correction;
    })
    .sort((a, b) => a.correction_key.localeCompare(b.correction_key));
}

function observationIdentity(observation, group) {
  // Only independently checked direct posting observations can support an alias. A title, author,
  // hostname or Telegram post URL alone cannot confirm an edited card's identity.
  const input = observation?.input;
  const company = observation?.facts?.company?.value;
  const title = observation?.facts?.title?.value;
  const role = observation?.facts?.role?.value;
  const member = group.sources.find(
    (source) =>
      source.observation_ref === observation?.observation_ref &&
      ["details", "apply"].includes(source.role),
  );
  if (
    !input ||
    input.source.accessOutcome !== "usable" ||
    observation.identity_status !== "confirmed" ||
    !member ||
    [company, title, role].some((value) => typeof value !== "string" || !value.trim())
  )
    return null;
  const ref = input.source.finalUrl ?? observation.source_ref;
  if (typeof ref !== "string") return null;
  return {
    key: vacancyIdentity(ref).key,
    company: company.trim().toLowerCase(),
    title: title.trim().toLowerCase(),
    role: role.trim().toLowerCase(),
  };
}

function normalizeAliases(
  rawAliases,
  sourceSet,
  resolution,
  batch,
  artifactsDir,
  parents,
  validation,
) {
  return rawAliases
    .map((raw, index) => {
      assertExactKeys(
        raw,
        [
          "card_ref",
          "logical_key",
          "parent_batch_id",
          "parent_entries_digest",
          "observation_ref",
          "parent_observation_ref",
        ],
        [],
        "triage_ledger_source_alias_invalid",
        `aliases[${index}]`,
      );
      assertCardReference(raw.card_ref, "triage_ledger_source_alias_invalid", "The new card");
      const group = resolution.groups.find(
        (item) => item.identity_status === "confirmed" && item.card_refs.includes(raw.card_ref),
      );
      const current = resolution.observations.find(
        (item) => item.observation_ref === raw.observation_ref && item.card_ref === raw.card_ref,
      );
      if (!group || !sourceSet.cards.some((card) => card.card_ref === raw.card_ref))
        fail(
          "triage_ledger_source_alias_invalid",
          "An alias needs a currently confirmed immutable card.",
        );
      const parent = readParent(
        artifactsDir,
        raw.parent_batch_id,
        raw.parent_entries_digest,
        parents,
      );
      if (
        parent.record.schema_version !== 2 ||
        !parent.record.logical_entries.some(
          (entry) => entry.key === raw.logical_key && entry.identity_status === "confirmed",
        )
      )
        fail(
          "triage_ledger_source_alias_invalid",
          "An alias needs a confirmed logical observation in a version 2 parent record.",
        );
      const prior = loadSourceArtifacts(parent.parentDir, parent.record, validation).resolution;
      const priorEntry = parent.record.logical_entries.find(
        (entry) => entry.key === raw.logical_key,
      );
      const priorGroup = prior.groups.find(
        (item) =>
          item.card_refs.some((ref) => priorEntry.card_refs.includes(ref)) &&
          item.identity_status === "confirmed" &&
          item.sources.some((source) => source.observation_ref === raw.parent_observation_ref),
      );
      const previous = prior.observations.find(
        (item) => item.observation_ref === raw.parent_observation_ref,
      );
      const left = group && observationIdentity(current, group),
        right = priorGroup && observationIdentity(previous, priorGroup);
      if (!priorGroup || !left || !right || JSON.stringify(left) !== JSON.stringify(right))
        fail(
          "triage_ledger_source_alias_invalid",
          "Alias evidence must independently confirm the same direct posting, explicit company and role in both immutable observations.",
        );
      const alias = {
        card_ref: raw.card_ref,
        logical_key: raw.logical_key,
        batch_id: batch.batch_id,
        parent_batch_id: raw.parent_batch_id,
        parent_entries_digest: raw.parent_entries_digest,
        parent_record_sha256: parent.reference.record_sha256,
        observation_ref: raw.observation_ref,
        parent_observation_ref: raw.parent_observation_ref,
      };
      validateAlias(alias, index, "triage_ledger_source_alias_invalid");
      return alias;
    })
    .sort((a, b) => a.card_ref.localeCompare(b.card_ref));
}

function assertSourcePlanUnmoved(ledger, plan, groups) {
  if (ledgerSnapshotDigest(ledger) !== plan.ledger_snapshot_sha256) {
    for (const item of plan.items) {
      const current = ledger.logical_entries.find((entry) => entry.key === item.logical_key);
      if (
        item.baseline === null
          ? current !== undefined
          : current === undefined || JSON.stringify(current) !== JSON.stringify(item.baseline)
      )
        fail(
          "triage_ledger_concurrent_observation",
          "A selected logical observation changed after this source batch planned; its immutable observations remain in the batch directory.",
        );
      for (const member of item.sources ?? []) {
        if (
          !Object.hasOwn(member, "baseline") ||
          ["company_context", "contact"].includes(member.role)
        )
          continue;
        if (JSON.stringify(sourceBaseline(ledger, member)) !== JSON.stringify(member.baseline))
          fail(
            "triage_ledger_concurrent_observation",
            "A scoped job source observation changed after the batch planned.",
          );
      }
    }
  }
  const plannedKeys = new Set(plan.items.map((item) => item.group_key ?? item.logical_key));
  for (const group of groups)
    if (
      !plannedKeys.has(group.logical_key) &&
      ledger.logical_entries.some((entry) => entry.key === group.logical_key)
    )
      fail(
        "triage_ledger_entry_unplanned",
        "A derived source group has a preexisting logical row absent from the batch's source plan.",
      );
  for (const group of groups) {
    if (
      group.card_refs.length < 2 ||
      !ledger.logical_entries.some((entry) => entry.key === group.logical_key)
    )
      continue;
    if (
      !plan.items.some(
        (item) =>
          (item.group_key ?? item.logical_key) === group.logical_key &&
          JSON.stringify([...item.card_refs].sort()) ===
            JSON.stringify([...group.card_refs].sort()) &&
          item.baseline !== null,
      )
    )
      fail(
        "triage_ledger_entry_unplanned",
        "An existing merged group requires its validated frozen group baseline before refetch.",
      );
  }
  const plannedCards = new Set(plan.items.flatMap((item) => item.card_refs ?? []));
  for (const group of groups)
    if (group.card_refs.some((ref) => !plannedCards.has(ref)))
      fail(
        "triage_ledger_entry_unplanned",
        "A source resolution card is outside the batch's source plan.",
      );
  for (const group of groups)
    for (const source of group.sources)
      if (
        !plan.items.some((item) =>
          item.sources?.some(
            (member) =>
              member.card_ref === source.card_ref &&
              member.anchor === source.anchor &&
              member.role === source.role &&
              member.source_ref === source.source_ref,
          ),
        )
      )
        fail(
          "triage_ledger_entry_unplanned",
          "A source resolution membership is outside the batch's source plan.",
        );
}

function mergeObservedRows(previous, observed, key) {
  const byKey = new Map(previous.map((item) => [item[key], item]));
  for (const item of observed) {
    const known = byKey.get(item[key]);
    if (known && parseInstant(known.last_checked) > parseInstant(item.last_checked)) continue;
    if (!known) {
      byKey.set(item[key], item);
      continue;
    }
    const carried = {};
    for (const field of ["title", "company", "priority_class"])
      if (!Object.hasOwn(item, field) && Object.hasOwn(known, field)) carried[field] = known[field];
    byKey.set(item[key], {
      ...item,
      ...carried,
      first_seen:
        parseInstant(known.first_seen) < parseInstant(item.first_seen)
          ? known.first_seen
          : item.first_seen,
      ...(Object.hasOwn(item, "card_refs")
        ? { card_refs: [...new Set([...known.card_refs, ...item.card_refs])].sort() }
        : {}),
    });
  }
  return [...byKey.values()].sort((a, b) => a[key].localeCompare(b[key]));
}

function mergeImmutable(previous, additions, key, code) {
  const byKey = new Map(previous.map((item) => [item[key], item]));
  for (const item of additions) {
    const known = byKey.get(item[key]);
    if (known && JSON.stringify(known) !== JSON.stringify(item))
      fail(code, "An immutable source association is already recorded with different evidence.");
    if (!known) byKey.set(item[key], item);
  }
  return [...byKey.values()].sort((a, b) => a[key].localeCompare(b[key]));
}

function frozenSourceRecord(artifactsDir, batchId) {
  try {
    const path = join(artifactsDir, triageBatchRecordFileName);
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink())
      fail(
        "triage_ledger_record_unreadable",
        "The frozen source record must be a regular file without a symlink.",
      );
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    if (error instanceof TriageLedgerError) throw error;
    fail(
      "triage_ledger_record_unreadable",
      `The frozen source record could not be read (${error?.code ?? "unknown error"}).`,
    );
  }
  const record = readBatchRecord(artifactsDir);
  if (record.schema_version !== 2 || record.batch_id !== batchId)
    fail(
      "triage_ledger_record_conflict",
      "The source directory already holds a different immutable batch record.",
    );
  return record;
}

function assertNoLogicalCardOverlap(ledger, entries, aliases) {
  for (const entry of entries) {
    if (entry.identity_status === "different") continue;
    for (const known of ledger.logical_entries) {
      if (
        known.identity_status === "different" ||
        known.key === entry.key ||
        !known.card_refs.some((ref) => entry.card_refs.includes(ref))
      )
        continue;
      // A verified alias may supersede a separately observed old card, but it must account for
      // every card of that retained row. Neither adding a smaller card nor a partial alias rekeys it.
      if (
        known.card_refs.every((ref) =>
          aliases.some((alias) => alias.card_ref === ref && alias.logical_key === entry.key),
        )
      )
        continue;
      fail(
        "triage_ledger_source_identity",
        "An immutable card already belongs to another logical vacancy; retain its established key using independently confirmed parent-bound aliases.",
      );
    }
  }
}

/**
 * Source-aware archive-before-index write. Every decision comes from the validated resolution;
 * correction timestamps describe a bookkeeping correction and never become a fresh network view.
 */
export function recordSourceBatch(path, batch, options) {
  verifyOperationalFolder();
  assertExactKeys(
    batch,
    [
      "batch_id",
      "observed_at",
      "policy_id",
      "source_set_sha256",
      "source_resolution_sha256",
      "plan_sha256",
    ],
    ["entries", "aliases", "corrections", "correction_only"],
    "triage_ledger_invalid_batch",
    "The source batch",
  );
  assertBoundedText(
    batch.policy_id,
    "policy_id",
    "triage_ledger_invalid_batch",
    "The source batch",
  );
  if (!identifierPattern.test(batch.batch_id ?? ""))
    fail("triage_ledger_invalid_batch", "The source batch has an invalid batch id.");
  parseInstant(batch.observed_at, "triage_ledger_invalid_batch");
  for (const key of ["source_set_sha256", "source_resolution_sha256", "plan_sha256"])
    assertDigest(batch[key], "triage_ledger_invalid_batch", key);
  assertExactKeys(
    options,
    ["artifactsDir"],
    ["validation"],
    "triage_ledger_record_undeclared",
    "The source batch options",
  );
  const archiveDir = resolveArchiveTarget(batch, { artifactsDir: options.artifactsDir });
  if (archiveDir === null)
    fail(
      "triage_ledger_record_undeclared",
      "A version 2 source batch always keeps an immutable archive.",
    );
  for (const key of ["entries", "aliases", "corrections"])
    if (Object.hasOwn(batch, key) && (!Array.isArray(batch[key]) || batch[key].length > maxEntries))
      fail("triage_ledger_invalid_batch", `${key} must be a bounded array.`);
  const validation = options.validation ?? {};
  const { sourceSet, resolution, plan, collectionText } = loadSourceArtifacts(
    archiveDir,
    batch,
    validation,
  );
  if (Object.hasOwn(batch, "correction_only") && batch.correction_only !== true)
    fail("triage_ledger_invalid_batch", "correction_only is an explicit true declaration.");
  if (
    batch.correction_only &&
    ((batch.entries?.length ?? 0) > 0 ||
      (batch.corrections?.length ?? 0) === 0 ||
      (batch.aliases?.length ?? 0) > 0)
  )
    fail(
      "triage_ledger_source_correction_invalid",
      "A correction-only batch cannot pretend to observe fresh URL or logical decisions.",
    );
  const parents = new Map();
  const aliases = normalizeAliases(
    batch.aliases ?? [],
    sourceSet,
    resolution,
    batch,
    archiveDir,
    parents,
    validation,
  );
  const corrections = normalizeCorrections(
    batch.corrections ?? [],
    sourceSet,
    resolution,
    batch,
    archiveDir,
    parents,
  );
  const startingLedger = requireSourceLedger(readLedger(path));
  const allAliases = [...startingLedger.aliases, ...aliases];
  const frozen = frozenSourceRecord(archiveDir, batch.batch_id);
  // Replay derives the original payload again, but later aliases may not reinterpret its key.
  // A frozen key is accepted only when derived from the resolution or a still-confirmed alias;
  // the complete recomputed record must then match the archive and index digests below.
  const recordAliases =
    frozen === null
      ? allAliases
      : allAliases.filter(
          (alias) =>
            frozen.logical_entries.some(
              (entry) =>
                entry.key === alias.logical_key && entry.card_refs.includes(alias.card_ref),
            ) ||
            frozen.source_records.some(
              (source) =>
                source.logical_key === alias.logical_key && source.card_ref === alias.card_ref,
            ),
        );
  const terminalOptions = {
    artifactsDir: archiveDir,
    asOf: plan.as_of,
    collectionText,
    validation,
  };
  const plannedSources = plan.items.flatMap((item) => item.sources ?? []);
  const carried = terminalSourceResults(
    startingLedger,
    sourceSet,
    resolution,
    terminalOptions,
    (member) => plannedSources.find((source) => sameSourceScope(source, member))?.baseline,
  );
  if (carried.violations.length)
    fail(
      "triage_ledger_refetched_closed_source",
      "A terminal job source has a fresh or unproven observation.",
    );
  for (const reuse of carried.reused) parents.set(reuse.parent.batch_id, reuse.parent);
  const entries = (batch.entries ?? [])
    .map((item, index) => normalizeBatchEntry(item, index, batch))
    .sort((a, b) => a.key.localeCompare(b.key));
  for (const entry of entries) {
    const observed = resolution.observations.filter(
      (observation) =>
        observation.trace?.source_ref &&
        vacancyIdentity(observation.trace.source_ref).key === entry.key,
    );
    if (
      !observed.some(
        (observation) =>
          observation.trace.decision === entry.decision &&
          sameFlags(flagsOfResult(observation.trace), entry.flags) &&
          entry.status ===
            (observation.input.source.accessOutcome === "closed" ? "closed" : "open") &&
          (!Object.hasOwn(entry, "title") || entry.title === observation.trace.job_title) &&
          (!Object.hasOwn(entry, "company") || entry.company === observation.trace.company),
      )
    )
      fail(
        "triage_ledger_entry_without_trace",
        "A URL observation has no matching independently validated liveness and Decision Trace in the source resolution.",
      );
  }
  const record = {
    schema_version: 2,
    batch_id: batch.batch_id,
    observed_at: batch.observed_at,
    policy_id: batch.policy_id,
    entries_digest: "",
    source_set_sha256: batch.source_set_sha256,
    source_resolution_sha256: batch.source_resolution_sha256,
    plan_sha256: batch.plan_sha256,
    entries,
    logical_entries: batch.correction_only
      ? []
      : normalizeLogicalGroups(resolution, batch, recordAliases),
    source_records: normalizeSourceMemberships(
      sourceSet,
      resolution,
      batch,
      recordAliases,
      carried.reused,
    ).filter(
      (member) =>
        !batch.correction_only ||
        corrections.some(
          (correction) =>
            correction.card_ref === member.card_ref &&
            correction.anchor === member.anchor &&
            correction.url === member.url &&
            member.role === "company_context",
        ),
    ),
    aliases,
    corrections,
    parents: [...parents.values()].sort((a, b) => a.batch_id.localeCompare(b.batch_id)),
  };
  record.entries_digest = sourceRecordDigest(record);
  validateSourceBatchRecord(record);
  return withLedgerLock(path, (rawLedger) => {
    const ledger = requireSourceLedger(rawLedger);
    const previous = ledger.batches.find((known) => known.batch_id === batch.batch_id);
    if (previous && previous.entries_digest !== record.entries_digest)
      fail(
        "triage_ledger_batch_id_reused",
        "The source batch id is already recorded with different immutable content.",
      );
    const existing = persistedRecordState(archiveDir, batch.batch_id, record.entries_digest);
    if (!previous && existing === "absent") {
      assertSourcePlanUnmoved(ledger, plan, resolution.groups);
      const terminal = inspectTerminalSourceObservations(
        ledger,
        sourceSet,
        resolution,
        terminalOptions,
      );
      if (terminal.violations.length)
        fail(
          "triage_ledger_refetched_closed_source",
          "A terminal job source has a fresh or unproven observation.",
        );
      if (
        terminal.reused.length !== carried.reused.length ||
        carried.reused.some(
          (reuse) =>
            JSON.stringify(sourceBaseline(ledger, reuse.baseline)) !==
            JSON.stringify(reuse.baseline),
        )
      )
        fail(
          "triage_ledger_plan_invalid",
          "A carried closure does not match the checked source baseline.",
        );
      for (const correction of corrections) {
        const known = ledger.entries.find((entry) => entry.key === correction.entry_key);
        if (
          !known ||
          known.batch_id !== correction.parent_batch_id ||
          known.last_checked !== correction.parent_last_checked ||
          known.decision !== triageRetryDecision ||
          known.status !== "open"
        )
          fail(
            "triage_ledger_concurrent_observation",
            "The URL observation moved since its correction parent was recorded.",
          );
      }
      for (const alias of aliases)
        if (
          !ledger.logical_entries.some(
            (entry) => entry.key === alias.logical_key && entry.identity_status === "confirmed",
          )
        )
          fail(
            "triage_ledger_source_alias_invalid",
            "The alias target has no current confirmed logical baseline.",
          );
      for (const alias of aliases) {
        const target = ledger.logical_entries.find((entry) => entry.key === alias.logical_key);
        if (target.batch_id !== alias.parent_batch_id)
          fail(
            "triage_ledger_concurrent_observation",
            "The confirmed alias target moved after its parent observation.",
          );
      }
      for (const entry of record.logical_entries) {
        const known = ledger.logical_entries.find((item) => item.key === entry.key);
        if (
          known &&
          entry.card_refs.some(
            (ref) =>
              !known.card_refs.includes(ref) &&
              !allAliases.some(
                (alias) => alias.card_ref === ref && alias.logical_key === entry.key,
              ),
          )
        )
          fail(
            "triage_ledger_source_identity",
            "A new card cannot inherit another card's logical decision without an independently confirmed alias.",
          );
      }
      assertNoLogicalCardOverlap(ledger, record.logical_entries, allAliases);
      mergeImmutable(ledger.aliases, aliases, "card_ref", "triage_ledger_source_alias_invalid");
      mergeImmutable(
        ledger.corrections,
        corrections,
        "correction_key",
        "triage_ledger_source_correction_invalid",
      );
    }
    const archived = persistBatchRecord(archiveDir, record);
    if (previous)
      return {
        changed: false,
        result: {
          batch_id: batch.batch_id,
          replayed: true,
          added: [],
          updated: [],
          ledger_entries: ledger.logical_entries.length,
          record: archived,
        },
      };
    const logicalEntries = mergeObservedRows(ledger.logical_entries, record.logical_entries, "key");
    const sourceByKey = new Map(ledger.source_records.map((item) => [item.membership_key, item]));
    for (const item of record.source_records) {
      const known = sourceByKey.get(item.membership_key);
      if (known && carried.reused.some((reuse) => sameSourceScope(reuse.baseline, item))) continue;
      // Accounting an unfetched alternative again cannot erase its last real source outcome.
      if (
        known &&
        item.observation_ref === null &&
        typeof known.observation_decision === "string" &&
        !["company_context", "contact"].includes(item.role)
      )
        continue;
      if (!known || parseInstant(known.observed_at) <= parseInstant(item.observed_at))
        sourceByKey.set(item.membership_key, item);
    }
    const batches = [
      ...ledger.batches,
      {
        batch_id: batch.batch_id,
        recorded_at: batch.observed_at,
        entry_count: record.logical_entries.length,
        entries_digest: record.entries_digest,
        policy_id: batch.policy_id,
        record_schema_version: 2,
        source_set_sha256: batch.source_set_sha256,
        source_resolution_sha256: batch.source_resolution_sha256,
        plan_sha256: batch.plan_sha256,
      },
    ].sort(
      (a, b) =>
        parseInstant(a.recorded_at) - parseInstant(b.recorded_at) ||
        a.batch_id.localeCompare(b.batch_id),
    );
    const knownKeys = new Set(ledger.logical_entries.map((item) => item.key));
    return {
      ledger: {
        ...ledger,
        batches,
        entries: mergeObservedRows(ledger.entries, record.entries, "key"),
        logical_entries: logicalEntries,
        source_records: [...sourceByKey.values()].sort((a, b) =>
          a.membership_key.localeCompare(b.membership_key),
        ),
        aliases: mergeImmutable(
          ledger.aliases,
          aliases,
          "card_ref",
          "triage_ledger_source_alias_invalid",
        ),
        corrections: mergeImmutable(
          ledger.corrections,
          corrections,
          "correction_key",
          "triage_ledger_source_correction_invalid",
        ),
      },
      result: {
        batch_id: batch.batch_id,
        replayed: false,
        added: record.logical_entries
          .filter((item) => !knownKeys.has(item.key))
          .map((item) => item.key),
        updated: record.logical_entries
          .filter((item) => knownKeys.has(item.key))
          .map((item) => item.key),
        ledger_entries: logicalEntries.length,
        source_records: record.source_records.length,
        corrections: corrections.length,
        record: archived,
      },
    };
  });
}

/** A separate immutable correction batch; no URL row or historical batch is rewritten. */
export function correctSourceObservations(path, batch, options) {
  if (!Array.isArray(batch?.corrections) || batch.corrections.length === 0)
    fail(
      "triage_ledger_source_correction_invalid",
      "A correction batch must name its verified parent observations.",
    );
  return recordSourceBatch(path, { ...batch, correction_only: true }, options);
}

/**
 * The review runbook's mechanical half: every open ledger entry that still carries a flag, grouped
 * by that flag. One group is one decision — `docs/runbooks/triage-review.md` owns the mapping from
 * a flag family to the single user decision or policy fix that clears it. A vacancy carrying two
 * flags appears in two groups on purpose: it genuinely needs both decisions.
 */
export function reviewLedger(ledger, { asOf } = {}) {
  validateLedger(ledger);
  parseInstant(asOf, "triage_ledger_invalid_instant");
  const sourceAware = ledger.schema_version === 2;
  const urlEntries = sourceAware
    ? ledger.entries.filter(
        (entry) =>
          !ledger.corrections.some(
            (correction) =>
              correction.entry_key === entry.key &&
              correction.parent_batch_id === entry.batch_id &&
              correction.parent_last_checked === entry.last_checked,
          ) &&
          !ledger.source_records.some(
            (source) =>
              source.batch_id === entry.batch_id &&
              /^https?:\/\//u.test(source.url) &&
              source.role !== "contact" &&
              vacancyIdentity(source.url).key === entry.key &&
              ledger.logical_entries.some((logical) => logical.key === source.logical_key),
          ),
      )
    : ledger.entries;
  const logicalEntries = sourceAware
    ? ledger.logical_entries.filter(
        (entry) =>
          entry.identity_status === "different" ||
          !entry.card_refs.every((ref) =>
            ledger.aliases.some(
              (alias) => alias.card_ref === ref && alias.logical_key !== entry.key,
            ),
          ),
      )
    : [];
  const entries = [...urlEntries, ...logicalEntries];
  const open = entries.filter((entry) => entry.status === "open");
  const groups = new Map();
  for (const entry of open) {
    for (const flag of entry.flags) {
      if (!groups.has(flag)) groups.set(flag, []);
      groups.get(flag).push({
        key: entry.key,
        ...(Object.hasOwn(entry, "url")
          ? { url: entry.url }
          : {
              card_refs: entry.card_refs,
              identity_status: entry.identity_status,
              primary_ref: entry.primary_ref,
              sources: ledger.source_records
                .filter((source) => source.logical_key === entry.key)
                .map((source) => ({
                  card_ref: source.card_ref,
                  url: source.url,
                  role: source.role,
                  disposition: source.disposition,
                })),
            }),
        ...(Object.hasOwn(entry, "title") ? { title: entry.title } : {}),
        ...(Object.hasOwn(entry, "company") ? { company: entry.company } : {}),
        decision: entry.decision,
        ...(Object.hasOwn(entry, "priority_class") ? { priority_class: entry.priority_class } : {}),
        batch_id: entry.batch_id,
        last_checked: entry.last_checked,
      });
    }
  }
  const rendered = [...groups.entries()]
    .map(([flag, entries]) => ({
      flag,
      count: entries.length,
      fast_lane: entries.some((entry) => entry.priority_class === 1),
      entries: entries.sort((left, right) => left.key.localeCompare(right.key)),
    }))
    .sort(
      (left, right) =>
        Number(right.fast_lane) - Number(left.fast_lane) ||
        right.count - left.count ||
        left.flag.localeCompare(right.flag),
    );
  return {
    as_of: asOf,
    totals: {
      entries: entries.length,
      open: open.length,
      closed: entries.length - open.length,
      flagged_open: open.filter((entry) => entry.flags.length > 0).length,
      unflagged_open: open.filter((entry) => entry.flags.length === 0).length,
      fast_lane_open: open.filter((entry) => entry.priority_class === 1).length,
      decision_groups: rendered.length,
      ...(sourceAware
        ? {
            url_observations: ledger.entries.length,
            logical_vacancies: logicalEntries.length,
            retained_logical_records: ledger.logical_entries.length,
            excluded_url_observations: ledger.entries.length - urlEntries.length,
            source_memberships: ledger.source_records.length,
            corrections: ledger.corrections.length,
          }
        : {}),
    },
    groups: rendered,
    ...(sourceAware ? { sources: ledger.source_records, corrections: ledger.corrections } : {}),
  };
}
