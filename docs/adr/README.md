# Architecture decision records

An ADR records the context, decision and consequences of an engineering choice. Start with
[the architecture overview](../architecture.md) for the current boundaries, then read the relevant
record below. An accepted record can have amendments; its status and amendment sections govern
its interpretation. Runtime procedures and policies remain with their canonical owners.

This index covers engine decisions retained for publication. Personal decisions are outside its
scope. Numbering gaps are intentional. The development-flow and two-repository records describe
the published arrangement; their status notices identify when it takes effect.

| ADR                                                             | Decision                                                                                         | Status / reading note                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| [0001](0001-migrate-to-claude-code.md)                          | Migrate the job-search pipeline to Claude Code                                                   | Accepted                                                               |
| [0002](0002-memory-vs-files-precedence.md)                      | Files always outrank memory.md (precedence model 0a)                                             | Accepted                                                               |
| [0003](0003-honesty-floor-inviolable.md)                        | The hard honesty rules are an inviolable floor (precedence model 0b)                             | Accepted; explicit-deviation procedure amended by ADR 0017             |
| [0005](0005-title-normalization.md)                             | Title normalization — Senior only in the Summary headline (F3)                                   | Accepted                                                               |
| [0009](0009-runtime-neutral-instructions-and-process-search.md) | Runtime-neutral instructions and searchable process ledger                                       | Accepted                                                               |
| [0010](0010-file-backed-pipeline-artifacts.md)                  | File-backed application pipeline artifacts                                                       | Accepted                                                               |
| [0011](0011-untrusted-input-safe-cli-transport.md)              | Untrusted external input and safe CLI transport                                                  | Accepted                                                               |
| [0012](0012-versioned-extraction-and-vacancy-v2.md)             | Versioned extraction, source capture, and vacancy v2                                             | Accepted                                                               |
| [0013](0013-versioned-source-keys-and-identity-migration.md)    | Versioned source keys and the identity migration path                                            | Accepted                                                               |
| [0014](0014-development-backlog-replaces-remediation-queue.md)  | A development backlog replaces the remediation queue                                             | Accepted; development flow superseded by ADR 0024                      |
| [0015](0015-lightweight-post-review-revision.md)                | Lightweight post-review revision of published CV and cover letter                                | Accepted; explicit post-publication revision contract                  |
| [0017](0017-user-confirmed-honesty-deviation.md)                | User-confirmed deviation replaces hard refusal at the honesty floor                              | Accepted                                                               |
| [0021](0021-uncertainty-tolerant-triage-policy.md)              | Triage tolerates uncertainty — absent data scores a defined middle instead of ending the vacancy | Accepted; amended scoring configuration in ADR 0026                    |
| [0022](0022-three-lanes-derived-from-the-diff.md)               | Ceremony is three lanes derived from the diff, not two                                           | Accepted; development ceremony superseded in part by ADR 0024          |
| [0023](0023-public-engine-and-private-candidate-layer.md)       | Publish the engine, keep the candidate in a private layer                                        | Accepted                                                               |
| [0024](0024-two-repositories-one-snapshot.md)                   | Two repositories, one snapshot                                                                   | Accepted                                                               |
| [0025](0025-markets-are-candidate-configuration.md)             | Markets and the presented location are candidate configuration                                   | Accepted; replaces candidate-specific market and location decisions    |
| [0026](0026-scoring-values-are-candidate-configuration.md)      | Scoring values are candidate configuration                                                       | Accepted; amendments include independent ToolMatch dimensions          |
| [0027](0027-tool-prices-are-candidate-configuration.md)         | ToolMatch prices are candidate configuration                                                     | Accepted; amended to score main languages and frameworks independently |
| [0028](0028-domain-fit-placement-is-candidate-configuration.md) | Domain Fit placement is candidate configuration                                                  | Accepted; amended Domain Fit scale                                     |

For development, read [ADR 0024](0024-two-repositories-one-snapshot.md) alongside
[development-flow](../runbooks/development-flow.md). Older development ADRs explain the earlier
arrangement; they do not override the current procedure in that runbook.
