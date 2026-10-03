# Running the real pipeline in Codex

The operational copy is the `job-search-pipeline/` folder without `.git`, assembled from an engine
tag and a private-layer tag ([ops-cutover.md](ops-cutover.md)).

## Open the right local project

1. Add the absolute path of the operational folder as a separate local project.
2. Create a new task in that project, choosing **Codex** and **Local**.
3. Keep all vacancy tasks in the same permanent folder. Different vacancies may run in parallel;
   never run two steps of one process at the same time.

Opening a real folder without `.git` was measured in Codex at the architecture switch. A fresh
CLI session was also measured in a disposable two-tag export. Neither result promises native
skill discovery on every version: the measured sessions loaded proxies directly. If the folder
cannot be opened, stop; do not initialize Git or move the run into a development checkout.
The terminal entry point is `codex exec --skip-git-repo-check -C <absolute operational path>`;
select `workspace-write` and an approval mode supported by the installed version, never bypass
the sandbox. The measured CLI's `--approve-for-me` already selects `workspace-write` and cannot
be combined with `--sandbox`.

## Preflight of a new operational task

Before invoking a skill:

```sh
pwd
npm run preflight
node tools/process-log.mjs validate --deep
npm run candidate:check
```

Expected: the exact operational path; green preflight, including manifest verification and the
two tags; a valid ledger; `candidate:check` returns `"status":"ready"`. A refusal stops the skill.
Check the session's actual writable roots and approvals. The manifest detects engine, candidate
and dependency drift after a write; it is not a write blocker. Codex does not run the Claude
write guard. Sandbox access to a path does not authorize a write there: engine, candidate and
dependency zones stay read-only, state and `outbox/` stay in this folder, and rehearsal sessions
stay in their own sealed folder. Do not broaden access to the projects parent to solve a refusal.
See [write boundary](development-flow.md#12-write-boundary-and-the-second-runner).

External values need the structured filesystem API and the shared
[safe input-file procedure](../../instructions/pipeline-artifacts.md#safe-input-file-producer-procedure),
or a true structured argv API without a shell. An unavailable producer is a stop, not permission
to write envelopes with shell quoting, heredocs or encoded strings. Put generated helper scripts
in an allowed state directory such as `.temp-docs/`, never at an unlisted root path.

## Explicit Codex skill invocations

Every step is started by a separate explicit message. Codex uses the name of the native skill with
the `$` prefix. Check the initial native catalogue separately from files on disk. When a proxy
is not registered, explicitly name its path in the request: read
`.agents/skills/<name>/SKILL.md`, then the full canonical procedure it names, before acting.
This direct-loader route does not establish automatic discovery. Do not install global copies
that could silently stay on an older release.

A new vacancy, Step 1:

```text
Run $get-vacancy for the vacancy:
<VACANCY_URL>

Run Step 1 only. Work in the operational folder, run the operational preflight,
and return the process id, the outcome and the published canonical paths. Do not move on to
Step 2 without a separate message.
```

Step 2:

```text
Run $research-company for process id <PROCESS_ID>.
Run Step 2 only and return a compact publication summary.
```

Step 3 is best started in a new clean task of the same Local project:

```text
Run $map-experience for process id <PROCESS_ID>.
Run the mandatory Step 3 only. Use only validated file-backed inputs.
```

Steps 4 and 5 are sibling consumers of Step 3, but for simplicity they run one after the other:

```text
Run $generate-cv for process id <PROCESS_ID>.
Run Step 4 only, including the mandatory build/render/visual QA procedure.
```

```text
Run $write-cover-letter for process id <PROCESS_ID>.
Run Step 5 only and publish cover-letter.txt through the lifecycle contract.
```

Batch triage creates no per-role process:

```text
Run $score-jobs for the following links:
<VACANCY_URLS>

Run the batch triage only. Do not start $get-vacancy automatically.
```

Telegram collection is separate from scoring:

```text
Run $collect-telegram over the configured sources only.
Use an independent telegram-reader for each general-source batch, finalize the sweep,
and return the collection path and the report. Do not score the collection automatically.
```

Initialize Telegram configuration or the triage ledger only on explicit user intent. A missing
file is reported, not created silently. Adding a live source follows the skill's probe and
source-type confirmation procedure.

Files, not chat, carry data between the steps. So Steps 2–5 can continue in new tasks, provided
they are opened as Local tasks of the same operational project and receive the exact
`PROCESS_ID`.

## Independent readers

The two canonical skills own their reader procedures. In Codex each reader is a fresh subagent
with `fork_turns: none`: canonical reader instruction inline, then only its permitted input
paths. The letter reader gets the staged letter and optional reading examples, never the brief,
author history or research. The Telegram reader gets one batch path; the parent never opens the
batch and writes the answer verbatim before `finalize` validates it.

This is a behavioural read-only assignment, not a mechanical tool allowlist. Subagents share
tools and filesystem access. Observe their actual calls; out-of-scope access, unavailable
structured reading, inherited author context or an invalid response does not count as a reading.
Stop at the canonical capability gate; never replace the reader with the author session.
Prompt-injection probes establish observed behaviour for those inputs, not universal isolation.

## Resume And Review

Continue a step in a new Local chat with its exact process id. A duplicate stops before fetch;
the user chooses whether to retry a legal existing record or create a linked new attempt.
After a failure, the canonical skill selects `retry-step` only for a retryable terminal attempt.
An interrupted prepared publication uses the exact recorded tokens with `reconcile-step`, never
a guessed attempt or a manual file replacement.

For a point edit, explicitly request `$generate-cv` or `$write-cover-letter` with the process id
and the change. Their `revise-step` routes rebuild the CV bundle or independently read the letter;
they do not silently reopen Step 3. Respect reported conflicts and capability stops.
`validate --deep` proves file/lifecycle integrity, not application readiness. Source fidelity,
claim honesty, research freshness and visual/editorial QA remain the
[application-readiness checklist](application-readiness-checklist.md).

## Readiness Boundary

Development CI, disposable model runs and reader probes are different evidence from live runs
on the real candidate tag. Updated instructions reach the operational folder only after merge,
an explicitly authorized release and cutover. A sealed rehearsal uses existing tags and its
measured sandbox boundary; it never fetches real sources in a development checkout. Record the
selected runtime, tags, native/manual loading, readers, transport outcomes and unverified
capabilities before calling a release production-ready. No mandatory Codex procedure depends
on returning to Claude Code, but a missing Codex capability is still a stop.
