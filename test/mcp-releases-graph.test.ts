// implements XSPEC-457
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { GraphLease, GraphBusyError, isLockContention } from "../src/graph-db/lease.js";
import type { GraphConnection } from "../src/graph-db/connection.js";
import { buildEgr, REPO_ROOT, type BuiltEgr } from "./helpers/build-cli.js";

/**
 * XSPEC-457 R1 — an MCP server that is still running must not stand between a
 * terminal and the graph.
 *
 * Reproduced on macOS before any change (so this is not Windows-only): with one
 * `egr-mcp` process holding the graph read-only, `egr index`, `egr feedback`,
 * `egr god-nodes` and `egr related` all exited 1 with `Could not set lock on
 * file`. The engine locks at open, not at first write, so a reader held all day
 * refused every writer.
 *
 * The evidence below runs the REAL entry points as separate processes — the
 * built `egr-mcp` stdio server and the built `egr` CLI — through
 * `scripts/mcp-concurrency-verify.mjs`, the same script the Windows workflow
 * runs. In-process tests cannot show this: the lock is held per process, so two
 * connections inside one process never contend.
 */

let built: BuiltEgr;
let report: { total: number; failed: number; results: Array<{ name: string; ok: boolean; detail: string }> };
let scriptStatus: number | null;

beforeAll(() => {
  built = buildEgr();
  const jsonOut = join(mkdtempSync(join(tmpdir(), "egr-r1-")), "report.json");
  const run = spawnSync(
    process.execPath,
    [join(REPO_ROOT, "scripts", "mcp-concurrency-verify.mjs"), "--dist", built.distRel, "--json", jsonOut],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 240_000 },
  );
  scriptStatus = run.status;
  report = JSON.parse(readFileSync(jsonOut, "utf8"));
}, 300_000);

afterAll(() => built?.cleanup());

/** The named step's result — and its detail, so a failure says what the process printed. */
function step(prefix: string): { ok: boolean; detail: string } {
  const r = report.results.find((x) => x.name.startsWith(prefix));
  if (!r) throw new Error(`the verify script did not report a step "${prefix}": ${JSON.stringify(report.results.map((x) => x.name))}`);
  return r;
}

describe("XSPEC-457 R1: a running MCP server and terminal egr commands", () => {
  it("egr index succeeds while an MCP stdio server that has already answered a query is still running", () => {
    const s = step("3a.");
    expect(s.ok, s.detail).toBe(true);
  });

  it("egr feedback and egr god-nodes and egr related also succeed while that MCP server is running", () => {
    for (const p of ["3b.", "3c.", "3d."]) {
      const s = step(p);
      expect(s.ok, `${p} ${s.detail}`).toBe(true);
    }
  });

  it("the running MCP server then sees what the terminal indexed, with no restart", () => {
    const s = step("4.");
    expect(s.ok, s.detail).toBe(true);
  });

  it("while another process is writing, the MCP server answers that the graph is busy rather than an empty result, and answers again afterwards", () => {
    for (const p of ["5a.", "6."]) {
      const s = step(p);
      expect(s.ok, `${p} ${s.detail}`).toBe(true);
    }
  });

  it("the whole verify script passes", () => {
    expect(report.failed, JSON.stringify(report.results.filter((r) => !r.ok))).toBe(0);
    expect(scriptStatus).toBe(0);
  });
});

describe("XSPEC-457 R1: the refusal for a writing tool works on every platform", () => {
  it("index_code over stdio says to run egr index in a terminal and that this works while the server runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egr-r1-refuse-"));
    const dbPath = join(dir, "graph.db");
    const proj = join(dir, "p");
    mkdirSync(proj);
    writeFileSync(join(proj, "a.ts"), "export function a() { return 1; }\n");
    const env = { ...process.env, ENGRAM_DB: dbPath };
    const idx = spawnSync(process.execPath, [built.cli, "index", proj], { env, encoding: "utf8" });
    expect(idx.status, idx.stderr).toBe(0);

    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [built.mcp], env: env as Record<string, string>, stderr: "ignore" }));
    try {
      const res = (await client.callTool({ name: "index_code", arguments: { files: [{ path: "x.ts", source: "export function x(){}" }] } })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      const text = res.content[0]!.text;
      expect(res.isError).toBe(true);
      expect(text).toContain("egr index <dir>");
      expect(text).toMatch(/works while this server is running/);
      // The old wording promised "queries here and egr commands in a terminal can run at the same time"
      // as the reason — which was false on Windows for as long as the server stayed open.
      expect(text).not.toMatch(/holds the graph read-only so that/);
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("XSPEC-457 R1: egr leaves nothing for the next open to replay", () => {
  it("a write command folds the write-ahead log into the database file before it exits", () => {
    // MCP now opens the graph once per query. A log left unfolded is replayed on every open:
    // measured 245 ms per query on a 4 MB log against 49 ms once folded (2.3k functions).
    const dir = mkdtempSync(join(tmpdir(), "egr-r1-wal-"));
    try {
      const proj = join(dir, "p");
      mkdirSync(proj);
      for (let i = 0; i < 30; i++) writeFileSync(join(proj, `f${i}.ts`), `export function fn${i}() { return ${i}; }\n`);
      const dbPath = join(dir, "graph.db");
      const r = spawnSync(process.execPath, [built.cli, "index", proj], { env: { ...process.env, ENGRAM_DB: dbPath }, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      expect(statSync(dbPath).size, "the database file holds the data").toBeGreaterThan(4096);
      const wal = `${dbPath}.wal`;
      expect(!existsSync(wal) || statSync(wal).size === 0, `${wal} still holds ${existsSync(wal) ? statSync(wal).size : 0} bytes`).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GraphLease (XSPEC-457 R1)", () => {
  /** A fake connection factory that counts opens and closes and refuses the first `refusals` opens. */
  function fakeOpen(refusals = 0) {
    const state = { opens: 0, closes: 0, live: 0, maxLive: 0, attempts: 0 };
    const open = async (): Promise<GraphConnection> => {
      state.attempts += 1;
      if (state.attempts <= refusals) throw new Error("IO exception: Could not set lock on file : /x/graph.db");
      state.opens += 1;
      state.live += 1;
      state.maxLive = Math.max(state.maxLive, state.live);
      return {
        close: async () => {
          await new Promise((r) => setTimeout(r, 5));
          state.closes += 1;
          state.live -= 1;
        },
      } as unknown as GraphConnection;
    };
    return { state, open };
  }

  it("holds nothing between uses: the connection is closed as soon as the last user is done", async () => {
    const { state, open } = fakeOpen();
    const lease = new GraphLease("/x/graph.db", { open });
    await lease.use(async () => "a");
    expect(lease.isOpen).toBe(false);
    expect(state).toMatchObject({ opens: 1, closes: 1, live: 0 });
    await lease.use(async () => "b");
    expect(state).toMatchObject({ opens: 2, closes: 2, live: 0 });
  });

  it("overlapping uses share one open and two opens never coexist", async () => {
    // Eight overlapping opens of one file in one process died with `Mmap … failed`
    // (measured), so the lease must serialise open/close around the shared connection.
    const { state, open } = fakeOpen();
    const lease = new GraphLease("/x/graph.db", { open });
    await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        await new Promise((r) => setTimeout(r, i));
        return lease.use(async () => new Promise((r) => setTimeout(r, 20)));
      }),
    );
    await Promise.all(Array.from({ length: 8 }, () => lease.use(async () => undefined)));
    expect(state.maxLive).toBe(1);
    expect(state.live).toBe(0);
    expect(state.closes).toBe(state.opens);
  });

  it("retries a refused open and succeeds once the writer is gone", async () => {
    const { state, open } = fakeOpen(3);
    const lease = new GraphLease("/x/graph.db", { open, lockWaitMs: 5_000, sleep: async () => undefined });
    await expect(lease.use(async () => "ok")).resolves.toBe("ok");
    expect(state.attempts).toBe(4);
  });

  it("gives up with an error that says the graph is busy — never a result — when the writer stays", async () => {
    const { open } = fakeOpen(Number.MAX_SAFE_INTEGER);
    let clock = 0;
    const realNow = Date.now;
    Date.now = () => clock;
    try {
      const lease = new GraphLease("/x/graph.db", { open, lockWaitMs: 1_000, sleep: async (ms) => void (clock += ms) });
      const err = await lease.use(async () => "never").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GraphBusyError);
      expect((err as Error).message).toMatch(/being written by another process/);
      expect((err as Error).message).toMatch(/not an empty result/);
      expect(lease.isOpen).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it("does not retry an error that is not a lock refusal", async () => {
    let attempts = 0;
    const lease = new GraphLease("/x/graph.db", {
      open: async () => {
        attempts += 1;
        throw new Error("No graph at /x/graph.db. Read-only commands cannot create one — run `egr index <dir>` first.");
      },
      sleep: async () => undefined,
    });
    await expect(lease.use(async () => 1)).rejects.toThrow(/No graph at/);
    expect(attempts).toBe(1);
  });

  it("recognises the engine's lock refusal text", () => {
    expect(isLockContention(new Error("IO exception: Could not set lock on file : C:\\g\\graph.db"))).toBe(true);
    expect(isLockContention(new Error("Binder exception: nope"))).toBe(false);
  });
});
