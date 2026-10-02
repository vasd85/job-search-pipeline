/*
 * One shared DOCX inspector for the builder and the lifecycle publisher.
 *
 * The builder ran a structural contract over its own rendered output, but the publisher committed
 * whatever non-empty bytes were staged under the `.docx` name. Both now run this contract over the
 * same bytes, so a text file, a broken package, or a document that no longer matches its cv.json
 * cannot become a canonical CV artifact.
 *
 * Node built-ins only, deliberately. The repository root package declares no runtime dependencies
 * and `docx`/`jszip` live in the gitignored nested `tools/cv-builder/node_modules`, so a package
 * import here would break `tools/lib/` and `npm test` on a fresh clone. Shelling out is equally
 * unavailable: the publisher must not spawn a process inside the ledger lock, and a subprocess
 * would re-read the file by path instead of inspecting the bytes that were hashed.
 */

import { crc32, inflateRawSync } from "node:zlib";

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const END_RECORD_LENGTH = 22;
const MAX_ZIP_COMMENT = 0xffff;
const STORED = 0;
const DEFLATED = 8;
const ENCRYPTED_FLAG = 0x0001;
/*
 * The publisher inflates candidate parts while it holds the ledger lock, so an entry that expands
 * far beyond any real document is a denial of service, not a document. The largest part observed
 * across the real corpus is a 24 KB `word/document.xml`; this bound is three orders of magnitude
 * above that and still turns a compression bomb into an ordinary rejection.
 */
const MAX_PART_BYTES = 16 * 1024 * 1024;
// Bounding one part is not enough: the reader retains every part it decodes, so many merely-large
// entries add up to the same denial of service. The whole real corpus stays under 64 KB of parts.
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

const OFFICE_DOCUMENT_RELATIONSHIP_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const MAIN_DOCUMENT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const WORDPROCESSING_NAMESPACE =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const CONTENT_TYPES_PART = "[Content_Types].xml";
const ROOT_RELATIONSHIPS_PART = "_rels/.rels";
const MAIN_DOCUMENT_PART = "word/document.xml";
const MAIN_DOCUMENT_RELATIONSHIPS_PART = "word/_rels/document.xml.rels";

export const REQUIRED_DOCX_PARTS = Object.freeze([
  CONTENT_TYPES_PART,
  ROOT_RELATIONSHIPS_PART,
  MAIN_DOCUMENT_PART,
  MAIN_DOCUMENT_RELATIONSHIPS_PART,
]);

export class DocxInspectionError extends Error {
  constructor(message) {
    super(`DOCX structural QA failed: ${message}`);
    this.name = "DocxInspectionError";
    this.code = "docx_package_invalid";
  }
}

function reject(reason) {
  throw new DocxInspectionError(reason);
}

/*
 * Sizes and checksums are read from the central directory, never from local headers. The current
 * renderer does fill its local headers in, but 18 of the 25 packages measured across the real
 * corpus are streaming entries (general-purpose bit 3) whose local headers carry zeroes and defer
 * the real values to a trailing data descriptor. Only the central directory is authoritative for
 * every producer.
 *
 * Tolerated because real packages contain them: deflated and stored entries side by side, explicit
 * directory entries, `[Content_Types].xml` in any position, and arbitrary extra parts.
 */
export function readDocxParts(input) {
  if (!Buffer.isBuffer(input) && !ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer)) {
    reject("the candidate is not readable bytes");
  }
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length < END_RECORD_LENGTH || bytes.readUInt32LE(0) !== LOCAL_FILE_HEADER) {
    reject("the bytes do not start with a ZIP local file header");
  }

  let end = -1;
  const earliest = Math.max(0, bytes.length - END_RECORD_LENGTH - MAX_ZIP_COMMENT);
  for (let offset = bytes.length - END_RECORD_LENGTH; offset >= earliest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      end = offset;
      break;
    }
  }
  if (end < 0) reject("the ZIP end-of-central-directory record is missing");

  const entryCount = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (
    entryCount === 0xffff
    || directorySize === 0xffffffff
    || directoryOffset === 0xffffffff
  ) {
    reject("ZIP64 packages are not supported");
  }
  const directoryEnd = directoryOffset + directorySize;
  if (directoryEnd > end) reject("the ZIP central directory is out of range");

  const parts = new Map();
  let decodedBytes = 0;
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > directoryEnd || bytes.readUInt32LE(cursor) !== CENTRAL_DIRECTORY) {
      reject(`central directory entry ${index} is malformed`);
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedChecksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (cursor > directoryEnd) reject(`central directory entry ${index} overruns the directory`);

    if (flags & ENCRYPTED_FLAG) reject(`part is encrypted: ${name}`);
    if (name.endsWith("/")) continue;
    if (method !== STORED && method !== DEFLATED) {
      reject(`unsupported compression method ${method}: ${name}`);
    }
    if (
      localOffset + 30 > bytes.length
      || bytes.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER
    ) {
      reject(`the local file header is missing: ${name}`);
    }
    const dataStart = localOffset
      + 30
      + bytes.readUInt16LE(localOffset + 26)
      + bytes.readUInt16LE(localOffset + 28);
    if (uncompressedSize > MAX_PART_BYTES) reject(`part is implausibly large: ${name}`);
    decodedBytes += uncompressedSize;
    if (decodedBytes > MAX_PACKAGE_BYTES) reject(`the package expands implausibly far: ${name}`);
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    if (raw.length !== compressedSize) reject(`part data is truncated: ${name}`);
    let content;
    try {
      content = method === STORED
        ? Buffer.from(raw)
        // Bounded by the size the directory declares, so a stream that lies about its own size
        // fails here instead of expanding until the process dies.
        : inflateRawSync(raw, { maxOutputLength: Math.max(uncompressedSize, 1) });
    } catch {
      reject(`part data is not a readable deflate stream: ${name}`);
    }
    if (content.length !== uncompressedSize) reject(`part size mismatch: ${name}`);
    if ((crc32(content) >>> 0) !== expectedChecksum) reject(`part checksum mismatch: ${name}`);
    if (parts.has(name)) reject(`duplicate part: ${name}`);
    parts.set(name, content);
  }
  if (parts.size === 0) reject("the package contains no parts");
  return parts;
}

function decodeXmlPart(parts, name) {
  const bytes = parts.get(name);
  const text = bytes.toString("utf8");
  // Buffer.toString substitutes replacement characters, so compare the round trip instead.
  if (!Buffer.from(text, "utf8").equals(bytes)) reject(`part is not valid UTF-8: ${name}`);
  assertWellFormedXml(text, name);
  return text;
}

const XML_PREDEFINED_ENTITIES = new Set(["amp", "apos", "gt", "lt", "quot"]);

function isXmlWhitespace(character) {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

function isXmlChar(codePoint) {
  return codePoint === 0x9
    || codePoint === 0xa
    || codePoint === 0xd
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

function isXmlNameStart(codePoint) {
  return codePoint === 0x3a
    || codePoint === 0x5f
    || (codePoint >= 0x41 && codePoint <= 0x5a)
    || (codePoint >= 0x61 && codePoint <= 0x7a)
    || (codePoint >= 0xc0 && codePoint <= 0xd6)
    || (codePoint >= 0xd8 && codePoint <= 0xf6)
    || (codePoint >= 0xf8 && codePoint <= 0x2ff)
    || (codePoint >= 0x370 && codePoint <= 0x37d)
    || (codePoint >= 0x37f && codePoint <= 0x1fff)
    || (codePoint >= 0x200c && codePoint <= 0x200d)
    || (codePoint >= 0x2070 && codePoint <= 0x218f)
    || (codePoint >= 0x2c00 && codePoint <= 0x2fef)
    || (codePoint >= 0x3001 && codePoint <= 0xd7ff)
    || (codePoint >= 0xf900 && codePoint <= 0xfdcf)
    || (codePoint >= 0xfdf0 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0xeffff);
}

function isXmlNameChar(codePoint) {
  return isXmlNameStart(codePoint)
    || codePoint === 0x2d
    || codePoint === 0x2e
    || (codePoint >= 0x30 && codePoint <= 0x39)
    || codePoint === 0xb7
    || (codePoint >= 0x300 && codePoint <= 0x36f)
    || (codePoint >= 0x203f && codePoint <= 0x2040);
}

/*
 * Required parts are untrusted bytes at the publication boundary. This deliberately small XML
 * scanner proves only well-formedness within the subset that current OOXML producers use. It is
 * iterative, consumes every token, and has no injectable parser or path-based fallback.
 */
function assertWellFormedXml(xml, partName) {
  const malformed = (reason) => reject(`${partName} is not well-formed XML: ${reason}`);
  const widthAt = (offset) => (xml.codePointAt(offset) > 0xffff ? 2 : 1);
  const documentStart = xml.startsWith("\ufeff") ? 1 : 0;
  const stack = [];
  let cursor = documentStart;
  let rootSeen = false;
  let declarationSeen = false;

  for (let offset = 0; offset < xml.length;) {
    const codePoint = xml.codePointAt(offset);
    if (!isXmlChar(codePoint)) malformed("illegal XML character");
    offset += codePoint > 0xffff ? 2 : 1;
  }

  const skipWhitespace = (start) => {
    let next = start;
    while (next < xml.length && isXmlWhitespace(xml[next])) next += 1;
    return next;
  };

  const parseName = (start) => {
    if (start >= xml.length || !isXmlNameStart(xml.codePointAt(start))) {
      malformed("invalid XML name");
    }
    let end = start + widthAt(start);
    while (end < xml.length && isXmlNameChar(xml.codePointAt(end))) end += widthAt(end);
    return { end, name: xml.slice(start, end) };
  };

  const parseReference = (start) => {
    let next = start + 1;
    if (xml[next] === "#") {
      next += 1;
      const hexadecimal = xml[next] === "x";
      if (hexadecimal) next += 1;
      const digitsStart = next;
      const digitPattern = hexadecimal ? /[0-9A-Fa-f]/ : /[0-9]/;
      while (next < xml.length && digitPattern.test(xml[next])) next += 1;
      const digits = xml.slice(digitsStart, next);
      const limit = hexadecimal ? 6 : 7;
      if (!digits || digits.length > limit || xml[next] !== ";") {
        malformed("malformed numeric character reference");
      }
      const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
      if (!isXmlChar(codePoint)) malformed("numeric character reference is outside XML Char");
      return next + 1;
    }

    const entity = parseName(next);
    if (xml[entity.end] !== ";") malformed("entity reference is missing its semicolon");
    if (!XML_PREDEFINED_ENTITIES.has(entity.name)) malformed("unknown entity reference");
    return entity.end + 1;
  };

  const parseQuotedValue = (start, { references = true } = {}) => {
    const quote = xml[start];
    if (quote !== '"' && quote !== "'") malformed("attribute value is not quoted");
    let next = start + 1;
    while (next < xml.length && xml[next] !== quote) {
      if (xml[next] === "<") malformed("attribute value contains a raw less-than sign");
      if (xml[next] === "&") {
        if (!references) malformed("XML declaration values cannot contain references");
        next = parseReference(next);
      } else {
        next += widthAt(next);
      }
    }
    if (next >= xml.length) malformed("unterminated quoted attribute value");
    return { end: next + 1, value: xml.slice(start + 1, next) };
  };

  const parseDeclaration = (start) => {
    if (start !== documentStart || declarationSeen || rootSeen || stack.length) {
      malformed("misplaced or duplicate XML declaration");
    }
    declarationSeen = true;
    let next = start + 5;
    if (!isXmlWhitespace(xml[next])) malformed("XML declaration requires whitespace");
    const attributes = [];
    const seen = new Set();
    while (next < xml.length) {
      next = skipWhitespace(next);
      if (xml.startsWith("?>", next)) break;
      const attribute = parseName(next);
      next = skipWhitespace(attribute.end);
      if (xml[next] !== "=") malformed("XML declaration attribute is missing equals");
      next = skipWhitespace(next + 1);
      const parsed = parseQuotedValue(next, { references: false });
      if (seen.has(attribute.name)) malformed("duplicate XML declaration attribute");
      seen.add(attribute.name);
      attributes.push([attribute.name, parsed.value]);
      next = parsed.end;
      if (!isXmlWhitespace(xml[next]) && !xml.startsWith("?>", next)) {
        malformed("XML declaration attributes require whitespace separation");
      }
    }
    if (!xml.startsWith("?>", next)) malformed("unterminated XML declaration");
    const names = attributes.map(([name]) => name);
    const allowedOrders = [
      ["version"],
      ["version", "encoding"],
      ["version", "standalone"],
      ["version", "encoding", "standalone"],
    ];
    if (!allowedOrders.some((order) => order.join("\0") === names.join("\0"))) {
      malformed("XML declaration attributes are missing, unknown, or out of order");
    }
    const values = new Map(attributes);
    if (values.get("version") !== "1.0") malformed("unsupported XML version");
    if (values.has("encoding") && !/^UTF-8$/i.test(values.get("encoding"))) {
      malformed("XML declaration encoding conflicts with UTF-8 bytes");
    }
    if (values.has("standalone") && !/^(?:yes|no)$/.test(values.get("standalone"))) {
      malformed("invalid XML standalone value");
    }
    return next + 2;
  };

  const parseProcessingInstruction = (start) => {
    const target = parseName(start + 2);
    if (target.name.toLowerCase() === "xml") {
      if (target.name !== "xml") malformed("reserved XML processing-instruction target");
      return parseDeclaration(start);
    }
    if (!xml.startsWith("?>", target.end) && !isXmlWhitespace(xml[target.end])) {
      malformed("processing instruction target requires whitespace");
    }
    const end = xml.indexOf("?>", target.end);
    if (end < 0) malformed("unterminated processing instruction");
    return end + 2;
  };

  const parseComment = (start) => {
    const end = xml.indexOf("-->", start + 4);
    if (end < 0) malformed("unterminated comment");
    const content = xml.slice(start + 4, end);
    if (content.includes("--") || content.endsWith("-")) {
      malformed("comment contains or ends with a double-hyphen sequence");
    }
    return end + 3;
  };

  const parseCdata = (start) => {
    if (!stack.length) malformed("CDATA is not allowed outside the root element");
    const end = xml.indexOf("]]>", start + 9);
    if (end < 0) malformed("unterminated CDATA section");
    return end + 3;
  };

  const parseStartTag = (start) => {
    const element = parseName(start + 1);
    if (!stack.length) {
      if (rootSeen) malformed("document contains a second root element");
      rootSeen = true;
    }
    const attributes = new Set();
    let next = element.end;
    let selfClosing = false;
    while (next < xml.length) {
      if (xml[next] === ">") {
        next += 1;
        break;
      }
      if (xml.startsWith("/>", next)) {
        selfClosing = true;
        next += 2;
        break;
      }
      if (!isXmlWhitespace(xml[next])) malformed("attributes require whitespace separation");
      next = skipWhitespace(next);
      if (xml[next] === ">") {
        next += 1;
        break;
      }
      if (xml.startsWith("/>", next)) {
        selfClosing = true;
        next += 2;
        break;
      }
      const attribute = parseName(next);
      if (attributes.has(attribute.name)) malformed("duplicate attribute name");
      attributes.add(attribute.name);
      next = skipWhitespace(attribute.end);
      if (xml[next] !== "=") malformed("attribute is missing equals");
      next = skipWhitespace(next + 1);
      next = parseQuotedValue(next).end;
    }
    if (next > xml.length || xml[next - 1] !== ">") malformed("unterminated start tag");
    if (!selfClosing) stack.push(element.name);
    return next;
  };

  const parseEndTag = (start) => {
    const element = parseName(start + 2);
    const next = skipWhitespace(element.end);
    if (xml[next] !== ">") malformed("end tag contains attributes or is unterminated");
    if (!stack.length || stack.at(-1) !== element.name) malformed("mismatched end tag");
    stack.pop();
    return next + 1;
  };

  const parseCharacterData = (start) => {
    let next = start;
    while (next < xml.length && xml[next] !== "<") {
      if (xml.startsWith("]]>", next)) malformed("CDATA close appears in character data");
      if (!stack.length && !isXmlWhitespace(xml[next])) {
        malformed("non-whitespace character data appears outside the root element");
      }
      if (xml[next] === "&") next = parseReference(next);
      else next += widthAt(next);
    }
    return next;
  };

  while (cursor < xml.length) {
    const before = cursor;
    if (xml[cursor] !== "<") cursor = parseCharacterData(cursor);
    else if (xml.startsWith("<!--", cursor)) cursor = parseComment(cursor);
    else if (xml.startsWith("<![CDATA[", cursor)) cursor = parseCdata(cursor);
    else if (xml.startsWith("<?", cursor)) cursor = parseProcessingInstruction(cursor);
    else if (xml.startsWith("</", cursor)) cursor = parseEndTag(cursor);
    else if (xml.startsWith("<!", cursor)) malformed("DTD and other declarations are not supported");
    else cursor = parseStartTag(cursor);
    if (cursor <= before) malformed("parser made no progress");
  }

  if (stack.length) malformed("unclosed element");
  if (!rootSeen) malformed("document has no root element");
}

// A commented-out declaration is not a declaration. Without this, a package carrying its only
// content-type override or officeDocument relationship inside `<!-- -->` passes every shape check
// and still cannot be opened by a renderer.
function withoutXmlComments(xml) {
  return xml.replaceAll(/<!--[\s\S]*?-->/g, "");
}

// Attribute order is producer-specific: the corpus contains `PartName` first and `ContentType`
// first. Parse each element's attributes rather than matching one fixed order.
function elementAttributes(xml, tagName) {
  const elements = [];
  for (const element of withoutXmlComments(xml).matchAll(new RegExp(`<${tagName}\\b[^>]*>`, "g"))) {
    const attributes = new Map();
    for (const attribute of element[0].matchAll(/([A-Za-z_:][\w.:-]*)\s*=\s*"([^"]*)"/g)) {
      attributes.set(attribute[1], attribute[2]);
    }
    elements.push(attributes);
  }
  return elements;
}

// Exported for the reverse sync, which decodes the same escapes one run at a time instead of one
// paragraph at a time; a second private copy of this table is exactly how the two would drift.
export function xmlUnescape(value) {
  return String(value)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    // Every numeric reference this scanner's own XML check accepts, decoded here rather than
    // carried into a comparison — or into a cv.json — as the literal characters `&`, `#`, digits.
    // `&amp;` stays last, so an escaped `&amp;#233;` decodes to that text and not to its character.
    .replaceAll(/&#(\d{1,7});/g, (reference, digits) => codePointText(Number(digits), reference))
    .replaceAll(/&#x([0-9A-Fa-f]{1,6});/g, (reference, digits) =>
      codePointText(Number.parseInt(digits, 16), reference))
    .replaceAll("&amp;", "&");
}

function codePointText(codePoint, reference) {
  return isXmlChar(codePoint) ? String.fromCodePoint(codePoint) : reference;
}

// A heading may be split across runs, and one role heading can be a strict prefix of another, so
// compare the paragraph's joined text rather than searching for a substring.
function paragraphText(paragraph) {
  return xmlUnescape(
    [...paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((run) => run[1])
      .join(""),
  );
}

/*
 * The parts a WordprocessingML consumer must find to open the document at all. Extra parts,
 * external hyperlink relationships and producer-specific relationship ids are all legitimate and
 * are deliberately not constrained.
 */
function assertPackageShape(parts) {
  const missing = REQUIRED_DOCX_PARTS.filter((part) => !parts.has(part));
  if (missing.length) reject(`required OOXML part is missing: ${missing.join(", ")}`);

  const contentTypes = decodeXmlPart(parts, CONTENT_TYPES_PART);
  const declaresMainDocument = elementAttributes(contentTypes, "Override").some(
    (attributes) =>
      attributes.get("PartName") === `/${MAIN_DOCUMENT_PART}`
      && attributes.get("ContentType") === MAIN_DOCUMENT_CONTENT_TYPE,
  );
  if (!declaresMainDocument) {
    reject(`${CONTENT_TYPES_PART} does not declare the main document content type`);
  }

  const rootRelationships = decodeXmlPart(parts, ROOT_RELATIONSHIPS_PART);
  const resolvesMainDocument = elementAttributes(rootRelationships, "Relationship").some(
    (attributes) => {
      if (attributes.get("Type") !== OFFICE_DOCUMENT_RELATIONSHIP_TYPE) return false;
      if (attributes.get("TargetMode") === "External") return false;
      return (attributes.get("Target") ?? "").replace(/^\/+/, "") === MAIN_DOCUMENT_PART;
    },
  );
  if (!resolvesMainDocument) {
    reject(`${ROOT_RELATIONSHIPS_PART} does not resolve ${MAIN_DOCUMENT_PART}`);
  }

  decodeXmlPart(parts, MAIN_DOCUMENT_RELATIONSHIPS_PART);
  const document = decodeXmlPart(parts, MAIN_DOCUMENT_PART);
  assertWordprocessingDocument(document);
  return document;
}

/*
 * Check the root element itself rather than searching the text for a namespace and a body tag.
 * A part whose root is anything else, or which merely mentions the namespace in a literal, is not
 * a document a renderer can open, however many of the right strings it contains.
 */
function assertWordprocessingDocument(document) {
  const root = withoutXmlComments(document)
    .replaceAll(/<\?[\s\S]*?\?>/g, "")
    .match(/<([A-Za-z_][\w.-]*)(?::([A-Za-z_][\w.-]*))?\b([^>]*)>/);
  if (!root) reject(`${MAIN_DOCUMENT_PART} has no root element`);
  const [, first, second, attributes] = root;
  const prefix = second === undefined ? null : first;
  const localName = second ?? first;
  if (localName !== "document") {
    reject(`${MAIN_DOCUMENT_PART} root element is <${first}>, not a WordprocessingML document`);
  }
  const namespaceAttribute = prefix === null ? "xmlns" : `xmlns:${prefix}`;
  const boundNamespace = attributes.match(
    new RegExp(`\\b${namespaceAttribute}\\s*=\\s*"([^"]*)"`),
  )?.[1];
  if (boundNamespace !== WORDPROCESSING_NAMESPACE) {
    reject(`${MAIN_DOCUMENT_PART} root element is not in the WordprocessingML namespace`);
  }
  const bodyTag = prefix === null ? "body" : `${prefix}:body`;
  const closingTag = prefix === null ? "document" : `${prefix}:document`;
  // Against the comment-stripped copy, like the root check above: a document whose only `<w:body>`
  // sits inside `<!-- -->` is not one a renderer can open, however the raw text reads.
  const uncommented = withoutXmlComments(document);
  if (
    !new RegExp(`<${bodyTag}\\b`).test(uncommented)
    || !new RegExp(`</${closingTag}\\s*>`).test(uncommented)
  ) {
    reject(`${MAIN_DOCUMENT_PART} has no complete document body`);
  }
}

/*
 * OOXML inspection catches invariant layout regressions that screenshots cannot reliably diagnose,
 * while later PNG review covers the visual properties that XML alone cannot prove. Run against the
 * staged cv.json it also proves the package was rendered from that exact cv, not from an earlier
 * revision of it.
 */
function assertLayoutContract(document, cv) {
  const checks = [];

  if (!/<w:pgSz\b[^>]*w:w="12240"[^>]*w:h="15840"/.test(document)) {
    reject("expected US Letter page size (12240 x 15840 twips)");
  }
  checks.push("US Letter page size");

  const marginTag = document.match(/<w:pgMar\b[^>]*>/)?.[0] ?? "";
  for (const side of ["top", "right", "bottom", "left"]) {
    if (!new RegExp(`w:${side}="1080"`).test(marginTag)) {
      reject(`expected 0.75in ${side} margin`);
    }
  }
  checks.push("0.75in margins");

  // Verify the renderer actually emitted the pagination contract for every role, rather than merely
  // trusting the source flags. This protects against docx-library or renderer regressions. Every
  // experience section counts: the renderer emits all of them.
  const roles = (cv?.sections ?? [])
    .filter((section) => section.type === "experience")
    .flatMap((section) => section.roles ?? []);
  const paragraphs = document.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];
  for (const role of roles) {
    const roleHeading = `${role.company} - ${role.title} - ${role.dates}`;
    const paragraph = paragraphs.find((candidate) => paragraphText(candidate) === roleHeading);
    if (!paragraph) reject(`role header is missing from the document: ${role.company}`);
    if (!paragraph.includes("<w:keepNext")) {
      reject(`role header is not protected with keepNext: ${role.company}`);
    }
    if (role.pageBreakBefore && !paragraph.includes("<w:pageBreakBefore")) {
      reject(`requested pageBreakBefore is missing: ${role.company}`);
    }
  }
  // Only claim a check that was actually performed.
  if (roles.length) checks.push(`role-header keepNext (${roles.length})`);

  const explicitBreaks = roles.filter((role) => role.pageBreakBefore).length;
  if (explicitBreaks) checks.push(`${explicitBreaks} explicit role page break(s)`);

  const expectedFont = cv?.font || "Calibri";
  if (!document.includes(`w:ascii="${expectedFont}"`)) {
    reject(`expected font ${expectedFont} not found`);
  }
  checks.push(`font ${expectedFont}`);

  return checks;
}

/*
 * The single entry point. Takes bytes, never a path, so the caller can bind the result to the exact
 * buffer it hashed. Returns the check list the builder reports as `structuralChecks`; throws
 * DocxInspectionError on the first violation.
 *
 * This proves package integrity and the layout contract only. Pagination, visual fidelity and
 * factual quality keep their own explicitly named review gates.
 */
export function inspectDocxBytes(bytes, cv) {
  const { document } = readDocxPackage(bytes);
  return ["ZIP/OOXML package integrity", ...assertLayoutContract(document, cv)];
}

/*
 * The same package integrity and XML well-formedness, without the cv-bound layout contract.
 *
 * The reverse sync cannot use `inspectDocxBytes`: that contract requires every role heading of one
 * cv.json to be present in the document, and a role heading is exactly what the user may have
 * edited. Reading the document is not blessing it — the published DOCX is still the one the builder
 * renders, and this entry point exists so the extractor reads bytes that are at least a readable
 * WordprocessingML package.
 */
export function readDocxPackage(bytes) {
  const parts = readDocxParts(bytes);
  return { parts, document: assertPackageShape(parts) };
}
