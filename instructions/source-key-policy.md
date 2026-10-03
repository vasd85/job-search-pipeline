# Source-key policy

The acting half of
[ADR 0013](../docs/adr/0013-versioned-source-keys-and-identity-migration.md). That record is the
decision, and its `## Implementation status` section records what shipped; both are read when the
decision itself is questioned, not to find out what to do.

Most of this policy already has an owner, so this file is short on purpose and names them:

| Question                                                                         | Owner                                                                                              |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Which parameters each version strips, and which version is computed              | `sourceKeyTrackingParameters`, `currentSourceKeyPolicyVersion` in `tools/lib/process-log-core.mjs` |
| What the cutover changed for an operator, the census reading, the whole rollback | [docs/runbooks/source-key-v2-cutover.md](../docs/runbooks/source-key-v2-cutover.md)                |
| Capture, render and fact evidence                                                | [vacancy-capture-policy.md](vacancy-capture-policy.md)                                             |

Version 2 is the computed version. Read the module for the sets; a prose copy of a bounded set is a
second spelling of one rule waiting to drift.

What follows is what neither of those owners carries.

## Binding on any change to this policy

**The version is derived from the immutable reference and is never stored on a record.** A stored
version field is a ledger schema event, measured rather than assumed: the per-record key sets are
closed and reject an unknown key, and the ledger number is pinned. Such an event would have to move
the operating contract's description of the schema, the artifact decision record, the bootstrap tool
and the lifecycle at once, and no work in this chain holds those locks.

**Refinement is the property the whole migration rests on.** Version 2 strips a strict subset of
version 1, so a group of references can split and never merge: no process that is distinct today can
become indistinguishable tomorrow, no duplicate link is ever required by the change, and there is no
ordering hazard in which two records must be linked before a key changes. This binds whoever adds a
host-specific rule: **such a rule may only preserve more than the generic policy, never less.**

**Version 1 stays computable forever**, because a stored key has to stay explainable. **Both
versions are computed by one parameterized path**, so the only difference between them is the strip
set — fragment, host case, trailing slash and parameter order are identical in both, deliberately.

**The read path ships before the normalizer.** Canonicality is enforced on load for every record,
and every read and every write goes through it. Moving the computed version while canonicality is
still an equality does not degrade one record — it throws on the first non-canonical record and
takes down every command, including validation and the census itself. So: ship the version-aware
membership check first, read the census on the real ledger, and only then change the computed
version. The same constraint binds any later change of the computed version, for the same reason:
canonicality is enforced on load, so a read path accepts a version before anything computes it.

**Canonicality is membership, not equality.** A record is canonical when its stored key equals the
key computed from its reference under _any_ accepted policy version. The cost is named: a record
that kept a stale key after a cutover is accepted rather than flagged, so only the census can count
them.

**No stored key is ever rewritten, re-keyed or migrated** — file-backed or historical. The
membership check has to cover historical records too: they are immutable by rule, so a corpus made
non-canonical could never be repaired.

## Two clauses the matrix does not state

Both were forced by the implementation and both are load-bearing.

**The duplicate-group invariant accepts a link whose two ends share the computed key _or_ the stored
key.** Sharing the stored key means the two were one group under the version that wrote the link.
The requirement itself is untouched — an unlinked duplicate is still an error. The clause is wider
than the case that forces it, and its bound is stated by construction: it decides something only
when a link's two ends share the stored key and not the computed one, which is the shape a split
creates. That width is kept unreachable by the writers rather than by the check. Each writer asks only the
first half of the reader's question: a record that shares its computed key with an earlier record
must name a member of that computed group, and a record alone or first in its group may name any
existing process. `start` and `link-duplicate` share that rule, and the historical importer writes a
link only where the reader would otherwise refuse the group. A link across two different keys is
therefore possible and is the user's explicit declaration; it is reported, never refused, and the
refusal that once made a split visible is gone.

**The legacy collision report is bound to version 1 explicitly.** It compares the keys version 1
produced, because that is what it exists to explain. Left reading "the current version" it would
have gone silent about the collisions it exists for, the moment the computed version moved. Its
payload and its exit contract are unchanged and are not to be contradicted.

## The census

`report-source-key-split` is read-only and exits `0` whenever it could read the ledger —
deliberately unlike the legacy collision report, because a census that fails whenever it has
something to say
cannot be run before the cutover it informs. Every leg compares the **stored** key of each record
against the key computed from its reference; it never compares one policy version against another,
because after a cutover a ledger holds both at once. The merge leg exists even though refinement
says it cannot fire from a single-version ledger: an invariant nothing checks is a claim.

The census reports that records would separate, not whether separating them is right. That
judgement is the operator's, and the runbook above owns how to read the output, the ledger backup
and the restore — including its recorded departure from the record: the backup is taken
immediately
**after** the source update rather than before, because the command that takes it does not exist on
the release the cutover leaves.

## Guarantees with no owner

Uncontained rather than quietly assigned; a task relying on either says so rather than assumes:

- a host-specific rule preserving refinement — the job-source registry holds that lock and no work
  in this chain does;
- honest presentation of a split to a reader, which changes what "duplicate of" means in the public
  reader and the web UI.
