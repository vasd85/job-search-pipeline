import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  checkToolchain,
  ToolchainPreflightError,
} from "../tools/bootstrap.mjs";
import {
  checkCvBuilderDependencies,
  CvBuilderDependencyError,
} from "../tools/cv-builder/check-dependencies.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_VERSION = "24.18.0";
const NPM_VERSION = "11.16.0";

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createToolchainFixture(t) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "job-search-toolchain-"));
  t.after(() => rmSync(workspaceRoot, { force: true, recursive: true }));
  const builderRoot = join(workspaceRoot, "tools", "cv-builder");
  mkdirSync(join(builderRoot, "node_modules", "docx"), { recursive: true });
  mkdirSync(join(builderRoot, "node_modules", "zip-helper"), { recursive: true });

  const engines = { node: NODE_VERSION, npm: NPM_VERSION };
  writeJson(join(workspaceRoot, "package.json"), {
    name: "toolchain-fixture",
    private: true,
    engines,
    packageManager: `npm@${NPM_VERSION}`,
  });
  writeFileSync(join(workspaceRoot, ".nvmrc"), `${NODE_VERSION}\n`);
  writeJson(join(workspaceRoot, "package-lock.json"), {
    name: "toolchain-fixture",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "toolchain-fixture",
        engines,
      },
    },
  });
  writeJson(join(builderRoot, "package.json"), {
    name: "cv-builder",
    private: true,
    engines,
    packageManager: `npm@${NPM_VERSION}`,
    dependencies: { docx: "9.7.1" },
  });
  writeJson(join(builderRoot, "package-lock.json"), {
    name: "cv-builder",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "cv-builder",
        dependencies: { docx: "9.7.1" },
        engines,
      },
      "node_modules/docx": {
        version: "9.7.1",
        dependencies: { "zip-helper": "1.0.0" },
      },
      "node_modules/zip-helper": { version: "1.0.0" },
    },
  });
  writeJson(join(builderRoot, "node_modules", "docx", "package.json"), {
    name: "docx",
    version: "9.7.1",
    main: "index.js",
  });
  writeFileSync(join(builderRoot, "node_modules", "docx", "index.js"), "module.exports = {};\n");
  writeJson(join(builderRoot, "node_modules", "zip-helper", "package.json"), {
    name: "zip-helper",
    version: "1.0.0",
  });

  return { builderRoot, workspaceRoot };
}

function readyContext(overrides = {}) {
  return {
    nodeVersion: NODE_VERSION,
    packageManagerVersion: () => NPM_VERSION,
    requireCommand(command) {
      return `/fixture/bin/${command}`;
    },
    resolveRenderer: () => ({ kind: "headless-soffice" }),
    ...overrides,
  };
}

function expectCode(fn, ErrorClass, code) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof ErrorClass, true);
    assert.equal(error.code, code);
    return true;
  });
}

test("exact Node/npm policy, both lockfiles, dependencies, tools, and renderer pass", (t) => {
  const fixture = createToolchainFixture(t);
  const result = checkToolchain({
    context: readyContext(),
    workspaceRoot: fixture.workspaceRoot,
  });

  assert.equal(result.node, NODE_VERSION);
  assert.equal(result.packageManager, `npm@${NPM_VERSION}`);
  assert.equal(result.dependencies.packages, 2);
  assert.equal(result.renderer, "headless-soffice");
  assert.deepEqual(Object.keys(result.tools), ["unzip", "pdfinfo", "pdftoppm"]);
});

test("Node and npm patch drift fail with distinct stable codes", (t) => {
  const fixture = createToolchainFixture(t);
  expectCode(
    () => checkToolchain({
      context: readyContext({ nodeVersion: "24.18.1" }),
      workspaceRoot: fixture.workspaceRoot,
    }),
    ToolchainPreflightError,
    "unsupported_node_version",
  );
  expectCode(
    () => checkToolchain({
      context: readyContext({ packageManagerVersion: () => "11.16.1" }),
      workspaceRoot: fixture.workspaceRoot,
    }),
    ToolchainPreflightError,
    "unsupported_package_manager",
  );
  expectCode(
    () => checkToolchain({
      context: readyContext({ packageManagerVersion: () => null }),
      workspaceRoot: fixture.workspaceRoot,
    }),
    ToolchainPreflightError,
    "package_manager_missing",
  );
});

function patchJson(path, mutate) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  mutate(value);
  writeJson(path, value);
}

// A directory in place of the file is the deterministic way to reach the
// unreadable branch. Removing the read permission does nothing when the suite
// runs as root, which would leave the branch uncovered while the case passed.
function replaceWithDirectory(path) {
  unlinkSync(path);
  mkdirSync(path);
}

// Frozen literal, so deleting a scenario from the table below cannot delete it
// from the coverage this test claims.
const TOOLCHAIN_REJECTION_NAMES = [
  "root packageManager is not one exact npm version",
  "root engines.node is not one exact version",
  "root npm engine differs from packageManager",
  "cv-builder packageManager differs from root",
  "cv-builder engines.node differs from root",
  "cv-builder engines.npm differs from root",
  "nvmrc is absent",
  "nvmrc differs from engines.node",
  "root package manifest is absent",
  "cv-builder package manifest is absent",
  "root package manifest is unreadable",
  "cv-builder package manifest is unreadable",
  "nvmrc is unreadable",
  "root lockfile is unreadable",
  "root package manifest is malformed",
  "cv-builder package manifest is malformed",
  "root lockfile is malformed",
];

/**
 * One entry per `toolchain_policy_invalid` and `toolchain_metadata_invalid`
 * emission, and one per distinct `label` each of those statements can carry:
 * three of the metadata messages are templated, so a single case per statement
 * would leave a swapped label argument alive. Each fixture mutates exactly one
 * point, because every earlier check in `checkToolchain` masks the later ones.
 */
const TOOLCHAIN_REJECTIONS = [
  {
    code: "toolchain_policy_invalid",
    message: "packageManager must pin one exact npm version",
    mutate: (f) => patchJson(join(f.workspaceRoot, "package.json"), (value) => {
      value.packageManager = `npm@${NPM_VERSION.slice(0, NPM_VERSION.lastIndexOf("."))}`;
    }),
    name: "root packageManager is not one exact npm version",
  },
  {
    code: "toolchain_policy_invalid",
    message: "engines.node must pin one exact version",
    mutate: (f) => patchJson(join(f.workspaceRoot, "package.json"), (value) => {
      value.engines.node = `^${NODE_VERSION}`;
    }),
    name: "root engines.node is not one exact version",
  },
  {
    code: "toolchain_policy_invalid",
    message: "root npm engine and packageManager pins differ",
    mutate: (f) => patchJson(join(f.workspaceRoot, "package.json"), (value) => {
      value.engines.npm = "11.16.1";
    }),
    name: "root npm engine differs from packageManager",
  },
  {
    code: "toolchain_policy_invalid",
    message: "root and cv-builder toolchain pins differ",
    mutate: (f) => patchJson(join(f.builderRoot, "package.json"), (value) => {
      value.packageManager = "npm@11.16.1";
    }),
    name: "cv-builder packageManager differs from root",
  },
  {
    code: "toolchain_policy_invalid",
    message: "root and cv-builder toolchain pins differ",
    mutate: (f) => patchJson(join(f.builderRoot, "package.json"), (value) => {
      value.engines.node = "22.0.0";
    }),
    name: "cv-builder engines.node differs from root",
  },
  {
    code: "toolchain_policy_invalid",
    message: "root and cv-builder toolchain pins differ",
    mutate: (f) => patchJson(join(f.builderRoot, "package.json"), (value) => {
      value.engines.npm = "11.16.1";
    }),
    name: "cv-builder engines.npm differs from root",
  },
  {
    code: "toolchain_policy_invalid",
    message: ".nvmrc is missing",
    mutate: (f) => unlinkSync(join(f.workspaceRoot, ".nvmrc")),
    name: "nvmrc is absent",
  },
  {
    code: "toolchain_policy_invalid",
    message: ".nvmrc and engines.node pins differ",
    mutate: (f) => writeFileSync(join(f.workspaceRoot, ".nvmrc"), "24.18.1\n"),
    name: "nvmrc differs from engines.node",
  },
  {
    code: "toolchain_metadata_invalid",
    message: "root package manifest is missing",
    mutate: (f) => unlinkSync(join(f.workspaceRoot, "package.json")),
    name: "root package manifest is absent",
  },
  {
    code: "toolchain_metadata_invalid",
    message: "cv-builder package manifest is missing",
    mutate: (f) => unlinkSync(join(f.builderRoot, "package.json")),
    name: "cv-builder package manifest is absent",
  },
  {
    code: "toolchain_metadata_invalid",
    message: "root package manifest is not readable",
    mutate: (f) => replaceWithDirectory(join(f.workspaceRoot, "package.json")),
    name: "root package manifest is unreadable",
  },
  {
    code: "toolchain_metadata_invalid",
    message: "cv-builder package manifest is not readable",
    mutate: (f) => replaceWithDirectory(join(f.builderRoot, "package.json")),
    name: "cv-builder package manifest is unreadable",
  },
  {
    // The one call site whose absent and unreadable outcomes carry different
    // codes: absent is a policy pin, unreadable is metadata.
    code: "toolchain_metadata_invalid",
    message: ".nvmrc is not readable",
    mutate: (f) => replaceWithDirectory(join(f.workspaceRoot, ".nvmrc")),
    name: "nvmrc is unreadable",
  },
  {
    code: "toolchain_metadata_invalid",
    message: "root lockfile is not readable",
    mutate: (f) => replaceWithDirectory(join(f.workspaceRoot, "package-lock.json")),
    name: "root lockfile is unreadable",
  },
  {
    code: "toolchain_metadata_invalid",
    message: "root package manifest is not valid JSON",
    mutate: (f) => writeFileSync(join(f.workspaceRoot, "package.json"), "{\n"),
    name: "root package manifest is malformed",
  },
  {
    code: "toolchain_metadata_invalid",
    message: "cv-builder package manifest is not valid JSON",
    mutate: (f) => writeFileSync(join(f.builderRoot, "package.json"), "{\n"),
    name: "cv-builder package manifest is malformed",
  },
  {
    code: "toolchain_metadata_invalid",
    message: "root lockfile is not valid JSON",
    mutate: (f) => writeFileSync(join(f.workspaceRoot, "package-lock.json"), "{\n"),
    name: "root lockfile is malformed",
  },
];

test("every toolchain policy and metadata rejection names its own code and message", async (t) => {
  assert.deepEqual(
    TOOLCHAIN_REJECTIONS.map((scenario) => scenario.name),
    TOOLCHAIN_REJECTION_NAMES,
  );
  assert.equal(TOOLCHAIN_REJECTION_NAMES.length, 17);
  // Six policy statements and three metadata statements; the three repeats are
  // the disjuncts of the single root-versus-builder comparison.
  assert.equal(
    new Set(TOOLCHAIN_REJECTIONS.map((scenario) => scenario.message)).size,
    15,
  );

  const executed = [];
  for (const scenario of TOOLCHAIN_REJECTIONS) {
    await t.test(scenario.name, (t) => {
      const fixture = createToolchainFixture(t);
      scenario.mutate(fixture);
      assert.throws(
        () => checkToolchain({
          context: readyContext(),
          workspaceRoot: fixture.workspaceRoot,
        }),
        (error) => {
          assert.equal(error instanceof ToolchainPreflightError, true, scenario.name);
          assert.equal(error.code, scenario.code, scenario.name);
          assert.equal(error.message, scenario.message, scenario.name);
          return true;
        },
      );
      executed.push(scenario.name);
    });
  }
  // Third leg: a described case that never ran would leave this short.
  assert.deepEqual(executed, TOOLCHAIN_REJECTION_NAMES);
});

// Every case above drives an injected context. Production must not, or the whole
// table would go green against a stubbed toolchain.
test("the production preflight resolves its own toolchain context", () => {
  const source = readFileSync(join(repoRoot, "tools", "bootstrap.mjs"), "utf8");
  const calls = [...source.matchAll(/(?<!function )\bcheckToolchain\(([^)]*)\)/g)]
    .map((match) => match[1]);
  assert.deepEqual(calls, [""]);
});

test("missing and drifted root or builder lockfiles fail closed", async (t) => {
  for (const [label, relativePath] of [
    ["root", "package-lock.json"],
    ["builder", "tools/cv-builder/package-lock.json"],
  ]) {
    await t.test(label, (t) => {
      const fixture = createToolchainFixture(t);
      unlinkSync(join(fixture.workspaceRoot, relativePath));
      expectCode(
        () => checkToolchain({
          context: readyContext(),
          workspaceRoot: fixture.workspaceRoot,
        }),
        label === "root" ? ToolchainPreflightError : CvBuilderDependencyError,
        "toolchain_lockfile_missing",
      );
    });
  }

  await t.test("root lock metadata drift", (t) => {
    const fixture = createToolchainFixture(t);
    const lockPath = join(fixture.workspaceRoot, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.packages[""].engines.node = "22.0.0";
    writeJson(lockPath, lock);
    expectCode(
      () => checkToolchain({
        context: readyContext(),
        workspaceRoot: fixture.workspaceRoot,
      }),
      ToolchainPreflightError,
      "toolchain_lockfile_mismatch",
    );
  });

  await t.test("builder lock metadata drift", (t) => {
    const fixture = createToolchainFixture(t);
    const lockPath = join(fixture.builderRoot, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.packages[""].engines.node = "22.0.0";
    writeJson(lockPath, lock);
    expectCode(
      () => checkToolchain({
        context: readyContext(),
        workspaceRoot: fixture.workspaceRoot,
      }),
      CvBuilderDependencyError,
      "toolchain_lockfile_mismatch",
    );
  });
});

test("dependency graph rejects absent, wrong-version, broken transitive, and symlink packages", async (t) => {
  await t.test("absent direct dependency", (t) => {
    const fixture = createToolchainFixture(t);
    rmSync(join(fixture.builderRoot, "node_modules", "docx"), { recursive: true });
    expectCode(
      () => checkCvBuilderDependencies(fixture.builderRoot),
      CvBuilderDependencyError,
      "toolchain_dependencies_missing",
    );
  });

  await t.test("wrong direct dependency version", (t) => {
    const fixture = createToolchainFixture(t);
    writeJson(join(fixture.builderRoot, "node_modules", "docx", "package.json"), {
      name: "docx",
      version: "9.7.0",
    });
    expectCode(
      () => checkCvBuilderDependencies(fixture.builderRoot),
      CvBuilderDependencyError,
      "toolchain_dependency_version_mismatch",
    );
  });

  await t.test("wrong direct dependency identity", (t) => {
    const fixture = createToolchainFixture(t);
    writeJson(join(fixture.builderRoot, "node_modules", "docx", "package.json"), {
      name: "not-docx",
      version: "9.7.1",
      main: "index.js",
    });
    expectCode(
      () => checkCvBuilderDependencies(fixture.builderRoot),
      CvBuilderDependencyError,
      "toolchain_dependency_identity_mismatch",
    );
  });

  await t.test("missing transitive dependency", (t) => {
    const fixture = createToolchainFixture(t);
    rmSync(join(fixture.builderRoot, "node_modules", "zip-helper"), { recursive: true });
    expectCode(
      () => checkCvBuilderDependencies(fixture.builderRoot),
      CvBuilderDependencyError,
      "toolchain_dependencies_missing",
    );
  });

  await t.test("broken direct dependency entrypoint", (t) => {
    const fixture = createToolchainFixture(t);
    unlinkSync(join(fixture.builderRoot, "node_modules", "docx", "index.js"));
    expectCode(
      () => checkCvBuilderDependencies(fixture.builderRoot),
      CvBuilderDependencyError,
      "toolchain_dependency_invalid",
    );
  });

  await t.test("unloadable direct dependency entrypoint", (t) => {
    const fixture = createToolchainFixture(t);
    writeFileSync(
      join(fixture.builderRoot, "node_modules", "docx", "index.js"),
      "module.exports = ;\n",
    );
    expectCode(
      () => checkCvBuilderDependencies(fixture.builderRoot),
      CvBuilderDependencyError,
      "toolchain_dependency_invalid",
    );
  });

  await t.test("symlink dependency", (t) => {
    const fixture = createToolchainFixture(t);
    const dependencyPath = join(fixture.builderRoot, "node_modules", "docx");
    const outside = join(fixture.builderRoot, "outside-docx");
    mkdirSync(outside);
    writeJson(join(outside, "package.json"), { name: "docx", version: "9.7.1" });
    rmSync(dependencyPath, { recursive: true });
    symlinkSync(outside, dependencyPath, "dir");
    expectCode(
      () => checkCvBuilderDependencies(fixture.builderRoot),
      CvBuilderDependencyError,
      "toolchain_dependency_invalid",
    );
  });

  await t.test("symlink node_modules ancestor", (t) => {
    const fixture = createToolchainFixture(t);
    const nodeModulesPath = join(fixture.builderRoot, "node_modules");
    const outside = join(fixture.workspaceRoot, "outside-node-modules");
    renameSync(nodeModulesPath, outside);
    symlinkSync(outside, nodeModulesPath, "dir");
    expectCode(
      () => checkCvBuilderDependencies(fixture.builderRoot),
      CvBuilderDependencyError,
      "toolchain_dependency_invalid",
    );
  });
});

test("missing system tools and renderer fail in deterministic preflight order", async (t) => {
  for (const missing of ["unzip", "pdfinfo", "pdftoppm"]) {
    await t.test(missing, (t) => {
      const fixture = createToolchainFixture(t);
      expectCode(
        () => checkToolchain({
          context: readyContext({
            requireCommand(command) {
              if (command === missing) {
                throw new ToolchainPreflightError(
                  "required_tool_missing",
                  `required tool is unavailable: ${command}`,
                );
              }
              return `/fixture/bin/${command}`;
            },
          }),
          workspaceRoot: fixture.workspaceRoot,
        }),
        ToolchainPreflightError,
        "required_tool_missing",
      );
    });
  }

  await t.test("renderer unavailable", (t) => {
    const fixture = createToolchainFixture(t);
    expectCode(
      () => checkToolchain({
        context: readyContext({
          resolveRenderer() {
            throw Object.assign(new Error("missing renderer"), {
              code: "cv_renderer_no_safe_backend",
            });
          },
        }),
        workspaceRoot: fixture.workspaceRoot,
      }),
      ToolchainPreflightError,
      "renderer_unavailable",
    );
  });
});

test("repository production shell has no package-manager execution path", () => {
  const shell = readFileSync(join(repoRoot, "tools", "cv-builder", "build.sh"), "utf8");
  assert.doesNotMatch(
    shell,
    /\b(?:npm|pnpm|yarn)\s+(?:install|i|ci|add|exec)\b|\bnpx\b/,
  );
  assert.match(shell, /check-dependencies\.mjs/);
});

test("production build attempt does not invoke a package manager when dependencies are missing", (t) => {
  const fixture = createToolchainFixture(t);
  rmSync(join(fixture.builderRoot, "node_modules", "docx"), { recursive: true });
  copyFileSync(
    join(repoRoot, "tools", "cv-builder", "build.sh"),
    join(fixture.builderRoot, "build.sh"),
  );
  copyFileSync(
    join(repoRoot, "tools", "cv-builder", "check-dependencies.mjs"),
    join(fixture.builderRoot, "check-dependencies.mjs"),
  );
  assert.equal(existsSync(join(fixture.builderRoot, "node_modules", "docx")), false);
  const dependencyProbe = spawnSync(
    process.execPath,
    [join(fixture.builderRoot, "check-dependencies.mjs")],
    { encoding: "utf8" },
  );
  assert.equal(dependencyProbe.status, 1, dependencyProbe.stderr);
  assert.match(dependencyProbe.stderr, /toolchain_dependencies_missing/);
  const fakeBin = join(fixture.workspaceRoot, "fake-bin");
  const marker = join(fixture.workspaceRoot, "package-manager-called");
  mkdirSync(fakeBin);
  const fakeNpm = join(fakeBin, "npm");
  writeFileSync(fakeNpm, `#!/bin/sh\ntouch '${marker}'\nexit 91\n`);
  chmodSync(fakeNpm, 0o755);

  const result = spawnSync("/bin/bash", [join(fixture.builderRoot, "build.sh"), "missing.json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /toolchain_dependencies_missing/);
  assert.equal(existsSync(marker), false);
});
