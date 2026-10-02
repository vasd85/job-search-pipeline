# Rollout of the vacancy-fetch transport

Status: **the procedure is done.** `tools/vacancy-fetch/` is the default transport of triage
([what makes a transport the default](#7-what-makes-a-transport-the-default)): the CLI requires
`--batch <label>`, and every manifest carries `isDefaultTransport: true`. The sections
[where to run it](#2-where-to-run-it), [preparation](#3-preparation), [run](#4-run),
[what to measure](#5-what-to-measure) and [written comparison](#6-written-comparison) remain the
procedure of a measured comparison of transports and are needed when the comparison is repeated.

The owner of the tool's own behaviour is
[tools/vacancy-fetch/README.md](../../tools/vacancy-fetch/README.md). This runbook owns only the
comparison procedure: where to run it, what to measure, what the written comparison looks like, and
what exactly makes a transport the default.

## 1. Why

The verified `/score-jobs` run of 2026-08-18 ran into the cost of the transport: under the browser
transport every byte of the JD crosses the model context twice (tool result → file write), and that
is exactly what limited the batch to ten vacancies. On top of that, the 88-probe copy-fidelity check
was needed only to keep the "model as file transport" path under control.

A plain-HTTP probe in the same run got 4/4 LinkedIn guest pages without an authwall. That is N=4,
one IP, one time of day — not enough to change the default. The procedure below turned that probe
into a measurement on a full batch; the outcome is
[what makes a transport the default](#7-what-makes-a-transport-the-default).

## 2. Where to run it

A real batch is a run over live links, not part of a task worktree.

- The measured batch runs from a **rehearsal worktree** pinned to the measured sha (the
  `rehearsal/<label>` role), with its preflight — both in
  [rehearsal-worktree.md](rehearsal-worktree.md). That is its proper place: a measured run is a
  measurement, not the processing of vacancies, so its state must not reach the operational ledger.
- `main` and task worktrees do not use real vacancy URLs for a run; how a run differs from reading a
  live page is set by invariant 6 of
  the gitflow invariants (in the private pre-switch archive). The task's
  deterministic gate stays offline: live network probes are not part of it.
- The tool does not write to `process-log.json` and publishes nothing to `output/`, so batch triage
  is still not a per-role process and is not logged.
- `--out-dir` is the batch's working directory, always as an absolute path (the CLI resolves a
  relative one against the caller's cwd). In a rehearsal worktree it is
  `<abs-rehearsal-path>/.rehearsal/batches/<batch-label>/`. Never the reserved
  `output/<company-role>/`.

## 3. Preparation

1. Collect the batch's list of links. The order and freshness of the collection are owned by
   [the pre-triage rules](triage-review.md#21-pre-triage-freshness-order-composition): newest-first,
   and a collection older than the window (or one without a collection date) first goes through a
   liveness sweep. The policy is only mentioned here.
2. Create an ADR 0011 envelope under steps 1-5 of the
   [safe input-file producer procedure](../../instructions/pipeline-artifacts.md#safe-input-file-producer-procedure)
   — input root, nonce, exclusive create with mode `0600`, the file closed before invocation, the
   cleanup rule. The compatibility table in the same section lists the subcommands of
   `tools/process-log.mjs` and does not extend to this CLI; the shape of `values` is owned by
   `tools/vacancy-fetch/input-schema.mjs`: `command: "fetch"`, `values.urls` — the ordered links.
   URLs never reach the command line.
3. Create an empty `--out-dir`. The tool rejects a directory that already holds a manifest: the
   manifest of an earlier batch is evidence, not a target to overwrite.
4. Record before the run: the number of links, the collection date, the batch label.

## 4. Run

```sh
node tools/vacancy-fetch/cli.mjs fetch \
  --input-file input-0123456789abcdef0123456789abcdef.json \
  --out-dir <absolute working directory> \
  --batch <label> \
  --delay-ms 2000
```

The nonce is illustrative — a fresh one is produced for every batch. The first run uses the default
settings: sequential, a pause of ~2 s, `--on-rate-limit stop`. They must not be changed in the first
run: the comparison measures exactly the mode in which the layer works by default.

Exit code `2` — at least one record needs the browser fallback, stayed unattempted, or is a `usable`
record flagged `deferred_content_suspected` that owes the browser a completeness check; `1` — a
caller error; `0` — none of these cases. `0` is not a promise that every record is usable: a
terminal `absent` record moves neither counter, and it owes its confirming load to the skill's
rule, not to this code. Code `2` is not a failed run but its normal outcome: it is the explicit
failure signal for the caller.

## 5. What to measure

The measurements come from `fetch-manifest.json` and from a counter-run of the same list through the
verified browser transport. The counter-run is mandatory: a comparison without it is a report on one
transport, not a comparison.

**Fidelity** — for every link where both transports are usable:

- whether the extracted text matches in substance: title, company, location, work format, salary,
  the body of the JD; divergences are listed line by line, not as a summary score;
- whether the terminal outcome matches (`active` / `closed` / `private` / `absent`) and, if not,
  which transport was wrong and on which observation;
- which fields exist only in the browser version. The 2026-08-18 run already showed that the
  workplace badge is missing from guest HTML — the comparison checks whether that still holds and
  whether other such fields have appeared;
- whether the identity guard fired: `structural.jobIdPresent` for every LinkedIn record.

**Cost** — from the manifest and from the session's observation:

- `summary.responseBytes` and `summary.persistedBytes` against the estimate of JD bytes that
  crossed the model context under the browser transport;
- the batch's wall-clock (`startedAt`, `finishedAt`) and the sum of `durationMs`;
- how many vacancies needed the browser fallback — the residual cost of the transport on this
  batch. The share is set by the composition of the link list and does not carry over from batch to
  batch: it is reported as an observation of the run and is not read as a verdict on whether the
  transport pays off.

**Rate-limit behaviour** — recorded explicitly, even if nothing happened:

- whether there was a `429`, on which record, with which `retry-after`;
- whether the batch stopped (`stoppedEarly`) and how many records stayed unattempted;
- whether there were `anti_bot` or `authentication` barriers, and on which sources. For LinkedIn
  separately: whether the status `999` occurred.

## 6. Written comparison

The result of the comparison is one document, not a chat message. It contains:

| Section | Content |
| --- | --- |
| Batch identity | label, date, number of links, collection date of the list, adapter versions |
| Fidelity | a table per link: usable for each transport, field agreement, divergences verbatim |
| Cost | bytes, wall-clock, fallback share, estimated saving of model context |
| Rate limits | everything from [what to measure](#5-what-to-measure), including an explicit "not observed" |
| Adapter degradations | every record with `structuralOk: false` and its reason code |
| Verdict | what becomes the default, what stays a fallback, what was not checked |

The document refers to the batch's `fetch-manifest.json` and to the capture files by their digests
instead of copying the JD. `verifyCaptureFile` re-checks every capture file against its own header
before its figures reach the comparison.

## 7. What makes a transport the default

The calling order and the promotion of the tool are different things, even when they say the same.
[instructions/skills/score-jobs.md](../../instructions/skills/score-jobs.md) calls the adapter
layer first and keeps the in-app browser as the verified fallback: a record the layer did not
return as `usable` goes to the verified transport — on its own signal `fallback: "browser"` — while
a terminal `absent` record, which carries no such signal, goes to one confirming load. A third class
goes there too: a `usable` record flagged `deferred_content_suspected` — the layer returned the
body but does not vouch for its completeness, and the browser checks exactly the completeness. And
a fourth: a `usable` record whose capture holds no description of the posting — a wall or a shell
the layer did not recognize; the layer considers it done, the procedure does not. An ordinary triage
batch therefore simply calls the layer and reports the transport split in its summary; the
[written comparison](#6-written-comparison) is needed not for every batch but when the comparison
is repeated.

**Promotion done.** On 2026-09-01 the experimental marking was removed: the mandatory label is
called `--batch`, every manifest carries `isDefaultTransport: true`, and the adapter layer is the
default transport of triage. The basis is the [written comparison](#6-written-comparison) for the
2026-08 run and the user's decision that closed the last open condition. The conditions the
promotion was set under, and how each of them was closed, are kept in the private development
history; they are not repeated here, because nobody acts on them any more.

## 8. Rollback

No data rollback is needed: the tool writes only to its own `--out-dir` and publishes nothing. The
rollback of one batch happens by itself: a record the layer did not return as `usable` goes to the
browser — on its own signal or, for a terminal `absent` record, to a confirming load — and a
`usable` record flagged `deferred_content_suspected` goes there too for a completeness check, and a
`usable` record without a description of the posting — to the retry; the limiting case is a batch
served entirely by the browser transport. Rolling back the calling order itself is an edit of the
canon (`instructions/skills/score-jobs.md`), not a decision of the call site. Capture files already
written stay as evidence of past runs and are not reused as the source of a new scoring run without
a new fetch.

**An interrupted batch is not resumed.** A batch that failed with an error still writes its
manifest, so the record of the requests already made is kept. A batch killed from outside leaves
capture files without a manifest — and a restart into the same directory is rejected with
`out_dir_occupied` instead of failing halfway. In both cases continuing means a new directory and a
repeated fetch of every link, including those already fetched. For the comparison this means a
broken-off run gives no partial result: it has to be taken again in full and recorded in the
comparison as a separate attempt.

## 9. Boundaries

- Green fixtures in `tools/vacancy-fetch/fixtures/` pin this repository's parsing contract, not the
  behaviour of the outside world. A live check of a route exists only in the measured run of this
  runbook.
- The tool does not prove the authorship of its capture files: an actor who can write arbitrary
  bytes into the working directory will write a self-consistent header next to a fabricated text.
  This is the same-UID filesystem residual of
  [ADR 0011](../adr/0011-untrusted-input-safe-cli-transport.md), and it is not closed.
- Raw HTML is not stored, so an extraction cannot be re-checked from the working directory — only
  fetched again.
- This runbook decides nothing about Step 1 publication: the typed extractor core, vacancy v2 and
  the capture artifact of [ADR 0012](../adr/0012-versioned-extraction-and-vacancy-v2.md) are a
  separate line of work, and the user's open question about the generic fallback stays open there.
