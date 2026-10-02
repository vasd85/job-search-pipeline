import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MAX_BUFFER = 64 * 1024 * 1024;
const STEP_TIMEOUT_MS = 20 * 60 * 1000;
const REPORTED_OUTPUT_LIMIT = 64 * 1024;

export const ENVIRONMENT_PREFIX = "JOB_PIPELINE_";
export const PRESERVED_ENVIRONMENT_VARIABLES = Object.freeze([
  "JOB_PIPELINE_BROWSER_BIN",
]);

// No child of this runner may be reconfigured, redirected or quietened from the
// ambient environment.
//
// For a git child that means `GIT_CONFIG*`, which injects configuration,
// `GIT_ATTR*`, which changes the attribute source, and `GIT_DIR`/`GIT_WORK_TREE`
// and friends, which point the whole stage at a different repository. Each of
// those turns the format stage green on a tree it never inspected.
//
// For a node child the same condition covers the whole `NODE_` namespace,
// because the knob that hides a red suite is not one name. `NODE_OPTIONS`
// carries `--test-only`, `--test-name-pattern` and `--test-skip-pattern`, each
// of which makes a suite report success with no case of its own executed, and
// `--require`/`--import`, which preloads code into every node child here
// including the proxy checker. `NODE_TEST_CONTEXT` needs no `NODE_OPTIONS` at
// all: node then treats this run as an inner one and skips the files it was
// given. Naming the namespace instead of the spellings costs the benign uses
// too — an ambient `--max-old-space-size` and `NODE_V8_COVERAGE` stop reaching a
// child, among every other `NODE_*` name — and that is accepted, because a list
// of spellings reopens on the next release that adds one. It binds this runner's
// own children and nothing else: a suite that hands its own child an explicit
// `NODE_OPTIONS` is unaffected.
//
// It is not a boundary, and it is not proposed as one. Every variable not named
// here still reaches every child: `PATH` alone selects the `git` and `tar`
// binaries the stages invoke by name, `LD_PRELOAD` and `DYLD_INSERT_LIBRARIES`
// inject code into them, `TMPDIR` relocates the disposable archive root that the
// fresh-archive guard then validates against that same value, and this runner's
// own process keeps running under the ambient environment it scrubs for its
// children.
export const SCRUBBED_ENVIRONMENT_PREFIXES = Object.freeze([
  ENVIRONMENT_PREFIX,
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_ATTR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
  "NODE_",
]);

export const PINNED_WHITESPACE_POLICY = "blank-at-eol,space-before-tab,blank-at-eof";

export class CiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CiError";
    this.code = code;
  }
}

/**
 * Every stage runs a repository gate. No stage may read or write the real
 * `process-log.json` or `output/`, so `bootstrap --init`, `bootstrap --check`
 * and `process-log validate` are deliberately absent: they resolve to the
 * operational tree by default. A stage either passes or fails; there is no
 * skipped or warning outcome.
 *
 * Publishability is blocking for the exported area. Only the tracked example's
 * language-data allowances are passed; CI never reads operator state or personal markers.
 */
export const CI_STAGES = Object.freeze([
  "proxy",
  "instruction",
  "full",
  "serial",
  "fresh-archive",
  "format",
  "publishability",
]);

/**
 * The executable test inventory this repository ships, frozen as a literal.
 *
 * The `full` and `serial` stages enumerate `tests/` themselves, so without this
 * list a suite renamed out of the glob loses its oracle in every stage while the
 * gate still reports six passes. That is not hypothetical: renaming
 * `tests/proxies.test.mjs` away is exactly half of the composite that
 * reintroduces the Codex explicit-invocation defect with a fully green run.
 *
 * The pin lives in the runner rather than only in `tests/ci.test.mjs`, because a
 * literal that lived only in a test file would be removed together with the file
 * that carries it. Consequence to accept deliberately: adding or removing a test
 * file is an edit here too, and a fixture workspace root that drives `full` or
 * `serial` must carry these exact names.
 */
export const EXPECTED_TEST_FILES = Object.freeze([
  join("tests", "application-brief.test.mjs"),
  join("tests", "board.test.mjs"),
  join("tests", "bootstrap.test.mjs"),
  join("tests", "candidate.test.mjs"),
  join("tests", "ci.test.mjs"),
  join("tests", "company-research-artifacts.test.mjs"),
  join("tests", "cover-letter-validator.test.mjs"),
  join("tests", "cv-builder.test.mjs"),
  join("tests", "development-flow.test.mjs"),
  join("tests", "disposable-workspace.test.mjs"),
  join("tests", "docx-extract.test.mjs"),
  join("tests", "docx-inspector.test.mjs"),
  join("tests", "file-backed-pipeline-e2e.test.mjs"),
  join("tests", "git-hooks.test.mjs"),
  join("tests", "instruction-contracts.test.mjs"),
  join("tests", "job-scorer.test.mjs"),
  join("tests", "job-source-registry.test.mjs"),
  join("tests", "job-source-routes.test.mjs"),
  join("tests", "letter-corrections.test.mjs"),
  join("tests", "libreoffice-backend.test.mjs"),
  join("tests", "operational-backup.test.mjs"),
  join("tests", "ops-tree.test.mjs"),
  join("tests", "pipeline-artifacts.test.mjs"),
  join("tests", "pipeline-contract-scenarios.test.mjs"),
  join("tests", "pretriage.test.mjs"),
  join("tests", "process-log-concurrency.test.mjs"),
  join("tests", "process-log-core.test.mjs"),
  join("tests", "process-log-v3-cli.test.mjs"),
  join("tests", "process-log-v3-deep-validation.test.mjs"),
  join("tests", "process-log-v3-identity-resolver.test.mjs"),
  join("tests", "process-log-v3-lifecycle-start.test.mjs"),
  join("tests", "process-log-v3-output-reservation.test.mjs"),
  join("tests", "process-log-v3-preflight-begin.test.mjs"),
  join("tests", "process-log-v3-revision.test.mjs"),
  join("tests", "process-log-v3-validation.test.mjs"),
  join("tests", "process-search-application-brief-view.test.mjs"),
  join("tests", "process-search-browser.test.mjs"),
  join("tests", "process-search-public.test.mjs"),
  join("tests", "process-search-server.test.mjs"),
  join("tests", "process-search-view-model.test.mjs"),
  join("tests", "proxies.test.mjs"),
  join("tests", "public-links.test.mjs"),
  join("tests", "publishability.test.mjs"),
  join("tests", "push-guard.test.mjs"),
  join("tests", "safe-cli-input.test.mjs"),
  join("tests", "section-links.test.mjs"),
  join("tests", "setup-github.test.mjs"),
  join("tests", "setup-machine.test.mjs"),
  join("tests", "source-key-v2-cutover.test.mjs"),
  join("tests", "telegram-collect.test.mjs"),
  join("tests", "toolchain-preflight.test.mjs"),
  join("tests", "triage-ledger.test.mjs"),
  join("tests", "triage-verify.test.mjs"),
  join("tests", "vacancy-fetch.test.mjs"),
  join("tests", "write-guard.test.mjs"),
]);

export function instructionTestFiles() {
  return [join("tests", "instruction-contracts.test.mjs")];
}

/**
 * Every generated proxy path, frozen as a literal.
 *
 * Pinning the reported count alone is not enough, and pinning nothing is what
 * `tools/ci.mjs` used to do. The checker reports the size of its own
 * manifest-derived expectation, so removing the Codex metadata branch from the
 * generator and declaring three more skills reports the identical count with no
 * invocation metadata on disk at all. The count catches deletion; only the set
 * catches substitution.
 */
export const EXPECTED_PROXY_FILES = Object.freeze([
  ".agents/skills/collect-telegram/SKILL.md",
  ".agents/skills/collect-telegram/agents/openai.yaml",
  ".agents/skills/generate-cv/SKILL.md",
  ".agents/skills/generate-cv/agents/openai.yaml",
  ".agents/skills/get-vacancy/SKILL.md",
  ".agents/skills/get-vacancy/agents/openai.yaml",
  ".agents/skills/map-experience/SKILL.md",
  ".agents/skills/map-experience/agents/openai.yaml",
  ".agents/skills/research-company/SKILL.md",
  ".agents/skills/research-company/agents/openai.yaml",
  ".agents/skills/score-jobs/SKILL.md",
  ".agents/skills/score-jobs/agents/openai.yaml",
  ".agents/skills/write-cover-letter/SKILL.md",
  ".agents/skills/write-cover-letter/agents/openai.yaml",
  ".claude/agents/letter-reader.md",
  ".claude/agents/telegram-labeler.md",
  ".claude/agents/telegram-reader.md",
  ".claude/skills/collect-telegram/SKILL.md",
  ".claude/skills/generate-cv/SKILL.md",
  ".claude/skills/get-vacancy/SKILL.md",
  ".claude/skills/map-experience/SKILL.md",
  ".claude/skills/research-company/SKILL.md",
  ".claude/skills/score-jobs/SKILL.md",
  ".claude/skills/write-cover-letter/SKILL.md",
  "AGENTS.md",
  "CLAUDE.md",
]);

export function childEnvironment(environment = process.env) {
  const child = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (PRESERVED_ENVIRONMENT_VARIABLES.includes(key)) {
      child[key] = value;
      continue;
    }
    if (SCRUBBED_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    child[key] = value;
  }
  return child;
}

// Diagnostics name the tool, not the operator's absolute interpreter path.
function stepLabel(command) {
  return command === process.execPath ? "node" : command;
}

function runStep(context, step) {
  const label = stepLabel(step.command);
  const result = context.spawn(step.command, step.args, {
    cwd: step.cwd ?? context.workspaceRoot,
    encoding: "utf8",
    env: step.env ?? context.environment,
    maxBuffer: MAX_BUFFER,
    shell: false,
    timeout: STEP_TIMEOUT_MS,
  });
  if (result.error) {
    throw new CiError(
      "ci_step_not_executed",
      `${label} could not run: ${result.error.code ?? "unknown error"}`,
    );
  }
  if (result.signal) {
    throw new CiError(
      "ci_step_signalled",
      `${label} terminated on signal ${result.signal}`,
    );
  }
  if (result.status !== 0) {
    context.report(result);
    throw new CiError(
      "ci_step_failed",
      `${label} exited with code ${result.status}`,
    );
  }
  return result;
}

function enumerateTestFiles(workspaceRoot) {
  const testsRoot = join(workspaceRoot, "tests");
  const files = readdirSync(testsRoot)
    .filter((entry) => entry.endsWith(".test.mjs"))
    .sort()
    .map((entry) => join("tests", entry));
  if (files.length === 0) {
    throw new CiError("ci_no_tests_found", "no tests/*.test.mjs file was found");
  }
  // Both directions: a frozen name with no file on disk, and a file on disk with
  // no frozen name. One direction alone would let a rename pass as an addition.
  const present = new Set(files);
  const expected = EXPECTED_TEST_FILES;
  const missing = expected.filter((path) => !present.has(path));
  const unexpected = files.filter((path) => !expected.includes(path));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new CiError(
      "ci_test_inventory_drift",
      "test inventory drifted:"
      + ` missing ${JSON.stringify(missing)},`
      + ` unexpected ${JSON.stringify(unexpected)}`,
    );
  }
  return files;
}

/**
 * The one byte string the Codex explicit-invocation finding is about. Presence
 * of the seven metadata files proves nothing on its own: the generator can emit
 * them with the policy inverted and every count and path still agrees.
 */
export const EXPECTED_CODEX_POLICY = "policy:\n  allow_implicit_invocation: false\n";
// A generated subagent reads untrusted text: its allowlist is reading and nothing else.
export const EXPECTED_AGENT_TOOLS_LINE = "tools: Read";

/**
 * Applied to every tree that has to satisfy the proxy gate, not only to the
 * working tree, because the fresh-archive stage claims the committed tree
 * satisfies the same gate and would otherwise be checking a weaker property.
 */
function verifyProxyInventory(context, root) {
  const result = runStep(context, {
    args: [join("tools", "sync-agent-proxies.mjs"), "--check"],
    command: process.execPath,
    cwd: root,
  });
  let report;
  try {
    report = JSON.parse(result.stdout ?? "");
  } catch {
    throw new CiError(
      "ci_proxy_report_unreadable",
      "proxy checker did not print a JSON report",
    );
  }
  if (
    report.status !== "current"
    || !Array.isArray(report.changed) || report.changed.length !== 0
    || !Array.isArray(report.unexpected) || report.unexpected.length !== 0
    || report.files !== EXPECTED_PROXY_FILES.length
  ) {
    throw new CiError(
      "ci_proxy_inventory_not_current",
      "proxy inventory is not current",
    );
  }
  // The report is the checker's own arithmetic over its own expectation, so the
  // count above proves only that the expectation has the pinned size. The names
  // are checked against the tree here instead.
  const missing = EXPECTED_PROXY_FILES.filter(
    (path) => !existsSync(join(root, path)),
  );
  if (missing.length > 0) {
    throw new CiError(
      "ci_proxy_inventory_incomplete",
      `generated proxy files are missing: ${JSON.stringify(missing)}`,
    );
  }
  // `existsSync` above accepts a directory, and an unreadable file would throw
  // an untyped error out of a gate whose every other failure names its cause.
  const readPolicy = (path) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch (error) {
      throw new CiError(
        "ci_proxy_inventory_incomplete",
        `generated proxy file is unreadable: ${path} (${error?.code ?? "unknown error"})`,
      );
    }
  };
  const drifted = EXPECTED_PROXY_FILES
    .filter((path) => path.endsWith("openai.yaml"))
    .filter((path) => readPolicy(path) !== EXPECTED_CODEX_POLICY);
  if (drifted.length > 0) {
    throw new CiError(
      "ci_proxy_policy_drift",
      `generated invocation policy is not explicit-only: ${JSON.stringify(drifted)}`,
    );
  }
  const armed = EXPECTED_PROXY_FILES
    .filter((path) => path.startsWith(".claude/agents/"))
    .filter((path) => !frontmatterLines(readPolicy(path)).includes(EXPECTED_AGENT_TOOLS_LINE));
  if (armed.length > 0) {
    throw new CiError(
      "ci_proxy_policy_drift",
      `generated agent allowlist is not reading only: ${JSON.stringify(armed)}`,
    );
  }
}

/** The lines of a leading YAML frontmatter block, or none when the file does not open with one. */
function frontmatterLines(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  return match === null ? [] : match[1].split("\n");
}

function proxyStage(context) {
  verifyProxyInventory(context, context.workspaceRoot);
}

function instructionStage(context) {
  runStep(context, {
    args: ["--test", ...instructionTestFiles(context.workspaceRoot)],
    command: process.execPath,
  });
}

function fullStage(context) {
  runStep(context, {
    args: ["--test", ...enumerateTestFiles(context.workspaceRoot)],
    command: process.execPath,
  });
}

function serialStage(context) {
  runStep(context, {
    args: [
      "--test",
      "--test-concurrency=1",
      ...enumerateTestFiles(context.workspaceRoot),
    ],
    command: process.execPath,
  });
}

/**
 * Proves that the committed tree alone satisfies the proxy and instruction
 * gates. It never installs anything, so it stays deterministic offline, and it
 * never runs `npm run ci`, so it cannot re-enter this runner.
 */
function freshArchiveStage(context) {
  const disposableRoot = context.createDisposableRoot();
  if (dirname(realpathSync(disposableRoot)) !== realpathSync(tmpdir())) {
    rmSync(disposableRoot, { force: true, recursive: true });
    throw new CiError(
      "ci_archive_root_not_disposable",
      "fresh archive root is not a direct child of the system temporary directory",
    );
  }
  const archivePath = join(disposableRoot, "committed-tree.tar");
  const treeRoot = join(disposableRoot, "tree");
  try {
    runStep(context, {
      args: ["archive", "--format=tar", "-o", archivePath, "HEAD"],
      command: "git",
    });
    context.createDirectory(treeRoot);
    runStep(context, {
      args: ["-xf", archivePath, "-C", treeRoot],
      command: "tar",
    });
    for (const required of [
      "package-lock.json",
      join("tools", "cv-builder", "package-lock.json"),
    ]) {
      if (!existsSync(join(treeRoot, required))) {
        throw new CiError(
          "ci_archive_incomplete",
          `committed tree is missing ${required}`,
        );
      }
    }
    // `candidate` is on this list for a different reason than the two installed
    // trees: it is one person's private layer, and a commit that carried it
    // would put a profile into every copy of this repository. The archive is
    // where that becomes visible, because it is exactly what an export ships.
    for (const installed of [
      "candidate",
      "node_modules",
      join("tools", "cv-builder", "node_modules"),
    ]) {
      if (existsSync(join(treeRoot, installed))) {
        throw new CiError(
          "ci_archive_not_clean",
          `committed tree unexpectedly contains ${installed}`,
        );
      }
    }
    verifyProxyInventory(context, treeRoot);
    runStep(context, {
      args: ["--test", ...instructionTestFiles(treeRoot)],
      command: process.execPath,
      cwd: treeRoot,
    });
  } finally {
    rmSync(disposableRoot, { force: true, recursive: true });
  }
}

/**
 * `git diff --check` alone only inspects unstaged changes, so on any clean
 * checkout it passes for every possible repository content. The second step
 * diffs the whole committed tree against the empty tree and therefore fails on
 * committed whitespace errors and conflict markers.
 *
 * Both steps pin the whitespace policy on the command line and read gitattributes
 * from the empty tree instead of the working tree, because a committed
 * `.gitattributes` saying `* -whitespace`, `* binary` or `* -diff` would
 * otherwise silence the check on exactly the content it is meant to reject.
 * `core.attributesFile` and the system attributes file are neutralized for the
 * same reason. `--attr-source` needs git 2.40 or newer; an older git fails the
 * step rather than passing it.
 */
function formatStage(context) {
  // `info/attributes` in the git common directory is the one attribute layer
  // with no command-line or environment override. It cannot be committed, so a
  // fresh checkout never has it, but a local one would silence this stage.
  const commonDir = runStep(context, {
    args: ["rev-parse", "--git-common-dir"],
    command: "git",
  });
  const attributesOverride = resolve(
    context.workspaceRoot,
    String(commonDir.stdout ?? "").trim(),
    "info",
    "attributes",
  );
  if (existsSync(attributesOverride)) {
    throw new CiError(
      "ci_repository_attributes_override",
      "info/attributes in the git common directory can silence the format check; remove it",
    );
  }
  const emptyTree = runStep(context, {
    args: ["hash-object", "-t", "tree", "/dev/null"],
    command: "git",
  });
  const emptyTreeId = String(emptyTree.stdout ?? "").trim();
  if (!/^[0-9a-f]{40,64}$/.test(emptyTreeId)) {
    throw new CiError(
      "ci_empty_tree_unresolved",
      "git did not report a usable empty tree object id",
    );
  }
  const pinned = [
    `--attr-source=${emptyTreeId}`,
    "-c",
    `core.whitespace=${PINNED_WHITESPACE_POLICY}`,
    "-c",
    "core.attributesFile=/dev/null",
  ];
  const env = { ...context.environment, GIT_ATTR_NOSYSTEM: "1" };
  runStep(context, { args: [...pinned, "diff", "--check"], command: "git", env });
  runStep(context, {
    args: [...pinned, "diff", "--check", emptyTreeId, "HEAD"],
    command: "git",
    env,
  });
  runStep(context, {
    args: [join("tools", "format.mjs"), "--check"],
    command: process.execPath,
  });
}

/**
 * How far this tree is from being publishable, as counts rather than a verdict.
 *
 * It hands the scanner no candidate root: no stage of this gate reads operator
 * state, which is the same rule that keeps `bootstrap --check` and
 * `candidate:check` outside it. The consequence travels with the numbers — the
 * report says the personal markers were not loaded rather than printing a zero
 * nobody earned.
 *
 * The counts are returned rather than written, so `runStages` can put them in
 * the record it already logs. `context.report` is the channel for a failing
 * step's output, and a passing stage writing to stderr would be the wrong shape.
 */
function publishabilityStage(context) {
  const result = runStep(context, {
    args: [join("tools", "publishability", "cli.mjs"), "--blocking", "--data-root", join(context.workspaceRoot, "candidate.example")],
    command: process.execPath,
  });
  let report;
  try {
    report = JSON.parse(result.stdout ?? "");
  } catch {
    throw new CiError(
      "ci_publishability_report_unreadable",
      "the publishability scan did not print a JSON report",
    );
  }
  if (report === null || typeof report !== "object" || typeof report.by_class !== "object") {
    throw new CiError(
      "ci_publishability_report_unreadable",
      "the publishability report has no class counts",
    );
  }
  if (report.absent > 0 || report.places_exported > 0) throw new CiError("ci_publishability_findings", "Publication findings or absent tracked files remain.");
  return {
    // `absent`, `scanned` and `skipped` travel with the counts on purpose: a report of no findings
    // over no files read is not the same statement as a clean tree, and only these three tell them
    // apart. Together they account for every path git listed.
    absent: report.absent,
    by_class: report.by_class,
    files_with_findings: report.files_with_findings,
    personal_markers: report.markers?.personal ?? null,
    places: report.places,
    places_exported: report.places_exported,
    scanned: report.scanned,
    skipped: report.skipped,
  };
}

const STAGE_IMPLEMENTATIONS = Object.freeze({
  "format": formatStage,
  "fresh-archive": freshArchiveStage,
  "full": fullStage,
  "instruction": instructionStage,
  "proxy": proxyStage,
  "publishability": publishabilityStage,
  "serial": serialStage,
});

export function runStages(options = {}) {
  const {
    createDirectory = (path) => mkdirSync(path, { recursive: true }),
    createDisposableRoot = () => mkdtempSync(join(realpathSync(tmpdir()), "job-search-ci-")),
    environment = childEnvironment(),
    log = () => {},
    report = () => {},
    spawn = spawnSync,
    stageIds = CI_STAGES,
    workspaceRoot = repoRoot,
  } = options;

  const unknown = stageIds.filter((id) => !CI_STAGES.includes(id));
  if (unknown.length > 0) {
    throw new CiError("ci_unknown_stage", `unknown stage: ${unknown[0]}`);
  }

  const context = {
    createDirectory,
    createDisposableRoot,
    environment,
    report,
    spawn,
    workspaceRoot,
  };
  const results = [];
  for (const id of stageIds) {
    let detail;
    try {
      detail = STAGE_IMPLEMENTATIONS[id](context);
    } catch (error) {
      // Every failure names its stage, including one this runner did not raise
      // itself, so a broken gate is never reported without a location.
      if (error && typeof error === "object") error.stage = id;
      throw error;
    }
    // Built once and logged, not assembled twice: a stage that reports numbers
    // has to reach the operator, and only the logged record is printed. The
    // field is absent, never undefined, for every stage that returns nothing,
    // because the shape of the record is pinned exactly.
    const entry = detail === undefined
      ? { stage: id, status: "passed" }
      : { detail, stage: id, status: "passed" };
    results.push(entry);
    log(entry);
  }
  return results;
}

function parseArguments(argv) {
  if (argv.length === 0) return { mode: "run", stageIds: [...CI_STAGES] };
  if (argv.length === 1 && argv[0] === "--list") return { mode: "list" };
  const stageIds = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--stage" || index + 1 >= argv.length) {
      throw new CiError(
        "invalid_ci_arguments",
        "use no arguments, --list, or one or more --stage <id> pairs",
      );
    }
    const id = argv[index + 1];
    if (!CI_STAGES.includes(id) || stageIds.includes(id)) {
      throw new CiError("invalid_ci_arguments", `unusable stage id: ${id}`);
    }
    stageIds.push(id);
    index += 1;
  }
  return { mode: "run", stageIds };
}

export function tailOutput(value, limit = REPORTED_OUTPUT_LIMIT) {
  const text = String(value ?? "");
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

export function main(argv = process.argv.slice(2)) {
  let stage = null;
  try {
    const parsed = parseArguments(argv);
    if (parsed.mode === "list") {
      process.stdout.write(`${JSON.stringify({ stages: [...CI_STAGES] })}\n`);
      return;
    }
    const results = runStages({
      log: (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`),
      report: (result) => {
        if (result.stdout) process.stderr.write(tailOutput(result.stdout));
        if (result.stderr) process.stderr.write(tailOutput(result.stderr));
      },
      stageIds: parsed.stageIds,
    });
    process.stdout.write(`${JSON.stringify({
      stages: results.map((entry) => entry.stage),
      status: "passed",
    })}\n`);
  } catch (error) {
    // `runStages` labels every failure with its stage, including one it did not
    // raise itself, so the label is printed regardless of the error type.
    stage = error?.stage ?? null;
    process.stderr.write(`${JSON.stringify({
      error: {
        code: error instanceof CiError ? error.code : "ci_failed",
        message: error instanceof CiError ? error.message : "ci failed unexpectedly",
      },
      ...(stage ? { stage } : {}),
      status: "error",
    })}\n`);
    process.exitCode = 1;
  }
}

function isDirectInvocation() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  }
}

if (isDirectInvocation()) main();
