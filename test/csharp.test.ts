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

  it("does not capture a bare generic call target (Helper<int>()) — documented Open Question", () => {
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

  it("does not capture a generic member-access call target (obj.Method<T>()) — documented Open Question", () => {
    const src = `
      public class C {
        public void Run() { list.Select<int>(x => x); }
      }
    `;
    const { callSites } = runTagQuery(CSharp, "csharp", tagsQuerySourceFor("csharp"), parseCSharp(src).rootNode);
    // list.Select<int>(...) — member_access_expression's "name" field is a
    // generic_name here, not a plain identifier, so the @reference.call
    // pattern (which requires name: (identifier)) does not match.
    expect(callSites.map((c) => c.name)).not.toContain("Select");
  });

  // Regression: a naive port of JS's by-reference-argument pattern
  // (`argument_list (argument (identifier))`, no further constraint) also
  // matches a *named argument's* parameter label, which is a plain
  // identifier in this grammar too — fabricating a CALLS edge to whatever
  // function happens to share a name with the parameter (found via an
  // adversarial review of the first draft of this query, not by inspection).
  it("does not treat a named-argument parameter label as a call reference", () => {
    const src = `
      public class C {
        public void M() { Foo(handler: 1); }
        private void handler() {}
        private void Foo(int x) {}
      }
    `;
    const { edges } = extractCodeGraph(src, { filePath: "named-arg.cs" });
    const callsFromM = edges
      .filter((e) => e.label === "CALLS" && e.from === "named-arg.cs#C.M")
      .map((e) => e.to);
    expect(callsFromM).toEqual(["named-arg.cs#C.Foo"]); // NOT ...#C.handler
  });

  // Regression: `nameof(X)` is a real invocation_expression to this grammar
  // (callee identifier "nameof", argument a bare identifier `X`) but is
  // semantically a symbol reference, not a call or a value-pass — idiomatic
  // in argument validation / logging. A naive port of JS's pattern
  // fabricates a CALLS edge to X whenever X names a real function.
  it("does not treat nameof(X)'s argument as a call reference to X", () => {
    const src = `
      public class C {
        public void M() { Log(nameof(Helper)); }
        private void Helper() {}
        private void Log(string s) {}
      }
    `;
    const { edges } = extractCodeGraph(src, { filePath: "nameof.cs" });
    const callsFromM = edges
      .filter((e) => e.label === "CALLS" && e.from === "nameof.cs#C.M")
      .map((e) => e.to);
    expect(callsFromM).toEqual(["nameof.cs#C.Log"]); // NOT ...#C.Helper
  });

  // Documented limitation (see extractor.ts's comment on qualifyFunctions'
  // call site): unlike JS/TS, C# allows method overloading — same name,
  // different parameter lists, same scope. This id scheme scope-qualifies
  // by name only, not by signature, so two overloads collapse onto the same
  // qualified id rather than erroring or silently dropping one.
  it("collapses method overloads onto one qualified id (documented limitation, not a crash)", () => {
    const src = `
      public class C {
        void M(int x) { }
        void M(string x) { }
      }
    `;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "overload.cs" });
    const functionNodes = nodes.filter((n) => n.label === "Function");
    expect(functionNodes).toHaveLength(2); // one per overload, not deduped
    expect(functionNodes.every((n) => n.id === "overload.cs#C.M")).toBe(true); // same id
    expect(edges.filter((e) => e.label === "DEFINES")).toHaveLength(2); // both DEFINES edges emitted
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

/**
 * Regression guards for GitHub issue #2, reported against 0.7.0.
 *
 * Both shapes below returned `functions: 0, classes: 0` for the *whole file*
 * on 0.7.0 — no error, no partial result, indistinguishable from a file that
 * genuinely declares nothing. That is worse than an outright failure: the
 * caller has no signal that anything was lost.
 *
 * Neither reproduces now. 0.8.0 replaced the hand-written AST walker with the
 * tag-query engine (XSPEC-333 R2), and these shapes went with it. Verified on
 * 2026-08-04 by running the issue's own repro against published 0.7.0 (0
 * functions, 0 classes) and against this build (3 functions, 1 class) — the
 * fix is real, not an artefact of a different test.
 *
 * Kept as tests rather than closed and forgotten: the bug was a silent zero,
 * and a silent zero is exactly what nobody notices coming back.
 */
describe("C# — GitHub issue #2 regression guards", () => {
  it("parses a class with a base-list clause AND range/index syntax in its methods", () => {
    // Neither ingredient alone reproduced it on 0.7.0. Only the combination —
    // `: SomeInterface` on the class plus `[..x]` / `[^1]` in a method body —
    // zeroed the file, which is why it survived narrower testing.
    const { nodes } = extractCodeGraph(
      `namespace Test;

public sealed class PiiHasherFullIface : ISomeUndeclaredInterface
{
    private readonly string _version;
    private readonly int _tokenLength;

    public PiiHasherFullIface(string pepper)
    {
        _version = "v1";
        _tokenLength = 8;
    }

    public string HashPhone(string phone)
    {
        var hex = phone.Trim();
        return $"{_version}:{hex[.._tokenLength]}";
    }

    public string MaskPhone(string phone)
    {
        var p = phone.Trim();
        return $"{p[..4]}***{p[^3..]}";
    }
}
`,
      { filePath: "PiiHasher.cs" },
    );

    expect(nodes.filter((n) => n.label === "Class")).toHaveLength(1);
    // Constructor + the two methods.
    expect(nodes.filter((n) => n.label === "Function").length).toBeGreaterThanOrEqual(3);
  });

  it("parses an interface and its implementer in the same batch, without zeroing unrelated files", () => {
    // The issue's second failure mode: indexing an interface together with a
    // class implementing it zeroed the ENTIRE batch, including files that had
    // nothing to do with either.
    const result = extractProject([
      {
        path: "IMultiProbe.cs",
        source: "public interface IMultiProbe {\n    string M1(string phone);\n}\n",
      },
      {
        path: "MultiProbeIface.cs",
        source:
          "public sealed class MultiProbeIface : IMultiProbe {\n" +
          "    private readonly string _a;\n" +
          "    public MultiProbeIface(string a) { _a = a; }\n" +
          "    public string M1(string phone) { return phone; }\n}\n",
      },
      { path: "unrelated.ts", source: "export function untouched(){ return 1; }\n" },
    ]);

    expect(result.functions).toBeGreaterThan(0);
    expect(result.classes).toBeGreaterThan(0);
    // Every input file produced something — the batch-wide zeroing is the bug.
    for (const file of result.parseHealth) {
      expect(
        file.functions + file.classes,
        `${file.path} produced nothing`,
      ).toBeGreaterThan(0);
      expect(file.failed, `${file.path} failed to parse`).toBeUndefined();
    }
  });
});
