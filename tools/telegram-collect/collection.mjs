// The links collection `/score-jobs` consumes unchanged: the only file of a sweep that scoring reads.
//
// No untrusted free text enters this file. An address line is either a URL rebuilt from a parsed URL
// and accepted by the ledger's normaliser, or the post's own address built from the config handle
// and the numeric id; a `# via:` line is assembled from the validated config handle, the numeric
// message id and a re-serialised instant. Titles and contacts live in the cards and the report.

export const collectionBasename = "collection.links.txt";

/**
 * Render the collection text for the addresses of one sweep, already ordered newest first and each
 * standing once. Returns null when there is nothing to emit: both readers refuse an empty links
 * file (`links_empty`), so an empty collection is not written at all and the report says so.
 */
export function renderCollection({ collectedAt, addresses }) {
  if (addresses.length === 0) return null;
  const lines = [`# collected: ${collectedAt}`, "# order: newest-first"];
  for (const address of addresses) {
    lines.push(`# via: ${address.handle}/${address.postId} ${address.instant}`);
    lines.push(address.url);
  }
  return `${lines.join("\n")}\n`;
}
