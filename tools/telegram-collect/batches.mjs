// The reader's input: one file per source per sweep, up to twenty posts, rendered so that the
// reader can answer with numbers only.
//
// A post is `### post <k>` - its number in the batch, never its id or handle - followed by its
// non-empty lines as `|<i>| <text>` and its links as `-> [<j>] <type> <host><path> "<anchor text>"
// [<marks>]`. Every line the reader may name carries its number, so a line that begins with `###`
// or `->` is text like any other. A post longer than twenty lines shows its first twelve, its last
// eight and every hidden line in which a role word stands: in the research sample 115 posts named
// the role only there.
//
// Only `url`, `tg` and `email` anchors are offered; for `tg` and `email` the address is not
// printed. Every printed line is flattened and bounded by the same function that bounds a card
// title, and nothing here is executed - the file is data for a model that has one tool, reading.
//
// A batch never splits a post and always holds at least one; the byte cap is checked before the
// next post is added.

import { flatLine } from "./cards.mjs";
import { matchingToken, numberedLines } from "./candidates.mjs";

export const batchDirBasename = "reader-in";
export const answerDirBasename = "reader-out";
export const labelDirBasename = "label-in";
export const labelAnswerDirBasename = "label-out";
export const MAX_BATCH_POSTS = 20;
export const MAX_BATCH_BYTES = 48 * 1024;
export const MAX_BATCH_LINE = 300;
export const MAX_ANCHOR_TEXT = 80;
export const SHOW_HEAD_LINES = 12;
export const SHOW_TAIL_LINES = 8;
export const CUT_ABOVE_LINES = 20;
export const offeredLinkTypes = Object.freeze(["url", "tg", "email"]);

/** The lines shown to the reader: all of them, or the head, the tail and the hidden matches. */
export function shownLines(post, tokens, { fullText = false } = {}) {
  const lines = numberedLines(post);
  if (fullText || lines.length <= CUT_ABOVE_LINES) return lines;
  const total = lines.length;
  return lines.filter(
    (line) =>
      line.n <= SHOW_HEAD_LINES ||
      line.n > total - SHOW_TAIL_LINES ||
      matchingToken(line.text, tokens) !== null,
  );
}

/** The anchors the reader may cite, numbered from 1, with the index of each in the post's entries. */
export function offeredLinks(entries) {
  const links = [];
  entries.forEach((entry, entryIndex) => {
    if (entry.skipped !== undefined || !offeredLinkTypes.includes(entry.type)) return;
    links.push({ j: links.length + 1, entryIndex, type: entry.type });
  });
  return links;
}

function renderLink(link, entries) {
  const entry = entries[link.entryIndex];
  const address =
    entry.type === "url" ? ` ${flatLine(`${entry.host}${entry.path}`, MAX_BATCH_LINE)}` : "";
  const marks =
    entry.type === "url" && entry.marks.length > 0 ? ` [${entry.marks.join(", ")}]` : "";
  const anchor = flatLine(entry.anchorText ?? "", MAX_ANCHOR_TEXT).replaceAll('"', "'");
  return `-> [${link.j}] ${entry.type}${address} "${anchor}"${marks}`;
}

/** One post rendered for the reader, and the descriptor the answer is checked against. */
export function renderPost({ post, entries }, k, tokens, { fullText = false } = {}) {
  const shown = shownLines(post, tokens, { fullText });
  const total = numberedLines(post).length;
  const out = [`### post ${k}`];
  let expected = 1;
  for (const line of shown) {
    if (line.n > expected) out.push(`|..| ${line.n - expected} lines hidden`);
    out.push(`|${line.n}| ${flatLine(line.text, MAX_BATCH_LINE)}`);
    expected = line.n + 1;
  }
  if (expected <= total) out.push(`|..| ${total - expected + 1} lines hidden`);
  const links = offeredLinks(entries);
  for (const link of links) out.push(renderLink(link, entries));
  return {
    text: `${out.join("\n")}\n`,
    descriptor: { post: k, shown: shown.map((line) => line.n), links },
  };
}

/**
 * Plan and render the batches of one sweep: per source in `sourceOrder`, posts in the order given,
 * at most `MAX_BATCH_POSTS` posts and `MAX_BATCH_BYTES` bytes per file. Returns
 * `[{ file, handle, text, posts: [{ post, handle, postId, shown, links }] }]`.
 */
export function planBatches(
  pending,
  tokens,
  {
    fullText = false,
    maxPosts = MAX_BATCH_POSTS,
    maxBytes = MAX_BATCH_BYTES,
    sourceOrder = [],
  } = {},
) {
  const bySource = new Map();
  for (const item of pending) {
    if (!bySource.has(item.handle)) bySource.set(item.handle, []);
    bySource.get(item.handle).push(item);
  }
  // Sources in config order; a source the order does not name comes after the named ones.
  const rank = (handle) =>
    sourceOrder.includes(handle) ? sourceOrder.indexOf(handle) : sourceOrder.length;
  const sources = [...bySource].sort(([a], [b]) => rank(a) - rank(b));
  const batches = [];
  for (const [handle, items] of sources) {
    let index = 0;
    let current = null;
    const open = () => {
      index += 1;
      current = {
        file: `${handle}-${String(index).padStart(3, "0")}.txt`,
        handle,
        text: "",
        posts: [],
      };
      batches.push(current);
    };
    for (const item of items) {
      const k = current === null ? 1 : current.posts.length + 1;
      const rendered = renderPost(item, k, tokens, { fullText });
      const bytes = Buffer.byteLength(rendered.text, "utf8");
      if (
        current === null ||
        current.posts.length >= maxPosts ||
        Buffer.byteLength(current.text, "utf8") + bytes > maxBytes
      ) {
        open();
        const first = renderPost(item, 1, tokens, { fullText });
        current.text += first.text;
        current.posts.push({ ...first.descriptor, handle: item.handle, postId: item.postId });
        continue;
      }
      current.text += rendered.text;
      current.posts.push({ ...rendered.descriptor, handle: item.handle, postId: item.postId });
    }
  }
  return batches;
}
