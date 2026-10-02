// The one pin of the development flow document: the list of paths that selects the light level.
// Everything outside the list is full, so a light change that widened the list would reclassify
// itself; with the list frozen here, widening it changes a test, and a test is outside the list.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const FLOW = "docs/runbooks/development-flow.md";

// The sentence and its list, whitespace-tolerant so a rewrap of the sentence is not a change.
const LIGHT_LIST = new RegExp(
  String.raw`\*\*Light\*\*\s+applies\s+only\s+when\s+every\s+changed\s+path\s+matches\s+one\s+of\s+`
    + String.raw`these\s+globs:\n\n\x60{3}text\n([\s\S]*?)\n\x60{3}\n`,
  "g",
);
const LIGHT_GLOBS = Object.freeze(["docs/**", "README.md"]);

test("the light level is exactly the frozen list of paths, and every other path is full", () => {
  const flow = readFileSync(join(repoRoot, FLOW), "utf8");
  const lists = [...flow.matchAll(LIGHT_LIST)];
  assert.equal(lists.length, 1, "one light list, directly after the sentence that introduces it");
  assert.deepEqual(lists[0][1].split("\n"), [...LIGHT_GLOBS]);

  // A second list of globs in the same section would widen light beside the frozen one, in any
  // fence: docs/runbooks/development-flow.md#5-two-levels-of-ceremony holds exactly the list and the one command that derives the level. What no
  // pin catches is a widening written as prose; the pull request's reader is the check there.
  const start = flow.indexOf("\n## 5. ");
  const end = flow.indexOf("\n## 6. ", start);
  assert.ok(start !== -1 && end !== -1, "docs/runbooks/development-flow.md#5-two-levels-of-ceremony holds the two levels");
  const openers = [];
  let open = false;
  for (const line of flow.slice(start, end).split("\n")) {
    const fence = /^\s*(?:`{3,}|~{3,})(\S*)\s*$/.exec(line);
    if (!fence) continue;
    if (!open) openers.push(fence[1]);
    open = !open;
  }
  assert.deepEqual(openers, ["text", "sh"], "docs/runbooks/development-flow.md#5-two-levels-of-ceremony fences: the light list, the diff command");

  // The default is what makes the list an exception rather than one level among several.
  assert.match(flow, /Any other path makes the task \*\*full\*\*\./);
});
