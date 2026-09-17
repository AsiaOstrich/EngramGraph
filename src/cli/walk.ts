/**
 * Recursive file discovery for the `egr index` command. Returns
 * `{ path, source }` tuples with repo-relative paths, skipping common
 * non-source dirs.
 *
 * ## Path-separator normalization (XSPEC-333 R3 follow-up)
 *
 * `relative()` (`node:path`) is OS-separator-dependent: `/`-joined on
 * POSIX, `\`-joined on Windows. `cli/run.ts`'s `ingestScipOverlay` string-
 * matches this module's `path` field directly against a SCIP index's
 * `Document.relativePath` (which the SCIP protobuf schema itself mandates is
 * always `/`-separated, "including on Windows" — see `scip_pb.ts`) BEFORE
 * either value ever reaches `extractor.ts`'s id-generation logic. A
 * `\`-separated path here would therefore never string-match SCIP's
 * `/`-separated document paths on a real Windows machine, silently
 * producing a zero-overlap SCIP ingest — this was an open, unfixed
 * limitation of XSPEC-333 R3's initial `--scip` CLI wiring (see the removed
 * Windows caveat this module doc used to carry, and `cli/run.ts`'s
 * `ingestScipOverlay` module doc, both updated alongside this fix).
 *
 * The fix normalizes to `/` (matching both the SCIP protocol's own mandated
 * convention and the overwhelming majority of cross-platform tooling, e.g.
 * git) at this module's own source point, via the shared
 * {@link toPosixPath} (re-exported here from `code-graph/path-utils.ts` —
 * see that module's doc for why it lives there, not here: `extractor.ts`'s
 * `collectExtraction` ALSO normalizes via the same function, as a second,
 * independent entry point's id generation needs it too — `mcp/server.ts`'s
 * `index_code`/`index_docs` tools accept caller-supplied paths directly,
 * bypassing `walkFiles` entirely, and an adversarial review of this fix
 * correctly caught that normalizing only here would leave THAT path still
 * broken on a Windows MCP client. Both normalization sites are needed, not
 * redundant: `collectExtraction`'s covers id generation for every caller;
 * this one covers `ingestScipOverlay`'s pre-`collectExtraction` path-set
 * comparison, which only ever sees `walkFiles`' raw output).
 */

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { toPosixPath } from "../code-graph/path-utils.js";

export { toPosixPath };

/**
 * How many bytes to read off the front of a candidate "unindexed source
 * file" to decide whether it's binary (XSPEC-414 R1). 8000 is the same
 * buffer size git itself uses for `core.autocrlf`/diff's binary-file
 * detection (`buffer_is_binary` in git's own `convert.c`) — not this
 * project's own number, borrowed because it's a widely-validated size that
 * balances catching the common binary formats against reading enough of a
 * legitimate text file whose first few hundred bytes happen to be ASCII-safe
 * padding (e.g. some resource formats).
 */
const BINARY_PROBE_BYTES = 8000;

/**
 * Cheap, sampling binary detector: read the first {@link BINARY_PROBE_BYTES}
 * bytes and look for a NUL byte. A NUL cannot appear in valid UTF-8/ASCII
 * source text, so its presence is a strong, well-established signal (the
 * same heuristic git, GNU grep and most "is this file text" checks use) —
 * without decoding or holding the whole file in memory, which matters here
 * because this scan runs over a directory's UNMATCHED files (XSPEC-414 R1's
 * "what did we not index" accounting), a set that can include large media or
 * archive blobs `readFileSync` would otherwise load in full just to reject.
 *
 * An unreadable file (permission denied, race with a delete, a dangling
 * symlink) is treated as binary — i.e. excluded from the unindexed-source
 * count — rather than raising: this accounting is a best-effort statistic
 * about source-*looking* files, not a second copy of `unreadable`'s
 * hard-failure tracking above, which only applies to files that already
 * matched a known extension.
 */
function looksBinary(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return true;
  }
  try {
    const buf = Buffer.alloc(BINARY_PROBE_BYTES);
    const bytesRead = readSync(fd, buf, 0, BINARY_PROBE_BYTES, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } catch {
    return true;
  } finally {
    closeSync(fd);
  }
}

// "bin"/"obj" are MSBuild's generated-output dirs for C# projects (XSPEC-333
// R2b) — without skipping them, `egr index` on a real .NET repo walks into
// compiler-generated files (e.g. `obj/**/*.AssemblyInfo.cs`, `*.g.cs`) that
// duplicate real symbol names into the global name index, degrading CALLS
// resolution precision the same way indexing node_modules would for JS/TS.
//
// XSPEC-333 R2c adds the same class of skip for the three new languages'
// own vendored-dependency / generated-output conventions, same rationale:
// "__pycache__" (Python's compiled bytecode cache), ".venv"/"venv" (Python
// virtualenvs, which contain a full copy of every installed dependency's
// source under site-packages), "vendor" (Go's vendoring convention, which
// — like node_modules — copies dependency source verbatim into the repo),
// and "target" (Maven's build-output dir; Gradle's default is "build",
// already skipped below alongside the pre-existing "dist" entry for the
// same "generic build-output dir name" reason).
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules", "dist", ".engram", ".git", "coverage", "bin", "obj",
  "__pycache__", ".venv", "venv", "vendor", "target", "build",
]);

export interface WalkResult {
  files: Array<{ path: string; source: string }>;
  /**
   * Directory symlinks encountered and NOT descended into (XSPEC-373 B3).
   *
   * `Dirent.isDirectory()` is false for a symlink even when it points at a
   * directory, and `SKIP_DIRS` does not list them either — so such a tree was
   * neither walked nor recorded. Measured on two identical trees differing
   * only in whether one subdirectory was a symlink: 2 files vs 1, and `egr
   * blindspots` then reported "all 1 indexed files parsed cleanly". The files
   * were not merely missing from the graph, they were missing from the
   * DENOMINATOR, so the green tick was sincere.
   *
   * Reporting rather than following is deliberate. Descending into symlinks
   * invites cycles and double-counting, and that trade-off deserves its own
   * decision; what is not defensible is making the choice silently. This
   * turns an invisible omission into a visible one.
   *
   * Symlinked FILES are unaffected: `readFileSync` follows them, and they are
   * indexed exactly as before.
   */
  skippedSymlinkDirs: string[];
  /**
   * Files matched by extension but not readable (XSPEC-373 B7), with the OS
   * error. Permission-denied, a race with a delete, an I/O error.
   */
  unreadable: Array<{ path: string; reason: string }>;
  /**
   * Files this walk saw but did NOT collect because their extension isn't in
   * `exts` (XSPEC-414 R1) — the population `egr index`'s "N files seen but
   * not indexed" summary is drawn from. Walked and excluded the same way
   * `files` is (same `SKIP_DIRS`, same directory-symlink handling), MINUS
   * `.d.ts` files (an existing, deliberate exclusion — declaration files
   * carry no runtime code — not a coverage gap) and binary files (see
   * {@link looksBinary}: a repo's images/archives/etc. are not "unsupported
   * source code", they're not source code at all).
   *
   * This is a walk-time, extension-only signal: it says nothing about
   * whether `detectLanguage` would recognize the extension either — it is
   * whatever `exts` this call was given. `cli/run.ts`'s `cmdIndex` calls this
   * with `CODE_EXTS`, so in practice the two do line up for the CLI's own
   * `egr index` command.
   */
  unindexed: Array<{ path: string; ext: string }>;
}

/**
 * Recursively collect files under `root` whose name ends with one of `exts`,
 * plus an account of what was skipped.
 *
 * Returns a result object rather than a bare array so callers cannot quietly
 * drop the skip list — an optional out-parameter would be omitted by every
 * caller that did not already know to ask, which is the failure this is fixing.
 */
export function walkFiles(root: string, exts: readonly string[]): WalkResult {
  const files: Array<{ path: string; source: string }> = [];
  const skippedSymlinkDirs: string[] = [];
  const unreadable: Array<{ path: string; reason: string }> = [];
  const unindexed: Array<{ path: string; ext: string }> = [];
  const rec = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) rec(full);
        continue;
      }
      // `throwIfNoEntry: false` covers a broken symlink — a dangling link is
      // not a skipped directory, and must not abort the whole walk either.
      if (entry.isSymbolicLink() && statSync(full, { throwIfNoEntry: false })?.isDirectory()) {
        skippedSymlinkDirs.push(toPosixPath(relative(root, full)));
        continue;
      }
      const isDts = entry.name.endsWith(".d.ts");
      if (exts.some((e) => entry.name.endsWith(e)) && !isDts) {
        const path = toPosixPath(relative(root, full));
        try {
          files.push({ path, source: readFileSync(full, "utf8") });
        } catch (err) {
          // Discovery runs BEFORE `extractProject`'s per-file resilience
          // (XSPEC-334 R1a), so an unreadable file used to abort the entire
          // index with a bare EACCES — one permission-denied file taking the
          // whole run with it. Recorded and skipped instead. Not swallowed:
          // silently dropping it would put the file outside the denominator,
          // which is the failure mode this whole spec is about.
          unreadable.push({ path, reason: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }
      // XSPEC-414 R1: everything else is a candidate for "seen but not
      // indexed" accounting — walked and excluded, not enumerated from a
      // second hand-maintained "these are source code extensions" list.
      // `.d.ts` is skipped here too: it's an existing, deliberate exclusion
      // (declaration files carry no runtime code), not something a user needs
      // told about as unsupported.
      if (isDts) continue;
      if (looksBinary(full)) continue;
      unindexed.push({
        path: toPosixPath(relative(root, full)),
        ext: extname(entry.name).toLowerCase() || "(none)",
      });
    }
  };
  rec(root);
  return { files, skippedSymlinkDirs, unreadable, unindexed };
}

/** Default cap on how many distinct extensions {@link summarizeUnindexed} reports (XSPEC-414 R1). */
export const UNINDEXED_TOP_N = 10;

/** One extension's share of {@link summarizeUnindexed}'s grouped output. */
export interface UnindexedExtensionCount {
  ext: string;
  count: number;
}

/** Grouped result of {@link summarizeUnindexed}. */
export interface UnindexedSummary {
  /** Total unindexed source files seen (across ALL extensions, not just the top N below). */
  count: number;
  /**
   * The most common extensions among `count`, largest first, ties broken
   * alphabetically for a deterministic order. Capped at `topN`.
   */
  topExtensions: UnindexedExtensionCount[];
}

/**
 * Group {@link WalkResult.unindexed} by extension for a compact CLI/`--json`
 * summary (XSPEC-414 R1) — a raw per-file list is fine for a handful of
 * files, unreadable for a repo with hundreds.
 */
export function summarizeUnindexed(
  unindexed: ReadonlyArray<{ path: string; ext: string }>,
  topN: number = UNINDEXED_TOP_N,
): UnindexedSummary {
  const counts = new Map<string, number>();
  for (const f of unindexed) counts.set(f.ext, (counts.get(f.ext) ?? 0) + 1);
  const topExtensions = [...counts.entries()]
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext))
    .slice(0, topN);
  return { count: unindexed.length, topExtensions };
}
