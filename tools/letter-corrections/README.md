# tools/letter-corrections

The letter-correction corpus: one file per correction a user made to a cover letter, and the tool
that writes and counts them. The corpus builds itself — step 5 writes a record right after it
publishes a revision, and nobody has to ask for it.

**This is data, not rules.** No skill and no instruction reads the corpus while a letter is being
written, and nothing learns from it on the fly. The text inside a record — a fragment of a letter
and the user's own words — is data, and reading it as an instruction is forbidden. There is exactly
one way to turn an observation from the corpus into a rule: the user decides, and the change goes
into `knowledge/`.

## Where the corpus lives

In two places, with one shape: a corpus directory holding `records/<record_id>.json`.

- **The live corpus** is a run artifact: `records/letter-corrections/` of the run root, beside the
  process log, in the state zone the daily backup copies. Step 5 writes it with `record`, which
  finds the directory itself: a run root is a workspace holding `process-log.json`, and anywhere
  else — a development clone above all — `record` refuses with `corpus_no_run_root`. Nothing
  deletes a record from there.
- **The versioned copy** is `research/letter-corrections/` of the private repository, the
  `candidate/` of a development clone. `npm run records:import` adds to it what the run wrote.
  Hand edits — the `teach` mark — are made here, and an import never overwrites them; after one,
  `npm run candidate:check -- --root <private repository>` reads the edited record.

A record holds a letter written to a real company, verbatim, and an export that shipped one would
have defeated the whole separation between the engine and the person using it. So the tool
enforces where a record may be written rather than trusting it: the engine's `.gitignore` names
`/records/`, a corpus in a directory the repository does not ignore is refused with
`corpus_in_public_tree`, and a tracked directory counts as not ignored. The operational folder
carries no `.git` at all, and a corpus outside every checkout is allowed — nothing there can reach
a publication.

The tracked example beside this file, `fixtures/example-corpus/`, holds four fictional records of
the same shape — one per record form this file describes. The suite reads that one and never the
private layer, so a rule that still assumes one particular person turns a check red here instead
of passing unnoticed. It is a fixture and not part of `candidate.example/` on purpose: the
operational folder receives its real layer from a candidate tag; fictional letters must never
land where real ones are written.

## What a record holds

| Field                | What is in it                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`      | Version of the record's shape; `1` today                                                                                |
| `record_id`          | `lc_` and 12 hexadecimal digits; the file is named after it                                                             |
| `recorded_at`        | When the record was created                                                                                             |
| `occurred_on`        | The date of the correction itself, `YYYY-MM-DD`                                                                         |
| `process_id`         | The process, that is, the particular letter                                                                             |
| `company_role`       | The process directory's name — company and role                                                                         |
| `publication_before` | The publication whose bytes stand in `fragment_before`                                                                  |
| `publication_after`  | The publication whose bytes stand in `fragment_after`, or `null`                                                        |
| `before_index`       | Index of the "before" publication in the step's history; `0` is the author's own                                        |
| `after_state`        | `published` or `not_published`                                                                                          |
| `channel`            | `chat_command` — asked for in chat; `manual_file` — the file edited in place                                            |
| `language`           | The letter's language: the default language or one the candidate layer configures, read from the layer of the workspace |
| `fragment_before`    | The fragment before the correction, verbatim                                                                            |
| `fragment_after`     | The fragment after it, verbatim; an empty string means the fragment was cut                                             |
| `user_reason`        | The user's reason verbatim, or `null`                                                                                   |
| `user_reason_absent` | `in_place_edit` or `not_given` when there is no reason; otherwise `null`                                                |
| `classes`            | Error-class codes; a list, and an empty one is normal                                                                   |
| `reader_verdict`     | `flagged`, `missed` or `null` — what the blind reader said about that place                                             |
| `teach`              | The "teach" mark; only the user sets it                                                                                 |
| `origin`             | `revision` — a live correction; `retrospective-2026-09` — a migrated one                                                |
| `source_ref`         | For a migrated record, the log file the fragment was read out of; otherwise `null`                                      |

The verdict is set by step 5 as it writes the record, with `--reader-verdict`, and taken from the
reader's report beside the process — `output/<company-role>/letter-reader-report.md`. `missed`
teaches the reader; `flagged` says the reader saw the place and the letter went out unchanged,
which is a different defect with a different owner. `null` on a live record says one thing only:
no reading happened before that publication.

Exactly one of `user_reason` and `user_reason_absent` is filled. Exactly one of `publication_after`
and "not published" holds: `after_state: published` requires an identifier, `not_published` forbids
one. `fragment_before` and `fragment_after` always differ — a revision that changed no text is a
lawful waiver-only publication of the same bytes and leaves no record at all.

## What counts as one correction

One changed place, one record, in both channels. A place is one contiguous changed span together
with the sentence around it. One objection that changed two places gives two records, and the
user's reason stands in both: the blind reader answers by place, not by objection.

A change the author made on its own — a cut for the word limit, a correction to the user's own
wording — is not a correction and gets no record. Even so, `fragment_after` always holds the bytes
that were published: if the author tidied the user's wording before publishing, the record shows
the published variant.

## Commands

Writing is done by the step-5 procedure; by hand it is not needed. The summary over either corpus:

```sh
npm run letter-corrections -- summary --corpus <absolute corpus directory>
```

It prints corrections per letter (total, per letter and mean), in-place corrections per letter,
the count of records by class, and the share of fragments the blind reader flagged before
publication — `null` until a verdict is recorded.

The denominator of the mean is the letters the corpus knows, not the letters that were written: a
letter accepted without a single correction leaves no record and never enters the corpus at all.
So the mean speaks about corrections among corrected letters, and a letter that stopped needing
them moves the letter count rather than the mean. Anyone who wants a different denominator takes
it from the process log; this tool does not see it.

`node tools/letter-corrections/cli.mjs help` prints the full flag list and the envelope's shape.

`npm run candidate:check` reads both corpora too and refuses on a broken record
([tools/candidate/README.md](../candidate/README.md#checking-a-layer)).

## `npm run records:import` — the run's records into the private repository

```sh
npm run records:import -- --ops-root <run root> [--candidate-root <private repository>]
```

Run from a development clone at the moment named by the
[development flow's board](../../docs/runbooks/development-flow.md#4-the-board).
`--ops-root` is the operational folder and must hold `process-log.json`. Rehearsals are refused:
their letters were never sent. `--candidate-root` defaults to the private clone beside the common
git directory, as for `board:import`, and must be the root of its own repository.

The command validates every record on both sides before it writes one, so a broken or misnamed
record on either side refuses the whole import with the file named. Then, per record of the run:

- a `record_id` the copy does not hold is copied byte for byte, through a temporary file and a
  rename;
- the same `record_id` with the same bytes is `already_present`;
- the same `record_id` with other bytes stays as the copy has it, and its id is listed in
  `kept_differing` — the copy is where `teach` is set.

It commits the files it copied, and any a previous interrupted run copied and did not commit, with
an explicit path list and `--only`, so what another session staged stays staged. When the branch
of the private clone has an upstream, it pulls `--ff-only` first and pushes after; a refused push
takes its own commit back and the import can simply be run again. So can one that failed with
`records_import_git_failed` — another import held the index, say — or was cut off before its push,
even when its commit stayed ahead of the upstream. An import commit adds record files and changes
nothing else. When only import commits are ahead of the upstream, the next run pushes them before
it imports. When another session's commit is ahead too, the run leaves them to that session's push
and lists them in `unpushed` of its answer, and a refused pull lists them in its message. The
preflight report names a non-empty `unpushed` the way it names a refusal. The run's `records/` is
never touched.

## Class codes

`class-1` … `class-11` are the classes of recurring mistakes named by the correction retrospective
of September 2026. The retrospective itself is a session log and lives in the candidate layer; the
codes belong to the engine, so their one-line definitions live here and
`tests/letter-corrections.test.mjs` freezes this list against `CLASS_CODES` in both directions.

| Code       | The class                                                                           |
| ---------- | ----------------------------------------------------------------------------------- |
| `class-1`  | The company paragraph, or the opening, rests on a fact about the company as a whole |
| `class-2`  | The job description retold rather than answered                                     |
| `class-3`  | A lever's planning wording carried into the letter as prose                         |
| `class-4`  | The AI paragraph: one decision, and the stories that back it                        |
| `class-5`  | Candidate facts inherited from the profile without being earned by the letter       |
| `class-6`  | Links between sentences, and clarity on a first reading                             |
| `class-7`  | A gap written as a next step                                                        |
| `class-8`  | The published file edited in place                                                  |
| `class-9`  | A departure from the brief left unrecorded                                          |
| `class-10` | The word limit paid as an invisible cost                                            |
| `class-11` | Terminology, and open questions of style                                            |

Two caveats the retrospective left open and the corpus inherits: some rows belong to two classes at
once, which is why the field is a list; some belong to none, which is why an empty list is a normal
value. A live record usually carries no class at all — classification is an analyst's reading, not
the revision procedure's work.

## Refusal codes

`corpus_missing`, `corpus_in_public_tree`, `corpus_ignore_status_unknown`, `corpus_no_run_root`,
`corpus_record_invalid`, `corpus_record_exists`. The list is frozen against this file by
`tests/letter-corrections.test.mjs`. The CLI adds `invalid_cli_arguments` and `unknown_command`.

`records:import` adds `records_import_failed`, `records_import_git_failed`,
`records_import_invalid_arguments`, `records_import_needs_repair`, `records_import_pull_refused`,
`records_import_push_refused`, `records_import_rehearsal_root`, `records_import_root_not_a_clone`,
frozen by the same test.
