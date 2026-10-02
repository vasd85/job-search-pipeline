#!/usr/bin/env node
// letter-corrections — the shell-facing entry point of the letter-correction corpus.
//
// What crosses the command line is only repository-owned tokens: the subcommand, a corpus
// directory for the summary, publication and process identifiers, bounded codes, an index, dates and the
// controlled basename of an ADR 0011 envelope. The letter fragments and the user's own reason live
// in that envelope. Nothing this CLI prints carries letter text, because its stdout is read by a
// model and a diagnostic that quotes a letter built from a vacancy page is an injection channel.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { CandidateError, candidateLanguageNames, candidateRootFor } from "../candidate/load.mjs";
import { SafeCliInputError, readSafeCliInput } from "../lib/safe-cli-input.mjs";
import {
  AFTER_STATES,
  CHANNELS,
  CLASS_CODES,
  LetterCorrectionError,
  ORIGINS,
  READER_VERDICTS,
  REASON_ABSENCES,
  RECORDS_DIRECTORY,
  RUN_CORPUS_DIRECTORY,
  readCorpus,
  runCorpusDirectory,
  summarize,
  workspaceRootFor,
  writeRecord,
} from "./corpus.mjs";
import { letterCorrectionCommand, letterCorrectionInputSchemas } from "./input-schema.mjs";

const checkoutRoot = resolve(import.meta.dirname, "../..");

// Resolved per invocation rather than at module load, so a caller that sets the isolation
// environment after importing this module is honoured instead of silently reading the real root.
function resolveWorkspaceRoot(seams) {
  return seams.workspaceRoot ?? workspaceRootFor(checkoutRoot);
}

function resolveInputRoot(workspaceRoot) {
  return process.env.JOB_PIPELINE_INPUT_ROOT ?? resolve(workspaceRoot, ".pipeline-input");
}

// The letter languages are those of the candidate layer of the same workspace, read per
// invocation for the same reason; a test hands them in through the seams instead.
function resolveLanguages(seams) {
  return (
    seams.languages ??
    candidateLanguageNames({
      root: candidateRootFor(resolveWorkspaceRoot(seams)),
    })
  );
}

// `--class` is the one repeatable flag: the retrospective puts eight of its rows in two classes at
// once, so a record carries a set rather than a value.
const REPEATABLE_OPTIONS = Object.freeze(["class"]);

const ALLOWED_RECORD_OPTIONS = Object.freeze([
  "input-file",
  "process-id",
  "publication-before",
  "publication-after",
  "before-index",
  "after-state",
  "channel",
  "language",
  "occurred-on",
  "reason-absent",
  "class",
  "origin",
  "source-ref",
  "reader-verdict",
]);

const ALLOWED_SUMMARY_OPTIONS = Object.freeze(["corpus"]);

function usage() {
  process.stdout.write(`letter-corrections — the corpus of cover-letter corrections

Usage:
  node tools/letter-corrections/cli.mjs record \\
    --input-file input-<32 lowercase hex>.json \\
    --process-id <process.id> --publication-before <id> \\
    [--publication-after <id>] --after-state ${AFTER_STATES.join("|")} \\
    --before-index <n> --channel ${CHANNELS.join("|")} \\
    --language <the default language or a configured one> --occurred-on YYYY-MM-DD \\
    [--reason-absent ${REASON_ABSENCES.join("|")}] [--class class-N]... \\
    [--origin ${ORIGINS.join("|")}] [--source-ref <repository-relative path>] \\
    [--reader-verdict ${READER_VERDICTS.join("|")}]

  node tools/letter-corrections/cli.mjs summary --corpus <corpus directory>

The envelope holds the letter fragments (\`values.fragmentBefore\`, \`values.fragmentAfter\`), the
process output directory name (\`values.companyRole\`) and the user's verbatim reason
(\`values.userReason\`, omitted when there is none). Produce it with the safe input-file producer
procedure in instructions/pipeline-artifacts.md; letter text never appears on the command line.

Exactly one of \`values.userReason\` and \`--reason-absent\` is supplied: a correction either carries
the user's own words or says in the record why it carries none.

\`--reader-verdict\` says what the blind reader made of this place before the corrected publication:
\`flagged\` if it flagged the sentence the user then changed, \`missed\` if it did not. Left out, the
record says no reading happened before that publication.

\`record\` writes only in a run root — a workspace that holds process-log.json — and writes one JSON
file per correction into <run root>/${RUN_CORPUS_DIRECTORY}/${RECORDS_DIRECTORY}/; anywhere else it
refuses with corpus_no_run_root. The corpus is data, never rules: no skill reads it, and promoting a
record into canon is a user decision.

Test isolation environment: JOB_PIPELINE_WORKSPACE_ROOT, JOB_PIPELINE_INPUT_ROOT
`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length;) {
    const flag = rest[index];
    if (!flag?.startsWith("--")) {
      throw new LetterCorrectionError(
        "invalid_cli_arguments",
        `Invalid argument near ${flag ?? "<end>"}`,
      );
    }
    const key = flag.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new LetterCorrectionError("invalid_cli_arguments", `Missing value for --${key}`);
    }
    if (REPEATABLE_OPTIONS.includes(key)) {
      options[key] = [...(options[key] ?? []), value];
    } else if (Object.hasOwn(options, key)) {
      throw new LetterCorrectionError("invalid_cli_arguments", `Duplicate option: --${key}`);
    } else {
      options[key] = value;
    }
    index += 2;
  }
  return { command, options };
}

function required(options, name) {
  if (!Object.hasOwn(options, name)) {
    throw new LetterCorrectionError("invalid_cli_arguments", `Missing --${name}`);
  }
  return options[name];
}

function oneOf(options, name, allowed, { optional = false } = {}) {
  if (!Object.hasOwn(options, name)) {
    if (optional) return null;
    throw new LetterCorrectionError("invalid_cli_arguments", `Missing --${name}`);
  }
  const value = options[name];
  if (!allowed.includes(value)) {
    throw new LetterCorrectionError(
      "invalid_cli_arguments",
      `--${name} must be one of ${allowed.join(", ")}`,
    );
  }
  return value;
}

function rejectUnknown(options, allowed) {
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new LetterCorrectionError(
      "invalid_cli_arguments",
      `Unknown option(s): ${unknown.map((key) => `--${key}`).join(", ")}`,
    );
  }
}

export function main(argv, seams = {}) {
  const { command, options } = parseArgs(argv);
  if (command === "help" || command === "--help" || command === undefined) {
    usage();
    return 0;
  }

  if (command === "summary") {
    rejectUnknown(options, ALLOWED_SUMMARY_OPTIONS);
    const records = readCorpus(resolve(required(options, "corpus")), {
      languages: resolveLanguages(seams),
    });
    process.stdout.write(`${JSON.stringify(summarize(records), null, 2)}\n`);
    return 0;
  }

  if (command !== letterCorrectionCommand) {
    throw new LetterCorrectionError("unknown_command", `Unknown command: ${command}`);
  }

  rejectUnknown(options, ALLOWED_RECORD_OPTIONS);
  // The run root first, before the layer is read: a development clone refuses for what it is,
  // not for whatever its layer happens to hold.
  const workspaceRoot = resolveWorkspaceRoot(seams);
  const corpus = runCorpusDirectory(workspaceRoot);
  const languages = resolveLanguages(seams);

  // Every caller-supplied token is resolved before the envelope is opened: a malformed invocation
  // must fail without touching the input root or the corpus.
  const afterState = oneOf(options, "after-state", AFTER_STATES);
  const publicationAfter = Object.hasOwn(options, "publication-after")
    ? options["publication-after"]
    : null;
  if ((afterState === "published") !== (publicationAfter !== null)) {
    throw new LetterCorrectionError(
      "invalid_cli_arguments",
      "--after-state published requires --publication-after, and not-published forbids it",
    );
  }
  const beforeIndex = Number(required(options, "before-index"));
  if (!Number.isSafeInteger(beforeIndex) || beforeIndex < 0) {
    throw new LetterCorrectionError(
      "invalid_cli_arguments",
      "--before-index must be a non-negative integer",
    );
  }
  const classes = options.class ?? [];
  for (const code of classes) {
    if (!CLASS_CODES.includes(code)) {
      throw new LetterCorrectionError(
        "invalid_cli_arguments",
        `--class must be one of ${CLASS_CODES.join(", ")}`,
      );
    }
  }
  const fields = {
    afterState,
    beforeIndex,
    channel: oneOf(options, "channel", CHANNELS),
    classes,
    language: oneOf(options, "language", languages),
    occurredOn: required(options, "occurred-on"),
    origin: oneOf(options, "origin", ORIGINS, { optional: true }) ?? "revision",
    processId: required(options, "process-id"),
    publicationAfter,
    publicationBefore: required(options, "publication-before"),
    readerVerdict: oneOf(options, "reader-verdict", READER_VERDICTS, { optional: true }),
    sourceRef: Object.hasOwn(options, "source-ref") ? options["source-ref"] : null,
    userReasonAbsent: oneOf(options, "reason-absent", REASON_ABSENCES, { optional: true }),
  };

  const envelope = readSafeCliInput({
    basename: required(options, "input-file"),
    command: letterCorrectionCommand,
    inputRoot: resolveInputRoot(workspaceRoot),
    schemas: letterCorrectionInputSchemas,
  });
  const userReason = Object.hasOwn(envelope.values, "userReason")
    ? envelope.values.userReason
    : null;
  // Said once here and once in the record validator. Here the message can name the two inputs the
  // caller actually typed; there the invariant holds for a record a hand edit produced too.
  if ((userReason === null) === (fields.userReasonAbsent === null)) {
    throw new LetterCorrectionError(
      "invalid_cli_arguments",
      "Supply exactly one of the envelope's userReason and --reason-absent",
    );
  }

  // The first record of a run creates the directory; the run root itself is already proven.
  mkdirSync(corpus, { recursive: true });
  const { path, record } = writeRecord(
    corpus,
    {
      ...fields,
      companyRole: envelope.values.companyRole,
      fragmentAfter: envelope.values.fragmentAfter,
      fragmentBefore: envelope.values.fragmentBefore,
      userReason,
    },
    { ...seams, languages },
  );

  // The identifier, the path and the counted facts. No fragment, no reason, no letter text.
  process.stdout.write(
    `${JSON.stringify(
      {
        recordId: record.record_id,
        path,
        processId: record.process_id,
        channel: record.channel,
        afterState: record.after_state,
        classes: record.classes,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

// `import.meta.main` is false when a test imports this module, so the tests drive `main` without
// the process-level exit handling below.
if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    const known =
      error instanceof LetterCorrectionError ||
      error instanceof SafeCliInputError ||
      error instanceof CandidateError;
    const code = known ? error.code : "unexpected_error";
    // Stable, bounded diagnostics: the code and the repository-owned message, never a stack, an
    // absolute path or a letter fragment.
    process.stderr.write(
      `${JSON.stringify({
        error: code,
        message: known ? error.message : "Unexpected failure.",
      })}\n`,
    );
    process.exitCode = 1;
  }
}
