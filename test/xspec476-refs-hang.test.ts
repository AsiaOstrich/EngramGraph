// implements XSPEC-476
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * The `egr refs check` hang found in CI (runs 38198642143 and 38210190999).
 *
 * Root cause: `refs check` looks a symbol up with TWO queries at once —
 * `Promise.all([functionLocations(…), classLocations(…)])` — on ONE connection,
 * and the engine does not survive two statements in flight on one connection.
 * About one process in twenty (4.4 % in 480 runs of exactly that pair, 0 in 960
 * runs that issued the same two queries one after the other) dies with SIGSEGV
 * or never answers; a CLI child that never answered is what CI reported as
 * "did not finish … ETIMEDOUT after 90084 ms, stdout 0 chars".
 *
 * `GraphConnection.query` now runs one statement at a time, whoever calls it.
 */

let built: BuiltEgr;
let work: string;

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-476-hang-"));
}, 120_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

describe("XSPEC-476: one statement in flight per connection", () => {
  it("queries issued together reach the engine one at a time, in the order they were issued [xspec476-hang-serialised]", async () => {
    const conn = GraphConnection.open(join(work, "serial.db"));
    await initSchema(conn);
    // Watch the engine's own entry points (`raw` is the object the wrapper calls into).
    const raw = conn.raw as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    let inFlight = 0;
    let maxInFlight = 0;
    const started: string[] = [];
    for (const name of ["query", "execute"] as const) {
      const original = raw[name]!.bind(raw);
      raw[name] = async (...args: unknown[]) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        started.push(String(args[0] && typeof args[0] === "string" ? args[0] : name));
        try {
          return await original(...args);
        } finally {
          inFlight--;
        }
      };
    }

    const sql = (i: number) => `MATCH (f:Function) WHERE f.start_line = ${i} RETURN f.id AS id`;
    const results = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((i) => conn.query(sql(i))));

    expect(results).toHaveLength(8);
    expect(maxInFlight).toBe(1);
    expect(started.filter((s) => s.startsWith("MATCH"))).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(sql));

    // A failing statement does not wedge the ones behind it.
    await expect(conn.query("THIS IS NOT CYPHER")).rejects.toThrow();
    expect(await conn.query("RETURN 1 AS ok")).toEqual([{ ok: 1 }]);
    await conn.close();
  });

  it("`egr refs check` on a symbol that is in the graph completes every time it is run [xspec476-hang-cli-symbol]", () => {
    const repo = join(work, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "lib.ts"), "export function realFn() { return 2; }\n");
    const db = join(work, "cli.db");
    const env = { ...process.env, ENGRAM_DB: db };
    const idx = runEgr(built.cli, ["index", repo], { env, cwd: work });
    expect(idx.status, idx.stderr).toBe(0);
    const note = join(work, "note.md");
    writeFileSync(note, "- the function: `realFn()`\n");

    // The crash is probabilistic (about 1 run in 20 on Linux before the fix), so the
    // test runs the command enough times that an unfixed build fails it most of the time.
    // A fixed build never fails it.
    const RUNS = 40;
    for (let i = 0; i < RUNS; i++) {
      const r = runEgr(built.cli, ["refs", "check", note, "--json"], { env, cwd: work, timeoutMs: 30_000 });
      expect(r.status, `run ${i}: ${r.stderr}`).toBe(0);
      expect((JSON.parse(r.stdout) as { items: Array<{ status: string }> }).items[0]!.status).toBe("present");
    }
  }, 180_000);
});
