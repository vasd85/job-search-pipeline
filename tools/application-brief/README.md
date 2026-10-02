# Application brief contract

`application-brief.json` is the compact Step 3 decision handoff consumed by CV and cover-letter
generation. The validator is the machine owner of its exact schema and semantic constraints:

```sh
node tools/application-brief/validate.mjs output/<company-role>/application-brief.json
```

## Files in this directory

- `shape-example.json` is an intentionally incomplete, abstract field-shape reference for
  `map-experience`. It explains where current-run values belong. It is not validator-valid and is
  never a content source.
- `fixtures/application-brief.v4.valid.json` is a complete deterministic fixture of the version
  Step 3 writes. It is used only by automated tests and validator development. A real pipeline run
  must not read it, copy it, or use its values as defaults.
- `validate.mjs` owns required fields, exact nested keys, cardinalities, enums, references, and
  cross-file validation.

## Construction rule

For every real application, start from the selected process and its current validated vacancy,
job-description, company-research, candidate-profile and lever-bank bytes. The profile and the
lever bank are `candidate/profile.md` and `candidate/levers.md` of the candidate layer; bundle
validation takes all six files, and a lever's register rules are checked against the properties
the bank gives it. Create every value from those
inputs:

- do not copy company names, role facts, IDs, digests, claims, keywords, evidence choices, lever
  wording, rationales, placements, or checks from either reference file;
- create run-local IDs and references only after selecting the current run's facts and evidence;
- close every required evidence-backed ATS keyword into executable `cvPlan.checks.requiredEvidence`
  entries that share support evidence and guarantee its `any`/`all` placement obligation;
- treat the fixtures as test data even when a field appears reusable;
- stop if a required value cannot be supported rather than borrowing a plausible example value.

## Top-level responsibilities

| Field | Meaning |
| --- | --- |
| `createdAt`, `process`, `inputs` | Current process identity and exact input-byte references |
| `role` | Selected vacancy facts, preserving the Step 1 feasibility shape |
| `company` | Selected Step 2 challenge, values, and hooks with research provenance |
| `positioning` | Current application levers, rationale, angle, and AI decision |
| `experience` | Selected profile-backed evidence, traits, and honest gaps |
| `ats` | Exact current-JD terms with evidence-or-gap support and placements |
| `cvPlan` | Final CV structure and machine-enforceable content decisions |
| `coverLetterPlan` | Final selected evidence IDs and exact ATS terms for the letter |

`shape-example.json` shows representative variants, including an evidence-backed keyword and a
hard-gap keyword. It deliberately contains fewer than the required 15–25 keywords and placeholder
values, so validation must fail if it is accidentally used as an application artifact.
