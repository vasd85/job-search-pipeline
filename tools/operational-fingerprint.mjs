#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FINGERPRINT_VERSION = 1;
const HASH_ALGORITHM = "sha256";
const OUTPUT_NAME = Buffer.from("output");
const LEDGER_NAME = Buffer.from("process-log.json");
const METADATA_BASENAME = Buffer.from(".DS_Store");
const SLASH = Buffer.from("/");
const MAX_DIAGNOSTIC_PATH_BYTES = 256;
const MAX_U64 = (1n << 64n) - 1n;

const DOMAINS = Object.freeze({
  inventory: Buffer.from("job-search-pipeline:operational-fingerprint:v1:protected-inventory\0"),
  content: Buffer.from("job-search-pipeline:operational-fingerprint:v1:protected-content\0"),
  metadata: Buffer.from("job-search-pipeline:operational-fingerprint:v1:metadata\0"),
});

export class OperationalFingerprintError extends Error {
  constructor(code, message, diagnostic = undefined) {
    super(message);
    this.name = "OperationalFingerprintError";
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

function fail(code, message, diagnostic) {
  throw new OperationalFingerprintError(code, message, diagnostic);
}

function pathDiagnostic(relativePath) {
  if (!relativePath) return undefined;
  const bounded = relativePath.subarray(0, MAX_DIAGNOSTIC_PATH_BYTES);
  return {
    repositoryRelativePathEncoding: "hex",
    repositoryRelativePath: bounded.toString("hex"),
    repositoryRelativePathTruncated: bounded.length !== relativePath.length,
  };
}

function u64(value) {
  const bigint = BigInt(value);
  if (bigint < 0n || bigint > MAX_U64) {
    fail("fingerprint_value_out_of_range", "a fingerprint field exceeds the v1 framing limit");
  }
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(bigint);
  return bytes;
}

function frame(fields) {
  const framed = [];
  for (const field of fields) {
    const bytes = Buffer.isBuffer(field) ? field : Buffer.from(field);
    framed.push(u64(bytes.length), bytes);
  }
  return Buffer.concat(framed);
}

function hashFramedRecords(domain, records) {
  const hash = createHash(HASH_ALGORITHM);
  hash.update(domain);
  hash.update(u64(records.length));
  for (const record of records) {
    hash.update(u64(record.length));
    hash.update(record);
  }
  return hash.digest("hex");
}

function statSignature(stats) {
  return [
    stats.dev,
    stats.ino,
    stats.mode,
    stats.nlink,
    stats.size,
    stats.mtimeNs,
    stats.ctimeNs,
  ].map((value) => value.toString()).join(":");
}

function sameStat(left, right) {
  return statSignature(left) === statSignature(right);
}

function hasReadBit(stats) {
  return (stats.mode & 0o444n) !== 0n;
}

function hasSearchBit(stats) {
  return (stats.mode & 0o111n) !== 0n;
}

function safeLstat(path, {
  code,
  diagnostic,
  missingCode = code,
  missingMessage,
  message,
  unstableOnMissing = false,
} = {}) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT" && unstableOnMissing) {
      fail(
        "unstable_operational_tree",
        "the operational tree changed while it was being measured",
        diagnostic,
      );
    }
    if (error?.code === "ENOENT") {
      fail(missingCode, missingMessage ?? message, diagnostic);
    }
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      fail(code, message, diagnostic);
    }
    fail(code, message, diagnostic);
  }
}

function validateDirectory(stats, code, message, diagnostic) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail(code, message, diagnostic);
  if (!hasReadBit(stats) || !hasSearchBit(stats)) {
    fail("unreadable_output_entry", "an output entry is not readable", diagnostic);
  }
}

function validateRegularFile(stats, code, message, diagnostic) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
    fail(code, message, diagnostic);
  }
  if (!hasReadBit(stats)) fail("unreadable_output_entry", "an output entry is not readable", diagnostic);
}

function joinRaw(parent, child) {
  return Buffer.concat([parent, SLASH, child]);
}

function measureRegularFile(absolutePath, relativePath, {
  invalidCode = "unsupported_output_entry",
  invalidMessage = "output contains a symlink, special file, or hard-linked file",
  unreadableCode = "unreadable_output_entry",
} = {}) {
  const diagnostic = pathDiagnostic(relativePath);
  const beforePath = safeLstat(absolutePath, {
    code: unreadableCode,
    diagnostic,
    message: "an output entry is not readable",
    unstableOnMissing: true,
  });
  validateRegularFile(beforePath, invalidCode, invalidMessage, diagnostic);

  let fd;
  try {
    fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes(error?.code)) {
      fail(
        "unstable_operational_tree",
        "the operational tree changed while it was being measured",
        diagnostic,
      );
    }
    fail(unreadableCode, "an output entry is not readable", diagnostic);
  }

  try {
    const beforeDescriptor = fstatSync(fd, { bigint: true });
    if (!sameStat(beforePath, beforeDescriptor)) {
      fail(
        "unstable_operational_tree",
        "the operational tree changed while it was being measured",
        diagnostic,
      );
    }

    const hash = createHash(HASH_ALGORITHM);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let totalBytes = 0n;
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      totalBytes += BigInt(bytesRead);
    }

    const afterDescriptor = fstatSync(fd, { bigint: true });
    const afterPath = safeLstat(absolutePath, {
      code: unreadableCode,
      diagnostic,
      message: "an output entry is not readable",
      unstableOnMissing: true,
    });
    if (
      totalBytes !== beforeDescriptor.size
      || !sameStat(beforeDescriptor, afterDescriptor)
      || !sameStat(afterDescriptor, afterPath)
    ) {
      fail(
        "unstable_operational_tree",
        "the operational tree changed while it was being measured",
        diagnostic,
      );
    }

    return {
      contentDigest: hash.digest(),
      size: totalBytes,
      stat: statSignature(afterDescriptor),
    };
  } finally {
    closeSync(fd);
  }
}

function walkOutputDirectory(absolutePath, relativePath, entries) {
  const diagnostic = pathDiagnostic(relativePath);
  const before = safeLstat(absolutePath, {
    code: "unreadable_output_entry",
    diagnostic,
    message: "an output entry is not readable",
    unstableOnMissing: true,
  });
  validateDirectory(before, "unsupported_output_entry", "output contains a non-directory entry where a directory was expected", diagnostic);
  entries.push({ path: relativePath, stat: statSignature(before), type: "directory" });

  let children;
  try {
    children = readdirSync(absolutePath, { encoding: "buffer", withFileTypes: true });
  } catch {
    fail("unreadable_output_entry", "an output entry is not readable", diagnostic);
  }
  children.sort((left, right) => Buffer.compare(left.name, right.name));

  for (const child of children) {
    const childAbsolute = joinRaw(absolutePath, child.name);
    const childRelative = joinRaw(relativePath, child.name);
    const childDiagnostic = pathDiagnostic(childRelative);
    const childStats = safeLstat(childAbsolute, {
      code: "unreadable_output_entry",
      diagnostic: childDiagnostic,
      message: "an output entry is not readable",
      unstableOnMissing: true,
    });

    if (childStats.isDirectory() && !childStats.isSymbolicLink()) {
      walkOutputDirectory(childAbsolute, childRelative, entries);
      continue;
    }
    if (childStats.isFile() && !childStats.isSymbolicLink()) {
      const measured = measureRegularFile(childAbsolute, childRelative);
      const metadata = child.name.equals(METADATA_BASENAME);
      entries.push({
        contentDigest: measured.contentDigest,
        metadata,
        path: childRelative,
        size: measured.size,
        stat: measured.stat,
        type: "regularFile",
      });
      continue;
    }
    fail(
      "unsupported_output_entry",
      "output contains a symlink or special file",
      childDiagnostic,
    );
  }

  const after = safeLstat(absolutePath, {
    code: "unreadable_output_entry",
    diagnostic,
    message: "an output entry is not readable",
    unstableOnMissing: true,
  });
  if (!sameStat(before, after)) {
    fail(
      "unstable_operational_tree",
      "the operational tree changed while it was being measured",
      diagnostic,
    );
  }
}

function validateTopology(root) {
  const rootStats = safeLstat(root, {
    code: "invalid_operational_root",
    message: "operational root must be a readable canonical directory",
    missingCode: "operational_root_missing",
    missingMessage: "operational root is missing",
  });
  if (rootStats.isSymbolicLink()) {
    fail("operational_root_alias", "operational root must not use a symlink alias");
  }
  if (!rootStats.isDirectory() || !hasReadBit(rootStats) || !hasSearchBit(rootStats)) {
    fail("invalid_operational_root", "operational root must be a readable canonical directory");
  }

  let canonical;
  try {
    canonical = realpathSync.native(root);
  } catch {
    fail("invalid_operational_root", "operational root must be a readable canonical directory");
  }
  if (canonical !== root) {
    fail("operational_root_alias", "operational root must not use a symlink alias");
  }

  const rootBuffer = Buffer.from(root);
  const outputPath = joinRaw(rootBuffer, OUTPUT_NAME);
  const ledgerPath = joinRaw(rootBuffer, LEDGER_NAME);
  const outputStats = safeLstat(outputPath, {
    code: "invalid_output_root",
    message: "output root must be a readable direct child directory",
    missingCode: "output_root_missing",
    missingMessage: "output root is missing",
  });
  if (outputStats.isSymbolicLink() || !outputStats.isDirectory()) {
    fail("invalid_output_root", "output root must be a readable direct child directory");
  }
  if (!hasReadBit(outputStats) || !hasSearchBit(outputStats)) {
    fail("invalid_output_root", "output root must be a readable direct child directory");
  }

  const ledgerStats = safeLstat(ledgerPath, {
    code: "invalid_process_log",
    message: "process-log.json must be a readable direct child regular file",
    missingCode: "process_log_missing",
    missingMessage: "process-log.json is missing",
  });
  if (
    ledgerStats.isSymbolicLink()
    || !ledgerStats.isFile()
    || ledgerStats.nlink !== 1n
    || !hasReadBit(ledgerStats)
  ) {
    fail("invalid_process_log", "process-log.json must be a readable direct child regular file");
  }
  return { ledgerPath, outputPath, rootBuffer };
}

function snapshot(root) {
  const { ledgerPath, outputPath, rootBuffer } = validateTopology(root);
  const rootBefore = lstatSync(root, { bigint: true });
  const entries = [];
  walkOutputDirectory(outputPath, OUTPUT_NAME, entries);
  entries.sort((left, right) => Buffer.compare(left.path, right.path));
  const ledger = measureRegularFile(ledgerPath, LEDGER_NAME, {
    invalidCode: "invalid_process_log",
    invalidMessage: "process-log.json must be a non-hard-linked regular file",
    unreadableCode: "invalid_process_log",
  });
  const rootAfter = safeLstat(rootBuffer, {
    code: "invalid_operational_root",
    message: "operational root must remain readable",
    unstableOnMissing: true,
  });
  if (!sameStat(rootBefore, rootAfter)) {
    fail("unstable_operational_tree", "the operational tree changed while it was being measured");
  }

  return {
    entries,
    ledger,
    rootStat: statSignature(rootAfter),
  };
}

function stabilityKey(measurement) {
  return JSON.stringify({
    rootStat: measurement.rootStat,
    ledger: {
      contentDigest: measurement.ledger.contentDigest.toString("hex"),
      size: measurement.ledger.size.toString(),
      stat: measurement.ledger.stat,
    },
    entries: measurement.entries.map((entry) => ({
      contentDigest: entry.contentDigest?.toString("hex") ?? null,
      metadata: entry.metadata ?? false,
      path: entry.path.toString("hex"),
      size: entry.size?.toString() ?? null,
      stat: entry.stat,
      type: entry.type,
    })),
  });
}

function buildRecord(root, measurement) {
  const protectedEntries = measurement.entries.filter((entry) => !entry.metadata);
  const protectedFiles = protectedEntries.filter((entry) => entry.type === "regularFile");
  const protectedDirectories = protectedEntries.filter((entry) => entry.type === "directory");
  const metadataEntries = measurement.entries.filter((entry) => entry.metadata);

  const inventoryRecords = protectedEntries.map((entry) => frame([
    entry.type === "directory" ? Buffer.from([0x44]) : Buffer.from([0x46]),
    entry.path,
  ]));
  const contentRecords = protectedFiles.map((entry) => frame([
    entry.path,
    u64(entry.size),
    entry.contentDigest,
  ]));
  const metadataRecords = metadataEntries.map((entry) => frame([
    Buffer.from([0x4d]),
    entry.path,
    u64(entry.size),
    entry.contentDigest,
  ]));
  const protectedBytes = protectedFiles.reduce((total, entry) => total + entry.size, 0n);
  const metadataBytes = metadataEntries.reduce((total, entry) => total + entry.size, 0n);

  return {
    fingerprintVersion: FINGERPRINT_VERSION,
    hashAlgorithm: HASH_ALGORITHM,
    operationalRoot: root,
    output: {
      protected: {
        inventory: {
          entryCount: protectedEntries.length,
          entryTypes: {
            directory: protectedDirectories.length,
            regularFile: protectedFiles.length,
          },
          digest: hashFramedRecords(DOMAINS.inventory, inventoryRecords),
        },
        content: {
          regularFileCount: protectedFiles.length,
          totalBytes: protectedBytes.toString(),
          digest: hashFramedRecords(DOMAINS.content, contentRecords),
        },
      },
      metadata: {
        allowlistedRegularFileBasenames: [METADATA_BASENAME.toString("ascii")],
        entryCount: metadataEntries.length,
        entryTypes: { regularFile: metadataEntries.length },
        totalBytes: metadataBytes.toString(),
        digest: hashFramedRecords(DOMAINS.metadata, metadataRecords),
      },
    },
    ledger: {
      path: LEDGER_NAME.toString("ascii"),
      totalBytes: measurement.ledger.size.toString(),
      digest: measurement.ledger.contentDigest.toString("hex"),
    },
  };
}

export function fingerprintOperationalRoot(rootInput, { cwd = process.cwd() } = {}) {
  if (typeof rootInput !== "string" || rootInput.length === 0) {
    fail("invalid_fingerprint_arguments", "usage: operational-fingerprint.mjs --root <operational-checkout>");
  }
  if (constants.O_NOFOLLOW === undefined) {
    fail("fingerprint_platform_unsupported", "this platform cannot enforce no-follow file reads");
  }
  const root = resolve(cwd, rootInput);
  const first = snapshot(root);
  const second = snapshot(root);
  if (stabilityKey(first) !== stabilityKey(second)) {
    fail("unstable_operational_tree", "the operational tree changed while it was being measured");
  }
  return buildRecord(root, second);
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--root" || !argv[1] || argv[1].startsWith("--")) {
    fail("invalid_fingerprint_arguments", "usage: operational-fingerprint.mjs --root <operational-checkout>");
  }
  return argv[1];
}

function serializeError(error) {
  const safe = error instanceof OperationalFingerprintError
    ? error
    : new OperationalFingerprintError("operational_fingerprint_failed", "operational fingerprint failed");
  const payload = {
    error: {
      code: safe.code,
      message: safe.message,
      ...(safe.diagnostic ? { diagnostic: safe.diagnostic } : {}),
    },
  };
  return `${JSON.stringify(payload)}\n`;
}

function main() {
  try {
    const root = parseArguments(process.argv.slice(2));
    const record = fingerprintOperationalRoot(root);
    process.stdout.write(`${JSON.stringify(record)}\n`);
  } catch (error) {
    process.stderr.write(serializeError(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
