# Cutover and the initial checkout split

Invariant numbers refer to the development gitflow runbook (in the private pre-switch archive).

## Cutover into `ops/current`

By default, vacancies already in progress finish entirely on the previous operational release.

A cutover that moves the source-key policy from version 1 to 2 additionally follows
[source-key-v2-cutover.md](source-key-v2-cutover.md): a census before the cutover, a ledger backup
right after the source update and before the first `start`, and a rollback that restores the ledger
rather than rolling back the release. It does not replace the requirements of this section.

A cutover between steps is allowed only when all of the following hold at once:

- there is no `running` attempt;
- there is no prepared publication/recovery journal;
- `node tools/process-log.mjs validate --deep` passes in the operational worktree;
- a versioned fingerprint record is taken before the cutover and must match after it on the
  protected inventory/content and the ledger ([write-boundary-map.md](write-boundary-map.md));
  metadata-only churn stays a separate diagnostic, and a `fingerprintVersion` mismatch requires an
  explicit cutover explanation;
- the new release reads every old schema version that actually occurs;
- the change requires no hidden/bulk migration;
- no existing process is upgraded automatically;
- the source update does not touch unrelated operational files;
- if the cutover's `git diff` is the first to bring into `ops/current` a `.claude/settings.json`
  with `sandbox.enabled: true`, a **real** render under that sandbox is run before the cutover and
  its output is attached to the cutover evidence. The command is the documented entrypoint of the
  builder, `tools/cv-builder/build.sh` (see its [README](../../tools/cv-builder/README.md)), on any
  already published `cv.json`. A test run is no substitute: the suite injects synthetic
  dependencies and fake `soffice` paths, so LibreOffice never starts in it and it can prove
  nothing. The write policy is cwd-relative and does not restrict an operational session, but the
  restriction on registering Mach services does, and the builder starts LibreOffice the same way
  the browser test starts headless Chrome. **Under the sandbox the render does not fail, it hangs
  — silence is not success.** The probe runs in the runtime the operational sessions will actually
  use — in a runtime without the sandbox the render passes and proves nothing. If the render does
  not pass, the cutover leaves a local `.claude/settings.local.json` with the sandbox off in the
  operational checkout; the file is not covered by this repository's `.gitignore` and is invisible
  to the gates only where the user's global excludes hide it, so it is recorded in the cutover
  evidence explicitly. A third entry in `sandbox.excludedCommands` is not a workaround: the list is
  closed at exactly two entries by the pin in `tests/operational-write-boundary.test.mjs` and by
  pre-switch operational write boundary (in the private pre-switch archive) of development gitflow (in the private pre-switch archive), so a third entry turns the
  development gates red; besides, the runtime matches an exclusion literally against the session's
  statement, and the render command carries the path to its own vacancy's `cv.json`, so no fixed
  entry can cover the real invocations. A legitimate extension of the list is a separate
  development task that deliberately edits the pin and the owner documents, never a side effect
  of a cutover.

A cutover is the only place where the steps marked `[cutover]` in the
[runtime smoke checklist](../runtime-smoke-checklist.md) can be executed: they need a real ledger
or a live skill invocation, and development sessions are closed off by invariants 2 and 6. Tasks
whose diff matched the globs in the checklist's header name this debt in their `## Result`; the
cutover settles it and records the outcome in its evidence.

Rehearsal worktrees neither affect a cutover nor delay it: they are not a cutover source, their
state does not move into `ops/current` ([rehearsal-worktree.md](rehearsal-worktree.md)), and none
of the conditions above concerns them. Open rehearsal trees are named in the cutover evidence as a
fact.

The candidate layer belongs to the operational checkout just as the ledger and `output/` do: it
lives in the ignored `candidate/`, and a cutover neither carries it over nor touches it — except
for the transfer step below. `bootstrap --init` does not create it there and prints a refusal with
the code `candidate_seed_refused_in_operational_checkout` — the tracked `candidate.example/` holds
a fictional candidate, who must never end up under a real letter. The first time, the directory is
created empty by hand, and `config.json` and the documents arrive in it through the transfer step
below; the example files are never copied into the operational layer. From then on
`npm run preflight` checks it along with everything else, and its absence stays a report field,
not a refusal. A present layer must hold `config.json`, `profile.md`, `levers.md` and `rules.md`,
and every language in the config's `languages.additional` its own pack in `languages/<language>/`,
whose pins `npm run candidate:check` executes; the form of every layer file is owned by
`tools/candidate/README.md`. Three checked files are optional: `letter-samples.md` with accepted
letters, `letter-reader-examples.md` with example findings for the letter reader, and
`constraints.json` with personal constraints — banned phrases, preferred terms, mandatory
spellings (`tools/candidate/README.md`). A constraint refuses the publication of a CV or a letter
and is lifted only by an edit of that file, so a ban that today lives only as a note is written
here. A broken `constraints.json` is a refusal of `npm run preflight`; a missing file is no
refusal and is not visible in the report at all, so how many constraints were read is shown by
`npm run candidate:check`, not by preflight.

**Transfer of the candidate documents.** The layer's files are edited not here but in `candidate/`
of the `main` worktree — a separate git repository that the engine ignores. The step transfers them
from there into `candidate/` of this checkout from the commit the user names, and only on the
user's word; no commit named, no step. The step's place is after the checkout switches to the new
release and before the first step of a run. No repository — stop: the bytes of its first version
lie in the history of `main`, at `0c29612^:candidate.handover/`, and restoring it is the user's
decision.

Transferred are `config.json`, `profile.md`, `levers.md`, `rules.md` — these must be in the
commit — `constraints.json`, `letter-samples.md`, `letter-reader-examples.md` and `memory.md` if
they are there, and the `languages/` directory — the packs of the configured languages. Every entry
of the directory is checked against the pack's form: a regular file (mode `100644`) whose path is in
the pack's set of files; any other entry is a stop before the export. A task that introduces a new layer file adds
it to this list. The step does not touch `research/` or anything else the runs write. Git in the
worktree's repository is called only as below — `rev-parse`, `cat-file` and `ls-tree` with
`core.fsmonitor` and hooks turned off: its config is written by development sessions. The
commands run from the root of the operational checkout. First the files of the commit are
exported into `candidate/.incoming/` and checked by the code of the new release:

```sh
repo=<absolute path of candidate/ in the main worktree>
g() { git -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-pager -C "$repo" "$@"; }
sha=$(g rev-parse --verify --quiet "<commit>^{commit}") || exit 1
echo "$sha"
for file in config.json profile.md levers.md rules.md; do g cat-file -e "$sha:$file" || exit 1; done
rm -rf candidate/.incoming && mkdir candidate/.incoming || exit 1
for file in config.json profile.md levers.md rules.md constraints.json letter-samples.md letter-reader-examples.md memory.md; do
  g cat-file -e "$sha:$file" 2>/dev/null || continue
  g cat-file blob "$sha:$file" > "candidate/.incoming/$file" || exit 1
done
pack='^100644 blob [0-9a-f]+[[:blank:]]languages/[A-Z][a-z]+/(pack[.]json|constraints[.]json|language-rules[.]md|pins[.]json|pins/[a-z][a-z0-9-]{0,63}[.]txt)$'
mkdir candidate/.incoming/languages || exit 1
g ls-tree -r -z "$sha" -- languages > candidate/.incoming/.tree || { rm -rf candidate/.incoming; exit 1; }
tree=$(tr '\0' '\n' < candidate/.incoming/.tree) && rm candidate/.incoming/.tree || exit 1
if [ -n "$tree" ]; then
  printf '%s\n' "$tree" | grep -Ev "$pack" | grep -q . && { echo "languages/ holds an entry no pack holds"; rm -rf candidate/.incoming; exit 1; }
  for entry in $(printf '%s\n' "$tree" | cut -f2); do
    mkdir -p "candidate/.incoming/$(dirname "$entry")" || exit 1
    g cat-file blob "$sha:$entry" > "candidate/.incoming/$entry" || exit 1
  done
fi
npm run candidate:check -- --root "$PWD/candidate/.incoming" || { rm -rf candidate/.incoming; exit 1; }
for file in config.json profile.md levers.md rules.md constraints.json letter-samples.md letter-reader-examples.md memory.md; do
  if [ -e "candidate/$file" ] || [ -e "candidate/.incoming/$file" ]; then
    diff -u -N "candidate/$file" "candidate/.incoming/$file"
  fi
  [ -e "$repo/$file" ] || [ -e "candidate/.incoming/$file" ] || continue
  cmp -s "$repo/$file" "candidate/.incoming/$file" || echo "working file differs from $sha: $file"
done
if [ -d candidate/languages ]; then
  diff -r -u -N -x '.*' candidate/languages candidate/.incoming/languages
  ls candidate/languages | while IFS= read -r name; do
    if [ -d "candidate/languages/$name" ] && printf '%s\n' "$name" | grep -Eqx '[A-Z][a-z]+'; then
      [ -d "candidate/.incoming/languages/$name" ] || echo "pack not in $sha: $name"
    else
      echo "not a pack, the layer check refuses it: $name"
    fi
  done
else
  ls -R candidate/.incoming/languages
fi
if [ -d "$repo/languages" ]; then
  diff -r -q -x '.*' "$repo/languages" candidate/.incoming/languages || echo "working packs differ from $sha"
fi
```

The user is shown five things: the difference for each file and each pack; the files whose working
copy in the repository differs from the transferred commit — those edits are not transferred; the
packs that are missing from the commit but present in the operational layer (`pack not in`); the
entries of the operational folder's packs that are not a pack (`not a pack`): the transfer does not
touch them, but the layer check after it refuses on them, so such an entry is deleted before the
transfer, only on the user's word — `rm -rf "candidate/languages/<name>"` before the block below;
and the open processes with a published brief, if `profile.md`, `levers.md` or `rules.md` changes —
these are protected inputs of the brief, and every such process will need Step 3 published again.
A refusal of the check is a stop, and the operational layer stays untouched. A pack missing from
the commit is deleted only on the user's word — `rm -rf candidate/languages/<language>` before the
block below; a refusal is a stop, and the layer stays untouched: the pack of an unconfigured
language would not pass the check after the transfer. On the user's word, from the same root:

```sh
[ -f candidate/.incoming/config.json ] || exit 1
for file in config.json profile.md levers.md rules.md constraints.json letter-samples.md letter-reader-examples.md memory.md; do
  [ -e "candidate/.incoming/$file" ] || continue
  mv "candidate/.incoming/$file" "candidate/$file" || exit 1
done
mkdir -p candidate/languages || exit 1
for name in $(ls candidate/.incoming/languages); do
  rm -rf "candidate/languages/$name" && mv "candidate/.incoming/languages/$name" "candidate/languages/$name" || exit 1
done
rm -rf candidate/.incoming
```

A refusal by the user is the same `rm -rf candidate/.incoming` without a write. An optional file
that is missing from the commit but present in `candidate/` is deleted only on a separate word of
the user. The cutover evidence records the commit's `sha`, the changed files and the named
processes.

On every cutover, after the checkout switches and before the first step of a run,
`npm run candidate:check` returns `ready`; a refusal stops the cutover.

After the cutover:

- old published artifacts keep their previous versions;
- a new process publishes the latest version;
- an existing process changes version only through the provided explicit reopen;
- a reopen invalidates the descendants in the usual way.

If compatibility is not proven, active processes continue in the previous operational worktree
until a terminal state; the source under them is not updated.

## Cutover of the operational folder — in force from the day of the switch

From the day of the switch the operational copy is not the `ops/current` checkout but a folder
without `.git`, assembled by `tools/ops-tree/` from an engine tag and a private-layer tag. The
section above does not apply to it; the tool, its zones and its codes are owned by
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

## Initial checkout split

Done once in August 2026 and not repeated on this machine. The principles, should the contour need
to be reproduced: classify every uncommitted change before any mutation; a read-only
`validate --deep`; reviewed commits without `git add -A`; a fingerprint record
([write-boundary-map.md](write-boundary-map.md)) before and after; bind the existing checkout with
`output/` to `ops/current` without copying or moving operational files; only then create a
separate linked worktree for `main`. No `cp`/`rsync`/bundle, no move of the primary checkout, no
automatic cleanup.
