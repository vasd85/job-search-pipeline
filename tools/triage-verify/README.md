# tools/triage-verify — the permanent triage verification suite

Eight checks over one finished `/score-jobs` batch, split across two cadences. It answers one
question — _is what this batch recorded actually what the pages said_ — and it answers it from
files, without asking the session that produced them anything.

This module owns the **verification input contract** (what a batch has to put on disk to be
verifiable), the checks and their codes. [docs/runbooks/triage-verification.md](../../docs/runbooks/triage-verification.md)
owns **when** each cadence runs, how the vocabulary ratchets, and which 2026-08-18 session check
each of these replaced.

## Why it exists

The 2026-08-18 verified run wrote seven check scripts by hand, in-session. They worked, and then
they were unusable: they carried a hardcoded scratchpad path, a hardcoded id map, and an assertion
that the closed set literally equals `[5,7,8]` — a check that rubber-stamps the batch it was written
from and can never fail on another. Their keyword families also missed that batch's most important
line, and the pattern that caught it died with the session.

So: no expected value is written down anywhere in this suite. Every check is an implication between
two things the batch itself produced, or an arithmetic re-check of a file against its own stamp.

## What it is not

- **Not the owner of the batch store.** The directory below is a permanent one now: a batch is
  built in `triage-batches/<batch_id>/` and stays there, and `recordBatch` adds
  `ledger-record.json` to it once this suite has passed. What this module owns is unchanged —
  _what may sit in that directory_ — while where the store lives, what a re-score adds to it and
  how a record is repaired belong to [the review runbook's batch
  store](../../docs/runbooks/triage-review.md#11-batch-store-the-history-beside-the-index).
- **Not a re-checker of an archived batch.** Verification is a one-time gate taken at record time,
  so a later run over an archived directory is a diagnostic rather than a standing promise — what
  that costs and why is owned by [the verification runbook's
  boundaries](../../docs/runbooks/triage-verification.md#7-boundaries), and the condition that would
  reverse the one-time gate by [the review runbook's batch
  store](../../docs/runbooks/triage-review.md#11-batch-store-the-history-beside-the-index).
- **Not a scorer test.** Scorer determinism is the repository unit test task 26 delivered. This
  suite recomputes each persisted trace from its persisted input, which is a statement about the
  batch, not about the scorer.
- **Not a proof that the page said what the batch says it said.** Copy fidelity retires only for
  the records `tools/vacancy-fetch` actually fetched — the condition the task attached to it. That
  transport is called first and is the default now - `--batch` names the run,
  `isDefaultTransport: true` in every manifest - and the browser still serves every record it does
  not deliver, so a capture the manifest does not name is a **transcript**: text a model read off a
  rendered page and wrote out, whose digest begins after the transcription. Those captures are counted separately in every
  report (`capturesByProvenance`), and a batch made entirely of them is visibly the weakest class.
- **Not part of `npm run ci`.** It verifies an operational batch; the gate verifies the repository.
  Its own unit tests are in `tests/triage-verify.test.mjs` and do run there.

## The artifacts directory

```text
<artifacts-dir>/
  NNN.capture.txt            raw file per record, `vacancy-fetch capture v1` stamped format
  NNN.<part>.capture.txt     further raw files for the same record (a browser phase, a second pass)
  fetch-manifest.json        optional: present when tools/vacancy-fetch served the batch
  inputs/NNN.input.json      the normalized scorer input the run built
  traces/NNN.trace.json      the Decision Trace the run emitted
  blind/NNN.input.json       1-2 blind re-extractions, required by `--cadence full`
  plan.json                  the `planBatch` result the run used; the diff baseline, required by `full`
  disposition.json           optional: negative-space dispositions
  attestation.json           optional: periodic probe records, required by `--cadence full`
  verification-report.json   written by this suite
  ledger-record.json         written by recordBatch after this suite passes; never read here
```

`ledger-record.json` is a member of this contract rather than a name the loader ignores. It appears
only after verification has already passed — it is the batch's immutable record of what it decided,
written by `tools/lib/triage-ledger-core.mjs`, which owns its schema and lends this module the
file's name so the two cannot drift. No check reads it; listing it is what stops a recorded batch's
own history from being reported as an unexpected artifact by the next run over that directory.

`NNN` is the record's number inside the batch directory — vacancy-fetch's own dense `1..M` over the
URLs it was given — and nothing is joined by it outside the directory. **Records are joined to links
by URL, not by position**: a batch legitimately skips links its plan removed, so a positional join
would report a lost vacancy on every healthy run. A record's `inputIndex`, and its trace's
`input_index`, is the one-based position of the record's link inside the verified range — the first
occurrence where two raw lines normalize to one URL — so it equals `NNN` only in a batch that
withheld nothing (`input_index_mismatch`, `trace_index_mismatch`). A link's record is found by
`source_ref`, never by `NNN`.

`plan.json` is the plan of **exactly the verified range**, not of a longer links file: the suite
compares the plan's link set with the range and reports `plan_range_mismatch` otherwise. A links
file triaged in several batches gets one `planBatch` call, one artifacts directory and one range per
batch.

Running `tools/vacancy-fetch` with `--out-dir <artifacts-dir>` produces the capture files and the
manifest in place; nothing is copied, because a copy is what broke the chain of custody in the run
this suite exists to replace. A record served by the browser transport writes its own capture in the
same stamped format under a `<part>` name.

The manifest and the records therefore share one numbering: a manifest produced for a different link
list belongs in a different directory. Nothing silently accepts a divergence — the manifest's
requested URL is compared with the record's own `source.sourceRef` — but the finding it raises is
`manifest_source_ref_mismatch` on every record, which is a confusing way to learn that two batches
were mixed.

A record may have no capture at all in exactly one case: it claims nothing about a page body — no
usable access outcome and no evidence quote anywhere. A `404` after retry is that case.

## Invocation

```sh
node tools/triage-verify/cli.mjs \
  --artifacts-dir /absolute/batch/dir \
  --links-file /absolute/links.txt \
  --from 1 --to 20 \
  --ledger /absolute/triage-ledger.json \
  [--cadence per-batch|full] \
  [--vocabulary /absolute/negative-space.vN.json] \
  [--report /absolute/report.json|none]
```

Every argument is an operator-owned path or a machine token. **No vacancy value ever appears in the
command line** — the links arrive in a file and the URLs inside the artifacts arrive in files, so
there is no shell string to escape. That is [ADR 0011](../../docs/adr/0011-untrusted-input-safe-cli-transport.md)'s
boundary in its strongest form, the same one the triage ledger uses.

The links file is UTF-8, one URL per line; blank lines and `#` comments are ignored, and the list is
deduplicated by full URL with order preserved — the derivation `instructions/skills/score-jobs.md`
step 1 already performs, reused rather than re-invented. `--from`/`--to` are 1-based and inclusive
over that deduplicated list, and a record's `inputIndex` is counted from `--from`.

The recomputed traces are built with the language names of the workspace's candidate layer —
`candidate/` of `JOB_PIPELINE_WORKSPACE_ROOT`, or of this checkout — the same set the batch was
scored with; a broken layer is a caller error.

Exit codes: `0` every check passed, `2` at least one check produced a finding, `1` a caller error.

A finding names a record by its `index` and a plan row by its `planPosition`; the two numberings
are named apart because a plan whose link set has drifted from the verified range is itself a
finding.

**Stdout is a bounded summary** — counts, check ids and finding codes — because a model reads it.
The full report is a file, because a human reads that. Neither carries a page line, an evidence
quote or a URL: a quote is reported as its path, its length and its digest, and a negative-space hit
as the repository's own phrase ids plus the digest of the line. The report reads no clock, so two
runs over the same directory produce byte-identical bytes.

## Checks

| id                     | cadence   | kind          | what it asserts                                                                                                                                                                                                                                        |
| ---------------------- | --------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chain-of-custody`     | per-batch | assert        | every capture re-verifies against its own stamp, carries this record's index, and records the normalization pass that produced it                                                                                                                      |
| `quote-integrity`      | per-batch | assert        | every evidence string of the normalized input is a literal substring of a _verified_ capture of that record; a scored record with no evidence at all fails                                                                                             |
| `completeness`         | per-batch | assert        | link coverage over the range; one input and one trace per record; `buildDecisionTrace(input)` deep-equals the persisted trace; no stray artifact                                                                                                       |
| `cross-transport`      | per-batch | assert        | manifest, captures, inputs and traces agree on identity and digests; a vacancy the manifest handed to the browser was not scored from the degraded body; a source that says closed was not scored; a vacancy the fetcher reached is still in the batch |
| `negative-space`       | per-batch | assert        | every main-zone vocabulary hit is inside a recorded evidence quote or carries a live disposition                                                                                                                                                       |
| `baseline-diff`        | full      | assert + diff | the batch obeyed its own plan in both directions — no link the plan called terminal was fetched, and no link it dropped rests on a claim the ledger does not back; decisions and flags that moved since the previous batch are reported                |
| `blind-extraction`     | full      | assert        | a second extraction of 1-2 records, built from the capture alone, produces the same outcome fields                                                                                                                                                     |
| `periodic-attestation` | full      | attest        | the two probes that cannot be code carry a dated record inside this batch's own window                                                                                                                                                                 |

A record the fetch transport handed to the browser is judged against the rescue rather than exempted
by it: a rescue capture whose own stamp contradicts the declaration raises
`rescue_contradicts_declaration` — one such capture is enough, the rescues are selected by derived
provenance rather than by filename, and only a stamp that is a verdict about the posting
(`active`, `absent`, `closed`, `private`) can contradict anything, because `access_failure` says the
fetch failed and nothing about the vacancy. The record stays in the `manifest_did_not_resolve`
residual either way: the batch that earns more suspicion must not produce the quieter report.
`private` counts as a terminal outcome, on ADR 0012's mapping of a delisted posting to closed.

**Nothing the plan says about itself is taken.** [plan.mjs](plan.mjs) is the one place that reads
`plan.json`, and it reads it under one rule, which five review rounds are the reason for: a field the
plan writes about itself is either _derived_ from something the plan did not choose, or
_corroborated_ by an artifact the plan did not write, or it does not verify. There is no fourth
branch, and the rounds each found the family at a fresh field — the declared key, the duplicate flag
in two checks, the declared windows, the declared action.

- the identity key is derived from the link; a declared key that disagrees is `plan_item_key_mismatch`;
- duplication is derived from the plan's own earlier rows, with one outcome per shape: a row
  repeating the **identical link** is a copied row (`plan_item_duplicate`) and accounts for nothing;
  a different spelling that normalizes onto the same link is one link as far as the range is
  concerned, so it is dropped without a finding; a different spelling of the same **posting** is the
  honest duplicate — two LinkedIn spellings collapsing to a single record — and one the plan did not
  mark is `plan_item_duplicate_undeclared`; a first sighting that calls itself a duplicate is
  `plan_item_duplicate_unclaimed`. The first row for a key always wins;
- no date enters a skip: a `cadence_days` or `recheck_due_on` a plan carries is ignored, and an
  action name this build does not plan (`skip_recent`) is not a skip — such a batch is re-planned;
- `action` cannot be derived from anything in the directory — it is a claim about the ledger — so it
  is corroborated by the ledger or it does not verify. A skip accounts for its link only when the
  ledger row **supports** it — and undecidable is not support: a batch with no verified capture has
  no instant to tell a baseline row from its own write-back by — the fetch manifest's own `startedAt` first, taken
  before the request loop and so earlier than anything else in the directory
  (`manifest_started_at_unusable` where it is not a usable instant), then the captures' headers, then
  the manifest's per-record instants, which survive even where nothing persisted — and a row already
  carrying this batch's own
  observation is this batch's write-back rather than the baseline it claims to rest on. Both are
  `plan_skips_unverifiable`, for the terminal `skip_closed` as much as for `skip_known`, and so is a
  batch that dropped links without presenting the ledger at all. Only a link with no record is a
  drop: a `skip_known` row whose link has a record is the user's re-check, answered for by that
  record — its ledger row still has to exist — and `skip_closed` is never read that way.
  **That is why `--ledger` belongs in the per-batch invocation too.**

`assert` means a finding fails the batch. `diff` means the output is an input to
[docs/runbooks/triage-review.md](../../docs/runbooks/triage-review.md), not a verdict — a decision
that moved between two batches can mean the page changed, the policy changed or the extractor
changed, and choosing between those is a person's job. `attest` means the check verifies that a
record of a manual probe exists and is well-formed, and nothing about the probe itself; it is
labelled separately so a green row is never read as a measurement.

### A record that owes no capture and no evidence

A record may legitimately carry neither: it claims nothing about a page body — no usable access
outcome and no evidence quote anywhere. A `404` after retry is that case, and `tools/vacancy-fetch`
persists nothing for it by design.

That exemption is also the cheapest route to a green report, so it is a checked class rather than a
hole. Where a manifest exists it has to corroborate the declaration — a declared closure needs a
manifest outcome of `absent` or `closed` (`closure_not_corroborated`), a declared technical
unavailability needs `access_failure` (`unavailability_not_corroborated`) — and the implication is
checked in both directions, so a vacancy the source calls closed cannot be scored either. One
witness stands in for the manifest, and only where the manifest's verdict owes a browser retry — an
`active`, usable record and an `absent` one: a verified capture of that record which is not its own
fetch and is stamped `outcome: access_failure` corroborates a declared technical unavailability.
That capture is a transcript, so every record it corroborates is named in the difference
`unavailability_from_browser_retry`. Where no
manifest exists the class has no independent corroboration in the directory at all: the suite says
so as a difference (`unavailability_uncorroborated_no_manifest`) and every report carries the
per-outcome counts, because a batch drifting toward "unavailable" is the shape this would take.

### The baseline is the plan, not the live ledger

`baseline-diff` compares against `plan.json` — the snapshot `planBatch` took before the first fetch,
inside the artifacts directory. The ledger keeps one mutable row per vacancy and `recordBatch`
upserts it, so after the batch is recorded its own baseline is gone; reading it for the comparison
gives a diff that is premature or empty depending on run order. The plan is immutable, so the
comparison is reproducible for as long as the batch exists.

A plan row that **states** its baseline is the baseline; one that omits it is not evidence that none
existed, so where the ledger holds a pre-batch row for that link it serves instead. Writing less must
not be safer than writing the truth — the asymmetry every round of this review kept finding.

The assertions are that the batch obeyed the plan, in both directions. A record for a link the plan
marked `skip_closed` is `refetched_closed_vacancy`, and a record the plan never mentions is
`record_absent_from_plan`. Passing `--ledger` adds what the plan cannot check about itself — the plan
is written by the session being verified, so its rows are compared against the ledger's
(`plan_disagrees_with_ledger`), the row the ledger is asked about is derived from the link and never
read off the plan — a plan that names its own key gets `plan_item_key_mismatch`, because otherwise
the side under test would choose which row corroborates it — a link the plan _dropped_ must be one
the ledger actually supports
dropping — `skip_closed` needs a row that is not open, `skip_known` an open row whose decision is
not `BLOCKED`, which the plan owes a `retry_blocked`, and the row merely existing satisfies neither
(`plan_skip_uncorroborated`) — and a ledger already carrying an observation at or
after this batch's own fetch time is reported (`ledger_already_recorded`) rather than silently
producing an empty diff. That is also why the batch's closing order is fixed: verify, then record.

### The blind extraction is computed, not attested

`blind/NNN.input.json` is a second normalized input for one or two records, built by an agent that
saw only that record's capture. The root keys a capture cannot supply — `policyId`,
`schemaVersion`, `scoringDate`, `inputIndex`, `fx`, `explicitOverride` and the scoring values
`candidateScoring` — are copied from the primary input; without `candidateScoring` the blind input
is `blind_input_not_scoreable`. A blind input whose evidence quotes are the primary's, path for
path and value for value, is refused (`blind_extraction_not_independent`): two honest extractions of
one page do not quote every field identically, and the comparison is over the evidence rather than
the file's bytes, so a copy with one unrelated field edited is still a copy. The suite verifies its quotes against the same capture, scores it
with the same scorer, and compares a frozen list of outcome fields — decision, terminal code,
bucket, and the mobility observations — against the primary trace. A disagreement names the fields
that moved and stops there: the 2026-08-18 run's one catch was an error in the blind agent itself,
so which of the two extractions is wrong is a person's call.

### Evidence fields are discovered, not listed

`evidence.mjs` walks the normalized input and treats a string leaf as evidence when its own key
matches `/evidence/i` or it sits inside a container named `evidence`. A field added to
`tools/job-scorer/normalized-input.mjs` is therefore covered the day it is added. The other half is
in the test suite: the discovered path set is frozen as a literal, so a _renamed_ evidence field
shows up as a failing pin instead of a walk that quietly finds nothing.

### The negative-space vocabulary

`vocabulary/negative-space.v1.json` — a versioned data file with three families (residence phrasing,
contract phrasing, work format) and the page-chrome markers that end the main zone. Literal phrases
only: the text being scanned is a vacancy page, and a pattern language over untrusted input is a
denial-of-service surface and an escaping problem at once. Matching is case-insensitive,
whitespace-flexible between tokens, word-boundary guarded, and never crosses a blank line.

The **main zone** labels a hit; it does not excuse one. It runs to the first `zoneTerminators`
phrase that starts a line and sits after everything the record quoted, and an unanswered hit past
that offset is reported as `negative_space_outside_main_zone` instead of `negative_space_unclaimed`
— a different code, the same obligation. Two review rounds are why: while the zone granted a pass, a
page could hide a requirement below its own "Similar jobs" rail, and each narrowing of the rule was
followed by a reviewer reproducing it one line further down. A boundary that cannot exempt anything
cannot be moved by the page into exempting something. The cost is one disposition per chrome line
that carries a vocabulary phrase, which is the trade this suite takes.

A hit is **claimed** when its span lies inside an occurrence of an evidence quote **that belongs to
an offer whose family-relevant field is actually set**. Both halves are load-bearing, and the second
one was added after an independent review took the first apart: `offers[].evidenceQuote` is one
required string standing behind fourteen offer keys, so a record quoting "MUST BE currently based in
Singapore" while recording `residenceRestriction: "none"` is schema-valid, reproduces its own trace
byte for byte, and under containment alone would be _claimed_ — the exact silent flip this sweep
exists to catch. The table is three static rows in `checks/negative-space.mjs`: a residence hit
needs an offer with `residenceRestriction` at `compatible`/`incompatible`, a contract hit an offer
with `contractorEligibility` set or an `engagementPath`, a work-format hit an offer with a known
`workFormat`. Widening a quote therefore buys no silence, and negated wording ("no residency
requirement") lands in the disposition ledger, which is where a person looks at it.

Claiming is decided per capture and then merged: one record's two captures are two observations of
one page, so a line the browser capture quoted is answered for that record even where a degraded
fetch capture carries it unquoted.

An unclaimed hit must carry a **disposition** in `disposition.json`, keyed by
`(recordIndex, family, lineSha256)` where the digest is over the folded, whitespace-collapsed line.
A disposition that matches no live hit fails as stale, so explanations cannot accumulate; a page
that changed its wording changes the digest, so the explanation is taken again. The unit is a line
and a family rather than a line and a phrase, because several spellings of one family land on one
sentence routinely.

```json
{
  "schemaVersion": 1,
  "batchId": "2026-08-23-linkedin-1-20",
  "dispositions": [
    {
      "recordIndex": 2,
      "family": "work_format",
      "lineSha256": "…",
      "disposition": "not_a_requirement",
      "note": "A benefit, not a work-format statement."
    }
  ]
}
```

`disposition` is one of `not_a_requirement`, `boilerplate`, `already_recorded_elsewhere`,
`outside_scope`.

### The periodic attestation

```json
{
  "schemaVersion": 1,
  "batchId": "2026-08-23-linkedin-1-20",
  "probes": [
    { "probe": "phase0_capability_probe", "ranAt": "…", "verdict": "held" },
    { "probe": "transport_hypotheses", "ranAt": "…", "verdict": "held" }
  ]
}
```

Two probes, closed set, both required under `--cadence full`. `verdict` is `held`, `changed` or
`failed`; `failed` is a finding. Freshness is a window with two sides, both decided against the
batch's own capture timestamps rather than a clock: a probe more than a day before the first fetch
is `probe_stale`, one more than a day after the last is `probe_out_of_window`, and re-running the
suite a month later therefore reaches the same verdict.

**This check verifies that the probe was run and recorded. It does not verify the probe.** A
self-reported record in the batch's own directory is weaker than a measurement and stronger than a
promise in prose, and that is the whole claim — which is why its kind is `attest`. The third probe
of the 2026-08-18 protocol, the blind double extraction, is not here: it became a computed check.

## Modules

| Module                             | Owns                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| [cli.mjs](cli.mjs)                 | argument parsing, exit codes, the bounded stdout summary, writing the report        |
| [suite.mjs](suite.mjs)             | the context every check reads, the cadence sets, the report shape                   |
| [artifacts.mjs](artifacts.mjs)     | reading the directory; a defective batch loads, an unreadable one is a caller error |
| [manifest.mjs](manifest.mjs)       | the fetch manifest, read once, and the derived capture provenance                   |
| [links.mjs](links.mjs)             | the links file and the batch range                                                  |
| [evidence.mjs](evidence.mjs)       | the schema-driven evidence walk                                                     |
| [text-scan.mjs](text-scan.mjs)     | index-preserving case folding, literal and phrase scanning, line digests            |
| [vocabulary.mjs](vocabulary.mjs)   | loading and validating the versioned vocabulary                                     |
| [disposition.mjs](disposition.mjs) | the disposition ledger's schema                                                     |
| [checks/](checks)                  | one module per check                                                                |

## Residual

The capture header is outside the digest `verifyCaptureFile` recomputes — that digest covers the
body — so `fetched-at`, which four gates rest on — skip support, the write-back guard, the baseline
fallback and probe freshness — is only as good as whatever wrote it. A stamp that is present but not an
unambiguous instant is a finding of its own (`capture_fetched_at_unusable`), because otherwise
writing the time unreadably would be quieter than leaving it out. Unambiguous means it carries its
own zone: [instants.mjs](instants.mjs) is the one predicate all four gates share, and a zoneless
stamp would otherwise be read in the host's timezone — dating the same directory differently on
every machine, and in either direction relaxing a gate. Read later, on a host behind UTC, the
write-back guard stops firing and a row this batch recorded passes as a baseline. Read earlier, on
one ahead of it, a healthy baseline row reads as the batch's own write-back and a recordable batch
is refused. The probe window loses whichever of its two sides the drift points away from.
Where the manifest names the capture the two are compared (`manifest_capture_fetched_at_mismatch`);
on a transcript there is nothing to compare it against, and the batch instant is the model's word,
like the body beside it.

Nothing here proves authorship. An actor able to write into the artifacts directory can write a
self-consistent capture header beside fabricated text, and can write a plan, a disposition and an
attestation to match. For a transcript capture the gap is not even adversarial: the bytes on disk
are what a model wrote down, so a green per-batch report over a fully transcribed batch asserts
internal consistency and nothing more. That is ADR 0011's same-UID filesystem residual, already named in
`tools/vacancy-fetch/persist.mjs`, and this suite does not close it. What it does close is the
distance between what a batch recorded and what its own files say.

### Independent ToolMatch epoch

Policy v8 (`triage-policy-v8-2026-10-01`) requires input schema 9 and taxonomy v6. Completeness
reports `policy_drift` before recomputation when the input schema/policy or trace policy/taxonomy
belongs to another epoch. Existing batches are not migrated; verify them with their original
engine. Re-score only as an explicit new batch with scope and exact evidence for each observation.
