// The scan itself: markers over a set of files, and markers over a piece of text.
//
// Neither entry point knows where anything lives. The root, the file list, the markers and the
// predicate that says whether a path is exported all arrive as parameters, which is what lets the
// suite prove the scan on a disposable tree instead of on this repository.
//
// The matching is done in this process rather than by `git grep -P`, and that is a measurement
// rather than a preference. The gate hands its children a scrubbed environment with no locale, so
// `LC_CTYPE` is `C`, and under it `git grep -P '\p{Cyrillic}'` reports zero files where the truth
// is 81. A scanner built on it would have declared the tree clean. `git` is asked for the file
// list and nothing else, which no locale changes.
//
// A finding carries a path, a line number and a marker id, never the matched text. A report that
// quoted its matches would itself become the thing the gate looks for, and a report gets pasted
// into places the tree never reaches.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PublishabilityError, coversPath, isMarkerSource } from "./markers.mjs";

const MAX_SCANNED_FILE_BYTES = 8 * 1024 * 1024;

function fail(code, message) {
  throw new PublishabilityError(code, message);
}

/**
 * The allowances that apply to one path, as a set of marker ids.
 *
 * The key is the pair (marker, path): one line can match two markers whose verdicts differ, and a
 * path-only key would silence both.
 */
function allowedMarkersFor(path, allow) {
  const allowed = new Set();
  for (const entry of allow) if (coversPath(entry.path, path)) allowed.add(entry.marker);
  return allowed;
}

function emptyTally() {
  return { excluded: 0, exported: 0, total: 0 };
}

function addTo(tally, exported) {
  tally.total += 1;
  if (exported) tally.exported += 1;
  else tally.excluded += 1;
}

/**
 * Read one tracked file as text, or `null` when there is no file there at all.
 *
 * Absence is the one skip, and it is counted and reported rather than quiet: a path git lists with
 * nothing on disk is an ordinary state mid-edit, and nothing can hide in a file that does not
 * exist. Every other way of failing to read one is a refusal — a NUL byte, a size over the budget,
 * a directory where a file belongs, an unreadable entry — because each of those is content this
 * scan did not inspect, and a scan that skips content reports a clean tree it never read.
 *
 * One of those refusals is reachable without any mistake: a submodule's gitlink, or a symbolic
 * link to a directory, is a path git lists and `readFileSync` answers with `EISDIR`. This tree has
 * neither today, and a repository that grows one has to say what the scan should do about it
 * rather than have this reader decide quietly.
 */
function readText(absolute, path) {
  let bytes;
  try {
    bytes = readFileSync(absolute);
  } catch (error) {
    // A tracked path with no file is an ordinary state mid-edit — deleted and not yet staged — and
    // there is nothing there for a leak to hide in. Skipped and counted rather than refused, so
    // the gate does not die on a state no other stage reacts to; every other way of not reading a
    // file is still a refusal, because those have content this scan failed to inspect.
    // `EISDIR` is deliberately not here: a directory where a file belongs is present and
    // unreadable, which is a refusal, not an absence.
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    fail("publishability_file_unreadable", `${path}: ${error?.message ?? error}`);
  }
  if (bytes.length > MAX_SCANNED_FILE_BYTES) {
    fail("publishability_file_unreadable", `${path}: larger than this scanner reads.`);
  }
  if (bytes.includes(0)) {
    fail("publishability_file_not_text", `${path}: not UTF-8 text.`);
  }
  return bytes.toString("utf8");
}

/**
 * Scan a set of repository-relative paths.
 *
 * `cyrillicData` names the paths whose text of a configured language is data rather than prose;
 * it comes from the candidate layer, so a run without the layer has none and says so instead of
 * showing a count it did not earn.
 *
 * A line matching several markers is one place and one entry per marker, the reading the
 * personalization inventory used: without it the sum over markers has nothing it can be checked
 * against.
 */
export function scanTree({
  allow = [],
  cyrillicData = [],
  isExported = () => true,
  markers,
  paths,
  root,
}) {
  if (!Array.isArray(markers) || markers.length === 0) {
    fail("publishability_scan_invalid", "the scan needs at least one marker.");
  }
  if (!Array.isArray(paths)) fail("publishability_scan_invalid", "paths is not an array.");
  if (typeof root !== "string" || root.length === 0) {
    fail("publishability_scan_invalid", "root must be a non-empty string.");
  }
  const dataPaths = cyrillicData.map((entry) => entry.path);
  const byMarker = new Map(markers.map((marker) => [marker.id, emptyTally()]));
  const byClass = new Map();
  for (const marker of markers)
    if (!byClass.has(marker.class)) byClass.set(marker.class, emptyTally());
  const files = [];
  const findings = [];
  const absent = [];
  // A marker source no loaded marker applies to is stepped over before anything is read, so it is
  // not a file this scan inspected either. Counted apart from `absent`, which is a path with
  // nothing behind it.
  let skipped = 0;
  let places = 0;
  // Counted apart, because this is the number a verdict may key on: a line in a file the export
  // leaves behind never reaches a published tree, so it must not refuse a commit.
  let placesExported = 0;

  for (const path of paths) {
    const allowed = allowedMarkersFor(path, allow);
    const isData = dataPaths.some((entry) => coversPath(entry, path));
    const source = isMarkerSource(path);
    const applicable = markers.filter(
      (marker) =>
        !allowed.has(marker.id) &&
        // The data allowance is a property of one class: a file whose Cyrillic is data is still
        // searched for every personal marker and every shared template it may carry.
        !(isData && marker.class === "cyrillic_prose") &&
        // A marker source carries the public patterns by design, so no public marker reads it; see
        // `MARKER_SOURCE_PATHS`. The personal markers still do: a real markers file copied over the
        // tracked example is exactly the leak the export gate exists to refuse.
        !(source && marker.class !== "personal_marker"),
    );
    if (source && applicable.length === 0) {
      skipped += 1;
      continue;
    }
    const exported = Boolean(isExported(path));
    const text = readText(resolve(root, path), path);
    if (text === null) {
      absent.push(path);
      continue;
    }
    const lines = text.split("\n");
    const perMarker = new Map();

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      let matchedHere = false;
      for (const marker of applicable) {
        if (!marker.pattern.test(line)) continue;
        matchedHere = true;
        addTo(byMarker.get(marker.id), exported);
        addTo(byClass.get(marker.class), exported);
        perMarker.set(marker.id, (perMarker.get(marker.id) ?? 0) + 1);
        findings.push({ class: marker.class, exported, line: index + 1, marker: marker.id, path });
      }
      if (matchedHere) {
        places += 1;
        if (exported) placesExported += 1;
      }
    }
    if (perMarker.size > 0) {
      files.push({
        exported,
        markers: Object.fromEntries([...perMarker.entries()].sort()),
        path,
        total: [...perMarker.values()].reduce((sum, count) => sum + count, 0),
      });
    }
  }

  files.sort((left, right) => right.total - left.total || left.path.localeCompare(right.path));
  return {
    absent,
    byClass: Object.fromEntries([...byClass.entries()].sort()),
    byMarker: Object.fromEntries([...byMarker.entries()].sort()),
    files,
    findings,
    places,
    placesExported,
    scanned: paths.length - absent.length - skipped,
    skipped,
  };
}

/**
 * Scan a piece of text that has no path — a commit message, and whatever else a caller hands over.
 *
 * Two consumers, which is why this is a function rather than a branch inside the commit-message
 * mode: this tool's own `--commit-msg`, and the pre-push of the private board, which scans an
 * outgoing diff and its messages.
 *
 * Allowances here are keyed by the exact matched literal, because there is no path to key them by.
 */
export function scanText({ markers, text, textAllow = [] }) {
  if (!Array.isArray(markers) || markers.length === 0) {
    fail("publishability_scan_invalid", "the scan needs at least one marker.");
  }
  if (typeof text !== "string") fail("publishability_scan_invalid", "text is not a string.");
  const byMarker = new Map(markers.map((marker) => [marker.id, 0]));
  const byClass = new Map(markers.map((marker) => [marker.class, 0]));
  const findings = [];
  const lines = text.split("\n");
  // Counted the same way the tree scan counts it — lines carrying at least one match — so the one
  // field name does not mean two different things to the two callers of this function.
  let places = 0;

  for (let index = 0; index < lines.length; index += 1) {
    let matchedHere = false;
    for (const marker of markers) {
      const waived = textAllow
        .filter((entry) => entry.marker === marker.id)
        .map((entry) => entry.text);
      // The waiver removes its exact literal and scans what is left, so a line that carries both
      // the waived text and a real match still reports the real one.
      const line = waived.reduce((rest, literal) => rest.split(literal).join(""), lines[index]);
      if (!marker.pattern.test(line)) continue;
      matchedHere = true;
      byMarker.set(marker.id, byMarker.get(marker.id) + 1);
      byClass.set(marker.class, byClass.get(marker.class) + 1);
      findings.push({ class: marker.class, line: index + 1, marker: marker.id });
    }
    if (matchedHere) places += 1;
  }
  return {
    byClass: Object.fromEntries([...byClass.entries()].sort()),
    byMarker: Object.fromEntries([...byMarker.entries()].sort()),
    findings,
    places,
  };
}
