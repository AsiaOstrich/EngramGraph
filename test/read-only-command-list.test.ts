import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { READ_ONLY_COMMANDS } from "../src/cli/read-only-commands.js";
import {
  cmdCallers,
  cmdCallees,
  cmdImplementers,
  cmdImplementedSpecs,
  cmdImpact,
  cmdTop,
  cmdBlindspots,
  cmdSignatures,
} from "../src/cli/run.js";

/**
 * Every command claiming to be read-only, executed on a read-only connection
 * (XSPEC-374).
 *
 * The list is written by hand — a command's arguments cannot be derived from
 * its name — and the first draft got three of eleven wrong. `god-nodes`,
 * `communities` and `related` install the algo extension and build a projected
 * graph before they can rank anything; all three are writes, and all three were
 * declared read-only.
 *
 * It shipped green. `related` returns early when the seed id is absent, and
 * every case I wrote used an absent id, so the write path was never reached.
 * It failed the first time a real node was passed to it — on the very spec
 * documenting this work, which is the only reason it was found before release.
 *
 * Hence two properties here, and the second is the one that matters:
 *
 *   1. Every command runs against a read-only connection without raising
 *      `Cannot execute write operations in a read-only database`.
 *   2. Every command runs against DATA THAT EXISTS, asserted non-empty. A
 *      query that returns early is a query whose write path was not tested,
 *      and that is exactly how the defect survived.
 *
 * The mapping is checked against `READ_ONLY_COMMANDS` itself rather than a
 * second hand-written list, so a command added there without a case here fails
 * rather than passing silently.
 */
describe("read-only command list (XSPEC-374)", () => {
  let dir: string;
  let dbPath: string;
  let manifestPath: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "engram-rocmd-"));
    dbPath = join(dir, "graph.db");
    manifestPath = join(dir, "parse-manifest.json");

    const seed = GraphConnection.open(dbPath);
    await initSchema(seed);
    // A neighbourhood every command below can actually hit. Empty results were
    // what hid the defect, so each case asserts it found something.
    await seed.query(
      `CREATE (s:Spec {id: 'SPEC-1', title: 'Real', status: 'draft', confidence: 0.9, origin: 'declared'})`,
    );
    await seed.query(`CREATE (m:Module {id: 'src/a.ts', path: 'src/a.ts'})`);
    await seed.query(`CREATE (f:Function {id: 'src/a.ts#alpha', name: 'alpha', confidence: 0.8})`);
    await seed.query(`CREATE (g:Function {id: 'src/a.ts#beta', name: 'beta', confidence: 0.7})`);
    await seed.query(
      `MATCH (f:Function {id: 'src/a.ts#alpha'}), (g:Function {id: 'src/a.ts#beta'})
       CREATE (f)-[:CALLS {confidence: 0.9}]->(g)`,
    );
    await seed.query(
      `MATCH (m:Module {id: 'src/a.ts'}), (s:Spec {id: 'SPEC-1'}) CREATE (m)-[:IMPLEMENTS]->(s)`,
    );
    // `impact` walks Decision-[:IMPACTS]->Spec, which the first version of this
    // fixture had no edge for — so the case returned an empty list and failed
    // its own non-empty assertion. Left as written rather than weakened: an
    // empty result is the condition under which the write path is skipped, and
    // weakening it here would rebuild the blind spot this file exists to close.
    await seed.query(
      `CREATE (d:Decision {id: 'DEC-1', title: 'A decision', date: '2026-08-11', confidence: 0.9, origin: 'declared'})`,
    );
    await seed.query(
      `MATCH (d:Decision {id: 'DEC-1'}), (s:Spec {id: 'SPEC-1'}) CREATE (d)-[:IMPACTS]->(s)`,
    );
    await seed.close();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * One case per read-only command. `nonEmpty` proves the query reached real
   * data — without it, a command that returns early looks identical to one
   * that never writes.
   */
  const CASES: Record<string, (conn: GraphConnection) => Promise<boolean>> = {
    callers: async (c) => (await cmdCallers(c, "beta")).length > 0,
    callees: async (c) => (await cmdCallees(c, "alpha")).length > 0,
    implementers: async (c) => (await cmdImplementers(c, "SPEC-1")).modules.length > 0,
    "implemented-by": async (c) => (await cmdImplementedSpecs(c, "src/a.ts")).specs.length > 0,
    impact: async (c) => (await cmdImpact(c, "SPEC-1")).decisions.length > 0,
    top: async (c) => (await cmdTop(c, "Function")).length > 0,
    // These two read a manifest file, never the graph — they cannot write by
    // construction. Present so the key-set assertion below covers the whole
    // list rather than the subset that happens to take a connection.
    blindspots: async () => cmdBlindspots(manifestPath) !== undefined,
    signatures: async () => cmdSignatures(manifestPath) !== undefined,
  };

  it("has a case for every declared read-only command, and no extras", () => {
    // Traverse the list itself. A command added to READ_ONLY_COMMANDS without
    // a case here fails now, instead of being declared read-only untested —
    // which is precisely what happened to `related`.
    expect(Object.keys(CASES).sort()).toEqual([...READ_ONLY_COMMANDS].sort());
  });

  it.each(Object.keys(CASES))("%s runs on a read-only connection and finds data", async (cmd) => {
    const conn = GraphConnection.open(dbPath, { readOnly: true });
    try {
      // The failure this exists to catch surfaces as a thrown error, not a
      // wrong answer: "Cannot execute write operations in a read-only
      // database!". Awaiting it here means a writing command fails loudly.
      const foundData = await CASES[cmd]!(conn);
      expect(foundData).toBe(true);
    } finally {
      await conn.close();
    }
  });

  it("excludes the three commands that write in order to read", async () => {
    // Regression pin with the reason attached: these rank nodes via the algo
    // extension, which must be INSTALLed, and a projected graph, which must be
    // CREATEd. Both are writes on a supposedly read-only path. If a future
    // change makes them projection-free they may join the list above — but
    // only by passing the case there, not by editing this expectation.
    for (const cmd of ["god-nodes", "communities", "related"]) {
      expect(READ_ONLY_COMMANDS.has(cmd)).toBe(false);
    }

    const { related } = await import("../src/structural-memory/query.js");
    const conn = GraphConnection.open(dbPath, { readOnly: true });
    try {
      // Seed present on purpose. With an absent id this resolves to `[]` and
      // proves nothing — the exact shape that let the defect ship.
      await expect(related(conn, "SPEC-1")).rejects.toThrow(/read-only/i);
    } finally {
      await conn.close();
    }
  });
});
