// The batch-triage ledger, driven the way the pipeline drives it: an in-process module for the
// two mutating paths and a read-only CLI as a real child process for the operator paths. Every
// case runs inside a disposable root; nothing here can see an operational ledger.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as ledgerSourceApi from "../tools/lib/triage-ledger-core.mjs";
import {
  createSourceSet,
  snapshotFromHtml,
  cardBody,
  serializeSourceSet,
  sourceSetDigest,
} from "../tools/triage-sources/source-set.mjs";
import {
  publishSourceResolution,
  resolveSourceSet,
  sourceResolutionDigest,
} from "../tools/triage-sources/reconcile.mjs";
import { baseInput } from "./fixtures/job-scorer/decision-table.mjs";
import { renderCaptureFile } from "../tools/vacancy-fetch/persist.mjs";
import { buildContext, runSuite } from "../tools/triage-verify/suite.mjs";
import {
  TriageLedgerError,
  emptyLedger,
  initLedger,
  normalizeVacancyUrl,
  planBatch,
  readBatchRecord,
  readLedger,
  recordBatch,
  reviewLedger,
  triageBatchPlanFileName,
  triageBatchRecordFileName,
  vacancyIdentity,
  validateBatchRecord,
  validateLedger,
} from "../tools/lib/triage-ledger-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "tools", "triage-ledger.mjs");
const corePath = join(repoRoot, "tools", "lib", "triage-ledger-core.mjs");

// Frozen literals, never read back out of the module under test.
const LINKEDIN_ONE = "https://www.linkedin.com/jobs/view/4418544694/";
const LINKEDIN_TWO = "https://www.linkedin.com/jobs/view/4449892212/";
const LINKEDIN_CLOSED = "https://www.linkedin.com/jobs/view/4455248338/";
const LINKEDIN_BLOCKED = "https://www.linkedin.com/jobs/view/4460017733/";

function fictionalSourceSet({
  homepage = "https://acme.example/",
  company = "Acme",
  title = "Senior QA Engineer",
  postId = 7,
  details = null,
  apply = null,
  extra = "",
} = {}) {
  const html =
    `<div class="tgme_widget_message" data-post="fiction_jobs/${postId}">` +
    `<div class="tgme_widget_message_text">${title}<br>` +
    `Company: <a href="${homepage}">${company}</a><br>` +
    `Manual testing and Java.${extra}${details === null ? "" : `<br>Read details: <a href="${details}">QA Engineer</a>`}${apply === null ? "" : `<br>Other role: <a href="${apply}">Junior QA Engineer</a>`}</div>` +
    '<a class="tgme_widget_message_date"><time datetime="2026-10-08T08:00:00Z"></time></a></div>';
  const snapshot = snapshotFromHtml(html, {
    handle: "fiction_jobs",
    postId,
    capturedAt: "2026-10-08T08:30:00.000Z",
  });
  const collectionText = `${homepage}\n${snapshot.original_url}\n${details === null ? "" : `${details}\n`}${apply === null ? "" : `${apply}\n`}`;
  const sourceSet = createSourceSet({
    collectionText,
    snapshots: [snapshot],
    cards: [
      {
        snapshot_ref: snapshot.snapshot_ref,
        title_line: 1,
        start_line: 1,
        end_line: snapshot.lines.length,
        description_kind: "full_description",
        links: [
          { anchor: 1, role: "company_context", url: homepage },
          { anchor: null, role: "original_post", url: snapshot.original_url },
          ...(details === null ? [] : [{ anchor: 2, role: "details", url: details }]),
          ...(apply === null
            ? []
            : [{ anchor: details === null ? 2 : 3, role: "apply", url: apply }]),
        ],
      },
    ],
  });
  return { homepage, company, title, sourceSet, collectionText, html };
}

const sourceInstant = "2026-10-08T09:00:00Z";
const sourcePolicy = "triage-policy-v9-2026-10-08";
const digest = (value) => createHash("sha256").update(value).digest("hex");

function sourceObservation(
  fixture,
  card = fixture.sourceSet.cards[0],
  { inputIndex = 1, sourceRef, body, capture, jobTitle } = {},
) {
  const set = fixture.sourceSet;
  const snapshot = set.snapshots.find((item) => item.snapshot_ref === card.snapshot_ref);
  const original = sourceRef === undefined;
  const ref = sourceRef ?? snapshot.original_url;
  const text = body ?? cardBody(set, card);
  const title = jobTitle ?? snapshot.lines[card.title_line - 1].text;
  const input = baseInput();
  input.schemaVersion = 10;
  input.policyId = sourcePolicy;
  input.inputIndex = inputIndex;
  input.source = {
    accessOutcome: "usable",
    accessReason: null,
    company: fixture.company ?? "Acme",
    evidenceQuote: title,
    finalUrl: ref,
    jobTitle: title,
    locationRaw: null,
    salaryRaw: null,
    sourceRef: ref,
    workFormatRaw: null,
  };
  input.role.automation = "manual_only";
  input.role.seniority = title.startsWith("Junior") ? "junior" : "senior";
  input.role.observedTools = [];
  input.role.observedLanguages = [];
  input.role.evidence = {
    aiProduct: null,
    aiWork: null,
    automation: title,
    domain: title,
    language: title,
    role: title,
    seniority: title,
    tools: null,
  };
  input.compensation = null;
  input.offers = input.offers.map((offer) => ({ ...offer, evidenceQuote: title }));
  const binding = capture ?? { file: snapshot.capture.file, sha256: snapshot.capture.sha256 };
  input.sourceContext = {
    sourceSetSha256: sourceSetDigest(set),
    cardRef: card.card_ref,
    snapshotRef: snapshot.snapshot_ref,
    primarySourceRef: ref,
    primaryCaptureSha256: binding.sha256,
    startLine: original ? card.start_line : 1,
    endLine: original ? card.end_line : text.split("\n").length,
  };
  const companyLine = text.split("\n").find((line) => line.includes(fixture.company ?? "Acme"));
  return {
    card_ref: card.card_ref,
    source_ref: ref,
    description_kind: "full_description",
    identity_status: "confirmed",
    capture: binding,
    body: text,
    facts: {
      company: { value: fixture.company ?? "Acme", evidence_quote: companyLine },
      title: { value: title, evidence_quote: title },
      role: { value: "QA Engineer", evidence_quote: title },
      seniority: null,
      salary: null,
      published_at: null,
    },
    input,
  };
}

function sourceLedger(t) {
  const root = disposableRoot(t, "triage-source-ledger-");
  const path = join(root, "triage-ledger.json");
  initLedger(path);
  ledgerSourceApi.upgradeLedger(path);
  const store = join(root, "triage-batches");
  mkdirSync(store);
  return { root, path, store };
}

function sourceBatchDir(
  context,
  fixture,
  batchId,
  {
    observations,
    observedAt = sourceInstant,
    aliases,
    corrections,
    sourceSelection,
    captures = [],
    prefetchPlan = false,
    planResolution,
    claimedDir = false,
    frozenPlan,
  } = {},
) {
  const dir = join(context.store, batchId);
  if (!claimedDir) mkdirSync(dir);
  writeFileSync(join(dir, fixture.sourceSet.snapshots[0].capture.file), fixture.html);
  for (const [file, bytes] of captures) writeFileSync(join(dir, file), bytes);
  const resolution = publishSourceResolution({
    artifactsDir: dir,
    sourceSet: fixture.sourceSet,
    collectionText: fixture.collectionText,
    observations: observations ?? [sourceObservation(fixture)],
    selection: sourceSelection,
  });
  const plan =
    frozenPlan ??
    ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, {
      asOf: observedAt,
      collectionText: fixture.collectionText,
      ...(planResolution !== undefined
        ? { resolution: planResolution, captureRoot: dir }
        : prefetchPlan
          ? {}
          : { resolution }),
    });
  const planText = `${JSON.stringify(plan, null, 2)}\n`;
  if (frozenPlan === undefined) writeFileSync(join(dir, "plan.json"), planText);
  else assert.equal(readFileSync(join(dir, "plan.json"), "utf8"), planText);
  const payload = {
    batch_id: batchId,
    observed_at: observedAt,
    policy_id: sourcePolicy,
    source_set_sha256: sourceSetDigest(fixture.sourceSet),
    source_resolution_sha256: sourceResolutionDigest(resolution),
    plan_sha256: digest(planText),
    ...(aliases ? { aliases } : {}),
    ...(corrections ? { corrections } : {}),
  };
  return { dir, resolution, plan, payload };
}

function recordSource(path, staged) {
  return ledgerSourceApi.recordSourceBatch(path, staged.payload, { artifactsDir: staged.dir });
}

function multiRoleFixture() {
  const html =
    '<div class="tgme_widget_message" data-post="fiction_jobs/7"><div class="tgme_widget_message_text">' +
    'Company: <a href="https://acme.example/">Acme</a><br>' +
    "Senior QA Engineer at Acme<br>Manual testing and Java.<br>" +
    "Junior QA Engineer at Acme<br>Manual testing and Java.</div>" +
    '<a class="tgme_widget_message_date"><time datetime="2026-10-08T08:00:00Z"></time></a></div>';
  const snapshot = snapshotFromHtml(html, {
    handle: "fiction_jobs",
    postId: 7,
    capturedAt: "2026-10-08T08:30:00.000Z",
  });
  const collectionText = `https://acme.example/\n${snapshot.original_url}\n`;
  const cards = [2, 4].map((line) => ({
    snapshot_ref: snapshot.snapshot_ref,
    title_line: line,
    start_line: line,
    end_line: line + 1,
    description_kind: "full_description",
    links: [
      { anchor: 1, role: "company_context", url: "https://acme.example/" },
      { anchor: null, role: "original_post", url: snapshot.original_url },
    ],
  }));
  const sourceSet = createSourceSet({ collectionText, snapshots: [snapshot], cards });
  return { html, collectionText, sourceSet, company: "Acme", cards, snapshot };
}

function detailsObservation(fixture, { company = fixture.company } = {}) {
  const sourceRef = fixture.sourceSet.cards[0].links.find((link) => link.role === "details").url;
  const body = `${fixture.title}\nCompany: ${company}\nManual testing and Java.`;
  const capture = { file: "001.capture.txt", sha256: digest(body) };
  const raw = sourceObservation({ ...fixture, company }, undefined, { sourceRef, body, capture });
  const bytes = renderCaptureFile({
    body,
    header: {
      index: 1,
      adapter: "fictional",
      "source-id": "url",
      "requested-url": sourceRef,
      "final-url": sourceRef,
      "fetched-at": sourceInstant,
      "http-status": 200,
      outcome: "active",
      "normalized-sha256": digest(body),
      "body-bytes": Buffer.byteLength(body),
    },
  });
  return { raw, captures: [[capture.file, bytes]] };
}

function unreadSourceObservation(fixture, { sourceRef, inputIndex = 1, closed = false } = {}) {
  const raw = sourceObservation(fixture, undefined, { sourceRef, inputIndex });
  raw.capture = null;
  raw.body = null;
  raw.description_kind = "unknown";
  raw.identity_status = "linked_unconfirmed";
  raw.facts = Object.fromEntries(Object.keys(raw.facts).map((key) => [key, null]));
  raw.input.source = {
    ...raw.input.source,
    accessOutcome: closed ? "closed" : "technical_unavailable",
    accessReason: closed ? "HTTP 404 after retry" : "challenge",
    company: null,
    jobTitle: null,
    evidenceQuote: null,
    finalUrl: null,
  };
  raw.input.role = {
    ...raw.input.role,
    family: "unknown",
    automation: "unknown",
    seniority: "unknown",
    language: "unknown",
    domain: "unclear",
    ai: { product: "unknown", work: "unknown" },
    evidence: Object.fromEntries(Object.keys(raw.input.role.evidence).map((key) => [key, null])),
  };
  raw.input.offers = [];
  raw.input.sourceContext = {
    ...raw.input.sourceContext,
    primaryCaptureSha256: null,
    startLine: null,
    endLine: null,
  };
  const manifest = `${JSON.stringify({ schemaVersion: 1, tool: "vacancy-fetch", records: [{ index: inputIndex, requestedUrl: raw.source_ref, outcome: closed ? "absent" : "access_failure", usable: false, ...(closed ? { httpStatus: 404 } : {}) }] })}\n`;
  raw.transport = { file: "fetch-manifest.json", sha256: digest(manifest), index: inputIndex };
  return { raw, captures: [["fetch-manifest.json", manifest]] };
}

function combinedSourceFixture(first, second) {
  const snapshots = [
    structuredClone(first.sourceSet.snapshots[0]),
    structuredClone(second.sourceSet.snapshots[0]),
  ];
  snapshots[0].capture.file = "101.page.html";
  snapshots[1].capture.file = "102.page.html";
  const collectionText =
    [
      ...new Set([
        ...first.collectionText.trim().split("\n"),
        ...second.collectionText.trim().split("\n"),
      ]),
    ].join("\n") + "\n";
  const sourceSet = createSourceSet({
    collectionText,
    snapshots,
    cards: [...first.sourceSet.cards, ...second.sourceSet.cards],
  });
  return {
    sourceSet,
    collectionText,
    html: first.html,
    company: first.company,
    title: first.title,
    captures: [["102.page.html", second.html]],
  };
}

function linkedSourceObservations(fixture) {
  const observations = [];
  const captures = [...(fixture.captures ?? [])];
  let inputIndex = 1;
  let captureIndex = 1;
  for (const card of fixture.sourceSet.cards) {
    observations.push(sourceObservation(fixture, card, { inputIndex: inputIndex++ }));
    for (const link of card.links.filter((source) => ["details", "apply"].includes(source.role))) {
      const sourceRef = link.url;
      const title = link.role === "apply" ? "Junior QA Engineer" : fixture.title;
      const company = link.role === "apply" ? "Beta" : fixture.company;
      const body = `${title}\nCompany: ${company}\nManual testing and Java.`;
      const file = `${String(captureIndex).padStart(3, "0")}.capture.txt`;
      const raw = sourceObservation({ ...fixture, company }, card, {
        inputIndex: inputIndex++,
        sourceRef,
        body,
        jobTitle: title,
        capture: { file, sha256: digest(body) },
      });
      if (link.role === "apply") raw.identity_status = "different";
      observations.push(raw);
      captures.push([
        file,
        renderCaptureFile({
          body,
          header: {
            index: captureIndex++,
            adapter: "fictional",
            "source-id": "url",
            "requested-url": sourceRef,
            "final-url": sourceRef,
            "fetched-at": sourceInstant,
            "http-status": 200,
            outcome: "active",
            "normalized-sha256": digest(body),
            "body-bytes": Buffer.byteLength(body),
            normalization: "none",
          },
        }),
      ]);
    }
  }
  return { observations, captures };
}

function verifySourceBatch(context, staged, fixture, cadence = "per-batch") {
  return runSuite(
    buildContext({
      artifactsDir: staged.dir,
      linksFile: join(staged.dir, "collection.links.txt"),
      from: 1,
      to: fixture.collectionText.trim().split("\n").length,
      ledgerPath: context.path,
    }),
    cadence,
  );
}

function overwriteSourcePlan(staged, plan) {
  const text = `${JSON.stringify(plan, null, 2)}\n`;
  writeFileSync(join(staged.dir, "plan.json"), text);
  staged.payload.plan_sha256 = digest(text);
}

function capturedDetailsOutcome(fixture, { outcome = "active", observedAt = sourceInstant } = {}) {
  const sourceRef = fixture.sourceSet.cards[0].links.find((link) => link.role === "details").url;
  const unread = outcome !== "active";
  const body =
    outcome === "closed"
      ? "This posting is closed."
      : unread
        ? "Request failed, no vacancy content available."
        : `${fixture.title}\nCompany: ${fixture.company}\nPrimary test automation and Java.\nEnglish description.`;
  const capture = { file: "002.capture.txt", sha256: digest(body) };
  const raw = unread
    ? unreadSourceObservation(fixture, { sourceRef, inputIndex: 2, closed: outcome === "closed" })
        .raw
    : sourceObservation(fixture, undefined, { sourceRef, inputIndex: 2, body, capture });
  delete raw.transport;
  raw.capture = capture;
  raw.body = body;
  raw.input.sourceContext = {
    ...raw.input.sourceContext,
    primaryCaptureSha256: capture.sha256,
    startLine: 1,
    endLine: body.split("\n").length,
  };
  if (outcome === "closed") raw.input.source.evidenceQuote = body;
  if (!unread) {
    raw.input.role.automation = "primary";
    raw.input.role.evidence.automation = "Primary test automation";
  }
  const bytes = renderCaptureFile({
    body,
    header: {
      index: 2,
      adapter: "fictional",
      "source-id": "url",
      "requested-url": sourceRef,
      "final-url": sourceRef,
      "fetched-at": observedAt,
      "http-status": outcome === "closed" ? 404 : 200,
      outcome,
      ...(outcome === "access_failure" ? { "access-barrier": "network_error" } : {}),
      "normalized-sha256": digest(body),
      "body-bytes": Buffer.byteLength(body),
      normalization: "none",
    },
  });
  return { observations: [sourceObservation(fixture), raw], captures: [[capture.file, bytes]] };
}

function sourceFullEvidence(staged, observedAt) {
  mkdirSync(join(staged.dir, "blind"));
  const blind = structuredClone(
    staged.resolution.observations.find((observation) => observation.input?.inputIndex === 1).input,
  );
  blind.source.evidenceQuote = "Company: Acme";
  writeFileSync(join(staged.dir, "blind", "001.input.json"), JSON.stringify(blind));
  writeFileSync(
    join(staged.dir, "attestation.json"),
    JSON.stringify({
      schemaVersion: 1,
      probes: ["phase0_capability_probe", "transport_hypotheses"].map((probe) => ({
        probe,
        ranAt: observedAt,
        verdict: "held",
      })),
    }),
  );
}

function terminalSourceScenario(t) {
  const context = sourceLedger(t);
  const fixture = fictionalSourceSet({ details: "https://acme.example/jobs/terminal-qa" });
  const closure = capturedDetailsOutcome(fixture, { outcome: "closed" });
  const first = sourceBatchDir(context, fixture, "terminal-source-first", {
    ...closure,
    prefetchPlan: true,
  });
  sourceFullEvidence(first, sourceInstant);
  for (const cadence of ["per-batch", "full"]) {
    const report = verifySourceBatch(context, first, fixture, cadence);
    assert.equal(report.status, "pass", `${cadence}: ${report.findingCodes.join(",")}`);
  }
  recordSource(context.path, first);
  const prior = readLedger(context.path).source_records.find((source) => source.role === "details");
  assert.equal(prior.observation_status, "closed");
  const observedAt = "2026-10-09T09:00:00Z";
  const frozen = ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, {
    asOf: observedAt,
    collectionText: fixture.collectionText,
    resolution: first.resolution,
    captureRoot: first.dir,
  });
  assert.equal(frozen.items[0].action, "source_review");
  assert.equal(
    frozen.items[0].sources.find((source) => source.role === "details").action,
    "skip_closed",
  );
  return { context, fixture, closure, first, prior, observedAt, frozen };
}

function disposableRoot(t, prefix = "triage-ledger-") {
  const root = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

function freshLedger(t) {
  const path = join(disposableRoot(t), "triage-ledger.json");
  initLedger(path);
  return path;
}

function entry(overrides = {}) {
  return {
    url: LINKEDIN_ONE,
    status: "open",
    decision: "MANUAL_REVIEW",
    flags: ["relocation_floor_missing"],
    ...overrides,
  };
}

function batch(overrides = {}) {
  return {
    batch_id: "2026-08-18-linkedin-1-10",
    observed_at: "2026-08-18T12:40:00Z",
    entries: [entry()],
    ...overrides,
  };
}

/**
 * The ledger half of `recordBatch`, with its history declared away.
 *
 * Most cases here are about the ledger's own arithmetic — upsert, planning, locking — and have no
 * batch directory to archive into. They say so once, through this helper, rather than each
 * inventing a directory it does not otherwise use. The store's own cases call `recordBatch`
 * directly with a real one.
 */
function recordWithoutStore(path, payload) {
  return recordBatch(path, payload, { artifactsDir: null });
}

/**
 * The traces a real batch directory holds before it is recorded: one per link the batch processed.
 * Only `source_ref` is written — it is the one field the record-time guard reads.
 */
function seedTraces(dir, urls = [LINKEDIN_ONE, LINKEDIN_TWO, LINKEDIN_CLOSED]) {
  mkdirSync(join(dir, "traces"), { recursive: true });
  urls.forEach((url, position) => {
    writeFileSync(
      join(dir, "traces", `${String(position + 1).padStart(3, "0")}.trace.json`),
      `${JSON.stringify({ input_index: position + 1, source_ref: url })}\n`,
      "utf8",
    );
  });
}

/**
 * The plan a real batch directory holds before it is recorded: `planBatch` over the batch's links
 * against the ledger as it stood when the batch started, written under the name the core reads.
 * Called at the moment the batch would have planned — before its fetch, so before any later write
 * to the same ledger — because that timing is the whole point of the record-time guard.
 */
function seedPlan(
  dir,
  ledgerPath,
  urls = [LINKEDIN_ONE, LINKEDIN_TWO, LINKEDIN_CLOSED],
  asOf = "2026-08-18T12:00:00Z",
) {
  const plan = planBatch(readLedger(ledgerPath), urls, { asOf });
  writeFileSync(join(dir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return plan;
}

function errorCode(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof TriageLedgerError, `unexpected error type: ${error}`);
    return error.code;
  }
  return null;
}

function runCli(args, { ledgerPath, workspaceRoot }) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(ledgerPath === undefined ? {} : { JOB_PIPELINE_TRIAGE_LEDGER: ledgerPath }),
      ...(workspaceRoot === undefined ? {} : { JOB_PIPELINE_WORKSPACE_ROOT: workspaceRoot }),
    },
  });
}

test("one vacancy has one identity across the spellings a links file actually carries", () => {
  const canonical = vacancyIdentity(LINKEDIN_ONE);
  assert.equal(canonical.key, "linkedin:4418544694");
  assert.equal(canonical.source, "linkedin");
  assert.equal(canonical.url, "https://www.linkedin.com/jobs/view/4418544694");

  for (const spelling of [
    "https://WWW.LinkedIn.com/jobs/view/4418544694/",
    "https://www.linkedin.com/jobs/view/4418544694#top",
    "https://www.linkedin.com/jobs/view/4418544694/?utm_source=share&utm_medium=member",
    "https://www.linkedin.com/jobs/view/4418544694/?refId=abc&trackingId=xyz",
    "https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4418544694",
  ]) {
    assert.equal(vacancyIdentity(spelling).key, canonical.key, spelling);
  }

  // A different posting must not collapse into it, whatever the query string says.
  assert.notEqual(vacancyIdentity(LINKEDIN_TWO).key, canonical.key);
});

test("a proven company link has a card-scoped disposition instead of retrying its old BLOCKED row", (t) => {
  const path = freshLedger(t);
  const { homepage, sourceSet, collectionText } = fictionalSourceSet();
  recordWithoutStore(
    path,
    batch({
      entries: [entry({ url: homepage, decision: "BLOCKED", flags: ["vacancy_unavailable"] })],
    }),
  );
  if (ledgerSourceApi.upgradeLedger) ledgerSourceApi.upgradeLedger(path);
  const plan = ledgerSourceApi.planSourceBatch
    ? ledgerSourceApi.planSourceBatch(path, sourceSet, {
        asOf: "2026-10-08T09:00:00Z",
        collectionText,
      })
    : {
        items: [
          {
            sources: planBatch(readLedger(path), [homepage], { asOf: "2026-10-08T09:00:00Z" })
              .items,
          },
        ],
      };
  assert.equal(plan.items[0].sources[0].action, "company_context");
  assert.equal(
    planBatch(readLedger(path), [homepage], { asOf: "2026-10-08T09:00:00Z" }).items[0].action,
    "retry_blocked",
    "a bare URL retains its own URL observation",
  );
});

test("LinkedIn's own share spellings collapse to the job id, not to a second row", () => {
  // Every one of these is a spelling LinkedIn itself hands out. A slug URL that failed to yield
  // the id would open a second ledger row for one posting, and the ledger would re-fetch a
  // vacancy it already knows is closed.
  for (const spelling of [
    "https://www.linkedin.com/jobs/view/senior-ai-automation-qa-engineer-at-bit-official-4418544694",
    "https://www.linkedin.com/jobs/view/senior-ai-automation-qa-engineer-at-bit-official-4418544694/?trk=public_jobs_topcard-title",
    "https://www.linkedin.com/jobs/view/4418544694%2F",
    "https://www.linkedin.com/jobs/view/4418544694/?position=1&pageNum=0",
  ]) {
    assert.equal(vacancyIdentity(spelling).key, "linkedin:4418544694", spelling);
  }
  // A slug carrying a different posting's id must not be pulled into that row.
  assert.equal(
    vacancyIdentity("https://www.linkedin.com/jobs/view/qa-automation-engineer-at-acme-4449892212")
      .key,
    "linkedin:4449892212",
  );
  // A view segment with no trailing id at all falls back to the URL rather than inventing one.
  assert.equal(
    vacancyIdentity("https://www.linkedin.com/jobs/view/qa-engineer-at-acme").key,
    "linkedin:https://www.linkedin.com/jobs/view/qa-engineer-at-acme",
  );
});

test("a batch cannot choose its own ledger key", (t) => {
  const path = freshLedger(t);
  // planBatch can only look a row up by the identity its URL produces, so a caller-supplied key
  // would be unreachable at batch start — and could park on another vacancy's key, silently
  // skipping a vacancy nobody triaged.
  for (const forged of [{ source: "linkedin" }, { job_id: "4449892212" }]) {
    assert.equal(
      errorCode(() => recordWithoutStore(path, batch({ entries: [entry(forged)] }))),
      "triage_ledger_invalid_batch",
      JSON.stringify(forged),
    );
  }
  recordWithoutStore(path, batch({ entries: [entry()] }));
  const plan = planBatch(readLedger(path), [LINKEDIN_ONE, LINKEDIN_TWO], {
    asOf: "2026-08-19T12:40:00Z",
  });
  assert.deepEqual(
    plan.items.map((item) => item.action),
    ["skip_known", "fetch_new"],
  );
});

test("a source without a readable id keeps the normalized URL as its identity", () => {
  const identity = vacancyIdentity("https://Jobs.Example.com/careers/qa-engineer/?utm_campaign=x");
  assert.equal(identity.source, "url");
  assert.equal(identity.key, "url:https://jobs.example.com/careers/qa-engineer");
  assert.equal(vacancyIdentity("https://jobs.example.com/careers/qa-engineer").key, identity.key);
  // A registry source that is not LinkedIn is still named, so a later adapter can claim it.
  assert.equal(vacancyIdentity("https://boards.greenhouse.io/acme/jobs/7").source, "greenhouse");
});

test("a non-http reference is rejected instead of becoming a ledger key", () => {
  for (const value of ["mailto:jobs@example.com", "javascript:alert(1)", "not a url", ""]) {
    assert.equal(
      errorCode(() => normalizeVacancyUrl(value)),
      "triage_ledger_invalid_url",
      value,
    );
  }
});

test("a batch write lands, and a re-triage keeps first_seen while advancing last_checked", (t) => {
  const path = freshLedger(t);
  const first = recordWithoutStore(path, batch());
  assert.deepEqual(first.added, ["linkedin:4418544694"]);
  assert.deepEqual(first.updated, []);

  const second = recordWithoutStore(
    path,
    batch({
      batch_id: "2026-08-25-linkedin-recheck",
      observed_at: "2026-08-25T09:00:00Z",
      entries: [entry({ status: "closed", decision: "SKIP", flags: [] })],
    }),
  );
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.updated, ["linkedin:4418544694"]);

  const ledger = readLedger(path);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].first_seen, "2026-08-18T12:40:00Z");
  assert.equal(ledger.entries[0].last_checked, "2026-08-25T09:00:00Z");
  assert.equal(ledger.entries[0].status, "closed");
  assert.equal(ledger.entries[0].batch_id, "2026-08-25-linkedin-recheck");
  assert.deepEqual(
    ledger.batches.map((record) => record.batch_id),
    ["2026-08-18-linkedin-1-10", "2026-08-25-linkedin-recheck"],
  );
});

test("an out-of-order replay never moves last_checked backwards", (t) => {
  const path = freshLedger(t);
  recordWithoutStore(path, batch({ observed_at: "2026-08-25T09:00:00Z" }));
  recordWithoutStore(
    path,
    batch({
      batch_id: "2026-08-18-replay",
      observed_at: "2026-08-18T12:40:00Z",
      entries: [entry({ status: "closed", decision: "SKIP", flags: [] })],
    }),
  );

  const [stored] = readLedger(path).entries;
  assert.equal(stored.first_seen, "2026-08-18T12:40:00Z");
  assert.equal(stored.last_checked, "2026-08-25T09:00:00Z");
});

test("every stored timestamp is the caller's, so a replay is byte-identical by construction", (t) => {
  const path = freshLedger(t);
  recordWithoutStore(path, batch());
  const once = readFileSync(path, "utf8");
  const stored = readLedger(path);
  // Frozen literals: a wall-clock stamp anywhere in the write path fails here even when the two
  // calls below happen inside the same millisecond, which is how a clock read hid before.
  assert.equal(stored.batches[0].recorded_at, "2026-08-18T12:40:00Z");
  assert.equal(stored.entries[0].first_seen, "2026-08-18T12:40:00Z");
  assert.equal(stored.entries[0].last_checked, "2026-08-18T12:40:00Z");

  recordWithoutStore(path, batch());
  assert.equal(readFileSync(path, "utf8"), once);
});

test("the core reads no clock at all", () => {
  // The behavioural pin above cannot see a clock read that only affects a field it does not
  // assert, so the claim is pinned at the source too: no Date.now(), no argument-less new Date().
  const source = readFileSync(corePath, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  assert.equal(source.includes("Date.now("), false);
  assert.doesNotMatch(source, /new Date\(\s*\)/);
  assert.doesNotMatch(source, /performance\.now|hrtime/);
  // No window is computed any more, so the core builds no Date at all.
  assert.doesNotMatch(source, /new Date\(/);
});

test("a batch that did not observe a vacancy fact does not delete it", (t) => {
  const path = freshLedger(t);
  recordWithoutStore(
    path,
    batch({
      entries: [entry({ title: "Senior QA", company: "BIT Official", priority_class: 1 })],
    }),
  );
  // A re-triage whose fetch failed observed no class: the one the ledger holds must survive it.
  recordWithoutStore(
    path,
    batch({
      batch_id: "2026-08-25-liveness",
      observed_at: "2026-08-25T09:00:00Z",
      policy_id: "triage-v2-2026-08-25",
      entries: [entry({ decision: "BLOCKED", flags: ["vacancy_unavailable"] })],
    }),
  );

  const [stored] = readLedger(path).entries;
  assert.equal(stored.priority_class, 1);
  assert.equal(stored.title, "Senior QA");
  assert.equal(stored.company, "BIT Official");
  assert.equal(stored.decision, "BLOCKED");
  // A decision-scoped field follows the newer decision instead of lingering from the older one.
  assert.equal(stored.policy_id, "triage-v2-2026-08-25");

  recordWithoutStore(
    path,
    batch({
      batch_id: "2026-08-26-reclass",
      observed_at: "2026-08-26T09:00:00Z",
      entries: [entry({ priority_class: 3 })],
    }),
  );
  const [reclassified] = readLedger(path).entries;
  assert.equal(reclassified.priority_class, 3, "an observed value still wins");
  assert.equal(Object.hasOwn(reclassified, "policy_id"), false, "a policy id is not carried over");
});

test("a batch id describes one batch: replay is allowed, reuse is not", (t) => {
  const path = freshLedger(t);
  recordWithoutStore(
    path,
    batch({ entries: [entry({ url: LINKEDIN_ONE }), entry({ url: LINKEDIN_TWO })] }),
  );
  const twoEntries = readFileSync(path, "utf8");

  // Same id, same entries: the retry ADR 0011 requires after a crash of unknown outcome.
  recordWithoutStore(
    path,
    batch({ entries: [entry({ url: LINKEDIN_ONE }), entry({ url: LINKEDIN_TWO })] }),
  );
  assert.equal(readFileSync(path, "utf8"), twoEntries);

  // Same id, same entries in another order: still the same batch. A retry that rebuilds the
  // batch from concurrent fetches can legitimately hand them over shuffled.
  recordWithoutStore(
    path,
    batch({ entries: [entry({ url: LINKEDIN_TWO }), entry({ url: LINKEDIN_ONE })] }),
  );
  assert.equal(readFileSync(path, "utf8"), twoEntries);

  // Same id, different entries: refused, because the batch record would stop describing the rows
  // that carry its id.
  assert.equal(
    errorCode(() =>
      recordWithoutStore(path, batch({ entries: [entry({ url: LINKEDIN_CLOSED })] })),
    ),
    "triage_ledger_batch_id_reused",
  );
  assert.equal(readFileSync(path, "utf8"), twoEntries, "the refusal wrote nothing");
  assert.equal(readLedger(path).batches[0].entry_count, 2);

  // Same id, same entry count, different content: the check is over what the batch wrote, not
  // over how much of it there was.
  assert.equal(
    errorCode(() =>
      recordWithoutStore(
        path,
        batch({
          entries: [entry({ url: LINKEDIN_ONE }), entry({ url: LINKEDIN_CLOSED })],
        }),
      ),
    ),
    "triage_ledger_batch_id_reused",
  );
  // And a changed decision on the same two vacancies is a different batch too.
  assert.equal(
    errorCode(() =>
      recordWithoutStore(
        path,
        batch({
          entries: [
            entry({ url: LINKEDIN_ONE }),
            entry({ url: LINKEDIN_TWO, decision: "EVALUATED" }),
          ],
        }),
      ),
    ),
    "triage_ledger_batch_id_reused",
  );
  assert.equal(readFileSync(path, "utf8"), twoEntries, "neither refusal wrote anything");
});

test("a write that fails mid-flight leaves no temp file and no held lock", (t) => {
  const root = disposableRoot(t);
  // A ledger name long enough that `<name>.<pid>.<hex>.tmp` exceeds NAME_MAX while `<name>.lock`
  // still fits: the lock is therefore taken normally and the temp write is what fails, which is
  // the path under test. Failing at lock creation instead would report the same error code and
  // prove nothing about temp-file cleanup.
  const path = join(root, `${"l".repeat(240)}.json`);
  initLedger(path);

  assert.equal(
    errorCode(() => recordWithoutStore(path, batch())),
    "triage_ledger_unwritable",
  );
  assert.deepEqual(readdirSync(root), [`${"l".repeat(240)}.json`], "no temp file, no lock left");
  assert.deepEqual(readLedger(path).entries, [], "the ledger itself is untouched");
});

test("the write path removes its own temp file when it fails after creating it", () => {
  // The behavioural case above can only fail the temp *open*, so nothing is created and the
  // cleanup branch is not exercised. A failure after creation (a full disk, a revoked
  // permission mid-write, a rename across devices) is not portably injectable from a test, so
  // the claim is pinned on the shape of the writer instead: one try covering both the write and
  // the rename, whose catch unlinks the temp path before reporting.
  const source = readFileSync(corePath, "utf8");
  const writer = source
    .slice(
      source.indexOf("function writeWithinLock"),
      source.indexOf("export function withLedgerLock"),
    )
    .replace(/\s+/g, " ");
  assert.match(
    writer,
    /try \{ writeFileSync\(temporaryPath, bytes, \{ mode: 0o600 \}\); renameSync\(temporaryPath, path\); \} catch \(error\) \{/,
  );
  assert.match(writer, /catch \(error\) \{[^}]*try \{ unlinkSync\(temporaryPath\); \}/);
});

test("the record writer reports a failed write with a code, like every other exit here", () => {
  // A write that fails after the file exists (a full disk, a revoked permission mid-write) is not
  // portably injectable, so the claim is pinned on the shape of the writer instead — the same way
  // the ledger's own post-create failure is pinned above. Without this, removing the catch
  // restores a raw fs error escaping a module where every other exit carries a code, and nothing
  // goes red.
  const source = readFileSync(corePath, "utf8");
  const start = source.indexOf("function persistBatchRecord");
  const end = source.indexOf("* Batch-end write.");
  // Both anchors, checked: a slice taken from anchors that moved or vanished is empty, and an
  // empty slice would pass a "does not contain" test and fail a "contains" one for the wrong
  // reason. Say which it was.
  assert.ok(start >= 0 && end > start, `writer anchors moved: start=${start} end=${end}`);
  const writer = source.slice(start, end).replace(/\s+/g, " ");
  assert.match(writer, /try \{ writeSync\(descriptor, [^;]+\); \} catch \(error\) \{/);
  assert.match(writer, /catch \(error\) \{[^}]*"triage_ledger_record_unwritable"/);
  assert.match(writer, /\} finally \{ closeSync\(descriptor\); \}/);
});

test("a root the writer cannot enter fails before it touches anything", (t) => {
  const root = disposableRoot(t);
  const path = join(root, "triage-ledger.json");
  initLedger(path);
  chmodSync(root, 0o500);
  try {
    // Here the lock is what cannot be created; the point is that the failure is still reported
    // rather than swallowed, and the ledger survives it.
    assert.equal(
      errorCode(() => recordWithoutStore(path, batch())),
      "triage_ledger_unwritable",
    );
    assert.deepEqual(readLedger(path).entries, []);
  } finally {
    // Restored inline, not in an after hook: the root's own cleanup hook runs first and would
    // remove the directory before a later hook could chmod it back.
    chmodSync(root, 0o700);
  }
});

test("a malformed batch is refused with the code that names the defect", (t) => {
  const path = freshLedger(t);
  const cases = [
    [batch({ batch_id: "not an identifier" }), "triage_ledger_invalid_batch"],
    [batch({ observed_at: "2026-08-18" }), "triage_ledger_invalid_batch"],
    [batch({ entries: [] }), "triage_ledger_invalid_batch"],
    [batch({ entries: [entry(), entry()] }), "triage_ledger_invalid_batch"],
    [batch({ entries: [{ ...entry(), unexpected: 1 }] }), "triage_ledger_invalid_batch"],
    [batch({ entries: [entry({ status: "dead" })] }), "triage_ledger_invalid_entry"],
    [batch({ entries: [entry({ decision: "manual_review" })] }), "triage_ledger_invalid_entry"],
    [batch({ entries: [entry({ flags: ["two words"] })] }), "triage_ledger_invalid_entry"],
    [batch({ entries: [entry({ flags: ["dup", "dup"] })] }), "triage_ledger_invalid_entry"],
    [batch({ entries: [entry({ priority_class: 0 })] }), "triage_ledger_invalid_entry"],
    [batch({ entries: [entry({ url: "mailto:jobs@example.com" })] }), "triage_ledger_invalid_url"],
  ];
  for (const [payload, expected] of cases) {
    assert.equal(
      errorCode(() => recordWithoutStore(path, payload)),
      expected,
      JSON.stringify(payload),
    );
  }
  assert.deepEqual(readLedger(path).entries, [], "a refused batch must not write anything");
});

test("the read path never creates the ledger it cannot find", (t) => {
  const path = join(disposableRoot(t), "triage-ledger.json");
  assert.equal(
    errorCode(() => readLedger(path)),
    "triage_ledger_missing",
  );
  assert.equal(
    errorCode(() => recordWithoutStore(path, batch())),
    "triage_ledger_missing",
  );
  assert.equal(existsSync(path), false);
});

test("init creates a private empty ledger once and never truncates an existing one", (t) => {
  const path = join(disposableRoot(t), "triage-ledger.json");
  const created = initLedger(path);
  assert.equal(created.created, true);
  assert.deepEqual(readLedger(path), emptyLedger());
  assert.equal(statSync(path).mode & 0o777, 0o600);

  recordWithoutStore(path, batch());
  const again = initLedger(path);
  assert.equal(again.created, false);
  assert.equal(readLedger(path).entries.length, 1);
});

test("a corrupted ledger fails loudly instead of being silently replaced", (t) => {
  const path = join(disposableRoot(t), "triage-ledger.json");
  writeFileSync(path, "{ not json\n");
  assert.equal(
    errorCode(() => readLedger(path)),
    "triage_ledger_unreadable",
  );

  writeFileSync(path, `${JSON.stringify({ ...emptyLedger(), schema_version: 3 })}\n`);
  assert.equal(
    errorCode(() => readLedger(path)),
    "triage_ledger_schema_version",
  );

  const duplicated = {
    ...emptyLedger(),
    entries: [validEntry(), validEntry()],
  };
  assert.equal(
    errorCode(() => validateLedger(duplicated)),
    "triage_ledger_invalid",
  );
});

function validEntry(overrides = {}) {
  return {
    key: "linkedin:4418544694",
    source: "linkedin",
    job_id: "4418544694",
    url: "https://www.linkedin.com/jobs/view/4418544694",
    first_seen: "2026-08-18T12:40:00Z",
    last_checked: "2026-08-18T12:40:00Z",
    status: "open",
    batch_id: "b1",
    decision: "MANUAL_REVIEW",
    flags: ["relocation_floor_missing"],
    ...overrides,
  };
}

test("a stored key that disagrees with its own source and job id is invalid", () => {
  assert.equal(
    errorCode(() =>
      validateLedger({ ...emptyLedger(), entries: [validEntry({ key: "linkedin:1" })] }),
    ),
    "triage_ledger_invalid_entry",
  );
  assert.equal(
    errorCode(() =>
      validateLedger({
        ...emptyLedger(),
        entries: [validEntry({ url: "https://www.linkedin.com/jobs/view/4418544694/" })],
      }),
    ),
    "triage_ledger_invalid_entry",
  );
  assert.equal(
    errorCode(() =>
      validateLedger({
        ...emptyLedger(),
        entries: [validEntry({ first_seen: "2026-08-19T00:00:00Z" })],
      }),
    ),
    "triage_ledger_invalid_entry",
  );
});

test("the batch-start plan skips what the ledger knows and retries only a failed fetch", (t) => {
  const path = freshLedger(t);
  recordWithoutStore(
    path,
    batch({
      entries: [
        entry({ url: LINKEDIN_CLOSED, status: "closed", decision: "SKIP", flags: [] }),
        entry({ url: LINKEDIN_ONE }),
        entry({
          url: LINKEDIN_TWO,
          decision: "MANUAL_REVIEW",
          flags: ["engagement_path_unknown"],
          priority_class: 1,
        }),
        entry({ url: LINKEDIN_BLOCKED, decision: "BLOCKED", flags: ["vacancy_unavailable"] }),
      ],
    }),
  );

  const links = [
    LINKEDIN_CLOSED,
    LINKEDIN_ONE,
    LINKEDIN_TWO,
    LINKEDIN_BLOCKED,
    "https://www.linkedin.com/jobs/view/4452389499/",
    "https://www.linkedin.com/jobs/view/4452389499/?utm_source=share",
    "mailto:jobs@example.com",
  ];
  const expected = [
    "skip_closed",
    "skip_known",
    "skip_known",
    "retry_blocked",
    "fetch_new",
    "fetch_new",
    null,
  ];
  // No date decides anything: one minute after the batch and a year after it plan the same.
  for (const asOf of ["2026-08-18T12:41:00Z", "2027-08-18T12:40:00Z"]) {
    const plan = planBatch(readLedger(path), links, { asOf });
    assert.deepEqual(
      plan.items.map((item) => item.action),
      expected,
      asOf,
    );
    assert.deepEqual(
      plan.items.map((item) => item.input_index),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.equal(plan.items[5].duplicate_in_batch, true);
    assert.equal(plan.items[4].duplicate_in_batch, false);
    assert.equal(plan.items[6].reason, "triage_ledger_invalid_url");
    assert.deepEqual(plan.counts, {
      fetch_new: 2,
      retry_blocked: 1,
      skip_known: 2,
      skip_closed: 1,
      invalid: 1,
    });
    assert.equal(plan.fetch, 3);
    assert.equal(plan.items[0].reason, "ledger status closed");
    assert.equal(plan.items[1].reason, "already triaged");
    assert.equal(plan.items[3].reason, "last fetch failed");
    assert.equal(Object.hasOwn(plan, "cadence_days"), false);
    assert.equal(Object.hasOwn(plan.items[1], "recheck_due_on"), false);
    assert.equal(plan.items[1].last_checked, "2026-08-18T12:40:00Z");
  }
});

test("the literal the plan retries on is the decision the scorer emits for a failed fetch", () => {
  // Frozen here, not read from either module: a renamed decision reddens this case instead of
  // stranding every failed row as `skip_known`.
  const scorer = readFileSync(join(repoRoot, "tools/job-scorer/decide.mjs"), "utf8");
  const core = readFileSync(corePath, "utf8");
  assert.match(scorer, /decision: "BLOCKED"/);
  assert.match(core, /export const triageRetryDecision = "BLOCKED";/);
});

test("an expired posting is as terminal as a closed one", (t) => {
  const path = freshLedger(t);
  recordWithoutStore(
    path,
    batch({
      entries: [entry({ status: "expired", decision: "SKIP", flags: [] })],
    }),
  );
  const plan = planBatch(readLedger(path), [LINKEDIN_ONE], { asOf: "2027-01-01T00:00:00Z" });
  assert.equal(plan.items[0].action, "skip_closed");
});

test("the review groups open flags into one group per decision, closed rows excluded", (t) => {
  const path = freshLedger(t);
  recordWithoutStore(
    path,
    batch({
      entries: [
        entry({
          url: LINKEDIN_ONE,
          flags: ["relocation_floor_missing", "residence_restriction_incompatible"],
        }),
        entry({ url: LINKEDIN_TWO, flags: ["engagement_path_unknown"], priority_class: 1 }),
        entry({
          url: "https://www.linkedin.com/jobs/view/4450463394/",
          flags: ["relocation_floor_missing"],
        }),
        entry({
          url: LINKEDIN_CLOSED,
          status: "closed",
          decision: "SKIP",
          flags: ["never_reviewed"],
        }),
        entry({
          url: "https://www.linkedin.com/jobs/view/4443093724/",
          decision: "EVALUATED",
          flags: [],
        }),
      ],
    }),
  );

  const review = reviewLedger(readLedger(path), { asOf: "2026-08-21T12:40:00Z" });
  assert.deepEqual(review.totals, {
    entries: 5,
    open: 4,
    closed: 1,
    flagged_open: 3,
    unflagged_open: 1,
    fast_lane_open: 1,
    decision_groups: 3,
  });
  // Fast lane first, then the larger group, then alphabetical: deterministic every run.
  assert.deepEqual(
    review.groups.map((group) => group.flag),
    ["engagement_path_unknown", "relocation_floor_missing", "residence_restriction_incompatible"],
  );
  assert.equal(review.groups[0].fast_lane, true);
  assert.equal(review.groups[1].count, 2);
  assert.equal(Object.hasOwn(review, "cadence_days"), false);
  for (const group of review.groups) {
    assert.equal(Object.hasOwn(group, "recheck_overdue"), false, group.flag);
    for (const row of group.entries) assert.equal(Object.hasOwn(row, "recheck_due_on"), false);
  }
  assert.equal(
    review.groups.some((group) => group.flag === "never_reviewed"),
    false,
    "a closed vacancy never asks the user for a decision",
  );
});

test("a policy-v2 gap annotation groups exactly like a v1 review reason", (t) => {
  const path = freshLedger(t);
  const v2Flags = ["gap:compensation_absent", "assumption:engagement_path.contractor_ge"];
  recordWithoutStore(
    path,
    batch({
      entries: [entry({ decision: "EVALUATED", flags: v2Flags, priority_class: 1 })],
    }),
  );

  const review = reviewLedger(readLedger(path), { asOf: "2026-08-18T12:40:00Z" });
  assert.deepEqual(
    review.groups.map((group) => group.flag),
    [...v2Flags].sort(),
  );
  assert.equal(review.totals.flagged_open, 1);
  for (const group of review.groups) assert.equal(group.fast_lane, true);
});

test("two writers serialize instead of losing a batch", (t) => {
  const root = disposableRoot(t);
  const path = join(root, "triage-ledger.json");
  initLedger(path);
  const childPath = join(root, "record-child.mjs");
  writeFileSync(
    childPath,
    [
      `import { recordBatch } from ${JSON.stringify(corePath)};`,
      "const [ledgerPath, batchId, url] = process.argv.slice(2);",
      "recordBatch(ledgerPath, {",
      "  batch_id: batchId,",
      '  observed_at: "2026-08-18T12:40:00Z",',
      '  entries: [{ url, status: "open", decision: "MANUAL_REVIEW", flags: ["work_format_unknown"] }],',
      "}, { artifactsDir: null });",
      "",
    ].join("\n"),
  );

  const children = [
    [path, "concurrent-a", LINKEDIN_ONE],
    [path, "concurrent-b", LINKEDIN_TWO],
  ].map((args) => spawnSync(process.execPath, [childPath, ...args], { encoding: "utf8" }));
  for (const child of children) assert.equal(child.status, 0, child.stderr);

  const ledger = readLedger(path);
  assert.deepEqual(ledger.entries.map((record) => record.key).sort(), [
    "linkedin:4418544694",
    "linkedin:4449892212",
  ]);
  assert.deepEqual(ledger.batches.map((record) => record.batch_id).sort(), [
    "concurrent-a",
    "concurrent-b",
  ]);
  assert.equal(existsSync(`${path}.lock`), false, "the lock is released");
});

test("a held lock is reported, never stolen", (t) => {
  const path = freshLedger(t);
  const heldLock = `${path}.lock`;
  mkdirSync(heldLock);

  assert.equal(
    errorCode(() => recordWithoutStore(path, batch())),
    "triage_ledger_locked",
  );
  assert.equal(existsSync(heldLock), true, "a foreign lock survives the failure");
});

test("the CLI reads, creates on request, and refuses anything it does not know", (t) => {
  const root = disposableRoot(t);
  const path = join(root, "triage-ledger.json");

  const missing = runCli(["show"], { ledgerPath: path });
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).error.code, "triage_ledger_missing");
  assert.equal(existsSync(path), false, "a read must not create the ledger");

  const created = runCli(["init"], { ledgerPath: path });
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).created, true);

  recordWithoutStore(
    path,
    batch({
      entries: [
        entry({ url: LINKEDIN_ONE }),
        entry({ url: LINKEDIN_TWO, flags: ["engagement_path_unknown"], priority_class: 1 }),
        entry({ url: LINKEDIN_CLOSED, status: "closed", decision: "SKIP", flags: [] }),
      ],
    }),
  );

  const shown = JSON.parse(runCli(["show", "--compact"], { ledgerPath: path }).stdout);
  assert.deepEqual(shown.by_status, { open: 2, closed: 1 });
  assert.equal(shown.entries, 3);
  assert.equal(shown.ledger, undefined);

  const review = JSON.parse(
    runCli(["review", "--as-of", "2026-08-21", "--compact"], { ledgerPath: path }).stdout,
  );
  assert.equal(review.as_of, "2026-08-21T00:00:00Z");
  assert.deepEqual(
    review.groups.map((group) => group.flag),
    ["engagement_path_unknown", "relocation_floor_missing"],
  );
  assert.deepEqual(review.groups[0].keys, ["linkedin:4449892212"]);
  assert.equal(review.totals.closed, 1);

  const validated = JSON.parse(runCli(["validate"], { ledgerPath: path }).stdout);
  assert.equal(validated.status, "valid");
  assert.equal(Object.hasOwn(validated, "cadence_days"), false);

  for (const args of [
    ["plan"],
    ["review", "--url", LINKEDIN_ONE],
    ["review", "--as-of", "yesterday"],
  ]) {
    const rejected = runCli(args, { ledgerPath: path });
    assert.equal(rejected.status, 1, args.join(" "));
    assert.ok(JSON.parse(rejected.stderr).error.code.length > 0, args.join(" "));
  }
});

test("the CLI resolves its default ledger inside the workspace it is pointed at", (t) => {
  const root = disposableRoot(t);
  const created = runCli(["init"], { workspaceRoot: root });
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).path, join(root, "triage-ledger.json"));
  assert.equal(existsSync(join(root, "triage-ledger.json")), true);
});

test("no CLI surface accepts a vacancy value, so ADR 0011 has nothing to escape", () => {
  const cli = readFileSync(cliPath, "utf8");
  for (const forbidden of [
    "--url",
    "--source-ref",
    "--company",
    "--title",
    "--flag",
    "--batch-id",
  ]) {
    assert.equal(cli.includes(forbidden), false, forbidden);
  }
  // The two mutating paths are module APIs; the CLI must not grow a shell-facing writer.
  assert.equal(cli.includes("recordBatch"), false);
  assert.equal(cli.includes("planBatch"), false);
  assert.match(cli, /input-file input-<32-hex>\.json/);
});

test("the runbook maps every flag family to one decision and names no re-check window", () => {
  const runbook = readFileSync(join(repoRoot, "docs/runbooks/triage-review.md"), "utf8");
  assert.doesNotMatch(runbook, /\|\s*(fast lane|standard)[^|]*\|\s*\d+ days\s*\|/i);
  assert.doesNotMatch(runbook, /skip_recent|refetch_due|recheck_overdue/);
  // Every flag family the runbook maps must resolve to exactly one decision line.
  const mapped = [...runbook.matchAll(/^\| `([a-z0-9_:.-]+)` \|/gm)].map((match) => match[1]);
  assert.ok(mapped.length >= 4, `expected a decision table, found ${mapped.length} rows`);
  assert.equal(new Set(mapped).size, mapped.length, "a flag family maps to one decision only");
});

test("a batch is archived where it was built, and the ledger row names the same digest", (t) => {
  const path = freshLedger(t);
  const dir = join(dirname(path), "triage-batches", "2026-08-18-linkedin-1-10");
  mkdirSync(dir, { recursive: true });
  seedTraces(dir);
  seedPlan(dir, path);

  const outcome = recordBatch(
    path,
    batch({
      policy_id: "triage-policy-v2-2026-08-21",
      entries: [entry({ url: LINKEDIN_ONE }), entry({ url: LINKEDIN_TWO, decision: "EVALUATED" })],
    }),
    { artifactsDir: dir },
  );

  assert.equal(outcome.record.path, join(dir, "ledger-record.json"));
  assert.equal(outcome.record.written, true);
  assert.equal(statSync(outcome.record.path).mode & 0o777, 0o600);

  const record = readBatchRecord(dir);
  assert.equal(record.schema_version, 1);
  assert.equal(record.batch_id, "2026-08-18-linkedin-1-10");
  assert.equal(record.observed_at, "2026-08-18T12:40:00Z");
  assert.equal(record.policy_id, "triage-policy-v2-2026-08-21");
  // Acceptance: every persisted record carries the stable vacancy key — derived, never supplied,
  // so a later step can join to it without agreeing on a second identity scheme.
  assert.deepEqual(record.entries.map((row) => row.key).sort(), [
    "linkedin:4418544694",
    "linkedin:4449892212",
  ]);
  for (const row of record.entries) {
    assert.equal(row.policy_id, "triage-policy-v2-2026-08-21");
    assert.equal(row.batch_id, "2026-08-18-linkedin-1-10");
  }
  // The ledger row and the record are two halves a caller holding both can compare.
  assert.equal(readLedger(path).batches[0].entries_digest, record.entries_digest);
});

test("a re-score adds a record beside the first instead of replacing it", (t) => {
  const path = freshLedger(t);
  const store = join(dirname(path), "triage-batches");
  const first = join(store, "2026-08-18-linkedin-1-10");
  const second = join(store, "2026-08-25-linkedin-1-10");
  mkdirSync(first, { recursive: true });
  seedTraces(first);
  mkdirSync(second, { recursive: true });
  seedTraces(second);

  seedPlan(first, path);
  recordBatch(
    path,
    batch({
      policy_id: "triage-policy-v2-2026-08-21",
      entries: [entry({ decision: "MANUAL_REVIEW", flags: ["gap:compensation_absent"] })],
    }),
    { artifactsDir: first },
  );
  // The re-score plans after the first batch recorded, so its plan knows the row it will replace.
  seedPlan(second, path, undefined, "2026-08-25T08:00:00Z");
  recordBatch(
    path,
    batch({
      batch_id: "2026-08-25-linkedin-1-10",
      observed_at: "2026-08-25T09:00:00Z",
      policy_id: "triage-policy-v3-2026-08-30",
      entries: [entry({ decision: "EVALUATED", flags: [] })],
    }),
    { artifactsDir: second },
  );

  // The ledger keeps one row: it is the index of what is true now, and the older decision is gone
  // from it. That is exactly why the two records have to exist.
  const ledger = readLedger(path);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].decision, "EVALUATED");

  // Acceptance: the same vacancy scored in two batches yields two readable records, each with its
  // own instant and policy_id, and neither is destroyed by the other.
  const observed = [first, second].map((dir) => {
    const record = readBatchRecord(dir);
    return [
      record.entries[0].key,
      record.observed_at,
      record.policy_id,
      record.entries[0].decision,
      record.entries[0].flags,
    ];
  });
  assert.deepEqual(observed, [
    [
      "linkedin:4418544694",
      "2026-08-18T12:40:00Z",
      "triage-policy-v2-2026-08-21",
      "MANUAL_REVIEW",
      ["gap:compensation_absent"],
    ],
    ["linkedin:4418544694", "2026-08-25T09:00:00Z", "triage-policy-v3-2026-08-30", "EVALUATED", []],
  ]);
});

test("a record is written once: a replay is accepted, a different batch never overwrites", (t) => {
  const path = freshLedger(t);
  const dir = join(disposableRoot(t, "triage-batch-"), "batch");
  mkdirSync(dir);
  seedTraces(dir);
  seedPlan(dir, path);

  recordBatch(path, batch({ policy_id: "p1" }), { artifactsDir: dir });
  const written = readFileSync(join(dir, "ledger-record.json"), "utf8");

  // A replay of the same batch — the retry after a crash with an unknown outcome — finds its own
  // record already there and accepts it rather than rewriting it.
  const replay = recordBatch(path, batch({ policy_id: "p1" }), { artifactsDir: dir });
  assert.equal(replay.record.written, false);
  assert.equal(readFileSync(join(dir, "ledger-record.json"), "utf8"), written, "byte-identical");

  // A different batch under the same id is refused by the ledger's own guard, before the store.
  assert.equal(
    errorCode(() =>
      recordBatch(
        path,
        batch({
          policy_id: "p1",
          entries: [entry({ decision: "EVALUATED" })],
        }),
        { artifactsDir: dir },
      ),
    ),
    "triage_ledger_batch_id_reused",
  );
  // And a different batch whose directory already holds someone else's record is refused there:
  // the store has no writer that can replace a record.
  assert.equal(
    errorCode(() =>
      recordBatch(
        path,
        batch({
          batch_id: "2026-08-25-linkedin-1-10",
          policy_id: "p1",
          entries: [entry({ decision: "EVALUATED" })],
        }),
        { artifactsDir: dir },
      ),
    ),
    "triage_ledger_record_conflict",
  );
  assert.equal(readFileSync(join(dir, "ledger-record.json"), "utf8"), written, "still untouched");
});

test("a torn record is unreadable rather than a conflict, and a replay recovers the batch", (t) => {
  const path = freshLedger(t);
  const dir = join(disposableRoot(t, "triage-batch-"), "batch");
  mkdirSync(dir);
  seedTraces(dir);
  seedPlan(dir, path);
  const recordPath = join(dir, "ledger-record.json");

  // What a crash mid-write leaves: a file that exists and does not describe its own rows. Its
  // remediation differs from a digest that disagrees, so its code does too.
  writeFileSync(recordPath, '{\n  "schema_version": 1,\n  "batch_id": "trunc');
  assert.equal(
    errorCode(() => readBatchRecord(dir)),
    "triage_ledger_record_unreadable",
  );
  assert.equal(
    errorCode(() => recordBatch(path, batch({ policy_id: "p1" }), { artifactsDir: dir })),
    "triage_ledger_record_unreadable",
  );
  assert.deepEqual(readLedger(path).entries, [], "a record it cannot read stops the ledger write");

  // A record whose digest does not describe its own entries is the same class of defect.
  const valid = { ...batch({ policy_id: "p1" }) };
  rmSync(recordPath);
  recordBatch(path, valid, { artifactsDir: dir });
  const parsed = JSON.parse(readFileSync(recordPath, "utf8"));
  parsed.entries[0].decision = "EVALUATED";
  writeFileSync(recordPath, `${JSON.stringify(parsed, null, 2)}\n`);
  assert.equal(
    errorCode(() => readBatchRecord(dir)),
    "triage_ledger_record_unreadable",
  );
});

test("a ledger write that fails after the record leaves the record, and a replay finishes it", (t) => {
  const root = disposableRoot(t);
  // The same NAME_MAX trick the temp-file case uses: `initLedger` writes at the final name and
  // succeeds, while `writeWithinLock`'s `<name>.<pid>.<hex>.tmp` does not fit. So the ledger write
  // fails *after* `operate()` returned — which is the one place the record-then-ledger order can
  // be observed from outside.
  const doomed = join(root, `${"l".repeat(240)}.json`);
  initLedger(doomed);
  const dir = join(root, "batch");
  mkdirSync(dir);
  seedTraces(dir);
  seedPlan(dir, doomed);

  assert.equal(
    errorCode(() => recordBatch(doomed, batch({ policy_id: "p1" }), { artifactsDir: dir })),
    "triage_ledger_unwritable",
  );
  // The orphan the runbook names: a valid record whose batch the ledger does not know.
  const orphan = readBatchRecord(dir);
  assert.equal(orphan.batch_id, "2026-08-18-linkedin-1-10");
  assert.deepEqual(readLedger(doomed).batches, [], "the ledger never learned of the batch");

  // The prescribed cure, against a ledger that can be written: the existing record is accepted as
  // this batch's own and the ledger row lands beside it.
  const healthy = join(root, "triage-ledger.json");
  initLedger(healthy);
  const replay = recordBatch(healthy, batch({ policy_id: "p1" }), { artifactsDir: dir });
  assert.equal(replay.record.written, false, "the orphan is adopted, not rewritten");
  assert.equal(readLedger(healthy).batches[0].entries_digest, orphan.entries_digest);
});

test("the archive is declared, not defaulted, and an archived batch names its policy", (t) => {
  const path = freshLedger(t);
  const dir = join(disposableRoot(t, "triage-batch-"), "batch");
  mkdirSync(dir);

  // The omission that cost the batch of 2026-08-26 its fifteen traces is now an error, and the
  // deliberate opt-out is a value rather than a silence.
  assert.equal(
    errorCode(() => recordBatch(path, batch({ policy_id: "p1" }))),
    "triage_ledger_record_undeclared",
  );
  assert.equal(
    errorCode(() => recordBatch(path, batch({ policy_id: "p1" }), {})),
    "triage_ledger_record_undeclared",
  );
  assert.equal(
    errorCode(() => recordBatch(path, batch({ policy_id: "p1" }), { artifactDir: dir })),
    "triage_ledger_record_undeclared",
  );
  assert.equal(
    errorCode(() => recordBatch(path, batch({ policy_id: "p1" }), { artifactsDir: "relative" })),
    "triage_ledger_record_dir_invalid",
  );
  // An archived decision that cannot say which policy produced it cannot be read beside a later
  // one, so the archive path requires it while the ledger schema keeps it optional.
  assert.equal(
    errorCode(() => recordBatch(path, batch(), { artifactsDir: dir })),
    "triage_ledger_record_missing_policy",
  );
  assert.equal(
    errorCode(() =>
      recordBatch(path, batch({ policy_id: "p1" }), {
        artifactsDir: join(dir, "absent"),
      }),
    ),
    "triage_ledger_record_dir_missing",
  );
  assert.deepEqual(readLedger(path).entries, [], "no refusal wrote a ledger row");
  assert.deepEqual(readdirSync(dir), [], "and none invented an archive");

  // The explicit opt-out writes the ledger and nothing else.
  recordWithoutStore(path, batch());
  assert.equal(readLedger(path).entries.length, 1);
  assert.deepEqual(readdirSync(dir), []);
});

test("a link the batch published no trace for cannot be recorded, so its row keeps its observer", (t) => {
  const path = freshLedger(t);
  const observedAt = "2026-08-18T12:40:00Z";
  recordWithoutStore(path, batch({ entries: [entry({ url: LINKEDIN_CLOSED })] }));
  const before = readFileSync(path, "utf8");

  const dir = join(dirname(path), "triage-batches", "2026-08-25-linkedin-1-3");
  mkdirSync(dir, { recursive: true });
  // The batch withheld the third link: it processed two and published two traces.
  seedTraces(dir, [LINKEDIN_ONE, LINKEDIN_TWO]);
  // A trace that cannot be read, and one whose `source_ref` yields no identity, stand for nothing.
  writeFileSync(join(dir, "traces", "003.trace.json"), "{", "utf8");
  writeFileSync(
    join(dir, "traces", "004.trace.json"),
    JSON.stringify({ source_ref: "mailto:x@example.com" }),
    "utf8",
  );
  // The plan covers all three links: the withheld one as the ledger's skip, the two as new.
  seedPlan(dir, path, undefined, "2026-08-25T08:00:00Z");
  const later = {
    batch_id: "2026-08-25-linkedin-1-3",
    observed_at: "2026-08-25T09:00:00Z",
    policy_id: "p1",
  };

  // The literal reading of "one entry per input link": the withheld row copied forward.
  assert.equal(
    errorCode(() =>
      recordBatch(
        path,
        batch({
          ...later,
          entries: [
            entry({ url: LINKEDIN_ONE }),
            entry({ url: LINKEDIN_TWO }),
            entry({ url: LINKEDIN_CLOSED }),
          ],
        }),
        { artifactsDir: dir },
      ),
    ),
    "triage_ledger_entry_without_trace",
  );
  assert.equal(
    readFileSync(path, "utf8"),
    before,
    "a refused batch leaves the ledger byte-identical",
  );
  assert.equal(existsSync(join(dir, triageBatchRecordFileName)), false, "and writes no record");

  // The same batch without the withheld link records, and the withheld row is not touched.
  recordBatch(
    path,
    batch({
      ...later,
      entries: [entry({ url: LINKEDIN_ONE }), entry({ url: LINKEDIN_TWO })],
    }),
    { artifactsDir: dir },
  );
  const withheld = readLedger(path).entries.find((row) => row.key === "linkedin:4455248338");
  assert.equal(withheld.last_checked, observedAt);
  assert.equal(withheld.batch_id, "2026-08-18-linkedin-1-10");
});

test("the trace guard tells a missing directory from a directory without traces, and lets a replay through", (t) => {
  const path = freshLedger(t);
  const dir = join(disposableRoot(t, "triage-batch-"), "batch");
  mkdirSync(dir);
  // No `traces/` at all: no entry has a trace.
  assert.equal(
    errorCode(() => recordBatch(path, batch({ policy_id: "p1" }), { artifactsDir: dir })),
    "triage_ledger_entry_without_trace",
  );
  assert.deepEqual(readdirSync(dir), []);
  // No batch directory: the older code keeps the case.
  assert.equal(
    errorCode(() =>
      recordBatch(path, batch({ policy_id: "p1" }), { artifactsDir: join(dir, "absent") }),
    ),
    "triage_ledger_record_dir_missing",
  );

  seedTraces(dir, [LINKEDIN_ONE]);
  seedPlan(dir, path, [LINKEDIN_ONE]);
  recordBatch(path, batch({ policy_id: "p1" }), { artifactsDir: dir });
  // A replay of a batch the ledger already holds runs no guard: its traces may be gone by then.
  rmSync(join(dir, "traces"), { recursive: true });
  const replay = recordBatch(path, batch({ policy_id: "p1" }), { artifactsDir: dir });
  assert.equal(replay.record.written, false);
});

test("a batch record read back off disk is validated, never believed", (t) => {
  const path = freshLedger(t);
  const dir = join(disposableRoot(t, "triage-batch-"), "batch");
  mkdirSync(dir);
  seedTraces(dir);
  seedPlan(dir, path);
  recordBatch(path, batch({ policy_id: "p1" }), { artifactsDir: dir });
  const sound = JSON.parse(readFileSync(join(dir, "ledger-record.json"), "utf8"));

  assert.equal(
    errorCode(() => readBatchRecord(join(dir, "nowhere"))),
    "triage_ledger_record_absent",
  );
  for (const [mutate, expected] of [
    [
      (value) => {
        value.schema_version = 3;
      },
      "triage_ledger_record_schema_version",
    ],
    [
      (value) => {
        delete value.policy_id;
      },
      "triage_ledger_record_unreadable",
    ],
    [
      (value) => {
        value.batch_id = "not an identifier";
      },
      "triage_ledger_record_unreadable",
    ],
    [
      (value) => {
        value.observed_at = "2026-08-18";
      },
      "triage_ledger_record_unreadable",
    ],
    [
      (value) => {
        value.entries_digest = "nothex";
      },
      "triage_ledger_record_unreadable",
    ],
    [
      (value) => {
        value.entries = [];
      },
      "triage_ledger_record_unreadable",
    ],
    // The top-level id, left a valid identifier so the pattern check passes and the digest still
    // describes the entries: only the cross-batch loop can answer this one, and mutating an entry
    // instead would be answered by the digest as well.
    [
      (value) => {
        value.batch_id = "someone-elses-batch";
      },
      "triage_ledger_record_unreadable",
    ],
    // A hand-edited row is the case the repair table is written for, so it has to surface in the
    // record's own vocabulary rather than in the ledger's entry vocabulary — otherwise the table
    // an operator reads does not carry the code they were handed.
    [
      (value) => {
        value.entries[0].status = "dead";
      },
      "triage_ledger_record_unreadable",
    ],
    [
      (value) => {
        value.surprise = 1;
      },
      "triage_ledger_record_unreadable",
    ],
  ]) {
    const candidate = JSON.parse(JSON.stringify(sound));
    mutate(candidate);
    assert.equal(
      errorCode(() => validateBatchRecord(candidate)),
      expected,
      JSON.stringify(candidate).slice(0, 90),
    );
  }
  assert.equal(validateBatchRecord(JSON.parse(JSON.stringify(sound))).batch_id, sound.batch_id);
  assert.equal(triageBatchRecordFileName, "ledger-record.json");

  // Only a verdict about the data is translated into the record's vocabulary. Anything else is a
  // defect in this module, and relabelling it would hand the operator `_unreadable`, whose repair
  // is to delete the file — for a file that is intact. No test can reach that path without
  // injecting a defect, so the guard is pinned on the shape of the source, like the writer above.
  const validation = readFileSync(corePath, "utf8");
  const start = validation.indexOf("raw.entries.forEach((entry, index)");
  // Searched from `start`, because the closing anchor's text also occurs earlier, in the ledger's
  // own duplicate-key loop — an anchor that matched there would slice backwards to nothing.
  const end = validation.indexOf("for (const entry of raw.entries)", start);
  assert.ok(start >= 0 && end > start, `validation anchors moved: start=${start} end=${end}`);
  // Comments are stripped before matching, the way the flag-vocabulary pin above already does it:
  // the guard sits directly behind three comment lines, and a `}` typed into any of them would
  // otherwise redden a pin about code by editing prose.
  assert.match(
    validation
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
      .replace(/\s+/g, " "),
    /catch \(error\) \{[^}]*if \(!\(error instanceof TriageLedgerError\)\) throw error;/,
  );
});

test("the plan carries the policy its baseline decision was taken under", (t) => {
  const path = freshLedger(t);
  recordWithoutStore(
    path,
    batch({
      policy_id: "triage-policy-v2-2026-08-21",
      entries: [entry({ url: LINKEDIN_ONE })],
    }),
  );
  recordWithoutStore(
    path,
    batch({
      batch_id: "2026-08-19-linkedin-1-10",
      observed_at: "2026-08-19T12:40:00Z",
      entries: [entry({ url: LINKEDIN_TWO })],
    }),
  );

  const plan = planBatch(readLedger(path), [LINKEDIN_ONE, LINKEDIN_TWO, LINKEDIN_CLOSED], {
    asOf: "2026-08-30T12:40:00Z",
  });
  assert.equal(plan.items[0].policy_id, "triage-policy-v2-2026-08-21");
  // A row recorded without one says nothing rather than inventing a policy for it.
  assert.equal(Object.hasOwn(plan.items[1], "policy_id"), false);
  // And a link the ledger has never seen has no baseline to carry a policy for at all.
  assert.equal(Object.hasOwn(plan.items[2], "policy_id"), false);
});

test("the ledger is operational state: untracked, named by canon, owned by the runbook", () => {
  const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
  assert.match(gitignore, /^\/triage-ledger\.json$/m);
  assert.match(gitignore, /^triage-ledger\.json\.lock$/m);

  const operatingContract = readFileSync(
    join(repoRoot, "instructions/operating-contract.md"),
    "utf8",
  );
  assert.match(operatingContract, /triage-ledger\.json/);
  assert.match(operatingContract, /docs\/runbooks\/triage-review\.md/);

  const precedence = readFileSync(join(repoRoot, "knowledge/precedence.md"), "utf8");
  assert.match(precedence, /\| Batch-triage vacancy state[^|]*\| `triage-ledger\.json`[^|]*\|/);
  assert.match(
    precedence,
    /\| Flagged-triage review procedure[^|]*\| `docs\/runbooks\/triage-review\.md`[ \t]+\|/,
  );

  const skill = readFileSync(join(repoRoot, "instructions/skills/score-jobs.md"), "utf8");
  assert.match(skill, /tools\/lib\/triage-ledger-core\.mjs#planBatch/);
  assert.match(skill, /tools\/lib\/triage-ledger-core\.mjs#recordBatch/);
  assert.match(skill, /docs\/runbooks\/triage-review\.md/);
});

// ---------------------------------------------------------------- two batches, one vacancy

/**
 * A batch directory with its traces and its plan, planned against the ledger as it stands now.
 * The plan is taken here, at the batch's start, so a later write to the same ledger is exactly
 * what the record-time guard has to notice.
 */
function plannedBatchDir(t, ledgerPath, batchId, urls = [LINKEDIN_ONE]) {
  const dir = join(disposableRoot(t, "triage-batch-"), batchId);
  mkdirSync(dir);
  seedTraces(dir, urls);
  seedPlan(dir, ledgerPath, urls);
  return dir;
}

test("the synthetic path measures what the task filed: without a store the last writer wins", (t) => {
  const path = freshLedger(t);
  recordWithoutStore(
    path,
    batch({ batch_id: "measure-a", entries: [entry({ decision: "MANUAL_REVIEW" })] }),
  );
  recordWithoutStore(
    path,
    batch({
      batch_id: "measure-b",
      observed_at: "2026-08-18T12:41:00Z",
      entries: [entry({ decision: "EVALUATED", flags: [] })],
    }),
  );
  const ledger = readLedger(path);
  // One row, the later observation, both batches in the history list: this is the behaviour the
  // filing read from the code, now measured. It is confined to `{artifactsDir: null}`, which
  // declares no history and no directory and therefore has no plan to hold a write to.
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].decision, "EVALUATED");
  assert.equal(ledger.entries[0].batch_id, "measure-b");
  assert.deepEqual(
    ledger.batches.map((row) => row.batch_id),
    ["measure-a", "measure-b"],
  );
});

test("two batches planned before either recorded: the first lands, the second is refused by name", (t) => {
  const path = freshLedger(t);
  // Both sessions plan against the empty ledger — the race the task describes.
  const first = plannedBatchDir(t, path, "2026-09-20-telegram-1-15");
  const second = plannedBatchDir(t, path, "2026-09-20-other-1-15");

  recordBatch(
    path,
    batch({
      batch_id: "2026-09-20-telegram-1-15",
      policy_id: "p1",
      entries: [entry({ decision: "MANUAL_REVIEW" })],
    }),
    { artifactsDir: first },
  );
  const before = readFileSync(path, "utf8");

  let refused = null;
  try {
    recordBatch(
      path,
      batch({
        batch_id: "2026-09-20-other-1-15",
        observed_at: "2026-08-18T12:41:00Z",
        policy_id: "p1",
        entries: [entry({ decision: "EVALUATED", flags: [] })],
      }),
      { artifactsDir: second },
    );
  } catch (error) {
    refused = error;
  }
  assert.ok(refused instanceof TriageLedgerError);
  assert.equal(refused.code, "triage_ledger_concurrent_observation");
  // The refusal names the key so the repair — drop the entry — can be done without guessing.
  assert.match(refused.message, /linkedin:4418544694/);
  assert.equal(
    readFileSync(path, "utf8"),
    before,
    "the refused batch left the ledger byte-identical",
  );
  assert.equal(existsSync(join(second, triageBatchRecordFileName)), false, "and wrote no record");
  assert.equal(existsSync(`${path}.lock`), false, "and released the lock");
  const row = readLedger(path).entries[0];
  assert.equal(row.batch_id, "2026-09-20-telegram-1-15");
  assert.equal(row.decision, "MANUAL_REVIEW");
});

test("two sessions recording one vacancy at the same moment: exactly one lands", async (t) => {
  const root = disposableRoot(t);
  const path = join(root, "triage-ledger.json");
  initLedger(path);
  const dirs = ["concurrent-a-1-1", "concurrent-b-1-1"].map((batchId) => {
    const dir = join(root, batchId);
    mkdirSync(dir);
    seedTraces(dir, [LINKEDIN_ONE]);
    seedPlan(dir, path, [LINKEDIN_ONE]);
    return [batchId, dir];
  });
  const childPath = join(root, "record-child.mjs");
  writeFileSync(
    childPath,
    [
      `import { recordBatch } from ${JSON.stringify(corePath)};`,
      "const [ledgerPath, batchId, dir, url] = process.argv.slice(2);",
      "try {",
      "  recordBatch(ledgerPath, {",
      "    batch_id: batchId,",
      '    observed_at: "2026-08-18T12:40:00Z",',
      '    policy_id: "p1",',
      '    entries: [{ url, status: "open", decision: "MANUAL_REVIEW", flags: [] }],',
      "  }, { artifactsDir: dir });",
      '  console.log("recorded");',
      "} catch (error) {",
      '  console.log(error.code ?? "unknown");',
      "  process.exitCode = 3;",
      "}",
      "",
    ].join("\n"),
  );
  const { spawn } = await import("node:child_process");
  const outcomes = await Promise.all(
    dirs.map(
      ([batchId, dir]) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [childPath, path, batchId, dir, LINKEDIN_ONE], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
          });
          child.on("close", (status) => resolve({ status, stdout: stdout.trim() }));
        }),
    ),
  );
  assert.deepEqual(
    outcomes.map((outcome) => outcome.stdout).sort(),
    ["recorded", "triage_ledger_concurrent_observation"],
    JSON.stringify(outcomes),
  );
  const ledger = readLedger(path);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.batches.length, 1);
  const winner = ledger.batches[0].batch_id;
  assert.equal(ledger.entries[0].batch_id, winner);
  const [loser] = dirs.filter(([batchId]) => batchId !== winner);
  assert.equal(
    existsSync(join(loser[1], triageBatchRecordFileName)),
    false,
    "the loser wrote no record",
  );
  assert.equal(existsSync(`${path}.lock`), false);
});

test("a re-score that planned after the first record passes the guard and replaces the row", (t) => {
  const path = freshLedger(t);
  const first = plannedBatchDir(t, path, "2026-08-18-linkedin-1-1");
  recordBatch(path, batch({ batch_id: "2026-08-18-linkedin-1-1", policy_id: "p1" }), {
    artifactsDir: first,
  });

  // Planned now, so the plan carries the row as `skip_known` with the five fields it has today.
  const second = plannedBatchDir(t, path, "2026-08-25-linkedin-1-1");
  const plan = JSON.parse(readFileSync(join(second, "plan.json"), "utf8"));
  assert.equal(plan.items[0].action, "skip_known");
  recordBatch(
    path,
    batch({
      batch_id: "2026-08-25-linkedin-1-1",
      observed_at: "2026-08-25T09:00:00Z",
      policy_id: "p2",
      entries: [entry({ decision: "EVALUATED", flags: [] })],
    }),
    { artifactsDir: second },
  );
  const row = readLedger(path).entries[0];
  assert.equal(row.decision, "EVALUATED");
  assert.equal(row.batch_id, "2026-08-25-linkedin-1-1");

  // And the first batch's replay still goes through: a batch the ledger holds runs no guard.
  const replay = recordBatch(
    path,
    batch({ batch_id: "2026-08-18-linkedin-1-1", policy_id: "p1" }),
    { artifactsDir: first },
  );
  assert.equal(replay.record.written, false);
});

test("a known row that moved between the plan and the record is refused, whichever field moved", (t) => {
  // One case per field the guard compares, each moving that field alone — so dropping any one
  // clause from the comparison reddens exactly its case. The baseline row is a failed fetch, the
  // one known row a batch re-fetches without being asked, and every intervening write keeps the
  // observation instant unless the instant is the field under test.
  const baseline = { decision: "BLOCKED", flags: ["vacancy_unavailable"] };
  const cases = [
    ["decision", { decision: "EVALUATED", flags: ["vacancy_unavailable"] }, {}],
    ["flags", { decision: "BLOCKED", flags: ["vacancy_unavailable", "work_format_unknown"] }, {}],
    ["status", { decision: "BLOCKED", flags: ["vacancy_unavailable"], status: "closed" }, {}],
    [
      "last_checked",
      { decision: "BLOCKED", flags: ["vacancy_unavailable"] },
      { observed_at: "2026-08-18T12:40:01Z" },
    ],
    ["policy_id", { decision: "BLOCKED", flags: ["vacancy_unavailable"] }, { policy_id: "p9" }],
  ];
  for (const [field, moved, batchOverrides] of cases) {
    const path = freshLedger(t);
    recordWithoutStore(path, batch({ batch_id: "earlier", entries: [entry(baseline)] }));
    // This batch plans the retry of the failed fetch…
    const dir = plannedBatchDir(t, path, `retry-${field}-1-1`);
    assert.equal(
      JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")).items[0].action,
      "retry_blocked",
      field,
    );
    // …and another batch touches the same row first, moving only this one field.
    recordWithoutStore(
      path,
      batch({ batch_id: "meanwhile", ...batchOverrides, entries: [entry(moved)] }),
    );

    assert.equal(
      errorCode(() =>
        recordBatch(path, batch({ batch_id: `retry-${field}-1-1`, policy_id: "p1" }), {
          artifactsDir: dir,
        }),
      ),
      "triage_ledger_concurrent_observation",
      field,
    );
    assert.equal(readLedger(path).entries[0].batch_id, "meanwhile", field);
  }

  // The control: an intervening write that moved nothing the plan saw is not a move. A replay of
  // the baseline batch itself keeps every field, so the retry lands.
  const path = freshLedger(t);
  recordWithoutStore(path, batch({ batch_id: "earlier", entries: [entry(baseline)] }));
  const dir = plannedBatchDir(t, path, "retry-control-1-1");
  recordWithoutStore(path, batch({ batch_id: "earlier", entries: [entry(baseline)] }));
  recordBatch(path, batch({ batch_id: "retry-control-1-1", policy_id: "p1" }), {
    artifactsDir: dir,
  });
  assert.equal(readLedger(path).entries[0].batch_id, "retry-control-1-1");
});

test("an orphaned record is finished by its replay even after another batch wrote the row", (t) => {
  const root = disposableRoot(t);
  const doomed = join(root, `${"l".repeat(240)}.json`);
  initLedger(doomed);
  const dir = join(root, "orphan-1-1");
  mkdirSync(dir);
  seedTraces(dir, [LINKEDIN_ONE]);
  seedPlan(dir, doomed, [LINKEDIN_ONE]);
  assert.equal(
    errorCode(() =>
      recordBatch(doomed, batch({ batch_id: "orphan-1-1", policy_id: "p1" }), {
        artifactsDir: dir,
      }),
    ),
    "triage_ledger_unwritable",
  );
  assert.ok(
    existsSync(join(dir, triageBatchRecordFileName)),
    "the record is on disk, the ledger half is not",
  );

  // Another batch records the same vacancy into a ledger that works.
  const healthy = join(root, "triage-ledger.json");
  initLedger(healthy);
  const other = plannedBatchDir(t, healthy, "other-1-1");
  recordBatch(
    healthy,
    batch({
      batch_id: "other-1-1",
      policy_id: "p1",
      entries: [entry({ decision: "EVALUATED", flags: [] })],
    }),
    { artifactsDir: other },
  );

  // The orphan's replay is not judged against its plan: its observation was committed when its
  // record was written, and docs/runbooks/triage-review.md#11-batch-store-the-history-beside-the-index's cure — repeat recordBatch — must still work. The row it lands
  // on is the named residual of the crash window.
  const replay = recordBatch(healthy, batch({ batch_id: "orphan-1-1", policy_id: "p1" }), {
    artifactsDir: dir,
  });
  assert.equal(replay.record.written, false);
  assert.deepEqual(
    readLedger(healthy)
      .batches.map((row) => row.batch_id)
      .sort(),
    ["orphan-1-1", "other-1-1"],
  );
});

test("an entry the plan never named is refused on its own code", (t) => {
  const path = freshLedger(t);
  const dir = join(disposableRoot(t, "triage-batch-"), "unplanned-1-1");
  mkdirSync(dir);
  seedTraces(dir, [LINKEDIN_ONE, LINKEDIN_TWO]);
  seedPlan(dir, path, [LINKEDIN_ONE]);
  let refused = null;
  try {
    recordBatch(
      path,
      batch({
        batch_id: "unplanned-1-1",
        policy_id: "p1",
        entries: [entry({ url: LINKEDIN_ONE }), entry({ url: LINKEDIN_TWO })],
      }),
      { artifactsDir: dir },
    );
  } catch (error) {
    refused = error;
  }
  assert.equal(refused?.code, "triage_ledger_entry_unplanned");
  assert.match(refused.message, /linkedin:4449892212/);
  assert.doesNotMatch(refused.message, /4418544694/);
  assert.deepEqual(readLedger(path).entries, []);
});

test("the archive path needs the plan the batch ran on, and reads it rather than believing it", (t) => {
  const path = freshLedger(t);
  const dir = join(disposableRoot(t, "triage-batch-"), "planless-1-1");
  mkdirSync(dir);
  seedTraces(dir, [LINKEDIN_ONE]);
  const attempt = () =>
    recordBatch(path, batch({ batch_id: "planless-1-1", policy_id: "p1" }), { artifactsDir: dir });

  assert.equal(errorCode(attempt), "triage_ledger_plan_undeclared");
  writeFileSync(join(dir, "plan.json"), "{ not json", "utf8");
  assert.equal(errorCode(attempt), "triage_ledger_plan_invalid");
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ as_of: "2026-08-18T12:00:00Z" }), "utf8");
  assert.equal(errorCode(attempt), "triage_ledger_plan_invalid");
  // A plan item whose declared key lies about its link is read by the link, never by the key.
  const lying = planBatch(readLedger(path), [LINKEDIN_ONE], { asOf: "2026-08-18T12:00:00Z" });
  lying.items[0].key = "linkedin:0000000000";
  writeFileSync(join(dir, "plan.json"), JSON.stringify(lying), "utf8");
  attempt();
  assert.equal(readLedger(path).entries[0].key, "linkedin:4418544694");
  assert.equal(existsSync(join(dir, triageBatchRecordFileName)), true);
  assert.equal(triageBatchPlanFileName, "plan.json");
});

// ------------------------------------------------ immutable cards and the version 2 lifecycle

test("version 1 is readable without migration and its explicit upgrade preserves observations and historical digests", (t) => {
  const path = freshLedger(t);
  recordWithoutStore(path, batch());
  const original = structuredClone(readLedger(path));
  const fixture = fictionalSourceSet();
  assert.equal(original.schema_version, 1);
  assert.equal(
    errorCode(() =>
      ledgerSourceApi.planSourceBatch(path, fixture.sourceSet, { asOf: sourceInstant }),
    ),
    "triage_ledger_upgrade_required",
  );
  assert.equal(readLedger(path).schema_version, 1);
  assert.equal(ledgerSourceApi.upgradeLedger(path).upgraded, true);
  const upgraded = readLedger(path);
  assert.equal(upgraded.schema_version, 2);
  assert.deepEqual(upgraded.entries, original.entries);
  assert.deepEqual(upgraded.batches, original.batches);
  const bytes = readFileSync(path, "utf8");
  assert.equal(ledgerSourceApi.upgradeLedger(path).upgraded, false);
  assert.equal(readFileSync(path, "utf8"), bytes);
  assert.equal(runCli(["upgrade"], { ledgerPath: path }).status, 0);
});

test("version 2 archives the bound logical decision and every scoped source before indexing it", (t) => {
  const context = sourceLedger(t);
  const fixture = fictionalSourceSet();
  const staged = sourceBatchDir(context, fixture, "source-first");
  const result = recordSource(context.path, staged);
  const record = readBatchRecord(staged.dir);
  const ledger = readLedger(context.path);
  assert.equal(record.schema_version, 2);
  assert.equal(record.entries_digest, ledger.batches[0].entries_digest);
  assert.equal(
    record.source_set_sha256,
    sourceSetDigest(readFileSync(join(staged.dir, "source-set.json"))),
  );
  assert.equal(
    readFileSync(join(staged.dir, "source-set.json"), "utf8"),
    serializeSourceSet(fixture.sourceSet),
  );
  assert.equal(record.logical_entries[0].decision, "SKIP");
  assert.equal(record.logical_entries[0].primary_ref, staged.resolution.groups[0].primary);
  assert.equal(ledger.entries.length, 0, "context dispositions never fabricate URL liveness");
  assert.equal(ledger.logical_entries.length, 1);
  assert.equal(ledger.source_records.length, 2);
  assert.equal(result.record.written, true);
  const plan = ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, {
    asOf: sourceInstant,
    collectionText: fixture.collectionText,
    resolution: staged.resolution,
  });
  assert.equal(plan.items[0].action, "skip_known");
  assert.equal(plan.items[0].sources[0].action, "company_context");
  const unconfirmed = ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, {
    asOf: sourceInstant,
  });
  assert.equal(unconfirmed.items[0].action, "source_review");
  const bytes = readFileSync(context.path, "utf8");
  assert.equal(recordSource(context.path, staged).replayed, true);
  assert.equal(
    readFileSync(context.path, "utf8"),
    bytes,
    "an indexed replay never moves last_checked",
  );
  assert.equal(
    errorCode(() =>
      recordSource(context.path, {
        ...staged,
        payload: { ...staged.payload, observed_at: "2026-10-09T09:00:00Z" },
      }),
    ),
    "triage_ledger_batch_id_reused",
  );
  const changed = structuredClone(record);
  changed.source_records[0].role = "unknown";
  assert.equal(
    errorCode(() => validateBatchRecord(changed)),
    "triage_ledger_record_unreadable",
  );
  const falseClosure = sourceBatchDir(context, fixture, "forged-source-closure");
  falseClosure.payload.entries = [
    {
      url: fixture.sourceSet.snapshots[0].original_url,
      status: "closed",
      decision: "SKIP",
      flags: [],
    },
  ];
  assert.equal(
    errorCode(() => recordSource(context.path, falseClosure)),
    "triage_ledger_entry_without_trace",
  );
  assert.equal(
    existsSync(join(falseClosure.dir, "ledger-record.json")),
    false,
    "a trace of an active manual role cannot falsely close its URL",
  );
});

test("reader permutations and adding a missed role preserve unchanged card identity without merging shared context", (t) => {
  const context = sourceLedger(t);
  const fixture = multiRoleFixture();
  const reversed = createSourceSet({
    collectionText: fixture.collectionText,
    snapshots: [fixture.snapshot],
    cards: [...fixture.cards].reverse(),
  });
  assert.deepEqual(reversed, fixture.sourceSet);
  const initial = {
    ...fixture,
    sourceSet: createSourceSet({
      collectionText: fixture.collectionText,
      snapshots: [fixture.snapshot],
      cards: [fixture.cards[0]],
    }),
  };
  recordSource(context.path, sourceBatchDir(context, initial, "initial-senior"));
  const observations = fixture.sourceSet.cards.map((card, at) =>
    sourceObservation(fixture, card, { inputIndex: at + 1 }),
  );
  const resolution = resolveSourceSet({
    sourceSet: reversed,
    collectionText: fixture.collectionText,
    observations,
  });
  const plan = ledgerSourceApi.planSourceBatch(context.path, reversed, {
    asOf: sourceInstant,
    collectionText: fixture.collectionText,
    resolution,
  });
  assert.equal(plan.items.length, 2);
  assert.deepEqual(
    plan.items.map((item) => item.action),
    ["skip_known", "fetch_new"],
  );
  assert.notEqual(plan.items[0].logical_key, plan.items[1].logical_key);
  assert.equal(
    plan.items.every(
      (item) =>
        item.sources.find((source) => source.role === "company_context").action ===
        "company_context",
    ),
    true,
  );
  assert.equal(fixture.sourceSet.cards[0].card_ref, initial.sourceSet.cards[0].card_ref);
  assert.equal(plan.items[0].baseline.card_refs[0], initial.sourceSet.cards[0].card_ref);
});

test("edited posts, remapped own boundaries and spoofed references cannot inherit another role's closed baseline", (t) => {
  const context = sourceLedger(t);
  const fixture = multiRoleFixture();
  const observations = fixture.sourceSet.cards.map((card, at) =>
    sourceObservation(fixture, card, { inputIndex: at + 1 }),
  );
  const staged = sourceBatchDir(context, fixture, "two-roles", { observations });
  recordSource(context.path, staged);
  ledgerSourceApi.withLedgerLock(context.path, (ledger) => ({
    ledger: {
      ...ledger,
      logical_entries: ledger.logical_entries.map((item) => ({ ...item, status: "closed" })),
    },
  }));
  const unchanged = ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, {
    asOf: sourceInstant,
    collectionText: fixture.collectionText,
    resolution: staged.resolution,
  });
  assert.equal(
    unchanged.items.every((item) => item.action === "skip_closed"),
    true,
  );
  const remapped = createSourceSet({
    collectionText: fixture.collectionText,
    snapshots: [fixture.snapshot],
    cards: [{ ...fixture.cards[0], end_line: 2 }, fixture.cards[1]],
  });
  const remappedPlan = ledgerSourceApi.planSourceBatch(context.path, remapped, {
    asOf: sourceInstant,
  });
  assert.equal(remappedPlan.items[0].action, "fetch_new");
  assert.equal(remappedPlan.items[0].baseline, null);
  const edited = fictionalSourceSet({ title: "Junior QA Engineer" });
  assert.equal(
    ledgerSourceApi.planSourceBatch(context.path, edited.sourceSet, { asOf: sourceInstant })
      .items[0].action,
    "fetch_new",
  );
  const forged = structuredClone(remapped);
  forged.cards[0].card_ref = fixture.sourceSet.cards[0].card_ref;
  assert.equal(
    errorCode(() =>
      ledgerSourceApi.planSourceBatch(join(context.root, "missing.json"), forged, {
        asOf: sourceInstant,
      }),
    ),
    "triage_ledger_source_identity",
    "identity is checked before any ledger lookup",
  );
});

test("same-row concurrent source batches refuse the loser before archive while unrelated logical batches both land", (t) => {
  const context = sourceLedger(t);
  const first = sourceBatchDir(context, fictionalSourceSet(), "first-writer");
  const loser = sourceBatchDir(context, fictionalSourceSet(), "second-writer");
  const unrelated = sourceBatchDir(
    context,
    fictionalSourceSet({ postId: 8, company: "Bravo", homepage: "https://bravo.example/" }),
    "unrelated-writer",
  );
  recordSource(context.path, first);
  assert.equal(
    errorCode(() => recordSource(context.path, loser)),
    "triage_ledger_concurrent_observation",
  );
  assert.equal(existsSync(join(loser.dir, "ledger-record.json")), false);
  recordSource(context.path, unrelated);
  assert.equal(readLedger(context.path).logical_entries.length, 2);
  assert.equal(readLedger(context.path).batches.length, 2);
});

test("three historical homepage BLOCKED observations get a separate evidence-bound correction with no false closure or new fetch", (t) => {
  const context = sourceLedger(t);
  for (const [at, company] of ["Acme", "Bravo", "Coda"].entries()) {
    const fixture = fictionalSourceSet({
      company,
      homepage: `https://${company.toLowerCase()}.example/`,
      postId: at + 1,
    });
    const parentId = `legacy-homepage-${at}`;
    const dir = join(context.store, parentId);
    mkdirSync(dir);
    seedTraces(dir, [fixture.homepage]);
    seedPlan(dir, context.path, [fixture.homepage]);
    recordBatch(
      context.path,
      batch({
        batch_id: parentId,
        policy_id: "legacy-policy",
        entries: [
          entry({ url: fixture.homepage, decision: "BLOCKED", flags: ["vacancy_unavailable"] }),
        ],
      }),
      { artifactsDir: dir },
    );
    const parent = readBatchRecord(dir);
    const parentBytes = readFileSync(join(dir, "ledger-record.json"), "utf8");
    const old = structuredClone(
      readLedger(context.path).entries.find(
        (item) => item.key === vacancyIdentity(fixture.homepage).key,
      ),
    );
    const corrections = [
      {
        parent_batch_id: parentId,
        parent_entries_digest: parent.entries_digest,
        card_ref: fixture.sourceSet.cards[0].card_ref,
        url: fixture.homepage,
      },
    ];
    const staged = sourceBatchDir(context, fixture, `correction-${at}`, { corrections });
    const result = ledgerSourceApi.correctSourceObservations(context.path, staged.payload, {
      artifactsDir: staged.dir,
    });
    assert.equal(result.corrections, 1);
    assert.deepEqual(
      readLedger(context.path).entries.find((item) => item.key === old.key),
      old,
    );
    assert.equal(
      readLedger(context.path).logical_entries.length,
      0,
      "bookkeeping cannot pretend to observe a JD again",
    );
    assert.equal(readFileSync(join(dir, "ledger-record.json"), "utf8"), parentBytes);
    assert.equal(readBatchRecord(staged.dir).parents[0].record_sha256, digest(parentBytes));
    assert.equal(readBatchRecord(staged.dir).corrections[0].parent_last_checked, old.last_checked);
    const plan = ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, {
      asOf: sourceInstant,
    });
    assert.equal(plan.items[0].sources[0].action, "company_context");
    assert.equal(
      planBatch(readLedger(context.path), [fixture.homepage], { asOf: sourceInstant }).items[0]
        .action,
      "retry_blocked",
    );
    const bytes = readFileSync(context.path, "utf8");
    assert.equal(
      ledgerSourceApi.correctSourceObservations(context.path, staged.payload, {
        artifactsDir: staged.dir,
      }).replayed,
      true,
    );
    assert.equal(readFileSync(context.path, "utf8"), bytes);
    const forged = sourceBatchDir(context, fixture, `wrong-parent-${at}`, {
      corrections: [{ ...corrections[0], parent_entries_digest: "0".repeat(64) }],
    });
    assert.equal(
      errorCode(() =>
        ledgerSourceApi.correctSourceObservations(context.path, forged.payload, {
          artifactsDir: forged.dir,
        }),
      ),
      "triage_ledger_source_parent_invalid",
    );
  }
  const report = reviewLedger(readLedger(context.path), { asOf: sourceInstant });
  assert.equal(report.totals.entries, 0);
  assert.equal(report.totals.closed, 0);
  assert.equal(report.totals.url_observations, 3);
  assert.equal(report.totals.excluded_url_observations, 3);
  assert.equal(report.totals.corrections, 3);
  const url = "https://acme.example/";
  recordWithoutStore(
    context.path,
    batch({
      batch_id: "later-standalone",
      observed_at: "2026-10-09T09:00:00Z",
      entries: [entry({ url, decision: "BLOCKED", flags: ["vacancy_unavailable"] })],
    }),
  );
  assert.equal(
    reviewLedger(readLedger(context.path), { asOf: sourceInstant }).totals.entries,
    1,
    "a correction never excludes a later standalone observation globally",
  );
});

test("a self-valid changed correction parent cannot suppress the indexed BLOCKED observation", (t) => {
  const context = sourceLedger(t);
  const fixture = fictionalSourceSet();
  const parentId = "correction-indexed-parent";
  const parentDir = join(context.store, parentId);
  mkdirSync(parentDir);
  seedTraces(parentDir, [fixture.homepage]);
  seedPlan(parentDir, context.path, [fixture.homepage]);
  recordBatch(
    context.path,
    batch({
      batch_id: parentId,
      policy_id: "legacy-policy",
      entries: [
        entry({ url: fixture.homepage, decision: "BLOCKED", flags: ["vacancy_unavailable"] }),
      ],
    }),
    { artifactsDir: parentDir },
  );
  const parentPath = join(parentDir, "ledger-record.json");
  const parentBytes = readFileSync(parentPath);
  const original = readBatchRecord(parentDir);
  const changed = structuredClone(original);
  changed.entries[0].title = "Different parent metadata";
  changed.entries_digest = digest(JSON.stringify(changed.entries));
  writeFileSync(parentPath, JSON.stringify(changed));
  assert.equal(validateBatchRecord(changed), changed, "the changed record validates itself");
  assert.notEqual(changed.entries_digest, readLedger(context.path).batches[0].entries_digest);
  const staged = sourceBatchDir(context, fixture, "correction-changed-parent", {
    corrections: [
      {
        parent_batch_id: parentId,
        parent_entries_digest: changed.entries_digest,
        card_ref: fixture.sourceSet.cards[0].card_ref,
        url: fixture.homepage,
      },
    ],
  });
  sourceFullEvidence(staged, sourceInstant);
  for (const cadence of ["per-batch", "full"]) {
    const report = verifySourceBatch(context, staged, fixture, cadence);
    assert.equal(report.status, "pass", `${cadence}: ${report.findingCodes.join(",")}`);
  }
  const ledgerBytes = readFileSync(context.path);
  assert.equal(reviewLedger(readLedger(context.path), { asOf: sourceInstant }).totals.entries, 1);
  assert.equal(
    errorCode(() =>
      ledgerSourceApi.correctSourceObservations(context.path, staged.payload, {
        artifactsDir: staged.dir,
      }),
    ),
    "triage_ledger_source_parent_invalid",
  );
  assert.deepEqual(readFileSync(context.path), ledgerBytes);
  assert.equal(existsSync(join(staged.dir, "ledger-record.json")), false);
  assert.equal(reviewLedger(readLedger(context.path), { asOf: sourceInstant }).totals.entries, 1);
  assert.equal(existsSync(`${context.path}.lock`), false);

  writeFileSync(parentPath, parentBytes);
  staged.payload.corrections[0].parent_entries_digest = original.entries_digest;
  assert.equal(
    ledgerSourceApi.correctSourceObservations(context.path, staged.payload, {
      artifactsDir: staged.dir,
    }).corrections,
    1,
  );
  assert.equal(reviewLedger(readLedger(context.path), { asOf: sourceInstant }).totals.entries, 0);
  const indexedParent = readLedger(context.path).batches.find((item) => item.batch_id === parentId);
  ledgerSourceApi.withLedgerLock(context.path, (ledger) => ({
    ledger: { ...ledger, batches: ledger.batches.filter((item) => item.batch_id !== parentId) },
  }));
  const unindexedBytes = readFileSync(context.path);
  assert.equal(
    errorCode(() =>
      ledgerSourceApi.correctSourceObservations(context.path, staged.payload, {
        artifactsDir: staged.dir,
      }),
    ),
    "triage_ledger_source_parent_invalid",
    "an indexed replay still needs the immutable parent index",
  );
  assert.deepEqual(readFileSync(context.path), unindexedBytes);
  ledgerSourceApi.withLedgerLock(context.path, (ledger) => ({
    ledger: { ...ledger, batches: [...ledger.batches, indexedParent] },
  }));
  assert.equal(
    ledgerSourceApi.correctSourceObservations(context.path, staged.payload, {
      artifactsDir: staged.dir,
    }).replayed,
    true,
  );
});

test("a self-valid changed alias parent cannot add a card to the indexed logical vacancy", (t) => {
  const context = sourceLedger(t);
  const details = "https://jobs.acme.example/vacancy/731";
  const original = fictionalSourceSet({ details });
  const first = sourceBatchDir(context, original, "alias-indexed-parent", {
    ...linkedSourceObservations(original),
    prefetchPlan: true,
  });
  recordSource(context.path, first);
  const parentPath = join(first.dir, "ledger-record.json");
  const parentBytes = readFileSync(parentPath);
  const parent = readBatchRecord(first.dir);
  const changed = structuredClone(parent);
  changed.logical_entries[0].title = "Different retained parent metadata";
  const { entries_digest: ignored, ...changedPayload } = changed;
  changed.entries_digest = digest(JSON.stringify(changedPayload));
  writeFileSync(parentPath, JSON.stringify(changed));
  assert.equal(validateBatchRecord(changed), changed, "the changed record validates itself");
  assert.notEqual(changed.entries_digest, readLedger(context.path).batches[0].entries_digest);
  const edited = fictionalSourceSet({ details, extra: " An independently captured revision." });
  const second = sourceBatchDir(context, edited, "alias-changed-parent", {
    ...linkedSourceObservations(edited),
    observedAt: "2026-10-09T09:00:00Z",
    prefetchPlan: true,
  });
  second.payload.aliases = [
    {
      card_ref: edited.sourceSet.cards[0].card_ref,
      logical_key: parent.logical_entries[0].key,
      parent_batch_id: first.payload.batch_id,
      parent_entries_digest: changed.entries_digest,
      observation_ref: second.resolution.observations.find((item) => item.source_ref === details)
        .observation_ref,
      parent_observation_ref: first.resolution.observations.find(
        (item) => item.source_ref === details,
      ).observation_ref,
    },
  ];
  sourceFullEvidence(second, second.payload.observed_at);
  for (const cadence of ["per-batch", "full"]) {
    const report = verifySourceBatch(context, second, edited, cadence);
    assert.equal(report.status, "pass", `${cadence}: ${report.findingCodes.join(",")}`);
  }
  const ledgerBytes = readFileSync(context.path);
  assert.equal(
    errorCode(() => recordSource(context.path, second)),
    "triage_ledger_source_parent_invalid",
  );
  assert.deepEqual(readFileSync(context.path), ledgerBytes);
  assert.equal(existsSync(join(second.dir, "ledger-record.json")), false);
  assert.deepEqual(
    readLedger(context.path).logical_entries[0].card_refs,
    parent.logical_entries[0].card_refs,
  );
  assert.equal(existsSync(`${context.path}.lock`), false);

  writeFileSync(parentPath, parentBytes);
  second.payload.aliases[0].parent_entries_digest = parent.entries_digest;
  recordSource(context.path, second);
  assert.deepEqual(
    readLedger(context.path).logical_entries[0].card_refs,
    [original.sourceSet.cards[0].card_ref, edited.sourceSet.cards[0].card_ref].sort(),
  );
  assert.equal(readBatchRecord(second.dir).parents[0].record_sha256, digest(parentBytes));
  const indexedParent = readLedger(context.path).batches.find(
    (item) => item.batch_id === first.payload.batch_id,
  );
  for (const [field, value] of [
    ["entry_count", indexedParent.entry_count + 1],
    ["recorded_at", "2026-10-08T09:01:00Z"],
    ["policy_id", "different-indexed-policy"],
    ["source_set_sha256", "0".repeat(64)],
    ["source_resolution_sha256", "0".repeat(64)],
    ["plan_sha256", "0".repeat(64)],
  ]) {
    ledgerSourceApi.withLedgerLock(context.path, (ledger) => ({
      ledger: {
        ...ledger,
        batches: ledger.batches.map((item) =>
          item.batch_id === indexedParent.batch_id ? { ...indexedParent, [field]: value } : item,
        ),
      },
    }));
    const movedIndex = readFileSync(context.path);
    assert.equal(
      errorCode(() => recordSource(context.path, second)),
      "triage_ledger_source_parent_invalid",
      `indexed replay cannot waive parent ${field}`,
    );
    assert.deepEqual(readFileSync(context.path), movedIndex);
  }
  ledgerSourceApi.withLedgerLock(context.path, (ledger) => ({
    ledger: {
      ...ledger,
      batches: ledger.batches.map((item) =>
        item.batch_id === indexedParent.batch_id ? indexedParent : item,
      ),
    },
  }));
  assert.equal(recordSource(context.path, second).replayed, true);
});

test("a correction parent record symlink is refused before archive or review mutation", (t) => {
  const context = sourceLedger(t);
  const fixture = fictionalSourceSet();
  const parentId = "correction-symlink-parent";
  const parentDir = join(context.store, parentId);
  mkdirSync(parentDir);
  seedTraces(parentDir, [fixture.homepage]);
  seedPlan(parentDir, context.path, [fixture.homepage]);
  recordBatch(
    context.path,
    batch({
      batch_id: parentId,
      policy_id: "legacy-policy",
      entries: [
        entry({ url: fixture.homepage, decision: "BLOCKED", flags: ["vacancy_unavailable"] }),
      ],
    }),
    { artifactsDir: parentDir },
  );
  const parent = readBatchRecord(parentDir);
  const staged = sourceBatchDir(context, fixture, "correction-record-symlink", {
    corrections: [
      {
        parent_batch_id: parentId,
        parent_entries_digest: parent.entries_digest,
        card_ref: fixture.sourceSet.cards[0].card_ref,
        url: fixture.homepage,
      },
    ],
  });
  const parentPath = join(parentDir, "ledger-record.json");
  const detached = join(context.root, "detached-parent-record.json");
  renameSync(parentPath, detached);
  symlinkSync(detached, parentPath);
  const bytes = readFileSync(context.path);
  assert.equal(
    errorCode(() =>
      ledgerSourceApi.correctSourceObservations(context.path, staged.payload, {
        artifactsDir: staged.dir,
      }),
    ),
    "triage_ledger_source_parent_invalid",
  );
  assert.deepEqual(readFileSync(context.path), bytes);
  assert.equal(existsSync(join(staged.dir, "ledger-record.json")), false);
  assert.equal(reviewLedger(readLedger(context.path), { asOf: sourceInstant }).totals.entries, 1);
  rmSync(parentPath);
  renameSync(detached, parentPath);
  assert.equal(
    ledgerSourceApi.correctSourceObservations(context.path, staged.payload, {
      artifactsDir: staged.dir,
    }).corrections,
    1,
  );
});

test("a source archive must remain in real directories before write and indexed-prior planning", (t) => {
  for (const variant of ["batch-symlink", "store-symlink", "wrong-batch-name"]) {
    const context = sourceLedger(t);
    const fixture = fictionalSourceSet();
    const staged = sourceBatchDir(context, fixture, `bounded-archive-${variant}`, {
      prefetchPlan: true,
    });
    sourceFullEvidence(staged, sourceInstant);
    const declared = staged.dir;
    let detached;
    let archivePath;
    if (variant === "store-symlink") {
      detached = join(context.root, "store-alias");
      symlinkSync(context.store, detached);
      archivePath = join(detached, staged.payload.batch_id);
    } else {
      detached = join(context.root, "detached-batch");
      renameSync(declared, detached);
      if (variant === "batch-symlink") {
        symlinkSync(detached, declared);
        archivePath = declared;
      } else archivePath = detached;
    }
    const misplaced = { ...staged, dir: archivePath };
    for (const cadence of ["per-batch", "full"]) {
      const report = verifySourceBatch(context, misplaced, fixture, cadence);
      assert.equal(
        report.status,
        "pass",
        `${variant}, ${cadence}: ${report.findingCodes.join(",")}`,
      );
    }
    const ledgerBytes = readFileSync(context.path);
    assert.equal(
      errorCode(() => recordSource(context.path, misplaced)),
      "triage_ledger_record_dir_invalid",
      variant,
    );
    assert.deepEqual(readFileSync(context.path), ledgerBytes);
    assert.equal(
      existsSync(join(archivePath, "ledger-record.json")),
      false,
      "no escaped immutable write",
    );
    assert.equal(existsSync(`${context.path}.lock`), false);
    if (variant === "store-symlink") rmSync(detached);
    else {
      if (variant === "batch-symlink") rmSync(declared);
      renameSync(detached, declared);
    }
    assert.equal(recordSource(context.path, staged).record.written, true);
    const plan = ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, {
      asOf: "2026-10-09T09:00:00Z",
      resolution: staged.resolution,
      collectionText: fixture.collectionText,
      captureRoot: staged.dir,
    });
    assert.equal(plan.prior_resolution.batch_id, staged.payload.batch_id);
    assert.equal(plan.prior_resolution.entries_digest, readBatchRecord(staged.dir).entries_digest);
    assert.equal(recordSource(context.path, staged).replayed, true);
  }
});

test("a version 2 orphan survives index failure and replays without replacing a newer observation", (t) => {
  const context = sourceLedger(t);
  const fixture = fictionalSourceSet();
  const template = {
    key: "",
    card_refs: [fixture.sourceSet.cards[0].card_ref],
    identity_status: "confirmed",
    primary_ref: null,
    first_seen: sourceInstant,
    last_checked: sourceInstant,
    status: "open",
    batch_id: "synthetic",
    decision: "SKIP",
    flags: [],
    policy_id: sourcePolicy,
  };
  ledgerSourceApi.withLedgerLock(context.path, (ledger) => ({
    ledger: {
      ...ledger,
      logical_entries: Array.from({ length: 4096 }, (_, at) => ({
        ...template,
        key: ledgerSourceApi.logicalVacancyKey(`synthetic-${at}`),
        card_refs: [`tg-card:sha256:${digest(`synthetic-card-${at}`)}`],
      })),
    },
  }));
  const orphan = sourceBatchDir(context, fixture, "orphan-before-newer");
  assert.equal(
    errorCode(() => recordSource(context.path, orphan)),
    "triage_ledger_invalid",
  );
  assert.equal(
    existsSync(join(orphan.dir, "ledger-record.json")),
    true,
    "archive precedes the failing index write",
  );
  assert.equal(readLedger(context.path).batches.length, 0);
  ledgerSourceApi.withLedgerLock(context.path, (ledger) => ({
    ledger: { ...ledger, logical_entries: ledger.logical_entries.slice(2) },
  }));
  const newer = sourceBatchDir(context, fixture, "newer-observation", {
    observedAt: "2026-10-09T09:00:00Z",
  });
  recordSource(context.path, newer);
  recordSource(context.path, orphan);
  const logical = readLedger(context.path).logical_entries.find(
    (item) => item.key === ledgerSourceApi.logicalVacancyKey(fixture.sourceSet.cards[0].card_ref),
  );
  assert.equal(logical.last_checked, "2026-10-09T09:00:00Z");
  assert.equal(logical.batch_id, "newer-observation");
  assert.equal(readLedger(context.path).batches.length, 2);
});

test("an explicit confirmed revision alias adds immutable membership without re-keying the parent observation", (t) => {
  const context = sourceLedger(t);
  const details = "https://jobs.acme.example/vacancy/71";
  const original = fictionalSourceSet({ details });
  const firstObservation = detailsObservation(original);
  firstObservation.raw.input.inputIndex = 2;
  const first = sourceBatchDir(context, original, "before-edit", {
    observations: [sourceObservation(original), firstObservation.raw],
    captures: firstObservation.captures,
  });
  recordSource(context.path, first);
  const oldRecord = readBatchRecord(first.dir);
  const oldBytes = readFileSync(join(first.dir, "ledger-record.json"), "utf8");
  const edited = fictionalSourceSet({ details, extra: " Updated publication." });
  const secondObservation = detailsObservation(edited);
  secondObservation.raw.input.inputIndex = 2;
  const second = sourceBatchDir(context, edited, "confirmed-edit", {
    observations: [sourceObservation(edited), secondObservation.raw],
    captures: secondObservation.captures,
    observedAt: "2026-10-09T09:00:00Z",
    prefetchPlan: true,
  });
  second.payload.aliases = [
    {
      card_ref: edited.sourceSet.cards[0].card_ref,
      logical_key: oldRecord.logical_entries[0].key,
      parent_batch_id: "before-edit",
      parent_entries_digest: oldRecord.entries_digest,
      observation_ref: second.resolution.observations.find(
        (observation) => observation.source_ref === details,
      ).observation_ref,
      parent_observation_ref: first.resolution.observations.find(
        (observation) => observation.source_ref === details,
      ).observation_ref,
    },
  ];
  recordSource(context.path, second);
  const ledger = readLedger(context.path);
  assert.equal(ledger.logical_entries.length, 1);
  assert.equal(ledger.logical_entries[0].key, oldRecord.logical_entries[0].key);
  assert.deepEqual(
    ledger.logical_entries[0].card_refs,
    [original.sourceSet.cards[0].card_ref, edited.sourceSet.cards[0].card_ref].sort(),
  );
  assert.equal(ledger.logical_entries[0].first_seen, sourceInstant);
  assert.equal(ledger.aliases.length, 1);
  assert.equal(readFileSync(join(first.dir, "ledger-record.json"), "utf8"), oldBytes);
  const plan = ledgerSourceApi.planSourceBatch(context.path, edited.sourceSet, {
    asOf: sourceInstant,
    collectionText: edited.collectionText,
    resolution: second.resolution,
  });
  assert.equal(plan.items[0].logical_key, oldRecord.logical_entries[0].key);
  assert.equal(plan.items[0].action, "skip_known");
  const unsupported = sourceBatchDir(
    context,
    fictionalSourceSet({ extra: " Contact only revision." }),
    "unsupported-alias",
    { observedAt: "2026-10-10T09:00:00Z" },
  );
  unsupported.payload.aliases = [
    {
      ...second.payload.aliases[0],
      card_ref: unsupported.resolution.groups[0].card_refs[0],
      observation_ref: unsupported.resolution.observations[0].observation_ref,
    },
  ];
  assert.equal(
    errorCode(() => recordSource(context.path, unsupported)),
    "triage_ledger_source_alias_invalid",
    "an original post or homepage alone cannot prove a prior posting alias",
  );
  assert.equal(existsSync(join(unsupported.dir, "ledger-record.json")), false);
});

test("adding a smaller confirmed card cannot create a second logical row for an already indexed immutable card", (t) => {
  const context = sourceLedger(t);
  const details = "https://jobs.acme.example/vacancy/101";
  let first = fictionalSourceSet({ postId: 101, details });
  let second = fictionalSourceSet({ postId: 102, details });
  if (first.sourceSet.cards[0].card_ref < second.sourceSet.cards[0].card_ref)
    [first, second] = [second, first];
  const original = sourceBatchDir(context, first, "single-confirmed-card", {
    ...linkedSourceObservations(first),
    prefetchPlan: true,
  });
  recordSource(context.path, original);
  const combined = combinedSourceFixture(first, second);
  const merged = sourceBatchDir(context, combined, "added-smaller-card", {
    ...linkedSourceObservations(combined),
    observedAt: "2026-10-09T09:00:00Z",
    prefetchPlan: true,
  });
  assert.equal(merged.resolution.groups.length, 1);
  assert.equal(merged.resolution.groups[0].identity_status, "confirmed");
  assert.equal(
    merged.resolution.groups[0].logical_key,
    ledgerSourceApi.logicalVacancyKey(second.sourceSet.cards[0].card_ref),
  );
  const ledgerBytes = readFileSync(context.path, "utf8");
  assert.equal(
    errorCode(() => recordSource(context.path, merged)),
    "triage_ledger_source_identity",
  );
  assert.equal(
    existsSync(join(merged.dir, "ledger-record.json")),
    false,
    "overlapping card re-keying is refused before archive",
  );
  assert.equal(readFileSync(context.path, "utf8"), ledgerBytes);
  assert.equal(
    reviewLedger(readLedger(context.path), { asOf: "2026-10-09T09:00:00Z" }).totals
      .logical_vacancies,
    1,
  );
  const parent = readBatchRecord(original.dir);
  const linked = sourceBatchDir(context, combined, "added-smaller-card-with-alias", {
    ...linkedSourceObservations(combined),
    observedAt: "2026-10-09T09:00:00Z",
    prefetchPlan: true,
  });
  linked.payload.aliases = [
    {
      card_ref: second.sourceSet.cards[0].card_ref,
      logical_key: parent.logical_entries[0].key,
      parent_batch_id: original.payload.batch_id,
      parent_entries_digest: parent.entries_digest,
      observation_ref: linked.resolution.observations.find(
        (observation) =>
          observation.card_ref === second.sourceSet.cards[0].card_ref &&
          observation.source_ref === details,
      ).observation_ref,
      parent_observation_ref: original.resolution.observations.find(
        (observation) => observation.source_ref === details,
      ).observation_ref,
    },
  ];
  recordSource(context.path, linked);
  const ledger = readLedger(context.path);
  assert.equal(ledger.logical_entries.length, 1);
  assert.equal(ledger.logical_entries[0].key, parent.logical_entries[0].key);
  assert.ok(
    ledger.source_records
      .filter((source) => source.batch_id === linked.payload.batch_id)
      .every((source) => source.logical_key === parent.logical_entries[0].key),
    "all confirmed merged memberships retain the established group key",
  );
  assert.equal(reviewLedger(ledger, { asOf: "2026-10-09T09:00:00Z" }).totals.logical_vacancies, 1);
});

test("an indexed batch replays its frozen identity after a later confirmed alias changes the current card key", (t) => {
  const context = sourceLedger(t);
  const details = "https://jobs.acme.example/vacancy/211";
  const first = fictionalSourceSet({ details });
  const original = sourceBatchDir(context, first, "replay-alias-parent", {
    ...linkedSourceObservations(first),
    prefetchPlan: true,
  });
  recordSource(context.path, original);
  const differentRef = "https://jobs.acme.example/vacancy/212";
  const edited = fictionalSourceSet({
    details,
    apply: differentRef,
    extra: " Updated publication.",
  });
  const separate = sourceBatchDir(context, edited, "replay-before-alias", {
    ...linkedSourceObservations(edited),
    observedAt: "2026-10-09T09:00:00Z",
    prefetchPlan: true,
  });
  recordSource(context.path, separate);
  const frozenBytes = readFileSync(join(separate.dir, "ledger-record.json"), "utf8");
  const parent = readBatchRecord(original.dir);
  const linked = sourceBatchDir(context, edited, "replay-later-alias", {
    ...linkedSourceObservations(edited),
    observedAt: "2026-10-10T09:00:00Z",
    prefetchPlan: true,
    planResolution: separate.resolution,
  });
  linked.payload.aliases = [
    {
      card_ref: edited.sourceSet.cards[0].card_ref,
      logical_key: parent.logical_entries[0].key,
      parent_batch_id: original.payload.batch_id,
      parent_entries_digest: parent.entries_digest,
      observation_ref: linked.resolution.observations.find(
        (observation) => observation.source_ref === details,
      ).observation_ref,
      parent_observation_ref: original.resolution.observations.find(
        (observation) => observation.source_ref === details,
      ).observation_ref,
    },
  ];
  recordSource(context.path, linked);
  const ledgerBytes = readFileSync(context.path, "utf8");
  assert.equal(recordSource(context.path, separate).replayed, true);
  assert.equal(readFileSync(join(separate.dir, "ledger-record.json"), "utf8"), frozenBytes);
  assert.equal(readFileSync(context.path, "utf8"), ledgerBytes);
  assert.equal(
    readBatchRecord(separate.dir).entries_digest,
    readLedger(context.path).batches.find((batch) => batch.batch_id === separate.payload.batch_id)
      .entries_digest,
  );
  const changed = {
    ...separate,
    payload: {
      ...separate.payload,
      aliases: [
        {
          ...linked.payload.aliases[0],
          observation_ref: separate.resolution.observations.find(
            (observation) => observation.source_ref === details,
          ).observation_ref,
        },
      ],
    },
  };
  assert.equal(
    errorCode(() => recordSource(context.path, changed)),
    "triage_ledger_batch_id_reused",
    "an indexed replay still refuses a changed actual payload after aliases evolve",
  );
  assert.equal(readFileSync(context.path, "utf8"), ledgerBytes);
  const withDifferent = readLedger(context.path);
  assert.equal(
    withDifferent.logical_entries.filter((entry) => entry.identity_status === "different").length,
    1,
  );
  const differentRow = withDifferent.logical_entries.find(
    (entry) => entry.identity_status === "different",
  );
  assert.equal(differentRow.title, "Junior QA Engineer");
  assert.ok(
    withDifferent.source_records.some(
      (source) => source.logical_key === differentRow.key && source.url === differentRef,
    ),
  );
  assert.equal(
    reviewLedger(withDifferent, { asOf: "2026-10-11T09:00:00Z" }).totals.logical_vacancies,
    2,
    "a confirmed card alias cannot hide a genuinely different target group sharing that card",
  );
});

test("rechecking existing merged and different groups requires and accepts a validated frozen group plan", (t) => {
  const mergeContext = sourceLedger(t);
  const details = "https://jobs.acme.example/vacancy/301";
  const combined = combinedSourceFixture(
    fictionalSourceSet({ postId: 301, details }),
    fictionalSourceSet({ postId: 302, details }),
  );
  const observed = linkedSourceObservations(combined);
  const first = sourceBatchDir(mergeContext, combined, "frozen-merged-first", {
    ...observed,
    prefetchPlan: true,
  });
  recordSource(mergeContext.path, first);
  const unplanned = sourceBatchDir(mergeContext, combined, "merged-per-card-repeat", {
    ...observed,
    observedAt: "2026-10-09T09:00:00Z",
    prefetchPlan: true,
  });
  assert.equal(
    errorCode(() => recordSource(mergeContext.path, unplanned)),
    "triage_ledger_entry_unplanned",
  );
  assert.equal(existsSync(join(unplanned.dir, "ledger-record.json")), false);
  const planned = sourceBatchDir(mergeContext, combined, "merged-frozen-repeat", {
    ...observed,
    observedAt: "2026-10-09T09:00:00Z",
    prefetchPlan: true,
    planResolution: first.resolution,
  });
  assert.equal(planned.plan.items.length, 1);
  assert.equal(planned.plan.items[0].baseline.key, first.resolution.groups[0].logical_key);
  recordSource(mergeContext.path, planned);
  assert.equal(
    reviewLedger(readLedger(mergeContext.path), { asOf: "2026-10-09T09:00:00Z" }).totals
      .logical_vacancies,
    1,
  );

  const differentContext = sourceLedger(t);
  const fixture = fictionalSourceSet({ details: "https://jobs.acme.example/vacancy/311" });
  const external = detailsObservation(fixture, { company: "Beta" });
  external.raw.input.inputIndex = 2;
  external.raw.identity_status = "different";
  const observationPair = [sourceObservation(fixture), external.raw];
  const separate = sourceBatchDir(differentContext, fixture, "frozen-different-first", {
    observations: observationPair,
    captures: external.captures,
    prefetchPlan: true,
  });
  recordSource(differentContext.path, separate);
  assert.equal(separate.resolution.groups.length, 2);
  const repeated = sourceBatchDir(differentContext, fixture, "different-per-card-repeat", {
    observations: observationPair,
    captures: external.captures,
    observedAt: "2026-10-09T09:00:00Z",
    prefetchPlan: true,
  });
  assert.equal(
    errorCode(() => recordSource(differentContext.path, repeated)),
    "triage_ledger_entry_unplanned",
  );
  assert.equal(existsSync(join(repeated.dir, "ledger-record.json")), false);
  const plannedDifferent = sourceBatchDir(differentContext, fixture, "different-frozen-repeat", {
    observations: observationPair,
    captures: external.captures,
    observedAt: "2026-10-09T09:00:00Z",
    prefetchPlan: true,
    planResolution: separate.resolution,
  });
  recordSource(differentContext.path, plannedDifferent);
  const ledger = readLedger(differentContext.path);
  assert.equal(
    ledger.logical_entries.length,
    2,
    "genuinely different targets may share the immutable card reference",
  );
  assert.ok(
    ledger.logical_entries.every((entry) => entry.batch_id === plannedDifferent.payload.batch_id),
  );
});

test("a frozen archived merged plan remains corroborated after new source observations produce a title conflict", (t) => {
  const context = sourceLedger(t);
  const details = "https://jobs.acme.example/vacancy/981";
  const fixture = combinedSourceFixture(
    fictionalSourceSet({ postId: 981, details }),
    fictionalSourceSet({ postId: 982, details }),
  );
  const original = sourceBatchDir(context, fixture, "prior-confirmed-merged", {
    ...linkedSourceObservations(fixture),
    prefetchPlan: true,
  });
  assert.equal(verifySourceBatch(context, original, fixture).status, "pass");
  recordSource(context.path, original);
  const asOf = "2026-10-09T09:00:00Z";
  const frozen = ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, {
    asOf,
    resolution: original.resolution,
    collectionText: fixture.collectionText,
    captureRoot: original.dir,
  });
  assert.equal(frozen.items[0].action, "skip_known");
  assert.deepEqual(frozen.prior_resolution, {
    batch_id: original.payload.batch_id,
    entries_digest: readLedger(context.path).batches[0].entries_digest,
    record_sha256: digest(readFileSync(join(original.dir, "ledger-record.json"))),
    source_set_sha256: original.payload.source_set_sha256,
    source_resolution_sha256: original.payload.source_resolution_sha256,
  });
  const stable = sourceBatchDir(context, fixture, "stable-frozen-control", {
    ...linkedSourceObservations(fixture),
    observedAt: asOf,
    prefetchPlan: true,
  });
  overwriteSourcePlan(stable, frozen);
  assert.equal(verifySourceBatch(context, stable, fixture).status, "pass");
  const changed = linkedSourceObservations(fixture);
  changed.observations = changed.observations.map((raw) => {
    if (raw.source_ref !== details) return raw;
    const card = fixture.sourceSet.cards.find((item) => item.card_ref === raw.card_ref);
    const body = "Junior QA Engineer\nCompany: Acme\nManual testing and Java.";
    const capture = { file: raw.capture.file, sha256: digest(body) };
    const at = changed.captures.findIndex(([file]) => file === capture.file);
    changed.captures[at] = [
      capture.file,
      renderCaptureFile({
        body,
        header: {
          index: Number(capture.file.slice(0, 3)),
          adapter: "fictional",
          "source-id": "url",
          "requested-url": details,
          "final-url": details,
          "fetched-at": asOf,
          "http-status": 200,
          outcome: "active",
          "normalized-sha256": digest(body),
          "body-bytes": Buffer.byteLength(body),
          normalization: "none",
        },
      }),
    ];
    return sourceObservation(fixture, card, {
      inputIndex: raw.input.inputIndex,
      sourceRef: details,
      body,
      capture,
      jobTitle: "Junior QA Engineer",
    });
  });
  const conflicted = sourceBatchDir(context, fixture, "changed-frozen-title", {
    ...changed,
    observedAt: asOf,
    prefetchPlan: true,
  });
  overwriteSourcePlan(conflicted, frozen);
  assert.equal(conflicted.resolution.groups[0].result.review_code, "source_review");
  const before = readFileSync(join(conflicted.dir, "plan.json"), "utf8");
  const report = verifySourceBatch(context, conflicted, fixture);
  assert.equal(report.status, "pass", report.findingCodes.join(","));
  assert.equal(
    readFileSync(join(conflicted.dir, "plan.json"), "utf8"),
    before,
    "new conflicting observations never rewrite the prefetch plan",
  );
  const unproven = structuredClone(frozen);
  delete unproven.prior_resolution;
  overwriteSourcePlan(conflicted, unproven);
  assert.ok(
    verifySourceBatch(context, conflicted, fixture).findingCodes.includes(
      "source_plan_uncorroborated",
    ),
    "new observations cannot corroborate the old merged identity without independent prior evidence",
  );
  overwriteSourcePlan(conflicted, frozen);
  recordSource(context.path, conflicted);
  assert.equal(readLedger(context.path).logical_entries.length, 1);
  assert.equal(readLedger(context.path).logical_entries[0].decision, "MANUAL_REVIEW");
});

test("archived source plan provenance cannot be spoofed or replace the frozen baseline", (t) => {
  const context = sourceLedger(t);
  const details = "https://jobs.acme.example/vacancy/991";
  const fixture = combinedSourceFixture(
    fictionalSourceSet({ postId: 991, details }),
    fictionalSourceSet({ postId: 992, details }),
  );
  const first = sourceBatchDir(context, fixture, "proof-prior-merged", {
    ...linkedSourceObservations(fixture),
    prefetchPlan: true,
  });
  recordSource(context.path, first);
  const asOf = "2026-10-09T09:00:00Z";
  const options = {
    asOf,
    resolution: first.resolution,
    collectionText: fixture.collectionText,
    captureRoot: first.dir,
  };
  const frozen = ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, options);
  const refresh = sourceBatchDir(context, fixture, "proof-new-merged", {
    ...linkedSourceObservations(fixture),
    observedAt: asOf,
    prefetchPlan: true,
  });
  overwriteSourcePlan(refresh, frozen);
  assert.equal(verifySourceBatch(context, refresh, fixture).status, "pass");
  const spoofed = [
    (plan) => {
      plan.prior_resolution.batch_id = "../proof-prior-merged";
    },
    (plan) => {
      plan.prior_resolution.batch_id = "absent-prior";
    },
    (plan) => {
      plan.prior_resolution.record_sha256 = "0".repeat(64);
    },
    (plan) => {
      plan.prior_resolution.entries_digest = "0".repeat(64);
    },
    (plan) => {
      plan.prior_resolution.archive_dir = first.dir;
    },
    (plan) => {
      plan.items[0].baseline.decision = "BLOCKED";
    },
    (plan) => {
      plan.items[0].sources.find((source) => source.role === "details").action = "skip_closed";
    },
  ];
  for (const mutate of spoofed) {
    const fake = structuredClone(frozen);
    mutate(fake);
    overwriteSourcePlan(refresh, fake);
    assert.ok(
      verifySourceBatch(context, refresh, fixture).findingCodes.includes(
        "source_plan_uncorroborated",
      ),
      "a capsule or baseline claim is corroborated from the archive and current ledger",
    );
  }
  const staleSnapshot = { ...frozen, ledger_snapshot_sha256: "0".repeat(64) };
  overwriteSourcePlan(refresh, staleSnapshot);
  assert.ok(
    verifySourceBatch(context, refresh, fixture).findingCodes.includes(
      "source_plan_snapshot_mismatch",
    ),
  );
  overwriteSourcePlan(refresh, frozen);

  const recordPath = join(first.dir, "ledger-record.json");
  const recordBytes = readFileSync(recordPath);
  rmSync(recordPath);
  try {
    assert.ok(
      verifySourceBatch(context, refresh, fixture).findingCodes.includes(
        "source_plan_uncorroborated",
      ),
      "a missing prior archive cannot fall back to a matching current resolution",
    );
    const currentOnly = ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, options);
    assert.equal(
      Object.hasOwn(currentOnly, "prior_resolution"),
      false,
      "unarchived current-resolution planning remains readable under the initial contract",
    );
  } finally {
    writeFileSync(recordPath, recordBytes);
  }

  const resolutionPath = join(first.dir, "source-resolution.json");
  const resolutionBytes = readFileSync(resolutionPath);
  const reformatted = JSON.stringify(first.resolution);
  writeFileSync(resolutionPath, reformatted);
  try {
    const fake = structuredClone(frozen);
    fake.prior_resolution.source_resolution_sha256 = digest(reformatted);
    overwriteSourcePlan(refresh, fake);
    assert.ok(
      verifySourceBatch(context, refresh, fixture).findingCodes.includes(
        "source_plan_uncorroborated",
      ),
      "redeclaring a valid resolution's byte digest cannot overwrite the indexed immutable binding",
    );
    assert.equal(
      errorCode(() => ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, options)),
      "triage_ledger_source_plan_prior_invalid",
    );
  } finally {
    writeFileSync(resolutionPath, resolutionBytes);
    overwriteSourcePlan(refresh, frozen);
  }
  const noncanonical = join(context.store, "not-the-recorded-batch-id");
  renameSync(first.dir, noncanonical);
  try {
    assert.equal(
      errorCode(() =>
        ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, {
          ...options,
          captureRoot: noncanonical,
        }),
      ),
      "triage_ledger_source_plan_prior_invalid",
      "a prior archive must remain addressable by its bounded sibling batch id",
    );
  } finally {
    renameSync(noncanonical, first.dir);
  }
  assert.equal(verifySourceBatch(context, refresh, fixture).status, "pass");
});

test("a different target identity can record a new derived group from a complete initial card plan", (t) => {
  const context = sourceLedger(t);
  const fixture = fictionalSourceSet({ details: "https://jobs.acme.example/vacancy/91" });
  const observation = detailsObservation(fixture, { company: "Beta" });
  observation.raw.input.inputIndex = 2;
  observation.raw.identity_status = "different";
  const staged = sourceBatchDir(context, fixture, "different-target", {
    observations: [sourceObservation(fixture), observation.raw],
    captures: observation.captures,
    prefetchPlan: true,
  });
  assert.equal(staged.plan.items.length, 1);
  assert.equal(staged.resolution.groups.length, 2);
  recordSource(context.path, staged);
  const entries = readLedger(context.path).logical_entries;
  assert.equal(entries.length, 2);
  assert.equal(new Set(entries.map((entry) => entry.key)).size, 2);
  assert.equal(entries.find((entry) => entry.identity_status === "different").decision, "SKIP");
  assert.equal(entries.find((entry) => entry.identity_status === "confirmed").decision, "SKIP");
});

test("baseline verification refuses a fresh active capture for an exact terminal source inside an open logical review", (t) => {
  const { context, fixture, observedAt, frozen } = terminalSourceScenario(t);
  const reopened = sourceBatchDir(context, fixture, "terminal-source-refetch", {
    ...capturedDetailsOutcome(fixture, { observedAt }),
    observedAt,
    prefetchPlan: true,
  });
  overwriteSourcePlan(reopened, frozen);
  sourceFullEvidence(reopened, observedAt);
  assert.equal(
    reopened.resolution.observations.find((observation) => observation.input?.inputIndex === 2)
      .trace.decision,
    "EVALUATED",
  );
  const findings = ["per-batch", "full"].map((cadence) => {
    const report = verifySourceBatch(context, reopened, fixture, cadence);
    return {
      cadence,
      refetchFound: report.findingCodes.includes("refetched_closed_vacancy"),
      baseline: (report.checks.find((check) => check.id === "baseline-diff")?.findings ?? [])
        .filter((finding) => finding.code === "refetched_closed_vacancy")
        .map((finding) => finding.index),
    };
  });
  assert.deepEqual(
    findings,
    [
      { cadence: "per-batch", refetchFound: true, baseline: [] },
      { cadence: "full", refetchFound: true, baseline: [2] },
    ],
    "a nonprimary exact job source must obey its own terminal disposition",
  );
});

test("the source recorder refuses a fresh terminal-member observation before archive or index mutation", (t) => {
  const { context, fixture, observedAt, frozen } = terminalSourceScenario(t);
  const reopened = sourceBatchDir(context, fixture, "terminal-recorder-refetch", {
    ...capturedDetailsOutcome(fixture, { observedAt }),
    observedAt,
    prefetchPlan: true,
  });
  overwriteSourcePlan(reopened, frozen);
  const before = readFileSync(context.path, "utf8");
  const code = errorCode(() => recordSource(context.path, reopened));
  assert.deepEqual(
    {
      code,
      archived: existsSync(join(reopened.dir, "ledger-record.json")),
      unchanged: readFileSync(context.path, "utf8") === before,
    },
    { code: "triage_ledger_refetched_closed_source", archived: false, unchanged: true },
  );
});

test("carried closure reuses immutable source evidence and retains its actual checked clock", (t) => {
  const { context, fixture, closure, first, prior, observedAt, frozen } = terminalSourceScenario(t);
  const carried = sourceBatchDir(context, fixture, "terminal-copied-closure", {
    ...closure,
    observedAt,
    prefetchPlan: true,
  });
  overwriteSourcePlan(carried, frozen);
  sourceFullEvidence(carried, observedAt);
  for (const cadence of ["per-batch", "full"])
    assert.equal(verifySourceBatch(context, carried, fixture, cadence).status, "pass");
  recordSource(context.path, carried);
  const archived = readBatchRecord(carried.dir);
  assert.deepEqual(
    readLedger(context.path).source_records.find((source) => source.role === "details"),
    prior,
    "reusing a closed capture cannot pretend to fetch that source again",
  );
  assert.equal(
    archived.source_records.find((source) => source.role === "details").observed_at,
    prior.observed_at,
  );
  assert.ok(archived.parents.some((parent) => parent.batch_id === first.payload.batch_id));
  const bytes = readFileSync(context.path, "utf8");
  assert.equal(recordSource(context.path, carried).replayed, true);
  assert.equal(readFileSync(context.path, "utf8"), bytes);
});

test("a fresh closed capture stamp cannot masquerade as carried terminal history", (t) => {
  const { context, fixture, closure, first, observedAt, frozen } = terminalSourceScenario(t);
  const refreshed = capturedDetailsOutcome(fixture, { outcome: "closed", observedAt });
  const staged = sourceBatchDir(context, fixture, "terminal-new-closed-stamp", {
    ...refreshed,
    observedAt,
    prefetchPlan: true,
  });
  overwriteSourcePlan(staged, frozen);
  sourceFullEvidence(staged, observedAt);
  const before = readFileSync(context.path, "utf8");
  for (const cadence of ["per-batch", "full"])
    assert.ok(
      verifySourceBatch(context, staged, fixture, cadence).findingCodes.includes(
        "refetched_closed_vacancy",
      ),
    );
  assert.equal(
    errorCode(() => recordSource(context.path, staged)),
    "triage_ledger_refetched_closed_source",
  );
  const [captureFile, oldBytes] = closure.captures[0];
  writeFileSync(join(first.dir, captureFile), refreshed.captures[0][1]);
  try {
    for (const cadence of ["per-batch", "full"])
      assert.ok(
        verifySourceBatch(context, staged, fixture, cadence).findingCodes.includes(
          "refetched_closed_vacancy",
        ),
        "matching rewritten archive/new headers cannot postdate the checked terminal source",
      );
    assert.equal(
      errorCode(() => recordSource(context.path, staged)),
      "triage_ledger_refetched_closed_source",
    );
  } finally {
    writeFileSync(join(first.dir, captureFile), oldBytes);
  }
  assert.equal(existsSync(join(staged.dir, "ledger-record.json")), false);
  assert.equal(readFileSync(context.path, "utf8"), before);
});

test("changed immutable cards and blocked source retries may fetch the same URL", (t) => {
  const { context, fixture, observedAt } = terminalSourceScenario(t);
  const edited = fictionalSourceSet({
    details: fixture.sourceSet.cards[0].links[2].url,
    extra: " Updated post.",
  });
  const changed = sourceBatchDir(context, edited, "terminal-edited-card", {
    ...capturedDetailsOutcome(edited, { observedAt }),
    observedAt,
    prefetchPlan: true,
  });
  sourceFullEvidence(changed, observedAt);
  assert.equal(
    changed.plan.items[0].sources.find((source) => source.role === "details").action,
    "fetch_new",
  );
  for (const cadence of ["per-batch", "full"])
    assert.equal(verifySourceBatch(context, changed, edited, cadence).status, "pass");
  recordSource(context.path, changed);

  const retryContext = sourceLedger(t);
  const blocked = sourceBatchDir(retryContext, fixture, "blocked-source-first", {
    ...capturedDetailsOutcome(fixture, { outcome: "access_failure" }),
    prefetchPlan: true,
  });
  recordSource(retryContext.path, blocked);
  const retry = sourceBatchDir(retryContext, fixture, "blocked-source-retry", {
    ...capturedDetailsOutcome(fixture, { observedAt }),
    observedAt,
    prefetchPlan: true,
  });
  sourceFullEvidence(retry, observedAt);
  assert.equal(
    retry.plan.items[0].sources.find((source) => source.role === "details").action,
    "retry_blocked",
  );
  for (const cadence of ["per-batch", "full"])
    assert.equal(verifySourceBatch(retryContext, retry, fixture, cadence).status, "pass");
  recordSource(retryContext.path, retry);
  assert.equal(
    readLedger(retryContext.path).source_records.find((source) => source.role === "details")
      .observation_status,
    "open",
  );
});

test("two source writers sharing a logical row serialize and retain only the winning observation", async (t) => {
  const context = sourceLedger(t);
  const fixture = fictionalSourceSet();
  const batches = ["writer-a", "writer-b"].map((id) => sourceBatchDir(context, fixture, id));
  const child = `import {readFileSync} from 'node:fs';
    const {recordSourceBatch}=await import(${JSON.stringify(new URL("../tools/lib/triage-ledger-core.mjs", import.meta.url).href)});
    const payload=JSON.parse(readFileSync(process.argv[1], 'utf8'));
    try { recordSourceBatch(payload.path, payload.batch, {artifactsDir:payload.artifactsDir}); }
    catch(error) { process.stderr.write(error.code); process.exitCode=1; }`;
  const runs = batches.map((staged, at) => {
    const file = join(context.root, `writer-${at}.json`);
    writeFileSync(
      file,
      JSON.stringify({ path: context.path, batch: staged.payload, artifactsDir: staged.dir }),
    );
    return new Promise((resolveRun, rejectRun) => {
      const process = spawn(globalThis.process.execPath, [
        "--input-type=module",
        "--eval",
        child,
        file,
      ]);
      let stderr = "";
      process.stderr.setEncoding("utf8");
      process.stderr.on("data", (text) => {
        stderr += text;
      });
      process.on("error", rejectRun);
      process.on("close", (status) => resolveRun({ status, stderr }));
    });
  });
  const outcomes = await Promise.all(runs);
  assert.equal(outcomes.filter((outcome) => outcome.status === 0).length, 1);
  assert.equal(
    outcomes.find((outcome) => outcome.status !== 0).stderr,
    "triage_ledger_concurrent_observation",
  );
  assert.equal(readLedger(context.path).logical_entries.length, 1);
  assert.equal(
    batches.filter((staged) => existsSync(join(staged.dir, "ledger-record.json"))).length,
    1,
  );
});

test("an unchanged card with a body-less access failure remains retry_blocked without confirming or closing it", (t) => {
  const context = sourceLedger(t);
  const fixture = fictionalSourceSet();
  const raw = sourceObservation(fixture);
  raw.capture = null;
  raw.body = null;
  raw.description_kind = "unknown";
  raw.identity_status = "linked_unconfirmed";
  raw.facts = Object.fromEntries(Object.keys(raw.facts).map((key) => [key, null]));
  raw.input.source = {
    ...raw.input.source,
    accessOutcome: "technical_unavailable",
    accessReason: "challenge",
    company: null,
    jobTitle: null,
    evidenceQuote: null,
    finalUrl: null,
  };
  raw.input.role = {
    ...raw.input.role,
    family: "unknown",
    automation: "unknown",
    seniority: "unknown",
    language: "unknown",
    domain: "unclear",
    ai: { product: "unknown", work: "unknown" },
    evidence: Object.fromEntries(Object.keys(raw.input.role.evidence).map((key) => [key, null])),
  };
  raw.input.offers = [];
  raw.input.sourceContext = {
    ...raw.input.sourceContext,
    primaryCaptureSha256: null,
    startLine: null,
    endLine: null,
  };
  const manifest = `${JSON.stringify({ schemaVersion: 1, tool: "vacancy-fetch", records: [{ index: 1, requestedUrl: raw.source_ref, outcome: "access_failure", usable: false }] })}\n`;
  raw.transport = { file: "fetch-manifest.json", sha256: digest(manifest), index: 1 };
  const staged = sourceBatchDir(context, fixture, "bodyless-failure", {
    observations: [raw],
    captures: [["fetch-manifest.json", manifest]],
    prefetchPlan: true,
  });
  recordSource(context.path, staged);
  const entry = readLedger(context.path).logical_entries[0];
  assert.equal(entry.decision, "BLOCKED");
  assert.equal(entry.status, "open");
  assert.equal(entry.identity_status, "linked_unconfirmed");
  assert.equal(
    ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, { asOf: sourceInstant })
      .items[0].action,
    "retry_blocked",
  );
  assert.equal(
    ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, {
      asOf: sourceInstant,
      collectionText: fixture.collectionText,
      resolution: staged.resolution,
    }).items[0].action,
    "retry_blocked",
  );
  const edited = fictionalSourceSet({ title: "Junior QA Engineer" });
  assert.equal(
    ledgerSourceApi.planSourceBatch(context.path, edited.sourceSet, { asOf: sourceInstant })
      .items[0].action,
    "fetch_new",
  );
});

test("a confirmed full original keeps a failed details source retryable within its exact card membership", (t) => {
  const context = sourceLedger(t);
  const fixture = fictionalSourceSet({ details: "https://acme.example/jobs/qa-7" });
  const failure = unreadSourceObservation(fixture, {
    sourceRef: fixture.sourceSet.cards[0].links[2].url,
    inputIndex: 2,
  });
  const staged = sourceBatchDir(context, fixture, "full-plus-failed-details", {
    observations: [sourceObservation(fixture), failure.raw],
    captures: failure.captures,
    prefetchPlan: true,
  });
  recordSource(context.path, staged);
  const ledger = readLedger(context.path);
  assert.equal(ledger.logical_entries[0].decision, "SKIP");
  const plan = ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, {
    asOf: "2026-10-09T09:00:00Z",
    collectionText: fixture.collectionText,
    resolution: staged.resolution,
  });
  assert.equal(plan.items[0].action, "skip_known");
  assert.equal(
    plan.items[0].sources.find((source) => source.role === "details").action,
    "retry_blocked",
  );
  assert.equal(
    plan.items[0].sources.find((source) => source.role === "company_context").action,
    "company_context",
  );
  const unconfirmedPlan = ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, {
    asOf: "2026-10-09T09:00:00Z",
  });
  assert.equal(
    unconfirmedPlan.items[0].sources.find((source) => source.role === "details").action,
    "retry_blocked",
  );
  const retainedFailure = ledger.source_records.find((source) => source.role === "details");
  assert.equal(retainedFailure.observation_decision, "BLOCKED");
  assert.equal(retainedFailure.observation_status, "open");
  const originalOnly = sourceBatchDir(context, fixture, "full-plus-unfetched-details", {
    observations: [sourceObservation(fixture)],
    observedAt: "2026-10-09T09:00:00Z",
    prefetchPlan: true,
  });
  recordSource(context.path, originalOnly);
  assert.deepEqual(
    readLedger(context.path).source_records.find((source) => source.role === "details"),
    retainedFailure,
    "unfetched accounting cannot erase the last actual source failure",
  );
  assert.equal(
    ledgerSourceApi
      .planSourceBatch(context.path, fixture.sourceSet, { asOf: "2026-10-10T09:00:00Z" })
      .items[0].sources.find((source) => source.role === "details").action,
    "retry_blocked",
  );
  assert.equal(
    planBatch(readLedger(context.path), [failure.raw.source_ref], { asOf: "2026-10-10T09:00:00Z" })
      .items[0].action,
    "fetch_new",
    "a standalone URL does not inherit card source outcomes globally",
  );
  const edited = fictionalSourceSet({
    title: "Junior QA Engineer",
    details: "https://acme.example/jobs/qa-7",
  });
  const editedPlan = ledgerSourceApi.planSourceBatch(context.path, edited.sourceSet, {
    asOf: "2026-10-09T09:00:00Z",
  });
  assert.equal(
    editedPlan.items[0].sources.find((source) => source.role === "details").action,
    "fetch_new",
  );
});

test("a pure corroborated closed source result has closed liveness while mixed active sources remain open", (t) => {
  const context = sourceLedger(t);
  const fixture = fictionalSourceSet();
  const closed = unreadSourceObservation(fixture, { closed: true });
  const staged = sourceBatchDir(context, fixture, "bodyless-confirmed-closure", {
    observations: [closed.raw],
    captures: closed.captures,
    prefetchPlan: true,
  });
  assert.equal(staged.resolution.groups[0].primary, null);
  assert.equal(staged.resolution.groups[0].result.decision, "SKIP");
  assert.equal(staged.resolution.groups[0].result.skip_code, "vacancy_unavailable");
  recordSource(context.path, staged);
  assert.equal(readLedger(context.path).logical_entries[0].status, "closed");

  const active = fictionalSourceSet({ details: "https://acme.example/jobs/qa-8", postId: 8 });
  const closedDetails = unreadSourceObservation(active, {
    sourceRef: active.sourceSet.cards[0].links[2].url,
    inputIndex: 2,
    closed: true,
  });
  const mixed = sourceBatchDir(context, active, "mixed-active-closed-details", {
    observations: [sourceObservation(active), closedDetails.raw],
    captures: closedDetails.captures,
    prefetchPlan: true,
  });
  assert.equal(mixed.resolution.groups[0].result.review_code, "source_review");
  assert.ok(mixed.resolution.groups[0].conflicts.includes("conflicting_liveness"));
  recordSource(context.path, mixed);
  assert.equal(
    readLedger(context.path).logical_entries.find((entry) =>
      entry.card_refs.includes(active.sourceSet.cards[0].card_ref),
    ).status,
    "open",
  );
  const mixedPlan = ledgerSourceApi.planSourceBatch(context.path, active.sourceSet, {
    asOf: "2026-10-09T09:00:00Z",
    resolution: mixed.resolution,
    collectionText: active.collectionText,
  });
  assert.equal(mixedPlan.items[0].action, "source_review");
  assert.equal(
    mixedPlan.items[0].sources.find((source) => source.role === "details").action,
    "skip_closed",
  );
  assert.equal(
    mixedPlan.items[0].sources.find((source) => source.role === "original_post").action,
    "source_review",
  );
  assert.equal(
    ledgerSourceApi
      .planSourceBatch(context.path, active.sourceSet, { asOf: "2026-10-09T09:00:00Z" })
      .items[0].sources.find((source) => source.role === "details").action,
    "skip_closed",
    "the default card plan also preserves its exact terminal source",
  );
  const edited = fictionalSourceSet({
    postId: 8,
    details: closedDetails.raw.source_ref,
    title: "Junior QA Engineer",
  });
  assert.equal(
    ledgerSourceApi
      .planSourceBatch(context.path, edited.sourceSet, { asOf: "2026-10-09T09:00:00Z" })
      .items[0].sources.find((source) => source.role === "details").action,
    "fetch_new",
    "an edited card cannot inherit the closed source outcome",
  );
  assert.equal(
    planBatch(readLedger(context.path), [closedDetails.raw.source_ref], {
      asOf: "2026-10-09T09:00:00Z",
    }).items[0].action,
    "fetch_new",
    "a closed card source never becomes a global URL disposition",
  );
});

function stagedHomepageCorrection(context, fixture, label) {
  const parentId = `${label}-parent`;
  const dir = join(context.store, parentId);
  mkdirSync(dir);
  seedTraces(dir, [fixture.homepage]);
  seedPlan(dir, context.path, [fixture.homepage]);
  recordBatch(
    context.path,
    batch({
      batch_id: parentId,
      policy_id: "legacy-policy",
      entries: [
        entry({ url: fixture.homepage, decision: "BLOCKED", flags: ["vacancy_unavailable"] }),
      ],
    }),
    { artifactsDir: dir },
  );
  const record = readBatchRecord(dir);
  const corrections = [
    {
      parent_batch_id: parentId,
      parent_entries_digest: record.entries_digest,
      card_ref: fixture.sourceSet.cards[0].card_ref,
      url: fixture.homepage,
    },
  ];
  return sourceBatchDir(context, fixture, `${label}-correction`, { corrections });
}

test("a correction refuses a concurrently replaced parent URL before creating its immutable record", (t) => {
  const context = sourceLedger(t);
  const fixture = fictionalSourceSet();
  const staged = stagedHomepageCorrection(context, fixture, "concurrent");
  recordWithoutStore(
    context.path,
    batch({
      batch_id: "changed-parent-url",
      observed_at: "2026-10-09T09:00:00Z",
      entries: [
        entry({ url: fixture.homepage, decision: "BLOCKED", flags: ["vacancy_unavailable"] }),
      ],
    }),
  );
  const bytes = readFileSync(context.path, "utf8");
  assert.equal(
    errorCode(() =>
      ledgerSourceApi.correctSourceObservations(context.path, staged.payload, {
        artifactsDir: staged.dir,
      }),
    ),
    "triage_ledger_concurrent_observation",
  );
  assert.equal(existsSync(join(staged.dir, "ledger-record.json")), false);
  assert.equal(readFileSync(context.path, "utf8"), bytes);
});

test("an orphaned correction replays while retaining a later standalone URL observation", (t) => {
  const context = sourceLedger(t);
  const fixture = fictionalSourceSet();
  const card = fixture.sourceSet.cards[0];
  const snapshot = fixture.sourceSet.snapshots[0];
  ledgerSourceApi.withLedgerLock(context.path, (ledger) => ({
    ledger: {
      ...ledger,
      source_records: Array.from({ length: 16384 }, (_, at) => {
        const source = {
          logical_key: ledgerSourceApi.logicalVacancyKey(card.card_ref),
          card_ref: card.card_ref,
          snapshot_ref: snapshot.snapshot_ref,
          anchor: 1,
          role: "company_context",
          url: `https://padding.example/${at}`,
          disposition: "company_context",
          observation_ref: null,
          batch_id: "synthetic",
          observed_at: sourceInstant,
        };
        return {
          membership_key: digest(
            JSON.stringify([
              source.logical_key,
              source.card_ref,
              source.anchor,
              source.role,
              source.url,
            ]),
          ),
          ...source,
        };
      }),
    },
  }));
  const staged = stagedHomepageCorrection(context, fixture, "orphan");
  assert.equal(
    errorCode(() =>
      ledgerSourceApi.correctSourceObservations(context.path, staged.payload, {
        artifactsDir: staged.dir,
      }),
    ),
    "triage_ledger_invalid",
  );
  assert.equal(existsSync(join(staged.dir, "ledger-record.json")), true);
  assert.equal(readLedger(context.path).corrections.length, 0);
  ledgerSourceApi.withLedgerLock(context.path, (ledger) => ({
    ledger: { ...ledger, source_records: ledger.source_records.slice(2) },
  }));
  recordWithoutStore(
    context.path,
    batch({
      batch_id: "standalone-after-orphan",
      observed_at: "2026-10-09T09:00:00Z",
      entries: [
        entry({ url: fixture.homepage, decision: "BLOCKED", flags: ["vacancy_unavailable"] }),
      ],
    }),
  );
  const parentId = staged.payload.corrections[0].parent_batch_id;
  const indexedParent = readLedger(context.path).batches.find((item) => item.batch_id === parentId);
  const orphanBytes = readFileSync(join(staged.dir, "ledger-record.json"));
  ledgerSourceApi.withLedgerLock(context.path, (ledger) => ({
    ledger: { ...ledger, batches: ledger.batches.filter((item) => item.batch_id !== parentId) },
  }));
  const unindexedBytes = readFileSync(context.path);
  assert.equal(
    errorCode(() =>
      ledgerSourceApi.correctSourceObservations(context.path, staged.payload, {
        artifactsDir: staged.dir,
      }),
    ),
    "triage_ledger_source_parent_invalid",
    "orphan adoption cannot waive the parent index",
  );
  assert.deepEqual(readFileSync(context.path), unindexedBytes);
  assert.deepEqual(readFileSync(join(staged.dir, "ledger-record.json")), orphanBytes);
  ledgerSourceApi.withLedgerLock(context.path, (ledger) => ({
    ledger: { ...ledger, batches: [...ledger.batches, indexedParent] },
  }));
  const later = structuredClone(readLedger(context.path).entries[0]);
  ledgerSourceApi.correctSourceObservations(context.path, staged.payload, {
    artifactsDir: staged.dir,
  });
  assert.deepEqual(readLedger(context.path).entries[0], later);
  assert.equal(readLedger(context.path).corrections.length, 1);
  assert.equal(reviewLedger(readLedger(context.path), { asOf: sourceInstant }).totals.entries, 1);
  assert.equal(readLedger(context.path).logical_entries.length, 0);
});

function recollectionPlanningScenario(t) {
  const context = sourceLedger(t);
  const details = "https://jobs.acme.example/vacancy/1001";
  const originalFixture = combinedSourceFixture(
    fictionalSourceSet({ postId: 1001, details }),
    fictionalSourceSet({ postId: 1002, details }),
  );
  const original = sourceBatchDir(context, originalFixture, "recollection-indexed-parent", {
    ...linkedSourceObservations(originalFixture),
    prefetchPlan: true,
  });
  sourceFullEvidence(original, sourceInstant);
  for (const cadence of ["per-batch", "full"]) {
    const report = verifySourceBatch(context, original, originalFixture, cadence);
    assert.equal(report.status, "pass", `${cadence}: ${report.findingCodes.join(",")}`);
  }
  recordSource(context.path, original);
  const fixture = structuredClone(originalFixture);
  for (const snapshot of fixture.sourceSet.snapshots)
    snapshot.capture.captured_at = "2026-10-09T08:30:00.000Z";
  assert.deepEqual(fixture.sourceSet.cards, originalFixture.sourceSet.cards);
  assert.notEqual(sourceSetDigest(fixture.sourceSet), sourceSetDigest(originalFixture.sourceSet));
  const asOf = "2026-10-09T09:00:00Z";
  const prefetch = sourceBatchDir(context, fixture, "recollection-own-prefetch", {
    ...linkedSourceObservations(fixture),
    observedAt: asOf,
    prefetchPlan: true,
  });
  return { context, details, originalFixture, original, fixture, asOf, prefetch };
}

function sourceArtifactBytes(dir) {
  const files = [];
  const scan = (parent, prefix = "") => {
    for (const file of readdirSync(parent, { withFileTypes: true })) {
      const relative = `${prefix}${file.name}`;
      if (file.isDirectory()) scan(join(parent, file.name), `${relative}/`);
      else files.push([relative, digest(readFileSync(join(parent, file.name)))]);
    }
  };
  scan(dir);
  return files.sort(([a], [b]) => a.localeCompare(b));
}

function publishedPrefetchBatch(
  scenario,
  batchId,
  observations = linkedSourceObservations(scenario.fixture),
) {
  const { context, fixture, prefetch, asOf } = scenario;
  const dir = join(context.store, batchId);
  mkdirSync(dir);
  const frozen = ledgerSourceApi.publishSourcePlan(context.path, fixture.sourceSet, {
    asOf,
    resolution: prefetch.resolution,
    collectionText: fixture.collectionText,
    captureRoot: prefetch.dir,
    artifactsDir: dir,
  });
  const staged = sourceBatchDir(context, fixture, batchId, {
    ...observations,
    observedAt: "2026-10-09T09:20:00Z",
    claimedDir: true,
    frozenPlan: frozen,
  });
  sourceFullEvidence(staged, "2026-10-09T09:20:00Z");
  return staged;
}

test("a recollected current-set prefetch plan survives a fresh Senior/Junior conflict at both cadences", (t) => {
  const { context, details, fixture, asOf, prefetch } = recollectionPlanningScenario(t);
  const conflictDir = join(context.store, "recollection-current-proof-conflict");
  mkdirSync(conflictDir);
  const frozen = ledgerSourceApi.publishSourcePlan(context.path, fixture.sourceSet, {
    asOf,
    resolution: prefetch.resolution,
    collectionText: fixture.collectionText,
    captureRoot: prefetch.dir,
    artifactsDir: conflictDir,
  });
  assert.equal(frozen.items.length, 1);
  assert.equal(frozen.items[0].action, "skip_known");
  assert.equal(Object.hasOwn(frozen, "prior_resolution"), false);
  const changed = linkedSourceObservations(fixture);
  changed.observations = changed.observations.map((raw) => {
    const title = raw.source_ref === details ? "Junior QA Engineer" : fixture.title;
    if (raw.source_ref === details) {
      const card = fixture.sourceSet.cards.find((item) => item.card_ref === raw.card_ref);
      const body = `${title}\nCompany: Acme\nManual testing and Java.`;
      const capture = { file: raw.capture.file, sha256: digest(body) };
      const at = changed.captures.findIndex(([file]) => file === capture.file);
      changed.captures[at] = [
        capture.file,
        renderCaptureFile({
          body,
          header: {
            index: Number(capture.file.slice(0, 3)),
            adapter: "fictional",
            "source-id": "url",
            "requested-url": details,
            "final-url": details,
            "fetched-at": "2026-10-09T09:10:00Z",
            "http-status": 200,
            outcome: "active",
            "normalized-sha256": digest(body),
            "body-bytes": Buffer.byteLength(body),
            normalization: "none",
          },
        }),
      ];
      raw = sourceObservation(fixture, card, {
        inputIndex: raw.input.inputIndex,
        sourceRef: details,
        body,
        capture,
        jobTitle: title,
      });
    }
    raw.facts.seniority = {
      value: title.startsWith("Junior") ? "Junior" : "Senior",
      evidence_quote: title,
    };
    return raw;
  });
  const conflicted = sourceBatchDir(context, fixture, "recollection-current-proof-conflict", {
    ...changed,
    observedAt: "2026-10-09T09:20:00Z",
    claimedDir: true,
    frozenPlan: frozen,
  });
  sourceFullEvidence(conflicted, "2026-10-09T09:20:00Z");
  assert.ok(conflicted.resolution.groups[0].conflicts.includes("conflicting_seniority"));
  assert.equal(conflicted.resolution.groups[0].result.review_code, "source_review");
  const ledgerBytes = readFileSync(context.path);
  const planBytes = readFileSync(join(conflicted.dir, "plan.json"));
  const reports = ["per-batch", "full"].map((cadence) => ({
    cadence,
    report: verifySourceBatch(context, conflicted, fixture, cadence),
  }));
  assert.deepEqual(
    reports.map(({ cadence, report }) => ({
      cadence,
      status: report.status,
      codes: report.findingCodes,
    })),
    ["per-batch", "full"].map((cadence) => ({ cadence, status: "pass", codes: [] })),
  );
  assert.deepEqual(readFileSync(context.path), ledgerBytes);
  assert.deepEqual(readFileSync(join(conflicted.dir, "plan.json")), planBytes);
  recordSource(context.path, conflicted);
  assert.equal(readLedger(context.path).logical_entries.length, 1);
  assert.equal(readLedger(context.path).logical_entries[0].decision, "MANUAL_REVIEW");
  const recordedBytes = readFileSync(context.path);
  assert.equal(recordSource(context.path, conflicted).replayed, true);
  assert.deepEqual(readFileSync(context.path), recordedBytes);
});

test("current-set prefetch proofs preserve stable controls, pure reproduction and initial-plan guards", (t) => {
  const scenario = recollectionPlanningScenario(t);
  const { context, fixture, prefetch, asOf, original, originalFixture } = scenario;
  const oldBytes = sourceArtifactBytes(original.dir);
  const ledgerBytes = readFileSync(context.path);
  const oldPlan = ledgerSourceApi.planSourceBatch(context.path, originalFixture.sourceSet, {
    asOf,
    resolution: original.resolution,
    collectionText: originalFixture.collectionText,
    captureRoot: original.dir,
  });
  assert.ok(oldPlan.prior_resolution);
  assert.equal(Object.hasOwn(oldPlan, "prefetch_resolution"), false);
  assert.equal(
    errorCode(() =>
      ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, {
        asOf,
        resolution: original.resolution,
        collectionText: fixture.collectionText,
        captureRoot: original.dir,
      }),
    ),
    "triage_ledger_source_resolution_invalid",
  );
  const currentOnly = ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, {
    asOf,
    resolution: prefetch.resolution,
    collectionText: fixture.collectionText,
    captureRoot: prefetch.dir,
  });
  assert.equal(Object.hasOwn(currentOnly, "prefetch_resolution"), false);
  const compatible = sourceBatchDir(context, fixture, "current-prefetch-legacy-stable", {
    ...linkedSourceObservations(fixture),
    observedAt: "2026-10-09T09:20:00Z",
    prefetchPlan: true,
  });
  overwriteSourcePlan(compatible, currentOnly);
  sourceFullEvidence(compatible, "2026-10-09T09:20:00Z");
  const stable = publishedPrefetchBatch(scenario, "current-prefetch-proved-stable");
  const before = sourceArtifactBytes(stable.dir);
  const ownOptions = {
    asOf,
    collectionText: fixture.collectionText,
    artifactsDir: stable.dir,
    prefetchProof: stable.plan.prefetch_resolution,
  };
  assert.deepEqual(
    ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, ownOptions),
    stable.plan,
  );
  assert.deepEqual(
    ledgerSourceApi.planSourceBatch(readLedger(context.path), fixture.sourceSet, ownOptions),
    stable.plan,
  );
  const proof = ledgerSourceApi.readSourcePlanPrefetchResolution(fixture.sourceSet, {
    ...ownOptions,
    reference: stable.plan.prefetch_resolution,
  });
  assert.deepEqual(proof.resolution, prefetch.resolution);
  assert.deepEqual(
    readFileSync(join(proof.captureRoot, "001.capture.txt")),
    readFileSync(join(prefetch.dir, "001.capture.txt")),
  );
  for (const staged of [compatible, stable]) {
    for (const cadence of ["per-batch", "full"]) {
      const report = verifySourceBatch(context, staged, fixture, cadence);
      assert.equal(report.status, "pass", `${cadence}: ${report.findingCodes.join(",")}`);
    }
  }
  assert.deepEqual(sourceArtifactBytes(stable.dir), before);
  assert.deepEqual(sourceArtifactBytes(original.dir), oldBytes);
  assert.deepEqual(readFileSync(context.path), ledgerBytes);
  const initial = sourceBatchDir(context, fixture, "current-prefetch-unproven-derived", {
    ...linkedSourceObservations(fixture),
    observedAt: "2026-10-09T09:20:00Z",
    prefetchPlan: true,
  });
  sourceFullEvidence(initial, "2026-10-09T09:20:00Z");
  for (const cadence of ["per-batch", "full"])
    assert.ok(
      verifySourceBatch(context, initial, fixture, cadence).findingCodes.includes(
        "source_plan_baseline_missing",
      ),
    );

  const edited = combinedSourceFixture(
    fictionalSourceSet({ postId: 1001, details: scenario.details, extra: " Edited card." }),
    fictionalSourceSet({ postId: 1002, details: scenario.details }),
  );
  const editedPlan = ledgerSourceApi.planSourceBatch(context.path, edited.sourceSet, {
    asOf,
    collectionText: edited.collectionText,
  });
  assert.equal(
    editedPlan.items.find((item) => item.card_refs.includes(edited.sourceSet.cards[0].card_ref))
      .action,
    "fetch_new",
  );
  assert.equal(
    errorCode(() =>
      ledgerSourceApi.planSourceBatch(context.path, edited.sourceSet, {
        ...ownOptions,
        collectionText: edited.collectionText,
      }),
    ),
    "triage_ledger_source_plan_prefetch_invalid",
  );
});

test("current-set prefetch custody uses the configured languages at both verifier cadences", (t) => {
  const { context, fixture, asOf } = recollectionPlanningScenario(t);
  const languages = ["English", "Russian"];
  const changed = linkedSourceObservations(fixture);
  for (const observation of changed.observations) observation.input.role.language = "Russian";
  const captureRoot = join(context.root, "configured-language-prefetch");
  mkdirSync(captureRoot);
  writeFileSync(join(captureRoot, fixture.sourceSet.snapshots[0].capture.file), fixture.html);
  for (const [file, bytes] of changed.captures) writeFileSync(join(captureRoot, file), bytes);
  const prefetch = resolveSourceSet({
    sourceSet: fixture.sourceSet,
    collectionText: fixture.collectionText,
    observations: changed.observations,
    captureRoot,
    languages,
  });
  const dir = join(context.store, "current-proof-configured-language");
  mkdirSync(dir);
  const frozen = ledgerSourceApi.publishSourcePlan(context.path, fixture.sourceSet, {
    asOf,
    resolution: prefetch,
    collectionText: fixture.collectionText,
    captureRoot,
    artifactsDir: dir,
    validation: { languages },
  });
  const htmlFiles = new Set(fixture.sourceSet.snapshots.map((snapshot) => snapshot.capture.file));
  for (const [file, bytes] of changed.captures)
    if (!htmlFiles.has(file)) writeFileSync(join(dir, file), bytes);
  const resolution = publishSourceResolution({
    artifactsDir: dir,
    sourceSet: fixture.sourceSet,
    collectionText: fixture.collectionText,
    sourceCaptureRoot: captureRoot,
    observations: changed.observations,
    languages,
  });
  sourceFullEvidence({ dir, resolution }, "2026-10-09T09:20:00Z");
  const before = sourceArtifactBytes(dir);
  const ledgerBytes = readFileSync(context.path);
  assert.deepEqual(
    ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, {
      asOf,
      collectionText: fixture.collectionText,
      artifactsDir: dir,
      prefetchProof: frozen.prefetch_resolution,
      validation: { languages },
    }),
    frozen,
  );
  for (const cadence of ["per-batch", "full"]) {
    const report = runSuite(
      buildContext({
        artifactsDir: dir,
        linksFile: join(dir, "collection.links.txt"),
        from: 1,
        to: fixture.collectionText.trim().split("\n").length,
        ledgerPath: context.path,
        languages,
      }),
      cadence,
    );
    assert.equal(report.status, "pass", `${cadence}: ${report.findingCodes.join(",")}`);
  }
  assert.deepEqual(sourceArtifactBytes(dir), before);
  assert.deepEqual(readFileSync(context.path), ledgerBytes);
});

test("prefetch plan claims cannot forge proof, baseline, source action or a parent fallback", (t) => {
  const scenario = recollectionPlanningScenario(t);
  const { context, fixture, original, asOf } = scenario;
  const staged = publishedPrefetchBatch(scenario, "current-proof-claims");
  const frozen = structuredClone(staged.plan);
  const ledgerBytes = readFileSync(context.path);
  const prior = ledgerSourceApi.planSourceBatch(context.path, scenario.originalFixture.sourceSet, {
    asOf,
    resolution: original.resolution,
    collectionText: scenario.originalFixture.collectionText,
    captureRoot: original.dir,
  }).prior_resolution;
  for (const mutate of [
    (plan) => {
      plan.prefetch_resolution.schema_version = 2;
    },
    (plan) => {
      plan.prefetch_resolution.batch_id = "../current-proof-claims";
    },
    (plan) => {
      plan.prefetch_resolution.batch_id = "another-proof-batch";
    },
    (plan) => {
      plan.prefetch_resolution.proof_sha256 = "0".repeat(64);
    },
    (plan) => {
      plan.prefetch_resolution.source_set_sha256 = original.payload.source_set_sha256;
    },
    (plan) => {
      plan.prefetch_resolution.source_resolution_sha256 = "0".repeat(64);
    },
    (plan) => {
      plan.prefetch_resolution.archive_dir = staged.dir;
    },
    (plan) => {
      plan.prior_resolution = prior;
    },
    (plan) => {
      plan.items[0].baseline.decision = "BLOCKED";
    },
    (plan) => {
      plan.items[0].baseline.last_checked = asOf;
    },
    (plan) => {
      plan.items[0].baseline = null;
    },
    (plan) => {
      plan.items[0].action = "skip_closed";
    },
    (plan) => {
      plan.items[0].sources.find((source) => source.role === "details").action = "skip_closed";
    },
    (plan) => {
      plan.items[0].card_refs = ["tg-card:sha256:" + "0".repeat(64)];
    },
    (plan) => {
      plan.ledger_snapshot_sha256 = "0".repeat(64);
    },
  ]) {
    const fake = structuredClone(frozen);
    mutate(fake);
    overwriteSourcePlan(staged, fake);
    for (const cadence of ["per-batch", "full"])
      assert.ok(
        verifySourceBatch(context, staged, fixture, cadence).findingCodes.includes(
          "source_plan_uncorroborated",
        ),
      );
    assert.deepEqual(readFileSync(context.path), ledgerBytes);
    assert.equal(existsSync(join(staged.dir, "ledger-record.json")), false);
  }
  overwriteSourcePlan(staged, frozen);
  assert.equal(verifySourceBatch(context, staged, fixture).status, "pass");
  recordSource(context.path, staged);
  const archived = readFileSync(join(staged.dir, "ledger-record.json"));
  const recorded = readFileSync(context.path);
  const missingProof = join(staged.dir, "source-plan", "proof.json");
  const bytes = readFileSync(missingProof);
  rmSync(missingProof);
  assert.equal(
    errorCode(() => recordSource(context.path, staged)),
    "triage_ledger_source_plan_prefetch_invalid",
  );
  assert.deepEqual(readFileSync(context.path), recorded);
  assert.deepEqual(readFileSync(join(staged.dir, "ledger-record.json")), archived);
  writeFileSync(missingProof, bytes);
  assert.equal(recordSource(context.path, staged).replayed, true);
  assert.deepEqual(readFileSync(context.path), recorded);
});

test("retained current-set proof rejects missing, extra, altered and unsafe dependencies", (t) => {
  const scenario = recollectionPlanningScenario(t);
  const { context, fixture } = scenario;
  const staged = publishedPrefetchBatch(scenario, "current-proof-custody");
  const root = join(staged.dir, "source-plan");
  const proofPath = join(root, "proof.json");
  const proofBytes = readFileSync(proofPath);
  const frozen = structuredClone(staged.plan);
  const ledgerBytes = readFileSync(context.path);
  const refused = () => {
    for (const cadence of ["per-batch", "full"]) {
      const report = verifySourceBatch(context, staged, fixture, cadence);
      assert.ok(
        report.findingCodes.includes("source_plan_uncorroborated"),
        report.findingCodes.join(","),
      );
      assert.ok(
        report.findingCodes.includes("unexpected_artifact"),
        "invalid proof subtree cannot be silently ignored",
      );
    }
    assert.notEqual(
      errorCode(() => recordSource(context.path, staged)),
      null,
    );
    assert.deepEqual(readFileSync(context.path), ledgerBytes);
    assert.equal(existsSync(join(staged.dir, "ledger-record.json")), false);
  };
  for (const file of [
    "proof.json",
    "source-set.json",
    "collection.links.txt",
    "source-resolution.json",
    "101.page.html",
    "001.capture.txt",
  ]) {
    const path = join(root, file);
    const bytes = readFileSync(path);
    rmSync(path);
    refused();
    writeFileSync(path, bytes);
    writeFileSync(path, file === "proof.json" ? "{ malformed" : `${bytes.toString("utf8")} `);
    refused();
    writeFileSync(path, bytes);
  }
  for (const file of ["unbound.capture.txt", "unbound.json"]) {
    writeFileSync(join(root, file), "unbound");
    refused();
    rmSync(join(root, file));
  }
  mkdirSync(join(root, "empty-unbound"));
  refused();
  rmSync(join(root, "empty-unbound"), { recursive: true });
  for (const mutate of [
    (proof) => {
      proof.files[0].file = "../outside";
    },
    (proof) => {
      proof.files[0].bytes = -1;
    },
    (proof) => {
      proof.files[0].sha256 = "0".repeat(64);
    },
    (proof) => {
      proof.files.push(proof.files[0]);
    },
    (proof) => {
      proof.files = Array.from({ length: 4097 }, () => proof.files[0]);
    },
    (proof) => {
      proof.as_of = "2026-10-09T09:01:00Z";
    },
    (proof) => {
      proof.batch_id = "different-proof-batch";
    },
    (proof) => {
      proof.path = root;
    },
  ]) {
    const proof = JSON.parse(proofBytes);
    mutate(proof);
    const text = `${JSON.stringify(proof, null, 2)}\n`;
    writeFileSync(proofPath, text);
    overwriteSourcePlan(staged, {
      ...frozen,
      prefetch_resolution: { ...frozen.prefetch_resolution, proof_sha256: digest(text) },
    });
    refused();
    writeFileSync(proofPath, proofBytes);
    overwriteSourcePlan(staged, frozen);
  }
  for (const file of ["proof.json", "101.page.html", "001.capture.txt"]) {
    const path = join(root, file);
    const detached = join(context.root, `detached-${file}`);
    renameSync(path, detached);
    symlinkSync(detached, path);
    refused();
    rmSync(path);
    renameSync(detached, path);
  }
  const detached = join(context.root, "detached-source-plan");
  renameSync(root, detached);
  symlinkSync(detached, root);
  refused();
  rmSync(root);
  renameSync(detached, root);
  assert.equal(verifySourceBatch(context, staged, fixture).status, "pass");
});

test("current-set proof clocks reject fresh final facts and publication never overwrites a partial batch", (t) => {
  const scenario = recollectionPlanningScenario(t);
  const { context, fixture, prefetch, asOf } = scenario;
  const staged = publishedPrefetchBatch(scenario, "current-proof-clocks");
  const frozen = structuredClone(staged.plan);
  const root = join(staged.dir, "source-plan");
  const path = join(root, "001.capture.txt");
  const bytes = readFileSync(path);
  const proofPath = join(root, "proof.json");
  const proofBytes = readFileSync(proofPath);
  const ledgerBytes = readFileSync(context.path);
  for (const clock of ["2026-10-09T09:00:01Z", "2026-10-09T08:59:00", "not-a-clock"]) {
    const text = bytes.toString("utf8").replace(/(# fetched-at: )[^\n]+/u, `$1${clock}`);
    assert.notEqual(text, bytes.toString("utf8"));
    writeFileSync(path, text);
    const proof = JSON.parse(proofBytes);
    Object.assign(
      proof.files.find((file) => file.file === "001.capture.txt"),
      { sha256: digest(text), bytes: Buffer.byteLength(text) },
    );
    const proofText = `${JSON.stringify(proof, null, 2)}\n`;
    writeFileSync(proofPath, proofText);
    overwriteSourcePlan(staged, {
      ...frozen,
      prefetch_resolution: { ...frozen.prefetch_resolution, proof_sha256: digest(proofText) },
    });
    for (const cadence of ["per-batch", "full"])
      assert.ok(
        verifySourceBatch(context, staged, fixture, cadence).findingCodes.includes(
          "source_plan_uncorroborated",
        ),
      );
    assert.equal(
      errorCode(() => recordSource(context.path, staged)),
      "triage_ledger_source_plan_prefetch_invalid",
    );
    assert.deepEqual(readFileSync(context.path), ledgerBytes);
  }
  writeFileSync(path, bytes);
  writeFileSync(proofPath, proofBytes);
  overwriteSourcePlan(staged, frozen);
  const before = sourceArtifactBytes(staged.dir);
  const options = {
    asOf,
    resolution: prefetch.resolution,
    collectionText: fixture.collectionText,
    captureRoot: prefetch.dir,
    artifactsDir: staged.dir,
  };
  assert.equal(
    errorCode(() => ledgerSourceApi.publishSourcePlan(context.path, fixture.sourceSet, options)),
    "triage_ledger_source_plan_prefetch_invalid",
  );
  assert.deepEqual(sourceArtifactBytes(staged.dir), before);

  const partial = join(context.store, "current-proof-partial");
  mkdirSync(partial);
  mkdirSync(join(partial, "source-plan"));
  writeFileSync(join(partial, "source-plan", "proof.json"), "{ unknown outcome");
  const partialBefore = sourceArtifactBytes(partial);
  assert.equal(
    errorCode(() =>
      ledgerSourceApi.publishSourcePlan(context.path, fixture.sourceSet, {
        ...options,
        artifactsDir: partial,
      }),
    ),
    "triage_ledger_source_plan_prefetch_invalid",
  );
  assert.deepEqual(sourceArtifactBytes(partial), partialBefore);
  assert.equal(existsSync(join(partial, "plan.json")), false);

  const future = join(context.store, "current-proof-future");
  mkdirSync(future);
  const prefetchedCapture = join(prefetch.dir, "001.capture.txt");
  const original = readFileSync(prefetchedCapture);
  writeFileSync(
    prefetchedCapture,
    original.toString("utf8").replace(/(# fetched-at: )[^\n]+/u, "$12026-10-09T09:00:01Z"),
  );
  assert.equal(
    errorCode(() =>
      ledgerSourceApi.publishSourcePlan(context.path, fixture.sourceSet, {
        ...options,
        artifactsDir: future,
      }),
    ),
    "triage_ledger_source_plan_prefetch_invalid",
  );
  assert.deepEqual(readdirSync(future), []);
  writeFileSync(prefetchedCapture, original);
  const old = join(context.store, "current-proof-indexed-parent");
  mkdirSync(old);
  assert.equal(
    errorCode(() =>
      ledgerSourceApi.publishSourcePlan(context.path, scenario.originalFixture.sourceSet, {
        asOf,
        resolution: scenario.original.resolution,
        collectionText: scenario.originalFixture.collectionText,
        captureRoot: scenario.original.dir,
        artifactsDir: old,
      }),
    ),
    "triage_ledger_source_plan_prefetch_invalid",
  );
  assert.deepEqual(readdirSync(old), []);
  assert.deepEqual(readFileSync(context.path), ledgerBytes);
});

test("prefetch publication refuses an index move instead of replacing its original frozen baseline", (t) => {
  const scenario = recollectionPlanningScenario(t);
  const { context, fixture, prefetch, asOf } = scenario;
  const dir = join(context.store, "current-proof-concurrent-index");
  mkdirSync(dir);
  const originalWrite = fs.writeFileSync;
  let moved = false;
  fs.writeFileSync = function (path, ...args) {
    const result = originalWrite.call(this, path, ...args);
    if (!moved && path === join(dir, "source-plan", "proof.json")) {
      moved = true;
      ledgerSourceApi.withLedgerLock(context.path, (ledger) => ({
        ledger: {
          ...ledger,
          logical_entries: ledger.logical_entries.map((entry) => ({
            ...entry,
            last_checked: "2026-10-09T09:00:01Z",
            decision: "BLOCKED",
          })),
        },
      }));
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    assert.equal(
      errorCode(() =>
        ledgerSourceApi.publishSourcePlan(context.path, fixture.sourceSet, {
          asOf,
          resolution: prefetch.resolution,
          collectionText: fixture.collectionText,
          captureRoot: prefetch.dir,
          artifactsDir: dir,
        }),
      ),
      "triage_ledger_concurrent_observation",
    );
  } finally {
    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
  }
  assert.equal(moved, true);
  assert.equal(existsSync(join(dir, "plan.json")), false);
  assert.equal(
    existsSync(join(dir, "source-plan", "proof.json")),
    true,
    "partial proof is retained",
  );
  assert.equal(existsSync(join(dir, "ledger-record.json")), false);
  assert.equal(readLedger(context.path).logical_entries[0].decision, "BLOCKED");
  assert.equal(existsSync(`${context.path}.lock`), false);
});

function indexedPriorRecorderScenario(t) {
  const context = sourceLedger(t);
  const details = "https://jobs.acme.example/vacancy/1101";
  const fixture = combinedSourceFixture(
    fictionalSourceSet({ postId: 1101, details }),
    fictionalSourceSet({ postId: 1102, details }),
  );
  const original = sourceBatchDir(context, fixture, "recorder-prior-seed", {
    ...linkedSourceObservations(fixture),
    prefetchPlan: true,
  });
  sourceFullEvidence(original, sourceInstant);
  for (const cadence of ["per-batch", "full"])
    assert.equal(verifySourceBatch(context, original, fixture, cadence).status, "pass");
  recordSource(context.path, original);
  const asOf = "2026-10-09T09:00:00Z";
  const frozen = ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, {
    asOf,
    resolution: original.resolution,
    collectionText: fixture.collectionText,
    captureRoot: original.dir,
  });
  assert.equal(frozen.items[0].action, "skip_known");
  assert.ok(frozen.prior_resolution);
  const changed = linkedSourceObservations(fixture);
  changed.observations = changed.observations.map((raw) => {
    const title = raw.source_ref === details ? "Junior QA Engineer" : fixture.title;
    if (raw.source_ref === details) {
      const card = fixture.sourceSet.cards.find((item) => item.card_ref === raw.card_ref);
      const body = `${title}\nCompany: Acme\nManual testing and Java.`;
      const capture = { file: raw.capture.file, sha256: digest(body) };
      const at = changed.captures.findIndex(([file]) => file === capture.file);
      changed.captures[at] = [
        capture.file,
        renderCaptureFile({
          body,
          header: {
            index: Number(capture.file.slice(0, 3)),
            adapter: "fictional",
            "source-id": "url",
            "requested-url": details,
            "final-url": details,
            "fetched-at": "2026-10-09T09:10:00Z",
            "http-status": 200,
            outcome: "active",
            "normalized-sha256": digest(body),
            "body-bytes": Buffer.byteLength(body),
            normalization: "none",
          },
        }),
      ];
      raw = sourceObservation(fixture, card, {
        inputIndex: raw.input.inputIndex,
        sourceRef: details,
        body,
        capture,
        jobTitle: title,
      });
    }
    raw.facts.seniority = {
      value: title.startsWith("Junior") ? "Junior" : "Senior",
      evidence_quote: title,
    };
    return raw;
  });
  const refresh = sourceBatchDir(context, fixture, "recorder-prior-conflict", {
    ...changed,
    observedAt: "2026-10-09T09:20:00Z",
    prefetchPlan: true,
  });
  overwriteSourcePlan(refresh, frozen);
  sourceFullEvidence(refresh, refresh.payload.observed_at);
  assert.equal(refresh.resolution.groups[0].result.review_code, "source_review");
  for (const cadence of ["per-batch", "full"])
    assert.equal(verifySourceBatch(context, refresh, fixture, cadence).status, "pass");
  return { context, fixture, original, refresh, frozen, asOf };
}

test("the source recorder rechecks indexed-prior plan custody after PASS and on indexed replay", (t) => {
  const { context, fixture, original, refresh } = indexedPriorRecorderScenario(t);
  const parentPath = join(original.dir, "ledger-record.json");
  const retained = join(context.root, "prior-record-retained.json");
  const ledgerBytes = readFileSync(context.path);
  const batchBytes = sourceArtifactBytes(refresh.dir);
  renameSync(parentPath, retained);
  for (const cadence of ["per-batch", "full"])
    assert.ok(
      verifySourceBatch(context, refresh, fixture, cadence).findingCodes.includes(
        "source_plan_uncorroborated",
      ),
    );
  assert.equal(
    errorCode(() => recordSource(context.path, refresh)),
    "triage_ledger_source_plan_prior_invalid",
  );
  assert.deepEqual(readFileSync(context.path), ledgerBytes);
  assert.deepEqual(sourceArtifactBytes(refresh.dir), batchBytes);
  assert.equal(existsSync(join(refresh.dir, "ledger-record.json")), false);
  renameSync(retained, parentPath);
  const parentBytes = readFileSync(parentPath);
  writeFileSync(parentPath, `${parentBytes.toString("utf8")} `);
  assert.equal(
    errorCode(() => recordSource(context.path, refresh)),
    "triage_ledger_source_plan_prior_invalid",
  );
  assert.deepEqual(readFileSync(context.path), ledgerBytes);
  assert.equal(existsSync(join(refresh.dir, "ledger-record.json")), false);
  writeFileSync(parentPath, parentBytes);
  renameSync(parentPath, retained);
  symlinkSync(retained, parentPath);
  assert.equal(
    errorCode(() => recordSource(context.path, refresh)),
    "triage_ledger_source_plan_prior_invalid",
  );
  assert.deepEqual(readFileSync(context.path), ledgerBytes);
  rmSync(parentPath);
  renameSync(retained, parentPath);
  const indexed = structuredClone(readLedger(context.path).batches);
  for (const mutate of [
    (batches) => batches.filter((batch) => batch.batch_id !== original.payload.batch_id),
    (batches) => {
      batches[0].entries_digest = "0".repeat(64);
      return batches;
    },
    (batches) => {
      batches[0].entry_count++;
      return batches;
    },
    (batches) => {
      batches[0].recorded_at = "2026-10-08T09:00:01Z";
      return batches;
    },
    (batches) => {
      batches[0].policy_id = "other-policy";
      return batches;
    },
    ...["source_set_sha256", "source_resolution_sha256", "plan_sha256"].map((key) => (batches) => {
      batches[0][key] = "0".repeat(64);
      return batches;
    }),
  ]) {
    ledgerSourceApi.withLedgerLock(context.path, (ledger) => ({
      ledger: { ...ledger, batches: mutate(structuredClone(indexed)) },
    }));
    const movedIndex = readFileSync(context.path);
    assert.equal(
      errorCode(() => recordSource(context.path, refresh)),
      "triage_ledger_source_plan_prior_invalid",
    );
    assert.deepEqual(readFileSync(context.path), movedIndex);
    assert.equal(existsSync(join(refresh.dir, "ledger-record.json")), false);
    ledgerSourceApi.withLedgerLock(context.path, (ledger) => ({
      ledger: { ...ledger, batches: indexed },
    }));
  }
  assert.deepEqual(readFileSync(context.path), ledgerBytes);
  recordSource(context.path, refresh);
  const recorded = readFileSync(context.path);
  const archived = readFileSync(join(refresh.dir, "ledger-record.json"));
  renameSync(parentPath, retained);
  assert.equal(
    errorCode(() => recordSource(context.path, refresh)),
    "triage_ledger_source_plan_prior_invalid",
  );
  assert.deepEqual(readFileSync(context.path), recorded);
  assert.deepEqual(readFileSync(join(refresh.dir, "ledger-record.json")), archived);
  renameSync(retained, parentPath);
  assert.equal(recordSource(context.path, refresh).replayed, true);
  assert.deepEqual(readFileSync(context.path), recorded);
});

test("source recording refuses a removed necessary prior ref and closed-reference or action claims before archive", (t) => {
  const { context, fixture, refresh, frozen } = indexedPriorRecorderScenario(t);
  const ledgerBytes = readFileSync(context.path);
  for (const mutate of [
    (plan) => {
      delete plan.prior_resolution;
    },
    (plan) => {
      plan.prior_resolution.entries_digest = "0".repeat(64);
    },
    (plan) => {
      plan.prior_resolution.record_sha256 = "0".repeat(64);
    },
    (plan) => {
      plan.prior_resolution.source_set_sha256 = "0".repeat(64);
    },
    (plan) => {
      plan.prior_resolution.source_resolution_sha256 = "0".repeat(64);
    },
    (plan) => {
      plan.prior_resolution.batch_id = "../recorder-prior-seed";
    },
    (plan) => {
      plan.prior_resolution.batch_id = "missing-prior";
    },
    (plan) => {
      plan.prior_resolution.path = refresh.dir;
    },
    (plan) => {
      plan.items[0].action = "skip_closed";
    },
    (plan) => {
      plan.items[0].sources.find((source) => source.role === "details").action = "skip_closed";
    },
    (plan) => {
      plan.items[0].baseline.last_checked = frozen.as_of;
    },
  ]) {
    const fake = structuredClone(frozen);
    mutate(fake);
    overwriteSourcePlan(refresh, fake);
    for (const cadence of ["per-batch", "full"])
      assert.notEqual(verifySourceBatch(context, refresh, fixture, cadence).status, "pass");
    assert.notEqual(
      errorCode(() => recordSource(context.path, refresh)),
      null,
    );
    assert.deepEqual(readFileSync(context.path), ledgerBytes);
    assert.equal(existsSync(join(refresh.dir, "ledger-record.json")), false);
  }
  overwriteSourcePlan(refresh, frozen);
  assert.equal(recordSource(context.path, refresh).record.written, true);
});

test("planning proof custody is rechecked under the recorder lock for first writes and replay", (t) => {
  for (const kind of ["prior", "prefetch"]) {
    const scenario =
      kind === "prior" ? indexedPriorRecorderScenario(t) : recollectionPlanningScenario(t);
    const { context } = scenario;
    const staged =
      kind === "prior"
        ? scenario.refresh
        : publishedPrefetchBatch(scenario, "locked-prefetch-proof");
    const proofPath =
      kind === "prior"
        ? join(scenario.original.dir, "ledger-record.json")
        : join(staged.dir, "source-plan", "proof.json");
    const retained = join(context.root, `locked-${kind}-retained.json`);
    for (const phase of ["first", "indexed replay"]) {
      const ledgerBytes = readFileSync(context.path);
      const batchBytes = sourceArtifactBytes(staged.dir);
      const originalMkdir = fs.mkdirSync;
      let moved = false;
      fs.mkdirSync = function (path, ...args) {
        const result = originalMkdir.call(this, path, ...args);
        if (!moved && path === `${context.path}.lock`) {
          moved = true;
          renameSync(proofPath, retained);
        }
        return result;
      };
      syncBuiltinESMExports();
      try {
        assert.equal(
          errorCode(() => recordSource(context.path, staged)),
          kind === "prior"
            ? "triage_ledger_source_plan_prior_invalid"
            : "triage_ledger_source_plan_prefetch_invalid",
          `${kind}: ${phase}`,
        );
      } finally {
        fs.mkdirSync = originalMkdir;
        syncBuiltinESMExports();
        if (moved) renameSync(retained, proofPath);
      }
      assert.equal(moved, true);
      assert.deepEqual(readFileSync(context.path), ledgerBytes);
      assert.deepEqual(sourceArtifactBytes(staged.dir), batchBytes);
      const result = recordSource(context.path, staged);
      assert.equal(result.replayed, phase === "indexed replay");
    }
  }
});

test("equivalent plain plans, unrelated writers and later orphan observations keep their recording contract", (t) => {
  const { context, fixture, original, refresh, frozen, asOf } = indexedPriorRecorderScenario(t);
  const stable = sourceBatchDir(context, fixture, "recorder-plain-equivalent", {
    ...linkedSourceObservations(fixture),
    observedAt: "2026-10-09T09:30:00Z",
    prefetchPlan: true,
  });
  const plain = structuredClone(frozen);
  delete plain.prior_resolution;
  overwriteSourcePlan(stable, plain);
  sourceFullEvidence(stable, asOf);
  for (const cadence of ["per-batch", "full"]) {
    const report = verifySourceBatch(context, stable, fixture, cadence);
    assert.equal(report.status, "pass", `${cadence}: ${report.findingCodes.join(",")}`);
  }
  const otherFixture = fictionalSourceSet({
    postId: 1201,
    homepage: "https://beta.example/",
    company: "Beta",
  });
  const unrelated = sourceBatchDir(context, otherFixture, "recorder-unrelated-first", {
    prefetchPlan: true,
    observedAt: asOf,
  });
  recordSource(context.path, unrelated);
  const unrelatedRow = structuredClone(
    readLedger(context.path).logical_entries.find(
      (entry) => entry.batch_id === unrelated.payload.batch_id,
    ),
  );
  assert.equal(recordSource(context.path, refresh).record.written, true);
  const conflictRecord = readFileSync(join(refresh.dir, "ledger-record.json"));
  const later = sourceBatchDir(context, fixture, "recorder-later-plain", {
    ...linkedSourceObservations(fixture),
    observedAt: "2026-10-10T09:00:00Z",
  });
  recordSource(context.path, later);
  const laterRow = structuredClone(
    readLedger(context.path).logical_entries.find(
      (entry) => entry.batch_id === later.payload.batch_id,
    ),
  );
  assert.equal(recordSource(context.path, refresh).replayed, true);
  assert.deepEqual(readFileSync(join(refresh.dir, "ledger-record.json")), conflictRecord);
  ledgerSourceApi.withLedgerLock(context.path, (ledger) => ({
    ledger: {
      ...ledger,
      batches: ledger.batches.filter((batch) => batch.batch_id !== refresh.payload.batch_id),
    },
  }));
  const parentPath = join(original.dir, "ledger-record.json");
  const retained = join(context.root, "orphan-prior-retained.json");
  renameSync(parentPath, retained);
  const before = readFileSync(context.path);
  assert.equal(
    errorCode(() => recordSource(context.path, refresh)),
    "triage_ledger_source_plan_prior_invalid",
  );
  assert.deepEqual(readFileSync(context.path), before);
  assert.deepEqual(readFileSync(join(refresh.dir, "ledger-record.json")), conflictRecord);
  renameSync(retained, parentPath);
  assert.equal(recordSource(context.path, refresh).replayed, false);
  assert.deepEqual(
    readLedger(context.path).logical_entries.find((entry) => entry.key === laterRow.key),
    laterRow,
  );
  assert.deepEqual(
    readLedger(context.path).logical_entries.find((entry) => entry.key === unrelatedRow.key),
    unrelatedRow,
  );
  assert.deepEqual(readFileSync(join(refresh.dir, "ledger-record.json")), conflictRecord);
  const plainContext = sourceLedger(t);
  const seed = sourceBatchDir(plainContext, fixture, "plain-seed", {
    ...linkedSourceObservations(fixture),
    prefetchPlan: true,
  });
  recordSource(plainContext.path, seed);
  const ordinary = sourceBatchDir(plainContext, fixture, "plain-refresh", {
    ...linkedSourceObservations(fixture),
    observedAt: "2026-10-09T09:30:00Z",
  });
  const equivalent = ledgerSourceApi.planSourceBatch(plainContext.path, fixture.sourceSet, {
    asOf,
    resolution: seed.resolution,
    collectionText: fixture.collectionText,
    captureRoot: seed.dir,
  });
  delete equivalent.prior_resolution;
  overwriteSourcePlan(ordinary, equivalent);
  assert.equal(Object.hasOwn(equivalent, "prior_resolution"), false);
  assert.equal(recordSource(plainContext.path, ordinary).record.written, true);
  assert.equal(recordSource(plainContext.path, ordinary).replayed, true);
});
