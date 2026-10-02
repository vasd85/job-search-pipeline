// The HTTP transport: one request, bounded, with the redirect chain recorded.
//
// It is the only module here that touches the network, and it takes `fetchImpl` as a parameter
// so every test drives it offline. Redirects are followed manually rather than by the runtime,
// because the chain is evidence: a posting that answers from a different origin, or a request
// that ends on an authwall path, is a fact the record has to carry.
//
// Every ceiling is explicit and every breach is a bounded code, never an exception message:
// a decoded response body is untrusted content, and a diagnostic that echoes it hands hostile
// text to whatever reads the summary.

import { serverSuppliedUrl } from "./url-rule.mjs";

export const transportFailureCodes = Object.freeze([
  "aborted",
  "invalid_redirect",
  "network_error",
  "oversize",
  "redirect_ceiling",
  "timeout",
]);

export const transportDefaults = Object.freeze({
  timeoutMs: 20_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
});

// Response headers are carried as a bounded allowlist, never as the raw header set: a raw set
// carries session cookies and authorization values for no fidelity benefit. `location` is
// narrowed by the URL rule before it is recorded.
export const recordedResponseHeaders = Object.freeze([
  "content-type",
  "content-encoding",
  "content-length",
  "etag",
  "last-modified",
  "retry-after",
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function collectHeaders(headers) {
  const recorded = {};
  for (const name of recordedResponseHeaders) {
    const value = headers.get(name);
    if (value !== null && value !== undefined) recorded[name] = value;
  }
  const authenticate = headers.get("www-authenticate");
  if (authenticate) {
    // The challenge scheme without its parameters: the parameters carry realm and token data.
    recorded["www-authenticate-scheme"] = authenticate.split(/[\s,]/u)[0]?.toLowerCase() ?? "";
  }
  const location = headers.get("location");
  if (location) {
    const narrowed = serverSuppliedUrl(location);
    if (narrowed !== null) recorded.location = narrowed;
  }
  return recorded;
}

function charsetOf(contentType) {
  const match =
    typeof contentType === "string" ? contentType.match(/charset\s*=\s*"?([\w.:+-]+)"?/iu) : null;
  return match ? match[1].toLowerCase() : null;
}

// A `<meta charset>` declaration in the first bytes, used only when the response declares no
// charset of its own. Bounded to the prologue so the scan cannot walk a whole hostile document.
function sniffMetaCharset(bytes) {
  const prologue = Buffer.from(bytes.subarray(0, 2048)).toString("latin1");
  const direct = prologue.match(/<meta[^>]+charset\s*=\s*["']?([\w.:+-]+)/iu);
  return direct ? direct[1].toLowerCase() : null;
}

function decodeBody(bytes, charset) {
  const candidates = [charset, "utf-8"].filter((value) => typeof value === "string");
  for (const candidate of candidates) {
    try {
      // Non-fatal on purpose: a single bad byte in a real posting must not lose the whole
      // description. The replacement count is reported so the record shows it happened.
      const decoder = new TextDecoder(candidate, { fatal: false });
      const text = decoder.decode(bytes);
      return {
        text,
        charset: candidate,
        replacementCount: (text.match(/�/gu) ?? []).length,
      };
    } catch {
      continue;
    }
  }
  const text = Buffer.from(bytes).toString("utf8");
  return {
    text,
    charset: "utf-8",
    replacementCount: (text.match(/�/gu) ?? []).length,
  };
}

async function readBounded(response, maxBytes) {
  if (response.body === null || response.body === undefined) {
    return { bytes: new Uint8Array(0), oversize: false };
  }
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Cancel rather than drain: the point of the ceiling is not to read the rest.
        //
        // Deliberately not awaited. `cancel()` on one branch of a teed stream resolves only once
        // the sibling branch is cancelled too, so awaiting it can hang forever on a body this
        // module does not own; the verdict is already decided, and the runtime tears the socket
        // down when the stream is collected.
        reader.cancel().catch(() => {});
        return { bytes: null, oversize: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return { bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), oversize: false };
}

/**
 * Fetch one document, following redirects manually.
 *
 * Returns a record, never a thrown transport error: a failed fetch is an observation the batch
 * has to persist, not an exception that ends the run.
 */
export async function fetchDocument({
  url,
  headers,
  method = "GET",
  fetchImpl = globalThis.fetch,
  timeoutMs = transportDefaults.timeoutMs,
  maxBytes = transportDefaults.maxBytes,
  maxRedirects = transportDefaults.maxRedirects,
  signal = null,
}) {
  const redirectChain = [];
  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const composed = signal === null ? timeout : AbortSignal.any([timeout, signal]);
    let response;
    try {
      response = await fetchImpl(current, {
        method,
        headers,
        redirect: "manual",
        signal: composed,
      });
    } catch (error) {
      const aborted = error?.name === "AbortError" || error?.name === "TimeoutError";
      return failure(aborted ? (timeout.aborted ? "timeout" : "aborted") : "network_error", {
        redirectChain,
        finalUrl: serverSuppliedUrl(current),
      });
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      let next;
      try {
        next = location === null ? null : new URL(location, current);
      } catch {
        next = null;
      }
      if (next === null || (next.protocol !== "https:" && next.protocol !== "http:")) {
        return failure("invalid_redirect", {
          status: response.status,
          redirectChain,
          finalUrl: serverSuppliedUrl(current),
          headers: collectHeaders(response.headers),
        });
      }
      // The fragment is dropped before the hop is followed as well as before it is recorded: it
      // is never sent to a server, and it is where an implicit-grant token lands.
      next.hash = "";
      redirectChain.push({ status: response.status, url: serverSuppliedUrl(next) });
      if (hop === maxRedirects) {
        return failure("redirect_ceiling", {
          status: response.status,
          redirectChain,
          finalUrl: serverSuppliedUrl(next),
          headers: collectHeaders(response.headers),
        });
      }
      current = next.toString();
      continue;
    }

    const recorded = collectHeaders(response.headers);
    const read = await readBounded(response, maxBytes);
    if (read.oversize) {
      return failure("oversize", {
        status: response.status,
        redirectChain,
        finalUrl: serverSuppliedUrl(current),
        headers: recorded,
      });
    }
    const declared = charsetOf(recorded["content-type"]) ?? sniffMetaCharset(read.bytes);
    const decoded = decodeBody(read.bytes, declared);
    return {
      transportFailure: null,
      status: response.status,
      redirectChain,
      finalUrl: serverSuppliedUrl(current),
      headers: recorded,
      bytes: read.bytes,
      byteLength: read.bytes.byteLength,
      body: decoded.text,
      charset: decoded.charset,
      declaredCharset: declared,
      replacementCount: decoded.replacementCount,
    };
  }

  return failure("redirect_ceiling", { redirectChain, finalUrl: serverSuppliedUrl(current) });
}

function failure(code, extra) {
  return {
    transportFailure: code,
    status: null,
    redirectChain: [],
    finalUrl: null,
    headers: {},
    bytes: null,
    byteLength: 0,
    body: "",
    charset: null,
    declaredCharset: null,
    replacementCount: 0,
    ...extra,
  };
}
