function source(id, category, domainFamilies) {
  return Object.freeze({
    id,
    category,
    domainFamilies: Object.freeze([...domainFamilies]),
    employerDomainExcluded: true,
  });
}

export const jobSourceRegistry = Object.freeze([
  source("ashby", "ats", ["ashbyhq.com"]),
  source("bamboohr", "ats", ["bamboohr.com"]),
  source("breezy", "ats", ["breezy.hr"]),
  source("google_docs", "document_share", ["docs.google.com"]),
  source("greenhouse", "ats", ["greenhouse.io"]),
  source("hirechain", "recruiter", ["hirechain.io"]),
  source("hh_ru", "job_board", ["hh.ru"]),
  source("huntflow", "ats", ["huntflow.io"]),
  source("icims", "ats", ["icims.com"]),
  source("jobvite", "ats", ["jobvite.com"]),
  source("keka", "ats", ["keka.com"]),
  source("lever", "ats", ["lever.co"]),
  source("linkedin", "job_board", ["linkedin.com"]),
  source("workday", "ats", ["myworkdayjobs.com"]),
  source("pinpoint", "ats", ["pinpointhq.com"]),
  source("recruitee", "ats", ["recruitee.com"]),
  source("smartrecruiters", "ats", ["smartrecruiters.com"]),
  source("taleo", "ats", ["taleo.net"]),
  source("workable", "ats", ["workable.com"]),
]);

function parseHostname(value) {
  const raw = String(value ?? "").trim();
  if (!raw || /\s/.test(raw)) return null;
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
    return hostname.includes(".") ? hostname : null;
  } catch {
    return null;
  }
}

function hostnameBelongsToFamily(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function detectJobSource(value) {
  const hostname = parseHostname(value);
  if (hostname === null) return null;
  return (
    jobSourceRegistry.find((candidate) =>
      candidate.domainFamilies.some((domain) => hostnameBelongsToFamily(hostname, domain)),
    ) ?? null
  );
}

export function isEmployerDomainExcluded(value) {
  return detectJobSource(value)?.employerDomainExcluded === true;
}
