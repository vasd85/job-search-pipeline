# Codex development environment

Use this checklist for a Codex development chat. The authority is
[development-flow.md](development-flow.md); derive the light/full level and load its reading
package there. This checklist supplies the Codex entry point and permission handling.

## Start and resume

1. Open the engine clone as a **Local** project. Read `AGENTS.md`, the operating contract in full,
   and the assigned task. Check dependencies before claiming with `runner: codex`; on resume use
   the existing claim and working copy.
2. Follow the flow's [board](development-flow.md#4-the-board) and
   [task procedure](development-flow.md#6-a-task-step-by-step): run preflight and imports, write
   the claim, and at full level review the plan and obtain start confirmation before creating the
   working copy from `origin/main` and installing dependencies.
3. Open the prepared working copy as a **Local** project. Check absolute path and branch against
   the claim. Private-only tasks follow
   [the private half](development-flow.md#69-the-private-half-of-a-task) without a task directory.
   Do not use the app's automatic Worktree or Handoff actions: the repository chooses the path
   and branch.
4. Check Node, npm and git versions and follow the flow's dependency commands. Do not run
   operational `npm run preflight` or initialize a process log in a development directory.
5. Run focused checks and the required gate; finish the engine half by opening the PR. The user
   merges it. Remove only your own working copy after merge and preservation of the result.

Recheck access to the private clone and GitHub on a new machine.

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
| Private-board writes and network calls | Request approval for the exact required operation; a refused pull or push follows the flow's stop rule. |

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

## Operational readiness

Development review does not replace the operational `letter-reader` and `telegram-reader`
procedures. Their Codex support and opening the operational folder without `.git` belong to task
232; rehearsal isolation belongs to task 44. Full pipeline validation belongs to
task 233. Until the operational checks and required canonical changes are complete, follow the
operational runbook's capability stops. Task 216 owns the separate terminal CLI checks. Before cutover, record the chosen operational runtime and any unverified capabilities
in the switch evidence; development CI alone does not establish production readiness.
