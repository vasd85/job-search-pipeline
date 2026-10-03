# Vacancy capture policy

The acting half of
[ADR 0012](../docs/adr/0012-versioned-extraction-and-vacancy-v2.md). That record is the decision —
its context, its rejected alternatives, its migration narrative — and is read when the decision
itself is questioned, not to find out what to do. This file is what a task acts on.

Identity is not decided here: [source-key-policy.md](source-key-policy.md) owns it, and the capture
records URLs as observations and derives no key from any of them.

The two halves below differ in kind. The first binds code that exists. The second is a contract over
work that has not started — `source-capture.json` is in no module, the ledger validator accepts
`vacancy.json` at schema version 2 only, and the private extraction-v2 epic is paused. A task that builds any of it inherits that contract and may not weaken it locally.

## What binds today

Every bounded set below has one machine owner. Read the module, never a prose copy of it.

| Rule                                                      | Owner                                                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Bounded outcome names and their retryability              | `failureRetryability`, `statusVocabulary` in `tools/job-sources/routes.mjs`                  |
| The access-barrier axis and the direct-route status table | `outcomeNames`, `accessBarriers`, `classifyDirectRoute` in `tools/vacancy-fetch/outcome.mjs` |
| The response-header allowlist                             | `recordedResponseHeaders` in `tools/vacancy-fetch/transport.mjs`                             |
| The URL rule                                              | `serverSuppliedUrl`, `requestedUrl` in `tools/vacancy-fetch/url-rule.mjs`                    |
| The triage-lane tool applying them                        | [tools/vacancy-fetch/README.md](../tools/vacancy-fetch/README.md)                            |

**The URL rule.** A server-supplied URL — every redirect hop, the final URL when it differs from
the requested one, any location header — is recorded as origin and path. The requested URL keeps
origin, path and query; narrowing it would silently change process identity. The fragment is
dropped from both. One residual is named rather than implied: a token embedded in a path survives
this rule everywhere.

**Response headers are a bounded allowlist, never the raw header set.**

Three boundaries the modules do not state on their own:

- **The status table governs a direct posting route.** An aggregate route keeps the selection rules
  the integrated outcome decision froze.
- **A wall is never a terminal verdict, whatever status carries it.** `authentication` is defined
  by the wall — a credential, consent or membership wall on any route, including the posting route
  itself — and not by the status. The table reaches it from a `401` or `403`, and the
  implementation reaches the same verdict for a wall page arriving under any other status, reading
  that case through the reasoning of the anti-bot row rather than the `404` row: `404` is the route
  that answers for one posting saying it is gone, and a wall page is a different page.
- **One condition keeps one name across the pipeline.** `active` carries no failure diagnostic in
  the ledger and is the triage layer's `usable`; `absent`, `closed` and `private` are a
  non-retryable ledger unavailability and the triage layer's `closed`, with the observed symptom or
  status quoted; `access_failure` with any barrier is a retryable ledger fetch failure and the
  triage layer's `technical_unavailable`. The triage vocabulary keeps its three values and this
  policy does not widen it.

Three earlier decisions are inherited and never re-derived or reversed here:

- adapters bind to registry source ids, and the registry stays the single domain matcher — a second
  domain matcher is never reintroduced;
- the Notion route is unsupported and names no helper that does not exist;
- the outcome names collapse on purpose: one real condition carries exactly one name, a status
  outside the vocabulary stays `active` rather than becoming a failure, and only an access failure
  is retryable.

## The contract epic 003 inherits

### The capture

Every supported source is served by a typed adapter returning one immutable result: adapter id and
version, registry source id, the URLs under the rule above, HTTP status, content type and charset,
capture timestamp, the byte count and digest of the exact response body, the ordered visible
description blocks with stable ids, the typed facts referencing those block ids, the outcome, the
allowlisted headers, and bounded diagnostics that never carry the response body or a secret.

That result is published as a fourth Step 1 artifact, `source-capture.json`, at schema version 1,
in the reserved output directory, with an explicit maximum size and a bounded block count. Its
basename joins the reserved canonical set: a canonical basename is declared and never discovered by
extension. It is never web-readable, and it is mandatory for every Step 1 publication that has an
adapter — including a reopen of a process that never had one.

**Authorship is structural, not proven.** The extractor writes the capture into the publication
staging directory itself, during the fetch, and no command exposes an interface that accepts capture
content from a caller, so the procedure offers no supported way to author one. It does not stop an
actor who writes arbitrary bytes into the staging directory — the same-UID filesystem residual
[ADR 0011](../docs/adr/0011-untrusted-input-safe-cli-transport.md) records as out of scope.

**The capture keeps no raw response body** — only its digest and byte count. Named consequence:
block extraction cannot be re-audited from the published bundle, only re-run.

### Render and evidence

`job-description.txt` is the output of a deterministic render over the capture's ordered blocks,
never authored, retyped, summarized or reordered by a model. The render rule is part of the
contract: blocks are emitted in capture order with no reordering, insertion or removal; exactly one
blank line separates one block from the next; the file ends with exactly one newline; the text is
NFC-normalized UTF-8 with HTML entities already resolved; no agent narration and no structured
metadata appear.

The description is accepted only when the render of the capture blocks is byte-identical to the
published file. A fact that quotes the source is accepted only when its recorded text is an exact
substring of the block it references. A fact that normalizes rather than quotes is accepted only
with a resolvable reference plus its quoted evidence: the machine proves the quote exists and is
unaltered, and whether the normalization is correct stays a named human review item, never reported
as proof.

None of this closes an adapter that mis-parses a real page. That residual belongs to frozen
per-source fixtures and to a live smoke.

### The extraction version of the vacancy

The extraction version is the next free schema version of `vacancy.json`: version 2 is taken by the
configured market ([ADR 0025](../docs/adr/0025-markets-are-candidate-configuration.md)), and the
current version is the one this delta is built over. Relative to the current version: a `provenance`
block carrying the adapter, the registry source id, the capture reference with its digest and byte
count, the URLs, the status, the content type and the timestamp; `process.finalUrl` bound to the
capture's final URL, with disagreement an error; section headings as references to block ids plus
the exact heading text, so a heading absent from the source is rejected; an evidence reference on
every feasibility and identity fact and the exact quoted text on every quotation; the outcome, and
the access barrier when the outcome is a failure; `schemaVersion` as the only version marker, set to
the extraction version. Bundles of the current version stay readable and revalidatable under the
current contract.

### When only the generic rendered fallback can read a posting

Such a run has no adapter, so no verified extraction stage and no independent evidence that the
description matches the source. **One choice here is product policy and is the user's alone:**
publish the outcome as blocked and require an adapter, or publish as completed only with an explicit
human attestation recorded on the process. Until the user answers, dependent tasks build everything
else and leave this branch unbuilt; an answer is never inferred from silence, and the executor may
not settle it.

Already decided, and not part of that question: such a run never publishes a silent completed
outcome and is never presented as source-verified. The mandatory-capture rule needs an exemption for
a run with no adapter, and which exemption it gets follows the user's answer.

### Cutover and rollback

A process started after the release publishes the extraction version; an existing process finishes
on its existing release. An existing process moves to the extraction version only through an
explicit reopen of Step 1, which marks its descendants stale in the ordinary way — research, brief,
CV and letter all go stale. There is no bulk migration, no silent upgrade and no adoption of an
existing bundle as a capture. Rollback is a release-level operation: revert the release and let
in-flight processes finish on the previous one; a published bundle of the extraction version is
never rewritten into the current version. Because a publication of the extraction version requires a
capture and a capture requires an adapter, the cutover is per-source in effect.

### What the implementing task also owes

- the ledger's per-kind schema check for the vacancy kind becomes an **accepted set**, not a scalar
  equality: a scalar refuses every existing record the moment the release lands;
- three obligations are pinned negatives rather than prose — that no command accepts capture content
  from a caller, which is the first to verify because the rest are worthless without it; that no
  header outside the allowlist reaches the capture; and that the capture never becomes web-readable;
- the runtime-readable Step 1 artifact table in [pipeline-artifacts.md](pipeline-artifacts.md) is
  deliberately left alone until the artifact set actually changes, and the implementing task updates
  it;
- the existing fixtures of the current version stay valid unedited and the negative one keeps
  producing the same errors; a set of the extraction version is added beside them.

### Guarantees with no owner

Uncontained rather than quietly assigned; a task relying on either says so rather than assumes:

- live route behaviour matching the frozen fixtures — a scheduled or manual smoke with no owner;
- honest presentation of a vacancy of the extraction version by the public reader, which would render
  an unsupported version as missing data.
