# Verification of batch triage: cadence, vocabulary, dispositions

Status: **a mandatory part of every `/score-jobs` batch**. A batch does not count as verified until
the per-batch set of `tools/triage-verify/` has run over its artifacts and returned `pass`.

Owners this runbook does not replace: the tool's own behaviour, the contract of the artifacts
directory and the finding codes — [tools/triage-verify/README.md](../../tools/triage-verify/README.md);
terminal codes and the Decision Trace — [job-match-rules.md](../../knowledge/job-match-rules.md);
the ledger and the review of flagged results — [triage-review.md](triage-review.md); the batch
procedure — [instructions/skills/score-jobs.md](../../instructions/skills/score-jobs.md). This file
holds only **when** what runs, **how the vocabulary is ratcheted** and **what to do with a
finding**.

## 0. What is fixed here (measurements of the 2026-08-18 run)

The 2026-08-18 run wrote seven check scripts right in the session. They worked — and turned out
unfit for reuse:

- they had the scratchpad path, an id map and the claim that the closed set literally equals
  `[5,7,8]` hard-coded. A check that stamps exactly the batch it was written from and cannot turn
  red on any other;
- the cadence was mixed up: the scorer's determinism is a property of the repository's code, not of
  a batch; a baseline diff needs data from an earlier batch; the blind double extraction on a
  stable transport gave zero divergences in outcomes, and its only finding was an error of the
  blind agent itself;
- the keyword families of the "negative space" lived as prose in the run's file and **did not
  reach** the most important line of the batch — a hard requirement of current residence. Only an
  extra pattern invented in the session reached it, and that pattern died with the session;
- the normalization of the raw files ran after the extraction, rewrote the mtime and was recorded
  nowhere: the chain of custody had to be reconstructed from memory.

Where each of them went is in the table below. The ids are the ones the suite's design gave them;
the run file's own numbering is not reproduced here, because the run file is not in the repository.

| Check of the 2026-08-18 run      | Where it went                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| V1 — quote integrity             | `quote-integrity`, generalized: the schema drives the walk, not a list of six paths                                    |
| V3 — completeness and sanity     | `completeness`, plus a recomputation of the trace from its own input                                                   |
| V4 — blind double extraction     | `blind-extraction`, periodic and **computed**: the second extraction is put on disk and compared on the outcome fields |
| V5 — scorer determinism          | a unit test of the repository; **not duplicated** here, only mentioned                                                 |
| V7 — baseline diff               | `baseline-diff`, periodic; the baseline is the batch's `plan.json`, and the ledger checks the plan itself              |
| E1 — copy-fidelity probe         | `chain-of-custody`: the persistence hashes instead of an eyeball comparison                                            |
| E2–E4 — transport reconciliation | `cross-transport`, rewritten as implications; not a single expected list                                               |
| E5 — negative-space families     | `negative-space` + the versioned file `vocabulary/negative-space.v1.json`                                              |

The run's scripts lived only in the session's scratchpad; there is nothing to delete in the
repository — this table is the record of their retirement.

## 1. Where verification sits in a batch

The order of a batch's closing steps is fixed, and it is not cosmetic:

1. gather the batch's artifacts into its directory — it is the batch's own directory in the batch
   store ([the review runbook's batch
   store](triage-review.md#11-batch-store-the-history-beside-the-index)), not the session's working
   directory: the transport's raw captures, `inputs/`, `traces/`, `plan.json`; for `full` also
   `blind/` and `attestation.json`;
2. **run the per-batch set**;
3. only after `pass`, record the ledger (`recordBatch`), and the same write puts the batch's
   immutable record of decisions into its directory;
4. then review the flagged groups under [triage-review.md](triage-review.md).

Why verify goes before the ledger write: `recordBatch` overwrites a vacancy's row. The baseline diff
compares the batch not with the live ledger but with `plan.json` — an immutable snapshot that
`planBatch` took before the first fetch and that lies in the batch's directory; that is exactly why
the comparison is reproducible even a month later. The ledger is needed only for what the plan
cannot do to itself: confirm that the plan did not lie (`plan_disagrees_with_ledger`), and notice
that the batch is already recorded (`ledger_already_recorded`). A red per-batch set means there is
nothing to record the batch with: the finding is fixed first.

```sh
node tools/triage-verify/cli.mjs \
  --artifacts-dir /absolute/path/to/batch/directory \
  --links-file /absolute/path/to/links.txt \
  --from 1 --to 20 \
  --ledger /absolute/path/to/triage-ledger.json
```

No vacancy value reaches the command line — the links arrive as a file
([ADR 0011](../adr/0011-untrusted-input-safe-cli-transport.md)). Stdout is limited to counters and
codes: the model reads it. The full report is `verification-report.json` next to the batch.

### Source-set batches

A Telegram source-set batch also publishes its exact `collection.links.txt`, version 1
`source-set.json`, saved HTML captures and version 1 `source-resolution.json`. Input 10 and source
policy v9 keep these meanings separate from historical URL batches. The suite checks the supplied
collection against its archive, verifies source-set/capture digests and reparses the HTML, then
reproduces the resolution from its retained observations. Both supplied URL coverage and selected
logical-card coverage must hold before the ledger write. `selection.from`/`to` is this batch's
verified range; a shared company link preserves memberships without merging cards.

The resolution owns identity, primary JD, conflicts, dispositions and logical results. Every raw
extraction with an input has its own input and trace on disk, including an alternative publication
whose result differs from the primary. Input 10 binds all its evidence to its one selected source,
capture digest and vacancy boundaries. A line from another card in the same post, or from another
publication, does not satisfy a quote. Summary text cannot stand in for a full JD. Company/context
links get proved source dispositions; they do not become unavailable vacancies or plan-only
coverage waivers. True transport failures keep their unavailable traces with exact manifest proof.

Source plans use ledger 2, validated card identities and a ledger snapshot digest. The suite accepts
the initial per-card plan and a plan taken with the final resolution; a later merge or split cannot
borrow a previous card's baseline. In `full`, the baseline diff compares the logical result and
its flags with that guarded prior observation. Historical inputs/traces stay in their own accepted
policy epoch; unsupported epochs produce `policy_drift`, without recomputation or migration.

A nonnull logical baseline must predate `source_plan.as_of`; an old saved HTML capture does not
make the current plan a historical run.

Source integrity, coverage and baseline failures are bounded `source_*` findings. Rebuild the
responsible artifact from its checked source or repeat the capture. An unsupported merge, missing
card or foreign quote is not repaired by updating a digest, changing a plan action or dropping
its URL. The exact file contract and codes remain owned by
[tools/triage-verify](../../tools/triage-verify/README.md#source-set-batches).

## 2. Cadence

| Set                   | When                                                       | What it includes                                                                           |
| --------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `per-batch` (default) | **every** batch                                            | `chain-of-custody`, `quote-integrity`, `completeness`, `cross-transport`, `negative-space` |
| `full`                | a change of transport or policy, otherwise every 5th batch | all of the above + `baseline-diff` + `blind-extraction` + `periodic-attestation`           |

**A change of transport or policy** is: a new or changed adapter version of
`tools/vacancy-fetch/`, a switch between the browser and the disk transport, a new `policy_id` in
`tools/job-scorer/`, a new `vocabularyId`. Any of these is a reason for `full` regardless of the
batch counter.

**Every 5th batch** is this runbook's starting figure, just like the 2/7 days in [the review
runbook's re-fetch rule](triage-review.md#3-when-a-known-vacancy-is-fetched-again), and it changes
here too. The basis: on a stable transport the blind double extraction in the 2026-08-18 run gave
zero divergences in outcomes, so nearly all of its cost is wasted while the transport has not moved;
but "never" turns "the transport has not moved" into an assumption nobody checks. Five is a
compromise, not a measurement, and it is up for review as soon as a second data point appears.

This tool keeps no batch counter: it has no state between runs and does not read the clock. Whoever
starts the batch keeps it, by the `batch_id` in the ledger.

## 3. The vocabulary ratchet

`tools/triage-verify/vocabulary/negative-space.v1.json` is an asset, not a setting. There is one
rule:

- **a phrase is added** when a batch showed wording the vocabulary did not reach. The addition is a
  deliberate git commit: an `id` in the form `<family>.<slug>`, the `text` as a literal, `addedIn`
  as a date and `source` — either the id of the batch where the wording was observed, or
  `anticipated` for an entry added ahead of need;
- **a phrase is removed** when over several batches in a row it produced only dispositions and not a
  single confirmed miss. Noise that people learn to rubber-stamp does more harm than a missing
  phrase;
- **a new `vocabularyId`** — on any change of content. It goes into the report, so two batches
  checked with different vocabularies are never compared silently. A new version of the file
  (`negative-space.v2.json`) is needed when the **schema** changes, not the list of phrases: the old
  file stays readable for re-checking an old batch.

The families today: `residence` (a requirement of current residence), `contract` (the form of
employment), `work_format` (a work format stated in the body rather than in the header). A new
family is added in the same commit as its first phrase, and a line appears here saying which
decision it supports.

## 4. Dispositions: what to do with an unclaimed hit

The main zone **exempts nobody**. It only picks the code: a hit below the page chrome arrives as
`negative_space_outside_main_zone`, the others as `negative_space_unclaimed`, and both need an
answer. This is how it ended up after two review rounds: while the zone granted a pass, a page could
hide a requirement under its own "Similar jobs" rail, and the reviewer reproduced every narrowing of
the rule one line lower. A boundary that exempts nothing hides nothing either.

A hit is **closed automatically** if it lies inside the evidence quote **of the offer whose field
matching the family is actually filled**: `residence` — `residenceRestriction` in
`compatible`/`incompatible`, `contract` — a set `contractorEligibility` or `engagementPath`,
`work_format` — a known `workFormat`. Nesting alone is not enough: `offers[].evidenceQuote` is one
mandatory string for the fourteen fields of an offer, so a record that quoted "MUST BE currently
based in Singapore" and recorded `residenceRestriction: "none"` is valid by the schema and
reproduces its trace byte for byte. Widening a quote must not buy silence — exactly the silent flip
this check exists for.

Hence a consequence for negating wording: "no residency requirement" also gives a hit that nothing
closes, and it goes to dispositions. That is by design — it is exactly the case a person looks at.

If a hit is not closed, it has exactly two exits, and both are written:

1. **it is an extraction miss** — the normalized object is fixed and the batch is rebuilt. If the
   miss came from wording the vocabulary did not have, the same edit adds the phrase
   ([the vocabulary ratchet](#3-the-vocabulary-ratchet));
2. **it is not a requirement** — an entry `(recordIndex, family, lineSha256)` appears in
   `disposition.json` with one of the values `not_a_requirement`, `boilerplate`,
   `already_recorded_elsewhere`, `outside_scope` and a short note.

A disposition is bound to its line: if the page rewrote the wording, the digest changes, the entry
goes stale and the check turns red. This is on purpose — the explanation is given anew instead of
outliving the text it referred to.

A disposition does **not** replace the user's decision. It says "this line does not change the
normalized object", and nothing more. Everything that changes the outcome goes the usual route of
flags in [where a decision goes](triage-review.md#5-where-a-decision-goes): an edit of the
canon/backlog or an input to the next run.

## 5. Periodic probes

Of the three checks of the 2026-08-18 run, one became computed and two stayed manual.

**Blind double extraction — now a check, not a record.** An agent given only this record's
`NNN.capture.txt` and nothing else builds the normalized object anew and puts it into
`blind/NNN.input.json` (1–2 records per batch). The root keys that are not extracted from the
capture — `policyId`, `schemaVersion`, `scoringDate`, `inputIndex`, `fx`, `explicitOverride` and
`candidateScoring` — it takes as a copy from this record's main input. Source input 10 also copies
its exact `sourceContext`; the blind agent receives only that primary source's own vacancy body,
not sibling cards or alternative JDs. From there the tool counts:
the blind object's quotes are checked against the same capture, the object is scored by the same
scorer, and a frozen list of outcome fields — decision, terminal code, bucket, mobility
observations — is compared with the main trace. `blind_extraction_disagrees` names the fields that
diverged and stops there: the only finding of this probe in the 2026-08-18 run was an error of the
blind agent itself, so which of the two is wrong is a person's decision, not the check's.

**The two remaining probes are recorded in `attestation.json`.**

| Probe                     | What the executor does                                                                                                   | Verdict                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `phase0_capability_probe` | checks that the source still serves what the adapter relies on: the guest fragment, the status banner, the authwall path | `held` / `changed` / `failed` |
| `transport_hypotheses`    | re-checks the transport hypotheses recorded in [vacancy-fetch-experiment.md](vacancy-fetch-experiment.md)                | the same                      |

`failed` is a finding: the transport or the source changed so that the batch's evidence is in
question. `changed` is not a finding, but it is a reason for `full` on the next batch and possibly
for a backlog task.

Freshness is a window with two sides, and both are counted from the timestamps of the batch's own
captures, not from the clock: a probe more than a day before the first fetch is `probe_stale`,
more than a day after the last one is `probe_out_of_window`. Source-set original-post observations
use the collector capture's digest-bound `captured_at`, never the post's publication time. A source
batch with no admissible capture clock reports `source_probe_window_unverifiable`; it cannot pass
`full` by omitting the window.

What is checked here is the fact of the record, not the probe itself, and this row is marked
`attest`, not `assert`: a dated machine-readable record in the batch's directory is weaker than a
measurement and stronger than a promise in prose — and that is the whole claim.

## 6. What to do with a finding

A finding means the batch is not verified, not that the vacancy is bad. The review goes by groups of
codes:

| Group of codes                                                                                                                                                                                                                                                                                                              | What it is                                                                                                                                                                             | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture_*`                                                                                                                                                                                                                                                                                                                 | a raw file does not match its stamp, lost its index or its normalization record                                                                                                        | capture the vacancy again; editing the file by hand is not a repair                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `quote_absent`, `quote_whitespace_variant`, `no_evidence_recorded`, `record_not_verifiable`                                                                                                                                                                                                                                 | a quote is not found in the body, or there is none at all                                                                                                                              | fix the normalized object against the page text; a divergence in whitespace only is also an edit, not a tolerance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `trace_mismatch`, `input_not_scoreable`, `policy_drift`                                                                                                                                                                                                                                                                     | the trace is not produced by its input under the current policy                                                                                                                        | regenerate the trace; `policy_drift` means the batch is being checked under a policy other than the one it was scored with, and on a batch recorded under the earlier revision of [the decision record](../../knowledge/job-match-rules.md#22-accepted-triage-decision-record), there is nothing to recompute: such a batch is not regenerated, its check is closed by its own revision; `input_not_scoreable` with the code `invalid_scorer_input` on a batch whose input was written under an earlier `schemaVersion` means the same — such a batch is neither recomputed nor edited by hand, its check is closed by its own release                                                                                                                                           |
| `link_uncovered`, `record_outside_range`, `duplicate_record_for_link`, `plan_range_mismatch`, `unexpected_artifact`                                                                                                                                                                                                         | the batch covered something other than what it was given; `link_uncovered` next to `plan_skips_unverifiable` means not "rebuild the batch" but "present the ledger the plan refers to" | complete the batch or fix the range; `plan_range_mismatch` means `plan.json` is a plan of a range other than exactly this one: every batch has its own `planBatch`, its own directory and its own `--from/--to`; an extra file — remove it from the directory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `manifest_*`, `capture_source_ref_mismatch`, `fallback_not_honoured`, `closed_source_scored`, `closure_not_corroborated`, `unavailability_not_corroborated`, `manifest_record_unaccounted`, `rescue_contradicts_declaration`                                                                                                | the transports disagree with each other                                                                                                                                                | find out which transport is right and rebuild the record; `fallback_not_honoured` means a degraded body was scored; `manifest_record_unaccounted` — the fetch got the vacancy, but the batch does not have it: the plan could declare it skipped, but the plan is written by the same session; the other two — a declared unavailability the manifest does not confirm (while a record the fetch itself did not resolve claims nothing and does not count as a claim); for a record the manifest called `active` and usable or `absent`, the unavailability is also confirmed by a browser retry — a verified capture not from the fetch, stamped `access_failure`; if there is none, make the retry under the `score-jobs` skill and store its capture with the stamp it earned |
| `negative_space_unclaimed`, `disposition_*`                                                                                                                                                                                                                                                                                 | negative space                                                                                                                                                                         | [dispositions](#4-dispositions-what-to-do-with-an-unclaimed-hit)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `negative_space_outside_main_zone`                                                                                                                                                                                                                                                                                          | the hit lies below the page chrome: the duty is the same as for `negative_space_unclaimed`, the code differs so that chrome is told apart from a requirement                           | [dispositions](#4-dispositions-what-to-do-with-an-unclaimed-hit); the usual outcome is a `boilerplate` disposition, one per line                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `refetched_closed_vacancy`, `record_absent_from_plan`, `plan_skip_uncorroborated`, `plan_item_key_mismatch`, `plan_item_duplicate`, `plan_item_duplicate_unclaimed`, `plan_item_duplicate_undeclared`, `plan_skips_unverifiable`, `plan_absent`, `plan_unreadable`, `plan_disagrees_with_ledger`, `ledger_already_recorded` | the batch diverged from its plan, skipped a link on a ground the ledger does not have, the plan was not presented, or verify ran after the ledger write                                | [where verification sits in a batch](#1-where-verification-sits-in-a-batch) and [the cadence](#2-cadence)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `blind_*`                                                                                                                                                                                                                                                                                                                   | the blind extraction is missing, unreadable, identical to the main one byte for byte, quotes what is not in the capture, or diverged from the main one on the outcome fields           | [periodic probes](#5-periodic-probes): a person, not the check, sorts out a divergence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `probe_*`, `attestation_*`                                                                                                                                                                                                                                                                                                  | periodic probes                                                                                                                                                                        | [periodic probes](#5-periodic-probes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## 7. Boundaries

- The tool does not prove authorship: whoever can write into the batch's directory can write a
  consistent header next to an invented text, and a plan, a disposition and an attestation to go
  with it. This is the same same-UID residual of
  [ADR 0011](../adr/0011-untrusted-input-safe-cli-transport.md) that
  `tools/vacancy-fetch/persist.mjs` names.
- **A capture the manifest does not name is a transcript.** The copy-fidelity probe is retired only
  "once hash-anchored persistence becomes the default"; the fetch transport is now the default
  (`tools/vacancy-fetch/README.md`), and on the browser path the bytes are put on disk by the model
  that read the rendered page. The hash of such a file begins **after** the transcription, so a
  green per-batch report on a batch made only of transcripts asserts internal consistency and
  nothing more. The report counts these records separately (`capturesByProvenance`), and `full`
  adds the computed blind extraction to them — the only thing in this directory able to argue with
  the model.
- **A batch's plan is its own word.** `plan.json` is written by the same session that is being
  checked, so one place reads it — `tools/triage-verify/plan.mjs` — and by one rule: a field the
  plan writes about itself is either derived from what the plan did not choose, or confirmed by an
  artifact the plan did not write, or not verifiable.
  - the key is derived from the link; one declared and not matching is `plan_item_key_mismatch`;
  - `duplicate_in_batch` is derived from the plan's earlier rows, with one outcome per form: a
    repeat of **the same link** is a copied row (`plan_item_duplicate`) and counts for nothing;
    another spelling that normalization reduces to the same link is one link as far as the range
    is concerned, and there is no finding; another spelling of **the same vacancy** is an honest
    duplicate (two entries of one LinkedIn link give one record of the batch), and one the plan did
    not mark is `plan_item_duplicate_undeclared`; a first mention that called itself a duplicate is
    `plan_item_duplicate_unclaimed`. The first row of a key always wins;
  - `action` cannot be derived from anywhere — it is a claim about the ledger. A skipped link counts
    only when a ledger row **confirms** it: `skip_closed` needs a row not in the status `open`,
    `skip_known` a row `open` whose decision is not `BLOCKED`: the plan must return such a row as
    `retry_blocked`. Only a link without a record counts as skipped: a `skip_known` with a record is
    a re-check at the user's request, and the record itself answers for the link; a terminal
    `skip_closed` has no such reading. "Nothing to decide with" is not a confirmation: a batch
    without a single verified capture and without a manifest has no moment relative to which a
    ledger row is a baseline. The moment is taken first from the manifest's `startedAt` — the
    transport takes it before the request loop, so it is earlier than anything else in the
    directory — then from the capture headers, then from the `fetchedAt` of the manifest's rows,
    which survive even a batch where nothing was stored. Only a stamp with its own zone counts, and
    an unfit one is a separate finding (`manifest_started_at_unusable`,
    `capture_fetched_at_unusable`, `manifest_fetched_at_unusable`), while a row that already
    carries an observation of this same batch is the batch's own record, not a baseline. Both
    cases — and for a terminal `skip_closed` no less than for `skip_known` — like a ledger not
    presented at all, give `plan_skips_unverifiable`. That is why `--ledger` is in the per-batch
    call of [where verification sits in a batch](#1-where-verification-sits-in-a-batch) too.
- **A plan row that stays silent does not count as an empty baseline.** If the plan did not write
  `status`/`decision`/`flags`, while the ledger holds a row observed before the fetch, the baseline
  is taken from the ledger: staying silent must not pay better than telling the truth.
- **A capture's header is not covered by the digest.** `verifyCaptureFile` computes the digest of
  the body, so `fetched-at`, on which four gates stand (the confirmation of a skip, the protection
  against the batch's own write, the baseline from the ledger and the freshness of the probes), is
  worth exactly as much as whoever wrote it. A stamp that exists but is not an unambiguous moment is
  a separate finding: otherwise writing the time in another notation would be quieter than not
  writing it at all. Unambiguous means with its own zone; the predicate is one for all four gates
  (`tools/triage-verify/instants.mjs`), because a stamp without a zone would be read in the
  machine's time zone and would date the same directory differently. Where the manifest names this
  capture, the two are compared (`manifest_capture_fetched_at_mismatch`); on a transcript there is
  nothing to compare with.
- **The "unavailable" class is checked, not exempted.** A record without a capture and without
  quotes is legitimate (a 404 after a retry), and it is also the cheapest path to a green report. So
  when a manifest exists, a declared unavailability must be confirmed by it
  (`closure_not_corroborated`, `unavailability_not_corroborated`), and without one the report says
  out loud that there is no confirmation and carries counters per outcome class. Where the
  manifest's verdict obliges a retry in the browser (`active` and usable, `absent`), the
  unavailability is also confirmed by that retry's capture stamped `access_failure`; the report
  names every such record in the divergence `unavailability_from_browser_retry`.
- **Verification is a one-time gate at the moment of the write, and this section owns what follows
  from that for a repeated run.** A batch's directory is permanent: the batch is built in the batch
  store (`triage-batches/<batch_id>/`, owned by [the review runbook's batch
  store](triage-review.md#11-batch-store-the-history-beside-the-index)) and stays there, and after
  `pass` `recordBatch` puts `ledger-record.json` into it. A green run over an **already recorded**
  batch is not guaranteed and is not counted as a guarantee, for two independent reasons: the
  recomputation of traces holds only inside its own `policy_id`/`toolmatch_taxonomy_id` epoch, and
  the rows the batch itself recorded are seen by its own plan as its own record, not as a baseline.
  So a later run over the archive is a diagnostic, not an obligation, and a red report on an
  archived batch is not a finding about the batch itself. The condition under which the one-time
  gate stops being enough is named by [the review runbook's batch
  store](triage-review.md#11-batch-store-the-history-beside-the-index).
- Verification is not part of `npm run ci`: the gate checks the repository, while this set checks
  an operational batch. Its own unit tests live in the gate (`tests/triage-verify.test.mjs`).
- `pass` does not mean the vacancy was scored correctly. It means the batch's decision is consistent
  with the files the batch presented.
