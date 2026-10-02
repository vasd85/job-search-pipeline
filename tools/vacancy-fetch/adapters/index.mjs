// Adapter registry and selection.
//
// Exactly one adapter serves one URL. Dedicated adapters are tried in declaration order and the
// generic fallback is last, so a source with a dedicated route is never quietly served by the
// weaker path. Source identification itself is never repeated here: `detectJobSource` from
// tools/job-sources/registry.mjs stays the single domain matcher for the registry source id
// recorded beside every record.

import { detectJobSource } from "../../job-sources/registry.mjs";
import { genericHtmlAdapter } from "./generic-html.mjs";
import { linkedinGuestAdapter } from "./linkedin-guest.mjs";

/** Dedicated adapters, in selection order. The generic fallback is not a member. */
export const dedicatedAdapters = Object.freeze([linkedinGuestAdapter]);

export const fallbackAdapter = genericHtmlAdapter;

export const vacancyFetchAdapters = Object.freeze([
  ...dedicatedAdapters,
  fallbackAdapter,
]);

/** The adapter that serves this URL. Never null: the generic fallback serves everything. */
export function selectAdapter(url) {
  return dedicatedAdapters.find((adapter) => adapter.matches(url)) ?? fallbackAdapter;
}

/** Registry source id for a URL, or null when no registered source family matches. */
export function sourceIdFor(url) {
  return detectJobSource(url)?.id ?? null;
}
