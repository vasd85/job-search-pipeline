#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { candidateLanguageNames, candidateMarkets, candidateRootForCommand } from "../candidate/load.mjs";
import { DEFAULT_LANGUAGE } from "../candidate/default-language.mjs";
import { marketNames, marketSide } from "../candidate/markets.mjs";
import {
  validateArray,
  validateBoolean,
  validateEnum,
  validateFileReference,
  validateHttpUrl,
  validateInteger,
  validateIsoTimestamp,
  validateNullableString,
  validateOutputDir,
  validateStrictObject,
  validateString,
  validateStringArray,
  validateUtf8TextBytes,
} from "./validation.mjs";

// The legal language set is not written down here: it is the default language plus the languages
// the candidate layer configures, and every caller passes it as `languages`. A caller that passes
// none gets the default language alone — what a checkout without a layer supports — so a forgotten
// option refuses more, never less.
export function vacancyLanguagesOption(languages) {
  return languages === undefined ? Object.freeze([DEFAULT_LANGUAGE.name]) : languages;
}

/**
 * The version a Step 1 publication writes, and every version a recorded vacancy may carry. In
 * version 2 `role.market.value` is the name of one of the two markets the candidate layer
 * configures.
 */
export const VACANCY_SCHEMA_VERSION = 2;
export const VACANCY_SCHEMA_VERSIONS = Object.freeze([2]);

/**
 * The side of the market a vacancy names — `home`, `outside_home`, or `null` for no market or one
 * the reader cannot place — by the configured names in `markets`.
 */
export function vacancyMarketSide(vacancy, markets) {
  if (!VACANCY_SCHEMA_VERSIONS.includes(vacancy?.schemaVersion)) return null;
  return marketSide(markets, vacancy.role?.market?.value);
}
const WORK_MODEL_VALUES = ["remote", "hybrid", "onsite", "unspecified"];
const SECTION_KEYS = ["responsibilities", "requirements", "niceToHaves"];
const SECTION_PRESENCE_VALUES = ["separated", "embedded", "absent"];
const OUTCOME_VALUES = ["completed", "blocked"];

function validateExpectedProcess(process, expectedProcess, errors) {
  if (expectedProcess === undefined) return;
  for (const key of ["id", "sourceRef", "outputDir"]) {
    if (expectedProcess[key] !== undefined && process[key] !== expectedProcess[key]) {
      errors.push(`process.${key} does not match the selected ledger process`);
    }
  }
}

function validateExpectedRole(role, expectedProcess, errors) {
  if (expectedProcess === undefined) return;
  const fields = [
    ["companyObserved", "company"],
    ["role", "title"],
  ];
  for (const [expectedKey, roleKey] of fields) {
    if (
      expectedProcess[expectedKey] !== undefined
      && role[roleKey] !== expectedProcess[expectedKey]
    ) {
      errors.push(`role.${roleKey} does not match the selected ledger process`);
    }
  }
}

function validateSectionIndex(value, errors) {
  const sectionIndex = validateStrictObject(value, "sectionIndex", errors, SECTION_KEYS);
  const sections = new Map();

  for (const sectionKey of SECTION_KEYS) {
    const path = `sectionIndex.${sectionKey}`;
    const section = validateStrictObject(
      sectionIndex[sectionKey],
      path,
      errors,
      ["presence", "sourceHeadings", "embeddedIn"],
    );
    sections.set(sectionKey, section);
    validateEnum(section.presence, `${path}.presence`, errors, SECTION_PRESENCE_VALUES);
    const headings = validateStringArray(section.sourceHeadings, `${path}.sourceHeadings`, errors);

    if (section.presence === "separated") {
      if (headings.length === 0) errors.push(`${path}.sourceHeadings must name at least one source heading when separated`);
      if (section.embeddedIn !== null) errors.push(`${path}.embeddedIn must be null when separated`);
    } else if (section.presence === "embedded") {
      if (headings.length !== 0) errors.push(`${path}.sourceHeadings must be empty when embedded`);
      if (!SECTION_KEYS.includes(section.embeddedIn) || section.embeddedIn === sectionKey) {
        errors.push(`${path}.embeddedIn must name a different canonical section when embedded`);
      }
    } else if (section.presence === "absent") {
      if (headings.length !== 0) errors.push(`${path}.sourceHeadings must be empty when absent`);
      if (section.embeddedIn !== null) errors.push(`${path}.embeddedIn must be null when absent`);
    }
  }

  for (const [sectionKey, section] of sections) {
    if (section.presence !== "embedded" || !SECTION_KEYS.includes(section.embeddedIn)) continue;
    if (sections.get(section.embeddedIn)?.presence !== "separated") {
      errors.push(`sectionIndex.${sectionKey}.embeddedIn must point to a separated canonical section`);
    }
  }
}

function validateAmbiguities(value, errors) {
  const ambiguities = validateArray(value, "ambiguities", errors);
  const codes = new Set();
  ambiguities.forEach((entry, index) => {
    const path = `ambiguities[${index}]`;
    const ambiguity = validateStrictObject(entry, path, errors, ["code", "question", "blocking"]);
    const code = validateString(ambiguity.code, `${path}.code`, errors);
    if (code && !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(code)) {
      errors.push(`${path}.code must be a stable snake_case code`);
    }
    if (code && codes.has(code)) errors.push(`duplicate ambiguity code: ${code}`);
    if (code) codes.add(code);
    validateString(ambiguity.question, `${path}.question`, errors);
    validateBoolean(ambiguity.blocking, `${path}.blocking`, errors);
  });
  return ambiguities;
}

export function validateVacancy(
  vacancy,
  {
    jobDescriptionBytes,
    expectedProcess,
    languages,
    markets,
    expectedSchemaVersion,
    outcome,
  } = {},
) {
  const errors = [];
  const root = validateStrictObject(
    vacancy,
    "vacancy",
    errors,
    ["schemaVersion", "createdAt", "process", "role", "jobDescription", "sectionIndex", "ambiguities"],
  );
  // A publication names the version it writes; a recorded vacancy is read under the version its
  // ledger entry records. Without either, the file is read under the version it declares.
  if (expectedSchemaVersion !== undefined) {
    if (root.schemaVersion !== expectedSchemaVersion) {
      errors.push(`schemaVersion must equal ${expectedSchemaVersion}`);
    }
  } else if (!VACANCY_SCHEMA_VERSIONS.includes(root.schemaVersion)) {
    errors.push(`schemaVersion must be one of: ${VACANCY_SCHEMA_VERSIONS.join(", ")}`);
  }
  validateIsoTimestamp(root.createdAt, "createdAt", errors);

  const process = validateStrictObject(
    root.process,
    "process",
    errors,
    ["id", "sourceRef", "finalUrl", "outputDir"],
  );
  validateString(process.id, "process.id", errors);
  validateString(process.sourceRef, "process.sourceRef", errors);
  validateHttpUrl(process.finalUrl, "process.finalUrl", errors, { nullable: true });
  validateOutputDir(process.outputDir, "process.outputDir", errors);
  validateExpectedProcess(process, expectedProcess, errors);

  const role = validateStrictObject(
    root.role,
    "role",
    errors,
    ["company", "title", "ats", "vacancyLanguage", "market", "feasibility"],
  );
  validateString(role.company, "role.company", errors);
  validateString(role.title, "role.title", errors);
  validateString(role.ats, "role.ats", errors);
  validateEnum(role.vacancyLanguage, "role.vacancyLanguage", errors, vacancyLanguagesOption(languages));
  validateExpectedRole(role, expectedProcess, errors);

  const market = validateStrictObject(role.market, "role.market", errors, ["value", "evidence"]);
  const names = marketNames(markets);
  if (names.length === 0 && market.value !== null) {
    errors.push("role.market.value must be null: the candidate layer configures no market");
  } else {
    validateEnum(market.value, "role.market.value", errors, names, { nullable: true });
  }
  validateNullableString(market.evidence, "role.market.evidence", errors);

  const feasibility = validateStrictObject(
    role.feasibility,
    "role.feasibility",
    errors,
    [
      "workModel",
      "locations",
      "employmentType",
      "timezoneOverlap",
      "workAuthorizationResidency",
      "relocationVisaSupport",
      "salary",
    ],
  );
  const workModel = validateStrictObject(
    feasibility.workModel,
    "role.feasibility.workModel",
    errors,
    ["normalized", "sourceText"],
  );
  validateEnum(workModel.normalized, "role.feasibility.workModel.normalized", errors, WORK_MODEL_VALUES);
  validateNullableString(workModel.sourceText, "role.feasibility.workModel.sourceText", errors);
  validateStringArray(feasibility.locations, "role.feasibility.locations", errors);
  for (const field of [
    "employmentType",
    "timezoneOverlap",
    "workAuthorizationResidency",
    "relocationVisaSupport",
    "salary",
  ]) {
    validateNullableString(feasibility[field], `role.feasibility.${field}`, errors);
  }

  if (jobDescriptionBytes === undefined) {
    errors.push("job-description.txt bytes are required for bundle validation");
  } else {
    validateUtf8TextBytes(jobDescriptionBytes, "job-description.txt", errors);
  }
  validateFileReference(
    root.jobDescription,
    "jobDescription",
    errors,
    {
      expectedPath: "job-description.txt",
      schemaVersion: "omit",
      contentBytes: jobDescriptionBytes,
    },
  );

  validateSectionIndex(root.sectionIndex, errors);
  const ambiguities = validateAmbiguities(root.ambiguities, errors);
  const blockingAmbiguities = ambiguities.filter((ambiguity) => ambiguity?.blocking === true);
  const hasBlockingMarketAmbiguity = blockingAmbiguities.some(
    (ambiguity) => ambiguity?.code === "market_ambiguous",
  );
  if (market.value === null && !hasBlockingMarketAmbiguity) {
    errors.push("role.market.value null requires a blocking market_ambiguous ambiguity");
  }

  if (outcome !== undefined && !OUTCOME_VALUES.includes(outcome)) {
    errors.push(`outcome must be one of: ${OUTCOME_VALUES.join(", ")}`);
  } else if (outcome === "completed" && blockingAmbiguities.length > 0) {
    errors.push("completed vacancy artifacts must not contain a blocking ambiguity");
  } else if (outcome === "blocked" && blockingAmbiguities.length === 0) {
    errors.push("blocked vacancy artifacts must contain a blocking ambiguity");
  }

  return errors;
}

export function readAndValidateVacancyBundle(
  vacancyPath,
  jobDescriptionPath,
  options = {},
) {
  const vacancy = JSON.parse(readFileSync(vacancyPath, "utf8"));
  const jobDescriptionBytes = readFileSync(jobDescriptionPath);
  const errors = validateVacancy(vacancy, { ...options, jobDescriptionBytes });
  if (errors.length) {
    throw new Error(`vacancy artifact validation failed:\n- ${errors.join("\n- ")}`);
  }
  return { vacancy, jobDescriptionBytes };
}

function main() {
  const args = process.argv.slice(2);
  const outcomeIndex = args.indexOf("--outcome");
  let outcome;
  if (outcomeIndex !== -1) {
    outcome = args[outcomeIndex + 1];
    args.splice(outcomeIndex, 2);
  }
  if (args.length !== 2 || (outcomeIndex !== -1 && outcome === undefined)) {
    throw new Error(
      "Usage: node tools/pipeline-artifacts/validate-vacancy.mjs "
      + "<vacancy.json> <job-description.txt> [--outcome completed|blocked]",
    );
  }

  const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const candidateRoot = candidateRootForCommand(checkoutRoot);
  const languages = candidateLanguageNames({ root: candidateRoot });
  const markets = candidateMarkets({ root: candidateRoot });
  const { vacancy, jobDescriptionBytes } = readAndValidateVacancyBundle(
    args[0],
    args[1],
    { languages, markets, outcome },
  );
  console.log(JSON.stringify({
    status: "valid",
    schemaVersion: vacancy.schemaVersion,
    processId: vacancy.process.id,
    outputDir: vacancy.process.outputDir,
    outcome: outcome ?? "capture",
    jobDescriptionBytes: jobDescriptionBytes.byteLength,
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
