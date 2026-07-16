/**
 * XSPEC-334 R4a — Tier 1 parse-conformance corpus (blocking).
 *
 * A vendored, in-repo fixture per language exercising a function + a class/
 * method — the constructs every one of egr's 13 grammars must parse cleanly.
 * The assertion is on the PARSE-HEALTH dimension specifically (`errorNodes ===
 * 0`, no signatures), which the existing per-language extraction tests do NOT
 * cover: tree-sitter's error recovery means a grammar upgrade could start
 * parsing a common construct PARTIALLY yet still extract its functions, so an
 * extraction-only test would stay green while parse health silently regressed.
 * This is the fast, deterministic, network-free regression guard for that.
 *
 * Deliberately NOT a reverse-ratchet on grammar GAPS (asserting a known gap
 * stays a gap) — that would fail the moment an upstream grammar improves. It
 * asserts only that COMMON, valid constructs parse clean; a failure here is a
 * real regression that must be seen (R4c "regression must be visible", not
 * "numbers may not move"). Tier 2 (pinned external-repo trend, R4b) and
 * baseline-snapshot approval (R4c/R4d) are deferred — see XSPEC-334 R4.
 *
 * Fixtures were confirmed to parse with errorNodes=0 against the pinned grammar
 * versions before being committed.
 */

import { describe, it, expect } from "vitest";

import { extractProject } from "../src/code-graph/extractor.js";
import type { SupportedLanguage } from "../src/code-graph/types.js";

interface Fixture {
  language: SupportedLanguage;
  path: string;
  source: string;
}

const FIXTURES: Fixture[] = [
  { language: "typescript", path: "a.ts", source: "export function f(x: number): number { return x + 1; }\nexport class C { m(): void {} }" },
  { language: "tsx", path: "a.tsx", source: "export function F(): JSX.Element { return <div>{1}</div>; }" },
  { language: "javascript", path: "a.js", source: "export function f(x){ return x+1; }\nexport class C { m(){} }" },
  { language: "csharp", path: "A.cs", source: "public class C { public int M(int x){ return x+1; } }" },
  { language: "python", path: "a.py", source: "def f(x):\n    return x + 1\n\nclass C:\n    def m(self):\n        return 1\n" },
  { language: "go", path: "a.go", source: "package main\nfunc F(x int) int { return x + 1 }\ntype T struct{}\nfunc (t T) M() int { return 1 }\n" },
  { language: "java", path: "A.java", source: "public class C { public int m(int x){ return x+1; } }" },
  { language: "kotlin", path: "a.kt", source: "fun f(x: Int): Int { return x + 1 }\nclass C { fun m(): Int { return 1 } }" },
  { language: "rust", path: "a.rs", source: "pub fn f(x: i32) -> i32 { x + 1 }\nstruct S;\nimpl S { fn m(&self) -> i32 { 1 } }" },
  { language: "cpp", path: "a.cpp", source: "int f(int x){ return x + 1; }\nclass C { public: int m(){ return 1; } };" },
  { language: "ruby", path: "a.rb", source: "def f(x)\n  x + 1\nend\n\nclass C\n  def m\n    1\n  end\nend\n" },
  { language: "php", path: "a.php", source: "<?php\nfunction f($x){ return $x + 1; }\nclass C { function m(){ return 1; } }\n" },
  { language: "dart", path: "a.dart", source: "int f(int x) { return x + 1; }\nclass C { int m() { return 1; } }" },
];

describe("parse-conformance corpus — all grammars parse common constructs cleanly (R4a)", () => {
  for (const fx of FIXTURES) {
    it(`${fx.language}: clean parse (errorNodes 0), extracts >=1 function, no signatures`, () => {
      const health = extractProject([{ path: fx.path, source: fx.source, language: fx.language }]).parseHealth[0]!;
      expect(health.failed).toBeUndefined();
      expect(health.errorNodes).toBe(0); // the conformance guard — a regression here is real
      expect(health.functions).toBeGreaterThanOrEqual(1);
      expect(health.signatures ?? []).toEqual([]); // clean code yields no failure signatures
    });
  }

  it("covers every SupportedLanguage (no grammar silently missing from the corpus)", () => {
    const covered = new Set(FIXTURES.map((f) => f.language));
    const all: SupportedLanguage[] = [
      "typescript", "tsx", "javascript", "csharp", "python", "go", "java", "kotlin", "rust", "cpp", "ruby", "php", "dart",
    ];
    for (const lang of all) expect(covered.has(lang)).toBe(true);
  });
});
