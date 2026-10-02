import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  candidateExampleRootFor,
  candidateLanguageNames,
  candidateMarkets,
} from "../tools/candidate/load.mjs";
import {
  sha256Hex,
  validateFileReference,
  validateOutputDir,
  validateStrictObject,
} from "../tools/pipeline-artifacts/validation.mjs";
import {
  readAndValidateVacancyBundle,
  validateVacancy,
} from "../tools/pipeline-artifacts/validate-vacancy.mjs";

import { seedCandidateConfig } from "./fixtures/protected-inputs.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(repoRoot, "tools/pipeline-artifacts/fixtures");
// The example's two markets: every completed fixture names one of them.
const exampleMarkets = candidateMarkets({ root: candidateExampleRootFor(repoRoot) });

function readFixture(name) {
  const directory = resolve(fixtureRoot, name);
  return {
    directory,
    vacancy: JSON.parse(readFileSync(resolve(directory, "vacancy.json"), "utf8")),
    jobDescriptionBytes: readFileSync(resolve(directory, "job-description.txt")),
  };
}

function validateFixture(name, options = {}) {
  const fixture = readFixture(name);
  return validateVacancy(fixture.vacancy, {
    jobDescriptionBytes: fixture.jobDescriptionBytes,
    ...options,
  });
}

test("completed Step 1 fixture validates exact JD bytes and selected process identity", () => {
  const fixture = readFixture("vacancy-v2-completed");
  fixture.vacancy.process.finalUrl =
    "https://redirected.example.test/jobs/senior-quality-engineer";
  assert.deepEqual(validateVacancy(fixture.vacancy, {
    jobDescriptionBytes: fixture.jobDescriptionBytes,
    markets: exampleMarkets,
    outcome: "completed",
    expectedProcess: {
      id: "proc_fixture_step1_completed",
      sourceRef: "https://example.test/jobs/senior-quality-engineer",
      outputDir: "output/example-labs-senior-quality-engineer",
      companyObserved: "Example Labs",
      role: "Senior Quality Engineer",
    },
  }), []);

  const result = readAndValidateVacancyBundle(
    resolve(fixture.directory, "vacancy.json"),
    resolve(fixture.directory, "job-description.txt"),
    { markets: exampleMarkets, outcome: "completed" },
  );
  assert.equal(result.vacancy.role.title, "Senior Quality Engineer");
  assert.equal(result.jobDescriptionBytes.byteLength, 499);
});

test("blocked Step 1 fixture preserves JD and an honest market ambiguity", () => {
  assert.deepEqual(validateFixture("vacancy-blocked", { outcome: "blocked" }), []);
  assert.match(
    validateFixture("vacancy-blocked", { outcome: "completed" }).join("\n"),
    /completed vacancy artifacts must not contain a blocking ambiguity/,
  );

  const withoutBlocker = readFixture("vacancy-blocked");
  withoutBlocker.vacancy.ambiguities = [];
  assert.match(
    validateVacancy(withoutBlocker.vacancy, {
      jobDescriptionBytes: withoutBlocker.jobDescriptionBytes,
      outcome: "blocked",
    }).join("\n"),
    /role\.market\.value null requires a blocking market_ambiguous ambiguity/,
  );

  withoutBlocker.vacancy.ambiguities = [{
    code: "salary_ambiguous",
    question: "What compensation applies?",
    blocking: true,
  }];
  assert.match(
    validateVacancy(withoutBlocker.vacancy, {
      jobDescriptionBytes: withoutBlocker.jobDescriptionBytes,
      outcome: "blocked",
    }).join("\n"),
    /role\.market\.value null requires a blocking market_ambiguous ambiguity/,
  );
});

test("deterministic invalid Step 1 fixture exercises strict and semantic failures", () => {
  const errors = validateFixture("vacancy-invalid", { outcome: "completed" }).join("\n");
  assert.match(errors, /vacancy contains unknown key: summary/);
  assert.match(errors, /createdAt must be an ISO-8601 timestamp with a timezone/);
  assert.match(errors, /process\.finalUrl must use http or https/);
  assert.match(errors, /process\.outputDir segment must contain lowercase Unicode letters/);
  assert.match(errors, /jobDescription\.sha256 does not match/);
  assert.match(errors, /responsibilities\.sourceHeadings must name at least one/);
  assert.match(errors, /requirements\.sourceHeadings must be empty when embedded/);
  assert.match(errors, /requirements\.embeddedIn must point to a separated canonical section/);
});

test("vacancy schema rejects missing and unknown fields at nested boundaries", async (t) => {
  const scenarios = [
    {
      name: "missing schemaVersion",
      mutate: (vacancy) => { delete vacancy.schemaVersion; },
      expected: /schemaVersion must be one of: 2$/m,
    },
    {
      name: "unknown process field",
      mutate: (vacancy) => { vacancy.process.status = "completed"; },
      expected: /process contains unknown key: status/,
    },
    {
      name: "impossible timestamp",
      mutate: (vacancy) => { vacancy.createdAt = "2026-02-31T09:00:00Z"; },
      expected: /createdAt must be an ISO-8601 timestamp with a timezone/,
    },
    {
      name: "missing feasibility",
      mutate: (vacancy) => { delete vacancy.role.feasibility; },
      expected: /role\.feasibility must be an object/,
    },
    {
      name: "unknown work-model field",
      mutate: (vacancy) => { vacancy.role.feasibility.workModel.inferred = true; },
      expected: /role\.feasibility\.workModel contains unknown key: inferred/,
    },
    {
      name: "unknown Section index field",
      mutate: (vacancy) => { vacancy.sectionIndex.other = {}; },
      expected: /sectionIndex contains unknown key: other/,
    },
    {
      name: "unexpected JD schema version",
      mutate: (vacancy) => { vacancy.jobDescription.schemaVersion = null; },
      expected: /jobDescription contains unknown key: schemaVersion/,
    },
    {
      name: "unknown ambiguity field",
      mutate: (vacancy) => {
        vacancy.ambiguities.push({
          code: "unknown_market",
          question: "Which market applies?",
          blocking: true,
          answer: null,
        });
      },
      expected: /ambiguities\[0\] contains unknown key: answer/,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, () => {
      const fixture = readFixture("vacancy-v2-completed");
      scenario.mutate(fixture.vacancy);
      assert.match(
        validateVacancy(fixture.vacancy, {
          jobDescriptionBytes: fixture.jobDescriptionBytes,
        }).join("\n"),
        scenario.expected,
      );
    });
  }
});

test("JD reference is fixed-name, non-empty, UTF-8, digest and size checked", async (t) => {
  const scenarios = [
    {
      name: "wrong path",
      mutate: ({ vacancy }) => { vacancy.jobDescription.path = "description.txt"; },
      expected: /jobDescription\.path must equal job-description\.txt/,
    },
    {
      name: "wrong digest",
      mutate: ({ vacancy }) => { vacancy.jobDescription.sha256 = "f".repeat(64); },
      expected: /jobDescription\.sha256 does not match/,
    },
    {
      name: "wrong size",
      mutate: ({ vacancy }) => { vacancy.jobDescription.bytes += 1; },
      expected: /jobDescription\.bytes does not match/,
    },
    {
      name: "empty JD",
      mutate: (fixture) => {
        fixture.jobDescriptionBytes = Buffer.alloc(0);
        fixture.vacancy.jobDescription.sha256 = sha256Hex(fixture.jobDescriptionBytes);
        fixture.vacancy.jobDescription.bytes = 0;
      },
      expected: /job-description\.txt must be non-empty/,
    },
    {
      name: "invalid UTF-8",
      mutate: (fixture) => {
        fixture.jobDescriptionBytes = Buffer.from([0xc3, 0x28]);
        fixture.vacancy.jobDescription.sha256 = sha256Hex(fixture.jobDescriptionBytes);
        fixture.vacancy.jobDescription.bytes = 2;
      },
      expected: /job-description\.txt must contain valid UTF-8/,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, () => {
      const fixture = readFixture("vacancy-v2-completed");
      scenario.mutate(fixture);
      assert.match(
        validateVacancy(fixture.vacancy, {
          jobDescriptionBytes: fixture.jobDescriptionBytes,
        }).join("\n"),
        scenario.expected,
      );
    });
  }
});

test("Step 1 refuses a vacancy language outside the layer's set", async (t) => {
  // The set is the default language and the ones the candidate layer configures; the example
  // configures Greek. Step 1 is where the token is written, so it is where a wrong one has to die:
  // repairing it later costs a reopen of this step and a republication of every step below it.
  const languages = candidateLanguageNames({ root: candidateExampleRootFor(repoRoot) });
  assert.deepEqual(languages, ["English", "Greek"]);
  const refused = ["en", "el", "english", "EN", "German", "Ελληνικά"];

  for (const value of refused) {
    await t.test(`refuses ${JSON.stringify(value)}`, () => {
      const fixture = readFixture("vacancy-v2-completed");
      fixture.vacancy.role.vacancyLanguage = value;
      assert.match(
        validateVacancy(fixture.vacancy, {
          jobDescriptionBytes: fixture.jobDescriptionBytes,
          languages,
          outcome: "completed",
        }).join("\n"),
        /role\.vacancyLanguage must be one of: "English", "Greek"/,
      );
    });
  }

  // The refusal is a property of the role block, not of a successful publication: a blocked
  // capture carries the same field and gets the same answer.
  await t.test("refuses the same value on a blocked capture", () => {
    const blocked = readFixture("vacancy-blocked");
    blocked.vacancy.role.vacancyLanguage = "en";
    assert.match(
      validateVacancy(blocked.vacancy, {
        jobDescriptionBytes: blocked.jobDescriptionBytes,
        languages,
        outcome: "blocked",
      }).join("\n"),
      /role\.vacancyLanguage must be one of: "English", "Greek"/,
    );
  });

  await t.test("accepts the default language and a configured one", () => {
    const fixture = readFixture("vacancy-v2-completed");
    for (const language of languages) {
      fixture.vacancy.role.vacancyLanguage = language;
      assert.deepEqual(validateVacancy(fixture.vacancy, {
        jobDescriptionBytes: fixture.jobDescriptionBytes,
        languages,
        markets: exampleMarkets,
        outcome: "completed",
      }), []);
    }
    // A fixture written in another configured language reads under a set that configures it.
    const other = readFixture("vacancy-russian-completed");
    assert.deepEqual(validateVacancy(other.vacancy, {
      jobDescriptionBytes: other.jobDescriptionBytes,
      languages: ["English", other.vacancy.role.vacancyLanguage],
      markets: exampleMarkets,
      outcome: "completed",
    }), []);
  });

  await t.test("without the layer's set only the default language is accepted", () => {
    const fixture = readFixture("vacancy-v2-completed");
    assert.deepEqual(validateVacancy(fixture.vacancy, {
      jobDescriptionBytes: fixture.jobDescriptionBytes,
      markets: exampleMarkets,
      outcome: "completed",
    }), []);
    fixture.vacancy.role.vacancyLanguage = "Greek";
    assert.match(
      validateVacancy(fixture.vacancy, {
        jobDescriptionBytes: fixture.jobDescriptionBytes,
        outcome: "completed",
      }).join("\n"),
      /role\.vacancyLanguage must be one of: "English"$/m,
    );
  });
});

test("a vacancy names one of the layer's two markets", async (t) => {
  const markets = exampleMarkets;
  const current = (mutate = () => {}, options = {}) => {
    const fixture = readFixture("vacancy-v2-completed");
    mutate(fixture.vacancy);
    return validateVacancy(fixture.vacancy, {
      jobDescriptionBytes: fixture.jobDescriptionBytes,
      markets,
      outcome: "completed",
      ...options,
    }).join("\n");
  };

  await t.test("either configured market is accepted, under the version a publication expects", () => {
    assert.equal(current(), "");
    assert.equal(current((vacancy) => { vacancy.role.market.value = markets.home.name; }), "");
    assert.equal(current(() => {}, { expectedSchemaVersion: 2 }), "");
  });

  await t.test("a name the layer does not configure is refused, the old words included", () => {
    for (const value of ["elsewhere", "russian-market", "foreign-market"]) {
      assert.match(
        current((vacancy) => { vacancy.role.market.value = value; }),
        /role\.market\.value must be one of: "domestic", "international", null/,
        value,
      );
    }
  });

  await t.test("without markets a named market is refused and an unresolved one still blocks", () => {
    assert.match(
      current(() => {}, { markets: null }),
      /role\.market\.value must be null: the candidate layer configures no market/,
    );
    assert.match(
      current(() => {}, { markets: undefined }),
      /role\.market\.value must be null: the candidate layer configures no market/,
    );
    const blocked = readFixture("vacancy-blocked");
    assert.deepEqual(validateVacancy(blocked.vacancy, {
      jobDescriptionBytes: blocked.jobDescriptionBytes,
      outcome: "blocked",
    }), []);
  });

  await t.test("version 1 and a version this reader does not know are refused", () => {
    for (const version of [1, 3]) {
      assert.match(current((vacancy) => { vacancy.schemaVersion = version; }), /schemaVersion must be one of: 2$/m);
      assert.match(
        current((vacancy) => { vacancy.schemaVersion = version; }, { expectedSchemaVersion: 2 }),
        /schemaVersion must equal 2/,
      );
    }
    // The two fixed words of version 1 are no market of any version.
    assert.match(
      current((vacancy) => {
        vacancy.schemaVersion = 1;
        vacancy.role.market.value = "foreign-market";
      }),
      /role\.market\.value must be one of: "domestic", "international", null/,
    );
  });
});

test("bundle validation cannot silently skip the referenced JD bytes", () => {
  const fixture = readFixture("vacancy-v2-completed");
  assert.match(
    validateVacancy(fixture.vacancy).join("\n"),
    /job-description\.txt bytes are required for bundle validation/,
  );
});

test("Section index enforces separated, embedded, and absent states", () => {
  const separated = readFixture("vacancy-v2-completed");
  assert.deepEqual(validateVacancy(separated.vacancy, {
    jobDescriptionBytes: separated.jobDescriptionBytes,
    markets: exampleMarkets,
  }), []);

  const embedded = readFixture("vacancy-blocked");
  assert.deepEqual(validateVacancy(embedded.vacancy, {
    jobDescriptionBytes: embedded.jobDescriptionBytes,
  }), []);

  embedded.vacancy.sectionIndex.requirements.embeddedIn = "niceToHaves";
  assert.match(
    validateVacancy(embedded.vacancy, {
      jobDescriptionBytes: embedded.jobDescriptionBytes,
    }).join("\n"),
    /embeddedIn must point to a separated canonical section/,
  );

  separated.vacancy.sectionIndex.niceToHaves.sourceHeadings = ["Nice to have"];
  assert.match(
    validateVacancy(separated.vacancy, {
      jobDescriptionBytes: separated.jobDescriptionBytes,
    }).join("\n"),
    /niceToHaves\.sourceHeadings must be empty when absent/,
  );
});

test("selected ledger process and artifact process must match exactly", () => {
  const fixture = readFixture("vacancy-v2-completed");
  const errors = validateVacancy(fixture.vacancy, {
    jobDescriptionBytes: fixture.jobDescriptionBytes,
    expectedProcess: {
      id: "proc_other",
      sourceRef: fixture.vacancy.process.sourceRef,
      outputDir: "output/other-company-role",
      companyObserved: "Other Company",
      role: "Other Role",
    },
  }).join("\n");
  assert.match(errors, /process\.id does not match the selected ledger process/);
  assert.match(errors, /process\.outputDir does not match the selected ledger process/);
  assert.match(errors, /role\.company does not match the selected ledger process/);
  assert.match(errors, /role\.title does not match the selected ledger process/);
});

test("shared strict-object, path, digest, and input-reference helpers are reusable", () => {
  const strictErrors = [];
  validateStrictObject({ path: "vacancy.json", extra: true }, "input", strictErrors, ["path"]);
  assert.deepEqual(strictErrors, ["input contains unknown key: extra"]);

  const outputErrors = [];
  validateOutputDir("output/équipe-qa-2", "outputDir", outputErrors);
  assert.deepEqual(outputErrors, []);
  validateOutputDir("output/E\u0301quipe QA", "outputDir", outputErrors);
  assert.match(outputErrors.join("\n"), /Unicode NFC normalization/);
  assert.match(outputErrors.join("\n"), /lowercase Unicode letters\/numbers/);

  const bytes = Buffer.from('{"schemaVersion":1}\n', "utf8");
  const reference = {
    path: "vacancy.json",
    schemaVersion: 1,
    sha256: sha256Hex(bytes),
    bytes: bytes.byteLength,
  };
  const referenceErrors = [];
  validateFileReference(reference, "inputs.vacancy", referenceErrors, {
    expectedPath: "vacancy.json",
    expectedSchemaVersion: 1,
    contentBytes: bytes,
  });
  assert.deepEqual(referenceErrors, []);

  const driftErrors = [];
  validateFileReference({ ...reference, schemaVersion: 2, unknown: true }, "inputs.vacancy", driftErrors, {
    expectedPath: "vacancy.json",
    expectedSchemaVersion: 1,
    contentBytes: Buffer.from("changed", "utf8"),
  });
  assert.match(driftErrors.join("\n"), /unknown key: unknown/);
  assert.match(driftErrors.join("\n"), /schemaVersion must equal 1/);
  assert.match(driftErrors.join("\n"), /sha256 does not match/);
  assert.match(driftErrors.join("\n"), /bytes does not match/);
});

test("the vacancy self-check reads the markets of the workspace's layer", (t) => {
  // The skill runs this command before it publishes. Without the layer's markets it would refuse
  // every vacancy of the current version that names one.
  const validatorPath = resolve(repoRoot, "tools/pipeline-artifacts/validate-vacancy.mjs");
  const current = readFixture("vacancy-v2-completed");
  const run = (workspaceRoot) => spawnSync(process.execPath, [
    validatorPath,
    resolve(current.directory, "vacancy.json"),
    resolve(current.directory, "job-description.txt"),
    "--outcome",
    "completed",
  ], { encoding: "utf8", env: { ...process.env, JOB_PIPELINE_WORKSPACE_ROOT: workspaceRoot } });
  const withLayer = mkdtempSync(join(tmpdir(), "job-search-vacancy-cli-"));
  const withoutLayer = mkdtempSync(join(tmpdir(), "job-search-vacancy-cli-bare-"));
  t.after(() => {
    rmSync(withLayer, { force: true, recursive: true });
    rmSync(withoutLayer, { force: true, recursive: true });
  });
  seedCandidateConfig(repoRoot, withLayer);
  const valid = run(withLayer);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).schemaVersion, 2);
  const refused = run(withoutLayer);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /the candidate layer configures no market/);
});

test("vacancy validator CLI accepts completed fixtures and rejects invalid bundles", (t) => {
  const validatorPath = resolve(repoRoot, "tools/pipeline-artifacts/validate-vacancy.mjs");
  const completed = readFixture("vacancy-v2-completed");
  const workspaceRoot = mkdtempSync(join(tmpdir(), "job-search-vacancy-cli-"));
  t.after(() => rmSync(workspaceRoot, { force: true, recursive: true }));
  seedCandidateConfig(repoRoot, workspaceRoot);
  const validRun = spawnSync(process.execPath, [
    validatorPath,
    resolve(completed.directory, "vacancy.json"),
    resolve(completed.directory, "job-description.txt"),
    "--outcome",
    "completed",
  ], { encoding: "utf8", env: { ...process.env, JOB_PIPELINE_WORKSPACE_ROOT: workspaceRoot } });
  assert.equal(validRun.status, 0, validRun.stderr);
  assert.equal(JSON.parse(validRun.stdout).status, "valid");

  const invalid = readFixture("vacancy-invalid");
  const invalidRun = spawnSync(process.execPath, [
    validatorPath,
    resolve(invalid.directory, "vacancy.json"),
    resolve(invalid.directory, "job-description.txt"),
    "--outcome",
    "completed",
  ], { encoding: "utf8" });
  assert.equal(invalidRun.status, 1);
  assert.match(invalidRun.stderr, /vacancy artifact validation failed/);
  assert.doesNotMatch(invalidRun.stdout, /"status": "valid"/);
});
