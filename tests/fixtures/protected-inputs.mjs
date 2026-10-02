/**
 * Where a test takes the tracked source of a protected input it copies into a disposable
 * workspace.
 *
 * A protected input under `candidate/` is a file of the candidate layer. The suite never reads the
 * layer of the checkout it runs in — a development tree has none, and a checkout that has one holds
 * a real person — so the source of such an input is the same file of the tracked example. The
 * workspace copy keeps the contract path, so the ledger records the path a real run records.
 */

import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  candidateConfigBasename,
  candidateDirectoryName,
  candidateExampleDirectoryName,
  candidateRootFor,
} from "../../tools/candidate/load.mjs";
import { candidateLanguagesDirectoryName } from "../../tools/candidate/languages.mjs";

export function protectedInputSource(repoRoot, contractPath) {
  const layerPrefix = `${candidateDirectoryName}/`;
  return contractPath.startsWith(layerPrefix)
    ? resolve(repoRoot, candidateExampleDirectoryName, contractPath.slice(layerPrefix.length))
    : resolve(repoRoot, contractPath);
}

/**
 * The example's config and language packs, placed in the workspace's candidate layer. Neither is
 * a protected input, so the copy loop over the protected inputs never brings them; a workspace
 * that publishes a cover letter needs both anyway, because the letter's limits are read from the
 * config and every language it names has to have its pack.
 */
export function seedCandidateConfig(repoRoot, workspaceRoot) {
  const root = candidateRootFor(workspaceRoot);
  mkdirSync(root, { recursive: true });
  copyFileSync(
    resolve(repoRoot, candidateExampleDirectoryName, candidateConfigBasename),
    resolve(root, candidateConfigBasename),
  );
  cpSync(
    resolve(repoRoot, candidateExampleDirectoryName, candidateLanguagesDirectoryName),
    resolve(root, candidateLanguagesDirectoryName),
    { recursive: true },
  );
}
