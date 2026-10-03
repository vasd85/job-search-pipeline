/**
 * The pure triage decision function of `triage-policy-v8-2026-10-01`.
 *
 * `knowledge/job-match-rules.md` owns the policy; every branch below cites the section it
 * implements. Two properties are load-bearing and are what the tests pin:
 *
 * - **Absent information never produces a terminal state** (knowledge/job-match-rules.md#22-accepted-triage-decision-record). A component that cannot be
 *   scored takes its defined middle and records a `gap:` token; a default the policy supplies
 *   records an `assumption:` token. The single deliberate exception is closing sign 3 of the
 *   mobility branch, which is a `SKIP` on silence and is marked as such where it is implemented.
 * - **`MANUAL_REVIEW` survives for contradiction only** (knowledge/job-match-rules.md#63-manual_review-codes): three reasons, all about source
 *   data that is present and irreconcilable, or about the operator's own batch override.
 *
 * Every value that belongs to the candidate - the feasible-residence set, the excluded destinations,
 * the relocation tiers, the floors and the target, the independent price and experience of each test language/framework, and where each product domain sits on the Domain
 * Fit scale - is read from `input.candidateScoring`, which `/score-jobs` copies from the candidate
 * configuration, together with point tables, unknown values and limits. Branch selection,
 * monetary boundaries, independent main-stack selection and direct integer addition stay here.
 */
import { normalizeScorerInput } from "./normalized-input.mjs";
import { REFERENCE_RATE_PROVIDER } from "../candidate/scoring.mjs";
import {
  TOOLMATCH_TAXONOMY_ID,
  resolveLanguageName,
  resolveToolName,
  frameworkClassFor,
  isSupportingName,
  normalizeToolName,
} from "./tool-taxonomy.mjs";

const FORMAT_PRIORITY = Object.freeze(["Remote", "Hybrid", "On-site", "Unknown"]);

/** knowledge/job-match-rules.md#22-accepted-triage-decision-record SKIP precedence. `vacancy_unavailable` outranks the whole list and is handled before it. */
const SKIP_PRECEDENCE = Object.freeze([
  "not_qa_or_testing_role",
  "language_not_supported",
  "explicitly_not_eligible_to_work",
  "destination_excluded",
  "mobility_not_feasible",
  "manager_role",
  "manual_role",
  "junior_role",
]);

const GAP = Object.freeze({
  automationShareAbsent: "gap:automation_share_absent",
  companyRegionAbsent: "gap:company_region_absent",
  compensationAbsent: "gap:compensation_absent",
  compensationBasisIncomparable: "gap:compensation_basis_incomparable",
  compensationFxUnavailable: "gap:compensation_fx_unavailable",
  compensationMarketCurveAbsent: "gap:compensation_market_curve_absent",
  compensationPeriodAbsent: "gap:compensation_period_absent",
  domainUnclear: "gap:domain_unclear",
  mobilityBranchUnresolved: "gap:mobility_branch_unresolved",
  relocationCountryAbsent: "gap:relocation_country_absent",
  relocationCountryUnlisted: "gap:relocation_country_unlisted",
  relocationCountryUnresolved: "gap:relocation_country_unresolved",
  residenceRequirementCountryUnresolved: "gap:residence_requirement_country_unresolved",
  residenceRestrictionAbsent: "gap:residence_restriction_absent",
  seniorityAbsent: "gap:seniority_absent",
  stackAbsent: "gap:stack_absent",
  testLanguageAbsent: "gap:test_language_absent",
  testFrameworkAbsent: "gap:test_framework_absent",
  stackAmbiguous: "gap:stack_ambiguous",
  workFormatAbsent: "gap:work_format_absent",
});

const ASSUMPTION = Object.freeze({
  compensationBasisAdvertisedGross: "assumption:compensation.basis_advertised_gross",
  compensationFloorCurrencyFallback: "assumption:compensation.floor_currency_fallback",
  compensationRangeCrossesFloor: "assumption:compensation.range_crosses_floor",
  engagementPathHomeEmployment: "assumption:engagement_path.home_employment",
  engagementPathOutsideHomeContractor: "assumption:engagement_path.outside_home_contractor",
  engagementPathRelocation: "assumption:engagement_path.relocation",
});

const REFERENCE_MARKET_BANDS = Object.freeze({
  US: Object.freeze([140000 / 12, 120000 / 12, 95000 / 12, 75000 / 12, 0]),
  UK: Object.freeze([80000 / 12, 65000 / 12, 50000 / 12, 40000 / 12, 0]),
  Canada: Object.freeze([140000 / 12, 120000 / 12, 95000 / 12, 75000 / 12, 0]),
});
const REFERENCE_MARKET_CURRENCIES = Object.freeze({ Canada: "CAD", UK: "GBP", US: "USD" });

/**
 * knowledge/job-match-rules.md#22-accepted-triage-decision-record "The advertised basis": the markets whose boards print gross pay. Named, never derived from
 * `REFERENCE_MARKET_BANDS` - carrying a reference band and printing gross are independent
 * properties, and a market joins this set by name or not at all.
 */
const GROSS_ADVERTISING_MARKETS = new Set(["US", "UK", "Canada"]);

/** knowledge/job-match-rules.md#32-c--compensation--contract-fit below-floor curve: distance below the floor, never a skip. */
const BELOW_FLOOR_CURVE = Object.freeze([0.9, 0.8, 0.7, 0.5, 0]);

const SKIP_REASONS = Object.freeze({
  not_qa_or_testing_role: "The vacancy is not a QA or software testing role.",
  language_not_supported: "The full description is not in a supported language.",
  explicitly_not_eligible_to_work:
    "The source explicitly states an incompatible work authorization.",
  destination_excluded: "The role requires presence in a destination the candidate excludes.",
  mobility_not_feasible:
    "A closing sign has no countervailing opening sign (knowledge/job-match-rules.md#mobility-feasibility).",
  manager_role: "The role is explicitly process/people management with no engineering QA scope.",
  manual_role: "The role is explicitly manual-only.",
  junior_role: "The role is explicitly Junior/Entry seniority.",
  vacancy_unavailable: "The source explicitly marks the vacancy closed, removed or expired.",
});

function review(reason, evidenceQuote = null) {
  return { evidenceQuote, reason };
}

/**
 * knowledge/job-match-rules.md#31-m--mobility--work-feasibility "The destination", membership question: is the destination outside the feasible-residence
 * set? An identified country answers it on its own - the set is a closed enumeration of codes, so
 * every country is either inside it or outside it. Only when no country is named does the region
 * settle it where it can, and `null` is "undecidable": an undecidable destination never closes a
 * door.
 *
 * A set member the listing spells its own way is protected by the code, not by a fallback here: the
 * extractor identifies "<city>, <country>" by its code and membership is answered by the code alone. A
 * name nobody could identify has no code, and knowledge/job-match-rules.md#31-m--mobility--work-feasibility reads it as an undecidable destination - not as a
 * country outside the set, and not as an unnamed one either. The region does not stand in for it:
 * the region answers "when no country is named", and a listing that names a place has named one.
 */
function destinationOutsideFeasibleSet(offer, scoring) {
  if (offer.relocationCountryCode !== null) {
    return !scoring.mobility.feasible_residences.includes(offer.relocationCountryCode);
  }
  if (offer.relocationCountry !== null) return null;
  // The configuration keeps every WEST country out of the set and the home region inside it, which
  // is what lets these two regions answer.
  if (offer.companyRegion === "WEST") return true;
  if (offer.companyRegion === "HOME") return false;
  return null;
}

/**
 * Hard-SKIP rule 4: an excluded destination as the office of a Hybrid/On-site path, or as the only
 * country a stated residence demand can be met in.
 */
function requiresExcludedDestination(offer, scoring) {
  const excluded = scoring.mobility.excluded_destinations;
  if (
    ["Hybrid", "On-site"].includes(offer.workFormat) &&
    excluded.includes(offer.relocationCountryCode)
  )
    return true;
  return excluded.includes(offer.residenceRequirementCountryCode);
}

/**
 * knowledge/job-match-rules.md#22-accepted-triage-decision-record "Mobility feasibility": one closing sign against one opening sign, on a Hybrid or On-site
 * path. Signs 1 and 2 reach only a destination outside the feasible-residence set; sign 3 is the
 * deliberate exception to the uncertainty contract and fires on WEST silence alone.
 */
function mobilityClosingSign(offer, scoring) {
  if (!["Hybrid", "On-site"].includes(offer.workFormat)) return null;
  const outside = destinationOutsideFeasibleSet(offer, scoring);
  if (outside === true && offer.workAuthorization === "required_existing") {
    return "authorization_required_existing";
  }
  if (outside === true && offer.sponsorship === "unavailable") return "sponsorship_unavailable";
  if (
    offer.companyRegion === "WEST" &&
    offer.sponsorship === "unknown" &&
    offer.workAuthorization === "unknown"
  )
    return "west_relocation_authorization_silent";
  return null;
}

function mobilityOpeningSign(offer) {
  return (
    offer.sponsorship === "available" ||
    offer.relocationSupport === "available" ||
    offer.workAuthorization === "eligible"
  );
}

/**
 * Hard-SKIP rule 3, structure unchanged from the superseded record (knowledge/job-match-rules.md#22-accepted-triage-decision-record keeps it and changes only
 * its input, the feasible-residence set): a Remote path whose restriction excludes every feasible
 * residence is skipped only where the source refuses every cure. Silence is not a refusal - that
 * would be a second exception to the uncertainty contract, and knowledge/job-match-rules.md#22-accepted-triage-decision-record records exactly one.
 */
function remoteResidenceCloses(offer) {
  if (offer.workFormat !== "Remote" || offer.residenceRestriction !== "incompatible") return false;
  // All four refusals together, and each one of them alone is enough to keep the path scoreable:
  // an offered cure and an explicit refusal of it are different values of the same fact.
  return (
    offer.contractorEligibility === "ineligible" &&
    offer.workAuthorization === "required_existing" &&
    offer.sponsorship === "unavailable" &&
    offer.relocationSupport === "unavailable"
  );
}

/** Every hard-SKIP rule this one offered path trips, with the basis a mobility skip owes knowledge/job-match-rules.md#7-decision-trace-contract. */
function terminatePath(offer, scoring) {
  const codes = [];
  if (offer.workAuthorization === "explicitly_ineligible") {
    codes.push({ basis: null, code: "explicitly_not_eligible_to_work" });
  }
  if (requiresExcludedDestination(offer, scoring))
    codes.push({ basis: null, code: "destination_excluded" });
  const closingSign = mobilityClosingSign(offer, scoring);
  if (closingSign !== null && !mobilityOpeningSign(offer)) {
    codes.push({ basis: closingSign, code: "mobility_not_feasible" });
  }
  if (remoteResidenceCloses(offer)) {
    codes.push({ basis: "residence_incompatible", code: "mobility_not_feasible" });
  }
  return codes;
}

/**
 * knowledge/job-match-rules.md#22-accepted-triage-decision-record offered-path selection: run the hard-SKIP rules per observed path, drop what they terminate,
 * and select among the survivors by the priority order. Only when every observed path is terminated
 * is the vacancy skipped, and the SKIP precedence decides which code is reported.
 */
function selectOffer(input) {
  const observedFormats = [...new Set(input.offers.map((offer) => offer.workFormat))];
  const observedRegions = [...new Set(input.offers.map((offer) => offer.companyRegion))];
  if (input.offerPairing === "unclear") {
    return {
      observedFormats,
      observedRegions,
      allTerminated: false,
      review: review("offered_path_pairing_ambiguous", input.offers[0]?.evidenceQuote ?? null),
      selectedOffer: null,
      terminations: [],
    };
  }

  const terminations = input.offers.map((offer) => ({
    codes: terminatePath(offer, input.candidateScoring),
    offer,
  }));
  const survivors = terminations
    .filter(({ codes }) => codes.length === 0)
    .map(({ offer }) => offer);
  if (input.offers.length > 0 && survivors.length === 0) {
    return {
      allTerminated: true,
      observedFormats,
      observedRegions,
      review: null,
      selectedOffer: null,
      terminations,
    };
  }

  for (const workFormat of FORMAT_PRIORITY) {
    const candidates = survivors.filter((offer) => offer.workFormat === workFormat);
    if (candidates.length === 1) {
      return {
        allTerminated: false,
        observedFormats,
        observedRegions,
        review: null,
        selectedOffer: candidates[0],
        terminations,
      };
    }
    if (candidates.length > 1) {
      // knowledge/job-match-rules.md#31-m--mobility--work-feasibility: a destination nobody identified changes nothing here. The path is still one the
      // listing offered, so it is neither dropped from the selection nor terminated by a rule that
      // could not read it, and this contradiction stays what knowledge/job-match-rules.md#22-accepted-triage-decision-record says it is - the source offering
      // several paths of the selected format at once.
      return {
        allTerminated: false,
        observedFormats,
        observedRegions,
        review: review("multiple_selected_format_paths", candidates[0].evidenceQuote),
        selectedOffer: null,
        terminations,
      };
    }
  }
  return {
    allTerminated: false,
    observedFormats,
    observedRegions,
    review: null,
    selectedOffer: null,
    terminations,
  };
}

/** The configured tier of one country code, or `null` when no tier lists it. */
function tierOf(code, scoring) {
  const tiers = scoring.mobility.relocation_tiers;
  return ["high", "middle", "low"].find((tier) => tiers[tier].includes(code)) ?? null;
}

/**
 * The tier a region without a named country stands in for (knowledge/job-match-rules.md#31-m--mobility--work-feasibility "Tier"): WEST at its configured
 * tier - the configuration lists no WEST country in any tier, so every member shares it - and the
 * home region at the tier all its countries share, if they share one. Any other region spans tiers.
 */
function regionTierScore(offer, scoring) {
  if (offer.companyRegion === "WEST")
    return scoring.scoring.m.relocation[scoring.mobility.west_tier];
  if (offer.companyRegion === "HOME") {
    const tiers = new Set(scoring.mobility.home_region.map((code) => tierOf(code, scoring)));
    const [only] = tiers;
    return tiers.size === 1 && only !== null
      ? scoring.scoring.m.relocation[only]
      : scoring.scoring.m.relocation.unknown;
  }
  return scoring.scoring.m.relocation.unknown;
}

/** knowledge/job-match-rules.md#31-m--mobility--work-feasibility branch D: RelocationCountryScore for the selected relocation path. */
function relocationCountryScore(offer, scoring) {
  if (offer.relocationCountryCode !== null) {
    const named = tierOf(offer.relocationCountryCode, scoring);
    if (named !== null) return { gaps: [], score: scoring.scoring.m.relocation[named] };
    // A code no tier lists on a WEST path is a WEST country, priced by the region as it always was.
    if (offer.companyRegion === "WEST")
      return { gaps: [], score: scoring.scoring.m.relocation[scoring.mobility.west_tier] };
    return { gaps: [GAP.relocationCountryUnlisted], score: scoring.scoring.m.relocation.unknown };
  }
  // A named destination nobody could identify (knowledge/job-match-rules.md#31-m--mobility--work-feasibility): the region does not price it either, because
  // the region stands in only for a destination the listing never named. One rule for all three
  // readings - undecidable is undecidable - so this is the lane's unknown value and not the WEST tier. The
  // annotation is not recorded here: an unidentified destination is undecidable on every branch,
  // including the ones that return before this one, so `scoreMobility` records it for all of them.
  if (offer.relocationCountry !== null) {
    return { gaps: [], score: scoring.scoring.m.relocation.unknown };
  }
  // No country named: the region answers only where all its members share a tier (knowledge/job-match-rules.md#31-m--mobility--work-feasibility "Tier").
  return { gaps: [GAP.relocationCountryAbsent], score: regionTierScore(offer, scoring) };
}

/**
 * knowledge/job-match-rules.md#31-m--mobility--work-feasibility "An unresolved spelling": a destination the listing named and nobody identified is recorded
 * wherever it is read, not only where it is priced. Branch D is the only branch that consults the
 * tier, but membership and rule 4 are read before any branch is chosen - a WEST on-site path with
 * explicit sponsorship is scored by branch A and never reaches the tier, and rule 4's residence half
 * is read on a Remote path that reaches no relocation branch at all. Annotating only branch D would
 * leave the loudest case of the two silent: the extractor omitting one code deletes the one hard
 * SKIP the candidate's excluded destinations own.
 *
 * The relocation destination is annotated only on a Hybrid or On-site path, because that is where
 * any rule reads it; the residence requirement is annotated on every format, because rule 4 reads it
 * on every format.
 */
function unresolvedDestinationGaps(offer) {
  const gaps = [];
  if (
    ["Hybrid", "On-site"].includes(offer.workFormat) &&
    offer.relocationCountry !== null &&
    offer.relocationCountryCode === null
  )
    gaps.push(GAP.relocationCountryUnresolved);
  if (offer.residenceRequirementCountry !== null && offer.residenceRequirementCountryCode === null)
    gaps.push(GAP.residenceRequirementCountryUnresolved);
  return gaps;
}

/** knowledge/job-match-rules.md#31-m--mobility--work-feasibility branches A-D, with the M middle of knowledge/job-match-rules.md#22-accepted-triage-decision-record wherever none of them resolves the selected path. */
function scoreMobility(offer, scoring) {
  const scored = mobilityBranchScore(offer, scoring);
  if (!offer) return scored;
  const unresolved = unresolvedDestinationGaps(offer);
  if (unresolved.length === 0) return scored;
  return { ...scored, gaps: [...new Set([...scored.gaps, ...unresolved])] };
}

function mobilityBranchScore(offer, scoring) {
  const points = scoring.scoring.m;
  const remote = points.remote;
  if (!offer) {
    return {
      gaps: [GAP.workFormatAbsent, GAP.companyRegionAbsent],
      reason: "Work format and region were not observed; middle mobility score.",
      score: scoring.scoring.m.unknown,
    };
  }
  const unresolved = {
    gaps: [GAP.mobilityBranchUnresolved],
    reason:
      "The observed combination matches no mobility branch; middle mobility score (knowledge/job-match-rules.md#31-m--mobility--work-feasibility).",
    score: scoring.scoring.m.unknown,
  };
  const residenceGaps =
    offer.residenceRestriction === "unknown" ? [GAP.residenceRestrictionAbsent] : [];

  if (offer.sponsorship === "available" && offer.companyRegion === "WEST") {
    return { gaps: [], reason: "WEST path with explicit sponsorship.", score: points.sponsored };
  }

  if (offer.workFormat === "Remote" && offer.companyRegion === "WEST") {
    const compatible = ["none", "compatible"].includes(offer.residenceRestriction);
    // Branch B prices the WEST sub-region far from the home timezone below the near one.
    const far = offer.westRegion !== scoring.mobility.west_near_subregion;
    if (["tz_any", "tz_home"].includes(offer.timezone)) {
      return {
        gaps: residenceGaps,
        reason: "WEST remote path with a broad or home-compatible timezone.",
        score: compatible ? remote.broad_open : remote.broad_restricted,
      };
    }
    if (offer.timezone === "tz_local") {
      return {
        gaps: residenceGaps,
        reason: "WEST remote path with a local timezone constraint.",
        score: far
          ? compatible
            ? remote.far_local_open
            : remote.far_local_restricted
          : compatible
            ? remote.near_local_open
            : remote.near_local_restricted,
      };
    }
    return {
      gaps: residenceGaps,
      reason: "WEST remote path with no explicit timezone constraint.",
      score: far
        ? compatible
          ? remote.far_unknown_open
          : remote.far_unknown_restricted
        : compatible
          ? remote.near_unknown_open
          : remote.near_unknown_restricted,
    };
  }

  if (offer.workFormat === "Remote") {
    if (["tz_any", "tz_home"].includes(offer.timezone)) {
      return {
        gaps: [],
        reason: "Remote path with a broad or home-compatible timezone.",
        score: remote.other_near,
      };
    }
    if (offer.companyRegion === "HOME") {
      return {
        gaps: [],
        reason: "Remote path in the home region, which shares the home timezone.",
        score: remote.other_near,
      };
    }
    if (offer.timezoneDistance === "near") {
      return {
        gaps: [],
        reason: "Remote path close to the home timezone.",
        score: remote.other_near,
      };
    }
    if (offer.companyRegion === "UNKNOWN") {
      return {
        gaps: [],
        reason: "Remote path with an unknown company region.",
        score: remote.other_unknown,
      };
    }
    if (offer.timezoneDistance === "far" && offer.timezone === "tz_unknown") {
      return {
        gaps: [],
        reason: "Remote path far from the home timezone with no explicit timezone constraint.",
        score: remote.other_far_unknown,
      };
    }
    if (offer.timezoneDistance === "far" && offer.timezone === "tz_local") {
      return {
        gaps: [],
        reason: "Remote path far from the home timezone and bound to a local timezone.",
        score: remote.other_far_local,
      };
    }
    return unresolved;
  }

  if (["Hybrid", "On-site"].includes(offer.workFormat)) {
    const country = relocationCountryScore(offer, scoring);
    const bonus =
      offer.sponsorship === "available" || offer.relocationSupport === "available"
        ? points.relocation.bonus
        : 0;
    return {
      gaps: country.gaps,
      reason:
        "Relocation path scored by the country table (knowledge/job-match-rules.md#31-m--mobility--work-feasibility).",
      score: Math.min(points.relocation.max, country.score + bonus),
    };
  }

  return unresolved;
}

/**
 * knowledge/job-match-rules.md#22-accepted-triage-decision-record engagement-path defaults: a table total over (format class, region). An observed model is
 * never overridden, and an applied default is named in `assumptions`.
 */
function resolveEngagementPath(offer, selectedFormat) {
  if (offer?.engagementPath) return { assumption: null, path: offer.engagementPath };
  const region = offer?.companyRegion ?? "UNKNOWN";
  if (region === "HOME") {
    return { assumption: ASSUMPTION.engagementPathHomeEmployment, path: "home_employment" };
  }
  const remoteOrUnresolved =
    selectedFormat === null || selectedFormat === "Remote" || selectedFormat === "Unknown";
  return remoteOrUnresolved
    ? {
        assumption: ASSUMPTION.engagementPathOutsideHomeContractor,
        path: "outside_home_contractor",
      }
    : { assumption: ASSUMPTION.engagementPathRelocation, path: "relocation_employment" };
}

function monthlyAmount(amount, period) {
  if (period === "monthly") return amount;
  if (period === "annual") return amount / 12;
  if (period === "hourly") return (amount * 40 * 52) / 12;
  return null;
}

/**
 * knowledge/job-match-rules.md#22-accepted-triage-decision-record floors, read from the candidate configuration. A floor with several currencies compares a
 * salary stated in one of them in that currency, and any other salary in the first, recorded as a
 * default; a floor with one currency compares every salary in it.
 */
function ordinaryFloor(engagementPath, compensation, scoring) {
  // Relocation employment has no ordinary numeric floor and none is invented (knowledge/job-match-rules.md#22-accepted-triage-decision-record).
  if (!Object.hasOwn(scoring.compensation.floors, engagementPath)) return null;
  const { amount, basis, currencies } = scoring.compensation.floors[engagementPath];
  const stated = compensation !== null && currencies.includes(compensation.currency);
  const fallback = currencies.length > 1 && !stated;
  return {
    amount,
    assumptions: fallback ? [ASSUMPTION.compensationFloorCurrencyFallback] : [],
    basis,
    currency: stated ? compensation.currency : currencies[0],
    origin: "ordinary",
    period: "monthly",
  };
}

function convertMonthly(value, sourceCurrency, targetCurrency, fx, scoring) {
  if (sourceCurrency === targetCurrency) return value;
  const { home_currency: homeCurrency, home_rate_provider: homeRateProvider } =
    scoring.compensation;
  const provider =
    sourceCurrency === homeCurrency || targetCurrency === homeCurrency
      ? homeRateProvider
      : REFERENCE_RATE_PROVIDER;
  if (
    !fx ||
    fx.sourceCurrency !== sourceCurrency ||
    fx.targetCurrency !== targetCurrency ||
    fx.provider !== provider
  )
    return null;
  return value * fx.targetPerSource;
}

function scoreReferenceMarket(market, monthly, points) {
  const bands = REFERENCE_MARKET_BANDS[market];
  if (!bands) return null;
  return points.reference[bands.findIndex((threshold) => monthly >= threshold)];
}

function belowFloorScore(ratio, points) {
  return points.below_floor[BELOW_FLOOR_CURVE.findIndex((threshold) => ratio >= threshold)];
}

/**
 * knowledge/job-match-rules.md#32-c--compensation--contract-fit A, from the floor `floor` up, with the target `target`: the band below the target is as wide
 * as the one above it, and everything past both scores the maximum.
 */
function outsideHomeContractorScore(monthly, floor, target, points) {
  const width = target - floor;
  if (monthly >= target + width) return points.max;
  if (monthly >= target)
    return points.target + Math.floor(((points.max - points.target) * (monthly - target)) / width);
  return points.start + Math.floor(((points.target - points.start) * (monthly - floor)) / width);
}

function compensationMiddle(gaps, reason, points) {
  return {
    assumptions: [],
    floor: null,
    fxUsed: null,
    gaps,
    reason,
    review: null,
    score: points.unknown,
  };
}

/**
 * knowledge/job-match-rules.md#22-accepted-triage-decision-record compensation normalization and knowledge/job-match-rules.md#32-c--compensation--contract-fit C. Branch order starts with absence; every remaining way
 * a comparison can fail takes the C middle with its own `gap:` token, and the only surviving review
 * state is an operator override the policy cannot normalize.
 */
function scoreCompensation(input, offer, engagementPath) {
  const compensation = input.compensation;
  const scoring = input.candidateScoring;
  const points = scoring.scoring.c;
  if (compensation === null) {
    return compensationMiddle(
      [GAP.compensationAbsent],
      "Compensation is not stated; middle score.",
      points,
    );
  }
  const override = input.explicitOverride;
  if (
    override &&
    (monthlyAmount(override.amount, override.period) === null || override.basis === "unknown")
  ) {
    return {
      assumptions: [],
      floor: null,
      fxUsed: null,
      gaps: [],
      review: review("compensation_override_undefined", compensation.evidenceQuote),
      score: null,
    };
  }

  const floor = override
    ? {
        amount: monthlyAmount(override.amount, override.period),
        basis: override.basis,
        currency: override.currency,
        origin: "override",
        period: "monthly",
        scope: "batch",
      }
    : ordinaryFloor(engagementPath, compensation, scoring);
  const floorAssumptions = floor?.assumptions ?? [];
  const publishedFloor =
    floor === null
      ? null
      : {
          amount: floor.amount,
          basis: floor.basis,
          currency: floor.currency,
          origin: floor.origin,
          period: floor.period,
          ...(floor.scope ? { scope: floor.scope } : {}),
        };

  const gaps = [];
  const monthlyMinimum = monthlyAmount(compensation.minimum, compensation.period);
  const monthlyMaximum = monthlyAmount(compensation.maximum, compensation.period);
  if (monthlyMinimum === null || monthlyMaximum === null) gaps.push(GAP.compensationPeriodAbsent);
  const assumptions = [...floorAssumptions];
  // knowledge/job-match-rules.md#22-accepted-triage-decision-record "The advertised basis": where the posting is placed in a market whose boards print gross
  // and the floor it meets is a gross one, a figure the listing left unlabelled is read as gross.
  // It never touches a stated basis, and against a net floor it would price nothing, because gross
  // is never converted to net. The floor may be the ordinary one or a batch override; on a lane
  // with no floor there is no comparison for the reading to be consumed by.
  const advertisedGross =
    compensation.basis === "unknown" &&
    floor !== null &&
    floor.basis === "gross" &&
    GROSS_ADVERTISING_MARKETS.has(offer?.compensationMarket);
  if (advertisedGross) assumptions.push(ASSUMPTION.compensationBasisAdvertisedGross);
  const comparisonBasis = advertisedGross ? "gross" : compensation.basis;
  // The basis bullet needs a floor to be about: a lane without one has no comparison to fail.
  if (floor !== null && (comparisonBasis === "unknown" || comparisonBasis !== floor.basis)) {
    gaps.push(GAP.compensationBasisIncomparable);
  }
  if (gaps.length > 0) {
    return {
      assumptions,
      floor: publishedFloor,
      fxUsed: null,
      gaps,
      reason: "The stated amount cannot be compared with the floor; middle score.",
      review: null,
      score: points.unknown,
    };
  }

  let fxApplied = false;
  const convert = (value, from, to) => {
    if (from === to) return value;
    const converted = convertMonthly(value, from, to, input.fx, scoring);
    if (converted !== null) fxApplied = true;
    return converted;
  };
  const fxMiddle = () => ({
    assumptions,
    floor: publishedFloor,
    fxUsed: fxApplied ? input.fx : null,
    gaps: [GAP.compensationFxUnavailable],
    reason: "The official rate is unavailable; middle score.",
    review: null,
    score: points.unknown,
  });

  // knowledge/job-match-rules.md#22-accepted-triage-decision-record "The comparison value": a stated lower bound is compared and scored **unchanged**, so it
  // keeps the currency the listing published it in. Only a range crossing the floor replaces it,
  // with the floor value itself.
  let comparisonValue = monthlyMinimum;
  let comparisonCurrency = compensation.currency;
  let floorRatio = null;
  let belowFloor = null;

  if (floor !== null) {
    const minimum = convert(monthlyMinimum, compensation.currency, floor.currency);
    const maximum = convert(monthlyMaximum, compensation.currency, floor.currency);
    if (minimum === null || maximum === null) return fxMiddle();
    if (maximum < floor.amount) {
      // knowledge/job-match-rules.md#32-c--compensation--contract-fit below-floor curve, computed from the maximum: the vacancy stays ranked.
      floorRatio = maximum / floor.amount;
      belowFloor = belowFloorScore(floorRatio, points);
      comparisonValue = maximum;
      comparisonCurrency = floor.currency;
    } else if (minimum < floor.amount) {
      floorRatio = 1;
      comparisonValue = floor.amount;
      comparisonCurrency = floor.currency;
      assumptions.push(ASSUMPTION.compensationRangeCrossesFloor);
    } else {
      floorRatio = minimum / floor.amount;
    }
  }

  const settle = (score, reason) => ({
    assumptions,
    floor: publishedFloor,
    fxUsed: fxApplied ? input.fx : null,
    gaps: [],
    reason,
    review: null,
    score,
  });

  if (belowFloor !== null)
    return settle(
      belowFloor,
      "The amount is below the applicable floor; below-floor curve applied (knowledge/job-match-rules.md#32-c--compensation--contract-fit).",
    );

  if (engagementPath === "outside_home_contractor") {
    const curve = scoring.compensation.floors.outside_home_contractor;
    const monthly = convert(comparisonValue, comparisonCurrency, curve.currencies[0]);
    if (monthly === null) return fxMiddle();
    // knowledge/job-match-rules.md#32-c--compensation--contract-fit A prices from the configured floor up and sends everything below it to the below-floor
    // curve. A batch override that lowers the floor is the one way to reach that range without
    // being below the floor, and the candidate may lower a floor for a batch.
    if (monthly < curve.amount) {
      return settle(
        belowFloorScore(floorRatio, points),
        "The amount is below band A; below-floor curve applied (knowledge/job-match-rules.md#32-c--compensation--contract-fit).",
      );
    }
    return settle(
      outsideHomeContractorScore(monthly, curve.amount, scoring.compensation.target, points),
      "Outside-home contractor curve.",
    );
  }
  if (
    ["home_employment", "home_contractor", "comparable_cost_employment"].includes(engagementPath)
  ) {
    return settle(points.local, "Approved neutral local compensation score.");
  }

  // Relocation employment: the US/UK/Canada reference bands, or the C middle where none exists.
  const market = offer?.compensationMarket ?? "unknown";
  const targetCurrency = REFERENCE_MARKET_CURRENCIES[market] ?? null;
  if (targetCurrency === null) {
    return {
      assumptions,
      floor: publishedFloor,
      fxUsed: fxApplied ? input.fx : null,
      gaps: [GAP.compensationMarketCurveAbsent],
      reason: "This market has no reference curve; middle score.",
      review: null,
      score: points.unknown,
    };
  }
  const monthly = convert(comparisonValue, comparisonCurrency, targetCurrency);
  if (monthly === null) return fxMiddle();
  return settle(
    scoreReferenceMarket(market, monthly, points),
    `${market} relocation reference curve.`,
  );
}

/**
 * knowledge/job-match-rules.md#34-d--domain-fit: a named domain scores where the candidate's configuration places it; the two the engine
 * handles itself are `irrelevant` (zero) and `unclear` (the configured unknown value).
 */
function scoreDomain(role, domainFit, points) {
  if (role.domain === "unclear") {
    return {
      gaps: [GAP.domainUnclear],
      reason: "Domain unclear; middle score.",
      score: points.unknown,
    };
  }
  if (role.domain === "irrelevant") {
    return { gaps: [], reason: "The domain is not software testing.", score: 0 };
  }
  // The input accepts only the names the scoring values place, so this is a broken invariant, never
  // a value to guess: an undefined score would sum to NaN and fall into `pass` in silence.
  if (!Object.hasOwn(domainFit, role.domain)) {
    throw new Error(`the scoring values place no domain ${role.domain}`);
  }
  return {
    gaps: [],
    reason: "Placed by the candidate's configuration.",
    score: domainFit[role.domain],
  };
}

export function mobilityCap(score, points) {
  return points.cap_limits[points.cap_scores.findIndex((upper) => score <= upper)];
}

export function bucketFor(matchPercent) {
  if (matchPercent >= 80) return "priority";
  if (matchPercent >= 65) return "apply";
  if (matchPercent >= 50) return "consider";
  return "pass";
}

/** Best main language and framework, independently (knowledge/job-match-rules.md#33-s--skillsstack--role-fit). */
function deriveToolMatch(role, toolMatch) {
  const observe = (item, language) => {
    const canonical = language ? resolveLanguageName(item.name) : resolveToolName(item.name);
    const knownClass = language ? null : frameworkClassFor(canonical);
    const kind = language
      ? "language"
      : knownClass !== null
        ? "framework"
        : isSupportingName(item.name)
          ? "supporting"
          : item.kind;
    const prices = language ? toolMatch.languages : toolMatch.frameworks;
    const price = prices.find((entry) => entry.name === canonical);
    const counted = item.scope === "main" && (language || kind === "framework");
    return {
      ...item,
      canonical_name: canonical,
      kind,
      framework_class: knownClass,
      recognised: canonical !== null,
      points: counted ? (price?.points ?? 0) : null,
      experience: price?.experience ?? "unknown",
      counted,
    };
  };
  const order = (left, right) => {
    const a = JSON.stringify([
      left.canonical_name ?? normalizeToolName(left.name),
      left.name,
      left.scope,
      left.requirement,
      left.evidenceQuote,
      left.requirementPhrase,
      left.scopeReason,
    ]);
    const b = JSON.stringify([
      right.canonical_name ?? normalizeToolName(right.name),
      right.name,
      right.scope,
      right.requirement,
      right.evidenceQuote,
      right.requirementPhrase,
      right.scopeReason,
    ]);
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const languages = role.observedLanguages.map((item) => observe(item, true)).sort(order);
  const tools = role.observedTools.map((item) => observe(item, false)).sort(order);
  const half = (items) => {
    const main = items.filter((item) => item.counted);
    if (main.length === 0) return { score: 2, selected: null, state: "unknown" };
    const best = [...main].sort((a, b) => b.points - a.points || order(a, b))[0];
    return { score: best.points, selected: best, state: best.points > 0 ? "matched" : "mismatch" };
  };
  const language = half(languages);
  const framework = half(tools);
  const all = [...languages, ...tools];
  const gaps = [];
  if (language.state === "unknown" && framework.state === "unknown") gaps.push(GAP.stackAbsent);
  else {
    if (language.state === "unknown") gaps.push(GAP.testLanguageAbsent);
    if (framework.state === "unknown") gaps.push(GAP.testFrameworkAbsent);
  }
  if (all.some((item) => item.scope === "ambiguous" || item.kind === "ambiguous"))
    gaps.push(GAP.stackAmbiguous);
  return {
    toolMatch: language.score + framework.score,
    gaps,
    breakdown: {
      language,
      framework,
      observations: all,
      optional: all.filter((item) => item.scope === "optional"),
      supporting: all.filter((item) => item.kind === "supporting"),
      product: all.filter((item) => item.scope === "product"),
      ambiguous: all.filter((item) => item.scope === "ambiguous" || item.kind === "ambiguous"),
      unrecognised: all.filter((item) => !item.recognised),
      required_without_direct_experience: all.filter(
        (item) =>
          item.requirement === "required" &&
          item.scope === "main" &&
          ["language", "framework"].includes(item.kind) &&
          item.experience !== "direct",
      ),
      experience_note:
        "Experience describes the named technology; direct framework use does not establish direct use in every language or version.",
    },
  };
}

/** knowledge/job-match-rules.md#33-s--skillsstack--role-fit S = AutomationShare + ToolMatch + SeniorityFit, each with its own middle. */
function scoreSkills(role, toolMatch, points) {
  const terminalCode =
    role.automation === "manager_only"
      ? "manager_role"
      : role.automation === "manual_only"
        ? "manual_role"
        : role.seniority === "junior"
          ? "junior_role"
          : null;
  if (terminalCode) return { gaps: [], score: null, terminalCode };

  const gaps = [];
  let automation = points.automation[role.automation];
  if (role.automation === "unknown") {
    automation = points.automation.unknown;
    gaps.push(GAP.automationShareAbsent);
  }
  const tools = deriveToolMatch(role, toolMatch);
  gaps.push(...tools.gaps);
  let seniority = points.seniority[role.seniority];
  if (role.seniority === "unknown") {
    seniority = points.seniority.unknown;
    gaps.push(GAP.seniorityAbsent);
  }
  return {
    automation,
    gaps,
    reason: `Automation ${automation} + ToolMatch ${tools.toolMatch} + Seniority ${seniority}.`,
    score: automation + tools.toolMatch + seniority,
    seniority,
    terminalCode: null,
    toolBreakdown: tools.breakdown,
    toolMatch: tools.toolMatch,
  };
}

function terminalEvidence(code, input, selection) {
  if (code === "language_not_supported") return input.role.evidence.language;
  if (code === "explicitly_not_eligible_to_work") {
    return (
      input.offers.find((offer) => offer.workAuthorization === "explicitly_ineligible")
        ?.evidenceQuote ?? null
    );
  }
  if (code === "destination_excluded") {
    return (
      input.offers.find((offer) => requiresExcludedDestination(offer, input.candidateScoring))
        ?.evidenceQuote ?? null
    );
  }
  if (code === "mobility_not_feasible") {
    return (
      selection.terminations.find(({ codes }) => codes.some((entry) => entry.code === code))?.offer
        .evidenceQuote ?? null
    );
  }
  if (["manager_role", "manual_role"].includes(code)) return input.role.evidence.automation;
  if (code === "junior_role") return input.role.evidence.seniority;
  return input.source.evidenceQuote;
}

/** knowledge/job-match-rules.md#7-decision-trace-contract: `skip_basis` is required for `mobility_not_feasible` and `null` for every other code. */
function skipBasisFor(code, selection) {
  if (code !== "mobility_not_feasible") return null;
  for (const { codes } of selection.terminations) {
    const match = codes.find((entry) => entry.code === code);
    if (match) return match.basis;
  }
  return null;
}

/**
 * The decision for one raw input. `normalizeScorerInput` refuses every object this record does not
 * score - an earlier schema version or another record's id - so what reaches the branches below was
 * built under the live record and carries the values it is scored with.
 */
export function decideNormalizedJob(rawInput, { languages, scoring } = {}) {
  const input = normalizeScorerInput(rawInput, { languages, scoring });
  // knowledge/job-match-rules.md#22-accepted-triage-decision-record: `SKIP: vacancy_unavailable` outranks the whole precedence list, because a vacancy the
  // source marks closed, removed or expired is not assessed for anything else. The title-only
  // not-QA skip still precedes `technical_unavailable`: knowledge/job-match-rules.md#21-access-outcome-before-scoring allows that early skip without a full
  // description, and a technical failure is not a statement about the vacancy.
  if (input.source.accessOutcome === "closed") {
    return {
      decision: "SKIP",
      evidenceQuote: input.source.evidenceQuote,
      input,
      skipBasis: null,
      skipCode: "vacancy_unavailable",
      skipReason: SKIP_REASONS.vacancy_unavailable,
      symptom: input.source.accessReason,
    };
  }
  if (input.role.family === "other") {
    return {
      decision: "SKIP",
      evidenceQuote: input.role.evidence.role,
      input,
      skipBasis: null,
      skipCode: "not_qa_or_testing_role",
      skipReason: SKIP_REASONS.not_qa_or_testing_role,
    };
  }
  if (input.source.accessOutcome === "technical_unavailable") {
    return {
      blockerCode: "vacancy_unavailable",
      blockerReason: "The full description is unavailable after the one allowed retry.",
      decision: "BLOCKED",
      evidenceQuote: input.source.evidenceQuote,
      input,
      symptom: input.source.accessReason,
    };
  }

  const selection = selectOffer(input);
  const skills = scoreSkills(
    input.role,
    input.candidateScoring.tool_match,
    input.candidateScoring.scoring.s,
  );
  const terminatedCodes = selection.allTerminated
    ? selection.terminations.flatMap(({ codes }) => codes.map(({ code }) => code))
    : [];
  const terminalFlags = {
    language_not_supported: input.role.language === "unsupported",
    explicitly_not_eligible_to_work: terminatedCodes.includes("explicitly_not_eligible_to_work"),
    destination_excluded: terminatedCodes.includes("destination_excluded"),
    mobility_not_feasible: terminatedCodes.includes("mobility_not_feasible"),
    manager_role: skills.terminalCode === "manager_role",
    manual_role: skills.terminalCode === "manual_role",
    junior_role: skills.terminalCode === "junior_role",
  };
  const skipCode = SKIP_PRECEDENCE.find((code) => terminalFlags[code]);
  if (skipCode) {
    return {
      decision: "SKIP",
      evidenceQuote: terminalEvidence(skipCode, input, selection),
      input,
      selection,
      skipBasis: skipBasisFor(skipCode, selection),
      skipCode,
      skipReason: SKIP_REASONS[skipCode],
    };
  }

  if (selection.review) {
    return {
      decision: "MANUAL_REVIEW",
      evidenceQuote: selection.review.evidenceQuote,
      input,
      reviewCode: "policy_undefined",
      reviewReason: selection.review.reason,
      selection,
    };
  }

  const selectedFormat = selection.selectedOffer?.workFormat ?? null;
  const engagement = resolveEngagementPath(selection.selectedOffer, selectedFormat);
  const compensation = scoreCompensation(input, selection.selectedOffer, engagement.path);
  if (compensation.review) {
    return {
      compensation,
      decision: "MANUAL_REVIEW",
      evidenceQuote: compensation.review.evidenceQuote,
      input,
      reviewCode: "policy_undefined",
      reviewReason: compensation.review.reason,
      selection,
    };
  }

  const mobility = scoreMobility(selection.selectedOffer, input.candidateScoring);
  const domain = scoreDomain(
    input.role,
    input.candidateScoring.domain_fit,
    input.candidateScoring.scoring.d,
  );
  const matchRaw = mobility.score + compensation.score + skills.score + domain.score;
  const cap = mobilityCap(mobility.score, input.candidateScoring.scoring.m);
  const matchPercent = Math.min(matchRaw, cap);
  return {
    assumptions: [engagement.assumption, ...compensation.assumptions].filter(Boolean),
    bucket: bucketFor(matchPercent),
    compensation,
    dataGaps: [...mobility.gaps, ...compensation.gaps, ...skills.gaps, ...domain.gaps],
    decision: "EVALUATED",
    domain,
    engagementPath: engagement.path,
    input,
    matchPercent,
    matchRaw,
    mobility,
    mobilityCap: cap,
    selection,
    skills,
    toolmatchTaxonomyId: TOOLMATCH_TAXONOMY_ID,
  };
}
