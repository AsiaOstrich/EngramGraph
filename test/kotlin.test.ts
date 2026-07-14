import { describe, it, expect } from "vitest";

import { extractCodeGraph, extractProject } from "../src/code-graph/extractor.js";

// XSPEC-333 R2c batch 2: Kotlin's queries were verified against
// @tree-sitter-grammars/tree-sitter-kotlin@1.1.0 (NOT the older, more
// widely-referenced fwcd tree-sitter-kotlin — see grammars.d.ts's module
// doc comment for the operational reason: fwcd's package ships no
// prebuilt native binaries at all, unlike every other grammar this repo
// depends on). class_declaration is reused for BOTH class and interface;
// object_declaration (a Kotlin singleton) genuinely scope-qualifies its
// methods, unlike Go's struct capture.

const CALCULATOR_SAMPLE = `
class Calculator(val base: Int) {
    fun compute(x: Int): Int {
        return square(x) + helper()
    }
    fun helper(): Int {
        return base
    }
}

fun square(n: Int): Int {
    return n * n
}
`;

describe("CodeGraph extractor — Kotlin (XSPEC-333 R2c batch 2)", () => {
  it("extracts Module and Function nodes (incl. class methods) with CALLS edges", () => {
    const { nodes, edges } = extractCodeGraph(CALCULATOR_SAMPLE, { filePath: "src/Calculator.kt" });

    const functionIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(functionIds).toEqual([
      "src/Calculator.kt#Calculator.compute",
      "src/Calculator.kt#Calculator.helper",
      "src/Calculator.kt#square",
    ]);

    const modules = nodes.filter((n) => n.label === "Module");
    expect(modules).toHaveLength(1);
    expect(modules[0]?.id).toBe("src/Calculator.kt");

    const defines = edges.filter((e) => e.label === "DEFINES");
    expect(defines).toHaveLength(3);

    const callsFromCompute = edges
      .filter((e) => e.label === "CALLS" && e.from === "src/Calculator.kt#Calculator.compute")
      .map((e) => e.to)
      .sort();
    expect(callsFromCompute).toEqual([
      "src/Calculator.kt#Calculator.helper",
      "src/Calculator.kt#square",
    ]);
  });

  it("stamps every Function node with provider: tree-sitter", () => {
    const { nodes } = extractCodeGraph(CALCULATOR_SAMPLE, { filePath: "src/Calculator.kt" });
    for (const n of nodes.filter((n) => n.label === "Function")) {
      expect(n.properties.provider).toBe("tree-sitter");
    }
  });

  it("captures interface declarations the same way as class declarations (same underlying node type)", () => {
    const src = `
interface Shape {
    fun area(): Double
}
`;
    const { nodes } = extractCodeGraph(src, { filePath: "Shape.kt" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name);
    expect(classNames).toEqual(["Shape"]);
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id);
    // A body-less abstract method is still captured as a Function node.
    expect(fnIds).toEqual(["Shape.kt#Shape.area"]);
  });

  it("scope-qualifies a function inside an object declaration (Kotlin singleton)", () => {
    const src = `
object Registry {
    fun register() {}
}
`;
    const { nodes } = extractCodeGraph(src, { filePath: "Registry.kt" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name);
    expect(classNames).toEqual(["Registry"]);
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id);
    expect(fnIds).toEqual(["Registry.kt#Registry.register"]);
  });

  it("captures a NAMED companion object as a Class node, but a function inside an UNNAMED companion object still qualifies to the enclosing class (not a synthetic 'Companion' scope)", () => {
    const namedSrc = `
class Foo {
    companion object Named {
        fun create(): Foo = Foo()
    }
}
`;
    const { nodes: namedNodes } = extractCodeGraph(namedSrc, { filePath: "Named.kt" });
    const namedClasses = namedNodes.filter((n) => n.label === "Class").map((n) => n.properties.name).sort();
    expect(namedClasses).toEqual(["Foo", "Named"]);

    const unnamedSrc = `
class Bar {
    companion object {
        fun make(): Bar = Bar()
    }
}
`;
    const { nodes: unnamedNodes } = extractCodeGraph(unnamedSrc, { filePath: "Bar.kt" });
    const unnamedFnIds = unnamedNodes.filter((n) => n.label === "Function").map((n) => n.id);
    // Qualifies to Bar.make (the enclosing class), not Bar.Companion.make.
    expect(unnamedFnIds).toEqual(["Bar.kt#Bar.make"]);
  });

  it("scope-qualifies a lambda literal bound to a variable, distinct from its call site", () => {
    const src = `
fun run() {
    val log = { m: String -> println(m) }
    log("hi")
}
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "main.kt" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(fnIds).toEqual(["main.kt#run", "main.kt#run.log"]);

    const callsFromRun = edges
      .filter((e) => e.label === "CALLS" && e.from === "main.kt#run")
      .map((e) => e.to);
    expect(callsFromRun).toEqual(["main.kt#run.log"]);
  });

  // Regression: verifies (rather than assumes) that Kotlin's destructuring
  // declaration does NOT cross-pair a wrong name onto a lambda literal —
  // it wraps names in a different node (multi_variable_declaration).
  it("does not fabricate a wrongly-named Function definition for a destructuring declaration", () => {
    const src = `
fun run() {
    val (a, b) = Pair(1, 2)
}
`;
    const { nodes } = extractCodeGraph(src, { filePath: "destructure.kt" });
    const fnNames = nodes.filter((n) => n.label === "Function").map((n) => n.properties.name);
    expect(fnNames).toEqual(["run"]);
  });

  // Regression for the real gap found during this file's development: a
  // naive port requiring value_arguments would MISS Kotlin's idiomatic
  // trailing-lambda call syntax entirely.
  it("captures a CALLS edge for a trailing-lambda-only call (no value_arguments node at all)", () => {
    const src = `
fun helper() {}

fun scopeFn(block: () -> Unit) { block() }

fun run() {
    scopeFn { helper() }
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "trailing.kt" });
    const callsFromRun = edges
      .filter((e) => e.label === "CALLS" && e.from === "trailing.kt#run")
      .map((e) => e.to)
      .sort();
    // Both the outer "scopeFn { ... }" call and the inner "helper()" call
    // inside its trailing lambda are attributed to the enclosing "run"
    // function (the lambda body is not itself a captured Function scope).
    expect(callsFromRun).toEqual(["trailing.kt#helper", "trailing.kt#scopeFn"]);
  });

  it("captures a member call at any chain depth, keeping only the final segment name", () => {
    const src = `
class A { fun b(): A = this }

fun c() {}

fun run() {
    val a = A()
    a.b().c()
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "chain.kt" });
    const callsFromRun = edges
      .filter((e) => e.label === "CALLS" && e.from === "chain.kt#run")
      .map((e) => e.to)
      .sort();
    // "b" resolves to A.b (a real method); "c" resolves to the top-level
    // "c" function — confirming only the final chain segment's name is
    // captured, not some other identifier from earlier in the chain.
    expect(callsFromRun).toEqual(["chain.kt#A.b", "chain.kt#c"]);
  });

  // Regression for a real gap found by adversarial review (fixed in this
  // batch, not shipped broken): null-safe navigation ("?.") is a SEPARATE
  // anonymous token from "." in this grammar — a first-draft pattern
  // literal-matching only "." silently captured ZERO calls for this
  // extremely common Kotlin idiom.
  it("captures a null-safe ('?.') member call, plain and mixed with '.' in a chain", () => {
    const src = `
class A { fun b(): A? = this }

fun run() {
    val obj: A? = A()
    obj?.b()
    val a = A()
    a?.b()?.hashCode()
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "safecall.kt" });
    // Both "obj?.b()" and "a?.b()?.hashCode()" resolve "b" to A.b; CALLS
    // edges aggregate same (from, to) pairs into one edge with a
    // call_count, not two separate edges (see extractor.ts's
    // buildCallEdges) — "hashCode" is undefined in this file and correctly
    // does not resolve to anything.
    const callFromRun = edges.find((e) => e.label === "CALLS" && e.from === "safecall.kt#run");
    expect(callFromRun?.to).toBe("safecall.kt#A.b");
    expect(callFromRun?.properties?.call_count).toBe(2);
  });

  // Regression for Kotlin's own false-positive risk explicitly named in
  // the task: named arguments have NO field to test for absence in this
  // grammar (unlike C#), so the fix is a different mechanism (a
  // leading+trailing anchor on value_argument's sole child).
  it("does not capture a named-argument label or its value as a by-reference call argument", () => {
    const src = `
fun handlerFn() {}

fun register(path: String, handler: () -> Unit) {}

fun setup() {
    register(path = "/x", handler = handlerFn)
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "named.kt" });
    const callsFromSetup = edges
      .filter((e) => e.label === "CALLS" && e.from === "named.kt#setup")
      .map((e) => e.to);
    // Only the call itself resolves; neither "path"/"handler" (the labels)
    // nor "handlerFn" (the named-argument value) are captured as
    // by-reference arguments.
    expect(callsFromSetup).toEqual(["named.kt#register"]);
  });

  it("captures a CALLS edge when a positional bare-identifier value (a val-bound lambda) is passed by reference", () => {
    const src = `
fun run() {
    val onClick = { println("clicked") }
    registerCallback(onClick)
}

fun registerCallback(cb: () -> Unit) {}
`;
    const { edges } = extractCodeGraph(src, { filePath: "callback.kt" });
    const callsFromRun = edges
      .filter((e) => e.label === "CALLS" && e.from === "callback.kt#run")
      .map((e) => e.to)
      .sort();
    expect(callsFromRun).toEqual(["callback.kt#registerCallback", "callback.kt#run.onClick"]);
  });

  it("captures a CALLS edge for a bare '::function' callable reference passed as a call argument", () => {
    const src = `
fun println2(m: String) {}

fun run() {
    val items = listOf("a")
    items.forEach(::println2)
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "callref.kt" });
    const callsFromRun = edges
      .filter((e) => e.label === "CALLS" && e.from === "callref.kt#run")
      .map((e) => e.to)
      .sort();
    expect(callsFromRun).toEqual(["callref.kt#println2"]);
  });

  it("captures only the method name (not the receiver type) for a qualified 'Type::method' callable reference argument", () => {
    const src = `
class StringUtils {
    fun upper(s: String): String = s
}

fun run() {
    val items = listOf("a")
    items.map(StringUtils::upper)
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "qualifiedref.kt" });
    const callsFromRun = edges
      .filter((e) => e.label === "CALLS" && e.from === "qualifiedref.kt#run")
      .map((e) => e.to)
      .sort();
    // "upper" (qualified to StringUtils.upper via the shared bare-name
    // index — see extractor.ts), never a spurious call to "StringUtils".
    expect(callsFromRun).toContain("qualifiedref.kt#StringUtils.upper");
    expect(callsFromRun.some((to) => to.endsWith("#StringUtils"))).toBe(false);
  });

  // Regression for Kotlin's own false-positive risk found during this
  // file's development (same underlying limitation as Go/Python/Rust/C++'s
  // class-instantiation ambiguity, no "new" keyword to disambiguate).
  it("does not resolve a class-instantiation call to anything when no function shares its name", () => {
    const src = `
class Point(val x: Int, val y: Int)

fun make() {
    val p = Point(1, 2)
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "point.kt" });
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(0);
  });
});

describe("CodeGraph cross-file resolution — Kotlin", () => {
  it("resolves a bare call to a function defined in another file", () => {
    const { fragment, calls } = extractProject([
      {
        path: "MathUtils.kt",
        source: "fun square(n: Int): Int {\n    return n * n\n}\n",
      },
      {
        path: "Runner.kt",
        source: "fun run(x: Int): Int {\n    return square(x)\n}\n",
      },
    ]);
    expect(calls).toBe(1);
    const callEdge = fragment.edges.find((e) => e.label === "CALLS");
    expect(callEdge?.from).toBe("Runner.kt#run");
    expect(callEdge?.to).toBe("MathUtils.kt#square");
  });

  it("infers the kotlin language from the .kt extension without an explicit language override", () => {
    const { edges } = extractCodeGraph(
      "fun f(): Int { return g() }\nfun g(): Int { return 1 }\n",
      { filePath: "x.kt" },
    );
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(1);
  });
});
