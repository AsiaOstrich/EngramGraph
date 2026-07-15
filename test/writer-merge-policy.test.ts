import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { writeFragment } from "../src/graph-db/writer.js";
import type { GraphFragment } from "../src/graph-db/types.js";

/**
 * XSPEC-333 R1: provenance-aware overwrite policy.
 *
 * A node/edge whose properties carry `provider` (+ optionally `confidence`)
 * may only be overwritten by a later write when either the provider matches
 * (a normal re-index) or the new write is a different provider with
 * strictly higher confidence. Equal-or-lower confidence from a different
 * provider must be a no-op — see src/graph-db/writer.ts for the full policy
 * writeup.
 */
describe("writer overwrite policy (XSPEC-333 R1)", () => {
  let dir: string;
  let conn: GraphConnection;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "engram-writer-test-"));
    conn = GraphConnection.open(join(dir, "graph.db"));
    await initSchema(conn);
  });

  afterEach(async () => {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function readFunction(id: string) {
    const rows = await conn.query(
      `MATCH (n:Function {id: $id}) RETURN n.name AS name, n.confidence AS confidence, n.provider AS provider`,
      { id },
    );
    return rows[0] as { name: string; confidence: number; provider: string } | undefined;
  }

  function functionFragment(props: {
    name: string;
    confidence: number;
    provider: string;
  }): GraphFragment {
    return {
      nodes: [
        {
          label: "Function",
          id: "f1",
          properties: {
            name: props.name,
            file: "a.ts",
            start_line: 1,
            confidence: props.confidence,
            provider: props.provider,
          },
        },
      ],
      edges: [],
    };
  }

  it("same provider always overwrites, regardless of confidence delta", async () => {
    await writeFragment(conn, functionFragment({ name: "v1", confidence: 0.9, provider: "tree-sitter" }));
    // Re-index by the same provider with a *lower* confidence must still win
    // — it's the authoritative source updating its own prior write.
    await writeFragment(conn, functionFragment({ name: "v2", confidence: 0.1, provider: "tree-sitter" }));

    const row = await readFunction("f1");
    expect(row).toEqual({ name: "v2", confidence: 0.1, provider: "tree-sitter" });
  });

  it("different provider with strictly higher confidence overwrites", async () => {
    await writeFragment(conn, functionFragment({ name: "v1", confidence: 0.5, provider: "tree-sitter" }));
    await writeFragment(conn, functionFragment({ name: "v2", confidence: 0.9, provider: "scip" }));

    const row = await readFunction("f1");
    expect(row).toEqual({ name: "v2", confidence: 0.9, provider: "scip" });
  });

  it("different provider with equal-or-lower confidence does NOT overwrite", async () => {
    await writeFragment(conn, functionFragment({ name: "v1", confidence: 0.5, provider: "tree-sitter" }));

    // equal confidence, different provider
    await writeFragment(conn, functionFragment({ name: "equal", confidence: 0.5, provider: "scip" }));
    expect(await readFunction("f1")).toEqual({ name: "v1", confidence: 0.5, provider: "tree-sitter" });

    // lower confidence, different provider
    await writeFragment(conn, functionFragment({ name: "lower", confidence: 0.1, provider: "scip" }));
    expect(await readFunction("f1")).toEqual({ name: "v1", confidence: 0.5, provider: "tree-sitter" });
  });

  it("first write (no prior node) always creates regardless of confidence", async () => {
    await writeFragment(conn, functionFragment({ name: "first", confidence: 0.0, provider: "scip" }));
    expect(await readFunction("f1")).toEqual({ name: "first", confidence: 0, provider: "scip" });
  });

  it("Class nodes (provider but no confidence column): same provider overwrites, different provider does not", async () => {
    const classFragment = (name: string, provider: string): GraphFragment => ({
      nodes: [{ label: "Class", id: "c1", properties: { name, file: "a.ts", provider } }],
      edges: [],
    });

    await writeFragment(conn, classFragment("V1", "tree-sitter"));
    await writeFragment(conn, classFragment("V2", "tree-sitter"));
    let rows = await conn.query(`MATCH (n:Class {id: 'c1'}) RETURN n.name AS name, n.provider AS provider`);
    expect(rows[0]).toEqual({ name: "V2", provider: "tree-sitter" });

    // A different provider has no confidence signal to justify overwriting —
    // must be a no-op.
    await writeFragment(conn, classFragment("V3", "scip"));
    rows = await conn.query(`MATCH (n:Class {id: 'c1'}) RETURN n.name AS name, n.provider AS provider`);
    expect(rows[0]).toEqual({ name: "V2", provider: "tree-sitter" });
  });

  it("nodes without any provenance (e.g. Module) keep the legacy unconditional overwrite", async () => {
    const moduleFragment = (path: string): GraphFragment => ({
      nodes: [{ label: "Module", id: "m1", properties: { path } }],
      edges: [],
    });

    await writeFragment(conn, moduleFragment("a.ts"));
    await writeFragment(conn, moduleFragment("b.ts"));
    const rows = await conn.query(`MATCH (n:Module {id: 'm1'}) RETURN n.path AS path`);
    expect(rows[0]?.path).toBe("b.ts");
  });

  // Historical note: when this test was written (R1), the real CALLS REL
  // table had no confidence/provider columns at all — no provider attached
  // that data to an edge yet, and adding unused columns speculatively was
  // out of scope for R1. XSPEC-333 R3 (SCIP PoC) has since added those two
  // columns to the *real* CALLS table (see schema.ts) because a real second
  // provider now exists to populate them (`src/code-graph/providers/scip/`,
  // exercised end-to-end in test/scip-merge.test.ts). This test's synthetic
  // `TEST_CALLS` table is kept as-is — it is still a useful, schema-agnostic
  // check of mergeEdge's generic overwrite-policy logic in isolation, now
  // simply no longer the *only* place that logic runs against a REL table
  // with these columns.
  it("edges with provider+confidence properties follow the same policy", async () => {
    await conn.execute(`CREATE NODE TABLE TestFn(id STRING, PRIMARY KEY(id))`);
    await conn.execute(
      `CREATE REL TABLE TEST_CALLS(FROM TestFn TO TestFn, call_count INT64, confidence DOUBLE, provider STRING)`,
    );
    await conn.execute(`CREATE (:TestFn {id: 'a'})`);
    await conn.execute(`CREATE (:TestFn {id: 'b'})`);

    const edgeFragment = (call_count: number, confidence: number, provider: string): GraphFragment =>
      ({
        nodes: [],
        edges: [
          {
            label: "TEST_CALLS",
            fromLabel: "TestFn",
            from: "a",
            toLabel: "TestFn",
            to: "b",
            properties: { call_count, confidence, provider },
          },
        ],
      }) as unknown as GraphFragment;

    async function readEdge() {
      const rows = await conn.query(
        `MATCH (:TestFn {id:'a'})-[r:TEST_CALLS]->(:TestFn {id:'b'}) RETURN r.call_count AS cc, r.confidence AS conf, r.provider AS prov`,
      );
      return rows[0];
    }

    await writeFragment(conn, edgeFragment(1, 0.5, "tree-sitter"));
    expect(await readEdge()).toEqual({ cc: 1, conf: 0.5, prov: "tree-sitter" });

    // different provider, lower confidence -> no-op
    await writeFragment(conn, edgeFragment(99, 0.1, "scip"));
    expect(await readEdge()).toEqual({ cc: 1, conf: 0.5, prov: "tree-sitter" });

    // same provider re-index -> overwrites
    await writeFragment(conn, edgeFragment(3, 0.5, "tree-sitter"));
    expect(await readEdge()).toEqual({ cc: 3, conf: 0.5, prov: "tree-sitter" });

    // different provider, strictly higher confidence -> overwrites
    await writeFragment(conn, edgeFragment(7, 0.9, "scip"));
    expect(await readEdge()).toEqual({ cc: 7, conf: 0.9, prov: "scip" });
  });

  // XSPEC-333 R3 OQ-4: before this fix, tree-sitter's OWN `buildCallEdges()`
  // never set `provider`/`confidence` on a CALLS edge, so every
  // tree-sitter-authored CALLS edge in a real DB had genuinely NULL values
  // for both — and `test/scip-merge.test.ts` used to be the one place that
  // exercised this exact "existing NULL blocks a cross-provider overwrite"
  // path end-to-end (against a real SCIP write). That test was rewritten to
  // prove the OPPOSITE now (tree-sitter no longer leaves CALLS edges NULL,
  // so SCIP's write upgrades them) — which means the NULL-blocks-overwrite
  // behaviour itself lost its only real-table regression coverage. It is
  // still load-bearing: any CALLS edge written before this fix (or any DB
  // row from any other legitimately-never-scored source) must still refuse
  // a cross-provider overwrite rather than treating NULL as "lower than
  // anything" — so this test recreates that legacy shape directly against
  // the REAL `CALLS` table (not the synthetic `TEST_CALLS` table above) and
  // asserts the invariant still holds after the OQ-4 fix.
  it("existing NULL confidence on a real CALLS edge (e.g. a pre-OQ-4 legacy row) still blocks a different-provider overwrite", async () => {
    await conn.execute(
      `CREATE (:Function {id: 'nf1', name: 'a', file: 'x.ts', start_line: 1, confidence: 1, provider: 'tree-sitter'})`,
    );
    await conn.execute(
      `CREATE (:Function {id: 'nf2', name: 'b', file: 'x.ts', start_line: 2, confidence: 1, provider: 'tree-sitter'})`,
    );
    // Simulate a legacy CALLS edge written before tree-sitter stamped
    // provider/confidence on its own CALLS edges: call_count only, leaving
    // the other two columns genuinely NULL (not merely omitted from a
    // GraphFragment — a real NULL value read back from Kuzu).
    await conn.execute(
      `MATCH (a:Function {id:'nf1'}), (b:Function {id:'nf2'}) CREATE (a)-[:CALLS {call_count: 1}]->(b)`,
    );

    async function readCalls() {
      const rows = await conn.query(
        `MATCH (:Function {id:'nf1'})-[r:CALLS]->(:Function {id:'nf2'}) RETURN r.call_count AS call_count, r.confidence AS confidence, r.provider AS provider`,
      );
      return rows[0];
    }

    expect(await readCalls()).toEqual({ call_count: 1, confidence: null, provider: null });

    const scipUpgrade: GraphFragment = {
      nodes: [],
      edges: [
        {
          label: "CALLS",
          fromLabel: "Function",
          from: "nf1",
          toLabel: "Function",
          to: "nf2",
          properties: { call_count: 99, confidence: 0.9, provider: "scip" },
        },
      ],
    };
    await writeFragment(conn, scipUpgrade);

    // Refused: NULL is "no signal to compare", not "lower than 0.9" — the
    // legacy row is unchanged, exactly like before this fix.
    expect(await readCalls()).toEqual({ call_count: 1, confidence: null, provider: null });
  });
});
