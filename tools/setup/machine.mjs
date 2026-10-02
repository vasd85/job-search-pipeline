#!/usr/bin/env node

/**
 * Set up a machine from the engine clone this script lives in (tools/setup/README.md).
 *
 *   npm run setup:machine -- [--private <url>] [--operational] [--check]
 *
 * Every path is derived, none is typed: the engine root is where this file lies, the private
 * repository is its `candidate` directory, the projects root is the engine's parent, and the
 * operational folder is `job-search-pipeline` beside the engine. What a step would do when it has
 * already been done, it skips, so a second run changes nothing.
 *
 * 1. The engine root must be a primary clone — a `.git` directory — which a linked working copy
 *    and the operational folder (no git at all) are not.
 * 2. The private repository is cloned into `candidate` when absent; when present it must be a
 *    repository of its own, the one `--private` names if given, and ignored by the engine.
 * 3. Dependencies are installed with the two `npm ci` commands of `.github/workflows/ci.yml`,
 *    unless the cv-builder's dependency check is already satisfied.
 * 4. `core.hooksPath` of the clone is set to the absolute `tools/git-hooks`: the pre-push guard
 *    and the pre-commit whitespace check.
 * 5. With `--operational` only: the templates of the layer's `machine` directory are rendered
 *    into their fixed targets — the operational folder's local Claude Code settings and the backup
 *    LaunchAgent — and the agent is registered with launchd unless launchd already knows it. The
 *    target table lives here; the layer supplies only the text. An existing target with other
 *    content is refused, never overwritten.
 * 6. The machine check: the toolchain, the layer, the hook path; with `--operational` also both
 *    targets, the registered agent and the operational folder's own preflight. `--check` runs
 *    only this step.
 *
 * External programs run as argument lists without a shell (ADR 0011); the private URL is passed
 * after `--`, and one that begins with `-` is refused.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkToolchain as realCheckToolchain } from "../bootstrap.mjs";
import { inspectCandidateLayer } from "../candidate/load.mjs";
import { checkCvBuilderDependencies } from "../cv-builder/check-dependencies.mjs";
import { LAUNCH_AGENT_LABEL } from "../operational-backup.mjs";
import { PRIVATE_DIRECTORY_NAME } from "../board/git.mjs";
import { SetupError, fail, lastLines, mustRun, report, reportError, run } from "./run.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const OPERATIONAL_FOLDER_NAME = "job-search-pipeline";
export const TEMPLATE_DIRECTORY = "machine";
export const HOOKS_DIRECTORY = join("tools", "git-hooks");
export const BACKUP_DIRECTORY = join("Backups", "job-search-pipeline");

/** The same two commands `.github/workflows/ci.yml` installs dependencies with. */
export const INSTALL_COMMANDS = Object.freeze([
  Object.freeze(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]),
  Object.freeze(["ci", "--prefix", join("tools", "cv-builder"), "--ignore-scripts", "--no-audit", "--no-fund"]),
]);

/** Template of the layer → where it lands. The layer never names a target itself. */
export const TEMPLATES = Object.freeze([
  Object.freeze({
    format: "json",
    template: "settings.local.json",
    target: ({ operationalRoot }) => join(operationalRoot, ".claude", "settings.local.json"),
  }),
  Object.freeze({
    format: "xml",
    template: "backup.plist",
    target: ({ home }) => join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`),
  }),
]);

export const USAGE = "use [--private <url>] [--operational] [--check]";

// A rendered value is a path written into XML and JSON verbatim; anything that would need
// escaping in either is refused rather than escaped, so a template stays readable as it lands.
const UNSAFE_VALUE = /[&<>"'\\\u0000-\u001f\u007f]/u;
const PLACEHOLDER = /\{\{([^{}]*)\}\}/gu;

export function parseArguments(argv) {
  const parsed = { check: false, operational: false, privateUrl: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--check" && !parsed.check) parsed.check = true;
    else if (flag === "--operational" && !parsed.operational) parsed.operational = true;
    else if (flag === "--private" && parsed.privateUrl === null && index + 1 < argv.length) {
      parsed.privateUrl = argv[index + 1];
      index += 1;
    } else fail("setup_machine_invalid_arguments", USAGE);
  }
  if (parsed.privateUrl !== null) {
    const url = parsed.privateUrl;
    if (url.length === 0 || url.startsWith("-") || /[\s\u0000-\u001f\u007f]/u.test(url)) {
      fail("setup_machine_invalid_arguments", "--private must be a repository URL.");
    }
  }
  return parsed;
}

function isDirectory(path) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function git(context, args, failCode = "setup_machine_git_failed") {
  return run(context.commands.git, args, { cwd: context.engineRoot, env: context.env, failCode });
}

function hooksPathOf(context) {
  const result = git(context, ["config", "--local", "--get", "core.hooksPath"]);
  return result.status === 0 ? result.stdout.trim() : null;
}

/** The values a template may name. Each is absolute and needs no escaping. */
export function renderValues(context) {
  const values = {
    backup_root: join(context.home, BACKUP_DIRECTORY),
    home: context.home,
    node: context.nodePath,
    operational_root: context.operationalRoot,
  };
  for (const [name, value] of Object.entries(values)) {
    if (!isAbsolute(value) || UNSAFE_VALUE.test(value)) {
      fail("setup_machine_path_unsafe", `${name} is not an absolute path safe to write into a template: ${JSON.stringify(value)}`);
    }
  }
  return values;
}

/** Fill one template; an unknown placeholder, or a JSON template that stops parsing, is refused. */
export function render(text, values, { format, template }) {
  const rendered = text.replace(PLACEHOLDER, (whole, name) => {
    if (!Object.hasOwn(values, name)) {
      fail("setup_machine_template_placeholder_unknown", `${template} names an unknown placeholder ${whole}.`);
    }
    return values[name];
  });
  if (format === "json") {
    try {
      JSON.parse(rendered);
    } catch {
      fail("setup_machine_template_invalid", `${template} is not JSON once rendered.`);
    }
  }
  return rendered;
}

/** Every template of the layer, rendered, with its target and whether the target already holds it. */
function plannedTargets(context) {
  const values = renderValues(context);
  const directory = join(context.candidateRoot, TEMPLATE_DIRECTORY);
  return TEMPLATES.map((entry) => {
    let text;
    try {
      text = readFileSync(join(directory, entry.template), "utf8");
    } catch {
      fail("setup_machine_template_missing", `the layer's ${TEMPLATE_DIRECTORY} directory has no ${entry.template}.`);
    }
    const content = render(text, values, entry);
    const target = entry.target(context);
    let present = false;
    if (existsSync(target)) {
      if (readFileSync(target, "utf8") !== content) {
        fail("setup_machine_target_differs", `${target} exists with other content; nothing was overwritten.`);
      }
      present = true;
    }
    return { content, present, target, template: entry.template };
  });
}

function agentRegistered(context) {
  const result = run(context.commands.launchctl, ["print", `gui/${context.uid}/${LAUNCH_AGENT_LABEL}`], {
    env: context.env,
    failCode: "setup_machine_launchctl_failed",
  });
  return result.status === 0;
}

function assertEngineClone(context) {
  if (!isDirectory(join(context.engineRoot, ".git"))) {
    fail("setup_machine_engine_not_a_clone", `${context.engineRoot} is not a primary clone of the engine.`);
  }
}

function assertOperationalFolder(context) {
  if (!isDirectory(context.operationalRoot)) {
    fail("setup_machine_operational_missing", `there is no operational folder at ${context.operationalRoot}.`);
  }
  if (existsSync(join(context.operationalRoot, ".git"))) {
    fail("setup_machine_operational_is_a_checkout", `${context.operationalRoot} is a git checkout, not an operational folder.`);
  }
}

function setUpPrivate(context, privateUrl, steps) {
  if (!existsSync(context.candidateRoot)) {
    if (privateUrl === null) {
      fail("setup_machine_private_url_missing", "the private repository is not cloned yet; name it with --private <url>.");
    }
    mustRun(context.commands.git, ["clone", "--quiet", "--", privateUrl, PRIVATE_DIRECTORY_NAME], {
      cwd: context.engineRoot,
      env: context.env,
      failCode: "setup_machine_git_failed",
    });
    steps.push({ step: "private-clone", outcome: "done" });
  } else {
    steps.push({ step: "private-clone", outcome: "skipped" });
  }
  if (!isDirectory(join(context.candidateRoot, ".git"))) {
    fail("setup_machine_private_not_a_clone", `${context.candidateRoot} is not a repository of its own.`);
  }
  if (privateUrl !== null) {
    const origin = run(context.commands.git, ["-C", context.candidateRoot, "remote", "get-url", "origin"], {
      env: context.env,
      failCode: "setup_machine_git_failed",
    });
    if (origin.status !== 0 || origin.stdout.trim() !== privateUrl) {
      fail("setup_machine_private_remote_mismatch", "the private repository's origin is not the URL --private names.");
    }
  }
  if (git(context, ["check-ignore", "--quiet", "--", PRIVATE_DIRECTORY_NAME]).status !== 0) {
    fail("setup_machine_private_not_ignored", "the engine does not ignore its private repository directory.");
  }
}

function dependenciesReady(context) {
  try {
    context.checkDependencies(join(context.engineRoot, "tools", "cv-builder"));
    return true;
  } catch {
    return false;
  }
}

function install(context, steps) {
  if (dependenciesReady(context)) {
    steps.push({ step: "dependencies", outcome: "skipped" });
    return;
  }
  for (const args of INSTALL_COMMANDS) {
    mustRun(context.commands.npm, args, {
      cwd: context.engineRoot,
      env: context.env,
      failCode: "setup_machine_install_failed",
    });
  }
  steps.push({ step: "dependencies", outcome: "done" });
}

function setHooksPath(context, steps) {
  const wanted = join(context.engineRoot, HOOKS_DIRECTORY);
  if (hooksPathOf(context) === wanted) {
    steps.push({ step: "hooks-path", outcome: "skipped" });
    return;
  }
  const result = git(context, ["config", "--local", "core.hooksPath", wanted]);
  if (result.status !== 0) fail("setup_machine_git_failed", `git config failed: ${lastLines(result.stderr)}`);
  steps.push({ step: "hooks-path", outcome: "done" });
}

function placeTemplates(context, steps) {
  const planned = plannedTargets(context);
  mkdirSync(join(context.home, BACKUP_DIRECTORY), { recursive: true });
  for (const entry of planned) {
    if (entry.present) {
      steps.push({ step: `template:${entry.template}`, outcome: "skipped" });
      continue;
    }
    mkdirSync(dirname(entry.target), { recursive: true });
    writeFileSync(entry.target, entry.content, { flag: "wx" });
    steps.push({ step: `template:${entry.template}`, outcome: "done" });
  }
  if (agentRegistered(context)) {
    steps.push({ step: "launch-agent", outcome: "skipped" });
    return;
  }
  const plist = TEMPLATES.find((entry) => entry.format === "xml").target(context);
  const result = run(context.commands.launchctl, ["bootstrap", `gui/${context.uid}`, plist], {
    env: context.env,
    failCode: "setup_machine_launchctl_failed",
  });
  if (result.status !== 0) {
    fail("setup_machine_launchctl_failed", `launchctl bootstrap failed: ${lastLines(result.stderr)}`);
  }
  steps.push({ step: "launch-agent", outcome: "done" });
}

/** The machine check. Returns what it established; any shortfall is a refusal. */
export function checkMachine(context, { operational }) {
  assertEngineClone(context);
  const toolchain = context.checkToolchain({ workspaceRoot: context.engineRoot });
  if (!isDirectory(join(context.candidateRoot, ".git"))) {
    fail("setup_machine_private_not_a_clone", `${context.candidateRoot} is not a repository of its own.`);
  }
  // The directory exists — it holds `.git` — so the loader either reads it or refuses with its own
  // code; "absent" cannot come back here.
  const layer = inspectCandidateLayer({ root: context.candidateRoot });
  if (hooksPathOf(context) !== join(context.engineRoot, HOOKS_DIRECTORY)) {
    fail("setup_machine_hooks_path_unset", "core.hooksPath does not name this clone's tools/git-hooks.");
  }
  const checked = { hooks_path: true, layer: layer.status, toolchain };
  if (!operational) return checked;

  assertOperationalFolder(context);
  const missing = plannedTargets(context).filter((entry) => !entry.present);
  if (missing.length > 0) {
    fail("setup_machine_target_missing", `${missing[0].target} is not in place.`);
  }
  if (!agentRegistered(context)) {
    fail("setup_machine_launch_agent_missing", `launchd does not know ${LAUNCH_AGENT_LABEL}.`);
  }
  const env = Object.fromEntries(Object.entries(context.env).filter(([key]) => !key.startsWith("JOB_PIPELINE_")));
  const preflight = run([context.nodePath], [join(context.operationalRoot, "tools", "bootstrap.mjs"), "--check"], {
    cwd: context.operationalRoot,
    env,
    failCode: "setup_machine_operational_preflight_failed",
  });
  let verdict = null;
  try {
    verdict = JSON.parse(preflight.stdout);
  } catch {
    verdict = null;
  }
  if (preflight.status !== 0 || verdict?.status !== "ready") {
    fail("setup_machine_operational_preflight_failed", `the operational folder's preflight is not green: ${lastLines(preflight.stderr)}`);
  }
  return { ...checked, launch_agent: true, operational_preflight: "ready", targets: TEMPLATES.length };
}

export function setUpMachine(context, { check, operational, privateUrl }) {
  assertEngineClone(context);
  if (operational) {
    assertOperationalFolder(context);
    renderValues(context);
  }
  const steps = [];
  if (!check) {
    setUpPrivate(context, privateUrl, steps);
    install(context, steps);
    setHooksPath(context, steps);
    if (operational) placeTemplates(context, steps);
  }
  const checked = checkMachine(context, { operational });
  return { steps, checked };
}

function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The context of a real run: everything derived from where this file lies and who runs it. */
export function defaultContext({ engineRoot = repoRoot, env = process.env } = {}) {
  const root = realOrSelf(engineRoot);
  return {
    candidateRoot: join(root, PRIVATE_DIRECTORY_NAME),
    checkDependencies: checkCvBuilderDependencies,
    checkToolchain: realCheckToolchain,
    commands: { git: ["git"], launchctl: ["launchctl"], npm: ["npm"] },
    engineRoot: root,
    env,
    home: realOrSelf(homedir()),
    nodePath: process.execPath,
    operationalRoot: join(dirname(root), OPERATIONAL_FOLDER_NAME),
    uid: userInfo().uid,
  };
}

export function main(argv = process.argv.slice(2), context = defaultContext(), io = process) {
  try {
    const options = parseArguments(argv);
    const { checked, steps } = setUpMachine(context, options);
    report({
      status: "ready",
      engine_root: context.engineRoot,
      private_root: context.candidateRoot,
      ...(options.operational ? { operational_root: context.operationalRoot } : {}),
      steps,
      checked,
    }, io.stdout);
    return 0;
  } catch (error) {
    reportError(error instanceof Error && typeof error.code === "string" && error.name !== "Error"
      ? error
      : new SetupError("setup_machine_failed", String(error?.message ?? error)), io.stderr);
    return 1;
  }
}

function isDirectInvocation() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  }
}

if (isDirectInvocation()) process.exitCode = main();
