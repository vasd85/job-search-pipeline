// Deferred-content measurement for the generic adapter.
//
// The silent-partial class this closes: a page whose server render passes every structural
// check while part of the vacancy exists only as data inside a typed JSON script island,
// rendered client-side. Measured on the reproduction page (batch rollout-2026-08, record 14):
// visible text 2 093 chars, prose inside JSON islands 51 330 chars — 24.5× — while a clean
// server-rendered control carried 0. The measurement is a per-response architecture signal:
// substantial prose arrived as data invisible to markup extraction, so the completeness of this
// capture is unverified by construction. It never asserts the capture is short — the same
// island fires against a complete render of the same page, because the island is a
// location-keyed catalog, not a mirror.
//
// Same hostile-input discipline as html-text.mjs: forward index scans only — no regular
// expression runs over attacker-controlled text, because a backtracking pattern over a
// `<`-dense string is quadratic and a single hostile JSON value could stall a batch for
// minutes — and bounded work: the walk carries an explicit value budget, and exhausting it is
// recorded and treated as suspect rather than ignored, because an island too large to finish
// walking is itself first-class evidence of content shipped as data. There is no private byte
// ceiling below the transport's own `maxBytes`: a ceiling reachable only by legitimate input
// would ship green against small fixtures and silently never fire on the very page that
// motivated it.
//
// One named divergence from the html-text.mjs scanner: islands inside HTML comments and CDATA
// are skipped like the browser skips them, but a `<script>` written inside a raw-text
// `<textarea>` is still scanned here while html-text renders it as visible text — those bytes
// then count on both sides of the ratio. The error is in the firing direction, costs one
// confirmation load, and full tokenization is not worth that residual.

// One threshold, one arm. The shared minimum-content floor already gates `usable` at 400
// characters, so `prose ≥ 2 × extracted` implies prose ≥ 800 on every usable record and a
// separate absolute floor could never be the deciding condition — a constant no test can
// exercise is the defect, not the guard.
export const deferredContentThresholdRatio = 2;

// Visited JSON values (strings, numbers, booleans, nulls, arrays, objects) before the walk
// stops. Reachable by a hostile 5 MiB island on purpose: the breach is recorded as a fact and
// fires the signal instead of silently under-measuring.
export const jsonWalkValueBudget = 250_000;

const JSON_SCRIPT_TYPE_MARKERS = Object.freeze(["application/json", "application/ld+json"]);

/**
 * The one bounded verdict this module owns. Fires on measured prose shipped as data — or on a
 * walk too large to finish, which is the same evidence in a louder form. A malformed island
 * alone fires nothing: nothing was measured there, and the recorded fact says so. `usable` is
 * untouched by design: the signal is advisory, and the caller's policy owns its cost.
 */
export function deferredContentSuspected({ jsonProseChars, jsonWalkBudgetHit }, extractedChars) {
  return (
    jsonWalkBudgetHit === true ||
    (jsonProseChars > 0 && jsonProseChars >= deferredContentThresholdRatio * extractedChars)
  );
}

// Each `<…>` span collapses to one space; a `<` that never closes is literal content, exactly
// as the html-text tokenizer treats a bare `<`. Index scan on purpose: `indexOf` only ever
// advances, so a value made of a hundred thousand `<` costs one pass, not a quadratic crawl.
function stripMarkup(value) {
  if (!value.includes("<")) return value;
  let out = "";
  let index = 0;
  for (;;) {
    const lt = value.indexOf("<", index);
    if (lt === -1) {
      out += value.slice(index);
      break;
    }
    const gt = value.indexOf(">", lt + 1);
    if (gt === -1) {
      out += value.slice(index);
      break;
    }
    out += `${value.slice(index, lt)} `;
    index = gt + 1;
  }
  return out;
}

/**
 * Prose-shaped length of one JSON string value: at least 30 characters and 4 spaces after
 * markup tags are stripped, so ids, tokens, urls and enum words count as zero. Returns the
 * stripped length, because embedded `<li>`/`<p>` markup is scaffolding, not prose mass.
 */
export function proseCharCount(value) {
  const stripped = stripMarkup(value);
  if (stripped.length < 30) return 0;
  let spaces = 0;
  for (let index = 0; index < stripped.length && spaces < 4; index += 1) {
    if (stripped[index] === " ") spaces += 1;
  }
  return spaces >= 4 ? stripped.length : 0;
}

function walkProse(root, budget, state) {
  const stack = [root];
  let prose = 0;
  while (stack.length > 0) {
    if (state.visited >= budget) {
      state.budgetHit = true;
      return prose;
    }
    state.visited += 1;
    const node = stack.pop();
    if (typeof node === "string") {
      prose += proseCharCount(node);
      continue;
    }
    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index -= 1) stack.push(node[index]);
      continue;
    }
    if (node !== null && typeof node === "object") {
      for (const value of Object.values(node)) stack.push(value);
    }
  }
  return prose;
}

// A close tag ends at a name boundary, exactly as the html-text scanner requires: `</scriptx`
// closes nothing.
function findScriptClose(lower, from) {
  let at = from;
  for (;;) {
    at = lower.indexOf("</script", at);
    if (at === -1) return -1;
    const following = lower[at + 8];
    if (
      following === undefined ||
      following === ">" ||
      following === "/" ||
      /\s/u.test(following)
    ) {
      return at;
    }
    at += 8;
  }
}

/**
 * Measure prose shipped as data inside typed JSON script islands of one HTML document.
 *
 * Islands are `<script>` elements whose open tag names `application/json` or
 * `application/ld+json`. Each is parsed as delivered — the transport's `maxBytes` is the only
 * size bound — and walked iteratively under `valueBudget`. A parse failure records
 * `jsonIslandUnparsed` and measures nothing from that island; a budget exhaustion records
 * `jsonWalkBudgetHit` and keeps the prose counted so far.
 */
export function measureJsonIslandProse(html, { valueBudget = jsonWalkValueBudget } = {}) {
  const result = {
    jsonProseChars: 0,
    jsonIslandCount: 0,
    jsonIslandUnparsed: false,
    jsonWalkBudgetHit: false,
  };
  if (typeof html !== "string" || html.length === 0) return result;
  const lower = html.toLowerCase();
  const state = { visited: 0, budgetHit: false };
  // A browser never runs a script inside a comment or CDATA section, and html-text.mjs skips
  // both wholesale — so a commented-out island may not fire the signal either. An unterminated
  // span consumes the rest of the document, exactly as the tokenizer treats it.
  //
  // The three needles are advance-only memo cursors, the html-text `missingClose` pattern: a
  // cursor is re-searched only after `at` has moved past its last hit, so successive searches
  // cover disjoint regions and the whole scan is amortized linear. The naive per-iteration
  // `indexOf` this replaces was measured quadratic in both directions a hostile page controls —
  // 21 s over 100 000 empty comments before one island, 47 s over 50 000 tiny islands whose
  // every iteration re-ran a failed whole-remainder comment search. A `-1` cursor is terminal:
  // none from an earlier position means none from any later one.
  let at = 0;
  let nextScript = lower.indexOf("<script");
  let nextComment = html.indexOf("<!--");
  let nextCdata = html.indexOf("<![CDATA[");
  for (;;) {
    if (nextScript !== -1 && nextScript < at) nextScript = lower.indexOf("<script", at);
    if (nextScript === -1) break;
    if (nextComment !== -1 && nextComment < at) nextComment = html.indexOf("<!--", at);
    if (nextCdata !== -1 && nextCdata < at) nextCdata = html.indexOf("<![CDATA[", at);
    if (nextComment !== -1 && nextComment < nextScript) {
      const end = html.indexOf("-->", nextComment + 4);
      if (end === -1) break;
      at = end + 3;
      continue;
    }
    if (nextCdata !== -1 && nextCdata < nextScript) {
      const end = html.indexOf("]]>", nextCdata + 9);
      if (end === -1) break;
      at = end + 3;
      continue;
    }
    const open = nextScript;
    const openEnd = html.indexOf(">", open);
    if (openEnd === -1) break;
    const close = findScriptClose(lower, openEnd);
    if (close === -1) break;
    const openTag = lower.slice(open, openEnd + 1);
    if (JSON_SCRIPT_TYPE_MARKERS.some((marker) => openTag.includes(marker))) {
      result.jsonIslandCount += 1;
      let parsed;
      let ok = true;
      try {
        parsed = JSON.parse(html.slice(openEnd + 1, close));
      } catch {
        result.jsonIslandUnparsed = true;
        ok = false;
      }
      if (ok) result.jsonProseChars += walkProse(parsed, valueBudget, state);
    }
    at = close + 8;
  }
  result.jsonWalkBudgetHit = state.budgetHit;
  return result;
}
