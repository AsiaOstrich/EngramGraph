import { Hono } from "hono";

import type { GraphConnection } from "../graph-db/connection.js";
import { healthRoute } from "./routes/health.js";
import { impactRoute } from "./routes/impact.js";
import { ingestRoute } from "./routes/ingest.js";

export interface ServerOptions {
  /**
   * Graph connection backing the data routes. When omitted, only the
   * (self-contained) health route is mounted — graph routes need a live DB.
   */
  connection?: GraphConnection;
}

/**
 * Build the CodeSage Hono application.
 *
 * Always mounts the health route (AC-1). When a `connection` is provided, the
 * graph data routes are mounted too: `/graph/impact-analysis` (Phase 3) and
 * `/graph/ingest` (Phase 4). A future phase adds `/graph/query`.
 */
export function createServer(options: ServerOptions = {}): Hono {
  const app = new Hono();

  app.route("/", healthRoute());

  if (options.connection) {
    app.route("/", impactRoute(options.connection));
    app.route("/", ingestRoute(options.connection));
  }

  return app;
}
