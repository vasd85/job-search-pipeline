# ops-tree — the operational folder

The operational folder is not a git checkout. It is an export of two pinned tags — the engine's
`release-<YYYYMMDD>[.N]` and the private repository's `candidate-<YYYYMMDD>[.N]` — beside the run's
own state, with no `.git` anywhere in it. `ops-manifest.json` at its root records both tags, the zone
table and a digest of every file of the read-only zones. This tool builds such a folder, checks it,
replaces its pair of tags and puts the previous pair back. The decision is
[ADR 0024](../../docs/adr/0024-two-repositories-one-snapshot.md), decision 1; the operator's
procedure is [docs/runbooks/ops-cutover.md](../../docs/runbooks/ops-cutover.md).



## Commands

```sh
npm run ops:export -- --release <tag> --candidate <tag> --engine-repo <abs> --candidate-repo <abs> --root <abs> [--kind operational|rehearsal]
npm run ops:cutover -- --release <tag> --candidate <tag> [--engine-repo <abs>] [--candidate-repo <abs>] [--input-file input-<32 hex>.json] [--dry-run]
npm run ops:rollback -- [--to <stamp>] [--input-file input-<32 hex>.json]
npm run ops:verify
```

`export` builds a new folder at `--root`, which must not exist or be empty and must not lie inside a
git repository. Every other command acts on the folder the tool itself lies in; no argument names
it. `cutover` without `--engine-repo`/`--candidate-repo` takes the repositories the manifest
recorded. A cutover onto the current pair rebuilds both zones after drift; a cutover onto the
current release and a new layer tag replaces only the layer.

`--kind rehearsal` builds a sealed folder on the real layer for a run against real vacancies. Its
zone table adds `.rehearsal/` to the state zone; the backup refuses it.

## Zones

Paths are relative to the folder root. The table is written into every manifest, and a folder is
always checked against the table in its own manifest. Historical tables can retain a mutable
`candidate/research/` exception; new builds omit it, and private research is never exported.

| Zone | Paths | Digested |
| --- | --- | --- |
| `candidate` | `candidate/` — the layer tag without `archive/`, `board/`, `decisions/`, `machine/`, `research/` | yes |
| `dependencies` | `tools/cv-builder/node_modules/`, installed by `npm ci` at build | yes |
| `state` | root entries starting `process-log.json`, `process-log.backup-`, `triage-ledger.json`, `telegram-sweep-state.json`; `output/`, `triage-batches/`, `telegram-sources.json`, `telegram-sweeps/`, `records/`, `.pipeline-input/`, `.temp-docs/`, `.playwright-mcp/`, `pkcs11.txt`, `.vscode/`, `.idea/`; nested `.claude/settings.local.json`, `.claude/.cc-writes/`; `.rehearsal/` in a rehearsal folder | no |
| `handover` | `outbox/` | no |
| service | `ops-manifest.json` and its temporary siblings, `.ops-tree/` | no |
| metadata | any `.DS_Store` | no |
| `engine` | everything else | yes |

A file nobody listed is an added `engine` file, and the check refuses it. The candidate exclusions
are the engine's list, not the private repository's `.gitattributes`: a tag cut from a commit
without that file would otherwise bring the board into the folder.

## The manifest

`ops-manifest.json`, schema `job-search-pipeline/ops-manifest`, version 1:

| Field | Meaning |
| --- | --- |
| `kind` | `operational` or `rehearsal` |
| `state` | `ready`, or `building` while a swap runs |
| `engine`, `candidate` | `{tag, commit, tree, repository}` — `repository` is the absolute path the tag was read from |
| `built_at` | when the image was built |
| `previous` | the stamp of the retained tree the last swap left, or `null` |
| `zones` | the zone table above |
| `files` | `{engine, dependencies, candidate}`: path → `{sha256, executable}` for a file, `{symlink: <target>}` for a link |

## The drift check

`verifyFolder` in `manifest.mjs` is called with the root of the tree the calling code lies in —
never with `JOB_PIPELINE_WORKSPACE_ROOT` — by:

- `tools/process-log.mjs` before every command except `help` and `validate`, so every step 1–5 is
  refused on a drifted folder at its start, its publication, its revision, its failure and its
  retry; `validate` stays readable so a drifted folder can still be diagnosed;
- `planBatch` and `recordBatch` of `tools/lib/triage-ledger-core.mjs`, before anything else, so a
  triage batch is refused at its start and at its record, before the ledger lock is taken; the
  code comes as a `TriageLedgerError`;
- `sweep` and `finalize` of `tools/telegram-collect/cli.mjs`, before they read or create anything;
- `tools/bootstrap.mjs --check` (`npm run preflight`) before anything else, which also reports the
  folder's kind, tags and build time as `ops_tree`;
- `npm run ops:verify`, which prints every drifted path.

Not covered: the collector's other commands (`init`, `reset-cursor`, `render-batches`, `probe`).

## The cutover

1. Take `.ops-tree/lock`; refuse a folder whose swap did not finish; remove leftover images of
   interrupted runs (a leftover may hold only the copy of the ledger and of `output/`).
2. Gates, read under the ledger's own lock. A step with an active attempt started less than 24 hours
   ago refuses; an older one is reported as stale. A prepared publication refuses at any age: finish
   it with `node tools/process-log.mjs reconcile-step` first. An existing `triage-ledger.json.lock`
   refuses. Only an input file whose envelope carries `overrideReason` lifts these refusals; the
   reason and the lifted codes are written to the evidence.
3. Export both tags into `.ops-tree/staging/<stamp>/`, compare each export with `git ls-tree` of the
   same commit, refuse any path that falls in a state, handover or service zone, run `npm ci` where
   a lockfile names packages, and write the image's manifest.
4. Copy `process-log.json` and `output/` into the image under the ledger lock. Run the new engine's
   `tools/bootstrap.mjs --check` against the image and its `tools/process-log.mjs validate --deep`
   against the copy; the current engine's `validate --deep` of the live folder is the baseline. The
   report names, per process, what the new engine reports that the current one does not — the
   processes the swap will stop until their brief is republished.
5. `--dry-run` stops here. Nothing in the folder has moved at any point before this step.
6. The swap: a journal of renames is written and synced, the manifest is marked `building`, the
   nested state children move into the image, then each swapped top-level entry moves out to
   `.ops-tree/previous/<stamp>/` and its replacement moves in, `package.json` and `tools/` last.
   An exception reverses the journal in the same process. SIGINT, SIGTERM and SIGHUP are ignored
   during the swap: the run completes, pruning and evidence included.
7. The new manifest is written last. The three newest retained trees are kept; an older one is
   deleted only if it still matches its own manifest. The evidence is
   `.ops-tree/cutovers/<stamp>.json`.

The swap never touches the state zones, so the daily backup is not unloaded around it; a backup
run that starts between the two renames of `tools/` fails once and the next run passes.

## Rollback and recovery

`rollback` with a journal present reverses the interrupted swap, idempotently. Run it as
`node tools/ops-tree/cli.mjs rollback`: a run killed between the two renames of `package.json`
leaves no `package.json` for `npm run`. A state child the reversal could not move back, because
the folder already holds a new one of the same name, stays in the image; the image is then kept and
named in the result, and the next cutover refuses with `ops_tree_staging_holds_state` until the
operator resolves it. When the folder has no `tools/` left — the run was killed between moving the
old one out and the new one in — run the retained copy instead:

```sh
node <folder>/.ops-tree/previous/<stamp>/tools/ops-tree/cli.mjs rollback
```

where `<stamp>` is the `stamp` of `<folder>/.ops-tree/journal.json`. A copy of the tool acts on the
folder it lies in and only when that folder's journal names its stamp; from a copy nothing but
`rollback` runs. A journal of an unknown version is refused with the reversing `mv` commands in its
details. A journal that does not parse is refused without them; the manual step for it is in the
operator's runbook.

Without a journal, `rollback` swaps the folder back to the retained tree `--to <stamp>` or the
manifest's `previous`, after checking that tree against its own manifest, under the same gates and
override. The tree it leaves becomes a retained tree in turn, so a rollback can itself be rolled
back.

## The lock

`.ops-tree/lock` holds the pid, host name, time and a token of its holder. A lock of another host,
or of a live process, refuses with `ops_tree_locked` and the manual step. A lock of this host whose
process is gone, or which predates the last boot, is taken over: it is moved aside under a unique
name, compared with what was read, and created afresh. If what was moved is not what was read,
another run took the lock in between; it is linked back into place and this run refuses. A lock is released only by the holder of its
token.

## Codes

| Code | Meaning |
| --- | --- |
| `engine_tree_drift`, `candidate_snapshot_drift` | a digested file was modified, added, removed or changed type |
| `ops_manifest_missing`, `ops_manifest_invalid` | `.ops-tree/` without a manifest; a manifest that does not parse |
| `ops_tree_building` | a swap did not finish; run `rollback` |
| `ops_tree_locked` | another run holds the lock, or it could not be taken over |
| `ops_tree_invalid_arguments`, `ops_tree_invalid_tag`, `ops_tree_tag_missing`, `ops_tree_repository_missing` | the command line |
| `ops_tree_root_inside_repository`, `ops_tree_root_not_empty` | `export` target |
| `ops_tree_export_mismatch`, `ops_tree_extract_failed`, `ops_tree_git_failed`, `ops_tree_install_failed` | building the image |
| `ops_tree_image_overlaps_state` | a tag carries a path of the state, handover or service zone |
| `ops_tree_pair_check_failed`, `cutover_ledger_unreadable`, `cutover_ledger_moving` | the new engine refused the pair or the ledger; the ledger changed during the copy |
| `cutover_step_running`, `cutover_publication_prepared`, `cutover_triage_locked` | gates |
| `ops_tree_staging_holds_state` | an image of an interrupted run still holds state; move it back, then delete the image |
| `ops_tree_nothing_to_roll_back`, `ops_tree_rollback_target_drift` | no retained tree; the retained tree no longer matches its manifest |
| `ops_tree_recovery_refused`, `ops_tree_journal_unknown` | a copy of the tool that the journal does not name; a journal this engine cannot read |
