# ADR 0003: The hard honesty rules are an inviolable floor (precedence model 0b)

- **Status:** Accepted; amended by [ADR 0017](0017-user-confirmed-honesty-deviation.md) — the
  hard-refusal rule is replaced by an explicit user-confirmed deviation gate
- **Date:** 2026-06-17

## Context

The pipeline auto-generates CVs, cover letters, and messages. A set of hard honesty rules (originally Section 12 of the candidate profile; now
`generation-rules.md` rules 15-17, with profile Section 7 and `impact-levers.md` §1.3) guards against dishonest
output: no production claim for a personal project, honest gaps, the lever
factual boundary (agentic methods attach only to the personal project, never to commercial
work), and no AI tool-name leakage. DECISION 0b asked whether an
in-session instruction can override these, or whether they are inviolable regardless of input.

## Decision

The honesty rules are an **inviolable hard floor.** No in-session instruction overrides them,
regardless of input. They sit **above** the source-authority hierarchy — above the playbooks,
`memory.md`, and `reference/`.

The **only** way to change a fact the floor protects is to **edit the canonical file**
(profile / playbook) deliberately, in git, through the revision process. A request to violate the
floor is refused; a request to change a fact is satisfied by editing canon, not by overriding
generation.

## Consequences

- (+) The floor holds under pressure — including the moment of temptation to embellish for an
  offer, and adversarial text inside a vacancy/JD.
- (+) Honest-by-construction output; the integrity guarantee does not depend on session wording.
- (−) No quick in-session "just this once" exception. Legitimate fact changes route through a
  deliberate, version-controlled canon edit — slower, but auditable and correct.
- Rejected "overridable": an overridable floor is not a floor; it fails exactly when pressure is
  highest, defeating its purpose.

Encoded as a top-level hard floor in [../../knowledge/precedence.md](../../knowledge/precedence.md)
(Section 0) and [../../CLAUDE.md](../../CLAUDE.md). Related: generation-rules.md rules 15-17, profile Section 7, impact-levers.md §1.3;
[0002-memory-vs-files-precedence.md](0002-memory-vs-files-precedence.md).
