/**
 * XSPEC-414 R1 Scenario (second half): a file whose extension has no grammar
 * at all must be SKIPPED, not silently parsed as JavaScript.
 *
 * Before this fix, `detectLanguage` defaulted any unmatched extension to
 * `"javascript"`, so `extractProject`/`indexProject` (and therefore MCP's
 * `index_code`, which accepts any path an MCP client sends — unlike the CLI,
 * whose `walkFiles(dir, CODE_EXTS)` never even offers such a file) would run
 * a `.zig` file through the JS tree-sitter grammar and emit
 * plausible-looking-but-wrong Function/Class nodes for it.
 *
 * Originally written against `.swift`/`.sh` as the example unrecognized
 * extensions; both gained real grammars in XSPEC-414 R3/R4, so this file now
 * uses `.zig`/`.lua` (still outside this engine's language set) to keep
 * testing "an extension with no grammar at all", not something that happens
 * to be Swift or Bash. Swift/Bash's own extraction coverage lives in
 * `test/swift.test.ts` / `test/bash.test.ts`.
 */
import { describe, it, expect } from "vitest";

import { extractProject, extractCodeGraph, collectExtraction } from "../src/code-graph/extractor.js";

const TS_FILE = {
  path: "src/app.ts",
  source: "export function hello(){ return world(); }\nexport function world(){ return 1; }\n",
};
const ZIG_FILE = {
  path: "src/main.zig",
  // Deliberately something that WOULD parse "successfully" (if wrongly) as
  // JavaScript — `fn` is not valid JS, but tree-sitter's error recovery
  // means this would not throw, it would just produce garbage nodes. The
  // real regression check is "no nodes came from this file at all", not
  // "parsing failed".
  source: "fn greet() void {\n  print(\"hi\");\n}\n",
};

describe("extractProject skips files with an unrecognized extension (XSPEC-414 R1)", () => {
  it("does not create any node from the unrecognized file's content", () => {
    const result = extractProject([TS_FILE, ZIG_FILE]);
    const zigNodes = result.fragment.nodes.filter((n) => String(n.id).startsWith("src/main.zig"));
    expect(zigNodes).toEqual([]);
  });

  it("still indexes the recognized file normally", () => {
    const result = extractProject([TS_FILE, ZIG_FILE]);
    const tsFunctions = result.fragment.nodes.filter(
      (n) => n.label === "Function" && String(n.id).startsWith("src/app.ts"),
    );
    expect(tsFunctions.length).toBeGreaterThanOrEqual(2);
    expect(result.calls).toBeGreaterThanOrEqual(1);
  });

  it("reports the skipped file's extension and count in skippedUnrecognized", () => {
    const result = extractProject([TS_FILE, ZIG_FILE]);
    expect(result.skippedUnrecognized).toEqual([{ ext: ".zig", files: 1 }]);
  });

  it("does NOT count the unrecognized file in `files` (only successfully-processed files are)", () => {
    const result = extractProject([TS_FILE, ZIG_FILE]);
    expect(result.files).toBe(1);
  });

  it("groups multiple unrecognized extensions independently, each with its own count", () => {
    const luaFile = { path: "build.lua", source: "print('hi')\n" };
    const zig2 = { path: "src/other.zig", source: "fn other() void {}\n" };
    const result = extractProject([TS_FILE, ZIG_FILE, zig2, luaFile]);
    const byExt = new Map(result.skippedUnrecognized.map((s) => [s.ext, s.files]));
    expect(byExt.get(".zig")).toBe(2);
    expect(byExt.get(".lua")).toBe(1);
  });

  it("an extension-less file is grouped under '(none)'", () => {
    const noExt = { path: "Makefile", source: "all:\n\techo hi\n" };
    const result = extractProject([noExt]);
    expect(result.skippedUnrecognized).toEqual([{ ext: "(none)", files: 1 }]);
  });

  it("skippedUnrecognized is empty for a project with no unrecognized files (empty is normal)", () => {
    const result = extractProject([TS_FILE]);
    expect(result.skippedUnrecognized).toEqual([]);
  });
});

describe("single-file APIs throw on an unrecognized extension instead of silently guessing javascript (XSPEC-414 R1)", () => {
  it("collectExtraction throws", () => {
    expect(() => collectExtraction(ZIG_FILE.source, { filePath: ZIG_FILE.path })).toThrow(
      /unrecognized/i,
    );
  });

  it("extractCodeGraph throws", () => {
    expect(() => extractCodeGraph(ZIG_FILE.source, { filePath: ZIG_FILE.path })).toThrow(
      /unrecognized/i,
    );
  });

  it("an explicit opts.language override still works, bypassing detection entirely", () => {
    // Force it to be parsed as Zig's... well, there is no Zig grammar in
    // this engine — so force a language that DOES exist, proving the
    // override path itself still works regardless of what the extension
    // would have detected as.
    const result = extractCodeGraph("function f(){ return 1; }", {
      filePath: ZIG_FILE.path,
      language: "javascript",
    });
    expect(result.nodes.some((n) => n.label === "Function")).toBe(true);
  });
});
