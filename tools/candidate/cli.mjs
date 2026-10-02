#!/usr/bin/env node

/**
 * `--check` over one candidate layer, printing one JSON object.
 *
 * It exists beside `bootstrap --check` for two reasons. It takes an explicit `--root`, so a layer
 * that is not the one this checkout would use can be validated — the tracked example, above all.
 * And it needs no ledger and no output root, so it answers in a checkout where the operational
 * preflight could not even start.
 *
 * It is not part of the aggregate gate, for the same reason `bootstrap --check` is not: without
 * `--root` it resolves to the working checkout, and no stage of the gate may read operator state.
 *
 * It prints how many constraints it read and whether the layer's own `constraints.json` is there,
 * which is the one cheap way to tell an empty file from a misspelt file name: silence would look
 * the same either way. For the same reason it prints how many levers, projects, rules and letter
 * samples the documents hold. The count covers the constraints of the language packs and the
 * entries the profile derives for its private projects too.
 *
 * On a present layer it also runs the pins of every language pack (`pins.mjs`) and prints the
 * languages and how many pins held; a pin that does not hold is a refusal.
 *
 * It reads the letter-correction corpus in both of its homes: the layer's own
 * `research/letter-corrections/` — the private repository's copy after `records:import` — and,
 * without `--root` only, the run's `records/letter-corrections/` beside the process log. It
 * prints how many records each holds, `null` for a home with no corpus, and refuses on the first
 * broken record, naming the home and the file. With `--root` the run's corpus is reported as
 * `not_checked`: a root handed in says nothing about which run it belongs to, and a test that
 * checks the example must never read an operator's records.
 */

import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, realpathSync } from "node:fs";
import {
  LAYER_CORPUS_DIRECTORY,
  LetterCorrectionError,
  RECORDS_DIRECTORY,
  RUN_CORPUS_DIRECTORY,
  readCorpus,
} from "../letter-corrections/corpus.mjs";
import { CandidateError, candidateRootFor, inspectCandidateLayer } from "./load.mjs";
import { loadAllCandidateConstraints } from "./constraints.mjs";
import { runCandidatePins } from "./pins.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

class CandidateCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CandidateCliError";
    this.code = code;
  }
}

export function defaultCandidateRoot(environment = process.env) {
  return candidateRootFor(defaultWorkspaceRoot(environment));
}

function defaultWorkspaceRoot(environment) {
  return resolve(environment.JOB_PIPELINE_WORKSPACE_ROOT ?? repoRoot);
}

/** How many records the corpus in `directory` holds, or `null` when there is no corpus there. */
function countCorpus(home, directory, languages) {
  if (!existsSync(join(directory, RECORDS_DIRECTORY))) return null;
  try {
    return readCorpus(directory, { languages }).length;
  } catch (error) {
    if (error instanceof LetterCorrectionError) {
      throw new LetterCorrectionError(error.code, `${home} corpus: ${error.message}`);
    }
    throw error;
  }
}

export function parseArguments(argv, environment = process.env) {
  if (argv.length === 0 || argv[0] !== "--check") {
    throw new CandidateCliError("invalid_candidate_arguments", "use --check [--root <absolute path>]");
  }
  if (argv.length === 1) {
    return { root: defaultCandidateRoot(environment), runRoot: defaultWorkspaceRoot(environment) };
  }
  if (argv.length !== 3 || argv[1] !== "--root") {
    throw new CandidateCliError("invalid_candidate_arguments", "use --check [--root <absolute path>]");
  }
  if (!isAbsolute(argv[2]) || argv[2] !== resolve(argv[2])) {
    throw new CandidateCliError("invalid_candidate_arguments", "--root must be an absolute normalized path");
  }
  return { root: argv[2], runRoot: null };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { root, runRoot } = parseArguments(argv);
    const inspected = inspectCandidateLayer({ root });
    const constraints = loadAllCandidateConstraints({ root });
    const pins = inspected.status === "ready" ? runCandidatePins({ root }) : null;
    // An absent layer has no configured languages; the corpus then accepts the default one.
    const languages = inspected.languages ?? undefined;
    const letterCorrections = {
      layer: countCorpus("layer", join(root, LAYER_CORPUS_DIRECTORY), languages),
      run: runRoot === null
        ? "not_checked"
        : countCorpus("run", join(runRoot, RUN_CORPUS_DIRECTORY), languages),
    };
    process.stdout.write(`${JSON.stringify({
      config_path: inspected.configPath,
      constraints_count: constraints.count,
      constraints_status: constraints.status,
      documents: inspected.documents === null ? null : {
        letter_samples: inspected.documents.letterSamples,
        levers: inspected.documents.levers,
        projects: inspected.documents.projects,
        rules: inspected.documents.rules,
      },
      languages: inspected.languages,
      letter_corrections: letterCorrections,
      pins_run: pins === null ? null : pins.run,
      root: inspected.root,
      schema_version: inspected.schemaVersion,
      status: inspected.status,
    })}\n`);
  } catch (error) {
    const known = error instanceof CandidateCliError
      || error instanceof CandidateError
      || error instanceof LetterCorrectionError;
    process.stderr.write(`${JSON.stringify({
      error: {
        code: known ? error.code : "candidate_check_failed",
        message: known ? error.message : "candidate check failed unexpectedly",
      },
      status: "error",
    })}\n`);
    process.exitCode = 1;
  }
}

function isDirectInvocation() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  }
}

if (isDirectInvocation()) main();
