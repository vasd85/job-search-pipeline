# ADR 0014: A development backlog replaces the remediation queue

- **Status:** Accepted; amended by [ADR 0022](0022-three-lanes-derived-from-the-diff.md) — decision 3's single default lane and
  concept-based protected zone are replaced by three lanes and a literal glob list, and the
  Consequences sentence putting every task in its own worktree now holds for the standard and
  protected lanes only; superseded in part by
  [ADR 0024](0024-two-repositories-one-snapshot.md) — decision 1's home for the board moves to a
  private repository, decision 2's claim route moves with it and its "no remote and no push" is
  reversed, decision 3 falls together with ADR 0022, and the worktree topology of the
  Consequences is replaced in all three of its clauses; decision 4 stands; decision 5 is amended by
  backlog task 184 on 2026-09-23 — an accepted product decision is owned by the ADR that records
  it, and the register of product decisions leaves the registered owners
- **Date:** 2026-08-13
- **Decision authority:** explicit user decision, session of 2026-08-13

## Context

The remediation plan set — register, protocol, three card files and the append-only log, six
files totalling ~650 KB — was built for one bounded campaign: closing the fifty-seven findings
of the July 2026 audit with parallel agent sessions working on a fragile core. Its controls were
proportionate to that campaign: twenty-one exclusive locks, a nine-state task lifecycle, six to
eight plan-only commits on `main` per task, mandatory adversarial reviewer roles, and an
evidence log that grew to 451 KB.

Group 1 is fully integrated, including all six integration gates. The campaign succeeded, and
its machinery then outlived its purpose: the standing rule that every behavior-changing edit
must flow through the `R*` queue made the campaign register the only channel for *any*
development. New feature work had to be expressed as remediation rows, task status was split
across three places (the register queue, the card's own `Status:` line, and a move between
directories), and `knowledge/precedence.md` §1 named no owner for the concern "development tasks" at
all. The user judged the result bulky and confusing, and asked for a single, flexible, simple
way to track project development.

## Decision

1. **`docs/backlog/` is the single home of development tasks.** One file per task, named
   `<id>-<type>-<slug>.md`, with YAML frontmatter (`id`, `type`, `title`, `status`,
   `priority`, `created`, `source`, `depends`, optional `claim`) so agents can search the
   backlog mechanically. `docs/backlog/README.md` owns the format and lifecycle rules and may
   evolve without superseding this ADR.
2. **Status truth lives on `main`.** Claims are serialized through the user, who assigns tasks
   to sessions; a claim is a commit in the `main` worktree made before the task worktree is
   created, and the task file is read-only on task branches. There is no remote and no push;
   the old coordinator, lock table and assignment-index ceremony are retired.
3. **Ceremony scales with risk, derived from the diff.** The default lane is a task branch plus
   the full test suite and the runtime smoke checklist. A diff touching a protected zone
   (artifact validators, process lifecycle, `knowledge/` canon, `instructions/`, the proxy
   generator, `tests/` pins) follows the heavy checklist in the development gitflow runbook.
   The lane is decided by the touched paths, not by a self-assessed field.
4. **The remediation plan set is closed and archived.** Completed work keeps its evidence in
   the archived log; the closure record lists the fate of every audit finding — closed by an
   integrated task, carried forward as a backlog entry, or consciously deferred behind a named
   trigger — so audit traceability survives the archive. The four open user-decision gates
   (`R2-01G`, `R2-02G`, `R2-04G`, `R2-08C`) move to the product-decision register as open product
   questions. Remaining planned rows migrate to backlog entries per the user's triage of
   2026-08-13; group 3 stays behind its documented triggers, recorded in the closure record
   rather than in live backlog files.
5. **Ownership is registered.** `knowledge/precedence.md` §1 gains rows naming
   `docs/backlog/` as the owner of development-task tracking and the register of product
   decisions as the owner of product decisions. *Amended 2026-09-23 (task 184): an accepted
   product decision is owned by the ADR that records it; a question still under analysis governs
   nothing until it is decided.*

## Consequences

- The development gitflow runbook is rewritten in backlog terms: schedulable unit, claim
  verification, the heavy checklist, and the integration and operational-fingerprint
  procedures previously defined only in the remediation runbooks move into it or into their
  own permanent homes.
- Content pins in `tests/instruction-contracts.test.mjs` and
  `tests/operational-write-boundary.test.mjs` that read the plan set and runbooks by literal
  path are updated in the same change as each move.
- The worktree topology of the development gitflow runbook is unchanged: `main` remains the
  integration baseline, `ops/current` owns real vacancy runs, each task runs in its own
  branch and worktree.
- Memory notes that encoded the old lane ("behavior-changing code goes through the todo
  directory and the `R*` queue", the `INTEGRATION_MAIN` register lock, the Codex quota-handoff claim rule) are
  retired or rewritten against the backlog rules.
