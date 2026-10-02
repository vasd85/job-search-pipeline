# Job-source route fixtures

**Every file in this directory is synthetic. None of them is a captured vendor response.**

They were written by hand to pin this repository's own aggregate-parsing contract — which posting
an aggregate body resolves to, and which bounded outcome that is. They are not evidence about how
Ashby or Pinpoint actually behave, and a green test here never means a live route was verified.

The envelopes imitate the documented response shapes so the parsing contract is exercised against
something realistic. Where a value mirrors a figure recorded by the 2026-07-28 audit — for example
the compensation summary in `ashby-board-compensation.json` — it was retyped from that finding to
keep the regression recognizable; it is still a hand-written fixture, not a recorded response.

`tests/job-source-routes.test.mjs` owns the frozen manifest for this directory: it lists every
file with its SHA-256 and its expected outcomes, compares the list against the directory in both
directions, and fails when a case is present but never exercised. Adding, removing, renaming or
editing a file here requires updating that manifest in the same change.

Live-route verification belongs to the Step 1 release gate; captured, provenance-carrying
fixtures belong to the versioned per-source adapters and to the enumerated harvests declared in
[tools/vacancy-fetch/fixtures/README.md](../../vacancy-fetch/fixtures/README.md).
