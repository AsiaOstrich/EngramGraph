// implements XSPEC-508
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STATE_VERSION,
  applyDelta,
  deriveGraph,
  dropRootState,
  dropState,
  fingerprint,
  gitChangedPaths,
  newToken,
  inspectState,
  readState,
  statePathForManifest,
  usableState,
  writeState,
  type IncrementalState,
  type RootState,
} from "../src/code-graph/incremental.js";
import { extractProjectDetailed, type FileFacts } from "../src/code-graph/extractor.js";
import type { ParseManifest } from "../src/code-graph/parse-manifest.js";
import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { writeFragment } from "../src/graph-db/writer.js";

/**
 * XSPEC-508 R6 — the pieces of `code-graph/incremental.ts`, called directly.
 *
 * The product path (`egr index --incremental`) is proved in `xspec508-r6-incremental-index.test.ts`
 * (built CLI, child process) and in `xspec508-r6-cmdindex-incremental.test.ts` (in-process). This file
 * pins the edges those two reach only by accident: a state file that is damaged in each way it can be,
 * the seven reasons a state is refused, what `dropRootState` keeps, what `gitChangedPaths` reports, and
 * which `// implements` stubs `applyDelta` may delete. Real facts come from the real extractor; nothing
 * here is a hand-made imitation of what parsing would give.
 */

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "egr-r6-state-"));
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function fresh(label: string): string {
  return mkdtempSync(join(scratch, `${label}-`));
}

/** The facts of real sources, as an incremental index would remember them. */
function factsOf(files: Record<string, string>, ids: Record<string, string> = {}): { facts: FileFacts[]; fragment: ReturnType<typeof extractProjectDetailed>["fragment"] } {
  const ex = extractProjectDetailed(
    Object.entries(files).map(([path, source]) => ({ path, source, ...(ids[path] ? { id: ids[path] } : {}) })),
    { hash: true },
  );
  return { facts: ex.facts, fragment: ex.fragment };
}

function rootState(facts: FileFacts[], token = "t1"): RootState {
  return { token, ...fingerprint("9.9.9"), files: Object.fromEntries(facts.map((f) => [f.path, f])) };
}

describe("the state file: read, write, drop (XSPEC-508 R6)", () => {
  it("statePathForManifest keeps the graph's name and swaps the suffix", () => {
    expect(statePathForManifest("/x/.engram/graph.parse-manifest.json")).toBe("/x/.engram/graph.incremental-state.json");
    expect(statePathForManifest("/x/other.json")).toBe("/x/other.json.incremental-state.json");
  });

  it("readState gives null for a file that is absent, not JSON, of another version, or whose roots is not an object", () => {
    const dir = fresh("read");
    const p = join(dir, "s.json");
    expect(readState(p)).toBeNull(); // absent
    writeFileSync(p, "not json");
    expect(readState(p)).toBeNull();
    writeFileSync(p, JSON.stringify({ version: STATE_VERSION + 1, roots: {} }));
    expect(readState(p)).toBeNull();
    writeFileSync(p, JSON.stringify({ version: STATE_VERSION, roots: null }));
    expect(readState(p)).toBeNull();
    writeFileSync(p, JSON.stringify({ version: STATE_VERSION, roots: "x" }));
    expect(readState(p)).toBeNull();
    writeFileSync(p, JSON.stringify({ version: STATE_VERSION, roots: {} }));
    expect(readState(p)).toEqual({ version: STATE_VERSION, roots: {} });
  });

  it("inspectState says WHY a state cannot be used: absent, unreadable, older, newer (issue #17)", () => {
    const dir = fresh("inspect");
    const p = join(dir, "s.json");
    expect(inspectState(p)).toEqual({ state: null, problem: { kind: "absent" } });
    writeFileSync(p, "not json");
    expect(inspectState(p)).toEqual({ state: null, problem: { kind: "unreadable" } });
    writeFileSync(p, "null");
    expect(inspectState(p)).toEqual({ state: null, problem: { kind: "unreadable" } });
    writeFileSync(p, JSON.stringify({ roots: {} })); // no version at all
    expect(inspectState(p)).toEqual({ state: null, problem: { kind: "unreadable" } });
    writeFileSync(p, JSON.stringify({ version: "2", roots: {} }));
    expect(inspectState(p)).toEqual({ state: null, problem: { kind: "unreadable" } });
    writeFileSync(p, JSON.stringify({ version: STATE_VERSION, roots: "x" }));
    expect(inspectState(p)).toEqual({ state: null, problem: { kind: "unreadable" } });
    writeFileSync(p, JSON.stringify({ version: STATE_VERSION - 1, roots: {} }));
    expect(inspectState(p)).toEqual({ state: null, problem: { kind: "older", version: STATE_VERSION - 1 } });
    writeFileSync(p, JSON.stringify({ version: STATE_VERSION + 1, roots: {} }));
    expect(inspectState(p)).toEqual({ state: null, problem: { kind: "newer", version: STATE_VERSION + 1 } });
    writeFileSync(p, JSON.stringify({ version: STATE_VERSION, roots: {} }));
    expect(inspectState(p)).toEqual({ state: { version: STATE_VERSION, roots: {} } });
    mkdirSync(join(dir, "adir"));
    expect(inspectState(join(dir, "adir"))).toEqual({ state: null, problem: { kind: "unreadable" } }); // exists, cannot be read as a file
  });

  it("writeState round-trips through readState and leaves no temp file", () => {
    const dir = fresh("write");
    const p = join(dir, "s.json");
    const { facts } = factsOf({ "a.ts": "export function a() { return 1; }\n" });
    const state: IncrementalState = { version: STATE_VERSION, roots: { "/r": rootState(facts) } };
    writeState(p, state);
    expect(readState(p)).toEqual(state);
    expect(readdirSync(dir)).toEqual(["s.json"]);
  });

  it("writeState into a directory that does not exist throws and leaves nothing behind", () => {
    const dir = fresh("write-fail");
    const p = join(dir, "missing", "s.json");
    expect(() => writeState(p, { version: STATE_VERSION, roots: {} })).toThrow();
    expect(existsSync(join(dir, "missing"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("dropState removes the file, and a file that is already gone is not an error", () => {
    const dir = fresh("drop");
    const p = join(dir, "s.json");
    writeState(p, { version: STATE_VERSION, roots: {} });
    dropState(p);
    expect(existsSync(p)).toBe(false);
    expect(() => dropState(p)).not.toThrow();
  });

  describe("dropRootState", () => {
    const A = rootState(factsOf({ "a.ts": "export function a() { return 1; }\n" }).facts, "ta");
    const B = rootState(factsOf({ "b.ts": "export function b() { return 1; }\n" }).facts, "tb");

    it("removes ONE root's section and keeps every other root's, byte for byte", () => {
      const dir = fresh("dropone");
      const p = join(dir, "s.json");
      writeState(p, { version: STATE_VERSION, roots: { "/a": A, "/b": B } });
      dropRootState(p, "/a");
      const after = readState(p)!;
      expect(Object.keys(after.roots)).toEqual(["/b"]);
      expect(after.roots["/b"]).toEqual(B);
    });

    it("removes the file when no root is left", () => {
      const dir = fresh("droplast");
      const p = join(dir, "s.json");
      writeState(p, { version: STATE_VERSION, roots: { "/a": A } });
      dropRootState(p, "/a");
      expect(existsSync(p)).toBe(false);
    });

    it("does nothing for a root the state does not hold, for no file, and for a file it cannot read", () => {
      const dir = fresh("dropnone");
      const p = join(dir, "s.json");
      expect(() => dropRootState(p, "/a")).not.toThrow(); // no file
      expect(existsSync(p)).toBe(false);

      writeState(p, { version: STATE_VERSION, roots: { "/a": A } });
      const before = readFileSync(p, "utf8");
      dropRootState(p, "/other");
      expect(readFileSync(p, "utf8")).toBe(before); // untouched, not rewritten

      writeFileSync(p, "garbage");
      dropRootState(p, "/a");
      expect(readFileSync(p, "utf8")).toBe("garbage"); // not ours to repair here
    });
  });

  it("newToken gives a different token every time", () => {
    const tokens = new Set(Array.from({ length: 20 }, () => newToken()));
    expect(tokens.size).toBe(20);
  });

  it("fingerprint carries the egr version given and the installed grammars", () => {
    const f = fingerprint("1.2.3");
    expect(f.egrVersion).toBe("1.2.3");
    expect(Object.keys(f.grammarVersions)).toContain("tree-sitter-typescript");
  });
});

describe("usableState: the reasons a remembered state is refused (XSPEC-508 R6)", () => {
  const { facts } = factsOf({ "a.ts": "export function a() { return 1; }\n" });
  const manifestWith = (section: Partial<ParseManifest["runs"][string]> | undefined): ParseManifest => ({
    egrVersion: "9.9.9",
    grammarVersions: {},
    runs: section ? { "/r": { indexedAt: "t", files: [], ...section } } : {},
  });
  const stateWith = (prev: RootState | undefined): IncrementalState => ({ version: STATE_VERSION, roots: prev ? { "/r": prev } : {} });

  it("accepts a state whose token and parser match, and hands back that root's section", () => {
    const prev = rootState(facts, "tok");
    const r = usableState({ root: "/r", manifest: manifestWith({ incrementalToken: "tok" }), state: stateWith(prev), egrVersion: "9.9.9" });
    expect(r).toEqual({ ok: true, prev });
  });

  it.each([
    ["no manifest", { manifest: null, state: stateWith(rootState(facts)) }, "first index of this graph"],
    ["a manifest without this root", { manifest: manifestWith(undefined), state: stateWith(rootState(facts)) }, "has not been indexed into this graph before"],
    ["no state", { manifest: manifestWith({ incrementalToken: "t1" }), state: null }, "no incremental state yet"],
    ["a state without this root", { manifest: manifestWith({ incrementalToken: "t1" }), state: stateWith(undefined) }, "no incremental state for this root yet"],
    ["a section with no token (a plain index wrote it)", { manifest: manifestWith({}), state: stateWith(rootState(facts, "t1")) }, "token mismatch"],
    ["a token that differs", { manifest: manifestWith({ incrementalToken: "other" }), state: stateWith(rootState(facts, "t1")) }, "token mismatch"],
    ["another egr version", { manifest: manifestWith({ incrementalToken: "t1" }), state: stateWith({ ...rootState(facts, "t1"), egrVersion: "1.0.0" }) }, "parser fingerprint differs"],
    [
      "a grammar of another version",
      { manifest: manifestWith({ incrementalToken: "t1" }), state: stateWith({ ...rootState(facts, "t1"), grammarVersions: { ...fingerprint("9.9.9").grammarVersions, "tree-sitter-typescript": "0.0.0" } }) },
      "parser fingerprint differs",
    ],
    [
      "a grammar that is no longer installed (fewer entries)",
      { manifest: manifestWith({ incrementalToken: "t1" }), state: stateWith({ ...rootState(facts, "t1"), grammarVersions: { "tree-sitter": "1" } }) },
      "parser fingerprint differs",
    ],
    ["no state, and the file was written by an older egr", { manifest: manifestWith({ incrementalToken: "t1" }), state: null, stateProblem: { kind: "older", version: 1 } }, "written by an older egr (state version 1, now 2)"],
    ["no state, and the file was written by a newer egr", { manifest: manifestWith({ incrementalToken: "t1" }), state: null, stateProblem: { kind: "newer", version: 3 } }, "written by a newer egr (state version 3, now 2)"],
    ["no state, because the file could not be read", { manifest: manifestWith({ incrementalToken: "t1" }), state: null, stateProblem: { kind: "unreadable" } }, "could not be read"],
  ] as const)("refuses %s", (_name, input, reason) => {
    const r = usableState({ root: "/r", egrVersion: "9.9.9", ...input });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(reason);
  });
});

describe("gitChangedPaths (XSPEC-508 R6)", () => {
  const GIT_LOCAL_ENV = [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
  ];
  function git(cwd: string, ...args: string[]): void {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    for (const k of GIT_LOCAL_ENV) delete env[k];
    execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", ...args], { env, stdio: "pipe" });
  }
  function repo(label: string): string {
    const dir = fresh(label);
    mkdirSync(join(dir, "sub"), { recursive: true });
    for (const [name, text] of Object.entries({ "a.ts": "1\n", "b.ts": "2\n", "gone.ts": "3\n", "sub/s.ts": "4\n", ".gitignore": "ignored.ts\n" })) writeFileSync(join(dir, name), text);
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    return dir;
  }

  it("lists a modified file, a deleted file and an untracked one, and not an unchanged or an ignored one", () => {
    const dir = repo("git-basic");
    writeFileSync(join(dir, "a.ts"), "changed\n");
    rmSync(join(dir, "gone.ts"));
    writeFileSync(join(dir, "new.ts"), "x\n");
    writeFileSync(join(dir, "ignored.ts"), "x\n");
    expect([...gitChangedPaths(dir, "HEAD")].sort()).toEqual(["a.ts", "gone.ts", "new.ts"]);
  });

  it("reports a rename as the old path (gone) and the new path (there)", () => {
    const dir = repo("git-rename");
    git(dir, "mv", "b.ts", "c.ts");
    expect([...gitChangedPaths(dir, "HEAD")].sort()).toEqual(["b.ts", "c.ts"]);
  });

  it("paths are relative to the directory asked about, not to the repository", () => {
    const dir = repo("git-relative");
    writeFileSync(join(dir, "sub", "s.ts"), "changed\n");
    writeFileSync(join(dir, "a.ts"), "changed\n");
    expect([...gitChangedPaths(join(dir, "sub"), "HEAD")]).toEqual(["s.ts"]);
  });

  it("an empty set when nothing differs", () => {
    const dir = repo("git-clean");
    expect(gitChangedPaths(dir, "HEAD").size).toBe(0);
  });

  it("refuses an empty ref and a ref that starts with '-' (it would be read as an option) without running git", () => {
    expect(() => gitChangedPaths("/nonexistent-dir", "")).toThrow(/--changed-from needs a git ref \(got ""\)/);
    expect(() => gitChangedPaths("/nonexistent-dir", "--output=/tmp/x")).toThrow(/--changed-from needs a git ref/);
  });

  it("a ref git does not know, or a directory that is no repository, throws with git's own words", () => {
    const dir = repo("git-badref");
    expect(() => gitChangedPaths(dir, "no-such-ref")).toThrow(/--changed-from no-such-ref: git diff failed in .*:/);
    expect(() => gitChangedPaths(fresh("git-norepo"), "HEAD")).toThrow(/--changed-from HEAD: git diff failed/);
  });

  it("is not redirected by the GIT_DIR of a hook that runs us: it answers about the directory it was given", () => {
    const dir = repo("git-env");
    const other = repo("git-env-other");
    writeFileSync(join(dir, "a.ts"), "changed\n");
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    try {
      expect([...gitChangedPaths(dir, "HEAD")]).toEqual(["a.ts"]);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("deriveGraph (XSPEC-508 R6)", () => {
  it("describes the nodes and edges a full index of those facts would write", () => {
    const { facts } = factsOf({
      "a.ts": "// implements XSPEC-900\nexport function foo() { return helper(); }\nexport function helper() { return 1; }\nexport class W {}\n",
      "b.ts": "export function use() { return foo(); }\n",
    });
    const g = deriveGraph(facts);
    expect([...g.modules].sort()).toEqual(["a.ts", "b.ts"]);
    expect([...g.functions].sort()).toEqual(["a.ts#foo", "a.ts#helper", "b.ts#use"]);
    expect([...g.classes]).toEqual(["a.ts#class:W"]);
    expect([...g.specs]).toEqual(["XSPEC-900"]);
    const keys = [...g.edges.values()].map((e) => `${e.label} ${e.from} ${e.to}`).sort();
    expect(keys).toEqual(["CALLS a.ts#foo a.ts#helper", "CALLS b.ts#use a.ts#foo", "DEFINES a.ts a.ts#foo", "DEFINES a.ts a.ts#helper", "DEFINES b.ts b.ts#use", "IMPLEMENTS a.ts XSPEC-900"]);
  });

  it("uses a file's root-qualified id when it has one, for the module and for what it defines", () => {
    const { facts } = factsOf({ "src/i.ts": "export function boot() { return 1; }\n" }, { "src/i.ts": "pkg/src/i.ts" });
    const g = deriveGraph(facts);
    expect([...g.modules]).toEqual(["pkg/src/i.ts"]);
    expect([...g.functions]).toEqual(["pkg/src/i.ts#boot"]);
  });

  it("is empty for no facts", () => {
    const g = deriveGraph([]);
    expect(g.modules.size + g.functions.size + g.classes.size + g.specs.size + g.edges.size).toBe(0);
  });
});

describe("applyDelta against a real graph (XSPEC-508 R6)", () => {
  async function withGraph(label: string, fn: (conn: GraphConnection, dir: string) => Promise<void>): Promise<void> {
    const dir = fresh(label);
    const conn = GraphConnection.open(join(dir, "graph.db"));
    try {
      await initSchema(conn);
      await fn(conn, dir);
    } finally {
      await conn.close();
    }
  }
  const count = async (conn: GraphConnection, cypher: string): Promise<number> => Number((await conn.query(cypher))[0]?.c ?? 0);

  it("removes what the new facts no longer describe, writes what they add, and reports the numbers", async () => {
    await withGraph("delta-basic", async (conn) => {
      const before = factsOf({
        "a.ts": "export function foo() { return helper(); }\nexport function helper() { return 1; }\nexport class Gone {}\n",
        "b.ts": "export function use() { return foo(); }\n",
        "c.ts": "export function lone() { return 1; }\n",
      });
      await writeFragment(conn, before.fragment);
      expect(await count(conn, "MATCH (n:Function) RETURN count(n) AS c")).toBe(4);

      // a.ts loses helper and Gone, c.ts is deleted, d.ts is new and calls foo too
      const after = factsOf({
        "a.ts": "export function foo() { return 1; }\n",
        "b.ts": "export function use() { return foo(); }\n",
        "d.ts": "export function fresh() { return foo(); }\n",
      });
      const freshNodes = after.fragment.nodes.filter((n) => n.id.startsWith("a.ts") || n.id.startsWith("d.ts"));
      const stats = await applyDelta(conn, before.facts, after.facts, freshNodes);

      expect(stats.nodesRemoved).toBe(4); // helper, Gone, lone, Module c.ts
      expect(stats.edgesRemoved).toBe(0); // foo -> helper died WITH helper (DETACH DELETE), so it is not deleted twice
      const fn = (await conn.query("MATCH (n:Function) RETURN n.id AS id")).map((r) => String(r.id)).sort();
      expect(fn).toEqual(["a.ts#foo", "b.ts#use", "d.ts#fresh"]);
      const mods = (await conn.query("MATCH (n:Module) RETURN n.id AS id")).map((r) => String(r.id)).sort();
      expect(mods).toEqual(["a.ts", "b.ts", "d.ts"]);
      expect(await count(conn, "MATCH (n:Class) RETURN count(n) AS c")).toBe(0);
      const calls = (await conn.query("MATCH (a:Function)-[:CALLS]->(b:Function) RETURN a.id AS a, b.id AS b")).map((r) => `${r.a} -> ${r.b}`).sort();
      expect(calls).toEqual(["b.ts#use -> a.ts#foo", "d.ts#fresh -> a.ts#foo"]);
      expect(stats.edgesWritten).toBe(2); // d.ts DEFINES fresh, fresh CALLS foo - and nothing that was already there
    });
  });

  it("deletes an edge between two functions that both stay, when a name turns ambiguous in another file", async () => {
    await withGraph("delta-ambiguous", async (conn) => {
      const before = factsOf({ "b.ts": "export function use() { return dup(); }\n", "c.ts": "export function dup() { return 1; }\n" });
      await writeFragment(conn, before.fragment);
      expect(await count(conn, "MATCH (:Function {id: 'b.ts#use'})-[r:CALLS]->(:Function {id: 'c.ts#dup'}) RETURN count(r) AS c")).toBe(1);

      const after = factsOf({ "a.ts": "export function dup() { return 2; }\n", "b.ts": "export function use() { return dup(); }\n", "c.ts": "export function dup() { return 1; }\n" });
      const stats = await applyDelta(conn, before.facts, after.facts, after.fragment.nodes.filter((n) => n.id.startsWith("a.ts")));

      expect(stats.edgesRemoved).toBe(1);
      expect(stats.nodesRemoved).toBe(0);
      expect(await count(conn, "MATCH (:Function)-[r:CALLS]->(:Function) RETURN count(r) AS c")).toBe(0);
      expect(await count(conn, "MATCH (n:Function) RETURN count(n) AS c")).toBe(3); // all three functions stayed
    });
  });

  it("deletes more than one chunk of nodes (the ids go to the engine 200 at a time)", async () => {
    await withGraph("delta-chunks", async (conn) => {
      const N = 450;
      const src = Array.from({ length: N }, (_, i) => `export function f${i}() { return ${i}; }`).join("\n") + "\n";
      const before = factsOf({ "big.ts": src, "keep.ts": "export function k() { return 1; }\n" });
      await writeFragment(conn, before.fragment);
      expect(await count(conn, "MATCH (n:Function) RETURN count(n) AS c")).toBe(N + 1);

      const after = factsOf({ "keep.ts": "export function k() { return 1; }\n" });
      const stats = await applyDelta(conn, before.facts, after.facts, []);
      expect(stats.nodesRemoved).toBe(N + 1); // 450 functions + the Module
      expect(await count(conn, "MATCH (n:Function) RETURN count(n) AS c")).toBe(1);
      expect(await count(conn, "MATCH (n:Module) RETURN count(n) AS c")).toBe(1);
    });
  });

  it("rewrites an edge whose call_count changed, and leaves an edge that did not change alone", async () => {
    await withGraph("delta-callcount", async (conn) => {
      const before = factsOf({ "a.ts": "export function f() { return g() + h(); }\nexport function g() { return 1; }\nexport function h() { return 1; }\n" });
      await writeFragment(conn, before.fragment);
      const after = factsOf({ "a.ts": "export function f() { return g() + g() + g() + h(); }\nexport function g() { return 1; }\nexport function h() { return 1; }\n" });
      const stats = await applyDelta(conn, before.facts, after.facts, after.fragment.nodes);
      const rows = await conn.query("MATCH (a:Function {id: 'a.ts#f'})-[r:CALLS]->(b:Function) RETURN b.id AS b, r.call_count AS n");
      const byCallee = Object.fromEntries(rows.map((r) => [String(r.b), Number(r.n)]));
      expect(byCallee).toEqual({ "a.ts#g": 3, "a.ts#h": 1 });
      expect(stats.edgesRemoved).toBe(0);
    });
  });

  describe("an `// implements` stub nobody implements any more", () => {
    const withAnnotation = { "m.ts": "// implements XSPEC-777\nexport function keep() { return 1; }\n" };
    const without = { "m.ts": "export function keep() { return 1; }\n" };

    async function specCount(conn: GraphConnection): Promise<number> {
      return count(conn, "MATCH (s:Spec {id: 'XSPEC-777'}) RETURN count(s) AS c");
    }

    it("is deleted when it was only ever annotated and nothing else points at it", async () => {
      await withGraph("stub-delete", async (conn) => {
        const before = factsOf(withAnnotation);
        await writeFragment(conn, before.fragment);
        expect(await specCount(conn)).toBe(1);
        const after = factsOf(without);
        const stats = await applyDelta(conn, before.facts, after.facts, after.fragment.nodes);
        expect(await specCount(conn)).toBe(0);
        expect(stats.nodesRemoved).toBe(1);
      });
    });

    it("is kept when its origin is not 'annotated' (a document declared it)", async () => {
      await withGraph("stub-declared", async (conn) => {
        const before = factsOf(withAnnotation);
        await writeFragment(conn, before.fragment);
        await conn.execute("MATCH (s:Spec {id: 'XSPEC-777'}) SET s.origin = 'declared'");
        const after = factsOf(without);
        const stats = await applyDelta(conn, before.facts, after.facts, after.fragment.nodes);
        expect(await specCount(conn)).toBe(1);
        expect(stats.nodesRemoved).toBe(0);
      });
    });

    it("is kept while another Module still implements it", async () => {
      await withGraph("stub-other-module", async (conn) => {
        const both = factsOf({ ...withAnnotation, "n.ts": "// implements XSPEC-777\nexport function other() { return 1; }\n" });
        await writeFragment(conn, both.fragment);
        const after = factsOf({ ...without, "n.ts": "// implements XSPEC-777\nexport function other() { return 1; }\n" });
        await applyDelta(conn, both.facts, after.facts, after.fragment.nodes);
        expect(await specCount(conn)).toBe(1);
        expect(await count(conn, "MATCH (:Module)-[r:IMPLEMENTS]->(:Spec {id: 'XSPEC-777'}) RETURN count(r) AS c")).toBe(1);
      });
    });

    it("is kept while a Decision impacts it", async () => {
      await withGraph("stub-decision", async (conn) => {
        const before = factsOf(withAnnotation);
        await writeFragment(conn, before.fragment);
        await conn.execute("CREATE (:Decision {id: 'DEC-1'})");
        await conn.execute("MATCH (d:Decision {id: 'DEC-1'}), (s:Spec {id: 'XSPEC-777'}) CREATE (d)-[:IMPACTS]->(s)");
        const after = factsOf(without);
        await applyDelta(conn, before.facts, after.facts, after.fragment.nodes);
        expect(await specCount(conn)).toBe(1);
      });
    });

    it("is kept while another Spec relates to it, in either direction", async () => {
      for (const dir of ["in", "out"] as const) {
        await withGraph(`stub-relates-${dir}`, async (conn) => {
          const before = factsOf(withAnnotation);
          await writeFragment(conn, before.fragment);
          await conn.execute("CREATE (:Spec {id: 'XSPEC-OTHER', origin: 'declared'})");
          const link = dir === "in" ? "(o)-[:RELATES]->(s)" : "(s)-[:RELATES]->(o)";
          await conn.execute(`MATCH (o:Spec {id: 'XSPEC-OTHER'}), (s:Spec {id: 'XSPEC-777'}) CREATE ${link}`);
          const after = factsOf(without);
          await applyDelta(conn, before.facts, after.facts, after.fragment.nodes);
          expect(await specCount(conn)).toBe(1);
        });
      }
    });

    it("a stub that is not in the graph any more is not an error", async () => {
      await withGraph("stub-missing", async (conn) => {
        const before = factsOf(withAnnotation);
        await writeFragment(conn, before.fragment);
        await conn.execute("MATCH (s:Spec {id: 'XSPEC-777'}) DETACH DELETE s");
        const after = factsOf(without);
        const stats = await applyDelta(conn, before.facts, after.facts, after.fragment.nodes);
        expect(stats.nodesRemoved).toBe(0);
      });
    });
  });
});
