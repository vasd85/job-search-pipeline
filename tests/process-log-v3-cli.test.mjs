import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { jobSourceRegistry } from "../tools/job-sources/registry.mjs";
import { createValidV3Log } from "./fixtures/process-log-v3.mjs";
import { seedCandidateConfig } from "./fixtures/protected-inputs.mjs";
import {
  createDisposableWorkspace,
  disposableWorkspaceEnv,
} from "./fixtures/disposable-workspace.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(repoRoot, "tests/fixtures/process-log-cli-child.mjs");
const productionCliPath = resolve(repoRoot, "tools/process-log.mjs");
const processLogCorePath = resolve(repoRoot, "tools/lib/process-log-core.mjs");
const processLogLifecyclePath = resolve(
  repoRoot,
  "tools/lib/process-log-v3-lifecycle.mjs",
);
const vacancyFixturePath = resolve(
  repoRoot,
  "tools/pipeline-artifacts/fixtures/vacancy-v2-completed/vacancy.json",
);
const jobDescriptionFixturePath = resolve(
  repoRoot,
  "tools/pipeline-artifacts/fixtures/vacancy-v2-completed/job-description.txt",
);

function emptyV3Log() {
  return {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: "2026-07-23T08:00:00.000Z",
    companies: [],
    processes: [],
  };
}

// A record written under version 1: its stored key is the version 1 key of a reference whose
// version 2 key is different. `start` cannot produce one after the cutover, and the fixture is
// deliberately a historical record, because that is the corpus that is immutable by rule.
function legacyHistoricalRecord({ id, sourceRef, sourceKey, duplicateOf = null }) {
  return {
    id,
    started_at: "2026-07-23T07:00:00.000Z",
    source_ref: sourceRef,
    source_key: sourceKey,
    company_id: null,
    company_observed: null,
    company_hint: null,
    role: null,
    runner: "claude-ai-web",
    output_dir: null,
    status: "started",
    duplicate_of: duplicateOf,
  };
}

function createEnvironment(t, log = emptyV3Log()) {
  return createDisposableWorkspace(t, {
    ledger: log,
    prefix: "job-search-v3-cli-",
  });
}

function runCli(environment, ...args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...disposableWorkspaceEnv(environment),
    },
  });
}

function runCliWithEnvironmentMap(environment, ...args) {
  return spawnSync(process.execPath, [productionCliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
    },
  });
}

function runCliSuccess(environment, ...args) {
  const result = runCli(environment, ...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function stageCompletedVacancy(environment, processRecord, publicationId) {
  const outputPath = resolve(
    environment.workspaceRoot,
    processRecord.output_dir,
  );
  const stagingPath = join(outputPath, ".pipeline-tmp", publicationId);
  mkdirSync(stagingPath, { recursive: true });
  // A completed vacancy names one of the markets the layer configures, so the workspace carries the
  // example's config.
  seedCandidateConfig(repoRoot, environment.workspaceRoot);
  copyFileSync(
    jobDescriptionFixturePath,
    join(stagingPath, "job-description.txt"),
  );
  const vacancy = JSON.parse(readFileSync(vacancyFixturePath, "utf8"));
  vacancy.process.id = processRecord.id;
  vacancy.process.sourceRef = processRecord.source_ref;
  vacancy.process.finalUrl = processRecord.source_ref;
  vacancy.process.outputDir = processRecord.output_dir;
  vacancy.role.company = processRecord.company_observed;
  vacancy.role.title = processRecord.role;
  writeFileSync(
    join(stagingPath, "vacancy.json"),
    `${JSON.stringify(vacancy, null, 2)}\n`,
    "utf8",
  );
}

test("production CLI exposes the complete tested v3 lifecycle surface on isolated roots", (t) => {
  const environment = createEnvironment(t);
  const sourceRef = "https://example.test/jobs/senior-quality-engineer";
  const started = runCliSuccess(
    environment,
    "start",
    "--source-ref",
    sourceRef,
    "--runner",
    "codex",
    "--company-hint",
    "Example",
  );
  const processId = started.process.id;
  const firstAttemptId =
    started.process.steps.get_vacancy.active_attempt.id;

  const updated = runCliSuccess(
    environment,
    "update",
    "--id",
    processId,
    "--company-observed",
    "Example Labs",
    "--clear-company-hint",
    "--role",
    "Senior Quality Engineer",
  );
  assert.equal(updated.process.company_hint, null);

  const reserved = runCliSuccess(
    environment,
    "reserve-output",
    "--id",
    processId,
  );
  assert.equal(
    reserved.output_dir,
    "output/example-labs-senior-quality-engineer",
  );
  const selectedOutputPath = resolve(
    environment.workspaceRoot,
    reserved.output_dir,
  );
  assert.equal(existsSync(selectedOutputPath), true);
  assert.equal(selectedOutputPath.startsWith(environment.outputRoot), true);

  const resolvedBySource = runCliSuccess(
    environment,
    "resolve",
    "--source-ref",
    `${sourceRef}?utm_source=cli-test`,
  );
  assert.equal(resolvedBySource.process.id, processId);
  const resolvedByOutput = runCliSuccess(
    environment,
    "resolve",
    "--output-dir",
    `output/${reserved.output_dir.slice("output/".length).toUpperCase()}`,
  );
  assert.equal(resolvedByOutput.process.id, processId);

  const stepOnePreflight = runCliSuccess(
    environment,
    "preflight-step",
    "--id",
    processId,
    "--step",
    "get_vacancy",
  );
  assert.equal(stepOnePreflight.status, "ready");
  assert.deepEqual(stepOnePreflight.input_snapshot, []);

  const publicationId = "publication_cli_vacancy_001";
  stageCompletedVacancy(environment, reserved.process, publicationId);
  const published = runCliSuccess(
    environment,
    "publish-step",
    "--id",
    processId,
    "--step",
    "get_vacancy",
    "--attempt-id",
    firstAttemptId,
    "--publication-id",
    publicationId,
    "--outcome",
    "completed",
  );
  assert.equal(published.status, "completed");
  assert.equal(
    published.process.steps.get_vacancy.state,
    "completed",
  );
  const beforeRejectedIdentityUpdate = readFileSync(
    environment.ledgerPath,
    "utf8",
  );
  const rejectedIdentityUpdate = runCli(
    environment,
    "update",
    "--id",
    processId,
    "--role",
    "Drifted CLI Role",
  );
  assert.equal(rejectedIdentityUpdate.status, 1);
  assert.equal(
    JSON.parse(rejectedIdentityUpdate.stderr).error.code,
    "identity_update_not_authorized",
  );
  assert.equal(
    readFileSync(environment.ledgerPath, "utf8"),
    beforeRejectedIdentityUpdate,
  );

  const structurallyValid = runCliSuccess(environment, "validate");
  assert.equal(structurallyValid.schema_version, 4);
  const deeplyValid = runCliSuccess(environment, "validate", "--deep");
  assert.equal(deeplyValid.health, "current");

  const reconciled = runCliSuccess(
    environment,
    "reconcile-step",
    "--id",
    processId,
    "--step",
    "get_vacancy",
  );
  assert.equal(reconciled.status, "unchanged");

  const researchPreflight = runCliSuccess(
    environment,
    "preflight-step",
    "--output-dir",
    reserved.output_dir,
    "--step",
    "research_company",
  );
  assert.deepEqual(
    researchPreflight.input_snapshot.map((entry) => entry.kind),
    ["job_description", "vacancy"],
  );
  const begun = runCliSuccess(
    environment,
    "begin-step",
    "--source-ref",
    sourceRef,
    "--step",
    "research_company",
  );
  assert.equal(begun.status, "started");

  const failure = {
    code: "source_fetch_failed",
    message: "The test research source could not be opened.",
    retryable: true,
    details: ["synthetic CLI failure"],
  };
  const failed = runCliSuccess(
    environment,
    "fail-step",
    "--id",
    processId,
    "--step",
    "research_company",
    "--attempt-id",
    begun.attempt_id,
    "--error-json",
    JSON.stringify(failure),
  );
  assert.equal(failed.status, "failed");
  const retried = runCliSuccess(
    environment,
    "retry-step",
    "--id",
    processId,
    "--step",
    "research_company",
  );
  assert.equal(retried.status, "retried");
  runCliSuccess(
    environment,
    "fail-step",
    "--id",
    processId,
    "--step",
    "research_company",
    "--attempt-id",
    retried.attempt_id,
    "--error-json",
    JSON.stringify(failure),
  );

  const reopened = runCliSuccess(
    environment,
    "reopen-step",
    "--id",
    processId,
    "--step",
    "get_vacancy",
  );
  assert.equal(reopened.status, "reopened");
  assert.deepEqual(reopened.invalidated_steps, []);
  assert.equal(
    reopened.process.steps.research_company.state,
    "failed",
  );
  const revised = runCliSuccess(
    environment,
    "update",
    "--id",
    processId,
    "--company-observed",
    "Revised CLI Labs",
    "--role",
    "Principal Quality Engineer",
  );
  assert.equal(revised.process.company_observed, "Revised CLI Labs");
  assert.equal(revised.process.role, "Principal Quality Engineer");
  assert.equal(revised.process.output_dir, reserved.output_dir);
});

test("v3 CLI company mutations and search preserve registry behavior", (t) => {
  const environment = createEnvironment(t);
  const started = runCliSuccess(
    environment,
    "start",
    "--source-ref",
    "direct-outreach:cli-company",
    "--runner",
    "codex",
  );
  const company = runCliSuccess(
    environment,
    "create-company",
    "--display-name",
    "CLI Example",
    "--term",
    "Си-эл-ай",
    "--domain",
    "www.cli-example.test/about",
  ).company;
  runCliSuccess(
    environment,
    "link-company",
    "--id",
    started.process.id,
    "--company-id",
    company.id,
  );
  runCliSuccess(
    environment,
    "rename-company",
    "--id",
    company.id,
    "--display-name",
    "CLI Example Labs",
  );
  runCliSuccess(
    environment,
    "add-company-term",
    "--id",
    company.id,
    "--term",
    "Command Line Labs",
  );
  runCliSuccess(
    environment,
    "add-company-domain",
    "--id",
    company.id,
    "--domain",
    "careers.cli-example.test/jobs",
  );
  const search = runCliSuccess(
    environment,
    "find-company",
    "--query",
    "Command Line Labs",
  );
  assert.equal(search.matches[0].company.id, company.id);
  runCliSuccess(
    environment,
    "remove-company-term",
    "--id",
    company.id,
    "--term",
    "Command Line Labs",
  );
  runCliSuccess(
    environment,
    "remove-company-domain",
    "--id",
    company.id,
    "--domain",
    "cli-example.test",
  );

  const log = JSON.parse(readFileSync(environment.ledgerPath, "utf8"));
  assert.equal(log.processes[0].company_id, company.id);
  assert.equal(log.companies[0].display_name, "CLI Example Labs");
  assert.deepEqual(log.companies[0].domains, ["careers.cli-example.test"]);
});

test("every CLI company mutation preserves the ledger root clock", async (t) => {
  const expectedIds = Object.freeze([
    "add_domain",
    "add_term",
    "create",
    "remove_domain",
    "remove_term",
    "rename",
  ]);
  const cases = [
    {
      id: "create",
      args: ["create-company", "--display-name", "New Clock Company"],
    },
    {
      id: "rename",
      args: [
        "rename-company",
        "--id",
        "company_clock_guard",
        "--display-name",
        "Clock Guard Renamed",
      ],
    },
    {
      id: "add_term",
      args: [
        "add-company-term",
        "--id",
        "company_clock_guard",
        "--term",
        "New Clock Term",
      ],
    },
    {
      id: "remove_term",
      args: [
        "remove-company-term",
        "--id",
        "company_clock_guard",
        "--term",
        "Removable Clock Term",
      ],
    },
    {
      id: "add_domain",
      args: [
        "add-company-domain",
        "--id",
        "company_clock_guard",
        "--domain",
        "new-clock.example.test",
      ],
    },
    {
      id: "remove_domain",
      args: [
        "remove-company-domain",
        "--id",
        "company_clock_guard",
        "--domain",
        "remove-clock.example.test",
      ],
    },
  ];
  const executedIds = new Set();
  assert.deepEqual(cases.map(({ id }) => id).sort(), [...expectedIds].sort());

  for (const fixture of cases) {
    await t.test(fixture.id, (subtest) => {
      const log = emptyV3Log();
      log.updated_at = new Date(Date.now() + 240_000).toISOString();
      log.companies.push({
        id: "company_clock_guard",
        display_name: "Clock Guard Company",
        search_terms: ["Clock Guard Company", "Removable Clock Term"],
        domains: ["remove-clock.example.test"],
      });
      const environment = createEnvironment(subtest, log);
      const before = readFileSync(environment.ledgerPath, "utf8");
      const result = runCliWithEnvironmentMap(
        disposableWorkspaceEnv(environment),
        ...fixture.args,
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.deepEqual(JSON.parse(result.stderr).error, {
        code: "invalid_mutation_timestamp",
        message: "clock timestamp is outside the allowed causal window",
      });
      assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
      executedIds.add(fixture.id);
    });
  }
  assert.deepEqual([...executedIds].sort(), [...expectedIds].sort());

  const noOpLog = emptyV3Log();
  noOpLog.updated_at = new Date(Date.now() + 240_000).toISOString();
  noOpLog.companies.push({
    id: "company_clock_noop",
    display_name: "Clock Guard No-op",
    search_terms: ["Clock Guard No-op"],
    domains: [],
  });
  const noOpEnvironment = createEnvironment(t, noOpLog);
  const noOpBefore = readFileSync(noOpEnvironment.ledgerPath, "utf8");
  const noOp = runCliWithEnvironmentMap(
    disposableWorkspaceEnv(noOpEnvironment),
    "create-company",
    "--display-name",
    "Clock Guard No-op",
  );
  assert.equal(noOp.status, 0, noOp.stderr);
  assert.equal(JSON.parse(noOp.stdout).status, "existing");
  assert.equal(readFileSync(noOpEnvironment.ledgerPath, "utf8"), noOpBefore);

  const equalTimestamp = "2026-07-23T08:00:00.000Z";
  const equalEnvironment = createEnvironment(t);
  const equalScript = `
    const NativeDate = Date;
    const fixedTimestamp = ${JSON.stringify(equalTimestamp)};
    globalThis.Date = class extends NativeDate {
      constructor(...args) {
        super(...(args.length > 0 ? args : [fixedTimestamp]));
      }
      static now() { return NativeDate.parse(fixedTimestamp); }
      static parse(value) { return NativeDate.parse(value); }
    };
    process.argv = [
      process.execPath,
      ${JSON.stringify(productionCliPath)},
      "create-company",
      "--display-name",
      "Equal Clock Company",
    ];
    await import(${JSON.stringify(pathToFileURL(productionCliPath).href)});
  `;
  const equalResult = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", equalScript],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ...disposableWorkspaceEnv(equalEnvironment),
      },
    },
  );
  assert.equal(equalResult.status, 0, equalResult.stderr);
  assert.equal(JSON.parse(equalResult.stdout).status, "created");
  assert.equal(
    JSON.parse(readFileSync(equalEnvironment.ledgerPath, "utf8")).updated_at,
    equalTimestamp,
  );

  const source = readFileSync(productionCliPath, "utf8");
  assert.match(
    source,
    /if \(Date\.parse\(timestamp\) < Date\.parse\(log\.updated_at\)\) \{/,
  );
  assert.match(source, /log\.updated_at = timestamp;/);
});

test("company-domain additions reject every registered intermediary family byte-stably", (t) => {
  const environment = createEnvironment(t);
  const company = runCliSuccess(
    environment,
    "create-company",
    "--display-name",
    "Existing Company",
    "--domain",
    "example.test",
  ).company;

  for (const source of jobSourceRegistry) {
    assert.equal(source.employerDomainExcluded, true, source.id);
    for (const domain of source.domainFamilies) {
      const forbidden = `TeNaNt.${domain}.`;
      const beforeCreate = readFileSync(environment.ledgerPath, "utf8");
      const create = runCli(
        environment,
        "create-company",
        "--display-name",
        "Existing Company",
        "--domain",
        forbidden,
      );
      assert.equal(create.status, 1, `${source.id}: ${create.stderr}`);
      assert.equal(JSON.parse(create.stderr).error.code, "company_domain_forbidden");
      assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeCreate);

      const beforeAdd = readFileSync(environment.ledgerPath, "utf8");
      const add = runCli(
        environment,
        "add-company-domain",
        "--id",
        company.id,
        "--domain",
        forbidden,
      );
      assert.equal(add.status, 1, `${source.id}: ${add.stderr}`);
      assert.equal(JSON.parse(add.stderr).error.code, "company_domain_forbidden");
      assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeAdd);
    }
  }

  // A non-http(s) scheme is the one form the registry cannot recognize on its
  // own: parseHostname discards it, while normalizeDomain keeps the hostname.
  // Denial here therefore proves the CLI derives the stored value first and
  // only then applies the policy, which no pure-unit assertion can observe.
  const beforeScheme = readFileSync(environment.ledgerPath, "utf8");
  const scheme = runCli(
    environment,
    "add-company-domain",
    "--id",
    company.id,
    "--domain",
    "ftp://greenhouse.io",
  );
  assert.equal(scheme.status, 1, scheme.stderr);
  assert.equal(JSON.parse(scheme.stderr).error.code, "company_domain_forbidden");
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeScheme);

  const allowed = runCliSuccess(
    environment,
    "add-company-domain",
    "--id",
    company.id,
    "--domain",
    "careers.example.org/jobs",
  );
  assert.equal(allowed.status, "domain-added");
});

test("legacy intermediary domains stay readable and removable but cannot be re-added", (t) => {
  const log = emptyV3Log();
  log.companies.push({
    id: "company_legacy_intermediary",
    display_name: "Legacy Company",
    search_terms: ["Legacy Company"],
    domains: ["tenant.pinpointhq.com"],
  });
  const environment = createEnvironment(t, log);

  assert.equal(runCli(environment, "validate").status, 0);
  const beforeExistingAdd = readFileSync(environment.ledgerPath, "utf8");
  const existingAdd = runCli(
    environment,
    "add-company-domain",
    "--id",
    "company_legacy_intermediary",
    "--domain",
    "tenant.pinpointhq.com",
  );
  assert.equal(existingAdd.status, 1);
  assert.equal(
    JSON.parse(existingAdd.stderr).error.code,
    "company_domain_forbidden",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeExistingAdd);
  const removed = runCliSuccess(
    environment,
    "remove-company-domain",
    "--id",
    "company_legacy_intermediary",
    "--domain",
    "tenant.pinpointhq.com",
  );
  assert.equal(removed.status, "domain-removed");
  const beforeReAdd = readFileSync(environment.ledgerPath, "utf8");
  const reAdd = runCli(
    environment,
    "add-company-domain",
    "--id",
    "company_legacy_intermediary",
    "--domain",
    "tenant.pinpointhq.com",
  );
  assert.equal(reAdd.status, 1);
  assert.equal(JSON.parse(reAdd.stderr).error.code, "company_domain_forbidden");
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeReAdd);
});

test("removed v2 commands and historical mutations fail with stable errors byte-stably", (t) => {
  const environment = createEnvironment(t, createValidV3Log());
  for (const command of ["set-output", "mark-failed", "find", "migrate"]) {
    const before = readFileSync(environment.ledgerPath, "utf8");
    const result = runCli(environment, command);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.code, "unknown_command");
    assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
  }

  const before = readFileSync(environment.ledgerPath, "utf8");
  const historicalUpdate = runCli(
    environment,
    "update",
    "--id",
    "proc_historical_001",
    "--role",
    "Changed Role",
  );
  assert.equal(historicalUpdate.status, 1);
  assert.equal(
    JSON.parse(historicalUpdate.stderr).error.code,
    "historical_process_read_only",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

test("CLI reports legacy source collisions read-only and refuses silent source resolution", (t) => {
  const environment = createEnvironment(t);
  const clearBefore = readFileSync(environment.ledgerPath, "utf8");
  const clear = runCliSuccess(environment, "report-source-collisions");
  assert.deepEqual(clear, {
    status: "clear",
    collision_count: 0,
    collisions: [],
  });
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), clearBefore);

  // The parameter is one version 2 still strips: after the cutover the four meaningful ones are two
  // postings rather than a collision, so a collision report seeded with them would be empty and this
  // case would pass while proving nothing.
  const first = runCliSuccess(
    environment,
    "start",
    "--source-ref",
    "https://example.test/jobs/cli-collision?trk=alpha",
    "--runner",
    "codex",
  );
  const beforeAmbiguousStart = readFileSync(environment.ledgerPath, "utf8");
  const ambiguousStart = runCli(
    environment,
    "start",
    "--source-ref",
    "https://example.test/jobs/cli-collision?trk=beta",
    "--runner",
    "codex",
  );
  assert.equal(ambiguousStart.status, 2, ambiguousStart.stderr);
  const ambiguousPayload = JSON.parse(ambiguousStart.stdout);
  assert.equal(ambiguousPayload.status, "duplicate");
  assert.equal(ambiguousPayload.collision.status, "ambiguous");
  assert.equal(ambiguousPayload.collision.requires_final_url_check, true);
  assert.equal(ambiguousPayload.collision.requires_explicit_duplicate_of, true);
  assert.deepEqual(ambiguousPayload.collision.matches[0].witnesses, ["trk"]);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeAmbiguousStart);

  const contained = runCliSuccess(
    environment,
    "start",
    "--source-ref",
    "https://example.test/jobs/cli-collision?trk=beta",
    "--runner",
    "codex",
    "--duplicate-of",
    first.process.id,
  );
  assert.equal(contained.process.duplicate_of, first.process.id);
  assert.equal(contained.collision.status, "ambiguous");
  assert.equal(contained.collision.requires_explicit_duplicate_of, false);

  const beforeReport = readFileSync(environment.ledgerPath, "utf8");
  const reportResult = runCli(environment, "report-source-collisions");
  assert.equal(reportResult.status, 2, reportResult.stderr);
  const report = JSON.parse(reportResult.stdout);
  assert.equal(report.status, "collision");
  assert.equal(report.collision_count, 1);
  assert.deepEqual(report.collisions[0].witnesses[0].fields, ["trk"]);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeReport);

  const ambiguousResolve = runCli(
    environment,
    "resolve",
    "--source-ref",
    "https://example.test/jobs/cli-collision?trk=gamma",
  );
  assert.equal(ambiguousResolve.status, 1);
  assert.equal(
    JSON.parse(ambiguousResolve.stderr).error.code,
    "process_ambiguous",
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), beforeReport);
});

test("CLI censuses a source-key policy change read-only, without the containment report's exit", (t) => {
  const environment = createEnvironment(t);
  const emptyBefore = readFileSync(environment.ledgerPath, "utf8");
  const emptyResult = runCli(environment, "report-source-key-split");
  // Exit 0 on a successful read. The sibling `report-source-collisions` exits 2 because an ambiguous
  // stored key is a condition to resolve; this command describes planned work, and a census that
  // fails whenever it has something to say cannot be run before the cutover it informs.
  assert.equal(emptyResult.status, 0, emptyResult.stderr);
  assert.deepEqual(JSON.parse(emptyResult.stdout), {
    status: "clear",
    policy: { to_version: 2 },
    record_count: 0,
    changed_count: 0,
    split_group_count: 0,
    merge_count: 0,
    broken_duplicate_link_count: 0,
    changed: [],
    split_groups: [],
    merges: [],
    broken_duplicate_links: [],
  });
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), emptyBefore);
});

test("CLI censuses a mixed-version ledger and the containment report still explains it", (t) => {
  // After the cutover the corpus this command exists for cannot be produced by `start` any more:
  // a process started now carries a version 2 key. So the legacy half is seeded — which is itself
  // the membership check under test, because a ledger holding both key versions has to load at all
  // — and one process is started on top of it to prove the census leaves the migrated record alone.
  const environment = createEnvironment(t, {
    ...emptyV3Log(),
    updated_at: "2026-07-23T08:00:00.000Z",
    processes: [
      legacyHistoricalRecord({
        id: "proc_legacy_split_a",
        sourceRef: "https://example.test/jobs/census-split?query=alpha",
        sourceKey: "https://example.test/jobs/census-split",
      }),
      legacyHistoricalRecord({
        id: "proc_legacy_split_b",
        sourceRef: "https://example.test/jobs/census-split?query=beta",
        sourceKey: "https://example.test/jobs/census-split",
        duplicateOf: "proc_legacy_split_a",
      }),
      // The record the containment report cannot see: alone under its stored key, and still changing.
      legacyHistoricalRecord({
        id: "proc_legacy_lone",
        sourceRef: "https://example.test/jobs/census-lone?source=hh",
        sourceKey: "https://example.test/jobs/census-lone",
      }),
      // A record that only ever carried genuine tracking must stay out of the census entirely.
      legacyHistoricalRecord({
        id: "proc_legacy_stable",
        sourceRef: "https://example.test/jobs/census-stable?utm_source=x",
        sourceKey: "https://example.test/jobs/census-stable",
      }),
    ],
  });
  const migrated = runCliSuccess(
    environment,
    "start",
    "--source-ref",
    "https://example.test/jobs/census-new?query=fresh",
    "--runner",
    "codex",
  );
  assert.equal(
    migrated.process.source_key,
    "https://example.test/jobs/census-new?query=fresh",
  );

  const collisionResult = runCli(environment, "report-source-collisions");
  assert.equal(collisionResult.status, 2, collisionResult.stderr);
  const collisionReport = JSON.parse(collisionResult.stdout);
  // The R1-03C report keeps its payload and its exit contract across the cutover: it explains a
  // stored key version 1 produced, so it still names `query` as the witness even though two such
  // references no longer share a key under the version the module now computes.
  assert.equal(collisionReport.collision_count, 1);
  assert.deepEqual(collisionReport.collisions[0].witnesses[0].fields, ["query"]);
  assert.equal(
    collisionReport.collisions.some(
      (collision) => collision.records.some((record) => record.process_id === "proc_legacy_lone"),
    ),
    false,
    "the containment report is blind to a lone record whose key would change",
  );

  const censusBefore = readFileSync(environment.ledgerPath, "utf8");
  const censusResult = runCli(environment, "report-source-key-split");
  assert.equal(censusResult.status, 0, censusResult.stderr);
  const census = JSON.parse(censusResult.stdout);
  assert.equal(census.status, "split");
  assert.equal(census.record_count, 5);
  assert.equal(census.changed_count, 3);
  assert.equal(census.merge_count, 0);
  assert.deepEqual(census.merges, []);
  assert.equal(
    census.changed.some((record) => record.process_id === "proc_legacy_lone"),
    true,
    "the census must see the lone record",
  );
  assert.equal(
    census.changed.some((record) => record.process_id === "proc_legacy_stable"),
    false,
    "a genuine tracking parameter is not a change",
  );
  // The migrated record already carries the version 2 key, so the census must say it does not
  // change. A version-to-version comparison would report it, which is why the census reads the
  // stored key.
  assert.equal(
    census.changed.some((record) => record.process_id === migrated.process.id),
    false,
    "a record written after the cutover is not pending work",
  );
  assert.equal(census.split_group_count, 1);
  assert.equal(census.broken_duplicate_link_count, 1);
  assert.equal(census.broken_duplicate_links[0].duplicate_of, "proc_legacy_split_a");
  assert.equal(
    census.broken_duplicate_links[0].projected_source_key,
    "https://example.test/jobs/census-split?query=beta",
  );
  assert.equal(
    census.broken_duplicate_links[0].duplicate_of_projected_source_key,
    "https://example.test/jobs/census-split?query=alpha",
  );
  assert.deepEqual(census.split_groups[0].projected_source_keys, [
    "https://example.test/jobs/census-split?query=alpha",
    "https://example.test/jobs/census-split?query=beta",
  ]);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), censusBefore);

  const censusHelp = runCli(environment, "help");
  assert.match(censusHelp.stdout, /report-source-key-split/);
  const rejected = runCli(environment, "report-source-key-split", "--id", "proc_x");
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stderr).error.code, "invalid_cli_arguments");
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), censusBefore);
});
test("CLI preserves bounded machine-usable ledger failure classes without raw internals", async (t) => {
  const cases = [
    {
      id: "missing_ledger",
      createFixture() {
        const environment = createEnvironment(t);
        const childEnvironment = disposableWorkspaceEnv(environment);
        unlinkSync(environment.ledgerPath);
        return { childEnvironment, environment };
      },
      expected: {
        code: "process_log_read_failed",
        message: "Process log could not be read.",
        context: "operation=read_process_log",
        cause_code: "ENOENT",
        recovery_action: "run_bootstrap_init",
      },
    },
    {
      id: "ledger_is_directory",
      createFixture() {
        const environment = createEnvironment(t);
        const childEnvironment = disposableWorkspaceEnv(environment);
        unlinkSync(environment.ledgerPath);
        mkdirSync(environment.ledgerPath);
        return { childEnvironment, environment };
      },
      expected: {
        code: "process_log_read_failed",
        message: "Process log could not be read.",
        context: "operation=read_process_log",
        cause_code: "EISDIR",
        recovery_action: "inspect_process_log_path",
      },
    },
    {
      id: "ledger_access_denied",
      createFixture() {
        const environment = createEnvironment(t);
        const childEnvironment = disposableWorkspaceEnv(environment);
        chmodSync(environment.ledgerPath, 0o000);
        t.after(() => {
          if (existsSync(environment.ledgerPath)) chmodSync(environment.ledgerPath, 0o600);
        });
        return { childEnvironment, environment };
      },
      expected: {
        code: "process_log_read_failed",
        message: "Process log could not be read.",
        context: "operation=read_process_log",
        cause_code: "EACCES",
        recovery_action: "repair_process_log_access",
      },
    },
    {
      id: "malformed_json",
      createFixture() {
        const environment = createDisposableWorkspace(t, {
          ledger: "{\"schema_version\":3, malformed fixture",
          prefix: "job-search-v3-cli-json-",
        });
        return {
          childEnvironment: disposableWorkspaceEnv(environment),
          environment,
        };
      },
      expected: {
        code: "process_log_invalid_json",
        message: "Process log contains invalid JSON.",
        context: "operation=parse_process_log",
        cause_code: "JSON_PARSE",
        recovery_action: "repair_process_log_json",
      },
    },
    {
      id: "structurally_invalid_v3",
      createFixture() {
        const invalid = emptyV3Log();
        invalid.schema_version = 2;
        const environment = createEnvironment(t, invalid);
        return {
          childEnvironment: disposableWorkspaceEnv(environment),
          environment,
        };
      },
      expected: {
        code: "process_log_validation_failed",
        message: "Process log failed structural validation.",
        context: "operation=validate_process_log",
        recovery_action: "repair_process_log_schema",
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.id, () => {
      const { childEnvironment, environment } = fixture.createFixture();
      const result = runCliWithEnvironmentMap(childEnvironment, "validate");
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.deepEqual(JSON.parse(result.stderr).error, fixture.expected);
      assert.doesNotMatch(result.stderr, new RegExp(environment.workspaceRoot));
      assert.doesNotMatch(result.stderr, /Unexpected|position|column|stack|\.mjs:\d+/i);
    });
  }
});

test("CLI preserves a typed bounded lock-acquisition failure", (t) => {
  const environment = createEnvironment(t);
  const childEnvironment = disposableWorkspaceEnv(environment);
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  let result;
  chmodSync(environment.workspaceRoot, 0o500);
  try {
    result = runCliWithEnvironmentMap(
      childEnvironment,
      "start",
      "--source-ref",
      "fixture:typed-lock-failure",
      "--runner",
      "codex",
    );
  } finally {
    chmodSync(environment.workspaceRoot, 0o700);
  }

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr).error, {
    code: "process_log_lock_failed",
    message: "Process log lock could not be acquired.",
    context: "operation=acquire_process_log_lock",
    cause_code: "EACCES",
    recovery_action: "repair_process_log_access",
  });
  assert.doesNotMatch(result.stderr, new RegExp(environment.workspaceRoot));
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
});

test("CLI preserves primary and secondary filesystem recovery evidence", (t) => {
  const environment = createEnvironment(t);
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  const script = `
    import fileSystem from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const ledgerPath = process.env.JOB_PIPELINE_PROCESS_LOG;
    const originalRenameSync = fileSystem.renameSync.bind(fileSystem);
    const originalUnlinkSync = fileSystem.unlinkSync.bind(fileSystem);
    fileSystem.renameSync = (from, to) => {
      if (typeof from === "string" && from.endsWith(".tmp") && to === ledgerPath) {
        throw Object.assign(new Error("synthetic rename failure"), { code: "EIO" });
      }
      return originalRenameSync(from, to);
    };
    fileSystem.unlinkSync = (targetPath, ...args) => {
      if (
        typeof targetPath === "string"
        && targetPath.startsWith(ledgerPath + ".")
        && targetPath.endsWith(".tmp")
      ) {
        throw Object.assign(new Error("synthetic cleanup failure"), { code: "EACCES" });
      }
      return originalUnlinkSync(targetPath, ...args);
    };
    syncBuiltinESMExports();
    process.argv = [
      process.execPath,
      ${JSON.stringify(productionCliPath)},
      "start",
      "--source-ref",
      "fixture:typed-primary-secondary",
      "--runner",
      "codex",
    ];
    await import(${JSON.stringify(pathToFileURL(productionCliPath).href)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...disposableWorkspaceEnv(environment),
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr).error, {
    code: "process_log_write_failed",
    message: "Process log could not be written.",
    context: "operation=write_process_log",
    cause_code: "EIO",
    recovery_action: "inspect_process_log_write_path",
    secondary_errors: [{
      code: "process_log_temp_cleanup_failed",
      context: "operation=cleanup_process_log_temp",
      cause_code: "EACCES",
      recovery_action: "repair_process_log_access",
    }],
  });
  assert.doesNotMatch(result.stderr, /synthetic|\.mjs:\d+|stack/i);
  assert.doesNotMatch(result.stderr, new RegExp(environment.workspaceRoot));
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
  const residues = readdirSync(environment.workspaceRoot).filter(
    (name) => name.startsWith("process-log.json.") && name.endsWith(".tmp"),
  );
  assert.equal(residues.length, 1);
  unlinkSync(join(environment.workspaceRoot, residues[0]));
});

test("CLI bounds a hostile filesystem cause code before recovery output", (t) => {
  const environment = createEnvironment(t);
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  const hostileCause = "HOSTILE/cause-Bearer-synthetic-secret";
  const script = `
    import fileSystem from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const ledgerPath = process.env.JOB_PIPELINE_PROCESS_LOG;
    const originalWriteFileSync = fileSystem.writeFileSync.bind(fileSystem);
    fileSystem.writeFileSync = (targetPath, ...args) => {
      if (
        typeof targetPath === "string"
        && targetPath.startsWith(ledgerPath + ".")
        && targetPath.endsWith(".tmp")
      ) {
        throw Object.assign(new Error("synthetic hostile cause"), {
          code: ${JSON.stringify(hostileCause)},
        });
      }
      return originalWriteFileSync(targetPath, ...args);
    };
    syncBuiltinESMExports();
    process.argv = [
      process.execPath,
      ${JSON.stringify(productionCliPath)},
      "start",
      "--source-ref",
      "fixture:hostile-cause-code",
      "--runner",
      "codex",
    ];
    await import(${JSON.stringify(pathToFileURL(productionCliPath).href)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...disposableWorkspaceEnv(environment),
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr).error, {
    code: "process_log_write_failed",
    message: "Process log could not be written.",
    context: "operation=write_process_log",
    cause_code: "UNKNOWN",
    recovery_action: "inspect_process_log_write_path",
  });
  assert.doesNotMatch(result.stderr, /HOSTILE|Bearer|synthetic-secret/);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
});

test("CLI renders trusted core evidence from its immutable private snapshot", (t) => {
  const environment = createEnvironment(t);
  const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
  const script = `
    import fileSystem from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { updateLogV3Atomic } from ${JSON.stringify(pathToFileURL(processLogCorePath).href)};
    const ledgerPath = process.env.JOB_PIPELINE_PROCESS_LOG;
    const originalWriteFileSync = fileSystem.writeFileSync.bind(fileSystem);
    fileSystem.writeFileSync = (targetPath, ...args) => {
      if (
        typeof targetPath === "string"
        && targetPath.startsWith(ledgerPath + ".")
        && targetPath.endsWith(".tmp")
      ) {
        throw Object.assign(new Error("synthetic storage failure"), { code: "ENOSPC" });
      }
      return originalWriteFileSync(targetPath, ...args);
    };
    syncBuiltinESMExports();
    let trustedError;
    try {
      updateLogV3Atomic(ledgerPath, (log) => {
        log.updated_at = "2026-07-23T08:01:00.000Z";
      });
    } catch (error) {
      trustedError = error;
    }
    trustedError.causeCode = "HOSTILE_CAUSE";
    trustedError.code = "hostile_code";
    trustedError.context = "/private/tmp/hostile-core-context";
    trustedError.message = "https://secret.invalid/hostile-core-message";
    trustedError.recoveryAction = "Bearer synthetic-hostile-recovery";
    console.log = () => { throw trustedError; };
    process.argv = [process.execPath, ${JSON.stringify(productionCliPath)}, "help"];
    await import(${JSON.stringify(pathToFileURL(productionCliPath).href)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...disposableWorkspaceEnv(environment),
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr).error, {
    code: "process_log_write_failed",
    message: "Process log could not be written.",
    context: "operation=write_process_log",
    cause_code: "ENOSPC",
    recovery_action: "free_process_log_storage",
  });
  assert.doesNotMatch(
    result.stderr,
    /HOSTILE|hostile|private\/tmp|secret\.invalid|Bearer|synthetic-hostile/,
  );
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
});

test("CLI renders trusted validation evidence from its immutable private snapshot", (t) => {
  const environment = createEnvironment(t);
  const script = `
    import { validateLogV3 } from ${JSON.stringify(pathToFileURL(processLogCorePath).href)};
    let trustedError;
    try {
      validateLogV3({});
    } catch (error) {
      trustedError = error;
    }
    trustedError.code = "hostile_code";
    trustedError.context = "/private/tmp/hostile-validation-context";
    trustedError.recoveryAction = "Bearer synthetic-hostile-recovery";
    console.log = () => { throw trustedError; };
    process.argv = [process.execPath, ${JSON.stringify(productionCliPath)}, "help"];
    await import(${JSON.stringify(pathToFileURL(productionCliPath).href)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...disposableWorkspaceEnv(environment),
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr).error, {
    code: "process_log_validation_failed",
    message: "Process log failed structural validation.",
    context: "operation=validate_process_log",
    recovery_action: "repair_process_log_schema",
  });
  assert.doesNotMatch(
    result.stderr,
    /hostile|private\/tmp|Bearer|synthetic-hostile/,
  );
});

test("CLI enforces exact filesystem cause-code grammar and byte bounds", async (t) => {
  const cases = [
    { id: "single_character", causeCode: "E", expected: "E" },
    { id: "digit_body", causeCode: "E2", expected: "E2" },
    { id: "underscore_body", causeCode: "E_A", expected: "E_A" },
    { id: "exact_64", causeCode: "E".repeat(64), expected: "E".repeat(64) },
    { id: "over_64", causeCode: "E".repeat(65), expected: "UNKNOWN" },
    { id: "lowercase", causeCode: "eacces", expected: "UNKNOWN" },
    { id: "leading_digit", causeCode: "1CODE", expected: "UNKNOWN" },
    { id: "lowercase_body", causeCode: "Ea", expected: "UNKNOWN" },
    { id: "hostile_getter", causeCode: null, expected: "UNKNOWN" },
  ];
  for (const fixture of cases) {
    await t.test(fixture.id, (subtest) => {
      const environment = createEnvironment(subtest);
      const ledgerBefore = readFileSync(environment.ledgerPath, "utf8");
      const script = `
        import fileSystem from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        const ledgerPath = process.env.JOB_PIPELINE_PROCESS_LOG;
        const originalWriteFileSync = fileSystem.writeFileSync.bind(fileSystem);
        fileSystem.writeFileSync = (targetPath, ...args) => {
          if (
            typeof targetPath === "string"
            && targetPath.startsWith(ledgerPath + ".")
            && targetPath.endsWith(".tmp")
          ) {
            const error = new Error("synthetic bounded cause");
            throw ${fixture.causeCode === null
              ? `new Proxy(error, {
                  get(value, property, receiver) {
                    if (property === "code") throw new Error("hostile code getter");
                    return Reflect.get(value, property, receiver);
                  },
                })`
              : `Object.assign(error, { code: ${JSON.stringify(fixture.causeCode)} })`};
          }
          return originalWriteFileSync(targetPath, ...args);
        };
        syncBuiltinESMExports();
        process.argv = [
          process.execPath,
          ${JSON.stringify(productionCliPath)},
          "start",
          "--source-ref",
          ${JSON.stringify(`fixture:cause-${fixture.id}`)},
          "--runner",
          "codex",
        ];
        await import(${JSON.stringify(pathToFileURL(productionCliPath).href)});
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          ...disposableWorkspaceEnv(environment),
        },
      });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      const error = JSON.parse(result.stderr).error;
      assert.equal(error.code, "process_log_write_failed");
      assert.equal(error.cause_code, fixture.expected);
      assert.equal(error.recovery_action, "inspect_process_log_write_path");
      assert.equal(readFileSync(environment.ledgerPath, "utf8"), ledgerBefore);
    });
  }
});

test("CLI error codes consume the shared exact diagnostic grammar and limit", async (t) => {
  const cases = [
    { id: "single_character", code: "a", accepted: true },
    { id: "digit_body", code: "a1", accepted: true },
    { id: "digit_segment", code: "a_1", accepted: true },
    { id: "exact_64", code: `a${"b".repeat(63)}`, accepted: true },
    { id: "over_64", code: `a${"b".repeat(64)}`, accepted: false },
    { id: "uppercase", code: "NOT_STABLE", accepted: false },
    { id: "hyphen", code: "not-stable", accepted: false },
    { id: "leading_digit", code: "1code", accepted: false },
    { id: "trailing_underscore", code: "code_", accepted: false },
    { id: "double_underscore", code: "code__part", accepted: false },
    { id: "uppercase_body", code: "aB", accepted: false },
    { id: "uppercase_segment", code: "a_B", accepted: false },
    { id: "number", codeExpression: "42", accepted: false },
    { id: "string_wrapper", codeExpression: 'new String("wrapped_code")', accepted: false },
  ];
  for (const fixture of cases) {
    await t.test(fixture.id, (subtest) => {
      const environment = createEnvironment(subtest);
      const script = `
        import { ProcessLogLifecycleError } from ${JSON.stringify(
          pathToFileURL(processLogLifecyclePath).href,
        )};
        console.log = () => {
          throw new ProcessLogLifecycleError(
            ${fixture.codeExpression ?? JSON.stringify(fixture.code)},
            "synthetic lifecycle diagnostic",
          );
        };
        process.argv = [process.execPath, ${JSON.stringify(productionCliPath)}, "help"];
        await import(${JSON.stringify(pathToFileURL(productionCliPath).href)});
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          ...disposableWorkspaceEnv(environment),
        },
      });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      const printedError = JSON.parse(result.stderr).error;
      assert.equal(
        printedError.code,
        fixture.accepted ? fixture.code : "process_log_cli_failed",
      );
      if (fixture.accepted) {
        assert.equal(printedError.message, "synthetic lifecycle diagnostic");
      }
    });
  }
});

test("CLI ignores untrusted secondary error fields on an unexpected exception", (t) => {
  const environment = createEnvironment(t);
  const hostileContext = `${environment.workspaceRoot}/synthetic-secret`;
  const script = `
    console.log = () => {
      const error = new Error("synthetic unexpected failure https://secret.invalid/value");
      error.secondaryErrors = [{
        causeCode: "HOSTILE",
        code: "hostile_secondary",
        context: ${JSON.stringify(hostileContext)},
        recoveryAction: "Bearer synthetic-secret-token",
      }];
      throw error;
    };
    process.argv = [process.execPath, ${JSON.stringify(productionCliPath)}, "help"];
    await import(${JSON.stringify(pathToFileURL(productionCliPath).href)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...disposableWorkspaceEnv(environment),
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr).error, {
    code: "process_log_cli_failed",
    message: "Process-log command failed with a bounded repository diagnostic.",
  });
  assert.doesNotMatch(result.stderr, /HOSTILE|hostile_secondary|Bearer|synthetic-secret/);
  assert.doesNotMatch(result.stderr, new RegExp(environment.workspaceRoot));
});

test("CLI ignores symbol-spoofed secondary evidence from an unexpected proxy error", (t) => {
  const environment = createEnvironment(t);
  const hostileContext = `${environment.workspaceRoot}/symbol-spoofed-secret`;
  const script = `
    console.log = () => {
      const hostile = [{
        causeCode: "HOSTILE",
        code: "hostile_symbol_secondary",
        context: ${JSON.stringify(hostileContext)},
        recoveryAction: "Bearer symbol-spoofed-secret-token",
      }];
      const target = new Error("synthetic unexpected proxy failure https://secret.invalid/value");
      target.secondaryErrors = hostile;
      throw new Proxy(target, {
        get(value, property, receiver) {
          if (typeof property === "symbol") return hostile;
          return Reflect.get(value, property, receiver);
        },
      });
    };
    process.argv = [process.execPath, ${JSON.stringify(productionCliPath)}, "help"];
    await import(${JSON.stringify(pathToFileURL(productionCliPath).href)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...disposableWorkspaceEnv(environment),
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr).error, {
    code: "process_log_cli_failed",
    message: "Process-log command failed with a bounded repository diagnostic.",
  });
  assert.doesNotMatch(
    result.stderr,
    /HOSTILE|hostile_symbol_secondary|Bearer|symbol-spoofed-secret/,
  );
  assert.doesNotMatch(result.stderr, new RegExp(environment.workspaceRoot));
});

test("CLI contains hostile unexpected error inspection traps", async (t) => {
  const cases = [
    {
      id: "message_getter",
      imports: "",
      construct: `new Proxy(new Error("safe placeholder"), {
        get(target, property, receiver) {
          if (property === "message") throw new Error("HOSTILE_MESSAGE_GETTER_SECRET");
          return Reflect.get(target, property, receiver);
        },
      })`,
      expectedMessage: "Process-log command failed with a bounded repository diagnostic.",
    },
    {
      id: "message_object",
      imports: "",
      construct: `({
        message: {
          startsWith() {
            throw new Error("HOSTILE_MESSAGE_OBJECT_SECRET");
          },
        },
      })`,
      expectedMessage: "Process-log command failed with a bounded repository diagnostic.",
    },
    {
      id: "typed_code_getter",
      imports: `import { ProcessLogLifecycleError } from ${JSON.stringify(
        pathToFileURL(processLogLifecyclePath).href,
      )};`,
      construct: `new Proxy(
        new ProcessLogLifecycleError("safe_lifecycle_code", "safe lifecycle placeholder"),
        {
          get(target, property, receiver) {
            if (property === "code") throw new Error("HOSTILE_CODE_GETTER_SECRET");
            return Reflect.get(target, property, receiver);
          },
        },
      )`,
      expectedMessage: "safe_lifecycle_code: safe lifecycle placeholder",
    },
    {
      id: "prototype_getter",
      imports: "",
      construct: `new Proxy(new Error("safe prototype placeholder"), {
        getPrototypeOf() {
          throw new Error("HOSTILE_PROTOTYPE_GETTER_SECRET");
        },
      })`,
      expectedMessage: "safe prototype placeholder",
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.id, () => {
      const environment = createEnvironment(t);
      const script = `
        ${fixture.imports}
        console.log = () => { throw ${fixture.construct}; };
        process.argv = [process.execPath, ${JSON.stringify(productionCliPath)}, "help"];
        await import(${JSON.stringify(pathToFileURL(productionCliPath).href)});
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          ...disposableWorkspaceEnv(environment),
        },
      });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.deepEqual(JSON.parse(result.stderr).error, {
        code: "process_log_cli_failed",
        message: fixture.expectedMessage,
      });
      assert.doesNotMatch(
        result.stderr,
        /HOSTILE_(?:MESSAGE_(?:GETTER|OBJECT)|CODE_GETTER|PROTOTYPE_GETTER)_SECRET|stack|\.mjs:\d+/i,
      );
    });
  }
});

test("CLI ignores prototype-spoofed primary error evidence", async (t) => {
  for (const className of ["ProcessLogCoreError", "ProcessLogV3ValidationError"]) {
    await t.test(className, () => {
      const environment = createEnvironment(t);
      const hostileContext = `${environment.workspaceRoot}/prototype-spoofed-secret`;
      const script = `
        import { ${className} as SpoofedClass } from ${JSON.stringify(
          pathToFileURL(processLogCorePath).href,
        )};
        console.log = () => {
          const target = new Error("https://secret.invalid/prototype-spoofed");
          Object.assign(target, {
            causeCode: "HOSTILE_CAUSE",
            code: "hostile_primary",
            context: ${JSON.stringify(hostileContext)},
            recoveryAction: "Bearer prototype-spoofed-secret-token",
          });
          throw new Proxy(target, {
            getPrototypeOf() {
              return SpoofedClass.prototype;
            },
          });
        };
        process.argv = [process.execPath, ${JSON.stringify(productionCliPath)}, "help"];
        await import(${JSON.stringify(pathToFileURL(productionCliPath).href)});
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          ...disposableWorkspaceEnv(environment),
        },
      });

      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.deepEqual(JSON.parse(result.stderr).error, {
        code: "process_log_cli_failed",
        message: "Process-log command failed with a bounded repository diagnostic.",
      });
      assert.doesNotMatch(
        result.stderr,
        /HOSTILE|hostile_primary|Bearer|prototype-spoofed|secret\.invalid/,
      );
      assert.doesNotMatch(result.stderr, new RegExp(environment.workspaceRoot));
    });
  }
});

test("CLI does not trust externally constructed public error base classes", async (t) => {
  const cases = [
    {
      className: "ProcessLogCoreError",
      construct: `new PublicError({
        causeCode: "HOSTILE_CAUSE",
        code: "hostile_public_core",
        context: hostileContext,
        message: "https://secret.invalid/public-core",
        recoveryAction: "Bearer public-core-secret-token",
      })`,
    },
    {
      className: "ProcessLogV3ValidationError",
      construct: `new PublicError([
        "https://secret.invalid/public-validation",
        hostileContext,
        "Bearer public-validation-secret-token",
      ])`,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.className, () => {
      const environment = createEnvironment(t);
      const hostileContext = `${environment.workspaceRoot}/public-error-secret`;
      const script = `
        import { ${fixture.className} as PublicError } from ${JSON.stringify(
          pathToFileURL(processLogCorePath).href,
        )};
        const hostileContext = ${JSON.stringify(hostileContext)};
        console.log = () => {
          throw ${fixture.construct};
        };
        process.argv = [process.execPath, ${JSON.stringify(productionCliPath)}, "help"];
        await import(${JSON.stringify(pathToFileURL(productionCliPath).href)});
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          ...disposableWorkspaceEnv(environment),
        },
      });

      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.deepEqual(JSON.parse(result.stderr).error, {
        code: "process_log_cli_failed",
        message: "Process-log command failed with a bounded repository diagnostic.",
      });
      assert.doesNotMatch(
        result.stderr,
        /HOSTILE|hostile_public|Bearer|public-(?:core|validation)|secret\.invalid/,
      );
      assert.doesNotMatch(result.stderr, new RegExp(environment.workspaceRoot));
    });
  }
});

test("CLI replaces an unsafe typed argument diagnostic instead of echoing hostile prose", (t) => {
  const environment = createEnvironment(t);
  const hostile = "https://secret.invalid/private-token";
  const result = runCliWithEnvironmentMap(
    disposableWorkspaceEnv(environment),
    "validate",
    hostile,
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr).error, {
    code: "invalid_cli_arguments",
    message: "Process-log command failed with a bounded repository diagnostic.",
  });
  assert.doesNotMatch(result.stderr, /secret\.invalid|private-token|https?:/i);
});

test("cleanup-staging CLI is dry-run by default and confirms one exact orphan", (t) => {
  const log = createValidV3Log();
  const record = log.processes.find((candidate) => candidate.artifact_mode === "file-backed");
  const environment = createEnvironment(t, log);
  const publicationId = "publication_cli_orphan_cleanup_001";
  const outputPath = resolve(environment.workspaceRoot, record.output_dir);
  const targetPath = join(outputPath, ".pipeline-tmp", publicationId);
  mkdirSync(targetPath, { recursive: true });
  writeFileSync(join(targetPath, "candidate.bin"), "synthetic CLI orphan\n", "utf8");
  const before = readFileSync(environment.ledgerPath, "utf8");

  const review = runCliSuccess(
    environment,
    "cleanup-staging",
    "--id",
    record.id,
    "--publication-id",
    publicationId,
  );
  assert.equal(review.status, "review_required");
  const expectedResultKeys = [
    "age_ms",
    "confirmation_token",
    "entry_count",
    "max_depth",
    "modified_at",
    "process_id",
    "publication_id",
    "status",
    "total_bytes",
    "tree_digest",
  ];
  assert.deepEqual(Object.keys(review).sort(), expectedResultKeys);
  assert.doesNotMatch(JSON.stringify(review), new RegExp(environment.workspaceRoot));
  assert.equal(existsSync(targetPath), true);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);

  const explicitReview = runCliSuccess(
    environment,
    "cleanup-staging",
    "--id",
    record.id,
    "--publication-id",
    publicationId,
    "--dry-run",
  );
  assert.equal(explicitReview.status, "review_required");
  assert.equal(explicitReview.confirmation_token, review.confirmation_token);
  assert.match(explicitReview.tree_digest, /^[a-f0-9]{64}$/);
  assert.equal(Number.isInteger(explicitReview.age_ms), true);
  assert.equal(explicitReview.age_ms >= 0, true);
  assert.equal(Number.isInteger(explicitReview.entry_count), true);
  assert.equal(Number.isInteger(explicitReview.max_depth), true);
  assert.equal(Number.isInteger(explicitReview.total_bytes), true);
  assert.equal(Number.isFinite(Date.parse(explicitReview.modified_at)), true);
  assert.equal(existsSync(targetPath), true);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);

  const conflicting = runCli(
    environment,
    "cleanup-staging",
    "--id",
    record.id,
    "--publication-id",
    publicationId,
    "--dry-run",
    "--confirmation-token",
    review.confirmation_token,
  );
  assert.equal(conflicting.status, 1);
  assert.equal(JSON.parse(conflicting.stderr).error.code, "invalid_cli_arguments");
  assert.equal(existsSync(targetPath), true);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);

  const cleaned = runCliSuccess(
    environment,
    "cleanup-staging",
    "--id",
    record.id,
    "--publication-id",
    publicationId,
    "--confirmation-token",
    review.confirmation_token,
  );
  assert.equal(cleaned.status, "cleaned");
  assert.deepEqual(Object.keys(cleaned).sort(), expectedResultKeys);
  assert.doesNotMatch(JSON.stringify(cleaned), new RegExp(environment.workspaceRoot));
  assert.equal(existsSync(targetPath), false);
  assert.equal(readFileSync(environment.ledgerPath, "utf8"), before);
});

test("the CLI links a duplicate late, corrects it, and reads the chain from the historical end", (t) => {
  // Task 010, end to end through the production command surface: the posting is gone, so the two
  // references never share a key. The historical end is the one the resolver refuses, which is why
  // the chain report reads the ledger directly.
  const environment = createEnvironment(t, {
    ...emptyV3Log(),
    processes: [
      legacyHistoricalRecord({
        id: "proc_july_posting",
        sourceRef: "https://apply.workable.test/ergonia/j/ABC",
        sourceKey: "https://apply.workable.test/ergonia/j/ABC",
      }),
    ],
  });

  const created = runCliSuccess(
    environment,
    "start",
    "--source-ref",
    "local-file:JD Cashen",
    "--runner",
    "codex",
  );
  assert.equal(created.status, "created");

  const linked = runCliSuccess(
    environment,
    "link-duplicate",
    "--id",
    created.process.id,
    "--duplicate-of",
    "proc_july_posting",
  );
  assert.equal(linked.status, "linked");
  assert.equal(linked.cross_source_link.code, "cross_source_duplicate_link");

  const chain = runCliSuccess(
    environment,
    "report-duplicate-chain",
    "--id",
    "proc_july_posting",
  );
  assert.equal(chain.status, "chain");
  assert.deepEqual(
    chain.members.map((member) => member.process_id),
    ["proc_july_posting", created.process.id],
  );
  assert.equal(chain.members[0].record_class, "historical");

  const cleared = runCliSuccess(
    environment,
    "link-duplicate",
    "--id",
    created.process.id,
    "--clear-duplicate-of",
  );
  assert.equal(cleared.status, "cleared");
  assert.equal(
    runCliSuccess(environment, "report-duplicate-chain", "--id", "proc_july_posting").status,
    "single",
  );
});

test("link-duplicate refuses an unknown target and takes exactly one of its two forms", (t) => {
  const environment = createEnvironment(t);
  const created = runCliSuccess(
    environment,
    "start",
    "--source-ref",
    "local-file:only",
    "--runner",
    "codex",
  );

  const unknown = runCli(
    environment,
    "link-duplicate",
    "--id",
    created.process.id,
    "--duplicate-of",
    "proc_typo_999",
  );
  assert.equal(unknown.status, 1);
  assert.equal(JSON.parse(unknown.stderr).error.code, "invalid_duplicate_reference");

  for (const extra of [[], ["--duplicate-of", created.process.id, "--clear-duplicate-of"]]) {
    const result = runCli(environment, "link-duplicate", "--id", created.process.id, ...extra);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.code, "invalid_cli_arguments");
  }
});
