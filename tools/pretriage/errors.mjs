/**
 * One error type for every caller mistake this stage can make.
 *
 * A caller error is not an observation about a vacancy. The two are kept apart deliberately: this
 * module answers questions about a batch, and the answer that a link is dead, unreachable or
 * outside the candidate's priority classes is a value it returns, never a thrown error. What throws
 * is being pointed at something unreadable.
 *
 * No message here echoes an external value. The links file names a line number, the manifest names
 * a record index, and a bounded code names the rule. That is the same discipline
 * `tools/triage-verify/links.mjs` states for the same reason: a message built from a hostile URL is
 * a message a model later reads.
 */
export class PreTriageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreTriageError";
    this.code = code;
  }
}

export function fail(code, message) {
  throw new PreTriageError(code, message);
}
