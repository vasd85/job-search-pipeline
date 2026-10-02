# Architecture overview

The pipeline combines model-driven reading and writing with deterministic decisions, validators
and file publication. It serves one candidate at a time. The public engine defines procedures
and formats; a candidate layer supplies the person's facts, preferences and evidence. This is a
map of the implementation, not a second source of application rules.

## The three principles in practice

**The model observes, code decides.** In batch triage, the agent extracts a normalized observation
object from the vacancy. [The scorer](../tools/job-scorer/) validates it and computes mobility,
compensation, skills and domain-fit components, plus the final decision and trace. Candidate
values come from configuration; branch logic belongs to code. The
[scoring rubric](../knowledge/job-match-rules.md) owns the policy. Missing data and contradictions
have distinct outcomes ([ADR 0021](adr/0021-uncertainty-tolerant-triage-policy.md)). Model judgment
still matters when interpreting a source and selecting evidence; a deterministic scorer cannot
prove that the observation was correct.

**A result is a file with provenance.** Each per-role step consumes verified files and publishes
another bundle. Content digests connect that bundle to its inputs and lifecycle record. The
process log records attempts, failures and publication state. Application materials and journals
stay in the operational folder; Git versions the engine and candidate sources. A session can
resume from a process selector on the same filesystem without recovering an earlier conversation
([ADR 0010](adr/0010-file-backed-pipeline-artifacts.md)).

**A check must be able to fail.** Validators reject specific broken conditions, and instruction
pins hold explicit expectations independent of the document under test. Mutation checks test
whether a deliberate break is caught when the development procedure requires them. A passing
schema proves shape and consistency, not that a quotation matches a live page or that a letter
reads well. The [readiness checklist](runbooks/application-readiness-checklist.md) covers the
human review that remains, and [README Checks](../README.md#checks) names the gate's limits.

## Two paths through the engine

| Path | Model work | Deterministic work | Persistent result |
| --- | --- | --- | --- |
| Batch triage | Read captures, extract observed facts and evidence | Fetch pages, validate observations, score, verify the batch | Captures, inputs, traces, batch record and triage ledger |
| Per-role application | Capture the JD, research the company, select evidence, write materials | Validate inputs and bundles, build DOCX, journal publication and recovery | Vacancy files, company research, application brief, CV and letter |

The batch capture layer writes page bodies directly to disk. Adapters report when they cannot
deliver a page so the agent can use the browser fallback. Captures carry digests and source
metadata. A browser transcript's digest establishes its subsequent integrity; it cannot establish
that the transcript equals the source. [Vacancy-fetch](../tools/vacancy-fetch/README.md) owns the
transport contract, and [triage verification](../tools/triage-verify/README.md) checks the chain
between captures, quoted evidence, scorer inputs and traces. Consistent artifacts can still share
a mistaken extraction; the procedure includes independent probes with a bounded cadence.

For a selected role, the five steps are `get-vacancy`, `research-company`, `map-experience`,
`generate-cv` and `write-cover-letter`. Step 3 records the chosen facts, positioning, ATS terms
and CV plan in an [application brief](../tools/application-brief/README.md). Steps 4 and 5 consume
those decisions independently. Their shared input is a versioned artifact rather than decisions
reconstructed from chat. [Pipeline-run](../instructions/pipeline-run.md) owns step order;
[pipeline-artifacts](../instructions/pipeline-artifacts.md) owns publication and prerequisite checks.

## Boundaries that keep the paths reliable

| Boundary | Implementation and reason |
| --- | --- |
| Public engine / candidate data | [Candidate loader](../tools/candidate/README.md) reads a root supplied explicitly. Schemas, typed constraints and language packs separate general policy from personal facts. Tests use the fictional `candidate.example/` ([ADR 0023](adr/0023-public-engine-and-private-candidate-layer.md)). |
| Development / live applications | The published operational folder exports an engine release tag and a candidate tag, with manifests checked against their file bytes. Development changes reach it through an explicit cutover ([ADR 0024](adr/0024-two-repositories-one-snapshot.md), [ops-tree](../tools/ops-tree/README.md)). Until the switch, runbook status notices name the older worktree arrangement. |
| External data / executable commands | Vacancy text, URLs and company labels are untrusted data. Shell-facing lifecycle calls use a structured input file, never external values assembled into shell program text ([ADR 0011](adr/0011-untrusted-input-safe-cli-transport.md)). |
| Files / lifecycle records | The CLI reserves output paths, validates staged bundles, locks each read-check-write transaction and journals atomic replacement. An interrupted publication is reconciled against a valid complete bundle before it can proceed ([ADR 0010](adr/0010-file-backed-pipeline-artifacts.md)). |
| Canon / runtime wrappers | Runtime-neutral procedures live in `instructions/`; generated Claude Code and Codex wrappers load them. Runtime discovery does not own the policy ([ADR 0009](adr/0009-runtime-neutral-instructions-and-process-search.md)). |
| Valid material / ready application | Honesty rules and candidate constraints limit claims; manual review verifies sources, attribution and the finished documents. The authority and explicit-deviation procedure belong to [precedence](../knowledge/precedence.md) and [ADR 0017](adr/0017-user-confirmed-honesty-deviation.md). |

The local [process search server](../tools/process-search-server.mjs) is another reader of that
state. It validates the ledger on each request and serves allowlisted artifacts by recorded kind.
It has no mutation endpoints and does not expose an arbitrary output-directory file server.

## Where to read next

- [ADR index](adr/README.md): the rationale, amendments and consequences behind these choices.
- [Operating contract](../instructions/operating-contract.md): authority, languages and source ownership.
- [Generation rules](../knowledge/generation-rules.md): the writing and honesty policy.
- [Development flow](runbooks/development-flow.md): task execution, independent review, PRs and release.
- [Example candidate](../candidate.example/): the complete fictional input used by verification.

The overview carries no historical performance claims. Measurements and the limits of an
individual experiment belong to its evidence; an accepted decision and its consequences belong
to the ADR that records it.
