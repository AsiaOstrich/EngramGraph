// implements XSPEC-508
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { indexProject } from "../src/code-graph/indexer.js";
import { MCP_INDEX_ROOT, upsertRun, writeManifest, type ParseManifest } from "../src/code-graph/parse-manifest.js";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * XSPEC-508 R6, decision 134乙 — two index roots of ONE graph that hold the same relative path
 * (dev-platform: `src/index.ts` of EngramGraph and of both telemetry packages) used to be one
 * Module node with the functions of every root under it, and that one collision made
 * `--incremental` fall back to a full index on every run.
 *
 * Everything is driven through the built CLI as a child process and read back from the graph. The
 * oracle for "incremental = full" is a second graph built from the same final sources by plain
 * indexes in the same order.
 */

let built: BuiltEgr;
let scratch: string;

beforeAll(() => {
  built = buildEgr();
  scratch = mkdtempSync(join(tmpdir(), "egr-r6-roots-"));
});

afterAll(() => {
  built?.cleanup();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const ALPHA_INDEX = [
  "export function main() { return helper(); }",
  "export function helper() { return 1; }",
  "export function onlyAlpha() { return helper(); }",
  "",
].join("\n");
const BETA_INDEX = [
  "export function main() { return helper(); }",
  "export function helper() { return 2; }",
  "export function onlyBeta() { return helper(); }",
  "export function callsAlpha() { return onlyAlpha(); }", // defined in ANOTHER root: no edge may appear
  "",
].join("\n");
const BETA_INDEX_EDITED = [
  "export function main() { return helper2(); }",
  "export function helper() { return 2; }",
  "export function helper2() { return 22; }",
  "export function onlyBeta() { return helper(); }",
  "export function callsAlpha() { return onlyAlpha(); }",
  "",
].join("\n");

interface World {
  dir: string;
  alpha: string;
  beta: string;
  db: string;
}

/** Two roots, `alpha/src` and `beta/src`, each with its own `index.ts`, and one file each that only that root has. */
function makeWorld(label: string): World {
  const dir = mkdtempSync(join(scratch, `${label}-`));
  const alpha = join(dir, "alpha", "src");
  const beta = join(dir, "beta", "src");
  mkdirSync(alpha, { recursive: true });
  mkdirSync(beta, { recursive: true });
  writeFileSync(join(alpha, "index.ts"), ALPHA_INDEX);
  writeFileSync(join(alpha, "a-only.ts"), "export function aOnly() { return 1; }\n");
  writeFileSync(join(beta, "index.ts"), BETA_INDEX);
  writeFileSync(join(beta, "b-only.ts"), "export function bOnly() { return 1; }\n");
  return { dir, alpha, beta, db: join(dir, "graph.db") };
}

function egr(args: string[], db: string, cwd: string) {
  return runEgr(built.cli, args, { env: { ...process.env, ENGRAM_DB: db }, cwd });
}

interface IndexJson {
  code: { files: number };
  incremental?: { mode: "incremental" | "full"; reason?: string; reparsed: number; reused: number; removed: number };
  rootQualifiedIds?: { label: string; files: number; examples: Array<{ path: string; id: string }> };
  sharedNodes?: { count: number; examples: Array<{ id: string; otherRoot: string }> };
}

function indexJson(args: string[], db: string, cwd: string): IndexJson {
  const r = egr(["index", ...args, "--json"], db, cwd);
  if (r.status !== 0) throw new Error(`egr index ${args.join(" ")} exited ${r.status}\n${r.stdout}${r.stderr}`);
  return JSON.parse(r.stdout) as IndexJson;
}

async function dumpGraph(db: string): Promise<{ nodes: string[]; edges: string[] }> {
  const conn = GraphConnection.open(db, { readOnly: true });
  try {
    const nodes: string[] = [];
    const edges: string[] = [];
    for (const r of await conn.query("MATCH (n:Function) RETURN n.id AS id, n.name AS name, n.file AS file, n.start_line AS line"))
      nodes.push(`Function|${r.id}|${r.name}|${r.file}|${r.line}`);
    for (const r of await conn.query("MATCH (n:Module) RETURN n.id AS id, n.path AS path")) nodes.push(`Module|${r.id}|${r.path}`);
    for (const r of await conn.query("MATCH (a:Function)-[r:CALLS]->(b:Function) RETURN a.id AS a, b.id AS b, r.call_count AS n"))
      edges.push(`CALLS|${r.a}|${r.b}|${r.n}`);
    for (const r of await conn.query("MATCH (a:Module)-[:DEFINES]->(b:Function) RETURN a.id AS a, b.id AS b")) edges.push(`DEFINES|${r.a}|${r.b}`);
    return { nodes: nodes.sort(), edges: edges.sort() };
  } finally {
    await conn.close();
  }
}

const moduleIds = (g: { nodes: string[] }): string[] => g.nodes.filter((n) => n.startsWith("Module|")).map((n) => n.split("|")[1]!);
const defines = (g: { edges: string[] }, module: string): string[] =>
  g.edges.filter((e) => e.startsWith(`DEFINES|${module}|`)).map((e) => e.split("|")[2]!).sort();
const calls = (g: { edges: string[] }): string[] => g.edges.filter((e) => e.startsWith("CALLS|")).map((e) => e.split("|").slice(1, 3).join(" -> "));

describe("two roots of one graph that hold the same relative path (XSPEC-508 R6)", () => {
  it("keeps both index.ts as separate Module nodes after a full index, each with only its own functions and calls", async () => {
    const w = makeWorld("separate");
    const first = indexJson([w.alpha], w.db, w.dir);
    const second = indexJson([w.beta], w.db, w.dir);

    // The first root keeps the plain path it always had; the second says what it did.
    expect(first.rootQualifiedIds).toBeUndefined();
    expect(second.rootQualifiedIds).toMatchObject({ label: "beta/src", files: 1, examples: [{ path: "index.ts", id: "beta/src/index.ts" }] });

    const g = await dumpGraph(w.db);
    expect(moduleIds(g)).toEqual(["a-only.ts", "b-only.ts", "beta/src/index.ts", "index.ts"]);
    // Neither file overwrote the other: each Module defines exactly its own functions, same names and all.
    expect(defines(g, "index.ts")).toEqual(["index.ts#helper", "index.ts#main", "index.ts#onlyAlpha"]);
    expect(defines(g, "beta/src/index.ts")).toEqual([
      "beta/src/index.ts#callsAlpha",
      "beta/src/index.ts#helper",
      "beta/src/index.ts#main",
      "beta/src/index.ts#onlyBeta",
    ]);
    // Calls stay inside their own root: main -> helper in each, and beta's call to a function only alpha
    // defines is NOT an edge (CALLS are resolved within one index root, as before this change).
    expect(calls(g).sort()).toEqual([
      "beta/src/index.ts#main -> beta/src/index.ts#helper",
      "beta/src/index.ts#onlyBeta -> beta/src/index.ts#helper",
      "index.ts#main -> index.ts#helper",
      "index.ts#onlyAlpha -> index.ts#helper",
    ]);

    // What the user sees: the same query reaches both roots' functions, and the qualified one shows its root.
    const r = egr(["callers", "helper", "--json"], w.db, w.dir);
    const rows = JSON.parse(r.stdout) as Array<{ id: string; file: string }>;
    expect(rows.map((x) => x.file).sort()).toEqual(["beta/src/index.ts", "beta/src/index.ts", "index.ts", "index.ts"]);
  });

  it("an incremental index of one root after editing its index.ts does not fall back to full, and ends with the graph full indexes give", async () => {
    const w = makeWorld("incremental");
    indexJson([w.alpha, "--incremental"], w.db, w.dir);
    const startB = indexJson([w.beta, "--incremental"], w.db, w.dir);
    expect(startB.incremental?.mode).toBe("full"); // the first run of a root has no state yet: that is the only reason
    expect(startB.incremental?.reason).not.toMatch(/relative path|also indexed from another root/);

    writeFileSync(join(w.beta, "index.ts"), BETA_INDEX_EDITED);
    const inc = indexJson([w.beta, "--incremental"], w.db, w.dir);
    expect(inc.incremental).toMatchObject({ mode: "incremental", reparsed: 1, reused: 1, removed: 0 });
    expect(inc.incremental?.reason).toBeUndefined();

    // The reference: the same final sources, indexed in the same order by plain indexes into a new graph.
    const oracleDb = join(w.dir, "oracle.db");
    indexJson([w.alpha], oracleDb, w.dir);
    indexJson([w.beta], oracleDb, w.dir);
    const got = await dumpGraph(w.db);
    const want = await dumpGraph(oracleDb);
    expect(got.nodes).toEqual(want.nodes);
    expect(got.edges).toEqual(want.edges);
    // and the edit really landed in the right root only
    expect(defines(got, "beta/src/index.ts")).toContain("beta/src/index.ts#helper2");
    expect(defines(got, "index.ts")).not.toContain("index.ts#helper2");
    expect(calls(got)).toContain("beta/src/index.ts#main -> beta/src/index.ts#helper2");
    expect(calls(got)).toContain("index.ts#main -> index.ts#helper"); // alpha's edge is as it was

    // The other root, edited the same way, is also incremental (its state was never reset by beta's runs).
    writeFileSync(join(w.alpha, "index.ts"), ALPHA_INDEX + "export function alphaNew() { return helper(); }\n");
    const incA = indexJson([w.alpha, "--incremental"], w.db, w.dir);
    expect(incA.incremental).toMatchObject({ mode: "incremental", reparsed: 1, reused: 1 });
    expect(defines(await dumpGraph(w.db), "index.ts")).toContain("index.ts#alphaNew");
  });

  it("removing the colliding file from one root leaves the other root's file, functions and edges in the graph", async () => {
    const w = makeWorld("remove");
    indexJson([w.alpha, "--incremental"], w.db, w.dir);
    indexJson([w.beta, "--incremental"], w.db, w.dir);

    rmSync(join(w.beta, "index.ts"));
    const inc = indexJson([w.beta, "--incremental"], w.db, w.dir);
    expect(inc.incremental).toMatchObject({ mode: "incremental", reparsed: 0, removed: 1 });

    const g = await dumpGraph(w.db);
    expect(moduleIds(g)).toEqual(["a-only.ts", "b-only.ts", "index.ts"]); // beta's gone, alpha's index.ts is still there
    expect(defines(g, "index.ts")).toEqual(["index.ts#helper", "index.ts#main", "index.ts#onlyAlpha"]);
    expect(calls(g)).toContain("index.ts#main -> index.ts#helper");
  });

  it("an id is kept for as long as its file is in the index: the plain path freed by the other root is not taken over", async () => {
    const w = makeWorld("stable");
    indexJson([w.alpha], w.db, w.dir);
    indexJson([w.beta], w.db, w.dir); // beta/src/index.ts is qualified because alpha held index.ts

    rmSync(join(w.alpha, "index.ts")); // alpha stops holding index.ts ...
    indexJson([w.alpha], w.db, w.dir);
    indexJson([w.beta], w.db, w.dir); // ... and beta indexes again

    const g = await dumpGraph(w.db);
    // beta's file is still the qualified one; it did not turn into `index.ts` and leave a second copy behind.
    expect(moduleIds(g).filter((m) => m.endsWith("index.ts") && m.includes("beta"))).toEqual(["beta/src/index.ts"]);
    expect(defines(g, "beta/src/index.ts")).toContain("beta/src/index.ts#main");
    // and beta's functions did not appear under the plain id that alpha freed
    expect(g.nodes.some((n) => n.startsWith("Function|index.ts#onlyBeta|") || n.startsWith("Function|index.ts#callsAlpha|"))).toBe(false);
    expect(defines(g, "index.ts").some((f) => f.includes("callsAlpha") || f.includes("onlyBeta"))).toBe(false);
  });

  it("the same directory reached through a symlink is one root, not a second one: its files keep their ids and nothing is duplicated", async () => {
    const w = makeWorld("symlink");
    const link = join(w.dir, "alpha-link"); // how index-all.sh reaches dev-platform's sub-projects
    symlinkSync(w.alpha, link);
    indexJson([w.alpha], w.db, w.dir);
    const before = await dumpGraph(w.db);

    const again = indexJson([link], w.db, w.dir);
    expect(again.rootQualifiedIds).toBeUndefined();
    expect(again.sharedNodes).toBeUndefined();
    expect(moduleIds(await dumpGraph(w.db))).toEqual(moduleIds(before));
    expect((await dumpGraph(w.db)).nodes).toEqual(before.nodes);
  });

  it("a file the MCP index_code tool recorded is not another root: re-indexing it with egr keeps its plain id and raises no warning", async () => {
    const w = makeWorld("mcp");
    // What the MCP server's index_code leaves in the manifest: a section under a sentinel key, plain paths.
    const conn = GraphConnection.open(w.db);
    await initSchema(conn);
    const r = await indexProject(conn, [{ path: "index.ts", source: ALPHA_INDEX }]);
    await conn.close();
    writeManifest(join(w.dir, "graph.parse-manifest.json"), upsertRun(null, MCP_INDEX_ROOT, new Date().toISOString(), r.parseHealth, "0.0.0"));

    const j = indexJson([w.alpha], w.db, w.dir);
    expect(j.rootQualifiedIds).toBeUndefined();
    expect(j.sharedNodes).toBeUndefined();
    expect(moduleIds(await dumpGraph(w.db))).toEqual(["a-only.ts", "index.ts"]);
  });

  it("a partly parsed qualified file is named by its graph id in blindspots and still marks results near it as possibly incomplete", async () => {
    const w = makeWorld("health");
    indexJson([w.alpha], w.db, w.dir);
    writeFileSync(join(w.beta, "index.ts"), "export function onlyBeta() { return 1; }\nexport function ( {{{ ;\n");
    indexJson([w.beta], w.db, w.dir);

    const bs = JSON.parse(egr(["blindspots", "--json"], w.db, w.dir).stdout) as { blindspots: Array<{ path: string }> };
    expect(bs.blindspots.map((b) => b.path)).toEqual(["beta/src/index.ts"]);
    // a query whose answer sits in that file: the plain relative path `index.ts` is alpha's healthy file
    const q = egr(["callers", "onlyBeta"], w.db, w.dir);
    expect(q.stdout).toMatch(/possibly incomplete: 1 file\(s\) near this result/);
  });

  it("a graph with one root, or roots that share no path, keeps every id exactly as it was and writes nothing new into the manifest", async () => {
    const w = makeWorld("single");
    rmSync(join(w.beta, "index.ts")); // beta now shares no relative path with alpha
    const a = indexJson([w.alpha], w.db, w.dir);
    const b = indexJson([w.beta], w.db, w.dir);
    expect(a.rootQualifiedIds).toBeUndefined();
    expect(b.rootQualifiedIds).toBeUndefined();

    const g = await dumpGraph(w.db);
    expect(moduleIds(g)).toEqual(["a-only.ts", "b-only.ts", "index.ts"]);
    expect(g.nodes).toContain("Function|index.ts#main|main|index.ts|1");

    const manifest = JSON.parse(readFileSync(join(w.dir, "graph.parse-manifest.json"), "utf8")) as ParseManifest;
    for (const section of Object.values(manifest.runs)) {
      expect(section.rootLabel).toBeUndefined();
      for (const f of section.files) expect(f.id).toBeUndefined();
    }
  });
});

describe("a graph an older egr built from roots that share a relative path (XSPEC-508 R6)", () => {
  /**
   * What an egr without root-qualified ids left behind: both roots' `index.ts` written onto the SAME
   * Module id, and a manifest whose two sections both list `index.ts` with no `id`. Built with the
   * library, because no current command can produce it any more.
   */
  async function legacyWorld(label: string): Promise<World> {
    const w = makeWorld(label);
    const conn = GraphConnection.open(w.db);
    await initSchema(conn);
    let manifest: ParseManifest | null = null;
    for (const [root, files] of [
      [w.alpha, [{ path: "index.ts", source: ALPHA_INDEX }, { path: "a-only.ts", source: "export function aOnly() { return 1; }\n" }]],
      [w.beta, [{ path: "index.ts", source: BETA_INDEX }, { path: "b-only.ts", source: "export function bOnly() { return 1; }\n" }]],
    ] as const) {
      const r = await indexProject(conn, [...files]);
      manifest = upsertRun(manifest, root, new Date().toISOString(), r.parseHealth, "0.0.0-legacy");
    }
    await conn.close();
    writeManifest(join(w.dir, "graph.parse-manifest.json"), manifest!);
    return w;
  }

  it("is detected and reported by a plain index, which then writes no mixed old/new ids", async () => {
    const w = await legacyWorld("legacy-plain");
    const before = await dumpGraph(w.db);
    expect(moduleIds(before)).toEqual(["a-only.ts", "b-only.ts", "index.ts"]); // one mixed node for both roots

    const r = egr(["index", w.beta], w.db, w.dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/WARNING: 1 node\(s\) of this root \(e\.g\. index\.ts\) are also held by another root/);
    expect(r.stdout).toMatch(/--clean/);
    const json = indexJson([w.beta], w.db, w.dir);
    expect(json.sharedNodes).toMatchObject({ count: 1, examples: [{ id: "index.ts", otherRoot: w.alpha }] });
    expect(json.rootQualifiedIds).toBeUndefined();

    // No second set of ids appeared next to the old ones.
    expect(moduleIds(await dumpGraph(w.db))).toEqual(["a-only.ts", "b-only.ts", "index.ts"]);
  });

  it("makes --incremental index in full and say to rebuild, instead of diffing against nodes two roots share", async () => {
    const w = await legacyWorld("legacy-inc");
    const r = indexJson([w.beta, "--incremental"], w.db, w.dir);
    expect(r.incremental?.mode).toBe("full");
    expect(r.incremental?.reason).toMatch(/also held by another root/);
    expect(r.incremental?.reason).toMatch(/--clean/);
    expect(r.sharedNodes?.count).toBe(1);

    // Still shared on the next run: the full index could not separate them, and it does not pretend to.
    const again = indexJson([w.beta, "--incremental"], w.db, w.dir);
    expect(again.incremental?.mode).toBe("full");
  });

  it("is healed by one rebuild: after --clean the roots have separate ids and the warning is gone", async () => {
    const w = await legacyWorld("legacy-clean");
    indexJson([w.alpha, "--clean"], w.db, w.dir);
    const b = indexJson([w.beta], w.db, w.dir);
    expect(b.sharedNodes).toBeUndefined();
    expect(b.rootQualifiedIds?.files).toBe(1);
    expect(moduleIds(await dumpGraph(w.db))).toEqual(["a-only.ts", "b-only.ts", "beta/src/index.ts", "index.ts"]);
  });

  it("leaves a legacy graph with a single root alone: same ids, no warning, no rebuild asked for", async () => {
    const w = await legacyWorld("legacy-single");
    // keep only alpha's section: this is the graph of a user who never had two roots
    const mp = join(w.dir, "graph.parse-manifest.json");
    const m = JSON.parse(readFileSync(mp, "utf8")) as ParseManifest;
    delete m.runs[w.beta];
    writeFileSync(mp, JSON.stringify(m));
    const r = indexJson([w.alpha, "--incremental"], w.db, w.dir);
    expect(r.sharedNodes).toBeUndefined();
    expect(r.rootQualifiedIds).toBeUndefined();
    expect(moduleIds(await dumpGraph(w.db))).toEqual(["a-only.ts", "b-only.ts", "index.ts"]);
    const second = indexJson([w.alpha, "--incremental"], w.db, w.dir);
    expect(second.incremental).toMatchObject({ mode: "incremental", reparsed: 0 });
  });
});

describe("--scip on a root whose files carry root-qualified ids (XSPEC-508 R6)", () => {
  it("is refused before anything is written, because the overlay would build the other root's ids", async () => {
    const w = makeWorld("scip");
    indexJson([w.alpha], w.db, w.dir);
    const before = await dumpGraph(w.db);
    const r = egr(["index", w.beta, "--scip", join(w.dir, "does-not-matter.scip")], w.db, w.dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--scip cannot be combined with this root: 1 of its files share a relative path with another root/);
    expect(await dumpGraph(w.db)).toEqual(before); // nothing of beta reached the graph
  });
});
