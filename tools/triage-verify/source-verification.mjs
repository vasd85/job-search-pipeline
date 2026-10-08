// Source accounting is evidence, not a plan waiver. The immutable set is read with the saved HTML;
// the resolution is reproduced by its owner, then every retained extraction is joined by its own
// binding. A transport record number and an extraction ordinal are deliberately separate axes.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  MAX_SOURCE_CAPTURE_BYTES,
  MAX_SOURCE_SET_BYTES,
  cardBody,
  sourceSetDigest,
  sourceSetMemberships,
  validateSourceSet,
} from "../triage-sources/source-set.mjs";
import { validateSourceResolution } from "../triage-sources/reconcile.mjs";
import { verifyCaptureFile } from "../vacancy-fetch/persist.mjs";
import { sha256 } from "./text-scan.mjs";
import { captureProvenance } from "./manifest.mjs";

export function deepEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, at) => deepEqual(item, right[at]))
    );
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return false;
  const keys = Object.keys(left).sort();
  const other = Object.keys(right).sort();
  return (
    keys.length === other.length &&
    keys.every((key, at) => key === other[at] && deepEqual(left[key], right[key]))
  );
}

/** External filenames remain filesystem data and must resolve below this exact batch. */
function readSourceFile(root, file, maximum = MAX_SOURCE_CAPTURE_BYTES) {
  if (
    typeof file !== "string" ||
    file.length > 256 ||
    isAbsolute(file) ||
    !/^[A-Za-z0-9._/-]+$/u.test(file) ||
    file.split("/").some((part) => ["", ".", ".."].includes(part))
  )
    return null;
  try {
    const base = realpathSync(root);
    let path = base;
    for (const part of file.split("/")) {
      path = join(path, part);
      if (lstatSync(path).isSymbolicLink()) return null;
    }
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > maximum) return null;
    const rel = relative(base, realpathSync(path));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

function sourceMode(context) {
  return (
    context.batch.sourceSet.present ||
    context.batch.sourceResolution.present ||
    context.batch.plan.value?.schema_version === 2 ||
    context.records.some(
      (record) => record.input?.schemaVersion === 10 && record.input.sourceContext != null,
    )
  );
}

function membershipKey(member) {
  return JSON.stringify([
    member.card_ref,
    member.snapshot_ref,
    member.role,
    member.url,
    member.anchor,
  ]);
}

/** A bounded failure contains a machine code, never the owner's external-content message. */
function boundedFailure(error) {
  return typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,80}$/u.test(error.code)
    ? error.code
    : "validation_failed";
}

function verifyAccounting(context, source, findings) {
  const resolution = source.resolution;
  if (
    !deepEqual({ from: resolution.selection?.from, to: resolution.selection?.to }, context.range)
  ) {
    findings.push({ code: "source_range_mismatch" });
  }
  const accounts = resolution.url_accounting;
  if (!Array.isArray(accounts)) {
    findings.push({ code: "source_url_coverage_incomplete" });
    return;
  }
  const byPosition = new Map();
  for (const account of accounts) {
    if (byPosition.has(account.input_index))
      findings.push({ code: "source_url_duplicate", position: account.input_index });
    byPosition.set(account.input_index, account);
  }
  for (const link of context.links) {
    const account = byPosition.get(link.position);
    if (account === undefined || context.normalizeUrl(account.url) !== link.normalizedUrl) {
      findings.push({ code: "source_url_coverage_incomplete", position: link.position });
      continue;
    }
    const expected = sourceSetMemberships(source.sourceSet, link.url).map(membershipKey).sort();
    const actual = Array.isArray(account.memberships)
      ? account.memberships.map(membershipKey).sort()
      : [];
    if (!deepEqual(expected, actual))
      findings.push({ code: "source_membership_mismatch", position: link.position });
    const active = account.memberships.filter((member) =>
      resolution.selection.card_refs.includes(member.card_ref),
    );
    if (
      account.disposition === "company_context" &&
      (active.length === 0 || active.some((member) => member.role !== "company_context"))
    ) {
      findings.push({ code: "source_context_unproven", position: link.position });
    }
  }
  if (
    accounts.length !== context.links.length ||
    [...byPosition.keys()].some((at) => !context.links.some((link) => link.position === at))
  ) {
    findings.push({ code: "source_url_coverage_incomplete" });
  }
  const selected = resolution.selection?.card_refs;
  const groups = resolution.groups;
  if (!Array.isArray(selected) || !Array.isArray(groups)) {
    findings.push({ code: "source_card_coverage_incomplete" });
    return;
  }
  const wanted = new Set(selected);
  const covered = new Set(groups.flatMap((group) => group.card_refs ?? []));
  if (
    wanted.size !== selected.length ||
    wanted.size !== covered.size ||
    [...wanted].some((ref) => !covered.has(ref)) ||
    [...wanted].some((ref) => !source.sourceSet.cards.some((card) => card.card_ref === ref))
  ) {
    findings.push({ code: "source_card_coverage_incomplete" });
  }
  source.accounts = accounts;
}

function observedScope(context, source, observation, findings) {
  const card = source.sourceSet.cards.find((item) => item.card_ref === observation.card_ref);
  const snapshot = source.sourceSet.snapshots.find(
    (item) => item.snapshot_ref === card?.snapshot_ref,
  );
  const members =
    card?.links.filter(
      (member) =>
        !member.url.startsWith("mailto:") &&
        context.normalizeUrl(member.url) === context.normalizeUrl(observation.source_ref),
    ) ?? [];
  const link = ["original_post", "details", "apply", "unknown"]
    .map((role) => members.find((member) => member.role === role))
    .find((member) => member !== undefined);
  if (
    card === undefined ||
    snapshot === undefined ||
    link === undefined ||
    link.role === "company_context" ||
    link.role === "contact"
  ) {
    findings.push({ code: "source_observation_unbound" });
    return null;
  }
  if (observation.capture === null) {
    if (observation.body !== null || observation.transport?.file !== "fetch-manifest.json") {
      findings.push({ code: "source_failure_unproven" });
      return null;
    }
    const bytes = readSourceFile(context.batch.dir, observation.transport.file, 8 * 1024 * 1024);
    const manifestRecord = context.manifest.records?.get(observation.transport.index);
    if (
      bytes === null ||
      sha256(bytes) !== observation.transport.sha256 ||
      manifestRecord === undefined ||
      context.normalizeUrl(manifestRecord.requestedUrl) !==
        context.normalizeUrl(observation.source_ref) ||
      manifestRecord.usable !== false ||
      !["access_failure", "absent", "closed", "private"].includes(manifestRecord.outcome)
    ) {
      findings.push({ code: "source_failure_unproven" });
      return null;
    }
    return {
      body: null,
      file: null,
      original: false,
      captureSha256: null,
      transportIndex: observation.transport.index,
      card,
      snapshot,
      observation,
    };
  }
  if (link.role === "original_post") {
    if (
      observation.capture?.file !== snapshot.capture.file ||
      observation.capture?.sha256 !== snapshot.capture.sha256 ||
      observation.body !== cardBody(source.sourceSet, card) ||
      observation.description_kind !== card.description_kind
    ) {
      findings.push({ code: "source_primary_mismatch" });
      return null;
    }
    return {
      body: observation.body,
      file: snapshot.capture.file,
      original: true,
      captureSha256: snapshot.capture.sha256,
      transportIndex: null,
      card,
      snapshot,
      observation,
    };
  }
  const bytes = readSourceFile(context.batch.dir, observation.capture?.file);
  const capture = bytes === null ? null : verifyCaptureFile(bytes.toString("utf8"));
  if (
    capture?.ok !== true ||
    capture.header["normalized-sha256"] !== observation.capture.sha256 ||
    capture.body !== observation.body ||
    context.normalizeUrl(capture.header["requested-url"]) !==
      context.normalizeUrl(observation.source_ref)
  ) {
    findings.push({ code: "source_capture_mismatch" });
    return null;
  }
  const loaded = context.batch.captures.find((item) => item.file === observation.capture.file);
  const index = Number(capture.header.index);
  if (loaded === undefined || loaded.index !== index) {
    findings.push({ code: "source_capture_index_mismatch" });
    return null;
  }
  return {
    body: capture.body,
    file: loaded.file,
    original: false,
    captureSha256: observation.capture.sha256,
    transportIndex: index,
    card,
    snapshot,
    observation,
  };
}

function verifyExtractions(context, source, findings) {
  const observations = source.resolution.observations;
  if (!Array.isArray(observations)) {
    findings.push({ code: "source_resolution_unreadable" });
    return;
  }
  const scopes = new Map();
  const extracted = new Map();
  for (const observation of observations) {
    const scope = observedScope(context, source, observation, findings);
    if (scope === null) continue;
    if (scope.transportIndex !== null) source.transportIndices.add(scope.transportIndex);
    if (observation.input === null) continue;
    const index = observation.input.inputIndex;
    if (extracted.has(index)) findings.push({ code: "source_extraction_duplicate", index });
    extracted.set(index, scope);
  }
  for (const record of context.records) {
    const scope = extracted.get(record.input?.inputIndex);
    if (
      scope === undefined ||
      !deepEqual(scope.observation.input, record.input) ||
      !deepEqual(scope.observation.trace, record.trace)
    ) {
      findings.push({ code: "source_record_unbound", index: record.index });
      continue;
    }
    if (record.index !== record.input.inputIndex)
      findings.push({ code: "input_index_mismatch", index: record.index });
    scopes.set(record.index, scope);
    record.sourceScope = scope;
    record.transportIndex = scope.transportIndex;
    record.captures =
      scope.transportIndex === null
        ? []
        : context.batch.captures
            .filter((capture) => capture.index === scope.transportIndex)
            .map((capture) => {
              const verified = capture.text === null ? null : verifyCaptureFile(capture.text);
              const checked = { ...capture, verified };
              return {
                ...checked,
                provenance: captureProvenance(
                  checked,
                  context.manifest.records?.get(capture.index) ?? null,
                ),
              };
            });
  }
  for (const [index] of extracted) {
    if (!context.records.some((record) => record.input?.inputIndex === index)) {
      findings.push({ code: "source_observation_record_absent", index });
    }
  }
  source.scopes = scopes;
}

/** Missing or malformed new artifacts become findings, like defective legacy captures. */
export function readSourceArtifacts(
  context,
  { collectionText, validateResolution = validateSourceResolution } = {},
) {
  const source = {
    active: sourceMode(context),
    valid: false,
    sourceSet: null,
    digest: null,
    resolution: null,
    chainFindings: [],
    findings: [],
    scopes: new Map(),
    transportIndices: new Set(),
    accounts: [],
    htmlCaptures: 0,
    accountedUrls: new Set(),
  };
  if (!source.active) {
    for (const capture of context.batch.sourceCaptures)
      source.findings.push({ code: "unexpected_artifact", file: capture.file });
    return source;
  }
  if (!context.batch.collection.present)
    source.chainFindings.push({ code: "source_collection_absent" });
  else if (
    context.batch.collection.error !== null ||
    sourceSetDigest(context.batch.collection.text) !== sourceSetDigest(collectionText)
  ) {
    source.chainFindings.push({ code: "source_collection_mismatch" });
  }
  const file = context.batch.sourceSet;
  if (!file.present) {
    source.chainFindings.push({ code: "source_set_absent" });
    return source;
  }
  if (file.error !== null || file.value === null) {
    source.chainFindings.push({
      code: "source_set_unreadable",
      reason: file.error ?? "shape_unexpected",
    });
    return source;
  }
  try {
    const bytes = readSourceFile(context.batch.dir, "source-set.json", MAX_SOURCE_SET_BYTES);
    if (bytes === null) throw { code: "source_set_unreadable" };
    source.digest = sourceSetDigest(bytes);
    source.sourceSet = validateSourceSet(file.value, {
      collectionText,
      captureRoot: context.batch.dir,
    });
    if (sourceSetDigest(source.sourceSet) !== source.digest)
      source.chainFindings.push({ code: "source_set_digest_mismatch" });
    const declared = new Set(source.sourceSet.snapshots.map((snapshot) => snapshot.capture.file));
    source.htmlCaptures = declared.size;
    for (const capture of context.batch.sourceCaptures) {
      if (!declared.has(capture.file))
        source.findings.push({ code: "unexpected_artifact", file: capture.file });
    }
  } catch (error) {
    source.chainFindings.push({ code: "source_set_invalid", reason: boundedFailure(error) });
    return source;
  }
  const resolutionFile = context.batch.sourceResolution;
  if (!resolutionFile.present) {
    source.findings.push({ code: "source_resolution_absent" });
    return source;
  }
  if (resolutionFile.error !== null || resolutionFile.value === null) {
    source.findings.push({
      code: "source_resolution_unreadable",
      reason: resolutionFile.error ?? "shape_unexpected",
    });
    return source;
  }
  try {
    if (typeof validateResolution !== "function") throw { code: "source_resolution_unverifiable" };
    validateResolution(resolutionFile.value, {
      sourceSet: source.sourceSet,
      collectionText,
      languages: context.languages,
      captureRoot: context.batch.dir,
    });
    source.resolution = resolutionFile.value;
    if (source.resolution.source_set_sha256 !== source.digest)
      source.chainFindings.push({ code: "source_set_digest_mismatch" });
    verifyAccounting(context, source, source.findings);
    verifyExtractions(context, source, source.findings);
    source.valid = source.chainFindings.length === 0 && source.findings.length === 0;
    if (source.valid)
      source.accountedUrls = new Set(
        source.accounts.map((account) => context.normalizeUrl(account.url)),
      );
  } catch (error) {
    source.findings.push({ code: "source_resolution_invalid", reason: boundedFailure(error) });
  }
  return source;
}
