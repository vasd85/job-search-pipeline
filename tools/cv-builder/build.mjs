#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CandidateError,
  candidateConfigValue,
  candidateLanguageNames,
  candidateMarkets,
  candidateRootFor,
  loadCandidateConfig,
} from "../candidate/load.mjs";
import { readAndRunCvPreflight } from "./preflight.mjs";
import { inspectDocxBytes } from "./docx-inspector.mjs";
import {
  buildLibreOfficeInvocation,
  createRendererEnvironment,
  resolveLibreOfficeBackend,
} from "./libreoffice-backend.mjs";

const toolDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(toolDir, "../..");

/*
 * One orchestration boundary for targeted CV QA. Content gates run before document generation;
 * deterministic OOXML checks and visual rendering run afterwards. The application deliverable is
 * DOCX. PDF and PNG files are temporary QA views kept in qaDir, not application artifacts.
 */

function usage() {
  return "Usage: tools/cv-builder/build.sh <cv.json> [--brief <application-brief.json> | --general] [--revision] [--revision-waivers <waivers.json>] [--qa-dir <directory>] [--docx-renderer <render_docx.py> --python <python>] [--pipeline-staging-dir <directory> --workspace-root <directory>]";
}

export function parseArgs(argv) {
  const [cvPath, ...rest] = argv;
  if (!cvPath || cvPath.startsWith("--")) throw new Error(usage());
  const options = {
    cvPath: resolve(cvPath),
    briefPath: null,
    general: false,
    qaDir: null,
    docxRenderer: null,
    python: "python3",
    pipelineStagingDir: null,
    revision: false,
    revisionWaiversPath: null,
    workspaceRoot: repoRoot,
    workspaceRootProvided: false,
  };
  for (let index = 0; index < rest.length;) {
    const flag = rest[index];
    if (flag === "--general") {
      options.general = true;
      index += 1;
    } else if (flag === "--revision") {
      options.revision = true;
      index += 1;
    } else if ([
      "--brief",
      "--qa-dir",
      "--docx-renderer",
      "--python",
      "--pipeline-staging-dir",
      "--revision-waivers",
      "--workspace-root",
    ].includes(flag)) {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      if (flag === "--brief") options.briefPath = resolve(value);
      else if (flag === "--qa-dir") options.qaDir = resolve(value);
      else if (flag === "--docx-renderer") options.docxRenderer = resolve(value);
      else if (flag === "--pipeline-staging-dir") options.pipelineStagingDir = resolve(value);
      else if (flag === "--revision-waivers") options.revisionWaiversPath = resolve(value);
      else if (flag === "--workspace-root") {
        options.workspaceRoot = resolve(value);
        options.workspaceRootProvided = true;
      }
      else options.python = value.includes("/") ? resolve(value) : value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}\n${usage()}`);
    }
  }
  if (options.general && options.briefPath) throw new Error("Use either --brief or --general, not both");
  if (options.general && options.pipelineStagingDir) {
    throw new Error("--pipeline-staging-dir is only valid for a targeted CV");
  }
  if (options.workspaceRootProvided && !options.pipelineStagingDir) {
    throw new Error("--workspace-root is only valid with --pipeline-staging-dir");
  }
  if (options.pipelineStagingDir && !options.briefPath) {
    throw new Error("--pipeline-staging-dir requires an explicit --brief");
  }
  if (options.revision && options.general) {
    throw new Error("--revision is only valid for a targeted CV");
  }
  if (options.revisionWaiversPath && !options.revision) {
    throw new Error("--revision-waivers is only valid with --revision");
  }
  // A targeted run is the safe default: the sibling brief proves Step 3 completed and supplies the
  // decisions preflight must enforce. General CVs must opt out explicitly.
  if (!options.general && !options.briefPath) {
    options.briefPath = resolve(dirname(options.cvPath), "application-brief.json");
  }
  return options;
}

function terminateMatchingRenderer(pidFile, processMatchToken) {
  if (!pidFile || !processMatchToken || !existsSync(pidFile)) return false;
  try {
    const pidText = readFileSync(pidFile, "utf8").trim();
    if (!/^[1-9]\d*$/.test(pidText)) return false;
    const pid = Number(pidText);
    const processInfo = spawnSync("/bin/ps", ["-ww", "-p", pidText, "-o", "command="], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (processInfo.status !== 0 || !processInfo.stdout.includes(processMatchToken)) return false;
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env ?? process.env,
    cwd: options.cwd,
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeoutMs,
  });
  if (result.error) {
    const rendererSignalled = result.error.code === "ETIMEDOUT"
      && terminateMatchingRenderer(options.pidFile, options.processMatchToken);
    const suffix = result.error.code ? ` (${result.error.code})` : "";
    const cleanup = result.error.code === "ETIMEDOUT"
      ? rendererSignalled
        ? "; the matching isolated renderer was sent SIGTERM"
        : "; no matching renderer process was terminated"
      : "";
    const error = new Error(`${command} failed to execute${suffix}: ${result.error.message}${cleanup}`);
    error.code = result.error.code;
    error.exitCode = 1;
    throw error;
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const exitDescription = result.signal
      ? `signal ${result.signal}`
      : `exit code ${result.status}`;
    const error = new Error(`${command} failed with ${exitDescription}${detail ? `:\n${detail}` : ""}`);
    error.exitCode = result.status || 1;
    throw error;
  }
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function assertFile(path, label) {
  if (!existsSync(path) || statSync(path).size === 0) throw new Error(`${label} was not created: ${path}`);
}

function assertFreshGeneratedFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} was not created: ${path}`);
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size === 0) {
    throw new Error(`${label} must be a non-empty regular file: ${path}`);
  }
}

function assertDirectoryWithoutSymlink(path, label) {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
  if (!stats.isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
  return realpathSync(path);
}

function assertRegularFileWithoutSymlink(path, label) {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
  if (!stats.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
  if (stats.size === 0) throw new Error(`${label} must not be empty: ${path}`);
  return realpathSync(path);
}

function isStrictlyWithin(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent !== ""
    && pathFromParent !== ".."
    && !pathFromParent.startsWith(`..${sep}`)
    && !isAbsolute(pathFromParent);
}

function assertSafePipelineDocxName(fileName) {
  if (
    typeof fileName !== "string"
    || !fileName.endsWith(".docx")
    || fileName.startsWith(".")
    || basename(fileName) !== fileName
    || fileName.includes("/")
    || fileName.includes("\\")
  ) {
    throw new Error("pipeline cv.json fileName must be a non-hidden .docx basename");
  }
}

export function validatePipelineStaging(options, brief, cv) {
  if (!options.pipelineStagingDir) return null;

  const workspaceReal = assertDirectoryWithoutSymlink(options.workspaceRoot, "Pipeline workspace root");
  const outputRoot = join(options.workspaceRoot, "output");
  const outputRootReal = assertDirectoryWithoutSymlink(outputRoot, "Pipeline output root");
  if (!isStrictlyWithin(workspaceReal, outputRootReal)) {
    throw new Error("Pipeline output root escapes the pipeline workspace root");
  }

  const outputDir = resolve(options.workspaceRoot, brief.process.outputDir);
  if (dirname(outputDir) !== outputRoot) {
    throw new Error("application brief outputDir must be one direct child of the pipeline output root");
  }
  const outputReal = assertDirectoryWithoutSymlink(outputDir, "Reserved output directory");
  if (!isStrictlyWithin(outputRootReal, outputReal)) {
    throw new Error("application brief outputDir must resolve inside the pipeline output root");
  }

  const canonicalBriefPath = join(outputDir, "application-brief.json");
  if (options.briefPath !== canonicalBriefPath) {
    throw new Error(`pipeline build requires the canonical application brief: ${canonicalBriefPath}`);
  }
  assertRegularFileWithoutSymlink(canonicalBriefPath, "Canonical application-brief.json");

  const stagingParent = join(outputDir, ".pipeline-tmp");
  const stagingParentReal = assertDirectoryWithoutSymlink(stagingParent, "Pipeline staging parent");
  if (!isStrictlyWithin(outputReal, stagingParentReal)) {
    throw new Error("Pipeline staging parent escapes the reserved output directory");
  }

  const stagingDir = options.pipelineStagingDir;
  const publicationId = basename(stagingDir);
  if (
    dirname(stagingDir) !== stagingParent
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(publicationId)
  ) {
    throw new Error("Pipeline staging directory must be .pipeline-tmp/<publication-id>");
  }
  const stagingReal = assertDirectoryWithoutSymlink(stagingDir, "Pipeline staging directory");
  if (!isStrictlyWithin(stagingParentReal, stagingReal)) {
    throw new Error("Pipeline staging directory escapes .pipeline-tmp");
  }

  const expectedCvPath = join(stagingDir, "cv.json");
  if (options.cvPath !== expectedCvPath) {
    throw new Error(`pipeline build requires candidate cv.json at ${expectedCvPath}`);
  }
  assertRegularFileWithoutSymlink(expectedCvPath, "Pipeline candidate cv.json");

  const entries = readdirSync(stagingDir).sort();
  if (entries.length !== 1 || entries[0] !== "cv.json") {
    throw new Error("Pipeline staging directory must be fresh and contain only candidate cv.json");
  }

  assertSafePipelineDocxName(cv.fileName);
  const qaDir = join(stagingDir, "qa");
  if (options.qaDir && options.qaDir !== qaDir) {
    throw new Error(`pipeline QA directory must be ${qaDir}`);
  }

  return {
    stagingDir,
    docxPath: join(stagingDir, cv.fileName),
    qaDir,
  };
}

// OOXML inspection catches invariant layout regressions that screenshots cannot reliably diagnose,
// while later PNG review covers the visual properties that XML alone cannot prove. The contract
// itself lives in the shared inspector, so the lifecycle publisher enforces exactly what the
// builder enforces here.
function validateDocxStructure(docxPath, cv) {
  return inspectDocxBytes(readFileSync(docxPath), cv);
}

// Word pagination is evaluated through a rendered PDF because DOCX has no stable page-count model.
// An isolated LibreOffice profile prevents user settings or concurrent builds from changing results.
export function convertAndRender(docxPath, qaDir, { docxRenderer, python }) {
  mkdirSync(qaDir, { recursive: true });
  const pdfPath = join(qaDir, `${basename(docxPath, extname(docxPath))}.pdf`);
  const stalePageImage = readdirSync(qaDir).find((entry) => /^page-\d+\.png$/.test(entry));
  if (existsSync(pdfPath) || stalePageImage) {
    throw new Error(
      `cv_renderer_qa_output_not_fresh: use a fresh QA directory; existing rendered output was found under ${qaDir}`,
    );
  }
  const backend = resolveLibreOfficeBackend({ docxRenderer, python });
  if (backend.kind === "python-renderer") assertFile(backend.renderer, "DOCX renderer");

  // Each conversion gets a new profile. This prevents a headless renderer from attaching to an
  // already-running user LibreOffice process and also isolates concurrent pipeline builds.
  const profileDir = backend.kind === "python-renderer"
    ? null
    : mkdtempSync(join(qaDir, "libreoffice-profile-"));
  const invocation = buildLibreOfficeInvocation(backend, {
    docxPath,
    qaDir,
    profileDir,
  });
  const env = createRendererEnvironment(process.env);
  try {
    run(invocation.command, invocation.args, {
      env,
      timeoutMs: invocation.timeoutMs,
      pidFile: invocation.pidFile,
      processMatchToken: invocation.processMatchToken,
    });
  } catch (error) {
    if (backend.kind !== "macos-launchservices") throw error;
    const wrapped = new Error(
      "cv_renderer_requires_external_execution: macOS LaunchServices could not complete the isolated LibreOffice conversion from this execution context; allow /usr/bin/open or rerun the builder with approved external execution"
      + `\n${error.message}`,
    );
    wrapped.code = "cv_renderer_requires_external_execution";
    wrapped.exitCode = error.exitCode || 1;
    wrapped.cause = error;
    throw wrapped;
  }

  try {
    assertFreshGeneratedFile(pdfPath, "Rendered PDF");
  } catch (error) {
    if (backend.kind !== "macos-launchservices") throw error;
    const wrapped = new Error(
      "cv_renderer_launchservices_failed: the isolated LibreOffice instance exited without producing a valid PDF"
      + `; inspect ${invocation.stdoutLog} and ${invocation.stderrLog}`
      + `\n${error.message}`,
    );
    wrapped.code = "cv_renderer_launchservices_failed";
    wrapped.exitCode = 1;
    wrapped.cause = error;
    throw wrapped;
  }
  const pdfInfo = run("pdfinfo", [pdfPath]).stdout;
  const pages = Number(pdfInfo.match(/^Pages:\s+(\d+)$/m)?.[1] ?? 0);
  const pageSize = pdfInfo.match(/^Page size:\s+(.+)$/m)?.[1]?.trim() ?? "unknown";
  if (!pages) throw new Error("PDF QA failed: page count is missing");

  const imagePrefix = join(qaDir, "page");
  if (!backend.emitsPageImages) run("pdftoppm", ["-png", pdfPath, imagePrefix]);
  const pageImages = Array.from({ length: pages }, (_, index) => `${imagePrefix}-${index + 1}.png`);
  pageImages.forEach((path) => assertFreshGeneratedFile(path, "Rendered page image"));

  return {
    pdfPath,
    pages,
    pageSize,
    pageImages,
    backend: backend.label,
    profileDir,
  };
}

function readRevisionWaivers(waiversPath) {
  if (!waiversPath) return [];
  assertFile(waiversPath, "revision waivers");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(waiversPath, "utf8"));
  } catch {
    throw new Error("revision waivers file must contain valid JSON");
  }
  if (
    !Array.isArray(parsed)
    || parsed.some((record) =>
      record === null
      || typeof record !== "object"
      || record.subject === null
      || typeof record.subject !== "object")
  ) {
    throw new Error("revision waivers file must contain an array of waiver records with subjects");
  }
  return parsed;
}

/*
 * The page budget of a CV, from the candidate layer of the workspace the build serves. The CLI
 * resolves it once, before anything is rendered; `executeBuild` never reads the layer itself, so a
 * test hands it a budget and the suite never reaches the operator's real layer.
 */
export function pageBudgetFor(workspaceRoot) {
  try {
    const { config } = loadCandidateConfig({ root: candidateRootFor(workspaceRoot) });
    return candidateConfigValue(config, "cv.page_budget");
  } catch (error) {
    if (error instanceof CandidateError) {
      throw new Error(`candidate layer: ${error.code}: ${error.message}`);
    }
    throw error;
  }
}

/*
 * The language names a brief of this workspace may carry, resolved by the CLI the same way and for
 * the same reason as the page budget: `executeBuild` gets them as `languages` and never reads the
 * layer. Without them the brief is checked against the default language alone.
 */
export function languagesFor(workspaceRoot) {
  try {
    return candidateLanguageNames({ root: candidateRootFor(workspaceRoot) });
  } catch (error) {
    if (error instanceof CandidateError) {
      throw new Error(`candidate layer: ${error.code}: ${error.message}`);
    }
    throw error;
  }
}

/*
 * The two markets a brief of this workspace may name, resolved the same way as the languages above:
 * `executeBuild` gets them as `markets`. Without them the brief names no market it could pass with.
 */
export function marketsFor(workspaceRoot) {
  try {
    return candidateMarkets({ root: candidateRootFor(workspaceRoot) });
  } catch (error) {
    if (error instanceof CandidateError) {
      throw new Error(`candidate layer: ${error.code}: ${error.message}`);
    }
    throw error;
  }
}

export function executeBuild(options, dependencies = {}) {
  // Required, never defaulted: a budget this file chose would gate a CV the candidate never sized.
  if (!Number.isSafeInteger(options.pageBudget) || options.pageBudget < 1) {
    throw new Error("the build needs the page budget of the candidate config");
  }
  const runPreflight = dependencies.runPreflight ?? readAndRunCvPreflight;
  const renderCv = dependencies.renderCv ?? ((cvPath) => {
    const renderResult = run(process.execPath, [resolve(toolDir, "render.js"), cvPath]);
    return resolve(renderResult.stdout.split(/\r?\n/).at(-1));
  });
  const inspectDocx = dependencies.inspectDocx ?? validateDocxStructure;
  const renderQa = dependencies.renderQa ?? convertAndRender;

  assertFile(options.cvPath, "cv.json");
  const cv = JSON.parse(readFileSync(options.cvPath, "utf8"));
  if (typeof cv.fileName !== "string" || !cv.fileName.endsWith(".docx")) {
    throw new Error("cv.json fileName must end with .docx");
  }

  // Fail targeted builds before authoring artifacts when the persisted Step 3 contract is absent or
  // contradicted. A general CV has no per-role brief, so it deliberately skips only this gate.
  // In revision mode the same brief-coupled checks classify instead of aborting: the DOCX is
  // rendered despite conflicting findings so the user can choose waiver-vs-reopen afterwards
  // (ADR 0015 docs/adr/0015-lightweight-post-review-revision.md#3-conflicts-and-waivers); the intrinsic page-budget and structural gates below stay hard.
  let preflight = { conflicts: [], notices: [], warnings: [] };
  if (!options.general) {
    assertFile(options.briefPath, "application-brief.json");
    const waivers = readRevisionWaivers(options.revisionWaiversPath);
    preflight = runPreflight(
      options.cvPath,
      options.briefPath,
      options.revision
        ? { languages: options.languages, markets: options.markets, waivers }
        : { languages: options.languages, markets: options.markets },
    );
    if (!options.revision && preflight.errors.length) {
      throw new Error(`CV content preflight failed:\n- ${preflight.errors.join("\n- ")}`);
    }
    if (!options.pipelineStagingDir) {
      const cvRelative = relative(repoRoot, options.cvPath);
      const cvIsInRepo = cvRelative && !cvRelative.startsWith(`..${sep}`) && cvRelative !== "..";
      if (cvIsInRepo) {
        const expectedDir = resolve(repoRoot, preflight.brief.process.outputDir);
        if (dirname(options.cvPath) !== expectedDir) {
          throw new Error(`application brief outputDir mismatch: expected cv.json under ${expectedDir}`);
        }
      }
    }
  }

  const pipelineStaging = options.general
    ? null
    : validatePipelineStaging(options, preflight.brief, cv);
  const docxPath = renderCv(options.cvPath);
  if (pipelineStaging && docxPath !== pipelineStaging.docxPath) {
    throw new Error(`pipeline renderer returned an unexpected DOCX path: ${docxPath}`);
  }
  assertFile(docxPath, "DOCX");
  const structuralChecks = inspectDocx(docxPath, cv);

  const qaDir = pipelineStaging?.qaDir
    ?? options.qaDir
    ?? mkdtempSync(join(tmpdir(), "cv-builder-qa-"));
  const rendered = renderQa(docxPath, qaDir, options);

  // Return every QA location so the calling skill can inspect all pages in one operation. The PDF
  // remains in qaDir: it exists to establish pagination and feed PNG review, not to be submitted.
  const summary = {
    status: rendered.pages <= options.pageBudget ? "valid" : "too-long",
    mode: options.general ? "general" : pipelineStaging ? "pipeline-staged" : "targeted",
    cvJson: options.cvPath,
    applicationBrief: options.general ? null : options.briefPath,
    docx: docxPath,
    qaPdf: rendered.pdfPath,
    pages: rendered.pages,
    pageSize: rendered.pageSize,
    pageImages: rendered.pageImages,
    qaDir,
    renderBackend: rendered.backend
      ?? (options.docxRenderer ? `Python DOCX renderer: ${options.docxRenderer}` : "injected QA renderer"),
    rendererProfile: rendered.profileDir ?? null,
    structuralChecks,
    warnings: preflight.warnings,
    ...(options.revision
      ? {
          revision: true,
          conflicts: preflight.conflicts ?? [],
          notices: preflight.notices ?? [],
        }
      : {}),
  };

  if (rendered.pages > options.pageBudget) {
    const error = new Error(`CV is ${rendered.pages} pages (>${options.pageBudget}). Review ${qaDir}, trim content, and rerun the same build command.`);
    error.exitCode = 3;
    error.summary = summary;
    throw error;
  }
  return summary;
}

// `dependencies` reaches `executeBuild` untouched: the shell entry never passes it, and a test hands
// in a renderer so that what this function resolves from the layer is checked through it.
export function main(argv = process.argv.slice(2), dependencies = {}) {
  try {
    const options = parseArgs(argv);
    const summary = executeBuild({
      ...options,
      languages: languagesFor(options.workspaceRoot),
      markets: marketsFor(options.workspaceRoot),
      pageBudget: pageBudgetFor(options.workspaceRoot),
    }, dependencies);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    if (error.summary) console.log(JSON.stringify(error.summary, null, 2));
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(`[cv-builder] ${error.message}`);
    process.exitCode = error.exitCode || 1;
  }
}
