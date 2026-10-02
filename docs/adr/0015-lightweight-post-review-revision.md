# ADR 0015: Lightweight post-review revision of published CV and cover letter

- **Status:** Accepted (2026-08-14, user review) — implements PD-003 (accepted 2026-08-12);
  recorded deviation from ADR 0010
- **Date:** 2026-08-13
- **Decision authority:** accepted by the user on 2026-08-14; backlog task 015
- **Task numbers:** the task ids below name records of this project's private predecessor backlog,
  which is not published. They are history, not pointers.

## Context

PD-003 (reproduced at the end) requires a lightweight revision operation for published
materials: after user review, an edit to `cv.json`/DOCX or `cover-letter.txt` must be a single
light operation — no regeneration, no step-3 reopen — with three edit channels (chat command,
manual file edit, DOCX edit with reverse sync), waivers for brief conflicts, a review-remark
list, and retained revision content history. PD-003 §5 mandates exactly three per-edit checks —
DOCX rebuild, the two-page limit, and mandatory ATS-term survival honoring waivers — and
explicitly does *not* require full visual QA or the full validator set for a small edit.
PD-003 §1 explicitly declines a draft-until-approval gate before publication, and §4 fixes the
conflict order: the edit is applied and the touched brief decision named; the user chooses
*afterwards* between a waiver and an explicit step-3 revision.

The current contracts forbid exactly this. `reopen-step` is "the only revision entrypoint"
(`instructions/pipeline-artifacts.md:222`); canonical artifacts "are never authored or revised
in place" (`:245`); "Chat is never an input" (`:188`); every publication requires "all human QA
required by the step" (`:253`); the chat return bans pasting material content (`:352-353`).
The v3 ledger rejects unknown keys at every level — ADR 0013's probes established that any
stored new field is a schema event and enumerated the owners such an event must edit together.
Old canonical bytes are deleted after each publication, so no content history survives. The
safe `--input-file` whitelist (ADR 0011) is closed, and its free-text envelope classes
deliberately destroy content. The DOCX publish gate enforces a bounded structural contract
(OOXML parts, page geometry, role headings, font) tied to the staged `cv.json` — not builder
provenance; the always-builder-rendered rule is contract prose
(`instructions/skills/generate-cv.md:70-72`).

ADR 0010 requires any deviation to be recorded "through a superseding ADR and the current
execution plan that owns the change"; execution plans were retired by ADR 0014 in favor of
backlog tasks, so this ADR plus its owning backlog tasks (015-019) is that record.

What already fits: steps 4 and 5 are leaf siblings, so revising them can invalidate nothing
upstream (PD-003 §3 is structurally free); each of PD-003 §5's three mandated checks is
already implemented inside an existing deterministic gate (`tools/cv-builder/build.sh` rebuild
+ 2-page gate; `runCvPreflight` ATS survival); the ledger already journals attempts and
publications with digests and a content-based revision counter.

## Decision

### 1. A new lifecycle operation: `revise-step` (steps 4/5 only)

A new mutation operation in `tools/process-log.mjs` opens a **revision attempt** on
`generate_cv` or `write_cover_letter` when the step is `completed` or `stale`. It reuses the
staging discipline, attempt tokens, the journaled publication transaction, the content-based
revision counter, and byte-stable rollback. It is not a thin alias of `reopen-step` +
`publish-step`: it forks the input-currency, finalization, and bundle-validation behavior of
publication by operation. The forks, named explicitly:

- **No descendant semantics.** Defined only for the two leaf steps; never marks anything
  stale. `reopen-step` keeps its meaning (re-author a step; upstream revision with descendant
  invalidation). `pipeline-artifacts.md:222` is rewritten to name two entrypoints with
  disjoint scopes.
- **Pinned input snapshot.** Preflight and publication select the input-currency policy by
  operation. Today both the attempt-open path (`assertCommittedStepCurrent`) and the publish
  path (`assertPublicationInputsCurrent`, re-run before commit and closing the attempt as
  `inputs_changed` on drift) derive currency from live protected-input bytes, and steps-4/5
  publish validation reads the brief through `verifiedArtifactBundle(map_experience)`, which
  re-validates live inputs transitively. For a revision, all three points instead validate
  against the step's own `published_inputs` digests: `knowledge/` drift neither blocks a
  revision nor is cleared by it, and the brief is accepted by digest match without
  transitively re-validating `map_experience` against live bytes.
- **Brief coherence guard.** The committed `application-brief.json` bytes must match the
  digest in the step's `published_inputs` — checked at attempt open *and re-verified under
  the ledger lock at publication*; `revise-step` is refused while `map_experience` has an
  active attempt or a prepared publication. If step 3 republished different bytes, the
  material is a regeneration case (`reopen-step` on the material step), not a light revision:
  validators cannot meaningfully check an edit against a brief the material was not generated
  from.
- **Finalization by digest, not by fiat.** The current commit path sets the step state to the
  intended outcome unconditionally; a revision publication instead re-derives the mark: if
  every `published_inputs` digest matches the current bytes of its file, the step finalizes
  `completed`; on any mismatch it finalizes `stale`. A step revised under persisting
  `knowledge/` drift stays `stale`; drift that healed (including an upstream identical-bytes
  republication) clears to `completed`. This comparison is raw digest checking and does not
  run the live preflight derivation. A revision attempt that closes *without* a publication
  (failed or abandoned) restores the step's pre-attempt mark from `pre_attempt_state` (§2):
  the published material is untouched, so the step is still `completed`/`stale`, never
  `failed`.
- **Light validation profile** (§4).

A publication closing a revision attempt records the operation and the edit channel
(`chat_command` | `manual_file` | `docx_sync`) in its attempt-history entry.

### 2. Ledger schema event: v3 → v4

Waivers, conflict journaling, and revision provenance need ledger fields; the strict v3
schema and gitflow invariant 9 (no meaning change under an unchanged schemaVersion) make this
a versioned event. The precedent is ADR 0010 §9's v2→v3 cutover: bump the top-level number,
existing records stay byte-for-byte compatible, cutover is one-way with no rollback writer.
ADR 0013 contributes the owner list a schema event edits together:
`tools/lib/process-log-v3-validation.mjs`, `tools/lib/process-log-v3-lifecycle.mjs`,
`tools/process-log.mjs`, `tools/bootstrap.mjs`, the schema prose in
`instructions/pipeline-artifacts.md`/operating contract, and a consequences note against
ADR 0010. v4 = v3 plus:

- `steps.<generate_cv|write_cover_letter>.waivers` — append-only array (§3):
  `{id, created_at, brief_digest, subject: {kind: check|decision, key}, status:
  active|superseded, note?}`.
- attempt-history entries gain optional `operation` (`reopen|retry|revise`), `channel`,
  `pre_attempt_state` (restores the step mark when a revision attempt closes without a
  publication — §1), `open_conflicts` (§3), and archived-file digests (§6).
- an adoption-base journal record for §5(b): the observed divergent digest plus a phase
  marker — the adoption preamble's idempotent-recovery anchor and its old-bundle proof.

Waiver lifetime (PD-003 §6): a waiver is marked `superseded` when a `map_experience`
publication commits an `application-brief.json` whose digest differs from the waiver's
`brief_digest`, and when the material step itself is re-authored through `reopen-step` — an
explicit restart rewrites the material from scratch, so waivers about edits of the previous
version lose their referent (PD-003 §6: waivers are not inherited). A byte-identical step-3
republication preserves active waivers, consistent with §1's healed-drift finalization:
nothing the waivers reference has changed. Superseded records remain journaled for
retrospection. Revisions never mutate `application-brief.json`; waivers are the only
persistence of a deviation, which is what keeps sync strictly downward (PD-003 §3).

### 3. Conflicts and waivers

A **conflict** is an edit that touches a brief decision (PD-003 §4) — not merely one that
fails a validator. Detection has two layers:

- **Deterministic layer.** The brief-coupled validator checks: required ATS-term placements,
  `requiredEvidence`, `forbiddenTerms`, `skillGroups`, structure/header/project placement
  rules (`runCvPreflight`); `coverLetterPlan.keywordTerms` survival (`validateCoverLetter`).
  Both validators gain a `waivers` parameter; their lifecycle call sites pass the step's
  active waiver set. An error suppressed by a waiver downgrades to a notice naming the waiver
  id, re-reported on every subsequent revision.
- **Procedural layer.** The revision procedure in the skills obliges the agent to name any
  brief decision the edit touches — the "treat as final" inventory of
  `instructions/skills/generate-cv.md:36-37`: evidence links, positioning/levers, structure,
  header, project, skill groups, exclusions, keywords — even when no deterministic check
  fires (e.g. deleting a bullet that carries an evidence link outside `checks`). Machine
  checks cannot see these; the obligation is instruction-owned, like the honesty floor, and
  such conflicts are recordable as waivers with `subject.kind: decision`.

**Flow, per PD-003 §4 and §1 (no pre-publication approval gate):** apply the edit → run the
light profile → publish → name the touched decisions and brief-coupled findings → the user
chooses per conflict: record a waiver (new envelope, §5) or explicitly reopen step 3.
Brief-coupled deterministic failures do **not** block a revision publication. That is a
machine change, not prose: today `tools/cv-builder/build.mjs` aborts on any preflight error
*before* rendering, and the publish gate throws `candidate_bundle_invalid` on any
validator error — under which the first conflicting edit could never publish and the waiver
choice could never be offered. In revision mode the deterministic gates therefore *classify*:
the brief-coupled subset becomes reported findings — `preflight.mjs`/`build.mjs` still render
the DOCX and return the findings, and the steps-4/5 publish validation journals them as
`open_conflicts` on the revise transaction instead of failing it. A waiver downgrades a
conflict to a notice naming the waiver id; unresolved conflicts re-surface on every
subsequent revision and in deep validation until resolved by a waiver or an explicit step-3
reopen. Intrinsic (non-waivable) failures still block publication. Nothing auto-escalates
into regeneration.

Never waivable: the honesty floor (`knowledge/precedence.md` §0); the letter's intrinsic
format/typography/markup rules (they encode playbook canon — changing them is a deliberate
canon edit per the scope guard) — *amended 2026-09-15, task 112: the letter's upper word limit
admits a bounded user approval journaled as a `check` waiver `letter_body_words_max:<N>`,
N ≤ 300, the lower limit does not; and a `decision` waiver binds both materials published from
the same brief digest, read by the sibling step as `sibling_decision_waivers`*; the letter language rule — it is brief-parameterized
(`brief.role.vacancyLanguage`), but rewriting the letter in another language is not a light
edit, it is a re-authoring, which PD-003 §1 scopes out of the revision operation entirely;
the structural DOCX contract; the two-page limit; staging/publication integrity and
selector/transport rules.

Forward compatibility: `subject.key` addresses a brief-v3 decision unit (term, check id,
group label, decision path). The brief-v4 evidence graph (epic 005, R2-03B) re-binds these
keys onto atom/evidence ids as a data migration; addressing is deliberately isolated in
`subject`. qa-v2 (epic 006) receipts are digest-bound; every revision publication is a new
digest, and the profile's results are journaled per publication so receipts re-derive rather
than survive.

### 4. Light validation profile

PD-003 §5 mandates three checks. This ADR chooses to run a superset — the full deterministic
gates, waiver-aware: for the CV, `tools/cv-builder/build.sh` staged mode in its revision
mode (§3: conflict-classifying preflight that renders despite brief-coupled findings, DOCX
rebuild, structural QA, 2-page gate — the gate stays in the builder) plus the publisher's
package checks; for the letter, waiver-aware `validateCoverLetter`. The expansion is deliberate and visible: deterministic checks are
machine-run and add zero human cost, and each intrinsic rule they enforce protects a canon
decision; PD-003's "lightness" is preserved where it matters — the human loop. What is
dropped, per PD-003 §5: full every-page 100%-zoom visual QA (the agent inspects only the
rendered page(s) whose content changed, from the PNGs the build already produces) and any
re-authoring. The honesty floor binds every agent-authored formulation in any channel,
unchanged.

### 5. Edit channels and transports

- **(a) Chat command.** Chat *instructs* the agent; the agent authors the edited bytes into
  staging, exactly as it authors originals today. "Files, not chat, cross step boundaries"
  survives with a clarification: chat may direct a revision, but content crosses the boundary
  only as staged, validated files. Untrusted-boundary rules are unchanged — nothing from chat
  is interpolated into shell text. Waiver decisions and their optional bounded rationale
  travel through a new closed `--input-file` envelope class for `revise-step` (ADR 0011
  table row + `commandSchemas` entry); unlike the diagnostic classes, this class carries
  user-owned text as bounded data, because the waiver note is a journaled record.
  *Amended 2026-09-21, task 145: the same envelope class serves `publish-step`, which carries
  exactly one waiver and only outside a revision — the letter's `letter_body_words_max:<N>`
  approval, decided on a draft that exists only between `begin-step` and the publication.*
- **(b) Manual file edit.** Initiation: the user says they edited the published
  `cv.json`/`cover-letter.txt` (or asks to pick it up); `revise-step` detects the digest
  divergence and adopts it. Adoption cannot ride the normal backup path — with divergent
  canonical bytes, attempt open throws `artifact_corrupt`, the publish backup phase throws
  `stale_writer`, and an interruption would wedge recovery in
  `publication_recovery_conflict`. It is therefore a dedicated, journaled **adoption
  preamble**: (1) under the ledger lock, journal the observed divergent digest as the
  adoption base *before touching any file*; (2) **copy** — not move — the divergent bytes
  into fresh staging as the revision candidate: the canonical slot is untouched until the
  publication's backup phase, whose old-bundle proof for the adopted kind is the journaled
  divergent digest; (3) corruption checks for the adopted kind are relaxed only inside this
  journaled flow; (4) an interrupted, failed, or abandoned adoption has a defined resting
  state — the canonical file still holds the user's bytes, the open adoption-base record
  makes deep validation report *adoption pending* rather than corruption, and a retry
  re-enters idempotently by digest match. The version the user overwrote is not lost: §6
  archives every steps-4/5 publication's committed bundle, so the pre-edit bytes are the
  previous publication's archive entry — which is also what the channel-(b) before/after
  diff is computed against. Outside an explicit adoption, divergence
  remains corruption (open point 5) — nothing ever blesses in-place bytes where they sit, so
  `pipeline-artifacts.md:245` is amended, not repealed. The preamble is an
  operation-independent primitive also available to `reopen-step` on a material step: when
  divergence coexists with a superseded brief, §1's guard refuses `revise-step` and the
  reopen route itself would today throw `stale_writer` at the backup phase — a wedge with no
  exit. In that state the same journaled adoption runs first (divergent bytes journaled and
  archived to `.revisions/` as an adopted base), and the explicit re-authoring then proceeds
  against a clean baseline.
- **(c) DOCX edit.** Reverse-sync-then-rebuild (task 019): extract the user's edits from the
  DOCX into `cv.json`, then run channel-(b) machinery; the published DOCX is always
  builder-rendered. The motivation is the ownership contract, not the gate: `cv.json` is
  authoritative and the pair must stay consistent in both directions (PD-003 §2) — the
  bounded structural gate alone would accept an edited DOCX that stays inside its checks.
  Unmappable edits surface as conflicts.

### 6. Revision content history

Publication currently renames old canonical bytes to `.pipeline-tmp/<id>/.backup-<kind>` and
deletes them with the transaction directory after commit — on the in-band success path, on
`reconcile-step`'s deferred commit, and on committed-history cleanup. Under v4, every
steps-4/5 publication — initial, reopened, or revised — archives its **committed** bundle
bytes to `output/<company-role>/.revisions/<publication-id>/<canonical-basename>` (written
once, never mutated) before the transaction directory is removed, on all three of those
paths; the ordering is idempotent across a crash window (re-running finalization completes
the archive before any removal). Archiving committed bytes rather than replaced backups is
deliberate: a backup-based archive permanently loses the version a manual edit overwrote in
place (§5(b)), whereas a committed-bytes archive makes every published version recoverable
under a stable per-publication target. Each archived file's digest is recorded in the v4
publication history entry, so `validate --deep` can verify the archive without introducing a
second manifest; the archive carries content only,
no state — satisfying ADR 0010's "no second mutable status manifest". Diffs for chat display
are computed at edit time between the committed bytes (for channel (b): the previous
publication's archive entry) and the staged candidate; retrospective comparison (PD-003 §9)
reads the archive.

### 7. Review-remark list

Per-process append-only content file `output/<company-role>/review-remarks.md`: dated entries
capturing review feedback worth generalizing, written by the agent during review sessions. It
carries no lifecycle state and is consumed by nothing automatically; promoting a remark into
`knowledge/` canon remains a deliberate user decision (PD-003 §8). It lives outside step
bundles and outside the artifact contracts.

### 8. Chat display carve-out

The chat-return clauses gain one exception: during a revision operation the agent shows a
bounded before/after diff of the changed fragment(s) only. The ban on printing full materials
(JD, brief, CV source, letter body) stays; a diff exceeding a bounded size is delivered as a
file instead.

### 9. Contract-edit map (prose and pins land with the machine change)

- `instructions/pipeline-artifacts.md`: `:222` two entrypoints; `:245` adoption amendment;
  `:188` chat-instructs clarification; `:253` per-operation QA profile; `:344-353` diff
  carve-out; input-file table row for `revise-step`; `.revisions/` archive rules; schema v4
  description.
- Machine paths forked by operation (task 016): attempt-open and publish input-currency
  (`assertCommittedStepCurrent`, `assertPublicationInputsCurrent`), steps-4/5 publish bundle
  validation (brief by pinned digest; the brief-coupled error subset journaled as
  `open_conflicts` instead of `candidate_bundle_invalid` for revise transactions),
  publication finalization (state by digest comparison; archive-then-delete on all three
  cleanup paths), attempt-failure close (`fail-step`/`closeRunningStepAsFailed` restoring the
  step mark from `pre_attempt_state` instead of `failed` for revise attempts),
  `reconcile-step` handling of revise transactions, waiver parameters in
  `runCvPreflight` and `validateCoverLetter` and their lifecycle call sites, conflict
  classification in `tools/cv-builder/preflight.mjs`/`build.mjs` (render despite
  brief-coupled findings in revision mode) with the CLI plumbing that hands active waivers
  and the mode to the agent-invoked builder, and the adoption old-bundle proof (bundle
  validation accepting the journaled divergent digest for the adopted kind).
- `instructions/skills/write-cover-letter.md:50-66`: revision loop rewritten onto
  `revise-step` (task 017). `instructions/skills/generate-cv.md:51-53,70-78`: revision
  procedure and reduced visual QA (task 018); the `:77` failed-revision literal is preserved.
- Test pins: mutation-operation inventory and timestamp-call-site count
  (`tests/process-log-v3-lifecycle-start.test.mjs`), lifecycle command list and chat literals
  (`tests/instruction-contracts.test.mjs`), ledger validation suite
  (`tests/process-log-v3-validation.test.mjs`), validator contracts
  (`tests/cover-letter-validator.test.mjs`, `tests/cv-builder.test.mjs`), CI inventory
  3-file edit for new test files.

### 10. Rollout over pre-existing states

Divergences that already exist at cutover are handled by the same flows — adoption is
time-agnostic: it journals whatever divergent digest it observes, regardless of when the
bytes diverged. A pre-existing in-place edit of `cover-letter.txt`/`cv.json` becomes
adoptable through §5(b) the moment task 017/018 lands; a pre-existing in-place DOCX edit
waits for §5(c) reverse sync (task 019) — until then its only exits are re-applying the
edits through channel (a) and rebuilding, or a deliberate rebuild from the committed
`cv.json` that discards the manual DOCX changes. A step that is both `corrupt` (divergent
bytes) and input-`stale` (canon drift) is exactly the state §1 + §5(b) compose for: the
pinned snapshot admits the revision, adoption admits the bytes, and finalization keeps the
honest `stale` mark. The v4 ledger cutover itself needs no data migration for any of this:
`corrupt`/`stale`/`orphan` are derived views over digests, not stored states, and existing
records remain byte-compatible per §2.

## Consequences

- `revise-step` is a behavioral fork of publication semantics (input currency, finalization,
  recovery) — the largest single risk in task 016; every implementing task (016-019) is
  heavy-lane by touched paths: RED→GREEN, independent skeptic review, mutation-kill on new
  pins, fingerprints, runtime smoke.
- The one-word-edit criterion of PD-003 becomes: `revise-step` → stage edit → builder
  rebuild/validators with waivers → targeted diff in chat → journaled publication with
  conflicts surfaced for the user's waiver-vs-reopen choice. Steps 1-3 artifacts and their
  ledger records are byte-identical throughout.
- The ledger cutover is one-way (v4); `process-log.json` remains gitignored and local, so
  waivers, remarks, and revision history share the durability class of the materials
  themselves — acceptable, as they describe those same local artifacts.
- `reopen-step` semantics, the five-step model, brief ownership, the honesty floor, and the
  read-only web UI are unchanged; the UI may later render waivers/conflicts/history as
  derived read-only views (separate task, browser-test pins).
- Conflict protection for brief decisions without a deterministic check rests on the skill
  procedure (the agent naming touched decisions), not on a validator — the same enforcement
  class as the honesty floor today.

## Open points (resolved at acceptance, 2026-08-14)

Accepted by the user with the recommended option standing on every point:

1. Schema event as v4 bump (recommended; ADR 0010 §9 precedent) vs additive-in-v3 with an
   ADR amendment (rejected here: violates gitflow invariant 9).
2. Brief-digest match as a hard prerequisite for `revise-step` (recommended) vs allowing
   revisions against a superseded brief with a warning.
3. CV revision visual check = changed pages only (recommended) vs none at all.
4. Letter intrinsic format rules stay hard on user-authored versions (recommended) vs
   downgrading them to acknowledged warnings. *Narrowed 2026-09-15 (task 112): the upper word
   limit alone yields to an explicit, journaled, bounded user approval; nothing is downgraded to
   a warning.*
5. Manual edits encountered outside an explicit adoption flow remain `artifact_corrupt`
   (recommended default — corruption detection keeps its meaning) vs auto-offering adoption
   whenever divergence is seen.
6. The light profile runs the full deterministic gates (recommended; exceeds PD-003 §5's
   minimal three at zero human cost) vs the literal minimal set.

## PD-003, the product decision this record implements

Accepted by the user on 2026-08-12 and reproduced here word for word. "PD-003 §N" in this record,
in the skills and in the code means point N below. The points state product requirements only; the
technical design is the Decision above.

1. **A lightweight revision cycle after publication.** The user's review happens against the
   published material. An edit after review is a self-contained lightweight operation: it requires
   neither regeneration of the material nor, still less, a restart of Step 3. No "draft before
   approval" gate is introduced ahead of publication.
2. **Three mandatory edit channels:** (a) a chat command ("replace X with Y", "drop the third
   bullet") — the agent applies the edit; (b) a manual edit of `cv.json` / `cover-letter.txt` —
   the system picks up and validates the user's version; (c) an edit of the DOCX, with reverse
   synchronisation back into `cv.json`. The pair `cv.json` ↔ DOCX always stays consistent, in both
   directions. Pasting a wholly edited version is not a mandatory channel; for the letter it
   remains as an already existing option.
3. **Synchronisation downward only.** The data flow is one-way: an edit to a material never
   invalidates the brief or the artifacts of steps 1-2, and marks nothing stale. There are exactly
   two synchronisation obligations: the `cv.json` ↔ DOCX pair, and recording waivers (point 4).
4. **A conflict with the brief is shown, and the user decides.** If an edit touches a decision of
   the brief (removes a mandatory ATS term, changes the structure), the agent applies it and names
   the affected decision explicitly; the user chooses whether to accept a waiver (a deliberate
   departure, recorded) or to revise the brief (an explicit Step 3 reopen). The mandatory checks of
   later edits take recorded waivers into account. Two alternatives were rejected: silently
   synchronising the brief behind an edit, and escalating unconditionally to Step 3.
   Clarification 2026-09-15 (task 112): the edit the user asks for is the user's decision — the
   waiver is recorded by default, at the opening of that same revision, without a question; revising
   the brief happens on the user's word. A waiver against a brief decision applies to both materials
   of that brief.
5. **Mandatory control of every edit:** rebuilding the DOCX, the two-page limit, and the survival
   of mandatory ATS terms (waivers taken into account). Full visual QA of every page at 100% zoom
   and the full set of validators are not required for a small edit. The honesty floor remains
   binding canon for the agent's wording (`knowledge/precedence.md` §0; a departure only through an
   explicit per-case confirmation by the user, ADR 0017): it binds every edit but does not force a
   full re-run of the checks.
6. **Restarting Step 3 is an explicit intent to rewrite the materials.** There are no automatic
   restarts (stale is only a mark). On an explicit restart the CV and the letter are written from
   scratch; manual edits of the previous version are not carried over (no merge is needed) and its
   waivers are not inherited. The reason for the restart — updated `knowledge/` canon, changed
   vacancy or research data, deliberate retargeting, or an error in the brief itself — does not
   change the fate of the edits. Clarification 2026-09-15 (task 112): an edit to a material does
   not by itself require a restart; the departure lives on as a waiver, and a material not yet
   written is written with that waiver in view rather than under the cancelled brief decision.
7. **Showing an edit is a targeted diff in chat** (before and after of the affected fragment). The
   ban on printing a full material into chat stands.
8. **Accumulating feedback.** Review remarks accumulate as a list; moving a remark into canon
   (`knowledge/generation-rules.md`, the playbooks) is a separate deliberate decision of the user's,
   not an automatic proposal on every remark.
9. **Revision history.** The content of material revisions is preserved and available for
   comparison; its purpose is retrospective analysis of recurring edits and the distillation of
   patterns into new rules (together with the list from point 8), not carrying edits between
   versions.

Product-level success criteria:

- Replacing one word in a published CV is a single lightweight operation: edit → rebuild the DOCX →
  minimal control (the page limit, the mandatory ATS terms) → targeted diff. No Step 3 reopen and no
  full visual QA.
- An edit that touches a brief decision is never applied silently and never escalates to
  regeneration automatically — the choice (waiver or brief revision) is always the user's.
- No edit to a material changes or invalidates the artifacts of steps 1-3.
