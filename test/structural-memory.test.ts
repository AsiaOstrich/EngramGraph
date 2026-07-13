import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { godNodes, communities, related } from "../src/structural-memory/query.js";

/**
 * DEC-027 (graphify) L3 structural memory, reimplemented against ryugraph's
 * native `algo` extension (PageRank + Louvain) rather than ported Python.
 *
 * Every describe block below shares ONE connection for its whole group
 * (beforeAll/afterAll, not beforeEach/afterEach): opening/closing many
 * separate GraphConnections that each LOAD the ryugraph ALGO extension
 * crashes the native addon on worker teardown once cumulative connections
 * in a single process cross ~6 (observed empirically in this suite — not a
 * bug in the query logic; all assertions pass individually either way, only
 * the process-exit teardown segfaults). Scenarios within a group use
 * disjoint node ids so they can safely share one seeded graph.
 */
describe("structural memory (DEC-027 L3)", () => {
  let dir: string;
  let conn: GraphConnection;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "engram-test-structural-"));
    conn = GraphConnection.open(join(dir, "graph.db"));
    await initSchema(conn);

    // Hub-and-spoke: `f.core` is called by three others.
    await conn.execute(`CREATE (:Function {id: 'f.core', name: 'core', file: 'a.ts', start_line: 1, confidence: 1.0})`);
    for (const spoke of ["a", "b", "c"]) {
      await conn.execute(`CREATE (:Function {id: 'f.${spoke}', name: '${spoke}', file: 'a.ts', start_line: 1, confidence: 1.0})`);
      await conn.execute(`MATCH (a:Function {id: 'f.${spoke}'}), (b:Function {id: 'f.core'}) CREATE (a)-[:CALLS {call_count: 1}]->(b)`);
    }

    // Disjoint heterogeneous nodes for the display-name resolution case.
    await conn.execute(`CREATE (:Module {id: 'm.a', path: 'src/a.ts'})`);
    await conn.execute(`CREATE (:Spec {id: 's.1', title: 'XSPEC-327', status: 'Draft', confidence: 1.0})`);
  });

  afterAll(async () => {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("godNodes ranks the most-called function highest", async () => {
    const ranked = await godNodes(conn, 10);

    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]?.id).toBe("f.core");
    expect(ranked[0]?.name).toBe("core");
    expect(ranked[0]?.label).toBe("Function");
    expect(ranked[0]?.rank).toBeGreaterThan(ranked[ranked.length - 1]?.rank ?? 0);
  });

  it("godNodes respects limit", async () => {
    const ranked = await godNodes(conn, 2);

    expect(ranked).toHaveLength(2);
  });

  it("godNodes resolves display names across heterogeneous node types", async () => {
    const ranked = await godNodes(conn, 10);
    const byId = new Map(ranked.map((n) => [n.id, n]));

    expect(byId.get("m.a")?.name).toBe("src/a.ts");
    expect(byId.get("s.1")?.name).toBe("XSPEC-327");
  });

  it("communities groups directly-connected nodes into the same cluster", async () => {
    const members = await communities(conn);

    expect(members.length).toBeGreaterThan(0);
    const coreCommunity = members.find((m) => m.id === "f.core")?.communityId;
    const spokeCommunities = members
      .filter((m) => m.id !== "f.core")
      .map((m) => m.communityId);
    expect(spokeCommunities.every((c) => c === coreCommunity)).toBe(true);
  });

  it("godNodes is callable twice on the same connection (idempotent projection)", async () => {
    const first = await godNodes(conn, 10);
    const second = await godNodes(conn, 10);

    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBe(first.length);
  });
});

describe("structural memory (DEC-027 L3) — empty graph", () => {
  let dir: string;
  let conn: GraphConnection;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "engram-test-structural-empty-"));
    conn = GraphConnection.open(join(dir, "graph.db"));
    await initSchema(conn);
  });

  afterAll(async () => {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty array on an empty graph (no error)", async () => {
    const ranked = await godNodes(conn, 10);
    expect(ranked).toEqual([]);
  });
});

/**
 * DEC-028 (HippoRAG) L4a — seeded PageRank approximation. Two disconnected
 * neighbourhoods: `seed` is in a small local group, `b-hub` is a much
 * stronger hub far away. A correct seeded ranking must never let the
 * far-away hub leak in, even though it would dominate a *global* ranking.
 */
describe("related — seeded structural ranking (DEC-028 L4a)", () => {
  let dir: string;
  let conn: GraphConnection;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "engram-test-related-"));
    conn = GraphConnection.open(join(dir, "graph.db"));
    await initSchema(conn);

    await conn.execute(`CREATE (:Function {id: 'seed', name: 'seed', file: 'a.ts', start_line: 1, confidence: 1.0})`);
    await conn.execute(`CREATE (:Function {id: 'a1', name: 'a1', file: 'a.ts', start_line: 1, confidence: 1.0})`);
    await conn.execute(`CREATE (:Function {id: 'a2', name: 'a2', file: 'a.ts', start_line: 1, confidence: 1.0})`);
    await conn.execute(`MATCH (x:Function {id:'seed'}),(y:Function {id:'a1'}) CREATE (x)-[:CALLS {call_count:1}]->(y)`);
    await conn.execute(`MATCH (x:Function {id:'a1'}),(y:Function {id:'a2'}) CREATE (x)-[:CALLS {call_count:1}]->(y)`);

    await conn.execute(`CREATE (:Function {id: 'b-hub', name: 'b-hub', file: 'b.ts', start_line: 1, confidence: 1.0})`);
    for (const n of ["b1", "b2", "b3", "b4", "b5"]) {
      await conn.execute(`CREATE (:Function {id: '${n}', name: '${n}', file: 'b.ts', start_line: 1, confidence: 1.0})`);
      await conn.execute(`MATCH (x:Function {id:'${n}'}),(y:Function {id:'b-hub'}) CREATE (x)-[:CALLS {call_count:1}]->(y)`);
    }

    // A separate, disjoint module→spec component for cross-node-type traversal.
    // IMPLEMENTS is Module→Spec (XSPEC-331), so a Function reaches its Spec
    // through the defining Module: Function ← DEFINES ← Module → IMPLEMENTS → Spec.
    await conn.execute(`CREATE (:Module {id: 'c.ts', path: 'c.ts'})`);
    await conn.execute(`CREATE (:Function {id: 'f1', name: 'f1', file: 'c.ts', start_line: 1, confidence: 1.0})`);
    await conn.execute(`CREATE (:Spec {id: 's1', title: 'XSPEC-1', status: 'Draft', confidence: 1.0})`);
    await conn.execute(`MATCH (m:Module {id:'c.ts'}),(f:Function {id:'f1'}) CREATE (m)-[:DEFINES]->(f)`);
    await conn.execute(`MATCH (m:Module {id:'c.ts'}),(s:Spec {id:'s1'}) CREATE (m)-[:IMPLEMENTS]->(s)`);
  });

  afterAll(async () => {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("ranks the seed's own neighbourhood, never the disconnected far-away hub", async () => {
    const ranked = await related(conn, "seed", 2, 10);

    expect(ranked.map((n) => n.id).sort()).toEqual(["a1", "a2"]);
    expect(ranked.some((n) => n.id === "b-hub")).toBe(false);
    // a2 is the local hub within the neighbourhood (called by a1) — should outrank a1.
    expect(ranked[0]?.id).toBe("a2");
  });

  it("excludes the seed itself from results", async () => {
    const ranked = await related(conn, "seed", 2, 10);

    expect(ranked.some((n) => n.id === "seed")).toBe(false);
  });

  it("respects limit", async () => {
    const ranked = await related(conn, "seed", 2, 1);

    expect(ranked).toHaveLength(1);
  });

  it("crosses node types (Function → Module → Spec via DEFINES + IMPLEMENTS)", async () => {
    // IMPLEMENTS is Module→Spec, so a Function reaches its Spec through the
    // defining Module; related() surfaces both across the two edge types.
    const ranked = await related(conn, "f1", 2, 10);

    const spec = ranked.find((n) => n.label === "Spec");
    expect(spec?.id).toBe("s1");
    expect(spec?.name).toBe("XSPEC-1");
    // the defining module is part of the crossed-type neighbourhood too
    expect(ranked.some((n) => n.id === "c.ts")).toBe(true);
  });

  it("returns empty array for a seed id that does not exist", async () => {
    const ranked = await related(conn, "nonexistent", 2, 10);

    expect(ranked).toEqual([]);
  });

  it("is callable twice with different seeds on the same connection (no stale projection)", async () => {
    const fromSeed = await related(conn, "seed", 2, 10);
    const fromBHub = await related(conn, "b-hub", 2, 10);

    expect(fromSeed.map((n) => n.id).sort()).toEqual(["a1", "a2"]);
    expect(fromBHub.map((n) => n.id).sort()).toEqual(["b1", "b2", "b3", "b4", "b5"]);
  });
});
