#!/usr/bin/env node

import { readDisposableWorkspaceEnv } from "./disposable-workspace.mjs";

try {
  readDisposableWorkspaceEnv();
  await import("../../tools/process-log.mjs");
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    code: error.code ?? "disposable_cli_child_failed",
    message: error.message,
  })}\n`);
  process.exitCode = 1;
}
