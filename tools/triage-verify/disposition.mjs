// The disposition ledger: the machine-readable half of the negative-space sweep.
//
// A sweep whose unexplained hits can be waved away in prose is a sweep nobody has to answer. Each
// disposition therefore names one hit exactly - the record, the vocabulary family and the digest of
// the line it sits on - and a disposition that matches no live hit fails the batch instead of
// accumulating as a dead excuse. A page that changed its wording changes the line digest, so the
// explanation has to be taken again.
//
// The unit is a line and a family, not a line and a phrase. Several phrases of one family routinely
// hit the same sentence, and asking for the same explanation once per spelling is how a mechanism
// turns into paperwork - while a later phrase added to that family says nothing new about a line a
// person already read.
//
// Validation problems are findings, not exceptions: a malformed disposition file is something true
// about the batch, and the batch is what this suite reports on.

export const dispositionSchemaVersion = 1;

export const dispositionValues = Object.freeze([
  "not_a_requirement",
  "boilerplate",
  "already_recorded_elsewhere",
  "outside_scope",
]);

const ENTRY_KEYS = Object.freeze(["disposition", "family", "lineSha256", "note", "recordIndex"]);
const REQUIRED_ENTRY_KEYS = Object.freeze(["disposition", "family", "lineSha256", "recordIndex"]);
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_NOTE_CHARS = 400;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function dispositionKey(recordIndex, family, lineSha256) {
  return `${recordIndex} ${family} ${lineSha256}`;
}

/**
 * Validate a parsed disposition file.
 * Returns the usable entries keyed for lookup plus the bounded problems found on the way.
 */
export function validateDispositions(raw, knownFamilies) {
  const problems = [];
  const entries = new Map();
  if (!isRecord(raw)) {
    problems.push({ code: "disposition_invalid", reason: "not_an_object" });
    return { entries, problems };
  }
  if (raw.schemaVersion !== dispositionSchemaVersion) {
    problems.push({ code: "disposition_invalid", reason: "schema_version" });
    return { entries, problems };
  }
  if (!Array.isArray(raw.dispositions)) {
    problems.push({ code: "disposition_invalid", reason: "dispositions_not_an_array" });
    return { entries, problems };
  }
  raw.dispositions.forEach((entry, position) => {
    if (!isRecord(entry)) {
      problems.push({ code: "disposition_invalid", position, reason: "not_an_object" });
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.includes(key)) {
        problems.push({ code: "disposition_invalid", position, reason: "unknown_key" });
        return;
      }
    }
    for (const key of REQUIRED_ENTRY_KEYS) {
      if (!(key in entry)) {
        problems.push({ code: "disposition_invalid", position, reason: "missing_key" });
        return;
      }
    }
    if (!Number.isSafeInteger(entry.recordIndex) || entry.recordIndex < 1) {
      problems.push({ code: "disposition_invalid", position, reason: "record_index" });
      return;
    }
    if (typeof entry.family !== "string" || !knownFamilies.has(entry.family)) {
      problems.push({ code: "disposition_unknown_family", position });
      return;
    }
    if (typeof entry.lineSha256 !== "string" || !SHA256.test(entry.lineSha256)) {
      problems.push({ code: "disposition_invalid", position, reason: "line_digest" });
      return;
    }
    if (!dispositionValues.includes(entry.disposition)) {
      problems.push({ code: "disposition_unknown_value", position });
      return;
    }
    if (
      "note" in entry &&
      (typeof entry.note !== "string" ||
        entry.note.length === 0 ||
        entry.note.length > MAX_NOTE_CHARS)
    ) {
      problems.push({ code: "disposition_invalid", position, reason: "note" });
      return;
    }
    const key = dispositionKey(entry.recordIndex, entry.family, entry.lineSha256);
    if (entries.has(key)) {
      problems.push({ code: "disposition_duplicate", position });
      return;
    }
    entries.set(key, { ...entry, position, used: false });
  });
  return { entries, problems };
}
