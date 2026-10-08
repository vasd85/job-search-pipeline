// Fictional source-context cases. No production URL, company, person or candidate facts.
import { createHash } from "node:crypto";
import { baseInput, baseOffer } from "../job-scorer/decision-table.mjs";
import {
  cardBody,
  createSourceSet,
  snapshotFromHtml,
  sourceSetDigest,
} from "../../../tools/triage-sources/source-set.mjs";
const sha = (text) => createHash("sha256").update(text).digest("hex");
export const fixtureCaptureAt = "2026-10-08T08:00:00.000Z";
const escape = (text) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function fictionalPostHtml(lines, { postId = 101, handle = "fictionjobs" } = {}) {
  return `<div class="tgme_widget_message" data-post="${handle}/${postId}"><div class="tgme_widget_message_text">${lines.join("<br/>")}</div><div class="tgme_widget_message_footer"><a class="tgme_widget_message_date"><time datetime="2026-10-07T07:00:00+00:00">date</time></a></div></div>`;
}
export function fictionalSourceFixture({
  kind = "full_description",
  manual = false,
  junior = false,
  details = true,
  contact = false,
  postId = 101,
  companyUrl = "https://fictional-labs.example.test/",
  jobUrl = "https://jobs.example.test/qa/101",
  salary = null,
} = {}) {
  const title = "QA Engineer";
  const level = junior ? "Junior+" : "Senior QA Engineer";
  const automation = manual ? "Manual testing only" : "Primary test automation";
  const jd = [
    title,
    "Company Fictional Labs",
    "English description",
    "Remote work from Argentina",
    "B2B data platform",
    automation,
    level,
    ...(salary === null ? [] : [salary]),
  ];
  const lines =
    kind === "summary"
      ? [
          title,
          `Company <a href="${companyUrl}">Fictional Labs</a>`,
          "Read the full description below",
        ]
      : jd.map(escape);
  if (kind !== "summary") lines[1] = `Company <a href="${companyUrl}">Fictional Labs</a>`;
  if (details) lines.push(`Apply <a href="${jobUrl}">here</a>`);
  if (contact) lines.push('<a href="mailto:recruiting@example.test">Email recruiting</a>');
  const html = fictionalPostHtml(lines, { postId });
  const snapshot = snapshotFromHtml(html, {
    handle: "fictionjobs",
    postId,
    file: "001.page.html",
    capturedAt: fixtureCaptureAt,
  });
  const collectionText = `${companyUrl}\n${details ? `${jobUrl}\n` : ""}${kind === "summary" ? "" : `${snapshot.original_url}\n`}`;
  const links = snapshot.anchors.map((anchor) => ({
    anchor: anchor.index,
    url: anchor.href,
    role:
      anchor.href === companyUrl
        ? "company_context"
        : anchor.href.startsWith("mailto:")
          ? "contact"
          : "apply",
  }));
  links.push({ anchor: null, role: "original_post", url: snapshot.original_url });
  const sourceSet = createSourceSet({
    collectionText,
    snapshots: [snapshot],
    cards: [
      {
        snapshot_ref: snapshot.snapshot_ref,
        title_line: 1,
        start_line: 1,
        end_line: snapshot.lines.length,
        description_kind: kind,
        links,
      },
    ],
  });
  const card = sourceSet.cards[0];
  const fact = (value, evidence_quote = value) => ({ value, evidence_quote });
  const facts = {
    company: fact("Fictional Labs", "Company Fictional Labs"),
    title: fact(title),
    role: fact(title),
    seniority: kind === "summary" ? null : fact(level),
    salary: kind === "summary" || salary === null ? null : fact(salary),
    published_at: null,
  };
  const originalBody = cardBody(sourceSet, card);
  const inputFor = (
    sourceRef,
    body,
    {
      index = 1,
      captureSha256 = snapshot.capture.sha256,
      primary = true,
      seniority = junior ? "junior" : "senior",
      observedSalary = salary,
    } = {},
  ) => {
    const input = baseInput();
    input.schemaVersion = 10;
    input.policyId = "triage-policy-v9-2026-10-08";
    input.inputIndex = index;
    input.scoringDate = "2026-10-08";
    input.source = {
      ...input.source,
      company: "Fictional Labs",
      jobTitle: title,
      evidenceQuote: title,
      locationRaw: "Argentina",
      workFormatRaw: "Remote",
      salaryRaw: observedSalary,
      sourceRef,
      finalUrl: sourceRef.replace(/\?embed=1$/u, ""),
    };
    input.compensation =
      observedSalary === null ? null : { ...input.compensation, evidenceQuote: observedSalary };
    input.role = {
      ...input.role,
      automation: manual ? "manual_only" : "primary",
      seniority,
      observedTools: [],
      observedLanguages: [],
      evidence: {
        aiProduct: null,
        aiWork: null,
        automation,
        domain: "B2B data platform",
        language: "English description",
        role: title,
        seniority: seniority === "junior" ? "Junior+" : "Senior QA Engineer",
        tools: null,
      },
    };
    input.offers = [baseOffer({ evidenceQuote: "Remote work from Argentina" })];
    input.sourceContext = {
      sourceSetSha256: sourceSetDigest(sourceSet),
      cardRef: card.card_ref,
      snapshotRef: snapshot.snapshot_ref,
      primarySourceRef: sourceRef,
      primaryCaptureSha256: captureSha256,
      startLine: primary ? card.start_line : 1,
      endLine: primary ? card.end_line : body.split("\n").length,
    };
    return input;
  };
  const original = {
    card_ref: card.card_ref,
    source_ref: snapshot.original_url,
    description_kind: kind,
    identity_status: "confirmed",
    capture: snapshot.capture && { file: snapshot.capture.file, sha256: snapshot.capture.sha256 },
    body: originalBody,
    facts,
    input: kind === "full_description" ? inputFor(snapshot.original_url, originalBody) : null,
  };
  const detailsBody = jd.join("\n");
  const target = {
    card_ref: card.card_ref,
    source_ref: jobUrl,
    description_kind: "full_description",
    identity_status: "confirmed",
    capture: { file: "002.capture.txt", sha256: sha(detailsBody) },
    body: detailsBody,
    facts: {
      ...structuredClone(facts),
      seniority: fact(level),
      salary: salary === null ? null : fact(salary),
    },
    input: inputFor(jobUrl, detailsBody, {
      index: 2,
      captureSha256: sha(detailsBody),
      primary: false,
    }),
  };
  return {
    html,
    collectionText,
    sourceSet,
    card,
    snapshot,
    original,
    target,
    inputFor,
    detailsBody,
    observations: details ? [original, target] : [original],
  };
}
