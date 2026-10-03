# Manual application-readiness checklist

Status: **mandatory manual review before an application is sent**

This checklist separates the integrity of publication from the readiness of the materials. The
`completed/current` lifecycle proves only that the canonical files are published, their bytes are
intact and the recorded inputs have not changed. It does not prove that they match the live
source, nor their factuality, freshness, prose quality or visual fitness.

The checklist is run against live visible sources and the canonical files in the process-owned
`output/<company-role>/`. Chat, an earlier handoff and session memory are not evidence. The one
exception is a user-confirmed deviation under
[the honesty floor](../../knowledge/precedence.md#0-protected-honesty-floor): such a deviation
exists only in chat and therefore cannot be proven by an earlier session, so the user confirms it
again, live, during this run of the checklist. Passing the checklist does not change
`process-log.json`, the lifecycle state or artifact metadata, and it creates no stored
human-approval record.

## Step 1 — vacancy source and canonical vacancy

- [ ] The final URL is open; the vacancy is still active, not closed, archived, deleted or private.
- [ ] `job-description.txt` contains the full JD in its original order, including headings, lists,
      compensation and feasibility wording.
- [ ] Company and role match the live source.
- [ ] Every identity/feasibility field of `vacancy.json` is checked against the exact source
      wording: language, market, work model, location/region, timezone, authorization, relocation,
      employment type, contractor eligibility and salary/compensation.
- [ ] Implicit or missing facts stayed nullable/unspecified instead of being guessed.

## Step 2 — company research

- [ ] The supporting source of every load-bearing claim has been opened.
- [ ] Every quote matches its source and carries a correct translation.
- [ ] Scope (`company`, `team`, `role`) and the source owner/source family are checked; team
      evidence is not raised to a company-wide fact.
- [ ] The observed date and the actual freshness are checked for compensation, leadership,
      funding, logistics, stack and AI direction.
- [ ] Unverified/inferred claims and contradictions are not presented as verified facts.

## Step 3 — candidate mapping and honesty

The items of this section and the honesty items of Steps 4-5 are read with one proviso: a
divergence of the material from the honesty floor (its canonical owners are listed in
[the protected honesty floor](../../knowledge/precedence.md#0-protected-honesty-floor)) that is a
user-confirmed deviation under
[the protected honesty floor](../../knowledge/precedence.md#0-protected-honesty-floor), confirmed
again by the user during this run, does not count as a breach of the item; a divergence without
that confirmation is a breach of the honesty floor.

- [ ] Every candidate metric is checked against the canonical profile, including baseline,
      causality and personal/team attribution.
- [ ] Historical company, title and dates are unchanged.
- [ ] Every selected claim and trait has a supporting canonical evidence pointer.
- [ ] Every hard/adjacent gap is kept honest; a hard gap is not presented as direct experience.
- [ ] The commercial and personal-project AI boundary is respected; personal experimentation is not
      passed off as production experience.
- [ ] ATS keyword placements, exclusions and the chosen positioning match the vacancy and the brief.

## Step 4 — CV

- [ ] The DOCX is a valid ZIP/OOXML package and opens in a supported renderer.
- [ ] The structural/build checks passed on the exact published `cv.json` and DOCX.
- [ ] Every rendered page has been viewed at 100%: no clipping, overlap, broken glyphs, orphaned
      headings or illogical page splits.
- [ ] Header/title, chronology, metrics, gaps, ATS terms and AI wording are checked against the
      brief and the profile.
- [ ] The CV is readable, ATS-safe and carries no unplanned claims and no second variant.

## Step 5 — cover letter

- [ ] Title and language match the exact role and the vacancy language.
- [ ] Structure, paragraph/word limits, signature and the absence of markup are checked.
- [ ] Only planned evidence and keywords are used; causality and attribution are preserved.
- [ ] The company angle is specific but does not diagnose unknown internal problems.
- [ ] A person has read the letter in full: grammar, native phrasing, factuality, honesty and gaps
      are checked.

## Final decision

- [ ] Every applicable item above is confirmed against the canonical files and visible sources.
- [ ] Any unresolved divergence is fixed through an explicit lifecycle: a reopen of the matching
      Step with the downstream descendants published again, or — for a targeted edit of an already
      published Step 4/5 material — `revise-step` under the shared contract; or it is confirmed again
      by the user as a user-confirmed deviation under
      [the honesty floor](../../knowledge/precedence.md#0-protected-honesty-floor) — then it is
      resolved without an edit to the material.
- [ ] Exactly the current canonical CV/letter bundle checked in this review session is sent.
