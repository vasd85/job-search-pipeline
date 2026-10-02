// A replayed triage batch, written into a disposable root.
//
// The 2026-08-18 batch's own inputs no longer exist - its raw pages, normalized inputs and traces
// lived in one session's scratchpad, as `docs/runbooks/triage-review.md` docs/runbooks/triage-review.md#0-what-is-fixed-here-measurements-of-the-2026-08-18-run records. This
// fixture reconstructs that batch's *shape* instead: an on-site Singapore posting carrying the hard
// residence line the run's vocabulary missed, a remote EU posting, a posting closed behind its own
// banner, a posting that 404s, and a posting the primary transport had to hand to the browser. One
// link of the range is skipped by the batch plan, and it deliberately sits in the middle so nothing
// can pass by matching records to links positionally.
//
// Every evidence quote below is sliced out of the normalized capture body, so the fixture cannot
// drift into asserting a quote the page does not contain.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initLedger, recordBatch, vacancyIdentity } from "../../../tools/lib/triage-ledger-core.mjs";
import { normalizeExtractedText } from "../../../tools/vacancy-fetch/normalize.mjs";
import { renderCaptureFile } from "../../../tools/vacancy-fetch/persist.mjs";
import { sha256Utf8 } from "../../../tools/vacancy-fetch/digest.mjs";
import { buildDecisionTrace } from "../../../tools/job-scorer/trace.mjs";
import { baseScoring } from "../job-scorer/decision-table.mjs";

export const batchId = "2026-08-23-replay-1";
export const scoringDate = "2026-08-23";
export const fetchedAt = "2026-08-23T09:15:00.000Z";
export const priorObservedAt = "2026-08-16T10:00:00.000Z";
/** The policy the prior batch ran under — superseded by the one this batch scores with. */
export const priorPolicyId = "triage-r1-05a-2026-08-04";

export const links = Object.freeze([
  "https://www.linkedin.com/jobs/view/4500000001/",
  "https://www.linkedin.com/jobs/view/4500000002/",
  "https://www.linkedin.com/jobs/view/4500000003/",
  "https://www.linkedin.com/jobs/view/4500000004/",
  "https://www.linkedin.com/jobs/view/4500000005/",
  "https://boards.example.test/initech/qa-automation-platform",
]);

/** The one link the plan removes before the first fetch. Position 3 of the range, on purpose. */
export const skippedLinkPosition = 3;

const SINGAPORE_BODY = [
  "Senior QA Automation Engineer",
  "",
  "Acme Robotics is hiring a Senior QA Automation Engineer for our Singapore office.",
  "",
  "Requirements:",
  "- 5+ years in test automation with TypeScript and Playwright.",
  "- Candidates MUST BE currently based in Singapore; we do not sponsor relocation.",
  "- Experience with REST API testing.",
  "",
  "This is an on-site role, five days a week in the office.",
  "",
  "Benefits: health insurance and a learning budget.",
  "",
].join("\n");

// The non-breaking space is deliberate: it makes the normalization pass do something, so the
// capture header records a rule that fired rather than the "none" every clean fixture would show.
const NORTHWIND_BODY = [
  "Senior Test Automation Engineer (Remote)",
  "",
  "Northwind Analytics builds a distributed data platform for logistics operators in the EU.",
  "",
  "We are fully remote across the EU and hire through an employer of record where needed.",
  "",
  "You will own the end-to-end automation framework in TypeScript with Playwright.",
  "",
  "Compensation: 70 000 - 90 000 EUR gross per year.",
  "",
  "Benefits: we cover a work from home stipend and a yearly conference budget.",
  "",
].join("\n");

const GLOBEX_BODY = [
  "Senior QA Engineer",
  "",
  "No longer accepting applications",
  "",
  "Globex Payments was hiring a Senior QA Engineer for its Berlin office.",
  "",
].join("\n");

const INITECH_BODY = [
  "QA Automation Engineer, Platform",
  "",
  "Initech Cloud is a US-based infrastructure company.",
  "",
  "The role is remote, but you must reside in the United States for tax reasons.",
  "",
  "Stack: Java, Selenide, Jenkins.",
  "",
].join("\n");

function normalized(text) {
  return normalizeExtractedText(text);
}

function line(body, needle) {
  if (!body.includes(needle)) {
    throw new Error(`fixture quote is not in its own body: ${needle}`);
  }
  return needle;
}

function baseRole(overrides = {}) {
  return {
    automation: "unknown",
    domain: "unclear",
    evidence: {
      automation: null,
      domain: null,
      language: null,
      role: null,
      seniority: null,
      tools: null,
    },
    family: "qa_testing",
    language: "unknown",
    observedTools: [],
    observedLanguages: [],
    seniority: "unknown",
    ...overrides,
  };
}

function observedTool(overrides = {}) {
  const { language: _retiredBinding, ...values } = overrides;
  return { name: "Playwright", requirement: "observed", requirementPhrase: null,
    scope: "main", scopeReason: "The QA stack line names this tool.", kind: "framework",
    evidenceQuote: "placeholder", ...values };
}

function baseOffer(overrides = {}) {
  return {
    companyRegion: "OTHER",
    compensationMarket: "unknown",
    contractorEligibility: "unknown",
    engagementPath: null,
    evidenceQuote: "placeholder",
    relocationCountry: null,
    relocationCountryCode: null,
    relocationSupport: "unknown",
    residenceRequirementCountry: null,
    residenceRequirementCountryCode: null,
    residenceRestriction: "unknown",
    sponsorship: "unknown",
    timezone: "tz_unknown",
    timezoneDistance: "unknown",
    westRegion: null,
    workAuthorization: "unknown",
    workFormat: "Unknown",
    ...overrides,
  };
}

/**
 * `inputIndex` is the link's one-based position in the batch's deduplicated input, which is what
 * the rubric's knowledge/job-match-rules.md#7-decision-trace-contract calls `input_index`. It is not the record number: the plan withholds position 3,
 * so records `003`-`005` carry positions 4-6.
 */
function inputFor(sourceRef, overrides) {
  return withAiObservation({
    candidateScoring: baseScoring(),
    compensation: null,
    explicitOverride: null,
    fx: null,
    inputIndex: links.indexOf(sourceRef) + 1,
    offerPairing: "clear",
    offers: [],
    policyId: "triage-policy-v8-2026-10-01",
    role: baseRole(),
    schemaVersion: 9,
    scoringDate,
    source: {
      accessOutcome: "usable",
      accessReason: null,
      company: null,
      evidenceQuote: null,
      finalUrl: sourceRef,
      jobTitle: null,
      locationRaw: null,
      salaryRaw: null,
      sourceRef,
      workFormatRaw: null,
    },
    ...overrides,
  });
}

/**
 * knowledge/job-match-rules.md#7-decision-trace-contract's AI observation as the run would have recorded it when the record states none of its own: a
 * page nobody read says `unknown`, a read one that ties AI to nothing says `none`, and neither
 * carries a quote.
 */
function withAiObservation(input) {
  const unread = input.source.accessOutcome !== "usable";
  const silent = unread ? "unknown" : "none";
  input.role = {
    ai: { product: silent, work: silent },
    ...input.role,
    evidence: { aiProduct: null, aiWork: null, ...input.role.evidence },
  };
  return input;
}

/**
 * The five records of the replayed batch, each as its capture bodies plus the normalized input the
 * run would have built from them.
 */
export function buildRecords() {
  const singapore = normalized(SINGAPORE_BODY);
  const northwind = normalized(NORTHWIND_BODY);
  const globex = normalized(GLOBEX_BODY);
  const initech = normalized(INITECH_BODY);

  const record1 = {
    index: 1,
    link: links[0],
    captures: [{ part: null, adapter: "linkedin-guest@1", sourceId: "linkedin", pass: singapore, outcome: "active" }],
    manifest: { outcome: "active", usable: true, fallback: null, skipped: false },
    input: inputFor(links[0], {
      offers: [baseOffer({
        companyRegion: "OTHER",
        contractorEligibility: "unknown",
        evidenceQuote: line(singapore.text, "- Candidates MUST BE currently based in Singapore; we do not sponsor relocation."),
        relocationCountry: "Singapore",
        relocationCountryCode: "SG",
        relocationSupport: "unavailable",
        residenceRequirementCountry: "Singapore",
        residenceRequirementCountryCode: "SG",
        residenceRestriction: "incompatible",
        sponsorship: "unavailable",
        workFormat: "On-site",
      })],
      role: baseRole({
        automation: "primary",
        domain: "other_complex",
        evidence: {
          automation: line(singapore.text, "- 5+ years in test automation with TypeScript and Playwright."),
          domain: line(singapore.text, "Acme Robotics is hiring a Senior QA Automation Engineer for our Singapore office."),
          language: null,
          role: line(singapore.text, "Senior QA Automation Engineer"),
          seniority: null,
          tools: line(singapore.text, "TypeScript and Playwright"),
        },
        language: "English",
        observedLanguages: [{name:"TypeScript",requirement:"required",requirementPhrase:null,scope:"main",scopeReason:"The QA duties explicitly name the test language.",evidenceQuote: line(singapore.text, "TypeScript and Playwright")}],
        observedTools: [observedTool({
          evidenceQuote: line(singapore.text, "TypeScript and Playwright"),
          language: "typescript_javascript",
          name: "Playwright",
          requirement: "required",
        })],
        seniority: "senior",
      }),
      source: {
        accessOutcome: "usable",
        accessReason: null,
        company: "Acme Robotics",
        evidenceQuote: line(singapore.text, "Senior QA Automation Engineer"),
        finalUrl: links[0],
        jobTitle: "Senior QA Automation Engineer",
        locationRaw: "Singapore",
        salaryRaw: null,
        sourceRef: links[0],
        workFormatRaw: "On-site",
      },
    }),
  };

  const record2 = {
    index: 2,
    link: links[1],
    captures: [{ part: null, adapter: "linkedin-guest@1", sourceId: "linkedin", pass: northwind, outcome: "active" }],
    manifest: { outcome: "active", usable: true, fallback: null, skipped: false },
    input: inputFor(links[1], {
      compensation: {
        basis: "gross",
        currency: "EUR",
        evidenceQuote: line(northwind.text, "Compensation: 70 000 - 90 000 EUR gross per year."),
        kind: "range",
        maximum: 90000,
        minimum: 70000,
        period: "annual",
      },
      offers: [baseOffer({
        companyRegion: "WEST",
        compensationMarket: "other",
        contractorEligibility: "eligible",
        engagementPath: "outside_home_contractor",
        evidenceQuote: line(northwind.text, "We are fully remote across the EU and hire through an employer of record where needed."),
        residenceRestriction: "none",
        timezone: "tz_any",
        timezoneDistance: "near",
        westRegion: "EU_UK",
        workFormat: "Remote",
      })],
      role: baseRole({
        automation: "primary",
        domain: "data_platforms",
        evidence: {
          automation: line(northwind.text, "You will own the end-to-end automation framework in TypeScript with Playwright."),
          domain: line(northwind.text, "Northwind Analytics builds a distributed data platform for logistics operators in the EU."),
          language: null,
          role: line(northwind.text, "Senior Test Automation Engineer (Remote)"),
          seniority: null,
          tools: line(northwind.text, "TypeScript with Playwright"),
        },
        language: "English",
        observedLanguages: [{name:"TypeScript",requirement:"required",requirementPhrase:null,scope:"main",scopeReason:"The QA duties explicitly name the test language.",evidenceQuote: line(northwind.text, "TypeScript with Playwright")}],
        observedTools: [observedTool({
          evidenceQuote: line(northwind.text, "TypeScript with Playwright"),
          language: "typescript_javascript",
          name: "Playwright",
          requirement: "required",
        })],
        seniority: "senior",
      }),
      source: {
        accessOutcome: "usable",
        accessReason: null,
        company: "Northwind Analytics",
        evidenceQuote: line(northwind.text, "Senior Test Automation Engineer (Remote)"),
        finalUrl: links[1],
        jobTitle: "Senior Test Automation Engineer",
        locationRaw: "European Union",
        salaryRaw: "70 000 - 90 000 EUR",
        sourceRef: links[1],
        workFormatRaw: "Remote",
      },
    }),
  };

  const record3 = {
    index: 3,
    link: links[3],
    captures: [{ part: null, adapter: "linkedin-guest@1", sourceId: "linkedin", pass: globex, outcome: "closed" }],
    manifest: { outcome: "closed", usable: true, fallback: null, skipped: false },
    input: inputFor(links[3], {
      source: {
        accessOutcome: "closed",
        accessReason: "closure banner on the posting",
        company: "Globex Payments",
        evidenceQuote: line(globex.text, "No longer accepting applications"),
        finalUrl: links[3],
        jobTitle: "Senior QA Engineer",
        locationRaw: "Berlin",
        salaryRaw: null,
        sourceRef: links[3],
        workFormatRaw: null,
      },
    }),
  };

  const record4 = {
    index: 4,
    link: links[4],
    captures: [],
    manifest: { outcome: "absent", usable: false, fallback: null, skipped: false },
    input: inputFor(links[4], {
      source: {
        accessOutcome: "closed",
        accessReason: "HTTP 404 after retry",
        company: null,
        evidenceQuote: null,
        finalUrl: links[4],
        jobTitle: null,
        locationRaw: null,
        salaryRaw: null,
        sourceRef: links[4],
        workFormatRaw: null,
      },
    }),
  };

  const record5 = {
    index: 5,
    link: links[5],
    captures: [{ part: "browser", adapter: "in-app-browser@1", sourceId: "url", pass: initech, outcome: "active" }],
    manifest: { outcome: "access_failure", usable: false, fallback: "browser", skipped: false },
    input: inputFor(links[5], {
      offers: [baseOffer({
        companyRegion: "WEST",
        compensationMarket: "US",
        contractorEligibility: "unknown",
        evidenceQuote: line(initech.text, "The role is remote, but you must reside in the United States for tax reasons."),
        residenceRequirementCountry: "United States",
        residenceRequirementCountryCode: "US",
        residenceRestriction: "incompatible",
        timezone: "tz_local",
        timezoneDistance: "far",
        westRegion: "US_CANADA",
        workFormat: "Remote",
      })],
      role: baseRole({
        automation: "major",
        domain: "infra_platforms",
        evidence: {
          automation: null,
          domain: line(initech.text, "Initech Cloud is a US-based infrastructure company."),
          language: null,
          role: line(initech.text, "QA Automation Engineer, Platform"),
          seniority: null,
          tools: line(initech.text, "Stack: Java, Selenide, Jenkins."),
        },
        language: "English",
        observedLanguages: [{name:"Java",requirement:"required",requirementPhrase:null,scope:"main",scopeReason:"The QA role names its stack.",evidenceQuote:line(initech.text,"Stack: Java, Selenide, Jenkins.")}],
        observedTools: [
          observedTool({ name: "Selenide", requirement: "required", evidenceQuote:line(initech.text,"Stack: Java, Selenide, Jenkins.") }),
          observedTool({ name: "Jenkins", kind: "supporting", requirement: "observed", evidenceQuote:line(initech.text,"Stack: Java, Selenide, Jenkins.") }),
        ],
        seniority: "mid",
      }),
      source: {
        accessOutcome: "usable",
        accessReason: null,
        company: "Initech Cloud",
        evidenceQuote: line(initech.text, "QA Automation Engineer, Platform"),
        finalUrl: links[5],
        jobTitle: "QA Automation Engineer, Platform",
        locationRaw: "United States",
        salaryRaw: null,
        sourceRef: links[5],
        workFormatRaw: "Remote",
      },
    }),
  };

  return [record1, record2, record3, record4, record5];
}

function captureFile(record, capture) {
  const basename = capture.part === null
    ? `${String(record.index).padStart(3, "0")}.capture.txt`
    : `${String(record.index).padStart(3, "0")}.${capture.part}.capture.txt`;
  const responseSha256 = sha256Utf8(`response:${basename}`);
  const header = {
    index: record.index,
    adapter: capture.adapter,
    "source-id": capture.sourceId,
    "requested-url": record.link,
    "final-url": record.link,
    "fetched-at": fetchedAt,
    "http-status": 200,
    outcome: capture.outcome,
    "access-barrier": null,
    "response-sha256": responseSha256,
    "response-bytes": 4096,
    "extracted-sha256": capture.pass.log.beforeSha256,
    "normalized-sha256": capture.pass.log.afterSha256,
    "body-bytes": Buffer.byteLength(capture.pass.text, "utf8"),
    normalization: capture.pass.log.rules
      .filter((rule) => rule.replacements > 0)
      .map((rule) => `${rule.id}=${rule.replacements}`)
      .join(",") || "none",
  };
  return {
    basename,
    responseSha256,
    contents: renderCaptureFile({ header, body: capture.pass.text }),
    sha256: capture.pass.log.afterSha256,
    bytes: Buffer.byteLength(capture.pass.text, "utf8"),
  };
}

/** The dispositions the passing batch legitimately needs: two lines nobody quoted. */
export function buildDispositions(records) {
  const singapore = records[0].captures[0].pass.text;
  const northwind = records[1].captures[0].pass.text;
  return {
    schemaVersion: 1,
    batchId,
    dispositions: [
      {
        recordIndex: 1,
        family: "work_format",
        lineSha256: digestOfLine(singapore, "This is an on-site role, five days a week in the office."),
        disposition: "already_recorded_elsewhere",
        note: "On-site is the recorded work format and the offer carries the residence line.",
      },
      {
        recordIndex: 2,
        family: "work_format",
        lineSha256: digestOfLine(northwind, "Benefits: we cover a work from home stipend and a yearly conference budget."),
        disposition: "not_a_requirement",
        note: "A benefit, not a work-format statement.",
      },
    ],
  };
}

function digestOfLine(body, lineText) {
  const start = body.indexOf(lineText);
  if (start === -1) throw new Error(`fixture disposition line is not in its body: ${lineText}`);
  const folded = lineText.toLowerCase().replace(/\s+/gu, " ").trim();
  return sha256Utf8(folded);
}

export function buildAttestation() {
  return {
    schemaVersion: 1,
    batchId,
    probes: [
      { probe: "phase0_capability_probe", ranAt: "2026-08-23T08:40:00.000Z", verdict: "held", note: "Guest fragment still served." },
      { probe: "transport_hypotheses", ranAt: "2026-08-23T08:45:00.000Z", verdict: "held" },
    ],
  };
}

/**
 * The blind extraction of one sample: the same offer observations, quoted differently, as a second
 * agent that only saw the capture would write them. The outcome fields must therefore agree.
 */
export function buildBlindInput(records) {
  const record = records[1];
  const body = record.captures[0].pass.text;
  const blind = structuredClone(record.input);
  blind.role.evidence.domain = line(body, "Northwind Analytics builds a distributed data platform for logistics operators in the EU.");
  blind.role.evidence.automation = line(body, "the end-to-end automation framework in TypeScript with Playwright");
  blind.source.evidenceQuote = line(body, "Senior Test Automation Engineer");
  return blind;
}

/**
 * The plan the batch used, in `planBatch`'s own shape: the skipped link is terminal in the ledger,
 * the first two links are known and open - the plan calls them `skip_known`, and this batch fetched
 * them anyway because the user asked for a re-check - and the rest are new.
 */
export function buildPlan() {
  const items = links.map((link, position) => {
    const identity = vacancyIdentity(link);
    const base = {
      input_index: position + 1,
      link,
      key: identity.key,
      source: identity.source,
      url: identity.url,
      duplicate_in_batch: false,
    };
    if (position + 1 === skippedLinkPosition) {
      return {
        ...base,
        status: "closed",
        decision: "SKIP",
        flags: [],
        policy_id: priorPolicyId,
        last_checked: priorObservedAt,
        action: "skip_closed",
        reason: "ledger status closed",
      };
    }
    if (position === 0 || position === 1) {
      const known = position === 0
        ? { decision: "MANUAL_REVIEW", flags: ["relocation_floor_missing"], priority_class: 3 }
        : { decision: "EVALUATED", flags: ["work_format_unknown"], priority_class: 1 };
      return {
        ...base,
        status: "open",
        ...known,
        policy_id: priorPolicyId,
        last_checked: priorObservedAt,
        action: "skip_known",
        reason: "already triaged",
      };
    }
    return { ...base, action: "fetch_new", reason: "not in the ledger" };
  });
  return {
    as_of: "2026-08-23T09:00:00.000Z",
    links_in: links.length,
    counts: { fetch_new: 3, retry_blocked: 0, skip_known: 2, skip_closed: 1, invalid: 0 },
    fetch: 3,
    items,
  };
}

/**
 * Write the whole batch into `root`.
 * `mutate` receives the assembled files before they are written, so a test can break exactly one
 * thing without rebuilding the batch by hand.
 */
export function writeReplayBatch(root, mutate = null) {
  const artifactsDir = join(root, "artifacts");
  mkdirSync(join(artifactsDir, "inputs"), { recursive: true });
  mkdirSync(join(artifactsDir, "traces"), { recursive: true });
  mkdirSync(join(artifactsDir, "blind"), { recursive: true });

  const records = buildRecords();
  const files = new Map();
  const manifestRecords = [];

  for (const record of records) {
    const rendered = record.captures.map((capture) => captureFile(record, capture));
    for (const capture of rendered) files.set(capture.basename, capture.contents);
    const padded = String(record.index).padStart(3, "0");
    files.set(join("inputs", `${padded}.input.json`), `${JSON.stringify(record.input, null, 2)}\n`);
    files.set(
      join("traces", `${padded}.trace.json`),
      `${JSON.stringify(buildDecisionTrace(record.input), null, 2)}\n`,
    );
    const primary = rendered.find((capture) => !capture.basename.includes("browser")) ?? null;
    manifestRecords.push({
      index: record.index,
      adapterId: record.captures[0]?.adapter?.split("@")[0] ?? "linkedin-guest",
      requestedUrl: record.link,
      finalUrl: record.link,
      fetchedAt,
      httpStatus: record.manifest.outcome === "absent" ? 404 : 200,
      response: { sha256: primary === null ? null : primary.responseSha256, bytes: 4096 },
      persisted: primary === null || !record.manifest.usable
        ? null
        : { file: primary.basename, sha256: primary.sha256, bytes: primary.bytes },
      outcome: record.manifest.outcome,
      usable: record.manifest.usable,
      fallback: record.manifest.fallback,
      skipped: record.manifest.skipped,
    });
  }

  files.set("fetch-manifest.json", `${JSON.stringify({
    schemaVersion: 2,
    tool: "vacancy-fetch",
    batch: { label: "replay", isDefaultTransport: true },
    startedAt: fetchedAt,
    finishedAt: fetchedAt,
    stoppedEarly: null,
    records: manifestRecords,
  }, null, 2)}\n`);
  files.set("plan.json", `${JSON.stringify(buildPlan(), null, 2)}\n`);
  files.set(join("blind", "002.input.json"), `${JSON.stringify(buildBlindInput(records), null, 2)}\n`);
  files.set("disposition.json", `${JSON.stringify(buildDispositions(records), null, 2)}\n`);
  files.set("attestation.json", `${JSON.stringify(buildAttestation(), null, 2)}\n`);

  const linksFile = join(root, "links.txt");
  const linksText = ["# collected 2026-08-22", "", ...links, ""].join("\n");

  const payload = { artifactsDir, files, links: linksText, linksFile, records };
  if (mutate !== null) mutate(payload);

  writeFileSync(payload.linksFile, payload.links, "utf8");
  for (const [name, contents] of payload.files) {
    writeFileSync(join(artifactsDir, name), contents, "utf8");
  }
  return {
    artifactsDir,
    linksFile: payload.linksFile,
    from: 1,
    to: links.length,
    records: payload.records,
  };
}

/**
 * The ledger as it stood before this batch: the link the plan skips is already terminal, and the
 * first record carries an older decision so the baseline diff has something real to report.
 */
export function writePriorLedger(root) {
  const path = join(root, "triage-ledger.json");
  initLedger(path);
  // Synthetic prior state rather than a batch that ever existed: there is no directory to archive
  // it into, and `{artifactsDir: null}` is how a caller says so on purpose.
  recordBatch(path, {
    batch_id: "2026-08-16-prior-1",
    observed_at: priorObservedAt,
    // The prior batch ran under the superseded policy, which is the situation the policy stamp on
    // a diff row exists for: this batch's decisions move, and a reader can see that the policy
    // moved underneath them rather than having to reconstruct it.
    policy_id: priorPolicyId,
    entries: [
      { url: links[skippedLinkPosition - 1], status: "closed", decision: "SKIP", flags: [] },
      {
        url: links[0],
        status: "open",
        decision: "MANUAL_REVIEW",
        flags: ["relocation_floor_missing"],
        priority_class: 3,
      },
      // A second known link, kept because its trace carries annotations of its own: without one the
      // flag diff only ever has a `removed` side and half the comparison goes unexercised.
      {
        url: links[1],
        status: "open",
        decision: "EVALUATED",
        flags: ["work_format_unknown"],
        priority_class: 1,
      },
    ],
  }, { artifactsDir: null });
  return path;
}
