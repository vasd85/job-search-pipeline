# Targeted CV Playbook (v3)

## 1. Purpose and boundary

This playbook governs the content, information architecture, and human-readable quality of one
targeted CV. It does not fetch vacancy or company data, score fit, select positioning, choose an
output directory, or describe build and rendering commands. Those decisions are completed before
CV composition or are owned by the `generate-cv` procedure.

Produce exactly one CV for the application, in the language required by `generation-rules.md` rule
20. Do not create speculative remote, relocation, chronological, or hybrid variants. The validated
application plan has already resolved those choices.

## 2. Authoritative inputs

A targeted CV consumes only:

1. The validated `output/<company-role>/application-brief.json` for every application-specific
   decision.
2. The candidate profile (`candidate/profile.md`) for candidate facts and exact employment history.
3. `generation-rules.md` for global writing, presentation, and honesty rules.

Do not use session history as another data source. Do not reconstruct missing fields. If the brief
is absent, invalid, or internally inconsistent, stop; correction belongs to the step that creates
the brief.

### 2.1 Exact application-brief field map

| CV concern | Authoritative field |
| --- | --- |
| Company, target role, ATS, language, and market | `role.company`, `role.title`, `role.ats`, `role.vacancyLanguage`, `role.market` |
| Work-model facts used for presentation | `role.feasibility` |
| Product challenge and verified company-specific hooks | `company.challengeType`, `company.values`, `company.tailoringHooks` |
| Narrative spine | `positioning.selectedLevers`, `positioning.angleHint` |
| AI depth and permitted supporting material | `positioning.aiRegister`, `positioning.supportingSignals` |
| Ranked candidate-evidence pool and its destinations | `experience.priorityEvidence[*]`, including `cvPlacements` |
| Honest gap treatment | `experience.gaps` |
| Exact ATS terms and destinations | `ats.keywords` |
| CV structure | `cvPlan.structure` |
| Mandatory commercial LLM experience | `cvPlan.llmWorkSignal` resolved through `cvPlan.checks.requiredEvidence` |
| Header positioning | `cvPlan.headerPositioning` |
| Project inclusion | `cvPlan.projectDecision` |
| Evidence selected for the CV | `cvPlan.checks.requiredEvidence[*].evidenceIds` |
| Machine-enforceable wording, placements, exclusions, and skill groups | `cvPlan.checks` |
| Education credential reference date | `createdAt` |

The profile verifies and expands facts referenced by the brief; it does not authorize changing the
brief's application-specific priorities.

The CV evidence set is the union of every
`cvPlan.checks.requiredEvidence[*].evidenceIds`. Each id must resolve to
`experience.priorityEvidence[*].id`. Only those linked priority-evidence records may be materialized
as CV claims; unlinked records remain planning or cover-letter context and are not a reserve pool for
the CV writer.

## 3. Structure is a consumed decision

`cvPlan.structure` is mandatory and has exactly two supported values:

- `chronological`: Header, Summary, Skills, Experience, Education, then Projects only when included
  by `cvPlan.projectDecision`.
- `hybrid`: Header, Summary, Selected Impact, Skills, Experience, Education, then Projects only when
  included by `cvPlan.projectDecision`.

Do not choose between these structures during generation and do not introduce a functional or
skills-only structure.

### 3.1 Lever placement by structure

- In `hybrid`, Selected Impact is the primary surface for the selected lever or lever pair. Resolve
  each lever's `cvEvidenceCheckIds` to `cvPlan.checks.requiredEvidence`, then materialize only the
  `experience.priorityEvidence` records named by those checks' `evidenceIds`. The corresponding
  Experience bullet may add operational context but must not repeat the line verbatim.
- In `chronological`, there is no Selected Impact section. Carry the primary lever through the first
  bullet of the most relevant recent role and reinforce it only through linked evidence selected for
  Experience.

For a chronological CV, that first role bullet is **composite**: it states the role's generalized
scope and purpose, then connects the strongest mapped action or outcome. This satisfies the
role-description requirement without spending a separate front-loaded bullet on generic context.
Never force unrelated evidence into the composite bullet merely to mention a lever.

## 4. Section responsibilities

### 4.1 Header

The header contains contact details in the document body and applies `cvPlan.headerPositioning`
literally:

- `mode: "omit"`: add no contractor, location-positioning, work-authorization, sponsorship, or
  relocation line.
- `mode: "explicit"`: use `text` as the positioning line after verifying that it remains consistent
  with `role.feasibility` and the profile. Do not create an alternative formulation from session
  context.

### 4.2 Summary

The Summary is a concise positioning statement, not an evidence section:

1. Target identity and seniority, using the role-oriented title where useful.
2. Primary stack and domain relevance supported by the brief and profile.
3. The specialization expressed by the selected narrative spine.
4. A short operating-style signal when it materially supports the role.

Keep it to 4-6 lines. Use two or three priority terms assigned to Summary in `ats.keywords`. Do not
put metrics or detailed stories here.

### 4.3 Selected Impact

Include this section only for `cvPlan.structure: "hybrid"`.

- Use 3-5 concise bullets.
- Every bullet must resolve through a relevant check's `evidenceIds` to one or more
  `experience.priorityEvidence` entries assigned to Selected Impact.
- Prefer an anchored action, mechanism, and interpretable outcome.
- Preserve the distinction between personal contribution and team outcome recorded in the profile.

### 4.4 Skills

- Use the capability-based groups in `cvPlan.checks.skillGroups`; do not invent an overflow group.
- Include only skills supported by the profile and relevant to the application plan.
- Follow the term form and placement stored in `ats.keywords`; do not derive a second keyword map.
- Keep the section scannable: normally 3-5 groups, ordered by application priority.

### 4.5 Experience

- Use strict reverse chronology from the profile. Space pressure may reduce the oldest roles, never
  reorder middle roles for relevance.
- Every company, historical job title, and date must match the profile exactly. The target title and
  normalized seniority belong only in Summary, never in Experience.
- From the linked CV evidence set, use each record's `cvPlacements` to decide where it appears. Never
  pull an unlinked `priorityEvidence` record into Experience.
- Recent and highly relevant roles receive more depth; older roles receive only the evidence needed
  for continuity or application relevance.
- Each bullet carries one main idea and makes scope, action, and result understandable without
  internal context.
- An achievement may appear in both Selected Impact and Experience only when Experience adds useful
  operational context rather than repeating the wording.

### 4.6 Education

Education is a mandatory section: the credential test below removes individual lines, never the
section, and space pressure never drops it. The section is omitted only when the profile records
no education at all. Keep it conventional and compact.

Two entry classes exist, and the profile's own structure decides the class: an entry the profile
records as a degree is formal education and is always included in compact conventional form;
every entry the profile records as professional development, and any other non-degree credential,
earns its line only by passing the credential test.

The credential test reads recorded profile facts, the brief, and the composed work sections of
this CV; the author's reason for adding the entry is not an input. A credential that fails a leg
is left out of this CV while remaining a profile fact. At most two passing credential lines
appear, ordered by the most recent date the profile records for the entry, latest first; ties
keep the profile's own order. This cap is a fixed composition budget applied before the section
competes for space, so a credential line never displaces evidence.

1. **Standing.** A credential whose profile entry records an expiry date passes while that date
   is later than the brief's `createdAt` date and fails once it is not. A credential without a
   profile-recorded expiry date, including one whose issuer declares it never expires, passes
   only when the year of the brief's `createdAt` minus its recorded completion year is at most
   five.
2. **Relevance.** The credential's recorded subject must contain, or be contained by, a group
   `label` or `mustContain` term of `cvPlan.checks.skillGroups` or a `term` in `ats.keywords`,
   compared case-insensitively as strings. A credential whose subject matches nothing there
   fails, however recent it is.
3. **Contribution.** When a term matched in the relevance leg also appears, under the same
   case-insensitive comparison, inside an Experience, Selected Impact, or Projects bullet of this
   CV, the credential fails: a work line naming the same subject is stronger evidence, and a
   completion line adds nothing beside it. The one
   exception: a credential whose profile entry records award by third-party examination or audit
   passes this leg, because independent verification is information a work claim alone does not
   carry.

### 4.7 Projects

`cvPlan.projectDecision` is final:

- `decision: "exclude"`: omit Projects, regardless of other plausible signals.
- `decision: "include"`: include only `projectId`, using profile facts and the rationale already
  stored in the plan. Its CV claims must resolve through a required check's `evidenceIds`; otherwise
  the brief is invalid and generation stops. Do not substitute another project or broaden its status.

Project wording follows [LLM and AI material](#6-llm-and-ai-material). Inclusion never changes
factual maturity, ownership, or production status.

How the included project is named on the page is owned by `generation-rules.md` rule 16. The build
preflight enforces that the rendered Projects section literally contains `projectId`, so the plan's
`projectId` is what the page says: for a project whose profile entry says `**Visibility:** public`
it is that project's real name, and for one whose entry says `**Visibility:** private` it must be a
neutral label that carries no identity - the project's real name and its URL never reach the page,
and the publication refuses a page that names it.

## 5. ATS and evidence discipline

The brief already contains the keyword and evidence decisions. Generation only realizes them:

- Required terms appear in at least one permitted placement; `placementMode` determines whether one
  or every listed placement is required.
- Optional terms are used only when natural and supported.
- A term in Experience is attached to an action, responsibility, or result.
- Every `cvPlan.checks.requiredEvidence` item has one or more `evidenceIds`; its accepted wording and
  placements may materialize only those linked records.
- `cvPlan.checks.requiredEvidence`, `forbiddenTerms`, and `skillGroups` are binding acceptance
  criteria, not suggestions.
- `experience.gaps` controls adjacent or excluded claims. Never turn adjacent evidence into direct
  experience.

Do not add a keyword, tool, project, or claim solely because it appears plausible for the target
role.

## 6. LLM and AI material

Apply the baseline from `generation-rules.md` rule 15 through `cvPlan.llmWorkSignal` and its linked
evidence/check. Keep each selected commercial LLM work signal concise and in its designated
Experience entry, not as an inferred headline.

`cvPlan.llmWorkSignal` is a single slot and carries the unconditional baseline only. Rule 15's
second commercial track, when its trigger fired, travels as ordinary selected evidence with its own
required check - never by overloading this slot, and never by merging the two facts into one
sentence.

For any additional AI material, apply `positioning.aiRegister` and
`positioning.supportingSignals` exactly as persisted. Materialize only a signal explicitly included
by the brief, using its linked evidence and constraints. Do not reopen the register decision,
promote an excluded signal, or attach personal-project methods to commercial experience.

## 7. Format and content budget

- One ATS-safe column; no tables, icons, charts, text boxes, or essential header/footer content.
- Standard section names and consistent typography.
- Experience headers stay on one left-aligned line as `Company - Historical Title - Dates`.
- Keep bullets short and information-dense.
- Compose for a hard maximum of two rendered pages. Trim optional sections and older-role detail
  before compressing core evidence or reducing readability.
- Apply the output punctuation rule from `generation-rules.md`; this playbook does not redefine it.

## 8. Editorial quality gate

Before handing content to the generation procedure, confirm:

1. The document follows `cvPlan.structure` and contains no second variant.
2. Header positioning and Projects match their two explicit plan decisions.
3. Every selected lever has evidence in the correct structure-specific location.
4. The mandatory commercial LLM work signal appears in its required Experience placement.
5. The chronological first evidence bullet is composite when that structure is selected.
6. Summary contains target positioning but no metrics; Experience uses only factual historical
   titles.
7. Every number in the document passed the metric selection test owned by `generation-rules.md`
   rule 6.
8. Required evidence, keyword placements, exclusions, and skill groups satisfy `cvPlan.checks`.
9. Every factual claim resolves to the profile; every application-specific choice resolves to the
   brief.
10. Repeated evidence gains new context instead of duplicating wording.
11. Gaps and AI material follow the exact persisted decisions.
12. The content fits the page budget, `candidate.config.cv.page_budget`, without sacrificing readable
    type or core evidence.
13. Every Education line is either profile-recorded formal education or a credential that passed
    the credential test of [Education](#46-education); the test is applied by the author, and no
    validator inspects Education.

Runtime validation, file creation, rendering, and visual inspection belong to `generate-cv`, not to
this playbook.
