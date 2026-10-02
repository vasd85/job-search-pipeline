# Rehearsal worktree

Invariant numbers refer to the development gitflow runbook (in the private pre-switch archive).

This runbook is in force until the day of the switch. From that day a run with real URLs goes into
a sealed folder under [Rehearsal](development-flow.md#10-rehearsal) of the [development flow document](development-flow.md), and this
runbook does not apply to such a folder.

## `rehearsal/<label>` — rehearsal worktree

A one-time linked worktree for runs with **real URLs** that are not production: a measurement, a
comparison of transports, a check of a procedure on live pages. It exists because such a run has no
place either in `ops/current` (it is not the processing of vacancies, and its state must not reach
the real ledger) or in a task worktree (where invariant 6 forbids such a run).

Identity:

- the branch is `rehearsal/<label>`. `<label>` names the **tree**, not a batch: it comes from the
  purpose of the run and lives as long as the tree;
- every batch inside the tree has its own `<batch-label>` — one name for both `--batch` and
  the ledger's `batch_id`. So it must pass both validators, and what they share is lowercase Latin
  letters, digits and the hyphen, the first character not a hyphen, up to 64 characters. A dot,
  an underscore and a capital letter are accepted by the ledger but not by the fetch layer: it will
  reject such a batch with `batch_invalid` before the first request. The owner of this rule is
  [tools/vacancy-fetch/README.md](../../tools/vacancy-fetch/README.md);
- `<label>` takes the same alphabet as `<batch-label>`: the tree's first batch is usually named
  like the tree, and a slash or a dot in the tree's name would break exactly that batch;
- every later batch takes a new `<batch-label>`, with a suffix. There is no other way: the batch
  directory is append-only, and the tool rejects an `--out-dir` that already holds a manifest or
  captures;
- the branch is created from a **named** commit and is never merged anywhere: no commits of its own
  appear on it at all — everything a run produces is untracked state, not history;
- the linked worktree lives inside the same container as the other linked worktrees
  (`<repo-parent>/job-search-pipeline-worktrees/rehearsal/<label>/`);
- the pinned base sha is recorded in `.rehearsal/base.json` at the root of this worktree; the
  `.rehearsal/` directory itself is ignored;
- its own ignored `process-log.json`, `triage-ledger.json` and `output/` are created here explicitly
  when the tree is created (the section "Creating a rehearsal worktree, session choreography,
  repin"). `.pipeline-input/` needs no separate command: the producer of ADR 0011 envelopes creates
  it on the first CLI call.

What a rehearsal worktree is **not**:

- **not a development worktree.** Source is not edited here, no backlog task is carried out here,
  and the commits of this branch are not integrated into `main`. The ban of pre-switch operational write boundary (in the private pre-switch archive) on a copy of
  `process-log.json` in a development worktree does not extend to it: here the ledger is part of
  the role, not a leak.
- **not a disposable test root.** Automated tests still receive an injected `workspaceRoot`,
  `outputRoot` and ledger (invariant 7); the rehearsal directory is not substituted for them.
- **not a cutover source.** `ops/current` receives neither source nor state from here
  ([ops-cutover.md](ops-cutover.md)).
- **not production.** Its ledger rows and its `output/` never become real: they do not move into
  the operational checkout and die with the tree (invariant 6). No application is sent to an
  employer on the strength of materials generated here.

Evidence and the privacy of the harvest:

- everything a batch produced lies in `.rehearsal/batches/<batch-label>/` — the full output
  contract of the invoked skill, not a retelling in chat; a tree can hold several batches, each
  with its own directory;
- `fetch-manifest.json` and `plan.json` carry real vacancy URLs and are **never committed**;
- what goes into git is the written comparison (the task's report) plus `verification-report.json`
  — it is URL-free and byte-deterministic; everything else is referred to by digest and by its path
  inside the rehearsal worktree;
- the committed home of these materials is `docs/research/<label>/`: one directory per tree, not
  per batch, because a comparison is usually built from several batches of one run.

The life cycle is in the sections below: the preflight of the run session, the choreography of the
sessions and the deletion procedure.

## Rehearsal preflight — the run session

The session that lives in the rehearsal worktree and starts a batch runs neither the preflight of
pre-switch task preflight (in the private pre-switch archive) (it has no claim block, and the task file does not belong to it) nor the operational
preflight of [ops-pipeline-codex.md](ops-pipeline-codex.md) (it is not in `ops/current`). Its
checks are its own:

```sh
pwd
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
cat .rehearsal/base.json
git status --short -- ':(exclude).rehearsal'
env | grep '^JOB_PIPELINE_'
```

The same checks in one command — `npm run workspace:reset -- preflight`
([tools/workspace-reset.mjs](../../tools/workspace-reset.mjs)). It only reads, works exclusively
with its own cwd and refuses to run anywhere but a linked worktree on a `rehearsal/<label>` branch;
it prints the pinned base, the state of the lock and whether a ledger exists. The list above stays
the exact description of what it checks, and the authority is here, not in the tool.

Expected:

- `pwd` and the repository root equal the exact path of the rehearsal worktree;
- the branch is the `rehearsal/<label>` of the tree assigned to this session — by a task's claim
  block or by the user's direct request. `<label>` names the tree; a batch has its own
  `<batch-label>` from the same alphabet, and the two names can coincide only for the first batch
  (the section "`rehearsal/<label>` — rehearsal worktree");
- `HEAD` matches the `sha` in `.rehearsal/base.json` — the run measures exactly the named commit,
  not "roughly it";
- the working tree is clean. `.rehearsal/` itself is excluded from the check by a pathspec: the
  base may have been recorded on a commit whose `.gitignore` did not know that line yet, and then a
  clean tree looks like `?? .rehearsal/`;
- `grep` for `JOB_PIPELINE_` finds nothing (empty output, exit 1). An ambient variable would turn
  the run into a measurement of something else.

What this preflight deliberately lacks:

- **no `validate --deep`.** It belongs to the operational ledger. Here the ledger is either just
  created empty or holds the state of an earlier batch of the same run; a "deep" validation says
  nothing about whether the run is fit.
- **no implicit creation of a ledger.** A missing ledger is a stop and an explicit `init` (the
  section "Creating a rehearsal worktree, session choreography, repin"), not a quiet
  materialization along the way.

If the path, the branch or the sha does not match, the session stops and does not fix it with
either `git switch` or `git reset`: a repin is a deliberate operation of the section "Creating a
rehearsal worktree, session choreography, repin", not a self-repair by the preflight.

## Creating a rehearsal worktree, session choreography, repin

**Creation.** The first block is run by the session that carries the task (for an ad-hoc run, the
main session), from its own worktree. `<base-sha>` is the commit the run measures:

```sh
git worktree add <abs-rehearsal-path> -b rehearsal/<label> <base-sha>
git worktree lock --reason "unharvested: <why this run>" <abs-rehearsal-path>
```

`git worktree lock` is set at once, not "when there is something to lose": before it, an ordinary
`git worktree remove` takes the tree down without a single question (the section "Deleting a
rehearsal worktree").

The second block is run by the session whose `cwd` is already the new worktree, that is, the run
session; that is what it is opened for. It cannot be started "from afar", and not by convention:
`tools/bootstrap.mjs` computes the root from its own path, so an `npm run bootstrap:init` started
from another checkout creates `process-log.json` **in that checkout** — exactly the copy whose
absence pre-switch operational write boundary (in the private pre-switch archive) calls the protection, and `git status` will not show it, because the file is
ignored.

```sh
mkdir -p .rehearsal
printf '{"sha":"<base-sha>"}\n' > .rehearsal/base.json
npm run bootstrap:init
node tools/triage-ledger.mjs init
```

`base.json` has one mandatory field, `sha`; beyond it the tree may record anything about itself.
`bootstrap --init` and `triage-ledger init` are sanctioned here by invariant 7: this is one of the
three checkouts where a ledger is created on purpose.

Both blocks, except `git worktree add`, are run by one command started from the new worktree:
`npm run workspace:reset -- init --purpose "<why this run>"`. It sets the lock (a second run does
not set it again), writes `base.json`, runs both creation commands **from this same tree's copies**
and prints what else the tree lacks for Step 4. It never moves the pin under any circumstances: a
`base.json` with another sha is a refusal, not an overwrite.

**Two roles that are never combined in one session.**

*The run session.* Its `cwd` is the rehearsal worktree. It runs the preflight of the section
"Rehearsal preflight — the run session", starts only **explicitly invoked** skills (for real URLs
an explicit run is mandatory here too) and puts the full output contract of every invocation into
`.rehearsal/batches/<batch-label>/`. It does not edit source, does not commit and writes nothing
outside its own worktree. Files cross the boundary, not chat — the same rule as between the steps
of the pipeline.

*The task (analysis) session.* Its `cwd` is its own task worktree, and for an ad-hoc run `main`. It
reads the run's artifacts by an **absolute path** into the rehearsal worktree, writes its
conclusions under its own cwd (`docs/research/<label>/`) and commits them to its branch. It never
starts the pipeline.

What actually holds this separation:

- **The Bash channel — per the map of pre-switch operational write boundary (in the private pre-switch archive).** Where the sandbox is enforced, it lets a session
  write only under its own cwd, and that closes the main thing in both directions: the content of a
  rehearsal tree is not edited from a dev session, and source in `main` and task worktrees is not
  edited from a run session. In the measured desktop/SDK runtime there is no sandbox, and there the
  procedure of this section holds both sides. The exception is named plainly and bounded: the life
  cycle commands of the worktree itself — `add`, `lock`, `unlock`, `remove` — by construction write
  into the shared `.git` and outside the calling session's cwd. That is not work on the tree's
  content: they are run deliberately and named in the report, and deletion is additionally closed
  by the user's explicit confirmation (the section "Deleting a rehearsal worktree"). If the
  session's sandbox rejects them, the user runs the command — there is nothing to bypass it with.
  The provisos of pre-switch operational write boundary (in the private pre-switch archive) apply here too: both halves of the boundary bind only Claude Code, and
  excluded commands run outside the sandbox.
- **The file-tools channel — per the same map of pre-switch operational write boundary (in the private pre-switch archive).** The hook closes both sides
  mechanically: a write into a rehearsal tree from a dev session and a write by the run session
  outside its own tree, including directories outside any repository. The key is the branch name,
  not `.rehearsal/base.json`, and a detached HEAD is refused fail-closed. A proviso about versions:
  each side of the rule runs from the checkout of the session it constrains, so a tree created from
  an earlier sha has no outbound half (a repin cures it), and a checkout that has not yet received
  this version of the hook has no inbound half (the next cutover cures it).
- **The git refs channel — by procedure.** A linked worktree updates refs in the shared `.git`, and
  the boundary of pre-switch operational write boundary (in the private pre-switch archive) does not close this channel; pre-switch operational write boundary (in the private pre-switch archive) already names the same residual
  for a cutover.
- **Codex — outside both halves.** They live in `.claude/`. For Codex, isolation remains the user's
  machine configuration (pre-switch operational write boundary (in the private pre-switch archive)).

**Three scenarios.**

1. *A verification loop inside a dev task.* The task edits source and wants to see the effect on
   live links. The dev session commits the edit to its task branch and names the sha; the run
   session repins onto that sha and runs the batch again; the dev session reads the result and
   edits further. The loop repeats as many times as needed.
2. *A separate run task.* The deliverable of the backlog task is the run itself. The claim is the
   usual one, plus the `rehearsal` key in the claim block (its form is owned by the backlog's
   README, per [ADR 0014](../adr/0014-development-backlog-replaces-remediation-queue.md)); the
   rehearsal worktree is created from the sha the task measures.
3. *An ad-hoc run.* The user asks for a measurement outside any task. The main session creates the
   rehearsal worktree, the evidence is harvested into `docs/research/<label>/`, and whether it
   becomes a backlog task is the user's decision.

One run can be evidence for several tasks at once — they read the same batch directory. That is not
a mixing of tasks: mixing is a shared diff, not a shared measurement.

**Repin.** A rehearsal worktree is moved onto a new named sha; it does not catch up with a task
branch by a merge. The run session does this, from its own worktree:

```sh
git reset --hard <new-sha>
```

then the `sha` in `.rehearsal/base.json` is rewritten. The branch name does not change: `<label>`
names the tree, not a batch. A repin closes the previous batch — the next one takes a **new**
`<batch-label>` and so its own directory: `.rehearsal/batches/` is not touched, it is append-only
evidence, and the tool rejects a repeated `--out-dir` holding someone else's manifest.

The rest of the previous batch's state — the ledger, `output/`, `.pipeline-input/` — is **erased**
before a repin, not kept. This is not tidying for its own sake: a verification loop measures the
same links again, and a ledger that survived the repin would hand them to the next batch as
`skip_known`, leaving nothing to measure. No evidence is lost — it already lies in the previous
batch's `.rehearsal/batches/<batch-label>/`. After the erase, `bootstrap --init` and
`triage-ledger init` are run again: `git reset --hard` restores no untracked file, and the ledger
and `output/` are exactly untracked.

The erase, `git reset --hard` and the repeated init are done by one command:
`npm run workspace:reset -- reset --repin <new-sha>`. Two phases: the first run changes nothing and
prints the exact inventory and a token; the second accepts that token, recomputes the inventory and
refuses on any difference. The list of what is erased is fixed, `.rehearsal/` is outside it, and a
ledger with unreviewed flags is not erased at all without an explicit `--waive-review`. Without
`--repin` the command does the same, minus moving the sha.

## Deleting a rehearsal worktree

Git does not protect evidence that exists only as ignored files. Verified: a tree whose whole content
falls under `.gitignore` is taken down by an ordinary `git worktree remove` — without `--force`,
without questions, with exit code 0. `--force` is needed only for an untracked-but-not-ignored
remainder, so its absence is no protection. The protection is set by hand at creation.

- **The lock.** `git worktree lock --reason "unharvested: <purpose>"` right after
  `git worktree add`. A locked tree answers `git worktree remove --force` with a refusal and exit
  code 128 and prints the reason — that is, it tells whoever deletes it what exactly they are about
  to lose; `git worktree prune` does not touch it either, and `git worktree list --porcelain` shows
  a line `locked <reason>`. The lock is not a wall: `git worktree remove -f -f` overrides it. It
  exists precisely so that a deletion cannot happen unnoticed.
- **The consumer deletes, not the run.** The tree is taken down by the session that brought the
  evidence to a commit. Never by the run session right after a batch, and never "by age": a
  rehearsal tree does not go stale and does not revoke itself.
- **The sequence.** No step is skipped:

  1. **Pre-deletion report.** Record three things: the exact path of the tree — from
     `git worktree list --porcelain` by the branch `rehearsal/<label>`, not from memory; the
     current `git rev-parse rehearsal/<label>`; the contents of `.rehearsal/batches/*`. Against the
     last one — everything in git that refers to the label: the report shows which batches reached
     a commit and which did not. If several tasks read the run, the report lists the commits of
     **all** consumers, and the last of them takes the tree down.
  2. **Make sure nobody works in the tree.** There is no file check to rely on here: the fetch layer
     creates no lock files at all, and the ledger takes `triage-ledger.json.lock` only for a short
     transaction at the end of a batch. So "there is no lock file" proves nothing, while a live
     `*.lock` found is an immediate stop. The real answer comes from the run session itself: until
     it has finished and said so, the tree is not taken down.
  3. **The user's explicit confirmation in chat.** The report of step 1 is shown in full; silence is
     not a confirmation.
  4. `git worktree unlock <path from the report>`
  5. `git worktree remove --force <path from the report>` — the path is taken from the report, not
     typed again: the command accepts a path, and a typo in it takes down someone else's tree.
  6. Check the outcome: `<path>` no longer exists and `git worktree list` does not show it, while
     `git rev-parse rehearsal/<label>` still gives the sha from step 1. The last point proves not
     that the right directory was deleted — the ref does not depend on which directory was
     removed — but that nobody repinned or moved the branch between the report and the deletion;
  7. `git branch -D rehearsal/<label>`.

- **The task's terminal commit.** A task that becomes `blocked` or is deleted names its rehearsal
  trees in that same commit and proposes the teardown of unharvested evidence — otherwise the tree
  is left without an owner.
