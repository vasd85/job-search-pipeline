import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  gapCardView,
  gapSupportLine,
  priorityEvidenceCardView,
  traitCardView,
} from "../web/process-search/application-brief-view.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brief = JSON.parse(
  readFileSync(
    resolve(repoRoot, "tools/application-brief/fixtures/application-brief.v4.valid.json"),
    "utf8",
  ),
);

// Frozen here, never derived from the fixture or from the module. Emptying `experience.gaps` again,
// dropping a classification, or collapsing both support statuses onto one leg has to fail here.
const GAP_NODE_KEYS = Object.freeze([
  "classification",
  "framing",
  "id",
  "requirement",
  "transferableSupport",
]);
const GAP_CONTRACT_ROWS = Object.freeze([
  Object.freeze(["gap-cypress", "hard", "none"]),
  Object.freeze(["gap-team-leadership", "soft", "evidence"]),
  Object.freeze(["gap-kubernetes-infra", "adjacent", "evidence"]),
]);

// A read of a key the node does not carry, an enumeration of a contract node, a membership test and
// any mutation are all recorded or thrown. The absence predicate is `Reflect.has`, not
// `Object.hasOwn`: inherited members such as `join` or `Symbol.iterator` are legitimate reads.
function recordingProxy(node, records, path = "") {
  if (node === null || typeof node !== "object") return node;
  return new Proxy(node, {
    get(target, key, receiver) {
      if (typeof key === "string" && !Reflect.has(target, key)) {
        records.push(`absent key read: ${path}${key}`);
      }
      return recordingProxy(Reflect.get(target, key, receiver), records, `${path}${String(key)}.`);
    },
    has(target, key) {
      records.push(`membership test: ${path}${String(key)}`);
      return Reflect.has(target, key);
    },
    ownKeys(target) {
      records.push(`enumeration: ${path || "node"}`);
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      records.push(`descriptor read: ${path}${String(key)}`);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    set(_target, key) {
      throw new Error(`contract node mutated: ${path}${String(key)}`);
    },
    defineProperty(_target, key) {
      throw new Error(`contract node redefined: ${path}${String(key)}`);
    },
    deleteProperty(_target, key) {
      throw new Error(`contract node key deleted: ${path}${String(key)}`);
    },
    preventExtensions() {
      throw new Error(`contract node sealed: ${path || "node"}`);
    },
    setPrototypeOf() {
      throw new Error(`contract node reparented: ${path || "node"}`);
    },
  });
}

// The records are taken before anything else touches the descriptor: comparing a descriptor that
// still held a live proxy would enumerate it and turn a correct mapper red. The clone runs inside
// the watched window on purpose — it evaluates the descriptor's own enumerable accessors while the
// recorder is still listening, and it fails on a descriptor that carries a live proxy instead of
// copied data. Its reach is bounded: a prototype getter, a non-enumerable own getter and a
// symbol-keyed accessor are all skipped by `structuredClone`, so a mapper contrived to defer a read
// behind one of those still escapes.
function watchedCall(mapper, node) {
  const records = [];
  let thrown = null;
  let value;
  try {
    value = structuredClone(mapper(recordingProxy(node, records)));
  } catch (error) {
    thrown = error;
  }
  return { records: records.splice(0), thrown, value };
}

test("gap cards map exactly the keys the schema-v4 contract defines", () => {
  assert.deepEqual(brief.experience.gaps.map(gapCardView), [
    {
      id: "gap-cypress",
      requirement: "Cypress end-to-end suite ownership",
      classification: "hard",
      supportStatus: "none",
      supportEvidenceIds: [],
      framing:
        "Never claim Cypress. Say plainly that the framework depth was built in Playwright, and describe how the typed layers, fixtures, and auth strategies carry over.",
    },
    {
      id: "gap-team-leadership",
      requirement: "Formal line management of a quality engineering team",
      classification: "soft",
      supportStatus: "evidence",
      supportEvidenceIds: ["evidence-framework"],
      framing:
        "Do not imply a manager title. Describe the shared conventions and architectural boundaries the team adopted, and keep the claim at technical ownership.",
    },
    {
      id: "gap-kubernetes-infra",
      requirement: "Kubernetes-based test infrastructure ownership",
      classification: "adjacent",
      supportStatus: "evidence",
      supportEvidenceIds: ["evidence-framework", "evidence-web3"],
      framing:
        "Position the RPC interception and wallet infrastructure work as the closest real experience, and name where that boundary ends instead of stretching it.",
    },
  ]);
});

test("the canonical fixture keeps the gap coverage the gap card depends on", () => {
  assert.deepEqual(
    brief.experience.gaps.map((gap) => Object.keys(gap).sort()),
    GAP_CONTRACT_ROWS.map(() => [...GAP_NODE_KEYS]),
  );
  assert.deepEqual(
    brief.experience.gaps.map((gap) => [
      gap.id,
      gap.classification,
      gap.transferableSupport.status,
    ]),
    GAP_CONTRACT_ROWS.map((row) => [...row]),
  );
});

test("the mappers read no key the contract cannot contain and enumerate nothing", () => {
  const observed = [];
  const calls = [
    ...brief.experience.gaps.map((gap) => ["gap", gapCardView, gap]),
    ...brief.experience.priorityEvidence.map((item) => [
      "priorityEvidence",
      priorityEvidenceCardView,
      item,
    ]),
    ...brief.experience.traits.map((item) => ["trait", traitCardView, item]),
  ];
  for (const [shape, mapper, node] of calls) {
    const call = watchedCall(mapper, node);
    // An empty record list proves nothing unless the mapper actually completed: a mapper that
    // launders the node off the proxy (`structuredClone`, for one) throws before any trap fires and
    // would otherwise be reported as clean.
    assert.equal(call.thrown, null, `${shape} ${node.id}`);
    assert.notEqual(call.value, undefined, `${shape} ${node.id}`);
    observed.push(...call.records);
  }
  assert.equal(calls.length, 8);
  assert.deepEqual(observed, []);
});

test("the read guard itself records absent keys, enumeration and membership tests", () => {
  const [gap] = brief.experience.gaps;

  // A trait has none of the gap keys, so a live recorder must report every one of them. Compared as
  // a set: the pin is that the recorder fires, not the order the mapper happens to read them in.
  const trait = watchedCall(gapCardView, brief.experience.traits[0]);
  assert.deepEqual(trait.records.sort(), [
    "absent key read: classification",
    "absent key read: requirement",
    "absent key read: transferableSupport",
  ]);

  // Enumeration reports the `ownKeys` trap first and then one descriptor read per key, so the pin is
  // on the first record: both spreading and `Object.keys` must announce the enumeration itself.
  for (const enumerate of [
    // Returns a boolean, not the copy: a spread of the node carries live proxies, which the
    // descriptor clone would reject, and the point here is the `ownKeys` record.
    (node) => Object.keys({ ...node }).length > 0,
    (node) => Object.keys(node).length > 0,
  ]) {
    const call = watchedCall(enumerate, gap);
    assert.equal(call.thrown, null);
    assert.equal(call.records[0], "enumeration: node");
  }
  assert.deepEqual(watchedCall((node) => "term" in node, gap).records, ["membership test: term"]);
  assert.deepEqual(watchedCall((node) => Object.hasOwn(node, "term"), gap).records, [
    "descriptor read: term",
  ]);
  assert.deepEqual(watchedCall((node) => node.transferableEvidence?.status, gap).records, [
    "absent key read: transferableEvidence",
  ]);
});

test("the mappers do not mutate the contract node", () => {
  const [gap] = brief.experience.gaps;
  assert.match(
    watchedCall((node) => {
      node.term = "x";
    }, gap).thrown.message,
    /contract node mutated: term/,
  );
  assert.match(
    watchedCall((node) => {
      delete node.framing;
    }, gap).thrown.message,
    /contract node key deleted: framing/,
  );
  // `Object.defineProperty`, `Object.preventExtensions` and `Object.setPrototypeOf` each bypass the
  // `set` trap entirely, so each needs its own probe. Without them a mapper could mutate the shared
  // fixture object and leak that state into every later test in this file.
  assert.match(
    watchedCall((node) => {
      Object.defineProperty(node, "term", { value: "x" });
    }, gap).thrown.message,
    /contract node redefined: term/,
  );
  assert.match(
    watchedCall((node) => Object.preventExtensions(node), gap).thrown.message,
    /contract node sealed: node/,
  );
  assert.match(
    watchedCall((node) => Object.setPrototypeOf(node, null), gap).thrown.message,
    /contract node reparented: node/,
  );
  for (const gapNode of brief.experience.gaps) {
    assert.equal(watchedCall(gapCardView, gapNode).thrown, null);
  }
});

test("a mapper that defers a read past its return is still recorded", () => {
  const [gap] = brief.experience.gaps;
  // The descriptor's own enumerable accessors are materialised inside the watched window, so this
  // deferral shape cannot escape the recorder by evaluating after the mapper returned. Prototype,
  // non-enumerable and symbol-keyed accessors are outside that reach and are declared containment.
  const deferred = watchedCall(
    (node) => ({
      requirement: {
        get value() {
          return node.title ?? node.requirement;
        },
      },
    }),
    gap,
  );
  assert.deepEqual(deferred.records, ["absent key read: title"]);
});

test("transferable support is read only through its discriminator", () => {
  // Contract-impossible by validate.mjs, and that is the point: a mapper that reads `evidenceIds`
  // unconditionally instead of branching on `status` would leak them into the card.
  assert.deepEqual(
    gapCardView({
      id: "gap-local",
      requirement: "Locally built requirement",
      classification: "hard",
      transferableSupport: { status: "none", evidenceIds: ["evidence-framework"] },
      framing: "Locally built framing.",
    }).supportEvidenceIds,
    [],
  );

  const [, backed] = brief.experience.gaps;
  assert.notEqual(gapCardView(backed).supportEvidenceIds, backed.transferableSupport.evidenceIds);
});

test("the support line states the decision the contract records, and nothing more", () => {
  const [absent, single, several] = brief.experience.gaps.map(gapCardView);
  assert.equal(gapSupportLine(absent), "Transferable evidence deliberately not declared.");
  assert.equal(gapSupportLine(single), "Transferable evidence: evidence-framework");
  assert.equal(gapSupportLine(several), "Transferable evidence: evidence-framework, evidence-web3");
  // `gap` is a real status elsewhere in this schema — `ats.keywords[].support.status` — so a brief
  // carrying it on a gap node must not be rendered as a deliberate declaration of honesty.
  assert.equal(
    gapSupportLine({ supportStatus: "gap", supportEvidenceIds: [] }),
    "Transferable evidence: gap",
  );
});

test("classification passes through verbatim with no label map", () => {
  assert.equal(
    gapCardView({
      id: "gap-local",
      requirement: "Locally built requirement",
      classification: "an unmapped classification",
      transferableSupport: { status: "none", evidenceIds: [] },
      framing: "Locally built framing.",
    }).classification,
    "an unmapped classification",
  );
});

test("priority evidence cards show both priority and category", () => {
  assert.deepEqual(brief.experience.priorityEvidence.map(priorityEvidenceCardView), [
    {
      id: "evidence-framework",
      meta: "primary · Achievement",
      claim:
        "Rebuilt a loosely structured Playwright suite into a layered, maintainable automation framework.",
      proof: [
        "Established typed API layers, explicit architectural boundaries, stable auth strategies, fixtures, and shared conventions.",
        "The nightly run went from about seventy minutes to about twenty-five after the rebuild.",
      ],
      sourceLine: "candidate/profile.md · ### 9.1. Tarnwick Studio - Senior QA Engineer",
    },
    {
      id: "evidence-web3",
      meta: "supporting · Domain experience",
      claim:
        "Tested DApp flows, on-chain data, wallets, and transaction behavior across EVM products.",
      proof: [
        "Used TypeScript, Playwright, Ethers.js, Web3.js, Tenderly, wallet infrastructure, and RPC interception patterns.",
      ],
      sourceLine: "candidate/profile.md · ### 6.2. Test Automation Frameworks & Tools",
    },
    {
      id: "evidence-logistics",
      meta: "supporting · Feasibility",
      claim: "Can work remotely as an independent contractor.",
      proof: [
        "The timezone, the working language and the invoicing arrangement are recorded in the candidate profile.",
      ],
      sourceLine: "candidate/profile.md · ## 1. Contacts & Logistics",
    },
    {
      id: "evidence-llm-work",
      meta: "required · Commercial work practice",
      claim: "Used LLM-based tools systematically in a commercial QA workflow.",
      proof: [
        "Applied LLM-based tools to PR impact analysis, test scaffolding, requirements clarification, DOM analysis, and bug localization.",
      ],
      sourceLine: "candidate/profile.md · #### 6.5.1. AI-assisted QA workflow",
    },
  ]);
});

test("trait cards carry the trait shape and no evidence separator", () => {
  assert.deepEqual(brief.experience.traits.map(traitCardView), [
    {
      id: "trait-systematic",
      trait: "Systematic ownership",
      behavior:
        "Turns recurring test problems into explicit architecture, tooling, and team conventions.",
      sourceLine: "candidate/profile.md · ### Working style",
    },
  ]);
});
