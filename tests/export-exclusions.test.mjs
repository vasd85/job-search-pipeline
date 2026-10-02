import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  EXPORT_EXCLUSIONS_FILE,
  isExcluded,
  loadExportExclusions,
} from "../tools/export-exclusions.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every path this repository tracks, as the export would see them. */
function trackedPaths() {
  return execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 24 })
    .split("\n")
    .filter((line) => line.length > 0);
}

/** The eight decision records that decide facts about the candidate rather than about the engine. */
const CANDIDATE_DECISION_RECORDS = Object.freeze([
  "docs/adr/0004-timezone-presentation-utc3.md",
  "docs/adr/0006-cv-english-market-positioning.md",
  "docs/adr/0007-compensation-floors.md",
  "docs/adr/0008-keep-reference-reports.md",
  "docs/adr/0016-foreign-market-location-georgia-utc4.md",
  "docs/adr/0018-self-relocation-set-and-any-country-relocation.md",
  "docs/adr/0019-destination-conditional-sponsorship-statement.md",
  "docs/adr/0020-foreign-market-location-is-unconditional.md",
]);

/**
 * The private research this task moved into the candidate layer. Named here, not derived: the
 * whole point of the assertion below is that these paths are gone, and a list derived from the
 * tree would be empty and prove nothing.
 */
const MOVED_PRIVATE_RESEARCH = Object.freeze([
  "docs/research/letter-corrections/README.md",
  "docs/research/letter-corrections/records/lc_076ebcfc7c32.json",
  "docs/research/letter-revisions-2026-09/retrospective.md",
  "docs/research/publication-inventory.md",
  "docs/research/publication-markers.json",
]);

/** The register of product decisions, private since the user's decision of 2026-09-23. */
const PRODUCT_DECISION_REGISTER = "docs/product-decisions.md";

function withList(contents, run) {
  const root = mkdtempSync(join(tmpdir(), "job-search-export-exclusions-"));
  try {
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
      join(root, EXPORT_EXCLUSIONS_FILE),
      typeof contents === "string" ? contents : JSON.stringify(contents),
      { mode: 0o600 },
    );
    return run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function refusal(contents, code) {
  withList(contents, (root) => {
    assert.throws(
      () => loadExportExclusions({ root }),
      (error) => error.code === code,
      `expected ${code} for ${JSON.stringify(contents).slice(0, 120)}`,
    );
  });
}

test("the list excludes the independently named private fixture inventory", () => {
  const list = loadExportExclusions({ root: repoRoot });
  for (const path of [...CANDIDATE_DECISION_RECORDS, "docs/backlog/task.md", "docs/archive/task.md", "reference/report.md", "docs/audits/report.md", "docs/runbooks/development-gitflow.md", "tests/legacy-governance.test.mjs", "config/source-layout.json", "config/section-link-source-exceptions.json", PRODUCT_DECISION_REGISTER]) {
    assert.equal(isExcluded(path, list), true, path);
  }
});

test("the private research is both excluded and already out of the tree", () => {
  const list = loadExportExclusions({ root: repoRoot });
  const tracked = new Set(trackedPaths());

  for (const path of MOVED_PRIVATE_RESEARCH) {
    assert.equal(isExcluded(path, list), true, path);
    // The exclusion is the second lock. The first is that the letters are not here at all: they
    // live in the candidate layer, and a commit putting one back turns this red.
    assert.equal(tracked.has(path), false, `${path} is tracked again`);
  }
  // Nothing at all is left under the two moved roots.
  const left = [...tracked].filter((path) => path.startsWith("docs/research/letter-"));
  assert.deepEqual(left, []);
});

test("the old backlog README is excluded, and nothing under docs/research/ is opened", () => {
  const list = loadExportExclusions({ root: repoRoot });
  const tracked = new Set(trackedPaths());

  // The old source README moves into the private archive; the public tree has no keep entries.
  assert.equal(isExcluded("docs/backlog/README.md", list), true);
  assert.deepEqual(list.keep, []);

  // Every keep entry names a file the tree still carries. The list is judged against git rather
  // than against itself, so neither can excuse the other. This is what the frozen count of
  // research files used to catch — a document that left the tree while its keep entry stayed —
  // and it names the path instead of printing a difference of two numbers.
  for (const entry of list.keep) {
    assert.ok(tracked.has(entry.path), `keep: ${entry.path} is not in the tree`);
  }

  // No research is published: a reader of the engine needs the decision, which its ADR states,
  // not the evidence behind it. A keep entry here would reopen one file, so none may exist, and
  // every research file the tree carries stays behind.
  assert.deepEqual(list.keep.filter((entry) => entry.path.startsWith("docs/research/")), []);

  // And so is a label nobody has named yet. This is the pin: narrowing the wholesale entry to
  // the paths that exist today leaves every assertion above green and reds only this one, and it
  // would hand the next rehearsal's evidence to the single export.
  assert.equal(isExcluded("docs/research/unnamed-label/evidence.md", list), true);
});

test("a directory entry matches on a segment boundary, not as a text prefix", () => {
  const list = loadExportExclusions({ root: repoRoot });
  // `startsWith` on a slashless prefix would swallow all three of these.
  for (const path of ["docs/archiveX/note.md", "docs/researcher.md", "references/note.md"]) {
    assert.equal(isExcluded(path, list), false, path);
  }
  assert.equal(isExcluded("docs/archive/x/y.md", list), true);
});

test("a list this code cannot read is a refusal, never a pass", () => {
  const good = {
    schema_version: 1,
    exclude: [{ path: "docs/archive/", kind: "directory", why: "history" }],
    keep: [],
  };

  withList(good, (root) => {
    const list = loadExportExclusions({ root });
    assert.equal(isExcluded("docs/archive/a.md", list), true);
  });

  refusal("{", "export_exclusions_unreadable");
  refusal({ ...good, schema_version: 2 }, "export_exclusions_schema_version_unsupported");
  refusal({ ...good, exclude: [] }, "export_exclusions_invalid");
  refusal({ ...good, keep: "none" }, "export_exclusions_invalid");
  // A directory without its trailing slash is the bug the slash exists to prevent, so it is
  // refused rather than silently read as a prefix.
  refusal(
    { ...good, exclude: [{ path: "docs/archive", kind: "directory", why: "history" }] },
    "export_exclusions_invalid",
  );
  refusal(
    { ...good, exclude: [{ path: "reference/x.md/", kind: "file", why: "report" }] },
    "export_exclusions_invalid",
  );
  refusal(
    { ...good, exclude: [{ path: "docs/archive/", kind: "directory" }] },
    "export_exclusions_invalid",
  );
  refusal(
    { ...good, exclude: [{ path: "docs/archive/", why: "history" }] },
    "export_exclusions_invalid",
  );
  refusal(
    { ...good, exclude: [{ path: "../etc/passwd", kind: "file", why: "no" }] },
    "export_exclusions_invalid",
  );
  refusal(
    {
      ...good,
      exclude: [
        { path: "docs/archive/", kind: "directory", why: "history" },
        { path: "docs/archive/", kind: "directory", why: "history again" },
      ],
    },
    "export_exclusions_invalid",
  );
  // A keep entry nothing excludes reads as a decision about a path that was never in question.
  refusal(
    { ...good, keep: [{ path: "README.md", why: "it is the front door" }] },
    "export_exclusions_invalid",
  );
});
