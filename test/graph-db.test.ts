import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import {
  initSchema,
  NODE_TABLES,
  REL_TABLES,
} from "../src/graph-db/schema.js";

/**
 * AC-1: Kuzu DB initialises, the schema (6 NODE + 7 REL tables) can be
 * created, and a basic MATCH query runs without error.
 */
describe("graph-db schema (AC-1)", () => {
  let dir: string;
  let conn: GraphConnection;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-test-"));
    conn = GraphConnection.open(join(dir, "graph.db"));
  });

  afterEach(async () => {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates all node tables and they are queryable", async () => {
    await initSchema(conn);

    for (const table of NODE_TABLES) {
      const rows = await conn.query(`MATCH (n:${table}) RETURN count(n) AS n`);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.n)).toBe(0);
    }
  });

  it("creates all rel tables (insert + traverse works)", async () => {
    await initSchema(conn);

    await conn.execute(
      `CREATE (:Function {id: 'f1', name: 'execute', file: 'a.ts', start_line: 1, confidence: 1.0})`,
    );
    await conn.execute(
      `CREATE (:Function {id: 'f2', name: 'helper', file: 'a.ts', start_line: 9, confidence: 1.0})`,
    );
    await conn.execute(
      `MATCH (a:Function {id: 'f1'}), (b:Function {id: 'f2'}) CREATE (a)-[:CALLS {call_count: 1}]->(b)`,
    );

    const rows = await conn.query(
      `MATCH (f:Function)-[:CALLS]->(g:Function) WHERE f.name = 'execute' RETURN g.name AS name`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("helper");

    // Sanity: the schema declares the expected number of rel tables.
    expect(REL_TABLES.length).toBe(8);
  });

  it("initSchema is idempotent (safe to call twice)", async () => {
    await initSchema(conn);
    await expect(initSchema(conn)).resolves.toBeUndefined();
  });
});
