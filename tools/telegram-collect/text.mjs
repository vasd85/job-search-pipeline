// Text normalisation shared by the link marks, the repost rule and the choice of a post's title.
//
// Two posts are "the same text" for the collector when they are equal after this normalisation, so
// it lives in one place: a mark computed over one spelling and a fingerprint over another would
// disagree about which posts differ.

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const WORD = /[\p{L}\p{N}]+/gu;
const HASHTAG = /#[\p{L}\p{N}_]+/gu;

export function normalizeLine(line) {
  return String(line ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(INVISIBLE, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** The non-empty lines of a post, normalised, in post order. */
export function normalizedLines(post) {
  return post.lines.map(normalizeLine).filter((line) => line.length > 0);
}

export function normalizedText(post) {
  return normalizedLines(post).join("\n");
}

/** Letters and digits only: punctuation and emoji never tell two posts apart. */
export function wordsOf(text) {
  return text.match(WORD) ?? [];
}

export function hasText(post) {
  return post.lines.some((line) => line.length > 0);
}

export function firstLineOf(post) {
  return post.lines.find((line) => line.length > 0) ?? "";
}

/**
 * Does the line say anything once its hashtags are taken out? A row of `#vacancy #qa` says nothing,
 * and `Stack: C#, .NET` says plenty - a `#` with no word glued after it is not a hashtag at all.
 */
export function hasWordBeyondHashtags(line) {
  return wordsOf(String(line ?? "").replace(HASHTAG, " ")).length > 0;
}

/**
 * The line a post is named by: the first that says something of its own. Full texts and digests
 * often open with a row of hashtags, and `#digest` names no vacancy. A post that is hashtags and
 * nothing else keeps its first line - there is nothing better to show.
 */
export function titleLineOf(post) {
  return post.lines.find((line) => hasWordBeyondHashtags(line)) ?? firstLineOf(post);
}
