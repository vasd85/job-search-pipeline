# Running the real pipeline in Codex

This section applies only after the initial setup, once the operational checkout is bound to
`ops/current`. From the day of the switch the operational copy is not a checkout, and the last
section of this file applies.

## Open the right local project

1. Add the absolute path of the operational checkout to the Codex desktop app as a separate local
   project.
2. Create a new task inside that project.
3. Choose **Codex** and the **Local** mode, not **Worktree**.
4. Do not use Handoff from an implementation worktree to continue an application process.

A Codex-managed Worktree does not fit the operational pipeline: it is created from a commit in a
detached HEAD, and the ignored `output/` is not carried over automatically. The real ledger and
artifacts must stay in one permanent operational checkout.

A separate Codex task per vacancy is recommended, but all those tasks must use the same local
project `ops/current`. Different vacancies can be processed in parallel; never run two steps of
one process at the same time.

## Preflight of a new operational task

Before invoking a skill, the agent runs:

```sh
pwd
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git status --short
node tools/process-log.mjs validate --deep
npm run candidate:check
```

Expected:

- `pwd` and the repository root equal the exact path of the operational worktree;
- the branch is `ops/current`;
- the source files match the recorded operational release;
- `validate --deep` passes;
- `npm run candidate:check` prints `"status":"ready"` — the candidate layer and the corpus of letter
  corrections in `records/` have been read; a refusal names a code and a file, and the skill is not
  started;
- there is no unexpected source diff, lock or prepared publication.

If the path or the branch does not match, the agent does not run `git switch` and does not start
the pipeline. Close the task and open a new Local task in the right project.

## Explicit Codex skill invocations

Every step is started by a separate explicit message. Codex uses the name of the native skill with
the `$` prefix.

A new vacancy, Step 1:

```text
Run $get-vacancy for the vacancy:
<VACANCY_URL>

Run Step 1 only. Work in the current ops/current checkout, run the operational preflight,
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

## From the day of the switch

The operational copy is the `job-search-pipeline/` folder without `.git`, assembled from an engine
tag and a private-layer tag ([ops-cutover.md](ops-cutover.md), the section "Cutover of the
operational folder"). The `ops/current` branch no longer exists, and the git commands of the
preflight above do not apply to the folder. Everything else above still applies, and every mention
of the operational checkout or `ops/current` in it means the operational folder; in the Step 1
message the phrase "Work in the current ops/current checkout" is replaced by "Work in the
operational folder".

1. The local project in Codex is the absolute path of the operational folder.
2. Preflight before invoking a skill:

   ```sh
   pwd
   npm run preflight
   node tools/process-log.mjs validate --deep
   npm run candidate:check
   ```

   Expected: `pwd` equals the path of the operational folder; `npm run preflight` is green — it
   also checks the folder against its manifest and names the tags; `validate --deep` passes;
   `npm run candidate:check` prints `"status":"ready"`. A refusal is a stop: the skill is not
   started.
3. Whether Codex opens a directory without `.git` as a project has not been measured. If it does
   not, stop and ask the user.
4. Codex does not run the write guard: the ban on writing outside the folder is a rule for it, not
   a mechanism ([development flow document](development-flow.md), [Write boundary and the second runner](development-flow.md#12-write-boundary-and-the-second-runner)).
