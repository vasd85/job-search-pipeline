# Telegram vacancy sources

A source set preserves the vacancy card when a Telegram collection is flattened to URLs. A company
homepage is `company_context` for a specific card, not another vacancy or a failed JD. Bare links
and historical `# via:` comments remain the standalone URL contract.

## Artifacts and identity

`source-set.json` version 1 binds the exact collection bytes to saved Telegram HTML. Each snapshot
contains code-extracted complete lines/anchors, the original post URL, publication instant and
`capture: {file, sha256, captured_at}`. `sha256` describes the HTML bytes; `captured_at` is the
collector's clock, not the post's publication time. Re-parsing the saved HTML must reproduce the
snapshot. This detects later edits, not fabrication by an actor who can rewrite the entire store.

A `tg-snapshot:sha256:<digest>` includes source handle/post id, publication instant and the complete
code-extracted body/anchors. A `tg-card:sha256:<digest>` binds that snapshot to the title line and its
own inclusive start/end lines. `vacancy_no` is display order only. Reader answer permutations or a
newly recognised sibling cannot change an unchanged card's identity. Changed source bytes or its
own boundaries cannot inherit a cached result without a separately verified revision alias.

Cards declare `full_description`, `summary` or `unknown`, and `resolved` or `unresolved_oversize`.
Every web anchor has an explicit role: `company_context`, `details`, `apply`, `original_post`,
`contact`, or `unknown`. Only company context may be shared across disjoint vacancy boundaries.
The original source remains available even if the flat collection contains only company and
apply/detail URLs. Unknown roles remain visible and cannot become confirmed identity.

`validateSourceSet(set, {collectionText, captureRoot})` checks digests, bounds, closed fields,
code-derived references, full anchor coverage and HTML extraction. Persisted readers always supply
`captureRoot`; an in-memory fixture validation without it establishes shape, not capture custody.
`readSourceSet(file, options)` returns `{sourceSet, digest, text}`. Serialization is
`JSON.stringify(set, null, 2) + '\n'`; `sourceSetDigest` hashes those bytes, or exact bytes when given
text/Buffer. Noncanonical serialized artifacts cannot substitute a different digest downstream.

## Resolution and scoring

`reconcile.mjs#resolveSourceSet({sourceSet, collectionText, observations, selection, languages,
scoring, captureRoot})` compiles `source-resolution.json` version 1 under
`triage-policy-v9-2026-10-08`. `selection` is `{from, to, card_refs}` over the original deduplicated
collection. It cannot split a selected card's job sources. Shared context alone never activates a
card in another group. With no selection, the whole collection and every card are selected.

An observation supplies `card_ref`, `source_ref`, `description_kind`, `identity_status`,
`capture: {file, sha256}`, `body`, `facts` and `input`. Facts explicitly account for
`company`, `title`, `role`, `seniority`, `salary` and `published_at`; each is null or
`{value, evidence_quote}` supported by its own body. Absence differs from an explicit contradiction.
Publication dates are source facts; capture time never chooses the newer edition.

Every selected card requires its original observation, including an unscored summary. A
`full_description` observation requires its own scoring or unread input; it cannot disappear behind
`input: null`. The original body is the code-extracted `cardBody`, pinned to the HTML digest and
card boundaries. An unreachable original uses a typed unread observation instead.
Details/apply bodies use the verified stamped vacancy-fetch capture and its normalized body digest.
A usable input must be schema 10, policy v9 and a full description. Its `sourceContext` binds
`sourceSetSha256`, `cardRef`, `snapshotRef`, `primarySourceRef`, `primaryCaptureSha256`, `startLine`
and `endLine`. Every evidence quote belongs to that one body; no field is transplanted from another
publication. Original line bounds are full-snapshot coordinates; observation.body is already sliced.

A failed request with no capture supplies `capture: null`, `body: null`, all facts null and
`transport: {file, sha256, index}` binding its exact fetch manifest record. The input is unread;
context digest/range are null, evidence is absent and no usable JD is asserted. Manifest versions
1/2 and their existing outcomes are read. True failures remain BLOCKED/retryable; existing terminal
404/closure behavior keeps its own contract. A failed or closed saved capture or manifest record
also requires its unread input; unscored observations cannot hide transport failure or closure.
General homepage/not-a-vacancy codes belong elsewhere.

Membership alone does not confirm identity. A direct details/apply link also needs checked target
identity and matching explicit employer/role. Redirects to another posting, unknown roles,
unconfirmed targets and conflicting explicit title/seniority/salary/date/liveness produce
`source_review`. A readable original plus a closed linked job route does not silently become an
apply recommendation; the raw observations remain visible.
For confirmed sources a full original is primary; for a summary a full details/apply JD is primary.
Explicit material facts in summaries also constrain the linked full JD without scoring the summary.
Independently confirmed cards merge through a common job posting and matching employer/role. Every
observation in the union is compared, including nonprimary alternatives. A contradiction keeps
one linked `source_review` row and all raw outcomes; an absent primary fact cannot bridge conflicting
alternatives. A `different` target is a separate logical group, with its own result and key.

Each group contains its logical key/cards, identity status, primary observation reference, every
source disposition, conflicts, result and all raw alternatives. `url_accounting` covers every
supplied URL and all its memberships. A confirmed job has one report row; a review has one linked
row with alternative raw results; genuinely different jobs have separate rows. Manual/junior
filters and M/C/S/D/ToolMatch formulas are unchanged. Source review has no score or apply bucket. `sourceCompositionObservations` emits one
observation per logical group for `composeBatch`; unresolved groups or multiple offered paths
remain unknown rather than combining fields from different sources.

`validateSourceResolution(resolution, options)` verifies captures/transport when `captureRoot` is
provided and reproduces the complete artifact from observations. A caller's plan or primary choice
cannot waive coverage, quote scope or identity. It requires exact `collectionText`.

## Publication and lifecycle

Claim a batch in the existing store first. `publishSourceResolution` accepts that absolute
`artifactsDir`, validated `sourceSet`/`collectionText`, observations and optional selection plus
candidate languages/scoring. Supply `sourceCaptureRoot` to copy the collector's saved HTML before
validation; fetched captures/manifests already belong to the batch. It writes exclusive
`collection.links.txt`, `source-set.json`, `source-resolution.json`, `inputs/NNN.input.json` and
`traces/NNN.trace.json`. `inputIndex` is a unique extraction ordinal in 1..999 in source mode, independent of
URL positions and the logical job count. Summaries and company/contact sources produce no fake
input. A failed/partial publication is retained for diagnosis, never overwritten.

Archive the pre-fetch source/pretriage plan as `plan.json`. Run triage verification before
`recordSourceBatch`, with the source selection's original URL range and ledger. Use the module
APIs in the review runbook for an explicit ledger v1→v2 upgrade, revision aliases and corrections.
The mutable file stays one ledger; URL history, logical results and source-scoped memberships have
separate fields. Corrections add a new parent-bound immutable batch and retain old observations and
timestamps. They do not refetch, close a vacancy or change historical batches.

Schema9/policy8 inputs, reader1/card3/stage1/manifest1 and ledger/record1 retain their original
meanings. The supported legacy scoring epoch is reproduced without source grouping; earlier epochs
need their historical checkout and report policy drift here. Per-role source keys/process logs and
output bundles do not change. Development tests use fictional data and disposable roots; model/live
behavior is verified only by the later authorised tagged rehearsal/cutover smoke.
