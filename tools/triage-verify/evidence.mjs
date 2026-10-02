// Finding the evidence fields of a normalized scorer input without naming them.
//
// The 2026-08-18 quote check walked a hardcoded list of six paths. That list was right for that
// batch and silently wrong for the next schema: a field added to `normalized-input.mjs` would have
// been verified by nobody while the check still reported a pass. The walk below is driven by the
// object itself - a string leaf is evidence when its own key says so, or when it lives inside a
// container called `evidence` - so a new evidence field is covered the day it is added.
//
// The discovered path set is frozen as a literal in the test suite. That is the other half: the
// rule finds new fields automatically, and the pin makes a *renamed* field visible instead of
// letting the walk quietly find nothing.

const EVIDENCE_KEY = /evidence/iu;
const EVIDENCE_CONTAINER = "evidence";
const MAX_DEPTH = 12;
const MAX_NODES = 20000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Walk one normalized input and return every evidence-bearing leaf.
 *
 * `paths` holds every evidence path the walk reached, including the ones whose value is `null`;
 * `quotes` holds only the ones that carry text. A caller that wants to know whether a record
 * recorded any evidence at all reads `quotes`.
 */
export function discoverEvidence(input) {
  const paths = [];
  const quotes = [];
  let nodes = 0;

  const visit = (value, path, depth, insideEvidence) => {
    nodes += 1;
    if (depth > MAX_DEPTH || nodes > MAX_NODES) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1, insideEvidence));
      return;
    }
    if (isRecord(value)) {
      for (const key of Object.keys(value).sort()) {
        const childPath = path === "" ? key : `${path}.${key}`;
        const childInsideEvidence = insideEvidence || key === EVIDENCE_CONTAINER;
        visit(value[key], childPath, depth + 1, childInsideEvidence);
      }
      return;
    }
    if (value !== null && typeof value !== "string") return;
    const key = path.split(".").pop() ?? "";
    const isEvidence = insideEvidence || EVIDENCE_KEY.test(key);
    if (!isEvidence) return;
    paths.push(path);
    if (typeof value === "string" && value.length > 0) quotes.push({ path, value });
  };

  visit(input, "", 0, false);
  return { paths, quotes };
}

/**
 * The generic path spelling of a discovered path: array indices collapse to `[]`.
 * Two records with different offer counts then produce the same path set, which is what makes the
 * frozen pin in the test suite a statement about the schema rather than about one fixture.
 */
export function genericPath(path) {
  return path.replace(/\[\d+\]/gu, "[]");
}

export function genericEvidencePaths(input) {
  return [...new Set(discoverEvidence(input).paths.map(genericPath))].sort();
}
