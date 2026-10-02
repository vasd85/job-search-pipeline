/**
 * Collection freshness — the half of pre-triage that runs before anything is fetched at all.
 *
 * Measured basis (2026-08-18 verified run): 3 of 10 links were already closed at fetch time, one of
 * them roughly 22 hours after posting, and the operator's source file held 101 links collected the
 * day before. At that decay rate the tail of an old collection is mostly dead, so spending browser
 * and model budget on it in file order spends it on the least likely half first.
 *
 * Two answers, and both are reported rather than acted on silently:
 *
 * - **Is the collection still current?** An old one has to have its liveness re-established by a
 *   cheap sweep before the expensive lane opens.
 * - **In what order is it spent?** Newest first when the links carry posting instants; otherwise
 *   the order they arrived in, and the report says which of the two it was. A batch must never read
 *   "not ordered" as "ordered newest first".
 *
 * The module reads no clock. Every instant is supplied by the caller, exactly like
 * `tools/lib/triage-ledger-core.mjs`, so a replay of the same batch produces the same assessment.
 */
import { fail } from "./errors.mjs";

/**
 * How old a collection may be before its liveness must be re-established, in days.
 * docs/runbooks/triage-review.md#21-pre-triage-freshness-order-composition owns the number; `tests/pretriage.test.mjs` freezes it.
 */
export const collectionStaleAfterDays = 7;

/** Collection states. `undated` is not `fresh`: an unproven collection is swept, not trusted. */
export const collectionStates = Object.freeze(["fresh", "stale", "undated"]);

/** How the batch order was arrived at. Reported so silence is never mistaken for a guarantee. */
export const orderingBases = Object.freeze([
  "posted_at",
  "declared_newest_first",
  "input_order",
]);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const ZONE_DESIGNATOR = /(?:Z|[+-]\d{2}:\d{2})$/u;
const DAY_MS = 86_400_000;

/**
 * The instant a collection or posting timestamp denotes, or `null` when it denotes none.
 *
 * Two spellings are accepted. A full instant must carry its zone, for the reason
 * `tools/triage-verify/instants.mjs` states at length: a zone-less date-time is read in the host's
 * timezone and denotes a different moment on every machine, and each direction of that drift
 * relaxes a gate. A date-only spelling - what an operator actually writes next to a links file - is
 * read as midnight UTC, which is the earliest instant that date can mean and therefore the reading
 * that makes a collection look oldest. Being wrong in that direction costs a sweep; being wrong in
 * the other spends the expensive lane on dead links.
 */
export function collectionInstant(value) {
  if (typeof value !== "string") return null;
  if (DATE_ONLY.test(value)) {
    return calendarDate(`${value}T00:00:00Z`, value);
  }
  if (!ZONE_DESIGNATOR.test(value)) return null;
  // The same round trip guards the zoned spelling. `Date.parse` rolls 2026-02-30 forward to 2026-03-02
  // rather than refusing it, so without this a mistyped stamp reads two days younger than it was
  // written — and two days is a third of the staleness window.
  return calendarDate(value, value.slice(0, 10));
}

/** The instant a spelling denotes, or `null` when the calendar has no such date. */
function calendarDate(spelling, date) {
  const parsed = Date.parse(spelling);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().startsWith(date) ? parsed : null;
}

/**
 * Assess one collection against the instant the batch is running.
 *
 * `sweep_required` is the operative field: it is true for a stale collection and equally true for
 * an undated one. A collection that cannot say when it was gathered has not proved it is fresh, and
 * silence is never counted as proof anywhere else in this repository either.
 */
export function assessCollection({
  collectedAt = null,
  asOf,
  staleAfterDays = collectionStaleAfterDays,
} = {}) {
  // The batch instant must be zoned, and a date-only spelling is refused rather than read as
  // midnight. The date-only reading is deliberately the earliest instant a date can mean, which
  // makes a *collection* look older - the safe direction - and would make the *batch* look earlier,
  // which is the unsafe one: it shrinks every age and can hide a stale collection.
  if (typeof asOf === "string" && DATE_ONLY.test(asOf)) {
    fail("pretriage_invalid_instant", "The batch instant must carry a time and a zone.");
  }
  const asOfMs = collectionInstant(asOf);
  if (asOfMs === null) {
    fail("pretriage_invalid_instant", "The batch instant must be a zoned instant.");
  }
  if (!Number.isSafeInteger(staleAfterDays) || staleAfterDays < 1) {
    fail("pretriage_invalid_window", "The staleness window must be a positive whole number of days.");
  }
  if (collectedAt === null || collectedAt === undefined) {
    return {
      collected_at: null,
      as_of: asOf,
      age_days: null,
      state: "undated",
      stale_after_days: staleAfterDays,
      sweep_required: true,
    };
  }
  const collectedMs = collectionInstant(collectedAt);
  if (collectedMs === null) {
    // A present-but-unreadable date is louder than an absent one, and deliberately so: it means the
    // operator wrote something the policy could not use, which is a different problem from not
    // having written anything.
    fail(
      "pretriage_invalid_instant",
      "The collection date must be a zoned instant or a UTC date.",
    );
  }
  // A date-only stamp up to one day ahead is the operator writing their own local date: an hour
  // after midnight in Tbilisi, "today" is already tomorrow in UTC. That is an ordinary input, not a
  // mistake, so it clamps to age zero instead of stopping the batch. Anything further ahead is a
  // typo or a wrong clock, and stays loud.
  const aheadMs = collectedMs - asOfMs;
  const localDateAllowance = DATE_ONLY.test(collectedAt) ? DAY_MS : 0;
  if (aheadMs > localDateAllowance) {
    fail(
      "pretriage_collection_ahead_of_batch",
      "The collection date is later than the batch instant.",
    );
  }
  const ageMs = Math.max(0, asOfMs - collectedMs);
  return {
    collected_at: collectedAt,
    as_of: asOf,
    age_days: Math.round((ageMs / DAY_MS) * 1000) / 1000,
    state: ageMs >= staleAfterDays * DAY_MS ? "stale" : "fresh",
    stale_after_days: staleAfterDays,
    sweep_required: ageMs >= staleAfterDays * DAY_MS,
  };
}

/**
 * Order a collection newest first, and say on what evidence.
 *
 * Sorting is all-or-nothing on purpose. A partially dated list sorted by date would put every
 * undated link behind every dated one, which is a claim about their age that nothing observed - and
 * the undated links are exactly the ones a search export leaves in its own newest-first order. So:
 * every link dated, sort; otherwise leave the order alone and name it. `declared_newest_first` is
 * the operator's own assertion that the file already is in that order, kept distinct from
 * `input_order` because one is a claim and the other is an absence of one.
 *
 * Sorting relies on `Array.prototype.sort` being stable, which the language guarantees, so two
 * links posted in the same minute keep their input order rather than swapping between runs. An
 * explicit tie-break would be a line no test could ever fail.
 *
 * **Who produces `posted_at`.** No reader in this repository does today: a links file holds URLs,
 * and neither the fetch manifest nor the ledger carries a posting instant. The basis a real batch
 * gets is therefore `declared_newest_first` or `input_order`, and the sort is here for a caller
 * that has the dates - which is why the basis is reported rather than assumed.
 */
export function orderNewestFirst(links, { declaredOrder = null } = {}) {
  if (!Array.isArray(links)) fail("pretriage_invalid_links", "Links must be an array.");
  const dated = links.map((link) => ({
    link,
    instant: collectionInstant(link?.posted_at ?? null),
  }));
  if (links.length > 0 && dated.every((entry) => entry.instant !== null)) {
    const ordered = [...dated].sort((left, right) => right.instant - left.instant);
    return { basis: "posted_at", links: ordered.map((entry) => entry.link) };
  }
  return {
    basis: declaredOrder === "newest-first" ? "declared_newest_first" : "input_order",
    links: [...links],
  };
}
