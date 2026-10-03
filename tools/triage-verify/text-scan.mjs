// Literal phrase scanning over an untrusted capture body.
//
// Two properties are load-bearing.
//
// **No regular expression ever meets the body.** The negative-space vocabulary is repository-owned,
// but the text it is scanned against is a vacancy page, and a pattern language over untrusted input
// is a denial-of-service surface and an escaping problem at once. Every phrase is a literal token
// sequence and the scan is a hand-rolled walk, so a vocabulary entry cannot express backtracking.
//
// **Offsets stay in the body's own coordinates.** A hit has to be comparable with the span of an
// evidence quote inside the same body, so case folding is per character and keeps the string
// length: a fold that changed the length would make every later offset a lie.

import { createHash } from "node:crypto";

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/**
 * Lowercase without moving a single index.
 *
 * `String.prototype.toLowerCase` is not length-preserving for every code point (`İ` becomes two
 * code units), so a character whose lowercase spelling is not the same length keeps its original
 * form. The cost is that such a character does not fold; the benefit is that offset `i` in the
 * result is offset `i` in the input, which is what every caller here depends on.
 */
export function foldCase(text) {
  let folded = "";
  for (const character of text) {
    const lowered = character.toLowerCase();
    folded += lowered.length === character.length ? lowered : character;
  }
  return folded;
}

function isWhitespace(character) {
  return character !== undefined && /\s/u.test(character);
}

function isWordCharacter(character) {
  return character !== undefined && WORD_CHARACTER.test(character);
}

/**
 * Split a vocabulary phrase into the tokens the scan matches.
 * The phrase is repository text, so this is a normalisation, not a parser hardened against input.
 */
export function phraseTokens(phrase) {
  return phrase
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
}

/**
 * Length of the whitespace run at `from`, or `null` when the run is not a legal token separator.
 *
 * A separator must exist and must not cross a paragraph boundary: two consecutive line breaks are
 * the only paragraph marker a normalised capture body has, and a phrase that matched across one
 * would join two unrelated sentences into a requirement nobody wrote.
 */
function separatorLength(body, from) {
  let index = from;
  let newlines = 0;
  while (index < body.length && isWhitespace(body[index])) {
    if (body[index] === "\n") newlines += 1;
    index += 1;
  }
  if (index === from) return null;
  if (newlines > 1) return null;
  return index - from;
}

/**
 * Every occurrence of one literal phrase in `body`, as `{ start, end }` spans of `body`.
 *
 * Case-insensitive, whitespace-flexible between tokens, and guarded at both ends by a word
 * boundary so `based in` does not match inside `unbased inside`.
 */
export function findPhraseOccurrences(body, phrase) {
  const tokens = phraseTokens(phrase);
  if (tokens.length === 0) return [];
  const folded = foldCase(body);
  const foldedTokens = tokens.map((token) => foldCase(token));
  const first = foldedTokens[0];
  const occurrences = [];
  let searchFrom = 0;
  while (searchFrom <= folded.length - first.length) {
    const start = folded.indexOf(first, searchFrom);
    if (start === -1) break;
    searchFrom = start + 1;
    if (isWordCharacter(first[0]) && isWordCharacter(body[start - 1])) continue;
    let cursor = start + first.length;
    let matched = true;
    for (let index = 1; index < foldedTokens.length; index += 1) {
      const separator = separatorLength(body, cursor);
      if (separator === null) {
        matched = false;
        break;
      }
      const tokenStart = cursor + separator;
      if (!folded.startsWith(foldedTokens[index], tokenStart)) {
        matched = false;
        break;
      }
      cursor = tokenStart + foldedTokens[index].length;
    }
    if (!matched) continue;
    const lastToken = foldedTokens[foldedTokens.length - 1];
    if (isWordCharacter(lastToken[lastToken.length - 1]) && isWordCharacter(body[cursor])) continue;
    occurrences.push({ start, end: cursor });
  }
  return occurrences;
}

/**
 * Every occurrence of one exact literal in `body`. Used to locate an evidence quote, where the
 * comparison is deliberately byte-exact: a quote is either what the page said or it is not.
 */
export function findLiteralOccurrences(body, literal) {
  if (literal.length === 0) return [];
  const occurrences = [];
  let from = 0;
  while (from <= body.length - literal.length) {
    const start = body.indexOf(literal, from);
    if (start === -1) break;
    occurrences.push({ start, end: start + literal.length });
    from = start + 1;
  }
  return occurrences;
}

/** The line range enclosing a span, from the start of its first line to the end of its last. */
export function enclosingLines(body, span) {
  const start = span.start === 0 ? 0 : body.lastIndexOf("\n", span.start - 1) + 1;
  const lineEnd = body.indexOf("\n", span.end);
  return { start, end: lineEnd === -1 ? body.length : lineEnd };
}

/**
 * The digest a disposition is keyed by: the folded, whitespace-collapsed text of the lines a hit
 * sits on. Folding before hashing means a disposition survives a re-capture that only changed
 * spacing, and dies when the sentence itself changed - which is exactly when it must be re-taken.
 */
export function lineDigest(body, span) {
  const { start, end } = enclosingLines(body, span);
  const text = foldCase(body.slice(start, end)).replace(/\s+/gu, " ").trim();
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Collapse a run of whitespace, for the near-match diagnostic only. */
export function collapseWhitespace(text) {
  return text.replace(/\s+/gu, " ").trim();
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
