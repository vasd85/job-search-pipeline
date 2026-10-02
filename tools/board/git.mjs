// Git for the board tools and the push guard: argv arrays, no shell, and an environment that
// cannot redirect a command at a repository other than the one it names.
//
// Every command below names its repository with `-C <path>`. A `GIT_DIR` or `GIT_WORK_TREE`
// inherited from the caller would override that silently — and a caller that is itself a git
// hook has both set — so the location variables are dropped. Configuration is not: a real push
// needs the operator's credential helper, and the suite isolates itself through
// `GIT_CONFIG_GLOBAL`, which a wholesale scrub would also remove.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const LOCATION_VARIABLES = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
]);

const MAX_BUFFER = 256 * 1024 * 1024;

/** The directory name of the private repository inside an engine clone. */
export const PRIVATE_DIRECTORY_NAME = "candidate";

export class BoardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BoardError";
    this.code = code;
  }
}

export function gitEnvironment(environment = process.env) {
  const child = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || LOCATION_VARIABLES.includes(key)) continue;
    child[key] = value;
  }
  return child;
}

/**
 * Run one git command in `cwd`. Returns `{ status, stdout, stderr }`; `stdout` is a Buffer when
 * `binary` is set. A command that could not start at all is a refusal under `failCode`.
 */
export function runGit(cwd, args, { binary = false, failCode, input, spawn = spawnSync } = {}) {
  const result = spawn("git", ["-C", cwd, ...args], {
    encoding: binary ? "buffer" : "utf8",
    env: gitEnvironment(),
    input,
    maxBuffer: MAX_BUFFER,
    shell: false,
  });
  if (result.error) {
    throw new BoardError(failCode ?? "board_git_failed", `git ${args[0]}: ${result.error.message}`);
  }
  return {
    status: result.status,
    stderr: String(result.stderr ?? ""),
    stdout: binary ? result.stdout : String(result.stdout ?? ""),
  };
}

/** Like `runGit`, but a non-zero exit is a refusal carrying git's last lines. */
export function mustGit(cwd, args, { failCode = "board_git_failed", ...options } = {}) {
  const result = runGit(cwd, args, { failCode, ...options });
  if (result.status !== 0) {
    throw new BoardError(failCode, `git ${args[0]} failed: ${lastLines(result.stderr)}`);
  }
  return result.stdout;
}

export function lastLines(text, count = 4) {
  return String(text).trim().split("\n").slice(-count).join(" | ");
}

export function samePath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/**
 * Where the private repository of a checkout lives: beside the checkout's common git directory.
 *
 * For the engine clone that is its own `candidate/`; for a linked working copy of a task it is
 * the same directory of the clone it was made from, so a command run there reaches the one board
 * every session on the machine shares.
 */
export function privateRootFor(checkout) {
  const common = runGit(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.status !== 0) {
    throw new BoardError("board_not_in_a_checkout", `${checkout} is not inside a git checkout.`);
  }
  return join(dirname(common.stdout.trim()), PRIVATE_DIRECTORY_NAME);
}
