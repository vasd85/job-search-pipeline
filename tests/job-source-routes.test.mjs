import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  failureRetryability,
  readCompensation,
  resolveSourceRoute,
  retiredRouteMarkers,
  selectPostingFromAggregate,
  sourceRouteInventory,
  statusVocabulary,
} from "../tools/job-sources/routes.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(repoRoot, "tools/job-sources/fixtures");

const PINPOINT_TARGET = "7e0c9d21-4b83-4a17-b0c6-1f2a3b4c5d6e";
const PINPOINT_OTHER = "2b1f0f4a-6c1e-4f2f-9a2b-0d5f7c3e8a10";
const PINPOINT_RESTRICTED = "9d8c7b6a-5e4f-4321-9012-3456789abcde";
const ASHBY_TARGET = "4bb16644-9c3d-4f8a-8b21-7e0a5d6c9f31";
const ASHBY_OTHER = "0c70da0f-2a5b-4e19-9d33-8f4c1b2a7e60";
const NEVER_PUBLISHED = "00000000-0000-4000-8000-000000000000";

const PINPOINT_REF = `https://tabby.pinpointhq.com/en/postings/${PINPOINT_TARGET}`;
const ASHBY_REF = `https://jobs.ashbyhq.com/super.com/${ASHBY_TARGET}`;

// Frozen fixture manifest. Every file is synthetic: it encodes this repository's own parsing
// contract, not a captured vendor response (see tools/job-sources/fixtures/README.md). The
// digests turn byte drift into a diff, the two-directional directory comparison turns an omitted
// or unlisted file into a failure, and `expectations` is the executable oracle — each pair is
// replayed through the resolver below, so the column cannot decay into decoration.
const fixtureManifest = Object.freeze([
  Object.freeze({
    caseId: "readme",
    kind: "documentation",
    file: "README.md",
    sha256: "3c1ce41cdd3eec26c6c00a6ed30ae2a86e52bd26c7c49ab3cef58240cdb3d860",
    synthetic: true,
    sourceId: null,
    expectations: Object.freeze([]),
  }),
  Object.freeze({
    caseId: "ashby_board_compensation",
    kind: "case",
    file: "ashby-board-compensation.json",
    sha256: "30f4f26c892a10b90c5b07349e2f50f7c4b05f646837db51770f1f4ecbacf52a",
    synthetic: true,
    sourceId: "ashby",
    expectations: Object.freeze([
      Object.freeze({ postingId: ASHBY_TARGET, outcome: "active" }),
      Object.freeze({ postingId: ASHBY_OTHER, outcome: "active" }),
      Object.freeze({ postingId: NEVER_PUBLISHED, outcome: "absent" }),
    ]),
  }),
  Object.freeze({
    caseId: "ashby_board_hostile_content",
    kind: "case",
    file: "ashby-board-hostile-content.json",
    sha256: "96f49ca0d98313c87737ef598ed4621fd66a9c117fcc2555a7796f06bc0d19e8",
    synthetic: true,
    sourceId: "ashby",
    expectations: Object.freeze([Object.freeze({ postingId: ASHBY_TARGET, outcome: "active" })]),
  }),
  Object.freeze({
    caseId: "ashby_board_no_compensation",
    kind: "case",
    file: "ashby-board-no-compensation.json",
    sha256: "50716ee88b1f25575a645899a625435d81b1740775eccf9503a24494191de9a0",
    synthetic: true,
    sourceId: "ashby",
    expectations: Object.freeze([Object.freeze({ postingId: ASHBY_TARGET, outcome: "active" })]),
  }),
  Object.freeze({
    caseId: "ashby_board_target_absent",
    kind: "case",
    file: "ashby-board-target-absent.json",
    sha256: "a88ce57e0045c3e9a72ad02ea27245c4daf74fd21da26d15dc4837a0df3a398f",
    synthetic: true,
    sourceId: "ashby",
    expectations: Object.freeze([
      Object.freeze({ postingId: ASHBY_TARGET, outcome: "absent" }),
      Object.freeze({ postingId: ASHBY_OTHER, outcome: "active" }),
    ]),
  }),
  Object.freeze({
    caseId: "ashby_board_unlisted",
    kind: "case",
    file: "ashby-board-unlisted.json",
    sha256: "24cea1ed6340fbf7c3549db91c768d71466b1356105518865a7cc36496389a1f",
    synthetic: true,
    sourceId: "ashby",
    expectations: Object.freeze([Object.freeze({ postingId: ASHBY_TARGET, outcome: "private" })]),
  }),
  Object.freeze({
    caseId: "pinpoint_aggregate_active",
    kind: "case",
    file: "pinpoint-aggregate-active.json",
    sha256: "197f4cdb2f129d042935767adeba35ed6464c18b7b072908d6d99df72ddfb5af",
    synthetic: true,
    sourceId: "pinpoint",
    expectations: Object.freeze([
      Object.freeze({ postingId: PINPOINT_TARGET, outcome: "active" }),
      Object.freeze({ postingId: PINPOINT_OTHER, outcome: "active" }),
      Object.freeze({ postingId: NEVER_PUBLISHED, outcome: "absent" }),
    ]),
  }),
  Object.freeze({
    caseId: "pinpoint_aggregate_closed",
    kind: "case",
    file: "pinpoint-aggregate-closed.json",
    sha256: "df9d710194ad4d1d3ada8449615fc62b281eff13ea0a3fc715b2456d2dadd4dc",
    synthetic: true,
    sourceId: "pinpoint",
    expectations: Object.freeze([
      Object.freeze({ postingId: PINPOINT_TARGET, outcome: "closed" }),
      Object.freeze({ postingId: PINPOINT_RESTRICTED, outcome: "private" }),
    ]),
  }),
  Object.freeze({
    caseId: "pinpoint_aggregate_empty",
    kind: "case",
    file: "pinpoint-aggregate-empty.json",
    sha256: "3b459147c8170c320545247d8ba79c22d55408311adafa4ad737f02c7aa78700",
    synthetic: true,
    sourceId: "pinpoint",
    expectations: Object.freeze([
      Object.freeze({ postingId: PINPOINT_TARGET, outcome: "access_failure" }),
    ]),
  }),
  Object.freeze({
    caseId: "pinpoint_aggregate_html_error",
    kind: "case",
    file: "pinpoint-aggregate-html-error.txt",
    sha256: "ba8b3713cc3cdf918d418ea9c454f8d91692e15d06a52063038f2d63161446eb",
    synthetic: true,
    sourceId: "pinpoint",
    expectations: Object.freeze([
      Object.freeze({ postingId: PINPOINT_TARGET, outcome: "access_failure" }),
    ]),
  }),
  Object.freeze({
    caseId: "pinpoint_aggregate_target_absent",
    kind: "case",
    file: "pinpoint-aggregate-target-absent.json",
    sha256: "9937445b11d2437a3dd71605bd2cf3e58c4c623c37a02cd80f9652c66d13d896",
    synthetic: true,
    sourceId: "pinpoint",
    expectations: Object.freeze([
      Object.freeze({ postingId: PINPOINT_TARGET, outcome: "absent" }),
      Object.freeze({ postingId: PINPOINT_OTHER, outcome: "active" }),
    ]),
  }),
  Object.freeze({
    caseId: "pinpoint_aggregate_truncated",
    kind: "case",
    file: "pinpoint-aggregate-truncated.txt",
    sha256: "228419eb6937dcd8e57197be2e4f14339b4b26dbf276ee51fde7ad229661def1",
    synthetic: true,
    sourceId: "pinpoint",
    expectations: Object.freeze([
      Object.freeze({ postingId: PINPOINT_TARGET, outcome: "access_failure" }),
    ]),
  }),
  Object.freeze({
    caseId: "pinpoint_aggregate_unknown_shape",
    kind: "case",
    file: "pinpoint-aggregate-unknown-shape.json",
    sha256: "887b4396a4fbedc8d3e57ba787fbd4ded1daebc171c7fcfd0098a669165a0dab",
    synthetic: true,
    sourceId: "pinpoint",
    expectations: Object.freeze([
      Object.freeze({ postingId: PINPOINT_TARGET, outcome: "access_failure" }),
    ]),
  }),
]);

const executedCases = new Set();

function fixtureBody(caseId) {
  const entry = fixtureManifest.find((candidate) => candidate.caseId === caseId);
  assert.ok(entry, `unknown fixture case ${caseId}`);
  executedCases.add(caseId);
  return readFileSync(resolve(fixtureRoot, entry.file), "utf8");
}

test("frozen fixture manifest matches the fixture directory in both directions", () => {
  assert.deepEqual(
    readdirSync(fixtureRoot).sort(),
    fixtureManifest.map((entry) => entry.file).sort(),
  );

  for (const entry of fixtureManifest) {
    const bytes = readFileSync(resolve(fixtureRoot, entry.file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, entry.file);
    assert.equal(entry.synthetic, true, entry.file);
    assert.ok(["case", "documentation"].includes(entry.kind), entry.file);
    if (entry.kind === "case") {
      assert.ok(Object.hasOwn(sourceRouteInventory, entry.sourceId), entry.file);
      assert.ok(entry.expectations.length > 0, entry.file);
    }
  }

  const caseIds = fixtureManifest.map((entry) => entry.caseId);
  assert.equal(new Set(caseIds).size, caseIds.length);

  // The directory states in its own bytes that nothing here is a captured response.
  const readme = fixtureBody("readme");
  assert.match(readme, /Every file in this directory is synthetic/);
  assert.match(readme, /never means a live route was verified/);
});

test("every declared fixture expectation is replayed through the resolver", () => {
  const replayed = [];
  for (const entry of fixtureManifest.filter((item) => item.kind === "case")) {
    const body = fixtureBody(entry.caseId);
    for (const expectation of entry.expectations) {
      const result = selectPostingFromAggregate(entry.sourceId, body, expectation.postingId);
      replayed.push({
        caseId: entry.caseId,
        postingId: expectation.postingId,
        outcome: result.outcome,
      });
      assert.equal(
        result.retryable,
        Object.hasOwn(failureRetryability, result.outcome)
          ? failureRetryability[result.outcome]
          : false,
        `${entry.caseId}/${expectation.postingId}`,
      );
      assert.equal(
        result.posting === null,
        result.outcome === "absent" || result.outcome === "access_failure",
        `${entry.caseId}/${expectation.postingId}`,
      );
    }
  }

  assert.deepEqual(
    replayed,
    fixtureManifest
      .filter((item) => item.kind === "case")
      .flatMap((item) =>
        item.expectations.map((expectation) => ({
          caseId: item.caseId,
          postingId: expectation.postingId,
          outcome: expectation.outcome,
        })),
      ),
  );

  // Pinned independently of the manifest: without it an expectation could be deleted and the
  // covered set would silently shrink instead of failing.
  assert.equal(replayed.length, 19);
  assert.deepEqual([...new Set(replayed.map((item) => item.outcome))].sort(), [
    "absent",
    "access_failure",
    "active",
    "closed",
    "private",
  ]);
});

test("route inventory is frozen, bounded and states its unverified provenance", () => {
  assert.deepEqual(Object.keys(sourceRouteInventory).sort(), ["ashby", "pinpoint"]);
  assert.ok(Object.isFrozen(sourceRouteInventory));

  for (const [id, route] of Object.entries(sourceRouteInventory)) {
    assert.ok(Object.isFrozen(route), id);
    assert.equal(route.sourceId, id);
    assert.equal(route.observedAt, "2026-07-28");
    assert.match(route.verification, /not verified by this repository/);
    for (const list of [
      route.aggregateKeys,
      route.compensationFields,
      route.statusFields,
      route.unlistedFlags,
    ]) {
      assert.ok(Object.isFrozen(list), id);
    }
  }

  assert.equal(
    sourceRouteInventory.ashby.urlTemplate,
    "https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true",
  );
  assert.equal(
    sourceRouteInventory.pinpoint.urlTemplate,
    "https://{tenant}.pinpointhq.com/postings.json",
  );
  assert.deepEqual(sourceRouteInventory.ashby.aggregateKeys, ["jobs"]);
  assert.deepEqual(sourceRouteInventory.pinpoint.aggregateKeys, ["data"]);
  assert.deepEqual(sourceRouteInventory.ashby.unlistedFlags, ["isListed"]);
  assert.deepEqual(sourceRouteInventory.pinpoint.unlistedFlags, []);
  assert.deepEqual(failureRetryability, {
    absent: false,
    closed: false,
    private: false,
    access_failure: true,
  });
  assert.deepEqual(retiredRouteMarkers, [
    "append `.json` to the posting URL",
    "https://jobs.ashbyhq.com/api/non-user-graphql",
    "non-user-graphql",
  ]);
});

// Pinned independently of the module: iterating the module's own vocabulary would let a deleted
// literal silently leave the covered set instead of failing.
const frozenStatusVocabulary = Object.freeze({
  closed: Object.freeze([
    "archived",
    "closed",
    "deleted",
    "draft",
    "expired",
    "filled",
    "removed",
    "unpublished",
  ]),
  private: Object.freeze(["confidential", "internal", "private", "restricted", "unlisted"]),
});

test("every declared status literal classifies as declared and no source is outcome-starved", () => {
  assert.deepEqual(statusVocabulary, frozenStatusVocabulary);

  for (const [expected, literals] of Object.entries(frozenStatusVocabulary)) {
    for (const literal of literals) {
      for (const sourceId of Object.keys(sourceRouteInventory)) {
        const body = JSON.stringify({
          data: [{ id: PINPOINT_TARGET, status: literal }],
          jobs: [{ id: PINPOINT_TARGET, status: literal }],
        });
        const result = selectPostingFromAggregate(sourceId, body, PINPOINT_TARGET);
        assert.equal(result.outcome, expected, `${sourceId}/${literal}`);
        assert.equal(result.retryable, false, `${sourceId}/${literal}`);
      }
    }
  }

  // Each source must be able to reach every non-transport outcome through a declared mechanism,
  // otherwise the recipe prose promises a distinction the module cannot make.
  for (const [sourceId, route] of Object.entries(sourceRouteInventory)) {
    assert.ok(route.statusFields.length > 0 || route.unlistedFlags.length > 0, sourceId);
  }

  // An unrecognized status stays active on purpose: refusing it would turn a live vacancy into a
  // failure. This is the accepted boundary, not an oversight.
  const unknown = JSON.stringify({ data: [{ id: PINPOINT_TARGET, status: "wibble" }] });
  assert.equal(selectPostingFromAggregate("pinpoint", unknown, PINPOINT_TARGET).outcome, "active");
});

test("pinpoint resolves the documented tenant aggregate and never a posting suffix", () => {
  const route = resolveSourceRoute(PINPOINT_REF);
  assert.deepEqual(route, {
    sourceId: "pinpoint",
    method: "GET",
    url: "https://tabby.pinpointhq.com/postings.json",
    board: null,
    postingId: PINPOINT_TARGET,
  });
  assert.ok(!route.url.includes(route.postingId));

  for (const variant of [
    `https://tabby.pinpointhq.com/postings/${PINPOINT_TARGET}`,
    `https://tabby.pinpointhq.com/fr/postings/${PINPOINT_TARGET}`,
    `https://tabby.pinpointhq.com/en/postings/${PINPOINT_TARGET}/`,
    `https://tabby.pinpointhq.com/en/postings/${PINPOINT_TARGET}?utm_source=x#top`,
  ]) {
    assert.deepEqual(resolveSourceRoute(variant), route, variant);
  }

  // A `postings` segment elsewhere in the path must never shift the identifier onto a locale or
  // section segment. The identifier has to be the last segment, so an unexpected shape fails
  // closed instead of resolving to the wrong posting.
  assert.equal(
    resolveSourceRoute(`https://tabby.pinpointhq.com/postings/en/${PINPOINT_TARGET}`),
    null,
  );
});

test("ashby resolves the board aggregate with the compensation parameter and keeps real slugs", () => {
  assert.deepEqual(resolveSourceRoute(ASHBY_REF), {
    sourceId: "ashby",
    method: "GET",
    url: "https://api.ashbyhq.com/posting-api/job-board/super.com?includeCompensation=true",
    board: "super.com",
    postingId: ASHBY_TARGET,
  });

  for (const [ref, expected] of [
    [
      `https://jobs.ashbyhq.com/li.fi/${ASHBY_OTHER}`,
      "https://api.ashbyhq.com/posting-api/job-board/li.fi?includeCompensation=true",
    ],
    [
      `https://jobs.ashbyhq.com/pod-network/${ASHBY_OTHER}`,
      "https://api.ashbyhq.com/posting-api/job-board/pod-network?includeCompensation=true",
    ],
  ]) {
    const route = resolveSourceRoute(ref);
    assert.equal(route.url, expected, ref);
    const url = new URL(route.url);
    assert.equal(url.origin, "https://api.ashbyhq.com");
    assert.ok(url.pathname.startsWith("/posting-api/job-board/"));
    assert.deepEqual([...url.searchParams.keys()], ["includeCompensation"]);
    assert.equal(url.searchParams.get("includeCompensation"), "true");
  }
});

test("every resolved url is the declared template with its placeholder substituted", () => {
  // Without this the inventory could advertise one route while the resolver builds another, and
  // the prose contract would keep passing because it only reads the template.
  assert.equal(
    resolveSourceRoute(ASHBY_REF).url,
    sourceRouteInventory.ashby.urlTemplate.replace("{board}", "super.com"),
  );
  assert.equal(
    resolveSourceRoute(PINPOINT_REF).url,
    sourceRouteInventory.pinpoint.urlTemplate.replace("{tenant}", "tabby"),
  );
  // A multi-label tenant must still satisfy the same template, not a second URL shape.
  assert.equal(
    resolveSourceRoute(`https://eu.tabby.pinpointhq.com/en/postings/${PINPOINT_TARGET}`).url,
    sourceRouteInventory.pinpoint.urlTemplate.replace("{tenant}", "eu.tabby"),
  );
  // Ashby's own apply URL identifies the same posting and must not fail closed.
  assert.equal(
    resolveSourceRoute(`${ASHBY_REF}/application`).url,
    resolveSourceRoute(ASHBY_REF).url,
  );
});

test("route resolution refuses lookalike hosts, traversal, apex tenants and unroutable refs", () => {
  for (const ref of [
    `https://pinpointhq.com.evil.tld/en/postings/${PINPOINT_TARGET}`,
    `https://notashbyhq.com/super.com/${ASHBY_TARGET}`,
    `https://evil.tld/?u=https://tabby.pinpointhq.com/en/postings/${PINPOINT_TARGET}`,
    `https://greenhouse.io@evil.test/super.com/${ASHBY_TARGET}`,
    "https://jobs.ashbyhq.com/../../etc/passwd",
    "https://jobs.ashbyhq.com/%2e%2e/%2e%2e/etc/passwd",
    `https://tabby.pinpointhq.com/x/.%2e/postings/${PINPOINT_TARGET}`,
    "https://tabby.pinpointhq.com/en/postings/../../etc/passwd",
    `https://pinpointhq.com/en/postings/${PINPOINT_TARGET}`,
    `https://tabby.pinpointhq.com/en/jobs/${PINPOINT_TARGET}`,
    `https://tabby.pinpointhq.com/en/postings/${PINPOINT_TARGET}/apply`,
    "https://jobs.ashbyhq.com/super.com",
    `https://jobs.ashbyhq.com/embed/super.com/${ASHBY_TARGET}`,
    `https://www.jobs.ashbyhq.com/super.com/${ASHBY_TARGET}`,
    `https://jobs.ashbyhq.com.evil.tld/super.com/${ASHBY_TARGET}`,
    "https://api.ashbyhq.com/posting-api/job-board/super.com",
    `https://jobs.ashbyhq.com/super%2Fcom/${ASHBY_TARGET}`,
    "https://boards.greenhouse.io/acme/jobs/123",
    "local-file:jd.txt",
    "direct-outreach:acme-sdet",
    "tabby.pinpointhq.com",
    "",
    null,
  ]) {
    assert.equal(resolveSourceRoute(ref), null, String(ref));
  }

  // Homograph and full-width hosts follow the single registry matcher, not a second parser.
  assert.equal(
    resolveSourceRoute(`https://tabby.pinpoіnthq.com/en/postings/${PINPOINT_TARGET}`),
    null,
  );
  assert.equal(
    resolveSourceRoute(`https://TABBY.PINPOINTHQ.COM./en/postings/${PINPOINT_TARGET}`).url,
    "https://tabby.pinpointhq.com/postings.json",
  );
});

test("an aggregate that does not contain the posting is absent, never the nearest posting", () => {
  const result = selectPostingFromAggregate(
    "pinpoint",
    fixtureBody("pinpoint_aggregate_target_absent"),
    PINPOINT_TARGET,
  );
  assert.equal(result.outcome, "absent");
  assert.equal(result.retryable, false);
  assert.equal(result.posting, null);

  const serialized = JSON.stringify(result);
  for (const foreignValue of [PINPOINT_OTHER, "Senior Backend Engineer", "Data Analyst"]) {
    assert.ok(!serialized.includes(foreignValue), foreignValue);
  }

  // A genuinely near posting: identical but for the last character, a prefix, and a case fold.
  // Each must stay absent, otherwise a neighbouring vacancy could be handed back as this one.
  const near = JSON.stringify({
    data: [
      { id: `${PINPOINT_TARGET}0`, title: "One character longer" },
      { id: PINPOINT_TARGET.slice(0, -1), title: "One character shorter" },
      { id: PINPOINT_TARGET.toUpperCase(), title: "Case folded" },
    ],
  });
  const nearResult = selectPostingFromAggregate("pinpoint", near, PINPOINT_TARGET);
  assert.equal(nearResult.outcome, "absent");
  assert.equal(nearResult.posting, null);
});

test("a present posting is active and is returned byte-identically from the aggregate", () => {
  const body = fixtureBody("pinpoint_aggregate_active");
  const result = selectPostingFromAggregate("pinpoint", body, PINPOINT_TARGET);
  assert.equal(result.outcome, "active");
  assert.deepEqual(
    result.posting,
    JSON.parse(body).data.find((entry) => entry.id === PINPOINT_TARGET),
  );
  assert.ok(Object.isFrozen(result));
});

test("posting identity tolerates numeric ids and refuses inherited or non-scalar ones", () => {
  const numeric = JSON.stringify({ data: [{ id: 12345, status: "published" }] });
  assert.equal(selectPostingFromAggregate("pinpoint", numeric, "12345").outcome, "active");

  const inherited = { data: [Object.create({ id: PINPOINT_TARGET })] };
  assert.equal(
    selectPostingFromAggregate("pinpoint", inherited, PINPOINT_TARGET).outcome,
    "absent",
  );

  const structured = JSON.stringify({ data: [{ id: { value: "x" } }, { id: ["x"] }] });
  assert.equal(selectPostingFromAggregate("pinpoint", structured, "x").outcome, "absent");
});

test("closed and private statuses stay distinct from absent on both sources", () => {
  const body = fixtureBody("pinpoint_aggregate_closed");
  const closed = selectPostingFromAggregate("pinpoint", body, PINPOINT_TARGET);
  assert.equal(closed.outcome, "closed");
  assert.equal(closed.posting.status, "archived");

  const restricted = selectPostingFromAggregate("pinpoint", body, PINPOINT_RESTRICTED);
  assert.equal(restricted.outcome, "private");

  // Ashby retires a posting by dropping it from the board and hides one by unlisting it, so the
  // unlisted flag is the only way it can reach a non-active outcome while still present.
  const unlisted = selectPostingFromAggregate(
    "ashby",
    fixtureBody("ashby_board_unlisted"),
    ASHBY_TARGET,
  );
  assert.equal(unlisted.outcome, "private");
  assert.equal(unlisted.retryable, false);
  assert.equal(unlisted.posting.isListed, false);
});

test("an empty or unusable aggregate is a retryable access failure, never absence", () => {
  // An aggregate that returned nothing at all cannot prove a posting is gone.
  const empty = selectPostingFromAggregate(
    "pinpoint",
    fixtureBody("pinpoint_aggregate_empty"),
    PINPOINT_TARGET,
  );
  assert.equal(empty.outcome, "access_failure");
  assert.equal(empty.retryable, true);

  for (const caseId of [
    "pinpoint_aggregate_html_error",
    "pinpoint_aggregate_truncated",
    "pinpoint_aggregate_unknown_shape",
  ]) {
    const result = selectPostingFromAggregate("pinpoint", fixtureBody(caseId), PINPOINT_TARGET);
    assert.equal(result.outcome, "access_failure", caseId);
    assert.equal(result.retryable, true, caseId);
    assert.equal(result.posting, null, caseId);
  }

  // A body that is not a usable posting list is a transport problem, never a permanent absence.
  for (const body of ['﻿{"data": []}', "null", "42", '"data"', "[[]]", "[1,2,3]", ""]) {
    const result = selectPostingFromAggregate("pinpoint", body, PINPOINT_TARGET);
    assert.equal(result.outcome, "access_failure", JSON.stringify(body));
    assert.equal(result.retryable, true, JSON.stringify(body));
  }
});

test("an ashby board that loads without the posting is absent, not a fetch failure", () => {
  const result = selectPostingFromAggregate(
    "ashby",
    fixtureBody("ashby_board_target_absent"),
    ASHBY_TARGET,
  );
  assert.equal(result.outcome, "absent");
  assert.equal(result.retryable, false);
  assert.equal(result.posting, null);
});

test("compensation is read from the compensation object and never invented", () => {
  const withCompensation = fixtureBody("ashby_board_compensation");
  const active = selectPostingFromAggregate("ashby", withCompensation, ASHBY_TARGET);
  assert.equal(active.outcome, "active");
  for (const bound of ["150", "189", "150K", "189K", "USD", "$"]) {
    assert.ok(!active.posting.descriptionPlain.includes(bound), bound);
    assert.ok(!active.posting.descriptionHtml.includes(bound), bound);
  }

  const explicit = readCompensation("ashby", active.posting);
  assert.equal(explicit.status, "explicit");
  assert.equal(explicit.field, "compensation");
  assert.equal(explicit.compensation.compensationTierSummary, "$150K - $189K");

  for (const digits of JSON.stringify(explicit).match(/\d+/g) ?? []) {
    assert.ok(withCompensation.includes(digits), digits);
  }

  const control = selectPostingFromAggregate(
    "ashby",
    fixtureBody("ashby_board_no_compensation"),
    ASHBY_TARGET,
  );
  assert.deepEqual(readCompensation("ashby", control.posting), {
    status: "unspecified",
    field: null,
    compensation: null,
  });
  assert.deepEqual(control.posting.descriptionPlain, active.posting.descriptionPlain);

  // A falsy-but-present figure is still an explicit statement, and an empty container is not.
  assert.deepEqual(readCompensation("ashby", { compensation: 0 }), {
    status: "explicit",
    field: "compensation",
    compensation: 0,
  });
  assert.equal(
    readCompensation("ashby", { compensation: {}, compensationTierSummary: "$1" }).field,
    "compensationTierSummary",
  );
});

test("hostile posting content flows through as inert data", () => {
  const result = selectPostingFromAggregate(
    "ashby",
    fixtureBody("ashby_board_hostile_content"),
    ASHBY_TARGET,
  );
  assert.equal(result.outcome, "active");
  assert.match(result.posting.title, /\$\(touch marker\)/);
  assert.equal(readCompensation("ashby", result.posting).status, "explicit");
  assert.equal(resolveSourceRoute(result.posting.descriptionPlain), null);
});

test("the two sources degrade independently", () => {
  assert.equal(
    selectPostingFromAggregate(
      "pinpoint",
      fixtureBody("pinpoint_aggregate_html_error"),
      PINPOINT_TARGET,
    ).outcome,
    "access_failure",
  );
  assert.equal(
    selectPostingFromAggregate("ashby", fixtureBody("ashby_board_compensation"), ASHBY_TARGET)
      .outcome,
    "active",
  );
  assert.equal(resolveSourceRoute(ASHBY_REF).sourceId, "ashby");
});

test("unknown sources and unusable posting ids fail closed", () => {
  for (const sourceId of ["greenhouse", "lever", "", null, undefined, "__proto__", "constructor"]) {
    assert.equal(
      selectPostingFromAggregate(sourceId, "[]", "x").outcome,
      "access_failure",
      String(sourceId),
    );
    assert.equal(readCompensation(sourceId, { compensation: 1 }).status, "unspecified");
  }
  for (const postingId of ["", null, undefined, 7]) {
    assert.equal(
      selectPostingFromAggregate("pinpoint", "[]", postingId).outcome,
      "access_failure",
      String(postingId),
    );
  }
  assert.deepEqual(readCompensation("pinpoint", { compensation: { a: 1 } }), {
    status: "unspecified",
    field: null,
    compensation: null,
  });
  assert.deepEqual(readCompensation("ashby", null), {
    status: "unspecified",
    field: null,
    compensation: null,
  });
});

test("every manifest file is exercised by this suite", () => {
  assert.deepEqual([...executedCases].sort(), fixtureManifest.map((entry) => entry.caseId).sort());
});
