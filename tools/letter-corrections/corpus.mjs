// The letter-correction corpus: what a record is, where it may be written, and how the corpus is
// counted.
//
// The corpus is data, not rules. Nothing in the pipeline reads it while writing a letter; it
// exists so that a correction the user made once can be looked at later, and so that "corrections
// per letter" is a number rather than a memory. Turning any record into a rule is a deliberate
// user decision made in `knowledge/`, never a side effect of writing one.

import { spawnSync as defaultSpawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_LANGUAGE } from "../candidate/default-language.mjs";

export const CORPUS_SCHEMA_VERSION = 1;

/**
 * Where the live corpus lives: a run artifact in the run root, beside the process log, in the
 * state zone the daily backup copies (ADR 0024, decision 6).
 */
export const RUN_CORPUS_DIRECTORY = "records/letter-corrections";

/** Where the versioned copy lives inside the private repository, after `records:import`. */
export const LAYER_CORPUS_DIRECTORY = "research/letter-corrections";

/**
 * The file that makes a directory a run root. A development clone has no process log — that
 * absence is its protection (docs/runbooks/development-flow.md#3-rules-that-do-not-bend) — so a record is refused there rather than
 * written somewhere a run never looks.
 */
export const RUN_LEDGER_FILE = "process-log.json";

/**
 * Every refusal this module can raise, frozen so the README has an oracle in the source rather
 * than a second hand-kept list. A code added here and not documented is a refusal an operator
 * would meet with nothing to read about it.
 */
export const CORPUS_ERROR_CODES = Object.freeze([
  "corpus_ignore_status_unknown",
  "corpus_in_public_tree",
  "corpus_missing",
  "corpus_no_run_root",
  "corpus_record_exists",
  "corpus_record_invalid",
]);

/** Where records live inside the corpus directory. */
export const RECORDS_DIRECTORY = "records";

/**
 * The two revision channels of Step 5, spelled exactly as the ledger spells them. A correction
 * reaches the letter through one of them and through no other route: re-authoring the letter with
 * `reopen-step` is not a revision and leaves no record.
 */
export const CHANNELS = Object.freeze(["chat_command", "manual_file"]);

/**
 * The languages a record may name: the letter's own language, spelled as the brief and the
 * validator spell it. The set is the candidate layer's — the caller passes its names — and without
 * them only the default language is accepted.
 */
export function letterLanguages(languages) {
  return languages === undefined ? Object.freeze([DEFAULT_LANGUAGE.name]) : languages;
}

/**
 * What happened to the "after" side. `published` is the ordinary outcome. `not_published` exists
 * because one real correction never reached a publication at all: a letter the user edited on
 * disk in September 2026 was never adopted, and dropping it would hide an open state rather
 * than record it.
 */
export const AFTER_STATES = Object.freeze(["published", "not_published"]);

/**
 * Why a record carries no reason. `in_place_edit` is the user editing the published file without
 * saying why — the commonest case, and the one the version archive alone could never explain.
 * `not_given` is a change the user asked for in chat without saying what was wrong with the old
 * wording. Both are facts about the record, not apologies for it.
 */
export const REASON_ABSENCES = Object.freeze(["in_place_edit", "not_given"]);

/**
 * The error classes of the September 2026 retrospective, frozen as codes. New records may carry
 * none: a class is the analyst's reading, and the procedure that writes a record during a revision
 * is not asked to classify. Two codes on one record are ordinary — the report itself puts eight of
 * its rows in two classes at once.
 */
export const CLASS_CODES = Object.freeze([
  "class-1",
  "class-2",
  "class-3",
  "class-4",
  "class-5",
  "class-6",
  "class-7",
  "class-8",
  "class-9",
  "class-10",
  "class-11",
]);

/** Where the record came from: a live revision, or the migration of the retrospective. */
export const ORIGINS = Object.freeze(["revision", "retrospective-2026-09"]);

/**
 * The blind reader of task 144 fills this in per fragment: did it flag this fragment before the
 * letter was published? `missed` teaches the reader; `flagged` says the reader saw it and the
 * author published anyway, which is a different defect with a different owner.
 */
export const READER_VERDICTS = Object.freeze(["flagged", "missed"]);

const RECORD_ID_PATTERN = /^lc_[0-9a-f]{12}$/u;
const PROCESS_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;
const PUBLICATION_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SOURCE_REF_PATTERN = /^[A-Za-z0-9_./-]{1,256}$/u;
const FRAGMENT_MAX_BYTES = 8192;
const REASON_MAX_BYTES = 4096;
const COMPANY_ROLE_MAX_BYTES = 256;

export class LetterCorrectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LetterCorrectionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new LetterCorrectionError(code, message);
}

/**
 * The keys of a record, in the order they are written. The order is part of the file: a corpus a
 * human opens should read the same way in every file, and a stable order keeps a re-write of one
 * record from showing up as a reordering diff.
 */
const RECORD_KEYS = Object.freeze([
  "schemaVersion",
  "record_id",
  "recorded_at",
  "occurred_on",
  "process_id",
  "company_role",
  "publication_before",
  "publication_after",
  "before_index",
  "after_state",
  "channel",
  "language",
  "fragment_before",
  "fragment_after",
  "user_reason",
  "user_reason_absent",
  "classes",
  "reader_verdict",
  "teach",
  "origin",
  "source_ref",
]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withinBytes(value, max) {
  return Buffer.byteLength(value, "utf8") <= max;
}

/**
 * Validate one record. Used both when a record is written and when the corpus is read, so a hand
 * edit of `teach` — the mark the procedure deliberately leaves to the user — is held to the same
 * shape as a generated record.
 */
export function validateRecord(record, label, { languages } = {}) {
  const where = label === undefined ? "record" : label;
  if (!isPlainObject(record)) {
    fail("corpus_record_invalid", `${where}: not a JSON object.`);
  }
  const actual = Object.keys(record);
  const missing = RECORD_KEYS.filter((key) => !Object.hasOwn(record, key));
  const unexpected = actual.filter((key) => !RECORD_KEYS.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    fail(
      "corpus_record_invalid",
      `${where}: key set is wrong (missing ${missing.join(", ") || "none"}; ` +
        `unexpected ${unexpected.join(", ") || "none"}).`,
    );
  }
  const check = (condition, what) => {
    if (!condition) fail("corpus_record_invalid", `${where}: ${what}.`);
  };

  check(record.schemaVersion === CORPUS_SCHEMA_VERSION, "unknown schemaVersion");
  check(
    typeof record.record_id === "string" && RECORD_ID_PATTERN.test(record.record_id),
    "record_id is not lc_<12 lowercase hex>",
  );
  check(
    typeof record.recorded_at === "string" && !Number.isNaN(Date.parse(record.recorded_at)),
    "recorded_at is not a timestamp",
  );
  check(
    typeof record.occurred_on === "string" && DATE_PATTERN.test(record.occurred_on),
    "occurred_on is not YYYY-MM-DD",
  );
  check(
    typeof record.process_id === "string" && PROCESS_ID_PATTERN.test(record.process_id),
    "process_id is not a process identifier",
  );
  check(
    typeof record.company_role === "string" &&
      record.company_role.length > 0 &&
      withinBytes(record.company_role, COMPANY_ROLE_MAX_BYTES),
    "company_role is empty or too long",
  );
  check(
    typeof record.publication_before === "string" &&
      PUBLICATION_ID_PATTERN.test(record.publication_before),
    "publication_before is not a publication identifier",
  );
  check(
    record.publication_after === null ||
      (typeof record.publication_after === "string" &&
        PUBLICATION_ID_PATTERN.test(record.publication_after)),
    "publication_after is neither null nor a publication identifier",
  );
  check(
    Number.isInteger(record.before_index) && record.before_index >= 0,
    "before_index is not a non-negative integer",
  );
  check(AFTER_STATES.includes(record.after_state), "after_state is not a known state");
  // The two are one statement said twice, and a record that disagrees with itself would be read
  // by task 144 as a published fragment that has no published bytes.
  check(
    (record.after_state === "published") === (record.publication_after !== null),
    "after_state and publication_after disagree",
  );
  check(CHANNELS.includes(record.channel), "channel is not a revision channel");
  check(letterLanguages(languages).includes(record.language), "language is not a letter language");
  for (const side of ["fragment_before", "fragment_after"]) {
    check(
      typeof record[side] === "string" && withinBytes(record[side], FRAGMENT_MAX_BYTES),
      `${side} is not a string within ${FRAGMENT_MAX_BYTES} bytes`,
    );
  }
  // A record whose two sides are equal records nothing: the corpus is corrections, and a revision
  // that changed no text — a waiver-only publication of the same bytes — leaves no record at all.
  check(
    record.fragment_before !== record.fragment_after,
    "fragment_before and fragment_after are identical",
  );
  check(
    record.user_reason === null ||
      (typeof record.user_reason === "string" &&
        record.user_reason.length > 0 &&
        withinBytes(record.user_reason, REASON_MAX_BYTES)),
    "user_reason is neither null nor a non-empty bounded string",
  );
  check(
    record.user_reason_absent === null || REASON_ABSENCES.includes(record.user_reason_absent),
    "user_reason_absent is not a known absence code",
  );
  check(
    (record.user_reason === null) !== (record.user_reason_absent === null),
    "exactly one of user_reason and user_reason_absent must be set",
  );
  check(
    Array.isArray(record.classes) &&
      record.classes.every((code) => CLASS_CODES.includes(code)) &&
      new Set(record.classes).size === record.classes.length,
    "classes is not a set of known class codes",
  );
  check(
    record.reader_verdict === null || READER_VERDICTS.includes(record.reader_verdict),
    "reader_verdict is not a known verdict",
  );
  check(typeof record.teach === "boolean", "teach is not a boolean");
  check(ORIGINS.includes(record.origin), "origin is not a known origin");
  check(
    record.source_ref === null ||
      (typeof record.source_ref === "string" && SOURCE_REF_PATTERN.test(record.source_ref)),
    "source_ref is neither null nor a repository-relative path",
  );
  return record;
}

/**
 * What git says when the answer is "there is nothing here", as opposed to "I would not look".
 *
 * Anchored to the start of a line of git's own message, because git interpolates paths into other
 * fatal messages: an unanchored phrase can be produced by a directory named after it, and the
 * refusing side is where an unreadable repository has to land.
 */
const NO_REPOSITORY_HERE = /^fatal: not a git repository/mu;

function runGit(spawnSync, cwd, args) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    // The guard reads git's message to tell an absent repository from a refused one, so the
    // message has to be the one this code was written against rather than the operator's locale.
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
}

/**
 * Refuse a corpus that Git does not ignore.
 *
 * The corpus holds cover letters written to real companies, verbatim. Until backlog task 165 it
 * was a tracked file, and the guard here asked a different question — whether it sat in the
 * repository's primary worktree, which is the operational checkout, where a tracked modification
 * is what the next cutover refuses. That reason died with the move: the corpus now lives in the
 * run's `records/`, which Git ignores, so a cutover never sees it.
 *
 * What replaces it is the invariant the move exists for. A corpus Git would track is a corpus that
 * an export ships, and an export that ships one real letter has defeated the whole separation. So
 * the question is asked of Git rather than of the topology: is this directory ignored?
 *
 * Three answers, and the middle one is the only refusal:
 *
 * - no repository here at all — allowed. This is the operational folder, which carries no `.git`,
 *   and nothing about it can reach a publication.
 * - a repository that ignores it — allowed. This is `records/` of a checkout that runs the
 *   pipeline, which the engine's `.gitignore` names.
 * - a repository that does not ignore it — refused. Tracked counts: `git check-ignore` reports a
 *   tracked path as not ignored even when a rule would match it, which is exactly the reading this
 *   guard wants.
 *
 * An answer Git will not give is a refusal of its own rather than a pass: a guard that fails open
 * on an unreadable repository would be no guard at all. That distinction has to be made by hand,
 * because "there is no repository here" and "I would not look" arrive the same way — a non-zero
 * exit — and only the first is safe. Git names the first in its message, so the message is what
 * separates them, under `LC_ALL=C` so the wording is the one this code was written against. A
 * translated or reworded message falls to the refusing side, which is the side to fall to. Git
 * failing to run at all — missing, unexecutable — is not an answer and never a pass.
 */
export function assertCorpusWritable(corpusRealPath, { spawnSync = defaultSpawnSync } = {}) {
  const inside = runGit(spawnSync, corpusRealPath, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.error) {
    fail(
      "corpus_ignore_status_unknown",
      "git did not run, so whether this corpus is ignored is unknown.",
    );
  }
  if (inside.status !== 0) {
    if (!NO_REPOSITORY_HERE.test(String(inside.stderr ?? ""))) {
      fail("corpus_ignore_status_unknown", "git refused to say whether a repository is here.");
    }
    return;
  }
  if (String(inside.stdout ?? "").trim() !== "true") return;

  const ignored = runGit(spawnSync, corpusRealPath, ["check-ignore", "-q", "--", corpusRealPath]);
  if (ignored.error === undefined && ignored.status === 0) return;
  if (ignored.error === undefined && ignored.status === 1) {
    fail(
      "corpus_in_public_tree",
      "The corpus lies in a directory this repository does not ignore, so an export would ship " +
        "the letters inside it. Write it in the run's records/ instead.",
    );
  }
  fail(
    "corpus_ignore_status_unknown",
    "git could not decide whether the corpus directory is ignored.",
  );
}

/**
 * The workspace a command-line entry point works in: the one `JOB_PIPELINE_WORKSPACE_ROOT` names,
 * or the checkout the command belongs to — the same resolution `tools/process-log.mjs` makes, so
 * a record lands beside the ledger the step itself used.
 */
export function workspaceRootFor(checkoutRoot, environment = process.env) {
  return resolve(environment.JOB_PIPELINE_WORKSPACE_ROOT ?? checkoutRoot);
}

/** Whether `root` holds a run's process log, which is what makes it a run root. */
export function isRunRoot(root) {
  try {
    return statSync(resolve(root, RUN_LEDGER_FILE)).isFile();
  } catch {
    return false;
  }
}

/**
 * The live corpus directory of a run root, refused anywhere that is not one. The directory itself
 * need not exist yet: the first record of a run creates it.
 */
export function runCorpusDirectory(root) {
  if (!isRunRoot(root)) {
    fail(
      "corpus_no_run_root",
      `No ${RUN_LEDGER_FILE} here, so this is not a run root; a record is written only beside ` +
        "the process log of the run that published the letter.",
    );
  }
  return resolve(root, RUN_CORPUS_DIRECTORY);
}

/**
 * Write one record and return it. The caller owns the corpus path; this function owns the shape,
 * the identifier and the one field it always leaves empty.
 */
export function writeRecord(
  corpusDirectory,
  fields,
  {
    languages,
    now = () => new Date(),
    randomId = () => randomBytes(6).toString("hex"),
    spawnSync = defaultSpawnSync,
  } = {},
) {
  const corpus = resolve(corpusDirectory);
  let corpusRealPath;
  try {
    corpusRealPath = realpathSync(corpus);
  } catch {
    return fail("corpus_missing", "The corpus directory does not exist.");
  }
  assertCorpusWritable(corpusRealPath, { spawnSync });

  const record = validateRecord(
    {
      schemaVersion: CORPUS_SCHEMA_VERSION,
      record_id: `lc_${randomId()}`,
      recorded_at: now().toISOString(),
      occurred_on: fields.occurredOn,
      process_id: fields.processId,
      company_role: fields.companyRole,
      publication_before: fields.publicationBefore,
      publication_after: fields.publicationAfter,
      before_index: fields.beforeIndex,
      after_state: fields.afterState,
      channel: fields.channel,
      language: fields.language,
      fragment_before: fields.fragmentBefore,
      fragment_after: fields.fragmentAfter,
      user_reason: fields.userReason,
      user_reason_absent: fields.userReasonAbsent,
      classes: fields.classes,
      // The verdict is the revision's own observation: the blind reader read the version the user
      // then corrected, and only that revision still knows what it said. Absent, it stays null, and
      // null on a live record means no reading happened. `teach` is never filled here: a record that
      // arrived already marked as a lesson would be the corpus teaching itself, which is the one
      // thing it must not do, and the mark is the user's.
      reader_verdict: fields.readerVerdict ?? null,
      teach: false,
      origin: fields.origin,
      source_ref: fields.sourceRef,
    },
    undefined,
    { languages },
  );

  const directory = resolve(corpusRealPath, RECORDS_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  // The guard above resolved the corpus directory; `records/` inside it is resolved too, because a
  // symlink there would carry the write back into the checkout the guard just refused, and
  // `mkdirSync` follows it without a word.
  const directoryRealPath = realpathSync(directory);
  assertCorpusWritable(directoryRealPath, { spawnSync });
  const path = resolve(directoryRealPath, `${record.record_id}.json`);
  // Exclusive: a record identifier is generated, and a collision must be a loud failure rather
  // than a silently overwritten correction. It gets its own code, because the CLI promises a
  // bounded vocabulary and a raw EEXIST would surface as "unexpected".
  try {
    writeFileSync(path, `${JSON.stringify(record, RECORD_KEYS, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("corpus_record_exists", "A record with this identifier already exists. Run again.");
    }
    throw error;
  }
  return { path, record };
}

/**
 * Read every record file of the corpus, in file-name order, validating each one, with the bytes
 * it was read from. A file must be named after the record it holds: the identifier is what a copy
 * of the corpus is deduplicated by, and two files carrying one identifier would be two copies of
 * one correction.
 */
export function readCorpusEntries(corpusDirectory, { languages } = {}) {
  const directory = resolve(corpusDirectory, RECORDS_DIRECTORY);
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return fail("corpus_missing", "The corpus has no records directory.");
  }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => {
      const bytes = readFileSync(resolve(directory, entry));
      let parsed;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        return fail("corpus_record_invalid", `${entry}: not valid JSON.`);
      }
      const record = validateRecord(parsed, entry, { languages });
      if (entry !== `${record.record_id}.json`) {
        fail("corpus_record_invalid", `${entry}: the file is not named after its record_id.`);
      }
      return { bytes, name: entry, record };
    });
}

/** Read every record of the corpus, in file-name order, validating each one. */
export function readCorpus(corpusDirectory, { languages } = {}) {
  return readCorpusEntries(corpusDirectory, { languages }).map((entry) => entry.record);
}

function mean(total, count) {
  return count === 0 ? null : Math.round((total / count) * 100) / 100;
}

/**
 * The counts the corpus exists to produce.
 *
 * Corrections per letter is the one number that shows whether anything done to the review helps:
 * it accumulates on every real letter, with no separate measurement run. In-place corrections per
 * letter is the same number for the corrections the user made by editing the file, which is the
 * half that used to leave no reason anywhere.
 *
 * The denominator is letters the corpus knows about, not letters written: a letter the user
 * accepted without a single correction leaves no record and never enters it. So the mean measures
 * corrections among corrected letters, and a review change that removes a letter's corrections
 * entirely moves the count of letters, not the mean. Whoever wants the other denominator reads it
 * from the ledger; this tool does not see the ledger at all.
 */
export function summarize(records) {
  const letters = new Map();
  const byClass = new Map();
  let unclassified = 0;
  let inPlace = 0;
  let verdictFilled = 0;
  let verdictFlagged = 0;

  for (const record of records) {
    const letter = letters.get(record.process_id) ?? {
      processId: record.process_id,
      companyRole: record.company_role,
      corrections: 0,
      inPlace: 0,
    };
    letter.corrections += 1;
    if (record.channel === "manual_file") {
      letter.inPlace += 1;
      inPlace += 1;
    }
    letters.set(record.process_id, letter);

    if (record.classes.length === 0) unclassified += 1;
    for (const code of record.classes) {
      byClass.set(code, (byClass.get(code) ?? 0) + 1);
    }
    if (record.reader_verdict !== null) {
      verdictFilled += 1;
      if (record.reader_verdict === "flagged") verdictFlagged += 1;
    }
  }

  const perLetter = [...letters.values()].sort((left, right) =>
    left.processId.localeCompare(right.processId),
  );

  return {
    records: records.length,
    letters: perLetter.length,
    perLetter,
    correctionsPerLetter: { total: records.length, mean: mean(records.length, perLetter.length) },
    inPlacePerLetter: { total: inPlace, mean: mean(inPlace, perLetter.length) },
    byClass: {
      ...Object.fromEntries(
        CLASS_CODES.filter((code) => byClass.has(code)).map((code) => [code, byClass.get(code)]),
      ),
      unclassified,
    },
    readerVerdict: {
      filled: verdictFilled,
      flagged: verdictFlagged,
      // Null, not zero: "no fragment was flagged" and "no verdict has been recorded yet" are
      // different answers, and task 144 reads this field to tell them apart.
      flaggedShare:
        verdictFilled === 0 ? null : Math.round((verdictFlagged / verdictFilled) * 100) / 100,
    },
  };
}
