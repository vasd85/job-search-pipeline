#!/usr/bin/env node

import defaultFileSystem, {
  existsSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { readDisposableWorkspaceEnv } from "./disposable-workspace.mjs";

const fixtureWriteFileSync = writeFileSync;

const declaredChildModes = Object.freeze([
  "cli-barrier",
  "hold-owner",
  "hold-successor",
  "publish-owner",
  "recover-inode",
  "recover-raw",
  "recover-validated-first",
  "recover-validated-second",
  "release-owner",
]);
const declaredSafeInputModes = Object.freeze([
  "safe-blocked-contender",
  "safe-direct-successor",
  "safe-release-owner",
  "safe-supervisor-kill",
  "safe-supervisor-term",
]);
const declaredLockScenarios = Object.freeze([
  "atomic-publication",
  "bounded-timeout",
  "boundary-255",
  "boundary-256",
  "boundary-257",
  "dead-owner",
  "empty-directory",
  "extra-key",
  "hard-link-inode",
  "hard-link-raw",
  "live-owner",
  "malformed-json",
  "missing-acquired-at",
  "missing-lock-version",
  "missing-owner-token",
  "missing-pid",
  "old-release",
  "orphan-candidate",
  "owner-record",
  "partial-json",
  "successor-aba",
  "token-length-31",
  "token-length-33",
  "token-uppercase",
  "two-recoverer",
  "wrong-lock-version",
]);

function fail(message) {
  throw new Error(`process_log_lock_fixture: ${message}`);
}

function markerPath(workspaceRoot, marker) {
  if (!/^[a-z][a-z0-9-]*$/.test(marker)) fail(`invalid marker: ${marker}`);
  return join(workspaceRoot, `.lock-fixture-${marker}`);
}

function publishMarker(workspaceRoot, marker) {
  fixtureWriteFileSync(markerPath(workspaceRoot, marker), `${process.pid}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function waitForMarker(workspaceRoot, marker, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  const path = markerPath(workspaceRoot, marker);
  while (!existsSync(path)) {
    if (Date.now() >= deadline) fail(`timed out waiting for ${marker}`);
    Atomics.wait(waitBuffer, 0, 0, 5);
  }
}

function waitAtBarrier(workspaceRoot, observedMarker, continueMarker) {
  publishMarker(workspaceRoot, observedMarker);
  waitForMarker(workspaceRoot, continueMarker);
}

function errorWithCode(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function installValidatedRecoveryBarrier(lockPath, workspaceRoot, role) {
  const originalRenameSync = defaultFileSystem.renameSync.bind(defaultFileSystem);
  const originalUnlinkSync = defaultFileSystem.unlinkSync.bind(defaultFileSystem);
  let barrierUsed = false;
  let unlinkAttempted = false;
  let blockedPublished = false;
  defaultFileSystem.unlinkSync = (path) => {
    if (path === lockPath) {
      if (!barrierUsed) {
        barrierUsed = true;
        waitAtBarrier(workspaceRoot, `${role}-validated`, `${role}-unlink`);
      }
      unlinkAttempted = true;
    }
    return originalUnlinkSync(path);
  };
  defaultFileSystem.renameSync = (sourcePath, destinationPath) => {
    try {
      return originalRenameSync(sourcePath, destinationPath);
    } catch (error) {
      if (
        role === "second"
        && unlinkAttempted
        && destinationPath === lockPath
        && ["EEXIST", "EISDIR", "ENOTDIR", "ENOTEMPTY"].includes(error.code)
        && !blockedPublished
      ) {
        blockedPublished = true;
        publishMarker(workspaceRoot, "second-blocked-after-unlink");
      }
      throw error;
    }
  };
  syncBuiltinESMExports();
}

function installIdentityBarrier(lockPath, workspaceRoot, identity) {
  const originalLinkSync = defaultFileSystem.linkSync.bind(defaultFileSystem);
  const originalUnlinkSync = defaultFileSystem.unlinkSync.bind(defaultFileSystem);
  let claimCount = 0;
  let frozenBarrierUsed = false;
  let preservedPublished = false;
  let unsafePublished = false;
  const observedMarker = `${identity}-claimed`;
  const continueMarker = `${identity}-continue`;
  if (identity === "inode") {
    const originalKill = process.kill.bind(process);
    let syntheticPidChecks = 0;
    process.kill = (pid, signal) => {
      if (pid !== 2_147_483_647) return originalKill(pid, signal);
      syntheticPidChecks += 1;
      if (syntheticPidChecks === 1) {
        throw errorWithCode("ESRCH", "synthetic first dead-owner observation");
      }
      return true;
    };
  }

  defaultFileSystem.linkSync = (sourcePath, destinationPath) => {
    if (sourcePath !== lockPath) return originalLinkSync(sourcePath, destinationPath);
    claimCount += 1;
    if (claimCount === 1) {
      const result = originalLinkSync(sourcePath, destinationPath);
      waitAtBarrier(workspaceRoot, observedMarker, continueMarker);
      return result;
    }
    if (!preservedPublished) {
      preservedPublished = true;
      publishMarker(workspaceRoot, `${identity}-preserved`);
    }
    throw errorWithCode("EEXIST", "synthetic repeated identity claim");
  };
  defaultFileSystem.unlinkSync = (path) => {
    if (path === lockPath) {
      if (claimCount === 0 && !frozenBarrierUsed) {
        frozenBarrierUsed = true;
        waitAtBarrier(workspaceRoot, observedMarker, continueMarker);
      }
      if (!unsafePublished) {
        unsafePublished = true;
        publishMarker(workspaceRoot, `${identity}-unsafe-unlink`);
      }
    }
    return originalUnlinkSync(path);
  };
  syncBuiltinESMExports();
}

function installReleaseBarrier(lockPath, workspaceRoot) {
  const originalUnlinkSync = defaultFileSystem.unlinkSync.bind(defaultFileSystem);
  let barrierUsed = false;
  defaultFileSystem.unlinkSync = (path) => {
    if (
      !barrierUsed
      && (path === lockPath || (typeof path === "string" && path.startsWith(`${lockPath}/`)))
    ) {
      barrierUsed = true;
      waitAtBarrier(workspaceRoot, "release-observed", "release-continue");
    }
    return originalUnlinkSync(path);
  };
  syncBuiltinESMExports();
}

function installPublicationBarrier(lockPath, workspaceRoot) {
  const originalOpenSync = defaultFileSystem.openSync.bind(defaultFileSystem);
  const originalWriteFileSync = defaultFileSystem.writeFileSync.bind(defaultFileSystem);
  let authoritativeDescriptor = null;
  let barrierUsed = false;
  defaultFileSystem.openSync = (path, flags, ...args) => {
    const descriptor = originalOpenSync(path, flags, ...args);
    if (path === lockPath && flags === "wx") authoritativeDescriptor = descriptor;
    return descriptor;
  };
  defaultFileSystem.writeFileSync = (pathOrDescriptor, data, ...args) => {
    const candidateEntry = typeof pathOrDescriptor === "string"
      && pathOrDescriptor.startsWith(`${lockPath}.candidate-`)
      && pathOrDescriptor.endsWith(".json");
    if (!barrierUsed && (pathOrDescriptor === authoritativeDescriptor || candidateEntry)) {
      barrierUsed = true;
      waitAtBarrier(workspaceRoot, "owner-before-record", "owner-record-continue");
    }
    return originalWriteFileSync(pathOrDescriptor, data, ...args);
  };
  syncBuiltinESMExports();
}

function installSafeReleaseBarrier(lockPath, workspaceRoot) {
  const originalRmdirSync = defaultFileSystem.rmdirSync.bind(defaultFileSystem);
  let barrierUsed = false;
  defaultFileSystem.rmdirSync = (path, ...args) => {
    if (!barrierUsed && path === lockPath) {
      barrierUsed = true;
      waitAtBarrier(workspaceRoot, "safe-owner-empty", "safe-owner-release");
      try {
        return originalRmdirSync(path, ...args);
      } catch (error) {
        if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") {
          publishMarker(workspaceRoot, `safe-owner-release-blocked-${error.code.toLowerCase()}`);
        }
        throw error;
      }
    }
    return originalRmdirSync(path, ...args);
  };
  syncBuiltinESMExports();
}

function installSafeDirectSuccessor(lockPath, ledgerPath, workspaceRoot) {
  const originalReadFileSync = defaultFileSystem.readFileSync.bind(defaultFileSystem);
  const originalRenameSync = defaultFileSystem.renameSync.bind(defaultFileSystem);
  let enteredCriticalSection = false;
  let replacedOldDirectory = false;
  defaultFileSystem.renameSync = (sourcePath, destinationPath, ...args) => {
    const result = originalRenameSync(sourcePath, destinationPath, ...args);
    if (
      !replacedOldDirectory
      && destinationPath === lockPath
      && typeof sourcePath === "string"
      && sourcePath.startsWith(`${lockPath}.candidate-`)
    ) {
      replacedOldDirectory = true;
      publishMarker(workspaceRoot, "safe-successor-replaced");
    }
    return result;
  };
  defaultFileSystem.readFileSync = (path, ...args) => {
    if (!enteredCriticalSection && replacedOldDirectory && path === ledgerPath) {
      enteredCriticalSection = true;
      waitAtBarrier(workspaceRoot, "safe-successor-entered", "safe-successor-release");
    }
    return originalReadFileSync(path, ...args);
  };
  syncBuiltinESMExports();
}

function installSafeBlockedContender(lockPath, ledgerPath, workspaceRoot, contenderId) {
  if (!/^\d{2}$/.test(contenderId)) fail(`invalid safe contender id: ${contenderId}`);
  const originalReadFileSync = defaultFileSystem.readFileSync.bind(defaultFileSystem);
  const originalRenameSync = defaultFileSystem.renameSync.bind(defaultFileSystem);
  let blockedPublished = false;
  let enteredPublished = false;
  defaultFileSystem.renameSync = (sourcePath, destinationPath, ...args) => {
    try {
      return originalRenameSync(sourcePath, destinationPath, ...args);
    } catch (error) {
      if (
        !blockedPublished
        && destinationPath === lockPath
        && typeof sourcePath === "string"
        && sourcePath.startsWith(`${lockPath}.candidate-`)
        && ["EEXIST", "EISDIR", "ENOTDIR", "ENOTEMPTY"].includes(error.code)
      ) {
        blockedPublished = true;
        publishMarker(workspaceRoot, `safe-contender-${contenderId}-blocked`);
      }
      throw error;
    }
  };
  defaultFileSystem.readFileSync = (path, ...args) => {
    if (!enteredPublished && path === ledgerPath) {
      enteredPublished = true;
      publishMarker(workspaceRoot, `safe-contender-${contenderId}-entered`);
    }
    return originalReadFileSync(path, ...args);
  };
  syncBuiltinESMExports();
}

async function runSafeSupervisorFaultMode(workspaceRoot, scenario) {
  if (scenario === "safe-supervisor-kill") {
    process.on("SIGTERM", () => {});
  }
  publishMarker(workspaceRoot, `${scenario}-ready`);
  await new Promise(() => {
    setInterval(() => {}, 1_000);
  });
}

async function main() {
  const [scenario, ...scenarioArgs] = process.argv.slice(2);
  if (scenario === "--inventory") {
    process.stdout.write(`${JSON.stringify({
      child_modes: declaredChildModes,
      lock_scenarios: declaredLockScenarios,
      safe_input_modes: declaredSafeInputModes,
    })}\n`);
    return;
  }
  if (![...declaredChildModes, ...declaredSafeInputModes].includes(scenario)) {
    fail(`unknown scenario: ${scenario}`);
  }

  const environment = readDisposableWorkspaceEnv();
  if (scenario === "safe-supervisor-term" || scenario === "safe-supervisor-kill") {
    if (scenarioArgs.length !== 0) fail(`${scenario} does not accept arguments`);
    await runSafeSupervisorFaultMode(environment.workspaceRoot, scenario);
    return;
  }
  if (scenario === "cli-barrier") {
    const [readyMarker, releaseMarker, ...cliArgs] = scenarioArgs;
    if (!readyMarker || !releaseMarker || cliArgs.length === 0) {
      fail("cli-barrier requires ready/release markers and CLI arguments");
    }
    publishMarker(environment.workspaceRoot, readyMarker);
    waitForMarker(environment.workspaceRoot, releaseMarker);
    process.argv = [process.execPath, "tools/process-log.mjs", ...cliArgs];
    await import("../../tools/process-log.mjs");
    return;
  }
  const lockPath = `${environment.ledgerPath}.lock`;
  if (
    scenario === "safe-release-owner"
    || scenario === "safe-direct-successor"
    || scenario === "safe-blocked-contender"
  ) {
    const cliArgs = scenario === "safe-blocked-contender" ? scenarioArgs.slice(1) : scenarioArgs;
    if (cliArgs.length === 0) fail(`${scenario} requires CLI arguments`);
    if (scenario === "safe-release-owner") {
      installSafeReleaseBarrier(lockPath, environment.workspaceRoot);
    } else if (scenario === "safe-direct-successor") {
      installSafeDirectSuccessor(
        lockPath,
        environment.ledgerPath,
        environment.workspaceRoot,
      );
    } else {
      installSafeBlockedContender(
        lockPath,
        environment.ledgerPath,
        environment.workspaceRoot,
        scenarioArgs[0],
      );
    }
    process.argv = [process.execPath, "tools/process-log.mjs", ...cliArgs];
    await import("../../tools/process-log.mjs");
    return;
  }
  if (scenario === "recover-validated-first" || scenario === "recover-validated-second") {
    installValidatedRecoveryBarrier(
      lockPath,
      environment.workspaceRoot,
      scenario === "recover-validated-first" ? "first" : "second",
    );
  } else if (scenario === "recover-inode" || scenario === "recover-raw") {
    installIdentityBarrier(
      lockPath,
      environment.workspaceRoot,
      scenario === "recover-inode" ? "inode" : "raw",
    );
  } else if (scenario === "release-owner") {
    installReleaseBarrier(lockPath, environment.workspaceRoot);
  } else if (scenario === "publish-owner") {
    installPublicationBarrier(lockPath, environment.workspaceRoot);
  }
  const { withLogV3Lock } = await import("../../tools/lib/process-log-core.mjs");
  const scenarioContract = {
    "hold-owner": ["owner-acquired", "owner-write", "2026-08-04T10:00:00.000Z"],
    "hold-successor": ["successor-acquired", "successor-write", "2026-08-04T10:00:02.000Z"],
    "publish-owner": ["publisher-entered", "publisher-write", "2026-08-04T10:00:03.000Z"],
    "recover-validated-first": ["first-acquired", "first-write", "2026-08-04T10:00:01.000Z"],
    "recover-validated-second": ["second-acquired", "second-write", "2026-08-04T10:00:07.000Z"],
    "recover-inode": ["inode-entered", "inode-write", "2026-08-04T10:00:04.000Z"],
    "recover-raw": ["raw-entered", "raw-write", "2026-08-04T10:00:05.000Z"],
    "release-owner": ["release-entered", null, "2026-08-04T10:00:06.000Z"],
  };
  const [acquiredMarker, writeMarker, updatedAt] = scenarioContract[scenario];

  withLogV3Lock(environment.ledgerPath, ({ log, write }) => {
    publishMarker(environment.workspaceRoot, acquiredMarker);
    if (writeMarker !== null) waitForMarker(environment.workspaceRoot, writeMarker);
    log.updated_at = updatedAt;
    write(log);
  }, {
    timeoutMs: scenario === "recover-inode" || scenario === "recover-raw" ? 800 : 8_000,
    staleAfterMs: 100,
  });
  if (scenario === "hold-owner") {
    publishMarker(environment.workspaceRoot, "owner-completed");
  }
  process.stdout.write(`${JSON.stringify({ pid: process.pid, scenario, status: "completed" })}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    code: error.code ?? "process_log_lock_fixture_failed",
    message: error.message,
  })}\n`);
  process.exitCode = 1;
}
