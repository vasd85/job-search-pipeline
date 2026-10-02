import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  classifyProcessRecord,
  fileBackedStepNames,
  outputDirEquivalenceKey,
  searchProcessesV3,
  withLogV3Lock,
} from "./process-log-core.mjs";
import {
  fileBackedStepDependencies,
  inspectProcessLogV3Deep,
} from "./process-log-v3-lifecycle.mjs";
import { sha256Hex } from "../pipeline-artifacts/validation.mjs";

export const webReadableArtifactKinds = Object.freeze([
  "job_description",
  "vacancy",
  "company_research",
  "application_brief",
  "cover_letter",
]);

const webReadableArtifactKindSet = new Set(webReadableArtifactKinds);
const jsonArtifactKinds = new Set(["vacancy", "company_research", "application_brief"]);
const corruptArtifactHealth = new Set(["corrupt", "recovery_required"]);
const missingInputHealth = new Set(["missing"]);
const unavailableInputHealth = new Set(["unavailable"]);

export class ProcessSearchPublicError extends Error {
  constructor(code, status = 500) {
    super(code);
    this.name = "ProcessSearchPublicError";
    this.code = code;
    this.status = status;
  }
}

function publicError(code, status) {
  return new ProcessSearchPublicError(code, status);
}

function healthByStep(processHealth) {
  return new Map(processHealth.steps.map((step) => [step.name, step]));
}

function fallbackStepHealth(stepName, step) {
  return {
    name: stepName,
    state: step.state,
    artifact_health: step.revision > 0 ? "current" : "not_published",
    input_health: step.revision > 0 ? "current" : "not_published",
    issues: [],
  };
}

function selectedStepHealth(stepName, step, byStep) {
  return byStep.get(stepName) ?? fallbackStepHealth(stepName, step);
}

function stepIsCurrentCompleted(step, health) {
  return (
    step.state === "completed" &&
    health.artifact_health === "current" &&
    health.input_health === "current"
  );
}

function stepEffectiveState(step, health) {
  if (
    step.state === "stale" ||
    (step.revision > 0 && ["stale", "unavailable"].includes(health.input_health))
  ) {
    return "stale";
  }
  return step.state;
}

function stepNeedsAttention(step, health) {
  return (
    ["blocked", "failed", "stale"].includes(step.state) ||
    ["missing", "corrupt", "recovery_required"].includes(health.artifact_health) ||
    ["missing", "stale", "unavailable"].includes(health.input_health)
  );
}

function dependenciesAreCurrent(process, byStep, stepName) {
  return fileBackedStepDependencies[stepName].every((dependencyName) => {
    const dependency = process.steps[dependencyName];
    const dependencyHealth = selectedStepHealth(dependencyName, dependency, byStep);
    return stepIsCurrentCompleted(dependency, dependencyHealth);
  });
}

function stepIsActionable(process, byStep, stepName) {
  const step = process.steps[stepName];
  const health = selectedStepHealth(stepName, step, byStep);
  if (
    ["missing", "corrupt", "recovery_required"].includes(health.artifact_health) ||
    missingInputHealth.has(health.input_health) ||
    unavailableInputHealth.has(health.input_health)
  ) {
    return false;
  }
  if (!dependenciesAreCurrent(process, byStep, stepName)) return false;
  if (step.state === "pending" || step.state === "stale") return true;
  if (health.input_health === "stale") return true;
  return step.state === "failed" && step.error?.retryable === true;
}

function siblingAggregate(leftState, rightState) {
  const states = [leftState, rightState];
  if (states.includes("running")) return "running";
  if (states.includes("stale")) return "stale";
  if (states.includes("failed")) return "failed";
  if (states.includes("blocked")) return "blocked";
  if (states.every((state) => state === "completed")) return "complete";
  return "ready";
}

function latestCompletedStep(process) {
  const completed = fileBackedStepNames
    .map((stepName) => {
      const attempt = [...(process.steps[stepName].attempt_history ?? [])]
        .reverse()
        .find((candidate) => candidate.outcome === "completed");
      return {
        name: stepName,
        finishedAt: attempt?.finished_at ?? null,
      };
    })
    .filter(({ finishedAt }) => finishedAt !== null)
    .sort(
      (left, right) =>
        right.finishedAt.localeCompare(left.finishedAt) ||
        fileBackedStepNames.indexOf(right.name) - fileBackedStepNames.indexOf(left.name),
    );
  return completed[0]?.name ?? null;
}

function countReadableArtifacts(process, byStep) {
  let count = 0;
  for (const stepName of fileBackedStepNames) {
    const step = process.steps[stepName];
    const health = selectedStepHealth(stepName, step, byStep);
    if (step.revision === 0 || health.artifact_health !== "current") continue;
    count += step.artifacts.filter((artifact) =>
      webReadableArtifactKindSet.has(artifact.kind),
    ).length;
  }
  return count;
}

function processHasCurrentCv(process, byStep) {
  const step = process.steps.generate_cv;
  const health = selectedStepHealth("generate_cv", step, byStep);
  if (step.revision === 0 || health.artifact_health !== "current") return false;
  const kinds = new Set(step.artifacts.map((artifact) => artifact.kind));
  return kinds.has("cv_source") && kinds.has("cv_docx");
}

export function derivePublicLifecycle(process, processHealth) {
  if (classifyProcessRecord(process) === "historical") {
    return {
      state: "historical",
      completed_steps: [],
      actionable_steps: [],
      attention_steps: [],
      running_steps: [],
      last_completed_step: null,
      has_stale: false,
      has_corrupt: false,
      has_missing: false,
      readable_artifact_count: 0,
      has_cv: false,
      manual_review_required: false,
    };
  }

  const byStep = healthByStep(processHealth);
  const hasCorrupt =
    processHealth.output.health === "invalid" ||
    fileBackedStepNames.some((stepName) => {
      const step = process.steps[stepName];
      return corruptArtifactHealth.has(selectedStepHealth(stepName, step, byStep).artifact_health);
    });
  const hasMissing =
    processHealth.output.health === "missing" ||
    fileBackedStepNames.some((stepName) => {
      const step = process.steps[stepName];
      const health = selectedStepHealth(stepName, step, byStep);
      return health.artifact_health === "missing" || health.input_health === "missing";
    });
  const hasStale = fileBackedStepNames.some((stepName) => {
    const step = process.steps[stepName];
    const health = selectedStepHealth(stepName, step, byStep);
    return (
      step.state === "stale" ||
      (step.revision > 0 && ["stale", "unavailable"].includes(health.input_health))
    );
  });

  const completedSteps = fileBackedStepNames.filter((stepName) => {
    const step = process.steps[stepName];
    return stepIsCurrentCompleted(step, selectedStepHealth(stepName, step, byStep));
  });
  const runningSteps = fileBackedStepNames.filter(
    (stepName) => process.steps[stepName].state === "running",
  );
  const attentionSteps = fileBackedStepNames.filter((stepName) => {
    const step = process.steps[stepName];
    return stepNeedsAttention(step, selectedStepHealth(stepName, step, byStep));
  });
  if (["missing", "invalid"].includes(processHealth.output.health) && attentionSteps.length === 0) {
    attentionSteps.push("get_vacancy");
  }
  const actionableSteps = fileBackedStepNames.filter((stepName) =>
    stepIsActionable(process, byStep, stepName),
  );

  let state;
  if (hasCorrupt) {
    state = "corrupt";
  } else if (hasMissing) {
    state = "missing";
  } else {
    state = null;
    for (const stepName of ["get_vacancy", "research_company", "map_experience"]) {
      const step = process.steps[stepName];
      const effectiveState = stepEffectiveState(step, selectedStepHealth(stepName, step, byStep));
      if (effectiveState === "completed") continue;
      state = effectiveState === "pending" ? "ready" : effectiveState;
      break;
    }
    if (state === null) {
      const cvState = stepEffectiveState(
        process.steps.generate_cv,
        selectedStepHealth("generate_cv", process.steps.generate_cv, byStep),
      );
      const letterState = stepEffectiveState(
        process.steps.write_cover_letter,
        selectedStepHealth("write_cover_letter", process.steps.write_cover_letter, byStep),
      );
      state = siblingAggregate(cvState, letterState);
    }
  }

  return {
    state,
    completed_steps: completedSteps,
    actionable_steps: actionableSteps,
    attention_steps: attentionSteps,
    running_steps: runningSteps,
    last_completed_step: latestCompletedStep(process),
    has_stale: hasStale,
    has_corrupt: hasCorrupt,
    has_missing: hasMissing,
    readable_artifact_count: countReadableArtifacts(process, byStep),
    has_cv: processHasCurrentCv(process, byStep),
    manual_review_required: completedSteps.length > 0,
  };
}

function publicCompany(company, { detail = false } = {}) {
  if (company === null) return null;
  const result = {
    id: company.id,
    display_name: company.display_name,
  };
  if (detail) result.domains = [...company.domains];
  return result;
}

function publicListProcess(process, lifecycle) {
  return {
    id: process.id,
    mode: classifyProcessRecord(process),
    company_observed: process.company_observed,
    company_hint: process.company_hint,
    role: process.role,
    source_ref: process.source_ref,
    started_at: process.started_at,
    updated_at: process.updated_at ?? null,
    lifecycle_state: lifecycle.state,
    last_completed_step: lifecycle.last_completed_step,
    completed_steps: lifecycle.completed_steps,
    actionable_steps: lifecycle.actionable_steps,
    attention_steps: lifecycle.attention_steps,
    running_steps: lifecycle.running_steps,
    readable_artifact_count: lifecycle.readable_artifact_count,
    has_cv: lifecycle.has_cv,
    manual_review_required: lifecycle.manual_review_required,
    has_stale: lifecycle.has_stale,
    has_corrupt: lifecycle.has_corrupt,
    has_missing: lifecycle.has_missing,
  };
}

function findProcessHealth(report, processId) {
  const health = report.processes.find((candidate) => candidate.process_id === processId);
  if (!health) throw publicError("process_health_unavailable", 500);
  return health;
}

export function buildPublicProcessList({ log, report, query = "" }) {
  const results = searchProcessesV3(log, query).map((result) => {
    const processHealth = findProcessHealth(report, result.process.id);
    const lifecycle = derivePublicLifecycle(result.process, processHealth);
    return {
      process: publicListProcess(result.process, lifecycle),
      company: publicCompany(result.company),
      matched_by: result.match ? { type: result.match.type } : null,
    };
  });
  return {
    query,
    count: results.length,
    total_processes: log.processes.length,
    total_companies: log.companies.length,
    results,
  };
}

function publicStepTimeline(process, processHealth) {
  const byStep = healthByStep(processHealth);
  return fileBackedStepNames.map((stepName) => {
    const step = process.steps[stepName];
    const health = selectedStepHealth(stepName, step, byStep);
    const diagnostic = step.blocker
      ? {
          type: "blocker",
          code: step.blocker.code,
          retryable: step.blocker.retryable,
        }
      : step.error
        ? {
            type: "error",
            code: step.error.code,
            retryable: step.error.retryable,
          }
        : null;
    return {
      name: stepName,
      state: step.state,
      started_at: step.started_at,
      updated_at: step.updated_at,
      finished_at: step.finished_at,
      artifact_health: health.artifact_health,
      input_health: health.input_health,
      issues: [...health.issues],
      diagnostic,
    };
  });
}

function publicArtifacts(process, processHealth) {
  const byStep = healthByStep(processHealth);
  const artifacts = [];
  for (const stepName of fileBackedStepNames) {
    const step = process.steps[stepName];
    const health = selectedStepHealth(stepName, step, byStep);
    if (step.revision === 0 || health.artifact_health !== "current") continue;
    for (const artifact of step.artifacts) {
      if (!webReadableArtifactKindSet.has(artifact.kind)) continue;
      artifacts.push({
        kind: artifact.kind,
        step: stepName,
        schema_version: artifact.schema_version,
        bytes: artifact.bytes,
        read_url: `/api/processes/${encodeURIComponent(process.id)}/artifacts/${artifact.kind}`,
      });
    }
  }
  return artifacts;
}

function publicCv(process, lifecycle, processHealth) {
  if (!lifecycle.has_cv) {
    return {
      status: process.steps.generate_cv.state,
      preview_available: false,
      docx_path: null,
    };
  }
  const cvHealth = processHealth.steps.find((step) => step.name === "generate_cv");
  const docx = process.steps.generate_cv.artifacts.find((artifact) => artifact.kind === "cv_docx");
  if (cvHealth?.artifact_health !== "current" || !docx || process.output_dir === null) {
    throw publicError("cv_metadata_unavailable", 500);
  }
  return {
    status: "published",
    preview_available: false,
    docx_path: `${process.output_dir}/${docx.path}`,
  };
}

export function buildPublicProcessDetail({ log, report, processId }) {
  const process = log.processes.find((candidate) => candidate.id === processId);
  if (!process) throw publicError("process_not_found", 404);
  const company = process.company_id
    ? (log.companies.find((candidate) => candidate.id === process.company_id) ?? null)
    : null;
  const processHealth = findProcessHealth(report, process.id);
  const lifecycle = derivePublicLifecycle(process, processHealth);
  const historical = classifyProcessRecord(process) === "historical";
  return {
    process: {
      id: process.id,
      mode: historical ? "historical" : "file-backed",
      company_observed: process.company_observed,
      company_hint: process.company_hint,
      role: process.role,
      source_ref: process.source_ref,
      started_at: process.started_at,
      updated_at: process.updated_at ?? null,
      runner: process.runner,
      output_dir: process.output_dir,
      duplicate_of: process.duplicate_of,
      historical_status: historical ? process.status : null,
    },
    company: publicCompany(company, { detail: true }),
    lifecycle,
    steps: historical ? [] : publicStepTimeline(process, processHealth),
    artifacts: historical ? [] : publicArtifacts(process, processHealth),
    cv: historical ? null : publicCv(process, lifecycle, processHealth),
    historical: historical
      ? {
          artifacts_available: false,
          code: "historical_artifacts_unavailable",
        }
      : null,
  };
}

function requireAbsoluteDirectory(directory, code) {
  if (typeof directory !== "string" || !isAbsolute(directory)) {
    throw publicError(code, 500);
  }
  let stats;
  try {
    stats = lstatSync(directory);
  } catch {
    throw publicError(code, 500);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw publicError(code, 500);
  }
  return resolve(directory);
}

function resolveArtifactEnvironment(workspaceRoot, outputRoot) {
  const workspacePath = requireAbsoluteDirectory(workspaceRoot, "artifact_environment_invalid");
  const outputPath = requireAbsoluteDirectory(outputRoot, "artifact_environment_invalid");
  if (outputPath !== resolve(workspacePath, "output")) {
    throw publicError("artifact_environment_invalid", 500);
  }
  let workspaceRealPath;
  let outputRealPath;
  try {
    workspaceRealPath = realpathSync(workspacePath);
    outputRealPath = realpathSync(outputPath);
  } catch {
    throw publicError("artifact_environment_invalid", 500);
  }
  if (outputRealPath !== resolve(workspaceRealPath, "output")) {
    throw publicError("artifact_environment_invalid", 500);
  }
  return {
    outputPath,
    outputRealPath,
  };
}

function pathIsWithin(parentPath, childPath) {
  const distance = relative(parentPath, childPath);
  return (
    distance === "" ||
    (distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance))
  );
}

function resolveOwnedOutputDirectory(environment, outputDir) {
  if (outputDir === null) throw publicError("output_not_reserved", 409);
  const segment = outputDir.slice("output/".length);
  let entries;
  try {
    entries = readdirSync(environment.outputPath);
  } catch {
    throw publicError("output_unavailable", 409);
  }
  const equivalent = entries.filter(
    (entry) => outputDirEquivalenceKey(`output/${entry}`) === outputDirEquivalenceKey(outputDir),
  );
  if (!equivalent.includes(segment) || equivalent.some((entry) => entry !== segment)) {
    throw publicError("output_missing_or_conflicting", 409);
  }
  const outputDirectory = resolve(environment.outputPath, segment);
  let stats;
  let realPath;
  try {
    stats = lstatSync(outputDirectory);
    realPath = realpathSync(outputDirectory);
  } catch {
    throw publicError("output_missing", 409);
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    relative(environment.outputRealPath, realPath) !== segment
  ) {
    throw publicError("output_path_invalid", 409);
  }
  return {
    path: outputDirectory,
    realPath,
  };
}

function readVerifiedArtifactFile(outputDirectory, metadata, maxBytes) {
  if (metadata.bytes > maxBytes) throw publicError("artifact_too_large", 413);
  const artifactPath = resolve(outputDirectory.path, metadata.path);
  if (!pathIsWithin(outputDirectory.path, artifactPath)) {
    throw publicError("artifact_path_invalid", 409);
  }

  let pathStats;
  let artifactRealPath;
  try {
    pathStats = lstatSync(artifactPath);
    artifactRealPath = realpathSync(artifactPath);
  } catch {
    throw publicError("artifact_missing", 404);
  }
  if (
    pathStats.isSymbolicLink() ||
    !pathStats.isFile() ||
    !pathIsWithin(outputDirectory.realPath, artifactRealPath)
  ) {
    throw publicError("artifact_path_invalid", 409);
  }

  let descriptor;
  try {
    descriptor = openSync(artifactPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStats = fstatSync(descriptor);
    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino
    ) {
      throw publicError("artifact_changed_during_read", 409);
    }
    const bytes = readFileSync(descriptor);
    if (
      bytes.byteLength !== metadata.bytes ||
      bytes.byteLength !== openedStats.size ||
      sha256Hex(bytes) !== metadata.sha256
    ) {
      throw publicError("artifact_corrupt", 409);
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw publicError("artifact_invalid_utf8", 422);
    }
    return bytes;
  } catch (error) {
    if (error instanceof ProcessSearchPublicError) throw error;
    if (error?.code === "ELOOP") throw publicError("artifact_path_invalid", 409);
    if (error?.code === "ENOENT") throw publicError("artifact_missing", 404);
    throw publicError("artifact_read_failed", 409);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readPublicProcessArtifact(
  { artifactKind, logPath, maxBytes = 1024 * 1024, outputRoot, processId, workspaceRoot },
  { lockOptions } = {},
) {
  if (!webReadableArtifactKindSet.has(artifactKind)) {
    throw publicError("artifact_not_found", 404);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw publicError("artifact_preview_limit_invalid", 500);
  }
  const environment = resolveArtifactEnvironment(workspaceRoot, outputRoot);
  return withLogV3Lock(
    logPath,
    ({ log }) => {
      const process = log.processes.find((candidate) => candidate.id === processId);
      if (!process) throw publicError("process_not_found", 404);
      if (classifyProcessRecord(process) === "historical") {
        throw publicError("historical_artifacts_unavailable", 409);
      }

      const owner = fileBackedStepNames
        .map((stepName) => ({
          stepName,
          step: process.steps[stepName],
          artifact: process.steps[stepName].artifacts.find(
            (candidate) => candidate.kind === artifactKind,
          ),
        }))
        .find((candidate) => candidate.artifact !== undefined);
      if (!owner || owner.step.revision === 0) {
        throw publicError("artifact_not_found", 404);
      }

      const report = inspectProcessLogV3Deep(log, {
        outputRoot,
        workspaceRoot,
      });
      const processHealth = findProcessHealth(report, process.id);
      const stepHealth = processHealth.steps.find((step) => step.name === owner.stepName);
      if (!stepHealth || stepHealth.artifact_health !== "current") {
        const code =
          {
            missing: "artifact_missing",
            corrupt: "artifact_corrupt",
            recovery_required: "publication_recovery_required",
          }[stepHealth?.artifact_health] ?? "artifact_unavailable";
        throw publicError(code, 409);
      }

      const outputDirectory = resolveOwnedOutputDirectory(environment, process.output_dir);
      const bytes = readVerifiedArtifactFile(outputDirectory, owner.artifact, maxBytes);
      return {
        bytes,
        contentType: jsonArtifactKinds.has(artifactKind)
          ? "application/json; charset=utf-8"
          : "text/plain; charset=utf-8",
      };
    },
    lockOptions,
  );
}
