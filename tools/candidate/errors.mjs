/**
 * The one refusal type of the candidate layer. It lives apart from the loader so the document
 * contracts can throw it while the loader imports them: `load.mjs` re-exports it, and every
 * existing caller keeps importing it from there.
 */

export class CandidateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CandidateError";
    this.code = code;
  }
}
