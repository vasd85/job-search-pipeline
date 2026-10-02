#!/usr/bin/env node

/**
 * Bring the public engine repository on GitHub to the settings declared in `config/github/`.
 *
 *   npm run setup:github -- --repo <owner>/<name> [--check]
 *
 * Each file there is exactly the body of one API call, so it can also be applied by hand:
 * `repository.json` for `PATCH repos/{repo}`, `fork-pr-approval.json` for the fork pull-request
 * approval policy, and one `ruleset-*.json` per ruleset, matched on GitHub by its `name`.
 *
 * The run reads the current state first and writes only what differs: a field of the repository,
 * the approval policy, a ruleset that is missing (created) or not covered by the declared one
 * (replaced as a whole). A second run therefore reads and writes nothing. `--check` only reads,
 * prints what differs and exits 1 when anything does.
 *
 * A private repository is refused before any write. Rulesets do not bind a private repository
 * on the free plan, and the private repository is the one place this script must never be
 * pointed at by mistake.
 *
 * Every call goes through `gh api` as an argument list; a body goes in on stdin (ADR 0011).
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SetupError, fail, lastLines, report, reportError, run } from "./run.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const CONFIG_DIRECTORY = join("config", "github");
export const REPOSITORY_FILE = "repository.json";
export const FORK_APPROVAL_FILE = "fork-pr-approval.json";
export const RULESET_FILES = Object.freeze(["ruleset-main.json", "ruleset-release-tags.json"]);

export const USAGE = "use --repo <owner>/<name> [--check]";

const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;

export function parseArguments(argv) {
  const parsed = { check: false, repo: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--check" && !parsed.check) {
      parsed.check = true;
    } else if (flag === "--repo" && parsed.repo === null && index + 1 < argv.length) {
      parsed.repo = argv[index + 1];
      index += 1;
    } else {
      fail("github_settings_invalid_arguments", USAGE);
    }
  }
  if (parsed.repo === null) fail("github_settings_invalid_arguments", USAGE);
  const name = parsed.repo.split("/")[1];
  if (!REPOSITORY_PATTERN.test(parsed.repo) || name === "." || name === "..") {
    fail("github_settings_invalid_arguments", "--repo must be <owner>/<name>.");
  }
  return parsed;
}

function readConfig(root, file) {
  const path = join(root, CONFIG_DIRECTORY, file);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    fail("github_settings_config_invalid", `${CONFIG_DIRECTORY}/${file} is not readable.`);
  }
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("not an object");
    return value;
  } catch {
    fail("github_settings_config_invalid", `${CONFIG_DIRECTORY}/${file} is not a JSON object.`);
  }
}

/** The declared state: the four bodies, read from a repository root. */
export function loadDesired(root = repoRoot) {
  const rulesets = RULESET_FILES.map((file) => readConfig(root, file));
  const names = rulesets.map((ruleset) => ruleset.name);
  if (
    names.some((name) => typeof name !== "string" || name.length === 0) ||
    new Set(names).size !== names.length
  ) {
    fail("github_settings_config_invalid", "every ruleset needs its own non-empty name.");
  }
  return {
    forkApproval: readConfig(root, FORK_APPROVAL_FILE),
    repository: readConfig(root, REPOSITORY_FILE),
    rulesets,
  };
}

/**
 * Whether the current value already says everything the declared one says. An object may carry
 * more keys than declared — the server adds ids, links and defaulted parameters. An array must
 * have the same length, and each declared element must be covered by its own current element, in
 * any order: a rule added by hand in the web interface is a difference, a reordering is not.
 */
export function covers(current, desired) {
  if (Array.isArray(desired)) {
    if (!Array.isArray(current) || current.length !== desired.length) return false;
    const unused = [...current];
    return desired.every((want) => {
      const index = unused.findIndex((have) => covers(have, want));
      if (index === -1) return false;
      unused.splice(index, 1);
      return true;
    });
  }
  if (desired !== null && typeof desired === "object") {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return false;
    return Object.keys(desired).every((key) => covers(current[key], desired[key]));
  }
  return current === desired;
}

function makeApi(gh, env) {
  return function api(method, path, body) {
    const args = ["api", "--method", method, path];
    if (body !== undefined) args.push("--input", "-");
    const result = run(gh, args, {
      env,
      failCode: "github_settings_gh_failed",
      input: body === undefined ? undefined : JSON.stringify(body),
    });
    if (result.status !== 0) {
      fail(
        "github_settings_gh_failed",
        `gh api ${method} ${path} failed: ${lastLines(result.stderr)}`,
      );
    }
    try {
      return result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
    } catch {
      fail("github_settings_gh_failed", `gh api ${method} ${path} did not return JSON.`);
    }
  };
}

/**
 * Compare and, unless `check`, apply. Returns the list of differences it found; each names its
 * target and what was done about it.
 */
export function applySettings({ api, check, desired, repo }) {
  const changes = [];
  const base = `repos/${repo}`;

  const current = api("GET", base);
  if (current?.private !== false || current?.visibility !== "public") {
    fail(
      "github_settings_repository_not_public",
      `${repo} is not a public repository; nothing was changed.`,
    );
  }

  const fields = Object.keys(desired.repository).filter(
    (key) => !covers(current[key], desired.repository[key]),
  );
  if (fields.length > 0) {
    const body = Object.fromEntries(fields.map((key) => [key, desired.repository[key]]));
    if (!check) api("PATCH", base, body);
    changes.push({ target: "repository", fields, action: check ? "differs" : "updated" });
  }

  const approvalPath = `${base}/actions/permissions/fork-pr-contributor-approval`;
  const approval = api("GET", approvalPath);
  if (!covers(approval, desired.forkApproval)) {
    if (!check) api("PUT", approvalPath, desired.forkApproval);
    changes.push({ target: "fork-pr-approval", action: check ? "differs" : "updated" });
  }

  const listed = api("GET", `${base}/rulesets?includes_parents=false&per_page=100`);
  if (!Array.isArray(listed))
    fail("github_settings_gh_failed", "the ruleset list is not an array.");
  for (const ruleset of desired.rulesets) {
    const matches = listed.filter((entry) => entry?.name === ruleset.name);
    if (matches.length > 1) {
      fail(
        "github_settings_ruleset_ambiguous",
        `${repo} has ${matches.length} rulesets named ${ruleset.name}.`,
      );
    }
    if (matches.length === 0) {
      if (!check) api("POST", `${base}/rulesets`, ruleset);
      changes.push({ target: `ruleset:${ruleset.name}`, action: check ? "missing" : "created" });
      continue;
    }
    const id = matches[0].id;
    if (!Number.isInteger(id))
      fail("github_settings_gh_failed", `ruleset ${ruleset.name} has no numeric id.`);
    const detail = api("GET", `${base}/rulesets/${id}`);
    if (!covers(detail, ruleset)) {
      if (!check) api("PUT", `${base}/rulesets/${id}`, ruleset);
      changes.push({ target: `ruleset:${ruleset.name}`, action: check ? "differs" : "replaced" });
    }
  }
  return changes;
}

export function main(
  argv = process.argv.slice(2),
  { env = process.env, gh = ["gh"], io = process, root = repoRoot } = {},
) {
  try {
    const { check, repo } = parseArguments(argv);
    const desired = loadDesired(root);
    const changes = applySettings({ api: makeApi(gh, env), check, desired, repo });
    const status = changes.length === 0 ? "unchanged" : check ? "differs" : "applied";
    report({ status, repository: repo, changes }, io.stdout);
    return check && changes.length > 0 ? 1 : 0;
  } catch (error) {
    reportError(
      error instanceof SetupError
        ? error
        : new SetupError("github_settings_failed", String(error?.message ?? error)),
      io.stderr,
    );
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
