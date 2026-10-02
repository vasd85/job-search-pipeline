#!/usr/bin/env node

import { createRequire } from "node:module";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultBuilderRoot = dirname(fileURLToPath(import.meta.url));

export class CvBuilderDependencyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CvBuilderDependencyError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CvBuilderDependencyError(code, message);
}

function readJson(path, missingCode, label) {
  let bytes;
  try {
    bytes = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") fail(missingCode, `${label} is missing`);
    fail("toolchain_metadata_invalid", `${label} is not readable`);
  }
  try {
    return JSON.parse(bytes);
  } catch {
    fail("toolchain_metadata_invalid", `${label} is not valid JSON`);
  }
}

function packagePath(builderRoot, lockKey) {
  if (
    typeof lockKey !== "string"
    || !lockKey.startsWith("node_modules/")
    || isAbsolute(lockKey)
    || lockKey.includes("\\")
    || normalize(lockKey) !== lockKey
    || lockKey.split("/").includes("..")
  ) {
    fail("toolchain_lockfile_mismatch", "cv-builder lockfile contains an unsafe package path");
  }
  const path = resolve(builderRoot, lockKey);
  if (path !== join(builderRoot, lockKey) || !path.startsWith(`${builderRoot}${sep}`)) {
    fail("toolchain_lockfile_mismatch", "cv-builder lockfile package path escapes its owner");
  }
  return path;
}

function assertRegularPath(path, lockKey, kind) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("toolchain_dependencies_missing", `locked dependency is missing: ${lockKey}`);
    }
    fail("toolchain_dependency_invalid", `locked dependency is not inspectable: ${lockKey}`);
  }
  const valid = kind === "directory" ? stats.isDirectory() : stats.isFile();
  if (!valid || stats.isSymbolicLink()) {
    fail("toolchain_dependency_invalid", `locked dependency has an invalid ${kind}: ${lockKey}`);
  }
}

function assertRegularPackageAncestors(builderRoot, lockKey) {
  let ancestor = builderRoot;
  for (const segment of lockKey.split("/").slice(0, -1)) {
    ancestor = join(ancestor, segment);
    assertRegularPath(ancestor, lockKey, "directory");
  }
}

function packageNameForLockKey(lockKey) {
  const segments = lockKey.split("/");
  const packageStart = segments.lastIndexOf("node_modules") + 1;
  const first = segments[packageStart];
  if (!first) {
    fail("toolchain_lockfile_mismatch", `cv-builder lockfile has an invalid package identity: ${lockKey}`);
  }
  if (!first.startsWith("@")) return first;
  const second = segments[packageStart + 1];
  if (!second) {
    fail("toolchain_lockfile_mismatch", `cv-builder lockfile has an invalid package identity: ${lockKey}`);
  }
  return `${first}/${second}`;
}

export function checkCvBuilderDependencies(builderRoot = defaultBuilderRoot) {
  const exactRoot = resolve(builderRoot);
  const packageJson = readJson(
    join(exactRoot, "package.json"),
    "toolchain_metadata_invalid",
    "cv-builder package manifest",
  );
  const lock = readJson(
    join(exactRoot, "package-lock.json"),
    "toolchain_lockfile_missing",
    "cv-builder lockfile",
  );
  const rootLock = lock?.packages?.[""];
  if (lock?.lockfileVersion !== 3 || !rootLock || typeof rootLock !== "object") {
    fail("toolchain_lockfile_mismatch", "cv-builder lockfile must use lockfileVersion 3");
  }
  if (
    JSON.stringify(rootLock.dependencies ?? {})
    !== JSON.stringify(packageJson.dependencies ?? {})
  ) {
    fail("toolchain_lockfile_mismatch", "cv-builder manifest and lockfile dependencies differ");
  }
  if (
    JSON.stringify(rootLock.engines ?? {})
    !== JSON.stringify(packageJson.engines ?? {})
  ) {
    fail("toolchain_lockfile_mismatch", "cv-builder manifest and lockfile engines differ");
  }

  const lockedPackages = Object.entries(lock.packages)
    .filter(([lockKey]) => lockKey !== "")
    .sort(([left], [right]) => left.localeCompare(right));
  if (lockedPackages.length === 0) {
    fail("toolchain_lockfile_mismatch", "cv-builder lockfile has no dependency graph");
  }

  for (const [lockKey, locked] of lockedPackages) {
    if (locked?.link === true || typeof locked?.version !== "string") {
      fail("toolchain_lockfile_mismatch", `cv-builder lockfile has an unsupported package entry: ${lockKey}`);
    }
    const dependencyPath = packagePath(exactRoot, lockKey);
    assertRegularPackageAncestors(exactRoot, lockKey);
    assertRegularPath(dependencyPath, lockKey, "directory");
    const manifestPath = join(dependencyPath, "package.json");
    assertRegularPath(manifestPath, lockKey, "file");
    const installed = readJson(
      manifestPath,
      "toolchain_dependencies_missing",
      `installed dependency ${lockKey}`,
    );
    if (installed.version !== locked.version) {
      fail(
        "toolchain_dependency_version_mismatch",
        `locked dependency version mismatch: ${lockKey}`,
      );
    }
    if (installed.name !== packageNameForLockKey(lockKey)) {
      fail(
        "toolchain_dependency_identity_mismatch",
        `locked dependency identity mismatch: ${lockKey}`,
      );
    }
  }

  const requireFromBuilder = createRequire(join(exactRoot, "render.js"));
  let entryPath;
  try {
    entryPath = requireFromBuilder.resolve("docx");
    requireFromBuilder("docx");
  } catch {
    fail("toolchain_dependency_invalid", "locked dependency is not locally loadable: node_modules/docx");
  }
  const localDocxRoot = realpathSync(join(exactRoot, "node_modules", "docx"));
  let exactEntry;
  try {
    exactEntry = realpathSync(entryPath);
  } catch {
    fail("toolchain_dependency_invalid", "locked dependency entrypoint is not readable: node_modules/docx");
  }
  if (!exactEntry.startsWith(`${localDocxRoot}${sep}`)) {
    fail("toolchain_dependency_invalid", "docx must resolve from the local locked dependency graph");
  }
  assertRegularPath(exactEntry, "node_modules/docx entrypoint", "file");

  return {
    direct: Object.keys(packageJson.dependencies ?? {}).length,
    packages: lockedPackages.length,
  };
}

function main() {
  try {
    const result = checkCvBuilderDependencies();
    process.stdout.write(`${JSON.stringify({ status: "ready", ...result })}\n`);
  } catch (error) {
    const known = error instanceof CvBuilderDependencyError;
    process.stderr.write(`${JSON.stringify({
      status: "error",
      error: {
        code: known ? error.code : "toolchain_dependency_check_failed",
        message: known ? error.message : "dependency check failed unexpectedly",
      },
    })}\n`);
    process.exitCode = 1;
  }
}

function isDirectInvocation() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  }
}

if (isDirectInvocation()) main();
