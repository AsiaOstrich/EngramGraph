import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema, clearGraph } from "../src/graph-db/schema.js";
import { writeFragment } from "../src/graph-db/writer.js";
import { extractProject } from "../src/code-graph/extractor.js";
import { ingestScipIndex } from "../src/code-graph/providers/scip/scip-ingest.js";
import { loadScipPocFixtureIndex, loadScipPocFixtureSources } from "./fixtures/scip-poc/load-fixture.js";

/**
 * XSPEC-333 R3 (SCIP PoC): end-to-end merge of a real SCIP-derived fragment
 * onto a real Kuzu graph a real tree-sitter pass already wrote to, through
 * the unmodified `writeFragment` — this is the test the R1 provenance/merge
 * policy was designed for, run for the first time against a real second
 * provider instead of a synthetic one.
 *
 * Three distinct, separately-asserted claims (see module docs in
 * `graph-db/schema.ts` and `code-graph/providers/scip/scip-ingest.ts` for
 * why these are kept distinct rather than folded into one "it merges!"
 * assertion — an earlier draft of this PoC's plan conflated them, which a
 * review caught before this test was written):
 *
 *   1. **Gap-fill**: a CALLS edge tree-sitter never created (the ambiguous
 *      `Validate` pair) gets created by SCIP, with `provider`/`confidence`
 *      set. This is `shouldOverwrite`'s trivial `existing === null` branch —
 *      real and useful, but not itself proof the *overwrite* policy works.
 *   2. **Node-count / id-alignment invariant**: after the SCIP merge, the
 *      Function node count is IDENTICAL to the tree-sitter-only baseline,
 *      and every new CALLS edge's endpoints are ids that already existed
 *      before the SCIP write. This is the check that would catch a subtle
 *      id-normalization bug silently creating parallel/orphaned nodes
 *      instead of merging onto the real ones.
 *   3. **Cross-provider upgrade** (XSPEC-333 R3 OQ-4): for a pair
 *      tree-sitter DID create a CALLS edge for (e.g.
 *      `OrderService.Process -> OrderService.Validate`, a same-file call),
 *      SCIP's higher-confidence write now DOES upgrade it in place —
 *      `provider` flips from `tree-sitter` to `scip` and `confidence` from
 *      tree-sitter's `0.6` (`extractor.ts`'s `CALLS_CONFIDENCE`, an honest
 *      score for its bare-name resolution heuristic) to SCIP's `0.9`.
 *
 *      This test used to assert the OPPOSITE — that the write was a no-op,
 *      because tree-sitter's `buildCallEdges` left `confidence`/`provider`
 *      NULL on every CALLS edge it wrote, and `writer.ts`'s
 *      `shouldOverwrite` treats a NULL existing confidence as "no signal to
 *      compare against", refusing ANY cross-provider overwrite — not "lower
 *      confidence, still comparable". That was a real, structural gap: a
 *      second, more precise provider could only ever *fill a gap* tree-
 *      sitter left empty, never upgrade an edge it had already resolved, no
 *      matter how much better the new evidence was. It was a genuine
 *      limitation of the R1 design, not a still-correct behaviour worth
 *      preserving — so XSPEC-333 R3 OQ-4 fixed it at the *source*
 *      (tree-sitter now stamps a real, non-null confidence on its own CALLS
 *      edges) rather than by loosening `shouldOverwrite` itself, which is
 *      untouched: same-provider still always wins, different-provider still
 *      only wins with strictly higher confidence, and NULL (e.g. a DB row
 *      written before this fix, not yet re-indexed) still means "no signal,
 *      don't overwrite". This test is the one place that now proves the R1
 *      Scenario ("a later, more precise provider can supersede an earlier,
 *      coarser one") actually holds for CALLS edges, not just for
 *      Function/Class nodes (`test/writer-merge-policy.test.ts` already
 *      covered nodes).
 */
describe("SCIP merge onto a real tree-sitter-populated Kuzu graph (XSPEC-333 R3)", () => {
  // A single shared GraphConnection (opened once for the whole describe
  // block, graph cleared between tests via clearGraph) rather than one fresh
  // GraphConnection per `it()` — empirically necessary: opening/closing
  // several GraphConnections interleaved with repeated tree-sitter parsing
  // in one process reproducibly crashed the vitest worker (a pre-existing,
  // documented native-handle-accumulation risk in this codebase, not a bug
  // in the code under test — see XSPEC-331's own "同process開超過6個
  // GraphConnection...會segfault" finding). One long-lived connection avoids
  // the open/close churn entirely.
  let dir: string;
  let conn: GraphConnection;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "engram-scip-merge-test-"));
    conn = GraphConnection.open(join(dir, "graph.db"));
    await initSchema(conn);
  });

  afterAll(async () => {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await clearGraph(conn);
  });

  async function functionNodeIds(): Promise<string[]> {
    const rows = await conn.query(`MATCH (n:Function) RETURN n.id AS id`);
    return rows.map((r) => r.id as string);
  }

  async function callsEdge(from: string, to: string) {
    const rows = await conn.query(
      `MATCH (:Function {id: $from})-[r:CALLS]->(:Function {id: $to}) RETURN r.call_count AS call_count, r.confidence AS confidence, r.provider AS provider`,
      { from, to },
    );
    return rows[0] as { call_count: number; confidence: number | null; provider: string | null } | undefined;
  }

  it("gap-fill: writes the ambiguous CALLS edges tree-sitter never created, with provider=scip", async () => {
    const sources = loadScipPocFixtureSources();
    const treeSitter = extractProject(sources.map((f) => ({ path: f.relativePath, source: f.source, language: "csharp" })));
    await writeFragment(conn, treeSitter.fragment);

    // Confirm the gap really exists before SCIP fills it.
    expect(
      await callsEdge("Program.cs#Program.Main", "Services/OrderService.cs#OrderService.Validate"),
    ).toBeUndefined();

    const { fragment } = ingestScipIndex(loadScipPocFixtureIndex(), sources);
    await writeFragment(conn, fragment);

    const orderValidate = await callsEdge("Program.cs#Program.Main", "Services/OrderService.cs#OrderService.Validate");
    expect(orderValidate).toEqual({ call_count: 1, confidence: 0.9, provider: "scip" });

    const userValidate = await callsEdge("Program.cs#Program.Main", "Services/UserService.cs#UserService.Validate");
    expect(userValidate).toEqual({ call_count: 1, confidence: 0.9, provider: "scip" });
  });

  it("node-count / id-alignment invariant: SCIP merge does not change the Function node count or create orphaned ids", async () => {
    const sources = loadScipPocFixtureSources();
    const treeSitter = extractProject(sources.map((f) => ({ path: f.relativePath, source: f.source, language: "csharp" })));
    await writeFragment(conn, treeSitter.fragment);

    const before = new Set(await functionNodeIds());
    expect(before.size).toBeGreaterThan(0);

    const { fragment } = ingestScipIndex(loadScipPocFixtureIndex(), sources);
    await writeFragment(conn, fragment);

    const after = new Set(await functionNodeIds());
    expect(after.size).toBe(before.size); // no duplicates, no orphans created

    // Every SCIP CALLS edge's endpoints must be ids that already existed
    // pre-SCIP (i.e. SCIP attached to the REAL tree-sitter nodes, not to
    // parallel ones it minted itself).
    for (const edge of fragment.edges.filter((e) => e.label === "CALLS")) {
      expect(before.has(edge.from)).toBe(true);
      expect(before.has(edge.to)).toBe(true);
    }
  });

  it("cross-provider upgrade: SCIP's higher confidence upgrades a CALLS edge tree-sitter already resolved (XSPEC-333 R3 OQ-4)", async () => {
    const sources = loadScipPocFixtureSources();
    const treeSitter = extractProject(sources.map((f) => ({ path: f.relativePath, source: f.source, language: "csharp" })));
    await writeFragment(conn, treeSitter.fragment);

    // Ground truth: tree-sitter DOES resolve this one on its own (same-file
    // call), now with its own honest, non-null confidence (0.6 —
    // CALLS_CONFIDENCE in extractor.ts) rather than a NULL that used to
    // block any cross-provider comparison.
    const before = await callsEdge(
      "Services/OrderService.cs#OrderService.Process",
      "Services/OrderService.cs#OrderService.Validate",
    );
    expect(before).toEqual({ call_count: 1, confidence: 0.6, provider: "tree-sitter" });

    const { fragment } = ingestScipIndex(loadScipPocFixtureIndex(), sources);
    await writeFragment(conn, fragment);

    const after = await callsEdge(
      "Services/OrderService.cs#OrderService.Process",
      "Services/OrderService.cs#OrderService.Validate",
    );
    // Upgraded: SCIP's strictly higher confidence (0.9 > 0.6) wins, through
    // the SAME shouldOverwrite policy writer-merge-policy.test.ts exercises —
    // no special-casing for CALLS edges.
    expect(after).toEqual({ call_count: 1, confidence: 0.9, provider: "scip" });
  });

  it("confidence ceiling: SCIP (confidence 0.9) cannot overwrite a Function node's properties, because tree-sitter already wrote confidence 1 (the max of the documented [0,1] range)", async () => {
    const sources = loadScipPocFixtureSources();
    const treeSitter = extractProject(sources.map((f) => ({ path: f.relativePath, source: f.source, language: "csharp" })));
    await writeFragment(conn, treeSitter.fragment);

    const targetId = "Services/OrderService.cs#OrderService.Validate";
    const beforeRows = await conn.query(
      `MATCH (n:Function {id: $id}) RETURN n.provider AS provider, n.confidence AS confidence, n.start_line AS start_line`,
      { id: targetId },
    );
    expect(beforeRows[0]).toEqual({ provider: "tree-sitter", confidence: 1, start_line: expect.any(Number) });

    const { fragment } = ingestScipIndex(loadScipPocFixtureIndex(), sources);
    await writeFragment(conn, fragment);

    const afterRows = await conn.query(
      `MATCH (n:Function {id: $id}) RETURN n.provider AS provider, n.confidence AS confidence`,
      { id: targetId },
    );
    // Still tree-sitter's — SCIP's 0.9 is not strictly greater than 1.
    expect(afterRows[0]).toEqual({ provider: "tree-sitter", confidence: 1 });
  });
});
