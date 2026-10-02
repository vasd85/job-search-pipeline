#!/usr/bin/env node

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readProcessLogV3DeepSnapshot } from "./lib/process-log-v3-lifecycle.mjs";
import {
  buildPublicProcessDetail,
  buildPublicProcessList,
  ProcessSearchPublicError,
  readPublicProcessArtifact,
} from "./lib/process-search-public.mjs";

const modulePath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(modulePath), "..");
const defaultStaticRoot = resolve(repoRoot, "web/process-search");
const defaultLogPath = resolve(repoRoot, "process-log.json");
const defaultOutputRoot = resolve(repoRoot, "output");
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
]);

function sendJson(response, status, payload, headOnly = false) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store, max-age=0",
  });
  response.end(headOnly ? undefined : body);
}

function sendBytes(response, status, bytes, contentType, headOnly = false) {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": bytes.byteLength,
    "cache-control": "no-store, max-age=0",
  });
  response.end(headOnly ? undefined : bytes);
}

function safeStaticPath(staticRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const target = resolve(staticRoot, relativePath);
  const distance = relative(staticRoot, target);
  if (!distance || distance === ".." || distance.startsWith(`..${sep}`) || isAbsolute(distance))
    return null;
  return target;
}

function decodeApiSegment(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
    return null;
  }
  return decoded;
}

function publicErrorResponse(response, error, headOnly) {
  if (error instanceof ProcessSearchPublicError) {
    sendJson(response, error.status, { error: error.code }, headOnly);
    return;
  }
  sendJson(response, 500, { error: "process_data_unavailable" }, headOnly);
}

function isLoopbackHost(host) {
  return ["127.0.0.1", "::1", "localhost"].includes(String(host).trim().toLowerCase());
}

export function createProcessSearchServer({
  artifactAccessEnabled = true,
  artifactPreviewMaxBytes = 1024 * 1024,
  logPath = defaultLogPath,
  outputRoot = defaultOutputRoot,
  staticRoot = defaultStaticRoot,
  workspaceRoot = repoRoot,
} = {}) {
  return createServer((request, response) => {
    response.setHeader("cache-control", "no-store, max-age=0");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("cross-origin-resource-policy", "same-origin");
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    const method = request.method ?? "GET";
    const headOnly = method === "HEAD";
    if (method !== "GET" && !headOnly) {
      response.setHeader("allow", "GET, HEAD");
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    let url;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      sendJson(response, 400, { error: "Invalid URL" }, headOnly);
      return;
    }

    if (url.pathname === "/api/processes") {
      try {
        const query = url.searchParams.get("q")?.trim() ?? "";
        const snapshot = readProcessLogV3DeepSnapshot(logPath, {
          outputRoot,
          workspaceRoot,
        });
        sendJson(
          response,
          200,
          buildPublicProcessList({
            log: snapshot.log,
            report: snapshot.report,
            query,
          }),
          headOnly,
        );
      } catch (error) {
        publicErrorResponse(response, error, headOnly);
      }
      return;
    }

    const artifactMatch = url.pathname.match(/^\/api\/processes\/([^/]+)\/artifacts\/([^/]+)$/);
    if (artifactMatch) {
      if (!artifactAccessEnabled) {
        sendJson(response, 404, { error: "not_found" }, headOnly);
        return;
      }
      const processId = decodeApiSegment(artifactMatch[1]);
      const artifactKind = decodeApiSegment(artifactMatch[2]);
      if (processId === null || artifactKind === null) {
        sendJson(response, 404, { error: "not_found" }, headOnly);
        return;
      }
      try {
        const artifact = readPublicProcessArtifact({
          artifactKind,
          logPath,
          maxBytes: artifactPreviewMaxBytes,
          outputRoot,
          processId,
          workspaceRoot,
        });
        sendBytes(response, 200, artifact.bytes, artifact.contentType, headOnly);
      } catch (error) {
        publicErrorResponse(response, error, headOnly);
      }
      return;
    }

    const detailMatch = url.pathname.match(/^\/api\/processes\/([^/]+)$/);
    if (detailMatch) {
      const processId = decodeApiSegment(detailMatch[1]);
      if (processId === null) {
        sendJson(response, 404, { error: "not_found" }, headOnly);
        return;
      }
      try {
        const snapshot = readProcessLogV3DeepSnapshot(logPath, {
          outputRoot,
          workspaceRoot,
        });
        sendJson(
          response,
          200,
          buildPublicProcessDetail({
            log: snapshot.log,
            processId,
            report: snapshot.report,
          }),
          headOnly,
        );
      } catch (error) {
        publicErrorResponse(response, error, headOnly);
      }
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "Not found" }, headOnly);
      return;
    }

    const shellMatch = url.pathname.match(/^\/processes\/([^/]+)\/?$/);
    const shellProcessId = shellMatch ? decodeApiSegment(shellMatch[1]) : null;
    const staticPathname = shellProcessId === null ? url.pathname : "/";
    const filePath = safeStaticPath(staticRoot, staticPathname);
    if (!filePath || !mimeTypes.has(extname(filePath))) {
      sendJson(response, 404, { error: "Not found" }, headOnly);
      return;
    }
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) throw new Error("not a file");
      response.writeHead(200, {
        "content-type": mimeTypes.get(extname(filePath)),
        "content-length": stat.size,
        "cache-control": "no-store, max-age=0",
      });
      if (headOnly) response.end();
      else createReadStream(filePath).pipe(response);
    } catch {
      sendJson(response, 404, { error: "Not found" }, headOnly);
    }
  });
}

function startServer() {
  const host = process.env.JOB_PIPELINE_SEARCH_HOST || "127.0.0.1";
  const port = Number.parseInt(process.env.JOB_PIPELINE_SEARCH_PORT || "4173", 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("JOB_PIPELINE_SEARCH_PORT must be an integer from 0 to 65535");
  }
  const artifactAccessEnabled =
    isLoopbackHost(host) || process.env.JOB_PIPELINE_ENABLE_ARTIFACT_API === "1";
  const server = createProcessSearchServer({ artifactAccessEnabled });
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`Process search: http://${host}:${actualPort}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  try {
    startServer();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
