import { describe, it, expect } from "vitest";

import { extractCodeGraph, extractProject, collectExtraction } from "../src/code-graph/extractor.js";
import { runTagQuery } from "../src/code-graph/tag-query-engine.js";
import { tagsQuerySourceFor } from "../src/code-graph/queries/index.js";
import Dart from "@vokturz/tree-sitter-dart";
import Parser from "tree-sitter";

// XSPEC-333 R2c batch 3: Dart is the hardest of the three languages in this
// batch, both on the packaging side (see grammars.d.ts's module doc comment
// for why @vokturz/tree-sitter-dart was the only viable candidate) and on
// the grammar side (a two-level definition-wrapper shape — see
// queries/dart.ts's module doc comment).

function parseDart(source: string) {
  const parser = new Parser();
  parser.setLanguage(Dart);
  return parser.parse(source);
}

const CALCULATOR_SAMPLE = `
class Calculator {
  int compute(int x) {
    return square(x) + helper();
  }

  int helper() {
    return base;
  }
}

int square(int n) {
  return n * n;
}
`;

describe("CodeGraph extractor — Dart (XSPEC-333 R2c batch 3)", () => {
  it("extracts Module and Function nodes (incl. methods, outer-wrapper range including body) with CALLS edges", () => {
    const { nodes, edges } = extractCodeGraph(CALCULATOR_SAMPLE, { filePath: "calculator.dart" });

    const functionIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(functionIds).toEqual([
      "calculator.dart#Calculator.compute",
      "calculator.dart#Calculator.helper",
      "calculator.dart#square",
    ]);

    const modules = nodes.filter((n) => n.label === "Module");
    expect(modules).toHaveLength(1);

    const callsFromCompute = edges
      .filter((e) => e.label === "CALLS" && e.from === "calculator.dart#Calculator.compute")
      .map((e) => e.to)
      .sort();
    expect(callsFromCompute).toEqual([
      "calculator.dart#Calculator.helper",
      "calculator.dart#square",
    ]);
  });

  it("stamps every Function node with provider: tree-sitter", () => {
    const { nodes } = extractCodeGraph(CALCULATOR_SAMPLE, { filePath: "calculator.dart" });
    for (const n of nodes.filter((n) => n.label === "Function")) {
      expect(n.properties.provider).toBe("tree-sitter");
    }
  });

  it("captures mixin and extension declarations as bonus Class-like scope containers", () => {
    const src = `
mixin Loud {
  void shout() {
    speak();
  }
}

extension StringExt on String {
  void yell() {
    print(this);
  }
}

void speak() {
}
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "mixins.dart" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name).sort();
    expect(classNames).toEqual(["Loud", "StringExt"]);
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(fnIds).toEqual(["mixins.dart#Loud.shout", "mixins.dart#StringExt.yell", "mixins.dart#speak"]);
    expect(
      edges.some(
        (e) => e.label === "CALLS" && e.from === "mixins.dart#Loud.shout" && e.to === "mixins.dart#speak",
      ),
    ).toBe(true);
  });

  it("scope-qualifies a getter and setter sharing a name onto the same collapsed id (documented overload-collapse limitation)", () => {
    const src = `
class Foo {
  int get value => _value;
  set value(int v) {
    _value = v;
  }
  int _value = 0;
}
`;
    const { nodes } = extractCodeGraph(src, { filePath: "getset.dart" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id);
    expect(fnIds).toEqual(["getset.dart#Foo.value", "getset.dart#Foo.value"]);
  });

  // Regression for an adversarial-review finding (XSPEC-333 R2c batch 3):
  // a TOP-LEVEL getter/setter (outside any class) uses a THIRD/FOURTH
  // wrapper shape (getter_definition/setter_definition), not
  // method_definition (method_signature (getter_signature ...)) the way a
  // class member is wrapped — before this fix, top-level getters/setters
  // produced ZERO Function nodes at all.
  it("captures a top-level getter and setter (outside any class) as Function nodes", () => {
    const src = `
int get answer => 42;

set answer(int v) {
  print(v);
}
`;
    const { nodes } = extractCodeGraph(src, { filePath: "toplevel_getset.dart" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(fnIds).toEqual(["toplevel_getset.dart#answer", "toplevel_getset.dart#answer"]);
  });

  it("resolves a call inside a top-level getter's body", () => {
    const src = `
int helper() {
  return 42;
}

int get answer {
  return helper();
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "toplevel_getter_body.dart" });
    const callsFromAnswer = edges
      .filter((e) => e.label === "CALLS" && e.from === "toplevel_getter_body.dart#answer")
      .map((e) => e.to);
    expect(callsFromAnswer).toEqual(["toplevel_getter_body.dart#helper"]);
  });

  // Regression: this file's first draft only verified the "///" line-doc
  // spelling links to an IMPLEMENTS edge; adversarial review found the
  // "/** */" block-doc spelling is ALSO documentation_comment (not plain
  // comment) and should behave identically.
  it("links a block-style /** implements XSPEC-NNN */ doc comment to an IMPLEMENTS edge (also documentation_comment)", () => {
    const src = `
/** implements XSPEC-333 */
class Foo {
  void run() {}
}
`;
    const { implementsEdges } = collectExtraction(src, { filePath: "ImplBlockDoc.dart" });
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0]?.to).toBe("XSPEC-333");
  });

  it("does not capture a bodyless abstract/interface method as a Function (different wrapper node than a bodied method)", () => {
    const src = `
abstract class Shape {
  double area();
}
`;
    const { nodes } = extractCodeGraph(src, { filePath: "shape.dart" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name);
    expect(classNames).toEqual(["Shape"]);
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id);
    expect(fnIds).toEqual([]);
  });

  it("captures a nested/local function distinct from its enclosing function", () => {
    const src = `
void outer() {
  void inner() {
    helper();
  }
  inner();
}

void helper() {
}
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "nested.dart" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(fnIds).toEqual(["nested.dart#helper", "nested.dart#outer", "nested.dart#outer.inner"]);

    const callsFromOuter = edges
      .filter((e) => e.label === "CALLS" && e.from === "nested.dart#outer")
      .map((e) => e.to);
    expect(callsFromOuter).toEqual(["nested.dart#outer.inner"]);

    const callsFromInner = edges
      .filter((e) => e.label === "CALLS" && e.from === "nested.dart#outer.inner")
      .map((e) => e.to);
    expect(callsFromInner).toEqual(["nested.dart#helper"]);
  });

  it("scope-qualifies a closure literal bound to a variable inside a function, distinct from its call site", () => {
    const src = `
void main() {
  var log = (String m) {
    print(m);
  };
  log("hi");
}
`;
    const { nodes } = extractCodeGraph(src, { filePath: "main.dart" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(fnIds).toEqual(["main.dart#main", "main.dart#main.log"]);
  });

  it("resolves a null-aware ('?.') member call the same as a plain '.' call", () => {
    const src = `
class Foo {
  int helper() {
    return 1;
  }
}

int callerFn(Foo? obj) {
  return obj?.helper() ?? 0;
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "nullaware.dart" });
    const callsFromCaller = edges
      .filter((e) => e.label === "CALLS" && e.from === "nullaware.dart#callerFn")
      .map((e) => e.to);
    expect(callsFromCaller).toEqual(["nullaware.dart#Foo.helper"]);
  });

  it("resolves cascade-section calls ('..method()') without a dedicated pattern, attributing them to the enclosing function", () => {
    const src = `
class Builder {
  Builder method1(int x) {
    return this;
  }
  Builder method2(int y) {
    return this;
  }
}

Builder callerFn(Builder obj) {
  return obj..method1(1)..method2(2);
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "cascade.dart" });
    const callsFromCaller = edges
      .filter((e) => e.label === "CALLS" && e.from === "cascade.dart#callerFn")
      .map((e) => e.to)
      .sort();
    expect(callsFromCaller).toEqual([
      "cascade.dart#Builder.method1",
      "cascade.dart#Builder.method2",
    ]);
  });

  it("excludes named arguments (a core Dart feature, not an edge case) from the by-reference call-argument pattern", () => {
    const src = `
void register({required handler, required path}) {
}

void setup(handlerFn, pathVar) {
  register(handler: handlerFn, path: pathVar);
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "namedargs.dart" });
    const callsFromSetup = edges
      .filter((e) => e.label === "CALLS" && e.from === "namedargs.dart#setup")
      .map((e) => e.to);
    expect(callsFromSetup).toEqual(["namedargs.dart#register"]);
  });

  it("does not capture a named argument's value as a by-reference call target (tag-query level)", () => {
    const src = `
void main() {
  foo(handler: handlerFn, path: pathVar);
}
`;
    const { callSites } = runTagQuery(Dart, "dart", tagsQuerySourceFor("dart"), parseDart(src).rootNode);
    const argNames = callSites.map((c) => c.name);
    expect(argNames).not.toContain("handlerFn");
    expect(argNames).not.toContain("pathVar");
  });

  it("captures a CALLS edge when a function is passed by reference as a direct positional call argument", () => {
    const src = `
void handlerFn() {
}

void register(String name, Function h) {
}

void setup() {
  register("/x", handlerFn);
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "setup.dart" });
    const callsFromSetup = edges
      .filter((e) => e.label === "CALLS" && e.from === "setup.dart#setup")
      .map((e) => e.to)
      .sort();
    expect(callsFromSetup).toEqual(["setup.dart#handlerFn", "setup.dart#register"]);
  });

  it("does not produce a call reference for object instantiation via the explicit 'new' keyword", () => {
    const src = `
class Foo {
  Foo(this.a);
  final int a;
}

Foo callerFn(int a) {
  var x = new Foo(a);
  return x;
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "newkw.dart" });
    const callsFromCaller = edges.filter(
      (e) => e.label === "CALLS" && e.from === "newkw.dart#callerFn",
    );
    expect(callsFromCaller).toHaveLength(0);
  });

  // Regression for the tag-query-engine.ts collectComments fix (Dart's
  // grammar has a THIRD, distinct comment node type, "documentation_comment",
  // for "///" doc comments — not unified with the plain "comment" node
  // "//"/"/* */" both use) — without that fix, a "/// implements XSPEC-NNN"
  // doc comment in a .dart file would silently produce zero IMPLEMENTS
  // edges.
  it("links a /// implements XSPEC-NNN doc comment to an IMPLEMENTS edge (documentation_comment)", () => {
    const src = `
/// implements XSPEC-333
class Foo {
  void run() {}
}
`;
    const { implementsEdges } = collectExtraction(src, { filePath: "Impl.dart" });
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0]).toMatchObject({
      label: "IMPLEMENTS",
      from: "Impl.dart",
      to: "XSPEC-333",
    });
  });

  it("also links an ordinary // implements XSPEC-NNN comment (plain 'comment' node, not documentation_comment)", () => {
    const src = `
// implements XSPEC-333
class Foo {
  void run() {}
}
`;
    const { implementsEdges } = collectExtraction(src, { filePath: "ImplPlain.dart" });
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0]?.to).toBe("XSPEC-333");
  });

  it("resolves an explicit generic-type-argument call correctly, unlike Kotlin's grammar ambiguity", () => {
    const src = `
int identityFn(int x) {
  return x;
}

int callerFn() {
  return identityFn<int>(5);
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "generic.dart" });
    const callsFromCaller = edges
      .filter((e) => e.label === "CALLS" && e.from === "generic.dart#callerFn")
      .map((e) => e.to);
    expect(callsFromCaller).toEqual(["generic.dart#identityFn"]);
  });
});

describe("CodeGraph cross-file resolution — Dart", () => {
  it("resolves a call to a function defined in another file", () => {
    const { fragment, calls } = extractProject([
      {
        path: "mathutils.dart",
        source: "int square(int n) {\n  return n * n;\n}\n",
      },
      {
        path: "runner.dart",
        source: "int run(int x) {\n  return square(x);\n}\n",
      },
    ]);
    expect(calls).toBe(1);
    const callEdge = fragment.edges.find((e) => e.label === "CALLS");
    expect(callEdge?.from).toBe("runner.dart#run");
    expect(callEdge?.to).toBe("mathutils.dart#square");
  });

  it("infers the dart language from the .dart extension without an explicit language override", () => {
    const { edges } = extractCodeGraph(
      "int f() {\n  return g();\n}\nint g() {\n  return 1;\n}\n",
      { filePath: "x.dart" },
    );
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(1);
  });
});
