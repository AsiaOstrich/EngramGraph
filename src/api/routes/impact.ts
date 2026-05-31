import { Hono } from "hono";

import type { GraphConnection } from "../../graph-db/connection.js";
import { impactAnalysis } from "../../knowledge-graph/query.js";

/**
 * Impact-analysis route.
 *
 * `POST /graph/impact-analysis { nodeId, maxHops? }` returns the Decisions in
 * the impact chain of a Spec. Backed by a caller-provided graph connection.
 */
export function impactRoute(conn: GraphConnection): Hono {
  const app = new Hono();

  app.post("/graph/impact-analysis", async (c) => {
    let body: { nodeId?: unknown; maxHops?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const nodeId = body.nodeId;
    if (typeof nodeId !== "string" || nodeId.length === 0) {
      return c.json({ error: "nodeId is required" }, 400);
    }
    const maxHops = typeof body.maxHops === "number" ? body.maxHops : 3;

    try {
      const result = await impactAnalysis(conn, nodeId, maxHops);
      return c.json(result, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
