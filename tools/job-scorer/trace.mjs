/**
 * The Decision Trace of knowledge/job-match-rules.md#7-decision-trace-contract and the approved evaluated ranking.
 *
 * The trace is versioned by what produced it, not by a version counter of its own: `policy_id`
 * names the decision record and `toolmatch_taxonomy_id` names the ToolMatch table, which is what
 * keeps a v1 and a v2 ToolMatch figure from being compared silently. Epic 007's `R2-05A` owns any
 * further trace-schema versioning; this module deliberately does not fork a second scheme.
 */
import { decideNormalizedJob } from "./decide.mjs";

const BUCKET_ORDER = Object.freeze({ priority: 0, apply: 1, consider: 2, pass: 3 });

function selectedOrUnanimous(outcome, key, fallback = "unknown") {
  if (outcome.selection?.selectedOffer) return outcome.selection.selectedOffer[key];
  const values = [...new Set(outcome.input.offers.map((offer) => offer[key]))];
  return values.length === 1 ? values[0] : fallback;
}

function usedFx(outcome) {
  return outcome.compensation?.fxUsed ?? null;
}

function commonFields(outcome) {
  const { input } = outcome;
  const selected = outcome.selection?.selectedOffer ?? null;
  const fx = usedFx(outcome);
  return {
    input_index: input.inputIndex,
    source_ref: input.source.sourceRef,
    final_url: input.source.finalUrl,
    job_title: input.source.jobTitle,
    company: input.source.company,
    location_raw: input.source.locationRaw,
    work_format_raw: input.source.workFormatRaw,
    salary_raw: input.source.salaryRaw,
    work_formats_observed: outcome.selection?.observedFormats ?? [
      ...new Set(input.offers.map((offer) => offer.workFormat)),
    ],
    selected_work_format: selected?.workFormat ?? null,
    company_regions_observed: outcome.selection?.observedRegions ?? [
      ...new Set(input.offers.map((offer) => offer.companyRegion)),
    ],
    selected_company_region: selected?.companyRegion ?? null,
    sponsorship: selectedOrUnanimous(outcome, "sponsorship"),
    workAuthorization: selectedOrUnanimous(outcome, "workAuthorization"),
    residenceRestriction: selectedOrUnanimous(outcome, "residenceRestriction"),
    contractorEligibility: selectedOrUnanimous(outcome, "contractorEligibility"),
    relocationSupport: selectedOrUnanimous(outcome, "relocationSupport"),
    relocation_destination: selectedOrUnanimous(outcome, "relocationCountry", null),
    // An applied default reaches the trace only where a decision consumed one; a stated model is an
    // observation and survives every decision (knowledge/job-match-rules.md#22-accepted-triage-decision-record, knowledge/job-match-rules.md#7-decision-trace-contract).
    engagement_path: outcome.engagementPath ?? selectedOrUnanimous(outcome, "engagementPath", null),
    compensation_floor: outcome.compensation?.floor ?? null,
    fx_provider: fx?.provider ?? null,
    fx_rate_date: fx?.rateDate ?? null,
    fx_rate: fx?.targetPerSource ?? null,
    // knowledge/job-match-rules.md#7-decision-trace-contract: an observation of the description, carried by every decision and read by no score.
    ai_in_product: { value: input.role.ai.product, evidence_quote: input.role.evidence.aiProduct },
    ai_in_work: { value: input.role.ai.work, evidence_quote: input.role.evidence.aiWork },
    decision: outcome.decision,
    data_gaps: outcome.dataGaps ?? [],
    assumptions: outcome.assumptions ?? [],
    policy_id: input.policyId,
    ...(input.schemaVersion === 10 && input.sourceContext !== null
      ? { source_context: input.sourceContext }
      : {}),
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function toolBreakdownFields(outcome) {
  return {
    toolmatch_taxonomy_id: outcome.toolmatchTaxonomyId,
    tool_match_score: outcome.skills.toolMatch,
    tool_breakdown: outcome.skills.toolBreakdown,
  };
}

export function buildDecisionTrace(rawInput, { languages, scoring } = {}) {
  const outcome = decideNormalizedJob(rawInput, { languages, scoring });
  const common = commonFields(outcome);
  if (outcome.decision === "BLOCKED") {
    return deepFreeze({
      ...common,
      blocker_code: outcome.blockerCode,
      blocker_reason: outcome.blockerReason,
      symptom: outcome.symptom,
      evidence_quote: outcome.evidenceQuote,
    });
  }
  if (outcome.decision === "SKIP") {
    return deepFreeze({
      ...common,
      skip_code: outcome.skipCode,
      skip_reason: outcome.skipReason,
      evidence_quote: outcome.evidenceQuote,
      skip_basis: outcome.skipBasis,
      ...(outcome.skipCode === "vacancy_unavailable" ? { symptom: outcome.symptom } : {}),
    });
  }
  if (outcome.decision === "MANUAL_REVIEW") {
    return deepFreeze({
      ...common,
      review_code: outcome.reviewCode,
      review_reason: outcome.reviewReason,
      evidence_quote: outcome.evidenceQuote,
    });
  }
  return deepFreeze({
    ...common,
    M_score: outcome.mobility.score,
    M_reason: outcome.mobility.reason,
    M_evidence_quote: outcome.selection.selectedOffer?.evidenceQuote ?? null,
    C_score: outcome.compensation.score,
    C_reason: outcome.compensation.reason,
    C_evidence_quote: outcome.input.compensation?.evidenceQuote ?? null,
    S_score: outcome.skills.score,
    S_reason: outcome.skills.reason,
    S_evidence_quote: outcome.input.role.evidence.automation ?? outcome.input.role.evidence.tools,
    D_score: outcome.domain.score,
    D_reason: outcome.domain.reason,
    D_evidence_quote: outcome.input.role.evidence.domain,
    match_raw: outcome.matchRaw,
    mobility_cap: outcome.mobilityCap,
    match_percent: outcome.matchPercent,
    bucket: outcome.bucket,
    short_reason: `M ${outcome.mobility.score} and C ${outcome.compensation.score} gave ${outcome.mobility.score + outcome.compensation.score}; S ${outcome.skills.score} and D ${outcome.domain.score} gave ${outcome.skills.score + outcome.domain.score}. After the mobility cap ${outcome.mobilityCap} the total is ${outcome.matchPercent}, bucket ${outcome.bucket}.`,
    ...toolBreakdownFields(outcome),
  });
}

export function rankDecisionTraces(traces) {
  if (!Array.isArray(traces)) throw new TypeError("traces must be an array");
  const evaluated = traces
    .filter((trace) => trace.decision === "EVALUATED")
    .sort(
      (left, right) =>
        BUCKET_ORDER[left.bucket] - BUCKET_ORDER[right.bucket] ||
        right.match_percent - left.match_percent ||
        right.C_score - left.C_score ||
        right.M_score - left.M_score ||
        right.D_score - left.D_score ||
        right.S_score - left.S_score ||
        left.input_index - right.input_index,
    );
  const byInput = (decision) =>
    traces
      .filter((trace) => trace.decision === decision)
      .sort((left, right) => left.input_index - right.input_index);
  return Object.freeze({
    evaluated: Object.freeze(evaluated),
    blocked: Object.freeze(byInput("BLOCKED")),
    skipped: Object.freeze(byInput("SKIP")),
    manualReview: Object.freeze(byInput("MANUAL_REVIEW")),
  });
}

const SUMMARY_STACK_LIMIT = 5;
const SUMMARY_STACK_TIERS = Object.freeze(["main", "optional", "product", "ambiguous"]);
const DECISION_CODE_FIELDS = Object.freeze({
  BLOCKED: "blocker_code",
  SKIP: "skip_code",
  MANUAL_REVIEW: "review_code",
});

/**
 * The short stack of an evaluated trace: the names its ToolMatch breakdown records, main ones
 * first, then optional, product and ambiguous observations; each
 * name once and verbatim, at most five, and `+N` for the ones left out. `—` when the description
 * named no tool. `null` for the other decisions, whose trace carries no breakdown.
 */
function shortStack(trace) {
  if (trace.decision !== "EVALUATED") return null;
  const names = [];
  const add = (name) => {
    if (!names.includes(name)) names.push(name);
  };
  if (Array.isArray(trace.tool_breakdown)) {
    // Read saved category-era traces without recomputing or altering them.
    for (const requirement of ["required", "optional", "observed"]) {
      for (const row of trace.tool_breakdown)
        for (const item of row.observed_tools) {
          if (item.requirement === requirement) add(item.name);
        }
    }
    for (const name of trace.unclassified_tools ?? []) add(name);
  } else {
    for (const tier of SUMMARY_STACK_TIERS) {
      for (const item of trace.tool_breakdown.observations) if (item.scope === tier) add(item.name);
    }
  }
  if (names.length === 0) return "—";
  const shown = names.slice(0, SUMMARY_STACK_LIMIT).join(", ");
  const omitted = names.length - SUMMARY_STACK_LIMIT;
  return omitted > 0 ? `${shown} +${omitted}` : shown;
}

/**
 * One row of the batch summary the chat receives (`score-jobs`, "Chat return"), built from one
 * published trace and from nothing else. Every cell is a trace value or a fixed arrangement of
 * trace values; the caller prints them as data.
 */
export function summaryRow(trace) {
  if (trace === null || typeof trace !== "object") throw new TypeError("trace must be an object");
  const codeField = DECISION_CODE_FIELDS[trace.decision];
  if (trace.decision !== "EVALUATED" && codeField === undefined) {
    throw new TypeError(`unsupported decision ${String(trace.decision)}`);
  }
  return Object.freeze({
    input_index: trace.input_index,
    job_title: trace.job_title,
    company: trace.company,
    decision:
      trace.decision === "EVALUATED"
        ? `${trace.bucket} ${trace.match_percent}%`
        : `${trace.decision}: ${trace[codeField]}`,
    stack: shortStack(trace),
    ai: `${trace.ai_in_product.value} / ${trace.ai_in_work.value}`,
    link: trace.source_ref,
  });
}
