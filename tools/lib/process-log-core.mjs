import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  classifyProcessRecord,
  duplicateSourceKeyGroupErrors,
  fileBackedStepNames,
  fileBackedStepStates,
  outputDirEquivalenceKey,
  ProcessLogV3ValidationError,
  processLogV3ValidationErrorEvidence,
  validateProcessLogV3,
} from "./process-log-v3-validation.mjs";
import {
  processLogDiagnosticLimits,
  processLogUppercaseCauseCodePattern,
} from "./process-log-diagnostics.mjs";
import { detectJobSource } from "../job-sources/registry.mjs";

export const allowedRunners = new Set([
  "claude-code",
  "claude-ai-web",
  "codex",
  "manual",
  "unknown",
]);
export const allowedStatuses = new Set(["started", "fetch_failed", "output_created"]);
export {
  classifyProcessRecord,
  fileBackedStepNames,
  fileBackedStepStates,
  outputDirEquivalenceKey,
  ProcessLogV3ValidationError,
  processLogV3ValidationErrorEvidence,
};

const trustedPrimaryErrorEvidence = new WeakMap();
const trustedSecondaryErrorEvidence = new WeakMap();

export class ProcessLogCoreError extends Error {
  constructor({ causeCode, code, context, message, recoveryAction }) {
    super(message);
    this.name = "ProcessLogCoreError";
    this.causeCode = causeCode;
    this.code = code;
    this.context = context;
    this.recoveryAction = recoveryAction;
  }
}

class TrustedProcessLogCoreError extends ProcessLogCoreError {
  constructor(details) {
    super(details);
    trustedPrimaryErrorEvidence.set(
      this,
      Object.freeze({
        causeCode: this.causeCode,
        code: this.code,
        context: this.context,
        message: this.message,
        recoveryAction: this.recoveryAction,
      }),
    );
  }
}

export function processLogCorePrimaryEvidence(error) {
  const evidence = trustedPrimaryErrorEvidence.get(error);
  return evidence === undefined ? null : { ...evidence };
}

export function processLogCoreSecondaryEvidence(error) {
  const evidence = trustedSecondaryErrorEvidence.get(error);
  return Array.isArray(evidence) ? evidence.map((entry) => ({ ...entry })) : [];
}

function appendSecondaryCoreError(primaryError, secondaryError) {
  try {
    if (!(primaryError instanceof Error)) return;
  } catch {
    return;
  }
  const secondaryEvidence = trustedPrimaryErrorEvidence.get(secondaryError);
  if (secondaryEvidence === undefined) return;
  const stored = trustedSecondaryErrorEvidence.get(primaryError);
  const existing = Array.isArray(stored) ? stored : [];
  const { causeCode, code, context, recoveryAction } = secondaryEvidence;
  trustedSecondaryErrorEvidence.set(
    primaryError,
    Object.freeze([
      ...existing.slice(0, 1),
      Object.freeze({ causeCode, code, context, recoveryAction }),
    ]),
  );
}

function boundedCoreCauseCode(error, fallback = "UNKNOWN") {
  try {
    const code = error?.code;
    return typeof code === "string" &&
      Buffer.byteLength(code, "utf8") <= processLogDiagnosticLimits.codeMaxBytes &&
      processLogUppercaseCauseCodePattern.test(code)
      ? code
      : fallback;
  } catch {
    return fallback;
  }
}

function processLogAccessRecovery(causeCode, fallback) {
  return ["EACCES", "EPERM"].includes(causeCode) ? "repair_process_log_access" : fallback;
}

// Source-key policy versions. The decision record is
// docs/adr/0013-versioned-source-keys-and-identity-migration.md; it owns which parameters each
// version strips, and its "Implementation status" section records the cutover that moved the
// computed version to 2.
const trackingParamsByVersion = new Map([
  [
    1,
    new Set([
      "alternatechannel",
      "hhtmfrom",
      "query",
      "refid",
      "source",
      "tab",
      "trackingid",
      "trk",
    ]),
  ],
  // Version 2 strips a strict subset of version 1. That is not a coincidence and not an
  // implementation detail: it is what makes the projection a refinement, so no two references that
  // have distinct version 1 keys can acquire the same version 2 key.
  [2, new Set(["alternatechannel", "hhtmfrom", "trackingid", "trk"])],
]);

export const sourceKeyPolicyVersions = Object.freeze(
  [...trackingParamsByVersion.keys()].sort((left, right) => left - right),
);

// The version this module computes into `source_key`. Moving it was the last step of the ordering
// in ADR 0013 and it is only survivable in this order: the version-aware read path — membership
// canonicality, the group invariant and identity lookup on the computed key — has to be in place
// first, because canonicality is enforced on load for every record and one stale key would fail the
// whole file rather than degrade one record.
//
// Nothing is re-keyed by this constant. A record written before the cutover keeps the version 1 key
// it was written with, forever; `report-source-key-split` is what counts them.
export const currentSourceKeyPolicyVersion = 2;

export function sourceKeyTrackingParameters(version) {
  const params = trackingParamsByVersion.get(version);
  if (params === undefined) {
    throw new Error(`unknown source key policy version: ${version}`);
  }
  return Object.freeze([...params].sort());
}

export function normalizeSourceRefForVersion(value, version) {
  const params = trackingParamsByVersion.get(version);
  if (params === undefined) {
    throw new Error(`unknown source key policy version: ${version}`);
  }
  const sourceRef = value.trim();
  if (!sourceRef) throw new Error("source_ref must not be empty");
  try {
    const url = new URL(sourceRef);
    if (url.protocol !== "http:" && url.protocol !== "https:") return sourceRef;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.startsWith("utm_") || params.has(lowerKey)) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return sourceRef;
  }
}

export function normalizeSourceRef(value) {
  return normalizeSourceRefForVersion(value, currentSourceKeyPolicyVersion);
}

// Canonicality is membership, not equality (ADR 0013 rows 13-14). A stored key is canonical when
// *some* accepted policy version derives it from the immutable reference, which is what lets a
// record written before the cutover keep loading beside one written after it. Equality could not:
// canonicality is enforced on load for every record of both classes, so the first stale key would
// fail the whole file and take every command down with it, including the census.
//
// The cost is the one the ADR names rather than hides: a record that kept a stale version 1 key
// after the cutover is accepted here rather than flagged, so `report-source-key-split` — not this
// check — is the only thing that can count them. The set iterated is exactly the accepted versions,
// so a key produced by a policy this module does not implement is still refused.
export function sourceKeyIsCanonical(sourceKey, sourceRef) {
  return sourceKeyPolicyVersions.some(
    (version) => sourceKey === normalizeSourceRefForVersion(sourceRef, version),
  );
}

function parseLegacyHttpSourceRef(value) {
  try {
    const url = new URL(String(value).trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function legacyIdentityParameterGroups(url) {
  // Deliberately pinned to version 1. This is the R1-03C containment detector: it explains why two
  // references already share a stored key, so it must keep reading the set that produced that key.
  const legacyTrackingParams = trackingParamsByVersion.get(1);
  const groups = new Map();
  for (const [key, value] of url.searchParams) {
    const lowerKey = key.toLowerCase();
    if (!legacyTrackingParams.has(lowerKey)) continue;
    if (!groups.has(lowerKey)) groups.set(lowerKey, []);
    groups.get(lowerKey).push([key, value]);
  }
  return groups;
}

export function legacySourceRefCollisionWitnesses(leftValue, rightValue) {
  const left = String(leftValue).trim();
  const right = String(rightValue).trim();
  // Pinned to version 1 on both sides, for the same reason the witness set below is. This detector
  // explains why two records already share a *stored* key, and every stored key it has to explain
  // was produced by version 1 (ADR 0013 row 22). Reading the current version here would make the
  // R1-03C report go silent about exactly the collisions it exists to name, the moment the computed
  // version moved: two references differing only in `query` stop sharing a version 2 key, while the
  // stored key that already groups them does not move at all.
  if (normalizeSourceRefForVersion(left, 1) !== normalizeSourceRefForVersion(right, 1)) {
    return [];
  }
  const leftUrl = parseLegacyHttpSourceRef(left);
  const rightUrl = parseLegacyHttpSourceRef(right);
  if (leftUrl === null || rightUrl === null) return [];

  const witnesses = [];
  const leftGroups = legacyIdentityParameterGroups(leftUrl);
  const rightGroups = legacyIdentityParameterGroups(rightUrl);
  const parameterNames = [...new Set([...leftGroups.keys(), ...rightGroups.keys()])].sort();
  for (const parameterName of parameterNames) {
    if (
      JSON.stringify(leftGroups.get(parameterName) ?? []) !==
      JSON.stringify(rightGroups.get(parameterName) ?? [])
    ) {
      witnesses.push(parameterName);
    }
  }
  if (leftUrl.hash !== rightUrl.hash) witnesses.push("fragment");
  return witnesses.sort();
}

export function buildLegacySourceCollisionReport(log) {
  const recordsBySourceKey = new Map();
  for (const record of log.processes) {
    if (!recordsBySourceKey.has(record.source_key)) {
      recordsBySourceKey.set(record.source_key, []);
    }
    recordsBySourceKey.get(record.source_key).push(record);
  }

  const collisions = [];
  for (const [sourceKey, records] of recordsBySourceKey) {
    if (records.length < 2) continue;
    const sortedRecords = [...records].sort(
      (left, right) =>
        left.id.localeCompare(right.id) || left.source_ref.localeCompare(right.source_ref),
    );
    const witnesses = [];
    const involvedProcessIds = new Set();
    for (let leftIndex = 0; leftIndex < sortedRecords.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < sortedRecords.length; rightIndex += 1) {
        const left = sortedRecords[leftIndex];
        const right = sortedRecords[rightIndex];
        const fields = legacySourceRefCollisionWitnesses(left.source_ref, right.source_ref);
        if (fields.length === 0) continue;
        involvedProcessIds.add(left.id);
        involvedProcessIds.add(right.id);
        witnesses.push({
          process_ids: [left.id, right.id],
          fields,
        });
      }
    }
    if (witnesses.length === 0) continue;
    collisions.push({
      source_key: sourceKey,
      records: sortedRecords
        .filter((record) => involvedProcessIds.has(record.id))
        .map((record) => ({
          process_id: record.id,
          source_ref: record.source_ref,
          duplicate_of: record.duplicate_of,
        })),
      witnesses,
    });
  }
  collisions.sort((left, right) => left.source_key.localeCompare(right.source_key));
  return {
    status: collisions.length === 0 ? "clear" : "collision",
    collision_count: collisions.length,
    collisions,
  };
}

// A link the projection breaks is one whose two ends share a stored key today and stop sharing a
// key afterwards. A link that already crosses two stored keys was never a same-key link, so the
// projection does not break it and it is not reported here.
function brokenDuplicateLinks(records) {
  const byId = new Map(records.map((record) => [record.process_id, record]));
  return records
    .filter((record) => {
      if (record.duplicate_of === null) return false;
      const target = byId.get(record.duplicate_of);
      if (target === undefined) return false;
      return (
        target.stored_source_key === record.stored_source_key &&
        target.projected_source_key !== record.projected_source_key
      );
    })
    .map((record) => ({
      process_id: record.process_id,
      duplicate_of: record.duplicate_of,
      stored_source_key: record.stored_source_key,
      projected_source_key: record.projected_source_key,
      duplicate_of_projected_source_key: byId.get(record.duplicate_of).projected_source_key,
    }));
}

// The history of one vacancy, read from either end (task 010). `duplicate_of` points one way only,
// so a record knows its predecessor and nothing about the copies that came after it; a reader
// starting from the older process would otherwise see an empty chain. This returns the whole
// connected component: every record reachable by following links forward from the seed, and every
// record that reaches the seed by following its own.
//
// Nothing here resolves a process. `resolveFileBackedProcessV3` refuses a historical id, and a
// historical record is exactly what one end of a repaired chain usually is.
//
// The walk carries a visited set. A cycle cannot be written through the lifecycle, but load-time
// validation forbids only a dangling link and a self-reference, so a ledger restored from a backup
// or assembled by hand can already hold one and still load.
export function buildDuplicateChain(log, processId) {
  const byId = new Map(log.processes.map((record) => [record.id, record]));
  const seed = byId.get(processId);
  if (seed === undefined) {
    return {
      status: "unknown_process",
      process_id: processId,
      member_count: 0,
      members: [],
    };
  }

  const successorsById = new Map();
  for (const record of log.processes) {
    const target = record.duplicate_of ?? null;
    if (target === null) continue;
    successorsById.set(target, [...(successorsById.get(target) ?? []), record.id]);
  }

  const visited = new Set();
  const queue = [processId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const record = byId.get(id);
    const next = [
      ...(record?.duplicate_of ? [record.duplicate_of] : []),
      ...(successorsById.get(id) ?? []),
    ];
    for (const candidate of next) {
      if (!visited.has(candidate) && byId.has(candidate)) queue.push(candidate);
    }
  }

  const members = [...visited]
    .map((id) => byId.get(id))
    .map((record) => ({
      process_id: record.id,
      record_class: classifyProcessRecord(record),
      source_ref: record.source_ref,
      source_key: record.source_key,
      duplicate_of: record.duplicate_of ?? null,
      output_dir: record.output_dir ?? null,
      started_at: record.started_at,
    }))
    .sort(
      (left, right) =>
        Date.parse(left.started_at) - Date.parse(right.started_at) ||
        left.process_id.localeCompare(right.process_id),
    );

  return {
    status: members.length > 1 ? "chain" : "single",
    process_id: processId,
    member_count: members.length,
    members,
  };
}

// Read-only census of what a source-key policy change would do to a ledger that already exists.
// It answers the question the R1-03C containment report cannot: that report groups by the stored
// key and only speaks about groups of two or more, so a lone record whose key merely changes is
// invisible to it. Nothing here mutates the log, and nothing here writes a key anywhere.
//
// Every leg compares the **stored** key against the projection, never one policy version against
// another. That is what makes it readable after the cutover: the ledger now holds both versions at
// once, and a census that compared version to version would report records that are already
// migrated and stay silent about two stored keys converging.
//
// Precondition: a log that has passed validation, so every record carries a string `source_ref` and
// process ids are unique. With duplicate ids a link resolves to whichever record came last.
export function buildSourceKeyVersionProjection(log, { toVersion = 2 } = {}) {
  if (!sourceKeyPolicyVersions.includes(toVersion)) {
    throw new Error(`unknown source key policy version: ${toVersion}`);
  }

  const records = [...log.processes]
    .map((record) => ({
      process_id: record.id,
      record_class: classifyProcessRecord(record),
      source_ref: record.source_ref,
      stored_source_key: record.source_key,
      projected_source_key: normalizeSourceRefForVersion(record.source_ref, toVersion),
      duplicate_of: record.duplicate_of ?? null,
    }))
    .sort((left, right) => left.process_id.localeCompare(right.process_id));

  const changed = records
    .filter((record) => record.projected_source_key !== record.stored_source_key)
    .map(({ process_id, record_class, source_ref, stored_source_key, projected_source_key }) => ({
      process_id,
      record_class,
      source_ref,
      stored_source_key,
      projected_source_key,
    }));

  const byStoredKey = new Map();
  for (const record of records) {
    const group = byStoredKey.get(record.stored_source_key) ?? [];
    group.push(record);
    byStoredKey.set(record.stored_source_key, group);
  }
  const splitGroups = [];
  for (const [storedSourceKey, members] of byStoredKey) {
    const projectedKeys = [...new Set(members.map((member) => member.projected_source_key))].sort();
    if (projectedKeys.length < 2) continue;
    splitGroups.push({
      stored_source_key: storedSourceKey,
      projected_source_keys: projectedKeys,
      members: members.map(
        ({ process_id, record_class, source_ref, projected_source_key, duplicate_of }) => ({
          process_id,
          record_class,
          source_ref,
          projected_source_key,
          duplicate_of,
        }),
      ),
    });
  }
  splitGroups.sort((left, right) => left.stored_source_key.localeCompare(right.stored_source_key));

  // A merge is two records that carry different stored keys today and would carry one afterwards.
  // Version 2 cannot produce one, because it strips a strict subset of version 1 and therefore only
  // refines. The census still looks: an invariant nothing checks is a claim, a host-specific rule
  // added later could break it, and after cutover a mixed-version ledger is exactly where two
  // stored keys could quietly converge.
  const byProjectedKey = new Map();
  for (const record of records) {
    const group = byProjectedKey.get(record.projected_source_key) ?? new Set();
    group.add(record.stored_source_key);
    byProjectedKey.set(record.projected_source_key, group);
  }
  const merges = [...byProjectedKey]
    .filter(([, storedKeys]) => storedKeys.size > 1)
    .map(([projectedSourceKey, storedKeys]) => ({
      projected_source_key: projectedSourceKey,
      stored_source_keys: [...storedKeys].sort(),
    }))
    .sort((left, right) => left.projected_source_key.localeCompare(right.projected_source_key));

  const brokenLinks = brokenDuplicateLinks(records);

  return {
    // A merge always implies at least one changed record, so `changed` alone decides the verdict.
    status: changed.length === 0 ? "clear" : "split",
    policy: { to_version: toVersion },
    record_count: records.length,
    changed_count: changed.length,
    split_group_count: splitGroups.length,
    merge_count: merges.length,
    broken_duplicate_link_count: brokenLinks.length,
    changed,
    split_groups: splitGroups,
    merges,
    broken_duplicate_links: brokenLinks,
  };
}

// The diaeresis is the one mark a search ignores, in every script: it is the mark people leave out
// when they type a name. Other marks tell letters apart (a breve, a dakuten) and are kept.
const COMBINING_DIAERESIS = /\u0308/gu;

export function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_DIAERESIS, "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeDomain(value) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!raw || /\s/.test(raw)) throw new Error("domain must not be empty or contain spaces");
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`invalid domain or URL: ${value}`);
  }
  if (!url.hostname || !url.hostname.includes(".")) {
    throw new Error(`invalid domain or URL: ${value}`);
  }
  return url.hostname.replace(/\.$/, "").replace(/^www\./, "");
}

export function parseDomainQuery(value) {
  const raw = String(value ?? "").trim();
  if (!raw || /\s/.test(raw) || !raw.includes(".")) return null;
  try {
    return normalizeDomain(raw);
  } catch {
    return null;
  }
}

function domainIs(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function extractObviousFirstPartyDomain(sourceRef) {
  let url;
  try {
    url = new URL(sourceRef);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  let hostname = normalizeDomain(url.hostname);
  if (detectJobSource(hostname) !== null) return null;
  hostname = hostname.replace(/^(careers|career|jobs|job|news)\./, "");
  return hostname;
}

function uniqueOriginalValues(values, normalizer) {
  const seen = new Set();
  const result = [];
  for (const raw of values) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    const key = normalizer(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function deriveSearchTerms(companyName) {
  const name = String(companyName ?? "").trim();
  if (!name) return [];
  const terms = [name];
  for (const part of name.split(/\s+\/\s+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    terms.push(trimmed);
    const parenthetical = trimmed.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (parenthetical) terms.push(parenthetical[1], parenthetical[2]);
  }
  const wholeParenthetical = name.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (wholeParenthetical) terms.push(wholeParenthetical[1], wholeParenthetical[2]);
  return uniqueOriginalValues(terms, normalizeSearchText);
}

function asciiSlug(value) {
  return (
    normalizeSearchText(value)
      .normalize("NFKD")
      .replace(/[^a-z\d]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 36) || "company"
  );
}

export function createCompanyId(displayName, deterministic = false) {
  const suffix = deterministic
    ? createHash("sha256").update(normalizeSearchText(displayName)).digest("hex").slice(0, 8)
    : randomUUID().slice(0, 8);
  return `company_${asciiSlug(displayName)}_${suffix}`;
}

export function createCompanyRecord(displayName, { sourceRefs = [], deterministic = false } = {}) {
  const name = String(displayName ?? "").trim();
  if (!name) throw new Error("display_name must not be empty");
  const domains = uniqueOriginalValues(
    sourceRefs.map(extractObviousFirstPartyDomain).filter(Boolean),
    normalizeDomain,
  ).map(normalizeDomain);
  return {
    id: createCompanyId(name, deterministic),
    display_name: name,
    search_terms: deriveSearchTerms(name),
    domains,
  };
}

export function normalizeOutputDir(value) {
  const outputDir = value.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  if (outputDir.startsWith("/") || !/^output\/(?!\.{1,2}$)[^/\r\n]+$/.test(outputDir)) {
    throw new Error("output path must be a repo-relative directory: output/<company-role>");
  }
  return outputDir;
}

function isIsoDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function validateLog(log) {
  const errors = [];
  if (!log || typeof log !== "object" || Array.isArray(log)) {
    throw new Error("Invalid process log:\n- root must be an object");
  }
  if (log.schema_version !== 2) errors.push("schema_version must be 2");
  if (!["prompt", "resume", "new-attempt"].includes(log.duplicate_policy)) {
    errors.push("duplicate_policy must be prompt, resume, or new-attempt");
  }
  if (!isIsoDate(log.updated_at)) errors.push("updated_at must be ISO-8601");
  if (!Array.isArray(log.companies)) errors.push("companies must be an array");
  if (!Array.isArray(log.processes)) errors.push("processes must be an array");
  if (errors.length) throw new Error(`Invalid process log:\n- ${errors.join("\n- ")}`);

  const companyIds = new Set();
  for (const [index, company] of log.companies.entries()) {
    const prefix = `companies[${index}]`;
    if (!company?.id || typeof company.id !== "string") errors.push(`${prefix}.id is required`);
    if (companyIds.has(company?.id)) errors.push(`${prefix}.id is duplicated: ${company?.id}`);
    companyIds.add(company?.id);
    if (!company?.display_name || typeof company.display_name !== "string") {
      errors.push(`${prefix}.display_name is required`);
    }
    if (!Array.isArray(company?.search_terms) || company.search_terms.length === 0) {
      errors.push(`${prefix}.search_terms must be a non-empty array`);
    } else {
      const normalizedTerms = company.search_terms.map(normalizeSearchText);
      if (normalizedTerms.some((term) => !term))
        errors.push(`${prefix}.search_terms contains an empty term`);
      if (new Set(normalizedTerms).size !== normalizedTerms.length) {
        errors.push(`${prefix}.search_terms contains normalized duplicates`);
      }
      if (!normalizedTerms.includes(normalizeSearchText(company.display_name))) {
        errors.push(`${prefix}.search_terms must include display_name`);
      }
    }
    if (!Array.isArray(company?.domains)) {
      errors.push(`${prefix}.domains must be an array`);
    } else {
      const normalizedDomains = [];
      for (const domain of company.domains) {
        try {
          const normalized = normalizeDomain(domain);
          normalizedDomains.push(normalized);
          if (domain !== normalized) errors.push(`${prefix}.domains must be canonical: ${domain}`);
        } catch (error) {
          errors.push(`${prefix}.domains: ${error.message}`);
        }
      }
      if (new Set(normalizedDomains).size !== normalizedDomains.length) {
        errors.push(`${prefix}.domains contains duplicates`);
      }
    }
  }

  const processIds = new Set();
  for (const [index, record] of log.processes.entries()) {
    const prefix = `processes[${index}]`;
    if (!record?.id || typeof record.id !== "string") errors.push(`${prefix}.id is required`);
    if (processIds.has(record?.id)) errors.push(`${prefix}.id is duplicated: ${record?.id}`);
    processIds.add(record?.id);
    if (!isIsoDate(record?.started_at)) errors.push(`${prefix}.started_at must be ISO-8601`);
    if (!record?.source_ref || typeof record.source_ref !== "string") {
      errors.push(`${prefix}.source_ref is required`);
    } else if (!sourceKeyIsCanonical(record.source_key, record.source_ref)) {
      errors.push(`${prefix}.source_key is not canonical`);
    }
    if (record.company_id !== null && !companyIds.has(record.company_id)) {
      errors.push(`${prefix}.company_id references an unknown company`);
    }
    for (const field of ["company_observed", "company_hint", "role"]) {
      if (record[field] !== null && (typeof record[field] !== "string" || !record[field].trim())) {
        errors.push(`${prefix}.${field} must be a non-empty string or null`);
      }
    }
    if (!allowedRunners.has(record.runner)) errors.push(`${prefix}.runner is invalid`);
    if (!allowedStatuses.has(record.status)) errors.push(`${prefix}.status is invalid`);
    if (record.output_dir !== null) {
      try {
        normalizeOutputDir(record.output_dir);
      } catch (error) {
        errors.push(`${prefix}.output_dir: ${error.message}`);
      }
      if (record.status !== "output_created")
        errors.push(`${prefix}.status must be output_created`);
    } else if (record.status === "output_created") {
      errors.push(`${prefix}.output_dir is required for output_created status`);
    }
  }

  const outputOwners = new Map();
  for (const [index, record] of log.processes.entries()) {
    if (!record.output_dir) continue;
    const owner = outputOwners.get(record.output_dir);
    if (owner) {
      errors.push(`processes[${index}].output_dir is already linked to ${owner}`);
    } else {
      outputOwners.set(record.output_dir, record.id);
    }
  }

  for (const [index, record] of log.processes.entries()) {
    if (record.duplicate_of !== null && !processIds.has(record.duplicate_of)) {
      errors.push(`processes[${index}].duplicate_of references an unknown id`);
    }
    if (record.duplicate_of === record.id) {
      errors.push(`processes[${index}].duplicate_of cannot reference itself`);
    }
  }
  errors.push(...duplicateSourceKeyGroupErrors(log.processes, normalizeSourceRef));
  if (errors.length) throw new Error(`Invalid process log:\n- ${errors.join("\n- ")}`);
  return log;
}

export function readRawLog(logPath) {
  let source;
  try {
    source = readFileSync(logPath, "utf8");
  } catch (error) {
    const causeCode = boundedCoreCauseCode(error);
    const recoveryAction =
      causeCode === "ENOENT"
        ? "run_bootstrap_init"
        : processLogAccessRecovery(causeCode, "inspect_process_log_path");
    throw new TrustedProcessLogCoreError({
      causeCode,
      code: "process_log_read_failed",
      context: "operation=read_process_log",
      message: "Process log could not be read.",
      recoveryAction,
    });
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new TrustedProcessLogCoreError({
      causeCode: "JSON_PARSE",
      code: "process_log_invalid_json",
      context: "operation=parse_process_log",
      message: "Process log contains invalid JSON.",
      recoveryAction: "repair_process_log_json",
    });
  }
}

export function readLog(logPath) {
  return validateLog(readRawLog(logPath));
}

export function validateLogV3(log) {
  return validateProcessLogV3(log, {
    allowedHistoricalStatuses: allowedStatuses,
    allowedRunners,
    normalizeDomain,
    normalizeHistoricalOutputDir: normalizeOutputDir,
    normalizeSearchText,
    normalizeSourceRef,
    sourceKeyIsCanonical,
  });
}

export function readLogV3(logPath) {
  return validateLogV3(readRawLog(logPath));
}

const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));
const lockContentionCodes = new Set(["EEXIST", "EISDIR", "ENOTDIR", "ENOTEMPTY"]);
const lockOwnerKeys = Object.freeze(["acquired_at", "lock_version", "owner_token", "pid"]);
const legacyLockOwnerKeys = Object.freeze(["acquired_at", "pid"]);
const lockOwnerTokenPattern = /^[0-9a-f]{32}$/;
const maxLockOwnerBytes = 256;

function waitSynchronously(milliseconds) {
  Atomics.wait(lockWaitBuffer, 0, 0, milliseconds);
}

function lockAgeHint(lockPath, staleAfterMs) {
  try {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    return ageMs > staleAfterMs ? " The lock appears stale; inspect it before removal." : "";
  } catch {
    return "";
  }
}

function exactObjectKeys(value, expectedKeys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expectedKeys)
  );
}

function validOwnerTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseLockOwner(source, { allowLegacy = false } = {}) {
  try {
    const owner = JSON.parse(source);
    const validPid = Number.isSafeInteger(owner?.pid) && owner.pid > 0;
    if (
      exactObjectKeys(owner, lockOwnerKeys) &&
      owner.lock_version === 1 &&
      validPid &&
      lockOwnerTokenPattern.test(owner.owner_token) &&
      validOwnerTimestamp(owner.acquired_at)
    ) {
      return owner;
    }
    if (
      allowLegacy &&
      exactObjectKeys(owner, legacyLockOwnerKeys) &&
      validPid &&
      validOwnerTimestamp(owner.acquired_at)
    ) {
      return owner;
    }
    return null;
  } catch {
    return null;
  }
}

function readBoundedLockBytes(path) {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(maxLockOwnerBytes + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

function decodeLockOwner(bytes, options) {
  if (bytes.length > maxLockOwnerBytes) return null;
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes)) return null;
  return parseLockOwner(source, options);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function removeEmptyLockDirectory(lockPath) {
  try {
    rmdirSync(lockPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    if (error.code === "EEXIST" || error.code === "ENOTDIR" || error.code === "ENOTEMPTY") {
      return false;
    }
    return false;
  }
}

function removeExactDirectoryOwner(lockPath, entryName) {
  try {
    unlinkSync(join(lockPath, entryName));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    return false;
  }
  return removeEmptyLockDirectory(lockPath);
}

function sameRegularLock(left, right) {
  return (
    left.stats.dev === right.stats.dev &&
    left.stats.ino === right.stats.ino &&
    left.stats.size === right.stats.size &&
    left.bytes.equals(right.bytes)
  );
}

function inspectRegularLock(path) {
  const stats = lstatSync(path);
  if (!stats.isFile()) return null;
  return {
    bytes: readBoundedLockBytes(path),
    stats,
  };
}

function recoverLegacyRegularLock(lockPath, observed) {
  const claimToken = randomUUID().replaceAll("-", "");
  const claimPath = `${lockPath}.claim-${process.pid}-${claimToken}`;
  try {
    try {
      linkSync(lockPath, claimPath);
    } catch (error) {
      if (error.code === "ENOENT" || lockContentionCodes.has(error.code)) return false;
      throw error;
    }
    const claim = inspectRegularLock(claimPath);
    const current = inspectRegularLock(lockPath);
    if (
      claim === null ||
      current === null ||
      !sameRegularLock(observed, claim) ||
      !sameRegularLock(claim, current)
    ) {
      return false;
    }
    try {
      unlinkSync(lockPath);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return true;
      if (error.code === "EISDIR" || error.code === "EPERM") return false;
      return false;
    }
  } finally {
    try {
      unlinkSync(claimPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function lockIsStale(stats, staleAfterMs) {
  return Date.now() - stats.mtimeMs > staleAfterMs;
}

function recoverDirectoryLock(lockPath, directoryStats, staleAfterMs) {
  let entries;
  try {
    entries = readdirSync(lockPath).sort();
  } catch (error) {
    return error.code === "ENOENT";
  }
  if (entries.length === 0) {
    return lockIsStale(directoryStats, staleAfterMs) ? removeEmptyLockDirectory(lockPath) : false;
  }
  if (entries.length !== 1) return false;
  const [entryName] = entries;
  const tokenMatch = /^([0-9a-f]{32})\.json$/.exec(entryName);
  if (!tokenMatch) return false;
  let entry;
  try {
    entry = inspectRegularLock(join(lockPath, entryName));
  } catch (error) {
    return error.code === "ENOENT";
  }
  if (entry === null) return false;
  const owner = decodeLockOwner(entry.bytes);
  const exactOwner = owner !== null && owner.owner_token === tokenMatch[1];
  if (exactOwner && processIsAlive(owner.pid)) return false;
  if (!exactOwner && !lockIsStale(directoryStats, staleAfterMs)) return false;

  let currentDirectory;
  let currentEntry;
  try {
    currentDirectory = lstatSync(lockPath);
    currentEntry = inspectRegularLock(join(lockPath, entryName));
  } catch (error) {
    return error.code === "ENOENT";
  }
  if (
    currentEntry === null ||
    !currentDirectory.isDirectory() ||
    currentDirectory.dev !== directoryStats.dev ||
    currentDirectory.ino !== directoryStats.ino ||
    !sameRegularLock(entry, currentEntry)
  ) {
    return false;
  }
  return removeExactDirectoryOwner(lockPath, entryName);
}

function recoverAbandonedLock(lockPath, staleAfterMs) {
  let stats;
  try {
    stats = lstatSync(lockPath);
  } catch (error) {
    return error.code === "ENOENT";
  }
  if (stats.isDirectory()) {
    return recoverDirectoryLock(lockPath, stats, staleAfterMs);
  }
  if (!stats.isFile()) return false;

  let observed;
  try {
    observed = inspectRegularLock(lockPath);
  } catch (error) {
    return error.code === "ENOENT";
  }
  if (observed === null) return false;
  const owner = decodeLockOwner(observed.bytes, { allowLegacy: true });
  if (owner !== null && processIsAlive(owner.pid)) return false;
  if (owner === null && !lockIsStale(stats, staleAfterMs)) return false;
  return recoverLegacyRegularLock(lockPath, observed);
}

function cleanupLockCandidate(candidatePath, entryPath) {
  try {
    unlinkSync(entryPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    rmdirSync(candidatePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function tryPublishLock(lockPath) {
  const ownerToken = randomUUID().replaceAll("-", "");
  if (!lockOwnerTokenPattern.test(ownerToken)) {
    throw new Error("Cannot create a valid process log lock owner token");
  }
  const ownerSource = `${JSON.stringify({
    lock_version: 1,
    pid: process.pid,
    owner_token: ownerToken,
    acquired_at: new Date().toISOString(),
  })}\n`;
  if (Buffer.byteLength(ownerSource, "utf8") > maxLockOwnerBytes) {
    throw new Error("Cannot create a bounded process log lock owner record");
  }
  const candidatePath = `${lockPath}.candidate-${process.pid}-${ownerToken}`;
  const entryPath = join(candidatePath, `${ownerToken}.json`);
  mkdirSync(candidatePath, { mode: 0o700 });
  let candidateStats;
  try {
    writeFileSync(entryPath, ownerSource, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    candidateStats = lstatSync(candidatePath);
    if (!candidateStats.isDirectory()) {
      throw Object.assign(new Error("Process log lock candidate is not a directory"), {
        code: "LOCK_IDENTITY_INVALID",
      });
    }
    try {
      renameSync(candidatePath, lockPath);
    } catch (error) {
      cleanupLockCandidate(candidatePath, entryPath);
      if (lockContentionCodes.has(error.code)) return null;
      throw error;
    }
  } catch (error) {
    if (existsSync(candidatePath)) cleanupLockCandidate(candidatePath, entryPath);
    throw error;
  }
  return {
    directoryIdentity: { dev: candidateStats.dev, ino: candidateStats.ino },
    lockPath,
    ownerToken,
  };
}

function acquireLockUnchecked(logPath, { timeoutMs = 35_000, staleAfterMs = 30_000 } = {}) {
  const lockPath = `${logPath}.lock`;
  const startedAt = Date.now();
  let attempt = 0;
  while (true) {
    const lock = tryPublishLock(lockPath);
    if (lock !== null) return lock;
    if (recoverAbandonedLock(lockPath, staleAfterMs)) {
      attempt = 0;
      continue;
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      const staleHint = lockAgeHint(lockPath, staleAfterMs);
      throw Object.assign(
        new Error(`Timed out after ${timeoutMs}ms waiting for the process log lock.${staleHint}`),
        { code: "LOCK_TIMEOUT" },
      );
    }
    attempt += 1;
    const delayMs = Math.min(10 + attempt * 4, 80) + Math.floor(Math.random() * 10);
    waitSynchronously(Math.min(delayMs, timeoutMs - elapsedMs));
  }
}

function acquireLock(logPath, options) {
  try {
    return acquireLockUnchecked(logPath, options);
  } catch (error) {
    const causeCode = boundedCoreCauseCode(error);
    const timedOut = causeCode === "LOCK_TIMEOUT";
    throw new TrustedProcessLogCoreError({
      causeCode,
      code: timedOut ? "process_log_lock_timeout" : "process_log_lock_failed",
      context: "operation=acquire_process_log_lock",
      message: timedOut ? error.message : "Process log lock could not be acquired.",
      recoveryAction: timedOut
        ? "retry_process_log_command"
        : processLogAccessRecovery(causeCode, "inspect_process_log_lock"),
    });
  }
}

function releaseLock(lock) {
  const entryPath = join(lock.lockPath, `${lock.ownerToken}.json`);
  try {
    unlinkSync(entryPath);
  } catch (error) {
    if (boundedCoreCauseCode(error) === "ENOENT") {
      let currentStats;
      try {
        currentStats = lstatSync(lock.lockPath);
      } catch (identityError) {
        if (boundedCoreCauseCode(identityError) === "ENOENT") return true;
        const causeCode = boundedCoreCauseCode(identityError);
        throw new TrustedProcessLogCoreError({
          causeCode,
          code: "process_log_lock_release_failed",
          context: "operation=release_process_log_lock",
          message: "Process log lock could not be released.",
          recoveryAction: processLogAccessRecovery(causeCode, "inspect_process_log_lock"),
        });
      }
      if (
        currentStats.dev !== lock.directoryIdentity.dev ||
        currentStats.ino !== lock.directoryIdentity.ino
      ) {
        return false;
      }
      throw new TrustedProcessLogCoreError({
        causeCode: "LOCK_OWNER_ENTRY_MISSING",
        code: "process_log_lock_release_failed",
        context: "operation=release_process_log_lock",
        message: "Process log lock could not be released.",
        recoveryAction: "inspect_process_log_lock",
      });
    }
    const causeCode = boundedCoreCauseCode(error);
    throw new TrustedProcessLogCoreError({
      causeCode,
      code: "process_log_lock_release_failed",
      context: "operation=release_process_log_lock",
      message: "Process log lock could not be released.",
      recoveryAction: processLogAccessRecovery(causeCode, "inspect_process_log_lock"),
    });
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmdirSync(lock.lockPath);
      return true;
    } catch (error) {
      const releaseCauseCode = boundedCoreCauseCode(error);
      if (releaseCauseCode === "ENOENT") return true;
      if (["EEXIST", "ENOTEMPTY"].includes(releaseCauseCode)) {
        let currentStats;
        try {
          currentStats = lstatSync(lock.lockPath);
        } catch (identityError) {
          if (boundedCoreCauseCode(identityError) === "ENOENT") return true;
          const causeCode = boundedCoreCauseCode(identityError);
          throw new TrustedProcessLogCoreError({
            causeCode,
            code: "process_log_lock_release_failed",
            context: "operation=release_process_log_lock",
            message: "Process log lock could not be released.",
            recoveryAction: processLogAccessRecovery(causeCode, "inspect_process_log_lock"),
          });
        }
        if (
          currentStats.dev !== lock.directoryIdentity.dev ||
          currentStats.ino !== lock.directoryIdentity.ino
        ) {
          return false;
        }
        if (attempt >= 19) {
          const causeCode = boundedCoreCauseCode(error);
          throw new TrustedProcessLogCoreError({
            causeCode,
            code: "process_log_lock_release_failed",
            context: "operation=release_process_log_lock",
            message: "Process log lock could not be released.",
            recoveryAction: "inspect_process_log_lock",
          });
        }
        waitSynchronously(1);
        continue;
      }
      const causeCode = boundedCoreCauseCode(error);
      throw new TrustedProcessLogCoreError({
        causeCode,
        code: "process_log_lock_release_failed",
        context: "operation=release_process_log_lock",
        message: "Process log lock could not be released.",
        recoveryAction: processLogAccessRecovery(causeCode, "inspect_process_log_lock"),
      });
    }
  }
  throw new TrustedProcessLogCoreError({
    causeCode: "LOCK_RELEASE_RETRY_EXHAUSTED",
    code: "process_log_lock_release_failed",
    context: "operation=release_process_log_lock",
    message: "Process log lock could not be released.",
    recoveryAction: "inspect_process_log_lock",
  });
}

function processLogWriteError(error) {
  const causeCode = boundedCoreCauseCode(error);
  const recoveryAction =
    causeCode === "ENOSPC"
      ? "free_process_log_storage"
      : processLogAccessRecovery(causeCode, "inspect_process_log_write_path");
  return new TrustedProcessLogCoreError({
    causeCode,
    code: "process_log_write_failed",
    context: "operation=write_process_log",
    message: "Process log could not be written.",
    recoveryAction,
  });
}

function processLogTempCleanupError(error) {
  const causeCode = boundedCoreCauseCode(error);
  return new TrustedProcessLogCoreError({
    causeCode,
    code: "process_log_temp_cleanup_failed",
    context: "operation=cleanup_process_log_temp",
    message: "Process log temporary file could not be cleaned.",
    recoveryAction: processLogAccessRecovery(causeCode, "inspect_process_log_temp"),
  });
}

function writeLogWithinLock(logPath, log, validator = validateLog) {
  validator(log);
  const tempPath = `${logPath}.${process.pid}.${randomUUID()}.tmp`;
  let hasWriteError = false;
  let writeError = null;
  try {
    writeFileSync(tempPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
    renameSync(tempPath, logPath);
  } catch (error) {
    hasWriteError = true;
    writeError = error;
  }
  let hasCleanupError = false;
  let cleanupError = null;
  try {
    unlinkSync(tempPath);
  } catch (error) {
    if (boundedCoreCauseCode(error) !== "ENOENT") {
      hasCleanupError = true;
      cleanupError = error;
    }
  }
  if (hasWriteError) {
    const translated = processLogWriteError(writeError);
    if (hasCleanupError) {
      appendSecondaryCoreError(translated, processLogTempCleanupError(cleanupError));
    }
    throw translated;
  }
  if (hasCleanupError) throw processLogTempCleanupError(cleanupError);
}

function operateWithAcquiredLock(lock, operate) {
  let result;
  let hasPrimaryError = false;
  let primaryError = null;
  try {
    result = operate();
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  }
  let releaseError = null;
  try {
    releaseLock(lock);
  } catch (error) {
    releaseError = error;
  }
  if (hasPrimaryError) {
    if (releaseError !== null) appendSecondaryCoreError(primaryError, releaseError);
    throw primaryError;
  }
  if (releaseError !== null) throw releaseError;
  return result;
}

export function updateRawLogAtomic(logPath, mutate, options) {
  const lock = acquireLock(logPath, options);
  return operateWithAcquiredLock(lock, () => {
    const rawLog = readRawLog(logPath);
    const outcome = mutate(rawLog) ?? {};
    if (outcome.changed !== false) {
      writeLogWithinLock(logPath, outcome.log ?? rawLog);
    }
    return outcome.result;
  });
}

export function updateLogAtomic(logPath, mutate, options) {
  return updateRawLogAtomic(logPath, (rawLog) => mutate(validateLog(rawLog)), options);
}

export function withLogV3Lock(logPath, operate, options) {
  const lock = acquireLock(logPath, options);
  return operateWithAcquiredLock(lock, () => {
    const log = validateLogV3(readRawLog(logPath));
    const write = (nextLog = log) => writeLogWithinLock(logPath, nextLog, validateLogV3);
    return operate({ log, write });
  });
}

export function updateLogV3Atomic(logPath, mutate, options) {
  return withLogV3Lock(
    logPath,
    ({ log, write }) => {
      const outcome = mutate(log) ?? {};
      if (outcome.changed !== false) {
        write(outcome.log ?? log);
      }
      return outcome.result;
    },
    options,
  );
}

export function buildMigrationBaseline(log) {
  const isV1 = log.schema_version === 1;
  return (log.processes ?? [])
    .map((record) => ({
      id: record.id,
      started_at: record.started_at,
      source_ref: record.source_ref,
      source_key: record.source_key,
      company_observed: isV1 ? record.company : record.company_observed,
      role: record.role,
      runner: record.runner,
      output_dir: record.output_dir,
      status: record.status,
      duplicate_of: record.duplicate_of,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function compareMigrationBaselines(before, after) {
  const beforeText = JSON.stringify(before);
  const afterText = JSON.stringify(after);
  return {
    equal: beforeText === afterText,
    before_count: before.length,
    after_count: after.length,
  };
}

export function migrateV1ToV2(log) {
  if (log.schema_version === 2) return { log: validateLog(log), migrated: false };
  if (log.schema_version !== 1 || !Array.isArray(log.processes)) {
    throw new Error("Only schema_version 1 can be migrated");
  }
  const groups = new Map();
  for (const record of log.processes) {
    if (!record.company) continue;
    const key = normalizeSearchText(record.company);
    const group = groups.get(key) ?? { name: record.company, sourceRefs: [] };
    group.sourceRefs.push(record.source_ref);
    groups.set(key, group);
  }
  const companies = [...groups.values()]
    .map((group) =>
      createCompanyRecord(group.name, { sourceRefs: group.sourceRefs, deterministic: true }),
    )
    .sort((left, right) => left.display_name.localeCompare(right.display_name, "en"));
  const companyByName = new Map(
    companies.map((company) => [normalizeSearchText(company.display_name), company]),
  );
  const processes = log.processes.map((record) => ({
    id: record.id,
    started_at: record.started_at,
    source_ref: record.source_ref,
    source_key: record.source_key,
    company_id: record.company ? companyByName.get(normalizeSearchText(record.company)).id : null,
    company_observed: record.company ?? null,
    company_hint: null,
    role: record.role ?? null,
    runner: record.runner,
    output_dir: record.output_dir ?? null,
    status: record.status,
    duplicate_of: record.duplicate_of ?? null,
  }));
  const migratedLog = {
    schema_version: 2,
    duplicate_policy: log.duplicate_policy,
    updated_at: new Date().toISOString(),
    companies,
    processes,
  };
  return { log: validateLog(migratedLog), migrated: true };
}

function matchTextQuery(query, values) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return null;
  const candidates = uniqueOriginalValues(values, normalizeSearchText);
  for (const value of candidates) {
    if (normalizeSearchText(value) === normalizedQuery) return { type: "exact", value, rank: 0 };
  }
  if (normalizedQuery.length < 3) return null;
  const queryTokens = normalizedQuery.split(" ");
  for (const value of candidates) {
    const candidateTokens = normalizeSearchText(value).split(" ");
    if (
      queryTokens.every((queryToken) =>
        candidateTokens.some((token) => token.startsWith(queryToken)),
      )
    ) {
      return { type: "token-prefix", value, rank: 2 };
    }
  }
  if (normalizedQuery.length < 4) return null;
  for (const value of candidates) {
    const normalizedValue = normalizeSearchText(value);
    if (queryTokens.every((token) => normalizedValue.includes(token))) {
      return { type: "substring", value, rank: 3 };
    }
  }
  return null;
}

function matchCompany(company, query, extraTerms = []) {
  const textMatch = matchTextQuery(query, [
    company?.display_name,
    ...(company?.search_terms ?? []),
    ...extraTerms,
  ]);
  if (textMatch?.rank === 0) return textMatch;
  const queryDomain = parseDomainQuery(query);
  if (queryDomain && company?.domains.some((domain) => domainIs(queryDomain, domain))) {
    const domain = company.domains.find((candidate) => domainIs(queryDomain, candidate));
    return { type: "domain", value: domain, rank: 1 };
  }
  return textMatch;
}

function searchCompaniesValidated(log, query) {
  const results = [];
  for (const company of log.companies) {
    const match = matchCompany(company, query);
    if (match) results.push({ company, match });
  }
  return results.sort(
    (left, right) =>
      left.match.rank - right.match.rank ||
      left.company.display_name.localeCompare(right.company.display_name, "en"),
  );
}

export function searchCompanies(log, query) {
  validateLog(log);
  return searchCompaniesValidated(log, query);
}

export function searchCompaniesV3(log, query) {
  validateLogV3(log);
  return searchCompaniesValidated(log, query);
}

function searchProcessesValidated(log, query) {
  const companyById = new Map(log.companies.map((company) => [company.id, company]));
  const normalizedQuery = normalizeSearchText(query);
  const results = [];
  for (const record of log.processes) {
    const company = record.company_id ? companyById.get(record.company_id) : null;
    const sourceDomain = extractObviousFirstPartyDomain(record.source_ref);
    const searchIdentity = {
      display_name: company?.display_name ?? null,
      search_terms: company?.search_terms ?? [],
      domains: [...new Set([...(company?.domains ?? []), sourceDomain].filter(Boolean))],
    };
    const match = normalizedQuery
      ? matchCompany(searchIdentity, query, [record.company_observed, record.company_hint])
      : null;
    if (!normalizedQuery || match) results.push({ process: record, company, match });
  }
  return results.sort(
    (left, right) =>
      (left.match?.rank ?? 0) - (right.match?.rank ?? 0) ||
      Date.parse(right.process.started_at) - Date.parse(left.process.started_at) ||
      right.process.id.localeCompare(left.process.id),
  );
}

export function searchProcesses(log, query) {
  validateLog(log);
  return searchProcessesValidated(log, query);
}

export function searchProcessesV3(log, query) {
  validateLogV3(log);
  return searchProcessesValidated(log, query);
}
