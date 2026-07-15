import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema, clearGraph } from "../src/graph-db/schema.js";
import { writeFragment } from "../src/graph-db/writer.js";
import { extractProject } from "../src/code-graph/extractor.js";
import { ingestScipIndex } from "../src/code-graph/providers/scip/scip-ingest.js";
import { loadScipJavaPocFixtureIndex, loadScipJavaPocFixtureSources } from "./fixtures/scip-java-poc/load-fixture.js";

/**
 * XSPEC-333 R3 Java PoC: re-runs `test/scip-merge.test.ts`'s three-claim
 * merge validation (gap-fill / node-count-alignment / cross-provider
 * upgrade) against a real `scip-java`-derived fragment merged onto a real
 * tree-sitter-populated Kuzu graph, to check the specific claim the C# PoC
 * could NOT check on its own: **does XSPEC-333 R3 OQ-4's fix (tree-sitter
 * stamping honest, non-null CALLS confidence) generalize to a second
 * language, or was the C# result an artifact of that one fixture?**
 *
 * The case that matters most here is "cross-provider upgrade" below:
 * `OrderService.process -> OrderService.validate` is a SAME-FILE Java call
 * tree-sitter resolves on its own (confidence 0.8, same as C#'s
 * `CALLS_CONFIDENCE["same-file"]` -- this constant is language-agnostic, it
 * lives in `extractor.ts` and is not C#-specific), so this is a real test of
 * "does SCIP's higher-confidence write upgrade an edge tree-sitter ALREADY
 * resolved" -- not just "fill a gap it left empty" (the ambiguous
 * validate() pair, covered by the gap-fill test below, and already
 * sufficiently proven language-agnostic since it re-uses the exact same
 * `shouldOverwrite` merge policy code path with no CALLS-specific
 * special-casing for either language).
 */
describe("SCIP merge onto a real tree-sitter-populated Kuzu graph (XSPEC-333 R3 Java PoC)", () => {
  // Single shared GraphConnection per describe block -- same rationale as
  // test/scip-merge.test.ts (repeated open/close + tree-sitter parsing in one
  // process reproducibly crashed the vitest worker; see XSPEC-331's finding).
  let dir: string;
  let conn: GraphConnection;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "engram-scip-java-merge-test-"));
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
    const sources = loadScipJavaPocFixtureSources();
    const treeSitter = extractProject(sources.map((f) => ({ path: f.relativePath, source: f.source, language: "java" })));
    await writeFragment(conn, treeSitter.fragment);

    // Confirm the gap really exists before SCIP fills it.
    expect(
      await callsEdge(
        "src/main/java/com/example/Program.java#Program.main",
        "src/main/java/com/example/services/OrderService.java#OrderService.validate",
      ),
    ).toBeUndefined();

    const { fragment } = ingestScipIndex(loadScipJavaPocFixtureIndex(), sources);
    await writeFragment(conn, fragment);

    const orderValidate = await callsEdge(
      "src/main/java/com/example/Program.java#Program.main",
      "src/main/java/com/example/services/OrderService.java#OrderService.validate",
    );
    expect(orderValidate).toEqual({ call_count: 1, confidence: 0.9, provider: "scip" });

    const userValidate = await callsEdge(
      "src/main/java/com/example/Program.java#Program.main",
      "src/main/java/com/example/services/UserService.java#UserService.validate",
    );
    expect(userValidate).toEqual({ call_count: 1, confidence: 0.9, provider: "scip" });
  });

  it("node-count / id-alignment invariant: SCIP merge does not change the Function node count or create orphaned ids", async () => {
    const sources = loadScipJavaPocFixtureSources();
    const treeSitter = extractProject(sources.map((f) => ({ path: f.relativePath, source: f.source, language: "java" })));
    await writeFragment(conn, treeSitter.fragment);

    const before = new Set(await functionNodeIds());
    expect(before.size).toBeGreaterThan(0);

    const { fragment } = ingestScipIndex(loadScipJavaPocFixtureIndex(), sources);
    await writeFragment(conn, fragment);

    const after = new Set(await functionNodeIds());
    expect(after.size).toBe(before.size); // no duplicates, no orphans created

    for (const edge of fragment.edges.filter((e) => e.label === "CALLS")) {
      expect(before.has(edge.from)).toBe(true);
      expect(before.has(edge.to)).toBe(true);
    }
  });

  it("cross-provider upgrade: SCIP's higher confidence upgrades a CALLS edge tree-sitter already resolved, same as the C# case (XSPEC-333 R3 OQ-4 generalizes)", async () => {
    const sources = loadScipJavaPocFixtureSources();
    const treeSitter = extractProject(sources.map((f) => ({ path: f.relativePath, source: f.source, language: "java" })));
    await writeFragment(conn, treeSitter.fragment);

    // Ground truth: tree-sitter DOES resolve this one on its own (same-file
    // call, resolved via the local-name map -- see extractProject), with its
    // own honest, non-null confidence (0.8, extractor.ts's
    // CALLS_CONFIDENCE["same-file"] -- the same language-agnostic constant
    // the C# case exercises).
    const before = await callsEdge(
      "src/main/java/com/example/services/OrderService.java#OrderService.process",
      "src/main/java/com/example/services/OrderService.java#OrderService.validate",
    );
    expect(before).toEqual({ call_count: 1, confidence: 0.8, provider: "tree-sitter" });

    const { fragment } = ingestScipIndex(loadScipJavaPocFixtureIndex(), sources);
    await writeFragment(conn, fragment);

    const after = await callsEdge(
      "src/main/java/com/example/services/OrderService.java#OrderService.process",
      "src/main/java/com/example/services/OrderService.java#OrderService.validate",
    );
    // Upgraded: SCIP's strictly higher confidence (0.9 > 0.8) wins, through
    // the SAME shouldOverwrite policy -- no special-casing for Java, no
    // special-casing for CALLS edges.
    expect(after).toEqual({ call_count: 1, confidence: 0.9, provider: "scip" });
  });

  it("confidence ceiling: SCIP (confidence 0.9) cannot overwrite a Function node's properties, because tree-sitter already wrote confidence 1 (the max of the documented [0,1] range)", async () => {
    const sources = loadScipJavaPocFixtureSources();
    const treeSitter = extractProject(sources.map((f) => ({ path: f.relativePath, source: f.source, language: "java" })));
    await writeFragment(conn, treeSitter.fragment);

    const targetId = "src/main/java/com/example/services/OrderService.java#OrderService.validate";
    const beforeRows = await conn.query(
      `MATCH (n:Function {id: $id}) RETURN n.provider AS provider, n.confidence AS confidence, n.start_line AS start_line`,
      { id: targetId },
    );
    expect(beforeRows[0]).toEqual({ provider: "tree-sitter", confidence: 1, start_line: expect.any(Number) });

    const { fragment } = ingestScipIndex(loadScipJavaPocFixtureIndex(), sources);
    await writeFragment(conn, fragment);

    const afterRows = await conn.query(
      `MATCH (n:Function {id: $id}) RETURN n.provider AS provider, n.confidence AS confidence`,
      { id: targetId },
    );
    expect(afterRows[0]).toEqual({ provider: "tree-sitter", confidence: 1 });
  });
});
