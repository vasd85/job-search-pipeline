/**
 * One error type for every caller mistake this suite can make.
 *
 * A caller error is not a verification finding. The two are kept apart on purpose: a finding says
 * something about the batch, an error says the suite was pointed at something it cannot read. They
 * exit with different codes, and only findings appear in the report.
 */
export class TriageVerifyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TriageVerifyError";
    this.code = code;
  }
}

export function fail(code, message) {
  throw new TriageVerifyError(code, message);
}
