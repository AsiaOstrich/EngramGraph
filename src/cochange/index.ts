/**
 * Historical co-change (XSPEC-514 R2): "which files changed together with this one before?"
 *
 * The call graph answers "who calls this". It cannot see a file that has to change with another for a reason
 * no call expresses (a doc, a test, a schema, a sibling module). The history can: files that were committed
 * together often are likely to be edited together again. This module reads the LOCAL git history and counts
 * it. No model, no graph, no network; the graph database is not opened.
 *
 * ## The rules, each of which is a decision
 *
 * - **Commits considered**: the most recent `commits` (default 200) NON-MERGE commits that touched the file.
 *   Merge commits are left out: their file list is a copy of work already counted in the commits they merged.
 * - **Big commits are skipped**: a commit that changed more than `maxFilesPerCommit` files (default 30,
 *   counting EVERY file of the commit, the asked-for file included) says "a sweep happened", not "these
 *   belong together". The count is `> 30`, so a commit of exactly 30 files is used. The result reports how
 *   many were skipped, because a filter nobody can see is a filter nobody can check.
 * - **A shallow clone's boundary commit is skipped**: git shows the oldest commit of a shallow clone as if it
 *   had added every file in the tree, which would credit every file with having changed with the asked-for one.
 *   Those commits (listed in the repository's `shallow` file) are left out and counted separately; the result
 *   says `shallow: true` because the counts are then lower bounds.
 * - **Renames are not followed** (`--no-renames`): a rename is a delete of the old path and an add of the new
 *   one, so history under an old name is not credited to the new name. Following renames needs similarity
 *   guesses, and a guess presented as history is exactly what this tool must not do. The result says
 *   `renamesFollowed: false`.
 * - **Each file says whether it is still in HEAD** (`existsAtHead`): one `git ls-tree` of HEAD, not a process per file.
 *   The files are NOT filtered by it and counts and order do not depend on it; a deleted file, or the old path of a
 *   renamed one, is listed with `false`. If HEAD's tree cannot be read the field is `null` (not known), never a guess.
 * - **"Cannot determine" is an answer, an empty list is not.** Not a git repository, no commit touches the
 *   file, git missing, git timing out, or every commit that touched the file was skipped as too big: all of
 *   these are `status: "undetermined"` with the reason. `cochanged: []` with `status: "ok"` is reserved for
 *   "the file has usable history and nothing else ever changed with it".
 *
 * The counting is measured, not new: `experiments/2026-10-29-crg-vs-egr/analysis/cochange.py` (dev-platform)
 * is the experiment script; this is its product form, with the differences above spelled out (the script
 * filtered to `pydantic/*.py` BEFORE applying the 30-file rule; the product counts every file of a commit).
 *
 * ## Running git
 *
 * - The path is passed after `--` and with `--literal-pathspecs`, so a name that starts with `-`, or
 *   contains `*`, `[` or starts with `:`, is a file name and never an option or a pattern.
 * - Variables that point git at ANOTHER repository (`GIT_DIR`, `GIT_INDEX_FILE`, … — a hook runs us with
 *   them set) are removed, the same list `egr index --incremental` uses.
 * - Every git call has a timeout (killed with SIGKILL). A timeout is "cannot determine", never a partial list.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, basename, isAbsolute, join, posix, relative, resolve } from "node:path";

import { cleanGitEnv } from "../code-graph/incremental.js";

export const DEFAULT_COCHANGE_COMMITS = 200;
export const DEFAULT_COCHANGE_MAX_FILES = 30;
export const DEFAULT_COCHANGE_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface CoChangeOptions {
  /** The file to ask about. Relative to `repo` (default: the current directory) or absolute. */
  file: string;
  /** A directory inside the git work tree. Default: the current working directory. */
  repo?: string;
  /** How many of the most recent commits touching the file to look at. Default 200. */
  commits?: number;
  /** A commit that changed MORE files than this is skipped. Default 30. */
  maxFilesPerCommit?: number;
  /** How many co-changed files to return (the total is reported separately). Default 10. */
  limit?: number;
  /** Per git call. Default 60 000. */
  timeoutMs?: number;
  /** The git executable. Default "git". A seam for tests (a stand-in that hangs, or is missing). */
  gitBinary?: string;
}

export interface CoChangedFile {
  /** Repository-root-relative, `/`-separated. */
  file: string;
  /** In how many of the used commits it changed together with the asked-for file. */
  count: number;
  /**
   * Is this path still in the tree of `HEAD`? `false` for a file that was deleted, or renamed away (renames are not
   * followed, so the old path of a renamed file is `false` and its new path is a different row). `null` when HEAD's
   * tree could not be read: not known, which is neither true nor false. Counts and order do not depend on it.
   */
  existsAtHead: boolean | null;
}

export interface CoChangeOk {
  status: "ok";
  /** The asked-for file, repository-root-relative. */
  file: string;
  repoRoot: string;
  /** Commits that touched the file, up to `maxCommits`. `commitsUsed + commitsSkippedLarge + commitsSkippedShallowBoundary`. */
  commitsExamined: number;
  commitsUsed: number;
  /** Commits left out because they changed more than `maxFilesPerCommit` files. */
  commitsSkippedLarge: number;
  /** Commits left out because they are a shallow clone's boundary (git shows them as adding the whole tree). */
  commitsSkippedShallowBoundary: number;
  maxCommits: number;
  maxFilesPerCommit: number;
  /** A shallow clone: history before the clone depth is absent, so counts are lower bounds. */
  shallow: boolean;
  /** Always false: a renamed file's earlier history is not credited to its new name. */
  renamesFollowed: false;
  /** Always false: merge commits are not counted. */
  mergesIncluded: false;
  /** Distinct co-changed files before `limit` was applied. */
  totalFiles: number;
  limit: number;
  /** Most frequent first; ties by path. */
  cochanged: CoChangedFile[];
}

export interface CoChangeUndetermined {
  status: "undetermined";
  file: string;
  /** Why no answer can be given. English; the CLI prefixes it with 「無法判定」. */
  reason: string;
}

export type CoChangeResult = CoChangeOk | CoChangeUndetermined;

function requirePositiveInt(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`${name} must be a positive integer (got ${String(v)})`);
}

interface GitRun {
  ok: true;
  stdout: string;
}
interface GitFail {
  ok: false;
  reason: string;
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0]?.trim() ?? "";
}

function runGit(
  bin: string,
  dir: string,
  args: string[],
  timeoutMs: number,
  input?: string,
): GitRun | GitFail {
  const r = spawnSync(bin, ["--literal-pathspecs", "-C", dir, ...args], {
    encoding: "utf8",
    env: { ...cleanGitEnv(), GIT_OPTIONAL_LOCKS: "0" },
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024 * 1024,
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return { ok: false, reason: `git could not be run (${bin} not found); co-change reads the local git history` };
  if (code === "ETIMEDOUT" || (r.error && r.signal)) {
    return { ok: false, reason: `git did not finish within ${timeoutMs} ms (git ${args[0]}); an unfinished read is not a result` };
  }
  if (code === "ENOBUFS") return { ok: false, reason: `git ${args[0]} printed more than the 256 MB this command reads` };
  if (r.error) return { ok: false, reason: `git ${args[0]} failed to run: ${r.error.message}` };
  if (r.status !== 0) {
    const detail = firstLine(r.stderr ?? "") || `exit status ${String(r.status)}`;
    return { ok: false, reason: `git ${args[0]} failed: ${detail}` };
  }
  return { ok: true, stdout: r.stdout };
}

/** realpath of `p`, or of its deepest existing ancestor with the rest appended (a deleted file has no realpath). */
function realOrAncestorReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    return join(realOrAncestorReal(parent), basename(p));
  }
}

/** Backslashes are separators only on Windows; on POSIX a backslash is a legal file-name character. */
const sep = (p: string): string => (process.platform === "win32" ? p.split("\\").join("/") : p);

/**
 * Which files changed together with `opts.file` in the repository's history. Throws only on a call that is
 * wrong (a limit that is not a positive integer); everything the repository or the machine can do wrong comes
 * back as `{ status: "undetermined", reason }`.
 */
export function coChange(opts: CoChangeOptions): CoChangeResult {
  const maxCommits = opts.commits ?? DEFAULT_COCHANGE_COMMITS;
  const maxFiles = opts.maxFilesPerCommit ?? DEFAULT_COCHANGE_MAX_FILES;
  const limit = opts.limit ?? DEFAULT_COCHANGE_LIMIT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bin = opts.gitBinary ?? "git";
  requirePositiveInt("commits", maxCommits);
  requirePositiveInt("max files per commit", maxFiles);
  requirePositiveInt("limit", limit);
  requirePositiveInt("timeout", timeoutMs);
  if (opts.file === "" || opts.file.includes("\0")) throw new RangeError("file must be a non-empty path");

  const undetermined = (reason: string): CoChangeUndetermined => ({ status: "undetermined", file: opts.file, reason });

  const repoDir = resolve(opts.repo ?? process.cwd());
  if (!existsSync(repoDir) || !statSync(repoDir).isDirectory()) {
    return undetermined(`${repoDir} is not a directory, so there is no repository to read`);
  }

  // Where is the work tree, where in it are we, and is the history complete?
  const top = runGit(bin, repoDir, ["rev-parse", "--show-toplevel", "--show-prefix", "--is-shallow-repository"], timeoutMs);
  if (!top.ok) return undetermined(`${repoDir} is not inside a git work tree, or git could not read it (${top.reason})`);
  const lines = top.stdout.split("\n");
  if (lines.length !== 4 || lines[0] === "") return undetermined(`unexpected output from git rev-parse: ${JSON.stringify(top.stdout.slice(0, 200))}`);
  const repoRoot = lines[0]!;
  const prefix = lines[1]!;
  const shallow = lines[2] === "true";

  // The file, as git names it: relative to the work tree root.
  let rel: string;
  if (isAbsolute(opts.file)) {
    rel = sep(relative(realOrAncestorReal(repoRoot), realOrAncestorReal(resolve(opts.file))));
  } else {
    rel = posix.normalize(sep(prefix) + sep(opts.file));
  }
  if (rel === "." || rel === "") return undetermined(`${opts.file} is the repository root, not a file`);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    return undetermined(`${opts.file} is outside the repository at ${repoRoot}`);
  }
  if (rel.endsWith("/")) rel = rel.slice(0, -1);
  const onDisk = join(repoRoot, rel);
  if (existsSync(onDisk) && statSync(onDisk).isDirectory()) {
    return undetermined(`${rel} is a directory; co-change is asked of one file at a time`);
  }

  // Pass 1: the commits that touched the file (newest first). The path goes after `--`.
  const listed = runGit(bin, repoRoot, ["log", `--max-count=${maxCommits}`, "--no-merges", "--format=%H", "--", rel], timeoutMs);
  if (!listed.ok) return undetermined(`the history could not be read (${listed.reason})`);
  const shas = listed.stdout.split("\n").filter((l) => l !== "");
  if (shas.length === 0) {
    return undetermined(
      `no commit reachable from HEAD touches ${rel} — a file that was never committed (or a path that does not exist) has no history to count` +
        (shallow ? "; this is a shallow clone, so the history before its depth is absent" : ""),
    );
  }

  // Pass 2: every file of each of those commits. `%x01` opens each record, so a record boundary is never
  // guessed from the length of a hash; a path cannot be mistaken for one.
  const shown = runGit(
    bin,
    repoRoot,
    ["log", "--no-walk=unsorted", "--stdin", "-z", "--name-only", "--no-renames", "--format=%x01%H"],
    timeoutMs,
    shas.join("\n") + "\n",
  );
  if (!shown.ok) return undetermined(`the files of the commits could not be read (${shown.reason})`);
  const records = shown.stdout.split("\x01");
  if (records[0] !== "" || records.length !== shas.length + 1) {
    return undetermined(`unexpected output from git log: expected ${shas.length} commit record(s), found ${records.length - 1}`);
  }

  // A shallow clone's boundary commits look like "added every file". They are not history; leave them out.
  const boundary = shallow ? shallowBoundary(bin, repoRoot, timeoutMs) : new Set<string>();
  if (boundary === null) return undetermined("the repository is a shallow clone and its boundary commits could not be read, so a made-up 'added everything' commit might be counted");

  const counts = new Map<string, number>();
  let used = 0;
  let skipped = 0;
  let skippedBoundary = 0;
  for (let i = 1; i < records.length; i++) {
    const rec = records[i]!;
    const nul = rec.indexOf("\0");
    const head = nul === -1 ? rec : rec.slice(0, nul);
    if (head !== shas[i - 1]) {
      return undetermined(`unexpected output from git log: record ${i} is for ${JSON.stringify(head.slice(0, 80))}, not ${shas[i - 1]}`);
    }
    if (boundary.has(head)) {
      skippedBoundary++;
      continue;
    }
    let body = nul === -1 ? "" : rec.slice(nul + 1);
    if (body.startsWith("\n")) body = body.slice(1);
    const names = body === "" ? [] : body.split("\0");
    if (names[names.length - 1] === "") names.pop();
    const files = new Set(names);
    if (files.size > maxFiles) {
      skipped++;
      continue;
    }
    used++;
    for (const f of files) if (f !== rel) counts.set(f, (counts.get(f) ?? 0) + 1);
  }

  if (used === 0) {
    const why = [
      ...(skipped ? [`${skipped} changed more than ${maxFiles} files (raise --max-files to use them)`] : []),
      ...(skippedBoundary ? [`${skippedBoundary} ${skippedBoundary === 1 ? "is" : "are"} the shallow clone's boundary, which git shows as adding every file`] : []),
    ].join("; ");
    return undetermined(
      `all ${shas.length} commit(s) that touched ${rel} were set aside, so none was used: ${why} — ` +
        `the history says nothing about it at this setting`,
    );
  }

  // Which of them are still there? ONE `git ls-tree` of HEAD for the whole answer, not a process per file. When it
  // cannot be read the column is `null` (not known), never a guess in either direction.
  const atHead = headPaths(bin, repoRoot, timeoutMs);
  const sorted = [...counts.entries()]
    .map(([file, count]) => ({ file, count, existsAtHead: atHead === null ? null : atHead.has(file) }))
    .sort((a, b) => b.count - a.count || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return {
    status: "ok",
    file: rel,
    repoRoot,
    commitsExamined: shas.length,
    commitsUsed: used,
    commitsSkippedLarge: skipped,
    commitsSkippedShallowBoundary: skippedBoundary,
    maxCommits,
    maxFilesPerCommit: maxFiles,
    shallow,
    renamesFollowed: false,
    mergesIncluded: false,
    totalFiles: sorted.length,
    limit,
    cochanged: sorted.slice(0, limit),
  };
}

/** Every path in HEAD's tree, or `null` when git cannot say (no HEAD, timeout, failure). */
function headPaths(bin: string, repoRoot: string, timeoutMs: number): Set<string> | null {
  const r = runGit(bin, repoRoot, ["ls-tree", "-r", "--name-only", "-z", "HEAD"], timeoutMs);
  if (!r.ok) return null;
  return new Set(r.stdout.split("\0").filter((p) => p !== ""));
}

/**
 * The commits at a shallow clone's edge (`<git-dir>/shallow`, one hash per line). `null` when the file that must
 * exist in a shallow repository cannot be read: then the caller does not guess.
 */
function shallowBoundary(bin: string, repoRoot: string, timeoutMs: number): Set<string> | null {
  const where = runGit(bin, repoRoot, ["rev-parse", "--git-path", "shallow"], timeoutMs);
  if (!where.ok) return null;
  const path = resolve(repoRoot, where.stdout.trim());
  try {
    return new Set(readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter((l) => l !== ""));
  } catch {
    return null;
  }
}

/** The sentence the CLI and the MCP tool give when `coChange` cannot answer. */
export function undeterminedMessage(r: CoChangeUndetermined): string {
  return `cochange: 無法判定 (cannot determine) — ${r.reason}`;
}

/** Human-readable form of an `ok` result: the denominators first, then the ranking, then what it does not follow. */
export function formatCoChange(r: CoChangeOk): string {
  const head =
    `cochange(${r.file}): ${r.commitsUsed} commit(s) used of the last ${r.commitsExamined} non-merge commit(s) that touched it ` +
    `(limit ${r.maxCommits}); ${r.commitsSkippedLarge} skipped for changing more than ${r.maxFilesPerCommit} files` +
    (r.commitsSkippedShallowBoundary ? `, ${r.commitsSkippedShallowBoundary} skipped as the shallow clone's boundary` : "");
  const body = r.cochanged.length
    ? r.cochanged
        .map((c) => `  ${String(c.count).padStart(4)}  ${c.file}${c.existsAtHead === false ? "  (not at HEAD)" : c.existsAtHead === null ? "  (HEAD unreadable)" : ""}`)
        .join("\n")
    : "  (none — in the commits used, no other file changed with it)";
  const more = r.totalFiles > r.cochanged.length ? `\n  … ${r.totalFiles - r.cochanged.length} more file(s); --limit N shows more` : "";
  const notes = [
    "counts are commits in which the file changed together with this one; merge commits are not counted; renames are not followed (a renamed file's earlier history is credited to its old name)",
    ...(r.cochanged.some((c) => c.existsAtHead === false)
      ? ["(not at HEAD) = the path is no longer in HEAD's tree: deleted, or renamed away; it is listed, counted and ranked like any other"]
      : []),
    ...(r.cochanged.some((c) => c.existsAtHead === null)
      ? ["(HEAD unreadable) = git could not list HEAD's tree, so whether the path still exists is not known"]
      : []),
    ...(r.shallow ? ["shallow clone: history before the clone depth is absent, so counts are lower bounds"] : []),
  ];
  return `${head}\n${body}${more}\n${notes.map((n) => `note: ${n}`).join("\n")}`;
}
