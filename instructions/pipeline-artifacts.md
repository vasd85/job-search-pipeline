# File-backed pipeline artifact contract

This is the shared runtime-neutral procedure for the five per-role application steps. The
step-specific skills define what to research or author; this file defines how a step selects a
process, opens an attempt, publishes files, and reports the result.

All five steps require explicit user intent. Completing one step does not authorize starting the
next one unless the user's request explicitly covered that next step.

## Machine-owned contracts

Do not reproduce or improvise the ledger or artifact schemas in instructions:

- `tools/lib/process-log-v3-validation.mjs` owns the exact process-log record shapes, lifecycle
  values, timestamp/dependency invariants, artifact inventory, and canonical artifact-path
  constraints. Ledger schema v4 extends v3 with the waiver machinery of ADR 0015 on the two
  generation steps only: journaled waiver records and the attempt's pending set, revision attempt
  metadata (operation, channel, pre-attempt mark), open-conflict journaling, archived-bundle
  digests, and the journaled adoption base; every earlier record stays byte-compatible. The
  pending set belongs to the attempt, not to the revision operation: the letter's word-limit
  approval rides a first publication the same way.
- `tools/lib/process-log-diagnostics.mjs` owns the persisted diagnostic limits, stable-code grammar,
  and frozen conservative forbidden-shape detector.
- `tools/lib/process-log-v3-lifecycle.mjs` owns protected-input snapshots, transitions,
  invalidation, reservation, publication, staging inspection, reviewed cleanup, and recovery
  behavior.
- `tools/process-log.mjs` is the only normal lifecycle/company-registry mutation CLI.
- `tools/pipeline-artifacts/` owns the Step 1 and Step 2 artifact schemas and cross-file validation.
- `tools/application-brief/validate.mjs` owns the Step 3 schema and reference checks.
- `tools/cv-builder/` owns targeted CV preflight, rendering, and structural QA.

When prose and a machine-enforced contract disagree, stop and report the mismatch. Do not work
around a validator or create a second lifecycle file.

## External values in lifecycle commands

The [operating contract](operating-contract.md#untrusted-external-data-boundary) owns the trust
classification, shell prohibition, allowed data boundaries, and fail-closed availability behavior.
That policy applies to every step, including source-ref selectors and source-derived diagnostics;
this shared contract defines only their lifecycle-specific use.

[ADR 0011](../docs/adr/0011-untrusted-input-safe-cli-transport.md) owns the file-transport
design. Process/company/attempt/publication ids, fixed step/outcome names, and exact
machine-returned output paths remain validated flags. Failure/blocker objects use
repository-owned stable messages and compact safe details; never copy raw page text, a hostile
value, source bodies, full logs, secrets, or stacks into a CLI diagnostic or the ledger.

## Safe input-file producer procedure

Use this procedure whenever a repository CLI crosses a shell and needs one of the external values
listed in ADR 0011. Steps 1 to 5 are transport mechanics and hold for every such CLI; the command
vocabulary tabulated below is `tools/process-log.mjs`'s own. The runtime's structured filesystem
API, not a shell command, is the producer:

1. Resolve `JOB_PIPELINE_INPUT_ROOT`, or use the absolute
   `<workspace>/.pipeline-input` default. Create that exact directory only when absent, as a real
   directory owned by the current UID with mode `0700`. Do not accept a symlink or repair an
   existing unsafe root.
2. Generate 16 cryptographically random bytes and encode them as 32 lowercase hexadecimal
   characters. Build the direct-child basename `input-<nonce>.json`; source data never contributes
   to the name.
3. Build one exact command-bound ADR 0011 envelope in memory. Create the file exclusively, with
   mode `0600`, write the UTF-8 JSON bytes literally, finish the write, and close it before invoking
   the CLI. Do not use a heredoc, pipe, environment value, `echo`, `printf`, or generated shell
   escaping to produce it.
4. Invoke the CLI with only the controlled basename, repository-owned subcommand, and validated
   machine tokens. The basename in the command and the envelope nonce must match. Do not combine
   `--input-file` with a legacy external-value flag.
5. Keep the immutable file after a crash, timeout, or unknown outcome and retry that exact logical
   operation with the same basename. The CLI never deletes it. After a terminal response, the
   producer may remove only that exact file after proving that its device/inode still match the
   created file; never use recursive, glob, or age-only cleanup.

For example, after the structured producer has closed the exact `start` envelope defined in ADR
0011 with nonce `0123456789abcdef0123456789abcdef`, the matching shell invocation is exactly:

```sh
node tools/process-log.mjs start --input-file input-0123456789abcdef0123456789abcdef.json --runner codex
```

Other Step 1 external-value operations use their own freshly produced command-bound file:

```sh
node tools/process-log.mjs update --id proc_... --input-file input-11111111111111111111111111111111.json
node tools/process-log.mjs find-company --input-file input-22222222222222222222222222222222.json
node tools/process-log.mjs create-company --input-file input-33333333333333333333333333333333.json
node tools/process-log.mjs add-company-term --id company_example --input-file input-44444444444444444444444444444444.json
node tools/process-log.mjs add-company-domain --id company_example --input-file input-55555555555555555555555555555555.json
node tools/process-log.mjs revise-step --id proc_... --step write_cover_letter --channel chat_command --input-file input-66666666666666666666666666666666.json
```

The nonce above is illustrative; generate a fresh one for each new logical mutation. The accepted
payload fields and the flags that remain outside the file are:

| Command                                       | Envelope `values`                                                                         | Validated flags outside                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `start`                                       | `sourceRef`, optional `companyHint`                                                       | `--runner`, optional `--duplicate-of`                               |
| `update`                                      | one or more of `companyObserved`, `companyHint`, `role`                                   | `--id`, optional `--clear-company-hint`                             |
| `resolve`                                     | exactly `sourceRef` for the fallback                                                      | alternatively `--id` or `--output-dir` without an input file        |
| `find-company`                                | `query`                                                                                   | none                                                                |
| `create-company`                              | `displayName`, optional `term`, `domain`                                                  | none                                                                |
| `rename-company`                              | `displayName`                                                                             | `--id`                                                              |
| `add-company-term`, `remove-company-term`     | `term`                                                                                    | `--id`                                                              |
| `add-company-domain`, `remove-company-domain` | `domain`                                                                                  | `--id`                                                              |
| `publish-step`                                | optional command-bound `blocker`; optional `waivers`, the letter word-limit approval only | selector, `--step`, `--attempt-id`, `--publication-id`, `--outcome` |
| `fail-step`                                   | required command-bound `error`                                                            | selector, `--step`, `--attempt-id`                                  |
| `revise-step`                                 | optional `waivers`: subject (`kind`, `key`) plus bounded user-owned `note`                | selector, `--step`, `--channel`, `--adopt`                          |

Each diagnostic object has exact keys `code`, `message`, `retryable`, and optional `details`.
The producer supplies a bounded stable code and retryability; `message` and `details` remain
required/optional envelope-shape fields but are never ledger prose. The transport discards them
and substitutes a repository-owned message in the default language plus empty details before
invoking lifecycle code. Input validation limits a diagnostic code to 64 ASCII stable-code characters, its input
message to 512 UTF-8 bytes, and input details to at most eight strings of 256 UTF-8 bytes each.
A `tools/process-log.mjs` command not listed in the table does not accept `--input-file`. Another
CLI carries its own accepted `command` and `values` shape in its own input schema, not here:
`tools/vacancy-fetch/input-schema.mjs` owns the one the triage fetch layer accepts, and
[score-jobs.md](skills/score-jobs.md) invokes it through these same five steps.

The same exact numeric limits apply after transport to every diagnostic accepted directly or read
from the ledger. Persisted message/details must be one-line valid Unicode scalar text. The shared
validator rejects URLs, absolute paths, stack frames, private-key markers, credential assignments,
bearer tokens, and the frozen high-confidence token prefixes. This is a conservative
forbidden-shape detector, not universal secret detection: callers must still use repository-owned
prose and must never put raw source material or credentials into a diagnostic.

CLI failures are bounded JSON. They retain a stable `code` and `message`; when the typed failure
class provides them, they also retain bounded `context`, `cause_code`, and `recovery_action`.
If a primary filesystem operation and its required cleanup/release both fail, the primary class
remains authoritative and bounded `secondary_errors` preserve the additional recovery evidence.
Absolute paths, parser prose, stacks, and raw exception text are not operator output.

## Timestamp and chronology boundary

`tools/lib/process-log-v3-validation.mjs` owns a future-skew ceiling of exactly 300000 milliseconds
(five minutes). Timestamp ordering compares ISO instants, not their lexical spellings. Root,
process, step, active-attempt, attempt-history, prepared-publication, and diagnostic timestamps must
remain within the process bounds and satisfy their causal/dependency order. Terminal attempt
history and its step share the same finish instant.

Lifecycle mutations additionally reject a non-ISO, backward-moving, or too-far-future clock value
with stable code `invalid_mutation_timestamp` before writing the ledger. The public validation and
lifecycle paths use the wall clock directly; callers do not receive a production time override.

## Selecting an existing process

A selector is not generated or assembled for each command. It is one exact lookup value already
owned by the process record. The actor executing the explicitly requested step chooses the option
mechanically, in this order:

1. Use `--id <process-id>` whenever the process id is known. This is the normal path: Step 1 keeps
   the `process.id` returned by `start`, and `resolve` returns the same id for later commands.
2. If the id is unavailable but the exact reserved path is known, use
   `--output-dir output/<company-role>`. Copy the path returned by `reserve-output` or stored in
   `process.output_dir`; never reconstruct it from a company and role name.
3. If neither is available and the exact stable reference used to start the process is known, use
   the source-ref fallback only through the safe transport from ADR 0011 or a true structured argv
   caller. Copy `process.source_ref`; do not substitute a browser URL, manually normalize it, or
   place it in a shell command.

The user may supply one of these existing values in the request. When one explicit run covers
sequential steps, the actor may instead carry forward the process id returned by the preceding
lifecycle command. In a fresh run with none of the three exact values, stop and request the process
id; a company or role name is not a selector. The CLI does not decide among candidates.

Pass exactly one option to `node tools/process-log.mjs resolve <selector>` before continuing:

```sh
node tools/process-log.mjs resolve --id "proc_..."
node tools/process-log.mjs resolve --output-dir "output/company-role"
```

If more than one value is known, use the first applicable option in the order above; do not combine
them. An output directory or source ref is usable only when `resolve` finds exactly one file-backed
process. After a successful lookup, use the returned `process.id` as `--id` for the remaining
commands in that step. If lookup finds none or several, stop and request the process id instead of
guessing from the company, role, or chat history.

## Historical records

Old-shape records are historical and read-only. They may be viewed and searched, but no numbered
step may resume, mutate, or adopt their output. A new application attempt uses `start` and, when
the duplicate policy requires it or the user declares the vacancy already known, explicitly
links the new file-backed attempt with `--duplicate-of <historical-or-earlier-id>`. The same
link is written or withdrawn afterwards with `link-duplicate`, and `report-duplicate-chain`
reads the whole chain from any of its members. Both take machine ids only and, like
`link-company`, accept no `--input-file`. A link records provenance only: the linked
record runs every step itself, and the target is never resumed, reused or written to.

## Artifact ownership

Only the owning step authors each canonical artifact:

| Step | Step key             | Canonical artifact                              |
| ---- | -------------------- | ----------------------------------------------- |
| 1    | `get_vacancy`        | `job-description.txt`, `vacancy.json`           |
| 2    | `research_company`   | `company-research.json`                         |
| 3    | `map_experience`     | `application-brief.json`                        |
| 4    | `generate_cv`        | `cv.json`, the DOCX named by `cv.json.fileName` |
| 5    | `write_cover_letter` | `cover-letter.txt`                              |

The ledger owns lifecycle state and artifact metadata. Canonical files own substantive content.
Chat is never an input, recovery source, or substitute artifact. Chat may direct a `revise-step`
revision of a published generation material, but the content still crosses the step boundary only
as staged, validated files.

The per-process `review-remarks.md` in the output directory is an append-only content file for
review feedback worth generalizing. It carries no lifecycle state, is consumed by nothing
automatically, and lives outside step bundles; promoting a remark into `knowledge/` canon remains
a deliberate user decision.

The per-process `letter-reader-report.md` in the output directory is an append-only content file of
the same class, written by Step 5: one entry per blind reading of a staged letter. It carries no
lifecycle state, gates nothing, and lives outside step bundles; the procedure that writes and reads
it is `write-cover-letter`.

Steps 1–3 are linear. After a current Step 3 completion, Steps 4 and 5 are independent siblings;
one generation step may proceed when the other is pending, blocked, or failed.

## Publication integrity is not application readiness

Every Step 1–5 procedure inherits the
[manual application-readiness checklist](../docs/runbooks/application-readiness-checklist.md).
Lifecycle `completed/current` means only that published canonical bytes are intact and their
committed input snapshots remain current. It does not prove live-source fidelity, claim truth,
research freshness, visual QA, editorial quality, or human approval.

Run the applicable checklist sections from visible sources and canonical files before using the
materials. The checklist is review guidance: it does not mutate the ledger, clear the derived UI
warning, or create a second status/approval manifest. If review finds a discrepancy, revise the
owning step through the explicit lifecycle: `reopen-step` re-authors it; a light post-review edit
of a published Step 4/5 material goes through `revise-step`.

## Open or resume an attempt

Step 1 is special: `start` atomically creates the process with `get_vacancy` already running. Keep
both `process.id` and `process.steps.get_vacancy.active_attempt.id` from its JSON result.

For a continuing step:

1. Resolve the selector and inspect the selected step.
2. Run `preflight-step <selector> --step <step-key>`. This rereads and validates exact prerequisite
   artifacts and protected canonical inputs. A `revise-step` revision skips it: preflight refuses
   `prerequisite_stale` on exactly the live-input drift the revision is defined to survive, and the
   revision validates against its own pinned snapshot instead.
3. Open work with the command appropriate to the current record:
   - `begin-step` for untouched work;
   - `retry-step` only for a retryable blocked or failed attempt;
   - `reopen-step` only for a completed or stale step that the user explicitly wants re-authored;
   - `revise-step` only for a completed or stale Step 4/5 material the user wants lightly edited
     after review, with the edit channel named by `--channel`.
4. Keep the returned `attempt_id` and input snapshot. Never reuse a token from an earlier attempt.
   For `generate_cv` and `write_cover_letter`, `preflight-step` and `revise-step` also return
   `sibling_decision_waivers`: the other material step's active `decision` waivers on the brief
   digest this step publishes from. A `decision` waiver binds both materials of that brief; the
   step reads them before authoring and its skill owns what they change.

Do not manually change lifecycle state. Revision has exactly two entrypoints with disjoint scopes.
`reopen-step` re-authors a step against live inputs and performs the required descendant
invalidation; if it reports a running dependent, finish or explicitly fail that dependent attempt
before reopening upstream work. `revise-step` opens a light revision of a published Step 4/5
material against the step's own pinned published-input snapshot: it never marks anything stale,
knowledge-file drift neither blocks it nor is cleared by it, and it is refused with
`brief_superseded` when the committed `application-brief.json` bytes no longer match the pinned
digest — that situation is a regeneration case for `reopen-step`. Its three channels are not
interchangeable: `chat_command` has no divergent bytes and never adopts, and the reverse-sync
channel `docx_sync` is defined only for `generate_cv`, whose bundle is the only one with a
rendered document, and only together with `--adopt`. A publication closing a
revision journals its edit channel, the waiver decisions supplied to `revise-step`, and any
unwaived brief-coupled findings as open conflicts; intrinsic format and package rules stay hard —
the one bounded exception is the letter's upper word limit, which an explicit user approval
journaled as a `check` waiver `letter_body_words_max:<N>` moves to N, at most
`candidate.config.letter.body_words.approved_max`. That approval is
the one waiver a publication outside a revision also takes, supplied to `publish-step` by the
letter's first publication or its re-authoring; everything else it might carry stays a hard
refusal —
and an honesty-floor conflict is resolved only through the
[user-confirmed deviation](../knowledge/precedence.md#user-confirmed-deviation) procedure —
surfaced, explicitly confirmed in chat, restated in the summary — never by a waiver. A revision
attempt that closes without a publication restores the step's pre-attempt mark, and a revision
publication finalizes `completed` or `stale` by raw digest comparison of the pinned snapshot against
current bytes.

## Step 1 output reservation

After Step 1 observes the exact company and role, update the process identity and company link, then
run:

```sh
node tools/process-log.mjs reserve-output --id "<process.id>"
```

The command derives and reserves the path, records ownership before directory creation, handles
collisions, and returns the exact `output_dir`. Callers never choose, rename, clear, reuse, or adopt
an output path. Later steps reuse the ledger path and never reserve or create another directory.

If reservation was recorded but directory setup was interrupted, use the guarded
`reconcile-step --id "<process.id>" --step get_vacancy` path. Do not create or adopt the directory
outside the lifecycle command.

## Candidate staging and validation

Canonical artifacts are never authored or revised in place. A manual in-place edit of a published
Step 4/5 artifact stays `artifact_corrupt` until the user explicitly asks to adopt it:
`revise-step --adopt --channel manual_file` journals every observed divergent digest first and then
copies — never moves — the divergent bytes into fresh staging, so the canonical slot keeps the
user's bytes until the publication's backup phase. Of the CV bundle only `cv.json` is staged that
way; a divergent DOCX is journaled and archived with it but never staged, because the published
document is always builder-rendered. `revise-step --adopt --channel docx_sync` is that same
preamble opened for the document itself: the archived copy is the reverse sync's input, and Step
4's own procedure owns how the edits inside it reach the staged `cv.json` and what happens to an
edit that cannot be mapped. Outside that journaled preamble, divergence
remains corruption. For every attempt:

1. Choose a globally unique publication id containing only letters, numbers, `_`, and `-`.
2. Create one fresh, non-symlink candidate directory at
   `output/<company-role>/.pipeline-tmp/<publication-id>/`.
3. Write only this attempt's candidate artifacts there, using their canonical basenames.
4. Run the step-specific validator or builder against the staged files and current canonical
   prerequisites.
5. Perform the human QA the step's operation requires before publication: a first or reopened
   publication runs the step's full QA profile; a `revise-step` publication runs the light
   revision profile — the full deterministic gates, waiver-aware, with visual inspection only of
   the rendered CV page(s) whose content changed.

Do not put a mutable `run.json`, state manifest, or second ledger in the output directory. Do not
rename staged files over canonical paths yourself.

### Staging diagnostics and reviewed cleanup

`validate --deep` inspects only bounded metadata below each owned `.pipeline-tmp` directory. It
classifies direct publication directories as prepared recovery evidence, committed-history
evidence, foreign ownership, active-but-not-yet-journaled work, orphan staging, or an invalid
entry. It does not read staged artifact bytes or return nested names. Orphan and invalid inventory
put the process in `attention`; active and recovery-owned inventory remain visible without being
called orphaned.

Cleanup is never automatic and has no hook or hidden age threshold. First request an exact scoped
review; this is read-only and reports bounded age/modified-time and aggregate tree identity:

```sh
node tools/process-log.mjs cleanup-staging --id proc_... --publication-id publication_... --dry-run
```

After reviewing that response, repeat the same exact process/publication scope with its returned
token:

```sh
node tools/process-log.mjs cleanup-staging --id proc_... --publication-id publication_... --confirmation-token <sha256>
```

Confirmation is rejected if the process has any active attempt, the id belongs to prepared or
committed history, the target is unsafe or unbounded, or its ownership/inode/tree inventory has
changed. The command removes only that direct publication directory and never changes the ledger.
The target root modified time used to calculate age is bound into the confirmation token; the
changing numeric `age_ms` value is operator evidence, never deletion authority by itself.
As with the repository's existing path-based filesystem boundary, a same-UID writer still exists
outside the process-log lock; the repeated identity/tree check narrows but does not eliminate the
final check-to-remove race.

## Publish, block, fail, and recover

Publish a validated candidate bundle with the matching attempt token:

```sh
node tools/process-log.mjs publish-step <selector> \
  --step "<step-key>" \
  --attempt-id "<attempt-id>" \
  --publication-id "<publication-id>" \
  --outcome completed
```

Steps 1 and 2 may preserve a validator-valid partial bundle with the controlled
`--outcome blocked` flag. Transport the command-bound blocker object only through ADR 0011 or a
true structured argv caller; never use a legacy `--blocker-json` value in a shell invocation.
The blocker code must resolve to the ambiguity/gap in the staged artifact. Other steps report
execution problems with `fail-step`; they do not publish a blocked bundle.

Failure and blocker JSON contains a stable lowercase snake_case code, a concise human-readable
message in the default language, a retryability boolean, and only compact safe details. The
message never repeats the code: a code is the machine's handle, the message is the explanation. Never place
secrets, raw page bodies, full logs, or stack traces in the ledger.

After an execution failure, close the matching running attempt only after transporting the
command-bound error object through ADR 0011 or a true structured argv caller.

Publication is ledger-journaled and replaces the complete bundle under the process-log lock. A
same-digest revalidation is idempotent; different bytes require a current reopened, retried, or
revised attempt. An input-snapshot or revision conflict must fail rather than overwrite newer
work.

Every Step 4/5 publication additionally archives its committed bundle bytes under
`output/<company-role>/.revisions/<publication-id>/` before its transaction directory is removed.
The archive is content-only and write-once: each archived file's digest is recorded in the
publication's history entry, `validate --deep` verifies the archive against those digests, and
retrospective comparison of revisions reads it. It is not a second status manifest and is never
adopted back by any lifecycle command.

If publication is interrupted after preparation, do not delete, move, or adopt evidence. Resolve
the process, take the exact attempt/publication ids from its prepared transaction, and run:

```sh
node tools/process-log.mjs reconcile-step <selector> \
  --step "<step-key>" \
  --attempt-id "<attempt-id>" \
  --publication-id "<publication-id>"
```

Reconciliation may prove and commit the new bundle or restore the old bundle. If it reports
`publication_recovery_conflict`, stop and preserve every file for review.

`validate --deep` is read-only. A tokenless `reconcile-step` may persist proven input drift as stale
or recover the narrow reservation-before-directory window; it never adopts changed artifacts.

## Optional isolated execution

Delegation is optional and must not change the contract. Use it only when it materially improves
research or visual QA. Delegate a whole step at most once, keep the shared workspace, pass only the
selector/paths and explicit request, and have exactly one actor publish. The parent consumes paths,
validation status, and a compact summary without repeating completed work. Direct local execution
is equally valid.

## Chat return

After publication or a terminal failure/blocker, return only a compact summary containing:

- process id and step outcome;
- reserved output directory and owned artifact paths when available;
- validation/QA result;
- any user-confirmed honesty-floor deviation applied to the published material
  ([the honesty floor](../knowledge/precedence.md#0-protected-honesty-floor));
- the stable blocker or error code and the one unresolved user decision, when applicable;
- for a revision publication: the journaled open conflicts and waiver notices, each naming its
  subject, so the user can choose per conflict between a waiver and an explicit Step 3 reopen;
- for any other publication that journaled a waiver: the record and the waiver notices it produced;
- for a Step 4/5 publication: the `sibling_decision_waivers` the material was authored under.

Do not paste the full JD, research report, brief, CV source, or cover letter into chat. One
exception exists for revision operations: the agent shows a bounded before/after diff of the
changed fragment(s) only, and a diff exceeding a bounded size is delivered as a file instead.
Continuity is guaranteed by the validated files and ledger within the same checkout/filesystem,
not by the session.
