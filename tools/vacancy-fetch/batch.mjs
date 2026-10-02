// Batch orchestration: URLs in, capture files and one manifest out.
//
// Sequential by construction. One request at a time with a delay between requests is not a
// performance compromise, it is the whole rate-limit policy: a personal job search opens the
// pages it was going to open anyway, at a human pace, from one address. Concurrency would turn
// that into crawling, and no flag here enables it.
//
// The batch never throws on a bad page. A failed fetch, a challenge page, a wall and an
// unreadable body are all observations that belong in the manifest; only a caller mistake — an
// unusable output directory, a malformed setting — stops the run before it starts.

import { existsSync, lstatSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { deferredContentReason } from "./adapters/contract.mjs";
import { selectAdapter, sourceIdFor, vacancyFetchAdapters } from "./adapters/index.mjs";
import { normalizeExtractedText } from "./normalize.mjs";
import { classifyDirectRoute } from "./outcome.mjs";
import { sha256Bytes, sha256Utf8 } from "./digest.mjs";
import {
  captureBasename,
  manifestBasename,
  renderCaptureFile,
} from "./persist.mjs";
import { fetchDocument, transportDefaults } from "./transport.mjs";
import { parseHttpUrl, requestedUrl, serverSuppliedUrl } from "./url-rule.mjs";

export const manifestSchemaVersion = 2;
export const batchLabelPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;
export const rateLimitPolicies = Object.freeze(["stop", "continue"]);
export const maxBatchUrls = 256;

export class VacancyFetchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VacancyFetchError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new VacancyFetchError(code, message);
}

/**
 * Validate the output directory and refuse to write into a directory that already holds a
 * batch. A previous batch's manifest is evidence; overwriting it silently is how a comparison
 * loses the run it was comparing against.
 */
export function prepareOutDir(outDir, { uid = process.getuid?.() ?? null } = {}) {
  if (typeof outDir !== "string" || outDir.length === 0 || !isAbsolute(outDir)
    || resolve(outDir) !== outDir) {
    fail("out_dir_unsafe", "Output directory must be an absolute, resolved path.");
  }
  let stats;
  try {
    stats = lstatSync(outDir);
  } catch {
    fail("out_dir_missing", "Output directory does not exist.");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("out_dir_unsafe", "Output directory must be a real directory.");
  }
  if (uid !== null && stats.uid !== uid) {
    fail("out_dir_unsafe", "Output directory must be owned by the current user.");
  }
  if ((stats.mode & 0o022) !== 0) {
    fail("out_dir_unsafe", "Output directory must not be group- or world-writable.");
  }
  if (existsSync(join(outDir, manifestBasename))) {
    fail("out_dir_occupied", "Output directory already holds a batch manifest.");
  }
  // Capture files are checked too, not only the manifest. A batch that died between its first
  // capture and its manifest leaves captures without one, and a retry into the same directory
  // would otherwise collide on an exclusive create halfway through — after re-requesting every
  // earlier URL. Refusing here turns that into a bounded caller error before the first request.
  let entries;
  try {
    entries = readdirSync(outDir);
  } catch {
    fail("out_dir_unsafe", "Output directory could not be listed.");
  }
  if (entries.some((entry) => /^\d{3}\.capture\.txt$/u.test(entry))) {
    fail("out_dir_occupied", "Output directory already holds capture files.");
  }
  return outDir;
}

function realSleep(ms) {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

function skippedRecord(index, url, reason) {
  return {
    index,
    adapterId: null,
    adapterVersion: null,
    sourceId: sourceIdFor(url),
    requestedUrl: requestedUrl(url),
    routeUrl: null,
    redirectChain: [],
    finalUrl: null,
    httpStatus: null,
    responseHeaders: {},
    charset: null,
    declaredCharset: null,
    fetchedAt: null,
    durationMs: null,
    response: null,
    extracted: null,
    normalization: null,
    persisted: null,
    outcome: "access_failure",
    accessBarrier: reason === "rate_limited" ? "rate_limit" : "unparseable",
    retryable: true,
    structural: {},
    structuralOk: false,
    reasons: [reason],
    usable: false,
    fallback: "browser",
    skipped: true,
  };
}

/**
 * A record the layer served but whose completeness it cannot vouch for.
 *
 * `usable` promises access plus the adapter's structural checks and never completeness, so a
 * record carrying the deferred-content signal may be a fragment of the posting and the procedure
 * that scores the batch spends one browser load on it. This is not the `fallback` signal and must
 * not be folded into it: a flagged record's capture is scoreable and competes with the browser
 * body, while a `fallback` record's capture is not.
 *
 * It reads `usable` and the reason code, never `outcome`. That is sound while the flag cannot
 * land on a record the batch procedure already treats as finished: only the generic adapter
 * measures JSON islands, and that adapter reports no first-party status word and no listing flag,
 * so neither `closed` nor `private` is reachable through it. A flagged terminal record would
 * otherwise be counted here and then scored without the browser ever opening. Both halves of the
 * implication are pinned in tests/vacancy-fetch.test.mjs rather than left to this comment.
 */
export function browserCompletenessCheckOwed(record) {
  return record.usable === true
    && Array.isArray(record.reasons)
    && record.reasons.includes(deferredContentReason);
}

function summarize(records) {
  const byOutcome = {};
  for (const name of ["active", "absent", "closed", "private", "access_failure"]) {
    byOutcome[name] = records.filter((record) => record.outcome === name).length;
  }
  return {
    records: records.length,
    byOutcome,
    persisted: records.filter((record) => record.persisted !== null).length,
    usable: records.filter((record) => record.usable).length,
    needsBrowserFallback: records.filter((record) => record.fallback === "browser").length,
    needsBrowserCompletenessCheck: records.filter(browserCompletenessCheckOwed).length,
    skipped: records.filter((record) => record.skipped).length,
    responseBytes: records.reduce(
      (total, record) => total + (record.response?.bytes ?? 0),
      0,
    ),
    persistedBytes: records.reduce(
      (total, record) => total + (record.persisted?.bytes ?? 0),
      0,
    ),
  };
}

/**
 * Run one batch.
 *
 * `fetchImpl`, `sleep` and `now` are parameters so the whole orchestration — delays, the
 * rate-limit stop, persistence, the manifest — is exercised offline. No test in this repository
 * reaches the network.
 */
export async function runVacancyFetchBatch({
  urls,
  outDir,
  batch,
  delayMs = 2000,
  timeoutMs = transportDefaults.timeoutMs,
  maxBytes = transportDefaults.maxBytes,
  maxRedirects = transportDefaults.maxRedirects,
  userAgent = null,
  onRateLimit = "stop",
  fetchImpl = globalThis.fetch,
  sleep = realSleep,
  now = () => new Date(),
}) {
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > maxBatchUrls) {
    fail("urls_invalid", `A batch carries 1 to ${maxBatchUrls} URLs.`);
  }
  if (typeof batch !== "string" || !batchLabelPattern.test(batch)) {
    fail("batch_invalid", "A batch label is required and must be a bounded token.");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 600_000) {
    fail("delay_invalid", "Delay must be between 0 and 600000 milliseconds.");
  }
  if (!rateLimitPolicies.includes(onRateLimit)) {
    fail("rate_limit_policy_invalid", "Rate-limit policy must be stop or continue.");
  }
  prepareOutDir(outDir);

  const startedAt = now().toISOString();
  const records = [];
  let stopped = null;
  let failure = null;
  let requestsMade = 0;

  // The loop is wrapped so the manifest is written even when a record fails unexpectedly. A batch
  // that already spent polite, rate-limited requests must not lose the record of what it fetched
  // just because the run ended badly. This covers a thrown error, not a killed process: after a
  // SIGKILL the captures exist without a manifest, and `prepareOutDir` then refuses the directory
  // instead of colliding mid-retry. There is no resume path, and the README says so.
  try {
    for (let position = 0; position < urls.length; position += 1) {
      const index = position + 1;
      const url = urls[position];

      if (stopped !== null) {
        records.push(skippedRecord(index, url, stopped));
        continue;
      }

      const parsed = parseHttpUrl(url);
      if (parsed === null) {
        // Not a fetchable reference at all. No request is made and no delay is spent.
        records.push({
          ...skippedRecord(index, url, "route_unresolved"),
          skipped: false,
        });
        continue;
      }

      const adapter = selectAdapter(url);
      const route = adapter.route(url, { userAgent });
      if (route === null) {
        records.push({
          ...skippedRecord(index, url, "route_unresolved"),
          adapterId: adapter.id,
          adapterVersion: adapter.version,
          skipped: false,
        });
        continue;
      }

      if (requestsMade > 0 && delayMs > 0) await sleep(delayMs);
      const requestStarted = now();
      const response = await fetchDocument({
        url: route.url,
        method: route.method,
        headers: route.headers,
        fetchImpl,
        timeoutMs,
        maxBytes,
        maxRedirects,
      });
      requestsMade += 1;
      const requestFinished = now();
      const responseSha256 = response.bytes === null ? null : sha256Bytes(response.bytes);

      const reading = adapter.interpret({
        transportFailure: response.transportFailure,
        status: response.status,
        finalUrl: response.finalUrl,
        contentType: response.headers["content-type"] ?? null,
        body: response.body,
        context: route.context,
      });

      const verdict = classifyDirectRoute({
        transportFailure: response.transportFailure,
        status: response.status,
        antiBot: reading.antiBot,
        authWall: reading.authWall,
        statusWord: reading.statusWord,
        unlisted: reading.unlisted,
        hasPostingBody: reading.structural.minimumContentMet === true,
      });

      let extracted = null;
      let normalization = null;
      let persisted = null;
      const persistable = ["active", "closed", "private"].includes(verdict.outcome)
        && typeof reading.text === "string"
        && reading.structural.minimumContentMet === true;

      if (typeof reading.text === "string" && reading.text.length > 0) {
        extracted = { sha256: sha256Utf8(reading.text), chars: reading.text.length };
        const pass = normalizeExtractedText(reading.text);
        normalization = pass.log;
        if (persistable) {
          const basename = captureBasename(index);
          const header = {
            index,
            adapter: `${adapter.id}@${adapter.version}`,
            "source-id": sourceIdFor(url),
            "requested-url": requestedUrl(url),
            "final-url": response.finalUrl,
            "fetched-at": requestStarted.toISOString(),
            "http-status": response.status,
            outcome: verdict.outcome,
            "access-barrier": verdict.accessBarrier,
            "response-sha256": responseSha256,
            "response-bytes": response.byteLength,
            "extracted-sha256": extracted.sha256,
            "normalized-sha256": pass.log.afterSha256,
            "body-bytes": Buffer.byteLength(pass.text, "utf8"),
            normalization: pass.log.rules
              .filter((rule) => rule.replacements > 0)
              .map((rule) => `${rule.id}=${rule.replacements}`)
              .join(",") || "none",
          };
          // Exclusive create: a batch never overwrites a file another batch wrote. A collision is
          // reported as a bounded code rather than a raw filesystem error, because the only way to
          // reach it is a concurrent batch sharing this directory.
          try {
            writeFileSync(
              join(outDir, basename),
              renderCaptureFile({ header, body: pass.text }),
              { encoding: "utf8", flag: "wx", mode: 0o600 },
            );
          } catch {
            fail("capture_write_failed", "A capture file could not be created exclusively.");
          }
          persisted = {
            file: basename,
            sha256: pass.log.afterSha256,
            bytes: Buffer.byteLength(pass.text, "utf8"),
          };
        }
      }

      // A record is usable for scoring only when a body was persisted and every structural check
      // the serving adapter claims actually held.
      const usable = persisted !== null && reading.structuralOk;
      // Only `absent` needs a term of its own. It is derived from a 404/410 on a route that
      // answers for exactly one posting, and a 404 body has no description to check, so no
      // body-level check can touch it — and it never persists a body, so `usable` cannot cover it.
      //
      // `closed` and `private` are read out of the body, so a closure banner found in a layout the
      // adapter no longer recognizes must not be trusted. That is already the case without a
      // second term: every adapter's `structuralOk` implies its minimum-content check, which
      // implies a persisted body, which is `usable`. A closed record therefore needs no fallback
      // exactly when its structural checks held. Naming that here instead of restating it as an
      // unreachable condition — a branch nothing can enter is decoration, not a safeguard. The
      // implication it rests on is pinned per adapter in tests/vacancy-fetch.test.mjs.
      const terminal = verdict.outcome === "absent";

      records.push({
        index,
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        sourceId: sourceIdFor(url),
        requestedUrl: requestedUrl(url),
        routeUrl: serverSuppliedUrl(route.url),
        redirectChain: response.redirectChain,
        finalUrl: response.finalUrl,
        httpStatus: response.status,
        responseHeaders: response.headers,
        charset: response.charset,
        declaredCharset: response.declaredCharset,
        fetchedAt: requestStarted.toISOString(),
        durationMs: requestFinished.getTime() - requestStarted.getTime(),
        response: {
          sha256: responseSha256,
          bytes: response.byteLength,
          decodeReplacements: response.replacementCount,
          transportFailure: response.transportFailure,
        },
        extracted,
        normalization,
        persisted,
        outcome: verdict.outcome,
        accessBarrier: verdict.accessBarrier,
        retryable: verdict.retryable,
        structural: reading.structural,
        structuralOk: reading.structuralOk,
        reasons: reading.reasons,
        usable,
        fallback: usable || terminal ? null : "browser",
        skipped: false,
      });

      if (verdict.accessBarrier === "rate_limit" && onRateLimit === "stop") {
        // The source refused for volume reasons. Continuing would spend the rest of the batch
        // proving the same thing; the remaining links are recorded as unattempted and retryable.
        stopped = "rate_limited";
      }
    }
  } catch (error) {
    failure = error;
    stopped = "failed";
  }

  const manifest = {
    schemaVersion: manifestSchemaVersion,
    tool: "vacancy-fetch",
    batch: {
      label: batch,
      isDefaultTransport: true,
      note: "Default triage transport. Promoted out of marked-experiment state by backlog task 50"
        + " on the written transport comparison of the 2026-08 rollout.",
    },
    startedAt,
    finishedAt: now().toISOString(),
    settings: {
      delayMs,
      timeoutMs,
      maxBytes,
      maxRedirects,
      onRateLimit,
      userAgentOverridden: typeof userAgent === "string" && userAgent.length > 0,
    },
    adapters: vacancyFetchAdapters.map((entry) => ({
      id: entry.id,
      version: entry.version,
      sourceId: entry.sourceId,
    })),
    stoppedEarly: stopped,
    summary: summarize(records),
    records,
  };

  try {
    writeFileSync(
      join(outDir, manifestBasename),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch {
    // A write failure here must not replace a record failure that is already pending: the record
    // error is why the batch ended, and the write error is a consequence of the same bad state.
    // Losing the first for the second is how a caller ends up debugging the disk instead of the
    // bug. With nothing pending, the write failure is itself the outcome and gets a bounded code.
    if (failure === null) {
      fail("manifest_write_failed", "The batch manifest could not be written.");
    }
  }

  if (failure !== null) throw failure;
  return manifest;
}
