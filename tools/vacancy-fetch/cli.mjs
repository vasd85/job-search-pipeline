#!/usr/bin/env node
// Source-agnostic vacancy fetch layer — the shell-facing entry point.
//
// What crosses the command line is only repository-owned tokens: the subcommand, an absolute
// output directory, bounded numeric settings, a bounded batch label and the controlled
// basename of an ADR 0011 envelope. The vacancy URLs live in that envelope. Nothing this CLI
// prints carries a URL, a page body or a header value, because its own stdout is read by a model
// and a diagnostic that quotes an untrusted page is an instruction-injection channel.
//
// The layer is the default triage transport: `--batch <label>` names the run and every manifest
// records that it is the default. The label is required because one bounded token names the
// manifest's batch, the ledger `batch_id` and the output directory alike.

import { resolve } from "node:path";

import { SafeCliInputError, readSafeCliInput } from "../lib/safe-cli-input.mjs";
import {
  VacancyFetchError,
  browserCompletenessCheckOwed,
  rateLimitPolicies,
  runVacancyFetchBatch,
} from "./batch.mjs";
import { vacancyFetchCommand, vacancyFetchInputSchemas } from "./input-schema.mjs";
import { manifestBasename } from "./persist.mjs";
import { transportDefaults } from "./transport.mjs";

// Resolved per invocation rather than at module load, so a caller that sets the isolation
// environment after importing this module is honoured instead of silently reading the real root.
function resolveInputRoot() {
  const workspaceRoot = resolve(
    process.env.JOB_PIPELINE_WORKSPACE_ROOT ?? resolve(import.meta.dirname, "../.."),
  );
  return process.env.JOB_PIPELINE_INPUT_ROOT ?? resolve(workspaceRoot, ".pipeline-input");
}

const NUMERIC_OPTIONS = Object.freeze({
  "delay-ms": { key: "delayMs", min: 0, max: 600_000, fallback: 2000 },
  "timeout-ms": {
    key: "timeoutMs",
    min: 1000,
    max: 120_000,
    fallback: transportDefaults.timeoutMs,
  },
  "max-bytes": {
    key: "maxBytes",
    min: 1024,
    max: 64 * 1024 * 1024,
    fallback: transportDefaults.maxBytes,
  },
  "max-redirects": {
    key: "maxRedirects",
    min: 0,
    max: 10,
    fallback: transportDefaults.maxRedirects,
  },
});

const ALLOWED_OPTIONS = Object.freeze([
  "input-file",
  "out-dir",
  "batch",
  "on-rate-limit",
  ...Object.keys(NUMERIC_OPTIONS),
]);

function usage() {
  process.stdout.write(`vacancy-fetch — disk-to-disk vacancy capture for the triage lane

Usage:
  node tools/vacancy-fetch/cli.mjs fetch \\
    --input-file input-<32 lowercase hex>.json \\
    --out-dir <absolute working directory> \\
    --batch <label> [--delay-ms 2000] [--timeout-ms 20000] \\
    [--max-bytes 5242880] [--max-redirects 5] [--on-rate-limit stop|continue]

The envelope holds the ordered vacancy URLs (\`values.urls\`) and an optional \`values.userAgent\`.
Produce it with the safe input-file producer procedure in instructions/pipeline-artifacts.md; the
URLs never appear on the command line.

Writes one \`NNN.capture.txt\` per record whose body was persisted - which includes a degraded
record routed to the browser - and one ${manifestBasename} into the output directory.

Exit 2 when at least one record needs the in-app browser fallback, was left unattempted, or is
usable and carries \`deferred_content_suspected\` and therefore owes the browser one completeness
check; 1 on a caller error; 0 when none of those happened - which is not a promise that every
record is usable, since a terminal \`absent\` record moves none of these counters and owes its own
browser load to the scoring procedure rather than to this exit code.

Test isolation environment: JOB_PIPELINE_WORKSPACE_ROOT, JOB_PIPELINE_INPUT_ROOT
`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length;) {
    const flag = rest[index];
    if (!flag?.startsWith("--")) {
      throw new VacancyFetchError(
        "invalid_cli_arguments",
        `Invalid argument near ${flag ?? "<end>"}`,
      );
    }
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) {
      throw new VacancyFetchError("invalid_cli_arguments", `Duplicate option: --${key}`);
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new VacancyFetchError("invalid_cli_arguments", `Missing value for --${key}`);
    }
    options[key] = value;
    index += 2;
  }
  return { command, options };
}

function numeric(options, name) {
  const spec = NUMERIC_OPTIONS[name];
  if (!Object.hasOwn(options, name)) return spec.fallback;
  const value = Number(options[name]);
  if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
    throw new VacancyFetchError(
      "invalid_cli_arguments",
      `--${name} must be an integer between ${spec.min} and ${spec.max}`,
    );
  }
  return value;
}

/*
 * `transport` carries the same three seams `runVacancyFetchBatch` accepts, so the argument
 * parsing, the envelope read, the exit-code mapping and the printed summary are all exercised
 * offline. The shell entry point below passes nothing, so production always uses the defaults.
 */
export async function main(argv, transport = {}) {
  const { command, options } = parseArgs(argv);
  if (command === "help" || command === "--help" || command === undefined) {
    usage();
    return 0;
  }
  if (command !== vacancyFetchCommand) {
    throw new VacancyFetchError("unknown_command", `Unknown command: ${command}`);
  }
  const unknown = Object.keys(options).filter((key) => !ALLOWED_OPTIONS.includes(key));
  if (unknown.length > 0) {
    throw new VacancyFetchError(
      "invalid_cli_arguments",
      `Unknown option(s): ${unknown.map((key) => `--${key}`).join(", ")}`,
    );
  }
  for (const required of ["input-file", "out-dir", "batch"]) {
    if (!Object.hasOwn(options, required)) {
      throw new VacancyFetchError("invalid_cli_arguments", `Missing --${required}`);
    }
  }
  const policy = options["on-rate-limit"] ?? "stop";
  if (!rateLimitPolicies.includes(policy)) {
    throw new VacancyFetchError(
      "invalid_cli_arguments",
      `--on-rate-limit must be one of ${rateLimitPolicies.join(", ")}`,
    );
  }
  // Every caller-supplied setting is resolved before the envelope is opened: a malformed
  // invocation must fail without touching the input root or the output directory.
  const settings = {
    delayMs: numeric(options, "delay-ms"),
    timeoutMs: numeric(options, "timeout-ms"),
    maxBytes: numeric(options, "max-bytes"),
    maxRedirects: numeric(options, "max-redirects"),
  };

  const envelope = readSafeCliInput({
    basename: options["input-file"],
    command: vacancyFetchCommand,
    inputRoot: resolveInputRoot(),
    schemas: vacancyFetchInputSchemas,
  });

  const manifest = await runVacancyFetchBatch({
    urls: envelope.values.urls,
    outDir: resolve(options["out-dir"]),
    batch: options.batch,
    ...settings,
    userAgent: envelope.values.userAgent ?? null,
    onRateLimit: policy,
    ...transport,
  });

  // Counts and bounded codes only. No URL, no title, no page text.
  const { summary } = manifest;
  process.stdout.write(
    `${JSON.stringify(
      {
        batch: manifest.batch.label,
        isDefaultTransport: manifest.batch.isDefaultTransport,
        manifest: manifestBasename,
        stoppedEarly: manifest.stoppedEarly,
        summary,
        fallback: manifest.records
          .filter((record) => record.fallback !== null)
          .map((record) => ({
            index: record.index,
            outcome: record.outcome,
            accessBarrier: record.accessBarrier,
            reasons: record.reasons,
          })),
        // A second list rather than a longer first one: a record the layer could not serve and a
        // record it served without being able to vouch for its completeness are different
        // instructions to the caller. No `accessBarrier` here - a usable record never carries one,
        // and a field that is always null is decoration, not information.
        completenessCheck: manifest.records.filter(browserCompletenessCheckOwed).map((record) => ({
          index: record.index,
          outcome: record.outcome,
          reasons: record.reasons,
        })),
      },
      null,
      2,
    )}\n`,
  );

  // The expression stays here, inline in the return, because that is the line the contract suite
  // anchors the documented sentence to; hiding it in a helper would leave this return unguarded.
  return summary.needsBrowserFallback > 0 ||
    summary.skipped > 0 ||
    summary.needsBrowserCompletenessCheck > 0
    ? 2
    : 0;
}

// `import.meta.main` is false when a test imports this module, so the tests drive `main` without
// the process-level exit handling below.
if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    const code =
      error instanceof VacancyFetchError || error instanceof SafeCliInputError
        ? error.code
        : "unexpected_error";
    // Stable, bounded diagnostics: the code and the repository-owned message, never a stack, an
    // absolute path, a URL or a page body.
    process.stderr.write(
      `${JSON.stringify({
        error: code,
        message:
          error instanceof VacancyFetchError || error instanceof SafeCliInputError
            ? error.message
            : "Unexpected failure.",
      })}\n`,
    );
    process.exitCode = 1;
  }
}
