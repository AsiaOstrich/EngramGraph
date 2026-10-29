// implements XSPEC-508
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdIndex } from "../src/cli/run.js";
import { extractCodeGraph, extractProject } from "../src/code-graph/extractor.js";
import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";

/**
 * Which function a bare-name call binds to. Two shapes upstream graphify fixed, checked here
 * against egr's own resolver.
 *
 * (a) A function declared INSIDE another function is local to it. egr put it in the file's
 *     one bare-name table anyway ("last definition wins"), so a nested `foo` declared after a
 *     top-level `foo` took the name over for the whole file and for every other file's `foo()`.
 * (b) A Python member call `self.run()` must bind to a function named `run`, not to `_run` or
 *     `Run` (names that only match once case or underscores are folded away).
 */

type Edge = { from: string; to: string };

function calls(fragment: { edges: Array<{ label: string; from: string; to: string }> }): Edge[] {
  return fragment.edges.filter((e) => e.label === "CALLS").map((e) => ({ from: e.from, to: e.to }));
}

const TOP_THEN_NESTED = [
  "export function foo() { return 1; }",
  "export function bar() {",
  "  function foo() { return 2; }", // local to bar, declared AFTER the top-level foo
  "  return foo();",
  "}",
  "export function baz() { return foo(); }", // top level: sees the top-level foo
  "",
].join("\n");

const NESTED_THEN_TOP = [
  "export function bar() {",
  "  function foo() { return 2; }", // declared BEFORE the top-level foo
  "  return foo();",
  "}",
  "export function foo() { return 1; }",
  "export function baz() { return foo(); }",
  "",
].join("\n");

describe("(a) a function declared inside another function does not leak its name to the file", () => {
  it("another file's foo() binds to the top-level foo, not to a nested foo declared after it", () => {
    const r = extractProject([
      { path: "a.ts", source: TOP_THEN_NESTED },
      { path: "b.ts", source: "export function caller() { return foo(); }\n" },
    ]);
    expect(calls(r.fragment)).toContainEqual({ from: "b.ts#caller", to: "a.ts#foo" });
    expect(calls(r.fragment).filter((e) => e.from === "b.ts#caller")).toEqual([{ from: "b.ts#caller", to: "a.ts#foo" }]);
  });

  it("the answer does not depend on declaration order", () => {
    const r = extractProject([
      { path: "a.ts", source: NESTED_THEN_TOP },
      { path: "b.ts", source: "export function caller() { return foo(); }\n" },
    ]);
    expect(calls(r.fragment).filter((e) => e.from === "b.ts#caller")).toEqual([{ from: "b.ts#caller", to: "a.ts#foo" }]);
  });

  it("inside the same file: a top-level function binds to the top-level foo, the enclosing function still binds to its own nested foo", () => {
    const edges = calls(extractProject([{ path: "a.ts", source: TOP_THEN_NESTED }]).fragment);
    expect(edges).toContainEqual({ from: "a.ts#baz", to: "a.ts#foo" });
    expect(edges).not.toContainEqual({ from: "a.ts#baz", to: "a.ts#bar.foo" });
    expect(edges).toContainEqual({ from: "a.ts#bar", to: "a.ts#bar.foo" }); // lexical shadowing is kept
    expect(edges).not.toContainEqual({ from: "a.ts#bar", to: "a.ts#foo" });
    // the single-file entry point resolves the same way
    const single = calls(extractCodeGraph(TOP_THEN_NESTED, { filePath: "a.ts" }));
    expect(single).toContainEqual({ from: "a.ts#baz", to: "a.ts#foo" });
    expect(single).toContainEqual({ from: "a.ts#bar", to: "a.ts#bar.foo" });
  });

  it("a nested function is visible to the functions nested alongside it in the same enclosing function, and not outside", () => {
    const src = [
      "export function outer() {",
      "  function helper() { return 1; }",
      "  function mid() { return helper(); }", // sibling: sees outer's helper
      "  return mid();",
      "}",
      "export function elsewhere() { return helper(); }", // outside: helper is not in scope
      "",
    ].join("\n");
    const edges = calls(extractProject([{ path: "a.ts", source: src }, { path: "b.ts", source: "export function other() { return helper(); }\n" }]).fragment);
    expect(edges).toContainEqual({ from: "a.ts#outer.mid", to: "a.ts#outer.helper" });
    expect(edges).toContainEqual({ from: "a.ts#outer", to: "a.ts#outer.mid" });
    expect(edges.filter((e) => e.from === "a.ts#elsewhere" || e.from === "b.ts#other")).toEqual([]);
  });

  it("a nested function nobody else defines is not callable from other files by its bare name", () => {
    const r = extractProject([
      { path: "a.ts", source: "export function bar() {\n  function onlyInside() { return 1; }\n  return onlyInside();\n}\n" },
      { path: "b.ts", source: "export function caller() { return onlyInside(); }\n" },
    ]);
    expect(calls(r.fragment)).toEqual([{ from: "a.ts#bar", to: "a.ts#bar.onlyInside" }]);
    expect(r.unresolved).toBe(1);
  });

  it("class methods are still found by their bare name from other files (a method is not 'inside a function')", () => {
    const r = extractProject([
      { path: "k.ts", source: "export class K {\n  run() { return 1; }\n  go() { return this.run(); }\n}\n" },
      { path: "b.ts", source: "export function caller(k: any) { return k.run(); }\n" },
    ]);
    expect(calls(r.fragment)).toContainEqual({ from: "b.ts#caller", to: "k.ts#K.run" });
    expect(calls(r.fragment)).toContainEqual({ from: "k.ts#K.go", to: "k.ts#K.run" });
  });

  it("Python: a def inside a def is local too", () => {
    const r = extractProject([
      { path: "a.py", source: "def foo():\n    return 1\n\ndef bar():\n    def foo():\n        return 2\n    return foo()\n\ndef baz():\n    return foo()\n" },
      { path: "b.py", source: "def caller():\n    return foo()\n" },
    ]);
    const edges = calls(r.fragment);
    expect(edges).toContainEqual({ from: "b.py#caller", to: "a.py#foo" });
    expect(edges).toContainEqual({ from: "a.py#baz", to: "a.py#foo" });
    expect(edges).toContainEqual({ from: "a.py#bar", to: "a.py#bar.foo" });
  });

  it("through the index command, read back from the graph: callers of foo are the top-level callers, bar keeps its own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egr-nested-names-"));
    const conn = GraphConnection.open(join(dir, "graph.db"));
    try {
      await initSchema(conn);
      writeFileSync(join(dir, "a.ts"), TOP_THEN_NESTED);
      writeFileSync(join(dir, "b.ts"), "export function caller() { return foo(); }\n");
      await cmdIndex(conn, { dir });
      const rows = await conn.query("MATCH (a:Function)-[:CALLS]->(b:Function) RETURN a.id AS f, b.id AS t ORDER BY f, t");
      expect(rows).toEqual([
        { f: "a.ts#bar", t: "a.ts#bar.foo" },
        { f: "a.ts#baz", t: "a.ts#foo" },
        { f: "b.ts#caller", t: "a.ts#foo" },
      ]);
    } finally {
      await conn.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("(a) and --incremental", () => {
  it("a file whose facts are reused keeps its nested functions local; a state written before nested functions were kept is not used", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egr-nested-incremental-"));
    const conn = GraphConnection.open(join(dir, "graph.db"));
    const manifestPath = join(dir, "graph.parse-manifest.json");
    const statePath = join(dir, "graph.incremental-state.json");
    const edgesNow = async () =>
      (await conn.query("MATCH (a:Function)-[:CALLS]->(b:Function) RETURN a.id AS f, b.id AS t ORDER BY f, t")).map((r) => `${r.f}->${r.t}`);
    try {
      await initSchema(conn);
      writeFileSync(join(dir, "a.ts"), TOP_THEN_NESTED);
      writeFileSync(join(dir, "b.ts"), "export function caller() { return foo(); }\n");
      await cmdIndex(conn, { dir, incremental: true, manifestPath });
      // Only b.ts changes: a.ts is NOT parsed again, its nested/top-level split comes from the remembered facts.
      writeFileSync(join(dir, "b.ts"), "export function caller() { return foo(); }\nexport function caller2() { return foo(); }\n");
      const r = await cmdIndex(conn, { dir, incremental: true, manifestPath });
      expect(r.incremental).toMatchObject({ mode: "incremental", reparsed: 1, reused: 1 });
      expect(await edgesNow()).toEqual(["a.ts#bar->a.ts#bar.foo", "a.ts#baz->a.ts#foo", "b.ts#caller->a.ts#foo", "b.ts#caller2->a.ts#foo"]);

      // A state of the previous version (names kept nested functions) must not be trusted.
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state.version = 1;
      writeFileSync(statePath, JSON.stringify(state));
      const again = await cmdIndex(conn, { dir, incremental: true, manifestPath });
      expect(again.incremental?.mode).toBe("full");
      expect(await edgesNow()).toEqual(["a.ts#bar->a.ts#bar.foo", "a.ts#baz->a.ts#foo", "b.ts#caller->a.ts#foo", "b.ts#caller2->a.ts#foo"]);
    } finally {
      await conn.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("(b) a Python member call binds to the exact name", () => {
  it("self.run() does not bind to _run() or Run()", () => {
    const r = extractProject([
      { path: "m.py", source: "def _run():\n    pass\n\ndef Run():\n    pass\n" },
      { path: "n.py", source: "class K:\n    def go(self):\n        self.run()\n" },
    ]);
    expect(calls(r.fragment)).toEqual([]);
    expect(r.unresolved).toBe(1);
  });

  it("each spelling binds to itself and to nothing else", () => {
    const r = extractProject([
      { path: "m.py", source: "def _run():\n    pass\n\ndef Run():\n    pass\n\ndef run():\n    pass\n" },
      {
        path: "n.py",
        source: "class K:\n    def plain(self):\n        self.run()\n    def under(self):\n        self._run()\n    def upper(self):\n        self.Run()\n",
      },
    ]);
    expect(calls(r.fragment).sort((a, b) => a.from.localeCompare(b.from))).toEqual([
      { from: "n.py#K.plain", to: "m.py#run" },
      { from: "n.py#K.under", to: "m.py#_run" },
      { from: "n.py#K.upper", to: "m.py#Run" },
    ]);
  });

  it("inside one file: self.run() does not bind to a module-level _run or Run when there is no run", () => {
    const r = extractProject([
      { path: "m.py", source: "def _run():\n    pass\n\ndef Run():\n    pass\n\nclass K:\n    def go(self):\n        self.run()\n" },
    ]);
    expect(calls(r.fragment)).toEqual([]);
    expect(calls(extractCodeGraph("def _run():\n    pass\n\nclass K:\n    def go(self):\n        self.run()\n", { filePath: "m.py" }))).toEqual([]);
  });

  it("inside one file: self.run() binds to the method run, not to a module-level _run", () => {
    const edges = calls(
      extractProject([
        { path: "m.py", source: "def _run():\n    pass\n\nclass K:\n    def run(self):\n        pass\n    def go(self):\n        self.run()\n" },
      ]).fragment,
    );
    expect(edges).toEqual([{ from: "m.py#K.go", to: "m.py#K.run" }]);
  });
});

describe("(a)(b) through the CLI", () => {
  let built: BuiltEgr;
  let work: string;
  beforeAll(() => {
    built = buildEgr();
    work = mkdtempSync(join(tmpdir(), "egr-call-binding-"));
  }, 120_000);
  afterAll(() => {
    built?.cleanup();
    rmSync(work, { recursive: true, force: true });
  });

  function egr(args: string[], db: string, cwd: string) {
    const r = spawnSync(process.execPath, [built.cli, ...args], { encoding: "utf8", env: { ...process.env, ENGRAM_DB: db }, cwd });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it("egr callees --depth 2 from another file's caller reaches what the top-level foo calls, not what the nested foo calls; a Python _run has no caller that wrote run", () => {
    const root = join(work, "p");
    mkdirSync(root, { recursive: true });
    // The CLI prints names, not ids, so the two foo are told apart by what each one calls.
    writeFileSync(
      join(root, "a.ts"),
      [
        "export function leaf() { return 0; }",
        "export function nestedLeaf() { return 0; }",
        "export function foo() { return leaf(); }",
        "export function bar() {",
        "  function foo() { return nestedLeaf(); }",
        "  return foo();",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(join(root, "b.ts"), "export function caller() { return foo(); }\n");
    writeFileSync(join(root, "m.py"), "def _run():\n    pass\n");
    writeFileSync(join(root, "n.py"), "class K:\n    def go(self):\n        self.run()\n");
    const db = join(work, "p.db");
    expect(egr(["index", "."], db, root).status).toBe(0);

    const callee = egr(["callees", "caller", "--depth", "2"], db, root);
    expect(callee.status, callee.stderr).toBe(0);
    expect(callee.stdout).toContain("leaf");
    expect(callee.stdout).not.toContain("nestedLeaf");

    const under = egr(["callers", "_run"], db, root);
    expect(under.status, under.stderr).toBe(0);
    expect(under.stdout).not.toContain("go");
  });
});
