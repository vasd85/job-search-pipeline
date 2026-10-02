# ADR 0023: Publish the engine, keep the candidate in a private layer

- **Status:** Accepted
- **Date:** 2026-09-21
- **Decision authority:** explicit user decisions, chat session of 2026-09-21, taken while
  preparing the project for publication on GitHub
- **Carried out by:** backlog epic 146 and its tasks 148-167
- **Task numbers:** the task ids below name records of this project's private predecessor backlog,
  which is not published. They are history, not pointers.

The seven decisions below were spoken in Russian and are quoted verbatim in the decisions section
of epic 146. That file stays behind: tasks do not cross to the new repository
(decision 2), so the verbatim record ends with the old history and this English record is what
survives. Each decision is therefore stated here in full rather than by reference.

## Context

The repository holds two things that are not the same product. One is an engine: a scoring
rubric, a triage pipeline, a CV builder, a cover-letter generator, the instruction corpus that
drives them and the development process that maintains all of it. The other is one person — a
profile, stories, pay floors, countries, a working language, a letter archive, a job-search
history. The engine is worth publishing. The person is not.

The two are not separable today. Candidate facts sit inside the rules rather than beside them:
the vacancy languages and the market set, the residence countries and the relocation scores, the
compensation thresholds, the signature lines and the letter's length are all literals in
validator and scorer code; fourteen code and test files reach the profile by its path; one
generation rule bans naming the project by tying that ban to the project being private, and a
second such ban lives only in `memory.md`, where no check can see it.

The history is less separable still. Every commit carries one author address, a home path
appears in 96 tracked files, and for two and a half weeks the operational process log — with its
company registry and its application records — was tracked in git. Language is the third
obstacle: all eleven runbooks, most of two playbooks, and roughly a thousand lines of code and
tests are Russian, and several rules require Russian by name.

The question the user answered was how to publish the engine without leaking the person, without
maintaining two repositories in parallel until then, and without the published rules quietly
continuing to describe one candidate.

## Decision

Seven decisions. This record states what was decided and why; it describes no procedure, and for
each decision it names the task that carries the acting half.

1. **The work stays in one repository, and publication is an export without history.** The
   repositories are not split now. When the project is ready, it is published without its git
   history; at that moment the working tree switches to the new repository and history starts
   from zero. — Acting half: **task 167**, which builds the export and the move runbook.

2. **Tasks do not move to the new repository.** How tasks are documented after the move is a
   separate question, answered when the flow is rebuilt rather than here. — Acting half:
   **task 161**, which owns the task flow of a public repository and puts the files-versus-Issues
   question to the user at its start-confirmation gate. Open tasks of the old backlog are not
   migrated; the ones still wanted are refiled in English, continuing the numbering.

3. **No license for now.** The license is a later decision of the user's, deliberately deferred
   rather than defaulted. — Acting half: **task 167**, whose first commit of the new history
   ships no license file, and **task 166**, whose README states the status. Until that decision,
   outside pull requests are not accepted.

4. **Public documents are written in English, and private documents carry English section
   names.** The second half is not stylistic: public documents point at sections of private ones,
   so those sections need stable English names — which in turn means the private documents need a
   canonical structure rather than free-form prose. — Acting half, English: **tasks 159**
   (runbooks), **160** (project documents, decision records, audits), **162** (canon after
   restructuring), **163** (web interface, tool READMEs, code comments) and **166** (README).
   Acting half, canonical structure: **task 152** (a numbered profile section map), **154** (the
   format of candidate prose rules) and **157** (the format of a language pack).

5. **Values that today stand inside the rules move into a candidate config.** The length of the
   cover letter is the example the user gave; the rule names a key, the config holds the number.
   — Acting half: **task 149**, which builds the config, its schema and its loader, and
   **task 156**, which moves the named values into keys.

6. **English is the default language; further languages come from the config; no rule names
   Russian.** The engine knows one language by name — its default. Everything language-specific
   beyond it lives in a configured pack. — Acting half: **task 157**, which derives the language
   enum from the config and defines the packs, and **task 150**, which puts runtime messages and
   diagnostics in the default language.

7. **Public rules are general; everything tied to this candidate's profile and preferences is
   supplied privately.** A rule in the public tree may state a mechanism and a key, never a
   person's fact or preference. — Acting half: **task 149** (the layer itself: an ignored
   `candidate/` beside a tracked example), **152** (profile, stories and samples as candidate
   data), **153** (markets and time zone), **154** (prose rules), **155** (machine-checkable
   constraints), **156** (values) and **158** (project disclosure keyed on a visibility field).
   **Task 148** inventories what else in the tree depends on the candidate.

## What this record does not decide

The shape of the private layer is not decided here. That the layer is a `candidate/` directory
with its own repository and private remote, that personal content splits into three kinds with
three different checks, that markets and time zone need a schema migration rather than a config
key, and that tasks after the move stay files — all of these are working hypotheses of epic 146,
binding on nobody. Each is confirmed or discarded inside the task that would rely on it, at its
start-confirmation gate. A hypothesis that is overturned does not reopen a decision above; the
decisions constrain the outcome, not the design.

## Consequences

- (+) The engine becomes publishable at all. Today no commit of this repository could be shown to
  anyone: the tree names the candidate and the history names him in every commit.
- (−) Publication costs the history. A new repository with a single first commit loses the record
  of how every rule in it came to be — the audits, the measurements and the review rounds behind
  them. The decision records are the part deliberately kept, which is why this one is written to
  stand without the epic that produced it.
- (−) Every pointer into the backlog dies at the move, and there are many: seventeen public files
  reference task or archive paths, and forty mention a task number. Whatever still needs saying
  after the move has to be said in a file that crosses over.
- (+) Generality stops being a matter of intent and becomes a matter of the test suite. The
  example candidate is fictional and is what continuous integration runs on, so a rule that still
  assumes the real person turns a check red instead of passing unnoticed.
- (−) The separation is not one change but a long one: twenty tasks in six waves, whose longest
  dependency chain is 147, 149, 155, 157, 162, 166, 167. Until it finishes, the rules are in a
  half-moved state, and every task in it competes with ordinary pipeline work.
- (−) After the move the operational checkout is the only place holding both halves — the public
  engine and the private candidate layer — so a backup that covers only one of them covers
  nothing that matters. Task 151 carries that consequence.
- (+) A side effect worth naming: two bans that today live where no check can reach them — one in
  `memory.md`, one written into a generation rule as prose — become typed constraints of the
  candidate layer, which a validator can enforce.
