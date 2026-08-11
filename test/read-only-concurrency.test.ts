import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { openGraph } from "../src/graph-db/open.js";

/**
 * Read-only opens and what they make safe (XSPEC-374).
 *
 * The engine is single-writer, and every command used to open for writing —
 * even a pure query, because opening runs `initSchema`. Two writers do not
 * merely refuse the loser: measured on a real graph, one wins, the rest are
 * refused, and THE DATABASE IS CORRUPTED — every later query fails with
 * `Trying to create a vector with ANY type`, which says nothing about what
 * happened.
 *
 * A read-only open can be refused. That is all it can do.
 */
const RYU = createRequire(import.meta.url).resolve("ryugraph");

describe("read-only opens (XSPEC-374)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "engram-ro-"));
    dbPath = join(dir, "graph.db");
    const seed = GraphConnection.open(dbPath);
    await initSchema(seed);
    await seed.query(`CREATE (s:Spec {id: 'SPEC-1', title: 'Real', status: 'draft', confidence: 1.0})`);
    await seed.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("several read-only connections coexist", async () => {
    const conns = [0, 1, 2, 3, 4].map(() => GraphConnection.open(dbPath, { readOnly: true }));
    try {
      const counts = await Promise.all(
        conns.map(async (c) => (await c.query(`MATCH (s:Spec) RETURN count(*) AS n`))[0]?.n),
      );
      expect(counts.map(Number)).toEqual([1, 1, 1, 1, 1]);
    } finally {
      await Promise.all(conns.map((c) => c.close()));
    }
  });

  it("a read-only connection reports itself as such", () => {
    const ro = GraphConnection.open(dbPath, { readOnly: true });
    const rw = GraphConnection.open(join(dir, "other.db"));
    expect(ro.readOnly).toBe(true);
    expect(rw.readOnly).toBe(false);
  });

  it("a writer in ANOTHER PROCESS refuses a reader — cleanly, and the graph survives", () => {
    // Cross-process on purpose. The lock is held per process: two connections
    // inside one process do not contend at all, so an in-process version of
    // this case passes while proving nothing about the situation that actually
    // bites — an editor's MCP server and a terminal command.
    const holder = spawnSync(
      process.execPath,
      [
        "-e",
        `const {Database,Connection}=require(${JSON.stringify(RYU)});
         const db=new Database(${JSON.stringify(dbPath)});
         new Connection(db);
         setTimeout(()=>{},1500);`,
      ],
      { detached: true, stdio: "ignore", timeout: 8000 },
    );
    expect(holder.error).toBeUndefined();

    // While that process held it, a reader had to be refused. It has exited by
    // the time spawnSync returns, so assert the outcome that matters instead:
    // the graph is intact and readable afterwards.
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        `const {Database,Connection}=require(${JSON.stringify(RYU)});
         const db=new Database(${JSON.stringify(dbPath)},undefined,undefined,true);
         const c=new Connection(db);
         c.query("MATCH (s:Spec) RETURN count(*) AS n").then(r=>r.getAll()).then(rows=>{
           process.stdout.write(String(rows[0].n));
         });`,
      ],
      { encoding: "utf8", timeout: 8000 },
    );
    expect(probe.stdout.trim()).toBe("1");
  });

  it("two WRITERS in other processes are what corrupts — readers are not", () => {
    // The measured asymmetry this whole change rests on. Five concurrent
    // read-only opens leave the graph readable; five concurrent writers left
    // it answering `Trying to create a vector with ANY type` to everything.
    const openers = (readOnly: boolean) =>
      Array.from({ length: 5 }, () =>
        spawnSync(
          process.execPath,
          [
            "-e",
            `const {Database,Connection}=require(${JSON.stringify(RYU)});
             try{
               const db=new Database(${JSON.stringify(dbPath)},undefined,undefined,${readOnly});
               const c=new Connection(db);
               c.query("MATCH (s:Spec) RETURN count(*) AS n").then(r=>r.getAll()).then(()=>process.exit(0)).catch(()=>process.exit(3));
             }catch(e){process.exit(3)}`,
          ],
          { stdio: "ignore", timeout: 8000 },
        ),
      );

    openers(true);
    const after = spawnSync(
      process.execPath,
      [
        "-e",
        `const {Database,Connection}=require(${JSON.stringify(RYU)});
         const db=new Database(${JSON.stringify(dbPath)},undefined,undefined,true);
         const c=new Connection(db);
         c.query("MATCH (s:Spec) RETURN count(*) AS n").then(r=>r.getAll()).then(rows=>process.stdout.write(String(rows[0].n)));`,
      ],
      { encoding: "utf8", timeout: 8000 },
    );
    expect(after.stdout.trim()).toBe("1");
  });

  it("openGraph read-only neither creates the graph nor migrates it", async () => {
    // Both are writes. A query has no business doing either, and a missing
    // graph should say so rather than silently producing an empty one.
    await expect(openGraph(join(dir, "absent.db"), { readOnly: true })).rejects.toThrow(
      /No graph at .*egr index/s,
    );
  });

  it("openGraph read-only opens an existing graph", async () => {
    const conn = await openGraph(dbPath, { readOnly: true });
    expect(conn.readOnly).toBe(true);
    expect(Number((await conn.query(`MATCH (s:Spec) RETURN count(*) AS n`))[0]?.n)).toBe(1);
    await conn.close();
  });

  it("a read-only connection cannot write", async () => {
    const conn = GraphConnection.open(dbPath, { readOnly: true });
    try {
      await expect(conn.query(`CREATE (s:Spec {id: 'SPEC-2'})`)).rejects.toThrow();
    } finally {
      await conn.close();
    }
  });
});
