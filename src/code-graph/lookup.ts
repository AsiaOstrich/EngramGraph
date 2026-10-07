// implements XSPEC-457
/**
 * "Is the thing you asked about in the graph at all?" — kept apart from the
 * queries that answer questions about it (XSPEC-457 R4).
 *
 * `callers(X)` returns `[]` for two situations that mean opposite things:
 * X is in the graph and nobody calls it (safe to delete), or X is not in the
 * graph at all (a typo, another repo, never indexed — nothing is known). Both
 * printed `(none)` and exited 0, so a mistyped name read as "no callers, safe
 * to delete". `top BogusLabel` already refuses an input that names nothing;
 * this gives the symbol-, spec- and node-keyed queries the same refusal.
 *
 * The check is a separate function on purpose: `callers()`/`callees()` are
 * public API and also back the REST routes, so their return type stays as it
 * was and each entry point asks this module first.
 */

import type { GraphConnection } from "../graph-db/connection.js";
import { NODE_TABLES } from "../graph-db/schema.js";

/** What kind of thing the caller named. */
export type LookupKind = "function" | "spec" | "node" | "module";

/** The named input is not in the graph. Mapped to a non-zero exit by the CLI, to `isError` by MCP. */
export class NotInGraphError extends Error {
  readonly kind: LookupKind;
  readonly query: string;
  readonly suggestions: string[];

  constructor(kind: LookupKind, query: string, suggestions: string[], label?: string) {
    super(notInGraphMessage(kind, query, suggestions, label));
    this.name = "NotInGraphError";
    this.kind = kind;
    this.query = query;
    this.suggestions = suggestions;
  }
}

function notInGraphMessage(kind: LookupKind, query: string, suggestions: string[], label?: string): string {
  const what =
    kind === "function"
      ? `no function named "${query}" is in the graph`
      : kind === "spec"
        ? `no spec with id "${query}" is in the graph`
        : kind === "module"
          ? `no module with path "${query}" is in the graph`
          : `no ${label ? `${label} ` : ""}node with id "${query}" is in the graph`;
  const meaning =
    kind === "function"
      ? ` — this is not the same as "nothing calls it"; the graph knows nothing about this name`
      : "";
  const didYouMean = suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : "";
  const next =
    kind === "function"
      ? " Check the spelling, or index the directory that defines it (`egr index <dir>`)."
      : kind === "module"
        ? " Check the path, or index the directory that contains it (`egr index <dir>`)."
        : " Check the id, or index the directory that contains it (`egr index <dir> --docs`).";
  return `${what}${meaning}.${didYouMean}${next}`;
}

/** Levenshtein distance, bounded: returns `max + 1` as soon as it cannot be within `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Rank candidate names by closeness to `query`: case-insensitive equal, then
 * prefix/substring (either direction), then small edit distance. Pure — the
 * graph lookups below only feed it.
 */
export function rankSimilar(query: string, candidates: Iterable<string>, limit = 5): string[] {
  const q = query.toLowerCase();
  const maxEdit = Math.max(1, Math.min(3, Math.floor(q.length / 4)));
  const scored: Array<{ name: string; score: number }> = [];
  for (const name of new Set(candidates)) {
    if (!name || name === query) continue;
    const n = name.toLowerCase();
    let score: number | null = null;
    if (n === q) score = 0;
    else if (n.startsWith(q) || q.startsWith(n)) score = 1;
    else if (n.includes(q) || q.includes(n)) score = 2;
    else {
      const d = editDistance(q, n, maxEdit);
      if (d <= maxEdit) score = 2 + d;
    }
    if (score !== null) scored.push({ name, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((s) => s.name);
}

/** Near-miss names for a function symbol, or `[]` when nothing is close. */
export async function suggestSymbols(conn: GraphConnection, name: string, limit = 5): Promise<string[]> {
  const rows = await conn.query(`MATCH (f:Function) RETURN DISTINCT f.name AS name`);
  return rankSimilar(name, rows.map((r) => String(r.name)), limit);
}

/** Near-miss ids for a spec. */
export async function suggestSpecs(conn: GraphConnection, id: string, limit = 5): Promise<string[]> {
  const rows = await conn.query(`MATCH (s:Spec) RETURN s.id AS id`);
  return rankSimilar(id, rows.map((r) => String(r.id)), limit);
}

/**
 * Throws {@link NotInGraphError} unless a Function with exactly this name
 * exists. Returns the files that define it — the same answer
 * `definitionFiles()` gives, so a caller that needs both asks once.
 */
export async function requireFunction(conn: GraphConnection, name: string): Promise<string[]> {
  const rows = await conn.query(`MATCH (f:Function {name: $name}) RETURN DISTINCT f.file AS file`, { name });
  if (rows.length === 0) throw new NotInGraphError("function", name, await suggestSymbols(conn, name));
  return rows.map((r) => String(r.file)).filter((f) => f && f !== "null");
}

/** Near-miss module paths (compared on the whole path and on the file name). */
export async function suggestModules(conn: GraphConnection, path: string, limit = 5): Promise<string[]> {
  const rows = await conn.query(`MATCH (m:Module) RETURN m.id AS id`);
  const ids = rows.map((r) => String(r.id));
  const base = (p: string) => p.split("/").pop() ?? p;
  const byBase = new Map<string, string[]>();
  for (const id of ids) byBase.set(base(id), [...(byBase.get(base(id)) ?? []), id]);
  const near = rankSimilar(base(path), byBase.keys(), limit);
  return near.flatMap((b) => byBase.get(b) ?? []).slice(0, limit);
}

/** Throws {@link NotInGraphError} unless a Spec with this id exists. */
export async function requireSpec(conn: GraphConnection, id: string): Promise<void> {
  const rows = await conn.query(`MATCH (s:Spec {id: $id}) RETURN s.id AS id LIMIT 1`, { id });
  if (rows.length > 0) return;
  throw new NotInGraphError("spec", id, await suggestSpecs(conn, id));
}

/** True when any node table has a node with this id. */
export async function nodeExists(conn: GraphConnection, id: string): Promise<boolean> {
  for (const table of NODE_TABLES) {
    const rows = await conn.query(`MATCH (n:${table} {id: $id}) RETURN n.id AS id LIMIT 1`, { id });
    if (rows.length > 0) return true;
  }
  return false;
}

/** Throws {@link NotInGraphError} unless some node has this id. */
export async function requireNode(conn: GraphConnection, id: string): Promise<void> {
  if (await nodeExists(conn, id)) return;
  throw new NotInGraphError("node", id, []);
}
