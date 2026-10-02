import assert from "node:assert/strict";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createInitialFileBackedProcess,
  createPendingFileBackedStep,
} from "../tools/lib/process-log-v3-lifecycle.mjs";
import { createProcessSearchServer } from "../tools/process-search-server.mjs";
import { sha256Hex } from "../tools/pipeline-artifacts/validation.mjs";
import {
  assertDisposableWorkspace,
  createDisposableWorkspace,
} from "./fixtures/disposable-workspace.mjs";
import { createProcessSearchUiFixture } from "./fixtures/process-search-ui.mjs";
import { seedCandidateConfig } from "./fixtures/protected-inputs.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staticRoot = resolve(repoRoot, "web/process-search");
// The whole served directory is frozen, not just its scripts, so a module carrying a different
// extension still has to appear here as a visible diff. Note what that does and does not buy: the
// negative scan below covers `.js` only, and what actually keeps an `.mjs` from being loaded is the
// MIME allowlist in `tools/process-search-server.mjs`, which serves `.css`, `.html` and `.js` only.
const frontendFiles = Object.freeze([
  "app.js",
  "application-brief-view.js",
  "index.html",
  "styles.css",
  "view-model.js",
]);
const frontendModules = Object.freeze(
  frontendFiles.filter((name) => name.endsWith(".js")),
);
// Reads the application-brief card renderers must never perform, written as receiver/key pairs
// because the names are not globally forbidden: `term` is a real contract key on `ats.keywords[]`
// and `description` on `cvPlan.checks.requiredEvidence[]`, both of which `app.js` reads legitimately
// through other receivers. Bounds of this pin, stated rather than implied: it is identifier-scoped,
// so renaming a loop variable makes it unreachable; it tolerates optional chaining but not bracket
// access or destructuring; and a newly invented name is not caught at all. Inside
// `application-brief-view.js` the unit read guard covers all of those; `app.js` has no importable
// surface and therefore no equivalent guard.
const briefCardAbsentReads = Object.freeze([
  ["gap", "term"],
  ["gap", "gap"],
  ["gap", "description"],
  ["gap", "transferableEvidence"],
  ["item", "term"],
]);
const processId = "proc_fixture_step1_completed";
const failedProcessId = "proc_fixture_failed_private";
const historicalProcessId = "proc_historical_search";
const sourceRef = "https://example.test/jobs/senior-quality-engineer";
const outputDir = "output/example-labs-senior-quality-engineer";
const secretMarker = "SECRET_WEB_DTO_MARKER_73b4";
const secretDiagnosticDetail = "PRIVATE_WEB_INTERNAL_DETAIL_73b4";
const timestamps = Object.freeze({
  historical: "2026-07-20T08:00:00.000Z",
  process: "2026-07-23T10:00:00.000Z",
  vacancy: "2026-07-23T10:10:00.000Z",
  failed: "2026-07-23T11:00:00.000Z",
  ledger: "2026-07-23T12:30:00.000Z",
});
const vacancyFixtureRoot = resolve(
  repoRoot,
  "tools/pipeline-artifacts/fixtures/vacancy-v2-completed",
);

function artifactMetadata(kind, path, schemaVersion, absolutePath) {
  const bytes = readFileSync(absolutePath);
  return {
    kind,
    path,
    schema_version: schemaVersion,
    sha256: sha256Hex(bytes),
    bytes: bytes.byteLength,
  };
}

function completedStep({ artifacts, finishedAt, publicationId, startedAt }) {
  return {
    state: "completed",
    attempt: 1,
    revision: 1,
    started_at: startedAt,
    updated_at: finishedAt,
    finished_at: finishedAt,
    published_inputs: [],
    artifacts: structuredClone(artifacts),
    active_attempt: null,
    publication_transaction: null,
    attempt_history: [{
      attempt: 1,
      outcome: "completed",
      started_at: startedAt,
      finished_at: finishedAt,
      input_snapshot: [],
      error_code: null,
      publication_id: publicationId,
    }],
    error: null,
    blocker: null,
  };
}

function failedPrivateProcess() {
  const process = createInitialFileBackedProcess({
    attemptId: "attempt_private_failure",
    processId: failedProcessId,
    runner: "codex",
    sourceRef: "https://private.example.test/jobs/failed",
    startedAt: timestamps.process,
  });
  process.updated_at = timestamps.failed;
  process.steps.get_vacancy = {
    state: "failed",
    attempt: 1,
    revision: 0,
    started_at: timestamps.process,
    updated_at: timestamps.failed,
    finished_at: timestamps.failed,
    published_inputs: [],
    artifacts: [],
    active_attempt: null,
    publication_transaction: null,
    attempt_history: [{
      attempt: 1,
      outcome: "failed",
      started_at: timestamps.process,
      finished_at: timestamps.failed,
      input_snapshot: [],
      error_code: "synthetic_private_failure",
      publication_id: null,
    }],
    error: {
      code: "synthetic_private_failure",
      message: "Synthetic internal error for the DTO check.",
      at: timestamps.failed,
      retryable: true,
      details: [secretMarker, secretDiagnosticDetail],
    },
    blocker: null,
  };
  return process;
}

function historicalProcess() {
  return {
    id: historicalProcessId,
    started_at: timestamps.historical,
    source_ref: "historical-fixture:search",
    source_key: "historical-fixture:search",
    company_id: "company_example",
    company_observed: "Example Project",
    company_hint: null,
    role: "QA Engineer",
    runner: "claude-ai-web",
    output_dir: "output/historical-must-not-be-read",
    status: "output_created",
    duplicate_of: null,
  };
}

function baseLog(processes = [historicalProcess()]) {
  return {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: timestamps.ledger,
    companies: [{
      id: "company_example",
      display_name: "Example Labs",
      search_terms: ["Example Labs", "Пример"],
      domains: ["example.test"],
    }],
    processes,
  };
}

function createHistoricalEnvironment(t) {
  const disposable = createDisposableWorkspace(t, {
    ledger: baseLog(),
    prefix: "job-search-server-historical-",
  });
  return {
    ...disposable,
    logPath: disposable.ledgerPath,
    selectedOutputPath: null,
  };
}

function createArtifactEnvironment(t) {
  const disposable = createDisposableWorkspace(t, {
    prefix: "job-search-server-artifact-",
  });
  const { ledgerPath, outputRoot, workspaceRoot } = disposable;
  const selectedOutputPath = join(
    outputRoot,
    outputDir.slice("output/".length),
  );
  mkdirSync(selectedOutputPath, { recursive: true });
  // The vacancy names one of the example's markets, which the health check reads from the layer.
  seedCandidateConfig(repoRoot, workspaceRoot);
  for (const fileName of ["job-description.txt", "vacancy.json"]) {
    copyFileSync(
      join(vacancyFixtureRoot, fileName),
      join(selectedOutputPath, fileName),
    );
  }
  writeFileSync(
    join(selectedOutputPath, "unregistered.txt"),
    `${secretMarker}\n`,
    "utf8",
  );
  writeFileSync(
    join(selectedOutputPath, "cv.json"),
    `${JSON.stringify({ secret: secretMarker })}\n`,
    "utf8",
  );

  const jobDescription = artifactMetadata(
    "job_description",
    "job-description.txt",
    null,
    join(selectedOutputPath, "job-description.txt"),
  );
  const vacancy = artifactMetadata(
    "vacancy",
    "vacancy.json",
    2,
    join(selectedOutputPath, "vacancy.json"),
  );
  const process = {
    id: processId,
    started_at: timestamps.process,
    updated_at: timestamps.vacancy,
    source_ref: sourceRef,
    source_key: sourceRef,
    company_id: "company_example",
    company_observed: "Example Labs",
    company_hint: "Example",
    role: "Senior Quality Engineer",
    runner: "codex",
    output_dir: outputDir,
    artifact_mode: "file-backed",
    steps: {
      get_vacancy: completedStep({
        artifacts: [jobDescription, vacancy],
        finishedAt: timestamps.vacancy,
        publicationId: "publication_server_vacancy",
        startedAt: timestamps.process,
      }),
      research_company: createPendingFileBackedStep(),
      map_experience: createPendingFileBackedStep(),
      generate_cv: createPendingFileBackedStep(),
      write_cover_letter: createPendingFileBackedStep(),
    },
    duplicate_of: null,
  };
  const log = baseLog([
    historicalProcess(),
    process,
    failedPrivateProcess(),
  ]);
  const logPath = ledgerPath;
  writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  return {
    ...disposable,
    jobDescription,
    logPath,
    outputRoot,
    selectedOutputPath,
    vacancy,
    workspaceRoot,
  };
}

async function startFixtureServer(t, environment, options = {}) {
  assertDisposableWorkspace({
    ...environment,
    ledgerPath: environment.logPath,
  });
  const server = createProcessSearchServer({
    artifactAccessEnabled: options.artifactAccessEnabled ?? true,
    artifactPreviewMaxBytes:
      options.artifactPreviewMaxBytes ?? 1024 * 1024,
    logPath: environment.logPath,
    outputRoot: environment.outputRoot,
    staticRoot,
    workspaceRoot: environment.workspaceRoot,
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => server.close());
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, port };
}

function rawRequest(port, path, method = "GET") {
  return new Promise((resolveRequest, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path, method },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolveRequest({
            status: response.statusCode,
            headers: response.headers,
            body,
          }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("serves the UI and allowlisted v3 list API without caching", async (t) => {
  const environment = createHistoricalEnvironment(t);
  const { baseUrl } = await startFixtureServer(t, environment);
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(
    page.headers.get("cross-origin-resource-policy"),
    "same-origin",
  );
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const pageText = await page.text();
  assert.match(pageText, /Processes/);
  assert.match(pageText, /Local only/);

  const response = await fetch(
    `${baseUrl}/api/processes?q=${encodeURIComponent("Пример")}`,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const payload = await response.json();
  assert.equal(payload.count, 1);
  assert.equal(payload.results[0].matched_by.type, "exact");
  assert.equal(payload.results[0].process.mode, "historical");
  assert.equal(payload.results[0].process.lifecycle_state, "historical");
  assert.equal(payload.results[0].process.readable_artifact_count, 0);
  assert.equal(payload.results[0].process.has_cv, false);
  assert.equal(Object.hasOwn(payload.results[0].process, "status"), false);
});

test("reads the v3 ledger again for every API request", async (t) => {
  const environment = createHistoricalEnvironment(t);
  const { baseUrl } = await startFixtureServer(t, environment);
  assert.equal((await (await fetch(`${baseUrl}/api/processes`)).json()).count, 1);
  const changed = baseLog([]);
  changed.updated_at = "2026-07-23T13:00:00.000Z";
  writeFileSync(
    environment.logPath,
    `${JSON.stringify(changed, null, 2)}\n`,
    "utf8",
  );
  assert.equal((await (await fetch(`${baseUrl}/api/processes`)).json()).count, 0);
});

test("returns historical detail without inspecting or exposing artifacts", async (t) => {
  const environment = createHistoricalEnvironment(t);
  const { baseUrl } = await startFixtureServer(t, environment);
  const response = await fetch(
    `${baseUrl}/api/processes/${historicalProcessId}`,
  );
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.process.mode, "historical");
  assert.equal(detail.process.output_dir, "output/historical-must-not-be-read");
  assert.deepEqual(detail.steps, []);
  assert.deepEqual(detail.artifacts, []);
  assert.equal(detail.cv, null);
  assert.deepEqual(detail.historical, {
    artifacts_available: false,
    code: "historical_artifacts_unavailable",
  });
});

test("list/detail DTOs do not disclose raw ledger internals", async (t) => {
  const environment = createArtifactEnvironment(t);
  const { baseUrl } = await startFixtureServer(t, environment);
  const listResponse = await fetch(`${baseUrl}/api/processes`);
  assert.equal(listResponse.status, 200);
  const listText = await listResponse.text();
  assert.doesNotMatch(listText, new RegExp(secretMarker));
  assert.doesNotMatch(listText, new RegExp(secretDiagnosticDetail));
  assert.doesNotMatch(listText, new RegExp(environment.jobDescription.sha256));
  assert.doesNotMatch(listText, /active_attempt|attempt_history|published_inputs/);

  const detailResponse = await fetch(
    `${baseUrl}/api/processes/${failedProcessId}`,
  );
  assert.equal(detailResponse.status, 200);
  const detailText = await detailResponse.text();
  assert.doesNotMatch(detailText, new RegExp(secretMarker));
  assert.doesNotMatch(detailText, new RegExp(secretDiagnosticDetail));
  assert.doesNotMatch(detailText, /details|message|active_attempt|attempt_history/);
  const detail = JSON.parse(detailText);
  const failed = detail.steps.find((step) => step.name === "get_vacancy");
  assert.deepEqual(failed.diagnostic, {
    type: "error",
    code: "synthetic_private_failure",
    retryable: true,
  });

  const artifactDetail = await (
    await fetch(`${baseUrl}/api/processes/${processId}`)
  ).json();
  assert.deepEqual(
    artifactDetail.artifacts.map((artifact) => artifact.kind),
    ["job_description", "vacancy"],
  );
  assert.equal(artifactDetail.lifecycle.state, "ready");
  assert.deepEqual(artifactDetail.lifecycle.actionable_steps, [
    "research_company",
  ]);
  assert.equal(JSON.stringify(artifactDetail).includes("sha256"), false);
  assert.equal(JSON.stringify(artifactDetail).includes("job-description.txt"), false);
});

test("serves only registered web-readable artifact kinds with fixed content types", async (t) => {
  const environment = createArtifactEnvironment(t);
  const { baseUrl, port } = await startFixtureServer(t, environment);
  const jdResponse = await fetch(
    `${baseUrl}/api/processes/${processId}/artifacts/job_description`,
  );
  assert.equal(jdResponse.status, 200);
  assert.match(jdResponse.headers.get("content-type"), /^text\/plain/);
  assert.equal(
    await jdResponse.text(),
    readFileSync(
      join(environment.selectedOutputPath, "job-description.txt"),
      "utf8",
    ),
  );

  const vacancyResponse = await fetch(
    `${baseUrl}/api/processes/${processId}/artifacts/vacancy`,
  );
  assert.equal(vacancyResponse.status, 200);
  assert.match(vacancyResponse.headers.get("content-type"), /^application\/json/);
  assert.equal((await vacancyResponse.json()).process.id, processId);

  const head = await rawRequest(
    port,
    `/api/processes/${processId}/artifacts/job_description`,
    "HEAD",
  );
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.equal(
    Number(head.headers["content-length"]),
    environment.jobDescription.bytes,
  );

  assert.equal(
    (
      await fetch(
        `${baseUrl}/api/processes/${processId}/artifacts/cv_source`,
      )
    ).status,
    404,
  );
  const directCv = await fetch(
    `${baseUrl}/output/${outputDir.slice("output/".length)}/cv.json`,
  );
  assert.equal(directCv.status, 404);
  assert.doesNotMatch(await directCv.text(), new RegExp(secretMarker));
  assert.equal(
    (
      await fetch(
        `${baseUrl}/api/processes/${processId}/artifacts/unregistered`,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(
        `${baseUrl}/api/processes/${historicalProcessId}/artifacts/vacancy`,
      )
    ).status,
    409,
  );
});

test("artifact reader enforces preview limits, digest integrity, and missing-file handling", async (t) => {
  const oversized = createArtifactEnvironment(t);
  const oversizedServer = await startFixtureServer(t, oversized, {
    artifactPreviewMaxBytes: 100,
  });
  const oversizedResponse = await fetch(
    `${oversizedServer.baseUrl}/api/processes/${processId}/artifacts/job_description`,
  );
  assert.equal(oversizedResponse.status, 413);
  assert.deepEqual(await oversizedResponse.json(), {
    error: "artifact_too_large",
  });

  const corrupt = createArtifactEnvironment(t);
  const corruptServer = await startFixtureServer(t, corrupt);
  appendFileSync(
    join(corrupt.selectedOutputPath, "job-description.txt"),
    "\ncorrupt\n",
    "utf8",
  );
  const corruptResponse = await fetch(
    `${corruptServer.baseUrl}/api/processes/${processId}/artifacts/job_description`,
  );
  assert.equal(corruptResponse.status, 409);
  assert.deepEqual(await corruptResponse.json(), {
    error: "artifact_corrupt",
  });

  const missing = createArtifactEnvironment(t);
  const missingServer = await startFixtureServer(t, missing);
  assert.equal(
    (await (await fetch(`${missingServer.baseUrl}/api/processes`)).json()).count,
    3,
  );
  unlinkSync(join(missing.selectedOutputPath, "job-description.txt"));
  const missingResponse = await fetch(
    `${missingServer.baseUrl}/api/processes/${processId}/artifacts/job_description`,
  );
  assert.equal(missingResponse.status, 409);
  assert.deepEqual(await missingResponse.json(), {
    error: "artifact_missing",
  });
});

test("artifact reader rejects symlink escapes and never returns outside bytes", async (t) => {
  const environment = createArtifactEnvironment(t);
  const outsidePath = join(environment.workspaceRoot, "outside-secret.txt");
  writeFileSync(outsidePath, `${secretMarker}\n`, "utf8");
  unlinkSync(join(environment.selectedOutputPath, "job-description.txt"));
  symlinkSync(
    outsidePath,
    join(environment.selectedOutputPath, "job-description.txt"),
  );
  const { baseUrl } = await startFixtureServer(t, environment);
  const response = await fetch(
    `${baseUrl}/api/processes/${processId}/artifacts/job_description`,
  );
  assert.equal(response.status, 409);
  assert.doesNotMatch(await response.text(), new RegExp(secretMarker));
});

test("artifact reader rejects invalid UTF-8 even when ledger digests match", async (t) => {
  const environment = createArtifactEnvironment(t);
  const invalidBytes = Buffer.from([0xff, 0xfe, 0xfd]);
  const jobDescriptionPath = join(
    environment.selectedOutputPath,
    "job-description.txt",
  );
  writeFileSync(jobDescriptionPath, invalidBytes);

  const log = JSON.parse(readFileSync(environment.logPath, "utf8"));
  const process = log.processes.find((record) => record.id === processId);
  const jobDescription = process.steps.get_vacancy.artifacts.find((artifact) =>
    artifact.kind === "job_description");
  jobDescription.sha256 = sha256Hex(invalidBytes);
  jobDescription.bytes = invalidBytes.byteLength;

  const vacancyPath = join(environment.selectedOutputPath, "vacancy.json");
  const vacancy = JSON.parse(readFileSync(vacancyPath, "utf8"));
  vacancy.jobDescription.sha256 = jobDescription.sha256;
  vacancy.jobDescription.bytes = jobDescription.bytes;
  writeFileSync(vacancyPath, `${JSON.stringify(vacancy, null, 2)}\n`, "utf8");
  const vacancyMetadata = process.steps.get_vacancy.artifacts.find((artifact) =>
    artifact.kind === "vacancy");
  const vacancyBytes = readFileSync(vacancyPath);
  vacancyMetadata.sha256 = sha256Hex(vacancyBytes);
  vacancyMetadata.bytes = vacancyBytes.byteLength;
  writeFileSync(
    environment.logPath,
    `${JSON.stringify(log, null, 2)}\n`,
    "utf8",
  );

  const { baseUrl } = await startFixtureServer(t, environment);
  const response = await fetch(
    `${baseUrl}/api/processes/${processId}/artifacts/job_description`,
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "artifact_corrupt",
  });
});

test("can disable artifact APIs for a non-loopback deployment policy", async (t) => {
  const environment = createArtifactEnvironment(t);
  const { baseUrl } = await startFixtureServer(t, environment, {
    artifactAccessEnabled: false,
  });
  const response = await fetch(
    `${baseUrl}/api/processes/${processId}/artifacts/job_description`,
  );
  assert.equal(response.status, 404);
});

test("rejects write methods, API misses, output access, and traversal", async (t) => {
  const environment = createArtifactEnvironment(t);
  const { port } = await startFixtureServer(t, environment);
  assert.equal((await rawRequest(port, "/api/processes", "POST")).status, 405);
  assert.equal((await rawRequest(port, "/api/unknown")).status, 404);
  assert.equal((await rawRequest(port, "/output/secret.txt")).status, 404);
  const hidden = await rawRequest(
    port,
    `/output/${outputDir.slice("output/".length)}/unregistered.txt`,
  );
  assert.equal(hidden.status, 404);
  assert.doesNotMatch(hidden.body, new RegExp(secretMarker));
  assert.equal(
    (
      await rawRequest(
        port,
        `/api/processes/${processId}/artifacts/%2e%2e%2fvacancy`,
      )
    ).status,
    404,
  );
  assert.equal(
    (await rawRequest(port, "/%2e%2e/%2e%2e/process-log.json")).status,
    404,
  );
});

test("supports HEAD for static, list, and detail responses without a body", async (t) => {
  const environment = createArtifactEnvironment(t);
  const { port } = await startFixtureServer(t, environment);
  for (const path of [
    "/",
    "/api/processes",
    `/api/processes/${processId}`,
  ]) {
    const response = await rawRequest(port, path, "HEAD");
    assert.equal(response.status, 200);
    assert.equal(response.body, "");
  }
});

test("serves the same safe app shell for one-segment process detail routes", async (t) => {
  const environment = createArtifactEnvironment(t);
  const { baseUrl, port } = await startFixtureServer(t, environment);
  const detailPage = await fetch(
    `${baseUrl}/processes/${encodeURIComponent(processId)}`,
  );
  assert.equal(detailPage.status, 200);
  assert.match(detailPage.headers.get("content-type"), /text\/html/);
  assert.match(await detailPage.text(), /id="main-content"/);

  const head = await rawRequest(
    port,
    `/processes/${processId}`,
    "HEAD",
  );
  assert.equal(head.status, 200);
  assert.equal(head.body, "");

  assert.equal(
    (await fetch(`${baseUrl}/processes/${processId}/extra`)).status,
    404,
  );
  assert.equal(
    (await fetch(`${baseUrl}/processes/%2fetc`)).status,
    404,
  );
});

test("frontend assets keep untrusted artifact rendering DOM-only", async (t) => {
  const environment = createHistoricalEnvironment(t);
  const { baseUrl } = await startFixtureServer(t, environment);

  // The corpus is the served directory, not a hand-kept list: a new frontend module has to appear
  // here or fail. The literal exists only so that an addition is visible in the diff.
  const entries = readdirSync(staticRoot, { withFileTypes: true });
  assert.deepEqual(
    entries.filter((entry) => !entry.isFile()).map((entry) => entry.name),
    [],
    "the served root must stay flat: a subdirectory would escape this scan",
  );
  // Dotfiles are excluded: `.DS_Store` is gitignored and invisible to review, so a single Finder
  // visit would red the suite with a diff that points nowhere near the real cause.
  const served = entries
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .sort();
  assert.deepEqual(served, [...frontendFiles]);
  // Three legs: the directory against the literal, the literal against the directory, and the number
  // of files actually scanned against the number the directory offers. The count is derived from the
  // directory read, not from the literal, so it cannot agree with itself.
  const servedScripts = served.filter((name) => name.endsWith(".js"));
  const discovered = frontendModules;
  assert.deepEqual(discovered, servedScripts);

  // The scan runs over what the server actually returns, so a module that stops being served fails
  // here rather than only in the browser suite.
  let scanned = 0;
  const sources = new Map();
  for (const name of discovered) {
    const response = await fetch(`${baseUrl}/${name}`);
    assert.equal(response.status, 200, name);
    const source = await response.text();
    sources.set(name, source);
    assert.doesNotMatch(
      source,
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
      name,
    );
    // A renderer that reads one of these degrades silently instead of failing, which is exactly how
    // the gap card broke.
    for (const [receiver, key] of briefCardAbsentReads) {
      assert.doesNotMatch(
        source,
        new RegExp(`\\b${receiver}\\s*\\??\\.\\s*${key}\\b`),
        `${name}: ${receiver}.${key}`,
      );
    }
    scanned += 1;
  }
  assert.equal(scanned, servedScripts.length);

  const appSource = sources.get("app.js");
  assert.match(appSource, /textContent/);
  assert.match(appSource, /noreferrer noopener/);
  assert.match(appSource, /navigator\.clipboard\.writeText/);
  assert.match(appSource, /event\.key !== "Enter"/);
});

test("the semantic view keeps its empty-state messages", async (t) => {
  // `No declared gaps.` is reachable for a contract-valid brief — `validate.mjs` declares no `min`
  // on `experience.gaps` — and is unexercised here only because the canonical fixture now fills that
  // array. `No selected entries.` is unreachable for any valid brief, because `priorityEvidence`
  // and `traits` both carry `min: 1`. Either way this is a source pin, not a behavioural one: it
  // proves the wording survives an edit, not that the branch still renders. The DOM branch stays
  // uncovered and is owned by the semantic-view completeness task.
  const environment = createHistoricalEnvironment(t);
  const { baseUrl } = await startFixtureServer(t, environment);
  const appSource = await (await fetch(`${baseUrl}/app.js`)).text();
  assert.match(appSource, /No declared gaps\./);
  assert.match(appSource, /No selected entries\./);
});

test("complete temporary UI fixture integrates all readers and CV metadata", async (t) => {
  const disposable = createDisposableWorkspace(t, {
    prefix: "job-search-server-ui-",
  });
  const environment = createProcessSearchUiFixture(disposable);
  const { baseUrl } = await startFixtureServer(t, environment);

  const list = await (await fetch(`${baseUrl}/api/processes`)).json();
  assert.equal(list.count, 2);
  const complete = list.results.find((result) =>
    result.process.id === environment.processId);
  assert.equal(complete.process.lifecycle_state, "complete");
  assert.equal(complete.process.readable_artifact_count, 5);
  assert.equal(complete.process.has_cv, true);
  assert.equal(complete.process.manual_review_required, true);

  const detail = await (
    await fetch(`${baseUrl}/api/processes/${environment.processId}`)
  ).json();
  assert.deepEqual(
    detail.artifacts.map((artifact) => artifact.kind),
    [
      "job_description",
      "vacancy",
      "company_research",
      "application_brief",
      "cover_letter",
    ],
  );
  assert.deepEqual(detail.steps.map((step) => step.state), [
    "completed",
    "completed",
    "completed",
    "completed",
    "completed",
  ]);
  assert.equal(detail.lifecycle.manual_review_required, true);
  assert.equal(detail.cv.status, "published");
  assert.equal(detail.cv.preview_available, false);
  assert.match(detail.cv.docx_path, /^output\/.+\.docx$/);

  for (const artifact of detail.artifacts) {
    const response = await fetch(`${baseUrl}${artifact.read_url}`);
    assert.equal(response.status, 200, artifact.kind);
    assert.ok((await response.text()).length > 0, artifact.kind);
  }
});
