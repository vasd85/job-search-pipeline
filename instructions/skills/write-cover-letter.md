# write-cover-letter

**Explicit Step 5 of the per-role pipeline.** Execute the committed Step 3 letter plan and publish
one `cover-letter.txt`.

**Input:** exactly one file-backed process selector.

Read and follow the shared
[file-backed pipeline artifact contract](../pipeline-artifacts.md). Resolve and preflight
`write_cover_letter`, then use the lifecycle command authorized by the current record. Step 5 may
run when Step 4 is pending, blocked, or failed as long as Step 3 remains completed, healthy, and
current. A post-review edit of an already published letter is a light revision instead and follows
its own route below.

## Responsibility boundary and inputs

This step authors and revises the letter. It does not read Step 1/2 artifacts, consume prior chat
reports, reselect evidence/keywords/positioning, or repeat targeting.

Read only:

- committed `output/<company-role>/application-brief.json` as the role-specific input;
- [knowledge/cover-letter-playbook.md](../../knowledge/cover-letter-playbook.md);
- [knowledge/generation-rules.md](../../knowledge/generation-rules.md);
- [knowledge/precedence.md](../../knowledge/precedence.md);
- `candidate/profile.md` in the candidate layer for canonical facts referenced by selected
  evidence.
- `candidate/letter-samples.md` in the candidate layer — accepted letters in the vacancy language,
  read before composing as samples of how a finished letter reads. They are neither rules nor a
  fact bank: no phrase, metric or paragraph structure is carried from them into the new letter.
  The file names the languages it covers; for a language it does not cover, or when the layer has
  no such file, this input does not exist.
- `candidate/rules.md` in the candidate layer — the candidate's rules whose `Scope:` names
  `write-cover-letter`, read after the canon this step reads; a candidate rule narrows that canon
  and never overrides it
  ([authority by responsibility](../../knowledge/precedence.md#1-authority-by-responsibility)).
- `candidate/languages/<language>/language-rules.md` in the candidate layer — for a letter in a
  configured language, that language's own writing rules from its pack, read after the playbook;
  for the default language, or a pack without the file, this input does not exist.

A revision additionally reads two files of its own process, both read-only: the committed
`cover-letter.txt` it edits, and — for an adopted manual edit — the previous publication's archive
entry as the diff base.

Stop on preflight/input failure. Never create or replace the output directory, reconstruct a
missing brief, or silently choose another process.

## Author, check, and publish

1. Create the fresh `.pipeline-tmp/<publication-id>/` candidate directory from the shared contract.
2. Compose staged `cover-letter.txt` in the brief's vacancy language. Apply the cover-letter
   playbook to the selected evidence ids, exact keyword terms, positioning, traits, gaps, and AI
   register without substituting alternatives, except where a `sibling_decision_waivers` entry of
   the `preflight-step` result names one of them: that is the CV step's recorded `decision` waiver
   on this brief, it binds the letter as well, and the letter is authored honoring it rather than
   the cancelled brief decision (see Waivers). Name each such entry in the chat return.
3. Count the body words and apply Length before compression below. A draft that does not fit is
   never cut to fit.
4. Include the required plain-text title and run the playbook's quality, native-phrasing, grammar,
   evidence, keyword, lever-payoff, and honesty checks.
5. Have the staged letter read by the blind reader and answer what it reports (The blind reader
   below). A first publication may rewrite any place the reading exposes.
6. Publish the candidate through the matching active attempt. The lifecycle publisher validates
   the staged bytes with `tools/cover-letter/validate.mjs` before it writes the publication journal,
   then repeats bundle validation for canonical bytes and publication recovery. This deterministic
   gate covers the exact name of the default or a configured language, the script of the title and of every paragraph, blank lines, the
   configured number of body paragraphs and body words (Length before compression; a journaled
   approval may carry a higher maximum, see Waivers), the exact signature and subject word of the letter's language, markup, planned keyword, punctuation, and
   forbidden-term contract, and the constraints of the candidate layer and of the language's pack —
   phrases that may never appear, preferred terms, required spellings. A candidate constraint refuses the publication and
   no waiver lifts it, so read `candidate/constraints.json` before drafting rather than after a
   refusal. It does not replace the manual/model review of title
   relevance, natural phrasing, factual support, company specificity, grammar, or honesty.

On authoring or validation failure, close the attempt with `fail-step`. This step has no partial
blocked publication and never writes canonical `cover-letter.txt` directly.

### Length before compression

The length limits are the candidate's own values, read from `candidate/config.json` before
drafting. The body holds from `candidate.config.letter.body_paragraphs.min` to
`candidate.config.letter.body_paragraphs.max` paragraphs, and from
`candidate.config.letter.body_words.min` (_the minimum_) to `candidate.config.letter.body_words.max`
(_the maximum_) words: that is the machine contract. `candidate.config.letter.body_words.target`
(_the target_) is the ceiling of a first publication: above it the letter has no room for the
corrections review will ask for. `candidate.config.letter.body_words.approved_max` (_the approval
cap_) is as far as a user's approval can move the maximum.

The draft is written for its reader; the count is taken once the draft exists, and again after every
rewrite.

- Up to the target: publish. A rewrite that answers the reading is counted again before publication,
  and it takes the same routes as the draft did.
- Above the target, up to the maximum: publish, and say the count in the chat return together with the fact that the
  letter has almost no room left. The margin is never bought: neither by removing a block of the
  letter plan nor by trimming a sentence somewhere else in the letter.
- Above the maximum before a publication that is not a revision — a first publication, or a
  re-authoring after `reopen-step`: stop before publishing and name three things — the absolute
  path of the staged draft, the body word count, and the block of the letter plan that does not
  fit — then wait. The user reads the draft and decides: drop that block, replace it with a
  shorter one, approve the length, or close the attempt with `fail-step`. This step neither chooses
  for the user nor trims the draft into the limit, and it names no number of its own: an approval
  carries the user's number, or the count of the draft the user read (Word-limit approval). A
  rewrite that answers the blind reading is counted again, and above the approved count the
  publisher refuses it: the new count goes back to the user, never a trim.
- Above the maximum at a revision: the correction is not paid for by cutting elsewhere. Report the
  overrun and the two routes — drop a plan block with a `decision` waiver, or approve the length
  with a `letter_body_words_max:<N>` waiver at the revision's open. Above the approval cap only the
  first route remains in either place, because the approval stops there.

### The blind reader

Before every publication — the first one and every revision — the staged letter is read by the
`letter-reader` agent, which is handed the absolute path of the staged `cover-letter.txt` and,
when the candidate layer holds `candidate/letter-reader-examples.md`, the absolute path of that file
after it, and nothing else. It has no brief, no letter plan and no company research. The examples
file is the reader's input, not the author's: pass its path without reading it. The agent's canon is [instructions/agents/letter-reader.md](../agents/letter-reader.md); it answers with
one JSON object — a phrase per paragraph saying what that paragraph claims and what proves it, four
lists of sentence addresses (`reread`, `unclear_reference`, `missing_link`, `translated`), and what
a skim of the title and the first sentences gives.

In Codex, spawn a fresh subagent with `fork_turns: none`. Put the canonical reader instruction
in its task message, followed only by the permitted input paths. Do not pass the author's
conversation, brief, letter plan, company research, or a summary of them. Give it a read-only
assignment: read those inputs and return the canonical JSON, with no other file access, shell
execution, network, writes, or delegation. Use the runtime's structured file-reading API.
This is a behavioural assignment, not a mechanical tool allowlist. Codex subagents share the
filesystem and available tools; a fresh conversation does not restrict those tools. Check the
returned JSON against the canonical shape and the actual paragraph/sentence addresses before
using it. An unavailable reading API, inherited author context, an out-of-scope action or an
invalid answer means the reading did not complete; follow the stop below.

What the author does with the answer:

- **Compare the retelling with the letter plan, paragraph by paragraph.** A paragraph retold as
  something other than what it was written to carry is the heaviest finding of the reading.
- **Read every flagged sentence in the letter**, never the flag alone.
- **At a first publication** any place may be rewritten. Read again after the rewrite; at most two
  readings. What the second one still flags is named to the user in the chat return and goes no
  further — the user's review is the third reading.
- **At a chat-command revision** only the touched fragment and the paragraph around it may change,
  which is the scope step 5 below already checks. Flags inside it are acted on, within the same two
  readings. Flags outside it are named to the user and never quietly corrected: an edit the user did
  not ask for is an authoring error.
- **At an adopted manual edit** the staged bytes are the user's own text. The reading still runs,
  because the next correction's verdict is read out of it, but nothing in it is acted on: every flag
  is named to the user, whose text it is.

Only counts and addresses reach the chat; the letter body does not.

Every reading is appended to the per-process `output/<company-role>/letter-reader-report.md`, an
append-only file of the same class as `review-remarks.md`: no lifecycle state, nothing consumes it
automatically, and it belongs to no step bundle. One entry per reading — the date, the publication
the staged bytes became, the agent's answer as it came, and for each flagged address the sentence
itself as the letter held it — a later revision resolves the place by that sentence, because the
addresses point into a text that has changed.

When the reading cannot be performed — the `letter-reader` agent is unavailable or a fresh
independent context cannot be started — do not read the letter in the session that
wrote it: that session holds the brief. Stop before publishing, say so, and leave to the user
whether to publish without the reading.

## Post-review revision loop

The latest committed `cover-letter.txt` remains the canonical letter, and it is never authored or
edited in place. After review, a point edit of that letter is one light Step 5 revision: open it
with `revise-step`, publish it through the same lifecycle, and leave Steps 1-3 artifacts and their
ledger records untouched. A revision never marks anything stale and never reopens targeting.

Re-author with `reopen-step` instead when the letter has to be written again rather than edited:
another vacancy language, a wholesale restructure, or a `brief_superseded` refusal — the committed
`application-brief.json` no longer matches the digest the letter was published from, so validators
cannot check an edit against the plan the letter was written from. When that re-authoring meets a
`cover-letter.txt` the user also edited in place, plain `reopen-step` refuses with
`artifact_corrupt`: run `reopen-step --adopt`, which journals and archives the divergent bytes as an
adopted base first, and then re-author against the new brief. That pairing is the only route out of
a manual edit whose brief was superseded — the revision channels below are both refused with
`brief_superseded` in that state. `brief_attempt_active` means Step 3 has work open: wait for it to
finish instead of forcing a route.

A revision does not run `preflight-step`. Preflight validates the prerequisites against live canon
and refuses `prerequisite_stale` on exactly the `knowledge/` drift a revision is defined to survive;
the revision works from the step's own pinned published-input snapshot instead. Resolve the
process, read the step record, and open the revision.

### The two letter channels

- **Chat command.** The user directs the edit in chat and this step authors the edited bytes into
  staging, exactly as it authors originals. A version the user pastes into chat is the same
  channel: chat directs the revision, files still cross the boundary.

  ```sh
  node tools/process-log.mjs revise-step --id "<process.id>" --step write_cover_letter --channel chat_command
  ```

- **Manual file edit.** The user edited the published `cover-letter.txt` in place, or asks to pick
  that version up. Only the explicit adoption below may take those bytes; outside it the divergence
  stays `artifact_corrupt`, and corrupt canonical bytes are never revalidated, blessed where they
  sit, or silently kept as the letter.

  ```sh
  node tools/process-log.mjs revise-step --id "<process.id>" --step write_cover_letter --channel manual_file --adopt
  ```

  The command journals the observed divergent digest before touching any file, archives the
  divergent bytes, and copies them into fresh staging; the canonical slot keeps the user's version
  until publication. Take the returned publication id and staged path from its result instead of
  choosing your own. An interrupted adoption has a defined resting state, reported by
  `validate --deep` as `adoption_pending` rather than corruption. Resume it by closing the running
  attempt named in the step's `active_attempt` with `fail-step` — that restores the pre-attempt
  mark and keeps the journaled base — and then running the same `--adopt` command again: it
  re-enters that base idempotently by digest match and returns the same publication id. Re-running
  it without closing the attempt is refused with `invalid_step_transition`.

The shared contract's third channel belongs to the CV bundle; Step 5 has no DOCX and never uses it.

### Procedure

0. Before choosing a channel, compare the committed `cover-letter.txt` with its last publication:
   run `node tools/process-log.mjs validate --deep` (the report covers the whole ledger; take this
   process from `processes[]` by `process_id`) and read `artifact_health` of `write_cover_letter`.
   `current` means the bytes match and the chat-command channel is open. `corrupt` means the user
   edited the file in place: verify the previous publication's archive entry exactly as step 3
   does, show the changed fragments, name every brief decision they touch, ask whether to adopt
   them, and dry-run the combined text — the adopted bytes plus the edit the user asks for — through
   `validateCoverLetter` of `tools/cover-letter/validate.mjs` (the module has no CLI: `node -e`
   with a dynamic `import()` and file paths), passing the step's active waivers from the resolved
   record as `{ waivers }` so a journaled approval is not reported as a fresh failure, and the
   candidate layer's constraints as `{ constraints }` — `candidateConstraintsFor` of
   `tools/candidate/constraints.mjs` with `material: "cover_letter"`, the brief's
   `role.vacancyLanguage` as `language`, the checkout's `candidate` directory as `root` and
   `coverLetterEngineForbidden` as `engineForbidden` — the length limits as `{ limits }` —
   `coverLetterLimitsFor` of the same validator module, with the same `candidate` directory as
   `root` — and the languages as `{ languages }` — `coverLetterLanguagesFor` of the same module and
   root — so the dry run sees what the publication will see, before
   proposing any wording. `adoption_pending` means an earlier adoption is still open: resume it
   as described under the manual channel. `missing` or `recovery_required` is not a revision
   case: stop, report it, and open no channel: `recovery_required` is a prepared publication and
   takes the shared contract's `reconcile-step` route; `missing` bytes have no lifecycle exit at
   all — every command, `reopen-step` included, refuses them — so this step runs nothing, and
   whether to put the last published bytes back from `.revisions/<publication-id>/` (verified
   against the digest in the step's attempt history) is the user's decision, not this step's.
   Then open the revision on the channel the comparison selected, never on a guess.
1. Open the revision on the matching channel, supplying every waiver the edit already needs (see
   Waivers: a touched brief decision the user asked for is recorded at this open, not at the
   next one). Keep `attempt_id`, `active_waivers`, `sibling_decision_waivers`, and
   `open_conflicts` from the result. Open conflicts are unresolved brief-coupled findings of
   earlier revisions; they re-surface until a waiver or an explicit Step 3 reopen resolves them.
   `sibling_decision_waivers` are the CV step's active `decision` waivers on this brief: they bind
   this letter too, so an edit never restores a decision the user cancelled on the CV.
2. Stage the candidate. For a chat-command edit, create the fresh `.pipeline-tmp/<publication-id>/`
   directory, copy the committed letter into it, and change only the fragment the edit touches —
   the rest stays byte-identical, because a revision is a point edit and not a rewrite. For an
   adopted edit the staging copy already exists; touch it only if the user asked for further
   changes.
3. Capture the diff's "before" side now, at edit time, not after publication — the publication
   replaces the canonical bytes. For a chat-command edit it is the fragment as the committed letter
   still holds it. For an adopted edit the canonical slot already holds the user's version, so it is
   the same fragment in the previous publication's archive entry,
   `.revisions/<previous-publication-id>/cover-letter.txt`. That id is the `publication_id` of the
   newest entry that has one in this step's own `steps.write_cover_letter.attempt_history`; a
   record-wide search would find the CV step's publications, which archive into the same
   `.revisions/` tree. Never use `.revisions/<adoption-id>/`: that archive holds the adopted bytes
   themselves. Verify that entry against the `sha256` and `bytes` its history record names before
   showing anything from it. If it is unavailable — missing, because the letter was published before
   the archive existed or its archive write was interrupted beyond repair, or present with bytes
   that do not match, which `validate --deep` reports as `revision_archive_missing` and
   `revision_archive_corrupt` — say the overwritten version is unavailable and show only the adopted
   fragment. Never present unverified bytes as the user's previous version, and never reconstruct
   text you have not seen.
4. For a local wording objection, discuss two or three alternatives in the working language without
   reprinting the full letter, then stage the selected one.
5. Re-run the playbook's quality, native-phrasing, grammar, evidence, keyword, lever-payoff, and
   honesty checks over the touched fragment and the paragraph around it. Respect the user's cuts,
   and flag any load-bearing element — selected evidence, a planned keyword, a lever payoff — that
   disappeared with them.
6. Name every brief decision the edit touches, even when no deterministic check fires: selected
   evidence ids, planned keyword terms, positioning and levers, traits, gaps, and the AI register.
   The machine sees only `coverLetterPlan.keywordTerms` survival; the rest of the plan is this
   procedure's obligation, in the same enforcement class as the honesty floor. Every touched
   decision the user asked for must already be a pending waiver of this attempt (step 1). One that
   surfaces only now is closed the same way, before publication: `fail-step` this attempt (nothing
   was published, the step mark is restored, a journaled adoption base is kept), open the revision
   again with the waivers, and re-stage — a chat-command edit is authored again, an adoption
   re-enters its base by digest. A deviation the user did not ask for is an authoring error:
   correct the fragment; it is never waived and never published.
7. Have the staged letter read by the blind reader and answer what it reports, within the scope the
   channel allows (The blind reader above).
8. Publish through the matching active attempt with the shared contract's `publish-step`. The
   publisher runs the same deterministic gate, waiver-aware: intrinsic failures still refuse the
   publication with nothing committed, brief-coupled keyword findings are journaled as
   `open_conflicts` instead of failing it, and a waived finding comes back as a notice naming its
   waiver id. The result reports the finalized `completed` or `stale` mark.
9. Show the before/after diff of the changed fragment only — the two sides captured in step 3 and
   staged in step 2 — within the shared contract's bounded chat carve-out. Both sides keep the
   letter's own language; the commentary around them stays in the working language.
10. Record every correction this revision made, one record per correction, in the letter-correction
    corpus (see Correction records). A revision that changed the letter is not finished until its
    records exist; a revision that changed no text — a waiver-only publication of the same bytes —
    records nothing, and that is not an omission. A correction is **one changed place** — one
    contiguous changed span with the sentence around it — in both channels. One objection that
    changed two places leaves two records, each carrying that objection as its reason, because the
    blind reader of a later revision answers place by place and not objection by objection. Both
    sides of a record are the two the diff of step 9 already holds, and both publication ids are
    this step's own: the publication the "before" fragment came from, and the one step 8 just
    wrote. A change the author made on its own — a cut for the word limit, a correction to the user's own wording —
    is not a correction of the letter and gets no record; `fragment_after` always holds the
    published bytes, so an author correction applied to the user's edit before publication is what
    the record shows.
11. Report each recorded waiver with its subject; the alternative to any of them — an explicit
    Step 3 `reopen-step` — stays available on the user's word and is not asked as a question. Report
    each journaled conflict with its subject and let the user choose per conflict: a waiver
    or an explicit Step 3 `reopen-step`. Nothing auto-escalates into regeneration, and a conflict
    left open is reported again on the next revision. When a recorded `decision` waiver names a
    field the CV also consumes (the
    [authoritative inputs](../../knowledge/targeted-cv-playbook.md#2-authoritative-inputs) of the CV
    playbook) and the CV is already published, say that the CV carries the cancelled decision;
    revising it is the user's call.

### Waivers

A waiver records the user's decision to keep an edit that costs a brief-coupled requirement. It is
supplied to the command that carries it — `revise-step` for a revision's decisions, `publish-step`
for the letter's word-limit approval outside a revision — and journaled by the publication that
closes that attempt. An edit the user asks for — in chat or by editing the published file — that
costs a brief decision is that decision: record the `decision` waiver at the open of the same
revision without asking
(step 0 shows a manual edit's touched decisions before the channel is chosen; a chat request is
read against the committed letter and the brief before the open). A waiver on a finding of an
earlier publication rides the next revision — publishing the same bytes is a legitimate
waiver-only revision. The decisions travel through the shared contract's `--input-file` envelope
for `revise-step`; the optional note is the user's own bounded rationale and is journaled
verbatim, so keep it short, factual, and free of source text.

- `check` subjects address a deterministic finding: copy `subject.key` verbatim from the journaled
  conflict — the keyword findings are keyed `letter_keyword:<index>` — and never invent one. The
  single composed `check` key is the word-limit approval below.
- `decision` subjects address a brief decision the machine cannot see, keyed by its path in the
  brief, such as `coverLetterPlan.evidenceIds`. A `decision` waiver is a decision about the brief,
  not about one material: it binds both materials published from the same brief digest. The CV
  reads this step's `decision` waivers as `sibling_decision_waivers` before it is authored and
  never inherits the cancelled brief decision, and this step reads the CV's the same way
  (step 2 of authoring, step 1 of a revision); the record stays where it was journaled, once.
  Re-authoring this letter with `reopen-step` supersedes it for both — name the CV as authored on
  it in that chat return, and the user chooses: record the waiver again on the CV, or revise the
  CV.

An edit of a published letter or CV never requires a Step 3 restart by itself: the deviation lives
as a waiver. `reopen-step` of `map_experience` is the user's explicit choice for the reasons of
point 6 of
[PD-003](../../docs/adr/0015-lightweight-post-review-revision.md#pd-003-the-product-decision-this-record-implements)
only, and its cost is stated when it is offered: a brief published with a different digest marks
both materials `stale`, closes their light revision (`brief_superseded`), and supersedes their
waivers; the texts themselves are kept.

**Word-limit approval.** The minimum and the maximum are the machine contract, the target the
ceiling of a first publication (Length before compression), and this step never proposes exceeding
it. When the user
explicitly approves a longer letter, record the approval as a `check` waiver keyed
`letter_body_words_max:<N>` on the attempt that publishes it: at the revision's open with
`revise-step`, and at the publication itself with `publish-step` on any attempt that is not a
revision — a first publication, and a `reopen-step` re-authoring. N is the absolute body word count
the user allows, above the maximum and at most the approval cap — the number the user named, or the count of the draft
the user read, never a larger one this step chose; the note quotes the user's words. Both commands
refuse a percentage, an increment, or a count past the approval cap with `invalid_waiver_input`, and
`publish-step` takes this one subject and no other: every other finding of such a publication stays
a hard refusal. The publisher then accepts a body of up to N words and reports the overrun as a
notice naming the waiver; more than N words, or fewer than the minimum, stays a hard refusal. A
publication outside a revision whose staged bytes fit the default maximum is refused with `waiver_not_applicable`
instead of journaling an approval it did not use — publish it again without the approval. The
approval holds for later revisions of the same letter and is superseded like any waiver, a brief
republication included.

Never waivable, in any channel: the honesty floor — a conflict with it is resolved only through the
[user-confirmed deviation](../../knowledge/precedence.md#user-confirmed-deviation) procedure, never
by a waiver; the letter's intrinsic language, title, structure, paragraph limit and lower word
limit, signature, markup, typography, and forbidden-term rules —
they encode playbook canon, and changing them is a deliberate canon edit, not a waiver — the
upper word limit moves only by the bounded approval above; and
staging/publication integrity. A user-supplied version is held to exactly the same floors as an
agent-authored one.

Every active waiver comes back in the `active_waivers` of the next `revise-step`, and a publication
reports a notice for one only when its waived finding fires again on the published bytes — a
restored keyword simply stops producing either. A Step 3 publication of a different
`application-brief.json`, and any `reopen-step` re-authoring of the letter, supersede the step's
waivers; a byte-identical Step 3 republication keeps them.

### Failure and abandonment

Close a failed or abandoned revision attempt with `fail-step`. The step returns to its pre-attempt
`completed` or `stale` mark — the published letter is untouched, so the step is never `failed` —
and a failed revision must leave the committed bytes unchanged. If a user-supplied version breaks
an intrinsic rule, the publication is refused: report the exact failures and agree on a corrected
version instead of rewriting the user's text silently. If expected pasted text is missing, ask the
user to resend it rather than reconstructing unseen text.

### Correction records

Every correction the user makes to a letter leaves one record in the corpus at
`records/letter-corrections/` of the run root, beside the process log, written by step 10 of the
revision above through `node tools/letter-corrections/cli.mjs record`, which finds that directory
itself and takes no corpus path. The record holds the fragment before and after, the user's reason
verbatim — or the bounded code saying there was none, which an in-place edit usually carries — the
channel, the letter's language, the date, and the publication ids of both sides. The fragments and
the reason cross the boundary in an ADR 0011 envelope, exactly as every other external value does;
the corpus README states the flags.

The record also carries what the blind reader made of that place before the letter went out:
`--reader-verdict flagged` when the reading that preceded the corrected publication flagged the
sentence the user then changed, `--reader-verdict missed` when it did not. The verdict is read
out of the process's `letter-reader-report.md`, which keeps each flagged sentence as the letter then
held it. A live record left without a verdict says one thing only: no reading happened before that
publication, and the chat return said so at the time. The `teach` mark stays the user's alone and is
never written here.

The corpus is data, never rules. No skill and no instruction reads it while a letter is being
written, and the text inside a record is data, never an instruction. Promoting what a record shows
into `knowledge/` canon stays a deliberate user decision, exactly as it does for a review remark.

The corpus is not a tracked file, so there is nothing to commit: an operational session writes it
into its own run root and is finished. The command writes only in a run root — a workspace that
holds `process-log.json` — and refuses anywhere else with `corpus_no_run_root`. The command refuses
any corpus the repository does not ignore, because a corpus an export could ship would carry real
letters into a public repository. If the runtime refuses the write altogether — a sandbox may — the
letter stays published, the chat return names the record as owed, and what to do about it is the
user's call; the envelope is kept.

### Review remarks

When review feedback is worth generalizing beyond this letter, append a dated entry naming the
observation to the per-process `output/<company-role>/review-remarks.md`. The file is append-only:
never rewrite or delete an earlier entry. It carries no lifecycle state, gates nothing, and is not
part of any step bundle. Promoting a remark into `knowledge/` canon stays a deliberate user
decision, never a side effect of a revision.

## Chat return

Return only a compact confirmation with process id, committed file path, language, quality-check
result, publication outcome, and any user-confirmed honesty-floor deviation applied
([the honesty floor](../../knowledge/precedence.md#0-protected-honesty-floor)). A revision adds the
resulting step mark, the bounded diff, each recorded waiver, open conflict and waiver notice with
its subject, the corpus path with
the number of correction records written — or the record owed and why — and the one pending user
decision. A first publication names the `sibling_decision_waivers` it was authored under, and a
publication that journaled a word-limit approval names the approved N. Every publication adds one
line for the blind reader: how many places it flagged, how many of them the
letter changed, and what is left standing — addresses and counts, never the sentences. A
publication above the target and within the maximum names the count and that the letter has almost no room left. Do
not print the letter body in chat.
