import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { normalizeDomain } from "../tools/lib/process-log-core.mjs";
import {
  detectJobSource,
  isEmployerDomainExcluded,
  jobSourceRegistry,
} from "../tools/job-sources/registry.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const frozenDomainFamilies = Object.freeze([
  ["ashby", "ashbyhq.com"],
  ["bamboohr", "bamboohr.com"],
  ["breezy", "breezy.hr"],
  ["google_docs", "docs.google.com"],
  ["greenhouse", "greenhouse.io"],
  ["hirechain", "hirechain.io"],
  ["hh_ru", "hh.ru"],
  ["huntflow", "huntflow.io"],
  ["icims", "icims.com"],
  ["jobvite", "jobvite.com"],
  ["keka", "keka.com"],
  ["lever", "lever.co"],
  ["linkedin", "linkedin.com"],
  ["workday", "myworkdayjobs.com"],
  ["pinpoint", "pinpointhq.com"],
  ["recruitee", "recruitee.com"],
  ["smartrecruiters", "smartrecruiters.com"],
  ["taleo", "taleo.net"],
  ["workable", "workable.com"],
]);

test("registry is the exact frozen owner of intermediary domain families", () => {
  const actual = jobSourceRegistry.flatMap((source) =>
    source.domainFamilies.map((domain) => [source.id, domain]));
  assert.deepEqual(actual, frozenDomainFamilies);
  assert.equal(new Set(jobSourceRegistry.map((source) => source.id)).size, jobSourceRegistry.length);
  assert.equal(new Set(actual.map(([, domain]) => domain)).size, actual.length);
  assert.equal(jobSourceRegistry.every((source) => source.employerDomainExcluded), true);
});

test("core detection and CLI denial consume the registry instead of local domain lists", () => {
  const core = readFileSync(resolve(repoRoot, "tools/lib/process-log-core.mjs"), "utf8");
  const cli = readFileSync(resolve(repoRoot, "tools/process-log.mjs"), "utf8");
  assert.match(core, /import \{ detectJobSource \} from "\.\.\/job-sources\/registry\.mjs"/);
  assert.match(core, /detectJobSource\(hostname\)/);
  assert.doesNotMatch(core, /\batsDomains\b/);
  assert.match(cli, /import \{ isEmployerDomainExcluded \} from "\.\/job-sources\/registry\.mjs"/);
  assert.match(cli, /isEmployerDomainExcluded\(domain\)/);
});

test("route facts reuse the single matcher and leave the denial guard unconditional", () => {
  const routes = readFileSync(resolve(repoRoot, "tools/job-sources/routes.mjs"), "utf8");
  const registry = readFileSync(resolve(repoRoot, "tools/job-sources/registry.mjs"), "utf8");

  assert.match(routes, /import \{ detectJobSource \} from "\.\/registry\.mjs"/);
  assert.match(routes, /detectJobSource\(sourceRef\)/);
  assert.doesNotMatch(routes, /\bdomainFamilies\b|\bjobSourceRegistry\b/);
  assert.doesNotMatch(
    routes,
    /\bfetch\(|node:(?:https?|net|dgram|dns|child_process|fs)|XMLHttpRequest|undici|require\(/,
  );

  assert.deepEqual(
    [...registry.matchAll(/employerDomainExcluded:[^\n]*/g)].map((match) =>
      match[0].trim()),
    ["employerDomainExcluded: true,"],
  );
  assert.doesNotMatch(registry, /urlTemplate|includeCompensation|postings\.json/);
});

test("source detection and employer denial share exact label-boundary matching", () => {
  for (const [id, domain] of frozenDomainFamilies) {
    assert.equal(detectJobSource(domain)?.id, id);
    assert.equal(detectJobSource(`https://TeNaNt.${domain}./jobs/1`)?.id, id);
    assert.equal(isEmployerDomainExcluded(`tenant.${domain}`), true);
  }

  assert.equal(
    detectJobSource("https://ＪＯＢＳ．ＧＲＥＥＮＨＯＵＳＥ．ＩＯ.:443/jobs/1")?.id,
    "greenhouse",
  );
  assert.equal(
    detectJobSource("https://ПРИМЕР.pinpointhq.com/postings/1")?.id,
    "pinpoint",
  );
  assert.equal(isEmployerDomainExcluded("greenhouse.io.."), true);

  for (const value of [
    "notpinpointhq.com",
    "pinpointhq.com.example.test",
    "https://greenhouse.io@evil.test/jobs/1",
    "https://careers.example.com/jobs/1",
    "https://jobs.пример.рф/vacancy/1",
  ]) {
    assert.equal(detectJobSource(value), null, value);
    assert.equal(isEmployerDomainExcluded(value), false, value);
  }
  assert.equal(
    detectJobSource("https://evil.test@greenhouse.io/jobs/1")?.id,
    "greenhouse",
  );
});

test("invalid and non-network values do not become registered job sources", () => {
  for (const value of ["", "not a domain", "direct-outreach:example", "http://localhost/jobs"]) {
    assert.equal(detectJobSource(value), null, value);
    assert.equal(isEmployerDomainExcluded(value), false, value);
  }
});

// Both production call sites normalize before they consult the registry:
// tools/process-log.mjs derives the stored value with normalizeDomain and only
// then applies the denial. This pins that exact composition, so a caller that
// reorders the two steps loses the guarantees asserted here.
test("the stored-value composition denies intermediaries in every caller-supplied form", () => {
  for (const value of [
    "pinpointhq.com",
    "TABBY.PINPOINTHQ.COM",
    "www.greenhouse.io",
    "tabby.pinpointhq.com.",
    "tabby.pinpointhq.com..",
    "ＴＡＢＢＹ．ＰＩＮＰＯＩＮＴＨＱ．ＣＯＭ",
    "ПРИМЕР.pinpointhq.com",
    "xn--e1afmkfd.pinpointhq.com",
    "https://tabby.pinpointhq.com:8443/en/postings/1?x=1#y",
    "https://user:pw@tabby.pinpointhq.com/en/postings/1",
    "//linkedin.com/jobs/1",
    "ftp://greenhouse.io",
    "spb.hh.ru",
    "www.docs.google.com",
  ]) {
    assert.equal(isEmployerDomainExcluded(normalizeDomain(value)), true, value);
  }

  for (const value of [
    "example.com",
    "www.example.com",
    "careers.example.com",
    "notpinpointhq.com",
    "pinpointhq.com.evil.test",
    "GREENHOUSE.IO.EVIL.TEST",
    "https://greenhouse.io@evil.test/jobs/1",
  ]) {
    assert.equal(isEmployerDomainExcluded(normalizeDomain(value)), false, value);
  }
});
