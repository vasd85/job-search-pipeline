#!/usr/bin/env node
/*
 * DOCX -> cv.json reverse sync (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#5-edit-channels-and-transports(c), PD-003 point 2 (docs/adr/0015-lightweight-post-review-revision.md#pd-003-the-product-decision-this-record-implements)).
 *
 * The third edit channel: the user edits the published document, and this tool maps those edits
 * back onto the `cv.json` the document was rendered from. The published DOCX stays builder-rendered,
 * so this closes the pair in the one direction the builder cannot.
 *
 * Two rules shape everything below.
 *
 * The committed `cv.json` is the model, never the document. This tool does not read a CV out of the
 * package: it plans the paragraphs `render.js` would have produced from the model, aligns them with
 * the paragraphs the document actually contains, and replaces string values that already exist in
 * the source. Fields the renderer consumes but never prints — `fileName`, `font`, `bodySizePt`,
 * `nameSizePt`, `pageBreakBefore` — therefore survive by construction rather than by a rule someone
 * has to remember.
 *
 * A change is applied only when its inverse is faithful and unique. Everything else is reported as
 * an unmappable finding with its location and left to the user: an uppercased section heading whose
 * source spelling cannot be recovered, a run structure the model cannot address, a paragraph added
 * or removed, punctuation `generation-rules.md` rule 21 forbids. A finding never becomes an edit,
 * and any finding is a nonzero exit — the revision stops until the user resolves it.
 *
 * Node built-ins only, like the shared inspector it seeds on: `docx`/`jszip` live in the gitignored
 * nested `tools/cv-builder/node_modules`, and a package import here would break this tool on a fresh
 * clone. The forward mapping is therefore mirrored from `render.js` rather than imported from it,
 * and the mirror is proven by re-extracting the rebuilt document: drift between the two makes that
 * round trip report changes instead of reporting nothing.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runLinks } from "./cv-links.mjs";
import { readDocxPackage, xmlUnescape } from "./docx-inspector.mjs";

export const EXIT_UNMAPPABLE = 4;

/*
 * A CV is a few pages. These bounds exist because the document is untrusted input, read before any
 * gate has looked at it: a package with a hundred thousand paragraphs would otherwise become an
 * alignment matrix instead of a rejection.
 */
const MAX_BODY_PARAGRAPHS = 4096;
const MAX_ALIGNMENT_CELLS = 4_000_000;
// Body children the model cannot hold are reported one by one, so they need the same bound as the
// paragraphs: a body of tables costs one report entry each, and the report is read by an agent.
const MAX_BODY_BLOCKS = 256;
/*
 * Reading a paragraph rescans the content below each level, so its cost is quadratic in the number
 * of tags it holds — 12000 nested elements is a 1.5 KB package and six seconds, and the inspector's
 * 16 MB part limit allows far more. This is counted before anything descends into it.
 *
 * The bound is generous because the input is by definition a document a word processor has been
 * editing: Word splits a run at every edit session and hangs eight or more property tags off each
 * one, so a heavily revised bullet reaches a few hundred tags where this renderer emits under
 * forty. Refusing one of those would be a false alarm on the channel's normal input; the aggregate
 * stays bounded either way, because a paragraph that large leaves room for proportionally fewer of
 * them inside the same part.
 */
const MAX_PARAGRAPH_TAGS = 2048;
/*
 * The report crosses into an agent's context, so every free-text field it carries is bounded and
 * every list is capped. Without this a 5 KB document of empty tables expands into tens of megabytes
 * of findings — inside the package limits the shared inspector enforces, and past anything a reader
 * can hold.
 */
const MAX_REPORT_TEXT = 1000;
const MAX_REPORT_ENTRIES = 100;

function boundedText(value) {
  const text = String(value);
  return text.length <= MAX_REPORT_TEXT
    ? text
    : `${text.slice(0, MAX_REPORT_TEXT)}... (+${text.length - MAX_REPORT_TEXT} characters)`;
}

function boundedList(entries, kind) {
  if (entries.length <= MAX_REPORT_ENTRIES) return entries;
  return [
    ...entries.slice(0, MAX_REPORT_ENTRIES),
    {
      code: "report_truncated",
      location: "report",
      detail: `${entries.length - MAX_REPORT_ENTRIES} further ${kind} are not listed`,
    },
  ];
}

/*
 * Characters a keyboard does not produce and a reader cannot see. They are not `generation-rules.md`
 * rule 21's list — that one is mirrored verbatim above and belongs to the renderer — but this
 * channel is the first one that can carry a character straight out of a document into `cv.json`,
 * and the user approves the result from a diff in chat. An invisible space, a soft hyphen or a
 * bidirectional override would be approved as text it does not read as.
 */
const UNSUPPORTED_CHARACTERS = [
  { re: /[\t\n\r]/, name: "a tab or line break" },
  { re: /\p{Cc}/u, name: "a control character" },
  // Unicode's own categories rather than a list of the ones somebody remembered: `Cf` covers the
  // soft hyphen, every zero-width character, the word joiner, the Arabic letter mark and the whole
  // bidirectional family, and it keeps covering them as the standard adds more.
  { re: /\p{Cf}/u, name: "an invisible formatting or bidirectional control character" },
  { re: /[\p{Zl}\p{Zp}]/u, name: "a line or paragraph separator" },
  // Every `Zs` except the space itself.
  { re: /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/, name: "a non-breaking or exotic space" },
  { re: /[\ufff9-\ufffd]/, name: "an annotation, object-replacement or replacement character" },
  { re: /\p{Co}/u, name: "a private-use character" },
];

// Mirrored from `render.js`; `tests/docx-extract.test.mjs` pins the two lists against each other,
// because a violation only the renderer knows about is a build failure after the user has already
// been shown a diff.
export const FORBIDDEN_PUNCTUATION = Object.freeze([
  { re: /—/, name: "em-dash (\\u2014) — use a single hyphen '-'" },
  { re: /–/, name: "en-dash (\\u2013) — use a single hyphen '-'" },
  { re: /--/, name: "double hyphen '--' — use a single hyphen '-'" },
  { re: /[‘’]/, name: "curly single quote — use a straight '" },
  { re: /[“”]/, name: "curly double quote — use a straight \"" },
  { re: /[«»]/, name: "guillemet (« ») — use a straight \"" },
  { re: /…/, name: "ellipsis char (\\u2026) — use '...'" },
]);

export class DocxExtractionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DocxExtractionError";
    this.code = code;
  }
}

// ---- XML scanning -----------------------------------------------------------
/*
 * The four required parts are already proven well-formed by the shared inspector, so this scanner
 * only has to walk them. It tracks element depth across every tag rather than searching for a
 * closing name, and it skips quoted attribute values, so a `>` inside an attribute cannot end a tag
 * early.
 */

function tagEnd(xml, start) {
  let quote = null;
  for (let index = start + 1; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index + 1;
  }
  throw new DocxExtractionError("docx_document_unreadable", "an XML tag is unterminated");
}

// `indexOf` returns -1 for an unterminated construct, and -1 plus the closer's length walks the
// cursor backwards into an endless rescan. A caller reading a part the shared inspector already
// proved well-formed never sees this; the exported reader can be handed anything.
function closerEnd(xml, closer, at) {
  const end = xml.indexOf(closer, at);
  if (end < 0) {
    throw new DocxExtractionError("docx_document_unreadable", `an XML ${closer} is unterminated`);
  }
  return end + closer.length;
}

function skipNonElement(xml, at) {
  if (xml.startsWith("<!--", at)) return closerEnd(xml, "-->", at);
  if (xml.startsWith("<![CDATA[", at)) return closerEnd(xml, "]]>", at);
  if (xml.startsWith("<?", at)) return closerEnd(xml, "?>", at);
  if (xml.startsWith("<!", at)) return tagEnd(xml, at);
  return -1;
}

function parseElement(xml, start) {
  const headEnd = tagEnd(xml, start);
  const head = xml.slice(start, headEnd);
  const name = head.match(/^<([^\s/>]+)/)?.[1];
  if (!name) throw new DocxExtractionError("docx_document_unreadable", "an XML tag has no name");
  if (head.endsWith("/>")) return { name, head, inner: "", end: headEnd };

  let depth = 1;
  let cursor = headEnd;
  while (cursor < xml.length) {
    const next = xml.indexOf("<", cursor);
    if (next < 0) break;
    const skipped = skipNonElement(xml, next);
    if (skipped >= 0) {
      cursor = skipped;
      continue;
    }
    const end = tagEnd(xml, next);
    if (xml.startsWith("</", next)) depth -= 1;
    else if (!xml.slice(next, end).endsWith("/>")) depth += 1;
    if (depth === 0) return { name, head, inner: xml.slice(headEnd, next), end };
    cursor = end;
  }
  throw new DocxExtractionError("docx_document_unreadable", `element <${name}> is unclosed`);
}

function childElements(xml) {
  const children = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const next = xml.indexOf("<", cursor);
    if (next < 0) break;
    const skipped = skipNonElement(xml, next);
    if (skipped >= 0) {
      cursor = skipped;
      continue;
    }
    if (xml.startsWith("</", next)) {
      throw new DocxExtractionError("docx_document_unreadable", "an end tag has no start tag");
    }
    const element = parseElement(xml, next);
    children.push(element);
    cursor = element.end;
  }
  return children;
}

/*
 * Attributes are parsed, never searched for. Both quote styles are legal XML and the shared
 * inspector accepts both, so a regex over the tag text reads `w:val="0"` out of a neighbouring
 * attribute's own value — `<w:b w:rsidR=' w:val="0"'/>` is a bold run — and misses every
 * single-quoted declaration outright.
 */
function tagAttributes(head) {
  const attributes = new Map();
  const name = head.match(/^<\/?([^\s/>]+)/);
  if (!name) return attributes;
  let cursor = name[0].length;
  const isSpace = (character) => character === " " || character === "\t"
    || character === "\n" || character === "\r";
  while (cursor < head.length) {
    while (cursor < head.length && isSpace(head[cursor])) cursor += 1;
    const start = cursor;
    while (cursor < head.length && !isSpace(head[cursor]) && head[cursor] !== "=" && head[cursor] !== ">" && head[cursor] !== "/") {
      cursor += 1;
    }
    if (cursor === start) break;
    const attribute = head.slice(start, cursor);
    while (cursor < head.length && isSpace(head[cursor])) cursor += 1;
    if (head[cursor] !== "=") continue;
    cursor += 1;
    while (cursor < head.length && isSpace(head[cursor])) cursor += 1;
    const quote = head[cursor];
    if (quote !== '"' && quote !== "'") break;
    const end = head.indexOf(quote, cursor + 1);
    if (end < 0) break;
    // Last one wins, and it never matters: a duplicate attribute name is not well-formed XML, and
    // the shared inspector rejects the part before this reader sees it. A first-wins guard here
    // would be a branch no input can reach.
    attributes.set(attribute, xmlUnescape(head.slice(cursor + 1, end)));
    cursor = end + 1;
  }
  return attributes;
}

function attributeValue(head, name) {
  return tagAttributes(head).get(name) ?? null;
}

// ---- document paragraphs ----------------------------------------------------

/*
 * Element names carry the namespace prefix the root element binds — `w:` for every producer this
 * repository has seen, but the shared inspector also accepts a default-namespace document. Taking
 * the prefix from the root keeps both readable; a document that rebinds the namespace on inner
 * elements finds no paragraphs at all and is reported as an empty body rather than silently
 * half-read.
 */
function namespacePrefix(document) {
  const root = childElements(document)[0];
  if (!root) {
    throw new DocxExtractionError("docx_document_unreadable", "the document has no root element");
  }
  const parts = root.head.match(/^<([A-Za-z_][\w.-]*)(?::([A-Za-z_][\w.-]*))?/);
  return parts?.[2] === undefined ? "" : `${parts[1]}:`;
}

// Paragraph children that carry no content the model could hold and no edit the user could make.
const IGNORED_PARAGRAPH_CHILDREN = Object.freeze([
  "pPr",
  "bookmarkStart",
  "bookmarkEnd",
  "commentRangeStart",
  "commentRangeEnd",
  "proofErr",
  "permStart",
  "permEnd",
  "lastRenderedPageBreak",
]);

// Run children that are formatting metadata or a rendering hint, not text.
const IGNORED_RUN_CHILDREN = Object.freeze(["rPr", "lastRenderedPageBreak"]);

const TRACKED_CHANGE_ELEMENTS = Object.freeze(["ins", "del", "moveFrom", "moveTo"]);

const RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MAIN_DOCUMENT_RELATIONSHIPS_PART = "word/_rels/document.xml.rels";

/*
 * The main document's relationships by id. A hyperlink names its target only through one of them,
 * and only an external one is a target a renderer would open.
 */
export function readRelationships(xml) {
  const relationships = new Map();
  if (!xml) return relationships;
  const root = childElements(xml)[0];
  if (!root) return relationships;
  for (const child of childElements(root.inner)) {
    if (child.name.replace(/^[^:]*:/, "") !== "Relationship") continue;
    const attributes = tagAttributes(child.head);
    const id = attributes.get("Id");
    if (id === undefined) continue;
    relationships.set(id, {
      target: attributes.get("Target") ?? null,
      external: attributes.get("TargetMode") === "External",
    });
  }
  return relationships;
}

function localName(name, prefix) {
  return prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function toggledOn(properties, prefix, name) {
  const element = childElements(properties)
    .find((child) => localName(child.name, prefix) === name);
  if (!element) return false;
  // `render.js` emits an explicit `w:val="false"` for every unbolded bullet run, so a toggle's
  // presence is not its value.
  const value = attributeValue(element.head, prefix ? `${prefix}val` : "val");
  return !["0", "false", "off"].includes(value ?? "");
}

/*
 * Formatting is read from direct run properties only; this tool resolves no style chain. That is
 * why a formatting difference on text that did not change is a notice rather than a finding: a
 * producer that expressed the same bold through a style would otherwise block every sync.
 */
function readRun(run, prefix, issues) {
  const properties = childElements(run.inner)
    .find((child) => localName(child.name, prefix) === "rPr");
  let text = "";
  for (const child of childElements(run.inner)) {
    const name = localName(child.name, prefix);
    if (IGNORED_RUN_CHILDREN.includes(name)) continue;
    if (name === "t") {
      text += elementText(child.inner, issues);
      continue;
    }
    if (name === "delText") {
      issues.add("tracked_changes");
      continue;
    }
    issues.add("unsupported_run_content");
  }
  return {
    t: text,
    b: properties ? toggledOn(properties.inner, prefix, "b") : false,
    i: properties ? toggledOn(properties.inner, prefix, "i") : false,
  };
}

/*
 * The character data of an element, not the bytes between its tags. A CDATA section, a processing
 * instruction or a nested element inside `<w:t>` is legal XML that the shared inspector accepts and
 * a renderer does not print as text — copying the raw slice would carry `<![CDATA[` and everything
 * inside it into cv.json as literal characters.
 */
function elementText(inner, issues) {
  let text = "";
  let cursor = 0;
  while (cursor < inner.length) {
    const next = inner.indexOf("<", cursor);
    if (next < 0) {
      text += xmlUnescape(inner.slice(cursor));
      break;
    }
    text += xmlUnescape(inner.slice(cursor, next));
    if (inner.startsWith("<![CDATA[", next)) {
      const end = closerEnd(inner, "]]>", next);
      text += inner.slice(next + 9, end - 3);
      cursor = end;
      continue;
    }
    const skipped = skipNonElement(inner, next);
    if (skipped >= 0) {
      cursor = skipped;
      continue;
    }
    issues.add("unsupported_run_content");
    cursor = parseElement(inner, next).end;
  }
  return text;
}

/*
 * Adjacent runs with identical formatting are one atom: producers split runs on spell-check
 * boundaries, language attributes and edit sessions without changing a single character, and an
 * unmerged comparison would report every such re-save as a formatting change.
 */
export function normalizeAtoms(atoms) {
  const merged = [];
  for (const atom of atoms) {
    if (atom.t === "") continue;
    const previous = merged.at(-1);
    if (previous && previous.b === atom.b && previous.i === atom.i) {
      previous.t += atom.t;
      continue;
    }
    merged.push({ t: atom.t, b: atom.b, i: atom.i });
  }
  return merged;
}

/*
 * A rebinding of the prefix this reader resolves names with, anywhere inside the paragraph. Element
 * names are compared as strings here, so `<w:t xmlns:w="urn:other">` is text a renderer would not
 * show and this reader would otherwise carry into cv.json as an ordinary edit.
 *
 * Read from element tags rather than from the paragraph's source, and compared against the URI the
 * root bound: text that merely contains `xmlns:w=`, and a descendant that redeclares the same URI,
 * are both legitimate. Only the active prefix matters — a drawing's own `xmlns:a` changes nothing
 * about what `w:t` means, and the drawing is already content the model cannot hold.
 */
function namespaceDeclaration(prefix) {
  return prefix ? `xmlns:${prefix.slice(0, -1)}` : "xmlns";
}

function rebindsNamespace(element, declaration, boundUri) {
  const pending = [element];
  while (pending.length > 0) {
    const current = pending.pop();
    const declared = attributeValue(current.head, declaration);
    if (declared !== null && declared !== boundUri) return true;
    if (current.inner) {
      for (const child of childElements(current.inner)) pending.push(child);
    }
  }
  return false;
}

/*
 * Where a hyperlink points: the external relationship its `r:id` names, or `#anchor` for a link
 * inside the document. Anything else resolves to null, which the link check reports.
 */
function hyperlinkTarget(head, prefix, namespace) {
  const attributes = tagAttributes(head);
  if (namespace.relationshipsPrefix !== null) {
    const id = attributes.get(`${namespace.relationshipsPrefix}:id`);
    if (id !== undefined) {
      const relationship = namespace.relationships.get(id);
      return relationship?.external && relationship.target ? relationship.target : null;
    }
  }
  const anchor = attributes.get(`${prefix}anchor`);
  return anchor === undefined ? null : `#${anchor}`;
}

function readParagraph(paragraph, prefix, namespace, index) {
  const issues = new Set();
  if (rebindsNamespace(paragraph, namespace.declaration, namespace.uri)) {
    issues.add("unsupported_paragraph_content");
  }
  const properties = childElements(paragraph.inner)
    .find((child) => localName(child.name, prefix) === "pPr");
  const bullet = properties
    ? childElements(properties.inner).some((child) => localName(child.name, prefix) === "numPr")
    : false;

  const atoms = [];
  const links = [];
  let offset = 0;
  // A hyperlink is a container of runs: its runs are text like any other, and its span over the
  // paragraph's joined text is recorded for the link check. Word puts proofing marks and bookmarks
  // inside one, so its children are read by the paragraph's own lists.
  const readChildren = (inner, hyperlink) => {
    for (const child of childElements(inner)) {
      const name = localName(child.name, prefix);
      if (IGNORED_PARAGRAPH_CHILDREN.includes(name)) continue;
      if (name === "r") {
        const atom = readRun(child, prefix, issues);
        atoms.push(atom);
        offset += atom.t.length;
        continue;
      }
      if (TRACKED_CHANGE_ELEMENTS.includes(name)) {
        issues.add("tracked_changes");
        continue;
      }
      if (name === "hyperlink" && !hyperlink) {
        const start = offset;
        readChildren(child.inner, true);
        if (offset === start) continue;
        const target = hyperlinkTarget(child.head, prefix, namespace);
        const previous = links.at(-1);
        // Producers split one link into several wrappers around their own run splits.
        if (previous && previous.end === start && previous.target === target) previous.end = offset;
        else links.push({ start, end: offset, target });
        continue;
      }
      issues.add("unsupported_paragraph_content");
    }
  };
  readChildren(paragraph.inner, false);

  const normalized = normalizeAtoms(atoms);
  return {
    index,
    bullet,
    atoms: normalized,
    text: normalized.map((atom) => atom.t).join(""),
    links,
    issues: [...issues],
  };
}

/*
 * The body's own children: paragraphs in order, plus everything the model has no room for. A table
 * or a content control is reported once, with its position, instead of being walked for text that
 * would then have nowhere to go.
 */
export function readDocumentParagraphs(document, relationships = new Map()) {
  const prefix = namespacePrefix(document);
  const root = childElements(document)[0];
  const declaration = namespaceDeclaration(prefix);
  const relationshipsDeclaration = [...tagAttributes(root.head)]
    .find(([name, value]) => name.startsWith("xmlns:") && value === RELATIONSHIPS_NAMESPACE);
  const namespace = {
    declaration,
    uri: attributeValue(root.head, declaration),
    relationshipsPrefix: relationshipsDeclaration ? relationshipsDeclaration[0].slice(6) : null,
    relationships,
  };
  const body = childElements(root.inner)
    .find((child) => localName(child.name, prefix) === "body");
  if (!body) throw new DocxExtractionError("docx_document_unreadable", "the document has no body");
  // A body that rebinds the prefix is not the body its own name claims, and nothing below it can be
  // resolved by name at all.
  if (rebindsNamespace({ head: body.head, inner: "" }, declaration, namespace.uri)) {
    throw new DocxExtractionError(
      "docx_document_unreadable",
      "the document body rebinds the namespace prefix its element names resolve through",
    );
  }

  const paragraphs = [];
  const blocks = [];
  for (const child of childElements(body.inner)) {
    const name = localName(child.name, prefix);
    if (name === "p") {
      if (paragraphs.length >= MAX_BODY_PARAGRAPHS) {
        throw new DocxExtractionError(
          "docx_document_too_large",
          `the document body holds more than ${MAX_BODY_PARAGRAPHS} paragraphs`,
        );
      }
      const tags = child.inner.split("<").length - 1;
      if (tags > MAX_PARAGRAPH_TAGS) {
        // Named like every other per-paragraph report: a refusal with no location leaves the user
        // nothing to look at in a document of twenty paragraphs.
        throw new DocxExtractionError(
          "docx_document_too_large",
          `document paragraph ${paragraphs.length} holds ${tags} tags, more than the ${MAX_PARAGRAPH_TAGS} a paragraph may carry`,
        );
      }
      paragraphs.push(readParagraph(child, prefix, namespace, paragraphs.length));
      continue;
    }
    if (name === "sectPr") continue;
    if (blocks.length >= MAX_BODY_BLOCKS) {
      throw new DocxExtractionError(
        "docx_document_too_large",
        `the document body holds more than ${MAX_BODY_BLOCKS} elements the model cannot carry`,
      );
    }
    blocks.push({ name, after: paragraphs.length });
  }
  return { paragraphs, blocks };
}

// ---- the model's own paragraphs (mirror of render.js) -----------------------

export function formatPath(path) {
  return path.reduce(
    (rendered, segment) =>
      typeof segment === "number"
        ? `${rendered}[${segment}]`
        : rendered
          ? `${rendered}.${segment}`
          : String(segment),
    "",
  );
}

function sameFormatting(expected, observed) {
  return expected.length === observed.length
    && expected.every((atom, index) => atom.b === observed[index].b && atom.i === observed[index].i);
}

// Identity, not shape: two runs can carry the same formatting sequence and split the same sentence
// at a different word, which is an edit the source may well be able to hold.
function sameAtoms(expected, observed) {
  return sameFormatting(expected, observed)
    && expected.every((atom, index) => atom.t === observed[index].t);
}

function describeAtoms(atoms) {
  return atoms
    .map((atom) => `${atom.b ? "bold" : "plain"}${atom.i ? "+italic" : ""}`)
    .join(" | ") || "empty";
}

function describeParagraph(paragraph) {
  return `${describeAtoms(paragraph.atoms)}${paragraph.bullet ? ", list item" : ""}`;
}

function describeSlot(slot) {
  return `${describeAtoms(slot.atoms)}${slot.bullet ? ", list item" : ""}`;
}

function runFormattingFinding(slot, paragraph) {
  return {
    code: "run_formatting_changed",
    detail:
      `the document's run structure (${describeAtoms(paragraph.atoms)}) no longer matches the `
      + `source's (${describeAtoms(slot.atoms)}); bold and italic carry brief decisions, so this is `
      + "applied to cv.json by hand, never inferred from the document",
  };
}

function slotText(atoms) {
  return atoms.map((atom) => atom.t).join("");
}

// `runTexts` are the texts of the runs `render.js` emits for this paragraph, one per source value,
// so the slot's links are exactly the ones the renderer wrote.
function makeSlot({ runTexts, upper = false, ...slot }) {
  return { ...slot, text: slotText(slot.atoms), links: runLinks(runTexts, { upper }) };
}

function textSlot(kind, path, value, format, { bullet = false } = {}) {
  const addressable = typeof value === "string";
  const atoms = normalizeAtoms([{ t: addressable ? value : "", b: !!format.b, i: !!format.i }]);
  return makeSlot({
    kind,
    path,
    bullet,
    addressable,
    atoms,
    runTexts: addressable ? [value] : [],
    invert(paragraph) {
      if (!addressable) {
        return {
          finding: { code: "value_not_addressable", detail: "the source value is not a string" },
        };
      }
      if (!sameFormatting(atoms, paragraph.atoms)) {
        return { finding: runFormattingFinding(this, paragraph) };
      }
      return { changes: [{ path, before: value, after: paragraph.text }] };
    },
  });
}

function richSlot(path, value, { bullet }) {
  if (typeof value === "string") return textSlot("bullet", path, value, {}, { bullet });
  const atoms = Array.isArray(value)
    ? value.map((atom) => ({
        t: typeof atom?.t === "string" ? atom.t : "",
        b: !!atom?.b,
        i: !!atom?.i,
      }))
    : [];
  const normalized = normalizeAtoms(atoms);
  // Two adjacent source atoms with the same formatting render as one run, so an edit to that run
  // has no unique home in the source. Say so instead of picking one of them.
  const addressable = Array.isArray(value) && normalized.length === atoms.length;
  return makeSlot({
    kind: "bullet",
    path,
    bullet,
    addressable,
    atoms: normalized,
    runTexts: atoms.map((atom) => atom.t),
    invert(paragraph) {
      if (!addressable) {
        return {
          finding: {
            code: "run_atoms_not_addressable",
            detail: "the source run atoms do not map one-to-one onto the document's runs",
          },
        };
      }
      if (!sameFormatting(normalized, paragraph.atoms)) {
        return { finding: runFormattingFinding(this, paragraph) };
      }
      const changes = [];
      paragraph.atoms.forEach((atom, index) => {
        if (atom.t === atoms[index].t) return;
        changes.push({ path: [...path, index, "t"], before: atoms[index].t, after: atom.t });
      });
      return { changes };
    },
  });
}

function skillSlot(path, skill) {
  const label = typeof skill?.label === "string" ? skill.label : null;
  const body = typeof skill?.body === "string" ? skill.body : null;
  const atoms = normalizeAtoms([
    { t: `${label ?? ""}: `, b: true, i: false },
    { t: body ?? "", b: false, i: false },
  ]);
  return makeSlot({
    kind: "skill",
    path,
    bullet: false,
    addressable: label !== null && body !== null,
    atoms,
    runTexts: [`${label ?? ""}: `, body ?? ""],
    invert(paragraph) {
      if (label === null || body === null) {
        return {
          finding: {
            code: "value_not_addressable",
            detail: "the skill label or body is not a string",
          },
        };
      }
      // The renderer emits exactly two runs: a bold `Label: ` and the plain body. An edit that
      // merges or reformats them leaves no separator to split on, and inventing one would move
      // text between two brief-owned fields.
      if (
        paragraph.atoms.length !== 2
        || !paragraph.atoms[0].b
        || paragraph.atoms[0].i
        || paragraph.atoms[1].b
        || paragraph.atoms[1].i
        || !paragraph.atoms[0].t.endsWith(": ")
      ) {
        return {
          finding: {
            code: "skill_line_unparsable",
            detail: "a skills line must stay a bold `Label: ` run followed by the plain body run",
          },
        };
      }
      const changes = [];
      const editedLabel = paragraph.atoms[0].t.slice(0, -2);
      if (editedLabel !== label) {
        changes.push({ path: [...path, "label"], before: label, after: editedLabel });
      }
      if (paragraph.atoms[1].t !== body) {
        changes.push({ path: [...path, "body"], before: body, after: paragraph.atoms[1].t });
      }
      return { changes };
    },
  });
}

const ROLE_FIELDS = Object.freeze(["company", "title", "dates"]);

function roleSlot(path, role) {
  const values = ROLE_FIELDS.map((field) => role?.[field]);
  const addressable = values.every((value) => typeof value === "string");
  const heading = `${values[0]} - ${values[1]} - ${values[2]}`;
  return makeSlot({
    kind: "role",
    path,
    bullet: false,
    addressable,
    atoms: normalizeAtoms([{ t: heading, b: true, i: false }]),
    runTexts: [heading],
    invert(paragraph) {
      if (!addressable) {
        return {
          finding: {
            code: "value_not_addressable",
            detail: "a role heading field is not a string",
          },
        };
      }
      if (!sameFormatting(this.atoms, paragraph.atoms)) {
        return { finding: runFormattingFinding(this, paragraph) };
      }
      /*
       * ` - ` cannot be split on: real dates read `2020 - Present`, so an unedited heading already
       * contains four parts. The model's own three values are the anchors instead — one edited
       * field is recoverable because the other two still bracket it, and an edit that moves two of
       * them at once is reported rather than guessed.
       */
      const observed = paragraph.text;
      const attempts = [
        { field: "dates", prefix: `${values[0]} - ${values[1]} - `, suffix: "" },
        { field: "title", prefix: `${values[0]} - `, suffix: ` - ${values[2]}` },
        { field: "company", prefix: "", suffix: ` - ${values[1]} - ${values[2]}` },
      ];
      // Every reading is collected, not the first one that fits: an edit that puts a ` - ` inside a
      // field — `Senior QA Engineer - Team Lead`, `Example Labs - EU` — reads equally well as an
      // edit of the neighbouring field, and taking whichever attempt happens to come first writes
      // the user's text into a field they did not touch.
      const candidates = [];
      for (const attempt of attempts) {
        if (attempt.prefix.length + attempt.suffix.length > observed.length) continue;
        if (!observed.startsWith(attempt.prefix) || !observed.endsWith(attempt.suffix)) continue;
        const edited = observed.slice(attempt.prefix.length, observed.length - attempt.suffix.length);
        const index = ROLE_FIELDS.indexOf(attempt.field);
        const rebuilt = values
          .map((value, position) => (position === index ? edited : value))
          .join(" - ");
        if (rebuilt !== observed) continue;
        candidates.push({ path: [...path, attempt.field], before: values[index], after: edited });
      }
      if (candidates.length === 1) return { changes: candidates };
      return {
        finding: {
          code: "role_heading_unparsable",
          detail:
            "a role heading renders as `Company - Title - Dates`; this edit "
            + (candidates.length > 1
              ? `reads as an edit of ${candidates.map((candidate) => candidate.path.at(-1)).join(" or of ")}`
              : "moved more than one of the three fields")
            + ", so which text belongs to which field is not recoverable",
        },
      };
    },
  });
}

function headingSlot(path, heading) {
  return makeSlot({
    kind: "heading",
    path,
    bullet: false,
    addressable: false,
    atoms: normalizeAtoms([{ t: String(heading).toUpperCase(), b: true, i: false }]),
    runTexts: [String(heading)],
    upper: true,
    invert() {
      // The renderer uppercases headings, so the document cannot say what the source spelling was.
      // Writing the uppercased text back would silently rewrite the section title's own casing.
      return {
        finding: {
          code: "heading_case_not_invertible",
          detail:
            "section headings render uppercased, so the source spelling cannot be recovered from "
            + "the document; rename a section by editing cv.json directly",
        },
      };
    },
  });
}

/*
 * The paragraph sequence `render.js` produces from a cv.json, in its order. Every branch here
 * mirrors one branch of that renderer's `build`, including which values it skips when they are
 * absent; the round-trip check on the rebuilt document is what proves the mirror still holds.
 */
export function planCvSlots(cv) {
  const slots = [];
  const header = cv?.header ?? {};
  if (header.name) slots.push(textSlot("header", ["header", "name"], header.name, { b: true }));
  if (header.contact) slots.push(textSlot("header", ["header", "contact"], header.contact, {}));
  if (header.positioning) {
    slots.push(textSlot("header", ["header", "positioning"], header.positioning, {}));
  }

  (cv?.sections ?? []).forEach((section, sectionIndex) => {
    const sectionPath = ["sections", sectionIndex];
    if (section.heading) slots.push(headingSlot([...sectionPath, "heading"], section.heading));
    switch (section.type) {
      case "summary":
        slots.push(textSlot("summary", [...sectionPath, "text"], section.text, {}));
        break;
      case "bullets":
        (section.bullets ?? []).forEach((bullet, bulletIndex) => {
          slots.push(richSlot([...sectionPath, "bullets", bulletIndex], bullet, { bullet: true }));
        });
        break;
      case "skills":
        (section.skills ?? []).forEach((skill, skillIndex) => {
          slots.push(skillSlot([...sectionPath, "skills", skillIndex], skill));
        });
        break;
      case "experience":
        (section.roles ?? []).forEach((role, roleIndex) => {
          const rolePath = [...sectionPath, "roles", roleIndex];
          slots.push(roleSlot(rolePath, role));
          if (role.stack) {
            slots.push(textSlot("stack", [...rolePath, "stack"], role.stack, { i: true }));
          }
          (role.bullets ?? []).forEach((bullet, bulletIndex) => {
            slots.push(richSlot([...rolePath, "bullets", bulletIndex], bullet, { bullet: true }));
          });
        });
        break;
      case "lines":
        (section.lines ?? []).forEach((line, lineIndex) => {
          slots.push(textSlot("line", [...sectionPath, "lines", lineIndex], line, {}));
        });
        break;
      default:
        throw new DocxExtractionError(
          "cv_section_type_unknown",
          `cv.json section ${sectionIndex} has unknown type "${section.type}"`,
        );
    }
  });
  return slots;
}

// ---- alignment --------------------------------------------------------------

/*
 * Anchor on the paragraphs that did not change, and treat what lies between two anchors as one
 * region. A region whose two sides have equal counts is a set of in-place edits and is inverted
 * slot by slot; a region whose counts differ is a structural change, and the report names the
 * region rather than guessing which paragraph became which.
 */
export function alignParagraphs(slots, paragraphs) {
  if ((slots.length + 1) * (paragraphs.length + 1) > MAX_ALIGNMENT_CELLS) {
    throw new DocxExtractionError(
      "docx_document_too_large",
      "the document and the CV are too far apart to align",
    );
  }
  const rows = slots.length;
  const columns = paragraphs.length;
  const table = Array.from({ length: rows + 1 }, () => new Int32Array(columns + 1));
  const matches = (slotIndex, paragraphIndex) =>
    slots[slotIndex].bullet === paragraphs[paragraphIndex].bullet
    && slots[slotIndex].text === paragraphs[paragraphIndex].text;

  for (let slotIndex = rows - 1; slotIndex >= 0; slotIndex -= 1) {
    for (let paragraphIndex = columns - 1; paragraphIndex >= 0; paragraphIndex -= 1) {
      table[slotIndex][paragraphIndex] = matches(slotIndex, paragraphIndex)
        ? table[slotIndex + 1][paragraphIndex + 1] + 1
        : Math.max(table[slotIndex + 1][paragraphIndex], table[slotIndex][paragraphIndex + 1]);
    }
  }

  const pairs = [];
  const regions = [];
  let slotIndex = 0;
  let paragraphIndex = 0;
  let regionSlots = [];
  let regionParagraphs = [];
  let anchor = null;

  const closeRegion = (nextAnchor) => {
    if (regionSlots.length || regionParagraphs.length) {
      regions.push({
        slots: regionSlots,
        paragraphs: regionParagraphs,
        before: anchor,
        after: nextAnchor,
      });
      regionSlots = [];
      regionParagraphs = [];
    }
  };

  while (slotIndex < rows && paragraphIndex < columns) {
    if (matches(slotIndex, paragraphIndex)) {
      closeRegion(slots[slotIndex]);
      anchor = slots[slotIndex];
      pairs.push({ slot: slots[slotIndex], paragraph: paragraphs[paragraphIndex] });
      slotIndex += 1;
      paragraphIndex += 1;
      continue;
    }
    if (table[slotIndex + 1][paragraphIndex] >= table[slotIndex][paragraphIndex + 1]) {
      regionSlots.push(slots[slotIndex]);
      slotIndex += 1;
    } else {
      regionParagraphs.push(paragraphs[paragraphIndex]);
      paragraphIndex += 1;
    }
  }
  while (slotIndex < rows) {
    regionSlots.push(slots[slotIndex]);
    slotIndex += 1;
  }
  while (paragraphIndex < columns) {
    regionParagraphs.push(paragraphs[paragraphIndex]);
    paragraphIndex += 1;
  }
  closeRegion(null);

  const unmatched = [];
  for (const region of regions) {
    if (region.slots.length === region.paragraphs.length) {
      region.slots.forEach((slot, index) => {
        pairs.push({ slot, paragraph: region.paragraphs[index] });
      });
      continue;
    }
    unmatched.push(region);
  }
  return { pairs, unmatched };
}

function regionLocation(region) {
  const before = region.before
    ? `after ${formatPath(region.before.path)}`
    : "at the start of the document";
  const after = region.after
    ? `before ${formatPath(region.after.path)}`
    : "at the end of the document";
  return `${before}, ${after}`;
}

// ---- cv.json editing --------------------------------------------------------

function parseJsonWithSpans(text) {
  const spans = new Map();
  let cursor = 0;
  const fail = (reason) => {
    throw new DocxExtractionError("cv_json_unreadable", `${reason} at offset ${cursor}`);
  };
  const whitespace = () => {
    while (cursor < text.length && " \t\n\r".includes(text[cursor])) cursor += 1;
  };
  const parseString = () => {
    const start = cursor;
    if (text[cursor] !== '"') fail("expected a string");
    cursor += 1;
    while (cursor < text.length && text[cursor] !== '"') {
      cursor += text[cursor] === "\\" ? 2 : 1;
    }
    if (text[cursor] !== '"') fail("unterminated string");
    cursor += 1;
    return { start, end: cursor, value: JSON.parse(text.slice(start, cursor)) };
  };
  const parseValue = (path) => {
    whitespace();
    const character = text[cursor];
    if (character === '"') {
      const parsed = parseString();
      spans.set(formatPath(path), { start: parsed.start, end: parsed.end });
      return parsed.value;
    }
    if (character === "{") {
      cursor += 1;
      const object = {};
      whitespace();
      if (text[cursor] === "}") {
        cursor += 1;
        return object;
      }
      for (;;) {
        whitespace();
        const key = parseString().value;
        whitespace();
        if (text[cursor] !== ":") fail("expected a colon");
        cursor += 1;
        object[key] = parseValue([...path, key]);
        whitespace();
        if (text[cursor] === ",") {
          cursor += 1;
          continue;
        }
        if (text[cursor] === "}") {
          cursor += 1;
          return object;
        }
        fail("expected a comma or a closing brace");
      }
    }
    if (character === "[") {
      cursor += 1;
      const array = [];
      whitespace();
      if (text[cursor] === "]") {
        cursor += 1;
        return array;
      }
      for (;;) {
        array.push(parseValue([...path, array.length]));
        whitespace();
        if (text[cursor] === ",") {
          cursor += 1;
          continue;
        }
        if (text[cursor] === "]") {
          cursor += 1;
          return array;
        }
        fail("expected a comma or a closing bracket");
      }
    }
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, cursor)) {
        cursor += literal.length;
        return value;
      }
    }
    const number = text.slice(cursor).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number) fail("unexpected token");
    cursor += number[0].length;
    return Number(number[0]);
  };

  const value = parseValue([]);
  whitespace();
  if (cursor !== text.length) fail("trailing content after the JSON value");
  // The spans are trustworthy only if this scanner read the same document `JSON.parse` reads.
  if (JSON.stringify(value) !== JSON.stringify(JSON.parse(text))) {
    throw new DocxExtractionError(
      "cv_json_unreadable",
      "cv.json did not scan to the value it parses to",
    );
  }
  return { value, spans };
}

function setValueAtPath(root, path, value) {
  const parent = path.slice(0, -1).reduce((node, segment) => node[segment], root);
  parent[path.at(-1)] = value;
}

/*
 * Edits are applied to the committed bytes, not to a re-serialized model: a revision is a point
 * edit, and re-printing the whole file would replace every line of the published source with a
 * formatting difference the user never asked for. Each edit replaces exactly the span of one string
 * literal, and the result is compared against the model those changes describe before it is
 * returned — a span that moved, or an edit that reached anything else, fails here with nothing
 * written.
 */
function applyStringEdits(text, spans, edits, baseValue) {
  const expected = structuredClone(baseValue);
  const replacements = edits.map((edit) => {
    const key = formatPath(edit.path);
    const span = spans.get(key);
    if (!span) {
      throw new DocxExtractionError("cv_json_span_missing", `cv.json has no string value at ${key}`);
    }
    if (JSON.parse(text.slice(span.start, span.end)) !== edit.before) {
      throw new DocxExtractionError(
        "cv_json_span_mismatch",
        `cv.json holds different bytes at ${key} than the change reports`,
      );
    }
    setValueAtPath(expected, edit.path, edit.after);
    return { span, replacement: JSON.stringify(edit.after) };
  });

  const updated = replacements
    .sort((left, right) => right.span.start - left.span.start)
    .reduce(
      (carried, edit) =>
        carried.slice(0, edit.span.start) + edit.replacement + carried.slice(edit.span.end),
      text,
    );
  // A span that moved leaves text that no longer parses, so the guard has to survive its own
  // failure: a raw SyntaxError here would escape as an unhandled parser error instead of the
  // fail-closed refusal this check exists to be.
  let verified = null;
  try {
    verified = JSON.stringify(JSON.parse(updated));
  } catch {
    verified = null;
  }
  if (verified !== JSON.stringify(expected)) {
    throw new DocxExtractionError(
      "cv_json_edit_unsound",
      "the edited cv.json does not match the changes that were reported",
    );
  }
  return updated;
}

// ---- links ------------------------------------------------------------------

function comparableHref(href) {
  try {
    return new URL(href).href;
  } catch {
    return href;
  }
}

/*
 * A scheme-less link the user made clickable by hand: Word's link dialog prepends `http://`, and
 * some producers store the text as typed. Host and path still agree with the derived `https://`
 * target, so the rebuild emits the link the user meant.
 */
function differsOnlyByScheme(expected, target, text) {
  if (target === null || !expected.href.startsWith("https://") || /^https?:\/\//i.test(text)) {
    return false;
  }
  const withoutScheme = target.replace(/^http:\/\//i, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(withoutScheme)) return false;
  return comparableHref(`https://${withoutScheme}`) === comparableHref(expected.href);
}

/*
 * The document's hyperlinks against the links the rebuild will emit. The model holds no link of its
 * own — every link is derived from the text — so a hyperlink the derivation does not produce cannot
 * be carried over and is a finding, and a derived link the document lacks is restored by the rebuild
 * and is a notice. Expected links come from the source while the text is unchanged, and from the
 * document's own runs once it changed, because that text is what the rebuild renders.
 */
function checkLinks(slot, paragraph) {
  const location = formatPath(slot.path);
  const expected = slot.text === paragraph.text || slot.kind === "heading"
    ? slot.links
    : runLinks(paragraph.atoms.map((atom) => atom.t));
  const findings = [];
  const notices = [];
  const accounted = new Set();

  for (const observed of paragraph.links) {
    const text = paragraph.text.slice(observed.start, observed.end);
    const shown = observed.target === null ? "no external target" : JSON.stringify(observed.target);
    const same = expected.find((link) => link.start === observed.start && link.end === observed.end);
    if (same && observed.target !== null
      && comparableHref(same.href) === comparableHref(observed.target)) {
      accounted.add(same);
      continue;
    }
    if (same && differsOnlyByScheme(same, observed.target, text)) {
      accounted.add(same);
      notices.push({
        code: "hyperlink_not_synced",
        location,
        detail: `the document links ${JSON.stringify(text)} to ${shown}; the rebuild links it to `
          + `${JSON.stringify(same.href)}, the same address, so nothing is synced`,
      });
      continue;
    }
    const overlapping = expected.filter(
      (link) => link.start < observed.end && observed.start < link.end,
    );
    if (overlapping.length) {
      for (const link of overlapping) accounted.add(link);
      findings.push({
        code: "hyperlink_target_mismatch",
        location,
        detail: `the document links ${JSON.stringify(text)} to ${shown}, but cv.json derives every `
          + `link from its text and the rebuild links ${overlapping
            .map((link) => JSON.stringify(paragraph.text.slice(link.start, link.end)))
            .join(", ")} to ${overlapping.map((link) => JSON.stringify(link.href)).join(", ")}; `
          + "change the text to the address the link should open, or drop the retarget",
      });
      continue;
    }
    findings.push({
      code: "hyperlink_not_derivable",
      location,
      detail: `the document links ${JSON.stringify(text)} to ${shown}; cv.json turns only a URL `
        + "or an e-mail address written in the text into a link, so write the address into the text "
        + "or drop the link",
    });
  }

  for (const link of expected) {
    if (accounted.has(link)) continue;
    notices.push({
      code: "hyperlink_not_synced",
      location,
      detail: `the document does not link ${JSON.stringify(paragraph.text.slice(link.start, link.end))}; `
        + `every address in a CV renders as a link, so the rebuild links it to ${JSON.stringify(link.href)}`,
    });
  }
  return { findings, notices };
}

// ---- extraction -------------------------------------------------------------

function punctuationProblem(value) {
  return FORBIDDEN_PUNCTUATION.find((forbidden) => forbidden.re.test(value)) ?? null;
}

// Only what the edit introduces. A published CV may legitimately hold one of these already — it is
// the agent's own authored text — and refusing to carry an unrelated edit of that same paragraph
// would report the source's own history as the user's mistake.
function characterProblem(before, after) {
  return UNSUPPORTED_CHARACTERS.find(
    (unsupported) => unsupported.re.test(after) && !unsupported.re.test(before),
  ) ?? null;
}

function commentCount(parts) {
  const comments = parts.get("word/comments.xml");
  if (!comments) return 0;
  // The renderer ships an empty comments part; only real comments are review feedback.
  return (comments.toString("utf8").match(/<(?:[A-Za-z_][\w.-]*:)?comment\b/g) ?? []).length;
}

function issueDetail(issue) {
  switch (issue) {
    case "tracked_changes":
      return "the paragraph carries tracked changes; accept or reject them in the document first, "
        + "because an unresolved revision is not the text the CV would claim";
    case "unsupported_run_content":
      return "a run holds a line break, tab, field or drawing, which the cv.json model cannot carry";
    default:
      return "the paragraph holds structure the cv.json model cannot carry";
  }
}

/*
 * The whole reverse sync as data: what changed, what could not be mapped, what was seen and
 * deliberately not carried over, and the updated source text when every reported change was
 * applied. `updatedText` is the input text itself when nothing mapped, so an unedited document
 * round-trips byte for byte.
 */
export function extractCvEdits(docxBytes, cvText) {
  const { parts, document } = readDocxPackage(docxBytes);
  const { value: cv, spans } = parseJsonWithSpans(cvText);
  const slots = planCvSlots(cv);
  const relationshipsPart = parts.get(MAIN_DOCUMENT_RELATIONSHIPS_PART);
  const relationships = readRelationships(relationshipsPart ? relationshipsPart.toString("utf8") : "");
  const { paragraphs, blocks } = readDocumentParagraphs(document, relationships);

  const edits = [];
  const changes = [];
  const unmappable = [];
  const notices = [];

  for (const block of blocks) {
    unmappable.push({
      code: "unsupported_block",
      location: `document body, after paragraph ${block.after}`,
      detail: `<${block.name}> holds content the cv.json model cannot carry`,
    });
  }
  if (commentCount(parts) > 0) {
    unmappable.push({
      code: "document_comments_present",
      location: "word/comments.xml",
      detail: "the document carries comments; the rebuild drops them, so read them out before it runs",
    });
  }

  const content = paragraphs;

  for (const paragraph of content) {
    for (const issue of paragraph.issues) {
      unmappable.push({
        code: issue,
        location: `document paragraph ${paragraph.index}`,
        detail: issueDetail(issue),
      });
    }
  }

  const { pairs, unmatched } = alignParagraphs(slots, content);

  for (const region of unmatched) {
    if (region.slots.length === 0) {
      // An empty paragraph with no counterpart is an editor's leftover, not content: the model has
      // nowhere to hold it and the rebuild simply will not emit it.
      if (region.paragraphs.every((paragraph) => paragraph.text === "" && !paragraph.issues.length)) {
        for (const paragraph of region.paragraphs) {
          notices.push({
            code: "empty_paragraph_ignored",
            location: `document paragraph ${paragraph.index}`,
            detail: "an empty paragraph has no place in cv.json and is not carried over",
          });
        }
        continue;
      }
      unmappable.push({
        code: "paragraph_added",
        location: regionLocation(region),
        detail: `${region.paragraphs.length} document paragraph(s) have no counterpart in cv.json: `
          + region.paragraphs.map((paragraph) => JSON.stringify(paragraph.text)).join(", "),
      });
      continue;
    }
    if (region.paragraphs.length === 0) {
      unmappable.push({
        code: "paragraph_removed",
        location: regionLocation(region),
        detail: `cv.json still holds ${region.slots.length} paragraph(s) the document dropped: `
          + region.slots.map((slot) => formatPath(slot.path)).join(", "),
      });
      continue;
    }
    unmappable.push({
      code: "unmatched_region",
      location: regionLocation(region),
      detail: `${region.slots.length} source paragraph(s) — `
        + `${region.slots.map((slot) => formatPath(slot.path)).join(", ")} — face `
        + `${region.paragraphs.length} document paragraph(s): `
        + region.paragraphs.map((paragraph) => JSON.stringify(paragraph.text)).join(", "),
    });
  }

  for (const pair of pairs) {
    // A paragraph whose content the model cannot hold has already been reported, and the text read
    // out of it is incomplete by definition — inverting that text would add a second, misleading
    // finding about a difference the first one causes.
    if (pair.paragraph.issues.length) continue;
    // Before every exit below: a retarget made together with a formatting change on unchanged text
    // would otherwise leave through a notice without being looked at.
    const links = checkLinks(pair.slot, pair.paragraph);
    unmappable.push(...links.findings);
    notices.push(...links.notices);
    // The list flag is formatting the source cannot hold on its own: a bullets entry is always
    // rendered as a bullet. It is reported on the same terms as bold and italic — a notice while
    // the text stands, and a refusal to invert once the text moved too, because a paragraph that
    // changed both is no longer obviously the same paragraph.
    const listDiffers = pair.slot.bullet !== pair.paragraph.bullet;
    if (!listDiffers && sameAtoms(pair.slot.atoms, pair.paragraph.atoms)) continue;
    const textUnchanged = pair.slot.text === pair.paragraph.text;
    if (listDiffers) {
      if (textUnchanged) {
        notices.push({
          code: "formatting_not_synced",
          location: formatPath(pair.slot.path),
          detail: `the document formats this paragraph as ${describeParagraph(pair.paragraph)} and `
            + `the source as ${describeSlot(pair.slot)}; the text is unchanged, so nothing is `
            + "synced",
        });
        continue;
      }
      unmappable.push({
        code: "paragraph_kind_changed",
        location: formatPath(pair.slot.path),
        detail: `the document ${pair.paragraph.bullet ? "made this paragraph a list item" : "took this paragraph out of its list"} `
          + "and changed its text; the cv.json model cannot carry the first, so the second is not "
          + "applied either",
      });
      continue;
    }
    const result = pair.slot.invert(pair.paragraph);
    if (result.finding) {
      // Text that did not move cannot be lost by declining to map it: what differs is formatting the
      // source cannot address, and refusing the whole sync over it would block every producer that
      // expresses the same bold through a style this tool does not resolve. It is still reported.
      if (textUnchanged) {
        notices.push({
          code: "formatting_not_synced",
          location: formatPath(pair.slot.path),
          detail: `${result.finding.detail}; the text is unchanged, so nothing is synced`,
        });
        continue;
      }
      unmappable.push({
        code: result.finding.code,
        location: formatPath(pair.slot.path),
        detail: result.finding.detail,
      });
      continue;
    }
    for (const change of result.changes) {
      const forbidden = punctuationProblem(change.after);
      if (forbidden) {
        unmappable.push({
          code: "punctuation_forbidden",
          location: formatPath(change.path),
          detail: `generation-rules.md rule 21 forbids ${forbidden.name}; the renderer refuses that `
            + "text, so the edit needs keyboard-only punctuation before it can be carried over",
        });
        continue;
      }
      const unsupported = characterProblem(change.before, change.after);
      if (unsupported) {
        unmappable.push({
          code: "unsupported_characters",
          location: formatPath(change.path),
          detail: `the edited text carries ${unsupported.name}, which is invisible or reorders what `
            + "a reader sees; retype the fragment before it can be carried over",
        });
        continue;
      }
      edits.push(change);
      changes.push({
        path: formatPath(change.path),
        kind: pair.slot.kind,
        before: change.before,
        after: change.after,
      });
    }
  }

  return {
    // Bounded on the way out, never on the way in: the edits below are applied in full, and only
    // what the reader is shown is capped.
    changes: changes.map((change) => ({
      ...change,
      before: boundedText(change.before),
      after: boundedText(change.after),
    })),
    unmappable: boundedList(
      unmappable.map((finding) => ({ ...finding, detail: boundedText(finding.detail) })),
      "unmappable edits",
    ),
    notices: boundedList(
      notices.map((notice) => ({ ...notice, detail: boundedText(notice.detail) })),
      "notices",
    ),
    updatedText: edits.length ? applyStringEdits(cvText, spans, edits, cv) : cvText,
  };
}

// ---- CLI --------------------------------------------------------------------

function usage() {
  return "Usage: node tools/cv-builder/docx-extract.mjs <edited.docx> --cv <cv.json> "
    + "[--write <cv.json>] [--expect-sha256 <hex>] [--ignore-unmappable]";
}

export function parseArgs(argv) {
  const [docxPath, ...rest] = argv;
  if (!docxPath || docxPath.startsWith("--")) throw new Error(usage());
  const options = {
    docxPath: resolve(docxPath),
    cvPath: null,
    writePath: null,
    expectSha256: null,
    ignoreUnmappable: false,
  };
  for (let index = 0; index < rest.length;) {
    const flag = rest[index];
    if (flag === "--ignore-unmappable") {
      options.ignoreUnmappable = true;
      index += 1;
      continue;
    }
    const value = rest[index + 1];
    if (!["--cv", "--write", "--expect-sha256"].includes(flag)) {
      throw new Error(`Unknown option: ${flag}\n${usage()}`);
    }
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--cv") options.cvPath = resolve(value);
    else if (flag === "--write") options.writePath = resolve(value);
    else options.expectSha256 = value;
    index += 2;
  }
  if (!options.cvPath) throw new Error(`--cv is required\n${usage()}`);
  if (options.writePath !== null && options.writePath !== options.cvPath) {
    throw new Error("--write names the same cv.json as --cv; it updates that file in place");
  }
  if (options.expectSha256 !== null && !/^[0-9a-f]{64}$/.test(options.expectSha256)) {
    throw new Error("--expect-sha256 takes 64 lowercase hexadecimal characters");
  }
  return options;
}

/*
 * The candidate replaces the staged source in place, so the write is a create-then-rename: a
 * torn write would otherwise destroy the base the adoption staged, and the next run would have
 * nothing to align against. A crash between the two leaves the temporary file in the staging
 * directory, where the builder's freshness contract refuses the rebuild until it is cleared.
 */
function writeCvAtomically(targetPath, contents) {
  const temporaryPath = join(dirname(targetPath), `.cv-extract-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    renameSync(temporaryPath, targetPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The failure being reported is the write, not the cleanup of a file that may never exist.
    }
    throw error;
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const docxBytes = readFileSync(options.docxPath);
  if (options.expectSha256) {
    const observed = createHash("sha256").update(docxBytes).digest("hex");
    if (observed !== options.expectSha256) {
      const error = new DocxExtractionError(
        "docx_digest_mismatch",
        `the document is ${observed}, not the expected ${options.expectSha256}`,
      );
      error.exitCode = 1;
      throw error;
    }
  }
  const cvText = readFileSync(options.cvPath, "utf8");
  const { changes, unmappable, notices, updatedText } = extractCvEdits(docxBytes, cvText);

  const blocked = unmappable.length > 0 && !options.ignoreUnmappable;
  let written = null;
  if (options.writePath && !blocked && updatedText !== cvText) {
    writeCvAtomically(options.writePath, updatedText);
    written = options.writePath;
  }

  const report = {
    status: unmappable.length ? "unmappable" : changes.length ? "changed" : "clean",
    docx: options.docxPath,
    docxSha256: createHash("sha256").update(docxBytes).digest("hex"),
    cvJson: options.cvPath,
    changes,
    unmappable,
    notices,
    written,
    // Without this the only signal that findings were dropped on the user's instruction rather than
    // blocking the write is the presence of `written` beside a nonzero exit.
    unmappableIgnored: unmappable.length > 0 && options.ignoreUnmappable,
  };
  console.log(JSON.stringify(report, null, 2));
  if (unmappable.length) {
    const error = new DocxExtractionError(
      "docx_edits_unmappable",
      `${unmappable.length} edit(s) could not be mapped onto cv.json`,
    );
    error.exitCode = EXIT_UNMAPPABLE;
    throw error;
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(`[cv-extract] ${error.message}`);
    process.exitCode = error.exitCode || 1;
  }
}
