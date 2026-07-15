import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { walkFiles, toPosixPath } from "../src/cli/walk.js";

// XSPEC-333 R2b: `egr index` on a real .NET repo must not walk into
// MSBuild's generated-output dirs (`bin/`, `obj/`) — those contain
// compiler-generated .cs files (e.g. AssemblyInfo.cs, *.g.cs) that would
// duplicate real symbol names into the global name index, degrading CALLS
// resolution the same way indexing node_modules would for JS/TS.
describe("walkFiles", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-walk-"));
    writeFileSync(join(dir, "Program.cs"), "class Program {}");
    mkdirSync(join(dir, "obj", "Debug"), { recursive: true });
    writeFileSync(join(dir, "obj", "Debug", "Program.AssemblyInfo.cs"), "// generated");
    mkdirSync(join(dir, "bin", "Debug"), { recursive: true });
    writeFileSync(join(dir, "bin", "Debug", "Copy.cs"), "// generated");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips bin/ and obj/ when walking a directory for .cs files", () => {
    const files = walkFiles(dir, [".cs"]).map((f) => f.path);
    expect(files).toEqual(["Program.cs"]);
  });

  // XSPEC-333 R3 follow-up: nested subdirectories must produce `/`-separated
  // paths (the SCIP protocol's own mandated convention) on THIS host, and
  // (via toPosixPath's own dedicated tests below) on Windows too, where
  // `node:path`'s `relative()` would otherwise join segments with `\`.
  it("produces '/'-separated paths for nested subdirectories, never the raw path.relative() segments unnormalized", () => {
    mkdirSync(join(dir, "Services", "Deep"), { recursive: true });
    writeFileSync(join(dir, "Services", "Deep", "Nested.cs"), "class Nested {}");
    try {
      const files = walkFiles(dir, [".cs"]).map((f) => f.path);
      expect(files).toContain("Services/Deep/Nested.cs");
      expect(files.some((f) => f.includes("\\"))).toBe(false);
    } finally {
      rmSync(join(dir, "Services"), { recursive: true, force: true });
    }
  });
});

/**
 * XSPEC-333 R3 follow-up: `toPosixPath` is the single normalization point
 * every path-derived id in this codebase flows through (see `walk.ts`'s
 * module doc). These tests exercise it directly with manufactured
 * Windows-style (`\`-separated) input strings — this repo's sandbox has no
 * real Windows host to run `egr` on, but the normalization logic itself
 * (a pure string transform, not an OS API call) is fully verifiable this way,
 * per this task's own instruction to prove the logic with string-level unit
 * tests rather than skip verification for lack of a Windows machine.
 */
describe("toPosixPath", () => {
  it("converts a Windows-style nested relative path to '/'-separated", () => {
    expect(toPosixPath("Services\\OrderService.cs")).toBe("Services/OrderService.cs");
  });

  it("converts multiple nested levels", () => {
    expect(toPosixPath("Services\\Deep\\Nested\\Program.cs")).toBe("Services/Deep/Nested/Program.cs");
  });

  it("is a no-op on an already-POSIX path (idempotent — safe to apply unconditionally on every OS)", () => {
    expect(toPosixPath("Services/OrderService.cs")).toBe("Services/OrderService.cs");
  });

  it("is a no-op on a bare filename with no separators", () => {
    expect(toPosixPath("Program.cs")).toBe("Program.cs");
  });

  it("converts every backslash even when mixed with forward slashes", () => {
    // Not a real `path.relative()` output on any single platform, but proves
    // the fold is unconditional rather than gated on detecting "which style
    // is this string already in".
    expect(toPosixPath("Services\\Deep/Nested\\Program.cs")).toBe("Services/Deep/Nested/Program.cs");
  });

  it("applying it twice is idempotent (safe if ever accidentally called more than once)", () => {
    const once = toPosixPath("Services\\OrderService.cs");
    expect(toPosixPath(once)).toBe(once);
  });

  // Adversarial-review edge cases (Windows drive letters / UNC paths):
  // `walkFiles`' own `full` is always built via `join(root, ...)` while
  // recursing INTO `root`, so `relative(root, full)` can never legitimately
  // produce a drive-letter-prefixed or UNC absolute path in practice (that
  // only happens when the two paths are on different drives/shares, which
  // cannot occur for a path `full` derived from `root` itself). These tests
  // don't claim `toPosixPath` is a correctness fix for that scenario — only
  // that it degrades sanely (no throw, no corruption of the non-separator
  // parts) rather than silently mishandling it, since it is a plain
  // byte-level `\`->`/` fold with no path-shape assumptions.
  it("does not corrupt (though does not special-case) a hypothetical drive-letter-prefixed path", () => {
    expect(toPosixPath("C:\\Users\\dev\\Program.cs")).toBe("C:/Users/dev/Program.cs");
  });

  it("does not corrupt (though does not special-case) a hypothetical UNC path", () => {
    expect(toPosixPath("\\\\server\\share\\Program.cs")).toBe("//server/share/Program.cs");
  });
});
