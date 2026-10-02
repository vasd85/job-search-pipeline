# Claude Code / Codex runtime smoke checklist

Use this checklist when a change touches any of these paths. The globs are the trigger the
development gitflow runbook pre-switch development procedure (in the private archive) reads; prose that has to be interpreted is not a trigger.

```text
instructions/operating-contract.md
instructions/pipeline-run.md
instructions/skills/**
tools/sync-agent-proxies.mjs
```

Every step below is marked with where it can actually run. The mark is a fact about the step, not
a preference: a development session owns no real `process-log.json` (gitflow invariant 2) and may
not invoke a pipeline skill for real (invariant 6), so the steps that need either of those are
executable only at cutover, in the operational checkout.

1. **[gate]** Run `node tools/sync-agent-proxies.mjs --check`. Already enforced on every
   aggregate run: `tests/proxies.test.mjs` executes it against the repository root and requires
   `status: current` with 26 files and no drift. A development session records that the gate
   covered it rather than running it a second time.
2. **[cutover]** Run `node tools/process-log.mjs validate` — it resolves the real ledger.
3. **[cutover]** Confirm both runtimes discover `get-vacancy` from their native skill directory.
4. **[cutover]** Record the checksum or Git diff of `process-log.json`.
5. **[cutover]** In Claude Code, invoke `get-vacancy` with a `source_ref` already present in the
   log. Expect:
   - the proxy reads `instructions/skills/get-vacancy.md` first;
   - `runner_id` resolves to `claude-code`;
   - the CLI reports `status: duplicate` before any vacancy fetch;
   - no new process is written unless the user explicitly chooses a new attempt.
6. **[cutover]** Repeat in Codex. The expected behavior is identical except `runner_id` resolves
   to `codex`.
7. **[cutover]** Confirm `process-log.json` is byte-for-byte unchanged and no output directory was
   created.
8. **[cutover]** Run `npm run candidate:check` in the operational checkout. Expect `status: ready`
   and the real candidate's counts — the example has five levers, one letter sample and seven
   rules, so those counts are what tells the real layer from a copied example. The layer's files
   arrive by the transfer step of [docs/runbooks/ops-cutover.md](runbooks/ops-cutover.md), which
   runs before this check.

So a development session whose diff matches the globs above owes one line in its `## Result`: the
globs matched, the gate covered step 1, and steps 2-8 are owed by the next cutover. That is the
whole of it — and it is the honest shape, because no archived task ever executed the live steps
and every one of them carried the same disclaimer instead.

Run live agent smoke tests only in a trusted environment: each runtime may send repository context to
its configured model provider. The automated test suite validates the same proxy, runner, duplicate,
and no-mutation contracts without transmitting workspace contents.
