# ADR 0025: Markets and the presented location are candidate configuration

- **Status:** Accepted; the migration decision 4 owes was carried out on 2026-09-29, and the readers
  of the earlier versions are dropped
- **Date:** 2026-09-24
- **Decision authority:** explicit user decisions of 2026-09-24, taken while planning backlog task
  153 of epic 146 and at its start gate, under decision 7 of
  [ADR 0023](0023-public-engine-and-private-candidate-layer.md)
- **Supersedes:** ADR 0004, ADR 0016 and ADR 0020 — as rules of the engine; each recorded what one
  candidate's materials state, and that choice is now a value of that candidate's configuration.
  None of the three is published, so they are named here without a link.
- **Amends:** [ADR 0012](0012-versioned-extraction-and-vacancy-v2.md) — version 2 of `vacancy.json`
  is taken below; the delta that record describes lands under the next free version
- **Carried out by:** backlog task 153
- **Task numbers:** the task ids here name records of a backlog that is not published. They are
  history, not pointers.

## Context

The engine divided the world into two markets named after one candidate's country, printed that
candidate's location and time offsets in its generation rules, and wrote the two market words into
the schemas of the vacancy and the brief. Three decision records fixed what those rules state for
that person: a timezone presented without a city, then a location with its offset for every role
abroad, then the same location unconditionally, with a pending move never disclosed.

Decision 7 of ADR 0023 makes a public rule state a mechanism and a key, never a person's fact or
preference. Here the mechanism is small. For the steps from a vacancy to its materials, a market
decides exactly two things: whether a material states positioning at all, and whether the
company's contractor and payment logistics are researched. Both depend on one question — is the
role on the candidate's home market or outside it.

## Decision

1. **Two markets, named by the candidate.** The engine knows the home market and the market outside
   it, and nothing else about either. The candidate config names both, lists the home countries
   that make a vacancy's market the home one, and a vacancy is classified against that list.
2. **What a material states is configuration.** The config sets the timezone a material names on
   the home market, and the location and the timezone it names for every role outside it. The
   generation rules name these keys; they name no country and no offset.
3. **The framing is the candidate's own rule.** How the candidate's engagement is described outside
   the home market, and what a material keeps silent about the candidate's own circumstances, are
   rules of the candidate layer, read by the steps that map experience and write the materials.
   The engine keeps only the mechanism: the configured location with its configured timezone, and
   never a location paired with an offset it does not have.
4. **The market is versioned in the artifacts.** `vacancy.json` version 2 and
   `application-brief.json` version 4 carry one of the two configured names. The earlier versions
   carry their two fixed words and stay readable under their own contract until the operational
   files are migrated and those readers are dropped; a publication writes only the new versions.
   `company-research.json` version 2 names the version of the vacancy it was written over, as the
   brief already did for the research. A version 4 brief may be built over a version 1 vacancy when
   the vacancy's word is itself a configured name on the same side, so a layer that keeps the old
   words as its names carries its open processes across the change without repeating Step 1.
5. **A market name is permanent once used.** The config is not a pinned input of a process; every
   check reads it afresh. A renamed market, or two names swapped between the sides, turns every
   recorded artifact that named it into a corrupt one — the same property a removed language has.

## What this record does not decide

The job scorer and its rubric keep a home geography of their own — a home region, a timezone band
measured from the home offset, engagement paths named after countries, and the rate source of the
home currency. Moving them into the configuration changes the scoring policy and is decided by the
task that also moves the scorer's values, not here.

## Consequences

- (+) A public rule no longer describes one person's location, and a second candidate gets the same
  mechanism with its own markets and its own presentation.
- (+) Two decisions that were taken for one person's situation — the unconditional location and the
  silence about a pending move — now live where that person keeps them, beside the framing they
  belong to.
- (−) A migration is owed: the recorded vacancies and briefs of the old versions stay in the ledger
  until a task rewrites them and removes the old readers, which are the last place the two old
  words live in the engine.
- (−) A checkout whose layer lacks the new keys cannot run a step, and a rollback past the first
  publication of the new versions needs the ledger, the output and the layer from one snapshot.
- (−) The configured location is taken as given. Nothing checks it against the profile; the
  candidate owns both files and keeps them consistent.
