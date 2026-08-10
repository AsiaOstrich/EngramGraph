import { describe, it, expect } from "vitest";
import { extractCodeGraph } from "../src/code-graph/extractor.js";
import { unavailableGrammars } from "../src/code-graph/grammar-registry.js";
import { GRAMMARS } from "../language-support.js";

/**
 * Comment capture, asserted per grammar (XSPEC-373 R4c).
 *
 * `COMMENT_NODE_TYPES` is a hardcoded Set of four node-type names shared by
 * every grammar, and a grammar that names its comment node anything else is
 * invisible to `// implements` — silently, with no parse error and no missing
 * file. It has already happened once: Dart's `///` is its own
 * `documentation_comment` node, not folded into `comment`, and a project
 * writing `/// implements XSPEC-NNN` produced zero IMPLEMENTS edges until the
 * fourth entry was added.
 *
 * The existing conformance suite (`parse-conformance.test.ts`) asserts
 * `errorNodes === 0`, which a file whose comments are invisible passes
 * perfectly. So this walks the grammar list and asserts the actual capability,
 * rather than enumerating the node types we happen to know about. A fourteenth
 * grammar arrives with a case here automatically, and fails until its comment
 * node type is accounted for.
 */

/** Minimal parseable source per language, carrying an `implements` declaration. */
const CASES: Array<{ language: string; ext: string; source: string; doc?: string }> = [
  { language: "typescript", ext: ".ts", source: "// implements SPEC-1\nexport function f(): void {}\n", doc: "/** implements SPEC-2 */\nexport function g(): void {}\n" },
  { language: "tsx", ext: ".tsx", source: "// implements SPEC-1\nexport function f(): null { return null; }\n" },
  { language: "javascript", ext: ".js", source: "// implements SPEC-1\nexport function f() {}\n", doc: "/** implements SPEC-2 */\nexport function g() {}\n" },
  { language: "csharp", ext: ".cs", source: "// implements SPEC-1\nclass C { void M() {} }\n", doc: "/// <summary>implements SPEC-2</summary>\nclass D { void M() {} }\n" },
  { language: "python", ext: ".py", source: "# implements SPEC-1\ndef f():\n    pass\n" },
  { language: "go", ext: ".go", source: "// implements SPEC-1\npackage main\n\nfunc F() {}\n" },
  { language: "java", ext: ".java", source: "// implements SPEC-1\nclass C { void m() {} }\n", doc: "/** implements SPEC-2 */\nclass D { void m() {} }\n" },
  { language: "kotlin", ext: ".kt", source: "// implements SPEC-1\nfun f() {}\n" },
  { language: "rust", ext: ".rs", source: "// implements SPEC-1\nfn f() {}\n", doc: "/// implements SPEC-2\nfn g() {}\n" },
  { language: "cpp", ext: ".cpp", source: "// implements SPEC-1\nvoid f() {}\n" },
  { language: "ruby", ext: ".rb", source: "# implements SPEC-1\ndef f\nend\n" },
  { language: "php", ext: ".php", source: "<?php\n// implements SPEC-1\nfunction f() {}\n" },
  { language: "dart", ext: ".dart", source: "// implements SPEC-1\nvoid f() {}\n", doc: "/// implements SPEC-2\nvoid g() {}\n" },
];

const declared = GRAMMARS.map((g: { language: string }) => g.language);
const missing = declared.filter((l) => !CASES.some((c) => c.language === l));

describe("comment capture per grammar (XSPEC-373 R4c)", () => {
  it("covers every declared grammar — the list is walked, not enumerated by hand", () => {
    // Reads the grammar registry rather than restating it, so adding a
    // fourteenth language fails here until a case is written for it.
    expect(missing).toEqual([]);
  });

  const unavailable = new Set(unavailableGrammars().map((g: { language: string }) => g.language));

  for (const { language, ext, source, doc } of CASES) {
    const run = unavailable.has(language) ? it.skip : it;

    run(`${language}: a line comment yields an IMPLEMENTS edge`, () => {
      const { edges } = extractCodeGraph(source, { filePath: `src/a${ext}` });
      const impl = edges.filter((e) => e.label === "IMPLEMENTS");
      expect(impl).toHaveLength(1);
      expect(impl[0]).toMatchObject({ toLabel: "Spec", to: "SPEC-1", from: `src/a${ext}` });
    });

    if (doc) {
      run(`${language}: a doc comment yields an IMPLEMENTS edge`, () => {
        // The Dart regression was exactly this shape: the ordinary comment
        // worked while the documentation form was a distinct node type.
        const { edges } = extractCodeGraph(doc, { filePath: `src/b${ext}` });
        const impl = edges.filter((e) => e.label === "IMPLEMENTS");
        expect(impl).toHaveLength(1);
        expect(impl[0]).toMatchObject({ toLabel: "Spec", to: "SPEC-2" });
      });
    }
  }

  it("reports which grammars were skipped rather than reading as full coverage", () => {
    // A green suite where half the grammars silently did not run is the same
    // "green tick over a fraction of the surface" this spec is about.
    if (unavailable.size > 0) {
      console.warn(`[R4c] grammars unavailable on this machine, not asserted: ${[...unavailable].sort().join(", ")}`);
    }
    expect(unavailable.size).toBeLessThan(declared.length);
  });
});
