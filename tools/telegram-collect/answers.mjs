// The reader's answer, checked against what it was shown. Version 2 adds complete-input source
// roles and disjoint vacancy boundaries; version 1 remains explicitly readable in its own epoch.
//
// An answer is one JSON object: for every post of the batch, by its number, a list of vacancies,
// each naming the line of its title, up to five ways to apply as a closed `via` code with the number
// of the link it points at, and the number of a details link. Numbers and codes only: the reader
// never writes a title, an address or a name, so nothing of a post's text reaches the session
// through the model. A number outside what the post showed, a link of a type the `via` does not
// name, a key this schema does not know - the post is `answer_invalid` with a bounded code, and the
// other posts of the batch stand. A file that is not one object gives every post of the batch
// `file_invalid`; one markdown fence around the object is tolerated and stripped, because a cheap
// model puts one there, and the canon still asks for the object alone.
//
// One number is corrected instead of rejected, and only where the answer cannot be ambiguous: in a
// post that showed a single line, a `title_line` the post does not have is read as that line. The
// corrected numbers of a post come back as `repairs`, so the sweep can print them.

import {
  descriptionKinds,
  excludedRegionsProblem,
  sourceRoles,
} from "../triage-sources/source-set.mjs";

export const answerSchemaVersion = 2;
export const acceptedAnswerSchemaVersions = Object.freeze([1, 2]);
export const applyVias = Object.freeze(["url", "tg", "email", "phone", "dm_author", "unspecified"]);
export const answerCodes = Object.freeze([
  "file_invalid",
  "post_missing",
  "post_duplicate",
  "post_invalid",
]);
export const MAX_ANSWER_BYTES = 64 * 1024;
export const MAX_VACANCIES_PER_POST = 20;
export const MAX_APPLY_PER_VACANCY = 5;

const LINK_TYPE_OF_VIA = Object.freeze({ url: "url", tg: "tg", email: "email" });
const FENCE = /^\s*```[a-z]*\s*\n([\s\S]*?)\n\s*```\s*$/u;

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keysAre = (value, keys) => Object.keys(value).sort().join() === [...keys].sort().join();
const isIndex = (value) => Number.isSafeInteger(value) && value >= 1;

/** Parse the text of one answer file into an object, or null when it is not one object. */
export function parseAnswerText(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_ANSWER_BYTES) return null;
  const fenced = text.match(FENCE);
  let parsed;
  try {
    parsed = JSON.parse(fenced === null ? text : fenced[1]);
  } catch {
    return null;
  }
  return isPlainObject(parsed) ? parsed : null;
}

/**
 * One vacancy record checked against the descriptor of its post. Returns the record as it will be
 * used, with the number the reader named under `repaired` when it had to be corrected, or null when
 * the record is off the schema.
 *
 * There is one correction, and it is made only where the answer cannot be ambiguous. A post that
 * showed a single line has a single place a title can stand in, so a `title_line` the post does not
 * have is read as that line instead of rejecting the record - the reader has been seen to name a
 * number out of nowhere in such a post, and rejecting it threw away a vacancy whose position could
 * not be in doubt. With two shown lines or more the place is not decided, and a number outside the
 * shown ones stays `post_invalid`: a card titled by the wrong line would name another vacancy.
 * Nothing else is corrected - a link number the post does not offer, a link of a type the `via`
 * does not name, a key this schema does not know are rejected as before.
 */
function checkVacancy(vacancy, descriptor) {
  if (!isPlainObject(vacancy) || !keysAre(vacancy, ["title_line", "apply", "details_link"]))
    return null;
  if (!isIndex(vacancy.title_line)) return null;
  const shown = descriptor.shown.includes(vacancy.title_line);
  const onlyLine = descriptor.shown.length === 1 ? descriptor.shown[0] : null;
  if (!shown && onlyLine === null) return null;
  if (!Array.isArray(vacancy.apply) || vacancy.apply.length > MAX_APPLY_PER_VACANCY) return null;
  for (const apply of vacancy.apply) {
    if (!isPlainObject(apply) || !keysAre(apply, ["via", "link"])) return null;
    if (!applyVias.includes(apply.via)) return null;
    const type = LINK_TYPE_OF_VIA[apply.via];
    if (type === undefined) {
      if (apply.link !== null) return null;
      continue;
    }
    if (!isIndex(apply.link) || apply.link > descriptor.links.length) return null;
    if (descriptor.links[apply.link - 1].type !== type) return null;
  }
  if (vacancy.details_link !== null) {
    if (!isIndex(vacancy.details_link) || vacancy.details_link > descriptor.links.length)
      return null;
    if (descriptor.links[vacancy.details_link - 1].type !== "url") return null;
  }
  return shown
    ? { vacancy, repaired: null }
    : { vacancy: { ...vacancy, title_line: onlyLine }, repaired: vacancy.title_line };
}

// Version 2 accepts only complete input. No single-line repair can alter a title anchor in this
// epoch, and each card owns its own disjoint description boundaries.
function checkMappedVacancy(vacancy, descriptor) {
  if (
    !isPlainObject(vacancy) ||
    !keysAre(vacancy, [
      "title_line",
      "start_line",
      "end_line",
      "description_kind",
      "links",
      "apply",
    ]) ||
    descriptor.complete !== true
  )
    return null;
  const line = (n) => isIndex(n) && descriptor.shown.includes(n);
  if (
    ![vacancy.title_line, vacancy.start_line, vacancy.end_line].every(line) ||
    vacancy.start_line > vacancy.title_line ||
    vacancy.title_line > vacancy.end_line ||
    !descriptionKinds.includes(vacancy.description_kind) ||
    !Array.isArray(vacancy.links) ||
    !Array.isArray(vacancy.apply) ||
    vacancy.apply.length > MAX_APPLY_PER_VACANCY
  )
    return null;
  const seen = new Set();
  for (const mapping of vacancy.links) {
    if (
      !isPlainObject(mapping) ||
      !keysAre(mapping, ["anchor", "role"]) ||
      !isIndex(mapping.anchor) ||
      mapping.anchor > descriptor.links.length ||
      seen.has(mapping.anchor) ||
      !sourceRoles.includes(mapping.role) ||
      mapping.role === "original_post"
    )
      return null;
    seen.add(mapping.anchor);
    const anchor = descriptor.links[mapping.anchor - 1];
    if (
      (mapping.role === "contact" && !["tg", "email"].includes(anchor.type)) ||
      (["company_context", "details", "apply"].includes(mapping.role) &&
        !["url", "tg_other"].includes(anchor.type))
    )
      return null;
    if (
      mapping.role !== "company_context" &&
      anchor.line !== null &&
      (anchor.line < vacancy.start_line || anchor.line > vacancy.end_line)
    )
      return null;
  }
  for (const apply of vacancy.apply) {
    if (!isPlainObject(apply) || !keysAre(apply, ["via", "link"]) || !applyVias.includes(apply.via))
      return null;
    const type = LINK_TYPE_OF_VIA[apply.via];
    if (type === undefined) {
      if (apply.link !== null) return null;
      continue;
    }
    if (
      !isIndex(apply.link) ||
      apply.link > descriptor.links.length ||
      descriptor.links[apply.link - 1].type !== type
    )
      return null;
    const mapping = vacancy.links.find((item) => item.anchor === apply.link);
    if (mapping === undefined || mapping.role !== (type === "url" ? "apply" : "contact"))
      return null;
  }
  return { vacancy, repaired: null };
}

function mappingIsComplete(checked, descriptor, excludedRegions) {
  const vacancies = checked.map((item) => item.vacancy).sort((a, b) => a.start_line - b.start_line);
  if (vacancies.some((vacancy, at) => at > 0 && vacancy.start_line <= vacancies[at - 1].end_line))
    return false;
  if (
    excludedRegionsProblem(excludedRegions, {
      lineCount: descriptor.shown.length,
      anchors: descriptor.links.map((link) => ({ ...link, index: link.j })),
      cards: vacancies,
    }) !== null
  )
    return false;
  const excluded = new Set(excludedRegions.flatMap((region) => region.anchors));
  for (const link of descriptor.links) {
    const roles = vacancies.flatMap((vacancy) =>
      vacancy.links.filter((mapping) => mapping.anchor === link.j).map((mapping) => mapping.role),
    );
    if (roles.length === 0 && vacancies.length > 0 && !excluded.has(link.j)) return false;
    if (roles.length > 1 && roles.some((role) => role !== "company_context")) return false;
  }
  return true;
}

/**
 * Check one answer object against its batch. Returns a Map of post number to
 * `{ kind: "vacancy", vacancies }`, `{ kind: "none" }` or `{ kind: "invalid", code }`, plus the
 * count of stray post numbers the answer named and the batch does not know.
 */
export function checkAnswer(answer, batch) {
  const results = new Map();
  const invalid = (code) => ({ kind: "invalid", code });
  const allInvalid = (code) => {
    for (const post of batch.posts) results.set(post.post, invalid(code));
    return { results, stray: 0 };
  };
  if (
    answer === null ||
    !keysAre(answer, ["schema_version", "batch", "posts"]) ||
    !acceptedAnswerSchemaVersions.includes(answer.schema_version) ||
    answer.schema_version !== (batch.schema_version ?? 1) ||
    answer.batch !== batch.name ||
    !Array.isArray(answer.posts)
  ) {
    return allInvalid("file_invalid");
  }
  const byNumber = new Map(batch.posts.map((post) => [post.post, post]));
  const seen = new Map();
  let stray = 0;
  for (const entry of answer.posts) {
    const number = isPlainObject(entry) && isIndex(entry.post) ? entry.post : null;
    if (number === null || !byNumber.has(number)) {
      stray += 1;
      continue;
    }
    seen.set(number, (seen.get(number) ?? 0) + 1);
    if (seen.get(number) > 1) {
      results.set(number, invalid("post_duplicate"));
      continue;
    }
    const descriptor = byNumber.get(number);
    const postKeys = ["post", "vacancies"];
    const hasExclusions = answer.schema_version === 2 && Object.hasOwn(entry, "excluded_regions");
    if (hasExclusions) postKeys.push("excluded_regions");
    const excludedRegions = hasExclusions ? entry.excluded_regions : [];
    const checked =
      !keysAre(entry, postKeys) ||
      !Array.isArray(entry.vacancies) ||
      entry.vacancies.length > MAX_VACANCIES_PER_POST
        ? null
        : entry.vacancies.map((vacancy) =>
            answer.schema_version === 1
              ? checkVacancy(vacancy, descriptor)
              : checkMappedVacancy(vacancy, descriptor),
          );
    if (
      checked === null ||
      checked.includes(null) ||
      (answer.schema_version === 2 && !mappingIsComplete(checked, descriptor, excludedRegions))
    ) {
      results.set(number, invalid("post_invalid"));
      continue;
    }
    results.set(
      number,
      checked.length === 0
        ? { kind: "none" }
        : {
            kind: "vacancy",
            vacancies: checked.map((item) => item.vacancy),
            repairs: checked.filter((item) => item.repaired !== null).map((item) => item.repaired),
            ...(excludedRegions.length > 0 ? { excluded_regions: excludedRegions } : {}),
          },
    );
  }
  for (const post of batch.posts)
    if (!results.has(post.post)) results.set(post.post, invalid("post_missing"));
  return { results, stray };
}
