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
 * The ledger is the operational index — one mutable row per vacancy, the single truth about what
 * is live now. The history beside it is the batch store: `recordBatch` writes one immutable
 * `ledger-record.json` into the batch's own directory, and a re-score of the same vacancy adds a
 * record under a new batch id rather than replacing the first. `docs/runbooks/triage-review.md`
 * docs/runbooks/triage-review.md#11-batch-store-the-history-beside-the-index owns where that store lives and what happens to it over time; this file owns the
 * record's schema and the discipline of writing it.
 */

import {
  closeSync,
  mkdirSync,
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

export const triageLedgerSchemaVersion = 1;

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

export function emptyLedger() {
  return { schema_version: triageLedgerSchemaVersion, batches: [], entries: [] };
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
    ["schema_version", "batches", "entries"],
    [],
    "triage_ledger_invalid",
    "The ledger",
  );
  if (raw.schema_version !== triageLedgerSchemaVersion) {
    fail(
      "triage_ledger_schema_version",
      `The ledger declares schema_version ${String(raw.schema_version)}; this build reads ` +
        `${triageLedgerSchemaVersion}.`,
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
      ["policy_id"],
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
  });
  raw.entries.forEach(validateEntry);
  const keys = new Set();
  for (const entry of raw.entries) {
    if (keys.has(entry.key)) fail("triage_ledger_invalid", `Duplicate ledger key ${entry.key}.`);
    keys.add(entry.key);
  }
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

export function initLedger(path) {
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
    writeSync(descriptor, serializeLedger(emptyLedger()));
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

/**
 * The review runbook's mechanical half: every open ledger entry that still carries a flag, grouped
 * by that flag. One group is one decision — `docs/runbooks/triage-review.md` owns the mapping from
 * a flag family to the single user decision or policy fix that clears it. A vacancy carrying two
 * flags appears in two groups on purpose: it genuinely needs both decisions.
 */
export function reviewLedger(ledger, { asOf } = {}) {
  validateLedger(ledger);
  parseInstant(asOf, "triage_ledger_invalid_instant");
  const open = ledger.entries.filter((entry) => entry.status === "open");
  const groups = new Map();
  for (const entry of open) {
    for (const flag of entry.flags) {
      if (!groups.has(flag)) groups.set(flag, []);
      groups.get(flag).push({
        key: entry.key,
        url: entry.url,
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
      entries: ledger.entries.length,
      open: open.length,
      closed: ledger.entries.length - open.length,
      flagged_open: open.filter((entry) => entry.flags.length > 0).length,
      unflagged_open: open.filter((entry) => entry.flags.length === 0).length,
      fast_lane_open: open.filter((entry) => entry.priority_class === 1).length,
      decision_groups: rendered.length,
    },
    groups: rendered,
  };
}
