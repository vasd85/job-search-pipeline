# ADR 0001: Migrate the job-search pipeline to Claude Code

- **Status:** Accepted
- **Date:** 2026-06-17

## Context

The job-search pipeline lived as a Claude.ai Project: knowledge docs uploaded into the
Project context, procedures pasted as prompts, and memory held by the Project's auto-memory.
That setup made it hard to edit canon without re-uploading, gave no real version history or
diffs, and kept procedures as loose copy-paste prompts.

## Decision

Move the pipeline into a Claude Code repository, with **git as the source of truth**.

- **Direct file editing** — knowledge docs live in `knowledge/` and are edited in place, with
  no re-upload or context reload.
- **Sync through git** — history, diffs, and rollback instead of an opaque hosted Project.
- **File-based memory** — memory is a file (`memory.md`), versioned with everything else,
  not auto-memory.
- **Procedures as skills** — the prompts/playbooks become Claude Code skills
  (`.claude/skills/`), thin wrappers over the canonical docs, invocable as slash commands.
  Side-effecting skills (`generate-cv`, `score-jobs`) are gated to explicit runs
  (`disable-model-invocation`).

## Consequences

- (+) Canon is editable in place and reviewable via diffs.
- (+) One source of truth; reproducible and portable.
- (+) Procedures are discoverable and explicitly invocable.
- (-) Requires local tooling and discipline (git, Claude Code) instead of a hosted Project.
- (-) A separate revision pass is still needed to reconcile content drift this migration
  deliberately did not touch.

Supersedes the Claude.ai Project setup. Related: [../../knowledge/precedence.md](../../knowledge/precedence.md).
