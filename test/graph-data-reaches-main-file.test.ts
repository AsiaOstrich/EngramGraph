import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { GraphConnection } from "../src/graph-db/connection.js";
import { checkpointOrWarn } from "../src/graph-db/checkpoint.js";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * The graph must live in `graph.db`, not only in `graph.db.wal` (risk
 * egr-graph-lives-only-in-wal; measured 2026-08-13: a 4096-byte `graph.db` that
 * opened alone with "Table does not exist", and an 11.9 MB `.wal` that was the whole graph — delete
 * the `.wal` and the graph is gone, copy `graph.db` alone to back it up and the
 * backup is empty).
 *
 * "Lives in the main file" is checked the way a backup would use it: copy ONLY `graph.db`
 * (no `.wal`) to another directory, open the copy, and read the data back. Looking at the
 * size of the `.wal` is not that check — it says nothing about what the main file holds.
 *
 * Every `it` builds its own tree and graph and starts its own processes, so any one can run alone.
 * The CLI, `egr serve` and `egr-mcp` are the built entry points, run as child processes.
 */

let built: BuiltEgr;
let scratch: string;

beforeAll(() => {
  built = buildEgr();
  scratch = mkdtempSync(join(tmpdir(), "egr-wal-"));
});

afterAll(() => {
  built?.cleanup();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const N_FILES = 12;

/** A tree of `N_FILES` files with one exported function each. */
function makeTree(name: string): { dir: string; proj: string; db: string } {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  const proj = join(dir, "proj");
  mkdirSync(proj);
  for (let i = 0; i < N_FILES; i++) writeFileSync(join(proj, `f${i}.ts`), `export function fn${i}() { return ${i}; }\n`);
  return { dir, proj, db: join(dir, "graph.db") };
}

function egr(db: string, cwd: string, args: string[]) {
  return runEgr(built.cli, args, { env: { ...process.env, ENGRAM_DB: db }, cwd });
}

/** Copy ONLY the main file of `db` into a fresh directory and return the copy's path. */
function copyMainFileOnly(db: string, dir: string): string {
  const where = mkdtempSync(join(dir, "copy-"));
  const copy = join(where, "graph.db");
  copyFileSync(db, copy);
  expect(existsSync(`${copy}.wal`), "the copy must not bring a .wal with it").toBe(false);
  return copy;
}

async function readFrom<T>(copy: string, cypher: string, pick: (row: Record<string, unknown>) => T): Promise<T> {
  const conn = GraphConnection.open(copy, { readOnly: true });
  try {
    const rows = await conn.query(cypher);
    return pick(rows[0] ?? {});
  } finally {
    await conn.close();
  }
}

const countFunctions = (copy: string) => readFrom(copy, "MATCH (f:Function) RETURN count(f) AS c", (r) => Number(r.c));

describe("a write command leaves the data in the main file", () => {
  it("egr index: a copy of graph.db alone, without graph.db.wal, holds every indexed function", async () => {
    const t = makeTree("index");
    const r = egr(t.db, t.proj, ["index", t.proj, "--json"]);
    expect(r.status, r.stderr).toBe(0);
    const indexed = (JSON.parse(r.stdout) as { code: { functions: number } }).code.functions;
    expect(indexed).toBe(N_FILES);

    const copy = copyMainFileOnly(t.db, t.dir);
    expect(await countFunctions(copy)).toBe(indexed);
  }, 60_000);

  it("egr index that fails after it has written: what it had written is in the main file too", async () => {
    // The code pass is written before `--scip` is read; a missing .scip file ends the command with exit 1.
    const t = makeTree("index-fails");
    const r = egr(t.db, t.proj, ["index", t.proj, "--scip", join(t.dir, "no-such.scip")]);
    expect(r.status, "the command must still fail").toBe(1);
    expect(r.stderr).toMatch(/--scip: file not found/);

    const copy = copyMainFileOnly(t.db, t.dir);
    expect(await countFunctions(copy)).toBe(N_FILES);
  }, 60_000);

  it("egr feedback (a different write command) reaches the main file as well", async () => {
    const t = makeTree("feedback");
    expect(egr(t.db, t.proj, ["index", t.proj]).status).toBe(0);
    const before = await readFrom(copyMainFileOnly(t.db, t.dir), "MATCH (f:Function {name: 'fn3'}) RETURN f.id AS id, f.confidence AS c", (r) => ({ id: String(r.id), c: Number(r.c) }));
    const fb = egr(t.db, t.proj, ["feedback", "test_fail", before.id]);
    expect(fb.status, fb.stderr).toBe(0);

    const after = await readFrom(copyMainFileOnly(t.db, t.dir), `MATCH (f:Function {id: '${before.id}'}) RETURN f.confidence AS c`, (r) => Number(r.c));
    expect(after, "the lowered confidence is in the main file").toBeLessThan(before.c);
  }, 60_000);
});

/** A free TCP port: listen on 0, read it, close. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

describe("egr serve (a writer that runs until it is stopped)", () => {
  it("SIGTERM after a REST write: the write is in the main file once the process has ended", async () => {
    const t = makeTree("serve");
    expect(egr(t.db, t.proj, ["index", t.proj]).status).toBe(0);
    const row = await readFrom(copyMainFileOnly(t.db, t.dir), "MATCH (f:Function {name: 'fn5'}) RETURN f.id AS id, f.confidence AS c", (r) => ({ id: String(r.id), c: Number(r.c) }));

    const port = await freePort();
    const child: ChildProcess = spawn(process.execPath, [built.cli, "serve", "--port", String(port)], {
      env: { ...process.env, ENGRAM_DB: t.db },
      cwd: t.proj,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr += String(d)));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.once("exit", (code, signal) => res({ code, signal })));
    try {
      await new Promise<void>((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`serve did not start: ${stderr}`)), 30_000);
        child.stdout!.on("data", (d) => {
          if (String(d).includes("EngramGraph REST on")) {
            clearTimeout(timer);
            res();
          }
        });
        child.once("exit", (code) => rej(new Error(`serve exited ${code} before it listened: ${stderr}`)));
      });

      const post = await fetch(`http://127.0.0.1:${port}/graph/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "test_fail", functionId: row.id }),
      });
      expect(post.status, await post.clone().text()).toBe(200);

      child.kill("SIGTERM");
      const end = await Promise.race([exited, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`serve did not stop after SIGTERM: ${stderr}`)), 30_000))]);
      expect(end.code, `serve should end itself cleanly (signal ${end.signal}): ${stderr}`).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }

    const after = await readFrom(copyMainFileOnly(t.db, t.dir), `MATCH (f:Function {id: '${row.id}'}) RETURN f.confidence AS c`, (r) => Number(r.c));
    expect(after, "the REST write is in the main file").toBeLessThan(row.c);
  }, 90_000);
});

describe("egr-mcp (read-only; holds the graph only while a query runs)", () => {
  it("answers a query, is stopped with SIGTERM, and leaves nothing behind: no .wal, the main file already holds the data, and a terminal writer works at once", async () => {
    // There is nothing for the MCP server to CHECKPOINT: it opens read-only per query
    // (XSPEC-457 R1) and a read-only connection cannot write. What matters at its shutdown is
    // the other half: it must not leave a log or a lock. This test pins that; it has no
    // "cut the checkpoint call" mutation because the server has no such call.
    const t = makeTree("mcp");
    expect(egr(t.db, t.proj, ["index", t.proj]).status).toBe(0);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [built.mcp],
      env: { ...process.env, ENGRAM_DB: t.db } as Record<string, string>,
      stderr: "ignore",
    });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(transport);
    try {
      const res = (await client.callTool({ name: "call_chain", arguments: { symbol: "fn2", direction: "both" } })) as { isError?: boolean };
      expect(res.isError, JSON.stringify(res)).not.toBe(true);
    } finally {
      await client.close(); // closes stdin, then ends the process (SIGTERM if it lingers)
    }

    const wal = `${t.db}.wal`;
    expect(!existsSync(wal) || statSync(wal).size === 0, `${wal} was left behind`).toBe(true);
    expect(await countFunctions(copyMainFileOnly(t.db, t.dir))).toBe(N_FILES);
    const again = egr(t.db, t.proj, ["index", t.proj]);
    expect(again.status, `a terminal writer right after the MCP server ended: ${again.stderr}`).toBe(0);
  }, 90_000);
});

describe("CHECKPOINT that fails after the command has done its work", () => {
  function conn(execute: (cypher: string) => Promise<void>): GraphConnection {
    return { readOnly: false, execute } as unknown as GraphConnection;
  }

  it("a failure that is not a lock refusal is a warning on stderr; the command's own result stands", async () => {
    const warnings: string[] = [];
    await expect(
      checkpointOrWarn(
        conn(async () => {
          throw new Error("IO exception: No space left on device");
        }),
        (m) => warnings.push(m),
      ),
    ).resolves.toBeUndefined();
    expect(warnings.join("")).toMatch(/warning: could not fold the write-ahead log into graph\.db/);
    expect(warnings.join("")).toMatch(/No space left on device/);
  });

  it("a lock refusal still fails the command (XSPEC-457 R2: that is how a command that never touched the file learns it did not hold the lock)", async () => {
    await expect(
      checkpointOrWarn(
        conn(async () => {
          throw new Error("IO exception: Could not set lock on file : /x/graph.db");
        }),
        () => undefined,
      ),
    ).rejects.toThrow(/Could not set lock/);
  });

  it("a read-only connection is not asked to CHECKPOINT", async () => {
    let asked = false;
    await checkpointOrWarn({ readOnly: true, execute: async () => void (asked = true) } as unknown as GraphConnection, () => undefined);
    expect(asked).toBe(false);
  });
});
