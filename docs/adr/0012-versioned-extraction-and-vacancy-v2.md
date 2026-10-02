# ADR 0012: Versioned extraction, source capture, and vacancy v2

- **Status:** Accepted; amended by [ADR 0025](0025-markets-are-candidate-configuration.md)
  (2026-09-24) — version 2 of `vacancy.json` is taken by the configured market, and the delta below
  lands under the next free version; and again under its decision 4 (2026-09-29) — the recorded
  version 1 vacancies were migrated in place into version 2 and the version 1 reader dropped, so
  every row and sentence below that keeps version 1 readable, revalidatable or never rewritten speaks
  of the version the delta is built over
- **Date:** 2026-08-13
- **Decision authority:** a separate `R2-01A` integration review

## Context

Step 1 promises the full visible job description "in source order and wording". Nothing in the
repository can check that promise. The published bundle carries a digest and a byte count for
`job-description.txt`, and the validator compares them to the bytes of that same file. Both sides of
that comparison are produced by the same actor in the same act, so the check proves internal
consistency and nothing about the source.

Two P1 findings follow from that gap and were reproduced again on the frozen base of this task,
against the shipped validator and the canonical Step 1 fixture:

- `EXTRACT-03` — the 499-byte fixture description was replaced with 40 fabricated bytes, the
  self-reported digest and size were recomputed over the fabricated bytes, and the production
  validator returned no errors and exited `0`.
- `VAL-03` — company, title, ATS, vacancy language, market, work model, locations, timezone overlap
  and every source heading were replaced with values that contradict the published description, and
  the production validator again returned no errors and exited `0`.

The same run proved the oracle was alive rather than broken: the untouched fixture validated, and
the same fabricated description without a refreshed digest failed with the exact two digest and size
errors. So the defect is not a missing check but a missing input — there is no record of what the
source actually returned.

Three further findings share that root. `EXTRACT-04` is that the per-platform recipes are prose
bullets rather than a typed adapter layer. `TEST-05` is that no test covers endpoints, redirects,
encoding, anti-bot barriers, deleted or private postings, or document order, and that the Step 1
fixtures author both the source bytes and the expectation. `EXTRACT-06` leaves the generic
rendered-page fallback without a contract.

This ADR freezes the technical decisions those tasks need. It changes no schema, no validator, no
lifecycle rule and no recipe. `R2-01D` and the per-source adapter tasks implement it.

## Already decided and not reopened here

Three decisions landed after the audit baseline. This ADR records them as settled so that no
dependent task re-derives or reverses them by accident.

| Decision | Closed by | This ADR |
| --- | --- | --- |
| Source domain identification is single-sourced through the registry; the duplicated policy-domain list is gone and company-domain mutation is fail-closed | `R1-04A` | Inherited unchanged. The extractor binds adapters to registry source ids; it never reintroduces a second domain matcher |
| The Notion route is unsupported and names no helper that does not exist; the two invented helper names are banned across every runtime-readable surface | `R1-04C` | Inherited unchanged. This ADR contracts the **generic rendered fallback** only, and does not restate the Notion recipe, whose exact wording is frozen by test |
| Bounded outcome names collapse deliberately: one real condition carries exactly one name, an unknown status stays active rather than becoming a failure, and only an access failure is retryable | `R1-04B` | Inherited unchanged, and extended only along a new orthogonal axis. See **Access and outcome taxonomy** |

The remaining halves of `EXTRACT-04` and `EXTRACT-06` — the typed adapter layer and the generic
fallback contract — are open and are what this ADR decides.

## Decision

Step 1 gains a machine-produced capture, and the published description becomes a deterministic
function of it rather than a transcription of it.

1. Every supported source is served by a typed adapter that returns one immutable `ExtractorResult`.
   The result carries the adapter id and adapter version, the registry source id, the requested URL,
   the ordered redirect chain and the final URL — all three under the URL rule below — the HTTP
   status, the content type and charset, the capture timestamp, the byte count and digest of the
   exact response body, the ordered visible description blocks with stable ids, the typed
   feasibility and identity facts with references into those block ids, the outcome, and bounded
   diagnostics that never carry the response body or a secret. Response headers are carried as a
   bounded allowlist — content type, content encoding, content length, last modified, ETag,
   retry-after, the challenge scheme of an authentication header without its parameters, and a
   location value narrowed by the URL rule below, which matters for a `3xx` at the redirect ceiling
   and for a `201` or `202` that carries one — and never as the raw header set, because a raw set
   carries session cookies and authorization values into a published artifact for no fidelity
   benefit. The allowlist is not arbitrary: content encoding is there because the body digest below
   is taken over the bytes as received on the wire, and the authentication scheme is there because
   it is the evidence for the wall the status table classifies. This is a deliberate narrowing of
   the epic's "exact raw header fields" bullet and is recorded as such rather than dropped.
2. **The URL rule.** Every URL the capture records is recorded under one rule, because a redirect
   target is a place a secret arrives without anyone choosing to write it down. A **server-supplied**
   URL — every hop of the redirect chain, the final URL when it differs from the requested one, and
   any location header — is recorded as origin and path, with the query string and the fragment
   dropped: an authentication redirect routinely carries a code, a state value, a signed-URL token or
   an implicit-grant access token in exactly those two parts. The **requested** URL keeps its origin,
   path and query, because the ledger's identity key is computed from exactly those and narrowing
   them would silently change process identity, which belongs to `R2-01B`. Its fragment is dropped
   too: the key computation already discards it, so nothing depends on it, and it is where an
   implicit-grant token lands. One residual is named rather than implied: a token embedded in a path
   survives this rule everywhere.
3. That result is published as a fourth Step 1 artifact, `source-capture.json`, and it is never
   web-readable. Its authorship is **structural, not asserted, and not proven**. The extractor code
   path writes the capture into the publication staging directory itself, during the fetch, and no
   command exposes an interface that accepts capture content from a caller. An agent following the
   procedure therefore has no supported way to author one. The publication path then verifies the
   staged bundle against that capture and refuses it otherwise, which keeps publication offline and
   leaves the ledger's digests computed from staged bytes exactly as they are today. What this does
   **not** do is prove authorship: an actor able to write arbitrary bytes into the staging directory
   can still fabricate a self-consistent capture and description. That is the same-UID filesystem
   adversary ADR 0011 already recorded as out of scope, and this ADR does not close it. The whole
   fidelity argument below is exactly this strong and no stronger.
4. `job-description.txt` becomes the output of a deterministic render over the capture's ordered
   blocks. It is not authored, retyped, summarized or reordered by a model.
5. `vacancy.json` becomes schema version 2. Every identity and feasibility fact it records carries a
   reference to the capture block that supports it, and every fact that is a quotation carries the
   exact quoted text.
6. A source that no adapter serves is handled by the generic rendered fallback, which never
   publishes a silent completed outcome. See **Open decisions that require the user** for the part
   of that rule the agent may not choose.

## Capture and the two-stage fidelity chain

The value of a capture is exactly the independence it buys, and it buys less than the word suggests.
Stating that precisely is the point of this section, because a capture whose digest is written by
the same run that wrote the description is the defect of `EXTRACT-03` with one more file.

The chain from the live posting to a published fact has two stages with different owners and
different strengths.

**Stage A — response bytes to ordered blocks.** Performed by a per-source adapter. It is *not*
verified per run: nothing in a local run can know what the live page really said. It is verified
per source, offline, by frozen fixtures that pin one captured response to one expected block
sequence. A fixture is synthetic unless its own bytes say otherwise, and a synthetic fixture pins
this repository's parsing contract, not the behaviour of the outside world.

**Stage B — ordered blocks to published bytes and published facts.** Verified per run, by
recomputation rather than by a report:

- the description is accepted only when `render(capture.blocks)` is byte-identical to the published
  `job-description.txt`. The two compared values are a function of the capture and the published
  file; neither is a number an agent typed;
- a fact that quotes the source is accepted only when its recorded text is an exact substring of the
  capture block it references. Source headings, work-model source text, location strings,
  compensation strings and the vacancy language evidence are all of this kind;
- a fact that normalizes rather than quotes — market, normalized work model — is accepted only with
  a resolvable reference plus its quoted evidence. The machine proves the quote exists and is
  unaltered. Whether the normalization of that quote is correct stays a named human review item and
  is never reported as proof.

The render rule is part of the contract, because "same order and wording" is otherwise unfalsifiable:
blocks are emitted in capture order with no reordering, no insertion and no removal; each block is
separated from the next by exactly one blank line; the file ends with exactly one newline; text is
NFC-normalized UTF-8 with HTML entities already resolved during Stage A; no agent narration and no
structured metadata appear.

What this closes and what it does not:

- `EXTRACT-03` is closed against a fabricated, truncated or reordered description **produced through
  the ordinary Step 1 path**, because the published bytes must be a render of a capture the
  procedure gives no way to author. It is not closed against an actor writing arbitrary bytes into
  the staging directory: a fabricated capture beside a fabricated description agrees with itself
  perfectly, and only the structural authorship of decision 3 stands between the two cases;
- `VAL-03` is closed against invented quoted facts on the same condition and with the same limit,
  because a quotation that is not in the capture is rejected;
- neither is closed against an adapter that mis-parses a real page. That residual is owned by the
  frozen per-source fixtures of the adapter tasks and by a scheduled or manual live smoke, and it is
  named here rather than left to be discovered.

Capture bounds: `source-capture.json` retains the transport record, the ordered blocks and the
digest and byte count of the raw response body. It does **not** retain the raw response body itself.
The raw body is unbounded, untrusted content, and keeping it in the reserved output directory would
widen the hostile-content surface of every later reader for a benefit the frozen fixtures already
provide offline. The consequence is named: after the fact, block extraction cannot be re-audited
from the published bundle alone.

## Vacancy v2 delta

Relative to version 1, version 2:

- adds `provenance` with the adapter id and version, the registry source id, the capture reference
  including its digest and byte count, the requested URL, the ordered redirect chain and the final
  URL as the URL rule of decision 2 records them,
  the HTTP status, the content type and charset, and the capture timestamp;
- binds `process.finalUrl`, which version 1 never cross-checks against anything, to the final URL of
  the capture, and makes disagreement an error;
- replaces free-text section headings with references to capture block ids plus the exact heading
  text, so a heading that is not in the source is rejected;
- requires an evidence reference on every feasibility and identity fact, and the exact quoted text
  on every fact that is a quotation;
- records the outcome and, when the outcome is an access failure, the access barrier defined below;
- keeps `schemaVersion` as the only version marker and sets it to `2`.

Version 1 bundles stay readable under the version 1 contract, unchanged and revalidatable. Version 2
is required only for publications made after cutover.

## Access and outcome taxonomy

The five bounded outcome names and their retryability are inherited from `R1-04B` **unchanged**:
`active`, `absent`, `closed`, `private`, `access_failure`, of which only `access_failure` is
retryable. The deliberate collapses stay: a posting that was deleted, retired, expired, filled,
drafted or unpublished is `closed`; a posting that is confidential, internal, restricted or unlisted
is `private`; a status outside the bounded vocabulary stays `active` on purpose, because refusing an
unknown status turns a live vacancy into a failure.

The epic also names archived, deleted and anti-bot outcomes. Archived and deleted are already
answered: the integrated vocabulary carries both as `closed`, and promoting either to its own
outcome name would give one real condition two names, which that decision forbids for a stated
reason. Only anti-bot is genuinely unrepresented today, and it belongs to a second, orthogonal axis
rather than to the outcome names.

`accessBarrier` is recorded only when the outcome is `access_failure`, and every value is retryable,
because a barrier describes why a fetch did not complete and never asserts that a posting is gone:

| `accessBarrier` | Meaning |
| --- | --- |
| `network` | The transport did not complete |
| `http_status` | A status that says only that this fetch failed — never one the status table below maps to a terminal outcome |
| `unparseable` | The response loaded but its shape is unknown, including an aggregate holding no postings |
| `authentication` | A credential, consent or membership wall, on any route, including the posting route itself |
| `anti_bot` | A challenge, interstitial or block page instead of the posting, whatever status carries it |
| `rate_limit` | The source refused for volume reasons |

A terminal verdict is never derived from a barrier. This is the fail-safe direction the audit's Step
1 findings repeatedly required: an uncertain outcome stays retryable.

Because a barrier is retryable and an outcome may be terminal, the boundary between them cannot be
left to each adapter. A direct posting route resolves its HTTP status here, once:

The rows are ordered and the first match wins, so no observation resolves twice:

| Observed on a direct posting route | Outcome | Barrier | Why |
| --- | --- | --- | --- |
| A challenge, interstitial or block page, at any status | `access_failure` | `anti_bot` | A block page is not a posting, and the status it arrives under says nothing about the posting |
| `404`, `410` | `absent` | none | The posting is gone from a route that answers for exactly one posting. This is the case the triage layer already treats as terminal after a retry |
| `401`, `403`, on any route | `access_failure` | `authentication` | A wall states what this reader may see, never whether the posting exists. A live posting behind a sign-in or bot wall is a case this repository has already observed, so the fail-safe direction is mandatory here |
| `429` | `access_failure` | `rate_limit` | Volume, not availability |
| `5xx`, transport failure, timeout | `access_failure` | `network` or `http_status` | The source did not answer |
| `200` carrying a first-party status word the bounded vocabulary maps to closed | `closed` | none | The source said so, in its own words |
| `200` carrying a first-party status word or listing flag the bounded vocabulary maps to private | `private` | none | The source said so. Only a first-party statement makes a posting private; an HTTP status never does |
| `200` with a posting body | `active` | none | The posting is there |
| Any other status, or a body of unknown shape | `access_failure` | `unparseable` | Fail retryable, never terminal, on incomplete information |

Two properties of that table are the point of writing it down. A terminal unavailability verdict —
`absent`, `closed` or `private` — is reachable only from what the source states in its own words, or
from a `404`/`410` on a route that answers for one posting; apart from that single carve-out, no HTTP
status alone ever produces one. And every uncertain observation lands on `access_failure`, which is
retryable.

An aggregate route keeps the selection rules the integrated decision already froze; the table above
governs the direct routes, which have no aggregate status field to fall back on and are exactly
where the adapters would otherwise each invent an answer.

Mapping to the vocabularies that already exist, so that one condition keeps one meaning across the
pipeline:

| This ADR | Ledger diagnostic today | Triage vocabulary today |
| --- | --- | --- |
| `active` | no failure diagnostic | `usable` |
| `absent` | non-retryable unavailability | `closed`, with the observed symptom quoted |
| `closed` | non-retryable unavailability | `closed`, with the observed status quoted |
| `private` | non-retryable unavailability | `closed`, with the observed status quoted |
| `access_failure` with any barrier | retryable fetch failure | `technical_unavailable` |

The triage vocabulary keeps its three values; this ADR does not widen it. `R2-05A` owns whether the
barrier reaches a decision trace.

## Compatibility matrix

Every artifact version, ledger version, identity element and lifecycle transition that exists today
has a row. Rows that this ADR does not touch say so explicitly rather than being omitted.

### Artifact versions

| # | Item | Today | Under this ADR | Owner |
| ---: | --- | --- | --- | --- |
| 1 | `vacancy.json` v1 | The only accepted value | Stays readable and revalidatable under the v1 contract; never rewritten in place | `R2-01D` |
| 2 | `vacancy.json` v2 | Does not exist | Introduced with the delta above | `R2-01D` |
| 3 | v1 to v2 | Not applicable | Only by an explicit reopen of Step 1 after cutover; never automatic, never bulk | `R2-01D` |
| 4 | v2 to v1 | Not applicable | Not supported. A v2 bundle is never downgraded; the rollback path is Git revert of the release plus finishing in-flight processes on the previous release | `R2-01D` |
| 5 | Ledger artifact pin for the vacancy kind | Asserts equality with a single schema number | Must accept the set of both versions; a scalar equality would refuse every existing record the moment the new release lands | `R2-01D` |
| 6 | `job-description.txt` | Unversioned; null schema version in ledger metadata; the reference inside the vacancy omits a version | Stays unversioned. Its version is implied by the vacancy that references it | `R2-01D` |
| 7 | Render determinism across versions | Not defined | A v2 render of the same blocks is not guaranteed byte-identical to a v1 hand transcription. Reopening therefore republishes description bytes, which is a real change and is why reopen is explicit | `R2-01D` |
| 8 | `source-capture.json` | Does not exist | New Step 1 artifact kind, schema version 1, in the reserved output directory, with an explicit maximum size and a bounded block count. Its basename joins the reserved canonical set, which today lists six names, because a canonical basename is declared and never discovered by extension | `R2-01D` |
| 9 | Capture web-readability | Not applicable | Must stay out of the public reader's artifact allowlist. Unknown kinds are skipped today, so this holds by default and must be pinned rather than assumed | `R2-01D` |
| 10 | `company-research.json` v1 | Current | Not applicable — owned by `R2-02A` | `R2-02A` |
| 11 | `application-brief.json` v3, with v1 and v2 explicitly refused | Current | Not applicable to the brief itself. It is cited as the repository's only worked multi-version reader and is the pattern the vacancy dispatch follows | `R2-03P` |
| 12 | `cv.json` | Unversioned | Not applicable | `R2-04B` |
| 13 | The CV document, whose basename is frozen at first publication | Current | Not applicable | `R2-04B` |
| 14 | `cover-letter.txt` | Unversioned | Not applicable | `R2-04C` |
| 15 | Triage normalized input v1 | Current | Not applicable to this ADR. Whether a v2 vacancy or an access barrier forces a new normalized-input version is decided by `R2-05A`, which depends on this ADR | `R2-05A` |
| 16 | Existing vacancy fixtures | Three valid v1 bundles plus one frozen negative bundle, reaching eleven suites directly or through the shared producers | The three valid bundles stay valid under the v2 reader without edits, and the negative bundle keeps producing the same errors; a separate v2 fixture set is added beside them | `R2-01D` |

### Ledger schema and artifact metadata

| # | Item | Today | Under this ADR | Owner |
| ---: | --- | --- | --- | --- |
| 17 | Ledger schema v3 | Current and enforced | A new artifact kind does not change the ledger schema number. If per-record source-key versioning later demands one, that is `R2-01B`'s event, not this ADR's | `R2-01D` |
| 18 | Ledger schema v2 | Refused by the v3 ledger | Not applicable — remains dead | none |
| 19 | The shipped v1-to-v2 ledger migrator | Still present | Not applicable — untouched | none |
| 20 | Bundle entry shape | Fixed key set per artifact entry | Unchanged. The capture is a new entry, not a new field | `R2-01D` |
| 21 | Per-kind schema equality | Strict equality | Becomes a per-kind accepted set for the vacancy kind only | `R2-01D` |
| 22 | Artifact mode | Must be file-backed | Not applicable — unchanged | none |
| 23 | Artifact digests and byte counts in the ledger | Computed by the lifecycle from staged bytes, not accepted from the caller | Unchanged, and deliberately so: this is already the one place where the number is not self-reported, and the capture inherits it | `R2-01D` |
| 24 | Mandatory artifact descriptors at publication | Every contract artifact with a fixed path is mandatory for every publication of its step | Adding the capture makes it mandatory for **every** Step 1 publication that has an adapter, including a reopen of a process that never had one. A no-adapter run cannot satisfy it, and which exemption it gets depends on the open user decision below | `R2-01D` |
| 25 | `finalUrl` | Nullable, never cross-checked | Bound to the capture's final URL in v2; unchanged for v1 | `R2-01D` |

### Identity and source keys

| # | Item | Today | Under this ADR | Owner |
| ---: | --- | --- | --- | --- |
| 26 | `source_key` has no version field | Current | Not applicable — owned by `R2-01B`. This ADR deliberately records no capture-derived identity, so that it cannot pre-empt that decision | `R2-01B` |
| 27 | Source reference normalization semantics | Frozen | Not applicable — unchanged here. Changing its meaning under the same version is forbidden by the plan's own rule | `R2-01B` |
| 28 | Tracking parameters stripped from the key, including meaningful ones | Current | Not applicable — the correction is `R2-01B`'s scope | `R2-01B` |
| 29 | Duplicate detection by source key | Current | Not applicable — unchanged | `R2-01B` |
| 30 | Legacy source-key collision containment | Integrated, read-only, reports rather than migrates | Not applicable — unchanged, and must not be contradicted | `R2-01B` |
| 31 | Historical source references are immutable | Current | Not applicable — unchanged | none |
| 32 | Historical source-key canonicality is enforced on load for historical records too | Current | Named as an inherited constraint for `R2-01B`: any normalization change invalidates the historical corpus at load time, so it is a ledger-schema event and not a local edit | `R2-01B` |

### Historical records

| # | Item | Today | Under this ADR | Owner |
| ---: | --- | --- | --- | --- |
| 33 | Imported web-application provenance is historical-only | Enforced | Not applicable — a historical record can never own a file-backed artifact, so it can never carry a capture or a v2 vacancy | none |
| 34 | Historical versus file-backed record classification | Enforced | Not applicable — unchanged | none |
| 35 | Imported historical source-reference grammar is not a URL | Current | Not applicable — unchanged. Named because it does not pass through URL normalization | `R2-01B` |
| 36 | Historical records are read-only | Enforced | Not applicable — a historical process cannot be reopened into v2 | none |

### Reopen, staleness and descendants

| # | Item | Today | Under this ADR | Owner |
| ---: | --- | --- | --- | --- |
| 37 | Reopen precondition: the step is completed or stale | Enforced | Unchanged; it is the only door to v2 | `R2-01D` |
| 38 | Reopen is refused while a dependent step is running | Enforced | Unchanged | `R2-01D` |
| 39 | Reopen marks completed descendants stale | Enforced | Named as the real cost of moving one process to v2: research, brief, CV and letter all go stale. The default of finishing a started application on its existing release stands | `R2-01D` |
| 40 | Input snapshots carry the schema version of each input | Current | A v1-to-v2 change alters the snapshot for the research and mapping steps, which is exactly what makes their staleness visible instead of silent | `R2-01D` |
| 41 | Downstream steps fail closed on a stale prerequisite | Enforced | Unchanged and relied upon | `R2-01D` |
| 42 | Step dependency graph | Fixed | Unchanged. The mapping step reads both Step 1 and Step 2, so a v2 vacancy reaches it through two edges | `R2-01D` |
| 43 | Public reader presentation of a vacancy | Renders by artifact kind with no version check | **Uncontained.** A v2 body would render as missing data rather than as an unsupported version, and no queue row in this lane holds the web presentation lock. Named as uncontained rather than assigned to a task that cannot act | none today |

### Routes and outcomes

| # | Item | Today | Under this ADR | Owner |
| ---: | --- | --- | --- | --- |
| 44 | Machine route facts cover two of nine sources | Current | Each remaining source gains an adapter in its own task, in the order the epic fixes; the unstable demand-only routes stay a placeholder that must be replaced by separate tasks before activation | `R2-01D`, `R2-01H`, `R2-01I`, `R2-01J`, `R2-01K`, `R2-01L`, `R2-01F` |
| 45 | Route facts carry an observation date but no version | Current | Adapter id and adapter version become part of the capture, which is what lets one adapter degrade without the others | `R2-01D` |
| 46 | Outcome vocabulary and retryability | Frozen by an integrated task | Unchanged; extended only by the orthogonal barrier axis | `R2-01D` |
| 47 | Live-route verification | Assigned to a release gate that has since completed and explicitly disclaimed it | **Uncontained.** Restated here as a scheduled or manual live smoke with no current owner rather than left attached to a closed gate | none today |

### Capture integrity

| # | Item | Today | Under this ADR | Owner |
| ---: | --- | --- | --- | --- |
| 48 | Who may write a published artifact | Every candidate is read from bytes the agent staged, so authorship is not a property the publication path can distinguish | The extractor writes the capture into staging itself and no command accepts capture content from a caller, so the procedure offers no way to author one. This is structural, not proven: an actor writing arbitrary staged bytes defeats it, and that actor is ADR 0011's same-UID residual | `R2-01D`, as a pinned negative on the absent interface |
| 49 | Response headers in the capture | Not recorded anywhere | A bounded allowlist rather than the epic's raw header set, so that no header value beyond it, and no URL outside the URL rule, reaches a published artifact. It carries content encoding, because the body digest is over the bytes as received, and the authentication scheme, because the status table classifies on it | `R2-01D` |
| 50 | URLs in the capture | `finalUrl` is a whole URL and nothing narrows it; no redirect chain is recorded at all | One rule for all of them: a server-supplied URL keeps origin and path, and the requested URL stays whole because process identity keys on it. A path-borne token and a secret inside the requested URL are named residuals, not claims | `R2-01D` |

## Cutover and rollback

- A new process started after the release publishes v2. An existing process finishes on its existing
  release by default.
- An existing process moves to v2 only through an explicit reopen of Step 1, which invalidates its
  descendants in the ordinary way. There is no bulk migration, no silent upgrade and no adoption of
  an existing bundle as a capture.
- Rollback is a release-level operation: revert the release and let in-flight processes finish on the
  previous one. A published v2 bundle is never rewritten into v1.
- The operational checkout receives the release only through the intentional cutover procedure, whose
  own preconditions are unchanged by this ADR.
- Because a v2 publication requires a capture, and a capture only exists where an adapter exists,
  the cutover is per-source in effect: a source with no adapter continues through the generic
  fallback and cannot publish v2.

## Relationship to ADR 0010

ADR 0010 froze the file-backed artifact contract and lists the canonical artifact of each step. That
list was complete when it was written and is not complete afterwards. This ADR extends exactly two
of its rows: it adds a fourth Step 1 artifact, and it changes the vacancy schema version from a
single accepted number into a set. Everything else in ADR 0010 — staging and publication, recovery,
the rule that a staging directory is never a canonical artifact and never web-readable, the
one-way ledger cutover — is inherited unchanged. A pointer in ADR 0010 names this ADR so that a
reader of the older table learns that Step 1's artifact set moved on.

## Boundary with `R2-01B` and the dependent adapter tasks

This ADR decides capture, render and fact evidence. It decides nothing about process identity.
Specifically, the capture records the requested URL, and the redirect chain and final URL narrowed
by the URL rule of decision 2, as
observations, and no identity key is derived from any of them here. Source-key versioning,
normalization semantics, the collision report and the migration path belong to `R2-01B` and
`R2-01C`, which hold the locks over that code.

`R2-01B` has since answered those rows in
[ADR 0013](0013-versioned-source-keys-and-identity-migration.md), from whatever status that record
currently carries. It answers matrix rows 26 to 30, row 32 and row 35 here — row 31 admits no owner and is not that record's to answer — and it corrects one of them:
row 35 states that the imported historical source-reference grammar is not a URL, which is true only
of the synthetic fallback. The importer prefers a first-party URL and then a URL extracted from the
message text, so imported records do pass through normalization, and a normalization change therefore
reaches an immutable corpus. That correction is recorded there rather than by rewriting a row of this
accepted record.

`R2-01D` implements the extractor core and one reference adapter. Each further adapter is its own
task so that a single source can degrade without the others. An adapter task inherits this contract
and may not weaken it locally.

## Verification owners

Every guarantee stated above, with the task that must prove it. A guarantee with no owner is written
as uncontained, not quietly assigned.

| Guarantee | Verified by |
| --- | --- |
| No command accepts capture content from a caller, so the ordinary procedure cannot author a capture | `R2-01D`, as a pinned negative. This is the first guarantee to verify: every row below is worthless without it, and it is structural rather than proven |
| The published description is a byte-identical render of the capture blocks | `R2-01D`, per run and by test |
| A fabricated, truncated or reordered description is refused | `R2-01D`, negative tests derived from this task's reproduction probe |
| A quoted fact that is not in the capture is refused | `R2-01D` |
| Each status in the table maps as the table says, and no barrier is terminal | `R2-01D`, plus one fixture per status per direct-route adapter. That the table is total and disjoint is argued, not proven |
| The capture carries no header outside the bounded allowlist | `R2-01D`, as a pinned negative |
| Response bytes map to the correct ordered blocks for a given source | Frozen per-source fixtures in `R2-01D`, `R2-01H`, `R2-01I`, `R2-01J`, `R2-01K`, `R2-01L` |
| One adapter can fail without disabling the others | Each adapter task |
| Existing v1 bundles stay readable | `R2-01D`, against the existing fixtures |
| The capture never becomes web-readable | `R2-01D`, as a pinned negative |
| The outcome vocabulary and retryability are unchanged | `R2-01D` |
| Identity and source keys are unaffected | `R2-01B` |
| Live route behaviour matches the frozen fixtures | **Uncontained** — a scheduled or manual smoke with no current owner |
| A v2 vacancy is presented honestly by the public reader | **Uncontained** — no row in this lane holds that lock |

## Open decisions that require the user

One choice in this design is product policy, not technical design, and is deliberately left open.
The agent may not settle it, and the integration review may not settle it either.

**What happens when only the generic rendered fallback can read a posting.** Such a run has no
adapter, therefore no verified Stage A, therefore no independent evidence that the description
matches the source. Both candidate rules keep the honesty floor and differ in who pays:

- publish the outcome as blocked and require an adapter before the application proceeds — the pipeline
  stays provably honest and the user cannot apply through an unsupported source;
- publish as completed only with an explicit human attestation recorded on the process — the user can
  proceed on any source, at the cost of personally standing behind the fidelity of that description.

What is already decided, and is not part of the question: such a run never publishes a silent
completed outcome, and it is never presented as source-verified.

Until the user answers, dependent tasks implement everything else and leave this branch unbuilt.

## Rejected alternatives

- **Keep prose recipes and only strengthen the validator.** Rejected: no validator can compare a
  description against a source it never saw. This is the exact configuration in which both P1
  findings reproduce today.
- **Record a second self-reported digest, or a capture receipt carrying only hashes.** Rejected: two
  numbers written by the same run over the same bytes are one self-report with an extra file. The
  reproduction probe in this task defeats that design without modification.
- **Store the raw response body as the canonical description.** Rejected: it is untrusted content of
  unbounded size, it violates the rule that the description carries no structured metadata, and it
  hands hostile bytes to every later reader.
- **Make the capture web-readable.** Rejected: it contradicts the inherited rule that capture-like
  material is never web-readable, and it enlarges the untrusted-content surface of the local reader
  for no verification benefit.
- **Redefine vacancy v1 in place instead of versioning.** Rejected: it changes the meaning of a
  schema under its existing number, and it breaks the revalidation that Step 3 performs on
  already-published bundles.
- **Keep the capture in the transaction staging area.** Rejected: staging is transaction-scoped and
  legitimately removable, so it cannot back a durable guarantee.
- **One module serving all nine sources.** Rejected: it defeats the requirement that a single source
  can degrade independently, which is the main operational lesson of the route hotfixes.
- **Add archived, deleted and anti-bot as new outcome names.** Rejected for archived and deleted: the
  integrated vocabulary already carries both as a closed posting, and a second name for one condition
  reverses that decision for no gain. Accepted in substance for anti-bot only, on the orthogonal
  barrier axis, where it cannot make anything terminal.
- **Let the capture be one more artifact the procedure tells an agent to write.** Rejected: it would
  be authored by the same actor as the description it is supposed to check, and the reproduction
  probe in this task defeats that arrangement by writing one extra file.
- **Have the publication path re-fetch the source to write the capture itself.** Rejected although it
  would give a stronger authorship guarantee: it puts network access inside the ledger transaction,
  fetches the posting a second time with no rule for a page that changed in between, and has no
  answer for a blocked publication, a reopen or a crash recovery. The structural arrangement in
  decision 3 is weaker and honest about being weaker.
- **Record the raw response headers, as the epic's target contract literally asks.** Rejected as
  written: a raw header set carries session cookies and authorization values into a published
  artifact that outlives the run, against a fidelity benefit of zero. Replaced by a bounded
  allowlist, which is a narrowing of the epic and is recorded as one.
- **Leave the HTTP status to each adapter.** Rejected: six adapter tasks resolving the same status
  independently is how one real condition acquires six names. The status table decides it once.
- **Make an unknown status a failure.** Rejected: it converts a live vacancy into a terminal
  unavailability, which is the harm class the Step 1 findings are about.
- **Live network probes inside the deterministic gate.** Rejected: they make the gate
  non-deterministic; live behaviour belongs to a scheduled or manual smoke.

## Containment

This document decides. It proves nothing on its own, and the following limits are part of the
decision rather than an apology for it.

- No code, schema, validator, recipe or lifecycle rule changes in this task. Every guarantee above is
  a claim about a future implementation.
- The fidelity chain is verified per run only from the capture onward. What the live posting actually
  said is outside any local check, and the per-source fixtures that stand in for it are synthetic
  until a captured, provenance-carrying fixture replaces them.
- Two guarantees have no owner today and are written as uncontained: live route verification, whose
  previous owner is a completed gate that disclaimed it, and honest presentation of a v2 vacancy in
  the public reader, whose lock no row in this lane holds.
- Whether the ADR's compatibility matrix is semantically complete cannot be proven by any check in
  this repository. It was graded against a required-row inventory produced from the code by a
  reviewer who did not draft the document, which reduces the risk without removing it.
- The whole fidelity argument stands on decision 3's structural authorship, which is an arrangement
  rather than a proof: it removes the supported way to author a capture, and it does not stop an
  actor who writes arbitrary bytes into the staging directory. None of it exists yet, and until
  `R2-01D` builds it the findings of this ADR's context section remain open in running code, not
  merely undecided.
- A source that no adapter serves publishes through the generic fallback and has no capture at all,
  so the mandatory-artifact rule of matrix row 24 needs an exemption for those runs. Which exemption
  depends on the open user decision above, so it is named here and not decided.
- The machine pin over this document freezes its section list, its matrix row subjects, which rows
  decide and which defer, and a bounded set of literals. It does not freeze most verdict cells, so a
  verdict can be reworded without the test noticing. That is deliberate — freezing every cell would
  make any later correction a test failure — and it means the verdicts are the integration
  reviewer's responsibility, not the suite's.
- The runtime-readable Step 1 artifact table in the shared artifact contract is deliberately left
  untouched. It describes what Step 1 publishes today, and a fourth artifact that does not exist
  yet does not belong there until the artifact set actually changes. Whoever implements `R2-01D` updates it.
- A decision record is scanned for retired routes, for helper names that do not exist, for the
  reworded suffix shape and for source route templates, but it is still outside the frozen recipe
  literals and the operating contract's own prose bans. A paraphrase of a banned instruction can live
  in this file where it could not live in a skill.
- The generic-fallback branch stays undecided until the user answers, and dependent tasks must not
  infer an answer from silence.
