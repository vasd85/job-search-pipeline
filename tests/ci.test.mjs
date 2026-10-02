// This file is part of `tests/*.test.mjs`, so it runs inside the `full` and
// `serial` stages of the runner it verifies. It must therefore never execute a
// stage that runs the suite. It drives `runStages` with an injected recording
// spawn wherever the argv itself is the property under test. The real child
// processes it does start are bounded, and none of them is this repository's
// suite: the pure `--list` and argument-validation modes, the runner itself in
// disposable roots that hold nothing but one synthetic single-case suite, `git`
// against throwaway fixture repositories, and that synthetic suite run directly.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatTrackedFiles } from "../tools/format.mjs";
import {
  CI_STAGES,
  CiError,
  EXPECTED_AGENT_TOOLS_LINE,
  EXPECTED_CODEX_POLICY,
  EXPECTED_PROXY_FILES,
  EXPECTED_TEST_FILES,
  PRESERVED_ENVIRONMENT_VARIABLES,
  SCRUBBED_ENVIRONMENT_PREFIXES,
  childEnvironment,
  runStages,
  tailOutput,
} from "../tools/ci.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = join(repoRoot, "tools", "ci.mjs");
const workflowPath = join(repoRoot, ".github", "workflows", "ci.yml");
const readmePath = join(repoRoot, "README.md");

const CI_SCRIPT = "node tools/ci.mjs";

// The single literal both the runner and the workflow are pinned to. Changing
// either side alone must break this file.
const EXPECTED_STAGES = [
  "proxy",
  "instruction",
  "full",
  "serial",
  "fresh-archive",
  "format",
  "publishability",
];

// Frozen here a second time, on purpose. Reading the inventory back out of the
// runner would make the comparison a tautology, and reading it out of the
// directory would make it the very enumeration the runner is being checked
// against. Three anchors are needed and this file owns the middle one.
const PINNED_TEST_FILES = [
  "application-brief.test.mjs",
  "board.test.mjs",
  "bootstrap.test.mjs",
  "candidate.test.mjs",
  "ci.test.mjs",
  "company-research-artifacts.test.mjs",
  "cover-letter-validator.test.mjs",
  "cv-builder.test.mjs",
  "development-flow.test.mjs",
  "disposable-workspace.test.mjs",
  "docx-extract.test.mjs",
  "docx-inspector.test.mjs",
  "file-backed-pipeline-e2e.test.mjs",
  "git-hooks.test.mjs",
  "instruction-contracts.test.mjs",
  "job-scorer.test.mjs",
  "job-source-registry.test.mjs",
  "job-source-routes.test.mjs",
  "letter-corrections.test.mjs",
  "libreoffice-backend.test.mjs",
  "operational-backup.test.mjs",
  "ops-tree.test.mjs",
  "pipeline-artifacts.test.mjs",
  "pipeline-contract-scenarios.test.mjs",
  "pretriage.test.mjs",
  "process-log-concurrency.test.mjs",
  "process-log-core.test.mjs",
  "process-log-v3-cli.test.mjs",
  "process-log-v3-deep-validation.test.mjs",
  "process-log-v3-identity-resolver.test.mjs",
  "process-log-v3-lifecycle-start.test.mjs",
  "process-log-v3-output-reservation.test.mjs",
  "process-log-v3-preflight-begin.test.mjs",
  "process-log-v3-revision.test.mjs",
  "process-log-v3-validation.test.mjs",
  "process-search-application-brief-view.test.mjs",
  "process-search-browser.test.mjs",
  "process-search-public.test.mjs",
  "process-search-server.test.mjs",
  "process-search-view-model.test.mjs",
  "proxies.test.mjs",
  "public-links.test.mjs",
  "publishability.test.mjs",
  "push-guard.test.mjs",
  "safe-cli-input.test.mjs",
  "section-links.test.mjs",
  "setup-github.test.mjs",
  "setup-machine.test.mjs",
  "source-key-v2-cutover.test.mjs",
  "telegram-collect.test.mjs",
  "toolchain-preflight.test.mjs",
  "triage-ledger.test.mjs",
  "triage-verify.test.mjs",
  "vacancy-fetch.test.mjs",
  "write-guard.test.mjs",
].map((entry) => join("tests", entry));

const CURRENT_TEST_FILES = PINNED_TEST_FILES;

// The generated inventory, frozen independently of the manifest that produces it
// and of the checker that counts it.
const PINNED_PROXY_FILES = [
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
];

// The two halves of one policy, frozen independently of the runner that applies
// them. They have to be read together: the preserved list is consulted first, so
// a name added there overrides every prefix below it. Freezing the prefixes
// alone would leave that one-line bypass invisible, and freezing either as a
// membership test would accept a widened or substituted list.
const PINNED_SCRUBBED_PREFIXES = [
  "JOB_PIPELINE_",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_ATTR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
  "NODE_",
];

const PINNED_PRESERVED_VARIABLES = ["JOB_PIPELINE_BROWSER_BIN"];

// A suite kept in the inventory but suppressed still reports success, so the
// name pin needs a marker scan beside it. Every receiver is covered, not just
// the imported registration function: a suppression call on the per-case
// context object, inside the body, works just as well. An option key is covered
// when it stands directly before its colon, bare or in one pair of quotes.
//
// Matched against whitespace-normalized source rather than line by line, and
// against two views of it: the source as written, and the source with comments
// blanked. An options object wrapped across lines, or one carrying a comment
// before the key, is ordinary formatting of the one exemption this repository
// already carries. Both views are required to pass, so blanking comments can
// only add findings: a naive strip cannot hide a marker that follows a `//`
// inside a string. The cost of the second view, accepted deliberately: a
// comment sitting between `{` or `,` and a legitimate key of one of these three
// names now reads as adjacency and is rejected. Nothing in the corpus does that
// today, and the failure direction is closed.
//
// What this does NOT reach: a key or method name assembled at run time, and a
// computed key even when its parts are literal — `["skip"]`, a backtick key, an
// escaped identifier, a getter. This scan is a tripwire over the exact
// spellings below, not a boundary, and README states that bound.
//
// The pattern is assembled from fragments so that this file does not match its
// own scan — the same dodge tests/write-guard.test.mjs uses
// against the runner scan at the bottom of this file.
const SUPPRESSION_PATTERN = new RegExp([
  "\\.(?:", "skip", "|", "only", "|", "todo", ")\\s*\\(",
  "|\\[\\s*[\"'](?:", "skip", "|", "only", "|", "todo", ")[\"']\\s*\\]\\s*\\(",
  "|[{,]\\s*[\"']?(?:", "skip", "|", "only", "|", "todo", ")[\"']?\\s*:[^,}]{0,60}",
].join(""), "g");

// Suppression markers a suite is permitted to carry, in the same normalized
// form the scan produces. Membership is permission, never obligation: removing
// an exemption must not turn this file red. It is not licence to repeat one
// either, so the scan also caps how many markers a file may carry.
const ALLOWED_SUPPRESSIONS = new Map([
  // A POSIX-only permission fixture in the proxy inventory suite.
  [join("tests", "proxies.test.mjs"), ['{ ' + 'skip: process.platform === "win32"']],
]);

// Written into every synthetic inventory fixture below, so a stray copy is
// identifiable as this suite's scaffolding and never mistaken for a real suite.
const SYNTHETIC_FIXTURE_MARKER = "// synthetic inventory fixture, tests/ci.test.mjs\n";
// The frontmatter a generated agent must open with: the runner reads the allowlist line from it.
const SYNTHETIC_AGENT_FIXTURE = `---\nname: synthetic\ndescription: "synthetic inventory fixture"\n${EXPECTED_AGENT_TOOLS_LINE}\nmodel: haiku\n---\n`;

function read(path) {
  return readFileSync(path, "utf8");
}

function manifest() {
  return JSON.parse(read(join(repoRoot, "package.json")));
}

// The npm pin is derived from the manifest, so a toolchain bump cannot leave the
// workflow installing a stale package manager while this file stays green.
function expectedWorkflowRunLines() {
  const { packageManager } = manifest();
  return [
    "sudo apt-get update",
    "sudo apt-get install --yes --no-install-recommends libreoffice-writer poppler-utils",
    `npm install --global ${packageManager}`,
    "npm ci --ignore-scripts --no-audit --no-fund",
    "npm ci --prefix tools/cv-builder --ignore-scripts --no-audit --no-fund",
    "npm run ci",
  ];
}

// Returns the indented body of a top-level YAML key, blank lines removed.
function workflowBlock(name) {
  const lines = read(workflowPath).split("\n");
  const start = lines.indexOf(`${name}:`);
  assert.notEqual(start, -1, `workflow has no top-level ${name}:`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.length > 0 && !/^\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).filter((line) => line.trim().length > 0);
}

function workflowRunLines() {
  return read(workflowPath)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- run:") || line.startsWith("run:"))
    .map((line) => line.replace(/^-\s*/, "").replace(/^run:\s*/, "").trim());
}

function successfulSpawn() {
  return { status: 0, stderr: "", stdout: "" };
}

// The publishability stage parses its child's stdout, so the default empty answer of
// `successfulSpawn` would throw inside every arm that drives the whole stage list.
function publishabilityReport() {
  return {
    status: 0,
    stderr: "",
    stdout: JSON.stringify({
      absent: 0,
      by_class: { cyrillic_prose: { excluded: 0, exported: 0, total: 0 } },
      files_with_findings: 0,
      markers: { personal: null, personal_source: null, public: 8 },
      places: 0,
      places_exported: 0,
      scanned: 0,
      skipped: 0,
      status: "reported",
    }),
  };
}

function proxyReport() {
  return {
    status: 0,
    stderr: "",
    stdout: JSON.stringify({
      changed: [],
      files: 26,
      status: "current",
      unexpected: [],
    }),
  };
}

// Writes the pinned generated inventory into a synthetic root. The metadata
// bytes are the real expected policy, so a fixture cannot pass a check the
// repository would fail.
function materializeProxyInventory(root) {
  for (const relative of PINNED_PROXY_FILES) {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(
      join(root, relative),
      relative.endsWith("openai.yaml") ? EXPECTED_CODEX_POLICY
        : relative.startsWith(".claude/agents/") ? SYNTHETIC_AGENT_FIXTURE : SYNTHETIC_FIXTURE_MARKER,
    );
  }
}

/**
 * Records every spawn and materializes just enough of an extracted archive for
 * the fresh-archive stage to reach its own assertions.
 */
function recordingSpawn(overrides = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ args: [...args], command, cwd: options.cwd, options });
    const override = overrides[`${command} ${args[0]}`];
    if (override) return override;
    if (args.some((arg) => String(arg).endsWith("sync-agent-proxies.mjs"))) {
      return proxyReport();
    }
    if (args.some((arg) => String(arg).endsWith(join("publishability", "cli.mjs")))) {
      return publishabilityReport();
    }
    if (command === "git" && args[0] === "hash-object") {
      return { status: 0, stderr: "", stdout: `${"4".repeat(40)}\n` };
    }
    if (command === "tar") {
      const target = args[args.indexOf("-C") + 1];
      mkdirSync(join(target, "tools", "cv-builder"), { recursive: true });
      writeFileSync(join(target, "package-lock.json"), "{}\n");
      writeFileSync(join(target, "tools", "cv-builder", "package-lock.json"), "{}\n");
      // The extracted tree now has to satisfy the same proxy inventory the
      // working tree does, so the fixture materializes it.
      materializeProxyInventory(target);
      return successfulSpawn();
    }
    return successfulSpawn();
  };
  return { calls, spawn };
}

function disposableRootFactory(t) {
  const created = [];
  return {
    created,
    factory: () => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), "job-search-ci-test-"));
      created.push(root);
      t.after(() => rmSync(root, { force: true, recursive: true }));
      return root;
    },
  };
}

// Every stage is driven from an ambient environment carrying one variable of
// each silencing family. Under correct code this reduces to the same `{ PATH }`
// the plain input used to produce, so it adds no kill of its own and is not
// counted as coverage; it is here so the scan below is stated over an input
// that actually contains what it rejects.
const HOSTILE_AMBIENT_ENVIRONMENT = Object.freeze({
  GIT_DIR: "/decoy/.git",
  JOB_PIPELINE_PROCESS_LOG: "/real/process-log.json",
  NODE_OPTIONS: "--test-only",
  NODE_TEST_CONTEXT: "child-v8",
  PATH: "/usr/bin",
});

function driveAllStages(t, overrides = {}) {
  const recorder = recordingSpawn(overrides);
  const roots = disposableRootFactory(t);
  const results = runStages({
    createDisposableRoot: roots.factory,
    environment: childEnvironment(HOSTILE_AMBIENT_ENVIRONMENT),
    spawn: recorder.spawn,
    workspaceRoot: repoRoot,
  });
  return { calls: recorder.calls, results, roots: roots.created };
}

test("the ci script, the runner stage list, and the workflow are pinned together", () => {
  assert.equal(manifest().scripts.ci, CI_SCRIPT);
  assert.equal(manifest().packageManager, `npm@${manifest().engines.npm}`);

  assert.deepEqual([...CI_STAGES], EXPECTED_STAGES);

  const listed = JSON.parse(execFileSync(
    process.execPath,
    [runnerPath, "--list"],
    { cwd: repoRoot, encoding: "utf8" },
  ));
  assert.deepEqual(listed.stages, EXPECTED_STAGES);

  assert.deepEqual(workflowRunLines(), expectedWorkflowRunLines());
  const gateLines = workflowRunLines().filter((line) => line.startsWith("npm run "));
  assert.deepEqual(gateLines, ["npm run ci"]);
});

// Pinning only the workflow's payload would let an edit keep every step intact
// while making the workflow never fire, which is the same silent no-op this gate
// exists to prevent.
test("the workflow's activation surface is pinned", () => {
  assert.deepEqual(workflowBlock("on"), [
    "  push:",
    "    branches:",
    "      - main",
    "  pull_request:",
    "  workflow_dispatch:",
  ]);
  assert.deepEqual(workflowBlock("permissions"), ["  contents: read"]);
  const jobs = workflowBlock("jobs");
  assert.deepEqual(jobs.filter((line) => line.trim().startsWith("runs-on:")),
    ["    runs-on: ubuntu-latest"]);
  assert.deepEqual(jobs.filter((line) => /^  \S/.test(line)), ["  gate:"]);
});

test("the workflow cannot soft-fail and installs both lockfiles before the gate", () => {
  const workflow = read(workflowPath);
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.doesNotMatch(workflow, /\|\|\s*true/);
  assert.match(workflow, /node-version-file:\s*\.nvmrc/);
  // Any `if:` — on the job or on a step — can disable the gate while the check
  // still reports green, so the workflow carries no condition at all.
  assert.doesNotMatch(workflow, /^\s*if:/m);
  // `run:` is not the only way to add a second gate; pin the actions too.
  const usesLines = workflow
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- uses:") || line.startsWith("uses:"))
    .map((line) => line.replace(/^-\s*/, "").replace(/^uses:\s*/, "").trim());
  assert.deepEqual(usesLines, ["actions/checkout@v4", "actions/setup-node@v4"]);

  const runLines = workflowRunLines();
  const installs = runLines.filter((line) => line.startsWith("npm ci"));
  assert.equal(installs.length, 2);
  assert.equal(runLines.indexOf("npm run ci"), runLines.length - 1);
  assert.ok(runLines.some((line) => line.includes(manifest().packageManager)));
});

// The counts of the reporting stage reach the operator through the record the runner logs, and
// through nothing else: the final summary maps `entry.stage` only. A record built twice — once to
// return and once to log — would let the field exist in the returned value and never be printed,
// which is a promise that fails silently.
test("only the reporting stage carries a detail, and it is logged as well as returned", (t) => {
  const logged = [];
  const recorder = recordingSpawn();
  const roots = disposableRootFactory(t);
  const results = runStages({
    createDisposableRoot: roots.factory,
    environment: childEnvironment(HOSTILE_AMBIENT_ENVIRONMENT),
    log: (entry) => logged.push(entry),
    spawn: recorder.spawn,
    workspaceRoot: repoRoot,
  });
  const driven = { calls: recorder.calls };

  assert.deepEqual(logged, results);
  for (const entry of results) {
    if (entry.stage === "publishability") continue;
    // Absent, never `undefined`: `assert.deepEqual` is strict and five cases below pin the exact
    // two-key shape of these records.
    assert.deepEqual(Object.keys(entry).sort(), ["stage", "status"], entry.stage);
  }
  // The argv itself, not the stub's answer. Everything else in this case reads values the fixture
  // made up. This pin requires blocking mode and only fictional data allowances; a real
  // candidate-root flag or loss of blocking must fail independently of the stub response.
  const scan = driven.calls.find((call) => call.args.some(
    (argument) => String(argument).endsWith(join("publishability", "cli.mjs")),
  ));
  assert.deepEqual(scan.args, [join("tools", "publishability", "cli.mjs"), "--blocking", "--data-root", join(repoRoot, "candidate.example")]);
  assert.equal(scan.command, process.execPath);

  const reporting = results.find((entry) => entry.stage === "publishability");
  assert.deepEqual(Object.keys(reporting).sort(), ["detail", "stage", "status"]);
  assert.equal(reporting.status, "passed");
  assert.deepEqual(Object.keys(reporting.detail).sort(), [
    "absent",
    "by_class",
    "files_with_findings",
    "personal_markers",
    "places",
    "places_exported",
    "scanned",
    "skipped",
  ]);
  // No candidate root is passed by the stage, so the personal half is reported as not loaded
  // rather than as zero.
  assert.equal(reporting.detail.personal_markers, null);
});

// A child that answers with something this stage cannot parse is a broken gate, not a clean tree.
test("the reporting stage fails when its child prints no usable report", (t) => {
  const roots = disposableRootFactory(t);
  const drive = (stdout) => runStages({
    createDisposableRoot: roots.factory,
    environment: {},
    spawn: () => ({ status: 0, stderr: "", stdout }),
    stageIds: ["publishability"],
    workspaceRoot: repoRoot,
  });
  for (const stdout of ["", "not json", JSON.stringify({ status: "reported" })]) {
    assert.throws(() => drive(stdout), (error) => {
      assert.equal(error instanceof CiError, true);
      assert.equal(error.code, "ci_publishability_report_unreadable");
      assert.equal(error.stage, "publishability");
      return true;
    }, JSON.stringify(stdout));
  }
});

test("the runner spawns fixed argv without a shell and cannot soft-fail", () => {
  const source = read(runnerPath);
  assert.match(source, /shell:\s*false/);
  // Every `shell:` occurrence must be the literal `false`; a variable there
  // could be flipped by an environment switch at run time.
  assert.doesNotMatch(source, /shell:(?!\s*false\b)/);
  assert.doesNotMatch(source, /\bexecSync\b/);
  assert.doesNotMatch(source, /\bexecFileSync\b/);
  assert.doesNotMatch(source, /\|\|\s*true/);
  assert.doesNotMatch(source, /"skipped"|'skipped'|continue-on-error/);
});

// `bootstrap --init` creates missing exact operational roots, `bootstrap --check`
// requires them to pre-exist, and the process-log CLI defaults to the local untracked ledger.
// None of them may become a stage.
test("the runner never invokes an operational entrypoint", () => {
  const source = read(runnerPath);
  assert.doesNotMatch(source, /bootstrap:init/);
  assert.doesNotMatch(source, /bootstrap\.mjs/);
  assert.doesNotMatch(source, /process-log\.mjs/);
  assert.doesNotMatch(source, /process-log:validate/);
  assert.doesNotMatch(source, /"--init"/);
  assert.doesNotMatch(source, /"--check"\s*,\s*"--deep"/);
});

test("every stage executes its exact argv in order", (t) => {
  const driven = driveAllStages(t);
  assert.deepEqual(
    driven.results.map((entry) => entry.stage),
    EXPECTED_STAGES,
  );

  const commands = driven.calls.map((call) => `${call.command} ${call.args.join(" ")}`);
  assert.equal(
    commands.filter((command) => command.includes("sync-agent-proxies.mjs --check")).length,
    2,
  );
  assert.ok(commands.some((command) => command.startsWith("git archive --format=tar")));
  assert.ok(commands.some((command) => command.startsWith("tar -xf")));
  // Once for the instruction stage, once inside the committed-tree archive.
  assert.equal(
    commands.filter((command) => command.endsWith("--test tests/instruction-contracts.test.mjs")).length,
    2,
  );
  const pinned = "--attr-source=4{40} -c core.whitespace=blank-at-eol,space-before-tab,blank-at-eof"
    + " -c core.attributesFile=/dev/null";
  const pinnedPattern = pinned.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  assert.ok(commands.some((command) => new RegExp(`^git ${pinnedPattern} diff --check$`).test(command)));
  assert.ok(commands.some(
    (command) => new RegExp(`^git ${pinnedPattern} diff --check 4{40} HEAD$`).test(command),
  ));
  for (const call of driven.calls.filter((entry) => entry.args.includes("--check")
    && entry.command === "git")) {
    assert.equal(call.options.env.GIT_ATTR_NOSYSTEM, "1");
  }

  assert.ok(commands.some((command) => command.endsWith("tools/format.mjs --check")));

  const suiteCalls = driven.calls.filter((call) => call.args[0] === "--test");
  const fullCall = suiteCalls.find((call) => call.args[1] !== "--test-concurrency=1"
    && call.args.length > 3);
  const serialCall = suiteCalls.find((call) => call.args[1] === "--test-concurrency=1");
  // Against the frozen literal, never against a second `readdirSync`: comparing
  // the runner's enumeration with the same enumeration is a tautology that a
  // renamed-away suite satisfies on both sides.
  assert.deepEqual(fullCall.args.slice(1), CURRENT_TEST_FILES);
  assert.deepEqual(serialCall.args.slice(2), CURRENT_TEST_FILES);
});

// Three anchors, pinned pairwise: the literal frozen in this file, the literal
// the runner enforces, and the directory both of them describe. Any single edit
// breaks at least one pair.
test("the executable test inventory agrees across test literal, runner and directory", () => {
  assert.deepEqual([...EXPECTED_TEST_FILES], PINNED_TEST_FILES);
  assert.equal(PINNED_TEST_FILES.length, 55);

  const onDisk = readdirSync(join(repoRoot, "tests"))
    .filter((entry) => entry.endsWith(".test.mjs"))
    .sort()
    .map((entry) => join("tests", entry));
  assert.deepEqual(onDisk, CURRENT_TEST_FILES);

  assert.deepEqual([...EXPECTED_PROXY_FILES], PINNED_PROXY_FILES);
  assert.equal(PINNED_PROXY_FILES.length, 26);
  for (const relative of PINNED_PROXY_FILES) {
    assert.equal(statSync(join(repoRoot, relative)).isFile(), true, relative);
  }
  // The policy literal is frozen here too, and against the tree, so the runner
  // constant cannot be relaxed in step with the files it guards.
  assert.equal(EXPECTED_CODEX_POLICY, 'policy:\n  allow_implicit_invocation: false\n');
  // The agent allowlist literal is frozen here too, and read from the tree: reading and nothing else.
  assert.equal(EXPECTED_AGENT_TOOLS_LINE, "tools: Read");
  for (const relative of PINNED_PROXY_FILES.filter((path) => path.startsWith(".claude/agents/"))) {
    assert.match(read(join(repoRoot, relative)), /^---\nname: [a-z-]+\ndescription: "[^\n]+"\ntools: Read\nmodel: (haiku|sonnet)\n---\n/u, relative);
  }
  for (const relative of PINNED_PROXY_FILES.filter((path) => path.endsWith("openai.yaml"))) {
    assert.equal(read(join(repoRoot, relative)), EXPECTED_CODEX_POLICY, relative);
  }
});

// The name pin proves a suite still exists. This one proves no suite carries an
// unlisted suppression marker, and nothing more. What it deliberately does NOT
// prove, because a static scan cannot: that a suite still asserts anything. A
// case with an empty body, or one whose assertions were deleted, keeps both its
// name and its registration and passes this scan. Closing that needs executed
// case counts, which the aggregate runner does not collect from child
// processes; it is an open hole, not a covered one.
test("pinned suites keep a registration token and no suppression in the pinned spellings", () => {
  for (const relative of CURRENT_TEST_FILES) {
    const source = read(join(repoRoot, relative));
    // A token, and only a token. It catches a suite whose registrations were
    // removed wholesale; it says nothing about what the cases still assert.
    assert.match(source, /\btest\(/, relative);
    const allowed = ALLOWED_SUPPRESSIONS.get(relative) ?? [];
    const views = [
      ["as written", source],
      ["comments blanked", source
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ")],
    ];
    // The view is named in both messages: a finding that exists only after
    // blanking would otherwise report a marker that appears nowhere in the file
    // a maintainer can open.
    for (const [view, text] of views) {
      const found = [...text.replace(/\s+/g, " ").matchAll(SUPPRESSION_PATTERN)]
        .map((match) => match[0].trim());
      // Subset, not equality: an exemption may be removed, never added.
      assert.deepEqual(
        found.filter((marker) => !allowed.includes(marker)),
        [],
        `${relative} (${view})`,
      );
      // And never repeated: a subset test alone would accept the exempted
      // marker copied onto every case in the file.
      assert.ok(
        found.length <= allowed.length,
        `${relative} (${view}): ${found.length} markers, ${allowed.length} allowed`,
      );
    }
  }
  for (const relative of ALLOWED_SUPPRESSIONS.keys()) {
    assert.ok(PINNED_TEST_FILES.includes(relative), relative);
  }
  // The exemption list stays closed; widening it is a deliberate edit here.
  assert.equal(ALLOWED_SUPPRESSIONS.size, 1);
});

test("a drifted test inventory fails the full and serial stages", (t) => {
  const inventoryRoot = mkdtempSync(join(realpathSync(tmpdir()), "job-search-ci-inventory-"));
  t.after(() => rmSync(inventoryRoot, { force: true, recursive: true }));
  mkdirSync(join(inventoryRoot, "tests"));
  for (const relative of CURRENT_TEST_FILES) {
    writeFileSync(join(inventoryRoot, relative), SYNTHETIC_FIXTURE_MARKER);
  }
  const drive = (stage) => runStages({
    environment: {},
    spawn: () => successfulSpawn(),
    stageIds: [stage],
    workspaceRoot: inventoryRoot,
  });

  // A complete synthetic inventory is accepted, so the cases below fail on the
  // drift itself and not on the fixture being synthetic.
  for (const stage of ["full", "serial"]) {
    assert.deepEqual(drive(stage), [{ stage, status: "passed" }]);
  }

  const renamedAway = join(inventoryRoot, "tests", "proxies.test.mjs");
  rmSync(renamedAway);
  writeFileSync(`${renamedAway}.bak`, SYNTHETIC_FIXTURE_MARKER);
  for (const stage of ["full", "serial"]) {
    assert.throws(() => drive(stage), (error) => {
      assert.equal(error instanceof CiError, true);
      assert.equal(error.code, "ci_test_inventory_drift");
      assert.equal(error.stage, stage);
      assert.match(error.message, /missing \["tests\/proxies\.test\.mjs"\]/);
      assert.match(error.message, /unexpected \[\]/);
      return true;
    });
  }

  writeFileSync(renamedAway, SYNTHETIC_FIXTURE_MARKER);
  rmSync(`${renamedAway}.bak`);
  writeFileSync(join(inventoryRoot, "tests", "added.test.mjs"), SYNTHETIC_FIXTURE_MARKER);
  assert.throws(() => drive("full"), (error) => {
    assert.equal(error.code, "ci_test_inventory_drift");
    assert.match(error.message, /missing \[\]/);
    assert.match(error.message, /unexpected \["tests\/added\.test\.mjs"\]/);
    return true;
  });
});

test("a missing or permissive generated proxy fails the proxy stage", (t) => {
  const proxyRoot = mkdtempSync(join(realpathSync(tmpdir()), "job-search-ci-proxy-"));
  t.after(() => rmSync(proxyRoot, { force: true, recursive: true }));
  materializeProxyInventory(proxyRoot);
  const drive = () => runStages({
    environment: {},
    spawn: () => proxyReport(),
    stageIds: ["proxy"],
    workspaceRoot: proxyRoot,
  });
  assert.deepEqual(drive(), [{ stage: "proxy", status: "passed" }]);

  const metadata = PINNED_PROXY_FILES.filter((path) => path.endsWith("openai.yaml"));
  assert.equal(metadata.length, 7);

  // Presence is not enough. The generator can keep every path and every count
  // while emitting the policy inverted, which is the finding itself.
  writeFileSync(
    join(proxyRoot, metadata[0]),
    EXPECTED_CODEX_POLICY.replace("false", "true"),
  );
  assert.throws(drive, (error) => {
    assert.equal(error instanceof CiError, true);
    assert.equal(error.code, "ci_proxy_policy_drift");
    assert.equal(error.stage, "proxy");
    assert.ok(error.message.includes(metadata[0]), metadata[0]);
    return true;
  });

  writeFileSync(join(proxyRoot, metadata[0]), EXPECTED_CODEX_POLICY);

  // A generated agent whose allowlist grew: every path present, every count right, and a reader of
  // untrusted text holding a shell. The runner reads the frontmatter line, not the file's presence.
  const agents = PINNED_PROXY_FILES.filter((path) => path.startsWith(".claude/agents/"));
  assert.equal(agents.length, 3);
  writeFileSync(join(proxyRoot, agents[0]), SYNTHETIC_AGENT_FIXTURE.replace("tools: Read", "tools: Read, Bash"));
  assert.throws(drive, (error) => {
    assert.equal(error instanceof CiError, true);
    assert.equal(error.code, "ci_proxy_policy_drift");
    assert.equal(error.stage, "proxy");
    assert.ok(error.message.includes(agents[0]), agents[0]);
    return true;
  });
  writeFileSync(join(proxyRoot, agents[0]), SYNTHETIC_AGENT_FIXTURE);
  assert.deepEqual(drive(), [{ stage: "proxy", status: "passed" }]);

  // Exactly the composite that reintroduces the defect by deletion: the checker
  // keeps reporting `current` because its own expectation shrank with the
  // generator branch.
  for (const relative of metadata) rmSync(join(proxyRoot, relative));
  assert.throws(drive, (error) => {
    assert.equal(error instanceof CiError, true);
    assert.equal(error.code, "ci_proxy_inventory_incomplete");
    assert.equal(error.stage, "proxy");
    for (const relative of metadata) assert.ok(error.message.includes(relative), relative);
    return true;
  });
});

// The committed tree has to satisfy the same inventory the working tree does,
// or a defect could be committed while an untracked working tree stayed green.
test("the fresh-archive stage applies the same proxy inventory to the committed tree", (t) => {
  const roots = disposableRootFactory(t);
  const recorder = recordingSpawn();
  assert.deepEqual(
    runStages({
      createDisposableRoot: roots.factory,
      environment: {},
      spawn: recorder.spawn,
      stageIds: ["fresh-archive"],
      workspaceRoot: repoRoot,
    }),
    [{ stage: "fresh-archive", status: "passed" }],
  );

  const stripped = disposableRootFactory(t);
  assert.throws(
    () => runStages({
      createDisposableRoot: stripped.factory,
      environment: {},
      spawn: (command, args, options) => {
        const result = recorder.spawn(command, args, options);
        if (command === "tar") {
          const target = args[args.indexOf("-C") + 1];
          for (const relative of PINNED_PROXY_FILES.filter((p) => p.endsWith("openai.yaml"))) {
            rmSync(join(target, relative));
          }
        }
        return result;
      },
      stageIds: ["fresh-archive"],
      workspaceRoot: repoRoot,
    }),
    (error) => {
      assert.equal(error.code, "ci_proxy_inventory_incomplete");
      assert.equal(error.stage, "fresh-archive");
      return true;
    },
  );

  const permissive = disposableRootFactory(t);
  assert.throws(
    () => runStages({
      createDisposableRoot: permissive.factory,
      environment: {},
      spawn: (command, args, options) => {
        const result = recorder.spawn(command, args, options);
        if (command === "tar") {
          const target = args[args.indexOf("-C") + 1];
          const first = PINNED_PROXY_FILES.find((path) => path.endsWith("openai.yaml"));
          writeFileSync(
            join(target, first),
            EXPECTED_CODEX_POLICY.replace("false", "true"),
          );
        }
        return result;
      },
      stageIds: ["fresh-archive"],
      workspaceRoot: repoRoot,
    }),
    (error) => {
      assert.equal(error.code, "ci_proxy_policy_drift");
      assert.equal(error.stage, "fresh-archive");
      return true;
    },
  );

  // A directory in place of a metadata file passes the existence check, so the
  // read must still fail with this gate's own code rather than a raw errno.
  const unreadable = disposableRootFactory(t);
  assert.throws(
    () => runStages({
      createDisposableRoot: unreadable.factory,
      environment: {},
      spawn: (command, args, options) => {
        const result = recorder.spawn(command, args, options);
        if (command === "tar") {
          const target = args[args.indexOf("-C") + 1];
          const first = PINNED_PROXY_FILES.find((path) => path.endsWith("openai.yaml"));
          rmSync(join(target, first));
          mkdirSync(join(target, first));
        }
        return result;
      },
      stageIds: ["fresh-archive"],
      workspaceRoot: repoRoot,
    }),
    (error) => {
      assert.equal(error instanceof CiError, true);
      assert.equal(error.code, "ci_proxy_inventory_incomplete");
      assert.match(error.message, /unreadable/);
      return true;
    },
  );
});

test("no stage inherits an operational root through the child environment", (t) => {
  // The ambient variable is also set for real, not only injected. A stage that
  // reads `process.env` back and merges it into its own step environment only
  // when the variable is present is invisible to an injected input alone, and
  // that shape reopens the finding for whichever stage carries it.
  const hadOption = Object.prototype.hasOwnProperty.call(process.env, "NODE_OPTIONS");
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--test-only";
  t.after(() => {
    if (hadOption) process.env.NODE_OPTIONS = previous;
    else delete process.env.NODE_OPTIONS;
  });

  const driven = driveAllStages(t);
  for (const call of driven.calls) {
    for (const key of Object.keys(call.options.env)) {
      assert.equal(
        key.startsWith("JOB_PIPELINE_") && key !== "JOB_PIPELINE_BROWSER_BIN",
        false,
        `stage environment leaked ${key}`,
      );
      // The same scan covers the runtime family, and it covers every stage
      // rather than the two that run suites: the proxy checker and the
      // committed-tree instruction run are node children too, and a preload
      // reaches them all. The format stage clones the environment, so its
      // clone is scanned here as well.
      assert.equal(key.startsWith("NODE_"), false, `stage environment leaked ${key}`);
    }
    assert.equal(call.options.shell, false);
    const argv = `${call.command} ${call.args.join(" ")}`;
    assert.doesNotMatch(argv, /tools\/process-log\.mjs/);
    assert.doesNotMatch(argv, /tools\/bootstrap\.mjs/);
    assert.doesNotMatch(argv, /\bnpm\b/);
  }

  const environment = childEnvironment({
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.whitespace",
    GIT_CONFIG_VALUE_0: "-blank-at-eol",
    JOB_PIPELINE_BROWSER_BIN: "/usr/bin/google-chrome",
    JOB_PIPELINE_DISPOSABLE_ROOT_TOKEN: "token",
    JOB_PIPELINE_OUTPUT_ROOT: "/real/output",
    JOB_PIPELINE_PROCESS_LOG: "/real/process-log.json",
    JOB_PIPELINE_WORKSPACE_ROOT: "/real",
    NODE_OPTIONS: "--test-only",
    NODE_TEST_CONTEXT: "child-v8",
    PATH: "/usr/bin",
  });
  assert.deepEqual(environment, {
    JOB_PIPELINE_BROWSER_BIN: "/usr/bin/google-chrome",
    PATH: "/usr/bin",
  });
});

test("a failing, signalled, or missing child fails the run", (t) => {
  const failures = [
    { stderr: "", status: 1, stdout: "" },
    { signal: "SIGKILL", status: null, stderr: "", stdout: "" },
    { error: Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }), status: null },
  ];
  const codes = ["ci_step_failed", "ci_step_signalled", "ci_step_not_executed"];
  for (const [index, failure] of failures.entries()) {
    const roots = disposableRootFactory(t);
    assert.throws(
      () => runStages({
        createDisposableRoot: roots.factory,
        environment: {},
        spawn: () => failure,
        stageIds: ["proxy"],
        workspaceRoot: repoRoot,
      }),
      (error) => {
        assert.equal(error instanceof CiError, true);
        assert.equal(error.code, codes[index]);
        assert.equal(error.stage, "proxy");
        // Diagnostics name the tool, never the operator's interpreter path.
        assert.equal(error.message.startsWith("node "), true, error.message);
        assert.doesNotMatch(error.message, /[/\\]/);
        return true;
      },
    );
  }
});

test("a proxy inventory that is not current fails even when the checker exits zero", (t) => {
  const roots = disposableRootFactory(t);
  const current = { changed: [], files: 26, status: "current", unexpected: [] };
  for (const drift of [
    { changed: ["AGENTS.md"] },
    { unexpected: [".claude/skills/rogue"] },
    { status: "stale" },
    { files: 0 },
    { files: "26" },
    // 19 is the count the checker reports once the Codex metadata branch is
    // removed from the generator; 25 and 27 are the neighbouring off-by-ones a
    // "positive integer" predicate also accepted.
    { files: 19 },
    { files: 25 },
    { files: 27 },
  ]) {
    assert.throws(
      () => runStages({
        createDisposableRoot: roots.factory,
        environment: {},
        spawn: () => ({
          status: 0,
          stderr: "",
          stdout: JSON.stringify({ ...current, ...drift }),
        }),
        stageIds: ["proxy"],
        workspaceRoot: repoRoot,
      }),
      (error) => {
        assert.equal(error.code, "ci_proxy_inventory_not_current", JSON.stringify(drift));
        return true;
      },
    );
  }
});

// The scrub list is the only thing standing between an ambient git variable and
// a stage that inspects a repository nobody asked about.
test("the scrubbed environment prefixes cover every git redirection variable", () => {
  for (const prefix of [
    "JOB_PIPELINE_", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_ATTR",
    "GIT_CEILING_DIRECTORIES", "GIT_CONFIG", "GIT_DIR", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_WORK_TREE",
  ]) {
    assert.equal(SCRUBBED_ENVIRONMENT_PREFIXES.includes(prefix), true, prefix);
    assert.deepEqual(
      childEnvironment({ [`${prefix}X`]: "hostile", PATH: "/usr/bin" }),
      { PATH: "/usr/bin" },
      prefix,
    );
  }
});

// Frozen as exact sets rather than as membership tests. A subset assertion
// cannot see a widened list, and it cannot see a name moved into the preserved
// list, which `childEnvironment` consults first and which therefore overrides
// every prefix below it.
test("the scrub and preserve lists are frozen as exact sets", () => {
  assert.deepEqual([...SCRUBBED_ENVIRONMENT_PREFIXES], PINNED_SCRUBBED_PREFIXES);
  assert.deepEqual([...PRESERVED_ENVIRONMENT_VARIABLES], PINNED_PRESERVED_VARIABLES);
  // One preserved name sits deliberately inside a scrubbed prefix. It is the
  // single sanctioned bypass, so it is named here rather than counted.
  assert.deepEqual(
    PINNED_PRESERVED_VARIABLES.filter(
      (name) => PINNED_SCRUBBED_PREFIXES.some((prefix) => name.startsWith(prefix)),
    ),
    ["JOB_PIPELINE_BROWSER_BIN"],
  );
});

// The git case above builds a fabricated `${prefix}X` name. That shape cannot
// see the bypass that matters: moving a real spelling into the preserved list
// leaves the invented name scrubbed and the assertion green. These are the
// exact names observed to make a stage report success without running a case.
test("the observed ambient silencers are removed and unrelated names survive", () => {
  for (const key of ["NODE_OPTIONS", "NODE_TEST_CONTEXT"]) {
    assert.deepEqual(
      childEnvironment({ [key]: "hostile", PATH: "/usr/bin" }),
      { PATH: "/usr/bin" },
      key,
    );
  }
  // Real values as well as real names. No other case here carries a preload
  // spelling, so a carve-out conditioned on the value survives all of them
  // while leaving open the one shape that reaches every node child, the proxy
  // checker included.
  for (const value of [
    "--require=/tmp/preload.cjs",
    "--import=data:text/javascript,",
    "--test-only",
    "--max-old-space-size=8192",
  ]) {
    assert.deepEqual(
      childEnvironment({ NODE_OPTIONS: value, PATH: "/usr/bin" }),
      { PATH: "/usr/bin" },
      value,
    );
  }
  // Removed as a consequence of taking the whole prefix, not because it was
  // observed to silence anything: it was not. The accepted cost is that a
  // gate run can no longer be instrumented through this variable.
  assert.deepEqual(
    childEnvironment({ NODE_V8_COVERAGE: "/tmp/coverage", PATH: "/usr/bin" }),
    { PATH: "/usr/bin" },
  );
  // Anchored at the start of the name. A match that drifted to containment
  // would eat unrelated variables; one that drifted to equality would let every
  // real spelling through. The bare `NODE` that npm sets is deliberately kept.
  const unrelated = {
    MY_NODE_OPTIONS: "kept",
    NODE: "/usr/bin/node",
    NODEX_OPTIONS: "kept",
    PATH: "/usr/bin",
  };
  assert.deepEqual(childEnvironment({ ...unrelated }), unrelated);
});

// Every other case here injects an environment explicitly, so all of them would
// stay green if the default stopped scrubbing. This one covers the default
// itself; that `main()` still takes it is covered end to end by the shipped-entry
// arm further down. This process is itself a `node --test` child, so its own
// environment already carries `NODE_TEST_CONTEXT`.
test("the default child environment scrubs the ambient process environment", (t) => {
  const hadOption = Object.prototype.hasOwnProperty.call(process.env, "NODE_OPTIONS");
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--test-only";
  t.after(() => {
    if (hadOption) process.env.NODE_OPTIONS = previous;
    else delete process.env.NODE_OPTIONS;
  });

  const recorder = recordingSpawn();
  runStages({
    environment: undefined,
    spawn: recorder.spawn,
    stageIds: ["proxy"],
    workspaceRoot: repoRoot,
  });
  assert.equal(recorder.calls.length > 0, true);
  for (const call of recorder.calls) {
    for (const key of Object.keys(call.options.env)) {
      assert.equal(key.startsWith("NODE_"), false, key);
    }
  }
});

// The cases above are shape; this one is behaviour. A real `node --test` child
// runs a suite that fails on its own, and the two arms differ by exactly
// `childEnvironment`. The silenced arm deliberately uses the caller-supplied
// `environment` option, which is not scrubbed: that seam is what makes the
// runner testable, `main()` never passes it, and driving it here is what turns
// this case into a control instead of an assertion that could pass for some
// other ambient reason. Execution is proved by a sentinel the case itself
// writes, because the reporter names a case only when it fails, and because a
// non-zero exit is also what a load error or a missing file produces.
test("an ambient runtime variable silences a real stage until the environment is scrubbed", (t) => {
  const fixtureRoot = mkdtempSync(join(realpathSync(tmpdir()), "job-search-ci-ambient-"));
  t.after(() => rmSync(fixtureRoot, { force: true, recursive: true }));
  mkdirSync(join(fixtureRoot, "tests"));
  const sentinelPath = join(fixtureRoot, "case-executed");
  const writeSuite = (body) => writeFileSync(
    join(fixtureRoot, "tests", "instruction-contracts.test.mjs"),
    SYNTHETIC_FIXTURE_MARKER
    + 'import assert from "node:assert/strict";\n'
    + 'import { writeFileSync } from "node:fs";\n'
    + 'import test from "node:test";\n'
    + 'test("synthetic ambient-scrub fixture case", () => {\n'
    + `  writeFileSync(${JSON.stringify(sentinelPath)}, "executed");\n`
    + `  ${body}\n`
    + "});\n",
  );

  const drive = (environment) => {
    rmSync(sentinelPath, { force: true });
    let failure = null;
    try {
      runStages({
        environment,
        spawn: spawnSync,
        stageIds: ["instruction"],
        workspaceRoot: fixtureRoot,
      });
    } catch (error) {
      failure = error;
    }
    return { executed: existsSync(sentinelPath), failure };
  };

  writeSuite("assert.equal(1, 2);");
  for (const silencer of [
    { NODE_OPTIONS: "--test-only" },
    { NODE_OPTIONS: "--test-name-pattern=matches-no-case-in-this-fixture" },
    { NODE_OPTIONS: "--test-skip-pattern=." },
    // Read by node directly, with no `NODE_OPTIONS` involved: it makes the
    // runner treat itself as an inner run and skip the files it was given.
    // This spelling is why the entry is the whole prefix and not one name.
    { NODE_TEST_CONTEXT: "child-v8" },
    { NODE_TEST_CONTEXT: "child" },
  ]) {
    const ambient = { ...silencer, PATH: "/usr/bin" };
    const label = JSON.stringify(silencer);

    const silenced = drive({ ...ambient });
    assert.equal(silenced.failure, null, label);
    assert.equal(silenced.executed, false, label);

    const scrubbed = drive(childEnvironment({ ...ambient }));
    assert.equal(scrubbed.failure instanceof CiError, true, label);
    assert.equal(scrubbed.failure.code, "ci_step_failed", label);
    assert.equal(scrubbed.failure.stage, "instruction", label);
    assert.equal(scrubbed.executed, true, label);
  }

  // Recovery. Scrubbing must not turn a legitimate run red, and a pass has to
  // remain a real pass: the case runs and the stage reports success. The
  // benign option is discarded along with the hostile ones, which is the cost
  // this design accepts rather than hides.
  writeSuite("assert.equal(1, 1);");
  const recovered = drive(childEnvironment({
    NODE_OPTIONS: "--max-old-space-size=8192",
    PATH: "/usr/bin",
  }));
  assert.equal(recovered.failure, null);
  assert.equal(recovered.executed, true);

  // The production entry. Every arm above calls `runStages` directly and would
  // stay green if `main()` stopped taking the scrubbed default — one added
  // option there reopens the finding, and `main()` is what `npm run ci` runs.
  // The runner is copied into the fixture root so its own `repoRoot` resolves
  // there and the stage runs this one synthetic file instead of this
  // repository's suite. Bound of this arm, stated rather than implied: only
  // `instruction` ever executes here, because a run stops at its first failing
  // stage. The six other stages are reached as argv but never as behaviour,
  // and what covers them is the environment scan above.
  mkdirSync(join(fixtureRoot, "tools"));
  writeFileSync(join(fixtureRoot, "tools", "ci.mjs"), read(runnerPath));
  writeSuite("assert.equal(1, 2);");
  const shipped = (ambient, argv) => {
    rmSync(sentinelPath, { force: true });
    const result = spawnSync(
      process.execPath,
      [join(fixtureRoot, "tools", "ci.mjs"), ...argv],
      { cwd: fixtureRoot, encoding: "utf8", env: ambient, shell: false },
    );
    return { executed: existsSync(sentinelPath), result };
  };
  const oneStage = ["--stage", "instruction"];
  // The npm script runs the runner with no arguments at all, which parses to
  // the whole stage list. A leak conditioned on that list survives every
  // one-stage arm, so the last arm asks for all seven with `instruction` first:
  // the run fails there and never reaches the stages this fixture cannot
  // satisfy, while the argv it was given is the shape production uses.
  const everyStage = CI_STAGES
    .slice()
    .sort((left, right) => Number(right === "instruction") - Number(left === "instruction"))
    .flatMap((stage) => ["--stage", stage]);
  for (const [ambient, argv] of [
    // The clean run is here for readability, not for coverage: under correct
    // code all these arms hand the child the identical environment, and it
    // kills nothing the others do not. What keeps every arm from passing
    // vacuously is `executed`, asserted per arm below.
    [{ PATH: "/usr/bin" }, oneStage],
    [{ NODE_OPTIONS: "--test-only", PATH: "/usr/bin" }, oneStage],
    [{ NODE_TEST_CONTEXT: "child-v8", PATH: "/usr/bin" }, oneStage],
    [{ NODE_OPTIONS: "--test-only", PATH: "/usr/bin" }, everyStage],
  ]) {
    const label = `${JSON.stringify(ambient)} ${argv.length / 2} stages`;
    const observed = shipped(ambient, argv);
    assert.equal(observed.result.status, 1, label);
    // The runner writes the failing child's own output to stderr ahead of its
    // verdict, and nothing forbids a later line on that stream, so the verdict
    // is read as the last `{`-initial line rather than as the last line.
    const verdict = observed.result.stderr
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .at(-1);
    assert.equal(typeof verdict, "string", label);
    const reported = JSON.parse(verdict);
    assert.equal(reported.error.code, "ci_step_failed", label);
    assert.equal(reported.stage, "instruction", label);
    assert.equal(observed.executed, true, label);
  }
});

test("the fresh-archive stage stays inside a disposable root and cleans up", (t) => {
  const driven = driveAllStages(t);
  assert.equal(driven.roots.length, 1);
  const root = driven.roots[0];
  assert.equal(statSync(dirname(root)).isDirectory(), true);
  assert.equal(dirname(root), realpathSync(tmpdir()));
  assert.throws(() => statSync(root), { code: "ENOENT" });

  const archiveCall = driven.calls.find((call) => call.command === "git"
    && call.args[0] === "archive");
  assert.equal(archiveCall.args.at(-1), "HEAD");
  assert.ok(archiveCall.args[3].startsWith(root));
  const extractCall = driven.calls.find((call) => call.command === "tar");
  assert.ok(extractCall.args.at(-1).startsWith(root));
});

test("an incomplete or pre-installed committed tree fails the fresh-archive stage", (t) => {
  for (const [code, prepare] of [
    ["ci_archive_incomplete", (target) => {
      mkdirSync(join(target, "tools", "cv-builder"), { recursive: true });
      writeFileSync(join(target, "package-lock.json"), "{}\n");
    }],
    ["ci_archive_not_clean", (target) => {
      mkdirSync(join(target, "tools", "cv-builder"), { recursive: true });
      mkdirSync(join(target, "node_modules"), { recursive: true });
      writeFileSync(join(target, "package-lock.json"), "{}\n");
      writeFileSync(join(target, "tools", "cv-builder", "package-lock.json"), "{}\n");
    }],
    // The private candidate layer is ignored, so it reaches a commit only by a
    // deliberate force-add — and the archive is where that becomes visible,
    // because the archive is exactly what an export ships.
    ["ci_archive_not_clean", (target) => {
      mkdirSync(join(target, "tools", "cv-builder"), { recursive: true });
      mkdirSync(join(target, "candidate"), { recursive: true });
      writeFileSync(join(target, "package-lock.json"), "{}\n");
      writeFileSync(join(target, "tools", "cv-builder", "package-lock.json"), "{}\n");
    }],
  ]) {
    const roots = disposableRootFactory(t);
    assert.throws(
      () => runStages({
        createDisposableRoot: roots.factory,
        environment: {},
        spawn: (command, args) => {
          if (command === "tar") {
            prepare(args[args.indexOf("-C") + 1]);
          }
          return successfulSpawn();
        },
        stageIds: ["fresh-archive"],
        workspaceRoot: repoRoot,
      }),
      (error) => {
        assert.equal(error instanceof CiError, true, code);
        assert.equal(error.code, code);
        assert.equal(error.stage, "fresh-archive");
        return true;
      },
    );
  }
});

// The production factory is what ships; an oracle that only ever injects its own
// factory would let a regression point the archive root at the repository.
test("the shipped disposable-root factory is used and its guard is live", (t) => {
  const recorder = recordingSpawn();
  const observed = [];
  runStages({
    createDisposableRoot: undefined,
    environment: {},
    spawn: (command, args, options) => {
      if (command === "tar") observed.push(args[args.indexOf("-C") + 1]);
      return recorder.spawn(command, args, options);
    },
    stageIds: ["fresh-archive"],
    workspaceRoot: repoRoot,
  });
  assert.equal(observed.length, 1);
  const treeRoot = observed[0];
  assert.equal(dirname(dirname(treeRoot)), realpathSync(tmpdir()));
  assert.equal(treeRoot.startsWith(repoRoot), false);
  assert.throws(() => statSync(dirname(treeRoot)), { code: "ENOENT" });

  // The guard is exercised with a nested path that is still under the system
  // temporary directory, so this test never names a repository path and the
  // runner's cleanup can never delete one.
  const outerRoot = mkdtempSync(join(realpathSync(tmpdir()), "job-search-ci-guard-"));
  t.after(() => rmSync(outerRoot, { force: true, recursive: true }));
  const nestedRoot = join(outerRoot, "nested", "root");
  assert.throws(
    () => runStages({
      createDisposableRoot: () => {
        mkdirSync(nestedRoot, { recursive: true });
        return nestedRoot;
      },
      environment: {},
      spawn: recorder.spawn,
      stageIds: ["fresh-archive"],
      workspaceRoot: repoRoot,
    }),
    (error) => {
      assert.equal(error.code, "ci_archive_root_not_disposable");
      return true;
    },
  );
});

// The regex part is a tripwire against the obvious form; the inventory part is
// the actual proof that driving every stage leaves the checkout untouched.
test("no stage or test writes into the repository working tree", (t) => {
  for (const entry of readdirSync(join(repoRoot, "tests"))) {
    if (!entry.endsWith(".test.mjs")) continue;
    const source = read(join(repoRoot, "tests", entry));
    assert.doesNotMatch(source, /mkdirSync\(\s*(join|resolve)\(\s*repoRoot/, entry);
    assert.doesNotMatch(source, /writeFileSync\(\s*(join|resolve)\(\s*repoRoot/, entry);
    assert.doesNotMatch(source, /rmSync\(\s*(join|resolve)\(\s*repoRoot/, entry);
  }

  const inventory = () => readdirSync(repoRoot).sort().join("\n");
  const before = inventory();
  driveAllStages(t);
  assert.equal(inventory(), before);
});

test("every defensive failure names its own cause", (t) => {
  const roots = disposableRootFactory(t);
  const cases = [
    {
      code: "ci_proxy_report_unreadable",
      spawn: () => ({ status: 0, stderr: "", stdout: "not json" }),
      stage: "proxy",
    },
    {
      code: "ci_empty_tree_unresolved",
      spawn: (_command, args) => (args.includes("hash-object")
        ? { status: 0, stderr: "", stdout: "not-an-object-id\n" }
        : successfulSpawn()),
      stage: "format",
    },
  ];
  for (const scenario of cases) {
    assert.throws(
      () => runStages({
        createDisposableRoot: roots.factory,
        environment: {},
        spawn: scenario.spawn,
        stageIds: [scenario.stage],
        workspaceRoot: repoRoot,
      }),
      (error) => {
        assert.equal(error.code, scenario.code);
        assert.equal(error.stage, scenario.stage);
        return true;
      },
    );
  }

  const emptyRoot = mkdtempSync(join(realpathSync(tmpdir()), "job-search-ci-empty-"));
  t.after(() => rmSync(emptyRoot, { force: true, recursive: true }));
  mkdirSync(join(emptyRoot, "tests"));
  assert.throws(
    () => runStages({
      environment: {},
      spawn: () => successfulSpawn(),
      stageIds: ["full"],
      workspaceRoot: emptyRoot,
    }),
    (error) => {
      assert.equal(error.code, "ci_no_tests_found");
      assert.equal(error.stage, "full");
      return true;
    },
  );
});

test("the format stage fails on committed whitespace errors", (t) => {
  const fixtureRoot = mkdtempSync(join(realpathSync(tmpdir()), "job-search-ci-format-"));
  t.after(() => rmSync(fixtureRoot, { force: true, recursive: true }));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: fixtureRoot, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  prepareFormatFixture(fixtureRoot);
  git("init", "--quiet", ".");
  git("config", "user.email", "ci@example.invalid");
  git("config", "user.name", "ci");
  writeFileSync(join(fixtureRoot, "clean.txt"), "clean line\n");
  git("add", "clean.txt");
  git("commit", "--quiet", "-m", "clean");

  assert.deepEqual(
    runStages({
      environment: childEnvironment(process.env),
      spawn: spawnSync,
      stageIds: ["format"],
      workspaceRoot: fixtureRoot,
    }),
    [{ stage: "format", status: "passed" }],
  );

  writeFileSync(join(fixtureRoot, "dirty.txt"), "trailing whitespace   \n");
  git("add", "dirty.txt");
  git("commit", "--quiet", "-m", "dirty");
  const expectFormatFailure = (environment) => assert.throws(
    () => runStages({
      environment,
      spawn: spawnSync,
      stageIds: ["format"],
      workspaceRoot: fixtureRoot,
    }),
    (error) => {
      assert.equal(error.code, "ci_step_failed");
      assert.equal(error.stage, "format");
      return true;
    },
  );
  expectFormatFailure(childEnvironment(process.env));

  // Neither a repository setting nor an injected git configuration may switch
  // the whitespace checks off: the stage pins them on the command line and the
  // child environment is scrubbed of GIT_CONFIG_*.
  git("config", "core.whitespace", "-blank-at-eol,-space-before-tab,-blank-at-eof");
  expectFormatFailure(childEnvironment(process.env));
  expectFormatFailure(childEnvironment({
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.whitespace",
    GIT_CONFIG_VALUE_0: "-blank-at-eol,-space-before-tab,-blank-at-eof",
  }));
  git("config", "--unset", "core.whitespace");

  // A committed `.gitattributes` is repository content: one commit could add
  // both the defect and the attribute that hides it.
  for (const attributes of [
    "* -whitespace",
    "* whitespace=-blank-at-eol,-space-before-tab,-blank-at-eof",
    "* binary",
    "* -diff",
  ]) {
    writeFileSync(join(fixtureRoot, ".gitattributes"), `${attributes}\n`);
    git("add", ".gitattributes");
    git("commit", "--quiet", "-m", `attributes: ${attributes}`);
    expectFormatFailure(childEnvironment(process.env));
  }
  git("rm", "--quiet", ".gitattributes");
  git("commit", "--quiet", "-m", "drop attributes");

  // The same silencing is reachable through an operator-level attributes file.
  const globalAttributes = join(fixtureRoot, "global-attributes");
  writeFileSync(globalAttributes, "* -whitespace\n");
  git("config", "core.attributesFile", globalAttributes);
  expectFormatFailure(childEnvironment(process.env));
  git("config", "--unset", "core.attributesFile");

  // `info/attributes` has no command-line override, so the stage refuses to run
  // rather than reporting a result it cannot trust.
  mkdirSync(join(fixtureRoot, ".git", "info"), { recursive: true });
  writeFileSync(join(fixtureRoot, ".git", "info", "attributes"), "* -whitespace\n");
  assert.throws(
    () => runStages({
      environment: childEnvironment(process.env),
      spawn: spawnSync,
      stageIds: ["format"],
      workspaceRoot: fixtureRoot,
    }),
    (error) => {
      assert.equal(error.code, "ci_repository_attributes_override");
      assert.equal(error.stage, "format");
      return true;
    },
  );
  rmSync(join(fixtureRoot, ".git", "info", "attributes"));

  // A redirected git cannot make the stage inspect a different repository.
  const decoy = mkdtempSync(join(realpathSync(tmpdir()), "job-search-ci-decoy-"));
  t.after(() => rmSync(decoy, { force: true, recursive: true }));
  for (const argv of [["init", "--quiet", "."], ["config", "user.email", "ci@example.invalid"],
    ["config", "user.name", "ci"]]) {
    assert.equal(spawnSync("git", argv, { cwd: decoy, encoding: "utf8" }).status, 0);
  }
  writeFileSync(join(decoy, "clean.txt"), "clean line\n");
  for (const argv of [["add", "clean.txt"], ["commit", "--quiet", "-m", "clean"]]) {
    assert.equal(spawnSync("git", argv, { cwd: decoy, encoding: "utf8" }).status, 0);
  }
  expectFormatFailure(childEnvironment({
    ...process.env,
    GIT_DIR: join(decoy, ".git"),
    GIT_WORK_TREE: decoy,
  }));
});

test("a failure that the runner did not raise still names its stage", (t) => {
  const roots = disposableRootFactory(t);
  assert.throws(
    () => runStages({
      createDisposableRoot: roots.factory,
      environment: {},
      spawn: () => {
        throw new TypeError("spawn is not a function");
      },
      stageIds: ["proxy"],
      workspaceRoot: repoRoot,
    }),
    (error) => {
      assert.equal(error instanceof CiError, false);
      assert.equal(error.stage, "proxy");
      return true;
    },
  );

  // The command line must print that label too, not only carry it internally.
  const isolated = mkdtempSync(join(realpathSync(tmpdir()), "job-search-ci-isolated-"));
  t.after(() => rmSync(isolated, { force: true, recursive: true }));
  mkdirSync(join(isolated, "tools"));
  writeFileSync(join(isolated, "tools", "ci.mjs"), read(runnerPath));
  const result = spawnSync(
    process.execPath,
    [join(isolated, "tools", "ci.mjs"), "--stage", "full"],
    { cwd: isolated, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  const reported = JSON.parse(result.stderr);
  assert.equal(reported.status, "error");
  assert.equal(reported.stage, "full");
  // Pinned, not incidental: this root has no tests directory at all, so the
  // failure must stay the unexpected-exception path. Moving the inventory check
  // ahead of the directory read would silently change this code.
  assert.equal(reported.error.code, "ci_failed");
});

// The prose in the technical owner names both sizes; without this the README
// numbers could drift from the gate they describe and nothing would fail.
test("the README states the inventory sizes the runner enforces", () => {
  const readme = read(readmePath);
  // Anchored to this file's frozen literals, not to the runner's exports, so
  // prose and literal are pinned directly and literal and export are pinned by
  // the case above. All three pairs are wired, none of them transitively.
  assert.match(
    readme,
    new RegExp(`exactly ${PINNED_TEST_FILES.length} public executable test files`),
  );
  assert.match(
    readme,
    new RegExp(`exactly ${PINNED_PROXY_FILES.length} generated proxy files`),
  );
  const nonBrowser = PINNED_TEST_FILES
    .filter((relative) => !relative.endsWith("process-search-browser.test.mjs"));
  assert.match(readme, new RegExp(`own glob over the ${nonBrowser.length} public non-browser files`));
});

test("reported child output is bounded and the scrub covers bare GIT_CONFIG", () => {
  const limit = 16;
  assert.equal(tailOutput("short", limit), "short");
  const long = "x".repeat(limit * 4);
  const bounded = tailOutput(long, limit);
  assert.equal(bounded.length, limit + 1);
  assert.equal(bounded.startsWith("…"), true);
  assert.equal(tailOutput(undefined, limit), "");

  assert.deepEqual(
    childEnvironment({ GIT_CONFIG: "/tmp/hostile", GIT_CONFIG_GLOBAL: "/tmp/g", PATH: "/usr/bin" }),
    { PATH: "/usr/bin" },
  );
});

test("the runner rejects unusable arguments and unknown stages", (t) => {
  for (const argv of [["--stage"], ["--stage", "nope"], ["--all"], ["--list", "extra"]]) {
    const result = spawnSync(process.execPath, [runnerPath, ...argv], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.code, "invalid_ci_arguments");
  }
  const roots = disposableRootFactory(t);
  assert.throws(
    () => runStages({
      createDisposableRoot: roots.factory,
      spawn: () => successfulSpawn(),
      stageIds: ["publish"],
      workspaceRoot: repoRoot,
    }),
    (error) => {
      assert.equal(error.code, "ci_unknown_stage");
      return true;
    },
  );
});

// The runner runs the whole suite, so any other test that reached back into the
// runner would recurse without bound. This file is the single allowed caller and
// only uses the pure listing and argument-validation modes.
test("no other test re-enters the runner", () => {
  for (const entry of readdirSync(join(repoRoot, "tests"))) {
    if (!entry.endsWith(".test.mjs") || entry === "ci.test.mjs") continue;
    const source = read(join(repoRoot, "tests", entry));
    assert.doesNotMatch(source, /npm run ci\b/, entry);
    assert.doesNotMatch(source, /"run",\s*"ci"/, entry);
    assert.doesNotMatch(source, /ci\.mjs/, entry);
  }
});

test("blocking publishability refuses findings and absent tracked files even on a successful child", () => {
  for (const detail of [{ places_exported: 1 }, { absent: 1 }]) {
    assert.throws(() => runStages({ workspaceRoot: repoRoot, stageIds: ["publishability"], spawn: () => ({ status: 0, stdout: JSON.stringify({ by_class: {}, ...detail }) }) }), e => e.code === "ci_publishability_findings");
  }
});


// A copied CLI in a disposable repository resolves the installed formatter
// dependency through a read-only link; every source write stays in the fixture.
function prepareFormatFixture(root) {
  mkdirSync(join(root, "tools"), { recursive: true });
  writeFileSync(join(root, "tools", "format.mjs"), read(join(repoRoot, "tools", "format.mjs")));
  writeFileSync(join(root, ".prettierrc.json"), read(join(repoRoot, ".prettierrc.json")));
  writeFileSync(join(root, ".prettierignore"), read(join(repoRoot, ".prettierignore")));
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
}

function formatterFixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "job-search-prettier-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  prepareFormatFixture(root);
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: root, encoding: "utf8", env: childEnvironment(process.env), shell: false,
    });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "--quiet", ".");
  git("config", "user.email", "formatter@example.invalid");
  git("config", "user.name", "formatter");
  return { root, git };
}

test("tracked formatter includes dotfiles, preserves exclusions and ignores untracked files", async (t) => {
  const { root, git } = formatterFixture(t);
  const samples = {
    "code.mjs": "const value={answer:42};\n",
    "a space.md": "| A | B |\n| --- | --- |\n| small | larger |\n",
    ".settings.json": '{"a":1}\n',
    "tools/fixtures/sample.json": '{"a":1}\n',
    "candidate.example/config.json": '{"a":1}\n',
    ".agents/skills/example/SKILL.md": "*example*\n",
    ".claude/agents/example.md": "*example*\n",
    ".claude/skills/example/SKILL.md": "*example*\n",
    "AGENTS.md": "*example*\n",
    "CLAUDE.md": "*example*\n",
    "package-lock.json": '{"a":1}\n',
    "plain.txt": "plain text\n",
  };
  for (const [name, source] of Object.entries(samples)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), source);
  }
  git("add", "--", ...Object.keys(samples));
  writeFileSync(join(root, "untracked.js"), "const untouched={a:1};\n");
  const before = await formatTrackedFiles({ root });
  assert.deepEqual(before.changed.sort(), [".settings.json", "a space.md", "code.mjs"]);
  assert.equal(before.checked, 3);
  assert.equal(before.ignored, 8);
  assert.equal(before.unsupported, 1);
  assert.equal(read(join(root, "code.mjs")), samples["code.mjs"], "check never writes");
  const written = await formatTrackedFiles({ root, write: true });
  assert.deepEqual(written, before);
  assert.deepEqual((await formatTrackedFiles({ root })).changed, []);
  for (const name of Object.keys(samples).filter((name) => !before.changed.includes(name))) {
    assert.equal(read(join(root, name)), samples[name], name);
  }
  assert.equal(read(join(root, "untracked.js")), "const untouched={a:1};\n");
});

test("format CI rejects clean-whitespace code until Prettier formats it", async (t) => {
  const { root, git } = formatterFixture(t);
  writeFileSync(join(root, "code.mjs"), "const value={answer:42};\n");
  git("add", "code.mjs");
  git("commit", "--quiet", "-m", "unformatted code");
  const run = () => runStages({
    environment: childEnvironment(process.env), spawn: spawnSync,
    stageIds: ["format"], workspaceRoot: root,
  });
  assert.throws(run, (error) => error.code === "ci_step_failed" && error.stage === "format");
  await formatTrackedFiles({ root, write: true });
  git("add", "code.mjs");
  git("commit", "--quiet", "-m", "formatted code");
  assert.deepEqual(run(), [{ stage: "format", status: "passed" }]);
});

test("formatter CLI refuses bad arguments, parse errors and absent git inventory", (t) => {
  const { root, git } = formatterFixture(t);
  const cli = (argv) => spawnSync(process.execPath, [join(root, "tools", "format.mjs"), ...argv], {
    cwd: root, encoding: "utf8", env: childEnvironment(process.env), shell: false,
  });
  for (const argv of [[], ["--unknown"], ["--write", "--check"]]) {
    assert.equal(cli(argv).status, 1);
  }
  writeFileSync(join(root, "broken.json"), "{broken\n");
  git("add", "broken.json");
  assert.equal(cli(["--check"]).status, 1);
  writeFileSync(join(root, "broken.json"), '{}\n');
  writeFileSync(join(root, ".prettierrc.json"), "{broken\n");
  assert.equal(cli(["--check"]).status, 1);
  rmSync(join(root, ".git"), { recursive: true });
  assert.equal(cli(["--write"]).status, 1);
});
