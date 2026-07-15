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

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { toPosixPath } from "../code-graph/path-utils.js";

export { toPosixPath };

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
