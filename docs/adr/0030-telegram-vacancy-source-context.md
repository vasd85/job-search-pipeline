# ADR 0030: Preserve Telegram vacancy source context

Status: accepted
Date: 2026-10-08

## Context

A Telegram vacancy can contain a complete JD, a company homepage, contacts and an external apply
page. The URL-only handoff treated each as a vacancy. A readable homepage became technical
unavailability and was retried, while the original JD could already yield a correct manual/junior
SKIP. A short post could disappear from the flat inputs even though its external full JD remained
available. Grouping by company, author or post would also combine the separate jobs of a digest.

## Decision

Publish a versioned, digest-bound source set beside the collection. Code extracts full original
text/anchors; the isolated reader supplies only numbers, own vacancy boundaries and closed roles.
Use snapshot/body and title/own-boundary references as durable identity. Display ordinals and
approximate repost similarity cannot supply a cache key. New source mapping only folds exact
body/anchor reposts; old state remains readable in its own epoch.

Preserve two accounting units: URLs with their explicit dispositions, and logical vacancies with
all publications and application routes. Context roles are card-scoped, never hostname rules.
Source units remain indivisible when splitting sessions; shared company context does not join
jobs. Unknown mappings and oversize input are visible rather than silently dropped.

Compile an immutable source-resolution artifact. Direct link evidence, checked target identity
and matching explicit employer/role establish a relation. The complete original is primary; a
summary needs a complete details/apply JD. Compare explicit material facts, keep absence distinct,
and never mix salary/seniority or any other fields across descriptions. Unknown publication dates
do not gain precedence from fetch time. Conflicts/unconfirmed identity yield source review with all
raw alternatives; different jobs stay separate. Manual/junior filters and scoring prices/formulas
remain unchanged.

Normalized input10/`triage-policy-v9-2026-10-08` binds every quote to one selected source, digest and own vacancy body.
Source review is a logical resolution result, not a relabelled `policy_undefined` trace. Proven
company context is source accounting without JD fetching or BLOCKED; true transport/identity
failures retain retry behavior. Standalone URL terminal codes remain a separate concern.

Extend the existing mutable ledger to explicit version2 logical/source fields. Keep prior URL
observations and immutable records intact. Guard snapshot/card identity before cache lookup;
confirmed revision aliases need parent-bound evidence. Correct old contextual BLOCKED observations
through a new immutable parent-bound correction batch, archive before ledger, preserve original
observation timestamps and never falsely close the URL. Bare URLs retain their previous contract.

Verification re-parses saved HTML, checks exact digests, card coverage, quote ownership, target
identity, deterministic primary/result and both counts. A plan does not prove a context role or
waive a missing JD. Read old artifacts in their declared supported epoch; incompatible epochs
require the historical mechanism. Per-role source keys and output artifacts are unchanged.

## Consequences

The handoff has explicit immutable artifacts and a new reader/card/state/input/ledger epoch.
Session reports show one confirmed job or one linked review with alternatives, not inflated chances
to apply. A same-UID actor who rewrites every artifact consistently remains outside capture-custody
proof. Fictional offline regressions establish code behavior; isolated model source mapping and
live capture behavior require the subsequent authorised runtime smoke.
