# ADR 0029: Checked release pairs reuse unchanged component tags

- **Status:** Accepted
- **Date:** 2026-10-06
- **Decision authority:** explicit user approval of the release-pair procedure and its validation
  limits on 2026-10-06
- **Amends:** [ADR 0024](0024-two-repositories-one-snapshot.md) decision 11, the requirement to
  create both tags at every release; decision 1's two pinned snapshot components remains in force

## Context

The development and cutover runbooks required two new annotated tags at each release, while
`ops-tree` already accepted an existing engine tag with a changed candidate tag. The private
repository also holds excluded board and research records: its next commit need not change any
operational input. A release record written after a tag is one such change.

Some changes require both repositories to move together, such as introducing a required config
key and supplying its value. Others change only a profile or preserve the candidate contract in a
new engine. Creating an extra tag for unchanged content does not verify either case. Matching tag
dates also do not prove compatibility, and publishing tags in two repositories is not atomic.

The existing tool exports both selected trees and checks candidate with the selected engine.
Before a cutover with a ledger, it also checks copied process state and reports new deep-validation
findings. Those checks cannot prove prose rules agree or replace runtime smoke. The tool rebuilds
and swaps both zones even when one component's selected version is unchanged.

## Decision

1. **Readiness belongs to the exact pair.** A release names an engine tag and a candidate tag,
   their commits and trees, the user's scope, and the evidence for compatibility. The user
   authorizes the selected pair; a release and an operational cutover remain separate decisions.
2. **Reuse unchanged versions explicitly.** Create annotated tags only for included changes to
   exported content that lack a suitable tag. An unchanged counterpart keeps its named approved
   tag. Excluded private records alone need no candidate release. Changes present in both
   repositories do not automatically enter the same release: the user selects the scope.
3. **Keep related contracts together.** A release cannot be declared ready with an unfinished
   required counterpart. Schema, file, constraint, language and prose-rule changes are reviewed
   against the selected consumer. An old counterpart is allowed when it already supports that
   contract, with recorded evidence. A list of changed paths or a validation pass cannot prove
   semantic independence.
4. **Use the installed pair as the explicit comparison baseline.** Another baseline or an initial
   export is recorded explicitly. Changes are evaluated in exported content under the applicable
   builder's rules. The latest tags, HEADs and equal dates never select or validate a counterpart.
   Engine gate evidence and exact-image checks belong to the selected revisions, followed by
   a dry run on the intended folder's current state before cutover.
5. **Use the existing private task and operational evidence.** The private release record stores
   version and tag-object identities, scope, semantic review, mechanical check results and limits,
   authorization, publication progress and the eventual cutover identity. The manifest and cutover
   evidence record what was installed; the private record connects them. There is no new registry,
   compatibility matrix or manifest schema. The tool does not enforce this procedural connection.
6. **Treat interrupted publication and recovery explicitly.** A partially published pair is not
   a ready release. Resume the same recorded revisions and verify both refs; never retarget tags
   to a newer HEAD or overwrite conflicting refs. A rebuild of the installed pair and a rollback
   to a retained tree need no new tags and are recovery events. Current state is preserved, so
   returning to older code still requires review of that state's version compatibility.

## Consequences

- Independent updates no longer require a tag whose exported content is unchanged. The two
  versions still travel as one explicitly selected snapshot.
- Required linked changes are evaluated together; gate, candidate and image checks, and operational
  state checks retain their existing responsibilities. Expected stale inputs are reported without
  being mistaken for an unreadable pair.
- Semantic compatibility remains a recorded review conclusion, not an automatic proof. Publishing
  both refs and connecting private evidence to an installed manifest also remain procedural duties.
- Physical export, dependency installation, swap and rollback behavior do not change. Optimizing
  unchanged zones would be separate work with its own drift-repair and recovery consequences.
- Historical tags, earlier release evidence and operational folders are not altered by this
  decision. The current procedure is owned by
  [development flow](../runbooks/development-flow.md#8-release-and-cutover), with the state-specific
  steps in [ops-cutover](../runbooks/ops-cutover.md).
