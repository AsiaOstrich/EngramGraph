/**
 * SAGE reader (XSPEC-237 Phase 4) — confidence-ranked, multi-hop reads.
 *
 * The reader side of the evolution loop: surface high-confidence nodes first so
 * an agent's context is biased toward what feedback has reinforced.
 */

import type { GraphConnection } from "../graph-db/connection.js";
import type { ConfidenceLabel } from "./writer.js";

export interface RankedNode {
  id: string;
  confidence: number;
}

function safeHops(maxHops: number): number {
  if (!Number.isFinite(maxHops)) return 1;
  return Math.min(Math.max(Math.trunc(maxHops), 1), 10);
}

/** Top nodes of a label, highest confidence first. */
export async function topByConfidence(
  conn: GraphConnection,
  label: ConfidenceLabel,
  limit = 10,
): Promise<RankedNode[]> {
  const lim = Math.min(Math.max(Math.trunc(limit), 1), 1000);
  const rows = await conn.query(
    `MATCH (n:${label}) RETURN n.id AS id, n.confidence AS confidence
     ORDER BY n.confidence DESC, n.id ASC LIMIT ${lim}`,
  );
  return rows.map((r) => ({ id: String(r.id), confidence: Number(r.confidence) }));
}

/**
 * Decisions in a spec's impact chain, ranked by confidence (multi-hop read).
 *
 * Combines the direct IMPACTS edge with the variable-length SUPERSEDES chain
 * (Kuzu has no zero-length `*0..N`, so the two are unioned), then orders the
 * resulting decisions by confidence so the most-reinforced surfaces first.
 */
export async function rankedImpact(
  conn: GraphConnection,
  specId: string,
  maxHops = 3,
): Promise<RankedNode[]> {
  const hops = safeHops(maxHops);

  const direct = await conn.query(
    "MATCH (d:Decision)-[:IMPACTS]->(s:Spec {id: $id}) RETURN d.id AS id, d.confidence AS confidence",
    { id: specId },
  );
  const chained = await conn.query(
    `MATCH (d:Decision)-[:SUPERSEDES*1..${hops}]->(:Decision)-[:IMPACTS]->(s:Spec {id: $id})
     RETURN DISTINCT d.id AS id, d.confidence AS confidence`,
    { id: specId },
  );

  const byId = new Map<string, RankedNode>();
  for (const r of [...direct, ...chained]) {
    const id = String(r.id);
    if (!byId.has(id)) byId.set(id, { id, confidence: Number(r.confidence) });
  }
  return [...byId.values()].sort(
    (a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id),
  );
}
