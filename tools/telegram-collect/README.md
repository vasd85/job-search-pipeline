# telegram-collect

An explicit sweep of configured public Telegram sources: channels through the `t.me/s/<handle>`
web preview, and public groups (chats) one message at a time through `t.me/<handle>/<id>?embed=1`
— a group has no preview, and the section [Groups](#groups) says how it is read instead. It
publishes a links collection, a file of vacancy cards, an immutable source-set, and a
sweep report of everything the sweep did **not** emit. No auth, no npm dependency, no model call
from code, no scoring, no ledger write, no scheduled run. The procedure an agent follows is
[instructions/skills/collect-telegram.md](../../instructions/skills/collect-telegram.md).

**A source is thematic or general.** A thematic source (the default) has no first-stage
role-word filter: every new post with text reaches the isolated reader. A general source
(`thematic: false`) reaches it only when the config's word list selects the post. Both use the
[reader stage](#the-reader-stage) for vacancy boundaries, description completeness and source
roles. The reading agent returns numbers and closed codes; code builds all source text and URLs.

## Commands

```sh
node tools/telegram-collect/cli.mjs init
node tools/telegram-collect/cli.mjs sweep --out-dir <absolute path> [--config <absolute path>]
node tools/telegram-collect/cli.mjs finalize --out-dir <absolute path> [--accept-invalid]
node tools/telegram-collect/cli.mjs render-batches --out-dir <absolute path> --full-text
node tools/telegram-collect/cli.mjs probe <handle> [<message id>]
node tools/telegram-collect/cli.mjs reset-cursor <handle>
```

Stdout is one JSON object of bounded codes and counts, with no post title, no address and no
contact: it is read by a model. Exit `0` — done, or a sweep awaiting the reader's answers
(`completed: false`, `stage: "awaiting_answers"`); `2` — the sweep finished but at least one
source did not complete; `1` — refused (`status: "refused"` with a code) or failed. `sweep` and
`finalize` first run the operational folder's drift check and are refused with its code
([tools/ops-tree/README.md](../ops-tree/README.md)). `finalize` and `render-batches` are the
second step of a sweep with posts to map (see the reader stage); `finalize` takes no
`--config` — the path is in the stage file. The `probe` card carries
`sources_rule: "thematic_or_reader"` — the one thing a probe cannot check. With a message id the
probe reads one message page of a group instead: whether it is readable (`message_ok`), has text,
names an author with a user name, and when it was sent.

## Working files

Both are untracked, live in the checkout root beside `triage-ledger.json`, and are resolved from
`JOB_PIPELINE_WORKSPACE_ROOT` when it is set (test isolation).

- **`telegram-sources.json`** — channels, groups, the two word lists, the résumé hints and exclusions, edited by hand. `init` copies it
  from the tracked template [config/telegram-sources.json](../../config/telegram-sources.json) when
  it is missing and never touches an existing one. The template is not read by a sweep, and its
  channels are fictional: the real list is the candidate's and lives only in the working file, so a
  checkout that needs it — a rehearsal worktree, say — has the file placed by hand.
- **`telegram-sweep-state.json`** — schema version 3. Versions 1 and 2 remain readable;
  historical writes retain their version-2 semantics. A reader2 completion writes version 3,
  retaining legacy fingerprints without claiming their identity was verified. New fingerprints
  also carry `source_body_sha256`, the digest of full code-extracted lines and anchors; only an
  exact digest match may suppress a reader2 post as a repost. Per channel `{last_message_id, last_sweep_at}`; per group
  `{kind: "group", last_live_id, last_live_at, last_sweep_at, last_stop, last_stop_after, longest_gap}`
  (see Groups); plus two memories: `fingerprints` of the posts that became cards and `emitted_urls`,
  the addresses already emitted. All hold digests, handles, ids, instants and normalised addresses —
  not a word of a post. Created by `init` only; a sweep without it is refused with `state_missing`,
  never a silent full backfill. An entry of a source no longer in the config is inert and is kept. A
  source whose `kind` in the config differs from its entry is refused before any request with
  `state_kind_mismatch` — run `reset-cursor` first. Losing the memories breaks nothing: the triage
  ledger knows the emitted addresses anyway.

### Config

```json
{
  "schema_version": 4,
  "channels": [
    "example_qa_jobs",
    { "handle": "example_second_qa_jobs", "note": "why", "enabled": true },
    { "handle": "example_chat", "kind": "group", "start_id": 259000, "stop_after": 300, "request_cap": 600, "note": "why" },
    { "handle": "general_jobs", "thematic": false, "note": "general: read by the reader stage" }
  ],
  "exclusions": ["example.com", "board.example.com/careers"],
  "role_words": ["QA", "AQA", "SQA", "SDET", "test*", "quality", "automation"],
  "strong_role_words": ["QA", "AQA", "SQA", "SDET", "QC", "test", "tests", "tester*", "testing"],
  "resume_hints": ["#cv", "#resume", "open to work"],
  "backfill_days": 14,
  "page_cap": 25,
  "delay_ms": 2000,
  "repost_memory_days": 60
}
```

Every top-level key is required; the code holds no default — `role_words`, `strong_role_words` and
`resume_hints` too, in a config of thematic sources only. Thematic posts bypass the first-stage
role-word filter, while strong-word discrepancy and résumé reporting still apply. A source carries
`thematic` (`true` by default); a general one says `"thematic": false`, channel or group alike. A
word of either list is a whole word or a prefix ending in `*`, letters and digits only in any
script, compared without case after NFKC; 1–64 words a list. A résumé hint is a tag or a phrase in
any script, at most 64 characters with a letter or a digit, compared without case after NFKC; 0–64
hints a list. A file of schema version 3 is refused with the words `schema_version must be 4`; the
edit it needs is that line and the `resume_hints` key. A source is a handle string or an
object; `enabled: false` switches it off and keeps the note; `kind` is `channel` (the default) or
`group`. A group carries three more keys, all required: `start_id` — the id of the message the
first pass starts from, taken from a message link `t.me/<handle>/<id>`; `stop_after` — how many
empty ids in a row end a pass (1-5000); `request_cap` — how many requests one pass may spend
(1-10000, not below `stop_after`). A channel entry may carry none of the three. A handle must match
`^[A-Za-z][A-Za-z0-9_]{3,31}$`; a failing entry is `config_invalid` naming the entry index, before
any request. An exclusion is a host (its subdomains included) or a host with a path prefix (the path
itself and everything under it), read without case. Bounds: `backfill_days` 1-90, `page_cap` 1-50,
`delay_ms` 500-60000, `repost_memory_days` 1-365. Unknown keys are refused — `role_tokens` of the
retired token filter among them. A file of version 1 or 2 is refused with the same words.

Choosing the two group numbers: `stop_after` at least three times the longest hole the group has
shown — 300 for a large moderated chat where deletions and service records burn most ids (the
research of task 125 saw a hole of 98 in a 58-thousand chat), 100 for a small one (holes of 8-17
there); `request_cap` at least `stop_after` plus the group's daily id inflow times the days between
sweeps (about 30 ids a day in that large chat), otherwise an active group ends every pass at the
cap and never gets a verdict.

## The sweep

Strictly sequential, `delay_ms` between requests, transport and digests reused from
`tools/vacancy-fetch/`. Per channel the walk goes newest to older through `?before=<min id>` and
stops at the **first** of: the stored cursor, the backfill-window edge, the page cap, the end of
history. A stop at the window or the page cap reports the id range that entered nothing: everything
below the smallest new post down to the cursor — the posts nobody walked and, on a window stop, the
walked ones older than the window. The same range is reported when such a post shares a page with
the cursor and the stop is the cursor. The new cursor is the largest id of the first page.

A source interrupted mid-walk emits nothing, enters no count and no repost comparison, and keeps
its state entry untouched. After a `429` the remaining sources are `unattempted`; sources completed
before it emit and advance. Source outcomes: `completed`, `disabled`, `unattempted`,
`rate_limited`, `not_a_channel` (a group configured as a channel, or preview off), `not_found`,
`group_not_found`, `handle_mismatch`, `http_error`, `transport_failure`, `page_truncated`,
`unrecognized_page`, `empty_page`, `pagination_stalled`.

### Groups

A public group is read one message at a time: `https://t.me/<handle>/<id>?embed=1` answers every id
with status 200, and the body decides — a message widget with the handle's `data-post` is a live
message; an error widget saying "Post not found" is an empty id, which is one answer for three
things: a deleted message, a service record (someone joined) and an id not issued yet; an error
widget naming an unknown handle is `group_not_found`; a widget whose `data-post` carries another
handle means the address leads elsewhere and stops the source (`handle_mismatch`). Anything else —
a page whose `data-post` id is not the id asked for included — is `unrecognized_page`, a loud stop.

**The walk goes up, one id at a time**, from the id above `last_live_id` — the highest live message
the group has ever answered with — and on the first pass from `start_id` inclusive. It stops at the
first of two rules, checked in this order after every answer: `stop_after` empty ids in a row
(`tip`), or `request_cap` requests spent (`request_cap`, the tail above is named in the report).
Because an empty id above the tip is a message not written yet, **the position never moves over
empty ids**: after a `tip` stop it stands on the last live message, and the next pass rereads the
empty ids above it. A hole shorter than `stop_after` is therefore always crossed; one of
`stop_after` empty ids or longer stops the group until `stop_after` is raised or a new `start_id`
above it is set (`reset-cursor` and the config). A pass that read no live message keeps its
position. The cost of a quiet pass is `stop_after` requests, `delay_ms` apart; every request is one
message id, there are no probes.

**The backfill window binds what a group emits, not what it walks.** A message older than the
window is read, counted (`older_than_window`), moves the position and becomes no card. That is what
keeps `reset-cursor` from re-emitting a group's history: the next pass starts at `start_id` again
and emits only what lies within the window.

**The author is a contact.** A message page names its author; when the author has a public user
name, it becomes `author_tg` of the card and, unless the text names it already, a `tg` contact —
in a group "write me" is the usual way to apply, and the page is the only place that name exists.
The author remains contact metadata. The reader names `dm_author` only when the post asks for
that route; an author does not replace a stated form or merge separate roles. Original-post
source membership always survives, including a summary whose post URL is absent from the collection. An author without a user name (a deleted account, a hidden name) is
`author_tg: null`, adds no contact, and the source counts the message in `author_without_username`;
the card is built as usual. A channel post has no author and `author_tg: null`.

**What the report says about a group**: the id range checked, live messages, messages older than
the window, new posts by bucket, the stop and its reason (`tip` — how many empty ids over which
range; `request_cap` — on which id), the position before and after, `longest_gap` — the longest run
of empty ids between two live ones the group has ever shown (measured only between live ids, so a
deleted `start_id` counts for nothing; kept in the state, forgotten by `reset-cursor`), the last
live instant with the days since, and the **verdict on the previous stop**. The verdict exists only
when the previous pass ended with `tip`: a live message above the previous position and sent more
than fifteen minutes before that pass began (the tolerance covers a clock) existed then and was
answered "Post not found" — within the previous `stop_after` that is a `transient_miss`, beyond it
the previous pass stood at a `hole` at least as long as its threshold, and the hole's length is printed:
the run of "not found" answers above the previous position, the messages within the threshold it
was told "not found" about counted inside it and named. Live messages with none such: `confirmed`.
No live message: `none`. After a `request_cap` stop there is no verdict; a previous pass that read
nothing live has no position to judge from, and the report says so (`no_position`). The `hole`
verdict is reached only after `stop_after` was raised: with the same threshold the pass stands at
the same hole and reads nothing. At the moment of a stop a silent group and a pass standing at a
hole answer alike; the evidence — `stop_after`, `longest_gap`, the days since the last live message
against the group's usual pace — is what the report can give then, and the verdict is what the next
pass adds in hindsight.

An interrupted group pass (`429`, a network failure, an HTTP error, `group_not_found`,
`handle_mismatch`, an unrecognized or truncated page) emits nothing and leaves the state entry
untouched, like a channel; up to `request_cap` requests of work are repeated next time.

### Links: types and marks

The unit is the post. Every anchor of a post gets one entry. A link is rebuilt from a parsed URL,
never copied:

| Type       | What it is                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`      | `http(s)`, userinfo and fragment cut, accepted by `tools/lib/triage-ledger-core.mjs#normalizeVacancyUrl` — the links-file readers refuse a whole file over one link that is not |
| `tg`       | `t.me/<name>`, the name matching the handle pattern — a contact                                                                                                                 |
| `tg_other` | any other Telegram link: a post, an invite (`+…`, `joinchat`), a route — counted                                                                                                |
| `email`    | `mailto:` with an address matching a plain pattern — a contact                                                                                                                  |
| `unusable` | failed the fitness check: `too_long`, `local_host` (localhost or an IP), `normalizer_refused`, `bad_email`                                                                      |

Hashtags (`?q=%23…`), `tg://` and every other scheme are not in the list and are counted
(`hashtag`, `non_web`). A link-preview card folds into the text link with the same host and path
(`preview_folded`): on live pages the text address keeps a tracking query the card has dropped.

A `url` link may carry marks. **A mark never removes a link**: it keeps the link out of the scoring
addresses and names it in the report.

- `social` — the host is on the closed list of social networks (Telegram is not on it);
- `boilerplate` — the same normalised address stands in the walked posts of the source under
  **different** normalised texts, and such posts are at least three **and** at least a quarter of
  all the posts walked. The base counts every post of the pages walked, the ones a previous sweep
  saw and the ones without text included. It is about repetition, not position: a repeated address
  in the body of a post is marked like one in its footer;
- `excluded` — the host or path prefix is in `exclusions`;
- `autolink` — the anchor text, having no scheme, equals the host and nothing follows it: a word
  Telegram itself turned into a link (`ASP.NET`, `Node.js`).

A `tg` name is never `boilerplate`: a recruiter runs many vacancies.

### Cards, reposts, known addresses

Every new post lies in exactly one bucket:

- **`empty`** — no text, with the attachment flag; listed in the report.
- **`not_candidate`** — a general-source post without a role-word match; counted per source.
- **`repost`** — the existing head/text/URL-set comparison matches, and for reader2 the full
  code-extracted body-and-anchor digest also matches. Legacy approximate fingerprints do not
  suppress new source mapping. Listed with its original post and any differing line.
- **`card`** — the reader names vacancies, or the complete post exceeds the reader limit and
  code retains an explicit unresolved mapping. Each named vacancy has its own card.
- **`no_vacancy`** — the reader names none; counted, with strong-word discrepancies and résumé
  hints reported. Thematic posts can now reach this bucket too.
- **`answer_invalid`** — a rejected answer accepted with `--accept-invalid`; listed by bounded code.

`emitted_urls` is read once at the start and written last, so an address emitted within a sweep
is not already known to another card of that sweep. New/known marks and URL holders remain visible.
One full URL stands in the collection once, at its newest holder; this removes duplicate URL
lines, not card memberships. Shared context URLs, contacts, authors and post ids never merge
vacancies. Every known/held card retains its own immutable source-set membership. A full
original description always offers the post URL; a summary with an external details/apply route
may omit that URL from the collection while retaining the original snapshot.

Accounting remains `empty + not_candidate + repost + card + no_vacancy + answer_invalid = new
posts`; `card` counts posts and the separate cards count counts roles. Each original anchor has
one code-owned link fate (`preview_folded`, `hashtag`, `non_web`, `tg_other`, `contact`, `marked`,
`unusable`, `known`, `not_cited`, `repeat_in_sweep`, `emit`). Semantic source roles are separate
from those fates and are preserved for each card even when a URL is held or known.

## The reader stage

Both thematic posts and general-source candidates are mapped by an isolated model between the
two halves of a sweep. Code checks every reference and builds all source content; the reader
never supplies title/URL/contact text.

1. **Input.** `reader-in/<handle>-NNN.txt`, one source per file, at most twenty posts and 48 KiB,
   without splitting a post. Every non-empty source line and full offered anchor is shown,
   without middle omission or line/anchor truncation. Types `url`, `tg`, `email`, `tg_other` are
   offered; unusable/skipped anchors remain accounted by code. Oversize posts receive a
   `mapping_oversize` sentinel; their full HTML/text remains saved and is never passed off as
   complete reader input.
2. **Stage.** New sweeps publish `sweep-stage.json` version 2, captures, batch digests and complete
   descriptors without changing state. All-complete batches need reader answers; an all-oversize
   batch needs no answer. `finalize` checks config/state digests, resolves answers, validates saved
   HTML, publishes cards/collection/source-set/report/manifest, then writes state last. A completed
   directory, missing answer or changed config/state remains a bounded refusal. The stdout
   `unresolved_mappings` count and report expose oversize posts; their description and anchor roles
   stay `unknown` with `mapping_status: unresolved_oversize`, requiring source review.
3. **Answer version 2.** One object, closed keys at every level, at most 64 KiB:

   ```json
   {"schema_version":2,"batch":"<handle>-NNN","posts":[{"post":1,"vacancies":[
     {"title_line":1,"start_line":1,"end_line":5,"description_kind":"summary",
      "links":[{"anchor":1,"role":"company_context"},{"anchor":2,"role":"apply"}],
      "apply":[{"via":"url","link":2}]}]}]}
   ```

   At most twenty vacancies per post, five apply routes per vacancy. `description_kind` is
   `full_description`, `summary` or `unknown`. Boundaries are inclusive, disjoint, inside the full
   post, and contain the actual title line. There is no title-number repair in this epoch.
   Every offered anchor is assigned explicitly to a QA card or a known excluded region; a card
   cannot quietly discard an uncited URL. Roles follow surrounding text: `company_context`, `details`, `apply`, `contact`, `unknown`.
   Code adds the derived `original_post` membership. Only company context may be shared between
   cards or sit outside their own boundaries. A details/apply/contact/unknown anchor of a sibling is
   rejected; a button without a line may belong to one card only. A link that provides both full
   details and an explicit application route uses `apply`. `unknown` stays reviewable.
   `apply` keeps the existing `url`, `tg`, `email`, `phone`, `dm_author`, `unspecified` codes;
   numbered routes must match their anchor type and role. Reader order does not control identity.

   A post with QA cards may optionally carry `excluded_regions`, up to twenty records:
   `{"start_line":6,"end_line":8,"reason":"non_qa_vacancy","anchors":[3]}`. The only reasons
   are `non_qa_vacancy` and `non_vacancy`; uncertain roles remain cards with unknown mapping for
   source review. Exclusion bounds are inclusive and disjoint from every QA card and other
   exclusion. Every offered anchor inside the excluded text must be listed; a listed known-line
   anchor must lie inside its region, while a floating anchor needs one explicit owner. No
   excluded anchor may also have any card role, including company context or unknown. Missing,
   malformed, overlapping, QA-owned or unknown exclusions are `post_invalid`. The complete body
   and anchors stay in the saved snapshot, with numbers and the auditable reason in the source-set.
   Excluded anchors create no QA source membership or collection URL; the same URL may still be
   offered through a separate legitimate QA anchor. Absence of this additive optional field keeps
   the original answer2 coverage contract; answer1 does not accept it.

4. **Cards.** Code sorts vacancies by their own start/title lines and assigns `vacancy_no` only
   for display. `source_snapshot_ref` binds handle, post id, publication instant, and the digest
   of full code-extracted lines/anchors. `card_ref` binds that snapshot, title line and the card's
   own boundaries. Adding/reordering a sibling never changes an unchanged card reference;
   editing the post or remapping its own boundaries changes it and requires fresh reconciliation.
   Source roles do not prove the identity of a fetched target page. Contacts come from captured
   anchors in the card's boundaries and author metadata; the author does not replace a form.
5. **Validation and discrepancies.** Existing bounded answer rejection, duplicate/missing/stray
   post handling, rejected-file retention and `--accept-invalid` behavior remain. Strong-word
   discrepancies now apply to both types of read post. Structural validation proves references,
   coverage and source integrity; semantic mistakes by the reader remain possible and require
   operational smoke/review. A general source can still miss a role without a role-word match.
   A reader's false negative or a missed role without a strong-word discrepancy is a named residual,
   including roles without their own anchor in a digest. Oversize mapping is always explicit.
6. **Historical epoch.** `checkAnswer` accepts answer1 only with a version-1 batch descriptor and
   retains its `details_link`/apply semantics and single-line title repair. Stage1 finalization
   retains card3 and historical collection behavior; old fixtures and files are unchanged.
   The internal `readerVersion: 1` test/compatibility entrypoint executes that epoch explicitly;
   CLI production defaults are answer2/stage2/card4/state3. `cardProblem` reads both card3 and
   card4 without treating a historical ordinal as durable identity.

**The boundary.** The reader is a generated Claude Code subagent, `.claude/agents/telegram-reader.md`,
whose canon is [instructions/agents/telegram-reader.md](../../instructions/agents/telegram-reader.md)
and whose frontmatter allows one tool, `Read`: no shell, no file writes, no network, no
subagents — a post's text cannot make it write or fetch. The allowlist is pinned by a test and
refused by the generator otherwise. The reader cannot answer for another post: each post of a batch
is taken exactly once by its number, and a number the batch does not know is dropped. Residuals:
one post's text may sway the reader's verdict on a neighbour of the same batch (a batch never mixes
sources, and a "no" over a strong role word lands in the discrepancy list); the reading tool is not
bounded to the sweep directory, so the reader can read any file the user can — what leaves it is
a few small integers per vacancy and the reply text the session writes verbatim and does not act
on; a cheap model is easier to sway than a strong one. In Codex the skill starts a fresh subagent
with `fork_turns: none`, passes the canonical instruction and one batch path, and assigns only
structured reading of that file. The parent never opens the batch. This is a behavioural
assignment: Codex does not mechanically remove the subagent's other tools or filesystem access.
The answer schema, code-built cards and discrepancy list remain the deterministic checks;
an unavailable independent reader stops the skill instead of falling back to parent reading.

## Output directory

Must be absolute and empty or absent; it is append-only. Inside the repository it may stand only
under `telegram-sweeps/` or `.rehearsal/` — the cards carry people's contacts; the check resolves
the symlinks of the existing part of both paths (letter case too, where the file system folds it). Write order:
`NNN.page.html` captures as fetched, `vacancies.jsonl`, `collection.links.txt`, `source-set.json`,
`sweep-report.md`,
`sweep-manifest.json` with the digests of the cards and the collection and `completed: true`, the
state last. With nothing to emit no collection file is written; with no card, no cards file.

- **`collection.links.txt`** — addresses and `# collected:`, `# order:`,
  `# via: <handle>/<id> <instant>` comments only; not a word of a post, no contact.
- **`vacancies.jsonl`** — one card per line, `schema_version` 4: the historical metadata
  (`handle`, `post_id`, `instant`, `title`, `score_urls`, `known_urls`, `contacts`, `author_tg`,
  `vacancy_no`, `apply_via`, `marked_urls`, `unusable_links`, `held_by`) plus `source_snapshot_ref`,
  `card_ref`, `title_line`, `start_line`, `end_line`, `description_kind`, `mapping_status` and
  `source_links`. The ordinal is display only. `cards.mjs#cardProblem` reads versions 3 and 4;
  historical records are not rewritten.
- **`source-set.json`** — schema version 1, immutable, adjacent to the collection. The contract
  owner is [source-set.mjs](../triage-sources/source-set.mjs). It binds exact collection bytes by
  `collection_sha256`; snapshots preserve handle/post/date, original URL, saved HTML
  `{file, sha256, captured_at}`, every full numbered source line and every code-extracted anchor.
  `captured_at` is code-owned capture time, distinct from the post's publication instant. Cards
  retain their title/boundaries/completeness, all semantic link roles and source-order display
  ordinal. Optional top-level `excluded_regions` retain `snapshot_ref`, inclusive line bounds,
  the closed `reason` and original anchor indices for known non-QA/non-vacancy regions. They are
  disjoint from cards and each other, account explicitly for their anchors, and preserve complete
  saved text without assigning it a QA source role. This additive field changes no existing epoch
  field or reference meaning and is absent from historical fixtures. The original post remains a
  source when absent from flat inputs. Snapshot refs are
  `tg-snapshot:sha256:<64 lowercase hex>`; card refs `tg-card:sha256:<64 lowercase hex>`.
  `validateSourceSet(set,{collectionText,captureRoot})` checks closed keys, limits, derived refs,
  coverage across cards/exclusions, disjoint bounds, anchor roles/URLs, exact collection/capture
  digests and reparses
  saved HTML to reject rewritten source text. Capture paths must be relative and non-symlink.
  `readSourceSet` returns `{sourceSet,digest,text}` and reparses by default from its directory.
  `sourceSetMemberships` preserves all card memberships on URL normalization; `cardBody` renders
  only that card's own lines. Object serialization is `JSON.stringify(set,null,2) + "\n"`;
  `sourceSetDigest` hashes those bytes for objects and exact bytes for strings/Buffers. Limits
  are code-owned; reader oversize is unresolved rather than truncation. HTML cannot independently
  attest the capture clock or semantic mapping; metadata integrity is digest-bound and the
  same-UID filesystem residual remains.
- **`sweep-report.md`** — per source the stop and the unwalked range (for a group: the id range
  checked, the stop and its reason, the position, `longest_gap`, the last live instant and the
  verdict on the previous stop), then the lists: emitted cards, cards whose address stands at a
  newer post, addresses already emitted, reposts (with the reader's outcome on the original when it
  was read), the discrepancies, rejected answers, posts whose title line was corrected, posts said
  no that look like a résumé, marked links the reader chose, marked and unusable links, posts
  without text, the boilerplate addresses of each source. Every title, line and address is one neutralised line in a code span. People's contacts — a group message's author included — are printed here and in
  the cards, nowhere else.
- **`sweep-manifest.json`** stays at schema version 1: its `channels` are the source records as the
  sweep built them, and a group's record carries `kind`, `checked`, `stop`, `verdict` and the other
  group fields; a two-step sweep adds `stage` (the stage file's digest), `batches`, `answers`,
  `rejected_answers` (files with digests), `accepted_invalid`, `title_line_repaired` and
  `stray_answers`, and `source_set` (file/digest/snapshot/card counts) — additive extensions; the file has no reader besides the tests. Each capture
  entry carries `message_id` (the id a group request asked for, `null` for a channel page).

`reset-cursor <handle>` forgets the source's cursor — a group's position, `last_stop` and
`longest_gap` with it — together with its fingerprints and the addresses it emitted: without that a
re-sweep would fold every post into itself and emit nothing. A group then starts again at
`start_id`, and the window binds what it emits.
