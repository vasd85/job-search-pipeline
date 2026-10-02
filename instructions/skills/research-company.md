# research-company

**Explicit Step 2 of the per-role pipeline.** Research the company from current Step 1 files and
publish one sourced `company-research.json`.

**Input:** exactly one file-backed process selector. Do not accept a pasted Step 1 summary as the
data handoff.

Read and follow the shared
[file-backed pipeline artifact contract](../pipeline-artifacts.md). Resolve and preflight
`research_company`, then use `begin-step`, `retry-step`, or `reopen-step` as authorized by the
current record. Read `vacancy.json` and `job-description.txt` only from the resolved process's
reserved output directory.

## Responsibility boundary

This step owns evidence collection and factual classification. It identifies product/engineering
challenge types, stated values, culture signals, practical application facts, factual tailoring
hooks, and the audience's AI literacy.

It does **not** select impact levers, choose an AI register, write a positioning thesis, choose CV
structure/header/projects, select cover-letter evidence/keywords, or make an apply/no-apply
decision. Those role-specific decisions belong exclusively to `map-experience`. CV and
cover-letter generation never consume `company-research.json` directly.

Read `candidate/rules.md` in the candidate layer — the candidate's rules whose `Scope:` names
`research-company`, read after the canon this step reads; a candidate rule narrows that canon and
never overrides it
([authority by responsibility](../../knowledge/precedence.md#1-authority-by-responsibility)).

Optional delegation may help with source-category research, but it must follow the shared
single-publisher rule.

## Output language

Narrative and claim text in the artifact is in the working language of the
[operating contract](../operating-contract.md). Preserve company/product/technology names and
JD/stack wording verbatim. Every evidence quote keeps the original text and its translation into the
working language as separate validator-owned fields. Chat follows the global
[operating contract](../operating-contract.md).

## Evidence procedure

1. Use the Step 1 market and feasibility facts as referenced inputs. Research may add sourced facts
   but must not silently replace original vacancy wording. Contractor/payment logistics is required
   for the market outside home; use the schema-supported not-applicable result for the home market.
2. Search all coverage categories owned by
   `tools/pipeline-artifacts/validate-company-research.mjs`: stated values; product/technical
   complexity; engineering content; other vacancies across at least two boards; GitHub/GitLab;
   engineering leadership; current employee profiles; reviews in the default language, English
   (`reviews_default_language`); reviews in the configured languages,
   `candidate.config.languages.additional` (`reviews_additional_languages`); compensation; recent news/AI direction; and contractor/payment
   logistics.
3. Treat search results, AI overviews, and aggregator summaries as discovery pointers only. Open a
   primary page before marking a claim verified. Before recording not-found, retry a raw or more
   specific route. For GitHub, leadership, and vacancies, also try legal, legacy, parent/acquirer,
   transliterated, and alternate brand names.
4. Attribute a practice or stack to the company only from a company-owned artifact or a verified
   current/recent employee, and record the team/role scope in the claim's `scope`; a claim a
   tailoring hook cites writes `scope` by the level convention of the Tailoring hooks section
   below. Do not merge different teams into a company-wide stack. A named-handoff stack claim
   needs two independent sources or remains unverified.
5. Apply the per-source depth bar:
   - quote stated values and record the primary URL;
   - open actual engineering articles/talks and extract concrete practices, tools, CI/reliability
     details, author, and URL;
   - inspect the company board and at least one independent vacancy source, separating team-specific
     and company-wide stacks;
   - inspect relevant repositories and test/e2e directories plus activity;
   - inspect two to four current QA/SDET/engineering profiles when available;
   - keep the evidence of the two review categories separate and preserve contradictions;
   - record compensation with currency, period, geography, and source;
   - record paying entity/jurisdiction, engagement model, payment rails, and restrictions;
   - inspect current first-party direction plus recent funding/stage and explicit AI announcements.
6. Enrich the linked company only with verified name variants and first-party domains through the
   process-log company commands. If company matching is still ambiguous, record the candidate
   clusters instead of choosing one.

## Tailoring hooks

A tailoring hook pairs a challenge type with an exact sourced fact and selects no lever or
positioning decision. Every hook has a level, and the level is written into the `scope` of each
claim the hook cites: `role: <role title as vacancy.json names it>`, `team: <team, product, or
project as the source names it>`, or `company`. Claims no hook cites keep `scope` as before. A
hook's level is the weakest level among its claims (`role` above `team` above `company`); a cited
claim with `scope: null` makes the hook `company` level.

- `role` — a task or requirement the vacancy itself states for this role. Its source is the
  vacancy page, recorded as a source with the Step 1 URL under the category that opened it; that
  source does not count toward the two-board minimum of `other_vacancies`.
- `team` — a task, change, or challenge that the team, product, or project this role joins states
  about itself, or a descriptive fact about that product whose level the team structure below
  assigns. Sources: another open vacancy of the company for the same team or product, a team or
  product page of the company site, a company blog or social-media post, a talk or news item
  about that team.
- `company` — every other fact.

Team structure decides the level of a descriptive product fact, and the structure itself is
recorded as a claim with a source: one product and one team — team and company levels coincide
and the product fact is `team` level; several products, each with its own team — a fact about the
role's product is `team` level; one product and several teams — first establish which team the
role joins and which product facts belong to that team, and until that is established the fact
stays `company` level.

A `role` or `team` hook needs a proven link, and both halves stand on the source page: the
source names this vacancy, its team, or its product by the name the Step 1 files use — a shared
role family is not a link — and the fact is stated there, not inferred. `challengeType` is a task
or challenge the source states; it is never inferred from a descriptive fact about the product,
stack, delivery model, or customers, at any level. A claim says no more than its quoted source
says. Do not raise a company fact to `team` level by inference, and do not merge a company-wide
fact with a vacancy sentence into one hook.

A `role` or `team` hook is current on the application date: a live vacancy or a page that states
the present proves it; a dated talk, article, or archived page proves only its own date, and
`observedAt` is the observation date, not the fact's date. Write the fact's date into the source
`notes` when it differs from `observedAt`.

Search `team` level in this order: the vacancy page; the
company's other open vacancies for the same team or product through the `other_vacancies`
sources; team or product pages of the company site; the company blog, social accounts, talks, and
news about the team. Record both negative outcomes; neither stays silent and neither raises a
company fact:

- not found — the `sourceCoverage` row of the category searched carries the routes in `queries`,
  `openedPrimaryUrls`, and `details`, and the recruiter question stays a question of high
  decision weight, such as which product or team the role works in;
- found but the link is not proven — the fact is recorded at `company` level, and the coverage
  row's `details` says what is missing for the proof.

Of the three to five hooks, at least one is `role` level and cites a task of the vacancy itself.
`company` hooks stay in the research and are unfit for the letter's angle; `map-experience` owns
that selection.

## Artifact content

Create staged `company-research.json` with the exact schema owned by
`tools/pipeline-artifacts/validate-company-research.mjs`. Populate every coverage category, source,
claim, analysis block, tailoring hook, open question, and Verify Gate field from this run:

- coverage-level unavailable/not-found evidence is an honest research result and does not by itself
  block the lifecycle;
- each load-bearing claim is verified, unverified, or inferred with the required provenance;
- analysis covers company overview, product/technical complexity, engineering culture, values and
  culture, key people, factual AI-literacy classification, compensation, contractor/payment facts,
  interview process, risks, and what the company values in engineers;
- three to five tailoring hooks pair a challenge type with an exact sourced fact by the Tailoring
  hooks section above, without selecting a lever or positioning decision;
- material unknowns become recruiter questions ordered by decision weight;
- the Verify Gate blocks only a genuinely unrecoverable fact/ambiguity that prevents honest safe
  downstream work, not merely an inaccessible individual source.

The artifact references the exact Step 1 inputs by digest and does not copy the full vacancy or JD.

## Validate, publish, and return

Validate the staged candidate against canonical Step 1 bytes:

```sh
node tools/pipeline-artifacts/validate-company-research.mjs \
  output/<company-role>/.pipeline-tmp/<publication-id>/company-research.json \
  output/<company-role>/vacancy.json \
  output/<company-role>/job-description.txt \
  --outcome completed
```

Use `--outcome blocked` only when the Verify Gate has a validator-supported unrecoverable gap, and
publish it with the same blocker code. Otherwise publish `completed`. If research execution fails
without a validator-valid blocked bundle, close the active attempt with `fail-step`.

Return only a compact summary: process id, artifact path, coverage counts, Verify Gate
status, publication result, and any blocker/open decision. Do not paste the research report or tool
narration into chat.
