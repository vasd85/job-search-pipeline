// Hash-anchored persistence.
//
// The point of this layer is that the description never crosses a model context on its way to
// disk. That only buys anything if the file on disk says what it is and can be re-checked
// without trusting whoever wrote it, so every capture file carries a stamped header and the
// header carries the digest of the body that follows it. `verifyCaptureFile` recomputes that
// digest from the file's own bytes; the two compared values are a function of the file, not a
// number a model typed.
//
// What this does not prove is authorship: an actor able to write arbitrary bytes into the
// working directory can write a self-consistent header beside fabricated text. That is the
// same-UID filesystem residual ADR 0011 already recorded as out of scope, and nothing here
// closes it. The guarantee is exactly this strong: the file was not altered after it was
// stamped, and a hand edit that forgot to restamp is detected.

import { sha256Utf8 } from "./digest.mjs";

export const captureFormatVersion = 1;
export const captureBodyDelimiter = "#--- body ---";
const HEADER_PREFIX = "# ";

// Header field order is fixed so a capture file diffs cleanly between runs.
const HEADER_FIELDS = Object.freeze([
  "index",
  "adapter",
  "source-id",
  "requested-url",
  "final-url",
  "fetched-at",
  "http-status",
  "outcome",
  "access-barrier",
  "response-sha256",
  "response-bytes",
  "extracted-sha256",
  "normalized-sha256",
  "body-bytes",
  "normalization",
]);

function headerValue(value) {
  if (value === null || value === undefined || value === "") return "-";
  const text = String(value);
  // A header value never carries a line break. Everything written here is a repository-owned
  // enum, a digest, a number, a timestamp or a URL already narrowed by the URL rule, so this is
  // an invariant check rather than an escaping step: escaping would make the file ambiguous.
  if (/[\r\n]/u.test(text)) throw new Error("capture header value must be single-line");
  return text;
}

/**
 * Render one capture file: stamped header, delimiter, body.
 * `body` is already normalized; the header's `normalized-sha256` and `body-bytes` describe
 * exactly the bytes that follow the delimiter line.
 */
export function renderCaptureFile({ header, body }) {
  const lines = [`${HEADER_PREFIX}vacancy-fetch capture v${captureFormatVersion}`];
  for (const field of HEADER_FIELDS) {
    lines.push(`${HEADER_PREFIX}${field}: ${headerValue(header[field])}`);
  }
  lines.push(captureBodyDelimiter);
  return `${lines.join("\n")}\n${body}`;
}

/**
 * Re-check one capture file against its own header.
 * Returns bounded problem codes and never echoes the body, so the result can be reported.
 */
export function verifyCaptureFile(contents) {
  const problems = [];
  if (typeof contents !== "string" || contents.length === 0) {
    return { ok: false, header: null, body: null, problems: ["capture_empty"] };
  }
  // The first delimiter line ends the header. A body may legitimately contain the same
  // characters, so only the first occurrence is structural; the manifest, not a later line in
  // an untrusted body, remains the machine-readable authority.
  const marker = `\n${captureBodyDelimiter}\n`;
  const at = contents.indexOf(marker);
  if (at === -1) {
    return { ok: false, header: null, body: null, problems: ["capture_delimiter_absent"] };
  }
  const headerText = contents.slice(0, at);
  const body = contents.slice(at + marker.length);

  const header = Object.create(null);
  for (const line of headerText.split("\n")) {
    if (!line.startsWith(HEADER_PREFIX)) continue;
    const rest = line.slice(HEADER_PREFIX.length);
    const separator = rest.indexOf(": ");
    if (separator === -1) continue;
    header[rest.slice(0, separator)] = rest.slice(separator + 2);
  }

  if (!headerText.startsWith(`${HEADER_PREFIX}vacancy-fetch capture v`)) {
    problems.push("capture_header_absent");
  }
  const declaredDigest = header["normalized-sha256"];
  const actualDigest = sha256Utf8(body);
  if (declaredDigest !== actualDigest) problems.push("capture_digest_mismatch");
  const declaredBytes = Number(header["body-bytes"]);
  if (!Number.isSafeInteger(declaredBytes)
    || declaredBytes !== Buffer.byteLength(body, "utf8")) {
    problems.push("capture_size_mismatch");
  }
  return { ok: problems.length === 0, header, body, problems };
}

/** Zero-padded record basename. Never derived from source text. */
export function captureBasename(index) {
  return `${String(index).padStart(3, "0")}.capture.txt`;
}

export const manifestBasename = "fetch-manifest.json";
