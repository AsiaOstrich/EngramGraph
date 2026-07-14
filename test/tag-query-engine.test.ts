import { describe, it, expect } from "vitest";
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";

import {
  runTagQuery,
  qualifyFunctions,
  findEnclosingFunction,
  collectComments,
} from "../src/code-graph/tag-query-engine.js";
import { tagsQuerySourceFor } from "../src/code-graph/queries/index.js";
import { extractCodeGraph } from "../src/code-graph/extractor.js";

// XSPEC-333 R2a: unit coverage for the tag-query engine itself (the
// declarative replacement for the old hand-written recursive walker), not
// just the extractor's end-to-end behavior already covered by
// code-graph.test.ts.

function parseJs(source: string) {
  const parser = new Parser();
  parser.setLanguage(JavaScript);
  return parser.parse(source);
}

function parseTs(source: string) {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  return parser.parse(source);
}

describe("runTagQuery", () => {
  it("captures function_declaration, generator_function_declaration and method_definition as function definitions", () => {
    const src = `
      function a() {}
      function* b() {}
      class C { m() {} }
    `;
    const tree = parseJs(src);
    const { definitions } = runTagQuery(JavaScript, "javascript", tagsQuerySourceFor("javascript"), tree.rootNode);
    const fnNames = definitions.filter((d) => d.kind === "function").map((d) => d.name).sort();
    expect(fnNames).toEqual(["a", "b", "m"]);
    const classNames = definitions.filter((d) => d.kind === "class").map((d) => d.name);
    expect(classNames).toEqual(["C"]);
  });

  it("captures an arrow/function expression only when bound to a variable, not as a bare callback argument", () => {
    const src = `
      const bound = () => 1;
      register(() => 2);
    `;
    const tree = parseJs(src);
    const { definitions } = runTagQuery(JavaScript, "javascript", tagsQuerySourceFor("javascript"), tree.rootNode);
    expect(definitions.filter((d) => d.kind === "function").map((d) => d.name)).toEqual(["bound"]);
  });

  it("does not capture an anonymous class expression (no name field)", () => {
    const src = `const X = class { m() {} };`;
    const tree = parseJs(src);
    const { definitions } = runTagQuery(JavaScript, "javascript", tagsQuerySourceFor("javascript"), tree.rootNode);
    expect(definitions.filter((d) => d.kind === "class")).toHaveLength(0);
    // the method inside the anonymous class is still captured (matches the
    // old walker: a function/class node is only skipped when it truly has
    // no name — the enclosing anonymous class simply doesn't push a scope).
    expect(definitions.filter((d) => d.kind === "function").map((d) => d.name)).toEqual(["m"]);
  });

  // A degenerate but syntactically legal case: a function value directly
  // bound via a destructuring pattern (`const {f} = () => 1`), rather than a
  // plain identifier. The old walker took the raw `.text` of the
  // variable_declarator's name field with no type check, so it produced a
  // garbage-but-real Function node named "{f}" — this preserves that exact
  // (odd) behavior rather than quietly dropping the definition.
  it("captures a function value destructure-bound to a non-identifier pattern, using its raw text as the name", () => {
    const src = `const {f} = () => 1;`;
    const tree = parseJs(src);
    const { definitions } = runTagQuery(JavaScript, "javascript", tagsQuerySourceFor("javascript"), tree.rootNode);
    expect(definitions.filter((d) => d.kind === "function").map((d) => d.name)).toEqual(["{f}"]);
  });

  it("captures a direct call and a callee reached through a member expression", () => {
    const src = `function f() { helper(); console.log("x"); }`;
    const tree = parseJs(src);
    const { callSites } = runTagQuery(JavaScript, "javascript", tagsQuerySourceFor("javascript"), tree.rootNode);
    expect(callSites.map((c) => c.name).sort()).toEqual(["helper", "log"]);
  });

  it("captures a direct-identifier call argument but not one nested in an object literal", () => {
    const src = `f(directRef, { handler: nested });`;
    const tree = parseJs(src);
    const { callSites } = runTagQuery(JavaScript, "javascript", tagsQuerySourceFor("javascript"), tree.rootNode);
    const names = callSites.map((c) => c.name);
    expect(names).toContain("directRef");
    expect(names).not.toContain("nested");
  });

  // Not just "the array equals its own sorted copy" (that would pass even if
  // runTagQuery did nothing) — this asserts the *specific* expected document
  // order: the outer function, then its nested namesake, then a later
  // top-level sibling with the same name. This ordering is what
  // `collectExtraction`'s "last bare-name definition wins" resolution
  // (extractor.ts) and qualifyFunctions' ancestor reconstruction both rely
  // on being pre-order-DFS-equivalent.
  it("returns definitions in document order, not grouped by which query pattern matched", () => {
    const src = `function outer() { function helper(){} }\nfunction helper(){}`;
    const tree = parseJs(src);
    const { definitions } = runTagQuery(JavaScript, "javascript", tagsQuerySourceFor("javascript"), tree.rootNode);
    expect(definitions.map((d) => d.name)).toEqual(["outer", "helper", "helper"]);
  });

  // Regression: member_expression's "property" field can be a
  // private_property_identifier (`this.#priv()`), not just a
  // property_identifier — a pattern restricted to property_identifier alone
  // silently drops every private-method call.
  it("captures a call through a private-field member expression (this.#priv())", () => {
    const src = `class C { #priv(){ return 1; } run(){ return this.#priv(); } }`;
    const tree = parseJs(src);
    const { callSites } = runTagQuery(JavaScript, "javascript", tagsQuerySourceFor("javascript"), tree.rootNode);
    expect(callSites.map((c) => c.name)).toContain("#priv");
  });

  it("uses type_identifier for a TypeScript class name (vs identifier for JS)", () => {
    const tree = parseTs(`class Foo { m() {} }`);
    const { definitions } = runTagQuery(
      TypeScript.typescript,
      "typescript",
      tagsQuerySourceFor("typescript"),
      tree.rootNode,
    );
    expect(definitions.find((d) => d.kind === "class")?.name).toBe("Foo");
  });

  // Regression: a method_definition's `name` field is not always a
  // property_identifier — computed (`[x](){}`), private (`#x(){}`), string
  // (`"x"(){}`) and numeric (`1(){}`) method names all use a different node
  // type there. The old walker took the raw `.text` of whatever occupied the
  // name field with no type check, so all five must still be captured
  // (see the wildcard `(_)` pattern in queries/javascript.ts).
  it("captures a method_definition regardless of its name field's node type", () => {
    const src = `class C { "str"(){} 1(){} #priv(){} [Symbol.iterator](){} normal(){} }`;
    const tree = parseJs(src);
    const { definitions } = runTagQuery(JavaScript, "javascript", tagsQuerySourceFor("javascript"), tree.rootNode);
    const names = definitions.filter((d) => d.kind === "function").map((d) => d.name).sort();
    expect(names).toEqual(['"str"', "#priv", "1", "[Symbol.iterator]", "normal"]);
  });
});

describe("qualifyFunctions", () => {
  it("qualifies a nested function by its enclosing function's name", () => {
    const src = `function outer() { function helper(){ return 1; } return helper(); }\nfunction helper(){ return 2; }`;
    const tree = parseJs(src);
    const { definitions } = runTagQuery(JavaScript, "javascript", tagsQuerySourceFor("javascript"), tree.rootNode);
    const { functions } = qualifyFunctions("x.ts", definitions);
    expect(functions.map((f) => f.id).sort()).toEqual(["x.ts#helper", "x.ts#outer", "x.ts#outer.helper"]);
  });

  it("qualifies a class method by the class name but a Class node's own id is never scope-qualified", () => {
    const src = `class Service { execute(){ return 1; } }`;
    const tree = parseJs(src);
    const { definitions } = runTagQuery(JavaScript, "javascript", tagsQuerySourceFor("javascript"), tree.rootNode);
    const { functions, classes } = qualifyFunctions("svc.ts", definitions);
    expect(functions.map((f) => f.id)).toEqual(["svc.ts#Service.execute"]);
    expect(classes.map((c) => c.name)).toEqual(["Service"]);
  });

  it("qualifies a doubly-nested function through both enclosing scopes, outer-to-inner", () => {
    const src = `
      class Outer {
        run() {
          function helper() { return 1; }
          return helper();
        }
      }
    `;
    const tree = parseJs(src);
    const { definitions } = runTagQuery(JavaScript, "javascript", tagsQuerySourceFor("javascript"), tree.rootNode);
    const { functions } = qualifyFunctions("n.ts", definitions);
    const helper = functions.find((f) => f.name === "helper");
    expect(helper?.id).toBe("n.ts#Outer.run.helper");
  });

  // A class nested inside a method contributes its name to the *function*
  // scope chain (Outer.method.Inner.innerMethod), even though a sibling
  // function declared *after* that nested class in the same method body is
  // NOT qualified by it (Outer.method.helperInMethod, no "Inner" segment) —
  // exactly the pre-order-DFS scopeStack push/pop semantics of the old
  // walker, reconstructed here purely from byte-range containment.
  it("qualifies through a class nested inside a method, without leaking scope to a later sibling", () => {
    const src = `
      class Outer {
        method() {
          class Inner {
            innerMethod() { return helperInMethod(); }
          }
          function helperInMethod() { return 1; }
          return new Inner();
        }
      }
    `;
    const tree = parseJs(src);
    const { definitions } = runTagQuery(JavaScript, "javascript", tagsQuerySourceFor("javascript"), tree.rootNode);
    const { functions } = qualifyFunctions("deep.ts", definitions);
    const ids = Object.fromEntries(functions.map((f) => [f.name, f.id]));
    expect(ids["method"]).toBe("deep.ts#Outer.method");
    expect(ids["innerMethod"]).toBe("deep.ts#Outer.method.Inner.innerMethod");
    expect(ids["helperInMethod"]).toBe("deep.ts#Outer.method.helperInMethod");
  });
});

describe("findEnclosingFunction", () => {
  it("finds the innermost enclosing function for a nested position", () => {
    const src = `function outer() { function inner() { return 1; } return inner(); }`;
    const tree = parseJs(src);
    const { definitions, callSites } = runTagQuery(
      JavaScript,
      "javascript",
      tagsQuerySourceFor("javascript"),
      tree.rootNode,
    );
    const { functions } = qualifyFunctions("x.ts", definitions);
    const innerCall = callSites.find((c) => c.name === "inner");
    expect(innerCall).toBeDefined();
    const enclosing = findEnclosingFunction(functions, innerCall!.node);
    expect(enclosing?.name).toBe("outer");
  });

  it("returns null for a position outside any function (module top level)", () => {
    const src = `function outer() {}\ntopLevelCall();`;
    const tree = parseJs(src);
    const { definitions, callSites } = runTagQuery(
      JavaScript,
      "javascript",
      tagsQuerySourceFor("javascript"),
      tree.rootNode,
    );
    const { functions } = qualifyFunctions("x.ts", definitions);
    const call = callSites.find((c) => c.name === "topLevelCall");
    expect(findEnclosingFunction(functions, call!.node)).toBeNull();
  });

  // Regression: tree-sitter's `endIndex` is the exclusive byte just past a
  // node's last byte. A call immediately adjacent to (not inside) a
  // function's closing brace — e.g. minified `function f(){}g();` — has
  // `startIndex === f.endIndex`. A start-only / inclusive-end containment
  // check wrongly treats that as "g() is inside f", fabricating a CALLS
  // edge that the old walker (whose `currentFn` truly tracks "am I lexically
  // inside a function body") never produced.
  it("does not treat a call immediately adjacent to a function's end as enclosed by it", () => {
    const src = `function f(){}g();function g(){}`;
    const tree = parseJs(src);
    const { definitions, callSites } = runTagQuery(
      JavaScript,
      "javascript",
      tagsQuerySourceFor("javascript"),
      tree.rootNode,
    );
    const { functions } = qualifyFunctions("adj.ts", definitions);
    const call = callSites.find((c) => c.name === "g");
    expect(findEnclosingFunction(functions, call!.node)).toBeNull();
  });
});

describe("collectComments", () => {
  it("collects every comment node's text regardless of nesting depth", () => {
    const src = `
      // top level
      function f() {
        // nested
        return 1;
      }
    `;
    const tree = parseJs(src);
    const comments = collectComments(tree.rootNode);
    expect(comments).toHaveLength(2);
    expect(comments.some((c) => c.includes("top level"))).toBe(true);
    expect(comments.some((c) => c.includes("nested"))).toBe(true);
  });
});

// End-to-end regression coverage through the real public API
// (extractCodeGraph), not just the internal engine primitives above — these
// exercise the exact two bugs an adversarial review caught before this was
// committed (findEnclosingFunction's containment off-by-one and the missing
// private_property_identifier call pattern), plus a minimal .tsx smoke test
// (previously zero coverage: a broken TSX query pattern would only surface
// the first time someone indexed a real .tsx file, not at build time).
describe("extractCodeGraph — tag-query engine end-to-end regressions", () => {
  it("does not fabricate a CALLS edge for a call immediately adjacent to a function's closing brace", () => {
    const { edges } = extractCodeGraph(`function f(){}g();function g(){}`, { filePath: "adj.ts" });
    // g() is a top-level call (no enclosing function) — same as the old
    // walker's `currentFn` gate — so it must not resolve to any CALLS edge,
    // in particular not a spurious f -> g.
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(0);
  });

  it("resolves a CALLS edge for a private-method call (this.#priv())", () => {
    const src = `class C { #priv(){ return 1; } run(){ return this.#priv(); } }`;
    const { edges } = extractCodeGraph(src, { filePath: "priv.ts" });
    const calls = edges.filter((e) => e.label === "CALLS");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ from: "priv.ts#C.run", to: "priv.ts#C.#priv" });
  });

  it("parses a minimal .tsx file and extracts a function (tag query compiles for the tsx grammar)", () => {
    const src = `function Greeting() { return helper(); }\nfunction helper() { return 1; }`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "component.tsx" });
    expect(nodes.filter((n) => n.label === "Function").map((n) => n.properties.name).sort()).toEqual([
      "Greeting",
      "helper",
    ]);
    expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(1);
  });
});
