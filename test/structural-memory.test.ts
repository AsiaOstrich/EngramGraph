import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { godNodes, communities } from "../src/structural-memory/query.js";

/**
 * DEC-027 (graphify) L3 structural memory, reimplemented against ryugraph's
 * native `algo` extension (PageRank + Louvain) rather than ported Python.
 */
describe("structural memory (DEC-027 L3)", () => {
  let dir: string;
  let conn: GraphConnection;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "engram-test-structural-"));
    conn = GraphConnection.open(join(dir, "graph.db"));
    await initSchema(conn);
  });

  afterEach(async () => {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A small hub-and-spoke graph: `core` is called by three others. */
  async function seedHubGraph(): Promise<void> {
    await conn.execute(
      `CREATE (:Function {id: 'f.core', name: 'core', file: 'a.ts', start_line: 1, confidence: 1.0})`,
    );
    for (const spoke of ["a", "b", "c"]) {
      await conn.execute(
        `CREATE (:Function {id: 'f.${spoke}', name: '${spoke}', file: 'a.ts', start_line: 1, confidence: 1.0})`,
      );
      await conn.execute(
        `MATCH (a:Function {id: 'f.${spoke}'}), (b:Function {id: 'f.core'}) CREATE (a)-[:CALLS {call_count: 1}]->(b)`,
      );
    }
  }

  it("godNodes ranks the most-called function highest", async () => {
    await seedHubGraph();

    const ranked = await godNodes(conn, 10);

    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]?.id).toBe("f.core");
    expect(ranked[0]?.name).toBe("core");
    expect(ranked[0]?.label).toBe("Function");
    expect(ranked[0]?.rank).toBeGreaterThan(ranked[ranked.length - 1]?.rank ?? 0);
  });

  it("godNodes respects limit", async () => {
    await seedHubGraph();

    const ranked = await godNodes(conn, 2);

    expect(ranked).toHaveLength(2);
  });

  it("godNodes resolves display names across heterogeneous node types", async () => {
    await conn.execute(
      `CREATE (:Module {id: 'm.a', path: 'src/a.ts'})`,
    );
    await conn.execute(
      `CREATE (:Spec {id: 's.1', title: 'XSPEC-327', status: 'Draft', confidence: 1.0})`,
    );

    const ranked = await godNodes(conn, 10);
    const byId = new Map(ranked.map((n) => [n.id, n]));

    expect(byId.get("m.a")?.name).toBe("src/a.ts");
    expect(byId.get("s.1")?.name).toBe("XSPEC-327");
  });

  it("returns empty array on an empty graph (no error)", async () => {
    const ranked = await godNodes(conn, 10);
    expect(ranked).toEqual([]);
  });

  it("communities groups directly-connected nodes into the same cluster", async () => {
    await seedHubGraph();

    const members = await communities(conn);

    expect(members.length).toBeGreaterThan(0);
    const coreCommunity = members.find((m) => m.id === "f.core")?.communityId;
    const spokeCommunities = members
      .filter((m) => m.id !== "f.core")
      .map((m) => m.communityId);
    expect(spokeCommunities.every((c) => c === coreCommunity)).toBe(true);
  });

  it("godNodes is callable twice on the same connection (idempotent projection)", async () => {
    await seedHubGraph();

    const first = await godNodes(conn, 10);
    const second = await godNodes(conn, 10);

    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBe(first.length);
  });
});
