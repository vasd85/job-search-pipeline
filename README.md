# job-search-pipeline

An agent-assisted job-search pipeline for a QA Automation Engineer / SDET. It helps one candidate
screen vacancies, understand the risks of a role, and prepare a targeted CV and cover letter from
confirmed experience. The same canonical procedures run in Claude Code and Codex.

The project is in active personal use. It is a local tool with explicit steps and reviewable
artifacts; it does not submit applications automatically. The public engine includes a fictional
candidate so you can explore and verify it without anyone's private data.

## Quick start

Start from a fresh clone of the engine repository and run these commands from its root.
Install Node **24.18.0**, npm **11.16.0**, and Git **2.40 or newer** first. `.nvmrc` records the
Node version; with nvm installed, `nvm install` and `nvm use` select it.

The browser tests also need Google Chrome or Chromium and permission to bind local loopback
ports. If your browser is outside the usual macOS or Linux paths, set `JOB_PIPELINE_BROWSER_BIN`
to its executable's absolute path. For real CV rendering later, also install `unzip`,
LibreOffice (`soffice`), and Poppler (`pdfinfo`, `pdftoppm`); the gate tests renderer behaviour
with injected fixtures.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm ci --prefix tools/cv-builder --ignore-scripts --no-audit --no-fund
npm run candidate:check -- --root "$PWD/candidate.example"
npm run ci
```

The first two commands install the two locked dependency graphs and need package-registry access.
The candidate check should report `status: "ready"` and the example's documents and language pins.
The final command runs the repository gate, including scoring, artifact publication and recovery
fixtures against the fictional candidate. Success means every stage passes and the command exits
with code 0. These are deterministic fixtures; generating a new letter requires an agent session.

This route needs no private repository, `candidate/`, process log, credentials, or model account.
The tests create their own disposable state. Keep the development clone free of application state;
`bootstrap:init` and operational `preflight` are not quick-start commands.

## How the pipeline works

Batch triage starts with `/score-jobs`; `/collect-telegram` can optionally gather public vacancy
links first. Capture adapters save descriptions to disk, and the agent uses a browser fallback
when an adapter cannot deliver the page. The model extracts observations; code computes fit and
records scores, gaps and reasons against the candidate's configuration.

For a chosen role, start each step explicitly:

1. `/get-vacancy` saves the full job description and vacancy facts.
2. `/research-company` saves sourced company research.
3. `/map-experience` selects confirmed evidence and writes `application-brief.json`.
4. `/generate-cv` builds the targeted DOCX CV from that brief.
5. `/write-cover-letter` writes the letter from the same decisions.

Each step publishes validated files and records their digests. A later session resumes from those
files on the same filesystem. CVs are in English; letters follow the vacancy's supported language.
Before sending materials, use the
[application-readiness checklist](docs/runbooks/application-readiness-checklist.md): a successful
publication does not establish source fidelity, factual accuracy or writing quality by itself.
The full procedure is in [pipeline-run](instructions/pipeline-run.md), and the file lifecycle is
in [pipeline-artifacts](instructions/pipeline-artifacts.md).

## Design principles

- **The model observes, code decides.** Computable decisions have deterministic functions and
  traces; missing evidence stays visible.
- **A result is a file with provenance.** Validated publications, recorded inputs and digests
  carry work across sessions. Git holds the engine and candidate sources.
- **A check must be able to fail.** Tests and reviews are useful when they catch a concrete
  broken condition; their coverage limits are part of the design.

Read the [architecture overview](docs/architecture.md) for the boundaries and engineering choices.
The [ADR index](docs/adr/README.md) explains why those choices were made and links to their records.

## Repository map

| Path                                                  | Start here for                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [knowledge/](knowledge/)                              | Generation rules, scoring rubric, playbooks and authority rules.                          |
| [instructions/](instructions/)                        | Operating contract, explicit pipeline steps and canonical skill procedures.               |
| [candidate.example/](candidate.example/)              | Fictional profile, evidence, configuration, constraints and language packs used by tests. |
| [tools/candidate/](tools/candidate/README.md)         | Candidate-layer format and validation.                                                    |
| [tools/job-scorer/](tools/job-scorer/)                | Deterministic vacancy decisions and their trace.                                          |
| [tools/vacancy-fetch/](tools/vacancy-fetch/README.md) | Page capture and source adapters.                                                         |
| [tools/triage-verify/](tools/triage-verify/README.md) | Batch evidence and verification checks.                                                   |
| [tools/cv-builder/](tools/cv-builder/README.md)       | DOCX build, rendering and pagination checks.                                              |
| [tests/](tests/)                                      | Offline fixtures, behavioural tests and instruction pins.                                 |
| [docs/runbooks/](docs/runbooks/)                      | Development, operations, release and recovery procedures.                                 |
| [web/process-search/](web/process-search/)            | Local read-only process search interface.                                                 |

`AGENTS.md`, `CLAUDE.md` and native skill wrappers are generated entry points. Edit their canonical
sources in `instructions/`, then use `node tools/sync-agent-proxies.mjs --write` and `--check`.

## Development

The [development flow](docs/runbooks/development-flow.md) describes the published engine's process:
a task, a level of ceremony derived from changed paths, focused checks and the required gate,
independent review where required, then a pull request. The user reviews and merges with a merge
commit. The public record of development is the runbooks, ADRs and pull-request history; the
personal board is not needed to understand the engine or run its tests.

For a Codex development session, follow the
[environment checklist](docs/runbooks/codex-development.md). Source changes and live applications
use separate directories. Tests use disposable roots and never the real candidate or journals.

## Running your own search

For real applications, supply your own candidate layer in the
[documented format](tools/candidate/README.md) and use the
[operational entry point](docs/runbooks/ops-pipeline-codex.md). The published layout separates the
engine clone, private candidate repository and operational folder. The operational folder is
built from an engine release tag and a candidate tag, as described in
[ops-tree](tools/ops-tree/README.md). [Machine setup](tools/setup/README.md) is for that complete arrangement,
including access to your private repository; it is not required for the example above.

Operational state stays local: `process-log.json` records application steps, `triage-ledger.json`
records batch decisions, and `output/` holds materials. With a valid operational ledger,
`npm run search` serves the read-only interface at [localhost:4173](http://127.0.0.1:4173).
The normal writer is `tools/process-log.mjs`. External selectors and mutations follow the
[safe input-file producer procedure](instructions/pipeline-artifacts.md#safe-input-file-producer-procedure).

<details>
<summary>Operational bootstrap and recovery reference</summary>

`bootstrap:init` may only create the missing exact `output/` root, an
absent exact `process-log.json` containing an empty schema-v4 ledger, and — in a disposable root or
a rehearsal worktree only — an absent `candidate/` copied from `candidate.example/`. It reports each
creation and never overwrites, repairs, or merges an existing ledger.

The operational folder receives the real candidate's config, documents and language packs from
the candidate tag during [export and cutover](docs/runbooks/ops-cutover.md). The fictional example
is never copied into that layer.

`bootstrap --check` validates the layer when it is there and reports its absence as a fact; a
present but broken one fails the check. `npm run candidate:check` does the same without needing a
ledger, and takes `--root` so the tracked example can be checked too.

`preflight` is read-only, requires a valid ledger, and verifies the actual Node/npm versions, both
lockfiles, the installed local renderer graph, `unzip`, a safe LibreOffice backend, `pdfinfo`, and
`pdftoppm`. Only `bootstrap:init` may finish an exact validated interrupted bootstrap publication;
`bootstrap --check` remains read-only. When npm itself is missing, use
`node tools/bootstrap.mjs --check` to obtain the stable preflight diagnostic.

Deep validation also reports bounded `.pipeline-tmp` inventory, including orphan staging, without
reading candidate artifact bytes. Cleanup is never automatic: review one exact process/publication
scope with `cleanup-staging --id proc_... --publication-id publication_... --dry-run`, then repeat
that exact scope with
`cleanup-staging --id proc_... --publication-id publication_... --confirmation-token <sha256>`
only after inspection. Active, prepared-recovery, and committed-history staging cannot be removed
by this command. CLI failures are bounded JSON with a stable code and, where available, typed
context, cause, and recovery action. A simultaneous cleanup/release failure is retained as bounded
secondary recovery evidence without replacing the primary failure; errors do not expose absolute
paths, parser internals, raw exceptions, or stacks.

Deterministic artifact/lifecycle fixtures and their isolation rules are documented in
[file-backed-pipeline-fixtures](docs/file-backed-pipeline-fixtures.md). They use disposable roots;
the CLI read path never creates one implicitly.

</details>

## Checks

`npm run ci` is the single enforced aggregate gate. This section owns its contents; the governing
development runbook owns when to run it. [GitHub Actions](.github/workflows/ci.yml) installs both
lockfiles and delegates to the same command.

The stages run in order: proxy inventory, instruction contracts, full suite, serial suite,
fresh committed-tree archive, format, blocking publishability. The gate stops on the first failing
stage. It reads no real process log, output or candidate layer. The publishability stage refuses exported findings and missing tracked files. It loads only
the fictional layer's declared language-data paths; it never reads real candidate files or personal
markers. The blocking scan covers every tracked public path.

<details>
<summary>Gate inventory and limits</summary>

The runner freezes exactly 55 public executable test files and exactly 26 generated proxy files as
literals. Test paths are compared against the tree in both directions; additions and removals
require coordinated edits in `tools/ci.mjs`, `tests/ci.test.mjs` and the counts here. The proxy
check verifies every expected path and the explicit-only invocation policy of all seven Codex
metadata files. The `fresh-archive` stage checks those proxies in `git archive HEAD`, offline and
without installing anything, so uncommitted and untracked files cannot repair it.

The inventory proves presence, not assertion quality. A named suite emptied of meaningful
assertions can still pass. The suppression-marker scan has a finite vocabulary and cannot prove
that all tests executed. A focused `node --test` invocation should name one test file: with
multiple names, Node can exit 0 despite a missing file when another resolves. `npm test` keeps its
own glob over the 54 public non-browser files; that glob is not cross-checked against the runner's
inventory. The aggregate gate is the enforced entry point.

The suite checks [active section links](tools/candidate/README.md#repository-section-links),
including references in code fences and engine messages. The format stage checks uncommitted
changes and the whole committed tree against a fixed whitespace policy, including trailing
spaces, CRLF and conflict markers. It requires Git 2.40 or newer and refuses when the common Git
directory contains `info/attributes`, since those attributes would undermine the check.

`node tools/ci.mjs --list` prints the stage list. Individual commands such as `npm test`,
`npm run test:browser`, `npm run proxies:check` and `node tools/ci.mjs --stage format` remain
available; a focused run does not replace a required aggregate gate. Browser tests and the
aggregate gate need a shell that permits Chrome and local loopback servers. Operational
`npm run preflight` and `npm run process-log:validate` belong in the operational folder and stay
outside the gate.

</details>

## License and contributions

No license has been selected. This is a deliberate deferred decision; outside pull requests are
not accepted until it is made.

## Formatting

Run `npm run format` to format tracked files and `npm run format:check` to check them.
The `format` CI stage checks Prettier as well as whitespace. Prettier is pinned in the root
lockfile; install it with `npm ci --ignore-scripts --no-audit --no-fund`.
The shared configuration uses a width of 100, preserves prose wrapping, and leaves embedded
code examples unchanged. The formatter infers supported file types, includes dotfiles, and
never visits untracked operational or candidate files. `.prettierignore` documents every
excluded family: byte-sensitive fixtures, the candidate example, generated runtime proxies,
and npm-generated lockfiles. Regenerate proxies after changing their canonical instructions.

The mechanical formatting commit is recorded in `.git-blame-ignore-revs`. To retain useful
line authorship locally, run:

```sh
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

For a single invocation, use `git blame --ignore-revs-file .git-blame-ignore-revs <file>`.
Configuration, tooling, and test corrections remain visible in blame; only mechanical
formatting is ignored.
