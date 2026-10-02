#!/usr/bin/env node

import { resolve } from "node:path";
import { createProcessSearchServer } from "../../tools/process-search-server.mjs";
import { createDisposableWorkspace } from "./disposable-workspace.mjs";
import { createProcessSearchUiFixture } from "./process-search-ui.mjs";

const disposable = createDisposableWorkspace(null, {
  prefix: "job-search-ui-fixture-",
});
const workspaceRoot = disposable.workspaceRoot;
const fixture = createProcessSearchUiFixture(disposable);
const server = createProcessSearchServer({
  artifactAccessEnabled: true,
  logPath: fixture.logPath,
  outputRoot: fixture.outputRoot,
  staticRoot: resolve("web/process-search"),
  workspaceRoot: fixture.workspaceRoot,
});
const requestedPort = Number.parseInt(
  process.env.JOB_PIPELINE_SEARCH_PORT ?? "0",
  10,
);

function cleanup() {
  disposable.cleanup();
}

function close() {
  server.close(() => {
    cleanup();
    process.exit(0);
  });
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
process.on("exit", cleanup);

server.listen(requestedPort, "127.0.0.1", () => {
  const { port } = server.address();
  console.log(JSON.stringify({
    url: `http://127.0.0.1:${port}`,
    processId: fixture.processId,
    workspaceRoot,
  }));
});
