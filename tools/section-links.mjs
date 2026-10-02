import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { candidateHeadingAnchors } from "./candidate/manifest.mjs";

const HISTORICAL = [
  "docs/adr/",
  "docs/research/",
  "docs/audits/",
  "docs/backlog/",
  "docs/archive/",
  "reference/",
];
const LOCAL_ROOTS = new Set([
  "candidate",
  "output",
  "triage-batches",
  "telegram-sweeps",
  "records",
  "outbox",
  ".pipeline-input",
  ".rehearsal",
  ".playwright-mcp",
  ".idea",
  ".vscode",
]);
const ROOT_TEXT = new Set([".gitignore", ".gitattributes", ".npmrc"]);
const LOCAL_FILES =
  /^(?:process-log(?:\..*)?|triage-ledger|telegram-sources|telegram-sweep-state|conversations|apply-conversations)\.json$/u;
const TEXT = new Set([
  ".md",
  ".mjs",
  ".js",
  ".cjs",
  ".sh",
  ".json",
  ".yaml",
  ".yml",
  ".html",
  ".py",
  ".ts",
  ".tsx",
  ".jsx",
  ".css",
]);
const NUMBER =
  /\u00a7|(?<![\p{L}\p{N}_-])(?:(?:sub)?sections?\s+|secs?\.\s*|(?:под)?раздел\p{L}*\s+)\d[\d.a-z–-]*/giu;
const LINKS =
  /\]\(([^\s()]*\.md)?#([^\s()]+)\)|(?<![\p{L}\p{N}_/])((?:\.{1,2}\/)*[\p{L}\p{N}_.\/-]+\.md)#([\p{L}\p{N}_%\-]+)|`#([\p{L}\p{N}_%\-]+)`/gu;

/** Active repository text, including new files and hidden instruction/code directories. */
export function sectionSourceFiles(root) {
  const result = [];
  function walk(path) {
    if (!existsSync(join(root, path))) return;
    const info = statSync(join(root, path));
    if (info.isDirectory()) {
      if (
        ["node_modules", ".git", ".temp-docs"].includes(path.split("/").at(-1)) ||
        LOCAL_ROOTS.has(path)
      )
        return;
      for (const entry of readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (!entry.isSymbolicLink()) walk(`${path}/${entry.name}`);
      }
    } else if (
      (TEXT.has(extname(path)) || ROOT_TEXT.has(path) || path.startsWith("tools/git-hooks/")) &&
      !LOCAL_FILES.test(path) &&
      path !== "docs/product-decisions.md" &&
      path !== "config/section-link-exceptions.json" &&
      path !== "config/section-link-source-exceptions.json" &&
      (path === "docs/backlog/README.md" || !HISTORICAL.some((prefix) => path.startsWith(prefix)))
    )
      result.push(path);
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) walk(entry.name);
  }
  return result.sort();
}

// Reference exceptions match complete scanner tokens. A bare layer reference must not mask
// the same substring inside a rooted link, and a short anchor must not mask a longer one.
function referenceOccurrences(source, token) {
  const numbers = source.replace(/\\[nr]/gu, "  ");
  const numberTokens =
    /\u00a7(?:\d[\d.a-z–-]*)?|(?<![\p{L}\p{N}_-])(?:(?:sub)?sections?\s+|secs?\.\s*|(?:под)?раздел\p{L}*\s+)\d[\d.a-z–-]*/giu;
  return [...numbers.matchAll(numberTokens), ...source.matchAll(LINKS)]
    .filter((match) => source.slice(match.index, match.index + match[0].length) === token)
    .map((match) => match.index);
}

/** Exact exceptions mask only their text, preserve offsets and fail closed when stale. */
export function checkSectionLinks({ root, files = sectionSourceFiles(root), exceptions = [] }) {
  const findings = [];
  const cache = new Map();
  const examples = [];
  const texts = new Map(files.map((file) => [file, readFileSync(join(root, file), "utf8")]));
  const report = (file, text, offset, reason) =>
    findings.push({ file, line: text.slice(0, offset).split("\n").length, reason });
  for (const exception of exceptions) {
    const { file, text, count, reason } = exception;
    const source = texts.get(file);
    const offsets =
      source !== undefined && text && exception.kind === "reference"
        ? referenceOccurrences(source, text)
        : null;
    const actual =
      source === undefined || !text ? 0 : (offsets?.length ?? source.split(text).length - 1);
    if (
      !reason ||
      !Number.isInteger(count) ||
      count < 1 ||
      actual !== count ||
      (exception.kind !== undefined && exception.kind !== "reference")
    ) {
      findings.push({
        file,
        line: 1,
        reason: `section-link exception is stale or invalid: ${reason ?? ""} (expected ${count}, found ${actual})`,
      });
      continue;
    }
    if (exception.document) examples.push([exception.document, text, file]);
    const masked = text.replace(/[^\n]/gu, " ");
    let remainder = source;
    if (offsets) {
      for (const offset of offsets)
        remainder = remainder.slice(0, offset) + masked + remainder.slice(offset + text.length);
    } else remainder = source.replaceAll(text, masked);
    texts.set(file, remainder);
  }
  for (const [document, text, sourceFile] of [...texts, ...examples]) {
    const file = sourceFile ?? document;
    // Unwrap quote and comment prefixes without erasing the newline or shifting offsets.
    const scan = text.replace(/^(\s*(?:>|\/\/|\*)\s*)/gmu, (value) =>
      value.replace(/[^\n]/gu, " "),
    );
    const numbers = scan
      .replace(/["']\s*\+\s*["']/gu, (value) => value.replace(/[^\n]/gu, " "))
      .replace(/\\[nr]/gu, "  ");
    for (const match of numbers.matchAll(NUMBER))
      report(file, text, match.index, "names a section by number");
    for (const match of scan.matchAll(LINKS)) {
      const markdown = match[0].startsWith("](");
      const path = match[1] ?? match[3] ?? "";
      if (/^[a-z][a-z\d+.-]*:/iu.test(path) || path.startsWith("//")) continue;
      let anchor;
      try {
        anchor = decodeURIComponent(match[2] ?? match[4] ?? match[5]);
      } catch {
        report(file, text, match.index, "invalid encoded heading anchor");
        continue;
      }
      const base = extname(document) === ".md" || markdown ? dirname(join(root, document)) : root;
      let target = path ? resolve(base, path) : join(root, document);
      // Root-written layer paths resolve on the fictional layer, never on private files.
      if (!markdown && path.startsWith("candidate/")) target = resolve(root, path);
      const local = relative(root, target).split(sep).join("/");
      if (local.startsWith("../") || local === "..") {
        report(file, text, match.index, `heading target leaves the repository: ${path}`);
        continue;
      }
      if (local.startsWith("candidate/"))
        target = join(root, "candidate.example", local.slice("candidate/".length));
      if (path && !markdown && !local.startsWith("candidate/") && !existsSync(target))
        target = resolve(root, path);
      if (!cache.has(target))
        cache.set(
          target,
          existsSync(target) && statSync(target).isFile()
            ? candidateHeadingAnchors(readFileSync(target, "utf8"))
            : null,
        );
      const anchors = cache.get(target);
      if (anchors === null)
        report(file, text, match.index, `heading target does not exist: ${path}`);
      else if (!anchors.has(anchor))
        report(file, text, match.index, `heading target has no #${anchor}: ${path || file}`);
    }
  }
  return findings;
}

/** Exact exceptions for the public tree. */
export function loadSectionExceptions(root) {
  return JSON.parse(readFileSync(join(root, "config/section-link-exceptions.json"), "utf8"));
}
