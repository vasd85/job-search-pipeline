// The negative-space sweep: what the page said that the normalized object does not account for.
//
// The 2026-08-18 batch's most important line - a hard current-residence requirement - was in the
// page and in nobody's normalized object, and the run's keyword families did not reach it. So the
// sweep runs off a versioned vocabulary file that ratchets, and its verdict is binary: every hit in
// the main zone is either claimed by the normalized object or carries a disposition naming it.
// There is no third outcome, because a third outcome is where the previous check went to die.
//
// **Claiming is a quote span inside a field that decided something.** Span containment alone is not
// enough and an independent review is what settled it: `offers[].evidenceQuote` is one required
// string standing behind fourteen offer keys, so the natural quote for an offer is the whole terms
// line. A record quoting "MUST BE currently based in Singapore" while recording
// `residenceRestriction: "none"` is schema-valid, produces a trace that reproduces byte for byte,
// and under a containment-only rule would be claimed - the exact silent flip this sweep exists to
// catch. Widening a quote must not buy silence, so the claiming quote has to belong to an offer
// whose family-relevant field is actually set.
//
// **The main zone labels a hit; it does not excuse one.** Two review rounds went at the first
// version of this. The zone ended at a terminator phrase and everything after it was dropped with a
// counter, so a page could hide a requirement below its own "Similar jobs" rail and the batch
// passed. Anchoring the terminator to a line start and to the text the record quoted narrowed that,
// and a reviewer promptly reproduced it again below the deepest quote - which is precisely the
// class this sweep exists for, because the requirement the extractor missed is by definition the
// one it did not quote.
//
// So the zone no longer grants anything. Every hit is claimed or disposed, and the zone only
// decides *which finding code* an unanswered hit gets, so an operator can tell a requirement from
// page chrome and dispose the chrome once. A boundary that cannot exempt anything cannot be moved
// by the page into exempting something.
//
// Hits are answered per line and per family rather than per phrase. Several spellings of one family
// land on one sentence routinely, and a mechanism that asks for the same explanation once per
// spelling is one an operator learns to batch-approve.

import { dispositionKey, validateDispositions } from "../disposition.mjs";
import { findLiteralOccurrences, findPhraseOccurrences, lineDigest } from "../text-scan.mjs";
import { vocabularyPhrases } from "../vocabulary.mjs";

export const id = "negative-space";
export const cadence = "per-batch";
export const kind = "assert";

/**
 * One row per vocabulary family: which offer a quote must belong to before it may claim a hit of
 * that family. A static table, not an evaluator - three rows are not worth a predicate language,
 * and a language here would be one more thing nobody reviews.
 *
 * A family with no row falls back to plain span containment, and `tests/triage-verify.test.mjs`
 * pins that every shipped family has a row, so the fallback cannot become the quiet default.
 */
export const familyClaimRules = Object.freeze({
  residence: (offer) => offer?.residenceRestriction === "compatible"
    || offer?.residenceRestriction === "incompatible",
  contract: (offer) => (offer?.contractorEligibility !== undefined
    && offer.contractorEligibility !== "unknown")
    || (offer?.engagementPath ?? null) !== null,
  work_format: (offer) => offer?.workFormat !== undefined && offer.workFormat !== "Unknown",
});

const OFFER_QUOTE_PATH = /^offers\[(\d+)\]\.evidenceQuote$/u;

/**
 * Where page chrome starts, as a label.
 *
 * A terminator has to start a line, because a rail is a block of its own and a sentence that merely
 * names one is not, and it has to sit after the text the record quoted, because a rail rendered
 * above the description would otherwise label the description itself as chrome. Neither rule is
 * load-bearing any more - a hit past this offset is still reported and still has to be answered -
 * so the worst a page can do by defeating one is mislabel a finding it cannot suppress.
 */
function mainZoneEnd(body, terminators, quoteSpans) {
  const quotedUpTo = quoteSpans.reduce((furthest, span) => Math.max(furthest, span.end), 0);
  let end = body.length;
  let terminatorId = null;
  for (const terminator of terminators) {
    for (const occurrence of findPhraseOccurrences(body, terminator.text)) {
      const startsLine = occurrence.start === 0 || body[occurrence.start - 1] === "\n";
      if (!startsLine) continue;
      if (occurrence.start < quotedUpTo) continue;
      if (occurrence.start < end) {
        end = occurrence.start;
        terminatorId = terminator.id;
      }
    }
  }
  return { end, terminatorId };
}

/** Every occurrence of every evidence quote, tagged with the path the quote came from. */
function quoteSpansOf(body, quotes) {
  const spans = [];
  for (const quote of quotes) {
    for (const occurrence of findLiteralOccurrences(body, quote.value)) {
      spans.push({ ...occurrence, path: quote.path });
    }
  }
  return spans;
}

function claims(span, family, input) {
  const rule = familyClaimRules[family];
  if (rule === undefined) return true;
  const matched = span.path.match(OFFER_QUOTE_PATH);
  if (matched === null) return false;
  const offer = Array.isArray(input?.offers) ? input.offers[Number(matched[1])] : undefined;
  return offer !== undefined && rule(offer) === true;
}

function loadDispositions(context, families, findings) {
  const file = context.batch.disposition;
  if (!file.present) return new Map();
  if (file.error !== null || file.value === null) {
    findings.push({
      code: "disposition_unreadable",
      reason: file.error ?? "disposition_shape_unexpected",
    });
    return new Map();
  }
  const validated = validateDispositions(file.value, families);
  findings.push(...validated.problems);
  return validated.entries;
}

export function run(context) {
  const findings = [];
  const phrases = vocabularyPhrases(context.vocabulary);
  const families = new Set(context.vocabulary.families.map((family) => family.id));
  const dispositions = loadDispositions(context, families, findings);

  let hits = 0;
  let outsideMainZone = 0;
  const groups = new Map();

  for (const record of context.records) {
    const bodies = record.captures
      .filter((capture) => capture.verified?.ok === true)
      .map((capture) => ({ file: capture.file, body: capture.verified.body }));
    if (bodies.length === 0) continue;
    if (record.input === null) {
      findings.push({ code: "record_not_sweepable", index: record.index });
      continue;
    }
    for (const entry of bodies) {
      const spans = quoteSpansOf(entry.body, record.evidence.quotes);
      const zone = mainZoneEnd(entry.body, context.vocabulary.zoneTerminators, spans);
      // Claiming is decided per body and then merged, because one record's captures are two
      // observations of one page: a line the browser capture quoted is answered for that record
      // even when the degraded fetch capture carries it unquoted.
      const inThisBody = new Map();
      for (const phrase of phrases) {
        for (const occurrence of findPhraseOccurrences(entry.body, phrase.text)) {
          hits += 1;
          const outside = occurrence.start >= zone.end;
          if (outside) outsideMainZone += 1;
          const digest = lineDigest(entry.body, occurrence);
          const key = dispositionKey(record.index, phrase.family, digest);
          const local = inThisBody.get(key) ?? {
            claimed: true,
            family: phrase.family,
            file: entry.file,
            index: record.index,
            lineSha256: digest,
            outside: true,
            phraseIds: new Set(),
            terminator: zone.terminatorId,
          };
          local.phraseIds.add(phrase.id);
          if (!outside) local.outside = false;
          if (!spans.some((span) => span.start <= occurrence.start
            && occurrence.end <= span.end
            && claims(span, phrase.family, record.input))) {
            local.claimed = false;
          }
          inThisBody.set(key, local);
        }
      }
      for (const [key, local] of inThisBody) {
        const group = groups.get(key);
        if (group === undefined) {
          groups.set(key, local);
          continue;
        }
        group.claimed = group.claimed || local.claimed;
        group.outside = group.outside && local.outside;
        for (const phraseId of local.phraseIds) group.phraseIds.add(phraseId);
      }
    }
  }

  let claimed = 0;
  let disposed = 0;
  for (const [key, group] of groups) {
    if (group.claimed) {
      claimed += 1;
      continue;
    }
    const disposition = dispositions.get(key);
    if (disposition !== undefined) {
      disposition.used = true;
      disposed += 1;
      continue;
    }
    findings.push({
      code: group.outside ? "negative_space_outside_main_zone" : "negative_space_unclaimed",
      index: group.index,
      file: group.file,
      family: group.family,
      lineSha256: group.lineSha256,
      phraseIds: [...group.phraseIds].sort(),
      ...(group.outside ? { terminator: group.terminator } : {}),
    });
  }

  for (const disposition of dispositions.values()) {
    if (!disposition.used) {
      findings.push({
        code: "disposition_stale",
        index: disposition.recordIndex,
        family: disposition.family,
        lineSha256: disposition.lineSha256,
      });
    }
  }

  return {
    findings,
    counts: {
      vocabularyId: context.vocabulary.vocabularyId,
      phrasesScanned: phrases.length,
      hits,
      lines: groups.size,
      claimed,
      disposed,
      outsideMainZone,
    },
  };
}
