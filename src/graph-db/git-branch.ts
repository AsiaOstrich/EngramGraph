/**
 * Git-branch isolation helpers.
 *
 * Per-branch graph DBs live under the repo's git common dir
 * (`<git-common-dir>/engram/<sanitized-branch>.db`) so they survive
 * `git checkout` (git never touches its own dir) without polluting the work
 * tree, and `--git-common-dir` keeps linked worktrees pointing at one location.
 *
 * Pure leaf module: only node builtins, no graph-db/adapter imports, so both
 * the open helper and the GitBranchIsolation adapter can depend on it.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

/**
 * Env vars git itself sets when it invokes a hook (pre-commit, post-commit,
 * etc.): `GIT_DIR`/`GIT_WORK_TREE` name the repo the hook is running FOR,
 * and `GIT_INDEX_FILE`/`GIT_COMMON_DIR` go with them. Left in `process.env`,
 * a `git` subprocess spawned from inside that hook with an explicit `cwd`
 * pointing somewhere else (a different repo entirely — exactly what this
 * function is FOR: resolving isolation for whatever `cwd` names) silently
 * ignores `cwd` and resolves against the HOOK's repo instead, because git
 * treats `GIT_DIR` as authoritative over `cwd`-based discovery whenever it is
 * set. Found via `resolveDbPath`/`cmdGc` returning the outer EngramGraph
 * repo's own `.git/engram` for a temp fixture repo, reproducible with zero
 * other changes by setting `GIT_DIR`/`GIT_WORK_TREE` before a plain
 * `npm test` run — i.e. exactly what running `git commit` (which triggers
 * this repo's husky pre-commit → `npm test`) does on every machine, not
 * something specific to a linked worktree.
 */
const GIT_ENV_OVERRIDE = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_COMMON_DIR: undefined,
};

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ...GIT_ENV_OVERRIDE },
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Make a branch name safe to use as a file name, with a short hash of the
 * original appended so distinct branches never collide (e.g. `feature/x` vs
 * `feature-x` map to different files).
 */
export function sanitizeBranch(branch: string): string {
  const safe = branch.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
  const hash = createHash("sha1").update(branch).digest("hex").slice(0, 8);
  return `${safe}-${hash}`;
}

/** The `egr` dir under the repo's git common dir, or null if not a repo. */
export function gitBranchEngramDir(cwd: string): string | null {
  const gitDir = git(cwd, ["rev-parse", "--git-common-dir"]);
  if (!gitDir) return null;
  return join(resolve(cwd, gitDir), "engram");
}

/**
 * Current branch name, or null if not a repo / detached HEAD.
 *
 * Uses `symbolic-ref` (not `rev-parse --abbrev-ref`) so it resolves correctly
 * on an unborn branch (fresh `git init` with no commits yet) and cleanly fails
 * — returning null — on a detached HEAD.
 */
export function currentBranch(cwd: string): string | null {
  return git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || null;
}

/**
 * Resolve the per-branch graph DB path for `cwd`, or null when isolation can't
 * apply (not a git repo, or detached HEAD — caller should fall back).
 */
export function gitBranchDbPath(cwd: string): string | null {
  const dir = gitBranchEngramDir(cwd);
  const branch = currentBranch(cwd);
  if (!dir || !branch) return null;
  return join(dir, `${sanitizeBranch(branch)}.db`);
}

/** Existing local branch names (empty when not a repo / no commits yet). */
export function listBranches(cwd: string): string[] {
  const out = git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  if (!out) return [];
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}
