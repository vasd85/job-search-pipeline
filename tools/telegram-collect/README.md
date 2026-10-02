# telegram-collect

An explicit sweep of configured public Telegram sources: channels through the `t.me/s/<handle>`
web preview, and public groups (chats) one message at a time through `t.me/<handle>/<id>?embed=1`
— a group has no preview, and the section [Groups](#groups) says how it is read instead. It
publishes a links collection that `/score-jobs` consumes unchanged, a file of vacancy cards, and a
sweep report of everything the sweep did **not** emit. No auth, no npm dependency, no model call
from code, no scoring, no ledger write, no scheduled run. The procedure an agent follows is
[instructions/skills/collect-telegram.md](../../instructions/skills/collect-telegram.md).

**A source is thematic or general.** A thematic source (the default) has no role filter: everything
but advertising fits, every post with text becomes a card, and the collector does not tell a
vacancy from a résumé or a question — in a thematic group that is the wanted behaviour, and the
author of any such message becomes a contact of its card (see Groups). A general source
(`thematic: false`) pours every role into the channel, so its posts reach the collection only
through the [reader stage](#the-reader-stage): the code picks the candidates by the config's word
list, a reading agent with one tool names the QA vacancies by line and link numbers, and the code
builds the cards from those numbers.

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
second step of a sweep over a general source (see the reader stage); `finalize` takes no
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
- **`telegram-sweep-state.json`** — schema version 2 (a version 1 file is read as it is and written
  back as 2). Per channel `{last_message_id, last_sweep_at}`; per group
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
`resume_hints` too, in a config of thematic sources only, where they are carried and not used. A source carries
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
The card therefore counts as one with a contact and offers its own `?embed=1` address to scoring
on top of its new links. An author without a user name (a deleted account, a hidden name) is
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

Every new post lies in exactly one bucket; a thematic source fills only the first three, the other
three belong to the reader stage.

- **`empty`** — a post without text, with an attachment flag. Listed in the report.
- **`not_candidate`** — a post of a general source in which no word of `role_words` stands, in
  the text or in an anchor text. Counted per source, never listed: the accepted boundary of the
  first stage (the research measured zero QA vacancies lost there on 1 859 posts).
- **`repost`** — all three hold against an earlier post, of this sweep (in the source or across
  sources) or of a fingerprint not older than `repost_memory_days`: the first two lines that carry
  a word are equal after normalisation; the texts are near-equal (a Jaccard estimate of at least
  0.6 over 64 min-hashes of five-word shingles; a text under 25 words is compared for equality);
  the sets of all unmarked `url` links are equal, new and known together. A repost emits nothing,
  prolongs the term of its original, and is always listed with the original's `handle/id` and the
  first line the original does not carry — so a wrong fold is visible.
- **`card`** — every other post of a thematic source, and a post of a general source in which the
  reader named at least one vacancy. A thematic card: title — the first line that still carries a
  word once its hashtags are taken out, and the first non-empty line when the post carries no such
  line; contacts — `tg` names and `email` addresses, and for a group message the author's user
  name (`author_tg`, see Groups). Its unmarked `url` links split into **known** (the address is
  in `emitted_urls`) and **new**. `score_urls` are the new links in post order, plus the post
  address `https://t.me/<handle>/<id>?embed=1` — built from the config handle and the numeric id
  — when there is no new link or the post names a contact. A reader's card differs in what the
  reader stage says below: one card per named vacancy, the title by line number, the links by link
  number.
- **`no_vacancy`** — a post of a general source the reader read and named no vacancy in. Counted;
  listed only through the discrepancy list (a strong role word in its head or an anchor) and, when
  it looks like a résumé, in its own list.
- **`answer_invalid`** — a post of a general source whose answer the schema rejected and
  `finalize --accept-invalid` accepted. Always listed with its code.

`emitted_urls` is read once at the start of a sweep and written with the state at its end, so an
address this sweep emits is not known to the other posts of the same sweep. Only `url` addresses
enter it, never a post address. A known link in a post of any bucket but `empty` prolongs its term.

One address stands in the collection once per sweep, at the newest card that offers it (at an equal
instant — the channel that stands first in the config, then the larger id, then the lower
`vacancy_no` of one post). A card whose every address stands at a newer post gets no line of its
own and no post address; the report lists it with the holder of each address — for two cards of
one post, "card N of the same post".

Accounting: `empty + not_candidate + repost + card + no_vacancy + answer_invalid = new posts`
(`card` counts posts; the number of cards is reported beside it), and every anchor of a card post
has exactly one fate, the first that applies — `preview_folded`, `hashtag`, `non_web`,
`tg_other`, `contact`, `marked`, `unusable`, `known`, `not_cited` (a `url` link of a read post the
reader named in no vacancy), `repeat_in_sweep`, `emit`.

## The reader stage

A general source's posts are read by a model between the two halves of a sweep. The code chooses
what the model sees and checks every number it writes; no word of the model's own reaches a card.

1. **Candidates.** A new post with text of a general source is a candidate when a word of
   `role_words` stands in any line of its text or in the text of any of its anchors; the rest is
   `not_candidate`. A résumé hint in the first six lines — one of the config's `resume_hints`, with
   no letter or digit right after it — is printed in the report and removes nothing.
2. **Groups of one sweep.** Reposts fold as always, but in this order: every post of a thematic
   source first, oldest first, then the candidates of general sources, oldest first. A group of
   identical posts that holds a thematic post is never read — that post is the card and the
   original, even when a general copy is older (the one case an original is newer than its
   repost). Otherwise the oldest candidate is read and the copies are reposts that inherit its
   outcome. A candidate that folds into a card's fingerprint of an earlier sweep is a repost and is
   not read. Fingerprints are kept for cards only: a post the reader said no to has none, and its
   repost next sweep is read anew — a miss of the reader is never hidden for the memory term.
3. **Batches**, `reader-in/<handle>-NNN.txt`: one source per file, at most 20 posts and 48 KiB, a
   post never split. A post is `### post <k>` (its number in the batch, not its id), its non-empty
   lines as `|<i>| <text>`, and its `url`, `tg` and `email` anchors as
   `-> [<j>] <type> <host><path> "<anchor text>" [<marks>]` (no address for `tg` and `email`;
   `tg_other`, `unusable` and skipped anchors are not offered). A post longer than 20 lines shows
   its first 12, its last 8 and every hidden line in which a role word stands, with `|..| N lines
hidden` between. Every printed line is flattened and bounded (300 characters; 80 for an anchor
   text).
4. **Two steps.** `sweep` walks, writes the captures, the batches and `sweep-stage.json` (the
   walk, the digests of the config and state files, the batch descriptors) and touches no state;
   stdout says `stage: "awaiting_answers"`. The reader answers into `reader-out/<handle>-NNN.json`.
   `finalize --out-dir` re-reads the config (by the path in the stage) and the state and refuses
   when either changed (`config_changed`, `state_changed` — start a new sweep; the directory stays
   as it is), refuses a completed directory (`already_completed`) and a missing answer file
   (`answers_missing`, naming the batches), then resolves the sweep and writes cards, collection,
   report, manifest and the state last. An abandoned two-step sweep moved nothing: the next `sweep`
   walks the same posts again. A config of thematic sources only, or a general source with no
   candidate, finishes in `sweep` alone. `render-batches --full-text` writes the same batches with
   no hidden middle into `label-in/`, with `label-in/descriptors.json` beside them so a label is
   checked by the same schema as an answer; it works before and after `finalize`, for the
   measurement's independent labelling.
5. **The answer**, one JSON object (one markdown fence around it is tolerated):
   `{"schema_version":1,"batch":"<handle>-NNN","posts":[{"post":k,"vacancies":[{"title_line":i,"apply":[{"via":"…","link":j}],"details_link":j}]}]}`.
   `via` is `url`, `tg`, `email` (with the number of a link of that type), `phone`, `dm_author`
   or `unspecified` (with `link: null`); `details_link` a `url` link or `null`; `title_line` a
   shown line, with the one correction below; at most 20 vacancies a post and 5 ways to apply a
   vacancy; keys closed at every level; a file of at most 64 KiB. Every post of the batch exactly once — missing is
   `post_missing`, twice is `post_duplicate`, a number the batch does not know is counted as a
   stray and ignored; a record off the schema is `post_invalid`; a file that is not one object by
   the schema gives every post of its batch `file_invalid`. `finalize` refuses any rejected
   answer by name — the batch's answer file, the post and the code (`answers_invalid`) — unless
   `--accept-invalid` is given, and then lists the posts
   under `answer_invalid`. A rejected answer file kept beside as `<handle>-NNN.rejected.json` is
   listed in the manifest with its digest and never read as an answer.

   **The one correction.** A post that showed a SINGLE line has a single place a title can stand
   in, so a `title_line` that post does not have is read as that line instead of rejecting the
   record. A descriptor of one shown line comes only from a post of one non-empty line: below the
   cut every line is shown, above it at least the first twelve. With two shown lines or more
   nothing is corrected — a card titled by the wrong line would name another vacancy — and the
   record stays `post_invalid`. Nothing but the title line is ever corrected. Each corrected post
   is listed in the report with the number the reader named, and counted in the manifest and on
   stdout as `title_line_repaired`; the post is a card like any other and stays in the `card`
   bucket.

6. **The reader's cards.** One card per vacancy named: `title` is the named line; `score_urls` are
   the named `details_link` and `url` apply links that are new and unmarked, in post order, plus
   the post address when there is none or a way to apply is a person (`tg`, `email`, `phone`,
   `dm_author`); the post address is offered once per post. Contacts are the code's, from every
   `tg` and `email` anchor of the post and the author — the reader only says how one applies,
   recorded as `apply_via`. A named marked link is not offered and is listed under "the reader
   chose a marked link"; a named known link stays known; a `url` link named in no vacancy is
   `not_cited`. Fates are accounted once per post, on its first card.
7. **Discrepancies** — the report's list of places where the reader saw no vacancy and a word of
   `strong_role_words` stands: for a post said no (and its reposts of the sweep) in the first two
   lines that carry a word or in an anchor; for a card of a general source in an anchor the reader
   named in no vacancy, in that anchor's line, or in one of the first two word-lines not named as a
   title — a tag row is skipped there, as no second vacancy. An anchor is read by its text and by
   its line; a contact anchor (`tg`, `email`) by its line with the name taken out, since a name is
   not a role; a hashtag anchor not at all. Each place once, in line order.

**The worst case, stated.** A QA vacancy of a general source is lost with no trace in the report
in exactly three cases: (a) no word of `role_words` stands in its text or its anchor texts — it is
`not_candidate`, in the count only; (b) the reader said no, and no strong role word stands in the
first two word-lines or in an anchor — it is in the `no_vacancy` count, not in the discrepancy
list; (c) the reader found another vacancy in the post, and the missed one stands below the first
two lines with no anchor of its own carrying a strong word in its text or its line — a vacancy
without a link or a contact, or whose link sits on a line without the role word, inside a post
where another was found. A repost of such a post in the same sweep is listed as a repost with the
original's outcome; next sweep a repost of (b) is read again, a repost of (c) is a repost of a card.
A picture-only vacancy is `empty`, listed per source. Nothing else is lost silently: posts
`empty`, `repost` and `answer_invalid` and every card are listed.

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
on; a cheap model is easier to sway than a strong one. In Codex there is no subagent with a tool
allowlist: the session reads the batches itself, and the checks above — the answer schema, the
code-built cards, the discrepancy list — are all there is.

## Output directory

Must be absolute and empty or absent; it is append-only. Inside the repository it may stand only
under `telegram-sweeps/` or `.rehearsal/` — the cards carry people's contacts; the check resolves
the symlinks of the existing part of both paths (letter case too, where the file system folds it). Write order:
`NNN.page.html` captures as fetched, `vacancies.jsonl`, `collection.links.txt`, `sweep-report.md`,
`sweep-manifest.json` with the digests of the cards and the collection and `completed: true`, the
state last. With nothing to emit no collection file is written; with no card, no cards file.

- **`collection.links.txt`** — addresses and `# collected:`, `# order:`,
  `# via: <handle>/<id> <instant>` comments only; not a word of a post, no contact.
- **`vacancies.jsonl`** — one card per line, `schema_version` 3: `handle`, `post_id`, `instant`,
  `title`, `score_urls`, `known_urls`, `contacts`, `author_tg`, `vacancy_no` (the vacancy's number
  in its post; `1` for a thematic card), `apply_via` (the ways to apply the reader named; empty for
  a thematic card), `marked_urls`, `unusable_links`, `held_by`. Today its reader is the user;
  `cards.mjs#cardProblem` is its schema. Files of earlier sweeps keep their older lines and are not
  rewritten.
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
  `stray_answers` — additive extensions; the file has no reader besides the tests. Each capture
  entry carries `message_id` (the id a group request asked for, `null` for a channel page).

`reset-cursor <handle>` forgets the source's cursor — a group's position, `last_stop` and
`longest_gap` with it — together with its fingerprints and the addresses it emitted: without that a
re-sweep would fold every post into itself and emit nothing. A group then starts again at
`start_id`, and the window binds what it emits.
