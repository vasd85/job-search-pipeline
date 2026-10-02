// External programs for the setup scripts: argv arrays, no shell (ADR 0011), and one error type.
//
// A command is an array — the program and any fixed leading arguments — so a test can hand in
// `[process.execPath, "<stub>.mjs"]` and exercise the very spawn path the real program takes,
// without the program ever being looked up on `PATH`.

import { spawnSync } from "node:child_process";
import { gitEnvironment } from "../board/git.mjs";

const MAX_BUFFER = 64 * 1024 * 1024;

export class SetupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SetupError";
    this.code = code;
  }
}

export function fail(code, message) {
  throw new SetupError(code, message);
}

/** The last lines of a program's output, flattened for a one-line refusal message. */
export function lastLines(text, count = 3) {
  return String(text ?? "").trim().split("\n").slice(-count).join(" | ").slice(0, 400);
}

/**
 * Run `command` (an argv prefix) with `args`. Returns `{ status, stdout, stderr }`. A program that
 * could not start at all is a refusal under `failCode`; a non-zero exit is returned, not thrown.
 */
export function run(command, args, { cwd, env = process.env, failCode, input } = {}) {
  const [program, ...prefix] = command;
  const result = spawnSync(program, [...prefix, ...args], {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(env),
    input,
    maxBuffer: MAX_BUFFER,
    shell: false,
  });
  if (result.error) fail(failCode, `${program} could not start: ${result.error.message}`);
  return { status: result.status, stderr: String(result.stderr ?? ""), stdout: String(result.stdout ?? "") };
}

/** Like `run`, but a non-zero exit is a refusal carrying the program's last lines. */
export function mustRun(command, args, options) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    fail(options.failCode, `${command[0]} ${args[0] ?? ""} failed: ${lastLines(result.stderr)}`);
  }
  return result.stdout;
}

/** Print a result or a refusal the way the repository's other tools do: one JSON line. */
export function report(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value)}\n`);
}

export function reportError(error, stream = process.stderr) {
  const known = typeof error?.code === "string" && error.code.length > 0 && error.name !== "Error";
  report({
    status: "error",
    error: {
      code: known ? error.code : "setup_failed",
      message: known ? error.message : `setup failed unexpectedly: ${error?.message ?? error}`,
    },
  }, stream);
}
