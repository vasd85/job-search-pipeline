import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  checkSectionLinks,
  sectionSourceFiles,
  loadSectionExceptions,
} from "../tools/section-links.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function fixture(t, files) {
  const directory = mkdtempSync(join(tmpdir(), "section-links-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), text);
  }
  return directory;
}

test("active repository section references resolve and exact exceptions stay current", () => {
  const exceptions = loadSectionExceptions(root);
  assert.deepEqual(checkSectionLinks({ root, exceptions }), []);
});

test("scope discovers new sources and hidden instructions, but preserves historical records", (t) => {
  const included = [
    "README.md",
    ".gitignore",
    "src/new.ts",
    "instructions/new.md",
    "knowledge/new.md",
    "docs/runbooks/new.md",
    "docs/backlog/README.md",
    "docs/runtime-smoke-checklist.md",
    "tools/new/README.md",
    "tools/new.mjs",
    "tests/new.test.mjs",
    ".agents/skills/new/SKILL.md",
    ".claude/hooks/new.mjs",
    ".github/workflows/new.yml",
    "web/new.js",
    "config/new.json",
    "candidate.example/rules.md",
    "tools/git-hooks/pre-commit",
  ];
  const excluded = [
    "docs/adr/new.md",
    "docs/research/new.md",
    "docs/audits/new.md",
    "docs/backlog/999.md",
    "docs/archive/new.md",
    "docs/product-decisions.md",
    "reference/new.md",
    "candidate/rules.md",
    "output/new.md",
    "node_modules/new.md",
    "tools/new/node_modules/new.js",
  ];
  const workspace = fixture(
    t,
    Object.fromEntries([...included, ...excluded].map((file) => [file, "Text.\n"])),
  );
  assert.deepEqual(sectionSourceFiles(workspace), [...included].sort());
  writeFileSync(join(workspace, "tools/added.py"), "# New source\n");
  assert.ok(sectionSourceFiles(workspace).includes("tools/added.py"));
});

test("numbers are found in prose, comments, messages, quoted continuations and fenced code", (t) => {
  const text =
    "Section 3\nsubsection 2\nSec. 4\nраздела 5\n§7\n> section\n> 9\n```text\nsection 6\n```\n// section\n// 8\n";
  const workspace = fixture(t, {
    "README.md": text,
    "tools/new.js": 'throw Error("section 4");\n',
  });
  assert.deepEqual(
    checkSectionLinks({ root: workspace }).map(({ file, line }) => [file, line]),
    [
      ["README.md", 1],
      ["README.md", 2],
      ["README.md", 3],
      ["README.md", 4],
      ["README.md", 5],
      ["README.md", 6],
      ["README.md", 9],
      ["README.md", 11],
      ["tools/new.js", 1],
    ],
  );
});

test("local links resolve relative to Markdown, from source root, and inside code fences", (t) => {
  const workspace = fixture(t, {
    "docs/runbooks/new.md":
      "# Start\n[own](#start)\n[other](../../README.md#root)\n```text\nREADME.md#root\n```\n",
    "README.md": "# Root\n## Café & Tea\n## Root\n",
    "tools/new.js": '// README.md#caf%C3%A9--tea\nconst message = "README.md#root-1";\n',
  });
  assert.deepEqual(checkSectionLinks({ root: workspace }), []);
  writeFileSync(join(workspace, "README.md"), "# Renamed\n");
  assert.equal(checkSectionLinks({ root: workspace }).length, 4);
});

test("missing files, broken anchors, malformed encodings and escaping paths fail", (t) => {
  const workspace = fixture(t, {
    "README.md":
      "# Root\n[bad](missing.md#absent)\n[bad](#absent)\n[bad](#%ZZ)\n[bad](../outside.md#heading)\n",
  });
  assert.deepEqual(
    checkSectionLinks({ root: workspace }).map(({ line }) => line),
    [2, 3, 4, 5],
  );
});

test("layer links use the example and never the private layer", (t) => {
  const workspace = fixture(t, {
    "README.md": "candidate/profile.md#profile\n[profile](candidate/profile.md#profile)\n",
    "candidate.example/profile.md": "# Profile\n",
    "candidate/profile.md": "# Wrong private heading\n",
  });
  assert.deepEqual(checkSectionLinks({ root: workspace }), []);
  writeFileSync(join(workspace, "candidate.example/profile.md"), "# Wrong example heading\n");
  assert.equal(checkSectionLinks({ root: workspace }).length, 2);
});

test("exact exceptions neither hide neighbours nor survive changed counts or removal", (t) => {
  const workspace = fixture(t, { "README.md": "section 4\nsection 5\n" });
  const exception = {
    file: "README.md",
    text: "section 4",
    count: 1,
    reason: "negative syntax example",
  };
  assert.deepEqual(
    checkSectionLinks({ root: workspace, exceptions: [exception] }).map(({ line }) => line),
    [2],
  );
  for (const text of ["", "section 4\nsection 4\n"]) {
    writeFileSync(join(workspace, "README.md"), text);
    assert.match(
      checkSectionLinks({ root: workspace, exceptions: [exception] })[0].reason,
      /stale or invalid/,
    );
  }
  for (const change of [{ count: 0 }, { reason: "" }, { file: "missing.md" }]) {
    assert.match(
      checkSectionLinks({ root: workspace, exceptions: [{ ...exception, ...change }] })[0].reason,
      /stale or invalid/,
    );
  }
});

test("quoted document pins are checked in the owning document context", (t) => {
  const workspace = fixture(t, {
    "README.md": "# Root\n",
    "tests/new.mjs": 'const pin = "[root](#root)";\n',
  });
  const exception = {
    file: "tests/new.mjs",
    text: "[root](#root)",
    count: 1,
    reason: "quoted document pin",
    document: "README.md",
  };
  assert.deepEqual(checkSectionLinks({ root: workspace, exceptions: [exception] }), []);
  writeFileSync(join(workspace, "README.md"), "# Renamed\n");
  assert.match(checkSectionLinks({ root: workspace, exceptions: [exception] })[0].reason, /has no/);
});

test("external URLs, code-symbol links, numbered headings and procedure steps are not section references", (t) => {
  const workspace = fixture(t, {
    "README.md":
      "# 3. Heading\n[external](https://example.com/a.md#missing)\nhttps://example.com/a.md#missing\nmodule.mjs#symbol\nstep 3, rule 4, cross-section 3\n",
  });
  assert.deepEqual(checkSectionLinks({ root: workspace }), []);
});

test("active section references also resolve throughout the public tree", (t) => {
  const files = [
    ...sectionSourceFiles(root),
    "config/section-link-exceptions.json",
    ...readdirSync(join(root, "docs/adr"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `docs/adr/${name}`),
  ];
  const workspace = fixture(
    t,
    Object.fromEntries(files.map((file) => [file, readFileSync(join(root, file))])),
  );
  assert.deepEqual(
    checkSectionLinks({ root: workspace, exceptions: loadSectionExceptions(workspace) }),
    [],
  );
});

test("source-reference pins survive formatter layout changes and still reject semantic mutations", async (t) => {
  const { format } = await import("prettier");
  const exceptions = loadSectionExceptions(root);
  const files = [
    ...sectionSourceFiles(root),
    "config/section-link-exceptions.json",
    ...readdirSync(join(root, "docs/adr"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `docs/adr/${name}`),
  ];
  const workspace = fixture(
    t,
    Object.fromEntries(files.map((file) => [file, readFileSync(join(root, file))])),
  );
  for (const file of new Set(
    exceptions.filter(({ file }) => file.endsWith(".mjs")).map(({ file }) => file),
  )) {
    const source = readFileSync(join(workspace, file), "utf8");
    const formatted = await format(source, {
      filepath: file,
      singleQuote: true,
      printWidth: 45,
      embeddedLanguageFormatting: "off",
    });
    writeFileSync(join(workspace, file), formatted);
  }
  assert.deepEqual(checkSectionLinks({ root: workspace, exceptions }), []);
  const pin = exceptions.find(
    ({ file, document }) => file === "tests/instruction-contracts.test.mjs" && document,
  );
  const path = join(workspace, pin.file);
  const formatted = readFileSync(path, "utf8");
  for (const source of [
    formatted.replace(pin.text, pin.text.replace(/#[^)]*/u, "#changed-anchor")),
    `${formatted}\n// ${pin.text}\n`,
    `${formatted}\n// README.md#changed-neighbour\n`,
  ]) {
    writeFileSync(path, source);
    assert.notDeepEqual(checkSectionLinks({ root: workspace, exceptions }), []);
  }
});

test("reference exceptions mask complete tokens and keep longer or rooted neighbours visible", (t) => {
  const reference = "target.md" + "#short";
  const workspace = fixture(t, {
    "target.md": "# Short\n",
    "tools/new.js": `${reference}\n${reference}-missing\nrooted/${reference}\n`,
  });
  const exception = {
    file: "tools/new.js",
    text: reference,
    count: 1,
    kind: "reference",
    reason: "document pin",
    document: "target.md",
  };
  assert.deepEqual(
    checkSectionLinks({ root: workspace, exceptions: [exception] }).map(({ line }) => line),
    [2, 3],
  );
  writeFileSync(join(workspace, "tools/new.js"), `${reference}-missing\n`);
  assert.match(
    checkSectionLinks({ root: workspace, exceptions: [exception] })[0].reason,
    /stale or invalid/u,
  );
});
