# Cutover of the operational folder

The operational folder has no `.git` and is assembled from an engine tag and a private-layer tag.
The tool, its zones and codes are owned by
[tools/ops-tree/README.md](../../tools/ops-tree/README.md).

1. **The released pair.** Use the exact pair authorized and checked under
   [development flow, release and cutover](development-flow.md#8-release-and-cutover). It always
   names both versions; new tags are needed only for included changes that are not already
   tagged. An unchanged component's tag is explicitly reused. Before a normal release cutover,
   confirm both refs were published and match the release record's tag objects and commits;
   resolve the local tags to the recorded commits and trees. A partial publication or conflicting
   ref is a stop. The documented locally tagged rehearsal remains a separate case. Compare the
   installed manifest with the record's baseline and reassess any intervening change. A release
   does not authorize this folder's cutover.
2. **A dry run** in the folder: `npm run ops:cutover -- --release <tag> --candidate <tag> --dry-run`.
   Save the command/result and the separately resolved baseline and target commits/trees in the
   operational state zone, for example `.temp-docs/`; the dry-run report names tags, not SHAs, and
   is not written as cutover evidence automatically. The user is shown: the change of tags; the
   drift (every path changed or added in the folder by hand — the cutover will replace it, and it
   will remain only in the kept tree); stale running steps; and the new deep-validation findings.
   Classify those findings before authorization: expected input drift, incompatible data or other
   unresolved defects. A refusal of the pair check or of the journal is a stop. Dry run uses
   service lock/staging files; it does not replace working zones. It checks this state at this
   time, and the actual command repeats its gates and checks.
3. **Gates.** A step started less than 24 hours ago, a prepared publication of any age and the
   triage lock refuse. A prepared publication is first completed with
   `node tools/process-log.mjs reconcile-step`. A refusal can be overridden only on the user's
   word: the words are written as a file `.pipeline-input/input-<32 hex>.json` with the field
   `overrideReason` (the transport of [pipeline-artifacts.md](../../instructions/pipeline-artifacts.md))
   and passed with `--input-file`; the reason and the lifted refusals go into the evidence
   `.ops-tree/cutovers/<stamp>.json`.
4. **Cutover** — verify the same target refs again and run the same command without `--dry-run`,
   on the user's word. It rebuilds and swaps both zones and dependencies even when one tag is
   reused. Connect the resulting manifest's tags/commits/trees and the evidence stamp to the
   private release record; the tool does not enforce that connection. The backup agent is not
   unloaded: the swap does not touch the backup members. After it — one snapshot and a freshness
   check: `npm run backup -- run --dest ~/Backups/job-search-pipeline`, then
   `npm run backup -- verify --dest ~/Backups/job-search-pipeline --max-age-hours 36`.
5. **Rollback** — `npm run ops:rollback`, on the user's word: it brings back the previous pair together with its files,
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
   `npm run ops:verify` names the paths; a cutover onto the exact current pair of tags rebuilds
   both zones without new tags. Keep the same dry-run, authorization and state safeguards and
   record this as recovery. Rollback also needs no new tags; it uses the retained tree. Neither
   operation resets or migrates the ledger or published materials.
7. **Smoke.** The steps marked `[cutover]` in the [smoke checklist](../runtime-smoke-checklist.md)
   are executed here, after the swap; their outcome is reported by the user or the operational
   session and recorded by the development session — in the task in which the user said to cut the
   release.

## Compatibility and runtime checks

The selected pair must read every schema version actually in use, without a hidden bulk migration
or automatically upgrading existing processes. Review contracts against these selected revisions;
the development checkout's validation or equal tag dates do not prove it. Published artifacts keep
their versions; an explicit reopen invalidates descendants in the usual way. If compatibility is
unproven, active processes finish on the previous pair. The same rule applies before returning to
an older retained engine after the operational state has changed: rollback restores code and the
layer, not an older ledger, and does not run a new pair/deep check before swapping.

The existing image checks have distinct scopes. Export, or a cutover without a ledger, invokes
the selected engine's candidate CLI, including language pins. With a ledger, cutover invokes the
selected image's bootstrap, checks a copy of `process-log.json` and `output/` with `validate --deep`,
and compares it to the current deep report. `stopped_by_swap` contains newly reported findings,
including findings other than stale inputs. A readable report can contain corruption or
unsupported artifacts; a successful dry run alone does not approve them. Other state, such as
triage batches, is not copied into this deep check, so review the applicable version contracts and
run the change's required checks before calling that state compatible. Semantic review and runtime
smoke remain separate evidence.

`npm run candidate:check` must return `ready` before the first step. A change to a Step 3 protected
input makes the brief stale and stops Steps 4/5 until Step 3 is republished. A change pinned only by
a published Step 4/5 yields `published_inputs_stale`, with the behavior owned by
[what a step pins](../../tools/candidate/README.md#what-a-step-pins). These are expected input
consequences, not proof of an incompatible engine/candidate pair. Missing required inputs,
unreadable schema or artifacts corrupted by a removed language are not ordinary stale briefs;
leave compatibility unresolved until they are addressed. No automatic regeneration occurs.

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
