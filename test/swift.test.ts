import { describe, it, expect } from "vitest";

import { extractCodeGraph, extractProject } from "../src/code-graph/extractor.js";
import { cmdDoctor } from "../src/cli/run.js";

// XSPEC-414 R3: class/struct/enum/protocol/extension all parse to
// class_declaration/protocol_declaration, letting extension attribution work
// for free via range containment — see queries/swift.ts's module doc comment.

const FOO_SAMPLE = `
struct Foo {
    var value: Int
    func base() -> Int { return value }
}
`;

describe("CodeGraph extractor — Swift (XSPEC-414 R3)", () => {
  it("extracts Function and Class nodes with a CALLS edge for a self.method() call", () => {
    const src = `
struct Foo {
    var value: Int
    func base() -> Int { return value }
    func run() -> Int {
        return self.base()
    }
}
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "Foo.swift" });

    const functionIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(functionIds).toEqual(["Foo.swift#Foo.base", "Foo.swift#Foo.run"]);

    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name);
    expect(classNames).toEqual(["Foo"]);

    const callsFromRun = edges
      .filter((e) => e.label === "CALLS" && e.from === "Foo.swift#Foo.run")
      .map((e) => e.to);
    expect(callsFromRun).toEqual(["Foo.swift#Foo.base"]);
  });

  it("stamps every Function node with provider: tree-sitter", () => {
    const { nodes } = extractCodeGraph(FOO_SAMPLE, { filePath: "Foo.swift" });
    for (const n of nodes.filter((n) => n.label === "Function")) {
      expect(n.properties.provider).toBe("tree-sitter");
    }
  });

  it("extracts protocol and enum declarations as Class nodes", () => {
    const src = `
protocol Greeter { func greet() -> String }
enum Status { case ok, fail }
`;
    const { nodes } = extractCodeGraph(src, { filePath: "Types.swift" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name).sort();
    expect(classNames).toEqual(["Greeter", "Status"]);
    // A protocol's body-less method requirement is NOT captured as a
    // Function node — see queries/swift.ts's module doc comment.
    expect(nodes.filter((n) => n.label === "Function")).toEqual([]);
  });

  it("gives every initializer the synthetic name 'init'", () => {
    const src = `
struct Foo {
    var value: Int
    init(value: Int) { self.value = value }
}
`;
    const { nodes } = extractCodeGraph(src, { filePath: "Foo.swift" });
    const functionIds = nodes.filter((n) => n.label === "Function").map((n) => n.id);
    expect(functionIds).toEqual(["Foo.swift#Foo.init"]);
  });

  it("captures a function passed by reference as a direct call argument, distinct from a labeled argument's own label", () => {
    const src = `
func onRequest(_ x: Int) -> Int { return x }
func registerHandler(_ path: String, _ handler: (Int) -> Int) {}
func run() {
    registerHandler("/x", onRequest)
    registerHandler("/y", handler: onRequest)
}
`;
    const { fragment, calls } = extractProject([{ path: "a.swift", source: src }]);
    const callTargets = fragment.edges
      .filter((e) => e.label === "CALLS" && e.from === "a.swift#run")
      .map((e) => e.to)
      .sort();
    // registerHandler (x2) + onRequest by-ref (x2, aggregated into one edge
    // with call_count 2) — never a spurious edge to something named "handler".
    expect(callTargets).toEqual(["a.swift#onRequest", "a.swift#registerHandler"]);
    expect(calls).toBe(2);
  });
});

describe("XSPEC-414 R3 AC-3 — extension attribution and cross-file resolution", () => {
  it("attributes an extension's method to the type it extends, in the SAME file", () => {
    const src = `
struct Foo {
    var value: Int
}
extension Foo {
    func doubled() -> Int { return value * 2 }
}
`;
    const { nodes } = extractCodeGraph(src, { filePath: "Foo.swift" });
    const functionIds = nodes.filter((n) => n.label === "Function").map((n) => n.id);
    expect(functionIds).toEqual(["Foo.swift#Foo.doubled"]);
  });

  it("Scenario: Foo.swift defines struct Foo, Foo+Ext.swift extends it with a method — the method is attributed to Foo, and a cross-file call to it resolves", () => {
    const files = [
      { path: "Foo.swift", source: "struct Foo {\n    var value: Int\n}\n" },
      {
        path: "Foo+Ext.swift",
        source: "extension Foo {\n    func addTax(_ rate: Double) -> Double {\n        return Double(value) * rate\n    }\n}\n",
      },
      {
        path: "Runner.swift",
        source: "func run(_ f: Foo) -> Double {\n    return f.addTax(0.1)\n}\n",
      },
    ];
    const { fragment, calls } = extractProject(files);

    // The method is attributed to "Foo", qualified by the file it's
    // physically defined in (Foo+Ext.swift) — see queries/swift.ts's module
    // doc comment for why this engine cannot merge it onto Foo.swift's own
    // Class node (a limitation shared with every other language here).
    const addTax = fragment.nodes.find((n) => n.label === "Function" && n.id === "Foo+Ext.swift#Foo.addTax");
    expect(addTax).toBeDefined();

    // Cross-file call resolves despite the split Class nodes — CALLS keys
    // off the bare function name, not the Class node.
    expect(calls).toBe(1);
    const callEdge = fragment.edges.find((e) => e.label === "CALLS");
    expect(callEdge).toMatchObject({ from: "Runner.swift#run", to: "Foo+Ext.swift#Foo.addTax" });
  });

  it("infers the swift language from the .swift extension without an explicit language override", () => {
    const { edges } = extractCodeGraph("func f() -> Int { return g() }\nfunc g() -> Int { return 1 }\n", {
      filePath: "x.swift",
    });
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(1);
  });
});

describe("egr doctor lists Swift (XSPEC-414 R3)", () => {
  it("includes Swift among the reported languages", () => {
    const result = cmdDoctor("/tmp/probe-swift/.engram/graph.db");
    const swift = result.languages.find((l) => l.language === "swift");
    expect(swift).toBeDefined();
    expect(swift?.label).toBe("Swift");
  });
});
