// The scripted normalization pass.
//
// The 2026-08-18 triage run normalized raw files by hand, after extraction, and left no record
// of what changed; the chain of custody had to be reconstructed from memory. This module is the
// answer to that: one ordered, named rule list, one function, and a log that carries the digest
// before the pass, the digest after it, and the replacement count of every rule. A rule that
// changed nothing is still listed with a zero, so "no normalization happened" and "the pass was
// never run" cannot look alike.
//
// Every rule is deliberately conservative. Nothing here rewrites words, reorders text, expands
// an abbreviation, strips punctuation or drops a line: the persisted body is quoted literally by
// later checks, so a normalization that improved readability would corrupt evidence.

import { sha256Utf8 } from "./digest.mjs";

function replaceCounted(text, pattern, replacement) {
  let count = 0;
  const next = text.replace(pattern, (match) => {
    count += 1;
    return typeof replacement === "function" ? replacement(match) : replacement;
  });
  return { text: next, count };
}

/**
 * Ordered rules. Order matters: line endings are unified before line-trailing whitespace is
 * trimmed, and blank runs are collapsed only after both.
 */
export const normalizationRules = Object.freeze([
  Object.freeze({
    id: "strip_bom",
    // A byte-order mark that survived decoding would sit inside the first quoted line.
    apply: (text) => replaceCounted(text, /^﻿/u, ""),
  }),
  Object.freeze({
    id: "crlf_to_lf",
    apply: (text) => replaceCounted(text, /\r\n?/gu, "\n"),
  }),
  Object.freeze({
    id: "nbsp_to_space",
    // Non-breaking, figure and narrow no-break spaces read as ordinary spaces on the page but
    // break every substring comparison a later check makes against a hand-typed quote.
    apply: (text) => replaceCounted(text, /[   ]/gu, " "),
  }),
  Object.freeze({
    id: "remove_zero_width",
    // Zero-width and soft-hyphen characters are invisible on the page and inside a quote.
    apply: (text) => replaceCounted(text, /[­​‌‍⁠﻿]/gu, ""),
  }),
  Object.freeze({
    id: "nfc",
    // Counted as one change for the whole document rather than per character: the pass either
    // moved the text to NFC or it did not.
    apply: (text) => {
      const next = text.normalize("NFC");
      return { text: next, count: next === text ? 0 : 1 };
    },
  }),
  Object.freeze({
    id: "trim_line_trailing_whitespace",
    apply: (text) => replaceCounted(text, /[ \t]+$/gmu, ""),
  }),
  Object.freeze({
    id: "collapse_blank_runs",
    // Three or more line breaks become one blank line. Extraction produces long empty runs
    // from nested block elements; two consecutive breaks are kept because they are the only
    // paragraph boundary the plain-text file has.
    apply: (text) => replaceCounted(text, /\n{3,}/gu, "\n\n"),
  }),
  Object.freeze({
    id: "single_trailing_newline",
    apply: (text) => {
      const next = `${text.replace(/^\n+/u, "").replace(/\n+$/u, "")}\n`;
      return { text: next, count: next === text ? 0 : 1 };
    },
  }),
]);

/**
 * Run the pass over one extracted text.
 * Returns the normalized text and the log record persisted beside it. The caller never
 * normalizes on its own: an unlogged pass is exactly the defect this module exists to close.
 */
export function normalizeExtractedText(text) {
  const beforeSha256 = sha256Utf8(text);
  let current = text;
  const rules = [];
  for (const rule of normalizationRules) {
    const result = rule.apply(current);
    current = result.text;
    rules.push(Object.freeze({ id: rule.id, replacements: result.count }));
  }
  const afterSha256 = sha256Utf8(current);
  return {
    text: current,
    log: Object.freeze({
      beforeSha256,
      beforeChars: text.length,
      afterSha256,
      afterChars: current.length,
      changed: beforeSha256 !== afterSha256,
      rules: Object.freeze(rules),
    }),
  };
}
