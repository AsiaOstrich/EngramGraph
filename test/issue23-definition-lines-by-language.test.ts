// SPDX-License-Identifier: MIT
// implements XSPEC-514
import { describe, it, expect } from "vitest";

import { collectExtraction } from "../src/code-graph/extractor.js";

/**
 * Issue #23, step 1: which languages put several definitions on one Function id, and so record `definition_lines`.
 *
 * The id (`<file>#<Class>.<name>`) is built by one shared function for every language, so the answer is a property
 * of what each language's tag query captures, not of the new code. This pins it per language, with the extractor
 * as a unit; the entry-point proof (CLI text/--json, MCP, exit codes) is in issue23-same-file-overloads.test.ts
 * and runs on C#.
 */

function fnRows(file: string, src: string): Array<{ id: string; lines: string | null; startLine: number }> {
  return collectExtraction(src, { filePath: file }).nodes
    .filter((n) => n.label === "Function")
    .map((n) => ({ id: n.id, lines: n.properties.definition_lines as string | null, startLine: n.properties.start_line as number }));
}

describe("issue #23: definition_lines per language (same id, several definitions)", () => {
  const overloaded: Array<[string, string, string, string]> = [
    ["csharp", "a.cs", "public static class R {\n public static int V(A a) { return 1; }\n public static int V(B b) { return 2; }\n}\n", "a.cs#R.V"],
    ["java", "A.java", "class R {\n int v(String a) { return 1; }\n int v(int b) { return 2; }\n}\n", "A.java#R.v"],
    ["kotlin", "a.kt", "class R {\n fun v(a: String): Int { return 1 }\n fun v(b: Int): Int { return 2 }\n}\n", "a.kt#R.v"],
    ["cpp", "a.cpp", "class R {\npublic:\n int v(int a) { return 1; }\n int v(double b) { return 2; }\n};\n", "a.cpp#R.v"],
    ["swift", "a.swift", "class R {\n func v(_ a: Int) -> Int { return 1 }\n func v(_ a: String) -> Int { return 2 }\n}\n", "a.swift#R.v"],
    ["python (redefinition)", "a.py", "class R:\n    def v(self, a): return 1\n    def v(self, b): return 2\n", "a.py#R.v"],
    ["ruby (redefinition)", "a.rb", "class R\n def v; 1; end\n def v; 2; end\nend\n", "a.rb#R.v"],
    ["typescript (redeclaration)", "c.ts", "function v() { return 1; }\nfunction v() { return 2; }\n", "c.ts#v"],
    ["javascript (redeclaration)", "c.js", "function v() { return 1; }\nfunction v() { return 2; }\n", "c.js#v"],
    ["go (two receivers, one method name)", "a.go", 'package p\ntype A struct{}\ntype B struct{}\nfunc (a A) String() string { return "a" }\nfunc (b B) String() string { return "b" }\n', "a.go#String"],
  ];

  for (const [lang, file, src, id] of overloaded) {
    it(`${lang}: both definitions are on one id and the row lists both lines`, () => {
      const rows = fnRows(file, src).filter((r) => r.id === id);
      expect(rows).toHaveLength(2);
      const lines = JSON.parse(rows[0]!.lines!) as number[];
      expect(lines).toHaveLength(2);
      expect(lines).toEqual(rows.map((r) => r.startLine));
      // every node of the id carries the same full list, so the row is right whichever is written last
      expect(rows[1]!.lines).toBe(rows[0]!.lines);
    });
  }

  it("a typescript overload SIGNATURE is not a definition: the one implementation is one definition, NULL", () => {
    const rows = fnRows("b.ts", "function v(a: string): number;\nfunction v(a: number): number;\nfunction v(a: any): number { return 1; }\n");
    expect(rows).toEqual([{ id: "b.ts#v", lines: null, startLine: 3 }]);
    const cls = fnRows("a.ts", "class R {\n v(a: string): number;\n v(a: number): number;\n v(a: any): number { return 1; }\n}\n");
    expect(cls).toEqual([{ id: "a.ts#R.v", lines: null, startLine: 4 }]);
  });

  it("languages whose ids already differ per scope (rust impls, php/dart classes) record NULL", () => {
    expect(fnRows("a.rs", "struct A; struct B;\nimpl A { fn new() -> A { A } }\nimpl B { fn new() -> B { B } }\n").map((r) => r.lines)).toEqual([null, null]);
    expect(fnRows("a.php", "<?php\nclass R {\n function v() { return 1; }\n}\nclass S {\n function v() { return 2; }\n}\n").map((r) => r.lines)).toEqual([null, null]);
  });

  it("a function defined once records NULL (which also clears the list when an overload is removed)", () => {
    expect(fnRows("one.cs", "public class C {\n void M(int x) { }\n}\n")).toEqual([{ id: "one.cs#C.M", lines: null, startLine: 2 }]);
  });
});
