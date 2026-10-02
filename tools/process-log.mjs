#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDuplicateChain,
  buildLegacySourceCollisionReport,
  buildSourceKeyVersionProjection,
  createCompanyRecord,
  deriveSearchTerms,
  normalizeDomain,
  normalizeSearchText,
  processLogCorePrimaryEvidence,
  processLogCoreSecondaryEvidence,
  processLogV3ValidationErrorEvidence,
  readLogV3,
  searchCompaniesV3,
  updateLogV3Atomic,
} from "./lib/process-log-core.mjs";
import {
  ProcessLogLifecycleError,
  beginFileBackedStepV3,
  cleanupFileBackedStagingV3,
  failFileBackedStepV3,
  linkFileBackedProcessCompanyV3,
  linkFileBackedProcessDuplicateV3,
  preflightFileBackedStepV3,
  publishFileBackedStepV3,
  reconcileFileBackedStepV3,
  reopenFileBackedStepV3,
  reserveFileBackedOutputV3,
  resolveFileBackedProcessV3,
  retryFileBackedStepV3,
  reviseFileBackedStepV3,
  startFileBackedProcessV3,
  updateFileBackedProcessV3,
  validateProcessLogV3Deep,
} from "./lib/process-log-v3-lifecycle.mjs";
import {
  SafeCliInputError,
  hydrateSafeCliOptions,
} from "./lib/safe-cli-input.mjs";
import {
  backupProcessLogV3,
  restoreProcessLogV3,
} from "./lib/process-log-ledger-rollback.mjs";
import { isEmployerDomainExcluded } from "./job-sources/registry.mjs";
import {
  processLogDiagnosticLimits,
  processLogDiagnosticProblems,
  processLogStableDiagnosticCodePattern,
} from "./lib/process-log-diagnostics.mjs";
import { OpsTreeError, verifyFolder } from "./ops-tree/manifest.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(
  process.env.JOB_PIPELINE_WORKSPACE_ROOT ?? repoRoot,
);
const outputRoot = resolve(
  process.env.JOB_PIPELINE_OUTPUT_ROOT ?? resolve(workspaceRoot, "output"),
);
const logPath = resolve(
  process.env.JOB_PIPELINE_PROCESS_LOG
    ?? resolve(workspaceRoot, "process-log.json"),
);
const inputRoot = process.env.JOB_PIPELINE_INPUT_ROOT
  ?? resolve(workspaceRoot, ".pipeline-input");
const booleanFlags = new Set(["adopt", "clear-company-hint", "clear-duplicate-of", "deep", "dry-run"]);
const selectorOptionNames = Object.freeze(["id", "source-ref", "output-dir"]);

class ProcessLogCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProcessLogCliError";
    this.code = code;
  }
}

function usage() {
  console.log(`Usage:
  node tools/process-log.mjs start --input-file INPUT_FILE --runner <runner> [--duplicate-of <id>]
  node tools/process-log.mjs update --id <id> --input-file INPUT_FILE [--clear-company-hint]
  node tools/process-log.mjs resolve (--id <id> | --output-dir output/<company-role> | --input-file INPUT_FILE)
  node tools/process-log.mjs reserve-output --id <id>
  node tools/process-log.mjs preflight-step <selector> --step <step-name>
  node tools/process-log.mjs begin-step <selector> --step <step-name>
  node tools/process-log.mjs publish-step <selector> --step <step-name> --attempt-id <id> --publication-id <id> --outcome <completed|blocked> [--input-file INPUT_FILE]
  node tools/process-log.mjs fail-step <selector> --step <step-name> --attempt-id <id> --input-file INPUT_FILE
  node tools/process-log.mjs retry-step <selector> --step <step-name>
  node tools/process-log.mjs reopen-step <selector> --step <step-name> [--adopt]
  node tools/process-log.mjs revise-step <selector> --step <step-name> --channel <chat_command|manual_file|docx_sync> [--adopt] [--input-file INPUT_FILE]
  node tools/process-log.mjs reconcile-step <selector> --step <step-name> [--attempt-id <id> --publication-id <id>]
  node tools/process-log.mjs cleanup-staging --id <process-id> --publication-id <id> [--dry-run | --confirmation-token <sha256>]
  node tools/process-log.mjs find-company --input-file INPUT_FILE
  node tools/process-log.mjs create-company --input-file INPUT_FILE
  node tools/process-log.mjs link-company --id <process-id> --company-id <company-id>
  node tools/process-log.mjs link-duplicate --id <process-id> (--duplicate-of <process-id> | --clear-duplicate-of)
  node tools/process-log.mjs rename-company --id <company-id> --input-file INPUT_FILE
  node tools/process-log.mjs add-company-term|remove-company-term --id <company-id> --input-file INPUT_FILE
  node tools/process-log.mjs add-company-domain|remove-company-domain --id <company-id> --input-file INPUT_FILE
  node tools/process-log.mjs report-duplicate-chain --id <process-id>
  node tools/process-log.mjs report-source-collisions
  node tools/process-log.mjs report-source-key-split
  node tools/process-log.mjs backup-ledger --backup-file process-log.backup-<label>.json
  node tools/process-log.mjs restore-ledger --backup-file <name> [--dry-run | --confirmation-token <sha256>]
  node tools/process-log.mjs validate [--deep]

Shell callers must transport every external value through --input-file. Backward-compatible
external-value flags remain available only to callers using a true structured argv API.
INPUT_FILE is a fresh basename matching input-<32 lowercase hexadecimal characters>.json; see
instructions/pipeline-artifacts.md for the structured producer procedure and exact envelope.

Test isolation environment:
  JOB_PIPELINE_PROCESS_LOG, JOB_PIPELINE_WORKSPACE_ROOT, JOB_PIPELINE_OUTPUT_ROOT,
  JOB_PIPELINE_INPUT_ROOT`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length;) {
    const flag = rest[index];
    if (!flag?.startsWith("--")) {
      throw new ProcessLogCliError(
        "invalid_cli_arguments",
        `Invalid argument near ${flag ?? "<end>"}`,
      );
    }
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) {
      throw new ProcessLogCliError(
        "invalid_cli_arguments",
        `Duplicate option: --${key}`,
      );
    }
    if (booleanFlags.has(key)) {
      options[key] = true;
      index += 1;
    } else {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ProcessLogCliError(
          "invalid_cli_arguments",
          `Missing value for --${key}`,
        );
      }
      options[key] = value;
      index += 2;
    }
  }
  return { command, options };
}

function assertAllowed(options, allowed) {
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new ProcessLogCliError(
      "invalid_cli_arguments",
      `Unknown option(s): ${unknown.map((key) => `--${key}`).join(", ")}`,
    );
  }
}

function requireOption(options, key) {
  const value = options[key]?.trim();
  if (!value) {
    throw new ProcessLogCliError(
      "invalid_cli_arguments",
      `Missing required option: --${key}`,
    );
  }
  return value;
}

function parseJsonOption(options, key) {
  const source = requireOption(options, key);
  try {
    return JSON.parse(source);
  } catch {
    throw new ProcessLogCliError(
      "invalid_cli_json",
      `--${key} must contain valid JSON`,
    );
  }
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function boundedCliErrorCode(value, fallback = "process_log_cli_failed") {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= processLogDiagnosticLimits.codeMaxBytes
    && processLogStableDiagnosticCodePattern.test(value)
    ? value
    : fallback;
}

function safeErrorProperty(error, property) {
  try {
    return error?.[property] ?? null;
  } catch {
    return null;
  }
}

function safeErrorIs(error, ErrorType) {
  try {
    return error instanceof ErrorType;
  } catch {
    return false;
  }
}

function safeErrorMessage(error) {
  const message = safeErrorProperty(error, "message");
  return typeof message === "string" ? message : null;
}

function printError(error) {
  const coreEvidence = processLogCorePrimaryEvidence(error);
  const validationEvidence = processLogV3ValidationErrorEvidence(error);
  const knownCommandError = safeErrorIs(error, ProcessLogLifecycleError)
    || safeErrorIs(error, ProcessLogCliError)
    || safeErrorIs(error, SafeCliInputError);
  const code = boundedCliErrorCode(
    coreEvidence?.code
      ?? validationEvidence?.code
      ?? (knownCommandError ? safeErrorProperty(error, "code") : null),
  );
  const prefix = `${code}: `;
  const observedMessage = safeErrorMessage(error);
  const rawMessage = observedMessage?.startsWith(prefix)
    ? observedMessage.slice(prefix.length)
    : observedMessage;
  let message;
  if (validationEvidence !== null) {
    message = "Process log failed structural validation.";
  } else if (coreEvidence !== null) {
    message = coreEvidence.message;
  } else if (
    typeof rawMessage === "string"
    && processLogDiagnosticProblems({
      code: "cli_error",
      message: rawMessage,
      details: [],
    }, "error").length === 0
  ) {
    message = rawMessage;
  } else {
    message = "Process-log command failed with a bounded repository diagnostic.";
  }
  const details = { code, message };
  if (coreEvidence !== null) {
    details.context = coreEvidence.context;
    details.cause_code = coreEvidence.causeCode;
    details.recovery_action = coreEvidence.recoveryAction;
  } else if (validationEvidence !== null) {
    details.context = validationEvidence.context;
    details.recovery_action = validationEvidence.recoveryAction;
  }
  const secondaryEvidence = processLogCoreSecondaryEvidence(error);
  if (secondaryEvidence.length > 0) {
    details.secondary_errors = secondaryEvidence.map((secondary) => ({
      code: secondary.code,
      context: secondary.context,
      cause_code: secondary.causeCode,
      recovery_action: secondary.recoveryAction,
    }));
  }
  console.error(JSON.stringify({
    status: "error",
    error: details,
  }, null, 2));
}

function translateTransportedCommandError(error) {
  const trustedCoreError = processLogCorePrimaryEvidence(error) !== null;
  const trustedValidationError = processLogV3ValidationErrorEvidence(error) !== null;
  if (
    safeErrorIs(error, SafeCliInputError)
    || safeErrorIs(error, ProcessLogCliError)
    || trustedCoreError
    || trustedValidationError
  ) {
    return error;
  }
  if (safeErrorIs(error, ProcessLogLifecycleError)) {
    return new ProcessLogCliError(
      boundedCliErrorCode(safeErrorProperty(error, "code"), "safe_input_value_invalid"),
      "The command rejected safely transported input.",
    );
  }
  return new ProcessLogCliError(
    "safe_input_value_invalid",
    "The safely transported value failed command validation.",
  );
}

function touch(log) {
  const timestamp = new Date().toISOString();
  if (Date.parse(timestamp) < Date.parse(log.updated_at)) {
    throw new ProcessLogCliError(
      "invalid_mutation_timestamp",
      "clock timestamp is outside the allowed causal window",
    );
  }
  log.updated_at = timestamp;
}

function commitCompanyMutation(mutate) {
  const payload = updateLogV3Atomic(logPath, (log) => {
    const outcome = mutate(log) ?? {};
    if (outcome.changed !== false) touch(log);
    return outcome;
  });
  print(payload);
  return payload;
}

function requireAllowedCompanyDomain(domain) {
  if (isEmployerDomainExcluded(domain)) {
    throw new ProcessLogCliError(
      "company_domain_forbidden",
      "ATS, job-board, recruiter, and document-share domains cannot be company domains.",
    );
  }
  return domain;
}

function selectorFromOptions(options) {
  const selector = {};
  if (Object.hasOwn(options, "id")) {
    selector.id = requireOption(options, "id");
  }
  if (Object.hasOwn(options, "source-ref")) {
    selector.sourceRef = requireOption(options, "source-ref");
  }
  if (Object.hasOwn(options, "output-dir")) {
    selector.outputDir = requireOption(options, "output-dir");
  }
  return selector;
}

function assertStepCommandOptions(options, extra = []) {
  assertAllowed(options, [...selectorOptionNames, "step", ...extra]);
}

function lifecycleEnvironment() {
  return { outputRoot, workspaceRoot };
}

function start(options) {
  assertAllowed(options, ["source-ref", "runner", "company-hint", "duplicate-of"]);
  const result = startFileBackedProcessV3(logPath, {
    sourceRef: requireOption(options, "source-ref"),
    runner: requireOption(options, "runner"),
    companyHint: options["company-hint"]?.trim() || null,
    duplicateOf: options["duplicate-of"]?.trim() || null,
  });
  print(result);
  if (result.status === "duplicate") process.exitCode = 2;
}

function update(options) {
  assertAllowed(options, [
    "id",
    "company-observed",
    "company-hint",
    "clear-company-hint",
    "role",
  ]);
  if (options["company-hint"] && options["clear-company-hint"]) {
    throw new ProcessLogCliError(
      "invalid_cli_arguments",
      "Use only one of --company-hint and --clear-company-hint",
    );
  }
  const input = {
    processId: requireOption(options, "id"),
  };
  if (Object.hasOwn(options, "company-observed")) {
    input.companyObserved = requireOption(options, "company-observed");
  }
  if (Object.hasOwn(options, "company-hint")) {
    input.companyHint = requireOption(options, "company-hint");
  }
  if (options["clear-company-hint"]) input.companyHint = null;
  if (Object.hasOwn(options, "role")) {
    input.role = requireOption(options, "role");
  }
  print(updateFileBackedProcessV3(logPath, input));
}

function resolveProcess(options) {
  assertAllowed(options, selectorOptionNames);
  const processRecord = resolveFileBackedProcessV3(
    readLogV3(logPath),
    selectorFromOptions(options),
  );
  print({ status: "resolved", process: processRecord });
}

function reserveOutput(options) {
  assertAllowed(options, ["id"]);
  print(reserveFileBackedOutputV3(
    logPath,
    { processId: requireOption(options, "id") },
    lifecycleEnvironment(),
  ));
}

function preflightStep(options) {
  assertStepCommandOptions(options);
  const result = preflightFileBackedStepV3(
    logPath,
    {
      selector: selectorFromOptions(options),
      stepName: requireOption(options, "step"),
    },
    lifecycleEnvironment(),
  );
  print({ status: "ready", ...result });
}

function beginStep(options) {
  assertStepCommandOptions(options);
  print(beginFileBackedStepV3(
    logPath,
    {
      selector: selectorFromOptions(options),
      stepName: requireOption(options, "step"),
    },
    lifecycleEnvironment(),
  ));
}

function publishStep(options) {
  assertStepCommandOptions(options, [
    "attempt-id",
    "publication-id",
    "outcome",
    "blocker-json",
    "waivers-json",
  ]);
  const outcome = requireOption(options, "outcome");
  const blocker = Object.hasOwn(options, "blocker-json")
    ? parseJsonOption(options, "blocker-json")
    : null;
  print(publishFileBackedStepV3(
    logPath,
    {
      selector: selectorFromOptions(options),
      stepName: requireOption(options, "step"),
      attemptId: requireOption(options, "attempt-id"),
      publicationId: requireOption(options, "publication-id"),
      outcome,
      blocker,
      waivers: Object.hasOwn(options, "waivers-json")
        ? parseJsonOption(options, "waivers-json")
        : [],
    },
    lifecycleEnvironment(),
  ));
}

function failStep(options) {
  assertStepCommandOptions(options, ["attempt-id", "error-json"]);
  print(failFileBackedStepV3(logPath, {
    selector: selectorFromOptions(options),
    stepName: requireOption(options, "step"),
    attemptId: requireOption(options, "attempt-id"),
    error: parseJsonOption(options, "error-json"),
  }));
}

function retryStep(options) {
  assertStepCommandOptions(options);
  print(retryFileBackedStepV3(
    logPath,
    {
      selector: selectorFromOptions(options),
      stepName: requireOption(options, "step"),
    },
    lifecycleEnvironment(),
  ));
}

function reopenStep(options) {
  assertStepCommandOptions(options, ["adopt"]);
  print(reopenFileBackedStepV3(
    logPath,
    {
      selector: selectorFromOptions(options),
      stepName: requireOption(options, "step"),
      adopt: options.adopt === true,
    },
    lifecycleEnvironment(),
  ));
}

function reviseStep(options) {
  assertStepCommandOptions(options, ["channel", "adopt", "waivers-json"]);
  print(reviseFileBackedStepV3(
    logPath,
    {
      selector: selectorFromOptions(options),
      stepName: requireOption(options, "step"),
      channel: requireOption(options, "channel"),
      adopt: options.adopt === true,
      waivers: Object.hasOwn(options, "waivers-json")
        ? parseJsonOption(options, "waivers-json")
        : [],
    },
    lifecycleEnvironment(),
  ));
}

function reconcileStep(options) {
  assertStepCommandOptions(options, ["attempt-id", "publication-id"]);
  const hasAttemptId = Object.hasOwn(options, "attempt-id");
  const hasPublicationId = Object.hasOwn(options, "publication-id");
  print(reconcileFileBackedStepV3(
    logPath,
    {
      selector: selectorFromOptions(options),
      stepName: requireOption(options, "step"),
      attemptId: hasAttemptId ? requireOption(options, "attempt-id") : null,
      publicationId: hasPublicationId
        ? requireOption(options, "publication-id")
        : null,
    },
    lifecycleEnvironment(),
  ));
}

function cleanupStaging(options) {
  assertAllowed(options, ["id", "publication-id", "confirmation-token", "dry-run"]);
  if (
    options["dry-run"]
    && Object.hasOwn(options, "confirmation-token")
  ) {
    throw new ProcessLogCliError(
      "invalid_cli_arguments",
      "--dry-run and --confirmation-token are mutually exclusive",
    );
  }
  print(cleanupFileBackedStagingV3(
    logPath,
    {
      processId: requireOption(options, "id"),
      publicationId: requireOption(options, "publication-id"),
      confirmationToken: Object.hasOwn(options, "confirmation-token")
        ? requireOption(options, "confirmation-token")
        : null,
    },
    lifecycleEnvironment(),
  ));
}

function findCompany(options) {
  assertAllowed(options, ["query"]);
  const query = requireOption(options, "query");
  print({ query, matches: searchCompaniesV3(readLogV3(logPath), query) });
}

function createCompany(options) {
  assertAllowed(options, ["display-name", "term", "domain"]);
  const displayName = requireOption(options, "display-name");
  const domain = options.domain
    ? requireAllowedCompanyDomain(normalizeDomain(options.domain))
    : null;
  const normalized = normalizeSearchText(displayName);
  const result = commitCompanyMutation((log) => {
    const collisions = log.companies.filter((company) =>
      company.search_terms.some(
        (term) => normalizeSearchText(term) === normalized,
      ));
    if (collisions.length === 1) {
      return {
        changed: false,
        result: { status: "existing", company: collisions[0] },
      };
    }
    if (collisions.length > 1) {
      return {
        changed: false,
        result: { status: "ambiguous", matches: collisions },
      };
    }
    const company = createCompanyRecord(displayName);
    if (options.term) {
      company.search_terms = [...deriveSearchTerms(displayName), options.term.trim()]
        .filter((term, index, terms) =>
          terms.findIndex((candidate) =>
            normalizeSearchText(candidate) === normalizeSearchText(term),
          ) === index);
    }
    if (domain) company.domains = [domain];
    log.companies.push(company);
    log.companies.sort((left, right) =>
      left.display_name.localeCompare(right.display_name, "en"));
    return { result: { status: "created", company } };
  });
  if (result.status === "ambiguous") process.exitCode = 2;
}

function linkCompany(options) {
  assertAllowed(options, ["id", "company-id"]);
  print(linkFileBackedProcessCompanyV3(logPath, {
    processId: requireOption(options, "id"),
    companyId: requireOption(options, "company-id"),
  }));
}

// Provenance only, and the two ids are machine tokens the caller already holds, so no `--input-file`
// transport applies (ADR 0011 keeps `duplicate-of` outside the envelope for the same reason).
function linkDuplicate(options) {
  assertAllowed(options, ["id", "duplicate-of", "clear-duplicate-of"]);
  const clear = options["clear-duplicate-of"] === true;
  const duplicateOf = options["duplicate-of"]?.trim() || null;
  if (clear === (duplicateOf !== null)) {
    throw new ProcessLogCliError(
      "invalid_cli_arguments",
      "link-duplicate takes exactly one of --duplicate-of <id> or --clear-duplicate-of",
    );
  }
  print(linkFileBackedProcessDuplicateV3(logPath, {
    processId: requireOption(options, "id"),
    duplicateOf,
  }));
}

// Read-only, and it exits 0 whatever it finds: a chain is history, not a condition to resolve. It
// reads the ledger directly rather than resolving the id, because one end of a chain is usually a
// historical record and the resolver refuses those.
function reportDuplicateChain(options) {
  assertAllowed(options, ["id"]);
  const report = buildDuplicateChain(readLogV3(logPath), requireOption(options, "id"));
  print(report);
}

function renameCompany(options) {
  assertAllowed(options, ["id", "display-name"]);
  const id = requireOption(options, "id");
  const displayName = requireOption(options, "display-name");
  commitCompanyMutation((log) => {
    const company = getCompany(log, id);
    company.search_terms = [...company.search_terms, ...deriveSearchTerms(displayName)]
      .filter((term, index, terms) =>
        terms.findIndex((candidate) =>
          normalizeSearchText(candidate) === normalizeSearchText(term),
        ) === index);
    company.display_name = displayName;
    return { result: { status: "renamed", company } };
  });
}

function getCompany(log, id) {
  const company = log.companies.find((candidate) => candidate.id === id);
  if (!company) {
    throw new ProcessLogCliError(
      "company_not_found",
      `Unknown company id: ${id}`,
    );
  }
  return company;
}

function editCompanyTerm(options, remove) {
  assertAllowed(options, ["id", "term"]);
  const id = requireOption(options, "id");
  const term = requireOption(options, "term");
  const key = normalizeSearchText(term);
  commitCompanyMutation((log) => {
    const company = getCompany(log, id);
    const exists = company.search_terms.some(
      (candidate) => normalizeSearchText(candidate) === key,
    );
    if (remove && key === normalizeSearchText(company.display_name)) {
      throw new ProcessLogCliError(
        "company_term_required",
        "Cannot remove the display_name search term",
      );
    }
    if ((remove && !exists) || (!remove && exists)) {
      return {
        changed: false,
        result: { status: "unchanged", company },
      };
    }
    if (remove) {
      company.search_terms = company.search_terms.filter(
        (candidate) => normalizeSearchText(candidate) !== key,
      );
    } else {
      company.search_terms.push(term);
    }
    return {
      result: { status: remove ? "term-removed" : "term-added", company },
    };
  });
}

function editCompanyDomain(options, remove) {
  assertAllowed(options, ["id", "domain"]);
  const id = requireOption(options, "id");
  const domain = normalizeDomain(requireOption(options, "domain"));
  if (!remove) requireAllowedCompanyDomain(domain);
  commitCompanyMutation((log) => {
    const company = getCompany(log, id);
    const exists = company.domains.includes(domain);
    if ((remove && !exists) || (!remove && exists)) {
      return {
        changed: false,
        result: { status: "unchanged", company },
      };
    }
    if (remove) {
      company.domains = company.domains.filter(
        (candidate) => candidate !== domain,
      );
    } else {
      company.domains.push(domain);
    }
    return {
      result: { status: remove ? "domain-removed" : "domain-added", company },
    };
  });
}

function validate(options) {
  assertAllowed(options, ["deep"]);
  if (options.deep) {
    const report = validateProcessLogV3Deep(logPath, lifecycleEnvironment());
    print(report);
    if (report.health !== "current") process.exitCode = 2;
    return;
  }
  const log = readLogV3(logPath);
  print({
    status: "valid",
    schema_version: log.schema_version,
    companies: log.companies.length,
    processes: log.processes.length,
  });
}

// The two halves of the source-key cutover rollback. docs/runbooks/source-key-v2-cutover.md owns
// the procedure; these commands own its preconditions. The backup never overwrites, and the restore
// never runs without a token bound to the exact pair of files a review already saw.
function backupLedger(options) {
  assertAllowed(options, ["backup-file"]);
  const result = backupProcessLogV3(logPath, {
    backupFile: requireOption(options, "backup-file"),
  });
  print(result);
  // The backup exists either way — that is why the status stays `backed_up`. Exit 2 says the file
  // is not a rollback target for the code this cutover reverts to, which is a condition the
  // operator must resolve while they still can, not a failure of the command.
  if (!result.backup_readable_by_version_1_code) process.exitCode = 2;
}

function restoreLedger(options) {
  assertAllowed(options, ["backup-file", "confirmation-token", "dry-run"]);
  if (options["dry-run"] && Object.hasOwn(options, "confirmation-token")) {
    throw new ProcessLogCliError(
      "invalid_cli_arguments",
      "--dry-run and --confirmation-token are mutually exclusive",
    );
  }
  const result = restoreProcessLogV3(logPath, {
    backupFile: requireOption(options, "backup-file"),
    confirmationToken: Object.hasOwn(options, "confirmation-token")
      ? requireOption(options, "confirmation-token")
      : null,
  });
  print(result);
  // Exit 2 while a decision is still owed, on the same reading as `start` reporting a duplicate: a
  // rollback that drops records, or one whose backup the reverted code could not read, is a
  // condition an operator must resolve rather than a failure of the command.
  if (result.status === "review_required" && result.rollback !== "clean") {
    process.exitCode = 2;
  }
}

function reportSourceCollisions(options) {
  assertAllowed(options, []);
  const report = buildLegacySourceCollisionReport(readLogV3(logPath));
  print(report);
  if (report.status === "collision") process.exitCode = 2;
}

// A census, not a gate. The sibling above exits 2 because an ambiguous stored key is a condition an
// operator must resolve before continuing; this one describes work a planned cutover will do, and a
// report that fails whenever it has something to say is a report nobody can run in a pipeline.
function reportSourceKeySplit(options) {
  assertAllowed(options, []);
  print(buildSourceKeyVersionProjection(readLogV3(logPath)));
}

// Every command but these two runs the operational folder's drift check first: `help` prints usage,
// and `validate` only reads — it is also what a cutover runs from the new engine against its image.
// The check reads the manifest of the tree this file lies in, never of the environment's workspace.
const commandsWithoutFolderCheck = Object.freeze(["help", "validate"]);

function verifyOperationalFolder() {
  try {
    verifyFolder(repoRoot);
  } catch (error) {
    if (error instanceof OpsTreeError) throw new ProcessLogCliError(error.code, error.message);
    throw error;
  }
}

const commands = Object.freeze({
  start,
  update,
  resolve: resolveProcess,
  "reserve-output": reserveOutput,
  "preflight-step": preflightStep,
  "begin-step": beginStep,
  "publish-step": publishStep,
  "fail-step": failStep,
  "retry-step": retryStep,
  "reopen-step": reopenStep,
  "revise-step": reviseStep,
  "reconcile-step": reconcileStep,
  "cleanup-staging": cleanupStaging,
  "find-company": findCompany,
  "create-company": createCompany,
  "link-company": linkCompany,
  "link-duplicate": linkDuplicate,
  "rename-company": renameCompany,
  "add-company-term": (options) => editCompanyTerm(options, false),
  "remove-company-term": (options) => editCompanyTerm(options, true),
  "add-company-domain": (options) => editCompanyDomain(options, false),
  "remove-company-domain": (options) => editCompanyDomain(options, true),
  "report-duplicate-chain": reportDuplicateChain,
  "report-source-collisions": reportSourceCollisions,
  "report-source-key-split": reportSourceKeySplit,
  "backup-ledger": backupLedger,
  "restore-ledger": restoreLedger,
  validate,
});

try {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "help" || command === "--help") {
    usage();
  } else if (!command || !Object.hasOwn(commands, command)) {
    throw new ProcessLogCliError(
      "unknown_command",
      `Unknown command: ${command ?? "<none>"}`,
    );
  } else {
    if (!commandsWithoutFolderCheck.includes(command)) verifyOperationalFolder();
    const hydrated = hydrateSafeCliOptions({
      command,
      inputRoot,
      options,
    });
    try {
      commands[command](hydrated.options);
    } catch (error) {
      throw hydrated.transported
        ? translateTransportedCommandError(error)
        : error;
    }
  }
} catch (error) {
  printError(error);
  process.exitCode = 1;
}
