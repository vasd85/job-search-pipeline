# ADR 0021: Triage tolerates uncertainty — absent data scores a defined middle instead of ending the vacancy

- **Status:** Accepted; implemented in `tools/job-scorer/` by backlog task 26 on 2026-08-22, which
  removed the interim paragraphs §2.2 and §3.3 carried and moved produced traces onto
  `policy_id: triage-policy-v2-2026-08-21`. The two residuals below stay open and stay owned by
  backlog task 38. Decision 8's review veto — and, with it, the consequence that the ledger review
  reaches a wholly uninformative vacancy — is withdrawn by backlog task 57 on 2026-09-02: an
  applied default is class C of the rubric's annotation classes, is not a ledger flag and is not
  presented at review; a gap the source was silent on is class A, counted and not asked. The
  compensation basis rule under «Compensation normalization» is amended by backlog task 58 on
  2026-09-02, and the record's id moves with it to `triage-policy-v3-2026-09-02`: a figure whose
  gross/net basis the listing does not state is read as gross where the posting is placed in the US,
  the UK or Canada and the floor it meets is a gross one. The reason is the market base rate —
  those boards print gross pay, and without the reading a published pay range scored exactly what
  silence scored, which is what batch `2026-08-26-linkedin-1-15` measured. The reading is class C,
  tax is still never inferred and gross is still never converted to net. The cost, accepted with the
  rule: a posting in one of those three markets that means net is over-scored. Those three are also
  the markets §3.2 C carries reference bands for, which is a coincidence of fact and not a rule: a
  fourth market joins the reading by name, never by acquiring a band. The record's id moves on to
  `triage-policy-v4-2026-09-27` by ADR 0026 on 2026-09-27, which moves the candidate's values into
  the candidate configuration and names the record's geography by role; no decision of this record
  changes. It moves on again to `triage-policy-v5-2026-09-30` by ADR 0027 on 2026-09-30, which moves
  the ToolMatch prices there too, with the same result,
  and to `triage-policy-v6-2026-09-30` by ADR 0028 on the same day, which moves where each product
  domain sits on the Domain Fit scale there as well: the scores move unchanged, and the domain a
  listing is recorded under stays the extractor's reading.
- **Date:** 2026-08-21
- **Decision authority:** explicit user decisions, sessions of 2026-08-18 and 2026-08-21
- **Amends:** private predecessor ADR 0007 — its decision text mandates a rubric skip
  below the floor, and this record removes that skip; the floors themselves are untouched.
  Discharges the rubric mandate private predecessor ADR 0018
  decision 6 reserved for backlog task 24.
- **Task numbers:** the task ids below name records of this project's private predecessor backlog,
  which is not published. They are history, not pointers.

## Amendment — 2026-10-01

Task 236 moves all component point settings into the private configuration. Personal numerical
examples are omitted from this public historical record. Its earlier version identifiers remain
historical; the current contract is [the scoring rubric](../../knowledge/job-match-rules.md#8-private-point-configuration).
Explicit configured unknown values replace derived middles; configured maxima, tables, bonuses
and limits replace the former engine constants. Historical batches are not rewritten.

## Context

The verified `/score-jobs` run of 2026-08-18 (links 1-10) returned 0 EVALUATED, 7 MANUAL_REVIEW and
3 SKIP. Six of the seven review outcomes were decided by the policy rather than by the listings —
five `relocation_floor_missing` on non-WEST relocation roles and one engagement path the policy
refused to default, the count the implementing task 26 tracks as «the five predetermined
`relocation_floor_missing` MRs» plus that sixth: a non-WEST relocation role was unresolvable by *any* answer the user could give — without
a numeric override the scorer demanded a relocation floor, with one it found no reference curve
outside US/UK/Canada — and a remote WEST posting silent on its hiring model landed in
`engagement_path_unknown` whether or not it published a salary. Only one of the ten was a genuine
absence of data.

That is the shape of the defect: the triage did not fail to *know* things, it failed to *decide*
under partial knowledge, and it spent the user's attention on questions no answer could close.
Underneath sat a second class of the same error — a below-floor salary ended the vacancy outright,
and an unlisted relocation country ended it too, although the profile is open to relocating
anywhere except the configured market.

The user stated the governing principle on 2026-08-18 and approved the resulting record point by
point on 2026-08-21.

## Decision

1. **Absent information never produces a terminal state.** Not `SKIP`, and not a dead-end
   `MANUAL_REVIEW` either. Where the source does not carry what a component needs, the component
   takes a **defined middle value** and the trace records what was missing and what was supplied.
   The middle of a component is the midpoint of its numeric range snapped to the nearest value its
   own scale defines, ties resolving downward — a rule chosen because it reproduces both middles the
   rubric already carried instead of inventing a third convention. This historical midpoint rule
   is superseded by the explicit unknown settings in the amendment above.
2. **`MANUAL_REVIEW` survives for contradiction only** — source data that is present and
   irreconcilable, or an operator batch override that cannot be normalized. Three reasons remain of
   the twenty distinct reasons `tools/job-scorer/decide.mjs` can put in `review_reason` today —
   eighteen distinct strings across its literal `manual("…")` calls, plus the two the ternary at
   `decide.mjs:143` supplies, which a grep for the literal form misses. Counting call sites gives 26
   literal ones plus that ternary, because several reasons are raised from more than one branch. `BLOCKED` is untouched: a technical failure to obtain the description is not missing
   information, because there is no source text for anything to be missing from.
3. **`SKIP: compensation_too_low` is removed.** A below-floor salary is a low score on a stepped curve
   by distance below the floor, and the vacancy stays ranked. This is the amendment to ADR 0007: the
   floors it set, all personal numerical values included, are unchanged and stay owned by
   profile §4, and the band boundaries it set are unchanged where they actually live, in
   `job-match-rules.md` §3.2. Only the skip that ADR 0007's decision text mandated is retired.
4. **Relocation is any country except the configured market, and the country table is total.** A named destination
   outside the closed RelocationCountryScore list takes the table's middle tier with a gap
   annotation. A destination the listing never names takes the tier of its region when every country
   in that region shares one, and the middle tier otherwise, with the same
   annotation either way, so no relocation listing ends in a review state for want of a country. Both are the relocation lane's own middle rather than the M
   middle: the lane has its own scale, and a listing that says "On-site" has entered it, having
   foreclosed the `Remote` path the selection order would otherwise prefer. A WEST tier joins
   the table, because decision 5 now lets a WEST relocation listing through whenever an opening sign
   is observed, and the superseded record had no M value for one. The excluded market, the one destination profile §1/§3 excludes, becomes an explicit
   `SKIP: destination_excluded` rather than a cheap score: an exclusion the candidate stated is a
   fact, not a gap, and a score of 0 would leave the vacancy ranked as if it were under
   consideration. The rule keys on the requirement rather than the work format — a remote role that
   demands residence in the configured market asks for the same move an on-site one does, and rule 3's contractor
   escape would otherwise let it through — while a remote role merely offered by a company in the excluded market
   demands no move and is scored normally.
5. **Hard-SKIP rule 2 is rewritten as one closing sign against one opening sign.** The superseded
   rule required four explicit refusals simultaneously, which no listing writes; it never fired, and
   WEST on-site roles died in manual review instead. `contractorEligibility` leaves the branch
   entirely — contractor status does not create a right of entry, and an on-site role has to be
   attended in person, so requiring it for the skip while never letting it prevent one was an
   inconsistency rather than a policy. Closing signs 1 and 2 read the destination first and close
   nothing inside the feasible-residence set: a role in a configured feasible-residence market demanding a work permit or refusing visa
   sponsorship excludes no authorization the candidate already holds. That
   restores a qualifier the superseded text carried — "authorization that the candidate does not
   have" — and the first draft of this record lost. Against the five normalized facts a scorer can
   read, the new rule is a superset of the old. One class moves the other way, and it is named here
   rather than left to be found: the superseded prose also skipped where relocation support excluded
   immigration help, a distinction the `relocationSupport` enum never carried and the scorer never
   implemented, so a listing that pays for the move without mentioning visas now opens the door
   instead of closing it. That class is exactly what the WEST tier of decision 4 exists to score.
6. **One deliberate exception to decision 1, recorded as one.** For a WEST Hybrid/On-site path,
   silence about visa and work authorization is read as refusal. The ground is the market base rate:
   sponsorship needs infrastructure a company either has or does not — a UK sponsor licence, the
   annual US lottery — and a company that has it says so; senior QA automation is not a specialty an
   exception gets made for. The exception is scoped exactly to WEST. Where an employer-arranged work
   visa is the only ordinary way for a foreign engineer to be employed — the Gulf states, Singapore,
   and the other non-WEST members of the high tier — silence carries no information, because there is
   nothing unusual for a company to announce. The rule is written over the two normalized facts,
   both `unknown`, and not over the raw text, so that a non-committal sentence about visas cannot buy
   an escape that a real commitment has to be paid for.
7. **RU/BY becomes a region category of its own**, beside WEST, OTHER and UNKNOWN. It already
   carries its own engagement paths and its own compensation floors, and the engagement-path
   defaults cannot be derived without it. "The CIS" was refused as a category for the same reason
   ADR 0018 refused it for the self-relocation set: an enumeration stays checkable, a class label
   does not.
8. **Engagement path is defaulted, never left unknown**, when the listing is silent on the hiring
   model. The table keys on the pair (format class, configured home region) and is total over both:
   Remote, or a format that did not resolve at all including literal `Unknown`, outside the home
   region takes `outside_home_contractor`; the same inside the home region takes `home_employment`.
   Hybrid/On-site outside the home region takes `relocation_employment`; inside it takes
   `home_employment`. An unresolved format must not carry a home-region listing onto the
   international contractor floor: format class never overrides the region. Every applied default
   is an `assumption:` token, veto-able at review one answer per class, and a default is applied
   only where a decision consumes it. The later withdrawal of that review veto is recorded above.
9. **`residenceRestriction: incompatible` requires every feasible residence to be excluded** —
   current, committed, and every country of the profile §1 self-relocation set. This discharges the
   mandate ADR 0018 decision 6 reserved for this task. The rubric points at profile §1 and keeps no
   second copy of the enumeration, so a country added there cannot leave a stale duplicate behind.
   The set's open class is not a scoring input until a destination is confirmed into the profile.

## Scope of edits

- `knowledge/job-match-rules.md` — §2.2 replaced under the new policy id
  `triage-policy-v2-2026-08-21`; §3.1 (residence set, region taxonomy, hard-SKIP rules, relocation
  table), §3.2 (below-floor curve, relocation lane), §3.3 (the three S middles), §3.4, §4, §5, §6.2,
  §6.3, §7 (`data_gaps`, `assumptions`, `skip_basis`, `relocation_destination`, `policy_id`).
- `tests/instruction-contracts.test.mjs` — the §3.1 residence pins rewritten against the new prose;
  a new test freezes the six middles, the removed skip, the surviving review reasons and the region
  category.
- `instructions/skills/score-jobs.md` — the batch summary reports how many links decision 6 removed.
- `docs/runbooks/triage-review.md` — five flag rows rewritten (`relocation_floor_missing`,
  `engagement_path_unknown`, `work_format_unknown`, `residence_restriction_incompatible` and
  `policy_undefined`), two rows added for the `gap:*` and `assumption:*` groups task 26 will start
  producing, and the `flags` bullet gains the `skip_basis` counter's exemption. The
  `residence_restriction_incompatible` row is where the runbook points at task 38.
- the register of product decisions — the accepted triage record it names is the new id.
- `docs/adr/0007` — status pointer, and a corrected `Related:` line: it addressed the USD scale as
  "§3.4", which has been Domain Fit since the sections were renumbered.
- `docs/adr/0018`, `docs/adr/0019` — status pointers. Both carried present-tense statements that
  §3.1 still evaluates residence against the current and committed residences alone, and ADR 0018's third Consequence
  additionally told readers not to touch the rubric outside task 24.
- Backlog task 038 — created alongside this change as its own `main` commit, not as part of this
  branch, and it owns the two residuals named in Consequences below.
- Backlog tasks 026 and 028 — the implementing task gains the obligations this record
  created, and 028's premise that no scoring policy could turn a Gulf/Singapore composition into
  apply decisions is retired.
- `tools/job-scorer/` — **no edit**, by design. Backlog task 26 implements this record; until it
  lands, §2.2 carries an implementation-status paragraph and produced traces keep the superseded
  `policy_id`. This mirrors the interim the ToolMatch v2 taxonomy already runs under.

## Consequences

- (+) The five predetermined `relocation_floor_missing` outcomes of the 2026-08-18 run become
  scoreable, as do the `engagement_path_unknown` and `work_format_unknown` ones. Review attention is
  spent on contradictions rather than on absences.
- (+) A below-floor or unpriceable vacancy stays visible and ranked instead of disappearing, which
  is what the user asked for: the decision to drop it becomes his, not the scorer's.
- (−) **Uncertainty caps the bucket under the historical settings.** The unknown M value
  sits in a capped band of §4, so a vacancy
  whose mobility could not be established cannot reach `priority`. This is the conservative reading
  of a cap written for a *proven* blocker and is kept deliberately.
- (−) **A wholly uninformative vacancy lands in `pass` under the historical settings**, where the superseded policy
  would have raised it for review. It is not lost — it is ranked, its `data_gaps` list is full, and
  the ledger review is the mechanism that reaches it. The bucket is not asked to be that mechanism.
- (−) **Decision 6 loses vacancies the market would have honoured.** Hiring foreign engineers is
  routine in the Netherlands and Germany too, and silence there may be as neutral as in Dubai. The
  rule is not curable at the level of a listing's text; the loss is made visible instead of denied,
  through the `skip_basis` count in the batch summary.
- (−) Between this ADR and backlog task 26 the canon and the runtime disagree by design: the rubric
  states policy v2, `tools/job-scorer/` still executes the superseded record. The interim is stated
  in §2.2 rather than left to be discovered.
- (−) **An accepted asymmetry, not a defect:** an on-site listing that demands already-held
  authorization and names no location is scored, while its WEST-region twin is skipped, because
  closing signs 1 and 2 need a destination and sign 3 needs WEST. That is the uncertainty contract
  preferring to score over an unresolvable input, and it is recorded in §2.2 rather than fixed.
- (−) **Two defects this record deliberately does not close, both owned by backlog task 38.** On a
  Hybrid or On-site path no rule consumes `residenceRestriction`, so a listing demanding that the
  candidate already live in the destination is scored rather than skipped — "MUST BE currently based
  in Singapore" measured at `EVALUATED 62 consider`. And on a Remote path the superseded escape
  hatch, a contractor or employment path curing an incompatible residence, is left standing even
  though decision 5 rejects the same reasoning for on-site work: a contract changes the form of
  employment, not the place of residence. Rule 3's input changes here, its structure does not.
  Closing either means a new closing sign, which is a scoring decision this record's approval did
  not cover. Both are stated in `job-match-rules.md` §2.2 as well, because a residual that lives
  only in an ADR is invisible to the document a scoring run reads.

Related: private predecessor ADR 0007 (amended),
private predecessor ADR 0016,
private predecessor ADR 0018 (decision 6 discharged),
private predecessor ADR 0019; profile §1, §3, §4; backlog
tasks 24 (this record) and 26 (implementation).
