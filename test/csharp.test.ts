import { describe, it, expect } from "vitest";

import { extractCodeGraph, extractProject } from "../src/code-graph/extractor.js";
import { runTagQuery } from "../src/code-graph/tag-query-engine.js";
import { tagsQuerySourceFor } from "../src/code-graph/queries/index.js";
import CSharp from "tree-sitter-c-sharp";
import Parser from "tree-sitter";

// XSPEC-333 R2b: C# is the first non-JS/TS language on the generic
// tag-query engine (tag-query-engine.ts) — this file exercises the same
// shapes test/code-graph.test.ts already covers for TS/JS (Module/Function/
// Class nodes, DEFINES/CALLS edges, scope-qualified ids, cross-file
// resolution, the by-reference-argument CALLS pattern), but through
// `.cs` source, to prove the engine actually generalizes rather than being
// JS/TS-shaped in disguise.

function parseCSharp(source: string) {
  const parser = new Parser();
  parser.setLanguage(CSharp);
  return parser.parse(source);
}

const GREETER_SAMPLE = `
namespace Sample {
  public class Greeter {
    private readonly string _name;

    public Greeter(string name) {
      _name = name;
    }

    public string Greet() {
      return BuildMessage(_name);
    }

    private string BuildMessage(string name) {
      return "Hello, " + name;
    }
  }
}
`;

describe("CodeGraph extractor — C# (XSPEC-333 R2b)", () => {
  it("extracts Module, Class and Function (incl. constructor) nodes with CALLS edges", () => {
    const { nodes, edges } = extractCodeGraph(GREETER_SAMPLE, { filePath: "src/Greeter.cs" });

    const classes = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name);
    expect(classes).toEqual(["Greeter"]);

    // Greeter (constructor), Greet, BuildMessage — the constructor's name
    // repeats the class name (constructor_declaration's `name` field is
    // literally "Greeter" in this grammar — see queries/csharp.ts doc).
    const functions = nodes.filter((n) => n.label === "Function").map((n) => n.properties.name).sort();
    expect(functions).toEqual(["BuildMessage", "Greet", "Greeter"]);

    const modules = nodes.filter((n) => n.label === "Module");
    expect(modules).toHaveLength(1);
    expect(modules[0]?.id).toBe("src/Greeter.cs");

    const defines = edges.filter((e) => e.label === "DEFINES");
    expect(defines).toHaveLength(3);

    const callsFromGreet = edges
      .filter((e) => e.label === "CALLS" && e.from === "src/Greeter.cs#Greeter.Greet")
      .map((e) => e.to);
    expect(callsFromGreet).toEqual(["src/Greeter.cs#Greeter.BuildMessage"]);
  });

  it("stamps every Function/Class node with provider: tree-sitter", () => {
    const { nodes } = extractCodeGraph(GREETER_SAMPLE, { filePath: "src/Greeter.cs" });
    for (const n of nodes.filter((n) => n.label === "Function" || n.label === "Class")) {
      expect(n.properties.provider).toBe("tree-sitter");
    }
  });

  it("scope-qualifies a local function nested inside a method, and resolves calls to it and to a sibling method", () => {
    const src = `
      public class Calculator {
        public int Compute(int x) {
          int Square(int n) { return n * n; }
          return Square(x) + Helper();
        }

        private int Helper() { return 1; }
      }
    `;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "Calculator.cs" });

    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(fnIds).toEqual([
      "Calculator.cs#Calculator.Compute",
      "Calculator.cs#Calculator.Compute.Square",
      "Calculator.cs#Calculator.Helper",
    ]);

    const callsFromCompute = edges
      .filter((e) => e.label === "CALLS" && e.from === "Calculator.cs#Calculator.Compute")
      .map((e) => e.to)
      .sort();
    expect(callsFromCompute).toEqual([
      "Calculator.cs#Calculator.Compute.Square",
      "Calculator.cs#Calculator.Helper",
    ]);
  });

  it("captures a lambda bound to a local variable as a Function definition, distinct from the call that invokes it", () => {
    const src = `
      public class C {
        public void M() {
          Action<int> log = (m) => Console.WriteLine(m);
          log(1);
        }
      }
    `;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "C.cs" });
    const fnNames = nodes.filter((n) => n.label === "Function").map((n) => n.properties.name).sort();
    expect(fnNames).toEqual(["M", "log"]);

    const callsFromM = edges
      .filter((e) => e.label === "CALLS" && e.from === "C.cs#C.M")
      .map((e) => e.to);
    expect(callsFromM).toEqual(["C.cs#C.M.log"]);
  });

  it("captures struct/interface/record declarations as Class nodes alongside class_declaration (low-cost bonus scope)", () => {
    const src = `
      namespace Foo {
        public record Point(int X, int Y);
        public struct Vec { public int X; }
        public interface IFoo { void Bar(); }
        public class Impl : IFoo { public void Bar() {} }
      }
    `;
    const { nodes } = extractCodeGraph(src, { filePath: "Shapes.cs" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name).sort();
    expect(classNames).toEqual(["IFoo", "Impl", "Point", "Vec"]);
  });

  // Regression for the C# analogue of the Fastify `app.register(pluginFn, opts)`
  // by-reference-argument pattern (DEC-095) — a "method group" passed as a
  // bare identifier argument, which C# implicitly converts to a delegate.
  it("captures a CALLS edge when a method is passed by reference (method group) as a call argument", () => {
    const src = `
      public class Startup {
        private void ConfigureAlerts(object app) { }

        public void Configure(object app) {
          Register(ConfigureAlerts, DefaultOptions);
        }

        private void Register(object handler, object opts) { }
      }
    `;
    const { edges } = extractCodeGraph(src, { filePath: "Startup.cs" });
    const callsFromConfigure = edges
      .filter((e) => e.label === "CALLS" && e.from === "Startup.cs#Startup.Configure")
      .map((e) => e.to)
      .sort();
    // Register resolves via the direct invocation_expression; ConfigureAlerts
    // resolves via the argument-reference detection; DefaultOptions is not a
    // known function and must not spuriously resolve to anything.
    expect(callsFromConfigure).toEqual([
      "Startup.cs#Startup.ConfigureAlerts",
      "Startup.cs#Startup.Register",
    ]);
  });

  it("does not capture a generic member-access call target (obj.Method<T>()) — documented Open Question", () => {
    const src = `
      public class C {
        public void Run() { Helper<int>(1); }
        private void Helper<T>(T x) {}
      }
    `;
    const { callSites } = runTagQuery(CSharp, "csharp", tagsQuerySourceFor("csharp"), parseCSharp(src).rootNode);
    // Helper<int>(...) — function field is a generic_name, not a plain
    // identifier or member_access_expression, so this call site is not
    // captured at all (neither by name).
    expect(callSites.map((c) => c.name)).not.toContain("Helper");
  });
});

describe("CodeGraph cross-file resolution — C#", () => {
  it("resolves a static-class member-access call to a function defined in another file", () => {
    const { fragment, calls } = extractProject([
      {
        path: "MathUtils.cs",
        source: "public static class MathUtils { public static int Square(int n) { return n * n; } }",
      },
      {
        path: "Runner.cs",
        source: "public class Runner { public int Run(int x) { return MathUtils.Square(x); } }",
      },
    ]);
    expect(calls).toBe(1);
    const callEdge = fragment.edges.find((e) => e.label === "CALLS");
    expect(callEdge?.from).toBe("Runner.cs#Runner.Run");
    expect(callEdge?.to).toBe("MathUtils.cs#MathUtils.Square");
  });

  it("infers the csharp language from the .cs extension without an explicit language override", () => {
    const { edges } = extractCodeGraph(
      "public class A { public int F() { return G(); } private int G() { return 1; } }",
      { filePath: "x.cs" },
    );
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(1);
  });
});
