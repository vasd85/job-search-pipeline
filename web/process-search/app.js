import {
  gapCardView,
  gapSupportLine,
  priorityEvidenceCardView,
  traitCardView,
} from "./application-brief-view.js";
import {
  filterProcessResults,
  listLocation,
  normalizeFilter,
  parseAppRoute,
  processFilters,
  safeExternalUrl,
} from "./view-model.js";

const mainNode = document.querySelector("#main-content");
const stateLabels = Object.freeze({
  blocked: "Blocked",
  complete: "Files published",
  completed: "Published",
  corrupt: "Corrupt",
  failed: "Failed",
  historical: "Historical",
  missing: "No files",
  pending: "Pending",
  ready: "Ready for the next step",
  running: "Running",
  stale: "Stale",
});
const stateDescriptions = Object.freeze({
  blocked: "Needs the information or the decision named in the diagnostic.",
  complete: "The files are published and intact; a manual check is required before use.",
  corrupt: "One or more published artifacts failed their check.",
  failed: "The last attempt ended in an error.",
  historical: "The record predates the file-backed lifecycle and is available as history only.",
  missing: "The declared output or a published artifact is missing.",
  ready: "The next step can start.",
  running: "One of the steps is running.",
  stale: "The inputs changed; the derived step has to be reopened and run again.",
});
const stepLabels = Object.freeze({
  get_vacancy: "Vacancy",
  research_company: "Company research",
  map_experience: "Experience mapping",
  generate_cv: "CV",
  write_cover_letter: "Cover letter",
});
const stepNumbers = Object.freeze({
  get_vacancy: "01",
  research_company: "02",
  map_experience: "03",
  generate_cv: "04",
  write_cover_letter: "05",
});
const artifactLabels = Object.freeze({
  job_description: "Job description",
  vacancy: "Vacancy facts",
  company_research: "Company research",
  application_brief: "Application brief",
  cover_letter: "Cover letter",
});
const artifactHints = Object.freeze({
  job_description: "The exact extracted source text",
  vacancy: "Structured requirements and feasibility",
  company_research: "Source coverage, claims and the Verify Gate",
  application_brief: "The selected evidence and the decisions for generation",
  cover_letter: "The published plain-text document",
});
const artifactHealthLabels = Object.freeze({
  corrupt: "corrupt",
  current: "published and intact",
  missing: "missing",
  not_published: "not published",
  recovery_required: "recovery required",
  stale: "stale",
  unavailable: "unavailable",
});
const inputHealthLabels = Object.freeze({
  corrupt: "corrupt",
  current: "match the publication snapshot",
  missing: "missing",
  not_published: "not recorded yet",
  recovery_required: "recovery required",
  stale: "changed since publication",
  unavailable: "unavailable",
});
const coverageLabels = Object.freeze({
  stated_values: "Stated values",
  products_technical_complexity: "Product and technical complexity",
  engineering_content: "Engineering content",
  other_vacancies: "Other vacancies",
  source_code_organizations: "GitHub / GitLab",
  engineering_leadership: "Engineering leadership",
  employee_profiles: "Employee profiles",
  reviews_default_language: "Reviews in the default language",
  reviews_additional_languages: "Reviews in additional languages",
  compensation: "Compensation",
  recent_news_ai_direction: "Recent news and AI direction",
  contractor_payment_logistics: "Contractor / payment logistics",
});
const analysisLabels = Object.freeze({
  companyOverview: "Company overview",
  productTechnicalComplexity: "Product and technical complexity",
  engineeringCultureSignals: "Engineering culture",
  companyValuesCulture: "Values and culture",
  keyPeople: "Key people",
  aiLiteracyEvidence: "AI-literacy",
  compensationFacts: "Compensation",
  contractorPaymentFacts: "Contractor / payment",
  interviewProcessFacts: "Interview process",
  riskSignals: "Risk signals",
  whatCompanyValuesInEngineers: "What they value in engineers",
});
const issueLabels = Object.freeze({
  artifact_corrupt: "Artifact is corrupt",
  artifact_missing: "Artifact is missing",
  input_invalid: "Input artifact is invalid",
  input_missing: "Input artifact is missing",
  input_stale: "Input artifact is stale",
  output_invalid: "Output path is invalid",
  output_missing: "Output directory is missing",
  publication_recovery_required: "The publication has to be recovered",
});
const artifactErrorLabels = Object.freeze({
  artifact_corrupt: "The file changed and no longer matches the published digest.",
  artifact_invalid_utf8: "The file is not valid UTF-8 text.",
  artifact_missing: "The published file is no longer there.",
  artifact_not_found: "This artifact is not published.",
  artifact_too_large: "The file is over the safe preview limit.",
  artifact_unavailable: "The artifact is unavailable right now.",
  historical_artifacts_unavailable: "File artifacts are not available for historical processes.",
  process_data_unavailable: "The process data failed its check.",
  publication_recovery_required: "The unfinished publication has to be recovered first.",
});
const researchStatusLabels = Object.freeze({
  blocked: "blocked",
  checked: "checked",
  "not-found": "not found",
  "n/a": "not applicable",
  pass: "pass",
});

let listRequest;
let detailRequest;
let debounceTimer;

function element(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function append(parent, ...children) {
  for (const child of children.flat()) {
    if (child !== null && child !== undefined) parent.append(child);
  }
  return parent;
}

function actionButton(label, className = "button secondary") {
  const button = element("button", className, label);
  button.type = "button";
  return button;
}

function displayValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-GB", {
    style: "unit",
    unit: value >= 1024 ? "kilobyte" : "byte",
    unitDisplay: value >= 1024 ? "short" : "long",
    maximumFractionDigits: value >= 1024 ? 1 : 0,
  }).format(value >= 1024 ? value / 1024 : value);
}

function statePill(state, extraClass = "") {
  const pill = element("span", `state-pill ${extraClass}`.trim(), stateLabels[state] ?? state);
  pill.dataset.state = state;
  return pill;
}

function createExternalLink(value, label = value) {
  const safeUrl = safeExternalUrl(value);
  if (!safeUrl) return element("span", "source-value", displayValue(value));
  const link = element("a", "external-link", label);
  link.href = safeUrl;
  link.target = "_blank";
  link.rel = "noreferrer noopener";
  return link;
}

function pageIntro({ eyebrow, title, description, actions = [] }) {
  const intro = element("section", "page-intro");
  const copy = element("div", "page-intro-copy");
  append(
    copy,
    element("div", "eyebrow", eyebrow),
    element("h1", null, title),
    element("p", "lede", description),
  );
  append(intro, copy);
  if (actions.length) {
    const actionWrap = element("div", "page-actions");
    append(actionWrap, actions);
    append(intro, actionWrap);
  }
  return intro;
}

function metadataGrid(items, className = "") {
  const list = element("dl", `metadata-grid ${className}`.trim());
  for (const item of items) {
    const wrapper = element("div", "metadata-item");
    let valueNode;
    if (item.node?.tagName === "DD") {
      valueNode = item.node;
    } else if (item.node) {
      valueNode = element("dd");
      valueNode.append(item.node);
    } else {
      valueNode = element("dd", null, displayValue(item.value));
    }
    append(wrapper, element("dt", null, item.label), valueNode);
    valueNode.classList.add("metadata-value");
    append(list, wrapper);
  }
  return list;
}

function sectionHeading(title, hint) {
  const heading = element("div", "section-heading");
  append(heading, element("h2", null, title));
  if (hint) append(heading, element("p", null, hint));
  return heading;
}

function emptyState(title, message, { action = null, kind = "" } = {}) {
  const node = element("section", `empty-state ${kind}`.trim());
  append(
    node,
    element("div", "empty-mark", kind === "error" ? "!" : "·"),
    element("h2", null, title),
    element("p", null, message),
    action,
  );
  return node;
}

function loadingState(label = "Loading…") {
  const node = element("div", "loading-state");
  const indicator = element("span", "loading-indicator");
  indicator.setAttribute("aria-hidden", "true");
  append(node, indicator, element("span", null, label));
  return node;
}

function listRouteState() {
  const params = new URLSearchParams(window.location.search);
  return {
    filter: normalizeFilter(params.get("filter") ?? "all"),
    query: params.get("q")?.trim() ?? "",
  };
}

function updateListLocation(state) {
  window.history.replaceState(null, "", listLocation({ filter: state.filter, query: state.query }));
}

function detailHref(processId) {
  const from = `${window.location.pathname}${window.location.search}`;
  const params = new URLSearchParams({ from });
  return `/processes/${encodeURIComponent(processId)}?${params}`;
}

function renderListCard(result) {
  const process = result.process;
  const companyName =
    result.company?.display_name ||
    process.company_observed ||
    process.company_hint ||
    "Company not identified";
  const card = element("a", "process-card");
  card.href = detailHref(process.id);
  card.dataset.state = process.lifecycle_state;
  card.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    window.location.assign(card.href);
  });
  const top = element("div", "card-topline");
  const identity = element("div", "card-identity");
  append(
    identity,
    element("div", "company-name", companyName),
    element("h2", "role", process.role || "Role not identified"),
  );
  append(top, identity, statePill(process.lifecycle_state));

  const source = element("span", "source-value", process.source_ref);
  const meta = metadataGrid(
    [
      { label: "Started", value: formatDate(process.started_at) },
      { label: "Source", node: source },
      {
        label: "Last step",
        value: process.last_completed_step ? stepLabels[process.last_completed_step] : "None yet",
      },
    ],
    "card-metadata",
  );
  const footer = element("div", "card-footer");
  const signals = element("div", "card-signals");
  if (process.running_steps.length) {
    append(
      signals,
      element(
        "span",
        "mini-signal running",
        `Running: ${process.running_steps.map((step) => stepLabels[step]).join(", ")}`,
      ),
    );
  }
  if (process.attention_steps.length) {
    append(
      signals,
      element(
        "span",
        "mini-signal attention",
        `Attention: ${process.attention_steps.map((step) => stepLabels[step]).join(", ")}`,
      ),
    );
  }
  if (process.readable_artifact_count > 0) {
    append(
      signals,
      element("span", "mini-signal", `${process.readable_artifact_count} file artifact`),
    );
  }
  if (process.manual_review_required) {
    append(signals, element("span", "mini-signal review", "Manual review required"));
  }
  if (process.has_cv) {
    append(signals, element("span", "mini-signal", "DOCX published; review required"));
  }
  append(footer, signals, element("span", "open-label", "Open process →"));
  append(card, top, meta, footer);
  return card;
}

function renderListResults(payload, state, nodes) {
  nodes.results.replaceChildren();
  const filteredResults = filterProcessResults(payload.results, state.filter);
  const queryDescription = payload.query ? `for "${payload.query}"` : "in the log";
  nodes.summary.textContent = `${filteredResults.length} of ${payload.count} ${queryDescription} · Newest first`;

  for (const button of nodes.filters.querySelectorAll("button")) {
    const active = button.dataset.filter === state.filter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }

  if (payload.total_processes === 0 && !payload.query) {
    nodes.results.append(
      emptyState("The log is empty", "A new file-backed process appears here once Step 1 runs."),
    );
    return;
  }
  if (!filteredResults.length) {
    const reset = actionButton("Reset search and filter");
    reset.addEventListener("click", () => {
      state.query = "";
      state.filter = "all";
      nodes.search.value = "";
      updateListLocation(state);
      loadProcessList(state, nodes);
    });
    nodes.results.append(
      emptyState("No matches", "Change the query, pick another status, or show every process.", {
        action: reset,
      }),
    );
    return;
  }
  if (filteredResults.some((result) => result.process.manual_review_required)) {
    nodes.results.append(renderManualReviewNotice());
  }
  for (const result of filteredResults) {
    nodes.results.append(renderListCard(result));
  }
}

async function loadProcessList(state, nodes) {
  listRequest?.abort();
  listRequest = new AbortController();
  nodes.summary.textContent = "Refreshing the log…";
  nodes.results.replaceChildren(loadingState("Loading processes"));
  try {
    const response = await fetch(`/api/processes?q=${encodeURIComponent(state.query)}`, {
      cache: "no-store",
      signal: listRequest.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    nodes.payload = payload;
    renderListResults(payload, state, nodes);
  } catch (error) {
    if (error.name === "AbortError") return;
    nodes.summary.textContent = "The log is unavailable";
    const retry = actionButton("Retry");
    retry.addEventListener("click", () => loadProcessList(state, nodes));
    nodes.results.replaceChildren(
      emptyState("Could not load the processes", "Check the local server and try again.", {
        action: retry,
        kind: "error",
      }),
    );
  }
}

function renderListRoute() {
  listRequest?.abort();
  detailRequest?.abort();
  document.title = "Processes · job-search-pipeline";
  const state = listRouteState();
  const fragment = document.createDocumentFragment();
  append(
    fragment,
    pageIntro({
      eyebrow: "Local lifecycle",
      title: "Processes",
      description: "Vacancies, research and application artifacts in one verifiable flow.",
    }),
  );

  const controls = element("section", "list-controls");
  controls.setAttribute("aria-label", "Search and filters");
  const searchLabel = element("label", "search-label", "Company, role or site");
  searchLabel.htmlFor = "process-search";
  const searchWrap = element("div", "search-wrap");
  const searchIcon = element("span", "search-icon", "⌕");
  searchIcon.setAttribute("aria-hidden", "true");
  const search = element("input", "search-input");
  search.id = "process-search";
  search.type = "search";
  search.autocomplete = "off";
  search.spellcheck = false;
  search.placeholder = "For example: Example Labs or example.test";
  search.value = state.query;
  append(searchWrap, searchIcon, search);

  const filterLabel = element("div", "filter-label", "Status");
  const filters = element("div", "filter-row");
  filters.setAttribute("role", "group");
  filters.setAttribute("aria-labelledby", "filter-label");
  filterLabel.id = "filter-label";
  for (const filter of processFilters) {
    const button = actionButton(filter.label, "filter-button");
    button.dataset.filter = filter.id;
    button.setAttribute("aria-pressed", String(filter.id === state.filter));
    button.classList.toggle("active", filter.id === state.filter);
    button.addEventListener("click", () => {
      state.filter = filter.id;
      updateListLocation(state);
      if (nodes.payload) renderListResults(nodes.payload, state, nodes);
      else loadProcessList(state, nodes);
    });
    filters.append(button);
  }
  const summary = element("div", "list-summary", "Loading the log…");
  summary.setAttribute("aria-live", "polite");
  append(controls, element("div", "search-control"), element("div", "filter-control"), summary);
  append(controls.children[0], searchLabel, searchWrap);
  append(controls.children[1], filterLabel, filters);

  const results = element("section", "process-list");
  results.setAttribute("aria-label", "Processes");
  const nodes = { filters, payload: null, results, search, summary };
  append(fragment, controls, results);
  mainNode.replaceChildren(fragment);

  search.addEventListener("input", () => {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      state.query = search.value.trim();
      updateListLocation(state);
      loadProcessList(state, nodes);
    }, 160);
  });
  loadProcessList(state, nodes);
}

function detailBackHref() {
  const from = new URLSearchParams(window.location.search).get("from");
  if (!from) return "/";
  try {
    const target = new URL(from, window.location.origin);
    if (target.origin !== window.location.origin || target.pathname !== "/") {
      return "/";
    }
    return `${target.pathname}${target.search}`;
  } catch {
    return "/";
  }
}

function renderDetailMeta(detail) {
  const process = detail.process;
  const sourceNode = element("dd");
  sourceNode.append(createExternalLink(process.source_ref));
  return metadataGrid(
    [
      { label: "Started", value: formatDate(process.started_at) },
      { label: "Updated", value: formatDate(process.updated_at) },
      { label: "Source", node: sourceNode },
      { label: "Process ID", value: process.id },
      { label: "Runner", value: process.runner },
      { label: "Output", value: process.output_dir || "Not reserved" },
      {
        label: "Company cluster",
        value: detail.company?.display_name || "Not linked",
      },
    ],
    "detail-metadata",
  );
}

function renderLifecycleNotice(detail) {
  const lifecycle = detail.lifecycle;
  const notice = element("section", "lifecycle-notice");
  notice.dataset.state = lifecycle.state;
  append(
    notice,
    statePill(lifecycle.state, "large"),
    element(
      "p",
      null,
      stateDescriptions[lifecycle.state] ?? "The state comes from the verified lifecycle ledger.",
    ),
  );
  const flags = element("div", "notice-signals");
  if (lifecycle.has_corrupt) append(flags, element("span", null, "Corruption present"));
  if (lifecycle.has_missing) append(flags, element("span", null, "Gaps present"));
  if (lifecycle.has_stale) append(flags, element("span", null, "Stale inputs present"));
  if (lifecycle.actionable_steps.length) {
    append(
      flags,
      element(
        "span",
        null,
        `Available: ${lifecycle.actionable_steps.map((step) => stepLabels[step]).join(", ")}`,
      ),
    );
  }
  append(notice, flags);
  return notice;
}

function renderManualReviewNotice() {
  const notice = element("section", "manual-review-notice");
  notice.setAttribute("role", "note");
  append(
    notice,
    element("h2", null, "Manual review required"),
    element(
      "p",
      null,
      "Publication health does not prove source fidelity, factuality, freshness or the quality of the materials.",
    ),
    element("code", "review-checklist-path", "docs/runbooks/application-readiness-checklist.md"),
  );
  return notice;
}

function renderTimeline(detail) {
  const section = element("section", "detail-section timeline-section");
  append(
    section,
    sectionHeading(
      "Pipeline",
      "Five fixed steps; Steps 4 and 5 are independent consumers of Step 3.",
    ),
  );
  const timeline = element("ol", "timeline");
  for (const step of detail.steps) {
    const item = element("li", "timeline-step");
    item.dataset.state = step.state;
    const marker = element("div", "timeline-marker", stepNumbers[step.name]);
    const body = element("div", "timeline-body");
    const heading = element("div", "timeline-heading");
    append(heading, element("h3", null, stepLabels[step.name] ?? step.name), statePill(step.state));
    append(body, heading);
    const health = element("div", "health-row");
    append(
      health,
      element(
        "span",
        null,
        `Artifacts: ${artifactHealthLabels[step.artifact_health] ?? step.artifact_health}`,
      ),
      element("span", null, `Inputs: ${inputHealthLabels[step.input_health] ?? step.input_health}`),
    );
    append(body, health);
    if (step.diagnostic) {
      append(
        body,
        element(
          "p",
          "step-diagnostic",
          `${step.diagnostic.type === "blocker" ? "Blocker" : "Error"}: ${step.diagnostic.code}${step.diagnostic.retryable ? " · retryable" : ""}`,
        ),
      );
    }
    if (step.issues.length) {
      const issues = element("ul", "issue-list");
      for (const issue of step.issues) {
        append(issues, element("li", null, issueLabels[issue] ?? issue));
      }
      append(body, issues);
    }
    const time = step.finished_at ?? step.updated_at ?? step.started_at;
    append(body, element("p", "timeline-time", time ? formatDate(time) : "No attempts yet"));
    append(item, marker, body);
    timeline.append(item);
  }
  append(section, timeline);
  return section;
}

function simpleTable(headers, rows) {
  const wrap = element("div", "table-wrap");
  const table = element("table", "data-table");
  const head = element("thead");
  const headRow = element("tr");
  for (const header of headers) headRow.append(element("th", null, header));
  head.append(headRow);
  const body = element("tbody");
  for (const row of rows) {
    const line = element("tr");
    row.forEach((value, index) => {
      const cell = element("td", null, displayValue(value));
      cell.dataset.label = headers[index];
      line.append(cell);
    });
    body.append(line);
  }
  append(table, head, body);
  wrap.append(table);
  return wrap;
}

function semanticSection(title, content, className = "") {
  const section = element("section", `semantic-section ${className}`.trim());
  append(section, element("h3", null, title), content);
  return section;
}

function unorderedTextList(values, emptyText = "No data") {
  if (!values?.length) return element("p", "muted", emptyText);
  const list = element("ul", "semantic-list");
  for (const value of values) list.append(element("li", null, value));
  return list;
}

function renderVacancy(data) {
  const root = element("div", "semantic-view");
  const role = data.role ?? {};
  const feasibility = role.feasibility ?? {};
  append(
    root,
    semanticSection(
      "Role",
      metadataGrid(
        [
          { label: "Company", value: role.company },
          { label: "Title", value: role.title },
          { label: "ATS", value: role.ats },
          { label: "Language", value: role.vacancyLanguage },
          { label: "Market", value: role.market?.value },
          { label: "Market evidence", value: role.market?.evidence },
        ],
        "semantic-metadata",
      ),
    ),
    semanticSection(
      "Feasibility",
      metadataGrid(
        [
          {
            label: "Work model",
            value: feasibility.workModel?.sourceText || feasibility.workModel?.normalized,
          },
          { label: "Locations", value: feasibility.locations },
          { label: "Employment", value: feasibility.employmentType },
          { label: "Timezone", value: feasibility.timezoneOverlap },
          {
            label: "Authorization / residency",
            value: feasibility.workAuthorizationResidency,
          },
          { label: "Relocation / visa", value: feasibility.relocationVisaSupport },
          { label: "Salary", value: feasibility.salary },
        ],
        "semantic-metadata",
      ),
    ),
  );
  const sections = Object.entries(data.sectionIndex ?? {}).map(([name, value]) => [
    {
      responsibilities: "Responsibilities",
      requirements: "Requirements",
      niceToHaves: "Nice to haves",
    }[name] ?? name,
    value.presence,
    value.sourceHeadings,
    value.embeddedIn,
  ]);
  append(
    root,
    semanticSection(
      "JD structure",
      simpleTable(["Section", "Presence", "Source headings", "Embedded in"], sections),
    ),
  );
  const ambiguityList = (data.ambiguities ?? []).map(
    (item) => `${item.code}: ${item.question}${item.blocking ? " (blocking)" : ""}`,
  );
  append(
    root,
    semanticSection("Ambiguities", unorderedTextList(ambiguityList, "No blocking ambiguities.")),
  );
  return root;
}

function renderResearchClaims(block) {
  const node = element("div", "analysis-block");
  append(node, element("p", "analysis-summary", block.summary));
  if (block.classification) {
    append(node, element("div", "classification", `Class: ${block.classification}`));
  }
  const claims = element("div", "claim-list");
  for (const claim of block.claims ?? []) {
    const card = element("article", "claim-card");
    append(
      card,
      element("span", "claim-id", claim.id),
      element("p", null, claim.text),
      element(
        "small",
        null,
        `${claim.evidenceStatus} · ${claim.sourceIds?.join(", ") || "no source"}${claim.scope ? ` · ${claim.scope}` : ""}`,
      ),
    );
    if (claim.inferenceBasis) {
      append(card, element("p", "inference", `Basis: ${claim.inferenceBasis}`));
    }
    claims.append(card);
  }
  if (!claims.children.length) claims.append(element("p", "muted", "No claims."));
  append(node, claims);
  return node;
}

function renderCompanyResearch(data) {
  const root = element("div", "semantic-view");
  const gate = element("div", "verify-gate");
  gate.dataset.status = data.verifyGate?.status ?? "unknown";
  append(
    gate,
    element("div", "eyebrow", "Verify Gate"),
    element(
      "strong",
      null,
      researchStatusLabels[data.verifyGate?.status] ?? data.verifyGate?.status,
    ),
    element("span", null, `${data.verifyGate?.checkedInvariants?.length ?? 0} invariants`),
  );
  append(root, gate);

  const coverageRows = (data.sourceCoverage ?? []).map((row) => [
    coverageLabels[row.category] ?? row.category,
    researchStatusLabels[row.status] ?? row.status,
    row.confidence,
    row.sourceIds,
  ]);
  append(
    root,
    semanticSection(
      "Source coverage",
      simpleTable(["Category", "Status", "Confidence", "Sources"], coverageRows),
    ),
  );

  const analysis = element("div", "analysis-grid");
  for (const [key, block] of Object.entries(data.analysis ?? {})) {
    const card = element("section", "analysis-card");
    append(card, element("h4", null, analysisLabels[key] ?? key), renderResearchClaims(block));
    analysis.append(card);
  }
  append(root, semanticSection("Analysis", analysis));

  const hooks = element("div", "compact-card-grid");
  for (const hook of data.tailoringHooks ?? []) {
    const card = element("article", "compact-card");
    append(
      card,
      element("span", "claim-id", hook.id),
      element("h4", null, hook.challengeType),
      element("p", null, hook.fact),
      element(
        "small",
        null,
        `Claims: ${hook.claimIds.join(", ")} · Sources: ${hook.sourceIds.join(", ")}`,
      ),
    );
    hooks.append(card);
  }
  if (!hooks.children.length) hooks.append(element("p", "muted", "No hooks."));
  append(root, semanticSection("Tailoring hooks", hooks));

  const questions = (data.openQuestions ?? []).map(
    (item) => `${item.id} · ${item.decisionWeight}: ${item.question}`,
  );
  append(
    root,
    semanticSection("Open questions", unorderedTextList(questions, "No open questions.")),
  );

  const sourceList = element("div", "source-list");
  for (const source of data.sources ?? []) {
    const details = element("details", "source-card");
    const summary = element(
      "summary",
      null,
      `${source.id} · ${source.title || source.owner || source.sourceType}`,
    );
    const body = element("div", "source-card-body");
    append(
      body,
      createExternalLink(source.url),
      element("p", "muted", `${source.sourceType} · ${formatDate(source.observedAt)}`),
    );
    for (const quote of source.quotes ?? []) {
      const quoteNode = element("blockquote");
      append(
        quoteNode,
        element("p", null, quote.original),
        element("p", "translation", quote.translation),
      );
      body.append(quoteNode);
    }
    append(details, summary, body);
    sourceList.append(details);
  }
  append(root, semanticSection("Sources", sourceList));
  return root;
}

// Priority evidence and traits are separate contract shapes and therefore separate renderers: one
// renderer over both is what previously hid `category` behind `priority` and printed a trait's
// separator with nothing after it.
function compactCardGrid(cards) {
  const grid = element("div", "compact-card-grid");
  for (const card of cards) grid.append(card);
  if (!grid.children.length) grid.append(element("p", "muted", "No selected entries."));
  return grid;
}

function renderPriorityEvidenceCards(items) {
  return compactCardGrid(
    (items ?? []).map((item) => {
      const view = priorityEvidenceCardView(item);
      const card = element("article", "compact-card");
      append(
        card,
        element("span", "claim-id", `${view.id} · ${view.meta}`),
        element("h4", null, view.claim),
        unorderedTextList(view.proof),
        element("small", null, view.sourceLine),
      );
      return card;
    }),
  );
}

function renderTraitCards(items) {
  return compactCardGrid(
    (items ?? []).map((item) => {
      const view = traitCardView(item);
      const card = element("article", "compact-card");
      append(
        card,
        element("span", "claim-id", view.id),
        element("h4", null, view.trait),
        element("p", null, view.behavior),
        element("small", null, view.sourceLine),
      );
      return card;
    }),
  );
}

function renderGapCards(gaps) {
  const grid = element("div", "compact-card-grid");
  for (const gap of gaps ?? []) {
    const view = gapCardView(gap);
    const card = element("article", "compact-card gap-card");
    // One contract value feeds both the visible text and the attribute, so no label map can drift
    // away from the enum for a brief the validator accepts. For a brief that does not satisfy the
    // schema the two do diverge — an absent classification renders empty text beside
    // `data-classification="undefined"` — and that is the validator's failure to report, not
    // something this renderer papers over.
    const classification = element("span", "gap-classification", view.classification);
    classification.dataset.classification = view.classification;
    append(
      card,
      element("span", "claim-id", view.id),
      classification,
      element("h4", null, view.requirement),
      element("p", null, view.framing),
      element("small", null, gapSupportLine(view)),
    );
    grid.append(card);
  }
  if (!grid.children.length) grid.append(element("p", "muted", "No declared gaps."));
  return grid;
}

function renderApplicationBrief(data) {
  const root = element("div", "semantic-view");
  const positioning = data.positioning ?? {};
  const positionBlock = element("div", "positioning-block");
  append(
    positionBlock,
    metadataGrid(
      [
        { label: "Angle", value: positioning.angleHint },
        { label: "AI register", value: positioning.aiRegister },
        { label: "Challenge", value: data.company?.challengeType },
      ],
      "semantic-metadata",
    ),
  );
  for (const lever of positioning.selectedLevers ?? []) {
    const card = element("article", "lever-card");
    append(
      card,
      element("span", "claim-id", `Lever ${lever.id}`),
      element("h4", null, lever.wording),
      element("p", null, lever.rationale),
      element("small", null, `Evidence: ${lever.evidenceAnchors.join(", ")}`),
    );
    positionBlock.append(card);
  }
  append(root, semanticSection("Positioning", positionBlock));

  append(
    root,
    semanticSection(
      "Selected evidence",
      renderPriorityEvidenceCards(data.experience?.priorityEvidence),
    ),
    semanticSection("Traits", renderTraitCards(data.experience?.traits)),
  );

  append(root, semanticSection("Gaps", renderGapCards(data.experience?.gaps)));

  const keywordRows = (data.ats?.keywords ?? []).map((keyword) => [
    keyword.term,
    keyword.support?.status,
    keyword.support?.evidenceIds ?? keyword.support?.gapId,
    keyword.placements,
    keyword.placementMode,
  ]);
  append(
    root,
    semanticSection(
      "ATS plan",
      simpleTable(["Keyword", "Support", "Evidence / gap", "Placements", "Mode"], keywordRows),
    ),
  );

  const cvPlan = data.cvPlan ?? {};
  const cvContent = element("div", "plan-stack");
  append(
    cvContent,
    metadataGrid(
      [
        { label: "Structure", value: cvPlan.structure },
        { label: "Header", value: cvPlan.headerPositioning?.text },
        { label: "Project", value: cvPlan.projectDecision?.decision },
        { label: "Project rationale", value: cvPlan.projectDecision?.rationale },
      ],
      "semantic-metadata",
    ),
  );
  const checks = (cvPlan.checks?.requiredEvidence ?? []).map(
    (check) => `${check.id}: ${check.description}`,
  );
  append(cvContent, unorderedTextList(checks, "No required evidence checks."));
  append(root, semanticSection("CV plan", cvContent));

  const letterPlan = data.coverLetterPlan ?? {};
  append(
    root,
    semanticSection(
      "Cover letter plan",
      metadataGrid(
        [
          { label: "Evidence", value: letterPlan.evidenceIds },
          { label: "Keywords", value: letterPlan.keywordTerms },
        ],
        "semantic-metadata",
      ),
    ),
  );
  return root;
}

function renderJsonArtifact(kind, data) {
  if (kind === "vacancy") return renderVacancy(data);
  if (kind === "company_research") return renderCompanyResearch(data);
  if (kind === "application_brief") return renderApplicationBrief(data);
  return element("pre", "artifact-text raw-json", JSON.stringify(data, null, 2));
}

function renderArtifactContent(artifact, rawText) {
  if (!["vacancy", "company_research", "application_brief"].includes(artifact.kind)) {
    return element("pre", "artifact-text", rawText);
  }
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    return emptyState(
      "The JSON does not parse",
      "The file passed the transport check, but the browser parser could not open it.",
      { kind: "error" },
    );
  }
  const wrapper = element("div", "artifact-renderer");
  const modes = element("div", "view-switch");
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "JSON view mode");
  const semanticButton = actionButton("Semantic view", "view-button active");
  const rawButton = actionButton("Raw JSON", "view-button");
  semanticButton.setAttribute("aria-pressed", "true");
  rawButton.setAttribute("aria-pressed", "false");
  const content = element("div", "artifact-mode-content");
  const showSemantic = () => {
    semanticButton.classList.add("active");
    rawButton.classList.remove("active");
    semanticButton.setAttribute("aria-pressed", "true");
    rawButton.setAttribute("aria-pressed", "false");
    content.replaceChildren(renderJsonArtifact(artifact.kind, data));
  };
  const showRaw = () => {
    rawButton.classList.add("active");
    semanticButton.classList.remove("active");
    rawButton.setAttribute("aria-pressed", "true");
    semanticButton.setAttribute("aria-pressed", "false");
    content.replaceChildren(
      element("pre", "artifact-text raw-json", JSON.stringify(data, null, 2)),
    );
  };
  semanticButton.addEventListener("click", showSemantic);
  rawButton.addEventListener("click", showRaw);
  append(modes, semanticButton, rawButton);
  append(wrapper, modes, content);
  showSemantic();
  return wrapper;
}

function renderArtifactError(container, error, retry) {
  const retryButton = actionButton("Retry");
  retryButton.addEventListener("click", retry);
  container.replaceChildren(
    emptyState(
      "Artifact unavailable",
      artifactErrorLabels[error.code] ?? "The published file could not be read safely.",
      { action: retryButton, kind: "error" },
    ),
  );
}

function renderArtifactWorkspace(detail) {
  const section = element("section", "detail-section artifacts-section");
  append(
    section,
    sectionHeading(
      "Artifacts",
      "The reader opens only the web-readable kinds registered in the ledger.",
    ),
  );
  if (!detail.artifacts.length) {
    append(
      section,
      emptyState(
        "No readable artifacts yet",
        detail.process.output_dir
          ? "The current step has not published a file the browser reader can open."
          : "The output directory is not reserved yet.",
      ),
    );
    return section;
  }

  const workspace = element("div", "artifact-workspace");
  const navigation = element("nav", "artifact-navigation");
  navigation.setAttribute("aria-label", "Process artifacts");
  const reader = element("div", "artifact-reader");
  const cache = new Map();
  const buttons = new Map();

  async function selectArtifact(artifact) {
    for (const [kind, button] of buttons) {
      const selected = kind === artifact.kind;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-current", selected ? "true" : "false");
    }
    const title = element("div", "reader-heading");
    append(
      title,
      element("div", "eyebrow", `${stepNumbers[artifact.step]} · ${stepLabels[artifact.step]}`),
      element("h3", null, artifactLabels[artifact.kind] ?? artifact.kind),
      element("p", null, `${artifactHints[artifact.kind] ?? ""} · ${formatBytes(artifact.bytes)}`),
    );
    const content = element("div", "reader-content");
    reader.replaceChildren(title, content);
    content.replaceChildren(loadingState("Reading and verifying the file"));
    try {
      // The cache hit renders inside the same guard as the first read. The artifact endpoint verifies
      // the digest, not the schema, so a few shapes throw inside the renderer, and reopening such an
      // artifact would otherwise leave an empty reader body. Defensive: no fixture in this repository
      // produces a brief that parses and then fails to render, so this branch is untested for the
      // failing case; the reopen assertion covers only the valid one.
      if (cache.has(artifact.kind)) {
        content.replaceChildren(renderArtifactContent(artifact, cache.get(artifact.kind)));
        return;
      }
      const response = await fetch(artifact.read_url, { cache: "no-store" });
      if (!response.ok) {
        let code = "artifact_unavailable";
        try {
          code = (await response.json()).error ?? code;
        } catch {
          // The public endpoint intentionally exposes only stable JSON errors.
        }
        throw Object.assign(new Error(code), { code });
      }
      const text = await response.text();
      cache.set(artifact.kind, text);
      content.replaceChildren(renderArtifactContent(artifact, text));
    } catch (error) {
      renderArtifactError(content, error, () => {
        cache.delete(artifact.kind);
        selectArtifact(artifact);
      });
    }
  }

  for (const artifact of detail.artifacts) {
    const button = actionButton("", "artifact-nav-button");
    const label = element("span", null, artifactLabels[artifact.kind] ?? artifact.kind);
    const hint = element(
      "small",
      null,
      `${stepNumbers[artifact.step]} · ${formatBytes(artifact.bytes)}`,
    );
    append(button, label, hint);
    button.addEventListener("click", () => selectArtifact(artifact));
    buttons.set(artifact.kind, button);
    navigation.append(button);
  }
  append(workspace, navigation, reader);
  append(section, workspace);
  selectArtifact(detail.artifacts[0]);
  return section;
}

function renderCvCard(detail) {
  const section = element("section", "detail-section cv-section");
  append(
    section,
    sectionHeading("CV", "CV content is deliberately kept out of the browser preview."),
  );
  const card = element("div", "cv-card");
  const icon = element("div", "cv-icon", "DOCX");
  const body = element("div", "cv-card-body");
  const status = detail.cv?.status ?? "pending";
  append(
    body,
    element(
      "h3",
      null,
      detail.cv?.docx_path ? "DOCX published; review required" : "DOCX not published yet",
    ),
    element(
      "p",
      null,
      detail.cv?.docx_path
        ? "Preview and download are off. Check every rendered page against the checklist."
        : `Step 4 state: ${stateLabels[status] ?? status}.`,
    ),
  );
  if (detail.cv?.docx_path) {
    const path = element("code", "cv-path", detail.cv.docx_path);
    const copy = actionButton("Copy path", "button primary");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(detail.cv.docx_path);
        copy.textContent = "Path copied";
      } catch {
        copy.textContent = "Select the path by hand";
        path.focus();
      }
    });
    path.tabIndex = 0;
    append(body, path, copy);
  }
  append(card, icon, body);
  append(section, card);
  return section;
}

function renderHistoricalDetail(detail) {
  return emptyState(
    "File artifacts unavailable",
    "This is an immutable historical record from schema v2. The lifecycle is not reconstructed from old output files, so the timeline and the reader are deliberately empty.",
  );
}

function renderDetail(detail) {
  const process = detail.process;
  const companyName =
    detail.company?.display_name ||
    process.company_observed ||
    process.company_hint ||
    "Company not identified";
  document.title = `${companyName} · ${process.role || "Process"}`;
  const back = element("a", "back-link", "← Back to processes");
  back.href = detailBackHref();
  const headerActions = element("div", "detail-header-actions");
  append(headerActions, statePill(detail.lifecycle.state, "large"));
  const fragment = document.createDocumentFragment();
  append(
    fragment,
    back,
    pageIntro({
      eyebrow: process.mode === "historical" ? "Historical record" : "File-backed process",
      title: companyName,
      description: process.role || "Role not identified yet",
      actions: [headerActions],
    }),
    renderLifecycleNotice(detail),
    detail.lifecycle.manual_review_required ? renderManualReviewNotice() : null,
    renderDetailMeta(detail),
  );

  if (process.mode === "historical") {
    append(fragment, renderHistoricalDetail(detail));
  } else {
    append(fragment, renderTimeline(detail), renderArtifactWorkspace(detail), renderCvCard(detail));
  }
  mainNode.replaceChildren(fragment);
}

async function renderDetailRoute(processId) {
  listRequest?.abort();
  detailRequest?.abort();
  detailRequest = new AbortController();
  document.title = "Loading the process…";
  mainNode.replaceChildren(loadingState("Loading the process"));
  try {
    const response = await fetch(`/api/processes/${encodeURIComponent(processId)}`, {
      cache: "no-store",
      signal: detailRequest.signal,
    });
    if (response.status === 404) {
      mainNode.replaceChildren(
        emptyState("Process not found", "The link may be stale, or the process id may be wrong.", {
          action: Object.assign(element("a", "button secondary", "Back to the list"), {
            href: "/",
          }),
        }),
      );
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderDetail(await response.json());
  } catch (error) {
    if (error.name === "AbortError") return;
    const retry = actionButton("Retry");
    retry.addEventListener("click", () => renderDetailRoute(processId));
    mainNode.replaceChildren(
      emptyState(
        "Could not load the process",
        "The verified detail data is unavailable right now.",
        { action: retry, kind: "error" },
      ),
    );
  }
}

function renderUnknownRoute() {
  document.title = "Page not found · job-search-pipeline";
  const home = element("a", "button secondary", "Back to processes");
  home.href = "/";
  mainNode.replaceChildren(
    emptyState("Page not found", "The local reader has a process list and detail pages.", {
      action: home,
    }),
  );
}

function renderRoute() {
  const route = parseAppRoute(window.location.pathname);
  if (route.name === "list") renderListRoute();
  else if (route.name === "detail") renderDetailRoute(route.processId);
  else renderUnknownRoute();
}

window.addEventListener("popstate", renderRoute);
renderRoute();
