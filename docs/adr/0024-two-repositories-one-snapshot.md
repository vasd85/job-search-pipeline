# ADR 0024: Two repositories, one snapshot

- **Status:** Accepted
- **Date:** 2026-09-23
- **Decision authority:** explicit user decisions, chat sessions of 2026-09-22, taken on the
  evidence of the separation report of backlog task 170 and the server measurements of task 171
- **Supersedes in part:** [ADR 0014](0014-development-backlog-replaces-remediation-queue.md) and
  [ADR 0022](0022-three-lanes-derived-from-the-diff.md) — the parts are named one by one below
- **Re-reads:** [ADR 0023](0023-public-engine-and-private-candidate-layer.md) decision 2, which
  stays Accepted and is read aloud here in the sense it now carries
- **Carried out by:** backlog tasks 173-182, and the export task 167 of epic 146
- **Task numbers:** the task ids below name records of a backlog that is not published — first
  this project's private predecessor, then the private board this record creates. They are
  history, not pointers.

The decisions were spoken in Russian and are quoted verbatim in the decisions sections of epic 146
and of the tasks that carry them. Those files stay private, so each decision is stated here in
full in English rather than by reference. Nothing below is an executor's choice: every numbered
decision is one the user made, and where a decision leaves something open this record says so
instead of closing it.

## Context

ADR 0023 decided *that* the engine is published and the candidate stays private. It deliberately
left the shape open: the private layer's form was a working hypothesis of epic 146, and how tasks
are documented after the move was handed to a separate task. Three requirements the user stated
afterwards could not be met by the flow this repository runs today.

The first is a server. The user wants every engine change to arrive through a pull request that a
green check gates, and wants to be able to read it before it lands. This repository has no remote
at all, and its development runbook states as a non-negotiable invariant that the absence of a
remote is not permission to push. Nothing here is enforced by anything outside the machine.

The second is a private board. Development tasks live in `docs/backlog/` inside the same tree as
the engine. Of the last 400 commits on `main`, 291 touch only task files — a claim line, a plan, a
review row, a status. In a public repository with a protected `main`, each of those is either its
own pull request or a push around the protection. A board in the published tree also publishes
every task the user ever filed.

The third is a rights matrix, in the user's own division: the operational side must be able to
save the artifacts of its own run and to file tasks, and must not be able to change public or
private files; the development side must be able to change the user's files and the tasks, and
must not be able to change the run's artifacts. Today one checkout holds both halves and the only
separation is a write-boundary hook that reasons about git topology.

Six architectures were designed and attacked in the separation report; all six were viable with
corrections, and they differed in what would have to be corrected. The user chose one and then
answered the report's questions about it. Task 171 measured, on two disposable repositories, the
four GitHub behaviours the server half depends on, because until then "a green check is
mandatory" was a belief rather than a mechanism.

## Decision

Twelve decisions. This record states what was decided and why; it describes no procedure, and for
each decision it names the task that carries the acting half.

1. **The scheme is two repositories and one snapshot.** The engine is a public repository on
   GitHub, cloned for development. One private repository holds the board, the candidate data,
   the research and the personal decision records; in a development clone it is nested as
   `candidate/`, which the engine ignores, so one session works in both with ordinary commits.
   The operational folder is not a working copy of anything: it is an export of two pinned tags —
   `release-<date>` of the engine and `candidate-<date>` of the private repository — beside the
   run's own state, with no `.git` anywhere in it. A marker file records both tags, the zone table
   and a digest of every file of the two read-only zones. — Acting halves: **task 173**, which
   builds the operational-folder tool, the marker file and the cutover; **task 175**, which
   creates the private repository and moves the board into it; **task 174**, which rebuilds the
   write guard on the marker file instead of git topology.

2. **Every engine change reaches public `main` through a pull request, and it is merged as a merge
   commit.** The user asked that all engine commits stay visible in the public history, which
   rules out squash; of the two merge modes that keep them, the merge commit was chosen. A merge
   commit keeps the pull request's commits under it with their own SHAs, so the ruleset cannot
   also require a linear history — the public ruleset therefore does not carry that rule.
   — Acting halves: **task 179**, the flow document that describes the pull-request route, and
   **task 180**, which applies the repository settings and the ruleset from a JSON file.

3. **That the user is the one who merges is a rule for the agent, not a mechanism.** The agent's
   last action on the engine is to open the pull request; it does not merge its own. Required
   approvals stay at zero and the user's reading stays a habit. The alternative — a separate agent
   account without administrator rights plus one mandatory approval — was put to the user and
   declined, because it turns the habit into a required click on every typo. — Acting halves:
   **tasks 179 and 180**.

4. **The copy of the private half that lives off this machine is a private GitHub repository.**
   Today the board and the layer exist in one copy on one disk, and a disk failure erases both.
   The application log, the finished letters and the CVs are not part of that repository and stay
   on the same disk until a separate decision; the old history is never sent anywhere. — Acting
   halves: **task 175**, which creates and fills the repository, and **task 181**, which resets
   what the daily backup covers.

5. **The candidate layer is pinned to a process, but only the files that really affect it.** A
   running process reads one version of the candidate data from its first step to its last, and a
   replacement of the snapshot refuses the next step until the brief is reissued. Changing rules
   that do not affect the pipeline — the development rules, for instance — must not demand that
   the pipeline's steps be rebuilt. — Acting halves: **task 178**, which extends the protected
   inputs to the whole snapshot and writes the layer's version into the process record, and
   **task 155**, whose constraints become pinned rather than live.

6. **The letter-corrections corpus is an artifact of the run.** It is written by the fifth
   pipeline step, so by origin it belongs to the run even though by content it is private: it
   lives beside the process log in the operational folder, it is in the backup, and it is
   versioned only by a copy taken into the private repository. This is what makes the rights
   matrix consistent — the operational side writes only its own artifacts. — Acting halves:
   **task 176**, which moves the corpus and builds the import, **task 181** for the backup, and
   **task 169**, whose operator check reads it.

7. **A run files a task as a draft with a deferred number, and a draft can be transferred without
   starting the task.** The operational folder has neither git nor the private repository, so it
   cannot write into the board; it writes a draft, and the next development session gives it a
   number and commits it. The user asked additionally that transferring a draft be a command of
   its own — filing a task must not mean starting it. — Acting half: **task 175**.

8. **The whole old backlog moves to the private board — open and closed alike — and the
   numbering continues.** — Acting half: **task 175**.

9. **Private files, tasks included, may be written in an alternative language named in the config,
   Russian among them; the section headings inside candidate files are English.** The engine knows
   one language by name, its default, which stays English by ADR 0023 decision 6; the alternative
   is configuration, not a rule. The headings are English because public documents point at
   sections of private ones. — Acting halves: **task 175** for the board and its README,
   **task 177** for the heading parity that keeps those pointers honest, and **task 157** for the
   language packs.

10. **The boundary around the operational side is a loud refusal, not a wall.** With one operating
    system user, no arrangement of git makes "must not be able to" absolute: a shell command and a
    second agent that does not run the hook both go around it. The wall would be a second macOS
    user with two logins; the user chose the loud, reversible refusal for now, and the layout
    keeps the wall available later without a redesign. — Acting half: **task 174**.

11. **The user cuts the release.** On the user's word the session sets both tags — the engine's
    and the layer's — and records them in the task; the operational folder can only take a pair of
    tags that exist. — Acting halves: **task 173**, whose cutover consumes the pair, and
    **task 179**, which states the rule.

12. **The order is: candidate data out of the rules first, by today's flow; then the new flow built
    beside the old one; then the export.** The alternative — rebuilding the flow first — would
    rewrite a document that another task is translating and leave the data extraction waiting. —
    Acting halves: the wave table of **epic 146**; **task 167**, the export and the move runbook;
    **task 182**, which deletes the old flow's tools and pins after the switch.

## How the rights matrix is held, cell by cell

The user's matrix has two actors and four kinds of thing. Each cell below names the mechanism that
holds it and, as the report's invariant demands, the path that mechanism does not close. In the
recommended layout the operational folder and the development clone are on the same disk of the
same machine, so the uncovered paths are named plainly rather than smoothed over.

| Actor and target | Mechanism | What it does not close |
| --- | --- | --- |
| run → its own artifacts | state zones, written by the folder's own session; the existing log locks | nothing — this is the permitted cell |
| run → engine sources | no `.git`, so nothing can be committed; the engine zone is read-only; the tool's drift check runs on every pipeline step | an edit through the shell, or by a second agent, before the first drift check |
| run → the board | only a draft in the outbox; the number is given by the next development session; rule 2 of the write guard keeps the run out of the live board | the shell and a second agent can write into the live board — it is on the same disk |
| run → candidate data | the snapshot's candidate zone is read-only and drift-checked on every step; rule 2 of the write guard covers the live nested clone | the shell and a second agent — into the snapshot before the first step, into the live clone at any time |
| development → the run's artifacts | rule 1 of the write guard; a development clone holds no process log | the shell; a second agent; the one declared exception of the outbox — deleting a draft already imported and recording its number |
| development → engine sources | permitted; into public `main` only through a pull request with a green check | nothing |
| development → the board | permitted, through the nested private clone, under the board's two rules | nothing |
| development → candidate data | permitted; a change reaches a run only through a tag and a cutover | nothing |

The mechanisms themselves are built by the tasks named in the decisions above: the marker file and
the zone table by task 173, the two guard rules by task 174, the outbox and the board rules by
task 175, the drift check on every step by tasks 173 and 178.

## What this supersedes in ADR 0014 and ADR 0022

**ADR 0014.** Decision 1 said `docs/backlog/` is the single home of development tasks. The home
moves: the board becomes `board/` inside the private repository. What survives is the rest of that
decision — one file per task, the filename shape, the frontmatter that makes the board greppable,
and a README that owns the format and may evolve without superseding an ADR. Decision 2 said
status truth lives on `main`, a claim is a commit made in the `main` worktree before the task
worktree is created, and there is no remote and no push. Status truth stays a commit, but on the
private repository's own `main`, and there is now both a remote and a push, with the board's two
rules — fast-forward pull before a claim, push straight after it, and an explicit pathspec per
session — in place of the old serialization. Decision 3, already amended by ADR 0022, is
superseded together with it below. Decisions 4 and 5 stand: the remediation plan set stays closed
and archived, and ownership stays registered — the registered row's path follows the board.

The Consequences of ADR 0014 stated a worktree topology: `main` the integration baseline,
`ops/current` the owner of real vacancy runs, each task in its own branch and worktree. All three
change. `main` becomes a read-only mirror of the public remote's `main`, which is written only by
merged pull requests; `ops/current` ceases to exist, because the operational folder is not a
worktree and not a repository; a task still gets its own branch and working copy, but the tool
that provisioned working copies on request, and the absolute paths a claim recorded for them, are
both removed.

**ADR 0022.** Decisions 1, 2 and 3 fall as a group. Ceremony is no longer three lanes derived from
the diff by a table of change classes and a protected zone of literal globs; it is two levels —
light for documents outside the instruction, canon, settings, schema, code and test areas, and
full for everything else — with exactly one pin freezing the list of paths that separates them, so
that a light change cannot reclassify itself. The runbook section that owned the gate definition
is replaced along with the runbook: the gate is the one aggregate command, and the server runs it.
The docs lane's sanctioned partial run disappears with the lane.

Decision 4 survives in substance and loses its name: the plan, the adversarial review of the plan
and the recorded start confirmation are what the full level runs; they are no longer described as
belonging to "the standard and protected lanes". Decision 5 falls: the cap of three full-diff
rounds goes, and with it the accounting of which cap a review pass spends a round in. Decision 6
survives except for its fingerprint predicate — operational fingerprints go away entirely, because
what they proved locally (that the integrated tree is the reviewed tree) is what the server now
proves by refusing anything whose check is not green. Decision 7 falls with the runbook: a reading
table keyed by lane cannot outlive the lanes.

Two consequences of ADR 0022 are worth naming as retired rather than merely changed. Its accepted
risk — that a docs-lane change writes into the shared `main` before any full run — disappears,
because there are no direct commits to `main` at all. And its closing argument, that literal pins
on the lane-selecting lists make a silent widening of the protected zone impossible, is kept in
form: one pin now freezes the list of paths that selects the ceremony level.

## How this re-reads ADR 0023

ADR 0023 stays Accepted; all seven of its decisions stand. Decision 2 is re-read aloud, because
the scheme changes what it was about.

Decision 2 said that tasks do not move to the new repository, that how tasks are documented after
the move is a separate question, and that open tasks of the old backlog are not migrated while the
ones still wanted are refiled in English, continuing the numbering. Read at the time, "the new
repository" meant the one repository the project was going to have. There are now two, and the
sentence is about the **public** one: tasks do not move to the public repository, and they never
will. To the private board they move in full, open and closed, by decision 8 above — and by
decision 9 they stay in the language the config names, not necessarily English. The numbering
continues either way, which is the one half of the old sentence that survives unchanged.

The acting half named by ADR 0023 decision 2 was task 161, which was to own the task flow of a
public repository. The user overturned its premise — that the task flow is local and does not
change at the move — at its start-confirmation gate, and the task was closed as obsolete. The
acting half moves to **task 175**, which builds the private board, and **task 179**, which writes
the flow.

## What this record does not decide

- **The license.** ADR 0023 decision 3 stands: it is a later decision of the user's, and until it
  is made, outside pull requests are not accepted.
- **How the direct-push path around the pull request is treated.** The measurements of task 171
  showed that a commit whose check already went green on a branch can be pushed straight into a
  protected `main`, and that GitHub then marks the pull request merged. Decision 3 above is the
  user's answer about who merges; whether to close this wider path by requiring a pull request in
  the ruleset — which would also close it for the user, and cost the local fast-forward route —
  is an open question of the measurement report, not answered here.
- **How the red server gate is fixed.** The aggregate command is not green on a stock GitHub
  runner: three of its tests require external programs the runner does not carry. Which of the
  three remedies to take is an open question of the measurement report.
- **The internal design of each mechanism.** The marker file's schema, the zone table, the two
  guard rules, the board import, the layer manifest and the protected-input extension are working
  hypotheses of the separation report. Each is confirmed or discarded inside the task that would
  rely on it, at its own start-confirmation gate. A hypothesis that is overturned does not reopen
  a decision above: the decisions constrain the outcome, not the design.
- **Which zone four files belong to** — the tag file of the CV builder, the formatter's ignore
  list, the conversation export and the rehearsal batch directory. The report left them to the
  gate of task 173 deliberately.
- **Whether a second operating-system user is ever adopted.** Decision 10 is the choice for now;
  the report records that moving to the wall later needs no redesign, and that remains a decision
  the user can take at any time.

## Consequences

- (+) "A green check is mandatory" stops being a belief. It was measured on a disposable
  repository that a ruleset with an empty bypass list binds the repository owner: a push without a
  passing check is refused by the server, naming the owner as the actor and the required check as
  the reason. This is the one requirement of the user's that the new scheme turns into a mechanism
  rather than a habit.
- (−) It is the only one. The measurement also showed the reverse case: a commit that already
  carries a green check lands in `main` by direct push, bypassing the pull request entirely, and
  the pull request is then marked merged. So "the user merges" and "the agent opens a pull
  request" are rules for the agent, exactly as decision 3 says — and the hole is wider than it
  looked when that decision was taken.
- (−) The gate does not run on a stock runner today. Three tests demand external document tools
  the runner does not have, and an export-exclusion count is red for reasons of its own. Until
  both are fixed, the export step that turns on the protection rules cannot complete, because it
  waits for a green check that cannot go green.
- (−) The price is the largest change this project has taken: by the report's own count twenty to
  twenty-five tasks, and up to forty if the correction it applies to every architect applies to
  its author too. That is two to three times what remains of epic 146, and most of it runs under
  the heavy ceremony of the predecessor flow during the transition.
- (+) A great deal is deleted rather than retargeted. Three lanes and the table that derived them,
  direct commits to `main`, the range-diff and fast-forward transfer proofs, operational
  fingerprints, the review round caps, the protected-zone globs as a trigger, roughly 105
  assertions guarding the text of the development runbook, the absolute paths in a claim, the
  task working-copy tool, the workspace reset tool, the topological write guard, the invariant that
  bans pushing while there is no remote, and the export exclusion list after the single export.
  What stays is the task format, red-before-green for defects, the one aggregate command, the
  loader contract and its fictional example, the corpus guard, the log locks and the daily backup.
- (−) The process prose loses its pins. Today about a hundred assertions hold the development
  runbook's text to its rules; the new flow document is guarded by a reader's eye on a pull
  request instead. This is a real loss of a property this project deliberately built.
- (−) Every engine change, including a typo, waits for the user to merge it. The user accepted
  that, and it is a delay in every flow.
- (−) A forgotten snapshot replacement stays quiet inside the scheme. A value changed in the
  private repository does not reach a run until the next cutover; only visibility cures it — the
  preflight prints the snapshot's version and age, and a cutover always replaces it.
- (−) The private repository has no server-side protection, no secret scanning and no push
  protection on the free plan. The board and the layer are guarded only by a local pre-push scan
  and by the rule never to skip it.
- (+) The nested private clone makes one session work with both repositories without any special
  arrangement, which was the user's own question about the scheme. The cost is that the clone is
  shared by every development session on the machine — the same competition the shared `main` has
  today, and the same cure: commit your own files by explicit pathspec.
