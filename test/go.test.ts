import { describe, it, expect } from "vitest";

import { extractCodeGraph, extractProject } from "../src/code-graph/extractor.js";
import { runTagQuery } from "../src/code-graph/tag-query-engine.js";
import { tagsQuerySourceFor } from "../src/code-graph/queries/index.js";
import Go from "tree-sitter-go";
import Parser from "tree-sitter";

// XSPEC-333 R2c: Go is the first language on the generic tag-query engine
// with no `class` construct at all (methods attach to a type via a
// *receiver*, never lexically nested inside that type's declaration) — this
// file exercises the same DEFINES/CALLS/scope-qualification shapes
// test/csharp.test.ts already covers, but through `.go` source, plus Go's
// own type-conversion-vs-call ambiguity (see queries/go.ts's module doc).

function parseGo(source: string) {
  const parser = new Parser();
  parser.setLanguage(Go);
  return parser.parse(source);
}

const CALCULATOR_SAMPLE = `package sample

type Calculator struct {
	base int
}

func (c *Calculator) Compute(x int) int {
	return square(x) + c.Helper()
}

func (c *Calculator) Helper() int {
	return c.base
}

func square(n int) int {
	return n * n
}
`;

describe("CodeGraph extractor — Go (XSPEC-333 R2c)", () => {
  it("extracts Module and Function nodes (incl. methods) with CALLS edges", () => {
    const { nodes, edges } = extractCodeGraph(CALCULATOR_SAMPLE, { filePath: "src/calculator.go" });

    // Go methods are NOT scope-qualified by receiver type (see queries/go.ts
    // module doc — a method_declaration is a top-level sibling of its
    // receiver type's declaration, never nested inside it), so ids are bare
    // function/method names.
    const functions = nodes.filter((n) => n.label === "Function").map((n) => n.properties.name).sort();
    expect(functions).toEqual(["Compute", "Helper", "square"]);

    const modules = nodes.filter((n) => n.label === "Module");
    expect(modules).toHaveLength(1);
    expect(modules[0]?.id).toBe("src/calculator.go");

    const defines = edges.filter((e) => e.label === "DEFINES");
    expect(defines).toHaveLength(3);

    const callsFromCompute = edges
      .filter((e) => e.label === "CALLS" && e.from === "src/calculator.go#Compute")
      .map((e) => e.to)
      .sort();
    expect(callsFromCompute).toEqual(["src/calculator.go#Helper", "src/calculator.go#square"]);
  });

  it("stamps every Function node with provider: tree-sitter", () => {
    const { nodes } = extractCodeGraph(CALCULATOR_SAMPLE, { filePath: "src/calculator.go" });
    for (const n of nodes.filter((n) => n.label === "Function")) {
      expect(n.properties.provider).toBe("tree-sitter");
    }
  });

  it("captures struct and interface type declarations as Class nodes (low-cost bonus scope, no CALLS involvement)", () => {
    const src = `package shapes

type Point struct {
	X, Y int
}

type Shape interface {
	Area() float64
}
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "shapes.go" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name).sort();
    expect(classNames).toEqual(["Point", "Shape"]);
    // Class nodes never contribute a CALLS/DEFINES edge for Go — no method
    // is ever lexically nested inside a type's own declaration.
    expect(edges.filter((e) => e.label === "DEFINES" && e.to.includes("class:"))).toHaveLength(0);
  });

  // Documented, tested consequence of not receiver-qualifying method ids
  // (see queries/go.ts module doc and extractor.ts's qualifyFunctions
  // call-site comment): two DIFFERENT receiver types' methods sharing a
  // name collapse onto one shared id — mirroring test/csharp.test.ts's
  // overload-collapse regression test, but for a more commonly-hit Go case.
  it("collapses two different receiver types' same-named methods onto one shared id (documented limitation, not a crash)", () => {
    const src = `package sample

type A struct{}
type B struct{}

func (a A) Close() error { return nil }
func (b B) Close() error { return nil }
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "closers.go" });
    const functionNodes = nodes.filter((n) => n.label === "Function");
    expect(functionNodes).toHaveLength(2); // one per receiver type, not deduped
    expect(functionNodes.every((n) => n.id === "closers.go#Close")).toBe(true); // same id
    expect(edges.filter((e) => e.label === "DEFINES")).toHaveLength(2); // both DEFINES edges emitted
  });

  it("scope-qualifies a func literal bound to a variable inside a function, distinct from its call site", () => {
    const src = `package sample

func main() {
	log := func(m string) { println(m) }
	log("hi")
}
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "main.go" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(fnIds).toEqual(["main.go#main", "main.go#main.log"]);

    const callsFromMain = edges
      .filter((e) => e.label === "CALLS" && e.from === "main.go#main")
      .map((e) => e.to);
    expect(callsFromMain).toEqual(["main.go#main.log"]);
  });

  it("captures a func literal bound via 'var', not just ':='", () => {
    const src = `package sample

func main() {
	var log = func(m string) { println(m) }
	log("hi")
}
`;
    const { nodes } = extractCodeGraph(src, { filePath: "var.go" });
    const fnNames = nodes.filter((n) => n.label === "Function").map((n) => n.properties.name).sort();
    expect(fnNames).toEqual(["log", "main"]);
  });

  // Regression for the adversarial-review-caught cross-pairing bug: a naive
  // (unanchored) func-literal-binding pattern wrongly paired every name on
  // the left with every func_literal on the right of a multi-value ":="
  // declaration. The fix (single-element anchors) must miss this case
  // entirely rather than mis-name the function.
  it("does not fabricate a wrongly-named Function definition for a multi-value short variable declaration mixing a func literal", () => {
    const src = `package sample

func main() {
	a, f := 1, func() {}
	_ = a
	f()
}
`;
    const { nodes } = runTagQueryFunctionNames(src);
    // The single func_literal here must not be captured at all (anchored
    // pattern requires exactly one name / one value on each side) — in
    // particular "a" must never appear as a captured definition name.
    expect(nodes).not.toContain("a");
  });

  function runTagQueryFunctionNames(src: string): { nodes: string[] } {
    const { definitions } = runTagQuery(Go, "go", tagsQuerySourceFor("go"), parseGo(src).rootNode);
    return { nodes: definitions.filter((d) => d.kind === "function").map((d) => d.name) };
  }

  // Regression for Go's own false-positive risk (analogous to C#'s
  // nameof/named-argument lessons): type-conversion syntax (`int(x)`) parses
  // identically to a real call. Builtin/predeclared type names must be
  // excluded via the query's #not-any-of? predicate.
  it("does not treat a builtin type conversion (int(x)) as a call", () => {
    const src = `package sample

func Helper(n int) int { return n }

func main() {
	x := 5
	y := int(x)
	z := Helper(x)
	_ = y
	_ = z
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "conv.go" });
    const callsFromMain = edges
      .filter((e) => e.label === "CALLS" && e.from === "conv.go#main")
      .map((e) => e.to);
    expect(callsFromMain).toEqual(["conv.go#Helper"]); // NOT a spurious call to "int"
  });

  it("does not exclude a real function that happens to share a name pattern with builtin conversions (sanity check on the exclusion list)", () => {
    // "stringify" is not in the excluded builtin-type-name list (only the
    // exact predeclared type names are excluded) — must still resolve.
    const src = `package sample

func stringify(n int) string { return "" }

func main() {
	_ = stringify(5)
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "notbuiltin.go" });
    const callsFromMain = edges
      .filter((e) => e.label === "CALLS" && e.from === "notbuiltin.go#main")
      .map((e) => e.to);
    expect(callsFromMain).toEqual(["notbuiltin.go#stringify"]);
  });

  // Regression for the DEC-095-style by-reference-argument pattern's Go
  // analogue, including the "true positive, not false positive" case found
  // during this file's development (http.HandlerFunc(myHandler) is *also*
  // syntactically a type conversion, but the argument is a genuine function
  // reference).
  it("captures a CALLS edge when a function is passed by reference as a direct call argument", () => {
    const src = `package sample

func handlerFunc() {}

func register(path string, h func()) {}

func setup() {
	register("/x", handlerFunc)
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "setup.go" });
    const callsFromSetup = edges
      .filter((e) => e.label === "CALLS" && e.from === "setup.go#setup")
      .map((e) => e.to)
      .sort();
    expect(callsFromSetup).toEqual(["setup.go#handlerFunc", "setup.go#register"]);
  });
});

describe("CodeGraph cross-file resolution — Go", () => {
  it("resolves a package-qualified selector call to a function defined in another file", () => {
    const { fragment, calls } = extractProject([
      {
        path: "mathutils.go",
        source: "package mathutils\n\nfunc Square(n int) int {\n\treturn n * n\n}\n",
      },
      {
        path: "runner.go",
        source: "package runner\n\nfunc Run(x int) int {\n\treturn mathutils.Square(x)\n}\n",
      },
    ]);
    expect(calls).toBe(1);
    const callEdge = fragment.edges.find((e) => e.label === "CALLS");
    expect(callEdge?.from).toBe("runner.go#Run");
    expect(callEdge?.to).toBe("mathutils.go#Square");
  });

  it("infers the go language from the .go extension without an explicit language override", () => {
    const { edges } = extractCodeGraph(
      "package sample\n\nfunc f() int { return g() }\nfunc g() int { return 1 }\n",
      { filePath: "x.go" },
    );
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(1);
  });
});
