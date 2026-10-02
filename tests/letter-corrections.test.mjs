import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createDisposableWorkspace } from "./fixtures/disposable-workspace.mjs";
import { candidateExampleRootFor, candidateLanguageNames } from "../tools/candidate/load.mjs";
import {
  CLASS_CODES,
  CORPUS_ERROR_CODES,
  workspaceRootFor,
  readCorpus as readCorpusWith,
  summarize,
  validateRecord as validateRecordWith,
  writeRecord as writeRecordWith,
} from "../tools/letter-corrections/corpus.mjs";
import { letterCorrectionCommand } from "../tools/letter-corrections/input-schema.mjs";
import { main as mainWith } from "../tools/letter-corrections/cli.mjs";
import {
  IMPORT_ERROR_CODES,
  importRecords,
  main as importMain,
  parseArguments as parseImportArguments,
} from "../tools/letter-corrections/import.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The letter languages come from the tracked example — the default language and Greek — never from
// the operator's layer. The wrappers pass them so each case states only what it is about.
const exampleLanguages = candidateLanguageNames({ root: candidateExampleRootFor(repoRoot) });
const readCorpus = (directory, options = {}) =>
  readCorpusWith(directory, { languages: exampleLanguages, ...options });
const validateRecord = (record, label, options = {}) =>
  validateRecordWith(record, label, { languages: exampleLanguages, ...options });
const writeRecord = (directory, fields, options = {}) =>
  writeRecordWith(directory, fields, { languages: exampleLanguages, ...options });
const main = (argv, seams = {}) => mainWith(argv, { languages: exampleLanguages, ...seams });
const cliPath = join(repoRoot, "tools", "letter-corrections", "cli.mjs");

/**
 * A spawn seam answering the two questions the guard asks git: whether the corpus sits inside a
 * work tree at all, and whether that tree ignores it. The tests state the answers directly instead
 * of building checkouts on disk; one test below does drive real git, so the default wiring is
 * proven too.
 *
 * The defaults are the ordinary case — an ignored corpus inside the candidate layer — so a test
 * that is not about the guard says nothing about git. `ignored` may be a predicate when a test
 * needs two verdicts in one repository, which is what the symlink case is made of.
 */
function gitAnswers({ insideWorkTree = true, ignored = true } = {}) {
  const isIgnored = typeof ignored === "function" ? ignored : () => ignored;
  return (_command, args) => {
    if (args[0] === "rev-parse") {
      return insideWorkTree
        ? { error: undefined, status: 0, stdout: "true\n", stderr: "" }
        : {
            error: undefined,
            status: 128,
            stdout: "",
            stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
          };
    }
    if (args[0] === "check-ignore") {
      return {
        error: undefined,
        status: isIgnored(args[args.length - 1]) ? 0 : 1,
        stdout: "",
        stderr: "",
      };
    }
    throw new Error(`the guard asked git something the seam does not know: ${args.join(" ")}`);
  };
}

/**
 * A corpus inside a directory the repository ignores: the ordinary case, where the guard has
 * nothing to protect and stays out of the way.
 */
function corpusIn(root) {
  const corpus = join(root, "corpus");
  mkdirSync(join(corpus, "records"), { mode: 0o700, recursive: true });
  return realpathSync(corpus);
}

/**
 * A run root: a workspace holding a process log, which is what `record` writes beside. The corpus
 * it returns is where the CLI finds its directory on its own; the directory is not created here,
 * because the first record creates it.
 */
function runRootIn(root) {
  writeFileSync(join(root, "process-log.json"), "{}\n", { mode: 0o600 });
  return join(root, "records", "letter-corrections");
}

function inputRootIn(workspaceRoot) {
  const inputRoot = join(workspaceRoot, ".pipeline-input");
  if (!existsSync(inputRoot)) mkdirSync(inputRoot, { mode: 0o700 });
  chmodSync(inputRoot, 0o700);
  return realpathSync(inputRoot);
}

function writeEnvelope(inputRoot, values, { command = letterCorrectionCommand } = {}) {
  const nonce = randomBytes(16).toString("hex");
  const basename = `input-${nonce}.json`;
  writeFileSync(
    join(inputRoot, basename),
    `${JSON.stringify({ schemaVersion: 1, command, nonce, values })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  chmodSync(join(inputRoot, basename), 0o600);
  return basename;
}

const ENVELOPE = Object.freeze({
  companyRole: "кассиопея-senior-qa-инженер",
  fragmentAfter: "полноценный кошелёк на сервере проекта",
  fragmentBefore: "тестовый кошелёк-заглушка",
  userReason: "Это не была заглушка - это был функциональный кошелёк, но на нашем сервере.",
});

function recordArgs(basename, overrides = []) {
  return [
    "record",
    "--input-file",
    basename,
    "--process-id",
    "proc_20260911T141824Z_67541307",
    "--publication-before",
    "pub_write_cover_letter_9581796e085d",
    "--publication-after",
    "publication_d36efb81",
    "--after-state",
    "published",
    "--before-index",
    "0",
    "--channel",
    "chat_command",
    "--language",
    "Greek",
    "--occurred-on",
    "2026-09-11",
    ...overrides,
  ];
}

function silently(run) {
  const originalWrite = process.stdout.write;
  const written = [];
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    return { result: run(), stdout: written.join("") };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function seams(overrides, workspaceRoot) {
  return {
    spawnSync: gitAnswers(overrides),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
  };
}

function fields(overrides = {}) {
  return {
    afterState: "published",
    beforeIndex: 0,
    channel: "chat_command",
    classes: [],
    companyRole: "кассиопея-senior-qa-инженер",
    fragmentAfter: "после",
    fragmentBefore: "до",
    language: "Greek",
    occurredOn: "2026-09-11",
    origin: "revision",
    processId: "proc_a",
    publicationAfter: "pub_b",
    publicationBefore: "pub_a",
    sourceRef: null,
    userReason: "не нравится",
    userReasonAbsent: null,
    ...overrides,
  };
}

test("a record is one file, and an unrecorded verdict and the teach mark arrive empty", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-letter-corrections-",
  });
  const root = realpathSync(environment.workspaceRoot);
  const corpus = corpusIn(root);
  const here = seams();

  const { record, path } = writeRecord(corpus, fields({ classes: ["class-5", "class-6"] }), {
    ...here,
    now: () => new Date("2026-09-21T10:00:00.000Z"),
    randomId: () => "0123456789ab",
  });

  assert.equal(path, join(corpus, "records", "lc_0123456789ab.json"));
  assert.deepEqual(readdirSync(join(corpus, "records")), ["lc_0123456789ab.json"]);
  // Read back from disk, not from the return value: the file is the corpus.
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(onDisk, {
    schemaVersion: 1,
    record_id: "lc_0123456789ab",
    recorded_at: "2026-09-21T10:00:00.000Z",
    occurred_on: "2026-09-11",
    process_id: "proc_a",
    company_role: "кассиопея-senior-qa-инженер",
    publication_before: "pub_a",
    publication_after: "pub_b",
    before_index: 0,
    after_state: "published",
    channel: "chat_command",
    language: "Greek",
    fragment_before: "до",
    fragment_after: "после",
    user_reason: "не нравится",
    user_reason_absent: null,
    classes: ["class-5", "class-6"],
    reader_verdict: null,
    teach: false,
    origin: "revision",
    source_ref: null,
  });
  assert.equal(onDisk.reader_verdict, null);
  assert.equal(onDisk.teach, false);
  assert.equal(record.record_id, onDisk.record_id);

  // An empty class list is an ordinary value: six rows of the retrospective carry no class at all,
  // and a live revision is not asked to classify.
  const second = writeRecord(corpus, fields({ classes: [] }), {
    ...here,
    randomId: () => "ba9876543210",
  });
  assert.deepEqual(second.record.classes, []);
});

test("the blind reader's verdict is written by the revision that records the correction", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-letter-corrections-verdict-",
  });
  const workspaceRoot = realpathSync(environment.workspaceRoot);
  const corpus = runRootIn(workspaceRoot);
  const inputRoot = inputRootIn(workspaceRoot);
  t.after(() => {
    delete process.env.JOB_PIPELINE_INPUT_ROOT;
  });
  process.env.JOB_PIPELINE_INPUT_ROOT = inputRoot;

  // `flagged` and `missed` answer different questions and have different owners, so both travel.
  for (const [verdict, id] of [
    ["flagged", "aa0000000001"],
    ["missed", "aa0000000002"],
  ]) {
    const basename = writeEnvelope(inputRoot, { ...ENVELOPE });
    const { result, stdout } = silently(() =>
      main(recordArgs(basename, ["--reader-verdict", verdict]), {
        ...seams(undefined, workspaceRoot),
        randomId: () => id,
      }),
    );
    assert.equal(result, 0);
    const written = JSON.parse(readFileSync(JSON.parse(stdout).path, "utf8"));
    assert.equal(written.reader_verdict, verdict);
    // The mark the user alone sets is not reachable from here, whatever else the record carries.
    assert.equal(written.teach, false);
  }

  // Left out, the field stays null - which on a live record means the reading did not happen, not
  // that the reader found nothing. Nothing in the CLI invents a verdict.
  const bare = writeEnvelope(inputRoot, { ...ENVELOPE });
  const { stdout: bareStdout } = silently(() =>
    main(recordArgs(bare, []), {
      ...seams(undefined, workspaceRoot),
      randomId: () => "aa0000000003",
    }),
  );
  assert.equal(JSON.parse(readFileSync(JSON.parse(bareStdout).path, "utf8")).reader_verdict, null);

  // A verdict outside the vocabulary is refused before anything is written.
  const wrong = writeEnvelope(inputRoot, { ...ENVELOPE });
  const before = readdirSync(join(corpus, "records")).length;
  assert.throws(
    () =>
      silently(() =>
        main(recordArgs(wrong, ["--reader-verdict", "ignored"]), {
          ...seams(undefined, workspaceRoot),
          randomId: () => "aa0000000004",
        }),
      ),
    (error) => error.code === "invalid_cli_arguments" && /reader-verdict/u.test(error.message),
  );
  assert.equal(readdirSync(join(corpus, "records")).length, before);
});

test("the record keeps its shape against hand edits of the two open fields", () => {
  for (const [patch, needle] of [
    [{ reader_verdict: "ignored" }, /reader_verdict/u],
    [{ teach: "yes" }, /teach/u],
    [{ classes: ["class-99"] }, /classes/u],
    [{ classes: ["class-6", "class-6"] }, /classes/u],
    [{ before_index: -1 }, /before_index/u],
    [{ occurred_on: "11.09.2026" }, /occurred_on/u],
    // The two statements that must agree with each other, each broken on its own side.
    [{ after_state: "not_published" }, /after_state and publication_after disagree/u],
    [{ user_reason_absent: "in_place_edit" }, /exactly one of user_reason/u],
    [{ user_reason: null }, /exactly one of user_reason/u],
    // A record whose sides are equal says nothing was corrected.
    [{ fragment_after: "до" }, /identical/u],
  ]) {
    const base = {
      schemaVersion: 1,
      record_id: "lc_0123456789ab",
      recorded_at: "2026-09-21T10:00:00.000Z",
      occurred_on: "2026-09-11",
      process_id: "proc_a",
      company_role: "role",
      publication_before: "pub_a",
      publication_after: "pub_b",
      before_index: 0,
      after_state: "published",
      channel: "chat_command",
      language: "Greek",
      fragment_before: "до",
      fragment_after: "после",
      user_reason: "не нравится",
      user_reason_absent: null,
      classes: [],
      reader_verdict: null,
      teach: false,
      origin: "revision",
      source_ref: null,
    };
    assert.doesNotThrow(() => validateRecord({ ...base }));
    assert.throws(
      () => validateRecord({ ...base, ...patch }, "lc_x.json"),
      (error) => error.code === "corpus_record_invalid" && needle.test(error.message),
      JSON.stringify(patch),
    );
    // The letter languages are the layer's: without them only the default language is a letter
    // language, so a record in a configured one is refused rather than read on a guess.
    assert.throws(
      () => validateRecordWith({ ...base }, "lc_x.json"),
      (error) =>
        error.code === "corpus_record_invalid" &&
        /language is not a letter language/u.test(error.message),
    );
    assert.doesNotThrow(() => validateRecordWith({ ...base, language: "English" }, "lc_x.json"));
  }
});

test("the corpus is refused in a tree the repository does not ignore", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-letter-corrections-guard-",
  });
  const root = realpathSync(environment.workspaceRoot);
  const corpus = corpusIn(root);

  // The refusal the move exists for: a corpus git would track is a corpus an export ships, and
  // one shipped record is one real letter published to strangers.
  assert.throws(
    () => writeRecord(corpus, fields(), seams({ ignored: false })),
    (error) => error.code === "corpus_in_public_tree",
  );
  // Ignored is the candidate layer, which is where the corpus belongs.
  assert.doesNotThrow(() =>
    writeRecord(corpus, fields(), {
      ...seams(),
      randomId: () => "cccccccccccc",
    }),
  );
  // Outside every checkout there is nothing an export could reach, so there is nothing to guard.
  assert.doesNotThrow(() =>
    writeRecord(corpus, fields(), {
      ...seams({ insideWorkTree: false }),
      randomId: () => "dddddddddddd",
    }),
  );
  // git that did not run at all is not an answer. This is the failure mode a guard is likeliest to
  // meet on somebody else's machine, and the one it must not read as permission.
  assert.throws(
    () =>
      writeRecord(corpus, fields(), {
        randomId: () => "111111111111",
        spawnSync: () => ({
          error: new Error("spawn git ENOENT"),
          status: null,
          stdout: "",
          stderr: "",
        }),
      }),
    (error) => error.code === "corpus_ignore_status_unknown",
  );
  // A repository git refuses to look at is not a repository that is absent. Both exit non-zero,
  // and only the absent one is safe, so the two are told apart by what git says.
  assert.throws(
    () =>
      writeRecord(corpus, fields(), {
        randomId: () => "222222222222",
        spawnSync: () => ({
          error: undefined,
          status: 128,
          stdout: "",
          stderr: "fatal: detected dubious ownership in repository at '/x'\n",
        }),
      }),
    (error) => error.code === "corpus_ignore_status_unknown",
  );
  // An answer git will not give is a refusal of its own. A guard that failed open on an unreadable
  // repository would pass exactly the case it cannot see.
  assert.throws(
    () =>
      writeRecord(corpus, fields(), {
        randomId: () => "ffffffffffff",
        spawnSync: (_command, args) =>
          args[0] === "rev-parse"
            ? { error: undefined, status: 0, stdout: "true\n", stderr: "" }
            : { error: undefined, status: 128, stdout: "", stderr: "fatal: bad index\n" },
      }),
    (error) => error.code === "corpus_ignore_status_unknown",
  );
});

test("a records directory that links out of the ignored corpus is refused too", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-letter-corrections-symlink-",
  });
  const root = realpathSync(environment.workspaceRoot);
  const layer = join(root, "layer");
  const tracked = join(root, "tracked");
  mkdirSync(join(tracked, "smuggled"), { mode: 0o700, recursive: true });
  mkdirSync(join(layer, "corpus"), { mode: 0o700, recursive: true });
  // The corpus directory is ignored, which the guard allows, while `records/` points back into a
  // directory the repository does not ignore. Resolving only the corpus would let the write
  // through, and the letters would land in the exported tree after all.
  symlinkSync(join(tracked, "smuggled"), join(layer, "corpus", "records"));
  const layerReal = realpathSync(layer);

  assert.throws(
    () =>
      writeRecord(join(layer, "corpus"), fields(), {
        ...seams({ ignored: (path) => path.startsWith(layerReal) }),
        randomId: () => "aaaaaaaaaaaa",
      }),
    (error) => error.code === "corpus_in_public_tree",
  );
  assert.deepEqual(readdirSync(join(tracked, "smuggled")), []);
});

test("the guard reads a real repository through its default wiring", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-letter-corrections-git-",
  });
  const root = realpathSync(environment.workspaceRoot);
  const primary = join(root, "primary");
  mkdirSync(primary, { mode: 0o700 });
  const git = (args, cwd = primary) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_AUTHOR_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
      },
    });
  git(["init", "--initial-branch", "main", "."]);
  mkdirSync(join(primary, "corpus", "records"), { mode: 0o700, recursive: true });
  mkdirSync(join(primary, "public-corpus", "records"), { mode: 0o700, recursive: true });
  writeFileSync(join(primary, ".gitignore"), "/corpus/\n", { mode: 0o600 });
  git(["add", ".gitignore"]);
  git(["commit", "-m", "seed"]);

  // Ignored by a rule this repository really carries: no seam involved, and the write goes through.
  assert.doesNotThrow(() =>
    writeRecord(join(primary, "corpus"), fields(), {
      randomId: () => "eeeeeeeeeeee",
    }),
  );

  // The same repository, one directory over, with no rule covering it.
  assert.throws(
    () =>
      writeRecord(join(primary, "public-corpus"), fields(), {
        randomId: () => "ffffffffffff",
      }),
    (error) => error.code === "corpus_in_public_tree",
  );

  // The branch that grants permission, witnessed by real git rather than by a mock. It turns on
  // the wording of git's own message, so a mock is the one oracle that cannot confirm it: the
  // mock says what this file says. A corpus outside every checkout is the case, and the
  // disposable root is already outside one.
  const loose = join(root, "loose-corpus");
  mkdirSync(join(loose, "records"), { mode: 0o700, recursive: true });
  assert.doesNotThrow(() => writeRecord(loose, fields(), { randomId: () => "aaaabbbbcccc" }));
});

test("the CLI takes the fragments and the reason only from the envelope", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-letter-corrections-cli-",
  });
  const workspaceRoot = realpathSync(environment.workspaceRoot);
  const corpus = runRootIn(workspaceRoot);
  const inputRoot = inputRootIn(workspaceRoot);
  t.after(() => {
    delete process.env.JOB_PIPELINE_INPUT_ROOT;
  });
  process.env.JOB_PIPELINE_INPUT_ROOT = inputRoot;

  const basename = writeEnvelope(inputRoot, { ...ENVELOPE });
  const { result, stdout } = silently(() =>
    main(recordArgs(basename, ["--class", "class-5", "--class", "class-6"]), {
      ...seams(undefined, workspaceRoot),
      randomId: () => "0123456789ab",
    }),
  );
  assert.equal(result, 0);
  const reported = JSON.parse(stdout);
  assert.equal(reported.recordId, "lc_0123456789ab");
  assert.deepEqual(reported.classes, ["class-5", "class-6"]);
  // The reported summary carries identifiers and codes, never the letter or the user's words.
  assert.doesNotMatch(stdout, /кошелёк/u);

  const written = JSON.parse(readFileSync(reported.path, "utf8"));
  assert.equal(written.fragment_before, ENVELOPE.fragmentBefore);
  assert.equal(written.fragment_after, ENVELOPE.fragmentAfter);
  assert.equal(written.user_reason, ENVELOPE.userReason);
  assert.equal(written.company_role, ENVELOPE.companyRole);
});

test("the CLI refuses a malformed envelope, a wrong code and a contradictory reason", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-letter-corrections-refusals-",
  });
  const workspaceRoot = realpathSync(environment.workspaceRoot);
  const corpus = runRootIn(workspaceRoot);
  const inputRoot = inputRootIn(workspaceRoot);
  t.after(() => {
    delete process.env.JOB_PIPELINE_INPUT_ROOT;
  });
  process.env.JOB_PIPELINE_INPUT_ROOT = inputRoot;

  const refuse = (argv, code) => {
    assert.throws(
      () => silently(() => main(argv, seams(undefined, workspaceRoot))),
      (error) => error.code === code,
      `${code}: ${argv.join(" ")}`,
    );
  };

  // The envelope's own shape.
  const missingSide = writeEnvelope(inputRoot, {
    companyRole: "role",
    fragmentBefore: "до",
  });
  refuse(recordArgs(missingSide, ["--reason-absent", "not_given"]), "safe_input_schema_mismatch");
  const strayKey = writeEnvelope(inputRoot, { ...ENVELOPE, teach: "true" });
  refuse(recordArgs(strayKey), "safe_input_schema_mismatch");

  // Exactly one of the two ways a record can answer "why".
  const withReason = writeEnvelope(inputRoot, { ...ENVELOPE });
  refuse(recordArgs(withReason, ["--reason-absent", "in_place_edit"]), "invalid_cli_arguments");
  const withoutReason = writeEnvelope(inputRoot, {
    companyRole: ENVELOPE.companyRole,
    fragmentAfter: ENVELOPE.fragmentAfter,
    fragmentBefore: ENVELOPE.fragmentBefore,
  });
  refuse(recordArgs(withoutReason), "invalid_cli_arguments");

  // Bounded codes and numbers, each rejected on its own flag.
  for (const override of [
    ["--channel", "editor"],
    ["--language", "Ελληνικά"],
    ["--after-state", "kept"],
    ["--class", "class-99"],
    ["--origin", "guess"],
    ["--before-index", "-1"],
  ]) {
    const basename = writeEnvelope(inputRoot, { ...ENVELOPE });
    const argv = recordArgs(basename).filter(
      (value, index, all) => value !== override[0] && all[index - 1] !== override[0],
    );
    refuse([...argv, ...override], "invalid_cli_arguments");
  }

  // `not_published` and a publication id are the same statement twice, so they may not disagree.
  const disagree = writeEnvelope(inputRoot, { ...ENVELOPE });
  refuse(
    recordArgs(disagree).map((value) => (value === "published" ? "not_published" : value)),
    "invalid_cli_arguments",
  );
  assert.equal(existsSync(corpus), false, "no refusal wrote a record or created the corpus");
});

test("every refusal leaves stable JSON on stderr and exit code 1", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-letter-corrections-exit-",
  });
  const workspaceRoot = realpathSync(environment.workspaceRoot);
  const result = spawnSync(process.execPath, [cliPath, "record", "--input-file"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const reported = JSON.parse(result.stderr);
  assert.equal(reported.error, "invalid_cli_arguments");
  assert.equal(typeof reported.message, "string");
  // A diagnostic a model reads carries no stack and no path.
  assert.doesNotMatch(result.stderr, /at Object|\/Users\//u);
});

test("the summary counts corrections per letter, classes and the reader's share", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-letter-corrections-summary-",
  });
  const root = realpathSync(environment.workspaceRoot);
  const corpus = corpusIn(root);
  const write = (overrides, id) =>
    writeRecord(corpus, fields(overrides), {
      ...seams(),
      randomId: () => id,
    });

  write({ processId: "proc_a", classes: ["class-6"] }, "a00000000000");
  write({ processId: "proc_a", classes: ["class-1", "class-6"] }, "a00000000001");
  write({ processId: "proc_a", channel: "manual_file", classes: [] }, "a00000000002");
  write({ processId: "proc_b", channel: "manual_file", classes: [] }, "b00000000000");

  const summary = summarize(readCorpus(corpus));
  assert.equal(summary.records, 4);
  assert.equal(summary.letters, 2);
  assert.deepEqual(
    summary.perLetter.map((letter) => [letter.processId, letter.corrections]),
    [
      ["proc_a", 3],
      ["proc_b", 1],
    ],
  );
  assert.deepEqual(summary.inPlacePerLetter, { total: 2, mean: 1 });
  assert.deepEqual(summary.correctionsPerLetter, { total: 4, mean: 2 });
  // A record in two classes counts in both, and the unclassified ones are counted as such rather
  // than silently dropped.
  assert.deepEqual(summary.byClass, { "class-1": 1, "class-6": 2, unclassified: 2 });
  // Null, not zero: nothing has been read yet, which is a different answer from "nothing flagged".
  assert.deepEqual(summary.readerVerdict, { filled: 0, flagged: 0, flaggedShare: null });

  const records = readCorpus(corpus);
  const patched = { ...records[0], reader_verdict: "flagged" };
  writeFileSync(
    join(corpus, "records", `${patched.record_id}.json`),
    `${JSON.stringify(patched, null, 2)}\n`,
    { mode: 0o600 },
  );
  const patchedRecords = readCorpus(corpus);
  writeFileSync(
    join(corpus, "records", `${patchedRecords[1].record_id}.json`),
    `${JSON.stringify({ ...patchedRecords[1], reader_verdict: "missed" }, null, 2)}\n`,
    { mode: 0o600 },
  );
  assert.deepEqual(summarize(readCorpus(corpus)).readerVerdict, {
    filled: 2,
    flagged: 1,
    flaggedShare: 0.5,
  });
});

test("the summary refuses a broken record and names its file", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-letter-corrections-broken-",
  });
  const root = realpathSync(environment.workspaceRoot);
  const corpus = corpusIn(root);
  writeRecord(corpus, fields(), { ...seams(), randomId: () => "a00000000000" });
  writeFileSync(join(corpus, "records", "lc_b00000000000.json"), "{\n", { mode: 0o600 });

  assert.throws(
    () => readCorpus(corpus),
    (error) =>
      error.code === "corpus_record_invalid" && error.message.includes("lc_b00000000000.json"),
  );
});

test("the class codes and the refusal codes match the README, in both directions", () => {
  // The live corpus is a run artifact in `records/letter-corrections/` of the run root, and the
  // retrospective that named these eleven classes lives in the candidate layer, so the report can
  // no longer be the oracle: the suite may not read the operator's own layer. The definitions came
  // into the public README instead, and the two lists are frozen against each other here - a code
  // without a line, or a line without a code, is a defect either way round.
  const readme = readFileSync(join(repoRoot, "tools/letter-corrections/README.md"), "utf8");
  const documented = [...readme.matchAll(/^\| `(class-\d+)` \| /gmu)].map((match) => match[1]);
  assert.equal(documented.length, 11);
  assert.deepEqual([...CLASS_CODES].sort(), [...documented].sort());

  // The refusal codes are read out of the section that claims to list them, not out of the whole
  // document: a code mentioned once in prose would otherwise satisfy a pin about the list.
  // The oracle is the module's own frozen list, not a second copy kept in this file: a refusal
  // added to the code and left undocumented is a code an operator meets with nothing to read.
  const section = readme.match(/\n## Refusal codes\n([\s\S]*)$/u)?.[1] ?? "";
  const listed = [...section.matchAll(/`(corpus_[a-z_]+)`/gu)].map((match) => match[1]);
  assert.deepEqual([...listed].sort(), [...CORPUS_ERROR_CODES].sort());
  // The code this task retired must not survive anywhere: a README still promising it would send
  // a reader looking for a refusal the tool can no longer produce.
  assert.doesNotMatch(readme, /corpus_in_primary_worktree/u);
});

test("every record of the tracked example still validates", () => {
  // The corpus is hand-editable by design - the user sets `teach`, task 144 writes the verdict -
  // so the example files are read here with the same validator a fresh record goes through.
  // The real corpus is no longer readable from a gate: it lives in the candidate layer, which the
  // suite never reads, and a broken hand edit there shows up only in a summary run by hand.
  const records = readCorpus(join(repoRoot, "tools/letter-corrections/fixtures/example-corpus"));
  assert.equal(records.length, 4);
  // The README states the count in words, and a fifth record added without touching that sentence
  // would leave a public document quietly wrong. The sentence is compared with the directory, not
  // with a number repeated here: a pin between two literals an author edits together proves only
  // that the author was consistent.
  const counted = readFileSync(join(repoRoot, "tools/letter-corrections/README.md"), "utf8").match(
    /`fixtures\/example-corpus\/`, holds (\w+) fictional records/u,
  )?.[1];
  assert.equal(counted, ["no", "one", "two", "three", "four", "five", "six"][records.length]);
  for (const record of records) validateRecord(record, record.record_id);
  // A migrated record names the log it was read out of, and that log is in the candidate layer
  // now. Nothing here asserts a value of `teach` or `reader_verdict`: those two are the fields the
  // user and task 144 are meant to change, and pinning them would make a legitimate edit of the
  // data turn this suite red.
  const migrated = records.filter((entry) => entry.origin === "retrospective-2026-09");
  assert.equal(migrated.length, 1);
  for (const record of migrated) {
    assert.match(
      record.source_ref,
      /^candidate\/research\/letter-revisions-2026-09\//u,
      record.record_id,
    );
  }
  assert.equal(new Set(records.map((record) => record.record_id)).size, records.length);

  // The example is also the only worked instance of the record shapes the README describes, so
  // every shape it documents has to stand behind one. A form documented with no example is a
  // sentence a reader cannot check. The letter's language is the one exception, deliberately: the
  // enum it draws on is being replaced by a configured language pack, and an example leaning on
  // today's values would have to be rewritten by that work.
  const values = (key) => [...new Set(records.map((record) => record[key]))].sort();
  assert.deepEqual(values("channel"), ["chat_command", "manual_file"]);
  assert.deepEqual(values("origin"), ["retrospective-2026-09", "revision"]);
  assert.deepEqual(values("after_state"), ["not_published", "published"]);
  assert.deepEqual(values("user_reason_absent"), ["in_place_edit", "not_given", null]);
  assert.deepEqual(values("reader_verdict"), ["flagged", "missed", null]);
  assert.deepEqual(values("teach"), [false, true]);
  // The author's own publication is index 0, which the README names and no record used to show.
  assert.deepEqual(values("before_index"), [0, 1, 2]);
  // Both edges the README calls normal: no class at all, and two classes on one record.
  assert.deepEqual([...new Set(records.map((record) => record.classes.length))].sort(), [0, 1, 2]);
  // An empty "after" side is the README's way of saying the fragment was cut, and it is the one
  // shape a careless validator would reject as a missing field.
  assert.equal(records.filter((record) => record.fragment_after === "").length, 1);
});

test("a colliding record identifier is refused by its own code, not as an unknown failure", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-letter-corrections-collision-",
  });
  const root = realpathSync(environment.workspaceRoot);
  const corpus = corpusIn(root);
  const always = { ...seams(), randomId: () => "cccccccccccc" };
  writeRecord(corpus, fields(), always);
  assert.throws(
    () => writeRecord(corpus, fields({ fragmentAfter: "другое" }), always),
    (error) => error.code === "corpus_record_exists",
  );
  // The first record is untouched: a collision must never overwrite a correction.
  assert.equal(
    JSON.parse(readFileSync(join(corpus, "records", "lc_cccccccccccc.json"), "utf8"))
      .fragment_after,
    "после",
  );
});

test("the summary command prints the counts, and refuses what it cannot read", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-letter-corrections-summary-cli-",
  });
  const root = realpathSync(environment.workspaceRoot);
  const corpus = corpusIn(root);
  writeRecord(corpus, fields(), { ...seams(), randomId: () => "a00000000000" });
  writeRecord(
    corpus,
    fields({ channel: "manual_file", userReason: null, userReasonAbsent: "in_place_edit" }),
    {
      ...seams(),
      randomId: () => "b00000000000",
    },
  );

  const { result, stdout } = silently(() => main(["summary", "--corpus", corpus]));
  assert.equal(result, 0);
  const printed = JSON.parse(stdout);
  assert.equal(printed.records, 2);
  assert.equal(printed.inPlacePerLetter.total, 1);
  assert.equal(printed.readerVerdict.flaggedShare, null);
  // The command prints counts and identifiers, never a fragment or the user's words.
  assert.doesNotMatch(stdout, /не нравится|после/u);

  assert.throws(
    () => silently(() => main(["summary", "--corpus", corpus, "--class", "class-6"])),
    (error) => error.code === "invalid_cli_arguments",
  );
  assert.throws(
    () => silently(() => main(["summary", "--corpus", join(root, "nowhere")])),
    (error) => error.code === "corpus_missing",
  );
});

test("a refusal raised deep in the run still leaves stable JSON and exit code 1", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-letter-corrections-exit-deep-",
  });
  const root = realpathSync(environment.workspaceRoot);
  const corpus = runRootIn(root);
  // No envelope was produced, so the transport refuses - the case that travels through
  // SafeCliInputError rather than through this CLI's own error class.
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "record",
      "--input-file",
      "input-00000000000000000000000000000000.json",
      "--process-id",
      "proc_a",
      "--publication-before",
      "pub_a",
      "--publication-after",
      "pub_b",
      "--after-state",
      "published",
      "--before-index",
      "0",
      "--channel",
      "chat_command",
      "--language",
      "English",
      "--occurred-on",
      "2026-09-11",
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, JOB_PIPELINE_WORKSPACE_ROOT: root } },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const reported = JSON.parse(result.stderr);
  assert.match(reported.error, /^safe_input_/u);
  assert.doesNotMatch(result.stderr, /at Object|\/Users\//u);
  assert.equal(existsSync(corpus), false);
});

test("a record is written only in a run root, beside the process log", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-letter-corrections-run-root-",
  });
  const workspaceRoot = realpathSync(environment.workspaceRoot);
  const inputRoot = inputRootIn(workspaceRoot);
  t.after(() => {
    delete process.env.JOB_PIPELINE_INPUT_ROOT;
  });
  process.env.JOB_PIPELINE_INPUT_ROOT = inputRoot;
  const corpus = join(workspaceRoot, "records", "letter-corrections");

  // No process log: this is what a development clone looks like, and the refusal comes before the
  // layer is read — the broken config below would otherwise be the reason given.
  mkdirSync(join(workspaceRoot, "candidate"), { mode: 0o700 });
  writeFileSync(join(workspaceRoot, "candidate", "config.json"), "{ broken\n", { mode: 0o600 });
  const refused = writeEnvelope(inputRoot, { ...ENVELOPE });
  assert.throws(
    () => silently(() => mainWith(recordArgs(refused), { ...seams(undefined, workspaceRoot) })),
    (error) => error.code === "corpus_no_run_root",
  );
  assert.equal(existsSync(join(workspaceRoot, "records")), false, "nothing was created");
  // A directory named after the ledger is not a ledger.
  mkdirSync(join(workspaceRoot, "process-log.json"));
  assert.throws(
    () => silently(() => mainWith(recordArgs(refused), { ...seams(undefined, workspaceRoot) })),
    (error) => error.code === "corpus_no_run_root",
  );
  assert.equal(existsSync(join(workspaceRoot, "records")), false);

  // The corpus is no longer the caller's to name.
  const other = join(workspaceRoot, "elsewhere");
  assert.throws(
    () =>
      silently(() =>
        main(["record", "--corpus", other, ...recordArgs(refused).slice(1)], {
          ...seams(undefined, workspaceRoot),
        }),
      ),
    (error) => error.code === "invalid_cli_arguments" && /--corpus/u.test(error.message),
  );
  assert.equal(existsSync(other), false);

  // With the ledger in place the first record creates the run's corpus directory.
  mkdirSync(join(workspaceRoot, "run"), { mode: 0o700 });
  const run = realpathSync(join(workspaceRoot, "run"));
  const runCorpus = runRootIn(run);
  const basename = writeEnvelope(inputRoot, { ...ENVELOPE });
  const { result, stdout } = silently(() =>
    main(recordArgs(basename), {
      ...seams(undefined, run),
      randomId: () => "0000aaaa1111",
    }),
  );
  assert.equal(result, 0);
  assert.equal(JSON.parse(stdout).path, join(runCorpus, "records", "lc_0000aaaa1111.json"));
  assert.deepEqual(readdirSync(join(runCorpus, "records")), ["lc_0000aaaa1111.json"]);
  assert.equal(existsSync(corpus), false, "the first workspace still has no corpus");
});

test("the workspace is the isolation variable's, or else the command's own checkout", () => {
  assert.equal(workspaceRootFor("/checkout", {}), "/checkout");
  assert.equal(
    workspaceRootFor("/checkout", { JOB_PIPELINE_WORKSPACE_ROOT: "/run/./root" }),
    "/run/root",
  );
});

test("the run's records/ is written where the engine ignores it and refused where it is tracked", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-letter-corrections-records-git-",
  });
  const root = realpathSync(environment.workspaceRoot);
  const inputRoot = inputRootIn(root);
  t.after(() => {
    delete process.env.JOB_PIPELINE_INPUT_ROOT;
  });
  process.env.JOB_PIPELINE_INPUT_ROOT = inputRoot;
  const checkout = (name, { ignore }) => {
    const path = join(root, name);
    mkdirSync(path, { mode: 0o700 });
    const git = (...args) =>
      execFileSync("git", args, { cwd: path, encoding: "utf8", env: gitIdentity() });
    git("init", "--quiet", "--initial-branch", "main", ".");
    writeFileSync(
      join(path, ".gitignore"),
      ignore ? "/process-log.json\n/records/\n" : "/process-log.json\n",
    );
    runRootIn(path);
    if (!ignore) {
      // A checkout that tracks the directory: the case an export would ship.
      mkdirSync(join(path, "records", "letter-corrections", "records"), { recursive: true });
      writeFileSync(join(path, "records", "letter-corrections", "records", ".keep"), "");
    }
    git("add", "--all");
    git("commit", "--quiet", "-m", "seed");
    return path;
  };
  const record = (workspaceRoot, id) =>
    silently(() =>
      main(recordArgs(writeEnvelope(inputRoot, { ...ENVELOPE })), {
        randomId: () => id,
        workspaceRoot,
      }),
    );

  // Real git, no seam: the engine's own rule is what lets the write through.
  const ignoring = checkout("ignoring", { ignore: true });
  assert.equal(record(ignoring, "1111aaaa2222").result, 0);
  assert.deepEqual(readdirSync(join(ignoring, "records", "letter-corrections", "records")), [
    "lc_1111aaaa2222.json",
  ]);
  const tracking = checkout("tracking", { ignore: false });
  assert.throws(
    () => record(tracking, "3333aaaa4444"),
    (error) => error.code === "corpus_in_public_tree",
  );
  assert.deepEqual(readdirSync(join(tracking, "records", "letter-corrections", "records")), [
    ".keep",
  ]);

  // And the engine carries the rule itself.
  assert.match(readFileSync(join(repoRoot, ".gitignore"), "utf8"), /^\/records\/$/mu);
});

test("a record file must be named after its record_id", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-letter-corrections-misnamed-",
  });
  const corpus = corpusIn(realpathSync(environment.workspaceRoot));
  const { path } = writeRecord(corpus, fields(), { ...seams(), randomId: () => "a00000000000" });
  writeFileSync(join(corpus, "records", "lc_b00000000000.json"), readFileSync(path));
  assert.throws(
    () => readCorpus(corpus),
    (error) =>
      error.code === "corpus_record_invalid" &&
      error.message.includes("lc_b00000000000.json") &&
      /named after its record_id/u.test(error.message),
  );
});

function gitIdentity() {
  return {
    ...process.env,
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_AUTHOR_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/**
 * The import runs git through the board's helper, which reads the process environment, so a case
 * sets a throwaway identity there and puts the previous values back after.
 */
function isolateGit(t, root) {
  const config = join(root, "gitconfig");
  writeFileSync(
    config,
    [
      "[user]",
      "\tname = Records Probe",
      "\temail = probe@example.invalid",
      "[init]",
      "\tdefaultBranch = main",
      "[commit]",
      "\tgpgsign = false",
      "",
    ].join("\n"),
  );
  const saved = {};
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) saved[key] = process.env[key];
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return (cwd, ...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };
}

/** A run root holding a corpus of the given records, written as step 5 writes them. */
function opsRootWith(root, ids) {
  const opsRoot = join(root, "ops");
  mkdirSync(opsRoot, { mode: 0o700 });
  const corpus = runRootIn(opsRoot);
  mkdirSync(corpus, { recursive: true });
  for (const id of ids) {
    writeRecord(corpus, fields({ processId: `proc_${id}` }), { ...seams(), randomId: () => id });
  }
  return { corpus, opsRoot };
}

/** The private repository: the example layer (so Greek is a letter language), committed. */
function privateRepository(root, git, { commit = true } = {}) {
  const candidate = join(root, "private");
  cpSync(candidateExampleRootFor(repoRoot), candidate, { recursive: true });
  git(candidate, "init", "--quiet", "--initial-branch", "main", ".");
  if (commit) {
    git(candidate, "add", "--all");
    git(candidate, "commit", "--quiet", "-m", "layer");
  }
  return candidate;
}

/** The private repository pushed to a bare remote, and a clone of it that tracks the remote. */
function clonedPrivateRepository(root, git) {
  const seed = privateRepository(root, git);
  const remote = join(root, "remote.git");
  git(root, "init", "--quiet", "--bare", "--initial-branch", "main", remote);
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "--quiet", "--set-upstream", "origin", "main");
  const candidate = join(root, "clone");
  git(root, "clone", "--quiet", remote, candidate);
  return { candidate, remote };
}

function snapshot(directory) {
  return existsSync(directory)
    ? Object.fromEntries(
        readdirSync(directory)
          .sort()
          .map((name) => [name, readFileSync(join(directory, name), "utf8")]),
      )
    : {};
}

test("records:import carries overlapping sets into the private repository without a duplicate or a loss", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-records-import-",
  });
  const root = realpathSync(environment.workspaceRoot);
  const git = isolateGit(t, root);
  const { corpus: runCorpus, opsRoot } = opsRootWith(root, [
    "a00000000001",
    "a00000000002",
    "a00000000003",
    "a00000000004",
  ]);
  const candidate = privateRepository(root, git);
  const target = join(candidate, "research", "letter-corrections", "records");
  const source = join(runCorpus, "records");

  // The copy already holds one record as the run wrote it, one with `teach` set by the user, and
  // one the run no longer has — an earlier folder's, say.
  mkdirSync(target, { recursive: true });
  cpSync(join(source, "lc_a00000000001.json"), join(target, "lc_a00000000001.json"));
  const taught = JSON.parse(readFileSync(join(source, "lc_a00000000002.json"), "utf8"));
  taught.teach = true;
  const taughtText = `${JSON.stringify(taught, null, 2)}\n`;
  writeFileSync(join(target, "lc_a00000000002.json"), taughtText);
  const older = join(root, "older");
  mkdirSync(join(older, "records"), { recursive: true });
  writeRecord(older, fields({ processId: "proc_old" }), {
    ...seams(),
    randomId: () => "b00000000009",
  });
  cpSync(join(older, "records", "lc_b00000000009.json"), join(target, "lc_b00000000009.json"));
  git(candidate, "add", "--all");
  git(candidate, "commit", "--quiet", "-m", "earlier copy");
  // Another session's work in progress, staged in the same clone.
  writeFileSync(join(candidate, "notes.md"), "draft\n");
  git(candidate, "add", "notes.md");
  const sourceBefore = snapshot(source);
  const headBefore = git(candidate, "rev-parse", "HEAD").trim();

  const result = importRecords({ candidateRoot: candidate, opsRoot });
  assert.deepEqual(
    { ...result, commit: typeof result.commit },
    {
      already_present: 1,
      commit: "string",
      committed: 2,
      imported: 2,
      kept_differing: ["lc_a00000000002"],
      pushed: null,
      source_records: 4,
      status: "imported",
      unpushed: null,
    },
  );

  // The union, once each; every record of the run is there, and the user's edit won.
  const after = snapshot(target);
  assert.deepEqual(Object.keys(after), [
    "lc_a00000000001.json",
    "lc_a00000000002.json",
    "lc_a00000000003.json",
    "lc_a00000000004.json",
    "lc_b00000000009.json",
  ]);
  for (const name of ["lc_a00000000001.json", "lc_a00000000003.json", "lc_a00000000004.json"]) {
    assert.equal(after[name], sourceBefore[name], `${name} is the run's bytes`);
  }
  assert.equal(after["lc_a00000000002.json"], taughtText);
  const ids = readCorpus(join(candidate, "research", "letter-corrections")).map(
    (record) => record.record_id,
  );
  assert.equal(new Set(ids).size, ids.length);

  // One commit, exactly the two new files; the other session's file is still staged, not committed.
  assert.equal(git(candidate, "rev-parse", "HEAD~1").trim(), headBefore);
  assert.deepEqual(git(candidate, "show", "--name-only", "--format=", "HEAD").trim().split("\n"), [
    "research/letter-corrections/records/lc_a00000000003.json",
    "research/letter-corrections/records/lc_a00000000004.json",
  ]);
  assert.equal(git(candidate, "diff", "--cached", "--name-only").trim(), "notes.md");
  // The run's records are a run artifact and stay where they are.
  assert.deepEqual(snapshot(source), sourceBefore);

  // Again: nothing new, no commit.
  const head = git(candidate, "rev-parse", "HEAD").trim();
  const again = importRecords({ candidateRoot: candidate, opsRoot });
  assert.equal(again.imported, 0);
  assert.equal(again.committed, 0);
  assert.equal(again.commit, null);
  assert.equal(again.already_present, 3);
  assert.equal(git(candidate, "rev-parse", "HEAD").trim(), head);
});

test("records:import commits what an interrupted run copied, and starts a corpus the copy lacks", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-records-import-first-",
  });
  const root = realpathSync(environment.workspaceRoot);
  const git = isolateGit(t, root);
  const { corpus: runCorpus, opsRoot } = opsRootWith(root, ["c00000000001", "c00000000002"]);
  // A repository with no commit at all and no research directory: the first import of all.
  const candidate = privateRepository(root, git, { commit: false });
  const target = join(candidate, "research", "letter-corrections", "records");
  // An interrupted run left one record copied and never committed.
  mkdirSync(target, { recursive: true });
  cpSync(join(runCorpus, "records", "lc_c00000000001.json"), join(target, "lc_c00000000001.json"));

  const result = importRecords({ candidateRoot: candidate, opsRoot });
  assert.equal(result.imported, 1);
  assert.equal(result.already_present, 1);
  assert.equal(result.committed, 2);
  assert.deepEqual(git(candidate, "show", "--name-only", "--format=", "HEAD").trim().split("\n"), [
    "research/letter-corrections/records/lc_c00000000001.json",
    "research/letter-corrections/records/lc_c00000000002.json",
  ]);
  assert.deepEqual(readdirSync(target), ["lc_c00000000001.json", "lc_c00000000002.json"]);
});

test("records:import writes nothing when either side holds a broken record", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-records-import-broken-",
  });
  const root = realpathSync(environment.workspaceRoot);
  const git = isolateGit(t, root);
  const { corpus: runCorpus, opsRoot } = opsRootWith(root, ["d00000000001", "d00000000002"]);
  const candidate = privateRepository(root, git);
  const target = join(candidate, "research", "letter-corrections", "records");
  const head = git(candidate, "rev-parse", "HEAD").trim();

  writeFileSync(join(runCorpus, "records", "lc_d00000000003.json"), "{\n");
  assert.throws(
    () => importRecords({ candidateRoot: candidate, opsRoot }),
    (error) =>
      error.code === "corpus_record_invalid" && error.message.includes("lc_d00000000003.json"),
  );
  assert.equal(existsSync(target), false);
  rmSync(join(runCorpus, "records", "lc_d00000000003.json"));

  // A truncated copy on the private side is refused by name, not kept as a differing record.
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "lc_d00000000001.json"), '{\n  "schemaVersion": 1,\n');
  assert.throws(
    () => importRecords({ candidateRoot: candidate, opsRoot }),
    (error) =>
      error.code === "corpus_record_invalid" && error.message.includes("lc_d00000000001.json"),
  );
  assert.deepEqual(readdirSync(target), ["lc_d00000000001.json"]);
  assert.equal(git(candidate, "rev-parse", "HEAD").trim(), head);
});

test("records:import refuses what is not a production run, and a root that is not a clone", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-records-import-refusals-",
  });
  const root = realpathSync(environment.workspaceRoot);
  const git = isolateGit(t, root);
  const { opsRoot } = opsRootWith(root, ["e00000000001"]);
  const candidate = privateRepository(root, git);
  const refuse = (options, code) =>
    assert.throws(
      () => importRecords(options),
      (error) => error.code === code,
      code,
    );

  const noLedger = join(root, "no-ledger");
  mkdirSync(noLedger);
  refuse({ candidateRoot: candidate, opsRoot: noLedger }, "corpus_no_run_root");

  mkdirSync(join(opsRoot, ".rehearsal"));
  refuse({ candidateRoot: candidate, opsRoot }, "records_import_rehearsal_root");
  rmSync(join(opsRoot, ".rehearsal"), { recursive: true });
  writeFileSync(join(opsRoot, "ops-manifest.json"), `${JSON.stringify({ kind: "rehearsal" })}\n`);
  refuse({ candidateRoot: candidate, opsRoot }, "records_import_rehearsal_root");
  writeFileSync(join(opsRoot, "ops-manifest.json"), "{ unreadable\n");
  refuse({ candidateRoot: candidate, opsRoot }, "records_import_rehearsal_root");
  writeFileSync(join(opsRoot, "ops-manifest.json"), `${JSON.stringify({ kind: "operational" })}\n`);

  // A directory inside the clone is not the clone's root, and neither is one outside every clone.
  refuse(
    { candidateRoot: join(candidate, "languages"), opsRoot },
    "records_import_root_not_a_clone",
  );
  refuse({ candidateRoot: join(root, "nowhere"), opsRoot }, "records_import_root_not_a_clone");
  assert.equal(existsSync(join(candidate, "research")), false);

  // A run with no corpus yet has nothing to import, and says so.
  const empty = join(root, "empty-run");
  mkdirSync(empty);
  runRootIn(empty);
  assert.equal(
    importRecords({ candidateRoot: candidate, opsRoot: empty }).status,
    "nothing_to_import",
  );

  // The operational kind passes.
  assert.equal(importRecords({ candidateRoot: candidate, opsRoot }).imported, 1);

  assert.throws(
    () => parseImportArguments([]),
    (error) => error.code === "records_import_invalid_arguments",
  );
  assert.throws(
    () => parseImportArguments(["--ops-root", "relative/path"]),
    (error) => error.code === "records_import_invalid_arguments",
  );
  assert.throws(
    () => parseImportArguments(["--ops-root", "/a", "--ops-root", "/b"]),
    (error) => error.code === "records_import_invalid_arguments",
  );
  const written = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    importMain(["--draft", "x"]);
  } finally {
    process.stderr.write = originalWrite;
    process.exitCode = 0;
  }
  assert.equal(JSON.parse(written.join("")).error.code, "records_import_invalid_arguments");
});

test("records:import pushes to an upstream and takes its commit back when the push is refused", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-records-import-push-",
  });
  const root = realpathSync(environment.workspaceRoot);
  const git = isolateGit(t, root);
  const { opsRoot } = opsRootWith(root, ["f00000000001"]);
  const { candidate, remote } = clonedPrivateRepository(root, git);
  const target = join(candidate, "research", "letter-corrections", "records");

  // A refusing remote: the commit is taken back, the file removed, another session's staged file
  // left staged, and the record is still in the run.
  const hook = join(remote, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(candidate, "notes.md"), "draft\n");
  git(candidate, "add", "notes.md");
  const head = git(candidate, "rev-parse", "HEAD").trim();
  assert.throws(
    () => importRecords({ candidateRoot: candidate, opsRoot }),
    (error) => error.code === "records_import_push_refused",
  );
  assert.equal(git(candidate, "rev-parse", "HEAD").trim(), head);
  assert.equal(existsSync(join(target, "lc_f00000000001.json")), false);
  assert.equal(git(candidate, "diff", "--cached", "--name-only").trim(), "notes.md");

  // The remote accepts again: the same run imports and the commit reaches it.
  rmSync(hook);
  const result = importRecords({ candidateRoot: candidate, opsRoot });
  assert.equal(result.pushed, true);
  assert.deepEqual(result.unpushed, []);
  assert.equal(git(remote, "rev-parse", "main").trim(), result.commit);
});

/**
 * Strand an import commit the way a failed take-back does: the remote refuses the push and, while
 * it does, holds the branch's ref lock in the clone, so the take-back cannot move the branch.
 */
function strandImportCommit(git, { candidate, opsRoot, remote }) {
  const hook = join(remote, "hooks", "pre-receive");
  const lock = join(candidate, ".git", "refs", "heads", "main.lock");
  writeFileSync(hook, `#!/bin/sh\n: > '${lock}'\nexit 1\n`, { mode: 0o755 });
  assert.throws(
    () => importRecords({ candidateRoot: candidate, opsRoot }),
    (error) => error.code === "records_import_git_failed",
  );
  rmSync(lock);
  rmSync(hook);
  const stranded = git(candidate, "rev-parse", "HEAD").trim();
  assert.notEqual(git(remote, "rev-parse", "main").trim(), stranded);
  return stranded;
}

test("records:import pushes an import commit a failed take-back left ahead of the upstream", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-records-import-stranded-",
  });
  const root = realpathSync(environment.workspaceRoot);
  const git = isolateGit(t, root);
  const { opsRoot } = opsRootWith(root, ["f10000000001"]);
  const { candidate, remote } = clonedPrivateRepository(root, git);
  const record = join(
    candidate,
    "research",
    "letter-corrections",
    "records",
    "lc_f10000000001.json",
  );
  const stranded = strandImportCommit(git, { candidate, opsRoot, remote });
  assert.equal(existsSync(record), true);

  // A remote that still refuses: the commit is named and kept — it is not this run's to take back.
  const hook = join(remote, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  assert.throws(
    () => importRecords({ candidateRoot: candidate, opsRoot }),
    // Named by the command itself, not only inside git's quoted output after the parenthesis.
    (error) =>
      error.code === "records_import_push_refused" &&
      error.message.split("(")[0].includes(stranded),
  );
  assert.equal(git(candidate, "rev-parse", "HEAD").trim(), stranded);
  assert.equal(existsSync(record), true);

  // The remote accepts again: the next run pushes the stranded commit with nothing new to commit.
  rmSync(hook);
  const result = importRecords({ candidateRoot: candidate, opsRoot });
  assert.deepEqual(
    {
      committed: result.committed,
      pushed: result.pushed,
      status: result.status,
      unpushed: result.unpushed,
    },
    { committed: 0, pushed: true, status: "imported", unpushed: [] },
  );
  assert.equal(git(remote, "rev-parse", "main").trim(), stranded);

  // The user's own correction of a record, not yet pushed, is not an import commit: left alone.
  const taught = JSON.parse(readFileSync(record, "utf8"));
  taught.teach = true;
  writeFileSync(record, `${JSON.stringify(taught, null, 2)}\n`);
  git(candidate, "commit", "--quiet", "-am", "teach one record");
  const again = importRecords({ candidateRoot: candidate, opsRoot });
  assert.deepEqual(
    { pushed: again.pushed, unpushed: again.unpushed },
    { pushed: null, unpushed: [] },
  );
  assert.equal(git(remote, "rev-parse", "main").trim(), stranded);
});

test("records:import leaves an import commit under another session's commit to that session, and names it", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-records-import-foreign-",
  });
  const root = realpathSync(environment.workspaceRoot);
  const git = isolateGit(t, root);
  const { opsRoot } = opsRootWith(root, ["f20000000001", "f20000000002"]);
  const { candidate, remote } = clonedPrivateRepository(root, git);
  const stranded = strandImportCommit(git, { candidate, opsRoot, remote });
  const upstreamBefore = git(remote, "rev-parse", "main").trim();

  // Another session's commit on top: it sets `teach` on one record and adds a file of its own.
  const recordPath = "research/letter-corrections/records/lc_f20000000001.json";
  const taught = JSON.parse(readFileSync(join(candidate, recordPath), "utf8"));
  taught.teach = true;
  writeFileSync(join(candidate, recordPath), `${JSON.stringify(taught, null, 2)}\n`);
  writeFileSync(join(candidate, "notes.md"), "draft\n");
  git(candidate, "add", recordPath, "notes.md");
  git(candidate, "commit", "--quiet", "-m", "teach one record");

  const result = importRecords({ candidateRoot: candidate, opsRoot });
  assert.equal(result.pushed, null);
  assert.deepEqual(result.unpushed, [stranded]);
  assert.equal(git(remote, "rev-parse", "main").trim(), upstreamBefore);

  // The upstream moves on from another machine: the pull refuses and names the same commit.
  const other = join(root, "other");
  git(root, "clone", "--quiet", remote, other);
  writeFileSync(join(other, "elsewhere.md"), "x\n");
  git(other, "add", "elsewhere.md");
  git(other, "commit", "--quiet", "-m", "elsewhere");
  git(other, "push", "--quiet");
  assert.throws(
    () => importRecords({ candidateRoot: candidate, opsRoot }),
    (error) => error.code === "records_import_pull_refused" && error.message.includes(stranded),
  );
});

test("records:import is not stopped by a temporary file a killed run left behind", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-records-import-leftover-",
  });
  const root = realpathSync(environment.workspaceRoot);
  const git = isolateGit(t, root);
  const { opsRoot } = opsRootWith(root, ["f30000000001"]);
  const candidate = privateRepository(root, git);
  const target = join(candidate, "research", "letter-corrections", "records");
  mkdirSync(target, { recursive: true });
  // The name the previous naming scheme gave this process's temporary file.
  const leftover = `.lc_f30000000001.json.${process.pid}.tmp`;
  writeFileSync(join(target, leftover), "{\n");

  const result = importRecords({ candidateRoot: candidate, opsRoot });
  assert.equal(result.imported, 1);
  assert.deepEqual(readdirSync(target).sort(), [leftover, "lc_f30000000001.json"]);
});

test("the import's refusal codes match the README, in both directions", () => {
  const readme = readFileSync(join(repoRoot, "tools/letter-corrections/README.md"), "utf8");
  const section = readme.match(/\n## Refusal codes\n([\s\S]*)$/u)?.[1] ?? "";
  const listed = [...section.matchAll(/`(records_import_[a-z_]+)`/gu)].map((match) => match[1]);
  assert.deepEqual([...listed].sort(), [...IMPORT_ERROR_CODES].sort());
  // Every code the import source raises by name is in its list.
  const sourceText = readFileSync(join(repoRoot, "tools/letter-corrections/import.mjs"), "utf8");
  const raised = [...sourceText.matchAll(/"(records_import_[a-z_]+)"/gu)].map((match) => match[1]);
  for (const code of new Set(raised)) assert.equal(IMPORT_ERROR_CODES.includes(code), true, code);
});
