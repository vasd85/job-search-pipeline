// A task file's frontmatter, read as the board README defines it, and the one transformation the
// import makes: a draft with no number becomes a task with one.
//
// The reader is deliberately narrow. It reads the top-level `key: value` lines between the two
// `---` fences and nothing inside nested blocks, which is all the import needs: it checks the keys
// a draft must carry and must not carry, and it finds a task by `draft_id`. It never rewrites a
// value, so a quoting style it does not understand is carried through untouched.

import { BoardError } from "./git.mjs";

export const TASK_TYPES = Object.freeze(["bug", "epic", "feat", "process", "research"]);
export const TASK_PRIORITIES = Object.freeze(["p1", "p2", "p3"]);

/** Keys a draft must carry, each with the check its value must pass. */
const REQUIRED_DRAFT_KEYS = Object.freeze({
  created: (value) => /^\d{4}-\d{2}-\d{2}$/u.test(value),
  draft_id: (value) => DRAFT_ID_PATTERN.test(value),
  priority: (value) => TASK_PRIORITIES.includes(value),
  source: (value) => value.length > 0,
  status: (value) => value === "open",
  title: (value) => value.length > 0,
  type: (value) => TASK_TYPES.includes(value),
});

/** A draft has no number yet and nobody has claimed it. */
const FORBIDDEN_DRAFT_KEYS = Object.freeze(["claim", "id"]);

export const DRAFT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
export const DRAFT_FILE_PATTERN = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/u;
export const TASK_FILE_PATTERN = /^(\d+)-[a-z]+-[a-z0-9-]+\.md$/u;

function invalid(where, message) {
  throw new BoardError("board_import_draft_invalid", `${where}: ${message}`);
}

/**
 * The frontmatter block of a task file: its line range and its top-level keys. Returns null when
 * the text does not open with a fenced block.
 */
export function readFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  const keys = new Map();
  for (let index = 1; index < end; index += 1) {
    const match = /^([a-z][a-z_-]*):(.*)$/u.exec(lines[index]);
    if (match === null) continue;
    let value = match[2].trim();
    if (value.length >= 2 && /^(["']).*\1$/u.test(value)) value = value.slice(1, -1);
    if (keys.has(match[1])) return { duplicate: match[1], end, keys, lines };
    keys.set(match[1], value);
  }
  return { duplicate: null, end, keys, lines };
}

/** Validate one draft file; returns what the import needs from it. */
export function parseDraft(fileName, text) {
  const name = DRAFT_FILE_PATTERN.exec(fileName);
  if (name === null) invalid(fileName, "a draft is named <slug>.md, the slug in kebab-case.");
  const front = readFrontmatter(text);
  if (front === null) invalid(fileName, "no frontmatter block between two --- lines.");
  if (front.duplicate !== null) invalid(fileName, `the key ${front.duplicate} appears twice.`);
  for (const key of FORBIDDEN_DRAFT_KEYS) {
    if (front.keys.has(key)) invalid(fileName, `a draft carries no ${key}.`);
  }
  for (const [key, check] of Object.entries(REQUIRED_DRAFT_KEYS)) {
    if (!front.keys.has(key)) invalid(fileName, `the key ${key} is missing.`);
    if (!check(front.keys.get(key))) invalid(fileName, `the value of ${key} is not allowed.`);
  }
  return {
    draftId: front.keys.get("draft_id"),
    fileName,
    slug: name[1],
    text,
    title: front.keys.get("title"),
    type: front.keys.get("type"),
  };
}

export function taskFileName(id, type, slug) {
  return `${String(id).padStart(3, "0")}-${type}-${slug}.md`;
}

/** The next id: one above the largest number any task file carries, open or done. */
export function nextTaskId(fileNames) {
  let max = 0;
  for (const fileName of fileNames) {
    const match = TASK_FILE_PATTERN.exec(fileName);
    if (match !== null) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/** The draft's text with `id` as the first frontmatter key; everything else byte for byte. */
export function numberedText(text, id) {
  if (!text.startsWith("---\n")) {
    throw new BoardError("board_import_draft_invalid", "a draft opens with its frontmatter.");
  }
  return `---\nid: ${id}\n${text.slice(4)}`;
}
