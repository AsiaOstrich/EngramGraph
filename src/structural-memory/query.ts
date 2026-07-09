/**
 * Structural memory — god nodes (importance ranking) and community detection
 * over the whole code + knowledge graph.
 *
 * Borrows the *concept* from safishamsi/graphify (DEC-027): high-connectivity
 * "god nodes" and community clustering surface structure an AI agent would
 * not find by reading files linearly. Unlike graphify (Python networkx /
 * graspologic Leiden, backed by a separate JSONL entity-index), this runs
 * both algorithms natively inside ryugraph's built-in `algo` extension
 * (PageRank, Louvain) directly against the existing graph-db — no ported
 * algorithm code, no parallel data structure to keep in sync.
 *
 * Kuzu/ryugraph node tables are strictly typed (no dynamic properties), so a
 * heterogeneous result (a Function next to a Doc) cannot ask a single Cypher
 * expression for "the name" — each table exposes a different display field
 * (`name` | `path` | `title`). {@link DISPLAY_PROPERTY} resolves that per
 * label with a plain per-table MATCH, the same pattern every other query
 * module in this repo already uses.
 *
 * PageRank and Louvain do not have the same reach: PageRank traverses the
 * whole heterogeneous projected graph fine, but ryugraph's Louvain rejects
 * multi-label projections at runtime ("Louvain only supports operations on
 * one node table" — not documented, found empirically). {@link communities}
 * therefore projects a second, Function-only graph over `CALLS` edges —
 * which also happens to match graphify's original AST-community use case
 * more closely than a forced cross-domain clustering would.
 */

import type { GraphConnection } from "../graph-db/connection.js";
import { NODE_TABLES, REL_TABLES } from "../graph-db/schema.js";

const PROJECTED_GRAPH = "egr_structural";
const FUNCTION_PROJECTED_GRAPH = "egr_structural_functions";

/** The property each node table exposes as its human-readable label. */
const DISPLAY_PROPERTY: Record<string, string> = {
  Function: "name",
  Class: "name",
  Module: "path",
  Spec: "title",
  Decision: "title",
  Doc: "title",
};

export interface GodNode {
  id: string;
  label: string;
  name: string;
  rank: number;
}

export interface CommunityMember {
  id: string;
  label: string;
  name: string;
  communityId: number;
}

function isAlreadyProjectedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already exists/i.test(message);
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 10;
  return Math.min(Math.max(Math.trunc(limit), 1), 1000);
}

/**
 * Project the whole schema (every NODE/REL table) as `egr_structural` so
 * `page_rank`/`louvain` can traverse across code and knowledge nodes in one
 * call. Projected graphs are connection-scoped (dropped when the connection
 * closes), so this is idempotent per-connection, mirroring the
 * already-exists tolerance in {@link initSchema}.
 */
async function ensureProjectedGraph(conn: GraphConnection): Promise<void> {
  // The ALGO extension (page_rank/louvain/PROJECT_GRAPH) ships with ryugraph
  // but is not loaded by default — must INSTALL + LOAD once per connection.
  await conn.execute(`INSTALL ALGO; LOAD EXTENSION ALGO;`);

  const nodeList = NODE_TABLES.map((t) => `'${t}'`).join(", ");
  const relList = REL_TABLES.map((t) => `'${t}'`).join(", ");
  try {
    await conn.execute(`CALL PROJECT_GRAPH('${PROJECTED_GRAPH}', [${nodeList}], [${relList}])`);
  } catch (err) {
    if (!isAlreadyProjectedError(err)) throw err;
  }
}

/** Function-only projection (`CALLS` edges) — the graph {@link communities} runs Louvain against. */
async function ensureFunctionProjectedGraph(conn: GraphConnection): Promise<void> {
  await conn.execute(`INSTALL ALGO; LOAD EXTENSION ALGO;`);
  try {
    await conn.execute(`CALL PROJECT_GRAPH('${FUNCTION_PROJECTED_GRAPH}', ['Function'], ['CALLS'])`);
  } catch (err) {
    if (!isAlreadyProjectedError(err)) throw err;
  }
}

/** Resolve display names for a batch of (id, label) refs, one MATCH per label group. */
async function resolveNames(
  conn: GraphConnection,
  refs: ReadonlyArray<{ id: string; label: string }>,
): Promise<Map<string, string>> {
  const byLabel = new Map<string, string[]>();
  for (const ref of refs) {
    const ids = byLabel.get(ref.label) ?? [];
    ids.push(ref.id);
    byLabel.set(ref.label, ids);
  }

  const names = new Map<string, string>();
  for (const [label, ids] of byLabel) {
    const prop = DISPLAY_PROPERTY[label];
    if (!prop) continue; // unknown label (schema drift) — leave unresolved, caller falls back to id
    const rows = await conn.query(
      `MATCH (n:${label}) WHERE n.id IN $ids RETURN n.id AS id, n.${prop} AS name`,
      { ids },
    );
    for (const row of rows) {
      names.set(String(row.id), String(row.name));
    }
  }
  return names;
}

/**
 * Highest-importance nodes across the whole graph (code + knowledge), ranked
 * by PageRank. This is graphify's "god_nodes" concept, but weighted by
 * importance (PageRank) rather than raw degree.
 */
export async function godNodes(
  conn: GraphConnection,
  limit = 10,
  dampingFactor = 0.85,
): Promise<GodNode[]> {
  await ensureProjectedGraph(conn);
  const lim = clampLimit(limit);

  const rows = await conn.query(
    `CALL page_rank('${PROJECTED_GRAPH}', dampingFactor := $dampingFactor)
     RETURN node.id AS id, label(node) AS label, rank
     ORDER BY rank DESC LIMIT ${lim}`,
    { dampingFactor },
  );

  const refs = rows.map((r) => ({ id: String(r.id), label: String(r.label) }));
  const names = await resolveNames(conn, refs);

  return rows.map((r) => {
    const id = String(r.id);
    const label = String(r.label);
    return { id, label, name: names.get(id) ?? id, rank: Number(r.rank) };
  });
}

/**
 * Function-call communities (Louvain modularity optimisation over `CALLS`
 * edges). Functions that cluster tightly together — regardless of file —
 * surface structure graphify calls "communities".
 *
 * Scoped to `Function` only: ryugraph's Louvain rejects heterogeneous
 * projected graphs at runtime (see module docstring), so a single unified
 * code+knowledge clustering is not currently possible.
 */
export async function communities(
  conn: GraphConnection,
  maxPhases = 20,
  maxIterations = 20,
): Promise<CommunityMember[]> {
  await ensureFunctionProjectedGraph(conn);

  const rows = await conn.query(
    `CALL louvain('${FUNCTION_PROJECTED_GRAPH}', maxPhases := $maxPhases, maxIterations := $maxIterations)
     RETURN node.id AS id, label(node) AS label, louvain_id AS communityId
     ORDER BY communityId, id`,
    { maxPhases, maxIterations },
  );

  const refs = rows.map((r) => ({ id: String(r.id), label: String(r.label) }));
  const names = await resolveNames(conn, refs);

  return rows.map((r) => {
    const id = String(r.id);
    const label = String(r.label);
    return { id, label, name: names.get(id) ?? id, communityId: Number(r.communityId) };
  });
}
