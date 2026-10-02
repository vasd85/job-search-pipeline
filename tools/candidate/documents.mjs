/**
 * The four documents of the candidate layer and the form each must have: the profile, the lever
 * bank, the rules and the letter samples.
 *
 * Their content is one person's and lives in the layer; their form is the engine's and lives here.
 * Public rules name a profile section by a link to its heading (`manifest.mjs`), never by the number
 * this map gives it, and a lever by a property this file declares, never by a person's fact, so the
 * map is what makes those references resolve for any candidate. The tracked example is checked
 * against it by the suite and the real layer by `npm run candidate:check`.
 *
 * Headings are English in every layer, whatever language the prose under them is in: a public
 * document points at a private one by heading, so the heading is part of the contract and the prose
 * is not.
 *
 * Every function here is pure. Reading a layer from disk, with the root rules that go with it, is
 * `load.mjs`.
 */

import { CandidateError } from "./errors.mjs";

export const candidateProfileBasename = "profile.md";
export const candidateLeversBasename = "levers.md";
export const candidateLetterSamplesBasename = "letter-samples.md";
export const candidateRulesBasename = "rules.md";

// The repository-relative path an application brief and the process log record as the source of a
// fact. It names the layer of the checkout a run happens in, never the tracked example.
export const candidateProfileSourcePath = "candidate/profile.md";
export const candidateLeversSourcePath = "candidate/levers.md";
export const candidateRulesSourcePath = "candidate/rules.md";

export const candidateProfileSchemaVersion = 2;
export const candidateProjectVisibilities = Object.freeze(["private", "public"]);
export const candidateLeverProperties = Object.freeze(["ai-infrastructure", "ai-practice"]);
export const candidateRulesSchemaVersion = 1;

// The read points of the candidate's rules: one per skill that reads them, named as the skill is.
// A rule's `Scope:` names points from this list, and each skill names its own point in the
// sentence that says where it reads the rules.
export const candidateRuleScopes = Object.freeze([
  "generate-cv",
  "get-vacancy",
  "map-experience",
  "research-company",
  "score-jobs",
  "write-cover-letter",
]);

export const candidateDocumentErrorCodes = Object.freeze([
  "candidate_document_missing",
  "candidate_document_unreadable",
  "candidate_letter_samples_invalid",
  "candidate_levers_invalid",
  "candidate_profile_heading_invalid",
  "candidate_profile_schema_version_missing",
  "candidate_profile_schema_version_unsupported",
  "candidate_profile_visibility_invalid",
  "candidate_rules_invalid",
  "candidate_rules_schema_version_missing",
  "candidate_rules_schema_version_unsupported",
]);

function fail(code, message) {
  throw new CandidateError(code, message);
}

/**
 * The profile section map, in document order. A fixed entry is one heading every profile carries,
 * word for word: a public rule links to it by an anchor built from the whole heading, so the heading
 * carries no qualifier of its own. `entries` marks a section whose subsections are the candidate's
 * own list — employers, projects — numbered from one without a gap; `optional` marks a section a
 * profile may leave out.
 *
 * The presentation guidance in tools/candidate/README.md#the-profile is optional: a profile
 * without it is complete, and the guidance may stand in the rules file instead. Dropping the section from the map would refuse a
 * profile this version of the map accepts.
 */
export const candidateProfileSections = Object.freeze([
  Object.freeze({ level: 2, number: "1", title: "Contacts & Logistics" }),
  Object.freeze({ level: 2, number: "2", title: "Role & Seniority" }),
  Object.freeze({ level: 2, number: "3", title: "Career Target & Priorities" }),
  Object.freeze({ level: 2, number: "4", title: "Compensation" }),
  Object.freeze({ level: 2, number: "5", title: "Professional Identity" }),
  Object.freeze({ level: 2, number: "6", title: "Technical Skills" }),
  Object.freeze({ level: 3, number: "6.1", title: "Languages" }),
  Object.freeze({ level: 3, number: "6.2", title: "Test Automation Frameworks & Tools" }),
  Object.freeze({ level: 3, number: "6.3", title: "CI/CD & Infrastructure" }),
  Object.freeze({ level: 3, number: "6.4", title: "Domain Skills" }),
  Object.freeze({ level: 3, number: "6.5", title: "AI Tooling in Engineering Workflow" }),
  Object.freeze({ level: 4, number: "6.5.1", title: "AI-assisted QA workflow" }),
  Object.freeze({ level: 4, number: "6.5.2", title: "Agentic AI infrastructure" }),
  Object.freeze({ level: 3, number: "6.6", title: "Other Technical Skills" }),
  Object.freeze({ level: 2, number: "7", title: "Explicit Gaps" }),
  Object.freeze({ level: 2, number: "8", title: "Work Approach & Team Style" }),
  Object.freeze({ level: 3, number: null, title: "Decision-making" }),
  Object.freeze({ level: 3, number: null, title: "Communication" }),
  Object.freeze({ level: 3, number: null, title: "Values in a team" }),
  Object.freeze({ level: 3, number: null, title: "Working style" }),
  Object.freeze({ level: 3, number: null, title: "Strengths" }),
  Object.freeze({ level: 3, number: null, title: "Risk areas" }),
  Object.freeze({ entries: "employer", level: 2, number: "9", title: "Experience" }),
  Object.freeze({ entries: "project", level: 2, number: "10", title: "Personal Projects" }),
  Object.freeze({ level: 2, number: "11", title: "Education" }),
  Object.freeze({
    level: 2,
    number: "12",
    optional: true,
    title: "How to Present Short Tenures and the Current Situation",
  }),
]);

const VERSION_LINE = /^<!-- candidate-profile-schema: (\d+) -->$/u;
const HEADING = /^(#{1,6}) (.+?)\s*$/u;
const QUALIFIER = /^(.+?) \((.+)\)$/u;
const VISIBILITY_LINE = /^\*\*Visibility:\*\* (.+)$/u;

/**
 * The headings of a markdown text in order, with the body lines below each, skipping fenced code:
 * a letter or an example inside a fence may start a line with `#` and is not a heading.
 */
function outline(text) {
  const sections = [];
  let current = { body: [], heading: null, level: 0, line: 0, plain: [] };
  let fence = null;
  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\r$/u, "");
    const fenceMatch = /^(```|~~~)/u.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1];
      else if (line.startsWith(fence)) fence = null;
      current.body.push(line);
      return;
    }
    const heading = fence === null ? HEADING.exec(line) : null;
    if (heading) {
      sections.push(current);
      current = { body: [], heading: heading[2], level: heading[1].length, line: index + 1, plain: [] };
      return;
    }
    current.body.push(line);
    // The lines outside a fence, where a field line of the document may stand.
    if (fence === null) current.plain.push(line);
  });
  sections.push(current);
  return { preamble: sections[0].body, sections: sections.slice(1), unclosedFence: fence !== null };
}

function withoutQualifier(title) {
  const match = QUALIFIER.exec(title);
  return match ? match[1] : title;
}

/**
 * The headings of a markdown text in document order, each with its level, its line and its whole
 * title — the form a heading is compared in and its anchor is built from. A heading inside a code
 * fence is not one.
 */
export function candidateHeadings(text) {
  return Object.freeze(outline(text).sections.map((section) => Object.freeze({
    level: section.level,
    line: section.line,
    title: section.heading,
  })));
}

function headingFailure(section, expected) {
  const where = section ? `line ${section.line}: ${"#".repeat(section.level)} ${section.heading}` : "end of file";
  fail("candidate_profile_heading_invalid", `profile heading does not match the section map at ${where}; expected ${expected}`);
}

function describe(entry) {
  const label = entry.number === null ? entry.title : `${entry.number}. ${entry.title}`;
  return `${"#".repeat(entry.level)} ${label}`;
}

function matchesFixed(section, entry) {
  if (!section || section.level !== entry.level) return false;
  const prefix = entry.number === null ? "" : `${entry.number}. `;
  if (!section.heading.startsWith(prefix)) return false;
  return section.heading.slice(prefix.length) === entry.title;
}

function readVersion(preamble) {
  const first = preamble.find((line) => line.trim() !== "");
  const match = first === undefined ? null : VERSION_LINE.exec(first.trim());
  if (!match) {
    fail(
      "candidate_profile_schema_version_missing",
      `the profile must open with <!-- candidate-profile-schema: ${candidateProfileSchemaVersion} -->`,
    );
  }
  const version = Number(match[1]);
  if (version !== candidateProfileSchemaVersion) {
    fail(
      "candidate_profile_schema_version_unsupported",
      `the profile declares a section map this engine does not read; it reads ${candidateProfileSchemaVersion}`,
    );
  }
  return version;
}

// The visibility of a project entry: exactly one line, anywhere in the entry — under its own
// subheadings too — and never inside a fence, where a line is an example rather than a field.
function readVisibility(sections, entryLabel) {
  const values = sections
    .flatMap((section) => section.plain)
    .map((line) => VISIBILITY_LINE.exec(line.trim()))
    .filter(Boolean);
  if (values.length !== 1) {
    fail(
      "candidate_profile_visibility_invalid",
      `${entryLabel} must carry exactly one **Visibility:** line, found ${values.length}`,
    );
  }
  const value = values[0][1].trim();
  if (!candidateProjectVisibilities.includes(value)) {
    fail(
      "candidate_profile_visibility_invalid",
      `${entryLabel} visibility must be one of ${candidateProjectVisibilities.join(", ")}`,
    );
  }
  return value;
}

/**
 * Walks the entries of a variable section and returns them. Headings of level four and deeper
 * inside an entry are the candidate's own and are not checked.
 */
function readEntries(sections, start, parent) {
  const found = [];
  let index = start;
  while (index < sections.length && sections[index].level > 2) {
    const section = sections[index];
    const expectedNumber = `${parent.number}.${found.length + 1}`;
    const prefix = `${expectedNumber}. `;
    if (section.level !== 3 || !section.heading.startsWith(prefix) || section.heading.length === prefix.length) {
      headingFailure(section, `### ${prefix}<${parent.entries}>`);
    }
    const name = section.heading.slice(prefix.length);
    if (parent.entries === "employer" && !withoutQualifier(name).includes(" - ")) {
      headingFailure(section, `### ${prefix}<employer> - <role>`);
    }
    const entry = { heading: section.heading, number: expectedNumber };
    let end = index + 1;
    while (end < sections.length && sections[end].level > 3) end += 1;
    if (parent.entries === "project") {
      // The project's name is its heading without the number and the qualifier in parentheses:
      // `quiet-ledger (private)` is named `quiet-ledger`. It is what the name ban on a private
      // project matches, so the qualifier, which is prose, never becomes part of it.
      entry.name = withoutQualifier(name);
      entry.visibility = readVisibility(sections.slice(index, end), `project ${found.length + 1} of candidate/profile.md#10-personal-projects`);
    }
    found.push(Object.freeze(entry));
    index = end;
  }
  return { entries: found, next: index };
}

/**
 * The profile against the section map. Returns the schema version, the employers and the projects
 * with their name and visibility; every disagreement throws with a code of its own.
 */
export function validateCandidateProfile(text) {
  if (typeof text !== "string") fail("candidate_document_unreadable", "the profile must be text");
  const { preamble, sections } = outline(text);
  const schemaVersion = readVersion(preamble);
  if (sections.length === 0 || sections[0].level !== 1) {
    headingFailure(sections[0], "# <candidate name>");
  }
  let index = 1;
  const employers = [];
  const projects = [];
  for (const entry of candidateProfileSections) {
    const section = sections[index];
    if (!matchesFixed(section, entry)) {
      if (entry.optional) continue;
      headingFailure(section, describe(entry));
    }
    index += 1;
    if (entry.entries) {
      const read = readEntries(sections, index, entry);
      if (entry.entries === "employer") employers.push(...read.entries);
      else projects.push(...read.entries);
      index = read.next;
    }
  }
  if (index < sections.length) headingFailure(sections[index], "no further heading after the last section of the map");
  return Object.freeze({
    employers: Object.freeze(employers),
    projects: Object.freeze(projects),
    schemaVersion,
  });
}

const LEVER_HEADING = /^Lever (\d+)$/u;
const LEVER_FIELDS = Object.freeze(["Statement", "Weight", "Condition", "Properties"]);
const CONDITIONAL = /^conditional — (\S.*)$/u;

function leverFailure(message) {
  fail("candidate_levers_invalid", message);
}

function readLeverFields(section) {
  const fields = new Map();
  for (const line of section.body) {
    if (line.trim() === "") {
      if (fields.size > 0) break;
      continue;
    }
    const match = /^([A-Z][a-z]+): (.*)$/u.exec(line);
    if (!match || !LEVER_FIELDS.includes(match[1])) break;
    if (fields.has(match[1])) leverFailure(`${section.heading} repeats the field ${match[1]}`);
    fields.set(match[1], match[2].trim());
  }
  return fields;
}

function parseLever(section, expectedId) {
  const heading = LEVER_HEADING.exec(section.heading);
  if (section.level !== 2 || !heading || Number(heading[1]) !== expectedId) {
    leverFailure(`lever headings must run ## Lever 1, ## Lever 2, … without a gap; expected ## Lever ${expectedId} at line ${section.line}`);
  }
  const fields = readLeverFields(section);
  const order = [...fields.keys()];
  const expectedOrder = LEVER_FIELDS.filter((name) => fields.has(name));
  if (order.join() !== expectedOrder.join()) {
    leverFailure(`${section.heading} lists its fields out of order: ${LEVER_FIELDS.join(", ")}`);
  }
  for (const name of ["Statement", "Weight", "Condition"]) {
    if (!fields.has(name) || fields.get(name) === "") leverFailure(`${section.heading} must carry ${name}`);
  }
  const weight = fields.get("Weight");
  if (!/^[1-5]$/u.test(weight)) leverFailure(`${section.heading} weight must be an integer from 1 to 5`);
  const condition = fields.get("Condition");
  const conditional = CONDITIONAL.exec(condition);
  if (condition !== "broad" && !conditional) {
    leverFailure(`${section.heading} condition must be "broad" or "conditional — <trigger>"`);
  }
  const properties = fields.has("Properties") ? fields.get("Properties").split(",").map((value) => value.trim()) : [];
  if (properties.some((value) => !candidateLeverProperties.includes(value))) {
    leverFailure(`${section.heading} properties must come from ${candidateLeverProperties.join(", ")}`);
  }
  if (new Set(properties).size !== properties.length) leverFailure(`${section.heading} repeats a property`);
  return Object.freeze({
    condition: conditional ? "conditional" : "broad",
    id: expectedId,
    properties: Object.freeze(properties),
    statement: fields.get("Statement"),
    trigger: conditional ? conditional[1] : null,
    weight: Number(weight),
  });
}

/**
 * The lever bank against its format: one `## Lever <id>` per lever, numbered from one without a
 * gap, each opening with its fields; then `## Positioning`, then an optional `## Stance`. Deeper
 * headings inside a section are the candidate's own.
 */
export function validateCandidateLevers(text) {
  if (typeof text !== "string") fail("candidate_document_unreadable", "the lever bank must be text");
  const { sections } = outline(text);
  if (sections.length === 0 || sections[0].level !== 1) leverFailure("the lever bank must open with a level-one heading");
  const top = sections.slice(1).filter((section) => section.level <= 2);
  if (top.some((section) => section.level === 1)) leverFailure("the lever bank has one level-one heading");
  const levers = [];
  let index = 0;
  while (index < top.length && LEVER_HEADING.test(top[index].heading)) {
    levers.push(parseLever(top[index], levers.length + 1));
    index += 1;
  }
  if (levers.length === 0) leverFailure("the lever bank must carry at least one lever");
  if (top[index]?.heading !== "Positioning") leverFailure("## Positioning must follow the last lever");
  index += 1;
  if (top[index]?.heading === "Stance") index += 1;
  if (index < top.length) leverFailure(`unexpected section after the levers: ## ${top[index].heading}`);
  return Object.freeze({ levers: Object.freeze(levers) });
}

const COVERED = /^Covered languages: (.+)$/u;

/**
 * The letter samples against their requirements: a covered-languages line before the first
 * sample and one `##` section per accepted letter. Zero samples is a valid file — it says which
 * languages have none.
 */
export function validateCandidateLetterSamples(text) {
  if (typeof text !== "string") fail("candidate_document_unreadable", "the letter samples must be text");
  const { sections } = outline(text);
  if (sections.length === 0 || sections[0].level !== 1) {
    fail("candidate_letter_samples_invalid", "the letter samples must open with a level-one heading");
  }
  const covered = sections[0].body.map((line) => COVERED.exec(line.trim())).filter(Boolean);
  if (covered.length !== 1) {
    fail("candidate_letter_samples_invalid", "the letter samples must name their languages on one Covered languages: line");
  }
  const languages = covered[0][1].split(",").map((value) => value.trim());
  if (languages.some((value) => value === "") || new Set(languages).size !== languages.length) {
    fail("candidate_letter_samples_invalid", "Covered languages must list distinct language names");
  }
  const samples = sections.slice(1);
  if (samples.some((section) => section.level === 1)) {
    fail("candidate_letter_samples_invalid", "the letter samples have one level-one heading");
  }
  return Object.freeze({
    languages: Object.freeze(languages),
    samples: Object.freeze(samples.filter((section) => section.level === 2).map((section) => section.heading)),
  });
}

const RULES_VERSION_LINE = /^<!-- candidate-rules-schema: (\d+) -->$/u;
const RULE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const RULE_FIELD = /^(Scope|Why):(.*)$/u;

function rulesFailure(message) {
  fail("candidate_rules_invalid", message);
}

function readRulesVersion(preamble) {
  const first = preamble.find((line) => line.trim() !== "");
  const match = first === undefined ? null : RULES_VERSION_LINE.exec(first.trim());
  if (!match) {
    fail(
      "candidate_rules_schema_version_missing",
      `the rules must open with <!-- candidate-rules-schema: ${candidateRulesSchemaVersion} -->`,
    );
  }
  const version = Number(match[1]);
  if (version !== candidateRulesSchemaVersion) {
    fail(
      "candidate_rules_schema_version_unsupported",
      `the rules declare a format this engine does not read; it reads ${candidateRulesSchemaVersion}`,
    );
  }
  return version;
}

// A rule is its `##` section together with the deeper sections below it: a `###` inside a rule is
// part of the rule's text, as it is inside a lever.
function parseRule(sections, ids) {
  const [head, ...below] = sections;
  const id = head.heading;
  if (!RULE_ID.test(id)) {
    rulesFailure(`line ${head.line}: a rule heading is its id — lowercase letters, digits and hyphens, starting with a letter`);
  }
  if (ids.has(id)) rulesFailure(`rule ${id} appears twice`);
  ids.add(id);
  const lines = head.body;
  let index = 0;
  while (index < lines.length && lines[index].trim() === "") index += 1;
  const fields = [];
  while (index < lines.length && fields.length < 2) {
    const match = RULE_FIELD.exec(lines[index]);
    if (!match) break;
    fields.push([match[1], match[2].trim()]);
    index += 1;
  }
  if (fields.length !== 2 || fields[0][0] !== "Scope" || fields[1][0] !== "Why") {
    rulesFailure(`rule ${id} must open with a Scope: line and then a Why: line`);
  }
  const scope = fields[0][1].split(",").map((value) => value.trim());
  if (scope.some((value) => !candidateRuleScopes.includes(value))) {
    rulesFailure(`rule ${id} scope must name points from ${candidateRuleScopes.join(", ")}`);
  }
  if (new Set(scope).size !== scope.length) rulesFailure(`rule ${id} names a point twice`);
  if (fields[1][1] === "") rulesFailure(`rule ${id} must say why on its Why: line`);
  const text = [...lines.slice(index), ...below.flatMap((section) => [section.heading, ...section.body])];
  if (!text.some((line) => line.trim() !== "")) rulesFailure(`rule ${id} has no text`);
  return Object.freeze({ id, scope: Object.freeze(scope), why: fields[1][1] });
}

/**
 * The rules against their format: the version line, one level-one heading, then one `## <id>` per
 * rule, each opening with its `Scope:` and `Why:` lines and carrying text below them. The text is
 * the candidate's and is not read; zero rules is a valid file.
 */
export function validateCandidateRules(text) {
  if (typeof text !== "string") fail("candidate_document_unreadable", "the rules must be text");
  const { preamble, sections, unclosedFence } = outline(text);
  const schemaVersion = readRulesVersion(preamble);
  // A fence left open would hide every rule below it from the check and from the count.
  if (unclosedFence) rulesFailure("a code fence is opened and never closed");
  if (sections.length === 0 || sections[0].level !== 1) rulesFailure("the rules must carry a level-one heading after the version line");
  if (sections.slice(1).some((section) => section.level === 1)) rulesFailure("the rules have one level-one heading");
  if (sections.length > 1 && sections[1].level !== 2) {
    rulesFailure(`line ${sections[1].line}: the first heading after the title must be a rule, ## <id>`);
  }
  const rules = [];
  const ids = new Set();
  let index = 1;
  while (index < sections.length) {
    let end = index + 1;
    while (end < sections.length && sections[end].level > 2) end += 1;
    rules.push(parseRule(sections.slice(index, end), ids));
    index = end;
  }
  return Object.freeze({ rules: Object.freeze(rules), schemaVersion });
}
