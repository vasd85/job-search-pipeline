# ADR 0027: ToolMatch prices are candidate configuration

- **Status:** Accepted; decision 5 amended by
  [ADR 0028](0028-domain-fit-placement-is-candidate-configuration.md) — the scorer input moves to
  version 7 under `triage-policy-v6-2026-09-30`, and version 6 is refused in turn
- **Date:** 2026-09-30
- **Decision authority:** explicit user decisions of 2026-09-30, taken before the claim and at the
  start gate of backlog task 215 of epic 146, under decision 7 of
  [ADR 0023](0023-public-engine-and-private-candidate-layer.md)
- **Amends:** [ADR 0026](0026-scoring-values-are-candidate-configuration.md) — the scorer input
  moves to version 6 and the scoring record's id to `triage-policy-v5-2026-09-30`;
  [ADR 0021](0021-uncertainty-tolerant-triage-policy.md) — the same id
- **Carried out by:** backlog task 215
- **Task numbers:** the task ids here name records of a backlog that is not published. They are
  history, not pointers.

## Amendment — 2026-10-01

Task 236 moves all component point settings into the private configuration. Personal numerical
examples are omitted from this public historical record. Its earlier version identifiers remain
historical; the current contract is [the scoring rubric](../../knowledge/job-match-rules.md#8-private-point-configuration).
Explicit configured unknown values replace derived middles; configured maxima, tables, bonuses
and limits replace the former engine constants. Historical batches are not rewritten.

## Context

The ToolMatch component of the scoring rubric prices each tool a vacancy names by how close it is to
the candidate's stack. The rubric printed those prices in its category table, the scorer held them
as literals, and the prose beside the table justified them with one candidate's languages, skills
and gaps. The prices were a projection of that candidate's profile: for any other candidate they
were wrong, the project's own fictional example included. The bonus for an optional modern tool had
the same dependency in another form — its closed set was kept free of the candidate's skills by
choosing its members.

## Decision

1. **The prices are configuration.** Three lists of the candidate config,
   originally named after their point values, name members at three price levels; a member no
   list names is worth 0. The amendment replaces numeric names with `tool_match.preferred`,
   `tool_match.adjacent` and `tool_match.base`, with explicit `tool_match.prices` values. A list
   spells a member exactly as the table does, and a web UI framework with its binding. Only web UI
   frameworks may use the two higher price groups.
2. **The structure stays with the engine.** The categories, their members, the bindings a framework
   is priced in, the subtotal bounds, the middle and the bonus are the engine's policy. How the
   table is partitioned is a question of its own, left open here.
3. **The rubric keeps the mechanism.** The ladder that places a member and a price rule that maps
   the language level the profile gives a binding to one of three price groups say how the lists are written; the
   rule reproduces the table it replaces.
4. **The bonus reads what the candidate knows.** `tool_match.known_modern` lists the members of the
   modern-signal set the candidate's profile names; such a member earns no bonus. The set itself
   stays the engine's knowledge of the market.
5. **One input shape is read.** The scorer input is version 6 under `triage-policy-v5-2026-09-30`
   and carries the lists with the rest of the scoring values. Version 5 is refused: recomputing it
   needs the prices the engine no longer carries. A batch recorded under an earlier record is
   reported as policy drift before its input is read.

## Consequences

- (+) The public rubric no longer describes one person's stack, and a second candidate prices the
  same table from their own profile.
- (+) No decision changes for the candidate whose prices the table carried: their lists hold exactly
  those prices.
- (−) A checkout whose layer lacks the new keys cannot run a step, and the steps that write a CV or a
  letter pin the whole config, so adding the keys makes their open work stale.
- (−) Batches recorded under version 5 are no longer recomputed.
- (−) Writing the lists is a reading of the profile by whoever edits the layer; nothing checks the
  lists against the profile.

## Amendment — 2026-10-01, task 237

The original decision above describes the historical category model. The current contract uses
config schema 3: independent `tool_match.languages` and `tool_match.frameworks` record arrays,
canonical name, integer points 0–5 and direct/transferable/none/unknown experience. Framework price
is independent of language. ToolMatch reserves 10 points in S; its two unknown halves score 2
each. Category subtotal limits, grouped prices, binding resolution and optional-modern bonus are
removed. Other private integer maxima still sum to 100 without normalization. Inputs use schema 9
and policy v8; historical batches retain their original settings and engine. Canonical mechanism
and upgrade procedure live in job-match-rules.md and tools/candidate/README.md.
