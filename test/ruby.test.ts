import { describe, it, expect } from "vitest";

import { extractCodeGraph, extractProject, collectExtraction } from "../src/code-graph/extractor.js";
import { runTagQuery } from "../src/code-graph/tag-query-engine.js";
import { tagsQuerySourceFor } from "../src/code-graph/queries/index.js";
import Ruby from "tree-sitter-ruby";
import Parser from "tree-sitter";

// XSPEC-333 R2c batch 3: Ruby is the second *dynamic* language on this
// engine after Python, and the first where a bare dot-access (no
// parentheses, no arguments) is itself indistinguishable from a real
// zero-arg method call — see queries/ruby.ts's module doc comment.

function parseRuby(source: string) {
  const parser = new Parser();
  parser.setLanguage(Ruby);
  return parser.parse(source);
}

// "helper" (bare, no receiver, no parens, no args) is deliberately NOT used
// here as a call target — it is syntactically indistinguishable from a
// local variable read in this grammar (see queries/ruby.ts's module doc
// comment) and does not produce a "call" node at all. "self.helper" (an
// explicit receiver) and "square(x)" (parenthesized) both do.
const CALCULATOR_SAMPLE = `
class Calculator
  def compute(x)
    square(x) + self.helper
  end

  def helper
    base
  end
end

def square(n)
  n * n
end
`;

describe("CodeGraph extractor — Ruby (XSPEC-333 R2c batch 3)", () => {
  it("extracts Module and Function nodes (incl. instance methods) with CALLS edges", () => {
    const { nodes, edges } = extractCodeGraph(CALCULATOR_SAMPLE, { filePath: "calculator.rb" });

    const functionIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(functionIds).toEqual([
      "calculator.rb#Calculator.compute",
      "calculator.rb#Calculator.helper",
      "calculator.rb#square",
    ]);

    const modules = nodes.filter((n) => n.label === "Module");
    expect(modules).toHaveLength(1);
    expect(modules[0]?.id).toBe("calculator.rb");

    const defines = edges.filter((e) => e.label === "DEFINES");
    expect(defines).toHaveLength(3);

    const callsFromCompute = edges
      .filter((e) => e.label === "CALLS" && e.from === "calculator.rb#Calculator.compute")
      .map((e) => e.to)
      .sort();
    // "helper" (no parens, no args) is a real zero-arg method call in Ruby —
    // see module doc comment.
    expect(callsFromCompute).toEqual([
      "calculator.rb#Calculator.helper",
      "calculator.rb#square",
    ]);
  });

  it("stamps every Function node with provider: tree-sitter", () => {
    const { nodes } = extractCodeGraph(CALCULATOR_SAMPLE, { filePath: "calculator.rb" });
    for (const n of nodes.filter((n) => n.label === "Function")) {
      expect(n.properties.provider).toBe("tree-sitter");
    }
  });

  it("qualifies 'def self.x' (singleton_method) to ClassName.method, same as an ordinary method", () => {
    const src = `
class Foo
  def self.create
    new
  end
end
`;
    const { nodes } = extractCodeGraph(src, { filePath: "foo.rb" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id);
    expect(fnIds).toEqual(["foo.rb#Foo.create"]);
  });

  it("qualifies a method inside 'class << self' (singleton class reopening) to the enclosing class, even though the wrapper itself is not captured", () => {
    const src = `
class Foo
  class << self
    def bar
      helper
    end
  end
end
`;
    const { nodes } = extractCodeGraph(src, { filePath: "foo.rb" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id);
    expect(fnIds).toEqual(["foo.rb#Foo.bar"]);
  });

  it("captures a namespaced class declaration ('class Foo::Bar') and scope-qualifies its methods", () => {
    const src = `
class Foo::Bar
  def m
    helper
  end
end
`;
    const { nodes } = extractCodeGraph(src, { filePath: "namespaced.rb" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name);
    expect(classNames).toEqual(["Bar"]);
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id);
    expect(fnIds).toEqual(["namespaced.rb#Bar.m"]);
  });

  it("captures a namespaced module declaration ('module Foo::Bar') and scope-qualifies its methods", () => {
    const src = `
module Foo::Bar
  def self.m
    helper
  end
end
`;
    const { nodes } = extractCodeGraph(src, { filePath: "namespaced_mod.rb" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name);
    expect(classNames).toEqual(["Bar"]);
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id);
    expect(fnIds).toEqual(["namespaced_mod.rb#Bar.m"]);
  });

  it("scope-qualifies a lambda bound to a variable inside a method, distinct from its call site", () => {
    const src = `
def main
  log = ->(m) { puts(m) }
  log.call("hi")
end
`;
    const { nodes } = extractCodeGraph(src, { filePath: "main.rb" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(fnIds).toEqual(["main.rb#main", "main.rb#main.log"]);
  });

  it("does not fabricate a Function definition for a multi-assignment destructuring mixing a lambda", () => {
    const src = `
def main
  a, f = 1, ->(m) { puts(m) }
  f.call(a)
end
`;
    const { definitions } = runTagQuery(Ruby, "ruby", tagsQuerySourceFor("ruby"), parseRuby(src).rootNode);
    const fnNames = definitions.filter((d) => d.kind === "function").map((d) => d.name);
    expect(fnNames).not.toContain("a");
    expect(fnNames).not.toContain("f");
  });

  it("excludes keyword arguments from the by-reference call-argument pattern", () => {
    const src = `
def register(handler:, path:)
end

def setup
  register(handler: some_handler, path: some_path)
end
`;
    const { edges } = extractCodeGraph(src, { filePath: "kwargs.rb" });
    const callsFromSetup = edges
      .filter((e) => e.label === "CALLS" && e.from === "kwargs.rb#setup")
      .map((e) => e.to);
    // "register" itself resolves (an ordinary call); "some_handler"/
    // "some_path" must NOT resolve as by-reference args since they were
    // passed as keyword values, not positional.
    expect(callsFromSetup).toEqual(["kwargs.rb#register"]);
  });

  it("does not capture a bare symbol argument (':handler_method') as a by-reference call target", () => {
    const src = `
def handler_method
end

def setup
  register(:handler_method)
end
`;
    const { edges } = extractCodeGraph(src, { filePath: "symbols.rb" });
    const callsFromSetup = edges
      .filter((e) => e.label === "CALLS" && e.from === "symbols.rb#setup")
      .map((e) => e.to);
    expect(callsFromSetup).not.toContain("symbols.rb#handler_method");
  });

  it("captures a CALLS edge when a function/lambda is passed by reference as a direct call argument", () => {
    const src = `
def handler_fn
end

def register(name, h)
end

def setup
  register("/x", handler_fn)
end
`;
    const { edges } = extractCodeGraph(src, { filePath: "setup.rb" });
    const callsFromSetup = edges
      .filter((e) => e.label === "CALLS" && e.from === "setup.rb#setup")
      .map((e) => e.to)
      .sort();
    expect(callsFromSetup).toEqual(["setup.rb#handler_fn", "setup.rb#register"]);
  });

  it("resolves a scope-resolution call ('Foo::bar') the same as a '.' member call", () => {
    const src = `
module Foo
  def self.bar
    1
  end
end

def caller_fn
  Foo::bar
end
`;
    const { edges } = extractCodeGraph(src, { filePath: "scope.rb" });
    const callsFromCaller = edges
      .filter((e) => e.label === "CALLS" && e.from === "scope.rb#caller_fn")
      .map((e) => e.to);
    expect(callsFromCaller).toEqual(["scope.rb#Foo.bar"]);
  });

  it("resolves a safe-navigation ('&.') call the same as a plain '.' call", () => {
    const src = `
class Foo
  def helper
    1
  end
end

def caller_fn(obj)
  obj&.helper
end
`;
    const { edges } = extractCodeGraph(src, { filePath: "safenav.rb" });
    const callsFromCaller = edges
      .filter((e) => e.label === "CALLS" && e.from === "safenav.rb#caller_fn")
      .map((e) => e.to);
    expect(callsFromCaller).toEqual(["safenav.rb#Foo.helper"]);
  });

  it("does NOT capture a bare, receiver-less, paren-less method invocation as a call (documented false negative)", () => {
    const src = `
def helper
  1
end

def compute
  helper
end
`;
    const { edges } = extractCodeGraph(src, { filePath: "bare_call.rb" });
    // "helper" alone (no parens, no receiver, no args) is syntactically
    // indistinguishable from a local variable read in this grammar — see
    // queries/ruby.ts's module doc comment. Not captured as a CALLS edge.
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(0);
  });

  it("DOES capture a bare, receiver-less, paren-less invocation of a '?'/'!'-suffixed method (no ambiguity with a local variable, since those can never end in '?'/'!')", () => {
    const src = `
def safe
  1
end

def compute
  safe?
end
`;
    // "safe?" is a distinct method name from "safe" here (Ruby predicate
    // naming convention) — this fixture defines "safe?" nowhere, so the call
    // is expected to be unresolved (0 CALLS edges), but the KEY point is
    // that a call site is captured at all (not silently dropped as an
    // "identifier", the way "helper" alone is — see the other test above
    // and queries/ruby.ts's module doc comment).
    const { rawCalls } = collectExtraction(src, { filePath: "predicate.rb" });
    expect(rawCalls.some((c) => c.callee === "safe?")).toBe(true);
  });

  // Regression for an adversarial-review finding (XSPEC-333 R2c batch 3):
  // Ruby has no distinct "attribute access" node (see queries/ruby.ts's
  // module doc comment) — "obj.name" is a "call" node whether it's a real
  // zero-arg invocation OR the LHS of "obj.name = x" (which Ruby actually
  // dispatches to a DIFFERENT method, "name=", never invoking "name" at
  // all). Before the tag-query-engine.ts isPlainAssignmentTarget fix, this
  // fabricated a CALLS edge to the getter.
  it("does NOT fabricate a CALLS edge from a plain setter assignment ('obj.name = x') to a coincidentally-named getter", () => {
    const src = `
class Person
  def name
    @name
  end

  def rename(x)
    self.name = x
  end
end
`;
    const { edges } = extractCodeGraph(src, { filePath: "person.rb" });
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(0);
  });

  it("does NOT fabricate a CALLS edge from a multi-assignment ('a.x, a.y = 1, 2') to coincidentally-named getters", () => {
    const src = `
class Pair
  def x
    @x
  end

  def y
    @y
  end

  def reset
    self.x, self.y = 1, 2
  end
end
`;
    const { edges } = extractCodeGraph(src, { filePath: "pair.rb" });
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(0);
  });

  it("STILL resolves a CALLS edge from a compound assignment ('obj.count += 1') to the getter — it genuinely reads through it first", () => {
    const src = `
class Counter
  def count
    @count
  end

  def increment
    self.count += 1
  end
end
`;
    const { edges } = extractCodeGraph(src, { filePath: "counter.rb" });
    const callsFromIncrement = edges
      .filter((e) => e.label === "CALLS" && e.from === "counter.rb#Counter.increment")
      .map((e) => e.to);
    expect(callsFromIncrement).toEqual(["counter.rb#Counter.count"]);
  });

  // Regression for an adversarial-review finding (XSPEC-333 R2c batch 3):
  // "def name=" (setter) and "def ==" (operator) methods have a name: field
  // that is NOT a bare identifier ("setter"/"operator" node types) — before
  // this fix, an entire "def name=" method produced ZERO definition
  // captures at all.
  it("captures a setter method definition ('def name=') with its full name including the trailing '='", () => {
    const src = `
class Person
  def name=(v)
    @name = v
  end
end
`;
    const { nodes } = extractCodeGraph(src, { filePath: "setter.rb" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id);
    expect(fnIds).toEqual(["setter.rb#Person.name="]);
  });

  it("captures an operator method definition ('def ==') with its full operator symbol as the name", () => {
    const src = `
class Point
  def ==(other)
    true
  end
end
`;
    const { nodes } = extractCodeGraph(src, { filePath: "operator.rb" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id);
    expect(fnIds).toEqual(["operator.rb#Point.=="]);
  });

  it("captures a class-level setter/operator definition ('def self.name=' / 'def self.==') the same way", () => {
    const src = `
class Config
  def self.name=(v)
    @@name = v
  end

  def self.==(other)
    true
  end
end
`;
    const { nodes } = extractCodeGraph(src, { filePath: "class_setter.rb" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(fnIds).toEqual(["class_setter.rb#Config.==", "class_setter.rb#Config.name="]);
  });

  // Regression for an adversarial-review finding (XSPEC-333 R2c batch 3):
  // Ruby's explicit block-pass operator ("&handler") was not captured by
  // the by-reference-argument pattern at all (the identifier is nested one
  // level inside a "block_argument" node, not a direct child of
  // argument_list).
  it("captures a CALLS edge when a Proc/lambda is passed via the explicit block-pass operator ('&handler')", () => {
    const src = `
def handler_fn
end

def register(name, &blk)
end

def setup
  register("/x", &handler_fn)
end
`;
    const { edges } = extractCodeGraph(src, { filePath: "blockpass.rb" });
    const callsFromSetup = edges
      .filter((e) => e.label === "CALLS" && e.from === "blockpass.rb#setup")
      .map((e) => e.to)
      .sort();
    expect(callsFromSetup).toEqual(["blockpass.rb#handler_fn", "blockpass.rb#register"]);
  });

  it("does not treat a bodyless (declaration-only) definition specially — endless methods parse and resolve calls in their body", () => {
    const src = `
def helper(x)
  x
end

def compute(x) = helper(x)
`;
    const { edges } = extractCodeGraph(src, { filePath: "endless.rb" });
    const callsFromCompute = edges
      .filter((e) => e.label === "CALLS" && e.from === "endless.rb#compute")
      .map((e) => e.to);
    expect(callsFromCompute).toEqual(["endless.rb#helper"]);
  });
});

describe("CodeGraph cross-file resolution — Ruby", () => {
  it("resolves a call to a function defined in another file", () => {
    const { fragment, calls } = extractProject([
      {
        path: "mathutils.rb",
        source: "def square(n)\n  n * n\nend\n",
      },
      {
        path: "runner.rb",
        source: "def run(x)\n  square(x)\nend\n",
      },
    ]);
    expect(calls).toBe(1);
    const callEdge = fragment.edges.find((e) => e.label === "CALLS");
    expect(callEdge?.from).toBe("runner.rb#run");
    expect(callEdge?.to).toBe("mathutils.rb#square");
  });

  it("infers the ruby language from the .rb extension without an explicit language override", () => {
    const { edges } = extractCodeGraph(
      "def f\n  g()\nend\ndef g\n  1\nend\n",
      { filePath: "x.rb" },
    );
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(1);
  });
});
