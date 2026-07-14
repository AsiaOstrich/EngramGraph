/**
 * Recursive file discovery for the `egr index` command. Returns
 * `{ path, source }` tuples with repo-relative paths, skipping common
 * non-source dirs.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

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
        out.push({ path: relative(root, full), source: readFileSync(full, "utf8") });
      }
    }
  };
  rec(root);
  return out;
}
