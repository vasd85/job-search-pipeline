# Running the real pipeline in Codex

The operational copy is the `job-search-pipeline/` folder without `.git`, assembled from an engine
tag and a private-layer tag ([ops-cutover.md](ops-cutover.md)).

## Open the right local project

1. Add the absolute path of the operational folder as a separate local project.
2. Create a new task in that project, choosing **Codex** and **Local**.
3. Keep all vacancy tasks in the same permanent folder. Different vacancies may run in parallel;
   never run two steps of one process at the same time.

Whether Codex opens a directory without `.git` as a project has not been measured. If it does
not, stop and ask the user. Required reader support and live validation follow the capability
stops in [codex-development.md](codex-development.md#operational-readiness).

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
Codex's ban on writing outside this folder is procedural:
[write boundary](development-flow.md#12-write-boundary-and-the-second-runner).

## Explicit Codex skill invocations

Every step is started by a separate explicit message. Codex uses the name of the native skill with
the `$` prefix.

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

Files, not chat, carry data between the steps. So Steps 2–5 can continue in new tasks, provided
they are opened as Local tasks of the same operational project and receive the exact
`PROCESS_ID`.
