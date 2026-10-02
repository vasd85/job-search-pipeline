// The first stage over a general source: which new posts the reader gets to see at all.
//
// A thematic source has no filter - everything but advertising fits, and every post with text is a
// card. A general source pours every role into the channel, so a post of it is a CANDIDATE only when
// a word of the config's `role_words` stands anywhere in its text or in the text of any of its
// anchors. The list is wide on purpose (`test*`, `quality`, `automation`): the research measured
// zero QA vacancies lost at this stage on 1 859 posts, and the price of the width is paid in cheap
// model tokens, not in silent loss. A post outside the list is counted per source and is not
// listed - that is the accepted boundary of the first stage.
//
// A word is a whole word or a prefix ending in `*`, compared without case after NFKC, over the same
// letters-and-digits words `text.mjs` gives every other rule. `strong_role_words` use the same
// grammar; they mark the lines the report doubts the reader over, never the lines it filters.
//
// A résumé carries the same words as a vacancy (`QA`, `SDET` in its first line), so a hint is
// computed for the report - one of the config's `resume_hints` in the first six lines - and it
// removes nothing: the research found a résumé tag on four real vacancies. A hint is a tag or a
// phrase in any script, compared without case after the same normalisation as a line, and matched
// only where no letter or digit follows it.

import { fail } from "./errors.mjs";
import { hasWordBeyondHashtags, normalizeLine, wordsOf } from "./text.mjs";

export const MAX_ROLE_WORDS = 64;
const TOKEN = /^[\p{L}\p{N}]{2,32}\*?$/u;
export const MAX_RESUME_HINTS = 64;
const MAX_RESUME_HINT_LENGTH = 64;
const RESUME_HINT_LINES = 6;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Parse one word list of the config; refusals name the key and the index, never the value. */
export function parseRoleWords(value, key) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ROLE_WORDS) {
    fail("config_invalid", `${key} must be a list of 1 to ${MAX_ROLE_WORDS} words.`);
  }
  return Object.freeze(
    value.map((raw, index) => {
      if (typeof raw !== "string" || !TOKEN.test(raw.normalize("NFKC"))) {
        fail(
          "config_invalid",
          `${key}[${index}] must be a word of letters and digits, optionally ending in *.`,
        );
      }
      const token = raw.normalize("NFKC").toLowerCase();
      const prefix = token.endsWith("*");
      return Object.freeze({ word: prefix ? token.slice(0, -1) : token, prefix });
    }),
  );
}

/** Parse the config's résumé hints; refusals name the index, never the value. The list may be empty. */
export function parseResumeHints(value, key) {
  if (!Array.isArray(value) || value.length > MAX_RESUME_HINTS) {
    fail("config_invalid", `${key} must be a list of at most ${MAX_RESUME_HINTS} hints.`);
  }
  return Object.freeze(
    value.map((raw, index) => {
      const hint = typeof raw === "string" ? normalizeLine(raw) : "";
      if (!LETTER_OR_DIGIT.test(hint) || [...hint].length > MAX_RESUME_HINT_LENGTH) {
        fail(
          "config_invalid",
          `${key}[${index}] must be a tag or a phrase of at most ${MAX_RESUME_HINT_LENGTH} characters with a letter or a digit.`,
        );
      }
      return hint;
    }),
  );
}

// `\b` knows ASCII only, so a hint's end is spelled out as "no letter or digit follows".
function endsAWord(text, end) {
  return end >= text.length || !LETTER_OR_DIGIT.test(String.fromCodePoint(text.codePointAt(end)));
}

function containsHint(text, hint) {
  for (let at = text.indexOf(hint); at >= 0; at = text.indexOf(hint, at + 1)) {
    if (endsAWord(text, at + hint.length)) return true;
  }
  return false;
}

/** The first token that matches a word of `text`, or null. */
export function matchingToken(text, tokens) {
  for (const word of wordsOf(normalizeLine(text))) {
    for (const token of tokens) {
      if (token.prefix ? word.startsWith(token.word) : word === token.word) return token;
    }
  }
  return null;
}

function tokenText(token) {
  return token.prefix ? `${token.word}*` : token.word;
}

/** The lines of a post that carry anything, numbered from 1 as the reader sees them. */
export function numberedLines(post) {
  const lines = [];
  post.lines.forEach((text, lineIndex) => {
    if (text.length > 0) lines.push({ n: lines.length + 1, lineIndex, text });
  });
  return lines;
}

/** The numbers of the first two lines that carry a word - the same two lines a fingerprint's head reads. */
export function headLineNumbers(post) {
  return numberedLines(post)
    .filter((line) => wordsOf(normalizeLine(line.text)).length > 0)
    .slice(0, 2)
    .map((line) => line.n);
}

/** Is a post of a general source a candidate: a role word anywhere in its text or in an anchor text. */
export function isCandidate(post, entries, tokens) {
  return (
    post.lines.some((line) => matchingToken(line, tokens) !== null) ||
    entries.some((entry) => matchingToken(entry.anchorText ?? "", tokens) !== null)
  );
}

/** The résumé hint for the report: a hint of the config in the first six lines. Removes nothing. */
export function resumeHint(post, hints) {
  const head = numberedLines(post)
    .slice(0, RESUME_HINT_LINES)
    .map((line) => normalizeLine(line.text))
    .join("\n");
  return hints.some((hint) => containsHint(head, hint));
}

/**
 * The strong-word hits the report prints for one post: over every anchor - by its text, and by its
 * line when that line is not one the reader named - and over the first two word-lines. `cited`
 * names the line numbers and entry indexes the reader named. A hashtag anchor is skipped as a tag
 * of the post, not an anchor of a vacancy. A contact anchor (`tg`, `email`) is a name, not a
 * role: its text is not read, and its line is read with the name taken out, so `@qa_hr` alone
 * never makes a line while "QA Engineer - write @qa_hr" still does. With `skipTagRows` a line that
 * is hashtags and nothing else is not read: inside a post where the reader found a vacancy, a tag
 * row is not a second vacancy it missed. Each place is reported once, in line order.
 */
export function strongHits(
  post,
  entries,
  tokens,
  { citedLines = new Set(), citedEntries = new Set(), skipTagRows = false } = {},
) {
  const lines = numberedLines(post);
  const byLineIndex = new Map(lines.map((line) => [line.lineIndex, line]));
  const hits = [];
  const seenLines = new Set();
  const lineHit = (line, text = line?.text) => {
    if (line === undefined || seenLines.has(line.n) || citedLines.has(line.n)) return;
    if (skipTagRows && !hasWordBeyondHashtags(line.text)) return;
    const token = matchingToken(text, tokens);
    if (token === null) return;
    seenLines.add(line.n);
    hits.push({ where: "line", n: line.n, token: tokenText(token), text: line.text });
  };
  entries.forEach((entry, index) => {
    if (citedEntries.has(index) || entry.skipped === "hashtag") return;
    const line = entry.lineIndex === null ? undefined : byLineIndex.get(entry.lineIndex);
    const contact = entry.type === "tg" || entry.type === "email";
    const text = entry.anchorText ?? "";
    if (!contact) {
      const token = matchingToken(text, tokens);
      if (token !== null) {
        if (line !== undefined && (seenLines.has(line.n) || citedLines.has(line.n))) return;
        if (line !== undefined) seenLines.add(line.n);
        hits.push({ where: "anchor", n: line?.n ?? null, token: tokenText(token), text });
        return;
      }
    }
    if (line !== undefined)
      lineHit(line, contact && text.length > 0 ? line.text.split(text).join(" ") : line.text);
  });
  for (const n of headLineNumbers(post)) lineHit(lines[n - 1]);
  return hits.sort((a, b) => (a.n ?? Number.MAX_SAFE_INTEGER) - (b.n ?? Number.MAX_SAFE_INTEGER));
}
