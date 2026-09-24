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
 * confidence-ranked results are actually valid.
 *
 * "Confidence-weighted" here is not a reimplementation of the ranking logic —
 * it calls the real `topByConfidence` export from reader.ts, the same
 * function `egr top` and the MCP server use.
 *
 * ## What "static baseline" is compared against, and why (2026-09-25 fix)
 *
 * The first version of this ruler compared the weighted score against
 * `scoreStaticBaseline` — a confidence-blind read ordered by id ascending.
 * That was wrong as a "did confidence weighting help" measure: an id-ordered
 * read's score is an artifact of what the fixture happened to name its
 * nodes, not of anything confidence weighting did. On the original fixture,
 * the invalid decisions' ids happened to sort before the valid ones'
 * (`DEC-A1` < `DEC-A2` < `DEC-A3`, etc.), so the id-ordered baseline scored
 * low largely because of naming — renaming the same nine nodes so the valid
 * four sort first makes that same baseline score a perfect 1.0 with zero
 * change to whether confidence weighting did anything (see
 * test/recall-quality.test.ts's naming-robustness test, which rebuilds the
 * identical fixture under both naming schemes).
 *
 * `scoreExpectedBaseline` is the order-independent replacement: it is the
 * fraction of the whole population that is valid — `validCount / population`
 * — which is the expected top-K valid ratio of ANY ordering that carries no
 * signal (formally, the expectation of a hypergeometric draw without
 * replacement does not depend on K). That number cannot be moved by
 * renaming nodes, because it never looks at order or id at all.
 * `scoreStaticBaseline` (id-ordered) is kept and still returned by
 * `compareRecallQuality` as a secondary, informational figure — it is a
 * legitimate description of "what a caller literally gets from an
 * unweighted read of this graph" — but it must never be the thing the
 * "weighted beats baseline" claim is measured against, because it can
 * accidentally agree with (or contradict) that claim for reasons that have
 * nothing to do with confidence weighting.
 *
 * ## What this ruler does NOT claim
 *
 * A green result here says the confidence-weighted READ mechanism
 * (reader.ts's ranking) correctly surfaces nodes whose confidence a caller
 * already set. It says nothing about whether EGR's production environment
 * currently generates that confidence signal on its own. As of this writing
 * it does not: `src/knowledge-graph/parser.ts` stamps every new Spec/Decision
 * node with a hardcoded `confidence: 1.0`, and nothing in this codebase
 * automatically calls `applyFeedback`/`ingestFeedback` when a SUPERSEDES edge
 * is created — creating "DEC-B supersedes DEC-A" does not, by itself, lower
 * DEC-A's confidence. Every negative/positive feedback event that makes this
 * ruler's fixtures score well was fired explicitly, by a caller who already
 * knew the ground truth (a human, or in this test, the fixture setup code)
 * — simulating what a real signal source (CI test pass/fail, human
 * correction, XSPEC status change) is supposed to feed the evolution loop
 * once one is wired up (DEC-078's "設計態" gap; DEC-092 D1's origin-bound
 * initial confidence is the other, orthogonal half still open). This ruler
 * measures "does the mechanism work once fed a signal", not "does EGR feed
 * itself a signal today".
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
 * Id-ordered baseline top-K — SECONDARY/INFORMATIONAL ONLY.
 *
 * Kept because it is a truthful description of "what an unweighted read of
 * this graph literally returns", but see the module doc: its score is
 * sensitive to what the fixture happened to name its nodes, so it must not
 * be the target the "weighted beats baseline" claim is measured against.
 * Use {@link scoreExpectedBaseline} for that.
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

export interface ExpectedBaselineScore {
  /** Total nodes of this label in the graph — the population any order-blind top-K draw comes from. */
  population: number;
  /** How many of those are valid per ground truth. */
  validInPopulation: number;
  /**
   * `validInPopulation / population` — the expected top-K valid ratio of any
   * ordering that carries no signal about validity, independent of K and
   * independent of node ids/naming (hypergeometric expectation of the
   * fraction valid in a draw without replacement does not depend on the
   * draw size). This is what "confidence weighting beats a static read"
   * should be measured against, not a specific id ordering.
   */
  ratio: number;
}

/**
 * Order-independent baseline: the fraction of the whole population that is
 * valid. This is the number a confidence-blind read should be expected to
 * score on average — not the score of any one particular ordering (id,
 * insertion, or otherwise), which is an artifact of that ordering's
 * relationship to the ground truth, not a property of "having no signal".
 */
export async function scoreExpectedBaseline(
  conn: GraphConnection,
  label: ConfidenceLabel,
  ground: RecallGroundTruth,
): Promise<ExpectedBaselineScore> {
  const rows = await conn.query(`MATCH (n:${label}) RETURN n.id AS id`);
  const ids = rows.map((r) => String(r.id));
  const validInPopulation = ids.filter((id) => ground.validIds.has(id)).length;
  return {
    population: ids.length,
    validInPopulation,
    ratio: ids.length === 0 ? 0 : validInPopulation / ids.length,
  };
}

export interface RecallQualityComparison {
  weighted: RecallQualityScore;
  /** Secondary/informational — see {@link scoreStaticBaseline}. Not the "beats baseline" target. */
  staticBaseline: RecallQualityScore;
  /** The order-independent baseline the "weighted beats baseline" claim should be measured against. */
  expectedBaseline: ExpectedBaselineScore;
}

/**
 * Run all three reads against the same graph/label/ground-truth/k and hand
 * back all three scores so a caller (a test, a CLI report, a CI gate) can
 * compare them without re-deriving any query.
 */
export async function compareRecallQuality(
  conn: GraphConnection,
  label: ConfidenceLabel,
  ground: RecallGroundTruth,
  k: number,
): Promise<RecallQualityComparison> {
  const [weighted, staticBaseline, expectedBaseline] = await Promise.all([
    scoreConfidenceWeighted(conn, label, ground, k),
    scoreStaticBaseline(conn, label, ground, k),
    scoreExpectedBaseline(conn, label, ground),
  ]);
  return { weighted, staticBaseline, expectedBaseline };
}
