import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

function git(root, args, input) {
  // In particular, retain GIT_INDEX_FILE: Git supplies a temporary index for pathspec commits.
  const result = spawnSync("git", args, {
    cwd: root,
    input,
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`Git ${args[0]} failed.`);
  return result.stdout;
}

function text(blob) {
  const source = blob.toString("utf8");
  if (!Buffer.from(source).equals(blob)) throw new Error("A supported file is not valid UTF-8.");
  return source;
}

export async function formatStagedFiles({ root = process.cwd() } = {}) {
  const prettier = await import("prettier");
  root = text(git(root, ["rev-parse", "--show-toplevel"])).replace(/\n$/u, "");
  const entries = new Map();
  for (const record of text(git(root, ["ls-files", "--stage", "-z"]))
    .split("\0")
    .filter(Boolean)) {
    const tab = record.indexOf("\t");
    const [mode, oid, stage] = record.slice(0, tab).split(" ");
    if (stage !== "0") throw new Error("The index has unmerged entries.");
    entries.set(record.slice(tab + 1), { mode, oid });
  }
  function policy(path) {
    const entry = entries.get(path);
    if (!entry || !["100644", "100755"].includes(entry.mode))
      throw new Error(`Missing staged ${path}.`);
    return text(git(root, ["cat-file", "blob", entry.oid]));
  }
  const config = JSON.parse(policy(".prettierrc.json"));
  const ignore = policy(".prettierignore");
  const snapshot = await mkdtemp(join(tmpdir(), "pre-commit-format-"));
  const prepared = [];
  const changed = [];
  try {
    const ignorePath = join(snapshot, ".prettierignore");
    await writeFile(ignorePath, ignore);
    const paths = text(git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"]));
    for (const path of paths.split("\0").filter(Boolean)) {
      const entry = entries.get(path);
      if (!entry || !["100644", "100755"].includes(entry.mode)) continue;
      // Both names are in the temporary policy root, so ignore patterns resolve against staged policy.
      const info = await prettier.getFileInfo(join(snapshot, path), {
        ignorePath,
        resolveConfig: false,
      });
      if (info.ignored || info.inferredParser === null) continue;
      const original = git(root, ["cat-file", "blob", entry.oid]);
      let formatted = text(original);
      let stable = false;
      for (let pass = 0; pass < 5; pass += 1) {
        const next = await prettier.format(formatted, {
          ...config,
          filepath: join(snapshot, path),
        });
        if (next === formatted) {
          stable = true;
          break;
        }
        formatted = next;
      }
      if (!stable) throw new Error("Formatting did not reach a stable result.");
      if (Buffer.from(formatted).equals(original)) continue;
      changed.push({ path, ...entry, original, formatted });
    }
    // Finish parsing every file before touching the index or any working file.
    for (const change of changed) {
      change.oid = text(git(root, ["hash-object", "-w", "--stdin"], change.formatted)).trim();
      const target = join(root, change.path);
      let info;
      try {
        info = await lstat(target);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (
        !info.isFile() ||
        (await realpath(dirname(target))) !== dirname(target) ||
        !(await readFile(target)).equals(change.original)
      )
        continue;
      const temporary = join(dirname(target), `.pre-commit-format-${randomUUID()}`);
      prepared.push({ target, temporary, original: change.original });
      await writeFile(temporary, change.formatted, { flag: "wx", mode: info.mode });
      await chmod(temporary, info.mode);
    }
    if (changed.length) {
      git(
        root,
        ["update-index", "-z", "--index-info"],
        changed.map(({ mode, oid, path }) => `${mode} ${oid}\t${path}\0`).join(""),
      );
    }
    for (const { target, temporary, original } of prepared) {
      // Preserve edits made since preparation as well as edits that were already unstaged.
      const info = await lstat(target);
      if (info.isFile() && (await readFile(target)).equals(original))
        await rename(temporary, target);
    }
    return changed.map(({ path }) => path);
  } finally {
    for (const { temporary } of prepared) await rm(temporary, { force: true });
    await rm(snapshot, { recursive: true, force: true });
  }
}

export async function main() {
  try {
    await formatStagedFiles();
    return 0;
  } catch (error) {
    process.stderr.write(
      `pre-commit: unable to format staged files; nothing was committed. ${error.message}\n`,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href
) {
  process.exitCode = await main();
}
