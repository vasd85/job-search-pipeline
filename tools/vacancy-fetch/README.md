# tools/vacancy-fetch — source-agnostic vacancy fetch layer

Disk-to-disk vacancy capture for the **triage lane**. It fetches a batch of vacancy URLs over
plain HTTP, extracts the visible text with a per-source adapter, runs one logged normalization
pass, and writes a hash-stamped capture file per vacancy plus one machine-readable manifest. The
model reads each page once, for extraction only; no job-description byte crosses a model context
on its way to disk.

This **is** the default transport for the triage lane. Every run carries a `--batch <label>` and
every manifest records `isDefaultTransport: true`; the rollout that got it here is owned by
[docs/runbooks/vacancy-fetch-experiment.md](../../docs/runbooks/vacancy-fetch-experiment.md).
The in-app browser stays the verified fallback, and `WebFetch` remains forbidden for vacancy pages.

## What it is not

- **Not the Step 1 publication path.** It reserves no output directory, touches no
  `process-log.json`, and publishes no `vacancy.json`, `job-description.txt` or
  `source-capture.json`. The typed extractor core, the vacancy v2 schema and the capture artifact
  of [ADR 0012](../../docs/adr/0012-versioned-extraction-and-vacancy-v2.md) are a separate lane
  (epic 003); this layer implements the ADR's **vocabularies** — the bounded outcome names, the
  access-barrier axis, the direct-route status table and the URL rule — for triage, and reuses
  them rather than inventing a second set.
- **Not a crawler.** One request at a time, a delay between requests, no discovery, no link
  following beyond HTTP redirects, no concurrency flag.
- **Not a fidelity proof.** A green fixture pins this repository's parsing contract. What a live
  page actually said is outside every local check; that is what the rollout runbook's measured
  comparison against the browser transport does, and no gate here reaches a live page.

## Invocation

Vacancy URLs are untrusted external values, so they never appear in shell program text. They
arrive through the canonical [ADR 0011](../../docs/adr/0011-untrusted-input-safe-cli-transport.md)
envelope.

The producer side is the one in
[instructions/pipeline-artifacts.md](../../instructions/pipeline-artifacts.md#safe-input-file-producer-procedure),
**steps 1 to 5** — the input root, the nonce, the exclusive create at mode `0600`, the closed file
before invocation, and the cleanup rule. Those steps are transport mechanics and apply unchanged
here. What does **not** apply is that section's compatibility table: it enumerates
`tools/process-log.mjs` subcommands, and this CLI is not one of them. The `values` shape this
command accepts is owned by [input-schema.mjs](input-schema.mjs) and by the envelope below.
That canonical procedure now scopes its steps 1 to 5 as transport mechanics for any repository CLI
and names this one, so `instructions/skills/score-jobs.md` invokes this command through those same
five steps:

```json
{
  "schemaVersion": 1,
  "command": "fetch",
  "nonce": "0123456789abcdef0123456789abcdef",
  "values": {
    "urls": ["https://…", "https://…"],
    "userAgent": "optional operator-owned override"
  }
}
```

```sh
node tools/vacancy-fetch/cli.mjs fetch \
  --input-file input-0123456789abcdef0123456789abcdef.json \
  --out-dir /absolute/working/directory \
  --batch 2026-08-18-batch-1 \
  --delay-ms 2000
```

The nonce above is illustrative; generate a fresh one per batch. `values.urls` holds 1 to 256
ordered references. `values.userAgent` is operator-owned configuration, not source data; it lives
in the envelope because a header string in shell text is the habit this transport exists to break.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--input-file` | required | controlled basename of the envelope inside `JOB_PIPELINE_INPUT_ROOT` |
| `--out-dir` | required | absolute, existing, non-symlink directory owned by the current user and not group/world-writable; refused when it already holds a manifest |
| `--batch` | required | bounded label `[a-z0-9][a-z0-9-]{0,63}`, stamped into the manifest; one token names the batch, the ledger `batch_id` and the output directory |
| `--delay-ms` | `2000` | pause between requests; never before the first |
| `--timeout-ms` | `20000` | per-request timeout |
| `--max-bytes` | `5242880` | response ceiling; a larger body is a retryable `unparseable` failure |
| `--max-redirects` | `5` | redirect ceiling |
| `--on-rate-limit` | `stop` | `stop` records the remaining links as unattempted; `continue` keeps going |

Exit codes: `2` at least one record needs the browser fallback, was left unattempted, or is a
usable record flagged `deferred_content_suspected` and therefore owes the browser one completeness
check; `1` a caller error, `0` none of those. `0` is not a promise that every record is usable: a
terminal `absent` record is neither usable, nor a fallback, nor flagged, so it moves none of those
counters — the browser load it owes is owed to the scoring procedure's own rule, not to this exit
code — and a batch of nothing but `404`s exits `0` with zero usable records. Stdout carries counts
and bounded codes only — never a URL, a title or page text, because that output is read by a model.

## What lands on disk

`NNN.capture.txt` per record whose body was persisted — which is not the same set as the usable
records, because a degraded record keeps its capture as evidence and is routed to the browser
anyway — and one `fetch-manifest.json`.

A capture file is a stamped header, a delimiter line, and the normalized body:

```text
# vacancy-fetch capture v1
# index: 1
# adapter: linkedin-guest@1
# …
# extracted-sha256: <digest of the text before normalization>
# normalized-sha256: <digest of the body below>
# body-bytes: <byte count of the body below>
# normalization: nbsp_to_space=12,collapse_blank_runs=3
#--- body ---
<the vacancy text>
```

`verifyCaptureFile` in [persist.mjs](persist.mjs) recomputes the digest and the byte count from
the file's own bytes, so a hand edit that forgot to restamp is detected. What this does **not**
prove is authorship: an actor able to write arbitrary bytes into the working directory can write a
self-consistent header beside fabricated text. That is ADR 0011's same-UID filesystem residual and
nothing here closes it.

The manifest is the machine-readable authority. Each record carries the adapter and its version,
the registry source id, the requested URL, the redirect chain and final URL under the URL rule, the
HTTP status, an allowlisted subset of response headers, the response digest and byte count, the
extraction and normalization digests, the full normalization log, the bounded outcome and access
barrier, the structural checks, bounded reason codes, and the `usable` / `fallback` verdicts.

The raw HTML is **not** kept. It is unbounded untrusted content, and keeping it would widen the
hostile-content surface of every later reader; the response digest and byte count anchor the chain
instead. The named consequence: block extraction cannot be re-audited from the working directory
alone, only re-run.

## Outcomes and the fallback signal

Outcome names, their retryability and the access-barrier axis are ADR 0012's and are imported from
`tools/job-sources/routes.mjs` rather than restated: `active`, `absent`, `closed`, `private`,
`access_failure`, of which only `access_failure` is retryable. A barrier is one of `network`,
`http_status`, `unparseable`, `authentication`, `anti_bot`, `rate_limit`, and never makes anything
terminal.

Two limits of the current adapter set are named rather than implied. **No adapter here can produce
`private`**: that verdict needs a first-party status word or listing flag, and neither the guest
fragment nor a generic page exposes one, so the row exists for a future adapter and is exercised
today only by the status table's own tests. And **`closed` is reachable only through LinkedIn**,
from its bounded banner list.

Alongside the outcome and the barrier, a record carries bounded `reasons` — `anti_bot_page`,
`auth_wall`, `content_below_minimum`, `deferred_content_suspected`,
`description_container_absent`, `identity_unconfirmed`, `rate_limited`, `route_unresolved`,
`transport_failed`, `unsupported_content_type`,
`unknown_shape`. That list is the whole vocabulary a caller may branch on; an adapter that emits
anything outside it throws rather than passing an unrecognized code downstream.

A record is `usable` when a body was persisted **and** every structural check the serving adapter
claims actually held. **`usable` promises access and those checks — never completeness**: no
single static capture can prove it carried the whole page, because there is nothing in one
response to compare against. Otherwise it carries `fallback: "browser"` — the explicit signal
that the caller must fall back to the in-app-browser transport — unless it is terminal, which carries no
signal at all. Two consequences are deliberate:

- a **degraded adapter** — a description container that has moved, a job id absent from the
  response — still persists its capture as evidence, and still routes the vacancy to the browser.
  The 2026-08-18 run watched LinkedIn's selectors break mid-batch, so this tripwire is the point;
- `absent` from a `404`/`410` is terminal without a structural check, because a 404 body has no
  description to check. `closed` and `private` are read out of the body, so they are trusted only
  when the structural checks held.

### The deferred-content signal

`deferred_content_suspected` is a per-response **architecture signal** raised by the generic
adapter on a record that stays `usable`: substantial prose arrived as data inside typed JSON
script islands (`application/json`, `application/ld+json`), invisible to markup extraction, so
the completeness of this capture is unverified by construction. It is **not** a shortness
verdict — the same island fires against a complete render of the page it was measured on,
because such islands are catalogs, not mirrors. The measurement and the verdict live in
[deferred-content.mjs](deferred-content.mjs): prose-shaped string values (at least 30 characters
and 4 spaces, tags stripped) are summed over the islands, and the signal fires when that mass
reaches **2×** the extracted text, or when the walk exhausts its value budget — an island too
large to finish walking is the same evidence in a louder form. The per-record facts land in the
manifest under `structural`: `bodyChars`, `jsonProseChars`, `jsonIslandUnparsed`,
`jsonWalkBudgetHit`. A malformed island alone records its fact and fires nothing.

Two residuals are named and accepted rather than implied. Content deferred with **no in-response
trace** — a block fetched after load on an otherwise light page — leaves nothing for any
single-capture check to read; only a cross-transport comparison sees it, which is how the defect
behind this signal was found. And prose inside **untyped** script assignments
(`window.__INITIAL_STATE__ = {…}`) is invisible to a typed-island scan. The known false-positive
cost is stated too: on a heavy-JSON architecture every record of the domain fires, complete or
not, and the caller's policy pays one browser confirmation per record; the per-domain transport
registry (backlog task 89) is the relief valve for domains repeatedly confirmed complete.

`summary.needsBrowserCompletenessCheck` counts the records that fired the signal while staying
usable, the stdout summary lists them under `completenessCheck`, and the exit code moves on them.
The count is not the number of browser loads the whole batch owes — a terminal `absent` record
owes one too and is counted nowhere here. The key was added without a `schemaVersion` bump, so a
manifest captured before it existed does not carry it, and a reader must not read that absence as
a zero.

## Adapters

An adapter answers three questions about one source and nothing else: does it serve this URL,
which route does it request, and what did the response contain. It never decides an outcome name —
it reports observations, and [outcome.mjs](outcome.mjs) resolves them through the single status
table. It never fetches, never writes, never sleeps and never reads the clock.

| Adapter | Serves | Notes |
| --- | --- | --- |
| `linkedin-guest` | LinkedIn posting references that identify exactly one job id | requests the canonical guest route already declared by `instructions/skills/get-vacancy.md`; structural checks are the requested job id present in the response and a description container found; detects the closed banner, the authwall path and LinkedIn's `999` block status |
| `generic-html` | everything no dedicated adapter claims | semantic-container extraction (`<main>`, `<article>`, `role="main"`), page chrome dropped, shared minimum-content floor, deferred-content signal over typed JSON islands; a final URL the registry names LinkedIn on one of `linkedin-guest`'s wall paths is a wall whatever the page's language; reads no first-party status vocabulary, so `closed` and `private` are unreachable through it |

The generic adapter is what makes an arbitrary vacancy URL scoreable. ADR 0012 leaves one branch
of the generic fallback open for the user — whether a Step 1 run served only by the generic path
may publish a completed outcome — and that question is untouched here, because this layer publishes
nothing.

### Adding an adapter is a bounded change

Five steps, no more:

1. **Write the module** in `adapters/`, exporting one frozen object with `id`, `version`,
   `sourceId`, `matches(url)`, `route(url, { userAgent })` and
   `interpret({ transportFailure, status, finalUrl, contentType, body, context })`. Return the
   shape documented in [adapters/contract.mjs](adapters/contract.mjs): observations plus
   `structural`, `structuralOk` and bounded `reasons`. Never resolve an outcome name yourself.
2. **Declare the route as a fact**, in the same shape as `linkedinGuestRoute` in
   [adapters/linkedin-guest.mjs](adapters/linkedin-guest.mjs) — the sibling adapter's own exported
   route object, not the aggregate-route table in `tools/job-sources/routes.mjs`, which serves a
   different mechanism. This repository cannot verify a live route; say so in the module, as that
   object's `verification` field does.
3. **Register it** in `adapters/index.mjs` — one entry in `dedicatedAdapters`, before the
   fallback. Selection order is declaration order; the fallback is always last.
4. **Add one fixture per behaviour you claim** in `fixtures/`, and one manifest row per fixture in
   `tests/vacancy-fetch.test.mjs` with its SHA-256 and its expected reading. The directory is
   compared against the manifest in both directions, so an unlisted or unexercised fixture fails.
5. **Reuse, do not restate.** Domain identification stays `detectJobSource`; the status vocabulary
   stays `tools/job-sources/routes.mjs`; the minimum-content floor stays
   `adapters/contract.mjs`. An adapter that lowers a shared bound locally is the defect this
   structure exists to prevent.

Nothing else changes: no CLI flag, no manifest field, no schema version. One adapter cannot
disable another, because the registry selects exactly one and none of them share state.

Candidates named by the task and the epic — hh.ru's embedded initial-state JSON, and ATS career
pages with documented JSON routes — each belong in their own change so one source can degrade
without the others.

## Rate limits and politeness

Requests are strictly sequential with a configurable pause, defaulting to the ~2 s the canonical
LinkedIn recipe already prescribes. On a `429` the default is to stop the batch: continuing would
spend the rest of it proving the same thing, and the remaining links are recorded as unattempted
and retryable rather than silently dropped. `Retry-After` is recorded in the manifest and is not
acted on automatically — no automatic retry happens at all, because the retry decision belongs to
the caller that also owns the browser fallback.

**An interrupted batch has no resume path.** The loop always starts at the first URL, and there is
no cursor. A batch that dies from a thrown error still writes its manifest, so the record of what it
already fetched survives; a batch killed outright (`SIGKILL`, a sleeping machine) leaves capture
files with no manifest, and `--out-dir` then refuses that directory rather than colliding halfway
through a retry. Either way the way forward is a fresh directory, which re-requests every URL —
including the ones already fetched politely. That is a real cost of the no-hidden-state design and
is named here rather than discovered; a resume cursor would be its own change.

Two further residuals are named rather than implied. `robots.txt` is not fetched: this tool opens the
pages one person already chose to open, one at a time, and a preflight request per vacancy would
double the traffic it is trying to keep small — a crawler would need a different answer. And the
default request headers imitate a browser, exactly as the canonical Step 1 recipes for LinkedIn and
Lever already prescribe; whether a source serves guest HTML at all under those headers is what the
rollout comparison of 2026-08-24 measured, on the fourteen links it covered and no more.

## Modules

| Module | Owns |
| --- | --- |
| [cli.mjs](cli.mjs) | argument parsing, the envelope read, exit codes, the bounded stdout summary |
| [batch.mjs](batch.mjs) | sequential orchestration, the delay, the rate-limit policy, output-directory safety, the manifest |
| [transport.mjs](transport.mjs) | one bounded HTTP request, the manual redirect walk, the header allowlist, decoding |
| [adapters/](adapters) | the contract, the registry, and one module per source |
| [html-text.mjs](html-text.mjs) | the dependency-free HTML scanner and visible-text collector |
| [deferred-content.mjs](deferred-content.mjs) | the typed-JSON-island prose measurement and the deferred-content verdict |
| [digest.mjs](digest.mjs) | the one SHA-256 helper the whole layer uses |
| [normalize.mjs](normalize.mjs) | the ordered, logged normalization pass |
| [outcome.mjs](outcome.mjs) | the ADR 0012 direct-route status table, implemented once |
| [url-rule.mjs](url-rule.mjs) | the ADR 0012 URL rule |
| [persist.mjs](persist.mjs) | capture rendering and re-verification |
| [input-schema.mjs](input-schema.mjs) | the ADR 0011 envelope this CLI accepts |

`tests/vacancy-fetch.test.mjs` drives all of them offline: the transport takes `fetchImpl` as a
parameter and every case supplies a response built in memory. No test in this repository reaches
the network.
