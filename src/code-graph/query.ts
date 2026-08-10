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
import { toPosixPath } from "./path-utils.js";
import type { KnowledgeOrigin } from "../graph-db/types.js";

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

/**
 * Files that define a Function named `name` (XSPEC-334 R2 query anchor).
 *
 * A symbol's callers most often live in — or in a sibling of — the symbol's
 * OWN definition file, so this anchors the coarse index-health blindspot match
 * even when the caller/callee result set is EMPTY. That empty case is exactly
 * the highest-risk answer ("nothing calls foo, safe to delete") and, without
 * this anchor, would carry no blindspot signal at all (an empty result has no
 * result files to match against). Cheap: one indexed lookup by name.
 */
export async function definitionFiles(conn: GraphConnection, name: string): Promise<string[]> {
  const rows = await conn.query(
    `MATCH (f:Function {name: $name}) RETURN DISTINCT f.file AS file`,
    { name },
  );
  return rows.map((r) => String(r.file)).filter((f) => f && f !== "null");
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

// --- doc↔code (IMPLEMENTS) queries (XSPEC-331 R1/R4) ---
//
// IMPLEMENTS is Module→Spec, so both directions hop through the Module: a file
// implements a spec (`// implements XSPEC-NNN`), and its Functions are reached
// via DEFINES(Module→Function).

/** A file that implements a spec, plus the functions it defines. */
export interface ImplementerModule {
  module: string;
  functions: string[];
}

export interface ImplementersResult {
  spec: string;
  /** Spec title if the doc has been indexed (`index --docs`), else null. */
  title: string | null;
  modules: ImplementerModule[];
  /**
   * How this spec's id got into the graph, or null when it is not there at all
   * (XSPEC-373 R2).
   *
   * The obvious existence signal was `title === null`, and it is wrong in both
   * directions — which is what a review caught before this shipped. A spec
   * asserted by a `// implements` comment has a null title AND real
   * implementers; a phantom minted from a `[[ref]]` used to have a non-null
   * title (its own id) and no document behind it. Answering "not in the graph"
   * off a null title would have told a user their indexed spec did not exist,
   * and answering "exists" off a non-null one would have vouched for a spec
   * nobody ever wrote.
   *
   * `origin` is the field that actually knows: absent means absent, and the
   * three present values say which route the id took.
   */
  origin: KnowledgeOrigin | null;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => v != null).map(String).sort();
}

/**
 * spec → code: files that declare `// implements <specId>`, each with the
 * functions defined in that file.
 */
export async function implementers(
  conn: GraphConnection,
  specId: string,
): Promise<ImplementersResult> {
  const specRows = await conn.query(
    `MATCH (s:Spec {id: $specId}) RETURN s.title AS title, s.origin AS origin`,
    { specId },
  );
  const rawTitle = specRows[0]?.title;
  const title = rawTitle == null ? null : String(rawTitle);
  // No row at all → not in the graph. A row with no origin is pre-R5 data,
  // reported as `declared` since that is what every pre-R5 document node was.
  const origin: KnowledgeOrigin | null =
    specRows.length === 0 ? null : ((specRows[0]?.origin as KnowledgeOrigin | null) ?? "declared");

  const rows = await conn.query(
    `MATCH (s:Spec {id: $specId})<-[:IMPLEMENTS]-(m:Module)
     OPTIONAL MATCH (m)-[:DEFINES]->(f:Function)
     RETURN m.id AS module, collect(f.name) AS functions
     ORDER BY module`,
    { specId },
  );
  const modules = rows.map((r) => ({
    module: String(r.module),
    functions: toStringList(r.functions),
  }));
  return { spec: specId, title, modules, origin };
}

export interface ImplementedSpec {
  id: string;
  title: string | null;
}

export interface ImplementedSpecsResult {
  /** The module id actually queried — after resolution (see `resolvedFrom`). */
  module: string;
  specs: ImplementedSpec[];
  /**
   * Whether a Module with this id exists in the graph at all (XSPEC-373 B4).
   *
   * `specs: []` had two completely different meanings and no way to tell them
   * apart: "this file is indexed and declares no spec" and "this file is not
   * in the graph — wrong path, or never indexed". The outputs were
   * byte-for-byte identical, so a mistyped or differently-rooted path looked
   * exactly like an honest empty answer.
   *
   * Module nodes are only ever created by the extractor from a real file, so
   * unlike Spec this needs no origin/provenance field to be trustworthy — a
   * Module either was indexed or was not.
   */
  moduleFound: boolean;
  /**
   * Set when the caller's path did not match exactly but resolved to exactly
   * one module by path suffix — e.g. an absolute path, or one typed from a
   * subdirectory. Absent on an exact match.
   */
  resolvedFrom?: string;
  /**
   * Set when the caller's path matched several modules by suffix and was
   * therefore NOT resolved. Ambiguity is reported, never silently picked.
   */
  ambiguousMatches?: string[];
}

/**
 * Normalise a user-typed path toward the shape module ids use: POSIX
 * separators, no `./`, no leading `/`.
 *
 * Applied HERE rather than at the CLI so both entry points get it — the MCP
 * tool called `implementedSpecs` with the raw string and did not even apply
 * `toPosixPath`, so the same query behaved differently depending on whether a
 * human or an agent asked it (XSPEC-373 B4).
 */
function normalizeModulePath(p: string): string {
  return toPosixPath(p).replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * code → spec: specs a file (`moduleId` = its indexed path) declares it
 * implements.
 *
 * Module ids are repo-relative POSIX paths, but users type what they have: an
 * absolute path from an editor, a `./`-prefixed one from tab completion, or a
 * path relative to a subdirectory they happen to be standing in. All of those
 * previously produced an empty result indistinguishable from a real one, so a
 * path that merely does not match falls back to a unique suffix match, and a
 * genuinely absent module now says so (XSPEC-373 B4).
 */
export async function implementedSpecs(
  conn: GraphConnection,
  moduleId: string,
): Promise<ImplementedSpecsResult> {
  const wanted = normalizeModulePath(moduleId);

  const exists = async (id: string): Promise<boolean> =>
    (await conn.query(`MATCH (m:Module {id: $id}) RETURN m.id AS id`, { id })).length > 0;

  let resolved = wanted;
  let resolvedFrom: string | undefined;
  if (!(await exists(wanted))) {
    // Both directions, because the mismatch runs both ways: a user pasting an
    // ABSOLUTE path gives something longer than the id (`…/project/src/a.ts`
    // vs `src/a.ts`), while a user typing a bare filename gives something
    // shorter (`a.ts` vs `src/a.ts`). Comparison is on a path BOUNDARY, so
    // `auth.ts` never matches `oauth.ts` — only whole trailing segments count.
    const rows = await conn.query(`MATCH (m:Module) RETURN m.id AS id`);
    const all = rows.map((r) => String(r.id));
    const matches = all.filter(
      (id) => id === wanted || id.endsWith(`/${wanted}`) || wanted.endsWith(`/${id}`),
    );
    if (matches.length === 1 && matches[0]) {
      resolved = matches[0];
      resolvedFrom = moduleId;
    } else if (matches.length > 1) {
      return { module: wanted, specs: [], moduleFound: false, ambiguousMatches: matches.sort() };
    } else {
      return { module: wanted, specs: [], moduleFound: false };
    }
  }

  const rows = await conn.query(
    `MATCH (m:Module {id: $moduleId})-[:IMPLEMENTS]->(s:Spec)
     RETURN s.id AS id, s.title AS title
     ORDER BY id`,
    { moduleId: resolved },
  );
  const specs = rows.map((r) => ({
    id: String(r.id),
    title: r.title == null ? null : String(r.title),
  }));
  return { module: resolved, specs, moduleFound: true, ...(resolvedFrom ? { resolvedFrom } : {}) };
}
