# ADR 0010: File-backed application pipeline artifacts

- **Status:** Accepted
- **Date:** 2026-07-23

## Context

The numbered application pipeline currently preserves process identity in `process-log.json`, but
Steps 1 and 2 still hand substantive results to Step 3 through chat. Step 3 writes the only
persistent decision handoff, and Steps 4 and 5 have no shared lifecycle capable of representing
blocked work, revisions, stale inputs, or recoverable multi-file publication.

The pipeline must work identically in one session and across fresh sessions, retain existing process
and company history, prevent output collisions and stale writers, and keep the local web reader
read-only. The completed delivery and test record was kept in the archived implementation plan of
this project's private predecessor, which is not published; this ADR freezes the architectural
choices that the implementation encoded.

## Decision

### 1. Files are the cross-step contract

`process-log.json` remains the only mutable lifecycle ledger. It owns process identity, output
ownership, step state, input snapshots, artifact inventory, and publication recovery metadata.
Substantive content remains in the reserved output directory:

| Artifact kind       | Canonical path                                   | Owner  |
| ------------------- | ------------------------------------------------ | ------ |
| `job_description`   | `job-description.txt`                            | Step 1 |
| `vacancy`           | `vacancy.json`                                   | Step 1 |
| `company_research`  | `company-research.json`                          | Step 2 |
| `application_brief` | `application-brief.json`                         | Step 3 |
| `cv_source`         | `cv.json`                                        | Step 4 |
| `cv_docx`           | the safe basename declared by `cv.json.fileName` | Step 4 |
| `cover_letter`      | `cover-letter.txt`                               | Step 5 |

The first successful Step 4 publication freezes the concrete `cv_docx` path for that process.
Later Step 4 revisions must publish to the same path. The name must be a non-hidden basename ending
in `.docx`, contain no path separator, and not collide with another canonical artifact name.

`.pipeline-tmp/<publication-id>/` is reserved for transaction-owned candidates, backups, rendering,
and QA. It is never a canonical artifact, is never discovered by extension, and is never
web-readable. No second mutable run manifest is introduced under `output/`.

Artifact schemas and cross-file invariants belong to the validators created in WP1, not to this ADR.
The brief becomes schema v3; vacancy and company-research start at schema v1. Exact JD bytes and
plain-text deliverables have `schema_version: null` in ledger metadata.

The table above was complete when it was written and is not complete afterwards. Step 1's artifact
set and the accepted vacancy schema versions belong to
[ADR 0012](0012-versioned-extraction-and-vacancy-v2.md); that record, and not this table, decides any
Step 1 artifact kind or vacancy version it introduces, from whatever status it currently carries.
Everything else in this ADR is inherited by it unchanged.

The same holds for process identity. How `source_ref` becomes `source_key`, whether that key carries
a policy version, and what a change of that policy does to the strict closed record union below
belong to [ADR 0013](0013-versioned-source-keys-and-identity-migration.md), from whatever status it
currently carries. The ledger schema number and the record union are inherited by it unchanged.

Post-review revision of published Step 4/5 materials is the one recorded deviation from this ADR's
single-entrypoint revision model. The ledger schema number (v4), the `revise-step` operation with
its pinned input snapshot and mark restoration, waiver records, open-conflict journaling, the
committed-bundle revision archive, and the journaled adoption of manual edits belong to
[ADR 0015](0015-lightweight-post-review-revision.md), from whatever status it currently carries.
`reopen-step` semantics, the §9 one-way cutover discipline, and everything else in this ADR are
inherited by it unchanged.

### 2. Process-log v3 is a strict record union

The ledger retains the top-level fields `schema_version`, `duplicate_policy`, `updated_at`,
`companies`, and `processes`, with `schema_version: 3`.

Each process is exactly one of:

1. an unchanged old-shape historical record, with its existing `status` and without
   `artifact_mode` or `steps`; or
2. a file-backed record with identity/company fields, `updated_at`, nullable `output_dir`,
   `artifact_mode: "file-backed"`, `duplicate_of`, and no manually maintained process-level
   `status`.

Historical records are searchable display data only. Every lifecycle mutation against one is
rejected, and neither the CLI nor web layer inspects its output directory to infer artifacts.

Every file-backed record contains exactly these fixed step keys:

```text
get_vacancy
research_company
map_experience
generate_cv
write_cover_letter
```

Every step has one common machine-owned shape:

```text
state, attempt, revision,
started_at, updated_at, finished_at,
published_inputs, artifacts,
active_attempt, publication_transaction,
attempt_history, error, blocker
```

`state` is one of `pending`, `running`, `blocked`, `failed`, `completed`, or `stale`. Artifact and
input entries use the common fields `kind`, repo-relative `path`, nullable `schema_version`,
`sha256`, and `bytes`. Error and blocker objects use stable codes, Russian user-facing text,
timestamps, and retryability; private diagnostics must not contain raw logs, page bodies, secrets,
or stack traces.

A new process is created atomically with Step 1 `running`, `attempt: 1`, and `revision: 0`. The other
steps start `pending` with attempt and revision zero and null timestamps. The common validators
implemented in WP2 own the exact nested object keys and reject unknown keys. Public API objects are
separate explicit allowlisted DTOs, never spreads of ledger records.

### 3. Dependencies and invalidation are fixed

The dependency graph is:

```text
get_vacancy
  -> research_company
  -> map_experience
       -> generate_cv
       -> write_cover_letter
```

Steps 4 and 5 are siblings. A failed or blocked Step 4 does not prevent Step 5 when Step 3 remains
completed, healthy, and current.

Reopening Step 1 invalidates committed descendants in Steps 2–5; reopening Step 2 invalidates
committed descendants in Steps 3–5; reopening Step 3 invalidates committed descendants in Steps
4–5. Steps 4 and 5 never invalidate one another. Previously completed descendants become `stale`;
untouched descendants remain `pending`; blocked and failed descendants retain their diagnostics.
An upstream reopen is rejected while any transitive descendant is `running`.

Protected canonical inputs and prerequisite bundles are recorded by digest. Drift is detected by
preflight, publication, deep validation, and reconciliation. A changed prerequisite makes its
consumer stale; a missing or byte-modified published artifact is respectively missing or corrupt,
not stale.

### 4. Attempts authorize work; revisions identify committed bytes

`begin-step` starts only a pending step. `retry-step` starts only blocked or failed work.
`reopen-step` is the only command that authorizes work on a completed or stale step. Each operation
creates a unique `active_attempt.id`, increments the attempt counter, and snapshots:

- the exact prerequisite and protected-canonical inputs;
- the expected prior revision;
- the expected prior artifact paths and digests.

`publish-step --outcome completed`, `publish-step --outcome blocked`, and `fail-step` must present
the matching active-attempt id. Closing an attempt appends a compact immutable history entry and
clears `active_attempt`. Input drift during publication closes the attempt as failed with
`inputs_changed`; it never leaves the step running.

The first committed artifact bundle has revision 1. A different authorized bundle increments the
revision, including a safely published partial bundle with outcome `blocked`. A same-digest
revalidation closes a new attempt without incrementing the revision. Lifecycle outcome alone does
not identify a new artifact revision. Old diagnostics remain in `attempt_history`.

### 5. Output reservation is deterministic and filesystem-aware

Step 1 reserves the output directory after exact company and role are known. The base segment is
formed from `"<company>-<role>"` by:

1. Unicode NFC normalization;
2. locale-independent Unicode lowercasing;
3. NFC normalization again after case mapping;
4. replacing every maximal run outside Unicode letters and numbers with `-`;
5. trimming leading/trailing `-` and rejecting an empty result.

Stored output paths have exactly one child segment under the injected output root:
`output/<base>`. Reservation comparisons normalize separators, reject absolute paths and dot
segments, apply NFC, apply ECMAScript locale-independent `toLowerCase()` to the full repo-relative
path, and apply NFC again. The same equivalence key is used for ledger paths and existing immediate
filesystem entries.

The unsuffixed path is preferred; otherwise the first free `-2`, `-3`, and so on is selected while
holding the ledger lock. Any unowned directory, file, symlink, or case/Unicode-equivalent entry is
occupied. An already reserved path is reusable only by the same file-backed process and only when
`lstat`, type, non-symlink, and realpath-containment checks pass.

Reservation is committed before `mkdir`. A crash before `mkdir` is idempotently recoverable. A
setup failure leaves ownership reserved and closes Step 1 as failed with `output_setup_failed`; no
other process may adopt the path. Core, CLI, tests, and web receive explicit `workspaceRoot`,
`outputRoot`, and ledger-path dependencies so fixture tests cannot reach the real output root.

### 6. Publication is journaled and recoverable

Candidates are created and validated inside the attempt's `.pipeline-tmp/<publication-id>/`.
Publication holds the process-log lock across final checks, journaling, filesystem replacement, and
ledger commit. Before the first canonical rename, the owning step receives a private
`publication_transaction` containing the publication/attempt ids, intended outcome, old and new
bundle metadata, canonical targets, candidate names, backup names, and timestamps.

Existing canonical files move to transaction-owned backups before candidates move to their
canonical names. The complete canonical bundle is revalidated before the ledger records the new
revision and clears `publication_transaction`. Cleanup happens only after that commit.

Reconciliation is proof-based:

- a complete final bundle matching the journaled new metadata completes the ledger commit;
- a provably complete old backup bundle restores the old committed state and records failure;
- an incomplete first publication is removed only when every affected target and candidate is
  accounted for by the transaction;
- any state that proves neither the complete old nor complete new bundle stops with
  `publication_recovery_conflict` and preserves evidence.

Cleanup after an already committed publication is allowed only when canonical files match the
committed metadata. This protocol applies to single-file artifacts and is mandatory for the Step 4
`cv_source`/`cv_docx` pair.

### 7. Session topology is operational, not semantic

A step accepts exactly one stable selector: process id, normalized source ref, or normalized output
directory. Resolution must produce one file-backed process or fail as not found, ambiguous,
conflicting, or historical/read-only. Each step rereads and validates files even when the previous
step ran in the same session. Chat reports are never inputs or recovery sources.

One-session sequential execution and fresh-session execution are equally valid. The recommended
human workflow remains Steps 1–2, then Step 3 in a clean context, then Steps 4–5, but this grouping
does not alter dependencies or artifacts. Continuity is guaranteed only within the same checkout
and filesystem because `output/` remains ignored.

### 8. Every per-role step requires explicit user intent

All five per-role skills are explicit-run operations. Runtimes that support invocation gating must
set it consistently for all five in the generated metadata. A user may explicitly request one step
or a contiguous multi-step run; completing a step alone never authorizes silently starting the
next one. Regardless of one-message scope, every boundary publishes and the next step resolves and
validates from files.

`/score-jobs` remains outside this per-role lifecycle and is unchanged.

### 9. Cutover is one-way

WP2 implements and tests v3 entirely against temporary ledgers and output roots before changing the
real ledger. The real cutover changes only top-level `schema_version: 2` to `3`; company and process
arrays remain byte-for-byte unchanged in the serialized diff and receive no inferred fields. The
old historical importer fails closed in write mode on v3. There is no v2 process resume, migration
command, historical artifact adoption, or rollback writer.

## Consequences

- Every load-bearing step result survives session loss and has one canonical owner.
- Lifecycle health can distinguish stale inputs, corrupt bytes, missing files, blockers, failures,
  and active work without a second status manifest.
- Same-digest retries are idempotent; changed revisions require an explicit current attempt token.
- Crashed multi-file publication is recoverable to a complete old or complete new bundle, never a
  guessed mixture.
- Historical records remain visible without being mutated or exposing legacy output contents.
- Output reservation and artifact tests require explicit temporary roots and filesystem collision
  fixtures.
- Generated runtime proxies and canonical procedures are updated later in WP3, not in this ADR.

## Plan alignment

This ADR made no deviation from that completed implementation plan. It resolved the plan's open
naming, nesting,
path-normalization, revision, session-topology, and invocation choices. Any future deviation must
be recorded through a superseding ADR and the current execution plan that owns the change; the
closed historical implementation log is not updated.
