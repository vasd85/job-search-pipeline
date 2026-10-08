# tools/pretriage — the batch-start stage

What a `/score-jobs` batch decides **before** the expensive lane opens: is this collection still
current, in what order is it spent, which of its links are already over, and what does it actually
contain. The expensive lane is the rendered-page browser, the full description extraction and the
scoring pass over it; a link this stage disposes of never enters it.

Behaviour is owned here. The policy numbers and the class mapping are owned by [the review runbook's
pre-triage section](../../docs/runbooks/triage-review.md#21-pre-triage-freshness-order-composition),
and which regions and destinations the classes rank by the `priorities.*` keys of the candidate
config.

## Why it exists

Measured in the verified run of 2026-08-18: 3 of 10 links were already closed at fetch time, one of
them about 22 hours after posting; 1 of 10 matched the profile's priority-1 class while 8 were
on-site relocation outside the ranked classes; and the operator's source file held 101 links
collected the day before. Two costs follow from that and neither was visible until it had been
paid — budget spent on postings that were already gone, and a collection whose shape was discovered
only after the whole pipeline had run over it.

## What it is not

- **Not a transport.** It fetches nothing, opens no page and reads no clock. Liveness arrives as
  observations — from the manifest of `tools/vacancy-fetch`, which the rollout of
  [its runbook](../../docs/runbooks/vacancy-fetch-experiment.md) made the default transport, and from
  any later producer of the same observation shape — and every instant is supplied by the caller, so
  a replayed batch produces an identical plan.
- **Not a second classifier.** The one terminal state it reaches is the rubric's own
  `SKIP: vacancy_unavailable`, and it reaches it by handing the pure scorer a `source` fragment, not
  by naming a decision. Everything else it can say about a link is a disposition, not a verdict on
  the vacancy.
- **Not a filter the user cannot see.** Every link held back from the expensive lane is printed on
  its own line with its reason. A stage that dropped fifteen links and reported only "15" would be
  asking to be trusted about which fifteen.
- **Not a shell surface.** Every entry point is an in-process module API, called the way
  `instructions/skills/score-jobs.md` already calls the pure scorer and the triage ledger. No vacancy
  value reaches argv, which is the strongest form of the
  [ADR 0011](../../docs/adr/0011-untrusted-input-safe-cli-transport.md) boundary: there is no shell,
  so there is nothing to escape.

## The stage, in the order a batch runs it

```js
import { readCollection } from "tools/pretriage/collection.mjs";
import { planBatch } from "tools/lib/triage-ledger-core.mjs";
import { applyLivenessSweep, planPreTriage } from "tools/pretriage/plan.mjs";
import { composeBatch } from "tools/pretriage/composition.mjs";
import { candidatePriorities } from "tools/candidate/load.mjs";
import { renderCompositionReport, renderPreTriagePlan } from "tools/pretriage/report.mjs";

const collection = readCollection("/absolute/links.txt");
const ledgerPlan = planBatch(ledger, collection.links.map((link) => link.url), { asOf });
const plan = planPreTriage({ collection, ledgerPlan, asOf });
// plan.sweep.links -> the fetch layer, in that exact order
const swept = applyLivenessSweep(plan, { manifest });
const composition = composeBatch(observations, {  // header facts of the surviving links
  priorities: candidatePriorities({ root: "/absolute/checkout/candidate" }),
});
```

`asOf` is the batch's own observation instant, the same value the ledger write uses.

## Explicit source-aware collections

`readCollection(path, {sourceSetPath, captureRoot})` validates the explicitly paired source set,
exact collection bytes and saved HTML and adds all card/snapshot/role memberships. Neither an
adjacent file nor historical `# via:` comments enable this mode. Standalone URL behavior is unchanged.
The artifact contract is [tools/triage-sources/README.md](../triage-sources/README.md).

Pass `sourcePlan: planSourceBatch(...)` alongside the legacy URL `ledgerPlan` to `planPreTriage`.
A source-aware plan has schema version 2. It retains URL accounting and separate logical-card
counts; a legacy URL `skip_known`/`skip_closed` cannot suppress a new or edited card. Only a
validated logical/source baseline may withhold it. Per-source technical failures remain retryable.
`company_context` and `source_contact` avoid fetch/extraction/scoring. A fresh `source_snapshot`
uses a full original from saved HTML, saving only HTTP spend; `source_summary` is not scored as a
JD. Details/apply/unknown routes still enter the normal liveness/fallback lane. The new dispositions
are bounded separately from version 1, whose fields and meanings remain intact.

`splitCollection` emits schema version 2 with `card_refs`, logical counts and `oversize` on each
source group. It packs whole vacancy source units into contiguous URL ranges. Shared company/contact
URLs are accounted once by the nearest job position of a card with an explicit membership; ties use
the card's first job position and then its reference. A repeated context footer stays with its nearby
job holder rather than extending the first card's range through unrelated jobs. A shared homepage
does not establish shared job identity. The noncontext sources of one card remain indivisible.
Canonical spellings of the same posting identity join their cards into one source unit, so a
Senior/Junior conflict cannot disappear across session ranges. Genuinely distinct posting IDs
remain separate. A source unit bigger than the requested group size remains whole and is reported.
`collectionGroup` retains the full source set and exact original collection bytes plus the selected
`source_selection`; verification uses the original range. Composition is counted once per logical
vacancy, using one primary's own facts and unknown when identity or facts are unresolved.

## The collection

A links file, read by `tools/triage-verify/links.mjs#readLinksFile` — that module owns the list, and
deriving it a second way here would make every later disagreement an argument about which list was
right. What this directory adds is the header, in comment lines that reader already skips:

```text
# collected: 2026-08-17
# order: newest-first
https://…
```

Only the comment block before the first link is read. `collected: ` takes a UTC date or a zoned
instant; a date is read as midnight UTC, which is the earliest instant it can mean and therefore the
reading that makes a collection look oldest. Being wrong in that direction costs a sweep; being wrong
in the other spends the expensive lane on dead links. `order: newest-first` is the operator's
assertion that the file is already in that order — recorded as a claim, never as a sort.

Three consequences of that reading, each stated because an operator meets them:

- a date **one calendar day ahead** of the batch instant is accepted as age zero — at 01:00 in
  Tbilisi "today" is already tomorrow in UTC, and the operator writes their own date. Further ahead
  is a typo or a wrong clock and stops the batch;
- the **batch instant itself may not be a bare date**: midnight is the earliest moment of a day, so
  reading it that way would shrink every age and could show a stale collection as fresh;
- a date the calendar does not have (`2026-02-30`) is refused in **both** spellings. `Date.parse`
  rolls it forward to 2026-03-02 rather than refusing it, which would read two days younger than
  written — a third of the staleness window.

## Session groups

A collection larger than one session can read is spent by several sessions, each on its own
**group**: a contiguous 1-based range of the deduplicated collection in the file's own order, cut at
the size the caller names. `groups.mjs` owns the cut and the claim:

```js
import { claimGroup, collectionGroup, splitCollection } from "tools/pretriage/groups.mjs";

const split = splitCollection(collection, { groupSize: 15 });
// split.groups -> [{ group: 1, from: 1, to: 15, size: 15 }, …]; split.cross_group_spellings
const claim = claimGroup({
  storeDir: "/abs/triage-batches", split, labelPrefix: "2026-09-20-telegram",
});
// claim.batch_id -> "2026-09-20-telegram-1-15"; claim.dir is the batch directory, already created
const group = collectionGroup(collection, claim);   // the collection as this batch sees it
```

Three properties hold by construction, and none of them needs the sessions to talk:

- **The cut reads no ledger.** Two sessions that split one file with one size compute the same
  groups whenever they do it. Cutting only the links the ledger would fetch would make the cut
  depend on the moment it was made — after one group recorded, the next session would see other
  groups. The ledger cleans links _inside_ a group, as it does in any batch; the cost is that a
  re-run over a mostly-known collection has thin groups, never a group over the budget.
- **A group is a batch.** Its own `batch_id` — `<prefix>-<from>-<to>`, the shape the manual runs
  already used — its own directory, its own `plan.json`, its own verification range: `--from` and
  `--to` are the group's bounds, and `collectionGroup` cuts the slice with the same
  `tools/triage-verify/links.mjs#sliceRange` the verifier cuts the range with. Inside the group,
  `input_index` runs 1..k, which is what the verify README calls the position inside the verified
  range. `groupBatchId` refuses a prefix the ledger's `batch_id` pattern would refuse, before a
  fetch is spent under it. No size given, the collection is one group — today's behaviour.
- **The batch directory is the claim.** [The review runbook's batch
  store](../../docs/runbooks/triage-review.md#11-batch-store-the-history-beside-the-index) already
  has a session create the directory before the first fetch; `claimGroup` makes that `mkdir` the
  atomic act of taking a group. Without a group number it takes the first group whose directory does
  not exist; with one, exactly that group, and one already claimed is refused
  (`pretriage_group_claimed`) — the way to take a group again on purpose. `storeDir` is the store of
  this checkout as [the batch store
  section](../../docs/runbooks/triage-review.md#11-batch-store-the-history-beside-the-index) names
  it, absolute and already existing (`pretriage_store_missing` otherwise); every group claimed is
  `pretriage_no_free_group`.

**What the cut names and does not remove.** The file is deduplicated by full URL and the ledger
collapses spellings, so two spellings of one posting can land in two groups.
`cross_group_spellings` lists them, with the group each one falls in, before anything is fetched.
The cut does not drop the later one — the verify suite requires every link of a range to be
accounted for — and the session cannot skip it for the same reason; what settles it is the record
write: `recordBatch` reads the batch's `plan.json` back and refuses an entry whose row another batch
wrote since (`triage_ledger_concurrent_observation`), so the vacancy is recorded once, by whichever
group recorded first, at the cost of one fetch and one score in the other. A group that was claimed
and never finished is found the same way the skill closes a collection: `planBatch` over the whole
file after the last group, where a link still `fetch_new` names the group to take again by number.

The bounded codes of this part: `pretriage_invalid_group_size`, `pretriage_invalid_group`,
`pretriage_invalid_label`, `pretriage_invalid_split`, `pretriage_store_missing`,
`pretriage_group_claimed`, `pretriage_no_free_group`, and `pretriage_claim_failed` for a store that
exists and still refused the directory (permissions, a read-only mount, no space). A message names
a group number or a code, never a link.

## Freshness and ordering

`assessCollection` returns `fresh`, `stale` or `undated`, and `sweep_required` is the operative
field: true for stale, and equally true for undated. A collection that cannot say when it was
gathered has not proved it is fresh. The window is the collection's own number, owned by [the review
runbook's pre-triage
section](../../docs/runbooks/triage-review.md#21-pre-triage-freshness-order-composition).

`orderNewestFirst` sorts only when **every** link carries a posting instant. A partially dated list
sorted by date would put every undated link behind every dated one, which is a claim about their age
that nothing observed — and those undated links are exactly the ones a search export leaves in its
own newest-first order. The basis is always reported: `posted_at`, `declared_newest_first` or
`input_order`.

**Nothing in this repository produces `posted_at` yet.** A links file holds URLs, and neither the
fetch manifest nor the ledger carries a posting instant, so a real batch gets
`declared_newest_first` or `input_order` today. The plan carries the field through from the
collection when a caller has it, and the basis is reported precisely so the difference is never
guessed at.

The freshness policy is enforced, not advised: `plan.gate.expensive_lane_open` is false for a
collection that needs a sweep and has not had one — and what opens it is the sweep's result, not the
fact that one ran. A sweep that left links unattempted, because a rate limit stopped it or the batch
died, established no liveness for them, so the gate stays shut with `sweep_incomplete` and the way
forward is another sweep of those links.

## The liveness sweep

`sweepFromManifest` reads a `fetch-manifest.json` into bounded observations; `classifyLiveness`
turns one into a verdict. Three verdicts, and `gone` is the narrow one — it means this stage is
willing to end the link without the expensive lane.

| observation      | verdict      | why                                                                                                                                                        |
| ---------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| never attempted  | `unresolved` | a stopped batch says nothing about the posting                                                                                                             |
| `absent`         | `unresolved` | owes one browser confirmation load before [the rubric's terminal decision codes](../../knowledge/job-match-rules.md#6-terminal-decision-codes) classify it |
| `access_failure` | `unresolved` | a technical failure is never the vacancy's own state                                                                                                       |
| not `usable`     | `unresolved` | a status word read out of a layout the adapter no longer recognizes                                                                                        |
| `closed`         | `gone`       | the source's own closure statement, in a page whose checks held                                                                                            |
| `private`        | `unresolved` | not expired, removed or closed; [the rubric's terminal decision codes](../../knowledge/job-match-rules.md#6-terminal-decision-codes) have no row for it    |
| `active`         | `live`       | the expensive lane opens                                                                                                                                   |

Two of those rows are worth stating twice. An **`absent` record is not terminal here**:
`instructions/skills/score-jobs.md` requires one browser confirmation load before [the rubric's
terminal decision codes](../../knowledge/job-match-rules.md#6-terminal-decision-codes) classify it,
because the layer observed that 404 exactly once. And a **`closed` record still owes one short
quote** — [the rubric's evidence
rule](../../knowledge/job-match-rules.md#5-evidence-and-uncertainty) requires it and
`normalizeScorerInput` refuses a closed outcome without one unless the symptom is exactly
`HTTP 404 after retry`. Reading one banner line off a capture already on disk is not the full
extraction this stage exists to avoid.

`goneScorerSource` builds the `source` half of the normalized scorer input for such a link, so the
caller assembles no vocabulary of its own and the trace comes out of the pure scorer as
`SKIP: vacancy_unavailable`. `tests/pretriage.test.mjs` drives that path end to end against the real
scorer.

**A verdict carries no manifest index.** A record's index is its position inside its own manifest,
and a batch split across invocations has several manifests each starting at 1; the plan row's
`input_index` is the only identity. The fold checks both the count and each record's requested URL
under the ADR 0012 rule, with no escape for a record that carries none — an identity join that can
be switched off by omitting a field is not one.

## What pre-triage may decide, and what it may not

Under policy `triage-policy-v8-2026-10-01` the set of outcomes that can be settled before the
description is read is **liveness and nothing else**. [The rubric's access
outcome](../../knowledge/job-match-rules.md#21-access-outcome-before-scoring) allows exactly one
title-only early SKIP — `not_qa_or_testing_role` — and every other [SKIP
code](../../knowledge/job-match-rules.md#62-skip-codes) is gated on the description. The on-site
relocation postings outside WEST that the 2026-08-18 run wanted to pre-classify are scoreable under
policy v2 and must be scored: outside WEST, silence about visas is neutral. This directory therefore
implements no early-SKIP classifier. The composition report is what surfaces such a collection
instead — as a shape the user can act on, not as a decision taken for them.

## The spend accounting

`plan.spend` is what makes "measurable fetch-spend reduction" a number the batch produces rather
than a claim made about it afterwards. It refuses to flatter itself in two ways that a single total
would have hidden:

- **A fetch and the expensive lane are different spends.** The adapter-layer run _is_ the sweep, so
  a swept-dead link was requested like every other; what it saves is the browser load, the
  extraction and the scoring. `never_fetched` is the narrower count of links that cost no request
  at all — a ledger skip, an in-batch duplicate, an unreadable link.
- **The ledger's saving is the ledger's.** `avoided_by_ledger` is what `planBatch` removed and
  would have removed without this stage; `avoided_by_pretriage` is what this stage removed itself —
  the in-batch duplicates and the swept-dead links. The ledger's answer is therefore read _before_
  the duplicate flag: a second spelling of a link the ledger already reports closed is the ledger's
  saving, though neither costs a request. `avoided_expensive_lane` is the total of both plus the
  unreadable links, which are nobody's saving because they were never spendable — and the rendered
  report names all three parts so its decomposition adds up to its own headline.

## The composition report

`priorityClassFor(observation, { priorities })` maps one observation to a priority class. The
engine keeps the form of the classes — `"1"` is remote work for a company of a ranked region, `"2"`
any other remote work, `"3"` a relocation with visa sponsorship to a ranked destination — and the
candidate's `priorities`, as `tools/candidate/load.mjs#candidatePriorities` returns them, say which
regions and destinations are ranked: `remoteCompanyRegions`, `relocationWest` for the whole WEST
region, and `relocationCountries`, the ranked destinations spelled out as ISO 3166-1 alpha-2 codes
with every excluded destination taken out. A call without them is refused with
`pretriage_priorities_invalid`, because an absent set would rank nothing and say so for every link.

The observation's **values** are the scorer's vocabulary (`Remote`, `WEST`, `available`, a country
code); its **field names** — `work_format`, `company_region`, `sponsorship`,
`relocation_destination_code` — are this stage's own, because the scorer spells its normalized offer
in camelCase and its trace with a `selected_` prefix, and these are header facts read before
anything was scored. The field that named the country by name, `relocation_destination`, is refused
rather than ignored. [The review runbook's pre-triage
section](../../docs/runbooks/triage-review.md#21-pre-triage-freshness-order-composition) states the
accepted shape. The answers are `"1"`, `"2"`, `"3"`, `outside` or `unknown`. `outside` means
genuinely outside the three ranked classes — such a role is still acceptable, only not ranked — and
`unknown` means the source did not carry what the class needs. The two are never folded together: a
collection that is mostly `outside` is one finding, and one that is mostly `unknown` means the
header facts were too thin to say, which is a different one.

**The destination code decides first; no country is named here.** A code is ranked exactly when it
is in `relocationCountries`, whatever the company's region. Without a code only the company region
is left: a WEST company is ranked when the whole region is and `unknown` when only some WEST
countries are; a company of unknown region is `unknown`; a HOME or OTHER company is `outside`. The
cost of a missing code is named twice: a ranked country outside WEST is not recognised in a HOME or
OTHER company's posting, and with the whole region ranked an excluded WEST country is ranked on its
company's region. The one country table read is the engine's own list of WEST countries.

## Modules

`priorityClassForLedger` returns the same class in the shape `triage-ledger.json` stores — `1`, `2`,
`3`, or `null` for a row that carries no `priority_class` at all — and the test suite writes its
result through `recordBatch` so the agreement is proved against the real validator.

| Module                             | Owns                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| [collection.mjs](collection.mjs)   | the links file as a collection: the reused list reader plus the header                  |
| [groups.mjs](groups.mjs)           | session groups: the file-order cut, the group's slice and batch id, the directory claim |
| [freshness.mjs](freshness.mjs)     | the staleness window, the age assessment, the ordering basis                            |
| [liveness.mjs](liveness.mjs)       | manifest to observations, observation to verdict, the terminal `source` fragment        |
| [composition.mjs](composition.mjs) | the priority classes and the batch composition report                                   |
| [plan.mjs](plan.mjs)               | dispositions, the freshness gate, the spend accounting                                  |
| [report.mjs](report.mjs)           | the two rendered reports, prose in the default language with verbatim machine tokens    |
| [errors.mjs](errors.mjs)           | one error type, bounded codes, and no external value in a message                       |

## Limits

- **The stage is only as good as the sweep it is given.** It verifies that a manifest is about the
  links it planned — count, order and requested URL under the same ADR 0012 rule — and refuses one
  that is not. It cannot verify that the manifest describes what the pages actually said; that is
  `tools/triage-verify/` and the rollout runbook's measured comparison.
- **The composition report classifies observations, not vacancies.** Its input is the header facts a
  batch read cheaply. A wrong or missing header fact produces a wrong bucket, and the report says
  how many buckets it could not fill rather than filling them.
- **Nothing here is a substitute for the ledger.** The ledger owns liveness across batches; this
  stage owns one batch's start, and the only thing it writes is the batch directory a group claims.
- **The stage's own saving is structurally LinkedIn-shaped today.** `terminal_gone` needs the
  manifest outcome `closed`, and only the `linkedin-guest` adapter can produce it: a generic page
  exposes no first-party status word, as `tools/vacancy-fetch/README.md` states. On a collection
  from any other source `avoided_by_pretriage` can only come from in-batch duplicates, and the
  measurement will honestly read near zero rather than being wrong.
