// The two periodic probes no code can run, recorded so their cadence is checkable.
//
// A capability probe needs a live source and a transport hypothesis needs the transport; neither
// exists inside an artifacts directory. Leaving them as prose would make the cadence a promise, so
// each batch that runs the periodic set carries a dated record instead.
//
// **This check is not an assertion about the probe.** It asserts that a record exists, names a
// probe from the closed set, sits inside this batch's own time window, and does not itself report a
// failure. That is why its kind is `attest` and not `assert`: a green row here means somebody said
// they ran it, which is weaker than a measurement and stronger than nothing, and calling it
// anything else would be the rubber stamp this suite exists to remove. The third probe of the
// 2026-08-18 protocol - the blind double extraction - is not here at all: it became a computed
// check in `blind-extraction.mjs`, because that one *can* be computed.
//
// Freshness is decided without reading a clock: the batch's own capture timestamps are the
// reference, so re-running the suite over the same directory a month later reaches the same verdict.

import { usableInstant } from "../instants.mjs";

export const id = "periodic-attestation";
export const cadence = "periodic";
export const kind = "attest";

export const attestationSchemaVersion = 1;

/** The closed probe set. A third probe is a deliberate edit here and in the runbook. */
export const requiredProbes = Object.freeze(["phase0_capability_probe", "transport_hypotheses"]);

export const attestationVerdicts = Object.freeze(["held", "changed", "failed"]);

const PROBE_KEYS = Object.freeze(["note", "probe", "ranAt", "verdict"]);
const REQUIRED_PROBE_KEYS = Object.freeze(["probe", "ranAt", "verdict"]);
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function batchWindow(context) {
  const source = context.sourceVerification;
  const captures = source?.active
    ? context.captures
    : context.records.flatMap((record) => record.captures);
  const instants = captures
    .filter((capture) => capture.verified?.ok === true)
    .map((capture) => usableInstant(capture.verified.header["fetched-at"]))
    .filter((value) => value !== null);
  if (source?.valid) {
    const selected = new Set(source.resolution.selection.card_refs);
    const cards = new Map(source.sourceSet.cards.map((card) => [card.card_ref, card]));
    const snapshots = new Map(
      source.sourceSet.snapshots.map((snapshot) => [snapshot.snapshot_ref, snapshot]),
    );
    // A summary has no extraction record. Only a selected observation bound to this checked
    // original HTML contributes its clock; saved but unselected/replaced snapshots do not.
    for (const observation of source.resolution.observations) {
      if (!selected.has(observation.card_ref)) continue;
      const snapshot = snapshots.get(cards.get(observation.card_ref)?.snapshot_ref);
      if (
        snapshot === undefined ||
        context.normalizeUrl(observation.source_ref) !==
          context.normalizeUrl(snapshot.original_url) ||
        observation.capture?.file !== snapshot.capture.file ||
        observation.capture?.sha256 !== snapshot.capture.sha256
      )
        continue;
      const instant = usableInstant(snapshot.capture.captured_at);
      if (instant !== null) instants.push(instant);
    }
  }
  if (instants.length === 0) return null;
  return { earliest: Math.min(...instants), latest: Math.max(...instants) };
}

export function run(context) {
  const findings = [];
  const file = context.batch.attestation;
  if (!file.present) {
    return { findings: [{ code: "attestation_absent" }], counts: { probes: 0 } };
  }
  if (file.error !== null || !isRecord(file.value)) {
    return {
      findings: [
        { code: "attestation_unreadable", reason: file.error ?? "attestation_shape_unexpected" },
      ],
      counts: { probes: 0 },
    };
  }
  const value = file.value;
  if (value.schemaVersion !== attestationSchemaVersion || !Array.isArray(value.probes)) {
    return { findings: [{ code: "attestation_invalid", reason: "shape" }], counts: { probes: 0 } };
  }

  const window = batchWindow(context);
  if (context.sourceVerification?.active && window === null)
    findings.push({ code: "source_probe_window_unverifiable" });
  const seen = new Map();
  value.probes.forEach((probe, position) => {
    if (!isRecord(probe)) {
      findings.push({ code: "attestation_invalid", position, reason: "not_an_object" });
      return;
    }
    for (const key of Object.keys(probe)) {
      if (!PROBE_KEYS.includes(key)) {
        findings.push({ code: "attestation_invalid", position, reason: "unknown_key" });
        return;
      }
    }
    for (const key of REQUIRED_PROBE_KEYS) {
      if (!(key in probe)) {
        findings.push({ code: "attestation_invalid", position, reason: "missing_key" });
        return;
      }
    }
    if (!requiredProbes.includes(probe.probe)) {
      findings.push({ code: "probe_unknown", position });
      return;
    }
    if (seen.has(probe.probe)) {
      findings.push({ code: "probe_duplicate", probe: probe.probe });
      return;
    }
    seen.set(probe.probe, probe);
    const ranAt = usableInstant(probe.ranAt);
    if (ranAt === null) {
      findings.push({ code: "attestation_invalid", position, reason: "ran_at" });
      return;
    }
    if (!attestationVerdicts.includes(probe.verdict)) {
      findings.push({ code: "attestation_invalid", position, reason: "verdict" });
      return;
    }
    if (window !== null && ranAt < window.earliest - ONE_DAY_MS) {
      findings.push({ code: "probe_stale", probe: probe.probe });
    }
    // The other side of the same window: a probe dated after the batch closed did not run for this
    // batch either, and only checking the past direction made "fresh" mean half of what it says.
    if (window !== null && ranAt > window.latest + ONE_DAY_MS) {
      findings.push({ code: "probe_out_of_window", probe: probe.probe });
    }
    if (probe.verdict === "failed") {
      findings.push({ code: "probe_failed", probe: probe.probe });
    }
  });

  for (const probe of requiredProbes) {
    if (!seen.has(probe)) findings.push({ code: "probe_missing", probe });
  }

  return { findings, counts: { probes: seen.size, required: requiredProbes.length } };
}
