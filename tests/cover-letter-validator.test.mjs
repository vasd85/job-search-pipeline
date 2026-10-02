import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { candidateExampleRootFor } from "../tools/candidate/load.mjs";
import {
  coverLetterEngineForbidden,
  coverLetterLanguagesFor,
  coverLetterLimitsFor,
  coverLetterLimitsFrom,
  coverLetterValidationContract,
  parseBodyWordApproval,
  validateCoverLetter as validateCoverLetterWith,
  validateCoverLetterFindings as validateCoverLetterFindingsWith,
} from "../tools/cover-letter/validate.mjs";
import {
  candidateConstraintsFor,
  parseCandidateConstraints,
  selectCandidateConstraints,
} from "../tools/candidate/constraints.mjs";

const encoder = new TextEncoder();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The limits and the languages come from the tracked example, never from the operator's real layer.
// The example configures Greek beside the default language, so a letter in a configured language is
// a Greek one here. The letters below are written for them; the two wrappers pass them so each case
// states only what it is about.
const exampleLimits = coverLetterLimitsFor({ root: candidateExampleRootFor(repoRoot) });
const exampleLanguages = coverLetterLanguagesFor({ root: candidateExampleRootFor(repoRoot) });
// The signatures are the example's own name, which a test never quotes: the publishability scan
// treats it as a personal marker. They are read from the layer.
const [defaultSignature, greekSignature] = exampleLanguages.map((language) => language.signature);
const validateCoverLetter = (letterBytes, brief, options = {}) =>
  validateCoverLetterWith(letterBytes, brief, {
    languages: exampleLanguages,
    limits: exampleLimits,
    ...options,
  });
const validateCoverLetterFindings = (letterBytes, brief, options = {}) =>
  validateCoverLetterFindingsWith(letterBytes, brief, {
    languages: exampleLanguages,
    limits: exampleLimits,
    ...options,
  });
const expectedContract = Object.freeze({
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

const expectedScenarioIds = Object.freeze([
  "invalid-byte-type",
  "invalid-utf8",
  "nul-byte",
  "lone-carriage-return",
  "unicode-next-line",
  "unicode-line-separator",
  "unicode-paragraph-separator",
  "unknown-language",
  "language-case-drift",
  "missing-title",
  "title-surrounding-whitespace",
  "missing-blank-after-title",
  "english-subject-prefix",
  "greek-subject-prefix",
  "heading-markup",
  "setext-heading-markup",
  "setext-hyphen-heading-markup",
  "two-space-hard-break-markup",
  "backslash-hard-break-markup",
  "backslash-escape-markup",
  "list-markup",
  "asterisk-list-markup",
  "plus-list-markup",
  "ordered-list-period-markup",
  "ordered-list-parenthesis-markup",
  "thematic-break-asterisk-markup",
  "thematic-break-underscore-markup",
  "thematic-break-hyphen-markup",
  "table-markup",
  "single-column-table-markup",
  "short-delimiter-table-markup",
  "one-sided-single-column-table-markup",
  "blockquote-markup",
  "asterisk-emphasis-markup",
  "underscore-emphasis-markup",
  "strike-markup",
  "multiline-asterisk-emphasis-markup",
  "multiline-underscore-emphasis-markup",
  "multiline-strike-markup",
  "internal-underscore-emphasis-markup",
  "internal-tilde-strike-markup",
  "link-markup",
  "empty-destination-link-markup",
  "multiline-link-markup",
  "nested-link-label-markup",
  "escaped-closing-bracket-link-markup",
  "reference-link-markup",
  "reference-definition-markup",
  "reference-definition-no-space-markup",
  "multiline-reference-definition-markup",
  "multiline-reference-label-definition-markup",
  "angle-email-autolink-markup",
  "angle-punctuation-email-autolink-markup",
  "gfm-bare-url-autolink-markup",
  "gfm-www-autolink-markup",
  "gfm-email-autolink-markup",
  "gfm-punctuation-email-autolink-markup",
  "code-markup",
  "tilde-code-fence-markup",
  "tilde-code-fence-info-markup",
  "four-space-indented-code-markup",
  "tab-indented-code-markup",
  "space-tab-indented-code-markup",
  "named-character-reference-markup",
  "hex-character-reference-markup",
  "decimal-character-reference-markup",
  "html-markup",
  "html-doctype-markup",
  "html-comment-markup",
  "html-processing-instruction-markup",
  "html-unclosed-processing-instruction-markup",
  "html-unclosed-declaration-markup",
  "html-unclosed-cdata-markup",
  "html-multiline-tag-markup",
  "html-multiline-doctype-markup",
  "english-title-greek",
  "english-title-without-latin",
  "greek-title-without-greek",
  "english-body-greek",
  "english-body-without-latin",
  "greek-body-without-greek",
  "three-paragraphs",
  "six-paragraphs",
  "229-body-words",
  "261-body-words",
  "wrong-english-signature",
  "wrong-greek-signature",
  "signature-without-blank-line",
  "missing-keyword",
  "keyword-substring-only",
  "keyword-connector-continuation-only",
  "keyword-combining-mark-continuation-only",
  "keyword-zero-width-non-joiner-continuation-only",
  "keyword-zero-width-joiner-continuation-only",
  "keyword-format-continuation-only",
  "keyword-word-joiner-continuation-only",
  "keyword-format-before-continuation-only",
  "keyword-word-joiner-before-continuation-only",
  "keyword-astral-letter-before-continuation-only",
  "keyword-astral-letter-after-continuation-only",
  "keyword-title-only",
  "keyword-signature-only",
  "empty-keyword",
  "english-keyword-typescript-omitted",
  "english-keyword-playwright-omitted",
  "english-keyword-api-testing-omitted",
  "greek-keyword-automation-omitted",
  "greek-keyword-api-testing-omitted",
  "greek-keyword-strategy-omitted",
  "typography-em-dash",
  "typography-en-dash",
  "typography-left-double-quote",
  "typography-right-double-quote",
  "typography-left-single-quote",
  "typography-right-single-quote",
  "typography-left-angle-quote",
  "typography-right-angle-quote",
  "typography-ellipsis",
  "typography-double-hyphen",
  "term-cursor",
  "term-excited",
  "term-thrilled",
  "term-passionate",
  "term-perfect-fit",
  "term-cost-of-error",
  "term-high-stakes-product",
  "term-bugs-are-expensive",
  "term-perfect-fit-no-break-space",
  "term-perfect-fit-thin-space",
  "term-perfect-fit-multiple-spaces",
  "term-perfect-fit-line-wrap",
  "term-cost-of-error-line-wrap",
  "term-high-stakes-product-line-wrap",
  "term-bugs-are-expensive-line-wrap",
]);

function makeBrief(language = "English", keywordTerms) {
  return {
    role: { vacancyLanguage: language },
    coverLetterPlan: {
      keywordTerms:
        keywordTerms ??
        (language === "Greek"
          ? ["αυτοματισμός", "δοκιμές API", "στρατηγική"]
          : ["TypeScript", "Playwright", "API testing"]),
    },
  };
}

function makeBodyWords(language, count) {
  const required =
    language === "Greek"
      ? ["αυτοματισμός", "δοκιμές", "API", "στρατηγική"]
      : ["TypeScript", "Playwright", "API", "testing"];
  const filler = language === "Greek" ? "ποιότητα" : "quality";
  return [...required, ...Array(Math.max(0, count - required.length)).fill(filler)].slice(0, count);
}

function splitParagraphs(words, count) {
  const paragraphs = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const remaining = words.length - offset;
    const slots = count - index;
    const size = Math.ceil(remaining / slots);
    paragraphs.push(words.slice(offset, offset + size).join(" "));
    offset += size;
  }
  return paragraphs;
}

function makeLetter({
  language = "English",
  words = 240,
  paragraphCount = 4,
  title,
  signature,
  paragraphs,
  blankAfterTitle = true,
  blankBeforeSignature = true,
  trailingNewline = true,
} = {}) {
  const greek = language === "Greek";
  const resolvedTitle =
    title ?? (greek ? "Αξιόπιστη μηχανική ποιότητας" : "Reliable Quality Engineering");
  const resolvedSignature = signature ?? (greek ? greekSignature : defaultSignature);
  const resolvedParagraphs =
    paragraphs ?? splitParagraphs(makeBodyWords(language, words), paragraphCount);
  return [
    resolvedTitle,
    ...(blankAfterTitle ? [""] : []),
    ...resolvedParagraphs.flatMap((paragraph, index) =>
      index === resolvedParagraphs.length - 1 ? [paragraph] : [paragraph, ""],
    ),
    ...(blankBeforeSignature ? [""] : []),
    resolvedSignature,
    ...(trailingNewline ? [""] : []),
  ].join("\n");
}

function replaceFirstBodyWord(letter, replacement) {
  const lines = letter.split("\n");
  const firstBodyIndex = lines.findIndex((line, index) => index >= 2 && line !== "");
  lines[firstBodyIndex] = lines[firstBodyIndex].replace(/^\S+/u, replacement);
  return lines.join("\n");
}

function bytes(text) {
  return encoder.encode(text);
}

function assertHasExactError(letterBytes, brief, expectedError) {
  const errors = validateCoverLetter(letterBytes, brief);
  assert.ok(
    errors.includes(expectedError),
    `expected exact error ${JSON.stringify(expectedError)}; received ${JSON.stringify(errors)}`,
  );
}

test("the letter gate reads its languages from the layer and refuses to run without them", () => {
  // The example configures Greek beside the default language; nothing in the engine names it.
  assert.deepEqual(
    exampleLanguages.map((language) => language.name),
    ["English", "Greek"],
  );
  const refusal = "role.vacancyLanguage must be exactly one of English, Greek";
  for (const { name } of exampleLanguages) {
    const { errors } = validateCoverLetterFindings(
      encoder.encode("Title\n\nBody.\n"),
      makeBrief(name),
    );
    assert.equal(errors.includes(refusal), false, `${name} is refused by the letter gate`);
  }
  for (const token of ["en", "German", "greek"]) {
    const { errors } = validateCoverLetterFindings(
      encoder.encode("Title\n\nBody.\n"),
      makeBrief(token),
    );
    assert.ok(errors.includes(refusal), `${token} is accepted by the letter gate`);
  }
  // No languages, no letter: a signature this file made up would pass a gate the candidate never
  // configured.
  const letter = bytes(makeLetter());
  assert.throws(
    () => validateCoverLetterWith(letter, makeBrief(), { limits: exampleLimits }),
    TypeError,
  );
  assert.throws(
    () => validateCoverLetterWith(letter, makeBrief(), { languages: [], limits: exampleLimits }),
    TypeError,
  );
});

// A language beside the example's, described here rather than in a pack: the rule is the engine's,
// and what it decides depends only on the scripts of the languages a layer configures.
const cyrillicLanguage = Object.freeze({
  admitsScripts: Object.freeze(["Latin"]),
  locale: "bg",
  name: "Bulgarian",
  script: "Cyrillic",
  signature: "Кандидат",
  subjectPrefix: "Относно",
});

function languageErrors(letter, language, languages) {
  return validateCoverLetterWith(bytes(letter), makeBrief(language, ["Playwright"]), {
    languages,
    limits: exampleLimits,
  }).filter((error) => error.includes("script"));
}

test("a letter carries its own script, and the scripts of the other configured languages only where its pack admits them", () => {
  const englishWith = (word) => replaceFirstBodyWord(makeLetter({ paragraphs: undefined }), word);
  const withCyrillic = [...exampleLanguages, cyrillicLanguage];
  // The default language admits no other script: a word of a configured language's script refuses it.
  assert.deepEqual(languageErrors(englishWith("ποιότητα"), "English", exampleLanguages), [
    "cover-letter.txt body paragraph 1 must use English script",
  ]);
  assert.deepEqual(languageErrors(englishWith("качество"), "English", withCyrillic), [
    "cover-letter.txt body paragraph 1 must use English script",
  ]);
  // A script no configured language uses is not the rule's business: a layer with only the default
  // language does not refuse it, which is the price of naming no second language in the engine.
  assert.deepEqual(languageErrors(englishWith("качество"), "English", exampleLanguages), []);
  assert.deepEqual(languageErrors(englishWith("ποιότητα"), "English", [exampleLanguages[0]]), []);
  // A configured language needs its own script and may carry the ones its pack admits.
  const greekWithLatin = replaceFirstBodyWord(baseGreekLetter, "Playwright");
  assert.deepEqual(languageErrors(greekWithLatin, "Greek", withCyrillic), []);
  const greekWithCyrillic = baseGreekLetter.replace(
    "Αξιόπιστη μηχανική ποιότητας",
    "Αξιόπιστη μηχανική качество",
  );
  assert.deepEqual(languageErrors(greekWithCyrillic, "Greek", withCyrillic), [
    "cover-letter.txt title must use Greek script",
  ]);
  assert.deepEqual(languageErrors(greekWithCyrillic, "Greek", exampleLanguages), []);
});

test("every configured subject word refuses a title in every letter, and each letter is signed in its own language", () => {
  const withCyrillic = [...exampleLanguages, cyrillicLanguage];
  for (const title of [
    "Subject: Reliable tests",
    "Θέμα: Reliable tests",
    "Относно: Reliable tests",
    "subject : Reliable tests",
  ]) {
    const errors = validateCoverLetterWith(bytes(makeLetter({ title })), makeBrief(), {
      languages: withCyrillic,
      limits: exampleLimits,
    });
    assert.ok(
      errors.includes("cover-letter.txt title must not use a Subject or Θέμα or Относно prefix"),
      `${title} is not refused`,
    );
  }
  // The subject word is escaped: a pack's word is text, never a pattern.
  const dotted = { ...cyrillicLanguage, subjectPrefix: "Re." };
  const errors = validateCoverLetterWith(
    bytes(makeLetter({ title: "Rex: Reliable tests" })),
    makeBrief(),
    {
      languages: [...exampleLanguages, dotted],
      limits: exampleLimits,
    },
  );
  assert.equal(
    errors.some((error) => error.includes("prefix")),
    false,
  );
  // The default language is signed with the config's signature, a configured one with its pack's,
  // each read here straight from its file.
  const example = candidateExampleRootFor(repoRoot);
  assert.deepEqual(
    exampleLanguages.map((language) => language.signature),
    [
      JSON.parse(readFileSync(join(example, "config.json"), "utf8")).letter.signature,
      JSON.parse(readFileSync(join(example, "languages", "Greek", "pack.json"), "utf8")).signature,
    ],
  );
  assert.notEqual(defaultSignature, greekSignature);
});

test("cover-letter public contract is pinned by independent literals", () => {
  assert.deepEqual(coverLetterValidationContract, expectedContract);
  // The length limits are the candidate's: the example carries these, and the engine carries none.
  assert.deepEqual(exampleLimits, {
    bodyParagraphs: { maximum: 5, minimum: 4 },
    bodyWords: { approvedMaximum: 300, maximum: 260, minimum: 230, target: 250 },
  });
});

test("the letter gate measures against the limits it is given and refuses to run without them", () => {
  const limits = coverLetterLimitsFrom({
    letter: {
      body_paragraphs: { max: 3, min: 2 },
      body_words: { approved_max: 150, max: 130, min: 100, target: 120 },
    },
  });
  const brief = makeBrief();
  const short = bytes(makeLetter({ words: 110, paragraphCount: 3 }));
  // What the example's limits refuse, these accept, and the other way round.
  assert.deepEqual(
    validateCoverLetterWith(short, brief, { languages: exampleLanguages, limits }),
    [],
  );
  assert.deepEqual(validateCoverLetter(short, brief), [
    "cover-letter.txt body must contain 4 to 5 paragraphs",
    "cover-letter.txt body must contain 230 to 260 words",
  ]);
  assert.deepEqual(
    validateCoverLetterWith(bytes(baseEnglishLetter), brief, {
      languages: exampleLanguages,
      limits,
    }),
    [
      "cover-letter.txt body must contain 2 to 3 paragraphs",
      "cover-letter.txt body must contain 100 to 130 words",
    ],
  );
  // The approval range moves with the limits.
  assert.deepEqual(parseBodyWordApproval("letter_body_words_max:140", limits), { maximum: 140 });
  assert.equal(parseBodyWordApproval("letter_body_words_max:151", limits), null);
  assert.equal(parseBodyWordApproval("letter_body_words_max:280", limits), null);
  assert.deepEqual(parseBodyWordApproval("letter_body_words_max:280", exampleLimits), {
    maximum: 280,
  });
  // No limits, no measurement: a number chosen here would gate a letter the candidate never sized.
  assert.throws(() => validateCoverLetterWith(short, brief), TypeError);
  assert.throws(() => validateCoverLetterFindingsWith(short, brief, { waivers: [] }), TypeError);
  // Refused before anything is read, so bytes the gate would reject early do not slip through.
  assert.throws(() => validateCoverLetterFindingsWith(new Uint8Array([0xff]), brief), TypeError);
  assert.throws(() => parseBodyWordApproval("letter_body_words_max:280"), TypeError);
  // A partial set is no set: without the cap an approval of any size would parse.
  const { approvedMaximum: _cap, ...uncapped } = exampleLimits.bodyWords;
  assert.throws(
    () =>
      parseBodyWordApproval("letter_body_words_max:5000", {
        ...exampleLimits,
        bodyWords: uncapped,
      }),
    TypeError,
  );
  // A key of another kind is answered without the limits: only an approval needs the range.
  assert.equal(parseBodyWordApproval("letter_keyword:0"), null);
});

test("valid English and Greek letters pass at every numeric boundary", () => {
  for (const [language, words, paragraphCount] of [
    ["English", 230, 4],
    ["English", 260, 5],
    ["Greek", 230, 4],
    ["Greek", 260, 5],
  ]) {
    assert.deepEqual(
      validateCoverLetter(
        bytes(makeLetter({ language, words, paragraphCount })),
        makeBrief(language),
      ),
      [],
      `${language} ${words} words ${paragraphCount} paragraphs`,
    );
  }
});

const baseEnglishLetter = makeLetter();
const baseGreekLetter = makeLetter({ language: "Greek" });
const baseEnglishParagraphs = splitParagraphs(makeBodyWords("English", 240), 4);
const baseGreekParagraphs = splitParagraphs(makeBodyWords("Greek", 240), 4);

const mutationScenarios = [
  {
    id: "invalid-byte-type",
    letterBytes: "not bytes",
    brief: makeBrief(),
    error: "cover-letter.txt must be provided as bytes",
  },
  {
    id: "invalid-utf8",
    letterBytes: new Uint8Array([0xc3, 0x28]),
    brief: makeBrief(),
    error: "cover-letter.txt must be valid UTF-8",
  },
  {
    id: "nul-byte",
    letter: replaceFirstBodyWord(baseEnglishLetter, "quality\0"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain NUL bytes",
  },
  {
    id: "lone-carriage-return",
    letter: baseEnglishLetter.replace("\n\n", "\r\n\r"),
    brief: makeBrief(),
    error: "cover-letter.txt must use LF or CRLF line endings",
  },
  ...[
    ["unicode-next-line", "\u0085"],
    ["unicode-line-separator", "\u2028"],
    ["unicode-paragraph-separator", "\u2029"],
  ].map(([id, token]) => ({
    id,
    letter: baseEnglishLetter.replace("Reliable Quality", `Reliable${token}Quality`),
    brief: makeBrief(),
    error: "cover-letter.txt must use LF or CRLF line endings",
  })),
  {
    id: "unknown-language",
    letter: baseEnglishLetter,
    brief: makeBrief("German"),
    error: "role.vacancyLanguage must be exactly one of English, Greek",
  },
  {
    id: "language-case-drift",
    letter: baseEnglishLetter,
    brief: makeBrief("english"),
    error: "role.vacancyLanguage must be exactly one of English, Greek",
  },
  {
    id: "missing-title",
    letter: "\n\n",
    brief: makeBrief(),
    error: "cover-letter.txt must contain a title",
  },
  {
    id: "title-surrounding-whitespace",
    letter: makeLetter({ title: " Reliable Quality Engineering " }),
    brief: makeBrief(),
    error: "cover-letter.txt title must not have surrounding whitespace",
  },
  {
    id: "missing-blank-after-title",
    letter: makeLetter({ blankAfterTitle: false }),
    brief: makeBrief(),
    error: "cover-letter.txt title must be followed by a blank line",
  },
  {
    id: "english-subject-prefix",
    letter: makeLetter({ title: "Subject: Reliable Quality Engineering" }),
    brief: makeBrief(),
    error: "cover-letter.txt title must not use a Subject or Θέμα prefix",
  },
  {
    id: "greek-subject-prefix",
    letter: makeLetter({ language: "Greek", title: "Θέμα: Αξιόπιστη μηχανική ποιότητας" }),
    brief: makeBrief("Greek"),
    error: "cover-letter.txt title must not use a Subject or Θέμα prefix",
  },
  {
    id: "heading-markup",
    letter: makeLetter({ title: "# Reliable Quality Engineering" }),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain heading markup",
  },
  {
    id: "setext-heading-markup",
    letter: makeLetter({ paragraphs: ["Quality heading\n===", ...baseEnglishParagraphs] }),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain heading markup",
  },
  {
    id: "setext-hyphen-heading-markup",
    letter: baseEnglishLetter.replace("TypeScript", "TypeScript\n-\n"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain heading markup",
  },
  {
    id: "two-space-hard-break-markup",
    letter: baseEnglishLetter.replace("TypeScript Playwright", "TypeScript  \nPlaywright"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain hard-break markup",
  },
  {
    id: "backslash-hard-break-markup",
    letter: baseEnglishLetter.replace("TypeScript Playwright", "TypeScript\\\nPlaywright"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain hard-break markup",
  },
  {
    id: "backslash-escape-markup",
    letter: baseEnglishLetter.replace("TypeScript", "\\*TypeScript"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain escape markup",
  },
  {
    id: "list-markup",
    letter: makeLetter({ paragraphs: ["- quality", ...baseEnglishParagraphs.slice(1)] }),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain list markup",
  },
  ...[
    ["asterisk-list-markup", "*"],
    ["plus-list-markup", "+"],
    ["ordered-list-period-markup", "1."],
  ].map(([id, marker]) => ({
    id,
    letter: makeLetter({ paragraphs: [`${marker} quality`, ...baseEnglishParagraphs.slice(1)] }),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain list markup",
  })),
  {
    id: "ordered-list-parenthesis-markup",
    letter: makeLetter({ paragraphs: ["1) quality", ...baseEnglishParagraphs.slice(1)] }),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain list markup",
  },
  ...[
    ["thematic-break-asterisk-markup", "***"],
    ["thematic-break-underscore-markup", "___"],
    ["thematic-break-hyphen-markup", "---"],
  ].map(([id, marker]) => ({
    id,
    letter: makeLetter({ paragraphs: [marker, ...baseEnglishParagraphs] }),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain thematic-break markup",
  })),
  {
    id: "table-markup",
    letter: baseEnglishLetter.replace(
      "TypeScript Playwright",
      "TypeScript | Playwright\n--- | ---\nquality | API testing",
    ),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain table markup",
  },
  {
    id: "single-column-table-markup",
    letter: baseEnglishLetter.replace(
      "TypeScript Playwright",
      "| TypeScript |\n| --- |\n| Playwright |",
    ),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain table markup",
  },
  {
    id: "short-delimiter-table-markup",
    letter: baseEnglishLetter.replace(
      "TypeScript Playwright",
      "TypeScript | Playwright\n- | -\nquality | API testing",
    ),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain table markup",
  },
  {
    id: "one-sided-single-column-table-markup",
    letter: baseEnglishLetter.replace("TypeScript Playwright", "| TypeScript\n| ---\n| Playwright"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain table markup",
  },
  {
    id: "blockquote-markup",
    letter: makeLetter({ paragraphs: ["> quality", ...baseEnglishParagraphs.slice(1)] }),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain blockquote markup",
  },
  ...[
    ["asterisk-emphasis-markup", "*quality*"],
    ["underscore-emphasis-markup", "_quality_"],
    ["strike-markup", "~~quality~~"],
  ].map(([id, token]) => ({
    id,
    letter: replaceFirstBodyWord(baseEnglishLetter, token),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain emphasis markup",
  })),
  ...[
    ["multiline-asterisk-emphasis-markup", "*TypeScript\nPlaywright*"],
    ["multiline-underscore-emphasis-markup", "_TypeScript\nPlaywright_"],
    ["multiline-strike-markup", "~~TypeScript\nPlaywright~~"],
  ].map(([id, token]) => ({
    id,
    letter: baseEnglishLetter.replace("TypeScript Playwright", token),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain emphasis markup",
  })),
  {
    id: "internal-underscore-emphasis-markup",
    letter: replaceFirstBodyWord(baseEnglishLetter, "_quality_delivery_"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain emphasis markup",
  },
  {
    id: "internal-tilde-strike-markup",
    letter: replaceFirstBodyWord(baseEnglishLetter, "~~quality~delivery~~"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain emphasis markup",
  },
  {
    id: "link-markup",
    letter: replaceFirstBodyWord(baseEnglishLetter, "[quality](/reference)"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain link markup",
  },
  {
    id: "empty-destination-link-markup",
    letter: baseEnglishLetter.replace("TypeScript", "[TypeScript]()"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain link markup",
  },
  {
    id: "multiline-link-markup",
    letter: baseEnglishLetter.replace(
      "TypeScript Playwright",
      "[TypeScript\nPlaywright](/reference)",
    ),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain link markup",
  },
  {
    id: "nested-link-label-markup",
    letter: baseEnglishLetter.replace("TypeScript", "[[TypeScript]](/reference)"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain link markup",
  },
  {
    id: "escaped-closing-bracket-link-markup",
    letter: baseEnglishLetter.replace("TypeScript", "[TypeScript \\] quality](/reference)"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain link markup",
  },
  {
    id: "reference-link-markup",
    letter: replaceFirstBodyWord(baseEnglishLetter, "[quality][reference]"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain link markup",
  },
  {
    id: "reference-definition-markup",
    letter: replaceFirstBodyWord(baseEnglishLetter, "[reference]: /reference"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain link markup",
  },
  {
    id: "reference-definition-no-space-markup",
    letter: replaceFirstBodyWord(baseEnglishLetter, "[reference]:/reference"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain link markup",
  },
  {
    id: "multiline-reference-definition-markup",
    letter: baseEnglishLetter.replace("TypeScript", "[TypeScript]\n[TypeScript]:\n  /reference"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain link markup",
  },
  {
    id: "multiline-reference-label-definition-markup",
    letter: baseEnglishLetter.replace("TypeScript", "[TypeScript\nquality]: /reference"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain link markup",
  },
  {
    id: "angle-email-autolink-markup",
    letter: replaceFirstBodyWord(baseEnglishLetter, "<1qa@example.test>"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain link markup",
  },
  {
    id: "angle-punctuation-email-autolink-markup",
    letter: replaceFirstBodyWord(baseEnglishLetter, "<_qa@example.test>"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain link markup",
  },
  {
    id: "gfm-bare-url-autolink-markup",
    letter: replaceFirstBodyWord(baseEnglishLetter, "https://example.test"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain link markup",
  },
  {
    id: "gfm-www-autolink-markup",
    letter: replaceFirstBodyWord(baseEnglishLetter, "www.example.test"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain link markup",
  },
  {
    id: "gfm-email-autolink-markup",
    letter: replaceFirstBodyWord(baseEnglishLetter, "qa@example.test"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain link markup",
  },
  {
    id: "gfm-punctuation-email-autolink-markup",
    letter: replaceFirstBodyWord(baseEnglishLetter, "_qa@example.test"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain link markup",
  },
  {
    id: "code-markup",
    letter: replaceFirstBodyWord(baseEnglishLetter, "`quality`"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain code markup",
  },
  {
    id: "tilde-code-fence-markup",
    letter: makeLetter({ paragraphs: ["~~~", ...baseEnglishParagraphs] }),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain code markup",
  },
  {
    id: "tilde-code-fence-info-markup",
    letter: makeLetter({ paragraphs: ["~~~js\nquality", ...baseEnglishParagraphs] }),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain code markup",
  },
  {
    id: "four-space-indented-code-markup",
    letter: makeLetter({ paragraphs: ["    quality", ...baseEnglishParagraphs.slice(1)] }),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain indented-code markup",
  },
  {
    id: "tab-indented-code-markup",
    letter: makeLetter({ paragraphs: ["\tquality", ...baseEnglishParagraphs.slice(1)] }),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain indented-code markup",
  },
  {
    id: "space-tab-indented-code-markup",
    letter: makeLetter({ paragraphs: [" \tquality", ...baseEnglishParagraphs.slice(1)] }),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain indented-code markup",
  },
  ...[
    ["named-character-reference-markup", "&amp;"],
    ["hex-character-reference-markup", "&#x2014;"],
    ["decimal-character-reference-markup", "perfect&#32;fit"],
  ].map(([id, token]) => ({
    id,
    letter: replaceFirstBodyWord(baseEnglishLetter, token + " TypeScript"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain character-reference markup",
  })),
  {
    id: "html-markup",
    letter: replaceFirstBodyWord(baseEnglishLetter, "<strong>quality</strong>"),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain html markup",
  },
  ...[
    ["html-doctype-markup", "<!DOCTYPE html>"],
    ["html-comment-markup", "<!-- quality -->"],
    ["html-processing-instruction-markup", "<?quality value?>"],
  ].map(([id, token]) => ({
    id,
    letter: replaceFirstBodyWord(baseEnglishLetter, token),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain html markup",
  })),
  ...[
    ["html-unclosed-processing-instruction-markup", "<?TypeScript"],
    ["html-unclosed-declaration-markup", "<!DOCTYPE TypeScript"],
    ["html-unclosed-cdata-markup", "<![CDATA[ TypeScript"],
  ].map(([id, token]) => ({
    id,
    letter: replaceFirstBodyWord(baseEnglishLetter, token),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain html markup",
  })),
  ...[
    ["html-multiline-tag-markup", "<strong\nclass=x>quality</strong>"],
    ["html-multiline-doctype-markup", "<!DOCTYPE\nhtml>"],
  ].map(([id, token]) => ({
    id,
    letter: replaceFirstBodyWord(baseEnglishLetter, token),
    brief: makeBrief(),
    error: "cover-letter.txt must not contain html markup",
  })),
  {
    id: "english-title-greek",
    letter: makeLetter({ title: "Reliable ποιότητα" }),
    brief: makeBrief(),
    error: "cover-letter.txt title must use English script",
  },
  {
    id: "english-title-without-latin",
    letter: makeLetter({ title: "12345" }),
    brief: makeBrief(),
    error: "cover-letter.txt title must use English script",
  },
  {
    id: "greek-title-without-greek",
    letter: makeLetter({ language: "Greek", title: "Reliable API" }),
    brief: makeBrief("Greek"),
    error: "cover-letter.txt title must use Greek script",
  },
  {
    id: "english-body-greek",
    letter: replaceFirstBodyWord(baseEnglishLetter, "ποιότητα"),
    brief: makeBrief(),
    error: "cover-letter.txt body paragraph 1 must use English script",
  },
  {
    id: "english-body-without-latin",
    letter: makeLetter({ paragraphs: ["123 456", ...baseEnglishParagraphs.slice(1)] }),
    brief: makeBrief(),
    error: "cover-letter.txt body paragraph 1 must use English script",
  },
  {
    id: "greek-body-without-greek",
    letter: makeLetter({
      language: "Greek",
      paragraphs: ["API 123", ...baseGreekParagraphs.slice(1)],
    }),
    brief: makeBrief("Greek"),
    error: "cover-letter.txt body paragraph 1 must use Greek script",
  },
  {
    id: "three-paragraphs",
    letter: makeLetter({ paragraphCount: 3 }),
    brief: makeBrief(),
    error: "cover-letter.txt body must contain 4 to 5 paragraphs",
  },
  {
    id: "six-paragraphs",
    letter: makeLetter({ paragraphCount: 6 }),
    brief: makeBrief(),
    error: "cover-letter.txt body must contain 4 to 5 paragraphs",
  },
  {
    id: "229-body-words",
    letter: makeLetter({ words: 229 }),
    brief: makeBrief(),
    error: "cover-letter.txt body must contain 230 to 260 words",
  },
  {
    id: "261-body-words",
    letter: makeLetter({ words: 261 }),
    brief: makeBrief(),
    error: "cover-letter.txt body must contain 230 to 260 words",
  },
  {
    id: "wrong-english-signature",
    letter: makeLetter({ signature: "Example Vasylenko" }),
    brief: makeBrief(),
    error: `cover-letter.txt signature must be exactly ${defaultSignature}`,
  },
  {
    id: "wrong-greek-signature",
    letter: makeLetter({ language: "Greek", signature: `${greekSignature}.` }),
    brief: makeBrief("Greek"),
    error: `cover-letter.txt signature must be exactly ${greekSignature}`,
  },
  {
    id: "signature-without-blank-line",
    letter: makeLetter({ blankBeforeSignature: false }),
    brief: makeBrief(),
    error: "cover-letter.txt signature must be preceded by a blank line",
  },
  {
    id: "missing-keyword",
    letter: baseEnglishLetter,
    brief: makeBrief("English", ["Selenium"]),
    error: "cover-letter.txt body must contain planned keyword at index 0",
  },
  {
    id: "keyword-substring-only",
    letter: baseEnglishLetter,
    brief: makeBrief("English", ["Play"]),
    error: "cover-letter.txt body must contain planned keyword at index 0",
  },
  {
    id: "keyword-connector-continuation-only",
    letter: baseEnglishLetter.replace("Playwright", "Play_writer"),
    brief: makeBrief("English", ["Play"]),
    error: "cover-letter.txt body must contain planned keyword at index 0",
  },
  {
    id: "keyword-combining-mark-continuation-only",
    letter: baseEnglishLetter.replace("Playwright", "Play\u0301"),
    brief: makeBrief("English", ["Play"]),
    error: "cover-letter.txt body must contain planned keyword at index 0",
  },
  {
    id: "keyword-zero-width-non-joiner-continuation-only",
    letter: baseEnglishLetter.replace("Playwright", "Play\u200cwriter"),
    brief: makeBrief("English", ["Play"]),
    error: "cover-letter.txt body must contain planned keyword at index 0",
  },
  {
    id: "keyword-zero-width-joiner-continuation-only",
    letter: baseEnglishLetter.replace("Playwright", "Play\u200dwriter"),
    brief: makeBrief("English", ["Play"]),
    error: "cover-letter.txt body must contain planned keyword at index 0",
  },
  {
    id: "keyword-format-continuation-only",
    letter: baseEnglishLetter.replace("Playwright", "Play\u00adwright"),
    brief: makeBrief("English", ["Play"]),
    error: "cover-letter.txt body must contain planned keyword at index 0",
  },
  {
    id: "keyword-word-joiner-continuation-only",
    letter: baseEnglishLetter.replace("Playwright", "Play\u2060wright"),
    brief: makeBrief("English", ["Play"]),
    error: "cover-letter.txt body must contain planned keyword at index 0",
  },
  {
    id: "keyword-format-before-continuation-only",
    letter: baseEnglishLetter.replace("Playwright", "wright\u00adPlay"),
    brief: makeBrief("English", ["Play"]),
    error: "cover-letter.txt body must contain planned keyword at index 0",
  },
  {
    id: "keyword-word-joiner-before-continuation-only",
    letter: baseEnglishLetter.replace("Playwright", "wright\u2060Play"),
    brief: makeBrief("English", ["Play"]),
    error: "cover-letter.txt body must contain planned keyword at index 0",
  },
  {
    id: "keyword-astral-letter-before-continuation-only",
    letter: baseEnglishLetter.replace("Playwright", "\u{10400}Play"),
    brief: makeBrief("English", ["Play"]),
    error: "cover-letter.txt body must contain planned keyword at index 0",
  },
  {
    id: "keyword-astral-letter-after-continuation-only",
    letter: baseEnglishLetter.replace("Playwright", "Play\u{10400}"),
    brief: makeBrief("English", ["Play"]),
    error: "cover-letter.txt body must contain planned keyword at index 0",
  },
  {
    id: "keyword-title-only",
    letter: baseEnglishLetter,
    brief: makeBrief("English", ["Reliable"]),
    error: "cover-letter.txt body must contain planned keyword at index 0",
  },
  {
    id: "keyword-signature-only",
    letter: baseEnglishLetter,
    brief: makeBrief("English", ["Example"]),
    error: "cover-letter.txt body must contain planned keyword at index 0",
  },
  {
    id: "empty-keyword",
    letter: baseEnglishLetter,
    brief: makeBrief("English", [""]),
    error: "cover-letter.txt body must contain planned keyword at index 0",
  },
  ...[
    ["english-keyword-typescript-omitted", "TypeScript", "typed", "TypeScript"],
    ["english-keyword-playwright-omitted", "Playwright", "browser", "Playwright"],
    ["english-keyword-api-testing-omitted", "API testing", "service testing", "API testing"],
  ].map(([id, from, to], index) => ({
    id,
    letter: baseEnglishLetter.replace(from, to),
    brief: makeBrief(),
    error: `cover-letter.txt body must contain planned keyword at index ${index}`,
  })),
  ...[
    ["greek-keyword-automation-omitted", "αυτοματισμός", "αξιοπιστία", "αυτοματισμός"],
    ["greek-keyword-api-testing-omitted", "δοκιμές API", "έλεγχος API", "δοκιμές API"],
    ["greek-keyword-strategy-omitted", "στρατηγική", "πρακτική", "στρατηγική"],
  ].map(([id, from, to], index) => ({
    id,
    letter: baseGreekLetter.replace(from, to),
    brief: makeBrief("Greek"),
    error: `cover-letter.txt body must contain planned keyword at index ${index}`,
  })),
  ...[
    ["typography-em-dash", "—"],
    ["typography-en-dash", "–"],
    ["typography-left-double-quote", "“"],
    ["typography-right-double-quote", "”"],
    ["typography-left-single-quote", "‘"],
    ["typography-right-single-quote", "’"],
    ["typography-left-angle-quote", "«"],
    ["typography-right-angle-quote", "»"],
    ["typography-ellipsis", "…"],
    ["typography-double-hyphen", "--"],
  ].map(([id, token]) => ({
    id,
    letter: replaceFirstBodyWord(baseEnglishLetter, `quality${token}`),
    brief: makeBrief(),
    error: `cover-letter.txt must not contain forbidden typography: ${token}`,
  })),
  ...[
    ["term-cursor", "Cursor"],
    ["term-excited", "excited"],
    ["term-thrilled", "thrilled"],
    ["term-passionate", "passionate"],
    ["term-perfect-fit", "perfect fit"],
    ["term-cost-of-error", "cost of error"],
    ["term-high-stakes-product", "high-stakes product"],
    ["term-bugs-are-expensive", "bugs are expensive"],
  ].map(([id, term]) => ({
    id,
    letter: replaceFirstBodyWord(baseEnglishLetter, term),
    brief: makeBrief(),
    error: `cover-letter.txt must not contain forbidden term: ${term}`,
  })),
  ...[
    ["term-perfect-fit-no-break-space", "perfect\u00a0fit", "perfect fit"],
    ["term-perfect-fit-thin-space", "perfect\u2009fit", "perfect fit"],
    ["term-perfect-fit-multiple-spaces", "perfect   fit", "perfect fit"],
    ["term-perfect-fit-line-wrap", "perfect\nfit", "perfect fit"],
    ["term-cost-of-error-line-wrap", "cost of\nerror", "cost of error"],
    ["term-high-stakes-product-line-wrap", "high-stakes\nproduct", "high-stakes product"],
    ["term-bugs-are-expensive-line-wrap", "bugs are\nexpensive", "bugs are expensive"],
  ].map(([id, inserted, term]) => ({
    id,
    letter: replaceFirstBodyWord(baseEnglishLetter, inserted),
    brief: makeBrief(),
    error: `cover-letter.txt must not contain forbidden term: ${term}`,
  })),
];

test("every declared invalid mutation reaches its exact validator pin", async (t) => {
  const declaredIds = mutationScenarios.map((scenario) => scenario.id);
  assert.deepEqual(declaredIds, expectedScenarioIds);
  const executedIds = [];
  for (const scenario of mutationScenarios) {
    await t.test(scenario.id, () => {
      executedIds.push(scenario.id);
      assertHasExactError(
        scenario.letterBytes ?? bytes(scenario.letter),
        scenario.brief,
        scenario.error,
      );
    });
  }
  assert.deepEqual(executedIds, expectedScenarioIds);
});

test("missing-keyword diagnostics are repository-owned and bounded", () => {
  const hostileTerm = "private-value\n" + "x".repeat(4096);
  const errors = validateCoverLetter(bytes(baseEnglishLetter), makeBrief("English", [hostileTerm]));
  assert.deepEqual(errors, ["cover-letter.txt body must contain planned keyword at index 0"]);
  assert.doesNotMatch(errors.join("\n"), /private-value|x{32}/u);
  assert.ok(errors.join("\n").length < 128);
});

test("near misses do not trigger whole-term forbidden or keyword checks", () => {
  const letter = replaceFirstBodyWord(baseEnglishLetter, "Cursorless");
  assert.doesNotMatch(validateCoverLetter(bytes(letter), makeBrief()).join("\n"), /Cursor/u);
  const intrawordUnderscore = replaceFirstBodyWord(baseEnglishLetter, "foo_bar_baz TypeScript");
  assert.deepEqual(validateCoverLetter(bytes(intrawordUnderscore), makeBrief()), []);
  assert.deepEqual(
    validateCoverLetter(bytes(baseEnglishLetter), makeBrief("English", ["Playwright"])),
    [],
  );
});

test("keyword survival is the classified conflict subset and honors active waivers", () => {
  const missingKeyword = makeBrief("English", ["TypeScript", "GraphQL"]);
  const findings = validateCoverLetterFindings(bytes(baseEnglishLetter), missingKeyword);
  assert.deepEqual(findings.errors, [], "intrinsic checks stay clean on a valid letter");
  assert.deepEqual(findings.conflicts, [
    {
      code: "letter_keyword",
      subject: { kind: "check", key: "letter_keyword:1" },
      message: "cover-letter.txt body must contain planned keyword at index 1",
    },
  ]);
  assert.deepEqual(findings.notices, []);

  const waiver = {
    id: "waiver_letter_0001",
    status: "active",
    subject: { kind: "check", key: "letter_keyword:1" },
  };
  const waived = validateCoverLetterFindings(bytes(baseEnglishLetter), missingKeyword, {
    waivers: [waiver],
  });
  assert.deepEqual(waived.conflicts, []);
  assert.equal(waived.notices.length, 1);
  assert.equal(waived.notices[0].waiver_id, "waiver_letter_0001");
  assert.deepEqual(
    validateCoverLetter(bytes(baseEnglishLetter), missingKeyword, { waivers: [waiver] }),
    [],
    "the flat wrapper drops waived findings from its error stream",
  );

  const intrinsic = validateCoverLetterFindings(
    bytes(makeLetter({ signature: "Wrong Person" })),
    missingKeyword,
  );
  assert.equal(
    intrinsic.errors.includes(`cover-letter.txt signature must be exactly ${defaultSignature}`),
    true,
    "intrinsic rules never classify as conflicts",
  );
});

const wordLimitError = "cover-letter.txt body must contain 230 to 260 words";

function wordApproval(maximum, overrides = {}) {
  return {
    id: `waiver_words_${maximum}`,
    status: "active",
    subject: { kind: "check", key: `letter_body_words_max:${maximum}` },
    ...overrides,
  };
}

test("an approved upper word limit downgrades the over-limit finding to a notice", () => {
  const brief = makeBrief();
  const letter261 = bytes(makeLetter({ words: 261 }));

  const unapproved = validateCoverLetterFindings(letter261, brief);
  assert.ok(
    unapproved.errors.includes(wordLimitError),
    "without an approval 261 words stay an error",
  );
  assert.deepEqual(unapproved.conflicts, [], "an unapproved overrun is never a journaled conflict");

  const approved = validateCoverLetterFindings(letter261, brief, { waivers: [wordApproval(261)] });
  assert.deepEqual(approved.errors, []);
  assert.deepEqual(approved.conflicts, []);
  assert.deepEqual(approved.notices, [
    {
      code: "letter_body_words",
      subject: { kind: "check", key: "letter_body_words_max:261" },
      message: "cover-letter.txt body has 261 words over the 260 default, within the approved 261",
      waiver_id: "waiver_words_261",
    },
  ]);
  assert.deepEqual(
    validateCoverLetter(letter261, brief, { waivers: [wordApproval(261)] }),
    [],
    "the flat wrapper accepts the approved length",
  );
});

test("the approved maximum is bounded, absolute, and never touches the lower limit", () => {
  const brief = makeBrief();
  const at300 = bytes(makeLetter({ words: 300, paragraphCount: 5 }));
  const at301 = bytes(makeLetter({ words: 301, paragraphCount: 5 }));

  assert.deepEqual(
    validateCoverLetterFindings(at300, brief, { waivers: [wordApproval(300)] }).errors,
    [],
    "300 words pass under an approval of 300",
  );
  assert.ok(
    validateCoverLetterFindings(at301, brief, { waivers: [wordApproval(300)] }).errors.includes(
      wordLimitError,
    ),
    "301 words fail under an approval of 300",
  );
  assert.ok(
    validateCoverLetterFindings(at301, brief, { waivers: [wordApproval(301)] }).errors.includes(
      wordLimitError,
    ),
    "an approval above the cap is ignored, not honoured",
  );
  assert.ok(
    validateCoverLetterFindings(at300, brief, { waivers: [wordApproval(280), wordApproval(300)] })
      .errors.length === 0,
    "several approvals take the largest in-range value, never a sum",
  );
  const under = validateCoverLetterFindings(bytes(makeLetter({ words: 229 })), brief, {
    waivers: [wordApproval(300)],
  });
  assert.ok(under.errors.includes(wordLimitError), "the lower limit is never moved");
  for (const ignored of [
    wordApproval(280, { status: "superseded" }),
    wordApproval(280, { subject: { kind: "decision", key: "letter_body_words_max:280" } }),
    wordApproval(280, { subject: { kind: "check", key: "letter_body_words_max:+20" } }),
    wordApproval(280, { subject: { kind: "check", key: "letter_body_words_max:10%" } }),
  ]) {
    assert.ok(
      validateCoverLetterFindings(bytes(makeLetter({ words: 270, paragraphCount: 5 })), brief, {
        waivers: [ignored],
      }).errors.includes(wordLimitError),
      `an approval that is superseded, not a check, or not an absolute count is ignored: ${ignored.subject.key} ${ignored.status}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The candidate layer's constraints, as this validator applies them.
//
// They arrive as data, already read and already checked against the engine's own lists, and they
// leave by their own channel: not `errors`, which is the engine's, and not `conflicts`, which a
// revision publication is allowed to classify instead of refusing. A personal ban a
// re-publication could ignore would not be a ban.

function letterConstraints(entries) {
  return parseCandidateConstraints({ schema_version: 1, constraints: entries });
}

// Adds words to the first body paragraph instead of replacing one, so the planned keywords
// survive and the only finding under test is the candidate's own.
function withWords(letter, addition) {
  const lines = letter.split("\n");
  const firstBodyIndex = lines.findIndex((line, index) => index >= 2 && line !== "");
  lines[firstBodyIndex] = `${addition} ${lines[firstBodyIndex]}`;
  return lines.join("\n");
}

const letterScoped = { materials: ["cover_letter"] };

// Task 158. The letter's constraints are read from the tracked example the way the publication
// reads them, so the ban on a private project's name comes from the example's profile: the same
// sentence passes with a public project's name and is refused with a private one's.
test("a letter naming a private project is refused and one naming a public project is not", () => {
  const constraints = candidateConstraintsFor({
    engineForbidden: coverLetterEngineForbidden,
    material: "cover_letter",
    root: candidateExampleRootFor(repoRoot),
  });
  const naming = (project) =>
    validateCoverLetterFindings(
      bytes(withWords(baseEnglishLetter, `I built ${project} on my own time.`)),
      makeBrief(),
      { constraints },
    );
  const publicProject = naming("lindenbench");
  assert.deepEqual(publicProject.candidateErrors, []);
  assert.deepEqual(publicProject.errors, []);
  const privateProject = naming("quiet-ledger");
  assert.deepEqual(privateProject.candidateErrors, [
    'cover-letter.txt breaks candidate constraint "private-project-10-2" (forbid_phrases)',
  ]);
  assert.deepEqual(privateProject.errors, []);
});

test("a candidate constraint refuses the letter through its own channel", () => {
  const constraints = letterConstraints([
    {
      id: "no-name",
      type: "forbid_phrases",
      scope: letterScoped,
      phrases: ["Jordan Vale"],
      why: "A private contact asked not to be named.",
    },
  ]);
  const clean = validateCoverLetterFindings(bytes(baseEnglishLetter), makeBrief(), { constraints });
  assert.deepEqual(clean.candidateErrors, []);
  assert.deepEqual(clean.errors, []);

  const named = withWords(baseEnglishLetter, "Jordan Vale wrote.");
  const found = validateCoverLetterFindings(bytes(named), makeBrief(), { constraints });
  assert.equal(found.candidateErrors.length, 1);
  assert.match(found.candidateErrors[0], /candidate constraint "no-name" \(forbid_phrases\)/u);
  // Not an engine error and not a brief-coupled conflict: the two channels that already exist
  // both mean something else.
  assert.deepEqual(found.errors, []);
  assert.deepEqual(found.conflicts, []);
  // The matched phrase and the reason stay out of the message.
  assert.equal(found.candidateErrors[0].includes("Jordan Vale"), false);
  assert.equal(found.candidateErrors[0].includes("private contact"), false);
});

test("the flat validator result carries the candidate findings too", () => {
  // This is the shape the skill's dry run reads. A dry run that came back green over a
  // publication that refuses would be worse than no dry run at all.
  const constraints = letterConstraints([
    {
      id: "terms",
      type: "prefer_terms",
      scope: letterScoped,
      prefer: "regression suite",
      avoid: ["regression pack"],
      why: "Reviewers in this field call it a suite.",
    },
  ]);
  const letter = withWords(baseEnglishLetter, "One Regression pack ran.");
  const flat = validateCoverLetter(bytes(letter), makeBrief(), { constraints });
  assert.equal(flat.length, 1);
  assert.match(flat[0], /candidate constraint "terms" \(prefer_terms\): write "regression suite"/u);
});

test("no waiver lifts a candidate constraint", () => {
  const constraints = letterConstraints([
    {
      id: "no-name",
      type: "forbid_phrases",
      scope: letterScoped,
      phrases: ["Jordan Vale"],
      why: "A private contact asked not to be named.",
    },
  ]);
  const letter = bytes(withWords(baseEnglishLetter, "Jordan Vale wrote."));
  // Every waiver shape the validator knows, offered at once. None of them reaches this channel,
  // because a waiver is an approval of a brief decision and a personal constraint is not one.
  const waivers = [
    { id: "w1", status: "active", subject: { kind: "check", key: "candidate_constraint:no-name" } },
    { id: "w2", status: "active", subject: { kind: "decision", key: "no-name" } },
    { id: "w3", status: "active", subject: { kind: "check", key: "letter_keyword:0" } },
  ];
  const found = validateCoverLetterFindings(letter, makeBrief(), { constraints, waivers });
  assert.equal(found.candidateErrors.length, 1);
  assert.deepEqual(found.notices, []);
});

test("a constraint scoped to the CV does not touch the letter", () => {
  const constraints = letterConstraints([
    {
      id: "cv-only",
      type: "forbid_phrases",
      scope: { materials: ["cv"] },
      phrases: ["Jordan Vale"],
      why: "Only the CV is bound by this one.",
    },
  ]);
  const letter = bytes(withWords(baseEnglishLetter, "Jordan Vale wrote."));
  const selected = selectCandidateConstraints(constraints, { material: "cover_letter" });
  assert.deepEqual([...selected], []);
  assert.deepEqual(
    validateCoverLetterFindings(letter, makeBrief(), { constraints: selected }).candidateErrors,
    [],
  );
});

test("a live candidate layer does not lift one engine refusal", () => {
  // The point of the merge order, stated as behaviour rather than as a set comparison: with the
  // layer present and firing, every engine refusal still fires, and still in `errors`, where no
  // waiver reaches it.
  const constraints = letterConstraints([
    {
      id: "no-name",
      type: "forbid_phrases",
      scope: letterScoped,
      phrases: ["Jordan Vale"],
      why: "A private contact asked not to be named.",
    },
  ]);
  const withEngineBreaches = withWords(
    baseEnglishLetter,
    "Jordan Vale wrote; Cursor excited us—yes.",
  );
  const found = validateCoverLetterFindings(bytes(withEngineBreaches), makeBrief(), {
    constraints,
  });
  assert.equal(found.candidateErrors.length, 1);
  for (const expected of [
    "cover-letter.txt must not contain forbidden typography: —",
    "cover-letter.txt must not contain forbidden term: Cursor",
    "cover-letter.txt must not contain forbidden term: excited",
  ]) {
    assert.ok(found.errors.includes(expected), `${expected} is missing from ${found.errors}`);
  }
});

test("a brief that requires what the candidate forbids reports both owners", () => {
  // Unsatisfiable, and deliberately not resolved by the machine: the brief's requirement is a
  // step-3 decision and the constraint is the candidate's, so the report names both and the
  // choice of which to change is the user's.
  const constraints = letterConstraints([
    {
      id: "no-playwright",
      type: "forbid_phrases",
      scope: letterScoped,
      phrases: ["Playwright"],
      why: "Not a tool to name in this search.",
    },
  ]);
  const brief = makeBrief("English", ["Playwright"]);
  const found = validateCoverLetterFindings(bytes(baseEnglishLetter), brief, { constraints });
  assert.equal(found.candidateErrors.length, 1, "the candidate's own finding is reported");
  const missing = validateCoverLetterFindings(
    bytes(baseEnglishLetter.replaceAll("Playwright", "Selenium")),
    brief,
    { constraints },
  );
  assert.deepEqual(missing.candidateErrors, []);
  assert.equal(missing.conflicts.length, 1, "the brief's own finding is reported");
  assert.equal(missing.conflicts[0].code, "letter_keyword");
});

test("without constraints the validator answers exactly as it did before", () => {
  const withoutOption = validateCoverLetterFindings(bytes(baseEnglishLetter), makeBrief());
  assert.deepEqual(withoutOption.candidateErrors, []);
  assert.deepEqual(withoutOption.errors, []);
  assert.deepEqual(withoutOption.conflicts, []);
  assert.deepEqual(validateCoverLetter(bytes(baseEnglishLetter), makeBrief()), []);
});
