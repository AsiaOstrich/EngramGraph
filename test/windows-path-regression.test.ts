import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * XSPEC-333 R3 follow-up — regression tests an adversarial (fable) review of
 * the initial path-separator fix caught were MISSING:
 *
 *  - the first fix only added `toPosixPath` inside `walkFiles`, but every
 *    existing test either ran on this (POSIX) host — where `path.relative()`
 *    already returns `/`-separated strings, making the normalization call a
 *    no-op the test suite could not tell apart from its absence — or tested
 *    `toPosixPath` as a pure function directly, never through `walkFiles`
 *    itself. Removing the `toPosixPath(...)` call from `walkFiles` would NOT
 *    have failed any pre-existing test. This file's first `describe` closes
 *    that gap by mocking `node:path`'s `relative` to return Windows-style
 *    (`\`-separated) output regardless of host OS, so `walkFiles`' own
 *    normalization is actually exercised.
 *  - the review also caught that `walkFiles` is NOT the only place a
 *    path-derived id gets built: `mcp/server.ts`'s `index_code`/`index_docs`
 *    tools accept a caller-supplied `path` directly, bypassing `walkFiles`
 *    entirely — so a Windows MCP client would still mint `\`-separated ids
 *    even after the `walkFiles`-only fix. The follow-up fix moved the
 *    normalization into `extractor.ts`'s `collectExtraction` (the actual
 *    common choke point both entry points funnel through). This file's
 *    second `describe` proves THAT fix: a raw, un-normalized `\`-separated
 *    `filePath` (simulating what an MCP tool call would pass through
 *    untouched) produces the exact same ids as the `/`-separated equivalent
 *    `walkFiles` would have produced for the same logical file.
 */

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    default: {
      ...actual,
      // Simulate a real Windows `relative()`: same segments as the real
      // (POSIX, on this host) result, but `\`-joined — reproducing exactly
      // what `path.relative()` returns on a real Windows machine, without
      // needing one.
      relative: (from: string, to: string) => actual.relative(from, to).split(actual.sep).join("\\"),
    },
    relative: (from: string, to: string) => actual.relative(from, to).split(actual.sep).join("\\"),
  };
});

describe("walkFiles + simulated win32 path.relative(): output is still '/'-separated", () => {
  it("normalizes a mocked-Windows-style relative() result — would fail if walkFiles' toPosixPath call were removed", async () => {
    const { walkFiles } = await import("../src/cli/walk.js");
    const dir = mkdtempSync(join(tmpdir(), "engram-walk-win32-"));
    try {
      mkdirSync(join(dir, "Services", "Deep"), { recursive: true });
      writeFileSync(join(dir, "Services", "Deep", "Nested.cs"), "class Nested {}");
      writeFileSync(join(dir, "Program.cs"), "class Program {}");

      const files = walkFiles(dir, [".cs"]).map((f) => f.path);

      // With the mocked win32-style `relative()` above, this is exactly the
      // regression case: without `toPosixPath` inside `walkFiles`, these
      // would come back as "Services\\Deep\\Nested.cs" and "Program.cs"
      // (the latter has no separator either way, so it alone would NOT have
      // caught this regression — the nested case is essential).
      expect(files).toContain("Services/Deep/Nested.cs");
      expect(files).toContain("Program.cs");
      expect(files.some((f) => f.includes("\\"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("collectExtraction/extractCodeGraph: MCP-style caller-supplied '\\'-separated filePath still produces '/'-separated ids", () => {
  it("a raw backslash filePath (as mcp/server.ts's index_code would pass through un-normalized) yields the SAME ids as the '/'-separated equivalent walkFiles would have produced", async () => {
    // Fresh, unmocked import of extractor.ts — this describe block does NOT
    // want the node:path mock above (extractor.ts doesn't call path.relative
    // at all, so it's unaffected either way, but importing it fresh here
    // keeps this test's intent — "a caller hands collectExtraction a raw
    // Windows-shaped string directly" — independent of the walkFiles mock).
    const { extractCodeGraph } = await import("../src/code-graph/extractor.js");

    const source = "function bar() {}\nfunction foo() { bar(); }\n";

    const posixResult = extractCodeGraph(source, { filePath: "Services/Foo.ts", language: "typescript" });
    const backslashResult = extractCodeGraph(source, { filePath: "Services\\Foo.ts", language: "typescript" });

    const posixIds = posixResult.nodes.map((n) => n.id).sort();
    const backslashIds = backslashResult.nodes.map((n) => n.id).sort();

    // The whole point: an MCP client on Windows passing "Services\\Foo.ts"
    // must converge onto the IDENTICAL Module/Function ids a POSIX-walked
    // "Services/Foo.ts" produces, not a second, orphaned set of nodes for
    // "the same" logical file.
    expect(backslashIds).toEqual(posixIds);
    expect(posixIds).toContain("Services/Foo.ts");
    expect(posixIds.some((id) => id.includes("\\"))).toBe(false);
    expect(backslashIds.some((id) => id.includes("\\"))).toBe(false);

    // CALLS edges (bar <- foo) must also line up, not just node ids.
    const posixCalls = posixResult.edges.filter((e) => e.label === "CALLS").map((e) => `${e.from}->${e.to}`);
    const backslashCalls = backslashResult.edges.filter((e) => e.label === "CALLS").map((e) => `${e.from}->${e.to}`);
    expect(backslashCalls).toEqual(posixCalls);
    expect(posixCalls.length).toBeGreaterThan(0);
  });
});
