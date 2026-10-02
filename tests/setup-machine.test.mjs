// The new-machine setup, run in a disposable projects root: an engine clone of its own, a bare
// repository standing in for the private one and carrying the example layer, a home directory,
// and — for the operational cases — an operational folder whose preflight is a stub.
//
// Git is real, with a throwaway global config. `npm` and `launchctl` are stand-ins handed in by
// absolute path, so neither the real package manager nor the real launchd is ever reached; each
// logs its calls, and the cases assert on those logs. The toolchain check is injected: the
// machine running this suite need not carry the CV renderer, and `tests/bootstrap.test.mjs` owns
// that check. The real private layer of this checkout is never read.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { printPlist } from "../tools/operational-backup.mjs";
import {
  BACKUP_DIRECTORY,
  HOOKS_DIRECTORY,
  INSTALL_COMMANDS,
  OPERATIONAL_FOLDER_NAME,
  defaultContext,
  main,
} from "../tools/setup/machine.mjs";

const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const EXAMPLE = join(repoRoot, "candidate.example");
const SOURCE = readFileSync(join(repoRoot, "tools", "setup", "machine.mjs"), "utf8");
const LABEL = "com.job-search-pipeline.backup";
const UID = 4242;

// Frozen here rather than read from the module; tools/setup/README.md names the same set.
const PINNED_CODES = [
  "setup_machine_engine_not_a_clone",
  "setup_machine_failed",
  "setup_machine_git_failed",
  "setup_machine_hooks_path_unset",
  "setup_machine_install_failed",
  "setup_machine_invalid_arguments",
  "setup_machine_launch_agent_missing",
  "setup_machine_launchctl_failed",
  "setup_machine_operational_is_a_checkout",
  "setup_machine_operational_missing",
  "setup_machine_operational_preflight_failed",
  "setup_machine_path_unsafe",
  "setup_machine_private_not_a_clone",
  "setup_machine_private_not_ignored",
  "setup_machine_private_remote_mismatch",
  "setup_machine_private_url_missing",
  "setup_machine_target_differs",
  "setup_machine_target_missing",
  "setup_machine_template_invalid",
  "setup_machine_template_missing",
  "setup_machine_template_placeholder_unknown",
];

const FAKE_NPM = String.raw`
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + "\n");
if (argv.includes("--prefix")) writeFileSync(join(process.cwd(), ".stand-in-dependencies"), "");
`;

const FAKE_LAUNCHCTL = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_LAUNCHCTL_LOG, JSON.stringify(argv) + "\n");
const state = process.env.FAKE_LAUNCHCTL_STATE;
const known = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : [];
if (argv[0] === "print") process.exit(known.includes(argv[1]) ? 0 : 113);
if (argv[0] === "bootstrap") {
  if (process.env.FAKE_LAUNCHCTL_FAIL) { process.stderr.write("Bootstrap failed: 5: Input/output error\n"); process.exit(5); }
  const label = readFileSync(argv[2], "utf8").match(/<string>([^<]+)<\/string>/)[1];
  writeFileSync(state, JSON.stringify([...known, argv[1] + "/" + label]));
  process.exit(0);
}
process.exit(64);
`;

function sh(cwd, program, ...args) {
  const result = spawnSync(program, args, { cwd, encoding: "utf8", env: gitEnv });
  assert.equal(result.status, 0, `${program} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "setup-machine-config-")));
const gitConfig = join(scratch, "gitconfig");
writeFileSync(
  gitConfig,
  [
    "[user]",
    "\tname = Setup Probe",
    "\temail = probe@example.com",
    "[init]",
    "\tdefaultBranch = main",
    "[commit]",
    "\tgpgsign = false",
    '[protocol "file"]',
    "\tallow = always",
    "",
  ].join("\n"),
);
const gitEnv = { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1", PATH: process.env.PATH };
test.after(() => rmSync(scratch, { force: true, recursive: true }));

/**
 * One disposable machine. `layer` edits the private repository's files before it is committed;
 * `operational` creates the operational folder with a preflight stub answering `preflight`.
 */
function machine(
  t,
  { layer = () => {}, operational = false, preflight = "ready", home = "home", ignore = true } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "setup-machine-")));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const projects = join(root, "projects");
  const engine = join(projects, "engine");
  const homeRoot = join(root, home);
  const opsRoot = join(projects, OPERATIONAL_FOLDER_NAME);
  mkdirSync(engine, { recursive: true });
  mkdirSync(homeRoot, { recursive: true });
  sh(engine, "git", "init", "-q");
  if (ignore) writeFileSync(join(engine, ".gitignore"), "/candidate/\n");

  const source = join(root, "private-source");
  cpSync(EXAMPLE, source, { recursive: true });
  layer(source);
  sh(source, "git", "init", "-q");
  sh(source, "git", "add", "-A");
  sh(source, "git", "commit", "-q", "-m", "layer");
  const bare = join(root, "private.git");
  sh(root, "git", "clone", "-q", "--bare", source, bare);

  if (operational) {
    mkdirSync(join(opsRoot, "tools"), { recursive: true });
    const verdict =
      preflight === "ready"
        ? 'process.stdout.write(JSON.stringify({ status: "ready" }) + "\\n");'
        : 'process.stderr.write(JSON.stringify({ status: "error", error: { code: "bootstrap_required" } }) + "\\n"); process.exitCode = 1;';
    writeFileSync(join(opsRoot, "tools", "bootstrap.mjs"), `${verdict}\n`);
  }

  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "npm.mjs"), FAKE_NPM);
  writeFileSync(join(bin, "launchctl.mjs"), FAKE_LAUNCHCTL);
  const logs = {
    launchctl: join(root, "launchctl.jsonl"),
    launchctlState: join(root, "launchctl-state.json"),
    npm: join(root, "npm.jsonl"),
  };
  const context = (extraEnv = {}) => ({
    candidateRoot: join(engine, "candidate"),
    checkDependencies: (builderRoot) => {
      if (!existsSync(join(dirname(dirname(builderRoot)), ".stand-in-dependencies")))
        throw new Error("missing");
    },
    checkToolchain: ({ workspaceRoot }) => ({ stand_in: true, workspace_root: workspaceRoot }),
    commands: {
      git: ["git"],
      launchctl: [process.execPath, join(bin, "launchctl.mjs")],
      npm: [process.execPath, join(bin, "npm.mjs")],
    },
    engineRoot: engine,
    env: {
      ...gitEnv,
      FAKE_LAUNCHCTL_LOG: logs.launchctl,
      FAKE_LAUNCHCTL_STATE: logs.launchctlState,
      FAKE_NPM_LOG: logs.npm,
      HOME: homeRoot,
      ...extraEnv,
    },
    home: homeRoot,
    nodePath: process.execPath,
    operationalRoot: opsRoot,
    uid: UID,
  });
  const read = (path) =>
    existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const invoke = (argv, extraEnv = {}) => {
    for (const log of [logs.npm, logs.launchctl]) writeFileSync(log, "");
    let stdout = "";
    let stderr = "";
    const io = {
      stderr: {
        write: (text) => {
          stderr += text;
        },
      },
      stdout: {
        write: (text) => {
          stdout += text;
        },
      },
    };
    const code = main(argv, context(extraEnv), io);
    return {
      code,
      error: stderr ? JSON.parse(stderr).error : null,
      launchctl: read(logs.launchctl),
      npm: read(logs.npm),
      result: stdout ? JSON.parse(stdout) : null,
    };
  };
  const plistPath = join(homeRoot, "Library", "LaunchAgents", `${LABEL}.plist`);
  const settingsPath = join(opsRoot, ".claude", "settings.local.json");
  return { bare, engine, home: homeRoot, invoke, opsRoot, plistPath, root, settingsPath };
}

const outcomes = (result) =>
  Object.fromEntries(result.steps.map((step) => [step.step, step.outcome]));

function tree(path) {
  return existsSync(path) ? readdirSync(path, { recursive: true }).sort() : null;
}

test("a fresh machine: private clone, dependencies, hook path, a green check, nothing operational", (t) => {
  const m = machine(t, { operational: true });
  const opsBefore = tree(m.opsRoot);
  const run = m.invoke(["--private", m.bare]);
  assert.equal(run.code, 0, JSON.stringify(run.error));
  assert.deepEqual(outcomes(run.result), {
    "private-clone": "done",
    dependencies: "done",
    "hooks-path": "done",
  });
  assert.ok(existsSync(join(m.engine, "candidate", ".git")));
  assert.equal(
    sh(m.engine, "git", "config", "--local", "core.hooksPath").trim(),
    join(m.engine, HOOKS_DIRECTORY),
  );
  assert.deepEqual(
    run.npm,
    INSTALL_COMMANDS.map((argv) => ({ argv: [...argv], cwd: m.engine })),
  );
  assert.deepEqual(run.launchctl, []);
  assert.equal(run.result.checked.layer, "ready");
  assert.equal(run.result.checked.hooks_path, true);
  assert.equal(run.result.checked.toolchain.workspace_root, m.engine);
  assert.deepEqual(readdirSync(m.home), []);
  assert.deepEqual(tree(m.opsRoot), opsBefore);
  assert.equal(
    sh(m.engine, "git", "status", "--porcelain"),
    "?? .gitignore\n?? .stand-in-dependencies\n",
  );
});

test("a second run changes nothing: every step is skipped and no program is started", (t) => {
  const m = machine(t);
  assert.equal(m.invoke(["--private", m.bare]).code, 0);
  const config = readFileSync(join(m.engine, ".git", "config"), "utf8");
  const head = sh(join(m.engine, "candidate"), "git", "rev-parse", "HEAD");
  const again = m.invoke([]);
  assert.equal(again.code, 0, JSON.stringify(again.error));
  assert.deepEqual(outcomes(again.result), {
    "private-clone": "skipped",
    dependencies: "skipped",
    "hooks-path": "skipped",
  });
  assert.deepEqual(again.npm, []);
  assert.equal(readFileSync(join(m.engine, ".git", "config"), "utf8"), config);
  assert.equal(sh(join(m.engine, "candidate"), "git", "rev-parse", "HEAD"), head);
});

test("--operational renders both templates, registers the agent once, and runs the folder's preflight", (t) => {
  const m = machine(t, { operational: true });
  const run = m.invoke(["--private", m.bare, "--operational"]);
  assert.equal(run.code, 0, JSON.stringify(run.error));
  assert.deepEqual(outcomes(run.result), {
    "private-clone": "done",
    dependencies: "done",
    "hooks-path": "done",
    "template:settings.local.json": "done",
    "template:backup.plist": "done",
    "launch-agent": "done",
  });
  assert.deepEqual(JSON.parse(readFileSync(m.settingsPath, "utf8")), {
    sandbox: { enabled: false },
  });
  const backupRoot = join(m.home, BACKUP_DIRECTORY);
  const expected = printPlist(
    { dest: backupRoot, script: join(m.opsRoot, "tools", "operational-backup.mjs") },
    { nodePath: process.execPath },
  ).plist;
  assert.equal(readFileSync(m.plistPath, "utf8"), expected);
  assert.deepEqual(run.launchctl, [
    ["print", `gui/${UID}/${LABEL}`],
    ["bootstrap", `gui/${UID}`, m.plistPath],
    ["print", `gui/${UID}/${LABEL}`],
  ]);
  assert.equal(run.result.checked.operational_preflight, "ready");
  assert.equal(run.result.operational_root, m.opsRoot);

  const again = m.invoke(["--operational"]);
  assert.equal(again.code, 0, JSON.stringify(again.error));
  assert.equal(outcomes(again.result)["launch-agent"], "skipped");
  assert.equal(outcomes(again.result)["template:backup.plist"], "skipped");
  assert.deepEqual(again.launchctl, [
    ["print", `gui/${UID}/${LABEL}`],
    ["print", `gui/${UID}/${LABEL}`],
  ]);
});

test("a failed registration is retried by the next run", (t) => {
  const m = machine(t, { operational: true });
  const failed = m.invoke(["--private", m.bare, "--operational"], { FAKE_LAUNCHCTL_FAIL: "1" });
  assert.equal(failed.code, 1);
  assert.equal(failed.error.code, "setup_machine_launchctl_failed");
  assert.ok(existsSync(m.plistPath));
  const retried = m.invoke(["--operational"]);
  assert.equal(retried.code, 0, JSON.stringify(retried.error));
  assert.equal(outcomes(retried.result)["template:backup.plist"], "skipped");
  assert.equal(outcomes(retried.result)["launch-agent"], "done");
});

test("--check only checks: on a machine not set up it refuses and writes nothing", (t) => {
  const m = machine(t);
  const run = m.invoke(["--check"]);
  assert.equal(run.code, 1);
  assert.equal(run.error.code, "setup_machine_private_not_a_clone");
  assert.ok(!existsSync(join(m.engine, "candidate")));
  assert.deepEqual(run.npm, []);
});

test("refusals before anything is written", async (t) => {
  const cases = [
    {
      name: "no operational folder",
      argv: (m) => ["--private", m.bare, "--operational"],
      code: "setup_machine_operational_missing",
      options: {},
    },
    {
      name: "the operational folder is a git checkout",
      argv: (m) => ["--private", m.bare, "--operational"],
      code: "setup_machine_operational_is_a_checkout",
      options: { operational: true },
      prepare: (m) => sh(m.opsRoot, "git", "init", "-q"),
    },
    {
      name: "a home path a template could not carry verbatim",
      argv: (m) => ["--private", m.bare, "--operational"],
      code: "setup_machine_path_unsafe",
      options: { home: "home & more", operational: true },
    },
    {
      name: "a linked working copy instead of a clone",
      argv: (m) => ["--private", m.bare],
      code: "setup_machine_engine_not_a_clone",
      options: {},
      prepare: (m) => {
        rmSync(join(m.engine, ".git"), { force: true, recursive: true });
        writeFileSync(join(m.engine, ".git"), "gitdir: /elsewhere/.git/worktrees/engine\n");
      },
    },
    {
      name: "a private directory that is not a repository",
      argv: (m) => ["--private", m.bare],
      code: "setup_machine_private_not_a_clone",
      options: {},
      prepare: (m) => mkdirSync(join(m.engine, "candidate")),
    },
    {
      name: "no URL for a private repository not yet cloned",
      argv: () => [],
      code: "setup_machine_private_url_missing",
      options: {},
    },
    {
      name: "a URL that reads as an option",
      argv: () => ["--private", "--upload-pack=true"],
      code: "setup_machine_invalid_arguments",
      options: {},
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, (tt) => {
      const m = machine(tt, entry.options);
      entry.prepare?.(m);
      const run = m.invoke(entry.argv(m));
      assert.equal(run.code, 1);
      assert.equal(run.error.code, entry.code);
      assert.deepEqual(run.npm, []);
      assert.deepEqual(run.launchctl, []);
      assert.ok(!existsSync(join(m.engine, "candidate", ".git")));
      assert.deepEqual(readdirSync(m.home), []);
    });
  }
});

test("a private repository the engine does not ignore, or with another origin, is refused", (t) => {
  const unignored = machine(t, { ignore: false });
  const first = unignored.invoke(["--private", unignored.bare]);
  assert.equal(first.error.code, "setup_machine_private_not_ignored");
  assert.deepEqual(first.npm, []);

  const m = machine(t);
  assert.equal(m.invoke(["--private", m.bare]).code, 0);
  const other = m.invoke(["--private", join(m.root, "other.git")]);
  assert.equal(other.error.code, "setup_machine_private_remote_mismatch");
});

test("a target holding other content is refused and left as it was; no target is written", (t) => {
  const m = machine(t, { operational: true });
  mkdirSync(dirname(m.settingsPath), { recursive: true });
  writeFileSync(m.settingsPath, '{"permissions":{}}\n');
  const run = m.invoke(["--private", m.bare, "--operational"]);
  assert.equal(run.code, 1);
  assert.equal(run.error.code, "setup_machine_target_differs");
  assert.equal(readFileSync(m.settingsPath, "utf8"), '{"permissions":{}}\n');
  assert.ok(!existsSync(m.plistPath));
  assert.deepEqual(run.launchctl, []);
});

test("a template naming an unknown placeholder, or missing, is refused before any target is written", (t) => {
  const unknown = machine(t, {
    layer: (source) =>
      writeFileSync(join(source, "machine", "settings.local.json"), '{"x": "{{engine_root}}"}\n'),
    operational: true,
  });
  const run = unknown.invoke(["--private", unknown.bare, "--operational"]);
  assert.equal(run.error.code, "setup_machine_template_placeholder_unknown");
  assert.ok(!existsSync(unknown.settingsPath));
  assert.ok(!existsSync(unknown.plistPath));

  const missing = machine(t, {
    layer: (source) => rmSync(join(source, "machine", "backup.plist")),
    operational: true,
  });
  const second = missing.invoke(["--private", missing.bare, "--operational"]);
  assert.equal(second.error.code, "setup_machine_template_missing");
  assert.ok(!existsSync(missing.settingsPath));
});

test("the check refuses what a set-up machine has since lost", (t) => {
  const m = machine(t, { operational: true });
  assert.equal(m.invoke(["--private", m.bare, "--operational"]).code, 0);

  rmSync(m.plistPath);
  assert.equal(m.invoke(["--check", "--operational"]).error.code, "setup_machine_target_missing");
  assert.equal(m.invoke(["--operational"]).code, 0);

  writeFileSync(join(m.root, "launchctl-state.json"), "[]");
  assert.equal(
    m.invoke(["--check", "--operational"]).error.code,
    "setup_machine_launch_agent_missing",
  );

  sh(m.engine, "git", "config", "--local", "--unset", "core.hooksPath");
  assert.equal(m.invoke(["--check"]).error.code, "setup_machine_hooks_path_unset");
  sh(m.engine, "git", "config", "--local", "core.hooksPath", join(m.engine, HOOKS_DIRECTORY));

  rmSync(join(m.engine, "candidate", "config.json"));
  const layer = m.invoke(["--check"]);
  assert.equal(layer.code, 1);
  assert.equal(layer.error.code, "candidate_config_missing");
});

test("an install that fails, or a template that stops being JSON, is a refusal", (t) => {
  const m = machine(t);
  const failing = m.invoke(["--private", m.bare], {
    FAKE_NPM_LOG: join(m.root, "no-such-dir", "npm.jsonl"),
  });
  assert.equal(failing.error.code, "setup_machine_install_failed");

  const broken = machine(t, {
    layer: (source) =>
      writeFileSync(join(source, "machine", "settings.local.json"), '{"sandbox": {{node}}}\n'),
    operational: true,
  });
  const run = broken.invoke(["--private", broken.bare, "--operational"]);
  assert.equal(run.error.code, "setup_machine_template_invalid");
  assert.ok(!existsSync(broken.settingsPath));
});

test("a red preflight of the operational folder makes the whole setup red", (t) => {
  const m = machine(t, { operational: true, preflight: "red" });
  const run = m.invoke(["--private", m.bare, "--operational"]);
  assert.equal(run.code, 1);
  assert.equal(run.error.code, "setup_machine_operational_preflight_failed");
});

test("every path of a real run is derived from the engine root, none is typed", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "setup-machine-derive-")));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const engine = join(root, "engine");
  mkdirSync(engine);
  const context = defaultContext({ engineRoot: engine, env: {} });
  assert.equal(context.engineRoot, engine);
  assert.equal(context.candidateRoot, join(engine, "candidate"));
  assert.equal(context.operationalRoot, join(root, "job-search-pipeline"));
  assert.equal(context.nodePath, process.execPath);
  assert.deepEqual(context.commands, { git: ["git"], launchctl: ["launchctl"], npm: ["npm"] });
});

test("the install commands are the workflow's own", () => {
  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const installs = [...workflow.matchAll(/^ {6}- run: npm (ci\b.*)$/gmu)].map((match) =>
    match[1].split(" "),
  );
  assert.deepEqual(
    installs,
    INSTALL_COMMANDS.map((argv) => [...argv]),
  );
});

test("the refusal codes are frozen", () => {
  const found = [...new Set(SOURCE.match(/setup_machine_[a-z_]+/gu))].sort();
  assert.deepEqual(found, PINNED_CODES);
});
