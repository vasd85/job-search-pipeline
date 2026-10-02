/**
 * Session groups: how one collection is spent by several sessions at once.
 *
 * A group is a contiguous, 1-based range of the deduplicated collection in the order the file
 * gives it, cut at the size the caller names. Nothing else goes into the cut — not the ledger, not
 * a posting date, not what other sessions are doing — so two sessions that split one file with one
 * size compute the same groups without exchanging a byte. Disjoint and covering by construction.
 *
 * One group is one batch: its own `batch_id`, its own directory in the batch store, its own
 * `planBatch` and `plan.json`, its own verification range (`--from`/`--to` are the group's bounds)
 * and its own ledger write. The slice is cut by the same `sliceRange` the verify suite cuts the
 * range with, so the two cannot disagree about which links a group holds.
 *
 * The batch directory is the claim. docs/runbooks/triage-review.md#11-batch-store-the-history-beside-the-index already has the session
 * create it before the first fetch; `claimGroup` makes that `mkdir` the one atomic act by which a
 * session takes a group, and a directory that already exists is a group another session has. The
 * ledger's own guard (`recordBatch`) is what keeps two batches that nevertheless observe one
 * vacancy — a second spelling of one posting across two groups — from replacing each other's rows.
 *
 * No vacancy value reaches argv or a message: every entry point is an in-process module API, and
 * an error names a group number or a bounded code.
 */
import { mkdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { triageBatchIdPattern, vacancyIdentity } from "../lib/triage-ledger-core.mjs";
import { sliceRange } from "../triage-verify/links.mjs";
import { fail } from "./errors.mjs";

function assertCollection(collection) {
  if (collection === null || typeof collection !== "object" || !Array.isArray(collection.links)) {
    fail("pretriage_invalid_collection", "The collection must carry an array of links.");
  }
  if (collection.links.length === 0) {
    fail("pretriage_invalid_collection", "The collection holds no links to group.");
  }
}

/**
 * Cut the collection into groups.
 *
 * `groupSize` is the caller's number; omitted, the whole collection is one group, which is what a
 * single session does today. The ledger is not consulted: a group may hold links the ledger will
 * skip, and the batch's own `planBatch` removes those inside the group as it always has. Cutting
 * only the links the ledger would fetch would make the cut depend on when it was made.
 *
 * `cross_group_spellings` names the positions whose vacancy identity already appeared in an
 * earlier group. The file is deduplicated by full URL and the ledger collapses spellings, so such a
 * pair lands in two batches; the cut does not remove it — the verify suite requires every link of a
 * range to be accounted for — but says so before anything is fetched. Every session sees the same
 * list, because it is computed from the file alone.
 */
export function splitCollection(collection, { groupSize = null } = {}) {
  assertCollection(collection);
  const total = collection.links.length;
  const size = groupSize === null || groupSize === undefined ? total : groupSize;
  if (!Number.isSafeInteger(size) || size < 1) {
    fail("pretriage_invalid_group_size", "The group size must be a positive integer.");
  }
  const groups = [];
  for (let from = 1; from <= total; from += size) {
    const to = Math.min(from + size - 1, total);
    groups.push({ group: groups.length + 1, from, to, size: to - from + 1 });
  }
  const firstByKey = new Map();
  const crossGroupSpellings = [];
  collection.links.forEach((link, index) => {
    const position = index + 1;
    let key;
    try {
      key = vacancyIdentity(link.url).key;
    } catch {
      // An unreadable link is `planBatch`'s `action: null` inside its own group; it is nobody's
      // second spelling.
      return;
    }
    const first = firstByKey.get(key);
    if (first === undefined) {
      firstByKey.set(key, position);
      return;
    }
    const groupOf = (value) => Math.ceil(value / size);
    if (groupOf(first) !== groupOf(position)) {
      crossGroupSpellings.push({ position, group: groupOf(position), first_position: first, first_group: groupOf(first) });
    }
  });
  return { group_size: size, total, groups, cross_group_spellings: crossGroupSpellings };
}

/**
 * The collection as one group sees it: the same header, the links of the group's range.
 *
 * Cut by `tools/triage-verify/links.mjs#sliceRange`, so the group and the verify suite's
 * `--from`/`--to` slice are one function; each link keeps its `position` in the whole file and
 * takes `input_index` 1..k inside the group through `planPreTriage`, which is what the verify
 * README calls the position inside the verified range.
 */
export function collectionGroup(collection, group) {
  assertCollection(collection);
  if (group === null || typeof group !== "object" || !Number.isSafeInteger(group.from) || !Number.isSafeInteger(group.to)) {
    fail("pretriage_invalid_group", "A group names its 1-based inclusive bounds, from and to.");
  }
  let links;
  try {
    links = sliceRange(collection.links, group.from, group.to);
  } catch (error) {
    if (error?.name === "TriageVerifyError") {
      fail("pretriage_invalid_group", "The group's bounds do not fit the collection.");
    }
    throw error;
  }
  const { links: _ignored, ...header } = collection;
  return { ...header, links };
}

/**
 * The batch label of a group: `<prefix>-<from>-<to>`, the shape the manual runs already used
 * (`2026-09-20-telegram-1-15`). Checked against the ledger's own `batch_id` pattern here so a label
 * the ledger would refuse is refused before a fetch is spent under it.
 */
export function groupBatchId(prefix, group) {
  if (typeof prefix !== "string" || prefix.length === 0) {
    fail("pretriage_invalid_label", "The label prefix must be a non-empty string.");
  }
  if (group === null || typeof group !== "object" || !Number.isSafeInteger(group.from) || !Number.isSafeInteger(group.to)) {
    fail("pretriage_invalid_group", "A group names its 1-based inclusive bounds, from and to.");
  }
  const batchId = `${prefix}-${group.from}-${group.to}`;
  if (!triageBatchIdPattern.test(batchId)) {
    fail("pretriage_invalid_label", "The label prefix does not yield a batch_id the ledger accepts.");
  }
  return batchId;
}

/**
 * Take a group by creating its batch directory.
 *
 * `storeDir` is the batch store of this checkout as the review runbook docs/runbooks/triage-review.md#11-batch-store-the-history-beside-the-index names it —
 * `triage-batches/` in the operational checkout, `.rehearsal/batches/` in a rehearsal tree — given
 * absolute, and it must already exist: the store is not something a session invents. `mkdirSync`
 * without `recursive` is the claim: it creates `storeDir/<batch_id>` or fails `EEXIST`, and the
 * file system decides between two sessions that reach for the same directory at once.
 *
 * With `group` named, that group and no other is taken, and one already claimed is refused
 * (`pretriage_group_claimed`) — the mode for taking a group again on purpose. Without it, the first
 * group whose directory does not exist is taken, in order; when every group has a directory there
 * is nothing left to take (`pretriage_no_free_group`).
 */
export function claimGroup({ storeDir, split, labelPrefix, group = null } = {}) {
  if (typeof storeDir !== "string" || !isAbsolute(storeDir)) {
    fail("pretriage_store_missing", "The batch store must be given as an absolute path.");
  }
  try {
    if (!statSync(storeDir).isDirectory()) {
      fail("pretriage_store_missing", "The batch store path is not a directory.");
    }
  } catch (error) {
    if (error?.name === "PreTriageError") throw error;
    fail("pretriage_store_missing", "The batch store does not exist; this stage never creates it.");
  }
  if (split === null || typeof split !== "object" || !Array.isArray(split.groups) || split.groups.length === 0) {
    fail("pretriage_invalid_split", "The split must carry the groups splitCollection returned.");
  }
  const candidates = group === null
    ? split.groups
    : split.groups.filter((candidate) => candidate.group === group);
  if (candidates.length === 0) {
    fail("pretriage_invalid_group", `The split has no group ${group}.`);
  }
  for (const candidate of candidates) {
    const batchId = groupBatchId(labelPrefix, candidate);
    const dir = join(storeDir, batchId);
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") {
        if (group !== null) {
          fail("pretriage_group_claimed", `Group ${group} is already claimed: its batch directory exists.`);
        }
        continue;
      }
      // The store is there — it was checked above — and still refused the directory: permissions,
      // a read-only mount, no space. Not a missing store and not a claimed group.
      fail(
        "pretriage_claim_failed",
        `The batch directory of group ${candidate.group} could not be created `
          + `(${error?.code ?? "unknown error"}).`,
      );
    }
    return { ...candidate, batch_id: batchId, dir };
  }
  fail("pretriage_no_free_group", `Every group of the split is claimed (${split.groups.length} groups).`);
}
