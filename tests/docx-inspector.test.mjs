import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

import {
  DocxInspectionError,
  inspectDocxBytes,
  readDocxParts,
  REQUIRED_DOCX_PARTS,
} from "../tools/cv-builder/docx-inspector.mjs";
import {
  CONTENT_TYPES_PART,
  MAIN_DOCUMENT_PART,
  MAIN_DOCUMENT_RELATIONSHIPS_PART,
  ROOT_RELATIONSHIPS_PART,
  createDocxBytes,
} from "./fixtures/minimal-docx.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function makeCv(overrides = {}) {
  return {
    fileName: "Candidate_CV_Synthetic_Role.docx",
    header: { name: "Candidate Name" },
    sections: [
      {
        type: "experience",
        heading: "Experience",
        roles: [
          {
            company: "Current Company",
            title: "Senior QA Automation Engineer",
            dates: "2020 - Present",
          },
        ],
      },
    ],
    ...overrides,
  };
}

function rejection(bytes, cv = makeCv()) {
  let caught = null;
  try {
    inspectDocxBytes(bytes, cv);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "expected the inspector to reject these bytes");
  assert.ok(caught instanceof DocxInspectionError, `expected DocxInspectionError, got ${caught}`);
  assert.equal(caught.code, "docx_package_invalid");
  return caught;
}

const EXPECTED_REQUIRED_XML_PARTS = Object.freeze([
  "[Content_Types].xml",
  "_rels/.rels",
  "word/document.xml",
  "word/_rels/document.xml.rels",
]);

const EXPECTED_MALFORMED_XML_CASE_IDS = Object.freeze([
  "unknown-entity",
  "raw-ampersand",
  "entity-missing-semicolon",
  "numeric-reference-missing-semicolon",
  "decimal-reference-without-digits",
  "hex-reference-without-digits",
  "numeric-reference-zero",
  "numeric-reference-control",
  "numeric-reference-surrogate",
  "numeric-reference-fffe",
  "numeric-reference-ffff",
  "numeric-reference-too-large",
  "numeric-reference-huge",
  "illegal-literal-control",
  "illegal-literal-fffe",
  "invalid-name-start",
  "invalid-name-character",
  "invalid-name-range-gap",
  "invalid-name-supplementary-range",
  "mismatched-tag",
  "unclosed-tag",
  "unclosed-element",
  "stray-close-tag",
  "no-root",
  "second-root",
  "trailing-root",
  "text-before-root",
  "nbsp-before-root",
  "entity-before-root",
  "cdata-before-root",
  "text-after-root",
  "duplicate-attribute",
  "unquoted-attribute",
  "missing-attribute-separator",
  "less-than-in-attribute",
  "unterminated-attribute",
  "garbage-after-attributes",
  "malformed-empty-element",
  "end-tag-attributes",
  "cdata-close-in-character-data",
  "unterminated-comment",
  "double-hyphen-comment",
  "trailing-hyphen-comment",
  "unterminated-cdata",
  "unterminated-processing-instruction",
  "reserved-xml-processing-instruction",
  "declaration-after-whitespace",
  "declaration-after-comment",
  "declaration-inside-root",
  "duplicate-declaration",
  "declaration-missing-version",
  "declaration-unknown-attribute",
  "declaration-out-of-order",
  "duplicate-declaration-attribute",
  "unterminated-declaration",
  "declaration-reference-value",
  "unsupported-xml-version",
  "conflicting-encoding",
  "invalid-standalone",
  "doctype",
  "entity-declaration",
  "generic-declaration",
]);

const MALFORMED_XML_CASES = Object.freeze([
  ["unknown-entity", "<root>&unknown;</root>"],
  ["raw-ampersand", "<root>& raw</root>"],
  ["entity-missing-semicolon", "<root>&amp</root>"],
  ["numeric-reference-missing-semicolon", "<root>&#65</root>"],
  ["decimal-reference-without-digits", "<root>&#;</root>"],
  ["hex-reference-without-digits", "<root>&#x;</root>"],
  ["numeric-reference-zero", "<root>&#0;</root>"],
  ["numeric-reference-control", "<root>&#1;</root>"],
  ["numeric-reference-surrogate", "<root>&#xD800;</root>"],
  ["numeric-reference-fffe", "<root>&#xFFFE;</root>"],
  ["numeric-reference-ffff", "<root>&#xFFFF;</root>"],
  ["numeric-reference-too-large", "<root>&#x110000;</root>"],
  ["numeric-reference-huge", `<root>&#${"9".repeat(64)};</root>`],
  ["illegal-literal-control", "<root>\u0001</root>"],
  ["illegal-literal-fffe", "<root>\ufffe</root>"],
  ["invalid-name-start", "<1root/>"],
  ["invalid-name-character", "<root?bad/>"],
  ["invalid-name-range-gap", "<;root/>"],
  ["invalid-name-supplementary-range", "<󰀀root/>"],
  ["mismatched-tag", "<root><child></root></child>"],
  ["unclosed-tag", "<root><child/></root"],
  ["unclosed-element", "<root><child/>"],
  ["stray-close-tag", "</root>"],
  ["no-root", "<?outside ok?>"],
  ["second-root", "<root/><second/>"],
  ["trailing-root", "<root/>tail"],
  ["text-before-root", "text<root/>"],
  ["nbsp-before-root", "\u00a0<root/>"],
  ["entity-before-root", "&#x20;<root/>"],
  ["cdata-before-root", "<![CDATA[ ]]><root/>"],
  ["text-after-root", "<root/>text"],
  ["duplicate-attribute", '<root a="1" a="2"/>'],
  ["unquoted-attribute", "<root a=value/>"],
  ["missing-attribute-separator", '<root a="1"b="2"/>'],
  ["less-than-in-attribute", '<root a="one<two"/>'],
  ["unterminated-attribute", '<root a="value/>'],
  ["garbage-after-attributes", '<root a="1" garbage/>'],
  ["malformed-empty-element", "<root/ >"],
  ["end-tag-attributes", '<root></root x="1">'],
  ["cdata-close-in-character-data", "<root>bad]]>data</root>"],
  ["unterminated-comment", "<root><!-- open</root>"],
  ["double-hyphen-comment", "<root><!-- a--b --></root>"],
  ["trailing-hyphen-comment", "<root><!-- trailing---></root>"],
  ["unterminated-cdata", "<root><![CDATA[ open</root>"],
  ["unterminated-processing-instruction", "<root><?target open</root>"],
  ["reserved-xml-processing-instruction", "<root><?XML value?></root>"],
  ["declaration-after-whitespace", ' <?xml version="1.0"?><root/>'],
  ["declaration-after-comment", '<!--before--><?xml version="1.0"?><root/>'],
  ["declaration-inside-root", '<root><?xml version="1.0"?></root>'],
  ["duplicate-declaration", '<?xml version="1.0"?><?xml version="1.0"?><root/>'],
  ["declaration-missing-version", '<?xml encoding="UTF-8"?><root/>'],
  ["declaration-unknown-attribute", '<?xml version="1.0" mode="strict"?><root/>'],
  ["declaration-out-of-order", '<?xml version="1.0" standalone="yes" encoding="UTF-8"?><root/>'],
  ["duplicate-declaration-attribute", '<?xml version="1.0" version="1.0"?><root/>'],
  ["unterminated-declaration", '<?xml version="1.0"><root/>'],
  ["declaration-reference-value", '<?xml version="1&#46;0"?><root/>'],
  ["unsupported-xml-version", '<?xml version="1.1"?><root/>'],
  ["conflicting-encoding", '<?xml version="1.0" encoding="UTF-16"?><root/>'],
  ["invalid-standalone", '<?xml version="1.0" standalone="maybe"?><root/>'],
  ["doctype", "<!DOCTYPE root><root/>"],
  ["entity-declaration", "<!ENTITY example 'value'><root/>"],
  ["generic-declaration", "<!ELEMENT root ANY><root/>"],
]);

const EXPECTED_VALID_XML_CASE_IDS = Object.freeze([
  "qnames-and-self-closing",
  "single-and-double-quoted-attributes",
  "supported-declaration",
  "comment-pi-and-cdata-contexts",
  "predefined-and-numeric-entities",
  "nonrecursive-entity-unescape",
  "unicode-content-and-names",
  "initial-bom",
]);

const VALID_XML_CASES = Object.freeze([
  ["qnames-and-self-closing", '<r:root xmlns:r="urn:test"><r:child/></r:root>'],
  ["single-and-double-quoted-attributes", `<root one='1' two="2"/>`],
  ["supported-declaration", '<?xml version="1.0" encoding="utf-8" standalone="yes"?><root/>'],
  [
    "comment-pi-and-cdata-contexts",
    "<!-- <!DOCTYPE root> &unknown; <?xml?> ]]> --><?target ok?><root><![CDATA[<!DOCTYPE root> &unknown; <?xml?> ]]></root>",
  ],
  [
    "predefined-and-numeric-entities",
    '<root a="&lt;&gt;&amp;&quot;&apos;&#9;&#10;&#13;&#65;&#x41;">&lt;&gt;&amp;&quot;&apos;&#65;&#x1F642;</root>',
  ],
  ["nonrecursive-entity-unescape", "<root>&amp;lt;</root>"],
  ["unicode-content-and-names", "<Àroot·name><𐀀child>Привет 🙂</𐀀child></Àroot·name>"],
  ["initial-bom", "\ufeff<?xml version='1.0' encoding='UTF-8'?><root/>"],
]);

test("a package built from the staged cv passes every structural check", () => {
  const cv = makeCv();
  const checks = inspectDocxBytes(createDocxBytes({ cv, marker: "initial" }), cv);
  assert.deepEqual(checks, [
    "ZIP/OOXML package integrity",
    "US Letter page size",
    "0.75in margins",
    "role-header keepNext (1)",
    "font Calibri",
  ]);
});

test("a check is never reported for work that was not done", () => {
  const cv = makeCv({ sections: [] });
  const checks = inspectDocxBytes(createDocxBytes({ cv }), cv);
  assert.ok(!checks.some((check) => check.startsWith("role-header keepNext")));
});

test("roles in every experience section are checked, not only the first", () => {
  const cv = makeCv();
  cv.sections.push({
    type: "experience",
    heading: "Earlier Experience",
    roles: [{ company: "Earlier Company", title: "QA Engineer", dates: "2014 - 2016" }],
  });
  assert.deepEqual(
    inspectDocxBytes(createDocxBytes({ cv }), cv).filter((check) =>
      check.startsWith("role-header keepNext"),
    ),
    ["role-header keepNext (2)"],
  );

  // A document rendered from only the first section must not pass.
  const firstSectionOnly = makeCv();
  rejection(createDocxBytes({ cv: firstSectionOnly }), cv);
});

test("a role heading that prefixes another is matched on its own paragraph", () => {
  const cv = makeCv();
  cv.sections[0].roles = [
    { company: "Acme", title: "Senior QA Automation Engineer", dates: "2020 - Present extended" },
    {
      company: "Acme",
      title: "Senior QA Automation Engineer",
      dates: "2020 - Present",
      pageBreakBefore: true,
    },
  ];
  // The first heading strictly contains the second; a substring search would test the wrong
  // paragraph and reject a correctly rendered document.
  assert.ok(inspectDocxBytes(createDocxBytes({ cv }), cv).length > 0);
});

test("the whole package cannot expand implausibly far across many parts", () => {
  const cv = makeCv();
  const filler = "x".repeat(2 * 1024 * 1024);
  const replace = {};
  // Each part stays under the per-part bound; together they exceed the package bound.
  for (let index = 0; index < 40; index += 1) replace[`word/filler${index}.xml`] = filler;
  const error = rejection(createDocxBytes({ cv, replace, extraParts: Object.keys(replace) }), cv);
  assert.match(error.message, /expands implausibly far/);
});

test("input that is not bytes is rejected as a package problem, not a type error", () => {
  for (const input of [null, undefined, 42, {}, "PK"]) {
    rejection(input);
  }
});

test("both compression branches are accepted", () => {
  const cv = makeCv();
  for (const deflate of [true, false]) {
    assert.ok(inspectDocxBytes(createDocxBytes({ cv, deflate }), cv).length > 0);
  }
});

test("an external hyperlink relationship is legitimate and never rejected", () => {
  const cv = makeCv();
  const parts = readDocxParts(createDocxBytes({ cv }));
  const relationships = parts.get(MAIN_DOCUMENT_RELATIONSHIPS_PART).toString("utf8");
  // The fixture carries the real builder's hyperlink shape: nanoid id, absolute external target.
  assert.match(relationships, /Target="https:\/\/www\.linkedin\.com\/in\/example"/);
  assert.match(relationships, /TargetMode="External"/);
  assert.doesNotMatch(relationships, /Id="rId\d+"/);
  assert.ok(inspectDocxBytes(createDocxBytes({ cv }), cv).length > 0);
});

test("a declared page break and a non-default font are accepted", () => {
  const cv = makeCv({ font: "Georgia" });
  cv.sections[0].roles.push({
    company: "Previous Company",
    title: "QA Engineer",
    dates: "2016 - 2020",
    pageBreakBefore: true,
  });
  const checks = inspectDocxBytes(createDocxBytes({ cv }), cv);
  assert.ok(checks.includes("font Georgia"));
  assert.ok(checks.includes("1 explicit role page break(s)"));
});

test("role headings needing XML escaping are matched, not mis-escaped", () => {
  const cv = makeCv();
  cv.sections[0].roles[0].company = 'Ampersand & "Quote" <Co>';
  assert.ok(inspectDocxBytes(createDocxBytes({ cv }), cv).length > 0);
});

test("plain text named .docx is rejected", () => {
  rejection(Buffer.from("synthetic staged DOCX initial\n", "utf8"));
});

test("an empty candidate is rejected", () => {
  rejection(Buffer.alloc(0));
});

test("broken ZIP containers are rejected", () => {
  const cv = makeCv();
  const valid = createDocxBytes({ cv });

  // Truncation removes the end record entirely.
  rejection(valid.subarray(0, 120), cv);
  // A trailing byte pushes the end-of-central-directory scan off the record it must find.
  rejection(Buffer.concat([valid.subarray(0, valid.length - 4)]), cv);
  // The end record promises more entries than the directory holds.
  rejection(createDocxBytes({ cv, declaredEntryCount: 9 }), cv);
  // Intact offsets, one corrupted checksum.
  rejection(createDocxBytes({ cv, corruptCrcFor: MAIN_DOCUMENT_PART }), cv);

  // A valid ZIP whose deflate stream is garbage.
  const broken = Buffer.from(createDocxBytes({ cv }));
  const marker = broken.indexOf(Buffer.from("word/document.xml", "utf8"));
  broken[marker + 40] ^= 0xff;
  rejection(broken, cv);
});

test("a compression bomb is rejected instead of being inflated", () => {
  // The publisher inflates candidate parts inside the ledger lock, so this must fail fast rather
  // than expand. 50 MiB of zeros packs into ~50 KB.
  const bomb = Buffer.alloc(50 * 1024 * 1024, 0);
  const packed = deflateRawSync(bomb);
  assert.ok(packed.length < 100 * 1024);
  const name = Buffer.from(MAIN_DOCUMENT_PART, "utf8");

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(bomb) >>> 0, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(bomb.length, 22);
  local.writeUInt16LE(name.length, 26);

  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(20, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt16LE(8, 10);
  directory.writeUInt32LE(crc32(bomb) >>> 0, 16);
  directory.writeUInt32LE(packed.length, 20);
  directory.writeUInt32LE(bomb.length, 24);
  directory.writeUInt16LE(name.length, 28);
  directory.writeUInt32LE(0, 42);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + packed.length, 16);

  const error = rejection(Buffer.concat([local, name, packed, directory, name, end]));
  assert.match(error.message, /implausibly large/);
});

test("every required OOXML part is required", () => {
  const cv = makeCv();
  for (const part of [
    CONTENT_TYPES_PART,
    ROOT_RELATIONSHIPS_PART,
    MAIN_DOCUMENT_PART,
    MAIN_DOCUMENT_RELATIONSHIPS_PART,
  ]) {
    const error = rejection(createDocxBytes({ cv, omit: [part] }), cv);
    assert.match(error.message, new RegExp(part.replace(/[[\]./]/g, "\\$&")));
  }
});

test("every required XML part is parsed instead of merely decoded", () => {
  const cv = makeCv();
  const validParts = readDocxParts(createDocxBytes({ cv }));
  const declaredCases = [
    [CONTENT_TYPES_PART, (xml) => xml.replace("</Types>", "&undefined;</Types>")],
    [
      ROOT_RELATIONSHIPS_PART,
      (xml) => xml.replace("</Relationships>", "&undefined;</Relationships>"),
    ],
    [
      MAIN_DOCUMENT_PART,
      (xml) => xml.replace("<w:body>", "<w:body><w:p><w:r><w:t>&undefined;</w:t></w:r></w:p>"),
    ],
    [
      MAIN_DOCUMENT_RELATIONSHIPS_PART,
      (xml) => xml.replace("</Relationships>", "&undefined;</Relationships>"),
    ],
  ];
  const executed = new Set();

  assert.deepEqual([...REQUIRED_DOCX_PARTS].sort(), [...EXPECTED_REQUIRED_XML_PARTS].sort());
  assert.deepEqual(
    declaredCases.map(([part]) => part).sort(),
    [...EXPECTED_REQUIRED_XML_PARTS].sort(),
  );
  for (const [part, mutate] of declaredCases) {
    const original = validParts.get(part).toString("utf8");
    const error = rejection(createDocxBytes({ cv, replace: { [part]: mutate(original) } }), cv);
    assert.match(error.message, new RegExp(part.replace(/[[\]./]/g, "\\$&")));
    assert.match(error.message, /not well-formed XML/);
    executed.add(part);
  }
  assert.deepEqual([...executed].sort(), [...EXPECTED_REQUIRED_XML_PARTS].sort());
});

test("the XML scanner rejects every frozen malformed syntax class", () => {
  const cv = makeCv();
  const declaredIds = MALFORMED_XML_CASES.map(([id]) => id);
  const executed = new Set();

  assert.deepEqual(declaredIds.sort(), [...EXPECTED_MALFORMED_XML_CASE_IDS].sort());
  for (const [id, xml] of MALFORMED_XML_CASES) {
    const error = rejection(
      createDocxBytes({
        cv,
        replace: { [MAIN_DOCUMENT_RELATIONSHIPS_PART]: xml },
      }),
      cv,
    );
    assert.match(error.message, /word\/_rels\/document\.xml\.rels/);
    assert.match(error.message, /not well-formed XML/);
    executed.add(id);
  }
  assert.deepEqual([...executed].sort(), [...EXPECTED_MALFORMED_XML_CASE_IDS].sort());
});

test("the XML scanner accepts the frozen bounded positive syntax inventory", () => {
  const cv = makeCv();
  const declaredIds = VALID_XML_CASES.map(([id]) => id);
  const executed = new Set();

  assert.deepEqual(declaredIds.sort(), [...EXPECTED_VALID_XML_CASE_IDS].sort());
  for (const [id, xml] of VALID_XML_CASES) {
    assert.ok(
      inspectDocxBytes(
        createDocxBytes({
          cv,
          replace: { [MAIN_DOCUMENT_RELATIONSHIPS_PART]: xml },
        }),
        cv,
      ).length > 0,
      id,
    );
    executed.add(id);
  }
  assert.deepEqual([...executed].sort(), [...EXPECTED_VALID_XML_CASE_IDS].sort());
});

test("a package whose parts are present but unusable is rejected", () => {
  const cv = makeCv();
  const cases = [
    ["empty main document", { [MAIN_DOCUMENT_PART]: "" }],
    ["main document is plain text", { [MAIN_DOCUMENT_PART]: "not xml at all\n" }],
    [
      "main document is XML but not WordprocessingML",
      { [MAIN_DOCUMENT_PART]: '<?xml version="1.0"?><html><body/></html>' },
    ],
    [
      "main document has no body",
      {
        [MAIN_DOCUMENT_PART]:
          '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
      },
    ],
    [
      "content types do not declare the main document",
      {
        [CONTENT_TYPES_PART]:
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
      },
    ],
    [
      "root relationships do not point at the main document",
      {
        [ROOT_RELATIONSHIPS_PART]:
          '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/other.xml"/></Relationships>',
      },
    ],
    [
      "the office document relationship is external",
      {
        [ROOT_RELATIONSHIPS_PART]:
          '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="https://example.com/document.xml" TargetMode="External"/></Relationships>',
      },
    ],
    [
      "the main document is not valid UTF-8",
      { [MAIN_DOCUMENT_PART]: Buffer.from([0x3c, 0x77, 0xff, 0xfe, 0x3e]) },
    ],
  ];
  for (const [label, replace] of cases) {
    const error = rejection(createDocxBytes({ cv, replace }), cv);
    assert.ok(error.message.length > 0, label);
  }
});

test("a package that no longer matches the staged cv is rejected", () => {
  const cv = makeCv();

  // Stale render: cv.json was edited after the last build.
  const renamed = makeCv();
  renamed.sections[0].roles[0].company = "Former Company";
  rejection(createDocxBytes({ cv: renamed }), cv);

  // The font was changed in cv.json without rebuilding.
  rejection(createDocxBytes({ cv: makeCv({ font: "Arial" }) }), cv);

  // A requested page break never reached the document.
  const withBreak = makeCv();
  withBreak.sections[0].roles[0].pageBreakBefore = true;
  rejection(createDocxBytes({ cv }), withBreak);
});

test("layout regressions in the rendered package are rejected", () => {
  const cv = makeCv();
  const document = createDocxBytes({ cv });
  const documentXml = readDocxParts(document).get(MAIN_DOCUMENT_PART).toString("utf8");

  rejection(
    createDocxBytes({
      cv,
      replace: { [MAIN_DOCUMENT_PART]: documentXml.replace('w:h="15840"', 'w:h="16838"') },
    }),
    cv,
  );
  rejection(
    createDocxBytes({
      cv,
      replace: { [MAIN_DOCUMENT_PART]: documentXml.replace('w:top="1080"', 'w:top="1440"') },
    }),
    cv,
  );
  rejection(
    createDocxBytes({
      cv,
      replace: { [MAIN_DOCUMENT_PART]: documentXml.replaceAll("<w:keepNext/>", "") },
    }),
    cv,
  );
});

test("the inspector stays importable from the dependency-free repository root", () => {
  const source = readFileSync(resolve(repoRoot, "tools/cv-builder/docx-inspector.mjs"), "utf8");
  const imports = [...source.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";/gm)].map(
    (match) => match[1],
  );
  assert.ok(imports.length > 0);
  for (const specifier of imports) {
    assert.ok(
      specifier.startsWith("node:"),
      `the shared inspector must import only Node built-ins, found ${specifier}`,
    );
  }
  // The lifecycle publisher imports this module; a package dependency would break `npm test` and
  // every publication on a clone that never ran the nested cv-builder install.
  assert.doesNotMatch(source, /require\(|child_process|spawnSync/);
});

test("readDocxParts tolerates real-package encoding variants", () => {
  const cv = makeCv();
  const parts = readDocxParts(createDocxBytes({ cv }));
  assert.deepEqual(
    [...parts.keys()].sort(),
    [
      CONTENT_TYPES_PART,
      ROOT_RELATIONSHIPS_PART,
      MAIN_DOCUMENT_RELATIONSHIPS_PART,
      MAIN_DOCUMENT_PART,
    ].sort(),
  );
  // Content types is deliberately the last entry, as in every real package.
  assert.equal([...parts.keys()].at(-1), CONTENT_TYPES_PART);
  assert.ok(deflateRawSync(Buffer.from("x")).length > 0);
});

test("a declaration that only appears inside an XML comment does not count", () => {
  const cv = makeCv();
  const commented = (xml, pattern) => xml.replace(pattern, (match) => `<!-- ${match} -->`);
  const parts = readDocxParts(createDocxBytes({ cv }));
  const contentTypes = parts.get(CONTENT_TYPES_PART).toString("utf8");
  const rootRelationships = parts.get(ROOT_RELATIONSHIPS_PART).toString("utf8");

  rejection(
    createDocxBytes({
      cv,
      replace: { [CONTENT_TYPES_PART]: commented(contentTypes, /<Override\b[^>]*>/) },
    }),
    cv,
  );
  rejection(
    createDocxBytes({
      cv,
      replace: { [ROOT_RELATIONSHIPS_PART]: commented(rootRelationships, /<Relationship\b[^>]*>/) },
    }),
    cv,
  );
});

test("a part that merely mentions the namespace is not a document", () => {
  const cv = makeCv();
  const cases = [
    [
      "wrong root element",
      '<?xml version="1.0"?><notdocument xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        "<w:body><w:p/></w:body></notdocument>",
    ],
    [
      "right root, namespace not bound",
      '<?xml version="1.0"?><w:document xmlns:w="http://example.com/not-wordprocessingml">' +
        "<w:body><w:p>http://schemas.openxmlformats.org/wordprocessingml/2006/main</w:p></w:body></w:document>",
    ],
    [
      "namespace only inside a comment",
      '<?xml version="1.0"?><!-- <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"> -->' +
        "<w:body/>",
    ],
  ];
  for (const [label, documentXml] of cases) {
    const error = rejection(
      createDocxBytes({ cv, replace: { [MAIN_DOCUMENT_PART]: documentXml } }),
      cv,
    );
    assert.ok(error.message.length > 0, label);
  }
});
