import { Hono } from "hono";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { GraphConnection } from "../../graph-db/connection.js";
import { initSchema } from "../../graph-db/schema.js";

/**
 * Health route.
 *
 * `GET /health` performs a live readiness check: it opens a throwaway Kuzu DB,
 * runs `initSchema`, confirms a trivial query works, then tears down. Returns
 * `{ status: "ok" }` with HTTP 200 on success, or `{ status: "error" }` 503.
 */
export function healthRoute(): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    const dir = mkdtempSync(join(tmpdir(), "engram-health-"));
    const conn = GraphConnection.open(join(dir, "graph.db"));
    try {
      await initSchema(conn);
      // Confirm the schema is queryable.
      await conn.query("MATCH (f:Function) RETURN count(f) AS n");
      return c.json({ status: "ok" }, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ status: "error", message }, 503);
    } finally {
      await conn.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  return app;
}
