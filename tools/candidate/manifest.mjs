/**
 * The layer manifest: the files a candidate layer holds, which of them are required, and the headings
 * each markdown file must carry. It lives in the tracked example, `candidate.example/manifest.json`,
 * and is the one contract both directions are checked against:
 *
 * - a present layer carries every file and heading the manifest declares — `checkCandidateLayerParity`,
 *   run last by `inspectCandidateLayer`, so `npm run candidate:check`, `bootstrap --check` and the
 *   pair check of a cutover all refuse a layer that lost one;
 * - every reference a document read by a run makes into the layer, `candidate/<path>` or
 *   `candidate/<path>#<anchor>`, names a file the manifest declares and a heading it declares for
 *   that file, and opens on the example — `checkCandidateLinks`, run by the suite. The same check
 *   reports a section named by its number instead of by a link, and a link to a heading that does
 *   not open, in those documents and in the tool READMEs they name;
 * - the layer's own profile, lever bank, rules and language rules name a section the same way —
 *   `checkCandidateLayerSections`, run by `inspectCandidateLayer` after the parity check.
 *
 * The real layer carries no manifest of its own: it is held to the example's. The path of that file
 * is resolved here, from where this code lies, and the file is read only when a check runs.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateHeadings } from "./documents.mjs";
import { CandidateError } from "./errors.mjs";

export const candidateManifestBasename = "manifest.json";
export const candidateManifestVersion = 1;
// The one placeholder a manifest path may carry: it stands for every configured language, the
// default excluded — the default language has no pack.
export const candidateLanguagePlaceholder = "<language>";

export const candidateManifestErrorCodes = Object.freeze([
  "candidate_layer_file_missing",
  "candidate_layer_heading_missing",
  "candidate_manifest_invalid",
  "candidate_manifest_missing",
  "candidate_section_reference_invalid",
]);

// The documents a run reads: every markdown file under these two directories, and every runbook
// they name.
export const candidateRunDocumentRoots = Object.freeze(["instructions", "knowledge"]);
const RUNBOOK_DIRECTORY = join("docs", "runbooks");
// The layer files whose text names a section: the facts, the levers, the rules and each
// configured language's rules. The letter samples hold letters word for word, and the memory is
// operational notes; neither is read for a section.
const LAYER_SECTION_FILES = Object.freeze(["profile.md", "levers.md", "rules.md"]);

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const ROLE = /^[a-z][a-z_]*$/u;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MANIFEST_HEADING = /^(#{1,6}) (\S(?:.*\S)?)$/u;
const FILE_FIELDS = Object.freeze(["headings", "path", "required", "role"]);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function fail(code, message) {
  throw new CandidateError(code, message);
}

function invalid(message) {
  fail("candidate_manifest_invalid", `the layer manifest ${message}`);
}

/** Where the manifest of this checkout lies: in the tracked example beside the code. */
export function candidateTrackedManifestPath() {
  return join(repoRoot, "candidate.example", candidateManifestBasename);
}

/**
 * A heading's anchor, in GitHub's form: the whole title with its code marks dropped and a link
 * reduced to its text, lower-cased, with every character other than a letter, a mark, a digit, a
 * space, `-` and `_` removed and each space turned into `-`. Repeated hyphens are kept, so
 * `8. Work Approach & Team Style` is `8-work-approach--team-style`.
 */
export function candidateHeadingSlug(title) {
  return title
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N} _-]/gu, "")
    .replace(/ /gu, "-");
}

/**
 * The anchors of every heading of a markdown text. A repeated anchor is numbered as GitHub numbers
 * it: the second `x` is `x-1`, the third `x-2`, skipping any anchor already taken.
 */
export function candidateHeadingAnchors(text) {
  const anchors = new Set();
  const counts = new Map();
  for (const heading of candidateHeadings(text)) {
    const base = candidateHeadingSlug(heading.title);
    let anchor = base;
    let count = counts.get(base) ?? 0;
    while (anchors.has(anchor)) {
      count += 1;
      anchor = `${base}-${count}`;
    }
    counts.set(base, count);
    anchors.add(anchor);
  }
  return anchors;
}

function checkPath(path, where) {
  if (typeof path !== "string" || path.length === 0) invalid(`${where} has no path`);
  for (const segment of path.split("/")) {
    if (segment === candidateLanguagePlaceholder) continue;
    if (!PATH_SEGMENT.test(segment))
      invalid(`${where} has a path segment this reader does not accept: ${segment}`);
  }
}

function parseHeadings(value, path, where) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value))
    invalid(`${where} lists its headings in something other than an array`);
  if (value.length > 0 && !path.endsWith(".md"))
    invalid(`${where} declares headings for a file that is not markdown`);
  const seen = new Set();
  return Object.freeze(
    value.map((text) => {
      const match = typeof text === "string" ? MANIFEST_HEADING.exec(text) : null;
      if (!match) invalid(`${where} declares a heading that is not one: ${JSON.stringify(text)}`);
      if (seen.has(text)) invalid(`${where} declares the heading ${text} twice`);
      seen.add(text);
      return Object.freeze({ level: match[1].length, text, title: match[2] });
    }),
  );
}

/** The manifest's shape, checked: an engine that cannot read its own contract refuses every layer. */
export function parseCandidateManifest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid("is not an object");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "files,manifest_version")
    invalid("must carry manifest_version and files, nothing else");
  if (value.manifest_version !== candidateManifestVersion) {
    invalid(`declares a version this engine does not read; it reads ${candidateManifestVersion}`);
  }
  if (!Array.isArray(value.files) || value.files.length === 0) invalid("lists no files");
  const roles = new Set();
  const paths = new Set();
  const files = value.files.map((entry, index) => {
    const where = `file ${index + 1}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      invalid(`${where} is not an object`);
    const unknown = Object.keys(entry).find((key) => !FILE_FIELDS.includes(key));
    if (unknown !== undefined)
      invalid(`${where} carries a field this reader does not know: ${unknown}`);
    if (typeof entry.role !== "string" || !ROLE.test(entry.role))
      invalid(`${where} has no valid role`);
    if (roles.has(entry.role)) invalid(`declares the role ${entry.role} twice`);
    roles.add(entry.role);
    checkPath(entry.path, `role ${entry.role}`);
    if (paths.has(entry.path)) invalid(`declares the path ${entry.path} twice`);
    paths.add(entry.path);
    if (typeof entry.required !== "boolean")
      invalid(`role ${entry.role} does not say whether it is required`);
    return Object.freeze({
      headings: parseHeadings(entry.headings, entry.path, `role ${entry.role}`),
      path: entry.path,
      required: entry.required,
      role: entry.role,
    });
  });
  return Object.freeze({ files: Object.freeze(files), version: value.manifest_version });
}

/** The manifest at `path`, by default the tracked example's, read and checked. */
export function loadCandidateManifest({ path = candidateTrackedManifestPath() } = {}) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (error?.code === "ENOENT")
      fail(
        "candidate_manifest_missing",
        `the layer manifest is missing: ${candidateManifestBasename}`,
      );
    invalid(`is not readable (${error?.code ?? "unknown"})`);
  }
  if (bytes.length > MAX_MANIFEST_BYTES) invalid("is larger than this reader accepts");
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid("is not valid JSON");
  }
  return parseCandidateManifest(parsed);
}

// The layer-relative paths one manifest entry stands for: itself, or one per configured language.
// With no language list — a caller that injected its own key table — a language entry stands for
// nothing.
function expand(path, languages) {
  if (!path.split("/").includes(candidateLanguagePlaceholder)) return [path];
  return (languages ?? []).map((language) =>
    path
      .split("/")
      .map((segment) => (segment === candidateLanguagePlaceholder ? language : segment))
      .join("/"),
  );
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readText(path, label) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    fail("candidate_document_unreadable", `${label} is not readable (${error?.code ?? "unknown"})`);
  }
  if (bytes.length > MAX_DOCUMENT_BYTES)
    fail("candidate_document_unreadable", `${label} is larger than this reader accepts`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("candidate_document_unreadable", `${label} is not UTF-8 text`);
  }
}

function headingKeys(text) {
  return new Set(candidateHeadings(text).map((heading) => `${heading.level} ${heading.title}`));
}

/**
 * The layer at `root` against `manifest`: every required file is there, and every file that is
 * there carries the headings the manifest declares for it. `languages` names the configured
 * languages the `<language>` entries stand for. The first gap refuses, naming the file and the
 * heading; an optional file that is not there is not a gap.
 */
export function checkCandidateLayerParity({ root, manifest, languages }) {
  for (const file of manifest.files) {
    for (const path of expand(file.path, languages)) {
      const full = join(root, ...path.split("/"));
      if (!isFile(full)) {
        if (!file.required) continue;
        fail(
          "candidate_layer_file_missing",
          `the candidate layer is missing ${path}, which the layer manifest declares`,
        );
      }
      if (file.headings.length === 0) continue;
      const present = headingKeys(readText(full, path));
      const missing = file.headings.find(
        (heading) => !present.has(`${heading.level} ${heading.title}`),
      );
      if (missing !== undefined) {
        fail(
          "candidate_layer_heading_missing",
          `${path} lacks the heading ${missing.text}, which the layer manifest declares`,
        );
      }
    }
  }
}

// A reference into the layer starts at the beginning of a line or after a space, a backtick, a
// quote, `(` or `[`, optionally through `../` steps; so `tools/candidate/README.md` is not one. A
// path segment in angle brackets is a placeholder, and a path whose file name is one —
// `candidate/<file>` — describes the form rather than making a reference, so it is not scanned.
const REFERENCE =
  /(?<=^|[\s`'"(\[])(?:\.\.\/)*candidate\/((?:[A-Za-z0-9_.-]|\/|<[^<>\s/]+>)*)(?:#([A-Za-z0-9_-]+))?/gu;
const FENCE = /^\s*(```|~~~)/u;
const EXAMPLE_NAME = "candidate.example";

// A section named by its number rather than by a link: the sign `§` anywhere, or "section" —
// "subsection" and "Sec." included — or «раздел» in any of its forms, followed by a number. A step
// and a rule are not sections. The word boundary is a look-behind: `\b` knows no Cyrillic letter.
const SECTION_NUMBER =
  /§|(?<![\p{L}\p{N}_-])(?:(?:sub)?sections?\s+|secs?\.\s*|(?:под)?раздел\p{L}*\s+)\d/giu;
// A link to a heading: the target of a markdown link, `<path>.md#<anchor>` or `#<anchor>`; a path
// written in code or in prose, `<path>.md#<anchor>`; and an own anchor in code, `#<anchor>`. The
// anchor is letters, digits, `_` and `-` of any script, so `<anchor>` is a placeholder and not a
// link. A link to a code symbol, `groups.mjs#collectionGroup`, is not one.
const MARKDOWN_SECTION_LINK = /\]\(([^()\s#]*\.md)?#([\p{L}\p{N}_-]+)\)/gu;
const PATH_SECTION_LINK =
  /(?<=^|[\s`'"\[]|(?<!\])\()((?:\.{1,2}\/)*[A-Za-z0-9_][A-Za-z0-9_./-]*\.md)#([\p{L}\p{N}_-]+)/gu;
const OWN_SECTION_CODE = /(?<=`)#([\p{L}\p{N}_-]+)(?=`)/gu;
const LAYER_PATH = /^(?:\.\.\/)*candidate\//u;

// The lines of a text as a section-number scan reads them: a fenced line blanked, and the quote
// marks of a line turned into spaces, so a form broken across two quoted lines still reads as one.
// Every line keeps its length, so an offset still tells its line.
function sectionScanText(text) {
  let fence = null;
  return text
    .split("\n")
    .map((line) => {
      const fenceMatch = FENCE.exec(line);
      if (fenceMatch) {
        if (fence === null) fence = fenceMatch[1];
        else if (line.trim().startsWith(fence)) fence = null;
        return " ".repeat(line.length);
      }
      if (fence !== null) return " ".repeat(line.length);
      return line.replace(/^(?:\s*>)+/u, (marks) => " ".repeat(marks.length));
    })
    .join("\n");
}

function lineAt(text, offset) {
  let line = 1;
  for (
    let index = text.indexOf("\n");
    index !== -1 && index < offset;
    index = text.indexOf("\n", index + 1)
  )
    line += 1;
  return line;
}

/**
 * Every reference into the layer in a markdown text, every line naming the tracked example, every
 * line naming a section by number and every link to a heading, each with its line number. Lines
 * inside a code fence are skipped: a path in a shell command is not a reference. A number form
 * broken across two lines is reported at the first. A reference or a link written as the target of
 * a markdown link says so, `markdownLink`: its path is relative to the document and nothing else.
 */
export function candidateLayerReferencesIn(text) {
  const references = [];
  const exampleMentions = [];
  const sectionLinks = [];
  const scan = sectionScanText(text);
  const sectionNumbers = [
    ...new Set([...scan.matchAll(SECTION_NUMBER)].map((match) => lineAt(scan, match.index))),
  ];
  scan.split("\n").forEach((line, index) => {
    if (line.includes(EXAMPLE_NAME)) exampleMentions.push(index + 1);
    const inMarkdownLink = (offset) => line.slice(Math.max(0, offset - 2), offset) === "](";
    for (const match of line.matchAll(REFERENCE)) {
      // A sentence may end right after a path.
      const path = match[1].replace(/\.+$/u, "");
      if (/(?:^|\/)<[^<>/]+>$/u.test(path)) continue;
      references.push(
        Object.freeze({
          anchor: match[2] ?? null,
          line: index + 1,
          markdownLink: inMarkdownLink(match.index),
          path,
          text: match[0],
        }),
      );
    }
    for (const match of line.matchAll(MARKDOWN_SECTION_LINK)) {
      if ((match[1] ?? "").includes("://")) continue;
      sectionLinks.push(
        Object.freeze({
          anchor: match[2],
          line: index + 1,
          markdownLink: true,
          path: match[1] ?? "",
          text: match[0],
        }),
      );
    }
    for (const match of line.matchAll(PATH_SECTION_LINK)) {
      sectionLinks.push(
        Object.freeze({
          anchor: match[2],
          line: index + 1,
          markdownLink: false,
          path: match[1],
          text: match[0],
        }),
      );
    }
    for (const match of line.matchAll(OWN_SECTION_CODE)) {
      sectionLinks.push(
        Object.freeze({
          anchor: match[1],
          line: index + 1,
          markdownLink: false,
          path: "",
          text: match[0],
        }),
      );
    }
  });
  return Object.freeze({
    exampleMentions: Object.freeze(exampleMentions),
    references: Object.freeze(references),
    sectionLinks: Object.freeze(sectionLinks),
    sectionNumbers: Object.freeze(sectionNumbers),
  });
}

function markdownFilesUnder(directory) {
  if (!isDirectory(directory)) return [];
  const found = [];
  for (const name of readdirSync(directory).sort()) {
    if (name.startsWith(".")) continue;
    const path = join(directory, name);
    if (isDirectory(path)) found.push(...markdownFilesUnder(path));
    else if (name.endsWith(".md")) found.push(path);
  }
  return found;
}

/**
 * The documents a run reads, as paths relative to `root`: every markdown file under
 * `instructions/` and `knowledge/`, and every runbook of `docs/runbooks/` those files name.
 */
export function candidateRunDocuments(root) {
  const documents = candidateRunDocumentRoots.flatMap((directory) =>
    markdownFilesUnder(join(root, directory)),
  );
  const runbooks = new Set();
  for (const document of documents) {
    for (const match of readFileSync(document, "utf8").matchAll(/runbooks\/([a-z0-9-]+\.md)/gu)) {
      const path = join(root, RUNBOOK_DIRECTORY, match[1]);
      if (isFile(path)) runbooks.add(path);
    }
  }
  return Object.freeze(
    [...documents, ...[...runbooks].sort()].map((path) =>
      relative(root, path).split(sep).join("/"),
    ),
  );
}

/**
 * The tool READMEs a run is sent to, as paths relative to `root`: every `tools/<tool>/README.md`
 * one of `documents` names, runbooks included.
 */
export function candidateRunReadmes(root, documents = candidateRunDocuments(root)) {
  const readmes = new Set();
  for (const document of documents) {
    for (const match of readFileSync(join(root, document), "utf8").matchAll(
      /tools\/([a-z0-9-]+)\/README\.md/gu,
    )) {
      if (isFile(join(root, "tools", match[1], "README.md")))
        readmes.add(`tools/${match[1]}/README.md`);
    }
  }
  return Object.freeze([...readmes].sort());
}

// The placeholder a document writes may be spelled in any language; it stands for the manifest's.
function normalizePlaceholders(path) {
  return path
    .split("/")
    .map((segment) => (/^<[^<>]+>$/u.test(segment) ? candidateLanguagePlaceholder : segment))
    .join("/");
}

function resolveReference(reference, { manifest, exampleRoot, languages }) {
  const path = normalizePlaceholders(reference.path);
  if (path === "") {
    return reference.anchor === null ? null : "the layer root has no headings";
  }
  const directory = path.endsWith("/");
  const file = directory ? null : manifest.files.find((entry) => entry.path === path);
  if (
    directory ? !manifest.files.some((entry) => entry.path.startsWith(path)) : file === undefined
  ) {
    return `the layer manifest declares no ${directory ? "directory" : "file"} ${path}`;
  }
  const candidates = expand(directory ? path.slice(0, -1) : path, languages).map((expanded) =>
    join(exampleRoot, ...expanded.split("/")),
  );
  const present = candidates.filter(directory ? isDirectory : isFile);
  if (present.length === 0) return `the example has no ${path}`;
  if (reference.anchor === null) return null;
  if (directory) return "a directory has no headings";
  const declared = file.headings.find(
    (heading) => candidateHeadingSlug(heading.title) === reference.anchor,
  );
  if (declared === undefined)
    return `the layer manifest declares no heading #${reference.anchor} for ${path}`;
  const everywhere = present.every((full) =>
    headingKeys(readText(full, path)).has(`${declared.level} ${declared.title}`),
  );
  return everywhere ? null : `the example's ${path} lacks the heading ${declared.text}`;
}

// Whether a markdown link written in `document` lands in the layer at the root of the checkout. A
// link that climbs to `candidate/` from anywhere else — `tools/<tool>/` to `tools/candidate/` — is a
// link to a file of the repository.
function landsInLayer(root, document, path) {
  const target = resolve(root, dirname(document), path);
  return target.startsWith(join(resolve(root), "candidate") + sep);
}

// The anchors of a file, read once per check.
function anchorsOf(cache, path) {
  if (!cache.has(path))
    cache.set(path, isFile(path) ? candidateHeadingAnchors(readFileSync(path, "utf8")) : null);
  return cache.get(path);
}

// Why a link to a heading does not open, or `null`. `base` is the directory the document lies in;
// `fallbacks` are the roots a path written in code or prose is tried against after it. A markdown
// link is relative to its document and to nothing else, as GitHub opens it.
function sectionLinkFailure(link, { cache, documentPath, base, fallbacks }) {
  const candidates =
    link.path === ""
      ? [documentPath]
      : [
          resolve(base, link.path),
          ...(link.markdownLink ? [] : fallbacks.map((root) => resolve(root, link.path))),
        ];
  const target = candidates.find(isFile);
  if (target === undefined) return `${link.path} names no file`;
  const anchors = anchorsOf(cache, target);
  if (anchors.has(link.anchor)) return null;
  return `#${link.anchor} names no heading of ${link.path === "" ? "this document" : link.path}`;
}

/**
 * Every reference into the layer the documents a run reads make under `root`, each opened on the
 * example at `exampleRoot` through `manifest`, every mention of the tracked example in them, every
 * section they name by number and every link to a heading they make. The tool READMEs those
 * documents name are read for the last two only, and for a layer link with an anchor: a README
 * describes the example and the layer's form. `languages` names the example's configured languages.
 * Returns the
 * references of the run documents and the findings, one per reference or link that does not open,
 * per line that names the example and per line that names a section by number.
 */
export function checkCandidateLinks({ root, exampleRoot, manifest, languages }) {
  const references = [];
  const findings = [];
  const cache = new Map();
  const documents = candidateRunDocuments(root);
  const read = [
    ...documents.map((document) => ({ document, readme: false })),
    ...candidateRunReadmes(root, documents).map((document) => ({ document, readme: true })),
  ];
  for (const { document, readme } of read) {
    const documentPath = join(root, document);
    const scanned = candidateLayerReferencesIn(readFileSync(documentPath, "utf8"));
    const found = readme
      ? []
      : scanned.exampleMentions.map((line) =>
          Object.freeze({ document, line, reason: `a document a run reads names ${EXAMPLE_NAME}` }),
        );
    for (const reference of scanned.references) {
      if (reference.markdownLink && !landsInLayer(root, document, reference.text.split("#")[0]))
        continue;
      if (readme && reference.anchor === null) continue;
      if (!readme) references.push(Object.freeze({ ...reference, document }));
      const reason = resolveReference(reference, { exampleRoot, languages, manifest });
      if (reason !== null)
        found.push(
          Object.freeze({ document, line: reference.line, reason, reference: reference.text }),
        );
    }
    for (const line of scanned.sectionNumbers) {
      found.push(
        Object.freeze({
          document,
          line,
          reason: "a document a run reads names a section by number",
        }),
      );
    }
    for (const link of scanned.sectionLinks) {
      const layer = link.markdownLink
        ? landsInLayer(root, document, link.path)
        : LAYER_PATH.test(link.path);
      if (layer) continue;
      const reason = sectionLinkFailure(link, {
        base: dirname(documentPath),
        cache,
        documentPath,
        fallbacks: [root],
      });
      if (reason !== null)
        found.push(Object.freeze({ document, line: link.line, reason, reference: link.text }));
    }
    // In the order of the document, so a report reads top to bottom.
    findings.push(...found.sort((left, right) => left.line - right.line));
  }
  return Object.freeze({
    findings: Object.freeze(findings),
    references: Object.freeze(references),
  });
}

/**
 * The layer at `root` names a section only by a link that opens: its profile, lever bank, rules and
 * the language rules of each of `languages` carry no section number, and every link to a heading
 * they make opens — inside the layer, relative to the file or written `candidate/<path>`, or into the
 * engine, written from the root of the checkout this code lies in. The first that does not refuses,
 * naming the file, the line and why.
 */
export function checkCandidateLayerSections({ root, languages }) {
  const cache = new Map();
  const files = [
    ...LAYER_SECTION_FILES,
    ...(languages ?? []).map((language) => `languages/${language}/language-rules.md`),
  ];
  for (const file of files) {
    const documentPath = join(root, ...file.split("/"));
    if (!isFile(documentPath)) continue;
    const scanned = candidateLayerReferencesIn(readText(documentPath, file));
    const number = scanned.sectionNumbers[0];
    const failures =
      number === undefined ? [] : [{ line: number, reason: "names a section by number" }];
    for (const link of scanned.sectionLinks) {
      const inLayer = !link.markdownLink && LAYER_PATH.test(link.path);
      const reason = sectionLinkFailure(
        inLayer ? { ...link, path: link.path.replace(LAYER_PATH, "") } : link,
        {
          base: inLayer ? root : dirname(documentPath),
          cache,
          documentPath,
          fallbacks: [repoRoot],
        },
      );
      if (reason !== null) failures.push({ line: link.line, reason });
    }
    const first = failures.sort((left, right) => left.line - right.line)[0];
    if (first !== undefined) {
      fail(
        "candidate_section_reference_invalid",
        `${file} line ${first.line}: ${first.reason}; a section is named by a link to its heading`,
      );
    }
  }
}
