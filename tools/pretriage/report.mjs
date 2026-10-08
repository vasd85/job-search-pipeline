/**
 * The two things pre-triage puts in front of the user, rendered.
 *
 * Prose is in the default language of the operating contract, because a report is written by this
 * code and not by the agent. Every machine token - disposition, liveness reason, ordering basis,
 * work format, company region - stays verbatim and untranslated, because those are the strings the
 * ledger, the manifest and the rubric use.
 *
 * A rendered link is external content. It is printed as data and truncated, never interpreted, and
 * nothing downstream reads this text back: the plan object is the machine-readable authority and
 * this is the human-readable view of it.
 */
import { compositionBuckets } from "./composition.mjs";
import { dispositions, sourceDispositions } from "./plan.mjs";
import { fail } from "./errors.mjs";

// `typeof null === "object"`, so a guard written on `typeof` alone lets a null field through and
// the renderer throws a raw TypeError instead of this stage's bounded error.
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** English agreement for a count: one link, two links. */
function plural(count, one, many) {
  return Math.abs(count) === 1 ? one : many;
}

const MAX_RENDERED_URL = 200;
// The URL validator refuses C0 controls and DEL, and the links reader splits on CR/LF — none of
// which covers the Unicode separators. A URL carrying one of them would otherwise break a one-line
// report into two lines, which is how a link makes the report say something its author did not.
// Line separators break one report line into two; bidi overrides reorder what a line appears to
// say without changing a byte of it. Both are neutralised, because the point of printing a link is
// that the reader can recognise the resource the plan actually holds.
const UNICODE_SEPARATORS = /[\u2028\u2029\u0085\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

function link(url) {
  if (typeof url !== "string") return "(no link)";
  const flat = url.replace(UNICODE_SEPARATORS, "�");
  return flat.length > MAX_RENDERED_URL ? `${flat.slice(0, MAX_RENDERED_URL)}…` : flat;
}

function percent(ratio) {
  return `${(Math.round(ratio * 1000) / 10).toFixed(1)}%`;
}

function freshnessLine(freshness) {
  if (freshness.state === "undated") {
    return `Collection with no collection date — read as unverified, window ${freshness.stale_after_days} d.`;
  }
  return (
    `Collection of ${freshness.collected_at}: age ${freshness.age_days} d.,` +
    ` state ${freshness.state}, window ${freshness.stale_after_days} d.`
  );
}

/** The dispositions that genuinely end a link's spend. Everything else still costs the batch. */
const WITHHELD = new Set([
  "skipped_by_ledger",
  "duplicate_in_batch",
  "unreadable_link",
  "terminal_gone",
  "company_context",
  "source_contact",
  "source_summary",
]);

function block(lines, heading, rows) {
  if (rows.length === 0) return;
  lines.push("", heading);
  for (const row of rows) {
    const reason = row.reason === null ? row.disposition : `${row.disposition} ${row.reason}`;
    lines.push(`  #${row.input_index} ${reason} — ${link(row.url)}`);
  }
}

/**
 * The batch-start report: freshness, ordering, the spend accounting, and one line per link that
 * will not reach the expensive lane.
 *
 * One line per such link is the point. A batch that quietly dropped 15 dead links and said only
 * "15" would be asking to be trusted about which 15.
 *
 * The two blocks are separate because the first version had one, filtered as "not expensive_lane",
 * and so listed `browser_rung` and `pending_sweep` links under a heading saying they cost nothing —
 * three lines below a saving figure that correctly excluded them. A link awaiting a browser load,
 * and a link awaiting the sweep, are still ahead of the batch.
 */
export function renderPreTriagePlan(plan) {
  if (
    !isObject(plan) ||
    !Array.isArray(plan.links) ||
    !isObject(plan.spend) ||
    !isObject(plan.freshness) ||
    !isObject(plan.ordering) ||
    !isObject(plan.gate)
  ) {
    fail("pretriage_invalid_plan", "The plan must carry an array of links.");
  }
  const spend = plan.spend;
  const lines = [
    `Pre-triage: ${spend.supplied} ${plural(spend.supplied, "link", "links")},` +
      ` order — ${plan.ordering.basis}.`,
    freshnessLine(plan.freshness),
    plan.gate.expensive_lane_open
      ? "Gate: the expensive lane is open."
      : `Gate: the expensive lane is closed (${plan.gate.blocked_by.join(", ")}).`,
    `Saved: ${spend.avoided_expensive_lane} of ${spend.supplied}` +
      ` (${percent(spend.avoided_share)}) will not reach the expensive lane;` +
      ` of those ${spend.avoided_by_pretriage} were removed by pre-triage,` +
      ` ${spend.avoided_by_ledger} by the ledger,` +
      ` ${spend.unreadable_link} are unreadable. Never fetched at all: ${spend.never_fetched}.`,
    `Dispositions: ${Object.keys(spend)
      .filter((key) => [...dispositions, ...sourceDispositions].includes(key))
      .map((key) => `${key} ${spend[key]}`)
      .join(", ")}.`,
  ];
  if (plan.logical !== undefined)
    lines.push(
      `Logical vacancies: ${plan.logical.supplied}. Collector descriptions: ${spend.source_snapshot}; company context: ${spend.company_context}.`,
    );
  block(
    lines,
    "Not reaching the expensive lane:",
    plan.links.filter((row) => WITHHELD.has(row.disposition)),
  );
  block(
    lines,
    "Still costing the budget:",
    plan.links.filter(
      (row) => row.disposition === "browser_rung" || row.disposition === "pending_sweep",
    ),
  );
  return lines.join("\n");
}

/**
 * The composition report: what the collection contains, against the candidate's priority classes.
 *
 * `outside` and `unknown` are printed beside 1/2/3 rather than folded away. A collection that is
 * mostly `outside` is the finding; a collection that is mostly `unknown` means the header facts
 * were too thin to say, which is a different finding and must not read as the first one.
 */
export function renderCompositionReport(composition) {
  // The guard checks what the renderer reads, not merely that an object was passed: a report built
  // by hand, or one from a future shape, must fail with a bounded code rather than a TypeError
  // thrown from the middle of a string template.
  if (
    !isObject(composition) ||
    !isObject(composition.by_priority_class) ||
    !isObject(composition.priority_class_shares) ||
    !isObject(composition.by_work_format) ||
    !isObject(composition.by_company_region)
  ) {
    fail("pretriage_invalid_composition", "The composition report must be an object.");
  }
  const lines = [
    `Batch composition: ${composition.total}` +
      ` ${plural(composition.total, "vacancy", "vacancies")}` +
      " (the candidate's priority classes).",
  ];
  for (const bucket of compositionBuckets) {
    const count = composition.by_priority_class[bucket];
    const label =
      bucket === "outside"
        ? "outside (none of the three classes)"
        : bucket === "unknown"
          ? "unknown (the source did not say)"
          : `class ${bucket}`;
    lines.push(`  ${label}: ${count} (${percent(composition.priority_class_shares[bucket])})`);
  }
  lines.push(
    `Work format: ${Object.entries(composition.by_work_format)
      .map(([name, count]) => `${name} ${count}`)
      .join(", ")}.`,
    `Company region: ${Object.entries(composition.by_company_region)
      .map(([name, count]) => `${name} ${count}`)
      .join(", ")}.`,
  );
  return lines.join("\n");
}
