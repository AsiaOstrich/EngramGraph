/**
 * CodeGraph call-chain queries.
 *
 * The structural questions the D4 PoC needs and the D3 sidecar exposes:
 *   - callers(X): functions that (transitively) call X — "what breaks if I
 *     change X's signature?"
 *   - callees(X): functions X (transitively) calls.
 *
 * Queried by function name (a symbol may map to several Function nodes if the
 * name is reused; all matches are considered). `depth` follows CALLS edges
 * transitively (Kuzu `*1..N`; clamped).
 */

import type { GraphConnection } from "../graph-db/connection.js";

export type CallDirection = "callers" | "callees" | "both";

export interface CallNode {
  id: string;
  name: string;
  file: string;
}

export interface CallChainResult {
  symbol: string;
  direction: CallDirection;
  depth: number;
  callers: CallNode[];
  callees: CallNode[];
}

function safeDepth(depth: number): number {
  if (!Number.isFinite(depth)) return 1;
  return Math.min(Math.max(Math.trunc(depth), 1), 10);
}

function toNodes(rows: Array<Record<string, unknown>>): CallNode[] {
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), file: String(r.file) }));
}

/** Functions that (transitively, up to `depth`) call `name`. */
export async function callers(
  conn: GraphConnection,
  name: string,
  depth = 1,
): Promise<CallNode[]> {
  const d = safeDepth(depth);
  const rows = await conn.query(
    `MATCH (c:Function)-[:CALLS*1..${d}]->(f:Function {name: $name})
     RETURN DISTINCT c.id AS id, c.name AS name, c.file AS file
     ORDER BY file, name`,
    { name },
  );
  return toNodes(rows);
}

/** Functions that `name` (transitively, up to `depth`) calls. */
export async function callees(
  conn: GraphConnection,
  name: string,
  depth = 1,
): Promise<CallNode[]> {
  const d = safeDepth(depth);
  const rows = await conn.query(
    `MATCH (f:Function {name: $name})-[:CALLS*1..${d}]->(g:Function)
     RETURN DISTINCT g.id AS id, g.name AS name, g.file AS file
     ORDER BY file, name`,
    { name },
  );
  return toNodes(rows);
}

/** Combined call chain for a symbol. */
export async function callChain(
  conn: GraphConnection,
  symbol: string,
  direction: CallDirection = "both",
  depth = 1,
): Promise<CallChainResult> {
  const d = safeDepth(depth);
  const wantCallers = direction === "callers" || direction === "both";
  const wantCallees = direction === "callees" || direction === "both";
  return {
    symbol,
    direction,
    depth: d,
    callers: wantCallers ? await callers(conn, symbol, d) : [],
    callees: wantCallees ? await callees(conn, symbol, d) : [],
  };
}
