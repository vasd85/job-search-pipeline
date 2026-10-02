# Vacancy-fetch adapter fixtures

**Every file in this directory is synthetic, except the enumerated provenance-stamped harvests
below.** A synthetic file was written by hand and is not a captured vendor response; a harvest
carries real captured bytes and says so here, with its source URL, capture date, and digest.

The synthetic files pin this repository's own extraction and classification contract:
which visible text one document yields, which structural checks hold, and which bounded outcome
the observation resolves to. They are not evidence about how LinkedIn or any career page actually
behaves, and a green test here never means a live route was verified.

Where a synthetic file imitates a documented or audit-observed shape — the LinkedIn guest
fragment's `description__text` / `show-more-less-html__markup` containers, a Cloudflare
interstitial's wording — the shape was retyped so the parsing contract is exercised against
something realistic. It is still a hand-written fixture.

## Provenance-stamped harvests

Real captured material enters this directory only through this list (task 51, user decision of
2026-09-01). A harvest pins a dated observation of one real page; it is still not live-route
verification.

- `capture-rollout-2026-08-014-adapter.txt` and `capture-rollout-2026-08-014-browser.txt` —
  verbatim capture files of record 14 of batch `rollout-2026-08` (2026-08-24): the
  `generic-html@1` capture whose body silently misses the "We offer/Benefits" and
  equal-opportunity blocks, and the browser counter-capture of the same page that carries them.
  Each file's own stamped header holds the source URL and digests;
  `verifyCaptureFile` re-proves both.
- `generic-spa-deferred.html` — derived 2026-09-01 from the live response of the republished
  posting `https://careers.epam.com/en/vacancy/senior-automation-tester-in-js-blt6zeehgwcudsv59kv_en`
  (full response: 455 558 chars, sha256
  `19aab877bec3a7ca547fb4d35355dc07068fa041ea024296777ac049a7e77308`). Reduction rule: the real
  `<main>` subtree verbatim; the real `__NEXT_DATA__` island reduced to `job.benefits`,
  `job.disclaimers`, `staticData.configurator` (the location-keyed catalog carrying
  "We offer/Benefits") and a prose-ranked subset of `commonCmsProps`; minimal synthetic chrome.
  The generic adapter extracts from it the byte-identical body of the rehearsal capture
  (normalized sha256 `b6d524db…`), so the silent-partial reproduction is replayable offline.

`tests/vacancy-fetch.test.mjs` owns the frozen manifest for this directory: it lists every file
with its SHA-256 and its expected reading, compares the list against the directory in both
directions, and fails when a case is present but never exercised. Adding, removing, renaming or
editing a file here requires updating that manifest in the same change.

## What each file is for

| File | Exercised as |
| --- | --- |
| `linkedin-guest-active.html` | 200 with a description container and the requested job id |
| `linkedin-guest-closed.html` | 200 with a first-party closure banner |
| `linkedin-guest-wrong-job.html` | 200 whose body carries a different job id — the identity guard |
| `linkedin-guest-no-container.html` | 200 whose description container is gone — the degraded-adapter tripwire |
| `linkedin-guest-authwall.html` | a wall body, served on an `/authwall` final URL |
| `linkedin-guest-anti-bot.html` | a challenge body, served under LinkedIn's `999` status |
| `generic-main-active.html` | `<main>` container, page chrome and `<script>`/`<style>` dropped |
| `generic-article-longest.html` | two `<article>` candidates; the longest wins |
| `generic-no-semantic.html` | no semantic container; body fallback with chrome dropped |
| `generic-thin.html` | below the shared minimum-content floor |
| `generic-anti-bot.html` | a challenge interstitial detected from bounded markers |
| `generic-linkedin-login-localized.html` | a LinkedIn sign-in form in Dutch with no English marker, served on a `/uas/login` final URL — the wall is read from the final URL, not the language |
| `generic-hostile.html` | prompt-injection prose, shell metacharacters, entities including an unpaired-surrogate reference, an unclosed paragraph, a stray close tag, a bare `<`, raw-text and `noscript` subtrees |
| `generic-json-body.json` | a JSON route body, refused by content type rather than parsed as markup |
| `generic-spa-deferred.html` | partial server render beside a typed JSON island carrying the deferred blocks — the deferred-content signal fires |
| `generic-spa-mirror.html` | complete render whose typed island mirrors it (≈ 1×) — the signal must not fire |
| `generic-bundle-heavy.html` | complete render beside a large non-JSON code bundle — byte mass alone must not fire |
| `generic-json-malformed.html` | a typed island that fails to parse — the fact is recorded, nothing fires |
| `capture-rollout-2026-08-014-adapter.txt` | the silent partial capture of the reproduction, verbatim (harvest) |
| `capture-rollout-2026-08-014-browser.txt` | the browser counter-capture of the same page, verbatim (harvest) |

The hostile fixture is the one to read before changing the extractor. Its injected instructions
and its `$(touch marker)` string must survive into the extracted text **as data**: this layer
preserves untrusted content verbatim and never obeys it, and the string never reaches shell
program text because no vacancy value is ever assembled into a command.

Live-route verification is not this directory's job. The only live comparison this repository has
is the measured run of
[docs/runbooks/vacancy-fetch-experiment.md](../../../docs/runbooks/vacancy-fetch-experiment.md),
and no gate reaches a live page.
