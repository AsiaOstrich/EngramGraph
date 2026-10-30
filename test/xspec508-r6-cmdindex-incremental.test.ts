// implements XSPEC-508
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { cmdIndex, type IndexResultSummary } from "../src/cli/run.js";
import { readState, statePathForManifest, type IncrementalState } from "../src/code-graph/incremental.js";
import { MCP_INDEX_ROOT, manifestPathForDb, readManifest, type ParseManifest } from "../src/code-graph/parse-manifest.js";
import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";

/**
 * XSPEC-508 R6 — `cmdIndex({ incremental: true })` called IN THE TEST PROCESS.
 *
 * `xspec508-r6-incremental-index.test.ts` and `xspec508-r6-multiroot-ids.test.ts` run the built CLI as
 * a child process, which is the right way to prove the product works, and which v8 coverage cannot
 * see: 0.14.0-beta.1 was stopped at publish time by the coverage gate (incremental.ts 3.7%, root-ids.ts
 * 67%, run.ts 64%) with 94 files of green tests. These tests call the same entry point
 * (`cmdIndex`, what `egr index --incremental` calls) in this process and read the effect back from the
 * graph, the state file and the manifest — every `it` builds its own tree and database, so any one of
 * them can be run alone.
 */

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "egr-r6-inproc-"));
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** Git variables that point a command at ANOTHER repository (`git rev-parse --local-env-vars`). */
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

interface Env {
  dir: string;
  db: string;
  manifestPath: string;
  statePath: string;
  conn: GraphConnection;
}

/** A fresh directory, graph and manifest path; closed (and the directory kept for the process) when `fn` ends. */
async function withEnv(label: string, fn: (env: Env) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(scratch, `${label}-`));
  const db = join(dir, "g", "graph.db");
  mkdirSync(join(dir, "g"));
  const conn = GraphConnection.open(db);
  try {
    await initSchema(conn);
    const manifestPath = manifestPathForDb(db);
    await fn({ dir, db, manifestPath, statePath: statePathForManifest(manifestPath), conn });
  } finally {
    await conn.close();
  }
}

function writeTree(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
}

const TREE: Record<string, string> = {
  "a.ts": "export function foo() { return helper(); }\nexport function helper() { return 1; }\n",
  "b.ts": "export function useDup() { return dup(); }\n",
  "c.ts": "export function dup() { return 1; }\n",
};

async function ids(conn: GraphConnection, label: "Function" | "Module" | "Spec"): Promise<string[]> {
  const rows = await conn.query(`MATCH (n:${label}) RETURN n.id AS id`);
  return rows.map((r) => String(r.id)).sort();
}

async function calls(conn: GraphConnection): Promise<string[]> {
  const rows = await conn.query("MATCH (a:Function)-[:CALLS]->(b:Function) RETURN a.id AS a, b.id AS b");
  return rows.map((r) => `${r.a} -> ${r.b}`).sort();
}

function inc(r: IndexResultSummary) {
  if (!r.incremental) throw new Error("the summary has no `incremental` part");
  return r.incremental;
}

describe("cmdIndex --incremental, called in-process (XSPEC-508 R6)", () => {
  it("the first run is a full index that says why and leaves a state file + manifest token that match", async () => {
    await withEnv("first", async (e) => {
      const proj = join(e.dir, "proj");
      writeTree(proj, TREE);
      const r = await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });

      expect(inc(r)).toMatchObject({ mode: "full", reparsed: 3, reused: 0, added: 3, removed: 0 });
      expect(inc(r).reason).toContain("first index of this graph");
      expect(await ids(e.conn, "Module")).toEqual(["a.ts", "b.ts", "c.ts"]);

      // the state and the manifest section carry the same token, and the state holds every file's facts + hash
      const state = readState(e.statePath)!;
      const manifest = readManifest(e.manifestPath)!;
      const root = resolve(proj);
      expect(manifest.runs[root]!.incrementalToken).toBeTruthy();
      expect(state.roots[root]!.token).toBe(manifest.runs[root]!.incrementalToken);
      expect(Object.keys(state.roots[root]!.files).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
      expect(state.roots[root]!.files["a.ts"]!.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(state.roots[root]!.files["a.ts"]!.fnIds).toEqual(["a.ts#foo", "a.ts#helper"]);
    });
  });

  it("with no manifest path there is nowhere to keep the state: full, says so, and no state file appears", async () => {
    await withEnv("nomanifest", async (e) => {
      const proj = join(e.dir, "proj");
      writeTree(proj, TREE);
      const r = await cmdIndex(e.conn, { dir: proj, incremental: true });
      expect(inc(r).mode).toBe("full");
      expect(inc(r).reason).toContain("nowhere to keep the incremental state");
      expect(existsSync(e.statePath)).toBe(false);
      expect(await ids(e.conn, "Module")).toEqual(["a.ts", "b.ts", "c.ts"]);
    });
  });

  it("a second run with nothing edited parses nothing and writes nothing", async () => {
    await withEnv("noop", async (e) => {
      const proj = join(e.dir, "proj");
      writeTree(proj, TREE);
      await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      const before = await calls(e.conn);
      const r = await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      expect(inc(r)).toMatchObject({ mode: "incremental", reparsed: 0, reused: 3, changed: 0, added: 0, removed: 0, nodesRemoved: 0, edgesRemoved: 0, edgesWritten: 0 });
      expect(await calls(e.conn)).toEqual(before);
    });
  });

  it("an edited file is re-parsed alone, and an UNTOUCHED file's call edge follows the name that became ambiguous", async () => {
    await withEnv("edit", async (e) => {
      const proj = join(e.dir, "proj");
      writeTree(proj, TREE);
      await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      expect(await calls(e.conn)).toContain("b.ts#useDup -> c.ts#dup");

      writeFileSync(join(proj, "a.ts"), "export function foo() { return helper2(); }\nexport function helper2() { return 1; }\nexport function dup() { return 2; }\n");
      const r = await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });

      expect(inc(r)).toMatchObject({ mode: "incremental", reparsed: 1, changed: 1, added: 0, reused: 2, removed: 0 });
      expect(await ids(e.conn, "Function")).toEqual(["a.ts#dup", "a.ts#foo", "a.ts#helper2", "b.ts#useDup", "c.ts#dup"]); // helper is gone, helper2 is there
      const c = await calls(e.conn);
      expect(c).toContain("a.ts#foo -> a.ts#helper2");
      expect(c).not.toContain("a.ts#foo -> a.ts#helper");
      expect(c).not.toContain("b.ts#useDup -> c.ts#dup"); // b.ts was not touched; `dup` is now defined twice
    });
  });

  it("a file that is deleted leaves the graph with its functions, its edges and its Module, and the state forgets it", async () => {
    await withEnv("delete", async (e) => {
      const proj = join(e.dir, "proj");
      writeTree(proj, TREE);
      await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });

      rmSync(join(proj, "c.ts"));
      const r = await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });

      expect(inc(r)).toMatchObject({ mode: "incremental", reparsed: 0, removed: 1 });
      expect(inc(r).nodesRemoved).toBe(2); // the Function and the Module of c.ts
      expect(await ids(e.conn, "Module")).toEqual(["a.ts", "b.ts"]);
      expect(await ids(e.conn, "Function")).toEqual(["a.ts#foo", "a.ts#helper", "b.ts#useDup"]);
      expect(await calls(e.conn)).toEqual(["a.ts#foo -> a.ts#helper"]);
      expect(Object.keys(readState(e.statePath)!.roots[resolve(proj)]!.files).sort()).toEqual(["a.ts", "b.ts"]);
    });
  });

  it("a new file is counted as added, and a file that already called its name now calls it", async () => {
    await withEnv("add", async (e) => {
      const proj = join(e.dir, "proj");
      writeTree(proj, { ...TREE, "x.ts": "export function useE() { return eFn(); }\n" });
      await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });

      writeTree(proj, { "e.ts": "export function eFn() { return 1; }\n" });
      const r = await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });

      expect(inc(r)).toMatchObject({ mode: "incremental", reparsed: 1, changed: 0, added: 1, reused: 4, removed: 0 });
      expect(await ids(e.conn, "Module")).toContain("e.ts");
      expect(await calls(e.conn)).toContain("x.ts#useE -> e.ts#eFn");
    });
  });

  it("removing a `// implements` line removes the annotated Spec stub; adding one creates it", async () => {
    await withEnv("spec", async (e) => {
      const proj = join(e.dir, "proj");
      writeTree(proj, { "m.ts": "// implements XSPEC-901\nexport function keep() { return 1; }\n" });
      await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      expect(await ids(e.conn, "Spec")).toEqual(["XSPEC-901"]);

      writeTree(proj, { "m.ts": "// implements XSPEC-902\nexport function keep() { return 1; }\n" });
      const r = await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      expect(inc(r).mode).toBe("incremental");
      expect(await ids(e.conn, "Spec")).toEqual(["XSPEC-902"]);
    });
  });

  it("a state file that is not JSON is not trusted: full, and the reason says it could not be read", async () => {
    await withEnv("badstate", async (e) => {
      const proj = join(e.dir, "proj");
      writeTree(proj, TREE);
      await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      writeFileSync(e.statePath, "{ this is not json");
      const r = await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      expect(inc(r).mode).toBe("full");
      expect(inc(r).reason).toContain("could not be read");
      // and the run repaired it: the next one is incremental again
      expect(inc(await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath })).mode).toBe("incremental");
    });
  });

  it("a state file of another version is not trusted either, and the reason names the versions (issue #17)", async () => {
    await withEnv("oldversion", async (e) => {
      const proj = join(e.dir, "proj");
      writeTree(proj, TREE);
      await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      const state = JSON.parse(readFileSync(e.statePath, "utf8")) as IncrementalState;
      writeFileSync(e.statePath, JSON.stringify({ ...state, version: state.version + 1 }));
      const r = await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      expect(inc(r).mode).toBe("full");
      expect(inc(r).reason).toContain(`written by a newer egr (state version ${state.version + 1}, now ${state.version})`);
      writeFileSync(e.statePath, JSON.stringify({ ...state, version: state.version - 1 }));
      const older = await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      expect(inc(older).mode).toBe("full");
      expect(inc(older).reason).toContain(`written by an older egr (state version ${state.version - 1}, now ${state.version})`);
    });
  });

  it("a state with no section for this root is not trusted", async () => {
    await withEnv("noroot", async (e) => {
      const proj = join(e.dir, "proj");
      writeTree(proj, TREE);
      await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      writeFileSync(e.statePath, JSON.stringify({ version: readState(e.statePath)!.version, roots: {} }));
      const r = await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      expect(inc(r).mode).toBe("full");
      expect(inc(r).reason).toContain("no incremental state for this root yet");
    });
  });

  it("a plain index after the state was written makes the state stale (token mismatch): full, with that reason", async () => {
    await withEnv("token", async (e) => {
      const proj = join(e.dir, "proj");
      writeTree(proj, TREE);
      await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      await cmdIndex(e.conn, { dir: proj, manifestPath: e.manifestPath }); // a plain run rewrites the manifest section without the token
      expect(readManifest(e.manifestPath)!.runs[resolve(proj)]!.incrementalToken).toBeUndefined();

      const r = await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      expect(inc(r).mode).toBe("full");
      expect(inc(r).reason).toContain("token mismatch");
    });
  });

  it("a graph that was emptied while the state remained is detected from the graph itself: full, 'fewer files'", async () => {
    await withEnv("emptied", async (e) => {
      const proj = join(e.dir, "proj");
      writeTree(proj, TREE);
      await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      await e.conn.execute("MATCH (m:Module) DETACH DELETE m");
      expect(await ids(e.conn, "Module")).toEqual([]);

      const r = await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      expect(inc(r).mode).toBe("full");
      expect(inc(r).reason).toContain("fewer files than the incremental state remembers");
      expect(await ids(e.conn, "Module")).toEqual(["a.ts", "b.ts", "c.ts"]); // and the full index put them back
    });
  });

  it("an older parser (state written by another egr version) is parsed again in full, naming the fingerprint", async () => {
    await withEnv("oldparser", async (e) => {
      const proj = join(e.dir, "proj");
      writeTree(proj, TREE);
      await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      const state = JSON.parse(readFileSync(e.statePath, "utf8")) as IncrementalState;
      state.roots[resolve(proj)]!.egrVersion = "0.0.0-older";
      writeFileSync(e.statePath, JSON.stringify(state));
      const r = await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      expect(inc(r).mode).toBe("full");
      expect(inc(r).reason).toContain("parser fingerprint differs");
    });
  });

  it("--clean with --incremental is a full index of this root alone: the state keeps only that root", async () => {
    await withEnv("clean", async (e) => {
      const p1 = join(e.dir, "one");
      const p2 = join(e.dir, "two");
      writeTree(p1, { "a.ts": "export function one() { return 1; }\n" });
      writeTree(p2, { "b.ts": "export function two() { return 2; }\n" });
      await cmdIndex(e.conn, { dir: p1, incremental: true, manifestPath: e.manifestPath });
      await cmdIndex(e.conn, { dir: p2, incremental: true, manifestPath: e.manifestPath });
      expect(Object.keys(readState(e.statePath)!.roots).sort()).toEqual([resolve(p1), resolve(p2)].sort());

      const r = await cmdIndex(e.conn, { dir: p2, incremental: true, clean: true, manifestPath: e.manifestPath });
      expect(inc(r).mode).toBe("full");
      expect(inc(r).reason).toContain("--clean");
      expect(await ids(e.conn, "Module")).toEqual(["b.ts"]);
      expect(Object.keys(readState(e.statePath)!.roots)).toEqual([resolve(p2)]);
      expect(Object.keys(readManifest(e.manifestPath)!.runs)).toEqual([resolve(p2)]);
    });
  });

  it("refuses --incremental together with --scip before it writes anything", async () => {
    await withEnv("scip", async (e) => {
      const proj = join(e.dir, "proj");
      writeTree(proj, TREE);
      await expect(cmdIndex(e.conn, { dir: proj, incremental: true, scip: join(e.dir, "index.scip"), manifestPath: e.manifestPath })).rejects.toThrow(
        /--incremental cannot be combined with --scip/,
      );
      expect(await ids(e.conn, "Module")).toEqual([]);
      expect(existsSync(e.manifestPath)).toBe(false);
    });
  });

  it("refuses --changed-from without --incremental", async () => {
    await withEnv("changedfrom-alone", async (e) => {
      const proj = join(e.dir, "proj");
      writeTree(proj, TREE);
      await expect(cmdIndex(e.conn, { dir: proj, changedFrom: "HEAD", manifestPath: e.manifestPath })).rejects.toThrow(/--changed-from only makes sense with --incremental/);
      expect(await ids(e.conn, "Module")).toEqual([]);
    });
  });

  it("a run that dies while editing the graph leaves no state for that root, so the next run is full and rebuilds the state", async () => {
    await withEnv("crash", async (e) => {
      const proj = join(e.dir, "proj");
      writeTree(proj, TREE);
      await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      expect(readState(e.statePath)!.roots[resolve(proj)]).toBeDefined();

      rmSync(join(proj, "c.ts"));
      // a connection whose first write fails: the run is past the point where the state was dropped
      const dying = new Proxy(e.conn, {
        get(target, prop) {
          if (prop === "execute") return () => Promise.reject(new Error("disk full (simulated)"));
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      await expect(cmdIndex(dying, { dir: proj, incremental: true, manifestPath: e.manifestPath })).rejects.toThrow(/disk full/);
      expect(readState(e.statePath)?.roots[resolve(proj)]).toBeUndefined(); // not left describing a half-edited graph

      const r = await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      expect(inc(r).mode).toBe("full");
      expect(inc(r).reason).toContain("incremental");
      // The documented limit (incremental.ts, "Known limits"): a full index never prunes, so the
      // half-edited graph still holds c.ts. What matters is that the state is rebuilt from the sources
      // (a.ts, b.ts) and the run after this one is incremental again.
      expect(await ids(e.conn, "Module")).toEqual(["a.ts", "b.ts", "c.ts"]);
      expect(Object.keys(readState(e.statePath)!.roots[resolve(proj)]!.files).sort()).toEqual(["a.ts", "b.ts"]);
      expect(inc(await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath })).mode).toBe("incremental");
    });
  });

  it("an unchanged file whose directory is a symlink to the same tree keeps its ids (the same root spelled two ways)", async () => {
    await withEnv("symlink-root", async (e) => {
      const proj = join(e.dir, "proj");
      const link = join(e.dir, "link");
      writeTree(proj, TREE);
      symlinkSync(proj, link, "dir");
      await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      const r = await cmdIndex(e.conn, { dir: link, incremental: true, manifestPath: e.manifestPath });
      // two spellings, one directory: nothing is qualified and no second Module appears
      expect(r.rootQualifiedIds).toBeUndefined();
      expect(await ids(e.conn, "Module")).toEqual(["a.ts", "b.ts", "c.ts"]);
    });
  });
});

describe("cmdIndex --incremental --changed-from, in-process (XSPEC-508 R6)", () => {
  function repo(e: Env): string {
    const proj = join(e.dir, "proj");
    writeTree(proj, TREE);
    git(proj, "init", "-q");
    git(proj, "add", "-A");
    git(proj, "commit", "-q", "-m", "base");
    return proj;
  }

  it("takes the changed list from git: the edited file is re-parsed, a new untracked file is added, and unlisted files are reused unhashed", async () => {
    await withEnv("git-listed", async (e) => {
      const proj = repo(e);
      await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });

      writeFileSync(join(proj, "a.ts"), "export function foo() { return helper(); }\nexport function helper() { return 2; }\nexport function extra() { return 3; }\n");
      writeFileSync(join(proj, "n.ts"), "export function brandNew() { return 1; }\n");
      const r = await cmdIndex(e.conn, { dir: proj, incremental: true, changedFrom: "HEAD", manifestPath: e.manifestPath });

      expect(inc(r)).toMatchObject({ mode: "incremental", changedFrom: "HEAD", reparsed: 2, changed: 1, added: 1, reused: 2 });
      expect(await ids(e.conn, "Function")).toContain("a.ts#extra");
      expect(await ids(e.conn, "Function")).toContain("n.ts#brandNew");
    });
  });

  it("trusts git over the content: an edit git does not list (committed already) is NOT re-parsed - the statement the caller made", async () => {
    await withEnv("git-trusted", async (e) => {
      const proj = repo(e);
      await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });

      writeFileSync(join(proj, "a.ts"), "export function foo() { return helper(); }\nexport function helper() { return 1; }\nexport function extra() { return 3; }\n");
      git(proj, "add", "-A");
      git(proj, "commit", "-q", "-m", "edit");
      const r = await cmdIndex(e.conn, { dir: proj, incremental: true, changedFrom: "HEAD", manifestPath: e.manifestPath });

      expect(inc(r)).toMatchObject({ mode: "incremental", reparsed: 0, reused: 3 });
      expect(await ids(e.conn, "Function")).not.toContain("a.ts#extra");
      // without --changed-from the same tree is seen by content
      const r2 = await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      expect(inc(r2)).toMatchObject({ reparsed: 1, changed: 1 });
      expect(await ids(e.conn, "Function")).toContain("a.ts#extra");
    });
  });

  it("a ref git cannot resolve fails the run before the graph is edited, and leaves no state for the root", async () => {
    await withEnv("git-badref", async (e) => {
      const proj = repo(e);
      await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      await expect(cmdIndex(e.conn, { dir: proj, incremental: true, changedFrom: "no-such-ref", manifestPath: e.manifestPath })).rejects.toThrow(/--changed-from no-such-ref: git diff failed/);
      expect(await ids(e.conn, "Module")).toEqual(["a.ts", "b.ts", "c.ts"]);
    });
  });
});

describe("two roots of one graph, in-process (XSPEC-508 R6)", () => {
  const ROOT_A = { "src/index.ts": "export function boot() { return 1; }\n" };
  const ROOT_B = { "src/index.ts": "export function boot() { return 2; }\nexport function other() { return boot(); }\n" };

  it("the second root's colliding file gets a root-qualified id, and both files keep their own functions", async () => {
    await withEnv("tworoots", async (e) => {
      const a = join(e.dir, "alpha", "pkg");
      const b = join(e.dir, "beta", "pkg");
      writeTree(a, ROOT_A);
      writeTree(b, ROOT_B);
      await cmdIndex(e.conn, { dir: a, incremental: true, manifestPath: e.manifestPath });
      const r = await cmdIndex(e.conn, { dir: b, incremental: true, manifestPath: e.manifestPath });

      expect(r.rootQualifiedIds).toMatchObject({ label: "beta/pkg", files: 1 });
      expect(r.rootQualifiedIds!.examples).toEqual([{ path: "src/index.ts", id: "beta/pkg/src/index.ts" }]);
      expect(await ids(e.conn, "Module")).toEqual(["beta/pkg/src/index.ts", "src/index.ts"]);
      expect(await ids(e.conn, "Function")).toEqual(["beta/pkg/src/index.ts#boot", "beta/pkg/src/index.ts#other", "src/index.ts#boot"]);
      expect(await calls(e.conn)).toEqual(["beta/pkg/src/index.ts#other -> beta/pkg/src/index.ts#boot"]);
      expect(readManifest(e.manifestPath)!.runs[resolve(b)]!.rootLabel).toBe("beta/pkg");
    });
  });

  it("an incremental run of one root keeps the other root's remembered facts, and deleting its colliding file does not reach the other root's", async () => {
    await withEnv("tworoots-keep", async (e) => {
      const a = join(e.dir, "alpha", "pkg");
      const b = join(e.dir, "beta", "pkg");
      writeTree(a, ROOT_A);
      writeTree(b, ROOT_B);
      await cmdIndex(e.conn, { dir: a, incremental: true, manifestPath: e.manifestPath });
      await cmdIndex(e.conn, { dir: b, incremental: true, manifestPath: e.manifestPath });

      writeTree(b, { "src/more.ts": "export function more() { return 1; }\n" });
      rmSync(join(b, "src/index.ts"));
      const r = await cmdIndex(e.conn, { dir: b, incremental: true, manifestPath: e.manifestPath });

      expect(inc(r)).toMatchObject({ mode: "incremental", added: 1, removed: 1 });
      expect(await ids(e.conn, "Module")).toEqual(["src/index.ts", "src/more.ts"]);
      expect(await ids(e.conn, "Function")).toEqual(["src/index.ts#boot", "src/more.ts#more"]);
      // root A's section of the state is still there, so root A can be run incrementally next
      const roots = readState(e.statePath)!.roots;
      expect(Object.keys(roots).sort()).toEqual([resolve(a), resolve(b)].sort());
      expect(Object.keys(roots[resolve(a)]!.files)).toEqual(["src/index.ts"]);
      const ra = await cmdIndex(e.conn, { dir: a, incremental: true, manifestPath: e.manifestPath });
      expect(inc(ra)).toMatchObject({ mode: "incremental", reparsed: 0, reused: 1 });
    });
  });

  it("--scip is refused for a root whose files carry root-qualified ids, before anything is written for it", async () => {
    await withEnv("tworoots-scip", async (e) => {
      const a = join(e.dir, "alpha", "pkg");
      const b = join(e.dir, "beta", "pkg");
      writeTree(a, ROOT_A);
      writeTree(b, ROOT_B);
      await cmdIndex(e.conn, { dir: a, manifestPath: e.manifestPath });
      await expect(cmdIndex(e.conn, { dir: b, scip: join(e.dir, "x.scip"), manifestPath: e.manifestPath })).rejects.toThrow(/--scip cannot be combined with this root: 1 of its files share a relative path/);
      expect(await ids(e.conn, "Module")).toEqual(["src/index.ts"]);
    });
  });

  it("a graph an older egr built (both roots hold the same plain id) is reported as shared and --incremental indexes in full, saying to rebuild", async () => {
    await withEnv("legacy-shared", async (e) => {
      const a = join(e.dir, "alpha", "pkg");
      const b = join(e.dir, "beta", "pkg");
      writeTree(a, ROOT_A);
      writeTree(b, ROOT_B);
      const health = (path: string) => ({ path, language: "typescript", errorNodes: 0, functions: 1, classes: 0 });
      // what an older egr wrote: both sections list `src/index.ts` with no separate id
      const legacy = {
        egrVersion: "0.0.1",
        grammarVersions: {},
        runs: {
          [resolve(a)]: { indexedAt: "2026-01-01T00:00:00.000Z", files: [health("src/index.ts")] },
          [resolve(b)]: { indexedAt: "2026-01-01T00:00:00.000Z", files: [health("src/index.ts")] },
        },
      } as unknown as ParseManifest;
      writeFileSync(e.manifestPath, JSON.stringify(legacy));

      const r = await cmdIndex(e.conn, { dir: b, incremental: true, manifestPath: e.manifestPath });
      expect(inc(r).mode).toBe("full");
      expect(inc(r).reason).toMatch(/1 node\(s\) of this root \(e\.g\. src\/index\.ts\) are also held by another root/);
      expect(inc(r).reason).toContain("--clean");
      expect(r.sharedNodes).toMatchObject({ count: 1 });
      expect(r.sharedNodes!.examples[0]).toMatchObject({ id: "src/index.ts", otherRoot: resolve(a) });
    });
  });

  it("the MCP index_code record is not a root: a file listed there keeps its plain id when a root indexes it", async () => {
    await withEnv("mcp-record", async (e) => {
      const a = join(e.dir, "alpha", "pkg");
      writeTree(a, ROOT_A);
      const mcp = {
        egrVersion: "0.0.1",
        grammarVersions: {},
        runs: { [MCP_INDEX_ROOT]: { indexedAt: "2026-01-01T00:00:00.000Z", files: [{ path: "src/index.ts", language: "typescript", errorNodes: 0, functions: 1, classes: 0 }] } },
      } as unknown as ParseManifest;
      writeFileSync(e.manifestPath, JSON.stringify(mcp));
      const r = await cmdIndex(e.conn, { dir: a, incremental: true, manifestPath: e.manifestPath });
      expect(r.rootQualifiedIds).toBeUndefined();
      expect(r.sharedNodes).toBeUndefined();
      expect(await ids(e.conn, "Module")).toEqual(["src/index.ts"]);
    });
  });
});

describe("the state files stay out of the way (XSPEC-508 R6)", () => {
  it("leaves only the graph, the manifest and the state beside the graph: no temp file survives a successful run", async () => {
    await withEnv("tmpfiles", async (e) => {
      const proj = join(e.dir, "proj");
      writeTree(proj, TREE);
      await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      await cmdIndex(e.conn, { dir: proj, incremental: true, manifestPath: e.manifestPath });
      const left = readdirSync(join(e.dir, "g")).filter((n) => n.endsWith(".tmp"));
      expect(left).toEqual([]);
      expect(existsSync(e.statePath)).toBe(true);
    });
  });
});
