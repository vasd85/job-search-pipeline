// What must not cross into a published tree, and where the answer to that comes from.
//
// Publication is an export of one commit without its history (ADR 0023, decision 1). "Ready to
// publish" has to be a measurable state of the tree rather than a reading somebody did once, and
// this module owns the half of that measurement which can live in the open.
//
// Two sources, and the split is the whole point. The markers below name nothing about any person:
// a mail address, a home directory, a vacancy link, a path that does not survive the move. They
// ship with the engine. The markers that name one candidate — a surname, a handle, an employer, a
// country from his constraints — cannot ship, because printed in the open they would reveal
// exactly what they hide; they live in the candidate layer and reach this code as data.
//
// No marker here names a language. The engine knows one language by name, its default
// (ADR 0023, decision 6), so the Cyrillic class is written as a script property and the paths
// whose text of a configured language is data come from the layer with the personal markers.
//
// The production CLI scans every tracked public path.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const CANDIDATE_MARKERS_FILE = "publishability-markers.json";

export const CANDIDATE_MARKERS_SCHEMA_VERSION = 1;

/**
 * The four finding classes. A class is the code a finding carries; the unit a reader acts on is
 * the marker, and below that the file.
 */
export const PUBLISHABILITY_CLASSES = Object.freeze([
  "personal_marker",
  "shared_template",
  "private_path",
  "cyrillic_prose",
]);

/**
 * Marker sources are never their own findings under a public marker.
 *
 * This file carries the patterns it searches for, the scanner carries the Cyrillic property, the
 * README describes both in words and the suite freezes them a second time. Without this rule the
 * gate reports itself on every run. The alternative — assembling the matching strings from pieces,
 * by constructing a NUL byte — was rejected: a NUL cannot be written
 * into source at all, whereas these can, and a frozen expectation spelled `'Cyr' + 'illic'` stops
 * being something a reader can check by eye, which is the only reason the second literal exists.
 *
 * The same rule reaches one more file, by name rather than by path: the layer's own
 * `publishability-markers.json`, wherever a copy of it sits. It is a marker source by definition,
 * and the tracked example is the copy a scan of this tree actually meets.
 *
 * The rule binds the public markers only. The personal markers read these paths like any other,
 * because a real markers file copied over the tracked example, or a real name pasted into a test,
 * is a leak the public patterns cannot see and the export must refuse.
 *
 * Cost, stated rather than discovered later: a public template leaking inside these paths — an
 * address, a home directory — is invisible to the gate. It is bounded by what lives there:
 * patterns and tests, no candidate fact.
 */
export const MARKER_SOURCE_PATHS = Object.freeze([
  "tools/publishability/",
  "tests/publishability.test.mjs",
]);

/**
 * Every marker the public engine ships, frozen as a literal.
 *
 * `template.*` are the leaks that are leaks whoever they belong to. `path.*` are references to
 * paths that do not cross the border: the task files, which do not move at all (ADR 0023,
 * decision 2), the archive, the research, the audits, the register of product decisions, and a
 * path into the candidate layer, which an outside reader's clone does not have. `text.cyrillic`
 * is the language axis written without naming a language.
 *
 * `path.candidate` requires a segment after the directory name. The layer's own name appears in
 * prose that documents the contract — `.gitignore`, the root README, the layer's own reader — and
 * a bare name is a statement about where the layer goes, not a pointer into its content. Measured
 * on main `ac6c8ca`: the bare form matches 23 lines of the exported tree, the form below 5.
 */
export const PUBLIC_MARKERS = Object.freeze([
  Object.freeze({
    id: "template.email",
    class: "shared_template",
    // `example.` is excluded because RFC 2606 reserves it for documentation, so an address there
    // is a leak of nothing. `.test` and the `user:pw@host` form inside a URL are not excluded by
    // the pattern: they are named per file below, where a reader can see what was waived.
    pattern: /[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u,
    why: "A mail address in the text of a published file reaches whoever reads it.",
  }),
  Object.freeze({
    id: "template.home-path",
    class: "shared_template",
    pattern: /\/Users\/[a-z0-9_.-]+/u,
    why: "A home directory names the account that ran the command.",
  }),
  Object.freeze({
    id: "template.hh-vacancy",
    class: "shared_template",
    pattern: /hh\.ru\/vacancy/u,
    why: "A vacancy link is a record of one application, not engine documentation.",
  }),
  Object.freeze({
    id: "path.backlog",
    class: "private_path",
    pattern: /(?<![\w./-])docs\/backlog\//u,
    why: "Task files do not move to the new repository (ADR 0023, decision 2).",
  }),
  Object.freeze({
    id: "path.archive",
    class: "private_path",
    pattern: /(?<![\w./-])docs\/archive\//u,
    why: "Closed tasks and archived campaign plans stay behind with the history.",
  }),
  Object.freeze({
    id: "path.research",
    class: "private_path",
    pattern: /(?<![\w./-])docs\/research\//u,
    why: "Research is not exported; a published document names the study in words.",
  }),
  Object.freeze({
    id: "path.audits",
    class: "private_path",
    pattern: /(?<![\w./-])docs\/audits\//u,
    why: "Audits are not exported; a published document names the audit in words.",
  }),
  Object.freeze({
    id: "path.product-decisions",
    class: "private_path",
    pattern: /(?<![\w./-])docs\/product-decisions\.md/u,
    why: "The product direction is private; an accepted decision is published through its ADR.",
  }),
  Object.freeze({
    id: "path.candidate",
    class: "private_path",
    pattern: /(?<![\w./-])candidate\/[A-Za-z0-9_.-]/u,
    why: "A path into the private layer, which an outside reader's clone does not have.",
  }),
  Object.freeze({
    id: "text.cyrillic",
    class: "cyrillic_prose",
    // A script property rather than a letter range: `[А-Яа-яЁё]` misses every other Cyrillic
    // letter, and naming the language would break decision 6 of ADR 0023.
    pattern: /\p{Script=Cyrillic}/u,
    why: "Public documents are written in the default language (ADR 0023, decision 4).",
  }),
]);

/**
 * Places a public marker is allowed to match, by marker and path. A path ending in a slash is a
 * directory and matches on a segment boundary.
 *
 * Not by line number, deliberately. A number goes stale on any edit above it, and then the
 * allowance misses and the gate reports a place it had already cleared. Every waiver the
 * personalization inventory recorded as "keep" was whole-file anyway.
 *
 * The key is the pair, never the path alone: one line can match two markers with two different
 * verdicts, and a path-only key would silence the second one too.
 *
 * Cost, stated: the widest of these covers a file of more than 1900 lines, so a genuine address
 * added to it later is not reported under this marker. It is bounded by the classes being
 * independent — a waived template never silences a personal marker on the same line.
 */
export const PUBLIC_ALLOWANCES = Object.freeze([
  Object.freeze({
    marker: "template.email",
    path: "tests/job-source-registry.test.mjs",
    why: "Synthetic addresses in the reserved .test domain and the user@host form inside a URL.",
  }),
  Object.freeze({
    marker: "template.email",
    path: "tests/job-source-routes.test.mjs",
    why: "Synthetic addresses in the reserved .test domain and the user@host form inside a URL.",
  }),
  Object.freeze({
    marker: "template.email",
    path: "tests/telegram-collect.test.mjs",
    why: "Synthetic addresses in the reserved .test domain and the user@host form inside a URL.",
  }),
  Object.freeze({
    marker: "template.email",
    path: "tools/telegram-collect/fixtures/",
    why: "Addresses inside captured pages kept as fixtures.",
  }),
  Object.freeze({
    marker: "template.email",
    path: "tools/vacancy-fetch/fixtures/",
    why: "Addresses inside captured pages kept as fixtures.",
  }),
  Object.freeze({
    marker: "template.home-path",
    path: "tests/libreoffice-backend.test.mjs",
    why: "Invented home paths in fixtures.",
  }),
  Object.freeze({
    marker: "template.home-path",
    path: "tests/process-log-v3-validation.test.mjs",
    why: "Invented home paths in fixtures.",
  }),
  Object.freeze({
    marker: "template.hh-vacancy",
    path: "tests/process-log-core.test.mjs",
    why: "A synthetic URL of a supported source, not a link to an application.",
  }),
  Object.freeze({
    marker: "template.hh-vacancy",
    path: "tests/vacancy-fetch.test.mjs",
    why: "A synthetic URL of a supported source, not a link to an application.",
  }),
  Object.freeze({
    marker: "path.backlog",
    path: "tests/board.test.mjs",
    why: "The suite of that tool builds an old repository and the private one from their real paths.",
  }),
  Object.freeze({
    marker: "path.archive",
    path: "tests/board.test.mjs",
    why: "The suite of that tool builds an old repository and the private one from their real paths.",
  }),
  Object.freeze({
    marker: "path.research",
    path: "tests/board.test.mjs",
    why: "The suite of that tool builds an old repository and the private one from their real paths.",
  }),
  Object.freeze({
    marker: "path.audits",
    path: "tests/board.test.mjs",
    why: "The suite of that tool builds an old repository and the private one from their real paths.",
  }),
  Object.freeze({
    marker: "path.product-decisions",
    path: "tests/board.test.mjs",
    why: "The suite of that tool builds an old repository and the private one from their real paths.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tests/board.test.mjs",
    why: "The suite of that tool builds an old repository and the private one from their real paths.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tools/candidate/README.md",
    why: "The layer's own contract states where its config file goes.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "knowledge/precedence.md",
    why: "The precedence map names the layer as the owner of configured values.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tools/letter-corrections/README.md",
    why: "The corpus tool documents that its corpus lives in the layer.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "instructions/skills/write-cover-letter.md",
    why: "The skill names where the correction corpus is read from.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tools/letter-corrections/fixtures/",
    why: "A fixture record carries a source reference of the same shape a real one has.",
  }),
  Object.freeze({
    marker: "path.archive",
    path: "tests/section-links.test.mjs",
    why: "Exact transition/checker mechanism or its synthetic fixture names predecessor paths to move or reject them.",
  }),
  Object.freeze({
    marker: "path.archive",
    path: "tools/ci.mjs",
    why: "Exact transition/checker mechanism or its synthetic fixture names predecessor paths to move or reject them.",
  }),
  Object.freeze({
    marker: "path.archive",
    path: "tools/section-links.mjs",
    why: "Exact transition/checker mechanism or its synthetic fixture names predecessor paths to move or reject them.",
  }),
  Object.freeze({
    marker: "path.audits",
    path: "tests/section-links.test.mjs",
    why: "Exact transition/checker mechanism or its synthetic fixture names predecessor paths to move or reject them.",
  }),
  Object.freeze({
    marker: "path.audits",
    path: "tools/ci.mjs",
    why: "Exact transition/checker mechanism or its synthetic fixture names predecessor paths to move or reject them.",
  }),
  Object.freeze({
    marker: "path.audits",
    path: "tools/section-links.mjs",
    why: "Exact transition/checker mechanism or its synthetic fixture names predecessor paths to move or reject them.",
  }),
  Object.freeze({
    marker: "path.backlog",
    path: "config/section-link-exceptions.json",
    why: "Exact transition/checker mechanism or its synthetic fixture names predecessor paths to move or reject them.",
  }),
  Object.freeze({
    marker: "path.backlog",
    path: "docs/adr/0014-development-backlog-replaces-remediation-queue.md",
    why: "Historical pre-switch route named as a contract; private predecessor material is not linked or needed by a public clone.",
  }),
  Object.freeze({
    marker: "path.backlog",
    path: "docs/adr/0022-three-lanes-derived-from-the-diff.md",
    why: "Historical pre-switch route named as a contract; private predecessor material is not linked or needed by a public clone.",
  }),
  Object.freeze({
    marker: "path.backlog",
    path: "docs/adr/0024-two-repositories-one-snapshot.md",
    why: "Historical pre-switch route named as a contract; private predecessor material is not linked or needed by a public clone.",
  }),
  Object.freeze({
    marker: "path.backlog",
    path: "instructions/operating-contract.md",
    why: "Historical pre-switch route named as a contract; private predecessor material is not linked or needed by a public clone.",
  }),
  Object.freeze({
    marker: "path.backlog",
    path: "knowledge/precedence.md",
    why: "Historical pre-switch route named as a contract; private predecessor material is not linked or needed by a public clone.",
  }),
  Object.freeze({
    marker: "path.backlog",
    path: "tests/ci.test.mjs",
    why: "Exact transition/checker mechanism or its synthetic fixture names predecessor paths to move or reject them.",
  }),
  Object.freeze({
    marker: "path.backlog",
    path: "tests/section-links.test.mjs",
    why: "Exact transition/checker mechanism or its synthetic fixture names predecessor paths to move or reject them.",
  }),
  Object.freeze({
    marker: "path.backlog",
    path: "tools/ci.mjs",
    why: "Exact transition/checker mechanism or its synthetic fixture names predecessor paths to move or reject them.",
  }),
  Object.freeze({
    marker: "path.backlog",
    path: "tools/section-links.mjs",
    why: "Exact transition/checker mechanism or its synthetic fixture names predecessor paths to move or reject them.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "config/section-link-exceptions.json",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "docs/runbooks/operational-backup.md",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "docs/runbooks/ops-cutover.md",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "docs/runbooks/triage-review.md",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "instructions/operating-contract.md",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "instructions/skills/generate-cv.md",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "instructions/skills/get-vacancy.md",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "instructions/skills/map-experience.md",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "instructions/skills/research-company.md",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "instructions/skills/score-jobs.md",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "knowledge/cover-letter-playbook.md",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "knowledge/generation-rules.md",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "knowledge/impact-levers.md",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "knowledge/job-match-rules.md",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "knowledge/targeted-cv-playbook.md",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tests/application-brief.test.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tests/candidate.test.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tests/file-backed-pipeline-e2e.test.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tests/fixtures/process-log-v3.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tests/instruction-contracts.test.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tests/operational-backup.test.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tests/ops-tree.test.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tests/process-log-v3-revision.test.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tests/process-search-application-brief-view.test.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tests/public-links.test.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tests/section-links.test.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tests/write-guard.test.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tools/application-brief/README.md",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tools/application-brief/fixtures/application-brief.v4.valid.json",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tools/application-brief/shape-example.json",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tools/candidate/constraints.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tools/candidate/documents.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tools/candidate/languages.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tools/cv-builder/README.md",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tools/job-scorer/iso-3166.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tools/operational-backup.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tools/ops-tree/README.md",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tools/ops-tree/manifest.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tools/pretriage/composition.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.candidate",
    path: "tools/public-links.mjs",
    why: "Documented layer contract or synthetic fixture path, resolved against the tracked fictional layer; no private file is read by CI.",
  }),
  Object.freeze({
    marker: "path.product-decisions",
    path: "tests/section-links.test.mjs",
    why: "Exact transition/checker mechanism or its synthetic fixture names predecessor paths to move or reject them.",
  }),
  Object.freeze({
    marker: "path.product-decisions",
    path: "tools/ci.mjs",
    why: "Exact transition/checker mechanism or its synthetic fixture names predecessor paths to move or reject them.",
  }),
  Object.freeze({
    marker: "path.product-decisions",
    path: "tools/section-links.mjs",
    why: "Exact transition/checker mechanism or its synthetic fixture names predecessor paths to move or reject them.",
  }),
  Object.freeze({
    marker: "path.research",
    path: "tests/section-links.test.mjs",
    why: "Exact transition/checker mechanism or its synthetic fixture names predecessor paths to move or reject them.",
  }),
  Object.freeze({
    marker: "path.research",
    path: "tools/ci.mjs",
    why: "Exact transition/checker mechanism or its synthetic fixture names predecessor paths to move or reject them.",
  }),
  Object.freeze({
    marker: "path.research",
    path: "tools/section-links.mjs",
    why: "Exact transition/checker mechanism or its synthetic fixture names predecessor paths to move or reject them.",
  }),
]);

/**
 * Matches a public marker is allowed to make in a piece of text that has no path — a commit
 * message, and whatever else a caller scans as text.
 *
 * One entry, and it is not a preference. Every commit of this repository carries the attribution
 * trailer required of the runtime that wrote it, and measured over the whole history that trailer
 * accounts for 1256 of 1256 matches of the address template: without this the check would report a
 * finding on every commit, and in blocking mode it would refuse almost every commit there is.
 *
 * The waiver is the exact literal, never "strip the trailer block": a stripped block is a place a
 * real leak could then hide in.
 */
export const PUBLIC_TEXT_ALLOWANCES = Object.freeze([
  Object.freeze({
    marker: "template.email",
    text: "noreply@anthropic.com",
    why: "The attribution trailer every commit of this repository is required to carry.",
  }),
]);

/**
 * Every key the layer's markers file may carry. `purpose` is prose for whoever opens the file and
 * is read by nobody.
 */
export const CANDIDATE_MARKERS_KEYS = Object.freeze([
  "allow",
  "cyrillic_data",
  "markers",
  "purpose",
  "schema_version",
]);

export class PublishabilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PublishabilityError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PublishabilityError(code, message);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Long enough for any marker a person writes by hand, short enough that a pathological expression
// cannot be pasted in whole. The file is the operator's own, so this is a guard against a mistake,
// not against an attacker.
const MAX_PATTERN_LENGTH = 512;
const MAX_MARKERS_FILE_BYTES = 256 * 1024;

function readPath(value, where) {
  if (typeof value !== "string" || value.length === 0) {
    fail("publishability_markers_invalid", `${where}: path is not a non-empty string.`);
  }
  if (value.startsWith("/") || value.includes("..")) {
    fail("publishability_markers_invalid", `${where}: ${value} is not a repository-relative path.`);
  }
  return value;
}

function readWhy(value, where) {
  if (typeof value !== "string" || value.length === 0) {
    // A waiver nobody can review is a waiver nobody will ever narrow again.
    fail("publishability_markers_invalid", `${where}: carries no reason.`);
  }
  return value;
}

function compilePattern(source, where) {
  if (typeof source !== "string" || source.length === 0) {
    fail("publishability_markers_invalid", `${where}: pattern is not a non-empty string.`);
  }
  if (source.length > MAX_PATTERN_LENGTH) {
    fail("publishability_markers_invalid", `${where}: pattern is longer than this reader accepts.`);
  }
  try {
    return new RegExp(source, "u");
  } catch (error) {
    fail(
      "publishability_markers_invalid",
      `${where}: pattern does not compile (${error?.message ?? error}).`,
    );
  }
  return null;
}

/**
 * The personal half of the contract, as the candidate layer states it.
 *
 * Three things come from here and from nowhere else: the markers that name this candidate, the
 * places those markers are allowed to match, and the paths whose text of a configured language is
 * data rather than prose. All three are values of one person's configuration, which is why the
 * public tree states the parameter and the layer supplies it.
 */
export function validateCandidateMarkers(parsed, { where = CANDIDATE_MARKERS_FILE } = {}) {
  if (!isPlainObject(parsed))
    fail("publishability_markers_invalid", `${where}: not a JSON object.`);
  if (parsed.schema_version !== CANDIDATE_MARKERS_SCHEMA_VERSION) {
    // A version this code does not read is a refusal, never a warning.
    fail(
      "publishability_markers_schema_version_unsupported",
      `${where}: schema_version ${JSON.stringify(parsed.schema_version)} is not ` +
        `${CANDIDATE_MARKERS_SCHEMA_VERSION}.`,
    );
  }
  // Both directions, and the reason is asymmetric. A key the schema does not know is usually a
  // key the writer misspelled, and a misspelled `markers` would leave the personal set empty — a
  // clean report nobody earned, which is the one outcome this check exists to prevent.
  for (const key of Object.keys(parsed)) {
    if (!CANDIDATE_MARKERS_KEYS.includes(key)) {
      fail("publishability_markers_invalid", `${where}: ${key} is not a key of this schema.`);
    }
  }
  if (!Array.isArray(parsed.markers) || parsed.markers.length === 0) {
    fail("publishability_markers_invalid", `${where}: markers is not a non-empty array.`);
  }
  if (!Array.isArray(parsed.allow ?? [])) {
    fail("publishability_markers_invalid", `${where}: allow is not an array.`);
  }
  if (!Array.isArray(parsed.cyrillic_data ?? [])) {
    fail("publishability_markers_invalid", `${where}: cyrillic_data is not an array.`);
  }

  const markers = parsed.markers.map((entry, index) => {
    const at = `${where}: markers[${index}]`;
    if (!isPlainObject(entry)) fail("publishability_markers_invalid", `${at}: not an object.`);
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      fail("publishability_markers_invalid", `${at}: id is not a non-empty string.`);
    }
    if (PUBLIC_MARKERS.some((marker) => marker.id === entry.id)) {
      // A layer marker shadowing a public one would silently change what the engine's own contract
      // means, and the report would name one id for two different patterns.
      fail("publishability_markers_invalid", `${at}: ${entry.id} is already a public marker.`);
    }
    return Object.freeze({
      class: "personal_marker",
      id: entry.id,
      pattern: compilePattern(entry.pattern, at),
      // Required here for the same reason it is required of a waiver: a marker nobody can read a
      // reason for is a marker nobody will ever narrow or retire.
      why: readWhy(entry.why, at),
    });
  });
  const ids = markers.map((marker) => marker.id);
  if (new Set(ids).size !== ids.length) {
    fail("publishability_markers_invalid", `${where}: markers name the same id twice.`);
  }

  const known = new Set([...ids, ...PUBLIC_MARKERS.map((marker) => marker.id)]);
  const allow = (parsed.allow ?? []).map((entry, index) => {
    const at = `${where}: allow[${index}]`;
    if (!isPlainObject(entry)) fail("publishability_markers_invalid", `${at}: not an object.`);
    if (!known.has(entry.marker)) {
      // An allowance for a marker nobody declared silences nothing and reads as protection.
      fail(
        "publishability_markers_invalid",
        `${at}: ${JSON.stringify(entry.marker)} is not a declared marker.`,
      );
    }
    return Object.freeze({
      marker: entry.marker,
      path: readPath(entry.path, at),
      why: readWhy(entry.why, at),
    });
  });

  const cyrillicData = (parsed.cyrillic_data ?? []).map((entry, index) => {
    const at = `${where}: cyrillic_data[${index}]`;
    if (!isPlainObject(entry)) fail("publishability_markers_invalid", `${at}: not an object.`);
    return Object.freeze({ path: readPath(entry.path, at), why: readWhy(entry.why, at) });
  });

  return Object.freeze({ allow, cyrillicData, markers });
}

/**
 * The layer's markers file. The root is a parameter and has no default here, the same rule
 * `tools/candidate/load.mjs` carries: a reader that knew where the layer lives would read the
 * operator's real candidate from a test.
 */
export function loadCandidateMarkers({ root }) {
  if (typeof root !== "string" || root.length === 0) {
    fail("publishability_markers_root_invalid", "candidate root must be a non-empty string.");
  }
  const file = resolve(root, CANDIDATE_MARKERS_FILE);
  let bytes;
  try {
    bytes = readFileSync(file, "utf8");
  } catch (error) {
    fail(
      "publishability_markers_unreadable",
      `${CANDIDATE_MARKERS_FILE}: ${error?.message ?? error}`,
    );
  }
  if (Buffer.byteLength(bytes, "utf8") > MAX_MARKERS_FILE_BYTES) {
    fail(
      "publishability_markers_unreadable",
      `${CANDIDATE_MARKERS_FILE}: larger than this reader accepts.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch (error) {
    fail(
      "publishability_markers_invalid",
      `${CANDIDATE_MARKERS_FILE}: not valid JSON (${error?.message ?? error}).`,
    );
  }
  return validateCandidateMarkers(parsed);
}

/** Whether a repository-relative path is covered by an allowance path (file or directory form). */
export function coversPath(allowancePath, path) {
  return allowancePath.endsWith("/") ? path.startsWith(allowancePath) : path === allowancePath;
}

/**
 * Whether this path is a marker source, and therefore never read by a public marker.
 *
 * The named paths are one half. The other is any file called `publishability-markers.json`,
 * wherever it sits: that file is a marker source by definition, and the tracked example is the
 * copy the scan actually meets. Found the hard way — the example was green only while it was
 * still untracked, and committing it made every one of its own patterns a finding.
 */
export function isMarkerSource(path) {
  if (path === CANDIDATE_MARKERS_FILE || path.endsWith(`/${CANDIDATE_MARKERS_FILE}`)) return true;
  return MARKER_SOURCE_PATHS.some((entry) => coversPath(entry, path));
}
