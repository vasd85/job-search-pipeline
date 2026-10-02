#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { childEnvironment } from "./ci.mjs";
import { isExcluded, loadExportExclusions } from "./export-exclusions.mjs";
import { assembleContract, trackedPaths } from "./publishability/cli.mjs";
import { PUBLIC_TEXT_ALLOWANCES } from "./publishability/markers.mjs";
import { scanText, scanTree } from "./publishability/scan.mjs";
import { checkPublicLinks } from "./public-links.mjs";

export const INITIAL_MESSAGE = "Initial public engine snapshot";
export class PublicExportError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new PublicExportError(code, message); };
const present = (path) => { try { lstatSync(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
const within = (parent, path) => { const rel = relative(parent, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };

/** No shell, ambient git redirection, shared hooks or inherited author identity. */
export function exportPublic(options, { spawn = spawnSync } = {}) {
  const { source, rev, target, candidateRoot, email, name = "Engine Maintainer", dependencyRoot = null } = options;
  for (const [key, value] of Object.entries({ source, target, candidateRoot })) {
    if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) fail("public_export_arguments", `${key} must be an absolute normalized path.`);
  }
  if (!/^[0-9a-f]{40,64}$/u.test(rev ?? "")) fail("public_export_arguments", "rev must be a full commit SHA.");
  if (!/^(?:[0-9]+\+)?[A-Za-z0-9-]+@users\.noreply\.github\.com$/u.test(email ?? "")) fail("public_export_identity", "Use a GitHub noreply email.");
  if (typeof name !== "string" || !name.trim() || /[\r\n<>]/u.test(name)) fail("public_export_identity", "Invalid author name.");
  const sourceReal = realpathSync(source);
  const parent = realpathSync(dirname(target));
  const destination = join(parent, target.split("/").at(-1));
  if (within(sourceReal, destination) || within(destination, sourceReal) || present(destination)) fail("public_export_target", "Target must be new and outside the source repository.");
  if (dependencyRoot !== null && (!isAbsolute(dependencyRoot) || realpathSync(dependencyRoot) !== sourceReal)) {
    fail("public_export_dependencies", "Offline dependencies must come from the explicit source checkout.");
  }
  const env = { ...childEnvironment(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1" };
  const run = (cwd, command, args, extra = {}) => {
    const result = spawn(command, args, { cwd, env, encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000, ...extra });
    if (result.error || result.status !== 0) fail("public_export_step_failed", `${command} failed (${result.error?.code ?? result.status}).`);
    return String(result.stdout ?? "");
  };
  const git = (cwd, args) => run(cwd, "git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", ...args]);
  const root = git(sourceReal, ["rev-parse", "--show-toplevel"]).trim();
  if (realpathSync(root) !== sourceReal) fail("public_export_source", "Source must be a repository root.");
  if (git(sourceReal, ["rev-parse", `${rev}^{commit}`]).trim() !== rev) fail("public_export_source", "Commit cannot be resolved exactly.");
  git(sourceReal, ["merge-base", "--is-ancestor", rev, "main"]);
  const before = git(sourceReal, ["status", "--porcelain=v1", "-z"]);
  const entries = git(sourceReal, ["ls-tree", "-r", "-z", rev]).split(String.fromCharCode(0)).filter(Boolean).map((line) => {
    const tab = line.indexOf("\t"); const [mode, , oid] = line.slice(0, tab).split(" ");
    const path = line.slice(tab + 1);
    if (!["100644", "100755"].includes(mode) || path.split("/").some(part => ["..", ".", ".git"].includes(part))) fail("public_export_entry", "Only safe regular tracked files can be exported.");
    return { path, mode, oid };
  });
  const contract = assembleContract({ candidateRoot });
  if (!contract.personalCount) fail("public_export_markers", "The export requires a nonempty set of personal markers.");
  if (scanText({ markers: contract.markers, text: `${name}\n${INITIAL_MESSAGE}`, textAllow: PUBLIC_TEXT_ALLOWANCES }).places) fail("public_export_publishability", "Initial commit text or author name carries a marker.");
  const staging = mkdtempSync(join(parent, ".public-export-"));
  try {
    const tree = join(staging, "tree"); mkdirSync(tree);
    const archive = join(staging, "source.tar");
    git(sourceReal, ["archive", "--format=tar", "-o", archive, rev]);
    run(staging, "tar", ["-xf", archive, "-C", tree]);
    const exclusions = loadExportExclusions({ root: tree });
    const kept = entries.filter(entry => !isExcluded(entry.path, exclusions));
    for (const entry of entries) {
      const file = join(tree, entry.path);
      if (isExcluded(entry.path, exclusions)) { rmSync(file, { force: true }); continue; }
      if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) fail("public_export_archive", "The archive omitted or changed a retained entry.");
      const oid = run(tree, "git", ["hash-object", "--no-filters", "--stdin"], { input: readFileSync(file) }).trim();
      if (oid !== entry.oid) fail("public_export_archive", "The archive changed a retained blob.");
    }
    const prune = (directory) => { for (const child of readdirSync(directory, { withFileTypes: true })) if (child.isDirectory()) { const path = join(directory, child.name); prune(path); if (!readdirSync(path).length) rmSync(path, { recursive: true }); } };
    prune(tree);
    git(tree, ["init", "--quiet", "--initial-branch=main", "--template="]);
    git(tree, ["config", "user.name", name]); git(tree, ["config", "user.email", email]);
    // Preserve bytes and executable modes even when committed attributes declare transforms.
    // Raw objects and cache entries bypass clean filters, encoding and EOL normalization.
    for (const entry of kept) {
      const oid = run(tree, "git", ["hash-object", "-w", "--no-filters", "--stdin"], { input: readFileSync(join(tree, entry.path)) }).trim();
      if (oid !== entry.oid) fail("public_export_archive", "The target object format changed a retained blob identity.");
      git(tree, ["update-index", "--add", "--cacheinfo", entry.mode, oid, entry.path]);
    }
    const expectedTree = kept.map(({path,mode,oid}) => `${mode} ${oid}\t${path}`).sort();
    const verifyTree = (index) => {
      const lines = git(tree, index ? ["ls-files", "--stage", "-z"] : ["ls-tree", "-r", "-z", "HEAD"])
        .split(String.fromCharCode(0)).filter(Boolean).map(line => {
          const tab = line.indexOf("\t"), [mode, second, third] = line.slice(0,tab).split(" ");
          if (index && third !== "0") fail("public_export_archive", "The snapshot index has unmerged entries.");
          return `${mode} ${index ? second : third}\t${line.slice(tab + 1)}`;
        }).sort();
      if (JSON.stringify(lines) !== JSON.stringify(expectedTree)) fail("public_export_archive", "Staged or committed bytes differ from the retained source snapshot.");
    };
    verifyTree(true);
    const paths = trackedPaths({ root: tree });
    if (JSON.stringify([...paths].sort()) !== JSON.stringify(kept.map(entry => entry.path).sort())) fail("public_export_archive", "The staged inventory differs from the filtered source commit.");
    if (["candidate", "process-log.json", "triage-ledger.json", "output", "triage-batches", "telegram-sweeps"].some(path => existsSync(join(tree, path)))) fail("public_export_private_state", "Operational state cannot enter the public snapshot.");
    const report = scanTree({ allow: contract.allow, cyrillicData: contract.cyrillicData, markers: contract.markers, paths, root: tree });
    if (report.absent.length || report.placesExported) fail("public_export_publishability", "The public tree carries publication findings.");
    const links = checkPublicLinks({ root: tree, files: paths.filter(path => path.endsWith(".md")), exclusions });
    if (links.length) fail("public_export_links", `The public tree has ${links.length} broken local links.`);
    // Explicit environment identity overrides ambient GIT_AUTHOR_* and GIT_COMMITTER_* values.
    run(tree, "git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", INITIAL_MESSAGE], { env: { ...env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email } });
    verifyTree(false);
    const initialCommit = git(tree, ["rev-parse", "HEAD"]).trim();
    if (dependencyRoot === null) {
      run(tree, "npm", ["ci"]); run(tree, "npm", ["ci", "--prefix", "tools/cv-builder"]);
    } else {
      for (const local of ["node_modules", "tools/cv-builder/node_modules"]) {
        if (existsSync(join(sourceReal, local))) cpSync(join(sourceReal, local), join(tree, local), { recursive: true });
      }
      if (!existsSync(join(tree, "tools/cv-builder/node_modules"))) fail("public_export_dependencies", "Offline CV dependencies are missing.");
    }
    run(tree, "npm", ["run", "ci"]);
    if (git(tree, ["rev-parse", "HEAD"]).trim() !== initialCommit || present(join(tree, ".git/objects/info/alternates")) || git(tree, ["rev-list", "--count", "--all"]).trim() !== "1" || git(tree, ["remote"]).trim() !== "" || git(tree, ["status", "--porcelain=v1"]).trim() !== "") fail("public_export_history", "Verified snapshot must remain clean with one commit and no remote.");
    verifyTree(true); verifyTree(false);
    if (git(sourceReal, ["status", "--porcelain=v1", "-z"]) !== before) fail("public_export_source_changed", "Source status changed during the export.");
    const commit = git(tree, ["rev-parse", "HEAD"]).trim();
    if (present(destination)) fail("public_export_target", "Target appeared during verification.");
    // Reserve exclusively after verification, then replace only our own empty directory.
    try { mkdirSync(destination); } catch (error) { if (error.code === "EEXIST") fail("public_export_target", "Target appeared during verification."); throw error; }
    try { renameSync(tree, destination); } catch (error) { rmSync(destination); throw error; }
    return { status: "ready", source_commit: rev, public_commit: commit, files: kept.length, personal_markers: contract.personalCount, places_exported: report.placesExported, links: "passed", ci: "passed", target: destination };
  } finally { rmSync(staging, { force: true, recursive: true }); }
}

export function parseArguments(argv) {
  const names = { "--source": "source", "--rev": "rev", "--target": "target", "--candidate-root": "candidateRoot", "--email": "email", "--name": "name", "--dependency-root": "dependencyRoot" };
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = names[argv[i]], value = argv[i + 1];
    if (!key || value === undefined || Object.hasOwn(options, key)) fail("public_export_arguments", "Use each documented value flag once.");
    options[key] = value;
  }
  return options;
}
export function main(argv = process.argv.slice(2)) {
  try { process.stdout.write(`${JSON.stringify(exportPublic(parseArguments(argv)))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ status: "error", error: { code: error.code ?? "public_export_failed", message: error instanceof PublicExportError ? error.message : "Public export failed." } })}\n`); process.exitCode = 1; }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
