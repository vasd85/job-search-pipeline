// The candidate layer: the private directory one person's profile, preferences and configured
// values live in, and the tracked example of the same shape the suite runs on.
//
// Three properties are proved here. The layer is invisible to the public repository, so nothing
// personal can reach a commit or an export by accident. Its config is read against a schema that
// carries a version, and every disagreement is a refusal with a code rather than a value read on
// a guess. And the rules and the schema are compared in both directions, so a rule cannot point
// at a setting that does not exist and the config cannot grow a setting nothing reads.
//
// The third check is vacuous today and says so: the key table starts empty because every value
// still sitting inside a rule moves out as its own task. The comparison itself is therefore
// proved on injected fixtures, where both failures are producible, and the pass over the real
// tree is a regression on top of that.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { writeRecord } from "../tools/letter-corrections/corpus.mjs";
import {
  CandidateError,
  candidateErrorCodes,
  candidateConfigPathFor,
  candidateConfigValue,
  candidateDirectoryName,
  candidateExampleDirectoryName,
  candidateExampleRootFor,
  candidateLanguageNames,
  candidateMarkets,
  candidatePriorities,
  candidateLanguages,
  candidateRootFor,
  candidateScoringValues,
  inspectCandidateLayer,
  loadCandidateConfig,
  loadCandidateDocuments,
  validateCandidateConfig,
  validateCandidateScoring,
} from "../tools/candidate/load.mjs";
import {
  candidateDocumentErrorCodes,
  candidateHeadings,
  candidateLeverProperties,
  candidateLeversSourcePath,
  candidateProfileSections,
  candidateProfileSourcePath,
  candidateProjectVisibilities,
  candidateRuleScopes,
  candidateRulesSourcePath,
  validateCandidateLetterSamples,
  validateCandidateLevers,
  validateCandidateProfile,
  validateCandidateRules,
} from "../tools/candidate/documents.mjs";
import {
  candidateKeyReferencesIn,
  compareCandidateKeyCoverage,
  scanCandidateKeyReferences,
} from "../tools/candidate/keys.mjs";
import {
  candidateConfigDistinct,
  candidateConfigKeys,
  candidateConfigRelations,
  candidateConfigSchemaVersion,
  declaredCandidateKeyPaths,
} from "../tools/candidate/schema.mjs";
import { candidatePrioritiesFrom } from "../tools/candidate/priorities.mjs";
import { DOMAIN_FIT_DOMAINS } from "../tools/candidate/scoring.mjs";
import { WEST_COUNTRY_CODES } from "../tools/job-scorer/iso-3166.mjs";
import {
  assertCandidateConstraintsCompatible,
  candidateConstraintFindings,
  candidateConstraintMaterials,
  candidateConstraintTypes,
  candidateConstraintsBasename,
  candidateConstraintsFor,
  candidateConstraintsPathFor,
  candidatePrivateProjectConstraints,
  containsCandidateTerm,
  loadAllCandidateConstraints,
  loadCandidateConstraints,
  parseCandidateConstraints,
  selectCandidateConstraints,
} from "../tools/candidate/constraints.mjs";
import { DEFAULT_LANGUAGE } from "../tools/candidate/languages.mjs";
import { MARKET_SIDES, marketNames, marketSide } from "../tools/candidate/markets.mjs";
import { runCandidatePins } from "../tools/candidate/pins.mjs";
import {
  candidateHeadingAnchors,
  candidateHeadingSlug,
  candidateLayerReferencesIn,
  candidateManifestErrorCodes,
  candidateRunDocuments,
  candidateRunReadmes,
  checkCandidateLayerParity,
  checkCandidateLinks,
  loadCandidateManifest,
  parseCandidateManifest,
} from "../tools/candidate/manifest.mjs";
import { coverLetterEngineForbidden } from "../tools/cover-letter/validate.mjs";
import {
  fileBackedLetterLanguageInputs,
  fileBackedProtectedInputs,
} from "../tools/lib/process-log-v3-lifecycle.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleRoot = candidateExampleRootFor(repoRoot);
// The example's config is the smallest config this engine accepts: every declared key is required.
const exampleConfigText = readFileSync(candidateConfigPathFor(exampleRoot), "utf8");
const exampleConfig = () => JSON.parse(exampleConfigText);

function disposable(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

// A layer with the given config and the example's required documents, so a case about the config
// is not refused for a document it never meant to test.
function layerWith(t, contents, prefix = "job-search-candidate-", { documents = true } = {}) {
  const base = disposable(t, prefix);
  const root = join(base, candidateDirectoryName);
  mkdirSync(root);
  if (contents !== null) writeFileSync(candidateConfigPathFor(root), contents, "utf8");
  if (documents) {
    for (const document of ["profile.md", "levers.md", "rules.md"]) {
      copyFileSync(join(exampleRoot, document), join(root, document));
    }
  }
  // The example's config names a language, so a present layer carries its pack; the documents are
  // read before the packs, so a case about a document still meets the document first.
  cpSync(join(exampleRoot, "languages"), join(root, "languages"), { recursive: true });
  return root;
}

function refusalCode(run) {
  try {
    run();
  } catch (error) {
    assert.equal(error instanceof CandidateError, true, String(error));
    return error.code;
  }
  return null;
}

test("the tracked example is a layer this engine reads", () => {
  const loaded = loadCandidateConfig({ root: exampleRoot });
  assert.equal(loaded.schemaVersion, candidateConfigSchemaVersion);
  assert.equal(loaded.configPath, candidateConfigPathFor(exampleRoot));
  assert.equal(inspectCandidateLayer({ root: exampleRoot }).status, "ready");
});

test("the loader takes its root as a parameter and refuses anything else", (t) => {
  // A loader with a default root would read the operator's real candidate from inside the suite.
  for (const root of [undefined, "", "candidate", "./candidate", "/tmp/../tmp/candidate"]) {
    assert.equal(refusalCode(() => loadCandidateConfig({ root })), "candidate_root_invalid");
  }
  const base = disposable(t, "job-search-candidate-symlink-");
  const outside = join(base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "config.json"), "{\"schema_version\": 3}\n", "utf8");
  // The write boundary judges a target by the worktree it belongs to, so a layer that is really a
  // symbolic link out of the tree would escape it entirely. This reader refuses that root.
  symlinkSync(outside, join(base, candidateDirectoryName));
  assert.equal(
    refusalCode(() => loadCandidateConfig({ root: candidateRootFor(base) })),
    "candidate_root_invalid",
  );
  assert.equal(
    refusalCode(() => inspectCandidateLayer({ root: candidateRootFor(base) })),
    "candidate_root_invalid",
  );
});

test("an absent layer is an answer and a broken one is a refusal", (t) => {
  const base = disposable(t, "job-search-candidate-absent-");
  const inspected = inspectCandidateLayer({ root: candidateRootFor(base) });
  assert.deepEqual(inspected, {
    configPath: null,
    documents: null,
    languages: null,
    root: candidateRootFor(base),
    schemaVersion: null,
    status: "absent",
  });
  assert.equal(
    refusalCode(() => loadCandidateConfig({ root: candidateRootFor(base) })),
    "candidate_root_invalid",
  );
  assert.equal(
    refusalCode(() => inspectCandidateLayer({ root: layerWith(t, null) })),
    "candidate_config_missing",
  );
});

test("every disagreement with the schema is its own code, and a version mismatch throws", (t) => {
  assert.equal(
    refusalCode(() => loadCandidateConfig({ root: layerWith(t, "{ not json\n") })),
    "candidate_config_invalid_json",
  );
  for (const [value, code] of [
    ["[]", "candidate_config_shape_invalid"],
    ["\"text\"", "candidate_config_shape_invalid"],
    ["null", "candidate_config_shape_invalid"],
    ["{}", "candidate_schema_version_missing"],
    ["{\"schema_version\": \"1\"}", "candidate_schema_version_unsupported"],
    ["{\"schema_version\": 1}", "candidate_schema_version_unsupported"],
    ["{\"schema_version\": 3, \"letter\": {\"max_words\": 120}}", "candidate_config_unknown_key"],
  ]) {
    assert.equal(refusalCode(() => validateCandidateConfig(JSON.parse(value))), code, value);
  }
  // A version this engine does not read is a refusal and never a field in a successful report:
  // a config written for another schema is a file whose meaning this code does not know.
  assert.equal(
    refusalCode(() => loadCandidateConfig({ root: layerWith(t, "{\"schema_version\": 99}\n") })),
    "candidate_schema_version_unsupported",
  );
  // A key the schema never declared must not be able to hide behind an empty object: the walk
  // finds no leaf below it, so the path itself has to be what the unknown-key check sees.
  for (const value of [
    { letter: {}, schema_version: 3 },
    { profile: { sections: {} }, schema_version: 3 },
  ]) {
    assert.equal(
      refusalCode(() => validateCandidateConfig(value)),
      "candidate_config_unknown_key",
      JSON.stringify(value),
    );
  }
  // A config the reader cannot open at all is its own refusal, not a missing file.
  const unreadable = layerWith(t, null);
  mkdirSync(candidateConfigPathFor(unreadable));
  assert.equal(
    refusalCode(() => loadCandidateConfig({ root: unreadable })),
    "candidate_config_unreadable",
  );
});

test("a schema entry with a type this reader does not know is a refusal of its own", () => {
  assert.equal(
    refusalCode(() => validateCandidateConfig({ pay: { floor: 1 }, schema_version: 3 }, [
      { path: "pay.floor", type: "number" },
    ])),
    "candidate_schema_key_type_unknown",
  );
});

test("the refusal codes and the tool README name the same set", () => {
  const readme = readFileSync(join(repoRoot, "tools/candidate/README.md"), "utf8");
  for (const code of candidateErrorCodes) {
    assert.equal(readme.includes(`\`${code}\``), true, `README omits ${code}`);
  }
  // And the other direction, so a code deleted from the code stays out of the document too.
  const documented = [...readme.matchAll(/`(candidate_[a-z_]+)`/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(documented)].sort(), [...candidateErrorCodes].sort());
});

test("a declared key is required and typed, in both directions", () => {
  const keys = [{ path: "letter.max_words", type: "integer" }];
  assert.equal(
    refusalCode(() => validateCandidateConfig({ schema_version: 3 }, keys)),
    "candidate_config_key_missing",
  );
  assert.equal(
    refusalCode(() => validateCandidateConfig({ letter: { max_words: "120" }, schema_version: 3 }, keys)),
    "candidate_config_key_type_invalid",
  );
  assert.equal(
    refusalCode(() => validateCandidateConfig({ letter: { max_words: 120, tone: "warm" }, schema_version: 3 }, keys)),
    "candidate_config_unknown_key",
  );
  assert.deepEqual(
    validateCandidateConfig({ letter: { max_words: 120 }, schema_version: 3 }, keys),
    { letter: { max_words: 120 }, schema_version: 3 },
  );
});

test("one reference form is recognised and a placeholder is not", () => {
  const found = candidateKeyReferencesIn([
    "the rule reads `candidate.config.letter.max_words` words",
    "and `candidate.config.cv.page_budget`, and the same one twice:",
    "candidate.config.letter.max_words",
    "the form itself is candidate.config.<key>, which names no key",
    "a bare candidate.config. names none either",
    "Candidate.Config.Shouted is not the form",
  ].join("\n"));
  assert.deepEqual([...found].sort(), ["cv.page_budget", "letter.max_words"]);
});

test("the coverage comparison is red in both directions on an injected root", (t) => {
  const root = disposable(t, "job-search-candidate-keys-");
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "rule.md"), "reads `candidate.config.letter.max_words` words\n", "utf8");
  writeFileSync(join(root, "nested", "other.md"), "and `candidate.config.cv.page_budget`\n", "utf8");
  const referenced = scanCandidateKeyReferences({ roots: [root] });
  assert.deepEqual([...referenced], ["cv.page_budget", "letter.max_words"]);

  // A rule naming a key the schema does not declare.
  assert.deepEqual(
    compareCandidateKeyCoverage({ declared: ["cv.page_budget"], referenced }),
    { undeclared: ["letter.max_words"], unreferenced: [] },
  );
  // A schema key no rule names.
  assert.deepEqual(
    compareCandidateKeyCoverage({ declared: ["cv.page_budget", "letter.max_words", "pay.floor"], referenced }),
    { undeclared: [], unreferenced: ["pay.floor"] },
  );
  assert.deepEqual(
    compareCandidateKeyCoverage({ declared: ["cv.page_budget", "letter.max_words"], referenced }),
    { undeclared: [], unreferenced: [] },
  );
  assert.deepEqual(
    compareCandidateKeyCoverage({ declared: [], referenced: [] }),
    { undeclared: [], unreferenced: [] },
  );
  assert.equal(
    refusalCode(() => scanCandidateKeyReferences({ roots: [] })),
    "candidate_key_root_invalid",
  );
  assert.equal(
    refusalCode(() => scanCandidateKeyReferences({ roots: [join(root, "missing")] })),
    "candidate_key_root_invalid",
  );
});

test("the scanner refuses what it cannot read rather than passing over it", (t) => {
  // Every way a scan can miss a reference makes the comparison pass on a rule naming a key
  // nobody declared — the direction the check exists to catch. So a file it cannot read is a
  // refusal, never a file it walks past.
  const root = disposable(t, "job-search-candidate-unreadable-");
  writeFileSync(join(root, "binary.bin"), Buffer.from([0x63, 0x00, 0x64]));
  assert.equal(
    refusalCode(() => scanCandidateKeyReferences({ roots: [root] })),
    "candidate_key_root_invalid",
  );
  rmSync(join(root, "binary.bin"));
  // UTF-16 carries the same reference and decodes to something the pattern never matches.
  writeFileSync(join(root, "wide.md"), Buffer.from("`candidate.config.pay.floor`", "utf16le"));
  assert.equal(
    refusalCode(() => scanCandidateKeyReferences({ roots: [root] })),
    "candidate_key_root_invalid",
  );
  rmSync(join(root, "wide.md"));
  writeFileSync(join(root, "huge.md"), "x".repeat(4 * 1024 * 1024 + 1));
  assert.equal(
    refusalCode(() => scanCandidateKeyReferences({ roots: [root] })),
    "candidate_key_root_invalid",
  );
  rmSync(join(root, "huge.md"));
  // Not prose either, and the refusal is what keeps a named key from going unseen behind it.
  symlinkSync(join(root, "rule.md"), join(root, "link.md"));
  assert.equal(
    refusalCode(() => scanCandidateKeyReferences({ roots: [root] })),
    "candidate_key_root_invalid",
  );
  rmSync(join(root, "link.md"));
});

test("operating-system metadata is stepped over rather than refused", (t) => {
  // `.DS_Store` carries NUL bytes. Refusing it would turn the coverage check red on whichever
  // machine last opened the folder in a file browser, for a reason having nothing to do with
  // rules or schema — and the file is invisible in `git status`, so the cause would not show.
  const root = disposable(t, "job-search-candidate-osjunk-");
  writeFileSync(join(root, "rule.md"), "reads `candidate.config.pay.floor`\n", "utf8");
  for (const name of [".DS_Store", "._rule.md", "Thumbs.db", "desktop.ini", ".Spotlight-V100"]) {
    writeFileSync(join(root, name), Buffer.from([0x00, 0x01, 0x02]));
  }
  assert.deepEqual([...scanCandidateKeyReferences({ roots: [root] })], ["pay.floor"]);
});

test("the rules and the schema name the same keys", () => {
  const referenced = scanCandidateKeyReferences({
    roots: [join(repoRoot, "knowledge"), join(repoRoot, "instructions")],
  });
  const coverage = compareCandidateKeyCoverage({
    declared: declaredCandidateKeyPaths(),
    referenced,
  });
  assert.deepEqual(coverage.undeclared, [], "rules name a key the schema does not declare");
  assert.deepEqual(coverage.unreferenced, [], "the schema declares a key no rule names");
  // Frozen literally, so the comparison above is never a pass on two empty sets and a key added or
  // dropped on both sides at once is still a visible edit here.
  assert.deepEqual([...referenced], [
    "compensation.floors.comparable_cost_employment.amount",
    "compensation.floors.comparable_cost_employment.basis",
    "compensation.floors.comparable_cost_employment.currencies",
    "compensation.floors.home_contractor.amount",
    "compensation.floors.home_contractor.basis",
    "compensation.floors.home_contractor.currencies",
    "compensation.floors.home_employment.amount",
    "compensation.floors.home_employment.basis",
    "compensation.floors.home_employment.currencies",
    "compensation.floors.outside_home_contractor.amount",
    "compensation.floors.outside_home_contractor.basis",
    "compensation.floors.outside_home_contractor.currencies",
    "compensation.home_currency",
    "compensation.home_rate_provider",
    "compensation.target",
    "cv.file_name_pattern",
    "cv.page_budget",
    "domain_fit.agency_outsourcing_vendor",
    "domain_fit.complex_saas_b2b",
    "domain_fit.data_platforms",
    "domain_fit.developer_tools",
    "domain_fit.distributed_systems",
    "domain_fit.fintech_payments_trading",
    "domain_fit.healthcare_biotech",
    "domain_fit.infra_platforms",
    "domain_fit.marketplaces",
    "domain_fit.media_entertainment",
    "domain_fit.other_complex",
    "domain_fit.security_tooling",
    "domain_fit.telecom",
    "domain_fit.web3",
    "languages.additional",
    "languages.working",
    "letter.body_paragraphs.max",
    "letter.body_paragraphs.min",
    "letter.body_words.approved_max",
    "letter.body_words.max",
    "letter.body_words.min",
    "letter.body_words.target",
    "letter.signature",
    "markets.home.countries",
    "markets.home.name",
    "markets.home.timezone",
    "markets.home.working_hours",
    "markets.outside_home.location",
    "markets.outside_home.name",
    "markets.outside_home.timezone",
    "mobility.excluded_destinations",
    "mobility.feasible_residences",
    "mobility.home_region",
    "mobility.relocation_tiers.high",
    "mobility.relocation_tiers.low",
    "mobility.relocation_tiers.middle",
    "mobility.self_relocation",
    "mobility.west_near_subregion",
    "mobility.west_tier",
    "priorities.relocation_destinations",
    "priorities.relocation_west",
    "priorities.remote_company_regions",
    "scoring.c.below_floor",
    "scoring.c.local",
    "scoring.c.max",
    "scoring.c.reference",
    "scoring.c.start",
    "scoring.c.target",
    "scoring.c.unknown",
    "scoring.d.max",
    "scoring.d.steps",
    "scoring.d.unknown",
    "scoring.m.cap_limits",
    "scoring.m.cap_scores",
    "scoring.m.max",
    "scoring.m.relocation.bonus",
    "scoring.m.relocation.high",
    "scoring.m.relocation.low",
    "scoring.m.relocation.max",
    "scoring.m.relocation.middle",
    "scoring.m.relocation.unknown",
    "scoring.m.remote.broad_open",
    "scoring.m.remote.broad_restricted",
    "scoring.m.remote.far_local_open",
    "scoring.m.remote.far_local_restricted",
    "scoring.m.remote.far_unknown_open",
    "scoring.m.remote.far_unknown_restricted",
    "scoring.m.remote.near_local_open",
    "scoring.m.remote.near_local_restricted",
    "scoring.m.remote.near_unknown_open",
    "scoring.m.remote.near_unknown_restricted",
    "scoring.m.remote.other_far_local",
    "scoring.m.remote.other_far_unknown",
    "scoring.m.remote.other_near",
    "scoring.m.remote.other_unknown",
    "scoring.m.sponsored",
    "scoring.m.unknown",
    "scoring.s.automation.limited",
    "scoring.s.automation.major",
    "scoring.s.automation.max",
    "scoring.s.automation.primary",
    "scoring.s.automation.unknown",
    "scoring.s.max",
    "scoring.s.seniority.lower",
    "scoring.s.seniority.max",
    "scoring.s.seniority.mid",
    "scoring.s.seniority.senior",
    "scoring.s.seniority.unknown",
    "scoring.s.tools.max",
    "tool_match.frameworks",
    "tool_match.languages",
  ]);
});

test("the example carries every key, with the values the suite's letters are written for", () => {
  const { config } = loadCandidateConfig({ root: exampleRoot });
  const values = Object.fromEntries(
    candidateConfigKeys.map((key) => [key.path, candidateConfigValue(config, key.path)]),
  );
  // The pattern carries the example's own name, which a test does not quote: the publishability
  // scan treats the example's names as personal markers. Its shape is what is frozen here.
  assert.match(values["cv.file_name_pattern"], /^[A-Z][a-z]+_[A-Z][a-z]+_CV_<Company>_<Role>\.docx$/);
  delete values["cv.file_name_pattern"];
  // The signature is the same name, in the default language's script.
  assert.match(values["letter.signature"], /^[A-Z][a-z]+ [A-Z][a-z]+$/);
  delete values["letter.signature"];
  // The home country and the stated location are the example's own place, a personal marker too:
  // one capitalized word each, and the example states its home country outside home.
  assert.equal(values["markets.home.countries"].length, 1);
  assert.match(values["markets.home.countries"][0], /^[A-Z][a-z]+$/);
  assert.equal(values["markets.outside_home.location"], values["markets.home.countries"][0]);
  delete values["markets.home.countries"];
  delete values["markets.outside_home.location"];
  // So is its timezone, which the example states at home and outside it alike.
  assert.match(values["markets.home.timezone"], /^UTC[+-]\d{1,2}$/);
  assert.equal(values["markets.outside_home.timezone"], values["markets.home.timezone"]);
  delete values["markets.home.timezone"];
  delete values["markets.outside_home.timezone"];
  assert.deepEqual(values, {
    // The scoring values are fictional and share nothing with any real candidate's, so a scorer
    // literal left behind cannot pass a test that runs on them. The domain placement is the one
    // exception: it follows the example's profile, which states two things about domains, so every
    // domain it is silent on sits on the middle step and the vendor below it - steps a real
    // placement uses too. The scorer's own fixture and the pin that the scorer spells no domain
    // guard D instead.
    "scoring.m.max": 25,
    "scoring.m.unknown": 15,
    "scoring.m.sponsored": 25,
    "scoring.m.remote.broad_open": 25,
    "scoring.m.remote.broad_restricted": 20,
    "scoring.m.remote.far_local_open": 15,
    "scoring.m.remote.far_local_restricted": 10,
    "scoring.m.remote.near_local_open": 25,
    "scoring.m.remote.near_local_restricted": 20,
    "scoring.m.remote.far_unknown_open": 20,
    "scoring.m.remote.far_unknown_restricted": 10,
    "scoring.m.remote.near_unknown_open": 25,
    "scoring.m.remote.near_unknown_restricted": 15,
    "scoring.m.remote.other_near": 25,
    "scoring.m.remote.other_unknown": 20,
    "scoring.m.remote.other_far_unknown": 15,
    "scoring.m.remote.other_far_local": 5,
    "scoring.m.relocation.high": 20,
    "scoring.m.relocation.middle": 10,
    "scoring.m.relocation.low": 0,
    "scoring.m.relocation.unknown": 10,
    "scoring.m.relocation.bonus": 5,
    "scoring.m.relocation.max": 25,
    "scoring.m.cap_scores": [4, 11, 19, 25],
    "scoring.m.cap_limits": [39, 59, 79, 100],
    "scoring.c.max": 35,
    "scoring.c.unknown": 15,
    "scoring.c.local": 15,
    "scoring.c.start": 5,
    "scoring.c.target": 15,
    "scoring.c.below_floor": [4, 3, 2, 1, 0],
    "scoring.c.reference": [35, 31, 24, 17, 10],
    "scoring.s.max": 30,
    "scoring.s.automation.max": 14,
    "scoring.s.automation.primary": 12,
    "scoring.s.automation.major": 8,
    "scoring.s.automation.limited": 4,
    "scoring.s.automation.unknown": 4,
    "scoring.s.seniority.max": 6,
    "scoring.s.seniority.senior": 6,
    "scoring.s.seniority.mid": 3,
    "scoring.s.seniority.lower": 0,
    "scoring.s.seniority.unknown": 3,
    "scoring.s.tools.max": 10,
    "scoring.d.max": 10,
    "scoring.d.unknown": 4,
    "scoring.d.steps": [0, 2, 4, 6, 8, 10],
    "compensation.floors.comparable_cost_employment.amount": 3000,
    "compensation.floors.comparable_cost_employment.basis": "net",
    "compensation.floors.comparable_cost_employment.currencies": ["USD", "SGD"],
    "compensation.floors.home_contractor.amount": 110000,
    "compensation.floors.home_contractor.basis": "gross",
    "compensation.floors.home_contractor.currencies": ["THB"],
    "compensation.floors.home_employment.amount": 90000,
    "compensation.floors.home_employment.basis": "net",
    "compensation.floors.home_employment.currencies": ["THB"],
    "compensation.floors.outside_home_contractor.amount": 3500,
    "compensation.floors.outside_home_contractor.basis": "gross",
    "compensation.floors.outside_home_contractor.currencies": ["USD"],
    "compensation.home_currency": "THB",
    "compensation.home_rate_provider": "BOT",
    "compensation.target": 4500,
    "cv.page_budget": 2,
    "domain_fit.agency_outsourcing_vendor": 2,
    "domain_fit.complex_saas_b2b": 4,
    "domain_fit.data_platforms": 4,
    "domain_fit.developer_tools": 4,
    "domain_fit.distributed_systems": 4,
    "domain_fit.fintech_payments_trading": 4,
    "domain_fit.healthcare_biotech": 4,
    "domain_fit.infra_platforms": 4,
    "domain_fit.marketplaces": 4,
    "domain_fit.media_entertainment": 4,
    "domain_fit.other_complex": 4,
    "domain_fit.security_tooling": 4,
    "domain_fit.telecom": 4,
    "domain_fit.web3": 4,
    "languages.additional": ["Greek"],
    "languages.working": "English",
    "letter.body_paragraphs.max": 5,
    "letter.body_paragraphs.min": 4,
    "letter.body_words.approved_max": 300,
    "letter.body_words.max": 260,
    "letter.body_words.min": 230,
    "letter.body_words.target": 250,
    "markets.home.name": "domestic",
    "markets.home.working_hours": "09:00-19:00",
    "markets.outside_home.name": "international",
    "mobility.excluded_destinations": ["AQ"],
    "mobility.feasible_residences": ["KH", "LA", "TH", "VN"],
    "mobility.home_region": ["TH"],
    "mobility.relocation_tiers.high": ["AU", "JP", "KR", "SG"],
    "mobility.relocation_tiers.low": ["KH", "LA", "TH", "VN"],
    "mobility.relocation_tiers.middle": ["MY", "PH"],
    "mobility.self_relocation": ["KH", "LA", "VN"],
    "mobility.west_near_subregion": "EU_UK",
    "mobility.west_tier": "middle",
    "priorities.relocation_destinations": ["JP"],
    "priorities.relocation_west": false,
    "priorities.remote_company_regions": ["HOME"],
    "tool_match.languages": [{name:"TypeScript",points:4,experience:"direct"},{name:"Java",points:1,experience:"transferable"},{name:"Python",points:5,experience:"direct"}],
    "tool_match.frameworks": [{name:"Playwright",points:4,experience:"direct"},{name:"REST Assured",points:2,experience:"transferable"},{name:"PyTest",points:5,experience:"direct"}],
  });
  assert.throws(() => candidateConfigValue(config, "letter.body_words.floor"), TypeError);
  // The validated config is frozen all the way down: a reader cannot move a limit for the next one.
  assert.equal(Object.isFrozen(config.letter.body_words), true);
});

test("a value is checked against its bound and against the keys it is ordered with", () => {
  const with_ = (path, value) => {
    const config = exampleConfig();
    const segments = path.split(".");
    let entry = config;
    for (const segment of segments.slice(0, -1)) entry = entry[segment];
    entry[segments.at(-1)] = value;
    return config;
  };
  const refused = (config) => refusalCode(() => validateCandidateConfig(config));
  // Each ordering, broken by one step and nothing else.
  for (const [path, value] of [
    ["letter.body_paragraphs.min", 6],
    ["letter.body_words.min", 251],
    ["letter.body_words.target", 261],
    ["letter.body_words.approved_max", 259],
    ["letter.body_words.max", 249],
  ]) {
    assert.equal(refused(with_(path, value)), "candidate_config_value_invalid", `${path} = ${value}`);
  }
  // Equal ends are allowed: an approved maximum equal to the maximum switches approvals off.
  assert.equal(refused(with_("letter.body_words.approved_max", 260)), null);
  assert.equal(refused(with_("letter.body_paragraphs.min", 5)), null);
  assert.equal(refused(with_("cv.page_budget", 0)), "candidate_config_value_invalid");
  assert.equal(refused(with_("cv.page_budget", 1)), null);
  for (const pattern of [
    "Name_CV_<Company>_<Role>.pdf",
    "Name_CV_<Company>.docx",
    "Name_CV_<Role>.docx",
    "Name_CV_<Company>_<Company>_<Role>.docx",
    "cvs/Name_CV_<Company>_<Role>.docx",
    "cvs\\Name_CV_<Company>_<Role>.docx",
    ".Name_CV_<Company>_<Role>.docx",
  ]) {
    assert.equal(refused(with_("cv.file_name_pattern", pattern)), "candidate_config_value_invalid", pattern);
  }
  assert.equal(refused(with_("cv.file_name_pattern", "CV_<Role>_<Company>_Name.docx")), null);
  // The refusal names the key and never the value: the value is the candidate's own.
  try {
    validateCandidateConfig(with_("cv.file_name_pattern", "Secret_Person_CV.docx"));
    assert.fail("a pattern without placeholders must be refused");
  } catch (error) {
    assert.match(error.message, /cv\.file_name_pattern/);
    assert.doesNotMatch(error.message, /Secret_Person/);
  }
});

test("the markets are checked against their bounds, and the two names differ", () => {
  const with_ = (side, key, value) => {
    const config = exampleConfig();
    config.markets[side][key] = value;
    return config;
  };
  const refused = (config) => refusalCode(() => validateCandidateConfig(config));
  for (const name of ["", "Domestic", "home market", "home_market", "-home", "home-", "home--market", "9home", "a".repeat(41)]) {
    assert.equal(refused(with_("home", "name", name)), "candidate_config_value_invalid", JSON.stringify(name));
  }
  for (const name of ["home", "home-market", "eu2", "a".repeat(40)]) {
    assert.equal(refused(with_("home", "name", name)), null, name);
  }
  // Two markets with one name would make every artifact's market both of them at once.
  assert.equal(refused(with_("home", "name", "international")), "candidate_config_value_invalid");
  for (const timezone of ["Invalid timezone:15", "UTC+15", "UTC-15", "UTC\u20133", "Invalid timezone", "utc+3", "UTC+03", "UTC +3", "+3"]) {
    assert.equal(refused(with_("home", "timezone", timezone)), "candidate_config_value_invalid", timezone);
    assert.equal(refused(with_("outside_home", "timezone", timezone)), "candidate_config_value_invalid", timezone);
  }
  for (const timezone of ["UTC", "UTC+0", "UTC-3", "UTC+14", "UTC-12", "UTC+5:30", "UTC+5:45"]) {
    assert.equal(refused(with_("home", "timezone", timezone)), null, timezone);
  }
  // The working hours: two different clock times, the end 24:00 at the latest; an end before the
  // start is a window across midnight, not a mistake.
  for (const hours of [
    "08:00-08:00", "8:00-21:00", "08:00-21", "08:00 - 21:00", "08:00\u201321:00", "24:00-08:00",
    "08:00-24:30", "08:60-21:00", "25:00-21:00", "08:00-21:00-22:00", "", "08:00",
  ]) {
    assert.equal(refused(with_("home", "working_hours", hours)), "candidate_config_value_invalid", hours);
  }
  for (const hours of ["08:00-21:00", "09:30-18:15", "00:00-24:00", "22:00-06:00", "23:59-00:00"]) {
    assert.equal(refused(with_("home", "working_hours", hours)), null, hours);
  }
  assert.equal(refused(with_("home", "working_hours", 8)), "candidate_config_key_type_invalid");
  const withoutHours = exampleConfig();
  delete withoutHours.markets.home.working_hours;
  assert.equal(refused(withoutHours), "candidate_config_key_missing");
  for (const countries of [[], ["Aland", "Aland"], ["Aland\nBorvia"], [" Aland"], [""]]) {
    assert.equal(refused(with_("home", "countries", countries)), "candidate_config_value_invalid", JSON.stringify(countries));
  }
  assert.equal(refused(with_("home", "countries", ["Aland", "Borvia"])), null);
  for (const location of ["", "Two\nlines", " Padded"]) {
    assert.equal(refused(with_("outside_home", "location", location)), "candidate_config_value_invalid", JSON.stringify(location));
  }
  // The refusal names the keys and never the values: the names are the candidate's own.
  try {
    validateCandidateConfig(with_("outside_home", "name", "domestic"));
    assert.fail("two markets with one name must be refused");
  } catch (error) {
    assert.match(error.message, /markets\.home\.name and markets\.outside_home\.name must differ/);
    assert.doesNotMatch(error.message, /domestic/);
  }
});

test("the scoring values are checked against their bounds and against each other", () => {
  const with_ = (path, value) => {
    const config = exampleConfig();
    const segments = path.split(".");
    let entry = config;
    for (const segment of segments.slice(0, -1)) entry = entry[segment];
    entry[segments.at(-1)] = value;
    return config;
  };
  const refused = (config) => refusalCode(() => validateCandidateConfig(config));
  const invalid = "candidate_config_value_invalid";
  // Bounds of one value.
  for (const [path, value] of [
    ["mobility.feasible_residences", []],
    ["mobility.feasible_residences", ["TH", "ZZ"]],
    ["mobility.feasible_residences", ["TH", "th"]],
    ["mobility.feasible_residences", ["TH", "TH"]],
    ["mobility.home_region", []],
    ["mobility.excluded_destinations", ["XK"]],
    ["mobility.relocation_tiers.middle", ["MY", "MY"]],
    ["mobility.west_tier", "top"],
    ["mobility.west_near_subregion", "EU"],
    ["compensation.home_currency", "thb"],
    ["compensation.home_currency", "BAHT"],
    ["compensation.home_rate_provider", "ECB"],
    ["compensation.home_rate_provider", "bot"],
    ["compensation.floors.home_employment.basis", "unknown"],
    ["compensation.floors.home_employment.currencies", []],
    ["compensation.floors.home_employment.currencies", ["THB", "THB"]],
    ["compensation.floors.home_employment.currencies", ["thb"]],
    ["compensation.floors.home_employment.amount", 0],
  ]) {
    assert.equal(refused(with_(path, value)), invalid, `${path} = ${JSON.stringify(value)}`);
  }
  // Every list that says where the candidate lives or relocates refuses a WEST country; the
  // excluded destinations do not, because excluding a country asks nothing of the WEST premise.
  for (const path of [
    "mobility.home_region",
    "mobility.feasible_residences",
    "mobility.self_relocation",
    "mobility.relocation_tiers.high",
    "mobility.relocation_tiers.middle",
    "mobility.relocation_tiers.low",
  ]) {
    const config = exampleConfig();
    const segments = path.split(".");
    let entry = config;
    for (const segment of segments.slice(0, -1)) entry = entry[segment];
    entry[segments.at(-1)] = [...entry[segments.at(-1)], "DE"];
    assert.equal(refused(config), invalid, path);
  }
  assert.equal(refused(with_("mobility.excluded_destinations", ["AQ", "MT"])), null);
  assert.equal(refused(with_("mobility.excluded_destinations", [])), null);
  assert.equal(refused(with_("mobility.self_relocation", [])), null);
  // The lists nest and stay apart.
  assert.equal(refused(with_("mobility.home_region", ["TH", "MY"])), invalid);
  assert.equal(refused(with_("mobility.self_relocation", ["KH", "MY"])), invalid);
  assert.equal(refused(with_("mobility.excluded_destinations", ["KH"])), invalid);
  assert.equal(refused(with_("mobility.excluded_destinations", ["MY"])), invalid);
  assert.equal(refused(with_("mobility.relocation_tiers.middle", ["MY", "SG"])), invalid);
  assert.equal(refused(with_("mobility.relocation_tiers.middle", ["MY", "TH"])), invalid);
  // The contractor curve needs a target strictly above its floor.
  assert.equal(refused(with_("compensation.target", 3500)), invalid);
  assert.equal(refused(with_("compensation.target", 3501)), null);
  // The refusal names the keys and never the values: the values are the candidate's own.
  try {
    validateCandidateConfig(with_("mobility.excluded_destinations", ["KH"]));
    assert.fail("an excluded residence must be refused");
  } catch (error) {
    assert.match(error.message, /mobility\.excluded_destinations and mobility\.feasible_residences must share no member/);
    assert.doesNotMatch(error.message, /KH/);
  }
});

test("the scoring values a scorer input carries are the config's, checked by the same rules", (t) => {
  const values = candidateScoringValues({ root: exampleRoot });
  const { config } = loadCandidateConfig({ root: exampleRoot });
  // The config's own shape: everything under mobility, compensation, tool_match and domain_fit but
  // the set rule 10 reads.
  assert.deepEqual(Object.keys(values).sort(), ["compensation", "domain_fit", "mobility", "scoring", "tool_match"]);
  assert.deepEqual(values.compensation, JSON.parse(JSON.stringify(config.compensation)));
  assert.deepEqual(values.domain_fit, JSON.parse(JSON.stringify(config.domain_fit)));
  assert.deepEqual(values.tool_match, JSON.parse(JSON.stringify(config.tool_match)));
  const { self_relocation: _selfRelocation, ...mobility } = config.mobility;
  assert.deepEqual(values.mobility, JSON.parse(JSON.stringify(mobility)));
  assert.equal(Object.isFrozen(values.mobility.relocation_tiers), true);
  assert.deepEqual(validateCandidateScoring(values), values);
  // The same bounds and relations, restricted to the part the input carries.
  const broken = structuredClone(values);
  broken.mobility.home_region = ["MY"];
  assert.equal(refusalCode(() => validateCandidateScoring(broken)), "candidate_config_value_invalid");
  const extra = structuredClone(values);
  extra.mobility.self_relocation = [];
  assert.equal(refusalCode(() => validateCandidateScoring(extra)), "candidate_config_unknown_key");
  assert.equal(refusalCode(() => validateCandidateScoring(null)), "candidate_config_shape_invalid");
  // A checkout without a layer configures nothing to score against.
  const base = disposable(t, "job-search-no-layer-");
  assert.equal(candidateScoringValues({ root: join(base, candidateDirectoryName) }), null);
});

test("independent ToolMatch prices are bounded, canonical, unique and honest about experience", () => {
  const invalid = "candidate_config_value_invalid";
  for (const key of ["languages", "frameworks"]) {
    const canonical = key === "languages" ? "Java" : "Playwright";
    for (const entry of [
      {name:canonical,points:-1,experience:"direct"}, {name:canonical,points:6,experience:"direct"},
      {name:canonical,points:1.5,experience:"direct"}, {name:canonical,points:NaN,experience:"direct"},
      {name:canonical,points:Infinity,experience:"direct"}, {name:canonical,points:1,experience:"none"},
      {name:canonical,points:1,experience:"unknown"}, {name:canonical,points:1,experience:"invented"},
      {name:canonical.toLowerCase(),points:1,experience:"direct"}, {name:canonical,points:1,experience:"direct",extra:true},
    ]) {
      const config = exampleConfig(); config.tool_match[key] = [entry];
      assert.equal(refusalCode(() => validateCandidateConfig(config)), invalid);
    }
    for (const points of [0,5]) {
      const config=exampleConfig(); config.tool_match[key]=[{name:canonical,points,experience:"direct"}];
      assert.equal(refusalCode(() => validateCandidateConfig(config)), null);
      const duplicate=structuredClone(config); duplicate.tool_match[key].push({...duplicate.tool_match[key][0]});
      assert.equal(refusalCode(() => validateCandidateConfig(duplicate)), invalid);
    }
    const empty=exampleConfig(); empty.tool_match[key]=[];
    assert.equal(refusalCode(() => validateCandidateConfig(empty)), null);
    const missing=structuredClone(empty); delete missing.tool_match[key];
    assert.equal(refusalCode(() => validateCandidateConfig(missing)), "candidate_config_key_missing");
  }
  const old=exampleConfig(); old.schema_version=2;
  assert.equal(refusalCode(() => validateCandidateConfig(old)), "candidate_schema_version_unsupported");
  const wrong=exampleConfig(); wrong.scoring.s.tools.max=0;
  assert.equal(refusalCode(() => validateCandidateConfig(wrong)), invalid);
});

test("the Domain Fit placement puts every domain of the engine on one step of the scale", () => {
  // The vocabulary is the engine's and frozen here; the scorer input accepts exactly these names
  // besides the two it scores itself, and each one is a key of its own.
  assert.deepEqual([...DOMAIN_FIT_DOMAINS], [
    "agency_outsourcing_vendor",
    "complex_saas_b2b",
    "data_platforms",
    "developer_tools",
    "distributed_systems",
    "fintech_payments_trading",
    "healthcare_biotech",
    "infra_platforms",
    "marketplaces",
    "media_entertainment",
    "other_complex",
    "security_tooling",
    "telecom",
    "web3",
  ]);
  assert.deepEqual(exampleConfig().scoring.d.steps, [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(
    candidateConfigKeys.filter((key) => key.path.startsWith("domain_fit.")).map((key) => [key.path, key.type]),
    DOMAIN_FIT_DOMAINS.map((name) => [`domain_fit.${name}`, "integer"]),
  );
  const with_ = (name, value) => {
    const config = exampleConfig();
    config.domain_fit[name] = value;
    return config;
  };
  const refused = (config) => refusalCode(() => validateCandidateConfig(config));
  for (const step of [0, 2, 4, 6, 8, 10]) assert.equal(refused(with_("web3", step)), null, String(step));
  // Between two steps, outside the scale, or not a whole number: the D middle is read off the steps,
  // so a value between them would be a scale the record does not define.
  for (const value of [-3, 1, 5, 7, 11, 16, 30]) {
    assert.equal(refused(with_("web3", value)), "candidate_config_value_invalid", String(value));
  }
  for (const value of [6.5, "15", null]) {
    assert.equal(refused(with_("web3", value)), "candidate_config_key_type_invalid", String(value));
  }
  // Every domain is placed, and only the engine's.
  const missing = exampleConfig();
  delete missing.domain_fit.telecom;
  assert.equal(refused(missing), "candidate_config_key_missing");
  assert.equal(refused(with_("logistics", 9)), "candidate_config_unknown_key");
  assert.equal(refused(with_("unclear", 6)), "candidate_config_unknown_key");
  assert.equal(refused(with_("irrelevant", 0)), "candidate_config_unknown_key");
  // The refusal names the key and the steps, never the value.
  try {
    validateCandidateConfig(with_("media_entertainment", 11));
    assert.fail("a value between two steps must be refused");
  } catch (error) {
    assert.match(error.message, /domain points must be declared domain steps$/);
    assert.doesNotMatch(error.message, /11/);
  }
});

test("the priorities are checked against their bounds and kept apart from the excluded destinations", () => {
  const with_ = (key, value) => {
    const config = exampleConfig();
    config.priorities[key] = value;
    return config;
  };
  const refused = (config) => refusalCode(() => validateCandidateConfig(config));
  const invalid = "candidate_config_value_invalid";
  for (const regions of [["UNKNOWN"], ["West"], ["WEST", "WEST"], ["EU"]]) {
    assert.equal(refused(with_("remote_company_regions", regions)), invalid, JSON.stringify(regions));
  }
  for (const regions of [[], ["WEST"], ["OTHER", "HOME", "WEST"]]) {
    assert.equal(refused(with_("remote_company_regions", regions)), null, JSON.stringify(regions));
  }
  for (const destinations of [["jp"], ["XK"], ["JP", "JP"], ["WEST"], ["Japan"]]) {
    assert.equal(refused(with_("relocation_destinations", destinations)), invalid, JSON.stringify(destinations));
  }
  // A WEST country may be named on its own: without the flag the region is not ranked as a whole.
  for (const destinations of [[], ["DE"], ["DE", "JP"]]) {
    assert.equal(refused(with_("relocation_destinations", destinations)), null, JSON.stringify(destinations));
  }
  // An excluded destination is never a ranked one.
  assert.equal(refused(with_("relocation_destinations", ["JP", "AQ"])), invalid);
  for (const flag of ["true", 1, null]) {
    assert.equal(refused(with_("relocation_west", flag)), "candidate_config_key_type_invalid", String(flag));
  }
  assert.equal(refused(with_("relocation_west", true)), null);
  const missing = exampleConfig();
  delete missing.priorities.relocation_west;
  assert.equal(refused(missing), "candidate_config_key_missing");
});

test("the priorities of a layer spell out the ranked destinations, less the excluded ones", (t) => {
  assert.deepEqual(JSON.parse(JSON.stringify(candidatePriorities({ root: exampleRoot }))), {
    remoteCompanyRegions: ["HOME"],
    relocationWest: false,
    relocationCountries: ["JP"],
  });
  // With the flag set, the whole WEST region is ranked, and an excluded WEST country is taken out.
  const config = exampleConfig();
  config.priorities.relocation_west = true;
  config.mobility.excluded_destinations = ["AQ", "MT"];
  const priorities = candidatePrioritiesFrom(validateCandidateConfig(config));
  assert.equal(priorities.relocationWest, true);
  assert.equal(priorities.relocationCountries.includes("DE"), true);
  assert.equal(priorities.relocationCountries.includes("JP"), true);
  assert.equal(priorities.relocationCountries.includes("MT"), false);
  assert.equal(priorities.relocationCountries.length, WEST_COUNTRY_CODES.length);
  assert.equal(Object.isFrozen(priorities.relocationCountries), true);
  // Nothing about the priorities travels in the scorer input.
  assert.deepEqual(Object.keys(candidateScoringValues({ root: exampleRoot })).sort(), ["compensation", "domain_fit", "mobility", "scoring", "tool_match"]);
  const base = disposable(t, "job-search-no-layer-");
  assert.equal(candidatePriorities({ root: join(base, candidateDirectoryName) }), null);
});

test("the markets of a layer are read from its config alone, and a checkout without one has none", (t) => {
  const markets = candidateMarkets({ root: exampleRoot });
  assert.equal(markets.home.name, "domestic");
  assert.equal(markets.outsideHome.name, "international");
  assert.equal(markets.home.timezone, candidateConfigValue(loadCandidateConfig({ root: exampleRoot }).config, "markets.home.timezone"));
  assert.equal(markets.outsideHome.timezone, markets.home.timezone);
  assert.equal(markets.home.workingHours, "09:00-19:00");
  assert.equal(Object.isFrozen(markets.home.countries), true);
  assert.equal(marketSide(markets, "domestic"), MARKET_SIDES.home);
  assert.equal(marketSide(markets, "international"), MARKET_SIDES.outsideHome);
  assert.equal(marketSide(markets, "elsewhere"), null);
  assert.equal(marketSide(null, "domestic"), null);
  assert.deepEqual(marketNames(markets), ["domestic", "international"]);
  assert.deepEqual(marketNames(null), []);
  const base = disposable(t, "job-search-no-layer-");
  assert.equal(candidateMarkets({ root: join(base, candidateDirectoryName) }), null);
  // A present config that cannot be read is a refusal, never an answer of "no markets".
  const broken = layerWith(t, "{", "job-search-broken-markets-");
  assert.equal(refusalCode(() => candidateMarkets({ root: broken })), "candidate_config_invalid_json");
});

test("the orderings follow the key table they belong to", () => {
  // An injected table gets no default orderings: they name keys it does not declare.
  const keys = [{ path: "letter.max_words", type: "integer" }];
  assert.deepEqual(
    validateCandidateConfig({ letter: { max_words: 120 }, schema_version: 3 }, keys),
    { letter: { max_words: 120 }, schema_version: 3 },
  );
  // An ordering over a key the table does not declare as an integer is the schema's fault.
  for (const relations of [
    [{ lower: "letter.max_words", upper: "letter.min_words" }],
    [{ lower: "letter.tone", upper: "letter.max_words" }],
  ]) {
    assert.equal(
      refusalCode(() => validateCandidateConfig(
        { letter: { max_words: 120, tone: "warm" }, schema_version: 3 },
        [...keys, { path: "letter.tone", type: "string" }],
        relations,
      )),
      "candidate_schema_relation_invalid",
      JSON.stringify(relations),
    );
  }
  // A pair that must differ, over a key the table does not declare as a string, is the schema's
  // fault as well.
  assert.equal(
    refusalCode(() => validateCandidateConfig(
      { letter: { max_words: 120, tone: "warm" }, schema_version: 3 },
      [...keys, { path: "letter.tone", type: "string" }],
      [],
      [{ one: "letter.tone", other: "letter.max_words" }],
    )),
    "candidate_schema_relation_invalid",
  );
  // The default table's pairs each name two of its own string keys.
  const strings = new Set(candidateConfigKeys.filter((key) => key.type === "string").map((key) => key.path));
  for (const { one, other } of candidateConfigDistinct) {
    assert.equal(strings.has(one) && strings.has(other), true, `${one} != ${other}`);
  }
  // The default table's orderings each name two of its own integer keys.
  const integers = new Set(candidateConfigKeys.filter((key) => key.type === "integer").map((key) => key.path));
  for (const { lower, upper } of candidateConfigRelations) {
    assert.equal(integers.has(lower) && integers.has(upper), true, `${lower} <= ${upper}`);
  }
});

test("the private layer is invisible to the public repository", () => {
  const ignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
  assert.match(ignore, /^\/candidate\/$/m);
  // Asked of Git rather than read off the pattern. The trailing slash makes the rule match a
  // directory, so the spelling that proves it is a path inside the layer, not the bare name.
  const ignored = spawnSync("git", ["check-ignore", "--quiet", join(candidateDirectoryName, "config.json")], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(ignored.status, 0, ignored.stderr);
  // The example is tracked and must stay outside the rule, or the suite would lose its fixture.
  const example = spawnSync("git", ["check-ignore", "--quiet", join(candidateExampleDirectoryName, "config.json")], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(example.status, 1, example.stderr);
});

// ---------------------------------------------------------------------------
// The constraints file: the personal rules a machine can check.
//
// Three shapes, one matching predicate, and a merge that only ever adds. The tests below prove
// the parts a reader cannot check by eye: that every refusal has its own code, that the two
// replacement types are told apart mechanically rather than by intention, that a constraint
// narrows to the material it names, and that nothing in the file can lift an engine constraint —
// not by a field, and not by requiring what the engine forbids.

const exampleConstraints = JSON.parse(
  readFileSync(candidateConstraintsPathFor(exampleRoot), "utf8"),
);

// The entries the example's profile derives, one per private project (candidate/profile.md#102-quiet-ledger-private and candidate/profile.md#104-shelfwise-private), frozen
// here rather than read from the module under test.
const examplePrivateIds = ["private-project-10-2", "private-project-10-4"];

// A present layer always carries its profile, and the constraints of the layer include what the
// profile derives, so a layer built for a constraints case carries the example's profile too.
function constraintsLayer(t, value, prefix = "job-search-constraints-") {
  const base = disposable(t, prefix);
  const root = join(base, candidateDirectoryName);
  mkdirSync(root);
  copyFileSync(join(exampleRoot, "profile.md"), join(root, "profile.md"));
  writeFileSync(
    candidateConstraintsPathFor(root),
    typeof value === "string" ? value : JSON.stringify(value),
    "utf8",
  );
  return root;
}

// `undefined` in an override drops the key rather than leaving it present and empty, because the
// reader refuses an unknown field and `phrases` is not a field of the other two types.
function entry(overrides = {}) {
  const value = {
    id: "no-name",
    type: "forbid_phrases",
    scope: { materials: ["cover_letter"] },
    phrases: ["Jordan Vale"],
    why: "A private contact asked not to be named.",
    ...overrides,
  };
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) delete value[key];
  }
  return value;
}

function file(constraints) {
  return { schema_version: 1, constraints };
}

test("the tracked example carries one constraint of each type", () => {
  const parsed = parseCandidateConstraints(exampleConstraints);
  assert.deepEqual(parsed.map((item) => item.type).sort(), [...candidateConstraintTypes].sort());
  // Every type is represented exactly once, so the example exercises the whole vocabulary and a
  // type added to the engine without an example entry turns this red.
  assert.equal(new Set(parsed.map((item) => item.type)).size, candidateConstraintTypes.length);
  for (const item of parsed) {
    assert.match(item.id, /^[a-z][a-z0-9-]*$/u);
    assert.ok(item.why.length > 0);
  }
});

test("the example's constraints load from the tracked layer", () => {
  const loaded = loadCandidateConstraints({ root: exampleRoot });
  assert.equal(loaded.status, "ready");
  assert.equal(loaded.path, candidateConstraintsPathFor(exampleRoot));
  assert.equal(loaded.constraints.length, exampleConstraints.constraints.length);
});

test("an absent file and an absent layer both constrain nothing", (t) => {
  // Unlike the config reader, which refuses a root that is not there. It has to differ: this one
  // is read wherever the layer is checked, and a development worktree has no layer by
  // construction, so a refusal here would redden every check that runs outside the operator's
  // own checkout.
  const base = disposable(t, "job-search-constraints-absent-");
  const withoutLayer = loadCandidateConstraints({ root: candidateRootFor(base) });
  assert.equal(withoutLayer.status, "absent");
  assert.deepEqual([...withoutLayer.constraints], []);
  const layer = join(base, candidateDirectoryName);
  mkdirSync(layer);
  const withoutFile = loadCandidateConstraints({ root: layer });
  assert.equal(withoutFile.status, "absent");
  assert.deepEqual([...withoutFile.constraints], []);
});

test("the constraints root must be an absolute normalized path", () => {
  for (const root of ["", "relative/candidate", "/tmp/../tmp/candidate", 7]) {
    assert.equal(
      refusalCode(() => loadCandidateConstraints({ root })),
      "candidate_root_invalid",
      String(root),
    );
  }
});

test("a present but unreadable constraints file is a refusal, never an empty layer", (t) => {
  assert.equal(
    refusalCode(() => loadCandidateConstraints({ root: constraintsLayer(t, "{ not json\n") })),
    "candidate_constraints_invalid_json",
  );
  const directoryInstead = join(disposable(t, "job-search-constraints-dir-"), candidateDirectoryName);
  mkdirSync(directoryInstead);
  mkdirSync(candidateConstraintsPathFor(directoryInstead));
  assert.equal(
    refusalCode(() => loadCandidateConstraints({ root: directoryInstead })),
    "candidate_constraints_unreadable",
  );
});

test("every disagreement with the constraints schema has its own code", () => {
  const cases = [
    [[], "candidate_constraints_shape_invalid"],
    ["text", "candidate_constraints_shape_invalid"],
    [{ constraints: [] }, "candidate_constraints_schema_version_missing"],
    [{ schema_version: 2, constraints: [] }, "candidate_constraints_schema_version_unsupported"],
    [{ schema_version: 1, constraints: [], extra: 1 }, "candidate_constraints_shape_invalid"],
    [{ schema_version: 1 }, "candidate_constraints_shape_invalid"],
    [file(["text"]), "candidate_constraints_shape_invalid"],
    [file([entry({ id: "Bad Id" })]), "candidate_constraint_id_invalid"],
    [file([entry(), entry()]), "candidate_constraint_id_duplicate"],
    [file([entry({ type: "forbid_words" })]), "candidate_constraint_type_unknown"],
    [file([{ ...entry(), disable: "no-name" }]), "candidate_constraint_unknown_field"],
    [file([entry({ scope: { materials: [] } })]), "candidate_constraint_scope_invalid"],
    [file([entry({ scope: { materials: ["letter"] } })]), "candidate_constraint_scope_invalid"],
    [file([entry({ scope: { materials: ["cv"], languages: ["English"] } })]), "candidate_constraint_scope_invalid"],
    [file([entry({ phrases: [] })]), "candidate_constraint_payload_invalid"],
    [file([entry({ phrases: [""] })]), "candidate_constraint_payload_invalid"],
    [file([entry({ why: "" })]), "candidate_constraint_why_invalid"],
    [file([entry({ why: "x".repeat(201) })]), "candidate_constraint_why_invalid"],
  ];
  for (const [value, code] of cases) {
    assert.equal(refusalCode(() => parseCandidateConstraints(value)), code, JSON.stringify(value));
  }
});

test("a spelling is one word and a term may be a phrase", () => {
  const spelling = (value) => file([entry({
    id: "spelling",
    type: "required_spellings",
    spelling: value,
    instead_of: ["Kestrelvail"],
    phrases: undefined,
  })]);
  assert.equal(refusalCode(() => parseCandidateConstraints(spelling("Kestrelvale"))), null);
  // The shape rule is what keeps the two replacement types apart: a phrase cannot be a spelling,
  // so an entry that means "prefer this wording" cannot be filed as one by accident.
  assert.equal(
    refusalCode(() => parseCandidateConstraints(spelling("Kestrelvale Limited"))),
    "candidate_constraint_payload_invalid",
  );
  assert.equal(
    refusalCode(() => parseCandidateConstraints(file([entry({
      id: "spelling",
      type: "required_spellings",
      spelling: "Kestrelvale",
      instead_of: ["Kestrelvail Limited"],
      phrases: undefined,
    })]))),
    "candidate_constraint_payload_invalid",
  );
  // `phrases` belongs to forbid_phrases alone: left on a prefer_terms entry it is an unknown
  // field, so a type changed without its payload is refused rather than half-read.
  assert.equal(
    refusalCode(() => parseCandidateConstraints(file([entry({
      id: "terms",
      type: "prefer_terms",
      prefer: "regression suite",
      avoid: ["regression pack"],
    })]))),
    "candidate_constraint_unknown_field",
  );
});

test("a spelling is matched with case distinguished and a term without", () => {
  const constraints = parseCandidateConstraints(file([
    entry({
      id: "spelling",
      type: "required_spellings",
      spelling: "Kestrelvale",
      instead_of: ["Kestrelvail"],
      scope: { materials: ["cv"] },
      phrases: undefined,
    }),
    entry({
      id: "terms",
      type: "prefer_terms",
      prefer: "regression suite",
      avoid: ["regression pack"],
      scope: { materials: ["cv"] },
      phrases: undefined,
    }),
  ]));
  const findings = (text) => candidateConstraintFindings(constraints, text, { artifact: "cv.json" });
  assert.equal(findings("I worked at Kestrelvail.").length, 1);
  // The same word in another case is a different spelling and not this one.
  assert.deepEqual(findings("I worked at kestrelvail."), []);
  // A term is that term however it is capitalized.
  assert.equal(findings("We ran a Regression Pack nightly.").length, 1);
  assert.deepEqual(findings("Nothing here matches."), []);
});

test("the matching predicate takes whole terms across line breaks only", () => {
  assert.equal(containsCandidateTerm("a regression pack ran", "regression pack"), true);
  assert.equal(containsCandidateTerm("a regression\n   pack ran", "regression pack"), true);
  // A term inside a longer word is not that term.
  assert.equal(containsCandidateTerm("repackaged", "pack"), false);
  assert.equal(containsCandidateTerm("Pack it", "pack"), true);
  assert.equal(containsCandidateTerm("Pack it", "pack", { caseSensitive: true }), false);
  // A payload is escaped, not treated as a pattern.
  assert.equal(containsCandidateTerm("a b", "a.b"), false);
});

test("a constraint applies only to the materials it names", () => {
  const constraints = parseCandidateConstraints(file([
    entry({ id: "letter-only", scope: { materials: ["cover_letter"] } }),
    entry({ id: "cv-only", scope: { materials: ["cv"] }, phrases: ["Kestrelvail"] }),
    entry({ id: "both", scope: { materials: ["cover_letter", "cv"] }, phrases: ["Tarn Holloway"] }),
  ]));
  assert.deepEqual(
    selectCandidateConstraints(constraints, { material: "cv" }).map((item) => item.id),
    ["cv-only", "both"],
  );
  assert.deepEqual(
    selectCandidateConstraints(constraints, { material: "cover_letter" }).map((item) => item.id),
    ["letter-only", "both"],
  );
  assert.equal(
    refusalCode(() => selectCandidateConstraints(constraints, { material: "letter" })),
    "candidate_constraint_scope_invalid",
  );
});

test("a finding names the constraint and never the text it matched", () => {
  const constraints = parseCandidateConstraints(file([
    entry({ id: "no-name", phrases: ["Jordan Vale"], why: "A private contact." }),
    entry({
      id: "terms",
      type: "prefer_terms",
      prefer: "regression suite",
      avoid: ["regression pack"],
      why: "Reviewers call it a suite.",
      phrases: undefined,
    }),
    entry({
      id: "spelling",
      type: "required_spellings",
      spelling: "Kestrelvale",
      instead_of: ["Kestrelvail"],
      why: "The employer spells it this way.",
      phrases: undefined,
    }),
  ]));
  const text = "Jordan Vale introduced me; we ran a regression pack at Kestrelvail.";
  const findings = candidateConstraintFindings(constraints, text, { artifact: "cover-letter.txt" });
  assert.equal(findings.length, 3);
  const joined = findings.join("\n");
  // The forbidden phrase, the avoided wording and every `why` stay out of the message: it travels
  // into the publication error and the session transcript, and a ban on a name is a ban on
  // repeating it.
  for (const secret of ["Jordan Vale", "regression pack", "Kestrelvail", "private contact", "spells it"]) {
    assert.equal(joined.includes(secret), false, secret);
  }
  // What the author is expected to write is named, because it is going into the material anyway.
  assert.match(joined, /write "regression suite"/u);
  assert.match(joined, /spell it "Kestrelvale"/u);
  for (const id of ["no-name", "terms", "spelling"]) assert.match(joined, new RegExp(`"${id}"`, "u"));
});

test("a candidate entry cannot make required what the engine forbids", () => {
  const compatible = (overrides) => refusalCode(() => assertCandidateConstraintsCompatible(
    parseCandidateConstraints(file([entry(overrides)])),
    { engineForbidden: coverLetterEngineForbidden },
  ));
  // A term the letter validator refuses, made the preferred wording.
  assert.equal(
    compatible({ id: "terms", type: "prefer_terms", prefer: "excited", avoid: ["keen"], phrases: undefined }),
    "candidate_constraint_conflicts_with_engine",
  );
  // A required spelling carrying forbidden typography. The engine matches typography as a plain
  // substring, which no whole-term predicate would catch: this is why the engine's own predicates
  // are passed in rather than reimplemented.
  assert.equal(
    compatible({
      id: "spelling",
      type: "required_spellings",
      spelling: "front—end",
      instead_of: ["frontend"],
      phrases: undefined,
    }),
    "candidate_constraint_conflicts_with_engine",
  );
  // Forbidding again what the engine already forbids is a duplicate, not a conflict.
  assert.equal(compatible({ phrases: ["excited"] }), null);
  assert.equal(compatible({}), null);
});

test("every refusal the constraints reader throws is in the frozen code list", () => {
  const source = readFileSync(join(repoRoot, "tools/candidate/constraints.mjs"), "utf8");
  const thrown = [...source.matchAll(/fail\(\s*"(candidate_[a-z_]+)"/gu)].map((match) => match[1]);
  assert.ok(thrown.length > 0);
  for (const code of new Set(thrown)) {
    assert.equal(candidateErrorCodes.includes(code), true, `${code} is not in candidateErrorCodes`);
  }
});

test("the vocabulary and the tool README name the same types and materials", () => {
  const readme = readFileSync(join(repoRoot, "tools/candidate/README.md"), "utf8");
  for (const type of candidateConstraintTypes) {
    assert.equal(readme.includes(`\`${type}\``), true, `README omits ${type}`);
  }
  for (const material of candidateConstraintMaterials) {
    assert.equal(readme.includes(`\`${material}\``), true, `README omits ${material}`);
  }
  // And the other direction, so a type dropped from the engine leaves the document too.
  const documented = [...readme.matchAll(/`(forbid_[a-z_]+|prefer_[a-z_]+|required_[a-z_]+)`/gu)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(documented)].sort(), [...candidateConstraintTypes].sort());
  assert.equal(readme.includes(`\`${candidateConstraintsBasename}\``), true);
});

test("the layer check reports how many constraints it read and fails on a broken file", (t) => {
  const cli = (root) => spawnSync(
    process.execPath,
    [join(repoRoot, "tools/candidate/cli.mjs"), "--check", "--root", root],
    { encoding: "utf8" },
  );
  const good = cli(exampleRoot);
  assert.equal(good.status, 0, good.stderr);
  const report = JSON.parse(good.stdout);
  assert.equal(report.constraints_status, "ready");
  // The layer's own entries, the two its profile derives and the one of the Greek pack.
  assert.equal(report.constraints_count, exampleConstraints.constraints.length + 2 + 1);
  assert.deepEqual(report.languages, ["English", "Greek"]);
  assert.equal(report.pins_run, 5);

  // A misspelt file name is the reason the count is printed at all: without it an empty layer and
  // a file nothing reads look the same.
  // A layer with the default language alone: no pack, so no pack constraints either.
  const defaultOnly = exampleConfig();
  defaultOnly.languages.additional = [];
  const empty = layerWith(t, JSON.stringify(defaultOnly));
  rmSync(join(empty, "languages"), { recursive: true });
  const emptyReport = JSON.parse(cli(empty).stdout);
  assert.deepEqual(emptyReport.languages, ["English"]);
  assert.equal(emptyReport.pins_run, 0);
  assert.equal(emptyReport.constraints_status, "absent");
  // No file, but the profile's two private projects still derive their bans.
  assert.equal(emptyReport.constraints_count, 2);

  const broken = layerWith(t, exampleConfigText);
  writeFileSync(candidateConstraintsPathFor(broken), "{ not json\n", "utf8");
  const run = cli(broken);
  assert.equal(run.status, 1);
  assert.equal(JSON.parse(run.stderr).error.code, "candidate_constraints_invalid_json");
  assert.equal(run.stdout, "");
});

test("the layer check reads the letter-correction corpus in the layer and in the run", (t) => {
  const cli = (argv, workspaceRoot) => spawnSync(
    process.execPath,
    [join(repoRoot, "tools/candidate/cli.mjs"), "--check", ...argv],
    {
      encoding: "utf8",
      env: workspaceRoot === undefined
        ? process.env
        : { ...process.env, JOB_PIPELINE_WORKSPACE_ROOT: workspaceRoot },
    },
  );
  // Records written the way step 5 writes them; git is answered as "no repository here", which is
  // what a disposable root outside every checkout really is.
  const noRepository = () => ({
    error: undefined,
    status: 128,
    stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
    stdout: "",
  });
  const corpusWith = (directory, ids) => {
    mkdirSync(join(directory, "records"), { recursive: true });
    for (const id of ids) {
      writeRecord(directory, {
        afterState: "published",
        beforeIndex: 0,
        channel: "chat_command",
        classes: [],
        companyRole: "example-role",
        fragmentAfter: "after",
        fragmentBefore: "before",
        language: "Greek",
        occurredOn: "2026-09-24",
        origin: "revision",
        processId: "proc_a",
        publicationAfter: "pub_b",
        publicationBefore: "pub_a",
        sourceRef: null,
        userReason: "reason",
        userReasonAbsent: null,
      }, { languages: ["English", "Greek"], randomId: () => id, spawnSync: noRepository });
    }
  };

  const layer = layerWith(t, exampleConfigText);
  const workspace = dirname(layer);
  const layerCorpus = join(layer, "research", "letter-corrections");
  const runCorpus = join(workspace, "records", "letter-corrections");

  // No corpus anywhere: two nulls, and with a root handed in the run is not read at all.
  const bare = JSON.parse(cli([], workspace).stdout);
  assert.deepEqual(bare.letter_corrections, { layer: null, run: null });
  corpusWith(layerCorpus, ["a00000000001", "a00000000002"]);
  corpusWith(runCorpus, ["b00000000001"]);
  assert.deepEqual(JSON.parse(cli([], workspace).stdout).letter_corrections, { layer: 2, run: 1 });
  const rooted = cli(["--root", layer], workspace);
  assert.equal(rooted.status, 0, rooted.stderr);
  assert.deepEqual(JSON.parse(rooted.stdout).letter_corrections, { layer: 2, run: "not_checked" });

  // A broken record is red in either home, and the refusal names the home and the file.
  const refusal = (run, home, file) => {
    assert.equal(run.status, 1);
    assert.equal(run.stdout, "");
    const { error } = JSON.parse(run.stderr);
    assert.equal(error.code, "corpus_record_invalid");
    assert.match(error.message, new RegExp(`^${home} corpus: ${file}`, "u"));
  };
  writeFileSync(join(runCorpus, "records", "lc_b00000000002.json"), "{\n");
  refusal(cli([], workspace), "run", "lc_b00000000002\\.json");
  rmSync(join(runCorpus, "records", "lc_b00000000002.json"));
  const renamed = join(layerCorpus, "records", "lc_a00000000009.json");
  renameSync(join(layerCorpus, "records", "lc_a00000000002.json"), renamed);
  refusal(cli(["--root", layer], workspace), "layer", "lc_a00000000009\\.json");
  refusal(cli([], workspace), "layer", "lc_a00000000009\\.json");
});

test("the composition both production callers use narrows before it compares", (t) => {
  // The order is the whole test. Each material has its own engine list, so a constraint is
  // compared only with the list of the material it binds. Comparing first would let a legitimate
  // CV entry — an employer's name spelled with a typographic apostrophe, which only the letter
  // forbids — refuse every letter publication in the checkout.
  const root = constraintsLayer(t, file([
    entry({
      id: "employer-apostrophe",
      type: "required_spellings",
      scope: { materials: ["cv"] },
      spelling: "O’Brien",
      instead_of: ["OBrien"],
      phrases: undefined,
    }),
    entry({ id: "letter-name", scope: { materials: ["cover_letter"] }, phrases: ["Jordan Vale"] }),
  ]), "job-search-constraints-for-");

  const forCv = candidateConstraintsFor({ engineForbidden: [], material: "cv", root });
  assert.deepEqual(forCv.map((item) => item.id), ["employer-apostrophe", ...examplePrivateIds]);

  const forLetter = candidateConstraintsFor({
    engineForbidden: coverLetterEngineForbidden,
    material: "cover_letter",
    root,
  });
  assert.deepEqual(forLetter.map((item) => item.id), ["letter-name", ...examplePrivateIds]);

  // And the check still bites on the material it belongs to.
  const conflicting = constraintsLayer(t, file([entry({
    id: "letter-apostrophe",
    type: "required_spellings",
    scope: { materials: ["cover_letter"] },
    spelling: "O’Brien",
    instead_of: ["OBrien"],
    phrases: undefined,
  })]), "job-search-constraints-conflict-");
  assert.equal(
    refusalCode(() => candidateConstraintsFor({
      engineForbidden: coverLetterEngineForbidden,
      material: "cover_letter",
      root: conflicting,
    })),
    "candidate_constraint_conflicts_with_engine",
  );
});

// Task 158. A private project is never named in a material, and the ban is keyed to the
// `**Visibility:**` line of its profile entry and nothing else: the engine derives one
// `forbid_phrases` entry per private project, so the same text passes for a public project's name
// and is refused for a private one's.
test("a private project's name is refused in both materials and a public one's is not, by the visibility line alone", (t) => {
  const findings = (root, material, text) => candidateConstraintFindings(
    candidateConstraintsFor({ material, root }),
    text,
    { artifact: material === "cv" ? "cv.json" : "cover-letter.txt" },
  );
  for (const material of ["cv", "cover_letter"]) {
    assert.deepEqual(findings(exampleRoot, material, "Built lindenbench and contract-kata."), []);
    for (const text of [
      "Built quiet-ledger on weekends.",
      "Built Quiet-Ledger on weekends.",
      "Code: https://github.com/example/quiet-ledger",
    ]) {
      assert.equal(findings(exampleRoot, material, text).length, 1, `${material}: ${text}`);
    }
    // Matched between letters and digits: a longer word or another spelling is not the name.
    assert.deepEqual(findings(exampleRoot, material, "quiet-ledgers and quiet_ledger"), []);
  }
  // The finding names the derived entry and never repeats the name.
  const [message] = findings(exampleRoot, "cv", "Built shelfwise.");
  assert.equal(message, 'cv.json breaks candidate constraint "private-project-10-4" (forbid_phrases)');
  assert.equal(message.includes("shelfwise"), false);

  // The key is the line, not the heading: candidate/profile.md#102-quiet-ledger-private keeps "(private)" in its heading and turns public.
  const turnedPublic = exampleCopy(t, "job-search-candidate-visibility-");
  const profilePath = join(turnedPublic, "profile.md");
  const profile = readFileSync(profilePath, "utf8");
  const flipped = profile.replace(
    "### 10.2. quiet-ledger (private)\n\n**Visibility:** private",
    "### 10.2. quiet-ledger (private)\n\n**Visibility:** public",
  );
  assert.notEqual(flipped, profile);
  writeFileSync(profilePath, flipped, "utf8");
  assert.deepEqual(findings(turnedPublic, "cv", "Built quiet-ledger."), []);
  assert.equal(findings(turnedPublic, "cv", "Built shelfwise.").length, 1);

  // A heading without a qualifier names the project whole.
  const bare = validateCandidateProfile(profile.replace("### 10.4. shelfwise (private)", "### 10.4. shelfwise"));
  assert.deepEqual(
    candidatePrivateProjectConstraints(bare).map((item) => [item.id, [...item.terms], [...item.scope.materials]]),
    [
      ["private-project-10-2", ["quiet-ledger"], ["cover_letter", "cv"]],
      ["private-project-10-4", ["shelfwise"], ["cover_letter", "cv"]],
    ],
  );
  // No layer derives nothing; a present layer without its profile is refused, not read as none.
  assert.deepEqual(candidatePrivateProjectConstraints(null), []);
  const missingRoot = join(disposable(t, "job-search-candidate-no-layer-"), candidateDirectoryName);
  assert.deepEqual(candidateConstraintsFor({ material: "cv", root: missingRoot }), []);
  const withoutProfile = exampleCopy(t, "job-search-candidate-no-profile-");
  rmSync(join(withoutProfile, "profile.md"));
  assert.equal(
    refusalCode(() => candidateConstraintsFor({ material: "cv", root: withoutProfile })),
    "candidate_document_missing",
  );
  // The prefix of a derived id is refused in a file, so a written entry never meets a derived one.
  assert.equal(
    refusalCode(() => parseCandidateConstraints(file([entry({ id: "private-project-10-2" })]))),
    "candidate_constraint_id_invalid",
  );
});

test("an entry that refuses its own required wording is refused", () => {
  // The same unsatisfiable pair the engine check catches, with both halves inside one record.
  // Without this the author gets a finding telling them to write what they already wrote.
  assert.equal(
    refusalCode(() => parseCandidateConstraints(file([entry({
      id: "self",
      type: "prefer_terms",
      prefer: "regression suite",
      avoid: ["regression"],
      phrases: undefined,
    })]))),
    "candidate_constraint_payload_invalid",
  );
  assert.equal(
    refusalCode(() => parseCandidateConstraints(file([entry({
      id: "self",
      type: "required_spellings",
      spelling: "Kestrelvale",
      instead_of: ["Kestrelvale"],
      phrases: undefined,
    })]))),
    "candidate_constraint_payload_invalid",
  );
  // A term is a term however it is capitalized, so a preferred wording that differs from an
  // avoided one only in case is still self-refusing. Without this the case flag could be frozen
  // to `true` here and nothing would notice.
  assert.equal(
    refusalCode(() => parseCandidateConstraints(file([entry({
      id: "self-case",
      type: "prefer_terms",
      prefer: "Regression Suite",
      avoid: ["regression suite"],
      phrases: undefined,
    })]))),
    "candidate_constraint_payload_invalid",
  );
  // A spelling differing only in case is not self-refusing: that is exactly the pair the type
  // exists to express.
  assert.equal(
    refusalCode(() => parseCandidateConstraints(file([entry({
      id: "case",
      type: "required_spellings",
      spelling: "Kestrelvale",
      instead_of: ["kestrelvale"],
      phrases: undefined,
    })]))),
    null,
  );
});

test("the reader's bounds are refusals, not truncations", (t) => {
  const many = Array.from({ length: 201 }, (_, index) => entry({ id: `id-${index}` }));
  assert.equal(
    refusalCode(() => parseCandidateConstraints(file(many))),
    "candidate_constraints_shape_invalid",
  );
  assert.equal(
    refusalCode(() => parseCandidateConstraints(file([entry({ phrases: ["x".repeat(101)] })]))),
    "candidate_constraint_payload_invalid",
  );
  assert.equal(
    refusalCode(() => parseCandidateConstraints(file([entry({
      phrases: Array.from({ length: 51 }, (_, index) => `phrase ${index}`),
    })]))),
    "candidate_constraint_payload_invalid",
  );
  // A control character in a term would travel into a message and into the ledger's bounded text.
  const bell = String.fromCharCode(7);
  assert.equal(
    refusalCode(() => parseCandidateConstraints(file([entry({ phrases: [`a${bell}b`] })]))),
    "candidate_constraint_payload_invalid",
  );
  assert.equal(
    refusalCode(() => parseCandidateConstraints(file([entry({ why: "two\nlines" })]))),
    "candidate_constraint_why_invalid",
  );
  // A file larger than the reader accepts is refused before it is parsed at all.
  const root = constraintsLayer(
    t,
    `{"schema_version": 1, "note": "${"x".repeat(300 * 1024)}", "constraints": []}`,
    "job-search-constraints-big-",
  );
  assert.equal(
    refusalCode(() => loadCandidateConstraints({ root })),
    "candidate_constraints_unreadable",
  );
});

// The four documents of the layer. The example is the only layer the suite reads; the real one
// is checked by `npm run candidate:check` in the checkout that holds it.

const exampleText = (basename) => readFileSync(join(exampleRoot, basename), "utf8");

function documentRefusal(run) {
  const code = refusalCode(run);
  assert.equal(candidateDocumentErrorCodes.includes(code), true, `${code} is not a document code`);
  return code;
}

test("the profile section map is frozen: numbers, English titles, one optional section", () => {
  // Frozen here as a literal rather than read back from the module, so an edit of the map is a
  // visible edit of this list too. Public rules cite these numbers.
  assert.deepEqual(
    candidateProfileSections.map((entry) => [
      "#".repeat(entry.level),
      entry.number,
      entry.title,
      entry.entries ?? null,
      entry.optional === true,
    ]),
    [
      ["##", "1", "Contacts & Logistics", null, false],
      ["##", "2", "Role & Seniority", null, false],
      ["##", "3", "Career Target & Priorities", null, false],
      ["##", "4", "Compensation", null, false],
      ["##", "5", "Professional Identity", null, false],
      ["##", "6", "Technical Skills", null, false],
      ["###", "6.1", "Languages", null, false],
      ["###", "6.2", "Test Automation Frameworks & Tools", null, false],
      ["###", "6.3", "CI/CD & Infrastructure", null, false],
      ["###", "6.4", "Domain Skills", null, false],
      ["###", "6.5", "AI Tooling in Engineering Workflow", null, false],
      ["####", "6.5.1", "AI-assisted QA workflow", null, false],
      ["####", "6.5.2", "Agentic AI infrastructure", null, false],
      ["###", "6.6", "Other Technical Skills", null, false],
      ["##", "7", "Explicit Gaps", null, false],
      ["##", "8", "Work Approach & Team Style", null, false],
      ["###", null, "Decision-making", null, false],
      ["###", null, "Communication", null, false],
      ["###", null, "Values in a team", null, false],
      ["###", null, "Working style", null, false],
      ["###", null, "Strengths", null, false],
      ["###", null, "Risk areas", null, false],
      ["##", "9", "Experience", "employer", false],
      ["##", "10", "Personal Projects", "project", false],
      ["##", "11", "Education", null, false],
      ["##", "12", "How to Present Short Tenures and the Current Situation", null, true],
    ],
  );
  assert.deepEqual([...candidateProjectVisibilities], ["private", "public"]);
  assert.deepEqual([...candidateLeverProperties], ["ai-infrastructure", "ai-practice"]);
  assert.equal(candidateProfileSourcePath, "candidate/profile.md");
  assert.equal(candidateLeversSourcePath, "candidate/levers.md");
  assert.equal(candidateRulesSourcePath, "candidate/rules.md");
});

test("the tracked example's documents pass their form, with its AI properties off the usual numbers", () => {
  const documents = loadCandidateDocuments({ root: exampleRoot });
  assert.equal(documents.profile.schemaVersion, 2);
  assert.deepEqual(
    documents.profile.projects.map((project) => [project.number, project.name, project.visibility]),
    [
      ["10.1", "lindenbench", "public"],
      ["10.2", "quiet-ledger", "private"],
      ["10.3", "contract-kata", "public"],
      ["10.4", "shelfwise", "private"],
      ["10.5", "playwright-starter", "public"],
    ],
  );
  assert.equal(documents.profile.employers.length, 3);
  const withProperty = (property) => documents.levers.levers
    .filter((lever) => lever.properties.includes(property))
    .map((lever) => lever.id);
  // A rule that still keys on the numbers 2 and 6 would find nothing here.
  assert.deepEqual(withProperty("ai-practice"), [3]);
  assert.deepEqual(withProperty("ai-infrastructure"), [5]);
  assert.deepEqual(documents.letterSamples.languages, ["English"]);
  assert.equal(documents.letterSamples.samples.length, 1);
  assert.deepEqual(inspectCandidateLayer({ root: exampleRoot }).documents, {
    letterSamples: 1,
    levers: 5,
    projects: 5,
    rules: documents.rules.rules.length,
  });
});

test("every disagreement of a profile with the map is refused with its own code", () => {
  const profile = exampleText("profile.md");
  const refused = (text) => documentRefusal(() => validateCandidateProfile(text));

  assert.equal(refused(profile.replace("<!-- candidate-profile-schema: 2 -->\n", "")), "candidate_profile_schema_version_missing");
  // A profile of the first map, whose fixed headings could carry a qualifier, is not read.
  assert.equal(refused(profile.replace("candidate-profile-schema: 2", "candidate-profile-schema: 1")), "candidate_profile_schema_version_unsupported");
  // Two sections swapped, a title renamed, a number skipped inside a list, an employer entry
  // without its role, and a section the map does not have.
  const second = profile.slice(profile.indexOf("## 2. "), profile.indexOf("## 3. "));
  const third = profile.slice(profile.indexOf("## 3. "), profile.indexOf("## 4. "));
  assert.equal(refused(profile.replace(second + third, third + second)), "candidate_profile_heading_invalid");
  assert.equal(refused(profile.replace("## 4. Compensation", "## 4. Salary")), "candidate_profile_heading_invalid");
  assert.equal(refused(profile.replace("### 9.3. ", "### 9.4. ")), "candidate_profile_heading_invalid");
  // The heading is read from the profile: the example's names are markers, and a test that spelt
  // one would be the leak the publishability suite looks for.
  const lastEmployer = profile.split("\n").find((line) => line.startsWith("### 9.3. "));
  assert.equal(refused(profile.replace(lastEmployer, lastEmployer.slice(0, lastEmployer.lastIndexOf(" - ")))), "candidate_profile_heading_invalid");
  assert.equal(refused(`${profile}\n## 13. Hobbies\n`), "candidate_profile_heading_invalid");
  assert.equal(refused(profile.replace("### Strengths", "### Superpowers")), "candidate_profile_heading_invalid");
  // A fixed heading is word for word: a qualifier changes the anchor a public rule links to.
  assert.equal(refused(profile.replace("## 11. Education", "## 11. Education (formal)")), "candidate_profile_heading_invalid");
  assert.equal(refused(profile.replace("### Risk areas", "### Risk areas (self-aware)")), "candidate_profile_heading_invalid");

  // The visibility line: missing, outside the closed set, or twice.
  assert.equal(refused(profile.replace("**Visibility:** private\n\nA private agent", "A private agent")), "candidate_profile_visibility_invalid");
  assert.equal(refused(profile.replace("**Visibility:** private\n\nA private agent", "**Visibility:** internal\n\nA private agent")), "candidate_profile_visibility_invalid");
  assert.equal(refused(profile.replace("**Visibility:** private\n\nA private agent", "**Visibility:** private\n**Visibility:** public\n\nA private agent")), "candidate_profile_visibility_invalid");

  // What the map allows: the last section absent, a qualifier after an entry's title, a heading
  // inside a fence, and headings of the candidate's own below an entry.
  const withoutTwelve = profile.slice(0, profile.indexOf("## 12. "));
  assert.equal(validateCandidateProfile(withoutTwelve).projects.length, 5);
  const lastProject = profile.split("\n").find((line) => line.startsWith("### 10.5. "));
  assert.equal(validateCandidateProfile(profile.replace(lastProject, `${lastProject} (kept)`)).projects[4].visibility, "public");
  const fenced = profile.replace("## 11. Education\n", "```text\n## 13. Not a heading\n```\n\n## 11. Education\n");
  assert.equal(validateCandidateProfile(fenced).schemaVersion, 2);
  const deeper = profile.replace("**Visibility:** private\n\nA private agent", "**Visibility:** private\n\n#### Notes\n\nA private agent");
  assert.equal(validateCandidateProfile(deeper).projects[1].visibility, "private");
  // The line counts anywhere in the entry, under its own subsections too, and never inside a fence.
  const underSubsection = profile.replace("**Visibility:** private\n\nA private agent", "#### Notes\n\n**Visibility:** private\n\nA private agent");
  assert.equal(validateCandidateProfile(underSubsection).projects[1].visibility, "private");
  assert.equal(refused(profile.replace("**Visibility:** private\n\nA private agent", "**Visibility:** private\n\n#### Notes\n\n**Visibility:** public\n\nA private agent")), "candidate_profile_visibility_invalid");
  assert.equal(refused(profile.replace("**Visibility:** private\n\nA private agent", "```text\n**Visibility:** private\n```\n\nA private agent")), "candidate_profile_visibility_invalid");
});

test("every disagreement of a lever bank with its format is refused", () => {
  const levers = exampleText("levers.md");
  const refused = (text) => documentRefusal(() => validateCandidateLevers(text));
  const invalid = "candidate_levers_invalid";

  assert.equal(refused(levers.replace("## Lever 2", "## Lever 3").replace("## Lever 3\n\nStatement: AI", "## Lever 4\n\nStatement: AI")), invalid);
  assert.equal(refused(levers.replace("Weight: 5", "Weight: 6")), invalid);
  assert.equal(refused(levers.replace("Weight: 5\nCondition: broad", "Weight: 5\nCondition: sometimes")), invalid);
  assert.equal(refused(levers.replace("Properties: ai-practice", "Properties: ai-magic")), invalid);
  assert.equal(refused(levers.replace("Properties: ai-practice", "Properties: ai-practice, ai-practice")), invalid);
  assert.equal(refused(levers.replace("## Positioning", "## Placement")), invalid);
  assert.equal(refused(`${levers}\n## Notes\n\nMore.\n`), invalid);
  // A bank that stops after its last lever has no positioning at all, which is a refusal too.
  assert.equal(refused(levers.slice(0, levers.indexOf("## Positioning"))), invalid);
  assert.equal(refused(levers.replace("Weight: 5\nCondition: broad", "Condition: broad\nWeight: 5")), invalid);
  assert.equal(refused(levers.replace("Statement: A test framework run as a maintained product.\n", "")), invalid);
  assert.equal(refused(levers.replace("Condition: conditional — the role owns", "Condition: conditional —the role owns")), invalid);

  // The stance is optional, and a lever's own subheadings are prose.
  assert.equal(validateCandidateLevers(levers.slice(0, levers.indexOf("## Stance"))).levers.length, 5);
  const parsed = validateCandidateLevers(levers.replace("Stories:\n", "### Stories\n"));
  assert.deepEqual(parsed.levers[3], {
    condition: "conditional",
    id: 4,
    properties: [],
    statement: "Contract tests that keep services honest with their clients.",
    trigger: "the role owns an API with several consumers",
    weight: 2,
  });
});

test("the letter samples name their languages once and hold one section per letter", () => {
  const samples = exampleText("letter-samples.md");
  const refused = (text) => documentRefusal(() => validateCandidateLetterSamples(text));
  assert.equal(refused(samples.replace("Covered languages: English\n", "")), "candidate_letter_samples_invalid");
  assert.equal(refused(samples.replace("Covered languages: English", "Covered languages: English, English")), "candidate_letter_samples_invalid");
  assert.equal(refused(samples.replace("Covered languages: English", "Covered languages: English\nCovered languages: German")), "candidate_letter_samples_invalid");
  // A file with no letter yet says which languages it covers and holds nothing else.
  const empty = validateCandidateLetterSamples("# Letter Samples\n\nCovered languages: English\n");
  assert.deepEqual(empty, { languages: ["English"], samples: [] });
});

test("a present layer needs its profile, lever bank and rules, and names the config first", (t) => {
  const config = exampleConfigText;
  const bare = layerWith(t, config, undefined, { documents: false });
  assert.equal(documentRefusal(() => inspectCandidateLayer({ root: bare })), "candidate_document_missing");
  // Each of the three required documents is required on its own.
  const leversOnly = layerWith(t, config, undefined, { documents: false });
  copyFileSync(join(exampleRoot, "levers.md"), join(leversOnly, "levers.md"));
  assert.equal(documentRefusal(() => inspectCandidateLayer({ root: leversOnly })), "candidate_document_missing");
  copyFileSync(join(exampleRoot, "profile.md"), join(bare, "profile.md"));
  assert.equal(documentRefusal(() => inspectCandidateLayer({ root: bare })), "candidate_document_missing");
  copyFileSync(join(exampleRoot, "levers.md"), join(bare, "levers.md"));
  // A layer with a profile and a lever bank but no rules is refused, not read as a candidate
  // without rules: a lost file must not look like an empty one.
  assert.throws(() => inspectCandidateLayer({ root: bare }), (error) => (
    error.code === "candidate_document_missing" && /rules\.md/u.test(error.message)
  ));
  writeFileSync(join(bare, "rules.md"), "<!-- candidate-rules-schema: 1 -->\n\n# Rules\n", "utf8");
  // The letter samples are optional: a layer without them is ready and says it holds none.
  assert.deepEqual(inspectCandidateLayer({ root: bare }).documents, { letterSamples: 0, levers: 5, projects: 5, rules: 0 });

  writeFileSync(join(bare, "letter-samples.md"), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
  assert.equal(documentRefusal(() => inspectCandidateLayer({ root: bare })), "candidate_document_unreadable");

  // A layer broken in both places is refused for its config, the order every caller relies on.
  const both = layerWith(t, "{ not json\n", undefined, { documents: false });
  assert.equal(refusalCode(() => inspectCandidateLayer({ root: both })), "candidate_config_invalid_json");
});

test("the rules name six read points, and the example has a rule for each", () => {
  // Frozen here as a literal: the skills name these points, and a point added to the list without
  // a skill reading it — or a skill renamed under it — is a visible edit of this line.
  assert.deepEqual([...candidateRuleScopes], [
    "generate-cv",
    "get-vacancy",
    "map-experience",
    "research-company",
    "score-jobs",
    "write-cover-letter",
  ]);
  const { rules, schemaVersion } = loadCandidateDocuments({ root: exampleRoot }).rules;
  assert.equal(schemaVersion, 1);
  const covered = new Set(rules.flatMap((rule) => rule.scope));
  for (const point of candidateRuleScopes) assert.equal(covered.has(point), true, `no example rule for ${point}`);
  assert.equal(new Set(rules.map((rule) => rule.id)).size, rules.length);
});

test("every disagreement of the rules with their format is refused with its own code", () => {
  const rules = exampleText("rules.md");
  const refused = (text) => documentRefusal(() => validateCandidateRules(text));
  const invalid = "candidate_rules_invalid";
  const first = "## past-tense-tarnwick\n\nScope: map-experience, generate-cv, write-cover-letter\nWhy:";

  assert.equal(rules.includes(first), true, "the cases below edit the example's first rule");
  assert.equal(refused(rules.replace("<!-- candidate-rules-schema: 1 -->\n", "")), "candidate_rules_schema_version_missing");
  assert.equal(refused(rules.replace("candidate-rules-schema: 1", "candidate-rules-schema: 2")), "candidate_rules_schema_version_unsupported");
  assert.equal(refused(rules.replace("# Rules\n", "")), invalid);
  assert.equal(refused(`${rules}\n# Second title\n`), invalid);
  assert.equal(refused(rules.replace("## past-tense-tarnwick", "## Past tense")), invalid);
  assert.equal(refused(rules.replace("## route-planning-not-maps", "## past-tense-tarnwick")), invalid);
  assert.equal(refused(rules.replace("Scope: map-experience, generate-cv, write-cover-letter", "Scope: map-experience, cover-letter")), invalid);
  assert.equal(refused(rules.replace("Scope: map-experience, generate-cv, write-cover-letter", "Scope: map-experience, map-experience")), invalid);
  assert.equal(refused(rules.replace("Scope: map-experience, generate-cv, write-cover-letter", "Scope:")), invalid);
  assert.equal(refused(rules.replace("Scope: map-experience, generate-cv, write-cover-letter\n", "")), invalid);
  assert.equal(refused(rules.replace(/Why: The Tarnwick Studio work[^\n]*/u, "Why:")), invalid);
  const [scopeLine, whyLine] = first.split("\n").slice(2);
  assert.equal(refused(rules.replace(`${scopeLine}\n${whyLine}`, `${whyLine}\n${scopeLine}`)), invalid);
  // The fields are read by name, not by place: swapped lines whose values would each pass as the
  // other field are refused too.
  assert.equal(refused(rules.replace(`${scopeLine}\n${whyLine}`, "Why: generate-cv\nScope: score-jobs")), invalid);
  // A second title is refused even when its text would pass as a rule id.
  assert.equal(refused(`${rules}\n# late-title\n\nScope: score-jobs\nWhy: A reason.\n\nText.\n`), invalid);
  // A rule with its two lines and nothing below them says nothing.
  const bare = rules.slice(0, rules.indexOf("The Tarnwick Studio work is described")) + rules.slice(rules.indexOf("## route-planning-not-maps"));
  assert.equal(refused(bare), invalid);
  assert.equal(refused(rules.replace("# Rules\n", "# Rules\n\n### Loose section\n\nText.\n")), invalid);
  // An unclosed fence would hide the rules below it, so a broken rule there must still be refused.
  const hidden = rules.replace("\n## route-planning-not-maps", "\n```text\n\n## route-planning-not-maps").replace("Scope: generate-cv, write-cover-letter", "Scope: nope");
  assert.equal(refused(hidden), invalid);

  // What the format allows: no rules at all, a subsection inside a rule, and a heading in a fence.
  assert.deepEqual(validateCandidateRules("<!-- candidate-rules-schema: 1 -->\n\n# Rules\n").rules, []);
  const withSubsection = validateCandidateRules(rules).rules.find((rule) => rule.id === "contract-tests-in-letters");
  assert.deepEqual([...withSubsection.scope], ["write-cover-letter"]);
  const fenced = rules.replace("\n## route-planning-not-maps", "\n```text\n## not-a-rule\n```\n\n## route-planning-not-maps");
  assert.equal(validateCandidateRules(fenced).rules.length, validateCandidateRules(rules).rules.length);
});

// ── Language packs ──────────────────────────────────────────────────────────────────────────────

// A whole copy of the example, so a case about a pack starts from a layer that is ready.
function exampleCopy(t, prefix = "job-search-candidate-pack-") {
  const root = join(disposable(t, prefix), candidateDirectoryName);
  cpSync(exampleRoot, root, { recursive: true });
  return root;
}

const greekPack = (root, ...rest) => join(root, "languages", "Greek", ...rest);

function rewriteJson(path, change) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  change(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("the language keys are bounded: distinct capitalized names beside the default, one-line signature", () => {
  const with_ = (path, value) => {
    const config = exampleConfig();
    const [head, tail] = path.split(".");
    config[head][tail] = value;
    return refusalCode(() => validateCandidateConfig(config));
  };
  for (const value of [["Greek", "Greek"], ["greek"], ["English"], ["Brazilian Portuguese"], ["El"]]) {
    const expected = value[0] === "El" ? null : "candidate_config_value_invalid";
    assert.equal(with_("languages.additional", value), expected, JSON.stringify(value));
  }
  assert.equal(with_("languages.additional", []), null);
  assert.equal(with_("languages.additional", "Greek"), "candidate_config_key_type_invalid");
  assert.equal(with_("languages.working", "english"), "candidate_config_value_invalid");
  // The working language is the language of chat and private files; it needs no pack.
  assert.equal(with_("languages.working", "German"), null);
  for (const value of ["", " Name", "Name ", "Name\nSurname"]) {
    assert.equal(with_("letter.signature", value), "candidate_config_value_invalid", JSON.stringify(value));
  }
});

test("the language names come from the config alone; the languages of a letter come with their packs", (t) => {
  assert.deepEqual(candidateLanguageNames({ root: exampleRoot }), ["English", "Greek"]);
  assert.deepEqual(
    candidateLanguageNames({ root: candidateRootFor(disposable(t, "job-search-candidate-none-")) }),
    [DEFAULT_LANGUAGE.name],
  );
  // A broken pack does not stop a reader of names, only the readers of the packs.
  const root = exampleCopy(t);
  writeFileSync(greekPack(root, "pack.json"), "{ not json\n", "utf8");
  assert.deepEqual(candidateLanguageNames({ root }), ["English", "Greek"]);
  assert.equal(refusalCode(() => candidateLanguages({ root })), "candidate_language_pack_invalid_json");
  assert.equal(refusalCode(() => inspectCandidateLayer({ root })), "candidate_language_pack_invalid_json");

  const [english, greek] = candidateLanguages({ root: exampleRoot });
  assert.deepEqual(
    { ...english, signature: typeof english.signature },
    {
      admitsScripts: [],
      locale: "en",
      name: "English",
      path: null,
      pins: [],
      rulesPath: null,
      script: "Latin",
      signature: "string",
      subjectPrefix: "Subject",
    },
  );
  assert.deepEqual(
    [greek.name, greek.locale, greek.script, greek.admitsScripts, greek.subjectPrefix, greek.pins.length],
    ["Greek", "el", "Greek", ["Latin"], "Θέμα", 5],
  );
  assert.equal(greek.rulesPath, greekPack(exampleRoot, "language-rules.md"));
});

test("a configured language needs its pack, and a pack needs a configured language", (t) => {
  const missing = exampleCopy(t);
  rmSync(join(missing, "languages"), { recursive: true });
  assert.equal(refusalCode(() => inspectCandidateLayer({ root: missing })), "candidate_language_pack_missing");

  const noPackFile = exampleCopy(t);
  rmSync(greekPack(noPackFile, "pack.json"));
  assert.equal(refusalCode(() => inspectCandidateLayer({ root: noPackFile })), "candidate_language_pack_missing");

  const stray = exampleCopy(t);
  mkdirSync(join(stray, "languages", "German"));
  assert.equal(refusalCode(() => inspectCandidateLayer({ root: stray })), "candidate_language_pack_unconfigured");

  // A name the file system gives, not the candidate, is neither read nor refused.
  const hidden = exampleCopy(t);
  writeFileSync(join(hidden, "languages", ".DS_Store"), "", "utf8");
  writeFileSync(greekPack(hidden, ".DS_Store"), "", "utf8");
  assert.equal(inspectCandidateLayer({ root: hidden }).status, "ready");

  const foreignFile = exampleCopy(t);
  writeFileSync(greekPack(foreignFile, "notes.md"), "# Notes\n", "utf8");
  assert.equal(refusalCode(() => inspectCandidateLayer({ root: foreignFile })), "candidate_language_pack_invalid");

  const packDirectory = exampleCopy(t);
  rmSync(greekPack(packDirectory, "pack.json"));
  mkdirSync(greekPack(packDirectory, "pack.json"));
  assert.equal(refusalCode(() => inspectCandidateLayer({ root: packDirectory })), "candidate_language_pack_invalid");

  const orphanPins = exampleCopy(t);
  rmSync(greekPack(orphanPins, "pins.json"));
  assert.equal(refusalCode(() => inspectCandidateLayer({ root: orphanPins })), "candidate_pins_invalid");

  // Only the pack file is required.
  const bare = exampleCopy(t);
  for (const name of ["constraints.json", "language-rules.md", "pins.json"]) rmSync(greekPack(bare, name));
  rmSync(greekPack(bare, "pins"), { recursive: true });
  assert.equal(inspectCandidateLayer({ root: bare }).status, "ready");
  assert.equal(candidateLanguages({ root: bare })[1].rulesPath, null);
});

test("pack.json is read field by field, and every field is required", (t) => {
  const refusal = (change) => {
    const root = exampleCopy(t);
    rewriteJson(greekPack(root, "pack.json"), change);
    return refusalCode(() => candidateLanguages({ root }));
  };
  assert.equal(refusal(() => {}), null);
  assert.equal(refusal((pack) => { pack.schema_version = 2; }), "candidate_language_pack_invalid");
  assert.equal(refusal((pack) => { pack.extra = true; }), "candidate_language_pack_invalid");
  for (const field of ["locale", "script", "admits_scripts", "subject_prefix", "signature", "schema_version"]) {
    assert.equal(refusal((pack) => { delete pack[field]; }), "candidate_language_pack_invalid", field);
  }
  // A locale the word counter does not support would count words by another language's rules.
  for (const locale of ["zz", "EL", "el_GR", ""]) {
    assert.equal(refusal((pack) => { pack.locale = locale; }), "candidate_language_pack_invalid", locale);
  }
  // The last one compiles as a pattern: only the form of a script name keeps it out.
  for (const script of ["Klingon", "greek", "Greek}|.", "", "Greek}|\\p{Script=Latin"]) {
    assert.equal(refusal((pack) => { pack.script = script; }), "candidate_language_pack_invalid", script);
  }
  assert.equal(refusal((pack) => { pack.admits_scripts = ["Greek"]; }), "candidate_language_pack_invalid");
  assert.equal(refusal((pack) => { pack.admits_scripts = ["Latin", "Latin"]; }), "candidate_language_pack_invalid");
  assert.equal(refusal((pack) => { pack.admits_scripts = "Latin"; }), "candidate_language_pack_invalid");
  assert.equal(refusal((pack) => { pack.subject_prefix = "Θέμα:"; }), "candidate_language_pack_invalid");
  assert.equal(refusal((pack) => { pack.signature = "Two\nLines"; }), "candidate_language_pack_invalid");

  const broken = exampleCopy(t);
  writeFileSync(greekPack(broken, "pack.json"), "{", "utf8");
  assert.equal(refusalCode(() => candidateLanguages({ root: broken })), "candidate_language_pack_invalid_json");
});

test("pins.json declares every letter in pins/, and a pin names its verdict", (t) => {
  const refusal = (change, after = () => {}) => {
    const root = exampleCopy(t);
    rewriteJson(greekPack(root, "pins.json"), change);
    after(root);
    return refusalCode(() => candidateLanguages({ root }));
  };
  const first = (pins) => pins.pins[0];
  const reject = (pins) => pins.pins.find((pin) => pin.expect === "reject");
  assert.equal(refusal(() => {}), null);
  assert.equal(refusal((pins) => { first(pins).id = "../plain-letter"; }), "candidate_pins_invalid");
  // An id of the wrong form is refused although its letter is there.
  assert.equal(
    refusal((pins) => { first(pins).id = "Plain-Letter"; }, (root) => {
      renameSync(greekPack(root, "pins", "plain-letter.txt"), greekPack(root, "pins", "Plain-Letter.txt"));
    }),
    "candidate_pins_invalid",
  );
  assert.equal(refusal((pins) => { pins.pins.push({ ...first(pins) }); }), "candidate_pins_invalid");
  assert.equal(refusal((pins) => { first(pins).expect = "maybe"; }), "candidate_pins_invalid");
  assert.equal(refusal((pins) => { first(pins).finding = "anything"; }), "candidate_pins_invalid");
  assert.equal(refusal((pins) => { delete reject(pins).finding; }), "candidate_pins_invalid");
  assert.equal(refusal((pins) => { first(pins).keyword_terms = []; }), "candidate_pins_invalid");
  assert.equal(refusal((pins) => { delete first(pins).why; }), "candidate_pins_invalid");
  assert.equal(refusal((pins) => { first(pins).weight = 1; }), "candidate_pins_invalid");
  assert.equal(refusal((pins) => { pins.pins = []; }), "candidate_pins_invalid");
  assert.equal(refusal((pins) => { pins.schema_version = 2; }), "candidate_pins_invalid");
  // A letter no pin declares, and a pin without its letter.
  assert.equal(
    refusal(() => {}, (root) => writeFileSync(greekPack(root, "pins", "extra.txt"), "x\n", "utf8")),
    "candidate_pins_invalid",
  );
  assert.equal(
    refusal(() => {}, (root) => rmSync(greekPack(root, "pins", "plain-letter.txt"))),
    "candidate_pins_invalid",
  );
});

test("the pins of the example hold, and a pin that proves nothing fails", (t) => {
  assert.deepEqual(runCandidatePins({ root: exampleRoot }), { run: 5 });

  const failure = (change) => {
    const root = exampleCopy(t);
    change(root);
    let caught;
    try {
      runCandidatePins({ root });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof CandidateError, String(caught));
    assert.equal(caught.code, "candidate_pin_failed");
    return caught.message;
  };
  // An accepted letter that the gate refuses.
  assert.match(
    failure((root) => {
      const path = greekPack(root, "pins", "plain-letter.txt");
      writeFileSync(path, readFileSync(path, "utf8").replace("Playwright", "Selenium"), "utf8");
    }),
    /languages\/Greek: pin plain-letter expects no finding/u,
  );
  // A refused letter refused for another reason than the one its pin names.
  assert.match(
    failure((root) => rewriteJson(greekPack(root, "pins.json"), (pins) => {
      pins.pins.find((pin) => pin.id === "wrong-signature").finding = "cover-letter.txt title must use Greek script";
    })),
    /pin wrong-signature expects/u,
  );
  // A refused letter refused for its reason and one more: it no longer isolates the check.
  assert.match(
    failure((root) => {
      const path = greekPack(root, "pins", "latin-paragraph.txt");
      writeFileSync(path, readFileSync(path, "utf8").replace("Αξιόπιστη", "Reliable").replace(/^[^\n]+/u, "Reliable title"), "utf8");
    }),
    /pin latin-paragraph expects/u,
  );
  // The pack's own constraint is what the spelling pin exercises: without it the pin fails.
  assert.match(
    failure((root) => rmSync(greekPack(root, "constraints.json"))),
    /pin unaccented-spelling expects/u,
  );
});

test("a pack's constraints bind letters in its language alone, together with the layer's", (t) => {
  const forLetter = (language, root = exampleRoot) => candidateConstraintsFor({
    engineForbidden: coverLetterEngineForbidden,
    language,
    material: "cover_letter",
    root,
  }).map((entry) => entry.id);
  const layerIds = [...exampleConstraints.constraints.map((entry) => entry.id), ...examplePrivateIds];
  assert.deepEqual(forLetter("Greek"), [...layerIds, "tonos-dokimes"]);
  assert.deepEqual(forLetter("English"), layerIds);
  assert.deepEqual(forLetter(null), layerIds);
  assert.deepEqual(
    candidateConstraintsFor({ language: "Greek", material: "cv", root: exampleRoot }).map((entry) => entry.id),
    layerIds,
  );
  assert.deepEqual(loadAllCandidateConstraints({ root: exampleRoot }), { count: layerIds.length + 1, status: "ready" });

  const cvScoped = exampleCopy(t);
  rewriteJson(greekPack(cvScoped, "constraints.json"), (file) => {
    file.constraints[0].scope.materials = ["cover_letter", "cv"];
  });
  assert.equal(refusalCode(() => forLetter("Greek", cvScoped)), "candidate_constraint_scope_invalid");
  assert.equal(refusalCode(() => loadAllCandidateConstraints({ root: cvScoped })), "candidate_constraint_scope_invalid");

  const repeated = exampleCopy(t);
  rewriteJson(greekPack(repeated, "constraints.json"), (file) => {
    file.constraints[0].id = layerIds[0];
  });
  assert.equal(refusalCode(() => forLetter("Greek", repeated)), "candidate_constraint_id_duplicate");

  // A pack entry that makes required what the engine forbids is refused with the layer's.
  const conflicting = exampleCopy(t);
  rewriteJson(greekPack(conflicting, "constraints.json"), (file) => {
    file.constraints[0] = {
      id: "dash", type: "required_spellings", scope: { materials: ["cover_letter"] },
      spelling: "a—b", instead_of: ["ab"], why: "A test.",
    };
  });
  assert.equal(refusalCode(() => forLetter("Greek", conflicting)), "candidate_constraint_conflicts_with_engine");
});

test("the letter samples cover only the default language and configured ones", (t) => {
  const root = exampleCopy(t);
  const path = join(root, "letter-samples.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("Covered languages: English", "Covered languages: English, German"), "utf8");
  assert.equal(refusalCode(() => inspectCandidateLayer({ root })), "candidate_letter_samples_invalid");
  writeFileSync(path, readFileSync(path, "utf8").replace("English, German", "English, Greek"), "utf8");
  assert.equal(inspectCandidateLayer({ root }).status, "ready");
});

// The layer manifest: the example declares what every layer holds, the real layer is checked
// against it, and every reference a document a run reads makes into the layer opens on the example.

const exampleManifest = loadCandidateManifest();
const exampleLanguages = () => candidateLanguageNames({ root: exampleRoot })
  .filter((name) => name !== DEFAULT_LANGUAGE.name);

function manifestWith(extra) {
  const raw = JSON.parse(readFileSync(join(exampleRoot, "manifest.json"), "utf8"));
  raw.files.push(...extra);
  return parseCandidateManifest(raw);
}

test("the manifest declares the profile's section map: every fixed heading, nothing else", () => {
  const profile = exampleManifest.files.find((file) => file.role === "profile");
  const fromMap = candidateProfileSections
    .filter((entry) => !entry.optional)
    .map((entry) => `${"#".repeat(entry.level)} ${entry.number === null ? entry.title : `${entry.number}. ${entry.title}`}`);
  assert.deepEqual(profile.headings.map((heading) => heading.text), fromMap);
  assert.equal(profile.path, "profile.md");
  assert.equal(profile.required, true);
});

test("the manifest's required files are frozen to the ones the loaders require", () => {
  const required = exampleManifest.files.filter((file) => file.required).map((file) => file.path);
  assert.deepEqual(required, ["config.json", "profile.md", "levers.md", "rules.md", "languages/<language>/pack.json"]);
  const memory = exampleManifest.files.find((file) => file.role === "memory");
  assert.deepEqual([memory.required, memory.headings.map((heading) => heading.text)], [false, ["## Open questions"]]);
  // The reader's examples sit under the four lists of its answer, and a layer may go without them.
  const examples = exampleManifest.files.find((file) => file.role === "letter_reader_examples");
  assert.deepEqual(
    [examples.path, examples.required, examples.headings.map((heading) => heading.text)],
    ["letter-reader-examples.md", false, ["## reread", "## unclear_reference", "## missing_link", "## translated"]],
  );
});

test("the tracked example meets its own manifest", () => {
  checkCandidateLayerParity({ languages: exampleLanguages(), manifest: exampleManifest, root: exampleRoot });
  assert.equal(inspectCandidateLayer({ root: exampleRoot }).status, "ready");
});

test("a layer names a section only by a link that opens, in its profile, levers, rules and language rules", (t) => {
  const root = exampleCopy(t, "job-search-candidate-sections-");
  assert.equal(inspectCandidateLayer({ root }).status, "ready");
  const refusal = (file, edit) => {
    const path = join(root, ...file.split("/"));
    const before = readFileSync(path, "utf8");
    writeFileSync(path, edit(before), "utf8");
    try {
      inspectCandidateLayer({ root });
      return null;
    } catch (error) {
      assert.equal(error.code, "candidate_section_reference_invalid", error.message);
      return error.message;
    } finally {
      writeFileSync(path, before, "utf8");
    }
  };
  const link = "`profile.md#651-ai-assisted-qa-workflow`";
  const line = readFileSync(join(root, "levers.md"), "utf8").split("\n").findIndex((text) => text.includes(link)) + 1;
  const tail = "; a section is named by a link to its heading";
  assert.equal(refusal("levers.md", (text) => text.replace(link, "profile §6.5.1")), `levers.md line ${line}: names a section by number${tail}`);
  assert.equal(refusal("levers.md", (text) => text.replace(link, "`profile.md#651-nowhere`")), `levers.md line ${line}: #651-nowhere names no heading of profile.md${tail}`);
  // Inside the layer a link is relative to its file or written from the layer's root; into the
  // engine it is written from the root of the checkout the code lies in.
  assert.equal(refusal("levers.md", (text) => text.replace(link, "`candidate/profile.md#651-ai-assisted-qa-workflow`")), null);
  assert.equal(refusal("levers.md", (text) => text.replace(link, "`knowledge/impact-levers.md#1-impact-levers`")), null);
  assert.equal(refusal("levers.md", (text) => text.replace(link, "`knowledge/impact-levers.md#nowhere`")), `levers.md line ${line}: #nowhere names no heading of knowledge/impact-levers.md${tail}`);
  assert.equal(refusal("rules.md", (text) => `${text}\nAs in section 3.\n`)?.startsWith("rules.md line "), true);
  assert.equal(refusal("profile.md", (text) => `${text}\nSee [the gaps](#7-explicit-gaps-do-not-oversell).\n`)?.includes("#7-explicit-gaps-do-not-oversell names no heading of this document"), true);
  assert.equal(refusal("languages/Greek/language-rules.md", (text) => `${text}\nΚαι §2.\n`)?.startsWith("languages/Greek/language-rules.md line "), true);
  // The memory and the letter samples are not read for a section.
  assert.equal(refusal("memory.md", (text) => `${text}\nprofile §7\n`), null);
});

test("a present layer without a declared heading or required file is refused, naming both", (t) => {
  const root = exampleCopy(t, "job-search-candidate-manifest-");
  const memory = join(root, "memory.md");
  const text = readFileSync(memory, "utf8");
  assert.equal(text.includes("\n## Open questions\n"), true);

  writeFileSync(memory, text.replace("\n## Open questions\n", "\n## Questions\n"), "utf8");
  assert.throws(() => inspectCandidateLayer({ root }), (error) => (
    error.code === "candidate_layer_heading_missing"
    && error.message === "memory.md lacks the heading ## Open questions, which the layer manifest declares"
  ));
  // A heading inside a code fence is not one.
  writeFileSync(memory, text.replace("\n## Open questions\n", "\n```\n## Open questions\n```\n"), "utf8");
  assert.equal(refusalCode(() => inspectCandidateLayer({ root })), "candidate_layer_heading_missing");
  // The wrong level is not the heading either.
  writeFileSync(memory, text.replace("\n## Open questions\n", "\n### Open questions\n"), "utf8");
  assert.equal(refusalCode(() => inspectCandidateLayer({ root })), "candidate_layer_heading_missing");
  // A qualifier in parentheses is part of the heading: the anchor a rule links to is built from it.
  writeFileSync(memory, text.replace("\n## Open questions\n", "\n## Open questions (flags)\n"), "utf8");
  assert.equal(refusalCode(() => inspectCandidateLayer({ root })), "candidate_layer_heading_missing");
  // The memory is optional: a layer without it has nothing to carry the heading in.
  rmSync(memory);
  assert.equal(inspectCandidateLayer({ root }).status, "ready");

  // A required file the manifest declares and no earlier check reads is refused by name, and a
  // language entry stands for each configured language.
  const withNotes = manifestWith([{ path: "notes.md", required: true, role: "notes" }]);
  assert.throws(() => inspectCandidateLayer({ manifest: withNotes, root }), (error) => (
    error.code === "candidate_layer_file_missing"
    && error.message === "the candidate layer is missing notes.md, which the layer manifest declares"
  ));
  const withPackRules = parseCandidateManifest({
    files: [{ headings: ["## Typography"], path: "languages/<language>/language-rules.md", required: true, role: "rules_of_a_pack" }],
    manifest_version: 1,
  });
  assert.equal(inspectCandidateLayer({ manifest: withPackRules, root }).status, "ready");
  const packRules = join(root, "languages", "Greek", "language-rules.md");
  writeFileSync(packRules, readFileSync(packRules, "utf8").replace("## Typography", "## Punctuation"), "utf8");
  assert.throws(() => inspectCandidateLayer({ manifest: withPackRules, root }), (error) => (
    error.code === "candidate_layer_heading_missing" && error.message.startsWith("languages/Greek/language-rules.md lacks the heading ## Typography")
  ));
  rmSync(packRules);
  assert.throws(() => inspectCandidateLayer({ manifest: withPackRules, root }), (error) => (
    error.code === "candidate_layer_file_missing" && error.message.includes("languages/Greek/language-rules.md")
  ));
});

test("the manifest comes last: a gap an earlier check reads keeps that check's code", (t) => {
  const root = exampleCopy(t, "job-search-candidate-manifest-");
  rmSync(join(root, "rules.md"));
  assert.equal(refusalCode(() => inspectCandidateLayer({ root })), "candidate_document_missing");
});

test("the layer check refuses a layer the manifest finds a gap in", (t) => {
  const root = exampleCopy(t, "job-search-candidate-manifest-");
  const memory = join(root, "memory.md");
  writeFileSync(memory, readFileSync(memory, "utf8").replace("\n## Open questions\n", "\n## Questions\n"), "utf8");
  const run = spawnSync(process.execPath, [join(repoRoot, "tools/candidate/cli.mjs"), "--check", "--root", root], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, "");
  const error = JSON.parse(run.stderr).error;
  assert.equal(error.code, "candidate_layer_heading_missing");
  assert.match(error.message, /^memory\.md lacks the heading ## Open questions/u);
});

test("a manifest this engine cannot read refuses with its own code", (t) => {
  const valid = () => JSON.parse(readFileSync(join(exampleRoot, "manifest.json"), "utf8"));
  const refused = (mutate) => {
    const raw = valid();
    mutate(raw);
    return refusalCode(() => parseCandidateManifest(raw));
  };
  const invalid = "candidate_manifest_invalid";
  assert.equal(refused(() => {}), null);
  assert.equal(refused((raw) => { raw.manifest_version = 2; }), invalid);
  assert.equal(refused((raw) => { raw.extra = true; }), invalid);
  assert.equal(refused((raw) => { raw.files = []; }), invalid);
  assert.equal(refused((raw) => { raw.files.push({ ...raw.files[0], path: "other.json" }); }), invalid);
  assert.equal(refused((raw) => { raw.files.push({ path: "config.json", required: true, role: "second" }); }), invalid);
  assert.equal(refused((raw) => { raw.files[0].path = "../config.json"; }), invalid);
  assert.equal(refused((raw) => { raw.files[0].path = "/config.json"; }), invalid);
  assert.equal(refused((raw) => { raw.files[0].path = "languages/<lang>/pack.json"; }), invalid);
  assert.equal(refused((raw) => { raw.files[0].required = "yes"; }), invalid);
  assert.equal(refused((raw) => { raw.files[0].headings = ["## Values"]; }), invalid);
  assert.equal(refused((raw) => { raw.files[0].why = "unknown field"; }), invalid);
  assert.equal(refused((raw) => { raw.files[2].headings.push("Explicit Gaps"); }), invalid);
  assert.equal(refused((raw) => { raw.files[2].headings.push("## 7. Explicit Gaps"); }), invalid);

  const base = disposable(t, "job-search-candidate-manifest-file-");
  assert.equal(refusalCode(() => loadCandidateManifest({ path: join(base, "manifest.json") })), "candidate_manifest_missing");
  writeFileSync(join(base, "manifest.json"), "{ not json\n", "utf8");
  assert.equal(refusalCode(() => loadCandidateManifest({ path: join(base, "manifest.json") })), invalid);
  assert.deepEqual([...candidateManifestErrorCodes].every((code) => candidateErrorCodes.includes(code)), true);
});

test("a heading's anchor is GitHub's: the whole title lower-cased, punctuation dropped, spaces hyphenated", () => {
  assert.equal(candidateHeadingSlug("7. Explicit Gaps"), "7-explicit-gaps");
  assert.equal(candidateHeadingSlug("8. Work Approach & Team Style"), "8-work-approach--team-style");
  assert.equal(candidateHeadingSlug("6.3. CI/CD & Infrastructure"), "63-cicd--infrastructure");
  assert.equal(candidateHeadingSlug("6.5.1. AI-assisted QA workflow"), "651-ai-assisted-qa-workflow");
  assert.equal(candidateHeadingSlug("Open questions"), "open-questions");
  // The qualifier stays, code marks go, a link keeps its text, and a letter of any script is kept.
  assert.equal(candidateHeadingSlug("2. Data sources (priority)"), "2-data-sources-priority");
  assert.equal(candidateHeadingSlug("3.1. Example — Range (0..42)"), "31-example--range-042");
  assert.equal(candidateHeadingSlug("Example (0..8) — taxonomy `example-v4`"), "example-08--taxonomy-example-v4");
  assert.equal(candidateHeadingSlug("See [the map](x.md) first"), "see-the-map-first");
  assert.equal(candidateHeadingSlug("9. Gate перед integration"), "9-gate-перед-integration");
  assert.equal(candidateHeadingSlug("`MANUAL_REVIEW` codes"), "manual_review-codes");
  assert.deepEqual(
    candidateHeadings("# T\n## 7. Explicit Gaps (Do Not Oversell)\n```\n## Not one\n```\n").map((heading) => [heading.level, heading.title]),
    [[1, "T"], [2, "7. Explicit Gaps (Do Not Oversell)"]],
  );
  // A repeated heading is numbered as GitHub numbers it, skipping an anchor already taken.
  assert.deepEqual([...candidateHeadingAnchors("# A\n## A\n## A-1\n## A\n")], ["a", "a-1", "a-1-1", "a-2"]);
});

test("every reference a document a run reads makes into the layer opens on the example, none names it, and no section is named by number", () => {
  const checked = checkCandidateLinks({
    exampleRoot,
    languages: exampleLanguages(),
    manifest: exampleManifest,
    root: repoRoot,
  });
  assert.deepEqual(checked.findings, []);
  // The rule's own example and the memory's flag heading are live links, so the check is not vacuous.
  const anchored = checked.references.filter((reference) => reference.anchor !== null)
    .map((reference) => `${reference.document} ${reference.path}#${reference.anchor}`);
  for (const live of [
    "instructions/operating-contract.md memory.md#open-questions",
    "instructions/operating-contract.md profile.md#7-explicit-gaps",
    "knowledge/generation-rules.md profile.md#9-experience",
    "knowledge/impact-levers.md profile.md#651-ai-assisted-qa-workflow",
    "knowledge/job-match-rules.md profile.md#61-languages",
    "knowledge/precedence.md profile.md#7-explicit-gaps",
    "docs/runbooks/triage-review.md profile.md#3-career-target--priorities",
  ]) {
    assert.equal(anchored.includes(live), true, live);
  }
  // Every anchored link written in a document was read as one: a link the scanner misses is checked
  // by nobody. None of these documents holds a layer link inside a code fence; the form
  // `candidate/<file>#<anchor>` describes a link and is not one.
  for (const document of candidateRunDocuments(repoRoot)) {
    const written = (readFileSync(join(repoRoot, document), "utf8").match(/(?<=^|[\s`'"(\[])(?:\.\.\/)*candidate\/[^\s`'")\]]*#/gmu) ?? [])
      .filter((link) => !link.endsWith(">#"));
    const read = checked.references.filter((reference) => reference.document === document && reference.anchor !== null);
    assert.equal(read.length, written.length, document);
  }
  assert.equal(checked.references.length > 40, true);
  // The same for every link to a heading, in the run documents and the tool READMEs alike: each
  // `.md#`, `](#` and own anchor in code written outside a fence is one the scanner read.
  for (const document of [...candidateRunDocuments(repoRoot), ...candidateRunReadmes(repoRoot)]) {
    const text = readFileSync(join(repoRoot, document), "utf8");
    const unfenced = text.replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gmu, "");
    const written = (unfenced.match(/\.md#[\p{L}\p{N}_-]|\]\(#[\p{L}\p{N}_-]|`#[\p{L}\p{N}_-]/gu) ?? []).length;
    assert.equal(candidateLayerReferencesIn(text).sectionLinks.length, written, document);
  }
  // The runbooks a run reads are scanned with the canon, and so are the tool READMEs a run is sent
  // to, a runbook's included.
  assert.equal(candidateRunDocuments(repoRoot).includes("docs/runbooks/triage-review.md"), true);
  const readmes = candidateRunReadmes(repoRoot);
  for (const readme of ["tools/candidate/README.md", "tools/application-brief/README.md", "tools/ops-tree/README.md"]) {
    assert.equal(readmes.includes(readme), true, readme);
  }
});

test("a reference that does not open, and a mention of the example, are findings", (t) => {
  const root = disposable(t, "job-search-candidate-links-");
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, "utf8");
  };
  write("instructions/a.md", [
    "Read `candidate/profile.md#7-explicit-gaps` and [the bank](../candidate/levers.md#positioning).",
    "Flags go to `candidate/memory.md#open-questions`; the root is `candidate/`.",
    "Packs: `candidate/languages/<language>/` and `candidate/languages/<язык>/language-rules.md`.",
    "The eighth is `candidate/profile.md#8-work-approach--team-style`, and the form is `candidate/<file>#<anchor>`.",
    "Not a reference: `tools/candidate/README.md` and ../tools/candidate/load.mjs.",
    "```sh",
    "cat candidate/nowhere.md candidate.example/profile.md",
    "```",
    "Broken: `candidate/profile.md#7-explicit-gaps-do-not-oversell`, `candidate/lever.md`.",
    "Undeclared: `candidate/levers.md#stance` and `candidate/profile.md#91-tarnwick-studio`.",
    "Absent from the example: `candidate/telegram-sources.json`.",
    "The fixture is candidate.example/profile.md.",
    "See [triage](../docs/runbooks/named.md).",
  ].join("\n"));
  write("instructions/d.md", "Read `tools/foo/README.md`.\n");
  write("knowledge/b.md", "Anchored directory: `candidate/languages/<language>/#x`.\n\n## Anchored\n\n## Anchored\n");
  write("knowledge/c.md", [
    "Gaps: profile §7.",
    "The stack: §7 of `candidate/profile.md`.",
    "Classes — Профиль (§3) and профиля, §3.",
    "The rubric's Section 2.2 decides.",
    "Sections 3.1 to 3.4 score it.",
    "The flags subsection 2 lists them.",
    "See Sec. 7 for the trace.",
    "Классы — в разделе 3.",
    "Read the stack of section",
    "9 before scoring.",
    "> A quote that reads section",
    "> 7 on its next line.",
    "Not findings: step 3, rule 16, a cross-section 3, an intersection 3, a heading below.",
    "## 6. A heading of its own",
    "```",
    "§7 and section 7 in a fence",
    "```",
    "Links: [own](#6-a-heading-of-its-own), [other](b.md#anchored), `knowledge/b.md#anchored`, `b.md#anchored`.",
    "Broken: [own](#nowhere), [other](b.md#nowhere), [rooted](knowledge/b.md#anchored), `missing.md#x`.",
    "Not links: `groups.mjs#collectionGroup`, https://example.com/x.md#y, [site](https://example.com/a.md#b), `<path>#<anchor>`.",
    "Repeat: [second](b.md#anchored-1); own in code: `#6-a-heading-of-its-own`.",
    "Broken in code and in plain parentheses: `#nowhere-code` (missing2.md#x).",
  ].join("\n"));
  write("docs/runbooks/named.md", "It reads `candidate/profiles.md`.\n");
  write("docs/runbooks/unnamed.md", "It reads `candidate/nothing.md` and candidate.example/.\n");
  // A tool README a run is sent to is read for section numbers and links only: it may describe the
  // example and the layer's form, and a link that climbs to a sibling tool is a file of the tree.
  write("tools/foo/README.md", [
    "It describes candidate.example and `candidate/research/`.",
    "The layer is checked by [the check](../candidate/README.md#checking).",
    "Section 4 of it.",
    "Broken: `candidate/profile.md#nowhere`.",
  ].join("\n"));
  write("tools/candidate/README.md", "## Checking\n");
  const manifest = manifestWith([{ path: "telegram-sources.json", required: false, role: "telegram_sources" }]);
  const checked = checkCandidateLinks({ exampleRoot, languages: exampleLanguages(), manifest, root });
  const number = "a document a run reads names a section by number";
  assert.deepEqual(
    checked.findings.map((finding) => `${finding.document}:${finding.line} ${finding.reason}`),
    [
      "instructions/a.md:9 the layer manifest declares no heading #7-explicit-gaps-do-not-oversell for profile.md",
      "instructions/a.md:9 the layer manifest declares no file lever.md",
      "instructions/a.md:10 the layer manifest declares no heading #stance for levers.md",
      "instructions/a.md:10 the layer manifest declares no heading #91-tarnwick-studio for profile.md",
      "instructions/a.md:11 the example has no telegram-sources.json",
      "instructions/a.md:12 a document a run reads names candidate.example",
      "knowledge/b.md:1 a directory has no headings",
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 11].map((line) => `knowledge/c.md:${line} ${number}`),
      "knowledge/c.md:19 #nowhere names no heading of this document",
      "knowledge/c.md:19 #nowhere names no heading of b.md",
      "knowledge/c.md:19 knowledge/b.md names no file",
      "knowledge/c.md:19 missing.md names no file",
      "knowledge/c.md:22 missing2.md names no file",
      "knowledge/c.md:22 #nowhere-code names no heading of this document",
      "docs/runbooks/named.md:1 the layer manifest declares no file profiles.md",
      `tools/foo/README.md:3 ${number}`,
      "tools/foo/README.md:4 the layer manifest declares no heading #nowhere for profile.md",
    ],
  );
  // What was read as a reference: through `../`, the root and a directory included; nothing from
  // the fence, `tools/candidate/` or the form `candidate/<file>`.
  assert.deepEqual(
    checked.references.filter((reference) => reference.document === "instructions/a.md" && reference.line <= 4)
      .map((reference) => `${reference.line} ${reference.path}${reference.anchor === null ? "" : `#${reference.anchor}`}`),
    [
      "1 profile.md#7-explicit-gaps",
      "1 levers.md#positioning",
      "2 memory.md#open-questions",
      "2 ",
      "3 languages/<language>/",
      "3 languages/<язык>/language-rules.md",
      "4 profile.md#8-work-approach--team-style",
    ],
  );
  assert.equal(checked.references.some((reference) => reference.line >= 5 && reference.line <= 8), false);
  assert.deepEqual(
    candidateLayerReferencesIn("`tools/candidate/x.md` (candidate/rules.md). candidate/profile.md.\n").references.map((reference) => reference.path),
    ["rules.md", "profile.md"],
  );
});

test("every layer file a step pins is a manifest role, by its path and whether it is required", () => {
  const roles = new Map(exampleManifest.files.map((file) => [`candidate_${file.role}`, file]));
  const pinned = new Set();
  for (const table of [fileBackedProtectedInputs, fileBackedLetterLanguageInputs]) {
    for (const [stepName, contracts] of Object.entries(table)) {
      for (const contract of contracts.filter((entry) => entry.kind.startsWith("candidate_"))) {
        const role = roles.get(contract.kind);
        assert.ok(role, `${stepName}: ${contract.kind} is no role of the manifest`);
        assert.equal(contract.path, `candidate/${role.path}`, `${stepName}: ${contract.kind}`);
        assert.equal(contract.optional === true, !role.required, `${stepName}: ${contract.kind}`);
        pinned.add(role.role);
      }
    }
  }
  // What no step pins is live, and the layer README names it so.
  assert.deepEqual(
    exampleManifest.files.map((file) => file.role).filter((role) => !pinned.has(role)).sort(),
    ["language_pins", "letter_reader_examples", "memory"],
  );
});
