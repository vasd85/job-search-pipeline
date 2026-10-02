# ADR 0009: Runtime-neutral instructions and searchable process ledger

- **Status:** Accepted
- **Date:** 2026-07-20

## Context

The repository had full, separately edited copies of its operating contract and six pipeline skills
for Claude Code and Codex. Small runtime substitutions had already changed candidate-facing canon:
the Codex copy replaced the protected `"Claude Code"` naming policy instead of merely selecting a
runner. At the same time, output directories recorded only successful runs, so failed or abandoned
`get-vacancy` starts were difficult to discover and company naming variants had no stable home.

The immediate product need is a small local experiment: enter a company spelling or website and see
whether the pipeline ran and for which role, without introducing a database or frontend framework.

## Decision

1. Keep the runtime-neutral operating contract and full skill procedures under `instructions/`.
   `CLAUDE.md`, `AGENTS.md`, `.claude/skills/`, and `.agents/skills/` are generated loaders only.
   A manifest owns shared discovery metadata and narrow runtime overrides. The generator updates
   known proxies, checks drift, and never deletes unknown runtime-specific skills.
2. Use `process-log.json` schema v2 as a Git-backed operational ledger. `companies` are search
   identity clusters — display name, observed terms, and verified first-party domains — not legal
   entities. Each process preserves observed/hinted company text and may remain unlinked when the
   company is unknown or ambiguous.
3. Record a process before the first vacancy request. Exact `source_key` duplicates keep the
   `prompt` policy. Failed fetches remain visible as `fetch_failed`; output creation links a unique
   repo-relative run directory to the same process. Every mutation holds a retrying lock across the
   full read-check-write transaction and replaces the JSON atomically, allowing parallel local
   sessions without lost updates.
4. Provide a dependency-free local Node.js server and vanilla web UI. The server binds to
   `127.0.0.1`, is read-only, rereads the JSON for each API request, and serves only the dedicated
   static directory.

This ADR supersedes only the Claude-Code-specific procedure-location decision in ADR 0001. ADR 0001's
repository migration, Git source-of-truth decision, and historical record remain valid.

## Consequences

- (+) Claude Code and Codex execute one procedure while retaining their native discovery format and
  runner identity.
- (+) Started, failed, completed, aliased, and domain-matched processes are visible in one place.
- (+) The MVP has no service dependency, build step, database, authentication, or hosting burden.
- (+) Proxy drift and migration invariants are testable in CI or locally.
- (-) Company clusters and aliases require gradual curation through the CLI.
- (+) Multiple local sessions can safely start and advance different vacancies concurrently.
- (+) A lock abandoned by a terminated local writer is recovered by checking its recorded PID;
  a live writer's lock is never removed automatically.
- (-) Coordination is local-filesystem only; shared multi-host writers are unsupported.
- (-) Fuzzy matching, transliteration, legal-entity modeling, cluster merging, and web editing are
  deliberately deferred.
