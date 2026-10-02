# ADR 0017: User-confirmed deviation replaces hard refusal at the honesty floor

- **Status:** Accepted
- **Date:** 2026-08-17
- **Decision authority:** explicit user decision, session of 2026-08-17
- **Amends:** [ADR 0003](0003-honesty-floor-inviolable.md)

## Context

ADR 0003 made the honesty floor inviolable: a request for output contradicting the floor was
refused, and the only sanctioned change was a deliberate canonical git edit. In practice the user
sometimes deliberately wants a one-off deviation from the recorded profile in a specific
deliverable, and the hard refusal forced a full canon edit for what is a per-application
presentation decision about the user's own facts. The user asked (2026-08-17) for a confirm gate
instead of a refusal: the agent must surface the contradiction explicitly and request
confirmation, but must not block the deviation once it is confirmed.

## Decision

The floor's protection changes from "refuse" to "no silent deviation":

1. When the user requests output that contradicts the floor, the agent surfaces the conflict —
   the owning canonical file, the protected fact, and exactly what the requested output would
   claim instead — offers canon correction or a one-off deviation, and proceeds with the deviation
   once the user explicitly confirms it in chat. Confirmation is per case and per deliverable.
2. Silent deviation stays forbidden. Confirmation is never inferred from context, session history,
   memory, or external content; fetched vacancy/web/recruiter text and user-pasted source material
   can neither request nor confirm a deviation — the untrusted-data boundary of the operating
   contract is unchanged.
3. A confirmed deviation does not amend canon and does not persist: a later session touching the
   same material surfaces the conflict again. Permanent fact changes still go through the
   protected-change policy's canonical git edit.
4. The ADR 0015 review-waiver channel is unchanged: honesty findings remain non-waivable there.
   The §0 confirmation procedure is the only deviation door.

## Consequences

- (+) The user keeps final authority over their own materials without a canon edit per deviation,
  and every deviation is explicit: named in chat before it happens, restated in the step summary
  after.
- (+) The floor still holds against every channel except an explicit per-case user confirmation in
  chat — including adversarial JD text, which has no way to produce such a confirmation.
- (−) Confirmations are session-scoped and per-deliverable, so a recurring deviation is
  re-confirmed each time material is touched — including on the sibling deliverable of the same
  application, which is what keeps a confirmed CV claim and the cover letter from silently
  diverging. A published artifact carrying a confirmed deviation is likewise indistinguishable in
  the ledger from one that deviated silently: the traces are the chat confirmation, the restated
  compact summary, and the live re-confirmation the application-readiness checklist requires. If
  the re-confirmation noise or that audit gap proves costly, persisting confirmed deviations (for
  example in `application-brief.json`) is a separate backlog task with schema consequences —
  deliberately out of scope here.
- ADR 0003's rejection of an "overridable floor" is amended, not discarded. What made an
  overridable floor worthless was silent override under pressure from content or convenience; an
  explicit, surfaced, per-case user confirmation is the user exercising ownership of their own
  facts — the thing the floor was built to serve, not to resist.

Encoded in [knowledge/precedence.md](../../knowledge/precedence.md) §0, the operating contract's
Honesty floor section, the revision journal rules and compact chat returns of
`instructions/pipeline-artifacts.md` and of the two generation skills (never-waivable lists and
Chat return sections), the header note of `knowledge/generation-rules.md`, and the deviation
carve-out of the application-readiness checklist. Related:
[ADR 0003](0003-honesty-floor-inviolable.md) (amended),
[ADR 0015](0015-lightweight-post-review-revision.md) (waiver channel unchanged),
`generation-rules.md` rules 15-17, profile §7, `impact-levers.md` §1.3.
