// One digest helper for the whole layer.
//
// The hash chain is the only thing that makes a persisted capture re-checkable, so the function
// that computes it lives in exactly one place: two copies in two modules is two chances for one
// of them to change encoding, and a digest mismatch caused by a helper is indistinguishable from
// a digest mismatch caused by tampering.

import { createHash } from "node:crypto";

/** SHA-256 over the UTF-8 encoding of a string. */
export function sha256Utf8(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** SHA-256 over bytes exactly as received, with no decoding step in between. */
export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
