import { describe, it, expect } from "vitest";

import { extractCodeGraph, extractProject } from "../src/code-graph/extractor.js";
import { runTagQuery } from "../src/code-graph/tag-query-engine.js";
import { tagsQuerySourceFor } from "../src/code-graph/queries/index.js";
import PhpModule from "tree-sitter-php";
import Parser from "tree-sitter";

// XSPEC-333 R2c batch 3: PHP is the FIRST language on this engine where
// class instantiation is NOT ambiguous with a call (`new Foo()` has its own
// distinct node type) — see queries/php.ts's module doc comment.

const Php = PhpModule.php;

function parsePhp(source: string) {
  const parser = new Parser();
  parser.setLanguage(Php);
  return parser.parse(source);
}

const CALCULATOR_SAMPLE = `<?php
class Calculator {
  public function compute($x) {
    return square($x) + $this->helper();
  }

  private function helper() {
    return $this->base;
  }
}

function square($n) {
  return $n * $n;
}
`;

describe("CodeGraph extractor — PHP (XSPEC-333 R2c batch 3)", () => {
  it("extracts Module and Function nodes (incl. methods) with CALLS edges", () => {
    const { nodes, edges } = extractCodeGraph(CALCULATOR_SAMPLE, { filePath: "calculator.php" });

    const functionIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(functionIds).toEqual([
      "calculator.php#Calculator.compute",
      "calculator.php#Calculator.helper",
      "calculator.php#square",
    ]);

    const modules = nodes.filter((n) => n.label === "Module");
    expect(modules).toHaveLength(1);

    const callsFromCompute = edges
      .filter((e) => e.label === "CALLS" && e.from === "calculator.php#Calculator.compute")
      .map((e) => e.to)
      .sort();
    expect(callsFromCompute).toEqual([
      "calculator.php#Calculator.helper",
      "calculator.php#square",
    ]);
  });

  it("stamps every Function node with provider: tree-sitter", () => {
    const { nodes } = extractCodeGraph(CALCULATOR_SAMPLE, { filePath: "calculator.php" });
    for (const n of nodes.filter((n) => n.label === "Function")) {
      expect(n.properties.provider).toBe("tree-sitter");
    }
  });

  it("captures interface and trait declarations as bonus Class-like scope containers", () => {
    const src = `<?php
interface Shape {
  public function area();
}

trait Greetable {
  public function greet() {
    speak();
  }
}

function speak() {
}
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "shapes.php" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name).sort();
    expect(classNames).toEqual(["Greetable", "Shape"]);
    // "area()" has no body (interface method) — still captured as a Function
    // (empty, call-free), mirroring Java's/C#'s own precedent, NOT C++'s —
    // see queries/php.ts's module doc comment for why PHP differs from C++
    // here.
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(fnIds).toEqual(["shapes.php#Greetable.greet", "shapes.php#Shape.area", "shapes.php#speak"]);
    expect(
      edges.some(
        (e) =>
          e.label === "CALLS" &&
          e.from === "shapes.php#Greetable.greet" &&
          e.to === "shapes.php#speak",
      ),
    ).toBe(true);
    expect(edges.some((e) => e.from === "shapes.php#Shape.area")).toBe(false);
  });

  // Regression for an adversarial-review finding (XSPEC-333 R2c batch 3):
  // a namespace-qualified bare call ("App\Util\helper($x)") sets
  // function_call_expression's function: field to a qualified_name node,
  // not a bare (name) — before this fix, this produced ZERO CALLS edges.
  it("resolves a namespace-qualified bare call ('App\\Util\\helper($x)')", () => {
    const src = `<?php
namespace App\\Util;

function helper($x) {
  return $x;
}

namespace App;

function caller_fn($x) {
  return \\App\\Util\\helper($x);
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "namespaced.php" });
    const callsFromCaller = edges
      .filter((e) => e.label === "CALLS" && e.from.endsWith("#caller_fn"))
      .map((e) => e.to);
    expect(callsFromCaller).toEqual(["namespaced.php#helper"]);
  });

  it("resolves a global-namespace-escape bare call ('\\\\strlen(...)'-style leading backslash) to a same-named local function", () => {
    const src = `<?php
function myHelper($x) {
  return $x;
}

function caller_fn($x) {
  return \\myHelper($x);
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "globalescape.php" });
    const callsFromCaller = edges
      .filter((e) => e.label === "CALLS" && e.from === "globalescape.php#caller_fn")
      .map((e) => e.to);
    expect(callsFromCaller).toEqual(["globalescape.php#myHelper"]);
  });

  it("resolves a '::' scoped static call the same as a '->' member call", () => {
    const src = `<?php
class Foo {
  public static function bar($x) {
    return $x;
  }
}

function caller_fn($x) {
  return Foo::bar($x);
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "scoped.php" });
    const callsFromCaller = edges
      .filter((e) => e.label === "CALLS" && e.from === "scoped.php#caller_fn")
      .map((e) => e.to);
    expect(callsFromCaller).toEqual(["scoped.php#Foo.bar"]);
  });

  it("resolves a nullsafe ('?->') member call the same as a plain '->' call", () => {
    const src = `<?php
class Foo {
  public function helper() {
    return 1;
  }
}

function caller_fn($obj) {
  return $obj?->helper();
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "nullsafe.php" });
    const callsFromCaller = edges
      .filter((e) => e.label === "CALLS" && e.from === "nullsafe.php#caller_fn")
      .map((e) => e.to);
    expect(callsFromCaller).toEqual(["nullsafe.php#Foo.helper"]);
  });

  it("excludes named arguments (PHP 8+) from the by-reference call-argument pattern", () => {
    const src = `<?php
function register($handler, $path) {
}

function setup($someHandler, $somePath) {
  register(handler: $someHandler, path: $somePath);
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "namedargs.php" });
    const callsFromSetup = edges
      .filter((e) => e.label === "CALLS" && e.from === "namedargs.php#setup")
      .map((e) => e.to);
    // Only "register" itself resolves; the named-argument VALUES must not
    // resolve via the by-reference-argument pattern (they aren't excluded
    // from CALLS because they don't match any real function anyway here,
    // but the key assertion is no by-ref capture fired for them — verified
    // more directly in the tag-query-engine-level test below).
    expect(callsFromSetup).toEqual(["namedargs.php#register"]);
  });

  it("does not capture a named-argument's variable value as a by-reference call target (tag-query level)", () => {
    const src = `<?php
foo(handler: $handlerFn, path: $pathVar);
`;
    const { callSites } = runTagQuery(Php, "php", tagsQuerySourceFor("php"), parsePhp(src).rootNode);
    const argNames = callSites.map((c) => c.name);
    expect(argNames).not.toContain("handlerFn");
    expect(argNames).not.toContain("pathVar");
  });

  it("captures a CALLS edge when a Closure variable is passed by reference as a direct call argument", () => {
    const src = `<?php
function handlerFn($x) {
}

function register($name, $h) {
}

function setup() {
  register("/x", $handlerFn);
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "setup.php" });
    const callsFromSetup = edges
      .filter((e) => e.label === "CALLS" && e.from === "setup.php#setup")
      .map((e) => e.to)
      .sort();
    expect(callsFromSetup).toEqual(["setup.php#handlerFn", "setup.php#register"]);
  });

  it("round-trips a closure bound to a variable, then passed by reference to another call", () => {
    const src = `<?php
function bar($x) {
}

function setup() {
  $handlerFn = function($x) {
    bar($x);
  };
  register($handlerFn);
}
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "closure.php" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(fnIds).toEqual(["closure.php#bar", "closure.php#setup", "closure.php#setup.handlerFn"]);

    const callsFromSetup = edges
      .filter((e) => e.label === "CALLS" && e.from === "closure.php#setup")
      .map((e) => e.to);
    expect(callsFromSetup).toEqual(["closure.php#setup.handlerFn"]);

    const callsFromHandler = edges
      .filter((e) => e.label === "CALLS" && e.from === "closure.php#setup.handlerFn")
      .map((e) => e.to);
    expect(callsFromHandler).toEqual(["closure.php#bar"]);
  });

  it("does not fabricate a Function definition for list()/[] destructuring assignment mixing a closure", () => {
    const src = `<?php
[$a, $f] = [1, function() {}];
`;
    const { definitions } = runTagQuery(Php, "php", tagsQuerySourceFor("php"), parsePhp(src).rootNode);
    const fnNames = definitions.filter((d) => d.kind === "function").map((d) => d.name);
    expect(fnNames).not.toContain("a");
    expect(fnNames).not.toContain("f");
  });

  it("does not resolve PHP's own variable-variable dynamic call ('$fn()') as if '$fn' were the callee's name", () => {
    const src = `<?php
function helper() {
  return 1;
}

function caller_fn() {
  $fn = 'helper';
  return $fn();
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "dynamic.php" });
    const callsFromCaller = edges
      .filter((e) => e.label === "CALLS" && e.from === "dynamic.php#caller_fn")
      .map((e) => e.to);
    expect(callsFromCaller).toEqual([]);
  });

  it("does not produce a call reference for object instantiation ('new Foo()') — PHP has a distinct node type, unlike every other language on this engine", () => {
    const src = `<?php
class Foo {
  public function __construct($a) {
  }
}

function caller_fn($a) {
  $x = new Foo($a);
  return $x;
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "instantiate.php" });
    const callsFromCaller = edges.filter(
      (e) => e.label === "CALLS" && e.from === "instantiate.php#caller_fn",
    );
    expect(callsFromCaller).toHaveLength(0);
  });

  it("captures a PHP 8.1+ first-class callable reference (bare, member, and static forms) as a by-reference call target", () => {
    const src = `<?php
function helperFn($x) {
}

class Foo {
  public function method($x) {
  }
  public static function staticMethod($x) {
  }
}

function setup() {
  $obj = new Foo();
  array_map(helperFn(...), [1, 2]);
  array_map($obj->method(...), [1, 2]);
  array_map(Foo::staticMethod(...), [1, 2]);
}
`;
    const { edges } = extractCodeGraph(src, { filePath: "fcc.php" });
    const callsFromSetup = edges
      .filter((e) => e.label === "CALLS" && e.from === "fcc.php#setup")
      .map((e) => e.to)
      .sort();
    // Exact set (not just toContain): "array_map" itself is never defined in
    // this file, so it does not resolve — only the three fcc-referenced
    // targets do.
    expect(callsFromSetup).toEqual([
      "fcc.php#Foo.method",
      "fcc.php#Foo.staticMethod",
      "fcc.php#helperFn",
    ]);
  });
});

describe("CodeGraph cross-file resolution — PHP", () => {
  it("resolves a call to a function defined in another file", () => {
    const { fragment, calls } = extractProject([
      {
        path: "mathutils.php",
        source: "<?php\nfunction square($n) {\n  return $n * $n;\n}\n",
      },
      {
        path: "runner.php",
        source: "<?php\nfunction run($x) {\n  return square($x);\n}\n",
      },
    ]);
    expect(calls).toBe(1);
    const callEdge = fragment.edges.find((e) => e.label === "CALLS");
    expect(callEdge?.from).toBe("runner.php#run");
    expect(callEdge?.to).toBe("mathutils.php#square");
  });

  it("infers the php language from the .php extension without an explicit language override", () => {
    const { edges } = extractCodeGraph(
      "<?php\nfunction f() {\n  return g();\n}\nfunction g() {\n  return 1;\n}\n",
      { filePath: "x.php" },
    );
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(1);
  });
});
