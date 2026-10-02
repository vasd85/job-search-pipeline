# ADR 0002: Files always outrank memory.md (precedence model 0a)

- **Status:** Accepted
- **Date:** 2026-06-17

## Context

`memory.md` is this project's file-based cross-session memory (chosen over Claude Code
auto-memory; see [0001-migrate-to-claude-code.md](0001-migrate-to-claude-code.md)). When memory
and a canonical file in `knowledge/` disagree, the precedence was undefined (DECISION 0a). Two
models were on the table:

- (a) Files always outrank `memory.md`.
- (b) Two-level: files outrank memory on canon, but a memory entry tagged "newer than file"
  outranks the file until promoted into a file.

The lived evidence is drift: the old Projects memory had already diverged from the files —
cover-letter length 220–280 in memory vs 230–260 in the playbook, a "home/outside-home" header the CV
playbook lacks, and a "euro payment preferred" claim the profile does not state. Removing that
drift is the reason Phase 2 exists.

## Decision

Adopt **model (a): files always outrank `memory.md`.** Memory is **additive only** —
preferences, working style, decisions log, open questions, and standalone facts not yet carried
by any file. Memory never competes with canon.

- A memory entry may not be tagged "newer than file" to override a file.
- A discrepancy with a file is recorded under **Open questions** (it flags, it does not govern)
  until the file itself is edited.
- A standalone fact worth keeping is written into its single carrier file first, then
  referenced — not duplicated — in memory.

## Consequences

- (+) One source of truth; no second authority path. The drift that motivated Phase 2 cannot
  recur through memory.
- (+) Simple, predictable rule with a clear owner (the file).
- (−) A mid-session correction cannot be made authoritative without editing the file. Acceptable
  in a git-backed repo where editing canon is cheap and is the correct, reviewable place for it;
  the Open-questions convention captures the correction in the meantime.
- Rejected (b): its only real benefit — deferring a file edit — is weak here, and it reintroduces
  exactly the second-source-of-truth drift this revision removes.

Encoded in [../../knowledge/precedence.md](../../knowledge/precedence.md) (Sections 1–2) and
[../../CLAUDE.md](../../CLAUDE.md). Related:
[0003-honesty-floor-inviolable.md](0003-honesty-floor-inviolable.md).
