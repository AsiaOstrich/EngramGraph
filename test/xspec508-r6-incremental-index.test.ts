// implements XSPEC-508
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * XSPEC-508 R6 — `egr index --incremental` parses only the files that changed
 * and ends with the graph a full rebuild gives.
 *
 * Everything here goes through the built CLI as a child process, the way a user
 * runs it, and reads the graph back from the database afterwards. The oracle is
 * `egr index --clean` over a copy of the same final sources: a plain `egr index`
 * never prunes, so it is not a rebuild and cannot be the reference.
 *
 * The fixture is built so that each way an incremental index can be wrong shows:
 *
 *   a.ts  changed   adds helper2, drops oldFn, calls helper2 instead of helper,
 *                   and adds `dup` (now defined in c.ts too) and `futureFn`
 *   b.ts  UNCHANGED calls dup, futureFn, oldFn:  its edge to c.ts#dup must go
 *                   (the name turned ambiguous), its edge to a.ts#futureFn must
 *                   appear (the name was undefined), its edge to oldFn must go
 *   m.ts  changed   drops `gone` and its `// implements XSPEC-901`
 *   u.ts  UNCHANGED calls gone (removed) and dfn (file deleted)
 *   n.ts  changed   calls other() instead of keep()
 *   d.ts  DELETED   `// implements XSPEC-903`
 *   e.ts  NEW       defines eFn, `// implements XSPEC-902`
 *   x.ts  UNCHANGED calls eFn, which did not exist when x.ts was indexed
 *   c.ts, z.ts  UNCHANGED and unrelated
 */

let built: BuiltEgr;
let scratch: string;

beforeAll(() => {
  built = buildEgr();
  scratch = mkdtempSync(join(tmpdir(), "egr-r6-"));
});

afterAll(() => {
  built?.cleanup();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const BEFORE: Record<string, string> = {
  "a.ts": [
    "// implements XSPEC-900",
    "export function foo() { return helper(); }",
    "export function helper() { return 1; }",
    "export function oldFn() { return helper(); }",
    "export class Widget { render() { return helper(); } }",
    "",
  ].join("\n"),
  "b.ts": [
    "export function useDup() { return dup(); }",
    "export function useFuture() { return futureFn(); }",
    "export function useOld() { return oldFn(); }",
    "",
  ].join("\n"),
  "c.ts": "export function dup() { return 1; }\n",
  "m.ts": [
    "// implements XSPEC-901",
    "export function keep() { return 1; }",
    "export function gone() { return keep(); }",
    "",
  ].join("\n"),
  "u.ts": "export function useGone() { return gone() + dfn(); }\n",
  "n.ts": "export function nfn() { return keep(); }\nexport function other() { return 2; }\n",
  "d.ts": "// implements XSPEC-903\nexport function dfn() { return helper(); }\n",
  "x.ts": "export function useE() { return eFn(); }\n",
  "z.ts": "export function zed() { return zed2(); }\nexport function zed2() { return 1; }\n",
};

const AFTER_CHANGED: Record<string, string> = {
  "a.ts": [
    "// implements XSPEC-900",
    "export function foo() { return helper2(); }",
    "export function helper() { return 1; }",
    "export function helper2() { return 3; }",
    "export function dup() { return 9; }",
    "export function futureFn() { return 4; }",
    "export class Widget { render() { return helper(); } }",
    "",
  ].join("\n"),
  "m.ts": ["export function keep() { return 1; }", "export function fresh() { return keep(); }", ""].join("\n"),
  "n.ts": "export function nfn() { return other(); }\nexport function other() { return 2; }\n",
};
const AFTER_NEW: Record<string, string> = {
  "e.ts": "// implements XSPEC-902\nexport function eFn() { return helper(); }\n",
};
const AFTER_DELETED = ["d.ts"];
const UNCHANGED = ["b.ts", "c.ts", "u.ts", "x.ts", "z.ts"];

function writeTree(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

function egr(args: string[], db: string, cwd: string) {
  return runEgr(built.cli, args, { env: { ...process.env, ENGRAM_DB: db }, cwd });
}

interface IncrementalJson {
  code: { files: number };
  incremental: {
    mode: "incremental" | "full";
    reason?: string;
    reparsed: number;
    reused: number;
    changed: number;
    added: number;
    removed: number;
    nodesRemoved: number;
    edgesRemoved: number;
    edgesWritten: number;
  };
}

function indexJson(args: string[], db: string, cwd: string): IncrementalJson {
  const r = egr(["index", ...args, "--json"], db, cwd);
  if (r.status !== 0) throw new Error(`egr index ${args.join(" ")} exited ${r.status}\n${r.stderr}`);
  return JSON.parse(r.stdout) as IncrementalJson;
}

/** Every node and edge in a graph, in a form two graphs can be compared as plain data. */
async function dumpGraph(db: string): Promise<{ nodes: string[]; edges: string[] }> {
  const conn = GraphConnection.open(db, { readOnly: true });
  try {
    const nodes: string[] = [];
    const edges: string[] = [];
    const q = async (cypher: string) => conn.query(cypher);
    for (const r of await q("MATCH (n:Function) RETURN n.id AS id, n.name AS name, n.file AS file, n.start_line AS line, n.confidence AS c, n.provider AS p"))
      nodes.push(`Function|${r.id}|${r.name}|${r.file}|${r.line}|${r.c}|${r.p}`);
    for (const r of await q("MATCH (n:Class) RETURN n.id AS id, n.name AS name, n.file AS file, n.provider AS p"))
      nodes.push(`Class|${r.id}|${r.name}|${r.file}|${r.p}`);
    for (const r of await q("MATCH (n:Module) RETURN n.id AS id, n.path AS path")) nodes.push(`Module|${r.id}|${r.path}`);
    for (const r of await q("MATCH (n:Spec) RETURN n.id AS id, n.origin AS origin")) nodes.push(`Spec|${r.id}|${r.origin}`);
    for (const r of await q("MATCH (a:Function)-[r:CALLS]->(b:Function) RETURN a.id AS a, b.id AS b, r.call_count AS n, r.confidence AS c, r.provider AS p"))
      edges.push(`CALLS|${r.a}|${r.b}|${r.n}|${r.c}|${r.p}`);
    for (const r of await q("MATCH (a:Module)-[:DEFINES]->(b:Function) RETURN a.id AS a, b.id AS b")) edges.push(`DEFINES|${r.a}|${r.b}`);
    for (const r of await q("MATCH (a:Module)-[:IMPLEMENTS]->(b:Spec) RETURN a.id AS a, b.id AS b")) edges.push(`IMPLEMENTS|${r.a}|${r.b}`);
    for (const r of await q("MATCH (a:Module)-[:IMPORTS]->(b:Module) RETURN a.id AS a, b.id AS b")) edges.push(`IMPORTS|${r.a}|${r.b}`);
    return { nodes: nodes.sort(), edges: edges.sort() };
  } finally {
    await conn.close();
  }
}

function callersOf(symbol: string, db: string, cwd: string): string[] {
  const r = egr(["callers", symbol, "--json"], db, cwd);
  if (r.status !== 0) throw new Error(`egr callers ${symbol} exited ${r.status}\n${r.stdout}${r.stderr}`);
  const rows = JSON.parse(r.stdout) as Array<{ id: string }>;
  return rows.map((x) => x.id).sort();
}

interface Scenario {
  dir: string;
  proj: string;
  db: string;
  /** The `--json` result of the incremental run after the edits. */
  second: IncrementalJson;
  /** The graph of a `--clean` rebuild over the final sources. */
  oracleDb: string;
}

/**
 * Index the BEFORE tree with `--incremental`, apply the edits, index again with
 * `--incremental`, and index a copy of the result with `--clean` as the reference.
 * Each caller builds its own — a test never leans on another test's run.
 */
function runScenario(label: string): Scenario {
  const dir = mkdtempSync(join(scratch, `${label}-`));
  const proj = join(dir, "proj");
  const db = join(dir, "inc", "graph.db");
  const oracleDb = join(dir, "oracle", "graph.db");
  mkdirSync(join(dir, "inc"));
  mkdirSync(join(dir, "oracle"));
  writeTree(proj, BEFORE);

  const first = indexJson([proj, "--incremental"], db, dir);
  expect(first.incremental.mode).toBe("full");

  writeTree(proj, AFTER_CHANGED);
  writeTree(proj, AFTER_NEW);
  for (const f of AFTER_DELETED) rmSync(join(proj, f));
  const second = indexJson([proj, "--incremental"], db, dir);

  const copy = join(dir, "proj-copy");
  cpSync(proj, copy, { recursive: true });
  indexJson([copy, "--clean"], oracleDb, dir);
  return { dir, proj, db, second, oracleDb };
}

describe("egr index --incremental (XSPEC-508 R6)", () => {
  it("an incremental index after edits ends with exactly the graph a --clean rebuild gives", async () => {
    const s = runScenario("consistency");
    expect(s.second.incremental.mode).toBe("incremental");

    const inc = await dumpGraph(s.db);
    const full = await dumpGraph(s.oracleDb);
    expect(inc.nodes).toEqual(full.nodes);
    expect(inc.edges).toEqual(full.edges);

    // The facts the edits were built around, read back from the incremental graph itself.
    expect(inc.nodes.some((n) => n.startsWith("Module|d.ts|"))).toBe(false); // deleted file is gone
    expect(inc.nodes.some((n) => n.startsWith("Function|a.ts#oldFn|"))).toBe(false); // deleted function is gone
    expect(inc.nodes.some((n) => n.startsWith("Function|m.ts#gone|"))).toBe(false);
    expect(inc.nodes.some((n) => n.startsWith("Function|a.ts#helper2|"))).toBe(true); // added function is there
    expect(inc.nodes.some((n) => n.startsWith("Spec|XSPEC-903|"))).toBe(false); // stub of a deleted file's annotation
    expect(inc.nodes.some((n) => n.startsWith("Spec|XSPEC-901|"))).toBe(false); // stub of a removed annotation
    expect(inc.nodes.some((n) => n.startsWith("Spec|XSPEC-902|"))).toBe(true);

    // The same answers through the query commands, from both graphs.
    for (const sym of ["helper", "helper2", "dup", "futureFn", "eFn", "keep", "other", "zed2", "fresh"]) {
      expect(callersOf(sym, s.db, s.dir), `callers of ${sym}`).toEqual(callersOf(sym, s.oracleDb, s.dir));
    }
    const impl = (db: string) => egr(["implementers", "XSPEC-902", "--json"], db, s.dir).stdout;
    expect(impl(s.db)).toEqual(impl(s.oracleDb));
  });

  it("re-parses only the files that changed, and says so: 4 parsed (3 changed, 1 new), 5 reused, 1 removed", () => {
    const s = runScenario("counts");
    const inc = s.second.incremental;
    expect(inc.mode).toBe("incremental");
    expect(inc.reparsed).toBe(4);
    expect(inc.changed).toBe(3);
    expect(inc.added).toBe(1);
    expect(inc.reused).toBe(UNCHANGED.length);
    expect(inc.removed).toBe(1);
    // code.files stays the size of the whole indexed tree, not of the delta
    expect(s.second.code.files).toBe(UNCHANGED.length + Object.keys(AFTER_CHANGED).length + Object.keys(AFTER_NEW).length);

    // A third run with nothing edited parses nothing and writes nothing.
    const third = indexJson([s.proj, "--incremental"], s.db, s.dir);
    expect(third.incremental).toMatchObject({ mode: "incremental", reparsed: 0, reused: third.code.files, removed: 0, nodesRemoved: 0, edgesRemoved: 0, edgesWritten: 0 });
  });

  it("an UNCHANGED file's calls follow a name that became ambiguous, one that was newly defined, and one that was deleted", async () => {
    const s = runScenario("cross-file");
    const inc = await dumpGraph(s.db);
    const calls = inc.edges.filter((e) => e.startsWith("CALLS|")).map((e) => e.split("|").slice(1, 3).join(" -> "));
    // b.ts was not touched; its edges changed because OTHER files changed.
    expect(calls).not.toContain("b.ts#useDup -> c.ts#dup"); // dup is now defined in a.ts and c.ts: ambiguous, dropped
    expect(calls).toContain("b.ts#useFuture -> a.ts#futureFn"); // futureFn did not exist; a.ts now defines it
    expect(calls).not.toContain("b.ts#useOld -> a.ts#oldFn"); // oldFn was deleted from a.ts
    expect(calls).toContain("x.ts#useE -> e.ts#eFn"); // eFn is in a file that did not exist
    expect(calls).not.toContain("u.ts#useGone -> m.ts#gone"); // gone was deleted from m.ts
    expect(calls).not.toContain("u.ts#useGone -> d.ts#dfn"); // d.ts was deleted
    // and the untouched, unrelated file's edge is still there
    expect(calls).toContain("z.ts#zed -> z.ts#zed2");
    // the 2 unchanged files whose edges moved were not parsed again to get there
    expect(s.second.incremental.reparsed).toBe(4);
  });

  it("keeps the SAGE confidence of a function that still exists, in an unchanged file and in a changed one", async () => {
    const dir = mkdtempSync(join(scratch, "sage-"));
    const proj = join(dir, "proj");
    const db = join(dir, "g", "graph.db");
    mkdirSync(join(dir, "g"));
    writeTree(proj, BEFORE);
    indexJson([proj, "--incremental"], db, dir);
    for (const id of ["z.ts#zed", "a.ts#helper"]) {
      expect(egr(["feedback", "test_fail", id, "--label", "Function"], db, dir).status).toBe(0);
    }
    const read = async (id: string) => {
      const conn = GraphConnection.open(db, { readOnly: true });
      try {
        const rows = await conn.query("MATCH (n:Function {id: $id}) RETURN n.confidence AS c", { id });
        return Number(rows[0]?.c);
      } finally {
        await conn.close();
      }
    };
    const zBefore = await read("z.ts#zed");
    const hBefore = await read("a.ts#helper");
    expect(zBefore).toBeLessThan(1);
    expect(hBefore).toBeLessThan(1);

    writeTree(proj, AFTER_CHANGED); // a.ts changes; a.ts#helper still exists in it
    const r = indexJson([proj, "--incremental"], db, dir);
    expect(r.incremental.mode).toBe("incremental");
    expect(await read("z.ts#zed")).toBe(zBefore);
    expect(await read("a.ts#helper")).toBe(hBefore);
  });

  it("sees a changed file by its content, not its mtime: an edit that keeps the old mtime is still re-parsed", async () => {
    const dir = mkdtempSync(join(scratch, "mtime-"));
    const proj = join(dir, "proj");
    const db = join(dir, "g", "graph.db");
    mkdirSync(join(dir, "g"));
    writeTree(proj, BEFORE);
    indexJson([proj, "--incremental"], db, dir);

    const target = join(proj, "z.ts");
    const { atime, mtime } = statSync(target);
    writeFileSync(target, "export function zed() { return zed3(); }\nexport function zed3() { return 1; }\n");
    utimesSync(target, atime, mtime); // a grammar upgrade, a checkout or a tool that preserves times looks exactly like this

    const r = indexJson([proj, "--incremental"], db, dir);
    expect(r.incremental).toMatchObject({ mode: "incremental", reparsed: 1, changed: 1 });
    const g = await dumpGraph(db);
    expect(g.nodes.some((n) => n.startsWith("Function|z.ts#zed3|"))).toBe(true);
    expect(g.nodes.some((n) => n.startsWith("Function|z.ts#zed2|"))).toBe(false);
  });

  it("indexes in full, and says why, when the grammar or egr version differs from the one that wrote the state", () => {
    const dir = mkdtempSync(join(scratch, "fingerprint-"));
    const proj = join(dir, "proj");
    const db = join(dir, "g", "graph.db");
    mkdirSync(join(dir, "g"));
    writeTree(proj, BEFORE);
    const statePath = join(dir, "g", "graph.incremental-state.json");

    const first = indexJson([proj, "--incremental"], db, dir);
    expect(first.incremental.mode).toBe("full");
    const total = first.code.files;

    // untouched sources + unchanged parser: nothing is parsed
    expect(indexJson([proj, "--incremental"], db, dir).incremental).toMatchObject({ mode: "incremental", reparsed: 0 });

    // a tree-sitter grammar "upgrade": every mtime and byte of source is identical
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const root = Object.keys(state.roots)[0]!;
    state.roots[root].grammarVersions["tree-sitter-typescript"] = "0.0.0-not-the-installed-one";
    writeFileSync(statePath, JSON.stringify(state));
    const afterGrammar = indexJson([proj, "--incremental"], db, dir);
    expect(afterGrammar.incremental.mode).toBe("full");
    expect(afterGrammar.incremental.reason).toMatch(/grammar/);
    expect(afterGrammar.incremental.reparsed).toBe(total);

    // the same for the egr version itself
    const state2 = JSON.parse(readFileSync(statePath, "utf8"));
    state2.roots[root].egrVersion = "0.0.0-not-this-egr";
    writeFileSync(statePath, JSON.stringify(state2));
    const afterEgr = indexJson([proj, "--incremental"], db, dir);
    expect(afterEgr.incremental.mode).toBe("full");
    expect(afterEgr.incremental.reparsed).toBe(total);

    // and the full run saved a state that works again
    expect(indexJson([proj, "--incremental"], db, dir).incremental).toMatchObject({ mode: "incremental", reparsed: 0 });
  });

  it("indexes in full when a plain `egr index` touched the graph after the state was written", () => {
    const dir = mkdtempSync(join(scratch, "token-"));
    const proj = join(dir, "proj");
    const db = join(dir, "g", "graph.db");
    mkdirSync(join(dir, "g"));
    writeTree(proj, BEFORE);
    indexJson([proj, "--incremental"], db, dir);
    expect(egr(["index", proj], db, dir).status).toBe(0); // no --incremental: the state no longer describes the graph
    const r = indexJson([proj, "--incremental"], db, dir);
    expect(r.incremental.mode).toBe("full");
    expect(r.incremental.reason).toMatch(/again|mismatch/);
    expect(r.incremental.reparsed).toBe(r.code.files);
  });

  it("refuses --incremental with --scip, and --changed-from without --incremental", () => {
    const dir = mkdtempSync(join(scratch, "refuse-"));
    const proj = join(dir, "proj");
    const db = join(dir, "g", "graph.db");
    mkdirSync(join(dir, "g"));
    writeTree(proj, BEFORE);
    const withScip = egr(["index", proj, "--incremental", "--scip", join(dir, "x.scip")], db, dir);
    expect(withScip.status).toBe(1);
    expect(withScip.stderr).toMatch(/--incremental cannot be combined with --scip/);
    const lone = egr(["index", proj, "--changed-from", "HEAD"], db, dir);
    expect(lone.status).toBe(1);
    expect(lone.stderr).toMatch(/--changed-from only makes sense with --incremental/);
  });
});

// ---------------------------------------------------------------------------
// --changed-from <git-ref>
// ---------------------------------------------------------------------------

/** git with every repository-pointing variable cleared, so a fixture repo can never be mistaken for the real one. */
function git(cwd: string, args: string[]): string {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("egr index --incremental --changed-from <git-ref> (XSPEC-508 R6)", () => {
  it("takes the changed files from git diff, ends with the --clean graph, and hashes none of the others", async () => {
    const dir = mkdtempSync(join(scratch, "git-"));
    const proj = join(dir, "proj");
    const db = join(dir, "inc", "graph.db");
    const oracleDb = join(dir, "oracle", "graph.db");
    mkdirSync(join(dir, "inc"));
    mkdirSync(join(dir, "oracle"));
    writeTree(proj, BEFORE);
    git(proj, ["init", "-q"]);
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-q", "-m", "base"]);
    indexJson([proj, "--incremental"], db, dir);

    // edits after the commit the graph describes: modified, new (untracked), deleted
    writeTree(proj, AFTER_CHANGED);
    writeTree(proj, AFTER_NEW);
    rmSync(join(proj, "d.ts"));

    // A file git does NOT list but whose content differs is not looked at: the ref is the caller's statement
    // that the graph describes it. (This is what makes --changed-from cheap, and what makes a wrong ref wrong.)
    const planted = readFileSync(join(proj, "z.ts"), "utf8");
    git(proj, ["update-index", "--assume-unchanged", "z.ts"]);
    writeFileSync(join(proj, "z.ts"), planted + "export function plantedButUnlisted() { return 1; }\n");

    const r = indexJson([proj, "--incremental", "--changed-from", "HEAD"], db, dir);
    expect(r.incremental).toMatchObject({ mode: "incremental", reparsed: 4, changed: 3, added: 1, removed: 1 });

    // restore z.ts so the oracle (a --clean build of the same sources) is comparable
    writeFileSync(join(proj, "z.ts"), planted);
    const copy = join(dir, "proj-copy");
    cpSync(proj, copy, { recursive: true, filter: (src) => !src.includes(`${join("proj", ".git")}`) });
    indexJson([copy, "--clean"], oracleDb, dir);
    const inc = await dumpGraph(db);
    const full = await dumpGraph(oracleDb);
    expect(inc.nodes).toEqual(full.nodes);
    expect(inc.edges).toEqual(full.edges);
    expect(inc.nodes.some((n) => n.includes("plantedButUnlisted"))).toBe(false);
  });

  it("fails with exit 1 and names the ref when git cannot resolve it", () => {
    const dir = mkdtempSync(join(scratch, "badref-"));
    const proj = join(dir, "proj");
    const db = join(dir, "g", "graph.db");
    mkdirSync(join(dir, "g"));
    writeTree(proj, BEFORE);
    git(proj, ["init", "-q"]);
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-q", "-m", "base"]);
    indexJson([proj, "--incremental"], db, dir);
    const r = egr(["index", proj, "--incremental", "--changed-from", "no-such-ref-xyz"], db, dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no-such-ref-xyz");
    expect(existsSync(db)).toBe(true);
  });
});
