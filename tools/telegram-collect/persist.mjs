// One sweep, end to end, with its files - in one step or in two.
//
// Write order of a finished sweep: captures as they are fetched, then cards, collection, report,
// manifest with `completed: true`, and the sweep state LAST. A crash before the state leaves a
// sweep that the next run repeats; `/collect-telegram` hands only a `completed` sweep's collection
// to scoring, and a repeated sweep's addresses are ones the triage ledger already knows.
//
// A sweep with candidates of a general source stops after the walk: it writes the reader's batches
// (`reader-in/`) and a stage file that carries the walk, the digests of the config and state files
// it ran with, and the batch descriptors - and touches no state. `finalize` reads the answers
// (`reader-out/`), refuses when the config or the state changed in between (the value a sweep runs
// with is the one the working file shows), refuses answers the schema rejects unless told to accept
// them, and finishes the sweep in the same write order. An abandoned two-step sweep moved nothing.
//
// The output directory is append-only, as in `tools/vacancy-fetch/`: a directory that already holds
// anything is refused before the first request. Inside the repository it may stand only under
// `telegram-sweeps/` or `.rehearsal/` - a closed list of two ignored prefixes, checked on the path
// alone and without asking git: the cards carry people's contacts, and a sweep written anywhere
// else in the checkout is one `git add` away from a commit.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Bytes, sha256Utf8 } from "../vacancy-fetch/digest.mjs";
import { checkAnswer, parseAnswerText } from "./answers.mjs";
import { answerDirBasename, batchDirBasename, labelDirBasename, planBatches } from "./batches.mjs";
import { cardRecord, cardsBasename } from "./cards.mjs";
import { collectionBasename, renderCollection } from "./collection.mjs";
import { readConfig } from "./config.mjs";
import { fail } from "./errors.mjs";
import { renderReport, reportBasename } from "./report.mjs";
import { assertSourceKinds, readState, writeFileAtomic, writeState } from "./state.mjs";
import { resolveSweep, sweepTotals, walkSources } from "./sweep.mjs";
import {
  buildSourceSet,
  serializeSourceSet,
  SourceSetError,
  sourceSetBasename,
  sourceSetDigest,
} from "../triage-sources/source-set.mjs";

export const manifestBasename = "sweep-manifest.json";
export const manifestSchemaVersion = 1;
export const stageBasename = "sweep-stage.json";
export const stageSchemaVersion = 2;
export const sweepDirPrefixes = Object.freeze(["telegram-sweeps", ".rehearsal"]);
export const rejectedAnswerSuffix = ".rejected.json";

const ownRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A path with the symlinks and the letter case of its existing part resolved: the directory of a
 * sweep does not exist yet, so the deepest existing ancestor is resolved and the rest appended.
 */
function canonical(path) {
  let existing = resolve(path);
  const rest = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync.native(existing), ...rest);
}

function checkOutDirPath(outDir, repoRoot) {
  if (typeof outDir !== "string" || !isAbsolute(outDir)) {
    fail("out_dir_invalid", "--out-dir must be an absolute path.");
  }
  const inside = relative(canonical(repoRoot), canonical(outDir));
  const outside = inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
  if (!outside) {
    const [prefix, ...rest] = inside.split(sep);
    if (!sweepDirPrefixes.includes(prefix) || rest.length === 0) {
      fail(
        "out_dir_invalid",
        "Inside the repository --out-dir must stand under telegram-sweeps/ or .rehearsal/.",
      );
    }
  }
}

export function prepareOutDir(outDir, { repoRoot = ownRepoRoot } = {}) {
  checkOutDirPath(outDir, repoRoot);
  try {
    mkdirSync(outDir, { recursive: true });
    const stats = lstatSync(outDir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("not a directory");
  } catch {
    fail("out_dir_invalid", "--out-dir must be a real directory.");
  }
  if (readdirSync(outDir).length > 0) {
    fail("out_dir_not_empty", "--out-dir already holds files; a sweep directory is append-only.");
  }
  return outDir;
}

/**
 * The directory of a two-step sweep: it exists and holds a stage file. `finalize` also needs it
 * not to hold a manifest yet; `render-batches` works before and after `finalize` alike.
 */
function stagedOutDir(outDir, { repoRoot, mustBeAwaiting }) {
  checkOutDirPath(outDir, repoRoot);
  let stats;
  try {
    stats = lstatSync(outDir);
  } catch {
    fail("stage_missing", "--out-dir does not exist or holds no two-step sweep.");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory())
    fail("out_dir_invalid", "--out-dir must be a real directory.");
  if (mustBeAwaiting && existsSync(join(outDir, manifestBasename))) {
    fail("already_completed", "This sweep directory already holds a completed manifest.");
  }
  if (!existsSync(join(outDir, stageBasename)))
    fail("stage_missing", "--out-dir holds no two-step sweep.");
  return outDir;
}

function captureName(index) {
  return `${String(index).padStart(3, "0")}.page.html`;
}

function fileDigest(path) {
  return sha256Utf8(readFileSync(path, "utf8"));
}

function readStage(outDir) {
  let stage;
  try {
    stage = JSON.parse(readFileSync(join(outDir, stageBasename), "utf8"));
  } catch {
    fail("stage_invalid", "The stage file of this sweep could not be read.");
  }
  if (
    typeof stage !== "object" ||
    stage === null ||
    ![1, 2].includes(stage.schema_version) ||
    typeof stage.config?.path !== "string" ||
    !isAbsolute(stage.config.path) ||
    typeof stage.config?.sha256 !== "string" ||
    typeof stage.state_sha256 !== "string" ||
    typeof stage.walk !== "object" ||
    stage.walk === null ||
    !Array.isArray(stage.batches) ||
    !Array.isArray(stage.captures)
  ) {
    fail("stage_invalid", "The stage file of this sweep does not match its schema.");
  }
  return stage;
}

/** Write the finished half: cards, collection, report, manifest, the state last. */
function finishSweep({
  outDir,
  statePath,
  result,
  captures,
  stage,
  batches,
  answersInfo,
  readerVersion = 2,
}) {
  const cardsText = result.cards
    .map((card) => `${JSON.stringify(cardRecord(card, { held: card.held }))}\n`)
    .join("");
  const cardsPath = result.cards.length === 0 ? null : join(outDir, cardsBasename);
  if (cardsPath !== null) writeFileAtomic(cardsPath, cardsText);
  const collectionText = renderCollection({
    collectedAt: result.started_at,
    addresses: result.collection,
  });
  const collectionPath = collectionText === null ? null : join(outDir, collectionBasename);
  if (collectionText !== null) writeFileAtomic(collectionPath, collectionText);
  let sourceSet = null;
  if (readerVersion === 2 && result.cards.length > 0) {
    try {
      sourceSet = buildSourceSet({
        cards: result.cards,
        collectionText,
        captures,
        captureRoot: outDir,
      });
    } catch (error) {
      if (error instanceof SourceSetError) fail("source_set_invalid", error.message);
      throw error;
    }
  }
  const sourceSetPath = sourceSet === null ? null : join(outDir, sourceSetBasename);
  if (sourceSet !== null) writeFileAtomic(sourceSetPath, serializeSourceSet(sourceSet));
  const reportText = renderReport(result, { collectionPath, cardsPath });
  writeFileAtomic(join(outDir, reportBasename), reportText);

  const manifest = {
    schema_version: manifestSchemaVersion,
    started_at: result.started_at,
    window_edge: result.window_edge,
    rate_limited: result.rate_limited,
    channels: result.channels,
    totals: sweepTotals(result),
    captures,
    cards:
      cardsPath === null
        ? null
        : { file: cardsBasename, cards: result.cards.length, sha256: sha256Utf8(cardsText) },
    collection:
      collectionText === null
        ? null
        : {
            file: collectionBasename,
            links: result.collection.length,
            sha256: sha256Utf8(collectionText),
          },
    report: { file: reportBasename, sha256: sha256Utf8(reportText) },
    ...(readerVersion === 2
      ? {
          source_set:
            sourceSet === null
              ? null
              : {
                  file: sourceSetBasename,
                  sha256: sourceSetDigest(sourceSet),
                  snapshots: sourceSet.snapshots.length,
                  cards: sourceSet.cards.length,
                },
        }
      : {}),
    stage,
    batches,
    answers: answersInfo.answers,
    rejected_answers: answersInfo.rejected,
    accepted_invalid: result.answer_invalid.length,
    title_line_repaired: result.title_line_repaired.length,
    stray_answers: answersInfo.stray,
    completed: true,
  };
  writeFileAtomic(join(outDir, manifestBasename), `${JSON.stringify(manifest, null, 2)}\n`);
  writeState(statePath, result.nextState);

  return {
    awaiting: false,
    result,
    manifest,
    collectionPath,
    cardsPath,
    sourceSetPath,
    reportPath: join(outDir, reportBasename),
  };
}

export async function executeSweep({
  configPath,
  statePath,
  outDir,
  repoRoot,
  now,
  sleep,
  fetchImpl,
  readerVersion = 2,
}) {
  // Config and state are read before the directory is touched and before any request: a caller
  // error must cost neither a request nor a half-made sweep directory.
  const config = readConfig(configPath);
  const state = readState(statePath);
  assertSourceKinds(state, config);
  prepareOutDir(outDir, { repoRoot });

  const captures = [];
  const capture = async ({ handle, page, before, messageId = null, record }) => {
    const entry = {
      index: captures.length + 1,
      handle,
      page,
      before,
      message_id: messageId,
      http_status: record.status,
      transport_failure: record.transportFailure,
      final_url: record.finalUrl,
      file: null,
      byte_length: record.byteLength,
      sha256: null,
      ...(readerVersion === 2 ? { captured_at: new Date(now()).toISOString() } : {}),
    };
    if (record.bytes !== null && record.bytes !== undefined) {
      entry.file = captureName(entry.index);
      entry.sha256 = sha256Bytes(record.bytes);
      writeFileAtomic(join(outDir, entry.file), record.bytes);
    }
    captures.push(entry);
  };

  const walk = await walkSources({ config, state, now, sleep, fetchImpl, capture });
  const result = resolveSweep({ config, state, walk, answers: null, readerVersion });
  if (!result.awaiting) {
    return finishSweep({
      outDir,
      statePath,
      result,
      captures,
      stage: null,
      batches: [],
      answersInfo: { answers: [], rejected: [], stray: 0 },
      readerVersion,
    });
  }

  // The reader's half: batches and the stage, no state.
  const batchDir = join(outDir, batchDirBasename);
  mkdirSync(batchDir);
  const sourceOrder = config.channels.map((source) => source.handle);
  const batches = planBatches(result.pending, config.roleWords, {
    sourceOrder,
    sourceMapping: readerVersion === 2,
  }).map((batch) => {
    writeFileAtomic(join(batchDir, batch.file), batch.text);
    return {
      file: batch.file,
      handle: batch.handle,
      sha256: sha256Utf8(batch.text),
      posts: batch.posts,
      ...(readerVersion === 2 ? { schema_version: 2 } : {}),
    };
  });
  const stage = {
    schema_version: readerVersion === 2 ? 2 : 1,
    started_at: walk.started_at,
    config: { path: configPath, sha256: fileDigest(configPath) },
    state_sha256: fileDigest(statePath),
    walk,
    batches,
    captures,
  };
  const stageText = `${JSON.stringify(stage, null, 2)}\n`;
  writeFileAtomic(join(outDir, stageBasename), stageText);
  return {
    awaiting: true,
    result,
    stage,
    stageDigest: sha256Utf8(stageText),
    batchDir,
    batches,
    posts_to_read: result.pending.length,
  };
}

function answerFileOf(batchFile) {
  return batchFile.replace(/\.txt$/u, ".json");
}

/** Read the reader's answers of every batch; a missing file is a refusal that names the batches. */
function readAnswers(outDir, batches) {
  const answerDir = join(outDir, answerDirBasename);
  const missing = [];
  const answers = new Map();
  const files = [];
  let stray = 0;
  for (const batch of batches) {
    if (batch.schema_version === 2) {
      if (
        typeof batch.file !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_]{3,31}-[0-9]{3,}\.txt$/u.test(batch.file) ||
        !/^[a-f0-9]{64}$/u.test(batch.sha256 ?? "")
      )
        fail("stage_invalid", "Reader batch metadata is invalid.");
      let digest;
      try {
        digest = fileDigest(join(outDir, batchDirBasename, batch.file));
      } catch {
        fail("stage_invalid", "The complete reader batch cannot be read.");
      }
      if (digest !== batch.sha256)
        fail("stage_invalid", "The complete reader input changed after the sweep was staged.");
    }
    const complete = batch.posts.filter((post) => post.complete !== false);
    for (const post of batch.posts.filter((post) => post.complete === false))
      answers.set(`${post.handle}/${post.postId}`, {
        kind: "unresolved_oversize",
        descriptor: post,
      });
    if (complete.length === 0) continue;
    const file = answerFileOf(batch.file);
    const path = join(answerDir, file);
    if (!existsSync(path)) {
      missing.push(file);
      continue;
    }
    const text = readFileSync(path, "utf8");
    files.push({ file, sha256: sha256Utf8(text) });
    const checked = checkAnswer(parseAnswerText(text), {
      name: batch.file.replace(/\.txt$/u, ""),
      posts: batch.posts,
      ...(batch.schema_version === 2 ? { schema_version: 2 } : {}),
    });
    stray += checked.stray;
    for (const post of batch.posts) {
      answers.set(`${post.handle}/${post.postId}`, {
        ...checked.results.get(post.post),
        descriptor: post,
        file,
      });
    }
  }
  if (missing.length > 0) {
    fail("answers_missing", `No answer file for: ${missing.join(", ")}.`);
  }
  const rejected = existsSync(answerDir)
    ? readdirSync(answerDir)
        .filter((name) => name.endsWith(rejectedAnswerSuffix))
        .sort()
        .map((name) => ({ file: name, sha256: fileDigest(join(answerDir, name)) }))
    : [];
  return { answers, files, rejected, stray };
}

/** The second step: answers in, the finished sweep out, the state last. */
export function executeFinalize({ outDir, statePath, repoRoot, acceptInvalid = false }) {
  stagedOutDir(outDir, { repoRoot, mustBeAwaiting: true });
  const stage = readStage(outDir);
  const config = readConfig(stage.config.path);
  if (fileDigest(stage.config.path) !== stage.config.sha256) {
    fail(
      "config_changed",
      "The sources config changed since the sweep started; start a new sweep.",
    );
  }
  const state = readState(statePath);
  if (fileDigest(statePath) !== stage.state_sha256) {
    fail("state_changed", "The sweep state changed since the sweep started; start a new sweep.");
  }
  assertSourceKinds(state, config);
  const { answers, files, rejected, stray } = readAnswers(outDir, stage.batches);
  const readerVersion = stage.schema_version === 1 ? 1 : 2;
  const result = resolveSweep({ config, state, walk: stage.walk, answers, readerVersion });
  if (result.answer_invalid.length > 0 && !acceptInvalid) {
    // The batch's answer file is named first: it is what the skill renames and re-reads.
    const named = result.answer_invalid.map(
      (post) =>
        `${answers.get(`${post.handle}/${post.postId}`)?.file ?? "?"}: ${post.handle}/${post.postId} ${post.code}`,
    );
    fail("answers_invalid", `The reader's answer was rejected for: ${named.join(", ")}.`);
  }
  const stageText = readFileSync(join(outDir, stageBasename), "utf8");
  return finishSweep({
    outDir,
    statePath,
    result,
    captures: stage.captures,
    stage: { file: stageBasename, sha256: sha256Utf8(stageText) },
    batches: stage.batches.map(({ file, handle, sha256, posts }) => ({
      file,
      handle,
      sha256,
      posts: posts.length,
    })),
    answersInfo: { answers: files, rejected, stray },
    readerVersion,
  });
}

/**
 * The labelling input of the measurement: the same batches with no hidden middle, in `label-in/`,
 * with their descriptors beside them (`label-in/descriptors.json`) so a label can be checked by
 * `answers.mjs` like an answer. Works before and after `finalize`.
 */
export function renderLabelBatches({ outDir, repoRoot }) {
  stagedOutDir(outDir, { repoRoot, mustBeAwaiting: false });
  const stage = readStage(outDir);
  const config = readConfig(stage.config.path);
  if (fileDigest(stage.config.path) !== stage.config.sha256) {
    fail(
      "config_changed",
      "The sources config changed since the sweep started; the labels would not match the reader's batches.",
    );
  }
  const labelDir = join(outDir, labelDirBasename);
  if (existsSync(labelDir) && readdirSync(labelDir).length > 0) {
    fail("out_dir_not_empty", "label-in/ already holds files; a sweep directory is append-only.");
  }
  mkdirSync(labelDir, { recursive: true });
  const state = { schema_version: 2, channels: {}, fingerprints: [], emitted_urls: {} };
  const pending =
    resolveSweep({
      config,
      state,
      walk: stage.walk,
      answers: null,
      readerVersion: stage.schema_version === 1 ? 1 : 2,
    }).pending ?? [];
  const wanted = new Set(
    stage.batches.flatMap((batch) => batch.posts.map((post) => `${post.handle}/${post.postId}`)),
  );
  const sourceOrder = config.channels.map((source) => source.handle);
  const batches = planBatches(
    pending.filter((item) => wanted.has(`${item.handle}/${item.postId}`)),
    config.roleWords,
    { fullText: true, sourceOrder, sourceMapping: stage.schema_version === 2 },
  ).map((batch) => {
    writeFileAtomic(join(labelDir, batch.file), batch.text);
    return {
      file: batch.file,
      handle: batch.handle,
      sha256: sha256Utf8(batch.text),
      posts: batch.posts,
      ...(stage.schema_version === 2 ? { schema_version: 2 } : {}),
    };
  });
  writeFileAtomic(
    join(labelDir, "descriptors.json"),
    `${JSON.stringify({ schema_version: 1, batches }, null, 2)}\n`,
  );
  return { labelDir, batches: batches.map((batch) => ({ ...batch, posts: batch.posts.length })) };
}

/** The exit code a summary earns: 2 when a source did not complete, 0 otherwise. */
export function exitCodeOf(summary) {
  const incomplete =
    summary.rate_limited ||
    summary.channels.some((channel) => !["completed", "disabled"].includes(channel.outcome));
  return incomplete ? 2 : 0;
}

/** The bounded stdout summary: codes and counts - no title, no address, no contact. */
export function summarize(run, command = "sweep") {
  const channels = (list) =>
    list.map((channel) => ({
      handle: channel.handle,
      kind: channel.kind,
      thematic: channel.thematic,
      outcome: channel.outcome,
      stop: channel.stop ?? null,
      gap: channel.gap ?? null,
      checked: channel.checked ?? null,
      verdict: channel.verdict?.kind ?? null,
      pages: channel.pages ?? 0,
      requests: channel.requests ?? 0,
      posts_new: channel.posts_new ?? 0,
      buckets: channel.buckets ?? null,
      cards: channel.cards ?? 0,
      read: channel.read ?? 0,
      discrepancies: channel.discrepancies ?? 0,
      addresses: channel.addresses ?? 0,
    }));
  if (run.awaiting) {
    return {
      command,
      completed: false,
      stage: "awaiting_answers",
      rate_limited: run.result.rate_limited,
      channels: channels(run.result.channels),
      batches: run.batches.map((batch) => ({
        file: batch.file,
        handle: batch.handle,
        posts: batch.posts.length,
        ...(run.stage.schema_version === 2
          ? {
              complete_posts: batch.posts.filter((post) => post.complete !== false).length,
              unresolved_posts: batch.posts.filter((post) => post.complete === false).length,
            }
          : {}),
      })),
      posts_to_read: run.batches
        .flatMap((batch) => batch.posts)
        .filter((post) => post.complete !== false).length,
      ...(run.stage.schema_version === 2
        ? {
            unresolved_mappings: run.batches
              .flatMap((batch) => batch.posts)
              .filter((post) => post.complete === false).length,
          }
        : {}),
      batch_dir: run.batchDir,
    };
  }
  const { manifest, collectionPath, cardsPath, reportPath, sourceSetPath } = run;
  return {
    command,
    completed: manifest.completed,
    stage: "completed",
    rate_limited: manifest.rate_limited,
    channels: channels(manifest.channels),
    totals: manifest.totals,
    links: manifest.collection?.links ?? 0,
    accepted_invalid: manifest.accepted_invalid,
    title_line_repaired: manifest.title_line_repaired,
    rejected_answers: manifest.rejected_answers.length,
    stray_answers: manifest.stray_answers,
    collection_path: collectionPath,
    cards_path: cardsPath,
    report_path: reportPath,
    ...(Object.hasOwn(manifest, "source_set") ? { source_set_path: sourceSetPath } : {}),
  };
}
