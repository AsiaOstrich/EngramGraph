import { describe, it, expect } from "vitest";

import { extractCodeGraph, extractProject } from "../src/code-graph/extractor.js";
import { runTagQuery } from "../src/code-graph/tag-query-engine.js";
import { tagsQuerySourceFor } from "../src/code-graph/queries/index.js";
import Rust from "tree-sitter-rust";
import Parser from "tree-sitter";

// XSPEC-333 R2c batch 2: Rust is verified DIFFERENT from Go's struct+method
// situation, not a mechanical copy of it — impl/trait blocks DO lexically
// contain their methods, so scope-qualification works here with no
// engine changes (see queries/rust.ts's module doc comment).

function parseRust(source: string) {
  const parser = new Parser();
  parser.setLanguage(Rust);
  return parser.parse(source);
}

const CALCULATOR_SAMPLE = `
struct Calculator { base: i32 }

impl Calculator {
    fn compute(&self, x: i32) -> i32 {
        square(x) + self.helper()
    }
    fn helper(&self) -> i32 { self.base }
}

fn square(n: i32) -> i32 { n * n }
`;

describe("CodeGraph extractor — Rust (XSPEC-333 R2c batch 2)", () => {
  it("extracts Module and Function nodes (incl. impl methods) with CALLS edges", () => {
    const { nodes, edges } = extractCodeGraph(CALCULATOR_SAMPLE, { filePath: "src/calculator.rs" });

    const functionIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    // Unlike Go, Rust's impl block DOES scope-qualify its methods — see
    // queries/rust.ts module doc comment.
    expect(functionIds).toEqual([
      "src/calculator.rs#Calculator.compute",
      "src/calculator.rs#Calculator.helper",
      "src/calculator.rs#square",
    ]);

    const modules = nodes.filter((n) => n.label === "Module");
    expect(modules).toHaveLength(1);
    expect(modules[0]?.id).toBe("src/calculator.rs");

    const defines = edges.filter((e) => e.label === "DEFINES");
    expect(defines).toHaveLength(3);

    const callsFromCompute = edges
      .filter((e) => e.label === "CALLS" && e.from === "src/calculator.rs#Calculator.compute")
      .map((e) => e.to)
      .sort();
    expect(callsFromCompute).toEqual([
      "src/calculator.rs#Calculator.helper",
      "src/calculator.rs#square",
    ]);
  });

  it("stamps every Function node with provider: tree-sitter", () => {
    const { nodes } = extractCodeGraph(CALCULATOR_SAMPLE, { filePath: "src/calculator.rs" });
    for (const n of nodes.filter((n) => n.label === "Function")) {
      expect(n.properties.provider).toBe("tree-sitter");
    }
  });

  it("captures the impl block's Self type as a Class node for both an inherent and a trait impl (same name, not the trait name)", () => {
    const src = `
struct Calculator { base: i32 }

impl Calculator {
    fn helper(&self) -> i32 { self.base }
}

impl std::fmt::Display for Calculator {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{}", self.base)
    }
}
`;
    const { nodes } = extractCodeGraph(src, { filePath: "display.rs" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name);
    // Three captures: the struct_item itself, plus both impl blocks — all
    // named "Calculator" (the Self type), never "Display" (the trait name)
    // — see module doc comment. Harmless, identical-id duplication (same
    // "two same-named classes collide" quirk this engine already documents
    // for every language), not a distinct bug.
    expect(classNames).toEqual(["Calculator", "Calculator", "Calculator"]);
  });

  it("qualifies a method inside a generic impl block (impl<T> Container<T>) to the base type name", () => {
    const src = `
struct Container<T> { items: Vec<T> }

impl<T> Container<T> {
    fn len(&self) -> usize { self.items.len() }
}
`;
    const { nodes } = extractCodeGraph(src, { filePath: "container.rs" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id);
    expect(fnIds).toEqual(["container.rs#Container.len"]);
  });

  it("captures struct and enum type declarations as bonus Class nodes (no CALLS involvement, do not scope-qualify methods)", () => {
    const src = `
struct Point { x: i32, y: i32 }

enum Color { Red, Green, Blue }
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "shapes.rs" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name).sort();
    expect(classNames).toEqual(["Color", "Point"]);
    expect(edges.filter((e) => e.label === "DEFINES" && e.to.includes("class:"))).toHaveLength(0);
  });

  it("qualifies a trait's default method to TraitName.method", () => {
    const src = `
trait Shape {
    fn area(&self) -> f64;
    fn describe(&self) -> f64 {
        self.area()
    }
}
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "shape.rs" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(fnIds).toEqual(["shape.rs#Shape.area", "shape.rs#Shape.describe"]);
    const calls = edges.filter((e) => e.label === "CALLS").map((e) => `${e.from}->${e.to}`);
    expect(calls).toContain("shape.rs#Shape.describe->shape.rs#Shape.area");
  });

  it("scope-qualifies a closure bound to a variable inside a function, distinct from its call site", () => {
    const src = `
fn main() {
    let log = |m: &str| { println!("{}", m); };
    log("hi");
}
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "main.rs" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(fnIds).toEqual(["main.rs#main", "main.rs#main.log"]);

    const callsFromMain = edges
      .filter((e) => e.label === "CALLS" && e.from === "main.rs#main")
      .map((e) => e.to);
    expect(callsFromMain).toEqual(["main.rs#main.log"]);
  });

  it("captures a 'move' closure bound to a variable the same way as a plain closure", () => {
    const src = `
fn main() {
    let mut counter = 0;
    let inc = move || { counter += 1; };
    inc();
}
`;
    const { nodes } = extractCodeGraph(src, { filePath: "move.rs" });
    const fnNames = nodes.filter((n) => n.label === "Function").map((n) => n.properties.name).sort();
    expect(fnNames).toEqual(["inc", "main"]);
  });

  // Regression: verifies (rather than assumes) that Rust's let_declaration
  // does NOT have Go's short_var_declaration cross-pairing bug — its
  // "pattern" field is singular, so a multi-binding tuple destructuring
  // mixing a closure cannot cross-pair a wrong name to it.
  it("does not fabricate a wrongly-named Function definition for a tuple-destructuring let binding mixing a closure", () => {
    const src = `
fn main() {
    let (a, f) = (1, || {});
    let _ = a;
    f();
}
`;
    const { definitions } = runTagQuery(Rust, "rust", tagsQuerySourceFor("rust"), parseRust(src).rootNode);
    const fnNames = definitions.filter((d) => d.kind === "function").map((d) => d.name);
    expect(fnNames).not.toContain("a");
  });

  // Regression for Rust's own false-positive risk (analogous to Go's
  // type-conversion / Python's class-instantiation lessons): tuple-struct
  // and enum-variant construction parse identically to a real call — but
  // since @definition.class captures never enter the bare-name Function
  // index, this does not fabricate a CALLS edge unless another real
  // function shares that exact name.
  it("does not resolve a tuple-struct construction call to anything when no function shares its name", () => {
    const src = `
struct Point(i32, i32);

fn make() {
    let p = Point(1, 2);
    let _ = p;
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "point.rs" });
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(0);
  });

  it("does not treat a macro invocation (println!) as a call", () => {
    const src = `
fn helper(n: i32) -> i32 { n }

fn main() {
    let x = helper(5);
    println!("{}", x);
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "macro.rs" });
    const callsFromMain = edges
      .filter((e) => e.label === "CALLS" && e.from === "macro.rs#main")
      .map((e) => e.to);
    expect(callsFromMain).toEqual(["macro.rs#helper"]);
  });

  // Regression for the by-reference-argument pattern's Rust analogue.
  it("captures a CALLS edge when a function is passed by reference as a direct call argument", () => {
    const src = `
fn handler_fn() {}

fn register(name: &str, h: fn()) {}

fn setup() {
    register("/x", handler_fn);
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "setup.rs" });
    const callsFromSetup = edges
      .filter((e) => e.label === "CALLS" && e.from === "setup.rs#setup")
      .map((e) => e.to)
      .sort();
    expect(callsFromSetup).toEqual(["setup.rs#handler_fn", "setup.rs#register"]);
  });

  it("resolves an associated-function ('Self::') call within an impl block", () => {
    const src = `
struct Calculator { base: i32 }

impl Calculator {
    fn compute(&self) -> i32 {
        Self::static_helper()
    }
    fn static_helper() -> i32 { 0 }
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "assoc.rs" });
    const callsFromCompute = edges
      .filter((e) => e.label === "CALLS" && e.from === "assoc.rs#Calculator.compute")
      .map((e) => e.to);
    expect(callsFromCompute).toEqual(["assoc.rs#Calculator.static_helper"]);
  });

  // Regression for a real gap found by adversarial review (fixed in this
  // batch, not shipped broken): an explicit-turbofish generic call
  // (`parse_it::<i32>(s)`) wraps the callee in a `generic_function` node
  // this file's first-draft patterns did not match at all — three shapes
  // (bare, member, associated/scoped), mirroring C++'s
  // template_function/template_method patterns.
  it("resolves explicit-turbofish generic calls (bare, member, and associated/scoped forms)", () => {
    const src = `
fn parse_it(s: &str) -> i32 { 0 }

struct Box2 { val: i32 }
impl Box2 {
    fn get_it(&self) -> i32 { self.val }
}

fn helper() -> i32 { 0 }
mod inner {
    pub fn size_of_it() -> i32 { 0 }
}

fn run() {
    let a = parse_it::<i32>("5");
    let b = Box2 { val: 1 };
    let c = b.get_it::<i32>();
    let d = inner::size_of_it::<i32>();
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "turbofish.rs" });
    const callsFromRun = edges
      .filter((e) => e.label === "CALLS" && e.from === "turbofish.rs#run")
      .map((e) => e.to)
      .sort();
    // "size_of_it" is defined inside a "mod" block, which this engine does
    // NOT scope-qualify (a mod is not a type — see queries/rust.ts's module
    // doc comment), so it resolves to a bare id, not "inner.size_of_it".
    expect(callsFromRun).toEqual([
      "turbofish.rs#Box2.get_it",
      "turbofish.rs#parse_it",
      "turbofish.rs#size_of_it",
    ]);
  });
});

describe("CodeGraph cross-file resolution — Rust", () => {
  it("resolves a module-qualified call to a function defined in another file", () => {
    const { fragment, calls } = extractProject([
      {
        path: "mathutils.rs",
        source: "pub fn square(n: i32) -> i32 {\n    n * n\n}\n",
      },
      {
        path: "runner.rs",
        source: "fn run(x: i32) -> i32 {\n    mathutils::square(x)\n}\n",
      },
    ]);
    expect(calls).toBe(1);
    const callEdge = fragment.edges.find((e) => e.label === "CALLS");
    expect(callEdge?.from).toBe("runner.rs#run");
    expect(callEdge?.to).toBe("mathutils.rs#square");
  });

  it("infers the rust language from the .rs extension without an explicit language override", () => {
    const { edges } = extractCodeGraph(
      "fn f() -> i32 { g() }\nfn g() -> i32 { 1 }\n",
      { filePath: "x.rs" },
    );
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(1);
  });
});
