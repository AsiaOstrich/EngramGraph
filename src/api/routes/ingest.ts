import { Hono } from "hono";

import type { GraphConnection } from "../../graph-db/connection.js";
import { applyFeedback, type ConfidenceLabel } from "../../sage/writer.js";
import { feedbackForEventType } from "../../sage/evolution-loop.js";

const CONFIDENCE_LABELS: ReadonlySet<string> = new Set(["Function", "Spec", "Decision", "Doc"]);

/**
 * SAGE ingest route (XSPEC-237 Phase 4, AC-4).
 *
 * `POST /graph/ingest { type, functionId | nodeId, nodeLabel?, weight? }`
 * applies a feedback event to a node's confidence and returns before/after.
 */
export function ingestRoute(conn: GraphConnection): Hono {
  const app = new Hono();

  app.post("/graph/ingest", async (c) => {
    let body: {
      type?: unknown;
      nodeId?: unknown;
      functionId?: unknown;
      nodeLabel?: unknown;
      weight?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const type = typeof body.type === "string" ? body.type : "";
    const nodeId =
      typeof body.functionId === "string"
        ? body.functionId
        : typeof body.nodeId === "string"
          ? body.nodeId
          : "";
    if (!type || !nodeId) {
      return c.json({ error: "type and functionId/nodeId are required" }, 400);
    }

    // functionId is shorthand for a Function-labelled node.
    const label: ConfidenceLabel =
      typeof body.functionId === "string"
        ? "Function"
        : typeof body.nodeLabel === "string" && CONFIDENCE_LABELS.has(body.nodeLabel)
          ? (body.nodeLabel as ConfidenceLabel)
          : "Function";

    const mapped = feedbackForEventType(type);
    const weight = typeof body.weight === "number" ? body.weight : mapped.weight;

    try {
      const update = await applyFeedback(
        conn,
        { nodeId, signal: mapped.signal, weight, source: "ingest" },
        label,
      );
      if (!update) {
        return c.json({ error: `node not found: ${label} ${nodeId}` }, 404);
      }
      return c.json(update, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
