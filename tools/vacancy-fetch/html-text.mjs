// Dependency-free HTML tokenizer and visible-text collector for the triage fetch layer.
//
// Node ships no DOM, and this repository has no runtime dependency to add one, so the layer
// carries its own scanner. It is deliberately not a conformant HTML parser: it never executes
// script, never resolves a stylesheet, never repairs a document into the shape a browser would
// build, and it makes no claim about matching browser-rendered text. What it does guarantee is
// bounded, linear work over hostile input — one forward pass, no backtracking regular expression
// over attacker-controlled text, a node ceiling and a nesting ceiling — because every byte it
// sees came from an untrusted vacancy page.
//
// Deliberate non-goals: no network access, no adapter policy, no outcome vocabulary, no
// normalization (tools/vacancy-fetch/normalize.mjs owns the logged pass), and no invented
// characters — a list item gets a line break and never a bullet glyph, because the persisted
// text is evidence that later checks quote from literally.

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

// Elements whose content is text rather than markup. The scanner must run to their exact closing
// tag, or a `<` inside a script literal silently becomes an element.
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);

// Of those, the ones whose content still resolves character references. `script` and `style` are
// CDATA and keep their bytes; `textarea` and `title` are RCDATA, so `&amp;` inside a textarea is
// an ampersand on the page and has to be one in the persisted text too.
const RCDATA_TAGS = new Set(["textarea", "title"]);

// Dropped while parsing: their text is never visible page content, so keeping it would put
// script bodies and stylesheet rules into a file later read as the job description.
const NEVER_TEXT_TAGS = new Set([
  "base", "head", "link", "math", "meta", "noscript", "script", "style", "svg",
  "template", "title",
]);

// Page chrome for the generic fallback. Kept as an exported set rather than an inline literal so
// an adapter states which chrome it drops instead of each adapter inventing its own list.
export const genericChromeTags = Object.freeze([
  "aside", "footer", "form", "header", "nav",
]);

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "caption", "dd", "div",
  "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hr", "legend", "li", "main", "nav", "ol",
  "p", "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr",
  "ul",
]);

const PREFORMATTED_TAGS = new Set(["pre"]);

// One open element implies the end of another. This is the small, well-known subset that real
// postings rely on; anything outside it is left to the stray-close-tag rule below.
const IMPLIED_END = new Map([
  ["li", new Set(["li"])],
  ["dd", new Set(["dd", "dt"])],
  ["dt", new Set(["dd", "dt"])],
  ["option", new Set(["option"])],
  ["td", new Set(["td", "th"])],
  ["th", new Set(["td", "th"])],
  ["tr", new Set(["td", "th", "tr"])],
  ["p", new Set(["p"])],
]);

const NAMED_ENTITIES = new Map(Object.entries({
  amp: "&", apos: "'", bull: "•", copy: "©", dash: "–",
  deg: "°", eacute: "é", euro: "€", gt: ">", hellip: "…",
  laquo: "«", ldquo: "“", lsquo: "‘", lt: "<", mdash: "—",
  middot: "·", nbsp: " ", ndash: "–", pound: "£",
  quot: "\"", raquo: "»", rdquo: "”", reg: "®", rsquo: "’",
  sect: "§", shy: "­", trade: "™", yen: "¥",
}));

const maxNodes = 200_000;
const maxDepth = 256;

function decodeNumericEntity(body) {
  const hex = body[0] === "x" || body[0] === "X";
  const digits = hex ? body.slice(1) : body;
  if (digits.length === 0 || digits.length > 8) return null;
  if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) return null;
  const code = Number.parseInt(digits, hex ? 16 : 10);
  // Surrogates and out-of-range code points would produce lone surrogates in the persisted
  // text, which the safe-string checks elsewhere reject; drop them instead.
  if (!Number.isFinite(code) || code === 0 || code > 0x10ffff) return null;
  if (code >= 0xd800 && code <= 0xdfff) return null;
  return String.fromCodePoint(code);
}

/**
 * Resolve HTML character references. An unknown reference is left literal rather than guessed,
 * so `&notanentity;` survives as source wording instead of becoming invented text.
 */
export function decodeEntities(value) {
  if (!value.includes("&")) return value;
  let result = "";
  let index = 0;
  while (index < value.length) {
    const start = value.indexOf("&", index);
    if (start === -1) {
      result += value.slice(index);
      break;
    }
    result += value.slice(index, start);
    const end = value.indexOf(";", start + 1);
    // A reference is short; a distant semicolon belongs to unrelated text.
    if (end === -1 || end - start > 12) {
      result += "&";
      index = start + 1;
      continue;
    }
    const body = value.slice(start + 1, end);
    const decoded = body.startsWith("#")
      ? decodeNumericEntity(body.slice(1))
      : NAMED_ENTITIES.get(body.toLowerCase()) ?? null;
    if (decoded === null) {
      result += "&";
      index = start + 1;
      continue;
    }
    result += decoded;
    index = end + 1;
  }
  return result;
}

function isNameStart(character) {
  return /[a-zA-Z]/.test(character);
}

function readTagName(html, start) {
  let index = start;
  while (index < html.length && /[^\s/>]/.test(html[index])) index += 1;
  return { name: html.slice(start, index).toLowerCase(), end: index };
}

function readAttributes(html, start) {
  const attributes = Object.create(null);
  let index = start;
  let selfClosing = false;
  while (index < html.length) {
    while (index < html.length && /\s/.test(html[index])) index += 1;
    if (index >= html.length) break;
    if (html[index] === ">") {
      index += 1;
      break;
    }
    if (html[index] === "/") {
      // Only a solidus standing immediately before `>` closes the tag. A solidus followed by
      // another attribute is the tokenizer's unexpected-solidus parse error and closes nothing;
      // latching the flag there would make the element void, so its real children would attach
      // to its parent and the whole subtree would vanish from every container lookup.
      if (html[index + 1] === ">") {
        selfClosing = true;
        index += 2;
        break;
      }
      index += 1;
      continue;
    }
    const nameStart = index;
    while (index < html.length && !/[\s/>=]/.test(html[index])) index += 1;
    const name = html.slice(nameStart, index).toLowerCase();
    if (name.length === 0) {
      index += 1;
      continue;
    }
    while (index < html.length && /\s/.test(html[index])) index += 1;
    let value = "";
    if (html[index] === "=") {
      index += 1;
      while (index < html.length && /\s/.test(html[index])) index += 1;
      const quote = html[index];
      if (quote === "\"" || quote === "'") {
        const close = html.indexOf(quote, index + 1);
        const stop = close === -1 ? html.length : close;
        value = html.slice(index + 1, stop);
        index = close === -1 ? html.length : close + 1;
      } else {
        const valueStart = index;
        while (index < html.length && !/[\s>]/.test(html[index])) index += 1;
        value = html.slice(valueStart, index);
      }
    }
    // First occurrence wins, matching how a duplicate attribute is treated in practice; the
    // alternative silently prefers whichever copy an injected attribute wrote last.
    if (!Object.hasOwn(attributes, name)) attributes[name] = decodeEntities(value);
  }
  return { attributes, end: index, selfClosing };
}

function element(tag, attributes) {
  return { type: "element", tag, attributes, children: [] };
}

/**
 * Parse one HTML document into a bounded element tree.
 * Returns the root plus the two ceilings' verdicts, so a caller can record that it read a
 * truncated document instead of silently treating a partial parse as the whole page.
 */
export function parseHtml(html) {
  const root = { type: "root", tag: null, attributes: Object.create(null), children: [] };
  const stack = [root];
  // A close tag that is absent from `from` onwards is absent from every later position too, so a
  // name whose search already missed is never searched again. Without this, a document built out
  // of `<meta>` or `<link>` — each of which has no close tag at all — spends one full scan of the
  // document per element, which is quadratic work on exactly the input a hostile page would send.
  // Measured before the memo on this repository's own code: 40,000 `<meta>` tags took 7.3 s and
  // each doubling roughly quadrupled the time.
  const missingClose = new Set();
  // The search runs over `html` itself and case-folds only the candidate tag name.
  //
  // A pre-lowercased copy of the document would be faster to search and would be wrong: not every
  // character keeps its length under `toLowerCase`. U+0130 (`İ`, an ordinary Turkish capital
  // letter that a real career page carries in a company name or an all-caps heading) lowercases to
  // two UTF-16 units, so every offset after it is shifted, and an index found in the copy then
  // slices the original at the wrong place. Measured on this repository's own code before the
  // search moved here: one `İ` before a `<textarea>` spliced a stray `<` into the persisted text,
  // and fourteen of them silently dropped a whole paragraph of the job description. That is
  // exactly the invented character the persisted body may never contain.
  const findClose = (name, from) => {
    if (missingClose.has(name)) return -1;
    let at = from;
    for (;;) {
      at = html.indexOf("</", at);
      if (at === -1) {
        missingClose.add(name);
        return -1;
      }
      const nameEnd = at + 2 + name.length;
      if (html.slice(at + 2, nameEnd).toLowerCase() === name) {
        // The name has to end where a tag name may end, so `</scriptable` is not `</script`.
        const following = html[nameEnd];
        if (
          following === undefined
          || following === ">"
          || following === "/"
          || /\s/u.test(following)
        ) {
          return at;
        }
      }
      at += 2;
    }
  };
  let index = 0;
  let nodes = 0;
  let nodeCeilingHit = false;
  let depthCeilingHit = false;

  const appendText = (raw) => {
    if (raw.length === 0) return;
    if (nodes >= maxNodes) {
      nodeCeilingHit = true;
      return;
    }
    nodes += 1;
    stack[stack.length - 1].children.push({ type: "text", value: decodeEntities(raw) });
  };

  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt === -1) {
      appendText(html.slice(index));
      break;
    }
    if (lt > index) appendText(html.slice(index, lt));

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", lt)) {
      const end = html.indexOf("]]>", lt + 9);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const closing = html[lt + 1] === "/";
    const nameStart = lt + (closing ? 2 : 1);
    if (!isNameStart(html[nameStart] ?? "")) {
      // Not a tag at all. A bare `<` in prose is content, not markup.
      appendText("<");
      index = lt + 1;
      continue;
    }
    const { name, end: afterName } = readTagName(html, nameStart);
    let attributes = Object.create(null);
    let selfClosing = false;
    if (closing) {
      const gt = html.indexOf(">", afterName);
      index = gt === -1 ? html.length : gt + 1;
    } else {
      const parsed = readAttributes(html, afterName);
      attributes = parsed.attributes;
      selfClosing = parsed.selfClosing;
      index = parsed.end;
    }

    if (closing) {
      const depth = stack.findLastIndex((node) => node.tag === name);
      // A stray close tag closes nothing: honouring it would unwind the document to its root
      // and merge unrelated sections into one block.
      if (depth > 0) stack.length = depth;
      continue;
    }

    if (nodes >= maxNodes) {
      nodeCeilingHit = true;
      break;
    }
    nodes += 1;

    const implied = IMPLIED_END.get(name);
    if (implied) {
      const top = stack[stack.length - 1];
      if (top.type === "element" && implied.has(top.tag)) stack.pop();
    }

    if (RAW_TEXT_TAGS.has(name)) {
      const closeIndex = findClose(name, index);
      const stop = closeIndex === -1 ? html.length : closeIndex;
      const raw = html.slice(index, stop);
      if (!NEVER_TEXT_TAGS.has(name)) {
        const node = element(name, attributes);
        node.children.push({
          type: "text",
          value: RCDATA_TAGS.has(name) ? decodeEntities(raw) : raw,
        });
        stack[stack.length - 1].children.push(node);
      }
      if (closeIndex === -1) {
        index = html.length;
      } else {
        const gt = html.indexOf(">", closeIndex);
        index = gt === -1 ? html.length : gt + 1;
      }
      continue;
    }

    if (NEVER_TEXT_TAGS.has(name)) {
      // Parsed and discarded together with its subtree: the subtree is skipped by not opening
      // a node for it, and its stray close tag then closes nothing.
      //
      // A void element in this set — `base`, `link`, `meta` — has no close tag by definition, so
      // it is skipped without a search at all. Searching for one would be both wrong and the
      // dominant cost on a page made of them.
      if (!VOID_TAGS.has(name)) {
        const closeIndex = findClose(name, index);
        if (closeIndex !== -1) {
          const gt = html.indexOf(">", closeIndex);
          index = gt === -1 ? html.length : gt + 1;
        }
      }
      continue;
    }

    const node = element(name, attributes);
    stack[stack.length - 1].children.push(node);
    if (VOID_TAGS.has(name) || selfClosing) continue;
    if (stack.length >= maxDepth) {
      depthCeilingHit = true;
      continue;
    }
    stack.push(node);
  }

  return { root, nodeCeilingHit, depthCeilingHit, nodes };
}

export function attributeOf(node, name) {
  return node.type === "element" && Object.hasOwn(node.attributes, name)
    ? node.attributes[name]
    : null;
}

export function classList(node) {
  const value = attributeOf(node, "class");
  return value === null ? [] : value.split(/\s+/).filter((entry) => entry.length > 0);
}

export function hasClassContaining(node, fragment) {
  return classList(node).some((entry) => entry.includes(fragment));
}

/** Depth-first element walk, root excluded. Iterative, so a deep document cannot overflow. */
export function walkElements(root) {
  const found = [];
  const stack = [...root.children];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.type !== "element") continue;
    found.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]);
    }
  }
  return found;
}

export function findElement(root, predicate) {
  return walkElements(root).find((node) => predicate(node)) ?? null;
}

/**
 * Collect the visible text of one subtree.
 *
 * Block elements and `<br>` become line breaks; inline whitespace collapses to single spaces;
 * `<pre>` keeps its own line structure. No bullet, dash, heading marker or separator is
 * inserted, because everything this function emits is later quoted as source wording.
 */
export function collectText(node, { skipTags = [] } = {}) {
  const skip = new Set(skipTags);
  const parts = [];
  const visit = (current, preformatted) => {
    if (current.type === "text") {
      if (preformatted) {
        parts.push(current.value);
        return;
      }
      const collapsed = current.value.replace(/\s+/gu, " ");
      if (collapsed.length > 0) parts.push(collapsed);
      return;
    }
    if (current.type === "element" && skip.has(current.tag)) return;
    const block = current.type === "element" && BLOCK_TAGS.has(current.tag);
    const pre = preformatted
      || (current.type === "element" && PREFORMATTED_TAGS.has(current.tag));
    if (block) parts.push("\n");
    for (const child of current.children) visit(child, pre);
    if (block) parts.push("\n");
  };
  visit(node, false);
  return parts
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
}

/** Visible-text length of a subtree, used to choose between candidate containers. */
export function textLength(node, options) {
  return collectText(node, options).replace(/\s+/gu, "").length;
}
