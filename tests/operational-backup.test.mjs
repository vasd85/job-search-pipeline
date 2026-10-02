// The tool under test copies the checkout it lives in, which is what every fixture here has to
// reproduce: a `mkdtemp` directory shaped like a primary worktree — a real `.git` **directory**,
// the ledgers, and for the child-process cases a copy of `tools/` so the entry really sits at
// `<fixture>/tools/operational-backup.mjs`. No case reads this repository's own
// `process-log.json`, `triage-ledger.json` or `output/`.
//
// Why the copy rather than something lighter: there is no argument and no environment variable
// that redirects the tool, by design, so a child process can only be aimed by *where the file it
// runs lives*. A symlinked entry would not do it either — the tool resolves its own realpath, so
// a link into a fixture would derive this repository as the root. The copy is about 1.4 MB
// (`tools/` without `cv-builder/`), and only the cases that must observe the exit code and the
// bounded JSON on stderr pay for it; the rest take an injected root in process.
//
// What the cases assert is the pair of promises the task filed. First, a snapshot is either
// consistent or refused: the lock cases hold the very locks the pipeline's writers take and
// prove the backup refuses instead of copying a torn file, and the topology cases prove a linked
// worktree is refused even when it holds a perfectly good ledger. Second, the rotation can only
// reach what the tool wrote: the retention case surrounds the snapshots with foreign directories,
// a foreign file and a look-alike directory carrying no manifest, and proves all of them survive.

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
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DEFAULT_KEEP,
  LAUNCH_AGENT_LABEL,
  MANIFEST_FILE_NAME,
  MANIFEST_SCHEMA,
  MANIFEST_SCHEMA_VERSION,
  MEMBERS,
  ownedSnapshots,
  runOperationalBackup,
  stampOf,
} from "../tools/operational-backup.mjs";
import { zoneTableFor } from "../tools/ops-tree/manifest.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toolPath = join(repoRoot, "tools", "operational-backup.mjs");

/**
 * The members and their locks, frozen independently of the module. A member silently moved to
 * the other lock would still copy the file while losing the consistency the pairing buys; one
 * silently dropped would stop being backed up with nothing to say so.
 */
const PINNED_MEMBERS = [
  ["process-log.json", "process-log"],
  ["output", "process-log"],
  ["triage-ledger.json", "triage-ledger"],
  ["triage-batches", "triage-ledger"],
  ["telegram-sources.json", "none"],
  ["telegram-sweep-state.json", "none"],
  ["records", "none"],
  ["outbox", "none"],
  ["candidate/research", "none"],
  ["ops-manifest.json", "none"],
];

/** The members no lock covers, as a fixture writes them; the sources file starts with a BOM. */
const UNLOCKED_FILES = {
  "telegram-sources.json": '\uFEFF{"sources":[]}\n',
  "telegram-sweep-state.json": '{"channels":{}}\n',
  "records/letter-corrections/records/lc_000000000001.json": '{"id":"lc_000000000001"}\n',
  "outbox/tasks/fix-a-thing.md": "# Draft\n",
  "candidate/research/publication-markers.json": '{"markers":[]}\n',
};

function writeUnlockedMembers(source) {
  for (const [path, text] of Object.entries(UNLOCKED_FILES)) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), text);
  }
  // Present in the source and deliberately not a member: the triage ledger already holds its
  // addresses, and its page captures would outgrow the entry bound.
  mkdirSync(join(source, "telegram-sweeps", "2026-09-24-1"), { recursive: true });
  writeFileSync(join(source, "telegram-sweeps", "2026-09-24-1", "001.page.html"), "<html></html>\n");
}

function emptyProcessLog() {
  return `${JSON.stringify({
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: "2026-09-01T09:00:00Z",
    companies: [],
    processes: [],
  }, null, 2)}\n`;
}

function emptyTriageLedger() {
  return `${JSON.stringify({ schema_version: 1, batches: [], entries: [] }, null, 2)}\n`;
}

/**
 * A checkout with one published artifact, one staging directory beside it, one recorded batch and
 * one batch still being built. `members` selects which of the four are present, so the cases that
 * exercise today's operational shape — no batch store until the next cutover — build exactly it.
 *
 * `linked` builds the other topology: a `.git` **file** holding a `gitdir:` pointer, which is what
 * every worktree in this repository except the operational one looks like.
 */
function makeSource(root, {
  ledger = true,
  store = true,
  output = true,
  linked = false,
  folder = null,
  processLog = true,
} = {}) {
  const source = join(root, "checkout");
  mkdirSync(source, { recursive: true });
  if (folder !== null) {
    writeOperationalManifest(source, folder);
  } else if (linked) {
    writeFileSync(join(source, ".git"), `gitdir: ${join(root, "common", "worktrees", "t")}\n`);
  } else {
    mkdirSync(join(source, ".git"));
  }
  if (processLog) writeFileSync(join(source, "process-log.json"), emptyProcessLog());
  if (ledger) writeFileSync(join(source, "triage-ledger.json"), emptyTriageLedger());
  if (output) {
    const role = join(source, "output", "acme-sdet");
    mkdirSync(join(role, ".pipeline-tmp", "publication_1"), { recursive: true });
    writeFileSync(join(role, "cv.json"), '{"published":true}\n');
    writeFileSync(join(role, "cover-letter.md"), "Dear team\n");
    writeFileSync(join(role, ".pipeline-tmp", "publication_1", "cv.json"), '{"staged":true}\n');
  }
  if (store) {
    const recorded = join(source, "triage-batches", "2026-09-01-linkedin-1");
    mkdirSync(join(recorded, "inputs"), { recursive: true });
    writeFileSync(join(recorded, "ledger-record.json"), '{"schema_version":1}\n');
    writeFileSync(join(recorded, "inputs", "001.input.json"), "{}\n");
    const building = join(source, "triage-batches", "2026-09-02-linkedin-1");
    mkdirSync(building, { recursive: true });
    writeFileSync(join(building, "capture.html"), "<html></html>\n");
  }
  return source;
}

/**
 * The marker of an operational folder built by `tools/ops-tree/`: no `.git` anywhere, a manifest
 * of the given kind and swap state. The backup reads only the kind and the state.
 */
function writeOperationalManifest(source, { kind = "operational", state = "ready" } = {}) {
  const pin = (tag) => ({ commit: "a".repeat(40), repository: "/fixture/repository", tag, tree: "b".repeat(40) });
  writeFileSync(join(source, "ops-manifest.json"), `${JSON.stringify({
    schema: "job-search-pipeline/ops-manifest",
    schema_version: 1,
    kind,
    state,
    built_at: "2026-09-24T12:00:00.000Z",
    previous: null,
    engine: pin("release-20260924"),
    candidate: pin("candidate-20260924"),
    zones: zoneTableFor(kind),
    files: { candidate: {}, dependencies: {}, engine: {} },
  }, null, 2)}\n`);
}

function makeRoot(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "job-search-backup-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

/**
 * Makes a fixture runnable as a child process by giving it its own copy of the tool at the path
 * the derivation expects. `cv-builder` is excluded — 10 of the 12 MB, and nothing the entry
 * imports — while `lib/` and `job-sources/` travel with it because the two ledger cores do.
 */
function makeRunnableCheckout(source) {
  cpSync(join(repoRoot, "tools"), join(source, "tools"), {
    filter: (from) => !from.startsWith(join(repoRoot, "tools", "cv-builder")),
    recursive: true,
  });
  return join(source, "tools", "operational-backup.mjs");
}

/**
 * Runs the tool the way launchd will: as a child, by absolute path, with a working directory that
 * has nothing to do with the tree being copied. `entry` decides which checkout is backed up, and
 * it is the only thing that can.
 */
function runTool(entry, argv) {
  return spawnSync(process.execPath, [entry, ...argv], {
    cwd: realpathSync(tmpdir()),
    encoding: "utf8",
  });
}

/** In-process, with the root injected where a child process would derive it. */
function runIn(source, argv) {
  return runOperationalBackup(argv, { root: source });
}

function errorOf(child) {
  return JSON.parse(child.stderr).error;
}

function memberStatus(result, id) {
  return result.members.find((member) => member.member === id);
}

test("the member table pairs each store with the lock its writers take", () => {
  assert.deepEqual(MEMBERS.map((member) => [member.id, member.lock]), PINNED_MEMBERS);
  assert.deepEqual(
    MEMBERS.filter((member) => member.required).map((member) => member.id),
    ["process-log.json"],
  );
  assert.equal(DEFAULT_KEEP, 7);
});

test("a snapshot copies the four members, excludes staging and skips an unrecorded batch", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root);
  const dest = join(root, "backups");

  const result = runIn(source, [
    "run", "--dest", dest, "--now", "2026-09-01T11:00:00Z",
  ]);

  assert.equal(result.status, "backed_up");
  assert.equal(result.stamp, "20260901T110000Z");
  const snapshot = join(realpathSync(dest), "20260901T110000Z");
  assert.equal(result.snapshot, snapshot);

  assert.equal(readFileSync(join(snapshot, "process-log.json"), "utf8"), emptyProcessLog());
  assert.equal(readFileSync(join(snapshot, "triage-ledger.json"), "utf8"), emptyTriageLedger());
  assert.equal(
    readFileSync(join(snapshot, "output", "acme-sdet", "cv.json"), "utf8"),
    '{"published":true}\n',
  );

  // The published artifact came across; the staging directory beside it did not. Staging has
  // writers that hold no log lock, so a copy of it would be the one part of the snapshot the
  // lock does not make consistent.
  assert.equal(existsSync(join(snapshot, "output", "acme-sdet", ".pipeline-tmp")), false);
  assert.deepEqual(memberStatus(result, "output").excluded_paths, ["acme-sdet/.pipeline-tmp"]);

  // A batch with its record is history and is copied; one still being built is named, not copied.
  assert.equal(
    existsSync(join(snapshot, "triage-batches", "2026-09-01-linkedin-1", "ledger-record.json")),
    true,
  );
  assert.equal(existsSync(join(snapshot, "triage-batches", "2026-09-02-linkedin-1")), false);
  assert.deepEqual(
    memberStatus(result, "triage-batches").skipped_batches,
    ["2026-09-02-linkedin-1"],
  );

  const manifest = JSON.parse(readFileSync(join(snapshot, MANIFEST_FILE_NAME), "utf8"));
  assert.equal(manifest.schema, MANIFEST_SCHEMA);
  assert.equal(manifest.schema_version, MANIFEST_SCHEMA_VERSION);
  assert.equal(manifest.created_at, "2026-09-01T11:00:00.000Z");
  assert.deepEqual(manifest.excluded, [".pipeline-tmp"]);
  assert.equal(
    manifest.files.some((entry) => entry.path.includes(".pipeline-tmp")),
    false,
  );
  assert.equal(
    runIn(source, ["verify", "--backup", snapshot, "--now", "2026-09-01T11:05:00Z"]).ok,
    true,
  );
});

test("the tree copied is the tree the running file lives in, whatever the working directory", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root);
  const entry = makeRunnableCheckout(source);
  const dest = join(root, "backups");

  // Run from the system temp directory, by absolute path, with no flag naming a checkout — the
  // shape of a scheduled job. The only thing pointing at the fixture is where `entry` lives.
  const child = runTool(entry, ["run", "--dest", dest, "--now", "2026-09-01T11:00:00Z"]);

  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.status, "backed_up");
  assert.equal(report.source, realpathSync(source));
  assert.equal(
    readFileSync(join(realpathSync(dest), "20260901T110000Z", "process-log.json"), "utf8"),
    emptyProcessLog(),
  );
});

test("a linked worktree is refused even when it holds a perfectly good ledger", (t) => {
  const root = makeRoot(t);
  // The measured defect this task exists for: before it, a tree was accepted on the strength of
  // holding a ledger, and a rehearsal worktree legitimately holds one (docs/runbooks/rehearsal-worktree.md#rehearsal-worktree).
  const source = makeSource(root, { linked: true });
  const entry = makeRunnableCheckout(source);
  const dest = join(root, "backups");

  const child = runTool(entry, ["run", "--dest", dest]);

  assert.equal(child.status, 1);
  assert.equal(errorOf(child).code, "backup_root_unmarked");
  assert.equal(existsSync(join(source, "process-log.json")), true);
  // Refused before anything is created: the destination is not even brought into existence.
  assert.equal(existsSync(dest), false);
});

test("an operational folder without .git is taken by its marker, a swap still building included", (t) => {
  for (const state of ["ready", "building"]) {
    const root = makeRoot(t);
    const source = makeSource(root, { folder: { state } });
    const result = runIn(source, ["run", "--dest", join(root, "backups"), "--now", "2026-09-24T11:00:00Z"]);
    assert.equal(result.status, "backed_up", state);
    assert.deepEqual(result.operational_folder, { kind: "operational", state }, state);
    assert.equal(existsSync(join(result.snapshot, "process-log.json")), true, state);
  }
});

test("a rehearsal folder and an unreadable marker are refused, each with its own code", (t) => {
  const cases = [
    ["rehearsal", (source) => writeOperationalManifest(source, { kind: "rehearsal" }), "backup_root_rehearsal"],
    ["broken manifest", (source) => writeFileSync(join(source, "ops-manifest.json"), "{ not json\n"), "backup_root_manifest_invalid"],
    ["service directory without a manifest", (source) => mkdirSync(join(source, ".ops-tree")), "backup_root_manifest_invalid"],
  ];
  for (const [label, mark, code] of cases) {
    const root = makeRoot(t);
    const source = makeSource(root, { folder: {} });
    rmSync(join(source, "ops-manifest.json"));
    mark(source);
    const dest = join(root, "backups");
    assert.throws(() => runIn(source, ["run", "--dest", dest]), (error) => {
      assert.equal(error.code, code, label);
      return true;
    });
    assert.equal(existsSync(dest), false, label);
  }
});

test("an operational folder without .git backs up when run as the scheduled job runs it", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root, { folder: {} });
  const entry = makeRunnableCheckout(source);
  const dest = join(root, "backups");

  const child = runTool(entry, ["run", "--dest", dest, "--now", "2026-09-24T11:00:00Z"]);

  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.source_identity, "marker");
  assert.equal(existsSync(join(source, ".git")), false);
  assert.equal(
    readFileSync(join(report.snapshot, "ops-manifest.json"), "utf8"),
    readFileSync(join(source, "ops-manifest.json"), "utf8"),
  );
  assert.equal(runTool(entry, ["verify", "--backup", report.snapshot]).status, 0);
});

test("the marker decides the source; without one only the primary worktree passes, for now", (t) => {
  const cases = [
    ["primary worktree without a marker", (source) => source, "primary-worktree"],
    ["primary worktree with an operational marker", (source) => writeOperationalManifest(source), "marker"],
  ];
  for (const [label, mark, identity] of cases) {
    const root = makeRoot(t);
    const source = makeSource(root);
    mark(source);
    const result = runIn(source, ["run", "--dest", join(root, "backups"), "--now", "2026-09-24T11:00:00Z"]);
    assert.equal(result.source_identity, identity, label);
  }

  const refusals = [
    ["primary worktree with a rehearsal marker", (source) => writeOperationalManifest(source, { kind: "rehearsal" }), "backup_root_rehearsal"],
    ["directory with neither a marker nor .git", (source) => rmSync(join(source, ".git"), { recursive: true }), "backup_root_unmarked"],
  ];
  for (const [label, mark, code] of refusals) {
    const root = makeRoot(t);
    const source = makeSource(root);
    mark(source);
    const dest = join(root, "backups");
    assert.throws(() => runIn(source, ["run", "--dest", dest]), (error) => {
      assert.equal(error.code, code, label);
      return true;
    });
    assert.equal(existsSync(dest), false, label);
  }
});

test("no argument can redirect the copy to another tree", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root);
  const entry = makeRunnableCheckout(source);
  const elsewhere = makeSource(makeRoot(t));

  const child = runTool(entry, [
    "run", "--source", elsewhere, "--dest", join(root, "backups"),
  ]);

  assert.equal(child.status, 1);
  assert.match(errorOf(child).message, /Unknown option\(s\): --source/);
});

test("a checkout carrying no operational ledger is refused, and nothing is written", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root, { ledger: false, output: false, processLog: false, store: false });
  const entry = makeRunnableCheckout(source);
  const dest = join(root, "backups");

  const child = runTool(entry, ["run", "--dest", dest]);

  assert.equal(child.status, 1);
  assert.equal(errorOf(child).code, "backup_root_not_operational");
  assert.equal(existsSync(dest), false);
});

test("a held triage ledger lock refuses the snapshot instead of copying a torn ledger", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root);
  const entry = makeRunnableCheckout(source);
  const dest = join(root, "backups");
  // The ledger's own lock protocol is an exclusive `mkdir`; holding it is what a mid-write
  // `/score-jobs` looks like from outside.
  mkdirSync(join(source, "triage-ledger.json.lock"));

  const child = runTool(entry, ["run", "--dest", dest]);

  assert.equal(child.status, 1);
  assert.equal(errorOf(child).code, "triage_ledger_locked");
  assert.deepEqual(readdirSync(dest), []);
});

test("a held process log lock refuses the snapshot once its wait expires", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root);
  const entry = makeRunnableCheckout(source);
  const dest = join(root, "backups");
  // The process log's lock is a directory holding one owner record, and its writers recover a
  // stale one after 30s. A fresh record with a live pid is therefore held, not abandoned.
  const lock = join(source, "process-log.json.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, `${"a".repeat(32)}.json`), `${JSON.stringify({
    lock_version: 1,
    pid: process.pid,
    owner_token: "a".repeat(32),
    acquired_at: new Date().toISOString(),
  })}\n`);

  const child = runTool(entry, [
    "run", "--dest", dest, "--lock-timeout-ms", "150",
  ]);

  assert.equal(child.status, 1);
  assert.equal(errorOf(child).code, "process_log_lock_timeout");
  assert.deepEqual(readdirSync(dest), []);
});

test("an unreadable ledger refuses the snapshot rather than archiving it", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root);
  const entry = makeRunnableCheckout(source);
  const dest = join(root, "backups");
  writeFileSync(join(source, "triage-ledger.json"), "{ this is not a ledger\n");

  const child = runTool(entry, ["run", "--dest", dest]);

  assert.equal(child.status, 1);
  assert.equal(errorOf(child).code, "triage_ledger_unreadable");
  // Refusing before rotation is the point: a corrupt day must not age out a good copy.
  assert.deepEqual(readdirSync(dest), []);
});

test("absent members are recorded as absent, which is today's operational shape", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root, { ledger: false, output: false, store: false });
  const dest = join(root, "backups");

  const result = runIn(source, [
    "run", "--dest", dest, "--now", "2026-09-01T11:00:00Z",
  ]);

  assert.equal(result.status, "backed_up");
  assert.equal(memberStatus(result, "process-log.json").status, "copied");
  for (const [id] of PINNED_MEMBERS.slice(1)) {
    assert.equal(memberStatus(result, id).status, "absent", id);
  }
  assert.equal(runIn(source, ["verify", "--backup", result.snapshot]).ok, true);
});

test("the members no lock covers are copied, recorded and verified like the rest", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root, { folder: {} });
  writeUnlockedMembers(source);
  const dest = join(root, "backups");

  const result = runIn(source, ["run", "--dest", dest, "--now", "2026-09-24T11:00:00Z"]);

  assert.equal(result.status, "backed_up");
  for (const [id, lock] of PINNED_MEMBERS.slice(4)) {
    assert.deepEqual(
      [memberStatus(result, id).status, memberStatus(result, id).lock],
      ["copied", lock],
      id,
    );
  }
  for (const [path, text] of Object.entries(UNLOCKED_FILES)) {
    assert.equal(readFileSync(join(result.snapshot, path), "utf8"), text, path);
  }
  assert.equal(existsSync(join(result.snapshot, "telegram-sweeps")), false);
  assert.equal(runIn(source, ["verify", "--backup", result.snapshot]).ok, true);

  // Each new member is in the snapshot's own manifest, so a change to any of them is named.
  const tampered = [...Object.keys(UNLOCKED_FILES), "ops-manifest.json"];
  for (const path of tampered) writeFileSync(join(result.snapshot, path), "changed\n");
  const verdict = runIn(source, ["verify", "--backup", result.snapshot]);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.mismatched.sort(), tampered.sort());
});

test("a JSON member that does not parse refuses the snapshot and leaves the older one alone", (t) => {
  for (const id of ["telegram-sources.json", "telegram-sweep-state.json"]) {
    const root = makeRoot(t);
    const source = makeSource(root);
    writeUnlockedMembers(source);
    const dest = join(root, "backups");
    const older = runIn(source, ["run", "--dest", dest, "--now", "2026-09-23T11:00:00Z"]);
    writeFileSync(join(source, id), "{ half a file");

    // The two locked phases have already copied by the time this member is read: the refusal
    // has to take their work down with it, and rotation must not run.
    assert.throws(
      () => runIn(source, ["run", "--dest", dest, "--now", "2026-09-24T11:00:00Z", "--keep", "1"]),
      (error) => {
        assert.equal(error.code, "backup_member_unreadable", id);
        assert.match(error.message, new RegExp(id.replace(".", "\\.")));
        return true;
      },
    );
    assert.deepEqual(readdirSync(realpathSync(dest)), [older.stamp], id);
    assert.equal(runIn(source, ["verify", "--backup", older.snapshot]).ok, true, id);
  }
});

test("a member of the wrong kind refuses before any of it is copied", (t) => {
  const cases = [
    ["records as a file", (source) => writeFileSync(join(source, "records"), "not a directory\n")],
    ["telegram-sources.json as a directory", (source) => mkdirSync(join(source, "telegram-sources.json"))],
    ["outbox as a link", (source) => {
      mkdirSync(join(source, "elsewhere"));
      symlinkSync(join(source, "elsewhere"), join(source, "outbox"));
    }],
  ];
  for (const [label, mark] of cases) {
    const root = makeRoot(t);
    const source = makeSource(root);
    mark(source);
    const dest = join(root, "backups");
    assert.throws(() => runIn(source, ["run", "--dest", dest]), (error) => {
      assert.equal(error.code, "backup_unsupported_entry", label);
      return true;
    });
    assert.deepEqual(readdirSync(realpathSync(dest)), [], label);
  }
});

test("a batch store without its ledger is skipped whole rather than half-copied", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root, { ledger: false });
  const dest = join(root, "backups");

  const result = runIn(source, [
    "run", "--dest", dest, "--now", "2026-09-01T11:00:00Z",
  ]);

  assert.equal(memberStatus(result, "triage-ledger.json").status, "absent");
  assert.equal(memberStatus(result, "triage-batches").status, "skipped_without_ledger");
  assert.equal(existsSync(join(result.snapshot, "triage-batches")), false);
});

test("rotation keeps the newest seven and can reach nothing it did not write", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root);
  const dest = join(root, "backups");
  mkdirSync(dest, { recursive: true });

  // Three things the rotation must never touch, all of them in the directory it owns: a foreign
  // directory, a foreign file, and a directory whose name matches the stamp shape exactly but
  // which carries no manifest of this tool — the shape a hand-made copy would have.
  const foreignDir = join(dest, "keep-me");
  mkdirSync(foreignDir);
  writeFileSync(join(foreignDir, "notes.txt"), "mine\n");
  writeFileSync(join(dest, "backup.log"), "scheduled run\n");
  const lookAlike = join(dest, "20250101T000000Z");
  mkdirSync(lookAlike);
  writeFileSync(join(lookAlike, "process-log.json"), emptyProcessLog());

  const stamps = [];
  for (let day = 1; day <= 9; day += 1) {
    const now = `2026-09-${String(day).padStart(2, "0")}T11:00:00Z`;
    stamps.push(runIn(source, ["run", "--dest", dest, "--now", now]).stamp);
  }

  const kept = ownedSnapshots(realpathSync(dest)).map((snapshot) => snapshot.stamp);
  assert.equal(kept.length, DEFAULT_KEEP);
  assert.deepEqual(kept, stamps.slice(2).reverse());
  for (const stamp of stamps.slice(0, 2)) {
    assert.equal(existsSync(join(dest, stamp)), false, stamp);
  }
  assert.equal(existsSync(join(foreignDir, "notes.txt")), true);
  assert.equal(existsSync(join(dest, "backup.log")), true);
  assert.equal(existsSync(join(lookAlike, "process-log.json")), true);
});

test("rotation sweeps only its own aged partial directories", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root);
  const dest = join(root, "backups");
  mkdirSync(dest, { recursive: true });

  const aged = join(dest, "20260801T110000Z.partial-424242");
  mkdirSync(aged);
  const young = join(dest, "20260831T110000Z.partial-424243");
  mkdirSync(young);
  const foreign = join(dest, "20260801T110000Z.partial-notapid");
  mkdirSync(foreign);
  // `--now` moves the tool's clock but not the filesystem's, and the sweep compares the two, so
  // every mtime here is set relative to the injected instant rather than to the real clock: the
  // case then proves the threshold instead of proving what time it is on this machine.
  const beforeThreshold = new Date("2026-08-30T11:00:00Z");
  const withinThreshold = new Date("2026-09-01T10:00:00Z");
  for (const directory of [aged, foreign]) {
    writeFileSync(join(directory, "leftover"), "partial\n");
    utimesSync(directory, beforeThreshold, beforeThreshold);
  }
  utimesSync(young, withinThreshold, withinThreshold);

  const result = runIn(source, [
    "run", "--dest", dest, "--now", "2026-09-01T11:00:00Z",
  ]);

  assert.deepEqual(result.rotation.removed_partials, ["20260801T110000Z.partial-424242"]);
  assert.equal(existsSync(young), true);
  assert.equal(existsSync(foreign), true);
  assert.equal(existsSync(aged), false);
});

test("a snapshot directory that already exists is never overwritten", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root);
  const entry = makeRunnableCheckout(source);
  const dest = join(root, "backups");
  mkdirSync(join(dest, "20260901T110000Z"), { recursive: true });

  const child = runTool(entry, [
    "run", "--dest", dest, "--now", "2026-09-01T11:00:00Z",
  ]);

  assert.equal(child.status, 1);
  assert.equal(errorOf(child).code, "backup_snapshot_exists");
  // An empty directory is exactly the case `rename` would have accepted silently.
  assert.deepEqual(readdirSync(join(dest, "20260901T110000Z")), []);
});

test("verify names a changed file, a missing one and an added one", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root);
  const entry = makeRunnableCheckout(source);
  const dest = join(root, "backups");
  const snapshot = runIn(source, [
    "run", "--dest", dest, "--now", "2026-09-01T11:00:00Z",
  ]).snapshot;

  writeFileSync(join(snapshot, "output", "acme-sdet", "cv.json"), '{"published":false}\n');
  rmSync(join(snapshot, "output", "acme-sdet", "cover-letter.md"));
  writeFileSync(join(snapshot, "output", "acme-sdet", "extra.md"), "added\n");

  const result = runIn(source, ["verify", "--backup", snapshot]);

  assert.equal(result.status, "mismatch");
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatched, ["output/acme-sdet/cv.json"]);
  assert.deepEqual(result.missing, ["output/acme-sdet/cover-letter.md"]);
  assert.deepEqual(result.unexpected, ["output/acme-sdet/extra.md"]);

  const child = runTool(entry, ["verify", "--backup", snapshot]);
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).status, "mismatch");
});

test("the freshness check answers the only question a scheduled job cannot", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root);
  const dest = join(root, "backups");

  // A destination that was never created answers the liveness question rather than refusing it:
  // "there are no backups" is the finding, not a mistyped argument.
  const missing = runIn(source, [
    "verify", "--dest", dest, "--max-age-hours", "24", "--now", "2026-09-01T11:00:00Z",
  ]);
  assert.equal(missing.status, "empty");
  assert.equal(missing.ok, false);
  assert.equal(existsSync(dest), false);

  mkdirSync(dest, { recursive: true });
  const empty = runIn(source, [
    "verify", "--dest", dest, "--max-age-hours", "24", "--now", "2026-09-01T11:00:00Z",
  ]);
  assert.equal(empty.status, "empty");
  assert.equal(empty.ok, false);

  runIn(source, ["run", "--dest", dest, "--now", "2026-09-01T11:00:00Z"]);

  const fresh = runIn(source, [
    "verify", "--dest", dest, "--max-age-hours", "24", "--now", "2026-09-02T10:00:00Z",
  ]);
  assert.equal(fresh.status, "fresh");
  assert.equal(fresh.age_hours, 23);

  const stale = runIn(source, [
    "verify", "--dest", dest, "--max-age-hours", "24", "--now", "2026-09-03T11:00:00Z",
  ]);
  assert.equal(stale.status, "stale");
  assert.equal(stale.ok, false);
  assert.equal(stale.newest.stamp, "20260901T110000Z");
});

test("the rendered LaunchAgent names the script it schedules and escapes what it interpolates", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root);
  const dest = join(root, "back & ups");
  mkdirSync(dest, { recursive: true });

  const result = runIn(source, [
    "print-plist", "--script", toolPath, "--dest", dest, "--hour", "11", "--minute", "0",
  ]);

  assert.equal(result.label, LAUNCH_AGENT_LABEL);
  assert.equal(result.argv[0], process.execPath);
  assert.equal(result.argv[1], toolPath);
  // No source in the scheduled command: the script's own location is the target.
  assert.deepEqual(result.argv.slice(2), ["run", "--dest", realpathSync(dest)]);
  assert.equal(result.script_present, true);
  assert.match(result.plist, /<key>Hour<\/key>\n\s+<integer>11<\/integer>/);
  assert.match(result.plist, /<key>RunAtLoad<\/key>\n\s+<false\/>/);
  // The ampersand in the destination reaches the XML escaped, and never raw.
  assert.equal(result.plist.includes("back &amp; ups"), true);
  assert.equal(/back & ups/.test(result.plist), false);
});

test("print-plist schedules a script that does not exist yet, and says so", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root);
  const dest = join(root, "backups");
  mkdirSync(dest, { recursive: true });
  // The shape the second user decision creates: the operational copy arrives only with a cutover,
  // so the plist has to be renderable against a path that is not there yet.
  const notYetThere = join(root, "operational-checkout", "tools", "operational-backup.mjs");

  const result = runIn(source, ["print-plist", "--script", notYetThere, "--dest", dest]);

  assert.equal(result.status, "rendered");
  assert.equal(result.script_present, false);
  assert.equal(result.argv[1], notYetThere);
  assert.equal(result.plist.includes(notYetThere), true);
});

test("print-plist refuses a relative script path and a missing one", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root);
  const dest = join(root, "backups");
  mkdirSync(dest, { recursive: true });

  // Relative would be resolved against whatever directory the command ran in, and the "not
  // present" line an operator expects before a cutover would make that typo look ordinary.
  assert.throws(
    () => runIn(source, ["print-plist", "--script", "tools/backup.mjs", "--dest", dest]),
    (error) => error.code === "backup_path_not_absolute",
  );
  // Defaulting to the running copy would schedule whichever checkout rendered the plist.
  assert.throws(
    () => runIn(source, ["print-plist", "--dest", dest]),
    (error) => error.code === "backup_invalid_arguments",
  );
});

test("the destination may not sit inside the checkout it backs up", (t) => {
  const root = makeRoot(t);
  const source = makeSource(root);
  const entry = makeRunnableCheckout(source);

  const child = runTool(entry, ["run", "--dest", join(source, "backups")]);

  assert.equal(child.status, 1);
  assert.equal(errorOf(child).code, "backup_destination_inside_source");
});

test("stamps are derived from the instant, not from the local clock", () => {
  assert.equal(stampOf(new Date("2026-09-01T11:00:00Z")), "20260901T110000Z");
  assert.equal(stampOf(new Date("2026-01-02T03:04:05.678Z")), "20260102T030405Z");
});
