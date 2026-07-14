import { describe, it, expect } from "vitest";

import { extractCodeGraph, extractProject } from "../src/code-graph/extractor.js";
import { runTagQuery } from "../src/code-graph/tag-query-engine.js";
import { tagsQuerySourceFor } from "../src/code-graph/queries/index.js";
import Python from "tree-sitter-python";
import Parser from "tree-sitter";

// XSPEC-333 R2c: Python is the first *dynamic*, indentation-based language on
// the generic tag-query engine (tag-query-engine.ts) — this file exercises
// the same shapes test/code-graph.test.ts and test/csharp.test.ts already
// cover for TS/JS/C# (Module/Function/Class nodes, DEFINES/CALLS edges,
// scope-qualified ids, cross-file resolution, the by-reference-argument
// CALLS pattern), but through `.py` source.

function parsePython(source: string) {
  const parser = new Parser();
  parser.setLanguage(Python);
  return parser.parse(source);
}

const GREETER_SAMPLE = `
class Greeter:
    def __init__(self, name):
        self._name = name

    def greet(self):
        return self._build_message(self._name)

    def _build_message(self, name):
        return "Hello, " + name
`;

describe("CodeGraph extractor — Python (XSPEC-333 R2c)", () => {
  it("extracts Module, Class and Function (incl. __init__) nodes with CALLS edges", () => {
    const { nodes, edges } = extractCodeGraph(GREETER_SAMPLE, { filePath: "src/greeter.py" });

    const classes = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name);
    expect(classes).toEqual(["Greeter"]);

    const functions = nodes.filter((n) => n.label === "Function").map((n) => n.properties.name).sort();
    expect(functions).toEqual(["__init__", "_build_message", "greet"]);

    const modules = nodes.filter((n) => n.label === "Module");
    expect(modules).toHaveLength(1);
    expect(modules[0]?.id).toBe("src/greeter.py");

    const defines = edges.filter((e) => e.label === "DEFINES");
    expect(defines).toHaveLength(3);

    const callsFromGreet = edges
      .filter((e) => e.label === "CALLS" && e.from === "src/greeter.py#Greeter.greet")
      .map((e) => e.to);
    expect(callsFromGreet).toEqual(["src/greeter.py#Greeter._build_message"]);
  });

  it("stamps every Function/Class node with provider: tree-sitter", () => {
    const { nodes } = extractCodeGraph(GREETER_SAMPLE, { filePath: "src/greeter.py" });
    for (const n of nodes.filter((n) => n.label === "Function" || n.label === "Class")) {
      expect(n.properties.provider).toBe("tree-sitter");
    }
  });

  it("scope-qualifies a function nested inside a method, and resolves calls to it and to a sibling method", () => {
    const src = `
class Calculator:
    def compute(self, x):
        def square(n):
            return n * n
        return square(x) + self.helper()

    def helper(self):
        return 1
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "calculator.py" });

    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(fnIds).toEqual([
      "calculator.py#Calculator.compute",
      "calculator.py#Calculator.compute.square",
      "calculator.py#Calculator.helper",
    ]);

    const callsFromCompute = edges
      .filter((e) => e.label === "CALLS" && e.from === "calculator.py#Calculator.compute")
      .map((e) => e.to)
      .sort();
    expect(callsFromCompute).toEqual([
      "calculator.py#Calculator.compute.square",
      "calculator.py#Calculator.helper",
    ]);
  });

  it("captures a lambda bound to a variable as a Function definition, distinct from the call that invokes it", () => {
    const src = `
class C:
    def m(self):
        log = lambda msg: print(msg)
        log(1)
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "c.py" });
    const fnNames = nodes.filter((n) => n.label === "Function").map((n) => n.properties.name).sort();
    expect(fnNames).toEqual(["log", "m"]);

    const callsFromM = edges
      .filter((e) => e.label === "CALLS" && e.from === "c.py#C.m")
      .map((e) => e.to);
    expect(callsFromM).toEqual(["c.py#C.m.log"]);
  });

  it("captures a @staticmethod-decorated function as a normal Function definition", () => {
    const src = `
class Derived:
    @staticmethod
    def make():
        return helper()

def helper():
    return 1
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "derived.py" });
    const fnNames = nodes.filter((n) => n.label === "Function").map((n) => n.properties.name).sort();
    expect(fnNames).toEqual(["helper", "make"]);

    const callsFromMake = edges
      .filter((e) => e.label === "CALLS" && e.from === "derived.py#Derived.make")
      .map((e) => e.to);
    expect(callsFromMake).toEqual(["derived.py#helper"]);
  });

  // Regression for the Python analogue of the Fastify `app.register(pluginFn,
  // opts)` by-reference-argument pattern (DEC-095) — e.g.
  // `signal.signal(signal.SIGINT, handler_fn)`.
  it("captures a CALLS edge when a function is passed by reference as a positional call argument", () => {
    const src = `
class Startup:
    def configure_alerts(self, app):
        pass

    def configure(self, app):
        self.register(self.configure_alerts, self.default_options)

    def register(self, handler, opts):
        pass
`;
    const { edges } = extractCodeGraph(src, { filePath: "startup.py" });
    const callsFromConfigure = edges
      .filter((e) => e.label === "CALLS" && e.from === "startup.py#Startup.configure")
      .map((e) => e.to)
      .sort();
    // register resolves via the direct call; configure_alerts is a method
    // access (self.configure_alerts) so this particular fixture only proves
    // the "register" call resolves — see the module-level variant below for
    // the true by-reference-argument case (bare identifiers, not attribute
    // access, are what the by-reference-argument pattern captures).
    expect(callsFromConfigure).toEqual(["startup.py#Startup.register"]);
  });

  it("captures a CALLS edge when a module-level function is passed by reference (bare identifier) as a call argument", () => {
    const src = `
def configure_alerts(app):
    pass

def register(handler, opts):
    pass

def configure(app):
    register(configure_alerts, default_options)
`;
    const { edges } = extractCodeGraph(src, { filePath: "app.py" });
    const callsFromConfigure = edges
      .filter((e) => e.label === "CALLS" && e.from === "app.py#configure")
      .map((e) => e.to)
      .sort();
    expect(callsFromConfigure).toEqual(["app.py#configure_alerts", "app.py#register"]);
  });

  // Regression: a naive port of the by-reference-argument pattern with no
  // structural exclusion would also match a *keyword argument's* value,
  // since it too is (eventually) a bare identifier somewhere under
  // argument_list. Verified in this file's queries/python.ts development
  // that Python's grammar wraps a keyword argument in its own
  // `keyword_argument` node (a direct child of argument_list), making the
  // value identifier a *grandchild*, not a direct child — this test proves
  // that structural exclusion actually holds against the real Query engine,
  // not just against a hand-inspected parse tree.
  it("does not treat a keyword argument's value as a by-reference call argument", () => {
    const src = `
def handler():
    pass

def foo(x=1, handler=None):
    pass

def caller():
    foo(handler=handler)
`;
    const { edges } = extractCodeGraph(src, { filePath: "kwarg.py" });
    const callsFromCaller = edges
      .filter((e) => e.label === "CALLS" && e.from === "kwarg.py#caller")
      .map((e) => e.to);
    // "foo" resolves via the direct call; "handler" (passed as a keyword
    // argument value) must NOT resolve to kwarg.py#handler.
    expect(callsFromCaller).toEqual(["kwarg.py#foo"]);
  });

  it("does not capture a keyword argument's value at the tag-query level at all (direct Query check)", () => {
    const src = `foo(x, handler=some_handler, *rest, **kw)`;
    const { callSites } = runTagQuery(Python, "python", tagsQuerySourceFor("python"), parsePython(src).rootNode);
    const argNames = callSites.map((c) => c.name);
    expect(argNames).toContain("x");
    expect(argNames).not.toContain("some_handler");
    expect(argNames).not.toContain("rest");
    expect(argNames).not.toContain("kw");
  });

  // Documented Open Question (queries/python.ts module doc, grouped with
  // Go's exactly-analogous type-conversion ambiguity): class instantiation
  // (`Foo()`) is grammatically identical to a call. Verified here that it
  // does NOT fabricate a CALLS edge in the common case, because Class nodes
  // never enter the bare-name Function index CALLS resolution reads from.
  it("does not resolve a class instantiation to any Function (Class nodes are not in the callable-name index)", () => {
    const src = `
class Foo:
    pass

def caller():
    return Foo()
`;
    const { edges } = extractCodeGraph(src, { filePath: "instantiate.py" });
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(0);
  });
});

describe("CodeGraph cross-file resolution — Python", () => {
  it("resolves an attribute-access call to a function defined in another file (module-level function used as a namespaced call)", () => {
    const { fragment, calls } = extractProject([
      {
        path: "math_utils.py",
        source: "def square(n):\n    return n * n\n",
      },
      {
        path: "runner.py",
        source: "import math_utils\n\ndef run(x):\n    return math_utils.square(x)\n",
      },
    ]);
    expect(calls).toBe(1);
    const callEdge = fragment.edges.find((e) => e.label === "CALLS");
    expect(callEdge?.from).toBe("runner.py#run");
    expect(callEdge?.to).toBe("math_utils.py#square");
  });

  it("infers the python language from the .py extension without an explicit language override", () => {
    const { edges } = extractCodeGraph(
      "def f():\n    return g()\n\ndef g():\n    return 1\n",
      { filePath: "x.py" },
    );
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(1);
  });
});
