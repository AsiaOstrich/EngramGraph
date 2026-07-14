import { describe, it, expect } from "vitest";

import { extractCodeGraph, extractProject } from "../src/code-graph/extractor.js";

// XSPEC-333 R2c batch 2: C++ is the first language on this engine whose
// function name is not a direct field of its defining node (it is nested
// inside a declarator chain — see queries/cpp.ts's module doc comment).
// Inline methods qualify to Class.method for free (like Rust's impl
// blocks); out-of-line definitions do not (like Go's receiver methods).

const CALCULATOR_SAMPLE = `
int square(int n) { return n * n; }

class Calculator {
public:
    int compute(int x) {
        return square(x) + helper();
    }
    int helper() { return base; }
private:
    int base;
};
`;

describe("CodeGraph extractor — C++ (XSPEC-333 R2c batch 2)", () => {
  it("extracts Module and Function nodes (incl. inline methods) with CALLS edges", () => {
    const { nodes, edges } = extractCodeGraph(CALCULATOR_SAMPLE, { filePath: "src/calculator.cpp" });

    const functionIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    // Inline methods qualify to Class.method via range containment — see
    // module doc comment.
    expect(functionIds).toEqual([
      "src/calculator.cpp#Calculator.compute",
      "src/calculator.cpp#Calculator.helper",
      "src/calculator.cpp#square",
    ]);

    const modules = nodes.filter((n) => n.label === "Module");
    expect(modules).toHaveLength(1);
    expect(modules[0]?.id).toBe("src/calculator.cpp");

    const defines = edges.filter((e) => e.label === "DEFINES");
    expect(defines).toHaveLength(3);

    const callsFromCompute = edges
      .filter((e) => e.label === "CALLS" && e.from === "src/calculator.cpp#Calculator.compute")
      .map((e) => e.to)
      .sort();
    expect(callsFromCompute).toEqual([
      "src/calculator.cpp#Calculator.helper",
      "src/calculator.cpp#square",
    ]);
  });

  it("stamps every Function node with provider: tree-sitter", () => {
    const { nodes } = extractCodeGraph(CALCULATOR_SAMPLE, { filePath: "src/calculator.cpp" });
    for (const n of nodes.filter((n) => n.label === "Function")) {
      expect(n.properties.provider).toBe("tree-sitter");
    }
  });

  it("captures class and struct declarations as Class nodes", () => {
    const src = `
class Foo { public: void bar() {} };
struct Point { int x; int y; };
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "shapes.cpp" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name).sort();
    expect(classNames).toEqual(["Foo", "Point"]);
    expect(edges.filter((e) => e.label === "DEFINES" && e.to.includes("class:"))).toHaveLength(0);
  });

  // Documented, tested consequence of an out-of-line method definition
  // being a top-level sibling of its class (not lexically nested inside
  // it) — mirrors Go's receiver-method limitation, verified independently
  // for C++ (see module doc comment).
  it("does NOT scope-qualify an out-of-line method definition (bare name, not Class.method)", () => {
    const src = `
class Calculator {
public:
    int outOfLine(int x);
};

int Calculator::outOfLine(int x) {
    return x + 1;
}
`;
    const { nodes } = extractCodeGraph(src, { filePath: "outofline.cpp" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(fnIds).toEqual(["outofline.cpp#outOfLine"]);
  });

  it("scope-qualifies a lambda bound to a variable inside a function, distinct from its call site", () => {
    const src = `
void run() {
    auto log = [](const char* m) { return; };
    log("hi");
}
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "main.cpp" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(fnIds).toEqual(["main.cpp#run", "main.cpp#run.log"]);

    const callsFromRun = edges
      .filter((e) => e.label === "CALLS" && e.from === "main.cpp#run")
      .map((e) => e.to);
    expect(callsFromRun).toEqual(["main.cpp#run.log"]);
  });

  it("captures a capturing lambda ([&counter]) bound to a variable the same way as a plain lambda", () => {
    const src = `
void run() {
    int counter = 0;
    auto inc = [&counter]() { counter++; };
    inc();
}
`;
    const { nodes } = extractCodeGraph(src, { filePath: "capture.cpp" });
    const fnNames = nodes.filter((n) => n.label === "Function").map((n) => n.properties.name).sort();
    expect(fnNames).toEqual(["inc", "run"]);
  });

  // C++'s functional-style-cast construction (Point(1, 2)) parses
  // identically to a real call (the same underlying grammar ambiguity as
  // Go's type-conversion / Python's class-instantiation lessons) — but
  // unlike those languages, C++ constructors ARE ordinary
  // function_definition nodes (captured via the field_identifier pattern,
  // named after the class, e.g. "Point.Point" — the same documented
  // constructor-name-repeats-class-name quirk C#/Java already have). Since
  // CALLS resolution keys off the *bare* name ("Point"), this means
  // "Point(1, 2)" DOES resolve here — and, unlike Rust's tuple-struct case
  // or Go's user-defined-type-conversion case, this is not a false positive
  // at all: `Point(1, 2)` genuinely does invoke `Point::Point(int, int)` at
  // runtime, so resolving it to that exact constructor is semantically
  // CORRECT, verified — a pleasant, C++-specific exception to the general
  // "class-instantiation-as-call" Open Question named in the module doc
  // comment (which still applies for a class with NO user-defined
  // constructor, since there's then no matching Function node to resolve
  // to at all).
  it("resolves a functional-style-cast construction call to the class's own constructor (a correct edge, not a false positive)", () => {
    const src = `
class Point {
public:
    Point(int x, int y) {}
};

void make() {
    Point p = Point(1, 2);
}
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "point.cpp" });
    expect(nodes.filter((n) => n.label === "Function").map((n) => n.id).sort()).toEqual([
      "point.cpp#Point.Point",
      "point.cpp#make",
    ]);
    const calls = edges.filter((e) => e.label === "CALLS");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.from).toBe("point.cpp#make");
    expect(calls[0]?.to).toBe("point.cpp#Point.Point");
  });

  // The Open Question DOES still apply when there's no matching
  // constructor: a class with no user-defined constructor has no Function
  // node named after it, so a functional-style-cast construction of it
  // simply resolves to nothing (same "narrow, mitigated" risk as Rust's
  // tuple-struct / Go's type-conversion cases) — UNLESS an unrelated
  // function happens to share that exact name elsewhere in the corpus
  // (not exercised here; that residual risk is the documented Open
  // Question itself, not something a unit test can positively demonstrate
  // without begging the question).
  it("does not resolve a functional-style-cast construction call when the class has no user-defined constructor", () => {
    const src = `
class Empty {
public:
    void method() {}
};

void make() {
    Empty e = Empty();
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "empty.cpp" });
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(0);
  });

  // Verified DIFFERENCE from Go: a primitive-type functional-style cast
  // (int(x)) parses to a DIFFERENT node type (primitive_type) in the
  // callee position, so it is excluded with NO predicate needed — unlike
  // Go, whose builtin type names parse as plain identifiers and need an
  // explicit #not-any-of? exclusion.
  it("does not treat a primitive-type cast (int(x)) as a call, with no exclusion predicate needed", () => {
    const src = `
int helper(int n) { return n; }

void run() {
    int x = 5;
    int y = int(x);
    int z = helper(x);
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "conv.cpp" });
    const callsFromRun = edges
      .filter((e) => e.label === "CALLS" && e.from === "conv.cpp#run")
      .map((e) => e.to);
    expect(callsFromRun).toEqual(["conv.cpp#helper"]);
  });

  // Regression for the by-reference-argument pattern's C++ analogue.
  it("captures a CALLS edge when a function is passed by reference as a direct call argument", () => {
    const src = `
void handlerFunc() {}

void registerHandler(const char* path, void(*fn)()) {}

void setup() {
    registerHandler("/x", handlerFunc);
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "setup.cpp" });
    const callsFromSetup = edges
      .filter((e) => e.label === "CALLS" && e.from === "setup.cpp#setup")
      .map((e) => e.to)
      .sort();
    expect(callsFromSetup).toEqual(["setup.cpp#handlerFunc", "setup.cpp#registerHandler"]);
  });

  it("captures an explicit-template-argument free-function call (identity<int>(5))", () => {
    const src = `
template<typename T> T identity(T x) { return x; }

void run() {
    int a = identity<int>(5);
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "generic.cpp" });
    const callsFromRun = edges
      .filter((e) => e.label === "CALLS" && e.from === "generic.cpp#run")
      .map((e) => e.to);
    expect(callsFromRun).toEqual(["generic.cpp#identity"]);
  });

  it("captures an explicit-template-argument method call (b.get<int>())", () => {
    const src = `
class Box {
public:
    template<typename T> T get() { return T(); }
};
void run() {
    Box b;
    int x = b.get<int>();
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "genmethod.cpp" });
    const callsFromRun = edges
      .filter((e) => e.label === "CALLS" && e.from === "genmethod.cpp#run")
      .map((e) => e.to);
    expect(callsFromRun).toContain("genmethod.cpp#Box.get");
  });

  // Documented, tested gap found via real-world smoke testing against
  // google/leveldb's Status class (see queries/cpp.ts's module doc
  // comment): an operator overload's declarator is `operator_name`, a
  // shape none of this file's definition patterns match — so it is
  // silently not extracted as a Function node at all, unlike every other
  // method shape this file handles.
  it("does NOT capture an operator overload (operator=) as a Function node (documented Open Question)", () => {
    const src = `
class Status {
public:
    Status& operator=(const Status& rhs) {
        return *this;
    }
    bool ok() const { return true; }
};
`;
    const { nodes } = extractCodeGraph(src, { filePath: "operator.cpp" });
    const fnNames = nodes.filter((n) => n.label === "Function").map((n) => n.properties.name);
    // Only "ok" is captured; "operator=" is missing entirely.
    expect(fnNames).toEqual(["ok"]);
  });

  // Regression for a real gap found by adversarial review (fixed in this
  // batch, not shipped broken): a pointer- or reference-returning function
  // wraps its function_declarator in an extra pointer_declarator/
  // reference_declarator layer. Before the fix, this silently dropped both
  // the definition AND every call site inside its body.
  it("captures pointer- and reference-returning functions (free, inline method, and out-of-line method)", () => {
    const src = `
int* makePtr() { return nullptr; }
int& makeRef() { static int x = 0; return x; }

class Foo {
public:
    int* getPtr() { return helper(); }
    int helper() { return 0; }
    Foo& outOfLine();
};

Foo& Foo::outOfLine() { return *this; }
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "ptrref.cpp" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(fnIds).toEqual([
      "ptrref.cpp#Foo.getPtr",
      "ptrref.cpp#Foo.helper",
      "ptrref.cpp#makePtr",
      "ptrref.cpp#makeRef",
      // out-of-line, so NOT scope-qualified (bare name) — same limitation
      // as a value-returning out-of-line method.
      "ptrref.cpp#outOfLine",
    ]);
    const callsFromGetPtr = edges
      .filter((e) => e.label === "CALLS" && e.from === "ptrref.cpp#Foo.getPtr")
      .map((e) => e.to);
    expect(callsFromGetPtr).toEqual(["ptrref.cpp#Foo.helper"]);
  });

  // Regression: a destructor captures the WHOLE destructor_name node
  // ("~Foo"), not its inner identifier ("Foo") — otherwise it would
  // silently collide with the constructor's own name onto one shared id.
  it("captures a destructor with a distinct name from the constructor (no id collision)", () => {
    const src = `
class Foo {
public:
    Foo() {}
    ~Foo() {}
};
`;
    const { nodes } = extractCodeGraph(src, { filePath: "dtor.cpp" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(fnIds).toEqual(["dtor.cpp#Foo.Foo", "dtor.cpp#Foo.~Foo"]);
  });

  // Regression for a real gap found by adversarial review: a
  // namespace-qualified or static/associated call (`ns::helper(x)`,
  // `Foo::staticMethod()`) was invisible to this file's first-draft
  // patterns entirely.
  it("resolves a namespace-qualified / static call (Foo::staticMethod())", () => {
    const src = `
class Foo {
public:
    static int staticMethod() { return 0; }
};

int run() {
    return Foo::staticMethod();
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "qualified.cpp" });
    const callsFromRun = edges
      .filter((e) => e.label === "CALLS" && e.from === "qualified.cpp#run")
      .map((e) => e.to);
    expect(callsFromRun).toEqual(["qualified.cpp#Foo.staticMethod"]);
  });
});

describe("CodeGraph cross-file resolution — C++", () => {
  it("resolves a bare call to a function defined in another file", () => {
    const { fragment, calls } = extractProject([
      {
        path: "mathutils.cpp",
        source: "int square(int n) {\n    return n * n;\n}\n",
      },
      {
        path: "runner.cpp",
        source: "int run(int x) {\n    return square(x);\n}\n",
      },
    ]);
    expect(calls).toBe(1);
    const callEdge = fragment.edges.find((e) => e.label === "CALLS");
    expect(callEdge?.from).toBe("runner.cpp#run");
    expect(callEdge?.to).toBe("mathutils.cpp#square");
  });

  it("infers the cpp language from the .cpp/.hpp/.h extensions without an explicit language override", () => {
    for (const ext of [".cpp", ".hpp", ".h", ".cc", ".cxx", ".hh"]) {
      const { edges } = extractCodeGraph(
        "int f() { return g(); }\nint g() { return 1; }\n",
        { filePath: `x${ext}` },
      );
      expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(1);
    }
  });
});
