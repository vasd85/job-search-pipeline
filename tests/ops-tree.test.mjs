import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { createRunningPublicationStep, createValidV3Log } from "./fixtures/process-log-v3.mjs";
import {
  MANIFEST_FILE_NAME,
  readManifest,
  verifyFolder,
  zoneOf,
  zoneTableFor,
} from "../tools/ops-tree/manifest.mjs";
import {
  acquireLock,
  cutoverFolder,
  exportFolder,
  releaseLock,
  rollbackFolder,
} from "../tools/ops-tree/tree.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const treeModuleUrl = pathToFileURL(join(repoRoot, "tools/ops-tree/tree.mjs")).href;

function gitEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && !key.startsWith("JOB_PIPELINE_")) environment[key] = value;
  }
  return environment;
}

function git(cwd, args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Fixture Author",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, encoding: "utf8", env: gitEnvironment() },
  );
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function writeTree(directory, files) {
  for (const [path, value] of Object.entries(files)) {
    const target = join(directory, path);
    if (value === null) {
      rmSync(target, { force: true, recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    const content = typeof value === "string" ? value : value.content;
    writeFileSync(target, content);
    chmodSync(target, typeof value === "object" && value.executable ? 0o755 : 0o644);
  }
}

function makeRepository(directory, files, tag) {
  mkdirSync(directory, { recursive: true });
  git(directory, ["init", "-q"]);
  commitAndTag(directory, files, tag);
}

function commitAndTag(directory, files, tag) {
  writeTree(directory, files);
  git(directory, ["add", "-A"]);
  git(directory, ["commit", "-q", "--allow-empty", "-m", `fixture ${tag}`]);
  git(directory, ["tag", tag]);
}

function scratch(t, prefix) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  return directory;
}

/** Every file under a directory, with its bytes and mode: the "nothing moved" proof. */
function treeSnapshot(directory) {
  const rows = {};
  const walk = (relativeDirectory) => {
    const absolute = relativeDirectory === "" ? directory : join(directory, relativeDirectory);
    for (const name of readdirSync(absolute).sort()) {
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const stats = lstatSync(join(absolute, name));
      if (stats.isDirectory()) walk(relativePath);
      else
        rows[relativePath] = `${stats.mode}:${createHash("sha256")
          .update(readFileSync(join(absolute, name)))
          .digest("hex")}`;
    }
  };
  walk("");
  return rows;
}

const STUB_CONTROL = "stub-control.json";

function stubScript(depth, key) {
  return `import { readFileSync } from "node:fs";
const control = JSON.parse(readFileSync(new URL("${"../".repeat(depth)}${STUB_CONTROL}", import.meta.url), "utf8"));
const args = process.argv.slice(2);
const entry = control[${JSON.stringify(key)}];
if (args[0] === "validate") {
  process.stdout.write(JSON.stringify(entry.report));
  process.exitCode = entry.exit;
} else if (entry.exit !== 0) {
  process.stderr.write(JSON.stringify({ status: "error", error: { code: entry.code } }));
  process.exitCode = entry.exit;
} else {
  process.stdout.write("{}");
}
`;
}

function engineFiles(control, extra = {}) {
  return {
    ".claude/settings.json": "{}\n",
    "README.md": "# Fixture engine\n",
    "docs/guide.md": "guide\n",
    "package-lock.json": `${JSON.stringify({ lockfileVersion: 3, packages: { "": {} } })}\n`,
    "package.json": '{"name":"fixture-engine","private":true}\n',
    [STUB_CONTROL]: `${JSON.stringify(control)}\n`,
    "tools/bootstrap.mjs": stubScript(1, "bootstrap"),
    "tools/build.sh": { content: "#!/bin/sh\nexit 0\n", executable: true },
    "tools/candidate/cli.mjs": stubScript(2, "candidate"),
    "tools/cv-builder/package-lock.json": `${JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/fixture-dep": { version: "1.0.0" } } })}\n`,
    "tools/process-log.mjs": stubScript(1, "validate"),
    ...extra,
  };
}

const PASSING = Object.freeze({
  bootstrap: { exit: 0 },
  candidate: { exit: 0 },
  validate: { exit: 0, report: { processes: [] } },
});

const CANDIDATE_FILES = Object.freeze({
  "board/0001-task.md": "a board task\n",
  "config.json": '{"schema_version":1}\n',
  "profile.md": "# Fixture profile\n",
  "research/notes.md": "private research\n",
  "rules.md": "# Rules\n",
});

function fakeInstall(directory) {
  mkdirSync(join(directory, "node_modules/fixture-dep"), { recursive: true });
  writeFileSync(join(directory, "node_modules/fixture-dep/index.js"), "module.exports = 1;\n");
}

function context(overrides = {}) {
  return { install: fakeInstall, now: () => new Date("2026-09-24T12:00:00.000Z"), ...overrides };
}

/** Two tagged repositories and an exported folder, with the state a run would have left. */
function fixtureFolder(t, { control = PASSING, extra = {}, withState = true } = {}) {
  const base = scratch(t, "ops-tree-");
  const engineRepo = join(base, "engine");
  const candidateRepo = join(base, "private");
  makeRepository(engineRepo, engineFiles(control, extra), "release-20260901");
  makeRepository(candidateRepo, CANDIDATE_FILES, "candidate-20260901");
  const root = join(base, "folder");
  exportFolder(
    {
      candidate: "candidate-20260901",
      candidateRepo,
      engineRepo,
      release: "release-20260901",
      root,
    },
    context(),
  );
  if (withState) {
    writeFileSync(
      join(root, "process-log.json"),
      `${JSON.stringify(createValidV3Log(), null, 2)}\n`,
    );
    mkdirSync(join(root, "output/example-labs-senior-sdet"), { recursive: true });
    writeFileSync(join(root, "output/example-labs-senior-sdet/cv.json"), "{}\n");
    mkdirSync(join(root, "records/letter-corrections"), { recursive: true });
    writeFileSync(join(root, "records/letter-corrections/record.json"), '{"id":1}\n');
    writeFileSync(join(root, ".claude/settings.local.json"), '{"local":true}\n');
  }
  return { base, candidateRepo, engineRepo, root };
}

function nextRelease(fixture, tag, files) {
  commitAndTag(fixture.engineRepo, files, tag);
}

function writeLedger(root, mutate) {
  const log = createValidV3Log();
  mutate(log);
  writeFileSync(join(root, "process-log.json"), `${JSON.stringify(log, null, 2)}\n`);
}

function writeOverride(root, command, reason) {
  const inputRoot = join(root, ".pipeline-input");
  mkdirSync(inputRoot, { mode: 0o700, recursive: true });
  chmodSync(inputRoot, 0o700);
  const nonce = createHash("sha256").update(`${command}${reason}`).digest("hex").slice(0, 32);
  const name = `input-${nonce}.json`;
  writeFileSync(
    join(inputRoot, name),
    JSON.stringify({
      command,
      nonce,
      schemaVersion: 1,
      values: { overrideReason: reason },
    }),
    { mode: 0o600 },
  );
  return name;
}

function assertCode(action, code) {
  assert.throws(action, (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// export and the manifest

test("export builds a folder without .git from two tags and records both, the zones and every digest", (t) => {
  const fixture = fixtureFolder(t, { withState: false });
  const { root } = fixture;
  assert.equal(existsSync(join(root, ".git")), false);
  assert.equal(existsSync(join(root, ".ops-tree")), true);
  const manifest = readManifest(root);
  assert.equal(manifest.kind, "operational");
  assert.equal(manifest.state, "ready");
  assert.equal(manifest.previous, null);
  assert.equal(manifest.engine.tag, "release-20260901");
  assert.equal(
    manifest.engine.commit,
    git(fixture.engineRepo, ["rev-parse", "release-20260901^{commit}"]),
  );
  assert.equal(
    manifest.engine.tree,
    git(fixture.engineRepo, ["rev-parse", "release-20260901^{tree}"]),
  );
  assert.equal(manifest.candidate.tag, "candidate-20260901");
  assert.deepEqual(manifest.zones, zoneTableFor("operational"));
  assert.equal(manifest.files.engine["tools/build.sh"].executable, true);
  assert.equal(manifest.files.engine["README.md"].executable, false);
  assert.ok(manifest.files.dependencies["tools/cv-builder/node_modules/fixture-dep/index.js"]);
  assert.deepEqual(Object.keys(manifest.files.candidate).sort(), [
    "candidate/config.json",
    "candidate/profile.md",
    "candidate/rules.md",
  ]);
  assert.equal(
    existsSync(join(root, "candidate/board")),
    false,
    "the board never enters the folder",
  );
  assert.equal(
    existsSync(join(root, "candidate/research")),
    false,
    "private research never enters the folder",
  );
  assert.equal(verifyFolder(root).status, "clean");
});

test("export refuses a root inside a repository, a non-empty root, a malformed tag and a non-tag", (t) => {
  const fixture = fixtureFolder(t, { withState: false });
  const input = {
    candidate: "candidate-20260901",
    candidateRepo: fixture.candidateRepo,
    engineRepo: fixture.engineRepo,
    release: "release-20260901",
  };
  assertCode(
    () => exportFolder({ ...input, root: join(fixture.engineRepo, "inside") }, context()),
    "ops_tree_root_inside_repository",
  );
  assert.equal(existsSync(join(fixture.engineRepo, "inside")), false);
  assertCode(
    () => exportFolder({ ...input, root: fixture.root }, context()),
    "ops_tree_root_not_empty",
  );
  assertCode(
    () => exportFolder({ ...input, release: "v1", root: join(fixture.base, "a") }, context()),
    "ops_tree_invalid_tag",
  );
  git(fixture.engineRepo, ["branch", "release-20260999"]);
  assertCode(
    () =>
      exportFolder(
        { ...input, release: "release-20260999", root: join(fixture.base, "b") },
        context(),
      ),
    "ops_tree_tag_missing",
  );
});

test("an engine tag that tracks a path of the state zone is refused before the folder exists", (t) => {
  const base = scratch(t, "ops-tree-overlap-");
  makeRepository(
    join(base, "engine"),
    engineFiles(PASSING, { "output/leak.txt": "x\n" }),
    "release-20260901",
  );
  makeRepository(join(base, "private"), CANDIDATE_FILES, "candidate-20260901");
  assertCode(
    () =>
      exportFolder(
        {
          candidate: "candidate-20260901",
          candidateRepo: join(base, "private"),
          engineRepo: join(base, "engine"),
          release: "release-20260901",
          root: join(base, "folder"),
        },
        context(),
      ),
    "ops_tree_image_overlaps_state",
  );
  assert.deepEqual(readdirSync(join(base, "folder/.ops-tree/staging")), []);
});

test("an export that differs from the tagged blobs is refused", (t) => {
  const base = scratch(t, "ops-tree-attributes-");
  makeRepository(
    join(base, "engine"),
    engineFiles(PASSING, {
      ".gitattributes": "docs/guide.md export-ignore\n",
    }),
    "release-20260901",
  );
  makeRepository(join(base, "private"), CANDIDATE_FILES, "candidate-20260901");
  assertCode(
    () =>
      exportFolder(
        {
          candidate: "candidate-20260901",
          candidateRepo: join(base, "private"),
          engineRepo: join(base, "engine"),
          release: "release-20260901",
          root: join(base, "folder"),
        },
        context(),
      ),
    "ops_tree_export_mismatch",
  );
});

test("the zone table: state, handover, service and metadata are never digested; the rest is engine", () => {
  const zones = zoneTableFor("operational");
  assert.equal(zoneOf(zones, "process-log.json.lock.claim-1"), "state");
  assert.equal(zoneOf(zones, "process-log.backup-pre-cutover.json"), "state");
  assert.equal(zoneOf(zones, "candidate/research/x"), "candidate");
  assert.equal(zoneOf(zones, ".claude/settings.local.json"), "state");
  assert.equal(zoneOf(zones, ".claude/.cc-writes/x"), "state");
  assert.equal(zoneOf(zones, ".claude/settings.json"), "engine");
  assert.equal(zoneOf(zones, "outbox/tasks/x.md"), "handover");
  assert.equal(zoneOf(zones, "ops-manifest.json.123.abc.tmp"), "service");
  assert.equal(zoneOf(zones, "tools/.DS_Store"), "metadata");
  assert.equal(zoneOf(zones, "tools/cv-builder/node_modules/x"), "dependencies");
  assert.equal(zoneOf(zones, "candidate/profile.md"), "candidate");
  assert.equal(zoneOf(zones, "pqs_tags.json"), "engine");
  assert.equal(zoneOf(zones, ".rehearsal/batches/x"), "engine");
  assert.equal(zoneOf(zoneTableFor("rehearsal"), ".rehearsal/batches/x"), "state");
});

// ---------------------------------------------------------------------------------------------
// verify

test("verify refuses a modified, added, removed or retyped file of each digested zone, naming path and zone", (t) => {
  const cases = [
    [
      "modified engine",
      (root) => writeFileSync(join(root, "docs/guide.md"), "changed\n"),
      "engine_tree_drift",
      "modified engine docs/guide.md",
    ],
    [
      "added at the root",
      (root) => writeFileSync(join(root, "pqs_tags.json"), "{}\n"),
      "engine_tree_drift",
      "added engine pqs_tags.json",
    ],
    [
      "removed engine",
      (root) => rmSync(join(root, "README.md")),
      "engine_tree_drift",
      "removed engine README.md",
    ],
    [
      "exec bit",
      (root) => chmodSync(join(root, "tools/build.sh"), 0o644),
      "engine_tree_drift",
      "modified engine tools/build.sh",
    ],
    [
      "dependency",
      (root) =>
        writeFileSync(join(root, "tools/cv-builder/node_modules/fixture-dep/index.js"), "2\n"),
      "engine_tree_drift",
      "modified dependencies",
    ],
    [
      "candidate",
      (root) => writeFileSync(join(root, "candidate/profile.md"), "edited in place\n"),
      "candidate_snapshot_drift",
      "modified candidate candidate/profile.md",
    ],
    [
      "candidate added",
      (root) => writeFileSync(join(root, "candidate/extra.md"), "x\n"),
      "candidate_snapshot_drift",
      "added candidate candidate/extra.md",
    ],
  ];
  for (const [label, mutate, code, fragment] of cases) {
    const { root } = fixtureFolder(t);
    mutate(root);
    assert.throws(
      () => verifyFolder(root),
      (error) => {
        assert.equal(error.code, code, label);
        assert.match(
          error.message,
          new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          label,
        );
        assert.ok(Buffer.byteLength(error.message) <= 512, label);
        assert.equal(error.message.includes(root), false, `${label}: no absolute path`);
        return true;
      },
    );
  }
});

test("verify ignores the state, handover and service zones and .DS_Store, and fails closed without the manifest", (t) => {
  const { root } = fixtureFolder(t);
  mkdirSync(join(root, "outbox/tasks"), { recursive: true });
  writeFileSync(join(root, "outbox/tasks/draft.md"), "draft\n");
  writeFileSync(join(root, "triage-ledger.json"), "{}\n");
  mkdirSync(join(root, ".temp-docs"));
  writeFileSync(join(root, "tools/.DS_Store"), "x");
  writeFileSync(join(root, "records/letter-corrections/record-2.json"), "{}\n");
  assert.equal(verifyFolder(root).status, "clean");
  rmSync(join(root, MANIFEST_FILE_NAME));
  assertCode(() => verifyFolder(root), "ops_manifest_missing");
});

test("a tree without the marker is not an operational folder and is not checked", (t) => {
  const directory = scratch(t, "ops-tree-plain-");
  assert.deepEqual(verifyFolder(directory), { status: "not_operational" });
});

// ---------------------------------------------------------------------------------------------
// cutover

test("cutover replaces both zones, drops files the release left, keeps the state byte for byte", (t) => {
  const fixture = fixtureFolder(t);
  const { root } = fixture;
  const stateBefore = {
    ledger: readFileSync(join(root, "process-log.json"), "utf8"),
    local: readFileSync(join(root, ".claude/settings.local.json"), "utf8"),
    output: readFileSync(join(root, "output/example-labs-senior-sdet/cv.json"), "utf8"),
    research: readFileSync(join(root, "records/letter-corrections/record.json"), "utf8"),
  };
  nextRelease(fixture, "release-20260902", { "docs/guide.md": null, "docs/new.md": "new\n" });
  commitAndTag(
    fixture.candidateRepo,
    { "profile.md": "# Fixture profile v2\n" },
    "candidate-20260902",
  );

  const result = cutoverFolder(
    { candidate: "candidate-20260902", release: "release-20260902", root },
    context(),
  );
  assert.equal(result.status, "cut_over");
  assert.equal(existsSync(join(root, "docs/guide.md")), false);
  assert.equal(readFileSync(join(root, "docs/new.md"), "utf8"), "new\n");
  assert.equal(readFileSync(join(root, "candidate/profile.md"), "utf8"), "# Fixture profile v2\n");
  assert.deepEqual(
    {
      ledger: readFileSync(join(root, "process-log.json"), "utf8"),
      local: readFileSync(join(root, ".claude/settings.local.json"), "utf8"),
      output: readFileSync(join(root, "output/example-labs-senior-sdet/cv.json"), "utf8"),
      research: readFileSync(join(root, "records/letter-corrections/record.json"), "utf8"),
    },
    stateBefore,
  );
  const manifest = readManifest(root);
  assert.equal(manifest.engine.tag, "release-20260902");
  assert.equal(manifest.candidate.tag, "candidate-20260902");
  assert.equal(manifest.previous, result.stamp);
  assert.equal(verifyFolder(root).status, "clean");
  const retained = join(root, ".ops-tree/previous", result.stamp);
  assert.equal(readFileSync(join(retained, "docs/guide.md"), "utf8"), "guide\n");
  assert.equal(readManifest(retained).engine.tag, "release-20260901");
  assert.ok(existsSync(join(root, ".ops-tree/cutovers", `${result.stamp}.json`)));
  assert.equal(existsSync(join(root, ".ops-tree/journal.json")), false);
  assert.equal(existsSync(join(root, ".ops-tree/lock")), false);
  assert.deepEqual(readdirSync(join(root, ".ops-tree/staging")), []);
});

test("a pair the new engine refuses, or a ledger it cannot read, stops the cutover before any file moves", (t) => {
  for (const [label, control, code] of [
    [
      "pair",
      { ...PASSING, bootstrap: { code: "candidate_document_missing", exit: 1 } },
      "ops_tree_pair_check_failed",
    ],
    ["ledger", { ...PASSING, validate: { exit: 1, report: {} } }, "cutover_ledger_unreadable"],
  ]) {
    const fixture = fixtureFolder(t);
    nextRelease(fixture, "release-20260902", {
      [STUB_CONTROL]: `${JSON.stringify(control)}\n`,
      "docs/new.md": "new\n",
    });
    const before = treeSnapshot(fixture.root);
    assert.throws(
      () =>
        cutoverFolder(
          { candidate: "candidate-20260901", release: "release-20260902", root: fixture.root },
          context(),
        ),
      (error) => {
        assert.equal(error.code, code, label);
        return true;
      },
    );
    assert.deepEqual(treeSnapshot(fixture.root), before, label);
    assert.deepEqual(readdirSync(join(fixture.root, ".ops-tree/staging")), [], label);
  }
});

test("dry-run changes nothing and reports drift and the processes the swap would stop", (t) => {
  const fixture = fixtureFolder(t);
  const report = {
    processes: [
      {
        process_id: "proc_file_backed_001",
        output: { code: null },
        steps: [{ issues: ["published_inputs_stale"], name: "map_experience" }],
      },
    ],
  };
  nextRelease(fixture, "release-20260902", {
    [STUB_CONTROL]: `${JSON.stringify({ ...PASSING, validate: { exit: 2, report } })}\n`,
  });
  writeFileSync(join(fixture.root, "stray.txt"), "dropped by hand\n");
  const before = treeSnapshot(fixture.root);
  const result = cutoverFolder(
    {
      candidate: "candidate-20260901",
      dryRun: true,
      release: "release-20260902",
      root: fixture.root,
    },
    context(),
  );
  assert.equal(result.status, "dry_run");
  assert.deepEqual(result.drift, [{ kind: "added", path: "stray.txt", zone: "engine" }]);
  assert.ok(
    result.stopped_by_swap.some(
      (row) =>
        row.process_id === "proc_file_backed_001" &&
        row.issues.includes("map_experience:published_inputs_stale"),
    ),
  );
  assert.deepEqual(treeSnapshot(fixture.root), before);
});

test("gates: a young running step and a prepared publication of any age refuse; an old step is reported", (t) => {
  const running = (log) => {
    const step = createRunningPublicationStep();
    step.publication_transaction = null;
    log.processes[1].steps.generate_cv = step;
  };
  const prepared = (log) => {
    log.processes[1].steps.generate_cv = createRunningPublicationStep();
  };
  const cases = [
    { code: "cutover_step_running", ledger: running, now: "2026-07-23T12:00:00.000Z" },
    { code: null, ledger: running, now: "2026-09-24T12:00:00.000Z", stale: 1 },
    { code: "cutover_publication_prepared", ledger: prepared, now: "2026-09-24T12:00:00.000Z" },
  ];
  for (const scenario of cases) {
    const fixture = fixtureFolder(t);
    writeLedger(fixture.root, scenario.ledger);
    nextRelease(fixture, "release-20260902", { "docs/new.md": "new\n" });
    const input = {
      candidate: "candidate-20260901",
      release: "release-20260902",
      root: fixture.root,
    };
    const clock = context({ now: () => new Date(scenario.now) });
    if (scenario.code === null) {
      const result = cutoverFolder(input, clock);
      assert.equal(result.gates.stale.length, scenario.stale);
      continue;
    }
    const before = treeSnapshot(fixture.root);
    assertCode(() => cutoverFolder(input, clock), scenario.code);
    assert.deepEqual(treeSnapshot(fixture.root), before);
    const inputFile = writeOverride(fixture.root, "cutover", "the user accepted the open step");
    const result = cutoverFolder({ ...input, inputFile }, clock);
    assert.equal(result.status, "cut_over");
    assert.deepEqual(result.override, {
      lifted: [scenario.code],
      reason: "the user accepted the open step",
    });
    const evidence = JSON.parse(
      readFileSync(join(fixture.root, ".ops-tree/cutovers", `${result.stamp}.json`), "utf8"),
    );
    assert.equal(evidence.override.reason, "the user accepted the open step");
  }
});

test("a triage lock refuses the cutover", (t) => {
  const fixture = fixtureFolder(t);
  mkdirSync(join(fixture.root, "triage-ledger.json.lock"));
  nextRelease(fixture, "release-20260902", { "docs/new.md": "new\n" });
  assertCode(
    () =>
      cutoverFolder(
        { candidate: "candidate-20260901", release: "release-20260902", root: fixture.root },
        context(),
      ),
    "cutover_triage_locked",
  );
});

// ---------------------------------------------------------------------------------------------
// rollback, interruption and retention

test("rollback after a cutover restores the previous files and manifest, and can be undone itself", (t) => {
  const fixture = fixtureFolder(t);
  const { root } = fixture;
  const original = treeSnapshot(root);
  nextRelease(fixture, "release-20260902", { "docs/guide.md": null, "docs/new.md": "new\n" });
  cutoverFolder({ candidate: "candidate-20260901", release: "release-20260902", root }, context());
  const cutOver = treeSnapshot(root);

  const back = rollbackFolder(
    { root },
    context({ now: () => new Date("2026-09-24T13:00:00.000Z") }),
  );
  assert.equal(back.status, "rolled_back");
  assert.equal(readManifest(root).engine.tag, "release-20260901");
  assert.equal(verifyFolder(root).status, "clean");
  const restored = treeSnapshot(root);
  for (const [path, row] of Object.entries(original)) {
    if (path === MANIFEST_FILE_NAME || path.startsWith(".ops-tree/")) continue;
    assert.equal(restored[path], row, path);
  }
  assert.equal(existsSync(join(root, "docs/new.md")), false);

  const forward = rollbackFolder(
    { root },
    context({ now: () => new Date("2026-09-24T14:00:00.000Z") }),
  );
  assert.equal(forward.status, "rolled_back");
  assert.equal(readManifest(root).engine.tag, "release-20260902");
  for (const [path, row] of Object.entries(cutOver)) {
    if (path === MANIFEST_FILE_NAME || path.startsWith(".ops-tree/")) continue;
    assert.equal(treeSnapshot(root)[path], row, path);
  }
});

test("an exception in the middle of the swap is reversed by the same process", (t) => {
  const fixture = fixtureFolder(t);
  const { root } = fixture;
  nextRelease(fixture, "release-20260902", { "docs/new.md": "new\n" });
  const before = treeSnapshot(root);
  assert.throws(
    () =>
      cutoverFolder(
        { candidate: "candidate-20260901", release: "release-20260902", root },
        context({
          beforeRename: (index) => {
            if (index === 5) throw new Error("injected fault");
          },
        }),
      ),
    /injected fault/,
  );
  const after = treeSnapshot(root);
  for (const [path, row] of Object.entries(before)) {
    if (path.startsWith(".ops-tree/")) continue;
    assert.equal(after[path], row, path);
  }
  assert.equal(readManifest(root).state, "ready");
  assert.equal(verifyFolder(root).status, "clean");
  assert.equal(existsSync(join(root, ".ops-tree/journal.json")), false);
});

test("an interrupted rollback of a finished swap is reversed by the same process", (t) => {
  const fixture = fixtureFolder(t);
  const { root } = fixture;
  nextRelease(fixture, "release-20260902", { "docs/guide.md": null, "docs/new.md": "new\n" });
  const cut = cutoverFolder(
    { candidate: "candidate-20260901", release: "release-20260902", root },
    context(),
  );
  const before = treeSnapshot(root);
  assert.throws(
    () =>
      rollbackFolder(
        { root },
        context({
          beforeRename: (index) => {
            if (index === 5) throw new Error("injected fault");
          },
          now: () => new Date("2026-09-24T13:00:00.000Z"),
        }),
      ),
    /injected fault/,
  );
  assert.deepEqual(treeSnapshot(root), before);
  assert.equal(readManifest(root).engine.tag, "release-20260902");
  assert.equal(
    readManifest(join(root, ".ops-tree/previous", cut.stamp)).engine.tag,
    "release-20260901",
  );
  assert.equal(verifyFolder(root).status, "clean");
});

test("an image refused before the journal is written is deleted even if the release ships a state-shaped path", (t) => {
  const fixture = fixtureFolder(t);
  // The live zone table is given one more nested state path; a release whose own table does not
  // have it, and which ships a file there, is refused while the swap is planned — before any journal.
  const manifest = readManifest(fixture.root);
  manifest.zones.stateNested = [...manifest.zones.stateNested, "docs/runtime"];
  writeFileSync(join(fixture.root, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  mkdirSync(join(fixture.root, "docs/runtime"));
  writeFileSync(join(fixture.root, "docs/runtime/x"), "x\n");
  nextRelease(fixture, "release-20260902", { "docs/runtime/x": "shipped\n" });
  assertCode(
    () =>
      cutoverFolder(
        { candidate: "candidate-20260901", release: "release-20260902", root: fixture.root },
        context(),
      ),
    "ops_tree_image_overlaps_state",
  );
  assert.deepEqual(readdirSync(join(fixture.root, ".ops-tree/staging")), []);
  assert.deepEqual(readdirSync(join(fixture.root, ".ops-tree/previous")), []);
});

test("a cutover refuses a folder whose swap journal is still there", (t) => {
  const fixture = fixtureFolder(t);
  writeFileSync(join(fixture.root, ".ops-tree/journal.json"), "{}\n");
  nextRelease(fixture, "release-20260902", { "docs/new.md": "new\n" });
  assertCode(
    () =>
      cutoverFolder(
        { candidate: "candidate-20260901", release: "release-20260902", root: fixture.root },
        context(),
      ),
    "ops_tree_building",
  );
});

test("a reversal never deletes an image holding a state file the folder has replaced meanwhile", (t) => {
  const fixture = fixtureFolder(t);
  const { root } = fixture;
  nextRelease(fixture, "release-20260902", { "docs/new.md": "new\n" });
  assert.throws(
    () =>
      cutoverFolder(
        { candidate: "candidate-20260901", release: "release-20260902", root },
        context({
          beforeRename: (index, pair) => {
            if (pair.from !== ".claude") return;
            writeFileSync(join(root, ".claude/settings.local.json"), '{"written":"meanwhile"}\n');
            throw new Error("injected fault");
          },
        }),
      ),
    (error) => {
      assert.match(error.message, /injected fault/);
      assert.deepEqual(error.details.kept_image.holds, [".claude/settings.local.json"]);
      return true;
    },
  );
  const [image] = readdirSync(join(root, ".ops-tree/staging"));
  assert.equal(
    readFileSync(join(root, ".ops-tree/staging", image, ".claude/settings.local.json"), "utf8"),
    '{"local":true}\n',
    "the original stays in the kept image",
  );
  assert.equal(
    readFileSync(join(root, ".claude/settings.local.json"), "utf8"),
    '{"written":"meanwhile"}\n',
  );
  assert.equal(
    readFileSync(join(root, "records/letter-corrections/record.json"), "utf8"),
    '{"id":1}\n',
    "the corpus came back",
  );
  assertCode(
    () =>
      cutoverFolder(
        { candidate: "candidate-20260901", release: "release-20260902", root },
        context(),
      ),
    "ops_tree_staging_holds_state",
  );
});

test("after four cutovers three retained trees are kept, and a retained tree holding a stray file is never pruned", (t) => {
  const fixture = fixtureFolder(t);
  const { root } = fixture;
  const stamps = [];
  for (let day = 2; day <= 5; day += 1) {
    const tag = `release-2026090${day}`;
    nextRelease(fixture, tag, { [`docs/day-${day}.md`]: `${day}\n` });
    if (day === 2) writeFileSync(join(root, "stray.txt"), "kept by hand\n");
    const result = cutoverFolder(
      { candidate: "candidate-20260901", release: tag, root },
      context({ now: () => new Date(`2026-09-2${day}T12:00:00.000Z`) }),
    );
    stamps.push(result.stamp);
  }
  const retained = readdirSync(join(root, ".ops-tree/previous")).sort();
  assert.deepEqual(retained, stamps, "the oldest tree carries the stray file and is kept");
  assert.equal(
    readFileSync(join(root, ".ops-tree/previous", stamps[0], "stray.txt"), "utf8"),
    "kept by hand\n",
  );

  nextRelease(fixture, "release-20260906", { "docs/day-6.md": "6\n" });
  const sixth = cutoverFolder(
    { candidate: "candidate-20260901", release: "release-20260906", root },
    context({ now: () => new Date("2026-09-26T12:00:00.000Z") }),
  );
  assert.deepEqual(sixth.retained.removed, [stamps[1]]);
  assert.deepEqual(sixth.retained.kept_unmatched, [stamps[0]]);
});

test("the lock: a live holder refuses, an abandoned one is taken over by exactly one taker", (t) => {
  const { root } = fixtureFolder(t, { withState: false });
  const alive = {
    hostname: () => "fixture-host",
    now: () => new Date(),
    processAlive: () => true,
    bootTime: () => 0,
  };
  const first = acquireLock(alive, root);
  assertCode(() => acquireLock(alive, root), "ops_tree_locked");
  const dead = { ...alive, processAlive: () => false };
  const second = acquireLock(dead, root);
  assert.deepEqual(Object.keys(second.takeover).sort(), ["acquired_at", "pid"]);
  releaseLock(root, first);
  assert.equal(
    existsSync(join(root, ".ops-tree/lock")),
    true,
    "a stale token never releases the new holder",
  );
  releaseLock(root, second);
  assert.equal(existsSync(join(root, ".ops-tree/lock")), false);
  const stale = acquireLock(alive, root);
  let winner = null;
  const loser = {
    ...dead,
    beforeLockTakeover: () => {
      winner = acquireLock(dead, root);
    },
  };
  assertCode(() => acquireLock(loser, root), "ops_tree_locked");
  assert.equal(
    JSON.parse(readFileSync(join(root, ".ops-tree/lock"), "utf8")).token,
    winner.token,
    "the winner's lock is put back, not left aside",
  );
  assert.deepEqual(
    readdirSync(join(root, ".ops-tree")).filter((name) => name.startsWith("lock.stale-")),
    [],
  );
  releaseLock(root, stale);
  releaseLock(root, winner);
  const foreign = acquireLock({ ...alive, hostname: () => "other-host" }, root);
  assertCode(() => acquireLock(dead, root), "ops_tree_locked");
  releaseLock(root, foreign);
});

test("a staging leftover holding state other than the ledger copy refuses the next cutover", (t) => {
  const fixture = fixtureFolder(t);
  const leftover = join(fixture.root, ".ops-tree/staging/20260901T000000.000Z");
  mkdirSync(join(leftover, "records"), { recursive: true });
  writeFileSync(join(leftover, "records/record.json"), "{}\n");
  nextRelease(fixture, "release-20260902", { "docs/new.md": "new\n" });
  const input = {
    candidate: "candidate-20260901",
    release: "release-20260902",
    root: fixture.root,
  };
  assertCode(() => cutoverFolder(input, context()), "ops_tree_staging_holds_state");
  rmSync(join(leftover, "records"), { recursive: true });
  writeFileSync(join(leftover, "process-log.json"), "{}\n");
  writeFileSync(join(leftover, "process-log.json.lock.claim-1"), "x");
  assert.equal(cutoverFolder(input, context()).status, "cut_over");
  assert.equal(existsSync(leftover), false);
});

// ---------------------------------------------------------------------------------------------
// the real engine: recovery from a copy, signals, and the call points

let realEngineCache = null;

/** A repository holding the real engine tree, tagged twice, and a fictional private repository. */
function realEngineRepositories() {
  if (realEngineCache !== null) return realEngineCache;
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ops-tree-real-")));
  process.on("exit", () => rmSync(base, { force: true, recursive: true }));
  const engineRepo = join(base, "engine");
  mkdirSync(engineRepo);
  git(engineRepo, ["init", "-q"]);
  const listed = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: gitEnvironment(),
    },
  )
    .stdout.split("\0")
    .filter(Boolean);
  for (const path of listed) {
    const source = join(repoRoot, path);
    if (!existsSync(source) || !statSync(source).isFile()) continue;
    const target = join(engineRepo, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    chmodSync(target, statSync(source).mode & 0o777);
  }
  git(engineRepo, ["add", "-A"]);
  git(engineRepo, ["commit", "-q", "-m", "real engine"]);
  git(engineRepo, ["tag", "release-20260901"]);
  commitAndTag(engineRepo, { "docs/ops-tree-fixture.md": "second release\n" }, "release-20260902");
  const candidateRepo = join(base, "private");
  const example = {};
  const collect = (relative) => {
    for (const name of readdirSync(join(repoRoot, "candidate.example", relative))) {
      const entry = relative === "" ? name : `${relative}/${name}`;
      const path = join(repoRoot, "candidate.example", entry);
      if (statSync(path).isFile()) example[entry] = readFileSync(path, "utf8");
      else if (name === "languages" || relative.startsWith("languages")) collect(entry);
    }
  };
  collect("");
  makeRepository(
    candidateRepo,
    { ...example, "board/0001-task.md": "task\n" },
    "candidate-20260901",
  );
  realEngineCache = { base, candidateRepo, engineRepo };
  return realEngineCache;
}

function copyDependencies(directory) {
  cpSync(join(repoRoot, "tools/cv-builder/node_modules"), join(directory, "node_modules"), {
    recursive: true,
  });
}

function realFolder(t) {
  const { candidateRepo, engineRepo } = realEngineRepositories();
  const root = join(scratch(t, "ops-tree-real-folder-"), "folder");
  exportFolder(
    {
      candidate: "candidate-20260901",
      candidateRepo,
      engineRepo,
      release: "release-20260901",
      root,
    },
    context({ install: copyDependencies }),
  );
  return root;
}

/**
 * A child process that runs a cutover of the real folder and signals itself just before one
 * rename: `stopWhen` is `from:<entry>` (before the old entry moves out) or `to:<entry>` (before
 * the new one moves in).
 */
function interruptedCutover(t, root, { operation = "cutover", signal, stopWhen }) {
  const script = join(scratch(t, "ops-tree-child-"), "child.mjs");
  writeFileSync(
    script,
    `import { spawnSync } from "node:child_process";
import { cpSync } from "node:fs";
import { join } from "node:path";
const { cutoverFolder, rollbackFolder } = await import(${JSON.stringify(treeModuleUrl)});
const [root, dependencies, signal, stopWhen, operation] = process.argv.slice(2);
const spawn = (command, args, options) => command === process.execPath
  ? { status: 0, stdout: "{}", stderr: "" }
  : spawnSync(command, args, options);
const hooks = {
  install: (directory) => cpSync(dependencies, join(directory, "node_modules"), { recursive: true }),
  spawn,
  beforeRename: (index, pair) => {
    const [side, name] = stopWhen.split(":");
    if (pair[side] === name) process.kill(process.pid, signal);
  },
};
if (operation === "rollback") rollbackFolder({ root }, hooks);
else cutoverFolder({ candidate: "candidate-20260901", release: "release-20260902", root }, hooks);
process.stdout.write("finished");
`,
  );
  return spawnSync(
    process.execPath,
    [script, root, join(repoRoot, "tools/cv-builder/node_modules"), signal, stopWhen, operation],
    { encoding: "utf8", env: gitEnvironment() },
  );
}

function runCli(cli, args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: gitEnvironment() });
}

test("a cutover killed while the root has no tools/ is recovered by the retained copy's rollback", (t) => {
  const root = realFolder(t);
  const before = treeSnapshot(root);
  const child = interruptedCutover(t, root, { signal: "SIGKILL", stopWhen: "to:tools" });
  assert.equal(child.signal, "SIGKILL");
  assert.equal(existsSync(join(root, "tools")), false, "the kill landed between tools/ out and in");
  assert.equal(existsSync(join(root, ".ops-tree/lock")), true, "the dead run left its lock");
  const journal = JSON.parse(readFileSync(join(root, ".ops-tree/journal.json"), "utf8"));
  const copy = join(root, ".ops-tree/previous", journal.stamp, "tools/ops-tree/cli.mjs");

  const wrong = runCli(join(root, ".ops-tree/previous", journal.stamp, "tools/ops-tree/cli.mjs"), [
    "verify",
  ]);
  assert.equal(JSON.parse(wrong.stderr).error.code, "ops_tree_recovery_refused");
  const recovered = runCli(copy, ["rollback"]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).status, "recovered");
  const after = treeSnapshot(root);
  for (const [path, row] of Object.entries(before)) {
    if (path.startsWith(".ops-tree/")) continue;
    assert.equal(after[path], row, path);
  }
  assert.equal(verifyFolder(root).status, "clean");
  assert.equal(existsSync(join(root, ".ops-tree/lock")), false);
});

test("a cutover killed with tools/ still in place is recovered by the folder's own rollback; state survives", (t) => {
  const root = realFolder(t);
  mkdirSync(join(root, "records"), { recursive: true });
  writeFileSync(join(root, "records/record.json"), '{"kept":true}\n');
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude/settings.local.json"), '{"local":true}\n');
  const before = treeSnapshot(root);
  const child = interruptedCutover(t, root, { signal: "SIGKILL", stopWhen: "from:.github" });
  assert.equal(child.signal, "SIGKILL");
  assert.equal(
    existsSync(join(root, "records/record.json")),
    true,
    "state stays in the root during the swap",
  );
  assertCode(() => verifyFolder(root), "ops_tree_building");

  const recovered = runCli(join(root, "tools/ops-tree/cli.mjs"), ["rollback"]);
  assert.equal(recovered.status, 0, recovered.stderr);
  const after = treeSnapshot(root);
  for (const [path, row] of Object.entries(before)) {
    if (path.startsWith(".ops-tree/")) continue;
    assert.equal(after[path], row, path);
  }
  assert.equal(readFileSync(join(root, "records/record.json"), "utf8"), '{"kept":true}\n');
  assert.equal(verifyFolder(root).status, "clean");
});

test("a rollback killed while the root has no tools/ is recovered by the copy its journal names", (t) => {
  const root = realFolder(t);
  cutoverFolder(
    { candidate: "candidate-20260901", release: "release-20260902", root },
    context({
      install: copyDependencies,
      spawn: (command, args, options) =>
        command === process.execPath
          ? { status: 0, stderr: "", stdout: "{}" }
          : spawnSync(command, args, options),
    }),
  );
  const before = treeSnapshot(root);
  const child = interruptedCutover(t, root, {
    operation: "rollback",
    signal: "SIGKILL",
    stopWhen: "to:tools",
  });
  assert.equal(child.signal, "SIGKILL");
  assert.equal(existsSync(join(root, "tools")), false);
  const journal = JSON.parse(readFileSync(join(root, ".ops-tree/journal.json"), "utf8"));
  assert.equal(journal.operation, "rollback");
  const recovered = runCli(
    join(root, ".ops-tree/previous", journal.stamp, "tools/ops-tree/cli.mjs"),
    ["rollback"],
  );
  assert.equal(recovered.status, 0, recovered.stderr);
  const after = treeSnapshot(root);
  for (const [path, row] of Object.entries(before)) {
    if (path.startsWith(".ops-tree/lock")) continue;
    assert.equal(after[path], row, path);
  }
  assert.equal(readManifest(root).engine.tag, "release-20260902");
  assert.equal(verifyFolder(root).status, "clean");
});

test("SIGTERM in the middle of the swap leaves a whole folder", (t) => {
  const root = realFolder(t);
  const child = interruptedCutover(t, root, { signal: "SIGTERM", stopWhen: "from:instructions" });
  assert.notEqual(child.signal, "SIGKILL");
  assert.equal(existsSync(join(root, ".ops-tree/journal.json")), false);
  assert.equal(verifyFolder(root).status, "clean");
  assert.equal(readManifest(root).engine.tag, "release-20260902");
});

test("the call points: process-log refuses on drift except validate, and preflight refuses before its toolchain", (t) => {
  const root = realFolder(t);
  writeFileSync(join(root, "process-log.json"), `${JSON.stringify(createValidV3Log(), null, 2)}\n`);
  mkdirSync(join(root, "output"));
  const processLog = join(root, "tools/process-log.mjs");
  const clean = runCli(processLog, ["validate"]);
  assert.equal(clean.status, 0, clean.stderr);

  writeFileSync(join(root, "knowledge/precedence.md"), "edited in the operational folder\n");
  const ledgerBefore = readFileSync(join(root, "process-log.json"), "utf8");
  const refused = runCli(processLog, [
    "start",
    "--source-ref",
    "synthetic:drift",
    "--runner",
    "codex",
  ]);
  assert.equal(refused.status, 1);
  const error = JSON.parse(refused.stderr).error;
  assert.equal(error.code, "engine_tree_drift");
  assert.match(error.message, /modified engine knowledge\/precedence\.md/);
  assert.equal(readFileSync(join(root, "process-log.json"), "utf8"), ledgerBefore);
  assert.equal(runCli(processLog, ["validate"]).status, 0, "validate still reads");

  const preflight = runCli(join(root, "tools/bootstrap.mjs"), ["--check"]);
  assert.equal(preflight.status, 1);
  assert.equal(JSON.parse(preflight.stderr).error.code, "engine_tree_drift");
});

test("the call points: the triage batch and the Telegram sweep refuse a drifted folder before their first write", async (t) => {
  const root = realFolder(t);
  const core = await import(pathToFileURL(join(root, "tools/lib/triage-ledger-core.mjs")).href);
  const collector = join(root, "tools/telegram-collect/cli.mjs");
  const ledgerPath = join(root, "triage-ledger.json");
  const lockPath = `${ledgerPath}.lock`;
  const outDir = join(root, "telegram-sweeps", "2026-09-27-1");
  const link = "https://boards.greenhouse.io/acme/jobs/7";
  const batch = {
    batch_id: "drift-check",
    observed_at: "2026-09-27T10:00:00Z",
    entries: [
      { url: link, status: "open", decision: "MANUAL_REVIEW", flags: ["work_format_unknown"] },
    ],
  };
  core.initLedger(ledgerPath);
  const collectorCode = (command) => {
    const run = runCli(collector, [command, "--out-dir", outDir]);
    assert.equal(run.status, 1, run.stdout);
    return JSON.parse(run.stdout).code;
  };
  const errorCode = (operate) => {
    try {
      operate();
    } catch (error) {
      assert.equal(error instanceof core.TriageLedgerError, true, String(error));
      return error.code;
    }
    return null;
  };
  // A clean folder passes the check: each call goes on to its own next refusal or result.
  const passes = () => {
    assert.equal(
      core.planBatch(core.readLedger(ledgerPath), [link], { asOf: batch.observed_at }).links_in,
      1,
    );
    assert.equal(
      core.recordBatch(ledgerPath, batch, { artifactsDir: null }).batch_id,
      "drift-check",
    );
    assert.equal(collectorCode("sweep"), "config_missing");
    assert.equal(collectorCode("finalize"), "stage_missing");
  };
  passes();

  for (const [path, code] of [
    ["knowledge/precedence.md", "engine_tree_drift"],
    ["candidate/profile.md", "candidate_snapshot_drift"],
  ]) {
    const original = readFileSync(join(root, path));
    writeFileSync(join(root, path), "edited in the operational folder\n");
    const ledger = core.readLedger(ledgerPath);
    const ledgerBefore = readFileSync(ledgerPath, "utf8");
    // A held lock proves the order: a check behind the lock would wait on it and answer
    // triage_ledger_locked, and the lock would not be the one this test made.
    mkdirSync(lockPath);
    assert.equal(
      errorCode(() => core.planBatch(ledger, [link], { asOf: batch.observed_at })),
      code,
      path,
    );
    assert.equal(
      errorCode(() => core.recordBatch(ledgerPath, batch, { artifactsDir: null })),
      code,
      path,
    );
    assert.equal(existsSync(lockPath), true);
    rmSync(lockPath, { recursive: true });
    assert.equal(readFileSync(ledgerPath, "utf8"), ledgerBefore, path);
    assert.equal(collectorCode("sweep"), code, path);
    assert.equal(collectorCode("finalize"), code, path);
    assert.equal(existsSync(outDir), false, path);
    writeFileSync(join(root, path), original);
  }
  passes();
});

test("new folders have no mutable private research exception; historical tables retain it", () => {
  const zones = zoneTableFor("operational");
  assert.equal(zoneOf(zones, "candidate/research/note.md"), "candidate");
  const historical = { ...zones, stateNested: [...zones.stateNested, "candidate/research"] };
  assert.equal(zoneOf(historical, "candidate/research/note.md"), "state");
});

test("historical manifest zones survive verification and rollback; residual research requires removal", (t) => {
  const fixture = fixtureFolder(t, { withState: false });
  const { root } = fixture;
  const marker = readManifest(root);
  marker.zones.stateNested.push("candidate/research");
  writeFileSync(join(root, "ops-manifest.json"), `${JSON.stringify(marker, null, 2)}\n`);
  mkdirSync(join(root, "candidate/research"), { recursive: true });
  writeFileSync(join(root, "candidate/research/note.md"), "historical state\n");
  assert.equal(verifyFolder(root).status, "clean");
  nextRelease(fixture, "release-20260902", { "docs/new.md": "new\n" });
  cutoverFolder({ candidate: "candidate-20260901", release: "release-20260902", root }, context());
  assert.equal(
    readFileSync(join(root, "candidate/research/note.md"), "utf8"),
    "historical state\n",
  );
  assertCode(() => verifyFolder(root), "candidate_snapshot_drift");
  rollbackFolder({ root }, context({ now: () => new Date("2026-09-25T12:00:00.000Z") }));
  assert.equal(zoneOf(readManifest(root).zones, "candidate/research/note.md"), "state");
  assert.equal(verifyFolder(root).status, "clean");
});
