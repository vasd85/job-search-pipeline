import assert from "node:assert/strict";
import test from "node:test";
import {
  filterProcessResults,
  listLocation,
  normalizeFilter,
  parseAppRoute,
  processMatchesFilter,
  safeExternalUrl,
} from "../web/process-search/view-model.js";

function result({
  attention = [],
  mode = "file-backed",
  state = "ready",
} = {}) {
  return {
    process: {
      mode,
      lifecycle_state: state,
      attention_steps: attention,
    },
  };
}

test("frontend routes accept only root and one safe process-id segment", () => {
  assert.deepEqual(parseAppRoute("/"), { name: "list" });
  assert.deepEqual(parseAppRoute("/processes/proc_123"), {
    name: "detail",
    processId: "proc_123",
  });
  assert.deepEqual(parseAppRoute("/processes/proc%20fixture/"), {
    name: "detail",
    processId: "proc fixture",
  });
  for (const pathname of [
    "/processes",
    "/processes/",
    "/processes/a/b",
    "/processes/%2fetc",
    "/unknown",
  ]) {
    assert.deepEqual(parseAppRoute(pathname), { name: "not-found" }, pathname);
  }
});

test("URL-backed list state omits defaults and normalizes unknown filters", () => {
  assert.equal(listLocation(), "/");
  assert.equal(
    listLocation({ query: "  Example Labs  ", filter: "attention" }),
    "/?q=Example+Labs&filter=attention",
  );
  assert.equal(
    listLocation({ query: "", filter: "unknown" }),
    "/",
  );
  assert.equal(normalizeFilter("historical"), "historical");
  assert.equal(normalizeFilter("unknown"), "all");
});

test("list filters preserve lifecycle semantics and sibling-ready processes", () => {
  const ready = result();
  const running = result({ state: "running" });
  const failed = result({ state: "failed", attention: ["generate_cv"] });
  const complete = result({ state: "complete" });
  const historical = result({ mode: "historical", state: "historical" });
  const fixtures = [ready, running, failed, complete, historical];

  assert.deepEqual(filterProcessResults(fixtures, "active"), [ready, running]);
  assert.deepEqual(filterProcessResults(fixtures, "attention"), [failed]);
  assert.deepEqual(filterProcessResults(fixtures, "completed"), [complete]);
  assert.deepEqual(filterProcessResults(fixtures, "historical"), [historical]);
  assert.equal(processMatchesFilter(failed, "active"), false);
  assert.equal(processMatchesFilter(complete, "all"), true);
});

test("only http and https source values can become external links", () => {
  assert.equal(
    safeExternalUrl("https://example.test/jobs/1"),
    "https://example.test/jobs/1",
  );
  assert.equal(
    safeExternalUrl("http://example.test/jobs/1"),
    "http://example.test/jobs/1",
  );
  assert.equal(safeExternalUrl("javascript:alert(1)"), null);
  assert.equal(safeExternalUrl("file:///private/secret"), null);
  assert.equal(safeExternalUrl("historical-fixture:example"), null);
});
