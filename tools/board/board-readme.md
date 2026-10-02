# Board

One file per development task, in the private repository. This README owns the format of a task
file. What a session does with a task — claiming it, planning, review, closing it — belongs to the
development flow document, not here.

The board is a grep away:

```bash
rg '^(id|type|title|status|priority):' board -g '!README.md' --no-heading
```

## Layout

- `board/` — tasks that are not closed: `open`, `in-progress`, `blocked`, and every epic.
- `board/done/` — closed tasks.

A task moves from the first to the second in the commit that closes it.

## Filename

`<id>-<type>-<slug>.md` — zero-padded numeric id, task type, kebab-case English slug that renders
the title. Ids are sequential and never reused; the next id is one above the largest id in
`board/` **and** `board/done/`.

## Language

Section headings are English, spelled as this file names them. The prose of a task — the title
and every section — is written in the working language the candidate config names for private
files, `languages.working`. Terms, names, code, commands, paths,
identifiers, frontmatter keys and enum values stay as they are. A quote keeps the language of its
source.

Tasks that came from the old backlog keep the headings they were written with. They are history
and are not translated.

## Types

- `feat` — development task with a concrete deliverable.
- `bug` — defect with a reproduction.
- `research` — investigation whose deliverable is a document, not code.
- `process` — change to how the project itself is run or documented.
- `epic` — a paused or long-running lane, split into tasks when work resumes. An epic is never
  claimed directly; its children name it with an `epic` entry in `depends`.

## Frontmatter

```yaml
---
id: 3
type: feat
title: One line
status: open          # open | in-progress | blocked | done
priority: p2          # p1 next up | p2 normal | p3 someday
created: 2026-09-23
source: where the task came from
depends: [{blocker: 2}]
draft_id: 20260923-4f1c   # only on a task that was imported from a draft
---
```

`depends` lists typed links, each `{<type>: <target>}` whose target is an id or a double-quoted
condition:

- `blocker` — the target is done before this task is claimed. An id is met when its file is in
  `board/done/` with `status: done`. A condition in text is met only by a commit that removes the
  entry and names the record that met it.
- `epic` — this task is a child of that epic.
- `related` — informational; requires nothing.

Optional keys: `blocked-by` (free text when `status: blocked`), `draft_id` (below), and a `claim`
block whose fields the development flow document names.

## Body

A filed task separates knowledge by how well it is established.

- **`## Facts`** — only what is verifiable, each with a pointer: file and line, a sha, a command
  and its output, an exact quote.
- **`## Decisions`** — explicit decisions of the user, in the user's words. They bind whoever
  carries the task out. Nobody else writes one.
- **`## Hypotheses`** — optional and non-binding.
- **`## Acceptance`** — what will be true when the task is done, not how to do it.

The sections written while the task is carried out are `## Plan`, `## Review` and `## Result`.

## Board rules

1. Pull with `git pull --ff-only` before a claim, and push straight after it. When the pull
   refuses on a dirty clone, stop and name the file git named — never `--rebase` over it.
2. Every session commits only its own task file, naming it explicitly: `git commit -- <file>`.

## Drafts

A session that cannot write into this repository — a run in the operational folder — files a task
as a draft: `outbox/tasks/<slug>.md` in that folder, in the format above with no `id` and with a
`draft_id` that names the draft uniquely.

`npm run board:import` in a development clone of the engine turns a draft into a task. It pulls,
takes the next id, commits that one file, pushes it, records the pair `draft_id → id` in
`outbox/tasks/.imported.json` and deletes the draft. The task keeps its `draft_id`, which is how a
repeated import after an interruption finds the task instead of filing it twice. When another
machine has pushed first, the import refuses and leaves the draft where it was; run it again.
Importing a draft does not start the task.
