// The fetch manifest, read once.
//
// It is optional: the browser transport writes none. Where it exists it is the only independent
// statement about a record in the whole directory - everything else was written by the session that
// is being verified - so two things read it, and they must read it the same way.

const KNOWN_SCHEMA_VERSIONS = new Set([1, 2]);

export function readManifestRecords(batch) {
  const file = batch.manifest;
  if (!file.present) return { records: null, problem: null, startedAt: null };
  if (file.error !== null || file.value === null) {
    return { records: null, problem: file.error ?? "manifest_shape_unexpected", startedAt: null };
  }
  const value = file.value;
  // Version 1 and version 2 differ only in the block naming the batch and in the transport's
  // promotion state, and this reader consumes neither: it takes `records` and `startedAt`. A batch
  // captured before the promotion stays verifiable for exactly that reason.
  if (
    !KNOWN_SCHEMA_VERSIONS.has(value.schemaVersion) ||
    value.tool !== "vacancy-fetch" ||
    !Array.isArray(value.records)
  ) {
    return { records: null, problem: "manifest_unrecognized", startedAt: null };
  }
  const byIndex = new Map();
  for (const record of value.records) {
    if (!Number.isSafeInteger(record?.index)) continue;
    byIndex.set(record.index, record);
  }
  // Taken before the request loop, so it precedes every `fetchedAt` in the file: the instant a
  // ledger row has to predate before it can be this batch's baseline rather than its write-back.
  return { records: byIndex, problem: null, startedAt: value.startedAt ?? null };
}

/**
 * Where a capture's bytes came from, derived rather than declared.
 *
 * `http_fetch` means the fetch manifest names this exact file with this exact digest, so the bytes
 * reached disk without crossing a model context - task 27's whole property. Anything else is a
 * `transcript`: text a model read off a rendered page and wrote out. A transcript capture is still
 * stamped and still re-checkable against its own stamp, but the stamp begins after the
 * transcription, so a check that compares an evidence quote against a transcript is comparing the
 * model with itself. Nothing in this suite can close that; naming which records have it is what it
 * can do, and the report carries the counts so a fully transcribed batch is visibly the weakest
 * class rather than indistinguishable from a fetched one.
 */
export function captureProvenance(capture, manifestRecord) {
  if (capture.verified?.ok !== true) return "unverified";
  // Both signals, not either. `persisted.file` is a manifest field, so a manifest could otherwise
  // name a browser transcript as its own fetched capture and launder its provenance - which is how
  // a review round reopened the rescue escape after it was closed by provenance alone. Only the
  // record's own primary file, named by the manifest, with the digest agreeing, is a fetch.
  if (capture.primary !== true) return "transcript";
  if (manifestRecord === undefined || manifestRecord === null) return "transcript";
  if (manifestRecord.usable !== true) return "transcript";
  const persisted = manifestRecord.persisted ?? null;
  if (persisted === null) return "transcript";
  if (persisted.file !== capture.file) return "transcript";
  return persisted.sha256 === capture.verified.header["normalized-sha256"]
    ? "http_fetch"
    : "transcript";
}

export const captureProvenanceClasses = Object.freeze(["http_fetch", "transcript", "unverified"]);
