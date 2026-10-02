#!/usr/bin/env node
// The operator entrypoint.
//
// Every argument is an operator-owned path or a machine token. No vacancy value is ever passed on
// the command line - the links arrive in a file, the URLs inside the artifacts arrive in files, and
// nothing this process prints echoes one. That is ADR 0011's boundary in its strongest form: there
// is no shell string to escape, because there is no external value in the command.
//
// Stdout is a bounded summary because a model reads it. The full report is a file, because a human
// reads that.

import { writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CandidateError, candidateLanguageNames, candidateRootForCommand } from "../candidate/load.mjs";
import { TriageVerifyError, fail } from "./errors.mjs";
import { buildContext, cadences, runSuite, summarize } from "./suite.mjs";
import { reportFileName } from "./artifacts.mjs";

const FLAGS = Object.freeze([
  "--artifacts-dir",
  "--links-file",
  "--from",
  "--to",
  "--cadence",
  "--ledger",
  "--vocabulary",
  "--report",
]);

const USAGE = [
  "usage: node tools/triage-verify/cli.mjs \\",
  "         --artifacts-dir <absolute dir> --links-file <absolute file> \\",
  "         --from <n> --to <n> [--cadence per-batch|full] \\",
  "         [--ledger <absolute file>] [--vocabulary <absolute file>] \\",
  "         [--report <absolute file>|none]",
].join("\n");

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!FLAGS.includes(flag)) fail("argument_unknown", `Unknown argument ${flag}.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("argument_value_missing", `${flag} needs a value.`);
    }
    if (values.has(flag)) fail("argument_repeated", `${flag} was given twice.`);
    values.set(flag, value);
    index += 1;
  }
  for (const required of ["--artifacts-dir", "--links-file", "--from", "--to"]) {
    if (!values.has(required)) fail("argument_missing", `${required} is required.`);
  }
  const integer = (flag) => {
    const parsed = Number(values.get(flag));
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      fail("argument_invalid", `${flag} must be a positive integer.`);
    }
    return parsed;
  };
  const cadence = values.get("--cadence") ?? "per-batch";
  if (!cadences.includes(cadence)) {
    fail("argument_invalid", `--cadence must be one of ${cadences.join(", ")}.`);
  }
  for (const flag of ["--artifacts-dir", "--links-file", "--ledger", "--vocabulary"]) {
    const value = values.get(flag);
    if (value !== undefined && !isAbsolute(value)) {
      fail("argument_invalid", `${flag} must be an absolute path.`);
    }
  }
  const report = values.get("--report") ?? null;
  if (report !== null && report !== "none" && !isAbsolute(report)) {
    fail("argument_invalid", "--report must be an absolute path or the token none.");
  }
  return {
    artifactsDir: values.get("--artifacts-dir"),
    cadence,
    from: integer("--from"),
    ledgerPath: values.get("--ledger") ?? null,
    linksFile: values.get("--links-file"),
    reportPath: report,
    to: integer("--to"),
    vocabularyPath: values.get("--vocabulary") ?? undefined,
  };
}

export function reportDestination(options) {
  if (options.reportPath === "none") return null;
  return options.reportPath ?? join(options.artifactsDir, reportFileName);
}

export function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    if (error instanceof TriageVerifyError) {
      process.stderr.write(`${JSON.stringify({ error: error.code, message: error.message })}\n${USAGE}\n`);
      return 1;
    }
    throw error;
  }
  let languages;
  try {
    // The languages the batch was scored in are the ones of the workspace's candidate layer.
    const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    languages = candidateLanguageNames({ root: candidateRootForCommand(checkoutRoot) });
  } catch (error) {
    if (error instanceof CandidateError) {
      process.stderr.write(`${JSON.stringify({ error: error.code, message: error.message })}\n`);
      return 1;
    }
    throw error;
  }
  let report;
  try {
    const context = buildContext({ ...options, languages });
    report = runSuite(context, options.cadence);
  } catch (error) {
    if (error instanceof TriageVerifyError) {
      process.stderr.write(`${JSON.stringify({ error: error.code, message: error.message })}\n`);
      return 1;
    }
    throw error;
  }
  const destination = reportDestination(options);
  if (destination !== null) {
    try {
      writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" });
    } catch {
      process.stderr.write(`${JSON.stringify({ error: "report_write_failed" })}\n`);
      return 1;
    }
  }
  process.stdout.write(`${JSON.stringify(summarize(report), null, 2)}\n`);
  return report.status === "pass" ? 0 : 2;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
