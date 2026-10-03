# tools/candidate

The reader of the candidate layer: the private directory that holds everything specific to one
person, and the tracked example beside it that the suite runs on.

The layer itself is `candidate/` in the checkout that uses it. It is ignored by Git, so it never
reaches `git status`, a commit or `git archive`. The tracked `candidate.example/` holds a
fictional candidate of the same shape; tests read the example and never the real layer, which is
what makes a rule that still assumes one real person turn a check red instead of passing
unnoticed.

The user edits the layer in one place: `candidate/` of the `main` working tree, a git repository of
its own. The operational checkout reads a copy of it, and the copy is replaced only by the transfer
step described under the documents below.

## Integer scoring settings

Config schema 3 is required. `scoring.m/c/s/d.max` are integer maxima summing to 100.
ToolMatch reserves 10 points: `scoring.s.tools.max` must be 10 and S.max must equal
`scoring.s.automation.max` + 10 + `scoring.s.seniority.max`. Other component maxima may be zero;
then all their points are zero, and a zero M requires an explicit cap row.
[job-match-rules.md](../../knowledge/job-match-rules.md#8-private-point-configuration) owns the keys.
`integer[]` holds bounded point tables. Branch values must fit their enclosing maxima; changing a
maximum does not rescale them. The loader validates full configs and scorer snapshots identically.
Invalid budgets, cap arrays, curves and domain steps fail with `candidate_config_value_invalid`.
Missing settings have no defaults.

`tool_match.languages` and `tool_match.frameworks` are independent record arrays. Each record has
exactly canonical `name`, integer `points` 0–5, and `experience` (`direct`, `transferable`, `none`,
`unknown`). Names are unique in each array; `none` and `unknown` require zero points. An omitted
name means zero and unknown experience. Write prices from the candidate's technical skills,
personal-project evidence and explicit gaps; transferable fit never asserts direct experience.
Direct use refers to the named technology, not every binding or version. See the ToolMatch canon.

An upgrade explicitly replaces the old preferred/adjacent/base lists and known-modern list with
independent records, removes old price-group/subtotal/bonus/unknown settings, reserves ToolMatch's
10 points, and sets schema 3. Do not copy the fictional example's preferences. Pair engine and
private layer updates at an explicit cutover. New batches snapshot the new settings; old batches
retain their inputs, traces and policy id and require their original engine for re-verification.
There is no automatic migration or rescore of an existing batch.

## The config and its schema

`candidate/config.json` carries `schema_version` and the declared keys, nothing else.
`schema.mjs` owns both: the version this engine reads and the table of keys with their types. Every
value still sitting inside a rule moves into the table as its own task.

| Key                                                          | Type                      | What it sets                                                                                                             |
| ------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `letter.body_paragraphs.min`, `.max`                         | integer                   | The number of body paragraphs of a cover letter.                                                                         |
| `letter.body_words.min`, `.max`                              | integer                   | The body word count a letter is published within.                                                                        |
| `letter.body_words.target`                                   | integer                   | The ceiling the letter step sets for a first publication.                                                                |
| `letter.body_words.approved_max`                             | integer                   | How far a user's length approval can move `.max`.                                                                        |
| `cv.page_budget`                                             | integer                   | The pages a CV may take; the CV builder's gate.                                                                          |
| `cv.file_name_pattern`                                       | string                    | The CV's file name, with `<Company>` and `<Role>` in it once each.                                                       |
| `languages.additional`                                       | string[]                  | The configured languages beyond the default one, each with a pack (see Language packs).                                  |
| `languages.working`                                          | string                    | The working language: the language of chat and of every private file.                                                    |
| `letter.signature`                                           | string                    | The signature of a letter in the default language.                                                                       |
| `markets.home.name`, `markets.outside_home.name`             | string                    | The names of the two markets, as a vacancy and a brief carry them (see Markets).                                         |
| `markets.home.countries`                                     | string[]                  | The countries whose employment or contracting makes a vacancy's market the home one.                                     |
| `markets.home.timezone`                                      | string                    | The timezone a material names on the home market.                                                                        |
| `markets.home.working_hours`                                 | string                    | The candidate's working hours in the home timezone, `HH:MM-HH:MM`; the rubric's `tz_home` reads them.                    |
| `markets.outside_home.location`, `.timezone`                 | string                    | The location and the timezone a material names for every role outside the home market.                                   |
| `mobility.home_region`                                       | string[]                  | The countries of the scorer's home region (see Scoring values).                                                          |
| `mobility.feasible_residences`                               | string[]                  | Every country the candidate can live and work in without an employer's help.                                             |
| `mobility.self_relocation`                                   | string[]                  | The countries the candidate moves to without sponsorship; rule 10 reads it.                                              |
| `mobility.excluded_destinations`                             | string[]                  | The destinations a vacancy is skipped for.                                                                               |
| `mobility.relocation_tiers.high`, `.middle`, `.low`          | string[]                  | The relocation countries of each tier the scorer prices.                                                                 |
| `mobility.west_tier`                                         | string                    | The tier of a WEST country no list names: `high`, `middle` or `low`.                                                     |
| `mobility.west_near_subregion`                               | string                    | The WEST sub-region near the home timezone: `EU_UK` or `US_CANADA`.                                                      |
| `compensation.floors.<path>.amount`, `.currencies`, `.basis` | integer, string[], string | The monthly floor of each engagement path that has one.                                                                  |
| `compensation.target`                                        | integer                   | The target of the outside-home contractor path, in its floor's first currency.                                           |
| `compensation.home_currency`, `.home_rate_provider`          | string                    | The home currency and the official rate a conversion involving it uses.                                                  |
| `priorities.remote_company_regions`                          | string[]                  | The company regions whose remote work is priority class 1 (see Priorities).                                              |
| `priorities.relocation_west`                                 | boolean                   | Whether every WEST country is a ranked relocation destination.                                                           |
| `priorities.relocation_destinations`                         | string[]                  | The other ranked relocation destinations.                                                                                |
| `tool_match.languages`                                       | record[]                  | Independent canonical test-language prices and experience labels (see Integer scoring settings).                         |
| `tool_match.frameworks`                                      | record[]                  | Independent canonical framework-name prices and experience labels.                                                       |
| `domain_fit.<name>`                                          | integer                   | Where the Domain Fit scale puts each domain the scoring rubric names: the configured integer steps (see Scoring values). |

Both directions are checked. A path the table does not declare is refused as an unknown key; a
declared key the config omits is refused as a missing one. There are no defaults in code — the
value a run uses is the value the file shows. The consequence is deliberate: a checkout without the
layer, or with a config that lacks a key, cannot publish a cover letter or build a CV.

A type is not always enough, so a key may carry a bound on its value — a minimum or a set of allowed
values for an integer, a test for a string or a list — and the schema carries orderings between keys: `letter.body_paragraphs.min` is
not above `.max`, and `letter.body_words.min`, `.target`, `.max` and `.approved_max` do not
decrease in that order. An approved maximum equal to the maximum switches length approvals off. A
value outside its bound is refused as `candidate_config_value_invalid`, and the refusal names the
key, never the value. An ordering that names a key the table does not declare as an integer is a
fault of the schema, `candidate_schema_relation_invalid`. Besides the orderings, the schema lists
pairs of string keys whose values must differ — the two market names — refused the same way, and a
pair that names a key the table does not declare as a string is the same fault of the schema.
An ordering may be strict, and the schema also lists country lists that must nest in another and
pairs of lists that may share no member (see Scoring values); a list relation that names a key the
table does not declare as a list is the same fault of the schema.

## Priorities

The pre-triage stage's composition report ranks a collection by the candidate's priority classes;
[the pre-triage section of the review
runbook](../../docs/runbooks/triage-review.md#21-pre-triage-freshness-order-composition) owns the
mapping. The engine keeps the form of the classes, and the `priorities.*` keys say what each ranks:
the company regions — `WEST`, `HOME`, `OTHER` — whose remote work is class 1, and the destinations
of class 3, the whole WEST region by a flag of its own and other countries as ISO 3166-1 alpha-2
codes. A listed destination may be a WEST country and may not be an excluded one.
`candidatePriorities` spells the ranked destinations out as codes, less every excluded destination.
No priority is a scoring value, so none travels in the scorer input. `markets.home.working_hours` is
two different clock times; an end before the start is a window across midnight.

## Scoring values

The scorer's values are the candidate's: where they can live and work (`mobility.*`), what they
are paid (`compensation.*`), what each tool of the ToolMatch table is worth to them
(`tool_match.*`) and where each product domain sits on the Domain Fit scale (`domain_fit.*`). Countries are ISO 3166-1 alpha-2 codes, currencies three uppercase
letters. `<path>` stands for each of `outside_home_contractor`, `home_employment`, `home_contractor`
and `comparable_cost_employment`; a floor with several currencies compares a salary stated in none
of them in the first.

- The home region and the self-relocation countries are inside the feasible residences.
- The excluded destinations are in no residence list and no tier, and no country is in two tiers.
- No list of where the candidate lives or relocates, and no tier, names a WEST country: the
  scoring record assumes the candidate needs permission to work in each of them.
- The target is above the outside-home contractor floor.
- A price list names members of the ToolMatch table exactly as the table spells them, a web UI
  framework as `<framework>@<binding>` in a binding the table prices it in; a member is in at most
  one list, and `preferred` and `adjacent` name web UI frameworks only. A member no list names is
  worth 0. `known_modern` names members of the modern-signal set. Every list may be empty. How the
  lists are written from the profile is the price rule of the scoring rubric's ToolMatch section.
- Every domain the scoring rubric's Domain Fit section names has a key of its own, and no other
  domain has one; its value is one of `scoring.d.steps`. `irrelevant` and `unclear`
  are not placed: the engine assigns zero to irrelevant and the configured unknown value to unclear.

`candidateScoringValues` returns the part the scorer input carries — everything under `mobility`
but `self_relocation`, `compensation`, `tool_match`, `domain_fit` and `scoring` — and `validateCandidateScoring` checks such a part by
the same rules. `/score-jobs` copies the values into each input it scores, so a recorded batch is
recomputed on the values it was scored with; editing a value changes the next batch, not the
recorded ones.

## Markets

The engine knows two markets and nothing about either: the home market and the market outside it.
The config names both, lists the home countries, and sets what the materials state — a timezone at
home, a location and a timezone outside it. A market name is lowercase letters and digits in words
joined by single hyphens; a timezone is `UTC`, or `UTC` followed by `+` or `-` and 0 to 14 hours,
optionally `:30` or `:45`.

A vacancy of `vacancy.json` version 2 and a brief of `application-brief.json` version 4 carry one of
the two names; the side it stands for decides whether the CV header states positioning and whether
the company's contractor logistics are researched. A checkout without a layer configures no market,
and such an artifact can then name none.

A market name, once an artifact carries it, is not renamed and not moved to the other side: the
config is read afresh by every check, so a renamed market turns every recorded artifact that named
it into `artifact_corrupt`, the way a removed language does.

## The constraints file

`candidate/constraints.json` carries the personal rules a machine can check. It is a second file
rather than a set of config keys because the config schema declares scalars at dotted paths, and a
constraint is a record with a scope and a payload. It has its own `schema_version`, read by
`constraints.mjs`.

A file that is not there is an answer, not a failure: a layer written before this file existed
adds nothing of its own — only the entries its profile derives (see Entries derived from the
profile) — and a checkout with no layer constrains nothing. A file that is there and cannot be read
is a refusal — `npm run candidate:check` and `bootstrap --check` both fail on it. Only
`npm run candidate:check` prints how many constraints it read and `constraints_status`, which
speaks of this file alone: `absent` against `ready` is how a misspelt file name is told from a
file that is there but adds nothing; the `bootstrap` report keeps its frozen shape and says
nothing about the count.

### The three types

| Type                 | Payload                  | What it means                                                       |
| -------------------- | ------------------------ | ------------------------------------------------------------------- |
| `forbid_phrases`     | `phrases`                | None of these may appear in the material.                           |
| `prefer_terms`       | `prefer`, `avoid`        | None of `avoid` may appear; `prefer` is the wording to use instead. |
| `required_spellings` | `spelling`, `instead_of` | None of `instead_of` may appear; the word is spelled `spelling`.    |

**Which of the last two to use:** different words are `prefer_terms`; two spellings of the same
word are `required_spellings`. The difference is mechanical as well, so the wrong choice is
refused rather than silently accepted: a spelling is a single word and is matched with case
distinguished, because a spelling is about the exact characters; a term may be a phrase and is
matched ignoring case, because a term stays that term however it is capitalized.

Every entry carries an `id` (lowercase letters, digits and hyphens, unique in the file, never
starting with `private-project-`), a `scope`
naming the materials it binds — `cover_letter`, `cv`, or both — and a one-line `why` for the person
who reads the file later. A field this reader does not know is a refusal; there is no field that
switches an engine constraint off.

```json
{
  "schema_version": 1,
  "constraints": [
    {
      "id": "no-introducer-name",
      "type": "forbid_phrases",
      "scope": { "materials": ["cover_letter", "cv"] },
      "phrases": ["A Name"],
      "why": "One line, for a person; it is never printed in a refusal."
    }
  ]
}
```

### Entries derived from the profile

One ban is not written in this file. A project whose profile entry says `**Visibility:** private`
is never named in a material (`knowledge/generation-rules.md` rule 16), so the engine derives one
`forbid_phrases` entry per such project, bound to both materials: its id is
`private-project-<section with a hyphen>` (`private-project-10-2`), its phrase the project's name
(see The profile below). A public project derives nothing, and turning a project public lifts its
ban with that one edit of the profile. The prefix is refused in a file, so a written id never meets
a derived one. The name is matched like any phrase — ignoring case, between letters and digits — so
a link whose path carries the name is caught too; a link that does not carry it, or the name spelled
with spaces or underscores, is not. A private project named with an ordinary word would refuse every
material that uses that word: rename the heading instead. The derived entries are counted by
`npm run candidate:check`, whether or not the file is there.

### What a finding says, and what it never says

A finding names the constraint id, its type and — for the two types that have one — the wording to
write instead. It never quotes the phrase that matched, and never quotes `why`. The message travels
into the publication error, into stderr and into the session transcript, and the usual reason for
forbidding a name is that it should not be repeated. The reason for a constraint is read in this
file, not in an error.

The material is matched whole: the letter as published, and the CV as the whole of `cv.json`
flattened, which includes contacts, employer names and historical titles. A `prefer_terms` entry
whose avoided wording also appears in a title that must stay verbatim will therefore fire; scope
that entry to `cover_letter`.

### Merge order

The engine's constraints apply first and always; the candidate's are added to them. Each material
is compared only with its own engine list — the letter's, for a letter — so an entry bound to the
CV alone is never measured against what the letter forbids, while one bound to both is measured
against the letter's list when a letter is published. Nothing in this file subtracts:

- an engine finding is not waivable, and a candidate finding is not waivable either — it refuses a
  first publication and a revision alike, because a personal ban a re-publication could ignore
  would not be a ban;
- the one remaining way around an engine constraint — making required what the engine forbids — is
  refused with `candidate_constraint_conflicts_with_engine`, when the material it binds is
  validated rather than when the file is read. That is the price of comparing each material with
  its own list: `npm run candidate:check` reads the whole file and runs no comparison, so a
  conflicting entry passes the check and is refused at the publication it belongs to. The engine
  list and its own matching rule are supplied by whichever validator owns them, never copied here.
  An entry that refuses its own required wording is a pair with both halves inside one record, and
  that one is refused when the file is read.

To lift a candidate constraint, edit `constraints.json`. There is no per-publication override. The
file is pinned by Steps 4 and 5 (What a step pins): the edit refuses an attempt it overlaps and marks
the materials already published, and stops no open process.

## Language packs

The engine knows one language by name, its default: English. Every other language the candidate
writes letters in, or reads vacancies in, is configured: `languages.additional` names it, spelled
the way the artifacts spell it — `vacancyLanguage` of a vacancy and a brief, `role.language` of a
scorer input, `language` of a letter-correction record — one word with a capital first letter. The
set every such field is checked against is the default language plus these names; a checkout
without a layer supports the default language alone.

Each configured language has a pack, the directory `languages/<name>/` with the name exactly as the
config spells it. Its files are a fixed set:

| File                            | Required | What it holds                                                                            |
| ------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `pack.json`                     | yes      | What a letter in the language is checked by.                                             |
| `constraints.json`              | no       | Constraints for a letter in the language, in the vocabulary of `constraints.json` above. |
| `language-rules.md`             | no       | The language's own writing rules: spelling, forms of address, typography.                |
| `pins.json` and `pins/<id>.txt` | no       | Letters the pack's checks must accept or refuse.                                         |

A file outside the set is refused; a name beginning with a dot is ignored. A configured language
without a pack is refused as `candidate_language_pack_missing`, and a pack the config does not name
as `candidate_language_pack_unconfigured`: nobody would read it, and its pins would never run.

### pack.json

```json
{
  "schema_version": 1,
  "locale": "el",
  "script": "Greek",
  "admits_scripts": ["Latin"],
  "subject_prefix": "Θέμα",
  "signature": "<the candidate's name, written in the language>"
}
```

Every field is required. `locale` is the canonical locale words are counted by; one the word counter
does not support is refused rather than counted by another language's rules. `script` is the Unicode
script the language is written in, and `admits_scripts` the scripts a letter in it may carry beside
its own — technical terms in Latin, for one. `subject_prefix` is the word an email subject line
opens with; `signature` is the exact last line of a letter in the language.

A letter in any language is checked by the same rule. Its title and every body paragraph contain
the script of its language, and none of them contains a letter of the script of another configured
language unless its pack admits that script. The default language admits none. Two languages written
in one script are not told apart by this rule, and a script no configured language uses is not the
rule's business: a layer with the default language alone does not refuse one. A title opening with
the subject word of any configured language, the default's `Subject` included, is refused in every
letter.

### constraints.json of a pack

The same vocabulary as the layer's own file. An entry binds `cover_letter` alone — the CV is always
in the default language — and applies to a letter in the pack's language together with the layer's
entries; an id is unique across the two files. The engine's lists are checked against the two as
one list.

### language-rules.md

Prose of the candidate's, with English headings and nothing checked about its form. It carries what
a material in the language must follow beyond the engine's rules and the playbooks; the letter step
reads it for a letter in the language.

### Pins

`pins.json` lists letters and the verdict the letter gate must reach on each:

```json
{
  "schema_version": 1,
  "pins": [
    { "id": "plain-letter", "expect": "accept", "keyword_terms": ["Playwright"], "why": "..." },
    {
      "id": "latin-paragraph",
      "expect": "reject",
      "finding": "cover-letter.txt body paragraph 4 must use Greek script",
      "keyword_terms": ["Playwright"],
      "why": "..."
    }
  ]
}
```

The letter of a pin is `pins/<id>.txt`; the id has the form of a constraint id, and a file in `pins/`
that no pin declares is refused. `npm run candidate:check` runs every pin through the gate a
publication meets — the layer's limits and languages, the constraints of the layer and the pack,
and a brief made of the pack's language and `keyword_terms`. An `accept` pin holds when the gate
reports nothing at all; a `reject` pin holds when the gate reports exactly one finding and it is the
`finding` word for word. A pin that does not hold is `candidate_pin_failed`, naming the pack and the
pin. The findings are the engine's own messages, so a change of their wording turns the pins red
until they follow; so does a change of the letter limits a pin was written for.

### Removing a language

A language taken out of `languages.additional` is no longer accepted anywhere: a process published
in it fails `validate --deep` as `artifact_corrupt`, and a batch scored in it cannot have its traces
recomputed by `triage-verify`.

## The documents

Four files beside the config hold the candidate's own material: `profile.md`, `levers.md`,
`rules.md` and `letter-samples.md`. Public rules reach them by path and heading — the profile as
`candidate/profile.md`, one of its sections by a link to its heading (see Naming a section from a
rule), a lever by the property it carries, a rule by the read point its scope names — so their form
is part of the contract and `documents.mjs` checks it; the prose under a heading is the candidate's
and is not checked. Headings are English in every layer, whatever language the prose is in. The
profile, the lever bank and the rules are required in a present layer; the letter samples are not. A
fifth file, `memory.md`, has one required heading and no other form (see The memory below), and a
sixth, `letter-reader-examples.md`, has four (see The letter reader's examples below).

### The profile

`profile.md` opens with `<!-- candidate-profile-schema: 2 -->`; a profile declaring another version
of the map is refused. Then one level-one heading, the candidate's name, and the sections below in
this order, each heading word for word as the table writes it: a public rule links to it by an
anchor built from the whole heading, so a fixed heading carries no qualifier of its own.

| Heading                      | Section                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `## 1.`                      | Contacts & Logistics                                                                                                                                     |
| `## 2.`                      | Role & Seniority                                                                                                                                         |
| `## 3.`                      | Career Target & Priorities                                                                                                                               |
| `## 4.`                      | Compensation                                                                                                                                             |
| `## 5.`                      | Professional Identity                                                                                                                                    |
| `## 6.`                      | Technical Skills                                                                                                                                         |
| `### 6.1.` – `### 6.4.`      | Languages; Test Automation Frameworks & Tools; CI/CD & Infrastructure; Domain Skills                                                                     |
| `### 6.5.`                   | AI Tooling in Engineering Workflow                                                                                                                       |
| `#### 6.5.1.`, `#### 6.5.2.` | AI-assisted QA workflow; Agentic AI infrastructure                                                                                                       |
| `### 6.6.`                   | Other Technical Skills                                                                                                                                   |
| `## 7.`                      | Explicit Gaps                                                                                                                                            |
| `## 8.`                      | Work Approach & Team Style, with the unnumbered `###` subsections Decision-making, Communication, Values in a team, Working style, Strengths, Risk areas |
| `## 9.`                      | Experience: one `### 9.<n>. <employer> - <role>` per employer                                                                                            |
| `## 10.`                     | Personal Projects: one `### 10.<n>. <project>` per project                                                                                               |
| `## 11.`                     | Education                                                                                                                                                |
| `## 12.`                     | How to Present Short Tenures and the Current Situation — may be absent                                                                                   |

The entries of Experience and Personal Projects are numbered from one without a gap, and headings of
level four and deeper inside an entry are the candidate's own. Each project entry carries exactly
one line `**Visibility:** public` or `**Visibility:** private`, anywhere in the entry, its own
subsections included; a line inside a code fence does not count. That line is the only carrier of a
project's visibility: a word in the heading or a repository line is prose, and no rule decides by
it. An entry heading may carry a qualifier in parentheses after its title. A project's name is its
heading without the number and without that qualifier — `### 10.2. quiet-ledger (private)` names
`quiet-ledger` — and it is what the ban on a private project matches (see Entries derived from the
profile above).

### The lever bank

`levers.md` holds the candidate's levers: one `## Lever <id>` per lever, numbered from one without
a gap. Each section opens with its field lines in this order — `Statement:`, `Weight:` (an integer
from 1 to 5), `Condition:` (`broad`, or `conditional — ` followed by the trigger) and an optional
`Properties:` naming `ai-practice`, `ai-infrastructure` or both. Below the fields the anchors,
framing and stories are prose; an anchor links to the profile section it rests on, as
`profile.md#<anchor>`. After the last lever comes `## Positioning`, the emphasis per company type,
and an optional `## Stance`. What a lever is, what its axes mean and what the two properties decide
is owned by [the impact levers](../../knowledge/impact-levers.md#1-impact-levers).

### The rules

`rules.md` holds the candidate's own rules: how this person's material is worded, framed or ordered
where no configured value and no machine check can carry it. Where they rank against the engine's
rules is owned by
[the authority by responsibility](../../knowledge/precedence.md#1-authority-by-responsibility). The
file opens with
`<!-- candidate-rules-schema: 1 -->`; a file declaring another version is refused. Then one
level-one heading, and one `## <id>` per rule:

```markdown
## past-tense-former-employer

Scope: map-experience, generate-cv, write-cover-letter
Why: One line, for the person who reads the file later.

The rule itself, in any language: paragraphs, lists, `###` subsections.
```

The id is lowercase letters, digits and hyphens, starting with a letter, and unique in the file.
`Scope:` names one or more read points and `Why:` says why the rule exists; where the reason was
never recorded, `Why:` says so rather than inventing one. The text below the two lines is the
candidate's and is not read; a `###` inside it belongs to the rule. A file with no rules is valid,
and the file is still required: a layer that lost it would read the same as one without rules.

The read points are the six skills that read the file, each named as the skill is:
`get-vacancy`, `research-company`, `map-experience`, `generate-cv`, `write-cover-letter` and
`score-jobs`. Each skill names its own point in one sentence of its procedure, and
`tests/instruction-contracts.test.mjs` holds the skills and this list to each other. A rule whose
check a machine can make belongs in `constraints.json` as well: the rule says what to write, the
constraint refuses the publication that breaks it.

The rules are a protected input of Steps 3, 4 and 5, fingerprinted as a whole file: any edit stops
the processes already open until their brief is republished, as a release change does.

### The letter samples

`letter-samples.md` names its languages on one `Covered languages: <language>[, <language>]` line
before the first sample, then holds one `##` section per accepted letter, whole. A sample is
neither a rule nor a fact: it shows how a finished letter the user accepted reads, and no phrase,
metric or paragraph structure is carried from it into a new letter. A language the line does not
name has no samples, and the letter step goes without this input for a letter in it. The line names
only the default language and configured ones; any other is `candidate_letter_samples_invalid`.

### The memory

`memory.md` is the project's file-based memory: preferences, working style, open questions and
facts no other file holds yet. The operating contract says what belongs in it and sends a flag to
its `## Open questions`, so a present `memory.md` carries that heading (see The layer manifest);
the rest of its shape is free. It is optional.

### The letter reader's examples

`letter-reader-examples.md` holds examples of findings for the `letter-reader` agent: sentences from
letters the candidate published, each with what its reader said about it. A present file carries a
`##` heading for each list of the agent's answer — `## reread`, `## unclear_reference`,
`## missing_link` and `## translated` — which the manifest declares; the rest of its shape is free.
The letter step hands its path to the agent beside the letter, and the author does not read it. It
is optional: without it the agent reads a letter with no examples. No step pins it (see What a step
pins), because an edit changes how a letter is checked, not the letter.

The operational layer receives the real documents, the config beside them and the language packs,
from a named commit of the working tree's repository by the transfer step of
[docs/runbooks/ops-cutover.md](../../docs/runbooks/ops-cutover.md). A task that adds a file to the
layer adds it to that step's list. The example's files are never copied into it.

## The layer manifest

`candidate.example/manifest.json` declares what every layer holds: its files, which of them are
required, and the headings each markdown file must carry. The real layer carries no manifest of its
own; it is held to this one, which `manifest.mjs` reads from the example beside the code.

```json
{
  "manifest_version": 1,
  "files": [
    { "role": "profile", "path": "profile.md", "required": true, "headings": ["## 7. Explicit Gaps"] },
    { "role": "language_pack", "path": "languages/<language>/pack.json", "required": true }
  ]
}
```

An entry names a `role` (lowercase letters and underscores, unique), a `path` relative to the layer
root (unique), whether the file is `required`, and, for a markdown file, the `headings` it must
carry, each written with its level. `<language>` in a path stands for each language
`languages.additional` configures. The profile's headings are the fixed entries of its section map
less the optional How to Present Short Tenures and the Current Situation; `tests/candidate.test.mjs`
holds the two equal.

Every check of a present layer — `npm run candidate:check`, `bootstrap --check` and the pair check
of a cutover — ends with the manifest. A required file that is missing is
`candidate_layer_file_missing`, naming the file; a present file without a declared heading is
`candidate_layer_heading_missing`, naming the file and the heading. A heading is compared at its
level, word for word, and never inside a code fence. The earlier checks run
first, so a gap one of them reads keeps its own code; an optional file that is absent is not a gap.
A manifest this engine cannot read is `candidate_manifest_missing` or `candidate_manifest_invalid`
and refuses every layer.

A file or heading a public rule points at is declared here first: the link check below refuses a
link to one that is not.

## What a step pins

Steps 3 to 5 record the digest of every layer file they read, except the live ones below, in the
step's `published_inputs`, each under the kind `candidate_<role>` of its manifest role:

| Step                 | Roles pinned                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `map_experience`     | `levers`, `profile`, `rules`                                                                                                                                                           |
| `generate_cv`        | `config`, `constraints`, `profile`, `rules`                                                                                                                                            |
| `write_cover_letter` | `config`, `constraints`, `letter_samples`, `profile`, `rules`; for a letter in a configured language also that language's `language_pack`, `language_constraints` and `language_rules` |

An optional file is pinned while it holds bytes: an absent or empty one has no entry, and its
appearance is a change. A file is pinned whole, so any edit counts, whatever entry it touches.

An edit of a pinned file:

- during the step's open attempt refuses its publication with `inputs_changed`, and the step is
  retried;
- of a Step 3 file, after the brief is published, stops Steps 4 and 5 with `prerequisite_stale`
  until the brief is republished;
- of a Step 4 or 5 file, after that step published, stops nothing: `validate --deep` reports the
  step with `published_inputs_stale` and the layer's own issue, candidate_layer_drift. Restoring
  the file clears the report. A step `reconcile-step` recorded `stale` is cleared by `reopen-step`,
  or by a revision once the file is restored; a revision while the edit stands finalizes `stale`
  again.

Live — pinned by no step, so an edit stops and marks nothing: `memory.md`;
`letter-reader-examples.md`; a pack's `pins.json` and `pins/`; the packs of the languages other
than the letter's, although the letter check reads their script and subject word and judges the next
publication by them; the config at Step 3, whose language and market names every consumer of the
brief re-checks against the current config; and every file the manifest does not declare. `tests/candidate.test.mjs` holds the pinned roles to the
manifest and the live ones to this list.

A Step 4 or 5 recorded before these files were pinned has no entry for the config, and the layer
files it never pinned are not compared for it.

## Naming a key from a rule

A rule in `knowledge/` or `instructions/` names a setting as `candidate.config.` followed by the
key's dotted path. A path segment is lowercase letters, digits and underscores, and must begin
with a letter; segments are joined with dots. That single form is what `keys.mjs` scans for, and
`tests/candidate.test.mjs` compares what the rules name with what the schema declares, in both
directions. A bracketed placeholder is not a reference and is not scanned, which is why this file
and the rules can talk about the form without inventing a key.

## Naming a section from a rule

A document a run reads — every file under `instructions/` and `knowledge/`, every runbook they name,
and every tool README one of them names — names a section only by a link to its heading, never by
its number, in no form: neither the section sign, nor a word meaning "section" followed by a number, in
the link's text or anywhere else. A step and a rule are not sections. A section of another file is a
markdown link `[<words>](<path>#<anchor>)`, its path relative to the document; a section of the
document itself is `[<words>](#<anchor>)`; a section of the layer is `candidate/<path>#<anchor>`, as
in `candidate/profile.md#7-explicit-gaps`, and the path is one the manifest declares. The anchor is
GitHub's: the whole heading, its code marks dropped, lower-cased, with everything but letters with
their accents, digits, spaces, `-` and `_` removed and each space turned into `-`; repeated hyphens
stay, so `## 8. Work Approach & Team Style` gets the anchor `8-work-approach--team-style`, and a
repeated heading of one file gets `-1`, `-2`. The layer's own profile, lever bank, rules and
language rules follow the same rule: a link inside the layer is relative to its file, and a link
into the engine is written from the root of the checkout, as `knowledge/<file>#<anchor>`.

`tests/candidate.test.mjs` scans the documents with `checkCandidateLinks`: every section number is a
finding, and so is every link to a heading that does not open — a markdown link relative to its
document only, a path in code or prose relative to the document and then to the root. A layer
reference opens on the example: the file or directory is declared by the manifest and present in
the example, and an anchor names a heading the manifest declares for that file. A line inside a
code fence is not scanned, nor is a path whose file name is a placeholder in angle brackets, nor a
link to a code symbol such as `groups.mjs#collectionGroup`. A document a run reads never names the
tracked example; explanatory documents — this README, the other tool READMEs, decision records —
may, and a tool README is read for its section numbers and links only. The repository-wide check below also covers development documents and fenced examples.

`inspectCandidateLayer` holds the layer to the same rule with `checkCandidateLayerSections`: the
first section number or link that does not open in the profile, the lever bank, the rules or a
language's rules refuses with `candidate_section_reference_invalid`, naming the file and the line.
The letter samples and the memory are not read for it.

## Repository section links

All active instructions and READMEs, engine messages and source comments name internal sections
by heading links. `tests/section-links.test.mjs` checks these sources, including fenced code, for
number-based references and missing local targets. Paths in source code and engine messages are
repository-relative; Markdown links are relative to their document. Layer targets resolve on the
tracked example. The check is offline: it does not fetch external URLs or inspect private files.

Historical ADRs, product decisions, research, audits, task records, archives and external background
reports are outside this check.
`config/section-link-exceptions.json` lists exact fixture or syntax examples with their occurrence
counts and reasons; an unused exception fails. It never exempts a whole source file or code fence.

## Entry points

| Export                                                                   | File              | What it does                                                                                                                                                                                                         |
| ------------------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadCandidateConfig({ root })`                                          | `load.mjs`        | Validated config of the layer at `root`; the root must exist.                                                                                                                                                        |
| `inspectCandidateLayer({ root })`                                        | `load.mjs`        | `absent` or `ready` with the layer's language names; a present but broken layer, packs and manifest gaps included, still throws.                                                                                     |
| `candidateScoringValues({ root })`                                       | `load.mjs`        | The scoring values the scorer input carries, read from the config alone; `null` without a layer.                                                                                                                     |
| `candidateLanguageNames({ root })`                                       | `load.mjs`        | The default language and the configured ones, read from the config alone; the default alone without a layer.                                                                                                         |
| `candidateLanguages({ root })`                                           | `load.mjs`        | Every language with what a letter in it is checked by, the packs read.                                                                                                                                               |
| `candidateMarkets({ root })`                                             | `load.mjs`        | The two markets, read from the config alone; `null` without a layer.                                                                                                                                                 |
| `candidatePriorities({ root })`                                          | `load.mjs`        | The priority classes as the pre-triage stage takes them, read from the config alone; `null` without a layer.                                                                                                         |
| `candidateRootForCommand(checkoutRoot)`                                  | `load.mjs`        | The layer a command-line entry point reads: `JOB_PIPELINE_WORKSPACE_ROOT` or its checkout.                                                                                                                           |
| `loadCandidateDocuments({ root })`                                       | `load.mjs`        | The profile, lever bank, rules and letter samples at `root`, each checked against its form.                                                                                                                          |
| `loadCandidateProfile({ root })`                                         | `load.mjs`        | The profile alone, checked against the section map; `null` without a layer.                                                                                                                                          |
| `validateCandidateProfile(text)`                                         | `documents.mjs`   | The profile against the section map: employers, projects with name and visibility.                                                                                                                                   |
| `validateCandidateLevers(text)`                                          | `documents.mjs`   | The lever bank against its format: each lever's fields and properties.                                                                                                                                               |
| `validateCandidateRules(text)`                                           | `documents.mjs`   | The rules against their format: each rule's id, scope and reason.                                                                                                                                                    |
| `validateCandidateLetterSamples(text)`                                   | `documents.mjs`   | The covered languages and the samples.                                                                                                                                                                               |
| `candidateHeadings(text)`                                                | `documents.mjs`   | The headings of a markdown text, each with its whole title.                                                                                                                                                          |
| `loadCandidateManifest({ path })`                                        | `manifest.mjs`    | The layer manifest, by default the tracked example's, checked against its form.                                                                                                                                      |
| `checkCandidateLayerParity({ root, manifest, languages })`               | `manifest.mjs`    | The layer at `root` against the manifest: its required files and declared headings.                                                                                                                                  |
| `checkCandidateLinks({ root, exampleRoot, manifest, languages })`        | `manifest.mjs`    | Every reference into the layer the documents a run reads make under `root`, opened on the example; every section they and the tool READMEs they name give by number, and every link to a heading that does not open. |
| `checkCandidateLayerSections({ root, languages })`                       | `manifest.mjs`    | The layer at `root` names a section only by a link that opens, in its profile, lever bank, rules and language rules.                                                                                                 |
| `candidateHeadingSlug(title)`                                            | `manifest.mjs`    | The anchor of a heading, in GitHub's form.                                                                                                                                                                           |
| `candidateHeadingAnchors(text)`                                          | `manifest.mjs`    | The anchors of every heading of a markdown text, a repeat numbered as GitHub numbers it.                                                                                                                             |
| `validateCandidateConfig(value)`                                         | `load.mjs`        | The schema check on an already parsed value.                                                                                                                                                                         |
| `candidateConfigValue(config, path)`                                     | `load.mjs`        | The value at one declared path of a validated config.                                                                                                                                                                |
| `candidateRootFor(workspaceRoot)`                                        | `load.mjs`        | `<workspaceRoot>/candidate`.                                                                                                                                                                                         |
| `scanCandidateKeyReferences({ roots })`                                  | `keys.mjs`        | Every key the prose under `roots` names.                                                                                                                                                                             |
| `compareCandidateKeyCoverage({ declared, referenced })`                  | `keys.mjs`        | The two-way difference.                                                                                                                                                                                              |
| `loadCandidateConstraints({ root })`                                     | `constraints.mjs` | The constraints at `root`; `absent` when the file is not there.                                                                                                                                                      |
| `candidatePrivateProjectConstraints(profile)`                            | `constraints.mjs` | The entries a profile derives, one per private project.                                                                                                                                                              |
| `candidateConstraintsFor({ root, material, engineForbidden, language })` | `constraints.mjs` | Loaded, joined by the entries the profile derives, narrowed to one material, joined by the pack of the letter's language, then checked against that material's engine list.                                          |
| `loadAllCandidateConstraints({ root })`                                  | `constraints.mjs` | Every constraints file of the layer, packs included, and the derived entries, for a check.                                                                                                                           |
| `runCandidatePins({ root })`                                             | `pins.mjs`        | Every pin of every pack through the letter gate.                                                                                                                                                                     |
| `candidateConstraintFindings(constraints, text, { artifact })`           | `constraints.mjs` | The messages one material's text earns.                                                                                                                                                                              |

The root is always a parameter. A loader with a default would read the operator's real candidate
from a test, and the suite runs only on injected disposable roots. The callers that do have a
default — `tools/bootstrap.mjs`, `cli.mjs` here and the CLI of `tools/cv-builder/build.mjs` —
derive it from their workspace root; the lifecycle publisher derives it from the workspace of the
process it publishes.

## Checking a layer

```sh
npm run candidate:check
npm run candidate:check -- --root /absolute/path/to/candidate.example
```

Read-only, prints one JSON object, and exits non-zero on a broken layer. An absent layer is
reported as `absent` and is not an error: a task worktree legitimately has none. A present
layer reports how many levers, projects, rules and letter samples its documents hold, how many
constraints its files hold, packs and the entries its profile derives included, whether its own
constraints file is there, its languages, and how many pins it ran; a pin that does not hold is a
refusal, and so is a gap the layer manifest names.

`letter_corrections` counts the records of the letter-correction corpus in its two homes
([tools/letter-corrections/README.md](../letter-corrections/README.md)): `layer` in the layer's
own `research/letter-corrections/`, `run` in `records/letter-corrections/` of the workspace the
layer belongs to. A home without a corpus is `null`. With `--root` the run's corpus is not read and
`run` is `not_checked`. A broken or misnamed record refuses with `corpus_record_invalid`, naming the
home and the file.

It is not part of `npm run ci`, for the same reason `bootstrap --check` is not: without `--root`
it resolves to the working checkout, and no stage of the gate may read operator state.

## Refusal codes

`candidate_root_invalid`, `candidate_config_missing`, `candidate_config_unreadable`,
`candidate_config_invalid_json`, `candidate_config_shape_invalid`,
`candidate_schema_version_missing`, `candidate_schema_version_unsupported`,
`candidate_config_unknown_key`, `candidate_config_key_missing`,
`candidate_config_key_type_invalid`, `candidate_config_value_invalid`,
`candidate_schema_key_type_unknown`, `candidate_schema_relation_invalid`,
`candidate_key_root_invalid`.

From the layer manifest: `candidate_manifest_missing`, `candidate_manifest_invalid`,
`candidate_layer_file_missing`, `candidate_layer_heading_missing`,
`candidate_section_reference_invalid`.

From the documents: `candidate_document_missing`, `candidate_document_unreadable`,
`candidate_profile_schema_version_missing`, `candidate_profile_schema_version_unsupported`,
`candidate_profile_heading_invalid`, `candidate_profile_visibility_invalid`,
`candidate_levers_invalid`, `candidate_letter_samples_invalid`, `candidate_rules_invalid`,
`candidate_rules_schema_version_missing`, `candidate_rules_schema_version_unsupported`.

From the language packs: `candidate_language_pack_missing`, `candidate_language_pack_unconfigured`,
`candidate_language_pack_unreadable`, `candidate_language_pack_invalid_json`,
`candidate_language_pack_invalid`, `candidate_pins_invalid`, `candidate_pin_failed`.

From the constraints file: `candidate_constraints_unreadable`,
`candidate_constraints_invalid_json`, `candidate_constraints_shape_invalid`,
`candidate_constraints_schema_version_missing`,
`candidate_constraints_schema_version_unsupported`, `candidate_constraint_id_invalid`,
`candidate_constraint_id_duplicate`, `candidate_constraint_type_unknown`,
`candidate_constraint_unknown_field`, `candidate_constraint_scope_invalid`,
`candidate_constraint_payload_invalid`, `candidate_constraint_why_invalid`,
`candidate_constraint_conflicts_with_engine`.

The list is frozen against this file by `tests/candidate.test.mjs`. The CLI adds
`invalid_candidate_arguments`.

A schema version this engine does not read is a refusal, never a warning: a config written for
another schema is not a config with an extra field, it is a file whose meaning this code does not
know.
