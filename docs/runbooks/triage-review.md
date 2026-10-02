# Triage ledger and the review of flagged results

Status: **a mandatory part of every `/score-jobs` batch**. A batch does not count as finished until
the ledger is recorded and the groups of flagged results are turned into a list of decisions for
the user.

Owners this runbook does not replace: terminal codes and the Decision Trace —
[job-match-rules.md](../../knowledge/job-match-rules.md); priority classes and work-format
preferences — `candidate/profile.md#3-career-target--priorities` in the candidate layer; the batch
procedure —
[instructions/skills/score-jobs.md](../../instructions/skills/score-jobs.md); the format of
development tasks — the private board README, per
[ADR 0024](../adr/0024-two-repositories-one-snapshot.md).

## 0. What is fixed here (measurements of the 2026-08-18 run)

- All of the run's output (raw pages, normalized inputs, traces, verification) lived in the
  session's scratchpad, while `process-log.json` does not log batch triage by design
  ([pipeline-run.md](../../instructions/pipeline-run.md)). The next batch knew nothing: known
  closed vacancies were fetched again at full price.
- No canon document named the consumer of a MANUAL_REVIEW/flagged result or a deadline. With the
  measured decay of links (3 of 10 closed, one about 22 hours after publication), an unconsumed
  review status is equivalent to a silent rejection.
- The baseline and the id map of the next batch lay in a prompt file in `~/Downloads`.

## 1. Ledger

`triage-ledger.json` belongs to the folder running the batch: the operational folder for
production, or a sealed rehearsal folder for measurement. Rehearsal rows die with that folder
and never move into production ([rehearsal](development-flow.md#10-rehearsal)). The ledger is
untracked operational state, like `process-log.json`; it is created explicitly and never by a read.
The operational folder contains no git repository. Its release changes through
[cutover](ops-cutover.md), which preserves state separately from the exported sources.

```sh
node tools/triage-ledger.mjs init
node tools/triage-ledger.mjs validate
```

The key of a row is `source:job_id` (`linkedin:4418544694`). The source is determined by the
registry `tools/job-sources/registry.mjs`; if the id cannot be read from the URL, the job id is the
normalized URL, so the ledger works for arbitrary links too.

| Field                         | What it holds                                                                                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                         | the normalized spelling of the link (host in lowercase, no fragment, no `utm_*`)                                                                                                                                            |
| `first_seen` / `last_checked` | UTC ISO-8601 instants; `first_seen` never moves, `last_checked` only moves forward                                                                                                                                          |
| `status`                      | `open` / `closed` / `expired` — what the batch observed on the day it looked; `closed` and `expired` are terminal — such links are not fetched again. A batch does not write `expired`; a row carrying it reads as terminal |
| `batch_id`, `policy_id`       | the batch that wrote the row, and the policy id the decision was obtained under                                                                                                                                             |
| `decision`                    | the run's terminal code (`EVALUATED`, `SKIP`, `MANUAL_REVIEW`, `BLOCKED`) — stored as an opaque string                                                                                                                      |
| `flags`                       | reasons and gap annotations, each an opaque string                                                                                                                                                                          |
| `priority_class`              | 1/2/3 as `tools/pretriage/composition.mjs#priorityClassForLedger` computes it ([pre-triage](#21-pre-triage-freshness-order-composition)); `1` puts the group first in the review report                                     |
| `title`, `company`            | for the readability of the review report                                                                                                                                                                                    |

What happens when the same vacancy is recorded again:

- **vacancy-scoped facts** (`title`, `company`, `priority_class`) are not removed by a batch that
  did not observe them: a failed fetch must not silently drop priority-1 and with it the place in
  the report. An observed value always overrides the old one.
- **decision-scoped fields** (`status`, `decision`, `flags`, `batch_id`, `policy_id`) are always the
  new observation. So an old `policy_id` never ends up attached to a fresh decision.
- `first_seen` does not move forward, `last_checked` does not move back — a replay in any order does
  not rewrite history.
- `batch_id` describes exactly one batch: recording **the same** batch again is allowed (it is a
  retry after a failure with an unknown outcome), while recording **different** content under the
  same id is rejected with `triage_ledger_batch_id_reused`. The check goes by the `entries_digest`
  in the batch's record and does not depend on the order of the entries. "Different content" is any
  difference, including a corrected `title`: a correction is a new observation, and it is recorded
  under its own `batch_id` (for example `<original>-fix1`) rather than replacing the earlier record
  of the batch. Such a batch is a repeated run with its own fetch, captures and traces: it fetches a
  `skip_known` row only at the user's request for a re-check, and a terminal one not at all, so the
  `title` of a terminal row is not corrected through `recordBatch`.
- **One record per published trace.** A link the batch did not process — skipped by the plan, or a
  second spelling — gets no record, and its row stays as the observing batch left it:
  `last_checked` and `batch_id` do not move.

Two rules about the content:

- **`flags`** — the `review_reason` of MANUAL_REVIEW, the `blocker_code` of BLOCKED and the trace's
  `gap:` annotations (`data_gaps`). `assumption:` tokens (`assumptions`) are not written into flags:
  class C under [the rubric's decision
  record](../../knowledge/job-match-rules.md#22-accepted-triage-decision-record). The reason for a
  SKIP already made lives in `decision` and in the run's trace, not in flags: a closed vacancy asks
  the user no questions. Policy v2 makes no exception to this rule: the counter
  `skip_basis: west_relocation_authorization_silent` goes into the batch's summary, not into flags.
- **The strings are opaque to the tool.** The vocabulary belongs to the rubric; the ledger accepts
  `relocation_floor_missing` (policy v1) and `gap:compensation_absent` (policy v2) alike, which is
  why the switch to policy v2 went through without a ledger migration.

The ledger is a baseline and a dedup index, not a store of traces. Traces, inputs and captures live
in the batch store — [the section on the batch store](#11-batch-store-the-history-beside-the-index)
owns its location and life cycle.

### Writes are in-process only

The mutating calls are a module API, exactly like the call of the pure scorer in the skill:

- `tools/lib/triage-ledger-core.mjs#recordBatch` — the write at the end of a batch;
- `tools/lib/triage-ledger-core.mjs#planBatch` — the plan at the start of a batch.

Vacancy values never reach argv in any scenario: there is no shell on this path, so there is
nothing to escape — the strongest form of the boundary of
[ADR 0011](../adr/0011-untrusted-input-safe-cli-transport.md). The CLI `tools/triage-ledger.mjs` is
read-only plus `init`, and it accepts only machine tokens (`--as-of`, `--compact`). If a mutation
from a shell is ever needed, it goes through the shared transport
`--input-file input-<32-hex>.json` and no other way.

The executor script is written with a file tool and contains no interpolation (the same rule as for
the scorer):

```js
// scratchpad/record-batch.mjs — run as `node record-batch.mjs`
import { readFileSync } from "node:fs";
import { recordBatch } from "<repo>/tools/lib/triage-ledger-core.mjs";

const batch = JSON.parse(readFileSync(new URL("./batch.json", import.meta.url), "utf8"));
console.log(recordBatch(
  "<operational-checkout>/triage-ledger.json",
  batch,
  { artifactsDir: "<operational-checkout>/triage-batches/<batch_id>" },
));
```

`observed_at` is the time the batch actually observed (when the pages were fetched), not "now": the
core does not read the clock itself, so repeating the write of the same batch gives a
byte-identical ledger.

### The write comes after verification

A batch is recorded in the ledger only after the per-batch set of `tools/triage-verify/` returned
`pass` on its artifacts — the order and the reason are owned by
[where verification sits in a batch](triage-verification.md#1-where-verification-sits-in-a-batch).
In short: `recordBatch` overwrites the vacancy's row, so a write before verification deprives the
baseline diff of its own reconciliation with the ledger, and a red set means there is nothing to
record yet.

## 1.1. Batch store: the history beside the index

The ledger is an index: one mutable row per vacancy, and after `recordBatch` the earlier decision is
gone from it. The history lives beside it: **`triage-batches/<batch_id>/` at the root of the same
checkout as the ledger itself** (in a rehearsal tree — `.rehearsal/batches/<batch-label>/`, and it
dies with the tree, [rehearsal](development-flow.md#10-rehearsal)). The batch directory is created **before** the first fetch and handed to the transport
as `--out-dir`: the batch is built in the store, not copied into it afterwards.

Inside the directory is the artifacts contract of
[tools/triage-verify/README.md](../../tools/triage-verify/README.md), unchanged (it owns what the
directory holds), plus one file that `recordBatch` puts there: `ledger-record.json` with
`batch_id`, `observed_at`, `policy_id` and a line per vacancy, each with the stable key
`source:job_id`. Its `entries_digest` equals the digest of the `ledger.batches[]` row, so whoever
has both files in hand can check them against each other.

Re-scoring **adds**: a new `batch_id` — a new directory — a new record. Two records of one vacancy
are read side by side, each with its own moment of observation and its own `policy_id`.

**The store is declared, not implied.** The third argument of `recordBatch` is mandatory:
`{artifactsDir: <absolute batch directory>}` archives the batch, and `{artifactsDir: null}` declares
that this write keeps no history — synthetic state, a disposable-root test. Omitting the argument is
`triage_ledger_record_undeclared`. On the archiving path the batch's `policy_id` is mandatory: a
decision that cannot name its policy cannot be read beside a later one.

**The record is made exactly once**, by an exclusive file create: the store has no writer able to
replace a record. A repeat of the same batch finds its record and accepts it. The other outcomes and
the repair of each:

| Code                                                                                                                 | What happened                                                                                                                                                                                           | What to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `triage_ledger_record_conflict`                                                                                      | the directory already holds a record, and it is not this batch: either another `batch_id`, or the same `batch_id` with different content                                                                | do not overwrite. Another batch — record the current one into its own directory; do not delete the other record, move it into its own directory by hand. The same `batch_id` with different content is a **new** batch: it needs its own label (for example `<original>-fix1`) and its own directory, exactly as [score-jobs.md](../../instructions/skills/score-jobs.md) requires; like any new batch, its `plan.json` is taken at its start — the ledger already knows the rows of the first record, and the new plan sees them |
| `triage_ledger_plan_undeclared`                                                                                      | the batch's directory has no `plan.json` — the result of `planBatch` written before the first fetch                                                                                                     | put back into the directory the plan file the batch wrote at its start, and repeat. With nothing to restore it from, the batch runs again as a new one: its own label, its own directory, a plan at its start. Do not switch to `{artifactsDir: null}` and do not slip under the old label a plan taken just before the write: it sees other batches' rows as known and turns off the check below                                                                                                                                 |
| `triage_ledger_plan_invalid`                                                                                         | `plan.json` is unreadable or not of the shape `planBatch` writes                                                                                                                                        | as in the row above: put back the plan file written at the start of the batch, otherwise the batch runs again                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `triage_ledger_entry_unplanned`                                                                                      | `entries` holds a vacancy that is not in the batch's plan                                                                                                                                               | remove it from `entries`: the link is not this batch's; the ledger and the directory are untouched                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `triage_ledger_concurrent_observation`                                                                               | the vacancy's row moved after the batch was planned: another batch recorded it between the plan and this write                                                                                          | the ledger and the directory are untouched. Remove the named entries from `entries` and repeat: the row stays with the batch that recorded first, and this batch's trace stays in its directory as evidence. A planned re-scoring does not land here: its plan was taken after the other write and saw the row                                                                                                                                                                                                                    |
| `triage_ledger_record_unreadable`                                                                                    | the file does not read as a record: truncated, does not match its digest, carries an unfit line or an unfit header field; also a file that cannot be read at all (permissions, wrong type, too large)   | first look at `ledger.batches[]`. No row of this batch there — delete the file and repeat `recordBatch`. There is a row — it is the only history of the recorded batch, and it must not be deleted: restore the file from a copy if there is one, otherwise the batch stays recorded in the ledger without a readable archive, and that is a fact for the report, not a reason to erase                                                                                                                                           |
| `triage_ledger_record_schema_version`                                                                                | the record's version is not the one this build reads                                                                                                                                                    | **do not delete.** It is not a truncated file: a build of its own version must read it                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `triage_ledger_record_dir_missing`                                                                                   | the batch directory does not exist                                                                                                                                                                      | create the directory before the run; the tool does not make it up                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `triage_ledger_entry_without_trace`                                                                                  | `entries` holds an entry whose link has no trace in the batch directory's `traces/`: the batch did not observe this vacancy                                                                             | the ledger and the directory are untouched. Remove every entry without a trace from `entries` and repeat `recordBatch`. Do not switch to `{artifactsDir: null}`: that is a write without an archive. A repeat of an already recorded batch is not subject to this check and is accepted as before                                                                                                                                                                                                                                 |
| `engine_tree_drift`, `candidate_snapshot_drift`, `ops_tree_building`, `ops_manifest_missing`, `ops_manifest_invalid` | the operational folder diverged from its manifest, its swap is not finished, or the manifest is unreadable; the meaning of the codes — [tools/ops-tree/README.md](../../tools/ops-tree/README.md#codes) | the ledger and the directory are untouched. Do not record the batch; `npm run ops:verify` names the paths. Repairing the folder is the operational-folder section of [ops-cutover.md](ops-cutover.md); repeating `recordBatch` after the repair is on the user's word                                                                                                                                                                                                                                                             |
| `triage_ledger_record_unwritable`                                                                                    | the file could not be created or completed (permissions, space)                                                                                                                                         | the ledger is untouched. If the file did appear, it is truncated — continue with the `_unreadable` row; then fix the directory and repeat                                                                                                                                                                                                                                                                                                                                                                                         |

**An orphaned record.** There is a window between the write of the file and the write of the
ledger: a break inside it leaves a record without a row in `ledger.batches[]`. It is cured by
repeating `recordBatch` — it accepts the existing file and completes the ledger. A record without its
row reads as an unfinished batch, not as a loss. One cause does not yield to this repeat: if the
ledger refused the batch on its own — say, the batch overflows its cap on entries — the repeat runs
into the same refusal, and there is no tool that would unload the ledger by itself. Then the write
stops: the batch's record lies in its directory and is not lost, and what to do with the overflowing
ledger is the user's decision; until then the batch stays unrecorded.

**Replay is a recomputation of the record.** A fresh session takes `inputs/NNN.input.json` and
`traces/NNN.trace.json` from the batch directory, recomputes the trace with the same
`buildDecisionTrace` and compares — without requesting a single page and without starting Step 1.
Equality lives inside its epoch: a change of `policy_id`, `toolmatch_taxonomy_id` or the input's
`schemaVersion` ends it. The files themselves outlive the epoch: decisions, inputs and quotes can be
read after it. What this means for a repeated run of the verify set over an already recorded batch
is owned by [the verification boundaries](triage-verification.md#7-boundaries).

**When the one-time gate stops being enough.** Verification is a one-time gate at the moment of the
write; the archive is neither re-checked nor recomputed. A revision of this decision (`R2-05A` — a
validator over the stored trace instead of a recomputation) becomes necessary if a source of
post-write corruption appears: a migration of the store's own layout, a second writer or a sync
between machines.

Only a source **able to change a batch that already has a record** counts; the mere appearance of a
writer does not meet the condition.

## 2. Batch start: a plan instead of a repeated spend

`planBatch` classifies every submitted link before the first fetch:

| action          | what the batch does                                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch_new`     | the link is not in the ledger — an ordinary full pass                                                                                                                                          |
| `retry_blocked` | the link is `open`, the last fetch failed (`decision: BLOCKED`) — fetch it as a new one                                                                                                        |
| `skip_known`    | the link is `open` and already scored — do not spend the budget; fetch only at the user's explicit request ([when a known vacancy is fetched again](#3-when-a-known-vacancy-is-fetched-again)) |
| `skip_closed`   | `closed`/`expired` — **never** fetch again                                                                                                                                                     |

`duplicate_in_batch` marks a repeat inside the batch itself; an unreadable link comes back with
`action: null` and a reason code instead of quietly disappearing. The input order is kept — the plan
is advice with a reason, not a rewritten batch. The plan's summary (how many links were skipped as
closed, and why) goes to chat before the fetches start.

### 2.1. Pre-triage: freshness, order, composition

This section owns the policy; the behaviour is implemented once in `tools/pretriage/`, and its
[README](../../tools/pretriage/README.md) owns the form of the calls. Measurements of the 2026-08-18
run: 3 of 10 links were already closed by the time of the fetch, 1 of 10 fell into the priority-1
class, and the source file held 101 links collected the day before.

**The collection's staleness window is 7 days.** This section owns the number;
`collectionStaleAfterDays` in `tools/pretriage/freshness.mjs` mirrors it, and
`tests/pretriage.test.mjs` holds the value as a literal.

A collection describes itself in the header of the links file (`# collected: 2026-08-17`,
`# order: newest-first`) — before this, the collection date lived in the session's opening message
and died with it. A date without a time is read as midnight UTC: that is the earliest it can mean,
so a mistake costs an extra sweep, not a spent expensive lane.

Two consequences of the same choice that the operator sees. **A date one calendar day ahead of the
batch is accepted** and counts as zero age: at 01:00 in Tbilisi "today" is already tomorrow in UTC,
and the operator writes their own date, not the UTC one; more than a day ahead is a typo or a wrong
clock, and such input stops the batch. **The batch's own instant cannot be a bare date** and is
rejected: for it, midnight is the earliest moment of the day, so it would understate every age and
could show a stale collection as fresh. A calendar date that does not exist (`2026-02-30`) is
rejected in both spellings, because otherwise it would silently read two days younger.

| state     | what it means               | what the batch does                                            |
| --------- | --------------------------- | -------------------------------------------------------------- |
| `fresh`   | the age is below the window | the expensive lane is open                                     |
| `stale`   | the age is ≥ the window     | a liveness sweep first, only then the browser/model budget     |
| `undated` | the header named no date    | the same as `stale`: what is unchecked does not count as fresh |

The order is newest-first, and **the basis is always named**: `posted_at` (every link has a
publication time — we sort), `declared_newest_first` (the operator claims it in the header — we do
not sort, but record the claim), `input_order` (nobody claimed anything). A partly dated list is not
sorted: that would put the undated links at the end as supposedly the oldest.

**Dispositions.** Every link carries exactly one at any moment.

| disposition          | where from                                                                                                                                                                                          | does it still cost budget |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `skipped_by_ledger`  | the plan of [batch start](#2-batch-start-a-plan-instead-of-a-repeated-spend): `skip_closed` always, `skip_known` unless the user asked for a re-check                                               | no                        |
| `duplicate_in_batch` | the plan of [batch start](#2-batch-start-a-plan-instead-of-a-repeated-spend) marked a repeat inside the batch: the ledger collapses spellings that the skill's dedup by the full URL does not catch | no                        |
| `unreadable_link`    | the plan returned `action: null`                                                                                                                                                                    | no                        |
| `pending_sweep`      | before the sweep; in the pre-sweep report this is the state of every planned link                                                                                                                   | not decided yet           |

| `terminal_gone` | the sweep saw a closure in a page whose structural checks agreed | no, except for one quote under [the rubric's evidence rule](../../knowledge/job-match-rules.md#5-evidence-and-uncertainty) |
| `browser_rung` | the sweep did not settle the question: `absent`, `access_failure`, an unconfirmed structure, `private`, an unattempted link | yes, one load in the browser |
| `expensive_lane` | the vacancy is alive | yes, in full |

`absent` is deliberately **not** terminal: [score-jobs.md](../../instructions/skills/score-jobs.md)
requires one confirming load in the browser, because the layer observed this `404` exactly once.

**The accounting of savings is split, and this is not cosmetic.** Fetch and the expensive lane are
different costs: the sweep is itself a fetch of every planned link, so `terminal_gone` saves the
browser load, the extraction of the description and the scoring, but not the request itself; only
`never_fetched` saves the request. And the ledger's savings (`skip_closed`/`skip_known`) are kept
apart from the stage's own savings (`duplicate_in_batch` + `terminal_gone`): they would be the same
without pre-triage, so they must not be credited to it. For the same reason the ledger's answer is
read **before** the duplicate flag: a second spelling of an already closed link is the ledger's
saving, not the stage's, even though neither costs a request. An unreadable link is nobody's saving
— it could not have been spent — and the report names it as the third term, so that the breakdown
adds up to the total.

**The sweep's order is kept as is.** Links go to the fetch layer exactly in the order of
`plan.sweep.links`, and folding the manifest back into the plan checks both the number of records
and the requested URL of each: the manifest of another batch is rejected instead of pasting one
vacancy's liveness onto another.

**The gate is opened by the sweep's result, not by the fact that it ran.** A batch the sweep did not
attempt — a stop on a rate limit, a failed batch — established nobody's liveness, so for a stale
collection the gate stays closed with `sweep_incomplete`, and the way forward is another sweep of
those links. A fresh collection was never held by the gate and is not held now.

**What pre-triage has no right to decide.** Under policy v2 only liveness is decided before the
description is read. [The rubric's access
outcome](../../knowledge/job-match-rules.md#21-access-outcome-before-scoring) allows one early SKIP
by title — `not_qa_or_testing_role` — and every other code of
[the SKIP codes](../../knowledge/job-match-rules.md#62-skip-codes) is tied to the description. The
UAE/Singapore on-site classes that the 2026-08-18 run wanted to cut off early are scored under
policy v2 and must be scored. So there is no classifier of early SKIPs in `tools/pretriage/`: the
composition report shows a collection of such makeup, and the decision stays with the user.

**Session groups.** A group is a contiguous range of the deduplicated collection file in file order,
of the size the user names; the ledger takes no part in the slicing and clears links inside a group
as in any batch. One group is one batch: its own `batch_id` of the form `<prefix>-<from>-<to>`, its
own directory in [the batch store](#11-batch-store-the-history-beside-the-index), its own
`plan.json`, its own `--from/--to` range. The batch directory is the claim on the group: a session
that created it took it, and if it exists, the group belongs to another session; a group is taken
again by its number. `tools/pretriage/groups.mjs` implements this once, and
[score-jobs.md](../../instructions/skills/score-jobs.md) says when a group is taken and what is
reported before the first fetch.

**Priority classes — the `priorities.*` keys of the candidate config.** The engine keeps the form
of the classes: `1` is remote work for a company of a ranked region, `2` any other remote work, `3`
a relocation with visa sponsorship to a ranked destination. The config says which regions and
destinations are ranked; the profile, `candidate/profile.md#3-career-target--priorities`, states
the same preference in prose. This section owns the mapping of observations onto the classes, and
`tools/pretriage/composition.mjs` implements it once. Before this, `priority_class` was a ledger
field without a single implementation: whoever ran the batch chose the value.

An observation is an object with the fields `work_format`, `company_region`, `sponsorship` and
`relocation_destination_code`. The **values** come from the scorer's vocabulary (`Remote`/`Hybrid`/
`On-site`/`Unknown`, `WEST`/`HOME`/`OTHER`/`UNKNOWN`, `available`/`unavailable`/`unknown`, an ISO
3166-1 alpha-2 code as the scorer's `relocationCountryCode`), while the **field names** belong to
the stage itself: the scorer's normalized offer is in camelCase, and the trace has the prefix
`selected_`, and neither of these spellings is accepted here. The field that named the country by
name, `relocation_destination`, is refused.

| observation                                                               | class                                                           |
| ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `work_format: Remote` + a region of `remote_company_regions`              | `1`                                                             |
| `work_format: Remote` + another known region                              | `2`                                                             |
| `work_format: Remote` + `UNKNOWN`                                         | `unknown`; `2` when no region is ranked, `1` when all three are |
| `Hybrid`/`On-site`, a ranked destination, `sponsorship: available`        | `3`                                                             |
| `Hybrid`/`On-site`, a ranked destination, `sponsorship: unavailable`      | `outside`                                                       |
| `Hybrid`/`On-site`, a ranked destination, `sponsorship: unknown`          | `unknown`                                                       |
| `Hybrid`/`On-site`, a destination that is not ranked                      | `outside`                                                       |
| `work_format: Unknown`, or a destination there is nothing to resolve with | `unknown`                                                       |

"A ranked destination" is a country of the ranked set: every WEST country when
`priorities.relocation_west` is set, plus the countries of `priorities.relocation_destinations`,
less every country of `mobility.excluded_destinations`. The destination code decides first: a
code is ranked exactly when it is in the set, whatever the company's region. Without a code only
the company region is left: a WEST company is ranked when the whole region is and `unknown` when
only some WEST countries are; a company of unknown region is `unknown`; a HOME or OTHER company is
`outside`. The price of a missing code is named: a ranked country outside WEST is not recognised in
a HOME or OTHER company's posting, and with the whole region ranked an excluded WEST country is
ranked on its company's region. The one country table read is the engine's own list of WEST
countries — a second copy of the rubric's tables is exactly the drift [the rubric's mobility
section](../../knowledge/job-match-rules.md#31-m--mobility--work-feasibility) forbids.

`outside` and `unknown` are not merged in the report: a collection that is mostly `outside` is one
finding (the wrong thing was collected), mostly `unknown` is another (the header facts are too
thin).

## 3. When a known vacancy is fetched again

A known vacancy is not fetched again on its own: the date plays no part in this decision. There are
two exceptions.

- **A failed fetch** — an `open` row with `decision: BLOCKED` is returned by the plan as
  `retry_blocked` every time the link is submitted. However many times the fetch fails, that does
  not close the row: only the source's own words about a closure or an `HTTP 404` make it terminal
  (the liveness rule in [score-jobs.md](../../instructions/skills/score-jobs.md)).
- **The user's explicit request for a re-check** — the batch runs with `refetchKnown: true`
  ([pre-triage](#21-pre-triage-freshness-order-composition)), and the option applies to every
  `skip_known` link of the batch. To re-check one group of the report means to submit a separate
  batch from the `entries[].url` of that group with the option on; the cost is a full batch: fetch,
  verify, record.

`skip_closed` is not fetched even on request.

## 4. Review: one group — one decision

```sh
node tools/triage-ledger.mjs review --as-of 2026-08-21 --compact
```

The report groups the **open** rows by each flag: `fast_lane` — whether the group has a priority-1
row, `keys` — which vacancies. A vacancy with two flags lands in two groups on purpose: it really
needs two decisions.

The review rule: **one decision per group, never per vacancy**. For every group of the report the
row of the table below is taken, and the user is asked exactly one question or shown exactly one
policy edit; left without a question are a class A group — it is presented as a counter — a class B
row whose "What would price it" column names nothing, and the `vacancy_unavailable` group — it is
presented per vacancy.

**How a group is presented is decided by the token's class.** The class of every
`gap:`/`assumption:` token is declared by the table in [the rubric's decision
record](../../knowledge/job-match-rules.md#22-accepted-triage-decision-record); here it is only
read:

- **class B** (the source spoke, the policy could not price it) — per vacancy: for every row of the
  group the vacancy and the discarded observation from its trace in
  [the batch store](#11-batch-store-the-history-beside-the-index) are named. The trace is found by
  the link — the `traces/NNN.trace.json` whose `source_ref` gives the row's `key`; `NNN` is taken
  from the name of that file, not from the position in `plan.json`.
  The observation: `salary_raw` for `gap:compensation_fx_unavailable`,
  `gap:compensation_market_curve_absent` and `gap:compensation_period_absent`; for
  `gap:compensation_basis_incomparable` — `salary_raw`, `location_raw` and `compensation_floor`: the
  question of this group names a market, not an amount, and it exists only where the floor's basis
  is gross while the amount itself names no basis; `relocation_destination` for
  `gap:relocation_country_unlisted` and `gap:relocation_country_unresolved`; for
  `gap:residence_requirement_country_unresolved` — `residenceRequirementCountry` from
  `inputs/NNN.input.json` with the same `NNN`, because the trace does not carry this field. The
  group's question is the one the "What would price it" column of the same table names; a row whose
  column names nothing is presented without a question;
- **class A** (the source was silent) — a counter: the token and the group's `count`, without a
  question. Change an unknown-data score through the private candidate configuration under
  [the point configuration contract](../../knowledge/job-match-rules.md#8-private-point-configuration).
  This does not remove the token: it stays as long as the source is silent. Recorded batches keep
  their inputs and traces; re-score only in an explicit new batch.
- **class C** (an approved default) — not presented: such a token is not written into flags
  ([the ledger](#1-ledger)).

| flag                                 | the one decision that closes the group                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relocation_floor_missing`           | Closed by a policy edit: [the decision record](../../knowledge/job-match-rules.md#22-accepted-triage-decision-record) of policy v2 dropped the floor requirement for relocation employment, C is computed without a floor gate. A row with this flag is left over from a policy v1 run and leaves the group when the vacancy is recomputed by a re-check at the user's request ([when a known vacancy is fetched again](#3-when-a-known-vacancy-is-fetched-again))                                                                                                                                                                                              |
| `engagement_path_unknown`            | Closed by a policy edit: [the decision record](../../knowledge/job-match-rules.md#22-accepted-triage-decision-record) of policy v2 sets a table of default engagement paths (Remote outside RU/BY → a contract through a a configured marketn individual entrepreneur), and an applied default now arrives as `assumption:engagement_path.*`. A row with this flag is left over from a policy v1 run; there is no decision on the default itself — class C under [the rubric's decision record](../../knowledge/job-match-rules.md#22-accepted-triage-decision-record)                                                                                          |
| `work_format_unknown`                | Closed by a policy edit: [the decision record](../../knowledge/job-match-rules.md#22-accepted-triage-decision-record) of policy v2 gives an unknown-data M score plus `gap:work_format_absent` instead of a dead end. A row with this flag is left over from a policy v1 run; `gap:work_format_absent` is class A, a counter under the class rule above                                                                                                                                                                                                                                                                                                         |
| `residence_restriction_incompatible` | Partly accepted: [the decision record](../../knowledge/job-match-rules.md#22-accepted-triage-decision-record) of policy v2 assesses the restriction against the whole feasible-residence set (`mobility.feasible_residences` of the candidate's config) — this changes the **Remote** branch. On the Hybrid/On-site path policy v2 deliberately does **not** read `residenceRestriction`: rule 2 is built on sponsorship/work authorization, so "MUST BE currently based in <country>" on an on-site role is still assessed rather than skipped. Closing this gap is a separate decision, not yet taken; until it is, the user decides per class of restriction |
| `policy_undefined`                   | Under policy v2 — a contradiction in the source's data itself (or a broken batch override), not a gap: [the decision record](../../knowledge/job-match-rules.md#22-accepted-triage-decision-record) leaves exactly three reasons and owns their list. It is not closed by a decision on one vacancy; it is closed by an answer on the class or by an edit of `knowledge/job-match-rules.md` through a backlog task. A row that came with another `review_reason` is from a policy v1 run: review it by the rows above                                                                                                                                           |
| `gap:*`                              | By the token's class ([the rubric's decision record](../../knowledge/job-match-rules.md#22-accepted-triage-decision-record), the rule above): class A — a counter, needs no decision; class B — per vacancy, the one decision is what the "What would price it" column names, and it has two exits under [where a decision goes](#5-where-a-decision-goes): a backlog task (the rubric's table or an extraction step) or an input to the next run                                                                                                                                                                                                               |
| `assumption:*`                       | Not presented: class C under [the rubric's decision record](../../knowledge/job-match-rules.md#22-accepted-triage-decision-record), not written into flags ([the ledger](#1-ledger)). A row with such a flag is left over from a batch recorded under the earlier rule of [the ledger](#1-ledger), and it leaves the group when the vacancy is recomputed — by a re-check at the user's request ([when a known vacancy is fetched again](#3-when-a-known-vacancy-is-fetched-again))                                                                                                                                                                             |
| `vacancy_unavailable`                | A technical failure of the fetch (BLOCKED), not a rejection. It needs no decision: it is presented per vacancy — the link and the `symptom` from its trace in the batch store — without a question. The row stays `open` and leaves the group when the link is submitted again and opens, or the source names the vacancy closed ([when a known vacancy is fetched again](#3-when-a-known-vacancy-is-fetched-again))                                                                                                                                                                                                                                            |

A group missing from the table never exists "just this once": either a row is added to the table in
the same commit as the new flag, or a backlog task is filed. An answer from the user of the form
"yes for this vacancy" without a row in the table is not accepted: it will not survive the next
batch.

The order of review: first the groups that need a decision — class B and those without a class
(`policy_undefined`, policy v1 flags) — then `vacancy_unavailable`, then the class A counters;
inside each block first the groups with `fast_lane: true` (the priority-1 class per
`candidate/profile.md#3-career-target--priorities` — its definition lives there and is not repeated
here), then by the size of the group. A fast-lane group is reviewed in the same session as the
batch.

## 5. Where a decision goes

The ledger holds observations, not approvals — "decided" never appears in it. A decision has exactly
two exits, and both live in git:

1. **An edit of policy or canon** — a backlog task under
   [ADR 0014](../adr/0014-development-backlog-replaces-remediation-queue.md); decisions on the
   rubric change `knowledge/job-match-rules.md`, candidate facts change the candidate's profile
   `candidate/profile.md`, scoring values (the residence set, excluded destinations, relocation
   tiers, thresholds and target, the independent price and experience label of each test language and framework, the place of each domain on the Domain Fit
   scale) change the `mobility.*`, `compensation.*`, `tool_match.*` and `domain_fit.*` keys in
   `candidate/config.json`. The edit itself does not recompute rows
   already scored: after it, the session offers the user a re-check of the group the edit answers
   ([when a known vacancy is fetched again](#3-when-a-known-vacancy-is-fetched-again)), and the rows
   leave the group with that batch. Without a re-check the report will repeat a question the edit
   has already answered.
2. **An input to the next run** — an answer that acts on a batch (for example, a relocation override
   with scope=batch) is passed to the batch as a launch parameter and ends up in its traces.

An answer that became neither counts as not received: the next batch will ask the same question.

## 6. Operation

- `review` without `--compact` prints every row of the groups in full; on a large ledger ask for
  `--compact` (groups, counters and keys) and look at the full output only for the group you need.
- If a process died holding the lock, the next write stops with `triage_ledger_locked` and names the
  path. The tool never removes someone else's lock by itself. The recovery order: make sure no
  session writes to the ledger (`node tools/triage-ledger.mjs validate` reads it without the lock),
  then delete the directory `triage-ledger.json.lock` by hand. Reads (`show`, `review`, `validate`)
  take no lock and work all along.

## 7. Boundaries

- The ledger does not hold traces, raw pages or evidence quotes: they are in
  [the batch store](#11-batch-store-the-history-beside-the-index).
- The ledger and the store live in one folder — the one that runs the batch — and have no
  independent copy: the same durability boundary as `process-log.json` ([durability boundary](development-flow.md#11-backup-and-what-it-does-not-cover)).
  Backup is a separate procedure: [operational-backup.md](operational-backup.md).
- The tool does not know the policy: it groups flags, and from the decisions it reads one value —
  `BLOCKED`, on which the plan returns `retry_blocked`. The meaning of a flag and the decision on a
  group belong to this runbook and the rubric.

### ToolMatch policy transition

Policy v8 uses independent main test-language and framework prices. Candidate config schema 3 and
normalized input schema 9 must be paired with that engine at explicit cutover. Existing batches
remain immutable: use their original engine for historical verification, or create a new batch
with fresh evidence-scoped observations to re-score. Compare results only with both policy and
taxonomy ids visible; a v7 category score is not a v8 ToolMatch score.
