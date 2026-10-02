#!/usr/bin/env node
// CLI of the Telegram collector. Explicit runs only; see README.md beside this file.
//
// A sweep over a config with general sources is two commands: `sweep` walks and writes the reader's
// batches, `finalize` takes the answers and finishes; a thematic-only config finishes in `sweep`.
// `finalize` takes no `--config`: the path is in the stage file, recorded by `sweep`.
//
// Stdout is one JSON object of bounded codes and counts - it is read by a model, so it carries no
// post title and no link. The only values argv may carry are the operator-typed tokens of `probe`
// (a handle and, for a group, a message id) and `reset-cursor`, all pattern-gated before any use;
// the sweep reads its handles from the working config file. Post text and post links never reach
// argv or a shell.

import { copyFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OpsTreeError, verifyFolder } from "../ops-tree/manifest.mjs";
import { isValidHandle } from "./config.mjs";
import { TelegramCollectError, fail } from "./errors.mjs";
import {
  executeFinalize,
  executeSweep,
  exitCodeOf,
  renderLabelBatches,
  summarize,
} from "./persist.mjs";
import { probeChannel, probeMessage } from "./probe.mjs";
import { initState, resetCursor, stateBasename } from "./state.mjs";

export const workingConfigBasename = "telegram-sources.json";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workspaceRoot = resolve(process.env.JOB_PIPELINE_WORKSPACE_ROOT ?? repoRoot);
const templatePath = resolve(repoRoot, "config", "telegram-sources.json");
const statePath = resolve(workspaceRoot, stateBasename);
const defaultConfigPath = resolve(workspaceRoot, workingConfigBasename);

function usage() {
  console.log(`Usage:
  node tools/telegram-collect/cli.mjs init
  node tools/telegram-collect/cli.mjs sweep --out-dir <absolute path> [--config <absolute path>]
  node tools/telegram-collect/cli.mjs finalize --out-dir <absolute path> [--accept-invalid]
  node tools/telegram-collect/cli.mjs render-batches --out-dir <absolute path> --full-text
  node tools/telegram-collect/cli.mjs probe <handle> [<message id>]
  node tools/telegram-collect/cli.mjs reset-cursor <handle>

Working files of one checkout, untracked, beside the triage ledger:
  ${workingConfigBasename}     channels and groups, thematic or not, word lists, exclusions - edit by hand; init copies the template
  ${stateBasename}  cursors and positions, post fingerprints, emitted addresses - created by init only

Test isolation environment:
  JOB_PIPELINE_WORKSPACE_ROOT`);
}

const MESSAGE_ID = /^[1-9]\d{0,11}$/u;

function parseArgs(rest, { positional, valued = ["out-dir", "config"], flags = [] }) {
  const values = [];
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      if (Object.hasOwn(options, key))
        fail("argv_invalid", "Unknown, repeated or valueless option.");
      if (flags.includes(key)) {
        options[key] = true;
        continue;
      }
      const value = rest[index + 1];
      if (!valued.includes(key) || value === undefined || value.startsWith("--")) {
        fail("argv_invalid", "Unknown, repeated or valueless option.");
      }
      options[key] = value;
      index += 1;
    } else {
      values.push(token);
    }
  }
  const allowed = Array.isArray(positional) ? positional : [positional];
  if (!allowed.includes(values.length)) fail("argv_invalid", "Wrong number of arguments.");
  return { values, options };
}

function configPathOf(options) {
  if (options.config === undefined) return defaultConfigPath;
  if (!isAbsolute(options.config)) fail("argv_invalid", "--config must be an absolute path.");
  return options.config;
}

function handleOf(value) {
  if (!isValidHandle(value))
    fail("handle_invalid", "The handle does not match the handle pattern.");
  return value;
}

// The two commands that write a sweep run the operational folder's drift check first. It reads the
// manifest of the tree this file lies in, never of JOB_PIPELINE_WORKSPACE_ROOT.
function verifyOperationalFolder() {
  try {
    verifyFolder(repoRoot);
  } catch (error) {
    if (error instanceof OpsTreeError) throw new TelegramCollectError(error.code, error.message);
    throw error;
  }
}

/** Print the bounded summary; exit 2 when a source did not complete. */
function report(summary) {
  console.log(JSON.stringify(summary));
  return exitCodeOf(summary);
}

function realSleep(ms) {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "help") {
    usage();
    return 0;
  }
  if (command === "init") {
    parseArgs(rest, { positional: 0 });
    const report = { command, config: "kept", state: "kept" };
    if (!existsSync(defaultConfigPath)) {
      copyFileSync(templatePath, defaultConfigPath);
      report.config = "created";
    }
    if (!existsSync(statePath)) {
      initState(statePath);
      report.state = "created";
    }
    console.log(JSON.stringify(report));
    return 0;
  }
  if (command === "sweep") {
    verifyOperationalFolder();
    const { options } = parseArgs(rest, { positional: 0 });
    if (options["out-dir"] === undefined) fail("argv_invalid", "sweep requires --out-dir.");
    const run = await executeSweep({
      configPath: configPathOf(options),
      statePath,
      outDir: options["out-dir"],
      repoRoot,
      now: () => Date.now(),
      sleep: realSleep,
      fetchImpl: globalThis.fetch,
    });
    return report(summarize(run));
  }
  if (command === "finalize") {
    verifyOperationalFolder();
    const { options } = parseArgs(rest, {
      positional: 0,
      valued: ["out-dir"],
      flags: ["accept-invalid"],
    });
    if (options["out-dir"] === undefined) fail("argv_invalid", "finalize requires --out-dir.");
    const run = executeFinalize({
      outDir: options["out-dir"],
      statePath,
      repoRoot,
      acceptInvalid: options["accept-invalid"] === true,
    });
    return report(summarize(run, "finalize"));
  }
  if (command === "render-batches") {
    const { options } = parseArgs(rest, {
      positional: 0,
      valued: ["out-dir"],
      flags: ["full-text"],
    });
    if (options["out-dir"] === undefined || options["full-text"] !== true) {
      fail("argv_invalid", "render-batches requires --out-dir and --full-text.");
    }
    const { labelDir, batches } = renderLabelBatches({ outDir: options["out-dir"], repoRoot });
    console.log(JSON.stringify({ command, label_dir: labelDir, batches }));
    return 0;
  }
  if (command === "probe") {
    const { values, options } = parseArgs(rest, { positional: [1, 2] });
    if (Object.keys(options).length > 0)
      fail("argv_invalid", "probe takes a handle, an optional message id and no option.");
    const handle = handleOf(values[0]);
    if (values.length === 2) {
      if (!MESSAGE_ID.test(values[1]))
        fail("argv_invalid", "The message id must be a positive integer.");
      const card = await probeMessage({
        handle,
        messageId: Number(values[1]),
        fetchImpl: globalThis.fetch,
      });
      console.log(JSON.stringify({ command, ...card }));
      return 0;
    }
    const card = await probeChannel({ handle, fetchImpl: globalThis.fetch });
    console.log(JSON.stringify({ command, ...card }));
    return 0;
  }
  if (command === "reset-cursor") {
    const { values } = parseArgs(rest, { positional: 1 });
    const handle = handleOf(values[0]);
    console.log(JSON.stringify({ command, handle, existed: resetCursor(statePath, handle) }));
    return 0;
  }
  fail("argv_invalid", "Unknown command.");
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    if (error instanceof TelegramCollectError) {
      console.log(JSON.stringify({ status: "refused", code: error.code, message: error.message }));
    } else {
      console.log(JSON.stringify({ status: "failed", code: "internal_error" }));
    }
    process.exitCode = 1;
  },
);
