# ADR 0005: Title normalization — Senior only in the Summary headline (F3)

- **Status:** Accepted
- **Date:** 2026-06-17

## Context

The self-identity and target role is "Senior QA Automation Engineer / SDET", but the actual
historical titles differ: three employers titled the role "Software QA Engineer" and three others
"QA Automation Engineer". The targeted-cv-playbook's own Experience example showed the most recent
employer as `Senior QA Automation Engineer`, which both inflated seniority and changed the role
type versus the real "Software QA Engineer". DECISION F3 asked for an explicit rule.

## Decision

Adopt the **strict** rule (owner's choice):

- The **Summary headline** may present the self-identity "Senior QA Automation Engineer / SDET"
  (target-role positioning).
- In **Experience**, use each employer's **actual historical title verbatim** (profile
  Section 9). Never present a historical title more senior than the real one, and do not relabel
  the role type (e.g., "Software QA Engineer" is not rewritten to "QA Automation Engineer").
- Seniority is normalized **only** in the Summary headline, never in Experience.

## Scope of edits

- Profile Section 12 (now generation-rules.md) — new generation rule 19 ("Title normalization").
- targeted-cv-playbook §5.5 Experience — new "Title rule" block; the example header corrected to
  the employer's real title, "Software QA Engineer".

## Consequences

- (+) Experience titles are honest and verifiable; the seniority claim lives only where it is a
  defensible self-summary (the headline), not attributed to a specific employer.
- (+) Removes a concrete misrepresentation (the inflated playbook example).
- (−) Slightly less ATS-keyword latitude in Experience (cannot relabel "Software QA Engineer" to
  "QA Automation Engineer"); the Summary headline and Skills section still carry the automation
  keywords. The rejected alternative (role-type relabel without seniority inflation) was declined
  as historical-title rewriting / a gray area.

Related: profile Section 9 (titles), generation-rules.md rule 19; CV-playbook §5.5.
