#!/usr/bin/env node
/*
 * cv-builder/render.js — shared CV renderer for the job-search-pipeline.
 *
 * Usage:  node render.js <path/to/cv.json>
 *
 * Reads a per-run content file (the cv.json schema, see README.md), LINTS it for
 * keyboard-only punctuation (generation-rules.md rule 21) and REFUSES to write on any
 * violation, then renders an ATS-safe .docx next to the cv.json. Prints the absolute
 * path of the written file as the final stdout line.
 *
 * All layout/formatting constants (font set, sizes, margins, single-column, bullet style)
 * live HERE — they encode the format budget in knowledge/targeted-cv-playbook.md#7-format-and-content-budget. The per-run cv.json carries
 * only content, never boilerplate. Do not re-implement this per run.
 */
const fs = require("fs");
const path = require("path");
const { Document, Packer, Paragraph, TextRun, ExternalHyperlink, BorderStyle } = require("docx");

// `cv-links.mjs` is an ES module shared with the reverse sync; `main` loads it before `build` runs.
let linkSegments = null;

// ---- formatting constants (tools/cv-builder/README.md#cvjson-schema) --------------------
const ALLOWED_FONTS = ["Calibri", "Arial", "Georgia"]; // pick exactly one per CV
const DEFAULT_FONT = "Calibri";
const pt = (n) => Math.round(n * 2); // docx sizes are in half-points
const SIZE = {
  bodyDefaultPt: 10.5, // 10pt min, 11pt only if it fits (tools/cv-builder/README.md#cvjson-schema)
  bodyMinPt: 10,
  nameDefaultPt: 16,
  nameMinPt: 14,
  nameMaxPt: 18,
  headPt: 12, // 12-14pt bold
};
const PAGE = {
  size: { width: 12240, height: 15840 }, // US Letter
  margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 }, // 0.75in
};

// ---- punctuation lint (generation-rules.md rule 21) -------------------------
// Keyboard-only punctuation: single "-" for every dash, straight quotes only,
// "..." for an ellipsis. The renderer enforces this as a hard gate.
const FORBIDDEN = [
  { re: /—/, name: "em-dash (\\u2014) — use a single hyphen '-'" },
  { re: /–/, name: "en-dash (\\u2013) — use a single hyphen '-'" },
  { re: /--/, name: "double hyphen '--' — use a single hyphen '-'" },
  { re: /[‘’]/, name: "curly single quote — use a straight '" },
  { re: /[“”]/, name: 'curly double quote — use a straight "' },
  { re: /[«»]/, name: 'guillemet (« ») — use a straight "' },
  { re: /…/, name: "ellipsis char (\\u2026) — use '...'" },
];

function lint(node, where, hits) {
  if (typeof node === "string") {
    for (const f of FORBIDDEN) {
      if (f.re.test(node)) {
        hits.push({ where, char: f.name, sample: node.slice(0, 80) });
      }
    }
  } else if (Array.isArray(node)) {
    node.forEach((v, i) => lint(v, `${where}[${i}]`, hits));
  } else if (node && typeof node === "object") {
    for (const k of Object.keys(node)) lint(node[k], where ? `${where}.${k}` : k, hits);
  }
  return hits;
}

// ---- run / paragraph helpers ------------------------------------------------
// Every run goes through here: a link the text states (cv-links.mjs) becomes a hyperlink around
// a run with the same formatting, so the author never marks one. `upper` is the section heading,
// uppercased for display while the target keeps the source spelling.
function runs(text, options, { upper = false } = {}) {
  // A value that is not a string states no link; it renders exactly as it did before links existed.
  if (typeof text !== "string") {
    return [new TextRun({ ...options, text: upper ? String(text).toUpperCase() : text })];
  }
  return linkSegments(text).map((segment) => {
    const display = upper ? segment.text.toUpperCase() : segment.text;
    if (segment.href === null) return new TextRun({ ...options, text: display });
    return new ExternalHyperlink({
      link: segment.href,
      children: [new TextRun({ ...options, text: display, style: "Hyperlink" })],
    });
  });
}

// A "rich" value is either a plain string (one normal run) or an array of run
// atoms {t, b, i} = {text, bold?, italic?}.
function toRuns(value, font, size) {
  const atoms = typeof value === "string" ? [{ t: value }] : value;
  return atoms.flatMap((a) => runs(a.t, { bold: !!a.b, italics: !!a.i, font, size }));
}

function heading(text, font) {
  return new Paragraph({
    // A section heading at the bottom of a page is meaningless without its first content paragraph.
    keepNext: true,
    spacing: { before: 160, after: 60 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "808080", space: 1 } },
    children: runs(text, { bold: true, font, size: pt(SIZE.headPt) }, { upper: true }),
  });
}
function bulletP(value, font, body) {
  return new Paragraph({
    // Keep a single achievement readable as one unit; Word may move the whole bullet to the next page.
    keepLines: true,
    bullet: { level: 0 },
    spacing: { after: 30 },
    children: toRuns(value, font, body),
  });
}
function plainP(text, font, size, after) {
  return new Paragraph({ spacing: { after: after ?? 20 }, children: runs(text, { font, size }) });
}

// ---- build ------------------------------------------------------------------
function build(data) {
  const font = data.font || DEFAULT_FONT;
  if (!ALLOWED_FONTS.includes(font)) {
    throw new Error(
      `font "${font}" not allowed; pick one of ${ALLOWED_FONTS.join(", ")} (tools/cv-builder/README.md#cvjson-schema)`,
    );
  }
  let bodyPt = data.bodySizePt ?? SIZE.bodyDefaultPt;
  if (bodyPt < SIZE.bodyMinPt)
    throw new Error(
      `bodySizePt ${bodyPt} below 10pt minimum (tools/cv-builder/README.md#cvjson-schema)`,
    );
  let namePt = data.nameSizePt ?? SIZE.nameDefaultPt;
  namePt = Math.min(SIZE.nameMaxPt, Math.max(SIZE.nameMinPt, namePt));
  const BODY = pt(bodyPt);
  const children = [];

  // Header (contact in body, never header/footer — knowledge/targeted-cv-playbook.md#7-format-and-content-budget)
  const h = data.header || {};
  if (h.name)
    children.push(
      new Paragraph({
        spacing: { after: 20 },
        children: runs(h.name, { bold: true, font, size: pt(namePt) }),
      }),
    );
  if (h.contact) children.push(plainP(h.contact, font, BODY, 20));
  if (h.positioning) children.push(plainP(h.positioning, font, BODY, 40));

  // Sections
  for (const s of data.sections || []) {
    if (s.heading) children.push(heading(s.heading, font));
    switch (s.type) {
      case "summary":
        children.push(plainP(s.text, font, BODY, 40));
        break;
      case "bullets": // Selected Impact, Projects, ...
        for (const b of s.bullets || []) children.push(bulletP(b, font, BODY));
        break;
      case "skills":
        for (const sk of s.skills || []) {
          children.push(
            new Paragraph({
              spacing: { after: 30 },
              children: [
                ...runs(`${sk.label}: `, { bold: true, font, size: BODY }),
                ...runs(sk.body, { font, size: BODY }),
              ],
            }),
          );
        }
        break;
      case "experience":
        for (const r of s.roles || []) {
          children.push(
            new Paragraph({
              // Normal pagination keeps the role header with what follows. pageBreakBefore is an
              // explicit, role-agnostic escape hatch when the final visual review still finds a bad split.
              keepNext: true,
              pageBreakBefore: !!r.pageBreakBefore,
              spacing: { before: 90, after: 20 },
              children: runs(`${r.company} - ${r.title} - ${r.dates}`, {
                bold: true,
                font,
                size: BODY,
              }),
            }),
          );
          // Chaining keepNext from header -> stack -> first bullet prevents an orphaned role opening.
          if (r.stack)
            children.push(
              new Paragraph({
                keepNext: true,
                spacing: { after: 30 },
                children: runs(r.stack, { italics: true, font, size: BODY }),
              }),
            );
          for (const b of r.bullets || []) children.push(bulletP(b, font, BODY));
        }
        break;
      case "lines": // Education and similar one-line-per-entry blocks
        (s.lines || []).forEach((l, i, arr) =>
          children.push(plainP(l, font, BODY, i === arr.length - 1 ? 40 : 20)),
        );
        break;
      default:
        throw new Error(`unknown section type "${s.type}" (see README.md)`);
    }
  }

  return new Document({
    styles: { default: { document: { run: { font, size: BODY } } } },
    sections: [{ properties: { page: PAGE }, children }],
  });
}

// ---- main -------------------------------------------------------------------
async function main() {
  const cvPath = process.argv[2];
  if (!cvPath) {
    console.error("usage: node render.js <path/to/cv.json>");
    process.exit(2);
  }
  const abs = path.resolve(cvPath);
  const data = JSON.parse(fs.readFileSync(abs, "utf8"));

  const hits = lint(data, "", []);
  if (hits.length) {
    console.error(
      `[cv-builder] punctuation lint FAILED (generation-rules.md rule 21) — file not written:`,
    );
    for (const x of hits) console.error(`  - ${x.where}: ${x.char}\n      "${x.sample}"`);
    process.exit(1);
  }

  if (!data.fileName)
    throw new Error(
      'cv.json must set "fileName" (the candidate config names its pattern: cv.file_name_pattern)',
    );
  const outPath = path.join(path.dirname(abs), data.fileName);
  ({ linkSegments } = await import("./cv-links.mjs"));
  const buf = await Packer.toBuffer(build(data));
  fs.writeFileSync(outPath, buf);
  console.error(`[cv-builder] wrote ${buf.length} bytes`);
  console.log(outPath); // final stdout line = path, consumed by build.sh
}

main().catch((e) => {
  console.error(`[cv-builder] ERROR: ${e.message}`);
  process.exit(1);
});
