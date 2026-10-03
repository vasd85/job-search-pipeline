# tools/publishability

Whether this tree is ready to be published, as a number rather than a reading.

This tool scans every tracked public path and also reads text such as a commit message before it
reaches public history. Report mode is the default and does not block findings. `--blocking` adds
a verdict; the aggregate gate uses it with the fictional layer's data-only allowances.

## What it looks for

Four classes. A class is the code a finding carries; the unit a reader acts on is the marker, and
below that the file.

| Class             | What it catches                                                                                     | Where the markers come from     |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------- |
| `personal_marker` | A line naming this candidate: surname, handle, employer, a country.                                 | the candidate layer             |
| `shared_template` | A leak that is a leak whoever it belongs to: a mail address, a home directory path, a vacancy link. | this directory                  |
| `private_path`    | A reference to a path that does not cross the border, or one into the candidate layer.              | this directory                  |
| `cyrillic_prose`  | A line of non-Latin script in a file where that script is prose, not data.                          | here; data paths from the layer |

The public markers are `template.email`, `template.home-path`, `template.hh-vacancy`,
`path.backlog`, `path.archive`, `path.research`, `path.audits`, `path.product-decisions`,
`path.candidate` and `text.cyrillic`. They are frozen as a literal in `markers.mjs`, this file
describes them in words, and `tests/publishability.test.mjs` freezes them a second time; the suite
ties all three, so no side drifts alone.

No marker here names a language. The engine knows one language by name, its default (ADR 0023,
decision 6), so the script class is written as a Unicode script property and the paths whose text
of a configured language is data arrive with the personal markers.

`path.candidate` requires a segment after the directory name. The layer's own name appears in
prose that documents the contract, and a bare name states where the layer goes rather than points
into its content.

## What is private, and why

The markers that name one candidate cannot ship with the engine: printed in the open, the list
would reveal exactly what it hides. They live in `candidate/publishability-markers.json`, beside
the profile, and reach this code as data. `candidate.example/publishability-markers.json` holds the
same shape for a fictional candidate, and the suite runs on that one.

The same file carries two more things, for the same reason: the places a personal marker is
allowed to match, and the paths whose text of a configured language is data. Which files hold
untranslatable text is a property of the configured language, not of the engine — an engine with no
configured second language has none, so the list is empty and the class reports nothing, which is
correct rather than a gap.

```json
{
  "schema_version": 1,
  "purpose": "prose for whoever opens the file; read by nobody",
  "markers": [{ "id": "identity.surname", "pattern": "<PCRE-compatible source>", "why": "…" }],
  "allow": [{ "marker": "geo.residence", "path": "tools/job-scorer/iso-3166.mjs", "why": "…" }],
  "cyrillic_data": [{ "path": "tools/<tool>/fixtures/<case>/", "why": "…" }]
}
```

A key the schema does not know is refused rather than ignored: a misspelled `markers` would leave
the personal set empty, which is a clean report nobody earned. A marker id that is already a public
one is refused too, because the report would then name one id for two patterns. Every marker and
every waiver carries a `why`, so a list somebody else wrote can still be narrowed.

**Name a marker by what it is, not by what it matches.** The report counts every declared marker,
including the ones that found nothing, so the ids are printed on every run — and a report gets
pasted into places the tree never reaches. `employer.1` reveals nothing; an id spelling the
employer's name walks straight past the rule that a finding never carries its matched text. The
tracked example follows this, and it is the only reason its ids look unhelpful.

`npm run candidate:check` says nothing about this file — it validates `config.json`. This file is
validated only by this tool.

## Allowances

A place is waived by the pair (marker, path), never by the path alone: one line can match two
markers whose verdicts differ, and a path-only key would silence both. A path ending in a slash is
a directory and matches on a segment boundary. Every entry carries a reason, because a waiver nobody can review is a waiver nobody will
narrow again.

Line numbers are deliberately not part of the key. A number goes stale on any edit above it, and
the waiver then misses and the gate reports a place it had already cleared.

The cost is real and bounded. The widest waiver covers a file of more than 1900 lines, so a genuine
address added to it later is not reported under that marker; what bounds it is that the classes are
independent, so a waived template never silences a personal marker on the same line.

Text with no path — a commit message — is waived by the exact matched literal instead. There is one
such entry: the attribution trailer every commit of this repository carries. Measured over the
whole history, that trailer accounts for 1256 of 1256 matches of the address template, so without
the waiver the check would report on every commit and, in blocking mode, refuse almost every commit
there is. The waiver removes its literal and scans what is left, so a real address beside the
trailer is still reported.

## Every tracked public path

The production CLI scans every path returned by `git ls-files`. No export filter hides files.
The report retains total/exported/excluded fields for API compatibility; tracked public findings
are exported findings, and blocking mode refuses them. Absent or unreadable tracked files refuse.

## A marker source is never read by a public marker

`markers.mjs` carries the patterns it searches for, `scan.mjs` carries the script property, this
file describes both in words, and the suite freezes them again. Without the rule the gate would
report itself on every run.

Two halves. `tools/publishability/` and `tests/publishability.test.mjs` are marker sources by
path. And any file named `publishability-markers.json` is one by name, wherever a copy of it sits,
because that file is a marker source by definition — the tracked example is the copy a scan of
this tree actually meets, and it was green only until the commit that tracked it.

The rule binds the public markers only. The personal markers read a marker source like any other
file, and the layer's allowances apply to it the same way: a real markers file copied over the
tracked example, or a real name pasted into a test, is found by a run with `--candidate-root` and
refused by `--blocking`. A marker source that no loaded marker applies to — every one of them in a
run without the layer — is stepped over before reading.

Two remainders. A public template leaking inside a marker source — an address, a home directory —
is invisible to the gate, bounded by what lives there: patterns and tests, no candidate fact. And a
personal pattern written with a backslash, such as an escaped dot, appears in its own JSON file
with the backslash doubled, so it does not find its own line in a copied markers file; the copy is
still refused by any pattern that is a plain literal, a surname or an employer, and one finding is
enough.

## Running it

```sh
npm run publishability
npm run publishability -- --candidate-root "$PWD/candidate" --list
npm run publishability -- --blocking --candidate-root "$PWD/candidate"
npm run publishability -- --commit-msg .git/COMMIT_EDITMSG --candidate-root "$PWD/candidate"
```

It prints one JSON object. `places` counts the lines carrying at least one match and
`places_exported` the ones inside the exported part; `scanned` is how many files were read,
`absent` how many tracked paths had no file on disk and `skipped` how many were marker sources
that no loaded marker applies to, stepped over before reading — the three add up to the paths git
listed, because no findings over no
files read is not the same statement as a clean tree. It exits non-zero on a refusal, or — with `--blocking` — when
the scan found anything **in the exported part** or a tracked file is absent. A finding inside the area the export leaves behind is
reported and never refuses: it does not reach a published tree. `--list` adds the findings themselves. A finding carries a path, a line number and
a marker id, never the matched text: a report that quoted its matches would become the thing the
gate looks for, and a report gets pasted into places the tree never reaches.

The `publishability` stage of `npm run ci` runs the report over the tree and passes whatever it
finds. It passes no candidate root, because no stage of the aggregate gate reads operator state —
the same reason `bootstrap --check` and `candidate:check` stay outside it. The consequence is
printed rather than hidden: the stage reports `personal_marker` as empty and
`"markers":{"personal":null}`, which means nothing was looked for, not that nothing is there. The
full scan is an operator command with `--candidate-root`.

## Commit and push protection

The [pre-push guard](../push-guard/README.md) scans commits, diffs and the branch name with the
private markers. Development sessions also scan PR titles and bodies before opening a PR. The
operational folder contains no git repository and installs no commit hook.

## Refusal codes

`publishability_markers_invalid`, `publishability_markers_schema_version_unsupported`,
`publishability_markers_unreadable`, `publishability_markers_root_invalid`,
`publishability_file_unreadable`, `publishability_file_not_text`,
`publishability_tracked_paths_unavailable`, `publishability_message_unreadable`,
`publishability_scan_invalid`. The CLI adds `invalid_publishability_arguments`. The list is frozen
against this file by `tests/publishability.test.mjs`.

None of them begins with `candidate_`: that list is frozen against `tools/candidate/README.md` by
`tests/candidate.test.mjs`, and a second reader of the layer may not extend somebody else's
contract.

## Blocking aggregate gate and data-only CI

The aggregate gate runs `--blocking --data-root <tracked fictional layer>`. This loads only
`cyrillic_data`, never that layer's personal markers or marker waivers. Each exact path declares
configured-language fixture input, detector vocabulary or syntax as data; public prose outside
those paths remains blocking. Public marker allowances name individual marker/file pairs with
reviewable reasons; they never silence personal markers. Missing tracked files also refuse the
aggregate gate. Ordinary diagnostics without either root load no candidate configuration.

Before pushing, the pre-push guard also scans personal markers, commit messages and the branch
name. Development sessions scan PR titles and bodies with the private marker set before opening
a PR, as [the development flow](../../docs/runbooks/development-flow.md#66-commit-push-pull-request) requires.
