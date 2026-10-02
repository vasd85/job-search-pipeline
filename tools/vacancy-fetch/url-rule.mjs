// The URL rule of ADR 0012 decision 2, applied to the triage working directory.
//
// A redirect target is a place a secret arrives without anyone choosing to write it down: an
// authentication redirect routinely carries a code, a state value, a signed-URL token or an
// implicit-grant access token in the query string or the fragment. So a server-supplied URL is
// recorded as origin and path only. A requested URL keeps its query, because the ledger's
// identity key is computed from exactly that and narrowing it would silently change process
// identity; its fragment is dropped, because the key computation already discards it and it is
// where an implicit-grant token lands.
//
// One residual is named rather than implied: a token embedded in a *path* survives this rule
// everywhere.

/** Parse an http(s) URL, or return null. Nothing else is ever fetched or recorded. */
export function parseHttpUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url;
}

/** Origin and path, query and fragment dropped. Used for every server-supplied URL. */
export function serverSuppliedUrl(value) {
  const url = value instanceof URL ? value : parseHttpUrl(value);
  return url === null ? null : `${url.origin}${url.pathname}`;
}

/** Origin, path and query, fragment dropped. Used for the URL the caller asked for. */
export function requestedUrl(value) {
  const url = value instanceof URL ? value : parseHttpUrl(value);
  return url === null ? null : `${url.origin}${url.pathname}${url.search}`;
}
