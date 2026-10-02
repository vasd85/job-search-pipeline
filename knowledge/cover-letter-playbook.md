# Cover Letter Playbook (v8)

## 1. Purpose and boundary of responsibility

This playbook defines the content, composition and editorial quality of one targeted Cover Letter.
It does not research the vacancy or the company, does not choose the lever, the evidence, the ATS
terms or the AI register, does not manage the output directory and does not describe writing the
file. Those decisions are already in the validated `application-brief.json` or belong to the
`write-cover-letter` procedure.

The letter is built around proven impact:

- claim - the selected lever, that is, the effect the candidate brings to the team;
- evidence - a concrete confirmed case;
- mechanism - observable working behaviour that explains why the effect is repeatable;
- company angle - how this approach connects to the task of this role or to the stated challenge
  of its team, product or project, without diagnosing the company's internal processes.

## 2. Authoritative inputs

The targeted letter uses only:

1. A valid `output/<company-role>/application-brief.json` for every decision of the specific
   application.
2. The candidate profile (`candidate/profile.md`) to check and expand the facts the brief refers to.
3. `generation-rules.md` for the general rules of writing, language, punctuation and honesty.
4. For a letter in a configured language - `candidate/languages/<language>/language-rules.md` of its
   pack, if it has one: the rules of the language itself (spelling, forms of address, typography)
   live there, the composition of any letter - in this playbook.

The session history is not a data source. If a required field is missing or a reference inside
the brief does not resolve, stop generation and fix the brief at the step that creates it.

### 2.1. Exact map of application brief fields

| Letter task                            | Authoritative field                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| Company, role and letter language      | `role.company`, `role.title`, `role.vacancyLanguage`                              |
| Confirmed challenge type and values    | `company.challengeType`, `company.values`                                         |
| Concrete anchor points to the company  | `company.tailoringHooks`                                                          |
| Central claim and angle                | `positioning.selectedLevers`, `positioning.angleHint`                             |
| Permitted AI depth                     | `positioning.aiRegister`                                                          |
| Permitted AI signals and constraints   | `positioning.supportingSignals`                                                   |
| Observable qualities for the mechanism | `experience.traits`                                                               |
| Risks of a false claim                 | `experience.gaps`                                                                 |
| Permitted evidence                     | `experience.priorityEvidence`, filtered strictly by `coverLetterPlan.evidenceIds` |
| Terms for the letter                   | `ats.keywords`, filtered strictly by `coverLetterPlan.keywordTerms`               |

Both sets of references have already been checked by the validator. Use them exactly: do not
replace items with more convenient ones and do not add new ones from memory.

## 3. Lever and angle

`positioning.selectedLevers` is a finished decision. The letter does not compare the available
levers and does not re-check the conditions of their applicability.

1. The primary lever sets the central claim.
2. The second lever, if kept, works as a short reinforcing beat, not as a competing theme.
3. `positioning.angleHint` connects the claim with `company.challengeType` and a fitting
   `company.tailoringHooks` entry.
4. The wording stays at the level of "the approach I bring". Do not claim the company has a
   specific problem when the brief holds only a signal about the challenge type.

## 4. Required plain-text title

The first non-empty line of the file is a short title specific to this role. It is a required part
of the letter.

- The title expresses the central engineering challenge or the idea the lever unfolds.
- It follows the same rule as the [micro-introduction](#51-micro-introduction): a judgment about
  cause, not a translation of the lever's wording.
- It is built only from `positioning.angleHint`, `company.challengeType` and the selected confirmed
  hook - a task of the role or a stated challenge of its team;
  [company link and motivation](#54-company-link-and-motivation) says what cannot serve as its basis
  or premise.
- It is written in `role.vacancyLanguage`.
- It does not repeat the first sentence of the letter, does not retell the company and does not
  diagnose its process.
- It is an ordinary plain-text line: no `#`, `**`, `Subject:` or other Markdown markup. An empty
  line follows it.

The title is not counted in the main word limit.

The machine boundary here is deliberately narrower than the editorial one. The validator checks
the single plain-text line, the empty line after it and that the script matches the language. The
title's connection to `positioning.angleHint`, `company.challengeType` and the selected hook is
checked by the author or the reviewer by meaning; it does not follow from the structure of the text
alone.

## 5. Letter composition

After the title the letter consists of short body paragraphs. Their number and size come from the
candidate config: paragraphs - from `candidate.config.letter.body_paragraphs.min` to
`candidate.config.letter.body_paragraphs.max`, words - from `candidate.config.letter.body_words.min`
to `candidate.config.letter.body_words.max`. The signature is not counted in the limit. The machine
checks these bounds at publication, and the target of the first publication is
`candidate.config.letter.body_words.target` words: the margin is there for review edits, otherwise
each of them is paid for by a cut elsewhere. A draft longer than the upper bound is not squeezed
under the limit: the author tells the user which block of the plan does not fit, and the decision
is the user's. The author does not choose the length and does not offer to exceed it: the upper
bound moves only on the user's explicit approval - a waiver `letter_body_words_max:<N>` of no more
than `candidate.config.letter.body_words.approved_max` words, which is recorded at the first
publication and at a revision alike; the lower bound does not move.

### 5.1. Micro-introduction

One sentence states the primary lever as an engineering judgment about cause - what decides the
outcome, what a choice in the team's behaviour leads to - and the next paragraph proves it. A
commonly known practice is not a judgment. The lever's `wording` and `positioning.angleHint` from
the brief set the meaning: they are neither quoted nor translated. A sentence that cannot be
understood without the brief is rewritten. This is not a warm-up and not a repeat of the title. Do
not name the vacancy here and do not use a template message about applying.

### 5.2. Evidence

Use only the entries listed in `coverLetterPlan.evidenceIds`, keeping their priority and factual
boundaries.

- One piece of evidence is the normal case; two are used only as short complementary anchors.
- The story shows the context, the personal action or an explicitly marked team contribution, the
  change and the effect.
- A number enters the letter only if it passes the metric selection test of rule 6 of
  `generation-rules.md`.
- A metric is used only together with the correct cause and scale from profile-backed evidence.
- Do not turn the story into a list of tools or an architecture description for its own sake.

### 5.3. Mechanism

Choose one behaviour from `experience.traits` that actually explains the result of the chosen
evidence. A quality is shown through action, not through a declaration of character. Do not create
a generic list of soft skills.

### 5.4. Company link and motivation

Connect the proven approach with one `company.tailoringHooks` entry and `company.challengeType`. A
hook in the brief is a task of this role or a stated challenge of its team, product or project; it
works as a confirmed reason for relevance, not as an occasion to retell the product or praise the
company. A fact that is not such a task or challenge - about the company as a whole, the product,
the stack, delivery or customers - is used neither as the basis of a paragraph nor as a premise for
a conclusion, even hedged with "may" or its equivalent in the letter's language. The role's task
is named briefly and in one's own words, tied to what the candidate will do, not by retelling the
vacancy sentence by sentence; the vacancy's modality is kept: a direction the vacancy is looking
toward is not a decision it has made. The role's task is named as a task, not as the candidate's
experience.

Motivation takes at most one sentence and rests on a concrete product, domain, autonomy,
engineering task or visibility of results already confirmed in the brief. Do not invent a
resonance of values.

### 5.5. Closing and signature

The closing is short and does not repeat the claim. The last line is separated by an empty line
and holds only the exact signature of the letter's language: for the default language -
`candidate.config.letter.signature`, for a configured language - the `signature` of its pack;
without a job title, links or contacts.

## 6. ATS terms

The target ATS set of the letter consists exactly of the terms of `coverLetterPlan.keywordTerms`,
resolved through an exact match with `ats.keywords[*].term`.

- Use the terms naturally and subordinate to the meaning of the lever.
- Do not change a form if that breaks the exact match, and do not add an alternative spelling
  without a decision in the brief.
- Do not list keywords and do not add a term that has no evidence.
- Other profile-backed words may naturally be needed for the story, but they do not become
  additional target ATS terms.

## 7. AI mapping

`positioning.aiRegister` is the final decision, and `positioning.supportingSignals` sets the
permitted evidence and constraints. The AI topic enters the letter only through an explicitly
included signal; use it at the depth the brief stores and only with the stated
evidence/constraints. Do not substitute the signal, do not raise the register and do not carry
personal-project methods into commercial experience.

## 8. Tone and coherence

- Calm confidence without grandiloquence or emotional clichés.
- The natural language of `role.vacancyLanguage`, not a literal translation.
- Concrete nouns and actions instead of abstract piles.
- Alternate short and medium sentences.
- Every sentence must be clear on the first reading and follow logically from the previous one.
- The letter is kept short by selecting what goes into it, not by compressing sentences:
  fragments, noun chains, abbreviations and jargon save words and cost the reader a second reading.
  The reader must not search for what a word refers to: the link is named in place.
- A technical judgment is acceptable as a reasoned choice, but not as belittling an alternative.
- A general thesis must survive a realistic counterexample; otherwise narrow it or present it as a
  personal observation.

Apply `generation-rules.md` in full, including the single rule of output punctuation and the
protected factual boundaries; this playbook does not duplicate them.

## 9. Editorial quality gate

Before handing the text to the writing procedure, check:

1. The first non-empty line is the required plain-text title without Markdown markup.
2. The levers, angle and AI register are read from the brief and not chosen again.
3. Exactly the evidence and the exact terms listed in `coverLetterPlan` are used.
4. Personal contribution, team contribution, scale and causality match the profile.
5. Every number in the letter has passed the metric selection test of rule 6 of
   `generation-rules.md`.
6. The mechanism is expressed by a behaviour from `experience.traits`, and the company angle by a
   hook of the role's task or of a stated challenge of its team, without a fact about the company
   as a whole.
7. No gap is presented as direct experience; a hard gap is not named - neither as a next step nor
   as an area of growth, in whatever words the letter's language puts it.
8. A recommendation, not a requirement: the letter shows which role it was written for; a letter
   without facts about the company is not a defect if the angle is built on the role's task.
9. The title, the number of paragraphs, the word limit of
   [letter composition](#5-letter-composition) and the signature are kept.
10. The text passes `generation-rules.md` without local exceptions.
11. What follows a colon explains exactly what precedes it.
12. A conclusion drawn with so / therefore / then, or their equivalent in the letter's language,
    names the link it follows through.
13. Checked after the other items, on a text that has already passed them: the letter has been read
    by a checking reader without the brief, the retelling of each paragraph matched the intent, and
    the flagged sentences have been dealt with - fixed or named to the user. The reading procedure,
    the cap of two rounds and the only case when there is no reading at all are held by
    `write-cover-letter`.

### 9.1. Deterministic publication boundary

Before publication `tools/cover-letter/validate.mjs` accepts only the exact name
`role.vacancyLanguage`: of the default language or of a language from
`candidate.config.languages.additional`; any other value is rejected fail-closed. The validator
checks UTF-8 without NUL, the plain-text title and the empty line after it, the script of the title
and of each paragraph, the number of body paragraphs and of words without the title and the
signature within the bounds of [letter composition](#5-letter-composition) (the upper bound - up to
N with a recorded approval `letter_body_words_max:<N>`, N no higher than
`candidate.config.letter.body_words.approved_max`), the exact signature, the absence of
Markdown/HTML, each exact term of `coverLetterPlan.keywordTerms`, and the deterministic bans on
punctuation and phrases from `generation-rules.md`.

The title and each paragraph must contain the script of the letter's language (for the default
language - Latin, for a configured one - the `script` of its pack) and must not contain letters of
the script of another configured language, except those the pack admits (`admits_scripts`); the
default language admits none. The pack also gives the exact signature and the subject word the
title may not open with; the constraints of the pack's `constraints.json` apply together with the
constraints of the layer. A machine PASS does not prove the title's relevance, the naturalness of
the language, the factual grounding or the specificity to the company: all four properties remain a
required manual or model-review check.

Writing the file, checking the output path and the message to the user belong to
`write-cover-letter`, not to this playbook.
