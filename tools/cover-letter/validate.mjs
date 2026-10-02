import { candidateConstraintFindings } from "../candidate/constraints.mjs";
import {
  candidateConfigValue,
  candidateLanguages,
  loadCandidateConfig,
} from "../candidate/load.mjs";
import { scriptPattern } from "../candidate/languages.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });
const wordCharacterPattern = /[\p{L}\p{M}\p{N}\p{Pc}\p{Cf}]/u;

export const coverLetterValidationContract = Object.freeze({
  forbiddenTypography: Object.freeze(["—", "–", "“", "”", "‘", "’", "«", "»", "…", "--"]),
  forbiddenTerms: Object.freeze([
    "Cursor",
    "excited",
    "thrilled",
    "passionate",
    "perfect fit",
    "cost of error",
    "high-stakes product",
    "bugs are expensive",
  ]),
});

/**
 * What this engine forbids a letter to contain, each list with the predicate that owns it.
 *
 * The candidate layer is refused a constraint that makes required what these forbid
 * (`assertCandidateConstraintsCompatible`). The predicates travel with the lists rather than being
 * reimplemented there, because typography is matched as a plain substring and a term as a whole
 * term across paragraphs: a single reimplemented predicate would refuse a layer this file accepts.
 *
 * Built from `coverLetterValidationContract`, never from a second literal — the contract's own
 * comment below says why.
 */
export const coverLetterEngineForbidden = Object.freeze([
  Object.freeze({
    matches: (text, term) => String(text).includes(term),
    terms: coverLetterValidationContract.forbiddenTypography,
  }),
  Object.freeze({
    matches: (text, term) => containsForbiddenTerm(String(text), term),
    terms: coverLetterValidationContract.forbiddenTerms,
  }),
]);

/**
 * The length limits of a letter, from the candidate config. The engine holds none of these numbers:
 * a letter is measured against the values the layer shows, and a checkout without them refuses.
 *
 * `maximum` is the default upper limit every first publication meets; `approvedMaximum` bounds how
 * far an explicit user approval, journaled as a `check` waiver keyed `letter_body_words_max:<N>`,
 * may move it (task 112). `target` is the ceiling the letter procedure sets for a first
 * publication; no gate here reads it. The lower limit never moves.
 */
export function coverLetterLimitsFrom(config) {
  const value = (path) => candidateConfigValue(config, path);
  return Object.freeze({
    bodyParagraphs: Object.freeze({
      maximum: value("letter.body_paragraphs.max"),
      minimum: value("letter.body_paragraphs.min"),
    }),
    bodyWords: Object.freeze({
      approvedMaximum: value("letter.body_words.approved_max"),
      maximum: value("letter.body_words.max"),
      minimum: value("letter.body_words.min"),
      target: value("letter.body_words.target"),
    }),
  });
}

/** The same limits read from the candidate layer rooted at `root`; a broken layer throws. */
export function coverLetterLimitsFor({ root } = {}) {
  return coverLetterLimitsFrom(loadCandidateConfig({ root }).config);
}

function requireLimits(limits) {
  const numbers = [
    limits?.bodyParagraphs?.minimum,
    limits?.bodyParagraphs?.maximum,
    limits?.bodyWords?.minimum,
    limits?.bodyWords?.maximum,
    limits?.bodyWords?.approvedMaximum,
  ];
  if (!numbers.every(Number.isSafeInteger)) {
    throw new TypeError("cover letter validation needs the limits of the candidate config");
  }
  return limits;
}

/**
 * The languages a letter may be written in, each with what it is checked by, from the candidate
 * layer rooted at `root`: the default language with the configured signature, then one entry per
 * configured pack. A broken layer throws.
 */
export function coverLetterLanguagesFor({ root } = {}) {
  return candidateLanguages({ root });
}

function requireLanguages(languages) {
  const valid =
    Array.isArray(languages) &&
    languages.length > 0 &&
    languages.every(
      (language) =>
        typeof language?.name === "string" &&
        typeof language.locale === "string" &&
        typeof language.signature === "string" &&
        typeof language.subjectPrefix === "string" &&
        scriptPattern(language.script) !== null &&
        Array.isArray(language.admitsScripts),
    );
  if (!valid) {
    throw new TypeError("cover letter validation needs the languages of the candidate layer");
  }
  return languages;
}

/*
 * What a letter in one language is checked by. Its script must appear in the title and in every
 * body paragraph; the scripts of the other configured languages must not, except the ones its pack
 * admits and its own. Two languages written in one script are not told apart by this rule.
 */
function languagePolicy(languages, name) {
  const language = languages.find((entry) => entry.name === name);
  if (language === undefined) return null;
  const admitted = new Set([language.script, ...language.admitsScripts]);
  const foreign = [...new Set(languages.map((entry) => entry.script))].filter(
    (script) => !admitted.has(script),
  );
  return Object.freeze({
    foreignPatterns: Object.freeze(foreign.map(scriptPattern)),
    locale: language.locale,
    name: language.name,
    ownPattern: scriptPattern(language.script),
    signature: language.signature,
  });
}

function escapeForPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// A subject line is refused in every letter, whatever its language, by the subject word of every
// configured language: a letter pasted with a subject from another template is still pasted.
function subjectPrefixPattern(languages) {
  const words = languages.map((language) => escapeForPattern(language.subjectPrefix));
  return new RegExp(`^(?:${words.join("|")})\\s*:`, "iu");
}

const markupPatterns = Object.freeze([
  Object.freeze({
    code: "heading",
    pattern: /^\s{0,3}#{1,6}(?:\s|$)/mu,
  }),
  Object.freeze({
    code: "heading",
    pattern: /^[ \t]{0,3}(?:=+|-+)[ \t]*$/mu,
  }),
  Object.freeze({
    code: "hard-break",
    pattern: / {2,}\n/u,
  }),
  Object.freeze({
    code: "hard-break",
    pattern: /\\\n/u,
  }),
  Object.freeze({
    code: "escape",
    pattern: /\\[!-/:-@[-`{-~]/u,
  }),
  Object.freeze({
    code: "list",
    pattern: /^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/mu,
  }),
  Object.freeze({
    code: "thematic-break",
    pattern: /^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/mu,
  }),
  Object.freeze({
    code: "table",
    pattern: /^[ \t]*(?=[^\n]*\|)\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/mu,
  }),
  Object.freeze({
    code: "blockquote",
    pattern: /^\s*>\s?/mu,
  }),
  Object.freeze({
    code: "emphasis",
    pattern:
      /(?:\*[^*]+\*|(?<![\p{L}\p{N}])_(?:[^_]|_(?=[\p{L}\p{N}]))+_(?![\p{L}\p{N}])|~~(?:[^~]|~(?!~))+~~)/u,
  }),
  Object.freeze({
    code: "link",
    pattern: /\]\(/u,
  }),
  Object.freeze({
    code: "link",
    pattern: /!?\[[^\]\n]+\]\[[^\]\n]*\]/u,
  }),
  Object.freeze({
    code: "link",
    pattern: /^[ \t]{0,3}\[[^\]]*\]:[ \t]*(?:\S|$)/mu,
  }),
  Object.freeze({
    code: "link",
    pattern: /<[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}>/u,
  }),
  Object.freeze({
    code: "link",
    pattern: /(?<![<\p{L}\p{M}\p{N}])https?:\/\/[^\s<>]+/iu,
  }),
  Object.freeze({
    code: "link",
    pattern: /(?<![\p{L}\p{M}\p{N}_])www\.[^\s<>]+/iu,
  }),
  Object.freeze({
    code: "link",
    pattern:
      /(?<![<A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-])[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![>\p{L}\p{M}\p{N}_-])/u,
  }),
  Object.freeze({
    code: "code",
    pattern: /`/u,
  }),
  Object.freeze({
    code: "code",
    pattern: /^[ \t]{0,3}~{3,}/mu,
  }),
  Object.freeze({
    code: "indented-code",
    pattern: /^(?: {4}| {0,3}\t)[^\n]/mu,
  }),
  Object.freeze({
    code: "character-reference",
    pattern: /&(?:#[xX][0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]*);/u,
  }),
  Object.freeze({
    code: "html",
    pattern: /<\/?[A-Za-z]/u,
  }),
  Object.freeze({
    code: "html",
    pattern: /<!/u,
  }),
  Object.freeze({
    code: "html",
    pattern: /<\?/u,
  }),
]);

function codePointBefore(text, index) {
  if (index === 0) return "";
  const finalCodeUnit = text.charCodeAt(index - 1);
  const hasSurrogatePair =
    index >= 2 &&
    finalCodeUnit >= 0xdc00 &&
    finalCodeUnit <= 0xdfff &&
    text.charCodeAt(index - 2) >= 0xd800 &&
    text.charCodeAt(index - 2) <= 0xdbff;
  return text.slice(hasSurrogatePair ? index - 2 : index - 1, index);
}

function codePointAt(text, index) {
  const value = text.codePointAt(index);
  return value === undefined ? "" : String.fromCodePoint(value);
}

function containsWholeTerm(text, term) {
  let offset = 0;
  while (offset <= text.length - term.length) {
    const index = text.indexOf(term, offset);
    if (index === -1) return false;
    const before = codePointBefore(text, index);
    const afterIndex = index + term.length;
    const after = codePointAt(text, afterIndex);
    if (
      (!before || !wordCharacterPattern.test(before)) &&
      (!after || !wordCharacterPattern.test(after))
    ) {
      return true;
    }
    offset = index + 1;
  }
  return false;
}

function containsForbiddenTerm(text, term) {
  const lowerTerm = term.replace(/[ \t]+/gu, " ").toLocaleLowerCase("en-US");
  return text.split(/\n[ \t]*\n+/u).some((block) => {
    const normalizedBlock = block.replace(/\p{White_Space}+/gu, " ").toLocaleLowerCase("en-US");
    return containsWholeTerm(normalizedBlock, lowerTerm);
  });
}

function paragraphBlocks(lines) {
  const paragraphs = [];
  let current = [];
  const flush = () => {
    if (current.length === 0) return;
    paragraphs.push(current.join(" ").trim());
    current = [];
  };
  for (const line of lines) {
    if (line.trim() === "") flush();
    else current.push(line.trim());
  }
  flush();
  return paragraphs;
}

function wordCount(text, locale) {
  const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
  return [...segmenter.segment(text)].filter((segment) => segment.isWordLike).length;
}

function decodeLetterBytes(letterBytes, errors) {
  if (!(letterBytes instanceof Uint8Array)) {
    errors.push("cover-letter.txt must be provided as bytes");
    return null;
  }
  try {
    return decoder.decode(letterBytes);
  } catch {
    errors.push("cover-letter.txt must be valid UTF-8");
    return null;
  }
}

function usesScript(policy, text) {
  return (
    policy.ownPattern.test(text) && !policy.foreignPatterns.some((pattern) => pattern.test(text))
  );
}

function validateLanguageText(policy, title, paragraphs, errors) {
  if (!usesScript(policy, title)) {
    errors.push(`cover-letter.txt title must use ${policy.name} script`);
  }
  paragraphs.forEach((paragraph, index) => {
    if (!usesScript(policy, paragraph)) {
      errors.push(`cover-letter.txt body paragraph ${index + 1} must use ${policy.name} script`);
    }
  });
}

export const BODY_WORD_APPROVAL_KEY_PREFIX = "letter_body_words_max:";
const bodyWordApprovalKeyPattern = /^letter_body_words_max:(0|[1-9]\d*)$/u;

/*
 * Parses an approval key. Returns `{ maximum }` for a well-formed, in-range key — an absolute body
 * word count strictly above the default maximum and at most `approvedMaximum` — and `null` for
 * anything else: a percentage, an increment, or a count outside the bounded range is not an
 * approval the validator honours, so both journal transports refuse it before it is journaled.
 *
 * The form is checked before the limits are asked for, so a key of another kind is answered
 * without them: only an approval key needs to know where the range lies.
 */
export function parseBodyWordApproval(key, limits) {
  if (typeof key !== "string") return null;
  const match = bodyWordApprovalKeyPattern.exec(key);
  if (!match) return null;
  const maximum = Number(match[1]);
  const { maximum: defaultMaximum, approvedMaximum } = requireLimits(limits).bodyWords;
  if (!Number.isSafeInteger(maximum) || maximum <= defaultMaximum || maximum > approvedMaximum) {
    return null;
  }
  return { maximum };
}

function approvedBodyWordMaximum(waivers, limits) {
  let approved = null;
  for (const waiver of waivers) {
    if (waiver?.status !== "active" || waiver?.subject?.kind !== "check") continue;
    const parsed = parseBodyWordApproval(waiver.subject.key, limits);
    if (parsed === null) continue;
    if (approved === null || parsed.maximum > approved.maximum) {
      approved = { maximum: parsed.maximum, waiver };
    }
  }
  return approved;
}

function matchWaiver(waivers, subject) {
  return (
    waivers.find(
      (waiver) =>
        waiver?.status === "active" &&
        waiver?.subject?.kind === subject.kind &&
        waiver?.subject?.key === subject.key,
    ) ?? null
  );
}

/*
 * The classified variant behind validateCoverLetter. Intrinsic format, typography, markup,
 * language, and structure rules stay in `errors`; the brief-coupled keywordTerms survival subset
 * is returned as `conflicts`, and an active waiver on a conflict's exact subject downgrades it to
 * a notice naming the waiver id (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#3-conflicts-and-waivers).
 */
export function validateCoverLetterFindings(
  letterBytes,
  brief,
  { constraints = [], languages, limits, waivers = [] } = {},
) {
  // The limits and the languages are required, not defaulted: a letter measured against numbers
  // this file made up, or signed with a name it made up, would pass a gate the candidate never
  // configured.
  requireLimits(limits);
  requireLanguages(languages);
  const errors = [];
  const conflicts = [];
  const notices = [];
  // Candidate-layer findings travel their own way to the caller and are never waivable: a
  // conflict does not block a revision publication (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#3-conflicts-and-waivers), and a personal ban that a
  // revision may ignore is not a ban. The lifecycle folds this array into `errors` in both modes.
  const candidateErrors = [];
  const result = { candidateErrors, conflicts, errors, notices };
  const text = decodeLetterBytes(letterBytes, errors);
  if (text === null) return result;
  if (text.includes("\0")) errors.push("cover-letter.txt must not contain NUL bytes");

  const normalized = text.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) {
    errors.push("cover-letter.txt must use LF or CRLF line endings");
  }
  if (/[\u0085\u2028\u2029]/u.test(normalized)) {
    errors.push("cover-letter.txt must use LF or CRLF line endings");
  }
  const languagePolicyOrNull = languagePolicy(languages, brief?.role?.vacancyLanguage);
  if (!languagePolicyOrNull) {
    errors.push(
      `role.vacancyLanguage must be exactly one of ${languages.map((language) => language.name).join(", ")}`,
    );
  }

  const lines = normalized.split("\n");
  const titleIndex = lines.findIndex((line) => line.trim() !== "");
  if (titleIndex === -1) {
    errors.push("cover-letter.txt must contain a title");
    return result;
  }
  const title = lines[titleIndex];
  if (title !== title.trim()) {
    errors.push("cover-letter.txt title must not have surrounding whitespace");
  }
  if (lines[titleIndex + 1]?.trim() !== "") {
    errors.push("cover-letter.txt title must be followed by a blank line");
  }
  if (subjectPrefixPattern(languages).test(title.trim())) {
    const words = languages.map((language) => language.subjectPrefix).join(" or ");
    errors.push(`cover-letter.txt title must not use a ${words} prefix`);
  }

  for (const { code, pattern } of markupPatterns) {
    if (pattern.test(normalized)) {
      errors.push(`cover-letter.txt must not contain ${code} markup`);
    }
  }
  for (const token of coverLetterValidationContract.forbiddenTypography) {
    if (normalized.includes(token)) {
      errors.push(`cover-letter.txt must not contain forbidden typography: ${token}`);
    }
  }
  for (const term of coverLetterValidationContract.forbiddenTerms) {
    if (containsForbiddenTerm(normalized, term)) {
      errors.push(`cover-letter.txt must not contain forbidden term: ${term}`);
    }
  }
  candidateErrors.push(
    ...candidateConstraintFindings(constraints, normalized, { artifact: "cover-letter.txt" }),
  );

  let signatureIndex = lines.length - 1;
  while (signatureIndex >= 0 && lines[signatureIndex].trim() === "") signatureIndex -= 1;
  const signature = signatureIndex >= 0 ? lines[signatureIndex] : "";
  if (languagePolicyOrNull && signature !== languagePolicyOrNull.signature) {
    errors.push(`cover-letter.txt signature must be exactly ${languagePolicyOrNull.signature}`);
  }
  if (signatureIndex <= titleIndex || lines[signatureIndex - 1]?.trim() !== "") {
    errors.push("cover-letter.txt signature must be preceded by a blank line");
  }

  const bodyLines = lines.slice(titleIndex + 2, Math.max(titleIndex + 2, signatureIndex - 1));
  const paragraphs = paragraphBlocks(bodyLines);
  const { bodyParagraphs } = limits;
  if (paragraphs.length < bodyParagraphs.minimum || paragraphs.length > bodyParagraphs.maximum) {
    errors.push(
      `cover-letter.txt body must contain ${bodyParagraphs.minimum} to ${bodyParagraphs.maximum} paragraphs`,
    );
  }
  if (languagePolicyOrNull) {
    const count = wordCount(paragraphs.join("\n"), languagePolicyOrNull.locale);
    const { minimum, maximum } = limits.bodyWords;
    const approval = approvedBodyWordMaximum(waivers, limits);
    const effectiveMaximum = approval === null ? maximum : approval.maximum;
    if (count < minimum || count > effectiveMaximum) {
      errors.push(`cover-letter.txt body must contain ${minimum} to ${maximum} words`);
    } else if (count > maximum) {
      notices.push({
        code: "letter_body_words",
        subject: structuredClone(approval.waiver.subject),
        message: `cover-letter.txt body has ${count} words over the ${maximum} default, within the approved ${approval.maximum}`,
        waiver_id: approval.waiver.id,
      });
    }
    validateLanguageText(languagePolicyOrNull, title, paragraphs, errors);
  }

  const keywordTerms = brief?.coverLetterPlan?.keywordTerms;
  if (!Array.isArray(keywordTerms) || keywordTerms.length === 0) {
    errors.push("application brief must define coverLetterPlan.keywordTerms");
  } else {
    const body = paragraphs.join("\n");
    for (const [index, term] of keywordTerms.entries()) {
      if (typeof term !== "string" || term.length === 0 || !containsWholeTerm(body, term)) {
        const finding = {
          code: "letter_keyword",
          subject: { kind: "check", key: `letter_keyword:${index}` },
          message: `cover-letter.txt body must contain planned keyword at index ${index}`,
        };
        const waiver = matchWaiver(waivers, finding.subject);
        if (waiver) notices.push({ ...finding, waiver_id: waiver.id });
        else conflicts.push(finding);
      }
    }
  }

  return result;
}

export function validateCoverLetter(letterBytes, brief, options = {}) {
  const { candidateErrors, conflicts, errors } = validateCoverLetterFindings(
    letterBytes,
    brief,
    options,
  );
  // The candidate findings belong in the flat list too: this is the shape the skill's dry run
  // reads, and a dry run that came back green over a publication that refuses would be worse
  // than no dry run at all.
  return [...errors, ...candidateErrors, ...conflicts.map((conflict) => conflict.message)];
}
