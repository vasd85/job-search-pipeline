# Rotating local backup of the operational state

Status: **procedure in force**. The tool is `tools/operational-backup.mjs`; the schedule is the
LaunchAgent `com.job-search-pipeline.backup`. The boundary the procedure narrows is recorded in
pre-switch durability boundary (in the private pre-switch archive), and from the day of the switch in [Backup and what it does not cover](development-flow.md#11-backup-and-what-it-does-not-cover) of the
[development flow document](development-flow.md).

## 1. What this protects against, and what not

The copies lie **on the same disk** as the original. The whole list follows from that:

| Failure | Covered? |
| --- | --- |
| Accidental deletion of `output/` or the ledger | yes |
| A bad write that corrupted a file | yes — yesterday's copy is intact |
| A mistaken `workspace-reset` in the wrong tree | yes |
| Loss of the disk, loss of the shared `.git`, theft of the machine | **no** |
| Corruption noticed later than 7 days after the fact | **no** — rotation has already deleted anything older |

The last two rows are the very durability boundary of gitflow pre-switch durability boundary (in the private pre-switch archive). It stays open: the procedure
narrows it, it does not close it. An off-disk copy and its encryption are a separate decision of
the user, with its own consequences for privacy (`output/` holds the candidate's CVs and letters,
and the batches hold data of third-party companies).

## 2. What is copied

Four members under locks, two per lock. A pair is copied **while holding the very lock its writers
take**, so a snapshot is either consistent or loudly refused:

| Member | Lock | Why a pair |
| --- | --- | --- |
| `process-log.json` | process log | the ledger and the artifacts it refers to |
| `output/` | process log | a canonical file appears only inside a publication transaction under this lock |
| `triage-ledger.json` | triage ledger | the index |
| `triage-batches/` | triage ledger | `recordBatch` writes a batch's record under the same lock |

The locks are taken **one after the other, never together**: no writer in the repository takes
both, and nothing defines an order between them — holding them together would mean inventing one.

Then, without a lock, six members that only a run or the user by hand writes and that are in no
repository. Each is copied if it exists; its absence is the status `absent`, not a refusal:

| Member | Role | How it is written |
| --- | --- | --- |
| `telegram-sources.json` | the Telegram collector's list of channels — the user's manual work | by hand |
| `telegram-sweep-state.json` | the positions of the channel sweep | a temporary file and a rename |
| `records/` | the corpus of letter corrections — an artifact of a run | a record is written once |
| `outbox/` | task drafts from a run; `board:import` takes and deletes them | by the run session |
| `candidate/research/` | the corpus of letter corrections from before `records/`, revision logs, the inventory, the list of markers; a **temporary member** — removed after the switch | by a run and by hand |
| `ops-manifest.json` | the operational folder's marker: the engine and layer tags the folder is rebuilt from ([Restore](#8-restore)) | a temporary file and a rename |

The JSON members (`telegram-*.json`, `ops-manifest.json`) are parsed after the copy the same way
their owner parses them; if parsing fails, the snapshot is refused (`backup_member_unreadable`),
just as an unreadable ledger is refused. A member of the wrong kind — a file instead of a
directory, a link instead of the member — refuses the snapshot before the copy
(`backup_unsupported_entry`). The residual: a corpus record or a draft caught in the middle of a
write is copied truncated, and a draft that `board:import` deletes in the middle of the copy
refuses the snapshot with the code `backup_failed`. In both cases the next run passes.

Not copied, and every "no" has a reason:

- `output/<company-role>/.pipeline-tmp/` — staging. It has writers that hold no lock (the renders
  of `tools/cv-builder/`, the steps' staged JSON), so this part of the tree would be the only one
  the lock does not make consistent. It is working state, not published material: it is rebuilt,
  and whatever is abandoned is cleaned up by `cleanup-staging`
  ([pipeline-artifacts.md](../../instructions/pipeline-artifacts.md)).
- A batch directory without `ledger-record.json` is a batch being built right now: the transport
  writes into it without holding a lock. Such a directory is listed in the manifest and is copied
  the **next** night, once its record appears.
- Lock files and the `.tmp` neighbours of the ledgers: under a held lock there is no foreign
  temporary file, and a restored foreign lock would block the tools.
- `process-log.backup-*.json` — these are the cutover's rollback copies and have their own owner
  ([source-key-v2-cutover.md](source-key-v2-cutover.md)); `.pipeline-input/` and `.rehearsal/` —
  transport and rehearsal files.
- `telegram-sweeps/` — page snapshots of the sweeps: their addresses are already in the triage
  ledger, and the directory's growth (about 530 files per sweep) would hit the snapshot limit of
  [Refusals and what to do about them](#6-refusals-and-what-to-do-about-them) within months. This is the user's decision.
- The operational folder's `.ops-tree/` — the kept trees of past cutovers and their evidence.

For `output/` the answer had to be given per class, not per directory. The answer: every class is
copied. `cv.json` can be rebuilt, but the digest of the built DOCX is recorded in
`process-log.json`, and a rebuilt file is already a different artifact; a sent bundle is proof of
what was sent, not a derived output. No class is cheaper to restore than to copy.

## 3. Rotation

The 7 latest snapshots are kept (`--keep`), and the eighth is deleted. Deletion is bounded three
times: only inside the destination directory, only for directories named with a stamp
`YYYYMMDDTHHMMSSZ`, and only if they hold a `manifest.json` written by this tool. A foreign
directory, a foreign file and even a directory with the right name but no manifest are invisible to
rotation. The repository applies the same rule to the input files of ADR 0011, for the same reason.

Rotation runs **only after a successful snapshot**. If the snapshot is refused — the state is
corrupted or someone is writing — the old copies stay in place. The count is by copies, not by
days: a manual run in the daytime takes a slot.

Separately, the tool sweeps its own `<stamp>.partial-<pid>` older than a day — the remains of
interrupted runs.

## 4. Daily run

**The tool copies the tree it lies in.** There is no flag naming a directory: "which tree to copy"
is not a value anyone types. The copy in the operational checkout is the one that runs:

```bash
node <operational-checkout>/tools/operational-backup.mjs run --dest ~/Backups/job-search-pipeline
```

The source is recognized **by its marker** — an `ops-manifest.json` of the kind `operational` at
the root of the tree. The marker decides even when a `.git` lies next to it: a folder of the kind
`rehearsal` is refused (`backup_root_rehearsal`), a folder in the middle of a swap
(`state: building`) is accepted, and the report says so. **Until the day of the switch** one more
tree is accepted without a marker — the primary worktree, that is, today's operational checkout: its
`.git` is a directory, while a linked tree's `.git` is a file, so the integration tree, a task tree
and a run tree are refused even when they carry a perfectly fit ledger (`backup_root_unmarked`).
The report's `source_identity` field says what the source was accepted by: `marker` or
`primary-worktree`; after the switch `marker` is expected, and the transitional path is removed. And
the tree must hold a `process-log.json` (`backup_root_not_operational`). All these refusals come
before a single write to disk.

> **Until the next cutover no copy can be taken at all — neither by the schedule nor by hand.** The
> tool reaches the operational checkout only with a cutover, and a copy run from a development tree
> refuses itself on the very first condition. This is the user's accepted decision of 2026-09-01,
> not a defect; the gap is closed by a cutover, which the user starts and which has no set date.
> Until it runs, the only protection is the snapshots taken before this change, and they are not
> refreshed.

The schedule is a LaunchAgent, not `cron`: a calendar job missed during sleep runs on wake-up, while
`cron` silently skips it; the machine is a laptop. The plist is printed for reading, not installed
by the tool; `--script` is mandatory and names the copy the schedule must run:

```bash
node tools/operational-backup.mjs print-plist --script <operational-checkout>/tools/operational-backup.mjs --dest ~/Backups/job-search-pipeline
```

`--script` accepts a path that does not exist yet — before a cutover it will not — and the report's
`script_present` field says whether the file is in place. The path must be absolute: a relative one
would be completed from whatever directory the command happened to run in, and "the file is
missing" would look like business as usual.

Installation (a person saves the file, then):

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.job-search-pipeline.backup.plist
```

Removal from the schedule is `launchctl bootout gui/$(id -u)/com.job-search-pipeline.backup`, after
which the plist file can be deleted.

Four operational facts:

- `ProgramArguments` holds absolute paths to both `node` and the script: a background job has no
  useful `PATH`. **A Node update is an edit in two places**: `engines` in `package.json` and the
  installed plist. The gate does not see the plist.
- **While the script file is missing, the failure looks unlike the others — but it is visible.**
  Measured on 2026-09-01 (`launchctl kickstart` with the script missing): `runs` rose to 1,
  `last exit code = 1`, and a `MODULE_NOT_FOUND` trace from Node landed in `backup.log`. So the job
  does start — `node` is in place — and it is Node itself that fails, which is why the output
  redirection works and the error gets through. It differs from the other refusals not by silence
  but by form: it is a Node trace, not the JSON with an `error.code` field the tool itself prints.
- **The job runs the working-tree file, not the committed version.** In the operational checkout
  source is not edited (gitflow pre-switch branch and worktree roles (in the private pre-switch archive)), so exactly one thing rewrites this file — a cutover. And
  `git checkout` is not atomic across `tools/operational-backup.mjs` and the `tools/lib/` modules
  it imports, so a run at 11:00 in the middle of a cutover can pick up a mixed set. Unload the job
  before a cutover (`launchctl bootout`), and afterwards load it back and check freshness; adding
  that step to the cutover procedure is a separate backlog task. From the day of the switch the job
  is not unloaded: a cutover of the operational folder swaps directories by renames, and a backup
  run caught between two of them fails once, while the next one passes
  ([tools/ops-tree/README.md](../../tools/ops-tree/README.md), the section The cutover).
- Full Disk Access is not needed for these paths: neither the repository directory nor `~/Backups`
  is a TCC-protected directory. If the destination or the checkout moves into `Documents`,
  `Desktop`, `Downloads` or iCloud Drive, a one-time interactive access prompt appears, and a
  synced destination is also a decision about disclosing data, not a storage detail.

## 5. Is it alive

From the outside every failure looks the same: no fresh directory and a line in `backup.log` that
nobody reads. So the check is one command, and it fits any monitor as well:

```bash
node tools/operational-backup.mjs verify --dest ~/Backups/job-search-pipeline --max-age-hours 36
```

A nonzero exit means "there is no fresh copy" — when the snapshots are stale, when there are none at
all, and when the destination directory does not exist. Look at `backup.log` in the destination
directory next, and if the job never started at all — at `launchctl print`.

Both checks read only the snapshot store and touch no checkout, so **any** copy of the tool can run
them, including the copy in a development tree. That is the only thing that keeps working in the
gap before a cutover — and exactly why the liveness check matters more than usual.

A byte-for-byte check of one snapshot:

```bash
node tools/operational-backup.mjs verify --backup ~/Backups/job-search-pipeline/<stamp>
```

It compares the snapshot with **its own** manifest, taken at the moment of copying — not with what
is in the checkout now. A difference names the changed, missing and extra files one by one.

## 6. Refusals and what to do about them

| Code | What happened | What to do |
| --- | --- | --- |
| `backup_root_unmarked` | the tree has no operational-folder marker and is not the primary worktree: a linked tree — integration, task, run — or an unrelated directory | run the copy in the operational checkout or the operational folder. Neither a flag nor `cd` gets around this: the tree that is copied is the one the file lies in |
| `backup_root_rehearsal` | the marker names a rehearsal folder | its state dies with it and is not copied |
| `backup_root_manifest_invalid` | `ops-manifest.json` is unreadable, or there is an `.ops-tree/` without it | restore the marker with a cutover onto the current pair of tags ([tools/ops-tree/README.md](../../tools/ops-tree/README.md)) |
| `backup_root_not_operational` | the tree has no `process-log.json` | this is not the operational checkout. The file's absence is the protection itself (gitflow pre-switch operational write boundary (in the private pre-switch archive)); run the right copy instead of creating the file |
| `backup_member_unreadable` | a JSON member of [What is copied](#2-what-is-copied) does not parse | **the snapshot is refused on purpose**, as with an unreadable ledger. Fix the file — its owner will refuse it the same way; the old copies are intact |
| `backup_unsupported_entry` | a member of the wrong kind: a file instead of a directory, a link, a device | find out who put it there; the tool will not copy a pointer instead of the state |
| `backup_path_not_absolute` | `--script` got a relative path | give an absolute one: a relative one would be completed from the launch directory |
| `triage_ledger_locked` | someone holds the triage ledger's lock | a `/score-jobs` is running. Retry later; if the lock belongs to nobody — [A lock left behind by a killed run](#7-a-lock-left-behind-by-a-killed-run) |
| `process_log_lock_timeout` | the process log's lock is busy longer than the wait | a per-role step is running. Retry later; this lock recovers by itself 30 seconds after a dead owner |
| `triage_ledger_unreadable`, `triage_ledger_invalid` | the ledger is unreadable or fails validation | **the snapshot is refused on purpose**: a copy of corrupted state would take a slot and push out a good one. Fix the state; the old copies are intact |
| `backup_snapshot_exists` | a directory with this stamp already exists | it is never overwritten. A run within the same second is a repeat; otherwise find out who created it |
| `backup_destination_inside_source` | the destination is inside the checkout | the destination must be outside: otherwise it would copy itself and become operational state itself |
| `backup_tree_too_large`, `backup_tree_too_deep` | the snapshot went beyond its bounds (100000 entries, 8 GiB, 32 levels) | find out what grew; the tool does not copy half a tree |

## 7. A lock left behind by a killed run

A run stopped with `SIGTERM` (including `launchctl bootout`) leaves no lock: every step is
synchronous, the signal handler runs only between phases and removes the half-built directory.
`SIGKILL` and a power loss are the residual. The process log's lock recovers by itself (30
seconds), but `triage-ledger.json.lock` does not: its message explicitly forbids deleting the lock
by hand, because the tool does not delete what it did not create. A person removes it, and only
after making sure of all three:

1. the directory `triage-ledger.json.lock` is **empty** (the process log's lock holds an owner
   record inside, this one holds nothing);
2. in `backup.log` the last run is cut off, and the lock's time matches it;
3. there is no live backup process — `pgrep -fl operational-backup.mjs` is empty.

Only then: `rmdir <checkout>/triage-ledger.json.lock`. If even one condition does not hold, a live
session holds the lock, and removing it will break that session's transaction.

## 8. Restore

This is a manual procedure. There is no automatic restore command, on purpose: a mistake in one
writes over the live state. There are two cases: individual members are damaged (8.1), or the whole
operational folder is lost (8.2).

### 8.1. Individual members

1. **Unload the schedule.** `launchctl bootout gui/$(id -u)/com.job-search-pipeline.backup`.
   Otherwise the next run takes a copy of a half-restored state, and it takes a slot.
2. **Check the copy** — `verify --backup <stamp>`. Restore only from a confirmed one.
3. **Make sure nobody is writing**: there are no pipeline sessions and no lock files in the
   checkout.
4. **Move the damaged state aside, do not delete it**: rename the members being restored to
   `<name>.damaged-<date>`. Until the restore is proven to have worked, this is the only copy of
   what was there. In the operational checkout — next to the original. **In the operational folder
   — outside it**: under a new name inside the folder only the ledger files stay in the state zone,
   while, for example, `output.damaged-…` at the root falls into the engine zone, and every pipeline
   step will refuse with `engine_tree_drift`.
5. **Copy the needed members** from the snapshot into their places. A single member can be
   restored too: `output/` without the ledger makes no sense, but the pair "ledger + its store" is
   the usual case. `ops-manifest.json` from the snapshot is not put in place: only `tools/ops-tree/`
   writes the marker.
6. **Read the restored state through the normal paths**: `node tools/process-log.mjs validate` and
   `node tools/triage-ledger.mjs validate`. An error here means the restore failed.
7. **Load the schedule back** (`launchctl bootstrap …`) and confirm with the check of [Is it alive](#5-is-it-alive).
8. The user deletes the `.damaged-*` set aside once satisfied — not the procedure.

### 8.2. The whole operational folder

When the folder is gone, or its engine and layer zones cannot be restored, it is rebuilt from the
tags, and the state is taken from a snapshot. A snapshot taken before the day of the switch carries
no marker — then this section does not apply, and the restore follows 8.1.

1. **Unload the schedule**, as in 8.1, and **check the snapshot** — `verify --backup <stamp>`.
2. **Read the snapshot's marker** — `<stamp>/ops-manifest.json`: `engine.tag`, `candidate.tag` and
   the `repository` of each. A marker with `state: building` names the previous pair of tags, and an
   export by it is consistent.
3. **Move what is left of the folder outside it**, if anything is left:
   `mv <folder> <folder>.damaged-<date>`. The folder's path is kept — the installed plist names it.
4. **Export the engine and the layer** into the same path (the directory must not exist or must be
   empty, and neither it nor its parents may lie in a git repository):

   ```bash
   npm run ops:export -- --release <engine.tag> --candidate <candidate.tag> --engine-repo <abs> --candidate-repo <abs> --root <folder>
   ```

   Any copy of the engine with `tools/ops-tree/` can run the command; `npm ci` in the export needs
   access to the package registry or its cache.
5. **Copy the state members** from the snapshot into the new folder — everything the snapshot holds
   except `ops-manifest.json` and `manifest.json`: the export wrote its own marker, and the
   snapshot's manifest is not a file of the folder.
6. **Check**: `npm run ops:verify`, `node tools/process-log.mjs validate`,
   `node tools/triage-ledger.mjs validate` and `npm run preflight` from the new folder.
7. **Load the schedule back** and confirm with the check of [Is it alive](#5-is-it-alive); the report of the first
   snapshot carries `source_identity: marker`.

Not restored: `.ops-tree/` — the kept trees of past cutovers and their evidence — and
`telegram-sweeps/`; the new folder has nothing to roll back to until its first cutover.

The restore of individual members (8.1) was rehearsed when it went into use, on 2026-09-01, on a
site that **already held other state**, so that its step 4 was really performed and not skipped as
a copy into emptiness; the result of the rehearsal is kept in the private development history.
