/**
 * Path-separator normalization shared by every producer of a code-graph id
 * (XSPEC-333 R3 follow-up).
 *
 * Lives in `code-graph/` (not `cli/`) so it sits below BOTH of this codebase's
 * two id-generating entry points without creating a backwards dependency:
 *
 *   - `cli/walk.ts`'s `walkFiles()` (the `egr index <dir>` CLI path), and
 *   - `mcp/server.ts`'s `index_code`/`index_docs` tools, which accept a
 *     caller-supplied `files[].path` directly and hand it straight to
 *     `indexProject`/`extractProject` — **bypassing `walkFiles` entirely**.
 *
 * An earlier version of this fix normalized only inside `walkFiles`, on the
 * (incorrect, caught by adversarial review) assumption that it was the one
 * and only place a path-derived id gets produced. It is not: a Windows MCP
 * client calling `index_code` with `\`-separated paths for the same project
 * an `egr index` CLI run already indexed (which normalizes via `walkFiles`)
 * would get a SECOND, differently-separated set of ids for the same logical
 * files — duplicate Module/Function/Class nodes instead of one shared node
 * per file, the exact same silent-mismatch failure mode this whole fix
 * exists to close, just one layer removed from the original `--scip`
 * report. `extractor.ts`'s `collectExtraction` (the actual, single place
 * every Function/Class/Module id is built, called by both entry points
 * above) now normalizes via {@link toPosixPath} too, so both callers
 * converge on the same id for the same logical file regardless of which one
 * produced the raw path string. `walkFiles`' OWN normalization is kept
 * (not redundant): `cli/run.ts`'s `ingestScipOverlay` compares `walkFiles`'
 * raw `path` field against a SCIP index's `Document.relativePath` BEFORE
 * either value ever reaches `collectExtraction`, so that comparison needs
 * its own normalized input independently.
 */

/**
 * Fold any `\` path-separator byte to `/`, unconditionally (not gated on the
 * live `process.platform`/`path.sep`). Deliberate, not an oversight:
 *
 *   1. It is the only way to make this normalization exercisable by a plain
 *      string-level unit test (feeding a manufactured Windows-style string
 *      containing `\`) on a non-Windows CI/dev machine, where `path.sep` is
 *      always `/` and gating on it would make the conversion branch dead
 *      code in every test run here.
 *   2. A literal backslash inside a real POSIX filename is technically legal
 *      but vanishingly rare in practice, and SCIP's own path convention has
 *      no way to represent it unambiguously either (its docs mandate `/` as
 *      THE separator with no escape convention for a literal `\` byte) — so
 *      even a perfectly platform-aware implementation would have no better
 *      answer for that edge case than "don't do that."
 *
 * Idempotent (safe to apply more than once to the same string — e.g. once in
 * `walkFiles` and again in `collectExtraction` for the CLI-originated path).
 */
export function toPosixPath(p: string): string {
  return p.split("\\").join("/");
}
