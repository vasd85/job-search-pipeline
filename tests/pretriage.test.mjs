// Pre-triage stage: collection freshness, the liveness sweep, the composition report and the
// spend accounting that ties them together.
//
// Every expectation is a frozen literal. Nothing here reads a bound, a class or a vocabulary back
// out of the module it is checking, because a test that asks the code what it should say cannot
// disagree with it. Files are written only inside a disposable root.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assessCollection,
  collectionInstant,
  collectionStaleAfterDays,
  orderNewestFirst,
} from "../tools/pretriage/freshness.mjs";
import { parseCollectionHeader, readCollection } from "../tools/pretriage/collection.mjs";
import {
  classifyLiveness,
  goneScorerSource,
  sweepFromManifest,
} from "../tools/pretriage/liveness.mjs";
import { manifestSchemaVersion } from "../tools/vacancy-fetch/batch.mjs";
import {
  composeBatch,
  priorityClassFor,
  priorityClassForLedger,
} from "../tools/pretriage/composition.mjs";
import { applyLivenessSweep, planPreTriage } from "../tools/pretriage/plan.mjs";
import { renderCompositionReport, renderPreTriagePlan } from "../tools/pretriage/report.mjs";
import { buildDecisionTrace } from "../tools/job-scorer/trace.mjs";
import { candidateExampleRootFor, candidateScoringValues } from "../tools/candidate/load.mjs";
import { candidatePrioritiesFrom } from "../tools/candidate/priorities.mjs";
import { initLedger, planBatch, readLedger, recordBatch } from "../tools/lib/triage-ledger-core.mjs";
import { claimGroup, collectionGroup, groupBatchId, splitCollection } from "../tools/pretriage/groups.mjs";
import { sliceRange } from "../tools/triage-verify/links.mjs";

// Frozen literals. The window is the runbook's standard cadence today; the test states the number
// itself so splitting the two becomes a deliberate edit rather than a silent consequence.
const EXPECTED_STALE_AFTER_DAYS = 7;
const LINK_ONE = "https://www.linkedin.com/jobs/view/4418544694/";
const LINK_TWO = "https://www.linkedin.com/jobs/view/4449892212/";
const LINK_THREE = "https://www.linkedin.com/jobs/view/4455248338/";

function disposableRoot(t, prefix = "pretriage-") {
  const root = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

function manifestRecord(overrides = {}) {
  return {
    index: 1,
    requestedUrl: LINK_ONE,
    finalUrl: LINK_ONE,
    outcome: "active",
    accessBarrier: null,
    httpStatus: 200,
    reasons: [],
    usable: true,
    skipped: false,
    ...overrides,
  };
}

function manifest(records) {
  return { schemaVersion: 1, tool: "vacancy-fetch", records };
}

function ledgerPlan(actions) {
  return {
    items: actions.map((action, position) => ({
      input_index: position + 1,
      action,
      reason: action === null ? "triage_ledger_invalid_url" : `${action} reason`,
    })),
  };
}

function collectionOf(urls, extra = {}) {
  return {
    collected_at: null,
    declared_order: null,
    links: urls.map((url, position) => ({ line: position + 1, url, normalizedUrl: url })),
    ...extra,
  };
}

// ---------------------------------------------------------------- freshness

// The window is the collection's own number, owned by the review runbook docs/runbooks/triage-review.md#21-pre-triage-freshness-order-composition; this literal is
// what makes a change of it a deliberate decision.
test("the staleness window is seven days", () => {
  assert.equal(collectionStaleAfterDays, EXPECTED_STALE_AFTER_DAYS);
});

test("a date-only collection stamp is read as midnight UTC", () => {
  assert.equal(collectionInstant("2026-08-17"), Date.parse("2026-08-17T00:00:00Z"));
});

test("a zoned instant is accepted and a zone-less date-time is not", () => {
  assert.equal(collectionInstant("2026-08-17T09:15:00Z"), Date.parse("2026-08-17T09:15:00Z"));
  assert.equal(collectionInstant("2026-08-17T09:15:00"), null);
});

test("a date the calendar does not have is refused rather than rolled forward", () => {
  assert.equal(collectionInstant("2026-02-30"), null);
  assert.equal(collectionInstant("2026-13-01"), null);
});

test("a non-string collection stamp denotes no instant", () => {
  assert.equal(collectionInstant(null), null);
  assert.equal(collectionInstant(20260817), null);
  assert.equal(collectionInstant(""), null);
});

test("a collection inside the window is fresh and needs no sweep", () => {
  const assessed = assessCollection({ collectedAt: "2026-08-17", asOf: "2026-08-23T00:00:00Z" });
  assert.equal(assessed.state, "fresh");
  assert.equal(assessed.sweep_required, false);
  assert.equal(assessed.age_days, 6);
  assert.equal(assessed.stale_after_days, 7);
});

test("a collection exactly one window old is already stale", () => {
  const assessed = assessCollection({ collectedAt: "2026-08-16", asOf: "2026-08-23T00:00:00Z" });
  assert.equal(assessed.state, "stale");
  assert.equal(assessed.sweep_required, true);
  assert.equal(assessed.age_days, 7);
});

test("an undated collection is not fresh and is swept", () => {
  const assessed = assessCollection({ asOf: "2026-08-23T00:00:00Z" });
  assert.deepEqual(assessed, {
    collected_at: null,
    as_of: "2026-08-23T00:00:00Z",
    age_days: null,
    state: "undated",
    stale_after_days: 7,
    sweep_required: true,
  });
});

test("a custom staleness window is honoured", () => {
  const assessed = assessCollection({
    collectedAt: "2026-08-21",
    asOf: "2026-08-23T00:00:00Z",
    staleAfterDays: 2,
  });
  assert.equal(assessed.state, "stale");
});

test("a collection dated well after the batch is a loud caller error", () => {
  assert.throws(
    () => assessCollection({ collectedAt: "2026-08-25", asOf: "2026-08-23T00:00:00Z" }),
    (error) => error.code === "pretriage_collection_ahead_of_batch",
  );
  assert.throws(
    () => assessCollection({ collectedAt: "2026-08-23T01:00:00Z", asOf: "2026-08-23T00:00:00Z" }),
    (error) => error.code === "pretriage_collection_ahead_of_batch",
  );
});

test("a local date one day ahead of UTC is an ordinary input, not a stop", () => {
  // 01:00 in Tbilisi on the 24th is 21:00 UTC on the 23rd; the operator writes their own date.
  const assessed = assessCollection({ collectedAt: "2026-08-24", asOf: "2026-08-23T21:00:00Z" });
  assert.equal(assessed.state, "fresh");
  assert.equal(assessed.age_days, 0);
});

test("the batch instant may not be a bare date", () => {
  // Midnight is the earliest instant a date can mean, which shrinks every age it is used in.
  assert.throws(
    () => assessCollection({ collectedAt: "2026-08-01", asOf: "2026-08-23" }),
    (error) => error.code === "pretriage_invalid_instant",
  );
});

test("an age is reported to the thousandth of a day, not rounded to whole days", () => {
  const assessed = assessCollection({
    collectedAt: "2026-08-22T12:00:00Z",
    asOf: "2026-08-23T00:00:00Z",
  });
  assert.equal(assessed.age_days, 0.5);
});

test("an unreadable collection date is louder than an absent one", () => {
  assert.throws(
    () => assessCollection({ collectedAt: "last tuesday", asOf: "2026-08-23T00:00:00Z" }),
    (error) => error.code === "pretriage_invalid_instant",
  );
});

test("an unreadable batch instant is refused", () => {
  assert.throws(
    () => assessCollection({ asOf: "2026-08-23T00:00:00" }),
    (error) => error.code === "pretriage_invalid_instant",
  );
});

test("a non-positive staleness window is refused", () => {
  assert.throws(
    () => assessCollection({ asOf: "2026-08-23T00:00:00Z", staleAfterDays: 0 }),
    (error) => error.code === "pretriage_invalid_window",
  );
});

test("a fully dated collection is ordered newest first and ties keep input order", () => {
  const ordered = orderNewestFirst([
    { url: LINK_ONE, posted_at: "2026-08-20T00:00:00Z" },
    { url: LINK_TWO, posted_at: "2026-08-22T00:00:00Z" },
    { url: LINK_THREE, posted_at: "2026-08-22T00:00:00Z" },
  ]);
  assert.equal(ordered.basis, "posted_at");
  assert.deepEqual(ordered.links.map((entry) => entry.url), [LINK_TWO, LINK_THREE, LINK_ONE]);
});

test("one undated link stops the sort and the basis says so", () => {
  const ordered = orderNewestFirst([
    { url: LINK_ONE, posted_at: "2026-08-20T00:00:00Z" },
    { url: LINK_TWO },
  ]);
  assert.equal(ordered.basis, "input_order");
  assert.deepEqual(ordered.links.map((entry) => entry.url), [LINK_ONE, LINK_TWO]);
});

test("an operator's declared order is reported as a claim, not as a sort", () => {
  const ordered = orderNewestFirst([{ url: LINK_ONE }], { declaredOrder: "newest-first" });
  assert.equal(ordered.basis, "declared_newest_first");
});

test("an empty collection is not reported as sorted by posting date", () => {
  assert.equal(orderNewestFirst([]).basis, "input_order");
});

// --------------------------------------------------------------- collection

test("the header carries the collection date and the declared order", () => {
  assert.deepEqual(
    parseCollectionHeader("# collected: 2026-08-17\n# order: newest-first\nhttps://example.com/a"),
    { collected_at: "2026-08-17", declared_order: "newest-first" },
  );
});

test("a comment after the first link cannot date the collection", () => {
  assert.deepEqual(
    parseCollectionHeader("https://example.com/a\n# collected: 2026-08-17"),
    { collected_at: null, declared_order: null },
  );
});

test("a file with no header reports both facts absent", () => {
  assert.deepEqual(
    parseCollectionHeader("https://example.com/a"),
    { collected_at: null, declared_order: null },
  );
});

test("a header key stated twice is a caller error", () => {
  assert.throws(
    () => parseCollectionHeader("# collected: 2026-08-17\n# collected: 2026-08-18\n"),
    (error) => error.code === "pretriage_duplicate_header",
  );
});

test("an order the stage does not recognize is refused, never defaulted", () => {
  assert.throws(
    () => parseCollectionHeader("# order: oldest-first\n"),
    (error) => error.code === "pretriage_unknown_order",
  );
});

test("an unreadable date in the header is refused at read time", () => {
  assert.throws(
    () => parseCollectionHeader("# collected: yesterday\n"),
    (error) => error.code === "pretriage_invalid_instant",
  );
});

test("a links file is read as one collection, header and list together", (t) => {
  const path = join(disposableRoot(t), "links.txt");
  writeFileSync(
    path,
    `# collected: 2026-08-17\n# order: newest-first\n# a note of the operator's own\n${LINK_ONE}\n\n${LINK_TWO}\n${LINK_ONE}\n`,
    "utf8",
  );
  const collection = readCollection(path);
  assert.equal(collection.collected_at, "2026-08-17");
  assert.equal(collection.declared_order, "newest-first");
  assert.deepEqual(collection.links.map((entry) => entry.url), [LINK_ONE, LINK_TWO]);
});

// ----------------------------------------------------------------- liveness

test("a manifest is read into bounded liveness observations", () => {
  const observations = sweepFromManifest(manifest([
    manifestRecord(),
    manifestRecord({ index: 2, requestedUrl: LINK_TWO, outcome: "closed", finalUrl: LINK_TWO }),
  ]));
  assert.equal(observations.length, 2);
  assert.deepEqual(observations[1], {
    index: 2,
    url: LINK_TWO,
    final_url: LINK_TWO,
    outcome: "closed",
    access_barrier: null,
    http_status: 200,
    reasons: [],
    usable: true,
    skipped: false,
  });
});

test("a manifest that is not a vacancy-fetch manifest of a known version is refused", () => {
  for (const value of [null, [], { schemaVersion: 3, tool: "vacancy-fetch", records: [] }, { schemaVersion: 1, tool: "other", records: [] }, { schemaVersion: 1, tool: "vacancy-fetch" }]) {
    assert.throws(
      () => sweepFromManifest(value),
      (error) => error.code === "pretriage_manifest_unrecognized",
    );
  }
});

// Version 2 is the shape the promoted tool writes; version 1 is what every batch captured before
// the promotion left behind. Both are read the same way here, because this module consumes
// `records` and nothing the rename touched. The accepted set is one frozen literal, exercised by
// the loop and compared against the tool's own constant: a future bump that forgets this reader
// reds here instead of dying on the first real batch, which is how the version-2 bump was nearly
// shipped broken, and widening the set to silence it also sweeps at the new version.
const ACCEPTED_MANIFEST_VERSIONS = Object.freeze([1, 2]);

test("both manifest versions sweep, and a bump that outruns this reader reds here", () => {
  const records = [manifestRecord()];
  for (const schemaVersion of ACCEPTED_MANIFEST_VERSIONS) {
    const observations = sweepFromManifest({ schemaVersion, tool: "vacancy-fetch", records });
    assert.equal(observations.length, 1);
    assert.equal(observations[0].outcome, "active");
    assert.equal(observations[0].usable, true);
  }
  assert.ok(
    ACCEPTED_MANIFEST_VERSIONS.includes(manifestSchemaVersion),
    `the fetch layer writes schemaVersion ${manifestSchemaVersion}, which this reader refuses`,
  );
});

test("a manifest record without a usable index or with a repeated one is refused", () => {
  assert.throws(
    () => sweepFromManifest(manifest([manifestRecord({ index: 0 })])),
    (error) => error.code === "pretriage_manifest_record_invalid",
  );
  assert.throws(
    () => sweepFromManifest(manifest([manifestRecord(), manifestRecord()])),
    (error) => error.code === "pretriage_manifest_record_invalid",
  );
});

test("a manifest outcome outside the layer's vocabulary is refused, never guessed", () => {
  assert.throws(
    () => sweepFromManifest(manifest([manifestRecord({ outcome: "gone" })])),
    (error) => error.code === "pretriage_manifest_record_invalid",
  );
});

test("an active usable record opens the expensive lane", () => {
  const classified = classifyLiveness({ index: 1, outcome: "active", usable: true, skipped: false });
  assert.equal(classified.verdict, "live");
  assert.equal(classified.reason, "active_body_usable");
  assert.equal(classified.source, null);
});

test("a closure banner in a page that checked out ends the link without the expensive lane", () => {
  const classified = classifyLiveness({ index: 1, outcome: "closed", usable: true, skipped: false });
  assert.equal(classified.verdict, "gone");
  assert.equal(classified.reason, "closed_banner_observed");
  assert.equal(classified.evidence_required, true);
  assert.deepEqual(classified.source, {
    accessOutcome: "closed",
    accessReason: "closure banner in the fetched page",
  });
});

test("an absent record owes a browser confirmation load before it is terminal", () => {
  const classified = classifyLiveness({ index: 1, outcome: "absent", usable: false, skipped: false });
  assert.equal(classified.verdict, "unresolved");
  assert.equal(classified.reason, "absent_awaiting_confirmation");
});

test("a closure read out of a layout the adapter no longer recognizes is not trusted", () => {
  const classified = classifyLiveness({ index: 1, outcome: "closed", usable: false, skipped: false });
  assert.equal(classified.verdict, "unresolved");
  assert.equal(classified.reason, "structural_checks_failed");
});

test("a technical access failure is never the vacancy's own state", () => {
  const classified = classifyLiveness({
    index: 1,
    outcome: "access_failure",
    usable: false,
    skipped: false,
  });
  assert.equal(classified.verdict, "unresolved");
  assert.equal(classified.reason, "access_failed");
});

test("a link the batch never attempted says nothing about the posting", () => {
  const classified = classifyLiveness({
    index: 1,
    outcome: "access_failure",
    usable: false,
    skipped: true,
  });
  assert.equal(classified.verdict, "unresolved");
  assert.equal(classified.reason, "unattempted");
});

test("a private listing is not expired, removed or closed", () => {
  const classified = classifyLiveness({ index: 1, outcome: "private", usable: true, skipped: false });
  assert.equal(classified.verdict, "unresolved");
  assert.equal(classified.reason, "private_listing_reported");
});

test("an observation outside the vocabulary is refused", () => {
  assert.throws(
    () => classifyLiveness({ index: 1, outcome: "dead", usable: true }),
    (error) => error.code === "pretriage_observation_invalid",
  );
  assert.throws(
    () => classifyLiveness(null),
    (error) => error.code === "pretriage_observation_invalid",
  );
});

test("only a gone verdict yields a terminal source fragment", () => {
  const live = classifyLiveness({ index: 1, outcome: "active", usable: true, skipped: false });
  assert.throws(
    () => goneScorerSource(live, { sourceRef: LINK_ONE, evidenceQuote: "x" }),
    (error) => error.code === "pretriage_not_gone",
  );
});

test("a closed vacancy without its quote is refused rather than passed on", () => {
  const gone = classifyLiveness({ index: 1, outcome: "closed", usable: true, skipped: false });
  assert.throws(
    () => goneScorerSource(gone, { sourceRef: LINK_ONE, evidenceQuote: "   " }),
    (error) => error.code === "pretriage_evidence_missing",
  );
  assert.throws(
    () => goneScorerSource(gone, { sourceRef: "", evidenceQuote: "No longer accepting applications" }),
    (error) => error.code === "pretriage_source_ref_missing",
  );
});

test("a swept-dead link scores as SKIP vacancy_unavailable with no model in the path", () => {
  const gone = classifyLiveness({ index: 1, outcome: "closed", usable: true, skipped: false });
  const source = goneScorerSource(gone, {
    sourceRef: LINK_ONE,
    finalUrl: LINK_ONE,
    evidenceQuote: "No longer accepting applications",
  });
  // The scoring values are the tracked example's: a closed page is skipped before any of them is read.
  const candidateScoring = candidateScoringValues({
    root: candidateExampleRootFor(join(fileURLToPath(import.meta.url), "..", "..")),
  });
  const trace = buildDecisionTrace({
    candidateScoring,
    compensation: null,
    explicitOverride: null,
    fx: null,
    inputIndex: 1,
    offerPairing: "clear",
    offers: [],
    policyId: "triage-policy-v8-2026-10-01",
    role: {
      ai: { product: "unknown", work: "unknown" },
      automation: "unknown",
      domain: "unclear",
      evidence: {
        aiProduct: null, aiWork: null, automation: null, domain: null, language: null, role: null, seniority: null, tools: null,
      },
      family: "unknown",
      language: "unknown",
      observedTools: [],
      observedLanguages: [],
      seniority: "unknown",
    },
    schemaVersion: 9,
    scoringDate: "2026-08-23",
    source,
  });
  assert.equal(trace.decision, "SKIP");
  assert.equal(trace.skip_code, "vacancy_unavailable");
  assert.equal(trace.symptom, "closure banner in the fetched page");
  assert.equal(trace.evidence_quote, "No longer accepting applications");
});

// -------------------------------------------------------------- composition

// A fictional candidate's priorities, spelled out the way the candidate layer spells them: remote
// work for WEST companies ranks first, relocation ranks the whole WEST region and one country
// outside it, and one WEST country is excluded.
function prioritiesOf({
  remote = ["WEST"],
  west = true,
  destinations = ["JP"],
  excluded = ["MT"],
} = {}) {
  return candidatePrioritiesFrom({
    mobility: { excluded_destinations: excluded },
    priorities: { relocation_destinations: destinations, relocation_west: west, remote_company_regions: remote },
  });
}
const ranked = { priorities: prioritiesOf() };
const classOf = (observation, options = ranked) => priorityClassFor(observation, options);
const onSite = (fields) => ({ work_format: "On-site", sponsorship: "available", ...fields });

test("remote for a company of a ranked region is the priority-1 class", () => {
  assert.equal(classOf({ work_format: "Remote", company_region: "WEST" }), "1");
  const home = { priorities: prioritiesOf({ remote: ["HOME"] }) };
  assert.equal(classOf({ work_format: "Remote", company_region: "HOME" }, home), "1");
  assert.equal(classOf({ work_format: "Remote", company_region: "WEST" }, home), "2");
});

test("remote elsewhere is the priority-2 class", () => {
  assert.equal(classOf({ work_format: "Remote", company_region: "OTHER" }), "2");
  assert.equal(classOf({ work_format: "Remote", company_region: "HOME" }), "2");
});

test("remote for a company of unknown region is a class only where the region cannot matter", () => {
  assert.equal(classOf({ work_format: "Remote", company_region: "UNKNOWN" }), "unknown");
  const none = { priorities: prioritiesOf({ remote: [] }) };
  assert.equal(classOf({ work_format: "Remote", company_region: "UNKNOWN" }, none), "2");
  assert.equal(classOf({ work_format: "Remote", company_region: "WEST" }, none), "2");
  const every = { priorities: prioritiesOf({ remote: ["OTHER", "WEST", "HOME"] }) };
  assert.equal(classOf({ work_format: "Remote", company_region: "UNKNOWN" }, every), "1");
});

test("an unobserved work format is unknown, never outside", () => {
  assert.equal(classOf({ work_format: "Unknown", company_region: "WEST" }), "unknown");
});

test("a sponsored relocation to a ranked destination is the priority-3 class", () => {
  assert.equal(classOf(onSite({ company_region: "WEST" })), "3");
  assert.equal(classOf(onSite({ company_region: "OTHER", relocation_destination_code: "JP" })), "3");
  assert.equal(classOf(onSite({ company_region: "WEST", relocation_destination_code: "DE" })), "3");
});

test("a relocation outside the ranked destinations is acceptable but outside the classes", () => {
  assert.equal(classOf(onSite({ company_region: "OTHER", relocation_destination_code: "AE" })), "outside");
  // Without a code a HOME or OTHER company's posting is placed by its region, which ranks nothing.
  assert.equal(classOf(onSite({ company_region: "OTHER" })), "outside");
  assert.equal(classOf(onSite({ company_region: "HOME" })), "outside");
});

test("the destination code decides before the company region", () => {
  // A WEST country with the company's region unobserved: ranked.
  assert.equal(classOf(onSite({ company_region: "UNKNOWN", relocation_destination_code: "DE" })), "3");
  // A WEST company relocating outside the ranked set: not ranked.
  assert.equal(classOf(onSite({ company_region: "WEST", relocation_destination_code: "AE" })), "outside");
  // A country outside the ranked set with the company's region unobserved: not ranked.
  assert.equal(classOf(onSite({ company_region: "UNKNOWN", relocation_destination_code: "AE" })), "outside");
  // A HOME or OTHER company relocating to a WEST country: ranked.
  assert.equal(classOf(onSite({ company_region: "OTHER", relocation_destination_code: "DE" })), "3");
});

test("an excluded destination never ranks, not even as a member of a ranked region", () => {
  for (const company_region of ["WEST", "UNKNOWN", "OTHER"]) {
    assert.equal(classOf(onSite({ company_region, relocation_destination_code: "MT" })), "outside", company_region);
  }
  assert.equal(ranked.priorities.relocationCountries.includes("MT"), false);
  assert.equal(ranked.priorities.relocationCountries.includes("DE"), true);
});

test("without the whole region ranked, a WEST company names nothing a class can use", () => {
  const some = { priorities: prioritiesOf({ west: false, destinations: ["DE", "JP"] }) };
  assert.equal(classOf(onSite({ company_region: "WEST" }), some), "unknown");
  assert.equal(classOf(onSite({ company_region: "WEST", relocation_destination_code: "DE" }), some), "3");
  assert.equal(classOf(onSite({ company_region: "WEST", relocation_destination_code: "FR" }), some), "outside");
  const outsideWest = { priorities: prioritiesOf({ west: false, destinations: ["JP"] }) };
  assert.equal(classOf(onSite({ company_region: "WEST" }), outsideWest), "outside");
  const nothing = { priorities: prioritiesOf({ west: false, destinations: [] }) };
  assert.equal(classOf(onSite({ company_region: "UNKNOWN" }), nothing), "outside");
});

test("silence about sponsorship on a ranked destination is unknown, not class 3", () => {
  assert.equal(classOf({ work_format: "Hybrid", company_region: "WEST", sponsorship: "unknown" }), "unknown");
});

test("a refusal to sponsor puts a ranked destination outside the classes", () => {
  assert.equal(classOf({ work_format: "Hybrid", company_region: "WEST", sponsorship: "unavailable" }), "outside");
});

test("a destination this stage cannot place is unknown rather than guessed", () => {
  assert.equal(classOf(onSite({ company_region: "UNKNOWN" })), "unknown");
});

test("an observation value outside the scorer's vocabulary is refused", () => {
  for (const observation of [
    { work_format: "remote", company_region: "WEST" },
    { work_format: "Remote", company_region: "EU" },
    onSite({ company_region: "OTHER", relocation_destination_code: "jp" }),
    onSite({ company_region: "OTHER", relocation_destination_code: "XK" }),
    onSite({ company_region: "OTHER", relocation_destination_code: 7 }),
    // The field that named the country by name is refused, not silently ignored.
    onSite({ company_region: "OTHER", relocation_destination: "Japan" }),
  ]) {
    assert.throws(
      () => classOf(observation),
      (error) => error.code === "pretriage_observation_invalid",
      JSON.stringify(observation),
    );
  }
});

test("the priorities are the candidate layer's or the class is refused", () => {
  const observation = { work_format: "Remote", company_region: "WEST" };
  const valid = prioritiesOf();
  for (const options of [
    undefined,
    {},
    { priorities: null },
    { priorities: { ...valid, remoteCompanyRegions: ["UNKNOWN"] } },
    { priorities: { ...valid, remoteCompanyRegions: ["WEST", "WEST"] } },
    { priorities: { ...valid, relocationWest: "yes" } },
    { priorities: { ...valid, relocationCountries: ["Japan"] } },
    { priorities: { ...valid, relocationCountries: undefined } },
  ]) {
    assert.throws(
      () => priorityClassFor(observation, options),
      (error) => error.code === "pretriage_priorities_invalid",
      JSON.stringify(options),
    );
  }
  assert.throws(() => composeBatch([], {}), (error) => error.code === "pretriage_priorities_invalid");
});

test("the composition report counts every bucket and both observed axes", () => {
  const report = composeBatch([
    { work_format: "Remote", company_region: "WEST" },
    onSite({ company_region: "OTHER", relocation_destination_code: "AE" }),
    onSite({ company_region: "OTHER", relocation_destination_code: "AE" }),
    { work_format: "Unknown", company_region: "UNKNOWN" },
  ], ranked);
  assert.equal(report.total, 4);
  assert.deepEqual(report.by_priority_class, { 1: 1, 2: 0, 3: 0, outside: 2, unknown: 1 });
  assert.equal(report.priority_one_share, 0.25);
  assert.deepEqual(report.by_work_format, { Remote: 1, Hybrid: 0, "On-site": 2, Unknown: 1 });
  assert.deepEqual(report.by_company_region, { WEST: 1, HOME: 0, OTHER: 2, UNKNOWN: 1 });
});

test("an empty batch composes to zeros rather than dividing by nothing", () => {
  const report = composeBatch([], ranked);
  assert.equal(report.total, 0);
  assert.equal(report.priority_one_share, 0);
  assert.equal(report.priority_class_shares.outside, 0);
});

// --------------------------------------------------------------------- plan

test("the ledger's skips and unreadable links are disposed of before the sweep", () => {
  const plan = planPreTriage({
    collection: collectionOf([LINK_ONE, LINK_TWO, LINK_THREE, "not a url"], {
      collected_at: "2026-08-22",
    }),
    ledgerPlan: ledgerPlan(["fetch_new", "skip_closed", "skip_known", null]),
    asOf: "2026-08-23T00:00:00Z",
  });
  assert.deepEqual(plan.links.map((row) => row.disposition), [
    "pending_sweep",
    "skipped_by_ledger",
    "skipped_by_ledger",
    "unreadable_link",
  ]);
  assert.deepEqual(plan.sweep.links, [LINK_ONE]);
  // Two ledger skips plus the unreadable link: all three are avoided, but only the ledger's two are
  // anyone's saving, and pre-triage claims none of them.
  assert.equal(plan.spend.avoided_expensive_lane, 3);
  assert.equal(plan.spend.avoided_share, 0.75);
  assert.equal(plan.spend.avoided_by_ledger, 2);
  assert.equal(plan.spend.avoided_by_pretriage, 0);
  assert.equal(plan.spend.never_fetched, 3);
});

test("a fresh collection may proceed without the pre-triage sweep", () => {
  const plan = planPreTriage({
    collection: collectionOf([LINK_ONE], { collected_at: "2026-08-22" }),
    ledgerPlan: ledgerPlan(["fetch_new"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  assert.equal(plan.gate.expensive_lane_open, true);
  assert.deepEqual(plan.gate.blocked_by, []);
});

test("a stale collection holds the expensive lane shut until it is swept", () => {
  const plan = planPreTriage({
    collection: collectionOf([LINK_ONE], { collected_at: "2026-08-01" }),
    ledgerPlan: ledgerPlan(["fetch_new"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  assert.equal(plan.freshness.state, "stale");
  assert.equal(plan.gate.expensive_lane_open, false);
  assert.deepEqual(plan.gate.blocked_by, ["sweep_required"]);
});

test("a ledger plan that does not cover the collection is refused", () => {
  // Both directions. A short plan is caught again by the per-link lookup, but a plan carrying more
  // items than the collection has links would never reach that lookup at all: only the count says
  // the two lists are not about the same batch.
  for (const actions of [["fetch_new"], ["fetch_new", "fetch_new", "fetch_new"]]) {
    assert.throws(
      () => planPreTriage({
        collection: collectionOf([LINK_ONE, LINK_TWO]),
        ledgerPlan: ledgerPlan(actions),
        asOf: "2026-08-23T00:00:00Z",
      }),
      (error) => error.code === "pretriage_ledger_plan_mismatch",
    );
  }
});

test("the sweep turns every pending link into a verdict and reopens the gate", () => {
  const plan = planPreTriage({
    collection: collectionOf([LINK_ONE, LINK_TWO, LINK_THREE], { collected_at: "2026-08-01" }),
    ledgerPlan: ledgerPlan(["fetch_new", "fetch_new", "fetch_new"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  const swept = applyLivenessSweep(plan, {
    manifest: manifest([
      manifestRecord({ index: 1, requestedUrl: LINK_ONE }),
      manifestRecord({ index: 2, requestedUrl: LINK_TWO, outcome: "closed" }),
      manifestRecord({ index: 3, requestedUrl: LINK_THREE, outcome: "absent", usable: false }),
    ]),
  });
  assert.deepEqual(swept.links.map((row) => row.disposition), [
    "expensive_lane",
    "terminal_gone",
    "browser_rung",
  ]);
  assert.equal(swept.spend.avoided_expensive_lane, 1);
  assert.equal(swept.gate.expensive_lane_open, true);
  assert.equal(swept.sweep.applied, true);
  // The pre-sweep plan is evidence of what the batch intended and is not rewritten.
  assert.equal(plan.links[1].disposition, "pending_sweep");
  assert.equal(plan.sweep.applied, false);
});

test("a sweep of the wrong size is refused rather than aligned by position", () => {
  const plan = planPreTriage({
    collection: collectionOf([LINK_ONE, LINK_TWO]),
    ledgerPlan: ledgerPlan(["fetch_new", "fetch_new"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  assert.throws(
    () => applyLivenessSweep(plan, { manifest: manifest([manifestRecord()]) }),
    (error) => error.code === "pretriage_manifest_link_mismatch",
  );
});

test("a manifest about another link is refused, not silently believed", () => {
  const plan = planPreTriage({
    collection: collectionOf([LINK_ONE]),
    ledgerPlan: ledgerPlan(["fetch_new"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  assert.throws(
    () => applyLivenessSweep(plan, {
      manifest: manifest([manifestRecord({ requestedUrl: LINK_TWO })]),
    }),
    (error) => error.code === "pretriage_manifest_link_mismatch",
  );
});

test("a batch split across invocations is folded in invocation order", () => {
  const plan = planPreTriage({
    collection: collectionOf([LINK_ONE, LINK_TWO]),
    ledgerPlan: ledgerPlan(["fetch_new", "fetch_new"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  const swept = applyLivenessSweep(plan, {
    manifests: [
      manifest([manifestRecord({ index: 1, requestedUrl: LINK_ONE })]),
      manifest([manifestRecord({ index: 1, requestedUrl: LINK_TWO, outcome: "closed" })]),
    ],
  });
  assert.deepEqual(swept.links.map((row) => row.disposition), ["expensive_lane", "terminal_gone"]);
});

test("a manifest whose records do not start at its own first request is refused", () => {
  const plan = planPreTriage({
    collection: collectionOf([LINK_ONE, LINK_TWO]),
    ledgerPlan: ledgerPlan(["fetch_new", "fetch_new"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  assert.throws(
    () => applyLivenessSweep(plan, {
      manifest: manifest([
        manifestRecord({ index: 2, requestedUrl: LINK_ONE }),
        manifestRecord({ index: 3, requestedUrl: LINK_TWO }),
      ]),
    }),
    (error) => error.code === "pretriage_manifest_link_mismatch",
  );
});

test("passing both a manifest and a list of them is a caller error", () => {
  const plan = planPreTriage({
    collection: collectionOf([LINK_ONE]),
    ledgerPlan: ledgerPlan(["fetch_new"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  // The two guards share one bounded code, so the message is what tells them apart: without that,
  // either guard alone would satisfy both cases and neither would be pinned.
  assert.throws(
    () => applyLivenessSweep(plan, { manifest: manifest([manifestRecord()]), manifests: [] }),
    (error) => error.code === "pretriage_invalid_manifest_input"
      && error.message === "Pass either one manifest or a list, not both.",
  );
  assert.throws(
    () => applyLivenessSweep(plan, {}),
    (error) => error.code === "pretriage_invalid_manifest_input"
      && error.message === "The sweep needs at least one fetch manifest.",
  );
});

test("a plan is swept once", () => {
  const plan = planPreTriage({
    collection: collectionOf([LINK_ONE]),
    ledgerPlan: ledgerPlan(["fetch_new"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  const swept = applyLivenessSweep(plan, { manifest: manifest([manifestRecord()]) });
  assert.throws(
    () => applyLivenessSweep(swept, { manifest: manifest([manifestRecord()]) }),
    (error) => error.code === "pretriage_sweep_already_applied",
  );
});

// ------------------------------------------------------------------- report

test("the plan report names the saving, the gate and every withheld link", () => {
  const plan = planPreTriage({
    collection: collectionOf([LINK_ONE, LINK_TWO], { collected_at: "2026-08-01" }),
    ledgerPlan: ledgerPlan(["fetch_new", "skip_closed"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  const rendered = renderPreTriagePlan(applyLivenessSweep(plan, {
    manifest: manifest([manifestRecord({ index: 1, requestedUrl: LINK_ONE, outcome: "closed" })]),
  }));
  assert.match(rendered, /Pre-triage: 2 links, order — input_order\./u);
  assert.match(rendered, /state stale/u);
  assert.match(rendered, /Saved: 2 of 2 \(100\.0%\)/u);
  assert.match(rendered, /of those 1 were removed by pre-triage, 1 by the ledger, 0 are unreadable\./u);
  assert.match(rendered, /#1 terminal_gone closed_banner_observed/u);
  assert.match(rendered, /#2 skipped_by_ledger skip_closed/u);
});

test("an undated collection is reported as unproven rather than as an age", () => {
  const plan = planPreTriage({
    collection: collectionOf([LINK_ONE]),
    ledgerPlan: ledgerPlan(["fetch_new"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  const rendered = renderPreTriagePlan(plan);
  assert.match(rendered, /Collection with no collection date/u);
  assert.match(rendered, /Gate: the expensive lane is closed \(sweep_required\)\./u);
});

test("the composition report prints all five buckets and both axes", () => {
  const rendered = renderCompositionReport(composeBatch([
    { work_format: "Remote", company_region: "WEST" },
    { work_format: "On-site", company_region: "OTHER", relocation_destination_code: "QA", sponsorship: "available" },
  ], ranked));
  assert.match(rendered, /Batch composition: 2 vacancies/u);
  assert.match(rendered, /class 1: 1 \(50\.0%\)/u);
  assert.match(rendered, /outside \(none of the three classes\): 1 \(50\.0%\)/u);
  assert.match(rendered, /unknown \(the source did not say\): 0 \(0\.0%\)/u);
  assert.match(rendered, /Work format: Remote 1, Hybrid 0, On-site 1, Unknown 0\./u);
  assert.match(rendered, /Company region: WEST 1, HOME 0, OTHER 1, UNKNOWN 0\./u);
});

// --------------------------------------------------- fixes from the review round

test("the plan carries a posting instant through to the ordering", () => {
  const plan = planPreTriage({
    collection: {
      collected_at: "2026-08-22",
      declared_order: null,
      links: [
        { line: 1, url: LINK_ONE, posted_at: "2026-08-01T00:00:00Z" },
        { line: 2, url: LINK_TWO, posted_at: "2026-08-22T00:00:00Z" },
      ],
    },
    ledgerPlan: ledgerPlan(["fetch_new", "fetch_new"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  assert.equal(plan.ordering.basis, "posted_at");
  assert.deepEqual(plan.sweep.links, [LINK_TWO, LINK_ONE]);
});

test("a second spelling of one vacancy is not worth a request", () => {
  const plan = planPreTriage({
    collection: collectionOf([LINK_ONE, LINK_TWO]),
    ledgerPlan: {
      items: [
        { input_index: 1, action: "fetch_new", reason: "x", duplicate_in_batch: false },
        { input_index: 2, action: "fetch_new", reason: "x", duplicate_in_batch: true },
      ],
    },
    asOf: "2026-08-23T00:00:00Z",
  });
  assert.deepEqual(plan.links.map((row) => row.disposition), ["pending_sweep", "duplicate_in_batch"]);
  assert.deepEqual(plan.sweep.links, [LINK_ONE]);
  assert.equal(plan.spend.avoided_by_pretriage, 1);
  assert.equal(plan.spend.never_fetched, 1);
});

test("the user's explicit re-check of a known link is expressible", () => {
  const collection = collectionOf([LINK_ONE]);
  const plan = ledgerPlan(["skip_known"]);
  const asOf = "2026-08-23T00:00:00Z";
  assert.equal(
    planPreTriage({ collection, ledgerPlan: plan, asOf }).links[0].disposition,
    "skipped_by_ledger",
  );
  assert.equal(
    planPreTriage({ collection, ledgerPlan: plan, asOf, refetchKnown: true }).links[0].disposition,
    "pending_sweep",
  );
});

test("a closed link is never re-fetched, whatever the user asked for", () => {
  const plan = planPreTriage({
    collection: collectionOf([LINK_ONE]),
    ledgerPlan: ledgerPlan(["skip_closed"]),
    asOf: "2026-08-23T00:00:00Z",
    refetchKnown: true,
  });
  assert.equal(plan.links[0].disposition, "skipped_by_ledger");
});

test("a sweep record carrying no requested URL is not believed by default", () => {
  const plan = planPreTriage({
    collection: collectionOf([LINK_ONE]),
    ledgerPlan: ledgerPlan(["fetch_new"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  assert.throws(
    () => applyLivenessSweep(plan, {
      manifest: manifest([manifestRecord({ requestedUrl: null })]),
    }),
    (error) => error.code === "pretriage_manifest_link_mismatch",
  );
});

test("a verdict carries no manifest index that two links could share", () => {
  const classified = classifyLiveness({ index: 1, outcome: "active", usable: true, skipped: false });
  assert.equal(Object.hasOwn(classified, "index"), false);
});

test("the ledger accepts the class this stage computes", (t) => {
  const path = join(disposableRoot(t), "triage-ledger.json");
  initLedger(path);
  assert.equal(priorityClassForLedger({ work_format: "Remote", company_region: "WEST" }, ranked), 1);
  assert.equal(priorityClassForLedger({ work_format: "Remote", company_region: "OTHER" }, ranked), 2);
  assert.equal(
    priorityClassForLedger({ work_format: "On-site", company_region: "WEST", sponsorship: "available" }, ranked),
    3,
  );
  assert.equal(priorityClassForLedger({ work_format: "Unknown", company_region: "WEST" }, ranked), null);
  assert.equal(
    priorityClassForLedger({ work_format: "Hybrid", company_region: "OTHER", sponsorship: "unavailable" }, ranked),
    null,
  );
  const computed = priorityClassForLedger({ work_format: "Remote", company_region: "WEST" }, ranked);
  recordBatch(path, {
    batch_id: "pretriage-seam-1",
    observed_at: "2026-08-23T00:00:00Z",
    policy_id: "triage-policy-v2-2026-08-21",
    entries: [{
      url: LINK_ONE,
      status: "open",
      decision: "EVALUATED",
      flags: [],
      priority_class: computed,
    }],
  }, { artifactsDir: null });
  assert.equal(readLedger(path).entries[0].priority_class, 1);
});

test("every bounded caller error this stage can raise is named by a case", () => {
  const plan = planPreTriage({
    collection: collectionOf([LINK_ONE]),
    ledgerPlan: ledgerPlan(["fetch_new"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  const cases = [
    ["pretriage_invalid_collection", () => planPreTriage({
      collection: null, ledgerPlan: ledgerPlan([]), asOf: "2026-08-23T00:00:00Z" })],
    ["pretriage_invalid_ledger_plan", () => planPreTriage({
      collection: collectionOf([]), ledgerPlan: { items: null }, asOf: "2026-08-23T00:00:00Z" })],
    ["pretriage_invalid_plan", () => applyLivenessSweep({ links: null }, { manifest: manifest([]) })],
    // One case per field each renderer reads, so no guard clause rests on a sibling catching it.
    ["pretriage_invalid_plan", () => renderPreTriagePlan({ links: [] })],
    ["pretriage_invalid_plan", () => renderPreTriagePlan({
      links: [], freshness: {}, ordering: {}, gate: {} })],
    ["pretriage_invalid_plan", () => renderPreTriagePlan({
      links: [], spend: {}, ordering: {}, gate: {} })],
    ["pretriage_invalid_plan", () => renderPreTriagePlan({
      links: [], spend: {}, freshness: {}, gate: {} })],
    ["pretriage_invalid_plan", () => renderPreTriagePlan({
      links: [], spend: {}, freshness: {}, ordering: {} })],
    ["pretriage_invalid_composition", () => renderCompositionReport({ total: 1 })],
    ["pretriage_invalid_composition", () => renderCompositionReport({
      priority_class_shares: {}, by_work_format: {}, by_company_region: {} })],
    ["pretriage_invalid_composition", () => renderCompositionReport({
      by_priority_class: {}, by_work_format: {}, by_company_region: {} })],
    ["pretriage_invalid_composition", () => renderCompositionReport({
      by_priority_class: {}, priority_class_shares: {}, by_company_region: {} })],
    ["pretriage_invalid_composition", () => renderCompositionReport({
      by_priority_class: {}, priority_class_shares: {}, by_work_format: {} })],
    ["pretriage_invalid_header", () => parseCollectionHeader(42)],
    ["pretriage_invalid_links", () => orderNewestFirst("not an array")],
    ["pretriage_links_unreadable", () => readCollection("/nonexistent/links.txt")],
    ["pretriage_manifest_record_invalid", () => sweepFromManifest(manifest([null]))],
    ["pretriage_observation_invalid", () => priorityClassFor("not an object", ranked)],
    ["pretriage_observation_invalid", () => composeBatch("not an array", ranked)],
    ["pretriage_observation_invalid", () => priorityClassFor({
      work_format: "Remote", company_region: "WEST", sponsorship: "maybe" }, ranked)],
    ["pretriage_priorities_invalid", () => composeBatch([], undefined)],
    ["pretriage_invalid_collection", () => splitCollection({ links: null })],
    ["pretriage_invalid_group_size", () => splitCollection(collectionOf([LINK_ONE]), { groupSize: 0 })],
    ["pretriage_invalid_group", () => collectionGroup(collectionOf([LINK_ONE]), { from: 1, to: 2 })],
    ["pretriage_invalid_label", () => groupBatchId("", { from: 1, to: 1 })],
    ["pretriage_store_missing", () => claimGroup({ storeDir: "relative", split: { groups: [] }, labelPrefix: "x" })],
    ["pretriage_invalid_split", () => claimGroup({
      storeDir: realpathSync(tmpdir()), split: { groups: [] }, labelPrefix: "x" })],
  ];
  for (const [code, run] of cases) {
    assert.throws(run, (error) => error.code === code, `expected ${code}`);
  }
  assert.equal(plan.links.length, 1);
});

test("an open gate and a withheld-versus-pending split are both stated", () => {
  // Two ledger skips against one pre-triage saving: the two figures must differ, or the report
  // could name them in the wrong order and no assertion would notice.
  const plan = planPreTriage({
    collection: collectionOf([LINK_ONE, LINK_TWO, LINK_THREE, "https://example.com/d"], {
      collected_at: "2026-08-22",
    }),
    ledgerPlan: ledgerPlan(["fetch_new", "fetch_new", "skip_closed", "skip_known"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  const preSweep = renderPreTriagePlan(plan);
  assert.match(preSweep, /Gate: the expensive lane is open\./u);
  // A link still awaiting the sweep is listed as costing budget, never as a saving.
  assert.match(preSweep, /Still costing the budget:\n {2}#1 pending_sweep/u);
  assert.match(preSweep, /Not reaching the expensive lane:\n {2}#3 skipped_by_ledger/u);

  const swept = renderPreTriagePlan(applyLivenessSweep(plan, {
    manifest: manifest([
      manifestRecord({ index: 1, requestedUrl: LINK_ONE, outcome: "absent", usable: false }),
      manifestRecord({ index: 2, requestedUrl: LINK_TWO, outcome: "closed" }),
    ]),
  }));
  assert.match(swept, /Still costing the budget:\n {2}#1 browser_rung absent_awaiting_confirmation/u);
  assert.match(swept, /of those 1 were removed by pre-triage, 2 by the ledger, 0 are unreadable\. Never fetched at all: 2\./u);
});

test("a rendered link cannot break the report into a line the stage did not write", () => {
  const hostile = `https://example.com/a\u2028fake-line`;
  const plan = planPreTriage({
    collection: collectionOf([hostile]),
    ledgerPlan: ledgerPlan(["skip_closed"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  const rendered = renderPreTriagePlan(plan);
  assert.equal(rendered.includes("\u2028"), false);
  assert.match(rendered, /#1 skipped_by_ledger skip_closed — https:\/\/example\.com\/a\ufffdfake-line/u);
});

test("a rendered link is truncated rather than printed whole", () => {
  const long = `https://example.com/${"a".repeat(400)}`;
  const plan = planPreTriage({
    collection: collectionOf([long]),
    ledgerPlan: ledgerPlan(["skip_closed"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  const line = renderPreTriagePlan(plan).split("\n").find((entry) => entry.startsWith("  #1"));
  assert.equal(line.endsWith("…"), true);
  assert.equal(line.length, 200 + "  #1 skipped_by_ledger skip_closed — ".length + 1);
});

// ------------------------------------------- fixes from the second review round

test("an impossible calendar date is refused in the zoned spelling too", () => {
  // Date.parse rolls 2026-02-30 to 2026-03-02, which would read two days younger than written —
  // a third of the staleness window.
  assert.equal(collectionInstant("2026-02-30T00:00:00Z"), null);
  assert.equal(collectionInstant("2026-04-31T12:00:00+03:00"), null);
  assert.equal(collectionInstant("2026-03-01T00:00:00Z"), Date.parse("2026-03-01T00:00:00Z"));
});

test("a links file larger than this stage reads is refused before it is read", (t) => {
  const path = join(disposableRoot(t), "links.txt");
  writeFileSync(path, `# collected: 2026-08-17\n${LINK_ONE}\n#${"x".repeat(1024 * 1024)}\n`, "utf8");
  assert.throws(
    () => readCollection(path),
    (error) => error.code === "pretriage_links_unreadable",
  );
});

test("a duplicate of a link the ledger already closed is the ledger's saving", () => {
  const plan = planPreTriage({
    collection: collectionOf([LINK_ONE, LINK_TWO]),
    ledgerPlan: {
      items: [
        { input_index: 1, action: "skip_closed", reason: "ledger status closed", duplicate_in_batch: false },
        { input_index: 2, action: "skip_closed", reason: "ledger status closed", duplicate_in_batch: true },
      ],
    },
    asOf: "2026-08-23T00:00:00Z",
  });
  assert.deepEqual(plan.links.map((row) => row.disposition), ["skipped_by_ledger", "skipped_by_ledger"]);
  assert.equal(plan.spend.avoided_by_ledger, 2);
  assert.equal(plan.spend.avoided_by_pretriage, 0);
});

test("a ledger plan about another collection is refused, not joined by position", () => {
  assert.throws(
    () => planPreTriage({
      collection: collectionOf([LINK_ONE]),
      ledgerPlan: { items: [{ input_index: 1, action: "fetch_new", reason: "x", link: LINK_TWO }] },
      asOf: "2026-08-23T00:00:00Z",
    }),
    (error) => error.code === "pretriage_ledger_plan_mismatch",
  );
});

test("a sweep that attempted nothing does not open a stale collection's gate", () => {
  const stale = planPreTriage({
    collection: collectionOf([LINK_ONE], { collected_at: "2026-08-01" }),
    ledgerPlan: ledgerPlan(["fetch_new"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  const sweptStale = applyLivenessSweep(stale, {
    manifest: manifest([manifestRecord({ outcome: "access_failure", usable: false, skipped: true })]),
  });
  assert.equal(sweptStale.gate.expensive_lane_open, false);
  assert.deepEqual(sweptStale.gate.blocked_by, ["sweep_incomplete"]);

  // A fresh collection was never held behind the gate, so an unattempted link does not close it.
  const fresh = planPreTriage({
    collection: collectionOf([LINK_ONE], { collected_at: "2026-08-22" }),
    ledgerPlan: ledgerPlan(["fetch_new"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  const sweptFresh = applyLivenessSweep(fresh, {
    manifest: manifest([manifestRecord({ outcome: "access_failure", usable: false, skipped: true })]),
  });
  assert.equal(sweptFresh.gate.expensive_lane_open, true);
});

test("a null field is refused by the renderers, not thrown through", () => {
  assert.throws(
    () => renderPreTriagePlan({ links: [], spend: null, freshness: {}, ordering: {}, gate: {} }),
    (error) => error.code === "pretriage_invalid_plan",
  );
  assert.throws(
    () => renderCompositionReport({
      by_priority_class: null, priority_class_shares: {}, by_work_format: {}, by_company_region: {} }),
    (error) => error.code === "pretriage_invalid_composition",
  );
});

test("the report agrees with itself on one link and on many", () => {
  const render = (count) => renderPreTriagePlan(planPreTriage({
    collection: collectionOf(Array.from({ length: count }, (_, index) => `https://example.com/${index}`)),
    ledgerPlan: ledgerPlan(Array.from({ length: count }, () => "skip_closed")),
    asOf: "2026-08-23T00:00:00Z",
  }));
  assert.match(render(1), /Pre-triage: 1 link,/u);
  assert.match(render(2), /Pre-triage: 2 links,/u);
  assert.match(render(5), /Pre-triage: 5 links,/u);
  assert.match(render(21), /Pre-triage: 21 links,/u);
});

test("a bidi override cannot make a report line name another resource", () => {
  const hostile = "https://example.com/\u202egnp.exe";
  const plan = planPreTriage({
    collection: collectionOf([hostile]),
    ledgerPlan: ledgerPlan(["skip_closed"]),
    asOf: "2026-08-23T00:00:00Z",
  });
  const rendered = renderPreTriagePlan(plan);
  assert.equal(rendered.includes("\u202e"), false);
  assert.match(rendered, /https:\/\/example\.com\/\ufffdgnp\.exe/u);
});

// ---------------------------------------------------------------- session groups

function linkAt(number) {
  return `https://www.linkedin.com/jobs/view/${4000000000 + number}/`;
}

function collectionOfSize(count) {
  return collectionOf(Array.from({ length: count }, (_, index) => linkAt(index + 1)), {
    collected_at: "2026-09-19",
    declared_order: "newest-first",
  });
}

test("the split is the same twice, reads no ledger, and covers the collection without overlap", () => {
  const collection = collectionOfSize(52);
  const first = splitCollection(collection, { groupSize: 15 });
  const second = splitCollection(collection, { groupSize: 15 });
  assert.deepEqual(first, second);
  // No ledger in the signature: the cut depends on the file and the number, and on nothing else.
  assert.equal(splitCollection.length, 1);
  assert.deepEqual(first.groups.map((group) => [group.from, group.to]), [[1, 15], [16, 30], [31, 45], [46, 52]]);
  assert.deepEqual(first.groups.map((group) => group.group), [1, 2, 3, 4]);
  assert.equal(first.group_size, 15);
  assert.equal(first.total, 52);
  const covered = first.groups.flatMap((group) =>
    Array.from({ length: group.to - group.from + 1 }, (_, offset) => group.from + offset));
  assert.equal(covered.length, 52, "no position twice");
  assert.deepEqual([...new Set(covered)].sort((a, b) => a - b), Array.from({ length: 52 }, (_, i) => i + 1));
  assert.deepEqual(first.cross_group_spellings, []);
});

test("no size means one group, and a size that is not a positive integer is refused", () => {
  const collection = collectionOfSize(7);
  assert.deepEqual(splitCollection(collection).groups, [{ group: 1, from: 1, to: 7, size: 7 }]);
  assert.deepEqual(splitCollection(collection, { groupSize: 7 }).groups, [{ group: 1, from: 1, to: 7, size: 7 }]);
  assert.deepEqual(splitCollection(collection, { groupSize: 100 }).groups, [{ group: 1, from: 1, to: 7, size: 7 }]);
  for (const groupSize of [0, -1, 1.5, "15", NaN]) {
    assert.throws(() => splitCollection(collection, { groupSize }), (error) => error.code === "pretriage_invalid_group_size", String(groupSize));
  }
  assert.throws(() => splitCollection(collectionOf([]), { groupSize: 3 }), (error) => error.code === "pretriage_invalid_collection");
});

test("a group's slice is the verify suite's slice, and the pre-triage plan takes it as a collection", () => {
  const collection = collectionOfSize(7);
  const split = splitCollection(collection, { groupSize: 3 });
  const group = collectionGroup(collection, split.groups[1]);
  assert.deepEqual(group.links, sliceRange(collection.links, 4, 6));
  assert.deepEqual(group.links.map((link) => link.position), [4, 5, 6]);
  assert.equal(group.collected_at, "2026-09-19");
  assert.equal(group.declared_order, "newest-first");
  const plan = planPreTriage({
    collection: group,
    ledgerPlan: ledgerPlan(["fetch_new", "fetch_new", "fetch_new"]),
    asOf: "2026-09-20T10:00:00Z",
  });
  assert.deepEqual(plan.links.map((row) => row.input_index), [1, 2, 3]);
  assert.deepEqual(plan.sweep.links, [linkAt(4), linkAt(5), linkAt(6)]);
  assert.throws(() => collectionGroup(collection, { from: 6, to: 9 }), (error) => error.code === "pretriage_invalid_group");
  assert.throws(() => collectionGroup(collection, null), (error) => error.code === "pretriage_invalid_group");
});

test("a second spelling of one posting in another group is named before anything is fetched", () => {
  const urls = [linkAt(1), linkAt(2), linkAt(3), `${linkAt(1)}?utm_source=share`, linkAt(5)];
  const split = splitCollection(collectionOf(urls), { groupSize: 3 });
  assert.deepEqual(split.cross_group_spellings, [
    { position: 4, group: 2, first_position: 1, first_group: 1 },
  ]);
  // The same pair inside one group is `planBatch`'s `duplicate_in_batch`, not this list's business.
  assert.deepEqual(splitCollection(collectionOf(urls), { groupSize: 5 }).cross_group_spellings, []);
});

test("a group's batch id is the manual runs' shape, checked against the ledger's pattern up front", () => {
  assert.equal(groupBatchId("2026-09-20-telegram", { from: 1, to: 15 }), "2026-09-20-telegram-1-15");
  assert.equal(groupBatchId("2026-09-20-telegram", { from: 46, to: 52 }), "2026-09-20-telegram-46-52");
  for (const prefix of ["", "с пробелом и кириллицей", "a".repeat(64), "-leading-dash"]) {
    assert.throws(() => groupBatchId(prefix, { from: 1, to: 15 }), (error) => error.code === "pretriage_invalid_label", prefix);
  }
  assert.throws(() => groupBatchId("ok", { from: 1 }), (error) => error.code === "pretriage_invalid_group");
});

test("the batch directory is the claim: groups are taken in order, once each, and only in a store that exists", (t) => {
  const root = disposableRoot(t);
  const store = join(root, "triage-batches");
  const split = splitCollection(collectionOfSize(7), { groupSize: 3 });
  const missing = { storeDir: store, split, labelPrefix: "2026-09-20-telegram" };
  assert.throws(() => claimGroup(missing), (error) => error.code === "pretriage_store_missing");
  assert.throws(() => claimGroup({ ...missing, storeDir: "triage-batches" }), (error) => error.code === "pretriage_store_missing");
  mkdirSync(store);

  const taken = [1, 2, 3].map(() => claimGroup(missing));
  assert.deepEqual(taken.map((claim) => [claim.group, claim.from, claim.to, claim.batch_id]), [
    [1, 1, 3, "2026-09-20-telegram-1-3"],
    [2, 4, 6, "2026-09-20-telegram-4-6"],
    [3, 7, 7, "2026-09-20-telegram-7-7"],
  ]);
  for (const claim of taken) assert.equal(claim.dir, join(store, claim.batch_id));
  assert.deepEqual(readdirSync(store).sort(), taken.map((claim) => claim.batch_id).sort());
  assert.throws(() => claimGroup(missing), (error) => error.code === "pretriage_no_free_group");
  // Taking a group again on purpose is by number, and a claimed one says so rather than yielding.
  assert.throws(() => claimGroup({ ...missing, group: 2 }), (error) => error.code === "pretriage_group_claimed");
  assert.throws(() => claimGroup({ ...missing, group: 9 }), (error) => error.code === "pretriage_invalid_group");
  assert.throws(() => claimGroup({ ...missing, split: { groups: [] } }), (error) => error.code === "pretriage_invalid_split");
  rmSync(taken[1].dir, { recursive: true });
  assert.equal(claimGroup({ ...missing, group: 2 }).batch_id, "2026-09-20-telegram-4-6");

  // A store that exists and still refuses the directory is neither missing nor claimed.
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    const sealed = join(root, "sealed-store");
    mkdirSync(sealed, { mode: 0o500 });
    try {
      assert.throws(
        () => claimGroup({ ...missing, storeDir: sealed }),
        (error) => error.code === "pretriage_claim_failed",
      );
    } finally {
      chmodSync(sealed, 0o700);
    }
  }
});

test("two sessions claiming at once get two different groups", async (t) => {
  const root = disposableRoot(t);
  const store = join(root, "triage-batches");
  mkdirSync(store);
  const collectionPath = join(root, "collection.links.txt");
  writeFileSync(collectionPath, `# collected: 2026-09-19\n${Array.from({ length: 6 }, (_, i) => linkAt(i + 1)).join("\n")}\n`, "utf8");
  const childPath = join(root, "claim-child.mjs");
  const groupsPath = fileURLToPath(new URL("../tools/pretriage/groups.mjs", import.meta.url));
  const collectionModule = fileURLToPath(new URL("../tools/pretriage/collection.mjs", import.meta.url));
  writeFileSync(
    childPath,
    [
      `import { claimGroup, splitCollection } from ${JSON.stringify(groupsPath)};`,
      `import { readCollection } from ${JSON.stringify(collectionModule)};`,
      "const [storeDir, collectionPath] = process.argv.slice(2);",
      "const split = splitCollection(readCollection(collectionPath), { groupSize: 3 });",
      "console.log(claimGroup({ storeDir, split, labelPrefix: \"2026-09-20-telegram\" }).batch_id);",
      "",
    ].join("\n"),
  );
  const claimed = await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childPath, store, collectionPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => (status === 0 ? resolve(stdout.trim()) : reject(new Error(stderr))));
  })));
  assert.deepEqual(claimed.sort(), ["2026-09-20-telegram-1-3", "2026-09-20-telegram-4-6"]);
});

test("every group planned and recorded leaves one row per vacancy and one batch per group", (t) => {
  const root = disposableRoot(t);
  const store = join(root, "triage-batches");
  mkdirSync(store);
  const ledgerPath = join(root, "triage-ledger.json");
  initLedger(ledgerPath);
  const collection = collectionOfSize(7);
  const split = splitCollection(collection, { groupSize: 3 });

  for (const group of split.groups) {
    const claim = claimGroup({ storeDir: store, split, labelPrefix: "2026-09-20-telegram", group: group.group });
    const slice = collectionGroup(collection, claim);
    const urls = slice.links.map((link) => link.url);
    // The batch's start: the ledger plan over the slice, written where the record write reads it.
    const plan = planBatch(readLedger(ledgerPath), urls, { asOf: "2026-09-20T10:00:00Z" });
    writeFileSync(join(claim.dir, "plan.json"), `${JSON.stringify(plan)}\n`, "utf8");
    const preTriage = planPreTriage({ collection: slice, ledgerPlan: plan, asOf: "2026-09-20T10:00:00Z" });
    assert.equal(preTriage.spend.supplied, urls.length);
    mkdirSync(join(claim.dir, "traces"));
    urls.forEach((url, index) => {
      writeFileSync(join(claim.dir, "traces", `${String(index + 1).padStart(3, "0")}.trace.json`), JSON.stringify({ source_ref: url }), "utf8");
    });
    recordBatch(ledgerPath, {
      batch_id: claim.batch_id,
      observed_at: "2026-09-20T10:30:00Z",
      policy_id: "triage-policy-v3-2026-09-02",
      entries: urls.map((url) => ({ url, status: "open", decision: "EVALUATED", flags: [] })),
    }, { artifactsDir: claim.dir });
    assert.ok(existsSync(join(claim.dir, "ledger-record.json")));
  }

  const ledger = readLedger(ledgerPath);
  assert.equal(ledger.entries.length, 7, "one row per vacancy that reached the record");
  assert.equal(new Set(ledger.entries.map((row) => row.key)).size, 7, "none twice");
  assert.deepEqual(ledger.batches.map((row) => row.batch_id), [
    "2026-09-20-telegram-1-3",
    "2026-09-20-telegram-4-6",
    "2026-09-20-telegram-7-7",
  ]);
  // The closing check the skill prescribes: nothing of the collection is still new.
  const closing = planBatch(ledger, collection.links.map((link) => link.url), { asOf: "2026-09-20T11:00:00Z" });
  assert.equal(closing.counts.fetch_new, 0);
});
