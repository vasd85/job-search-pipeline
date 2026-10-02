#!/usr/bin/env node

/**
 * Operator surface of the batch-triage ledger.
 *
 * Read-only by design, plus the one creation command. The batch-start plan and the batch-end write
 * are in-process module calls from `score-jobs` (`tools/lib/triage-ledger-core.mjs`), so no vacancy
 * URL, title, company or flag ever appears in a shell command line — ADR 0011's boundary held by
 * construction rather than by escaping. Consequently this CLI accepts machine tokens only:
 * `--as-of` and `--compact`. If a mutating command ever becomes necessary here, it takes its
 * payload through the shared `--input-file input-<32-hex>.json` transport and nothing else.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TriageLedgerError,
  initLedger,
  readLedger,
  reviewLedger,
} from "./lib/triage-ledger-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(process.env.JOB_PIPELINE_WORKSPACE_ROOT ?? repoRoot);
const ledgerPath = resolve(
  process.env.JOB_PIPELINE_TRIAGE_LEDGER ?? resolve(workspaceRoot, "triage-ledger.json"),
);

const booleanFlags = new Set(["compact"]);
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

class TriageLedgerCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TriageLedgerCliError";
    this.code = code;
  }
}

function usage() {
  console.log(`Usage:
  node tools/triage-ledger.mjs init
  node tools/triage-ledger.mjs show [--compact]
  node tools/triage-ledger.mjs review [--as-of <YYYY-MM-DD | ISO instant>] [--compact]
  node tools/triage-ledger.mjs validate

The ledger is operational state of one checkout, like process-log.json: untracked, created
explicitly, never created by a read. Batch writes and the batch-start plan are in-process module
calls (tools/lib/triage-ledger-core.mjs) so that no vacancy value reaches argv; this CLI therefore
takes no vacancy values at all. The review procedure lives in docs/runbooks/triage-review.md.

Test isolation environment:
  JOB_PIPELINE_TRIAGE_LEDGER, JOB_PIPELINE_WORKSPACE_ROOT`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length;) {
    const flag = rest[index];
    if (!flag?.startsWith("--")) {
      throw new TriageLedgerCliError(
        "invalid_cli_arguments",
        `Invalid argument near ${flag ?? "<end>"}`,
      );
    }
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) {
      throw new TriageLedgerCliError("invalid_cli_arguments", `Duplicate option: --${key}`);
    }
    if (booleanFlags.has(key)) {
      options[key] = true;
      index += 1;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new TriageLedgerCliError("invalid_cli_arguments", `Missing value for --${key}`);
    }
    options[key] = value;
    index += 2;
  }
  return { command, options };
}

function assertAllowed(options, allowed) {
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new TriageLedgerCliError(
      "invalid_cli_arguments",
      `Unknown option(s): ${unknown.map((key) => `--${key}`).join(", ")}`,
    );
  }
}

/** `--as-of` is a machine token, not external content: a calendar day or a UTC instant. */
function resolveAsOf(options) {
  const raw = options["as-of"];
  if (raw === undefined) return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const value = String(raw).trim();
  if (dayPattern.test(value)) return `${value}T00:00:00Z`;
  return value;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function init(options) {
  assertAllowed(options, []);
  print({ command: "init", ...initLedger(ledgerPath) });
}

function show(options) {
  assertAllowed(options, ["compact"]);
  const ledger = readLedger(ledgerPath);
  const byStatus = {};
  for (const entry of ledger.entries) {
    byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
  }
  const summary = {
    command: "show",
    path: ledgerPath,
    schema_version: ledger.schema_version,
    batches: ledger.batches.length,
    entries: ledger.entries.length,
    by_status: byStatus,
    last_batch: ledger.batches.at(-1) ?? null,
  };
  print(options.compact ? summary : { ...summary, ledger });
}

function review(options) {
  assertAllowed(options, ["as-of", "compact"]);
  const report = reviewLedger(readLedger(ledgerPath), { asOf: resolveAsOf(options) });
  if (!options.compact) {
    print({ command: "review", path: ledgerPath, ...report });
    return;
  }
  print({
    command: "review",
    path: ledgerPath,
    as_of: report.as_of,
    totals: report.totals,
    groups: report.groups.map((group) => ({
      flag: group.flag,
      count: group.count,
      fast_lane: group.fast_lane,
      keys: group.entries.map((entry) => entry.key),
    })),
  });
}

function validate(options) {
  assertAllowed(options, []);
  const ledger = readLedger(ledgerPath);
  print({
    command: "validate",
    path: ledgerPath,
    status: "valid",
    schema_version: ledger.schema_version,
    batches: ledger.batches.length,
    entries: ledger.entries.length,
  });
}

const commands = Object.freeze({ init, show, review, validate });

try {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "help" || command === "--help") {
    usage();
  } else if (!command || !Object.hasOwn(commands, command)) {
    throw new TriageLedgerCliError("unknown_command", `Unknown command: ${command ?? "<none>"}`);
  } else {
    commands[command](options);
  }
} catch (error) {
  const code = error instanceof TriageLedgerCliError || error instanceof TriageLedgerError
    ? error.code
    : "triage_ledger_cli_failed";
  console.error(JSON.stringify({ error: { code, message: error?.message ?? "unknown error" } }));
  process.exitCode = 1;
}
