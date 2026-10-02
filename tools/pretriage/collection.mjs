/**
 * The collection: the links a batch was handed, plus the two facts about how they were gathered.
 *
 * The link list itself is read by `tools/triage-verify/links.mjs#readLinksFile` and not derived a
 * second time here. That module's own header says why: two derivations of one list turn every later
 * disagreement into an argument about which list was right. What this module adds is the metadata
 * that has nowhere else to live - when the collection was gathered, and whether the operator
 * asserts it is already ordered newest first. Before this, that date lived in the chat message that
 * started the run and died with the session, which is the same failure the triage ledger was built
 * to end.
 *
 * The metadata is written as comment lines at the top of the links file, which `readLinksFile`
 * already skips:
 *
 *     # collected: 2026-08-17
 *     # order: newest-first
 *     https://…
 *
 * Only the comment block *before the first link* is read. A comment further down cannot
 * retroactively date the collection, and the restriction is what keeps the header a header rather
 * than a scan of the whole file for anything that looks like a key.
 */
import { readFileSync, statSync } from "node:fs";
import { readLinksFile } from "../triage-verify/links.mjs";
import { collectionInstant } from "./freshness.mjs";
import { fail } from "./errors.mjs";

const maxLinksFileBytes = 1024 * 1024;

const COLLECTED = /^#\s*collected:\s*(.+?)\s*$/u;
const ORDER = /^#\s*order:\s*(.+?)\s*$/u;

/** The orders an operator may assert. Anything else is a caller error, never a silent default. */
export const declaredOrders = Object.freeze(["newest-first"]);

/**
 * Parse the header block of a links file.
 *
 * Split from the file read so the rule is testable without a file, and so the header vocabulary
 * stays visible in one function rather than spread across a reader.
 */
export function parseCollectionHeader(text) {
  if (typeof text !== "string") fail("pretriage_invalid_header", "The header text must be a string.");
  let collectedAt = null;
  let declaredOrder = null;
  for (const raw of text.split(/\r\n|\r|\n/u)) {
    const line = raw.trim().replace(/^﻿/u, "");
    if (line.length === 0) continue;
    if (!line.startsWith("#")) break;
    const collected = line.match(COLLECTED);
    if (collected !== null) {
      if (collectedAt !== null) {
        fail("pretriage_duplicate_header", "The links file declares a collection date twice.");
      }
      if (collectionInstant(collected[1]) === null) {
        fail(
          "pretriage_invalid_instant",
          "The collection date must be a zoned instant or a UTC date.",
        );
      }
      collectedAt = collected[1];
      continue;
    }
    const order = line.match(ORDER);
    if (order !== null) {
      if (declaredOrder !== null) {
        fail("pretriage_duplicate_header", "The links file declares an order twice.");
      }
      if (!declaredOrders.includes(order[1])) {
        fail("pretriage_unknown_order", "The declared order is not one this stage recognizes.");
      }
      declaredOrder = order[1];
    }
    // Any other comment is the operator's own note and is left alone.
  }
  return { collected_at: collectedAt, declared_order: declaredOrder };
}

/**
 * Read one links file as a collection.
 *
 * The file is read twice - once by `readLinksFile` for the list, once here for the header - and
 * that is the deliberate price of not owning a second parser for the list. The file is an
 * operator's own working file of at most a megabyte, not a boundary anything is defended at, so the
 * gap between the two reads costs nothing but the read.
 */
export function readCollection(path) {
  // The header is read first so its own failure mode is reachable: `readLinksFile` reads the same
  // file, so running it first would leave this guard as a line only a race between the two reads
  // could ever enter — decoration rather than a safeguard.
  let text;
  try {
    // The same one-megabyte bound `readLinksFile` applies, checked before the read rather than
    // after it: reading the header first must not mean reading an unbounded file first.
    if (statSync(path).size > maxLinksFileBytes) {
      fail("pretriage_links_unreadable", "The links file is larger than this stage reads.");
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.name === "PreTriageError") throw error;
    fail("pretriage_links_unreadable", "The links file could not be read for its header.");
  }
  const header = parseCollectionHeader(text);
  return { ...header, links: readLinksFile(path) };
}
