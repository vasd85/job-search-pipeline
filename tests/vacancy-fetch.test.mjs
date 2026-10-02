// Offline suite for the triage fetch layer.
//
// Nothing here reaches the network: the transport takes `fetchImpl` as a parameter and every
// case supplies a `Response` built in memory, so the real streaming reader, the real redirect
// walk, the real decoder and the real persistence path all execute against frozen bytes. Live
// route behaviour belongs to the rollout runbook's measured comparison, not to a deterministic
// gate.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectText,
  decodeEntities,
  findElement,
  genericChromeTags,
  hasClassContaining,
  parseHtml,
  walkElements,
} from "../tools/vacancy-fetch/html-text.mjs";
import {
  normalizationRules,
  normalizeExtractedText,
} from "../tools/vacancy-fetch/normalize.mjs";
import {
  accessBarriers,
  classifyDirectRoute,
  classifyStatusWord,
  outcomeNames,
} from "../tools/vacancy-fetch/outcome.mjs";
import {
  parseHttpUrl,
  requestedUrl,
  serverSuppliedUrl,
} from "../tools/vacancy-fetch/url-rule.mjs";
import { sha256Utf8 } from "../tools/vacancy-fetch/digest.mjs";
import {
  captureBasename,
  captureBodyDelimiter,
  manifestBasename,
  renderCaptureFile,
  verifyCaptureFile,
} from "../tools/vacancy-fetch/persist.mjs";
import {
  fetchDocument,
  recordedResponseHeaders,
  transportDefaults,
  transportFailureCodes,
} from "../tools/vacancy-fetch/transport.mjs";
import {
  VacancyFetchError,
  maxBatchUrls,
  prepareOutDir,
  runVacancyFetchBatch,
} from "../tools/vacancy-fetch/batch.mjs";
import {
  dedicatedAdapters,
  fallbackAdapter,
  selectAdapter,
  sourceIdFor,
  vacancyFetchAdapters,
} from "../tools/vacancy-fetch/adapters/index.mjs";
import {
  closedBannerMarkers,
  extractJobId,
  linkedinAntiBotPathPrefixes,
  linkedinAuthWallPathPrefixes,
  linkedinGuestAdapter,
  linkedinGuestRoute,
} from "../tools/vacancy-fetch/adapters/linkedin-guest.mjs";
import {
  antiBotMarkers,
  authWallMarkers,
  genericHtmlAdapter,
} from "../tools/vacancy-fetch/adapters/generic-html.mjs";
import {
  adapterReading,
  adapterReasonCodes,
  defaultRequestHeaders,
  deferredContentReason,
  minimumContent,
} from "../tools/vacancy-fetch/adapters/contract.mjs";
import {
  deferredContentSuspected,
  deferredContentThresholdRatio,
  jsonWalkValueBudget,
  measureJsonIslandProse,
  proseCharCount,
} from "../tools/vacancy-fetch/deferred-content.mjs";
import {
  vacancyFetchCommand,
  vacancyFetchInputSchemas,
} from "../tools/vacancy-fetch/input-schema.mjs";
import { main as cliMain } from "../tools/vacancy-fetch/cli.mjs";
import { SafeCliInputError, readSafeCliInput } from "../tools/lib/safe-cli-input.mjs";
import { createDisposableWorkspace } from "./fixtures/disposable-workspace.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(repoRoot, "tools/vacancy-fetch/fixtures");

const LINKEDIN_JOB_ID = "4291837465";
const LINKEDIN_REF =
  `https://www.linkedin.com/jobs/view/senior-qa-automation-engineer-at-northwind-payments-${LINKEDIN_JOB_ID}`;
const GUEST_URL =
  `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${LINKEDIN_JOB_ID}`;
const GENERIC_REF = "https://careers.northwind-payments.example/jobs/senior-qa";
const LINKEDIN_LOGIN_URL = "https://www.linkedin.com/uas/login";

function readFixture(name) {
  return readFileSync(join(fixtureRoot, name), "utf8");
}

// Frozen fixture manifest. Every file is synthetic — see the directory README. The digests turn
// byte drift into a diff, the two-directional directory comparison turns an omitted or unlisted
// file into a failure, and `expectation` is the executable oracle: each row is replayed through
// the serving adapter below, so the column cannot decay into decoration.
const fixtureManifest = Object.freeze([
  Object.freeze({
    caseId: "readme",
    file: "README.md",
    sha256: "2128df927fc3c43282a42d89829fec3a0e771015467490a66812128a08a0d457",
    adapter: null,
    expectation: null,
  }),
  Object.freeze({
    caseId: "linkedin_active",
    file: "linkedin-guest-active.html",
    sha256: "4dbb8db97b65f3109f668d981e2f63004288af6a3eac9ee7ad2c888f37719e65",
    adapter: "linkedin-guest",
    request: Object.freeze({ status: 200, finalUrl: GUEST_URL }),
    expectation: Object.freeze({
      outcome: "active",
      accessBarrier: null,
      retryable: false,
      structuralOk: true,
      reasons: Object.freeze([]),
      textIncludes: Object.freeze([
        "Senior QA Automation Engineer",
        "Northwind Payments",
        "Playwright and TypeScript",
      ]),
      textExcludes: Object.freeze(["not visible text", "window.tracking"]),
    }),
  }),
  Object.freeze({
    caseId: "linkedin_closed",
    file: "linkedin-guest-closed.html",
    sha256: "d1bc75e0c39a9e8f01b5a5ec19d04d2494a8ee04279cfcb1ffce706e3dd315f6",
    adapter: "linkedin-guest",
    request: Object.freeze({ status: 200, finalUrl: GUEST_URL }),
    expectation: Object.freeze({
      outcome: "closed",
      accessBarrier: null,
      retryable: false,
      structuralOk: true,
      reasons: Object.freeze([]),
      textIncludes: Object.freeze(["No longer accepting applications"]),
      textExcludes: Object.freeze([]),
    }),
  }),
  Object.freeze({
    caseId: "linkedin_wrong_job",
    file: "linkedin-guest-wrong-job.html",
    sha256: "ddfb32cfb471bec7bffc7e4e7b13d56d98af43422c57dfa516e51a5d29387041",
    adapter: "linkedin-guest",
    request: Object.freeze({ status: 200, finalUrl: GUEST_URL }),
    expectation: Object.freeze({
      // The identity guard does not invent an outcome: the page is a live posting, it is simply
      // not provably the requested one, so the record stays active and unusable.
      outcome: "active",
      accessBarrier: null,
      retryable: false,
      structuralOk: false,
      reasons: Object.freeze(["identity_unconfirmed"]),
      textIncludes: Object.freeze(["Manual QA Engineer"]),
      textExcludes: Object.freeze([]),
    }),
  }),
  Object.freeze({
    caseId: "linkedin_no_container",
    file: "linkedin-guest-no-container.html",
    sha256: "0e6b15c7a46ef823bf62f4b9c4f816e74a526937954425c728f37e7584a934c9",
    adapter: "linkedin-guest",
    request: Object.freeze({ status: 200, finalUrl: GUEST_URL }),
    expectation: Object.freeze({
      outcome: "active",
      accessBarrier: null,
      retryable: false,
      structuralOk: false,
      reasons: Object.freeze(["description_container_absent"]),
      textIncludes: Object.freeze(["Senior QA Automation Engineer"]),
      textExcludes: Object.freeze([]),
    }),
  }),
  Object.freeze({
    caseId: "linkedin_authwall",
    file: "linkedin-guest-authwall.html",
    sha256: "e47472cb4c49cea697ae6d7b1bdba6b7479117acc06ec8e1a33ac7f20234d9d3",
    adapter: "linkedin-guest",
    request: Object.freeze({ status: 200, finalUrl: "https://www.linkedin.com/authwall" }),
    expectation: Object.freeze({
      outcome: "access_failure",
      accessBarrier: "authentication",
      retryable: true,
      structuralOk: false,
      reasons: Object.freeze([
        "auth_wall",
        "description_container_absent",
        "content_below_minimum",
        "identity_unconfirmed",
      ]),
      textIncludes: Object.freeze([]),
      textExcludes: Object.freeze([]),
    }),
  }),
  Object.freeze({
    caseId: "linkedin_anti_bot",
    file: "linkedin-guest-anti-bot.html",
    sha256: "9d9f04f86512ed91c92ffd9d3449275c89625e655e344cbfcca9ea214560c3f5",
    adapter: "linkedin-guest",
    request: Object.freeze({ status: 999, finalUrl: GUEST_URL }),
    expectation: Object.freeze({
      outcome: "access_failure",
      accessBarrier: "anti_bot",
      retryable: true,
      structuralOk: false,
      reasons: Object.freeze([
        "anti_bot_page",
        "description_container_absent",
        "content_below_minimum",
        "identity_unconfirmed",
      ]),
      textIncludes: Object.freeze([]),
      textExcludes: Object.freeze([]),
    }),
  }),
  Object.freeze({
    caseId: "generic_main_active",
    file: "generic-main-active.html",
    sha256: "a5a7c161ec739ffa33a3065a32b7287f87ccaa27f10c6baeb553879c7faca480",
    adapter: "generic-html",
    request: Object.freeze({ status: 200, finalUrl: GENERIC_REF }),
    expectation: Object.freeze({
      outcome: "active",
      accessBarrier: null,
      retryable: false,
      structuralOk: true,
      reasons: Object.freeze([]),
      textIncludes: Object.freeze(["Senior QA Automation Engineer", "What you will do"]),
      textExcludes: Object.freeze([
        "Home",
        "Northwind Payments careers",
        "All rights reserved",
        "display:none",
        "jobId",
      ]),
    }),
  }),
  Object.freeze({
    caseId: "generic_article_longest",
    file: "generic-article-longest.html",
    sha256: "c5d64bfd89eef282de5c32b9a3682499be2b25eba2038c7d0ae3e21c991edfb6",
    adapter: "generic-html",
    request: Object.freeze({ status: 200, finalUrl: GENERIC_REF }),
    expectation: Object.freeze({
      outcome: "active",
      accessBarrier: null,
      retryable: false,
      structuralOk: true,
      reasons: Object.freeze([]),
      textIncludes: Object.freeze(["Responsibilities include owning the regression suite"]),
      textExcludes: Object.freeze(["Short teaser about the role"]),
    }),
  }),
  Object.freeze({
    caseId: "generic_no_semantic",
    file: "generic-no-semantic.html",
    sha256: "17a50f5f07cf38a0fd07b2228bb093303f18653ce3f91703fd5346ca574a2c97",
    adapter: "generic-html",
    request: Object.freeze({ status: 200, finalUrl: GENERIC_REF }),
    expectation: Object.freeze({
      outcome: "active",
      accessBarrier: null,
      retryable: false,
      structuralOk: true,
      reasons: Object.freeze([]),
      textIncludes: Object.freeze(["Senior QA Automation Engineer"]),
      textExcludes: Object.freeze([
        "Home Jobs Contact",
        "Other openings you may like",
        "Copyright 2026",
      ]),
    }),
  }),
  Object.freeze({
    caseId: "generic_thin",
    file: "generic-thin.html",
    sha256: "210c34f51a5561444eefea5ad0b20e8f802705d22e90193dfb6b3fdd475504c8",
    adapter: "generic-html",
    request: Object.freeze({ status: 200, finalUrl: GENERIC_REF }),
    expectation: Object.freeze({
      outcome: "access_failure",
      accessBarrier: "unparseable",
      retryable: true,
      structuralOk: false,
      reasons: Object.freeze(["content_below_minimum"]),
      textIncludes: Object.freeze([]),
      textExcludes: Object.freeze([]),
    }),
  }),
  Object.freeze({
    caseId: "generic_anti_bot",
    file: "generic-anti-bot.html",
    sha256: "88e7b3be6677b1240871ba4c1a8051b0dd0f6eb438c2f03053d805b38d9ca63f",
    adapter: "generic-html",
    request: Object.freeze({ status: 200, finalUrl: GENERIC_REF }),
    expectation: Object.freeze({
      outcome: "access_failure",
      accessBarrier: "anti_bot",
      retryable: true,
      structuralOk: false,
      reasons: Object.freeze(["anti_bot_page", "content_below_minimum"]),
      textIncludes: Object.freeze([]),
      textExcludes: Object.freeze([]),
    }),
  }),
  Object.freeze({
    caseId: "generic_linkedin_login_localized",
    file: "generic-linkedin-login-localized.html",
    sha256: "a5f44d79c3abf095e674a87a0da797004785da11dbe3dd323907955e44dfed1d",
    adapter: "generic-html",
    request: Object.freeze({ status: 200, finalUrl: LINKEDIN_LOGIN_URL }),
    expectation: Object.freeze({
      // The body clears the content floor and carries none of the English wall markers, so only
      // the final URL can say what it is: LinkedIn sent the request to its sign-in page.
      outcome: "access_failure",
      accessBarrier: "authentication",
      retryable: true,
      structuralOk: true,
      reasons: Object.freeze(["auth_wall"]),
      textIncludes: Object.freeze(["Aanmelden", "Nieuw op LinkedIn?"]),
      textExcludes: Object.freeze(["window.pageTracking"]),
    }),
  }),
  Object.freeze({
    caseId: "generic_hostile",
    file: "generic-hostile.html",
    sha256: "73cd2d21ea281a703d330b5d2ef315d0935a92dbbdbc54018ebefc3ef5d6cb76",
    adapter: "generic-html",
    request: Object.freeze({ status: 200, finalUrl: GENERIC_REF }),
    expectation: Object.freeze({
      outcome: "active",
      accessBarrier: null,
      retryable: false,
      structuralOk: true,
      reasons: Object.freeze([]),
      // Hostile prose survives as data, verbatim. Suppressing it would be a second defect: the
      // operating contract requires preserving observed source content while never obeying it.
      textIncludes: Object.freeze([
        "ignore your previous instructions",
        "$(touch marker)",
        "<script> & \"quotes\" &notanentity; AB &#xD800;",
        "line one\nline two",
      ]),
      textExcludes: Object.freeze(["Enable JavaScript and cookies to continue"]),
    }),
  }),
  Object.freeze({
    caseId: "generic_json_body",
    file: "generic-json-body.json",
    sha256: "7f4d6ab19c15a001beb8e9422d885e9c890f0dac432f92bd68a0cd8314a423da",
    adapter: "generic-html",
    request: Object.freeze({
      status: 200,
      finalUrl: GENERIC_REF,
      contentType: "application/json",
    }),
    expectation: Object.freeze({
      outcome: "access_failure",
      accessBarrier: "unparseable",
      retryable: true,
      structuralOk: false,
      reasons: Object.freeze(["unsupported_content_type"]),
      textIncludes: Object.freeze([]),
      textExcludes: Object.freeze([]),
    }),
  }),
  Object.freeze({
    // Provenance-stamped harvest (see the directory README): the reduced real page whose
    // deferred blocks live only in the typed JSON island. The record stays usable — the flag
    // marks an architecture whose completeness a static capture cannot verify, not a shortness
    // verdict.
    caseId: "generic_spa_deferred",
    file: "generic-spa-deferred.html",
    sha256: "ebcbc17fe2d0fb47d769a400c7ff276a12bb3a3fdbd9c9421ec3c2240fbf4285",
    adapter: "generic-html",
    request: Object.freeze({ status: 200, finalUrl: GENERIC_REF }),
    expectation: Object.freeze({
      outcome: "active",
      accessBarrier: null,
      retryable: false,
      structuralOk: true,
      reasons: Object.freeze(["deferred_content_suspected"]),
      textIncludes: Object.freeze([
        "detail-oriented Senior Automation Tester in JS",
        "English proficiency at B2 level or higher",
      ]),
      textExcludes: Object.freeze([
        "International projects with top brands",
        "Equal Opportunity Employer",
      ]),
    }),
  }),
  Object.freeze({
    // The negative that pins the 2x bound against a 1x world: a complete render whose island
    // mirrors it.
    caseId: "generic_spa_mirror",
    file: "generic-spa-mirror.html",
    sha256: "3308106df7794a9d762d34c926818bb8dc62f5ab7017907658f0b2cda8028ec7",
    adapter: "generic-html",
    request: Object.freeze({ status: 200, finalUrl: GENERIC_REF }),
    expectation: Object.freeze({
      outcome: "active",
      accessBarrier: null,
      retryable: false,
      structuralOk: true,
      reasons: Object.freeze([]),
      textIncludes: Object.freeze(["owning the regression suite"]),
      textExcludes: Object.freeze([]),
    }),
  }),
  Object.freeze({
    caseId: "generic_bundle_heavy",
    file: "generic-bundle-heavy.html",
    sha256: "689012aef3681038be829b2244718ca53a09f3f4925ea20c37829fdd01698c68",
    adapter: "generic-html",
    request: Object.freeze({ status: 200, finalUrl: GENERIC_REF }),
    expectation: Object.freeze({
      outcome: "active",
      accessBarrier: null,
      retryable: false,
      structuralOk: true,
      reasons: Object.freeze([]),
      textIncludes: Object.freeze(["owning the regression suite"]),
      textExcludes: Object.freeze(["exports"]),
    }),
  }),
  Object.freeze({
    caseId: "generic_json_malformed",
    file: "generic-json-malformed.html",
    sha256: "7174769e20499c5007cb7006db44b55120e442b7dac31abb4ecb05473418d9cc",
    adapter: "generic-html",
    request: Object.freeze({ status: 200, finalUrl: GENERIC_REF }),
    expectation: Object.freeze({
      outcome: "active",
      accessBarrier: null,
      retryable: false,
      structuralOk: true,
      reasons: Object.freeze([]),
      textIncludes: Object.freeze(["owning the regression suite"]),
      textExcludes: Object.freeze(["truncated by an upstream bug"]),
    }),
  }),
  Object.freeze({
    // Harvested capture pair of batch rollout-2026-08 record 14 — the reproduction this task
    // was filed on. Exercised by the dedicated capture-pair test below, not by adapter replay.
    caseId: "capture_adapter",
    file: "capture-rollout-2026-08-014-adapter.txt",
    sha256: "267ac24ccef03212877586d096e7e41f35c01a1ed5e579e5602e1e68dbf7d33d",
    adapter: null,
    expectation: null,
  }),
  Object.freeze({
    caseId: "capture_browser",
    file: "capture-rollout-2026-08-014-browser.txt",
    sha256: "34b12b32421e115d34ffb292f9ee8d41691f0feaa3e921b1a66488c056cfe339",
    adapter: null,
    expectation: null,
  }),
]);

const adapterById = new Map(
  vacancyFetchAdapters.map((adapter) => [adapter.id, adapter]),
);

function replayFixture(entry) {
  const adapter = adapterById.get(entry.adapter);
  const reading = adapter.interpret({
    transportFailure: null,
    status: entry.request.status,
    finalUrl: entry.request.finalUrl,
    contentType: entry.request.contentType ?? "text/html; charset=utf-8",
    body: readFixture(entry.file),
    context: entry.adapter === "linkedin-guest" ? { jobId: LINKEDIN_JOB_ID } : {},
  });
  const verdict = classifyDirectRoute({
    transportFailure: null,
    status: entry.request.status,
    antiBot: reading.antiBot,
    authWall: reading.authWall,
    statusWord: reading.statusWord,
    unlisted: reading.unlisted,
    hasPostingBody: reading.structural.minimumContentMet === true,
  });
  return { reading, verdict };
}

test("the fixture directory and the frozen manifest agree in both directions", () => {
  const onDisk = readdirSync(fixtureRoot).sort();
  assert.deepEqual(onDisk, fixtureManifest.map((entry) => entry.file).sort());
  assert.equal(fixtureManifest.length, 21);
});

test("every fixture file matches its frozen digest", () => {
  for (const entry of fixtureManifest) {
    assert.equal(
      sha256Utf8(readFixture(entry.file)),
      entry.sha256,
      `${entry.file} drifted from its frozen digest`,
    );
  }
});

test("every fixture case is replayed through its adapter and matches the frozen expectation", () => {
  const exercised = new Set();
  for (const entry of fixtureManifest) {
    if (entry.expectation === null) continue;
    exercised.add(entry.caseId);
    const { reading, verdict } = replayFixture(entry);
    const label = entry.caseId;
    assert.equal(verdict.outcome, entry.expectation.outcome, `${label} outcome`);
    assert.equal(verdict.accessBarrier, entry.expectation.accessBarrier, `${label} barrier`);
    assert.equal(verdict.retryable, entry.expectation.retryable, `${label} retryable`);
    assert.equal(reading.structuralOk, entry.expectation.structuralOk, `${label} structuralOk`);
    assert.deepEqual(
      [...reading.reasons].sort(),
      [...entry.expectation.reasons].sort(),
      `${label} reasons`,
    );
    for (const needle of entry.expectation.textIncludes) {
      assert.ok(
        (reading.text ?? "").includes(needle),
        `${label} should carry ${JSON.stringify(needle)}`,
      );
    }
    for (const needle of entry.expectation.textExcludes) {
      assert.equal(
        (reading.text ?? "").includes(needle),
        false,
        `${label} must not carry ${JSON.stringify(needle)}`,
      );
    }
  }
  // A manifest row that is never replayed is decoration; a case count that drifts is a rewritten
  // oracle. Both fail here rather than in a reviewer's reading.
  assert.equal(exercised.size, 18);
});

test("the harvested capture pair re-verifies and freezes the silent-partial divergence", () => {
  // The dated observation this task was filed on, replayable offline: the adapter body stops
  // before the blocks the browser body carries. A harvest is evidence of one page on one day,
  // never live-route verification — the directory README owns that boundary.
  const adapterCapture = verifyCaptureFile(
    readFixture("capture-rollout-2026-08-014-adapter.txt"),
  );
  const browserCapture = verifyCaptureFile(
    readFixture("capture-rollout-2026-08-014-browser.txt"),
  );
  assert.equal(adapterCapture.ok, true);
  assert.deepEqual(adapterCapture.problems, []);
  assert.equal(browserCapture.ok, true);
  assert.deepEqual(browserCapture.problems, []);

  const adapterBody = adapterCapture.body;
  const browserBody = browserCapture.body;
  const deferredBlocks = [
    "We offer/Benefits",
    "International projects with top brands",
    "Unlimited access to the LinkedIn Learning library",
    "Equal Opportunity Employer",
  ];
  for (const block of deferredBlocks) {
    assert.ok(browserBody.includes(block), `browser body should carry ${JSON.stringify(block)}`);
    assert.equal(
      adapterBody.includes(block),
      false,
      `adapter body must lack ${JSON.stringify(block)}`,
    );
  }
  // Both captures are of the same posting: the shared description prefix is present in both.
  assert.ok(adapterBody.includes("detail-oriented Senior Automation Tester in JS"));
  assert.ok(browserBody.includes("detail-oriented Senior Automation Tester in JS"));
});

test("deferred-content measurement: prose shape, typed islands only, malformed and budget facts", () => {
  // Prose shape: ids, urls and short labels count as zero; sentence-shaped values count their
  // tag-stripped length.
  assert.equal(proseCharCount("short label"), 0);
  assert.equal(proseCharCount("id-3f9a8c7b2e514d6f0a1b9c8d7e6f5a4b"), 0);
  const sentence = "we build settlement software and test every release before it ships";
  assert.equal(proseCharCount(sentence), sentence.length);
  // Each of the four tags strips to one space around the 43-char sentence: 47.
  assert.equal(
    proseCharCount("<ul><li>quarterly bonus tied to reliability targets</li></ul>"),
    47,
  );

  // Typed islands are measured; untyped code scripts are not. ld+json counts as typed.
  const prose = "a paragraph of benefits prose that spans well over thirty characters";
  const page = (islands) => `<html><body><main><p>x</p></main>${islands}</body></html>`;
  const typed = measureJsonIslandProse(
    page(`<script type="application/json">{"a":${JSON.stringify(prose)}}</script>`
      + `<script>var s = ${JSON.stringify(prose)};</script>`),
  );
  assert.deepEqual(typed, {
    jsonProseChars: prose.length,
    jsonIslandCount: 1,
    jsonIslandUnparsed: false,
    jsonWalkBudgetHit: false,
  });
  const ld = measureJsonIslandProse(
    page(`<script type="application/ld+json">{"description":${JSON.stringify(prose)}}</script>`),
  );
  assert.equal(ld.jsonProseChars, prose.length);
  assert.equal(ld.jsonIslandCount, 1);

  // Hostile density: a value of a hundred thousand unclosed `<` is one pass for the index-scan
  // strip. The quadratic regex this replaced took ~14 s here and minutes at transport scale — a
  // reintroduction makes this case crawl, which the suite's wall clock exposes loudly.
  assert.equal(proseCharCount("<".repeat(100_000)), 0);
  const dense = measureJsonIslandProse(
    page(`<script type="application/json">${JSON.stringify({ a: "<".repeat(100_000) })}</script>`),
  );
  assert.equal(dense.jsonProseChars, 0);
  assert.equal(dense.jsonIslandCount, 1);

  // A browser never runs a commented-out or CDATA-wrapped script, so neither may fire here.
  const hidden = measureJsonIslandProse(
    page(`<!-- <script type="application/json">{"a":${JSON.stringify(prose)}}</script> -->`
      + `<![CDATA[ <script type="application/json">{"b":${JSON.stringify(prose)}}</script> ]]>`
      + `<script type="application/json">{"c":${JSON.stringify(prose)}}</script>`),
  );
  assert.equal(hidden.jsonIslandCount, 1);
  assert.equal(hidden.jsonProseChars, prose.length);
  // A comment after the island masks nothing.
  const trailing = measureJsonIslandProse(
    page(`<script type="application/json">{"c":${JSON.stringify(prose)}}</script><!-- x -->`),
  );
  assert.equal(trailing.jsonIslandCount, 1);
  assert.equal(trailing.jsonProseChars, prose.length);

  // The two shapes that made the naive scan quadratic, at tripwire scale: a comment field
  // before one island, and a field of tiny islands with no comment at all. Linear cursors
  // finish both in milliseconds; a reintroduced per-iteration search crawls for tens of
  // seconds here, which the suite's wall clock exposes loudly.
  const commentField = measureJsonIslandProse(
    page(`${"<!---->".repeat(100_000)}<script type="application/json">{"z":${JSON.stringify(prose)}}</script>`),
  );
  assert.equal(commentField.jsonIslandCount, 1);
  assert.equal(commentField.jsonProseChars, prose.length);
  const islandField = measureJsonIslandProse(
    page(`<script type="application/json">1</script>`.repeat(20_000)),
  );
  assert.equal(islandField.jsonIslandCount, 20_000);
  assert.equal(islandField.jsonProseChars, 0);

  // A malformed typed island records the fact, measures nothing from that island, and leaves
  // other islands counted.
  const malformed = measureJsonIslandProse(
    page(`<script type="application/json">{"broken": [</script>`
      + `<script type="application/json">{"ok":${JSON.stringify(prose)}}</script>`),
  );
  assert.equal(malformed.jsonIslandUnparsed, true);
  assert.equal(malformed.jsonProseChars, prose.length);
  assert.equal(malformed.jsonIslandCount, 2);

  // The walk budget is a parameter with a frozen default, so the breach path is exercisable
  // here without a megabyte fixture: three values of budget cannot finish an island of many.
  assert.equal(jsonWalkValueBudget, 250_000);
  const breached = measureJsonIslandProse(
    page(`<script type="application/json">{"a":[1,2,3,4,5,6,7,8],"b":${JSON.stringify(prose)}}</script>`),
    { valueBudget: 3 },
  );
  assert.equal(breached.jsonWalkBudgetHit, true);
  // Both arms of the verdict, exercised where they live: a budget breach fires with zero
  // measured prose, and without a breach the ratio arm alone decides.
  assert.equal(
    deferredContentSuspected({ jsonProseChars: 0, jsonWalkBudgetHit: true }, 5000),
    true,
  );
  assert.equal(
    deferredContentSuspected({ jsonProseChars: 0, jsonWalkBudgetHit: false }, 0),
    false,
  );

  // The threshold is exact and two-sided: prose equal to ratio × extracted fires, one character
  // short of it does not. The ratio is frozen as a literal here, never read back as arithmetic
  // from the constant under test.
  assert.equal(deferredContentThresholdRatio, 2);
  const filler = "posting body word ".repeat(40).trim();
  const buildBody = (proseChars) => {
    const value = "p ".repeat(Math.ceil(proseChars / 2)).slice(0, proseChars);
    return [
      "<html><body><main><p>",
      filler,
      "</p></main>",
      `<script type="application/json">{"v":${JSON.stringify(value)}}</script>`,
      "</body></html>",
    ].join("");
  };
  const probe = genericHtmlAdapter.interpret({
    transportFailure: null,
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: buildBody(64),
  });
  const extracted = probe.text.length;
  const atThreshold = genericHtmlAdapter.interpret({
    transportFailure: null,
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: buildBody(2 * extracted),
  });
  const belowThreshold = genericHtmlAdapter.interpret({
    transportFailure: null,
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: buildBody(2 * extracted - 1),
  });
  assert.equal(atThreshold.text.length, extracted);
  assert.equal(belowThreshold.text.length, extracted);
  assert.ok(atThreshold.reasons.includes("deferred_content_suspected"));
  assert.equal(belowThreshold.reasons.includes("deferred_content_suspected"), false);
  // The record stays usable either way at this size: the signal is advisory, not structural.
  assert.equal(atThreshold.structuralOk, belowThreshold.structuralOk);
});

test("the HTML scanner keeps visible text and drops what a page never shows", () => {
  const { root } = parseHtml([
    "<!doctype html><html><head><title>Tab title</title>",
    "<style>.x{color:red}</style><meta charset=\"utf-8\"></head><body>",
    "<script>var a = \"<p>fake</p>\";</script>",
    "<noscript><p>no script here</p></noscript>",
    "<p>First</p><p>Second",
    "<ul><li>Alpha<li>Beta</ul>",
    "<div>Third<br>Fourth</div>",
    "<pre>keep\nlines</pre>",
    "</wrong>",
    "<p>5 < 6 and &amp; and &#65;</p>",
    "</body></html>",
  ].join(""));
  // The collector emits raw block boundaries; the logged normalization pass owns blank-run
  // collapsing, so the pipeline's own composition is what this asserts.
  const text = normalizeExtractedText(collectText(root)).text;

  for (const dropped of ["Tab title", "color:red", "fake", "no script here"]) {
    assert.equal(text.includes(dropped), false, dropped);
  }
  assert.equal(
    text,
    [
      "First",
      "",
      "Second",
      "",
      "Alpha",
      "",
      "Beta",
      "",
      "Third",
      "",
      "Fourth",
      "",
      "keep",
      "lines",
      "",
      "5 < 6 and & and A",
      "",
    ].join("\n"),
  );
  // A stray close tag closes nothing: honouring it would unwind to the root and merge sections.
  assert.equal(text.includes("</wrong>"), false);
});

test("character references resolve, and an unknown one stays literal", () => {
  assert.equal(decodeEntities("&amp;&lt;&gt;&quot;&#65;&#x42;"), "&<>\"AB");
  assert.equal(decodeEntities("&notanentity;"), "&notanentity;");
  assert.equal(decodeEntities("&#xD800;"), "&#xD800;");
  assert.equal(decodeEntities("&#0;"), "&#0;");
  assert.equal(decodeEntities("no references"), "no references");
  // A semicolon far from the ampersand belongs to prose, not to a reference.
  assert.equal(decodeEntities("a & b; c"), "a & b; c");
  assert.equal(decodeEntities("10&nbsp;EUR"), "10 EUR");
});

function measuredDepth(root) {
  let deepest = 0;
  const stack = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop();
    if (depth > deepest) deepest = depth;
    for (const child of node.children ?? []) {
      if (child.type === "element") stack.push({ node: child, depth: depth + 1 });
    }
  }
  return deepest;
}

test("the scanner bounds nesting depth instead of overflowing the stack", () => {
  const depth = 5000;
  const nested = `${"<div>".repeat(depth)}deep${"</div>".repeat(depth)}`;
  const parsed = parseHtml(nested);
  assert.equal(parsed.depthCeilingHit, true);
  // 256 is the ceiling the module declares. Frozen as a literal here rather than imported, so a
  // widened ceiling has to be a deliberate edit in two places.
  assert.ok(measuredDepth(parsed.root) <= 256, `measured depth ${measuredDepth(parsed.root)}`);
  // Bounded, not broken: the text is still recovered and the recursive collector does not
  // overflow, which is the property the ceiling exists to buy.
  assert.match(collectText(parsed.root), /deep/u);
  assert.ok(walkElements(parsed.root).length > 0);
});

test("the scanner bounds node count on a document built to exhaust it", () => {
  const parsed = parseHtml("<p>x</p>".repeat(120_000));
  assert.equal(parsed.nodeCeilingHit, true);
  assert.ok(parsed.nodes <= 200_000, `counted ${parsed.nodes}`);
});

test("a stray close tag cannot move content out of its container", () => {
  // Honouring an unmatched close tag unwinds the stack, and everything after it becomes a
  // sibling of the container instead of its child - silently truncating a job description at
  // whatever stray tag a page happens to carry.
  const { root } = parseHtml([
    "<div class=\"description__text\"><div class=\"show-more-less-html__markup\">",
    "<p>Before the stray tag</p></section><p>After the stray tag</p>",
    "</div></div>",
  ].join(""));
  const container = findElement(root, (node) =>
    hasClassContaining(node, "show-more-less-html__markup"));
  assert.notEqual(container, null);
  const contained = collectText(container);
  assert.match(contained, /Before the stray tag/u);
  assert.match(contained, /After the stray tag/u);
});

test("class helpers read the attribute they claim to read", () => {
  const { root } = parseHtml(
    "<div class='alpha show-more-less-html__markup beta'><p>Body</p></div>",
  );
  const container = findElement(root, (node) =>
    hasClassContaining(node, "show-more-less-html__markup"));
  assert.notEqual(container, null);
  assert.equal(findElement(root, (node) => hasClassContaining(node, "absent")), null);
  assert.deepEqual(genericChromeTags, ["aside", "footer", "form", "header", "nav"]);
});

test("the normalization pass logs every rule, its count and the digests around it", () => {
  const extracted = "﻿Senior QA​ Engineer  \r\n\r\n\r\n\r\nSecond­line\n\n";
  const pass = normalizeExtractedText(extracted);

  assert.equal(pass.text, "Senior QA Engineer\n\nSecondline\n");
  assert.equal(pass.log.beforeSha256, sha256Utf8(extracted));
  assert.equal(pass.log.afterSha256, sha256Utf8(pass.text));
  assert.equal(pass.log.changed, true);
  assert.deepEqual(pass.log.rules.map((rule) => rule.id),
    normalizationRules.map((rule) => rule.id));
  const counts = Object.fromEntries(
    pass.log.rules.map((rule) => [rule.id, rule.replacements]),
  );
  assert.deepEqual(counts, {
    strip_bom: 1,
    crlf_to_lf: 4,
    nbsp_to_space: 1,
    remove_zero_width: 2,
    nfc: 0,
    trim_line_trailing_whitespace: 1,
    collapse_blank_runs: 1,
    single_trailing_newline: 1,
  });
});

test("the normalization pass is idempotent and records a no-op honestly", () => {
  const once = normalizeExtractedText("Already clean\n\nText\n");
  assert.equal(once.log.changed, false);
  assert.equal(once.log.beforeSha256, once.log.afterSha256);
  assert.deepEqual(once.log.rules.filter((rule) => rule.replacements > 0), []);
  const twice = normalizeExtractedText(normalizeExtractedText("A B\r\n\n\n\nC").text);
  assert.equal(twice.log.changed, false);
});

test("the normalization pass composes decomposed characters instead of rewriting words", () => {
  const decomposed = "Café role\n";
  const pass = normalizeExtractedText(decomposed);
  assert.equal(pass.text, "Café role\n");
  assert.equal(
    pass.log.rules.find((rule) => rule.id === "nfc").replacements,
    1,
  );
  // The before-digest describes the bytes as they arrived, not the bytes after any rule ran. A
  // log whose "before" was taken after normalization would report a chain of custody it does not
  // have, and this input is the one where the two differ.
  assert.equal(pass.log.beforeSha256, sha256Utf8(decomposed));
  assert.notEqual(pass.log.beforeSha256, pass.log.afterSha256);
  assert.equal(pass.log.afterSha256, sha256Utf8(pass.text));
  assert.equal(pass.log.changed, true);
});

test("the ADR 0012 status table resolves one row per observation", () => {
  const rows = [
    // A block page is not a posting, and the status it arrives under says nothing about it.
    [{ antiBot: true, status: 200 }, "access_failure", "anti_bot"],
    [{ antiBot: true, status: 404 }, "access_failure", "anti_bot"],
    [{ antiBot: true, status: 999 }, "access_failure", "anti_bot"],
    [{ status: 404 }, "absent", null],
    [{ status: 410 }, "absent", null],
    [{ status: 401 }, "access_failure", "authentication"],
    [{ status: 403 }, "access_failure", "authentication"],
    [{ authWall: true, status: 200 }, "access_failure", "authentication"],
    [{ status: 429 }, "access_failure", "rate_limit"],
    [{ status: 500 }, "access_failure", "http_status"],
    [{ status: 503 }, "access_failure", "http_status"],
    [{ transportFailure: "network_error" }, "access_failure", "network"],
    [{ transportFailure: "timeout" }, "access_failure", "network"],
    [{ transportFailure: "oversize" }, "access_failure", "unparseable"],
    [{ transportFailure: "redirect_ceiling" }, "access_failure", "unparseable"],
    [{ status: 200, statusWord: "archived", hasPostingBody: true }, "closed", null],
    [{ status: 200, statusWord: "filled", hasPostingBody: true }, "closed", null],
    [{ status: 200, statusWord: "confidential", hasPostingBody: true }, "private", null],
    [{ status: 200, unlisted: true, hasPostingBody: true }, "private", null],
    [{ status: 200, hasPostingBody: true }, "active", null],
    // An unknown status word stays active on purpose: refusing it turns a live vacancy into a
    // failure, which is the harm class the Step 1 findings are about.
    [{ status: 200, statusWord: "on hold", hasPostingBody: true }, "active", null],
    [{ status: 200, hasPostingBody: false }, "access_failure", "unparseable"],
    [{ status: 204, hasPostingBody: true }, "access_failure", "unparseable"],
    [{ status: 302, hasPostingBody: true }, "access_failure", "unparseable"],
    [{ status: null }, "access_failure", "unparseable"],
  ];
  for (const [observation, outcome, barrier] of rows) {
    const verdict = classifyDirectRoute({ transportFailure: null, ...observation });
    const label = JSON.stringify(observation);
    assert.equal(verdict.outcome, outcome, label);
    assert.equal(verdict.accessBarrier, barrier, label);
    assert.ok(outcomeNames.includes(verdict.outcome), label);
    if (barrier !== null) assert.ok(accessBarriers.includes(barrier), label);
  }
});

test("a stated closed word wins over a listing flag, so one condition keeps one name", () => {
  const verdict = classifyDirectRoute({
    transportFailure: null,
    status: 200,
    statusWord: "archived",
    unlisted: true,
    hasPostingBody: true,
  });
  assert.equal(verdict.outcome, "closed");
});

test("only access_failure is retryable, and no barrier is ever terminal", () => {
  for (const [outcome, retryable] of [
    ["active", false],
    ["absent", false],
    ["closed", false],
    ["private", false],
  ]) {
    const verdict = classifyDirectRoute({
      transportFailure: null,
      status: outcome === "absent" ? 404 : 200,
      statusWord: outcome === "closed" ? "archived" : outcome === "private" ? "internal" : null,
      hasPostingBody: outcome === "active",
    });
    assert.equal(verdict.outcome, outcome);
    assert.equal(verdict.retryable, retryable, outcome);
  }
  for (const barrier of accessBarriers) {
    const verdict = classifyDirectRoute({
      antiBot: barrier === "anti_bot",
      authWall: barrier === "authentication",
      status: barrier === "rate_limit" ? 429 : barrier === "http_status" ? 500 : 200,
      transportFailure: barrier === "network" ? "network_error" : null,
      hasPostingBody: false,
    });
    assert.equal(verdict.retryable, true, barrier);
    assert.equal(verdict.outcome, "access_failure", barrier);
  }
});

test("a terminal unavailability verdict is reachable only from a stated word or a 404/410", () => {
  // Every status other than 404/410, with no first-party statement, must stay non-terminal.
  const terminal = new Set(["absent", "closed", "private"]);
  for (const status of [200, 201, 202, 204, 301, 302, 400, 401, 403, 405, 418, 429, 500, 503, 999]) {
    const verdict = classifyDirectRoute({
      transportFailure: null,
      status,
      hasPostingBody: true,
    });
    assert.equal(terminal.has(verdict.outcome), false, `status ${status}`);
  }
});

test("the bounded status vocabulary is single-sourced from the routes module", () => {
  assert.equal(classifyStatusWord("Archived"), "closed");
  assert.equal(classifyStatusWord("  UNLISTED "), "private");
  assert.equal(classifyStatusWord("paused"), null);
  assert.equal(classifyStatusWord(""), null);
  assert.equal(classifyStatusWord(null), null);
});

test("the URL rule drops what a redirect target should never persist", () => {
  const withSecrets =
    "https://login.example.com/oauth/callback?code=SECRET&state=ALSOSECRET#access_token=TOKEN";
  assert.equal(serverSuppliedUrl(withSecrets), "https://login.example.com/oauth/callback");
  // The requested URL keeps its query, because process identity is computed from exactly that.
  assert.equal(
    requestedUrl("https://boards.example.com/jobs?gh_jid=42#fragment"),
    "https://boards.example.com/jobs?gh_jid=42",
  );
  assert.equal(parseHttpUrl("ftp://example.com/x"), null);
  assert.equal(parseHttpUrl("javascript:alert(1)"), null);
  assert.equal(parseHttpUrl("not a url"), null);
  assert.equal(serverSuppliedUrl("mailto:someone@example.com"), null);
});

test("a capture file round-trips through its own stamped header", () => {
  const body = "Senior QA Automation Engineer\n\nFull description.\n";
  const file = renderCaptureFile({
    header: {
      index: 7,
      adapter: "generic-html@1",
      "source-id": null,
      "requested-url": GENERIC_REF,
      "final-url": GENERIC_REF,
      "fetched-at": "2026-08-18T10:00:00.000Z",
      "http-status": 200,
      outcome: "active",
      "access-barrier": null,
      "response-sha256": "a".repeat(64),
      "response-bytes": 4096,
      "extracted-sha256": "b".repeat(64),
      "normalized-sha256": sha256Utf8(body),
      "body-bytes": Buffer.byteLength(body, "utf8"),
      normalization: "nfc=1",
    },
    body,
  });
  const verified = verifyCaptureFile(file);
  assert.deepEqual(verified.problems, []);
  assert.equal(verified.ok, true);
  assert.equal(verified.body, body);
  assert.equal(verified.header["source-id"], "-");
  assert.equal(verified.header.outcome, "active");
  // The delimiter is the structural boundary, and the header is human-readable above it.
  assert.ok(file.startsWith("# vacancy-fetch capture v1\n"));
  assert.ok(file.includes(`\n${captureBodyDelimiter}\n`));
  assert.equal(captureBasename(7), "007.capture.txt");
  assert.equal(manifestBasename, "fetch-manifest.json");
});

test("an edited capture body fails its own digest and size check", () => {
  const body = "Original description text.\n";
  const file = renderCaptureFile({
    header: {
      index: 1,
      adapter: "generic-html@1",
      "source-id": null,
      "requested-url": GENERIC_REF,
      "final-url": GENERIC_REF,
      "fetched-at": "2026-08-18T10:00:00.000Z",
      "http-status": 200,
      outcome: "active",
      "access-barrier": null,
      "response-sha256": "a".repeat(64),
      "response-bytes": 10,
      "extracted-sha256": "b".repeat(64),
      "normalized-sha256": sha256Utf8(body),
      "body-bytes": Buffer.byteLength(body, "utf8"),
      normalization: "none",
    },
    body,
  });
  assert.deepEqual(
    verifyCaptureFile(file.replace("Original", "Fabricated")).problems,
    ["capture_digest_mismatch", "capture_size_mismatch"],
  );
  // A same-length substitution is still caught, because the digest is over the bytes and the
  // size check alone would pass.
  assert.deepEqual(
    verifyCaptureFile(file.replace("Original", "Fabrikat")).problems,
    ["capture_digest_mismatch"],
  );
  assert.deepEqual(verifyCaptureFile("no delimiter here").problems,
    ["capture_delimiter_absent"]);
  assert.deepEqual(verifyCaptureFile("").problems, ["capture_empty"]);
});

test("a capture header value can never carry a line break", () => {
  assert.throws(() => renderCaptureFile({
    header: { index: "1\n# outcome: active", adapter: "x@1" },
    body: "b\n",
  }), /single-line/u);
});

test("a body line that imitates the delimiter does not move the header boundary", () => {
  const body = `First line\n${captureBodyDelimiter}\n# outcome: active\n`;
  const file = renderCaptureFile({
    header: {
      index: 1,
      adapter: "generic-html@1",
      "source-id": null,
      "requested-url": GENERIC_REF,
      "final-url": GENERIC_REF,
      "fetched-at": "2026-08-18T10:00:00.000Z",
      "http-status": 200,
      outcome: "closed",
      "access-barrier": null,
      "response-sha256": "a".repeat(64),
      "response-bytes": 10,
      "extracted-sha256": "b".repeat(64),
      "normalized-sha256": sha256Utf8(body),
      "body-bytes": Buffer.byteLength(body, "utf8"),
      normalization: "none",
    },
    body,
  });
  const verified = verifyCaptureFile(file);
  assert.deepEqual(verified.problems, []);
  // The first delimiter wins, so the imitation stays inside the body where it belongs.
  assert.equal(verified.header.outcome, "closed");
  assert.equal(verified.body, body);
});

// Every route is a factory, so each call builds a fresh `Response`. Cloning one instead would
// tee its body stream, and a teed branch behaves differently from a real response body.
function stubFetch(routes, calls = []) {
  return async (url, options) => {
    calls.push({ url, headers: options?.headers ?? null, redirect: options?.redirect });
    const entry = routes.get(url);
    if (entry === undefined) throw new TypeError("fetch failed");
    return entry();
  };
}

function htmlResponse(body, { status = 200, headers = {} } = {}) {
  return () => new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function redirectResponse(location, status = 302) {
  return () => new Response(null, { status, headers: { location } });
}

test("the transport records the redirect chain narrowed by the URL rule", async () => {
  const calls = [];
  const routes = new Map([
    ["https://jobs.example.com/a",
      redirectResponse("https://jobs.example.com/b?token=SECRET#frag")],
    ["https://jobs.example.com/b?token=SECRET",
      htmlResponse("<main>body</main>", { headers: { "set-cookie": "session=abc" } })],
  ]);
  const result = await fetchDocument({
    url: "https://jobs.example.com/a",
    headers: defaultRequestHeaders,
    fetchImpl: stubFetch(routes, calls),
  });

  assert.equal(result.transportFailure, null);
  assert.equal(result.status, 200);
  assert.deepEqual(result.redirectChain, [
    { status: 302, url: "https://jobs.example.com/b" },
  ]);
  assert.equal(result.finalUrl, "https://jobs.example.com/b");
  assert.equal(result.charset, "utf-8");
  assert.match(result.body, /body/u);
  // Redirects are followed by this module, never by the runtime, because the chain is evidence.
  assert.deepEqual(calls.map((call) => call.redirect), ["manual", "manual"]);
});

test("the transport records only allowlisted response headers", async () => {
  const routes = new Map([
    ["https://jobs.example.com/x", htmlResponse("<main>body</main>", {
      status: 401,
      headers: {
        "content-length": "18",
        etag: "\"abc\"",
        "retry-after": "120",
        "set-cookie": "session=SECRET; HttpOnly",
        "www-authenticate": "Bearer realm=\"corp\", error=\"invalid_token\"",
        "x-request-id": "should-not-be-recorded",
        location: "https://login.example.com/oauth?code=SECRET",
      },
    })],
  ]);
  const result = await fetchDocument({
    url: "https://jobs.example.com/x",
    headers: defaultRequestHeaders,
    fetchImpl: stubFetch(routes),
  });
  const recorded = Object.keys(result.headers).sort();
  assert.deepEqual(recorded, [
    "content-length",
    "content-type",
    "etag",
    "location",
    "retry-after",
    "www-authenticate-scheme",
  ]);
  // The challenge scheme without its parameters, and the location without its query.
  assert.equal(result.headers["www-authenticate-scheme"], "bearer");
  assert.equal(result.headers.location, "https://login.example.com/oauth");
  for (const forbidden of ["set-cookie", "x-request-id"]) {
    assert.equal(Object.hasOwn(result.headers, forbidden), false, forbidden);
  }
  assert.deepEqual(recordedResponseHeaders.includes("set-cookie"), false);
});

test("the transport fails closed on each bounded ceiling", async () => {
  const oversize = await fetchDocument({
    url: "https://jobs.example.com/big",
    headers: defaultRequestHeaders,
    maxBytes: 64,
    fetchImpl: stubFetch(new Map([
      ["https://jobs.example.com/big", htmlResponse("x".repeat(4096))],
    ])),
  });
  assert.equal(oversize.transportFailure, "oversize");
  assert.equal(oversize.body, "");

  const hop = (n) => [
    `https://jobs.example.com/r${n}`,
    redirectResponse(`https://jobs.example.com/r${n + 1}`),
  ];
  const chain = await fetchDocument({
    url: "https://jobs.example.com/r0",
    headers: defaultRequestHeaders,
    maxRedirects: 2,
    fetchImpl: stubFetch(new Map([hop(0), hop(1), hop(2), hop(3)])),
  });
  assert.equal(chain.transportFailure, "redirect_ceiling");
  assert.equal(chain.redirectChain.length, 3);

  const badScheme = await fetchDocument({
    url: "https://jobs.example.com/bad",
    headers: defaultRequestHeaders,
    fetchImpl: stubFetch(new Map([
      ["https://jobs.example.com/bad", redirectResponse("javascript:alert(1)")],
    ])),
  });
  assert.equal(badScheme.transportFailure, "invalid_redirect");

  const dead = await fetchDocument({
    url: "https://jobs.example.com/unreachable",
    headers: defaultRequestHeaders,
    fetchImpl: stubFetch(new Map()),
  });
  assert.equal(dead.transportFailure, "network_error");

  const abandoned = await fetchDocument({
    url: "https://jobs.example.com/slow",
    headers: defaultRequestHeaders,
    fetchImpl: async (_url, options) => {
      // The caller's own signal, not a wall-clock wait: the suite never sleeps.
      const error = new Error("aborted");
      error.name = "AbortError";
      assert.ok(options.signal instanceof AbortSignal);
      throw error;
    },
  });
  assert.ok(transportFailureCodes.includes(abandoned.transportFailure));
  assert.equal(abandoned.transportFailure, "aborted");
});

test("the transport decodes a declared charset and counts replacements", async () => {
  const latin1 = Buffer.from("<main>Caf\xe9 role and a long enough body</main>", "latin1");
  const declared = await fetchDocument({
    url: "https://jobs.example.com/latin1",
    headers: defaultRequestHeaders,
    fetchImpl: stubFetch(new Map([
      ["https://jobs.example.com/latin1",
        () => new Response(latin1, {
          status: 200,
          headers: { "content-type": "text/html; charset=iso-8859-1" },
        })],
    ])),
  });
  assert.equal(declared.charset, "iso-8859-1");
  assert.match(declared.body, /Café role/u);
  assert.equal(declared.replacementCount, 0);

  // No declared charset: the `<meta charset>` prologue is the only remaining evidence.
  const sniffed = await fetchDocument({
    url: "https://jobs.example.com/meta",
    headers: defaultRequestHeaders,
    fetchImpl: stubFetch(new Map([
      ["https://jobs.example.com/meta", () => new Response(
        Buffer.from("<html><head><meta charset=\"iso-8859-1\"></head><body>Caf\xe9</body>", "latin1"),
        { status: 200, headers: { "content-type": "text/html" } },
      )],
    ])),
  });
  assert.equal(sniffed.declaredCharset, "iso-8859-1");
  assert.match(sniffed.body, /Café/u);

  // Undeclared invalid UTF-8 is decoded with replacement characters and counted, not dropped.
  const broken = await fetchDocument({
    url: "https://jobs.example.com/broken",
    headers: defaultRequestHeaders,
    fetchImpl: stubFetch(new Map([
      ["https://jobs.example.com/broken", () => new Response(
        Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x70, 0x3e]),
        { status: 200, headers: { "content-type": "text/html" } },
      )],
    ])),
  });
  assert.equal(broken.replacementCount > 0, true);
  assert.equal(transportDefaults.maxRedirects, 5);
});

test("the LinkedIn job id is read only from shapes that identify one posting", () => {
  for (const [reference, expected] of [
    [LINKEDIN_REF, LINKEDIN_JOB_ID],
    [`${LINKEDIN_REF}/?refId=abc&trackingId=xyz`, LINKEDIN_JOB_ID],
    [`https://www.linkedin.com/jobs/view/${LINKEDIN_JOB_ID}`, LINKEDIN_JOB_ID],
    [`https://uk.linkedin.com/jobs/view/role-${LINKEDIN_JOB_ID}`, LINKEDIN_JOB_ID],
    [
      `https://www.linkedin.com/jobs/collections/recommended/?currentJobId=${LINKEDIN_JOB_ID}`,
      LINKEDIN_JOB_ID,
    ],
    ["https://www.linkedin.com/jobs/view/no-id-here", null],
    ["https://www.linkedin.com/company/northwind-payments/jobs", null],
    ["https://www.linkedin.example.com/jobs/view/1234567890", null],
    ["https://notlinkedin.com/jobs/view/1234567890", null],
    ["https://www.linkedin.com/feed/view/1234567890", null],
    ["not a url", null],
  ]) {
    assert.equal(extractJobId(reference), expected, reference);
  }
});

test("adapter selection prefers a dedicated adapter and never leaves a URL unserved", () => {
  assert.equal(selectAdapter(LINKEDIN_REF).id, "linkedin-guest");
  assert.equal(selectAdapter(GENERIC_REF).id, "generic-html");
  assert.equal(selectAdapter("https://hh.ru/vacancy/123").id, "generic-html");
  // A LinkedIn URL that identifies no single posting is served by the fallback, not refused.
  assert.equal(selectAdapter("https://www.linkedin.com/jobs/search").id, "generic-html");
  assert.equal(fallbackAdapter.id, "generic-html");
  assert.deepEqual(dedicatedAdapters.map((entry) => entry.id), ["linkedin-guest"]);
  assert.deepEqual(vacancyFetchAdapters.map((entry) => entry.id),
    ["linkedin-guest", "generic-html"]);
  // Source identification stays single-sourced through the registry.
  assert.equal(sourceIdFor(LINKEDIN_REF), "linkedin");
  assert.equal(sourceIdFor("https://hh.ru/vacancy/123"), "hh_ru");
  assert.equal(sourceIdFor(GENERIC_REF), null);
});

test("the LinkedIn adapter requests exactly the canonical guest route", () => {
  const route = linkedinGuestAdapter.route(`${LINKEDIN_REF}?trk=public`);
  assert.equal(route.url, GUEST_URL);
  assert.equal(route.method, "GET");
  assert.equal(route.context.jobId, LINKEDIN_JOB_ID);
  assert.equal(route.headers, defaultRequestHeaders);
  assert.equal(
    linkedinGuestRoute.urlTemplate,
    "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{JOB_ID}",
  );
  // The route fact carries the same disclaimer every route fact in this repository carries.
  assert.match(linkedinGuestRoute.verification, /not verified by this repository/u);
  assert.equal(linkedinGuestAdapter.route("https://www.linkedin.com/jobs/search"), null);

  const overridden = linkedinGuestAdapter.route(LINKEDIN_REF, { userAgent: "custom-agent/1" });
  assert.equal(overridden.headers["user-agent"], "custom-agent/1");
  assert.equal(overridden.headers.accept, defaultRequestHeaders.accept);
});

test("the generic adapter refuses a non-markup body instead of parsing it as markup", () => {
  const reading = genericHtmlAdapter.interpret({
    transportFailure: null,
    status: 200,
    finalUrl: GENERIC_REF,
    contentType: "application/pdf",
    body: "%PDF-1.7 binary-ish",
  });
  assert.deepEqual(reading.reasons, ["unsupported_content_type"]);
  assert.equal(reading.text, null);
  assert.equal(reading.structuralOk, false);

  // A plain-text body is used as-is: there is no markup to extract and no reason to refuse it.
  const plain = genericHtmlAdapter.interpret({
    transportFailure: null,
    status: 200,
    finalUrl: GENERIC_REF,
    contentType: "text/plain; charset=utf-8",
    body: "Senior QA Automation Engineer. ".repeat(30),
  });
  assert.equal(plain.structuralOk, true);
  assert.equal(plain.structural.semanticContainer, false);
});

test("the generic adapter never reaches a first-party terminal verdict", () => {
  // It reads no status vocabulary and no listing flag, so `closed` and `private` are
  // unreachable through it however the page is worded.
  const reading = genericHtmlAdapter.interpret({
    transportFailure: null,
    status: 200,
    finalUrl: GENERIC_REF,
    contentType: "text/html",
    body: `<main><p>This position is archived and unlisted. ${"Filler text. ".repeat(60)}</p></main>`,
  });
  assert.equal(reading.statusWord, null);
  assert.equal(reading.unlisted, false);
  const verdict = classifyDirectRoute({
    transportFailure: null,
    status: 200,
    antiBot: reading.antiBot,
    authWall: reading.authWall,
    statusWord: reading.statusWord,
    unlisted: reading.unlisted,
    hasPostingBody: true,
  });
  assert.equal(verdict.outcome, "active");
});

test("every adapter's structural verdict implies its minimum-content check", () => {
  // The invariant the batch's fallback rule rests on: `structuralOk` implies `minimumContentMet`,
  // which implies a persisted body, which is `usable`. That is why a trusted `closed` verdict needs
  // no separate terminal term. An adapter that reports `structuralOk` without enough content to be
  // a job description breaks the rule silently, so it breaks this test loudly instead.
  const filler = "Description filler text. ".repeat(40);
  const bodies = [
    "",
    "<main></main>",
    "<main><p>Too short to be a description.</p></main>",
    `<main><p>${filler}</p></main>`,
    `<main><div class="description__text"><div class="show-more-less-html__markup">`
      + `<p>${filler}</p></div></div></main>`,
    `<main><div class="description__text"><p>Short.</p></div></main>`,
    `<main><p>No longer accepting applications</p><p>${filler}</p></main>`,
  ];
  const observedTrue = new Map(vacancyFetchAdapters.map((adapter) => [adapter.id, 0]));
  for (const adapter of vacancyFetchAdapters) {
    for (const body of bodies) {
      const reading = adapter.interpret({
        transportFailure: null,
        status: 200,
        finalUrl: adapter.id === "linkedin-guest" ? GUEST_URL : GENERIC_REF,
        contentType: "text/html",
        body: `${body}<a href="/jobs/view/role-${LINKEDIN_JOB_ID}">job</a>`,
        context: { jobId: LINKEDIN_JOB_ID },
      });
      if (reading.structuralOk) {
        observedTrue.set(adapter.id, observedTrue.get(adapter.id) + 1);
        assert.equal(
          reading.structural.minimumContentMet,
          true,
          `${adapter.id} reported structuralOk with minimumContentMet=${reading.structural.minimumContentMet}`,
        );
        assert.equal(typeof reading.text, "string");
        assert.ok(reading.text.length > 0);
      }
    }
  }
  // The implication is vacuously true for any adapter that never reports structuralOk, so the
  // guard is per adapter and not a pooled total: a matrix edit that drops the one body reaching
  // linkedin-guest's true case must fail here, not hide behind the generic adapter's three.
  for (const [id, count] of observedTrue) {
    assert.ok(count >= 1, `${id} never reported structuralOk over the matrix`);
  }
});

test("the shared minimum-content floor is one number, not a per-adapter opinion", () => {
  assert.deepEqual(minimumContent, { characters: 400, words: 60 });
  const short = "word ".repeat(59);
  for (const adapter of vacancyFetchAdapters) {
    const reading = adapter.interpret({
      transportFailure: null,
      status: 200,
      finalUrl: adapter.id === "linkedin-guest" ? GUEST_URL : GENERIC_REF,
      contentType: "text/html",
      body: `<main><div class="description__text">${short}</div></main>`,
      context: { jobId: LINKEDIN_JOB_ID },
    });
    assert.equal(reading.structural.minimumContentMet, false, adapter.id);
    assert.ok(reading.reasons.includes("content_below_minimum"), adapter.id);
  }
});

test("the reason vocabulary is bounded, and an unknown code cannot leave an adapter", () => {
  // Frozen as a literal, so a new code is a deliberate edit here and in the README's list of what
  // a caller may branch on.
  assert.deepEqual([...adapterReasonCodes], [
    "anti_bot_page",
    "auth_wall",
    "content_below_minimum",
    "deferred_content_suspected",
    "description_container_absent",
    "identity_unconfirmed",
    "rate_limited",
    "route_unresolved",
    "transport_failed",
    "unsupported_content_type",
    "unknown_shape",
  ]);
  // The one code a module outside the adapters holds as a constant. It must stay a member of the
  // list above, or `tools/vacancy-fetch/batch.mjs` would count a demand no adapter ever emits.
  assert.ok(adapterReasonCodes.includes(deferredContentReason));
  assert.throws(
    () => adapterReading({ reasons: ["looks_wrong"] }),
    /unknown adapter reason code/u,
  );
  // Duplicates collapse rather than accumulate, so a caller counting reasons counts conditions.
  assert.deepEqual(
    adapterReading({ reasons: ["auth_wall", "auth_wall"] }).reasons,
    ["auth_wall"],
  );

  // Every reason any fixture actually produces is a member, so the list cannot drift away from
  // what the adapters emit.
  const emitted = new Set();
  for (const entry of fixtureManifest) {
    if (entry.expectation === null) continue;
    for (const reason of replayFixture(entry).reading.reasons) emitted.add(reason);
  }
  for (const reason of emitted) {
    assert.ok(adapterReasonCodes.includes(reason), reason);
  }
  assert.ok(emitted.size >= 6, `fixtures exercise only ${emitted.size} reason codes`);
});

test("the bounded marker lists stay bounded and repository-owned", () => {
  // All three lists, not two: an omitted list is how a marker set grows unbounded without anything
  // noticing, which is what happened to `authWallMarkers` until the review looked.
  for (const marker of [...closedBannerMarkers, ...antiBotMarkers, ...authWallMarkers]) {
    assert.equal(marker, marker.toLowerCase(), marker);
    assert.ok(marker.length >= 10 && marker.length <= 120, marker);
  }
  assert.equal(closedBannerMarkers.length, 3);
  assert.equal(antiBotMarkers.length, 8);
  assert.equal(authWallMarkers.length, 2);
});

test("the LinkedIn wall paths stay bounded, and both adapters read the same lists", () => {
  // The generic adapter imports these rather than keeping its own copy, so a path appended for one
  // adapter is a path the other reads too. The literal freezes the list; a change is deliberate.
  assert.deepEqual([...linkedinAuthWallPathPrefixes], ["/authwall", "/login", "/signup", "/uas/login"]);
  assert.deepEqual([...linkedinAntiBotPathPrefixes], ["/checkpoint"]);
  assert.ok(Object.isFrozen(linkedinAuthWallPathPrefixes));
  assert.ok(Object.isFrozen(linkedinAntiBotPathPrefixes));
});

function batchWorkspace(t) {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-vacancy-fetch-",
  });
  const outDir = realpathSync(environment.workspaceRoot);
  return { environment, outDir };
}

function fixtureRoutes() {
  return new Map([
    [GUEST_URL, htmlResponse(readFixture("linkedin-guest-active.html"))],
    [GENERIC_REF, htmlResponse(readFixture("generic-main-active.html"))],
    ["https://careers.example/closed", htmlResponse(readFixture("generic-thin.html"))],
  ]);
}

test("a batch persists one capture per usable vacancy and one manifest", async (t) => {
  const { outDir } = batchWorkspace(t);
  const calls = [];
  const slept = [];
  const manifest = await runVacancyFetchBatch({
    urls: [LINKEDIN_REF, GENERIC_REF, "https://careers.example/closed"],
    outDir,
    batch: "gate-1",
    delayMs: 1500,
    fetchImpl: stubFetch(fixtureRoutes(), calls),
    sleep: async (ms) => slept.push(ms),
    now: () => new Date("2026-08-18T09:00:00.000Z"),
  });

  // Sequential, with the delay between requests and never before the first one.
  assert.deepEqual(calls.map((call) => call.url), [
    GUEST_URL,
    GENERIC_REF,
    "https://careers.example/closed",
  ]);
  assert.deepEqual(slept, [1500, 1500]);

  assert.deepEqual(readdirSync(outDir).filter((entry) => entry.endsWith(".txt")).sort(),
    ["001.capture.txt", "002.capture.txt"]);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.batch.label, "gate-1");
  assert.equal(manifest.batch.isDefaultTransport, true);
  assert.equal(manifest.stoppedEarly, null);
  assert.deepEqual(manifest.summary.byOutcome,
    { active: 2, absent: 0, closed: 0, private: 0, access_failure: 1 });
  assert.equal(manifest.summary.usable, 2);
  assert.equal(manifest.summary.needsBrowserFallback, 1);
  assert.equal(manifest.summary.skipped, 0);

  // Each persisted file verifies against its own stamped header, and the manifest digest is the
  // same number: the two records of the same bytes cannot disagree.
  for (const record of manifest.records.filter((entry) => entry.persisted !== null)) {
    const contents = readFileSync(join(outDir, record.persisted.file), "utf8");
    const verified = verifyCaptureFile(contents);
    assert.deepEqual(verified.problems, [], record.persisted.file);
    assert.equal(verified.header["normalized-sha256"], record.persisted.sha256);
    assert.equal(verified.header["extracted-sha256"], record.extracted.sha256);
    assert.equal(verified.header.outcome, record.outcome);
    assert.equal(record.normalization.afterSha256, record.persisted.sha256);
  }

  const persistedManifest = JSON.parse(readFileSync(join(outDir, manifestBasename), "utf8"));
  assert.deepEqual(persistedManifest.summary, manifest.summary);
});

test("a batch stops on a rate limit and records the rest as unattempted", async (t) => {
  const { outDir } = batchWorkspace(t);
  const routes = fixtureRoutes();
  routes.set(GUEST_URL, htmlResponse("<div>slow down</div>", { status: 429 }));
  const calls = [];
  const manifest = await runVacancyFetchBatch({
    urls: [LINKEDIN_REF, GENERIC_REF, "https://careers.example/closed"],
    outDir,
    batch: "gate-2",
    delayMs: 0,
    fetchImpl: stubFetch(routes, calls),
    now: () => new Date("2026-08-18T09:00:00.000Z"),
  });

  assert.deepEqual(calls.map((call) => call.url), [GUEST_URL]);
  assert.equal(manifest.stoppedEarly, "rate_limited");
  assert.equal(manifest.summary.skipped, 2);
  assert.equal(manifest.records[0].accessBarrier, "rate_limit");
  assert.equal(manifest.records[0].retryable, true);
  for (const record of manifest.records.slice(1)) {
    assert.equal(record.skipped, true);
    assert.equal(record.outcome, "access_failure");
    assert.equal(record.accessBarrier, "rate_limit");
    assert.equal(record.retryable, true);
    assert.equal(record.fallback, "browser");
    assert.equal(record.httpStatus, null);
  }
});

test("a batch may be told to continue through a rate limit", async (t) => {
  const { outDir } = batchWorkspace(t);
  const routes = fixtureRoutes();
  routes.set(GUEST_URL, htmlResponse("<div>slow down</div>", { status: 429 }));
  const calls = [];
  const manifest = await runVacancyFetchBatch({
    urls: [LINKEDIN_REF, GENERIC_REF],
    outDir,
    batch: "gate-3",
    delayMs: 0,
    onRateLimit: "continue",
    fetchImpl: stubFetch(routes, calls),
    now: () => new Date("2026-08-18T09:00:00.000Z"),
  });
  assert.equal(calls.length, 2);
  assert.equal(manifest.stoppedEarly, null);
  assert.equal(manifest.summary.skipped, 0);
});

test("a degraded adapter persists its capture and still routes to the browser fallback", async (t) => {
  const { outDir } = batchWorkspace(t);
  const routes = new Map([
    [GUEST_URL, htmlResponse(readFixture("linkedin-guest-no-container.html"))],
  ]);
  const manifest = await runVacancyFetchBatch({
    urls: [LINKEDIN_REF],
    outDir,
    batch: "gate-4",
    delayMs: 0,
    fetchImpl: stubFetch(routes),
    now: () => new Date("2026-08-18T09:00:00.000Z"),
  });
  const [record] = manifest.records;
  assert.equal(record.outcome, "active");
  assert.notEqual(record.persisted, null);
  assert.equal(record.structuralOk, false);
  assert.equal(record.usable, false);
  assert.equal(record.fallback, "browser");
  assert.deepEqual(record.reasons, ["description_container_absent"]);
});

test("a closed posting read from an unrecognized layout is not trusted as terminal", async (t) => {
  const { outDir } = batchWorkspace(t);
  const manifest = await runVacancyFetchBatch({
    urls: [LINKEDIN_REF],
    outDir,
    batch: "gate-5",
    delayMs: 0,
    fetchImpl: stubFetch(new Map([
      [GUEST_URL, htmlResponse(readFixture("linkedin-guest-wrong-job.html"))],
    ])),
    now: () => new Date("2026-08-18T09:00:00.000Z"),
  });
  const [record] = manifest.records;
  assert.equal(record.structural.jobIdPresent, false);
  assert.equal(record.usable, false);
  assert.equal(record.fallback, "browser");
});

test("a terminal absence needs no browser fallback", async (t) => {
  const { outDir } = batchWorkspace(t);
  const manifest = await runVacancyFetchBatch({
    urls: [GENERIC_REF],
    outDir,
    batch: "gate-6",
    delayMs: 0,
    fetchImpl: stubFetch(new Map([
      [GENERIC_REF, htmlResponse("<main><p>Gone</p></main>", { status: 410 })],
    ])),
    now: () => new Date("2026-08-18T09:00:00.000Z"),
  });
  const [record] = manifest.records;
  assert.equal(record.outcome, "absent");
  assert.equal(record.retryable, false);
  assert.equal(record.fallback, null);
  assert.equal(record.persisted, null);
});

test("a reference that is not a fetchable URL costs no request", async (t) => {
  const { outDir } = batchWorkspace(t);
  const calls = [];
  const manifest = await runVacancyFetchBatch({
    urls: ["local-file:pasted-jd.txt", GENERIC_REF],
    outDir,
    batch: "gate-7",
    delayMs: 0,
    fetchImpl: stubFetch(fixtureRoutes(), calls),
    now: () => new Date("2026-08-18T09:00:00.000Z"),
  });
  assert.deepEqual(calls.map((call) => call.url), [GENERIC_REF]);
  assert.deepEqual(manifest.records[0].reasons, ["route_unresolved"]);
  assert.equal(manifest.records[0].skipped, false);
  assert.equal(manifest.records[0].requestedUrl, null);
});

test("the batch refuses an unusable output directory before it fetches anything", async (t) => {
  const { outDir } = batchWorkspace(t);
  const calls = [];
  const run = (overrides) => runVacancyFetchBatch({
    urls: [GENERIC_REF],
    outDir,
    batch: "gate-8",
    delayMs: 0,
    fetchImpl: stubFetch(fixtureRoutes(), calls),
    now: () => new Date("2026-08-18T09:00:00.000Z"),
    ...overrides,
  });

  await assert.rejects(run({ outDir: join(outDir, "absent") }), (error) => {
    assert.equal(error.code, "out_dir_missing");
    return true;
  });
  await assert.rejects(run({ outDir: "relative/path" }), (error) => {
    assert.equal(error.code, "out_dir_unsafe");
    return true;
  });

  const linked = join(outDir, "linked");
  mkdirSync(join(outDir, "real"), { mode: 0o700 });
  symlinkSync(join(outDir, "real"), linked);
  await assert.rejects(run({ outDir: linked }), (error) => {
    assert.equal(error.code, "out_dir_unsafe");
    return true;
  });

  const loose = join(outDir, "loose");
  mkdirSync(loose, { mode: 0o700 });
  chmodSync(loose, 0o777);
  await assert.rejects(run({ outDir: loose }), (error) => {
    assert.equal(error.code, "out_dir_unsafe");
    return true;
  });

  // Nothing above spent a request: the directory is validated first.
  assert.deepEqual(calls, []);

  // A directory that already holds a manifest is evidence, never a target.
  const occupied = join(outDir, "occupied");
  mkdirSync(occupied, { mode: 0o700 });
  await run({ outDir: occupied });
  await assert.rejects(run({ outDir: occupied }), (error) => {
    assert.equal(error.code, "out_dir_occupied");
    return true;
  });
  assert.equal(prepareOutDir(realpathSync(outDir)), realpathSync(outDir));
});

test("the batch validates its own settings", async (t) => {
  const { outDir } = batchWorkspace(t);
  const run = (overrides) => runVacancyFetchBatch({
    urls: [GENERIC_REF],
    outDir,
    batch: "gate-9",
    delayMs: 0,
    fetchImpl: stubFetch(fixtureRoutes()),
    now: () => new Date("2026-08-18T09:00:00.000Z"),
    ...overrides,
  });
  for (const [overrides, code] of [
    [{ urls: [] }, "urls_invalid"],
    [{ urls: new Array(maxBatchUrls + 1).fill(GENERIC_REF) }, "urls_invalid"],
    [{ batch: "" }, "batch_invalid"],
    [{ batch: "Not A Label" }, "batch_invalid"],
    [{ batch: undefined }, "batch_invalid"],
    [{ delayMs: -1 }, "delay_invalid"],
    [{ delayMs: 1.5 }, "delay_invalid"],
    [{ onRateLimit: "abort" }, "rate_limit_policy_invalid"],
  ]) {
    await assert.rejects(run(overrides), (error) => {
      assert.ok(error instanceof VacancyFetchError);
      assert.equal(error.code, code, JSON.stringify(overrides));
      return true;
    });
  }
});

test("a closure banner read without the description container is not trusted as terminal", async (t) => {
  const { outDir } = batchWorkspace(t);
  // Composed inline rather than added to the frozen corpus: this pins the interaction between a
  // body-derived terminal verdict and a failed structural check, not one document's extraction.
  const body = [
    "<section class=\"top-card-layout\">",
    `<a class="topcard__link" href="/jobs/view/role-${LINKEDIN_JOB_ID}">See job</a>`,
    "<p>No longer accepting applications</p>",
    `<p>${"Description filler text. ".repeat(40)}</p>`,
    "</section>",
  ].join("");
  const manifest = await runVacancyFetchBatch({
    urls: [LINKEDIN_REF],
    outDir,
    batch: "gate-10",
    delayMs: 0,
    fetchImpl: stubFetch(new Map([[GUEST_URL, htmlResponse(body)]])),
    now: () => new Date("2026-08-18T09:00:00.000Z"),
  });
  const [record] = manifest.records;
  assert.equal(record.outcome, "closed");
  assert.equal(record.structural.descriptionContainerFound, false);
  assert.equal(record.structuralOk, false);
  assert.equal(record.fallback, "browser");
});

// The CLI writes its compact summary to stdout. Captured rather than let through, so the suite's
// own output stays readable and so the summary itself can be asserted.
function captureStdout(run) {
  const written = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  return (async () => {
    try {
      return { result: await run(), stdout: written.join("") };
    } finally {
      process.stdout.write = originalWrite;
    }
  })();
}

function inputRootIn(workspaceRoot) {
  const inputRoot = join(workspaceRoot, ".pipeline-input");
  if (!existsSync(inputRoot)) mkdirSync(inputRoot, { mode: 0o700 });
  chmodSync(inputRoot, 0o700);
  return realpathSync(inputRoot);
}

function writeEnvelope(inputRoot, values, { command = vacancyFetchCommand } = {}) {
  const nonce = randomBytes(16).toString("hex");
  const basename = `input-${nonce}.json`;
  writeFileSync(
    join(inputRoot, basename),
    `${JSON.stringify({ schemaVersion: 1, command, nonce, values })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  chmodSync(join(inputRoot, basename), 0o600);
  return basename;
}

test("the CLI reads its URLs from the ADR 0011 envelope and never from argv", async (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-vacancy-fetch-cli-",
  });
  const workspaceRoot = realpathSync(environment.workspaceRoot);
  const inputRoot = inputRootIn(workspaceRoot);
  const outDir = join(workspaceRoot, "captures");
  mkdirSync(outDir, { mode: 0o700 });

  // A hostile reference travelling through the envelope, exactly as ADR 0011 intends: shell
  // metacharacters stay literal data because they never reach shell program text.
  const hostile = "https://careers.example/jobs/$(touch marker)`id`";
  const basename = writeEnvelope(inputRoot, {
    urls: [LINKEDIN_REF, hostile],
    userAgent: "job-pipeline-triage/1",
  });

  const previousInputRoot = process.env.JOB_PIPELINE_INPUT_ROOT;
  process.env.JOB_PIPELINE_INPUT_ROOT = inputRoot;
  t.after(() => {
    if (previousInputRoot === undefined) delete process.env.JOB_PIPELINE_INPUT_ROOT;
    else process.env.JOB_PIPELINE_INPUT_ROOT = previousInputRoot;
  });

  const calls = [];
  const routes = new Map([
    [GUEST_URL, htmlResponse(readFixture("linkedin-guest-active.html"))],
    [hostile, htmlResponse(readFixture("generic-main-active.html"))],
  ]);
  const { result: exitCode, stdout } = await captureStdout(() => cliMain([
    "fetch",
    "--input-file", basename,
    "--out-dir", outDir,
    "--batch", "cli-1",
    "--delay-ms", "0",
  ], {
    fetchImpl: stubFetch(routes, calls),
    now: () => new Date("2026-08-18T09:00:00.000Z"),
  }));

  assert.equal(exitCode, 0);
  // The printed summary carries counts and bounded codes only: a URL or a page fragment on
  // stdout is read by a model, and that is an instruction-injection channel.
  const printed = JSON.parse(stdout);
  assert.deepEqual(Object.keys(printed).sort(), [
    "batch",
    "completenessCheck",
    "fallback",
    "isDefaultTransport",
    "manifest",
    "stoppedEarly",
    "summary",
  ]);
  assert.equal(stdout.includes("careers.example"), false);
  assert.equal(stdout.includes("touch"), false);
  assert.equal(stdout.includes("linkedin"), false);
  assert.equal(existsSync(join(workspaceRoot, "marker")), false);
  const manifest = JSON.parse(readFileSync(join(outDir, manifestBasename), "utf8"));
  assert.equal(manifest.settings.userAgentOverridden, true);
  assert.equal(calls[0].headers["user-agent"], "job-pipeline-triage/1");
  assert.equal(manifest.summary.usable, 2);
  // The hostile reference is recorded as data, in the exact form URL parsing produces. It was
  // fetched, persisted and manifested without ever being assembled into shell program text.
  assert.equal(
    manifest.records[1].requestedUrl,
    "https://careers.example/jobs/$(touch%20marker)%60id%60",
  );
  assert.equal(calls[1].url, hostile);
});

test("the CLI signals the browser fallback through its exit code", async (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-vacancy-fetch-exit-",
  });
  const workspaceRoot = realpathSync(environment.workspaceRoot);
  const inputRoot = inputRootIn(workspaceRoot);
  const outDir = join(workspaceRoot, "captures");
  mkdirSync(outDir, { mode: 0o700 });
  const basename = writeEnvelope(inputRoot, { urls: [GENERIC_REF] });
  process.env.JOB_PIPELINE_INPUT_ROOT = inputRoot;
  t.after(() => delete process.env.JOB_PIPELINE_INPUT_ROOT);

  const { result: exitCode, stdout } = await captureStdout(() => cliMain([
    "fetch",
    "--input-file", basename,
    "--out-dir", outDir,
    "--batch", "cli-2",
    "--delay-ms", "0",
  ], {
    fetchImpl: stubFetch(new Map([[GENERIC_REF, htmlResponse("<main>thin</main>")]])),
    now: () => new Date("2026-08-18T09:00:00.000Z"),
  }));
  assert.equal(exitCode, 2);
  const printed = JSON.parse(stdout);
  assert.equal(printed.summary.needsBrowserFallback, 1);
  assert.deepEqual(printed.fallback, [{
    index: 1,
    outcome: "access_failure",
    accessBarrier: "unparseable",
    reasons: ["content_below_minimum"],
  }]);
});

test("a usable record whose completeness is unverified moves the exit code too", async (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-vacancy-fetch-completeness-",
  });
  const workspaceRoot = realpathSync(environment.workspaceRoot);
  const inputRoot = inputRootIn(workspaceRoot);
  const outDir = join(workspaceRoot, "captures");
  mkdirSync(outDir, { mode: 0o700 });
  const basename = writeEnvelope(inputRoot, { urls: [GENERIC_REF] });
  process.env.JOB_PIPELINE_INPUT_ROOT = inputRoot;
  t.after(() => delete process.env.JOB_PIPELINE_INPUT_ROOT);

  // The whole defect in one batch: every record is usable, none needs the fallback, nothing was
  // left unattempted - and every record owes the browser the one load the skill's confirmation
  // rule will spend on it. Before this counter existed the batch exited 0.
  const { result: exitCode, stdout } = await captureStdout(() => cliMain([
    "fetch",
    "--input-file", basename,
    "--out-dir", outDir,
    "--batch", "cli-3",
    "--delay-ms", "0",
  ], {
    fetchImpl: stubFetch(new Map([
      [GENERIC_REF, htmlResponse(readFixture("generic-spa-deferred.html"))],
    ])),
    now: () => new Date("2026-08-18T09:00:00.000Z"),
  }));

  const printed = JSON.parse(stdout);
  assert.equal(printed.summary.usable, 1);
  assert.equal(printed.summary.needsBrowserFallback, 0);
  assert.equal(printed.summary.skipped, 0);
  assert.equal(printed.summary.needsBrowserCompletenessCheck, 1);
  assert.equal(exitCode, 2);
  // Two lists, never one: a record the layer could not serve and a record whose completeness it
  // cannot vouch for are different instructions to the caller.
  assert.deepEqual(printed.fallback, []);
  assert.deepEqual(printed.completenessCheck, [{
    index: 1,
    outcome: "active",
    reasons: ["deferred_content_suspected"],
  }]);
  // The stdout summary stays counts and bounded codes: the new list carries no URL and no page
  // text, because a model reads this output.
  assert.equal(stdout.includes("northwind"), false);
  assert.equal(stdout.includes("Automation Tester"), false);
  // The fallback vocabulary is untouched. The record is usable, it carries no fallback signal,
  // and `needsBrowserFallback` did not move - that equivalence is what every other reader relies
  // on, and widening it is the shape this fix deliberately did not take.
  const manifest = JSON.parse(readFileSync(join(outDir, manifestBasename), "utf8"));
  assert.equal(manifest.records[0].usable, true);
  assert.equal(manifest.records[0].fallback, null);
  assert.equal(manifest.summary.needsBrowserCompletenessCheck, 1);
});

test("the completeness counter counts usable flagged records and nothing else", async (t) => {
  const { outDir } = batchWorkspace(t);
  // Three records, one per class the counter has to tell apart:
  //   1. a complete render whose island mirrors it - flagged by nothing, owes nothing;
  //   2. the deferred architecture - usable, flagged, owes one browser load;
  //   3. a thin body under a large island - flagged AND below the minimum content floor, so it is
  //      not usable and already travels on `fallback: "browser"`. Counting it here too would
  //      double-count it and break the equality the task asks for: the number must equal the
  //      confirmation loads the skill spends, and the skill spends its rule on usable records.
  const thinWithIsland = [
    "<html><body><main><p>Short.</p></main>",
    `<script type="application/json">{"v":${JSON.stringify("prose word ".repeat(60))}}</script>`,
    "</body></html>",
  ].join("");
  const mirror = "https://careers.example/mirror";
  const thin = "https://careers.example/thin";
  const manifest = await runVacancyFetchBatch({
    urls: [mirror, GENERIC_REF, thin],
    outDir,
    batch: "gate-completeness",
    delayMs: 0,
    fetchImpl: stubFetch(new Map([
      [mirror, htmlResponse(readFixture("generic-spa-mirror.html"))],
      [GENERIC_REF, htmlResponse(readFixture("generic-spa-deferred.html"))],
      [thin, htmlResponse(thinWithIsland)],
    ])),
    now: () => new Date("2026-08-18T09:00:00.000Z"),
  });

  const [complete, deferred, degraded] = manifest.records;
  assert.equal(complete.usable, true);
  assert.equal(complete.reasons.includes("deferred_content_suspected"), false);
  assert.equal(deferred.usable, true);
  assert.ok(deferred.reasons.includes("deferred_content_suspected"));
  assert.equal(degraded.usable, false);
  assert.ok(degraded.reasons.includes("deferred_content_suspected"));
  assert.ok(degraded.reasons.includes("content_below_minimum"));
  assert.equal(degraded.fallback, "browser");

  assert.equal(manifest.summary.needsBrowserCompletenessCheck, 1);
  assert.equal(manifest.summary.needsBrowserFallback, 1);
  assert.equal(manifest.summary.usable, 2);
});

test("only the generic adapter measures islands, and it can never reach a terminal verdict", () => {
  // The completeness predicate reads `usable` and the reason code and never looks at `outcome`.
  // That is sound only while the flag cannot land on a record the batch procedure treats as
  // finished: a pre-triage disposition of `terminal_gone` scores such a record without opening
  // the browser, so a flagged `closed` record would be counted and never confirmed. Two
  // conditions hold it, and both are pinned here rather than left to the reader.
  const adapterSources = vacancyFetchAdapters.map((entry) => ({
    id: entry.id,
    source: readFileSync(join(repoRoot, "tools/vacancy-fetch/adapters", `${entry.id}.mjs`), "utf8"),
  }));
  assert.deepEqual(
    adapterSources.filter((entry) => entry.source.includes("deferred-content.mjs"))
      .map((entry) => entry.id),
    ["generic-html"],
  );
  // And the generic adapter reports no first-party status word and no listing flag, so the status
  // table cannot resolve one of its readings to `closed` or `private`.
  const reading = genericHtmlAdapter.interpret({
    transportFailure: null,
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: readFixture("linkedin-guest-closed.html"),
  });
  assert.equal(reading.statusWord, null);
  assert.equal(reading.unlisted, false);
  assert.equal(
    classifyDirectRoute({
      status: 200,
      statusWord: reading.statusWord,
      unlisted: reading.unlisted,
      hasPostingBody: true,
    }).outcome,
    "active",
  );
});

test("the CLI refuses a malformed invocation before it reads anything", async () => {
  const cases = [
    [["fetch"], "invalid_cli_arguments"],
    [["fetch", "--input-file"], "invalid_cli_arguments"],
    [["fetch", "--input-file", "input-x.json", "--out-dir", "/tmp"], "invalid_cli_arguments"],
    [["fetch", "--unknown", "x"], "invalid_cli_arguments"],
    [["fetch", "positional"], "invalid_cli_arguments"],
    [["scrape"], "unknown_command"],
  ];
  for (const [argv, code] of cases) {
    await assert.rejects(cliMain(argv), (error) => {
      assert.equal(error.code, code, JSON.stringify(argv));
      return true;
    });
  }
  const numeric = [
    ["--delay-ms", "-5"],
    ["--timeout-ms", "1"],
    ["--max-redirects", "99"],
    ["--max-bytes", "0"],
    ["--on-rate-limit", "panic"],
  ];
  for (const [flag, value] of numeric) {
    await assert.rejects(cliMain([
      "fetch",
      "--input-file", "input-00000000000000000000000000000000.json",
      "--out-dir", "/tmp",
      "--batch", "cli-3",
      flag, value,
    ]), (error) => {
      assert.equal(error.code, "invalid_cli_arguments", `${flag} ${value}`);
      return true;
    });
  }
});

test("the CLI help surface names the envelope rather than a URL argument", async () => {
  const { result, stdout: help } = await captureStdout(() => cliMain(["help"]));
  assert.equal(result, 0);
  assert.match(help, /--input-file input-<32 lowercase hex>\.json/u);
  assert.match(help, /The envelope holds the ordered vacancy URLs/u);
  assert.match(help, /never appear on the command line/u);
  // No flag accepting a URL exists, so no shell-facing caller can be tempted to use one.
  assert.equal(/--url\b/u.test(help), false);
});

test("the tool README states the same numbers the code enforces", () => {
  const readme = readFileSync(resolve(repoRoot, "tools/vacancy-fetch/README.md"), "utf8");
  const flat = readme.replace(/\s+/gu, " ");

  // Defaults are frozen as literals here rather than interpolated from the modules: a table that
  // reads its own values back from the code cannot catch prose drifting from behaviour.
  for (const claim of [
    "| `--delay-ms` | `2000` |",
    "| `--timeout-ms` | `20000` |",
    "| `--max-bytes` | `5242880` |",
    "| `--max-redirects` | `5` |",
    "| `--on-rate-limit` | `stop` |",
  ]) {
    assert.ok(readme.includes(claim), claim);
  }
  assert.equal(transportDefaults.timeoutMs, 20_000);
  assert.equal(transportDefaults.maxBytes, 5_242_880);
  assert.equal(transportDefaults.maxRedirects, 5);

  assert.ok(readme.includes(captureBodyDelimiter));
  assert.ok(readme.includes(manifestBasename));
  for (const adapter of vacancyFetchAdapters) {
    assert.ok(readme.includes(`\`${adapter.id}\``), adapter.id);
  }
  // The two named limits of the current adapter set, pinned against behaviour and not only as
  // prose: an adapter that starts producing `private` reds this test and forces the claim to be
  // rewritten instead of quietly becoming false.
  assert.match(flat, /\*\*No adapter here can produce `private`\*\*/u);
  assert.match(flat, /\*\*`closed` is reachable only through LinkedIn\*\*/u);
  const readings = fixtureManifest
    .filter((entry) => entry.expectation !== null)
    .map((entry) => replayFixture(entry));
  assert.equal(readings.some((entry) => entry.reading.unlisted === true), false);
  assert.equal(readings.some((entry) => entry.verdict.outcome === "private"), false);
  assert.deepEqual(
    [...new Set(readings
      .filter((entry) => entry.verdict.outcome === "closed")
      .map((entry) => entry.reading.statusWord))],
    ["closed"],
  );

  // The layer's own boundary, stated where a reader of the tool will see it.
  assert.match(flat, /This \*\*is\*\* the default transport for the triage lane/u);
  assert.doesNotMatch(flat, /This is \*\*not\*\* the default transport/u);
  assert.doesNotMatch(flat, /--experiment\b/u);
  // Re-anchored from the rollout runbook's retired condition 5: promotion retired the condition
  // list, not the requirement it guarded, so the guard moves to the sentence that states it.
  assert.match(flat, /generic adapter is what makes an arbitrary vacancy URL scoreable/u);
  assert.match(flat, /reserves no output directory, touches no `process-log\.json`/u);
  assert.match(flat, /Adding an adapter is a bounded change/u);
  assert.match(flat, /`robots\.txt` is not fetched/u);
  // The three claims a reader acts on and the code has to keep: which producer steps apply, which
  // route-fact shape a new adapter imitates, and what an interrupted batch does.
  assert.match(flat, /\*\*steps 1 to 5\*\* — the input root, the nonce/u);
  assert.match(flat, /this CLI is not one of them/u);
  assert.match(flat, /in the same shape as `linkedinGuestRoute`/u);
  assert.match(flat, /\*\*An interrupted batch has no resume path\.\*\*/u);
});

test("the rollout runbook records the promotion and owns the measurement procedure", () => {
  const path = resolve(repoRoot, "docs/runbooks/vacancy-fetch-experiment.md");
  assert.equal(existsSync(path), true, "the rollout runbook must exist");
  const runbook = readFileSync(path, "utf8");
  const flat = runbook.replace(/\s+/gu, " ");

  // The measurement procedure the runbook still owns, and the promotion it now records.
  assert.match(flat, /--batch/u);
  assert.doesNotMatch(flat, /--experiment\b/u);
  assert.match(flat, /--delay-ms 2000/u);
  assert.match(flat, /Rate-limit behaviour/u);
  assert.match(flat, /\*\*Promotion done\.\*\*/u);
  assert.match(flat, /`isDefaultTransport: true`/u);
  assert.doesNotMatch(flat, /`isDefaultTransport: false`/u);
  // The measured share is an observation of one batch, never a bar a later batch has to clear:
  // the user refused a percentage as a criterion on 2026-09-01 and accepted the bounded worst
  // case instead. The clause that read the share as a pay-off verdict is gone and may not return.
  assert.doesNotMatch(flat, /decides whether the transport pays off/u);
  // The same decision has a second half, and it requires something to stay: the share is still
  // reported, it is only no longer read as a verdict. A pin on the removal alone would let the
  // observation itself be dropped with the suite green.
  assert.match(flat, /\| Cost \| bytes, wall-clock, fallback share/u);
  assert.match(flat, /how many vacancies needed the browser fallback/u);
  // A measured run is an operational activity, and the runbook says where it may not run.
  assert.match(flat, /main` and task worktrees do not use real vacancy URLs/u);
  // The runbook must not quietly become a second owner of the tool's behaviour.
  assert.match(flat, /The owner of the tool's own behaviour/u);
  // The runbook cites the producer procedure's steps, not its process-log table, and it says what
  // an interrupted batch means for the comparison.
  assert.match(flat, /under steps 1-5/u);
  assert.match(flat, /does not extend to this CLI/u);
  assert.match(flat, /\*\*An interrupted batch is not resumed\.\*\*/u);
});

test("this CLI's envelope schema is bounded and accepts nothing else", (t) => {
  const environment = createDisposableWorkspace(t, {
    createOutput: false,
    prefix: "job-search-vacancy-fetch-envelope-",
  });
  const inputRoot = inputRootIn(realpathSync(environment.workspaceRoot));
  const read = (values, options) => {
    const basename = writeEnvelope(inputRoot, values, options);
    return () => readSafeCliInput({
      basename,
      command: vacancyFetchCommand,
      inputRoot,
      schemas: vacancyFetchInputSchemas,
    });
  };

  const accepted = read({ urls: [LINKEDIN_REF, GENERIC_REF], userAgent: "agent/1" })();
  assert.deepEqual(accepted.values.urls, [LINKEDIN_REF, GENERIC_REF]);
  assert.equal(accepted.values.userAgent, "agent/1");

  // Frozen literals, so widening a bound is a deliberate edit in two places.
  const limits = vacancyFetchInputSchemas[vacancyFetchCommand].stringListLimits.urls;
  assert.deepEqual(limits, { maxItems: 256, itemMaxBytes: 2048 });
  assert.deepEqual(
    vacancyFetchInputSchemas[vacancyFetchCommand].required,
    ["urls"],
  );

  for (const values of [
    { urls: new Array(257).fill(GENERIC_REF) },
    { urls: [`https://careers.example/${"x".repeat(2100)}`] },
    { urls: [] },
    { urls: GENERIC_REF },
    { urls: [GENERIC_REF], outDir: "/tmp" },
  ]) {
    assert.throws(read(values), (error) => {
      assert.ok(error instanceof SafeCliInputError);
      assert.equal(error.code, "safe_input_schema_mismatch");
      return true;
    });
  }
  // The envelope is command-bound: a payload written for another command is refused.
  assert.throws(read({ sourceRef: GENERIC_REF }, { command: "start" }), (error) => {
    assert.equal(error.code, "safe_input_command_mismatch");
    return true;
  });
});

test("the scanner stays linear on a document built out of close-tag-less elements", () => {
  // The regression the review found: every `<meta>` searched the whole document for a `</meta`
  // that cannot exist, so a page made of them cost one full scan per element. Measured on this
  // repository's own code before the fix, 40,000 `<meta>` tags took 7.3 s and each doubling of the
  // input roughly quadrupled the time; after it, the same input takes about 10 ms.
  //
  // The budget is two orders of magnitude above the linear cost on purpose. It is not a
  // performance assertion — it is the only way to state "not quadratic" as a check, and a
  // quadratic scanner misses it by seconds, not by milliseconds.
  const budgetMs = 2000;
  for (const shape of [
    "<meta>",
    "<link rel=\"stylesheet\">",
    "<noscript>",
    "<script>x</script>",
  ]) {
    const html = `<html><body>${shape.repeat(40_000)}<p>tail</p></body></html>`;
    const started = process.hrtime.bigint();
    const parsed = parseHtml(html);
    collectText(parsed.root);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(
      elapsedMs < budgetMs,
      `${shape} x40000 took ${elapsedMs.toFixed(0)}ms, over the ${budgetMs}ms budget`,
    );
  }
});

test("a solidus only closes a tag when it stands immediately before the angle bracket", () => {
  // A latched self-closing flag makes the element void, so its real children attach to its parent
  // and the subtree disappears from every container lookup — a whole job description lost to one
  // stray slash in an attribute list.
  const stray = parseHtml("<div class=\"a\" / data-x=\"1\"><p>Child content</p></div>");
  const div = stray.root.children.find((node) => node.tag === "div");
  assert.notEqual(div, undefined);
  assert.equal(div.children.length, 1);
  assert.match(collectText(div), /Child content/u);

  // The genuine self-closing form still closes.
  const closed = parseHtml("<div><br/><p>After</p></div>");
  const outer = closed.root.children.find((node) => node.tag === "div");
  assert.deepEqual(outer.children.map((node) => node.tag ?? node.type), ["br", "p"]);

  // And the container lookup the LinkedIn adapter depends on survives a stray solidus.
  const container = findElement(
    parseHtml(
      "<div class=\"description__text\" / data-tracking=\"1\">"
      + "<div class=\"show-more-less-html__markup\"><p>Body</p></div></div>",
    ).root,
    (node) => hasClassContaining(node, "show-more-less-html__markup"),
  );
  assert.notEqual(container, null);
  assert.match(collectText(container), /Body/u);
});

test("RCDATA content resolves character references and CDATA content does not", () => {
  // `textarea` and `title` are RCDATA: an `&amp;` inside them is an ampersand on the page, so it
  // must be one in the persisted text. `script` and `style` are CDATA and are dropped whole.
  assert.equal(collectText(parseHtml("<textarea>a &amp; b &lt;x&gt;</textarea>").root), "a & b <x>");
  const script = collectText(parseHtml("<script>var s = \"&amp;\";</script><p>after</p>").root);
  assert.equal(script.includes("&amp;"), false);
  assert.equal(script.includes("var s"), false);
  assert.match(script, /after/u);
});

test("the generic adapter's auth-wall markers are exercised, not merely declared", () => {
  const filler = "Description filler text. ".repeat(40);
  for (const marker of authWallMarkers) {
    const reading = genericHtmlAdapter.interpret({
      transportFailure: null,
      status: 200,
      finalUrl: GENERIC_REF,
      contentType: "text/html",
      body: `<main><p>${marker}</p><p>${filler}</p></main>`,
    });
    assert.equal(reading.authWall, true, marker);
    assert.ok(reading.reasons.includes("auth_wall"), marker);
    const verdict = classifyDirectRoute({
      transportFailure: null,
      status: 200,
      antiBot: reading.antiBot,
      authWall: reading.authWall,
      statusWord: reading.statusWord,
      unlisted: reading.unlisted,
      hasPostingBody: reading.structural.minimumContentMet === true,
    });
    assert.equal(verdict.outcome, "access_failure", marker);
    assert.equal(verdict.accessBarrier, "authentication", marker);
  }
  // A challenge page wins over a wall: one observation resolves once.
  const both = genericHtmlAdapter.interpret({
    transportFailure: null,
    status: 200,
    finalUrl: GENERIC_REF,
    contentType: "text/html",
    body: `<main><p>Just a moment...</p><p>${authWallMarkers[0]}</p><p>${filler}</p></main>`,
  });
  assert.equal(both.antiBot, true);
  assert.equal(both.authWall, false);
});

test("the generic adapter reads a LinkedIn wall from the final URL, and only on LinkedIn", () => {
  // The same Dutch sign-in body as the fixture. It clears the content floor, so every verdict below
  // is decided by the final URL alone: the registry must name the host LinkedIn, and the path must
  // be one of LinkedIn's own wall paths.
  const body = readFixture("generic-linkedin-login-localized.html");
  const read = (finalUrl) => {
    const reading = genericHtmlAdapter.interpret({
      transportFailure: null,
      status: 200,
      finalUrl,
      contentType: "text/html",
      body,
    });
    const verdict = classifyDirectRoute({
      transportFailure: null,
      status: 200,
      antiBot: reading.antiBot,
      authWall: reading.authWall,
      statusWord: reading.statusWord,
      unlisted: reading.unlisted,
      hasPostingBody: reading.structural.minimumContentMet === true,
    });
    return { reasons: reading.reasons, outcome: verdict.outcome, barrier: verdict.accessBarrier };
  };

  for (const path of ["/uas/login", "/login/", "/authwall", "/signup/cold-join"]) {
    assert.deepEqual(read(`https://nl.linkedin.com${path}`),
      { reasons: ["auth_wall"], outcome: "access_failure", barrier: "authentication" }, path);
  }
  assert.deepEqual(read("https://www.linkedin.com/checkpoint/challenge"),
    { reasons: ["anti_bot_page"], outcome: "access_failure", barrier: "anti_bot" });

  // A LinkedIn page off the wall paths, the same path on a foreign host, a look-alike host, and a
  // missing final URL all leave the body to the text checks, which this body passes.
  for (const finalUrl of [
    "https://www.linkedin.com/company/northwind/posts/",
    "https://careers.northwind-payments.example/uas/login",
    "https://www.linkedin.com.example.org/uas/login",
    "https://evil-linkedin.com/login",
    null,
  ]) {
    assert.deepEqual(read(finalUrl),
      { reasons: [], outcome: "active", barrier: null }, String(finalUrl));
  }
});

test("a batch hands a LinkedIn sign-in redirect to the browser and persists nothing", async (t) => {
  const { outDir } = batchWorkspace(t);
  const requested = "https://www.linkedin.com/company/northwind/posts/?feedView=all";
  const manifest = await runVacancyFetchBatch({
    urls: [requested],
    outDir,
    batch: "gate-wall",
    delayMs: 0,
    fetchImpl: stubFetch(new Map([
      [requested, redirectResponse("https://nl.linkedin.com/uas/login?session_redirect=x")],
      ["https://nl.linkedin.com/uas/login?session_redirect=x",
        htmlResponse(readFixture("generic-linkedin-login-localized.html"))],
    ])),
    sleep: async () => {},
    now: () => new Date("2026-09-23T09:00:00.000Z"),
  });
  const [record] = manifest.records;
  assert.equal(record.adapterId, "generic-html");
  assert.equal(record.finalUrl, "https://nl.linkedin.com/uas/login");
  assert.equal(record.outcome, "access_failure");
  assert.equal(record.accessBarrier, "authentication");
  assert.deepEqual(record.reasons, ["auth_wall"]);
  assert.equal(record.usable, false);
  assert.equal(record.fallback, "browser");
  assert.equal(record.persisted, null);
  assert.deepEqual(readdirSync(outDir).filter((entry) => entry.endsWith(".txt")), []);
});

test("the transport separates its own timeout from a caller abort", async () => {
  const pending = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  });
  // The internal deadline fires: the bounded code is `timeout`, not `aborted`.
  const timedOut = await fetchDocument({
    url: "https://jobs.example.com/slow",
    headers: defaultRequestHeaders,
    timeoutMs: 5,
    fetchImpl: pending,
  });
  assert.equal(timedOut.transportFailure, "timeout");

  // A caller's own signal fires first: the code stays `aborted`, and the two are distinguishable.
  const controller = new AbortController();
  const abortedPromise = fetchDocument({
    url: "https://jobs.example.com/slow",
    headers: defaultRequestHeaders,
    timeoutMs: 60_000,
    signal: controller.signal,
    fetchImpl: pending,
  });
  controller.abort();
  assert.equal((await abortedPromise).transportFailure, "aborted");
});

test("a capture file whose header line is gone fails its own header check", () => {
  const body = "Description text.\n";
  const file = renderCaptureFile({
    header: {
      index: 1,
      adapter: "generic-html@1",
      "source-id": null,
      "requested-url": GENERIC_REF,
      "final-url": GENERIC_REF,
      "fetched-at": "2026-08-18T10:00:00.000Z",
      "http-status": 200,
      outcome: "active",
      "access-barrier": null,
      "response-sha256": "a".repeat(64),
      "response-bytes": 10,
      "extracted-sha256": "b".repeat(64),
      "normalized-sha256": sha256Utf8(body),
      "body-bytes": Buffer.byteLength(body, "utf8"),
      normalization: "none",
    },
    body,
  });
  // Only the magic first line is removed. The delimiter, the remaining fields and the body digest
  // all stay self-consistent, so nothing but the header check can catch it.
  const beheaded = file.slice(file.indexOf("\n") + 1);
  assert.deepEqual(verifyCaptureFile(beheaded).problems, ["capture_header_absent"]);
  assert.deepEqual(
    verifyCaptureFile(file.replace("# vacancy-fetch capture v1", "# something else")).problems,
    ["capture_header_absent"],
  );
});

test("a closed posting read from an intact page is terminal and needs no fallback", async (t) => {
  const { outDir } = batchWorkspace(t);
  const manifest = await runVacancyFetchBatch({
    urls: [LINKEDIN_REF],
    outDir,
    batch: "gate-11",
    delayMs: 0,
    fetchImpl: stubFetch(new Map([
      [GUEST_URL, htmlResponse(readFixture("linkedin-guest-closed.html"))],
    ])),
    now: () => new Date("2026-08-18T09:00:00.000Z"),
  });
  const [record] = manifest.records;
  // The success side of the terminal rule: every structural check held, so the closure statement
  // is trusted, the capture is written, and the caller is not sent to the browser.
  assert.equal(record.outcome, "closed");
  assert.equal(record.retryable, false);
  assert.equal(record.structuralOk, true);
  assert.notEqual(record.persisted, null);
  assert.equal(record.usable, true);
  assert.equal(record.fallback, null);
  assert.equal(manifest.summary.needsBrowserFallback, 0);
  const contents = readFileSync(join(outDir, record.persisted.file), "utf8");
  assert.deepEqual(verifyCaptureFile(contents).problems, []);
  assert.match(verifyCaptureFile(contents).body, /No longer accepting applications/u);
});

test("captures without a manifest occupy a directory just as a manifest does", async (t) => {
  const { outDir } = batchWorkspace(t);
  const orphaned = join(outDir, "orphaned");
  mkdirSync(orphaned, { mode: 0o700 });
  // What a killed process leaves behind: captures, no manifest. A retry into the same directory
  // must fail before the first request, not collide on an exclusive create halfway through after
  // re-requesting every earlier URL.
  writeFileSync(join(orphaned, "001.capture.txt"), "leftover\n", { mode: 0o600 });
  assert.throws(() => prepareOutDir(orphaned), (error) => {
    assert.equal(error.code, "out_dir_occupied");
    return true;
  });
  // An unrelated file is not a batch and does not occupy the directory.
  const notes = join(outDir, "notes");
  mkdirSync(notes, { mode: 0o700 });
  writeFileSync(join(notes, "links.txt"), "https://example.com/1\n", { mode: 0o600 });
  assert.equal(prepareOutDir(notes), notes);
});

test("a batch that fails mid-run still writes the manifest it earned", async (t) => {
  const { outDir } = batchWorkspace(t);
  const calls = [];
  // The delay between requests is where a run most plausibly dies without a fetch failing. The
  // first record is complete and persisted by then, so losing the manifest would throw away the
  // record of requests that were already politely spent.
  await assert.rejects(runVacancyFetchBatch({
    urls: [GENERIC_REF, "https://careers.example/second"],
    outDir,
    batch: "gate-12",
    delayMs: 10,
    sleep: async () => {
      throw new Error("host went to sleep");
    },
    fetchImpl: stubFetch(fixtureRoutes(), calls),
    now: () => new Date("2026-08-18T09:00:00.000Z"),
  }), /host went to sleep/u);

  assert.deepEqual(calls.map((call) => call.url), [GENERIC_REF]);
  const manifest = JSON.parse(readFileSync(join(outDir, manifestBasename), "utf8"));
  assert.equal(manifest.stoppedEarly, "failed");
  assert.equal(manifest.records.length, 1);
  assert.equal(manifest.records[0].usable, true);
  assert.equal(manifest.summary.records, 1);
  // The capture the first record earned is on disk and verifies against its own header.
  const contents = readFileSync(join(outDir, manifest.records[0].persisted.file), "utf8");
  assert.deepEqual(verifyCaptureFile(contents).problems, []);
});

test("a close tag is located by scanning the source, never a re-cased copy of it", () => {
  // U+0130 is an ordinary Turkish capital letter, and its lowercase form is two UTF-16 units. A
  // close-tag search over a pre-lowercased copy of the document therefore returns an index that is
  // shifted relative to the source, and the slice taken from the source lands in the wrong place.
  // Measured on this repository's own code when the search worked that way: one `İ` before a
  // `<textarea>` spliced a stray `<` into the persisted text, and fourteen of them silently
  // dropped a whole paragraph of the job description.
  assert.equal("İ".length, 1);
  assert.equal("İ".toLowerCase().length, 2);

  const dotted = "İ".repeat(14);
  const withDots = `<main><p>${dotted} office</p><script>var s = 1;</script>`
    + "<p>Requirements: Playwright</p><p>Salary 90000 EUR</p></main>";
  const control = withDots.replaceAll("İ", "I");
  const extract = (html) => normalizeExtractedText(collectText(parseHtml(html).root)).text;
  // The only difference between the two documents is the letter, so the extracted text may differ
  // only by that letter. Anything else is a boundary the scanner got wrong.
  assert.equal(extract(withDots), extract(control).replaceAll("I", "İ"));
  assert.match(extract(withDots), /Requirements: Playwright/u);
  assert.match(extract(withDots), /Salary 90000 EUR/u);

  // Raw-text content stays exact, with no character spliced in from the closing tag. Asserted on
  // the element's own text rather than the document's, so the claim is about the boundary and not
  // about where block breaks land.
  const textarea = findElement(
    parseHtml("<div>İ<textarea>EXACT_CONTENT_1234567890</textarea><p>t</p></div>").root,
    (node) => node.tag === "textarea",
  );
  assert.notEqual(textarea, null);
  assert.equal(collectText(textarea), "EXACT_CONTENT_1234567890");

  // And the name has to end where a tag name may end: `</textareaX` is not a close tag.
  assert.match(
    collectText(parseHtml("<textarea>keep</textareaX> more</textarea><p>t</p>").root),
    /keep<\/textareaX> more/u,
  );
});

test("a manifest that cannot be written does not replace the failure it was written for", async (t) => {
  const { outDir } = batchWorkspace(t);
  // Each scenario seals a directory mid-run, so the restore must be in a `finally` and not a bare
  // statement after the assertion: an assertion that fails skips everything below it, and the
  // disposable workspace's own cleanup hook — registered first, therefore run first — would then
  // throw ENOTEMPTY on the still-sealed directory and leave it on disk permanently, at exactly the
  // moment this test's diagnostics are the thing being trusted.
  const sealing = async (name, run) => {
    const target = join(outDir, name);
    mkdirSync(target, { mode: 0o700 });
    try {
      await run(target);
    } finally {
      chmodSync(target, 0o700);
    }
  };

  // The record loop fails, and the directory becomes unwritable in the same breath — the shape a
  // batch takes when the disk or the sandbox is the underlying problem. The record error is the
  // root cause and must survive; the write error is a consequence of the same bad state.
  await sealing("sealed", async (target) => {
    await assert.rejects(runVacancyFetchBatch({
      urls: [GENERIC_REF, "https://careers.example/second"],
      outDir: target,
      batch: "gate-13",
      delayMs: 10,
      sleep: async () => {
        chmodSync(target, 0o500);
        throw new Error("root cause to keep");
      },
      fetchImpl: stubFetch(fixtureRoutes()),
      now: () => new Date("2026-08-18T09:00:00.000Z"),
    }), /root cause to keep/u);
    chmodSync(target, 0o700);
    assert.equal(existsSync(join(target, manifestBasename)), false);
  });

  // A capture that cannot be written is its own bounded code, raised before the manifest.
  await sealing("sealed-capture", async (target) => {
    await assert.rejects(runVacancyFetchBatch({
      urls: [GENERIC_REF],
      outDir: target,
      batch: "gate-14",
      delayMs: 0,
      fetchImpl: async (url, options) => {
        chmodSync(target, 0o500);
        return stubFetch(fixtureRoutes())(url, options);
      },
      now: () => new Date("2026-08-18T09:00:00.000Z"),
    }), (error) => {
      assert.ok(error instanceof VacancyFetchError);
      assert.equal(error.code, "capture_write_failed");
      return true;
    });
  });

  // And with every record complete and nothing pending, a manifest that cannot be written is
  // itself the outcome and carries its own bounded code rather than being swallowed.
  //
  // The clock is read four times for a single-record batch: the batch start, the request start,
  // the request end, and the finish stamp. Sealing on the fourth means the capture is already on
  // disk and only the manifest write can fail. If a later edit changes that count, this scenario
  // fails loudly on the wrong bounded code rather than quietly testing nothing.
  await sealing("sealed-manifest", async (target) => {
    let clockReads = 0;
    await assert.rejects(runVacancyFetchBatch({
      urls: [GENERIC_REF],
      outDir: target,
      batch: "gate-15",
      delayMs: 0,
      fetchImpl: stubFetch(fixtureRoutes()),
      now: () => {
        clockReads += 1;
        if (clockReads === 4) chmodSync(target, 0o500);
        return new Date("2026-08-18T09:00:00.000Z");
      },
    }), (error) => {
      assert.ok(error instanceof VacancyFetchError);
      assert.equal(error.code, "manifest_write_failed");
      return true;
    });
    chmodSync(target, 0o700);
    assert.equal(existsSync(join(target, manifestBasename)), false);
    assert.equal(existsSync(join(target, captureBasename(1))), true);
  });
});
