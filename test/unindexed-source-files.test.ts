import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { walkFiles, summarizeUnindexed, UNINDEXED_TOP_N } from "../src/cli/walk.js";
import { CODE_EXTS } from "../src/cli/run.js";

/**
 * XSPEC-414 R1 — "unsupported files are invisible" fix, walk-level half.
 *
 * `walkFiles` used to report only what it collected. A file whose extension
 * wasn't in `exts` simply never appeared anywhere, so a user indexing a repo
 * with (say) Swift files had no way to learn "your index is missing N files"
 * short of noticing the file count looked low. This suite exercises the new
 * `unindexed` accounting the CLI summary (`egr index`) is built on top of.
 */
describe("walkFiles unindexed-file accounting (XSPEC-414 R1)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-unindexed-"));
    writeFileSync(join(dir, "app.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "main.swift"), "print(\"hi\")\n");
    writeFileSync(join(dir, "build.sh"), "#!/bin/sh\necho hi\n");
    // A second .swift file so the "grouped by extension" behaviour has
    // something to actually group.
    writeFileSync(join(dir, "App.swift"), "print(\"again\")\n");
    // A binary file (PNG-ish: starts with a NUL byte) must NOT be counted —
    // it is not "unsupported source code", it isn't source code at all.
    writeFileSync(join(dir, "logo.png"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
    // A .d.ts file is an EXISTING, deliberate exclusion (declaration files
    // carry no runtime code) — must not be counted as "unsupported".
    writeFileSync(join(dir, "types.d.ts"), "export type X = number;\n");
    // Excluded directories must not contribute either.
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "vendor.rlib"), "not source");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "config"), "[core]\n");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports files matched by exts in `files`, as before", () => {
    const { files } = walkFiles(dir, CODE_EXTS);
    expect(files.map((f) => f.path).sort()).toEqual(["app.ts"]);
  });

  it("reports files seen but not covered by exts in `unindexed`", () => {
    const { unindexed } = walkFiles(dir, CODE_EXTS);
    const byPath = new Map(unindexed.map((f) => [f.path, f.ext]));
    expect(byPath.get("main.swift")).toBe(".swift");
    expect(byPath.get("App.swift")).toBe(".swift");
    expect(byPath.get("build.sh")).toBe(".sh");
  });

  it("excludes binary files from `unindexed`", () => {
    const { unindexed } = walkFiles(dir, CODE_EXTS);
    expect(unindexed.some((f) => f.path === "logo.png")).toBe(false);
  });

  it("excludes .d.ts files from `unindexed` (existing, deliberate exclusion, not a coverage gap)", () => {
    const { unindexed } = walkFiles(dir, CODE_EXTS);
    expect(unindexed.some((f) => f.path === "types.d.ts")).toBe(false);
  });

  it("excludes files under node_modules/ and .git/ from `unindexed`, same as `files`", () => {
    const { unindexed } = walkFiles(dir, CODE_EXTS);
    expect(unindexed.some((f) => f.path.includes("node_modules"))).toBe(false);
    expect(unindexed.some((f) => f.path.includes(".git"))).toBe(false);
  });

  it("`unindexed` count matches the Scenario in XSPEC-414 R1: 2 unindexed files for a swift+sh+ts mix", () => {
    // A fresh, minimal dir matching the spec's Scenario exactly (this describe
    // block's shared `dir` has extra fixtures for the other assertions above).
    const scenarioDir = mkdtempSync(join(tmpdir(), "engram-unindexed-scenario-"));
    try {
      writeFileSync(join(scenarioDir, "main.swift"), "print(1)\n");
      writeFileSync(join(scenarioDir, "build.sh"), "echo hi\n");
      writeFileSync(join(scenarioDir, "app.ts"), "export const x = 1;\n");
      const { files, unindexed } = walkFiles(scenarioDir, CODE_EXTS);
      expect(files.map((f) => f.path)).toEqual(["app.ts"]);
      expect(unindexed).toHaveLength(2);
    } finally {
      rmSync(scenarioDir, { recursive: true, force: true });
    }
  });
});

describe("summarizeUnindexed", () => {
  it("groups by extension, largest group first", () => {
    const summary = summarizeUnindexed([
      { path: "a.swift", ext: ".swift" },
      { path: "b.swift", ext: ".swift" },
      { path: "c.sh", ext: ".sh" },
    ]);
    expect(summary.count).toBe(3);
    expect(summary.topExtensions).toEqual([
      { ext: ".swift", count: 2 },
      { ext: ".sh", count: 1 },
    ]);
  });

  it("breaks ties alphabetically for a deterministic order", () => {
    const summary = summarizeUnindexed([
      { path: "a.zzz", ext: ".zzz" },
      { path: "a.aaa", ext: ".aaa" },
    ]);
    expect(summary.topExtensions.map((e) => e.ext)).toEqual([".aaa", ".zzz"]);
  });

  it("caps at the given topN, but `count` still reflects every file", () => {
    const files = Array.from({ length: 15 }, (_, i) => ({
      path: `f${i}.ext${i}`,
      ext: `.ext${i}`,
    }));
    const summary = summarizeUnindexed(files, 5);
    expect(summary.count).toBe(15);
    expect(summary.topExtensions).toHaveLength(5);
  });

  it("defaults topN to UNINDEXED_TOP_N", () => {
    const files = Array.from({ length: UNINDEXED_TOP_N + 5 }, (_, i) => ({
      path: `f${i}.ext${i}`,
      ext: `.ext${i}`,
    }));
    const summary = summarizeUnindexed(files);
    expect(summary.topExtensions).toHaveLength(UNINDEXED_TOP_N);
  });

  it("returns an empty summary for no unindexed files", () => {
    expect(summarizeUnindexed([])).toEqual({ count: 0, topExtensions: [] });
  });
});
