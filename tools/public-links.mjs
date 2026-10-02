import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { candidateHeadingAnchors } from "./candidate/manifest.mjs";

// Preserve offsets while omitting fenced blocks and complete single-line code spans.
function renderedLinkText(text) {
  const blank = value => value.replace(/[^\n]/gu, " ");
  let fence = null;
  const prose = text.split("\n").map(line => {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence !== null) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
      return blank(line);
    }
    if (delimiter && (delimiter[1][0] !== "`" || !delimiter[2].includes("`"))) { fence = delimiter[1]; return blank(line); }
    return line;
  }).join("\n");
  // Mask only complete delimiter runs on one line. Multi-line markup stays scanable:
  // without a full block parser, crossing a block boundary could hide a rendered link.
  return prose.replace(/(?<!`)(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/gu, (match, _delimiter, _content, offset) => {
    let escapes = 0;
    for (let index = offset - 1; index >= 0 && prose[index] === "\\"; index -= 1) escapes += 1;
    return escapes % 2 ? match : blank(match);
  });
}

/** Validate the local links that a reader of the public snapshot can follow. */
export function checkPublicLinks({ root, files }) {
  if (files === undefined) {
    files = [];
    const walk = (path) => {
      for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
        const next = path ? `${path}/${entry.name}` : entry.name;
        if ([".git", "node_modules", ".temp-docs"].includes(entry.name) || next === "candidate") continue;
        if (entry.isDirectory()) walk(next);
        else if (entry.isFile() && next.endsWith(".md")) files.push(next);
      }
    };
    walk("");
  }
  const findings = [];
  for (const file of files) {
    const text = renderedLinkText(readFileSync(join(root, file), "utf8"));
    // Definitions are checked too, including a definition no current paragraph uses.
    const links = /!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)|^\s*\[[^\]\n]+\]:\s*(<[^>\n]+>|[^\s]+)/gmu;
    for (const match of text.matchAll(links)) {
      const raw = (match[1] ?? match[2]).replace(/^<|>$/gu, "");
      if (/^[a-z][a-z\d+.-]*:/iu.test(raw) || raw.startsWith("//")) continue;
      const line = text.slice(0, match.index).split("\n").length;
      const fail = (reason) => findings.push({ path: file, line, reason });
      let path, anchor;
      try {
        const hash = raw.indexOf("#");
        path = decodeURIComponent(hash < 0 ? raw : raw.slice(0, hash));
        anchor = hash < 0 ? null : decodeURIComponent(raw.slice(hash + 1));
      } catch { fail("Invalid URL encoding in local link."); continue; }
      if (path.includes("\\") || path.includes(String.fromCharCode(0))) { fail("Invalid local path."); continue; }
      const target = path === "" ? join(root, file) : resolve(dirname(join(root, file)), path);
      const local = relative(root, target).split("\\").join("/");
      if (local === ".." || local.startsWith("../") || local.startsWith("/")) {
        fail("Local link leaves the repository."); continue;
      }
      // A configured layer is optional; its public example owns the promised path/heading parity.
      const actual = local.startsWith("candidate/")
        ? join(root, "candidate.example", local.slice("candidate/".length)) : target;
      if (!existsSync(actual)) {
        fail("Local link target is absent from the public snapshot."); continue;
      }
      let linked = false;
      const parts = relative(root, actual).split("/");
      let current = root;
      for (const part of parts) {
        current = join(current, part);
        if (lstatSync(current).isSymbolicLink()) { linked = true; break; }
      }
      if (linked) { fail("Local link target passes through a symbolic link."); continue; }
      if (anchor && (!lstatSync(actual).isFile() || !candidateHeadingAnchors(readFileSync(actual, "utf8")).has(anchor))) {
        fail("Local heading target does not exist.");
      }
    }
  }
  return findings;
}
