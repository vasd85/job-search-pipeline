# File-backed pipeline deterministic fixtures

Automated contract tests use synthetic artifacts and temporary lifecycle roots. They do not fetch a
real vacancy, research a real company, generate personal application materials, or mutate the
repository's `process-log.json` and `output/`.

## Fixture owners

- `tools/pipeline-artifacts/fixtures/` contains deterministic Step 1 and Step 2 bundles, including
  completed, blocked and invalid cases. The `vacancy-v2-completed` vacancy and the
  `research-v2-over-vacancy-v2` research over it are the versions a publication writes; each
  completed vacancy names a market of the example candidate.
- `tools/application-brief/fixtures/application-brief.v4.valid.json` is complete schema-v4 test
  data over those two. It is not a content template for a real application.
- `tests/fixtures/process-log-v3.mjs` constructs historical/file-backed ledger records and lifecycle
  states for validation, transition, publication, recovery, and deep-health tests.
- `tests/pipeline-contract-scenarios.test.mjs` exercises deterministic downstream brief/CV/letter
  contracts without running model-owned skills.
- `tests/fixtures/file-backed-pipeline-producer.mjs` is the selector-only deterministic producer
  used in both child-process and single-parent boundary runs.
- `tests/file-backed-pipeline-e2e.test.mjs` publishes all five step bundles through the real
  resolver/preflight/publisher lifecycle on temporary roots and compares both session topologies.
- `tests/process-log-v3-*.test.mjs` exercise the lifecycle core and production CLI with injected
  temporary ledgers, workspaces, and output roots.

## Isolation requirements

Lifecycle, integration, CLI-child, and server scenarios must obtain their root from
`tests/fixtures/disposable-workspace.mjs`; they must not mark or adopt an existing directory.
The factory creates a temporary workspace containing its own `process-log.json`, `output/`, and a
nonce-bound `.job-pipeline-disposable-workspace.json` marker. The marker binds the creator's
lexical path and canonical realpath, so a repository root, copied marker, different
ledger/output, or symlink alias fails before fixture mutation.

CLI and lifecycle child processes receive the complete capability:

```text
JOB_PIPELINE_PROCESS_LOG
JOB_PIPELINE_WORKSPACE_ROOT
JOB_PIPELINE_OUTPUT_ROOT
JOB_PIPELINE_DISPOSABLE_ROOT_TOKEN
```

The child validates the marker and all four variables itself; a parent-only check is insufficient.
Changing only the ledger path is not sufficient: the default output root would still point at the
real checkout. Tests must also use synthetic source refs and transaction ids and must not inspect
historical output directories. This test-helper/API boundary is fail closed without runtime hooks;
no deployed hook is part of the isolation proof.

## Boundary scenarios

The WP6 scenarios use deterministic producers at the same boundaries as real steps:

1. publish a validator-valid Step 1 bundle;
2. start a new child process that receives only a process selector and reads Step 1 files;
3. publish Step 2, then start another selector-only consumer for Step 3;
4. have Step 4 and Step 5 consumers read only the committed brief and permitted canon;
5. pass no previous stdout/chat payload between child processes.

A second sequential scenario runs every boundary in one parent process but still forces each step
to resolve and reread committed files. The test deep-validates both runs and requires identical
artifact bytes, metadata, attempts, revisions, and input snapshots.

Negative cases delete or alter an upstream file, use another process's artifact, leave only staging
bytes, provide an ambiguous selector, or drift a protected canonical input. Each must fail at
preflight/publication without adopting bytes or changing the last committed bundle. Protected
candidate-profile drift after Step 3 is classified as stale input; only changed committed artifact
bytes are corrupt.

These scenarios test the file/resolver/publisher contract. They are not a new orchestrator and do
not execute the natural-language skill procedures as programs.

Run the focused WP6 scenarios with:

```sh
node --test tests/file-backed-pipeline-e2e.test.mjs
```
