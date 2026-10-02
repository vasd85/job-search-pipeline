# Cutover of the operational folder

The operational folder has no `.git` and is assembled from an engine tag and a private-layer tag.
The tool, its zones and codes are owned by
[tools/ops-tree/README.md](../../tools/ops-tree/README.md).

1. **Tags.** On the user's word "cut a release", the development session sets both tags —
   `release-<YYYYMMDD>` on the engine's `main` and `candidate-<YYYYMMDD>` on the private
   repository's `main`; a second tag on the same day gets the suffix `.2` — and records them in the
   task. Without the user's word no tag is set.
2. **A dry run** in the folder: `npm run ops:cutover -- --release <tag> --candidate <tag> --dry-run`.
   The user is shown: the change of tags; the drift (every path changed or added in the folder by
   hand — the cutover will replace it, and it will remain only in the kept tree); stale running
   steps; and the processes the swap will stop until their brief is published again. A refusal of
   the pair check or of the journal is a stop; nothing in the folder has moved.
3. **Gates.** A step started less than 24 hours ago, a prepared publication of any age and the
   triage lock refuse. A prepared publication is first completed with
   `node tools/process-log.mjs reconcile-step`. A refusal can be overridden only on the user's
   word: the words are written as a file `.pipeline-input/input-<32 hex>.json` with the field
   `overrideReason` (the transport of [pipeline-artifacts.md](../../instructions/pipeline-artifacts.md))
   and passed with `--input-file`; the reason and the lifted refusals go into the evidence
   `.ops-tree/cutovers/<stamp>.json`.
4. **Cutover** — the same command without `--dry-run`, on the user's word. The backup agent is not
   unloaded: the swap does not touch the backup members. After it — one snapshot and a freshness
   check: `npm run backup -- run --dest ~/Backups/job-search-pipeline`, then
   `npm run backup -- verify --dest ~/Backups/job-search-pipeline --max-age-hours 36`.
5. **Rollback** — `npm run ops:rollback`: it brings back the previous pair together with its files,
   without the network. An interrupted swap (`ops_tree_building`) is rolled back with
   `node tools/ops-tree/cli.mjs rollback` — it needs no `package.json`, which may be missing from
   the root. If the result names a kept image (`kept_image`), a state file remains in it for which
   the folder has already created a replacement: the user decides which one to keep, and then the
   image is deleted. If the folder's root has no `tools/`, the copy from the kept tree is run, the
   one whose stamp is named in `.ops-tree/journal.json`:
   `node .ops-tree/previous/<stamp>/tools/ops-tree/cli.mjs rollback`; if that one refuses too, the
   journal lists the pairs of renames, and they are reversed by hand with `mv` in reverse order. If
   `rollback` refuses with `ops_tree_journal_unknown` and "is not readable", while
   `ops-manifest.json` in the root is still `state: ready`, the journal write broke off before the
   first rename, and there is no `mv` to reverse: delete `.ops-tree/journal.json`, the newest
   directory `.ops-tree/previous/<stamp>/` and `.ops-tree/staging/<same stamp>/` if it exists. The
   directory in `previous/` is deleted only if it holds a lone `ops-manifest.json`; if it holds
   anything else — stop and go to the user.
6. **Drift** (`engine_tree_drift`, `candidate_snapshot_drift` at any step, at the start and at the
   write of a triage batch, in `sweep` and `finalize` of the Telegram sweep, or in preflight) —
   `npm run ops:verify` names the paths; a cutover onto the current pair of tags rebuilds both
   zones.
7. **Smoke.** The steps marked `[cutover]` in the [smoke checklist](../runtime-smoke-checklist.md)
   are executed here, after the swap; their outcome is reported by the user or the operational
   session and recorded by the development session — in the task in which the user said to cut the
   release.

## Compatibility and runtime checks

The new release must read every schema version actually in use, without a hidden bulk migration
or automatically upgrading existing processes. Published artifacts keep their versions; an
explicit reopen invalidates descendants in the usual way. If compatibility is unproven, active
processes finish on the previous release. `npm run candidate:check` must return `ready` before the
first step; changing protected brief inputs requires publishing Step 3 again.

A source-key policy transition follows [source-key-v2-cutover.md](source-key-v2-cutover.md),
including the census and ledger backup before the first `start` and its ledger rollback rules.

When enabling the runtime sandbox, prove a real render using the documented
[builder entrypoint](../../tools/cv-builder/README.md) on a published `cv.json` in the runtime
operational sessions use. Under the sandbox a render may hang; silence is no success. If it fails,
record a local `.claude/settings.local.json` with the sandbox off in the operational folder in
the cutover evidence. A third entry in `sandbox.excludedCommands` is not a workaround: the list
is closed at exactly two entries by `tests/write-guard.test.mjs`. Extending it is a separate task.

## Residual private research and historical snapshots

Before the next cutover, the operational session compares any residual `candidate/research/`
with `research/` in the private repository, preserves differences there, and removes the residual
directory only on the user's word. The swap considers both old and new zone tables; leaving it
in place can carry it into the new candidate digest. A development session does not do this write.

Older backups containing that member report a member-inventory mismatch under the current backup
tool. Keep them unchanged; use the preserved older tool to verify them when needed, and restore
only current state members, without research or replacement of `ops-manifest.json`:
[backup restore](operational-backup.md#8-restore).
