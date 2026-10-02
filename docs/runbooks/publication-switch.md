# Publication switch

This is the one-time move from the private predecessor to the two-repository layout of
[ADR 0024](../adr/0024-two-repositories-one-snapshot.md). Completing an export does not publish
it, cut tags, move production state or authorize a switch. The user performs those steps and
records their evidence. After the switch, [development-flow.md](development-flow.md) governs.
The predecessor stays a private, read-only archive. Its engine history is never pushed to the
new repository. The existing private candidate repository keeps its own history.

## 1. Freeze and inventory

Stop operational sessions and collectors. Finish active attempts and prepared publications,
or keep production on the old checkout until they reach a terminal state. Refuse a migration
while a process-log lock, triage lock, collector or backup is running; do not copy live ledgers.
Run the old engine's deep ledger validation and take a verified backup as described in
[operational-backup.md](operational-backup.md). Save the old checkout path, engine SHA, private
repository SHA and remote, state inventory with file digests, validation result and backup path
in private migration evidence. Before archiving or moving the old primary, census all branches,
linked task/rehearsal worktrees and their uncommitted or unharvested evidence. Preserve unfinished
work and harvest rehearsals before removing any tree; a historical residue list is not authority
to delete today's trees. Create a local `git bundle create <private backup path> --all` and
verify it with `git bundle verify <private backup path>`; it remains private and is never fetched
into the public engine. No live URL, private path, inventory or scan report belongs in
public GitHub logs.

Read the actual zone table in [tools/ops-tree](../../tools/ops-tree/README.md#zones). Inventory
all existing state and handover paths, including:

- `process-log.json` and its backup siblings, `output/`, `triage-ledger.json`, `triage-batches/`;
- `telegram-sources.json`, `telegram-sweep-state.json`, `telegram-sweeps/`, `records/`, `outbox/`;
- the temporary legacy `candidate/research/` corpus, `.pipeline-input/`, `.temp-docs/`,
  `.playwright-mcp/`, `pkcs11.txt`, `.vscode/`, `.idea/`, `.claude/.cc-writes/` when present.

Classify any extra path before moving it. Never copy `.git`, engine files, dependencies or a
private working tree over an exported zone. Keep the old copy untouched as rollback storage.
Do not carry stale lock files or an old `.claude/settings.local.json` into the new folder;
archive them in the private evidence. The setup renders current machine settings later.

Confirm that the private repository's committed candidate data is the intended production
version. Compare the operational copy against that SHA; report differences rather than silently
choosing one. The switch must not overwrite uncommitted private edits. The current compatible pair reads
candidate schema 3, scorer input 9, policy v8 and taxonomy v6; confirm the selected tags preserve
that contract. Old processes and archived batches retain their versions; no hidden migration runs. Ensure its
`publishability-markers.json` is nonempty, reviewed against the actual profile and constraints,
and contains the same reviewed language-data paths as the fictional example. Install and commit
`machine/settings.local.json` and `machine/backup.plist` from the example if missing. Confirm
`npm run candidate:check -- --root <private repository>` succeeds. This is a separate private
commit, never an engine commit.

## 2. Export a committed main snapshot

Use the pinned Node/npm versions, Git, tar, LibreOffice and poppler listed by
[tools/setup](../../tools/setup/README.md). Choose a new target outside the source checkout,
with an existing parent directory. Resolve the selected commit of `main` to its full SHA.
Select a public author name that contains no private marker, and the account's GitHub noreply
address. Author and committer both use that address.

```sh
npm run public:export -- --source <absolute predecessor root> --rev <full main SHA> \
  --target <absolute new engine root> --candidate-root <absolute private repository> \
  --email <GitHub noreply address> --name "Engine Maintainer"
```

The exporter reads committed bytes through `git archive`, applies the exclusion list from the
same commit, checks the retained blob inventory, requires personal markers, runs the full
blocking scan and all local Markdown links, and runs `npm run ci` without a private layer. Only
then does it return a ready directory. Failure deletes only its staging directory; an existing
target is refused. Source working files and private data are not exported. The returned JSON
records the source SHA, public SHA and gate results; save it outside the public tree.

For a local trial with already installed, verified dependencies, add
`--dependency-root <the same absolute source root>`. This explicitly copies dependencies from
that checkout; the public commit and mandatory gate are identical. Use the normal install path
for publication. There is no skip-gate option. No license is added: the license decision remains
with the user.

Inspect the ready repository: one root commit, no parent, no remotes, no object alternates,
clean status, and no real layer or operational state. Review `git show --format=fuller` and
`git ls-files`; the source SHA belongs in private evidence, not in the initial public message.
Do not add the old repository as a remote, fetch its refs, or use a mirror push.

## 3. Publish and configure GitHub

In the account's email settings, enable email privacy and blocking command-line pushes that
expose the personal email. Use the exact noreply address GitHub displays; account creation date
changes its form. GitHub's email block checks the most recent commit, so it complements the
exporter's author/committer check rather than replacing it
([email privacy](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/blocking-command-line-pushes-that-expose-your-personal-email-address),
[noreply forms](https://docs.github.com/en/account-and-profile/reference/email-addresses-reference)).

Create a new empty **public** repository without an initial README, ignore file or license.
Set local `user.name` and `user.email` in the new engine. Push the reviewed private candidate
commit to its existing private remote first. Before any engine push, from the exported root run
`npm run setup:machine -- --private <existing private repository URL>` without `--operational`.
This installs the ignored nested private clone with real markers and the absolute hook path
required by [the push guard](../../tools/push-guard/README.md). Verify
`git config core.hooksPath` is absolute; a relative path refuses. Add only the new public remote
and push only `main`,
without `--no-verify`, `--mirror`, `--all` or old tags. Wait for the first server `gate` to pass
on the public SHA. A failed server run is a stop; diagnose it before enabling required checks.

From the new engine, run:

```sh
npm run setup:github -- --repo <owner>/<engine>
npm run setup:github -- --repo <owner>/<engine> --check
```

[The setup contract](../../tools/setup/README.md#the-github-repository) owns the exact settings:
Issues, Wiki and Discussions off; merge commits only; no auto-merge; PR required on `main`,
zero required approvals, current branch and green GitHub Actions `gate`; no bypass, force push
or deletion; protected release tags. Do not enable linear history, which forbids merge commits
([GitHub rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)).
Enable secret scanning and repository push protection in the public repository's security
settings and verify both there. These public features do not imply availability on a private
Free repository
([secret scanning](https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning),
[push protection](https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection)).
Record the live server response and readback. The mocked setup tests cannot establish that GitHub
accepts every API field, strict required-check setting or ruleset on this account. Verify an
outdated or red PR is blocked and an eligible PR offers a merge commit; the user merges PRs.

## 4. First tags, then retire the old hook registration

Use the verified exported engine as `<projects>/engine`, or clone the published engine there. Run
`npm run setup:machine -- --private <existing private repository URL>` there, without
`--operational` yet. It clones the existing private history into the ignored `candidate/`
directory and installs dependencies and hooks. Check private `HEAD` and its ancestry against
the saved SHA; do not initialize or squash it. Configure a noreply identity on every engine
clone. Do not start a development session or file a nested private task yet.

On the user's explicit release instruction, cut the first pair of tags on both repositories'
`main`: `release-<YYYYMMDD>` and `candidate-<YYYYMMDD>` (use the documented `.2` suffix for a
second pair that day). These first tags retain **both** file-tool hooks.

Before the first development write into nested `candidate/`, make the transition commit on an
engine task branch: remove only the `operational-write-boundary.mjs` command entry from
`.claude/settings.json` and its expectation in `tests/operational-write-boundary.test.mjs`
(`EXPECTED_HOOKS`) and `tests/disposable-workspace.test.mjs` (the hooks literal). Keep
`write-guard.mjs` registered. Run focused hook tests and the full gate, open the PR, and let the
user merge it with a merge commit. This runbook step needs no private-board task: filing one
would already hit the old guard. The old hook implementation, behavioral suite and obsolete
transition tools remain until the private post-switch cleanup task 182.

Update the engine clone with `git pull --ff-only`. On the user's word, cut a new engine release
tag for this commit. Do not build production from the old first tag after this transition.

## 5. Import the board without replacing private history

In a disposable engine clone with an empty, ignored `candidate/`, run the old source's board
export, using the same committed source SHA, **without `--layer` or `--remote`**:

```sh
npm run board:init -- --source <absolute predecessor root> --rev <full main SHA> \
  --engine <absolute disposable engine clone>
```

This temporary repository only stages the excluded materials. Its generated `board/README.md`
is the new format. The old board README, gitflow, source layout seal, legacy pins and their exact
exceptions are preserved under `archive/pre-switch/`; closed tasks keep their ids in `board/done/`.
Every excluded file has a placement, and collisions refuse.

Compare the staged paths with the existing private clone **before copying**. Import only
`board/`, `decisions/`, `research/` and `archive/` into the existing private history, excluding
the staging repository's `.git` and generated `.gitignore`. For each overlapping path compare
bytes: an identical file can stay; differing content requires an explicit decision recorded in
private evidence. Do not use a bulk overwrite or merge unrelated histories. Confirm all task ids
and excluded-source files were preserved once, the new board README is intact, and no candidate
profile/configuration file changed. Commit explicit imported paths on private `main`, push the
private repository normally, and confirm the saved candidate SHA remains an ancestor. Before the final private tag, import the frozen
operational letter corpus with `npm run records:import -- --ops-root <old operational root>
--candidate-root <existing private clone>`, review its result, commit the exact private corpus
paths and push. An overlap with repository research requires a byte/digest census and an
explicit collision decision; never choose a source by bulk overwrite.

Remove the disposable staging clone. On the user's word, tag the resulting private snapshot.

## 6. Build and transfer the operational folder

Create `<projects>/job-search-pipeline` beside the engine as an empty folder outside every Git
repository. From the engine:

```sh
npm run ops:export -- --release <new engine release tag> --candidate <private snapshot tag> \
  --engine-repo <absolute engine clone> --candidate-repo <absolute private clone> \
  --root <absolute projects directory>/job-search-pipeline
```

Use the engine tag with only the new hook registered. Exported candidate data excludes the
board, personal decisions, machine templates and repository research. Transfer the frozen state
and handover entries from the inventory into their declared zones, checking each file digest
against the old copy. Transfer the legacy operational `candidate/research/` only as state; it is
not the private repository's research archive. Stop on any undeclared destination or collision.
Do not transfer dependencies; the export installs them. Do not mutate or delete the old checkout.

Run `npm run ops:verify`, `npm run preflight`, `npm run candidate:check`, and
`node tools/process-log.mjs validate --deep` from the new folder. Compare deep validation with
the saved baseline; a new failure is a stop. Compare file counts and digests for each transferred
state/handover member, and verify there is no `.git` anywhere under the folder. Record both tags,
SHAs, manifest and transfer results in private evidence. Redirect operational sessions only
after all these checks pass.

## 7. Machine setup, backup and runtime evidence

Unload the old LaunchAgent and preserve its plist and logs. If existing target settings/plist
have different content, archive them explicitly before setup: the script refuses overwrites.
From the engine run:

```sh
npm run setup:machine -- --private <existing private repository URL> --operational
npm run setup:machine -- --private <existing private repository URL> --operational --check
```

Inspect the rendered plist's script path: it must point into the new operational folder, not the
old checkout or a development clone. Check the registered LaunchAgent with `launchctl` and
retain the old restore path. In the new folder run a backup and a freshness verification:

```sh
npm run backup -- run --dest <absolute backup directory>
npm run backup -- verify --dest <absolute backup directory> --max-age-hours 36
```

The first run must report **`source_identity: marker`**. Verify the returned snapshot with
`npm run backup -- verify --backup <absolute snapshot directory>` and its manifest inventory.
The backup covers mutable state and handover, not the two Git histories; push those separately.
Do not resume production if the identity fallback or freshness check fails.

Execute the `[cutover]` steps of [the runtime smoke checklist](../runtime-smoke-checklist.md).
In the actual desktop runtime, from an operational-folder session, attempt a file-tool `Write`
into an engine-zone probe path. Expect refusal with **`[read_only_zone]`**, with no file created.
Record runtime/version, cwd, exact probe, outcome and diagnostic. A script-only hook test is not
this evidence. If the project hook does not execute, record the desktop file-tool channel as
open in the migration evidence and keep engine zones read-only by operating discipline until the
boundary is fixed. Verify a state-zone write is allowed. Never probe a real ledger or canon file.

## 8. Rollback and completion record

Before resuming production, rollback means point sessions back to the unchanged old checkout,
restore/reload its saved LaunchAgent and local settings, and verify its backup and deep ledger
validation. Preserve the new folder for diagnosis. After production writes in the new folder,
freeze it first: do not select the stale old state. Reconcile changed state explicitly against
its inventory or restore the verified latest snapshot. For later tag swaps use
[ops-cutover rollback](ops-cutover.md#cutover-of-the-operational-folder--in-force-from-the-day-of-the-switch).

The private completion record contains source/public SHAs, public author/committer check, local
and server gates, GitHub setup readback/security settings, preserved private ancestry, first and
transition tags, hook-registration PR, board import/collisions, state digest comparison, runtime
probe, machine setup readback, first backup marker identity and verified snapshot. Any unperformed
live check stays explicitly pending. Only then mark the switch complete and start post-switch
cleanup task 182. Keep the predecessor private and archived; never publish its refs.
