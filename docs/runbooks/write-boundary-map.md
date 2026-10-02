# Map of the operational write boundary

Invariant numbers refer to the development gitflow runbook (in the private pre-switch archive).

## What measured the write-boundary table

The probes of 2026-08-24 and their transcripts are kept in the private development history; the
outcome of each probe is one cell of the table in pre-switch operational write boundary (in the private pre-switch archive).

## Operational fingerprints

The current owner of the procedure is this section.

One canonical read-only command, given the absolute path of the operational checkout:

```sh
node tools/operational-fingerprint.mjs \
  --root <operational-checkout>
```

The command returns one JSON record. For each measurement, record:

- `fingerprintVersion` and `hashAlgorithm`;
- `output.protected.inventory`: count/types/digest of the structure, empty directories included;
- `output.protected.content`: count/bytes/digest of the protected regular files;
- `output.metadata`: a separate count/types/bytes/digest of the exact `.DS_Store` allowlist;
- `ledger`: separate bytes/digest of the real `process-log.json`.

Only records with the same `fingerprintVersion` can be compared. A version mismatch is a mandatory
cutover/explanation event, never a `PASS`.

**For a task comparison, every leg is diagnostic.** A difference in the protected inventory, the
protected content or the ledger goes into the evidence as bytes and digest, before against after —
and that is all: the package is not blocked, the measurement is not repeated, and no explanation or
user confirmation is required. A metadata-only difference, and a comparison with the same-version
record of an earlier task, have exactly the same status. The reason is that prevention lives in the
boundary of pre-switch operational write boundary (in the private pre-switch archive), while the ledger and `output/` legitimately grow when the user works on
their own vacancies alongside the task: a gate that fires on correct behaviour is a defect, not a
protection. The record remains the only detector of a foreign write into the ignored `output/` and
the diagnostic of a boundary that has drifted. Who takes it and when is set by pre-switch protected-change procedure (in the private pre-switch archive), step 9:
three triggers, before and after the work, and one line "identical" in `## Result` — the full JSON
only when the records differ.

Two outcomes are not diagnostic. Any nonzero exit means the root, the topology, the entry
type/readability or the stability of the read was not proven; such a run creates no baseline. And
a cutover into `ops/current` under [ops-cutover.md](ops-cutover.md) keeps its own blocking
requirement that the records match: the user initiates a cutover on a deliberately quiet checkout,
which is not the same as an hours-long task next to live work.

The resolved root is printed only as a diagnostic and is not part of the hashes, so an absolute or
relative spelling and the caller's cwd do not change the protected evidence. The helper protects
against changes its descriptor checks and two full passes can observe; it is not an atomic snapshot
against a same-UID actor who managed to change the tree and fully restore it between observations.
A quiet operational checkout makes the record easier to read, but it is not a requirement on the
task: the task can neither check it nor ensure it.

The explicit legacy-to-v1 cutover and the first baseline are recorded in the private development
history; a legacy aggregate from append-only evidence is not compared with v1.
