/**
 * Cross-domain impact analysis.
 *
 * Given a Spec id, return the Decisions in its impact chain: decisions that
 * IMPACTS it directly, plus decisions that reach it through a SUPERSEDES chain
 * up to `maxHops` long.
 */

import type { GraphConnection } from "../graph-db/connection.js";
import type { ImpactAnalysisResult, ImpactNode } from "./types.js";

/** Clamp `maxHops` to a safe small integer (it is interpolated into a pattern). */
function safeHops(maxHops: number): number {
  if (!Number.isFinite(maxHops)) return 1;
  return Math.min(Math.max(Math.trunc(maxHops), 1), 10);
}

/**
 * Return the impact chain (Decisions) for a Spec.
 *
 * @param conn    open graph connection
 * @param nodeId  the Spec id, e.g. `SPEC-205`
 * @param maxHops max SUPERSEDES depth to traverse (clamped to 1..10; default 3)
 */
export async function impactAnalysis(
  conn: GraphConnection,
  nodeId: string,
  maxHops = 3,
): Promise<ImpactAnalysisResult> {
  const hops = safeHops(maxHops);

  const direct = await conn.query(
    "MATCH (d:Decision)-[:IMPACTS]->(s:Spec {id: $id}) RETURN d.id AS id, d.title AS title",
    { id: nodeId },
  );

  const chained = await conn.query(
    `MATCH (d:Decision)-[:SUPERSEDES*1..${hops}]->(:Decision)-[:IMPACTS]->(s:Spec {id: $id})
     RETURN DISTINCT d.id AS id, d.title AS title`,
    { id: nodeId },
  );

  const byId = new Map<string, ImpactNode>();
  for (const row of direct) {
    const id = String(row.id);
    byId.set(id, { id, title: String(row.title), via: "direct" });
  }
  for (const row of chained) {
    const id = String(row.id);
    if (!byId.has(id)) {
      byId.set(id, { id, title: String(row.title), via: "supersedes" });
    }
  }

  return { nodeId, decisions: [...byId.values()] };
}
