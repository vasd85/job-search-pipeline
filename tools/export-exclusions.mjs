// The paths the public export leaves behind.
//
// Publication is an export of one commit without its history (ADR 0023, decision 1), and four
// kinds of path must not cross: the task files, which do not move at all (decision 2); the
// research and the audits, which are evidence behind decisions a published reader gets from their
// ADRs; the register of product decisions, because the product direction is private; and the
// decision records that decide facts about one person rather than about the engine.
//
// The list itself is data in `config/export-exclusions.json`, so the export tool and the checks
// read the same file rather than each carrying its own copy of the answer. This module owns only
// two things the data cannot state: how a path is matched, and what makes the file well formed.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const EXPORT_EXCLUSIONS_FILE = "config/export-exclusions.json";

export const EXPORT_EXCLUSIONS_SCHEMA_VERSION = 1;

export class ExportExclusionsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExportExclusionsError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ExportExclusionsError(code, message);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEntry(entry, where, { requireKind }) {
  if (!isPlainObject(entry)) fail("export_exclusions_invalid", `${where}: not an object.`);
  const { path, why } = entry;
  if (typeof path !== "string" || path.length === 0) {
    fail("export_exclusions_invalid", `${where}: path is not a non-empty string.`);
  }
  if (path.startsWith("/") || path.includes("..")) {
    fail("export_exclusions_invalid", `${where}: ${path} is not a repository-relative path.`);
  }
  if (typeof why !== "string" || why.length === 0) {
    // A path without a reason is a path nobody can review. The export drops files permanently and
    // the history that would explain the drop is exactly what publication throws away.
    fail("export_exclusions_invalid", `${where}: ${path} carries no reason.`);
  }
  if (!requireKind) return { path, why };
  const { kind } = entry;
  if (kind !== "directory" && kind !== "file") {
    fail("export_exclusions_invalid", `${where}: ${path} has no kind of directory or file.`);
  }
  if (kind === "directory" && !path.endsWith("/")) {
    // The trailing slash is what makes the match a segment boundary rather than a text prefix.
    // Without it `docs/archive` would also swallow a future `docs/archiveX/`.
    fail("export_exclusions_invalid", `${where}: directory ${path} does not end with a slash.`);
  }
  if (kind === "file" && path.endsWith("/")) {
    fail("export_exclusions_invalid", `${where}: file ${path} ends with a slash.`);
  }
  return { path, kind, why };
}

/** Read and validate the list. The root is a parameter: no default reaches an operator's tree. */
export function loadExportExclusions({ root }) {
  const file = resolve(root, EXPORT_EXCLUSIONS_FILE);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail("export_exclusions_unreadable", `${EXPORT_EXCLUSIONS_FILE}: ${error?.message ?? error}`);
  }
  if (!isPlainObject(parsed)) fail("export_exclusions_invalid", "the file is not a JSON object.");
  if (parsed.schema_version !== EXPORT_EXCLUSIONS_SCHEMA_VERSION) {
    // A version this code does not read is a refusal, never a warning: a list written against
    // another schema is not this list with an extra field.
    fail(
      "export_exclusions_schema_version_unsupported",
      `schema_version ${JSON.stringify(parsed.schema_version)} is not `
        + `${EXPORT_EXCLUSIONS_SCHEMA_VERSION}.`,
    );
  }
  if (!Array.isArray(parsed.exclude) || parsed.exclude.length === 0) {
    fail("export_exclusions_invalid", "exclude is not a non-empty array.");
  }
  if (!Array.isArray(parsed.keep)) fail("export_exclusions_invalid", "keep is not an array.");

  const exclude = parsed.exclude.map((entry, index) =>
    readEntry(entry, `exclude[${index}]`, { requireKind: true }));
  const keep = parsed.keep.map((entry, index) =>
    readEntry(entry, `keep[${index}]`, { requireKind: false }));

  for (const [label, entries] of [["exclude", exclude], ["keep", keep]]) {
    const paths = entries.map((entry) => entry.path);
    if (new Set(paths).size !== paths.length) {
      fail("export_exclusions_invalid", `${label} names the same path twice.`);
    }
  }
  // A keep entry that nothing excludes is a reader's trap: it reads as a decision to publish a
  // path that was never in question.
  for (const entry of keep) {
    if (!matchesExclusion(entry.path, exclude)) {
      fail("export_exclusions_invalid", `keep: ${entry.path} is not excluded by anything.`);
    }
  }
  return { exclude, keep };
}

function matchesExclusion(path, exclude) {
  return exclude.some((entry) => (entry.kind === "directory"
    ? path.startsWith(entry.path)
    : path === entry.path));
}

/**
 * Whether the export leaves this repository-relative path behind. A keep entry wins: the list is
 * read as "this whole area stays private, except these named files", which is the safe direction
 * when a new file appears in an excluded area and nobody updates the list.
 */
export function isExcluded(path, { exclude, keep }) {
  if (keep.some((entry) => entry.path === path)) return false;
  return matchesExclusion(path, exclude);
}
