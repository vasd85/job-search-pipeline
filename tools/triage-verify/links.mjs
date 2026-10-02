// The links file and the batch range - the two parameters that say what the batch was asked to do.
//
// The list is derived exactly the way `instructions/skills/score-jobs.md` step 1 derives it: trim,
// drop empty lines, deduplicate by full URL, preserve order. Deriving it a second way here would
// make every coverage finding an argument about which list was right.
//
// URLs are untrusted values. They arrive from a file, never from argv, and no message this module
// produces echoes one: a caller error names a line number and nothing else.

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { normalizeVacancyUrl } from "../lib/triage-ledger-core.mjs";
import { fail } from "./errors.mjs";

const MAX_LINKS_FILE_BYTES = 1024 * 1024;
const MAX_LINKS = 4096;

/**
 * Read a links file into ordered, deduplicated entries.
 * Each entry keeps the line it came from so a finding can point at it without quoting it.
 */
export function readLinksFile(path) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    fail("links_path_invalid", "The links file must be given as an absolute path.");
  }
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    fail("links_unreadable", "The links file could not be read.");
  }
  if (bytes.byteLength > MAX_LINKS_FILE_BYTES) {
    fail("links_unreadable", `The links file exceeds ${MAX_LINKS_FILE_BYTES} bytes.`);
  }
  const text = bytes.toString("utf8").replace(/^﻿/u, "");
  const seen = new Set();
  const links = [];
  const lines = text.split(/\r\n|\r|\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    let normalized;
    try {
      normalized = normalizeVacancyUrl(line);
    } catch {
      fail("links_invalid", `Line ${index + 1} of the links file is not an http(s) URL.`);
    }
    links.push({ line: index + 1, url: line, normalizedUrl: normalized });
    if (links.length > MAX_LINKS) {
      fail("links_unreadable", `The links file holds more than ${MAX_LINKS} links.`);
    }
  }
  if (links.length === 0) fail("links_empty", "The links file holds no links.");
  return links;
}

/**
 * The 1-based inclusive slice of the deduplicated list that one batch covers.
 * An out-of-range bound is a caller error: a range nobody can satisfy would otherwise be reported
 * as a batch that lost vacancies.
 */
export function sliceRange(links, from, to) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
    fail("range_invalid", "The batch range must be 1-based with --to not below --from.");
  }
  if (to > links.length) {
    fail("range_invalid", `The batch range ends past the ${links.length} links the file holds.`);
  }
  return links.slice(from - 1, to).map((link, offset) => ({ ...link, position: from + offset }));
}
