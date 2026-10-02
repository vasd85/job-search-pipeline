# Cutover of the source-key policy from version 1 to 2

Status: **one-time operator procedure**; once executed, it stays as the owner of the rollback.

The decision belongs to [ADR 0013](../adr/0013-versioned-source-keys-and-identity-migration.md),
whose **Implementation status** section records that the code already computes version 2. This
runbook owns only the operator's part: the order, the preconditions and the rollback. The general
cutover procedure into `ops/current` stays with [ops-cutover.md](ops-cutover.md); this file holds
what is added on top of it for source keys specifically.

## 1. What the cutover changes

`source_key` is the normalized form of the immutable `source_ref`. Version 1 stripped eight
parameters, of which `query`, `refid`, `source` and `tab` are how several job boards address a
vacancy. Version 2 strips only `utm_*`, `alternatechannel`, `hhtmfrom`, `trackingid` and `trk`.

After the cutover:

- a new process gets a version 2 key; **an existing process never changes its key** — there is no
  bulk migration, no re-keying and no automatic upgrade;
- two links that differ only in `query`, `refid`, `source` or `tab` are two vacancies, not a
  duplicate. `start` creates a second process instead of returning `status: "duplicate"` and exit 2;
- the duplicate lookup and the `--source-ref` selector compare the **computed** key of both links,
  not the stored one. So a legacy record is found by the link you have in hand but is **not** found
  by the string of its own stored key: if you used to look a process up by the stripped URL, use
  `--id` or `--output-dir`;
- `--duplicate-of` no longer requires the keys to match. A link to a predecessor the cutover
  separated is accepted: that a vacancy is the same across different sources is declared by the
  user, not by the system. There is no refusal here any more, but the signal remains — in that case
  the result of `start` and `link-duplicate` carries `cross_source_duplicate_link` with both keys.
  The refusal `invalid_duplicate_reference` remains for other cases: a missing target, a link to
  itself, a cycle, and an attempt to take a record out of its own group of identical keys;
- `report-source-collisions` does not change: it explains keys produced by version 1 and keeps
  naming `query` as the witness for records that already sit in the ledger under a shared key. But
  the collision warning in `start`/`resolve` now fires only on the four named parameters version 2
  still strips (`alternatechannel`, `hhtmfrom`, `trackingid`, `trk`), plus a difference in the
  fragment — simply because the other links no longer collide. `utm_*` was never and is not part of
  the witness set: two links that differ only in it give `status: "duplicate"` with no collision
  object at all, just as before the cutover;
- canonicality became membership: a record is canonical if its key was produced by **any** accepted
  version. After the cutover the validator does not flag an outdated version 1 key — only the census
  counts it.

## 2. Order

The order cannot be reversed: the read path comes first, the computed version later. Both parts are
already in one release, so they reach `ops/current` in one cutover, and the flip never exists
without the membership check. The census, however, must be read **before** the cutover — it is
read-only and its output does not depend on the membership check, so it runs on the current
operational release.

1. **Census on the real ledger.** In the operational checkout, before any cutover:

   ```sh
   node tools/process-log.mjs report-source-key-split
   ```

   The command writes nothing and exits `0` even when it has something to say. Read: `changed` —
   the records whose key will diverge from the stored one; `split_groups` — the stored keys that
   break into several; `broken_duplicate_links` — the `duplicate_of` links the projection breaks;
   `merges` — must be empty (version 2 strips a strict subset of version 1, so a group can only
   break apart).

   The census does not know whether it is one vacancy: it says that the records will diverge, not
   that separating them is right. `broken_duplicate_link_count: 0` next to a non-empty
   `split_groups` is a reason to look at the group by hand, not a statement that nothing diverged.

2. **Cutover under [ops-cutover.md](ops-cutover.md).** All the usual preconditions apply unchanged:
   no `running` attempt, no prepared publication/recovery journal, `validate --deep` passes, the
   fingerprint record is taken.

   Before the source update, take a manual copy of the ledger — this is the last moment it can
   be taken before the cutover, and [the rollback](#3-rollback) relies on it as a fallback
   rollback point:

   ```sh
   cp -n process-log.json process-log.backup-pre-cutover-<label>.json
   ```

   A plain copy of the file needs no repository command, so it works on any release. Two conditions
   are mandatory, and both exist because `cp` overwrites where `backup-ledger` refuses (`wx`).
   First: the attempt's own label in the name, as with the backup of step 3 — otherwise a second
   cutover attempt overwrites the copy of the first, and with it the only remaining version 1
   rollback point. Second: `-n`, so that a slip in the label cannot do so silently. The name from
   step 3 cannot be reused: that step would fail with `ledger_backup_exists`.

3. **Ledger backup — right after the source update and strictly before the first `start`.**

   ```sh
   node tools/process-log.mjs backup-ledger --backup-file process-log.backup-before-source-key-v2.json
   ```

   The order is exactly this, and it is not a relaxation: the `backup-ledger` command does not
   physically exist on the previous release — it arrives with the cutover, and an attempt to run it
   before the cutover ends in `unknown_command`. The moment is equivalent exactly as long as no
   process has started after the cutover: the cutover changes only the source and rewrites no key,
   so the file holds the same version 1 keys as before it. This is the backup "immediately before
   the computed version changes" that the ADR requires.

   There is no need to take this on faith, and you should not: the command itself answers whether
   **the file it took** is fit to be a rollback point. `backup_readable_by_version_1_code: true` and
   exit `0` — it is. Exit `2` with `status: "backed_up"` means the file is written, but the code
   being rolled back to will no longer read it; `backup_version_1_problem_count` and
   `backup_version_1_problems` say why. The main cause at step 3 is that a process already started
   between steps 2 and 3; the second, rarer one is an import of historical records, which also
   writes keys of the current version.

   Exit `2` here speaks about this file, not about there being no rollback point at all. If the
   manual copy of step 2 was taken, it will do, at the cost of the processes started after it:
   `restore-ledger` accepts any name of the form `process-log.backup-<label>.json` next to the
   ledger, and its review lists exactly what is lost. There is truly no rollback point to the
   previous release only when no such copy was made. The copy itself is not checked by the
   validator and does not pass through the command's payload, so it is a reserve, not a
   replacement for step 3.

   The copy is placed next to the ledger, byte for byte, only if the ledger is valid; an existing
   file is never overwritten — so the backup name is chosen for the specific attempt
   (`process-log.backup-<label>.json`) instead of reusing one name: otherwise a repeated cutover
   after a rollback runs into `ledger_backup_exists`. The backup name is covered by `.gitignore`
   (`/process-log.backup-*.json`) — it does not end up in a commit. Record in the cutover evidence
   `backup_sha256` **and** `backup_readable_by_version_1_code`.

4. **Check after the cutover.**

   ```sh
   node tools/process-log.mjs validate --deep
   node tools/process-log.mjs report-source-key-split
   ```

   `validate --deep` must pass: a mixed ledger with both key versions is exactly what the membership
   check makes loadable. The census after the cutover lists the same legacy records — this is not
   queued work but an honest count of the records left on a version 1 key.

## 3. Rollback

**Rollback here is not a revert of the release.** The one affected artifact is the ledger. As soon
as one record carries a version 2 key, rolling back to code whose canonicality is equality against
version 1 makes that record non-canonical, and a non-canonical record fails the whole file on load.
The order is reversed: stop → restore the ledger from the backup → roll back the code. Rolling back
only the code, leaving a ledger with two key versions, is an unsupported state.

**The order is mandatory.** `restore-ledger` lives in the release that computes version 2 and reads
the ledger through the same validator as every other command. If the code was rolled back first,
the ledger may no longer load, and the old release simply has no restore command: first bring back
the release with version 2, restore the ledger, and only then roll back the code. A manual copy of
the backup over the ledger is the last reserve if even that is impossible.

The backup name below is the one under which it was taken in step 3 of [the order](#2-order) or
copied by hand; the procedure has no single fixed name.

1. **Review.** It changes nothing: the command does not write until it receives a token —
   `--dry-run` only forbids passing the token in the same call. It reads both sides:

   ```sh
   node tools/process-log.mjs restore-ledger --backup-file process-log.backup-<label>.json --dry-run
   ```

   `rollback: "clean"` and exit `0` mean the restore loses nothing and the backup is readable by the
   version 1 code. `rollback: "divergent"` and exit `2` mean the decision is still the operator's;
   the payload lists exactly what is at stake:

   - `dropped_processes` — records missing from the backup. These are processes started after the
     backup was taken; the ADR states plainly that without deleting them this is not a rollback but
     a loss of data;
   - `modified_processes` — records present in both files but different: a step advanced, a
     publication was committed, a company was linked. The rollback winds this back too;
   - `reappearing_processes` — records present in the backup and missing from the ledger;
   - `dropped_companies` / `modified_companies` / `reappearing_companies` — the same for the company
     registry: the ledger holds it too, and the restore replaces the whole file;
   - `changed_root_fields` — fields of the ledger itself that the rollback returns to their previous
     values (`duplicate_policy`, `schema_version`); `updated_at` is not compared, it moves on every
     write;
   - `backup_readable_by_version_1_code: false`, `backup_version_1_problem_count` and the first
     entries of `backup_version_1_problems` — the version 1 code will not read this backup: the
     restore will pass, but the later code rollback will not. Both rules of that code are checked,
     not one: the equality of the stored key with the version 1 key, and the duplicate-group
     invariant on the **stored** key without the relaxation the cutover added. The second rule
     breaks as soon as, after the cutover, `start` creates an unlinked record that shares its
     stored key with a legacy record — even though every key in the file remains a version 1 key.
     The main cause: the backup was taken after a process started under the new version. Step 3 of
     [the order](#2-order) reports this at once, not at the moment the rollback is already needed.

   **Stop on `backup_readable_by_version_1_code: false`.** With such a backup, this procedure goes
   no further: the restore will pass, but step 3 will leave a ledger the previous release cannot
   load at all. There are exactly two options — take another backup whose field is `true` (for
   example the manual copy from step 2 of [the order](#2-order)), or stay on the current release
   and not roll back the code. Restoring the ledger from an unreadable backup makes sense only as a
   separate decision that has nothing to do with rolling back the version, and then step 3 is not
   executed.

2. **Confirm.** The token is bound to the exact bytes of both files; anything that changed between
   the review and the confirmation invalidates it.

   ```sh
   node tools/process-log.mjs restore-ledger --backup-file process-log.backup-<label>.json --confirmation-token <token>
   ```

3. **Code rollback** — an ordinary cutover back to the previous release, only after the ledger is
   restored and only if the review of this backup showed `backup_readable_by_version_1_code: true`.

4. **Check:** `node tools/process-log.mjs validate --deep` on the restored ledger.

What the rollback does not remove: the files under `output/`. The `output/<company-role>`
directories of dropped processes stay on disk in full; the wound-back ones (`modified_processes`)
keep the artifacts and the `.pipeline-tmp` staging of the steps the restored ledger no longer has.
`validate --deep` is silent about the former — the record that pointed to them is gone — and may
show orphan staging for the latter. A repeated `reserve-output` for the same vacancy takes a
neighbouring name rather than adopting the old directory. Sorting this out is a manual operation
after the rollback.

## 4. What closes the acceptance card

The card `R2-01C` named in ADR 0013 requires a "migration dry-run/backup/rollback". There is no separate
migration dry-run here, and there cannot be: the migration is a change of policy, not a rewrite of
keys (no record is re-keyed, rows 11 and 28 of the ADR). Its role is shared by two read-only runs:
`report-source-key-split` — what the policy change will do to the existing ledger (step 1 of
[the order](#2-order)), and `restore-ledger --dry-run` — what the rollback will do (step 1 of
[the rollback](#3-rollback)).

## 5. What this runbook does not cover

- Host-specific rules ("on this board `tab` is decorative") belong to the job-source registry and
  are not decided here. The ADR's constraint binds whoever adds them: a host-specific rule may only
  keep more than the generic policy, never less — otherwise refinement breaks and a group could
  merge, not only break apart.
- How a split looks to a reader of the public reader / web UI is left uncontained in ADR 0013 and
  here too.
- The backup is a copy of the ledger next to the ledger, in the same failure domain. An independent
  backup remains the separate, deliberate boundary of
  the gitflow (in the private pre-switch archive).
