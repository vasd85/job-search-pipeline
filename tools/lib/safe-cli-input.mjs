import * as defaultFileSystem from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import {
  processLogDiagnosticLimits,
  processLogStableDiagnosticCodePattern,
} from "./process-log-diagnostics.mjs";

export const safeCliInputMaxBytes = 65_536;
export const safeCliInputBasenamePattern = /^input-([0-9a-f]{32})\.json$/;

const maxJsonDepth = 64;
const stableDiagnosticCodePattern = processLogStableDiagnosticCodePattern;
const {
  codeMaxBytes: diagnosticCodeMaxBytes,
  detailMaxBytes: diagnosticDetailMaxBytes,
  detailsMaxItems: diagnosticDetailsMaxItems,
  messageMaxBytes: diagnosticMessageMaxBytes,
} = processLogDiagnosticLimits;
const safeDiagnosticMessages = Object.freeze({
  blocker: "The operation stopped on a controlled blocker.",
  error: "The operation ended with a controlled error.",
});
const externalValueOptions = Object.freeze([
  "source-ref",
  "company-hint",
  "company-observed",
  "role",
  "query",
  "display-name",
  "term",
  "domain",
  "blocker-json",
  "error-json",
  "waivers-json",
]);
const waiverSubjectKinds = Object.freeze(["check", "decision"]);
const waiverRecordsMaxItems = 16;

/*
 * Bounded defaults for a `stringListFields` value. A command schema may narrow them; nothing may
 * widen them past the envelope ceiling, which the whole-payload size check enforces anyway.
 */
export const safeCliInputStringListDefaults = Object.freeze({
  maxItems: 512,
  itemMaxBytes: 4096,
});

const commandSchemas = Object.freeze({
  start: Object.freeze({
    required: ["sourceRef"],
    optional: ["companyHint"],
    optionNames: Object.freeze({
      companyHint: "company-hint",
      sourceRef: "source-ref",
    }),
  }),
  update: Object.freeze({
    required: [],
    optional: ["companyObserved", "companyHint", "role"],
    atLeastOne: true,
    optionNames: Object.freeze({
      companyHint: "company-hint",
      companyObserved: "company-observed",
      role: "role",
    }),
  }),
  resolve: Object.freeze({
    required: ["sourceRef"],
    optional: [],
    disallowedMachineOptions: ["id", "output-dir"],
    optionNames: Object.freeze({
      sourceRef: "source-ref",
    }),
  }),
  "find-company": Object.freeze({
    required: ["query"],
    optional: [],
    optionNames: Object.freeze({
      query: "query",
    }),
  }),
  "create-company": Object.freeze({
    required: ["displayName"],
    optional: ["term", "domain"],
    optionNames: Object.freeze({
      displayName: "display-name",
      domain: "domain",
      term: "term",
    }),
  }),
  "rename-company": Object.freeze({
    required: ["displayName"],
    optional: [],
    optionNames: Object.freeze({
      displayName: "display-name",
    }),
  }),
  "add-company-term": Object.freeze({
    required: ["term"],
    optional: [],
    optionNames: Object.freeze({ term: "term" }),
  }),
  "remove-company-term": Object.freeze({
    required: ["term"],
    optional: [],
    optionNames: Object.freeze({ term: "term" }),
  }),
  "add-company-domain": Object.freeze({
    required: ["domain"],
    optional: [],
    optionNames: Object.freeze({ domain: "domain" }),
  }),
  "remove-company-domain": Object.freeze({
    required: ["domain"],
    optional: [],
    optionNames: Object.freeze({ domain: "domain" }),
  }),
  "publish-step": Object.freeze({
    required: [],
    optional: ["blocker", "waivers"],
    optionNames: Object.freeze({ blocker: "blocker-json", waivers: "waivers-json" }),
    objectFields: Object.freeze(["blocker"]),
    waiverFields: Object.freeze(["waivers"]),
  }),
  "fail-step": Object.freeze({
    required: ["error"],
    optional: [],
    optionNames: Object.freeze({ error: "error-json" }),
    objectFields: Object.freeze(["error"]),
  }),
  "revise-step": Object.freeze({
    required: [],
    optional: ["waivers"],
    optionNames: Object.freeze({ waivers: "waivers-json" }),
    waiverFields: Object.freeze(["waivers"]),
  }),
});

export class SafeCliInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SafeCliInputError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SafeCliInputError(code, message);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonFailure() {
  fail("safe_input_invalid_json", "Input payload must be strict JSON.");
}

function parseStrictJson(source) {
  let index = 0;

  function skipWhitespace() {
    while (
      source[index] === " " ||
      source[index] === "\t" ||
      source[index] === "\n" ||
      source[index] === "\r"
    ) {
      index += 1;
    }
  }

  function parseString() {
    if (source[index] !== '"') jsonFailure();
    const start = index;
    index += 1;
    while (index < source.length) {
      const code = source.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        try {
          return JSON.parse(source.slice(start, index));
        } catch {
          jsonFailure();
        }
      }
      if (code < 0x20) jsonFailure();
      if (code === 0x5c) {
        index += 1;
        const escape = source[index];
        if (escape === "u") {
          const digits = source.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) jsonFailure();
          index += 5;
          continue;
        }
        if (!['"', "\\", "/", "b", "f", "n", "r", "t"].includes(escape)) {
          jsonFailure();
        }
      }
      index += 1;
    }
    jsonFailure();
  }

  function parseNumber() {
    const match = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) jsonFailure();
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) jsonFailure();
    return value;
  }

  function parseArray(depth) {
    index += 1;
    const result = [];
    skipWhitespace();
    if (source[index] === "]") {
      index += 1;
      return result;
    }
    while (index < source.length) {
      result.push(parseValue(depth + 1));
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return result;
      }
      if (source[index] !== ",") jsonFailure();
      index += 1;
      skipWhitespace();
    }
    jsonFailure();
  }

  function parseObject(depth) {
    index += 1;
    const result = Object.create(null);
    const keys = new Set();
    skipWhitespace();
    if (source[index] === "}") {
      index += 1;
      return result;
    }
    while (index < source.length) {
      const key = parseString();
      if (keys.has(key)) jsonFailure();
      keys.add(key);
      skipWhitespace();
      if (source[index] !== ":") jsonFailure();
      index += 1;
      skipWhitespace();
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: parseValue(depth + 1),
        writable: true,
      });
      skipWhitespace();
      if (source[index] === "}") {
        index += 1;
        return result;
      }
      if (source[index] !== ",") jsonFailure();
      index += 1;
      skipWhitespace();
    }
    jsonFailure();
  }

  function parseValue(depth) {
    if (depth > maxJsonDepth) jsonFailure();
    skipWhitespace();
    const token = source[index];
    if (token === '"') return parseString();
    if (token === "{") return parseObject(depth);
    if (token === "[") return parseArray(depth);
    if (token === "-" || (token >= "0" && token <= "9")) {
      return parseNumber();
    }
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ]) {
      if (source.startsWith(literal, index)) {
        index += literal.length;
        return value;
      }
    }
    jsonFailure();
  }

  const value = parseValue(0);
  skipWhitespace();
  if (index !== source.length) jsonFailure();
  return value;
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertSafeStrings(value, depth = 0) {
  if (depth > maxJsonDepth) {
    fail("safe_input_schema_mismatch", "Input payload schema is invalid.");
  }
  if (typeof value === "string") {
    if (
      value.includes("\0") ||
      hasUnpairedSurrogate(value) ||
      Buffer.byteLength(value, "utf8") > safeCliInputMaxBytes
    ) {
      fail("safe_input_schema_mismatch", "Input payload schema is invalid.");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeStrings(item, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertSafeStrings(key, depth + 1);
      assertSafeStrings(item, depth + 1);
    }
  }
}

function assertExactKeys(value, required, optional = []) {
  if (!isRecord(value)) {
    fail("safe_input_schema_mismatch", "Input payload schema is invalid.");
  }
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    actual.some((key) => !allowed.has(key))
  ) {
    fail("safe_input_schema_mismatch", "Input payload schema is invalid.");
  }
}

function assertDiagnostic(value) {
  assertExactKeys(value, ["code", "message", "retryable"], ["details"]);
  if (
    typeof value.code !== "string" ||
    typeof value.message !== "string" ||
    typeof value.retryable !== "boolean" ||
    !stableDiagnosticCodePattern.test(value.code) ||
    Buffer.byteLength(value.code, "utf8") > diagnosticCodeMaxBytes ||
    Buffer.byteLength(value.message, "utf8") > diagnosticMessageMaxBytes ||
    (Object.hasOwn(value, "details") &&
      (!Array.isArray(value.details) ||
        value.details.length > diagnosticDetailsMaxItems ||
        value.details.some(
          (item) =>
            typeof item !== "string" || Buffer.byteLength(item, "utf8") > diagnosticDetailMaxBytes,
        )))
  ) {
    fail("safe_input_schema_mismatch", "Input payload schema is invalid.");
  }
}

/*
 * Waiver records are the one envelope class that carries user-owned text as bounded data: the
 * note is a journaled record (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#5-edit-channels-and-transports(a)), so it is bounded here and re-validated by the
 * lifecycle instead of being discarded like diagnostic prose.
 */
function assertWaiverRecords(value) {
  if (!Array.isArray(value) || value.length > waiverRecordsMaxItems) {
    fail("safe_input_schema_mismatch", "Input payload schema is invalid.");
  }
  for (const record of value) {
    assertExactKeys(record, ["subject"], ["note"]);
    assertExactKeys(record.subject, ["kind", "key"]);
    if (
      !waiverSubjectKinds.includes(record.subject.kind) ||
      typeof record.subject.key !== "string" ||
      record.subject.key.length === 0 ||
      Buffer.byteLength(record.subject.key, "utf8") > diagnosticDetailMaxBytes ||
      (Object.hasOwn(record, "note") &&
        (typeof record.note !== "string" ||
          record.note.length === 0 ||
          Buffer.byteLength(record.note, "utf8") > diagnosticMessageMaxBytes))
    ) {
      fail("safe_input_schema_mismatch", "Input payload schema is invalid.");
    }
  }
}

/*
 * A list of non-empty strings, bounded in item count and per-item size. This is the one value
 * shape beyond a bare string, a diagnostic object and a waiver record that the envelope carries:
 * a batch of vacancy URLs is a list, and splitting it into numbered string keys would only move
 * the same data behind a worse schema.
 */
function assertStringList(value, limits) {
  const maxItems = limits?.maxItems ?? safeCliInputStringListDefaults.maxItems;
  const itemMaxBytes = limits?.itemMaxBytes ?? safeCliInputStringListDefaults.itemMaxBytes;
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    fail("safe_input_schema_mismatch", "Input payload schema is invalid.");
  }
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      Buffer.byteLength(item, "utf8") > itemMaxBytes
    ) {
      fail("safe_input_schema_mismatch", "Input payload schema is invalid.");
    }
  }
}

function validateEnvelope(value, command, nonce, schemas) {
  assertExactKeys(value, ["schemaVersion", "command", "nonce", "values"]);
  if (value.schemaVersion !== 1 || !isRecord(value.values)) {
    fail("safe_input_schema_mismatch", "Input payload schema is invalid.");
  }
  if (value.command !== command) {
    fail("safe_input_command_mismatch", "Input payload command does not match the CLI command.");
  }
  if (value.nonce !== nonce) {
    fail("safe_input_nonce_mismatch", "Input payload nonce does not match its filename.");
  }

  // Own-property lookup: a bare `schemas[command]` resolves inherited names such as
  // `toString` to a truthy value and would reach the field loop below with no key sets.
  const schema = Object.hasOwn(schemas, command) ? schemas[command] : null;
  if (!schema) {
    fail("safe_input_command_mismatch", "This CLI command does not accept an input payload.");
  }
  assertExactKeys(value.values, schema.required, schema.optional);
  if (schema.atLeastOne && Object.keys(value.values).length === 0) {
    fail("safe_input_schema_mismatch", "Input payload schema is invalid.");
  }
  for (const [key, item] of Object.entries(value.values)) {
    if (schema.objectFields?.includes(key)) {
      assertDiagnostic(item);
    } else if (schema.waiverFields?.includes(key)) {
      assertWaiverRecords(item);
    } else if (schema.stringListFields?.includes(key)) {
      assertStringList(item, schema.stringListLimits?.[key]);
    } else if (typeof item !== "string") {
      fail("safe_input_schema_mismatch", "Input payload schema is invalid.");
    }
  }
  assertSafeStrings(value);
  return value;
}

function modeBits(stats) {
  return stats.mode & 0o7777n;
}

function sameIdentityAndMetadata(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.isFile() === right.isFile()
  );
}

function inspectInputRoot(inputRoot, fileSystem, uid) {
  if (typeof inputRoot !== "string" || !isAbsolute(inputRoot) || resolve(inputRoot) !== inputRoot) {
    fail("safe_input_unsafe_path", "Input root path is unsafe.");
  }
  let stats;
  let realPath;
  try {
    stats = fileSystem.lstatSync(inputRoot, { bigint: true });
    realPath = fileSystem.realpathSync(inputRoot);
  } catch {
    fail("safe_input_root_invalid", "Input root is unavailable or unsafe.");
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    stats.uid !== BigInt(uid) ||
    modeBits(stats) !== 0o700n ||
    realPath !== inputRoot
  ) {
    fail("safe_input_root_invalid", "Input root is unavailable or unsafe.");
  }
}

function inspectInputFile(stats, uid) {
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.uid !== BigInt(uid) ||
    modeBits(stats) !== 0o600n ||
    stats.nlink !== 1n
  ) {
    fail("safe_input_file_invalid", "Input file type or permissions are unsafe.");
  }
  if (stats.size > BigInt(safeCliInputMaxBytes)) {
    fail("safe_input_oversize", "Input payload exceeds 65,536 bytes.");
  }
}

function readDescriptor(fileSystem, descriptor) {
  const bytes = Buffer.alloc(safeCliInputMaxBytes + 1);
  let total = 0;
  while (total < bytes.length) {
    const read = fileSystem.readSync(descriptor, bytes, total, bytes.length - total, null);
    if (read === 0) break;
    total += read;
  }
  if (total > safeCliInputMaxBytes) {
    fail("safe_input_oversize", "Input payload exceeds 65,536 bytes.");
  }
  return bytes.subarray(0, total);
}

/*
 * `schemas` defaults to the process-log command map, so every existing caller is unchanged. A
 * second CLI that needs the same hardened descriptor read supplies its own command map rather
 * than adding its commands to this module: the reader is shared, the command vocabulary is not.
 */
export function readSafeCliInput({
  basename,
  command,
  fileSystem = defaultFileSystem,
  inputRoot,
  platform = process.platform,
  schemas = commandSchemas,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
}) {
  if (
    !["darwin", "linux"].includes(platform) ||
    !Number.isSafeInteger(uid) ||
    typeof fileSystem.constants?.O_NOFOLLOW !== "number"
  ) {
    fail("safe_input_unsupported_platform", "Safe input files are unsupported on this platform.");
  }
  const match = typeof basename === "string" ? basename.match(safeCliInputBasenamePattern) : null;
  if (!match) {
    fail("safe_input_unsafe_path", "Input filename is unsafe.");
  }
  inspectInputRoot(inputRoot, fileSystem, uid);
  const inputPath = join(inputRoot, basename);
  let pathStats;
  try {
    pathStats = fileSystem.lstatSync(inputPath, { bigint: true });
  } catch {
    fail("safe_input_file_invalid", "Input file type or permissions are unsafe.");
  }
  inspectInputFile(pathStats, uid);

  let descriptor = null;
  let failure = null;
  let bytes = null;
  try {
    try {
      descriptor = fileSystem.openSync(
        inputPath,
        fileSystem.constants.O_RDONLY | fileSystem.constants.O_NOFOLLOW,
      );
    } catch {
      fail("safe_input_file_invalid", "Input file type or permissions are unsafe.");
    }
    const openedStats = fileSystem.fstatSync(descriptor, { bigint: true });
    inspectInputFile(openedStats, uid);
    if (!sameIdentityAndMetadata(pathStats, openedStats)) {
      fail("safe_input_replaced", "Input file changed during validation.");
    }
    bytes = readDescriptor(fileSystem, descriptor);
    const finalStats = fileSystem.fstatSync(descriptor, { bigint: true });
    if (!sameIdentityAndMetadata(openedStats, finalStats)) {
      fail("safe_input_replaced", "Input file changed during the read.");
    }
  } catch (error) {
    failure =
      error instanceof SafeCliInputError
        ? error
        : new SafeCliInputError("safe_input_file_invalid", "Input file could not be read safely.");
  } finally {
    if (descriptor !== null) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        if (failure === null) {
          failure = new SafeCliInputError(
            "safe_input_file_invalid",
            "Input file could not be closed safely.",
          );
        }
      }
    }
  }
  if (failure) throw failure;

  if (bytes.length >= 1 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail("safe_input_invalid_utf8", "Input payload must be UTF-8 without a BOM.");
  }
  if (bytes.includes(0)) {
    fail("safe_input_invalid_utf8", "Input payload contains a forbidden NUL byte.");
  }
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("safe_input_invalid_utf8", "Input payload must be valid UTF-8.");
  }
  const parsed = parseStrictJson(source);
  return validateEnvelope(parsed, command, match[1], schemas);
}

export function hydrateSafeCliOptions({
  command,
  fileSystem = defaultFileSystem,
  inputRoot,
  options,
  platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
}) {
  if (!Object.hasOwn(options, "input-file")) {
    return { options, transported: false };
  }
  const schema = commandSchemas[command];
  if (!schema) {
    fail("safe_input_command_mismatch", "This CLI command does not accept an input payload.");
  }
  if (externalValueOptions.some((key) => Object.hasOwn(options, key))) {
    fail(
      "safe_input_conflicting_flags",
      "Do not combine --input-file with legacy external-value flags.",
    );
  }
  if (schema.disallowedMachineOptions?.some((key) => Object.hasOwn(options, key))) {
    fail("safe_input_conflicting_flags", "Input payload conflicts with another command selector.");
  }
  const basename = options["input-file"];
  const envelope = readSafeCliInput({
    basename,
    command,
    fileSystem,
    inputRoot,
    platform,
    uid,
  });
  if (
    command === "update" &&
    options["clear-company-hint"] &&
    Object.hasOwn(envelope.values, "companyHint")
  ) {
    fail("safe_input_conflicting_flags", "Input companyHint conflicts with --clear-company-hint.");
  }

  const merged = { ...options };
  delete merged["input-file"];
  for (const [key, value] of Object.entries(envelope.values)) {
    const optionName = schema.optionNames[key];
    if (schema.objectFields?.includes(key)) {
      merged[optionName] = JSON.stringify({
        code: value.code,
        message: safeDiagnosticMessages[key],
        retryable: value.retryable,
        details: [],
      });
    } else if (schema.waiverFields?.includes(key)) {
      merged[optionName] = JSON.stringify(
        value.map((record) => ({
          subject: { kind: record.subject.kind, key: record.subject.key },
          ...(Object.hasOwn(record, "note") ? { note: record.note } : {}),
        })),
      );
    } else {
      merged[optionName] = value;
    }
  }
  return { options: merged, transported: true };
}
