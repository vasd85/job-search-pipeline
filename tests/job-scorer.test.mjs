import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  candidateExampleRootFor,
  candidateLanguageNames,
  validateCandidateConfig,
  CandidateError,
} from "../tools/candidate/load.mjs";
import { DOMAIN_FIT_DOMAINS } from "../tools/candidate/scoring.mjs";

import {
  NORMALIZED_INPUT_SCHEMA_VERSION,
  SUPPORTED_INPUT_SCHEMA_VERSIONS,
  ScorerInputError,
  TRIAGE_POLICY_ID,
  normalizeScorerInput as normalizeScorerInputWith,
} from "../tools/job-scorer/normalized-input.mjs";
import {
  bucketFor,
  decideNormalizedJob as decideNormalizedJobWith,
  mobilityCap,
} from "../tools/job-scorer/decide.mjs";
import {
  buildDecisionTrace as buildDecisionTraceWith,
  rankDecisionTraces,
  summaryRow,
} from "../tools/job-scorer/trace.mjs";
import {
  TOOLMATCH_TAXONOMY_ID,
  LANGUAGE_NAMES,
  frameworkClassFor,
  isSupportingName,
  resolveToolName,
} from "../tools/job-scorer/tool-taxonomy.mjs";
import { resolveSourceSet, validateSourceResolution } from "../tools/triage-sources/reconcile.mjs";
import { fictionalSourceFixture } from "./fixtures/triage-source-context/cases.mjs";
import {
  annotationCases,
  baseInput,
  baseObservedTool,
  baseObservedLanguage,
  baseOffer,
  compensationCases,
  declaredDecisionCases,
  formatCases,
  markUnread,
  mobilityCases,
  onsiteResidenceResidual,
  terminalCases,
  toolCases,
} from "./fixtures/job-scorer/decision-table.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(repoRoot, "tests/fixtures/job-scorer");
const fixtureManifest = Object.freeze(["decision-table.mjs"]);

// The language names come from the tracked example — the default language and Greek — never from the
// operator's layer. The three wrappers pass them so each case states only what it is about.
const exampleLanguageNames = candidateLanguageNames({ root: candidateExampleRootFor(repoRoot) });
const normalizeScorerInput = (input, options = {}) =>
  normalizeScorerInputWith(input, { languages: exampleLanguageNames, ...options });
const decideNormalizedJob = (input, options = {}) =>
  decideNormalizedJobWith(input, { languages: exampleLanguageNames, ...options });
const buildDecisionTrace = (input, options = {}) =>
  buildDecisionTraceWith(input, { languages: exampleLanguageNames, ...options });
const EXPECTED_DECISION_CASE_COUNT = 517;
const executedDecisionCases = new Set();

test("full post/company/contact yields one manual SKIP with explicit source accounting", () => {
  const fixture = fictionalSourceFixture({ manual: true, contact: true, details: false });
  const resolution = resolveSourceSet(fixture);
  assert.equal(resolution.groups.length, 1);
  assert.equal(resolution.groups[0].result.skip_code, "manual_role");
  assert.equal(resolution.counts.context_urls, 1);
  assert.equal(
    resolution.groups[0].sources.find((source) => source.role === "contact").disposition,
    "contact",
  );
  assert.ok(
    !resolution.observations.some(
      (observation) => observation.source_ref === "https://fictional-labs.example.test/",
    ),
  );
  assert.equal(validateSourceResolution(resolution, fixture), resolution);
});

test("summary plus direct apply keeps full details JD without standalone original input", () => {
  const fixture = fictionalSourceFixture({ kind: "summary", manual: true });
  const resolution = resolveSourceSet(fixture);
  assert.equal(resolution.counts.logical_vacancies, 1);
  assert.equal(resolution.groups[0].result.skip_code, "manual_role");
  assert.equal(
    resolution.groups[0].primary,
    resolution.observations.find(
      (observation) => observation.source_ref === fixture.target.source_ref,
    ).observation_ref,
  );
  assert.equal(resolution.url_accounting.length, 2);
  assert.ok(!resolution.url_accounting.some((row) => row.url === fixture.snapshot.original_url));
  assert.equal(
    resolution.observations.find(
      (observation) => observation.source_ref === fixture.snapshot.original_url,
    ).trace,
    null,
  );
});

test("full original preserves Junior and salary when linked publication is silent", () => {
  const fixture = fictionalSourceFixture({ junior: true, salary: "ARS 2,000,000 net per month" });
  fixture.target.body = fixture.target.body
    .replace("Junior+", "Six months of experience")
    .replace("ARS 2,000,000 net per month", "Salary discussed later");
  fixture.target.capture.sha256 = "b".repeat(64);
  fixture.target.facts.seniority = null;
  fixture.target.facts.salary = null;
  fixture.target.input = fixture.inputFor(fixture.target.source_ref, fixture.target.body, {
    index: 2,
    primary: false,
    captureSha256: fixture.target.capture.sha256,
    seniority: "lower",
    observedSalary: null,
  });
  fixture.target.input.role.evidence.seniority = "Six months of experience";
  const confirmed = resolveSourceSet(fixture);
  assert.equal(confirmed.groups[0].identity_status, "confirmed");
  assert.equal(confirmed.groups[0].result.skip_code, "junior_role");
  assert.equal(confirmed.groups[0].result.salary_raw, "ARS 2,000,000 net per month");
  assert.equal(
    confirmed.observations.find(
      (observation) => observation.source_ref === fixture.target.source_ref,
    ).input.compensation,
    null,
  );
  fixture.target.identity_status = "linked_unconfirmed";
  const unresolved = resolveSourceSet(fixture);
  assert.equal(unresolved.groups[0].result.review_code, "source_review");
  assert.equal(unresolved.groups[0].alternatives.length, 2);
  assert.ok(
    unresolved.groups[0].alternatives.some(
      (alternative) => alternative.trace.skip_code === "junior_role",
    ),
  );
  assert.ok(
    unresolved.groups[0].alternatives.some(
      (alternative) => alternative.trace.decision === "EVALUATED",
    ),
  );
});

test("explicit source contradictions require review and foreign evidence is refused", () => {
  const fixture = fictionalSourceFixture();
  fixture.target.body = fixture.target.body.replace("Senior QA Engineer", "Junior+");
  fixture.target.facts.seniority = { value: "Junior+", evidence_quote: "Junior+" };
  fixture.target.input.role.seniority = "junior";
  fixture.target.input.role.evidence.seniority = "Junior+";
  const resolution = resolveSourceSet(fixture);
  assert.equal(resolution.groups[0].result.review_code, "source_review");
  assert.ok(resolution.groups[0].conflicts.includes("conflicting_seniority"));
  fixture.original.input.role.evidence.seniority = "Junior+";
  assert.throws(
    () => resolveSourceSet(fixture),
    (error) => error.code === "source_resolution_invalid",
  );
});

test("summary cannot pass to scoring and source resolution cannot forge the primary result", () => {
  const fixture = fictionalSourceFixture({ kind: "summary" });
  const resolution = resolveSourceSet(fixture);
  const forged = structuredClone(resolution);
  forged.groups[0].result.decision = "BLOCKED";
  assert.throws(
    () => validateSourceResolution(forged, fixture),
    (error) => error.code === "source_resolution_invalid",
  );
  fixture.original.input = fixture.inputFor(fixture.snapshot.original_url, fixture.original.body);
  assert.throws(
    () => resolveSourceSet(fixture),
    (error) => error.code === "source_resolution_invalid",
  );
});

test("source context epoch preserves manual and junior filters and the legacy epoch", () => {
  for (const [field, value, code] of [
    ["automation", "manual_only", "manual_role"],
    ["seniority", "junior", "junior_role"],
  ]) {
    const legacy = baseInput();
    legacy.role[field] = value;
    const current = {
      ...structuredClone(legacy),
      schemaVersion: 10,
      policyId: "triage-policy-v9-2026-10-08",
      sourceContext: null,
    };
    assert.equal(buildDecisionTrace(current).skip_code, code);
    assert.equal(buildDecisionTrace(legacy).skip_code, code);
    assert.equal(buildDecisionTrace(legacy).policy_id, "triage-policy-v8-2026-10-01");
    assert.equal(normalizeScorerInput(current).schemaVersion, 10);
  }
});

test("active full original and closed linked job source require source review", () => {
  const fixture = fictionalSourceFixture();
  const failure = fixture.target;
  failure.description_kind = "unknown";
  failure.identity_status = "linked_unconfirmed";
  failure.capture = null;
  failure.body = null;
  failure.facts = Object.fromEntries(Object.keys(failure.facts).map((key) => [key, null]));
  markUnread(failure.input, "closed", "HTTP 404 after retry");
  failure.input.source.evidenceQuote = null;
  failure.input.role.evidence = Object.fromEntries(
    Object.keys(failure.input.role.evidence).map((key) => [key, null]),
  );
  failure.input.offers = [];
  failure.input.compensation = null;
  Object.assign(failure.input.sourceContext, {
    primaryCaptureSha256: null,
    startLine: null,
    endLine: null,
  });
  failure.transport = { file: "fetch-manifest.json", sha256: "a".repeat(64), index: 1 };
  const resolution = resolveSourceSet(fixture);
  assert.equal(resolution.groups[0].result.review_code, "source_review");
  assert.ok(resolution.groups[0].conflicts.includes("conflicting_liveness"));
  assert.ok(
    resolution.groups[0].alternatives.some(
      (item) => item.trace.skip_code === "vacancy_unavailable",
    ),
  );
  assert.ok(resolution.groups[0].alternatives.some((item) => item.trace.decision === "EVALUATED"));
});

test("source observation extraction ordinal is bounded to the artifact filename contract", () => {
  const fixture = fictionalSourceFixture({ details: false });
  fixture.original.input.inputIndex = 1000;
  assert.throws(
    () => resolveSourceSet(fixture),
    (error) => error.code === "source_resolution_invalid",
  );
});

// Which family a `gap:` token belongs to, so a case can pin its own dimension exactly instead of
// asserting a subset and letting a stray annotation through.
const MOBILITY_GAPS = Object.freeze([
  "gap:company_region_absent",
  "gap:mobility_branch_unresolved",
  "gap:relocation_country_absent",
  "gap:relocation_country_unlisted",
  "gap:relocation_country_unresolved",
  "gap:residence_requirement_country_unresolved",
  "gap:residence_restriction_absent",
  "gap:work_format_absent",
]);
const COMPENSATION_GAPS = Object.freeze([
  "gap:compensation_absent",
  "gap:compensation_basis_incomparable",
  "gap:compensation_fx_unavailable",
  "gap:compensation_market_curve_absent",
  "gap:compensation_period_absent",
]);
const COMPENSATION_ASSUMPTIONS = Object.freeze([
  "assumption:compensation.basis_advertised_gross",
  "assumption:compensation.floor_currency_fallback",
  "assumption:compensation.range_crosses_floor",
]);
const ENGAGEMENT_ASSUMPTIONS = Object.freeze([
  "assumption:engagement_path.outside_home_contractor",
  "assumption:engagement_path.relocation",
  "assumption:engagement_path.home_employment",
]);
const SKILL_GAPS = Object.freeze([
  "gap:automation_share_absent",
  "gap:seniority_absent",
  "gap:stack_absent",
  "gap:test_language_absent",
  "gap:test_framework_absent",
  "gap:stack_ambiguous",
]);

function only(values, family) {
  return values.filter((value) => family.includes(value));
}

// knowledge/job-match-rules.md#7-decision-trace-contract's field list, frozen. The absence rules are as load-bearing as the fields: a `bucket` on a
// skipped trace or a missing `skip_basis` is a contract break, and only a whole-key-set assertion
// catches an added field.
const COMMON_TRACE_KEYS = Object.freeze([
  "input_index",
  "source_ref",
  "final_url",
  "job_title",
  "company",
  "location_raw",
  "work_format_raw",
  "salary_raw",
  "work_formats_observed",
  "selected_work_format",
  "company_regions_observed",
  "selected_company_region",
  "sponsorship",
  "workAuthorization",
  "residenceRestriction",
  "contractorEligibility",
  "relocationSupport",
  "relocation_destination",
  "engagement_path",
  "compensation_floor",
  "fx_provider",
  "fx_rate_date",
  "fx_rate",
  "ai_in_product",
  "ai_in_work",
  "decision",
  "data_gaps",
  "assumptions",
  "policy_id",
]);
const TRACE_KEYS = Object.freeze({
  BLOCKED: Object.freeze([
    ...COMMON_TRACE_KEYS,
    "blocker_code",
    "blocker_reason",
    "symptom",
    "evidence_quote",
  ]),
  EVALUATED: Object.freeze([
    ...COMMON_TRACE_KEYS,
    "M_score",
    "M_reason",
    "M_evidence_quote",
    "C_score",
    "C_reason",
    "C_evidence_quote",
    "S_score",
    "S_reason",
    "S_evidence_quote",
    "D_score",
    "D_reason",
    "D_evidence_quote",
    "match_raw",
    "mobility_cap",
    "match_percent",
    "bucket",
    "short_reason",
    "toolmatch_taxonomy_id",
    "tool_breakdown",
    "tool_match_score",
  ]),
  MANUAL_REVIEW: Object.freeze([
    ...COMMON_TRACE_KEYS,
    "review_code",
    "review_reason",
    "evidence_quote",
  ]),
  SKIP: Object.freeze([
    ...COMMON_TRACE_KEYS,
    "skip_code",
    "skip_reason",
    "evidence_quote",
    "skip_basis",
  ]),
});

function assertTraceShape(trace, label) {
  const expected = [...TRACE_KEYS[trace.decision]];
  // `symptom` is required for `vacancy_unavailable` and for no other skip code.
  if (trace.decision === "SKIP" && trace.skip_code === "vacancy_unavailable")
    expected.push("symptom");
  assert.deepEqual(Object.keys(trace).sort(), expected.sort(), label);
  if (trace.decision === "SKIP") {
    // knowledge/job-match-rules.md#7-decision-trace-contract: a skip's evidence quote may be `null` in exactly two cases - a 404-only closure and the
    // WEST authorization silence, where the reason is the absence of text.
    const quoteMayBeNull =
      trace.skip_basis === "west_relocation_authorization_silent" ||
      (trace.skip_code === "vacancy_unavailable" && trace.symptom === "HTTP 404 after retry");
    if (!quoteMayBeNull) assert.notEqual(trace.evidence_quote, null, `${label}: evidence quote`);
  }
  if (trace.decision !== "EVALUATED") return;
  // knowledge/job-match-rules.md#7-decision-trace-contract: "Dimension fields are always emitted in M/C/S/D order" - a sorted key set cannot see it.
  const keys = Object.keys(trace);
  assert.deepEqual(
    keys.filter((key) => /^[MCSD]_(score|reason|evidence_quote)$/.test(key)),
    [
      "M_score",
      "M_reason",
      "M_evidence_quote",
      "C_score",
      "C_reason",
      "C_evidence_quote",
      "S_score",
      "S_reason",
      "S_evidence_quote",
      "D_score",
      "D_reason",
      "D_evidence_quote",
    ],
    label,
  );
}

function markDecisionCaseExecuted(id) {
  executedDecisionCases.add(id);
}

function expectedDecisionCaseIds() {
  const ids = [];
  for (const family of ["qa_testing", "other"]) {
    for (const language of ["English", "Greek", "unsupported"]) {
      for (const feasibility of ["clear", "explicit", "mobility"]) {
        for (const automation of ["primary", "manager_only", "manual_only"]) {
          for (const seniority of ["senior", "junior"]) {
            for (const compensation of ["at_floor", "below"]) {
              ids.push(
                `terminal:${family}:${language}:${feasibility}:${automation}:${seniority}:${compensation}`,
              );
            }
          }
        }
      }
    }
  }
  ids.push(
    "terminal:multi-offer:explicit-over-mobility",
    "terminal:closed:outranks-not-qa",
    "terminal:malta:formal-spelling",
    "terminal:malta:spelling:city-and-country",
    "terminal:malta:spelling:country-and-city",
    "terminal:malta:spelling:greek-spelling",
    "terminal:malta:spelling:residence-requirement",
    "terminal:malta:uncoded-name-does-not-exclude",
    "terminal:malta:uncoded-residence-does-not-exclude",
    "terminal:malta:on-site",
    "terminal:malta:remote-residence-requirement",
    "terminal:malta:outranks-mobility",
    "terminal:malta:remote-company-scored",
    "terminal:mobility:authorization-required-existing",
    "terminal:mobility:sponsorship-unavailable",
    "terminal:mobility:west-silence",
    "terminal:mobility:remote-residence-refused",
    "terminal:mobility:inside-set-not-closed",
    "terminal:mobility:undecidable-destination",
    "terminal:mobility:undecidable-authorization",
    "terminal:mobility:undecidable-sponsorship",
    "terminal:mobility:region-answers-inside-set",
    "terminal:mobility:spelling-keeps-a-set-member-inside",
    "terminal:mobility:spelling-keeps-a-traditional-name-inside",
    "terminal:mobility:spelling-keeps-a-formal-name-inside",
    "terminal:mobility:city-and-country-keeps-a-set-member-inside",
    "terminal:mobility:unresolved-name-decides-nothing",
    "terminal:mobility:named-non-member-closes",
    "terminal:mobility:named-non-member-closes-west",
    "terminal:mobility:remote-residence-open-contractor",
    "terminal:mobility:remote-residence-open-authorization",
    "terminal:mobility:remote-residence-open-sponsorship",
    "terminal:mobility:remote-residence-open-relocation-support",
    "terminal:mobility:opened-by-sponsorship",
    "terminal:mobility:opened-by-relocation-support",
    "terminal:mobility:opened-by-authorization",
  );
  for (const westRegion of ["US_CANADA", "EU_UK"]) {
    for (const timezone of ["tz_any", "tz_home", "tz_local", "tz_unknown"]) {
      for (const restriction of ["none", "compatible", "incompatible", "unknown"]) {
        ids.push(`mobility:west:${westRegion}:${timezone}:${restriction}`);
      }
    }
  }
  for (const [region, distance, timezone] of [
    ["OTHER", "near", "tz_any"],
    ["OTHER", "near", "tz_home"],
    ["OTHER", "near", "tz_local"],
    ["OTHER", "near", "tz_unknown"],
    ["OTHER", "far", "tz_any"],
    ["OTHER", "far", "tz_home"],
    ["OTHER", "far", "tz_local"],
    ["OTHER", "far", "tz_unknown"],
    ["UNKNOWN", "unknown", "tz_any"],
    ["UNKNOWN", "unknown", "tz_home"],
    ["UNKNOWN", "unknown", "tz_local"],
    ["UNKNOWN", "unknown", "tz_unknown"],
    ["HOME", "near", "tz_any"],
    ["HOME", "near", "tz_local"],
    ["HOME", "far", "tz_local"],
    ["HOME", "unknown", "tz_unknown"],
    ["OTHER", "unknown", "tz_unknown"],
  ])
    ids.push(`mobility:${region}:${distance}:${timezone}`);
  for (const country of [
    "New Zealand",
    "Brunei",
    "Macao",
    "Maldives",
    "Hong Kong",
    "Taiwan",
    "Mauritius",
    "China",
    "Indonesia",
    "South Africa",
    "Seychelles",
    "Dominican Republic",
    "Panama",
    "Costa Rica",
    "Colombia",
    "Mexico",
    "Chile",
    "Ecuador",
    "Uruguay",
    "Bolivia",
    "Paraguay",
    "Guyana",
    "Argentina",
    "Suriname",
    "Belize",
    "Peru",
  ]) {
    ids.push(`mobility:relocation:${country}:no_support`);
    ids.push(`mobility:relocation:${country}:support`);
  }
  ids.push(
    "mobility:relocation:named-west-country",
    "mobility:relocation:west-tier-without-bonus",
    "mobility:relocation:unlisted-country",
    "mobility:relocation:spelling:nz-abbreviation",
    "mobility:relocation:spelling:formal-argentina",
    "mobility:relocation:spelling:city-and-country",
    "mobility:relocation:spelling:country-and-city",
    "mobility:relocation:spelling:greek-spelling",
    "mobility:relocation:unresolved:other",
    "mobility:relocation:unresolved:west",
    "mobility:relocation:unresolved:branch-a",
    "mobility:relocation:unresolved:remote-reads-no-destination",
    "mobility:residence-requirement:unresolved:remote",
    "mobility:sponsorship:OTHER:relocation",
    "mobility:sponsorship:HOME:relocation",
  );
  for (const region of ["WEST", "HOME", "OTHER", "UNKNOWN"]) {
    ids.push(`mobility:relocation:unnamed:${region}`);
  }
  for (const format of ["Remote", "Hybrid", "On-site"]) {
    ids.push(`mobility:sponsorship:WEST:${format}`);
  }
  ids.push("mobility:middle:no-offer-observed", "mobility:middle:unknown-format");
  for (const suffix of [
    "home-at-floor",
    "home-range-above",
    "home-crossing",
    "below-floor-1999999",
    "below-floor-1800000",
    "below-floor-1799999",
    "below-floor-1600000",
    "below-floor-1599999",
    "below-floor-1400000",
    "below-floor-1399999",
    "below-floor-1000000",
    "below-floor-999999",
    "below-floor-1",
    "below-floor-range-max",
    "home-contractor-below",
    "home-contractor-at-floor",
    "intl-3199.999",
    "intl-3200",
    "intl-3700",
    "intl-4199.999",
    "intl-4200",
    "intl-4700",
    "intl-5199.999",
    "intl-5200",
    "intl-annual",
    "intl-hourly",
    "basis-mismatch",
    "basis-unknown",
    "period-unknown",
    "period-and-basis-unknown",
    "salary-absent",
    "comparable-usd",
    "comparable-chf",
    "comparable-third-currency",
    "comparable-third-currency-no-fx",
    "intl-fx",
    "intl-fx-missing",
    "intl-fx-wrong-provider",
    "intl-fx-reversed",
    "home-official-rate",
    "relocation-no-salary-no-override",
    "relocation-other-market",
    "relocation-unknown-market",
    "relocation-below-override",
    "relocation-invalid-override-with-salary",
    "relocation-invalid-override-no-salary",
    "relocation-remote-us",
    "intl-override-2400-2000",
    "intl-override-2400-2399",
    "intl-override-2400-2400",
    "intl-override-2400-2800",
    "intl-override-2400-3199",
    "intl-override-2400-3200",
    "intl-override-2400-3700",
    "intl-range-crosses-floor",
    "intl-override-crossing-below-band",
    "comparable-below-floor",
    "relocation-uk-band-with-usd-override",
    "relocation-us-140000",
    "relocation-us-139999",
    "relocation-us-120000",
    "relocation-us-119999",
    "relocation-us-95000",
    "relocation-us-94999",
    "relocation-us-75000",
    "relocation-us-74999",
    "relocation-uk-80000",
    "relocation-uk-79999",
    "relocation-uk-65000",
    "relocation-uk-64999",
    "relocation-uk-50000",
    "relocation-uk-49999",
    "relocation-uk-40000",
    "relocation-uk-39999",
    "relocation-canada-140000",
    "relocation-canada-139999",
    "relocation-canada-120000",
    "relocation-canada-119999",
    "relocation-canada-95000",
    "relocation-canada-94999",
    "relocation-canada-75000",
    "relocation-canada-74999",
    "advertised-gross-us-annual",
    "advertised-gross-us-range-crosses-floor",
    "advertised-gross-uk-fx",
    "advertised-gross-uk-fx-missing",
    "advertised-gross-canada-fx",
    "advertised-gross-other-market",
    "advertised-gross-unknown-market",
    "advertised-gross-stated-net-kept",
    "advertised-gross-stated-gross-no-token",
    "advertised-gross-net-floor",
    "advertised-gross-override-net",
    "advertised-gross-override-gross-below-band",
    "advertised-gross-relocation-lane-unchanged",
    "advertised-gross-period-unknown",
    "advertised-gross-us-below-floor",
    "advertised-gross-no-offer-observed",
    "advertised-gross-relocation-override-gross",
  ])
    ids.push(`compensation:${suffix}`);
  ids.push(
    "format:hybrid-before-onsite",
    "format:case-b-all-three",
    "format:pairing-unclear",
    "format:unknown-only",
    "format:no-offer-observed",
    "format:two-remote-paths",
    "format:two-undecidable-paths",
    "format:undecidable-path-still-counts",
    "format:skip-infeasible-remote",
    "format:skip-explicit-ineligible-when-feasible-path-exists",
    "format:no-sponsorship-local",
    "format:no-sponsorship-b2b",
    "format:incompatible-residence-scored",
  );
  for (const suffix of [
    "independent-best",
    "python-same-framework",
    "java-same-framework",
    "unpriced-language",
    "framework-without-language",
    "language-without-framework",
    "unknown",
    "optional-only",
    "supporting-only",
    "known-mismatch",
    "unrecognised-main-framework",
    "unrecognised-language",
    "runner-with-unfamiliar-appium",
    "unmatched-required-no-penalty",
    "optional-never-selects",
    "product-only",
    "ambiguous",
    "maximum-does-not-sum",
    "former-modern-no-bonus",
  ])
    ids.push(`stack:${suffix}`);
  for (const suffix of [
    "engagement:remote-west",
    "engagement:remote-home",
    "engagement:unresolved-format-unknown-region",
    "engagement:unresolved-format-home",
    "engagement:unresolved-format-other",
    "engagement:onsite-other",
    "engagement:onsite-home",
    "engagement:observed-path-is-never-defaulted",
  ])
    ids.push(`annotation:${suffix}`);
  ids.push("residual:onsite-residence-requirement");
  return Object.freeze(ids);
}

const expectedDecisionIds = expectedDecisionCaseIds();

test("fixture manifest and directory match in both directions", () => {
  const directory = readdirSync(fixtureRoot).sort();
  assert.deepEqual(directory, [...fixtureManifest].sort());
  assert.deepEqual([...fixtureManifest].sort(), directory);
  assert.equal(expectedDecisionIds.length, EXPECTED_DECISION_CASE_COUNT);
  assert.equal(new Set(expectedDecisionIds).size, EXPECTED_DECISION_CASE_COUNT);
  assert.equal(declaredDecisionCases.length, EXPECTED_DECISION_CASE_COUNT);
  assert.equal(
    new Set(declaredDecisionCases.map(({ id }) => id)).size,
    EXPECTED_DECISION_CASE_COUNT,
  );
  assert.deepEqual(
    declaredDecisionCases.map(({ id }) => id).sort(),
    [...expectedDecisionIds].sort(),
  );
  assert.equal(terminalCases.length, 252);
  assert.equal(mobilityCases.length, 125);
  assert.equal(compensationCases.length, 99);
  assert.equal(formatCases.length, 13);
  assert.equal(toolCases.length, 19);
  assert.equal(annotationCases.length, 8);
});

for (const fixture of terminalCases) {
  test(fixture.id, () => {
    const trace = buildDecisionTrace(fixture.input);
    assertTraceShape(trace, fixture.id);
    if (fixture.expected === null) {
      assert.equal(trace.decision, "EVALUATED");
      assert.equal(Object.hasOwn(trace, "skip_code"), false);
    } else {
      assert.equal(trace.decision, "SKIP");
      assert.equal(trace.skip_code, fixture.expected);
      if (fixture.evidenceQuote) assert.equal(trace.evidence_quote, fixture.evidenceQuote);
      assert.equal(trace.skip_basis, fixture.skipBasis ?? null);
      assert.equal(Object.hasOwn(trace, "M_score"), false);
      assert.equal(Object.hasOwn(trace, "match_percent"), false);
      // A skipped trace has no dimension score for a middle to have entered (knowledge/job-match-rules.md#7-decision-trace-contract).
      assert.deepEqual(trace.data_gaps, []);
      assert.deepEqual(trace.assumptions, []);
    }
    if (Object.hasOwn(fixture, "destination")) {
      assert.equal(trace.relocation_destination, fixture.destination);
    }
    markDecisionCaseExecuted(fixture.id);
  });
}

for (const fixture of mobilityCases) {
  test(fixture.id, () => {
    const trace = buildDecisionTrace(fixture.input);
    assertTraceShape(trace, fixture.id);
    assert.equal(trace.decision, "EVALUATED");
    assert.equal(trace.M_score, fixture.expected);
    assert.deepEqual(only(trace.data_gaps, MOBILITY_GAPS), fixture.gaps);
    // knowledge/job-match-rules.md#7-decision-trace-contract records the country the listing named, at the listing's own spelling. Every reading keys on
    // the code, so without this the name in a fixture is a string nothing observes.
    if (Object.hasOwn(fixture, "destination")) {
      assert.equal(trace.relocation_destination, fixture.destination);
    }
    markDecisionCaseExecuted(fixture.id);
  });
}

for (const fixture of compensationCases) {
  test(fixture.id, () => {
    const trace = buildDecisionTrace(fixture.input);
    assertTraceShape(trace, fixture.id);
    assert.equal(trace.decision, fixture.expected.decision);
    if (fixture.expected.reviewReason)
      assert.equal(trace.review_reason, fixture.expected.reviewReason);
    if (fixture.expected.score !== undefined) assert.equal(trace.C_score, fixture.expected.score);
    if (trace.decision === "EVALUATED") {
      assert.deepEqual(only(trace.data_gaps, COMPENSATION_GAPS), fixture.expected.gaps ?? []);
      assert.deepEqual(
        only(trace.assumptions, COMPENSATION_ASSUMPTIONS),
        fixture.expected.assumptions ?? [],
      );
    } else {
      assert.equal(Object.hasOwn(trace, "C_score"), false);
      assert.equal(Object.hasOwn(trace, "match_percent"), false);
      assert.deepEqual(trace.data_gaps, []);
      assert.deepEqual(trace.assumptions, []);
    }
    markDecisionCaseExecuted(fixture.id);
  });
}

for (const fixture of formatCases) {
  test(fixture.id, () => {
    const trace = buildDecisionTrace(fixture.input);
    assertTraceShape(trace, fixture.id);
    assert.equal(trace.decision, fixture.expected.decision);
    assert.equal(trace.selected_work_format, fixture.expected.selected);
    if (fixture.expected.reviewReason)
      assert.equal(trace.review_reason, fixture.expected.reviewReason);
    markDecisionCaseExecuted(fixture.id);
  });
}

for (const fixture of toolCases) {
  test(fixture.id, () => {
    const trace = buildDecisionTrace(fixture.input);
    assertTraceShape(trace, fixture.id);
    assert.equal(trace.decision, "EVALUATED");
    assert.equal(trace.toolmatch_taxonomy_id, "toolmatch-taxonomy-v6-2026-10-01");
    assert.match(trace.S_reason, new RegExp(`ToolMatch ${fixture.expected.toolMatch}\\b`));
    assert.equal(trace.tool_match_score, fixture.expected.toolMatch);
    assert.deepEqual(only(trace.data_gaps, SKILL_GAPS), fixture.expected.gaps ?? []);
    markDecisionCaseExecuted(fixture.id);
  });
}

for (const fixture of annotationCases) {
  test(fixture.id, () => {
    const trace = buildDecisionTrace(fixture.input);
    assertTraceShape(trace, fixture.id);
    assert.equal(trace.decision, "EVALUATED");
    assert.equal(trace.engagement_path, fixture.expected.engagementPath);
    assert.deepEqual(only(trace.assumptions, ENGAGEMENT_ASSUMPTIONS), fixture.expected.assumptions);
    markDecisionCaseExecuted(fixture.id);
  });
}

test(onsiteResidenceResidual.id, () => {
  // The residual knowledge/job-match-rules.md#22-accepted-triage-decision-record records and backlog task 38 owns: an on-site listing demanding that the
  // candidate already live in the destination is scored, not skipped. Frozen at the measured
  // figure so closing the hole is a deliberate edit here rather than a silent behaviour change.
  const trace = buildDecisionTrace(onsiteResidenceResidual.input);
  assert.equal(trace.decision, onsiteResidenceResidual.expected.decision);
  assert.equal(trace.match_percent, onsiteResidenceResidual.expected.matchPercent);
  assert.equal(trace.bucket, onsiteResidenceResidual.expected.bucket);
  assert.equal(trace.residenceRestriction, "incompatible");
  markDecisionCaseExecuted(onsiteResidenceResidual.id);
});

test("every declared decision case executes exactly once", () => {
  assert.deepEqual([...executedDecisionCases].sort(), [...expectedDecisionIds].sort());
});

test("strict normalized input contract rejects drift with stable identity", () => {
  assert.equal(NORMALIZED_INPUT_SCHEMA_VERSION, 10);
  assert.deepEqual([...SUPPORTED_INPUT_SCHEMA_VERSIONS], [9, 10]);
  assert.equal(TRIAGE_POLICY_ID, "triage-policy-v9-2026-10-08");
  const cases = [
    [
      "unknown root key",
      (input) => {
        input.extra = true;
      },
      "input: must have exact keys",
    ],
    [
      "no scoring values",
      (input) => {
        delete input.candidateScoring;
      },
      "input: must have exact keys",
    ],
    [
      "schema version",
      (input) => {
        input.schemaVersion = 11;
      },
      "schemaVersion: must be 9 or 10; earlier versions are no longer read",
    ],
    [
      "positive input index",
      (input) => {
        input.inputIndex = 0;
      },
      "inputIndex: must be a positive integer",
    ],
    [
      "policy id",
      (input) => {
        input.policyId = "other";
      },
      "policyId: must be triage-policy-v8-2026-10-01",
    ],
    // Version 9 exists only under the live record: every earlier one scores the domains in the engine,
    // the ones before that price the tools there too, and the ones before those name the country of
    // the candidate in its vocabulary.
    [
      "previous policy id",
      (input) => {
        input.policyId = "triage-policy-v5-2026-09-30";
      },
      "policyId: must be triage-policy-v8-2026-10-01",
    ],
    [
      "superseded policy id",
      (input) => {
        input.policyId = "triage-policy-v4-2026-09-27";
      },
      "policyId: must be triage-policy-v8-2026-10-01",
    ],
    [
      "amended policy id",
      (input) => {
        input.policyId = "triage-policy-v3-2026-09-02";
      },
      "policyId: must be triage-policy-v8-2026-10-01",
    ],
    [
      "prior policy id",
      (input) => {
        input.policyId = "triage-policy-v2-2026-08-21";
      },
      "policyId: must be triage-policy-v8-2026-10-01",
    ],
    // The domain is one of the names the candidate places, or one of the two the engine scores itself.
    [
      "domain the vocabulary does not name",
      (input) => {
        input.role.domain = "logistics";
      },
      "role.domain: unsupported value logistics",
    ],
    // The scoring values are checked by the candidate configuration's own rules.
    [
      "scoring value outside the configuration's bounds",
      (input) => {
        input.candidateScoring.mobility.feasible_residences = ["ZZ"];
      },
      "candidateScoring: candidate config key mobility.feasible_residences must be",
    ],
    [
      "scoring value naming a WEST residence",
      (input) => {
        input.candidateScoring.mobility.feasible_residences.push("DE");
      },
      "candidateScoring: candidate config key mobility.feasible_residences must be",
    ],
    [
      "tool price naming no member of the table",
      (input) => {
        input.candidateScoring.tool_match.frameworks.push({
          name: "Selenide@python",
          points: 1,
          experience: "direct",
        });
      },
      "candidateScoring: candidate config key tool_match.frameworks must be",
    ],
    [
      "tool priced twice",
      (input) => {
        input.candidateScoring.tool_match.frameworks.push({
          ...input.candidateScoring.tool_match.frameworks[0],
        });
      },
      "candidateScoring: candidate config key tool_match.frameworks must be",
    ],
    [
      "no tool prices",
      (input) => {
        delete input.candidateScoring.tool_match;
      },
      "candidateScoring: candidate config omits a declared key: tool_match.languages",
    ],
    [
      "domain placed between steps",
      (input) => {
        input.candidateScoring.domain_fit.web3 = 7;
      },
      "candidateScoring: domain points must be declared domain steps",
    ],
    [
      "domain left unplaced",
      (input) => {
        delete input.candidateScoring.domain_fit.telecom;
      },
      "candidateScoring: candidate config omits a declared key: domain_fit.telecom",
    ],
    [
      "domain the engine does not name placed",
      (input) => {
        input.candidateScoring.domain_fit.logistics = 9;
      },
      "candidateScoring: candidate config declares a key the schema does not: domain_fit.logistics",
    ],
    [
      "scoring values missing a key",
      (input) => {
        delete input.candidateScoring.compensation.target;
      },
      "candidateScoring: candidate config omits a declared key: compensation.target",
    ],
    [
      "scoring values carrying rule 10's set",
      (input) => {
        input.candidateScoring.mobility.self_relocation = ["CR"];
      },
      "candidateScoring: candidate config declares a key the schema does not: mobility.self_relocation",
    ],
    [
      "scoring values out of order",
      (input) => {
        input.candidateScoring.compensation.target = 3200;
      },
      "candidateScoring: candidate config key compensation.floors.outside_home_contractor.amount must stay below compensation.target",
    ],
    [
      "FX from a provider the candidate does not name",
      (input) => {
        input.fx = {
          provider: "BCRX",
          rateDate: "2026-08-21",
          sourceCurrency: "ARS",
          targetCurrency: "USD",
          targetPerSource: 0.0016,
        };
      },
      "fx.provider: unsupported value BCRX",
    ],
    [
      "invalid scoring month",
      (input) => {
        input.scoringDate = "2026-13-01";
      },
      "scoringDate: must be a real YYYY-MM-DD calendar date",
    ],
    [
      "invalid scoring day",
      (input) => {
        input.scoringDate = "2026-04-31";
      },
      "scoringDate: must be a real YYYY-MM-DD calendar date",
    ],
    [
      "invalid non-leap day",
      (input) => {
        input.scoringDate = "2026-02-29";
      },
      "scoringDate: must be a real YYYY-MM-DD calendar date",
    ],
    [
      "invalid century leap day",
      (input) => {
        input.scoringDate = "1900-02-29";
      },
      "scoringDate: must be a real YYYY-MM-DD calendar date",
    ],
    [
      "uppercase currency",
      (input) => {
        input.compensation.currency = "usd";
      },
      "compensation.currency: must be a three-letter uppercase currency code",
    ],
    [
      "offer evidence",
      (input) => {
        input.offers[0].evidenceQuote = null;
      },
      "offers[0].evidenceQuote: must be a non-empty string",
    ],
    [
      "salary evidence",
      (input) => {
        input.compensation.evidenceQuote = null;
      },
      "compensation.evidenceQuote: must be a non-empty string",
    ],
    [
      "not-QA evidence",
      (input) => {
        input.role.family = "other";
        input.role.evidence.role = null;
      },
      "role.evidence.role: required for not_qa_or_testing_role",
    ],
    [
      "language evidence",
      (input) => {
        input.role.language = "unsupported";
        input.role.evidence.language = null;
      },
      "role.evidence.language: required for language_not_supported",
    ],
    [
      "manager evidence",
      (input) => {
        input.role.automation = "manager_only";
        input.role.evidence.automation = null;
      },
      "role.evidence.automation: required for manager_role",
    ],
    [
      "manual evidence",
      (input) => {
        input.role.automation = "manual_only";
        input.role.evidence.automation = null;
      },
      "role.evidence.automation: required for manual_role",
    ],
    [
      "junior evidence",
      (input) => {
        input.role.seniority = "junior";
        input.role.evidence.seniority = null;
      },
      "role.evidence.seniority: required for junior_role",
    ],
    [
      "west subtype",
      (input) => {
        input.offers[0].companyRegion = "WEST";
      },
      "offers[0].westRegion: must be present exactly for WEST offers",
    ],
    [
      "duplicate offer",
      (input) => {
        input.offers.push(structuredClone(input.offers[0]));
      },
      "offers: must not contain duplicate offers",
    ],
    [
      "range order",
      (input) => {
        input.compensation.kind = "range";
        input.compensation.minimum = 3000000;
      },
      "compensation: minimum must not exceed maximum",
    ],
    [
      "FX direction",
      (input) => {
        input.fx = {
          provider: "ECB",
          rateDate: "2026-08-21",
          sourceCurrency: "USD",
          targetCurrency: "USD",
          targetPerSource: 1,
        };
      },
      "fx: must convert between different currencies",
    ],
    [
      "future FX date",
      (input) => {
        input.fx = {
          provider: "ECB",
          rateDate: "2026-08-23",
          sourceCurrency: "EUR",
          targetCurrency: "USD",
          targetPerSource: 1.2,
        };
      },
      "fx.rateDate: must not be later than scoringDate",
    ],
    [
      "invalid FX date",
      (input) => {
        input.fx = {
          provider: "ECB",
          rateDate: "2026-02-29",
          sourceCurrency: "EUR",
          targetCurrency: "USD",
          targetPerSource: 1.2,
        };
      },
      "fx.rateDate: must be a real YYYY-MM-DD calendar date",
    ],
    [
      "blocked symptom",
      (input) => {
        input.source.accessOutcome = "technical_unavailable";
        input.source.accessReason = null;
      },
      "source.accessReason: required for technical_unavailable",
    ],
    [
      "closed symptom",
      (input) => {
        input.source.accessOutcome = "closed";
        input.role.observedLanguages = [];
        input.role.observedTools = [];
        input.source.accessReason = null;
      },
      "source.accessReason: required for closed",
    ],
    [
      "closed evidence",
      (input) => {
        input.source.accessOutcome = "closed";
        input.role.observedLanguages = [];
        input.role.observedTools = [];
        input.source.accessReason = "expired";
        input.source.evidenceQuote = null;
      },
      "source.evidenceQuote: required for closed unless symptom is HTTP 404",
    ],
    [
      "pre-retry 404 evidence",
      (input) => {
        input.source.accessOutcome = "closed";
        input.role.observedLanguages = [];
        input.role.observedTools = [];
        input.source.accessReason = "HTTP 404 before retry";
        input.source.evidenceQuote = null;
      },
      "source.evidenceQuote: required for closed unless symptom is HTTP 404",
    ],
    [
      "negated 404 evidence",
      (input) => {
        input.source.accessOutcome = "closed";
        input.role.observedLanguages = [];
        input.role.observedTools = [];
        input.source.accessReason = "not HTTP 404 after retry";
        input.source.evidenceQuote = null;
      },
      "source.evidenceQuote: required for closed unless symptom is HTTP 404",
    ],
    [
      "override scope",
      (input) => {
        input.explicitOverride = {
          amount: 1,
          basis: "gross",
          currency: "USD",
          period: "monthly",
          scope: "role",
        };
      },
      "explicitOverride.scope: must be exact batch",
    ],
    // Version 2's own additions: the tool shape, the region taxonomy and the residence-requirement
    // country each reject exactly what invited a fabricated ToolMatch under version 1.
    [
      "retired tool shape",
      (input) => {
        input.role.observedTools = [
          { contributions: [6], id: "playwright", optionalModern: false, requirement: "required" },
        ];
      },
      "role.observedTools[0]: must have exact keys",
    ],
    [
      "model-supplied contribution",
      (input) => {
        input.role.observedTools[0].contribution = 6;
      },
      "role.observedTools[0]: must have exact keys",
    ],
    [
      "tool name",
      (input) => {
        input.role.observedTools[0].name = "";
      },
      "role.observedTools[0].name: must be a non-empty string",
    ],
    [
      "language recorded as a tool",
      (input) => {
        input.role.observedTools[0].name = "TypeScript";
      },
      "role.observedTools[0].name: programming languages must be language observations",
    ],
    [
      "unsupported requirement",
      (input) => {
        input.role.observedTools[0].requirement = "must-have";
      },
      "role.observedTools[0].requirement: unsupported value must-have",
    ],
    [
      "duplicate observation",
      (input) => {
        input.role.observedTools.push(structuredClone(input.role.observedTools[0]));
      },
      "role.observedTools: must not contain duplicate observations",
    ],
    [
      "retired engagement unknown",
      (input) => {
        input.offers[0].engagementPath = "unknown";
      },
      "offers[0].engagementPath: unsupported value unknown",
    ],
    [
      "residence requirement without a restriction",
      (input) => {
        input.offers[0].residenceRequirementCountry = "Malta";
      },
      "offers[0].residenceRequirementCountry: requires an observed residence restriction",
    ],
    // Version 3's own additions. A destination code is an ISO 3166-1 alpha-2 code and nothing else,
    // and it identifies a name the listing carried: neither half may drift on its own.
    [
      "invented destination code",
      (input) => {
        input.offers[0].relocationCountry = "Ruritania";
        input.offers[0].relocationCountryCode = "ZZ";
      },
      "offers[0].relocationCountryCode: must be null or an ISO 3166-1 alpha-2 country code",
    ],
    [
      "lowercase destination code",
      (input) => {
        input.offers[0].relocationCountry = "Costa Rica";
        input.offers[0].relocationCountryCode = "cr";
      },
      "offers[0].relocationCountryCode: must be null or an ISO 3166-1 alpha-2 country code",
    ],
    [
      "destination code without a name",
      (input) => {
        input.offers[0].relocationCountryCode = "CR";
      },
      "offers[0].relocationCountryCode: requires the country name the listing used",
    ],
    [
      "invented residence requirement code",
      (input) => {
        input.offers[0].residenceRestriction = "incompatible";
        input.offers[0].residenceRequirementCountry = "Ruritania";
        input.offers[0].residenceRequirementCountryCode = "ZZ";
      },
      "offers[0].residenceRequirementCountryCode: must be null or an ISO 3166-1 alpha-2 country code",
    ],
    [
      "residence requirement code without a name",
      (input) => {
        input.offers[0].residenceRestriction = "incompatible";
        input.offers[0].residenceRequirementCountryCode = "MT";
      },
      "offers[0].residenceRequirementCountryCode: requires the country name the listing used",
    ],
    [
      "version-2 offer under version 4",
      (input) => {
        delete input.offers[0].relocationCountryCode;
      },
      "offers[0]: must have exact keys",
    ],
    // Version 4's own additions: two closed vocabularies, a quote exactly where a value says
    // something, and `unknown` exactly where the rubric does not read the description.
    [
      "version-3 role under version 4",
      (input) => {
        delete input.role.ai;
      },
      "role: must have exact keys",
    ],
    [
      "version-3 evidence under version 4",
      (input) => {
        delete input.role.evidence.aiWork;
      },
      "role.evidence: must have exact keys",
    ],
    [
      "AI key drift",
      (input) => {
        input.role.ai.summary = "LLM testing";
      },
      "role.ai: must have exact keys",
    ],
    [
      "unsupported AI product value",
      (input) => {
        input.role.ai.product = "ai_company";
      },
      "role.ai.product: unsupported value ai_company",
    ],
    [
      "unsupported AI work value",
      (input) => {
        input.role.ai.work = "encouraged";
      },
      "role.ai.work: unsupported value encouraged",
    ],
    [
      "AI product without its quote",
      (input) => {
        input.role.ai.product = "tested_by_role";
      },
      "role.evidence.aiProduct: required for role.ai.product tested_by_role",
    ],
    [
      "AI work without its quote",
      (input) => {
        input.role.ai.work = "optional";
      },
      "role.evidence.aiWork: required for role.ai.work optional",
    ],
    [
      "a quote behind a silent product axis",
      (input) => {
        input.role.evidence.aiProduct = "AI-powered search";
      },
      "role.evidence.aiProduct: must be null for role.ai.product none",
    ],
    [
      "a quote behind a silent work axis",
      (input) => {
        input.role.ai.work = "unknown";
        input.role.evidence.aiWork = "Copilot";
      },
      "role.evidence.aiWork: must be null for role.ai.work unknown",
    ],
    [
      "unknown on a read description",
      (input) => {
        input.role.ai.product = "unknown";
      },
      "role.ai.product: must not be unknown for a description the rubric reads",
    ],
    [
      "silence on an unread page",
      (input) => {
        input.source.accessOutcome = "technical_unavailable";
        input.source.accessReason = "timeout";
        input.role.observedLanguages = [];
        input.role.observedTools = [];
        input.role.ai.work = "unknown";
      },
      "role.ai.product: must be unknown for technical_unavailable: the description was not read",
    ],
    [
      "a statement on a closed page",
      (input) => {
        input.source.accessOutcome = "closed";
        input.role.observedLanguages = [];
        input.role.observedTools = [];
        input.source.accessReason = "HTTP 404 after retry";
        input.role.ai.product = "unknown";
        input.role.ai.work = "required";
        input.role.evidence.aiWork = "AI tools";
      },
      "role.ai.work: must be unknown for closed: the description was not read",
    ],
  ];
  for (const [name, mutate, message] of cases) {
    const input = baseInput();
    mutate(input);
    assert.throws(
      () => normalizeScorerInput(input),
      (error) =>
        error instanceof ScorerInputError &&
        error.code === "invalid_scorer_input" &&
        error.message.startsWith(message),
      name,
    );
  }
  const leapDay = baseInput();
  leapDay.scoringDate = "2028-02-29";
  assert.equal(normalizeScorerInput(leapDay).scoringDate, "2028-02-29");
  leapDay.scoringDate = "2000-02-29";
  assert.equal(normalizeScorerInput(leapDay).scoringDate, "2000-02-29");

  const closed404 = markUnread(baseInput(), "closed", "HTTP 404 after retry");
  closed404.source.evidenceQuote = null;
  assert.equal(normalizeScorerInput(closed404).source.evidenceQuote, null);

  // A scoreable role with no offered path at all is legal now: it is a gap, and knowledge/job-match-rules.md#22-accepted-triage-decision-record answers a gap
  // with a middle instead of refusing the input.
  const noOffers = baseInput();
  noOffers.offers = [];
  assert.deepEqual(normalizeScorerInput(noOffers).offers, []);

  // The AI axes carry what was said, with its quote, and `unknown` is legal exactly where the
  // rubric stops before the description: at the title and at an unsupported language.
  const stated = baseInput();
  stated.role.ai = { product: "tested_by_role", work: "optional" };
  stated.role.evidence.aiProduct = "Тестировать AI-функциональность";
  stated.role.evidence.aiWork = "Использование AI-инструментов";
  assert.deepEqual(normalizeScorerInput(stated).role.ai, {
    product: "tested_by_role",
    work: "optional",
  });
  for (const [name, mutate] of [
    [
      "title-only role",
      (input) => {
        input.role.family = "other";
      },
    ],
    [
      "unsupported language",
      (input) => {
        input.role.language = "unsupported";
      },
    ],
  ]) {
    const input = baseInput();
    mutate(input);
    input.role.ai = { product: "unknown", work: "unknown" };
    assert.deepEqual(
      normalizeScorerInput(input).role.ai,
      { product: "unknown", work: "unknown" },
      name,
    );
  }
  const unread = markUnread(baseInput(), "technical_unavailable", "timeout");
  assert.deepEqual(normalizeScorerInput(unread).role.ai, { product: "unknown", work: "unknown" });
});

test("every earlier input version is refused, and so is its record", () => {
  // The user decided on 27 September 2026 that the readers of versions 1 to 4 go, version 5 went
  // with task 215 and version 6 with task 226: recomputing them needs the tool prices and the domain
  // scores the engine no longer carries. An earlier shape is refused before a single field of it is
  // read, whichever record it names, so no object built for an earlier record is read - or scored -
  // under this one.
  for (const version of [1, 2, 3, 4, 5, 6, 7, 8]) {
    for (const policyId of [
      TRIAGE_POLICY_ID,
      "triage-policy-v6-2026-09-30",
      "triage-policy-v5-2026-09-30",
      "triage-policy-v4-2026-09-27",
      "triage-policy-v3-2026-09-02",
      "triage-policy-v2-2026-08-21",
      "triage-r1-05a-2026-08-04",
    ]) {
      const input = { ...baseInput(), policyId, schemaVersion: version };
      for (const call of [normalizeScorerInput, decideNormalizedJob, buildDecisionTrace]) {
        assert.throws(
          () => call(input),
          (error) =>
            error instanceof ScorerInputError &&
            error.message === "schemaVersion: must be 9 or 10; earlier versions are no longer read",
          `version ${version} under ${policyId}`,
        );
      }
    }
  }
});

test("the scoring values a caller passes must be the ones the input carries", () => {
  const input = baseInput();
  const own = structuredClone(input.candidateScoring);
  assert.equal(buildDecisionTrace(input, { scoring: own }).decision, "EVALUATED");
  // Key order is not a difference: the comparison is of the values.
  const reordered = {
    scoring: own.scoring,
    tool_match: own.tool_match,
    mobility: own.mobility,
    domain_fit: own.domain_fit,
    compensation: own.compensation,
  };
  assert.equal(buildDecisionTrace(input, { scoring: reordered }).decision, "EVALUATED");
  const other = structuredClone(own);
  other.compensation.target = 5200;
  for (const call of [normalizeScorerInput, decideNormalizedJob, buildDecisionTrace]) {
    assert.throws(
      () => call(input, { scoring: other }),
      (error) =>
        error instanceof ScorerInputError &&
        error.message === "candidateScoring: must equal the scoring values of the candidate layer",
    );
  }
  // Without one, the input's own values are the ones scored: that is how a recorded batch is
  // recomputed after the configuration moved on.
  assert.equal(buildDecisionTrace(input).decision, "EVALUATED");
});

test("normalization returns an immutable independent value", () => {
  const input = baseInput();
  const normalized = normalizeScorerInput(input);
  input.source.company = "Changed";
  assert.equal(normalized.source.company, "Synthetic Company");
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.offers[0]), true);
  assert.throws(() => {
    normalized.source.company = "Mutated";
  }, TypeError);
});

test("technical and explicit closure outcomes stay distinct", () => {
  const technical = markUnread(
    baseInput(),
    "technical_unavailable",
    "rendering failed after retry",
  );
  technical.source.finalUrl = null;
  const blocked = buildDecisionTrace(technical);
  assertTraceShape(blocked, "blocked");
  assert.equal(blocked.decision, "BLOCKED");
  assert.equal(blocked.blocker_code, "vacancy_unavailable");
  assert.equal(blocked.symptom, "rendering failed after retry");
  assert.equal(Object.hasOwn(blocked, "skip_code"), false);
  assert.equal(Object.hasOwn(blocked, "M_score"), false);
  // A blocked trace has no source text for anything to be missing from (knowledge/job-match-rules.md#7-decision-trace-contract).
  assert.deepEqual(blocked.data_gaps, []);
  assert.deepEqual(blocked.assumptions, []);

  const closed = markUnread(baseInput(), "closed", "HTTP 404 after retry");
  const skipped = buildDecisionTrace(closed);
  assert.equal(skipped.decision, "SKIP");
  assert.equal(skipped.skip_code, "vacancy_unavailable");
  assert.equal(skipped.symptom, "HTTP 404 after retry");
  assert.equal(skipped.skip_basis, null);
  assert.equal(Object.hasOwn(skipped, "blocker_code"), false);

  const titleOnly = markUnread(
    baseInput(),
    "technical_unavailable",
    "rendering failed after retry",
  );
  titleOnly.role.family = "other";
  const earlySkip = buildDecisionTrace(titleOnly);
  assert.equal(earlySkip.decision, "SKIP");
  assert.equal(earlySkip.skip_code, "not_qa_or_testing_role");
  assert.equal(Object.hasOwn(earlySkip, "blocker_code"), false);
});

test("a non-evaluated trace still carries the observed facts, not placeholders", () => {
  const skipped = baseInput();
  skipped.compensation = null;
  skipped.offers = [
    baseOffer({
      companyRegion: "WEST",
      compensationMarket: "other",
      contractorEligibility: "ineligible",
      engagementPath: "relocation_employment",
      evidenceQuote: "On-site in Berlin",
      relocationCountry: "Germany",
      relocationCountryCode: "DE",
      relocationSupport: "unavailable",
      residenceRestriction: "unknown",
      sponsorship: "unknown",
      westRegion: "EU_UK",
      workAuthorization: "unknown",
      workFormat: "On-site",
    }),
  ];
  const trace = buildDecisionTrace(skipped);
  assert.equal(trace.skip_code, "mobility_not_feasible");
  assert.equal(trace.skip_basis, "west_relocation_authorization_silent");
  assert.deepEqual(
    {
      contractorEligibility: trace.contractorEligibility,
      destination: trace.relocation_destination,
      engagement: trace.engagement_path,
      formats: trace.work_formats_observed,
      regions: trace.company_regions_observed,
      relocationSupport: trace.relocationSupport,
      residenceRestriction: trace.residenceRestriction,
      selectedFormat: trace.selected_work_format,
      selectedRegion: trace.selected_company_region,
      sponsorship: trace.sponsorship,
      workAuthorization: trace.workAuthorization,
    },
    {
      contractorEligibility: "ineligible",
      destination: "Germany",
      // An observed model survives every decision; only a default is withheld from a skip.
      engagement: "relocation_employment",
      formats: ["On-site"],
      regions: ["WEST"],
      relocationSupport: "unavailable",
      residenceRestriction: "unknown",
      selectedFormat: null,
      selectedRegion: null,
      sponsorship: "unknown",
      workAuthorization: "unknown",
    },
  );
});

test("title-only not-QA early skip does not require fabricated offered paths", () => {
  const input = baseInput();
  input.role.family = "other";
  input.offers = [];
  const trace = buildDecisionTrace(input);
  assert.equal(trace.decision, "SKIP");
  assert.equal(trace.skip_code, "not_qa_or_testing_role");
  assert.deepEqual(trace.work_formats_observed, []);
  assert.equal(trace.selected_work_format, null);
});

test("absent information takes a defined middle instead of a review state", () => {
  // Every branch the superseded record sent to manual review for want of data. The three review
  // reasons knowledge/job-match-rules.md#22-accepted-triage-decision-record keeps are all contradictions and are pinned by their own fixtures.
  const cases = [
    [
      "role family",
      (input) => {
        input.role.family = "unknown";
      },
      [],
    ],
    [
      "language",
      (input) => {
        input.role.language = "unknown";
      },
      [],
    ],
    [
      "automation",
      (input) => {
        input.role.automation = "unknown";
      },
      ["gap:automation_share_absent"],
    ],
    [
      "seniority",
      (input) => {
        input.role.seniority = "unknown";
      },
      ["gap:seniority_absent"],
    ],
    [
      "stack",
      (input) => {
        input.role.observedTools = [];
        input.role.observedLanguages = [];
      },
      ["gap:stack_absent"],
    ],
    [
      "domain",
      (input) => {
        input.role.domain = "unclear";
      },
      ["gap:domain_unclear"],
    ],
    [
      "engagement path",
      (input) => {
        input.offers[0].engagementPath = null;
      },
      [],
    ],
    [
      "timezone distance",
      (input) => {
        input.offers[0] = baseOffer({
          companyRegion: "OTHER",
          engagementPath: "outside_home_contractor",
          timezoneDistance: "unknown",
        });
        input.compensation = null;
      },
      ["gap:mobility_branch_unresolved", "gap:compensation_absent"],
    ],
    [
      "WEST onsite silence is the one exception",
      (input) => {
        input.offers[0] = baseOffer({
          companyRegion: "WEST",
          compensationMarket: "US",
          contractorEligibility: "ineligible",
          engagementPath: null,
          relocationSupport: "unknown",
          sponsorship: "unknown",
          westRegion: "US_CANADA",
          workAuthorization: "unknown",
          workFormat: "On-site",
        });
      },
      null,
    ],
    [
      "relocation country the tier table does not price",
      (input) => {
        input.offers[0] = baseOffer({
          companyRegion: "OTHER",
          engagementPath: null,
          relocationCountry: "Vietnam",
          relocationCountryCode: "VN",
          relocationSupport: "available",
          workAuthorization: "unknown",
          workFormat: "Hybrid",
        });
      },
      ["gap:relocation_country_unlisted"],
    ],
    [
      "relocation country nobody could identify",
      (input) => {
        input.offers[0] = baseOffer({
          companyRegion: "OTHER",
          engagementPath: null,
          relocationCountry: "Unknownland",
          relocationSupport: "available",
          workAuthorization: "unknown",
          workFormat: "Hybrid",
        });
      },
      ["gap:relocation_country_unresolved"],
    ],
  ];
  for (const [name, mutate, expectedGaps] of cases) {
    const input = baseInput();
    mutate(input);
    const trace = buildDecisionTrace(input);
    if (expectedGaps === null) {
      assert.equal(trace.decision, "SKIP", name);
      assert.equal(trace.skip_basis, "west_relocation_authorization_silent", name);
      continue;
    }
    assert.equal(trace.decision, "EVALUATED", name);
    assert.equal(typeof trace.match_percent, "number", name);
    for (const gap of expectedGaps) assert.ok(trace.data_gaps.includes(gap), `${name}: ${gap}`);
  }
});

test("the three surviving review reasons are the whole set", () => {
  const reasons = new Set(
    declaredDecisionCases
      .map(({ input }) => buildDecisionTrace(input))
      .filter((trace) => trace.decision === "MANUAL_REVIEW")
      .map((trace) => trace.review_reason),
  );
  assert.deepEqual([...reasons].sort(), [
    "compensation_override_undefined",
    "multiple_selected_format_paths",
    "offered_path_pairing_ambiguous",
  ]);
});

test("no trace repeats an annotation token", () => {
  for (const { id, input } of declaredDecisionCases) {
    const trace = buildDecisionTrace(input);
    assert.equal(new Set(trace.data_gaps).size, trace.data_gaps.length, id);
    assert.equal(new Set(trace.assumptions).size, trace.assumptions.length, id);
  }
});

test("taxonomy recognises frameworks and supporting names without a language binding or price", () => {
  assert.equal(TOOLMATCH_TAXONOMY_ID, "toolmatch-taxonomy-v6-2026-10-01");
  assert.equal(frameworkClassFor("TestNG"), "runner");
  assert.equal(frameworkClassFor("Appium"), "mobile");
  assert.equal(frameworkClassFor("Karate"), "api_test");
  assert.equal(resolveToolName("selenium webdriver"), "Selenium");
  assert.equal(resolveToolName("Playwrite"), null);
  for (const name of ["Docker", "CI", "SQL", "Postman", "Allure", "Stryker"])
    assert.equal(isSupportingName(name), true);
  assert.ok(LANGUAGE_NAMES.includes("JavaScript"));
});

test("automation, seniority, and domain tables use frozen literal anchors", () => {
  const automation = { primary: 12, major: 8, limited: 4, unknown: 4 };
  const seniority = { senior: 6, mid: 3, lower: 0, unknown: 3 };
  for (const [automationKey, automationScore] of Object.entries(automation)) {
    for (const [seniorityKey, seniorityScore] of Object.entries(seniority)) {
      const input = baseInput();
      input.role.automation = automationKey;
      input.role.seniority = seniorityKey;
      input.role.observedTools = [];
      input.role.observedLanguages = [];
      // No tool named at all is the ToolMatch middle of 4, not a zero sum.
      assert.equal(buildDecisionTrace(input).S_score, automationScore + 4 + seniorityScore);
    }
  }
  // A named domain scores where the input's scoring values place it - the fixture's fictional
  // placement, frozen here - and the two names the engine scores itself score the same for every
  // candidate: `irrelevant` 0, `unclear` the D middle.
  const domains = {
    agency_outsourcing_vendor: 4,
    complex_saas_b2b: 8,
    data_platforms: 6,
    developer_tools: 2,
    distributed_systems: 4,
    fintech_payments_trading: 0,
    healthcare_biotech: 10,
    infra_platforms: 6,
    marketplaces: 2,
    media_entertainment: 8,
    other_complex: 6,
    security_tooling: 4,
    telecom: 0,
    web3: 2,
    irrelevant: 0,
    unclear: 4,
  };
  assert.deepEqual(Object.keys(domains).slice(0, -2), [...DOMAIN_FIT_DOMAINS]);
  for (const [domain, expected] of Object.entries(domains)) {
    const input = baseInput();
    input.role.domain = domain;
    const trace = buildDecisionTrace(input);
    assert.equal(trace.D_score, expected, domain);
    // Moving the placement of a named domain moves D; the engine's two do not read it.
    input.candidateScoring.domain_fit = Object.fromEntries(
      DOMAIN_FIT_DOMAINS.map((name) => [name, 10]),
    );
    assert.equal(
      buildDecisionTrace(input).D_score,
      domain === "irrelevant" ? 0 : domain === "unclear" ? 4 : 10,
      domain,
    );
  }
});

test("mobility caps and bucket boundaries are exact", () => {
  const caps = [
    [0, 39],
    [4, 39],
    [5, 59],
    [11, 59],
    [12, 79],
    [19, 79],
    [20, 100],
    [25, 100],
  ];
  for (const [score, cap] of caps)
    assert.equal(mobilityCap(score, baseInput().candidateScoring.scoring.m), cap);
  const buckets = [
    [0, "pass"],
    [49, "pass"],
    [50, "consider"],
    [64, "consider"],
    [65, "apply"],
    [79, "apply"],
    [80, "priority"],
    [100, "priority"],
  ];
  for (const [score, bucket] of buckets) assert.equal(bucketFor(score), bucket);
});

test("uncertainty caps the bucket and a wholly uninformative vacancy lands in pass", () => {
  const input = baseInput();
  input.compensation = null;
  input.offers = [];
  input.role.automation = "unknown";
  input.role.domain = "unclear";
  input.role.observedTools = [];
  input.role.observedLanguages = [];
  input.role.seniority = "unknown";
  const trace = buildDecisionTrace(input);
  assert.equal(trace.M_score, 15);
  assert.equal(trace.C_score, 15);
  assert.equal(trace.S_score, 11);
  assert.equal(trace.D_score, 4);
  assert.equal(trace.match_raw, 45);
  assert.equal(trace.mobility_cap, 79);
  assert.equal(trace.match_percent, 45);
  assert.equal(trace.bucket, "pass");
  assert.deepEqual(trace.data_gaps, [
    "gap:work_format_absent",
    "gap:company_region_absent",
    "gap:compensation_absent",
    "gap:automation_share_absent",
    "gap:stack_absent",
    "gap:seniority_absent",
    "gap:domain_unclear",
  ]);
  assert.deepEqual(trace.assumptions, ["assumption:engagement_path.outside_home_contractor"]);
});

test("the mobility cap binds the total, not only the trace field", () => {
  // knowledge/job-match-rules.md#4-cap-rule-prevents-inflated-scores-when-mobility-is-blocked caps a vacancy whose mobility could not be established at 79, so it cannot reach `priority`
  // however good C, S and D are. Without a case whose raw total exceeds its cap, the cap is a
  // number in the trace and nothing else.
  const input = baseInput();
  input.offers = [];
  input.role.domain = "healthcare_biotech";
  input.role.observedTools = [
    baseObservedTool({
      language: "typescript_javascript",
      name: "Playwright",
      requirement: "required",
    }),
    baseObservedTool({ name: "Jenkins", requirement: "required" }),
    baseObservedTool({
      name: "Stryker",
      requirement: "optional",
      requirementPhrase: "nice to have",
    }),
  ];
  input.compensation = {
    basis: "gross",
    currency: "USD",
    evidenceQuote: "USD 5,200 per month",
    kind: "value",
    maximum: 5200,
    minimum: 5200,
    period: "monthly",
  };
  const trace = buildDecisionTrace(input);
  assert.equal(trace.M_score, 15);
  assert.equal(trace.C_score, 35);
  assert.equal(trace.S_score, 26);
  assert.equal(trace.D_score, 10);
  assert.equal(trace.match_raw, 86);
  assert.equal(trace.mobility_cap, 79);
  assert.equal(trace.match_percent, 79);
  assert.equal(trace.bucket, "apply");
});

test("compensation_floor records the applicable floor, its origin, and nothing when none applies", () => {
  const ordinary = buildDecisionTrace(baseInput());
  assert.deepEqual(ordinary.compensation_floor, {
    amount: 2000000,
    basis: "net",
    currency: "ARS",
    origin: "ordinary",
    period: "monthly",
  });

  const overridden = baseInput();
  overridden.explicitOverride = {
    amount: 1600000,
    basis: "net",
    currency: "ARS",
    period: "monthly",
    scope: "batch",
  };
  assert.deepEqual(buildDecisionTrace(overridden).compensation_floor, {
    amount: 1600000,
    basis: "net",
    currency: "ARS",
    origin: "override",
    period: "monthly",
    scope: "batch",
  });

  const international = baseInput();
  international.offers[0] = baseOffer({
    companyRegion: "OTHER",
    engagementPath: "outside_home_contractor",
    evidenceQuote: "Fully remote contractor engagement",
  });
  international.compensation = {
    basis: "gross",
    currency: "USD",
    evidenceQuote: "USD 4,200 per month",
    kind: "value",
    maximum: 4200,
    minimum: 4200,
    period: "monthly",
  };
  assert.deepEqual(buildDecisionTrace(international).compensation_floor, {
    amount: 3200,
    basis: "gross",
    currency: "USD",
    origin: "ordinary",
    period: "monthly",
  });

  const comparable = baseInput();
  comparable.offers[0].engagementPath = "comparable_cost_employment";
  comparable.compensation = {
    basis: "net",
    currency: "CHF",
    evidenceQuote: "CHF 3,400 net per month",
    kind: "value",
    maximum: 3400,
    minimum: 3400,
    period: "monthly",
  };
  assert.deepEqual(buildDecisionTrace(comparable).compensation_floor, {
    amount: 3200,
    basis: "net",
    currency: "CHF",
    origin: "ordinary",
    period: "monthly",
  });

  const annualOverride = baseInput();
  annualOverride.explicitOverride = {
    amount: 19200000,
    basis: "net",
    currency: "ARS",
    period: "annual",
    scope: "batch",
  };
  assert.equal(buildDecisionTrace(annualOverride).compensation_floor.amount, 1600000);

  // knowledge/job-match-rules.md#7-decision-trace-contract: `null` when salary is absent and no comparison was made, and also on a lane that has no
  // applicable floor at all - relocation employment without an override.
  const absent = baseInput();
  absent.compensation = null;
  assert.equal(buildDecisionTrace(absent).compensation_floor, null);

  const floorless = baseInput();
  floorless.offers[0] = baseOffer({
    companyRegion: "WEST",
    compensationMarket: "US",
    engagementPath: "relocation_employment",
    evidenceQuote: "On-site, relocation package provided",
    relocationCountry: "United States",
    relocationCountryCode: "US",
    relocationSupport: "available",
    sponsorship: "available",
    westRegion: "US_CANADA",
    workFormat: "On-site",
  });
  floorless.compensation = {
    basis: "gross",
    currency: "USD",
    evidenceQuote: "USD 120,000 per year",
    kind: "value",
    maximum: 120000,
    minimum: 120000,
    period: "annual",
  };
  const floorlessTrace = buildDecisionTrace(floorless);
  assert.equal(floorlessTrace.compensation_floor, null);
  assert.equal(floorlessTrace.C_score, 31);

  // A skipped or reviewed trace made no comparison either.
  const skipped = markUnread(baseInput(), "closed", "HTTP 404 after retry");
  assert.equal(buildDecisionTrace(skipped).compensation_floor, null);
});

test("base evaluated trace contains deterministic calculation fields and capped total", () => {
  const trace = buildDecisionTrace(baseInput());
  assert.deepEqual(
    {
      decision: trace.decision,
      M: trace.M_score,
      C: trace.C_score,
      S: trace.S_score,
      D: trace.D_score,
      raw: trace.match_raw,
      cap: trace.mobility_cap,
      percent: trace.match_percent,
      bucket: trace.bucket,
      selected: trace.selected_work_format,
      sponsorship: trace.sponsorship,
      authorization: trace.workAuthorization,
      policy: trace.policy_id,
      taxonomy: trace.toolmatch_taxonomy_id,
      destination: trace.relocation_destination,
      engagement: trace.engagement_path,
    },
    {
      decision: "EVALUATED",
      M: 25,
      C: 15,
      S: 26,
      D: 6,
      raw: 72,
      cap: 100,
      percent: 72,
      bucket: "apply",
      selected: "Remote",
      sponsorship: "unavailable",
      authorization: "eligible",
      policy: "triage-policy-v8-2026-10-01",
      taxonomy: "toolmatch-taxonomy-v6-2026-10-01",
      destination: null,
      engagement: "home_employment",
    },
  );
  assert.equal(trace.compensation_floor.amount, 2000000);
  assert.equal(trace.fx_provider, null);
  assert.deepEqual(trace.data_gaps, []);
  assert.deepEqual(trace.assumptions, []);
  assert.deepEqual(trace.tool_breakdown.unrecognised, []);
  assert.equal(Object.hasOwn(trace, "optional_modern_bonus"), false);
  assert.equal(
    trace.short_reason,
    "M 25 and C 15 gave 40; S 26 and D 6 gave 32. After the mobility cap 100 the total is 72, bucket apply.",
  );
});

test("official FX direction is recorded only when conversion executes", () => {
  const blocked = markUnread(baseInput(), "technical_unavailable", "timeout");
  blocked.fx = {
    provider: "ECB",
    rateDate: "2026-08-21",
    sourceCurrency: "EUR",
    targetCurrency: "USD",
    targetPerSource: 1.25,
  };
  assert.equal(buildDecisionTrace(blocked).fx_provider, null);

  const basisMismatch = baseInput();
  basisMismatch.compensation.basis = "gross";
  basisMismatch.compensation.currency = "EUR";
  basisMismatch.fx = {
    provider: "BCRA",
    rateDate: "2026-08-21",
    sourceCurrency: "EUR",
    targetCurrency: "ARS",
    targetPerSource: 780,
  };
  assert.equal(buildDecisionTrace(basisMismatch).fx_provider, null);

  const input = baseInput();
  input.offers[0].engagementPath = "outside_home_contractor";
  input.compensation = {
    basis: "gross",
    currency: "EUR",
    evidenceQuote: "EUR 3,360 gross monthly",
    kind: "value",
    maximum: 3360,
    minimum: 3360,
    period: "monthly",
  };
  input.fx = {
    provider: "ECB",
    rateDate: "2026-08-21",
    sourceCurrency: "EUR",
    targetCurrency: "USD",
    targetPerSource: 1.25,
  };
  const trace = buildDecisionTrace(input);
  assert.equal(trace.fx_provider, "ECB");
  assert.equal(trace.fx_rate_date, "2026-08-21");
  assert.equal(trace.fx_rate, 1.25);
  assert.equal(trace.C_score, 15);
});

test("a rate that was applied stays recorded even when a later conversion has none", () => {
  // knowledge/job-match-rules.md#7-decision-trace-contract asks for the exact normalization record. One `fx` record cannot serve two directions, so a
  // batch override in a third currency reaches the C middle - but the conversion that established
  // the floor comparison did happen, and the trace has to say so.
  const input = baseInput();
  input.offers[0] = baseOffer({
    companyRegion: "WEST",
    compensationMarket: "US",
    engagementPath: "relocation_employment",
    evidenceQuote: "On-site, relocation package provided",
    relocationCountry: "United States",
    relocationCountryCode: "US",
    relocationSupport: "available",
    sponsorship: "available",
    westRegion: "US_CANADA",
    workFormat: "On-site",
  });
  input.compensation = {
    basis: "gross",
    currency: "USD",
    evidenceQuote: "USD 3,000-9,000 per month",
    kind: "range",
    maximum: 9000,
    minimum: 3000,
    period: "monthly",
  };
  input.explicitOverride = {
    amount: 3200,
    basis: "gross",
    currency: "EUR",
    period: "monthly",
    scope: "batch",
  };
  input.fx = {
    provider: "ECB",
    rateDate: "2026-08-21",
    sourceCurrency: "USD",
    targetCurrency: "EUR",
    targetPerSource: 0.9,
  };
  const trace = buildDecisionTrace(input);
  assert.equal(trace.C_score, 15);
  assert.deepEqual(trace.data_gaps, ["gap:compensation_fx_unavailable"]);
  assert.deepEqual(trace.assumptions, ["assumption:compensation.range_crosses_floor"]);
  assert.equal(trace.fx_provider, "ECB");
  assert.equal(trace.fx_rate_date, "2026-08-21");
  assert.equal(trace.fx_rate, 0.9);
});

test("ranking uses bucket, percent, C/M/D/S, then stable input order", () => {
  const traces = [
    { decision: "SKIP", input_index: 3 },
    { decision: "BLOCKED", input_index: 4 },
    { decision: "MANUAL_REVIEW", input_index: 2 },
    {
      decision: "EVALUATED",
      input_index: 8,
      bucket: "apply",
      match_percent: 70,
      C_score: 20,
      M_score: 25,
      D_score: 9,
      S_score: 20,
    },
    {
      decision: "EVALUATED",
      input_index: 7,
      bucket: "priority",
      match_percent: 80,
      C_score: 15,
      M_score: 25,
      D_score: 10,
      S_score: 30,
    },
    {
      decision: "EVALUATED",
      input_index: 6,
      bucket: "apply",
      match_percent: 70,
      C_score: 20,
      M_score: 25,
      D_score: 9,
      S_score: 20,
    },
    { decision: "SKIP", input_index: 1 },
  ];
  const ranked = rankDecisionTraces(traces);
  assert.deepEqual(
    ranked.evaluated.map(({ input_index }) => input_index),
    [7, 6, 8],
  );
  assert.deepEqual(
    ranked.skipped.map(({ input_index }) => input_index),
    [1, 3],
  );
  assert.deepEqual(
    ranked.blocked.map(({ input_index }) => input_index),
    [4],
  );
  assert.deepEqual(
    ranked.manualReview.map(({ input_index }) => input_index),
    [2],
  );
});

test("every evaluated ranking tie-break has the approved descending direction", () => {
  const evaluated = [
    {
      input_index: 7,
      bucket: "apply",
      match_percent: 70,
      C_score: 20,
      M_score: 23,
      D_score: 9,
      S_score: 20,
    },
    {
      input_index: 6,
      bucket: "apply",
      match_percent: 70,
      C_score: 20,
      M_score: 23,
      D_score: 9,
      S_score: 20,
    },
    {
      input_index: 5,
      bucket: "apply",
      match_percent: 70,
      C_score: 20,
      M_score: 23,
      D_score: 9,
      S_score: 21,
    },
    {
      input_index: 4,
      bucket: "apply",
      match_percent: 70,
      C_score: 20,
      M_score: 23,
      D_score: 10,
      S_score: 20,
    },
    {
      input_index: 3,
      bucket: "apply",
      match_percent: 70,
      C_score: 20,
      M_score: 24,
      D_score: 9,
      S_score: 20,
    },
    {
      input_index: 2,
      bucket: "apply",
      match_percent: 70,
      C_score: 21,
      M_score: 23,
      D_score: 9,
      S_score: 20,
    },
    {
      input_index: 8,
      bucket: "apply",
      match_percent: 71,
      C_score: 5,
      M_score: 5,
      D_score: 0,
      S_score: 4,
    },
    {
      input_index: 1,
      bucket: "priority",
      match_percent: 80,
      C_score: 5,
      M_score: 20,
      D_score: 3,
      S_score: 10,
    },
  ].map((trace) => ({ decision: "EVALUATED", ...trace }));
  assert.deepEqual(
    rankDecisionTraces(evaluated).evaluated.map(({ input_index }) => input_index),
    [1, 8, 2, 3, 4, 5, 6, 7],
  );
});

test("decider remains pure and does not mutate normalized facts", () => {
  const input = baseInput();
  const before = structuredClone(input);
  const first = decideNormalizedJob(input);
  const second = decideNormalizedJob(input);
  assert.deepEqual(input, before);
  assert.deepEqual(first, second);
});

test("scoring a fixed batch twice is byte-identical", () => {
  // The session-level determinism check of the triage runbook, retired into CI: same inputs, same
  // traces, same order, byte for byte.
  const batch = declaredDecisionCases.map(({ input }, index) => {
    const copy = structuredClone(input);
    copy.inputIndex = index + 1;
    return copy;
  });
  const run = () => {
    const traces = batch.map((input) => buildDecisionTrace(input));
    const ranked = rankDecisionTraces(traces);
    return JSON.stringify({
      blocked: ranked.blocked,
      evaluated: ranked.evaluated,
      manualReview: ranked.manualReview,
      skipped: ranked.skipped,
      traces,
    });
  };
  const first = run();
  const second = run();
  assert.equal(first, second);
  assert.equal(first.length, second.length);
  // The batch is a real corpus, not an empty one, and the run is not trivially constant.
  assert.ok(first.length > 100000, `serialized batch is ${first.length} bytes`);
});

function statedAi(input) {
  input.role.ai = { product: "tested_by_role", work: "optional" };
  input.role.evidence.aiProduct = "Тестировать AI-функциональность";
  input.role.evidence.aiWork = "Использование AI-инструментов";
  return input;
}

test("every decision carries the AI observation, and an unread page says unknown", () => {
  const product = { value: "tested_by_role", evidence_quote: "Тестировать AI-функциональность" };
  const work = { value: "optional", evidence_quote: "Использование AI-инструментов" };
  const unknown = { value: "unknown", evidence_quote: null };

  const evaluated = buildDecisionTrace(statedAi(baseInput()));
  assert.equal(evaluated.decision, "EVALUATED");
  assert.deepEqual([evaluated.ai_in_product, evaluated.ai_in_work], [product, work]);

  // A skip and a review decided on a read description keep what it said: knowledge/job-match-rules.md#7-decision-trace-contract never discards an
  // observation.
  const junior = statedAi(baseInput());
  junior.role.seniority = "junior";
  const skipped = buildDecisionTrace(junior);
  assert.equal(skipped.skip_code, "junior_role");
  assert.deepEqual([skipped.ai_in_product, skipped.ai_in_work], [product, work]);
  const unclear = statedAi(baseInput());
  unclear.offerPairing = "unclear";
  const reviewed = buildDecisionTrace(unclear);
  assert.equal(reviewed.decision, "MANUAL_REVIEW");
  assert.deepEqual([reviewed.ai_in_product, reviewed.ai_in_work], [product, work]);

  for (const [outcome, reason, decision] of [
    ["technical_unavailable", "timeout", "BLOCKED"],
    ["closed", "HTTP 404 after retry", "SKIP"],
  ]) {
    const trace = buildDecisionTrace(markUnread(baseInput(), outcome, reason));
    assert.equal(trace.decision, decision);
    assert.deepEqual([trace.ai_in_product, trace.ai_in_work], [unknown, unknown], outcome);
  }

  // The observation enters no score: the same description with and without AI scores alike.
  const silent = buildDecisionTrace(baseInput());
  const scoreFields = [
    "M_score",
    "C_score",
    "S_score",
    "D_score",
    "match_percent",
    "bucket",
    "data_gaps",
  ];
  assert.deepEqual(
    Object.fromEntries(scoreFields.map((key) => [key, evaluated[key]])),
    Object.fromEntries(scoreFields.map((key) => [key, silent[key]])),
  );
});

function evaluatedSummaryTrace(overrides = {}) {
  return {
    decision: "EVALUATED",
    input_index: 3,
    job_title: "QA Automation Engineer",
    company: "Acme",
    bucket: "consider",
    match_percent: 58,
    source_ref: "https://example.test/jobs/3",
    ai_in_product: { value: "in_product", evidence_quote: "AI-powered search" },
    ai_in_work: { value: "required", evidence_quote: "Ability to use AI tools for testing" },
    tool_breakdown: {
      observations: [
        { name: "Playwright", scope: "main" },
        { name: "Docker", scope: "main" },
        { name: "Postman", scope: "optional" },
        { name: "Cypress", scope: "product" },
        { name: "Allure", scope: "product" },
        { name: "Kafka", scope: "ambiguous" },
        { name: "Wireshark", scope: "ambiguous" },
      ],
    },
    ...overrides,
  };
}

test("a summary row is built from its trace alone, and the short stack has a fixed order and bound", () => {
  // Required names first, then optional, then observed, each tier in trace order; unclassified
  // names after them; five at most, the rest counted.
  assert.deepEqual(summaryRow(evaluatedSummaryTrace()), {
    input_index: 3,
    job_title: "QA Automation Engineer",
    company: "Acme",
    decision: "consider 58%",
    stack: "Playwright, Docker, Postman, Cypress, Allure +2",
    ai: "in_product / required",
    link: "https://example.test/jobs/3",
  });
  assert.equal(Object.isFrozen(summaryRow(evaluatedSummaryTrace())), true);

  const five = evaluatedSummaryTrace({
    tool_breakdown: {
      observations: evaluatedSummaryTrace().tool_breakdown.observations.slice(0, 5),
    },
  });
  assert.equal(summaryRow(five).stack, "Playwright, Docker, Postman, Cypress, Allure");
  const repeated = evaluatedSummaryTrace({
    tool_breakdown: {
      observations: [
        { name: "Playwright", scope: "main" },
        { name: "Playwright", scope: "optional" },
        { name: "Kafka", scope: "ambiguous" },
      ],
    },
  });
  assert.equal(summaryRow(repeated).stack, "Playwright, Kafka");
  assert.equal(
    summaryRow(evaluatedSummaryTrace({ tool_breakdown: { observations: [] } })).stack,
    "—",
  );

  // The other decisions carry their code and no stack: their trace has no breakdown to read.
  for (const [decision, field, code] of [
    ["BLOCKED", "blocker_code", "vacancy_unavailable"],
    ["SKIP", "skip_code", "junior_role"],
    ["MANUAL_REVIEW", "review_code", "policy_undefined"],
  ]) {
    const row = summaryRow({
      decision,
      [field]: code,
      input_index: 7,
      job_title: null,
      company: "Acme",
      source_ref: "https://example.test/jobs/7",
      ai_in_product: { value: "unknown", evidence_quote: null },
      ai_in_work: { value: "unknown", evidence_quote: null },
    });
    assert.deepEqual(row, {
      input_index: 7,
      job_title: null,
      company: "Acme",
      decision: `${decision}: ${code}`,
      stack: null,
      ai: "unknown / unknown",
      link: "https://example.test/jobs/7",
    });
  }
  assert.throws(() => summaryRow({ decision: "SCORED" }), TypeError);
  assert.throws(() => summaryRow(null), TypeError);

  // End to end over a real trace: the base input records Playwright as required.
  const row = summaryRow(buildDecisionTrace(baseInput()));
  assert.equal(row.link, "https://example.test/jobs/1");
  assert.equal(row.ai, "none / none");
  assert.match(row.stack, /^TypeScript, Playwright(, |$)/);
});

test("role.language names a language of the layer, and without the layer's names only the default one", () => {
  const input = (language) => {
    const value = baseInput();
    value.role.language = language;
    return value;
  };
  assert.equal(normalizeScorerInput(input("Greek")).role.language, "Greek");
  assert.equal(normalizeScorerInput(input("unsupported")).role.language, "unsupported");
  // A language the layer does not configure is not a verdict the model may write.
  assert.throws(
    () => normalizeScorerInput(input("German")),
    /role\.language: unsupported value German/u,
  );
  // Without the names only the default language is accepted: a caller that forgets them refuses
  // more, never less.
  assert.throws(
    () => normalizeScorerInputWith(input("Greek")),
    /role\.language: unsupported value Greek/u,
  );
  assert.equal(normalizeScorerInputWith(input("English")).role.language, "English");
  assert.equal(
    buildDecisionTraceWith(input("Greek"), { languages: ["English", "Greek"] }).decision,
    buildDecisionTrace(input("Greek")).decision,
  );
});

test("the candidate's scoring values, not constants of the scorer, decide the outcome", () => {
  // Every pair below scores one listing twice, once on the base values and once with the one value
  // the case is about moved; the listing is the same object both times.
  const pair = (input, move) => {
    const moved = structuredClone(input);
    move(moved.candidateScoring);
    return [buildDecisionTrace(input), buildDecisionTrace(moved)];
  };
  const onsite = (overrides) =>
    baseInput({
      offers: [
        baseOffer({
          companyRegion: "OTHER",
          engagementPath: null,
          timezoneDistance: "unknown",
          workFormat: "On-site",
          ...overrides,
        }),
      ],
    });
  const named = (name, code) => ({ relocationCountry: name, relocationCountryCode: code });

  // The feasible-residence set answers closing sign 1.
  const [inSet, outOfSet] = pair(
    onsite({ ...named("Chile", "CL"), workAuthorization: "required_existing" }),
    (scoring) => {
      scoring.mobility.feasible_residences = scoring.mobility.feasible_residences.filter(
        (code) => code !== "CL",
      );
    },
  );
  assert.equal(inSet.decision, "EVALUATED");
  assert.deepEqual(
    [outOfSet.decision, outOfSet.skip_code, outOfSet.skip_basis],
    ["SKIP", "mobility_not_feasible", "authorization_required_existing"],
  );

  // The excluded destinations answer rule 4.
  const [notExcluded, excluded] = pair(
    onsite({ ...named("Dominican Republic", "DO"), sponsorship: "available" }),
    (scoring) => {
      scoring.mobility.excluded_destinations.push("DO");
      scoring.mobility.relocation_tiers.middle = scoring.mobility.relocation_tiers.middle.filter(
        (code) => code !== "DO",
      );
    },
  );
  assert.equal(notExcluded.decision, "EVALUATED");
  assert.deepEqual([excluded.decision, excluded.skip_code], ["SKIP", "destination_excluded"]);

  // The tier lists price a named destination.
  const [middleTier, highTier] = pair(
    onsite({ ...named("Mexico", "MX"), sponsorship: "available" }),
    (scoring) => {
      scoring.mobility.relocation_tiers.middle = scoring.mobility.relocation_tiers.middle.filter(
        (code) => code !== "MX",
      );
      scoring.mobility.relocation_tiers.high.push("MX");
    },
  );
  assert.deepEqual([middleTier.M_score, highTier.M_score], [15, 25]);

  // `west_tier` prices a WEST path that names no country.
  const [westHigh, westLow] = pair(
    onsite({
      companyRegion: "WEST",
      relocationSupport: "available",
      sponsorship: "unknown",
      westRegion: "EU_UK",
      workAuthorization: "unknown",
    }),
    (scoring) => {
      scoring.mobility.west_tier = "low";
    },
  );
  assert.deepEqual([westHigh.M_score, westLow.M_score], [25, 5]);

  // `west_near_subregion` decides which WEST sub-region branch B prices as the near one.
  const [far, near] = pair(
    baseInput({
      offers: [
        baseOffer({
          companyRegion: "WEST",
          timezone: "tz_unknown",
          timezoneDistance: "far",
          westRegion: "US_CANADA",
        }),
      ],
    }),
    (scoring) => {
      scoring.mobility.west_near_subregion = "US_CANADA";
    },
  );
  assert.deepEqual([far.M_score, near.M_score], [20, 25]);

  // The home region stands in for its countries' tier only while they share one.
  const [homeShared, homeSplit] = pair(onsite({ companyRegion: "HOME" }), (scoring) => {
    scoring.mobility.relocation_tiers.low = scoring.mobility.relocation_tiers.low.filter(
      (code) => code !== "UY",
    );
    scoring.mobility.relocation_tiers.middle.push("UY");
  });
  assert.deepEqual([homeShared.M_score, homeSplit.M_score], [0, 10]);
  assert.deepEqual(homeSplit.data_gaps, homeShared.data_gaps);

  // The floor and the target draw the outside-home contractor curve.
  const contractor = baseInput({
    compensation: {
      basis: "gross",
      currency: "USD",
      evidenceQuote: "$3,700 per month",
      kind: "value",
      maximum: 3700,
      minimum: 3700,
      period: "monthly",
    },
    offers: [
      baseOffer({
        companyRegion: "OTHER",
        engagementPath: "outside_home_contractor",
        timezoneDistance: "unknown",
      }),
    ],
  });
  const [narrowBand, wideBand] = pair(contractor, (scoring) => {
    scoring.compensation.target = 5200;
  });
  assert.deepEqual([narrowBand.C_score, wideBand.C_score], [10, 7]);
  const [aboveFloor, belowFloor] = pair(contractor, (scoring) => {
    scoring.compensation.floors.outside_home_contractor.amount = 4100;
    scoring.compensation.target = 5100;
  });
  assert.deepEqual([aboveFloor.C_score, belowFloor.C_score], [10, 4]);
  // The curve starts at the configured floor, not at a batch override that lowers the floor: a
  // salary between the two is below the curve and scores on the below-floor curve.
  const overridden = structuredClone(contractor);
  overridden.explicitOverride = {
    amount: 2400,
    basis: "gross",
    currency: "USD",
    period: "monthly",
    scope: "batch",
  };
  const [curveFromFloor, curveFromRaisedFloor] = pair(overridden, (scoring) => {
    scoring.compensation.floors.outside_home_contractor.amount = 4100;
    scoring.compensation.target = 5100;
  });
  assert.deepEqual([curveFromFloor.C_score, curveFromRaisedFloor.C_score], [10, 4]);

  // A salary stated in none of a floor's currencies falls back to the first one - and is recorded as
  // a default only where the floor offered a choice.
  const comparable = baseInput({
    compensation: {
      basis: "net",
      currency: "GBP",
      evidenceQuote: "£2,800 net per month",
      kind: "value",
      maximum: 2800,
      minimum: 2800,
      period: "monthly",
    },
    fx: {
      provider: "ECB",
      rateDate: "2026-08-21",
      sourceCurrency: "GBP",
      targetCurrency: "USD",
      targetPerSource: 1.3,
    },
    offers: [
      baseOffer({
        companyRegion: "OTHER",
        engagementPath: "comparable_cost_employment",
        timezoneDistance: "unknown",
      }),
    ],
  });
  const [dual, single] = pair(comparable, (scoring) => {
    scoring.compensation.floors.comparable_cost_employment.currencies = ["USD"];
  });
  assert.deepEqual(dual.assumptions, ["assumption:compensation.floor_currency_fallback"]);
  assert.deepEqual(single.assumptions, []);
  assert.deepEqual([dual.C_score, single.C_score], [15, 15]);

  // A conversion that involves the home currency needs the provider the candidate names.
  const homeRate = baseInput({
    compensation: {
      basis: "gross",
      currency: "ARS",
      evidenceQuote: "ARS 2,625,000 gross per month",
      kind: "value",
      maximum: 2625000,
      minimum: 2625000,
      period: "monthly",
    },
    fx: {
      provider: "BCRA",
      rateDate: "2026-08-21",
      sourceCurrency: "ARS",
      targetCurrency: "USD",
      targetPerSource: 0.0016,
    },
    offers: [
      baseOffer({
        companyRegion: "OTHER",
        engagementPath: "outside_home_contractor",
        timezoneDistance: "unknown",
      }),
    ],
  });
  const [ownProvider, otherProvider] = pair(homeRate, (scoring) => {
    scoring.compensation.home_currency = "CLP";
  });
  assert.equal(ownProvider.fx_provider, "BCRA");
  assert.deepEqual(
    ownProvider.data_gaps.filter((token) => token.startsWith("gap:compensation")),
    [],
  );
  assert.deepEqual(
    otherProvider.data_gaps.filter((token) => token.startsWith("gap:compensation")),
    ["gap:compensation_fx_unavailable"],
  );

  const stack = baseInput();
  stack.role.observedTools = [baseObservedTool({ name: "Selenide", requirement: "required" })];
  const [unpriced, priced] = pair(stack, (scoring) => {
    scoring.tool_match.frameworks.push({ name: "Selenide", points: 3, experience: "transferable" });
  });
  assert.deepEqual(
    [unpriced.tool_breakdown.framework.score, priced.tool_breakdown.framework.score],
    [0, 3],
  );
  assert.equal(priced.S_score - unpriced.S_score, 3);

  // Where the candidate places a domain is what the domain scores: the same listing, one placement
  // moved.
  const [placedAtSix, placedAtTen] = pair(baseInput(), (scoring) => {
    scoring.domain_fit.data_platforms = 10;
  });
  assert.deepEqual([placedAtSix.D_score, placedAtTen.D_score], [6, 10]);
  assert.equal(placedAtTen.match_raw - placedAtSix.match_raw, 4);
});

function zeroPointTree(value) {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      Array.isArray(entry)
        ? entry.map(() => 0)
        : typeof entry === "object"
          ? zeroPointTree(entry)
          : 0,
    ]),
  );
}

function singleComponentInput(component) {
  const input = baseInput();
  const values = input.candidateScoring;
  values.scoring = zeroPointTree(values.scoring);
  values.scoring.m.cap_scores = [0];
  values.scoring.m.cap_limits = [100];
  values.scoring.d.steps = [0];
  values.domain_fit = Object.fromEntries(Object.keys(values.domain_fit).map((key) => [key, 0]));
  values.tool_match = { languages: [], frameworks: [] };
  values.scoring.s.tools.max = 10;
  values.scoring.s.max = 10;
  input.role.observedLanguages = [baseObservedLanguage({ name: "C#" })];
  input.role.observedTools = [baseObservedTool({ name: "Karate" })];
  const points = values.scoring[component];
  points.max = component === "s" ? 100 : 90;
  if (component === "m") {
    points.remote.other_near = 90;
    points.cap_scores = [90];
  }
  if (component === "c") points.local = 90;
  if (component === "s") {
    points.automation.max = 90;
    points.automation.primary = 90;
  }
  if (component === "d") {
    points.steps = [0, 90];
    values.domain_fit.data_platforms = 90;
  }
  return input;
}

for (const component of ["m", "c", "s", "d"]) {
  test(`private points: ${component} can carry the budget outside the fixed ToolMatch reserve`, () => {
    const trace = buildDecisionTrace(singleComponentInput(component));
    assert.deepEqual(
      [trace.M_score, trace.C_score, trace.S_score, trace.D_score],
      ["m", "c", "s", "d"].map((key) => (key === component ? 90 : 0)),
    );
    assert.equal(trace.match_raw, 90);
    assert.equal(trace.match_percent, 90);
    assert.equal(trace.bucket, "priority");
  });
}

test("zero mobility uses its explicit cap and still applies terminal rules and gaps", () => {
  const input = singleComponentInput("c");
  input.candidateScoring.scoring.m.cap_limits = [43];
  assert.equal(buildDecisionTrace(input).match_percent, 43);
  input.offers = [];
  assert.ok(buildDecisionTrace(input).data_gaps.includes("gap:work_format_absent"));
  input.role.automation = "manual_only";
  const trace = buildDecisionTrace(input);
  assert.equal(trace.skip_code, "manual_role");
  assert.equal(Object.hasOwn(trace, "M_score"), false);
});

test("private integer points are summed directly and reconstructed from the trace", () => {
  const input = baseInput();
  input.candidateScoring.scoring.c.local = 13;
  input.candidateScoring.scoring.s.automation.primary = 11;
  input.candidateScoring.tool_match.frameworks[0].points = 3;
  const trace = buildDecisionTrace(input);
  assert.deepEqual([trace.M_score, trace.C_score, trace.S_score, trace.D_score], [25, 13, 24, 6]);
  assert.equal(trace.match_raw, 68);
  assert.equal(trace.match_raw, trace.M_score + trace.C_score + trace.S_score + trace.D_score);
  assert.equal(trace.match_percent, 68);
  assert.equal(trace.tool_breakdown.framework.score, 3);
  const altered = structuredClone(input.candidateScoring);
  altered.scoring.c.local = 14;
  assert.throws(
    () => buildDecisionTrace(input, { scoring: altered }),
    /must equal the scoring values/,
  );
});

test("invalid private point settings fail both at config and at scorer input", () => {
  const mutations = [
    (v) => {
      delete v.scoring;
    },
    (v) => {
      v.scoring.m.max = 24;
    },
    (v) => {
      v.scoring.c.max = 36;
    },
    (v) => {
      v.scoring.c.max = 35.5;
    },
    (v) => {
      v.scoring.c.local = -1;
    },
    (v) => {
      v.scoring.c.local = 36;
    },
    (v) => {
      v.scoring.m.sponsored = 26;
    },
    (v) => {
      v.scoring.m.extra = 1;
    },
    (v) => {
      v.scoring.s.automation.max = 13;
    },
    (v) => {
      v.scoring.s.tools.bonus = 13;
    },
    (v) => {
      v.scoring.s.tools.unknown = 13;
    },
    (v) => {
      v.tool_match.frameworks[0].points = 6;
    },
    (v) => {
      v.scoring.c.start = 16;
    },
    (v) => {
      v.scoring.c.below_floor = [6, 3, 2, 1, 0];
    },
    (v) => {
      v.scoring.c.reference = [35, 17, 24, 31, 10];
    },
    (v) => {
      v.scoring.c.reference.pop();
    },
    (v) => {
      v.scoring.m.cap_scores = [4, 4, 19, 25];
    },
    (v) => {
      v.scoring.m.cap_scores = [4, 11, 19, 24];
    },
    (v) => {
      v.scoring.m.cap_limits = [39, 35, 79, 100];
    },
    (v) => {
      v.scoring.m.cap_limits.pop();
    },
    (v) => {
      v.scoring.m.cap_limits[0] = 101;
    },
    (v) => {
      v.scoring.m.cap_scores[0] = 0.5;
    },
    (v) => {
      v.scoring.d.steps = [0, 2, 2, 10];
    },
    (v) => {
      v.scoring.d.unknown = 3;
    },
    (v) => {
      v.scoring.d.steps = [];
    },
  ];
  for (const mutate of mutations) {
    const input = baseInput();
    mutate(input.candidateScoring);
    assert.throws(() => buildDecisionTrace(input), ScorerInputError);
    const config = JSON.parse(
      readFileSync(resolve(repoRoot, "candidate.example/config.json"), "utf8"),
    );
    mutate(config);
    assert.throws(() => validateCandidateConfig(config), CandidateError);
  }
});

test("private C anchors retain floor rounding at salary steps", () => {
  const input = baseInput();
  input.offers = [
    baseOffer({
      companyRegion: "WEST",
      westRegion: "EU_UK",
      engagementPath: "outside_home_contractor",
      timezone: "tz_any",
    }),
  ];
  Object.assign(input.candidateScoring.scoring.c, { start: 7, target: 17 });
  Object.assign(input.compensation, { currency: "USD", basis: "gross" });
  for (const [salary, expected] of [
    [3200, 7],
    [3299.999, 7],
    [3300, 8],
    [3300.001, 8],
    [4199.999, 16],
    [4200, 17],
    [4200.001, 17],
    [4700, 26],
    [5199.999, 34],
    [5200, 35],
  ]) {
    Object.assign(input.compensation, { minimum: salary, maximum: salary });
    const trace = buildDecisionTrace(input);
    assert.equal(trace.C_score, expected, `salary ${salary}`);
    assert.ok(Number.isInteger(trace.match_raw));
  }
});

test("private mobility cap boundaries cover every score including zero maximum", () => {
  const points = { max: 7, cap_scores: [0, 3, 7], cap_limits: [17, 54, 92] };
  for (let score = 0; score <= 7; score += 1) {
    assert.equal(mobilityCap(score, points), score === 0 ? 17 : score <= 3 ? 54 : 92);
  }
  for (const cap of [0, 43, 100]) {
    const input = singleComponentInput("c");
    input.candidateScoring.scoring.m.cap_limits = [cap];
    assert.equal(buildDecisionTrace(input).match_percent, Math.min(cap, 90));
  }
});

test("historical category traces remain readable without recomputation or mutation", () => {
  const trace = structuredClone(buildDecisionTrace(baseInput()));
  trace.policy_id = "triage-policy-v7-2026-10-01";
  trace.toolmatch_taxonomy_id = "toolmatch-taxonomy-v5-2026-10-01";
  delete trace.tool_match_score;
  trace.tool_breakdown = [
    {
      category: "ui_web_ts_js",
      binding: "typescript_javascript",
      contribution: 6,
      observed_tools: [
        { name: "Playwright", requirement: "required" },
        { name: "Cypress", requirement: "optional" },
      ],
    },
  ];
  trace.unclassified_tools = ["InternalQA"];
  trace.optional_modern_bonus = null;
  const saved = JSON.stringify(trace);
  const historical = JSON.parse(saved);
  assert.equal(rankDecisionTraces([historical]).evaluated[0].policy_id, trace.policy_id);
  assert.equal(summaryRow(historical).stack, "Playwright, Cypress, InternalQA");
  assert.equal(JSON.stringify(historical), saved);
});

// Independent half selection and extraction boundary introduced by task 237.
for (const scope of ["main", "optional", "product", "ambiguous"]) {
  for (const language of [true, false]) {
    for (const field of ["evidenceQuote", "scopeReason"]) {
      test(`every ${scope} ${language ? "language" : "framework"} needs nonempty ${field}`, () => {
        for (const invalid of [null, "", " "]) {
          const input = baseInput();
          const item = (language ? baseObservedLanguage : baseObservedTool)({
            scope,
            requirement: scope === "optional" ? "optional" : "required",
            [field]: invalid,
          });
          input.role[language ? "observedLanguages" : "observedTools"] = [item];
          assert.throws(
            () => normalizeScorerInput(input),
            (error) => error instanceof ScorerInputError && error.message.includes(field),
          );
        }
      });
    }
  }
}

test("independent prices select separate maxima with stable ties under all permutations", () => {
  const input = baseInput();
  input.role.observedLanguages = [
    baseObservedLanguage({ name: "Java" }),
    baseObservedLanguage({ name: "Python" }),
    baseObservedLanguage({ name: "TypeScript" }),
  ];
  input.role.observedTools = [
    baseObservedTool({ name: "Playwright" }),
    baseObservedTool({ name: "PyTest" }),
    baseObservedTool({ name: "REST Assured" }),
    baseObservedTool({ name: "Playwright", scopeReason: "Another explicit QA requirement." }),
  ];
  const expected = buildDecisionTrace(input);
  assert.equal(expected.tool_match_score, 10);
  assert.equal(expected.tool_breakdown.language.selected.name, "Python");
  assert.equal(expected.tool_breakdown.framework.selected.name, "PyTest");
  const permutations = (items) =>
    items.length === 0
      ? [[]]
      : items.flatMap((item, index) =>
          permutations(items.filter((_, i) => i !== index)).map((tail) => [item, ...tail]),
        );
  for (const languages of permutations(input.role.observedLanguages))
    for (const tools of permutations(input.role.observedTools)) {
      const shuffled = structuredClone(input);
      shuffled.role.observedLanguages = languages;
      shuffled.role.observedTools = tools;
      assert.deepEqual(buildDecisionTrace(shuffled), expected);
    }
  // Force equal prices and observation ties; every source field participates in ordering.
  input.candidateScoring.tool_match.frameworks.find((item) => item.name === "PyTest").points = 4;
  const tied = buildDecisionTrace(input);
  input.role.observedTools.reverse();
  assert.deepEqual(buildDecisionTrace(input), tied);
});

test("optional, product and supporting additions never change the selected scores or bucket", () => {
  const input = baseInput();
  const before = buildDecisionTrace(input);
  for (const scope of ["optional", "product", "ambiguous"]) {
    input.role.observedLanguages.push(
      baseObservedLanguage({
        name: "Python",
        scope,
        requirement: scope === "optional" ? "optional" : "observed",
      }),
    );
    input.role.observedTools.push(
      baseObservedTool({
        name: "PyTest",
        scope,
        requirement: scope === "optional" ? "optional" : "observed",
      }),
    );
  }
  for (const name of ["Docker", "CI", "SQL", "Postman", "Allure", "Prometheus"])
    input.role.observedTools.push(baseObservedTool({ name, kind: "supporting" }));
  const after = buildDecisionTrace(input);
  for (const key of ["tool_match_score", "S_score", "match_raw", "match_percent", "bucket"])
    assert.equal(after[key], before[key], key);
  assert.deepEqual(after.tool_breakdown.language, before.tool_breakdown.language);
  assert.deepEqual(after.tool_breakdown.framework, before.tool_breakdown.framework);
  assert.equal(after.tool_breakdown.optional.length, 2);
  assert.equal(after.tool_breakdown.supporting.length, 6);
});

test("framework names are independently priced across languages and do not require a UI framework", () => {
  const input = baseInput();
  input.role.observedTools = [
    baseObservedTool({ name: "TestNG" }),
    baseObservedTool({ name: "Appium", requirement: "required" }),
  ];
  for (const [name, points] of [
    ["TypeScript", 4],
    ["Java", 1],
    ["Python", 5],
    ["C#", 0],
  ]) {
    input.role.observedLanguages = [baseObservedLanguage({ name })];
    const trace = buildDecisionTrace(input);
    assert.equal(trace.tool_breakdown.framework.score, 1);
    assert.equal(trace.tool_match_score, points + 1);
    assert.equal(trace.tool_breakdown.framework.selected.name, "TestNG");
    assert.ok(
      trace.tool_breakdown.required_without_direct_experience.some(
        (item) => item.name === "Appium",
      ),
    );
    assert.equal(trace.decision, "EVALUATED");
  }
});

test("a different candidate snapshot changes only independent prices and validates both boundaries", () => {
  const input = baseInput();
  const prior = buildDecisionTrace(input);
  input.candidateScoring.tool_match.languages = [
    { name: "TypeScript", points: 0, experience: "none" },
  ];
  input.candidateScoring.tool_match.frameworks = [
    { name: "Playwright", points: 5, experience: "transferable" },
  ];
  const trace = buildDecisionTrace(input);
  assert.equal(prior.tool_match_score, 8);
  assert.equal(trace.tool_match_score, 5);
  assert.equal(trace.tool_breakdown.language.state, "mismatch");
  assert.equal(trace.tool_breakdown.framework.selected.experience, "transferable");
  assert.equal(trace.M_score, prior.M_score);
  assert.equal(trace.C_score, prior.C_score);
  assert.equal(trace.D_score, prior.D_score);
  assert.equal(trace.S_score, prior.S_score - 3);
  assert.ok(trace.match_raw <= 100);
});

test("the extractor cannot relabel recognised helpers or frameworks as languages", () => {
  for (const name of ["SQL", "Docker", "Postman", "Allure", "Playwright"]) {
    const input = baseInput();
    input.role.observedLanguages = [baseObservedLanguage({ name })];
    assert.throws(() => normalizeScorerInput(input), ScorerInputError);
  }
  for (const [name, kind] of [
    ["Docker", "framework"],
    ["Playwright", "supporting"],
  ]) {
    const input = baseInput();
    input.role.observedTools = [baseObservedTool({ name, kind })];
    assert.throws(() => normalizeScorerInput(input), ScorerInputError);
  }
  for (const change of [
    (item) => (item.scope = "main"),
    (item) => (item.requirement = "required"),
  ]) {
    const input = baseInput();
    input.role.observedTools = [baseObservedTool({ scope: "optional", requirement: "optional" })];
    change(input.role.observedTools[0]);
    assert.throws(() => normalizeScorerInput(input), ScorerInputError);
  }
});

test("unread inputs cannot carry concrete stack observations", () => {
  for (const key of ["observedLanguages", "observedTools"]) {
    const input = baseInput();
    markUnread(input, "technical_unavailable", "timeout");
    input.role[key] = [(key === "observedLanguages" ? baseObservedLanguage : baseObservedTool)()];
    assert.throws(
      () => normalizeScorerInput(input),
      (error) => error.message.includes("unread descriptions"),
    );
  }
});
