/**
 * SAGE writer (XSPEC-237 Phase 4) — apply feedback events to node confidence.
 *
 * Confidence lives in [MIN_CONFIDENCE, 1.0]. A negative signal lowers it, a
 * positive signal raises it, scaled by the event `weight` and a fixed STEP.
 * The lower bound (R4) keeps an important node from being driven to zero by a
 * run of failures.
 */

import type { FeedbackEvent } from "../adapters/signal-source.js";
import type { GraphConnection } from "../graph-db/connection.js";

/** Node tables that carry a `confidence` property. */
export type ConfidenceLabel = "Function" | "Spec" | "Decision" | "Doc";

/** Per-event confidence step (a unit-weight signal moves confidence by this). */
export const STEP = 0.25;
/** Confidence floor (R4): never drive a node below this. */
export const MIN_CONFIDENCE = 0.1;
export const MAX_CONFIDENCE = 1.0;

export interface ConfidenceUpdate {
  nodeId: string;
  label: ConfidenceLabel;
  before: number;
  after: number;
}

function clamp(value: number): number {
  return Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, value));
}

function delta(event: FeedbackEvent): number {
  const magnitude = Math.max(0, Math.min(1, event.weight)) * STEP;
  if (event.signal === "negative") return -magnitude;
  if (event.signal === "positive") return magnitude;
  return 0;
}

/**
 * Apply one feedback event to a node's confidence.
 *
 * @returns the before/after confidence, or null if the node does not exist.
 */
export async function applyFeedback(
  conn: GraphConnection,
  event: FeedbackEvent,
  label: ConfidenceLabel = "Function",
): Promise<ConfidenceUpdate | null> {
  const rows = await conn.query(
    `MATCH (n:${label} {id: $id}) RETURN n.confidence AS confidence`,
    { id: event.nodeId },
  );
  if (rows.length === 0) return null;

  const before = Number(rows[0]?.confidence ?? MAX_CONFIDENCE);
  const after = clamp(before + delta(event));

  await conn.query(`MATCH (n:${label} {id: $id}) SET n.confidence = $c`, {
    id: event.nodeId,
    c: after,
  });

  return { nodeId: event.nodeId, label, before, after };
}
