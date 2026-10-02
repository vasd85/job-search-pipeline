# ADR 0022: Ceremony is three lanes derived from the diff, not two

- **Status:** Accepted; superseded in part by
  [ADR 0024](0024-two-repositories-one-snapshot.md) — decisions 1, 2, 3, 5 and 7 fall with the
  lanes and the runbook that owned them, decision 6 loses its fingerprint predicate, and
  decision 4 survives unnamed as what the full ceremony level runs
- **Date:** 2026-08-29
- **Decision authority:** explicit user decision, session of 2026-08-28, on the evidence of an
  audit of the project's development flow; three further decisions taken 2026-08-29 after the
  plan review of backlog task 63
- **Amends:** [ADR 0014](0014-development-backlog-replaces-remediation-queue.md) — decision 3 and
  the worktree sentence of its Consequences
- **Task numbers:** the task ids below name records of this project's private predecessor backlog,
  which is not published. They are history, not pointers.

## Context

ADR 0014 set ceremony to scale with risk and derived the lane from the touched paths rather than
from a self-assessed field. That principle held. Its granularity did not: two lanes, and a
protected zone written as concepts, put ~25 of the 31 tasks closed by then on the
heavy path. Task 034 — a profile diff of exactly two inserted tokens — ran three independent
review passes, four aggregate gates, fingerprints before and after, and an 87-line report.

Three further facts made the imbalance structural rather than incidental. Every task session paid
the same ~107 KB entry ticket before its first edit, because the reading list said "in full" with
no lane distinction. The `D0`–`D3` classification that would have sized the work already existed,
but applied only to someone else's drift in `main`, never to the task's own diff. And the concept
"`tests/` pins" was read widely enough that any task adding a test file became heavy — a process
that charged more for writing tests.

The cost was not only ceremony. When the only legal route is expensive, work leaks off it: at the
time of the audit two research documents had sat uncommitted in `main` for a week, in a repository
whose first principle is that Git is the source of truth.

## Decision

1. **Three lanes — docs, standard and protected — derived mechanically from the task's
   own diff**, by the same `D0`–`D3` table that classifies integration drift, plus membership in
   the protected zone. Derived twice: forecast in the claim block's `lane` field, re-derived by the
   executor at the gate. Ambiguity escalates upward; lowering a derived lane needs a new user
   decision. ADR 0014's rule — the lane is decided by the touched paths, not by a self-assessed
   field — is preserved verbatim and is what makes the field safe.
2. **The protected zone is a list of literal path globs**, owned by `docs/backlog/README.md`,
   extended with the write-boundary hook and settings, the former workspace reset tool and
   `tools/vacancy-fetch/`. "`tests/` pins" becomes a named list of the suites that assert the
   literal content of a governed document; adding a new test file for non-core code stays the
   standard lane.
   Both lists are frozen as literals in `tests/instruction-contracts.test.mjs`, so the rules that
   select lanes cannot be relaxed by the lightest lane.
3. **Runbook section 9 is the single owner of the gate definition.** The backlog README names no
   gate command, and the root `README.md` owns only what `npm run ci` contains. The docs lane is the
   one
   sanctioned partial run: the `format` stage alone, plus the pin tests its document reaches.
4. **Architecture before code in the standard and protected lanes**: the executor's own analysis, a `## Plan` section
   committed to `main`, an adversarial review of that plan, and then a start-confirmation gate —
   the approach described to the user in business language, and their explicit go-ahead recorded in
   Git — before implementation begins.
5. **The review loop is capped at three full-diff rounds under a harder invariant**: no unreviewed
   fix ever integrates. Fix-hunk delta checks are not rounds and are not capped; exit is possible
   only from a check that found nothing blocking; continued oscillation stops and hands the user
   the open items by name.
6. **Steps carry applicability predicates.** RED→GREEN moves down to `type: bug` in the standard
   and protected lanes;
   fixtures items become conditional on versioned-schema globs; smoke fires on the smoke
   checklist's own header globs; fingerprints fire on write-boundary globs, a `rehearsal` key, or a
   task running code able to write outside its own directory. That third trigger exists because
   runbook section 7 names the fingerprint record the only detector of a stray write where no
   sandbox executes, and the other two ask whether a task edits the boundary rather than whether it
   can cross it.
7. **The reading list becomes a table of packages by session type and lane**, and the preflight
   report names the lane and the packages it loaded, so on-demand reading is checkable.

## What this amends in ADR 0014

Decision 3 of ADR 0014 stated one default lane, and enumerated the protected zone as concepts.
Both are replaced by decisions 1–3 above. Its Consequences said each task runs in its own branch
and worktree; that is now true of the standard and protected lanes only — the docs lane commits
into `main`, which is an
extension of the already gate-free `D0` channel. Everything else in ADR 0014 stands: the backlog
as the single home of development tasks, status truth on `main`, the closure of the remediation
plan set, and the ownership rows in `knowledge/precedence.md`.

## Consequences

- A docs-only task costs a gate measured in seconds — 0.2 s for the format stage, 0.4 s for the
  mandatory pin floor, and about 6 s more when the edited document also reaches
  the former boundary suite, which the runbook itself does — instead of a
  2 min 09 s aggregate run, and it lands without a worktree. Accepted risk: it writes into the shared `main` before any full run. The
  compensations are entry by `D0`/`D1` globs with upward escalation, a mandatory focused pin run
  whose floor is `tests/instruction-contracts.test.mjs`, and the `fresh-archive` stage of the next
  aggregate run, which re-proves the committed tree independently.
- Every standard and protected task now has a point where it waits for the user. That is the
  user's deliberate
  trade: the cost of waiting is lower than the cost of rebuilding a wrong approach.
- Reading drops by 37% in the docs lane and 21% in the standard lane against the 107 KB baseline,
  and not at all in the protected lane — 2% — whose gain here is the applicability predicates, the
  review cap and the plan step
  rather than bytes. The unevenness is stated in the table rather than smoothed: this change grew
  the runbook from 83 to 125 KB, because the lanes, the escalation, the gate order and the review cap had to be
  written somewhere. Two later tasks move those numbers and the table says which: 067, which takes
  sections 7 and 8 out of the heavy package, and 070, which splits the operating contract. The
  three other extractions shorten the file without changing any reading package.
- Literal pins on the two lane-selecting lists mean a task that widens or narrows the protected
  zone, or moves a row of the classification table, is itself a protected-lane task. Deliberate
  change
  stays possible; silent change does not.
