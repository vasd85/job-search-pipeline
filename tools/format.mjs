import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as prettier from "prettier";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Git supplies the inventory, so private state and untracked scratch files never
// enter the formatter. NUL-delimited names remain data, never shell arguments.
export async function formatTrackedFiles({ root = repoRoot, write = false } = {}) {
  const inventory = spawnSync("git", ["ls-files", "--cached", "-z"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (inventory.error || inventory.status !== 0) {
    throw new Error("Unable to enumerate tracked files for formatting.");
  }
  const config = JSON.parse(await readFile(join(root, ".prettierrc.json"), "utf8"));
  const report = { checked: 0, ignored: 0, unsupported: 0, changed: [] };
  for (const relative of new Set(inventory.stdout.split("\0").filter(Boolean))) {
    const filepath = join(root, relative);
    const info = await prettier.getFileInfo(filepath, {
      ignorePath: join(root, ".prettierignore"),
      resolveConfig: false,
    });
    if (info.ignored) {
      report.ignored += 1;
      continue;
    }
    if (info.inferredParser === null) {
      report.unsupported += 1;
      continue;
    }
    const source = await readFile(filepath, "utf8");
    const formatted = await prettier.format(source, { ...config, filepath });
    report.checked += 1;
    if (source !== formatted) {
      report.changed.push(relative);
      if (write) await writeFile(filepath, formatted, "utf8");
    }
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !["--check", "--write"].includes(argv[0])) {
    process.stderr.write("Usage: node tools/format.mjs (--check | --write)\n");
    return 1;
  }
  try {
    const report = await formatTrackedFiles({ write: argv[0] === "--write" });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return argv[0] === "--check" && report.changed.length > 0 ? 1 : 0;
  } catch {
    process.stderr.write("Unable to format tracked files; check the configuration and source files.\n");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
