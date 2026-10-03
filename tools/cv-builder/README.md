# cv-builder — shared CV renderer

The build infrastructure for `/generate-cv`. It exists **once, here**, so the agent never
re-scaffolds a `build.js` + `package.json` + `node_modules` inside each `output/<company-role>/`
directory. Per run the agent writes **only the CV content** as a `cv.json` and calls the renderer.

ATS-safe layout is baked into [render.js](render.js). All build and QA stages run through the single
entrypoint documented below.

## Use it (from the repo root)

```bash
# Targeted CV: application-brief.json is resolved next to cv.json by default.
tools/cv-builder/build.sh output/<company-role>/cv.json

# Explicit equivalent:
tools/cv-builder/build.sh output/<company-role>/cv.json \
  --brief output/<company-role>/application-brief.json

# General CV with no vacancy/process brief:
tools/cv-builder/build.sh output/<general-cv>/cv.json --general

# A runtime-mandated Python renderer still runs through the same entrypoint:
tools/cv-builder/build.sh output/<company-role>/cv.json \
  --docx-renderer /absolute/path/to/render_docx.py \
  --python /absolute/path/to/python
```

The file-backed pipeline publisher uses the same entrypoint in controlled staging mode:

```bash
tools/cv-builder/build.sh \
  output/<company-role>/.pipeline-tmp/<publication-id>/cv.json \
  --brief output/<company-role>/application-brief.json \
  --pipeline-staging-dir output/<company-role>/.pipeline-tmp/<publication-id>
```

`--pipeline-staging-dir` is an opt-in targeted-build override. The publisher must create a fresh
direct child of `.pipeline-tmp/` containing only candidate `cv.json` before invocation. The builder
revalidates the brief's reserved `process.outputDir`, rejects symlinked or escaping workspace,
output, staging, brief, and candidate paths, writes the candidate DOCX beside staged `cv.json`, and
keeps PDF/PNG QA under the staging directory's `qa/` child. A non-default checkout root may be
injected with `--workspace-root`; that flag is accepted only in controlled staging mode.

The builder never copies, renames, or replaces canonical `cv.json` or DOCX files in controlled
staging mode. Validation, rendering, structural-QA, or page-gate failure may leave only
transaction-owned staging files. The lifecycle publisher introduced by the file-backed pipeline is
the sole component allowed to replace the canonical two-file CV bundle after visual QA passes.

`build.sh` first validates the installed dependency graph against this directory's committed
lockfile. It never invokes npm or installs packages. Run
`npm ci --prefix tools/cv-builder --ignore-scripts --no-audit --no-fund` during explicit repository
setup; a missing or drifted package fails before CV parsing or rendering.

The builder writes only `<fileName>.docx` next to `cv.json`, then prints one JSON result with the page
count, structural checks, QA directory, `qaPdf`, and every `page-<N>.png` path. PDF is necessary as a
pagination intermediate because DOCX itself has no stable page-count model; it is not an application
deliverable and remains in the QA directory with the PNGs. Exit code `3` means the CV is over its
page budget. `node_modules/` is gitignored and is never reconstructed during a production build.

The page budget is the candidate's own value, `cv.page_budget` in `candidate/config.json` of the
workspace root the build serves — the checkout, or `--workspace-root` in controlled staging mode.
The CLI reads it before anything is rendered and refuses under the layer's code when the layer or
the key is missing; there is no default. `executeBuild` takes it as `options.pageBudget` and never
reads the layer, so a test passes it and the suite stays off the operator's real layer.

### LibreOffice backend selection

Without `--docx-renderer`, the builder selects a safe LibreOffice backend without starting a probe
process:

1. `CV_BUILDER_HEADLESS_SOFFICE`, when it names an absolute executable path supplied by the current
   runtime;
2. a runtime-provided `dependencies/bin/override/soffice` found anywhere in `PATH` (so a system
   Homebrew wrapper earlier in `PATH` cannot shadow a bundled headless build);
3. on macOS only, a separate LibreOffice instance started through LaunchServices;
4. the normal `PATH` `soffice` behavior on non-macOS systems.

The direct system-GUI `soffice` path is deliberately forbidden on macOS. Current macOS versions may
abort that process during AppKit registration when it is launched from a desktop-agent sandbox,
even with `--headless`.

Every native LibreOffice conversion receives a fresh `qa/libreoffice-profile-*` directory through
`-env:UserInstallation`. The macOS fallback also uses `open -n -W` and background/headless flags, so
it starts a new process instead of attaching to an already-running user LibreOffice instance. The
user's normal profile and open documents are not reused or closed. Conversion still has a bounded
timeout and is accepted only when a non-empty PDF is actually produced.

Codex Desktop normally resolves its bundled headless override automatically. Claude Code Desktop,
or any other runtime, may either expose an equivalent override in `PATH`, set
`CV_BUILDER_HEADLESS_SOFFICE`, pass `--docx-renderer`, or use the macOS LaunchServices fallback.
Desktop sandboxes that restrict GUI application launches may require approval for `/usr/bin/open`;
the builder never retries with a direct system-GUI launch.

`CV_BUILDER_LIBREOFFICE_APP` may override `/Applications/LibreOffice.app` with another absolute
application path. It affects only the LaunchServices fallback. Runtimes that mandate their own
`render_docx.py` pass it to the same command; a second render command is never needed.
`--docx-renderer` is an explicit trust boundary: the builder invokes that runtime-provided renderer
as supplied and cannot validate which office application it may launch internally.

## cv.json schema

Use [cv.example.json](cv.example.json) as the shape-only starting point. It documents the top-level
file, font, header, and section fields with instructional placeholders; it is never a content
source. The notes below define the non-obvious rich-text and pagination behavior.

Top-level typography controls:

| Field        | Behavior                                                                |
| ------------ | ----------------------------------------------------------------------- |
| `font`       | Optional; `Calibri` by default. Allowed: `Calibri`, `Arial`, `Georgia`. |
| `bodySizePt` | Optional body size in points; `10.5` by default, minimum `10`.          |
| `nameSizePt` | Optional name size in points; `16` by default, clamped to `14`-`18`.    |

### Run atoms

A bullet, or any rich text, is either a **plain string** (one normal run) or an **array of run
atoms**. A run atom is `{ "t": "text", "b": true, "i": true }` — `t` text (required), `b` bold,
`i` italic. Use bold for the lead-in of Selected Impact / Projects bullets and the Skills label;
use italic for the per-role stack line (handled automatically by `stack`).

### Links

Every address a CV states renders as a hyperlink, styled as one, and the author never marks it:
[cv-links.mjs](cv-links.mjs) derives the link from the text, for every run the renderer writes.
Four shapes link — `http://` or `https://` with a host (the text is the target), `www.` with a host
(`https://` is prepended), a scheme-less `host.tld/path` whose host is lowercase and whose TLD is on
the module's list (`https://` is prepended), and an e-mail address whose domain passes the same host
rule (`mailto:`). Trailing sentence punctuation and an unbalanced closing bracket stay outside the
link. Everything else is text: `Booking.com` has no path, `Node.js/TypeScript` no listed TLD,
`ASP.NET/C#` no lowercase host. An address outside those shapes links once it is written with its
scheme.

### Section types

| `type`       | renders                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `summary`    | one prose paragraph (positioning only — keep metrics out, [the playbook's Summary](../../knowledge/targeted-cv-playbook.md#42-summary)) |
| `bullets`    | a bulleted list (Selected Impact, Projects, ...)                                                                                        |
| `skills`     | `Label: body` lines, label bold                                                                                                         |
| `experience` | per role: bold `Company - Title - Dates`, optional italic `stack`, then bullets                                                         |
| `lines`      | one paragraph per line (Education, certifications)                                                                                      |

### Pagination controls

Pagination is normally automatic and based on paragraph relationships:

- `keepNext` on a section or role heading asks Word to keep it on the same page as the following
  paragraph. When a role has a stack line, `keepNext` is chained from the role heading to the stack
  and from the stack to the first bullet, so the role does not open at the bottom of a page without
  evidence beneath it.
- `keepLines` on each bullet asks Word not to split that individual bullet between two pages. Word
  may move the complete bullet to the next page; it does not force all bullets for a role together.
- `pageBreakBefore: true` forces that one role to start on a new page. Use it only after visual QA
  still shows an illogical split; it is a per-document layout decision, never a company rule.

These are pagination preferences evaluated by Word/LibreOffice, not absolute grouping of an entire
section. The page-budget gate and PNG inspection remain necessary.

## Targeted preflight contract

Targeted builds first validate the adjacent `application-brief.json` — its vacancy language against
the language names of the workspace's candidate layer, or of the layer `--candidate-root` names for
`preflight.mjs`; without that flag only the default language is accepted — then compare `cv.json`
with its `cvPlan`: structure, header/project decisions, evidence and ATS placements, exclusions, and
skill groups. The application-brief validator owns schema and reference integrity; the preflight
owns agreement between the validated plan and rendered CV content.

### Revision mode (ADR 0015)

`--revision` (targeted builds only) switches the brief-coupled preflight from aborting to
classifying: the DOCX still renders, and the summary carries `conflicts` and `notices` with the
subject keys the lifecycle journals. `--revision-waivers <waivers.json>` passes the step's active
waiver records (as returned by `revise-step`); a waived finding is reported as a notice naming its
waiver id instead of a conflict. The page-budget gate, structural DOCX QA, the punctuation gate, and
every staging-safety rule stay hard in revision mode. The staging freshness contract is unchanged:
every build run — including a revision rebuild — starts from a fresh staging directory containing
only candidate `cv.json`. Two consequences for a rebuild: clear the previous run's own outputs (the
candidate DOCX and the `qa/` child) before rerunning, and keep the waivers file outside the staging
directory — it counts as an extra entry there like any other file.

## Reverse sync: DOCX to cv.json ([ADR 0015, channel (c)](../../docs/adr/0015-lightweight-post-review-revision.md#5-edit-channels-and-transports))

`docx-extract.mjs` maps a document the user edited in place back onto the `cv.json` it was rendered
from. It is a separate entrypoint, not a build stage, and it runs on Node built-ins alone — the
nested `node_modules` is neither needed nor consulted.

```bash
node tools/cv-builder/docx-extract.mjs <edited.docx> --cv <cv.json> \
  [--write <cv.json>] [--expect-sha256 <64 hex>] [--ignore-unmappable]
```

The `cv.json` is the model, never the document. The tool plans the paragraphs `render.js` would
produce from that source, aligns them with the document's own paragraphs, and replaces string values
that already exist in the source — so `fileName`, `font`, `bodySizePt`, `nameSizePt` and a role's
`pageBreakBefore`, which the document does not carry, survive by construction. Edits are applied to
the committed bytes as string spans, so a point edit stays a point edit and an unedited document
leaves the file untouched byte for byte.

It prints one JSON report: `changes` (mapped edits, each with `path`, `before` and `after`),
`unmappable` (edits it refused to guess, each with a `code`, a `location` and a `detail`), `notices`
(what it saw and deliberately did not carry over), `written`, and `unmappableIgnored`. `--write`
updates the file `--cv` named, in place, through a create-then-rename, and must name that same
file — a mistyped target cannot overwrite the archived document, or anything else, with CV source. `--expect-sha256` refuses a
document whose digest is not the expected one. Exit code `4` means at least one unmappable finding:
the tool writes nothing while one stands, and `--ignore-unmappable` records the user's decision to
drop them all and apply the rest — the exit code stays `4` either way, and `unmappableIgnored` is
what tells the two apart.

A document is read only within declared bounds: 4096 paragraphs, 2048 tags in any one of them, 256
body elements the model cannot carry. The paragraph bound is generous because the input is a
document a word processor has been editing — Word splits runs and hangs property tags off each one
— and it is what keeps reading one paragraph from costing quadratic time in what it nests.

The report is read into an agent's context, so it is bounded on the way out: every free-text field
is capped with an explicit `... (+N characters)` marker and each list stops at 100 entries with the
remainder counted. The edits themselves are applied in full — only the reader's copy is capped.

A change is applied only when its inverse is faithful and unique. Reported instead, never guessed: a
section heading, which renders uppercased and cannot be spelled back; a run structure that no longer
addresses the source's atoms; a role heading whose `Company - Title - Dates` line moved more than one
field at once, or moved one in a way that reads as two; a paragraph the document added, dropped, or
took out of its list while editing it; tracked changes, comments, tables, line breaks, fields and
drawings; a hyperlink the derivation above does not produce — on text that is not an address
(`hyperlink_not_derivable`) or pointing somewhere other than its address
(`hyperlink_target_mismatch`); text carrying punctuation the rule 21 gate below would reject; and text carrying a
character a reader cannot see — the tool takes those from Unicode's own `Cc`, `Cf`, `Zl`, `Zp`,
`Zs` and `Co` classes rather than a hand-picked list, because the user approves the edit from a
diff that does not show them.

Formatting alone is a notice rather than a finding: bold, italic or list formatting on text that did
not change is reported and not synced, because the tool reads direct run properties only and a
producer expressing the same bold through a style would otherwise block every sync. Where the source
can hold it — a bold boundary that moved inside a bullet's run atoms — it is an ordinary change. A
link the rebuild will emit and the document lacks is a notice too (`hyperlink_not_synced`) — every
CV rendered before links existed reads that way — and so is a hand-made link on a scheme-less
address whose target differs only by its scheme.

Byte identity is a property of `cv.json`, not of the package: a rebuilt DOCX carries wall-clock
metadata and is never byte-identical to its predecessor. An unedited document leaves `cv.json`
untouched byte for byte, which is the half that matters — the source is what the pair is published
from.

Because the rebuilt document is rendered from the synced source, running the tool again over that
document with the same source is the pair's own consistency check: it must report `"status":
"clean"` with no notices. The check is not channel-specific — any builder-rendered DOCX and the
`cv.json` it came from satisfy it — and it is what proves this tool's mirror of `render.js` has not
drifted from the renderer.

## Punctuation gate (generation-rules.md rule 21)

`render.js` rejects CV content that violates `generation-rules.md` rule 21. Repository documentation
is outside that content gate.

## Files

- `build.sh` / `build.mjs` — the only pipeline entrypoint: preflight → DOCX → structural QA → temporary PDF/PNG → page gate.
- `libreoffice-backend.mjs` — runtime-neutral backend resolver, macOS direct-launch guard, and
  isolated LaunchServices invocation builder.
- `preflight.mjs` — validates `cvPlan` structure/header/project decisions, required evidence, ATS terms, forbidden claims, and Skills grouping against `application-brief.json`.
- `cv-links.mjs` — the one rule for which text is a link and where it points, shared by the renderer
  and the reverse sync.
- `render.js` — punctuation lint and DOCX generation; role headings use `keepNext`, bullets use `keepLines`, and any role may request `pageBreakBefore`.
- `docx-extract.mjs` — the reverse sync above: reads an edited DOCX, maps its edits onto the
  `cv.json` it was rendered from, and reports every edit it refuses to guess.
- `package.json` and `package-lock.json` — pin the exact `docx` dependency graph and Node/npm
  policy.
- `check-dependencies.mjs` — read-only lockfile-to-local-install guard called by `build.sh`.
- `node_modules/` — gitignored setup output; never installed or repaired by `build.sh`.
- `cv.example.json` — shape-only template with instructional placeholders, never a content source.
