// One result per logical vacancy. Source observations remain visible as alternatives and accounting.
import { summaryRow } from "../job-scorer/trace.mjs";
const flat = (value) =>
  String(value ?? "—")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/[|`<>]/gu, "'")
    .slice(0, 512);
/** One composition observation per logical result, never a union of source offer fields. */
export function sourceCompositionObservations(resolution) {
  if (
    resolution?.schema_version !== 1 ||
    !Array.isArray(resolution.groups) ||
    !Array.isArray(resolution.observations)
  )
    throw new TypeError("A source resolution version 1 is required.");
  return resolution.groups.map((group) => {
    const primary = resolution.observations.find(
      (observation) => observation.observation_ref === group.primary,
    );
    const offers = primary?.input?.offers ?? [];
    const offer =
      group.result?.review_code !== "source_review" && offers.length === 1 ? offers[0] : null;
    return {
      work_format: offer?.workFormat ?? "Unknown",
      company_region: offer?.companyRegion ?? "UNKNOWN",
      sponsorship: offer?.sponsorship ?? "unknown",
      relocation_destination_code: offer?.relocationCountryCode ?? null,
    };
  });
}
export function sourceSummaryRows(resolution) {
  if (
    resolution?.schema_version !== 1 ||
    !Array.isArray(resolution.groups) ||
    !Array.isArray(resolution.observations)
  )
    throw new TypeError("A source resolution version 1 is required.");
  return resolution.groups.map((group, at) => {
    const primary = resolution.observations.find(
      (observation) => observation.observation_ref === group.primary,
    );
    const candidate =
      primary ??
      resolution.observations.find(
        (observation) =>
          group.card_refs.includes(observation.card_ref) && observation.input !== null,
      );
    const trace = group.result;
    const row =
      trace?.review_code === "source_review" ? null : trace === null ? null : summaryRow(trace);
    return {
      logical_index: at + 1,
      logical_key: group.logical_key,
      card_refs: group.card_refs,
      title: row?.job_title ?? candidate?.input?.source.jobTitle ?? null,
      company: row?.company ?? candidate?.input?.source.company ?? null,
      decision: row?.decision ?? "MANUAL_REVIEW: source_review",
      identity_status: group.identity_status,
      primary: primary?.source_ref ?? null,
      reasons: group.conflicts,
      alternatives: group.alternatives,
      sources: group.sources,
    };
  });
}
export function renderSourceResolution(resolution) {
  const rows = sourceSummaryRows(resolution);
  const lines = [
    `Source triage: ${rows.length} logical vacancies, ${resolution.counts.supplied_urls} supplied URLs; ${resolution.counts.context_urls} company context URLs.`,
    "",
    "| # | Vacancy | Company | Result | Identity | Primary JD |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows)
    lines.push(
      `| ${row.logical_index} | ${flat(row.title)} | ${flat(row.company)} | ${flat(row.decision)} | ${row.identity_status} | ${flat(row.primary)} |`,
    );
  lines.push("", "Source accounting:");
  for (const row of rows) {
    lines.push(
      `\n#${row.logical_index}${row.reasons.length ? ` — ${row.reasons.join(", ")}` : ""}`,
    );
    for (const source of row.sources)
      lines.push(`  ${source.role}: ${source.disposition} — ${flat(source.source_ref)}`);
    if (row.decision === "MANUAL_REVIEW: source_review")
      for (const alternative of row.alternatives) {
        const observation = resolution.observations.find(
          (item) => item.observation_ref === alternative.observation_ref,
        );
        const summary = summaryRow(alternative.trace);
        lines.push(`  Alternative: ${flat(summary.decision)} — ${flat(observation?.source_ref)}`);
      }
  }
  return `${lines.join("\n")}\n`;
}
