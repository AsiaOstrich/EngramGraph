/**
 * Recursive file discovery for the `egr index` command. Returns
 * `{ path, source }` tuples with repo-relative paths, skipping common
 * non-source dirs.
 *
 * ## Path-separator normalization (XSPEC-333 R3 follow-up)
 *
 * `relative()` (`node:path`) is OS-separator-dependent: `/`-joined on
 * POSIX, `\`-joined on Windows. Every downstream id in this codebase is
 * built directly from the `path` string this module produces —
 * `extractor.ts`'s `collectExtraction` takes it as `opts.filePath` and uses
 * it VERBATIM as `Module.id`, `Function.id`'s `${filePath}#...` prefix, and
 * the `file` property on every node; `cli/run.ts`'s `ingestScipOverlay`
 * then string-matches THAT id against a SCIP index's `Document.relativePath`
 * (which the SCIP protobuf schema itself mandates is always `/`-separated,
 * "including on Windows" — see `scip_pb.ts`). A `\`-separated id here would
 * therefore never string-match SCIP's `/`-separated document paths on a real
 * Windows machine, silently producing a zero-overlap SCIP ingest — this was
 * an open, unfixed limitation of XSPEC-333 R3's initial `--scip` CLI wiring
 * (see the removed Windows caveat this module doc used to carry, and
 * `cli/run.ts`'s `ingestScipOverlay` module doc, both updated alongside this
 * fix).
 *
 * The fix normalizes to `/` (matching both the SCIP protocol's own mandated
 * convention and the overwhelming majority of cross-platform tooling, e.g.
 * git) **at this single source point** — every id-generation site downstream
 * (`extractor.ts`, `scip-ingest.ts`) consumes `path` as an opaque string and
 * never re-derives it from the filesystem, so normalizing once here is
 * sufficient; it must NOT also be done again downstream (that would be
 * redundant at best, and a second, differently-scoped normalization site
 * that silently drifts out of sync at worst).
 *
 * {@link toPosixPath} converts unconditionally (not gated on the live
 * `process.platform`/`path.sep`): a literal `\` in a path segment is always
 * folded to `/`, regardless of which OS is actually running `egr`. This is
 * deliberate, not an oversight — two reasons:
 *   1. It is the only way to make this normalization exercisable by a plain
 *      string-level unit test (feeding a manufactured Windows-style string
 *      containing `\`) on a non-Windows CI/dev machine, where `path.sep` is
 *      always `/` and gating on it would make the conversion branch
 *      dead code in every test run here.
 *   2. A literal backslash inside a real POSIX filename is technically legal
 *      but vanishingly rare in practice, and SCIP's own path convention has
 *      no way to represent it unambiguously either (its docs mandate `/` as
 *      THE separator with no escape convention for a literal `\` byte) — so
 *      even a perfectly platform-aware implementation would have no better
 *      answer for that edge case than "don't do that."
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Fold any `\` path-separator byte to `/`, unconditionally. See this
 * module's doc comment above for why this is the single normalization point
 * for every path-derived id in the codebase, and why the conversion is not
 * gated on the live OS's own separator convention.
 */
export function toPosixPath(p: string): string {
  return p.split("\\").join("/");
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
const SKIP_DIRS = new Set([
  "node_modules", "dist", ".engram", ".git", "coverage", "bin", "obj",
  "__pycache__", ".venv", "venv", "vendor", "target", "build",
]);

/** Recursively collect files under `root` whose name ends with one of `exts`. */
export function walkFiles(root: string, exts: readonly string[]): Array<{ path: string; source: string }> {
  const out: Array<{ path: string; source: string }> = [];
  const rec = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) rec(full);
      } else if (exts.some((e) => entry.name.endsWith(e)) && !entry.name.endsWith(".d.ts")) {
        out.push({ path: toPosixPath(relative(root, full)), source: readFileSync(full, "utf8") });
      }
    }
  };
  rec(root);
  return out;
}
