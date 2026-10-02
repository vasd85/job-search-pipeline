/** Recognition only; independent prices belong to candidate.config.tool_match. */
export const TOOLMATCH_TAXONOMY_ID = "toolmatch-taxonomy-v6-2026-10-01";
export const LANGUAGE_NAMES = Object.freeze([
  "TypeScript", "JavaScript", "Java", "Kotlin", "Groovy", "Scala", "Python", "C#", "F#",
  "Go", "Ruby", "PHP", "Swift", "Objective-C", "Dart", "C", "C++", "Rust", "Perl",
]);
export const FRAMEWORK_CLASSES = Object.freeze([
  "web_ui", "codeless", "mobile", "api_test", "runner", "specification", "performance", "contract",
]);
const FRAMEWORKS = Object.freeze({
  web_ui: ["Playwright", "Selenium", "Selenide", "Cypress", "WebdriverIO", "Puppeteer", "TestCafe", "Nightwatch", "Protractor", "Capybara", "Synpress", "Dappwright"],
  codeless: ["Tosca", "TestComplete", "Katalon", "Ranorex", "UFT", "SikuliX", "Squish", "EggPlant", "Testim", "Mabl", "WinAppDriver", "AutoIt"],
  mobile: ["Appium", "Espresso", "Kaspresso", "UIAutomator", "XCUITest", "EarlGrey", "Detox", "Patrol", "Maestro"],
  api_test: ["REST Assured", "Karate", "Supertest"],
  runner: ["JUnit", "TestNG", "Spock", "Kotest", "PyTest", "unittest", "Jest", "Mocha", "Vitest", "Jasmine", "NUnit", "xUnit", "MSTest", "RSpec", "PHPUnit", "Ginkgo", "testify", "Arquillian"],
  specification: ["Cucumber", "Gherkin", "SpecFlow", "Behave", "Robot Framework", "Serenity"],
  performance: ["k6", "Gatling", "Locust", "Artillery", "JMeter", "LoadRunner", "NeoLoad", "Yandex.Tank", "ZeroCode BDD"],
  contract: ["Pact", "Spring Cloud Contract"],
});
export const SUPPORTING_NAMES = Object.freeze([
  "SQL", "Bash", "Shell", "PowerShell", "HTML", "CSS", "XML", "JSON", "YAML",
  "CI", "CI/CD", "Docker", "Kubernetes", "Ansible", "Terraform", "Allure", "ReportPortal",
  "GitLab CI", "GitHub Actions", "Jenkins", "TeamCity", "Azure DevOps", "CircleCI",
  "Postman", "Newman", "SoapUI", "ReadyAPI", "Insomnia", "Bruno", "curl",
  "requests", "httpx", "RestSharp", "Retrofit", "WebClient", "axios", "OkHttp",
  "Mockito", "WireMock", "Testcontainers", "SonarQube", "JaCoCo", "Grafana", "Applitools", "Percy",
  "Stryker", "PIT", "fast-check", "jqwik", "Chromatic", "OpenTelemetry", "Prometheus", "Datadog", "ArgoCD", "Flux",
]);
const ALIASES = Object.freeze({
  "ts": "TypeScript", "js": "JavaScript", "node.js": "JavaScript", "nodejs": "JavaScript",
  "golang": "Go", "csharp": "C#", "c#/.net": "C#",
  "playwright test": "Playwright", "@playwright/test": "Playwright", "playwright-core": "Playwright",
  "selenium webdriver": "Selenium", "webdriver": "Selenium", "wdio": "WebdriverIO", "webdriver io": "WebdriverIO",
  "cypress.io": "Cypress", "restassured": "REST Assured", "rest-assured": "REST Assured",
  "junit 4": "JUnit", "junit 5": "JUnit", "junit5": "JUnit", "robotframework": "Robot Framework",
  "cucumber-js": "Cucumber", "cucumber-jvm": "Cucumber", "reqnroll": "SpecFlow", "serenity bdd": "Serenity",
  "apache jmeter": "JMeter", "zerocode": "ZeroCode BDD", "grafana k6": "k6", "ui automator": "UIAutomator",
  "tricentis tosca": "Tosca", "qtp": "UFT", "eggplant functional": "EggPlant", "eggplant dai": "EggPlant",
  "gitlab ci/cd": "GitLab CI", "github action": "GitHub Actions", "open telemetry": "OpenTelemetry",
  "argo cd": "ArgoCD", "fastcheck": "fast-check", "ready api": "ReadyAPI",
});
export function normalizeToolName(name) {
  return name.trim().toLowerCase().replace(/\s+/gu, " ");
}
const byName = new Map();
const frameworkClass = new Map();
const languageSet = new Set(LANGUAGE_NAMES);
const supportingSet = new Set(SUPPORTING_NAMES);
for (const name of [...LANGUAGE_NAMES, ...Object.values(FRAMEWORKS).flat(), ...SUPPORTING_NAMES]) {
  const key = normalizeToolName(name);
  if (byName.has(key)) throw new Error(`tool taxonomy: duplicate name ${name}`);
  byName.set(key, name);
}
for (const [kind, names] of Object.entries(FRAMEWORKS)) for (const name of names) frameworkClass.set(name, kind);
for (const [alias, canonical] of Object.entries(ALIASES)) {
  if (byName.has(alias) || !byName.has(normalizeToolName(canonical))) throw new Error(`tool taxonomy: invalid alias ${alias}`);
  byName.set(alias, canonical);
}
export function resolveToolName(name) { return byName.get(normalizeToolName(name)) ?? null; }
export function resolveLanguageName(name) {
  const canonical = resolveToolName(name);
  return languageSet.has(canonical) ? canonical : null;
}
export function frameworkClassFor(name) { return frameworkClass.get(name) ?? null; }
export function isSupportingName(name) { return supportingSet.has(resolveToolName(name)); }
export const TAXONOMY_INVENTORY = Object.freeze({
  languages: LANGUAGE_NAMES,
  frameworks: Object.freeze([...frameworkClass].map(([name, kind]) => Object.freeze({ name, kind }))),
  supporting: SUPPORTING_NAMES,
});
