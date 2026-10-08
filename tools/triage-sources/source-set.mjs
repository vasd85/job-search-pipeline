// The immutable Telegram source contract. Source text and anchors are extracted by code; the
// reader supplies only references, boundaries and closed role codes. HTML verification is optional
// for an in-memory caller and mandatory when a persisted set enters the batch store.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalizeVacancyUrl } from "../lib/triage-ledger-core.mjs";
import { numberedLines } from "../telegram-collect/candidates.mjs";
import { linksOf } from "../telegram-collect/links.mjs";
import { parsePage } from "../telegram-collect/parse.mjs";

export const sourceSetSchemaVersion = 1;
export const sourceSetBasename = "source-set.json";
export const sourceRoles = Object.freeze([
  "company_context",
  "details",
  "apply",
  "original_post",
  "contact",
  "unknown",
]);
export const descriptionKinds = Object.freeze(["full_description", "summary", "unknown"]);
export const mappingStatuses = Object.freeze(["resolved", "unresolved_oversize"]);
export const exclusionReasons = Object.freeze(["non_qa_vacancy", "non_vacancy"]);
export const MAX_EXCLUDED_REGIONS_PER_POST = 20;
export const MAX_SOURCE_SET_BYTES = 16 * 1024 * 1024;
export const MAX_SOURCE_POST_BYTES = 1024 * 1024;
export const MAX_SOURCE_SNAPSHOTS = 2000;
export const MAX_SOURCE_CARDS = 40000;
export const MAX_SOURCE_LINES = 10000;
export const MAX_SOURCE_ANCHORS = 2000;
export const MAX_SOURCE_CAPTURE_BYTES = 5 * 1024 * 1024;
const HANDLE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/u;
const HEX = /^[a-f0-9]{64}$/u;
const SNAPSHOT = /^tg-snapshot:sha256:[a-f0-9]{64}$/u;
const CARD = /^tg-card:sha256:[a-f0-9]{64}$/u;
export const snapshotRefPattern = SNAPSHOT;
export const cardRefPattern = CARD;
const TYPES = new Set([
  "url",
  "tg",
  "email",
  "tg_other",
  "unusable",
  "hashtag",
  "non_web",
  "preview_folded",
]);
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) =>
  plain(value) && Object.keys(value).sort().join() === [...expected].sort().join();
const index = (value) => Number.isSafeInteger(value) && value > 0;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Numbers-only exclusions account for known non-QA text without giving its anchors QA roles. */
export function excludedRegionsProblem(regions, { lineCount, anchors, cards }) {
  if (
    !Array.isArray(regions) ||
    regions.length > MAX_EXCLUDED_REGIONS_PER_POST ||
    (regions.length > 0 && cards.length === 0)
  )
    return "Excluded regions must be a bounded list beside vacancy cards.";
  const offered = new Map(
    anchors
      .filter((anchor) => ["url", "tg", "email", "tg_other"].includes(anchor.type))
      .map((anchor) => [anchor.index, anchor]),
  );
  const mapped = new Set(cards.flatMap((card) => card.links.map((link) => link.anchor)));
  const sorted = [];
  const excluded = new Set();
  for (const region of regions) {
    if (
      !keys(region, ["start_line", "end_line", "reason", "anchors"]) ||
      !index(region.start_line) ||
      !index(region.end_line) ||
      region.start_line > region.end_line ||
      region.end_line > lineCount ||
      !exclusionReasons.includes(region.reason) ||
      !Array.isArray(region.anchors) ||
      region.anchors.length > anchors.length
    )
      return "Excluded region has invalid bounds, reason or anchors.";
    if (
      cards.some((card) => region.start_line <= card.end_line && card.start_line <= region.end_line)
    )
      return "Excluded region overlaps a vacancy's own text.";
    const own = new Set();
    for (const number of region.anchors) {
      const anchor = offered.get(number);
      if (
        !index(number) ||
        anchor === undefined ||
        excluded.has(number) ||
        mapped.has(number) ||
        (anchor.line !== null && (anchor.line < region.start_line || anchor.line > region.end_line))
      )
        return "Excluded anchor is absent, repeated, mapped or outside its region.";
      own.add(number);
      excluded.add(number);
    }
    for (const anchor of offered.values())
      if (
        anchor.line !== null &&
        anchor.line >= region.start_line &&
        anchor.line <= region.end_line &&
        !own.has(anchor.index)
      )
        return "Excluded region does not account for every offered anchor in its text.";
    sorted.push(region);
  }
  sorted.sort((a, b) => a.start_line - b.start_line);
  if (sorted.some((region, at) => at > 0 && region.start_line <= sorted[at - 1].end_line))
    return "Excluded regions overlap.";
  return null;
}

export class SourceSetError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceSetError";
    this.code = "source_set_invalid";
  }
}
function refuse(message) {
  throw new SourceSetError(message);
}

export function serializeSourceSet(set) {
  return `${JSON.stringify(set, null, 2)}\n`;
}
export function sourceSetDigest(value) {
  return hash(
    typeof value === "string" || Buffer.isBuffer(value) ? value : serializeSourceSet(value),
  );
}
export function snapshotBodySha256(snapshot) {
  return hash(JSON.stringify({ lines: snapshot.lines, anchors: snapshot.anchors }));
}
export function snapshotRef(snapshot) {
  return `tg-snapshot:sha256:${hash(JSON.stringify({ handle: snapshot.handle.toLowerCase(), post_id: snapshot.post_id, instant: snapshot.instant, body_sha256: snapshotBodySha256(snapshot) }))}`;
}
export function cardRef(card) {
  return `tg-card:sha256:${hash(JSON.stringify({ snapshot_ref: card.snapshot_ref, title_line: card.title_line, start_line: card.start_line, end_line: card.end_line }))}`;
}

/** Capture filenames are code-owned relative paths; symlink traversal is never accepted. */
function capturePath(root, file) {
  if (
    typeof file !== "string" ||
    file.length > 256 ||
    isAbsolute(file) ||
    !/^[A-Za-z0-9._/-]+$/u.test(file) ||
    file.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    refuse("Capture file must be a safe relative path.");
  if (root === undefined) return null;
  let base;
  try {
    base = realpathSync(root);
  } catch {
    refuse("Capture root cannot be read.");
  }
  let current = base;
  try {
    for (const part of file.split("/")) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) refuse("Capture path contains a symlink.");
    }
    const stat = lstatSync(current);
    if (!stat.isFile() || stat.size > MAX_SOURCE_CAPTURE_BYTES)
      refuse("Capture is not a bounded regular file.");
  } catch (error) {
    if (error instanceof SourceSetError) throw error;
    refuse("Capture file cannot be read.");
  }
  const rel = relative(base, realpathSync(current));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    refuse("Capture path escapes its root.");
  return current;
}

/** Full, code-extracted post body. Anchor indices are original parse order, never reader order. */
export function snapshotOf(post, { handle, capture }) {
  const lines = numberedLines(post);
  const numbers = new Map(lines.map((line) => [line.lineIndex, line.n]));
  const entries = linksOf(post);
  const snapshot = {
    snapshot_ref: "",
    handle,
    post_id: post.id,
    instant: post.instant,
    original_url: `https://t.me/${handle}/${post.id}?embed=1`,
    capture,
    lines: lines.map(({ n, text }) => ({ n, text })),
    anchors: post.anchors.map((anchor, at) => ({
      index: at + 1,
      href: anchor.href,
      text: anchor.text,
      line: numbers.get(anchor.lineIndex) ?? null,
      type: entries[at].type ?? entries[at].skipped,
    })),
  };
  snapshot.snapshot_ref = snapshotRef(snapshot);
  return snapshot;
}

export function snapshotFromHtml(
  html,
  { handle, postId, file = "001.page.html", capturedAt = new Date().toISOString() },
) {
  const parsed = parsePage(html, { handle });
  const found = parsed.posts.filter((post) => post.id === postId);
  if (parsed.truncated || found.length !== 1)
    refuse("Capture does not contain one complete requested post.");
  return snapshotOf(found[0], {
    handle,
    capture: { file, sha256: hash(Buffer.from(html, "utf8")), captured_at: capturedAt },
  });
}

function anchorUrl(anchor) {
  const post = {
    lines: [anchor.text],
    anchors: [{ container: "text", href: anchor.href, text: anchor.text, lineIndex: 0 }],
  };
  const entry = linksOf(post)[0];
  if (entry.type === "url") return entry.url;
  if (entry.type === "tg" || entry.type === "tg_other") {
    try {
      const url = new URL(anchor.href.replaceAll("&amp;", "&"));
      url.username = "";
      url.password = "";
      url.hash = "";
      if (url.href.length > 2048) return null;
      normalizeVacancyUrl(url.href);
      return url.href;
    } catch {
      return null;
    }
  }
  if (entry.type === "email") return `mailto:${entry.address}`;
  return null;
}
export function sourceAnchorUrl(anchor) {
  return anchorUrl(anchor);
}

/** An explicit constructor for fictional fixtures and collector publication. */
export function createSourceSet({ collectionText, snapshots, cards, excludedRegions = [] }) {
  const ordered = [...cards].sort(
    (a, b) =>
      a.snapshot_ref.localeCompare(b.snapshot_ref) ||
      a.start_line - b.start_line ||
      a.title_line - b.title_line,
  );
  const counters = new Map();
  const records = ordered.map((card) => {
    const ordinal = (counters.get(card.snapshot_ref) ?? 0) + 1;
    counters.set(card.snapshot_ref, ordinal);
    const record = {
      card_ref: "",
      snapshot_ref: card.snapshot_ref,
      title_line: card.title_line,
      start_line: card.start_line,
      end_line: card.end_line,
      description_kind: card.description_kind,
      mapping_status: card.mapping_status ?? "resolved",
      links: card.links,
      vacancy_no: ordinal,
    };
    record.card_ref = cardRef(record);
    return record;
  });
  const set = {
    schema_version: sourceSetSchemaVersion,
    collection_sha256: hash(collectionText ?? ""),
    snapshots,
    cards: records,
    ...(!Array.isArray(excludedRegions) || excludedRegions.length > 0
      ? { excluded_regions: excludedRegions }
      : {}),
  };
  validateSourceSet(set, { collectionText: collectionText ?? "" });
  if (set.excluded_regions)
    set.excluded_regions = [...set.excluded_regions]
      .sort((a, b) => a.snapshot_ref.localeCompare(b.snapshot_ref) || a.start_line - b.start_line)
      .map((region) => ({ ...region, anchors: [...region.anchors].sort((a, b) => a - b) }));
  return set;
}

export function validateSourceSet(set, { collectionText, captureRoot } = {}) {
  const setKeys = ["schema_version", "collection_sha256", "snapshots", "cards"];
  if (plain(set) && Object.hasOwn(set, "excluded_regions")) setKeys.push("excluded_regions");
  if (
    !keys(set, setKeys) ||
    set.schema_version !== 1 ||
    !HEX.test(set.collection_sha256 ?? "") ||
    !Array.isArray(set.snapshots) ||
    !Array.isArray(set.cards) ||
    set.snapshots.length > MAX_SOURCE_SNAPSHOTS ||
    set.cards.length > MAX_SOURCE_CARDS
  )
    refuse("Source set does not match schema version 1.");
  let serialized;
  try {
    serialized = serializeSourceSet(set);
  } catch {
    refuse("Source set cannot be serialized as JSON.");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_SOURCE_SET_BYTES)
    refuse("Source set exceeds its byte limit.");
  if (
    collectionText !== undefined &&
    ((typeof collectionText !== "string" && !Buffer.isBuffer(collectionText)) ||
      hash(collectionText) !== set.collection_sha256)
  )
    refuse("Collection bytes do not match the source set digest.");
  const snapshots = new Map();
  for (const snapshot of set.snapshots) {
    if (
      !keys(snapshot, [
        "snapshot_ref",
        "handle",
        "post_id",
        "instant",
        "original_url",
        "capture",
        "lines",
        "anchors",
      ]) ||
      typeof snapshot.handle !== "string" ||
      !HANDLE.test(snapshot.handle) ||
      !index(snapshot.post_id) ||
      snapshot.post_id > 999999999999 ||
      typeof snapshot.instant !== "string" ||
      !Number.isFinite(Date.parse(snapshot.instant)) ||
      new Date(snapshot.instant).toISOString() !== snapshot.instant ||
      snapshot.original_url !== `https://t.me/${snapshot.handle}/${snapshot.post_id}?embed=1` ||
      !SNAPSHOT.test(snapshot.snapshot_ref ?? "") ||
      !keys(snapshot.capture, ["file", "sha256", "captured_at"]) ||
      !HEX.test(snapshot.capture.sha256 ?? "") ||
      typeof snapshot.capture.captured_at !== "string" ||
      !Number.isFinite(Date.parse(snapshot.capture.captured_at)) ||
      new Date(snapshot.capture.captured_at).toISOString() !== snapshot.capture.captured_at ||
      !Array.isArray(snapshot.lines) ||
      !snapshot.lines.length ||
      snapshot.lines.length > MAX_SOURCE_LINES ||
      !Array.isArray(snapshot.anchors) ||
      snapshot.anchors.length > MAX_SOURCE_ANCHORS
    )
      refuse("Source snapshot has invalid fields.");
    for (const [at, line] of snapshot.lines.entries())
      if (
        !keys(line, ["n", "text"]) ||
        line.n !== at + 1 ||
        typeof line.text !== "string" ||
        !line.text.length ||
        /[\r\n]/u.test(line.text)
      )
        refuse("Snapshot lines must be complete numbered source lines.");
    for (const [at, anchor] of snapshot.anchors.entries())
      if (
        !keys(anchor, ["index", "href", "text", "line", "type"]) ||
        anchor.index !== at + 1 ||
        typeof anchor.href !== "string" ||
        typeof anchor.text !== "string" ||
        !TYPES.has(anchor.type) ||
        (anchor.line !== null && (!index(anchor.line) || anchor.line > snapshot.lines.length))
      )
        refuse("Snapshot anchors have invalid fields.");
    if (
      Buffer.byteLength(JSON.stringify({ lines: snapshot.lines, anchors: snapshot.anchors })) >
        MAX_SOURCE_POST_BYTES ||
      snapshot.snapshot_ref !== snapshotRef(snapshot) ||
      snapshots.has(snapshot.snapshot_ref)
    )
      refuse("Source snapshot reference or body limit is invalid.");
    const path = capturePath(captureRoot, snapshot.capture.file);
    if (path !== null) {
      const bytes = readFileSync(path);
      if (hash(bytes) !== snapshot.capture.sha256)
        refuse("Capture bytes do not match their digest.");
      const extracted = snapshotFromHtml(bytes.toString("utf8"), {
        handle: snapshot.handle,
        postId: snapshot.post_id,
        file: snapshot.capture.file,
        capturedAt: snapshot.capture.captured_at,
      });
      if (!same(extracted, snapshot))
        refuse("Snapshot body or anchors differ from the saved HTML.");
    }
    snapshots.set(snapshot.snapshot_ref, snapshot);
  }
  const refs = new Set();
  const bySnapshot = new Map();
  for (const card of set.cards) {
    if (
      !keys(card, [
        "card_ref",
        "snapshot_ref",
        "title_line",
        "start_line",
        "end_line",
        "description_kind",
        "mapping_status",
        "links",
        "vacancy_no",
      ]) ||
      !CARD.test(card.card_ref ?? "") ||
      !snapshots.has(card.snapshot_ref) ||
      !index(card.title_line) ||
      !index(card.start_line) ||
      !index(card.end_line) ||
      !index(card.vacancy_no) ||
      !descriptionKinds.includes(card.description_kind) ||
      !mappingStatuses.includes(card.mapping_status) ||
      !Array.isArray(card.links)
    )
      refuse("Source card has invalid fields.");
    const snapshot = snapshots.get(card.snapshot_ref);
    if (
      card.start_line > card.title_line ||
      card.title_line > card.end_line ||
      card.end_line > snapshot.lines.length ||
      card.card_ref !== cardRef(card) ||
      refs.has(card.card_ref)
    )
      refuse("Card identity or vacancy boundaries are invalid.");
    refs.add(card.card_ref);
    const anchorRoles = new Map();
    let original = 0;
    for (const link of card.links) {
      if (
        !keys(link, ["anchor", "role", "url"]) ||
        !sourceRoles.includes(link.role) ||
        typeof link.url !== "string"
      )
        refuse("Source link has invalid fields.");
      if (link.anchor === null) {
        if (link.role !== "original_post" || link.url !== snapshot.original_url || ++original > 1)
          refuse("Original post must be derived from its snapshot.");
        continue;
      }
      if (
        !index(link.anchor) ||
        link.anchor > snapshot.anchors.length ||
        anchorRoles.has(link.anchor)
      )
        refuse("Source link anchor is absent or assigned twice.");
      const anchor = snapshot.anchors[link.anchor - 1];
      if (
        anchorUrl(anchor) !== link.url ||
        link.role === "original_post" ||
        (link.role === "contact" && !["tg", "email"].includes(anchor.type)) ||
        (["company_context", "details", "apply"].includes(link.role) &&
          !["url", "tg_other"].includes(anchor.type))
      )
        refuse("Source link does not match its code-extracted anchor.");
      if (
        link.role !== "company_context" &&
        anchor.line !== null &&
        (anchor.line < card.start_line || anchor.line > card.end_line)
      )
        refuse("Source link belongs outside its vacancy boundaries.");
      anchorRoles.set(link.anchor, link.role);
    }
    if (
      original !== 1 ||
      (card.mapping_status === "unresolved_oversize" &&
        (card.description_kind !== "unknown" ||
          [...anchorRoles.values()].some((role) => role !== "unknown")))
    )
      refuse("Card mapping status or original post coverage is invalid.");
    if (!bySnapshot.has(card.snapshot_ref)) bySnapshot.set(card.snapshot_ref, []);
    bySnapshot.get(card.snapshot_ref).push(card);
  }
  const excludedBySnapshot = new Map();
  if (Object.hasOwn(set, "excluded_regions")) {
    if (
      !Array.isArray(set.excluded_regions) ||
      set.excluded_regions.length > MAX_SOURCE_SNAPSHOTS * MAX_EXCLUDED_REGIONS_PER_POST
    )
      refuse("Source exclusions must be a bounded list.");
    for (const region of set.excluded_regions) {
      if (
        !keys(region, ["snapshot_ref", "start_line", "end_line", "reason", "anchors"]) ||
        !bySnapshot.has(region.snapshot_ref)
      )
        refuse("Source exclusion has invalid fields or no vacancy snapshot.");
      if (!excludedBySnapshot.has(region.snapshot_ref))
        excludedBySnapshot.set(region.snapshot_ref, []);
      const { snapshot_ref: ref, ...numbers } = region;
      excludedBySnapshot.get(ref).push(numbers);
    }
  }
  for (const [ref, cards] of bySnapshot) {
    cards.sort((a, b) => a.start_line - b.start_line);
    if (cards.length > 20) refuse("A snapshot exceeds the vacancy limit.");
    for (const [at, card] of cards.entries())
      if (card.vacancy_no !== at + 1 || (at > 0 && card.start_line <= cards[at - 1].end_line))
        refuse("Vacancy boundaries overlap or display ordinals are not in source order.");
    const snapshot = snapshots.get(ref);
    const regions = excludedBySnapshot.get(ref) ?? [];
    const problem = excludedRegionsProblem(regions, {
      lineCount: snapshot.lines.length,
      anchors: snapshot.anchors,
      cards,
    });
    if (problem !== null) refuse(problem);
    const excluded = new Set(regions.flatMap((region) => region.anchors));
    for (const anchor of snapshot.anchors) {
      const assignments = cards.flatMap((card) =>
        card.links
          .filter((link) => link.anchor === anchor.index)
          .map((link) => ({ card, role: link.role })),
      );
      if (
        ["url", "tg", "tg_other", "email"].includes(anchor.type) &&
        anchorUrl(anchor) !== null &&
        !assignments.length &&
        !excluded.has(anchor.index)
      )
        refuse("A usable anchor has no explicit source mapping or exclusion.");
      if (assignments.length > 1 && assignments.some(({ role }) => role !== "company_context"))
        refuse("Only company context anchors may be shared between vacancies.");
    }
  }
  if ([...snapshots.keys()].some((ref) => !bySnapshot.has(ref)))
    refuse("Source snapshot has no vacancy card coverage.");
  if (collectionText !== undefined) {
    const known = new Set();
    for (const card of set.cards)
      for (const link of card.links)
        if (!link.url.startsWith("mailto:")) known.add(normalizeVacancyUrl(link.url));
    for (const line of collectionText.toString().split(/\r?\n/u)) {
      const text = line.trim();
      if (!text || text.startsWith("#")) continue;
      let url;
      try {
        url = normalizeVacancyUrl(text);
      } catch {
        refuse("Collection contains an invalid URL.");
      }
      if (!known.has(url)) refuse("Collection URL has no source membership.");
    }
  }
  return set;
}

export function readSourceSet(file, options = {}) {
  let bytes;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_SET_BYTES)
      refuse("Source set file is invalid or oversized.");
    bytes = readFileSync(file);
  } catch (error) {
    if (error instanceof SourceSetError) throw error;
    refuse("Source set file cannot be read.");
  }
  const text = bytes.toString("utf8");
  let sourceSet;
  try {
    sourceSet = JSON.parse(text);
  } catch {
    refuse("Source set file is not JSON.");
  }
  validateSourceSet(sourceSet, { captureRoot: dirname(resolve(file)), ...options });
  return { sourceSet, digest: hash(bytes), text };
}

export function sourceSetMemberships(set, url) {
  let normalized;
  try {
    normalized = normalizeVacancyUrl(url);
  } catch {
    return [];
  }
  return set.cards.flatMap((card) =>
    card.links
      .filter((link) => {
        if (link.url.startsWith("mailto:")) return false;
        try {
          return normalizeVacancyUrl(link.url) === normalized;
        } catch {
          return false;
        }
      })
      .map((link) => ({
        card_ref: card.card_ref,
        snapshot_ref: card.snapshot_ref,
        role: link.role,
        url: link.url,
        anchor: link.anchor,
      })),
  );
}
export function cardBody(set, card) {
  const reference = typeof card === "string" ? card : card?.card_ref;
  const value = set.cards.find((item) => item.card_ref === reference);
  if (value === undefined) refuse("Card does not belong to this source set.");
  const snapshot = set.snapshots.find((item) => item.snapshot_ref === value?.snapshot_ref);
  if (snapshot === undefined) refuse("Card snapshot cannot be resolved.");
  return snapshot.lines
    .slice(value.start_line - 1, value.end_line)
    .map((line) => line.text)
    .join("\n");
}

/** Publication uses the saved HTML, rather than trusting a serialized stage's copy of source text. */
export function buildSourceSet({ cards, collectionText, captures, captureRoot }) {
  const snapshots = new Map();
  for (const card of cards) {
    if (!card.sourceSnapshot) continue;
    const base = card.sourceSnapshot;
    if (snapshots.has(base.snapshot_ref)) continue;
    const matches = captures.filter(
      (capture) =>
        capture.handle.toLowerCase() === card.handle.toLowerCase() && capture.file !== null,
    );
    let snapshot = null;
    for (const capture of matches) {
      const path = capturePath(captureRoot, capture.file);
      const bytes = readFileSync(path);
      if (hash(bytes) !== capture.sha256) refuse("Saved collector capture digest changed.");
      const parsed = parsePage(bytes.toString("utf8"), { handle: card.handle });
      const posts = parsed.posts.filter((post) => post.id === card.postId);
      if (parsed.truncated || posts.length !== 1) continue;
      const candidate = snapshotOf(posts[0], {
        handle: card.handle,
        capture: { file: capture.file, sha256: capture.sha256, captured_at: capture.captured_at },
      });
      if (candidate.snapshot_ref !== base.snapshot_ref)
        refuse("Collector stage body differs from its saved capture.");
      snapshot = candidate;
      break;
    }
    if (snapshot === null) refuse("No saved capture resolves the source snapshot.");
    snapshots.set(snapshot.snapshot_ref, snapshot);
  }
  const set = createSourceSet({
    collectionText,
    snapshots: [...snapshots.values()],
    excludedRegions: cards.flatMap((card) => card.sourceExclusions ?? []),
    cards: cards
      .filter((card) => card.sourceSnapshot)
      .map((card) => ({
        card_ref: card.cardRef,
        snapshot_ref: card.sourceSnapshot.snapshot_ref,
        title_line: card.titleLine,
        start_line: card.startLine,
        end_line: card.endLine,
        description_kind: card.descriptionKind,
        mapping_status: card.mappingStatus,
        links: card.sourceLinks,
        vacancy_no: card.vacancyNo,
      })),
  });
  return validateSourceSet(set, { collectionText: collectionText ?? "", captureRoot });
}
