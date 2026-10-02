import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  allowedRunners,
  classifyProcessRecord,
  fileBackedStepNames,
  legacySourceRefCollisionWitnesses,
  normalizeOutputDir,
  normalizeSourceRef,
  outputDirEquivalenceKey,
  updateLogV3Atomic,
  validateLogV3,
  withLogV3Lock,
} from "./process-log-core.mjs";
import {
  duplicateLinkWriteError,
  fileBackedArtifactContractsForStep,
  fileBackedArtifactSchemaVersionMayBecome,
  fileBackedMaterialStepNames,
  fileBackedRevisionChannels,
  fileBackedRevisionSubjectKinds,
  fileBackedStepDependencies,
  isValidProcessLogV3TransactionId,
  PROCESS_LOG_FUTURE_SKEW_MS,
} from "./process-log-v3-validation.mjs";
import {
  processLogDiagnosticLimits,
  processLogDiagnosticProblems,
  processLogStableDiagnosticCodePattern,
  processLogUppercaseCauseCodePattern,
} from "./process-log-diagnostics.mjs";
import { validateApplicationBrief } from "../application-brief/validate.mjs";
import {
  candidateConstraintsBasename,
  candidateConstraintsFor,
} from "../candidate/constraints.mjs";
import {
  candidateLetterSamplesBasename,
  candidateLeversSourcePath,
  candidateProfileSourcePath,
  candidateRulesSourcePath,
} from "../candidate/documents.mjs";
import {
  DEFAULT_LANGUAGE,
  candidateLanguagePackBasename,
  candidateLanguageRulesBasename,
  candidateLanguagesDirectoryName,
  isLanguageName,
} from "../candidate/languages.mjs";
import {
  CandidateError,
  candidateConfigBasename,
  candidateDirectoryName,
  candidateLanguageNames,
  candidateMarkets,
  candidateRootFor,
} from "../candidate/load.mjs";
import { candidateLanguagePlaceholder } from "../candidate/manifest.mjs";
import {
  BODY_WORD_APPROVAL_KEY_PREFIX,
  coverLetterEngineForbidden,
  coverLetterLanguagesFor,
  coverLetterLimitsFor,
  parseBodyWordApproval,
  validateCoverLetterFindings,
} from "../cover-letter/validate.mjs";
import { inspectDocxBytes } from "../cv-builder/docx-inspector.mjs";
import { runCvPreflight } from "../cv-builder/preflight.mjs";
import {
  parseJsonBytes,
  sha256Hex,
  validateIsoTimestamp,
  validateUtf8TextBytes,
} from "../pipeline-artifacts/validation.mjs";
import { validateCompanyResearch } from "../pipeline-artifacts/validate-company-research.mjs";
import { validateVacancy } from "../pipeline-artifacts/validate-vacancy.mjs";
import {
  checkOutputRoot,
  OutputRootError,
} from "./output-root.mjs";

export { fileBackedStepDependencies };

function transitiveDescendantStepNames(stepName) {
  return fileBackedStepNames.filter((candidateStepName) => {
    const pending = [...fileBackedStepDependencies[candidateStepName]];
    const visited = new Set();
    while (pending.length > 0) {
      const dependency = pending.pop();
      if (dependency === stepName) return true;
      if (visited.has(dependency)) continue;
      visited.add(dependency);
      pending.push(...fileBackedStepDependencies[dependency]);
    }
    return false;
  });
}

// The Step 3 inputs whose bytes the application-brief validator reads.
const BRIEF_VALIDATION_INPUT_KINDS = Object.freeze(["candidate_levers", "candidate_profile"]);

const fileBackedArtifactInputSteps = Object.freeze({
  get_vacancy: Object.freeze([]),
  research_company: Object.freeze(["get_vacancy"]),
  map_experience: Object.freeze(["get_vacancy", "research_company"]),
  generate_cv: Object.freeze(["map_experience"]),
  write_cover_letter: Object.freeze(["map_experience"]),
});

// The layer-relative path of a candidate file, as a protected input records it: under the layer of
// the checkout the run happens in, the same form `documents.mjs` gives the profile.
function candidateSourcePath(...segments) {
  return [candidateDirectoryName, ...segments].join("/");
}

const candidateConfigSourcePath = candidateSourcePath(candidateConfigBasename);
const candidateConstraintsSourcePath = candidateSourcePath(candidateConstraintsBasename);
const candidateLetterSamplesSourcePath = candidateSourcePath(candidateLetterSamplesBasename);

/*
 * The inputs every process of a step reads, each fingerprinted when the step publishes. A kind of
 * the candidate layer is `candidate_<role>` of the layer manifest and its path the role's path.
 *
 * A step pins the layer files it reads and nothing else: an edit of any other file of the layer
 * stops no process. Step 3 reads the config only for the language and market names, and every
 * consumer of its brief re-checks those against the current config, so the config is pinned by
 * Steps 4 and 5 alone. An `optional` input is recorded only while its file holds bytes: an absent
 * or empty file has no entry, and its appearance changes the snapshot's composition.
 */
export const fileBackedProtectedInputs = Object.freeze({
  get_vacancy: Object.freeze([]),
  research_company: Object.freeze([]),
  map_experience: Object.freeze([
    Object.freeze({
      kind: "candidate_levers",
      path: candidateLeversSourcePath,
    }),
    Object.freeze({
      kind: "candidate_profile",
      path: candidateProfileSourcePath,
    }),
    Object.freeze({
      kind: "candidate_rules",
      path: candidateRulesSourcePath,
    }),
    Object.freeze({
      kind: "generation_rules",
      path: "knowledge/generation-rules.md",
    }),
    Object.freeze({
      kind: "impact_levers",
      path: "knowledge/impact-levers.md",
    }),
    Object.freeze({
      kind: "precedence",
      path: "knowledge/precedence.md",
    }),
  ]),
  generate_cv: Object.freeze([
    Object.freeze({
      kind: "candidate_config",
      path: candidateConfigSourcePath,
    }),
    Object.freeze({
      kind: "candidate_constraints",
      optional: true,
      path: candidateConstraintsSourcePath,
    }),
    Object.freeze({
      kind: "candidate_profile",
      path: candidateProfileSourcePath,
    }),
    Object.freeze({
      kind: "candidate_rules",
      path: candidateRulesSourcePath,
    }),
    Object.freeze({
      kind: "generation_rules",
      path: "knowledge/generation-rules.md",
    }),
    Object.freeze({
      kind: "precedence",
      path: "knowledge/precedence.md",
    }),
    Object.freeze({
      kind: "targeted_cv_playbook",
      path: "knowledge/targeted-cv-playbook.md",
    }),
  ]),
  write_cover_letter: Object.freeze([
    Object.freeze({
      kind: "candidate_config",
      path: candidateConfigSourcePath,
    }),
    Object.freeze({
      kind: "candidate_constraints",
      optional: true,
      path: candidateConstraintsSourcePath,
    }),
    Object.freeze({
      kind: "candidate_letter_samples",
      optional: true,
      path: candidateLetterSamplesSourcePath,
    }),
    Object.freeze({
      kind: "candidate_profile",
      path: candidateProfileSourcePath,
    }),
    Object.freeze({
      kind: "candidate_rules",
      path: candidateRulesSourcePath,
    }),
    Object.freeze({
      kind: "cover_letter_playbook",
      path: "knowledge/cover-letter-playbook.md",
    }),
    Object.freeze({
      kind: "generation_rules",
      path: "knowledge/generation-rules.md",
    }),
    Object.freeze({
      kind: "precedence",
      path: "knowledge/precedence.md",
    }),
  ]),
});

/*
 * The inputs of the letter's own language: its pack, the pack's constraints and its language rules,
 * read from `role.vacancyLanguage` of the brief the step publishes from. A letter in the default
 * language has none. The packs of the other configured languages are not pinned: the letter check
 * reads their script and subject word again at every publication.
 */
export const fileBackedLetterLanguageInputs = Object.freeze({
  write_cover_letter: Object.freeze([
    Object.freeze({
      kind: "candidate_language_pack",
      path: candidateSourcePath(
        candidateLanguagesDirectoryName,
        candidateLanguagePlaceholder,
        candidateLanguagePackBasename,
      ),
    }),
    Object.freeze({
      kind: "candidate_language_constraints",
      optional: true,
      path: candidateSourcePath(
        candidateLanguagesDirectoryName,
        candidateLanguagePlaceholder,
        candidateConstraintsBasename,
      ),
    }),
    Object.freeze({
      kind: "candidate_language_rules",
      optional: true,
      path: candidateSourcePath(
        candidateLanguagesDirectoryName,
        candidateLanguagePlaceholder,
        candidateLanguageRulesBasename,
      ),
    }),
  ]),
});

/*
 * The protected inputs of a step for a letter in `language`: the step's own table, then the inputs
 * of the letter's language when the step has any and the language is a configured one.
 */
function protectedInputContracts(stepName, language = null) {
  const languageContracts = fileBackedLetterLanguageInputs[stepName] ?? [];
  if (
    languageContracts.length === 0
    || !isLanguageName(language)
    || language === DEFAULT_LANGUAGE.name
  ) {
    return fileBackedProtectedInputs[stepName];
  }
  return [
    ...fileBackedProtectedInputs[stepName],
    ...languageContracts.map((contract) => ({
      ...contract,
      path: contract.path.replace(candidateLanguagePlaceholder, language),
    })),
  ];
}

function protectedInputKinds(stepName) {
  return new Set(
    [
      ...fileBackedProtectedInputs[stepName],
      ...(fileBackedLetterLanguageInputs[stepName] ?? []),
    ].map((contract) => contract.kind),
  );
}

// The language of the letter a Step 5 snapshot pinned, read back from the path of its pack entry;
// a snapshot without one is of a letter in the default language.
function pinnedLetterLanguage(snapshot) {
  const pack = snapshot.find((entry) => entry.kind === "candidate_language_pack");
  if (!pack) return null;
  const segments = pack.path.split("/");
  return segments[segments.length - 2];
}

/*
 * A Step 4 or 5 snapshot written before the steps pinned the layer files beyond the profile and the
 * rules. It is told by the config: a later snapshot of those steps always holds it, because the
 * config is a required input there. Such a snapshot is compared without the kinds added then, and
 * the deep check and `reconcile-step` do not read those inputs for it, so an old record reads as it
 * did: not marked stale by the release that added them, nor refused over one of those files. The
 * config is still read for the language names, and a broken one still refuses under its own code.
 */
const layerInputKindsAddedLater = Object.freeze(new Set([
  "candidate_config",
  "candidate_constraints",
  "candidate_language_constraints",
  "candidate_language_pack",
  "candidate_language_rules",
  "candidate_letter_samples",
]));

function snapshotPredatesLayerInputs(stepName, snapshot) {
  return fileBackedMaterialStepNames.includes(stepName)
    && !snapshot.some((entry) => entry.kind === "candidate_config");
}

function comparableCurrentSnapshot(stepName, pinnedSnapshot, currentSnapshot) {
  return snapshotPredatesLayerInputs(stepName, pinnedSnapshot)
    ? currentSnapshot.filter((entry) => !layerInputKindsAddedLater.has(entry.kind))
    : currentSnapshot;
}

function snapshotStillCurrent(stepName, pinnedSnapshot, currentSnapshot) {
  return bundleIdentity(pinnedSnapshot)
    === bundleIdentity(comparableCurrentSnapshot(stepName, pinnedSnapshot, currentSnapshot));
}

export const historicalProcessMutationOperations = Object.freeze([
  "update",
  "link-company",
  "link-duplicate",
  "reserve-output",
  "begin-step",
  "publish-step",
  "block-step",
  "fail-step",
  "retry-step",
  "reopen-step",
  "revise-step",
  "reconcile-step",
  "cleanup-staging",
  "set-output",
  "mark-failed",
]);

function isMaterialStep(stepName) {
  return fileBackedMaterialStepNames.includes(stepName);
}

function activeStepWaivers(step) {
  return (step.waivers ?? [])
    .filter((waiver) => waiver.status === "active")
    .map((waiver) => structuredClone(waiver));
}

/*
 * The waivers a running revision validates against: journaled active waivers plus the attempt's
 * pending ones — a waiver supplied at revise-step open must already downgrade this publication's
 * findings, even though it is journaled only when the publication commits.
 */
function effectiveRevisionWaivers(step) {
  return [
    ...activeStepWaivers(step),
    ...pendingAttemptWaivers(step),
  ];
}

/*
 * The attempt's own pending waivers, stamped active so the validators read them. This is the whole
 * waiver set of a publication that is not a revision (task 145): the step's journaled waivers are
 * deliberately excluded, because they are superseded only at finalization and an explicit
 * re-authoring must not inherit them (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#2-ledger-schema-event-v3--v4; PD-003 point 6 (docs/adr/0015-lightweight-post-review-revision.md#pd-003-the-product-decision-this-record-implements)).
 */
function pendingAttemptWaivers(step) {
  return (step.active_attempt?.pending_waivers ?? []).map((waiver) => ({
    ...structuredClone(waiver),
    status: "active",
  }));
}

/*
 * The waivers a publication validates against: a revision adds the step's journaled active ones,
 * any other publication honours only what its own attempt carries.
 */
function effectivePublicationWaivers(step, operation) {
  return operation === "revise"
    ? effectiveRevisionWaivers(step)
    : pendingAttemptWaivers(step);
}

/*
 * A `decision` waiver records a decision about the brief, not about one material (task 112): the
 * sibling material published from the same brief digest reads it before authoring. Only active
 * records of the other material step whose brief_digest equals the digest this step publishes
 * from are visible; superseded ones and records of another brief are not.
 */
function siblingDecisionWaivers(record, stepName, briefDigest) {
  if (!isMaterialStep(stepName) || typeof briefDigest !== "string") return [];
  const siblingName = fileBackedMaterialStepNames.find((name) => name !== stepName);
  const sibling = record.steps[siblingName];
  return (sibling?.waivers ?? [])
    .filter((waiver) =>
      waiver.status === "active"
      && waiver.subject?.kind === "decision"
      && waiver.brief_digest === briefDigest)
    .map((waiver) => ({
      id: waiver.id,
      key: waiver.subject.key,
      ...(waiver.note ? { note: waiver.note } : {}),
      step: siblingName,
    }));
}

function supersedeStepWaivers(step) {
  for (const waiver of step.waivers ?? []) {
    if (waiver.status === "active") waiver.status = "superseded";
  }
}

function latestCommittedOpenConflicts(step) {
  const committed = [...step.attempt_history]
    .reverse()
    .find((attempt) => attempt.publication_id !== null);
  return structuredClone(committed?.open_conflicts ?? []);
}

export class ProcessLogLifecycleError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ProcessLogLifecycleError";
    this.code = code;
  }
}

function requireNonEmptyString(value, field, code = "invalid_start_input") {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new ProcessLogLifecycleError(code, `${field} must not be empty`);
  }
  return normalized;
}

function normalizeNullableString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function createProcessId(startedAt, uuid) {
  const stamp = startedAt.replace(/\.\d{3}Z$/, "Z").replaceAll("-", "").replaceAll(":", "");
  return `proc_${stamp}_${uuid.slice(0, 8)}`;
}

function createAttemptId(uuid) {
  return `attempt_${uuid}`;
}

function allocateUniqueId(existingIds, factory, code, label) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = requireNonEmptyString(factory(), label);
    if (!existingIds.has(candidate)) return candidate;
  }
  throw new ProcessLogLifecycleError(code, `could not allocate a unique ${label}`);
}

function activeAttemptIds(log) {
  const ids = new Set();
  for (const processRecord of log.processes) {
    if (classifyProcessRecord(processRecord) !== "file-backed") continue;
    for (const stepName of fileBackedStepNames) {
      const id = processRecord.steps[stepName].active_attempt?.id;
      if (id) ids.add(id);
    }
  }
  return ids;
}

function requireStepName(value) {
  const stepName = requireNonEmptyString(value, "stepName", "invalid_step_name");
  if (!fileBackedStepNames.includes(stepName)) {
    throw new ProcessLogLifecycleError(
      "invalid_step_name",
      `stepName must be one of: ${fileBackedStepNames.join(", ")}`,
    );
  }
  return stepName;
}

const STABLE_DIAGNOSTIC_CODE_PATTERN = processLogStableDiagnosticCodePattern;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, allowedKeys, code, label) {
  if (!isPlainObject(value)) {
    throw new ProcessLogLifecycleError(code, `${label} must be an object`);
  }
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw new ProcessLogLifecycleError(
      code,
      `${label} contains unknown key(s): ${unknownKeys.join(", ")}`,
    );
  }
}

function normalizeDiagnosticInput(
  value,
  {
    inputCode,
    label,
  },
) {
  assertExactKeys(
    value,
    ["code", "message", "retryable", "details"],
    inputCode,
    label,
  );
  const code = requireNonEmptyString(
    value.code,
    `${label}.code`,
    inputCode,
  );
  if (!STABLE_DIAGNOSTIC_CODE_PATTERN.test(code)) {
    throw new ProcessLogLifecycleError(
      inputCode,
      `${label}.code must be a lowercase snake_case stable code`,
    );
  }
  const message = requireNonEmptyString(
    value.message,
    `${label}.message`,
    inputCode,
  );
  // The message is the explanation a reader gets; the code is the handle a machine gets. Repeating
  // the code explains nothing, and a message that is only the code used to be impossible for an
  // incidental reason - the message had to carry a Cyrillic letter and a code is ASCII by its own
  // pattern. That requirement is gone, so the part of it worth keeping is said here directly.
  if (message === code) {
    throw new ProcessLogLifecycleError(
      inputCode,
      `${label}.message must explain the diagnostic, not repeat ${label}.code`,
    );
  }
  if (typeof value.retryable !== "boolean") {
    throw new ProcessLogLifecycleError(
      inputCode,
      `${label}.retryable must be a boolean`,
    );
  }
  const details = value.details ?? [];
  if (
    !Array.isArray(details)
    || details.some((detail) => typeof detail !== "string" || !detail.trim())
  ) {
    throw new ProcessLogLifecycleError(
      inputCode,
      `${label}.details must be an array of non-empty strings`,
    );
  }
  const normalized = {
    code,
    message,
    retryable: value.retryable,
    details: [...details],
  };
  const [problem] = processLogDiagnosticProblems(normalized, label);
  if (problem) throw new ProcessLogLifecycleError(inputCode, problem);
  return normalized;
}

function normalizeFailureDiagnosticInput(value) {
  return normalizeDiagnosticInput(value, {
    inputCode: "invalid_fail_step_input",
    label: "fail-step error",
  });
}

function normalizeBlockerDiagnosticInput(value) {
  return normalizeDiagnosticInput(value, {
    inputCode: "invalid_publish_step_input",
    label: "publish-step blocker",
  });
}

function mutationTimestamp(clock, ...minimumTimestamps) {
  const observedTimestamp = clock();
  if (
    typeof observedTimestamp !== "string"
    || observedTimestamp.trim().length === 0
  ) {
    throw new ProcessLogLifecycleError(
      "invalid_mutation_timestamp",
      "clock timestamp is outside the allowed causal window",
    );
  }
  const timestamp = observedTimestamp.trim();
  const errors = [];
  validateIsoTimestamp(timestamp, "clock timestamp", errors);
  const timestampMs = Date.parse(timestamp);
  if (
    errors.length > 0
    || !Number.isFinite(timestampMs)
    || timestampMs > Date.now() + PROCESS_LOG_FUTURE_SKEW_MS
    || (
      minimumTimestamps.some(
        (minimumTimestamp) =>
          minimumTimestamp !== null
          && timestampMs < Date.parse(minimumTimestamp),
      )
    )
  ) {
    throw new ProcessLogLifecycleError(
      "invalid_mutation_timestamp",
      "clock timestamp is outside the allowed causal window",
    );
  }
  return timestamp;
}

function recordMutationTimestamp(clock, log, record) {
  return mutationTimestamp(clock, log.updated_at, record.updated_at);
}

function touchFileBackedRecord(log, record, timestamp) {
  record.updated_at = timestamp;
  log.updated_at = timestamp;
}

function historicalReadOnlyError(record, operation) {
  return new ProcessLogLifecycleError(
    "historical_process_read_only",
    `historical process ${record.id} is read-only and cannot run ${operation}`,
  );
}

/*
 * The letter's length limits from the candidate layer of this workspace. There is no fallback: a
 * checkout without the layer, or with a config that lacks the keys, refuses under the layer's own
 * code rather than under a code of the caller's input — a broken layer is not a wrong number.
 */
function candidateLetterLimits(environment) {
  try {
    return coverLetterLimitsFor({ root: candidateRootFor(environment.workspacePath) });
  } catch (error) {
    if (error instanceof CandidateError) {
      throw new ProcessLogLifecycleError(error.code, `candidate layer: ${error.message}`);
    }
    throw error;
  }
}

/*
 * The language names an artifact of this workspace may carry, from its candidate layer: the
 * default language and the configured ones. Only the config is read, so a broken pack does not
 * stop Steps 1–3 or the deep check of an old process. A broken config refuses under the layer's own
 * code rather than as a corrupt artifact — the artifact did not change, the layer did.
 */
function candidateVacancyLanguages(environment) {
  try {
    return candidateLanguageNames({ root: candidateRootFor(environment.workspacePath) });
  } catch (error) {
    if (error instanceof CandidateError) {
      throw new ProcessLogLifecycleError(error.code, `candidate layer: ${error.message}`);
    }
    throw error;
  }
}

/*
 * The two markets an artifact of this workspace may name, from its candidate layer, or `null`
 * without a layer. Read and refused exactly as the language names above.
 */
function candidateVacancyMarkets(environment) {
  try {
    return candidateMarkets({ root: candidateRootFor(environment.workspacePath) });
  } catch (error) {
    if (error instanceof CandidateError) {
      throw new ProcessLogLifecycleError(error.code, `candidate layer: ${error.message}`);
    }
    throw error;
  }
}

function resolveOutputEnvironment(workspaceRoot, outputRoot) {
  try {
    return checkOutputRoot({ outputRoot, workspaceRoot });
  } catch (error) {
    if (error instanceof OutputRootError) {
      throw new ProcessLogLifecycleError(error.code, error.message);
    }
    throw error;
  }
}

function directChildName(parentPath, childPath) {
  const childRelativePath = relative(parentPath, childPath);
  if (
    !childRelativePath
    || childRelativePath === ".."
    || childRelativePath.startsWith(`..${sep}`)
    || isAbsolute(childRelativePath)
    || childRelativePath.includes(sep)
  ) {
    return null;
  }
  return childRelativePath;
}

function pathIsWithin(parentPath, childPath) {
  const childRelativePath = relative(parentPath, childPath);
  return childRelativePath === ""
    || (
      childRelativePath !== ".."
      && !childRelativePath.startsWith(`..${sep}`)
      && !isAbsolute(childRelativePath)
    );
}

function listOutputEntries(outputPath) {
  try {
    return readdirSync(outputPath);
  } catch (error) {
    throw new ProcessLogLifecycleError(
      "output_scan_failed",
      `cannot inspect outputRoot (${error.code ?? "unknown"})`,
    );
  }
}

function validateOwnedOutputDirectory(outputPath, outputRealPath, outputDir) {
  const segment = outputDir.slice("output/".length);
  const equivalentNames = listOutputEntries(outputPath).filter(
    (name) => outputDirEquivalenceKey(`output/${name}`) === outputDirEquivalenceKey(outputDir),
  );
  if (equivalentNames.some((name) => name !== segment)) {
    throw new ProcessLogLifecycleError(
      "output_path_conflict",
      `${outputDir} collides with a differently named filesystem entry`,
    );
  }
  if (!equivalentNames.includes(segment)) return false;

  const targetPath = resolve(outputPath, segment);
  let stats;
  try {
    stats = lstatSync(targetPath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw new ProcessLogLifecycleError(
      "output_path_invalid",
      `${outputDir} cannot be inspected (${error.code ?? "unknown"})`,
    );
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ProcessLogLifecycleError(
      "output_path_invalid",
      `${outputDir} must be a non-symlink directory`,
    );
  }
  let targetRealPath;
  try {
    targetRealPath = realpathSync(targetPath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw new ProcessLogLifecycleError(
      "output_path_invalid",
      `${outputDir} realpath cannot be inspected (${error.code ?? "unknown"})`,
    );
  }
  if (directChildName(outputRealPath, targetRealPath) !== segment) {
    throw new ProcessLogLifecycleError(
      "output_path_invalid",
      `${outputDir} realpath is outside its reserved direct child`,
    );
  }
  return true;
}

function selectedOutputDirectory(environment, record) {
  if (record.output_dir === null) {
    throw new ProcessLogLifecycleError(
      "output_not_reserved",
      `process ${record.id} has no reserved output directory`,
    );
  }
  if (
    !validateOwnedOutputDirectory(
      environment.outputPath,
      environment.outputRealPath,
      record.output_dir,
    )
  ) {
    throw new ProcessLogLifecycleError(
      "output_missing",
      `reserved output directory is missing for process ${record.id}`,
    );
  }
  const segment = record.output_dir.slice("output/".length);
  return {
    path: resolve(environment.outputPath, segment),
    realPath: resolve(environment.outputRealPath, segment),
  };
}

function readVerifiedFile({
  basePath,
  baseRealPath,
  codePrefix,
  relativePath,
}) {
  const pathSegments = relativePath.split("/");
  const filePath = resolve(basePath, ...pathSegments);
  const expectedRealPath = resolve(baseRealPath, ...pathSegments);
  if (!pathIsWithin(basePath, filePath) || !pathIsWithin(baseRealPath, expectedRealPath)) {
    throw new ProcessLogLifecycleError(
      `${codePrefix}_invalid`,
      `${relativePath} resolves outside its owned root`,
    );
  }

  let stats;
  try {
    stats = lstatSync(filePath);
  } catch (error) {
    const code = error.code === "ENOENT" ? `${codePrefix}_missing` : `${codePrefix}_invalid`;
    throw new ProcessLogLifecycleError(
      code,
      `${relativePath} cannot be inspected (${error.code ?? "unknown"})`,
    );
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ProcessLogLifecycleError(
      `${codePrefix}_invalid`,
      `${relativePath} must be a non-symlink regular file`,
    );
  }

  let actualRealPath;
  try {
    actualRealPath = realpathSync(filePath);
  } catch (error) {
    const code = error.code === "ENOENT" ? `${codePrefix}_missing` : `${codePrefix}_invalid`;
    throw new ProcessLogLifecycleError(
      code,
      `${relativePath} realpath cannot be inspected (${error.code ?? "unknown"})`,
    );
  }
  if (actualRealPath !== expectedRealPath) {
    throw new ProcessLogLifecycleError(
      `${codePrefix}_invalid`,
      `${relativePath} resolves through an unexpected filesystem path`,
    );
  }

  try {
    return readFileSync(filePath);
  } catch (error) {
    const code = error.code === "ENOENT" ? `${codePrefix}_missing` : `${codePrefix}_invalid`;
    throw new ProcessLogLifecycleError(
      code,
      `${relativePath} cannot be read (${error.code ?? "unknown"})`,
    );
  }
}

function bundleIdentity(entries) {
  return JSON.stringify(
    entries
      .map((entry) => ({
        kind: entry.kind,
        path: entry.path,
        schema_version: entry.schema_version,
        sha256: entry.sha256,
        bytes: entry.bytes,
      }))
      .sort(
        (left, right) =>
          left.kind.localeCompare(right.kind)
          || left.path.localeCompare(right.path),
      ),
  );
}

function changedBundleKinds(leftEntries, rightEntries) {
  const leftByKind = new Map(
    leftEntries.map((entry) => [entry.kind, JSON.stringify(entry)]),
  );
  const rightByKind = new Map(
    rightEntries.map((entry) => [entry.kind, JSON.stringify(entry)]),
  );
  return [...new Set([...leftByKind.keys(), ...rightByKind.keys()])]
    .filter((kind) => leftByKind.get(kind) !== rightByKind.get(kind))
    .sort();
}

function canonicalSnapshot(entries) {
  const kindOwners = new Map();
  const pathOwners = new Map();
  for (const entry of entries) {
    const kindOwner = kindOwners.get(entry.kind);
    if (kindOwner !== undefined) {
      throw new ProcessLogLifecycleError(
        "inputs_ambiguous",
        `input kind ${entry.kind} resolves to both ${kindOwner} and ${entry.path}`,
      );
    }
    kindOwners.set(entry.kind, entry.path);

    const pathOwner = pathOwners.get(entry.path);
    if (pathOwner !== undefined) {
      throw new ProcessLogLifecycleError(
        "inputs_ambiguous",
        `input path ${entry.path} resolves to both ${pathOwner} and ${entry.kind}`,
      );
    }
    pathOwners.set(entry.path, entry.kind);
  }
  return entries
    .map((entry) => structuredClone(entry))
    .sort(
      (left, right) =>
        left.kind.localeCompare(right.kind)
        || left.path.localeCompare(right.path),
    );
}

function filesystemOutputKeys(outputPath) {
  return new Set(
    listOutputEntries(outputPath).map((name) =>
      outputDirEquivalenceKey(`output/${name}`)),
  );
}

function expectedProcessIdentity(record) {
  return {
    id: record.id,
    sourceRef: record.source_ref,
    outputDir: record.output_dir,
    companyObserved: record.company_observed,
    role: record.role,
  };
}

function parseJsonArtifact(bytes, artifactPath) {
  const errors = [];
  const value = parseJsonBytes(bytes, artifactPath, errors);
  if (errors.length > 0) {
    throw new ProcessLogLifecycleError(
      "artifact_corrupt",
      errors.join("; "),
    );
  }
  return value;
}

/*
 * The entry and bytes of one protected input, or `null` for an optional input that is not there: an
 * absent file, or an empty one, which the layer reads as holding nothing. This is the one test of
 * whether an input is present, for the snapshot and for the composition check of a revision alike.
 */
function protectedInputEntry(environment, contract) {
  let bytes;
  try {
    bytes = readVerifiedFile({
      basePath: environment.workspacePath,
      baseRealPath: environment.workspaceRealPath,
      codePrefix: "input",
      relativePath: contract.path,
    });
  } catch (error) {
    if (contract.optional && error.code === "input_missing") return null;
    throw error;
  }
  if (bytes.byteLength === 0 && contract.optional) return null;
  if (bytes.byteLength === 0) {
    throw new ProcessLogLifecycleError(
      "input_invalid",
      `${contract.path} must not be empty`,
    );
  }
  const utf8Errors = [];
  validateUtf8TextBytes(bytes, contract.path, utf8Errors);
  if (utf8Errors.length > 0) {
    throw new ProcessLogLifecycleError(
      "input_invalid",
      utf8Errors.join("; "),
    );
  }
  return {
    entry: {
      kind: contract.kind,
      path: contract.path,
      schema_version: null,
      sha256: sha256Hex(bytes),
      bytes: bytes.byteLength,
    },
    bytes,
  };
}

function currentProtectedInputs(
  environment,
  stepName,
  cache,
  language = null,
  pinnedSnapshot = null,
) {
  const entries = [];
  const skipsAddedKinds = pinnedSnapshot !== null
    && snapshotPredatesLayerInputs(stepName, pinnedSnapshot);
  for (const contract of protectedInputContracts(stepName, language)) {
    if (skipsAddedKinds && layerInputKindsAddedLater.has(contract.kind)) continue;
    let input = cache.get(contract.kind);
    if (input === undefined) {
      input = protectedInputEntry(environment, contract);
      cache.set(contract.kind, input);
    } else if (input !== null && input.entry.path !== contract.path) {
      throw new ProcessLogLifecycleError(
        "inputs_ambiguous",
        `protected input ${contract.kind} has conflicting canonical paths`,
      );
    }
    if (input !== null) entries.push(input.entry);
  }
  return entries;
}

// The language a Step 5 letter is written in: the vacancy language of the brief it is written from,
// already validated against the configured languages when the brief's bundle was verified.
function letterLanguageOf(briefBundle) {
  const brief = briefBundle.files.get("application_brief");
  if (!brief) return null;
  return parseJsonArtifact(brief.bytes, brief.metadata.path)?.role?.vacancyLanguage ?? null;
}

function verifiedArtifactBundle(
  record,
  stepName,
  environment,
  outputDirectory,
  artifactCache,
  protectedInputCache,
) {
  const existing = artifactCache.get(stepName);
  if (existing !== undefined) return existing;

  const step = record.steps[stepName];
  const files = new Map();
  for (const artifact of step.artifacts) {
    const bytes = readVerifiedFile({
      basePath: outputDirectory.path,
      baseRealPath: outputDirectory.realPath,
      codePrefix: "artifact",
      relativePath: artifact.path,
    });
    if (
      bytes.byteLength !== artifact.bytes
      || sha256Hex(bytes) !== artifact.sha256
    ) {
      throw new ProcessLogLifecycleError(
        "artifact_corrupt",
        `${artifact.path} does not match its committed digest and size`,
      );
    }
    files.set(artifact.kind, { bytes, metadata: artifact });
  }

  const expectedProcess = expectedProcessIdentity(record);
  let validationErrors = [];
  if (stepName === "get_vacancy") {
    const vacancyFile = files.get("vacancy");
    const jobDescriptionFile = files.get("job_description");
    if (vacancyFile && jobDescriptionFile) {
      validationErrors = validateVacancy(
        parseJsonArtifact(vacancyFile.bytes, vacancyFile.metadata.path),
        {
          expectedProcess,
          expectedSchemaVersion: vacancyFile.metadata.schema_version,
          languages: candidateVacancyLanguages(environment),
          markets: candidateVacancyMarkets(environment),
          jobDescriptionBytes: jobDescriptionFile.bytes,
          outcome: "completed",
        },
      );
    }
  } else if (stepName === "research_company") {
    const researchFile = files.get("company_research");
    const vacancyBundle = verifiedArtifactBundle(
      record,
      "get_vacancy",
      environment,
      outputDirectory,
      artifactCache,
      protectedInputCache,
    );
    if (researchFile) {
      validationErrors = validateCompanyResearch(
        parseJsonArtifact(researchFile.bytes, researchFile.metadata.path),
        {
          expectedProcess,
          languages: candidateVacancyLanguages(environment),
          markets: candidateVacancyMarkets(environment),
          expectedSchemaVersion: researchFile.metadata.schema_version,
          vacancyBytes: vacancyBundle.files.get("vacancy")?.bytes,
          jobDescriptionBytes: vacancyBundle.files.get("job_description")?.bytes,
          outcome: "completed",
        },
      );
    }
  } else if (stepName === "map_experience") {
    const briefFile = files.get("application_brief");
    const vacancyBundle = verifiedArtifactBundle(
      record,
      "get_vacancy",
      environment,
      outputDirectory,
      artifactCache,
      protectedInputCache,
    );
    const researchBundle = verifiedArtifactBundle(
      record,
      "research_company",
      environment,
      outputDirectory,
      artifactCache,
      protectedInputCache,
    );
    // The brief is validated against the bytes of the inputs below, so they are compared with the
    // ones Step 3 published from before that validation runs: an edit of the profile or of the
    // lever bank after Step 3 is a stale prerequisite, not a corrupt brief. An input the record
    // never published from — a Step 3 older than the input — is stale in the same way.
    const currentInputs = currentProtectedInputs(environment, "map_experience", protectedInputCache);
    const candidateProfile = currentInputs.find((entry) => entry.kind === "candidate_profile");
    for (const kind of BRIEF_VALIDATION_INPUT_KINDS) {
      const current = currentInputs.find((entry) => entry.kind === kind);
      if (!current) continue;
      const published = record.steps.map_experience.published_inputs
        .find((entry) => entry.kind === kind);
      if (!published || bundleIdentity([current]) !== bundleIdentity([published])) {
        throw new ProcessLogLifecycleError(
          "prerequisite_stale",
          `map_experience was published from a different ${kind} input`,
        );
      }
    }
    if (briefFile && candidateProfile) {
      validationErrors = validateApplicationBrief(
        parseJsonArtifact(briefFile.bytes, briefFile.metadata.path),
        {
          expectedProcess,
          expectedSchemaVersion: briefFile.metadata.schema_version,
          languages: candidateVacancyLanguages(environment),
          markets: candidateVacancyMarkets(environment),
          vacancyBytes: vacancyBundle.files.get("vacancy")?.bytes,
          jobDescriptionBytes: vacancyBundle.files.get("job_description")?.bytes,
          companyResearchBytes: researchBundle.files.get("company_research")?.bytes,
          candidateProfileBytes:
            protectedInputCache.get("candidate_profile")?.bytes,
          candidateLeversBytes:
            protectedInputCache.get("candidate_levers")?.bytes,
          requireInputBytes: true,
        },
      );
    }
  }
  if (validationErrors.length > 0) {
    throw new ProcessLogLifecycleError(
      "artifact_corrupt",
      `${stepName} artifact bundle validation failed: ${validationErrors.join("; ")}`,
    );
  }

  const bundle = {
    entries: canonicalSnapshot(step.artifacts),
    files,
  };
  artifactCache.set(stepName, bundle);
  return bundle;
}

function currentInputSnapshotForStep(
  record,
  stepName,
  environment,
  outputDirectory,
  artifactCache,
  protectedInputCache,
  pinnedSnapshot = null,
) {
  const entries = [];
  let language = null;
  for (const ownerStepName of fileBackedArtifactInputSteps[stepName]) {
    const bundle = verifiedArtifactBundle(
      record,
      ownerStepName,
      environment,
      outputDirectory,
      artifactCache,
      protectedInputCache,
    );
    entries.push(...bundle.entries);
    if (ownerStepName === "map_experience" && fileBackedLetterLanguageInputs[stepName]) {
      language = letterLanguageOf(bundle);
    }
  }
  entries.push(...currentProtectedInputs(
    environment,
    stepName,
    protectedInputCache,
    language,
    pinnedSnapshot,
  ));
  return canonicalSnapshot(entries);
}

function assertCommittedStepCurrent(
  record,
  stepName,
  environment,
  outputDirectory,
  artifactCache,
  protectedInputCache,
  currentSteps,
) {
  if (currentSteps.has(stepName)) return;
  const step = record.steps[stepName];
  if (step.state === "stale") {
    throw new ProcessLogLifecycleError(
      "prerequisite_stale",
      `${stepName} is stale`,
    );
  }
  if (step.state !== "completed") {
    throw new ProcessLogLifecycleError(
      "prerequisite_not_ready",
      `${stepName} must be completed before its consumer can begin`,
    );
  }
  for (const prerequisite of fileBackedStepDependencies[stepName]) {
    assertCommittedStepCurrent(
      record,
      prerequisite,
      environment,
      outputDirectory,
      artifactCache,
      protectedInputCache,
      currentSteps,
    );
  }
  verifiedArtifactBundle(
    record,
    stepName,
    environment,
    outputDirectory,
    artifactCache,
    protectedInputCache,
  );
  const expectedInputs = currentInputSnapshotForStep(
    record,
    stepName,
    environment,
    outputDirectory,
    artifactCache,
    protectedInputCache,
  );
  if (bundleIdentity(step.published_inputs) !== bundleIdentity(expectedInputs)) {
    throw new ProcessLogLifecycleError(
      "prerequisite_stale",
      `${stepName} was published from a different input snapshot`,
    );
  }
  currentSteps.add(stepName);
}

// `pinnedSnapshot` is passed only by the callers that compare against a published snapshot.
function preflightFileBackedStepRecord(record, stepName, environment, pinnedSnapshot = null) {
  if (stepName === "get_vacancy") {
    return {
      input_snapshot: [],
      prerequisites: [],
      process: record,
      step: record.steps[stepName],
      step_name: stepName,
    };
  }
  const outputDirectory = selectedOutputDirectory(environment, record);
  const artifactCache = new Map();
  const protectedInputCache = new Map();
  const currentSteps = new Set();

  for (const prerequisite of fileBackedStepDependencies[stepName]) {
    assertCommittedStepCurrent(
      record,
      prerequisite,
      environment,
      outputDirectory,
      artifactCache,
      protectedInputCache,
      currentSteps,
    );
  }
  const inputSnapshot = currentInputSnapshotForStep(
    record,
    stepName,
    environment,
    outputDirectory,
    artifactCache,
    protectedInputCache,
    pinnedSnapshot,
  );
  return {
    input_snapshot: inputSnapshot,
    prerequisites: [...fileBackedStepDependencies[stepName]],
    process: record,
    ...(isMaterialStep(stepName)
      ? {
          sibling_decision_waivers: siblingDecisionWaivers(
            record,
            stepName,
            pinnedBriefEntry(inputSnapshot)?.sha256 ?? null,
          ),
        }
      : {}),
    step: record.steps[stepName],
    step_name: stepName,
  };
}

export function preflightFileBackedStepV3(
  logPath,
  input,
  {
    lockOptions,
    outputRoot,
    workspaceRoot,
  } = {},
) {
  assertExactKeys(
    input,
    ["selector", "stepName"],
    "invalid_preflight_input",
    "preflight-step input",
  );
  const stepName = requireStepName(input.stepName);
  const environment = resolveOutputEnvironment(workspaceRoot, outputRoot);
  return withLogV3Lock(logPath, ({ log }) => {
    const record = resolveFileBackedProcessV3(log, input.selector);
    return preflightFileBackedStepRecord(record, stepName, environment);
  }, lockOptions);
}

export function beginFileBackedStepV3(
  logPath,
  input,
  {
    attemptIdFactory = () => createAttemptId(randomUUID()),
    clock = () => new Date().toISOString(),
    lockOptions,
    outputRoot,
    workspaceRoot,
  } = {},
) {
  assertExactKeys(
    input,
    ["selector", "stepName"],
    "invalid_begin_step_input",
    "begin-step input",
  );
  const stepName = requireStepName(input.stepName);
  const environment = resolveOutputEnvironment(workspaceRoot, outputRoot);

  return withLogV3Lock(logPath, ({ log, write }) => {
    const record = resolveFileBackedProcessV3(log, input.selector);
    const step = record.steps[stepName];
    if (step.state !== "pending") {
      throw new ProcessLogLifecycleError(
        "invalid_step_transition",
        `begin-step requires ${stepName} to be pending, found ${step.state}`,
      );
    }
    const preflight = preflightFileBackedStepRecord(record, stepName, environment);
    const startedAt = recordMutationTimestamp(clock, log, record);
    const attemptId = allocateUniqueId(
      activeAttemptIds(log),
      attemptIdFactory,
      "active_attempt_id_conflict",
      "active attempt id",
    );

    step.state = "running";
    step.attempt += 1;
    step.started_at = startedAt;
    step.updated_at = startedAt;
    step.finished_at = null;
    step.active_attempt = {
      id: attemptId,
      started_at: startedAt,
      expected_revision: step.revision,
      expected_artifacts: structuredClone(step.artifacts),
      input_snapshot: structuredClone(preflight.input_snapshot),
    };
    step.publication_transaction = null;
    step.error = null;
    step.blocker = null;
    touchFileBackedRecord(log, record, startedAt);
    write(log);

    return {
      attempt_id: attemptId,
      input_snapshot: structuredClone(step.active_attempt.input_snapshot),
      process: record,
      status: "started",
      step_name: stepName,
    };
  }, lockOptions);
}

function requireMatchingActiveAttempt(step, stepName, attemptId, operation) {
  if (
    step.state !== "running"
    || step.active_attempt === null
    || step.active_attempt.id !== attemptId
  ) {
    throw new ProcessLogLifecycleError(
      "stale_attempt",
      `${operation} did not match the active ${stepName} attempt`,
    );
  }
  if (step.publication_transaction !== null) {
    throw new ProcessLogLifecycleError(
      "publication_recovery_required",
      `${stepName} has a prepared publication that must be reconciled`,
    );
  }
  return step.active_attempt;
}

function closeRunningStepAsFailed({
  diagnostic,
  log,
  record,
  stepName,
  timestamp,
}) {
  const step = record.steps[stepName];
  const activeAttempt = step.active_attempt;
  const revising = activeAttempt.operation === "revise";
  const historyEntry = {
    attempt: step.attempt,
    outcome: "failed",
    started_at: activeAttempt.started_at,
    finished_at: timestamp,
    input_snapshot: structuredClone(activeAttempt.input_snapshot),
    error_code: diagnostic.code,
    publication_id: null,
  };
  if (revising) {
    historyEntry.operation = "revise";
    historyEntry.channel = activeAttempt.channel;
    historyEntry.pre_attempt_state = activeAttempt.pre_attempt_state;
  }
  // A revision attempt that closes without a publication leaves the published material untouched,
  // so the step keeps its committed mark instead of failing (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#1-a-new-lifecycle-operation-revise-step-steps-45-only).
  step.state = revising ? activeAttempt.pre_attempt_state : "failed";
  step.updated_at = timestamp;
  step.finished_at = timestamp;
  step.active_attempt = null;
  step.publication_transaction = null;
  step.attempt_history.push(historyEntry);
  step.error = revising
    ? null
    : {
        ...structuredClone(diagnostic),
        at: timestamp,
      };
  step.blocker = null;
  touchFileBackedRecord(log, record, timestamp);
  return revising ? step.state : "failed";
}

function adoptedEntryByKind(adoptionBase, kind) {
  return adoptionBase?.entries?.find((entry) => entry.kind === kind) ?? null;
}

function verifyCommittedArtifactBaseline(
  record,
  stepName,
  environment,
  { adoptionBase = null } = {},
) {
  const step = record.steps[stepName];
  if (step.revision === 0) return;
  const outputDirectory = selectedOutputDirectory(environment, record);
  for (const artifact of step.artifacts) {
    const bytes = readVerifiedFile({
      basePath: outputDirectory.path,
      baseRealPath: outputDirectory.realPath,
      codePrefix: "artifact",
      relativePath: artifact.path,
    });
    // Inside a journaled adoption the divergent digest is the expected baseline for its kind;
    // everywhere else divergence stays corruption (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#5-edit-channels-and-transports(b), open point 5).
    const adopted = adoptedEntryByKind(adoptionBase, artifact.kind);
    const expected = adopted ?? artifact;
    if (
      bytes.byteLength !== expected.bytes
      || sha256Hex(bytes) !== expected.sha256
    ) {
      throw new ProcessLogLifecycleError(
        "artifact_corrupt",
        `${artifact.path} does not match its committed digest and size`,
      );
    }
  }
}

export function failFileBackedStepV3(
  logPath,
  input,
  {
    clock = () => new Date().toISOString(),
    lockOptions,
  } = {},
) {
  assertExactKeys(
    input,
    ["selector", "stepName", "attemptId", "error"],
    "invalid_fail_step_input",
    "fail-step input",
  );
  const stepName = requireStepName(input.stepName);
  const attemptId = requireNonEmptyString(
    input.attemptId,
    "attemptId",
    "invalid_fail_step_input",
  );
  const diagnostic = normalizeFailureDiagnosticInput(input.error);

  return withLogV3Lock(logPath, ({ log, write }) => {
    const record = resolveFileBackedProcessV3(log, input.selector);
    const step = record.steps[stepName];
    requireMatchingActiveAttempt(step, stepName, attemptId, "fail-step");
    const revising = step.active_attempt.operation === "revise";
    const failedAt = recordMutationTimestamp(clock, log, record);
    closeRunningStepAsFailed({
      diagnostic,
      log,
      record,
      stepName,
      timestamp: failedAt,
    });
    write(log);
    return {
      attempt: step.attempt,
      error: structuredClone(step.error),
      process: record,
      status: revising ? "reverted" : "failed",
      ...(revising ? { state: step.state } : {}),
      step_name: stepName,
    };
  }, lockOptions);
}

export function retryFileBackedStepV3(
  logPath,
  input,
  {
    adoptionIdFactory = () => `adoption_${randomUUID()}`,
    attemptIdFactory = () => createAttemptId(randomUUID()),
    clock = () => new Date().toISOString(),
    lockOptions,
    outputRoot,
    workspaceRoot,
  } = {},
) {
  assertExactKeys(
    input,
    ["selector", "stepName"],
    "invalid_retry_step_input",
    "retry-step input",
  );
  const stepName = requireStepName(input.stepName);
  const environment = resolveOutputEnvironment(workspaceRoot, outputRoot);

  return withLogV3Lock(logPath, ({ log, write }) => {
    const record = resolveFileBackedProcessV3(log, input.selector);
    const step = record.steps[stepName];
    if (!["blocked", "failed"].includes(step.state)) {
      throw new ProcessLogLifecycleError(
        "invalid_step_transition",
        `retry-step requires ${stepName} to be blocked or failed, found ${step.state}`,
      );
    }
    const diagnostic = step.state === "blocked" ? step.blocker : step.error;
    if (diagnostic?.retryable !== true) {
      throw new ProcessLogLifecycleError(
        "step_not_retryable",
        `${stepName} diagnostic does not authorize a retry`,
      );
    }

    const preflight = preflightFileBackedStepRecord(record, stepName, environment);
    const startedAt = recordMutationTimestamp(clock, log, record);
    const attemptId = allocateUniqueId(
      activeAttemptIds(log),
      attemptIdFactory,
      "active_attempt_id_conflict",
      "active attempt id",
    );
    // A failed adopted re-authoring must keep a lifecycle exit: retry re-enters the journaled
    // adoption base (re-journaling freshly re-diverged bytes, archiving them, and rebinding the
    // base to the new attempt) so the canonical slot's legitimate divergence is not corruption.
    let adoption = null;
    if (isMaterialStep(stepName)) {
      const outputDirectory = selectedOutputDirectory(environment, record);
      if (step.revision > 0) {
        completeCommittedRevisionArchive(step, outputDirectory);
      }
      if (step.adoption_base) {
        const established = establishAdoptionBase({
          adoptionIdFactory,
          attemptId,
          outputDirectory,
          step,
          timestamp: startedAt,
        });
        adoption = established.adoption;
        if (adoption !== null) {
          // Journal-first, like revise and reopen: the (possibly re-journaled) base lands in
          // the ledger before any archive file is written (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#5-edit-channels-and-transports(b)).
          touchFileBackedRecord(log, record, startedAt);
          write(log);
          archiveAdoptedDivergence(step, outputDirectory, adoption, established.canonicalBytes);
          adoption.phase = "archived";
        }
      }
    }
    verifyCommittedArtifactBaseline(record, stepName, environment, {
      adoptionBase: adoption,
    });

    step.state = "running";
    step.attempt += 1;
    step.started_at = startedAt;
    step.updated_at = startedAt;
    step.finished_at = null;
    step.active_attempt = {
      id: attemptId,
      started_at: startedAt,
      expected_revision: step.revision,
      expected_artifacts: structuredClone(step.artifacts),
      input_snapshot: structuredClone(preflight.input_snapshot),
    };
    step.publication_transaction = null;
    step.error = null;
    step.blocker = null;
    touchFileBackedRecord(log, record, startedAt);
    write(log);

    return {
      attempt_id: attemptId,
      input_snapshot: structuredClone(step.active_attempt.input_snapshot),
      process: record,
      status: "retried",
      step_name: stepName,
    };
  }, lockOptions);
}

/*
 * The adoption preamble (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#5-edit-channels-and-transports(b)): under the ledger lock, journal the observed divergent
 * digests as the adoption base before touching any file. A retry with unchanged canonical bytes
 * re-enters the same base idempotently; freshly re-diverged bytes replace it with a new base —
 * adoption is time-agnostic and journals whatever divergence it observes (docs/adr/0015-lightweight-post-review-revision.md#10-rollout-over-pre-existing-states).
 */
function establishAdoptionBase({
  adoptionIdFactory,
  attemptId,
  outputDirectory,
  step,
  timestamp,
}) {
  const { canonicalBytes, divergent } = observedAdoptionDivergence(step, outputDirectory);
  const existing = step.adoption_base ?? null;
  if (divergent.length === 0) {
    if (existing) {
      delete step.adoption_base;
      return { adoption: null, canonicalBytes };
    }
    throw new ProcessLogLifecycleError(
      "adoption_target_unchanged",
      "every canonical artifact matches its committed digest; nothing to adopt",
    );
  }
  if (
    existing
    && adoptionEntriesIdentity(existing.entries) === adoptionEntriesIdentity(divergent)
  ) {
    existing.attempt_id = attemptId;
    return { adoption: existing, canonicalBytes };
  }
  const base = {
    id: adoptionIdFactory(),
    created_at: timestamp,
    attempt_id: attemptId,
    publication_id: null,
    phase: "journaled",
    entries: divergent,
  };
  step.adoption_base = base;
  return { adoption: base, canonicalBytes };
}

export function reopenFileBackedStepV3(
  logPath,
  input,
  {
    adoptionIdFactory = () => `adoption_${randomUUID()}`,
    attemptIdFactory = () => createAttemptId(randomUUID()),
    clock = () => new Date().toISOString(),
    lockOptions,
    outputRoot,
    workspaceRoot,
  } = {},
) {
  assertExactKeys(
    input,
    ["selector", "stepName", "adopt"],
    "invalid_reopen_step_input",
    "reopen-step input",
  );
  const stepName = requireStepName(input.stepName);
  const adopt = input.adopt === true;
  if (adopt && !isMaterialStep(stepName)) {
    throw new ProcessLogLifecycleError(
      "invalid_reopen_step_input",
      "adopt is defined only for the two material steps",
    );
  }
  const environment = resolveOutputEnvironment(workspaceRoot, outputRoot);

  return withLogV3Lock(logPath, ({ log, write }) => {
    const record = resolveFileBackedProcessV3(log, input.selector);
    const step = record.steps[stepName];
    if (!["completed", "stale"].includes(step.state)) {
      throw new ProcessLogLifecycleError(
        "invalid_step_transition",
        `reopen-step requires ${stepName} to be completed or stale, found ${step.state}`,
      );
    }

    const descendantStepNames = transitiveDescendantStepNames(stepName);
    const runningDescendants = descendantStepNames.filter(
      (descendantStepName) =>
        record.steps[descendantStepName].state === "running",
    );
    if (runningDescendants.length > 0) {
      throw new ProcessLogLifecycleError(
        "dependent_step_running",
        `reopen-step cannot revise ${stepName} while descendant step(s) are running: ${runningDescendants.join(", ")}`,
      );
    }

    const preflight = preflightFileBackedStepRecord(record, stepName, environment);
    const startedAt = recordMutationTimestamp(clock, log, record);
    const attemptId = allocateUniqueId(
      activeAttemptIds(log),
      attemptIdFactory,
      "active_attempt_id_conflict",
      "active attempt id",
    );
    let adoption = null;
    if (isMaterialStep(stepName) && step.revision > 0) {
      completeCommittedRevisionArchive(step, selectedOutputDirectory(environment, record));
    }
    if (adopt) {
      const outputDirectory = selectedOutputDirectory(environment, record);
      const established = establishAdoptionBase({
        adoptionIdFactory,
        attemptId,
        outputDirectory,
        step,
        timestamp: startedAt,
      });
      adoption = established.adoption;
      if (adoption !== null) {
        // Journal first, then preserve the user's bytes: the explicit re-authoring will
        // overwrite the canonical slot, so the divergent bytes are archived as an adopted
        // base before the reopen proceeds (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#5-edit-channels-and-transports(b)).
        touchFileBackedRecord(log, record, startedAt);
        write(log);
        archiveAdoptedDivergence(step, outputDirectory, adoption, established.canonicalBytes);
        adoption.phase = "archived";
      }
    }
    verifyCommittedArtifactBaseline(record, stepName, environment, {
      adoptionBase: adoption,
    });
    const invalidatedSteps = [];

    for (const descendantStepName of descendantStepNames) {
      const descendantStep = record.steps[descendantStepName];
      if (descendantStep.state !== "completed") continue;
      descendantStep.state = "stale";
      descendantStep.updated_at = startedAt;
      invalidatedSteps.push(descendantStepName);
    }

    step.state = "running";
    step.attempt += 1;
    step.started_at = startedAt;
    step.updated_at = startedAt;
    step.finished_at = null;
    step.active_attempt = {
      id: attemptId,
      started_at: startedAt,
      expected_revision: step.revision,
      expected_artifacts: structuredClone(step.artifacts),
      input_snapshot: structuredClone(preflight.input_snapshot),
    };
    step.publication_transaction = null;
    step.error = null;
    step.blocker = null;
    touchFileBackedRecord(log, record, startedAt);
    write(log);

    return {
      attempt_id: attemptId,
      ...(adoption
        ? {
            adoption: {
              id: adoption.id,
              entries: structuredClone(adoption.entries),
              phase: adoption.phase,
              publication_id: adoption.publication_id,
            },
          }
        : {}),
      input_snapshot: structuredClone(step.active_attempt.input_snapshot),
      invalidated_steps: invalidatedSteps,
      process: record,
      status: "reopened",
      step_name: stepName,
    };
  }, lockOptions);
}

/*
 * The reverse-sync channel addresses the CV bundle's rendered document (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#5-edit-channels-and-transports(c)); the letter
 * bundle has no document. The binding is a writer rule rather than a schema one — an existing
 * record keeps its meaning — so it lives here, in the operation that enforces it.
 */
export const fileBackedDocxRevisionStepName = "generate_cv";

/*
 * The reverse sync aligns the user's document against the cv.json staging holds, and staging holds
 * whatever the canonical slot holds. That reconstructs the user's edits only while the document is
 * the one thing that diverged. If cv.json diverged too, staging would carry the user's own source
 * while the document was rendered from the committed one, so every edit the user made in cv.json
 * would read as a difference the document does not have — and be written back out of it. Refuse
 * that state rather than choosing which half of the user's work to lose.
 */
function assertDocxSyncAdoptionScope(adoption) {
  const kinds = (adoption?.entries ?? []).map((entry) => entry.kind);
  if (!kinds.includes("cv_docx")) {
    throw new ProcessLogLifecycleError(
      "docx_sync_target_unchanged",
      "the published document matches its committed digest; there is nothing to sync",
    );
  }
  const others = kinds.filter((kind) => kind !== "cv_docx");
  if (others.length > 0) {
    throw new ProcessLogLifecycleError(
      "docx_sync_source_diverged",
      `the reverse sync needs the committed source the document was rendered from, but ${others.join(", ")} diverged as well`,
    );
  }
}

const REVISION_WAIVER_INPUT_LIMIT = 16;

function normalizeWaiverInputs(value, readLetterLimits) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > REVISION_WAIVER_INPUT_LIMIT) {
    throw new ProcessLogLifecycleError(
      "invalid_waiver_input",
      `waivers must be an array of at most ${REVISION_WAIVER_INPUT_LIMIT} records`,
    );
  }
  return value.map((candidate, index) => {
    const label = `waivers[${index}]`;
    assertExactKeys(candidate, ["subject", "note"], "invalid_waiver_input", label);
    assertExactKeys(
      candidate.subject,
      ["kind", "key"],
      "invalid_waiver_input",
      `${label}.subject`,
    );
    const kind = requireNonEmptyString(
      candidate.subject.kind,
      `${label}.subject.kind`,
      "invalid_waiver_input",
    );
    if (!fileBackedRevisionSubjectKinds.includes(kind)) {
      throw new ProcessLogLifecycleError(
        "invalid_waiver_input",
        `${label}.subject.kind must be one of: ${fileBackedRevisionSubjectKinds.join(", ")}`,
      );
    }
    const key = requireNonEmptyString(
      candidate.subject.key,
      `${label}.subject.key`,
      "invalid_waiver_input",
    );
    if (processLogDiagnosticProblems({ code: "waiver", details: [key] }, label).length > 0) {
      throw new ProcessLogLifecycleError(
        "invalid_waiver_input",
        `${label}.subject.key must be bounded one-line text without forbidden shapes`,
      );
    }
    const limits = kind === "check" && key.startsWith(BODY_WORD_APPROVAL_KEY_PREFIX)
      ? readLetterLimits()
      : null;
    if (limits !== null && parseBodyWordApproval(key, limits) === null) {
      const { maximum, approvedMaximum } = limits.bodyWords;
      throw new ProcessLogLifecycleError(
        "invalid_waiver_input",
        `${label}.subject.key must be ${BODY_WORD_APPROVAL_KEY_PREFIX}<N> with an absolute body word count above ${maximum} and at most ${approvedMaximum}`,
      );
    }
    const normalized = { subject: { kind, key } };
    if (candidate.note !== undefined && candidate.note !== null) {
      const note = requireNonEmptyString(
        candidate.note,
        `${label}.note`,
        "invalid_waiver_input",
      );
      if (processLogDiagnosticProblems({ code: "waiver", message: note }, label).length > 0) {
        throw new ProcessLogLifecycleError(
          "invalid_waiver_input",
          `${label}.note must be bounded one-line text without forbidden shapes`,
        );
      }
      normalized.note = note;
    }
    return normalized;
  });
}

/*
 * The attempt-scoped records a publication will journal if it commits. The brief digest is the one
 * the attempt itself is pinned to: a revision pins the step's published inputs, a first
 * publication its own input snapshot, and `published_inputs` is empty while the revision is 0.
 */
function attemptPendingWaivers(step, waiverInputs, briefDigest, waiverIdFactory) {
  const existingWaiverIds = new Set((step.waivers ?? []).map((waiver) => waiver.id));
  return waiverInputs.map((waiver) => {
    const id = allocateUniqueId(
      existingWaiverIds,
      waiverIdFactory,
      "waiver_id_conflict",
      "waiver id",
    );
    existingWaiverIds.add(id);
    return {
      id,
      brief_digest: briefDigest,
      subject: structuredClone(waiver.subject),
      ...(waiver.note ? { note: waiver.note } : {}),
    };
  });
}

/*
 * publish-step carries a waiver only where the revision channel cannot reach it in time: the
 * letter's word-limit approval is decided on a draft that exists only between `begin-step` and the
 * publication (task 145). A revision keeps supplying its waivers at `revise-step`, and every other
 * finding of a publication that is not a revision stays a hard refusal.
 */
function assertPublishStepWaiverScope(waiverInputs, stepName, operation, readLetterLimits) {
  if (waiverInputs.length === 0) return;
  if (operation === "revise") {
    throw new ProcessLogLifecycleError(
      "invalid_publish_step_input",
      "a revision supplies its waivers at revise-step, not at publish-step",
    );
  }
  if (stepName !== "write_cover_letter") {
    throw new ProcessLogLifecycleError(
      "invalid_publish_step_input",
      `publish-step waivers are defined only for write_cover_letter, not ${stepName}`,
    );
  }
  if (waiverInputs.length > 1) {
    throw new ProcessLogLifecycleError(
      "invalid_publish_step_input",
      "publish-step takes at most one waiver: the letter word-limit approval",
    );
  }
  const [waiver] = waiverInputs;
  if (
    waiver.subject.kind !== "check"
    || !waiver.subject.key.startsWith(BODY_WORD_APPROVAL_KEY_PREFIX)
    || parseBodyWordApproval(waiver.subject.key, readLetterLimits()) === null
  ) {
    throw new ProcessLogLifecycleError(
      "invalid_publish_step_input",
      `publish-step takes only the word-limit approval: a check subject keyed ${BODY_WORD_APPROVAL_KEY_PREFIX}<N>`,
    );
  }
}

/*
 * revise-step (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#1-a-new-lifecycle-operation-revise-step-steps-45-only): opens a revision attempt on a completed or stale material step. It
 * reuses the staging discipline, attempt tokens, and journaled publication transaction, but pins
 * the step's own published input snapshot instead of deriving currency from live protected
 * inputs — knowledge drift neither blocks a revision nor is cleared by it.
 */
export function reviseFileBackedStepV3(
  logPath,
  input,
  {
    adoptionIdFactory = () => `adoption_${randomUUID()}`,
    attemptIdFactory = () => createAttemptId(randomUUID()),
    clock = () => new Date().toISOString(),
    lockOptions,
    outputRoot,
    publicationIdFactory = () => `publication_${randomUUID()}`,
    waiverIdFactory = () => `waiver_${randomUUID()}`,
    workspaceRoot,
  } = {},
) {
  assertExactKeys(
    input,
    ["selector", "stepName", "channel", "adopt", "waivers"],
    "invalid_revise_step_input",
    "revise-step input",
  );
  const stepName = requireStepName(input.stepName);
  if (!isMaterialStep(stepName)) {
    throw new ProcessLogLifecycleError(
      "revise_step_unsupported",
      `revise-step is defined only for: ${fileBackedMaterialStepNames.join(", ")}`,
    );
  }
  const channel = requireNonEmptyString(
    input.channel,
    "channel",
    "invalid_revise_step_input",
  );
  if (!fileBackedRevisionChannels.includes(channel)) {
    throw new ProcessLogLifecycleError(
      "invalid_revise_step_input",
      `channel must be one of: ${fileBackedRevisionChannels.join(", ")}`,
    );
  }
  const adopt = input.adopt === true;
  /*
   * The two file channels both take divergent canonical bytes, so both adopt; chat directs an edit
   * the agent authors and has nothing to adopt. The reverse-sync channel additionally binds to the
   * one bundle that has a document, and it cannot open without an adoption: a DOCX edit is
   * divergence by definition, and an attempt opened without one would journal `docx_sync` over an
   * edit that never came out of a document (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#5-edit-channels-and-transports(c)).
   */
  if (channel === "docx_sync" && stepName !== fileBackedDocxRevisionStepName) {
    throw new ProcessLogLifecycleError(
      "invalid_revise_step_input",
      `the docx_sync channel is defined only for ${fileBackedDocxRevisionStepName}`,
    );
  }
  if (adopt && !["manual_file", "docx_sync"].includes(channel)) {
    throw new ProcessLogLifecycleError(
      "invalid_revise_step_input",
      "adopt requires the manual_file or docx_sync channel",
    );
  }
  if (channel === "docx_sync" && !adopt) {
    throw new ProcessLogLifecycleError(
      "invalid_revise_step_input",
      "the docx_sync channel requires adopt",
    );
  }
  const environment = resolveOutputEnvironment(workspaceRoot, outputRoot);
  const waiverInputs = normalizeWaiverInputs(input.waivers, () => candidateLetterLimits(environment));

  return withLogV3Lock(logPath, ({ log, write }) => {
    const record = resolveFileBackedProcessV3(log, input.selector);
    const step = record.steps[stepName];
    if (!["completed", "stale"].includes(step.state)) {
      throw new ProcessLogLifecycleError(
        "invalid_step_transition",
        `revise-step requires ${stepName} to be completed or stale, found ${step.state}`,
      );
    }
    const outputDirectory = selectedOutputDirectory(environment, record);
    assertRevisionBriefCoherent(record, stepName, outputDirectory, step.published_inputs);
    const briefDigest = pinnedBriefEntry(step.published_inputs).sha256;
    completeCommittedRevisionArchive(step, outputDirectory);

    const startedAt = recordMutationTimestamp(clock, log, record);
    const attemptId = allocateUniqueId(
      activeAttemptIds(log),
      attemptIdFactory,
      "active_attempt_id_conflict",
      "active attempt id",
    );

    let adoption = null;
    let adoptionCanonicalBytes = null;
    if (adopt) {
      const established = establishAdoptionBase({
        adoptionIdFactory,
        attemptId,
        outputDirectory,
        step,
        timestamp: startedAt,
      });
      adoption = established.adoption;
      adoptionCanonicalBytes = established.canonicalBytes;
      // Before any file is touched and before the journal write: a refused scope leaves the ledger
      // and the canonical slot exactly as they were.
      if (channel === "docx_sync") assertDocxSyncAdoptionScope(adoption);
      if (adoption !== null && adoption.publication_id === null) {
        const publicationId = allocateUniqueId(
          committedAndPreparedPublicationIds(log),
          publicationIdFactory,
          "publication_id_conflict",
          "publication id",
        );
        assertPathAbsent(
          outputDirectory,
          `.pipeline-tmp/${publicationId}`,
          "publication_staging_conflict",
        );
        adoption.publication_id = publicationId;
      }
    }
    if (adoption === null) {
      verifyCommittedArtifactBaseline(record, stepName, environment);
    }

    const pendingWaivers = attemptPendingWaivers(
      step,
      waiverInputs,
      briefDigest,
      waiverIdFactory,
    );

    const preAttemptState = step.state;
    step.state = "running";
    step.attempt += 1;
    step.started_at = startedAt;
    step.updated_at = startedAt;
    step.finished_at = null;
    step.active_attempt = {
      id: attemptId,
      started_at: startedAt,
      expected_revision: step.revision,
      expected_artifacts: structuredClone(step.artifacts),
      input_snapshot: structuredClone(step.published_inputs),
      operation: "revise",
      channel,
      pre_attempt_state: preAttemptState,
      pending_waivers: pendingWaivers,
    };
    step.publication_transaction = null;
    step.error = null;
    step.blocker = null;
    touchFileBackedRecord(log, record, startedAt);
    // The journal write lands before any file copy, so an interrupted adoption has a defined
    // resting state and a retry re-enters idempotently by digest match (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#5-edit-channels-and-transports(b)).
    write(log);

    let stagedPaths = null;
    if (adoption !== null) {
      // Preserve the user's divergent bytes — every divergent kind, the never-staged cv_docx
      // included — before any publication can overwrite them (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#5-edit-channels-and-transports(b)).
      archiveAdoptedDivergence(step, outputDirectory, adoption, adoptionCanonicalBytes);
      stagedPaths = writeAdoptionStagingCopy(
        step,
        outputDirectory,
        adoption.publication_id,
        adoptionCanonicalBytes,
      );
      adoption.phase = "staged";
      touchFileBackedRecord(log, record, startedAt);
      write(log);
    }

    return {
      attempt_id: attemptId,
      ...(adoption
        ? {
            adoption: {
              id: adoption.id,
              entries: structuredClone(adoption.entries),
              phase: adoption.phase,
              publication_id: adoption.publication_id,
              staged_paths: stagedPaths,
            },
          }
        : {}),
      // The exact waiver set this revision's publication will honor: journaled active waivers
      // plus this attempt's pending ones — hand this to the builder's --revision-waivers.
      active_waivers: effectiveRevisionWaivers(step),
      channel,
      input_snapshot: structuredClone(step.active_attempt.input_snapshot),
      open_conflicts: latestCommittedOpenConflicts(step),
      operation: "revise",
      pending_waivers: structuredClone(pendingWaivers),
      pre_attempt_state: preAttemptState,
      process: record,
      sibling_decision_waivers: siblingDecisionWaivers(
        record,
        stepName,
        pinnedBriefEntry(step.published_inputs)?.sha256 ?? null,
      ),
      status: "revision_opened",
      step_name: stepName,
    };
  }, lockOptions);
}

const FILE_BACKED_PUBLICATION_OUTCOMES = Object.freeze(["completed", "blocked"]);

function requirePublicationId(
  value,
  field = "publicationId",
  inputCode = "invalid_publish_step_input",
) {
  const publicationId = requireNonEmptyString(
    value,
    field,
    inputCode,
  );
  if (!isValidProcessLogV3TransactionId(publicationId)) {
    throw new ProcessLogLifecycleError(
      inputCode,
      `${field} must contain only letters, numbers, underscores, and hyphens`,
    );
  }
  return publicationId;
}

function committedAndPreparedPublicationIds(log) {
  const ids = new Set();
  for (const record of log.processes) {
    if (classifyProcessRecord(record) !== "file-backed") continue;
    for (const stepName of fileBackedStepNames) {
      const step = record.steps[stepName];
      if (step.publication_transaction?.id) {
        ids.add(step.publication_transaction.id);
      }
      if (step.adoption_base?.publication_id) {
        ids.add(step.adoption_base.publication_id);
      }
      for (const history of step.attempt_history) {
        if (history.publication_id) ids.add(history.publication_id);
      }
    }
  }
  return ids;
}

function publicationRelativePath(publicationId, basename) {
  return `.pipeline-tmp/${publicationId}/${basename}`;
}

function backupRelativePath(publicationId, kind) {
  return `.pipeline-tmp/${publicationId}/.backup-${kind}`;
}

// Text-authoritative kinds an adoption copies into staging; a divergent cv_docx is journaled for
// the backup proof but never copied — the builder rebuilds it from the adopted cv.json.
const adoptableTextKinds = new Set(["cv_source", "cover_letter"]);

function observedAdoptionDivergence(step, outputDirectory) {
  const divergent = [];
  const canonicalBytes = new Map();
  for (const artifact of step.artifacts) {
    const bytes = readVerifiedFile({
      basePath: outputDirectory.path,
      baseRealPath: outputDirectory.realPath,
      codePrefix: "artifact",
      relativePath: artifact.path,
    });
    canonicalBytes.set(artifact.kind, bytes);
    const digest = sha256Hex(bytes);
    if (bytes.byteLength !== artifact.bytes || digest !== artifact.sha256) {
      divergent.push({
        kind: artifact.kind,
        sha256: digest,
        bytes: bytes.byteLength,
      });
    }
  }
  return { canonicalBytes, divergent };
}

function adoptionEntriesIdentity(entries) {
  return JSON.stringify(
    entries
      .map((entry) => ({ kind: entry.kind, sha256: entry.sha256, bytes: entry.bytes }))
      .sort((left, right) => left.kind.localeCompare(right.kind)),
  );
}

function writeAdoptionStagingCopy(step, outputDirectory, publicationId, canonicalBytes) {
  const directoryRelativePath = `.pipeline-tmp/${publicationId}`;
  const { absolutePath: directoryPath } = outputRelativeAbsolutePath(
    outputDirectory,
    directoryRelativePath,
  );
  try {
    mkdirSync(directoryPath, { recursive: true });
  } catch (error) {
    throw new ProcessLogLifecycleError(
      "output_setup_failed",
      `adoption staging directory could not be created (${error.code ?? "unknown"})`,
    );
  }
  const staged = [];
  for (const artifact of step.artifacts) {
    if (!adoptableTextKinds.has(artifact.kind)) continue;
    const relativePath = `${directoryRelativePath}/${artifact.path}`;
    const { absolutePath: filePath } = outputRelativeAbsolutePath(
      outputDirectory,
      relativePath,
    );
    try {
      writeFileSync(filePath, canonicalBytes.get(artifact.kind));
    } catch (error) {
      throw new ProcessLogLifecycleError(
        "output_setup_failed",
        `adoption staging copy could not be written (${error.code ?? "unknown"})`,
      );
    }
    staged.push(artifact.path);
  }
  return staged;
}

function writeRevisionArchiveFiles(
  outputDirectory,
  archiveId,
  artifacts,
  bytesByKind,
  { onExistingMismatch = "conflict" } = {},
) {
  const directoryRelativePath = `.revisions/${archiveId}`;
  const { absolutePath: directoryPath } = outputRelativeAbsolutePath(
    outputDirectory,
    directoryRelativePath,
  );
  try {
    mkdirSync(directoryPath, { recursive: true });
  } catch (error) {
    throw new ProcessLogLifecycleError(
      "publication_cleanup_failed",
      `revision archive directory could not be created (${error.code ?? "unknown"})`,
    );
  }
  for (const artifact of artifacts) {
    const relativePath = `${directoryRelativePath}/${artifact.path}`;
    const { absolutePath: filePath } = outputRelativeAbsolutePath(
      outputDirectory,
      relativePath,
    );
    let existing = null;
    try {
      existing = readFileSync(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new ProcessLogLifecycleError(
          "publication_cleanup_failed",
          `revision archive could not be inspected (${error.code ?? "unknown"})`,
        );
      }
    }
    if (existing !== null) {
      if (
        existing.byteLength === artifact.bytes
        && sha256Hex(existing) === artifact.sha256
      ) {
        continue;
      }
      // A best-effort completion pass must not wedge attempt opens on a tampered archive copy:
      // it skips the entry and leaves deep validation reporting revision_archive_corrupt. An
      // adoption pass repairs instead — its source bytes are digest-proven against the journaled
      // base and the adoption archive is the bytes' only ledger-known copy once the publication
      // overwrites the canonical slot. A fresh publication write keeps the loud conflict.
      if (onExistingMismatch === "skip") continue;
      if (onExistingMismatch !== "repair") {
        throw new ProcessLogLifecycleError(
          "revision_archive_conflict",
          `${relativePath} does not match its committed archive digest`,
        );
      }
    }
    const bytes = bytesByKind.get(artifact.kind);
    if (
      !bytes
      || bytes.byteLength !== artifact.bytes
      || sha256Hex(bytes) !== artifact.sha256
    ) {
      throw new ProcessLogLifecycleError(
        "revision_archive_conflict",
        `${relativePath} source bytes do not match the committed digest`,
      );
    }
    // Atomic temp-write plus rename: a crash mid-write must never leave a torn file under the
    // archived basename, or the write-once digest check would wedge every later recovery.
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, bytes);
      renameSync(temporaryPath, filePath);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The primary failure below stays authoritative.
      }
      throw new ProcessLogLifecycleError(
        "publication_cleanup_failed",
        `revision archive could not be written (${error.code ?? "unknown"})`,
      );
    }
  }
}

/*
 * Completes the latest committed publication's archive from still-matching canonical bytes.
 * Opening the next attempt is the last moment the committed bytes are guaranteed to exist on
 * disk, so the archive-then-delete crash window (ledger committed, archive not yet written)
 * heals here before any new publication can overwrite the canonical slot (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#6-revision-content-history).
 */
function completeCommittedRevisionArchive(step, outputDirectory) {
  const committed = latestCommittedAttempt(step);
  if (!committed || !Array.isArray(committed.archived_artifacts)) return;
  const bytesByKind = new Map();
  const completable = [];
  for (const archived of committed.archived_artifacts) {
    let bytes;
    try {
      bytes = readVerifiedFile({
        basePath: outputDirectory.path,
        baseRealPath: outputDirectory.realPath,
        codePrefix: "artifact",
        relativePath: archived.path,
      });
    } catch {
      continue;
    }
    if (
      bytes.byteLength === archived.bytes
      && sha256Hex(bytes) === archived.sha256
    ) {
      bytesByKind.set(archived.kind, bytes);
      completable.push(archived);
    }
  }
  if (completable.length > 0) {
    writeRevisionArchiveFiles(
      outputDirectory,
      committed.publication_id,
      completable,
      bytesByKind,
      { onExistingMismatch: "skip" },
    );
  }
}

function archiveAdoptedDivergence(step, outputDirectory, adoption, canonicalBytes) {
  writeRevisionArchiveFiles(
    outputDirectory,
    adoption.id,
    step.artifacts
      .filter((artifact) =>
        adoption.entries.some((entry) => entry.kind === artifact.kind))
      .map((artifact) => {
        const entry = adoption.entries.find(
          (candidate) => candidate.kind === artifact.kind,
        );
        return { ...artifact, sha256: entry.sha256, bytes: entry.bytes };
      }),
    canonicalBytes,
    // A tampered duplicate in the adoption archive must neither wedge re-entry nor survive it:
    // the canonical slot still holds the user's digest-proven bytes, so re-entry repairs the
    // copy before a publication can discard the original.
    { onExistingMismatch: "repair" },
  );
}

/*
 * Journal-time backstop for conflict subject keys: the validator-side composition already digests
 * units that trip the frozen forbidden-shape detector, but a key that would still fail the ledger
 * schema must never reach the commit write — that write runs after the canonical renames, where a
 * validation failure has no clean rollback.
 */
function boundedJournaledSubjectKey(key) {
  const text = String(key);
  if (
    text.length > 0
    && text === text.trim()
    && Buffer.byteLength(text, "utf8") <= 256
    && processLogDiagnosticProblems({ code: "waiver", details: [text] }, "conflict").length === 0
  ) {
    return text;
  }
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function pinnedBriefEntry(snapshot) {
  return snapshot.find((entry) => entry.kind === "application_brief") ?? null;
}

/*
 * The brief coherence guard (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#1-a-new-lifecycle-operation-revise-step-steps-45-only): a light revision is defined only against the exact
 * committed application-brief bytes the material was published from. Validators cannot
 * meaningfully check an edit against a brief the material was not generated from, so a step-3
 * republication with different bytes makes the material a regeneration case for reopen-step.
 */
function assertRevisionBriefCoherent(record, stepName, outputDirectory, pinnedSnapshot) {
  const briefStep = record.steps.map_experience;
  if (briefStep.active_attempt !== null || briefStep.publication_transaction !== null) {
    throw new ProcessLogLifecycleError(
      "brief_attempt_active",
      "revise-step requires map_experience to have no active attempt or prepared publication",
    );
  }
  const pinned = pinnedBriefEntry(pinnedSnapshot);
  if (!pinned) {
    throw new ProcessLogLifecycleError(
      "brief_superseded",
      `${stepName} has no pinned application-brief snapshot`,
    );
  }
  const bytes = readVerifiedFile({
    basePath: outputDirectory.path,
    baseRealPath: outputDirectory.realPath,
    codePrefix: "artifact",
    relativePath: pinned.path,
  });
  if (bytes.byteLength !== pinned.bytes || sha256Hex(bytes) !== pinned.sha256) {
    throw new ProcessLogLifecycleError(
      "brief_superseded",
      `${stepName} was published from a different application-brief; a light revision needs the pinned brief, use reopen-step to regenerate`,
    );
  }
  return bytes;
}

/*
 * Revision finalization derives the step mark by raw digest comparison of the pinned snapshot
 * against current bytes — no live preflight derivation (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#1-a-new-lifecycle-operation-revise-step-steps-45-only): persisting drift keeps the
 * step stale, healed drift (including an upstream identical-bytes republication) clears it.
 */
function deriveRevisionFinalState(stepName, environment, outputDirectory, snapshot) {
  const protectedKinds = protectedInputKinds(stepName);
  for (const entry of snapshot) {
    let bytes;
    try {
      bytes = protectedKinds.has(entry.kind)
        ? readVerifiedFile({
            basePath: environment.workspacePath,
            baseRealPath: environment.workspaceRealPath,
            codePrefix: "input",
            relativePath: entry.path,
          })
        : readVerifiedFile({
            basePath: outputDirectory.path,
            baseRealPath: outputDirectory.realPath,
            codePrefix: "artifact",
            relativePath: entry.path,
          });
    } catch {
      return "stale";
    }
    if (bytes.byteLength !== entry.bytes || sha256Hex(bytes) !== entry.sha256) {
      return "stale";
    }
  }
  // An optional input the snapshot has no entry for was absent at publication; one present now is
  // drift the entries alone cannot show. A snapshot older than the layer inputs pinned none of them.
  if (!snapshotPredatesLayerInputs(stepName, snapshot)) {
    const pinnedKinds = new Set(snapshot.map((entry) => entry.kind));
    for (const contract of protectedInputContracts(stepName, pinnedLetterLanguage(snapshot))) {
      if (!contract.optional || pinnedKinds.has(contract.kind)) continue;
      try {
        if (protectedInputEntry(environment, contract) !== null) return "stale";
      } catch {
        return "stale";
      }
    }
  }
  return "completed";
}

function safeCvDocxPath(cv) {
  const fileName = cv?.fileName;
  if (
    typeof fileName !== "string"
    || !fileName.endsWith(".docx")
    || fileName.startsWith(".")
    || fileName.includes("/")
    || fileName.includes("\\")
  ) {
    throw new ProcessLogLifecycleError(
      "candidate_bundle_invalid",
      "cv.json fileName must be a non-hidden .docx basename",
    );
  }
  return fileName;
}

/*
 * Step 4 publishes bytes the builder produced, but nothing until now proved the candidate was a
 * document at all: any non-empty file named `*.docx` became a canonical CV artifact.
 *
 * The check runs on the buffers this transaction already read and hashed, so the bytes inspected
 * are provably the bytes recorded in `new_artifacts[].sha256` — re-reading the path would reopen
 * the window a concurrent rebuild into the same staging directory can use. It runs here rather than
 * in the shared bundle validator on purpose: the post-rename and recovery revalidations re-read
 * canonical files that `loadCanonicalPublicationBundle` already proves digest-identical, so a pure
 * inspection there would add no information and could only turn an interrupted-but-correct
 * publication into a rollback.
 *
 * It proves package integrity and the builder's layout contract. Pagination, visual fidelity and
 * factual quality keep their separate review gates.
 */
function assertCandidateCvDocxPackage(files) {
  const cvFile = files.get("cv_source");
  const docxFile = files.get("cv_docx");
  if (!cvFile || !docxFile) return;
  let cv;
  try {
    cv = parseJsonArtifact(cvFile.bytes, cvFile.metadata.path);
  } catch {
    // A malformed cv.json is reported with its own diagnostic by the bundle validator.
    return;
  }
  try {
    inspectDocxBytes(docxFile.bytes, cv);
  } catch (error) {
    throw new ProcessLogLifecycleError(
      "candidate_bundle_invalid",
      `generate_cv candidate bundle validation failed: ${docxFile.metadata.path}: ${error.message}`,
    );
  }
}

function metadataForBytes(kind, path, schemaVersion, bytes) {
  if (bytes.byteLength === 0) {
    throw new ProcessLogLifecycleError(
      "candidate_bundle_invalid",
      `${path} must not be empty`,
    );
  }
  return {
    kind,
    path,
    schema_version: schemaVersion,
    sha256: sha256Hex(bytes),
    bytes: bytes.byteLength,
  };
}

function validateArtifactBundleBytes({
  blocker,
  entries,
  environment,
  files,
  operation = null,
  outcome,
  outputDirectory,
  record,
  stepName,
  waivers = [],
}) {
  const expectedProcess = expectedProcessIdentity(record);
  const artifactCache = new Map();
  const protectedInputCache = new Map();
  const revising = operation === "revise";
  /*
   * The standing personal constraints of the candidate layer, for the material being published.
   * Read lazily, because only the two authored materials have any; a checkout without a layer
   * reports none. The letter's length limits are read from the same layer below and have no such
   * absence: without them the letter cannot be measured and is not published.
   *
   * `engineForbidden` is the list the material's own validator owns, so an entry that would make
   * required what that validator forbids is refused here rather than handed back as two refusals
   * that contradict each other. The CV has no such engine list — every exclusion it checks comes
   * from the brief — so there is no pair to be unsatisfiable and nothing to pass.
   */
  const readCandidateConstraints = (material, engineForbidden, language = null) => {
    try {
      return candidateConstraintsFor({
        engineForbidden,
        language,
        material,
        root: candidateRootFor(environment.workspacePath),
      });
    } catch (error) {
      if (!(error instanceof CandidateError)) throw error;
      errors.push(`candidate layer: ${error.code}: ${error.message}`);
      return [];
    }
  };
  const conflicts = [];
  const notices = [];
  let errors = [];

  // A revision accepts the committed brief by pinned digest without transitively re-validating
  // map_experience against live bytes (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#1-a-new-lifecycle-operation-revise-step-steps-45-only). Knowledge drift neither blocks nor clears.
  const readPinnedBrief = () => {
    const briefBytes = assertRevisionBriefCoherent(
      record,
      stepName,
      outputDirectory,
      record.steps[stepName].published_inputs,
    );
    return parseJsonArtifact(briefBytes, "application-brief.json");
  };

  if (stepName === "get_vacancy") {
    const vacancyFile = files.get("vacancy");
    const jobDescriptionFile = files.get("job_description");
    const vacancy = parseJsonArtifact(
      vacancyFile.bytes,
      vacancyFile.metadata.path,
    );
    errors = validateVacancy(
      vacancy,
      {
        expectedProcess,
        expectedSchemaVersion: vacancyFile.metadata.schema_version,
        languages: candidateVacancyLanguages(environment),
        markets: candidateVacancyMarkets(environment),
        jobDescriptionBytes: jobDescriptionFile.bytes,
        outcome,
      },
    );
    if (
      outcome === "blocked"
      && !vacancy.ambiguities?.some(
        (ambiguity) =>
          ambiguity?.blocking === true
          && ambiguity?.code === blocker?.code,
      )
    ) {
      errors.push("blocker.code must resolve to a blocking vacancy ambiguity");
    }
  } else if (stepName === "research_company") {
    const vacancyBundle = verifiedArtifactBundle(
      record,
      "get_vacancy",
      environment,
      outputDirectory,
      artifactCache,
      protectedInputCache,
    );
    const researchFile = files.get("company_research");
    const research = parseJsonArtifact(
      researchFile.bytes,
      researchFile.metadata.path,
    );
    errors = validateCompanyResearch(
      research,
      {
        expectedProcess,
        languages: candidateVacancyLanguages(environment),
        markets: candidateVacancyMarkets(environment),
        expectedSchemaVersion: researchFile.metadata.schema_version,
        vacancyBytes: vacancyBundle.files.get("vacancy")?.bytes,
        jobDescriptionBytes: vacancyBundle.files.get("job_description")?.bytes,
        outcome,
      },
    );
    if (
      outcome === "blocked"
      && !research.verifyGate?.unrecoverableGaps?.some(
        (gap) => gap?.code === blocker?.code,
      )
    ) {
      errors.push("blocker.code must resolve to a Verify Gate unrecoverable gap");
    }
  } else if (stepName === "map_experience") {
    if (outcome !== "completed") {
      throw new ProcessLogLifecycleError(
        "publication_outcome_unsupported",
        "map_experience does not define a blocked artifact capture bundle",
      );
    }
    const vacancyBundle = verifiedArtifactBundle(
      record,
      "get_vacancy",
      environment,
      outputDirectory,
      artifactCache,
      protectedInputCache,
    );
    const researchBundle = verifiedArtifactBundle(
      record,
      "research_company",
      environment,
      outputDirectory,
      artifactCache,
      protectedInputCache,
    );
    currentProtectedInputs(environment, "map_experience", protectedInputCache);
    const briefFile = files.get("application_brief");
    errors = validateApplicationBrief(
      parseJsonArtifact(briefFile.bytes, briefFile.metadata.path),
      {
        expectedProcess,
        expectedSchemaVersion: briefFile.metadata.schema_version,
        languages: candidateVacancyLanguages(environment),
        markets: candidateVacancyMarkets(environment),
        vacancyBytes: vacancyBundle.files.get("vacancy")?.bytes,
        jobDescriptionBytes: vacancyBundle.files.get("job_description")?.bytes,
        companyResearchBytes: researchBundle.files.get("company_research")?.bytes,
        candidateProfileBytes:
          protectedInputCache.get("candidate_profile")?.bytes,
        candidateLeversBytes:
          protectedInputCache.get("candidate_levers")?.bytes,
        requireInputBytes: true,
      },
    );
  } else if (stepName === "generate_cv") {
    if (outcome !== "completed") {
      throw new ProcessLogLifecycleError(
        "publication_outcome_unsupported",
        "generate_cv failures or blockers must preserve the committed CV bundle",
      );
    }
    const brief = revising
      ? readPinnedBrief()
      : parseJsonArtifact(
          verifiedArtifactBundle(
            record,
            "map_experience",
            environment,
            outputDirectory,
            artifactCache,
            protectedInputCache,
          ).files.get("application_brief").bytes,
          "application-brief.json",
        );
    const cvFile = files.get("cv_source");
    const docxFile = files.get("cv_docx");
    const cv = parseJsonArtifact(cvFile.bytes, cvFile.metadata.path);
    if (safeCvDocxPath(cv) !== docxFile.metadata.path) {
      errors.push("cv.json fileName must match the candidate cv_docx path");
    }
    const cvConstraints = readCandidateConstraints("cv", []);
    const preflight = runCvPreflight(
      cv,
      brief,
      revising ? { constraints: cvConstraints, waivers } : { constraints: cvConstraints },
    );
    // A candidate-layer finding refuses in both modes. It is not a brief decision, so the
    // revision's classify-instead-of-fail rule does not reach it: a personal ban a re-publication
    // could ignore would not be a ban.
    errors.push(...preflight.candidateErrors);
    // Every other preflight failure is brief-coupled; in revision mode the deterministic gate
    // classifies instead of failing, so the findings become reported conflicts (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#3-conflicts-and-waivers).
    if (revising) {
      conflicts.push(...preflight.conflicts);
      notices.push(...preflight.notices);
    } else {
      errors.push(...preflight.errors.map((error) => `cv preflight: ${error}`));
    }
  } else if (stepName === "write_cover_letter") {
    if (outcome !== "completed") {
      throw new ProcessLogLifecycleError(
        "publication_outcome_unsupported",
        "write_cover_letter does not define a blocked artifact capture bundle",
      );
    }
    const brief = revising
      ? readPinnedBrief()
      : parseJsonArtifact(
          verifiedArtifactBundle(
            record,
            "map_experience",
            environment,
            outputDirectory,
            artifactCache,
            protectedInputCache,
          ).files.get("application_brief").bytes,
          "application-brief.json",
        );
    const letterFile = files.get("cover_letter");
    // The limits come from the layer like the constraints do, and a layer that cannot supply them
    // is reported the same way: the letter cannot be measured, so it is not published.
    let limits = null;
    let languages = null;
    try {
      limits = coverLetterLimitsFor({ root: candidateRootFor(environment.workspacePath) });
      languages = coverLetterLanguagesFor({ root: candidateRootFor(environment.workspacePath) });
    } catch (error) {
      if (!(error instanceof CandidateError)) throw error;
      errors.push(`candidate layer: ${error.code}: ${error.message}`);
    }
    if (limits !== null && languages !== null) {
      const findings = validateCoverLetterFindings(letterFile.bytes, brief, {
        constraints: readCandidateConstraints(
          "cover_letter",
          coverLetterEngineForbidden,
          brief?.role?.vacancyLanguage ?? null,
        ),
        languages,
        limits,
        waivers,
      });
      errors.push(...findings.errors, ...findings.candidateErrors);
      if (revising) {
        conflicts.push(...findings.conflicts);
      } else {
        // Outside a revision a brief-coupled finding is still a hard refusal: only the notices a
        // waiver produced are reported. The message mapping is what `validateCoverLetter` does.
        errors.push(...findings.conflicts.map((conflict) => conflict.message));
      }
      notices.push(...findings.notices);
    }
  }

  if (errors.length > 0) {
    throw new ProcessLogLifecycleError(
      "candidate_bundle_invalid",
      `${stepName} candidate bundle validation failed: ${errors.join("; ")}`,
    );
  }
  return {
    conflicts,
    entries: canonicalSnapshot(entries),
    notices,
  };
}

function loadCandidatePublicationBundle({
  blocker,
  environment,
  operation = null,
  outcome,
  outputDirectory,
  publicationId,
  record,
  stepName,
  waivers = [],
}) {
  if (
    outcome === "blocked"
    && !["get_vacancy", "research_company"].includes(stepName)
  ) {
    throw new ProcessLogLifecycleError(
      "publication_outcome_unsupported",
      `${stepName} does not define a blocked artifact capture bundle`,
    );
  }

  const contracts = fileBackedArtifactContractsForStep(stepName);
  const descriptors = contracts
    .filter((contract) => contract.path !== null)
    .map((contract) => ({
      ...contract,
      canonical_path: contract.path,
      candidate_path: publicationRelativePath(publicationId, contract.path),
    }));

  if (stepName === "generate_cv") {
    const sourceDescriptor = descriptors.find((descriptor) => descriptor.kind === "cv_source");
    const sourceBytes = readVerifiedFile({
      basePath: outputDirectory.path,
      baseRealPath: outputDirectory.realPath,
      codePrefix: "candidate",
      relativePath: sourceDescriptor.candidate_path,
    });
    const cv = parseJsonArtifact(sourceBytes, sourceDescriptor.candidate_path);
    const docxPath = safeCvDocxPath(cv);
    descriptors.push({
      kind: "cv_docx",
      path: null,
      schema_version: null,
      canonical_path: docxPath,
      candidate_path: publicationRelativePath(publicationId, docxPath),
    });
  }

  const files = new Map();
  const entries = [];
  for (const descriptor of descriptors) {
    const bytes = readVerifiedFile({
      basePath: outputDirectory.path,
      baseRealPath: outputDirectory.realPath,
      codePrefix: "candidate",
      relativePath: descriptor.candidate_path,
    });
    const metadata = metadataForBytes(
      descriptor.kind,
      descriptor.canonical_path,
      descriptor.schema_version,
      bytes,
    );
    entries.push(metadata);
    files.set(descriptor.kind, {
      bytes,
      candidate_path: descriptor.candidate_path,
      metadata,
    });
  }

  if (stepName === "generate_cv") assertCandidateCvDocxPackage(files);

  const validated = validateArtifactBundleBytes({
    blocker,
    entries,
    environment,
    files,
    operation,
    outcome,
    outputDirectory,
    record,
    stepName,
    waivers,
  });
  return {
    conflicts: validated.conflicts,
    entries: validated.entries,
    files,
    notices: validated.notices,
  };
}

/*
 * A waiver supplied at publication is journaled only if the published bytes needed it (task 145).
 * A draft rewritten below the default limit after the user approved a longer one would otherwise
 * leave an active approval behind, silently raising the ceiling of every later revision of this
 * letter — the approval a publication does not exercise is not a decision about that letter.
 *
 * A revision is out of scope by construction: its `decision` waivers address a brief decision no
 * deterministic check can see, so they never produce a notice and are journaled regardless.
 */
function assertAttemptWaiversApplied(activeAttempt, notices, operation) {
  if (operation === "revise") return;
  const pending = activeAttempt.pending_waivers ?? [];
  if (pending.length === 0) return;
  const applied = new Set((notices ?? []).map((notice) => notice.waiver_id));
  const unused = pending.filter((waiver) => !applied.has(waiver.id));
  if (unused.length > 0) {
    throw new ProcessLogLifecycleError(
      "waiver_not_applicable",
      `the staged bundle does not need the supplied waiver(s): ${unused.map((waiver) => waiver.subject.key).join(", ")}`,
    );
  }
}

function assertPublicationBaseline(step, candidateEntries, stepName) {
  const activeAttempt = step.active_attempt;
  if (
    activeAttempt.expected_revision !== step.revision
    || bundleIdentity(activeAttempt.expected_artifacts) !== bundleIdentity(step.artifacts)
  ) {
    throw new ProcessLogLifecycleError(
      "stale_writer",
      `${stepName} committed baseline no longer matches the active attempt`,
    );
  }
  if (step.revision === 0) return;
  const expected = canonicalSnapshot(step.artifacts);
  const candidate = canonicalSnapshot(candidateEntries);
  const expectedPaths = expected.map((entry) => [entry.kind, entry.path]);
  const candidatePaths = candidate.map((entry) => [entry.kind, entry.path]);
  if (
    JSON.stringify(expectedPaths) !== JSON.stringify(candidatePaths)
    || expected.some((entry, index) => !fileBackedArtifactSchemaVersionMayBecome(
      stepName,
      entry.kind,
      entry.schema_version,
      candidate[index].schema_version,
    ))
  ) {
    throw new ProcessLogLifecycleError(
      "artifact_path_revision_conflict",
      `${stepName} revisions must preserve the committed artifact kinds and canonical paths`,
    );
  }
}

function assertPublicationInputsCurrent(record, stepName, environment, expectedSnapshot) {
  let current;
  try {
    current = preflightFileBackedStepRecord(record, stepName, environment).input_snapshot;
  } catch (error) {
    const inputError = new ProcessLogLifecycleError(
      "inputs_changed",
      `${stepName} inputs cannot be revalidated (${error.code ?? "invalid"})`,
    );
    inputError.causeCode = error.code ?? "invalid";
    throw inputError;
  }
  if (!snapshotStillCurrent(stepName, expectedSnapshot, current)) {
    throw new ProcessLogLifecycleError(
      "inputs_changed",
      `${stepName} inputs changed after the attempt began`,
    );
  }
}

function outputRelativeAbsolutePath(outputDirectory, relativePath) {
  const absolutePath = resolve(outputDirectory.path, ...relativePath.split("/"));
  const expectedRealPath = resolve(
    outputDirectory.realPath,
    ...relativePath.split("/"),
  );
  if (
    !pathIsWithin(outputDirectory.path, absolutePath)
    || !pathIsWithin(outputDirectory.realPath, expectedRealPath)
  ) {
    throw new ProcessLogLifecycleError(
      "publication_path_invalid",
      `${relativePath} resolves outside the reserved output directory`,
    );
  }
  return { absolutePath, expectedRealPath };
}

function inspectPublicationFile(outputDirectory, relativePath, metadata) {
  try {
    const bytes = readVerifiedFile({
      basePath: outputDirectory.path,
      baseRealPath: outputDirectory.realPath,
      codePrefix: "publication",
      relativePath,
    });
    return {
      bytes,
      status:
        bytes.byteLength === metadata.bytes
        && sha256Hex(bytes) === metadata.sha256
          ? "match"
          : "conflict",
    };
  } catch (error) {
    if (error.code === "publication_missing") return { status: "missing" };
    return { status: "conflict" };
  }
}

function assertPathAbsent(outputDirectory, relativePath, code) {
  const { absolutePath } = outputRelativeAbsolutePath(outputDirectory, relativePath);
  try {
    lstatSync(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new ProcessLogLifecycleError(
      code,
      `${relativePath} cannot be inspected (${error.code ?? "unknown"})`,
    );
  }
  throw new ProcessLogLifecycleError(code, `${relativePath} is already occupied`);
}

function publicationFiles(candidateBundle, oldArtifacts, publicationId) {
  const oldByKind = new Map(oldArtifacts.map((artifact) => [artifact.kind, artifact]));
  return [...candidateBundle.files.entries()].map(([kind, file]) => ({
    kind,
    canonical_path: file.metadata.path,
    candidate_path: file.candidate_path,
    backup_path: oldByKind.has(kind)
      ? backupRelativePath(publicationId, kind)
      : null,
  }));
}

function assertPublicationPathsReady(outputDirectory, transaction) {
  const oldByKind = new Map(
    transaction.old_artifacts.map((artifact) => [artifact.kind, artifact]),
  );
  for (const file of transaction.files) {
    if (file.backup_path !== null) {
      assertPathAbsent(
        outputDirectory,
        file.backup_path,
        "publication_staging_conflict",
      );
    }
    if (!oldByKind.has(file.kind)) {
      assertPathAbsent(
        outputDirectory,
        file.canonical_path,
        "artifact_path_collision",
      );
    }
  }
}

function invokePublicationFailpoint(failAt, boundary) {
  const configuredBoundary =
    typeof failAt === "string" ? failAt : failAt?.boundary;
  if (configuredBoundary !== boundary) return;
  const error = new ProcessLogLifecycleError(
    failAt?.crash === false
      ? "simulated_publication_failure"
      : "simulated_publication_crash",
    `simulated publication interruption at ${boundary}`,
  );
  error.simulatedCrash = failAt?.crash !== false;
  throw error;
}

function renamePublicationFile(outputDirectory, fromRelativePath, toRelativePath) {
  const from = outputRelativeAbsolutePath(outputDirectory, fromRelativePath);
  const to = outputRelativeAbsolutePath(outputDirectory, toRelativePath);
  renameSync(from.absolutePath, to.absolutePath);
}

function loadCanonicalPublicationBundle(
  transaction,
  outputDirectory,
) {
  const files = new Map();
  for (const artifact of transaction.new_artifacts) {
    const bytes = readVerifiedFile({
      basePath: outputDirectory.path,
      baseRealPath: outputDirectory.realPath,
      codePrefix: "publication",
      relativePath: artifact.path,
    });
    if (
      bytes.byteLength !== artifact.bytes
      || sha256Hex(bytes) !== artifact.sha256
    ) {
      throw new ProcessLogLifecycleError(
        "publication_bundle_invalid",
        `${artifact.path} does not match the prepared digest and size`,
      );
    }
    files.set(artifact.kind, { bytes, metadata: artifact });
  }
  return files;
}

function appendPublicationHistory(step, stepName, transaction, finishedAt, openConflicts) {
  const entry = {
    attempt: step.attempt,
    outcome: transaction.intended_outcome,
    started_at: step.active_attempt.started_at,
    finished_at: finishedAt,
    input_snapshot: structuredClone(transaction.input_snapshot),
    error_code:
      transaction.intended_outcome === "blocked"
        ? transaction.blocker.code
        : null,
    publication_id: transaction.id,
  };
  if (transaction.operation === "revise") {
    entry.operation = "revise";
    entry.channel = step.active_attempt.channel;
    entry.pre_attempt_state = step.active_attempt.pre_attempt_state;
    entry.open_conflicts = structuredClone(openConflicts ?? []);
  }
  if (isMaterialStep(stepName)) {
    entry.archived_artifacts = structuredClone(transaction.new_artifacts);
  }
  step.attempt_history.push(entry);
}

/*
 * A publication commits the waivers its own attempt carried: a revision's decisions supplied at
 * `revise-step`, or the letter's word-limit approval supplied at `publish-step` (task 145). Before
 * the commit they are the attempt's pending set and die with it, so an attempt that closes without
 * publishing journals nothing.
 */
function journalAttemptWaivers(step, timestamp) {
  const pendingWaivers = step.active_attempt?.pending_waivers ?? [];
  if (pendingWaivers.length === 0) return;
  step.waivers = [
    ...(step.waivers ?? []),
    ...pendingWaivers.map((waiver) => ({
      id: waiver.id,
      created_at: timestamp,
      brief_digest: waiver.brief_digest,
      subject: structuredClone(waiver.subject),
      status: "active",
      ...(waiver.note ? { note: waiver.note } : {}),
    })),
  ];
}

function applyPreparedPublicationFinalization({
  finalState = null,
  log,
  openConflicts = null,
  record,
  stepName,
  timestamp,
}) {
  const step = record.steps[stepName];
  const transaction = step.publication_transaction;
  const changedBundle =
    bundleIdentity(transaction.old_artifacts)
    !== bundleIdentity(transaction.new_artifacts);
  step.state = finalState ?? transaction.intended_outcome;
  step.revision = changedBundle ? transaction.old_revision + 1 : transaction.old_revision;
  step.updated_at = timestamp;
  step.finished_at = timestamp;
  step.published_inputs = structuredClone(transaction.input_snapshot);
  step.artifacts = structuredClone(transaction.new_artifacts);
  appendPublicationHistory(step, stepName, transaction, timestamp, openConflicts);
  if (transaction.operation !== "revise" && isMaterialStep(stepName)) {
    // An explicit re-authoring rewrites the material from scratch, so waivers about edits of
    // the previous version lose their referent regardless of the resulting bytes
    // (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#2-ledger-schema-event-v3--v4; PD-003 point 6 (docs/adr/0015-lightweight-post-review-revision.md#pd-003-the-product-decision-this-record-implements): waivers are not inherited across an explicit restart). This runs
    // before the attempt's own waivers are journaled, or the publication would supersede the
    // approval it was given (task 145).
    supersedeStepWaivers(step);
  }
  if (isMaterialStep(stepName)) {
    journalAttemptWaivers(step, timestamp);
  }
  if (stepName === "map_experience") {
    const oldBrief = transaction.old_artifacts.find(
      (artifact) => artifact.kind === "application_brief",
    );
    const newBrief = transaction.new_artifacts.find(
      (artifact) => artifact.kind === "application_brief",
    );
    if (oldBrief?.sha256 !== newBrief?.sha256) {
      for (const materialStepName of fileBackedMaterialStepNames) {
        supersedeStepWaivers(record.steps[materialStepName]);
      }
    }
  }
  if (isMaterialStep(stepName) && step.adoption_base) {
    delete step.adoption_base;
  }
  step.active_attempt = null;
  step.publication_transaction = null;
  step.error = null;
  step.blocker =
    transaction.intended_outcome === "blocked"
      ? {
          ...structuredClone(transaction.blocker),
          at: timestamp,
        }
      : null;
  touchFileBackedRecord(log, record, timestamp);
}

function finalizePreparedPublication({
  failAt,
  finalState = null,
  log,
  openConflicts = null,
  record,
  stepName,
  timestamp,
  write,
}) {
  const recordIndex = log.processes.indexOf(record);
  const committedLog = structuredClone(log);
  const committedRecord = committedLog.processes[recordIndex];
  applyPreparedPublicationFinalization({
    finalState,
    log: committedLog,
    openConflicts,
    record: committedRecord,
    stepName,
    timestamp,
  });
  try {
    invokePublicationFailpoint(failAt, "during_ledger_commit_write");
    write(committedLog);
  } catch {
    throw new ProcessLogLifecycleError(
      "publication_ledger_write_failed",
      "publication ledger commit failed; run tokened reconcile",
    );
  }
  applyPreparedPublicationFinalization({
    finalState,
    log,
    openConflicts,
    record,
    stepName,
    timestamp,
  });
}

function removeCanonicalPathForRestore(outputDirectory, relativePath) {
  const { absolutePath } = outputRelativeAbsolutePath(outputDirectory, relativePath);
  let stats;
  try {
    stats = lstatSync(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    throw new ProcessLogLifecycleError(
      "publication_recovery_conflict",
      `${relativePath} became a directory during publication recovery`,
    );
  }
  unlinkSync(absolutePath);
}

function transactionDirectoryPath(outputDirectory, publicationId) {
  return outputRelativeAbsolutePath(
    outputDirectory,
    `.pipeline-tmp/${publicationId}`,
  );
}

function removeTransactionDirectory(outputDirectory, publicationId) {
  const { absolutePath, expectedRealPath } = transactionDirectoryPath(
    outputDirectory,
    publicationId,
  );
  let stats;
  try {
    stats = lstatSync(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw new ProcessLogLifecycleError(
      "publication_cleanup_failed",
      `cannot inspect transaction directory (${error.code ?? "unknown"})`,
    );
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ProcessLogLifecycleError(
      "publication_cleanup_failed",
      "transaction path must be a non-symlink directory",
    );
  }
  let actualRealPath;
  try {
    actualRealPath = realpathSync(absolutePath);
  } catch (error) {
    throw new ProcessLogLifecycleError(
      "publication_cleanup_failed",
      `cannot resolve transaction directory (${error.code ?? "unknown"})`,
    );
  }
  if (actualRealPath !== expectedRealPath) {
    throw new ProcessLogLifecycleError(
      "publication_cleanup_failed",
      "transaction directory resolves through an unexpected filesystem path",
    );
  }
  rmSync(absolutePath, { recursive: true });
  return true;
}

function closePreparedPublicationAsFailed({
  diagnostic,
  log,
  record,
  stepName,
  timestamp,
  write,
}) {
  closeRunningStepAsFailed({
    diagnostic,
    log,
    record,
    stepName,
    timestamp,
  });
  write(log);
}

function rollbackPreparedPublication({
  diagnostic,
  log,
  outputDirectory,
  record,
  stepName,
  timestamp,
  write,
}) {
  const step = record.steps[stepName];
  const transaction = step.publication_transaction;
  const fileByKind = new Map(transaction.files.map((file) => [file.kind, file]));
  // Inside a journaled adoption the old-bundle proof for an adopted kind is the journaled
  // divergent digest, not the committed one (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#5-edit-channels-and-transports(b)).
  const expectedOldArtifact = (oldArtifact) => {
    const adopted = transaction.adopted_artifacts?.find(
      (entry) => entry.kind === oldArtifact.kind,
    );
    return adopted
      ? { ...oldArtifact, sha256: adopted.sha256, bytes: adopted.bytes }
      : oldArtifact;
  };

  if (transaction.old_revision > 0) {
    const recoverySources = new Map();
    for (const committedOldArtifact of transaction.old_artifacts) {
      const oldArtifact = expectedOldArtifact(committedOldArtifact);
      const file = fileByKind.get(oldArtifact.kind);
      const backup = inspectPublicationFile(
        outputDirectory,
        file.backup_path,
        oldArtifact,
      );
      const canonical = inspectPublicationFile(
        outputDirectory,
        file.canonical_path,
        oldArtifact,
      );
      if (backup.status === "match") {
        recoverySources.set(oldArtifact.kind, "backup");
      } else if (canonical.status === "match") {
        recoverySources.set(oldArtifact.kind, "canonical");
      } else {
        return false;
      }
    }

    for (const oldArtifact of transaction.old_artifacts) {
      if (recoverySources.get(oldArtifact.kind) !== "backup") continue;
      const file = fileByKind.get(oldArtifact.kind);
      removeCanonicalPathForRestore(outputDirectory, file.canonical_path);
      renamePublicationFile(
        outputDirectory,
        file.backup_path,
        file.canonical_path,
      );
    }
    for (const committedOldArtifact of transaction.old_artifacts) {
      const oldArtifact = expectedOldArtifact(committedOldArtifact);
      if (
        inspectPublicationFile(outputDirectory, oldArtifact.path, oldArtifact).status
        !== "match"
      ) {
        return false;
      }
    }
  } else {
    for (const newArtifact of transaction.new_artifacts) {
      const file = fileByKind.get(newArtifact.kind);
      const canonical = inspectPublicationFile(
        outputDirectory,
        file.canonical_path,
        newArtifact,
      );
      const candidate = inspectPublicationFile(
        outputDirectory,
        file.candidate_path,
        newArtifact,
      );
      if (canonical.status === "conflict" || candidate.status === "conflict") {
        return false;
      }
    }
    for (const newArtifact of transaction.new_artifacts) {
      const file = fileByKind.get(newArtifact.kind);
      if (
        inspectPublicationFile(outputDirectory, file.canonical_path, newArtifact).status
        === "match"
      ) {
        removeCanonicalPathForRestore(outputDirectory, file.canonical_path);
      }
    }
  }

  removeTransactionDirectory(outputDirectory, transaction.id);
  closePreparedPublicationAsFailed({
    diagnostic,
    log,
    record,
    stepName,
    timestamp,
    write,
  });
  return true;
}

function recoverPreparedPublication({
  environment,
  failAt,
  log,
  outputDirectory,
  preferNew,
  record,
  stepName,
  timestamp,
  write,
}) {
  const step = record.steps[stepName];
  const transaction = step.publication_transaction;
  const revising = transaction.operation === "revise";
  const completeNewBundle = transaction.new_artifacts.every(
    (artifact) =>
      inspectPublicationFile(outputDirectory, artifact.path, artifact).status
      === "match",
  );
  let recoveryDiagnostic = {
    code: "publication_interrupted",
    message: "The publication was interrupted and rolled back to the last proven state.",
    retryable: true,
    details: [`publication: ${transaction.id}`],
  };

  if (preferNew && completeNewBundle) {
    let ledgerCommitted = false;
    try {
      if (revising) {
        assertRevisionBriefCoherent(
          record,
          stepName,
          outputDirectory,
          transaction.input_snapshot,
        );
      } else {
        assertPublicationInputsCurrent(
          record,
          stepName,
          environment,
          transaction.input_snapshot,
        );
      }
      const files = loadCanonicalPublicationBundle(transaction, outputDirectory);
      const validated = validateArtifactBundleBytes({
        blocker: transaction.blocker,
        entries: transaction.new_artifacts,
        environment,
        files,
        operation: transaction.operation ?? null,
        outcome: transaction.intended_outcome,
        outputDirectory,
        record,
        stepName,
        waivers: effectivePublicationWaivers(step, transaction.operation ?? null),
      });
      const finalState = revising
        ? deriveRevisionFinalState(
            stepName,
            environment,
            outputDirectory,
            transaction.input_snapshot,
          )
        : null;
      finalizePreparedPublication({
        failAt,
        finalState,
        log,
        openConflicts: revising
          ? validated.conflicts.map((conflict) => ({
              subject: {
                kind: conflict.subject.kind,
                key: boundedJournaledSubjectKey(conflict.subject.key),
              },
              code: conflict.code,
            }))
          : null,
        record,
        stepName,
        timestamp,
        write,
      });
      ledgerCommitted = true;
      if (isMaterialStep(stepName)) {
        writeRevisionArchiveFiles(
          outputDirectory,
          transaction.id,
          transaction.new_artifacts,
          new Map(
            [...files.entries()].map(([kind, file]) => [kind, file.bytes]),
          ),
        );
      }
      removeTransactionDirectory(outputDirectory, transaction.id);
      return {
        publication_id: transaction.id,
        ...(revising ? { state: record.steps[stepName].state } : {}),
        status: transaction.intended_outcome,
      };
    } catch (error) {
      // Post-commit cleanup failures must never fall into the old-bundle rollback: the new
      // bundle is already the committed truth, and the nulled transaction would crash it anyway.
      if (error.code === "publication_ledger_write_failed" || ledgerCommitted) throw error;
      recoveryDiagnostic = {
        code: ["inputs_changed", "brief_superseded", "brief_attempt_active"].includes(error.code)
          ? error.code
          : "publication_validation_failed",
        message: error.code === "inputs_changed"
          ? "The step inputs changed while the publication was running."
          : ["brief_superseded", "brief_attempt_active"].includes(error.code)
            ? "The Step 3 brief no longer matches the revision's pinned snapshot."
            : "The prepared bundle failed revalidation during recovery.",
        retryable: true,
        details: [`recovery error: ${error.code ?? "invalid"}`],
      };
    }
  }

  if (rollbackPreparedPublication({
    diagnostic: recoveryDiagnostic,
    log,
    outputDirectory,
    record,
    stepName,
    timestamp,
    write,
  })) {
    return {
      publication_id: transaction.id,
      status: "rolled_back",
    };
  }
  throw new ProcessLogLifecycleError(
    "publication_recovery_conflict",
    `cannot prove a complete old or new bundle for publication ${transaction.id}`,
  );
}

export function publishFileBackedStepV3(
  logPath,
  input,
  {
    clock = () => new Date().toISOString(),
    failAt = null,
    lockOptions,
    outputRoot,
    waiverIdFactory = () => `waiver_${randomUUID()}`,
    workspaceRoot,
  } = {},
) {
  assertExactKeys(
    input,
    ["selector", "stepName", "attemptId", "publicationId", "outcome", "blocker", "waivers"],
    "invalid_publish_step_input",
    "publish-step input",
  );
  const stepName = requireStepName(input.stepName);
  const attemptId = requireNonEmptyString(
    input.attemptId,
    "attemptId",
    "invalid_publish_step_input",
  );
  const publicationId = requirePublicationId(input.publicationId);
  const outcome = requireNonEmptyString(
    input.outcome,
    "outcome",
    "invalid_publish_step_input",
  );
  if (!FILE_BACKED_PUBLICATION_OUTCOMES.includes(outcome)) {
    throw new ProcessLogLifecycleError(
      "invalid_publish_step_input",
      `outcome must be one of: ${FILE_BACKED_PUBLICATION_OUTCOMES.join(", ")}`,
    );
  }
  const blocker = outcome === "blocked"
    ? normalizeBlockerDiagnosticInput(input.blocker)
    : null;
  if (outcome === "completed" && input.blocker !== null) {
    throw new ProcessLogLifecycleError(
      "invalid_publish_step_input",
      "blocker must be null for a completed publication",
    );
  }
  const environment = resolveOutputEnvironment(workspaceRoot, outputRoot);
  const waiverInputs = normalizeWaiverInputs(input.waivers, () => candidateLetterLimits(environment));

  return withLogV3Lock(logPath, ({ log, write }) => {
    const record = resolveFileBackedProcessV3(log, input.selector);
    const step = record.steps[stepName];
    const activeAttempt = requireMatchingActiveAttempt(
      step,
      stepName,
      attemptId,
      "publish-step",
    );
    const outputDirectory = selectedOutputDirectory(environment, record);
    const operation = activeAttempt.operation === "revise" ? "revise" : null;
    const adoptionBase =
      isMaterialStep(stepName)
      && step.adoption_base
      && step.adoption_base.attempt_id === attemptId
        ? step.adoption_base
        : null;
    if (
      committedAndPreparedPublicationIds(log).has(publicationId)
      && adoptionBase?.publication_id !== publicationId
    ) {
      throw new ProcessLogLifecycleError(
        "publication_id_conflict",
        `publication id is already owned: ${publicationId}`,
      );
    }
    assertPublishStepWaiverScope(
      waiverInputs,
      stepName,
      operation,
      () => candidateLetterLimits(environment),
    );
    if (waiverInputs.length > 0) {
      const briefEntry = pinnedBriefEntry(activeAttempt.input_snapshot);
      if (briefEntry === null) {
        throw new ProcessLogLifecycleError(
          "invalid_publish_step_input",
          "publish-step waivers require the attempt to pin an application brief",
        );
      }
      // Nothing is persisted until the transaction's journal write below, so a refusal between
      // here and it leaves the ledger exactly as it was.
      activeAttempt.pending_waivers = attemptPendingWaivers(
        step,
        waiverInputs,
        briefEntry.sha256,
        waiverIdFactory,
      );
    }
    const publicationWaivers = effectivePublicationWaivers(step, operation);
    // The revalidation below reads the layer's language names and markets. A layer that cannot
    // supply them is refused here, under its own code and before the attempt is touched: inside
    // the block below it would close the attempt as if its inputs had changed.
    candidateVacancyLanguages(environment);
    candidateVacancyMarkets(environment);

    try {
      if (operation === "revise") {
        // The brief coherence guard is re-verified under the ledger lock at publication
        // (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#1-a-new-lifecycle-operation-revise-step-steps-45-only); live protected-input drift is deliberately not consulted.
        assertRevisionBriefCoherent(
          record,
          stepName,
          outputDirectory,
          activeAttempt.input_snapshot,
        );
      } else {
        assertPublicationInputsCurrent(
          record,
          stepName,
          environment,
          activeAttempt.input_snapshot,
        );
      }
    } catch (error) {
      const failedAt = recordMutationTimestamp(clock, log, record);
      const revisionRefusal = operation === "revise";
      closeRunningStepAsFailed({
        diagnostic: revisionRefusal
          ? {
              code: ["brief_superseded", "brief_attempt_active"].includes(error.code)
                ? error.code
                : "brief_superseded",
              message: "The Step 3 brief no longer matches the revision's pinned snapshot.",
              retryable: false,
              details: [`revision error: ${error.code ?? "brief_mismatch"}`],
            }
          : {
              code: "inputs_changed",
              message: "The step inputs changed after the attempt began.",
              retryable: true,
              details: [`preflight error: ${error.code ?? "snapshot_mismatch"}`],
            },
        log,
        record,
        stepName,
        timestamp: failedAt,
      });
      write(log);
      throw revisionRefusal
        ? new ProcessLogLifecycleError(
            error.code === "brief_attempt_active" ? "brief_attempt_active" : "brief_superseded",
            `${stepName} revision rejected because the pinned brief is no longer committed`,
          )
        : new ProcessLogLifecycleError(
            "inputs_changed",
            `${stepName} publication rejected because its inputs changed`,
          );
    }
    verifyCommittedArtifactBaseline(record, stepName, environment, { adoptionBase });

    const candidateBundle = loadCandidatePublicationBundle({
      blocker,
      environment,
      operation,
      outcome,
      outputDirectory,
      publicationId,
      record,
      stepName,
      waivers: publicationWaivers,
    });
    assertPublicationBaseline(step, candidateBundle.entries, stepName);
    assertAttemptWaiversApplied(activeAttempt, candidateBundle.notices, operation);

    const preparedAt = recordMutationTimestamp(clock, log, record);
    const transaction = {
      id: publicationId,
      attempt_id: attemptId,
      intended_outcome: outcome,
      prepared_at: preparedAt,
      old_revision: step.revision,
      old_artifacts: structuredClone(step.artifacts),
      new_artifacts: structuredClone(candidateBundle.entries),
      input_snapshot: structuredClone(activeAttempt.input_snapshot),
      blocker: blocker === null
        ? null
        : {
            ...structuredClone(blocker),
            at: preparedAt,
          },
      files: publicationFiles(candidateBundle, step.artifacts, publicationId),
    };
    if (operation === "revise") transaction.operation = "revise";
    if (adoptionBase) {
      transaction.adopted_artifacts = structuredClone(adoptionBase.entries);
    }
    assertPublicationPathsReady(outputDirectory, transaction);

    step.publication_transaction = transaction;
    touchFileBackedRecord(log, record, preparedAt);
    invokePublicationFailpoint(failAt, "before_journal_write");
    write(log);

    let ledgerCommitted = false;
    try {
      invokePublicationFailpoint(failAt, "after_journal_write");
      for (const file of transaction.files) {
        if (file.backup_path === null) continue;
        const committedOldArtifact = transaction.old_artifacts.find(
          (artifact) => artifact.kind === file.kind,
        );
        // The backup phase's old-bundle proof for an adopted kind is the journaled divergent
        // digest — the canonical slot legitimately holds the user's bytes (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#5-edit-channels-and-transports(b)).
        const adopted = transaction.adopted_artifacts?.find(
          (entry) => entry.kind === file.kind,
        );
        const oldArtifact = adopted
          ? { ...committedOldArtifact, sha256: adopted.sha256, bytes: adopted.bytes }
          : committedOldArtifact;
        if (
          inspectPublicationFile(
            outputDirectory,
            file.canonical_path,
            oldArtifact,
          ).status !== "match"
        ) {
          throw new ProcessLogLifecycleError(
            "stale_writer",
            `${file.canonical_path} changed before backup`,
          );
        }
        renamePublicationFile(
          outputDirectory,
          file.canonical_path,
          file.backup_path,
        );
        invokePublicationFailpoint(failAt, `after_backup:${file.kind}`);
      }
      for (const file of transaction.files) {
        const newArtifact = transaction.new_artifacts.find(
          (artifact) => artifact.kind === file.kind,
        );
        if (
          inspectPublicationFile(
            outputDirectory,
            file.candidate_path,
            newArtifact,
          ).status !== "match"
        ) {
          throw new ProcessLogLifecycleError(
            "candidate_bundle_invalid",
            `${file.candidate_path} changed before publication`,
          );
        }
        renamePublicationFile(
          outputDirectory,
          file.candidate_path,
          file.canonical_path,
        );
        invokePublicationFailpoint(failAt, `after_candidate:${file.kind}`);
      }

      invokePublicationFailpoint(failAt, "before_bundle_validation");
      const canonicalFiles = loadCanonicalPublicationBundle(
        transaction,
        outputDirectory,
      );
      const canonicalValidation = validateArtifactBundleBytes({
        blocker: transaction.blocker,
        entries: transaction.new_artifacts,
        environment,
        files: canonicalFiles,
        operation,
        outcome,
        outputDirectory,
        record,
        stepName,
        waivers: publicationWaivers,
      });
      invokePublicationFailpoint(failAt, "after_bundle_validation");
      if (operation === "revise") {
        assertRevisionBriefCoherent(
          record,
          stepName,
          outputDirectory,
          transaction.input_snapshot,
        );
      } else {
        assertPublicationInputsCurrent(
          record,
          stepName,
          environment,
          transaction.input_snapshot,
        );
      }
      const finalState = operation === "revise"
        ? deriveRevisionFinalState(
            stepName,
            environment,
            outputDirectory,
            transaction.input_snapshot,
          )
        : null;
      const openConflicts = operation === "revise"
        ? canonicalValidation.conflicts.map((conflict) => ({
            subject: {
              kind: conflict.subject.kind,
              key: boundedJournaledSubjectKey(conflict.subject.key),
            },
            code: conflict.code,
          }))
        : null;
      const finishedAt = recordMutationTimestamp(clock, log, record);
      invokePublicationFailpoint(failAt, "before_ledger_commit");
      finalizePreparedPublication({
        failAt,
        finalState,
        log,
        openConflicts,
        record,
        stepName,
        timestamp: finishedAt,
        write,
      });
      ledgerCommitted = true;
      invokePublicationFailpoint(failAt, "after_ledger_commit");
      if (isMaterialStep(stepName)) {
        writeRevisionArchiveFiles(
          outputDirectory,
          publicationId,
          transaction.new_artifacts,
          new Map(
            [...canonicalFiles.entries()].map(([kind, file]) => [kind, file.bytes]),
          ),
        );
      }
      invokePublicationFailpoint(failAt, "after_archive");
      removeTransactionDirectory(outputDirectory, publicationId);
      invokePublicationFailpoint(failAt, "after_cleanup");
      const journaledWaivers = (step.waivers ?? [])
        .filter((waiver) => waiver.created_at === step.finished_at)
        .map((waiver) => structuredClone(waiver));
      return {
        artifacts: structuredClone(step.artifacts),
        ...(operation === "revise"
          ? {
              open_conflicts: structuredClone(openConflicts),
              state: step.state,
            }
          : {}),
        // A publication reports what it journaled and what a waiver downgraded, whether or not it
        // was a revision: a first publication carrying the word-limit approval has both.
        ...(operation === "revise" || journaledWaivers.length > 0
          ? {
              notices: structuredClone(canonicalValidation.notices),
              waivers_recorded: journaledWaivers,
            }
          : {}),
        process: record,
        publication_id: publicationId,
        revision: step.revision,
        status: outcome,
        step_name: stepName,
      };
    } catch (error) {
      if (
        error.code === "publication_ledger_write_failed"
        || error.simulatedCrash
        || ledgerCommitted
      ) {
        throw error;
      }
      const recoveredAt = recordMutationTimestamp(clock, log, record);
      const recovery = recoverPreparedPublication({
        environment,
        failAt,
        log,
        outputDirectory,
        preferNew: false,
        record,
        stepName,
        timestamp: recoveredAt,
        write,
      });
      throw new ProcessLogLifecycleError(
        "publication_failed",
        `${stepName} publication failed and ${recovery.status} (${error.code ?? "filesystem"})`,
      );
    }
  }, lockOptions);
}

const STAGING_MAX_DEPTH = 16;
const STAGING_MAX_DIRECT_ENTRIES = 64;
const STAGING_MAX_ENTRIES = 1_024;
const STAGING_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const CLEANUP_CONFIRMATION_PATTERN = /^[a-f0-9]{64}$/;

function stagingFailure(code, message) {
  return new ProcessLogLifecycleError(code, message);
}

function boundedStagingCauseCode(error) {
  try {
    const code = error?.code;
    return typeof code === "string"
      && Buffer.byteLength(code, "utf8") <= processLogDiagnosticLimits.codeMaxBytes
      && processLogUppercaseCauseCodePattern.test(code)
      ? code
      : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

function readBoundedStagingDirectory(
  path,
  maximumEntries,
  { label, overflowMessage },
) {
  let directory;
  try {
    directory = opendirSync(path);
  } catch (error) {
    throw stagingFailure(
      "staging_inventory_unreadable",
      `${label} could not be opened (${boundedStagingCauseCode(error)})`,
    );
  }
  const entries = [];
  let failure = null;
  try {
    while (entries.length <= maximumEntries) {
      const entry = directory.readSync();
      if (entry === null) break;
      entries.push(entry);
    }
  } catch (error) {
    failure = stagingFailure(
      "staging_inventory_unreadable",
      `${label} could not be listed (${boundedStagingCauseCode(error)})`,
    );
  }
  try {
    directory.closeSync();
  } catch (error) {
    failure ??= stagingFailure(
      "staging_inventory_unreadable",
      `${label} could not be closed (${boundedStagingCauseCode(error)})`,
    );
  }
  if (failure !== null) throw failure;
  if (entries.length > maximumEntries) {
    throw stagingFailure("staging_inventory_unbounded", overflowMessage);
  }
  return entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")));
}

function stagingLstat(path, { allowMissing = false } = {}) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    const causeCode = boundedStagingCauseCode(error);
    if (allowMissing && causeCode === "ENOENT") return null;
    throw stagingFailure(
      "staging_inventory_unreadable",
      `staging inventory could not be inspected (${causeCode})`,
    );
  }
}

function stagingRealpath(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    throw stagingFailure(
      "staging_inventory_unreadable",
      `staging inventory realpath could not be inspected (${boundedStagingCauseCode(error)})`,
    );
  }
}

function stagingStatIdentity(stats) {
  return {
    ctime_ns: stats.ctimeNs.toString(),
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    mode: stats.mode.toString(),
    mtime_ns: stats.mtimeNs.toString(),
    nlink: stats.nlink.toString(),
    size: stats.size.toString(),
  };
}

function sameStagingIdentity(left, right) {
  return JSON.stringify(stagingStatIdentity(left))
    === JSON.stringify(stagingStatIdentity(right));
}

function inspectStagingTree(targetPath, expectedRealPath) {
  const rootStats = stagingLstat(targetPath, { allowMissing: true });
  if (rootStats === null) {
    throw stagingFailure("staging_cleanup_target_missing", "staging target does not exist");
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw stagingFailure(
      "staging_inventory_unsafe",
      "staging target must be a non-symlink directory",
    );
  }
  if (stagingRealpath(targetPath) !== expectedRealPath) {
    throw stagingFailure(
      "staging_inventory_unsafe",
      "staging target realpath is outside its owned output directory",
    );
  }

  const entries = [];
  let maxDepth = 0;
  let totalBytes = 0;
  const walk = (directoryPath, relativeDirectory, depth) => {
    if (depth > STAGING_MAX_DEPTH) {
      throw stagingFailure(
        "staging_inventory_unbounded",
        `staging inventory exceeds depth ${STAGING_MAX_DEPTH}`,
      );
    }
    maxDepth = Math.max(maxDepth, depth);
    const directoryEntries = readBoundedStagingDirectory(
      directoryPath,
      STAGING_MAX_ENTRIES - entries.length,
      {
        label: "staging directory",
        overflowMessage: `staging inventory exceeds ${STAGING_MAX_ENTRIES} entries`,
      },
    );
    for (const directoryEntry of directoryEntries) {
      if (entries.length >= STAGING_MAX_ENTRIES) {
        throw stagingFailure(
          "staging_inventory_unbounded",
          `staging inventory exceeds ${STAGING_MAX_ENTRIES} entries`,
        );
      }
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${directoryEntry.name}`
        : directoryEntry.name;
      const absolutePath = resolve(directoryPath, directoryEntry.name);
      const stats = stagingLstat(absolutePath);
      if (stats.isSymbolicLink()) {
        throw stagingFailure(
          "staging_inventory_unsafe",
          "staging inventory contains a symbolic link",
        );
      }
      if (stats.isDirectory()) {
        entries.push({
          path: relativePath,
          type: "directory",
          ...stagingStatIdentity(stats),
        });
        walk(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!stats.isFile() || stats.nlink !== 1n) {
        throw stagingFailure(
          "staging_inventory_unsafe",
          "staging inventory contains a non-regular or multiply-linked file",
        );
      }
      totalBytes += Number(stats.size);
      if (totalBytes > STAGING_MAX_TOTAL_BYTES) {
        throw stagingFailure(
          "staging_inventory_unbounded",
          `staging inventory exceeds ${STAGING_MAX_TOTAL_BYTES} bytes`,
        );
      }
      entries.push({
        path: relativePath,
        type: "file",
        ...stagingStatIdentity(stats),
      });
    }
  };
  walk(targetPath, "", 0);
  const finalRootStats = stagingLstat(targetPath);
  if (
    finalRootStats.isSymbolicLink()
    || !finalRootStats.isDirectory()
    || !sameStagingIdentity(rootStats, finalRootStats)
    || stagingRealpath(targetPath) !== expectedRealPath
  ) {
    throw stagingFailure(
      "staging_inventory_changed",
      "staging root identity changed while it was inspected",
    );
  }
  const digest = createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
  const modifiedAtMs = Number(rootStats.mtimeNs / 1_000_000n);
  return {
    ageMs: Math.max(0, Date.now() - modifiedAtMs),
    digest,
    entryCount: entries.length,
    maxDepth,
    modifiedAt: new Date(modifiedAtMs).toISOString(),
    rootIdentity: stagingStatIdentity(rootStats),
    totalBytes,
  };
}

function publicationOwnershipIndex(log) {
  const ownership = new Map();
  for (const record of log.processes) {
    if (classifyProcessRecord(record) !== "file-backed") continue;
    for (const stepName of fileBackedStepNames) {
      const step = record.steps[stepName];
      if (step.publication_transaction !== null) {
        ownership.set(step.publication_transaction.id, {
          kind: "prepared",
          processId: record.id,
          stepName,
        });
      }
      for (const attempt of step.attempt_history) {
        if (attempt.publication_id === null) continue;
        ownership.set(attempt.publication_id, {
          kind: "history",
          processId: record.id,
          stepName,
        });
      }
    }
  }
  return ownership;
}

function processHasActiveAttempt(record) {
  return fileBackedStepNames.some(
    (stepName) => record.steps[stepName].active_attempt !== null,
  );
}

function stagingParentDirectory(outputDirectory, { allowMissing = true } = {}) {
  const path = resolve(outputDirectory.path, ".pipeline-tmp");
  const realPath = resolve(outputDirectory.realPath, ".pipeline-tmp");
  const stats = stagingLstat(path, { allowMissing });
  if (stats === null) return null;
  if (stats.isSymbolicLink() || !stats.isDirectory() || stagingRealpath(path) !== realPath) {
    throw stagingFailure(
      "staging_inventory_unsafe",
      "staging root must be an exact non-symlink directory",
    );
  }
  return { path, realPath };
}

function stagingAction(classification) {
  return {
    active_unassigned: "wait_for_active_attempt",
    foreign_owned: "inspect_foreign_publication_owner",
    history_owned: "inspect_committed_history_residue",
    invalid_entry: "inspect_staging_inventory",
    orphan: "review_cleanup_staging",
    prepared_recovery: "use_reconcile_step",
  }[classification];
}

function stagingIssue(classification) {
  return {
    foreign_owned: "staging_foreign_owner",
    history_owned: "staging_history_residue",
    invalid_entry: "staging_invalid_entry",
    orphan: "staging_orphan",
    prepared_recovery: "staging_prepared_recovery",
  }[classification] ?? null;
}

function classifyStagingEntry(record, publicationId, ownership) {
  const owner = ownership.get(publicationId);
  if (owner?.processId !== record.id) return owner ? "foreign_owned" :
    processHasActiveAttempt(record) ? "active_unassigned" : "orphan";
  return owner.kind === "prepared" ? "prepared_recovery" : "history_owned";
}

function readBoundedStagingChildren(path) {
  return readBoundedStagingDirectory(path, STAGING_MAX_DIRECT_ENTRIES, {
    label: "staging root",
    overflowMessage: `staging root exceeds ${STAGING_MAX_DIRECT_ENTRIES} direct entries`,
  });
}

function inspectStagingDirectory(record, outputDirectory, ownership) {
  if (outputDirectory === null) {
    return { health: "not_evaluated", issues: [], entries: [] };
  }
  let parent;
  try {
    parent = stagingParentDirectory(outputDirectory);
  } catch (error) {
    return {
      health: "attention",
      issues: [error.code ?? "staging_invalid_entry"],
      entries: [{
        publication_id: null,
        classification: "invalid_entry",
        action: stagingAction("invalid_entry"),
        inventory_health: "unsafe",
      }],
    };
  }
  if (parent === null) return { health: "clear", issues: [], entries: [] };

  let directoryEntries;
  try {
    directoryEntries = readBoundedStagingChildren(parent.path);
  } catch (error) {
    return {
      health: "attention",
      issues: [error?.code ?? "staging_inventory_unreadable"],
      entries: [],
    };
  }
  const entries = [];
  const issues = [];
  for (const directoryEntry of directoryEntries) {
    const validId = isValidProcessLogV3TransactionId(directoryEntry.name);
    let classification = validId
      ? classifyStagingEntry(record, directoryEntry.name, ownership)
      : "invalid_entry";
    let snapshot = null;
    if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
      classification = "invalid_entry";
    } else {
      try {
        snapshot = inspectStagingTree(
          resolve(parent.path, directoryEntry.name),
          resolve(parent.realPath, directoryEntry.name),
        );
      } catch {
        classification = "invalid_entry";
      }
    }
    const issue = stagingIssue(classification);
    if (issue) addDeepIssue(issues, issue);
    entries.push({
      publication_id: validId ? directoryEntry.name : null,
      classification,
      action: stagingAction(classification),
      inventory_health: snapshot === null ? "unsafe" : "safe",
      ...(snapshot === null ? {} : {
        age_ms: snapshot.ageMs,
        entry_count: snapshot.entryCount,
        max_depth: snapshot.maxDepth,
        modified_at: snapshot.modifiedAt,
        total_bytes: snapshot.totalBytes,
      }),
    });
  }
  return {
    health: issues.length > 0 ? "attention" : entries.length > 0 ? "current" : "clear",
    issues,
    entries,
  };
}

function stagingCleanupToken(record, publicationId, snapshot) {
  const preimage = {
    process_id: record.id,
    process_updated_at: record.updated_at,
    publication_id: publicationId,
    root_identity: snapshot.rootIdentity,
    tree_digest: snapshot.digest,
  };
  return createHash("sha256").update(JSON.stringify(preimage)).digest("hex");
}

function sameStagingSnapshot(left, right) {
  return JSON.stringify({
    digest: left.digest,
    rootIdentity: left.rootIdentity,
  }) === JSON.stringify({
    digest: right.digest,
    rootIdentity: right.rootIdentity,
  });
}

export function cleanupFileBackedStagingV3(
  logPath,
  input,
  {
    lockOptions,
    outputRoot,
    workspaceRoot,
  } = {},
) {
  assertExactKeys(
    input,
    ["processId", "publicationId", "confirmationToken"],
    "invalid_cleanup_staging_input",
    "cleanup-staging input",
  );
  const processId = requireNonEmptyString(
    input.processId,
    "processId",
    "invalid_cleanup_staging_input",
  );
  const publicationId = requirePublicationId(
    input.publicationId,
    "publicationId",
    "invalid_cleanup_staging_input",
  );
  const confirmationToken = input.confirmationToken ?? null;
  if (
    confirmationToken !== null
    && (
      typeof confirmationToken !== "string"
      || !CLEANUP_CONFIRMATION_PATTERN.test(confirmationToken)
    )
  ) {
    throw new ProcessLogLifecycleError(
      "invalid_cleanup_staging_input",
      "confirmationToken must be null or a lowercase SHA-256 token",
    );
  }
  const environment = resolveOutputEnvironment(workspaceRoot, outputRoot);

  return withLogV3Lock(logPath, ({ log }) => {
    const record = getFileBackedProcessForMutation(log, processId, "cleanup-staging");
    const owner = publicationOwnershipIndex(log).get(publicationId);
    if (owner) {
      throw new ProcessLogLifecycleError(
        owner.kind === "prepared"
          ? "staging_cleanup_prepared_owned"
          : "staging_cleanup_history_owned",
        "cleanup-staging cannot remove prepared or committed recovery evidence",
      );
    }
    if (processHasActiveAttempt(record)) {
      throw new ProcessLogLifecycleError(
        "staging_cleanup_active_attempt",
        "cleanup-staging is forbidden while the process has an active attempt",
      );
    }
    const outputDirectory = selectedOutputDirectory(environment, record);
    const parent = stagingParentDirectory(outputDirectory, { allowMissing: false });
    const targetPath = resolve(parent.path, publicationId);
    const targetRealPath = resolve(parent.realPath, publicationId);
    const snapshot = inspectStagingTree(targetPath, targetRealPath);
    const token = stagingCleanupToken(record, publicationId, snapshot);
    const result = {
      process_id: record.id,
      publication_id: publicationId,
      age_ms: snapshot.ageMs,
      modified_at: snapshot.modifiedAt,
      entry_count: snapshot.entryCount,
      max_depth: snapshot.maxDepth,
      total_bytes: snapshot.totalBytes,
      tree_digest: snapshot.digest,
      confirmation_token: token,
    };
    if (confirmationToken === null) {
      return { status: "review_required", ...result };
    }
    if (confirmationToken !== token) {
      throw new ProcessLogLifecycleError(
        "staging_cleanup_confirmation_mismatch",
        "cleanup-staging confirmation no longer matches the exact inventory",
      );
    }
    const repeatedSnapshot = inspectStagingTree(targetPath, targetRealPath);
    if (!sameStagingSnapshot(snapshot, repeatedSnapshot)) {
      throw new ProcessLogLifecycleError(
        "staging_inventory_changed",
        "staging inventory changed before cleanup",
      );
    }
    try {
      rmSync(targetPath, { recursive: true });
    } catch (error) {
      throw new ProcessLogLifecycleError(
        "staging_cleanup_remove_failed",
        `staging cleanup could not remove the reviewed target (${boundedStagingCauseCode(error)})`,
      );
    }
    if (stagingLstat(targetPath, { allowMissing: true }) !== null) {
      throw new ProcessLogLifecycleError(
        "staging_cleanup_remove_failed",
        "staging cleanup did not remove the reviewed target",
      );
    }
    return { status: "cleaned", ...result };
  }, lockOptions);
}

function latestCommittedAttempt(step) {
  return [...step.attempt_history]
    .reverse()
    .find((attempt) => attempt.publication_id !== null)
    ?? null;
}

function artifactHealthFromError(error) {
  if (error.code === "artifact_missing") return "missing";
  return "corrupt";
}

function inputHealthFromError(error) {
  if (error.code === "input_missing") return "missing";
  if (error.code === "prerequisite_stale") return "stale";
  return "unavailable";
}

function addDeepIssue(issues, code) {
  if (!issues.includes(code)) issues.push(code);
}

/*
 * The open adoption-base record makes deep validation report adoption pending rather than
 * corruption: every canonical artifact must match either its committed digest or, for an adopted
 * kind, the journaled divergent digest (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#5-edit-channels-and-transports(b)).
 */
function adoptionExplainsCanonicalBytes(step, outputDirectory) {
  const base = step.adoption_base ?? null;
  if (!base) return false;
  try {
    for (const artifact of step.artifacts) {
      const adopted = adoptedEntryByKind(base, artifact.kind);
      const expected = adopted ?? artifact;
      const bytes = readVerifiedFile({
        basePath: outputDirectory.path,
        baseRealPath: outputDirectory.realPath,
        codePrefix: "artifact",
        relativePath: artifact.path,
      });
      if (
        bytes.byteLength !== expected.bytes
        || sha256Hex(bytes) !== expected.sha256
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function loadDeepArtifactFiles(step, outputDirectory) {
  const files = new Map();
  for (const artifact of step.artifacts) {
    const bytes = readVerifiedFile({
      basePath: outputDirectory.path,
      baseRealPath: outputDirectory.realPath,
      codePrefix: "artifact",
      relativePath: artifact.path,
    });
    if (
      bytes.byteLength !== artifact.bytes
      || sha256Hex(bytes) !== artifact.sha256
    ) {
      throw new ProcessLogLifecycleError(
        "artifact_corrupt",
        `${artifact.path} does not match its committed digest and size`,
      );
    }
    files.set(artifact.kind, { bytes, metadata: artifact });
  }
  return files;
}

function inspectDeepStep({
  environment,
  outputDirectory,
  outputHealth,
  record,
  stepName,
}) {
  const step = record.steps[stepName];
  const report = {
    name: stepName,
    state: step.state,
    artifact_health: step.revision === 0 ? "not_published" : "current",
    input_health: step.revision === 0 ? "not_published" : "current",
    issues: [],
  };

  if (step.publication_transaction !== null) {
    report.artifact_health = "recovery_required";
    addDeepIssue(report.issues, "publication_recovery_required");
    return report;
  }

  let files = null;
  if (step.revision > 0) {
    if (outputHealth === "missing") {
      report.artifact_health = "missing";
      addDeepIssue(report.issues, "output_missing");
    } else if (outputHealth === "invalid") {
      report.artifact_health = "corrupt";
      addDeepIssue(report.issues, "output_path_invalid");
    } else if (outputDirectory !== null) {
      try {
        files = loadDeepArtifactFiles(step, outputDirectory);
      } catch (error) {
        if (adoptionExplainsCanonicalBytes(step, outputDirectory)) {
          report.artifact_health = "adoption_pending";
          addDeepIssue(report.issues, "adoption_pending");
        } else {
          report.artifact_health = artifactHealthFromError(error);
          addDeepIssue(report.issues, error.code ?? "artifact_corrupt");
        }
      }
    }
  }

  let currentInputSnapshot = null;
  if (step.revision > 0) {
    if (step.state === "stale") {
      report.input_health = "stale";
      addDeepIssue(report.issues, "lifecycle_stale");
    } else if (outputHealth === "current") {
      try {
        currentInputSnapshot = preflightFileBackedStepRecord(
          record,
          stepName,
          environment,
          step.published_inputs,
        ).input_snapshot;
        if (
          !snapshotStillCurrent(stepName, step.published_inputs, currentInputSnapshot)
        ) {
          report.input_health = "stale";
          addDeepIssue(report.issues, "published_inputs_stale");
          const protectedKinds = protectedInputKinds(stepName);
          const changedKinds = changedBundleKinds(
            step.published_inputs,
            comparableCurrentSnapshot(stepName, step.published_inputs, currentInputSnapshot),
          ).filter((kind) => protectedKinds.has(kind));
          if (changedKinds.length > 0) {
            addDeepIssue(report.issues, "protected_input_drift");
          }
          // A file of the candidate layer drifted, told apart from a canon file.
          if (changedKinds.some((kind) => kind.startsWith("candidate_"))) {
            addDeepIssue(report.issues, "candidate_layer_drift");
          }
        }
      } catch (error) {
        report.input_health = inputHealthFromError(error);
        addDeepIssue(report.issues, error.code ?? "inputs_unavailable");
      }
    } else {
      report.input_health = "unavailable";
      addDeepIssue(report.issues, outputHealth === "missing"
        ? "output_missing"
        : "output_path_invalid");
    }
  }

  if (
    step.revision > 0
    && report.artifact_health === "current"
    && report.input_health === "current"
    && files !== null
  ) {
    try {
      const committedAttempt = latestCommittedAttempt(step);
      if (committedAttempt === null) {
        throw new ProcessLogLifecycleError(
          "artifact_manifest_invalid",
          `${stepName} has committed artifacts without publication history`,
        );
      }
      if (committedAttempt.outcome === "blocked") {
        validateArtifactBundleBytes({
          blocker: { code: committedAttempt.error_code },
          entries: step.artifacts,
          environment,
          files,
          outcome: "blocked",
          outputDirectory,
          record,
          stepName,
        });
      } else {
        verifiedArtifactBundle(
          record,
          stepName,
          environment,
          outputDirectory,
          new Map(),
          new Map(),
        );
      }
    } catch (error) {
      report.artifact_health = "corrupt";
      addDeepIssue(report.issues, error.code ?? "artifact_corrupt");
    }
  }

  if (isMaterialStep(stepName) && outputDirectory !== null) {
    for (const attempt of step.attempt_history) {
      if (
        attempt.publication_id === null
        || !Array.isArray(attempt.archived_artifacts)
      ) {
        continue;
      }
      for (const archived of attempt.archived_artifacts) {
        let bytes = null;
        try {
          bytes = readVerifiedFile({
            basePath: outputDirectory.path,
            baseRealPath: outputDirectory.realPath,
            codePrefix: "artifact",
            relativePath: `.revisions/${attempt.publication_id}/${archived.path}`,
          });
        } catch (error) {
          addDeepIssue(
            report.issues,
            error.code === "artifact_missing"
              ? "revision_archive_missing"
              : "revision_archive_corrupt",
          );
          continue;
        }
        if (
          bytes.byteLength !== archived.bytes
          || sha256Hex(bytes) !== archived.sha256
        ) {
          addDeepIssue(report.issues, "revision_archive_corrupt");
        }
      }
    }
    const openConflicts = latestCommittedOpenConflicts(step);
    if (openConflicts.length > 0) {
      addDeepIssue(report.issues, "open_conflicts");
    }
  }

  return report;
}

function inspectDeepFileBackedProcess(record, environment, ownership) {
  let outputDirectory = null;
  let output = {
    health: "not_reserved",
    code: null,
  };
  if (record.output_dir !== null) {
    try {
      if (
        validateOwnedOutputDirectory(
          environment.outputPath,
          environment.outputRealPath,
          record.output_dir,
        )
      ) {
        const segment = record.output_dir.slice("output/".length);
        outputDirectory = {
          path: resolve(environment.outputPath, segment),
          realPath: resolve(environment.outputRealPath, segment),
        };
        output = { health: "current", code: null };
      } else {
        output = { health: "missing", code: "output_missing" };
      }
    } catch (error) {
      output = {
        health: "invalid",
        code: error.code ?? "output_path_invalid",
      };
    }
  }

  const steps = fileBackedStepNames.map((stepName) =>
    inspectDeepStep({
      environment,
      outputDirectory,
      outputHealth: output.health,
      record,
      stepName,
    }));
  const staging = inspectStagingDirectory(record, outputDirectory, ownership);
  const hasAttention =
    ["missing", "invalid"].includes(output.health)
    || steps.some((step) => step.issues.length > 0)
    || staging.health === "attention";
  return {
    process_id: record.id,
    mode: "file-backed",
    health: hasAttention ? "attention" : "current",
    output,
    staging,
    steps,
  };
}

function inspectProcessLogV3DeepWithEnvironment(log, environment) {
  const ownership = publicationOwnershipIndex(log);
  const processes = log.processes.map((record) => {
    if (classifyProcessRecord(record) === "historical") {
      return {
        process_id: record.id,
        mode: "historical",
        health: "historical",
        output: {
          health: "not_evaluated",
          code: null,
        },
        steps: [],
      };
    }
    return inspectDeepFileBackedProcess(record, environment, ownership);
  });
  return {
    schema_version: 4,
    health: processes.some((process) => process.health === "attention")
      ? "attention"
      : "current",
    processes,
  };
}

export function inspectProcessLogV3Deep(
  log,
  {
    outputRoot,
    workspaceRoot,
  } = {},
) {
  validateLogV3(log);
  const environment = resolveOutputEnvironment(workspaceRoot, outputRoot);
  return inspectProcessLogV3DeepWithEnvironment(log, environment);
}

export function readProcessLogV3DeepSnapshot(
  logPath,
  {
    lockOptions,
    outputRoot,
    workspaceRoot,
  } = {},
) {
  const environment = resolveOutputEnvironment(workspaceRoot, outputRoot);
  return withLogV3Lock(logPath, ({ log }) => ({
    log,
    report: inspectProcessLogV3DeepWithEnvironment(log, environment),
  }), lockOptions);
}

export function validateProcessLogV3Deep(logPath, options = {}) {
  return readProcessLogV3DeepSnapshot(logPath, options).report;
}

function recoverMissingReservedOutputDirectory({
  environment,
  mkdirDirectory,
  record,
}) {
  if (record.output_dir === null) {
    throw new ProcessLogLifecycleError(
      "output_not_reserved",
      `process ${record.id} has no reserved output directory`,
    );
  }
  if (
    validateOwnedOutputDirectory(
      environment.outputPath,
      environment.outputRealPath,
      record.output_dir,
    )
  ) {
    return false;
  }
  if (
    fileBackedStepNames.some(
      (candidateStepName) => record.steps[candidateStepName].revision > 0,
    )
  ) {
    throw new ProcessLogLifecycleError(
      "publication_recovery_conflict",
      "a missing output directory with committed artifacts cannot be recreated as empty",
    );
  }
  const step = record.steps.get_vacancy;
  const recoverableRunning =
    step.state === "running"
    && step.active_attempt !== null;
  const recoverableFailure =
    step.state === "failed"
    && step.error?.code === "output_setup_failed";
  if (!recoverableRunning && !recoverableFailure) {
    throw new ProcessLogLifecycleError(
      "invalid_step_transition",
      "missing output recovery requires an active Step 1 reservation or output_setup_failed",
    );
  }

  const segment = record.output_dir.slice("output/".length);
  const targetPath = resolve(environment.outputPath, segment);
  try {
    mkdirDirectory(targetPath);
    if (
      !validateOwnedOutputDirectory(
        environment.outputPath,
        environment.outputRealPath,
        record.output_dir,
      )
    ) {
      const error = new Error("mkdir did not create the reserved directory");
      error.code = "ENOENT";
      throw error;
    }
  } catch (error) {
    throw new ProcessLogLifecycleError(
      "output_setup_failed",
      `could not recover ${record.output_dir} (${error.code ?? "unknown"})`,
    );
  }
  return true;
}

function reconcileCompletedInputDrift({
  clock,
  environment,
  log,
  record,
  stepName,
  write,
}) {
  const step = record.steps[stepName];
  if (step.state === "stale") {
    return {
      invalidated_steps: [],
      process: record,
      status: "unchanged",
      step_name: stepName,
    };
  }
  if (step.state !== "completed") {
    throw new ProcessLogLifecycleError(
      "invalid_step_transition",
      `input reconciliation requires ${stepName} to be completed, found ${step.state}`,
    );
  }
  verifyCommittedArtifactBaseline(record, stepName, environment);
  const preflight = preflightFileBackedStepRecord(
    record,
    stepName,
    environment,
    step.published_inputs,
  );
  if (snapshotStillCurrent(stepName, step.published_inputs, preflight.input_snapshot)) {
    return {
      invalidated_steps: [],
      process: record,
      status: "unchanged",
      step_name: stepName,
    };
  }

  const descendantStepNames = transitiveDescendantStepNames(stepName);
  const runningDescendants = descendantStepNames.filter(
    (descendantStepName) =>
      record.steps[descendantStepName].state === "running",
  );
  if (runningDescendants.length > 0) {
    throw new ProcessLogLifecycleError(
      "dependent_step_running",
      `reconcile-step cannot stale ${stepName} while descendant step(s) are running: ${runningDescendants.join(", ")}`,
    );
  }

  const timestamp = recordMutationTimestamp(clock, log, record);
  const invalidatedSteps = [];
  step.state = "stale";
  step.updated_at = timestamp;
  for (const descendantStepName of descendantStepNames) {
    const descendantStep = record.steps[descendantStepName];
    if (descendantStep.state !== "completed") continue;
    descendantStep.state = "stale";
    descendantStep.updated_at = timestamp;
    invalidatedSteps.push(descendantStepName);
  }
  touchFileBackedRecord(log, record, timestamp);
  write(log);
  return {
    invalidated_steps: invalidatedSteps,
    process: record,
    status: "stale",
    step_name: stepName,
  };
}

export function reconcileFileBackedStepV3(
  logPath,
  input,
  {
    clock = () => new Date().toISOString(),
    failAt = null,
    lockOptions,
    mkdirDirectory = (directory) => mkdirSync(directory),
    outputRoot,
    workspaceRoot,
  } = {},
) {
  assertExactKeys(
    input,
    ["selector", "stepName", "attemptId", "publicationId"],
    "invalid_reconcile_step_input",
    "reconcile-step input",
  );
  const stepName = requireStepName(input.stepName);
  if (
    !Object.hasOwn(input, "attemptId")
    || !Object.hasOwn(input, "publicationId")
  ) {
    throw new ProcessLogLifecycleError(
      "invalid_reconcile_step_input",
      "attemptId and publicationId must both be present, using null for non-publication reconcile",
    );
  }
  const publicationId = input.publicationId === null
    ? null
    : requirePublicationId(
        input.publicationId,
        "publicationId",
        "invalid_reconcile_step_input",
      );
  const attemptId = input.attemptId === null
    ? null
    : requireNonEmptyString(
        input.attemptId,
        "attemptId",
        "invalid_reconcile_step_input",
      );
  if ((attemptId === null) !== (publicationId === null)) {
    throw new ProcessLogLifecycleError(
      "invalid_reconcile_step_input",
      "attemptId and publicationId must either both be non-null or both be null",
    );
  }
  if (typeof mkdirDirectory !== "function") {
    throw new ProcessLogLifecycleError(
      "invalid_output_environment",
      "mkdirDirectory must be a function",
    );
  }
  const environment = resolveOutputEnvironment(workspaceRoot, outputRoot);

  return withLogV3Lock(logPath, ({ log, write }) => {
    const record = resolveFileBackedProcessV3(log, input.selector);
    const step = record.steps[stepName];

    if (publicationId === null) {
      if (step.publication_transaction !== null) {
        throw new ProcessLogLifecycleError(
          "publication_recovery_required",
          `${stepName} has a prepared publication that requires its publication token`,
        );
      }
      if (
        record.output_dir !== null
        && !validateOwnedOutputDirectory(
          environment.outputPath,
          environment.outputRealPath,
          record.output_dir,
        )
      ) {
        if (stepName !== "get_vacancy") {
          throw new ProcessLogLifecycleError(
            "invalid_reconcile_step_input",
            "missing output directory recovery must target get_vacancy",
          );
        }
        recoverMissingReservedOutputDirectory({
          environment,
          mkdirDirectory,
          record,
        });
        return {
          invalidated_steps: [],
          process: record,
          status: "output_recovered",
          step_name: stepName,
        };
      }
      if (record.output_dir === null) {
        throw new ProcessLogLifecycleError(
          "output_not_reserved",
          `process ${record.id} has no reserved output directory`,
        );
      }
      return reconcileCompletedInputDrift({
        clock,
        environment,
        log,
        record,
        stepName,
        write,
      });
    }

    const outputDirectory = selectedOutputDirectory(environment, record);
    const transaction = step.publication_transaction;

    if (transaction !== null) {
      if (
        transaction.id !== publicationId
        || attemptId === null
        || transaction.attempt_id !== attemptId
        || step.active_attempt?.id !== attemptId
      ) {
        throw new ProcessLogLifecycleError(
          "stale_attempt",
          `reconcile-step did not match the active ${stepName} publication`,
        );
      }
      return {
        ...recoverPreparedPublication({
          environment,
          failAt,
          log,
          outputDirectory,
          preferNew: true,
          record,
          stepName,
          timestamp: recordMutationTimestamp(clock, log, record),
          write,
        }),
        process: record,
        step_name: stepName,
      };
    }

    if (step.active_attempt !== null) {
      throw new ProcessLogLifecycleError(
        "stale_attempt",
        `${stepName} has a different active attempt`,
      );
    }
    const lastHistory = step.attempt_history.at(-1);
    if (lastHistory?.publication_id !== publicationId) {
      throw new ProcessLogLifecycleError(
        "stale_publication",
        `${publicationId} is not the latest committed ${stepName} publication`,
      );
    }
    const canonicalBytesByKind = new Map();
    for (const artifact of step.artifacts) {
      const inspection = inspectPublicationFile(outputDirectory, artifact.path, artifact);
      if (inspection.status !== "match") {
        throw new ProcessLogLifecycleError(
          "publication_recovery_conflict",
          `committed artifact ${artifact.path} is not healthy`,
        );
      }
      canonicalBytesByKind.set(artifact.kind, inspection.bytes);
    }
    // Re-running finalization completes the committed-bundle archive before any removal, so the
    // archive-then-delete ordering is idempotent across a crash window (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#6-revision-content-history). This is a
    // completion pass: a tampered existing entry stays for deep validation to report rather than
    // blocking the residue cleanup.
    if (isMaterialStep(stepName) && Array.isArray(lastHistory.archived_artifacts)) {
      writeRevisionArchiveFiles(
        outputDirectory,
        publicationId,
        lastHistory.archived_artifacts,
        canonicalBytesByKind,
        { onExistingMismatch: "skip" },
      );
    }
    const removed = removeTransactionDirectory(outputDirectory, publicationId);
    return {
      process: record,
      publication_id: publicationId,
      status: removed ? "cleaned" : "unchanged",
      step_name: stepName,
    };
  }, lockOptions);
}

function outputSetupFailureDetails(error) {
  const code = typeof error?.code === "string" && error.code ? error.code : "unknown";
  return [`filesystem error code: ${code}`];
}

function closeRunningStepForOutputSetupFailure(log, record, timestamp, error) {
  const step = record.steps.get_vacancy;
  if (step.state !== "running" || step.active_attempt === null) return false;
  closeRunningStepAsFailed({
    diagnostic: {
      code: "output_setup_failed",
      message: "The reserved output directory could not be created.",
      retryable: true,
      details: outputSetupFailureDetails(error),
    },
    log,
    record,
    stepName: "get_vacancy",
    timestamp,
  });
  return true;
}

function createReservedOutputDirectory({
  log,
  mkdirDirectory,
  outputDir,
  outputPath,
  outputRealPath,
  record,
  timestamp,
  write,
}) {
  const segment = outputDir.slice("output/".length);
  const targetPath = resolve(outputPath, segment);
  try {
    mkdirDirectory(targetPath);
    if (!validateOwnedOutputDirectory(outputPath, outputRealPath, outputDir)) {
      const error = new Error("mkdir did not create the reserved directory");
      error.code = "ENOENT";
      throw error;
    }
  } catch (error) {
    if (closeRunningStepForOutputSetupFailure(log, record, timestamp, error)) {
      write(log);
    }
    throw new ProcessLogLifecycleError(
      "output_setup_failed",
      `could not create ${outputDir} (${error.code ?? "unknown"})`,
    );
  }
}

export function createCanonicalOutputSegment(companyObserved, role) {
  const company = requireNonEmptyString(
    companyObserved,
    "companyObserved",
    "invalid_output_identity",
  );
  const exactRole = requireNonEmptyString(role, "role", "invalid_output_identity");
  const normalized = `${company}-${exactRole}`
    .normalize("NFC")
    .toLowerCase()
    .normalize("NFC");
  const segment = normalized
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!segment) {
    throw new ProcessLogLifecycleError(
      "invalid_output_identity",
      "companyObserved and role do not produce a non-empty output segment",
    );
  }
  return segment;
}

export function reserveFileBackedOutputV3(
  logPath,
  input,
  {
    clock = () => new Date().toISOString(),
    lockOptions,
    mkdirDirectory = (directory) => mkdirSync(directory),
    outputRoot,
    workspaceRoot,
  } = {},
) {
  assertExactKeys(
    input,
    ["processId"],
    "invalid_reserve_output_input",
    "reserve-output input",
  );
  const processId = requireNonEmptyString(
    input.processId,
    "processId",
    "invalid_reserve_output_input",
  );
  if (typeof mkdirDirectory !== "function") {
    throw new ProcessLogLifecycleError(
      "invalid_output_environment",
      "mkdirDirectory must be a function",
    );
  }
  const environment = resolveOutputEnvironment(workspaceRoot, outputRoot);

  return withLogV3Lock(logPath, ({ log, write }) => {
    const record = getFileBackedProcessForMutation(log, processId, "reserve-output");
    const step = record.steps.get_vacancy;

    if (record.output_dir !== null) {
      const existing = validateOwnedOutputDirectory(
        environment.outputPath,
        environment.outputRealPath,
        record.output_dir,
      );
      if (existing) {
        return {
          status: "unchanged",
          output_dir: record.output_dir,
          process: record,
        };
      }
      if (step.state !== "running" || step.active_attempt === null) {
        throw new ProcessLogLifecycleError(
          "step_not_running",
          "get_vacancy must be running to recover a missing reserved output directory",
        );
      }
      const recoveredAt = recordMutationTimestamp(clock, log, record);
      createReservedOutputDirectory({
        log,
        mkdirDirectory,
        outputDir: record.output_dir,
        outputPath: environment.outputPath,
        outputRealPath: environment.outputRealPath,
        record,
        timestamp: recoveredAt,
        write,
      });
      return {
        status: "recovered",
        output_dir: record.output_dir,
        process: record,
      };
    }

    if (record.company_observed === null || record.role === null) {
      throw new ProcessLogLifecycleError(
        "output_identity_incomplete",
        "exact company_observed and role are required before output reservation",
      );
    }
    if (step.state !== "running" || step.active_attempt === null) {
      throw new ProcessLogLifecycleError(
        "step_not_running",
        "get_vacancy must be running before output reservation",
      );
    }

    const baseSegment = createCanonicalOutputSegment(record.company_observed, record.role);
    const occupiedKeys = filesystemOutputKeys(environment.outputPath);
    for (const candidate of log.processes) {
      if (candidate.output_dir !== null) {
        occupiedKeys.add(outputDirEquivalenceKey(candidate.output_dir));
      }
    }

    let suffix = 1;
    let outputDir;
    while (true) {
      const segment = suffix === 1 ? baseSegment : `${baseSegment}-${suffix}`;
      const candidate = normalizeOutputDir(`output/${segment}`);
      if (!occupiedKeys.has(outputDirEquivalenceKey(candidate))) {
        outputDir = candidate;
        break;
      }
      suffix += 1;
    }

    const reservedAt = recordMutationTimestamp(clock, log, record);
    record.output_dir = outputDir;
    touchFileBackedRecord(log, record, reservedAt);
    write(log);

    createReservedOutputDirectory({
      log,
      mkdirDirectory,
      outputDir,
      outputPath: environment.outputPath,
      outputRealPath: environment.outputRealPath,
      record,
      timestamp: reservedAt,
      write,
    });
    return {
      status: "reserved",
      output_dir: outputDir,
      process: record,
    };
  }, lockOptions);
}

export function createPendingFileBackedStep() {
  return {
    state: "pending",
    attempt: 0,
    revision: 0,
    started_at: null,
    updated_at: null,
    finished_at: null,
    published_inputs: [],
    artifacts: [],
    active_attempt: null,
    publication_transaction: null,
    attempt_history: [],
    error: null,
    blocker: null,
  };
}

export function createInitialGetVacancyStep({ attemptId, startedAt }) {
  return {
    state: "running",
    attempt: 1,
    revision: 0,
    started_at: startedAt,
    updated_at: startedAt,
    finished_at: null,
    published_inputs: [],
    artifacts: [],
    active_attempt: {
      id: attemptId,
      started_at: startedAt,
      expected_revision: 0,
      expected_artifacts: [],
      input_snapshot: [],
    },
    publication_transaction: null,
    attempt_history: [],
    error: null,
    blocker: null,
  };
}

export function createInitialFileBackedProcess({
  attemptId,
  companyHint = null,
  duplicateOf = null,
  processId,
  runner,
  sourceRef,
  startedAt,
}) {
  const steps = Object.fromEntries(
    fileBackedStepNames.map((stepName) => [stepName, createPendingFileBackedStep()]),
  );
  steps.get_vacancy = createInitialGetVacancyStep({ attemptId, startedAt });
  return {
    id: processId,
    started_at: startedAt,
    updated_at: startedAt,
    source_ref: sourceRef,
    source_key: normalizeSourceRef(sourceRef),
    company_id: null,
    company_observed: null,
    company_hint: companyHint,
    role: null,
    runner,
    output_dir: null,
    artifact_mode: "file-backed",
    steps,
    duplicate_of: duplicateOf,
  };
}

export function getFileBackedProcessForMutation(log, processId, operation) {
  const id = requireNonEmptyString(processId, "process id", "invalid_process_target");
  const operationName = requireNonEmptyString(operation, "operation", "invalid_process_target");
  const record = log.processes.find((candidate) => candidate.id === id);
  if (!record) {
    throw new ProcessLogLifecycleError("process_not_found", `unknown process id: ${id}`);
  }
  if (classifyProcessRecord(record) === "historical") {
    throw historicalReadOnlyError(record, operationName);
  }
  return record;
}

// Identity lookup stops reading the stored key (ADR 0013 rows 19 and 21). It compares the key the
// current policy computes from each immutable reference, on both sides. A record written before the
// cutover keeps its stored key forever — it is never re-keyed — so a lookup that read that key would
// answer a question about the policy in force when the record was written rather than about the
// posting the caller is holding.
//
// Precondition: a log that has passed validation, so every reference normalizes. The keys are
// recomputed on every call rather than cached, because the ledger is small and a cache keyed by
// anything other than the reference would be one more thing that can disagree with the normalizer.
function processesWithComputedSourceKey(log, sourceKey) {
  return log.processes.filter(
    (record) => normalizeSourceRef(record.source_ref) === sourceKey,
  );
}

function describeLegacySourceCollision(sourceRef, matches) {
  const collisionMatches = matches
    .map((record) => ({
      process_id: record.id,
      source_ref: record.source_ref,
      duplicate_of: record.duplicate_of,
      witnesses: legacySourceRefCollisionWitnesses(sourceRef, record.source_ref),
    }))
    .filter((record) => record.witnesses.length > 0)
    .sort((left, right) => left.process_id.localeCompare(right.process_id));
  if (collisionMatches.length === 0) return null;
  return {
    code: "legacy_source_key_collision",
    status: "ambiguous",
    requested_source_ref: sourceRef,
    matches: collisionMatches,
  };
}

export function resolveFileBackedProcessV3(log, selector) {
  validateLogV3(log);
  const selectorKeys = ["id", "sourceRef", "outputDir"];
  assertExactKeys(selector, selectorKeys, "process_selector_conflict", "process selector");
  const suppliedKeys = selectorKeys.filter((key) => Object.hasOwn(selector, key));
  if (suppliedKeys.length !== 1) {
    throw new ProcessLogLifecycleError(
      "process_selector_conflict",
      "process selector must provide exactly one of id, sourceRef, or outputDir",
    );
  }

  const selectorKey = suppliedKeys[0];
  const selectorValue = requireNonEmptyString(
    selector[selectorKey],
    selectorKey,
    "invalid_process_selector",
  );
  let matches;
  let renderedSelector;
  if (selectorKey === "id") {
    matches = log.processes.filter((record) => record.id === selectorValue);
    renderedSelector = selectorValue;
  } else if (selectorKey === "sourceRef") {
    const sourceKey = normalizeSourceRef(selectorValue);
    matches = processesWithComputedSourceKey(log, sourceKey);
    renderedSelector = sourceKey;
  } else {
    let normalizedOutputDir;
    try {
      normalizedOutputDir = normalizeOutputDir(selectorValue);
    } catch (error) {
      throw new ProcessLogLifecycleError("invalid_process_selector", error.message);
    }
    const outputKey = outputDirEquivalenceKey(normalizedOutputDir);
    matches = log.processes.filter(
      (record) =>
        record.output_dir !== null
        && outputDirEquivalenceKey(record.output_dir) === outputKey,
    );
    renderedSelector = normalizedOutputDir;
  }

  if (matches.length === 0) {
    throw new ProcessLogLifecycleError(
      "process_not_found",
      `no process matches ${selectorKey}: ${renderedSelector}`,
    );
  }
  if (
    selectorKey === "sourceRef"
    && describeLegacySourceCollision(selectorValue, matches) !== null
  ) {
    throw new ProcessLogLifecycleError(
      "process_ambiguous",
      "legacy source-key collision makes sourceRef ambiguous; use an exact process id",
    );
  }
  if (matches.length > 1) {
    throw new ProcessLogLifecycleError(
      "process_ambiguous",
      `${matches.length} processes match ${selectorKey}: ${renderedSelector}`,
    );
  }
  if (classifyProcessRecord(matches[0]) === "historical") {
    throw historicalReadOnlyError(matches[0], "resolve for file-backed work");
  }
  return matches[0];
}

export function updateFileBackedProcessV3(
  logPath,
  input,
  {
    clock = () => new Date().toISOString(),
    lockOptions,
  } = {},
) {
  const allowedKeys = ["processId", "companyObserved", "companyHint", "role"];
  assertExactKeys(input, allowedKeys, "invalid_update_input", "update input");
  const processId = requireNonEmptyString(
    input.processId,
    "processId",
    "invalid_update_input",
  );
  const updateKeys = allowedKeys
    .slice(1)
    .filter((key) => Object.hasOwn(input, key));
  if (updateKeys.length === 0) {
    throw new ProcessLogLifecycleError(
      "invalid_update_input",
      "update requires companyObserved, companyHint, and/or role",
    );
  }

  const updates = {};
  for (const key of updateKeys) {
    if (key === "companyHint" && input[key] === null) {
      updates[key] = null;
    } else {
      updates[key] = requireNonEmptyString(input[key], key, "invalid_update_input");
    }
  }
  const fieldByInputKey = {
    companyHint: "company_hint",
    companyObserved: "company_observed",
    role: "role",
  };

  return updateLogV3Atomic(logPath, (log) => {
    const record = getFileBackedProcessForMutation(log, processId, "update");
    const changedKeys = updateKeys.filter(
      (key) => record[fieldByInputKey[key]] !== updates[key],
    );
    if (changedKeys.length === 0) {
      return {
        changed: false,
        result: {
          status: "unchanged",
          process: record,
        },
      };
    }
    const changesPublishedIdentity = changedKeys.some(
      (key) => key === "companyObserved" || key === "role",
    );
    if (changesPublishedIdentity) {
      const step = record.steps.get_vacancy;
      if (step.publication_transaction !== null) {
        throw new ProcessLogLifecycleError(
          "publication_recovery_required",
          "get_vacancy has a prepared publication that must be reconciled",
        );
      }
      if (step.state !== "running" || step.active_attempt === null) {
        throw new ProcessLogLifecycleError(
          "identity_update_not_authorized",
          "companyObserved and role may change only during an active get_vacancy attempt; retry or reopen the step first",
        );
      }
    }
    for (const key of updateKeys) {
      record[fieldByInputKey[key]] = updates[key];
    }
    touchFileBackedRecord(
      log,
      record,
      recordMutationTimestamp(clock, log, record),
    );
    return {
      result: {
        status: "updated",
        process: record,
      },
    };
  }, lockOptions);
}

export function linkFileBackedProcessCompanyV3(
  logPath,
  input,
  {
    clock = () => new Date().toISOString(),
    lockOptions,
  } = {},
) {
  const allowedKeys = ["processId", "companyId"];
  assertExactKeys(input, allowedKeys, "invalid_link_company_input", "link-company input");
  const processId = requireNonEmptyString(
    input.processId,
    "processId",
    "invalid_link_company_input",
  );
  const companyId = requireNonEmptyString(
    input.companyId,
    "companyId",
    "invalid_link_company_input",
  );

  return updateLogV3Atomic(logPath, (log) => {
    const record = getFileBackedProcessForMutation(log, processId, "link-company");
    const company = log.companies.find((candidate) => candidate.id === companyId);
    if (!company) {
      throw new ProcessLogLifecycleError(
        "company_not_found",
        `unknown company id: ${companyId}`,
      );
    }
    if (record.company_id === company.id) {
      return {
        changed: false,
        result: {
          status: "unchanged",
          process: record,
          company,
        },
      };
    }
    record.company_id = company.id;
    touchFileBackedRecord(
      log,
      record,
      recordMutationTimestamp(clock, log, record),
    );
    return {
      result: {
        status: "linked",
        process: record,
        company,
      },
    };
  }, lockOptions);
}

// Existence and non-self-reference are ADR 0013 row 17 — a different rule from the duplicate-group
// invariant, and the one that gives an operator a reason rather than a flat "failed structural
// validation" from the writer's own load check.
function requireDuplicateTarget(log, duplicateOf, recordId) {
  if (recordId !== null && duplicateOf === recordId) {
    throw new ProcessLogLifecycleError(
      "invalid_duplicate_reference",
      `duplicate_of cannot reference the process itself: ${duplicateOf}`,
    );
  }
  const target = log.processes.find((candidate) => candidate.id === duplicateOf);
  if (!target) {
    throw new ProcessLogLifecycleError(
      "invalid_duplicate_reference",
      `duplicate_of references an unknown process: ${duplicateOf}`,
    );
  }
  return target;
}

function assertDuplicateLinkWritable(log, { duplicateOf, recordId, sourceRef }) {
  const error = duplicateLinkWriteError(log.processes, normalizeSourceRef, {
    duplicateOf,
    recordId,
    sourceRef,
  });
  if (error !== null) throw new ProcessLogLifecycleError("invalid_duplicate_reference", error);
}

// A link across two different keys is what the user declared and is never refused. It is still
// worth saying out loud: before task 010 the refusal was the only place an operator saw that a
// source-key policy change had separated two references, and a silent acceptance would have taken
// that signal away without replacing it.
function describeCrossSourceLink(sourceKey, target) {
  const targetSourceKey = normalizeSourceRef(target.source_ref);
  if (targetSourceKey === sourceKey) return null;
  return {
    code: "cross_source_duplicate_link",
    source_key: sourceKey,
    duplicate_of: target.id,
    duplicate_of_source_key: targetSourceKey,
  };
}

// Following `duplicate_of` from the prospective target must not come back to the record. The
// duplicate-group invariant checks membership, never acyclicity, and ADR 0013 records that both of
// today's writers produce acyclic links only because neither can name a record that points back:
// `start` allocates a fresh id, and the historical importer always links to a group's first record.
// Late linking is the first writer that can close a loop, so it is the first that has to look. The
// walk carries a visited set because a ledger assembled outside these writers already loads with a
// cycle in it.
function assertNoDuplicateLinkCycle(log, recordId, duplicateOf) {
  const byId = new Map(log.processes.map((record) => [record.id, record]));
  const seen = new Set([recordId]);
  let cursor = duplicateOf;
  while (cursor !== null && cursor !== undefined) {
    if (cursor === recordId) {
      throw new ProcessLogLifecycleError(
        "invalid_duplicate_reference",
        `duplicate_of would close a cycle back to ${recordId}`,
      );
    }
    if (seen.has(cursor)) return;
    seen.add(cursor);
    cursor = byId.get(cursor)?.duplicate_of ?? null;
  }
}

// Late linking and its correction (task 010). Provenance only: the operation writes `duplicate_of`
// and the mutation timestamps and touches nothing else, so a completed step is not redone and an
// output directory is not reused. The target — historical or not — is only ever read: its id, its
// reference, whose key the cross-key report names and the group rule compares, and its own
// `duplicate_of` for the cycle walk.
export function linkFileBackedProcessDuplicateV3(
  logPath,
  input,
  {
    clock = () => new Date().toISOString(),
    lockOptions,
  } = {},
) {
  const allowedKeys = ["processId", "duplicateOf"];
  assertExactKeys(input, allowedKeys, "invalid_link_duplicate_input", "link-duplicate input");
  const processId = requireNonEmptyString(
    input.processId,
    "processId",
    "invalid_link_duplicate_input",
  );
  const duplicateOf = normalizeNullableString(input.duplicateOf);

  return updateLogV3Atomic(logPath, (log) => {
    const record = getFileBackedProcessForMutation(log, processId, "link-duplicate");
    let crossSourceLink = null;
    if (duplicateOf !== null) {
      const target = requireDuplicateTarget(log, duplicateOf, processId);
      assertNoDuplicateLinkCycle(log, processId, duplicateOf);
      crossSourceLink = describeCrossSourceLink(normalizeSourceRef(record.source_ref), target);
    }
    assertDuplicateLinkWritable(log, {
      duplicateOf,
      recordId: processId,
      sourceRef: record.source_ref,
    });
    if (record.duplicate_of === duplicateOf) {
      return {
        changed: false,
        result: {
          status: "unchanged",
          process: record,
        },
      };
    }
    record.duplicate_of = duplicateOf;
    touchFileBackedRecord(
      log,
      record,
      recordMutationTimestamp(clock, log, record),
    );
    const result = {
      status: duplicateOf === null ? "cleared" : "linked",
      process: record,
    };
    if (crossSourceLink !== null) result.cross_source_link = crossSourceLink;
    return { result };
  }, lockOptions);
}

export function startFileBackedProcessV3(
  logPath,
  {
    companyHint = null,
    duplicateOf = null,
    runner,
    sourceRef,
  },
  {
    attemptIdFactory = () => createAttemptId(randomUUID()),
    clock = () => new Date().toISOString(),
    lockOptions,
    processIdFactory,
  } = {},
) {
  const normalizedSourceRef = requireNonEmptyString(sourceRef, "source_ref");
  const normalizedRunner = requireNonEmptyString(runner, "runner");
  if (!allowedRunners.has(normalizedRunner) || normalizedRunner === "claude-ai-web") {
    throw new ProcessLogLifecycleError(
      "invalid_runner",
      `runner must be one of: ${[...allowedRunners].filter((value) => value !== "claude-ai-web").join(", ")}`,
    );
  }
  const normalizedCompanyHint = normalizeNullableString(companyHint);
  const normalizedDuplicateOf = normalizeNullableString(duplicateOf);
  const sourceKey = normalizeSourceRef(normalizedSourceRef);

  return updateLogV3Atomic(logPath, (log) => {
    const matches = processesWithComputedSourceKey(log, sourceKey);
    const collisionEvidence = describeLegacySourceCollision(normalizedSourceRef, matches);
    const collision = collisionEvidence === null
      ? null
      : {
          ...collisionEvidence,
          source_key: sourceKey,
          requires_final_url_check: true,
          requires_explicit_duplicate_of: normalizedDuplicateOf === null,
        };
    if (matches.length > 0 && normalizedDuplicateOf === null) {
      return {
        changed: false,
        result: {
          status: "duplicate",
          source_key: sourceKey,
          matches,
          collision,
        },
      };
    }
    let crossSourceLink = null;
    if (normalizedDuplicateOf !== null) {
      const target = requireDuplicateTarget(log, normalizedDuplicateOf, null);
      assertDuplicateLinkWritable(log, {
        duplicateOf: normalizedDuplicateOf,
        recordId: null,
        sourceRef: normalizedSourceRef,
      });
      crossSourceLink = describeCrossSourceLink(sourceKey, target);
    }

    const startedAt = mutationTimestamp(clock, log.updated_at);
    const processIds = new Set(log.processes.map((record) => record.id));
    const resolvedProcessIdFactory = processIdFactory
      ?? (() => createProcessId(startedAt, randomUUID()));
    const processId = allocateUniqueId(
      processIds,
      resolvedProcessIdFactory,
      "process_id_conflict",
      "process id",
    );
    const attemptId = allocateUniqueId(
      activeAttemptIds(log),
      attemptIdFactory,
      "active_attempt_id_conflict",
      "active attempt id",
    );
    const processRecord = createInitialFileBackedProcess({
      attemptId,
      companyHint: normalizedCompanyHint,
      duplicateOf: normalizedDuplicateOf,
      processId,
      runner: normalizedRunner,
      sourceRef: normalizedSourceRef,
      startedAt,
    });
    log.processes.push(processRecord);
    log.processes.sort((left, right) =>
      Date.parse(left.started_at) - Date.parse(right.started_at)
        || left.id.localeCompare(right.id),
    );
    log.updated_at = startedAt;
    const result = {
      status: "created",
      process: processRecord,
    };
    if (collision !== null) result.collision = collision;
    if (crossSourceLink !== null) result.cross_source_link = crossSourceLink;
    return { result };
  }, lockOptions);
}
