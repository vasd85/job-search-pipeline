// The ADR 0011 envelope this CLI accepts.
//
// Vacancy URLs are untrusted external values, so they never appear in shell program text — not
// quoted, not escaped, not through a heredoc, a pipe or an environment variable. They arrive the
// canonical way: a caller-produced `input-<32 lowercase hex>.json` inside the trusted input
// root, whose basename is the only thing the command line carries.
//
// `userAgent` is operator-owned configuration rather than an external value; it lives in the
// envelope because a header string in shell text is exactly the habit this transport exists to
// break, not because the header is untrusted.

export const vacancyFetchCommand = "fetch";

export const vacancyFetchInputSchemas = Object.freeze({
  [vacancyFetchCommand]: Object.freeze({
    required: ["urls"],
    optional: ["userAgent"],
    stringListFields: Object.freeze(["urls"]),
    stringListLimits: Object.freeze({
      // One triage batch, bounded well below the envelope's 65,536-byte ceiling. The 2026-08-17
      // collection held 101 links, so 256 is headroom rather than a target.
      urls: Object.freeze({ maxItems: 256, itemMaxBytes: 2048 }),
    }),
  }),
});
