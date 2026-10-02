# ADR 0026: Scoring values are candidate configuration

- **Status:** Accepted; decision 6 amended by
  [ADR 0027](0027-tool-prices-are-candidate-configuration.md) — the scorer input moves to version 6
  under `triage-policy-v5-2026-09-30`, and the ToolMatch prices join the configured values — and by
  [ADR 0028](0028-domain-fit-placement-is-candidate-configuration.md) — version 7 under
  `triage-policy-v6-2026-09-30`, and the Domain Fit placement joins them
- **Date:** 2026-09-27
- **Decision authority:** explicit user decisions of 2026-09-27, taken at the start gate of backlog
  task 194 of epic 146, under decision 7 of
  [ADR 0023](0023-public-engine-and-private-candidate-layer.md)
- **Supersedes:** ADR 0007 and ADR 0018 — as rules of the engine; each recorded one candidate's pay
  floors or relocation countries, and those are now values of that candidate's configuration.
  Neither is published, so they are named here without a link.
- **Amends:** [ADR 0021](0021-uncertainty-tolerant-triage-policy.md) — the scoring record's id moves
  to `triage-policy-v4-2026-09-27`; ADR 0019 — the set its relocation line reads is a configured
  one
- **Carried out by:** backlog task 194
- **Task numbers:** the task ids here name records of a backlog that is not published. They are
  history, not pointers.

## Amendment — 2026-10-01

Task 236 moves all component point settings into the private configuration. Personal numerical
examples are omitted from this public historical record. Its earlier version identifiers remain
historical; the current contract is [the scoring rubric](../../knowledge/job-match-rules.md#8-private-point-configuration).
Explicit configured unknown values replace derived middles; configured maxima, tables, bonuses
and limits replace the former engine constants. Historical batches are not rewritten.

## Context

The job scorer held one candidate's values as literals: the countries they can live and work in,
the destination they refuse, how desirable each relocation country is, and the pay floor and target
of each way they can be hired. The rubric printed the same values, and it named the candidate's
geography in its own vocabulary — a region, a timezone, engagement paths and a rate source named
after the candidate's countries. ADR 0025 moved the markets of the steps from a vacancy to its
materials into the configuration and left the scorer's geography to this record.

## Decision

1. **The values are configuration.** `mobility.*` and `compensation.*` keys of the candidate config
   carry the home region, the feasible residences, the self-relocation countries, the excluded
   destinations, the countries of each relocation tier, the tier of a WEST country and the WEST
   sub-region near the home timezone, each engagement path's floor, the target of the outside-home
   contractor path, and the home currency with the provider of its official rate. The rubric names
   the keys and prints none of the values. The policy stays in the engine: the tier scores, the
   middles, the below-floor curve, the reference bands of the markets that print gross pay, and the
   WEST region itself.
2. **The geography is named by role.** The scorer input and its trace say `HOME` for the home
   region, `tz_home` for a timezone range that includes the home timezone, and
   `outside_home_contractor`, `home_employment`, `home_contractor` and `comparable_cost_employment`
   for the engagement paths; the assumption tokens follow. No decision changes with the names.
3. **The values travel in the scorer input.** `/score-jobs` copies the values from the config into
   each input it scores, and the scorer refuses an input whose values differ from the ones the
   caller passes. Batch verification recomputes a trace from the input alone, so a config edited
   after a batch was recorded does not turn that batch red. The cost is trust: verification does
   not compare the recorded values with the configuration, so an input written with other values
   than the configuration held is recomputed as written.
4. **A WEST country is refused as a residence or a tier member.** Closing sign 3, the membership
   answer of the WEST region and the WEST tier all assume the candidate needs permission to work in
   every WEST country. The config therefore refuses a WEST country in the home region, the feasible
   residences, the self-relocation countries and every tier; a candidate for whom that premise is
   false is refused loudly rather than scored wrongly. An excluded destination may be a WEST country.
5. **The contractor curve is drawn by the floor and the target.** With floor `F` and target `T`, the
   curve interpolates from its start to its target score between `F` and `T`, then to its
   maximum between `T` and `2T - F`, and stays at its maximum above. The point anchors are now
   configured, as stated in the amendment above; the monetary boundaries are unchanged.
6. **One input shape is read.** The scorer input is version 5 under `triage-policy-v4-2026-09-27`;
   the readers of versions 1 to 4 are removed rather than kept. A batch recorded under an earlier
   record is reported as policy drift before its input is read, as it was after the previous
   amendment.

## Consequences

- (+) A public rule no longer describes where one person can live or what they are paid, and a
  second candidate gets the same scorer with their own values.
- (+) Editing a value changes the next batch and leaves recorded batches verifiable.
- (−) A checkout whose layer lacks the new keys cannot run a step, and a rollback past the first
  batch of version 5 needs the layer, the ledger and the batch store from one snapshot.
- (−) The steps that write a CV or a letter pin the whole config, so editing a scoring value makes
  their open work stale, as editing the profile did while the values lived there.
- (−) Inputs of the earlier versions cannot be read at all any more; which other superseded
  formats the engine keeps reading is an open question of its own.

## Amendment — 2026-10-01, task 237

The original decision above describes the historical category model. The current contract uses
config schema 3: independent `tool_match.languages` and `tool_match.frameworks` record arrays,
canonical name, integer points 0–5 and direct/transferable/none/unknown experience. Framework price
is independent of language. ToolMatch reserves 10 points in S; its two unknown halves score 2
each. Category subtotal limits, grouped prices, binding resolution and optional-modern bonus are
removed. Other private integer maxima still sum to 100 without normalization. Inputs use schema 9
and policy v8; historical batches retain their original settings and engine. Canonical mechanism
and upgrade procedure live in job-match-rules.md and tools/candidate/README.md.
