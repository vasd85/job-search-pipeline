# tools/board

The development board lives in the private repository, nested in an engine clone as `candidate/`
and ignored by the engine (ADR 0024, decision 1). Two commands work on it. The format of a task and
the two board rules are owned by the board's own README, which `board:init` writes from
[board-readme.md](board-readme.md).

## `npm run board:init` — create the private repository

```sh
npm run board:init -- --source <old repository> [--rev <commit>] --engine <engine clone> \
  [--layer <candidate directory>] [--remote <url>]
```

One run, on the day of the switch. It creates `<engine>/candidate/` as a git repository with one
commit and fills it from two places:

- the old repository at `--rev`: every tracked path the export-exclusion list of that commit leaves
  behind, placed by the table `LAYOUT` in [init.mjs](init.mjs) — tasks into `board/` and
  `board/done/`, decision records into `decisions/`, research, audits and reports into
  `research/`, the rest of the old archive into `archive/`. The files are read through git, so
  only committed content moves;
- `--layer`, copied as it is: the candidate data that lives outside git today.

It refuses before writing anything when the engine does not ignore `candidate/`, when that
directory exists and is not empty, when an excluded path has no row in the table — a path added to
the list later must get a place rather than stay behind in a repository nobody publishes — and when
two sources land on one path. After the commit it checks that the engine's `git status` did not
change. `--remote` adds `origin` and pushes `main`.

It is a transition tool: the old paths it names exist only in the old repository, and the task
that removes the old flow's tools removes this one after the switch.

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
clone: before the switch that path is a plain directory inside the operational checkout, and a git
command there would reach the checkout's repository instead.

Importing does not start the task, and nothing here calls it on its own; when a session runs it is
for the development flow document to say.

## Refusal codes

`board_invalid_arguments`, `board_git_failed`, `board_not_in_a_checkout`, `board_failed`,
`board_init_engine_not_a_checkout`, `board_init_layer_not_ignored`, `board_init_target_not_empty`,
`board_init_source_unreadable`, `board_init_exclusions_unreadable`, `board_init_unsupported_entry`,
`board_init_unmapped_path`, `board_init_path_collision`, `board_init_git_failed`,
`board_init_engine_sees_layer`, `board_init_push_failed`, `board_import_root_not_a_clone`,
`board_import_draft_invalid`, `board_import_draft_duplicate`, `board_import_imported_unreadable`,
`board_import_locked`, `board_import_no_upstream`, `board_import_git_failed`,
`board_import_diverged`, `board_import_pull_refused`, `board_import_draft_conflict`,
`board_import_needs_repair`, `board_import_target_exists`, `board_import_push_refused`.

The list is frozen against the sources by `tests/board.test.mjs`.
