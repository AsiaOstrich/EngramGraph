/**
 * SAGE evolution loop (XSPEC-237 Phase 4) — wire signal sources to the writer.
 *
 * collect feedback (from a {@link SignalSource} or a caller-supplied batch) →
 * apply each event to node confidence → return the resulting updates. The
 * reader side then surfaces high-confidence nodes (reader.ts).
 */

import type { FeedbackEvent, SignalSource } from "../adapters/signal-source.js";
import type { GraphConnection } from "../graph-db/connection.js";
import { applyFeedback, type ConfidenceLabel, type ConfidenceUpdate } from "./writer.js";

/** Well-known ingest event types and how they map to a feedback signal. */
export type IngestEventType = "test_fail" | "test_pass" | "human_fix" | "status_change";

/**
 * Map a high-level ingest event type to the signal + weight of a feedback
 * event. Unknown types are treated as neutral (no-op).
 */
export function feedbackForEventType(
  type: string,
): Pick<FeedbackEvent, "signal" | "weight"> {
  switch (type) {
    case "test_fail":
      return { signal: "negative", weight: 1 };
    case "test_pass":
      return { signal: "positive", weight: 0.4 };
    case "human_fix":
      return { signal: "positive", weight: 0.6 };
    default:
      return { signal: "neutral", weight: 0 };
  }
}

/** Apply a batch of feedback events; returns updates (nulls for missing nodes). */
export async function ingestFeedback(
  conn: GraphConnection,
  events: FeedbackEvent[],
  label: ConfidenceLabel = "Function",
): Promise<ConfidenceUpdate[]> {
  const updates: ConfidenceUpdate[] = [];
  for (const event of events) {
    const update = await applyFeedback(conn, event, label);
    if (update) updates.push(update);
  }
  return updates;
}

/**
 * Run one evolution pass: pull pending events from a signal source and apply
 * them. Returns the confidence updates produced.
 */
export async function runEvolution(
  conn: GraphConnection,
  source: SignalSource,
  label: ConfidenceLabel = "Function",
): Promise<ConfidenceUpdate[]> {
  const events = await source.collect();
  return ingestFeedback(conn, events, label);
}
