// DOM-free projection of application-brief v3 nodes onto flat card descriptors.
//
// `tools/application-brief/validate.mjs` is the authority on what a node may contain, and it rejects
// every key outside the lists below. So each mapper reads exactly those keys by name: no fallback
// chain over a name the contract cannot carry, and no enumeration of a contract node. Contract enums
// pass through verbatim, so the same value can drive both the visible text and a `data-*` attribute.

export function gapCardView(gap) {
  // Allowed keys: id, requirement, classification, transferableSupport { status, evidenceIds },
  // framing. `evidenceIds` is read only on the leg of the discriminator that gives it meaning; the
  // contract requires it to be empty when the status is `none`.
  const support = gap.transferableSupport;
  return {
    id: gap.id,
    requirement: gap.requirement,
    classification: gap.classification,
    supportStatus: support.status,
    supportEvidenceIds: support.status === "evidence" ? [...support.evidenceIds] : [],
    framing: gap.framing,
  };
}

// Presentation copy rather than a pure projection, kept here on purpose: in `app.js` its third leg
// would be unreachable by any test, and a status the contract does not define must not be dressed up
// as a deliberate declaration.
export function gapSupportLine(view) {
  if (view.supportStatus === "evidence") {
    return `Transferable evidence: ${view.supportEvidenceIds.join(", ")}`;
  }
  if (view.supportStatus === "none") {
    return "Transferable evidence deliberately not declared.";
  }
  return `Transferable evidence: ${view.supportStatus}`;
}

export function priorityEvidenceCardView(item) {
  // Allowed keys: id, priority, category, claim, profileSource, proof, cvPlacements. `priority` and
  // `category` are both required strings, so both are shown; `cvPlacements` is deliberately not
  // projected yet and stays owned by the semantic-view completeness task.
  return {
    id: item.id,
    meta: `${item.priority} · ${item.category}`,
    claim: item.claim,
    proof: [...item.proof],
    sourceLine: `${item.profileSource.path} · ${item.profileSource.section}`,
  };
}

export function traitCardView(item) {
  // Allowed keys: id, trait, behavior, profileSource. A trait carries neither `priority` nor
  // `category`, which is why it cannot share a renderer with priority evidence.
  return {
    id: item.id,
    trait: item.trait,
    behavior: item.behavior,
    sourceLine: `${item.profileSource.path} · ${item.profileSource.section}`,
  };
}
