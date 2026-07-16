import { Hono } from "hono";

import type { GraphConnection } from "../graph-db/connection.js";
import { callChainRoute } from "./routes/call-chain.js";
import { healthRoute } from "./routes/health.js";
import { impactRoute } from "./routes/impact.js";
import { ingestRoute } from "./routes/ingest.js";

export interface ServerOptions {
  /**
   * Graph connection backing the data routes. When omitted, only the
   * (self-contained) health route is mounted — graph routes need a live DB.
   */
  connection?: GraphConnection;
  /**
   * Path to the graph's parse-health manifest (XSPEC-334 R2). When given,
   * query routes attach `indexHealth` on a graph with blindspots. Omitting it
   * disables the surfacing (routes behave exactly as pre-R2).
   */
  manifestPath?: string;
}

/**
 * Build the EngramGraph Hono application.
 *
 * Always mounts the health route (AC-1). When a `connection` is provided, the
 * graph data routes are mounted too: `/graph/impact-analysis` (Phase 3),
 * `/graph/ingest` (Phase 4) and `/graph/call-chain` (D4 P2 / D3 sidecar).
 */
export function createServer(options: ServerOptions = {}): Hono {
  const app = new Hono();

  app.route("/", healthRoute());

  if (options.connection) {
    app.route("/", impactRoute(options.connection));
    app.route("/", ingestRoute(options.connection));
    app.route("/", callChainRoute(options.connection, options.manifestPath));
  }

  return app;
}
