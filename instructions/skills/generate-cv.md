# generate-cv

**Explicit Step 4 of the per-role pipeline.** Author, build, visually verify, and publish one
targeted `cv.json` plus DOCX bundle from the committed Step 3 brief.

**Input:** exactly one file-backed process selector.

Read and follow the shared
[file-backed pipeline artifact contract](../pipeline-artifacts.md). Resolve and preflight
`generate_cv`, then use the lifecycle command authorized by the current record. Step 4 and Step 5
are sibling consumers of Step 3; letter state does not block CV work. A post-review edit of an
already published CV bundle is a light revision instead: it follows its own route below, and that
route pins its own inputs rather than running this preflight.

Optional delegation may help with render inspection, but the shared single-publisher rule applies.

## Responsibility boundary and inputs

This step executes the brief's CV decisions. It does not read Step 1/2 artifacts, consume prior chat
reports, reselect evidence, or repeat targeting.

Read only:

- committed `output/<company-role>/application-brief.json` as the role-specific input;
- [knowledge/targeted-cv-playbook.md](../../knowledge/targeted-cv-playbook.md);
- [knowledge/generation-rules.md](../../knowledge/generation-rules.md);
- [knowledge/precedence.md](../../knowledge/precedence.md);
- `candidate/profile.md` in the candidate layer for canonical facts referenced by selected
  evidence;
- `candidate/rules.md` in the candidate layer — the candidate's rules whose `Scope:` names
  `generate-cv`, read after the canon this step reads; a candidate rule narrows that canon and never
  overrides it
  ([authority by responsibility](../../knowledge/precedence.md#1-authority-by-responsibility)).

A revision additionally reads files of its own process, all read-only: the committed `cv.json` it
edits; the archived copy of a DOCX the user edited in place, which the reverse-sync channel below
maps back onto that source; and — only when an adopted manual edit has already replaced the
committed source — the previous publication's archive entry as the diff base.

Stop on preflight/input failure. Never create or replace the output directory, reconstruct a
missing brief, or reinterpret the request as a general CV.

## Author and build in staging

1. Create the fresh `.pipeline-tmp/<publication-id>/` candidate directory from the shared contract.
2. Author candidate `cv.json` there by applying the CV playbook to the validated brief and profile.
   Treat the brief's evidence links, positioning, ATS terms, structure, header, project, skill-group,
   exclusion, and check decisions as final, except where a `sibling_decision_waivers` entry of the
   `preflight-step` result names one of them: that is the letter step's recorded `decision`
   waiver on this brief, it binds the CV as well, and the CV is authored honoring it rather than
   the cancelled brief decision (see Waivers). Name each such entry in the chat return.
   `cv.json.fileName` follows the candidate's pattern, `candidate.config.cv.file_name_pattern`,
   with `<Company>` and `<Role>` replaced by the company and the role of this process; a revision
   keeps the committed name.
   `coverLetterPlan` is outside this step.
3. Use the shared builder's controlled staging mode exactly as documented in
   [tools/cv-builder/README.md](../../tools/cv-builder/README.md):

   ```sh
   tools/cv-builder/build.sh \
     output/<company-role>/.pipeline-tmp/<publication-id>/cv.json \
     --brief output/<company-role>/application-brief.json \
     --pipeline-staging-dir output/<company-role>/.pipeline-tmp/<publication-id>
   ```

   The builder reads one value from the candidate layer, the page budget
   `candidate.config.cv.page_budget`, and refuses before rendering when the layer lacks it. The
   constraints it does not read, and the publication gate does: a constraint of
   `candidate/constraints.json` — a phrase that may never appear, a preferred term, a required
   spelling — refuses the publication and no waiver lifts it. Run the content check against the
   layer before building, so a refusal arrives before the render rather than after it:

   ```sh
   node tools/cv-builder/preflight.mjs \
     output/<company-role>/.pipeline-tmp/<publication-id>/cv.json \
     output/<company-role>/application-brief.json \
     --candidate-root <absolute path to the checkout's candidate directory>
   ```

   The builder must produce the candidate DOCX beside staged `cv.json`; PDF/PNG QA stays under the
   same staging directory. Do not use the default canonical-path build mode for a file-backed
   pipeline publication.

4. Inspect every returned page image at 100% zoom in one pass. Check clipping, overlap, glyph
   corruption, orphaned role headings, and illogical splits. Apply a documented pagination
   override only when rendered evidence requires it, then rerun the same controlled entrypoint.
   This full pass belongs to a first or reopened publication; a revision runs the lighter profile
   defined below.
5. If content or layout changes, edit staged `cv.json` and rebuild. Every rerun starts from a fresh
   staging directory: remove exactly what the previous run left there — the candidate DOCX and the
   `qa/` directory — and never the candidate `cv.json` itself, or the builder refuses the rebuild.
   Never alter facts or violate the playbook's readability limits to force pagination.

## Publish

A first or reopened publication goes out only after preflight, build, structural QA, page gate, and
the full visual QA all pass; a revision publishes on the light profile below. Publish the staged
`cv.json` and DOCX together through the matching active attempt. Before it journals anything, the
publisher validates that `cv.json.fileName` names the staged DOCX and re-runs the builder's own
DOCX contract over the staged bytes: a readable ZIP/OOXML package, the required parts and
relationships, UTF-8 well-formedness of the four required XML parts within a bounded
fail-closed subset, page geometry, and the role headings and font of the staged `cv.json`. Bytes
outside that bounded contract are rejected with nothing committed.

That check is narrow on purpose. It does not prove full XML Schema or OOXML validity, optional-part
validity, or universal renderability. The relationship and layout checks are bounded structural
checks, not complete semantic XML validation. It does not compare the rest of the content,
and it says nothing about pagination, visual fidelity, or factual quality. Editing staged `cv.json`
text without rebuilding produces a document the publisher will still accept, so
rebuild after every edit rather than relying on the gate to catch it. Only then is the pair committed
as one bundle.

On authoring, validation, rendering, or visual-QA failure, close the attempt with `fail-step`. Do
not publish a blocked CV bundle and do not move either candidate over the committed files. A failed
initial build leaves no canonical CV; a failed revision leaves the last committed pair
byte-for-byte unchanged.

## Post-review revision loop

The latest committed `cv.json` and the DOCX it names remain the canonical bundle, and neither is
ever authored or edited in place. After review, a point edit of that bundle is one light Step 4
revision: open it with `revise-step`, rebuild the document from the edited source, publish the pair
through the same lifecycle, and leave Steps 1-3 artifacts and their ledger records untouched. A
revision invalidates nothing upstream or downstream and never reopens targeting; the only lifecycle
mark it can move is Step 4's own.

Re-author with `reopen-step` instead when the CV has to be written again rather than edited: a
different structure or lever selection, a wholesale rewrite, or a `brief_superseded` refusal — the
committed `application-brief.json` no longer matches the digest the bundle was published from, so
validators cannot check an edit against the plan the CV was generated from. When that re-authoring
meets a `cv.json` or DOCX the user also edited in place, plain `reopen-step` refuses with
`artifact_corrupt`: run `reopen-step --adopt`, which journals and archives the divergent bytes as an
adopted base first, and then re-author against the new brief. That pairing is the route out of a
manual edit whose brief was superseded — the revision channels below are refused with
`brief_superseded` in that state — but only while this step's own prerequisites are current. If
`reopen-step` itself refuses with `prerequisite_stale`, live canon has moved away from what Step 3
published, and no Step 4 command can clear it: report that the exit runs through an explicit Step 3
re-run, and let the user decide to make it.

The bundle's canonical paths are fixed by its first publication, and no route reopens them: from
then on the publisher refuses any candidate that changes `cv.json.fileName` with
`artifact_path_revision_conflict`, and it refuses a re-authoring exactly as it refuses a revision.
A request to rename the published document therefore has no lifecycle route at all — report that
instead of routing it somewhere.

`brief_attempt_active` means Step 3 has work open. Wait for a running attempt to finish; a
publication interrupted after preparation is the same refusal and will never finish by itself, so
that one needs the shared contract's `reconcile-step` on `map_experience` before any revision can
open.

A revision does not run `preflight-step`. Preflight validates the prerequisites against live canon
and refuses `prerequisite_stale` on exactly the `knowledge/` drift a revision is defined to survive;
the revision works from the step's own pinned published-input snapshot instead. Resolve the
process, read the step record, and open the revision.

### The three CV channels

- **Chat command.** The user directs the edit in chat and this step authors the edited bytes into
  staging, exactly as it authors originals. A `cv.json` fragment the user pastes into chat is the
  same channel: chat directs the revision, files still cross the boundary.

  ```sh
  node tools/process-log.mjs revise-step --id "<process.id>" --step generate_cv --channel chat_command
  ```

- **Manual file edit.** The user edited the published `cv.json` in place, or asks to pick that
  version up. Only the explicit adoption below may take those bytes; outside it the divergence
  stays `artifact_corrupt`, and corrupt canonical bytes are never revalidated, blessed where they
  sit, or silently kept as the CV.

  ```sh
  node tools/process-log.mjs revise-step --id "<process.id>" --step generate_cv --channel manual_file --adopt
  ```

  The command journals every observed divergent digest before touching any file, archives the
  divergent bytes, and copies `cv.json` — the bundle's only adoptable text artifact — into fresh
  staging; the canonical slot keeps the user's version until publication. Work from the result
  rather than choosing your own ids: the staged candidate is the `adoption.staged_paths` basename
  under `.pipeline-tmp/<adoption.publication_id>/`.

  Read that result before assuming an adoption happened. The command refuses with
  `adoption_target_unchanged` when every canonical file still matches its committed digest and no
  adoption is open yet: nothing was edited, so the request belongs to the chat-command channel. When
  an adoption _is_ already open and the divergence is gone — the user reverted the file — it
  discards that base and opens an ordinary revision whose result carries no `adoption` at all;
  stage the candidate yourself, exactly as in the chat-command channel.

  An interrupted adoption has a defined resting state, reported by `validate --deep` as
  `adoption_pending` rather than corruption. Resume it by closing the running attempt named in the
  step's `active_attempt` with `fail-step` — that restores the pre-attempt mark and keeps the
  journaled base — and then running the same `--adopt` command again: it re-enters that base
  idempotently by digest match and returns the same publication id. Re-running it without closing
  the attempt is refused with `invalid_step_transition`. Re-entry rewrites the staged `cv.json` from
  the journaled base, so any further edit you had already staged is gone: re-apply it after the
  resume, and clear the interrupted run's DOCX and `qa/` before rebuilding.

- **DOCX edit.** The user edited the published document in place. The reverse sync maps those edits
  back onto `cv.json`, and the rebuild renders the document again from that source.

  ```sh
  node tools/process-log.mjs revise-step --id "<process.id>" --step generate_cv --channel docx_sync --adopt
  ```

  This channel belongs to the CV bundle alone and cannot open without the adoption: the machine
  refuses it on Step 5, whose bundle has no document, and refuses it without `--adopt`, because a
  DOCX edit is divergence by definition. The adoption journals the divergent document's digest,
  archives the document under `.revisions/<adoption.id>/`, and stages `cv.json` — the committed
  source, since only text artifacts are ever staged. Those two files are the reverse sync's inputs:
  the archive holds what the user edited, and staging holds what it was rendered from. Work from the
  result rather than choosing your own ids: the staged candidate is under
  `.pipeline-tmp/<adoption.publication_id>/`, and the archived document is that same committed
  basename under `.revisions/<adoption.id>/`.

  Two refusals keep that pairing honest. `docx_sync_target_unchanged` means the document still
  matches its committed digest: nothing was edited there, so there is nothing to sync and the
  request belongs to the chat-command channel. `docx_sync_source_diverged` means the committed
  `cv.json` diverged as well — staging would then hold the user's own source while the document was
  rendered from the committed one, so the sync would read every edit they made in `cv.json` as a
  difference the document does not have, and write it back out. Neither is retryable on this
  channel. Report the second one and let the user choose which half of their own work the revision
  carries: `--channel manual_file --adopt` takes the edited `cv.json` and archives the document, and
  its edits are then re-applied by hand or dropped; or the user restores `cv.json` to the version
  the ledger records, after which this channel opens on the document alone.

A DOCX the user edited in place is divergence like any other, which has one consequence beyond the
adoption: it also closes the chat-command channel, because that channel verifies the committed
baseline of every artifact in the bundle and refuses with `artifact_corrupt` while the document
diverges, so an adoption is the only way in — and an adoption blesses nothing.
The published DOCX is always builder-rendered, and that is the ownership contract rather than the
gate: `cv.json` is authoritative, and a hand-edited document drifts from it while staying inside
the publisher's bounded structural checks. What the reverse sync changes is where the user's edits
go — into that authoritative source, by machine, instead of into a question about which of them to
retype. The archived copy under `.revisions/<adoption-id>/` remains all the replaced document
itself leaves behind. Where an edit cannot be mapped, the extractor reports it and stops; it never
guesses, and neither do you.

### Procedure

1. Open the revision on the matching channel, supplying every waiver the edit already needs (see
   Waivers). Keep `attempt_id`, `active_waivers`, `sibling_decision_waivers`, and
   `open_conflicts` from the result. Open conflicts are unresolved brief-coupled findings of
   earlier revisions. Each one re-surfaces on every publication whose bytes still trip it, so three
   things end it: an edit that satisfies the check again, a waiver, or an explicit Step 3 reopen —
   and after that reopen the journaled list clears only when Step 4 publishes again.
2. Stage the candidate. For a chat-command edit, create the fresh `.pipeline-tmp/<publication-id>/`
   directory, copy the committed `cv.json` into it, and change only the fragment the edit touches —
   the rest stays byte-identical, because a revision is a point edit and not a rewrite. For an
   adopted edit the staging copy already exists; touch it only if the user asked for further
   changes, and for a DOCX sync it is the base step 3 writes the extracted edits into. For a local
   wording objection, discuss two or three alternatives in the working language without
   reprinting the CV, then stage the selected one. Adopted bytes that are not a point edit at all —
   a rewritten document rather than a changed fragment — are a re-authoring, not a light revision:
   close this attempt with `fail-step` first, because the revision you already opened blocks every
   other entrypoint, and then run `reopen-step --adopt`, which re-enters the same journaled base
   under the same publication id. That directory already holds what the revision staged, and the
   re-authoring stages into it, so clear it to the fresh state the build step requires first.
3. Sync the document into the staged source — `docx_sync` only. Run the extractor over the archived
   document and the staged `cv.json`, taking the `sha256` of the adoption's `cv_docx` entry as the
   expected digest, so a document that is not the one the ledger journaled is refused before it is
   read:

   ```sh
   node tools/cv-builder/docx-extract.mjs \
     output/<company-role>/.revisions/<adoption-id>/<cv.json fileName> \
     --cv output/<company-role>/.pipeline-tmp/<publication-id>/cv.json \
     --expect-sha256 <adoption cv_docx sha256> \
     --write output/<company-role>/.pipeline-tmp/<publication-id>/cv.json
   ```

   The archived copy is the input, not the canonical slot: it is the same bytes, but it is the copy
   the ledger's digest names. A resumed adoption re-enters by digest and rewrites the staged
   `cv.json` from the journaled base, so run this step again after any resume — whatever the
   previous run synced went with it.

   It prints one JSON report and edits the staged source in place, replacing only the string values
   the edits touch, so everything the document does not carry — `fileName`, `font`, the type sizes,
   a role's `pageBreakBefore` — stays exactly as published. Read the report before anything else:
   `changes` are the edits it mapped, each with its `path`, `before` and `after`; `unmappable` are
   the edits it refused to guess, each with its location; `notices` are what it saw and deliberately
   did not carry over, such as formatting on text that did not change.

   While `unmappable` is not empty the tool writes nothing and exits `4`. Every finding needs the
   user's decision, and nothing is published until they are all resolved. These are not the ledger's
   `open_conflicts` and carry no waiver subject: a waiver excuses an edit that costs a brief
   decision, while a finding here is an edit the tool would have had to invent. Report each one in
   the working language with its location and what it costs, then take the user's choice per finding: author the
   edit into the staged `cv.json` yourself — a deleted bullet, a renamed section, a bolded phrase
   are ordinary authoring, exactly as in the chat-command channel — or drop it. Author first and
   rerun the extractor afterwards: a finding you resolved stops being reported, and only then does
   `--ignore-unmappable` cover no more than what the user chose to drop, because that flag is not
   per-finding — it drops every one still standing. It carries the user's decision and is never your
   own fallback: it keeps the exit code at `4`, and a dropped edit is named in chat as dropped,
   never reported as applied. The remaining exit is to close the attempt as below.

   Any other nonzero exit is a refusal to read at all — a digest that does not match the journaled
   one, a document that is not a readable package, a `cv.json` this tool cannot scan. None of those
   is a finding to resolve with the user: fix the input or close the attempt.

   The tool refuses to invent a source spelling the renderer discarded, so a section heading — which
   renders uppercased — is always a finding. A run-structure change is one only when the text moved
   with it; bold, italic or list formatting added to text that is otherwise untouched comes back as
   a notice instead, because the rebuild will drop it. Report those notices too: whether a
   formatting change is worth authoring into `cv.json` is the user's call, not this tool's silence.
   Punctuation that the renderer's own rule 21 gate would reject is a finding as well, reported at
   its location instead of failing the build after the user has already seen a diff — and so is a
   character a reader cannot see, such as a non-breaking space or a bidirectional control, because
   the diff you show would not show it either.

4. Capture the diff's "before" side now, at edit time, not after publication — the publication
   replaces the canonical bytes. Key it on what actually diverged, not on the channel. For a
   chat-command edit, and for an adoption whose entries do not include `cv_source` — a DOCX-only
   adoption leaves the committed source untouched — it is the fragment as the committed `cv.json`
   still holds it. Only when `cv_source` is among the adoption's entries does the canonical slot
   already hold the user's version, and then it is the same fragment in the previous publication's
   archive entry, `.revisions/<previous-publication-id>/cv.json`. That id is the `publication_id` of the newest
   entry that has one in this step's own `steps.generate_cv.attempt_history`; a record-wide search
   would find the letter step's publications, which archive into the same `.revisions/` tree. Never
   use `.revisions/<adoption-id>/`: that archive holds the adopted bytes themselves. Verify that
   entry against the `sha256` and `bytes` its history record names before showing anything from it.
   If it is unavailable — missing, because the CV was published before the archive existed or its
   archive write was interrupted beyond repair, or present with bytes that do not match, which
   `validate --deep` reports as `revision_archive_missing` and `revision_archive_corrupt` — say the
   overwritten version is unavailable and show only the adopted fragment. Never present unverified
   bytes as the user's previous version, and never reconstruct text you have not seen.
5. Rebuild the document from the staged source. The rebuild is mandatory on every revision,
   including an adopted one whose source you did not touch: the pair is published together and a
   committed DOCX is never carried over. The staging directory must be fresh for every build run,
   including the second one after a trimmed edit, a refused publication, or a resumed adoption, so
   clear it exactly as the build step above requires before rerunning — plus, after a sync that died
   mid-write, the extractor's own `.cv-extract-*.tmp`, which the freshness contract counts like any
   other entry. When `active_waivers` is not
   empty, write that array verbatim to a JSON file with the runtime's structured filesystem API,
   under a fresh 32-hexadecimal-character basename in the runtime's own temporary directory,
   created exclusively with mode `0600` and removed after the build run — including a run the
   builder refused; a retry writes a fresh one rather than reusing that name. A predictable name in
   a shared temporary directory is not acceptable: concurrent local sessions are expected, and
   another session's file would silently supply another process's waivers. This file is the
   builder's own input and is not the shared contract's `--input-file` transport, which keeps its
   own root and its own retry rule. Keep it out of the
   staging directory, whose freshness contract admits only candidate `cv.json`, and never build it
   through a shell heredoc, `echo`, or generated escaping, because a waiver note is user-owned text.
   Then run the same controlled staging entrypoint in revision mode:

   ```sh
   tools/cv-builder/build.sh \
     output/<company-role>/.pipeline-tmp/<publication-id>/cv.json \
     --brief output/<company-role>/application-brief.json \
     --pipeline-staging-dir output/<company-role>/.pipeline-tmp/<publication-id> \
     --revision --revision-waivers <waivers-file>
   ```

   Drop `--revision-waivers` when there is no active waiver. `--revision` selects the builder's
   revision mode, whose contract its README owns: the brief-coupled preflight classifies instead of
   aborting, so the document renders and the summary carries the `conflicts` and `notices` the
   lifecycle journals. Every other gate in that mode stays hard, and the Waivers section below
   lists the ones no waiver can ever reach.

   After a `docx_sync` rebuild, run the extractor once more — over the document the builder just
   wrote, with the staged `cv.json` as its base and no `--write` — and require `"status": "clean"`
   with `notices` empty. That is the pair's own consistency check in the direction the builder
   cannot prove: any change or finding means the rebuilt document does not carry the source it was
   rendered from. Two things produce that — the sync dropped or misplaced an edit, or this tool's
   mirror of `render.js` has drifted from the renderer — and both are defects to report, not
   conditions to publish through. Never publish a pair that disagrees with itself: close the attempt
   with `fail-step` as below, so the revision does not sit open blocking every other entrypoint, and
   report which of the two you found.

6. Inspect only the rendered page(s) whose content changed, at 100% zoom, from the PNGs this build
   returned: clipping, overlap, glyph corruption, orphaned role headings, and illogical splits.
   Inspect the neighbouring page as well when the edit moved a page break. The every-page pass
   belongs to a first or reopened publication. A rebuild that runs past the page budget already failed
   the builder's gate, and the publisher never re-checks the page count: never publish that
   document. Trim the edit or agree a different one with the user, and never alter facts or the
   playbook's readability limits to force pagination.
7. Re-run the playbook's editorial and honesty checks over the touched fragment and the section
   around it. Respect the user's cuts, and flag any load-bearing element — a required ATS term,
   selected evidence, a lever payoff — that disappeared with them.
8. Name every brief decision the edit touches, even when no deterministic check fires: selected
   evidence links, positioning and levers, CV structure, the header line, the project decision,
   skill groups, exclusions, and ATS keywords. The machine sees only the brief-coupled checks its
   preflight runs; the rest of the plan is this procedure's obligation, in the same enforcement
   class as the honesty floor.
9. Publish the staged pair through the matching active attempt with the shared contract's
   `publish-step`. The publisher re-runs that preflight waiver-aware over the staged bytes and
   repeats the DOCX package gate: intrinsic failures still refuse the publication with nothing
   committed, brief-coupled findings are journaled as `open_conflicts` instead of failing it, and a
   waived finding comes back as a notice naming its waiver id. The result reports the finalized
   `completed` or `stale` mark.
10. Show the before/after diff of the changed fragment only — the two sides captured in step 4 and
    staged in step 2, or written into staging by step 3, whose report already carries the `before`
    and `after` of every change it mapped — within the shared contract's bounded chat carve-out.
    Both sides keep the CV's own default language; the commentary around them stays in the working
    language.
    A diff past that bound is delivered as a file, never printed: the carve-out is an
    exception for a fragment, not permission to print the CV. When there is no changed fragment —
    a waiver-only revision, or a synced document whose `changes` came back empty —
    say that in one line instead of inventing a diff, and name what the revision did change.
11. Report each journaled conflict with its subject and let the user choose per conflict: a waiver
    or an explicit Step 3 `reopen-step`. Nothing auto-escalates into regeneration, and a conflict
    left open is reported again on the next revision. It also keeps the process in `attention` with
    an `open_conflicts` issue in `validate --deep` until it is resolved — that is the record of the
    pending decision, not damage.

### Waivers

A waiver records the user's decision to keep an edit that costs a brief-coupled requirement. It is
supplied when a revision opens and journaled by the publication that closes that attempt. An edit
the user asks for — in chat, by editing the published `cv.json`, or in the document — that costs a
brief decision is that decision: record the `decision` waiver at the open of the same revision
without asking; a decision that surfaces only after the open is closed the same way before
publication — `fail-step` this attempt, open the revision again with the waivers, re-stage. A
deviation the user did not ask for is an authoring error: correct it; it is never waived. A waiver
on a finding of an earlier publication rides the next revision — publishing the same bytes is a
legitimate waiver-only revision. The decisions travel through
the shared contract's `--input-file` envelope for `revise-step`; the optional note is the user's own
bounded rationale and is journaled verbatim, so keep it short, factual, and free of source text.

- `check` subjects address a deterministic finding: copy `subject.key` verbatim from the journaled
  conflict and never compose one. The CV families are `cv_structure`, `cv_header_positioning`, and
  `cv_project_decision` for the three structural decisions, and `cv_ats_term:<term>`,
  `cv_required_evidence:<check id>`, `cv_forbidden_term:<term>`, and `cv_skill_group:<label>` for
  the keyed ones. A unit the ledger's bounded-text rules reject — an oversized or URL-shaped ATS
  term taken verbatim from a JD — comes back with its digest in place of that unit, which is
  exactly why the key is copied instead of rebuilt.
- `decision` subjects address a brief decision the machine cannot see, keyed by its path in the
  brief, such as `positioning.selectedLevers` or `experience.evidence`. A `decision` waiver is a
  decision about the brief, not about one material: it binds both materials published from the
  same brief digest. The letter reads this step's `decision` waivers as `sibling_decision_waivers`
  before it is authored, and this step reads the letter's the same way (step 2 of authoring, step 1
  of a revision); the record stays where it was journaled, once. Re-authoring this CV with
  `reopen-step` supersedes it for both — name the letter as authored on it in that chat return,
  and the user chooses: record the waiver again on the letter, or revise the letter.

An edit of a published CV or letter never requires a Step 3 restart by itself: the deviation lives
as a waiver. `reopen-step` of `map_experience` is the user's explicit choice for the reasons of
point 6 of
[PD-003](../../docs/adr/0015-lightweight-post-review-revision.md#pd-003-the-product-decision-this-record-implements)
only, and its cost is stated when it is offered: a brief published with a different digest marks
both materials `stale`, closes their light revision (`brief_superseded`), and supersedes their
waivers; the materials themselves are kept.

Never waivable, in any channel: the honesty floor — a conflict with it is resolved only through the
[user-confirmed deviation](../../knowledge/precedence.md#user-confirmed-deviation) procedure, never
by a waiver; the page budget; the structural DOCX contract the builder and the publisher both
enforce; the punctuation gate of `generation-rules.md` rule 21
and the renderer's font, body-size and section-type contract — they encode canon, and changing one
is a deliberate canon edit, not a waiver; and staging/publication integrity. A user-supplied `cv.json` is held to exactly the same floors as an
agent-authored one.

Every active waiver comes back in the `active_waivers` of the next `revise-step`, and a publication
reports a notice for one only when its waived finding fires again on the published bytes — a
restored ATS term simply stops producing either. A Step 3 publication of a different
`application-brief.json`, and any `reopen-step` re-authoring of the CV, supersede the step's
waivers; a byte-identical Step 3 republication keeps them.

### Failure and abandonment

Close a failed or abandoned revision attempt with `fail-step`, transporting its error object
through the shared contract's `--input-file` envelope. An abandonment has no natural failure, so
give it the stable code `revision_abandoned` rather than inventing one per session. The step
returns to its pre-attempt `completed` or `stale` mark — the published bundle is untouched, so the
step is never `failed`. A
failed chat-command revision leaves the canonical pair exactly where it was; a failed adopted one
leaves the user's own bytes in the canonical slot, which is the resting state the adoption defined,
while the ledger still names the last published pair. If `fail-step` refuses with
`publication_recovery_required`, the publication was interrupted after it journaled its
transaction: that state is not closable by hand, so take the exact attempt and publication ids from
the record and run the shared contract's `reconcile-step` instead. It may commit the prepared
bundle or roll it back, and a rollback removes the whole staging directory with the candidate you
built and inspected — a later edit starts from a new `revise-step`, not from those files.

Two residues are expected and neither is damage. The abandoned `.pipeline-tmp/<publication-id>/`
directory survives the closed attempt and `validate --deep` reports it as orphan staging; remove it
only through the shared contract's reviewed `cleanup-staging` dry-run and confirmation-token pair,
never by hand. An abandoned adoption also keeps its journaled base, which `validate --deep` reports
as `adoption_pending` until a publication clears it or the user restores the committed bytes.

Report the exact failures and agree on a corrected version instead of rewriting the user's content
silently. A user-supplied `cv.json` that breaks one of the publisher's own gates — the DOCX package
contract, or a `fileName` that no longer names the staged document — is refused there with nothing
committed. The renderer's own refusals end the attempt earlier and never reach the publisher at
all: the punctuation gate, and a font, body size or section type it does not accept, all fail
before any document is written. The page budget is not like them — the builder writes the
document and its QA renders first and fails the gate afterwards, so a rejected candidate is sitting
in staging and the publisher, which never counts pages, would take it. That one is enforced by your
own hand, as step 6 says. If expected pasted text is missing, ask the user to resend it rather than
reconstructing unseen text.

### Review remarks

When review feedback is worth generalizing beyond this CV, append a dated entry naming the
observation to the per-process `output/<company-role>/review-remarks.md` the shared contract owns.
The file is append-only: never rewrite or delete an earlier entry. Promoting a remark into
`knowledge/` canon stays a deliberate user decision, never a side effect of a revision.

## Chat return

Return only a compact confirmation with process id, committed `cv.json` and DOCX paths, page count,
validation/visual-QA result, publication outcome, and any user-confirmed honesty-floor deviation
applied ([the honesty floor](../../knowledge/precedence.md#0-protected-honesty-floor)). A revision
adds the resulting step mark, the bounded diff, each open conflict and waiver notice with its
subject, and the one pending
user decision. A `docx_sync` revision also names every edit the sync did not carry over, so the
published pair is never reported as if it held them.
Do not expose CV content in chat beyond that diff.
