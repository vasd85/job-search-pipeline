/**
 * The one form in which a rule may name a candidate setting, and the comparison that keeps the
 * rules and the schema from drifting apart.
 *
 * A rule names a setting as `candidate.config.` followed by the dotted path the schema declares.
 * One form is the whole point: a prose reference the scan cannot find is a reference no check can
 * verify, and a check that accepted several spellings would go green on the one the writer got
 * wrong. The path alphabet is deliberately narrow — lowercase, digits and underscores — so the
 * placeholder this repository writes in documentation, `candidate.config.` followed by a bracketed
 * word, never matches and never becomes a key nobody declared.
 *
 * The comparison runs in both directions. A key named in a rule but absent from the schema is a
 * rule pointing at nothing; a key in the schema that no rule names is a setting nothing reads.
 * With both sets empty, which is the state this layer starts in, the comparison passes.
 *
 * The roots are a parameter. The production call passes the two directories that carry the rules;
 * a test passes a fixture directory, which is what makes the comparison itself provable instead
 * of merely vacuous.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CandidateError } from "./load.mjs";

/**
 * The reference as it appears in prose. The path must start with a letter, so a bracketed
 * placeholder is not a reference, and `candidate.config.` on its own is not one either.
 */
export const candidateKeyReferencePattern = /candidate\.config\.([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)/gu;

const MAX_SCANNED_FILE_BYTES = 4 * 1024 * 1024;

// Operating-system metadata a file browser drops into any directory. It is not content of this
// tree — `.gitignore` keeps it out of the repository and the operational manifest
// holds the same basename apart from the tree it hashes — so the scan steps over it. Everything
// else it cannot read is a refusal: `.DS_Store` carries NUL bytes, and refusing it would turn
// the check red on whichever machine last opened the folder, for a reason having nothing to do
// with rules or schema.
const OPERATING_SYSTEM_METADATA = Object.freeze([
  ".DS_Store",
  ".Spotlight-V100",
  ".Trashes",
  "Thumbs.db",
  "desktop.ini",
]);

function isOperatingSystemMetadata(name) {
  return OPERATING_SYSTEM_METADATA.includes(name) || name.startsWith("._");
}

function fail(code, message) {
  throw new CandidateError(code, message);
}

export function candidateKeyReferencesIn(text) {
  const found = new Set();
  for (const match of String(text).matchAll(candidateKeyReferencePattern)) found.add(match[1]);
  return found;
}

function walk(directory, files) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    fail("candidate_key_root_invalid", `key scan root is unreadable (${error?.code ?? "unknown"})`);
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(path, files);
      continue;
    }
    if (isOperatingSystemMetadata(entry.name)) continue;
    if (!entry.isFile()) {
      // A symbolic link or a device node is not prose this scan can read, and passing over it
      // would be one more way for a named key to go unseen.
      fail("candidate_key_root_invalid", "key scan met an entry that is not a regular file");
    }
    files.push(path);
  }
  return files;
}

/**
 * Every key named by the prose under `roots`, sorted and without duplicates.
 */
export function scanCandidateKeyReferences({ roots } = {}) {
  if (!Array.isArray(roots) || roots.length === 0) {
    fail("candidate_key_root_invalid", "key scan needs at least one root");
  }
  const found = new Set();
  for (const root of roots) {
    if (typeof root !== "string" || !isAbsolute(root) || root !== resolve(root)) {
      fail("candidate_key_root_invalid", "key scan root must be an absolute normalized path");
    }
    let stats;
    try {
      stats = statSync(root);
    } catch (error) {
      fail("candidate_key_root_invalid", `key scan root is unavailable (${error?.code ?? "unknown"})`);
    }
    if (!stats.isDirectory()) fail("candidate_key_root_invalid", "key scan root must be a directory");
    for (const path of walk(root, [])) {
      let buffer;
      try {
        if (statSync(path).size > MAX_SCANNED_FILE_BYTES) {
          // Refused, not skipped. Every way this scan can miss a reference makes the two-way
          // comparison pass on a rule that names a key nobody declared, which is the direction
          // the check exists to catch.
          fail("candidate_key_root_invalid", "key scan met a file larger than it reads");
        }
        buffer = readFileSync(path);
      } catch (error) {
        if (error instanceof CandidateError) throw error;
        fail("candidate_key_root_invalid", `key scan cannot read a file (${error?.code ?? "unknown"})`);
      }
      if (buffer.includes(0)) {
        // A NUL byte means this is not the UTF-8 prose the reference form lives in — a binary
        // file, or UTF-16, whose decoding would silently match nothing.
        fail("candidate_key_root_invalid", "key scan met a file that is not UTF-8 text");
      }
      for (const key of candidateKeyReferencesIn(buffer.toString("utf8"))) found.add(key);
    }
  }
  return Object.freeze([...found].sort());
}

/**
 * The two-way comparison. `undeclared` are keys the rules name and the schema does not have;
 * `unreferenced` are keys the schema declares and no rule names.
 */
export function compareCandidateKeyCoverage({ declared, referenced } = {}) {
  const declaredSet = new Set(declared ?? []);
  const referencedSet = new Set(referenced ?? []);
  return Object.freeze({
    undeclared: Object.freeze([...referencedSet].filter((key) => !declaredSet.has(key)).sort()),
    unreferenced: Object.freeze([...declaredSet].filter((key) => !referencedSet.has(key)).sort()),
  });
}
