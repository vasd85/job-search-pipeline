# ADR 0013: Versioned source keys and the identity migration path

- **Status:** Accepted
- **Date:** 2026-08-13
- **Decision authority:** a separate `R2-01B` integration review
- **Task numbers:** the task ids below name records of this project's private predecessor backlog,
  which is not published. They are history, not pointers.

## Context

A file-backed process is identified by `source_key`, a normalized form of the `source_ref` the user
supplied. The normalization strips every query parameter whose lowercase name begins with `utm_` or
appears in one hard-coded set of eight names. Four of those eight — `query`, `source`, `tab` and
`refid` — are not tracking parameters. They are how several job boards address a posting.

`CORE-03` is the P1 confirmed defect that follows, and it was reproduced again on the frozen base of
this task, through the production CLI rather than through a unit call:

- four pairs of references that differ only in `query`, `source`, `tab` or `refid` respectively
  normalize to one identical key;
- starting the first posting succeeds; starting the second exits `2` with `status: "duplicate"` and
  a collision whose sole witness is the meaningful parameter;
- the only supported way forward is `--duplicate-of`, which permanently records two different
  vacancies as duplicates of each other;
- the control behaves correctly: a pair differing only in `utm_source` collapses onto one key on
  purpose, and the containment report stays **silent** about it, because the `utm_` prefix rule
  lives only in the normalizer and the prefix is deliberately outside the report's witness set —
  unlike each of the four meaningful parameters, which the report does name as the witness.

The same run showed the second half of the problem. `R1-03C` shipped a read-only containment report,
and that report groups records by the key they already carry and speaks only about groups of two or
more. In a corpus where all three records would change key, it reported one group. A lone record
whose key merely changes is invisible to it, so nothing in this repository can size the work a
policy change would create.

`R1-03C` closed detection and said so: its own completion entry records "no normalization … migration"
and lists versioned source-key migration as later work. ADR 0012 then routed every identity question
to this task and deliberately derived no identity from its new capture, so that it could not
pre-empt this record. This ADR decides that policy. It changes no stored key, migrates nothing and
does not flip the normalizer.

## Decision

1. The source key gains a **policy version**. Version 1 is exactly today's normalization. Version 2
   strips `utm_*` and a strict subset of version 1's named set.
2. The version is **derived from the immutable `source_ref`, never stored on the record**.
3. Both versions are computed by one code path, parameterized by version, so the two policies cannot
   drift apart in behaviour that is not the parameter.
4. The module keeps computing version 1 into `source_key`. Version 2 becomes the computed version
   only after the version-aware read path has shipped, and only through `R2-01C`.
5. A read-only census reports what a version change would do to an existing ledger, before anyone
   changes anything.
6. Historical records are never rewritten, never re-keyed and never migrated.

## The version 2 policy

Version 2 strips a query parameter when its lowercase name begins with `utm_`, or is one of
`alternatechannel`, `hhtmfrom`, `trackingid`, `trk`.

It therefore preserves `query`, `refid`, `source` and `tab` — exactly the four the audit reproduced
as meaningful. Everything else version 1 does is unchanged: the fragment is dropped, the host is
lowercased, a trailing slash is stripped from a path longer than one character, a non-`http(s)`
reference is returned verbatim, and the surviving parameters keep their original order and spelling.

The generic half of the policy is all this record decides. Host-specific rules — the knowledge that
one particular board's `tab` is decorative while another's is addressing — belong to the job-source
registry, and no queue row in this chain holds that lock. That is recorded below as uncontained,
not assigned.

**Version 2 is a refinement of version 1, and this is the property the whole migration rests on.**
Because version 2's strip set is a strict subset of version 1's, applying version 1 is the same as
applying version 2 and then stripping the remainder. Two references with the same version 2 key
therefore always had the same version 1 key. Contrapositively, two references with distinct version 1
keys can never acquire the same version 2 key:

- **a group can split, and never merge.** No process that is distinct today can become
  indistinguishable tomorrow;
- so no `duplicate_of` link is ever *required* by the change, and the group invariant "records
  sharing a key must be linked" can only become easier to satisfy;
- so the migration has no ordering hazard in which two records must be linked before the key changes.

A host-specific rule that strips a parameter version 1 preserved would break refinement. The
constraint is therefore stated as binding on whoever adds one: **any host-specific rule may only
preserve more than the generic policy, never less.** The census still looks for merges anyway,
because an invariant nothing checks is a claim.

## Why the version is derived and not stored

A stored `source_key_version` field was the epic's preferred cutover, and it is refused by the code
as it stands. Both probes were run on the frozen base:

- adding the field to a record fails validation with `processes[0] contains unknown key`, because
  the per-record key sets are closed and an unknown key is rejected rather than ignored;
- raising the ledger number fails with `schema_version must be 3`.

So a stored version is a ledger schema event. That event would have to edit the operating contract's
description of schema v3 under `INSTRUCTIONS_CORE`, ADR 0010 under `DOCS_AUTHORITY`, the bootstrap
tool under `BOOTSTRAP_CI` and the lifecycle under `PROCESS_LIFECYCLE`. Neither this task nor
`R2-01C` holds those locks, so a design that requires them is a design nobody in the queue can
build.

The derived design avoids the event entirely, because `source_ref` is immutable and both policies are
pure functions of it:

- **canonicality becomes membership.** A record is canonical when its stored `source_key` equals the
  key computed from its `source_ref` under *any* accepted policy version, instead of equalling the
  key computed under one.
- **duplicate lookup stops reading the stored key.** It compares the version 2 key computed from
  `source_ref` on both sides, which is exactly what the epic asked for when it required the lookup to
  compute v2 from the immutable reference.
- **rollback costs nothing at the record level**, because no record was rewritten.

The cost is named rather than buried: canonicality weakens from an equality to a two-element
membership test. A record that kept a stale version 1 key after cutover is accepted rather than
flagged, so the census below — not the validator — is the only thing that can tell an operator how
many such records exist. That is the trade this ADR makes, and the reason the census is a deliverable
and not a paragraph.

## Ordering: the read path ships before the normalizer

This is the sequencing constraint that makes the difference between a migration and an outage, and
it is stated here because the failure is total rather than gradual.

Canonicality is enforced for every record, in both the v3 validator and the legacy validator, and
every read path in the CLI goes through it — as does every write, which validates the next ledger
before committing it, so the constraint binds in both directions. Flipping the computed version while
canonicality is still an equality does not degrade one record: it throws on the first
non-canonical record and takes down every command, including `validate` and the census itself.

The order is therefore fixed:

1. ship the version-aware membership check while the computed version is still 1 — no stored key
   changes, and the ledger keeps loading;
2. run the census on the real ledger and read it;
3. only then change the computed version, so that new records carry version 2 keys while existing
   ones keep theirs;
4. existing processes are never re-keyed in place.

Steps 1 and 3 are `R2-01C`. Step 2 is an operator action on the operational checkout, which is why
the census is a command and not a test fixture.

## The read-only census

`node tools/process-log.mjs report-source-key-split` reads the ledger and writes nothing. Every leg
compares the **stored** key of each record against the version 2 key computed from its reference. It
never compares one policy version against another, and that choice is the point rather than a detail:
after cutover a ledger holds both versions at once, so a version-to-version census would report
records that are already migrated and stay silent about two stored keys converging. It reports:

- every record whose stored key would change, with its class (`file-backed` or `historical`), its
  reference, its stored key and its projected key;
- every stored key that splits into more than one projected key, with its members;
- every `duplicate_of` link the projection breaks — one whose two ends share a stored key today and
  land on different projected keys afterwards. A link that already crosses two stored keys was never
  a same-key link and is not reported, because the projection did not break it;
- every merge: one projected key reached from more than one stored key. The refinement property says
  version 2 can never produce one from a single-version ledger, and the leg exists because an
  invariant nothing checks is a claim, a later host-specific rule could break it, and a mixed-version
  ledger after cutover is exactly where two stored keys could quietly converge;
- counts for records, changes, split groups, merges and broken links.

One consequence is worth stating rather than leaving to be rediscovered, **and its premise has to be
stated with it**. Where the `duplicate_of` links inside a group are acyclic, every split group
necessarily contains a broken link: the group invariant exempts the first record of a group and
requires every other member to point at some member of it, so following links from any member
terminates, and it can only terminate at that exempt record. Any member that lands on a different
projected key than the exempt one therefore crosses a boundary somewhere along that path, and that
edge is a broken link.

The premise is not free. The invariant checks membership, not acyclicity, and nothing else checks
acyclicity either. Both tools that write links do produce acyclic ones — `start --duplicate-of` can
only name a record that already exists, and the historical importer links every member of a group to
its first record — but a ledger assembled outside them can hold a cycle among the non-exempt members,
split, and contain no broken link at all. That case was built and run through the production CLI: the
ledger loads, and the census reports one split group and zero broken links. So the operator question
is usually which links break, and `broken_duplicate_link_count: 0` beside a non-empty `split_groups`
is a signal to inspect that group by hand, not a statement that nothing separates.

It exits `0` whenever it could read the ledger. This is a deliberate difference from the `R1-03C`
containment report, which exits `2`: that report describes an ambiguity an operator must resolve
before proceeding, while this one describes planned work. A census that fails whenever it has
something to say cannot be run before a cutover it is supposed to inform.

The `R1-03C` report keeps its payload, its exit contract and its meaning. This is a second, separately
named command beside it, because ADR 0012 recorded that containment as integrated and not to be
contradicted.

## Compatibility matrix

Every policy element, ledger element, identity consumer, historical property and reader that could be
affected has a row. Rows this ADR does not touch say so explicitly rather than being omitted.

### Source-key policy

| # | Item | Today | Under this ADR | Owner |
| ---: | --- | --- | --- | --- |
| 1 | Version 1 normalization | The only policy; strips `utm_*` plus eight named parameters | Frozen as version 1 and kept computable forever, because stored keys must stay explainable | `R2-01B` |
| 2 | Version 2 generic policy | Does not exist | Strips `utm_*` plus `alternatechannel`, `hhtmfrom`, `trackingid`, `trk`; preserves `query`, `refid`, `source`, `tab` | `R2-01B` |
| 3 | Refinement | Not applicable — one policy | Version 2 strips a strict subset, so a group can split and never merge. Binding on any later rule | `R2-01B` |
| 4 | Host-specific rules | Do not exist | Specified, not built: they belong to the source registry, whose lock no row in this chain holds. **Uncontained.** Constrained only by row 3 | none today |
| 5 | The version marker | No version exists | Derived from the immutable reference; never a stored field | `R2-01B` |
| 6 | Which version the module computes | Version 1, implicitly | Version 1, explicitly and by a named constant, until `R2-01C` moves it | `R2-01C` |
| 7 | Non-URL references | Returned verbatim | Unchanged under both versions, verified for the imported grammar and for a plain scheme reference | `R2-01B` |
| 8 | Fragment, host case, trailing slash, parameter order | Normalized as described | Not applicable — identical in both versions, deliberately, so the only difference between them is the strip set | `R2-01B` |

### Ledger schema and stored records

| # | Item | Today | Under this ADR | Owner |
| ---: | --- | --- | --- | --- |
| 9 | Ledger schema v3 | Current and enforced | Unchanged. The derived design adds no field and needs no number | `R2-01C` |
| 10 | Closed per-record key sets | An unknown key is rejected, not ignored | Not applicable — unchanged, and named as the reason a stored version field is a schema event | `R2-01C` |
| 11 | `source_key` field | Stores the version 1 key | Keeps storing whatever version was current when the record was written; never rewritten in place | `R2-01C` |
| 12 | `source_ref` immutability | Current | Not applicable — unchanged, and relied on: it is what makes the version derivable | none |
| 13 | On-load canonicality, v3 validator | Strict equality with the single policy | Becomes membership in the set of keys the accepted versions produce from the reference | `R2-01C` |
| 14 | On-load canonicality, legacy v1/v2 validator | Strict equality | Same change, for the same reason: the migrator reads old shapes through it | `R2-01C` |
| 15 | Duplicate group invariant, v3 | Records sharing a key must be linked by `duplicate_of` | Moves to the computed key. Refinement means it can only become easier to satisfy | `R2-01C` |
| 16 | Duplicate group invariant, legacy | Same rule on the old shape | Same change | `R2-01C` |
| 17 | `duplicate_of` existence and non-self-reference | Enforced on load | Not applicable — unchanged | none |

### Identity consumers

| # | Item | Today | Under this ADR | Owner |
| ---: | --- | --- | --- | --- |
| 18 | Key computation when a process starts | Writes the current policy's key | Unchanged in shape; the version it computes is the one row 6 names | `R2-01C` |
| 19 | Duplicate lookup when a process starts | Filters on the stored key | Compares the version 2 key computed from each reference, and stops reading the stored key | `R2-01C` |
| 20 | `--duplicate-of` must reference a record with the same key | Enforced | Named as the one place a split is user-visible: after a split, a link to a predecessor whose key changed is refused. This ADR does not widen it; the cross-source duplicate question already has its own record and is not decided here | `R2-01C` |
| 21 | `--source-ref` selector resolution | Resolves on the stored key, fail-closed on an ambiguous match | Resolves on the computed key, and stays fail-closed. The fail-safe direction is not traded for convenience | `R2-01C` |
| 22 | `R1-03C` legacy collision containment | Integrated, read-only, reports rather than migrates | Not applicable — unchanged and not contradicted. It keeps reading the version 1 set, because it explains keys that version 1 produced | `R2-01B` |
| 23 | `report-source-collisions` payload and exit `2` | Frozen by two equality pins | Not applicable — untouched. The census is a separate command | `R2-01B` |
| 24 | Output directory ownership | Derived from company and role; uniqueness checked per directory | Not applicable — independent of the source key. Stated rather than left silent, because a total matrix must say so | none |
| 25 | Ledger-to-vacancy identity cross-check | Compares the recorded reference with the published bundle | Not applicable — it reads the reference, not the key | none |

### Historical records

| # | Item | Today | Under this ADR | Owner |
| ---: | --- | --- | --- | --- |
| 26 | Imported historical references are URLs | ADR 0012 row 35 says the imported grammar is not a URL and does not pass through normalization | **Corrected here.** The synthetic grammar is only the third fallback, behind a hard-coded first-party URL and a URL extracted from the message text, so most imported records do pass through normalization | `R2-01B` |
| 27 | Historical canonicality is enforced on load | Enforced through the shared field validator | Unchanged as an enforcement point, and named as the reason the membership check must cover historical records too. They are immutable, so a corpus made non-canonical could never be repaired | `R2-01C` |
| 28 | Historical `duplicate_of` chains | Built by the importer on the version 1 key | Never rewritten. A chain whose members separate under version 2 is reported by the census and left alone | `R2-01C` |
| 29 | Historical records are read-only and cannot be resumed | Enforced | Not applicable — unchanged | none |
| 30 | The `claude-ai-web` fallback grammar | Returned verbatim, because its scheme is not `http(s)` rather than because it fails to parse | Not applicable — unchanged under both versions, and verified as such | `R2-01B` |
| 31 | The historical importer writes keys and rewrites `duplicate_of` | It computes keys with the same normalizer and builds duplicate chains itself | Not applicable — its write path refuses a v3 ledger with `historical_import_write_unsupported_schema_v3`, and a dry run stops earlier still, so it cannot contradict row 28. Named because a reader of row 28 would otherwise have to rediscover why | none |

### Reports, migration and rollback

| # | Item | Today | Under this ADR | Owner |
| ---: | --- | --- | --- | --- |
| 32 | Census of a policy change | Does not exist; the containment report cannot answer it, because it only speaks about groups of two or more | New read-only command, exit `0` on a successful read | `R2-01B` |
| 33 | Migration tooling | Does not exist | Not built here. `R2-01B` decides; `R2-01C` builds, with the ordering of the section above as its contract | `R2-01C` |
| 34 | Rollback | Not applicable | Ledger backup and restore, with a stated precondition. **Not** a release revert: see below | `R2-01C` |
| 35 | Public reader and web UI | Renders the reference and the duplicate link, with no notion of a key version | **Uncontained.** A split changes what "duplicate of" means to a reader, and no row in this chain holds that lock | none today |
| 36 | Triage and decision traces | Normalize input separately from the ledger | Not applicable — the scorer owns whether a key version reaches a trace | `R2-05A` |

## Cutover and rollback

- The cutover is the ordering above: membership check first, census second, computed version third.
  No step rewrites a stored key.
- A process started after the cutover carries a version 2 key. An existing process keeps its key and
  finishes on it. There is no bulk migration, no silent re-keying and no automatic upgrade.
- The operational checkout receives the change only through the intentional cutover procedure, whose
  preconditions are unchanged by this ADR.
- **Rollback is not a release revert, and this is the single most likely thing to be waved through.**
  ADR 0012 could offer a release revert because a v2 bundle is a new file beside old ones. Here the
  affected artifact is the single ledger: once one record carries a version 2 key, reverting to code
  whose canonicality is an equality against version 1 makes that record non-canonical, and a
  non-canonical record fails the whole file at load. Rollback is therefore: stop, restore the ledger
  from a backup taken immediately before the computed version changed, then revert the code. The
  precondition is that the backup exists and that no process was started against the new version
  since it was taken; if a process was, its record must be removed by the same reviewed operation or
  the restore is not a rollback but data loss.
- Reverting only the code, while keeping a ledger that has both key versions in it, is not a
  supported state.

## Relationship to ADR 0012

[ADR 0012](0012-versioned-extraction-and-vacancy-v2.md) decided capture, render and fact evidence,
and deliberately decided nothing about identity:
its matrix routes rows 26 to 30, row 32 and row 35 to this task, leaves row 31 without an owner,
and records that a capture-derived
identity was withheld so as not to pre-empt this record. This ADR answers those rows and contradicts
none of the capture decisions.

One correction rather than an inheritance: ADR 0012 row 35 states that the imported historical
source-reference grammar is not a URL and therefore does not pass through URL normalization. That is
true only of the synthetic fallback. The importer prefers a hard-coded first-party reference, then a URL
extracted from the message text, and only then the synthetic form, and most of those hard-coded
references are ordinary `https://` URLs, so imported records routinely do pass through
normalization. The consequence is not cosmetic: it means a normalization change reaches
a corpus that is immutable by rule, which is why row 27 above exists and why the membership check
must cover historical records rather than only file-backed ones.

## Boundary with `R2-01C` and the registry

This record decides policy, ordering, rollback and what the census must show. It ships the census and
the parameterized policy, and it changes no stored key and no computed version.

`R2-01C` implements the membership check, moves duplicate lookup and selector resolution onto the
computed key, moves the computed version to 2, and owns the backup and restore procedure.

The host-specific half of the policy belongs to the job-source registry. Neither this row nor
`R2-01C` holds that lock, and the matrix records it as uncontained rather than assigning it to a task
that cannot act. Whoever picks it up inherits row 3 as a hard constraint.

## Verification owners

| Guarantee | Verified by |
| --- | --- |
| Version 1 behaviour is byte-identical to what it was before this record | `R2-01B`, by the untouched `R1-03C` equality pins and by the existing normalization tests |
| Version 2 preserves exactly `query`, `refid`, `source`, `tab` | `R2-01B`, by a three-anchor pin binding this document, a frozen literal and the module export |
| Version 2 is a refinement, so no merge is possible | `R2-01B`, over a structured reference corpus, and by the census reporting merges it can then be shown never to find |
| The census sees a lone record whose key changes | `R2-01B`, as the case the containment report provably misses |
| The census names the links the projection breaks, and only those | `R2-01B`, including a link that already crossed two stored keys and must not be reported |
| The merge leg is a detector rather than an always-empty field | `R2-01B`, by a coarsening projection and by a mixed-version ledger, since version 2 cannot produce one |
| The census writes nothing | `R2-01B`, twice: the input object is unchanged in memory, and the ledger bytes are unchanged around the command |
| A stored version field is refused by the current reader | `R2-01B`, as a pinned negative, so the schema-event claim above is measured rather than asserted |
| The containment report's payload and exit contract are unchanged | `R2-01B`, by the pins `R1-03C` already froze |
| Canonicality becomes membership without accepting a key from a third policy | `R2-01C` |
| The ledger still loads at every step of the ordering | `R2-01C` |
| Rollback restores a loadable ledger | `R2-01C`, including the case where a process was started after the backup |
| A host-specific rule preserves refinement | **Uncontained** — no row in this chain holds the registry lock |
| A split is presented honestly to a reader | **Uncontained** — no row in this chain holds the web lock |

## Rejected alternatives

- **Store `source_key_version` on each record.** Rejected: measured, not assumed — the closed key
  sets reject the field and the ledger number is pinned, so it is a schema event whose owning locks
  no row in this chain holds. It also makes rollback require rewriting every record, which is
  strictly worse than rewriting none.
- **Change `normalizeSourceRef` in place and accept the churn.** Rejected: canonicality is an
  equality enforced on load for every record, so the first non-canonical record fails the entire
  ledger. The failure is not degradation, it is an outage, and it would take the census down with it.
- **Keep one policy and fix only the duplicate lookup.** Tempting, and genuinely cheaper: the user
  harm is in the lookup, not in the stored string. Rejected because the stored key is also what the
  `--source-ref` selector resolves on and what the containment report explains, so a lookup that
  disagrees with the stored key gives one condition two answers — the failure mode the execution
  guide names explicitly.
- **Migrate historical records to version 2 keys.** Rejected: historical records are immutable by
  rule, their duplicate chains were built by the importer on version 1 keys, and there is no source
  to re-derive them from beyond the reference they already carry.
- **Extend the `R1-03C` containment report to answer the census question.** Rejected: its payload and
  exit code are frozen by equality pins and ADR 0012 records it as not to be contradicted. Widening
  it would also overload one command with a detector and a planner that disagree about what an
  exit code means.
- **Make the census exit non-zero when it finds work.** Rejected: it would be non-zero on essentially
  every real ledger, which turns the signal off. The containment report keeps the non-zero exit,
  because ambiguity is a condition rather than a plan.
- **Decide host-specific parameter rules here.** Rejected: they belong to the registry, whose lock
  this chain does not hold, and guessing which board's parameter is decorative is exactly the class
  of unverified claim this repository refuses.
- **Sort or case-fold query parameters in version 2.** Rejected: it would change the key for
  references that carry no tracking parameter at all, widening the blast radius for no defect in
  evidence, and it would break refinement.

## Containment

This document decides. It ships one read-only command and one parameterized policy, and the limits
below are part of the decision rather than an apology for it.

- **The defect is not fixed by this task.** The computed version is still 1, so two postings that
  differ only in a meaningful parameter still collide today exactly as reproduced above. What ships
  here is the decision, the ordering that makes the repair survivable, and the census that sizes it.
- The refinement property is argued from the strip sets being nested plus the serializer being
  idempotent, and corroborated over a structured corpus of references. That argument is sound and is
  not a machine proof over all inputs, so where the empty merge leg is called provable below it is a
  consequence of the argument and not of a check. A host-specific rule can break it.
- The census reads a ledger. It cannot know whether two records that share a key are the same
  posting; it reports that they would separate, not whether separating them is right. That judgement
  stays with the operator.
- The census was never run against the real operational ledger by this task, and could not be: a
  development session may not read it. The pre-cutover run is an operator action.
- Which of the eight version 1 parameters are genuinely tracking-only is a judgement about the
  outside world. Four are moved out of the strip set on reproduced evidence; the remaining four stay
  in it on their names and their observed use, which is weaker, and no fixture in this repository
  proves it.
- Canonicality weakens from equality to membership. A stale key after cutover becomes invisible to
  the validator, and only the census can count them.
- The census's merge leg cannot fire in the direction the cutover takes. That is the refinement
  property doing its job, not coverage: it is exercised by a coarsening projection and by a
  mixed-version ledger, and in a single-version ledger moving to version 2 it is provably empty.
- One residual is left deliberately: `buildSourceKeyVersionProjection` assumes a log that has passed
  validation, so a record with a missing or non-string reference reaches it only through a direct
  call and fails with an unbounded error rather than a typed one. Through the CLI it is unreachable,
  because the reader validates first.
- Two guarantees have no owner and are written as uncontained: a host-specific rule preserving
  refinement, and honest presentation of a split to a reader.
- The machine pin over this document freezes its section list, its matrix row subjects, which rows
  defer and which admit no owner, and the parameter sets, which are bound to the module export. It
  does not freeze most verdict cells, so a verdict can be reworded without the test noticing. Two
  narrower escapes are named rather than left to be found: a clause appended after a frozen sentence,
  and a later paragraph that contradicts an earlier one, both pass. That is deliberate — freezing
  every cell would make any correction a test failure — and it means the verdicts are the integration
  reviewer's responsibility, not the suite's.

## Implementation status

Everything above is the decision as it was accepted on 2026-08-13, and it is left as written: the
sentences in the present tense describe the repository at that date, not after it. This section
records what happened to the rows this record owns, and nothing above it was edited to match.

`R2-01C` shipped on 2026-08-18 as backlog task 002. Rows 6, 13-16, 19-21, 33 and 34 are implemented,
and **the module now computes version 2 into `source_key`**. The read path shipped first and the
computed version moved last, in that order and in separate commits, so the flip never existed
without the membership check. Row 33 (migration tooling) and row 34 (rollback) are discharged
together by `docs/runbooks/source-key-v2-cutover.md` and the two commands it drives: the migration
is a policy change with no re-keying step, so its dry run is `report-source-key-split` — already
shipped by `R2-01B` and runnable before the cutover — plus the read-only review of
`restore-ledger --dry-run`. Rows 1-5, 7-12, 17-18, 22-32 and 36 are unchanged by the implementation;
rows 4 and 35 remain uncontained.

Two things the implementation had to decide, because the matrix cell did not say them:

- **The duplicate-group invariant needed one clause the row does not name.** Row 15 says the
  invariant moves to the computed key and adds that refinement can only make it easier to satisfy.
  That is true of the requirement to link and false of the check as written: the check exempts a
  group's first record and requires every other member to name a member of *its own* group, so a
  group that shrinks can leave a non-first member pointing at a record that stayed outside. Such
  links exist in ledgers that are valid today — they are exactly the broken links the census
  reports — and for a historical group they could never be repaired, because those records are
  immutable by rule (row 27). The invariant therefore accepts a link whose two ends share the
  computed key **or** the stored key: sharing the stored key means they were one group under the
  version that wrote the link. The requirement itself is untouched — an unlinked duplicate is still
  an error. The clause is wider than the case that forces it, and its bound is recorded by
  construction rather than by how it looks: it decides something only when the link's two ends
  share the stored key and not the computed one — the shape a split creates, and the only shape it
  exists for. Only, not exactly: the check reaches it solely for a non-first member of a computed
  group that still holds at least two, so the canonical split of one pair into two singletons never
  consults it. A pair written after the cutover can never be that shape either, because stored
  equals computed for both; a legacy pair can, and that is the case the ledger already holds. That
  width is kept unreachable by the writers rather than by the check: `start` constrains
  `duplicate_of` to the computed-key match set, and the historical importer — the other writer of
  the field — writes a link only where the reader would otherwise refuse the group, and never
  rewrites a chain that already satisfies it.
- **The `R1-03C` witness comparison had to be pinned to version 1 explicitly.** It compared the
  *current* version's keys, which was version 1 when row 22 was written. Left alone, the containment
  report would have gone silent about the collisions it exists to explain the moment the computed
  version moved, since two references differing only in `query` stop sharing a version 2 key while
  the stored key that groups them does not move at all. Its payload and exit contract are unchanged.

One consequence of the flip is visible in `start` and `resolve` rather than in that report: fewer
references collide at all now, so the collision warning fires only for the four parameters version 2
still strips, plus a fragment difference. Nothing about the report's meaning changed; the input did.

### 2026-09-18: row 20 is widened by backlog task 010, and the writers' bound is restated

Row 20 said `--duplicate-of` must reference a record with the same key, and named that refusal as
the one place a split is user-visible. It also said this ADR does not widen it, because the
cross-source duplicate question had its own record. That record is backlog task 010, and it is now
decided: a vacancy can enter the pipeline through a different source — a dead posting re-sent as a
file, a re-post on another board — and only the user can say the two are the same vacancy. The old
refusal was the system answering that question from the two references alone, so it is gone. What
replaces it is a report, not a gate: `start` and the new `link-duplicate` return
`cross_source_duplicate_link` naming both keys whenever they write a link that crosses them, and
refuse nothing. Re-issuing a link a record already carries writes nothing and says so instead.
`docs/runbooks/source-key-v2-cutover.md` carries the operator's half.

Three things the widening deliberately does not touch.

- **Row 17 stays its own rule.** Existence of the target and non-self-reference are checked
  explicitly by both writers and still raise `invalid_duplicate_reference`. Folding them into the
  group invariant would have left a mistyped id to the load-time validator, whose answer to an
  operator is that the ledger failed structural validation — an outcome the task forbids.
- **Rows 15-16 are unchanged, and the writers stay strictly inside them.** Each writer asks only the
  first half of the reader's question: a record sharing its computed key with an earlier record must
  name a member of that computed group; a record alone in its group, or first in it, may name any
  existing process. So the clause above — a link accepted because its two ends share the *stored*
  key — is still never written by a writer, only read in ledgers a policy split already produced.
  The paragraph on the census consequence keeps its premise for the same reason it had it: the
  writers produce acyclic links. `start` still cannot close a loop, because it allocates a fresh id,
  and `link-duplicate` refuses one explicitly — it is the first writer that could.
- **Row 27 is unchanged.** A historical record is a legal target, and it is only ever read: its id,
  its reference, whose key the report above names and the group rule compares, and its own
  `duplicate_of`, which the cycle walk follows. The link is written on the linking record alone.

The identical-source case is exactly as strict as before, and that is not a courtesy. A record that
shares a key with an earlier one and points outside its group would make the ledger unreadable on
the next load, permanently for a historical group. It is also why the one real chain this decision
was filed for is repaired from the older end: the later record of a shared-reference pair can never
name the cross-source predecessor, but the pair's first record can, and the chain then reaches it
transitively. `report-duplicate-chain` exists to make that whole chain visible from any member, and
it reads the ledger directly rather than resolving an id, because one end of such a chain is
typically the historical record the resolver refuses.

One departure from the cutover section above is deliberate and is recorded here rather than left to
be discovered. That section says the backup is taken immediately **before** the computed version
changes. The runbook takes it immediately **after** the source update and before the first `start`,
because `backup-ledger` ships with this task and therefore does not exist on the release the cutover
leaves — ordered the other way, the step fails with `unknown_command` at the one point the rollback
design rests on. The two moments hold the same bytes as long as no process starts in
between, and what is measured is the weaker property that matters for a rollback rather than that
condition itself: `backup-ledger` reports `backup_readable_by_version_1_code` and exits 2 when the
file it just wrote is not a rollback target for the reverted code. A process that started in between
can leave that field `true` — a reference carrying only tracking parameters produces a record whose
stored key is its version 1 key — so the digest recorded beside it is the digest of the file that
was taken, not proof that the ledger did not move. An operator who wants the copy strictly
before the source update takes a
plain file copy, which needs no tooling from either release.

Rollback is `docs/runbooks/source-key-v2-cutover.md`, which owns the operator procedure and the
preconditions `backup-ledger` and `restore-ledger` enforce.
