// The publishability scan, proved on disposable trees rather than on this repository.
//
// Every case builds its own tiny tree, so a finding this file asserts is a finding the scanner
// produced from content written three lines above it. Scanning the real tree instead would make
// every expectation a moving target and would prove nothing about a class nobody has leaked yet.
//
// The expectations below are literals, never read back out of the module under test. That is the
// lesson this repository already paid for once: a table pin that took its numbers from the table
// missed three stale values. The prose of the tool's own README is the third anchor, and the cases
// at the bottom tie all three together.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CANDIDATE_MARKERS_FILE,
  CANDIDATE_MARKERS_KEYS,
  MARKER_SOURCE_PATHS,
  PUBLIC_ALLOWANCES,
  PUBLIC_MARKERS,
  PUBLIC_TEXT_ALLOWANCES,
  PUBLISHABILITY_CLASSES,
  PublishabilityError,
  coversPath,
  isMarkerSource,
  loadCandidateMarkers,
  validateCandidateMarkers,
} from "../tools/publishability/markers.mjs";
import { scanText, scanTree } from "../tools/publishability/scan.mjs";
import { REPORTED_FILE_LIMIT, USAGE, parseArguments, run } from "../tools/publishability/cli.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "tools", "publishability", "cli.mjs");

// Frozen a second time, on purpose. Reading the ids out of the module would make the comparison a
// tautology; reading them out of the README would make the README's own pin a tautology too.
const PINNED_CLASSES = ["personal_marker", "shared_template", "private_path", "cyrillic_prose"];

const PINNED_MARKERS = [
  ["template.email", "shared_template"],
  ["template.home-path", "shared_template"],
  ["template.hh-vacancy", "shared_template"],
  ["path.backlog", "private_path"],
  ["path.archive", "private_path"],
  ["path.research", "private_path"],
  ["path.audits", "private_path"],
  ["path.product-decisions", "private_path"],
  ["path.candidate", "private_path"],
  ["text.cyrillic", "cyrillic_prose"],
];

const PINNED_REFUSAL_CODES = [
  "publishability_file_not_text",
  "publishability_file_unreadable",
  "publishability_markers_invalid",
  "publishability_markers_root_invalid",
  "publishability_markers_schema_version_unsupported",
  "publishability_markers_unreadable",
  "publishability_message_unreadable",
  "publishability_scan_invalid",
  "publishability_tracked_paths_unavailable",
];

const PINNED_MARKER_SOURCES = ["tools/publishability/", "tests/publishability.test.mjs"];

// The tracked example's shape, frozen here. Read back out of the example it would be a tautology:
// trimming the example to one marker and an empty data list would keep the case green.
const PINNED_EXAMPLE_MARKERS = 10;
const PINNED_EXAMPLE_DATA_PATHS = 37;
// Ids name what a marker is, never what it matches, because the report prints every declared id.
const PINNED_EXAMPLE_IDS = [
  "application.1",
  "employer.1",
  "employer.2",
  "geo.residence",
  "geo.timezone",
  "identity.email",
  "identity.given-name",
  "identity.handle",
  "identity.surname",
  "profile.path",
];

// The one waived literal, written out here so a change to it has to be made twice.
const PINNED_ATTRIBUTION_ADDRESS = "noreply@anthropic.com";

function disposableRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "publishability-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

/** Write a tiny tree and return its root and the paths, in the order they were given. */
function tree(t, files) {
  const root = disposableRoot(t);
  for (const [path, body] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, body);
  }
  return { paths: Object.keys(files), root };
}

/** A tiny git repository with an exclusion list, so the shipped entry point can be driven on it. */
function repository(t, files) {
  const root = disposableRoot(t);
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "export-exclusions.json"), JSON.stringify({
    exclude: [{ kind: "directory", path: "docs/archive/", why: "history" }],
    keep: [],
    schema_version: 1,
  }));
  for (const [path, body] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, body);
  }
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

function scan(built, options = {}) {
  return scanTree({ markers: PUBLIC_MARKERS, paths: built.paths, root: built.root, ...options });
}

function markerIds(report) {
  return report.findings.map((finding) => finding.marker).sort();
}

const CYRILLIC_WORD = "\u043f\u0440\u0438\u043c\u0435\u0440";

test("each finding class is caught, with its code, path and line", (t) => {
  const built = tree(t, {
    "a/plain.md": "nothing here\n",
    "a/script.md": `first\n${CYRILLIC_WORD}\n`,
    "a/mail.md": "write to someone@a-real-domain.org\n",
    "a/path.md": "see docs/backlog/001-x.md\n",
  });
  const report = scan(built);

  assert.deepEqual(report.findings, [
    { class: "cyrillic_prose", exported: true, line: 2, marker: "text.cyrillic", path: "a/script.md" },
    { class: "shared_template", exported: true, line: 1, marker: "template.email", path: "a/mail.md" },
    { class: "private_path", exported: true, line: 1, marker: "path.backlog", path: "a/path.md" },
  ]);
  assert.equal(report.places, 3);
  assert.equal(report.byClass.cyrillic_prose.total, 1);
  assert.equal(report.byClass.private_path.total, 1);
  assert.equal(report.byClass.shared_template.total, 1);
  assert.equal(report.byClass.personal_marker, undefined);
});

test("the audits and the product-decision register are private paths", (t) => {
  const built = tree(t, {
    "a/audit.md": "see docs/audits/pipeline.md\n",
    "a/register.md": "see docs/product-decisions.md\n",
    // A path that only ends the same way is not the register, and a neighbour is not the area.
    "a/other.md": "see tools/docs/audits/x.md and docs/auditsX/y.md and docs/product-decisionsX\n",
  });

  assert.deepEqual(scan(built).findings, [
    { class: "private_path", exported: true, line: 1, marker: "path.audits", path: "a/audit.md" },
    {
      class: "private_path",
      exported: true,
      line: 1,
      marker: "path.product-decisions",
      path: "a/register.md",
    },
  ]);
});

test("a personal marker is caught only when the layer supplies it", (t) => {
  const built = tree(t, { "a/story.md": "Juniper Ashcombe joined in May.\n" });

  assert.deepEqual(scan(built).findings, []);

  const personal = [{
    class: "personal_marker",
    id: "identity.surname",
    pattern: /Ashcombe/u,
  }];
  const report = scan(built, { markers: [...PUBLIC_MARKERS, ...personal] });
  assert.deepEqual(report.findings, [
    { class: "personal_marker", exported: true, line: 1, marker: "identity.surname", path: "a/story.md" },
  ]);
});

test("a marker source is read by the personal markers and by no public one", (t) => {
  // The case a skip by path cannot see: a real markers file copied over the tracked example, or a
  // real name pasted into the scanner's own directory. The public template on the second line is
  // what the scanner's own files carry by design, and it must stay silent there.
  const body = "Juniper Ashcombe\nsee docs/archive/x.md\n";
  const built = tree(t, {
    [`candidate.example/${CANDIDATE_MARKERS_FILE}`]: body,
    [CANDIDATE_MARKERS_FILE]: body,
    "tools/publishability/x.mjs": body,
  });
  const personal = { class: "personal_marker", id: "identity.surname", pattern: /Ashcombe/u };

  const publicOnly = scan(built);
  assert.deepEqual(publicOnly.findings, []);
  // No marker applies to a marker source without the layer, so it is stepped over, not read.
  assert.equal(publicOnly.skipped, 3);
  assert.equal(publicOnly.scanned, 0);

  const withLayer = scan(built, { markers: [...PUBLIC_MARKERS, personal] });
  assert.deepEqual(withLayer.findings, [
    {
      class: "personal_marker",
      exported: true,
      line: 1,
      marker: "identity.surname",
      path: `candidate.example/${CANDIDATE_MARKERS_FILE}`,
    },
    { class: "personal_marker", exported: true, line: 1, marker: "identity.surname", path: CANDIDATE_MARKERS_FILE },
    {
      class: "personal_marker",
      exported: true,
      line: 1,
      marker: "identity.surname",
      path: "tools/publishability/x.mjs",
    },
  ]);
  assert.equal(withLayer.skipped, 0);
  assert.equal(withLayer.scanned, 3);

  // A layer allowance reaches a marker source like any other path; with nothing left to apply, the
  // file is stepped over again.
  const waived = scan(built, {
    allow: [{ marker: "identity.surname", path: "tools/publishability/" }],
    markers: [...PUBLIC_MARKERS, personal],
  });
  assert.deepEqual(waived.findings.map((finding) => finding.path), [
    `candidate.example/${CANDIDATE_MARKERS_FILE}`,
    CANDIDATE_MARKERS_FILE,
  ]);
  assert.equal(waived.skipped, 1);
  assert.equal(waived.scanned, 2);
});

test("a finding never carries the text it matched", (t) => {
  const secret = "Ashcombe";
  const built = tree(t, { "a/story.md": `${secret} was here\n` });
  const report = scan(built, {
    markers: [{ class: "personal_marker", id: "identity.surname", pattern: /Ashcombe/u }],
  });
  const printed = JSON.stringify(report);
  assert.equal(report.findings.length, 1);
  // The whole report, not only the finding: a count keyed by the matched text would leak it too.
  assert.doesNotMatch(printed, new RegExp(secret));
});

test("an allowance is keyed by marker and path, and silences only that pair", (t) => {
  const built = tree(t, {
    "fixtures/page.html": `someone@a-real-domain.org and docs/archive/x.md\n`,
    "other/page.html": "someone@a-real-domain.org\n",
  });
  const allow = [{ marker: "template.email", path: "fixtures/", why: "captured page" }];
  const report = scan(built, { allow });

  // The waived marker is gone from the waived path; the second marker on the same line is not,
  // and the same marker elsewhere is not either.
  assert.deepEqual(report.findings, [
    { class: "private_path", exported: true, line: 1, marker: "path.archive", path: "fixtures/page.html" },
    { class: "shared_template", exported: true, line: 1, marker: "template.email", path: "other/page.html" },
  ]);
});

test("a data path silences the script class alone", (t) => {
  const built = tree(t, {
    "data/vocabulary.json": `{"phrase": "${CYRILLIC_WORD}", "note": "someone@a-real-domain.org"}\n`,
    "prose/guide.md": `${CYRILLIC_WORD}\n`,
  });
  const report = scan(built, {
    cyrillicData: [{ path: "data/vocabulary.json", why: "detector phrases" }],
  });

  assert.deepEqual(report.findings, [
    { class: "shared_template", exported: true, line: 1, marker: "template.email", path: "data/vocabulary.json" },
    { class: "cyrillic_prose", exported: true, line: 1, marker: "text.cyrillic", path: "prose/guide.md" },
  ]);
});

test("the excluded area is counted apart from the exported one", (t) => {
  const built = tree(t, {
    "kept/guide.md": `${CYRILLIC_WORD}\n`,
    "left/guide.md": `${CYRILLIC_WORD}\n`,
  });
  const report = scan(built, { isExported: (path) => !path.startsWith("left/") });

  assert.deepEqual(report.byMarker["text.cyrillic"], { excluded: 1, exported: 1, total: 2 });
  assert.deepEqual(report.byClass.cyrillic_prose, { excluded: 1, exported: 1, total: 2 });
  // The sum over the two areas is the total; without that the report cannot be checked at all.
  const tally = report.byClass.cyrillic_prose;
  assert.equal(tally.exported + tally.excluded, tally.total);
  assert.deepEqual(report.files.map((entry) => [entry.path, entry.exported]), [
    ["kept/guide.md", true],
    ["left/guide.md", false],
  ]);
});

test("one line matching two markers is one place and two marker counts", (t) => {
  const built = tree(t, { "a/both.md": `docs/research/x.md ${CYRILLIC_WORD}\n` });
  const report = scan(built);

  assert.equal(report.places, 1);
  assert.deepEqual(markerIds(report), ["path.research", "text.cyrillic"]);
  assert.equal(report.byMarker["path.research"].total, 1);
  assert.equal(report.byMarker["text.cyrillic"].total, 1);
  assert.deepEqual(report.files, [{
    exported: true,
    markers: { "path.research": 1, "text.cyrillic": 1 },
    path: "a/both.md",
    total: 2,
  }]);
});

test("the bare layer name is not a path into the layer", (t) => {
  const built = tree(t, {
    "a/contract.md": "the private layer lives in candidate/ and git ignores it\n",
    "a/pointer.md": "see candidate/research/notes.md\n",
    "a/sibling.md": "the tracked example is candidate.example/ beside it\n",
    "a/tool.md": "the reader is tools/candidate/load.mjs\n",
  });
  assert.deepEqual(scan(built).findings, [
    { class: "private_path", exported: true, line: 1, marker: "path.candidate", path: "a/pointer.md" },
  ]);
});

test("a marker source is never its own finding", (t) => {
  const built = tree(t, {
    "tools/publishability/markers.mjs": "docs/backlog/ and someone@a-real-domain.org\n",
    "tests/publishability.test.mjs": `docs/archive/ and ${CYRILLIC_WORD}\n`,
    "tools/publishability-lookalike/x.mjs": "docs/backlog/\n",
    [`candidate.example/${CANDIDATE_MARKERS_FILE}`]: '{"pattern": "docs/research/"}\n',
  });
  // The third path is here so the rule is a segment-boundary match and not a text prefix.
  assert.deepEqual(scan(built).findings, [
    {
      class: "private_path",
      exported: true,
      line: 1,
      marker: "path.backlog",
      path: "tools/publishability-lookalike/x.mjs",
    },
  ]);
  assert.equal(isMarkerSource("tools/publishability/scan.mjs"), true);
  assert.equal(isMarkerSource("tools/publishability-lookalike/x.mjs"), false);
  assert.equal(isMarkerSource("tests/publishability.test.mjs"), true);
  // The layer's own file is a marker source by name, wherever a copy of it sits. Without this the
  // tracked example reports every one of its own patterns as a finding — which is exactly what it
  // did until the example was committed and the aggregate gate said so.
  assert.equal(isMarkerSource(`candidate.example/${CANDIDATE_MARKERS_FILE}`), true);
  assert.equal(isMarkerSource(CANDIDATE_MARKERS_FILE), true);
  assert.equal(isMarkerSource(`docs/${CANDIDATE_MARKERS_FILE}.md`), false);
});

test("the scanner refuses a file it cannot read as text", (t) => {
  const built = tree(t, { "a/blob.bin": `head${String.fromCharCode(0)}tail\n` });
  assert.throws(() => scan(built), (error) => {
    assert.equal(error instanceof PublishabilityError, true);
    assert.equal(error.code, "publishability_file_not_text");
    return true;
  });
});

test("a tracked path with no file is skipped and counted, not refused", (t) => {
  // Deleted and not yet staged is an ordinary working state, and nothing can hide in a file that
  // is not there. Every other way of failing to read one is still a refusal.
  const built = tree(t, { "a/present.md": "see docs/archive/x.md\n" });
  const report = scan(built, { paths: [...built.paths, "a/gone.md", "a/gone-dir/x.md"] });

  assert.deepEqual(report.absent, ["a/gone.md", "a/gone-dir/x.md"]);
  assert.equal(report.scanned, 1);
  // A directory where a file belongs is present and unreadable, so it is a refusal, not absence.
  mkdirSync(join(built.root, "a", "as-dir.md"), { recursive: true });
  assert.throws(
    () => scan(built, { paths: [...built.paths, "a/as-dir.md"] }),
    (error) => {
      assert.equal(error.code, "publishability_file_unreadable");
      return true;
    },
  );
  assert.deepEqual(report.findings, [
    { class: "private_path", exported: true, line: 1, marker: "path.archive", path: "a/present.md" },
  ]);
});

test("the message scan waives the attribution trailer and nothing beside it", () => {
  const clean = scanText({
    markers: PUBLIC_MARKERS,
    text: `fix: something\n\nCo-Authored-By: Someone <${PINNED_ATTRIBUTION_ADDRESS}>\n`,
    textAllow: PUBLIC_TEXT_ALLOWANCES,
  });
  assert.deepEqual(clean.findings, []);

  // The waiver removes its literal and scans what is left, so a real address on the same line is
  // still reported. A trailer block stripped wholesale would have hidden it.
  const beside = scanText({
    markers: PUBLIC_MARKERS,
    text: `fix\n\nCo-Authored-By: X <${PINNED_ATTRIBUTION_ADDRESS}>, cc someone@a-real-domain.org\n`,
    textAllow: PUBLIC_TEXT_ALLOWANCES,
  });
  assert.deepEqual(beside.findings, [
    { class: "shared_template", line: 3, marker: "template.email" },
  ]);

  const body = scanText({
    markers: PUBLIC_MARKERS,
    text: "chore: move docs/backlog/001-x.md\n",
    textAllow: PUBLIC_TEXT_ALLOWANCES,
  });
  assert.deepEqual(body.findings, [{ class: "private_path", line: 1, marker: "path.backlog" }]);
  assert.equal(body.places, 1);

  // One name, one meaning, in both modes: a line matching two markers is one place, not two. The
  // pre-push of the private board reads this field.
  const twice = scanText({
    markers: PUBLIC_MARKERS,
    text: `docs/backlog/x.md ${CYRILLIC_WORD}\n`,
    textAllow: PUBLIC_TEXT_ALLOWANCES,
  });
  assert.equal(twice.findings.length, 2);
  assert.equal(twice.places, 1);
});

test("the layer's markers file is validated in both directions", () => {
  const valid = {
    allow: [{ marker: "identity.surname", path: "tools/x.mjs", why: "reference data" }],
    cyrillic_data: [{ path: "config/x.json", why: "detector phrases" }],
    markers: [{ id: "identity.surname", pattern: "Ashcombe", why: "the surname" }],
    schema_version: 1,
  };
  const loaded = validateCandidateMarkers(valid);
  assert.equal(loaded.markers.length, 1);
  assert.equal(loaded.markers[0].class, "personal_marker");
  assert.equal(loaded.markers[0].pattern.test("Ashcombe"), true);

  const refuses = (mutate, code) => {
    const copy = JSON.parse(JSON.stringify(valid));
    mutate(copy);
    assert.throws(() => validateCandidateMarkers(copy), (error) => {
      assert.equal(error instanceof PublishabilityError, true);
      assert.equal(error.code, code, JSON.stringify(copy));
      return true;
    });
  };

  refuses((copy) => { copy.schema_version = 2; }, "publishability_markers_schema_version_unsupported");
  refuses((copy) => { delete copy.schema_version; }, "publishability_markers_schema_version_unsupported");
  // A misspelled key is the reason this direction exists: `markerz` would leave the personal set
  // empty and report a clean tree nobody earned.
  refuses((copy) => { copy.markerz = copy.markers; }, "publishability_markers_invalid");
  // Without `allow`, the emptiness of `markers` is the only thing left that can refuse: with an
  // allow entry present, the undeclared-marker check answers with the same code and the case would
  // pass whether the emptiness check exists or not.
  assert.throws(
    () => validateCandidateMarkers({ markers: [], schema_version: 1 }),
    (error) => {
      assert.equal(error.code, "publishability_markers_invalid");
      assert.match(error.message, /markers is not a non-empty array/);
      return true;
    },
  );
  refuses((copy) => { copy.markers[0].id = "template.email"; }, "publishability_markers_invalid");
  refuses((copy) => { copy.markers.push({ id: "identity.surname", pattern: "X", why: "y" }); }, "publishability_markers_invalid");
  refuses((copy) => { delete copy.markers[0].why; }, "publishability_markers_invalid");
  refuses((copy) => { copy.markers[0].pattern = "("; }, "publishability_markers_invalid");
  refuses((copy) => { copy.markers[0].pattern = ""; }, "publishability_markers_invalid");
  refuses((copy) => { copy.allow[0].marker = "nobody.declared"; }, "publishability_markers_invalid");
  refuses((copy) => { delete copy.allow[0].why; }, "publishability_markers_invalid");
  refuses((copy) => { copy.allow[0].path = "/absolute"; }, "publishability_markers_invalid");
  refuses((copy) => { copy.cyrillic_data[0].path = "../escape"; }, "publishability_markers_invalid");
  refuses((copy) => { delete copy.cyrillic_data[0].why; }, "publishability_markers_invalid");

  assert.throws(() => loadCandidateMarkers({ root: "" }), (error) => {
    assert.equal(error.code, "publishability_markers_root_invalid");
    return true;
  });
  assert.throws(() => loadCandidateMarkers({ root: join(repoRoot, "no-such-layer") }), (error) => {
    assert.equal(error.code, "publishability_markers_unreadable");
    return true;
  });
});

test("the markers file has a size budget, and it is counted in bytes", (t) => {
  const root = disposableRoot(t);
  // Every character here is two bytes in UTF-8, so a file under the limit by character count and
  // over it by byte count is the one case that tells the two readings apart.
  const why = "\u0431".repeat(200 * 1024);
  writeFileSync(join(root, CANDIDATE_MARKERS_FILE), JSON.stringify({
    markers: [{ id: "identity.surname", pattern: "Ashcombe", why }],
    schema_version: 1,
  }));
  assert.throws(() => loadCandidateMarkers({ root }), (error) => {
    assert.equal(error.code, "publishability_markers_unreadable");
    assert.match(error.message, /larger than this reader accepts/);
    return true;
  });
});

test("the tracked example is a fictional candidate the real tree never matches", () => {
  const layer = loadCandidateMarkers({ root: join(repoRoot, "candidate.example") });
  assert.deepEqual(layer.markers.map((marker) => marker.id).sort(), PINNED_EXAMPLE_IDS);
  assert.equal(layer.markers.length, PINNED_EXAMPLE_MARKERS);
  assert.equal(layer.cyrillicData.length, PINNED_EXAMPLE_DATA_PATHS);
  for (const marker of layer.markers) assert.ok(marker.why.length > 0, marker.id);
  for (const entry of layer.allow) assert.ok(entry.why.length > 0);
  for (const entry of layer.cyrillicData) assert.ok(entry.why.length > 0);

  // The point of the example is that the suite runs on it and stays green: a pattern of the
  // fictional candidate that matched this repository outside the example would mean the example
  // is not fictional. Inside it the markers must match — the profile, the lever bank and the
  // letter samples there are that candidate's own documents — and that match is what shows the
  // exclusion below is not empty.
  const report = run({
    argv: ["--candidate-root", join(repoRoot, "candidate.example")],
    root: repoRoot,
  }).report;
  assert.equal(report.markers.personal, PINNED_EXAMPLE_MARKERS);
  assert.equal(report.data_allowances, PINNED_EXAMPLE_DATA_PATHS);
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const personal = scanTree({ allow: layer.allow, markers: layer.markers, paths: tracked, root: repoRoot })
    .findings
    .filter((finding) => finding.class === "personal_marker");
  const inExample = (finding) => finding.path.startsWith("candidate.example/");
  assert.deepEqual(personal.filter((finding) => !inExample(finding)), []);
  // The markers file always finds its own patterns, so it is left out here: what this proves is
  // that the profile, the lever bank and the letter samples carry them.
  const inExampleDocument = (finding) => inExample(finding)
    && finding.path !== `candidate.example/${CANDIDATE_MARKERS_FILE}`;
  assert.ok(personal.some(inExampleDocument), "the example's own documents carry its markers");
});

test("without a candidate root the personal class is absent rather than zero", () => {
  const { report } = run({ argv: [], root: repoRoot });
  assert.equal(report.markers.personal, null);
  assert.equal(report.markers.personal_source, null);
  assert.equal(report.data_allowances, null);
  assert.equal(report.by_class.personal_marker, undefined);
  assert.equal(report.markers.public, PINNED_MARKERS.length);
});

test("the report rolls up by file and bounds what it prints", (t) => {
  // Driven on a repository this case builds. Asserting that the real tree still has findings would
  // go red the day the cleanup finishes, which is the outcome tasks 150-163 and 167 exist to reach.
  // Frozen here, so the limit is a decision a reader can see rather than whatever the module says.
  assert.equal(REPORTED_FILE_LIMIT, 20);
  const count = REPORTED_FILE_LIMIT + 3;
  const root = repository(t, {
    ...Object.fromEntries(Array.from({ length: count }, (unused, index) => [
      `a/file-${String(index).padStart(3, "0")}.md`,
      "docs/archive/x.md\n".repeat(index + 1),
    ])),
    // Excluded, and with more findings than anything exported: without the area filter it would
    // lead the roll-up, and nothing else in this case would notice.
    "docs/archive/loudest.md": "docs/archive/x.md\n".repeat(count + 50),
    // A marker source, to prove `scanned` counts files read rather than paths git listed.
    "tests/publishability.test.mjs": "docs/archive/x.md\n",
  });

  const { report } = run({ argv: [], root });
  assert.equal(report.files_with_findings, count);
  assert.equal(report.files.length, REPORTED_FILE_LIMIT);
  assert.equal(report.files_omitted, 3);
  // Files actually read: the exclusion list, the excluded file and the rest. The marker source is
  // not among them — it is counted by `skipped` on the next line, and the three add up to the 25
  // paths git lists here.
  assert.equal(report.scanned, count + 2);
  assert.equal(report.absent, 0);
  assert.equal(report.skipped, 1);
  for (const entry of report.files) assert.equal(entry.exported, true);
  assert.ok(report.files.every((entry) => !entry.path.startsWith("docs/archive/")));
  // Descending, so the file worth opening first is the first one printed, and the roll-up is cut
  // after sorting rather than before.
  const totals = report.files.map((entry) => entry.total);
  assert.deepEqual([...totals].sort((left, right) => right - left), totals);
  assert.equal(totals[0], count);
  assert.equal(report.findings, undefined);

  const listed = run({ argv: ["--list"], root }).report.findings;
  assert.ok(listed.length > 0);
  assert.ok(listed.every((finding) => !finding.path.startsWith("docs/archive/")));
  for (const finding of listed) {
    assert.deepEqual(Object.keys(finding).sort(), ["class", "exported", "line", "marker", "path"]);
    assert.equal(finding.exported, true);
  }
});

test("the blocking flag is the only difference between reporting and refusing", (t) => {
  const root = disposableRoot(t);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "export-exclusions.json"), JSON.stringify({
    exclude: [{ kind: "directory", path: "docs/archive/", why: "history" }],
    keep: [],
    schema_version: 1,
  }));
  writeFileSync(join(root, "clean.md"), "nothing here\n");
  git("add", "-A");

  const clean = () => run({ argv: ["--blocking"], root });
  assert.equal(clean().report.places_exported, 0);

  // A finding inside the area the export leaves behind is reported and must not refuse: it never
  // reaches a published tree.
  mkdirSync(join(root, "docs", "archive"), { recursive: true });
  writeFileSync(join(root, "docs", "archive", "old.md"), "see docs/archive/older.md\n");
  git("add", "-A");
  const behind = run({ argv: ["--blocking"], root });
  assert.equal(behind.report.places, 1);
  assert.equal(behind.report.places_exported, 0);

  writeFileSync(join(root, "leak.md"), "see docs/archive/old.md\n");
  git("add", "-A");
  const dirty = run({ argv: ["--blocking"], root });
  assert.equal(dirty.report.places, 2);
  assert.equal(dirty.report.places_exported, 1);
  assert.equal(dirty.parsed.blocking, true);

  // The exit code is `main`'s, and it is the one thing the export task switches on.
  const exits = (args) => {
    const result = execFileSync(process.execPath, [cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, JOB_PIPELINE_WORKSPACE_ROOT: root },
    });
    return JSON.parse(result);
  };
  assert.equal(exits([]).status, "reported");
  assert.equal(exits([]).places_exported, 1);
  assert.throws(() => exits(["--blocking"]), (error) => {
    assert.equal(error.status, 1);
    assert.equal(JSON.parse(error.stdout).status, "findings");
    return true;
  });

  // The verdict itself, on the one tree where the two counters disagree: a finding that sits only
  // in the area the export leaves behind must not refuse. Asserting the report's numbers is not
  // enough — `blocked` is computed in `main`, and it is the exit code the export task switches on.
  rmSync(join(root, "leak.md"));
  git("add", "-A");
  const behindOnly = exits(["--blocking"]);
  assert.equal(behindOnly.status, "reported");
  assert.equal(behindOnly.places, 1);
  assert.equal(behindOnly.places_exported, 0);
});

test("a real markers file copied over the example refuses the blocking gate", (t) => {
  // The export gate runs with the layer, so this is the run that has to see the copy. The markers
  // file of the tracked example and a file of the scanner itself both carry the real pattern.
  const layer = disposableRoot(t);
  writeFileSync(join(layer, CANDIDATE_MARKERS_FILE), JSON.stringify({
    markers: [{ id: "identity.surname", pattern: "Ashcombe", why: "the surname" }],
    schema_version: 1,
  }));
  const fictional = JSON.stringify({
    markers: [{ id: "identity.surname", pattern: "Fernhollow", why: "the surname" }],
    schema_version: 1,
  });
  const root = repository(t, {
    [`candidate.example/${CANDIDATE_MARKERS_FILE}`]: fictional,
    "tools/publishability/x.mjs": "// Fernhollow\n",
  });
  const exits = (args) => {
    const result = execFileSync(process.execPath, [cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, JOB_PIPELINE_WORKSPACE_ROOT: root },
    });
    return JSON.parse(result);
  };
  const blocking = ["--blocking", "--candidate-root", layer, "--list"];
  const refused = () => {
    try {
      exits(blocking);
    } catch (error) {
      assert.equal(error.status, 1);
      const report = JSON.parse(error.stdout);
      assert.equal(report.status, "findings");
      return report.findings.map((finding) => [finding.path, finding.marker]);
    }
    assert.fail("the blocking gate did not refuse");
  };

  assert.equal(exits(blocking).status, "reported");

  writeFileSync(join(root, "candidate.example", CANDIDATE_MARKERS_FILE), readFileSync(join(layer, CANDIDATE_MARKERS_FILE)));
  execFileSync("git", ["add", "-A"], { cwd: root });
  assert.deepEqual(refused(), [[`candidate.example/${CANDIDATE_MARKERS_FILE}`, "identity.surname"]]);

  writeFileSync(join(root, "candidate.example", CANDIDATE_MARKERS_FILE), fictional);
  writeFileSync(join(root, "tools", "publishability", "x.mjs"), "// Ashcombe\n");
  execFileSync("git", ["add", "-A"], { cwd: root });
  assert.deepEqual(refused(), [["tools/publishability/x.mjs", "identity.surname"]]);
});

test("the command line refuses what it cannot act on", () => {
  assert.deepEqual(parseArguments([]), {
    blocking: false,
    candidateRoot: null,
    dataRoot: null,
    commitMessage: null,
    list: false,
  });
  assert.deepEqual(parseArguments(["--blocking", "--list"]), {
    blocking: true,
    candidateRoot: null,
    dataRoot: null,
    commitMessage: null,
    list: true,
  });
  for (const argv of [
    ["--unknown"],
    ["--candidate-root"],
    ["--candidate-root", "--list"],
    ["--candidate-root", "relative/path"],
    ["--candidate-root", "/x/../y"],
    ["--commit-msg"],
  ]) {
    assert.throws(() => parseArguments(argv), (error) => {
      assert.equal(error.code, "invalid_publishability_arguments", JSON.stringify(argv));
      return true;
    }, JSON.stringify(argv));
  }
  assert.match(USAGE, /--blocking/);
});

test("the message mode reads a file and refuses one it cannot", (t) => {
  const root = disposableRoot(t);
  writeFileSync(join(root, "msg.txt"), "chore: touch docs/research/x.md\n");
  const { report } = run({ argv: ["--commit-msg", "msg.txt"], root });
  assert.equal(report.mode, "commit-message");
  assert.equal(report.places, 1);
  assert.equal(report.by_marker["path.research"], 1);

  // The report's own field, not only the scanner's: `places` counts lines carrying at least one
  // match in both modes, so the pre-push that reads it gets one meaning and not two.
  writeFileSync(join(root, "two.txt"), `docs/research/x.md ${CYRILLIC_WORD}\n`);
  const two = run({ argv: ["--commit-msg", "two.txt", "--list"], root }).report;
  assert.equal(two.findings.length, 2);
  assert.equal(two.places, 1);
  assert.equal(two.places_exported, 1);

  assert.throws(() => run({ argv: ["--commit-msg", "absent.txt"], root }), (error) => {
    assert.equal(error.code, "publishability_message_unreadable");
    return true;
  });
});

// Three anchors: the literals above, the contract the module freezes, and the prose of the
// README. Each pair is pinned directly, so no side can drift alone.
test("classes, markers and refusal codes agree across test, module and README", () => {
  assert.deepEqual([...PUBLISHABILITY_CLASSES], PINNED_CLASSES);
  assert.deepEqual(
    PUBLIC_MARKERS.map((marker) => [marker.id, marker.class]),
    PINNED_MARKERS,
  );
  assert.deepEqual([...MARKER_SOURCE_PATHS], PINNED_MARKER_SOURCES);
  assert.deepEqual([...CANDIDATE_MARKERS_KEYS], [
    "allow",
    "cyrillic_data",
    "markers",
    "purpose",
    "schema_version",
  ]);
  assert.equal(CANDIDATE_MARKERS_FILE, "publishability-markers.json");
  assert.deepEqual(
    PUBLIC_TEXT_ALLOWANCES.map((entry) => [entry.marker, entry.text]),
    [["template.email", PINNED_ATTRIBUTION_ADDRESS]],
  );

  const readme = readFileSync(join(repoRoot, "tools", "publishability", "README.md"), "utf8");
  for (const name of PINNED_CLASSES) assert.match(readme, new RegExp(`\`${name}\``), name);
  for (const [id] of PINNED_MARKERS) {
    assert.match(readme, new RegExp(`\`${id.replace(/[.]/g, "\\.")}\``), id);
  }
  for (const code of PINNED_REFUSAL_CODES) assert.match(readme, new RegExp(code), code);
  // Every waiver carries a reason, and the README says so; a list without reasons cannot be
  // narrowed later by anyone who did not write it.
  for (const entry of PUBLIC_ALLOWANCES) assert.ok(entry.why.length > 0, entry.path);
  for (const marker of PUBLIC_MARKERS) assert.ok(marker.why.length > 0, marker.id);
});

test("every public allowance names a declared marker and a path that could match", () => {
  const declared = new Set(PUBLIC_MARKERS.map((marker) => marker.id));
  for (const entry of PUBLIC_ALLOWANCES) {
    assert.equal(declared.has(entry.marker), true, entry.marker);
    // A public allowance over a marker source is dead: no public marker ever reads that path.
    assert.equal(isMarkerSource(entry.path), false, entry.path);
  }
  assert.equal(coversPath("tools/x/", "tools/x/y.mjs"), true);
  assert.equal(coversPath("tools/x/", "tools/xy/z.mjs"), false);
  assert.equal(coversPath("tools/x.mjs", "tools/x.mjs"), true);
  assert.equal(coversPath("tools/x.mjs", "tools/x.mjs.bak"), false);
});

test("data-only mode never loads fictional personal markers or personal waivers", (t) => {
  const root = repository(t, {"literal.txt": `${CYRILLIC_WORD}\nprivate_person\n`, "outside.txt": CYRILLIC_WORD});
  const layer = disposableRoot(t);
  writeFileSync(join(layer, "publishability-markers.json"), JSON.stringify({schema_version:1, markers:[{id:"identity.synthetic", pattern:"private_person", why:"Synthetic marker."}], allow:[{marker:"text.cyrillic",path:"outside.txt",why:"This personal waiver must not enter CI."}], cyrillic_data:[{path:"literal.txt",why:"Synthetic configured-language data."}]}));
  const {report} = run({argv:["--blocking","--list","--data-root",layer],root});
  assert.equal(report.markers.personal, null);
  assert.equal(report.markers.personal_source, null);
  assert.equal(report.data_allowances, 1);
  assert.deepEqual(report.findings.map(x => [x.path,x.marker]), [["outside.txt","text.cyrillic"]]);
  assert.throws(() => parseArguments(["--data-root",layer,"--candidate-root",layer]));
});

test("blocking CLI refuses a missing tracked file rather than a clean-looking report", (t) => {
  const root = repository(t, { "removed.md": "# Removed\n" });
  rmSync(join(root, "removed.md"));
  const child = spawnSync(process.execPath, [cliPath, "--blocking"], {encoding:"utf8", env:{...process.env, JOB_PIPELINE_WORKSPACE_ROOT:root}});
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).absent, 1);
});
