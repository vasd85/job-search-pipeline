export const processFilters = Object.freeze([
  Object.freeze({ id: "all", label: "All" }),
  Object.freeze({ id: "active", label: "Active" }),
  Object.freeze({ id: "attention", label: "Needs attention" }),
  Object.freeze({ id: "completed", label: "Completed" }),
  Object.freeze({ id: "historical", label: "Historical" }),
]);

const filterIds = new Set(processFilters.map((filter) => filter.id));
const attentionStates = new Set([
  "blocked",
  "corrupt",
  "failed",
  "missing",
  "stale",
]);

export function parseAppRoute(pathname) {
  if (pathname === "/") return { name: "list" };
  const match = pathname.match(/^\/processes\/([^/]+)\/?$/);
  if (!match) return { name: "not-found" };
  let processId;
  try {
    processId = decodeURIComponent(match[1]);
  } catch {
    return { name: "not-found" };
  }
  if (
    !processId
    || processId.includes("/")
    || processId.includes("\\")
    || processId.includes("\0")
  ) {
    return { name: "not-found" };
  }
  return { name: "detail", processId };
}

export function normalizeFilter(value) {
  return filterIds.has(value) ? value : "all";
}

export function processMatchesFilter(result, filterValue) {
  const filter = normalizeFilter(filterValue);
  const process = result.process;
  if (filter === "all") return true;
  if (filter === "historical") return process.mode === "historical";
  if (filter === "completed") return process.lifecycle_state === "complete";
  if (filter === "attention") {
    return (
      attentionStates.has(process.lifecycle_state)
      || process.attention_steps.length > 0
    );
  }
  return (
    process.mode === "file-backed"
    && process.lifecycle_state !== "complete"
    && !attentionStates.has(process.lifecycle_state)
  );
}

export function filterProcessResults(results, filterValue) {
  return results.filter((result) =>
    processMatchesFilter(result, filterValue));
}

export function listLocation({ filter = "all", query = "" } = {}) {
  const params = new URLSearchParams();
  const normalizedQuery = query.trim();
  const normalizedFilter = normalizeFilter(filter);
  if (normalizedQuery) params.set("q", normalizedQuery);
  if (normalizedFilter !== "all") params.set("filter", normalizedFilter);
  const search = params.toString();
  return search ? `/?${search}` : "/";
}

export function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
