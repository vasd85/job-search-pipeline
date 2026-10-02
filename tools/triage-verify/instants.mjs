// What counts as a usable instant, in one place.
//
// Four gates rest on the timestamps the batch's artifacts carry - skip support, the write-back
// guard, the ledger baseline and probe freshness - and every one of them fails open: a value it
// cannot read is treated as no value at all, which is quieter than leaving the field out. Two review
// rounds walked through that door in a row, so the predicate lives here and the readers share it
// rather than each deciding for itself what readable means.
//
// Readable is not enough. `Date.parse` accepts an ISO date-time with no zone designator and reads it
// in the host's timezone, so `2026-08-23T09:15:00.000` denotes a different instant on every machine
// - earlier than it says on a host ahead of UTC, later on one behind it - and each direction relaxes
// a gate rather than none. Read later, the write-back guard stops firing and a row this batch
// recorded passes as the baseline it is compared against. Read earlier, a healthy baseline row reads
// as this batch's own write-back and a recordable batch is refused. The probe window loses whichever side
// the drift points away from. It would also make the report's byte-identical promise true only per
// timezone. So a usable instant carries its zone: `Z` or an explicit offset, which is what
// `toISOString()` writes and therefore what every artifact in this repository already carries.

const ZONE_DESIGNATOR = /(?:Z|[+-]\d{2}:\d{2})$/u;

/** The instant a value denotes, or `null` when it denotes none unambiguously. */
export function usableInstant(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (!ZONE_DESIGNATOR.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Is a field that is *present* unusable as an instant?
 *
 * Absence is somebody else's finding - the field may be legitimately empty. This answers the other
 * question: the value is there and does not denote an instant, which must never be the quieter of
 * the two.
 */
export function presentButUnusable(value) {
  if (typeof value !== "string" || value.length === 0 || value === "-") return false;
  return usableInstant(value) === null;
}
