/*
 * Which text in a CV is a link, and where it points (backlog task 098).
 *
 * Every link a CV states renders as a hyperlink, and the author never marks one: the link is
 * derived from the text. `render.js` emits the hyperlinks from this module and `docx-extract.mjs`
 * checks a document's hyperlinks against it, so the rule exists once. A mirror of it — the way the
 * punctuation list is mirrored — could drift in the one direction the pair's round trip does not
 * see: text both sides fail to link.
 *
 * Node built-ins only, like the extractor that imports it.
 *
 * The rule is deliberately narrower than "anything a browser would accept". Four shapes link:
 *
 *   1. `http://` or `https://` and a host — the text is the target;
 *   2. `www.` and a host — `https://` is prepended;
 *   3. a scheme-less `host.tld/path` whose host is lowercase and whose TLD is listed below —
 *      `https://` is prepended;
 *   4. an e-mail address whose domain passes the same host rule — `mailto:` is prepended.
 *
 * Rule 3 needs both the path and the list because a CV is full of dotted names: `Booking.com`
 * has no path, `Node.js/TypeScript` and `package.json/yaml` have no listed TLD, and `ASP.NET/C#`
 * and `Socket.IO/REST` are not lowercase hosts. A URL outside rule 3 links once it is written with
 * its scheme.
 */

export const LINK_TLDS = Object.freeze([
  "com",
  "org",
  "net",
  "io",
  "dev",
  "ai",
  "app",
  "me",
  "co",
  "ru",
  "ge",
  "eu",
]);

const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const host = (tld) => `${LABEL}(?:\\.${LABEL})*\\.(?<${tld}>[a-z]{2,})(?![A-Za-z0-9-])`;

/*
 * The lookbehind is the left boundary: a match never starts inside a word, a host, a path or an
 * address, so the `gmail.com` of an e-mail and the `www.` of `https://www.` never open one.
 */
const CANDIDATE = new RegExp(
  "(?<![\\p{L}\\p{N}_.\\/@:+%-])(?:" +
    "(?<scheme>[Hh][Tt][Tt][Pp][Ss]?:\\/\\/[A-Za-z0-9]\\S*)" +
    "|(?<www>[Ww][Ww][Ww]\\.[A-Za-z0-9]\\S*)" +
    `|(?<email>[A-Za-z0-9._%+-]+@${host("emailTld")})` +
    `|(?<bare>${host("bareTld")}\\/\\S*)` +
    ")",
  "gu",
);

const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"']);
const CLOSERS = Object.freeze({ ")": "(", "]": "[", "}": "{" });

function count(text, character) {
  return text.split(character).length - 1;
}

// A sentence ends after the link, not inside it: `(https://example.com/x).` links the address.
function trimTrailing(text) {
  let trimmed = text;
  for (;;) {
    const last = trimmed.at(-1);
    if (TRAILING.has(last)) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener && count(trimmed, last) > count(trimmed, opener)) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }
    return trimmed;
  }
}

function linkAt(match) {
  const { scheme, www, email, bare, emailTld, bareTld } = match.groups;
  if (scheme !== undefined) {
    const text = trimTrailing(scheme);
    return /:\/\/[A-Za-z0-9]/.test(text) ? { text, href: text } : null;
  }
  if (www !== undefined) {
    const text = trimTrailing(www);
    return /^www\.[A-Za-z0-9-]+\./i.test(text) ? { text, href: `https://${text}` } : null;
  }
  if (email !== undefined) {
    return LINK_TLDS.includes(emailTld) ? { text: email, href: `mailto:${email}` } : null;
  }
  if (!LINK_TLDS.includes(bareTld)) return null;
  const text = trimTrailing(bare);
  return { text, href: `https://${text}` };
}

/*
 * The text as consecutive segments, each `{ text, href }` with `href` null for plain text. The
 * segments always join back to the input, and an input with no link — the empty string included —
 * is one plain segment, so a caller emitting one run per segment emits what it emitted before.
 */
export function linkSegments(value) {
  const text = String(value);
  const segments = [];
  let cursor = 0;
  CANDIDATE.lastIndex = 0;
  for (let match = CANDIDATE.exec(text); match; match = CANDIDATE.exec(text)) {
    const link = linkAt(match);
    if (!link) {
      // A rejected candidate may still hide a real one further in, so resume one position later.
      CANDIDATE.lastIndex = match.index + 1;
      continue;
    }
    if (match.index > cursor) segments.push({ text: text.slice(cursor, match.index), href: null });
    segments.push(link);
    cursor = match.index + link.text.length;
    CANDIDATE.lastIndex = cursor;
  }
  if (cursor < text.length || segments.length === 0) {
    segments.push({ text: text.slice(cursor), href: null });
  }
  return segments;
}

/*
 * The links a sequence of runs renders with, as `{ start, end, href }` offsets into the runs'
 * joined display text. Each run is derived on its own, exactly as the renderer emits one run per
 * source value; `upper` is the section heading, whose display text is uppercased per segment while
 * the target keeps the source spelling.
 */
export function runLinks(runTexts, { upper = false } = {}) {
  const links = [];
  let offset = 0;
  for (const runText of runTexts) {
    for (const segment of linkSegments(runText)) {
      const length = (upper ? segment.text.toUpperCase() : segment.text).length;
      if (segment.href !== null)
        links.push({ start: offset, end: offset + length, href: segment.href });
      offset += length;
    }
  }
  return links;
}
