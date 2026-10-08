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
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
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
  } = {},
) {
  const dir = join(context.store, batchId);
  mkdirSync(dir);
  writeFileSync(join(dir, fixture.sourceSet.snapshots[0].capture.file), fixture.html);
  for (const [file, bytes] of captures) writeFileSync(join(dir, file), bytes);
  const resolution = publishSourceResolution({
    artifactsDir: dir,
    sourceSet: fixture.sourceSet,
    collectionText: fixture.collectionText,
    observations: observations ?? [sourceObservation(fixture)],
    selection: sourceSelection,
  });
  const plan = ledgerSourceApi.planSourceBatch(context.path, fixture.sourceSet, {
    asOf: observedAt,
    collectionText: fixture.collectionText,
    ...(planResolution !== undefined
      ? { resolution: planResolution, captureRoot: dir }
      : prefetchPlan
        ? {}
        : { resolution }),
  });
  const planText = `${JSON.stringify(plan, null, 2)}\n`;
  writeFileSync(join(dir, "plan.json"), planText);
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

function detailsObservation(fixture) {
  const sourceRef = fixture.sourceSet.cards[0].links.find((link) => link.role === "details").url;
  const body = `${fixture.title}\nCompany: ${fixture.company}\nManual testing and Java.`;
  const capture = { file: "001.capture.txt", sha256: digest(body) };
  const raw = sourceObservation(fixture, undefined, { sourceRef, body, capture });
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
      const body = `${title}\nCompany: ${fixture.company}\nManual testing and Java.`;
      const file = `${String(captureIndex).padStart(3, "0")}.capture.txt`;
      const raw = sourceObservation(fixture, card, {
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
          },
        }),
      ]);
    }
  }
  return { observations, captures };
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
  const external = detailsObservation(fixture);
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

test("a different target identity can record a new derived group from a complete initial card plan", (t) => {
  const context = sourceLedger(t);
  const fixture = fictionalSourceSet({ details: "https://jobs.acme.example/vacancy/91" });
  const observation = detailsObservation(fixture);
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
  const later = structuredClone(readLedger(context.path).entries[0]);
  ledgerSourceApi.correctSourceObservations(context.path, staged.payload, {
    artifactsDir: staged.dir,
  });
  assert.deepEqual(readLedger(context.path).entries[0], later);
  assert.equal(readLedger(context.path).corrections.length, 1);
  assert.equal(reviewLedger(readLedger(context.path), { asOf: sourceInstant }).totals.entries, 1);
  assert.equal(readLedger(context.path).logical_entries.length, 0);
});
