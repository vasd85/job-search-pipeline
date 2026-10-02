/*
 * Deterministic OOXML package builder for tests.
 *
 * Fixtures that stage a CV publication must produce real packages now that the publisher inspects
 * DOCX bytes, and the real renderer is not reachable from `npm test`: `docx` lives in the
 * gitignored nested `tools/cv-builder/node_modules`, and its output carries wall-clock timestamps,
 * so it is neither installable nor byte-stable for a hermetic suite.
 *
 * The document is derived from the same `cv` object the fixture stages, so it satisfies the layout
 * contract the builder enforces: page size, margins, per-role `keepNext` headings and the font.
 * Every knob below exists to express one failure class the publication gate must reject.
 */

import { crc32, deflateRawSync } from "node:zlib";

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const STORED = 0;
const DEFLATED = 8;

export const CONTENT_TYPES_PART = "[Content_Types].xml";
export const ROOT_RELATIONSHIPS_PART = "_rels/.rels";
export const MAIN_DOCUMENT_PART = "word/document.xml";
export const MAIN_DOCUMENT_RELATIONSHIPS_PART = "word/_rels/document.xml.rels";

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// Real builder output emits `ContentType` before `PartName`; other producers in the corpus emit the
// opposite order. The fixture uses the real builder's order so an order-pinned inspector fails here
// instead of failing only in production.
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" PartName="/word/document.xml"/>
</Types>`;

const ROOT_RELATIONSHIPS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

// A real hyperlink relationship: nanoid-shaped id, absolute external target. The inspector must
// accept it, so the default document relationships carry one.
const DOCUMENT_RELATIONSHIPS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdehsjkgoql1vgxoip7hync" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.linkedin.com/in/example" TargetMode="External"/>
</Relationships>`;

function paragraph(text, { font, keepNext = false, pageBreakBefore = false } = {}) {
  const properties = [
    keepNext ? "<w:keepNext/>" : "",
    pageBreakBefore ? "<w:pageBreakBefore/>" : "",
  ].join("");
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}`
    + `<w:r><w:rPr><w:rFonts w:ascii="${xmlEscape(font)}" w:hAnsi="${xmlEscape(font)}"/></w:rPr>`
    + `<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

export function createDocumentXml(cv = {}, marker = "") {
  const font = cv.font || "Calibri";
  // The real renderer emits every experience section, so the fixture must too.
  const roles = (cv.sections || [])
    .filter((section) => section.type === "experience")
    .flatMap((section) => section.roles ?? []);
  const body = [
    paragraph(cv.header?.name ?? "Candidate Name", { font }),
    // The marker keeps successive revisions byte-distinct. The mixed-pair and backup oracles compare
    // committed bytes against staged bytes, and go vacuous if every revision renders identically.
    marker ? paragraph(`Revision ${marker}`, { font }) : "",
    ...roles.map((role) =>
      paragraph(`${role.company} - ${role.title} - ${role.dates}`, {
        font,
        keepNext: true,
        pageBreakBefore: Boolean(role.pageBreakBefore),
      })),
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}`
    + `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>`
    + `<w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr>`
    + `</w:body></w:document>`;
}

function buildZip(entries, { deflate, corruptCrcFor, declaredEntryCount }) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const content = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    // `_rels/.rels` stays stored so a single package exercises both branches of the reader, the way
    // real output mixes stored directory entries with deflated parts.
    const method = deflate && name !== ROOT_RELATIONSHIPS_PART ? DEFLATED : STORED;
    const stored = method === DEFLATED ? deflateRawSync(content) : content;
    const checksum = name === corruptCrcFor
      ? ((crc32(content) >>> 0) ^ 0xffffffff) >>> 0
      : crc32(content) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, stored);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(CENTRAL_DIRECTORY, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(stored.length, 20);
    directory.writeUInt32LE(content.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += local.length + nameBytes.length + stored.length;
  }

  const centralDirectory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(declaredEntryCount ?? entries.length, 8);
  end.writeUInt16LE(declaredEntryCount ?? entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

/*
 * `omit` drops required parts, `replace` swaps a present part's content so "present but garbage"
 * can be expressed, `corruptCrcFor` breaks one checksum without moving any offset,
 * `declaredEntryCount` desynchronises the end record from the real directory, and `deflate`
 * selects the compression branch.
 */
export function createDocxBytes({
  cv = {},
  marker = "",
  omit = [],
  replace = {},
  extraParts = [],
  corruptCrcFor = null,
  declaredEntryCount = null,
  deflate = true,
} = {}) {
  const omitted = new Set(omit);
  const entries = [
    [ROOT_RELATIONSHIPS_PART, ROOT_RELATIONSHIPS],
    [MAIN_DOCUMENT_PART, createDocumentXml(cv, marker)],
    [MAIN_DOCUMENT_RELATIONSHIPS_PART, DOCUMENT_RELATIONSHIPS],
    // Real packages never put [Content_Types].xml first; keep the fixture honest about ordering.
    [CONTENT_TYPES_PART, CONTENT_TYPES],
    // Real packages also carry parts beyond the required four.
    ...extraParts.map((name) => [name, ""]),
  ]
    .filter(([name]) => !omitted.has(name))
    .map(([name, value]) => [
      name,
      Object.hasOwn(replace, name) ? replace[name] : value,
    ]);
  return buildZip(entries, { corruptCrcFor, declaredEntryCount, deflate });
}
