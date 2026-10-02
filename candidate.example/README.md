# candidate.example

A fictional candidate, tracked in Git, of the same shape as the private layer beside it. The test
suite reads this directory and never the real one, so a rule that still assumes one particular
person turns a check red here instead of passing unnoticed.

Nothing in here describes a real person, and nothing in here is authoritative for a real run.

## Making a working copy

The private layer lives in `candidate/`, which Git ignores. In a disposable test root or a
rehearsal worktree `npm run bootstrap:init` creates it from this example. In the operational
checkout, where real applications are produced, nothing is copied from here: the config, the
profile, the lever bank, the rules, the letter samples, the letter reader's examples, the memory and
the language packs of the real candidate arrive by the cutover step of
[docs/runbooks/ops-cutover.md](../docs/runbooks/ops-cutover.md). The files
of this example never reach the operational layer: a fictional profile there would end up under a
real cover letter, and a fictional config would size a real letter and name a real CV.

## What lives here

- `config.json` — the configured values, carrying `schema_version` and the keys the schema
  declares. The numbers are the ones the suite's letter fixtures are written for; the CV file name
  and the letter signature carry this candidate's own name. It configures one language beside the
  default, Greek, and keeps the default as the working language.
- `constraints.json` — the personal rules a machine can check: a phrase that must never appear, a
  term preferred over another, a word with one correct spelling. One entry of each type, about a
  candidate who does not exist.
- `profile.md`, `levers.md`, `letter-samples.md` — the profile, the lever bank and one accepted
  letter of a candidate who does not exist, each in the form
  [tools/candidate/README.md](../tools/candidate/README.md) owns. Its two AI properties sit on
  other lever numbers than a real bank is likely to use, so a rule that still keys on a number
  turns a check red here.
- `rules.md` — the candidate's own rules, at least one for each of the six read points, so the
  suite checks that every skill that names a point has a rule to read there. The form is owned by
  [tools/candidate/README.md](../tools/candidate/README.md).
- `languages/Greek/` — the pack of the configured language: its script, locale, subject word and
  signature, one required spelling, its writing rules and five pins — one letter the gate must
  accept and four it must refuse, each for one reason. Greek is written in neither Latin nor
  Cyrillic, so the suite checks the script rule in both directions without the public tree carrying
  a language the real layer configures. The form is owned by
  [tools/candidate/README.md](../tools/candidate/README.md).
- `memory.md` — a short memory file of the same candidate: the shape of the layer's file-based
  memory, free but for the `## Open questions` heading the manifest requires.
- `letter-reader-examples.md` — one invented finding under each of the four headings the manifest
  requires. It shows the file's shape and is no calibration of the letter reader: a reading in a
  disposable root or a rehearsal worktree gets these examples, not real ones.
- `manifest.json` — the layer manifest: the files every layer holds, which are required, and the
  headings each markdown file must carry. The real layer is checked against this file and carries
  none of its own. Owned by [tools/candidate/README.md](../tools/candidate/README.md).
- `publishability-markers.json` — the markers that name this candidate, the places they are
  allowed to match, and the paths whose text of a configured language is data rather than prose.
  None of it can live in the public tree: printed in the open, the list would reveal exactly what
  it hides. Owned by [tools/publishability/README.md](../tools/publishability/README.md).
- `machine/` — the templates of the machine that hosts the operational folder: its local Claude
  Code settings and the backup LaunchAgent, with placeholders for the paths. Rendered into fixed
  targets by `npm run setup:machine -- --operational`; owned by
  [tools/setup/README.md](../tools/setup/README.md).

The constraint entries here are also a fixture. The end-to-end suite copies this directory into a
disposable workspace and publishes a cover letter that breaks one of them, so changing the wording
of an entry turns that test red until the fixture letter follows.

The contract, the reference form a rule uses to name a key, and the refusal codes are owned by
[tools/candidate/README.md](../tools/candidate/README.md).
