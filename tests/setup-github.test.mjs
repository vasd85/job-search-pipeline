// The GitHub settings script against a stand-in `gh`: a node program that keeps one repository's
// state in a JSON file and writes every call it receives — argv and stdin — to a log. The script
// is handed the stand-in by absolute path, so the real `gh`, which is logged into a real account,
// is never looked up, and every case also asserts that the stand-in was the one called.
//
// What a case observes is the exact list of calls and the state they leave behind.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { covers, main } from "../tools/setup/github.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(join(repoRoot, "tools", "setup", "github.mjs"), "utf8");
const readConfig = (file) => JSON.parse(readFileSync(join(repoRoot, "config", "github", file), "utf8"));

const REPO = "probe-owner/engine-probe";

// Frozen here rather than read from the module; tools/setup/README.md names the same set.
const PINNED_CODES = [
  "github_settings_config_invalid",
  "github_settings_failed",
  "github_settings_gh_failed",
  "github_settings_invalid_arguments",
  "github_settings_repository_not_public",
  "github_settings_ruleset_ambiguous",
];

const FAKE_GH = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const [, , ...argv] = process.argv;
const stateFile = process.env.FAKE_GH_STATE;
const input = argv.includes("--input") ? readFileSync(0, "utf8") : null;
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ argv, input: input === null ? null : JSON.parse(input) }) + "\n");
const state = JSON.parse(readFileSync(stateFile, "utf8"));
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const out = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
const notFound = () => { process.stderr.write("gh: Not Found (HTTP 404)\n"); process.exit(1); };
if (argv[0] !== "api" || argv[1] !== "--method") notFound();
const method = argv[2];
const path = argv[3];
if (process.env.FAKE_GH_FAIL === method + " " + path) { process.stderr.write("gh: Server Error (HTTP 500)\n"); process.exit(1); }
const base = "repos/" + state.repository.full_name;
const body = input === null ? null : JSON.parse(input);
if (path === base) {
  if (method === "GET") out(state.repository);
  if (method === "PATCH") { Object.assign(state.repository, body); save(); out(state.repository); }
}
if (path === base + "/actions/permissions/fork-pr-contributor-approval") {
  if (method === "GET") out(state.forkApproval);
  if (method === "PUT") { state.forkApproval = body; save(); process.exit(0); }
}
if (path === base + "/rulesets?includes_parents=false&per_page=100" && method === "GET") {
  out(state.rulesets.map(({ id, name, target, enforcement, source, source_type }) => ({ id, name, target, enforcement, source, source_type })));
}
const serverSide = (id, ruleset) => ({
  ...ruleset,
  id,
  node_id: "RRS_" + id,
  source: state.repository.full_name,
  source_type: "Repository",
  current_user_can_bypass: "never",
  _links: { self: { href: "https://api.github.com/" + base + "/rulesets/" + id } },
  rules: ruleset.rules.map((rule) => rule.type === "pull_request"
    ? { ...rule, parameters: { ...rule.parameters, required_reviewers: [] } }
    : rule),
});
if (path === base + "/rulesets" && method === "POST") {
  const id = state.nextId++;
  state.rulesets.push(serverSide(id, body));
  save();
  out(state.rulesets.at(-1));
}
const match = path.match(/\/rulesets\/(\d+)$/);
if (match && path.startsWith(base + "/rulesets/")) {
  const index = state.rulesets.findIndex((entry) => entry.id === Number(match[1]));
  if (index === -1) notFound();
  if (method === "GET") out(state.rulesets[index]);
  if (method === "PUT") { state.rulesets[index] = serverSide(Number(match[1]), body); save(); out(state.rulesets[index]); }
}
notFound();
`;

/** A fresh public repository, with the defaults task 171 measured on one (its report, 2.4). */
function freshState() {
  return {
    forkApproval: { approval_policy: "first_time_contributors" },
    nextId: 101,
    repository: {
      allow_auto_merge: false,
      allow_merge_commit: true,
      allow_rebase_merge: true,
      allow_squash_merge: true,
      delete_branch_on_merge: false,
      full_name: REPO,
      has_discussions: false,
      has_issues: true,
      has_projects: true,
      has_wiki: true,
      id: 1,
      merge_commit_message: "PR_TITLE",
      merge_commit_title: "MERGE_MESSAGE",
      private: false,
      squash_merge_commit_message: "COMMIT_MESSAGES",
      squash_merge_commit_title: "COMMIT_OR_PR_TITLE",
      visibility: "public",
    },
    rulesets: [],
  };
}

function harness(t, state = freshState()) {
  const root = mkdtempSync(join(tmpdir(), "setup-github-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const gh = join(root, "gh.mjs");
  writeFileSync(gh, FAKE_GH);
  chmodSync(gh, 0o755);
  const stateFile = join(root, "state.json");
  const log = join(root, "calls.jsonl");
  writeFileSync(stateFile, JSON.stringify(state));
  writeFileSync(log, "");
  const env = {
    FAKE_GH_LOG: log,
    FAKE_GH_STATE: stateFile,
    GH_TOKEN: "stand-in-token-not-a-credential",
    PATH: process.env.PATH,
  };
  const invoke = (argv, extraEnv = {}) => {
    writeFileSync(log, "");
    let stdout = "";
    let stderr = "";
    const io = {
      stderr: { write: (text) => { stderr += text; } },
      stdout: { write: (text) => { stdout += text; } },
    };
    const code = main(argv, { env: { ...env, ...extraEnv }, gh: [process.execPath, gh], io });
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return {
      calls,
      code,
      error: stderr ? JSON.parse(stderr) : null,
      result: stdout ? JSON.parse(stdout) : null,
    };
  };
  const readState = () => JSON.parse(readFileSync(stateFile, "utf8"));
  return { invoke, readState };
}

const call = (method, path, input = null) => ({ argv: ["api", "--method", method, path, ...(input ? ["--input", "-"] : [])], input });
const BASE = `repos/${REPO}`;
const APPROVAL = `${BASE}/actions/permissions/fork-pr-contributor-approval`;
const LIST = `${BASE}/rulesets?includes_parents=false&per_page=100`;

test("a fresh public repository gets exactly the declared calls, and a second run only reads", (t) => {
  const { invoke, readState } = harness(t);
  const first = invoke(["--repo", REPO]);
  assert.equal(first.code, 0, JSON.stringify(first.error));
  assert.deepEqual(first.calls, [
    call("GET", BASE),
    call("PATCH", BASE, {
      allow_squash_merge: false,
      allow_rebase_merge: false,
      delete_branch_on_merge: true,
      has_issues: false,
      has_wiki: false,
    }),
    call("GET", APPROVAL),
    call("PUT", APPROVAL, { approval_policy: "all_external_contributors" }),
    call("GET", LIST),
    call("POST", `${BASE}/rulesets`, readConfig("ruleset-main.json")),
    call("POST", `${BASE}/rulesets`, readConfig("ruleset-release-tags.json")),
  ]);
  assert.equal(first.result.status, "applied");

  const before = readState();
  const second = invoke(["--repo", REPO]);
  assert.equal(second.code, 0);
  assert.deepEqual(second.calls, [
    call("GET", BASE),
    call("GET", APPROVAL),
    call("GET", LIST),
    call("GET", `${BASE}/rulesets/101`),
    call("GET", `${BASE}/rulesets/102`),
  ]);
  assert.deepEqual(second.result, { status: "unchanged", repository: REPO, changes: [] });
  assert.deepEqual(readState(), before);
});

test("the state left behind is the declared one", (t) => {
  const { invoke, readState } = harness(t);
  assert.equal(invoke(["--repo", REPO]).code, 0);
  const state = readState();
  assert.ok(covers(state.repository, readConfig("repository.json")));
  assert.deepEqual(state.forkApproval, readConfig("fork-pr-approval.json"));
  assert.deepEqual(state.rulesets.map((ruleset) => ruleset.name), ["main", "release-tags"]);
});

test("a field changed by hand is patched alone", (t) => {
  // Someone turns squash back on in the web interface.
  const drifted = freshState();
  Object.assign(drifted.repository, readConfig("repository.json"), { allow_squash_merge: true });
  drifted.forkApproval = readConfig("fork-pr-approval.json");
  const run = harness(t, drifted).invoke(["--repo", REPO]);
  assert.equal(run.code, 0);
  assert.deepEqual(run.calls.slice(0, 3), [
    call("GET", BASE),
    call("PATCH", BASE, { allow_squash_merge: false }),
    call("GET", APPROVAL),
  ]);
  assert.deepEqual(run.result.changes[0], { target: "repository", fields: ["allow_squash_merge"], action: "updated" });
});

test("a ruleset with a rule added by hand is replaced whole, and one without its check too", (t) => {
  const { invoke, readState } = harness(t);
  invoke(["--repo", REPO]);
  const state = readState();
  state.rulesets[0].rules.push({ type: "required_linear_history" });
  state.rulesets[1].rules = state.rulesets[1].rules.filter((rule) => rule.type !== "update");
  const drifted = harness(t, state);
  const run = drifted.invoke(["--repo", REPO]);
  assert.deepEqual(run.calls.slice(1), [
    call("GET", APPROVAL),
    call("GET", LIST),
    call("GET", `${BASE}/rulesets/101`),
    call("PUT", `${BASE}/rulesets/101`, readConfig("ruleset-main.json")),
    call("GET", `${BASE}/rulesets/102`),
    call("PUT", `${BASE}/rulesets/102`, readConfig("ruleset-release-tags.json")),
  ]);
  assert.deepEqual(drifted.readState().rulesets[0].rules.map((rule) => rule.type).sort(),
    ["deletion", "non_fast_forward", "pull_request", "required_status_checks"]);
});

test("--check reads, reports what differs and exits 1 without a single write", (t) => {
  const { invoke, readState } = harness(t);
  const before = readState();
  const run = invoke(["--repo", REPO, "--check"]);
  assert.equal(run.code, 1);
  assert.deepEqual(run.calls.map((entry) => entry.argv[2]), ["GET", "GET", "GET"]);
  assert.equal(run.result.status, "differs");
  assert.deepEqual(run.result.changes.map((change) => change.action), ["differs", "differs", "missing", "missing"]);
  assert.deepEqual(readState(), before);
});

test("a private repository is refused before any write", (t) => {
  const state = freshState();
  state.repository.private = true;
  state.repository.visibility = "private";
  const { invoke, readState } = harness(t, state);
  const run = invoke(["--repo", REPO]);
  assert.equal(run.code, 1);
  assert.equal(run.error.error.code, "github_settings_repository_not_public");
  assert.deepEqual(run.calls, [call("GET", BASE)]);
  assert.deepEqual(readState(), state);
});

test("a failing gh call is a refusal that stops the run", (t) => {
  const { invoke } = harness(t);
  const run = invoke(["--repo", REPO], { FAKE_GH_FAIL: `GET ${APPROVAL}` });
  assert.equal(run.code, 1);
  assert.equal(run.error.error.code, "github_settings_gh_failed");
  assert.match(run.error.error.message, /HTTP 500/u);
  assert.equal(run.calls.length, 3);
});

test("two rulesets of one declared name are refused rather than guessed between", (t) => {
  const { invoke, readState } = harness(t);
  invoke(["--repo", REPO]);
  const state = readState();
  state.rulesets.push({ ...state.rulesets[0], id: 900 });
  const run = harness(t, state).invoke(["--repo", REPO]);
  assert.equal(run.error.error.code, "github_settings_ruleset_ambiguous");
});

test("arguments that do not name one repository are refused before gh is called", (t) => {
  const { invoke } = harness(t);
  for (const argv of [[], ["--repo"], ["--repo", "owner"], ["--repo", "owner/.."], ["--repo", "-x/y"],
    ["--repo", "a/b", "--repo", "c/d"], ["--repo", "a/b", "--extra"], ["--repo", "a/b c"]]) {
    const run = invoke(argv);
    assert.equal(run.code, 1, JSON.stringify(argv));
    assert.equal(run.error.error.code, "github_settings_invalid_arguments");
    assert.equal(run.calls.length, 0);
  }
});

test("covers: extra server keys pass, a missing or changed value and an extra element do not", () => {
  assert.ok(covers({ a: 1, b: { c: [1, 2], d: 0 } }, { b: { c: [2, 1] } }));
  assert.ok(!covers({ a: 1 }, { a: 2 }));
  assert.ok(!covers({}, { a: false }));
  assert.ok(!covers({ r: [{ t: 1 }, { t: 2 }] }, { r: [{ t: 1 }] }));
  assert.ok(!covers({ r: [{ t: 1 }, { t: 1 }] }, { r: [{ t: 1 }, { t: 2 }] }));
});

test("the declared settings follow the user's decisions and the measurements of task 171", () => {
  assert.deepEqual(readConfig("repository.json"), {
    allow_merge_commit: true,
    allow_squash_merge: false,
    allow_rebase_merge: false,
    allow_auto_merge: false,
    delete_branch_on_merge: true,
    merge_commit_title: "MERGE_MESSAGE",
    merge_commit_message: "PR_TITLE",
    has_issues: false,
    has_wiki: false,
    has_discussions: false,
  });
  assert.deepEqual(readConfig("fork-pr-approval.json"), { approval_policy: "all_external_contributors" });

  const main = readConfig("ruleset-main.json");
  assert.equal(main.enforcement, "active");
  assert.deepEqual(main.bypass_actors, []);
  assert.deepEqual(main.conditions.ref_name.include, ["~DEFAULT_BRANCH"]);
  assert.deepEqual(main.rules.map((rule) => rule.type).sort(),
    ["deletion", "non_fast_forward", "pull_request", "required_status_checks"]);
  const rule = (type) => main.rules.find((entry) => entry.type === type).parameters;
  assert.equal(rule("pull_request").required_approving_review_count, 0);
  assert.deepEqual(rule("pull_request").allowed_merge_methods, ["merge"]);
  assert.equal(rule("required_status_checks").strict_required_status_checks_policy, true);
  assert.deepEqual(rule("required_status_checks").required_status_checks, [{ context: "gate", integration_id: 15368 }]);

  const tags = readConfig("ruleset-release-tags.json");
  assert.equal(tags.target, "tag");
  assert.deepEqual(tags.bypass_actors, []);
  assert.deepEqual(tags.conditions.ref_name.include, ["refs/tags/release-*"]);
  assert.deepEqual(tags.rules.map((entry) => entry.type).sort(), ["deletion", "non_fast_forward", "update"]);
});

test("the required check is the one job of the CI workflow, and that job carries no name", () => {
  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const jobsBlock = workflow.split(/^jobs:\n/mu)[1];
  const jobIds = [...jobsBlock.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gmu)].map((match) => match[1]);
  const [context] = readConfig("ruleset-main.json").rules
    .find((entry) => entry.type === "required_status_checks").parameters.required_status_checks;
  assert.deepEqual(jobIds, [context.context]);
  assert.doesNotMatch(jobsBlock, /^ {4}name:/mu);
});

test("the refusal codes are frozen", () => {
  const found = [...new Set(SOURCE.match(/github_settings_[a-z_]+/gu))].sort();
  assert.deepEqual(found, PINNED_CODES);
});
