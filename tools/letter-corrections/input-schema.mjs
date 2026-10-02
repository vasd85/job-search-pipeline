// The ADR 0011 envelope this CLI accepts.
//
// A letter fragment is text the pipeline built from a vacancy description, and a user reason is
// the user's own words about it. Neither is repository-owned, so neither ever appears in shell
// program text — not quoted, not escaped, not through a heredoc, a pipe or an environment
// variable. Both arrive the canonical way: a caller-produced `input-<32 lowercase hex>.json`
// inside the trusted input root, whose basename is the only thing the command line carries.
//
// `companyRole` is the output directory name of the process, which is built from the company's
// own name; it travels in the envelope for the same reason.
//
// Everything else the record holds — publication ids, the channel, the letter language, the class
// codes, the dates — is a repository-owned token or a bounded code, and those stay validated
// flags, exactly as the shared artifact contract requires.

export const letterCorrectionCommand = "record";

export const letterCorrectionInputSchemas = Object.freeze({
  [letterCorrectionCommand]: Object.freeze({
    required: ["companyRole", "fragmentBefore", "fragmentAfter"],
    optional: ["userReason"],
  }),
});
