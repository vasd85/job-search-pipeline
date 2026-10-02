# tools/board

The development board lives in the private repository, nested in an engine clone as `candidate/`
and ignored by the engine (ADR 0024). The private board's README owns task format and board rules;
[board-readme.md](board-readme.md) is the reference template.

## `npm run board:import` — a draft becomes a task

```sh
npm run board:import -- --ops-root <operational folder> [--draft <file name>] [--board-root <path>]
```

A run in the operational folder files a task as `outbox/tasks/<slug>.md` with a `draft_id` and no
number. For each draft, in name order, the command:

1. takes a lock in the private clone's git directory, fetches, and settles a commit an interrupted
   import left unpushed — pushes it when the board did not move, takes it back and refuses when
   another machine pushed meanwhile;
2. pulls with `--ff-only`; a refusal names the files git named;
3. writes `board/<id>-<type>-<slug>.md` with the next id as the first frontmatter key, commits that
   one path with `--only` and a `Board-Import-Draft` trailer, and pushes;
4. records the pair in `outbox/tasks/.imported.json` and deletes the draft.

A refused push takes the commit back — the branch moves one step and only this path is unstaged,
so what another session staged stays staged — and leaves the draft in place. The task keeps its
`draft_id`; a repeated run finds it and finishes the record instead of filing the task twice.

`--board-root` defaults to `candidate/` beside the common git directory of the clone this tool is
in, so the command works the same from a task's working copy. It must be the root of its own
clone; otherwise git could reach a containing repository.

Importing does not start the task, and nothing here calls it on its own; when a session runs it is
for the development flow document to say.

## Refusal codes

`board_invalid_arguments`, `board_git_failed`, `board_not_in_a_checkout`, `board_failed`,
`board_import_draft_invalid`, `board_import_draft_duplicate`, `board_import_imported_unreadable`,
`board_import_locked`, `board_import_no_upstream`, `board_import_git_failed`,
`board_import_diverged`, `board_import_pull_refused`, `board_import_draft_conflict`,
`board_import_needs_repair`, `board_import_root_not_a_clone`, `board_import_target_exists`, `board_import_push_refused`.

The list is frozen against the sources by `tests/board.test.mjs`.
