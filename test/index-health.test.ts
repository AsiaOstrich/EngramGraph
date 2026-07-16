/**
 * XSPEC-334 R2 — query-side index health.
 *
 * Covers `computeIndexHealth`'s global counts + coarse directory-subtree
 * `possiblyIncomplete` match, and `cmdBlindspots`' manifest view.
 */

import { describe, it, expect } from "vitest";

import { computeIndexHealth } from "../src/code-graph/index-health.js";
import { upsertRun } from "../src/code-graph/parse-manifest.js";
import { cmdBlindspots } from "../src/cli/run.js";
import type { FileParseHealth } from "../src/code-graph/parse-health.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeManifest } from "../src/code-graph/parse-manifest.js";

const fph = (path: string, over: Partial<FileParseHealth> = {}): FileParseHealth => ({
  path,
  language: "typescript",
  errorNodes: 0,
  errorExtent: 0,
  sourceExtent: 10,
  functions: 1,
  classes: 0,
  ...over,
});

const manifestOf = (files: FileParseHealth[]) => upsertRun(null, "/root", "t", files, "1.0.0");

describe("computeIndexHealth (R2)", () => {
  it("returns null for a null manifest", () => {
    expect(computeIndexHealth(null, ["a.ts"])).toBeNull();
  });

  it("returns null for a fully healthy graph (no field, no noise)", () => {
    const m = manifestOf([fph("a.ts"), fph("b.ts")]);
    expect(computeIndexHealth(m, ["a.ts"])).toBeNull();
  });

  it("reports global counts without possiblyIncomplete when no result files given", () => {
    const m = manifestOf([fph("a.ts"), fph("bad.ts", { errorNodes: 2 }), fph("boom.ts", { failed: "x" })]);
    const h = computeIndexHealth(m, [])!;
    expect(h).toMatchObject({ filesIndexed: 3, partial: 1, failed: 1 });
    expect(h.possiblyIncomplete).toBeUndefined();
  });

  it("flags possiblyIncomplete when a blindspot shares the result's subtree", () => {
    const m = manifestOf([
      fph("domains/web/routes/foo.ts"),
      fph("domains/web/routes/__tests__/auth.test.ts", { errorNodes: 1 }),
    ]);
    const h = computeIndexHealth(m, ["domains/web/routes/foo.ts"])!;
    expect(h.possiblyIncomplete).toBe(true);
    expect(h.blindspots).toEqual(["domains/web/routes/__tests__/auth.test.ts"]);
  });

  it("does NOT flag when the blindspot is in an unrelated subtree", () => {
    const m = manifestOf([
      fph("domains/web/foo.ts"),
      fph("domains/discovery/bad.ts", { errorNodes: 1 }),
    ]);
    const h = computeIndexHealth(m, ["domains/web/foo.ts"])!;
    expect(h.partial).toBe(1); // still counted globally
    expect(h.possiblyIncomplete).toBeUndefined(); // but not flagged for THIS result
  });

  it("a top-level blindspot does not flag a nested result (conservative)", () => {
    const m = manifestOf([fph("domains/web/foo.ts"), fph("index.ts", { errorNodes: 1 })]);
    const h = computeIndexHealth(m, ["domains/web/foo.ts"])!;
    expect(h.possiblyIncomplete).toBeUndefined();
  });

  it("caps the blindspots list at 20 but reports the true total (never lies about count)", () => {
    const bad = Array.from({ length: 30 }, (_, i) => fph(`pkg/f${i}.ts`, { errorNodes: 1 }));
    const m = manifestOf([fph("pkg/ok.ts"), ...bad]);
    const h = computeIndexHealth(m, ["pkg/ok.ts"])!;
    expect(h.possiblyIncomplete).toBe(true);
    expect(h.blindspots).toHaveLength(20); // list truncated
    expect(h.blindspotsTotal).toBe(30); // but the count is honest
  });
});

describe("readManifest hardening (R2 [高] fix)", () => {
  it("returns null for a structurally-malformed manifest instead of crashing allFiles", async () => {
    const { readManifest } = await import("../src/code-graph/parse-manifest.js");
    const dir = mkdtempSync(join(tmpdir(), "engram-badmanifest-"));
    try {
      for (const bad of ["{}", "[]", '{"runs": null}', '{"runs": 42}', "not json at all"]) {
        const p = join(dir, "m.json");
        writeFileSync(p, bad);
        expect(readManifest(p)).toBeNull(); // no throw, treated as "no manifest"
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("computeIndexHealth over an all-empty manifest does not throw", () => {
    // A manifest whose runs exist but have no files (defensive `?? []`).
    const empty = manifestOf([]);
    expect(computeIndexHealth(empty, ["a.ts"])).toBeNull();
  });
});

describe("cmdBlindspots (R2b)", () => {
  it("returns empty for a missing manifest", () => {
    expect(cmdBlindspots(join(tmpdir(), "nope-xspec334-r2.json"))).toEqual({
      filesIndexed: 0,
      partial: 0,
      failed: 0,
      blindspots: [],
    });
  });

  it("lists unhealthy files worst-first (failed before partial)", () => {
    const dir = mkdtempSync(join(tmpdir(), "engram-blindspots-"));
    try {
      const path = join(dir, "graph.parse-manifest.json");
      writeManifest(
        path,
        manifestOf([
          fph("clean.ts"),
          fph("partial-lo.ts", { errorNodes: 1 }),
          fph("partial-hi.ts", { errorNodes: 5 }),
          fph("boom.ts", { failed: "threw" }),
        ]),
      );
      const r = cmdBlindspots(path);
      expect(r).toMatchObject({ filesIndexed: 4, partial: 2, failed: 1 });
      expect(r.blindspots.map((b) => b.path)).toEqual(["boom.ts", "partial-hi.ts", "partial-lo.ts"]);
      expect(r.blindspots[0]).toMatchObject({ path: "boom.ts", failed: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
