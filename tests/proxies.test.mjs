import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const explicitSkillNames = [
  "collect-telegram",
  "generate-cv",
  "get-vacancy",
  "map-experience",
  "research-company",
  "score-jobs",
  "write-cover-letter",
];
const codexPolicy = "policy:\n  allow_implicit_invocation: false\n";
const agentNames = ["letter-reader", "telegram-labeler", "telegram-reader"];
const agentModels = { "telegram-reader": "haiku", "telegram-labeler": "sonnet", "letter-reader": "sonnet" };
// Two agents deliberately share one canon (the labeller is the reader on a stronger model); the
// third has its own. Pinned per agent, because a generator that served every agent the same canon
// would pass a check written against one file.
const agentCanons = {
  "telegram-reader": "instructions/agents/telegram-reader.md",
  "telegram-labeler": "instructions/agents/telegram-reader.md",
  "letter-reader": "instructions/agents/letter-reader.md",
};

function runProxySync(root, mode) {
  return spawnSync(process.execPath, ["tools/sync-agent-proxies.mjs", mode], {
    cwd: root,
    encoding: "utf8",
  });
}

function copyIntoFixture(root, relativePath) {
  const destination = resolve(root, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(resolve(repoRoot, relativePath), destination);
}

function createProxyFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "job-pipeline-proxies-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  copyIntoFixture(root, "tools/sync-agent-proxies.mjs");
  copyIntoFixture(root, "instructions/skills/manifest.json");
  for (const skillName of explicitSkillNames) {
    copyIntoFixture(root, `instructions/skills/${skillName}.md`);
  }
  for (const canon of new Set(Object.values(agentCanons))) copyIntoFixture(root, canon);
  return root;
}

test("generated proxies are current and load canonical files first", () => {
  const check = runProxySync(repoRoot, "--check");
  assert.equal(check.status, 0, check.stderr);
  assert.deepEqual(JSON.parse(check.stdout), {
    status: "current",
    files: 26,
    changed: [],
    unexpected: [],
  });
  const manifest = JSON.parse(
    readFileSync(resolve(repoRoot, "instructions/skills/manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.skills.map((skill) => skill.name).sort(),
    explicitSkillNames,
  );
  for (const skill of manifest.skills) {
    assert.equal(skill.claude["disable-model-invocation"], true);
    assert.equal(skill.codex.allow_implicit_invocation, false);
  }
  for (const runtime of [".agents", ".claude"]) {
    const wrapper = readFileSync(resolve(repoRoot, runtime, "skills/get-vacancy/SKILL.md"), "utf8");
    assert.match(wrapper, /^---\nname: get-vacancy\n/);
    assert.match(wrapper, /Before taking any task action, read `instructions\/skills\/get-vacancy\.md` in full/);
  }
  for (const skillName of explicitSkillNames) {
    const metadata = readFileSync(
      resolve(repoRoot, `.agents/skills/${skillName}/agents/openai.yaml`),
      "utf8",
    );
    assert.equal(metadata, codexPolicy);
    const codexWrapper = readFileSync(
      resolve(repoRoot, `.agents/skills/${skillName}/SKILL.md`),
      "utf8",
    );
    assert.doesNotMatch(codexWrapper, /allow_implicit_invocation|^policy:/m);
  }
  const common = readFileSync(resolve(repoRoot, "instructions/skills/get-vacancy.md"), "utf8");
  assert.match(common, /--runner "<runner_id>"/);
  assert.match(common, /fail-step/);
  assert.match(common, /reserve-output/);
  assert.doesNotMatch(common, /mark-failed|set-output/);
});

test("a generated agent has reading as its only tool, the model the manifest names, and the canon verbatim as its body", (t) => {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, "instructions/skills/manifest.json"), "utf8"));
  assert.deepEqual(manifest.agents.map((agent) => agent.name).sort(), agentNames);
  assert.equal(manifest.runtimes.claude.agent_root, ".claude/agents");
  for (const agent of manifest.agents) {
    // The allowlist is pinned as a literal on both sides: the manifest and the generated file.
    assert.deepEqual(agent.claude.tools, ["Read"], agent.name);
    assert.equal(agent.claude.model, agentModels[agent.name], agent.name);
    assert.equal(agent.common, agentCanons[agent.name], agent.name);
    const canon = readFileSync(resolve(repoRoot, agentCanons[agent.name]), "utf8");
    const generated = readFileSync(resolve(repoRoot, `.claude/agents/${agent.name}.md`), "utf8");
    assert.match(generated, new RegExp(`^---\\nname: ${agent.name}\\ndescription: "[^\\n]+"\\ntools: Read\\nmodel: ${agentModels[agent.name]}\\n---\\n`, "u"), agent.name);
    assert.equal(generated.endsWith(`\n${canon}`), true, agent.name);
    assert.doesNotMatch(generated, /tools: .*(Bash|Write|Edit|WebFetch|WebSearch|Agent)/u);
  }
  // The generator refuses any wider allowlist before it writes a file.
  const fixtureRoot = createProxyFixture(t);
  const manifestPath = resolve(fixtureRoot, "instructions/skills/manifest.json");
  const armed = JSON.parse(readFileSync(manifestPath, "utf8"));
  armed.agents[0].claude.tools = ["Read", "Bash"];
  writeFileSync(manifestPath, `${JSON.stringify(armed, null, 2)}\n`, "utf8");
  const refused = runProxySync(fixtureRoot, "--write");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Invalid agent tool allowlist for telegram-reader/);
  assert.equal(existsSync(resolve(fixtureRoot, ".claude/agents/telegram-reader.md")), false);
  for (const tools of [["Bash"], [], "Read", ["read"]]) {
    armed.agents[0].claude.tools = tools;
    writeFileSync(manifestPath, `${JSON.stringify(armed, null, 2)}\n`, "utf8");
    assert.match(runProxySync(fixtureRoot, "--check").stderr, /Invalid agent tool allowlist/, JSON.stringify(tools));
  }
  armed.agents[0].claude = { tools: ["Read"], model: "haiku", permissionMode: "bypassPermissions" };
  writeFileSync(manifestPath, `${JSON.stringify(armed, null, 2)}\n`, "utf8");
  assert.match(runProxySync(fixtureRoot, "--check").stderr, /Invalid agent tool allowlist/);
});

test("Claude proxy metadata gates every per-role file-backed step", () => {
  for (const skill of explicitSkillNames) {
    const wrapper = readFileSync(
      resolve(repoRoot, `.claude/skills/${skill}/SKILL.md`),
      "utf8",
    );
    assert.match(wrapper, /disable-model-invocation: true/);
  }
});

test("checker detects missing, drifted, and orphan generated inventory without deleting orphans", (t) => {
  const fixtureRoot = createProxyFixture(t);
  const initialWrite = runProxySync(fixtureRoot, "--write");
  assert.equal(initialWrite.status, 0, initialWrite.stderr);
  assert.equal(JSON.parse(initialWrite.stdout).files, 26);
  assert.equal(runProxySync(fixtureRoot, "--check").status, 0);

  const metadataPath = resolve(
    fixtureRoot,
    ".agents/skills/get-vacancy/agents/openai.yaml",
  );
  rmSync(metadataPath);
  const missing = runProxySync(fixtureRoot, "--check");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /\.agents\/skills\/get-vacancy\/agents\/openai\.yaml/);
  assert.equal(runProxySync(fixtureRoot, "--write").status, 0);
  assert.equal(readFileSync(metadataPath, "utf8"), codexPolicy);

  writeFileSync(metadataPath, "policy:\n  allow_implicit_invocation: true\n", "utf8");
  const drifted = runProxySync(fixtureRoot, "--check");
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /\.agents\/skills\/get-vacancy\/agents\/openai\.yaml/);
  assert.equal(runProxySync(fixtureRoot, "--write").status, 0);
  assert.equal(readFileSync(metadataPath, "utf8"), codexPolicy);

  const orphanFile = resolve(
    fixtureRoot,
    ".agents/skills/retired-skill/SKILL.md",
  );
  const orphanDirectory = resolve(
    fixtureRoot,
    ".claude/skills/retired-empty",
  );
  const orphanMetadata = resolve(
    fixtureRoot,
    ".agents/skills/get-vacancy/agents/stale.yaml",
  );
  mkdirSync(dirname(orphanFile), { recursive: true });
  mkdirSync(orphanDirectory, { recursive: true });
  writeFileSync(orphanFile, "orphan-sentinel\n", "utf8");
  writeFileSync(orphanMetadata, "metadata-sentinel\n", "utf8");
  // A hand-written agent beside the generated ones is an orphan too: the agent root is checked.
  const orphanAgent = resolve(fixtureRoot, ".claude/agents/rogue-reader.md");
  writeFileSync(orphanAgent, "---\nname: rogue-reader\ntools: Bash\n---\n", "utf8");

  const orphaned = runProxySync(fixtureRoot, "--check");
  assert.equal(orphaned.status, 1);
  assert.match(orphaned.stderr, /\.agents\/skills\/retired-skill/);
  assert.match(orphaned.stderr, /\.agents\/skills\/get-vacancy\/agents\/stale\.yaml/);
  assert.match(orphaned.stderr, /\.claude\/skills\/retired-empty/);
  assert.match(orphaned.stderr, /\.claude\/agents\/rogue-reader\.md/);

  const writeWithOrphans = runProxySync(fixtureRoot, "--write");
  assert.equal(writeWithOrphans.status, 1);
  assert.equal(existsSync(orphanFile), true);
  assert.equal(readFileSync(orphanFile, "utf8"), "orphan-sentinel\n");
  assert.equal(readFileSync(orphanMetadata, "utf8"), "metadata-sentinel\n");
  assert.match(writeWithOrphans.stderr, /Unexpected generated proxy paths/);
  assert.equal(runProxySync(fixtureRoot, "--check").status, 1);

  rmSync(resolve(fixtureRoot, ".agents/skills/retired-skill"), {
    recursive: true,
  });
  rmSync(orphanDirectory, { recursive: true });
  rmSync(orphanMetadata);
  rmSync(orphanAgent);
  assert.equal(runProxySync(fixtureRoot, "--check").status, 0);
});

test("checker rejects changed runtime roots and never follows generated-path symlinks", (t) => {
  const fixtureRoot = createProxyFixture(t);
  assert.equal(runProxySync(fixtureRoot, "--write").status, 0);

  const metadataPath = resolve(
    fixtureRoot,
    ".agents/skills/get-vacancy/agents/openai.yaml",
  );
  const outsideTarget = resolve(fixtureRoot, "outside-metadata.yaml");
  writeFileSync(outsideTarget, codexPolicy, "utf8");
  rmSync(metadataPath);
  symlinkSync(outsideTarget, metadataPath);

  const symlinkCheck = runProxySync(fixtureRoot, "--check");
  assert.equal(symlinkCheck.status, 1);
  assert.match(symlinkCheck.stderr, /Invalid generated proxy path types/);
  const symlinkWrite = runProxySync(fixtureRoot, "--write");
  assert.equal(symlinkWrite.status, 1);
  assert.equal(readFileSync(outsideTarget, "utf8"), codexPolicy);

  rmSync(metadataPath);
  assert.equal(runProxySync(fixtureRoot, "--write").status, 0);

  const manifestPath = resolve(
    fixtureRoot,
    "instructions/skills/manifest.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.runtimes.codex.skill_root = ".agents/other";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const wrongRoot = runProxySync(fixtureRoot, "--check");
  assert.equal(wrongRoot.status, 1);
  assert.match(wrongRoot.stderr, /Invalid runtime proxy config for codex/);
});

test("write rejects symlinked generated-root ancestors without escaping the repository", (t) => {
  const fixtureRoot = createProxyFixture(t);
  const outsideRoot = mkdtempSync(join(tmpdir(), "job-pipeline-proxies-outside-"));
  t.after(() => rmSync(outsideRoot, { recursive: true, force: true }));
  symlinkSync(outsideRoot, resolve(fixtureRoot, ".agents"));

  const escapedWrite = runProxySync(fixtureRoot, "--write");
  assert.equal(escapedWrite.status, 1);
  assert.match(escapedWrite.stderr, /Invalid generated proxy path types/);
  assert.match(escapedWrite.stderr, /\.agents/);
  assert.deepEqual(readdirSync(outsideRoot), []);
});

test(
  "write repairs expected files before reporting unreadable orphans without traversing them",
  { skip: process.platform === "win32" },
  (t) => {
    const fixtureRoot = createProxyFixture(t);
    assert.equal(runProxySync(fixtureRoot, "--write").status, 0);

    const metadataPath = resolve(
      fixtureRoot,
      ".agents/skills/get-vacancy/agents/openai.yaml",
    );
    const orphanDirectory = resolve(
      fixtureRoot,
      ".agents/skills/unreadable-orphan",
    );
    rmSync(metadataPath);
    mkdirSync(orphanDirectory);
    writeFileSync(resolve(orphanDirectory, "sentinel.txt"), "do-not-read\n", "utf8");
    chmodSync(orphanDirectory, 0o000);

    const writeWithUnreadableOrphan = runProxySync(fixtureRoot, "--write");
    chmodSync(orphanDirectory, 0o700);
    assert.equal(writeWithUnreadableOrphan.status, 1, writeWithUnreadableOrphan.stderr);
    assert.equal(readFileSync(metadataPath, "utf8"), codexPolicy);
    assert.equal(
      JSON.parse(writeWithUnreadableOrphan.stdout).status,
      "written_with_orphans",
    );
    assert.match(
      writeWithUnreadableOrphan.stderr,
      /\.agents\/skills\/unreadable-orphan/,
    );
  },
);

test("manifest fixes every skill to its repository-owned canonical source", (t) => {
  const fixtureRoot = createProxyFixture(t);
  const manifestPath = resolve(
    fixtureRoot,
    "instructions/skills/manifest.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const researchSkill = manifest.skills.find(
    (skill) => skill.name === "research-company",
  );
  const outsideCanonical = resolve(fixtureRoot, "outside-research-company.md");
  writeFileSync(outsideCanonical, "# external canonical\n", "utf8");
  researchSkill.common = outsideCanonical;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const externalReference = runProxySync(fixtureRoot, "--write");
  assert.equal(externalReference.status, 1);
  assert.match(
    externalReference.stderr,
    /Invalid canonical skill path for research-company/,
  );

  researchSkill.common = "instructions/skills/research-company.md";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const canonicalPath = resolve(
    fixtureRoot,
    "instructions/skills/research-company.md",
  );
  rmSync(canonicalPath);
  symlinkSync(outsideCanonical, canonicalPath);

  const symlinkedCanonical = runProxySync(fixtureRoot, "--check");
  assert.equal(symlinkedCanonical.status, 1);
  assert.match(
    symlinkedCanonical.stderr,
    /Invalid canonical skill path for research-company/,
  );
});

test("root proxies declare different runners but the same operating contract", () => {
  const agents = readFileSync(resolve(repoRoot, "AGENTS.md"), "utf8");
  const claude = readFileSync(resolve(repoRoot, "CLAUDE.md"), "utf8");
  assert.match(agents, /`runner_id`: `codex`/);
  assert.match(claude, /`runner_id`: `claude-code`/);
  for (const proxy of [agents, claude]) {
    assert.match(proxy, /read \[instructions\/operating-contract\.md\].*in full/);
  }
});
