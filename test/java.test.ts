import { describe, it, expect } from "vitest";

import { extractCodeGraph, extractProject, collectExtraction } from "../src/code-graph/extractor.js";
import { runTagQuery } from "../src/code-graph/tag-query-engine.js";
import { tagsQuerySourceFor } from "../src/code-graph/queries/index.js";
import Java from "tree-sitter-java";
import Parser from "tree-sitter";

// XSPEC-333 R2c: Java is the third language on the generic tag-query engine
// with its own constructor node type (like C#), but the *only* one so far
// whose grammar unifies bare and member calls into a single `method_invocation`
// node type. This file exercises the same DEFINES/CALLS/scope-qualification
// shapes test/csharp.test.ts already covers, but through `.java` source, plus
// Java's method-reference-based by-reference-argument pattern (see
// queries/java.ts's module doc for why this replaces the bare-identifier
// pattern every other language on this engine uses).

function parseJava(source: string) {
  const parser = new Parser();
  parser.setLanguage(Java);
  return parser.parse(source);
}

const GREETER_SAMPLE = `
public class Greeter {
    private final String name;

    public Greeter(String name) {
        this.name = name;
    }

    public String greet() {
        return buildMessage(name);
    }

    private String buildMessage(String n) {
        return "Hello, " + n;
    }
}
`;

describe("CodeGraph extractor — Java (XSPEC-333 R2c)", () => {
  it("extracts Module, Class and Function (incl. constructor) nodes with CALLS edges", () => {
    const { nodes, edges } = extractCodeGraph(GREETER_SAMPLE, { filePath: "src/Greeter.java" });

    const classes = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name);
    expect(classes).toEqual(["Greeter"]);

    // Greeter (constructor, same class-name-repeat quirk as C#), greet,
    // buildMessage.
    const functions = nodes.filter((n) => n.label === "Function").map((n) => n.properties.name).sort();
    expect(functions).toEqual(["Greeter", "buildMessage", "greet"]);

    const modules = nodes.filter((n) => n.label === "Module");
    expect(modules).toHaveLength(1);
    expect(modules[0]?.id).toBe("src/Greeter.java");

    const defines = edges.filter((e) => e.label === "DEFINES");
    expect(defines).toHaveLength(3);

    const callsFromGreet = edges
      .filter((e) => e.label === "CALLS" && e.from === "src/Greeter.java#Greeter.greet")
      .map((e) => e.to);
    expect(callsFromGreet).toEqual(["src/Greeter.java#Greeter.buildMessage"]);
  });

  it("stamps every Function/Class node with provider: tree-sitter", () => {
    const { nodes } = extractCodeGraph(GREETER_SAMPLE, { filePath: "src/Greeter.java" });
    for (const n of nodes.filter((n) => n.label === "Function" || n.label === "Class")) {
      expect(n.properties.provider).toBe("tree-sitter");
    }
  });

  it("captures interface/enum/record/annotation-type declarations as Class nodes alongside class_declaration (low-cost bonus scope)", () => {
    const src = `
      interface Shape { double area(); }
      enum Color { RED, GREEN, BLUE }
      record Point(int x, int y) {}
      @interface Marker {}
      class Impl implements Shape { public double area() { return 0; } }
    `;
    const { nodes } = extractCodeGraph(src, { filePath: "Shapes.java" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name).sort();
    expect(classNames).toEqual(["Color", "Impl", "Marker", "Point", "Shape"]);
  });

  it("scope-qualifies methods nested inside a class, resolving calls to sibling methods", () => {
    const src = `
      public class Calculator {
        public int compute(int x) {
          return square(x) + helper();
        }
        private int square(int n) { return n * n; }
        private int helper() { return 1; }
      }
    `;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "Calculator.java" });

    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(fnIds).toEqual([
      "Calculator.java#Calculator.compute",
      "Calculator.java#Calculator.helper",
      "Calculator.java#Calculator.square",
    ]);

    const callsFromCompute = edges
      .filter((e) => e.label === "CALLS" && e.from === "Calculator.java#Calculator.compute")
      .map((e) => e.to)
      .sort();
    expect(callsFromCompute).toEqual([
      "Calculator.java#Calculator.helper",
      "Calculator.java#Calculator.square",
    ]);
  });

  // Regression for the adversarial-review-caught anchoring bug: a lambda
  // bound to a *field* (not just a local variable) must still be captured
  // as a Function definition — the first draft of this file's query
  // anchored on local_variable_declaration and missed field-bound lambdas
  // entirely.
  it("captures a lambda bound to a field, not just a local variable, as a Function definition", () => {
    // Deliberately does NOT call `.run()` on either lambda: since both
    // lambdas are named after the *enclosing* method here ("exercise"),
    // and JDK's Runnable#run() is not itself a Function this engine
    // indexes, resolving those calls would tell us nothing about the
    // field-vs-local capture bug this test guards against. That capture is
    // asserted directly against `nodes` instead.
    const src = `
      public class C {
        private Runnable fieldLambda = () -> System.out.println("field");

        public void exercise() {
          Runnable localLambda = () -> System.out.println("local");
        }
      }
    `;
    const { nodes } = extractCodeGraph(src, { filePath: "C.java" });
    const fnNames = nodes.filter((n) => n.label === "Function").map((n) => n.properties.name).sort();
    expect(fnNames).toEqual(["exercise", "fieldLambda", "localLambda"]);
  });

  // Regression for Java's unified method_invocation node type: bare calls
  // and member calls must both resolve via the same single pattern.
  it("resolves both a bare call and a member call via the unified method_invocation node", () => {
    const src = `
      public class C {
        public void run() {
          helper();
          this.helper();
        }
        private void helper() {}
      }
    `;
    const { edges } = extractCodeGraph(src, { filePath: "Unified.java" });
    const callsFromRun = edges
      .filter((e) => e.label === "CALLS" && e.from === "Unified.java#C.run")
      .map((e) => e.to);
    // Both call sites resolve to the same helper (call_count aggregates).
    expect(callsFromRun).toEqual(["Unified.java#C.helper"]);
    const callEdge = edges.find((e) => e.label === "CALLS");
    expect(callEdge?.properties?.call_count).toBe(2);
  });

  // Regression for the adversarial-review-caught method_reference anchoring
  // bug: a naive (unanchored) pattern captures BOTH the receiver
  // type/expression identifier and the trailing method-name identifier.
  // Only the latter should count as a by-reference call argument.
  it("captures only the method name (not the receiver) from a method reference passed as a call argument", () => {
    const src = `
      import java.util.List;
      public class C {
        void process(Object o) {}

        void run(List<String> items) {
          items.forEach(this::process);
          items.forEach(String::toUpperCase);
        }
      }
    `;
    const { edges } = extractCodeGraph(src, { filePath: "MethodRef.java" });
    const callsFromRun = edges
      .filter((e) => e.label === "CALLS" && e.from === "MethodRef.java#C.run")
      .map((e) => e.to);
    // "process" resolves (a real method); "String" must never appear as a
    // target (it is the receiver type of String::toUpperCase, not a
    // by-reference argument), and "toUpperCase" is not a real method in
    // this file so it stays unresolved (correctly dropped, not fabricated).
    expect(callsFromRun).toEqual(["MethodRef.java#C.process"]);
  });

  it("does not capture a method reference bound to a variable (not passed as a call argument) as a by-reference argument", () => {
    const src = `
      public class C {
        void process(Object o) {}
        void run() {
          Runnable r = this::process;
        }
      }
    `;
    const { callSites } = runTagQuery(Java, "java", tagsQuerySourceFor("java"), parseJava(src).rootNode);
    expect(callSites.map((c) => c.name)).not.toContain("process");
  });

  // Considered-and-rejected design decision (see queries/java.ts module doc):
  // Java's separate method/variable namespace means a bare identifier
  // argument is NEVER a genuine function reference in valid Java — verified
  // here that a local variable sharing a name with an unrelated real method
  // does NOT fabricate a CALLS edge, because this file's query has no
  // bare-identifier @reference.call.arg pattern for Java at all.
  it("does not treat a same-named local variable/parameter as a by-reference call argument (separate namespace, no bare-identifier pattern)", () => {
    const src = `
      public class C {
        void filter() {}
        void use(Object filter) {
          int size = 5;
          doSomething(size, filter);
        }
        void doSomething(int a, Object b) {}
      }
    `;
    const { edges } = extractCodeGraph(src, { filePath: "Namespace.java" });
    const callsFromUse = edges
      .filter((e) => e.label === "CALLS" && e.from === "Namespace.java#C.use")
      .map((e) => e.to);
    // Only the direct call to doSomething resolves; neither "size" nor
    // "filter" (the parameter, not the method) fabricate a CALLS edge.
    expect(callsFromUse).toEqual(["Namespace.java#C.doSomething"]);
  });

  // Regression for the tag-query-engine.ts collectComments fix (Java's
  // grammar splits comments into line_comment/block_comment, with no
  // unifying "comment" node type) — without that fix, `// implements
  // XSPEC-NNN` in a .java file would silently produce zero IMPLEMENTS
  // edges.
  it("links a // implements XSPEC-NNN comment to an IMPLEMENTS edge (line_comment)", () => {
    const src = `
      // implements XSPEC-333
      public class C {
        void run() {}
      }
    `;
    const { implementsEdges } = collectExtraction(src, { filePath: "Impl.java" });
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0]).toMatchObject({
      label: "IMPLEMENTS",
      from: "Impl.java",
      to: "XSPEC-333",
    });
  });

  it("links a /* implements XSPEC-NNN */ comment to an IMPLEMENTS edge (block_comment)", () => {
    const src = `
      /* implements XSPEC-333 */
      public class C {
        void run() {}
      }
    `;
    const { implementsEdges } = collectExtraction(src, { filePath: "ImplBlock.java" });
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0]?.to).toBe("XSPEC-333");
  });
});

describe("CodeGraph cross-file resolution — Java", () => {
  it("resolves a static-class member-access call to a function defined in another file", () => {
    const { fragment, calls } = extractProject([
      {
        path: "MathUtils.java",
        source: "public class MathUtils { public static int square(int n) { return n * n; } }",
      },
      {
        path: "Runner.java",
        source: "public class Runner { public int run(int x) { return MathUtils.square(x); } }",
      },
    ]);
    expect(calls).toBe(1);
    const callEdge = fragment.edges.find((e) => e.label === "CALLS");
    expect(callEdge?.from).toBe("Runner.java#Runner.run");
    expect(callEdge?.to).toBe("MathUtils.java#MathUtils.square");
  });

  it("infers the java language from the .java extension without an explicit language override", () => {
    const { edges } = extractCodeGraph(
      "public class A { public int f() { return g(); } private int g() { return 1; } }",
      { filePath: "x.java" },
    );
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(1);
  });
});
