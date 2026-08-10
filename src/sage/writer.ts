/**
 * SAGE writer — apply feedback events to node confidence.
 *
 * Confidence lives in [MIN_CONFIDENCE, 1.0]. A negative signal lowers it, a
 * positive signal raises it, scaled by the event `weight` and a fixed STEP.
 * The lower bound (R4) keeps an important node from being driven to zero by a
 * run of failures.
 */

import type { FeedbackEvent } from "../adapters/signal-source.js";
import type { GraphConnection } from "../graph-db/connection.js";

/**
 * Node tables that carry a `confidence` property.
 *
 * A runtime array with the type derived from it, not the other way round
 * (XSPEC-373 B10). The label list previously existed as a bare type plus four
 * hand-written copies — two `as ConfidenceLabel` casts in the CLI, one in the
 * HTTP route, and a `z.enum` in the MCP server — so nothing connected them and
 * a fifth label would have to be added in five places. Worse, a cast is
 * compile-time only: `egr top Module` type-checked, reached Cypher, and
 * surfaced `Binder exception: Cannot find property confidence for n` to the
 * user, while the correct message was already written three lines away.
 */
export const CONFIDENCE_LABELS = ["Function", "Spec", "Decision", "Doc"] as const;

export type ConfidenceLabel = (typeof CONFIDENCE_LABELS)[number];

/**
 * Narrow a user-supplied string to a `ConfidenceLabel`, or throw with the
 * valid set. Case-insensitive: `egr top spec` is unambiguous, and rejecting it
 * on capitalisation alone would be pedantry.
 */
export function asConfidenceLabel(value: string, context: string): ConfidenceLabel {
  const match = CONFIDENCE_LABELS.find((l) => l.toLowerCase() === value.toLowerCase());
  if (!match) {
    throw new Error(
      `${context}: "${value}" is not a node label with confidence. Valid: ${CONFIDENCE_LABELS.join(" | ")}.`,
    );
  }
  return match;
}

/** Per-event confidence step (a unit-weight signal moves confidence by this). */
export const STEP = 0.25;
/** Confidence floor (R4): never drive a node below this. */
export const MIN_CONFIDENCE = 0.1;
export const MAX_CONFIDENCE = 1.0;

/**
 * Starting point for a node that has never carried a confidence at all
 * (XSPEC-373 B2).
 *
 * `applyFeedback` used to fall back to MAX_CONFIDENCE, which reads "nothing
 * has ever been judged" as "verified, top marks". That was mostly theoretical
 * while every knowledge node was stamped 1.0 on creation — and then R5 stopped
 * doing that for stub nodes, precisely because a spec asserted only by a
 * `[[ref]]` has nothing behind it. Feeding one such node a single positive
 * signal would have jumped it from unjudged to 1.0, i.e. a phantom outranking
 * documents with real feedback history.
 *
 * Neutral, not zero: an unjudged node is not evidence of being wrong either,
 * and MIN is reserved for something feedback has actively pushed down.
 */
export const NEUTRAL_CONFIDENCE = 0.5;

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

  // NEUTRAL, not MAX — see NEUTRAL_CONFIDENCE. A node with no confidence has
  // not been judged well; it has not been judged at all.
  const before = Number(rows[0]?.confidence ?? NEUTRAL_CONFIDENCE);
  const after = clamp(before + delta(event));

  await conn.query(`MATCH (n:${label} {id: $id}) SET n.confidence = $c`, {
    id: event.nodeId,
    c: after,
  });

  return { nodeId: event.nodeId, label, before, after };
}
