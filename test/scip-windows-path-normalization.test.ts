import { describe, expect, it } from "vitest";

import { ingestScipIndex } from "../src/code-graph/providers/scip/scip-ingest.js";
import { toPosixPath } from "../src/cli/walk.js";
import { loadScipPocFixtureIndex, loadScipPocFixtureSources } from "./fixtures/scip-poc/load-fixture.js";

/**
 * XSPEC-333 R3 follow-up — proves the path-separator fix end-to-end at the
 * SCIP-ingest merge boundary, using SIMULATED Windows-style input strings
 * against the real `scip-dotnet` fixture (`test/fixtures/scip-poc/`), since
 * this sandbox has no real Windows host to run `egr index --scip` on.
 *
 * The fixture's real `Document.relativePath` values are already `/`-separated
 * (SCIP's own mandated convention, "including on Windows" — see
 * `scip_pb.ts`) and include nested paths (e.g. "Services/OrderService.cs",
 * see `load-fixture.ts`'s `SCIP_POC_SOURCE_PATHS`). Pre-fix, `egr index`'s own
 * `walkFiles` would have produced `\`-separated equivalents for these same
 * nested files on a real Windows host (`node:path`'s `relative()` is
 * OS-separator-dependent) — `manuallyBackslashed` below reproduces that exact
 * string shape by hand, without needing an actual Windows filesystem call, to
 * demonstrate both the bug this fixes and the fix itself:
 *
 *   1. Un-normalized (what `walkFiles` used to return pre-fix on Windows):
 *      `ingestScipIndex` resolves NOTHING for the nested-path files, because
 *      `fileByPath`'s keys (`\`-separated) never string-match
 *      `Document.relativePath` (`/`-separated) for any file under a
 *      subdirectory.
 *   2. Normalized via `toPosixPath` (what `walkFiles` now returns on every
 *      OS, post-fix — see `cli/walk.ts`'s module doc): the same nested files
 *      resolve identically to the real, always-POSIX fixture test in
 *      `test/scip-ingest.test.ts`.
 */
describe("SCIP ingest + Windows-style path normalization (simulated)", () => {
  const index = loadScipPocFixtureIndex();
  const sources = loadScipPocFixtureSources();

  // Only the nested-subdirectory files are affected by the separator bug —
  // top-level files like "Program.cs" have no separator at all, so they'd
  // match regardless. Sanity-check the fixture actually exercises the nested
  // case before relying on it below.
  const nestedSources = sources.filter((f) => f.relativePath.includes("/"));
  it("fixture sanity check: at least one source file is nested (exercises the separator bug)", () => {
    expect(nestedSources.length).toBeGreaterThan(0);
  });

  it("un-normalized ('\\'-separated, simulating pre-fix Windows walkFiles output): resolves NOTHING for nested files", () => {
    const manuallyBackslashed = sources.map((f) => ({
      ...f,
      relativePath: f.relativePath.replace(/\//g, "\\"),
    }));
    const { stats, fragment } = ingestScipIndex(index, manuallyBackslashed);

    // The two ambiguous-to-tree-sitter calls this PoC exists to prove SCIP
    // can resolve both live in nested files (Services/OrderService.cs,
    // Services/UserService.cs) — with un-normalized backslash paths, neither
    // resolves.
    const callTargets = fragment.edges.filter((e) => e.label === "CALLS").map((e) => `${e.from} -> ${e.to}`);
    expect(callTargets).not.toContain("Program.cs#Program.Main -> Services/OrderService.cs#OrderService.Validate");
    expect(callTargets).not.toContain("Program.cs#Program.Main -> Services/UserService.cs#UserService.Validate");
    expect(stats.definitionsResolved).toBeLessThan(loadRealResolvedCount());
  });

  it("normalized via toPosixPath (simulating post-fix walkFiles output on Windows): resolves identically to the real POSIX fixture", () => {
    const manuallyBackslashed = sources.map((f) => ({
      ...f,
      relativePath: f.relativePath.replace(/\//g, "\\"),
    }));
    // This is exactly what `cli/walk.ts`'s `walkFiles` now does at its own
    // source point — applied here to simulate what a real Windows `egr`
    // process would hand to `ingestScipOverlay`/`ingestScipIndex` post-fix.
    const normalized = manuallyBackslashed.map((f) => ({ ...f, relativePath: toPosixPath(f.relativePath) }));

    // Round-trips back to the exact original POSIX strings.
    expect(normalized.map((f) => f.relativePath)).toEqual(sources.map((f) => f.relativePath));

    const { stats, fragment } = ingestScipIndex(index, normalized);
    const callTargets = fragment.edges.filter((e) => e.label === "CALLS").map((e) => `${e.from} -> ${e.to}`);

    expect(callTargets).toContain("Program.cs#Program.Main -> Services/OrderService.cs#OrderService.Validate");
    expect(callTargets).toContain("Program.cs#Program.Main -> Services/UserService.cs#UserService.Validate");
    expect(stats.definitionsResolved).toBe(loadRealResolvedCount());
    expect(stats.callsEmitted).toBeGreaterThan(0);
  });

  /** The real, always-POSIX fixture's own `definitionsResolved` — the ground truth the normalized-Windows-simulation run above must match exactly. */
  function loadRealResolvedCount(): number {
    return ingestScipIndex(index, sources).stats.definitionsResolved;
  }
});
