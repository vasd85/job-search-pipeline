import assert from "node:assert/strict";
import {
  closeSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fingerprintPath = join(repoRoot, "tools", "operational-fingerprint.mjs");
const HASH = /^[0-9a-f]{64}$/;
const FINGERPRINT_VERSION = 1;
const ALLOWLIST = [".DS_Store"];
const canonicalTmpdir = realpathSync.native(tmpdir());

function makeTreeWritable(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) return;
  chmodSync(path, stats.isDirectory() ? 0o700 : 0o600);
  if (!stats.isDirectory()) return;
  for (const name of readdirSync(path, { encoding: "buffer" })) {
    makeTreeWritable(Buffer.concat([Buffer.from(path), Buffer.from("/"), name]));
  }
}

function createOperationalRoot(t, prefix = "job-search-fingerprint-") {
  const root = mkdtempSync(join(canonicalTmpdir, prefix));
  const output = join(root, "output");
  const ledger = join(root, "process-log.json");
  mkdirSync(output);
  writeFileSync(ledger, '{"schema_version":3,"processes":[]}\n');
  t.after(() => {
    try {
      makeTreeWritable(root);
    } catch {
      // A negative case may already have replaced the path.
    }
    rmSync(root, { force: true, recursive: true });
  });
  return { ledger, output, root };
}

function runFingerprint(root, { cwd = repoRoot, env = {} } = {}) {
  return spawnSync(process.execPath, [fingerprintPath, "--root", root], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function parseSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

function parseFailure(result, code) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.length <= 2048, `unbounded stderr: ${result.stderr.length}`);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.error.code, code);
  assert.equal(typeof payload.error.message, "string");
  return payload.error;
}

function protectedEvidence(record) {
  return record.output.protected;
}

function assertDigest(value) {
  assert.match(value, HASH);
}

function writeRawChild(parent, nameBytes, bytes) {
  const path = Buffer.concat([
    Buffer.from(parent),
    Buffer.from("/"),
    Buffer.from(nameBytes),
  ]);
  writeFileSync(path, bytes);
}

function runWhileMutating(root, target) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [fingerprintPath, "--root", root], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectRun);

    const fd = openSync(target, "r+");
    let value = 0;
    const timer = setInterval(() => {
      value ^= 0xff;
      writeSync(fd, Buffer.from([value]), 0, 1, 0);
    }, 0);

    child.on("close", (status) => {
      clearInterval(timer);
      closeSync(fd);
      resolveRun({ status, stderr, stdout });
    });
  });
}

test("CLI emits the frozen v1 schema and reads without mutating the operational tree", (t) => {
  const environment = createOperationalRoot(t);
  mkdirSync(join(environment.output, "empty"));
  writeFileSync(join(environment.output, "artifact.txt"), "protected sentinel\n");
  writeFileSync(join(environment.output, ".DS_Store"), "metadata sentinel\n");

  const beforeLedger = readFileSync(environment.ledger);
  const beforeEntries = readdirSync(environment.output).sort();
  const result = runFingerprint(environment.root);
  const record = parseSuccess(result);

  assert.deepEqual(Object.keys(record), [
    "fingerprintVersion",
    "hashAlgorithm",
    "operationalRoot",
    "output",
    "ledger",
  ]);
  assert.equal(record.fingerprintVersion, FINGERPRINT_VERSION);
  assert.equal(record.hashAlgorithm, "sha256");
  assert.equal(record.operationalRoot, environment.root);
  assert.deepEqual(Object.keys(record.output), ["protected", "metadata"]);
  assert.deepEqual(Object.keys(record.output.protected), ["inventory", "content"]);
  assert.deepEqual(record.output.protected.inventory, {
    entryCount: 3,
    entryTypes: { directory: 2, regularFile: 1 },
    digest: record.output.protected.inventory.digest,
  });
  assert.deepEqual(record.output.protected.content, {
    regularFileCount: 1,
    totalBytes: "19",
    digest: record.output.protected.content.digest,
  });
  assert.deepEqual(record.output.metadata, {
    allowlistedRegularFileBasenames: ALLOWLIST,
    entryCount: 1,
    entryTypes: { regularFile: 1 },
    totalBytes: "18",
    digest: record.output.metadata.digest,
  });
  assert.deepEqual(Object.keys(record.ledger), ["path", "totalBytes", "digest"]);
  assert.equal(record.ledger.path, "process-log.json");
  for (const digest of [
    record.output.protected.inventory.digest,
    record.output.protected.content.digest,
    record.output.metadata.digest,
    record.ledger.digest,
  ]) assertDigest(digest);

  assert.deepEqual(readdirSync(environment.output).sort(), beforeEntries);
  assert.deepEqual(readFileSync(environment.ledger), beforeLedger);
  assert.doesNotMatch(result.stdout, /protected sentinel|metadata sentinel|schema_version/);
});

test("absolute, relative, different-cwd, dot-dot, and locale variants are identical", (t) => {
  const environment = createOperationalRoot(t);
  mkdirSync(join(environment.output, "dir"));
  writeFileSync(join(environment.output, "dir", "artifact"), "bytes");

  const absolute = parseSuccess(runFingerprint(environment.root, { env: { LC_ALL: "C" } }));
  const fromParent = parseSuccess(runFingerprint(basename(environment.root), {
    cwd: dirname(environment.root),
    env: { LC_ALL: "tr_TR.UTF-8" },
  }));
  const cwd = mkdtempSync(join(canonicalTmpdir, "job-search-fingerprint-cwd-"));
  t.after(() => rmSync(cwd, { force: true, recursive: true }));
  const fromDifferentCwd = parseSuccess(runFingerprint(relative(cwd, environment.root), {
    cwd,
    env: { LANG: "en_US.UTF-8", LC_ALL: "" },
  }));
  const withDotDot = parseSuccess(runFingerprint(join(environment.root, "output", "..")));

  assert.deepEqual(fromParent, absolute);
  assert.deepEqual(fromDifferentCwd, absolute);
  assert.deepEqual(withDotDot, absolute);
});

test("metadata churn is isolated while unknown dotfiles stay protected", (t) => {
  const environment = createOperationalRoot(t);
  writeFileSync(join(environment.output, "artifact"), "artifact bytes");
  const initial = parseSuccess(runFingerprint(environment.root));

  writeFileSync(join(environment.output, ".DS_Store"), "finder one");
  const metadataAdded = parseSuccess(runFingerprint(environment.root));
  assert.deepEqual(protectedEvidence(metadataAdded), protectedEvidence(initial));
  assert.notEqual(metadataAdded.output.metadata.digest, initial.output.metadata.digest);
  assert.equal(metadataAdded.output.metadata.entryCount, 1);

  writeFileSync(join(environment.output, ".DS_Store"), "finder two");
  const metadataChanged = parseSuccess(runFingerprint(environment.root));
  assert.deepEqual(protectedEvidence(metadataChanged), protectedEvidence(initial));
  assert.notEqual(metadataChanged.output.metadata.digest, metadataAdded.output.metadata.digest);

  unlinkSync(join(environment.output, ".DS_Store"));
  const metadataDeleted = parseSuccess(runFingerprint(environment.root));
  assert.deepEqual(protectedEvidence(metadataDeleted), protectedEvidence(initial));
  assert.equal(metadataDeleted.output.metadata.entryCount, 0);

  for (const name of [".DS_Store.bak", ".ds_store", "._artifact", ".unknown"]) {
    writeFileSync(join(environment.output, name), name);
  }
  const unknownDots = parseSuccess(runFingerprint(environment.root));
  assert.notDeepEqual(protectedEvidence(unknownDots), protectedEvidence(initial));
  assert.equal(unknownDots.output.metadata.entryCount, 0);

  unlinkSync(join(environment.output, ".ds_store"));
  mkdirSync(join(environment.output, ".DS_Store"));
  writeFileSync(join(environment.output, ".DS_Store", "nested"), "protected");
  const metadataDirectory = parseSuccess(runFingerprint(environment.root));
  assert.equal(metadataDirectory.output.metadata.entryCount, 0);
  assert.equal(
    metadataDirectory.output.protected.inventory.entryTypes.directory,
    unknownDots.output.protected.inventory.entryTypes.directory + 1,
  );
});

test("path, type, and byte mutations affect the intended protected evidence", (t) => {
  const environment = createOperationalRoot(t);
  const first = join(environment.output, "first");
  const second = join(environment.output, "second");
  writeFileSync(first, "AAAA");
  writeFileSync(second, "BBBB");
  mkdirSync(join(environment.output, "empty"));
  const initial = parseSuccess(runFingerprint(environment.root));

  writeFileSync(first, "ZZZZ");
  const equalSizeBytes = parseSuccess(runFingerprint(environment.root));
  assert.equal(
    equalSizeBytes.output.protected.inventory.digest,
    initial.output.protected.inventory.digest,
  );
  assert.notEqual(
    equalSizeBytes.output.protected.content.digest,
    initial.output.protected.content.digest,
  );

  writeFileSync(first, "BBBB");
  writeFileSync(second, "AAAA");
  const swapped = parseSuccess(runFingerprint(environment.root));
  assert.equal(swapped.output.protected.inventory.digest, initial.output.protected.inventory.digest);
  assert.notEqual(swapped.output.protected.content.digest, initial.output.protected.content.digest);

  renameSync(first, join(environment.output, "renamed"));
  const renamed = parseSuccess(runFingerprint(environment.root));
  assert.notEqual(renamed.output.protected.inventory.digest, swapped.output.protected.inventory.digest);
  assert.notEqual(renamed.output.protected.content.digest, swapped.output.protected.content.digest);

  rmSync(join(environment.output, "empty"), { recursive: true });
  writeFileSync(join(environment.output, "empty"), "now a file");
  const typeChanged = parseSuccess(runFingerprint(environment.root));
  assert.notEqual(typeChanged.output.protected.inventory.digest, renamed.output.protected.inventory.digest);

  writeFileSync(join(environment.output, "added"), "added");
  const added = parseSuccess(runFingerprint(environment.root));
  assert.notEqual(added.output.protected.inventory.digest, typeChanged.output.protected.inventory.digest);
  unlinkSync(join(environment.output, "added"));
  const deleted = parseSuccess(runFingerprint(environment.root));
  assert.equal(deleted.output.protected.inventory.digest, typeChanged.output.protected.inventory.digest);
});

test("raw hostile path bytes are distinct, byte-sorted, framed, and never printed", (t) => {
  const environment = createOperationalRoot(t);
  const names = [
    "space name",
    "tab\tname",
    "line\nname",
    "back\\slash",
    'quote"name',
    "-leading",
    "trailing ",
    "hash 0123456789abcdef",
    "\u{10000}",
    "\uE000",
  ];
  for (const name of names) writeFileSync(join(environment.output, name), name);
  const result = runFingerprint(environment.root, { env: { LC_ALL: "C" } });
  const record = parseSuccess(result);
  assert.equal(record.output.protected.inventory.entryCount, names.length + 1);
  assert.equal(record.output.protected.content.regularFileCount, names.length);
  assert.equal(
    record.output.protected.inventory.digest,
    "552a3980d4e81b0e32129d2382e8ee79a9c674945e3bcd7e872cf1de8221893c",
  );
  assert.equal(
    record.output.protected.content.digest,
    "eb31e91ffe3de980e079870ce6e4b858f88b6fdc66245d91c08cbe9cfdb4b521",
  );
  for (const name of names) assert.equal(result.stdout.includes(name), false, name);
});

test("Unicode normalization lookalikes have an explicit platform outcome", (t) => {
  const environment = createOperationalRoot(t);
  writeFileSync(join(environment.output, "é"), "precomposed");
  const first = parseSuccess(runFingerprint(environment.root));
  writeFileSync(join(environment.output, "e\u0301"), "decomposed");
  const second = parseSuccess(runFingerprint(environment.root));

  if (process.platform === "darwin") {
    assert.equal(second.output.protected.content.regularFileCount, 1);
    assert.equal(first.output.protected.inventory.digest, second.output.protected.inventory.digest);
    assert.notEqual(first.output.protected.content.digest, second.output.protected.content.digest);
  } else {
    assert.equal(second.output.protected.content.regularFileCount, 2);
    assert.notEqual(first.output.protected.inventory.digest, second.output.protected.inventory.digest);
  }
});

test("invalid filename bytes have an explicit filesystem-dependent outcome", (t) => {
  const environment = createOperationalRoot(t);
  try {
    writeRawChild(environment.output, Buffer.from([0xff]), "invalid-byte-name");
  } catch (error) {
    assert.equal(process.platform, "darwin");
    assert.ok(["EILSEQ", "EPERM"].includes(error.code), error.code);
    return;
  }
  const result = runFingerprint(environment.root);
  const record = parseSuccess(result);
  assert.equal(record.output.protected.inventory.entryCount, 2);
  assert.equal(record.output.protected.content.regularFileCount, 1);
  assert.equal(result.stdout.includes("invalid-byte-name"), false);
});

test("ledger bytes are reported separately from output evidence", (t) => {
  const environment = createOperationalRoot(t);
  writeFileSync(join(environment.output, "artifact"), "unchanged");
  writeFileSync(environment.ledger, "ledger one");
  const initial = parseSuccess(runFingerprint(environment.root));
  writeFileSync(environment.ledger, "ledger two");
  const changed = parseSuccess(runFingerprint(environment.root));

  assert.deepEqual(changed.output, initial.output);
  assert.notEqual(changed.ledger.digest, initial.ledger.digest);
  assert.equal(changed.ledger.totalBytes, initial.ledger.totalBytes);
});

test("invalid topology, aliases, symlinks, special files, and unreadable entries fail closed", async (t) => {
  const expectedCases = [
    "missing-root",
    "root-symlink",
    "missing-output",
    "output-symlink",
    "ledger-symlink",
    "file-symlink",
    "broken-symlink",
    "special-file",
    "metadata-special-file",
    "unreadable-file",
    "unreadable-directory",
  ];
  const executedCases = [];

  await t.test("missing root", () => {
    executedCases.push("missing-root");
    parseFailure(runFingerprint(join(canonicalTmpdir, "definitely-missing-fingerprint-root")), "operational_root_missing");
  });

  await t.test("root symlink alias", (subtest) => {
    executedCases.push("root-symlink");
    const environment = createOperationalRoot(subtest);
    const alias = `${environment.root}-alias`;
    symlinkSync(environment.root, alias);
    subtest.after(() => rmSync(alias, { force: true }));
    parseFailure(runFingerprint(alias), "operational_root_alias");
  });

  await t.test("missing output", (subtest) => {
    executedCases.push("missing-output");
    const environment = createOperationalRoot(subtest);
    rmSync(environment.output, { recursive: true });
    parseFailure(runFingerprint(environment.root), "output_root_missing");
  });

  await t.test("output symlink", (subtest) => {
    executedCases.push("output-symlink");
    const environment = createOperationalRoot(subtest);
    rmSync(environment.output, { recursive: true });
    mkdirSync(join(environment.root, "other-output"));
    symlinkSync("other-output", environment.output);
    parseFailure(runFingerprint(environment.root), "invalid_output_root");
  });

  await t.test("ledger symlink", (subtest) => {
    executedCases.push("ledger-symlink");
    const environment = createOperationalRoot(subtest);
    unlinkSync(environment.ledger);
    writeFileSync(join(environment.root, "other-ledger"), "{}\n");
    symlinkSync("other-ledger", environment.ledger);
    parseFailure(runFingerprint(environment.root), "invalid_process_log");
  });

  await t.test("file symlink", (subtest) => {
    executedCases.push("file-symlink");
    const environment = createOperationalRoot(subtest);
    writeFileSync(join(environment.output, "target"), "bytes");
    symlinkSync("target", join(environment.output, "link"));
    parseFailure(runFingerprint(environment.root), "unsupported_output_entry");
  });

  await t.test("broken symlink", (subtest) => {
    executedCases.push("broken-symlink");
    const environment = createOperationalRoot(subtest);
    symlinkSync("missing", join(environment.output, "link"));
    parseFailure(runFingerprint(environment.root), "unsupported_output_entry");
  });

  for (const [caseId, name] of [
    ["special-file", "pipe"],
    ["metadata-special-file", ".DS_Store"],
  ]) {
    await t.test(caseId, (subtest) => {
      executedCases.push(caseId);
      const environment = createOperationalRoot(subtest);
      const made = spawnSync("mkfifo", [join(environment.output, name)], { encoding: "utf8" });
      assert.equal(made.status, 0, made.stderr);
      parseFailure(runFingerprint(environment.root), "unsupported_output_entry");
    });
  }

  await t.test("unreadable file", (subtest) => {
    executedCases.push("unreadable-file");
    const environment = createOperationalRoot(subtest);
    const path = join(environment.output, "unreadable");
    writeFileSync(path, "bytes");
    chmodSync(path, 0o000);
    parseFailure(runFingerprint(environment.root), "unreadable_output_entry");
  });

  await t.test("unreadable directory", (subtest) => {
    executedCases.push("unreadable-directory");
    const environment = createOperationalRoot(subtest);
    const path = join(environment.output, "unreadable");
    mkdirSync(path);
    chmodSync(path, 0o000);
    parseFailure(runFingerprint(environment.root), "unreadable_output_entry");
  });

  assert.deepEqual(executedCases.sort(), expectedCases.sort());
});

test("CLI grammar fails closed without emitting a success-shaped record", (t) => {
  const environment = createOperationalRoot(t);
  for (const args of [[], ["--root"], ["--unknown", environment.root], ["--root", environment.root, "extra"]]) {
    const result = spawnSync(process.execPath, [fingerprintPath, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    parseFailure(result, "invalid_fingerprint_arguments");
  }
});

test("protected and metadata mutations during measurement are rejected as unstable", async (t) => {
  const protectedEnvironment = createOperationalRoot(t, "job-search-fingerprint-race-protected-");
  const protectedFile = join(protectedEnvironment.output, "large");
  writeFileSync(protectedFile, Buffer.alloc(48 * 1024 * 1024));
  parseFailure(
    await runWhileMutating(protectedEnvironment.root, protectedFile),
    "unstable_operational_tree",
  );

  const metadataEnvironment = createOperationalRoot(t, "job-search-fingerprint-race-metadata-");
  const metadataFile = join(metadataEnvironment.output, ".DS_Store");
  writeFileSync(metadataFile, Buffer.alloc(48 * 1024 * 1024));
  parseFailure(
    await runWhileMutating(metadataEnvironment.root, metadataFile),
    "unstable_operational_tree",
  );
});
