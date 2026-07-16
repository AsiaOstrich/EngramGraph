/**
 * XSPEC-334 R3a — parse-failure signatures.
 *
 * Covers `errorSignatures` (same gap → same signature, different gaps →
 * different, privacy: no source text) and `cmdSignatures` bucketing.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parserFor } from "../src/code-graph/extractor.js";
import { errorSignatures } from "../src/code-graph/error-signature.js";
import { cmdSignatures } from "../src/cli/run.js";
import { upsertRun, writeManifest } from "../src/code-graph/parse-manifest.js";
import type { FileParseHealth } from "../src/code-graph/parse-health.js";

const sigsOf = (src: string): string[] => errorSignatures(parserFor("typescript").parse(src).rootNode, "typescript");

describe("errorSignatures (R3a)", () => {
  it("returns [] for a clean parse", () => {
    expect(sigsOf("export function ok(){ return 1; }")).toEqual([]);
  });

  it("gives the SAME signature to two files hitting the same gap", () => {
    const a = sigsOf('export type * from "./a.js";\nexport function f(){ return 1; }');
    const b = sigsOf('export type * from "./b.js";\nexport function g(){ return 2; }');
    expect(a).toHaveLength(1);
    expect(a).toEqual(b); // same structural gap → same signature despite different names
  });

  it("gives the SAME signature to one gap at different nesting positions (position-robust)", () => {
    // Regression guard for the adversarial-review finding: a depth-3 +
    // prev-sibling skeleton split this gap into 3 buckets by nesting depth.
    // Immediate-parent + kids must merge all positions into one.
    const top = sigsOf('const m = await importOriginal<typeof import("./x.js")>();');
    const inFn = sigsOf('function g(){ const m = importOriginal<typeof import("./x.js")>(); }');
    const inIf = sigsOf('if (true){ const m = importOriginal<typeof import("./x.js")>(); }');
    expect(top).toHaveLength(1);
    expect(top).toEqual(inFn);
    expect(top).toEqual(inIf);
  });

  it("gives DIFFERENT signatures to different gaps", () => {
    const exportType = sigsOf('export type * from "./a.js";\nexport function f(){ return 1; }');
    const importOriginal = sigsOf('const m = await importOriginal<typeof import("./x.js")>();\nexport function g(){ return 1; }');
    expect(exportType[0]).not.toEqual(importOriginal[0]);
  });

  it("embeds language@grammarVersion in the signature (drift = new signature)", () => {
    const [sig] = sigsOf('export type * from "./a.js";');
    expect(sig).toMatch(/^typescript@[\w.]+:[0-9a-f]{12}$/);
  });

  it("never leaks source identifiers into the signature (privacy)", () => {
    // A distinctive identifier + string literal in the broken region.
    const [sig] = sigsOf('const SUPERSECRET = importOriginal<typeof import("./PRIVATEPATH.js")>();');
    expect(sig).not.toContain("SUPERSECRET");
    expect(sig).not.toContain("PRIVATEPATH");
  });
});

describe("cmdSignatures (R3a)", () => {
  const fph = (path: string, over: Partial<FileParseHealth> = {}): FileParseHealth => ({
    path, language: "typescript", errorNodes: 1, errorExtent: 5, sourceExtent: 30, functions: 0, classes: 0, ...over,
  });

  it("buckets partial files by signature, most-files-first", () => {
    const dir = mkdtempSync(join(tmpdir(), "engram-sigs-"));
    try {
      const path = join(dir, "graph.parse-manifest.json");
      writeManifest(
        path,
        upsertRun(null, "/root", "t", [
          fph("clean.ts", { errorNodes: 0, signatures: undefined }),
          fph("a.ts", { signatures: ["ts@1:aaa"] }),
          fph("b.ts", { signatures: ["ts@1:aaa"] }),
          fph("c.ts", { signatures: ["ts@1:aaa"] }),
          fph("d.ts", { signatures: ["ts@1:bbb"] }),
          fph("e.ts", { signatures: ["ts@1:bbb"] }),
        ], "1.0.0"),
      );
      const r = cmdSignatures(path);
      expect(r.filesWithSignatures).toBe(5);
      expect(r.buckets.map((b) => [b.signature, b.fileCount])).toEqual([
        ["ts@1:aaa", 3],
        ["ts@1:bbb", 2],
      ]);
      expect(r.buckets[0]!.sampleFiles).toEqual(["a.ts", "b.ts", "c.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty for a missing manifest", () => {
    expect(cmdSignatures(join(tmpdir(), "nope-r3a.json"))).toEqual({ filesWithSignatures: 0, buckets: [] });
  });

  it("returns empty buckets for a pre-R3a manifest (partial files, no signatures field)", () => {
    // The CLI differentiates this from "all clean" via cmdBlindspots; here we
    // just pin that cmdSignatures yields no buckets when the field is absent.
    const dir = mkdtempSync(join(tmpdir(), "engram-sigs-old-"));
    try {
      const path = join(dir, "graph.parse-manifest.json");
      writeManifest(path, upsertRun(null, "/root", "t", [fph("partial.ts", { signatures: undefined })], "1.0.0"));
      expect(cmdSignatures(path)).toEqual({ filesWithSignatures: 0, buckets: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
