# map-experience

**Explicit mandatory Step 3 of the per-role pipeline.** Map candidate evidence to the role, make
every application-specific decision once, and publish a validated `application-brief.json`.

**Input:** exactly one file-backed process selector. Do not accept pasted vacancy/research reports
as the handoff.

Read and follow the shared
[file-backed pipeline artifact contract](../pipeline-artifacts.md). Resolve and preflight
`map_experience`, then use the lifecycle command authorized by the current record. Reuse the exact
Step 1 output directory; never reserve or create an output directory in this step.

## Direct file inputs

- current `output/<company-role>/vacancy.json`;
- current `output/<company-role>/job-description.txt`;
- current `output/<company-role>/company-research.json`;
- `candidate/profile.md` in the candidate layer for candidate facts and explicit gaps;
- `candidate/levers.md` in the candidate layer for the candidate's levers, their anchors and
  stories, and the company-type positioning;
- [impact levers](../../knowledge/impact-levers.md#1-impact-levers) for lever and AI-register
  rules;
- [knowledge/generation-rules.md](../../knowledge/generation-rules.md) for cross-deliverable rules;
- [knowledge/precedence.md](../../knowledge/precedence.md) for the honesty floor and responsibility
  resolution;
- `candidate/rules.md` in the candidate layer — the candidate's rules whose `Scope:` names
  `map-experience`, read after the canon this step reads; a candidate rule narrows that canon and
  never overrides it
  ([authority by responsibility](../../knowledge/precedence.md#1-authority-by-responsibility)).

This is the only step that reads both upstream artifact bundles and the only owner of targeting
decisions. Downstream skills consume the committed brief and permitted canon; they do not reopen
Step 1/2 facts or decisions.

Chat follows the global [operating contract](../operating-contract.md). Preserve ATS terms in the
JD's original language and exact spelling.

## Analysis and decisions

### Priority evidence and traits

Select role-relevant stack, domain, approach, achievement, responsibility, and transferable
evidence from the profile. Each selected item needs a stable run-local id, priority,
candidate-specific claim, canonical profile pointer, verified proof, and truthful placement
candidates.

Select only profile-supported behavioral traits relevant to researched values. Pair each trait with
observable behavior and its canonical profile pointer.

### ATS keyword and gap maps

Select 15–25 exact JD terms. For each term record the schema-owned evidence-or-gap support,
truthful placements, mandatory status, and placement mode. A hard gap has no fabricated proof or
dishonest placement.

Classify unmet requirements as adjacent or hard gaps. Record closest transferable evidence when it
exists, otherwise the schema's explicit absence, plus honest framing. Never imply a hard gap is met.
A framing never grants the letter permission to name the gap, as a next step or otherwise.

### Application decisions

Make these decisions once:

1. Select one impact lever or a meaningful pair under the
   [selection rules](../../knowledge/impact-levers.md#12-selection-rules-performed-only-by-map-experience).
   Record role-specific wording, rationale, evidence anchors, and an angle tied to the sourced
   challenge type without diagnosing the company's process. `wording`, `rationale` and the
   `constraints` of a supporting signal are planning language: they tell the generator what to claim
   and what proves it, not sentences for the generator. `company.challengeType`,
   `company.challengeEvidence`, and `positioning.angleHint` come from one research hook of `role` or
   `team` level — the level is the `scope` of the claims the hook cites, as Step 2 writes it — that
   is current on the application date; a `company`-level hook never carries them, whatever it says,
   and `company.tailoringHooks` lists only `role` and `team` hooks. When one hook is the only
   `role`/`team` hook, it fills both `challengeEvidence` and `tailoringHooks`. Without a `team` hook
   the angle rests on the `role` hook. `angleHint` names the task in its own words, does not repeat
   the hook's quote, and keeps the JD's modality: a direction the JD is looking toward is not a
   decision it has made. A research with no `role` or `team` hook cannot carry the brief: close the
   attempt with `fail-step` and a `retryable: true` diagnostic, and report that Step 2 needs
   `reopen-step` on the user's explicit word; do not promote a `company` hook.
2. Apply `generation-rules.md` rule 15. The unconditional baseline is the AI-assisted QA practice:
   put it in priority evidence and connect it to `cvPlan.llmWorkSignal` and its required CV check.
   That slot is the baseline's and carries nothing else. When rule 15's second commercial track is
   triggered - the condition is stated once, in track 2 of
   [the AI register and factual boundary](../../knowledge/impact-levers.md#13-ai-register-and-the-factual-boundary),
   and is confirmed from the vacancy or company research, never assumed - record it as its own
   priority evidence with its own `cvPlan.checks.requiredEvidence` entry placed in Experience, never
   by reusing the baseline slot and never merged with it into one claim. An unconfirmed trigger
   means the track is absent. The brief validator owns the exact reference and placement
   constraints.
3. Use the factual Step 2 AI-literacy evidence to select `positioning.aiRegister` and compatible
   supporting-signal evidence under
   [the AI register and factual boundary](../../knowledge/impact-levers.md#13-ai-register-and-the-factual-boundary).
   For the personal-project signal the `constraints` name the decisions for each material, per the
   `deep` definition there; a count such as "one decision" is never recorded as a constraint.
4. Choose one CV structure, exact header positioning, whether one project is included, skill
   grouping, exclusions, and deterministic content checks. Do not create multiple CV variants.
5. Select one or two priority-evidence ids and exactly three to five ATS terms for the cover letter.
   Step 5 executes these selections and does not revisit them.

## Construct the staged brief

Read [tools/application-brief/README.md](../../tools/application-brief/README.md) for field
responsibilities and use
[tools/application-brief/shape-example.json](../../tools/application-brief/shape-example.json) only
as an intentionally incomplete abstract field map. Neither file is a content source. The complete
fixture under `tools/application-brief/fixtures/` is only for tests and validator development; a
real run must not read, copy, or default from it.

Create every company name, role fact, id, digest, claim, keyword, evidence choice, lever wording,
rationale, placement, and check from the selected process's current validated files and canon.
Write staged `.pipeline-tmp/<publication-id>/application-brief.json` with the current schema.
`tools/application-brief/validate.mjs` owns exact fields, strict keys, references, enums, and
semantics.

The brief materializes selected facts, proof, decisions, and source pointers only. Do not copy the
full profile, JD, research report, playbooks, or generation rules, and do not create a second
experience-map report.

Build `cvPlan.checks` before any CV authoring:

- every required-evidence check references its exact selected evidence ids;
- every required evidence-backed ATS keyword is closed by one or more required-evidence checks that
  share at least one support evidence id and whose `placementMode` obligations guarantee the
  keyword's required placements; gap-backed keywords stay optional and have no placements;
- every selected lever has required checks with concrete acceptable wording and placements
  compatible with the chosen structure;
- selected commercial-LLM and role-specific AI signals resolve through their validated references;
- exact ATS terms that must survive editing are required, while merely helpful terms remain
  optional;
- skill groups are capability-based rather than an overflow list;
- hard-gap claims, disallowed tool names, and role-specific exclusions belong in forbidden terms.

## Validate, publish, and return

Validate the staged brief against exact current input bytes:

```sh
node tools/application-brief/validate.mjs \
  output/<company-role>/.pipeline-tmp/<publication-id>/application-brief.json \
  output/<company-role>/vacancy.json \
  output/<company-role>/job-description.txt \
  output/<company-role>/company-research.json \
  candidate/profile.md \
  candidate/levers.md
```

Publish the completed candidate through the matching active attempt. This step has no partial
blocked publication; if construction or validation fails, close the attempt with `fail-step` and
leave the previous canonical brief unchanged.

Return only a compact summary: process id, selected lever(s), up to three evidence anchors,
gap counts, AI register, CV structure/project decision, cover-letter evidence ids, validation
result, and committed brief path. Do not dump the full mapping into chat.
