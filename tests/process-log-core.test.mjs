import assert from "node:assert/strict";
import {
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildDuplicateChain,
  buildMigrationBaseline,
  buildLegacySourceCollisionReport,
  buildSourceKeyVersionProjection,
  compareMigrationBaselines,
  createCompanyRecord,
  currentSourceKeyPolicyVersion,
  extractObviousFirstPartyDomain,
  legacySourceRefCollisionWitnesses,
  migrateV1ToV2,
  normalizeDomain,
  normalizeOutputDir,
  normalizeSearchText,
  normalizeSourceRef,
  normalizeSourceRefForVersion,
  searchCompanies,
  searchProcesses,
  sourceKeyPolicyVersions,
  sourceKeyTrackingParameters,
  validateLog,
} from "../tools/lib/process-log-core.mjs";
import {
  createDisposableWorkspace,
  disposableWorkspaceEnv,
} from "./fixtures/disposable-workspace.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(repoRoot, "tests/fixtures/process-log-cli-child.mjs");
const disposableByLedgerPath = new Map();

function emptyLog() {
  return {
    schema_version: 2,
    duplicate_policy: "prompt",
    updated_at: "2026-07-20T10:00:00.000Z",
    companies: [],
    processes: [],
  };
}

function emptyV3Log() {
  return {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: "2026-07-20T10:00:00.000Z",
    companies: [],
    processes: [],
  };
}

function searchFixture() {
  return {
    schema_version: 2,
    duplicate_policy: "prompt",
    updated_at: "2026-07-20T10:00:00.000Z",
    companies: [
      {
        id: "company_semrush",
        display_name: "Semrush",
        search_terms: ["Semrush", "Семраш"],
        domains: ["semrush.com"],
      },
      {
        id: "company_x5",
        display_name: "Пятёрочка / X5 Digital",
        search_terms: ["Пятёрочка / X5 Digital", "Пятёрочка", "X5 Digital"],
        domains: ["x5.ru"],
      },
    ],
    processes: [
      {
        id: "proc_old",
        started_at: "2026-07-19T10:00:00.000Z",
        source_ref: "https://careers.semrush.com/jobs/1",
        source_key: "https://careers.semrush.com/jobs/1",
        company_id: "company_semrush",
        company_observed: "Semrush Inc.",
        company_hint: null,
        role: "Senior QA Engineer",
        runner: "codex",
        output_dir: null,
        status: "started",
        duplicate_of: null,
      },
      {
        id: "proc_new",
        started_at: "2026-07-20T10:00:00.000Z",
        source_ref: "direct-outreach:x5",
        source_key: "direct-outreach:x5",
        company_id: "company_x5",
        company_observed: "X5 Digital",
        company_hint: "Пятёрочка",
        role: "QA Lead",
        runner: "claude-code",
        output_dir: "output/x5-qa-lead",
        status: "output_created",
        duplicate_of: null,
      },
    ],
  };
}

function tempLog(t, log) {
  const environment = createDisposableWorkspace(t, {
    ledger: log,
    prefix: "job-search-pipeline-test-",
  });
  disposableByLedgerPath.set(environment.ledgerPath, environment);
  t.after(() => disposableByLedgerPath.delete(environment.ledgerPath));
  return environment.ledgerPath;
}

function runCli(path, ...args) {
  const environment = disposableByLedgerPath.get(path);
  assert.ok(environment, "CLI test ledger must come from the disposable factory");
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...disposableWorkspaceEnv(environment),
    },
  });
}

test("normalizes company text, source refs, and domains", () => {
  assert.equal(normalizeSearchText("  М.ТЕХ — Ёлка  "), "м тех елка");
  assert.equal(normalizeDomain("https://WWW.Semrush.COM/careers"), "semrush.com");
  assert.equal(normalizeDomain("careers.semrush.com/jobs"), "careers.semrush.com");
  assert.equal(normalizeOutputDir("output/example-role/"), "output/example-role");
  assert.throws(() => normalizeOutputDir("output/.."), /repo-relative directory/);
  assert.equal(
    normalizeSourceRef("https://EXAMPLE.com/job/?utm_source=x&id=2#apply"),
    "https://example.com/job?id=2",
  );
});

test("company search ignores the diaeresis in every script and keeps every other mark", () => {
  assert.equal(normalizeSearchText("Müller GmbH"), normalizeSearchText("MULLER gmbh"));
  assert.equal(normalizeSearchText("Naïve"), "naive");
  // A decomposed diaeresis folds the same as a precomposed one.
  assert.equal(normalizeSearchText("Mu\u0308ller"), "muller");
  // A breve and a dakuten tell letters apart, so they stay.
  assert.notEqual(normalizeSearchText("\u0419"), normalizeSearchText("\u0418"));
  assert.notEqual(normalizeSearchText("\u30ab\u30fc\u30c9"), normalizeSearchText("\u30ab\u30fc\u30c8"));
  assert.equal(normalizeSearchText("Zo\u00eb"), "zoe");
  assert.equal(normalizeSearchText("Andr\u00e9"), "andr\u00e9");
});

test("the diaeresis is the only difference from a locale-free lowercase", () => {
  const plain = (value) => value.normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  const differing = [];
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    const text = `a${String.fromCodePoint(codePoint)}b`;
    if (normalizeSearchText(text) === plain(text)) continue;
    if (!text.normalize("NFKC").toLowerCase().normalize("NFD").includes("\u0308")) differing.push(codePoint);
  }
  assert.deepEqual(differing, []);
});

test("companies of equal rank are listed in the default language's order", () => {
  const log = emptyLog();
  for (const name of ["\u0411\u0435\u0442\u0430", "Alpha", "Gamma"]) {
    const company = createCompanyRecord(name);
    company.search_terms.push("Sharedterm");
    log.companies.push(company);
  }
  assert.deepEqual(
    searchCompanies(log, "sharedterm").map((result) => result.company.display_name),
    ["Alpha", "Gamma", "\u0411\u0435\u0442\u0430"],
  );
});

test("first-party derivation uses job-source boundaries without substring false positives", () => {
  assert.equal(
    extractObviousFirstPartyDomain("https://tabby.pinpointhq.com/en/postings/qa"),
    null,
  );
  assert.equal(
    extractObviousFirstPartyDomain("https://ПРИМЕР.pinpointhq.com/postings/qa"),
    null,
  );
  assert.equal(
    extractObviousFirstPartyDomain("https://careers.example.com/jobs/qa"),
    "example.com",
  );
  assert.equal(
    extractObviousFirstPartyDomain("https://notpinpointhq.com/jobs/qa"),
    "notpinpointhq.com",
  );
  assert.equal(
    extractObviousFirstPartyDomain("https://pinpointhq.com.example.test/jobs/qa"),
    "pinpointhq.com.example.test",
  );
  assert.deepEqual(
    createCompanyRecord("Pinpoint Tenant", {
      deterministic: true,
      sourceRefs: ["https://tabby.pinpointhq.com/en/postings/qa"],
    }).domains,
    [],
  );
});

test("legacy source collision witnesses distinguish meaningful identity from benign tracking drift", () => {
  for (const parameter of [
    "alternatechannel",
    "hhtmfrom",
    "query",
    "refid",
    "source",
    "tab",
    "trackingid",
    "trk",
  ]) {
    assert.deepEqual(
      legacySourceRefCollisionWitnesses(
        `https://example.test/jobs/1?${parameter}=alpha`,
        `https://example.test/jobs/1?${parameter}=beta`,
      ),
      [parameter],
    );
  }
  assert.deepEqual(
    legacySourceRefCollisionWitnesses(
      "https://example.test/jobs/1#overview",
      "https://example.test/jobs/1#apply",
    ),
    ["fragment"],
  );
  assert.deepEqual(
    legacySourceRefCollisionWitnesses(
      "https://example.test/jobs/1?source=alpha&source=beta",
      "https://example.test/jobs/1?source=beta&source=alpha",
    ),
    ["source"],
  );
  assert.deepEqual(
    legacySourceRefCollisionWitnesses(
      "https://example.test/jobs/1?Source=alpha",
      "https://example.test/jobs/1?source=alpha",
    ),
    ["source"],
  );

  for (const [left, right] of [
    [
      "https://EXAMPLE.test/jobs/1/?utm_source=alpha",
      "https://example.test/jobs/1?utm_source=beta",
    ],
    [
      "https://example.test/jobs/1?source=alpha&tab=overview",
      "https://example.test/jobs/1?tab=overview&source=alpha",
    ],
    [
      "https://example.test/jobs/1?query=quality%20engineer",
      "https://example.test/jobs/1?query=quality+engineer",
    ],
    ["direct-outreach:example", "direct-outreach:example"],
  ]) {
    assert.deepEqual(legacySourceRefCollisionWitnesses(left, right), []);
  }
  assert.deepEqual(
    legacySourceRefCollisionWitnesses(
      "https://example.test/jobs/1?query=alpha&id=1",
      "https://example.test/jobs/1?query=beta&id=2",
    ),
    [],
  );
});

test("legacy source collision report is deterministic, pairwise, and leaves input untouched", () => {
  const sourceKey = "https://example.test/jobs/1";
  const log = {
    processes: [
      {
        id: "proc_b",
        source_ref: "https://example.test/jobs/1?query=beta",
        source_key: sourceKey,
        duplicate_of: "proc_a",
      },
      {
        id: "proc_clear",
        source_ref: "https://example.test/jobs/2?utm_source=clear",
        source_key: "https://example.test/jobs/2",
        duplicate_of: null,
      },
      {
        id: "proc_a",
        source_ref: "https://example.test/jobs/1?query=alpha",
        source_key: sourceKey,
        duplicate_of: null,
      },
    ],
  };
  const before = structuredClone(log);

  assert.deepEqual(buildLegacySourceCollisionReport(log), {
    status: "collision",
    collision_count: 1,
    collisions: [{
      source_key: sourceKey,
      records: [
        {
          process_id: "proc_a",
          source_ref: "https://example.test/jobs/1?query=alpha",
          duplicate_of: null,
        },
        {
          process_id: "proc_b",
          source_ref: "https://example.test/jobs/1?query=beta",
          duplicate_of: "proc_a",
        },
      ],
      witnesses: [{
        process_ids: ["proc_a", "proc_b"],
        fields: ["query"],
      }],
    }],
  });
  assert.deepEqual(log, before);
  assert.deepEqual(buildLegacySourceCollisionReport({ processes: [] }), {
    status: "clear",
    collision_count: 0,
    collisions: [],
  });
});

test("source key policy versions are explicit, nested, and computed by one code path", () => {
  assert.deepEqual(sourceKeyPolicyVersions, [1, 2]);
  // The version the module writes into `source_key`. The cutover moved it to 2; the value is frozen
  // here as a literal so that moving it again — in either direction — cannot happen silently.
  assert.equal(currentSourceKeyPolicyVersion, 2);

  // Frozen literals rather than an iteration over the export: iterating would delete a parameter
  // from the expectation at the same moment it was deleted from the policy.
  assert.deepEqual(sourceKeyTrackingParameters(1), [
    "alternatechannel",
    "hhtmfrom",
    "query",
    "refid",
    "source",
    "tab",
    "trackingid",
    "trk",
  ]);
  assert.deepEqual(sourceKeyTrackingParameters(2), [
    "alternatechannel",
    "hhtmfrom",
    "trackingid",
    "trk",
  ]);
  // The four parameters CORE-03 reproduced as meaningful. docs/adr/0013 states the same list in
  // prose, and tests/instruction-contracts.test.mjs binds that prose to this export.
  const strippedByV1 = new Set(sourceKeyTrackingParameters(1));
  const strippedByV2 = new Set(sourceKeyTrackingParameters(2));
  assert.deepEqual(
    [...strippedByV1].filter((parameter) => !strippedByV2.has(parameter)).sort(),
    ["query", "refid", "source", "tab"],
  );

  assert.throws(() => sourceKeyTrackingParameters(3), /unknown source key policy version: 3/);
  assert.throws(
    () => normalizeSourceRefForVersion("https://example.test/jobs/1", 3),
    /unknown source key policy version: 3/,
  );

  // One code path: the unversioned entry point is the current version and nothing else.
  for (const reference of [
    "https://EXAMPLE.com/job/?utm_source=x&id=2#apply",
    "https://example.test/jobs/1?query=sdet&trk=abc",
    "claude-ai-web:11ec952d-b7a4-4d1b-b2ad-3bef4158711f",
  ]) {
    assert.equal(
      normalizeSourceRef(reference),
      normalizeSourceRefForVersion(reference, currentSourceKeyPolicyVersion),
      reference,
    );
  }

  // Version 2 keeps the meaningful parameter and still strips the tracking one beside it.
  assert.equal(
    normalizeSourceRefForVersion("https://example.test/jobs/1?query=sdet&trk=abc&utm_source=x", 2),
    "https://example.test/jobs/1?query=sdet",
  );
  // The prefix rule is `utm_`, not `utm`. A parameter merely starting with those three letters is
  // an ordinary parameter and must survive under both versions; nothing else pins the underscore.
  for (const version of sourceKeyPolicyVersions) {
    assert.equal(
      normalizeSourceRefForVersion("https://example.test/jobs/1?utm=a&utmx=b&utm_source=c", version),
      "https://example.test/jobs/1?utm=a&utmx=b",
      `version ${version}`,
    );
  }
  // The unversioned entry point is version 2 after the cutover: the meaningful parameter survives
  // and the tracking ones do not. This is the assertion CORE-03 could not make.
  assert.equal(
    normalizeSourceRef("https://example.test/jobs/1?query=sdet&trk=abc&utm_source=x"),
    "https://example.test/jobs/1?query=sdet",
  );
});

test("version 2 refines version 1, so a stored key can split but never merge", () => {
  // The migration's central safety property. If two references that are distinct today could become
  // one tomorrow, the duplicate-link invariant would have to be repaired before the key moved, and
  // the ordering in docs/adr/0013 would need a step it does not have.
  const hosts = [
    "https://example.test/jobs/1",
    "https://example.test/jobs/1/",
    "http://EXAMPLE.test/jobs/2?id=1",
    "https://example.test/",
  ];
  const parameters = [
    ...sourceKeyTrackingParameters(1),
    "utm_source",
    "utm_medium",
    "QUERY",
    "Source",
    "id",
    "text",
  ];
  const references = [];
  for (const host of hosts) {
    for (const parameter of parameters) {
      for (const value of ["a", "b", ""]) {
        const separator = host.includes("?") ? "&" : "?";
        references.push(`${host}${separator}${parameter}=${value}`);
        references.push(`${host}${separator}${parameter}=${value}#fragment`);
      }
    }
  }
  references.push("claude-ai-web:11ec952d-b7a4-4d1b-b2ad-3bef4158711f");
  references.push("direct-outreach:example");

  assert.equal(references.length >= 300, true, `corpus size ${references.length}`);
  let comparedPairs = 0;
  for (let left = 0; left < references.length; left += 1) {
    for (let right = left + 1; right < references.length; right += 1) {
      comparedPairs += 1;
      if (
        normalizeSourceRefForVersion(references[left], 2)
        === normalizeSourceRefForVersion(references[right], 2)
      ) {
        assert.equal(
          normalizeSourceRefForVersion(references[left], 1),
          normalizeSourceRefForVersion(references[right], 1),
          `merge witness: ${references[left]} / ${references[right]}`,
        );
      }
    }
  }
  assert.equal(comparedPairs >= 40000, true, `compared ${comparedPairs} pairs`);

  // A reference that is not a URL is returned verbatim by both versions, so the imported historical
  // fallback grammar cannot be moved by a policy change.
  for (const reference of [
    "claude-ai-web:11ec952d-b7a4-4d1b-b2ad-3bef4158711f",
    "direct-outreach:example",
  ]) {
    assert.equal(normalizeSourceRefForVersion(reference, 1), reference);
    assert.equal(normalizeSourceRefForVersion(reference, 2), reference);
  }
});

test("source key projection sees the lone changing record the collision report cannot", () => {
  const log = {
    processes: [
      {
        id: "proc_split_b",
        source_ref: "https://example.test/jobs/1?query=beta",
        source_key: "https://example.test/jobs/1",
        duplicate_of: "proc_split_a",
        updated_at: "2026-08-13T08:00:00.000Z",
      },
      {
        id: "proc_split_a",
        source_ref: "https://example.test/jobs/1?query=alpha",
        source_key: "https://example.test/jobs/1",
        duplicate_of: null,
        updated_at: "2026-08-13T08:00:00.000Z",
      },
      {
        id: "proc_lone",
        source_ref: "https://example.test/jobs/solo?source=hh",
        source_key: "https://example.test/jobs/solo",
        duplicate_of: null,
        updated_at: "2026-08-13T08:00:00.000Z",
      },
      {
        id: "proc_historical",
        source_ref: "https://example.test/jobs/old?tab=team",
        source_key: "https://example.test/jobs/old",
        duplicate_of: null,
      },
      {
        id: "proc_stable",
        source_ref: "https://example.test/jobs/stable?utm_source=x",
        source_key: "https://example.test/jobs/stable",
        duplicate_of: null,
        updated_at: "2026-08-13T08:00:00.000Z",
      },
    ],
  };
  const before = structuredClone(log);
  const projection = buildSourceKeyVersionProjection(log);

  assert.deepEqual(log, before, "the census must not mutate its input");
  assert.deepEqual(projection.policy, { to_version: 2 });
  assert.equal(projection.status, "split");
  assert.equal(projection.record_count, 5);
  assert.equal(projection.changed_count, 4);
  assert.equal(projection.merge_count, 0);
  assert.deepEqual(projection.merges, []);

  // The record the R1-03C containment report provably misses: it is alone under its stored key, so
  // that report emits nothing for it, while its key still changes.
  assert.deepEqual(
    buildLegacySourceCollisionReport(log).collisions.map((collision) => collision.source_key),
    ["https://example.test/jobs/1"],
  );
  assert.deepEqual(
    projection.changed.map((record) => record.process_id),
    ["proc_historical", "proc_lone", "proc_split_a", "proc_split_b"],
  );
  assert.deepEqual(
    projection.changed.find((record) => record.process_id === "proc_lone"),
    {
      process_id: "proc_lone",
      record_class: "file-backed",
      source_ref: "https://example.test/jobs/solo?source=hh",
      stored_source_key: "https://example.test/jobs/solo",
      projected_source_key: "https://example.test/jobs/solo?source=hh",
    },
  );
  // The class is reported, because an immutable historical record cannot be repaired afterwards.
  assert.equal(
    projection.changed.find((record) => record.process_id === "proc_historical").record_class,
    "historical",
  );
  // A record whose only parameter is genuine tracking does not change and is not reported.
  assert.equal(
    projection.changed.some((record) => record.process_id === "proc_stable"),
    false,
  );

  assert.equal(projection.split_group_count, 1);
  // The link that the projection breaks, named rather than summarised: its two ends share a stored
  // key today and land on different projected keys afterwards.
  assert.equal(projection.broken_duplicate_link_count, 1);
  assert.deepEqual(projection.broken_duplicate_links, [{
    process_id: "proc_split_b",
    duplicate_of: "proc_split_a",
    stored_source_key: "https://example.test/jobs/1",
    projected_source_key: "https://example.test/jobs/1?query=beta",
    duplicate_of_projected_source_key: "https://example.test/jobs/1?query=alpha",
  }]);
  assert.deepEqual(projection.split_groups, [{
    stored_source_key: "https://example.test/jobs/1",
    projected_source_keys: [
      "https://example.test/jobs/1?query=alpha",
      "https://example.test/jobs/1?query=beta",
    ],
    members: [
      {
        process_id: "proc_split_a",
        record_class: "file-backed",
        source_ref: "https://example.test/jobs/1?query=alpha",
        projected_source_key: "https://example.test/jobs/1?query=alpha",
        duplicate_of: null,
      },
      {
        process_id: "proc_split_b",
        record_class: "file-backed",
        source_ref: "https://example.test/jobs/1?query=beta",
        projected_source_key: "https://example.test/jobs/1?query=beta",
        duplicate_of: "proc_split_a",
      },
    ],
  }]);
});

test("only a link the projection actually breaks is reported as broken", () => {
  // A group whose members stay together keeps its link, so it must not appear as broken. Without
  // this case `brokenDuplicateLinks` could report every link and every assertion above would hold.
  const survives = buildSourceKeyVersionProjection({
    processes: [
      {
        id: "proc_a",
        source_ref: "https://example.test/jobs/1?query=same&utm_source=a",
        source_key: "https://example.test/jobs/1",
        duplicate_of: null,
      },
      {
        id: "proc_b",
        source_ref: "https://example.test/jobs/1?query=same&utm_source=b",
        source_key: "https://example.test/jobs/1",
        duplicate_of: "proc_a",
      },
      {
        id: "proc_c",
        source_ref: "https://example.test/jobs/1?tab=other",
        source_key: "https://example.test/jobs/1",
        duplicate_of: null,
      },
    ],
  });
  assert.equal(survives.split_group_count, 1);
  assert.deepEqual(survives.split_groups[0].projected_source_keys, [
    "https://example.test/jobs/1?query=same",
    "https://example.test/jobs/1?tab=other",
  ]);
  assert.equal(survives.broken_duplicate_link_count, 0);
  assert.deepEqual(survives.broken_duplicate_links, []);

  // A link that already crosses two stored keys was never a same-key link, so the projection does
  // not break it and it is not this census's business. A ledger that loads cannot hold one, and the
  // guard exists because the function is exported and not only reached through the CLI.
  const alreadyCrossing = buildSourceKeyVersionProjection({
    processes: [
      {
        id: "proc_a",
        source_ref: "https://example.test/jobs/1?query=alpha",
        source_key: "https://example.test/jobs/1",
        duplicate_of: null,
      },
      {
        id: "proc_b",
        source_ref: "https://example.test/jobs/1?query=beta",
        source_key: "https://example.test/jobs/1",
        duplicate_of: "proc_elsewhere",
      },
      {
        id: "proc_elsewhere",
        source_ref: "https://example.test/jobs/2?tab=team",
        source_key: "https://example.test/jobs/2",
        duplicate_of: null,
      },
      {
        id: "proc_dangling",
        source_ref: "https://example.test/jobs/3?source=hh",
        source_key: "https://example.test/jobs/3",
        duplicate_of: "proc_missing",
      },
    ],
  });
  assert.deepEqual(alreadyCrossing.broken_duplicate_links, []);
  assert.equal(alreadyCrossing.broken_duplicate_link_count, 0);

  // The premise docs/adr/0013 now states explicitly. The group invariant exempts the first record of
  // a group and only requires the rest to point at some member, and it never checks acyclicity, so a
  // cycle among the non-exempt members splits while breaking nothing. The ledger below loads. The
  // census must report the split and honestly report zero broken links rather than invent one.
  const cyclic = buildSourceKeyVersionProjection({
    processes: [
      {
        id: "proc_exempt",
        source_ref: "https://example.test/jobs/1?utm_source=a",
        source_key: "https://example.test/jobs/1",
        duplicate_of: null,
      },
      {
        id: "proc_cycle_a",
        source_ref: "https://example.test/jobs/1?query=b",
        source_key: "https://example.test/jobs/1",
        duplicate_of: "proc_cycle_b",
      },
      {
        id: "proc_cycle_b",
        source_ref: "https://example.test/jobs/1?query=b&utm_medium=z",
        source_key: "https://example.test/jobs/1",
        duplicate_of: "proc_cycle_a",
      },
    ],
  });
  assert.equal(cyclic.split_group_count, 1);
  assert.deepEqual(cyclic.split_groups[0].projected_source_keys, [
    "https://example.test/jobs/1",
    "https://example.test/jobs/1?query=b",
  ]);
  assert.equal(cyclic.broken_duplicate_link_count, 0);
  assert.deepEqual(cyclic.broken_duplicate_links, []);

  assert.deepEqual(buildSourceKeyVersionProjection({ processes: [] }), {
    status: "clear",
    policy: { to_version: 2 },
    record_count: 0,
    changed_count: 0,
    split_group_count: 0,
    merge_count: 0,
    broken_duplicate_link_count: 0,
    changed: [],
    split_groups: [],
    merges: [],
    broken_duplicate_links: [],
  });

  assert.throws(
    () => buildSourceKeyVersionProjection({ processes: [] }, { toVersion: 3 }),
    /unknown source key policy version: 3/,
  );
});

test("source key projection compares against the stored key, not against a recomputed one", () => {
  // Before the cutover every stored key was the version 1 key, so a comparison against a recomputed
  // version 1 key agreed with a comparison against the stored one and a mutation between them
  // survived every fixture above. They stopped agreeing when the computed version moved: a record
  // written after it carries a version 2 key. The census must say that record does not change, and
  // a version-to-version comparison would say it does.
  const alreadyMigrated = buildSourceKeyVersionProjection({
    processes: [
      {
        id: "proc_new",
        source_ref: "https://example.test/jobs/1?query=alpha",
        // What the cutover writes: the version 2 key.
        source_key: "https://example.test/jobs/1?query=alpha",
        duplicate_of: null,
      },
      {
        id: "proc_old",
        source_ref: "https://example.test/jobs/2?query=beta",
        source_key: "https://example.test/jobs/2",
        duplicate_of: null,
      },
    ],
  });
  assert.deepEqual(
    alreadyMigrated.changed.map((record) => record.process_id),
    ["proc_old"],
  );
  assert.equal(alreadyMigrated.changed_count, 1);
});

test("the merge detector fires on a coarsening projection, which version 2 can never be", () => {
  // The merge leg is unreachable in the direction the cutover takes, precisely because version 2
  // refines. Exercising it in the opposite direction is the only way to prove the detector works
  // rather than being an always-empty field, and it makes the asymmetry itself executable.
  const log = {
    processes: [
      {
        id: "proc_a",
        source_ref: "https://example.test/jobs/1?query=alpha",
        source_key: "https://example.test/jobs/1?query=alpha",
        duplicate_of: null,
      },
      {
        id: "proc_b",
        source_ref: "https://example.test/jobs/1?query=beta",
        source_key: "https://example.test/jobs/1?query=beta",
        duplicate_of: null,
      },
    ],
  };
  const coarsening = buildSourceKeyVersionProjection(log, { toVersion: 1 });
  assert.deepEqual(coarsening.policy, { to_version: 1 });
  assert.equal(coarsening.merge_count, 1);
  assert.deepEqual(coarsening.merges, [{
    projected_source_key: "https://example.test/jobs/1",
    stored_source_keys: [
      "https://example.test/jobs/1?query=alpha",
      "https://example.test/jobs/1?query=beta",
    ],
  }]);
  // A merge always implies a changed record, which is why the verdict reads `changed` alone.
  assert.equal(coarsening.changed_count, 2);
  assert.equal(coarsening.status, "split");

  // The same corpus in the direction that matters reports no merge at all.
  const refining = buildSourceKeyVersionProjection(log, { toVersion: 2 });
  assert.equal(refining.merge_count, 0);
  assert.deepEqual(refining.merges, []);
  assert.equal(refining.changed_count, 0);
  assert.equal(refining.status, "clear");
});

test("every ordered list in the census has more than one element somewhere, and is sorted", () => {
  // With one element per list a dropped `sort` is invisible. Two split groups, two merges and two
  // broken links, all fed in reverse order, are the only way the ordering claims mean anything.
  const projection = buildSourceKeyVersionProjection({
    processes: [
      {
        id: "proc_01_beta",
        source_ref: "https://example.test/jobs/z?query=beta",
        source_key: "https://example.test/jobs/z?query=beta",
        duplicate_of: null,
      },
      {
        id: "proc_02_alpha",
        source_ref: "https://example.test/jobs/z?query=alpha",
        source_key: "https://example.test/jobs/z?query=alpha",
        duplicate_of: null,
      },
      {
        id: "proc_03_beta",
        source_ref: "https://example.test/jobs/a?tab=beta",
        source_key: "https://example.test/jobs/a?tab=beta",
        duplicate_of: null,
      },
      {
        id: "proc_04_alpha",
        source_ref: "https://example.test/jobs/a?tab=alpha",
        source_key: "https://example.test/jobs/a?tab=alpha",
        duplicate_of: null,
      },
    ],
  }, { toVersion: 1 });
  assert.deepEqual(projection.merges.map((merge) => merge.projected_source_key), [
    "https://example.test/jobs/a",
    "https://example.test/jobs/z",
  ]);
  assert.deepEqual(
    projection.changed.map((record) => record.process_id),
    ["proc_01_beta", "proc_02_alpha", "proc_03_beta", "proc_04_alpha"],
  );

  const splitting = buildSourceKeyVersionProjection({
    processes: [
      {
        id: "proc_01_z_alpha",
        source_ref: "https://example.test/jobs/z?query=alpha",
        source_key: "https://example.test/jobs/z",
        duplicate_of: null,
      },
      {
        id: "proc_02_z_beta",
        source_ref: "https://example.test/jobs/z?query=beta",
        source_key: "https://example.test/jobs/z",
        duplicate_of: "proc_01_z_alpha",
      },
      {
        id: "proc_03_a_alpha",
        source_ref: "https://example.test/jobs/a?tab=alpha",
        source_key: "https://example.test/jobs/a",
        duplicate_of: null,
      },
      {
        id: "proc_04_a_beta",
        source_ref: "https://example.test/jobs/a?tab=beta",
        source_key: "https://example.test/jobs/a",
        duplicate_of: "proc_03_a_alpha",
      },
    ],
  });
  assert.deepEqual(
    splitting.split_groups.map((group) => group.stored_source_key),
    ["https://example.test/jobs/a", "https://example.test/jobs/z"],
  );
  assert.deepEqual(
    splitting.split_groups[0].members.map((member) => member.process_id),
    ["proc_03_a_alpha", "proc_04_a_beta"],
  );
  assert.deepEqual(
    splitting.broken_duplicate_links.map((link) => link.process_id),
    ["proc_02_z_beta", "proc_04_a_beta"],
  );
});

test("a mixed-version ledger is where two stored keys could converge, and the census looks there", () => {
  // The post-cutover state docs/adr/0013 projects: one record already carries a version 2 key while
  // its neighbour still carries a version 1 one. Grouping merges by policy version rather than by
  // the stored key would report nothing here, which is exactly when an operator needs to be told.
  const mixed = buildSourceKeyVersionProjection({
    processes: [
      {
        id: "proc_migrated",
        source_ref: "https://example.test/jobs/1?query=alpha",
        source_key: "https://example.test/jobs/1?query=alpha",
        duplicate_of: null,
      },
      {
        id: "proc_legacy",
        source_ref: "https://example.test/jobs/1?query=alpha&trk=abc",
        source_key: "https://example.test/jobs/1",
        duplicate_of: null,
      },
    ],
  });
  assert.equal(mixed.merge_count, 1);
  assert.deepEqual(mixed.merges, [{
    projected_source_key: "https://example.test/jobs/1?query=alpha",
    stored_source_keys: [
      "https://example.test/jobs/1",
      "https://example.test/jobs/1?query=alpha",
    ],
  }]);
  // The already-migrated record is not reported as changing; only the legacy one is.
  assert.deepEqual(mixed.changed.map((record) => record.process_id), ["proc_legacy"]);
});

test("search ranks aliases and domains and protects short queries", () => {
  const log = searchFixture();
  assert.equal(searchProcesses(log, "Semrush")[0].match.type, "exact");
  assert.equal(searchProcesses(log, "Семраш")[0].process.id, "proc_old");
  assert.equal(searchProcesses(log, "sem")[0].match.type, "token-prefix");
  assert.equal(searchProcesses(log, "se").length, 0);
  assert.equal(searchProcesses(log, "rush")[0].match.type, "substring");
  assert.equal(searchProcesses(log, "https://careers.semrush.com/jobs")[0].match.type, "domain");
  assert.equal(searchProcesses(log, "x5 digi")[0].process.id, "proc_new");
  assert.deepEqual(searchProcesses(log, "").map((result) => result.process.id), ["proc_new", "proc_old"]);
});

test("process search orders equivalent ISO encodings by instant, not lexical text", () => {
  const log = searchFixture();
  log.updated_at = "2026-07-20T09:00:00.000Z";
  log.processes.find(({ id }) => id === "proc_old").started_at =
    "2026-07-20T10:00:00.000+02:00";
  log.processes.find(({ id }) => id === "proc_new").started_at =
    "2026-07-20T09:00:00.000Z";

  assert.deepEqual(
    searchProcesses(log, "").map((result) => result.process.id),
    ["proc_new", "proc_old"],
  );
});

test("an unlinked failed process remains searchable by its company hint", () => {
  const log = emptyLog();
  log.processes.push({
    id: "proc_failed",
    started_at: "2026-07-20T10:00:00.000Z",
    source_ref: "https://hh.ru/vacancy/1",
    source_key: "https://hh.ru/vacancy/1",
    company_id: null,
    company_observed: null,
    company_hint: "Айсмарт / iSmart",
    role: null,
    runner: "codex",
    output_dir: null,
    status: "fetch_failed",
    duplicate_of: null,
  });
  const [result] = searchProcesses(log, "iSmart");
  assert.equal(result.process.id, "proc_failed");
  assert.equal(result.company, null);
  assert.equal(result.match.type, "token-prefix");
});

test("a process is searchable by an obvious first-party source domain even before enrichment", () => {
  const log = emptyLog();
  log.processes.push({
    id: "proc_domain",
    started_at: "2026-07-20T10:00:00.000Z",
    source_ref: "https://careers.example.com/jobs/qa",
    source_key: "https://careers.example.com/jobs/qa",
    company_id: null,
    company_observed: null,
    company_hint: null,
    role: null,
    runner: "codex",
    output_dir: null,
    status: "fetch_failed",
    duplicate_of: null,
  });
  const [result] = searchProcesses(log, "https://www.example.com/about");
  assert.equal(result.process.id, "proc_domain");
  assert.equal(result.match.type, "domain");
  assert.equal(result.match.value, "example.com");
});

test("migration preserves a dynamic v1 baseline", () => {
  const v1 = {
    schema_version: 1,
    duplicate_policy: "prompt",
    updated_at: "2026-07-20T10:00:00.000Z",
    processes: [{
      id: "proc_1",
      started_at: "2026-07-20T09:00:00.000Z",
      source_ref: "https://careers.example.com/job/1",
      source_key: "https://careers.example.com/job/1",
      company: "Компания (Company)",
      role: "QA Engineer",
      runner: "claude-code",
      output_dir: null,
      status: "started",
      duplicate_of: null,
    }],
  };
  const before = buildMigrationBaseline(v1);
  const migrated = migrateV1ToV2(v1).log;
  assert.equal(validateLog(migrated), migrated);
  assert.deepEqual(migrated.companies[0].search_terms, ["Компания (Company)", "Компания", "Company"]);
  assert.deepEqual(migrated.companies[0].domains, ["example.com"]);
  assert.deepEqual(compareMigrationBaselines(before, buildMigrationBaseline(migrated)), {
    equal: true,
    before_count: 1,
    after_count: 1,
  });
});

test("migration does not treat an ATS hostname as a company domain", () => {
  const v1 = {
    schema_version: 1,
    duplicate_policy: "prompt",
    updated_at: "2026-07-20T10:00:00.000Z",
    processes: [{
      id: "proc_ats",
      started_at: "2026-07-20T09:00:00.000Z",
      source_ref: "https://example-company.breezy.hr/p/qa",
      source_key: "https://example-company.breezy.hr/p/qa",
      company: "Example Company",
      role: "QA Engineer",
      runner: "claude-code",
      output_dir: null,
      status: "started",
      duplicate_of: null,
    }],
  };
  assert.deepEqual(migrateV1ToV2(v1).log.companies[0].domains, []);
});

test("v3 CLI records starts and token-guarded failures before any output", (t) => {
  const path = tempLog(t, emptyV3Log());
  const started = runCli(path, "start", "--source-ref", "https://example.com/jobs/1", "--runner", "codex", "--company-hint", "Example");
  assert.equal(started.status, 0, started.stderr);
  const record = JSON.parse(started.stdout).process;
  assert.equal(record.company_hint, "Example");
  assert.equal(record.artifact_mode, "file-backed");
  assert.equal(record.steps.get_vacancy.state, "running");
  const failed = runCli(
    path,
    "fail-step",
    "--id",
    record.id,
    "--step",
    "get_vacancy",
    "--attempt-id",
    record.steps.get_vacancy.active_attempt.id,
    "--error-json",
    JSON.stringify({
      code: "fetch_failed",
      message: "Не удалось получить тестовую вакансию.",
      retryable: true,
      details: ["synthetic fetch failure"],
    }),
  );
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(
    JSON.parse(failed.stdout).process.steps.get_vacancy.state,
    "failed",
  );
});

test("CLI duplicate detection happens without mutating the log", (t) => {
  const path = tempLog(t, emptyV3Log());
  assert.equal(runCli(path, "start", "--source-ref", "https://example.com/jobs/1?utm_source=x", "--runner", "codex").status, 0);
  const before = readFileSync(path, "utf8");
  const duplicate = runCli(path, "start", "--source-ref", "https://example.com/jobs/1", "--runner", "claude-code");
  assert.equal(duplicate.status, 2);
  assert.equal(JSON.parse(duplicate.stdout).status, "duplicate");
  assert.equal(readFileSync(path, "utf8"), before);
});

test("v3 CLI rejects a top-level v2 ledger without mutating it", (t) => {
  const v2 = emptyLog();
  v2.processes.push({
    id: "proc_v2",
    started_at: "2026-07-20T09:00:00.000Z",
    source_ref: "direct-outreach:example",
    source_key: "direct-outreach:example",
    company_id: null,
    company_observed: "Example",
    company_hint: null,
    role: "QA",
    runner: "manual",
    output_dir: null,
    status: "started",
    duplicate_of: null,
  });
  const path = tempLog(t, v2);
  const before = readFileSync(path, "utf8");
  const validation = runCli(path, "validate");
  assert.equal(validation.status, 1);
  assert.equal(
    JSON.parse(validation.stderr).error.code,
    "process_log_validation_failed",
  );
  assert.deepEqual(JSON.parse(validation.stderr).error, {
    code: "process_log_validation_failed",
    message: "Process log failed structural validation.",
    context: "operation=validate_process_log",
    recovery_action: "repair_process_log_schema",
  });
  assert.doesNotMatch(validation.stderr, /schema_version must be 4/);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("v3 CLI manages aliases, domains, guarded links, and output reservation", (t) => {
  const path = tempLog(t, emptyV3Log());
  const start = JSON.parse(runCli(path, "start", "--source-ref", "direct-outreach:one", "--runner", "codex").stdout);
  assert.equal(runCli(
    path,
    "update",
    "--id",
    start.process.id,
    "--company-observed",
    "Example Labs",
    "--role",
    "QA Engineer",
  ).status, 0);
  const first = JSON.parse(runCli(path, "create-company", "--display-name", "Example", "--term", "Экзампл", "--domain", "example.com").stdout);
  assert.equal(runCli(path, "link-company", "--id", start.process.id, "--company-id", first.company.id).status, 0);
  assert.equal(runCli(path, "add-company-term", "--id", first.company.id, "--term", "Shared Name").status, 0);
  assert.equal(runCli(path, "add-company-domain", "--id", first.company.id, "--domain", "www.example.org/path").status, 0);
  assert.equal(runCli(path, "rename-company", "--id", first.company.id, "--display-name", "Example Labs").status, 0);
  const reservation = runCli(path, "reserve-output", "--id", start.process.id);
  assert.equal(reservation.status, 0, reservation.stderr);
  assert.equal(
    JSON.parse(reservation.stdout).output_dir,
    "output/example-labs-qa-engineer",
  );

  const second = JSON.parse(runCli(path, "create-company", "--display-name", "Another").stdout);
  assert.equal(runCli(path, "add-company-term", "--id", second.company.id, "--term", "Shared Name").status, 0);
  const ambiguous = JSON.parse(runCli(path, "find-company", "--query", "Shared Name").stdout);
  assert.equal(ambiguous.matches.length, 2);
  const beforeAmbiguousCreate = readFileSync(path, "utf8");
  const ambiguousCreate = runCli(
    path,
    "create-company",
    "--display-name",
    "Shared Name",
  );
  assert.equal(ambiguousCreate.status, 2);
  assert.equal(JSON.parse(ambiguousCreate.stdout).status, "ambiguous");
  assert.equal(readFileSync(path, "utf8"), beforeAmbiguousCreate);
  assert.equal(runCli(path, "remove-company-term", "--id", second.company.id, "--term", "Shared Name").status, 0);
  assert.equal(runCli(path, "remove-company-domain", "--id", first.company.id, "--domain", "example.com").status, 0);

  const finalLog = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(finalLog.processes[0].company_id, first.company.id);
  assert.equal(
    finalLog.processes[0].output_dir,
    "output/example-labs-qa-engineer",
  );
  assert.equal(finalLog.processes[0].steps.get_vacancy.state, "running");
  const finalCompany = finalLog.companies.find((company) => company.id === first.company.id);
  assert.equal(finalCompany.display_name, "Example Labs");
  assert.deepEqual(finalCompany.domains, ["example.org"]);
});

function chainLog(processes) {
  return {
    schema_version: 4,
    duplicate_policy: "prompt",
    updated_at: "2026-08-01T00:00:00.000Z",
    companies: [],
    processes,
  };
}

function chainRecord(id, { sourceRef, duplicateOf = null, startedAt, historical = false }) {
  const record = {
    id,
    started_at: startedAt,
    source_ref: sourceRef,
    source_key: normalizeSourceRef(sourceRef),
    company_id: null,
    company_observed: null,
    role: null,
    runner: "codex",
    output_dir: null,
    duplicate_of: duplicateOf,
  };
  // `classifyProcessRecord` reads the shape: a historical row carries no file-backed fields at all.
  if (!historical) {
    record.updated_at = startedAt;
    record.artifact_mode = "file-backed";
  }
  return record;
}

test("the duplicate chain reads the whole history of one vacancy from either end", () => {
  // The shape of the motivating case: a dead posting, a technical record that shares the file
  // reference, and the fresh process. `duplicate_of` points one way, so the old end would see
  // nothing without the reverse direction.
  const log = chainLog([
    chainRecord("proc_july_posting", {
      sourceRef: "https://apply.workable.test/ergonia/j/ABC",
      startedAt: "2026-07-20T08:47:48.000Z",
      historical: true,
    }),
    chainRecord("proc_august_technical", {
      sourceRef: "local-file:JD Cashen",
      duplicateOf: "proc_july_posting",
      startedAt: "2026-08-06T09:26:24.000Z",
    }),
    chainRecord("proc_august_fresh", {
      sourceRef: "local-file:JD Cashen",
      duplicateOf: "proc_august_technical",
      startedAt: "2026-08-06T09:39:47.000Z",
    }),
    chainRecord("proc_unrelated", {
      sourceRef: "https://example.test/other",
      startedAt: "2026-08-07T00:00:00.000Z",
    }),
  ]);

  const expectedMembers = [
    "proc_july_posting",
    "proc_august_technical",
    "proc_august_fresh",
  ];
  for (const seed of expectedMembers) {
    const chain = buildDuplicateChain(log, seed);
    assert.equal(chain.status, "chain");
    assert.equal(chain.member_count, 3);
    assert.deepEqual(chain.members.map((member) => member.process_id), expectedMembers);
  }
  assert.equal(
    buildDuplicateChain(log, "proc_july_posting").members[0].record_class,
    "historical",
  );
  assert.equal(buildDuplicateChain(log, "proc_unrelated").status, "single");
  assert.equal(buildDuplicateChain(log, "proc_missing").status, "unknown_process");
});

test("the duplicate chain terminates on a ledger that already holds a cycle", () => {
  // Load-time validation forbids a dangling link and a self-reference, never a cycle, so a restored
  // or hand-assembled ledger can hold one. A naive forward walk would never return.
  const log = chainLog([
    chainRecord("proc_cycle_first", {
      sourceRef: "local-file:looped",
      startedAt: "2026-08-01T00:00:00.000Z",
    }),
    chainRecord("proc_cycle_left", {
      sourceRef: "local-file:looped",
      duplicateOf: "proc_cycle_right",
      startedAt: "2026-08-02T00:00:00.000Z",
    }),
    chainRecord("proc_cycle_right", {
      sourceRef: "local-file:looped",
      duplicateOf: "proc_cycle_left",
      startedAt: "2026-08-03T00:00:00.000Z",
    }),
  ]);

  const chain = buildDuplicateChain(log, "proc_cycle_left");
  assert.equal(chain.member_count, 2);
  assert.deepEqual(
    chain.members.map((member) => member.process_id),
    ["proc_cycle_left", "proc_cycle_right"],
  );
});
