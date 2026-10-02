/**
 * The pins of the language packs: letters a pack's checks must accept or refuse, run against the
 * letter gate itself.
 *
 * A language's own checks live in its pack — the script, the signature, the subject word, the
 * wording rules — and the public suite runs on the tracked example, never on the real layer. The
 * pins are how the real pack proves that its checks do what it says: each one is a letter and the
 * verdict the gate must reach on it, run with the same validator, the same limits and the same
 * constraints a publication meets.
 *
 * An accepted pin must leave nothing behind — no error, no candidate finding, no conflict, no
 * notice. A refused pin must be refused by exactly one finding, and it must be the finding the pin
 * names: a letter refused for another reason, or for two, proves nothing about the check it was
 * written for.
 *
 * This runs in the operator check, `npm run candidate:check`, and never in the aggregate gate: the
 * gate never reads operator state.
 */

import { CandidateError, candidateLanguages, loadCandidateConfig } from "./load.mjs";
import { candidateConstraintsFor } from "./constraints.mjs";
import { readCandidatePinLetter } from "./languages.mjs";
import {
  coverLetterEngineForbidden,
  coverLetterLimitsFrom,
  validateCoverLetterFindings,
} from "../cover-letter/validate.mjs";

function describe(findings) {
  return findings.length === 0 ? "no finding" : findings.map((finding) => `"${finding}"`).join("; ");
}

/** Every finding the letter gate reaches on one pin, as the messages a publication would report. */
function pinFindings(pin, language, context) {
  const findings = validateCoverLetterFindings(
    readCandidatePinLetter(pin),
    {
      coverLetterPlan: { keywordTerms: [...pin.keywordTerms] },
      role: { vacancyLanguage: language.name },
    },
    {
      constraints: candidateConstraintsFor({
        engineForbidden: coverLetterEngineForbidden,
        language: language.name,
        material: "cover_letter",
        root: context.root,
      }),
      languages: context.languages,
      limits: context.limits,
    },
  );
  return [
    ...findings.errors,
    ...findings.candidateErrors,
    ...findings.conflicts.map((conflict) => conflict.message),
    ...findings.notices.map((notice) => notice.message),
  ];
}

/**
 * Run every pin of every pack of the layer rooted at `root`. Returns how many ran; the first pin
 * that does not hold throws `candidate_pin_failed`, naming the pack, the pin and what the gate
 * reported instead.
 */
export function runCandidatePins({ root } = {}) {
  const { config } = loadCandidateConfig({ root });
  const context = {
    languages: candidateLanguages({ root }),
    limits: coverLetterLimitsFrom(config),
    root,
  };
  let run = 0;
  for (const language of context.languages) {
    for (const pin of language.pins) {
      const findings = pinFindings(pin, language, context);
      const held = pin.expect === "accept"
        ? findings.length === 0
        : findings.length === 1 && findings[0] === pin.finding;
      if (!held) {
        throw new CandidateError(
          "candidate_pin_failed",
          `languages/${language.name}: pin ${pin.id} expects ${pin.expect === "accept" ? "no finding" : `"${pin.finding}" alone`}, the letter gate reports ${describe(findings)}`,
        );
      }
      run += 1;
    }
  }
  return Object.freeze({ run });
}
