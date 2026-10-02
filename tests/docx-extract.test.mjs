/*
 * The DOCX -> cv.json reverse sync (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#5-edit-channels-and-transports(c), backlog task 019).
 *
 * Every case runs against `tests/fixtures/cv-reverse-sync/rendered-document.xml`, which is the real
 * `render.js` output for the `cv.json` beside it, with that render's `rendered-relationships.xml` — the extractor mirrors that renderer's forward
 * mapping, so a fixture written by hand would only prove the mirror agrees with itself. Regenerate
 * the pair with `node tools/cv-builder/render.js <cv.json>` and copy `word/document.xml` and
 * `word/_rels/document.xml.rels` out of the package whenever either side changes.
 *
 * The package around that part is the deterministic test builder: `docx` is not reachable from
 * `npm test`, and package integrity is `tests/docx-inspector.test.mjs`'s subject, not this file's.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DocxExtractionError,
  EXIT_UNMAPPABLE,
  FORBIDDEN_PUNCTUATION,
  extractCvEdits,
  formatPath,
  planCvSlots,
  readDocumentParagraphs,
  readRelationships,
} from "../tools/cv-builder/docx-extract.mjs";
import { linkSegments, runLinks } from "../tools/cv-builder/cv-links.mjs";
import { DocxInspectionError } from "../tools/cv-builder/docx-inspector.mjs";
import {
  MAIN_DOCUMENT_PART,
  MAIN_DOCUMENT_RELATIONSHIPS_PART,
  createDocxBytes,
} from "./fixtures/minimal-docx.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..");
const fixtureDir = join(testDir, "fixtures", "cv-reverse-sync");
const CV_TEXT = readFileSync(join(fixtureDir, "cv.json"), "utf8");
const RENDERED_DOCUMENT = readFileSync(join(fixtureDir, "rendered-document.xml"), "utf8");
// The same render's relationships part: hyperlink relationship ids are random per render, so the
// document's `r:id`s resolve only against the part written beside it.
const RENDERED_RELATIONSHIPS = readFileSync(join(fixtureDir, "rendered-relationships.xml"), "utf8");
const extractorPath = join(repoRoot, "tools", "cv-builder", "docx-extract.mjs");

function documentWith(...replacements) {
  return replacements.reduce((xml, [from, to]) => {
    assert.ok(xml.includes(from), `the fixture document does not contain ${JSON.stringify(from)}`);
    return xml.replace(from, to);
  }, RENDERED_DOCUMENT);
}

function packageOf(documentXml, options = {}) {
  return createDocxBytes({
    ...options,
    replace: {
      [MAIN_DOCUMENT_PART]: documentXml,
      [MAIN_DOCUMENT_RELATIONSHIPS_PART]: RENDERED_RELATIONSHIPS,
      ...options.replace,
    },
  });
}

function extract(documentXml, cvText = CV_TEXT, options = {}) {
  return extractCvEdits(packageOf(documentXml, options), cvText);
}

// The run properties `render.js` emits for an unformatted body run, so a test that adds a run to a
// paragraph adds one the reader treats exactly like the renderer's own.
const BODY_RUN_PROPERTIES = '<w:rPr><w:rFonts w:ascii="Calibri" w:cs="Calibri" w:eastAsia="Calibri"'
  + ' w:hAnsi="Calibri"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>';

function bodyRun(text, properties = BODY_RUN_PROPERTIES) {
  return `<w:r>${properties}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}

function changedLines(before, after) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  assert.equal(afterLines.length, beforeLines.length, "a point edit must not add or remove lines");
  return afterLines
    .map((line, index) => (line === beforeLines[index] ? null : { index, before: beforeLines[index], after: line }))
    .filter(Boolean);
}

/*
 * What the renderer will produce from the synced source is the text of the document the user
 * edited — the pair is consistent in both directions (PD-003 point 2 (docs/adr/0015-lightweight-post-review-revision.md#pd-003-the-product-decision-this-record-implements)). The rebuild itself cannot run
 * here (`docx` is not reachable from `npm test`), so this compares the plan against the document;
 * that the plan is the renderer's own sequence is pinned separately against real renderer output.
 */
function assertPairConsistent(cvText, documentXml, label) {
  const slots = planCvSlots(JSON.parse(cvText));
  const content = readDocumentParagraphs(documentXml).paragraphs
    .filter((paragraph) => paragraph.text !== "");
  assert.equal(slots.length, content.length, `${label}: the rebuild would emit a different count`);
  slots.forEach((slot, index) => {
    assert.equal(slot.text, content[index].text, `${label}: paragraph ${index}`);
  });
}

function valueAt(root, path) {
  return path
    .replaceAll("[", ".")
    .replaceAll("]", "")
    .split(".")
    .reduce((node, segment) => node[segment], root);
}

test("an unedited document round-trips byte for byte", () => {
  const result = extract(RENDERED_DOCUMENT);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.unmappable, []);
  assert.deepEqual(result.notices, []);
  // Byte identity, not deep equality: a re-serialized model would republish every line of the
  // committed source as a formatting change nobody asked for.
  assert.equal(result.updatedText, CV_TEXT);
});

test("the plan is the renderer's own paragraph sequence, one slot per paragraph", () => {
  const slots = planCvSlots(JSON.parse(CV_TEXT));
  const { paragraphs, blocks } = readDocumentParagraphs(RENDERED_DOCUMENT);
  assert.deepEqual(blocks, [], "the rendered body holds paragraphs and its section properties only");
  // 20 is the fixture's own paragraph count, frozen here so a plan that silently stops emitting a
  // slot kind — the heading, the stack line, the second role — fails with a count, not a shrug.
  assert.equal(paragraphs.length, 20);
  assert.equal(slots.length, paragraphs.length);
  slots.forEach((slot, index) => {
    assert.equal(slot.text, paragraphs[index].text, `slot ${index} (${formatPath(slot.path)})`);
    assert.equal(slot.bullet, paragraphs[index].bullet, `slot ${index} bullet flag`);
  });
});

test("a wording edit in the document lands as one point edit of cv.json", () => {
  const edited = documentWith([
    "Owned the end-to-end suite for two product surfaces.",
    "Owned the end-to-end suite for three product surfaces.",
  ]);
  const result = extract(edited);
  assert.deepEqual(result.unmappable, []);
  assert.deepEqual(result.changes, [{
    path: "sections[3].roles[0].bullets[0]",
    kind: "bullet",
    before: "Owned the end-to-end suite for two product surfaces.",
    after: "Owned the end-to-end suite for three product surfaces.",
  }]);

  const touched = changedLines(CV_TEXT, result.updatedText);
  assert.equal(touched.length, 1, "exactly one line of the committed source moves");

  const expected = JSON.parse(CV_TEXT);
  expected.sections[3].roles[0].bullets[0] = "Owned the end-to-end suite for three product surfaces.";
  assert.deepEqual(JSON.parse(result.updatedText), expected);

  assertPairConsistent(result.updatedText, edited, "wording edit");
});

test("several edits in one document all land, in any order", () => {
  // Spans are replaced from the end of the file backwards; applied in reading order, the first
  // replacement would shift every later span and the second edit would land in the wrong place.
  // These three are deliberately spread across the file and change the byte length in both
  // directions.
  const edited = documentWith(
    ["Quality engineer with TypeScript depth and a bias for deterministic gates.", "Quality engineer."],
    ["Release gate: ", "Release gate and rollback: "],
    ["Example University, 2010", "Example University, 2011"],
  );
  const result = extract(edited);
  assert.deepEqual(result.unmappable, []);
  assert.deepEqual(result.changes.map((change) => change.path), [
    "sections[0].text",
    "sections[1].bullets[1][0].t",
    "sections[4].lines[0]",
  ]);

  const expected = JSON.parse(CV_TEXT);
  expected.sections[0].text = "Quality engineer.";
  expected.sections[1].bullets[1][0].t = "Release gate and rollback: ";
  expected.sections[4].lines[0] = "BSc Computer Science, Example University, 2011";
  assert.deepEqual(JSON.parse(result.updatedText), expected);
  assert.equal(changedLines(CV_TEXT, result.updatedText).length, 3);
  assertPairConsistent(result.updatedText, edited, "three edits at once");
});

test("the fields the renderer consumes but never prints survive the sync", () => {
  const result = extract(documentWith(["Candidate Name", "Candidate Name Jr"]));
  const updated = JSON.parse(result.updatedText);
  const base = JSON.parse(CV_TEXT);
  assert.equal(updated.header.name, "Candidate Name Jr");
  // The document carries none of these, so a reader that rebuilt a cv.json out of it would drop
  // them all; the extractor edits the source in place instead.
  assert.equal(updated.fileName, base.fileName);
  assert.equal(updated.font, base.font);
  assert.equal(updated.bodySizePt, base.bodySizePt);
  assert.equal(updated.nameSizePt, base.nameSizePt);
  assert.equal(updated.sections[3].roles[1].pageBreakBefore, true);
});

test("every addressable slot kind inverts onto its own source field", () => {
  const cases = [
    {
      label: "header contact",
      from: "UTC+2 | ",
      to: "UTC+6 | ",
      path: "header.contact",
      kind: "header",
    },
    {
      label: "header positioning",
      from: "independent contractor.",
      to: "independent contractor available across European hours.",
      path: "header.positioning",
      kind: "header",
    },
    {
      label: "summary",
      from: "a bias for deterministic gates.",
      to: "a bias for deterministic gates and short feedback loops.",
      path: "sections[0].text",
      kind: "summary",
    },
    {
      label: "plain bullet",
      from: "from 6% to 0.4% failures",
      to: "from 6% to 0.2% failures",
      path: "sections[1].bullets[0]",
      kind: "bullet",
    },
    {
      label: "bold run atom of a rich bullet",
      from: "Release gate: ",
      to: "Release gating: ",
      path: "sections[1].bullets[1][0].t",
      kind: "bullet",
    },
    {
      label: "plain run atom of a rich bullet",
      from: "made the pipeline refuse an unproven build",
      to: "made the pipeline reject an unproven build",
      path: "sections[1].bullets[1][1].t",
      kind: "bullet",
    },
    {
      label: "skills label",
      from: "Test Automation: ",
      to: "Test automation: ",
      path: "sections[2].skills[0].label",
      kind: "skill",
    },
    {
      label: "skills body",
      from: "TypeScript, Playwright, pytest, Selenium",
      to: "TypeScript, Playwright, pytest",
      path: "sections[2].skills[0].body",
      kind: "skill",
    },
    {
      label: "role company",
      from: "Second Example - QA Engineer",
      to: "Third Example - QA Engineer",
      path: "sections[3].roles[1].company",
      kind: "role",
    },
    {
      label: "role title",
      from: "Example Labs - Senior QA Automation Engineer - 2020",
      to: "Example Labs - Principal QA Automation Engineer - 2020",
      path: "sections[3].roles[0].title",
      kind: "role",
    },
    {
      // The hard case: real dates contain the same ` - ` the heading joins on, so a separator split
      // would find four parts in an unedited heading and never recover this field.
      label: "role dates",
      from: "QA Engineer - 2016 - 2020",
      to: "QA Engineer - 2016 - 2019",
      path: "sections[3].roles[1].dates",
      kind: "role",
    },
    {
      label: "role stack line",
      from: "TypeScript, Playwright, GitHub Actions",
      to: "TypeScript, Playwright, GitLab CI",
      path: "sections[3].roles[0].stack",
      kind: "stack",
    },
    {
      label: "education line",
      from: "Example University, 2010",
      to: "Example University, 2011",
      path: "sections[4].lines[0]",
      kind: "line",
    },
  ];

  for (const testCase of cases) {
    const edited = documentWith([testCase.from, testCase.to]);
    const result = extract(edited);
    assert.deepEqual(result.unmappable, [], `${testCase.label} produced findings`);
    assert.equal(result.changes.length, 1, `${testCase.label} produced ${result.changes.length} changes`);
    assert.equal(result.changes[0].path, testCase.path, testCase.label);
    assert.equal(result.changes[0].kind, testCase.kind, testCase.label);
    assert.equal(
      valueAt(JSON.parse(result.updatedText), testCase.path),
      result.changes[0].after,
      testCase.label,
    );
    assert.equal(changedLines(CV_TEXT, result.updatedText).length, 1, testCase.label);
    assertPairConsistent(result.updatedText, edited, testCase.label);
  }
});

test("editor churn that changes no character is not an edit", () => {
  // A word processor splits runs at spell-check, language and edit-session boundaries, and litters
  // paragraphs with bookmarks and proofing marks. Reporting any of that as a change would make the
  // channel unusable for the one thing it exists for.
  const splitRun = extract(documentWith([
    '<w:t xml:space="preserve">Candidate Name</w:t></w:r>',
    '<w:t xml:space="preserve">Candidate </w:t></w:r>'
      + '<w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">Name</w:t></w:r>',
  ]));
  assert.deepEqual(splitRun.changes, []);
  assert.deepEqual(splitRun.unmappable, []);
  assert.deepEqual(splitRun.notices, [], "a split run is not even worth a notice");
  assert.equal(splitRun.updatedText, CV_TEXT);

  const annotated = extract(documentWith([
    "<w:p><w:pPr><w:spacing w:after=\"40\"/></w:pPr>" + bodyRun("BSc Computer Science, Example University, 2010"),
    "<w:p><w:pPr><w:spacing w:after=\"40\"/></w:pPr>"
      + '<w:bookmarkStart w:id="1" w:name="edit"/><w:proofErr w:type="spellStart"/>'
      + '<w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="2"/>'
      + bodyRun("BSc Computer Science, Example University, 2010"),
  ]));
  assert.deepEqual(annotated.changes, []);
  assert.deepEqual(annotated.unmappable, []);
  assert.deepEqual(annotated.notices, []);
});

test("a role heading with plain dates is still anchored on the source's own fields", () => {
  // The fixture's two roles both carry a ` - ` inside their dates, which is what makes a separator
  // split impossible there. A role whose dates hold no separator splits into exactly three parts,
  // and that is where a naive splitter looks correct: it maps a single-field edit the same way, and
  // then silently invents a mapping for an edit that moved two fields at once.
  const cv = JSON.stringify(
    {
      fileName: "Plain_Dates.docx",
      sections: [
        {
          type: "experience",
          heading: "Experience",
          roles: [{ company: "Acme", title: "QA Engineer", dates: "2016" }],
        },
      ],
    },
    null,
    2,
  );
  const document = (heading) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">EXPERIENCE</w:t></w:r></w:p>'
    + `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${heading}</w:t></w:r></w:p>`
    + "<w:sectPr/></w:body></w:document>";

  const oneField = extractCvEdits(packageOf(document("Acme - Senior QA Engineer - 2016")), cv);
  assert.deepEqual(oneField.unmappable, []);
  assert.deepEqual(oneField.changes.map((change) => [change.path, change.after]), [
    ["sections[0].roles[0].title", "Senior QA Engineer"],
  ]);

  const twoFields = extractCvEdits(packageOf(document("Acme Labs - Senior QA Engineer - 2016")), cv);
  assert.deepEqual(twoFields.changes, [], "two moved fields have no unique inverse");
  assert.deepEqual(twoFields.unmappable.map((finding) => finding.code), ["role_heading_unparsable"]);
  assert.equal(twoFields.updatedText, cv);
});

test("a skills line with a third run drops nothing silently", () => {
  // Bolding a word inside the body while editing it leaves three runs. Reading the body from the
  // second run alone would publish a CV missing everything after it, so the shape is the check:
  // two runs, or nothing is taken from the line at all.
  const result = extract(documentWith([
    '<w:t xml:space="preserve">TypeScript, Playwright, pytest, Selenium</w:t></w:r>',
    '<w:t xml:space="preserve">TypeScript, </w:t></w:r>'
      + '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Playwright</w:t></w:r>'
      + bodyRun(", pytest and Selenium"),
  ]));
  assert.deepEqual(result.changes, []);
  assert.equal(result.updatedText, CV_TEXT);
  assert.deepEqual(result.unmappable.map((finding) => [finding.code, finding.location]), [
    ["skill_line_unparsable", "sections[2].skills[0]"],
  ]);
});

test("a skills line whose separator was edited away has no label to split on", () => {
  // Two runs, correct bold, and no `: ` left. Taking the label from `slice(0, -2)` anyway would
  // move two characters of the user's own text between two brief-owned fields and call it an edit.
  const result = extract(documentWith([
    '<w:t xml:space="preserve">Delivery: </w:t>',
    '<w:t xml:space="preserve">Delivery - </w:t>',
  ]));
  assert.deepEqual(result.changes, []);
  assert.equal(result.updatedText, CV_TEXT);
  assert.deepEqual(result.unmappable.map((finding) => [finding.code, finding.location]), [
    ["skill_line_unparsable", "sections[2].skills[1]"],
  ]);
});

test("run atoms that render as one run have no unique home to edit", () => {
  // Two adjacent atoms with identical formatting render as one run, so the document cannot say
  // which of them an edit belongs to. Writing it into the first would duplicate the second's text
  // in the published CV.
  const cv = JSON.stringify(
    {
      fileName: "Merged_Atoms.docx",
      sections: [
        {
          type: "bullets",
          heading: "Selected Impact",
          bullets: [[{ t: "first half " }, { t: "second half." }]],
        },
      ],
    },
    null,
    2,
  );
  const document = (bullet) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">SELECTED IMPACT</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>'
    + `${bodyRun(bullet)}</w:p>`
    + "<w:sectPr/></w:body></w:document>";

  const untouched = extractCvEdits(packageOf(document("first half second half.")), cv);
  assert.deepEqual(untouched.changes, []);
  assert.deepEqual(untouched.unmappable, []);
  assert.equal(untouched.updatedText, cv);

  const edited = extractCvEdits(packageOf(document("first half EDITED second half.")), cv);
  assert.deepEqual(edited.changes, []);
  assert.equal(edited.updatedText, cv, "nothing is written where nothing can be addressed");
  assert.deepEqual(edited.unmappable.map((finding) => finding.code), ["run_atoms_not_addressable"]);
});

test("a bullet that lost its list formatting is never accepted in silence", () => {
  // The list flag is formatting the source cannot hold: a bullets entry always renders as a bullet.
  // Matching on text alone would let a de-bulleted paragraph look untouched and publish silently.
  const bulletProperties = '<w:pPr><w:pStyle w:val="ListParagraph"/><w:keepLines/>'
    + '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:after="30"/></w:pPr>'
    + '<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:cs="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri"/>'
    + '<w:b w:val="false"/><w:bCs w:val="false"/><w:i w:val="false"/><w:iCs w:val="false"/>'
    + '<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>'
    + '<w:t xml:space="preserve">Cut a flaky suite from 6% to 0.4% failures without deleting a single check.</w:t></w:r>';

  const textUnchanged = extract(documentWith([
    bulletProperties,
    '<w:pPr><w:spacing w:after="30"/></w:pPr>'
      + bodyRun("Cut a flaky suite from 6% to 0.4% failures without deleting a single check."),
  ]));
  assert.deepEqual(textUnchanged.changes, []);
  assert.deepEqual(textUnchanged.unmappable, []);
  assert.deepEqual(textUnchanged.notices.map((notice) => [notice.code, notice.location]), [
    ["formatting_not_synced", "sections[1].bullets[0]"],
  ]);
  assert.match(textUnchanged.notices[0].detail, /list item/);

  const textChangedToo = extract(documentWith([
    bulletProperties,
    '<w:pPr><w:spacing w:after="30"/></w:pPr>'
      + bodyRun("Cut a flaky suite from 6% to 0.2% failures without deleting a single check."),
  ]));
  assert.deepEqual(textChangedToo.changes, []);
  assert.equal(textChangedToo.updatedText, CV_TEXT);
  assert.deepEqual(textChangedToo.unmappable.map((finding) => [finding.code, finding.location]), [
    ["paragraph_kind_changed", "sections[1].bullets[0]"],
  ]);
});

test("an empty run between two others is not a formatting change", () => {
  // Editors leave zero-length runs behind constantly; keeping them would make the atom structure
  // differ from the source on a paragraph nobody touched.
  const result = extract(documentWith([
    '<w:t xml:space="preserve">BSc Computer Science, Example University, 2010</w:t></w:r>',
    '<w:t xml:space="preserve">BSc Computer Science, </w:t></w:r>'
      + '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"></w:t></w:r>'
      + bodyRun("Example University, 2010"),
  ]));
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.unmappable, []);
  assert.deepEqual(result.notices, []);
});

test("a document body past the paragraph bound is refused, not aligned", () => {
  // The bound is the untrusted-input promise in the module header; without it the alignment table
  // is quadratic in whatever the document declares.
  const paragraph = `<w:p>${bodyRun("filler")}</w:p>`;
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + paragraph.repeat(4097)
    + "</w:body></w:document>";
  assert.throws(
    () => extract(document),
    (error) => error instanceof DocxExtractionError && error.code === "docx_document_too_large",
  );
});

test("a role heading edit that reads two ways is refused, not resolved by order", () => {
  // `Senior QA Automation Engineer - Team Lead` is equally an edit of the title and an edit of the
  // dates, because the user put the separator inside a field. Returning the first attempt that fits
  // writes their text into a field they never touched, and the rebuild then looks identical.
  const title = extract(documentWith([
    "Example Labs - Senior QA Automation Engineer - 2020 - Present",
    "Example Labs - Senior QA Automation Engineer - Team Lead - 2020 - Present",
  ]));
  assert.deepEqual(title.changes, []);
  assert.equal(title.updatedText, CV_TEXT);
  assert.deepEqual(title.unmappable.map((finding) => [finding.code, finding.location]), [
    ["role_heading_unparsable", "sections[3].roles[0]"],
  ]);
  assert.match(title.unmappable[0].detail, /reads as an edit of (title or of dates|dates or of title)/);

  const company = extract(documentWith([
    "Second Example - QA Engineer - 2016 - 2020",
    "Second Example - EU - QA Engineer - 2016 - 2020",
  ]));
  assert.deepEqual(company.changes, []);
  assert.deepEqual(company.unmappable.map((finding) => finding.code), ["role_heading_unparsable"]);
});

test("a bold boundary that moved is an edit the source can hold", () => {
  // Same flag sequence, different split point, identical paragraph text. Comparing only the shape
  // would call this unchanged and drop it; the atoms are addressable, so both halves are synced.
  const edited = documentWith([
    '<w:t xml:space="preserve">Release gate: </w:t></w:r>',
    '<w:t xml:space="preserve">Release gate: made</w:t></w:r>',
  ]).replace(
    '<w:t xml:space="preserve">made the pipeline refuse an unproven build instead of warning about it.</w:t>',
    '<w:t xml:space="preserve"> the pipeline refuse an unproven build instead of warning about it.</w:t>',
  );
  const result = extract(edited);
  assert.deepEqual(result.unmappable, []);
  assert.deepEqual(result.notices, []);
  assert.deepEqual(result.changes.map((change) => [change.path, change.after]), [
    ["sections[1].bullets[1][0].t", "Release gate: made"],
    ["sections[1].bullets[1][1].t", " the pipeline refuse an unproven build instead of warning about it."],
  ]);
  assertPairConsistent(result.updatedText, edited, "bold boundary");
});

test("a boundary the source cannot hold is reported even when the text stands still", () => {
  // The skills line renders as a bold `Label: ` and a plain body; moving text across that boundary
  // has no home in the source, and the rebuild will put it back. Silence would be the one wrong
  // answer.
  const result = extract(documentWith([
    '<w:t xml:space="preserve">Test Automation: </w:t></w:r>',
    '<w:t xml:space="preserve">Test Automation: TypeScript, </w:t></w:r>',
  ]).replace(
    '<w:t xml:space="preserve">TypeScript, Playwright, pytest, Selenium</w:t>',
    '<w:t xml:space="preserve">Playwright, pytest, Selenium</w:t>',
  ));
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.unmappable, []);
  assert.equal(result.updatedText, CV_TEXT);
  assert.deepEqual(result.notices.map((notice) => [notice.code, notice.location]), [
    ["formatting_not_synced", "sections[2].skills[0]"],
  ]);
});

test("a numeric character reference is text, not the characters that spell it", () => {
  // The shared inspector's XML check accepts `&#233;`, so a decoder that did not understand it
  // would carry `&#233;` into cv.json as six literal characters and publish it that way.
  const result = extract(documentWith([
    '<w:t xml:space="preserve">BSc Computer Science, Example University, 2010</w:t>',
    '<w:t xml:space="preserve">BSc Computer Science, Ren&#233; University, 2010</w:t>',
  ]));
  assert.deepEqual(result.unmappable, []);
  assert.deepEqual(result.changes.map((change) => change.after), [
    "BSc Computer Science, René University, 2010",
  ]);
  assert.equal(JSON.parse(result.updatedText).sections[4].lines[0], "BSc Computer Science, René University, 2010");
});

test("an empty value renders as an empty paragraph and round-trips as one", () => {
  // `render.js` emits a paragraph for an empty line or an empty bullet. Treating every empty
  // paragraph as an editor's leftover orphaned that slot and blocked a legitimate publication.
  const cv = JSON.stringify(
    {
      fileName: "Empty_Values.docx",
      sections: [
        { type: "lines", heading: "Education", lines: ["", "BSc Computer Science, 2010"] },
      ],
    },
    null,
    2,
  );
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">EDUCATION</w:t></w:r></w:p>'
    + `<w:p><w:r>${BODY_RUN_PROPERTIES}<w:t xml:space="preserve"></w:t></w:r></w:p>`
    + `<w:p>${bodyRun("BSc Computer Science, 2010")}</w:p>`
    + "<w:sectPr/></w:body></w:document>";

  const result = extractCvEdits(packageOf(document), cv);
  assert.deepEqual(result.unmappable, [], "an empty source value is not a dropped paragraph");
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.notices, []);
  assert.equal(result.updatedText, cv);
});

test("an unterminated XML construct is refused rather than scanned forever", () => {
  // `indexOf` returns -1 for a missing closer, and -1 plus the closer's length walks the cursor
  // backwards. The exported reader takes whatever it is handed, so it has to say no.
  //
  // In a child process on purpose: the failure this guards against is a synchronous loop, which no
  // in-process assertion can interrupt — the suite would hang instead of going red. Here the mutant
  // is killed by the timeout and the case fails in seconds.
  for (const unterminated of ["<!-- never closed", "<![CDATA[ never closed", "<?never closed"]) {
    const document = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + `<w:body><w:p>${unterminated}</w:body></w:document>`;
    const script = `import(${JSON.stringify(pathToFileURL(extractorPath).href)}).then((module) => {
      try {
        module.readDocumentParagraphs(${JSON.stringify(document)});
        process.stdout.write("no-error");
      } catch (error) {
        process.stdout.write(String(error.code));
      }
    });`;
    const observed = execFileSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(observed, "docx_document_unreadable", unterminated);
  }
});

test("text is the character data of its run, not the bytes between the tags", () => {
  // A CDATA section, a processing instruction and a nested element are all legal XML inside `<w:t>`
  // that the shared inspector accepts. Copying the raw slice would carry `<![CDATA[` and everything
  // after it into cv.json as literal characters, and the round trip would not notice.
  const smuggled = extract(documentWith([
    '<w:t xml:space="preserve">BSc Computer Science, Example University, 2010</w:t>',
    '<w:t xml:space="preserve">BSc <![CDATA[Computer]]> Science, <?ignore me?>Example University, 2011</w:t>',
  ]));
  assert.deepEqual(smuggled.unmappable, []);
  assert.deepEqual(smuggled.changes.map((change) => change.after), [
    "BSc Computer Science, Example University, 2011",
  ]);

  const nested = extract(documentWith([
    '<w:t xml:space="preserve">BSc Computer Science, Example University, 2010</w:t>',
    '<w:t xml:space="preserve">BSc Computer Science, <w:noBreakHyphen/>Example University, 2010</w:t>',
  ]));
  assert.deepEqual(nested.changes, []);
  assert.deepEqual(nested.unmappable.map((finding) => finding.code), ["unsupported_run_content"]);
});

test("characters a reader cannot see are not carried into the published source", () => {
  // The user approves this edit from a diff in chat. A non-breaking space reads as a space, a
  // bidirectional override reorders everything after it, and neither is what they typed.
  for (const [label, injected] of [
    ["non-breaking space", "Owned the\u00a0end-to-end suite for three product surfaces."],
    ["bidi override", "Owned the end-to-end suite for three product surfaces.\u202e"],
    ["zero-width space", "Owned the\u200bend-to-end suite for three product surfaces."],
  ]) {
    const result = extract(documentWith([
      "Owned the end-to-end suite for two product surfaces.",
      injected,
    ]));
    assert.deepEqual(result.changes, [], label);
    assert.equal(result.updatedText, CV_TEXT, label);
    assert.deepEqual(result.unmappable.map((finding) => [finding.code, finding.location]), [
      ["unsupported_characters", "sections[3].roles[0].bullets[0]"],
    ], label);
  }

  // The same character already in the committed source is the agent's own text, not this edit's
  // doing: an unrelated edit of that paragraph is still carried.
  const cv = JSON.stringify(
    { fileName: "Nbsp.docx", sections: [{ type: "summary", heading: "Summary", text: "Ten\u00a0years of it." }] },
    null,
    2,
  );
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">SUMMARY</w:t></w:r></w:p>'
    + `<w:p>${bodyRun("Eleven\u00a0years of it.")}</w:p><w:sectPr/></w:body></w:document>`;
  const carried = extractCvEdits(packageOf(document), cv);
  assert.deepEqual(carried.unmappable, []);
  assert.deepEqual(carried.changes.map((change) => change.after), ["Eleven\u00a0years of it."]);
});

test("a rebound namespace prefix is not read as the vocabulary its names spell", () => {
  // Element names are compared as strings, so anything that rebinds the prefix they resolve through
  // hands this reader text a renderer would never show. The guard has to cover the whole paragraph:
  // on the run, on its properties, and on `w:t` itself, which is the one that produces a change.
  for (const [label, replacement] of [
    ["on the run", [
      '<w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r>',
      '<w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r xmlns:w="urn:not-wordprocessing">',
    ]],
    ["on the run properties", [
      '<w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r><w:rPr>',
      '<w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r><w:rPr xmlns:w="urn:not-wordprocessing">',
    ]],
    ["on the text element", [
      '<w:t xml:space="preserve">BSc Computer Science, Example University, 2010</w:t>',
      '<w:t xmlns:w="urn:not-wordprocessing" xml:space="preserve">TEXT WORD NEVER SHOWS</w:t>',
    ]],
  ]) {
    const result = extract(documentWith(replacement));
    assert.deepEqual(result.changes, [], label);
    assert.equal(result.updatedText, CV_TEXT, label);
    assert.deepEqual(
      result.unmappable.map((finding) => finding.code),
      ["unsupported_paragraph_content"],
      label,
    );
  }

  // A body that rebinds it resolves nothing below itself, so there is no paragraph to report.
  assert.throws(
    () => extract(documentWith(["<w:body>", '<w:body xmlns:w="urn:not-wordprocessing">'])),
    (error) => error instanceof DocxExtractionError && error.code === "docx_document_unreadable",
  );

  // A foreign namespace changes nothing about what `w:t` means and is left alone.
  const foreign = extract(documentWith([
    '<w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r>',
    '<w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r xmlns:a="urn:drawing">',
  ]));
  assert.deepEqual(foreign.changes, []);
  assert.deepEqual(foreign.unmappable, []);
  assert.deepEqual(foreign.notices, []);
});

test("the namespace check reads declarations, not text that spells one", () => {
  // Read from the paragraph's source rather than from its element tags, the check fires on a CV
  // that merely writes about XML — and one finding stops the whole sync. Fail-closed, but wrong.
  const aboutXml = extract(documentWith([
    "BSc Computer Science, Example University, 2010",
    "Wrote xmlns:w= parsers at Example University, 2011",
  ]));
  assert.deepEqual(aboutXml.unmappable, []);
  assert.deepEqual(aboutXml.changes.map((change) => change.after), [
    "Wrote xmlns:w= parsers at Example University, 2011",
  ]);

  // Redeclaring the same URI binds the same vocabulary: producers emit it, and it rebinds nothing.
  const sameUri = extract(documentWith([
    '<w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r>',
    '<w:p><w:pPr><w:spacing w:after="40"/></w:pPr>'
      + '<w:r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
  ]));
  assert.deepEqual(sameUri.changes, []);
  assert.deepEqual(sameUri.unmappable, []);
  assert.deepEqual(sameUri.notices, []);
});

test("attributes are parsed, so quoting cannot hide a declaration or invent one", () => {
  // Single quotes are legal XML and the shared inspector accepts them. Searching the tag text for a
  // double-quoted value misses every single-quoted declaration — the namespace guard never fires —
  // and finds `w:val="0"` inside a neighbouring attribute's own value, where Word sees nothing.
  const singleQuoted = extract(documentWith([
    '<w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r>',
    "<w:p><w:pPr><w:spacing w:after=\"40\"/></w:pPr><w:r xmlns:w='urn:not-wordprocessing'>",
  ]));
  assert.deepEqual(singleQuoted.changes, []);
  assert.deepEqual(
    singleQuoted.unmappable.map((finding) => finding.code),
    ["unsupported_paragraph_content"],
  );

  // A bold run whose neighbouring attribute spells an off-toggle, space and all.
  const smuggledToggle = extract(documentWith([
    '<w:b/><w:bCs/><w:sz w:val="32"/>',
    "<w:b w:rsidR=' w:val=\"0\"'/><w:bCs/><w:sz w:val=\"32\"/>",
  ]));
  assert.deepEqual(smuggledToggle.changes, []);
  assert.deepEqual(smuggledToggle.unmappable, []);
  assert.deepEqual(smuggledToggle.notices, [], "the run is still bold");

  // And a single-quoted toggle is still a toggle.
  const singleQuotedToggle = extract(documentWith([
    '<w:b/><w:bCs/><w:sz w:val="32"/>',
    "<w:b w:val='false'/><w:bCs/><w:sz w:val=\"32\"/>",
  ]));
  assert.deepEqual(singleQuotedToggle.changes, []);
  assert.deepEqual(
    singleQuotedToggle.notices.map((notice) => notice.code),
    ["formatting_not_synced"],
    "an explicit off-toggle makes the run plain, whichever quotes it uses",
  );
});

test("a paragraph cannot nest its way into a quadratic parse", () => {
  // Reading a paragraph rescans what lies below each level. 12000 nested elements is a 1.5 KB
  // package that took six seconds; the inspector's own limits allow three orders of magnitude more,
  // and this input is read before any gate has looked at it.
  const nested = (depth) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + `<w:p><w:pPr/>${"<w:x>".repeat(depth)}q${"</w:x>".repeat(depth)}</w:p>`
    + "<w:sectPr/></w:body></w:document>";
  const refused = (() => {
    try {
      extract(nested(2100));
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.ok(refused instanceof DocxExtractionError);
  assert.equal(refused.code, "docx_document_too_large");
  // The refusal names the paragraph, like every other per-paragraph report.
  assert.match(refused.message, /document paragraph 0 holds 4201 tags/);

  // The bound is generous on purpose: the input is a document a word processor has been editing,
  // and Word carries eight or more property tags on every run it splits. A paragraph with far more
  // tags than this renderer emits is still read.
  const accepted = extract(nested(200));
  assert.equal(accepted.unmappable.some((finding) => finding.code === "unsupported_run_content"
    || finding.code === "paragraph_added" || finding.code === "unmatched_region"), true);
});

test("the invisible-character gate is Unicode's own classes, not a remembered list", () => {
  // Each of these is invisible or reorders what follows, and each was missed by a gate written as
  // hand-picked ranges. The user approves the edit from a diff that does not show them.
  for (const [label, character] of [
    ["word joiner", "\u2060"],
    ["arabic letter mark", "\u061c"],
    ["mongolian vowel separator", "\u180e"],
    ["line separator", "\u2028"],
    ["ideographic space", "\u3000"],
    ["object replacement", "\ufffc"],
    ["replacement character", "\ufffd"],
    ["zero-width space", "\u200b"],
    ["soft hyphen", "\u00ad"],
    ["right-to-left override", "\u202e"],
    ["private use", "\ue000"],
  ]) {
    const result = extract(documentWith([
      "Owned the end-to-end suite for two product surfaces.",
      `Owned the${character}end-to-end suite for three product surfaces.`,
    ]));
    assert.deepEqual(result.changes, [], label);
    assert.equal(result.updatedText, CV_TEXT, label);
    assert.deepEqual(
      result.unmappable.map((finding) => finding.code),
      ["unsupported_characters"],
      label,
    );
  }
});

test("the report stays a report: bounded fields, bounded lists, bounded blocks", () => {
  // The report is read into an agent's context. A 5 KB document of empty tables produced tens of
  // megabytes of findings — inside every package limit the shared inspector enforces.
  const tables = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + "<w:tbl/>".repeat(300)
    + "</w:body></w:document>";
  assert.throws(
    () => extract(tables),
    (error) => error instanceof DocxExtractionError && error.code === "docx_document_too_large",
  );

  // Under that bound the list itself is still capped, with the overflow counted rather than dropped
  // in silence.
  const manyBlocks = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + "<w:tbl/>".repeat(200)
    + "</w:body></w:document>";
  const capped = extract(manyBlocks);
  // 200 tables plus the one region that reports every slot of the CV as dropped: 201 findings, of
  // which 100 are listed and the rest counted.
  assert.equal(capped.unmappable.length, 101);
  assert.equal(capped.unmappable.at(-1).code, "report_truncated");
  assert.equal(capped.unmappable.at(-1).detail, "101 further unmappable edits are not listed");

  // One long value is bounded too, and says so.
  const long = "x".repeat(5000);
  const longEdit = extract(documentWith([
    "Owned the end-to-end suite for two product surfaces.",
    long,
  ]));
  assert.equal(longEdit.changes.length, 1);
  assert.equal(longEdit.changes[0].after.length, 1022);
  assert.match(longEdit.changes[0].after, /\.\.\. \(\+4000 characters\)$/);
  // The report is bounded; the write is not truncated with it.
  assert.equal(JSON.parse(longEdit.updatedText).sections[3].roles[0].bullets[0], long);
});

test("a toggle is read from its own attribute, not from another attribute's text", () => {
  // `<w:b mc:Ignorable='w:val="0"'/>` is a bold run whose neighbouring attribute happens to spell an
  // off-toggle. Searching the whole tag for `w:val="0"` read it as not bold, and the paragraph then
  // differed from a source nobody had edited.
  const result = extract(documentWith([
    '<w:b/><w:bCs/><w:sz w:val="32"/>',
    '<w:b mc:Ignorable=\'w:val="0"\'/><w:bCs/><w:sz w:val="32"/>',
  ]));
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.unmappable, []);
  assert.deepEqual(result.notices, [], "the run is still bold");
});

test("a document part that is not well-formed XML never reaches the mapping", () => {
  // The reverse sync is the second consumer of the shared inspector's well-formedness contract, and
  // the only one that reads the body element by element afterwards.
  assert.throws(
    () => extract('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/'
      + 'wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>unclosed</w:body></w:document>'),
    (error) => error instanceof DocxInspectionError && error.code === "docx_package_invalid",
  );
});

test("an uppercased heading is reported rather than written back in the renderer's own casing", () => {
  const result = extract(documentWith([">SKILLS<", ">TOOLING<"]));
  assert.deepEqual(result.changes, []);
  assert.equal(result.updatedText, CV_TEXT);
  assert.deepEqual(result.unmappable.map((finding) => [finding.code, finding.location]), [
    ["heading_case_not_invertible", "sections[2].heading"],
  ]);
});

test("a role heading edit that moves two fields at once is reported, not guessed", () => {
  const result = extract(documentWith([
    "Second Example - QA Engineer - 2016 - 2020",
    "Second Example - Senior QA Engineer - 2016 - 2019",
  ]));
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.unmappable.map((finding) => [finding.code, finding.location]), [
    ["role_heading_unparsable", "sections[3].roles[1]"],
  ]);
});

test("a skills line whose two runs were merged has no label to split on", () => {
  const result = extract(documentWith([
    '<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:cs="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri"/>'
      + '<w:b/><w:bCs/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>'
      + '<w:t xml:space="preserve">Delivery: </w:t></w:r>'
      + bodyRun("CI/CD gates, trunk-based development, release readiness"),
    bodyRun("Delivery - CI/CD gates, trunk-based development, release readiness"),
  ]));
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.unmappable.map((finding) => [finding.code, finding.location]), [
    ["skill_line_unparsable", "sections[2].skills[1]"],
  ]);
});

test("a paragraph added or removed is located between the anchors that did not move", () => {
  const bulletParagraph = RENDERED_DOCUMENT
    .match(/<w:p><w:pPr><w:pStyle w:val="ListParagraph"\/>[\s\S]*?<\/w:p>/)[0];
  assert.ok(bulletParagraph.includes("Cut a flaky suite"), "the first bullet is the fixture's first list paragraph");

  const removed = extract(RENDERED_DOCUMENT.replace(bulletParagraph, ""));
  assert.deepEqual(removed.changes, []);
  assert.equal(removed.updatedText, CV_TEXT);
  assert.equal(removed.unmappable.length, 1);
  assert.equal(removed.unmappable[0].code, "paragraph_removed");
  assert.equal(removed.unmappable[0].location, "after sections[1].heading, before sections[1].bullets[1]");
  assert.match(removed.unmappable[0].detail, /sections\[1\]\.bullets\[0\]/);

  const added = extract(
    RENDERED_DOCUMENT.replace(
      bulletParagraph,
      bulletParagraph + bulletParagraph.replace(
        "Cut a flaky suite from 6% to 0.4% failures without deleting a single check.",
        "A bullet the user typed straight into the document.",
      ),
    ),
  );
  assert.deepEqual(added.changes, []);
  assert.equal(added.unmappable.length, 1);
  assert.equal(added.unmappable[0].code, "paragraph_added");
  assert.equal(added.unmappable[0].location, "after sections[1].bullets[0], before sections[1].bullets[1]");
  assert.match(added.unmappable[0].detail, /A bullet the user typed straight into the document\./);
});

test("a region whose two sides both changed size names both sides", () => {
  const lastBullet = "<w:p><w:pPr><w:pStyle w:val=\"ListParagraph\"/><w:keepLines/>"
    + "<w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"1\"/></w:numPr><w:spacing w:after=\"30\"/></w:pPr>"
    + "<w:r><w:rPr><w:rFonts w:ascii=\"Calibri\" w:cs=\"Calibri\" w:eastAsia=\"Calibri\" w:hAnsi=\"Calibri\"/>"
    + "<w:b w:val=\"false\"/><w:bCs w:val=\"false\"/><w:i w:val=\"false\"/><w:iCs w:val=\"false\"/>"
    + "<w:sz w:val=\"21\"/><w:szCs w:val=\"21\"/></w:rPr>"
    + "<w:t xml:space=\"preserve\">Built the first automated regression pass the team trusted.</w:t></w:r></w:p>";
  const rewritten = lastBullet
    .replace("Built the first automated regression pass the team trusted.", "One rewritten bullet.")
    + lastBullet.replace("Built the first automated regression pass the team trusted.", "And a second one.");
  const result = extract(documentWith([lastBullet, rewritten]));
  assert.deepEqual(result.changes, []);
  assert.equal(result.unmappable.length, 1);
  assert.equal(result.unmappable[0].code, "unmatched_region");
  assert.match(result.unmappable[0].detail, /1 source paragraph\(s\)/);
  assert.match(result.unmappable[0].detail, /2 document paragraph\(s\)/);
  assert.match(result.unmappable[0].detail, /"One rewritten bullet\."/);
});

test("punctuation the renderer refuses is reported at its own location, not carried over", () => {
  const result = extract(documentWith([
    "without deleting a single check.",
    "without deleting a single “check”.",
  ]));
  assert.deepEqual(result.changes, []);
  assert.equal(result.updatedText, CV_TEXT);
  assert.deepEqual(result.unmappable.map((finding) => [finding.code, finding.location]), [
    ["punctuation_forbidden", "sections[1].bullets[0]"],
  ]);
  assert.match(result.unmappable[0].detail, /rule 21/);
});

test("the punctuation gate is the renderer's own list, character for character", () => {
  // Duplication is unavoidable: `render.js` is CommonJS and requires `docx`, which this
  // dependency-free tool cannot import. A silent divergence would hand the user a diff for an edit
  // the build then refuses, so the two lists are compared as source text.
  const renderer = readFileSync(join(repoRoot, "tools", "cv-builder", "render.js"), "utf8");
  const block = renderer.match(/const FORBIDDEN = \[([\s\S]*?)\n\];/);
  assert.ok(block, "render.js no longer declares a FORBIDDEN list this pin can read");
  const rendererPatterns = [...block[1].matchAll(/\{ re: (\/(?:[^/\\]|\\.)+\/),\s*name:/g)]
    .map((entry) => entry[1]);
  assert.equal(rendererPatterns.length, 7);
  assert.deepEqual(
    FORBIDDEN_PUNCTUATION.map((forbidden) => forbidden.re.toString()),
    rendererPatterns,
  );
});

test("formatting the source could hold is reported, never inferred", () => {
  // Text unchanged, formatting changed: the rebuild will drop the user's bold, so it is named.
  const notice = extract(documentWith([
    '<w:t xml:space="preserve">Owned the end-to-end suite for two product surfaces.</w:t></w:r>',
    '<w:t xml:space="preserve">Owned the </w:t></w:r>'
      + '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">end-to-end</w:t></w:r>'
      + bodyRun(" suite for two product surfaces."),
  ]));
  assert.deepEqual(notice.changes, []);
  assert.deepEqual(notice.unmappable, []);
  assert.deepEqual(notice.notices.map((entry) => [entry.code, entry.location]), [
    ["formatting_not_synced", "sections[3].roles[0].bullets[0]"],
  ]);

  // Text and formatting changed together: the run structure no longer addresses the source's atoms,
  // so there is no faithful place to put the new text.
  const finding = extract(documentWith([
    '<w:t xml:space="preserve">Owned the end-to-end suite for two product surfaces.</w:t></w:r>',
    '<w:t xml:space="preserve">Owned the </w:t></w:r>'
      + '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">end-to-end</w:t></w:r>'
      + bodyRun(" suite for three product surfaces."),
  ]));
  assert.deepEqual(finding.changes, []);
  assert.deepEqual(finding.unmappable.map((entry) => [entry.code, entry.location]), [
    ["run_formatting_changed", "sections[3].roles[0].bullets[0]"],
  ]);
});

test("content the model cannot carry is reported once, with its position", () => {
  const lineBreak = extract(documentWith([
    '<w:t xml:space="preserve">BSc Computer Science, Example University, 2010</w:t>',
    '<w:t xml:space="preserve">BSc Computer Science,</w:t><w:br/>'
      + '<w:t xml:space="preserve"> Example University, 2010</w:t>',
  ]));
  assert.deepEqual(lineBreak.changes, []);
  assert.deepEqual(lineBreak.unmappable.map((entry) => [entry.code, entry.location]), [
    ["unsupported_run_content", "document paragraph 19"],
  ]);

  const table = extract(documentWith([
    "<w:sectPr>",
    "<w:tbl><w:tr><w:tc><w:p>" + bodyRun("cell") + "</w:p></w:tc></w:tr></w:tbl><w:sectPr>",
  ]));
  assert.deepEqual(table.changes, []);
  assert.deepEqual(table.unmappable.map((entry) => [entry.code, entry.location]), [
    ["unsupported_block", "document body, after paragraph 20"],
  ]);
});

test("tracked changes are one finding, not a second one about the text they hide", () => {
  const result = extract(documentWith([
    bodyRun("BSc Computer Science, Example University, 2010"),
    '<w:ins w:id="9" w:author="reviewer">'
      + bodyRun("BSc Computer Science, Example University, 2011")
      + "</w:ins>",
  ]));
  assert.deepEqual(result.changes, []);
  // An unaccepted revision is not the text the CV would claim, and the paragraph reads as empty
  // while it stands — reporting that emptiness as a formatting change would bury the real finding.
  assert.deepEqual(result.unmappable.map((entry) => [entry.code, entry.location]), [
    ["tracked_changes", "document paragraph 19"],
  ]);
});

test("review comments are surfaced before the rebuild drops them", () => {
  const withoutComments = extract(RENDERED_DOCUMENT, CV_TEXT, {
    extraParts: ["word/comments.xml"],
    replace: {
      "word/comments.xml": '<?xml version="1.0"?><w:comments xmlns:w="http://example.test/w"/>',
    },
  });
  assert.deepEqual(withoutComments.unmappable, [], "the renderer ships an empty comments part");

  for (const comments of [
    '<?xml version="1.0"?><w:comments xmlns:w="http://example.test/w">'
      + '<w:comment w:id="1" w:author="reviewer"><w:p><w:r><w:t>trim this</w:t></w:r></w:p></w:comment>'
      + "</w:comments>",
    // The reader accepts a default-namespace document, so the comment scan cannot require a prefix.
    '<?xml version="1.0"?><comments xmlns="http://example.test/w">'
      + "<comment id=\"1\"><p><r><t>trim this</t></r></p></comment></comments>",
  ]) {
    const withComments = extract(RENDERED_DOCUMENT, CV_TEXT, {
      extraParts: ["word/comments.xml"],
      replace: { "word/comments.xml": comments },
    });
    assert.deepEqual(withComments.unmappable.map((entry) => [entry.code, entry.location]), [
      ["document_comments_present", "word/comments.xml"],
    ]);
  }
});

test("an empty paragraph is a notice, not an added paragraph", () => {
  const result = extract(documentWith([
    "<w:sectPr>",
    '<w:p><w:pPr><w:spacing w:after="20"/></w:pPr></w:p><w:sectPr>',
  ]));
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.unmappable, []);
  assert.deepEqual(result.notices.map((entry) => entry.code), ["empty_paragraph_ignored"]);
});

test("the span editor moves one string literal and leaves every other byte alone", () => {
  // Escapes, non-ASCII and a value that repeats elsewhere in the file: a naive search-and-replace
  // over the JSON text would corrupt at least one of them.
  const awkward = JSON.stringify(
    {
      fileName: "Awkward_CV.docx",
      note: "Quality engineer with TypeScript depth.",
      header: { name: "René \"Ren\" Example", contact: "a\tb", positioning: "ééé" },
      sections: [
        { type: "summary", heading: "Summary", text: "Quality engineer with TypeScript depth." },
      ],
    },
    null,
    2,
  );
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">René &quot;Ren&quot; Example</w:t></w:r></w:p>`
    + `<w:p>${bodyRun("a\tb")}</w:p>`
    + `<w:p>${bodyRun("ééé")}</w:p>`
    + `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">SUMMARY</w:t></w:r></w:p>`
    + `<w:p>${bodyRun("Quality engineer with TypeScript rigor.")}</w:p>`
    + "<w:sectPr/></w:body></w:document>";

  const result = extractCvEdits(packageOf(document), awkward);
  assert.deepEqual(result.unmappable, []);
  assert.deepEqual(result.changes.map((change) => change.path), ["sections[0].text"]);
  const updated = JSON.parse(result.updatedText);
  assert.equal(updated.sections[0].text, "Quality engineer with TypeScript rigor.");
  // The identical string one field above keeps its own bytes: the edit addressed a span, not a value.
  assert.equal(updated.note, "Quality engineer with TypeScript depth.");
  assert.equal(updated.header.name, "René \"Ren\" Example");
  assert.equal(changedLines(awkward, result.updatedText).length, 1);
});

test("a cv.json the renderer itself would refuse is refused here first", () => {
  const unknownType = JSON.stringify({
    fileName: "x.docx",
    sections: [{ type: "timeline", heading: "Timeline" }],
  });
  assert.throws(
    () => extractCvEdits(packageOf(RENDERED_DOCUMENT), unknownType),
    (error) => error instanceof DocxExtractionError && error.code === "cv_section_type_unknown",
  );
  assert.throws(
    () => extractCvEdits(packageOf(RENDERED_DOCUMENT), "{ not json"),
    (error) => error instanceof DocxExtractionError && error.code === "cv_json_unreadable",
  );
});

test("bytes that are not a readable package are the shared inspector's refusal", () => {
  assert.throws(
    () => extractCvEdits(Buffer.from("PK not really a package\n"), CV_TEXT),
    (error) => error instanceof DocxInspectionError && error.code === "docx_package_invalid",
  );
});

// ---- CLI --------------------------------------------------------------------

function runCli(args, { cwd } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [extractorPath, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, report: JSON.parse(stdout) };
  } catch (error) {
    return {
      status: error.status,
      stderr: error.stderr ?? "",
      report: error.stdout ? JSON.parse(error.stdout) : null,
    };
  }
}

function stagingFixture(t, { documentXml = RENDERED_DOCUMENT, cvText = CV_TEXT } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "docx-extract-cli-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const cvPath = join(directory, "cv.json");
  const docxPath = join(directory, "edited.docx");
  writeFileSync(cvPath, cvText, "utf8");
  writeFileSync(docxPath, packageOf(documentXml));
  return { directory, cvPath, docxPath };
}

test("--write applies the mappable edit in place and leaves the directory otherwise untouched", (t) => {
  const fixture = stagingFixture(t, {
    documentXml: documentWith(["a bias for deterministic gates.", "a bias for deterministic gates and short loops."]),
  });
  const first = runCli([fixture.docxPath, "--cv", fixture.cvPath, "--write", fixture.cvPath]);
  assert.equal(first.status, 0);
  assert.equal(first.report.status, "changed");
  assert.equal(first.report.written, fixture.cvPath);
  assert.deepEqual(readdirSync(fixture.directory).sort(), ["cv.json", "edited.docx"]);
  assert.equal(
    JSON.parse(readFileSync(fixture.cvPath, "utf8")).sections[0].text,
    "Quality engineer with TypeScript depth and a bias for deterministic gates and short loops.",
  );

  // Re-running against the file it just wrote reports nothing: the pair is consistent, which is the
  // same check the procedure runs against the rebuilt document.
  const second = runCli([fixture.docxPath, "--cv", fixture.cvPath]);
  assert.equal(second.status, 0);
  assert.equal(second.report.status, "clean");
  assert.deepEqual(second.report.changes, []);
});

test("an unmappable edit exits nonzero and writes nothing until the user resolves it", (t) => {
  const fixture = stagingFixture(t, {
    documentXml: documentWith(
      ["a bias for deterministic gates.", "a bias for deterministic gates and short loops."],
      [">EDUCATION<", ">DEGREES<"],
    ),
  });
  const blocked = runCli([fixture.docxPath, "--cv", fixture.cvPath, "--write", fixture.cvPath]);
  // Frozen literal, not the module's own constant: the procedure promises exit `4` in prose, and a
  // test that read the value back out of the tool would follow it wherever it moved.
  assert.equal(blocked.status, 4);
  assert.equal(EXIT_UNMAPPABLE, 4, "the exported code and the documented one are the same number");
  assert.equal(blocked.report.status, "unmappable");
  assert.equal(blocked.report.written, null);
  assert.equal(blocked.report.changes.length, 1, "the mappable edit is still reported");
  assert.equal(readFileSync(fixture.cvPath, "utf8"), CV_TEXT, "nothing is written while a finding stands");

  // The user's decision to drop the finding is a flag, not a silent fallback — and the exit code
  // still says a decision was made, so a script cannot mistake this for a clean sync.
  const forced = runCli([
    fixture.docxPath,
    "--cv",
    fixture.cvPath,
    "--write",
    fixture.cvPath,
    "--ignore-unmappable",
  ]);
  assert.equal(forced.status, 4);
  assert.equal(forced.report.written, fixture.cvPath);
  assert.equal(forced.report.unmappable.length, 1);
  // The report says which of the two nonzero outcomes this was, instead of leaving the agent to
  // infer it from the presence of `written`.
  assert.equal(forced.report.unmappableIgnored, true);
  assert.equal(blocked.report.unmappableIgnored, false);
  const written = JSON.parse(readFileSync(fixture.cvPath, "utf8"));
  assert.match(written.sections[0].text, /short loops\./);
  assert.equal(written.sections[4].heading, "Education", "the dropped finding changes nothing");
});

test("--expect-sha256 refuses a document that is not the one the ledger journaled", (t) => {
  const fixture = stagingFixture(t);
  const wrong = "0".repeat(64);
  const refused = runCli([
    fixture.docxPath,
    "--cv",
    fixture.cvPath,
    "--expect-sha256",
    wrong,
    "--write",
    fixture.cvPath,
  ]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /docx_digest_mismatch|not the expected/);
  assert.equal(readFileSync(fixture.cvPath, "utf8"), CV_TEXT);

  const accepted = runCli([fixture.docxPath, "--cv", fixture.cvPath]);
  assert.equal(accepted.status, 0);
  const matched = runCli([
    fixture.docxPath,
    "--cv",
    fixture.cvPath,
    "--expect-sha256",
    accepted.report.docxSha256,
  ]);
  assert.equal(matched.status, 0);
  assert.equal(matched.report.status, "clean");
});

test("the CLI refuses an unknown option instead of ignoring it", (t) => {
  const fixture = stagingFixture(t);
  const unknown = runCli([fixture.docxPath, "--cv", fixture.cvPath, "--apply"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option: --apply/);
  const missingCv = runCli([fixture.docxPath]);
  assert.equal(missingCv.status, 1);
  assert.match(missingCv.stderr, /--cv is required/);
  // A flag whose value was swallowed by the next flag would otherwise read as a path named `--write`.
  const missingValue = runCli([fixture.docxPath, "--cv", "--write", fixture.cvPath]);
  assert.equal(missingValue.status, 1);
  assert.match(missingValue.stderr, /Missing value for --cv/);
  // A digest that is not one cannot be compared, so it is refused rather than never matching.
  const badDigest = runCli([fixture.docxPath, "--cv", fixture.cvPath, "--expect-sha256", "deadbeef"]);
  assert.equal(badDigest.status, 1);
  assert.match(badDigest.stderr, /64 lowercase hexadecimal characters/);
  // The archived document is the only copy of what the user edited, and a mistyped target would
  // overwrite it — or any other file — with CV source and report success. The write updates the
  // file `--cv` named, and nothing else.
  for (const target of [fixture.docxPath, join(fixture.directory, "elsewhere.json")]) {
    const wrongTarget = runCli([fixture.docxPath, "--cv", fixture.cvPath, "--write", target]);
    assert.equal(wrongTarget.status, 1);
    assert.match(wrongTarget.stderr, /--write names the same cv\.json as --cv/);
  }
  assert.deepEqual(readdirSync(fixture.directory).sort(), ["cv.json", "edited.docx"]);
});

test("--write on a document that changed nothing leaves the file alone", (t) => {
  // Rewriting identical bytes is not harmless here: the staged candidate is the adoption's base,
  // and a write that reports itself as a write invites a diff that does not exist.
  const fixture = stagingFixture(t);
  const before = readFileSync(fixture.cvPath);
  const result = runCli([fixture.docxPath, "--cv", fixture.cvPath, "--write", fixture.cvPath]);
  assert.equal(result.status, 0);
  assert.equal(result.report.status, "clean");
  assert.equal(result.report.written, null);
  assert.deepEqual(readFileSync(fixture.cvPath), before);
  assert.deepEqual(readdirSync(fixture.directory).sort(), ["cv.json", "edited.docx"]);
});

// ---- links (backlog task 098) -----------------------------------------------

const HYPERLINK_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const GATES = "https://github.com/example/gates";
const GATES_ID = RENDERED_RELATIONSHIPS.match(/Id="([^"]+)"[^>]*Target="https:\/\/github\.com\/example\/gates"/)[1];
const GATES_BULLET = "sections[3].roles[0].bullets[1]";

function relationshipsWith(...replacements) {
  return replacements.reduce((xml, [from, to]) => {
    assert.ok(xml.includes(from), `the fixture relationships do not contain ${JSON.stringify(from)}`);
    return xml.replace(from, to);
  }, RENDERED_RELATIONSHIPS);
}

function addedRelationship(id, target) {
  return relationshipsWith([
    "</Relationships>",
    `<Relationship Id="${id}" Type="${HYPERLINK_TYPE}" Target="${target}" TargetMode="External"/></Relationships>`,
  ]);
}

function located(entries) {
  return entries.map((entry) => [entry.code, entry.location]);
}

test("a link is derived from the text it states, and a dotted name is not a link", () => {
  const cases = [
    ["candidate@example.com  |  linkedin.com/in/candidate-handle  |  github.com/candidate-handle", [
      ["candidate@example.com", "mailto:candidate@example.com"],
      ["linkedin.com/in/candidate-handle", "https://linkedin.com/in/candidate-handle"],
      ["github.com/candidate-handle", "https://github.com/candidate-handle"],
    ]],
    // The two shapes the real corpus ends a sentence with.
    ["a public suite (https://github.com/candidate-handle/sample-suite).", [
      ["https://github.com/candidate-handle/sample-suite", "https://github.com/candidate-handle/sample-suite"],
    ]],
    ["see github.com/candidate-handle/sample-suite.", [
      ["github.com/candidate-handle/sample-suite", "https://github.com/candidate-handle/sample-suite"],
    ]],
    ["[github.com/a_(b)]", [["github.com/a_(b)", "https://github.com/a_(b)"]]],
    // The `www.` inside a scheme does not open a second link.
    ["https://www.linkedin.com/in/candidate-handle", [
      ["https://www.linkedin.com/in/candidate-handle", "https://www.linkedin.com/in/candidate-handle"],
    ]],
    ["www.example.com/x", [["www.example.com/x", "https://www.example.com/x"]]],
    ["github.com/candidate-handle/Sample-E2E", [
      ["github.com/candidate-handle/Sample-E2E", "https://github.com/candidate-handle/Sample-E2E"],
    ]],
    ["https://example.xyz/page", [["https://example.xyz/page", "https://example.xyz/page"]]],
    ["Node.js/TypeScript, ASP.NET/C#, Socket.IO/REST, Booking.com, CI/CD, package.json/yaml, e.g.", []],
    ["next.js/react, vue.js/nuxt", []],
    // The accepted residual: no scheme, and an uppercase host or an unlisted TLD.
    ["GitHub.com/candidate-handle", []],
    ["example.xyz/page", []],
    ["candidate@example.test", []],
    ["http://", []],
    ["", []],
  ];
  for (const [text, expected] of cases) {
    const segments = linkSegments(text);
    assert.equal(segments.map((segment) => segment.text).join(""), text, `${text}: segments join back`);
    assert.deepEqual(
      segments.filter((segment) => segment.href !== null).map((segment) => [segment.text, segment.href]),
      expected,
      text,
    );
  }
  // A heading renders uppercased: the offsets follow the display text, which `ß` lengthens, and the
  // target keeps the source spelling.
  assert.deepEqual(runLinks(["Straße: github.com/Ab"], { upper: true }), [
    { start: 9, end: 22, href: "https://github.com/Ab" },
  ]);
});

test("the rendered document carries exactly the links the plan derives, paragraph by paragraph", () => {
  const slots = planCvSlots(JSON.parse(CV_TEXT));
  const { paragraphs } = readDocumentParagraphs(RENDERED_DOCUMENT, readRelationships(RENDERED_RELATIONSHIPS));
  assert.equal(slots.length, paragraphs.length);
  slots.forEach((slot, index) => {
    assert.deepEqual(
      paragraphs[index].links.map((link) => [link.start, link.end, link.target]),
      slot.links.map((link) => [link.start, link.end, link.href]),
      `slot ${index} (${formatPath(slot.path)})`,
    );
  });
  // Frozen: the e-mail, the profile link and the repository link inside parentheses.
  assert.deepEqual(slots.flatMap((slot) => slot.links.map((link) => link.href)), [
    "mailto:candidate@example.com",
    "https://linkedin.com/in/example",
    GATES,
  ]);
});

test("a document with no links reads with a notice per link the rebuild restores, never a finding", () => {
  const legacy = RENDERED_DOCUMENT.replaceAll(/<w:hyperlink\b[^>]*>/g, "").replaceAll("</w:hyperlink>", "");
  const result = extract(legacy);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.unmappable, []);
  assert.deepEqual(located(result.notices), [
    ["hyperlink_not_synced", "header.contact"],
    ["hyperlink_not_synced", "header.contact"],
    ["hyperlink_not_synced", GATES_BULLET],
  ]);
  assert.equal(result.updatedText, CV_TEXT);
});

test("a hand link on a scheme-less address that differs only by its scheme is a notice", () => {
  for (const target of ["http://linkedin.com/in/example", "linkedin.com/in/example"]) {
    const result = extract(RENDERED_DOCUMENT, CV_TEXT, {
      replace: {
        [MAIN_DOCUMENT_RELATIONSHIPS_PART]: relationshipsWith([
          'Target="https://linkedin.com/in/example"',
          `Target="${target}"`,
        ]),
      },
    });
    assert.deepEqual(result.unmappable, [], target);
    assert.deepEqual(located(result.notices), [["hyperlink_not_synced", "header.contact"]], target);
  }
  // The text states its scheme, so a different one is a different target.
  const stated = extract(RENDERED_DOCUMENT, CV_TEXT, {
    replace: {
      [MAIN_DOCUMENT_RELATIONSHIPS_PART]: relationshipsWith([`Target="${GATES}"`, 'Target="http://github.com/example/gates"']),
    },
  });
  assert.deepEqual(located(stated.unmappable), [["hyperlink_target_mismatch", GATES_BULLET]]);
});

test("a retargeted link is a finding at its location, alone or behind a formatting change", () => {
  const retargeted = {
    replace: {
      [MAIN_DOCUMENT_RELATIONSHIPS_PART]: relationshipsWith([`Target="${GATES}"`, 'Target="https://github.com/example/other"']),
    },
  };
  const alone = extract(RENDERED_DOCUMENT, CV_TEXT, retargeted);
  assert.deepEqual(alone.changes, []);
  assert.deepEqual(located(alone.unmappable), [["hyperlink_target_mismatch", GATES_BULLET]]);
  assert.match(alone.unmappable[0].detail, /github\.com\/example\/other/);

  // Bold on unchanged text leaves the pair loop through a notice; the retarget must not leave with it.
  const bolded = extract(documentWith([
    '<w:b w:val="false"/><w:bCs w:val="false"/><w:i w:val="false"/><w:iCs w:val="false"/><w:sz w:val="21"/>'
      + '<w:szCs w:val="21"/></w:rPr><w:t xml:space="preserve">Reviewed every gate',
    '<w:b/><w:bCs/><w:i w:val="false"/><w:iCs w:val="false"/><w:sz w:val="21"/>'
      + '<w:szCs w:val="21"/></w:rPr><w:t xml:space="preserve">Reviewed every gate',
  ]), CV_TEXT, retargeted);
  assert.deepEqual(located(bolded.unmappable), [["hyperlink_target_mismatch", GATES_BULLET]]);
  assert.deepEqual(located(bolded.notices), [["formatting_not_synced", GATES_BULLET]]);

  // An id the relationships part does not hold opens nothing: reported, not trusted.
  const dangling = extract(documentWith([`r:id="${GATES_ID}"`, 'r:id="rIdMissing"']));
  assert.deepEqual(located(dangling.unmappable), [["hyperlink_target_mismatch", GATES_BULLET]]);
  assert.match(dangling.unmappable[0].detail, /no external target/);
});

test("URL text edited under the target Word kept is carried over and the stale target reported", () => {
  const result = extract(documentWith([`>${GATES}<`, ">https://github.com/example/gate-log<"]));
  assert.deepEqual(result.changes.map((change) => [change.path, change.after]), [
    [GATES_BULLET, "Reviewed every gate change with the team that had to live with it (https://github.com/example/gate-log)."],
  ]);
  assert.deepEqual(located(result.unmappable), [["hyperlink_target_mismatch", GATES_BULLET]]);
});

test("a link on text that is not an address cannot be carried and is reported", () => {
  const owned = '<w:t xml:space="preserve">Owned the end-to-end suite for two product surfaces.</w:t></w:r>';
  const wrapped = (head) => documentWith([
    owned,
    `<w:t xml:space="preserve"></w:t></w:r>${head}<w:r>`
      + '<w:t xml:space="preserve">Owned the end-to-end suite for two product surfaces.</w:t></w:r></w:hyperlink>',
  ]);
  const external = extract(wrapped('<w:hyperlink r:id="rIdHand">'), CV_TEXT, {
    replace: { [MAIN_DOCUMENT_RELATIONSHIPS_PART]: addedRelationship("rIdHand", "https://github.com/example") },
  });
  assert.deepEqual(located(external.unmappable), [["hyperlink_not_derivable", "sections[3].roles[0].bullets[0]"]]);
  assert.equal(external.updatedText, CV_TEXT);

  const anchor = extract(wrapped('<w:hyperlink w:anchor="_Top">'));
  assert.deepEqual(located(anchor.unmappable), [["hyperlink_not_derivable", "sections[3].roles[0].bullets[0]"]]);
  assert.match(anchor.unmappable[0].detail, /#_Top/);
});

test("inside a hyperlink, proofing marks are ignored and tracked changes are what they are", () => {
  const open = `r:id="${GATES_ID}">`;
  const proofed = extract(documentWith([open, `${open}<w:proofErr w:type="spellStart"/><w:bookmarkStart w:id="3" w:name="_GoBack"/>`]));
  assert.deepEqual(proofed.changes, []);
  assert.deepEqual(proofed.unmappable, []);
  assert.deepEqual(proofed.notices, []);

  const tracked = extract(documentWith([
    open,
    `${open}<w:ins w:id="9" w:author="Reviewer"><w:r><w:t>x</w:t></w:r></w:ins>`,
  ]));
  assert.deepEqual(tracked.unmappable.map((finding) => finding.code), ["tracked_changes"]);
});

test("the link Word made by hand in a real CV reads clean when it matches the address", () => {
  // The shape observed in a real adoption: Word's own relationship id, the Hyperlink character
  // style, bold direct formatting, and the label's `: ` left outside the link.
  const url = "https://github.com/candidate-handle/sample-suite";
  const cvText = CV_TEXT.replace('"label": "Test Automation"', `"label": "${url}"`);
  assert.notEqual(cvText, CV_TEXT);
  const document = documentWith([
    '<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:cs="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri"/><w:b/><w:bCs/>'
      + '<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr><w:t xml:space="preserve">Test Automation: </w:t></w:r>',
    '<w:hyperlink r:id="rId2"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/><w:rFonts w:eastAsia="Calibri" w:cs="Calibri"/>'
      + `<w:b/><w:bCs/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr><w:t>${url}</w:t></w:r></w:hyperlink>`
      + '<w:r><w:rPr><w:rFonts w:eastAsia="Calibri" w:cs="Calibri"/><w:b/><w:bCs/><w:sz w:val="21"/>'
      + '<w:szCs w:val="21"/></w:rPr><w:t xml:space="preserve">: </w:t></w:r>',
  ]);
  const result = extract(document, cvText, {
    replace: { [MAIN_DOCUMENT_RELATIONSHIPS_PART]: addedRelationship("rId2", url) },
  });
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.unmappable, []);
  assert.deepEqual(result.notices, []);
  assert.equal(result.updatedText, cvText);
});
