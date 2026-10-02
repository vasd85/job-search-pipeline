# ADR 0028: Domain Fit placement is candidate configuration

- **Status:** Accepted
- **Date:** 2026-09-30
- **Decision authority:** explicit user decisions of 2026-09-30, taken at the start gates of backlog
  tasks 215 and 226 of epic 146, under decision 7 of
  [ADR 0023](0023-public-engine-and-private-candidate-layer.md)
- **Amends:** [ADR 0027](0027-tool-prices-are-candidate-configuration.md) decision 5 — the scorer
  input moves to version 7 and the scoring record's id to `triage-policy-v6-2026-09-30`;
  [ADR 0026](0026-scoring-values-are-candidate-configuration.md) and
  [ADR 0021](0021-uncertainty-tolerant-triage-policy.md) — the same id
- **Carried out by:** backlog task 226
- **Task numbers:** the task ids here name records of a backlog that is not published. They are
  history, not pointers.

## Amendment — 2026-10-01

Task 236 moves all component point settings into the private configuration. Personal numerical
examples are omitted from this public historical record. Its earlier version identifiers remain
historical; the current contract is [the scoring rubric](../../knowledge/job-match-rules.md#8-private-point-configuration).
Explicit configured unknown values replace derived middles; configured maxima, tables, bonuses
and limits replace the former engine constants. Historical batches are not rewritten.

## Context

The Domain Fit component of the scoring rubric scores the product domain of a vacancy on a bounded scale.
The rubric printed the scale as six lines, each a score followed by the domains it priced, and the
scorer held the same grouping as a table of categories. The scores were one candidate's preferences,
and so was the grouping: a category of several domains said they were worth the same to that
candidate, and another candidate could not tell them apart. The vocabulary a description is recorded
in came from the same lines.

## Decision

1. **The placement is configuration.** Each domain the scale names is a key of the candidate
   config, `domain_fit.<name>`, whose value puts it on one step of the scale. A config that leaves a
   domain unplaced, or places one the engine does not name, is refused.
2. **The domains are named one by one.** The scale's grouped lines are split into one name per
   item, each keeping the item's own words; a group's name is retired with its group. The names are
   printed in alphabetical order and without a score.
3. **The scale originally stayed with the engine.** The historical record fixed the steps and
   read the D middle off them. The amendment above supersedes this ownership: the steps, maximum
   and unknown value are now explicit private settings. `irrelevant` - not a QA/Testing domain, or a "quality" role not
   about software - scores 0 and `unclear` scores the middle for every candidate.
4. **The vocabulary is left open.** The names are the previous scale's items, not a design: which
   domains the engine names, whether industry, product type and business model are one axis or
   several, and what the catch-all `other_complex` covers are a question of their own, left open
   here.
5. **One input shape is read.** The scorer input is version 7 under `triage-policy-v6-2026-09-30`
   and carries the placement with the rest of the scoring values. Version 6 is refused: recomputing
   it needs the domain scores the engine no longer carries. A batch recorded under an earlier record
   is reported as policy drift before its input is read.

## Consequences

- (+) The public rubric no longer states one person's domain preferences, and a second candidate
  places the same domains from their own profile.
- (+) The scores move unchanged: every domain keeps the score its group had in the configuration of
  the candidate whose preferences the scale carried.
- (−) Recording a domain is now a choice among fourteen names instead of five groups, and a
  description on the border of two groups may be recorded under a name the previous grouping scored
  a step apart. That reading belongs to the extractor, and nothing measures it here.
- (−) A checkout whose layer lacks the new keys cannot run a step, and the steps that write a CV or a
  letter pin the whole config, so adding the keys makes their open work stale.
- (−) Batches recorded under version 6 are no longer recomputed.
- (−) The placement is a reading of the profile by whoever edits the layer; nothing checks one
  against the other.
