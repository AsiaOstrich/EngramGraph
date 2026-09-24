/**
 * Recall quality ruler — is confidence-weighted retrieval actually better
 * than a confidence-blind (static) read of the same graph?
 *
 * implements DEC-078 D1
 *
 * DEC-078 H1 claims the SAGE evolution loop's confidence feedback makes
 * retrieval more accurate than "純 MERGE 靜態圖檢索" (a plain, confidence-blind
 * graph read). That claim was previously unmeasured — DEC-078 H1's own row
 * says "驗證方式：EGR PoC" and nothing existed to run it. This module is that
 * PoC's measuring instrument, not a one-off script: it takes a caller-defined
 * ground truth (which node ids are still valid after however many changes
 * were applied to a graph) and reports, for a given top-K, how many of the
 * confidence-ranked results are actually valid versus how many of a
 * static, confidence-blind ordering are valid.
 *
 * "Confidence-weighted" here is not a reimplementation of the ranking logic —
 * it calls the real `topByConfidence` export from reader.ts, the same
 * function `egr top` and the MCP server use. "Static baseline" is a
 * confidence-blind read: same label, same limit, ordered only by id (the
 * order you would get if nothing had ever fed the evolution loop a signal —
 * every row bunched at whatever `confidence` a plain MERGE write left it at).
 * If confidence weighting has nothing to work with (e.g. every node still
 * carries the constant `1.0` `parser.ts` stamps on creation, with no
 * `applyFeedback` ever called), the two orderings degenerate to the same
 * thing — that is the ruler correctly reporting "no measurable advantage",
 * not a bug in the ruler.
 */

import type { GraphConnection } from "../graph-db/connection.js";
import type { ConfidenceLabel } from "./writer.js";
import { topByConfidence } from "./reader.js";

/** Which node ids are still considered valid (not stale / not overturned). */
export interface RecallGroundTruth {
  validIds: ReadonlySet<string>;
}

export interface RecallQualityScore {
  /** How many results were actually returned (may be < k if the graph is smaller). */
  k: number;
  /** Ids returned, in the order this method produced them — kept for debugging a failing assertion. */
  ids: string[];
  /** How many of `ids` are in the ground truth's `validIds`. */
  validInTopK: number;
  /** `validInTopK / ids.length` (0 when nothing was returned). */
  ratio: number;
}

function scoreIds(ids: string[], ground: RecallGroundTruth, k: number): RecallQualityScore {
  const validInTopK = ids.filter((id) => ground.validIds.has(id)).length;
  return {
    k,
    ids,
    validInTopK,
    ratio: ids.length === 0 ? 0 : validInTopK / ids.length,
  };
}

/**
 * Confidence-weighted top-K: the real reader.ts read the rest of EGR uses.
 */
export async function scoreConfidenceWeighted(
  conn: GraphConnection,
  label: ConfidenceLabel,
  ground: RecallGroundTruth,
  k: number,
): Promise<RecallQualityScore> {
  const ranked = await topByConfidence(conn, label, k);
  return scoreIds(
    ranked.map((r) => r.id),
    ground,
    k,
  );
}

/**
 * Static baseline top-K: same label, same limit, no confidence in the
 * ordering at all — id ascending, which is what a caller gets from a plain
 * MERGE-built graph that the evolution loop has never touched.
 */
export async function scoreStaticBaseline(
  conn: GraphConnection,
  label: ConfidenceLabel,
  ground: RecallGroundTruth,
  k: number,
): Promise<RecallQualityScore> {
  const lim = Math.min(Math.max(Math.trunc(k), 1), 1000);
  const rows = await conn.query(`MATCH (n:${label}) RETURN n.id AS id ORDER BY n.id ASC LIMIT ${lim}`);
  const ids = rows.map((r) => String(r.id));
  return scoreIds(ids, ground, k);
}

export interface RecallQualityComparison {
  weighted: RecallQualityScore;
  staticBaseline: RecallQualityScore;
}

/**
 * Run both reads against the same graph/label/ground-truth/k and hand back
 * both scores so a caller (a test, a CLI report, a CI gate) can compare them
 * without re-deriving either query.
 */
export async function compareRecallQuality(
  conn: GraphConnection,
  label: ConfidenceLabel,
  ground: RecallGroundTruth,
  k: number,
): Promise<RecallQualityComparison> {
  const [weighted, staticBaseline] = await Promise.all([
    scoreConfidenceWeighted(conn, label, ground, k),
    scoreStaticBaseline(conn, label, ground, k),
  ]);
  return { weighted, staticBaseline };
}
