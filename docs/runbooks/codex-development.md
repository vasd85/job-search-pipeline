# Codex development environment

Use this checklist for a Codex development chat. Before the switch, the authority is
`docs/runbooks/development-gitflow.md`; from the switch, it is
[development-flow.md](development-flow.md). Derive the lane or level there, and load its reading
package. This checklist supplies the Codex entry point and permission handling, not another gate.

## Start and resume

1. Open the existing integration checkout as a **Local** project. Read `AGENTS.md`, the operating
   contract in full, and the assigned task. Check its dependencies before claiming with
   `runner: codex`. On resume, use the existing claim and working copy.
2. Before the switch, claim on `main` and run its preflight. Lane D stays there. Lanes C/T record
   and review the plan, obtain and record start confirmation, then create the claimed tree from
   `main` with `npm run task:worktree -- --task <id>`. This command also copies and checks
   cv-builder dependencies. Run the records import at the point the gitflow runbook prescribes.
3. For a task with a working copy, open its prepared directory as a **Local** project, run the
   task preflight and check both branch and absolute path against the claim. Lane D stays in
   `main` and uses its main preflight; after the switch, private-only tasks follow development-flow
   [The private half of a task](development-flow.md#69-the-private-half-of-a-task) without a task directory. Report the derived lane or level and loaded packages.
   Do not use the app's automatic Worktree or Handoff actions for this procedure: the repository
   chooses the working copy's path and branch.
4. Check `node --version`, `npm --version` against `package.json`, and `git --version`. Follow the
   governing flow's dependency commands; do not run operational `npm run preflight` or initialize
   a process log in a development directory.
5. Run the governing flow's focused checks and gate, requesting command approval where needed
   below. Perform independent review when that flow requires it. Complete the task through that
   flow; remove only your own working copy, after its commits and result are preserved.

From the switch, claim and all task records move to the private board. Follow development-flow
[The board](development-flow.md#4-the-board) — [A task, step by step](development-flow.md#6-a-task-step-by-step) for imports, the private repository, the light/full level, working-copy creation from
`origin/main`, and dependency installation. The old `task:worktree` command and lanes no longer
define the procedure. Finish the engine half by opening the PR; the user merges it. Recheck access
to the private clone and GitHub before relying on this route on a new machine or after the switch.

## Permissions

Keep the chat in `workspace-write` with approvals available. Inspect the session's actual writable
roots and resolve `git rev-parse --path-format=absolute --git-common-dir`; do not infer access from
`.claude/settings.json`. The [OpenAI sandbox documentation](https://learn.chatgpt.com/docs/sandboxing)
describes the boundary and its separate approval control.

| Operation | How to run it when the sandbox refuses it |
| --- | --- |
| `git add`, commit, branch, rebase, merge, worktree metadata | Request `require_escalated` for the exact command; inspect the common Git directory and intended refs first. |
| Create or remove a sibling task directory | Request `require_escalated` for the task's exact path, using the governing flow's command. |
| Full `npm run ci` with loopback/browser tests | Run it as a separate command with `require_escalated` when loopback access is refused. |
| Private-board writes and network calls after the switch | Request approval for the exact required operation; a refused pull or push follows the flow's stop rule. |

An approval is permission for that command, not a persistent expansion of writable roots. After a
failed worktree creation or removal, inspect `git worktree list --porcelain`, the task branch and
the exact directory before retrying: a failed creation can leave a branch, and a failed removal
can drop registration while leaving the directory. Preserve uncommitted and ignored work before
recovering only your own partial operation; if registration is gone, verify the directory's `.git`
marker against the expected common directory before cleaning that exact path. Do not solve an
access refusal by opening the common projects
parent, making the operational tree writable, or selecting Full access for the whole chat.

If automatic approval review rejects an operation, report the command and stated reason; do not
claim that changing the shell's working directory changed the chat's sandbox. Ask the user only
when the exact required operation cannot proceed through the available approval route.

## Independent review

When a flow calls for a reviewer, spawn a fresh Codex subagent with `fork_turns: none`. Give it the
absolute checkout, the exact plan or diff surface and sha, the task's acceptance criteria, and the
governing review charter. Tell it to use read-only commands, make no edits, and return findings
with locations and a verdict to the parent chat. Verify each finding and record the pass as the
flow requires; use a separate skeptic where it requires finding verification.

The subagent has a separate conversation context but shares the filesystem and available tools.
The read-only assignment is a behavioural rule, not a mechanically read-only permission profile.
Check the review surface and `git status` before and after review. If subagents are unavailable,
stop at a required independent-review step and report the missing capability.

## Operational readiness at the switch

Development review does not replace the operational `letter-reader` and `telegram-reader`
procedures. Their Codex support and opening the operational folder without `.git` belong to task
232; rehearsal isolation belongs to task 44. Full pipeline validation after the switch belongs to
task 233. Until the operational checks and required canonical changes are complete, follow the
operational runbook's capability stops. Task 216 owns the separate terminal CLI checks after the
switch. Before switching, record the chosen operational runtime and any unverified capabilities
in the switch evidence; development CI alone does not establish production readiness.
