import { Hono } from "hono";

import type { GraphConnection } from "../../graph-db/connection.js";
import { callChain, definitionFiles, type CallDirection } from "../../code-graph/query.js";
import { readIndexHealth } from "../../code-graph/index-health.js";

const DIRECTIONS: ReadonlySet<string> = new Set(["callers", "callees", "both"]);

/**
 * Call-chain route.
 *
 * `POST /graph/call-chain { symbol, direction?, depth? }` returns the callers
 * and/or callees of a function symbol. When `manifestPath` is given (XSPEC-334
 * R2) the response carries an `indexHealth` field on a graph with blindspots —
 * mirroring the MCP tool, so a REST querier gets the same completeness signal.
 */
export function callChainRoute(conn: GraphConnection, manifestPath?: string): Hono {
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
      const anchor = [
        ...(await definitionFiles(conn, symbol)),
        ...result.callers.map((n) => n.file),
        ...result.callees.map((n) => n.file),
      ];
      const health = readIndexHealth(manifestPath, anchor);
      return c.json(health ? { ...result, indexHealth: health } : result, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
