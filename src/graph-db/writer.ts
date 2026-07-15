/**
 * Generic graph writer — idempotently MERGE a {@link GraphFragment} into Kuzu.
 *
 * Handles every NODE / REL label in the schema, so CodeGraph (Function/Class/
 * Module), KnowledgeGraph (Spec/Decision/Doc) and any future fragment producer
 * share one writer. Node/edge labels come from the controlled
 * {@link NodeLabel}/{@link RelLabel} unions and are safe to interpolate;
 * property keys are validated as plain identifiers and all values are bound as
 * parameters.
 *
 * ## Overwrite policy (XSPEC-333 R1)
 *
 * Today there is exactly one extraction provider (tree-sitter), so a plain
 * unconditional `MERGE ... SET` was harmless: every re-write came from the
 * same source. Once a second provider exists (e.g. SCIP) that is not true
 * any more — a coarser/older pass must not blindly clobber a more precise
 * one just because it happened to run more recently. So for any node/edge
 * whose properties carry a `provider` (and optionally `confidence`) field,
 * `mergeNode`/`mergeEdge` only let a write update existing data when either:
 *   - it comes from the **same provider** as what's already stored (a normal
 *     re-index of the same pipeline must still update in place), or
 *   - it comes from a **different provider with strictly higher confidence**
 *     (a better source is allowed to supersede a worse one).
 * Equal-or-lower confidence from a different provider is a no-op. If only
 * `provider` is present (no `confidence` to compare — see Class, which has
 * no confidence column), only same-provider re-writes are allowed. If
 * neither is present (Module/Spec/Decision/Doc, or edges with no provenance
 * properties at all), the legacy unconditional overwrite is preserved —
 * there is no source-quality signal to gate on.
 *
 * **Known consequence, accepted rather than fixed (XSPEC-333 R3 OQ-4):**
 * the decision is all-or-nothing per node/edge, not per property. Once a
 * higher-confidence provider wins (e.g. SCIP upgrades a CALLS edge
 * tree-sitter resolved), every property on that row — including
 * freshness-sensitive ones like `call_count`, which has nothing to do with
 * *which provider is more precise* — is now frozen against the losing
 * provider too, even if that provider keeps re-indexing daily while the
 * winner never runs again. This was already true for Function nodes since
 * R1 (a losing provider can't refresh `name`/`start_line` either); CALLS
 * edges inherit the same tradeoff now that they carry provenance. Splitting
 * "source-quality" properties from "freshness" properties would need a
 * per-property overwrite decision instead of one decision for the whole
 * SET clause — out of scope here; flagged so a future reader doesn't
 * mistake a stale `call_count` on an upgraded edge for a bug.
 *
 * ### Why this is a read-then-decide, not a single conditional query
 *
 * Kuzu's Cypher does support `MERGE ... ON CREATE SET ... ON MATCH SET ...`
 * and `CASE WHEN ... THEN ... ELSE ... END` inside a `SET` assignment, so a
 * first version of this policy tried to express the whole decision in one
 * `ON MATCH SET prop1 = CASE WHEN cond THEN ... END, prop2 = CASE WHEN cond
 * THEN ... END, ...` query (one CASE per changed property, all sharing the
 * same `cond`). That version was **empirically wrong**: Kuzu evaluates the
 * assignments in a `SET` clause sequentially, left to right, and later
 * assignments in the same clause see the *already-updated* values of
 * properties an earlier assignment in that same clause just wrote — not the
 * pre-write snapshot. Concretely, with `confidence` ahead of `provider` in
 * the assignment list (matching this fragment's own property order),
 * writing `{confidence: 0.9, provider: "scip"}` over `{confidence: 0.5,
 * provider: "tree-sitter"}` correctly updated `confidence` (0.9 > 0.5 →
 * true) but then silently *failed* to update `provider`, because by the
 * time that assignment's `CASE WHEN` re-evaluated `n.confidence`, it now
 * read the just-written 0.9 — so `$confidence(0.9) > n.confidence(0.9)` was
 * false and the shared condition flipped to false for that one assignment
 * only. Reordering the SET list does not fix this in general (it just moves
 * the inconsistency to a different property), so the design here instead
 * reads the existing `provider`/`confidence` first, decides in JS, and then
 * issues one **unconditional** `MERGE ... SET` (or, if the decision is "do
 * not overwrite", a bare `MERGE` with no SET at all so the node/edge still
 * exists for edges that reference it). This costs one extra read query per
 * node/edge that carries provenance properties, but every assignment is
 * computed off one consistent snapshot.
 */

import type { GraphConnection } from "./connection.js";
import type { GraphEdge, GraphFragment, GraphNode } from "./types.js";
import type { RyuValue } from "ryugraph";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertSafeKey(key: string): void {
  if (!IDENTIFIER.test(key)) {
    throw new Error(`writeFragment: unsafe property key "${key}"`);
  }
}

/** Existing provenance read back for the overwrite decision. */
interface ExistingProvenance {
  provider: unknown;
  confidence: unknown;
}

/**
 * Decide whether a new write may overwrite existing provenance-bearing data.
 *
 * @param existing `null` when no prior node/edge exists (always writes —
 *   there's nothing to protect yet).
 * @param newProvider / newConfidence the incoming write's values (`confidence`
 *   is `undefined` when the label has no confidence column, e.g. Class).
 */
function shouldOverwrite(
  existing: ExistingProvenance | null,
  newProvider: unknown,
  newConfidence: unknown,
): boolean {
  if (!existing) return true;
  if (newProvider === existing.provider) return true;
  if (newConfidence === undefined || existing.confidence === undefined || existing.confidence === null) {
    // No confidence to compare on either side — only a same-provider
    // re-write is allowed to overwrite (see Class, which has no confidence
    // column, and freshly-migrated rows with a null confidence).
    return false;
  }
  return Number(newConfidence) > Number(existing.confidence);
}

/**
 * Read back the existing `provider` (+ `confidence`, if the table has that
 * column) of a node, or `null` if it doesn't exist yet. Only called when the
 * incoming write's properties actually carry a `provider` (see callers) —
 * no point reading otherwise.
 *
 * `confidence` is only added to the RETURN clause when the caller says the
 * label has that column (Kuzu is strict — unlike a schemaless property
 * graph, `RETURN n.confidence` throws a binder error on a table that never
 * declared that column, e.g. Class).
 */
async function readExistingNodeProvenance(
  conn: GraphConnection,
  label: string,
  id: string,
  hasConfidence: boolean,
): Promise<ExistingProvenance | null> {
  const cols = hasConfidence ? `n.provider AS provider, n.confidence AS confidence` : `n.provider AS provider`;
  const rows = await conn.query(`MATCH (n:${label} {id: $id}) RETURN ${cols}`, { id });
  return rows.length > 0 ? { provider: rows[0]?.provider, confidence: rows[0]?.confidence } : null;
}

async function readExistingEdgeProvenance(
  conn: GraphConnection,
  edge: GraphEdge,
  hasConfidence: boolean,
): Promise<ExistingProvenance | null> {
  const cols = hasConfidence ? `r.provider AS provider, r.confidence AS confidence` : `r.provider AS provider`;
  const rows = await conn.query(
    `MATCH (a:${edge.fromLabel} {id: $from})-[r:${edge.label}]->(b:${edge.toLabel} {id: $to}) RETURN ${cols}`,
    { from: edge.from, to: edge.to },
  );
  return rows.length > 0 ? { provider: rows[0]?.provider, confidence: rows[0]?.confidence } : null;
}

async function mergeNode(conn: GraphConnection, node: GraphNode): Promise<void> {
  const keys = Object.keys(node.properties);
  const hasProvenance = "provider" in node.properties;

  let write = true;
  if (hasProvenance) {
    const hasConfidence = "confidence" in node.properties;
    const existing = await readExistingNodeProvenance(conn, node.label, node.id, hasConfidence);
    write = shouldOverwrite(existing, node.properties.provider, node.properties.confidence);
  }

  if (!write) {
    // Still ensure the node exists (a bare MERGE with no SET never touches
    // properties on an existing match, and creates an empty-ish node — with
    // no properties set beyond `id` — the rare first time a losing write
    // races a concurrent first-write; in practice mergeNode/mergeEdge run
    // strictly sequentially within one writeFragment call).
    await conn.execute(`MERGE (n:${node.label} {id: $id})`, { id: node.id });
    return;
  }

  const params: Record<string, RyuValue> = { id: node.id };
  const assignments: string[] = [];
  for (const key of keys) {
    assertSafeKey(key);
    params[key] = node.properties[key] as RyuValue;
    assignments.push(`n.${key} = $${key}`);
  }
  const setClause = assignments.length > 0 ? ` SET ${assignments.join(", ")}` : "";
  await conn.query(`MERGE (n:${node.label} {id: $id})${setClause}`, params);
}

async function mergeEdge(conn: GraphConnection, edge: GraphEdge): Promise<void> {
  const props = edge.properties ?? {};
  const keys = Object.keys(props);
  const hasProvenance = "provider" in props;

  let write = true;
  if (hasProvenance) {
    const hasConfidence = "confidence" in props;
    const existing = await readExistingEdgeProvenance(conn, edge, hasConfidence);
    write = shouldOverwrite(existing, props.provider, props.confidence);
  }

  const match = `MATCH (a:${edge.fromLabel} {id: $from}), (b:${edge.toLabel} {id: $to})`;

  if (!write) {
    await conn.execute(`${match} MERGE (a)-[r:${edge.label}]->(b)`, { from: edge.from, to: edge.to });
    return;
  }

  const params: Record<string, RyuValue> = { from: edge.from, to: edge.to };
  const assignments: string[] = [];
  for (const key of keys) {
    assertSafeKey(key);
    // prefix to avoid colliding with $from / $to
    params[`p_${key}`] = props[key] as RyuValue;
    assignments.push(`r.${key} = $p_${key}`);
  }
  const setClause = assignments.length > 0 ? ` SET ${assignments.join(", ")}` : "";
  await conn.query(`${match} MERGE (a)-[r:${edge.label}]->(b)${setClause}`, params);
}

/**
 * Write a fragment to the graph. Nodes are written before edges so that edge
 * endpoints always exist. Idempotent: re-writing updates properties in place
 * (subject to the overwrite policy above for provenance-bearing labels).
 */
export async function writeFragment(
  conn: GraphConnection,
  fragment: GraphFragment,
): Promise<void> {
  for (const node of fragment.nodes) {
    await mergeNode(conn, node);
  }
  for (const edge of fragment.edges) {
    await mergeEdge(conn, edge);
  }
}
