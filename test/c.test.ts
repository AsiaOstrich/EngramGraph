import { describe, it, expect } from "vitest";

import { extractCodeGraph, extractProject, detectLanguage } from "../src/code-graph/extractor.js";
import { cmdDoctor } from "../src/cli/run.js";

// XSPEC-414 R2: C is a strict subset of `queries/cpp.ts`'s shapes (no
// classes, no destructors, no namespaces/templates/references) — see
// queries/c.ts's module doc comment.

const MATH_SAMPLE = `
struct Point { int x; int y; };
union Data { int i; float f; };
enum Status { OK, FAIL };

int square(int n) { return n * n; }

int run(int x) {
    return square(x) + square(x + 1);
}
`;

describe("CodeGraph extractor — C (XSPEC-414 R2)", () => {
  it("extracts Function nodes and CALLS edges within one file", () => {
    const { nodes, edges } = extractCodeGraph(MATH_SAMPLE, { filePath: "src/math.c" });

    const functionIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(functionIds).toEqual(["src/math.c#run", "src/math.c#square"]);

    const modules = nodes.filter((n) => n.label === "Module");
    expect(modules).toHaveLength(1);
    expect(modules[0]?.id).toBe("src/math.c");

    const callsFromRun = edges
      .filter((e) => e.label === "CALLS" && e.from === "src/math.c#run")
      .map((e) => e.to);
    expect(callsFromRun).toEqual(["src/math.c#square"]);
  });

  it("extracts struct/union/enum as Class nodes", () => {
    const { nodes } = extractCodeGraph(MATH_SAMPLE, { filePath: "src/math.c" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name).sort();
    expect(classNames).toEqual(["Data", "Point", "Status"]);
  });

  it("stamps every Function node with provider: tree-sitter", () => {
    const { nodes } = extractCodeGraph(MATH_SAMPLE, { filePath: "src/math.c" });
    for (const n of nodes.filter((n) => n.label === "Function")) {
      expect(n.properties.provider).toBe("tree-sitter");
    }
  });

  it("resolves a call through a struct's function-pointer member the same way a method call would be", () => {
    const src = `
typedef struct { int (*handler)(int); } Dispatcher;
int on_request(int x) { return x; }
int run(Dispatcher d) {
    return d.handler(1);
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "src/dispatch.c" });
    const callsFromRun = edges.filter((e) => e.label === "CALLS" && e.from === "src/dispatch.c#run");
    // "handler" resolves to nothing (no Function named "handler" exists) —
    // this asserts the shape parses/attributes correctly, not that it
    // resolves; see queries/c.ts's module doc comment.
    expect(callsFromRun).toEqual([]);
  });

  it("does not create a CALLS edge for a primitive-type cast (int)(x) style call syntax", () => {
    // C has no functional-style construction ambiguity the way C++ does
    // (queries/cpp.ts's module doc comment) — included here as a same-shape
    // sanity check, not a new risk.
    const src = "int f(int x) { return (int)x; }\n";
    const { edges, nodes } = extractCodeGraph(src, { filePath: "src/cast.c" });
    expect(edges.filter((e) => e.label === "CALLS")).toEqual([]);
    expect(nodes.filter((n) => n.label === "Function").map((n) => n.id)).toEqual(["src/cast.c#f"]);
  });
});

describe("CodeGraph — C by-reference call argument", () => {
  it("captures a function passed by reference as a direct call argument", () => {
    const src = `
int on_request(int x) { return x; }
void register_handler(const char* path, int (*fn)(int)) {}
int run() {
    register_handler("/x", on_request);
    return 0;
}
`;
    const { fragment, calls } = extractProject([{ path: "a.c", source: src }]);
    expect(calls).toBe(2); // run -> register_handler, run -> on_request (by-ref arg)
    const callTargets = fragment.edges
      .filter((e) => e.label === "CALLS" && e.from === "a.c#run")
      .map((e) => e.to)
      .sort();
    expect(callTargets).toEqual(["a.c#on_request", "a.c#register_handler"]);
  });
});

describe("CodeGraph cross-file resolution — C", () => {
  it("resolves a bare call to a function defined in another file", () => {
    const { fragment, calls } = extractProject([
      { path: "mathutils.c", source: "int square(int n) {\n    return n * n;\n}\n" },
      { path: "runner.c", source: "int run(int x) {\n    return square(x);\n}\n" },
    ]);
    expect(calls).toBe(1);
    const callEdge = fragment.edges.find((e) => e.label === "CALLS");
    expect(callEdge?.from).toBe("runner.c#run");
    expect(callEdge?.to).toBe("mathutils.c#square");
  });

  it("infers the c language from the .c extension without an explicit language override", () => {
    const { edges } = extractCodeGraph("int f() { return g(); }\nint g() { return 1; }\n", {
      filePath: "x.c",
    });
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(1);
  });

  it("resolves #include \"foo.h\" into a Module -> Module IMPORTS edge (XSPEC-414 R2)", () => {
    const { fragment, imports } = extractProject([
      { path: "foo.h", source: "int helper(int x);\n" },
      { path: "main.c", source: '#include "foo.h"\nint run() { return helper(1); }\n' },
    ]);
    expect(imports).toBe(1);
    const importEdge = fragment.edges.find((e) => e.label === "IMPORTS");
    expect(importEdge).toMatchObject({ from: "main.c", to: "foo.h", fromLabel: "Module", toLabel: "Module" });
  });

  it("does not resolve a system #include <...> to any Module (the header is not in the project)", () => {
    const { imports, fragment } = extractProject([
      { path: "main.c", source: "#include <stdio.h>\nint run() { return 0; }\n" },
    ]);
    expect(imports).toBe(0);
    expect(fragment.edges.filter((e) => e.label === "IMPORTS")).toEqual([]);
  });

  it("resolves a subdirectory #include relative to the including file's own directory", () => {
    const { fragment, imports } = extractProject([
      { path: "include/foo.h", source: "int helper(int x);\n" },
      { path: "src/main.c", source: '#include "../include/foo.h"\nint run() { return helper(1); }\n' },
    ]);
    expect(imports).toBe(1);
    const importEdge = fragment.edges.find((e) => e.label === "IMPORTS");
    expect(importEdge).toMatchObject({ from: "src/main.c", to: "include/foo.h" });
  });
});

describe("XSPEC-414 R2 OQ1 — .h routes to C or C++ depending on the batch's own C++ sources", () => {
  it("a pure-C project's .h files are extracted as C, not the detectLanguage()-alone default of C++", () => {
    const { parseHealth } = extractProject([
      { path: "point.h", source: "struct Point { int x; int y; };\n" },
      { path: "main.c", source: '#include "point.h"\nint run(void) { return 0; }\n' },
    ]);
    // Directly asserts the resolved language per file — the load-bearing
    // check for OQ1's override, not just "some Class node exists" (a plain
    // struct's Class capture looks identical whether c.ts or cpp.ts produced
    // it, so that alone would not catch a regression to the C++ default).
    const pointHealth = parseHealth.find((p) => p.path === "point.h");
    expect(pointHealth?.language).toBe("c");
  });

  it("a mixed C++ project's .h files still route to C++ (existing behaviour unchanged)", () => {
    // A batch containing an unambiguous C++ source file (.cpp) alongside a
    // .h — the .h must parse with the C++ grammar, e.g. a C++-only
    // construct like a class with a method should extract cleanly.
    const { fragment } = extractProject([
      { path: "widget.h", source: "class Widget {\npublic:\n  int compute() { return 1; }\n};\n" },
      { path: "main.cpp", source: '#include "widget.h"\nint run() { Widget w; return w.compute(); }\n' },
    ]);
    const classNode = fragment.nodes.find((n) => n.label === "Class" && n.id === "widget.h#class:Widget");
    expect(classNode).toBeDefined();
    const methodNode = fragment.nodes.find((n) => n.id === "widget.h#Widget.compute");
    expect(methodNode).toBeDefined();
  });

  it("detectLanguage() alone (no project context) still defaults .h to cpp — the override lives in extractProject, not here", () => {
    expect(detectLanguage("standalone.h")).toBe("cpp");
  });
});

describe("egr doctor lists C (XSPEC-414 R2 AC-2)", () => {
  it("includes C among the reported languages", () => {
    const result = cmdDoctor("/tmp/probe-c/.engram/graph.db");
    const c = result.languages.find((l) => l.language === "c");
    expect(c).toBeDefined();
    expect(c?.label).toBe("C");
  });
});
