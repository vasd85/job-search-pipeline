# tools/setup

Two setups that are otherwise only prose: the public repository on GitHub, and a new machine. Both
scripts derive or read everything they act on, run external programs as argument lists without a
shell, and change nothing on a second run.

## The GitHub repository

```sh
npm run setup:github -- --repo <owner>/<name> [--check]
```

The declared settings live in [config/github/](../../config/github/), one file per API call, each
file exactly the body of that call:

| File                        | Call                                                                                                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repository.json`           | `PATCH repos/{repo}` — merge commits only, no auto-merge, branches deleted after merge, the merge commit titled by GitHub's default and carrying the pull request's title, no issues, wiki or discussions                                                  |
| `fork-pr-approval.json`     | `PUT repos/{repo}/actions/permissions/fork-pr-contributor-approval` — every outside contributor's workflow run waits for approval                                                                                                                          |
| `ruleset-main.json`         | a branch ruleset on the default branch: a pull request is required with no approvals and the merge-commit method only; the check `gate` of the GitHub Actions app must pass on a branch that is up to date; no deletion, no force push; nobody bypasses it |
| `ruleset-release-tags.json` | a tag ruleset on `release-*`: a release tag cannot be deleted or moved; creating one stays open                                                                                                                                                            |

The ruleset carries no linear-history rule: that rule forbids merge commits.

The script reads the repository first and refuses a private one before any write. It then writes
only what differs: the fields of the repository that differ, the approval policy, and each ruleset
— matched by its `name` — created when missing or replaced whole when the current one does not
cover the declared one. A ruleset covers the declared one when every declared value is present;
keys the server adds are ignored, and a rule added by hand in the web interface is a difference.
`--check` only reads, prints the differences and exits 1 when there are any.

The check context `gate` is the id of the one job in `.github/workflows/ci.yml`, which has no
`name:` of its own; `tests/setup-github.test.mjs` holds the two together.

## A new machine

Prerequisites the script does not install: Node and npm at the versions `package.json` pins,
`unzip`, LibreOffice (`soffice`) and poppler (`pdfinfo`, `pdftoppm`) — the machine check refuses
without them — and git credentials that can read the private repository, for instance through
`gh auth login` and `gh auth setup-git`.

1. Clone the engine. This is the one step before the script, because the script lives in it:

   ```sh
   git clone https://github.com/<owner>/<engine> engine
   cd engine
   ```

2. Run the setup, naming the private repository once:

   ```sh
   npm run setup:machine -- --private <private repository URL>
   ```

   On the machine that hosts the operational folder, add `--operational` once that folder exists
   beside the engine as `job-search-pipeline`.

The script does, in order, skipping whatever is already done:

- refuses unless the engine is a primary clone — a linked working copy or the operational folder
  is not one;
- clones the private repository into the engine's `candidate` directory, which the engine ignores;
  a directory already there must be a repository of its own, with the named URL as its origin;
- installs the dependencies with the two `npm ci` commands the CI workflow uses;
- points `core.hooksPath` at this clone's `tools/git-hooks`, which installs both hooks there: the
  pre-push guard ([tools/push-guard](../push-guard/README.md)) and the pre-commit check that
  refuses a commit whose staged content has a whitespace error;
- with `--operational`: renders the templates in the `machine` directory of the private layer
  into their targets, creates the backup destination, and registers the backup LaunchAgent with
  launchd unless launchd already knows it;
- checks the machine: the toolchain, the private layer, the hook path — and with `--operational`
  both targets, the registered agent and the operational folder's own `npm run preflight`. The
  run is green only when all of these are.

`--check` runs only the last step.

No path is typed. The engine root is where the script lies, the private repository is its
`candidate` directory, and the operational folder is `job-search-pipeline` in the same parent
directory as the engine.

### Templates

The layer supplies the text; the engine fixes where each one lands. A layer cannot direct a write
anywhere else.

| Template in the layer's `machine` directory | Target                                                        |
| ------------------------------------------- | ------------------------------------------------------------- |
| `settings.local.json`                       | `.claude/settings.local.json` of the operational folder       |
| `backup.plist`                              | `~/Library/LaunchAgents/com.job-search-pipeline.backup.plist` |

A template may name four placeholders: `{{node}}` (the running Node), `{{home}}`,
`{{operational_root}}` and `{{backup_root}}` (`~/Backups/job-search-pipeline`). An unknown
placeholder is refused, and so is a value that would need escaping in XML or JSON. A target that
already exists with other content is refused and left as it is; nothing is overwritten.

The example layer carries both templates. Rendered, its plist is byte for byte what
`node tools/operational-backup.mjs print-plist` prints for the same paths
([docs/runbooks/operational-backup.md](../../docs/runbooks/operational-backup.md)). Its settings
turn the sandbox off, because the CV render hangs under it
([ops-cutover](../../docs/runbooks/ops-cutover.md)). A development clone gets no local settings:
the tracked ones keep its sandbox on.

## Refusal codes

GitHub: `github_settings_invalid_arguments`, `github_settings_config_invalid`,
`github_settings_gh_failed`, `github_settings_repository_not_public`,
`github_settings_ruleset_ambiguous`, `github_settings_failed`.

Machine: `setup_machine_invalid_arguments`, `setup_machine_engine_not_a_clone`,
`setup_machine_private_url_missing`, `setup_machine_private_not_a_clone`,
`setup_machine_private_remote_mismatch`, `setup_machine_private_not_ignored`,
`setup_machine_git_failed`, `setup_machine_install_failed`, `setup_machine_hooks_path_unset`,
`setup_machine_operational_missing`, `setup_machine_operational_is_a_checkout`,
`setup_machine_path_unsafe`, `setup_machine_template_missing`,
`setup_machine_template_placeholder_unknown`, `setup_machine_template_invalid`,
`setup_machine_target_differs`, `setup_machine_target_missing`, `setup_machine_launchctl_failed`,
`setup_machine_launch_agent_missing`, `setup_machine_operational_preflight_failed`,
`setup_machine_failed`. The toolchain and the layer refuse with their own codes.

Both lists are frozen against the source by `tests/setup-github.test.mjs` and
`tests/setup-machine.test.mjs`.
