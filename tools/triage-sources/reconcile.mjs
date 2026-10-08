/** Immutable source resolution. A link is membership, not vacancy identity or a JD.
 * This compiler preserves every observation and never copies a field between descriptions.
 * File-backed validation rechecks the source bytes before reproducing the complete result.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  logicalVacancyKey,
  normalizeVacancyUrl,
  vacancyIdentity,
} from "../lib/triage-ledger-core.mjs";
import { buildDecisionTrace } from "../job-scorer/trace.mjs";
import { normalizeScorerInput, TRIAGE_POLICY_ID } from "../job-scorer/normalized-input.mjs";
import { discoverEvidence } from "../triage-verify/evidence.mjs";
import { verifyCaptureFile } from "../vacancy-fetch/persist.mjs";
import { requestedUrl, serverSuppliedUrl } from "../vacancy-fetch/url-rule.mjs";
import {
  cardBody,
  serializeSourceSet,
  sourceSetDigest,
  sourceSetMemberships,
  validateSourceSet,
} from "./source-set.mjs";

export const sourceResolutionSchemaVersion = 1;
export const sourceResolutionBasename = "source-resolution.json";
export const identityStatuses = Object.freeze(["confirmed", "linked_unconfirmed", "different"]);
export const sourceReviewCodes = Object.freeze([
  "mapping_unresolved",
  "unknown_link_role",
  "source_not_observed",
  "identity_unconfirmed",
  "identity_mismatch",
  "no_full_jd",
  "conflicting_title",
  "conflicting_seniority",
  "conflicting_salary",
  "conflicting_publication_date",
  "conflicting_liveness",
]);
export const MAX_RESOLUTION_BYTES = 32 * 1024 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_OBSERVATIONS = 999;
const FACT_KEYS = ["company", "title", "role", "seniority", "salary", "published_at"];
const HEX = /^[a-f0-9]{64}$/u;
const rawKeys = [
  "card_ref",
  "source_ref",
  "description_kind",
  "identity_status",
  "capture",
  "body",
  "facts",
  "input",
];
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) =>
  plain(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fold = (value) => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const equal = (a, b) => canonical(a) === canonical(b);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export class SourceResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceResolutionError";
    this.code = "source_resolution_invalid";
  }
}
function refuse(message) {
  throw new SourceResolutionError(message);
}
export function serializeSourceResolution(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
export function sourceResolutionDigest(value) {
  return hash(
    typeof value === "string" || Buffer.isBuffer(value) ? value : serializeSourceResolution(value),
  );
}

function sourceUrl(value) {
  try {
    return normalizeVacancyUrl(value);
  } catch {
    refuse("A source reference is not a supported web URL.");
  }
}
function collectionLinks(text) {
  if (typeof text !== "string" && !Buffer.isBuffer(text))
    refuse("Resolution needs the exact collection bytes.");
  const seen = new Set();
  const links = [];
  for (const line of text
    .toString()
    .replace(/^\uFEFF/u, "")
    .split(/\r\n|\r|\n/u)) {
    const url = line.trim();
    if (!url || url.startsWith("#") || seen.has(url)) continue;
    sourceUrl(url);
    seen.add(url);
    links.push(url);
  }
  if (links.length === 0 || links.length > 4096)
    refuse("Collection must contain between one and 4096 URLs.");
  return links;
}
function selectionOf(set, links, selection) {
  const value = selection ?? {
    from: 1,
    to: links.length,
    card_refs: set.cards.map((card) => card.card_ref),
  };
  if (
    !keys(value, ["from", "to", "card_refs"]) ||
    !Number.isSafeInteger(value.from) ||
    !Number.isSafeInteger(value.to) ||
    value.from < 1 ||
    value.to < value.from ||
    value.to > links.length ||
    !Array.isArray(value.card_refs) ||
    !value.card_refs.length ||
    new Set(value.card_refs).size !== value.card_refs.length
  )
    refuse("Resolution selection is invalid.");
  const cards = new Map(set.cards.map((card) => [card.card_ref, card]));
  if (value.card_refs.some((ref) => !cards.has(ref))) refuse("Resolution selects an absent card.");
  const selected = new Set(value.card_refs);
  const positions = new Map();
  links.forEach((url, at) => {
    for (const member of sourceSetMemberships(set, url)) {
      if (["company_context", "contact"].includes(member.role)) continue;
      if (!positions.has(member.card_ref)) positions.set(member.card_ref, []);
      positions.get(member.card_ref).push(at + 1);
      if (at + 1 >= value.from && at + 1 <= value.to && !selected.has(member.card_ref))
        refuse("A job source in the selected range belongs to an unselected card.");
    }
  });
  for (const ref of selected)
    if ((positions.get(ref) ?? []).some((at) => at < value.from || at > value.to))
      refuse("Selection splits a vacancy's job sources.");
  return {
    from: value.from,
    to: value.to,
    card_refs: set.cards.filter((card) => selected.has(card.card_ref)).map((card) => card.card_ref),
  };
}
function safeArtifact(root, file, limit = MAX_BODY_BYTES * 10) {
  artifactName(file);
  let base, path;
  try {
    base = realpathSync(root);
    path = base;
    for (const part of file.split("/")) {
      path = join(path, part);
      if (lstatSync(path).isSymbolicLink()) refuse("Artifact path contains a symlink.");
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > limit) refuse("Artifact is not a bounded regular file.");
    const rel = relative(base, realpathSync(path));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      refuse("Artifact path escapes its root.");
    return readFileSync(path);
  } catch (error) {
    if (error instanceof SourceResolutionError) throw error;
    refuse("Referenced artifact cannot be read.");
  }
}
function artifactName(file) {
  if (
    typeof file !== "string" ||
    file.length > 256 ||
    isAbsolute(file) ||
    !/^[A-Za-z0-9._/-]+$/u.test(file) ||
    file.split("/").some((part) => !part || part === "." || part === "..")
  )
    refuse("Artifact reference is not a safe relative path.");
}
function normalizeFact(fact, body, field) {
  if (fact === null) return null;
  if (
    !keys(fact, ["value", "evidence_quote"]) ||
    typeof fact.value !== "string" ||
    !fact.value.length ||
    fact.value.length > 512 ||
    typeof fact.evidence_quote !== "string" ||
    !fact.evidence_quote.length ||
    !body?.includes(fact.evidence_quote) ||
    !fold(fact.evidence_quote).includes(fold(fact.value))
  )
    refuse("An explicit source fact is not supported by its own body.");
  if (
    field === "published_at" &&
    (!/^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/u.test(fact.value) || !Number.isFinite(Date.parse(fact.value)))
  )
    refuse("Publication date is not an explicit supported instant.");
  return { value: fact.value, evidence_quote: fact.evidence_quote };
}
function fullRange(body) {
  return { startLine: 1, endLine: body.split(/\r\n|\r|\n/u).length };
}
function observationRole(card, ref) {
  const roles = card.links
    .filter((link) => !link.url.startsWith("mailto:") && sourceUrl(link.url) === sourceUrl(ref))
    .map((link) => link.role);
  const job = roles.filter((role) => !["company_context", "contact"].includes(role));
  if (!job.length) refuse("A context or contact link cannot become a scoring observation.");
  return job.includes("original_post")
    ? "original_post"
    : job.includes("details")
      ? "details"
      : job.includes("apply")
        ? "apply"
        : "unknown";
}
function verifyTransport(observation, captureRoot) {
  const transport = observation.transport;
  if (transport === null) {
    if (observation.capture === null) refuse("A body-less failure needs a manifest record.");
    return;
  }
  if (
    !keys(transport, ["file", "sha256", "index"]) ||
    !HEX.test(transport.sha256 ?? "") ||
    !Number.isSafeInteger(transport.index) ||
    transport.index < 1
  )
    refuse("Transport reference is invalid.");
  artifactName(transport.file);
  if (captureRoot === undefined) return;
  const bytes = safeArtifact(captureRoot, transport.file, 8 * 1024 * 1024);
  if (hash(bytes) !== transport.sha256) refuse("Transport artifact digest differs.");
  let manifest;
  try {
    manifest = JSON.parse(bytes);
  } catch {
    refuse("Transport artifact is not JSON.");
  }
  if (
    ![1, 2].includes(manifest?.schemaVersion) ||
    manifest.tool !== "vacancy-fetch" ||
    !Array.isArray(manifest.records)
  )
    refuse("Transport artifact is not a fetch manifest.");
  const record = manifest.records.find((row) => row.index === transport.index);
  if (record?.requestedUrl !== requestedUrl(observation.source_ref))
    refuse("Transport record identifies another source.");
  if (
    observation.capture === null &&
    (record.usable !== false ||
      !["access_failure", "absent", "private", "closed"].includes(record.outcome))
  )
    refuse("Transport record does not corroborate a body-less failure.");
  if (
    observation.input?.source.accessOutcome === "closed" &&
    observation.capture === null &&
    (record.outcome !== "absent" || record.httpStatus !== 404)
  )
    refuse("A body-less closure needs the existing confirmed 404 contract.");
  if (
    observation.capture !== null &&
    record.persisted !== null &&
    record.persisted !== undefined &&
    record.persisted.file !== observation.capture.file
  )
    refuse("Transport record identifies another capture.");
}
function normalizedObservation(raw, set, { languages, scoring, captureRoot }) {
  if (!plain(raw)) refuse("Observation must be an object.");
  const hasTransport = Object.hasOwn(raw, "transport");
  if (!keys(raw, hasTransport ? [...rawKeys, "transport"] : rawKeys))
    refuse("Observation has unexpected fields.");
  const card = set.cards.find((item) => item.card_ref === raw.card_ref);
  const snapshot = set.snapshots.find((item) => item.snapshot_ref === card?.snapshot_ref);
  if (
    card === undefined ||
    snapshot === undefined ||
    !["full_description", "summary", "unknown"].includes(raw.description_kind) ||
    !identityStatuses.includes(raw.identity_status)
  )
    refuse("Observation references or codes are invalid.");
  const role = observationRole(card, raw.source_ref);
  if (raw.identity_status === "different" && !["details", "apply"].includes(role))
    refuse("A different publication needs an explicit job-page link.");
  const transport = raw.transport ?? null;
  if (!keys(raw.facts, FACT_KEYS))
    refuse("Observation must explicitly account for every material fact.");
  const noBody = raw.capture === null;
  if (
    noBody
      ? raw.body !== null
      : typeof raw.body !== "string" ||
        Buffer.byteLength(raw.body) > MAX_BODY_BYTES ||
        !keys(raw.capture, ["file", "sha256"]) ||
        !HEX.test(raw.capture.sha256 ?? "")
  )
    refuse("Observation body or capture reference is invalid.");
  if (!noBody) artifactName(raw.capture.file);
  const facts = Object.fromEntries(
    FACT_KEYS.map((field) => [field, normalizeFact(raw.facts[field], raw.body, field)]),
  );
  const input = raw.input === null ? null : normalizeScorerInput(raw.input, { languages, scoring });
  if (input !== null && (input.schemaVersion !== 10 || input.sourceContext === null))
    refuse("A source observation requires a version 10 input with its source context.");
  if (input !== null && input.inputIndex > MAX_OBSERVATIONS)
    refuse("Extraction ordinal exceeds the artifact filename limit.");
  const originalHtml =
    role === "original_post" &&
    raw.capture !== null &&
    raw.capture.file === snapshot.capture.file &&
    raw.capture.sha256 === snapshot.capture.sha256;
  if (
    originalHtml &&
    (raw.body !== cardBody(set, card) || raw.description_kind !== card.description_kind)
  )
    refuse("Original description differs from its immutable card body or kind.");
  if (role === "original_post" && !originalHtml && input?.source.accessOutcome === "usable")
    refuse("A usable original post must use its code-extracted immutable card body.");
  if (
    noBody &&
    (raw.description_kind !== "unknown" ||
      raw.identity_status !== "linked_unconfirmed" ||
      input === null ||
      input.source.accessOutcome === "usable" ||
      Object.values(facts).some((fact) => fact !== null))
  )
    refuse("A body-less failure cannot assert a JD, identity or material facts.");
  const range = noBody
    ? { startLine: null, endLine: null }
    : originalHtml
      ? { startLine: card.start_line, endLine: card.end_line }
      : fullRange(raw.body);
  if (input !== null) {
    const context = {
      sourceSetSha256: sourceSetDigest(set),
      cardRef: card.card_ref,
      snapshotRef: snapshot.snapshot_ref,
      primarySourceRef: raw.source_ref,
      primaryCaptureSha256: raw.capture?.sha256 ?? null,
      ...range,
    };
    if (
      !equal(input.sourceContext, context) ||
      sourceUrl(input.source.sourceRef) !== sourceUrl(raw.source_ref)
    )
      refuse("Input context does not identify its own source and vacancy boundaries.");
    if (input.source.accessOutcome === "usable" && raw.description_kind !== "full_description")
      refuse("A summary or unresolved mapping cannot be scored as a full JD.");
    if (input.source.accessOutcome === "usable" && card.mapping_status !== "resolved")
      refuse("An unresolved card cannot be scored as a confirmed vacancy.");
    if (
      (facts.company !== null && input.source.company !== facts.company.value) ||
      (facts.title !== null && input.source.jobTitle !== facts.title.value) ||
      (facts.salary !== null && input.source.salaryRaw !== facts.salary.value)
    )
      refuse("Input metadata differs from its own explicit facts.");
    if (
      facts.seniority !== null &&
      /(?:^|\W)junior\+?(?:$|\W)/iu.test(facts.seniority.value) &&
      input.role.seniority !== "junior"
    )
      refuse("Explicit Junior seniority must retain the junior filter.");
    for (const quote of discoverEvidence(input).quotes)
      if (!raw.body?.includes(quote.value))
        refuse("Input evidence belongs outside its own source body.");
  }
  if (captureRoot !== undefined && !originalHtml && raw.capture !== null) {
    const bytes = safeArtifact(captureRoot, raw.capture.file);
    const captured = verifyCaptureFile(bytes.toString("utf8"));
    if (
      !captured.ok ||
      captured.body !== raw.body ||
      captured.header["normalized-sha256"] !== raw.capture.sha256 ||
      captured.header["requested-url"] !== requestedUrl(raw.source_ref)
    )
      refuse("Captured description, digest or requested identity differs.");
    if (
      input?.source.finalUrl !== null &&
      input?.source.finalUrl !== undefined &&
      serverSuppliedUrl(input.source.finalUrl) !== serverSuppliedUrl(captured.header["final-url"])
    )
      refuse("Input final identity differs from its capture.");
    if (
      input?.source.accessOutcome === "usable" &&
      ["access_failure", "absent", "private", "closed", "unknown"].includes(captured.header.outcome)
    )
      refuse("Failed or closed capture cannot be a usable description.");
  }
  const value = {
    card_ref: card.card_ref,
    source_ref: raw.source_ref,
    description_kind: raw.description_kind,
    identity_status: raw.identity_status,
    capture: raw.capture,
    body: raw.body,
    facts,
    input,
    transport,
  };
  verifyTransport(value, captureRoot);
  const observation_ref = `source-observation:sha256:${hash(canonical(value))}`;
  return {
    ...value,
    observation_ref,
    trace: input === null ? null : buildDecisionTrace(input, { languages, scoring }),
  };
}
function explicitCompatible(a, b, field) {
  const left = a?.facts[field],
    right = b?.facts[field];
  return (
    left === null ||
    right === null ||
    left === undefined ||
    right === undefined ||
    fold(left.value) === fold(right.value)
  );
}
function relationConfirmed(observation, original, set, card) {
  if (observation.identity_status !== "confirmed") return false;
  if (observationRole(card, observation.source_ref) === "original_post") return true;
  if (!["details", "apply"].includes(observationRole(card, observation.source_ref))) return false;
  if (observation.input?.source.finalUrl === null || observation.input === null) return false;
  const requestedIdentity = vacancyIdentity(observation.source_ref);
  const finalIdentity = vacancyIdentity(observation.input.source.finalUrl);
  if (
    requestedIdentity.key !== finalIdentity.key &&
    serverSuppliedUrl(observation.source_ref) !==
      serverSuppliedUrl(observation.input.source.finalUrl)
  )
    return false;
  for (const field of ["company", "role"]) {
    const fact = observation.facts[field];
    if (fact === null) return false;
    if (original?.facts[field] !== null && original?.facts[field] !== undefined) {
      if (fold(original.facts[field].value) !== fold(fact.value)) return false;
    } else if (!fold(cardBody(set, card)).includes(fold(fact.value))) return false;
  }
  return true;
}
function sourceRows(card, observations) {
  return card.links.map((link) => {
    const found = observations.find(
      (observation) =>
        !link.url.startsWith("mailto:") &&
        sourceUrl(observation.source_ref) === sourceUrl(link.url),
    );
    const disposition =
      link.role === "company_context"
        ? "company_context"
        : link.role === "contact"
          ? "contact"
          : found === undefined
            ? "source_not_observed"
            : found.input?.source.accessOutcome === "technical_unavailable"
              ? "technical_unavailable"
              : found.input?.source.accessOutcome === "closed"
                ? "closed"
                : found.description_kind === "summary"
                  ? "summary"
                  : found.description_kind === "unknown"
                    ? "unknown"
                    : "description";
    return {
      card_ref: card.card_ref,
      anchor: link.anchor,
      source_ref: link.url,
      role: link.role,
      disposition,
      observation_ref: found?.observation_ref ?? null,
    };
  });
}
function groupFor(card, set, observations, { separate = false, excludedSources = [] } = {}) {
  const original = observations.find(
    (observation) => observationRole(card, observation.source_ref) === "original_post",
  );
  const full = observations.filter(
    (observation) =>
      observation.description_kind === "full_description" &&
      observation.input?.source.accessOutcome === "usable",
  );
  const confirmed = (
    separate
      ? full
      : full.filter((observation) => relationConfirmed(observation, original, set, card))
  ).sort((a, b) => {
    const rank = (observation) =>
      ["original_post", "details", "apply", "unknown"].indexOf(
        observationRole(card, observation.source_ref),
      );
    return rank(a) - rank(b) || a.source_ref.localeCompare(b.source_ref);
  });
  const originalFull = confirmed.find(
    (observation) => observationRole(card, observation.source_ref) === "original_post",
  );
  const primary = originalFull ?? confirmed[0] ?? null;
  const sources = sourceRows(card, observations).filter(
    (source) =>
      ["company_context", "contact"].includes(source.role) ||
      !excludedSources.some((ref) => sourceUrl(ref) === sourceUrl(source.source_ref)),
  );
  const reasons = [];
  if (card.mapping_status !== "resolved") reasons.push("mapping_unresolved");
  if (sources.some((source) => source.role === "unknown")) reasons.push("unknown_link_role");
  if (
    sources.some(
      (source) =>
        source.disposition === "source_not_observed" &&
        !["original_post", "contact", "company_context"].includes(source.role),
    )
  )
    reasons.push("source_not_observed");
  if (
    full.some((observation) => !confirmed.includes(observation)) ||
    observations.some(
      (observation) =>
        observation.identity_status === "linked_unconfirmed" &&
        observation.input?.source.accessOutcome === "usable",
    )
  )
    reasons.push("identity_unconfirmed");
  if (
    full.length &&
    observations.some((observation) => observation.input?.source.accessOutcome === "closed")
  )
    reasons.push("conflicting_liveness");
  for (const field of ["title", "seniority", "salary", "published_at"]) {
    for (let at = 0; at < full.length; at += 1)
      if (full.slice(at + 1).some((other) => !explicitCompatible(full[at], other, field)))
        reasons.push(
          field === "published_at" ? "conflicting_publication_date" : `conflicting_${field}`,
        );
  }
  const conflicts = [...new Set(reasons)].sort();
  let result = primary?.trace ?? null;
  if (primary === null) {
    const failure = observations.find(
      (observation) =>
        observation.trace?.decision === "BLOCKED" ||
        observation.trace?.skip_code === "vacancy_unavailable",
    );
    if (failure !== undefined && full.length === 0 && !conflicts.length) result = failure.trace;
    else {
      conflicts.push("no_full_jd");
      result = {
        decision: "MANUAL_REVIEW",
        review_code: "source_review",
        reason_codes: [...new Set(conflicts)].sort(),
      };
    }
  } else if (conflicts.length)
    result = { decision: "MANUAL_REVIEW", review_code: "source_review", reason_codes: conflicts };
  return {
    logical_key: separate
      ? logicalVacancyKey(`${card.card_ref}\0${observations[0].source_ref}`)
      : logicalVacancyKey(card.card_ref),
    card_refs: [card.card_ref],
    identity_status: separate
      ? "different"
      : conflicts.length
        ? "linked_unconfirmed"
        : primary !== null
          ? "confirmed"
          : "linked_unconfirmed",
    primary: primary?.observation_ref ?? null,
    sources,
    conflicts: [...new Set(conflicts)].sort(),
    result,
    alternatives: observations
      .filter((observation) => observation.trace !== null)
      .map((observation) => ({
        observation_ref: observation.observation_ref,
        trace: observation.trace,
      })),
  };
}
function postingSources(group, observations) {
  return group.sources
    .filter(
      (source) =>
        ["details", "apply"].includes(source.role) &&
        observations.find((observation) => observation.observation_ref === source.observation_ref)
          ?.identity_status === "confirmed",
    )
    .map((source) => vacancyIdentity(source.source_ref).key);
}
function mergeConfirmed(groups, observations) {
  const result = [];
  for (const group of groups) {
    const primary = observations.find(
      (observation) => observation.observation_ref === group.primary,
    );
    const postings = postingSources(group, observations);
    const previous =
      group.identity_status === "confirmed" && postings.length
        ? result.find((candidate) => {
            if (
              candidate.identity_status !== "confirmed" ||
              !postingSources(candidate, observations).some((key) => postings.includes(key))
            )
              return false;
            const prior = observations.find(
              (observation) => observation.observation_ref === candidate.primary,
            );
            return (
              ["company", "role"].every(
                (field) =>
                  primary?.facts[field] !== null &&
                  prior?.facts[field] !== null &&
                  primary?.facts[field] !== undefined &&
                  prior?.facts[field] !== undefined &&
                  fold(primary.facts[field].value) === fold(prior.facts[field].value),
              ) &&
              ["title", "seniority", "salary", "published_at"].every((field) =>
                explicitCompatible(primary, prior, field),
              )
            );
          })
        : undefined;
    if (previous === undefined) {
      result.push(group);
      continue;
    }
    previous.card_refs = [...previous.card_refs, ...group.card_refs].sort();
    previous.logical_key = logicalVacancyKey(previous.card_refs[0]);
    previous.sources.push(...group.sources);
    previous.alternatives.push(...group.alternatives);
    // Both primary descriptions remain visible; deterministic preference for a full original.
    const choices = [previous.primary, group.primary].map((ref) =>
      observations.find((observation) => observation.observation_ref === ref),
    );
    const original = (observation) =>
      previous.sources.some(
        (source) =>
          source.observation_ref === observation.observation_ref && source.role === "original_post",
      );
    choices.sort(
      (a, b) => Number(original(b)) - Number(original(a)) || a.card_ref.localeCompare(b.card_ref),
    );
    previous.primary = choices[0].observation_ref;
    previous.result = choices[0].trace;
  }
  return result;
}

export function resolveSourceSet({
  sourceSet,
  collectionText,
  observations,
  selection,
  languages,
  scoring,
  captureRoot,
} = {}) {
  validateSourceSet(sourceSet, {
    collectionText,
    ...(captureRoot === undefined ? {} : { captureRoot }),
  });
  const links = collectionLinks(collectionText);
  const selected = selectionOf(sourceSet, links, selection);
  if (!Array.isArray(observations) || observations.length > MAX_OBSERVATIONS)
    refuse("Resolution needs a bounded array of observations.");
  const seen = new Set(),
    indexes = new Set();
  const normalized = observations
    .map((raw) => {
      if (!selected.card_refs.includes(raw?.card_ref))
        refuse("An observation belongs to an unselected card.");
      const value = normalizedObservation(raw, sourceSet, { languages, scoring, captureRoot });
      const key = `${value.card_ref}\0${sourceUrl(value.source_ref)}`;
      if (seen.has(key)) refuse("One card/source observation is supplied twice.");
      seen.add(key);
      if (value.input !== null) {
        if (indexes.has(value.input.inputIndex)) refuse("Extraction ordinals must be unique.");
        indexes.add(value.input.inputIndex);
      }
      return value;
    })
    .sort(
      (a, b) => a.card_ref.localeCompare(b.card_ref) || a.source_ref.localeCompare(b.source_ref),
    );
  const groups = [];
  for (const card of sourceSet.cards.filter((item) => selected.card_refs.includes(item.card_ref))) {
    const own = normalized.filter((observation) => observation.card_ref === card.card_ref);
    const different = own.filter((observation) => observation.identity_status === "different");
    const base = groupFor(
      card,
      sourceSet,
      own.filter((observation) => !different.includes(observation)),
      { excludedSources: different.map((observation) => observation.source_ref) },
    );
    groups.push(base);
    for (const observation of different) {
      const extra = groupFor(card, sourceSet, [observation], { separate: true });
      extra.sources = extra.sources.filter(
        (source) => source.observation_ref === observation.observation_ref,
      );
      extra.conflicts = [];
      extra.result = observation.trace ?? {
        decision: "MANUAL_REVIEW",
        review_code: "source_review",
        reason_codes: ["no_full_jd"],
      };
      groups.push(extra);
    }
  }
  const resolved = mergeConfirmed(groups, normalized);
  const url_accounting = links.slice(selected.from - 1, selected.to).map((url, offset) => {
    const memberships = sourceSetMemberships(sourceSet, url);
    const active = memberships.filter((member) => selected.card_refs.includes(member.card_ref));
    if (!active.length && !memberships.length) refuse("A supplied URL has no source membership.");
    const dispositions = resolved
      .flatMap((group) => group.sources)
      .filter(
        (source) =>
          !source.source_ref.startsWith("mailto:") &&
          sourceUrl(source.source_ref) === sourceUrl(url),
      )
      .map((source) => source.disposition);
    const disposition =
      active.length === 0
        ? "shared_context"
        : active.every((member) => member.role === "company_context")
          ? "company_context"
          : active.every((member) => member.role === "contact")
            ? "contact"
            : [...new Set(dispositions)].sort().join("+") || "source_not_observed";
    return { input_index: selected.from + offset, url, memberships, disposition };
  });
  const value = {
    schema_version: sourceResolutionSchemaVersion,
    policy_id: TRIAGE_POLICY_ID,
    source_set_sha256: sourceSetDigest(sourceSet),
    selection: selected,
    observations: normalized,
    groups: resolved,
    url_accounting,
    counts: {
      supplied_urls: url_accounting.length,
      logical_vacancies: resolved.length,
      confirmed: resolved.filter((group) => group.identity_status === "confirmed").length,
      source_review: resolved.filter((group) => group.result?.review_code === "source_review")
        .length,
      context_urls: url_accounting.filter((row) => row.disposition === "company_context").length,
      observations: normalized.length,
    },
  };
  if (Buffer.byteLength(serializeSourceResolution(value)) > MAX_RESOLUTION_BYTES)
    refuse("Resolution exceeds its byte limit.");
  return value;
}

export function validateSourceResolution(
  resolution,
  { sourceSet, collectionText, languages, scoring, captureRoot } = {},
) {
  if (
    !keys(resolution, [
      "schema_version",
      "policy_id",
      "source_set_sha256",
      "selection",
      "observations",
      "groups",
      "url_accounting",
      "counts",
    ]) ||
    resolution.schema_version !== 1 ||
    resolution.policy_id !== TRIAGE_POLICY_ID ||
    !Array.isArray(resolution.observations)
  )
    refuse("Source resolution does not match version 1.");
  const observations = resolution.observations.map((observation) => {
    if (!keys(observation, [...rawKeys, "transport", "observation_ref", "trace"]))
      refuse("Saved observation has unexpected fields.");
    const { observation_ref: _ref, trace: _trace, ...raw } = observation;
    return raw;
  });
  const rebuilt = resolveSourceSet({
    sourceSet,
    collectionText,
    observations,
    selection: resolution.selection,
    languages,
    scoring,
    captureRoot,
  });
  if (!equal(rebuilt, resolution))
    refuse("Saved source resolution differs from its deterministic reconstruction.");
  return resolution;
}

/** Publish after captures are ready. Each immutable file is exclusive; a partial batch is retained. */
export function publishSourceResolution({
  artifactsDir,
  sourceSet,
  collectionText,
  sourceCaptureRoot,
  observations,
  selection,
  languages,
  scoring,
} = {}) {
  if (typeof artifactsDir !== "string" || !isAbsolute(artifactsDir))
    refuse("Batch directory must be absolute.");
  let root;
  try {
    if (lstatSync(artifactsDir).isSymbolicLink() || !lstatSync(artifactsDir).isDirectory())
      refuse("Batch directory must be a real directory.");
    root = realpathSync(artifactsDir);
  } catch (error) {
    if (error instanceof SourceResolutionError) throw error;
    refuse("Batch directory must already exist.");
  }
  validateSourceSet(sourceSet, { collectionText, captureRoot: sourceCaptureRoot ?? root });
  if (sourceCaptureRoot !== undefined && realpathSync(sourceCaptureRoot) !== root) {
    const files = new Map(
      sourceSet.snapshots.map((snapshot) => [snapshot.capture.file, snapshot.capture.sha256]),
    );
    for (const [file, digest] of files) {
      const bytes = safeArtifact(sourceCaptureRoot, file);
      if (hash(bytes) !== digest) refuse("Source capture changed before publication.");
      const parts = file.split("/");
      let parent = root;
      for (const part of parts.slice(0, -1)) {
        parent = join(parent, part);
        try {
          mkdirSync(parent, { mode: 0o700 });
        } catch (error) {
          if (
            error.code !== "EEXIST" ||
            lstatSync(parent).isSymbolicLink() ||
            !lstatSync(parent).isDirectory()
          )
            refuse("Capture directory cannot be created safely.");
        }
      }
      try {
        writeFileSync(join(root, file), bytes, { flag: "wx", mode: 0o600 });
      } catch {
        refuse("Source capture publication requires an unused path.");
      }
    }
  }
  const resolution = resolveSourceSet({
    sourceSet,
    collectionText,
    observations,
    selection,
    languages,
    scoring,
    captureRoot: root,
  });
  const files = [
    ["collection.links.txt", collectionText],
    ["source-set.json", serializeSourceSet(sourceSet)],
    [sourceResolutionBasename, serializeSourceResolution(resolution)],
  ];
  for (const dir of ["inputs", "traces"]) {
    try {
      mkdirSync(join(root, dir), { mode: 0o700 });
    } catch {
      refuse("Source publication requires unused input and trace directories.");
    }
  }
  for (const observation of resolution.observations.filter((item) => item.input !== null)) {
    const prefix = String(observation.input.inputIndex).padStart(3, "0");
    files.push(
      [`inputs/${prefix}.input.json`, `${JSON.stringify(observation.input, null, 2)}\n`],
      [`traces/${prefix}.trace.json`, `${JSON.stringify(observation.trace, null, 2)}\n`],
    );
  }
  try {
    for (const [file, text] of files)
      writeFileSync(join(root, file), text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    refuse("Source publication requires unused artifact paths; retain the partial batch.");
  }
  return resolution;
}
