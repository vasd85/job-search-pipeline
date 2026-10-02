#!/usr/bin/env node

/**
 * Creates the task worktree of one claimed backlog task, provisions the cv-builder dependencies
 * into it, and prints the preflight report of the pre-switch development procedure of
 * `docs/runbooks/development-gitflow.md`, which stays the authority on every rule this
 * file mechanizes.
 *
 * **Nothing that decides what gets created is typed on the command line.** The only argument is
 * the task id; the path, the branch and the lane are read from that task's `claim` block through
 * `git show main:docs/backlog/<file>`. That is the same property `tools/workspace-reset.mjs`
 * relies on — "which tree" is never a value anybody types — sourced here from the file the
 * runbook already makes authoritative (the pre-switch development procedure, invariant 4). A claim block and a created tree
 * can therefore not disagree: the claim is the input, and the checks are what remain.
 *
 * Guards, in a fixed order, so no subcommand can reorder them into a hole:
 *
 * - the invoking checkout's repository root is the working directory, and its branch is `main`.
 *   `ops/current` and every `task/*` tree fail this under any name;
 * - the task file resolves to exactly one `docs/backlog/<padded id>-*.md` on `main` and carries
 *   `status: in-progress` and a claim block;
 * - every `depends` entry is met by its own type (`docs/backlog/README.md`): a `blocker` id
 *   archived `done`, an `epic` still on the board with every `blocker` of its own met, a
 *   `related` entry nothing at all. This precedes the lane check on purpose — a task that may not
 *   be claimed at all is refused for that, not for the lane it would have worked in;
 * - the claimed lane owes a tree at all — lane `D` works in the `main` worktree and is refused
 *   here with that reason;
 * - the claimed branch has the `task/<padded id>-<slug>` shape for this id and does not exist;
 * - the claimed path is absolute, holds no entry of any kind, lies outside the git common
 *   directory, and neither contains nor sits inside any registered worktree. Every comparison is
 *   over resolved paths, so a symlinked spelling of the operational checkout cannot walk past a
 *   string compare;
 * - the task carries a `## Plan`. the pre-switch development procedure creates the tree after the start-confirmation gate,
 *   and the pre-switch development procedure step 1 makes the plan unconditional in lanes C and T, so a task with no plan
 *   is one whose tree the runbook says does not exist yet. The confirmation record itself is
 *   *reported and never required*: the pre-switch development procedure step 1a can be waived by a user decision this tool
 *   cannot read, and enforcing a conditional rule as an unconditional one would make the tool
 *   stricter than the runbook;
 * - the source dependency tree already satisfies `checkCvBuilderDependencies`, checked before
 *   anything is created, so the likely failure is a refusal rather than a half-made worktree.
 *
 * Dependencies are copied from the invoking checkout by default and installed only when asked.
 * The copy needs nothing but the tree it reads; the install needs a warm npm cache or the
 * network, which is why it is the fallback and not the default. Either way the result is checked
 * with `checkCvBuilderDependencies` against the *new* tree — the repository's own oracle, which
 * compares installed versions against that tree's lockfile and so also catches a stale source.
 *
 * Every child is spawned without a shell, with an argv array, and with the environment scrubbed
 * by the owner of that policy plus every `npm_*` key: this tool normally runs *through*
 * `npm run`, so those variables describe the outer invocation and not the inner install.
 *
 * What the report deliberately does not discharge is named in it. The self-report line the pre-switch development procedure
 * asks for — the derived lane and the loaded reading packages — is knowledge only the session
 * has, and a missing start-confirmation record is stated rather than acted on.
 */

import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { childEnvironment } from "./ci.mjs";
import { checkCvBuilderDependencies } from "./cv-builder/check-dependencies.mjs";

/** The branch a task worktree is created from, and the only branch this tool runs on. */
export const INTEGRATION_BRANCH = "main";

export const TASK_BRANCH_PREFIX = "task/";

/** Lanes that own a task worktree. Lane `D` works in the `main` worktree and owns none. */
export const WORKTREE_LANES = Object.freeze(["C", "T"]);

export const BACKLOG_DIRECTORY = "docs/backlog";

/** Where a closed task lives. A `blocker` id is met by a file here whose status is `done`. */
export const ARCHIVE_DIRECTORY = "docs/archive/backlog";

/**
 * The three link types of `docs/backlog/README.md`, which owns what each requires at claim. The
 * tool enforces them in lanes C and T only, because it is the lane C/T tree that it builds; the
 * claimer checks them in every lane (README lifecycle rule 2), and this is the second net.
 */
export const DEPENDENCY_TYPES = Object.freeze(["blocker", "epic", "related"]);

/** Zero-padded width of a backlog id, owned by `docs/backlog/README.md`. */
export const TASK_ID_WIDTH = 3;

const TASK_ID_PATTERN = /^[0-9]{1,3}$/;
const DEPENDENCY_ENTRY_PATTERN = /^\{[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.+?)[ \t]*\}$/;
const DEPENDENCY_ID_PATTERN = /^[0-9]{1,3}$/;
const DEPENDENCY_TEXT_PATTERN = /^"([^"\\]*)"$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BOOLEAN_FLAGS = Object.freeze(["install"]);
const MAX_TASK_FILE_BYTES = 512 * 1024;
const MAX_CHILD_OUTPUT = 2048;

/**
 * The install spelling, frozen. It is the one `.github/workflows/ci.yml` uses, and the flags are
 * not decoration: the root `.npmrc` sets `ignore-scripts=true`, but npm reads project config from
 * `${prefix}/.npmrc` and `tools/cv-builder/` has none, so a bare `--prefix` install would run
 * dependency lifecycle scripts this repository turned off on purpose.
 */
export function npmInstallArgs(prefix) {
  return ["ci", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund"];
}

/**
 * The eight read-only commands of the pre-switch development procedure, in its order, frozen as a literal. `pwd` is answered
 * by the tool itself — it is the directory it hands every other command — and the rest are git
 * children of the new tree. `required` marks the ones whose expectation is a stop; the others are
 * reported, and the rehearsal pair is reported *because* the pre-switch development procedure says residue blocks nothing.
 */
export const PREFLIGHT_CHECKS = Object.freeze([
  Object.freeze({ id: "pwd", args: null, required: false }),
  Object.freeze({ id: "repository-root", args: ["rev-parse", "--show-toplevel"], required: true }),
  Object.freeze({ id: "branch", args: ["branch", "--show-current"], required: true }),
  Object.freeze({ id: "head", args: ["rev-parse", "HEAD"], required: false }),
  Object.freeze({ id: "status", args: ["status", "--short"], required: false }),
  Object.freeze({
    id: "worktree-list",
    args: ["worktree", "list", "--porcelain"],
    required: false,
  }),
  Object.freeze({
    id: "rehearsal-branches",
    args: ["branch", "--list", "rehearsal/*"],
    required: false,
  }),
  Object.freeze({ id: "task-file", args: null, required: true }),
]);

/** What the tool cannot answer for the session, printed with every successful run. */
export const SESSION_OWES_SELF_REPORT =
  "the self-report line of runbook the pre-switch development procedure the derived lane and the loaded reading packages";
export const SESSION_OWES_START_CONFIRMATION =
  "no '### Start confirmation' record inside '## Plan': the pre-switch development procedure step 1a is either still open "
  + "or waived by a user decision this tool cannot read";

export class TaskWorktreeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TaskWorktreeError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new TaskWorktreeError(code, message);
}

function usage() {
  return `Usage:
  node tools/task-worktree.mjs --task <id> [--install]

Creates the task worktree of one claimed backlog task, provisions tools/cv-builder dependencies
into it and prints the preflight report of runbook the pre-switch development procedure

The id is the only value you type. Path, branch and lane come from that task's claim block on
main, so this command cannot be aimed at the operational checkout or at another task's tree.

Runs only from the repository root of a checkout on ${INTEGRATION_BRANCH}. Refuses a task that is
not in-progress, one whose depends carries an unmet or unreadable entry, a lane that owns no
worktree, a task with no ## Plan, an existing branch or path, and a source dependency tree that
does not already check out.

--install provisions with npm ci instead of copying the invoking checkout's dependencies. The copy
is the default because it needs neither the network nor a warm npm cache.

The governing procedures are the pre-switch development procedure
and the pre-switch task preflight.`;
}

function parseArgs(argv) {
  const options = Object.create(null);
  for (let index = 0; index < argv.length;) {
    const flag = argv[index];
    if (!flag?.startsWith("--")) {
      fail("task_worktree_invalid_arguments", `Invalid argument near ${flag ?? "<end>"}`);
    }
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) {
      fail("task_worktree_invalid_arguments", `Duplicate option: --${key}`);
    }
    if (BOOLEAN_FLAGS.includes(key)) {
      options[key] = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("task_worktree_invalid_arguments", `Missing value for --${key}`);
    }
    options[key] = value;
    index += 2;
  }
  const unknown = Object.keys(options).filter((key) => key !== "task" && key !== "install");
  if (unknown.length) {
    fail(
      "task_worktree_invalid_arguments",
      `Unknown option(s): ${unknown.map((key) => `--${key}`).join(", ")}`,
    );
  }
  if (!Object.hasOwn(options, "task")) {
    fail("task_worktree_invalid_arguments", "--task <id> is required.");
  }
  if (!TASK_ID_PATTERN.test(options.task)) {
    fail("task_worktree_invalid_arguments", `--task must be a backlog id: ${options.task}`);
  }
  return options;
}

function tail(text) {
  const value = String(text ?? "").trim();
  return value.length > MAX_CHILD_OUTPUT ? `...${value.slice(-MAX_CHILD_OUTPUT)}` : value;
}

/**
 * The child environment: the repository-wide scrub, then every `npm_*` key. The second half is
 * this tool's own, because it is normally reached through `npm run`, and an inherited
 * `npm_config_*` would reconfigure the install it starts.
 */
function taskChildEnvironment(environment) {
  const scrubbed = childEnvironment(environment);
  for (const key of Object.keys(scrubbed)) {
    if (key.startsWith("npm_")) delete scrubbed[key];
  }
  return scrubbed;
}

function runChild(context, command, args, { cwd, allowFailure = false }) {
  const result = context.spawn(command, args, {
    cwd,
    encoding: "utf8",
    env: context.childEnv,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (result.error) {
    fail(
      "task_worktree_child_unavailable",
      `${command} could not run (${result.error.code ?? "unknown"}).`,
    );
  }
  if (result.status !== 0) {
    if (allowFailure) {
      return { ok: false, status: result.status, stderr: tail(result.stderr), stdout: "" };
    }
    fail(
      "task_worktree_child_failed",
      `${command} ${args[0]} failed with status ${result.status}: ${tail(result.stderr)}`,
    );
  }
  return { ok: true, status: 0, stderr: tail(result.stderr), stdout: String(result.stdout ?? "") };
}

function git(context, args, options = {}) {
  return runChild(context, "git", args, { cwd: context.cwd, ...options });
}

function gitLine(context, args) {
  return git(context, args).stdout.trim();
}

function realPathOf(path, code, label) {
  try {
    return realpathSync(path);
  } catch (error) {
    return fail(code, `${label} could not be resolved (${error?.code ?? "unknown error"}).`);
  }
}

function contains(parent, child) {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

/** Any entry at all, a dangling symlink included: `existsSync` answers false for one of those. */
function entryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return fail("task_worktree_target_refused", `${path} is not inspectable (${error?.code}).`);
  }
}

/** The invoking checkout: its own root, its branch, and the paths no target may collide with. */
function resolveCheckout(context) {
  const cwdRealPath = realPathOf(
    context.cwd,
    "task_worktree_root_unreadable",
    "the working directory",
  );
  const toplevel = gitLine(context, ["rev-parse", "--show-toplevel"]);
  const rootRealPath = realPathOf(toplevel, "task_worktree_root_unreadable", "the repository root");
  if (cwdRealPath !== rootRealPath) {
    fail(
      "task_worktree_root_mismatch",
      `The working directory ${cwdRealPath} is not the repository root ${rootRealPath}.`,
    );
  }
  const branch = gitLine(context, ["branch", "--show-current"]);
  if (branch !== INTEGRATION_BRANCH) {
    fail(
      "task_worktree_branch_refused",
      `This checkout is on ${branch || "a detached HEAD"}, not ${INTEGRATION_BRANCH}. A task `
        + `worktree is created from the ${INTEGRATION_BRANCH} worktree (runbook the pre-switch development procedure); the `
        + "operational checkout and every task tree are refused here by that check.",
    );
  }
  const commonDir = realPathOf(
    resolve(toplevel, gitLine(context, ["rev-parse", "--git-common-dir"])),
    "task_worktree_root_unreadable",
    "the git common directory",
  );
  return { branch, commonDir, root: toplevel, rootRealPath, worktrees: worktreePaths(context) };
}

/** Every registered worktree path, resolved. An unresolvable one is kept as written. */
function worktreePaths(context) {
  const paths = [];
  for (const line of git(context, ["worktree", "list", "--porcelain"]).stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length);
    try {
      paths.push(realpathSync(path));
    } catch {
      paths.push(path);
    }
  }
  return paths;
}

/**
 * Frontmatter of a backlog task, plus the two document facts the pre-switch development procedure needs. Deliberately not a
 * YAML parser: it reads the keys this tool acts on and ignores the rest, so an unrelated key
 * cannot change what it returns.
 *
 * One exception to line-at-a-time reading: a top-level value that opens a flow sequence and does
 * not close it continues on the indented lines below, because `depends` wraps once it carries more
 * than a couple of entries. The continuation opens only on an unclosed `[`, so the `claim` block
 * under a closed value is still read as a block and not swallowed as text.
 */
export function parseTaskDocument(text) {
  if (!text.startsWith("---\n")) {
    fail("task_worktree_task_unreadable", "The task file does not open with a frontmatter block.");
  }
  const end = text.indexOf("\n---\n", 3);
  if (end === -1) {
    fail("task_worktree_task_unreadable", "The task file's frontmatter block is not closed.");
  }
  const frontmatter = Object.create(null);
  const claim = Object.create(null);
  let sawClaim = false;
  let inClaim = false;
  let pending = null;
  const closePending = () => {
    if (pending) frontmatter[pending.key] = pending.value;
    pending = null;
  };
  for (const line of text.slice(4, end + 1).split("\n")) {
    if (line.trim() === "") {
      closePending();
      continue;
    }
    if (line.startsWith("  ")) {
      if (pending) {
        pending.value += ` ${line.trim()}`;
        if (flowState(pending.value).depth === 0) closePending();
        continue;
      }
      if (!inClaim) continue;
      const nested = /^ {2}([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
      if (nested) claim[nested[1]] = nested[2].trim();
      continue;
    }
    closePending();
    inClaim = false;
    const entry = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!entry) continue;
    if (entry[1] === "claim") {
      sawClaim = true;
      inClaim = true;
      continue;
    }
    const value = entry[2].trim();
    if (value.startsWith("[") && flowState(value).depth !== 0) {
      pending = { key: entry[1], value };
      continue;
    }
    frontmatter[entry[1]] = value;
  }
  closePending();
  const body = text.slice(end + 1);
  const planAt = body.search(/^## Plan[ \t]*$/m);
  let startConfirmation = false;
  if (planAt !== -1) {
    const after = body.slice(planAt + 1);
    const nextSection = after.search(/^## /m);
    const planBody = nextSection === -1 ? after : after.slice(0, nextSection);
    startConfirmation = /^### Start confirmation[ \t]*$/m.test(planBody);
  }
  const plan = { present: planAt !== -1, startConfirmation };
  return { claim, frontmatter, hasClaim: sawClaim, plan };
}

/**
 * Bracket depth and quote state of a flow value, scanned rather than counted: `[`, `{` and `,`
 * inside a double-quoted condition are text, and the board's own conditions carry all three.
 */
function flowState(value) {
  let depth = 0;
  let quoted = false;
  for (const character of value) {
    if (quoted) {
      if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "[" || character === "{") depth += 1;
    else if (character === "]" || character === "}") depth -= 1;
  }
  return { depth, quoted };
}

function failDependency(value, reason) {
  return fail(
    "task_worktree_dependency_invalid",
    `depends: ${value} ${reason}. The field is a flow sequence of one-key mappings — `
      + '{blocker: 56}, {epic: 14}, {related: "a condition"} — with a backlog id or a '
      + `double-quoted condition as the target (${BACKLOG_DIRECTORY}/README.md, section `
      + "Frontmatter).",
  );
}

/** Top-level items of a flow sequence's body, split on commas that are neither quoted nor nested. */
function splitFlowItems(inner, value) {
  const items = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (const character of inner) {
    if (quoted) {
      current += character;
      if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    else if (character === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (quoted || depth !== 0) failDependency(value, "does not close every quote and mapping");
  items.push(current);
  return items;
}

/**
 * The `depends` grammar, frozen here because two readers act on it: this tool and the claimer it
 * backs up. Deliberately narrow — a flow sequence of one-key flow mappings, a target that is
 * either one to three digits or a double-quoted condition with no inner double quote and no
 * backslash. Everything else is refused rather than guessed at, because a guess would turn an
 * unmet dependency into a claim.
 */
export function parseDependencies(raw) {
  const value = String(raw ?? "").trim();
  if (value === "") {
    return failDependency("<none>", "is empty; a task with no links carries `depends: []`");
  }
  if (!value.startsWith("[") || !value.endsWith("]") || value.length < 2) {
    return failDependency(value, "is not a flow sequence `[...]`");
  }
  const inner = value.slice(1, -1).trim();
  if (inner === "") return [];
  const entries = [];
  for (const item of splitFlowItems(inner, value)) {
    const spelling = item.trim();
    const match = DEPENDENCY_ENTRY_PATTERN.exec(spelling);
    if (!match) {
      failDependency(value, `carries ${spelling || "an empty entry"}, which is not {type: target}`);
    }
    const [, type, target] = match;
    if (!DEPENDENCY_TYPES.includes(type)) {
      failDependency(value, `names type ${type}; expected one of ${DEPENDENCY_TYPES.join(", ")}`);
    }
    if (DEPENDENCY_ID_PATTERN.test(target)) {
      entries.push({ type, target: Number(target) });
      continue;
    }
    const text = DEPENDENCY_TEXT_PATTERN.exec(target);
    if (!text) {
      failDependency(value, `carries ${spelling}, whose target is neither a backlog id nor a `
        + "double-quoted condition");
    }
    if (type === "epic") {
      failDependency(value, `carries ${spelling}: an epic entry names its epic by id`);
    }
    entries.push({ type, target: text[1] });
  }
  return entries;
}

function dependencySpelling(entry) {
  const target = typeof entry.target === "number" ? entry.target : JSON.stringify(entry.target);
  return `{${entry.type}: ${target}}`;
}

/** Both task directories on `main`. An absent directory is an empty one, not a failure. */
function boardOf(context) {
  const names = (directory) => git(
    context,
    ["ls-tree", "--name-only", `${INTEGRATION_BRANCH}:${directory}`],
    { allowFailure: true },
  ).stdout.split("\n").map((name) => name.trim()).filter((name) => name.endsWith(".md"));
  return { archived: names(ARCHIVE_DIRECTORY), open: names(BACKLOG_DIRECTORY) };
}

function taskFilesById(names, paddedId) {
  return names.filter((name) => name.startsWith(`${paddedId}-`));
}

function readBoardDocument(context, directory, name, spelling, taskPath) {
  const raw = git(context, ["show", `${INTEGRATION_BRANCH}:${directory}/${name}`]).stdout;
  try {
    return parseTaskDocument(raw);
  } catch {
    return fail(
      "task_worktree_dependency_invalid",
      `${taskPath} carries ${spelling}, and ${directory}/${name} has no readable frontmatter.`,
    );
  }
}

/**
 * One entry against `main`. `related` requires nothing. A `blocker` id is met by an archived `done`
 * file; a `blocker` condition in text is never met here — only the commit that removes the entry
 * meets it, which is why a standing one refuses. An `epic` must still be on the board, be an epic,
 * and carry no unmet `blocker` of its own; that walk stops at one level, because an epic's own
 * `epic` entries are its lineage and not this task's.
 */
function resolveDependency(context, board, entry, taskPath) {
  const spelling = dependencySpelling(entry);
  if (entry.type === "related") return { ...entry, resolution: "informational" };
  if (typeof entry.target === "string") {
    fail(
      "task_worktree_dependency_unmet",
      `${taskPath} carries ${spelling}, a condition that stands until a commit in `
        + `${INTEGRATION_BRANCH} removes the entry and names the record that met it `
        + `(${BACKLOG_DIRECTORY}/README.md, section Frontmatter).`,
    );
  }
  const paddedId = String(entry.target).padStart(TASK_ID_WIDTH, "0");
  const open = taskFilesById(board.open, paddedId);
  const archived = taskFilesById(board.archived, paddedId);
  if (open.length + archived.length !== 1) {
    fail(
      "task_worktree_dependency_invalid",
      `${taskPath} carries ${spelling}, which names ${open.length + archived.length} task files `
        + `(${[...open, ...archived].join(", ") || "none"}) across ${BACKLOG_DIRECTORY} and `
        + `${ARCHIVE_DIRECTORY}.`,
    );
  }
  if (entry.type === "blocker") {
    if (open.length === 1) {
      fail(
        "task_worktree_dependency_unmet",
        `${taskPath} carries ${spelling}, and ${BACKLOG_DIRECTORY}/${open[0]} is not closed.`,
      );
    }
    const target = readBoardDocument(context, ARCHIVE_DIRECTORY, archived[0], spelling, taskPath);
    if (target.frontmatter.status !== "done") {
      fail(
        "task_worktree_dependency_unmet",
        `${taskPath} carries ${spelling}, and ${ARCHIVE_DIRECTORY}/${archived[0]} has status `
          + `${target.frontmatter.status ?? "<none>"}, not done.`,
      );
    }
    return { ...entry, resolution: "done" };
  }
  if (archived.length === 1) {
    fail(
      "task_worktree_dependency_invalid",
      `${taskPath} carries ${spelling}, but ${ARCHIVE_DIRECTORY}/${archived[0]} is closed: a child `
        + `of a closed epic has no epic to name (${BACKLOG_DIRECTORY}/README.md, rule 4).`,
    );
  }
  const epic = readBoardDocument(context, BACKLOG_DIRECTORY, open[0], spelling, taskPath);
  if (epic.frontmatter.type !== "epic") {
    fail(
      "task_worktree_dependency_invalid",
      `${taskPath} carries ${spelling}, and ${BACKLOG_DIRECTORY}/${open[0]} is type `
        + `${epic.frontmatter.type ?? "<none>"}, not epic.`,
    );
  }
  let inherited;
  try {
    inherited = parseDependencies(epic.frontmatter.depends);
  } catch (error) {
    return fail(
      "task_worktree_dependency_invalid",
      `${taskPath} carries ${spelling}, and ${BACKLOG_DIRECTORY}/${open[0]} carries a depends field `
        + `this tool cannot read — ${error?.message ?? "unknown error"}`,
    );
  }
  for (const parent of inherited) {
    if (parent.type !== "blocker") continue;
    // The claiming task stays in the message. Passing the epic's path alone would refuse a claim
    // by naming two files the operator never touched, with nothing saying how the walk got there.
    resolveDependency(
      context,
      board,
      parent,
      `${taskPath} carries ${spelling}, and its epic ${BACKLOG_DIRECTORY}/${open[0]}`,
    );
  }
  return { ...entry, resolution: "open-epic" };
}

function assertDependencies(context, board, document, taskPath) {
  if (!Object.hasOwn(document.frontmatter, "depends")) {
    fail(
      "task_worktree_dependency_invalid",
      `${taskPath} carries no depends field. Every task lists its links, and a task with none `
        + `carries \`depends: []\` (${BACKLOG_DIRECTORY}/README.md, section Frontmatter).`,
    );
  }
  let entries;
  try {
    entries = parseDependencies(document.frontmatter.depends);
  } catch (error) {
    return fail("task_worktree_dependency_invalid", `${taskPath} — ${error?.message ?? "unknown"}`);
  }
  return entries.map((entry) => resolveDependency(context, board, entry, taskPath));
}

function taskFilePath(board, paddedId) {
  const matches = taskFilesById(board.open, paddedId);
  if (matches.length === 0) {
    fail(
      "task_worktree_task_not_found",
      `No open task ${paddedId} in ${BACKLOG_DIRECTORY} on ${INTEGRATION_BRANCH}. A closed task `
        + "lives in docs/archive/backlog/ and owns no new worktree.",
    );
  }
  if (matches.length > 1) {
    fail(
      "task_worktree_task_not_found",
      `Task id ${paddedId} matches ${matches.length} files: ${matches.join(", ")}.`,
    );
  }
  return `${BACKLOG_DIRECTORY}/${matches[0]}`;
}

function readTask(context, board, paddedId) {
  const path = taskFilePath(board, paddedId);
  const raw = git(context, ["show", `${INTEGRATION_BRANCH}:${path}`]).stdout;
  if (Buffer.byteLength(raw, "utf8") > MAX_TASK_FILE_BYTES) {
    fail("task_worktree_task_unreadable", `${path} exceeds ${MAX_TASK_FILE_BYTES} bytes.`);
  }
  const document = parseTaskDocument(raw);
  if (document.frontmatter.id !== String(Number(paddedId))) {
    fail(
      "task_worktree_task_unreadable",
      `${path} declares id ${document.frontmatter.id ?? "<none>"}, not ${Number(paddedId)}.`,
    );
  }
  if (document.frontmatter.status !== "in-progress") {
    fail(
      "task_worktree_task_not_claimed",
      `${path} has status ${document.frontmatter.status ?? "<none>"}. Claim the task in the `
        + `${INTEGRATION_BRANCH} worktree first (runbook the pre-switch development procedure).`,
    );
  }
  if (!document.hasClaim) {
    fail("task_worktree_task_not_claimed", `${path} carries no claim block.`);
  }
  return { document, path };
}

function assertLane(lane, path) {
  if (lane === "D") {
    fail(
      "task_worktree_lane_without_tree",
      `${path} is lane D, which creates no worktree and works in the ${INTEGRATION_BRANCH} `
        + "worktree (runbook the pre-switch development procedure, step 2).",
    );
  }
  if (!WORKTREE_LANES.includes(lane)) {
    fail(
      "task_worktree_lane_invalid",
      `${path} declares lane ${lane ?? "<none>"}. Expected one of ${WORKTREE_LANES.join(", ")} in `
        + "Latin letters (docs/backlog/README.md).",
    );
  }
}

function assertClaimedBranch(branch, paddedId, path) {
  if (typeof branch !== "string" || !branch.startsWith(TASK_BRANCH_PREFIX)) {
    fail("task_worktree_claim_invalid", `${path} claims branch ${branch ?? "<none>"}, which is not `
      + `${TASK_BRANCH_PREFIX}<id>-<slug>.`);
  }
  const rest = branch.slice(TASK_BRANCH_PREFIX.length);
  if (!rest.startsWith(`${paddedId}-`)) {
    fail(
      "task_worktree_claim_invalid",
      `${path} claims branch ${branch}, which does not name task ${paddedId}.`,
    );
  }
  if (!SLUG_PATTERN.test(rest.slice(paddedId.length + 1))) {
    fail(
      "task_worktree_claim_invalid",
      `${path} claims branch ${branch}, whose slug is not lower-case letters, digits and hyphens.`,
    );
  }
  return branch;
}

function assertBranchIsFree(context, branch) {
  const probe = git(context, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    allowFailure: true,
  });
  if (probe.ok) {
    fail(
      "task_worktree_branch_exists",
      `Branch ${branch} already exists. A resuming session continues in its own tree and does not `
        + "claim a second one (runbook the pre-switch development procedure).",
    );
  }
}

/**
 * The claimed path, resolved through its nearest existing ancestor because the target itself must
 * not exist yet. Resolving matters twice: a symlinked spelling of the operational checkout would
 * walk past a string compare, and a macOS temporary root is reached through one.
 */
function assertTargetIsFree(checkout, claimed, path) {
  if (typeof claimed !== "string" || claimed === "" || !isAbsolute(claimed)) {
    fail(
      "task_worktree_claim_invalid",
      `${path} claims worktree ${claimed || "<none>"}, which is not an absolute path. The claim `
        + "block records exact absolute paths (runbook the pre-switch development procedure).",
    );
  }
  if (resolve(claimed) !== claimed) {
    fail(
      "task_worktree_claim_invalid",
      `${path} claims a non-normalized worktree path ${claimed}.`,
    );
  }
  if (entryExists(claimed)) {
    fail("task_worktree_target_exists", `${claimed} already exists; nothing was created.`);
  }
  const missing = [];
  let ancestor = dirname(claimed);
  while (!entryExists(ancestor)) {
    missing.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      fail("task_worktree_target_refused", `No existing ancestor of ${claimed} could be resolved.`);
    }
    ancestor = parent;
  }
  const resolvedAncestor = realPathOf(ancestor, "task_worktree_target_refused", ancestor);
  const target = join(resolvedAncestor, ...missing, basename(claimed));
  if (contains(checkout.commonDir, target) || contains(target, checkout.commonDir)) {
    fail(
      "task_worktree_target_refused",
      `${claimed} resolves inside the git common directory ${checkout.commonDir}.`,
    );
  }
  for (const worktree of checkout.worktrees) {
    if (contains(worktree, target) || contains(target, worktree)) {
      fail(
        "task_worktree_target_refused",
        `${claimed} resolves to ${target}, which collides with the registered worktree `
          + `${worktree}. The operational checkout is refused here by this check.`,
      );
    }
  }
  return target;
}

function builderRoot(root) {
  return join(root, "tools", "cv-builder");
}

function verifyDependencies(root, code, note) {
  try {
    return checkCvBuilderDependencies(builderRoot(root));
  } catch (error) {
    return fail(code, `${note} (${error?.code ?? "unknown"}: ${error?.message ?? "no message"})`);
  }
}

/**
 * `verbatimSymlinks` is the point: `tools/cv-builder/node_modules/.bin` holds relative links, and
 * dereferencing them would replace two links with two copies of their targets.
 */
function copyDependencies(sourceRoot, targetRoot) {
  const source = join(builderRoot(sourceRoot), "node_modules");
  const target = join(builderRoot(targetRoot), "node_modules");
  try {
    cpSync(source, target, {
      errorOnExist: true,
      force: false,
      recursive: true,
      verbatimSymlinks: true,
    });
  } catch (error) {
    fail(
      "task_worktree_provisioning_failed",
      "The worktree was created but its dependencies were not copied "
        + `(${error?.code ?? "unknown"}). `
        + `Fix the copy, or remove the tree with "git worktree remove ${targetRoot}".`,
    );
  }
  return { method: "copy", source };
}

function installDependencies(context, targetRoot) {
  const prefix = builderRoot(targetRoot);
  const result = runChild(context, "npm", npmInstallArgs(prefix), {
    allowFailure: true,
    cwd: targetRoot,
  });
  if (!result.ok) {
    fail(
      "task_worktree_provisioning_failed",
      `The worktree was created but "npm ci" failed with status ${result.status}: `
        + `${result.stderr}. Fix the install, or remove the tree with `
        + `"git worktree remove ${targetRoot}".`,
    );
  }
  return { method: "npm-ci", source: null };
}

/** The eight commands of the pre-switch development procedure, run in the new tree, each with its output and its outcome. */
function preflight(context, { claimedBranch, document, taskPath, target }) {
  const checks = [];
  const outputs = Object.create(null);
  for (const check of PREFLIGHT_CHECKS) {
    let command;
    let output;
    if (check.id === "pwd") {
      command = "pwd";
      output = target;
    } else if (check.id === "task-file") {
      command = `git show ${INTEGRATION_BRANCH}:${taskPath}`;
      output = `status: ${document.frontmatter.status}; lane: ${document.claim.lane}; `
        + `branch: ${document.claim.branch}; worktree: ${document.claim.worktree}`;
    } else {
      command = `git ${check.args.join(" ")}`;
      output = runChild(context, "git", check.args, { cwd: target }).stdout.trimEnd();
    }
    outputs[check.id] = output;
    checks.push({ id: check.id, command, output });
  }

  const expectations = [
    ["pwd", true, "the directory the checks below ran in — the claimed worktree by "
      + "construction, so the tested half of this expectation is the repository root below"],
    ["repository-root", realpathSync(outputs["repository-root"]) === target,
      `equals the claimed worktree ${target}`],
    ["branch", outputs.branch === claimedBranch, `equals the claimed branch ${claimedBranch}`],
    ["head", true, "reported"],
    ["status", outputs.status === "", "the tree is clean"],
    ["worktree-list", true, "reported"],
    ["rehearsal-branches", true, "residue is listed and blocks nothing (runbook the pre-switch development procedure)"],
    ["task-file", document.frontmatter.status === "in-progress"
      && document.claim.branch === claimedBranch && document.claim.worktree !== undefined,
    "status is in-progress and the claim block matches the facts"],
  ];
  for (const [id, satisfied, expectation] of expectations) {
    const check = checks.find((entry) => entry.id === id);
    check.expected = expectation;
    check.outcome = satisfied ? "pass" : "attention";
  }
  for (const check of checks) {
    const definition = PREFLIGHT_CHECKS.find((entry) => entry.id === check.id);
    if (definition.required && check.outcome !== "pass") {
      fail(
        "task_worktree_preflight_failed",
        `The tree was created but its preflight check "${check.id}" did not hold: expected `
          + `${check.expected}, observed ${check.output}.`,
      );
    }
  }

  const residueBranches = outputs["rehearsal-branches"]
    .split("\n")
    .map((line) => line.replace(/^[*+ ]+/, "").trim())
    .filter((line) => line.length > 0);
  const residueWorktrees = outputs["worktree-list"]
    .split("\n")
    .filter((line) => line.startsWith("branch refs/heads/rehearsal/"))
    .map((line) => line.slice("branch refs/heads/".length));
  const owed = [SESSION_OWES_SELF_REPORT];
  if (!document.plan.startConfirmation) owed.push(SESSION_OWES_START_CONFIRMATION);

  return {
    status: checks.every((check) => check.outcome === "pass") ? "ready" : "attention",
    checks,
    rehearsal_residue: { blocking: false, branches: residueBranches, worktrees: residueWorktrees },
    session_owes: owed,
  };
}

export function runTaskWorktree(argv, {
  cwd = process.cwd(),
  environment = process.env,
  spawn = spawnSync,
} = {}) {
  const options = parseArgs(argv);
  const context = { childEnv: taskChildEnvironment(environment), cwd, environment, spawn };
  const paddedId = String(Number(options.task)).padStart(TASK_ID_WIDTH, "0");

  const checkout = resolveCheckout(context);
  const board = boardOf(context);
  const { document, path: taskPath } = readTask(context, board, paddedId);
  const depends = assertDependencies(context, board, document, taskPath);
  assertLane(document.claim.lane, taskPath);
  const claimedBranch = assertClaimedBranch(document.claim.branch, paddedId, taskPath);
  assertBranchIsFree(context, claimedBranch);
  const target = assertTargetIsFree(checkout, document.claim.worktree, taskPath);
  if (!document.plan.present) {
    fail(
      "task_worktree_plan_missing",
      `${taskPath} carries no "## Plan". Runbook the pre-switch development procedure creates the tree after the plan and `
        + "its start-confirmation gate, so there is nothing for this tree to hold yet.",
    );
  }
  if (!options.install) {
    verifyDependencies(
      checkout.root,
      "task_worktree_dependencies_unavailable",
      `The dependencies of ${builderRoot(checkout.root)} do not check out, so there is nothing `
        + 'sound to copy. Install them first, or provision the new tree with "--install"',
    );
  }

  const base = gitLine(context, ["rev-parse", INTEGRATION_BRANCH]);
  git(context, [
    "worktree", "add", document.claim.worktree, "-b", claimedBranch, INTEGRATION_BRANCH,
  ]);
  const dependencies = options.install
    ? installDependencies(context, target)
    : copyDependencies(checkout.root, target);
  const checked = verifyDependencies(
    target,
    "task_worktree_provisioning_failed",
    `The worktree was created but its dependencies do not check out. Fix them, or remove the tree `
      + `with "git worktree remove ${target}"`,
  );

  const report = preflight(context, { claimedBranch, document, taskPath, target });
  return {
    command: "task-worktree",
    status: report.status,
    task: {
      id: Number(options.task),
      file: taskPath,
      status: document.frontmatter.status,
      depends,
      lane: document.claim.lane,
      runner: document.claim.runner ?? null,
      start_confirmation: document.plan.startConfirmation ? "recorded" : "absent",
    },
    created: {
      worktree: target,
      branch: claimedBranch,
      base: { head: base, ref: INTEGRATION_BRANCH },
    },
    dependencies: { ...dependencies, direct: checked.direct, packages: checked.packages },
    preflight: report,
  };
}

export function main(argv = process.argv.slice(2)) {
  try {
    if (argv[0] === "help" || argv[0] === "--help") {
      console.log(usage());
      return;
    }
    console.log(JSON.stringify(runTaskWorktree(argv), null, 2));
  } catch (error) {
    const code = error instanceof TaskWorktreeError ? error.code : "task_worktree_failed";
    console.error(JSON.stringify({
      error: { code, message: error?.message ?? "unknown error" },
    }));
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
