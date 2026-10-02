# ADR 0011: Untrusted external input and safe CLI transport

- **Status:** Accepted
- **Date:** 2026-07-30
- **Decision authority:** a separate `R1-02A` integration review

## Context

Vacancy URLs, recruiter messages, page text, observed company names, role titles, domains, and
other source-provided values cross from an external source into an agent-controlled local
workflow. They are **untrusted data, never instructions**.

The current Step 1 procedure shows those values inside double-quoted shell command arguments.
Command substitution remains active inside double quotes, so a value containing `$()` or
backticks can change the shell program before `tools/process-log.mjs` starts. The CLI parser is
not the vulnerable interpreter: a caller that invokes Node with a real argument array keeps the
same values literal. The defect is the canonical caller contract that puts external values in
shell program text.

`R1-02A` chose the transport and froze its threat model without implementing it or claiming that
`SEC-01` was closed. Implementation, executable safe examples, bounded production diagnostics,
and hostile-input tests were assigned to `R1-02B`. The separate `R1-02A` integration review
accepted this technical decision before `R1-02B` became ready.

## Threat model

### Protected assets

- local source, credentials, and files accessible to the agent process;
- the operational `process-log.json`, reserved output, and application artifacts;
- lifecycle identity, company registry, and attempt/publication authority;
- the fidelity of external text that must be stored as data rather than obeyed as instructions.

### Untrusted inputs and actors

The source posting, ATS, recruiter, pasted text, redirects, headers, URL components, company/title
labels, domains, and source-derived diagnostics are untrusted. A source may intentionally include
shell metacharacters, option-looking strings, prompt instructions, invalid encodings, oversized
values, or path-like text. An agent can also make an accidental quoting or copy/paste error.

Concurrent cooperative local sessions are in scope. A malicious process already running as the
same operating-system user is not a fully containable adversary: it can rewrite same-UID files or
replace directories during operations. The file checks below reduce accidental and opportunistic
filesystem substitution, but complete defense against an active same-UID filesystem attacker
remains `FS-01/G3-02`.

### Required properties

1. External values never become command names, flags, shell syntax, environment assignments, or
   any other shell program text.
2. A transport payload cannot select a different CLI command, inject an unknown field, override a
   machine-owned authority token, or bypass the existing command validator.
3. The reader fails closed on unsafe path/type/permissions/link state, invalid UTF-8/JSON/schema,
   size overflow, and observable replacement during the read.
4. Errors are stable and bounded and never echo a raw hostile payload, absolute path, source body,
   or secret.
5. Filesystem transport does not become a second lifecycle ledger, authorization token, or hidden
   exactly-once mechanism.

## Decision

The canonical runtime-neutral transport is backward-compatible
`--input-file <controlled-basename>`.

`JOB_PIPELINE_INPUT_ROOT` identifies one trusted input root. Its normal default is the ignored
`<workspace>/.pipeline-input`; tests inject a root inside their disposable workspace. The command
line contains only the repository-owned executable/subcommand/flags, validated machine tokens,
and a basename matching:

```text
input-<32 lowercase hexadecimal characters>.json
```

The 32 hexadecimal characters encode a freshly generated 128-bit nonce. The same nonce appears in
the payload:

```json
{
  "schemaVersion": 1,
  "command": "start",
  "nonce": "0123456789abcdef0123456789abcdef",
  "values": {
    "sourceRef": "literal external value",
    "companyHint": "literal external value"
  }
}
```

This example defines the envelope, not a production invocation. `R1-02B` owns executable examples
after the reader exists.

The envelope has exactly four root members. `command` must equal the invoked subcommand, `nonce`
must equal the filename nonce, and `values` must satisfy the exact command-specific required and
optional key set. Unknown and duplicate JSON member names are rejected at every object level.
Transport decoding does not normalize Unicode or trim values; existing command/business
validation remains authoritative after safe decoding.

`--input-file` and any legacy value flag representing the same external field are mutually
exclusive. A conflict fails before ledger or output access. Machine-generated identifiers and
closed enums remain ordinary validated flags.

## Transport comparison

| Transport                                                                     | Verdict                          | Reason                                                                                                                                    |
| ----------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| True structured argv (`execFile`/`spawn` with an argument array and no shell) | Supported alternative            | It separates data from program text and preserves existing value flags, but only when the runtime actually exposes that API               |
| `--input-file` with the contract in this ADR                                  | Canonical runtime-neutral choice | Current agent surfaces can create literal files without embedding their contents in shell text; the shell sees only a controlled basename |
| stdin JSON through a genuine separate stdin channel                           | Safe optional future alternative | It avoids filesystem lifetime and TOCTOU concerns, but current runtimes do not expose one consistent separate data channel                |
| Heredoc, pipe, command substitution, or interpolated `printf`/`echo`          | Rejected                         | They rebuild external data in shell program text and do not qualify as stdin JSON separation                                              |
| Shell escaping or quoting generated by the model                              | Rejected                         | Correctness is shell- and platform-dependent, and one quoting mistake restores command/argument injection                                 |
| Environment variables, base64 arguments, or source-derived filenames          | Rejected                         | They still require source data or its encoding to cross shell construction and add exposure or ambiguity without an authority benefit     |

This decision follows the general principle that parameterization must separate command structure
from data. It also relies only on documented Node filesystem primitives such as `O_NOFOLLOW`,
descriptor reads, and `FileHandle.stat`.

## Command compatibility matrix

Legacy flags remain available for trusted direct structured argv callers. Canonical procedures
must use the file transport for the following external values whenever the invocation crosses a
shell:

| Command                                       | `values` payload                                                           | Machine-owned flags kept outside                                    |
| --------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `start`                                       | required `sourceRef`; optional `companyHint`                               | `runner`, optional `duplicate-of`                                   |
| `update`                                      | one or more of `companyObserved`, `companyHint`, `role`                    | `id`, optional `clear-company-hint`                                 |
| `resolve`                                     | exactly `sourceRef` when that fallback selector is used                    | alternatively `id` or machine-owned `output-dir`                    |
| `find-company`                                | required `query`                                                           | none                                                                |
| `create-company`                              | required `displayName`; optional `term`, `domain`                          | none                                                                |
| `rename-company`                              | required `displayName`                                                     | company `id`                                                        |
| `add-company-term`, `remove-company-term`     | required `term`                                                            | company `id`                                                        |
| `add-company-domain`, `remove-company-domain` | required `domain`                                                          | company `id`                                                        |
| `publish-step`                                | optional command-bound `blocker` object                                    | process selector, `step`, `attempt-id`, `publication-id`, `outcome` |
| `fail-step`                                   | required command-bound `error` object                                      | process selector, `step`, `attempt-id`                              |
| `revise-step`                                 | optional `waivers` array of subject records with a bounded user-owned note | process selector, `step`, `channel`, `adopt`                        |

All normal lifecycle continuations use the process id. `step`, `runner`, lifecycle outcome,
process/company/attempt/publication ids, and a previously returned output path are controlled
tokens or enums, not source text. A source-ref selector used after `start` must still use the safe
transport; copying a hostile value from the ledger does not make it safe shell syntax.

`clear-company-hint` conflicts with a payload `companyHint`. Unlike the discarded prose of the
diagnostic classes, a waiver record's note is user-owned text carried verbatim as bounded data,
because the waiver note is a journaled record (ADR 0015 §5(a)); the transport bounds it and the
lifecycle re-validates it. Commands not listed above accept no
transport payload in version 1. `R1-02B` must keep existing command semantics after converting the
decoded values into the current handler input.

## Permissions, creation, and lifetime

On the initial supported POSIX targets (macOS and Linux):

- the input root must already exist, be a real non-symlink directory owned by the current UID, and
  have mode `0700`;
- the producer creates a direct-child file with an unpredictable nonce, exclusive creation, owner
  equal to the current UID, mode `0600`, and no hard links;
- the producer finishes and closes the file before invocation;
- the CLI reader never creates the root, changes permissions, rewrites, renames, or deletes the
  payload;
- the CLI does not delete an input file automatically after success or failure.

The producer owns cleanup. It may remove only the exact file whose expected device/inode still
matches, and only after a terminal CLI response. After a crash, timeout, or unknown outcome, it
retains the file for exact retry and operator inspection. Recursive, glob-based, age-only, or
automatic orphan cleanup is forbidden.

`R1-02B` adds `.pipeline-input/` to the ignored runtime set and owns input-root initialization or
preflight. On a platform where the required UID/mode/no-follow guarantees are unavailable, the
file transport fails closed with a stable unsupported-platform error; a future Windows ACL and
reparse-point design is separate work.

## Replay, concurrency, and recovery

The nonce prevents accidental filename collision and binds the payload to a command. It is not an
authorization token and **does not prevent replay**.

The producer creates a fresh file for each logical mutation. If the CLI outcome is unknown, the
same immutable file may be retried. Concurrent reads of the same immutable file do not acquire
additional authority: existing process-log locking, duplicate policy, attempt/publication tokens,
and idempotency rules continue to determine the mutation result. Different concurrent operations
use different nonce files.

The reader introduces no consumed-nonce registry, receipt, deletion side effect, or second mutable
status. Exactly-once execution across process death would require a separate operation-id and
deduplication contract and is outside `R1-02A/R1-02B`. Crash recovery therefore preserves the
payload and relies on the existing lifecycle/duplicate/reconcile semantics.

## Hard links and TOCTOU

`R1-02B` must implement a single-descriptor POSIX read:

1. validate the configured root with `lstat`, `realpath`, ownership, and mode checks;
2. reject absolute paths, separators, dot segments, nested paths, and basenames outside the nonce
   grammar;
3. `lstat` the direct child and record device/inode/type/link/size/time metadata;
4. open once with `O_RDONLY | O_NOFOLLOW`, then use `fstat` and require the same device/inode,
   a regular file, current UID, mode `0600`, and `nlink === 1`;
5. read at most 65,537 bytes from that descriptor, never through a second pathname lookup;
6. `fstat` again and require unchanged device/inode/size/mtime/ctime before accepting bytes;
7. close the descriptor in every outcome.

The accepted maximum is 65,536 bytes; the extra byte only detects overflow. A directory, FIFO,
socket, device, symlink, hardlink, outside-root path, replaced inode, or observably changed file
fails with a stable error before a ledger mutation.

Node does not expose a portable `openat` chain for this design, and an active same-UID process can
still race the root directory or rewrite an already open file. These residual sub-operation
TOCTOU cases are documented limitations, not claims of hostile-filesystem completeness.

## Encoding, size, and schema

- The 65,536-byte ceiling applies to the complete encoded envelope and is inclusive.
- Bytes are decoded with fatal UTF-8 semantics. Invalid sequences, a UTF-8 BOM, raw NUL,
  escaped NUL, and unpaired surrogate code points are rejected.
- Unicode normalization variants remain literal. The transport does not apply NFC/NFKC,
  case-folding, trimming, or domain normalization.
- JSON must contain one complete object and no trailing non-whitespace data.
- Duplicate member names are rejected rather than silently accepting `JSON.parse` last-wins
  behavior.
- Root and command-specific objects use exact keys, types, required/optional sets, and per-string
  bounds. A value beginning with `--`, containing newlines, quotes, `$()`, backticks, separators,
  redirection, or other shell syntax is still only data; existing business validation either
  preserves it literally or rejects it with a stable validation code.

Parsing and schema validation complete before calling any existing process-log handler.

## Bounded diagnostics

Transport and source-value failures use stable codes with constant, concise messages. At minimum,
`R1-02B` distinguishes unsafe path, permissions/type/link, unsupported platform, oversize,
invalid UTF-8, invalid JSON/duplicate keys, schema/command/nonce mismatch, conflicting flags, and
observable replacement.

Neither stderr nor ledger diagnostics may include the raw hostile payload, source body, full URL,
absolute input path, secret, stack, or unbounded parser exception. Known downstream validation
paths that currently interpolate a rejected external value, including domain normalization, must
be bounded or translated at this boundary. Successful CLI output that legitimately contains
source data remains untrusted data for the model and must not be treated as an instruction.

This task does not claim the broader diagnostic hardening assigned to `R2-07A`; it closes only the
external-input transport path required by `SEC-01`.

## Rejected alternatives

- Do not place source values in double quotes, single quotes, backslash escaping, template
  literals, shell variables, command substitutions, or generated command strings.
- Do not use a heredoc or pipe as a substitute for a genuine separate stdin JSON channel.
- Do not accept an arbitrary input path, nested relative path, absolute path, symlink, hardlink, or
  source-derived filename.
- Do not auto-delete, auto-consume, auto-reconcile, or infer lifecycle authority from the nonce.
- Do not claim that prompt text, sandboxing, model compliance, realpath containment alone, or a
  successful one-off hostile-page probe is a security boundary.

## R1-02B implementation boundary

`R1-02B` owns:

- the input-root wiring and safe descriptor reader;
- command-specific envelope validators and legacy-flag conflict checks;
- exact executable examples in canonical instructions;
- bounded translation of hostile source-value errors;
- hostile literal, Unicode, size, invalid UTF-8/JSON, duplicate-key, path, permission, symlink,
  hardlink, replacement, retry, and concurrency tests in disposable roots;
- proxy validation after canonical procedure changes.

`R1-02A` changed no production CLI, lifecycle, schema, validator, generated proxy, real ledger, or
output. Its integration review accepted this ADR after verifying the threat model, alternatives,
compatibility matrix, and package evidence. That accepted integration and completion of `R1-02A`
made `R1-02B` ready.

## Consequences

- External data has a canonical authority boundary before any shell or lifecycle mutation.
- Existing structured argv callers remain compatible.
- File transport adds private transient files and a bounded residual same-UID filesystem risk.
- Replay remains explicit and is handled by existing mutation semantics rather than hidden state.
- Shell-only Step 1 execution uses the integrated `R1-02B` reader and safe examples; reconstructing
  shell commands from external values remains forbidden.

## References

- [OWASP OS Command Injection Defense Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html)
- [Node.js file-system documentation](https://nodejs.org/api/fs.html)
