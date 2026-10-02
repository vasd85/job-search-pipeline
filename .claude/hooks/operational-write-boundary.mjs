/**
 * Development-environment write boundary for file tools.
 *
 * The Bash sandbox configured in `.claude/settings.json` is the authoritative
 * boundary, but it binds one channel: Bash and its child processes. File tools
 * run inside the agent and pass straight through it. This hook closes exactly
 * that gap and nothing else — it is the second layer over an OS mechanism, the
 * only blocking-hook class the remediation protocol permits, and it is never a
 * guarantee on its own.
 *
 * Two rules run here, and both are derived from the repository topology rather
 * than from what a session believes it is doing — the first from the worktree
 * the target belongs to, the second from that worktree and from the one the
 * session lives in:
 *
 * - A session may write into a primary worktree only from inside that same
 *   primary worktree. The real ledger and `output/` live in one, so this is
 *   what keeps a development session out of operational state.
 * - A rehearsal worktree — a linked worktree on a `rehearsal/` branch, where
 *   runs against real vacancy URLs happen — is the private state of the run
 *   session living in it. Nothing writes into it from outside, and that session
 *   writes nothing outside it.
 *
 * Eight decisions are deliberate:
 *
 * - **Deny is exit code 2 with the reason on standard error and nothing on
 *   standard output.** Exit 2 blocks the tool call regardless of payload, so the
 *   boundary does not depend on the stdout schema-validation behaviour of any
 *   one runtime version.
 * - **It fails closed.** An unreadable payload, a missing target, an
 *   unresolvable repository topology or a head that names no branch denies and
 *   says which one it was. A write boundary that evaporates on a transient
 *   error is the guard this replaces.
 * - **The operational root is derived, never written down.** It is the primary
 *   worktree of the write target, and the session is exempt only when it lives
 *   inside that same primary worktree. Deriving it from the target rather than
 *   from the session closes the case where the session is itself a primary
 *   checkout — a fresh clone or a scratch repository — which would otherwise be
 *   exempt from every operational tree on the machine. No machine-specific path
 *   enters the tracked settings.
 * - **The rehearsal rule reads the branch name and nothing else.**
 *   `.rehearsal/base.json` marks such a tree for humans and for
 *   `tools/workspace-reset.mjs`, but any session can write that file: it is a
 *   name, not authentication. The prefix test here is deliberately broader than
 *   the label validation in that tool — a malformed label must not become a
 *   tree this guard stops recognising.
 * - **A detached head fails closed.** It names no branch, so nothing about it
 *   rules out a rehearsal tree sitting at its pinned base, and a rule that read
 *   the empty string as "not a rehearsal branch" would hand out that bypass to
 *   anyone who checks one out. The price is paid in full and is worth stating:
 *   the session's branch is read before either rule, so a detached session
 *   meets this refusal for every target outside its own tree — including the
 *   ones those rules would have allowed. A detached rehearsal tree is
 *   indistinguishable from any other detached checkout, and that is the whole
 *   reason.
 * - **A session's own worktree is answered before any branch is read.** Writing
 *   inside the tree you live in is always allowed, which keeps the previous
 *   decision from denying the very edits that resolve a rebase — a rebase runs
 *   on a detached head.
 * - **A run session gets no scratch exception.** Targets in no repository stay
 *   allowed for a development session whose head names a branch, and are denied
 *   for a rehearsal one: the
 *   deletion procedure of the runbook destroys exactly one directory, the tree,
 *   and everything a run produces carries real vacancy URLs. A file outside the
 *   tree would outlive the procedure that is supposed to erase it.
 * - **The candidate layer of a development worktree is the one named exception
 *   to the first rule.** The layer the user edits lives as a repository of its
 *   own in `candidate` at the root of the development worktree, and a
 *   repository with its own `.git` is a primary worktree to this guard. A
 *   session living in a linked worktree may write into the repository whose
 *   root is exactly that directory of its own tree — nothing deeper, nothing
 *   under another name, and nothing a session in any other tree may reach.
 *   The directory is compared as spelled and the target's root as resolved, so
 *   a link called `candidate` that points anywhere else is judged by where it
 *   lands. A primary session gets no such exception: that is where an
 *   operational checkout lives, or a scratch clone that happens to contain one.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GIT_TIMEOUT_MS = 5_000;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

export const REHEARSAL_BRANCH_PREFIX = "rehearsal/";

// The directory the candidate layer occupies at a worktree's root; the same name
// `tools/candidate/load.mjs` resolves the layer by. Written here rather than
// imported, because a guard that cannot start lets every write through.
export const CANDIDATE_DIRECTORY = "candidate";

// Every variable that can point git at another repository, or stop its upward
// search early. Left in place, any of them turns this guard's answer into
// something the caller chose.
const GIT_REDIRECTION_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
];

export class BoundaryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BoundaryError";
    this.code = code;
  }
}

/**
 * Resolves symlinks on the deepest existing ancestor and re-attaches the part
 * that does not exist yet, so a `Write` to a new file is judged by the real
 * directory it would land in. `realpathSync.native` also returns the on-disk
 * spelling, which is what makes the comparison correct on a case-insensitive
 * filesystem.
 */
export function resolveExistingPath(target) {
  let current = resolve(target);
  const missing = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.slice().reverse());
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        throw new BoundaryError("path_unresolvable", `${target}: ${error?.code ?? "unknown error"}`);
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new BoundaryError("path_unresolvable", `${target}: no existing ancestor`);
      }
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Containment on segment boundaries. A bare prefix test is wrong here: the
 * development container is a literal prefix sibling of the operational root, so
 * `<root>-worktrees/tasks/x` starts with `<root>` and would deny every edit in
 * every development worktree.
 */
export function isInside(root, target) {
  if (target === root) return true;
  const step = relative(root, target);
  return step !== "" && !step.startsWith("..") && !isAbsolute(step);
}

export function gitEnvironment(environment = process.env) {
  const child = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || GIT_REDIRECTION_VARIABLES.includes(key)) continue;
    child[key] = value;
  }
  return child;
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(),
    shell: false,
    timeout: GIT_TIMEOUT_MS,
  });
  if (result.error) {
    throw new BoundaryError("git_unavailable", result.error.code ?? "git did not run");
  }
  if (result.signal) {
    throw new BoundaryError("git_signalled", `git terminated on ${result.signal}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "").split("\n")[0].trim();
    throw new BoundaryError("git_failed", `git exited with ${result.status}: ${detail}`);
  }
  return String(result.stdout ?? "");
}

function nearestExistingDirectory(path) {
  let current = path;
  for (;;) {
    try {
      if (statSync(current).isDirectory()) return current;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        throw new BoundaryError("path_unresolvable", `${path}: ${error?.code ?? "unknown error"}`);
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new BoundaryError("path_unresolvable", `${path}: no existing directory above it`);
    }
    current = parent;
  }
}

function repositoryMarkerAbove(directory) {
  let current = directory;
  for (;;) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * The worktree a resolved path belongs to: the directory git was asked from, the
 * git directory that identifies the checkout, its own root, the primary worktree
 * of the same repository, and whether this is a checkout of its own. `null`
 * means the path is outside every repository — the one negative answer that is
 * safe to allow, because a path in no repository cannot be an operational
 * checkout. That answer comes from the filesystem, not from a failure message:
 * git reports a broken gitdir link with the same words it uses for a path in no
 * repository, and only one of those two is safe to allow.
 *
 * Whether the path sits in a checkout of its own is asked of git rather than
 * derived from where the path is. Git allows a linked worktree inside the
 * primary one, and a checkout whose git directory was moved aside reports the
 * same directory as both its own and the common one while its files live
 * somewhere else entirely. In either layout the cheaper containment test names
 * the wrong tree, and the branch this guard then reads is the wrong branch —
 * which is the bypass the rehearsal rule exists to close.
 *
 * The second call is skipped for a path inside its own primary worktree, which
 * is the common case and the one where the answer cannot be anything else. That
 * is also what keeps a target under a `.git` directory answered as it was: there
 * is no work tree to report there, and asking would only fail.
 */
export function worktreeOf(resolved, git = runGit) {
  const directory = nearestExistingDirectory(resolved);
  if (!repositoryMarkerAbove(directory)) return null;
  const [gitDir, commonDir] = git(directory, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
  ]).split("\n").map((line) => line.trim());
  if (!commonDir || !isAbsolute(commonDir) || !gitDir || !isAbsolute(gitDir)) {
    throw new BoundaryError("git_common_dir_unresolved", "git did not report an absolute common directory");
  }
  if (basename(commonDir) !== ".git") {
    throw new BoundaryError("unexpected_git_layout", `common directory is ${basename(commonDir)}`);
  }
  const primary = resolveExistingPath(dirname(commonDir));
  const identity = resolveExistingPath(gitDir);
  if (gitDir === commonDir && isInside(primary, resolved)) {
    return { context: directory, gitDir: identity, linked: false, primary, root: primary };
  }
  const topLevel = git(directory, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
  ]).trim();
  if (!topLevel || !isAbsolute(topLevel)) {
    throw new BoundaryError("worktree_root_unresolved", "git did not report an absolute worktree root");
  }
  const root = resolveExistingPath(topLevel);
  if (!isInside(root, resolved)) {
    throw new BoundaryError("worktree_root_unrelated", `${root} does not contain ${resolved}`);
  }
  // Not "different from the primary": a worktree whose `core.worktree` points
  // back at the primary reports the primary's own root here, and is still a
  // checkout of its own. That is why `root` alone decides nothing about
  // identity, and why the branch is read from `context`, the directory this
  // topology was resolved from, rather than from a root a configuration value
  // can move.
  return { context: directory, gitDir: identity, linked: true, primary, root };
}

/**
 * The branch checked out in the worktree that owns a directory. Asked from the
 * same directory the topology was resolved from, so the answer describes that
 * checkout and not whichever one a moved root would land in. A detached head
 * reports the empty string, and this is the point where that becomes a refusal
 * rather than a silent "no branch of interest".
 */
export function branchOf(directory, git, code) {
  const branch = git(directory, ["branch", "--show-current"]).trim();
  if (branch === "") {
    throw new BoundaryError(code, `${directory} is not on a named branch`);
  }
  return branch;
}

/**
 * The slash is part of the test, not decoration: `rehearsal/<label>` is the
 * whole convention, `tools/workspace-reset.mjs` refuses to work in a tree whose
 * branch carries no label, and git will not let a bare `rehearsal` branch exist
 * beside any `rehearsal/<label>` at all. A branch that merely starts or ends
 * like one — `rehearsal-dash`, or this task's own `task/043-rehearsal-…` — is
 * an ordinary development branch, and the cases pin that boundary from both
 * sides.
 */
export function isRehearsalBranch(branch) {
  return typeof branch === "string" && branch.startsWith(REHEARSAL_BRANCH_PREFIX);
}

export function writeTargets(payload) {
  const input = payload?.tool_input;
  const candidates = [input?.file_path, input?.notebook_path];
  return candidates.filter((value) => typeof value === "string" && value.trim() !== "");
}

/**
 * The two rules of the header, in the order that keeps each refusal the most
 * specific one available:
 *
 * 1. a target in the session's own worktree is allowed, before a branch is read
 *    anywhere — the same checkout, not merely a path underneath it;
 * 2. a session living on a `rehearsal/` branch writes nowhere else, targets in
 *    no repository included;
 * 3. a target inside a linked worktree on a `rehearsal/` branch is refused to
 *    every session but the one living there;
 * 4. a target inside a primary worktree is refused to every session that does
 *    not live inside that same primary worktree — except the candidate
 *    repository at the root of the linked worktree the session lives in.
 *
 * Rule 4 is why writes into an ordinary linked worktree stay allowed: a linked
 * worktree is not inside the primary one; rules 2 and 3 are the rehearsal
 * exception to that, and the candidate repository is the one exception to rule
 * 4 itself.
 */
export function decide(payload, git = runGit) {
  const cwd = payload?.cwd;
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new BoundaryError("session_cwd_missing", "the payload carries no session directory");
  }
  const targets = writeTargets(payload);
  if (targets.length === 0) {
    throw new BoundaryError("write_target_missing", "the payload names no write target");
  }
  const sessionDirectory = resolveExistingPath(cwd);
  // Resolved at most once for the whole payload. Resolving a worktree reads no
  // branch, so rule 1 still answers a session whose head a rebase has detached.
  let sessionTree;
  const sessionWorktree = () => {
    if (sessionTree === undefined) sessionTree = worktreeOf(sessionDirectory, git);
    return sessionTree;
  };
  for (const target of targets) {
    const absolute = isAbsolute(target) ? target : join(sessionDirectory, target);
    const resolved = resolveExistingPath(absolute);
    const tree = worktreeOf(resolved, git);
    const session = sessionWorktree();
    // Two questions, and each one alone gives a wrong answer somewhere.
    //
    // Containment alone: git allows a linked worktree inside another worktree,
    // and containment calls the inner one part of the outer, handing a session
    // in it the outer tree's rules.
    //
    // The git directory alone: it is not one per directory tree. A `cp -R` of a
    // linked worktree copies a `.git` file that still names the original's
    // administrative directory; a `.git` written by hand, or pointed at another
    // repository by symlink, names whatever it likes; and a separate git
    // directory that is itself called `.git` leaves its holder a second work
    // tree of the same one. Each answers "the same checkout" for two
    // directories that share no files — and a run session could then write
    // outside the tree its deletion procedure destroys. The ordinary spelling
    // of a separate git directory never gets this far: its common directory is
    // not called `.git`, and the resolver above refuses the layout instead.
    //
    // Both together are what "the session's own tree" means, and they are what
    // keeps rule 2 below meaning "outside it": that is exactly the case this
    // line did not accept.
    if (
      tree !== null
      && session !== null
      && tree.gitDir === session.gitDir
      && isInside(session.root, resolved)
    ) continue;
    if (session !== null) {
      const branch = branchOf(session.context, git, "session_head_detached");
      if (isRehearsalBranch(branch)) {
        return { allowed: false, branch, reason: "rehearsal_outbound", resolved, root: session.root, target };
      }
    }
    if (tree === null) continue;
    if (tree.linked) {
      const branch = branchOf(tree.context, git, "target_head_detached");
      if (isRehearsalBranch(branch)) {
        return { allowed: false, branch, reason: "rehearsal_inbound", resolved, root: tree.root, target };
      }
    }
    if (!isInside(tree.primary, resolved)) continue;
    // Containment, not checkout equality: this rule has always granted a session
    // the rights of the primary worktree its directory sits in, and narrowing it
    // would deny writes nothing in this repository has asked to make. A session
    // in a plain worktree nested inside the primary one therefore keeps that
    // primary's rights — the layout the runbook forbids and rules 2 and 3 no
    // longer depend on it forbidding.
    if (isInside(tree.primary, sessionDirectory)) continue;
    // `join` rather than a resolved path on purpose: `tree.primary` is already
    // resolved, so equality holds only when the directory of that name is the
    // repository itself and not a link to one.
    if (
      session !== null
      && session.linked
      && tree.primary === join(session.root, CANDIDATE_DIRECTORY)
    ) continue;
    return { allowed: false, reason: "operational_root", resolved, root: tree.primary, target };
  }
  return { allowed: true };
}

/**
 * Total by construction: a decision this function cannot classify still refuses,
 * and `main` renders it inside the same `try` that fails closed. Two belts for
 * one hazard — an escaping exception would exit with a code that is not 2, and
 * every runtime reads that as a non-blocking hook failure and lets the write
 * through.
 */
export function denyMessage({ branch, reason, resolved, root }) {
  switch (reason) {
    case "rehearsal_inbound":
      return `operational write boundary [rehearsal_inbound]: a rehearsal worktree is the private `
        + `state of the run session living in it — its ledger decides what the next batch fetches, `
        + `and its captures are that run's evidence — so nothing writes into it from outside. This `
        + `session runs elsewhere, so its file tools may not write into ${root}, the worktree of `
        + `branch ${branch}. Blocked target: ${resolved}. Read that tree by absolute path, and `
        + `write conclusions under your own worktree.`;
    case "rehearsal_outbound":
      return `operational write boundary [rehearsal_outbound]: this session lives in the rehearsal `
        + `worktree ${root} on branch ${branch}, so it is a run session, and its only write surface `
        + `is that tree — the one directory the deletion procedure destroys whole. Blocked target: `
        + `${resolved}. Source changes belong to a development session in its own worktree, and `
        + `anything this run produces belongs under ${root}.`;
    case "operational_root":
      return `operational write boundary [operational_root]: a session may write into a primary `
        + `worktree only from inside that worktree, and this session runs elsewhere, so its file `
        + `tools may not write into ${root} — the operational checkout when the target is the real `
        + `ledger or output tree. Blocked target: ${resolved}. Real pipeline work belongs in a `
        + `session whose own directory is that checkout; development changes belong in this `
        + `worktree.`;
    default:
      return `operational write boundary [unclassified]: this write was refused by a rule this `
        + `message cannot name, which is itself a defect in the guard. Blocked target: ${resolved}.`;
  }
}

export function failClosedMessage(error) {
  const code = error instanceof BoundaryError ? error.code : "unexpected_error";
  const detail = error instanceof BoundaryError ? error.message : "internal failure";
  return `operational write boundary: could not resolve whether this write stays outside the `
    + `operational checkout (${code}: ${detail}). Denying, because this guard fails closed.`;
}

export function main(read = () => readFileSync(0, "utf8"), write = (text) => process.stderr.write(text)) {
  let text;
  try {
    const raw = read();
    if (raw.length > MAX_PAYLOAD_BYTES) {
      throw new BoundaryError("payload_too_large", `${raw.length} bytes`);
    }
    const decision = decide(JSON.parse(raw));
    if (decision.allowed) return;
    text = denyMessage(decision);
  } catch (error) {
    text = failClosedMessage(error);
  }
  write(`${text}\n`);
  process.exitCode = 2;
}

function isDirectInvocation() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  }
}

if (isDirectInvocation()) main();
