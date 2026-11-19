// SPDX-License-Identifier: MIT
/**
 * `scanStaleFiles` and `readIndexHealth().staleFiles`, in-process.
 *
 * `egr-watch.test.ts` proves the feature from the product entry points (the CLI and the MCP server as child
 * processes). A child process is invisible to the coverage tool and shows only that one path worked; these cases
 * import the module and walk its branches: what counts as newer than the index, what is skipped, what is capped and
 * what is remembered.
 *
 * Each case builds its own directory, so nothing depends on another case having run.
 */
import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearStaleScanCache, scanStaleFiles, STALE_SCAN_TTL_MS } from "../src/code-graph/stale-files.js";
import { MCP_INDEX_ROOT, writeManifest, type ManifestRun, type ParseManifest } from "../src/code-graph/parse-manifest.js";
import type { FileParseHealth } from "../src/code-graph/parse-health.js";
import { computeIndexHealth, readIndexHealth, staleNote } from "../src/code-graph/index-health.js";

const dirs: string[] = [];
afterEach(() => {
  clearStaleScanCache();
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "egr-stale-"));
  dirs.push(d);
  return d;
}

const SINCE = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function file(path: string, extra: Partial<FileParseHealth> = {}): FileParseHealth {
  return { path, language: "typescript", errorNodes: 0, errorExtent: 0, sourceExtent: 10, functions: 1, classes: 0, ...extra };
}

/** Write `rel` under `root` with a given modification time. */
function put(root: string, rel: string, mtimeMs: number): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "export const x = 1;\n");
  utimesSync(full, mtimeMs / 1000, mtimeMs / 1000);
}

function manifestOf(runs: Record<string, Partial<ManifestRun>>): ParseManifest {
  const filled: Record<string, ManifestRun> = {};
  for (const [root, r] of Object.entries(runs)) filled[root] = { indexedAt: iso(SINCE), files: [], ...r };
  return { egrVersion: "0.0.0-test", grammarVersions: {}, runs: filled };
}

describe("scanStaleFiles: which indexed files are newer than the index", () => {
  it("counts a file modified after the run began, and not one modified before it", () => {
    const root = tmp();
    put(root, "old.ts", SINCE - 60_000);
    put(root, "new.ts", SINCE + 60_000);
    const m = manifestOf({ [root]: { files: [file("old.ts"), file("new.ts")] } });
    expect(scanStaleFiles(m)).toEqual({ count: 1, sample: ["new.ts"] });
  });

  it("measures from startedAt when the section has one, so a file edited mid-run is stale even though indexedAt is later", () => {
    const root = tmp();
    put(root, "mid.ts", SINCE + 30_000); // after the run began, before it finished
    const m = manifestOf({ [root]: { startedAt: iso(SINCE), indexedAt: iso(SINCE + 60_000), files: [file("mid.ts")] } });
    expect(scanStaleFiles(m).count).toBe(1);
  });

  it("falls back to indexedAt when the section has no startedAt (a section an older egr wrote)", () => {
    const root = tmp();
    put(root, "mid.ts", SINCE + 30_000);
    const m = manifestOf({ [root]: { indexedAt: iso(SINCE + 60_000), files: [file("mid.ts")] } });
    expect(scanStaleFiles(m).count).toBe(0);
  });

  it("counts a file that is gone while its root is still there: the graph still holds it", () => {
    const root = tmp();
    put(root, "kept.ts", SINCE - 60_000);
    const m = manifestOf({ [root]: { files: [file("kept.ts"), file("deleted.ts")] } });
    expect(scanStaleFiles(m)).toEqual({ count: 1, sample: ["deleted.ts"] });
  });

  it("reports a file by its graph id when it has one, not by its relative path", () => {
    const root = tmp();
    put(root, "src/a.ts", SINCE + 60_000);
    const m = manifestOf({ [root]: { files: [file("src/a.ts", { id: "repo-b/src/a.ts" })] } });
    expect(scanStaleFiles(m).sample).toEqual(["repo-b/src/a.ts"]);
  });

  // A directory with no permissions makes `stat` of a file inside it fail with EACCES, not ENOENT. (Not meaningful on
  // Windows, where mode bits do not deny access, or as root, which ignores them.)
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "does not count a file it cannot look at for a reason other than 'gone' (permissions): cannot tell is not stale",
    () => {
      const root = tmp();
      put(root, "locked/a.ts", SINCE + 60_000);
      chmodSync(join(root, "locked"), 0o000);
      try {
        const m = manifestOf({ [root]: { files: [file("locked/a.ts")] } });
        expect(scanStaleFiles(m).count).toBe(0);
      } finally {
        chmodSync(join(root, "locked"), 0o755);
      }
    },
  );

  it("skips the MCP index_code record, a root that is not on this machine, a root that is a file, and a section with no usable timestamp", () => {
    const real = tmp();
    const aFile = join(real, "just-a-file");
    writeFileSync(aFile, "x");
    const noTime = tmp();
    put(noTime, "n.ts", SINCE + 60_000);
    const m = manifestOf({
      [MCP_INDEX_ROOT]: { files: [file("gone.ts")] },
      [join(real, "no-such-root")]: { files: [file("gone.ts")] },
      [aFile]: { files: [file("gone.ts")] },
      [noTime]: { indexedAt: "not a date", files: [file("n.ts")] },
    });
    expect(scanStaleFiles(m)).toEqual({ count: 0, sample: [] });
  });

  it("adds up every root of a shared graph, each compared under its own directory", () => {
    const a = tmp();
    const b = tmp();
    put(a, "same.ts", SINCE + 60_000); // newer in root a
    put(b, "same.ts", SINCE - 60_000); // older in root b: the same relative path is not stale there
    const m = manifestOf({ [a]: { files: [file("same.ts")] }, [b]: { files: [file("same.ts")] } });
    expect(scanStaleFiles(m)).toEqual({ count: 1, sample: ["same.ts"] });
  });

  it("returns the full count but lists at most 20 files", () => {
    const root = tmp();
    const files: FileParseHealth[] = [];
    for (let i = 0; i < 25; i += 1) {
      put(root, `f${i}.ts`, SINCE + 60_000);
      files.push(file(`f${i}.ts`));
    }
    const r = scanStaleFiles(manifestOf({ [root]: { files } }));
    expect(r.count).toBe(25);
    expect(r.sample).toHaveLength(20);
  });

  it("is empty for a manifest with no runs", () => {
    expect(scanStaleFiles({ egrVersion: "0", grammarVersions: {}, runs: undefined as never })).toEqual({ count: 0, sample: [] });
  });
});

describe("scanStaleFiles: the answer is remembered for a second, per manifest", () => {
  it("reuses the scan for the same manifest object within the TTL, and looks again after it", () => {
    const root = tmp();
    put(root, "a.ts", SINCE - 60_000);
    const m = manifestOf({ [root]: { files: [file("a.ts")] } });
    const t0 = 1_000_000;
    expect(scanStaleFiles(m, t0).count).toBe(0);
    put(root, "a.ts", SINCE + 60_000); // the file changes behind the cache
    expect(scanStaleFiles(m, t0 + STALE_SCAN_TTL_MS - 1).count).toBe(0); // still the remembered answer
    expect(scanStaleFiles(m, t0 + STALE_SCAN_TTL_MS).count).toBe(1); // TTL over: looks again
  });

  it("clearStaleScanCache forgets it at once, and a new manifest object (a re-index) is scanned at once", () => {
    const root = tmp();
    put(root, "a.ts", SINCE - 60_000);
    const files = [file("a.ts")];
    const m = manifestOf({ [root]: { files } });
    expect(scanStaleFiles(m, 5_000_000).count).toBe(0);
    put(root, "a.ts", SINCE + 60_000);
    expect(scanStaleFiles(m, 5_000_001).count).toBe(0);
    clearStaleScanCache();
    expect(scanStaleFiles(m, 5_000_002).count).toBe(1);

    put(root, "b.ts", SINCE + 60_000);
    const rewritten = manifestOf({ [root]: { files: [file("a.ts"), file("b.ts")] } });
    expect(scanStaleFiles(rewritten, 5_000_003).count).toBe(2);
  });
});

describe("indexHealth.staleFiles", () => {
  it("is absent when nothing is stale and nothing failed to parse: a current, clean graph carries no indexHealth at all", () => {
    expect(computeIndexHealth(manifestOf({ x: { files: [file("a.ts")] } }), [], { count: 0, sample: [] })).toBeNull();
    expect(computeIndexHealth(null, [], { count: 3, sample: ["a.ts"] })).toBeNull();
  });

  it("is set, with its sample, when files are newer than the index, even if every file parsed cleanly", () => {
    const h = computeIndexHealth(manifestOf({ x: { files: [file("a.ts"), file("b.ts")] } }), [], { count: 2, sample: ["a.ts", "b.ts"] });
    expect(h).toEqual({ filesIndexed: 2, partial: 0, failed: 0, staleFiles: 2, staleSample: ["a.ts", "b.ts"] });
  });

  it("sits beside the blindspot signal when both apply", () => {
    const m = manifestOf({ x: { files: [file("src/ok.ts"), file("src/bad.ts", { failed: "boom" })] } });
    const h = computeIndexHealth(m, ["src/ok.ts"], { count: 1, sample: ["src/ok.ts"] });
    expect(h).toMatchObject({ failed: 1, possiblyIncomplete: true, blindspots: ["src/bad.ts"], staleFiles: 1, staleSample: ["src/ok.ts"] });
  });

  it("readIndexHealth reads the manifest from disk and the files from the file system: edited -> staleFiles 1, deleted -> counted too, untouched -> null", () => {
    const work = tmp();
    const root = join(work, "proj");
    put(root, "a.ts", SINCE - 60_000);
    put(root, "b.ts", SINCE - 60_000);
    const manifestPath = join(work, "graph.parse-manifest.json");
    writeManifest(manifestPath, manifestOf({ [root]: { files: [file("a.ts"), file("b.ts")] } }));

    expect(readIndexHealth(manifestPath, [])).toBeNull();

    put(root, "a.ts", SINCE + 60_000);
    // the manifest file is untouched, so its parsed object is cached; the stale scan has its own 1 s memory
    clearStaleScanCache();
    expect(readIndexHealth(manifestPath, [])).toMatchObject({ staleFiles: 1, staleSample: ["a.ts"] });

    rmSync(join(root, "b.ts"));
    clearStaleScanCache();
    expect(readIndexHealth(manifestPath, [])).toMatchObject({ staleFiles: 2 });
  });

  it("staleNote says how many, names the first three, and what to run; it is empty when nothing is behind", () => {
    expect(staleNote({ filesIndexed: 1, partial: 0, failed: 0 })).toBe("");
    const one = staleNote({ filesIndexed: 5, partial: 0, failed: 0, staleFiles: 1, staleSample: ["a.ts"] });
    expect(one).toContain("1 file(s) changed since this graph was indexed (a.ts)");
    expect(one).toContain("egr index <dir> --incremental");
    expect(one).toContain("egr watch <dir>");
    const many = staleNote({ filesIndexed: 9, partial: 0, failed: 0, staleFiles: 5, staleSample: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] });
    expect(many).toContain("(a.ts, b.ts, c.ts, …)");
    expect(many).not.toContain("d.ts");
    // a count with no sample still says the count
    expect(staleNote({ filesIndexed: 9, partial: 0, failed: 0, staleFiles: 2 })).toMatch(/^⚠ index is behind: 2 file\(s\) changed since this graph was indexed — /);
  });
});
