import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { extractCodeGraph, extractProject } from "../src/code-graph/extractor.js";
import { indexFile, indexProject } from "../src/code-graph/indexer.js";
import { callers, callees, callChain, implementers, implementedSpecs } from "../src/code-graph/query.js";
import { createServer } from "../src/api/server.js";

const TS_SAMPLE = `
import { foo } from "./foo";

export function execute(x: number): number {
  const y = helper(x);
  log(y);
  return foo(y);
}

function helper(n: number): number {
  return n + 1;
}

const log = (m: unknown): void => console.log(m);
`;

const CLASS_SAMPLE = `
function helper(n: number): number { return n + 1; }

class Service {
  run(): number {
    return this.execute();
  }
  execute(): number {
    return helper(2);
  }
}
`;

describe("CodeGraph extractor (Phase 2)", () => {
  it("extracts Module, Function and Class nodes with CALLS edges", () => {
    const { nodes, edges } = extractCodeGraph(TS_SAMPLE, { filePath: "src/a.ts" });

    const functions = nodes.filter((n) => n.label === "Function").map((n) => n.properties.name);
    expect(functions.sort()).toEqual(["execute", "helper", "log"]);

    const modules = nodes.filter((n) => n.label === "Module");
    expect(modules).toHaveLength(1);
    expect(modules[0]?.id).toBe("src/a.ts");

    // DEFINES: Module → every Function
    const defines = edges.filter((e) => e.label === "DEFINES");
    expect(defines).toHaveLength(3);

    // CALLS from execute → helper, log (foo is imported → unresolved, dropped)
    const callsFromExecute = edges
      .filter((e) => e.label === "CALLS" && e.from === "src/a.ts#execute")
      .map((e) => e.to)
      .sort();
    expect(callsFromExecute).toEqual(["src/a.ts#helper", "src/a.ts#log"]);
  });

  // XSPEC-333 R1: every Function/Class node this extractor produces must be
  // stamped with its provider so the writer's overwrite policy (writer.ts)
  // can tell a tree-sitter re-index apart from a future different-provider
  // write.
  it("stamps every Function node with provider: tree-sitter", () => {
    const { nodes } = extractCodeGraph(TS_SAMPLE, { filePath: "src/a.ts" });
    const functions = nodes.filter((n) => n.label === "Function");
    expect(functions.length).toBeGreaterThan(0);
    for (const fn of functions) {
      expect(fn.properties.provider).toBe("tree-sitter");
    }
  });

  it("captures class methods as Function nodes and a Class node", () => {
    const { nodes } = extractCodeGraph(CLASS_SAMPLE, { filePath: "src/svc.ts" });

    const classes = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name);
    expect(classes).toEqual(["Service"]);

    const fnNames = nodes.filter((n) => n.label === "Function").map((n) => n.properties.name).sort();
    expect(fnNames).toEqual(["execute", "helper", "run"]);
  });

  it("stamps every Class node with provider: tree-sitter", () => {
    const { nodes } = extractCodeGraph(CLASS_SAMPLE, { filePath: "src/svc.ts" });
    const classes = nodes.filter((n) => n.label === "Class");
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls.properties.provider).toBe("tree-sitter");
    }
  });

  it("scope-qualifies ids so same-name functions in different scopes don't collide", () => {
    const src = "function outer() { function helper(){ return 1; } return helper(); }\nfunction helper(){ return 2; }";
    const { nodes } = extractCodeGraph(src, { filePath: "x.ts" });
    const fnIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    // nested helper qualified by its enclosing function; top-level helper distinct
    expect(fnIds).toEqual(["x.ts#helper", "x.ts#outer", "x.ts#outer.helper"]);
  });

  it("infers language from extension (.js parses too)", () => {
    const js = `function a(){ return b(); } function b(){ return 1; }`;
    const { edges } = extractCodeGraph(js, { filePath: "x.js" });
    const calls = edges.filter((e) => e.label === "CALLS");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.from).toBe("x.js#a");
    expect(calls[0]?.to).toBe("x.js#b");
  });

  // R1 (XSPEC-331): a `// implements XSPEC-NNN` comment links the file to a
  // spec via a Module→Spec IMPLEMENTS edge, plus a stub Spec target node.
  it("emits IMPLEMENTS(Module→Spec) + stub Spec node from an `// implements` comment", () => {
    const src = `// implements XSPEC-190 AC-3\nexport function run() { return 1; }`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "src/run.ts" });

    const impl = edges.filter((e) => e.label === "IMPLEMENTS");
    expect(impl).toHaveLength(1);
    expect(impl[0]).toMatchObject({
      fromLabel: "Module",
      from: "src/run.ts",
      toLabel: "Spec",
      to: "XSPEC-190", // X preserved (distinct namespace); AC-3 ignored
    });

    // stub Spec node created so the edge target exists, with no properties so a
    // later `index --docs` pass never has its title/status/confidence clobbered.
    const spec = nodes.find((n) => n.label === "Spec" && n.id === "XSPEC-190");
    expect(spec).toBeDefined();
    expect(spec?.properties).toEqual({});
  });

  it("links a function-less file (OQ-3: module-level convention) and dedupes ids", () => {
    // Pure type file — no Function nodes — is exactly why IMPLEMENTS is
    // Module→Spec, not Function→Spec. Two mentions of the same id → one edge.
    const src = `// implements XSPEC-190\n// implements XSPEC-190 (see also SPEC-75)\nexport type T = string;`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "src/types.ts" });

    expect(nodes.filter((n) => n.label === "Function")).toHaveLength(0);
    const targets = edges.filter((e) => e.label === "IMPLEMENTS").map((e) => e.to).sort();
    expect(targets).toEqual(["SPEC-75", "XSPEC-190"]);
  });

  it("does not emit IMPLEMENTS for a spec id mentioned without the `implements` keyword", () => {
    const src = `// see SPEC-123 for the rationale\nexport function run() { return 1; }`;
    const { edges } = extractCodeGraph(src, { filePath: "src/x.ts" });
    expect(edges.filter((e) => e.label === "IMPLEMENTS")).toHaveLength(0);
  });

  // Regression for a real gap found comparing egr against an external tool
  // (colbymchenry/codegraph) on vibeops/src: `callers()` was blind to a
  // function passed *by reference* to a higher-order call (Fastify's
  // `app.register(pluginFn, opts)`), because only `fn()` call-expression
  // callees were captured — never bare identifiers appearing as arguments.
  // See dev-platform DEC-081 v1.1.0 / DEC-095 / improvement-backlog.md L11.
  it("captures a CALLS edge when a function is passed by reference as a call argument", () => {
    const src = `
      function alertRulesRoutes(app) { return app; }
      async function createApp() {
        await app.register(alertRulesRoutes, { prefix: "/api/alerts" });
      }
    `;
    const { edges } = extractCodeGraph(src, { filePath: "server.ts" });
    const callsFromCreateApp = edges
      .filter((e) => e.label === "CALLS" && e.from === "server.ts#createApp")
      .map((e) => e.to);
    expect(callsFromCreateApp).toContain("server.ts#alertRulesRoutes");
  });

  it("does not capture an identifier nested inside an object/array literal argument", () => {
    // `bar` here is only reachable through the `handler` property — a
    // materially weaker signal than a direct argument (see module doc
    // comment on scope). Deliberately not resolved, to keep false-positive
    // risk bounded to the concrete case that motivated this feature.
    const src = `
      function bar() { return 1; }
      function register(opts) { return opts; }
      function setup() {
        register({ handler: bar });
      }
    `;
    const { edges } = extractCodeGraph(src, { filePath: "y.ts" });
    const callsFromSetup = edges
      .filter((e) => e.label === "CALLS" && e.from === "y.ts#setup")
      .map((e) => e.to);
    expect(callsFromSetup).not.toContain("y.ts#bar");
  });

  it("does not spuriously resolve a plain (non-function) argument identifier", () => {
    // `opts` is just a local variable, not a known function — must not
    // resolve to anything, same as an ordinary unresolved call would.
    // `pass` is a bare-identifier argument to `use()` and resolves (the
    // feature under test); `use()` itself is also a real direct call.
    const src = `
      function use(fn, config) { return fn; }
      function setup(opts) {
        use(doWork, opts);
      }
      function doWork() { return 1; }
    `;
    const { edges } = extractCodeGraph(src, { filePath: "z.ts" });
    const callsFromSetup = edges
      .filter((e) => e.label === "CALLS" && e.from === "z.ts#setup")
      .map((e) => e.to)
      .sort();
    // `use` resolves via the direct call_expression; `doWork` resolves via
    // the new argument-reference detection; `opts` never appears as a target.
    expect(callsFromSetup).toEqual(["z.ts#doWork", "z.ts#use"]);
  });
});

// One shared Kuzu connection for the whole describe. tree-sitter + Kuzu are
// both native addons sharing libuv; opening/closing a fresh Kuzu DB per test
// (beforeEach) while tree-sitter is loaded leaves a handle that keeps the
// forks worker from exiting. A single open/close avoids it. Tests stay
// independent by scoping queries to a per-test file path.
describe("CodeGraph indexer + AC-2 query", () => {
  let dir: string;
  let conn: GraphConnection;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "engram-cg-"));
    conn = GraphConnection.open(join(dir, "graph.db"));
    await initSchema(conn);
  });

  afterAll(() => {
    // NOTE: we deliberately do NOT await conn.close() here. Kuzu's native
    // db.close() can intermittently deadlock when tree-sitter is also loaded in
    // the same forks worker (both are native addons on the shared libuv loop),
    // which produced flaky non-zero exit codes even though all tests passed.
    // The temp DB is reclaimed when the worker exits + rmSync below; long-lived
    // production connections close at process shutdown where this is moot.
    rmSync(dir, { recursive: true, force: true });
  });

  // AC-2: index a TS file, then the canonical "which functions does execute
  // call?" Cypher query returns the correct callee list.
  it("AC-2: MATCH (f:Function)-[:CALLS]->(g) WHERE f.name = 'execute' returns callees", async () => {
    const result = await indexFile(conn, TS_SAMPLE, { filePath: "src/a.ts" });
    expect(result.functions).toBe(3);
    expect(result.calls).toBe(2);

    const rows = await conn.query(
      `MATCH (f:Function)-[:CALLS]->(g:Function) WHERE f.name = 'execute' AND f.file = 'src/a.ts' RETURN g.name AS name ORDER BY name`,
    );
    expect(rows.map((r) => r.name)).toEqual(["helper", "log"]);
  });

  it("is idempotent — re-indexing the same file does not duplicate nodes", async () => {
    await indexFile(conn, TS_SAMPLE, { filePath: "src/b.ts" });
    await indexFile(conn, TS_SAMPLE, { filePath: "src/b.ts" });

    const fnCount = await conn.query(
      `MATCH (f:Function) WHERE f.file = 'src/b.ts' RETURN count(f) AS c`,
    );
    expect(Number(fnCount[0]?.c)).toBe(3);

    const callCount = await conn.query(
      `MATCH (f:Function)-[r:CALLS]->(:Function) WHERE f.file = 'src/b.ts' RETURN count(r) AS c`,
    );
    expect(Number(callCount[0]?.c)).toBe(2);
  });

  // R1 (XSPEC-331) end-to-end: a `// implements XSPEC-NNN` comment persists as
  // a Module→Spec IMPLEMENTS edge, and both query directions the user asked for
  // work — spec→code (through DEFINES) and code→spec.
  it("R1: persists IMPLEMENTS(Module→Spec) and answers doc↔code both ways", async () => {
    const result = await indexProject(conn, [
      { path: "impl/run.ts", source: "// implements XSPEC-190\nexport function runJob() { return 1; }" },
    ]);
    expect(result.implements).toBe(1);

    // spec → code: which functions implement XSPEC-190? (via Module→Function)
    const specToCode = await conn.query(
      "MATCH (s:Spec {id: 'XSPEC-190'})<-[:IMPLEMENTS]-(m:Module)-[:DEFINES]->(f:Function) RETURN f.name AS name",
    );
    expect(specToCode.map((r) => r.name)).toContain("runJob");

    // code → spec: which spec governs runJob? (via its Module)
    const codeToSpec = await conn.query(
      "MATCH (f:Function {name: 'runJob'})<-[:DEFINES]-(m:Module)-[:IMPLEMENTS]->(s:Spec) WHERE f.file = 'impl/run.ts' RETURN s.id AS id",
    );
    expect(codeToSpec.map((r) => r.id)).toEqual(["XSPEC-190"]);
  });

  // R4 (XSPEC-331): the implementers / implemented-by queries the MCP tools and
  // CLI wrap — spec→code (with each file's functions) and code→spec.
  it("R4: implementers(spec) and implementedSpecs(module) query both directions", async () => {
    await indexProject(conn, [
      { path: "r4/svc.ts", source: "// implements XSPEC-42\nexport function handle() { return 1; }\nexport function help() { return 2; }" },
      { path: "r4/types.ts", source: "// implements XSPEC-42\nexport type T = string;" }, // function-less
    ]);

    // spec → code: both files, svc.ts carrying its functions, types.ts with none.
    const impl = await implementers(conn, "XSPEC-42");
    expect(impl.spec).toBe("XSPEC-42");
    const byModule = Object.fromEntries(impl.modules.map((m) => [m.module, m.functions]));
    expect(byModule["r4/svc.ts"]).toEqual(["handle", "help"]);
    expect(byModule["r4/types.ts"]).toEqual([]);

    // code → spec: the function-less file still resolves its spec.
    const specs = await implementedSpecs(conn, "r4/types.ts");
    expect(specs.specs.map((s) => s.id)).toEqual(["XSPEC-42"]);

    // an unimplemented spec / unknown module yield empty, not an error.
    expect((await implementers(conn, "XSPEC-999")).modules).toEqual([]);
    expect((await implementedSpecs(conn, "nope.ts")).specs).toEqual([]);
  });

  // P1: indexProject resolves a cross-file call, so "callers of X" works even
  // when the caller lives in another file (the call-chain the D4 PoC needs).
  it("P1: indexProject finds a cross-file caller", async () => {
    const result = await indexProject(conn, [
      { path: "proj/a.ts", source: "import { helperX } from './b';\nexport function executeX(n: number) { return helperX(n); }" },
      { path: "proj/b.ts", source: "export function helperX(n: number) { return n + 1; }" },
    ]);
    expect(result.calls).toBeGreaterThanOrEqual(1);

    const callerRows = await conn.query(
      "MATCH (c:Function)-[:CALLS]->(f:Function {name: 'helperX'}) RETURN c.name AS name",
    );
    expect(callerRows.map((r) => r.name)).toContain("executeX");
  });

  // P2: call-chain queries (callers/callees, transitive depth) + REST route.
  it("P2: callers/callees resolve transitively across files", async () => {
    await indexProject(conn, [
      { path: "cc/a.ts", source: "import {bFn} from './b';\nexport function aFn() { return bFn(); }" },
      { path: "cc/b.ts", source: "import {cFn} from './c';\nexport function bFn() { return cFn(); }" },
      { path: "cc/c.ts", source: "export function cFn() { return 1; }" },
    ]);

    const directCallers = await callers(conn, "cFn", 1);
    expect(directCallers.map((n) => n.name)).toEqual(["bFn"]);

    const transitiveCallers = await callers(conn, "cFn", 2);
    expect(transitiveCallers.map((n) => n.name).sort()).toEqual(["aFn", "bFn"]);

    const transitiveCallees = await callees(conn, "aFn", 2);
    expect(transitiveCallees.map((n) => n.name).sort()).toEqual(["bFn", "cFn"]);

    const chain = await callChain(conn, "cFn", "callers", 2);
    expect(chain.callees).toEqual([]);
    expect(chain.callers.length).toBe(2);
  });

  // Full-pipeline oracle for the argument-passed-reference fix: index a
  // Fastify-shaped plugin registration across two files, then confirm
  // `callers()` — the actual CLI/API surface, not just extractor internals —
  // finds the caller. This is the exact query shape that returned empty
  // before the fix (dev-platform DEC-081/DEC-095, `alertRulesRoutes`).
  it("callers() resolves a function passed by reference to app.register", async () => {
    await indexProject(conn, [
      {
        path: "plugin/alerts.ts",
        source: "export function alertRulesRoutes(app) { return app; }",
      },
      {
        path: "plugin/server.ts",
        source:
          "import { alertRulesRoutes } from './alerts.js';\n" +
          "export async function createApp(app) { await app.register(alertRulesRoutes, { prefix: '/api/alerts' }); }",
      },
    ]);

    const result = await callers(conn, "alertRulesRoutes", 1);
    expect(result.map((n) => n.name)).toContain("createApp");
  });

  it("P2: serves POST /graph/call-chain", async () => {
    await indexProject(conn, [
      { path: "rc/a.ts", source: "import {rcB} from './b';\nexport function rcA() { return rcB(); }" },
      { path: "rc/b.ts", source: "export function rcB() { return 1; }" },
    ]);
    const app = createServer({ connection: conn });
    const res = await app.fetch(
      new Request("http://localhost/graph/call-chain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol: "rcB", direction: "callers", depth: 1 }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { callers: Array<{ name: string }> };
    expect(body.callers.map((c) => c.name)).toContain("rcA");
  });
});

describe("CodeGraph cross-file resolution (P1)", () => {
  it("resolves a call to a function defined in another file", () => {
    const { fragment, calls } = extractProject([
      { path: "a.ts", source: "export function execute(x: number) { return helper(x); }" },
      { path: "b.ts", source: "export function helper(n: number) { return n + 1; }" },
    ]);
    expect(calls).toBe(1);
    const callEdge = fragment.edges.find((e) => e.label === "CALLS");
    expect(callEdge?.from).toBe("a.ts#execute");
    expect(callEdge?.to).toBe("b.ts#helper"); // resolved across files
  });

  it("prefers a same-file definition (lexical shadowing) over a cross-file one", () => {
    const { fragment } = extractProject([
      { path: "c.ts", source: "export function helper() { return 1; }\nexport function run() { return helper(); }" },
      { path: "d.ts", source: "export function helper() { return 2; }" },
    ]);
    const runCall = fragment.edges.find((e) => e.label === "CALLS" && e.from === "c.ts#run");
    expect(runCall?.to).toBe("c.ts#helper"); // local wins, not d.ts#helper
  });

  it("skips an ambiguous call (name defined in >1 file, no local) and counts it", () => {
    const result = extractProject([
      { path: "e.ts", source: "export function helper() { return 1; }" },
      { path: "f.ts", source: "export function helper() { return 2; }" },
      { path: "g.ts", source: "export function caller() { return helper(); }" },
    ]);
    expect(result.ambiguous).toBeGreaterThanOrEqual(1);
    const callerEdge = result.fragment.edges.find(
      (e) => e.label === "CALLS" && e.from === "g.ts#caller",
    );
    expect(callerEdge).toBeUndefined(); // ambiguous → not resolved
  });

  it("counts an unresolved call (callee name unknown across the repo)", () => {
    const result = extractProject([
      { path: "h.ts", source: "export function caller() { return missingFn(); }" },
    ]);
    expect(result.unresolved).toBeGreaterThanOrEqual(1);
  });

  // Same shape as the real vibeops regression: the plugin function is
  // defined in one file and passed by reference (not called) from another.
  it("resolves a cross-file function passed by reference as a call argument", () => {
    const { fragment, calls } = extractProject([
      { path: "routes/oidc.ts", source: "export async function oidcRoutes(app, opts) { return app; }" },
      {
        path: "server.ts",
        source:
          "import { oidcRoutes } from './routes/oidc.js';\n" +
          "export async function createApp(app) { await app.register(oidcRoutes, { prefix: '/api/auth/oidc' }); }",
      },
    ]);
    expect(calls).toBeGreaterThanOrEqual(1);
    const callEdge = fragment.edges.find(
      (e) => e.label === "CALLS" && e.from === "server.ts#createApp",
    );
    expect(callEdge?.to).toBe("routes/oidc.ts#oidcRoutes");
  });
});
