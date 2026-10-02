# Impact Levers and Positioning

> Authoritative canon for impact levers: what a lever is, how `map-experience` selects levers and
> the AI register, and the factual boundary of AI material. The candidate's own levers - their
> wording, weights, conditions, properties, anchors, framing and stories - and the company-type
> positioning are candidate data in `candidate/levers.md`, whose form `tools/candidate/README.md`
> owns. The CV and cover-letter playbooks only _use_ levers; they never define them.
> `map-experience` is the only procedure that selects levers and the AI register for an
> application; it persists the result in `application-brief.json`. `generate-cv` and
> `write-cover-letter` consume that result and do not re-select it.
> [The AI register and factual boundary](#13-ai-register-and-the-factual-boundary) is part of the
> honesty floor (see [the protected honesty floor](precedence.md#0-protected-honesty-floor)).

## 1. Impact Levers

An impact lever is a reusable, evidence-backed statement of the effect the candidate brings to a team. It is worded at the level of "the approach I bring", not "you have a problem with X".

Every lever has two axes:

- weight 1-5: the default priority in selection (field `Weight`).
- condition: "broad" (almost any role) or "conditional: trigger" (fires only when the role values it) - field `Condition`, `broad` or `conditional — <trigger>`.

Two lever properties (field `Properties`) are all the rules of
[selection](#12-selection-rules-performed-only-by-map-experience) and
[the AI register](#13-ai-register-and-the-factual-boundary) rely on; the rules do not read a lever's
number:

- `ai-practice` - AI as a practice in QA work: commercial AI experience as a basis of credibility,
  not a headline (see [the AI register](#13-ai-register-and-the-factual-boundary)).
- `ai-infrastructure` - building agentic AI infrastructure; the evidence is the candidate's
  personal projects, disclosure and naming follow rule 16 of `generation-rules.md`, the frame is
  [the AI register](#13-ai-register-and-the-factual-boundary).

The set is finite - a palette, not a cage. Uniqueness comes from the combination of levers, the choice of evidence for the company's challenge type and the hint phrase. Instantiation in a letter - see cover-letter-playbook.md.

The bank's wording and its stories are planning language: they set the meaning, and what enters a material is a rewording for the role.

The stories of the lever with the `ai-infrastructure` property (Step 3 selects them for the role and records them in `constraints`). Selection criterion: to a senior engineer the story reads as a judgment about cause - which decision leads to which outcome - and not as a commonly known practice. Each one is a profile fact from the named section. The number of decisions - per the definition of `deep` in [the AI register](#13-ai-register-and-the-factual-boundary).

The candidate's connecting stance (the `## Stance` section of the bank) is NOT a lever: it is too abstract to stand as evidence on its own. Use it as the tone that holds the material together, not as a separate claim.

### 1.1. The bank

The candidate's lever bank is `candidate/levers.md`: a `## Lever <id>` section per lever, under it
the fields `Statement`, `Weight`, `Condition` and `Properties`, below them anchors with references
to profile sections, framing and stories. The bank's format is `tools/candidate/README.md`. The
rules of this file name a lever by its property, not by its number: the number is the lever's
address in one candidate's bank.

### 1.2. Selection rules (performed only by `map-experience`)

1. Use the confirmed role requirements, engineering challenge type, values and tailoring hooks
   handed over by the previous steps. Do not research them again inside the selection.
2. Pick the applicable levers and sort them by weight.
3. Conditional levers (`Condition: conditional`) are allowed only with an explicit confirmed
   trigger.
4. Choose one lever or a meaningful pair. The second lever must reinforce the first with a
   different type of evidence, not repeat the same claim.
5. Choose `positioning.aiRegister` separately, per
   [the AI register](#13-ai-register-and-the-factual-boundary). It governs AI material beyond the
   mandatory commercial LLM signal of `generation-rules.md` rule 15.
6. Store the selected levers, angle, register, supporting signals and their evidence links in
   `application-brief.json` per the current schema and pass validation.

Once the brief is validated, the selection is closed. The generators may only implement the stored
decision; changing a lever, the register or the evidence set requires fixing the brief through
`map-experience`.

### 1.3. AI register and the factual boundary

`positioning.aiRegister` uses only four values. The mandatory commercial LLM signal in the CV is set
separately in `generation-rules.md` rule 15:

- `work-only` - the CV contains the commercial LLM-work signal in Experience, but AI does not
  become a separate positioning angle, personal-project evidence is not used in the AI
  positioning, and the AI topic does not enter the cover letter. The register limits the
  positioning, not the set of facts: track 2 below stays in Experience if its condition fired;
  the non-AI decisions of a personal project follow track 3; the skills list follows rule 15 of
  `generation-rules.md` (commercial and personal AI skills together, without attribution, in any
  register). Incompatible with a selected lever with the `ai-practice` or `ai-infrastructure`
  property.
- `broad` - commercial AI experience becomes a supporting signal: practice, result and
  professional judgment without the tool's brand. The signal is built on the commercial tracks
  that apply per the list below.
- `relevance-link` - `broad` plus one short link to the selected personal-project evidence in the
  AI positioning, showing that the skill is current; without a deep architectural story.
- `deep` - `broad` plus architectural decisions from personal-project evidence, recorded by Step 3
  for each material in the signal's `constraints`: each one proves a statement of that material,
  there are as many decisions as the material's argument carries, and the material does not
  become a tour of the project (rule 16 of `generation-rules.md`). Allowed and required only when
  a lever with the `ai-infrastructure` property is selected and an AI-heavy trigger is confirmed.

The three tracks of AI material are independent and add up rather than compete. Their set is
decided by `map-experience`:

1. **AI-assisted QA practice** (`candidate/profile.md#651-ai-assisted-qa-workflow`) - the
   unconditional baseline of rule 15. Always in Experience, regardless of the register and of
   whether the vacancy talks about AI.
2. **Testing a product LLM/RAG feature** (the employer entry in `candidate/profile.md#9-experience`
   where it took place) - added when the target company has an LLM/AI product or the role names
   testing of LLM functionality. The condition is confirmed by the vacancy or by company research,
   never by a guess. It is a separate claim in Experience, not a replacement of the first track.
3. **Personal project** - in the AI positioning only under the `relevance-link` or `deep` register;
   `deep` additionally requires a selected lever with the `ai-infrastructure` property (see the
   definitions above). The non-AI engineering decisions of a personal project, recorded in
   `candidate/profile.md#10-personal-projects`, may support any selected lever in any register, as a
   personal project under rule 16 of `generation-rules.md`; decisions whose point is checking an
   agent's work or a model's instructions stay under the register. How commercial and personal AI
   skills are listed in the skills list without attribution is decided by rule 15 there.

The tracks may stand side by side in one CV. Each is worded in its own words; none is written so
that it implies another - the boundary between them is set by the factual boundary below. In a
cover letter the AI topic appears according to the register; when the condition of track 2 has
fired, that track may be its evidence, as a second track next to the first.

The register does not switch off the mandatory baseline. The generators do not raise it and use
only the selected supporting evidence with its stored constraints. The wording is created anew for
the role; this section sets the meaning, not text to copy.

FACTUAL BOUNDARY (hard rule): BUILDING agentic and frontier infrastructure (skills, context management, sub-agent orchestration, hooks, evaluator-optimizer) is attributed EXCLUSIVELY to the profile entry that names that building. To an employer (`candidate/profile.md#9-experience`) whose entry does not name it - never. Commercial AI experience is what `candidate/profile.md#651-ai-assisted-qa-workflow` (AI-assisted QA practice) and the employer entries of `candidate/profile.md#9-experience` record, for example manual testing of a product LLM/RAG feature with tool calling; it may be named within those limits. Attributing to commercial work the building of agentic infrastructure that the profile does not attribute to it is an inadmissible inaccuracy; equally inadmissible is raising manual testing of someone else's LLM feature to developing it, owning it or to an automated quality evaluation that never took place.

The frame of a lever with the `ai-infrastructure` property and of any evidence from a personal project: infrastructure, not a product; no claims about production, users or a release beyond what the profile records; naming and disclosure follow rules 15-17 in `generation-rules.md`. The concrete wording of the frame is in this lever's section of the candidate's bank.

## 2. Positioning for Different Company Types

This section is a selection aid for `map-experience` only. Once `application-brief.json` is
written, the generators do not apply it again and do not replace the stored positioning.

Which of the candidate's stories to use as the anchor for which company type, and what to stress in
it, is recorded in the `## Positioning` section of the candidate's bank (`candidate/levers.md`).

**For AI-heavy / agentic-AI / autonomous-tooling roles:** Apply the conditional triggers in
[the selection rules](#12-selection-rules-performed-only-by-map-experience) and the register in
[the AI register](#13-ai-register-and-the-factual-boundary). Commercial QA practice remains the primary
factual base; personal-project evidence is supporting material and stays inside the factual
boundary above.
