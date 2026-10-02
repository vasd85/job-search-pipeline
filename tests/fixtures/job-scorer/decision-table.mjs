// Synthetic policy fixtures for the pure scorer. They encode the accepted decision record
// `triage-policy-v8-2026-10-01` and the ToolMatch taxonomy `toolmatch-taxonomy-v6-2026-10-01`;
// they are not vacancy captures and never assert live-source behavior.

/**
 * The scoring values every base input carries, in the shape of the candidate configuration. They are
 * the values the record's cases were written against; a case about what the values decide replaces
 * the part it is about.
 */
export function baseScoring() {
  return {
    scoring: {
      m: {
        max: 25,
        unknown: 15,
        sponsored: 25,
        remote: {
          broad_open: 25,
          broad_restricted: 20,
          far_local_open: 15,
          far_local_restricted: 10,
          near_local_open: 25,
          near_local_restricted: 20,
          far_unknown_open: 20,
          far_unknown_restricted: 10,
          near_unknown_open: 25,
          near_unknown_restricted: 15,
          other_near: 25,
          other_unknown: 20,
          other_far_unknown: 15,
          other_far_local: 5
        },
        relocation: {
          high: 20,
          middle: 10,
          low: 0,
          unknown: 10,
          bonus: 5,
          max: 25
        },
        cap_scores: [
          4,
          11,
          19,
          25
        ],
        cap_limits: [
          39,
          59,
          79,
          100
        ]
      },
      c: {
        max: 35,
        unknown: 15,
        local: 15,
        start: 5,
        target: 15,
        below_floor: [
          4,
          3,
          2,
          1,
          0
        ],
        reference: [
          35,
          31,
          24,
          17,
          10
        ]
      },
      s: {
        max: 30,
        automation: {
          max: 14,
          primary: 12,
          major: 8,
          limited: 4,
          unknown: 4
        },
        seniority: {
          max: 6,
          senior: 6,
          mid: 3,
          lower: 0,
          unknown: 3
        },
        tools: { max: 10 }
      },
      d: {
        max: 10,
        unknown: 4,
        steps: [
          0,
          2,
          4,
          6,
          8,
          10
        ]
      }
    },
    compensation: {
      floors: {
        comparable_cost_employment: { amount: 3200, basis: "net", currencies: ["USD", "CHF"] },
        home_contractor: { amount: 2400000, basis: "gross", currencies: ["ARS"] },
        home_employment: { amount: 2000000, basis: "net", currencies: ["ARS"] },
        outside_home_contractor: { amount: 3200, basis: "gross", currencies: ["USD"] },
      },
      home_currency: "ARS",
      home_rate_provider: "BCRA",
      target: 4200,
    },
    // Fictional, like the values around it: only the base input's own domain keeps the 9 the whole
    // decision table was written against.
    domain_fit: {
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
    },
    mobility: {
      excluded_destinations: ["MT"],
      feasible_residences: ["AR", "BO", "CL", "CR", "PA", "PE", "PY", "UY"],
      home_region: ["AR", "UY"],
      relocation_tiers: {
        high: ["BN", "CN", "HK", "ID", "MO", "MU", "MV", "NZ", "SC", "TW", "ZA"],
        low: ["AR", "BO", "BZ", "CL", "EC", "GY", "PE", "PY", "SR", "UY"],
        middle: ["CO", "CR", "DO", "MX", "PA"],
      },
      west_near_subregion: "EU_UK",
      west_tier: "high",
    },
    tool_match: {
      languages: [{ name: "TypeScript", points: 4, experience: "direct" }, { name: "Java", points: 1, experience: "transferable" }, { name: "Python", points: 5, experience: "direct" }],
      frameworks: [{ name: "Playwright", points: 4, experience: "direct" }, { name: "REST Assured", points: 2, experience: "transferable" }, { name: "TestNG", points: 1, experience: "direct" }, { name: "PyTest", points: 5, experience: "direct" }],
    },
  };
}

export function baseObservedLanguage(overrides = {}) {
  return {
    name: "TypeScript", requirement: "required", requirementPhrase: null,
    scope: "main", scopeReason: "The QA requirements name the test language.",
    evidenceQuote: "TypeScript, Playwright, API", ...overrides,
  };
}
export function baseObservedTool(overrides = {}) {
  const { language: _retiredBinding, ...values } = overrides;
  const name = values.name ?? "Playwright";
  const supporting = ["Jenkins", "Docker", "Kubernetes", "GitHub Actions", "Stryker", "Prometheus", "Datadog", "Grafana", "Postman", "Allure", "SQL"].includes(name);
  return {
    evidenceQuote: values.evidenceQuote ?? "TypeScript, Playwright, API",
    name, requirement: "observed", requirementPhrase: null,
    scope: values.requirement === "optional" ? "optional" : "main",
    scopeReason: "The description names the QA stack.",
    kind: supporting ? "supporting" : "framework", ...values,
  };
}

export function baseOffer(overrides = {}) {
  return {
    companyRegion: "HOME",
    compensationMarket: "other",
    contractorEligibility: "eligible",
    engagementPath: "home_employment",
    evidenceQuote: "Remote work from Argentina",
    relocationCountry: null,
    relocationCountryCode: null,
    relocationSupport: "unknown",
    residenceRequirementCountry: null,
    residenceRequirementCountryCode: null,
    residenceRestriction: "none",
    sponsorship: "unavailable",
    timezone: "tz_unknown",
    timezoneDistance: "near",
    westRegion: null,
    workAuthorization: "eligible",
    workFormat: "Remote",
    ...overrides,
  };
}

export function baseInput(overrides = {}) {
  const input = {
    candidateScoring: baseScoring(),
    compensation: {
      basis: "net",
      currency: "ARS",
      evidenceQuote: "ARS 2,000,000 net per month",
      kind: "value",
      maximum: 2000000,
      minimum: 2000000,
      period: "monthly",
    },
    explicitOverride: null,
    fx: null,
    inputIndex: 1,
    offerPairing: "clear",
    offers: [baseOffer()],
    policyId: "triage-policy-v8-2026-10-01",
    role: {
      ai: { product: "none", work: "none" },
      automation: "primary",
      domain: "data_platforms",
      evidence: {
        aiProduct: null,
        aiWork: null,
        automation: "строить automation framework",
        domain: "B2B data platform",
        language: "English description",
        role: "Senior SDET",
        seniority: "architecture and mentoring",
        tools: "TypeScript, Playwright, API",
      },
      family: "qa_testing",
      language: "English",
      observedTools: [
        baseObservedTool({
          evidenceQuote: "TypeScript, Playwright",
          language: "typescript_javascript",
          name: "Playwright",
          requirement: "required",
        }),
        baseObservedTool({ name: "REST Assured" }),
      ],
      observedLanguages: [baseObservedLanguage()],
      seniority: "senior",
    },
    schemaVersion: 9,
    scoringDate: "2026-08-22",
    source: {
      accessOutcome: "usable",
      accessReason: null,
      company: "Synthetic Company",
      evidenceQuote: "Full description loaded",
      finalUrl: "https://example.test/jobs/1",
      jobTitle: "Senior SDET",
      locationRaw: "Argentina / Remote",
      salaryRaw: "2 000 000 ARS net monthly",
      sourceRef: "https://example.test/jobs/1",
      workFormatRaw: "Remote",
    },
  };
  return Object.assign(input, structuredClone(overrides));
}

/**
 * Mark the description unread: the source was not usable, so knowledge/job-match-rules.md#7-decision-trace-contract records `unknown` on both AI axes.
 * Every case that turns a base input into a blocked or closed one goes through here, because the
 * schema refuses a silent `none` on a page nobody read.
 */
export function markUnread(input, accessOutcome, accessReason) {
  input.source.accessOutcome = accessOutcome;
  if (accessReason !== undefined) input.source.accessReason = accessReason;
  input.role.observedTools = []; input.role.observedLanguages = [];
  input.role.observedLanguages = [];
  input.role.ai = { product: "unknown", work: "unknown" };
  input.role.evidence.aiProduct = null;
  input.role.evidence.aiWork = null;
  return input;
}

function terminalCase(family, language, feasibility, automation, seniority, compensation) {
  const input = baseInput();
  input.role.family = family;
  input.role.language = language;
  input.role.automation = automation;
  input.role.seniority = seniority;
  if (feasibility === "explicit") {
    Object.assign(input.offers[0], {
      contractorEligibility: "ineligible",
      relocationSupport: "unavailable",
      residenceRestriction: "incompatible",
      sponsorship: "unavailable",
      workAuthorization: "explicitly_ineligible",
    });
  } else if (feasibility === "mobility") {
    Object.assign(input.offers[0], {
      companyRegion: "WEST",
      compensationMarket: "US",
      contractorEligibility: "ineligible",
      relocationSupport: "unavailable",
      residenceRestriction: "incompatible",
      sponsorship: "unavailable",
      timezoneDistance: "far",
      westRegion: "US_CANADA",
      workAuthorization: "required_existing",
    });
  }
  if (compensation === "below") {
    input.compensation.minimum = 1999999;
    input.compensation.maximum = 1999999;
  }
  // `compensation_too_low` left the vocabulary: a below-floor salary is a low C score and the
  // vacancy stays ranked, so the compensation axis triggers nothing here any more.
  const triggered = [
    [family === "other", "not_qa_or_testing_role"],
    [language === "unsupported", "language_not_supported"],
    [feasibility === "explicit", "explicitly_not_eligible_to_work"],
    [feasibility === "mobility", "mobility_not_feasible"],
    [automation === "manager_only", "manager_role"],
    [automation === "manual_only", "manual_role"],
    [seniority === "junior", "junior_role"],
  ];
  const expected = triggered.find(([active]) => active)?.[1] ?? null;
  // The `mobility` axis closes a Remote path whose every cure the source refuses, so the basis it
  // records is rule 3's own.
  return { expected, input, skipBasis: expected === "mobility_not_feasible" ? "residence_incompatible" : null };
}

const terminalAxes = {
  family: ["qa_testing", "other"],
  language: ["English", "Greek", "unsupported"],
  feasibility: ["clear", "explicit", "mobility"],
  automation: ["primary", "manager_only", "manual_only"],
  seniority: ["senior", "junior"],
  compensation: ["at_floor", "below"],
};

export const terminalCases = [];
for (const family of terminalAxes.family) {
  for (const language of terminalAxes.language) {
    for (const feasibility of terminalAxes.feasibility) {
      for (const automation of terminalAxes.automation) {
        for (const seniority of terminalAxes.seniority) {
          for (const compensation of terminalAxes.compensation) {
            const id = `terminal:${family}:${language}:${feasibility}:${automation}:${seniority}:${compensation}`;
            terminalCases.push({ id, ...terminalCase(family, language, feasibility, automation, seniority, compensation) });
          }
        }
      }
    }
  }
}

const mixedTerminalInput = baseInput();
mixedTerminalInput.offers = [
  baseOffer({
    companyRegion: "WEST",
    compensationMarket: "US",
    contractorEligibility: "ineligible",
    evidenceQuote: "Remote path requires existing US work authorization and has no alternative.",
    relocationSupport: "unavailable",
    residenceRestriction: "incompatible",
    sponsorship: "unavailable",
    timezoneDistance: "far",
    westRegion: "US_CANADA",
    workAuthorization: "required_existing",
  }),
  baseOffer({
    evidenceQuote: "Candidate is explicitly ineligible for this employment path.",
    workAuthorization: "explicitly_ineligible",
    workFormat: "Hybrid",
  }),
];
terminalCases.push({
  evidenceQuote: "Candidate is explicitly ineligible for this employment path.",
  expected: "explicitly_not_eligible_to_work",
  id: "terminal:multi-offer:explicit-over-mobility",
  input: mixedTerminalInput,
});

// Hard-SKIP rule 4 and its precedence over `mobility_not_feasible`: an excluded destination holds
// whatever the listing says about visas, so it is the more informative code.
const maltaOnSite = baseInput();
maltaOnSite.compensation = null;
maltaOnSite.offers = [baseOffer({
  companyRegion: "OTHER",
  engagementPath: null,
  evidenceQuote: "On-site in Valletta, Malta",
  relocationCountry: "Malta",
  relocationCountryCode: "MT",
  relocationSupport: "available",
  workAuthorization: "unknown",
  workFormat: "On-site",
})];
terminalCases.push({
  evidenceQuote: "On-site in Valletta, Malta",
  expected: "destination_excluded",
  id: "terminal:malta:on-site",
  input: maltaOnSite,
});

const maltaRemoteResidence = baseInput();
maltaRemoteResidence.compensation = null;
maltaRemoteResidence.offers = [baseOffer({
  companyRegion: "OTHER",
  contractorEligibility: "eligible",
  engagementPath: null,
  evidenceQuote: "Remote, but you must reside in Malta",
  residenceRequirementCountry: "Malta",
  residenceRequirementCountryCode: "MT",
  residenceRestriction: "incompatible",
  workAuthorization: "unknown",
})];
terminalCases.push({
  evidenceQuote: "Remote, but you must reside in Malta",
  expected: "destination_excluded",
  id: "terminal:malta:remote-residence-requirement",
  input: maltaRemoteResidence,
});

const maltaOverMobility = baseInput();
maltaOverMobility.compensation = null;
maltaOverMobility.offers = [baseOffer({
  companyRegion: "WEST",
  compensationMarket: "other",
  engagementPath: null,
  evidenceQuote: "On-site in Malta; we do not sponsor visas",
  relocationCountry: "Malta",
  relocationCountryCode: "MT",
  sponsorship: "unavailable",
  westRegion: "EU_UK",
  workAuthorization: "required_existing",
  workFormat: "On-site",
})];
terminalCases.push({
  evidenceQuote: "On-site in Malta; we do not sponsor visas",
  expected: "destination_excluded",
  id: "terminal:malta:outranks-mobility",
  input: maltaOverMobility,
});

// A Maltese company offering remote work demands no move and is scored normally: rule 4 keys on the
// requirement, and a remote path states none even when the country is named.
const maltaRemoteCompany = baseInput();
maltaRemoteCompany.offers = [baseOffer({
  companyRegion: "OTHER",
  engagementPath: "outside_home_contractor",
  evidenceQuote: "Fully remote role at our Valletta-based company",
  relocationCountry: "Malta",
  relocationCountryCode: "MT",
  timezone: "tz_any",
})];
maltaRemoteCompany.compensation = null;
terminalCases.push({
  expected: null,
  id: "terminal:malta:remote-company-scored",
  input: maltaRemoteCompany,
});

// A variant spelling of an excluded destination is still that destination.
const maltaFormalSpelling = baseInput();
maltaFormalSpelling.compensation = null;
maltaFormalSpelling.offers = [baseOffer({
  companyRegion: "WEST",
  compensationMarket: "other",
  engagementPath: null,
  evidenceQuote: "On-site, Republic of Malta",
  relocationCountry: "Republic of Malta",
  relocationCountryCode: "MT",
  relocationSupport: "available",
  sponsorship: "unknown",
  westRegion: "EU_UK",
  workAuthorization: "unknown",
  workFormat: "On-site",
})];
terminalCases.push({
  destination: "Republic of Malta",
  evidenceQuote: "On-site, Republic of Malta",
  expected: "destination_excluded",
  id: "terminal:malta:formal-spelling",
  input: maltaFormalSpelling,
});

// Rule 4 may not depend on the spelling either. These are the two shapes task 39 measured as silent
// terminal flips - a city written into the country field, and the country with the city in
// parentheses - plus a name in another language, of the kind the deleted alias list carried and no
// list can cover in general. Each pins the exclusion through the code while the trace keeps the
// listing's own wording.
for (const [name, country] of [
  ["city-and-country", "Valletta, Malta"],
  ["country-and-city", "Malta (Valletta)"],
  ["greek-spelling", "Μάλτα"],
]) {
  const input = baseInput();
  input.compensation = null;
  input.offers = [baseOffer({
    companyRegion: "OTHER",
    engagementPath: null,
    evidenceQuote: `On-site, ${country}`,
    relocationCountry: country,
    relocationCountryCode: "MT",
    relocationSupport: "available",
    workAuthorization: "unknown",
    workFormat: "On-site",
  })];
  terminalCases.push({
    destination: country,
    evidenceQuote: `On-site, ${country}`,
    expected: "destination_excluded",
    id: `terminal:malta:spelling:${name}`,
    input,
  });
}

// The other half of rule 4 carries a spelling of its own, and is read on every format.
const maltaResidenceSpelling = baseInput();
maltaResidenceSpelling.compensation = null;
maltaResidenceSpelling.offers = [baseOffer({
  companyRegion: "OTHER",
  engagementPath: null,
  evidenceQuote: "Εξ αποστάσεως, αλλά διαμονή — Μάλτα (Βαλέτα)",
  residenceRequirementCountry: "Μάλτα (Βαλέτα)",
  residenceRequirementCountryCode: "MT",
  residenceRestriction: "incompatible",
  workAuthorization: "unknown",
})];
terminalCases.push({
  evidenceQuote: "Εξ αποστάσεως, αλλά διαμονή — Μάλτα (Βαλέτα)",
  expected: "destination_excluded",
  id: "terminal:malta:spelling:residence-requirement",
  input: maltaResidenceSpelling,
});

// And neither half may fire on the name alone. An uncoded Malta-shaped name is undecidable, so the
// exclusion does not fire - the reading that used to be a string match is now the code's alone.
const maltaUncodedDestination = baseInput();
maltaUncodedDestination.compensation = null;
maltaUncodedDestination.offers = [baseOffer({
  companyRegion: "OTHER",
  engagementPath: null,
  evidenceQuote: "On-site, Valletta",
  relocationCountry: "Valletta, Malta",
  relocationSupport: "available",
  workAuthorization: "unknown",
  workFormat: "On-site",
})];
terminalCases.push({
  destination: "Valletta, Malta",
  expected: null,
  id: "terminal:malta:uncoded-name-does-not-exclude",
  input: maltaUncodedDestination,
});

const maltaUncodedResidence = baseInput();
maltaUncodedResidence.compensation = null;
maltaUncodedResidence.offers = [baseOffer({
  companyRegion: "OTHER",
  engagementPath: null,
  evidenceQuote: "Εξ αποστάσεως, αλλά διαμονή — Μάλτα",
  residenceRequirementCountry: "Μάλτα",
  residenceRestriction: "incompatible",
  workAuthorization: "unknown",
})];
terminalCases.push({
  expected: null,
  id: "terminal:malta:uncoded-residence-does-not-exclude",
  input: maltaUncodedResidence,
});

// A vacancy the source marks closed is not assessed for anything else (knowledge/job-match-rules.md#22-accepted-triage-decision-record), not even for the
// role-family gate that heads the precedence list.
const closedAndNotQa = markUnread(baseInput(), "closed", "Vacancy closed banner");
closedAndNotQa.source.evidenceQuote = "This job is no longer accepting applications";
closedAndNotQa.role.family = "other";
closedAndNotQa.role.evidence.role = "Head Chef";
terminalCases.push({
  evidenceQuote: "This job is no longer accepting applications",
  expected: "vacancy_unavailable",
  id: "terminal:closed:outranks-not-qa",
  input: closedAndNotQa,
});

/** Closing signs of knowledge/job-match-rules.md#22-accepted-triage-decision-record, one fixture per sign plus the openings that neutralize them. */
const mobilitySkipCases = [
  ["authorization-required-existing", {
    companyRegion: "OTHER",
    engagementPath: null,
    evidenceQuote: "On-site in Shanghai; applicants must already hold a Chinese work permit",
    relocationCountry: "China",
    relocationCountryCode: "CN",
    workAuthorization: "required_existing",
    workFormat: "On-site",
  }, "authorization_required_existing"],
  ["sponsorship-unavailable", {
    companyRegion: "OTHER",
    engagementPath: null,
    evidenceQuote: "Hybrid in Mauritius; we do not sponsor work visas",
    relocationCountry: "Mauritius",
    relocationCountryCode: "MU",
    sponsorship: "unavailable",
    workAuthorization: "unknown",
    workFormat: "Hybrid",
  }, "sponsorship_unavailable"],
  ["west-silence", {
    companyRegion: "WEST",
    compensationMarket: "other",
    engagementPath: null,
    evidenceQuote: "On-site in Berlin",
    relocationCountry: "Germany",
    relocationCountryCode: "DE",
    sponsorship: "unknown",
    westRegion: "EU_UK",
    workAuthorization: "unknown",
    workFormat: "On-site",
  }, "west_relocation_authorization_silent"],
];
for (const [name, overrides, basis] of mobilitySkipCases) {
  const input = baseInput();
  input.compensation = null;
  input.offers = [baseOffer(overrides)];
  terminalCases.push({
    evidenceQuote: overrides.evidenceQuote,
    expected: "mobility_not_feasible",
    id: `terminal:mobility:${name}`,
    input,
    skipBasis: basis,
  });
}

// Rule 3 on a Remote path keeps its structure: every cure explicitly refused closes it, and the
// basis it records is its own.
const remoteResidenceSkip = baseInput();
remoteResidenceSkip.compensation = null;
remoteResidenceSkip.offers = [baseOffer({
  companyRegion: "WEST",
  compensationMarket: "US",
  contractorEligibility: "ineligible",
  engagementPath: null,
  evidenceQuote: "Remote, US residents only; no contractors, no relocation, existing authorization required",
  relocationSupport: "unavailable",
  residenceRestriction: "incompatible",
  sponsorship: "unavailable",
  timezoneDistance: "far",
  westRegion: "US_CANADA",
  workAuthorization: "required_existing",
})];
terminalCases.push({
  evidenceQuote: "Remote, US residents only; no contractors, no relocation, existing authorization required",
  expected: "mobility_not_feasible",
  id: "terminal:mobility:remote-residence-refused",
  input: remoteResidenceSkip,
  skipBasis: "residence_incompatible",
});

// Signs 1 and 2 reach only a destination outside the feasible-residence set: a Buenos Aires office
// demanding an Argentine permit refuses the candidate nothing they do not already hold.
const insideSetOnSite = baseInput();
insideSetOnSite.compensation = null;
insideSetOnSite.offers = [baseOffer({
  companyRegion: "HOME",
  engagementPath: null,
  evidenceQuote: "Office in Buenos Aires; an Argentine work permit is required",
  relocationCountry: "Argentina",
  relocationCountryCode: "AR",
  sponsorship: "unavailable",
  workAuthorization: "required_existing",
  workFormat: "On-site",
})];
terminalCases.push({ expected: null, id: "terminal:mobility:inside-set-not-closed", input: insideSetOnSite });

// An undecidable destination never closes a door, and non-WEST silence is not sign 3.
const undecidableDestination = baseInput();
undecidableDestination.compensation = null;
undecidableDestination.offers = [baseOffer({
  companyRegion: "OTHER",
  engagementPath: null,
  evidenceQuote: "On-site at one of our regional offices",
  sponsorship: "unknown",
  workAuthorization: "unknown",
  workFormat: "On-site",
})];
terminalCases.push({ expected: null, id: "terminal:mobility:undecidable-destination", input: undecidableDestination });

// Membership is what scopes signs 1 and 2, and it is answered by the region only where every
// country of that region shares an answer. `OTHER` leaves it open, so no sign fires; `HOME` answers
// "inside the set", so none fires there either - this time without a country to read.
for (const [name, region, overrides, extras] of [
  ["undecidable-authorization", "OTHER", { workAuthorization: "required_existing" }, {}],
  ["undecidable-sponsorship", "OTHER", { sponsorship: "unavailable", workAuthorization: "unknown" }, {}],
  ["region-answers-inside-set", "HOME", { workAuthorization: "required_existing" }, {}],
]) {
  const input = baseInput();
  input.compensation = null;
  input.offers = [baseOffer({
    companyRegion: region,
    engagementPath: null,
    evidenceQuote: "On-site at one of our offices; no country is named",
    workFormat: "On-site",
    ...overrides,
    ...extras,
  })];
  terminalCases.push({ expected: null, id: `terminal:mobility:${name}`, input });
}

// An identified country answers membership by itself, whatever the listing's spelling: the code is
// what carries a set member written another way back inside the set, and a country outside it closes
// the door whether or not the tier table prices it. The last row is the case this family exists for:
// a city written into the country field used to read as a country outside the set and skip the one
// destination knowledge/job-match-rules.md#22-accepted-triage-decision-record promises can never close.
for (const [name, region, country, code, expected] of [
  ["spelling-keeps-a-set-member-inside", "HOME", "Ουρουγουάη", "UY", null],
  ["spelling-keeps-a-traditional-name-inside", "OTHER", "Παραγουάη", "PY", null],
  ["spelling-keeps-a-formal-name-inside", "OTHER", "Republic of Costa Rica", "CR", null],
  ["named-non-member-closes", "OTHER", "Vietnam", "VN", "mobility_not_feasible"],
  ["named-non-member-closes-west", "WEST", "Portugal", "PT", "mobility_not_feasible"],
  ["city-and-country-keeps-a-set-member-inside", "OTHER", "San José, Costa Rica", "CR", null],
  ["unresolved-name-decides-nothing", "WEST", "Ruritania", null, null],
]) {
  const input = baseInput();
  input.compensation = null;
  input.offers = [baseOffer({
    companyRegion: region,
    engagementPath: null,
    evidenceQuote: "On-site; applicants must already hold a local work permit",
    relocationCountry: country,
    relocationCountryCode: code,
    westRegion: region === "WEST" ? "EU_UK" : null,
    workAuthorization: "required_existing",
    workFormat: "On-site",
  })];
  terminalCases.push({
    destination: country,
    expected,
    id: `terminal:mobility:${name}`,
    input,
    ...(expected === null ? {} : { skipBasis: "authorization_required_existing" }),
  });
}

// Rule 3 closes a Remote path only with all four refusals; dropping any one of them scores it.
for (const [name, overrides] of [
  ["contractor", { contractorEligibility: "unknown" }],
  ["authorization", { workAuthorization: "unknown" }],
  ["sponsorship", { sponsorship: "unknown" }],
  ["relocation-support", { relocationSupport: "unknown" }],
]) {
  const input = baseInput();
  input.compensation = null;
  input.offers = [baseOffer({
    companyRegion: "WEST",
    compensationMarket: "US",
    contractorEligibility: "ineligible",
    engagementPath: null,
    evidenceQuote: "Remote, US residents only",
    relocationSupport: "unavailable",
    residenceRestriction: "incompatible",
    sponsorship: "unavailable",
    timezoneDistance: "far",
    westRegion: "US_CANADA",
    workAuthorization: "required_existing",
    ...overrides,
  })];
  terminalCases.push({ expected: null, id: `terminal:mobility:remote-residence-open-${name}`, input });
}

// Each opening sign alone reopens a door closing sign 1 shut.
const openingSigns = [
  ["sponsorship", { sponsorship: "available" }],
  ["relocation-support", { relocationSupport: "available" }],
  ["authorization", { workAuthorization: "eligible" }],
];
for (const [name, overrides] of openingSigns) {
  const input = baseInput();
  input.compensation = null;
  input.offers = [baseOffer({
    companyRegion: "OTHER",
    engagementPath: null,
    evidenceQuote: "On-site in Shanghai; applicants must already hold a Chinese work permit",
    relocationCountry: "China",
    relocationCountryCode: "CN",
    workAuthorization: "required_existing",
    workFormat: "On-site",
    ...overrides,
  })];
  terminalCases.push({ expected: null, id: `terminal:mobility:opened-by-${name}`, input });
}

// The residual knowledge/job-match-rules.md#22-accepted-triage-decision-record records rather than closes: an on-site listing demanding that the candidate
// already live in the destination is scored, not skipped. Measured on this synthetic offer at
// EVALUATED 61 `consider`; backlog task 38 owns the decision to close it.
export const onsiteResidenceResidual = (() => {
  const input = baseInput();
  input.compensation = null;
  input.role.automation = "major";
  input.role.observedTools = [
    baseObservedTool({ language: "typescript_javascript", name: "Playwright", requirement: "required" }),
  ];
  input.offers = [baseOffer({
    companyRegion: "OTHER",
    engagementPath: null,
    evidenceQuote: "MUST BE currently based in Mauritius",
    relocationCountry: "Mauritius",
    relocationCountryCode: "MU",
    residenceRequirementCountry: "Mauritius",
    residenceRequirementCountryCode: "MU",
    residenceRestriction: "incompatible",
    sponsorship: "unknown",
    workAuthorization: "unknown",
    workFormat: "On-site",
  })];
  return { expected: { bucket: "consider", decision: "EVALUATED", matchPercent: 63 }, id: "residual:onsite-residence-requirement", input };
})();

// knowledge/job-match-rules.md#31-m--mobility--work-feasibility branch B prices `none` and `compatible` alike and everything else - silence and a curable
// `incompatible` restriction - at the "otherwise" value. All four values are exercised, because the
// record added a branch for the curable `incompatible` case that had none before.
const westExpectations = {
  US_CANADA: {
    tz_any: { none: 25, compatible: 25, incompatible: 20, unknown: 20 },
    tz_home: { none: 25, compatible: 25, incompatible: 20, unknown: 20 },
    tz_local: { none: 15, compatible: 15, incompatible: 10, unknown: 10 },
    tz_unknown: { none: 20, compatible: 20, incompatible: 10, unknown: 10 },
  },
  EU_UK: {
    tz_any: { none: 25, compatible: 25, incompatible: 20, unknown: 20 },
    tz_home: { none: 25, compatible: 25, incompatible: 20, unknown: 20 },
    tz_local: { none: 25, compatible: 25, incompatible: 20, unknown: 20 },
    tz_unknown: { none: 25, compatible: 25, incompatible: 15, unknown: 15 },
  },
};

export const mobilityCases = [];
for (const [westRegion, timezones] of Object.entries(westExpectations)) {
  for (const [timezone, restrictions] of Object.entries(timezones)) {
    for (const [residenceRestriction, expected] of Object.entries(restrictions)) {
      const input = baseInput();
      input.offers[0] = baseOffer({
        companyRegion: "WEST",
        compensationMarket: westRegion === "US_CANADA" ? "US" : "UK",
        engagementPath: "outside_home_contractor",
        residenceRestriction,
        timezone,
        timezoneDistance: "far",
        westRegion,
      });
      input.compensation = null;
      mobilityCases.push({
        expected,
        // Silence about residence is priced below a satisfied restriction, and the trace says so.
        gaps: residenceRestriction === "unknown" ? ["gap:residence_restriction_absent"] : [],
        id: `mobility:west:${westRegion}:${timezone}:${residenceRestriction}`,
        input,
      });
    }
  }
}

for (const [region, distance, timezone, expected] of [
  ["OTHER", "near", "tz_any", 25],
  ["OTHER", "near", "tz_home", 25],
  ["OTHER", "near", "tz_local", 25],
  ["OTHER", "near", "tz_unknown", 25],
  ["OTHER", "far", "tz_any", 25],
  ["OTHER", "far", "tz_home", 25],
  ["OTHER", "far", "tz_local", 5],
  ["OTHER", "far", "tz_unknown", 15],
  ["UNKNOWN", "unknown", "tz_any", 25],
  ["UNKNOWN", "unknown", "tz_home", 25],
  ["UNKNOWN", "unknown", "tz_local", 20],
  ["UNKNOWN", "unknown", "tz_unknown", 20],
  ["HOME", "near", "tz_any", 25],
  ["HOME", "near", "tz_local", 25],
  ["HOME", "far", "tz_local", 25],
  ["HOME", "unknown", "tz_unknown", 25],
]) {
  const input = baseInput();
  input.offers[0] = baseOffer({
    companyRegion: region,
    engagementPath: region === "HOME" ? "home_employment" : "outside_home_contractor",
    timezone,
    timezoneDistance: distance,
  });
  input.compensation = null;
  mobilityCases.push({ expected, gaps: [], id: `mobility:${region}:${distance}:${timezone}`, input });
}

// The one remote combination no branch of knowledge/job-match-rules.md#31-m--mobility--work-feasibility resolves takes the M middle with its annotation.
{
  const input = baseInput();
  input.offers[0] = baseOffer({
    companyRegion: "OTHER",
    engagementPath: "outside_home_contractor",
    timezone: "tz_unknown",
    timezoneDistance: "unknown",
  });
  input.compensation = null;
  mobilityCases.push({
    expected: 15,
    gaps: ["gap:mobility_branch_unresolved"],
    id: "mobility:OTHER:unknown:tz_unknown",
    input,
  });
}

// The tier table of knowledge/job-match-rules.md#31-m--mobility--work-feasibility branch D, one row per country the rubric prints. The code is what the
// scorer reads and the name is what the listing carried, so a row exercises both halves at once.
const relocationScores = [
  ["NZ", "New Zealand", 20],
  ["BN", "Brunei", 20],
  ["MO", "Macao", 20],
  ["MV", "Maldives", 20],
  ["HK", "Hong Kong", 20],
  ["TW", "Taiwan", 20],
  ["MU", "Mauritius", 20],
  ["CN", "China", 20],
  ["ID", "Indonesia", 20],
  ["ZA", "South Africa", 20],
  ["SC", "Seychelles", 20],
  ["DO", "Dominican Republic", 10],
  ["PA", "Panama", 10],
  ["CR", "Costa Rica", 10],
  ["CO", "Colombia", 10],
  ["MX", "Mexico", 10],
  ["CL", "Chile", 0],
  ["EC", "Ecuador", 0],
  ["UY", "Uruguay", 0],
  ["BO", "Bolivia", 0],
  ["PY", "Paraguay", 0],
  ["GY", "Guyana", 0],
  ["AR", "Argentina", 0],
  ["SR", "Suriname", 0],
  ["BZ", "Belize", 0],
  ["PE", "Peru", 0],
];

for (const [code, country, countryScore] of relocationScores) {
  for (const supported of [false, true]) {
    const input = baseInput();
    input.offers[0] = baseOffer({
      companyRegion: "OTHER",
      contractorEligibility: "unknown",
      engagementPath: "home_employment",
      relocationCountry: country,
      relocationCountryCode: code,
      relocationSupport: supported ? "available" : "unavailable",
      // Silence rather than refusal: a refused sponsorship is closing sign 2 for every destination
      // outside the feasible-residence set, and this family measures branch D instead.
      sponsorship: "unknown",
      workAuthorization: "unknown",
      workFormat: "Hybrid",
    });
    mobilityCases.push({
      destination: country,
      expected: Math.min(25, countryScore + (supported ? 5 : 0)),
      gaps: [],
      id: `mobility:relocation:${country}:${supported ? "support" : "no_support"}`,
      input,
    });
  }
}

// Branch D's three destination readings: a named WEST country, a named country outside the table,
// and no country at all, where only a region whose members share a tier can answer.
{
  const named = baseInput();
  named.compensation = null;
  named.offers[0] = baseOffer({
    companyRegion: "WEST",
    compensationMarket: "other",
    engagementPath: null,
    evidenceQuote: "On-site in Amsterdam, relocation package provided",
    relocationCountry: "Netherlands",
    relocationCountryCode: "NL",
    relocationSupport: "available",
    sponsorship: "unknown",
    westRegion: "EU_UK",
    workAuthorization: "unknown",
    workFormat: "On-site",
  });
  mobilityCases.push({ expected: 25, gaps: [], id: "mobility:relocation:named-west-country", input: named });

  const westWithoutBonus = baseInput();
  westWithoutBonus.compensation = null;
  westWithoutBonus.offers[0] = baseOffer({
    companyRegion: "WEST",
    compensationMarket: "other",
    engagementPath: null,
    evidenceQuote: "On-site in Berlin; EU work authorization already held",
    relocationCountry: "Germany",
    relocationCountryCode: "DE",
    relocationSupport: "unknown",
    sponsorship: "unknown",
    westRegion: "EU_UK",
    workAuthorization: "eligible",
    workFormat: "On-site",
  });
  mobilityCases.push({
    expected: 20,
    gaps: [],
    id: "mobility:relocation:west-tier-without-bonus",
    input: westWithoutBonus,
  });

  const unlisted = baseInput();
  unlisted.compensation = null;
  unlisted.offers[0] = baseOffer({
    companyRegion: "OTHER",
    engagementPath: null,
    evidenceQuote: "On-site in Hanoi",
    relocationCountry: "Vietnam",
    relocationCountryCode: "VN",
    relocationSupport: "available",
    workAuthorization: "unknown",
    workFormat: "On-site",
  });
  mobilityCases.push({
    expected: 15,
    gaps: ["gap:relocation_country_unlisted"],
    id: "mobility:relocation:unlisted-country",
    input: unlisted,
  });

  for (const [region, expected, extras] of [
    ["WEST", 25, { compensationMarket: "other", westRegion: "EU_UK" }],
    ["HOME", 5, {}],
    ["OTHER", 15, {}],
    ["UNKNOWN", 15, {}],
  ]) {
    const input = baseInput();
    input.compensation = null;
    input.offers[0] = baseOffer({
      companyRegion: region,
      engagementPath: null,
      evidenceQuote: "Hybrid at one of our offices, relocation supported",
      relocationSupport: "available",
      sponsorship: "unknown",
      workAuthorization: "unknown",
      workFormat: "Hybrid",
      ...extras,
    });
    mobilityCases.push({
      expected,
      gaps: ["gap:relocation_country_absent"],
      id: `mobility:relocation:unnamed:${region}`,
      input,
    });
  }
}

// Branch A is scoped to WEST: the same explicit sponsorship outside it is scored by its own branch.
for (const [region, expected, extras] of [
  ["OTHER", 25, { relocationCountry: "China", relocationCountryCode: "CN", workFormat: "Hybrid" }],
  ["HOME", 5, { relocationCountry: "Argentina", relocationCountryCode: "AR", workFormat: "On-site" }],
]) {
  const input = baseInput();
  input.compensation = null;
  input.offers[0] = baseOffer({
    companyRegion: region,
    engagementPath: null,
    evidenceQuote: "Relocation with visa sponsorship provided",
    relocationSupport: "unknown",
    sponsorship: "available",
    workAuthorization: "unknown",
    ...extras,
  });
  mobilityCases.push({ expected, gaps: [], id: `mobility:sponsorship:${region}:relocation`, input });
}

// A country spelling the listing writes its own way is the same destination: the tier, and with it
// the terminal reading of membership, may not depend on the spelling. What carries the spelling
// across is the code, so the family covers the three shapes an extractor actually meets - an
// abbreviation, a formal name, and a city written into the country field.
for (const [name, country, code, region, expected] of [
  ["nz-abbreviation", "NZ", "NZ", "OTHER", 25],
  ["formal-argentina", "Argentine Republic", "AR", "HOME", 5],
  ["city-and-country", "Shanghai, China", "CN", "OTHER", 25],
  ["country-and-city", "New Zealand (Auckland)", "NZ", "OTHER", 25],
  ["greek-spelling", "Νέα Ζηλανδία", "NZ", "OTHER", 25],
]) {
  const input = baseInput();
  input.compensation = null;
  input.offers[0] = baseOffer({
    companyRegion: region,
    engagementPath: null,
    evidenceQuote: "On-site, relocation supported",
    relocationCountry: country,
    relocationCountryCode: code,
    relocationSupport: "available",
    workAuthorization: "unknown",
    workFormat: "On-site",
  });
  // The name is asserted, not only the score: without it these rows would pass with no country name
  // at all, since every reading keys on the code. What acceptance asks is that the spelling reach
  // the same decision *and* survive into knowledge/job-match-rules.md#7-decision-trace-contract verbatim.
  mobilityCases.push({
    destination: country,
    expected,
    gaps: [],
    id: `mobility:relocation:spelling:${name}`,
    input,
  });
}

// A name nobody could identify is not a country outside the set and not an unnamed destination:
// it takes the relocation lane's middle with its own annotation, and the region does not price it.
for (const [name, region, extras] of [
  ["other", "OTHER", {}],
  ["west", "WEST", { westRegion: "EU_UK" }],
]) {
  const input = baseInput();
  input.compensation = null;
  input.offers[0] = baseOffer({
    companyRegion: region,
    engagementPath: null,
    evidenceQuote: "On-site at our Ruritanian office, relocation supported",
    relocationCountry: "Ruritania",
    relocationSupport: "available",
    workAuthorization: "unknown",
    workFormat: "On-site",
    ...extras,
  });
  mobilityCases.push({
    destination: "Ruritania",
    expected: 15,
    gaps: ["gap:relocation_country_unresolved"],
    id: `mobility:relocation:unresolved:${name}`,
    input,
  });
}

// An unidentified destination is undecidable on every branch, so it is recorded on every branch.
// Branch A resolves before the tier is ever consulted, and rule 4's residence half is read on a
// Remote path that reaches no relocation branch at all: both used to be scored in silence.
{
  const branchA = baseInput();
  branchA.compensation = null;
  branchA.offers[0] = baseOffer({
    companyRegion: "WEST",
    compensationMarket: "other",
    engagementPath: null,
    evidenceQuote: "On-site, Μάλτα (Βαλέτα), visa sponsorship provided",
    relocationCountry: "Μάλτα (Βαλέτα)",
    relocationSupport: "available",
    sponsorship: "available",
    westRegion: "EU_UK",
    workAuthorization: "unknown",
    workFormat: "On-site",
  });
  mobilityCases.push({
    destination: "Μάλτα (Βαλέτα)",
    expected: 25,
    gaps: ["gap:relocation_country_unresolved"],
    id: "mobility:relocation:unresolved:branch-a",
    input: branchA,
  });

  const remoteResidence = baseInput();
  remoteResidence.compensation = null;
  remoteResidence.offers[0] = baseOffer({
    companyRegion: "OTHER",
    engagementPath: null,
    evidenceQuote: "Εξ αποστάσεως, αλλά διαμονή — Μάλτα",
    residenceRequirementCountry: "Μάλτα",
    residenceRestriction: "incompatible",
    timezone: "tz_any",
    workAuthorization: "unknown",
  });
  mobilityCases.push({
    destination: null,
    expected: 25,
    gaps: ["gap:residence_requirement_country_unresolved"],
    id: "mobility:residence-requirement:unresolved:remote",
    input: remoteResidence,
  });
}

// The annotation is scoped to the formats that read the destination. A Remote path reads no
// relocation country at all - no rule of knowledge/job-match-rules.md#31-m--mobility--work-feasibility or knowledge/job-match-rules.md#22-accepted-triage-decision-record consults it there - so an unidentified one
// says nothing and is not annotated. The residence requirement is the opposite case and is covered
// by `mobility:residence-requirement:unresolved:remote` above: rule 4 reads it on every format.
{
  const input = baseInput();
  input.compensation = null;
  input.offers[0] = baseOffer({
    companyRegion: "OTHER",
    engagementPath: "outside_home_contractor",
    evidenceQuote: "Remote; our head office is in Ruritania",
    relocationCountry: "Ruritania",
    timezone: "tz_any",
    workFormat: "Remote",
  });
  mobilityCases.push({
    destination: "Ruritania",
    expected: 25,
    gaps: [],
    id: "mobility:relocation:unresolved:remote-reads-no-destination",
    input,
  });
}

for (const workFormat of ["Remote", "Hybrid", "On-site"]) {
  const input = baseInput();
  input.offers[0] = baseOffer({
    companyRegion: "WEST",
    compensationMarket: "UK",
    contractorEligibility: "unknown",
    engagementPath: "outside_home_contractor",
    relocationCountry: workFormat === "Remote" ? null : "United Kingdom",
    relocationCountryCode: workFormat === "Remote" ? null : "GB",
    residenceRestriction: "unknown",
    sponsorship: "available",
    timezoneDistance: "far",
    westRegion: "EU_UK",
    workAuthorization: "unknown",
    workFormat,
  });
  input.compensation = null;
  mobilityCases.push({ expected: 25, gaps: [], id: `mobility:sponsorship:WEST:${workFormat}`, input });
}

// The M middle itself: nothing observed at all, and an observed but unscoreable format.
{
  const nothing = baseInput();
  nothing.compensation = null;
  nothing.offers = [];
  mobilityCases.push({
    expected: 15,
    gaps: ["gap:work_format_absent", "gap:company_region_absent"],
    id: "mobility:middle:no-offer-observed",
    input: nothing,
  });

  const unknownFormat = baseInput();
  unknownFormat.compensation = null;
  unknownFormat.offers = [baseOffer({
    companyRegion: "UNKNOWN",
    engagementPath: null,
    evidenceQuote: "Work format is not stated",
    workFormat: "Unknown",
  })];
  mobilityCases.push({
    expected: 15,
    gaps: ["gap:mobility_branch_unresolved"],
    id: "mobility:middle:unknown-format",
    input: unknownFormat,
  });
}

function salary({ amount, basis = "net", currency = "ARS", maximum = amount, period = "monthly" }) {
  return {
    basis,
    currency,
    evidenceQuote: `${amount}-${maximum} ${currency} ${basis} ${period}`,
    kind: amount === maximum ? "value" : "range",
    maximum,
    minimum: amount,
    period,
  };
}

function relocationOffer(overrides = {}) {
  return baseOffer({
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
    ...overrides,
  });
}

/**
 * A remote WEST listing that published a pay range and did not say gross or net - the shape knowledge/job-match-rules.md#22-accepted-triage-decision-record's
 * advertised-basis reading is about. `compensationMarket` is where the posting is placed, never the
 * currency the figure is quoted in.
 */
function advertisedOffer(overrides = {}) {
  return baseOffer({
    companyRegion: "WEST",
    compensationMarket: "US",
    engagementPath: "outside_home_contractor",
    evidenceQuote: "Fully remote; base pay range published without a tax basis",
    westRegion: "US_CANADA",
    workFormat: "Remote",
    ...overrides,
  });
}

function compensationCase(id, configure, expected) {
  const input = baseInput();
  configure(input);
  return { expected, id: `compensation:${id}`, input };
}

const ADVERTISED = Object.freeze(["assumption:compensation.basis_advertised_gross"]);

export const compensationCases = [
  compensationCase("home-at-floor", (input) => { input.compensation = salary({ amount: 2000000 }); }, { decision: "EVALUATED", score: 15 }),
  compensationCase("home-range-above", (input) => { input.compensation = salary({ amount: 2000000, maximum: 3000000 }); }, { decision: "EVALUATED", score: 15 }),
  compensationCase("home-crossing", (input) => { input.compensation = salary({ amount: 1999999, maximum: 2000001 }); }, {
    assumptions: ["assumption:compensation.range_crosses_floor"],
    decision: "EVALUATED",
    score: 15,
  }),
  // The removed skip, replaced by the knowledge/job-match-rules.md#32-c--compensation--contract-fit curve: five ratios, one per band, plus its boundaries.
  ...[
    [1999999, 4], [1800000, 4], [1799999, 3], [1600000, 3], [1599999, 2], [1400000, 2],
    [1399999, 1], [1000000, 1], [999999, 0], [1, 0],
  ].map(([amount, score]) => compensationCase(`below-floor-${amount}`, (input) => {
    input.compensation = salary({ amount });
  }, { decision: "EVALUATED", score })),
  compensationCase("below-floor-range-max", (input) => {
    input.compensation = salary({ amount: 700000, maximum: 1600000 });
  }, { decision: "EVALUATED", score: 3 }),
  compensationCase("home-contractor-below", (input) => {
    input.offers[0].engagementPath = "home_contractor";
    input.compensation = salary({ amount: 2000000, basis: "gross" });
  }, { decision: "EVALUATED", score: 3 }),
  compensationCase("home-contractor-at-floor", (input) => {
    input.offers[0].engagementPath = "home_contractor";
    input.compensation = salary({ amount: 2400000, basis: "gross" });
  }, { decision: "EVALUATED", score: 15 }),
  ...[
    [3199.999, 4],
    [3200, 5],
    [3700, 10],
    [4199.999, 14],
    [4200, 15],
    [4700, 25],
    [5199.999, 34],
    [5200, 35],
  ].map(([amount, score]) => compensationCase(`intl-${amount}`, (input) => {
    input.offers[0] = baseOffer({
      companyRegion: "OTHER",
      engagementPath: "outside_home_contractor",
      evidenceQuote: "Fully remote contractor engagement",
    });
    input.compensation = salary({ amount, basis: "gross", currency: "USD" });
  }, { decision: "EVALUATED", score })),
  compensationCase("intl-annual", (input) => {
    input.offers[0].engagementPath = "outside_home_contractor";
    input.compensation = salary({ amount: 38400, basis: "gross", currency: "USD", period: "annual" });
  }, { decision: "EVALUATED", score: 5 }),
  compensationCase("intl-hourly", (input) => {
    input.offers[0].engagementPath = "outside_home_contractor";
    input.compensation = salary({ amount: 18.5, basis: "gross", currency: "USD", period: "hourly" });
  }, { decision: "EVALUATED", score: 5 }),
  compensationCase("basis-mismatch", (input) => { input.compensation = salary({ amount: 2000000, basis: "gross" }); }, {
    decision: "EVALUATED",
    gaps: ["gap:compensation_basis_incomparable"],
    score: 15,
  }),
  compensationCase("basis-unknown", (input) => { input.compensation = salary({ amount: 2000000, basis: "unknown" }); }, {
    decision: "EVALUATED",
    gaps: ["gap:compensation_basis_incomparable"],
    score: 15,
  }),
  compensationCase("period-unknown", (input) => { input.compensation = salary({ amount: 2000000, period: "unknown" }); }, {
    decision: "EVALUATED",
    gaps: ["gap:compensation_period_absent"],
    score: 15,
  }),
  compensationCase("period-and-basis-unknown", (input) => {
    input.compensation = salary({ amount: 2000000, basis: "unknown", period: "unknown" });
  }, {
    decision: "EVALUATED",
    gaps: ["gap:compensation_period_absent", "gap:compensation_basis_incomparable"],
    score: 15,
  }),
  compensationCase("salary-absent", (input) => { input.compensation = null; }, {
    decision: "EVALUATED",
    gaps: ["gap:compensation_absent"],
    score: 15,
  }),
  compensationCase("comparable-usd", (input) => {
    input.offers[0].engagementPath = "comparable_cost_employment";
    input.compensation = salary({ amount: 3200, currency: "USD" });
  }, { decision: "EVALUATED", score: 15 }),
  compensationCase("comparable-chf", (input) => {
    input.offers[0].engagementPath = "comparable_cost_employment";
    input.compensation = salary({ amount: 3200, currency: "CHF" });
  }, { decision: "EVALUATED", score: 15 }),
  compensationCase("comparable-third-currency", (input) => {
    input.offers[0].engagementPath = "comparable_cost_employment";
    input.compensation = salary({ amount: 2560, currency: "GBP" });
    input.fx = { provider: "ECB", rateDate: "2026-08-21", sourceCurrency: "GBP", targetCurrency: "USD", targetPerSource: 1.25 };
  }, {
    assumptions: ["assumption:compensation.floor_currency_fallback"],
    decision: "EVALUATED",
    score: 15,
  }),
  compensationCase("comparable-third-currency-no-fx", (input) => {
    input.offers[0].engagementPath = "comparable_cost_employment";
    input.compensation = salary({ amount: 2560, currency: "GBP" });
  }, {
    assumptions: ["assumption:compensation.floor_currency_fallback"],
    decision: "EVALUATED",
    gaps: ["gap:compensation_fx_unavailable"],
    score: 15,
  }),
  compensationCase("intl-fx", (input) => {
    input.offers[0].engagementPath = "outside_home_contractor";
    input.compensation = salary({ amount: 3360, basis: "gross", currency: "EUR" });
    input.fx = { provider: "ECB", rateDate: "2026-08-21", sourceCurrency: "EUR", targetCurrency: "USD", targetPerSource: 1.25 };
  }, { decision: "EVALUATED", score: 15 }),
  ...[
    ["intl-fx-missing", null],
    ["intl-fx-wrong-provider", { provider: "BCRA", rateDate: "2026-08-21", sourceCurrency: "EUR", targetCurrency: "USD", targetPerSource: 1.25 }],
    ["intl-fx-reversed", { provider: "ECB", rateDate: "2026-08-21", sourceCurrency: "USD", targetCurrency: "EUR", targetPerSource: 0.8 }],
  ].map(([id, fx]) => compensationCase(id, (input) => {
    input.offers[0].engagementPath = "outside_home_contractor";
    input.compensation = salary({ amount: 3360, basis: "gross", currency: "EUR" });
    input.fx = fx;
  }, { decision: "EVALUATED", gaps: ["gap:compensation_fx_unavailable"], score: 15 })),
  compensationCase("home-official-rate", (input) => {
    input.compensation = salary({ amount: 3200, currency: "USD" });
    input.fx = { provider: "BCRA", rateDate: "2026-08-21", sourceCurrency: "USD", targetCurrency: "ARS", targetPerSource: 625 };
  }, { decision: "EVALUATED", score: 15 }),
  // The five predetermined `relocation_floor_missing` outcomes of the 2026-08-18 run: a relocation
  // path with no salary and no override is now scored with the C middle and its annotation.
  compensationCase("relocation-no-salary-no-override", (input) => {
    input.offers[0] = relocationOffer({
      companyRegion: "OTHER",
      compensationMarket: "other",
      evidenceQuote: "On-site in Auckland, relocation package provided",
      relocationCountry: "New Zealand",
      relocationCountryCode: "NZ",
      sponsorship: "unknown",
      westRegion: null,
    });
    input.compensation = null;
  }, { decision: "EVALUATED", gaps: ["gap:compensation_absent"], score: 15 }),
  compensationCase("relocation-other-market", (input) => {
    input.offers[0] = relocationOffer({
      companyRegion: "OTHER",
      compensationMarket: "other",
      evidenceQuote: "On-site in Auckland, relocation package provided",
      relocationCountry: "New Zealand",
      relocationCountryCode: "NZ",
      sponsorship: "unknown",
      westRegion: null,
    });
    input.compensation = salary({ amount: 90000, basis: "gross", currency: "USD", period: "annual" });
  }, { decision: "EVALUATED", gaps: ["gap:compensation_market_curve_absent"], score: 15 }),
  compensationCase("relocation-unknown-market", (input) => {
    input.offers[0] = relocationOffer({ compensationMarket: "unknown" });
    input.compensation = salary({ amount: 90000, basis: "gross", currency: "USD", period: "annual" });
  }, { decision: "EVALUATED", gaps: ["gap:compensation_market_curve_absent"], score: 15 }),
  compensationCase("relocation-below-override", (input) => {
    input.offers[0] = relocationOffer();
    input.compensation = salary({ amount: 60000, basis: "gross", currency: "USD", period: "annual" });
    input.explicitOverride = { amount: 70000, basis: "gross", currency: "USD", period: "annual", scope: "batch" };
  }, { decision: "EVALUATED", score: 3 }),
  compensationCase("relocation-invalid-override-with-salary", (input) => {
    input.offers[0] = relocationOffer();
    input.compensation = salary({ amount: 100000, basis: "gross", currency: "USD", period: "annual" });
    input.explicitOverride = { amount: 70000, basis: "unknown", currency: "USD", period: "annual", scope: "batch" };
  }, { decision: "MANUAL_REVIEW", reviewReason: "compensation_override_undefined" }),
  compensationCase("relocation-invalid-override-no-salary", (input) => {
    input.offers[0] = relocationOffer();
    input.compensation = null;
    input.explicitOverride = { amount: 70000, basis: "unknown", currency: "USD", period: "annual", scope: "batch" };
  }, { decision: "EVALUATED", gaps: ["gap:compensation_absent"], score: 15 }),
  compensationCase("relocation-remote-us", (input) => {
    input.offers[0] = relocationOffer({ relocationCountry: null, relocationCountryCode: null, workFormat: "Remote" });
    input.compensation = salary({ amount: 100000, basis: "gross", currency: "USD", period: "annual" });
  }, { decision: "EVALUATED", score: 24 }),
  // An override may lower the floor below the band knowledge/job-match-rules.md#32-c--compensation--contract-fit A prices, and the scale sends everything
  // below USD 3,200 to the below-floor curve rather than into its own formula.
  ...[
    [2000, 3], [2399, 4], [2400, 4], [2800, 4], [3199, 4], [3200, 5], [3700, 10],
  ].map(([amount, score]) => compensationCase(`intl-override-2400-${amount}`, (input) => {
    input.offers[0] = baseOffer({
      companyRegion: "OTHER",
      engagementPath: "outside_home_contractor",
      evidenceQuote: "Fully remote contractor engagement",
    });
    input.compensation = salary({ amount, basis: "gross", currency: "USD" });
    input.explicitOverride = { amount: 2400, basis: "gross", currency: "USD", period: "monthly", scope: "batch" };
  }, { decision: "EVALUATED", score })),
  // A range crossing the floor scores by the floor value itself, on a lane whose curve actually
  // reads that value: USD 3,200 is the bottom of the international band, worth 5.
  compensationCase("intl-range-crosses-floor", (input) => {
    input.offers[0] = baseOffer({
      companyRegion: "OTHER",
      engagementPath: "outside_home_contractor",
      evidenceQuote: "Fully remote contractor engagement",
    });
    input.compensation = salary({ amount: 2800, basis: "gross", currency: "USD", maximum: 3700 });
  }, {
    assumptions: ["assumption:compensation.range_crosses_floor"],
    decision: "EVALUATED",
    score: 5,
  }),
  compensationCase("intl-override-crossing-below-band", (input) => {
    input.offers[0] = baseOffer({
      companyRegion: "OTHER",
      engagementPath: "outside_home_contractor",
      evidenceQuote: "Fully remote contractor engagement",
    });
    input.compensation = salary({ amount: 2000, basis: "gross", currency: "USD", maximum: 2800 });
    input.explicitOverride = { amount: 2400, basis: "gross", currency: "USD", period: "monthly", scope: "batch" };
  }, {
    assumptions: ["assumption:compensation.range_crosses_floor"],
    decision: "EVALUATED",
    score: 4,
  }),
  compensationCase("comparable-below-floor", (input) => {
    input.offers[0].engagementPath = "comparable_cost_employment";
    input.compensation = salary({ amount: 2400, currency: "USD" });
  }, { decision: "EVALUATED", score: 2 }),
  // The reference band reads the salary the listing published, in its own currency: an override in
  // another currency moves the floor, never the band's input.
  compensationCase("relocation-uk-band-with-usd-override", (input) => {
    input.offers[0] = relocationOffer({
      compensationMarket: "UK",
      relocationCountry: "United Kingdom",
      relocationCountryCode: "GB",
      westRegion: "EU_UK",
    });
    input.compensation = salary({ amount: 80000, basis: "gross", currency: "GBP", period: "annual" });
    input.explicitOverride = { amount: 4200, basis: "gross", currency: "USD", period: "monthly", scope: "batch" };
    input.fx = { provider: "ECB", rateDate: "2026-08-21", sourceCurrency: "GBP", targetCurrency: "USD", targetPerSource: 1.25 };
  }, { decision: "EVALUATED", score: 35 }),
  ...[
    [140000, 35], [139999, 31], [120000, 31], [119999, 24], [95000, 24], [94999, 17],
    [75000, 17], [74999, 10],
  ].map(([amount, score]) => compensationCase(`relocation-us-${amount}`, (input) => {
    input.offers[0] = relocationOffer();
    input.compensation = salary({ amount, basis: "gross", currency: "USD", period: "annual" });
  }, { decision: "EVALUATED", score })),
  ...[
    [80000, 35], [79999, 31], [65000, 31], [64999, 24], [50000, 24], [49999, 17],
    [40000, 17], [39999, 10],
  ].map(([amount, score]) => compensationCase(`relocation-uk-${amount}`, (input) => {
    input.offers[0] = relocationOffer({
      compensationMarket: "UK",
      relocationCountry: "United Kingdom",
      relocationCountryCode: "GB",
      westRegion: "EU_UK",
    });
    input.compensation = salary({ amount, basis: "gross", currency: "GBP", period: "annual" });
  }, { decision: "EVALUATED", score })),
  ...[
    [140000, 35], [139999, 31], [120000, 31], [119999, 24], [95000, 24], [94999, 17],
    [75000, 17], [74999, 10],
  ].map(([amount, score]) => compensationCase(`relocation-canada-${amount}`, (input) => {
    input.offers[0] = relocationOffer({ compensationMarket: "Canada", relocationCountry: "Canada", relocationCountryCode: "CA" });
    input.compensation = salary({ amount, basis: "gross", currency: "CAD", period: "annual" });
  }, { decision: "EVALUATED", score })),
  // knowledge/job-match-rules.md#22-accepted-triage-decision-record "The advertised basis": a figure whose basis the listing did not state is read as gross
  // where the market prints gross and the floor it meets is gross. The reading is a class-C
  // default, it never touches a stated basis, and outside the three markets nothing changes.
  compensationCase("advertised-gross-us-annual", (input) => {
    input.offers[0] = advertisedOffer();
    input.compensation = salary({ amount: 140000, basis: "unknown", currency: "USD", period: "annual" });
  }, { assumptions: ADVERTISED, decision: "EVALUATED", score: 35 }),
  compensationCase("advertised-gross-us-range-crosses-floor", (input) => {
    input.offers[0] = advertisedOffer();
    input.compensation = salary({ amount: 2400, basis: "unknown", currency: "USD", maximum: 4200 });
  }, {
    assumptions: [...ADVERTISED, "assumption:compensation.range_crosses_floor"],
    decision: "EVALUATED",
    score: 5,
  }),
  compensationCase("advertised-gross-uk-fx", (input) => {
    input.offers[0] = advertisedOffer({ compensationMarket: "UK", westRegion: "EU_UK" });
    input.compensation = salary({ amount: 60000, basis: "unknown", currency: "GBP", period: "annual" });
    input.fx = { provider: "ECB", rateDate: "2026-08-21", sourceCurrency: "GBP", targetCurrency: "USD", targetPerSource: 1.25 };
  }, { assumptions: ADVERTISED, decision: "EVALUATED", score: 35 }),
  // The reading survives an FX middle, the way the comparable-cost floor-currency default does.
  compensationCase("advertised-gross-uk-fx-missing", (input) => {
    input.offers[0] = advertisedOffer({ compensationMarket: "UK", westRegion: "EU_UK" });
    input.compensation = salary({ amount: 60000, basis: "unknown", currency: "GBP", period: "annual" });
  }, {
    assumptions: ADVERTISED,
    decision: "EVALUATED",
    gaps: ["gap:compensation_fx_unavailable"],
    score: 15,
  }),
  compensationCase("advertised-gross-canada-fx", (input) => {
    input.offers[0] = advertisedOffer({ compensationMarket: "Canada" });
    input.compensation = salary({ amount: 100000, basis: "unknown", currency: "CAD", period: "annual" });
    input.fx = { provider: "ECB", rateDate: "2026-08-21", sourceCurrency: "CAD", targetCurrency: "USD", targetPerSource: 0.75 };
  }, { assumptions: ADVERTISED, decision: "EVALUATED", score: 35 }),
  // Outside the three named markets the middle and its annotation stand, whatever the currency.
  compensationCase("advertised-gross-other-market", (input) => {
    input.offers[0] = advertisedOffer({ compensationMarket: "other" });
    input.compensation = salary({ amount: 140000, basis: "unknown", currency: "USD", period: "annual" });
  }, { decision: "EVALUATED", gaps: ["gap:compensation_basis_incomparable"], score: 15 }),
  compensationCase("advertised-gross-unknown-market", (input) => {
    input.offers[0] = advertisedOffer({ compensationMarket: "unknown" });
    input.compensation = salary({ amount: 140000, basis: "unknown", currency: "USD", period: "annual" });
  }, { decision: "EVALUATED", gaps: ["gap:compensation_basis_incomparable"], score: 15 }),
  // Tax is never inferred: a stated net stays net and stays incomparable with a gross floor.
  compensationCase("advertised-gross-stated-net-kept", (input) => {
    input.offers[0] = advertisedOffer();
    input.compensation = salary({ amount: 140000, basis: "net", currency: "USD", period: "annual" });
  }, { decision: "EVALUATED", gaps: ["gap:compensation_basis_incomparable"], score: 15 }),
  // A stated gross needs no default, so none is recorded.
  compensationCase("advertised-gross-stated-gross-no-token", (input) => {
    input.offers[0] = advertisedOffer();
    input.compensation = salary({ amount: 5200, basis: "gross", currency: "USD" });
  }, { decision: "EVALUATED", score: 35 }),
  // Against a net floor the reading would price nothing, because gross is never converted to net.
  compensationCase("advertised-gross-net-floor", (input) => {
    input.offers[0] = advertisedOffer({
      compensationMarket: "US",
      engagementPath: "comparable_cost_employment",
    });
    input.compensation = salary({ amount: 4200, basis: "unknown", currency: "USD" });
  }, { decision: "EVALUATED", gaps: ["gap:compensation_basis_incomparable"], score: 15 }),
  compensationCase("advertised-gross-override-net", (input) => {
    input.offers[0] = advertisedOffer();
    input.compensation = salary({ amount: 140000, basis: "unknown", currency: "USD", period: "annual" });
    input.explicitOverride = { amount: 3200, basis: "net", currency: "USD", period: "monthly", scope: "batch" };
  }, { decision: "EVALUATED", gaps: ["gap:compensation_basis_incomparable"], score: 15 }),
  // A gross override is the user's own gross line, so it consumes the reading like an ordinary floor.
  compensationCase("advertised-gross-override-gross-below-band", (input) => {
    input.offers[0] = advertisedOffer();
    input.compensation = salary({ amount: 2800, basis: "unknown", currency: "USD" });
    input.explicitOverride = { amount: 2400, basis: "gross", currency: "USD", period: "monthly", scope: "batch" };
  }, { assumptions: ADVERTISED, decision: "EVALUATED", score: 4 }),
  // The floorless relocation lane has no comparison for a default to be consumed by: the band reads
  // the figure as the listing published it, and no token is written.
  compensationCase("advertised-gross-relocation-lane-unchanged", (input) => {
    input.offers[0] = relocationOffer();
    input.compensation = salary({ amount: 140000, basis: "unknown", currency: "USD", period: "annual" });
  }, { decision: "EVALUATED", score: 35 }),
  // An unknown period is a different gap and does not withhold the reading.
  compensationCase("advertised-gross-period-unknown", (input) => {
    input.offers[0] = advertisedOffer();
    input.compensation = salary({ amount: 4200, basis: "unknown", currency: "USD", period: "unknown" });
  }, {
    assumptions: ADVERTISED,
    decision: "EVALUATED",
    gaps: ["gap:compensation_period_absent"],
    score: 15,
  }),
  // The reading lowers a score as readily as it raises one.
  compensationCase("advertised-gross-us-below-floor", (input) => {
    input.offers[0] = advertisedOffer();
    input.compensation = salary({ amount: 2400, basis: "unknown", currency: "USD" });
  }, { assumptions: ADVERTISED, decision: "EVALUATED", score: 2 }),
  // No offered path means no market was observed, so the reading has nothing to key on.
  compensationCase("advertised-gross-no-offer-observed", (input) => {
    input.offers = [];
    input.compensation = salary({ amount: 140000, basis: "unknown", currency: "USD", period: "annual" });
  }, { decision: "EVALUATED", gaps: ["gap:compensation_basis_incomparable"], score: 15 }),
  compensationCase("advertised-gross-relocation-override-gross", (input) => {
    input.offers[0] = relocationOffer();
    input.compensation = salary({ amount: 140000, basis: "unknown", currency: "USD", period: "annual" });
    input.explicitOverride = { amount: 5200, basis: "gross", currency: "USD", period: "monthly", scope: "batch" };
  }, { assumptions: ADVERTISED, decision: "EVALUATED", score: 35 }),
];

export const formatCases = [
  (() => {
    // The priority order continues below `Remote`: a listing offering Hybrid and On-site selects
    // the Hybrid one.
    const input = baseInput();
    input.compensation = null;
    input.offers = [
      baseOffer({
        companyRegion: "OTHER",
        engagementPath: null,
        evidenceQuote: "On-site in San José",
        relocationCountry: "Costa Rica",
        relocationCountryCode: "CR",
        workFormat: "On-site",
      }),
      baseOffer({
        companyRegion: "OTHER",
        engagementPath: null,
        evidenceQuote: "Hybrid in San José",
        relocationCountry: "Costa Rica",
        relocationCountryCode: "CR",
        workFormat: "Hybrid",
      }),
    ];
    return { expected: { decision: "EVALUATED", selected: "Hybrid" }, id: "format:hybrid-before-onsite", input };
  })(),
  (() => {
    const input = baseInput();
    input.offers = [
      baseOffer({ workFormat: "On-site", relocationCountry: "Costa Rica", relocationCountryCode: "CR", companyRegion: "OTHER" }),
      baseOffer({ workFormat: "Hybrid", relocationCountry: "Costa Rica", relocationCountryCode: "CR", companyRegion: "OTHER" }),
      baseOffer({ workFormat: "Remote" }),
    ];
    return { expected: { decision: "EVALUATED", selected: "Remote" }, id: "format:case-b-all-three", input };
  })(),
  (() => {
    const input = baseInput();
    input.offerPairing = "unclear";
    return {
      expected: { decision: "MANUAL_REVIEW", reviewReason: "offered_path_pairing_ambiguous", selected: null },
      id: "format:pairing-unclear",
      input,
    };
  })(),
  (() => {
    // A format the listing never resolves is scored with the M middle, not reviewed.
    const input = baseInput();
    input.offers = [baseOffer({ workFormat: "Unknown" })];
    return { expected: { decision: "EVALUATED", selected: "Unknown" }, id: "format:unknown-only", input };
  })(),
  (() => {
    const input = baseInput();
    input.offers = [];
    return { expected: { decision: "EVALUATED", selected: null }, id: "format:no-offer-observed", input };
  })(),
  (() => {
    const input = baseInput();
    input.offers = [
      baseOffer(),
      baseOffer({ companyRegion: "UNKNOWN", timezoneDistance: "unknown" }),
    ];
    return {
      expected: { decision: "MANUAL_REVIEW", reviewReason: "multiple_selected_format_paths", selected: null },
      id: "format:two-remote-paths",
      input,
    };
  })(),
  (() => {
    const input = baseInput();
    input.compensation = null;
    input.offers = [
      baseOffer({
        companyRegion: "OTHER",
        engagementPath: null,
        evidenceQuote: "On-site, Ruritania",
        relocationCountry: "Ruritania",
        relocationSupport: "available",
        workAuthorization: "unknown",
        workFormat: "On-site",
      }),
      baseOffer({
        companyRegion: "UNKNOWN",
        engagementPath: null,
        evidenceQuote: "On-site, Freedonia",
        relocationCountry: "Freedonia",
        relocationSupport: "available",
        workAuthorization: "unknown",
        workFormat: "On-site",
      }),
    ];
    // knowledge/job-match-rules.md#31-m--mobility--work-feasibility: an unidentified destination is not dropped from the count. Two paths of the selected
    // format neither of which could be read are the same contradiction as two that were read.
    return {
      expected: { decision: "MANUAL_REVIEW", reviewReason: "multiple_selected_format_paths", selected: null },
      id: "format:two-undecidable-paths",
      input,
    };
  })(),
  (() => {
    const input = baseInput();
    input.compensation = null;
    input.offers = [
      baseOffer({
        companyRegion: "OTHER",
        engagementPath: null,
        evidenceQuote: "On-site, Μάλτα (Βαλέτα)",
        relocationCountry: "Μάλτα (Βαλέτα)",
        relocationSupport: "available",
        workAuthorization: "unknown",
        workFormat: "On-site",
      }),
      baseOffer({
        companyRegion: "OTHER",
        engagementPath: null,
        evidenceQuote: "On-site, San José, Costa Rica",
        relocationCountry: "San José, Costa Rica",
        relocationCountryCode: "CR",
        relocationSupport: "available",
        workAuthorization: "unknown",
        workFormat: "On-site",
      }),
    ];
    // The decided case of knowledge/job-match-rules.md#31-m--mobility--work-feasibility: the path nobody could read is not dropped in favour of the one that
    // could, because that would choose among the source's paths by how well they were read. Supplying
    // the missing `MT` terminates the first path by rule 4 and the listing scores on the second; not
    // supplying it leaves the source offering two On-site paths, which is this review state.
    return {
      expected: { decision: "MANUAL_REVIEW", reviewReason: "multiple_selected_format_paths", selected: null },
      id: "format:undecidable-path-still-counts",
      input,
    };
  })(),
  (() => {
    const input = baseInput();
    input.offers = [
      baseOffer({
        companyRegion: "WEST",
        compensationMarket: "US",
        contractorEligibility: "ineligible",
        relocationSupport: "unavailable",
        residenceRestriction: "incompatible",
        sponsorship: "unavailable",
        westRegion: "US_CANADA",
        workAuthorization: "required_existing",
      }),
      baseOffer({ companyRegion: "OTHER", relocationCountry: "Costa Rica", relocationCountryCode: "CR", workFormat: "Hybrid" }),
    ];
    return { expected: { decision: "EVALUATED", selected: "Hybrid" }, id: "format:skip-infeasible-remote", input };
  })(),
  (() => {
    const input = baseInput();
    input.offers = [
      baseOffer({
        evidenceQuote: "Candidate is explicitly ineligible for the remote employment path.",
        workAuthorization: "explicitly_ineligible",
      }),
      baseOffer({
        companyRegion: "OTHER",
        evidenceQuote: "Hybrid contractor path is available from the candidate location.",
        relocationCountry: "Costa Rica",
        relocationCountryCode: "CR",
        workFormat: "Hybrid",
      }),
    ];
    return {
      expected: { decision: "EVALUATED", selected: "Hybrid" },
      id: "format:skip-explicit-ineligible-when-feasible-path-exists",
      input,
    };
  })(),
  (() => {
    const input = baseInput();
    return { expected: { decision: "EVALUATED", selected: "Remote" }, id: "format:no-sponsorship-local", input };
  })(),
  (() => {
    const input = baseInput();
    input.offers[0] = baseOffer({
      companyRegion: "OTHER",
      engagementPath: "outside_home_contractor",
      workAuthorization: "unknown",
    });
    input.compensation = salary({ amount: 3200, basis: "gross", currency: "USD" });
    return { expected: { decision: "EVALUATED", selected: "Remote" }, id: "format:no-sponsorship-b2b", input };
  })(),
  (() => {
    // An incompatible residence whose cures are merely unsilent-about is scored, never skipped:
    // knowledge/job-match-rules.md#22-accepted-triage-decision-record records exactly one exception to the uncertainty contract, and this is not it.
    const input = baseInput();
    input.compensation = null;
    input.offers = [
      baseOffer({
        companyRegion: "WEST",
        compensationMarket: "other",
        contractorEligibility: "unknown",
        engagementPath: "outside_home_contractor",
        evidenceQuote: "Remote in Europe only; residents of Argentina and Uruguay are not eligible.",
        residenceRestriction: "incompatible",
        sponsorship: "unknown",
        westRegion: "EU_UK",
        workAuthorization: "unknown",
      }),
    ];
    return {
      expected: { decision: "EVALUATED", selected: "Remote" },
      id: "format:incompatible-residence-scored",
      input,
    };
  })(),
];

function stackCase(id, languages, tools, score, gaps = []) {
  const input = baseInput();
  input.role.observedLanguages = languages;
  input.role.observedTools = tools;
  return { id, input, expected: { toolMatch: score, gaps } };
}
const language = (name, scope = "main") => baseObservedLanguage({ name, scope, requirement: scope === "optional" ? "optional" : "required" });
const tool = (name, scope = "main", kind) => baseObservedTool({ name, scope, requirement: scope === "optional" ? "optional" : "required", ...(kind ? { kind } : {}) });
export const toolCases = [
  stackCase("stack:independent-best", [language("TypeScript")], [tool("Playwright")], 8),
  stackCase("stack:python-same-framework", [language("Python")], [tool("Playwright")], 9),
  stackCase("stack:java-same-framework", [language("Java")], [tool("Playwright")], 5),
  stackCase("stack:unpriced-language", [language("C#")], [tool("Playwright")], 4),
  stackCase("stack:framework-without-language", [], [tool("Playwright")], 6, ["gap:test_language_absent"]),
  stackCase("stack:language-without-framework", [language("TypeScript")], [], 6, ["gap:test_framework_absent"]),
  stackCase("stack:unknown", [], [], 4, ["gap:stack_absent"]),
  stackCase("stack:optional-only", [language("Python", "optional")], [tool("Playwright", "optional")], 4, ["gap:stack_absent"]),
  stackCase("stack:supporting-only", [], [tool("Docker", "main", "supporting"), tool("SQL", "main", "supporting"), tool("Postman", "main", "supporting")], 4, ["gap:stack_absent"]),
  stackCase("stack:known-mismatch", [language("C#")], [tool("Karate")], 0),
  stackCase("stack:unrecognised-main-framework", [], [tool("InternalQAFramework")], 2, ["gap:test_language_absent"]),
  stackCase("stack:unrecognised-language", [language("COBOL")], [], 2, ["gap:test_framework_absent"]),
  stackCase("stack:runner-with-unfamiliar-appium", [language("Java")], [tool("Appium"), tool("TestNG")], 2),
  stackCase("stack:unmatched-required-no-penalty", [language("TypeScript")], [tool("Appium"), tool("Playwright")], 8),
  stackCase("stack:optional-never-selects", [language("TypeScript"), language("Python", "optional")], [tool("REST Assured"), tool("PyTest", "optional")], 6),
  stackCase("stack:product-only", [language("Python", "product")], [], 4, ["gap:stack_absent"]),
  stackCase("stack:ambiguous", [language("TypeScript", "ambiguous")], [tool("InternalQA", "ambiguous", "ambiguous")], 4, ["gap:stack_absent", "gap:stack_ambiguous"]),
  stackCase("stack:maximum-does-not-sum", [language("Java"), language("TypeScript"), language("Python")], [tool("REST Assured"), tool("Playwright"), tool("PyTest")], 10),
  stackCase("stack:former-modern-no-bonus", [], [tool("Prometheus", "optional", "supporting")], 4, ["gap:stack_absent"]),
];

function annotationCase(id, configure, expected) {
  const input = baseInput();
  configure(input);
  return { expected, id: `annotation:${id}`, input };
}

/** knowledge/job-match-rules.md#22-accepted-triage-decision-record engagement-path defaults: the table is total over (format class, region). */
export const annotationCases = [
  annotationCase("engagement:remote-west", (input) => {
    input.compensation = null;
    input.offers = [baseOffer({
      companyRegion: "WEST",
      compensationMarket: "UK",
      engagementPath: null,
      evidenceQuote: "Fully remote across Europe",
      residenceRestriction: "unknown",
      sponsorship: "unknown",
      timezone: "tz_any",
      timezoneDistance: "far",
      westRegion: "EU_UK",
      workAuthorization: "unknown",
    })];
  }, {
    assumptions: ["assumption:engagement_path.outside_home_contractor"],
    engagementPath: "outside_home_contractor",
  }),
  annotationCase("engagement:remote-home", (input) => {
    input.compensation = null;
    input.offers = [baseOffer({ engagementPath: null })];
  }, {
    assumptions: ["assumption:engagement_path.home_employment"],
    engagementPath: "home_employment",
  }),
  annotationCase("engagement:unresolved-format-unknown-region", (input) => {
    input.compensation = null;
    input.offers = [];
  }, {
    assumptions: ["assumption:engagement_path.outside_home_contractor"],
    engagementPath: "outside_home_contractor",
  }),
  annotationCase("engagement:unresolved-format-home", (input) => {
    input.compensation = null;
    input.offers = [baseOffer({ engagementPath: null, evidenceQuote: "Buenos Aires, work format not stated", workFormat: "Unknown" })];
  }, {
    assumptions: ["assumption:engagement_path.home_employment"],
    engagementPath: "home_employment",
  }),
  annotationCase("engagement:unresolved-format-other", (input) => {
    input.compensation = null;
    input.offers = [baseOffer({
      companyRegion: "OTHER",
      engagementPath: null,
      evidenceQuote: "Work format is not stated",
      workFormat: "Unknown",
    })];
  }, {
    assumptions: ["assumption:engagement_path.outside_home_contractor"],
    engagementPath: "outside_home_contractor",
  }),
  annotationCase("engagement:onsite-other", (input) => {
    input.compensation = null;
    input.offers = [baseOffer({
      companyRegion: "OTHER",
      engagementPath: null,
      evidenceQuote: "On-site in San José",
      relocationCountry: "Costa Rica",
      relocationCountryCode: "CR",
      relocationSupport: "available",
      workAuthorization: "unknown",
      workFormat: "On-site",
    })];
  }, {
    assumptions: ["assumption:engagement_path.relocation"],
    engagementPath: "relocation_employment",
  }),
  annotationCase("engagement:onsite-home", (input) => {
    input.compensation = null;
    input.offers = [baseOffer({
      engagementPath: null,
      evidenceQuote: "Office in Buenos Aires",
      relocationCountry: "Argentina",
      relocationCountryCode: "AR",
      workAuthorization: "unknown",
      workFormat: "On-site",
    })];
  }, {
    assumptions: ["assumption:engagement_path.home_employment"],
    engagementPath: "home_employment",
  }),
  annotationCase("engagement:observed-path-is-never-defaulted", (input) => {
    input.compensation = null;
    input.offers = [baseOffer({
      companyRegion: "WEST",
      compensationMarket: "UK",
      engagementPath: "comparable_cost_employment",
      evidenceQuote: "Employment contract with our Costa Rican entity",
      residenceRestriction: "unknown",
      timezone: "tz_any",
      timezoneDistance: "far",
      westRegion: "EU_UK",
    })];
  }, { assumptions: [], engagementPath: "comparable_cost_employment" }),
];

export const declaredDecisionCases = Object.freeze([
  ...terminalCases,
  ...mobilityCases,
  ...compensationCases,
  ...formatCases,
  ...toolCases,
  ...annotationCases,
  onsiteResidenceResidual,
]);
