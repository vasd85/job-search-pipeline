# Fixtures

**Every file here has synthetic content over live structure.** The element nesting, class names
and attributes follow live `t.me/s/<handle>` pages of thematic QA channels read on 2026-09-17 (and,
for the `group-*` files, live message pages read on 2026-09-18); every
handle, title, text, contact and URL is invented (`example*`, `*.test`). No file is a recorded
capture: a rehearsal run's captures are referenced by digest in the task's `## Result`, never copied
into git.

- `channel-page.html` — one readable channel page with the three shapes a vacancy takes:
  - `201` a **card**: a picture, one apply link whose tracking query is double-escaped
    (`&amp;amp;`) exactly as live pages serve it, two hashtags, and a link-preview card that repeats
    the link without the query;
  - `202` a **digest**: one link per line, a social link, a hashtag;
  - `203` a **full text with a contact**: a quoted reply, a forwarded-from header, a Telegram name,
    a mailbox, a word Telegram itself turned into a link (`ASP.NET`), and a footer of invite links;
  - `204` a full text with a contact **and** a link of its own; `205` a post without text (a
    picture); `206` a post whose links are all marked, plus a `localhost` link and a `tg://` link;
    `207` an inline URL button; a foreign post; a post with an unreadable date.
- `card-group.html` — what `t.me/s/<group>` redirects to: a card with audience counters.
- `card-not-found.html` — what `t.me/s/<nobody>` redirects to: a contact card without counters.

The four `group-*.html` files follow live `t.me/<group>/<id>?embed=1` message pages of public
groups read on 2026-09-18 (task 125); the same rule holds — structure live, every name, text,
contact and URL invented.

- `group-message.html` — one readable message (`501`) of a group: the author block with a profile
  link, a quoted reply whose own author carries a profile link too, a hashtag row, a careers link,
  a Telegram contact and a mailbox in the text.
- `group-message-no-username.html` — a message (`502`) whose author has no profile link (a deleted
  account): the author block is a plain name; no link and no contact in the text.
- `group-post-not-found.html` — the error widget an empty id answers with: deleted message, service
  record and not-yet-issued id all look like this.
- `group-not-found.html` — the error widget of a handle nobody owns.

The three `reader-*` files belong to the reader stage (task 127); no live page stands behind them.

- `reader-hostile-page.html` — one channel page with a post whose text talks to the reader: it
  orders a shell command, a file write, a different verdict on another post and an answer in free
  text, and then names a real QA vacancy with a link and a contact. Every line of it is data to the
  batch renderer and to the reader.
- `reader-batch.txt` — that page's post as `batches.mjs` renders it for the reader, byte for byte
  (the test compares); the hostile lines are numbered text like any other.
- `reader-answer.json` — an answer to that batch by the schema: the vacancy on line 3, the link and
  the contact by number, and nothing of the post's text.
