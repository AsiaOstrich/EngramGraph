import { Hono } from "hono";

import type { GraphConnection } from "../../graph-db/connection.js";
import { callChain, type CallDirection } from "../../code-graph/query.js";

const DIRECTIONS: ReadonlySet<string> = new Set(["callers", "callees", "both"]);

/**
 * Call-chain route.
 *
 * `POST /graph/call-chain { symbol, direction?, depth? }` returns the callers
 * and/or callees of a function symbol.
 */
export function callChainRoute(conn: GraphConnection): Hono {
  const app = new Hono();

  app.post("/graph/call-chain", async (c) => {
    let body: { symbol?: unknown; direction?: unknown; depth?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const symbol = body.symbol;
    if (typeof symbol !== "string" || symbol.length === 0) {
      return c.json({ error: "symbol is required" }, 400);
    }
    const direction: CallDirection =
      typeof body.direction === "string" && DIRECTIONS.has(body.direction)
        ? (body.direction as CallDirection)
        : "both";
    const depth = typeof body.depth === "number" ? body.depth : 1;

    try {
      const result = await callChain(conn, symbol, direction, depth);
      return c.json(result, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
