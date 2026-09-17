/**
 * Structural memory — god nodes (importance ranking), community detection,
 * and seed-anchored related-node ranking over the whole code + knowledge
 * graph.
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
import { ALGO_EXTENSION_VERSION, algoLoadStatement, currentBundledAlgo } from "./algo-extension.js";
import { NODE_TABLES, REL_TABLES } from "../graph-db/schema.js";

const PROJECTED_GRAPH = "egr_structural";
const FUNCTION_PROJECTED_GRAPH = "egr_structural_functions";
const RELATED_PROJECTED_GRAPH = "egr_structural_related";
const ALL_RELS_PATTERN = REL_TABLES.join("|");

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

export interface RelatedNode {
  id: string;
  label: string;
  name: string;
  rank: number;
}

function isAlreadyProjectedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already exists/i.test(message);
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 10;
  return Math.min(Math.max(Math.trunc(limit), 1), 1000);
}

function clampDepth(depth: number): number {
  if (!Number.isFinite(depth)) return 2;
  return Math.min(Math.max(Math.trunc(depth), 1), 10);
}

/** Escape a node id for interpolation into a Cypher string literal / IN-list. */
function cypherString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// `INSTALL ALGO` registers the extension at the process/binary level (not
// connection-scoped) — repeating it on every connection is redundant and,
// empirically, repeating it across many short-lived connections in one
// process eventually crashes the native addon (observed in this repo's own
// test suite past ~8 connections). `LOAD EXTENSION` still runs every call:
// it is connection-scoped and cheap.
let algoInstalled = false;

/**
 * The three commands that need this extension, named so the error below can
 * tell the reader which part of `egr` just became unavailable rather than
 * leaving them to work it out from a stack trace.
 */
const ALGO_BACKED_COMMANDS = "god-nodes, communities, related";

const ALGO_OFFLINE_HELP = [
  `This is the only part of egr that reaches the network. INSTALL ALGO downloads`,
  `ryugraph's graph-algorithm extension from extension.ryugraph.io on first use;`,
  `every other command (index, callers, callees, top, impact, implementers,`,
  `implemented-by, blindspots, signatures) works fully offline.`,
  ``,
  `If this machine cannot reach that host, build the extension from the source`,
  `that ships inside ryugraph and drop it where ryugraph looks for it:`,
  ``,
  `  cd node_modules/ryugraph/ryu-source`,
  `  make extension-release EXTENSION_LIST=algo`,
  `  mkdir -p ~/.ryu/extension/<ryugraph-version>/<platform>/algo`,
  `  cp extension/algo/build/libalgo.ryu_extension ~/.ryu/extension/<ryugraph-version>/<platform>/algo/`,
  ``,
  `<platform> is e.g. linux_amd64, win_amd64, osx_arm64 — the error above names`,
  `the exact path this install expected. Building needs cmake and a C++ compiler.`,
  ``,
  `On Windows the directory is under %USERPROFILE%, not ~ — in PowerShell:`,
  ``,
  `  New-Item -ItemType Directory -Force "$env:USERPROFILE\.ryu\extension\<ryugraph-version>\win_amd64\algo"`,
  `  Copy-Item libalgo.ryu_extension "$env:USERPROFILE\.ryu\extension\<ryugraph-version>\win_amd64\algo\"`,
  ``,
  `A libalgo.ryu_extension built for the same <ryugraph-version> and platform on any`,
  `machine can be copied in this way; the build steps above have not been verified on Windows.`,
].join("\n");

/**
 * Load the ryugraph ALGO extension for this connection.
 *
 * First choice (XSPEC-416): the prebuilt extension from this platform's
 * `@asiaostrich/engramgraph-algo-*` package, loaded by path. No INSTALL, no
 * network — the case a corporate intranet needs. If that package is present
 * but its file will not load, the error says so: falling back to a download
 * would hide a broken package behind the very failure it exists to prevent.
 *
 * Otherwise `INSTALL ALGO` (once per process) + `LOAD EXTENSION ALGO` (every
 * call), which downloads on first use. When that fails, the message names the
 * package this platform should have had, first — an npm mirror that did not
 * sync optional dependencies looks exactly like "no network" otherwise.
 */
async function ensureAlgoExtension(conn: GraphConnection): Promise<void> {
  const bundled = currentBundledAlgo();
  if (bundled.path) {
    try {
      await conn.execute(algoLoadStatement(bundled.path));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${ALGO_BACKED_COMMANDS} need ryugraph's ALGO extension. ${bundled.pkg} is installed but its extension did not load:\n` +
          `  ${message}\n  file: ${bundled.path}\n\n` +
          `Reinstall engramgraph so npm refetches ${bundled.pkg}; it must match ryugraph extension version ${ALGO_EXTENSION_VERSION}.`,
        { cause: err },
      );
    }
    await forgetLoadedExtensionPath(conn);
    return;
  }

  if (!algoInstalled) {
    try {
      await conn.execute(`INSTALL ALGO;`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const missing = bundled.pkg
        ? `${bundled.pkg} is not installed, so ${ALGO_BACKED_COMMANDS} fell back to downloading ryugraph's ALGO extension, and that failed.\n` +
          `  ${message}\n\n` +
          `engramgraph lists ${bundled.pkg} as an optional dependency, so a normal install includes it. If it is missing, ` +
          `your npm mirror or proxy may not have synced it — check that the mirror serves ${bundled.pkg}@${ALGO_EXTENSION_VERSION}, then reinstall engramgraph.\n\n`
        : `No prebuilt ALGO extension exists for ${process.platform}-${process.arch}, so ${ALGO_BACKED_COMMANDS} need to download it, and that failed:\n` +
          `  ${message}\n\n`;
      throw new Error(`${missing}${ALGO_OFFLINE_HELP}`, { cause: err });
    }
    algoInstalled = true;
  }
  await conn.execute(`LOAD EXTENSION ALGO;`);
  await forgetLoadedExtensionPath(conn);
}

/**
 * Checkpoint right after a LOAD EXTENSION, so the graph does not remember where
 * the extension file was.
 *
 * ryugraph writes the load — with the file's absolute path, even for a load by
 * name from `~/.ryu` — into the WAL, and replays it every time the database
 * opens. egr exits without checkpointing, so that record stays. Once the file
 * moves (a Node version switch, a reinstall, a new global prefix, a cleared
 * `~/.ryu`), every command on that graph fails with "Failed to load library",
 * including ones that never use ALGO. Measured 2026-09-17: reproduced with a
 * bare ryugraph script; a CHECKPOINT after the load removed the record and the
 * graph reopened with the file gone. Closing the connection hides the defect,
 * because close checkpoints too.
 *
 * A read-only connection writes no such record (measured the same day: the file
 * removed, the graph reopened) and cannot checkpoint — trying would replace the
 * read-only refusal a caller should see with an IO error.
 */
async function forgetLoadedExtensionPath(conn: GraphConnection): Promise<void> {
  if (conn.readOnly) return;
  await conn.execute(`CHECKPOINT;`);
}

/** Test hook: forget that INSTALL ALGO ran in this process. */
export function resetAlgoStateForTests(): void {
  algoInstalled = false;
}

/**
 * Project the whole schema (every NODE/REL table) as `egr_structural` so
 * `page_rank`/`louvain` can traverse across code and knowledge nodes in one
 * call. Projected graphs are connection-scoped (dropped when the connection
 * closes), so this is idempotent per-connection, mirroring the
 * already-exists tolerance in {@link initSchema}.
 */
async function ensureProjectedGraph(conn: GraphConnection): Promise<void> {
  await ensureAlgoExtension(conn);

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
  await ensureAlgoExtension(conn);
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

/**
 * Nodes structurally important *around a specific seed* — an approximation
 * of personalized/seeded PageRank (the mechanism HippoRAG/DEC-028 uses for
 * query-time associative retrieval), built entirely from primitives this
 * repo already has rather than a hand-written iterative algorithm:
 *
 *   1. undirected BFS from the seed, across every relationship type, up to
 *      `depth` hops (same `MATCH ... *0..N` shape as {@link callers}, but
 *      unrestricted to one rel type — verified empirically that ryugraph's
 *      Cypher accepts a `|`-union of rel types in a variable-length pattern);
 *   2. a projected graph filtered down to just that neighbourhood's ids
 *      (`PROJECT_GRAPH` with a per-table `id IN [...]` predicate);
 *   3. global {@link godNodes}-style PageRank run *only* on that small
 *      subgraph, so importance is computed relative to the neighbourhood,
 *      not the whole graph.
 *
 * This is a coarser approximation than true personalized PageRank (a hard
 * depth cutoff instead of a graduated restart-probability decay), and it
 * still requires a concrete seed id — turning a free-text query into good
 * seed ids (HippoRAG's OpenIE + fact-reranking layer) is a separate,
 * unimplemented capability this function does not attempt.
 */
export async function related(
  conn: GraphConnection,
  seedId: string,
  depth = 2,
  limit = 10,
): Promise<RelatedNode[]> {
  const d = clampDepth(depth);
  const lim = clampLimit(limit);

  const neighborhood = await conn.query(
    `MATCH (seed {id: $seedId})-[:${ALL_RELS_PATTERN}*0..${d}]-(n)
     RETURN DISTINCT n.id AS id, label(n) AS label`,
    { seedId },
  );
  if (neighborhood.length === 0) return []; // seed not found, or isolated with no neighbours

  await ensureAlgoExtension(conn);
  try {
    await conn.execute(`CALL DROP_PROJECTED_GRAPH('${RELATED_PROJECTED_GRAPH}')`);
  } catch {
    // no prior projection under this name on this connection — fine
  }

  const ids = neighborhood.map((r) => cypherString(String(r.id))).join(", ");
  const nodeFilters = NODE_TABLES.map((t) => `'${t}': 'n.id IN [${ids}]'`).join(", ");
  await conn.execute(
    `CALL PROJECT_GRAPH('${RELATED_PROJECTED_GRAPH}', {${nodeFilters}}, [${REL_TABLES.map((t) => `'${t}'`).join(", ")}])`,
  );

  const rows = await conn.query(
    `CALL page_rank('${RELATED_PROJECTED_GRAPH}')
     RETURN node.id AS id, label(node) AS label, rank
     ORDER BY rank DESC`,
  );

  const refs = rows.map((r) => ({ id: String(r.id), label: String(r.label) }));
  const names = await resolveNames(conn, refs);

  return rows
    .map((r) => {
      const id = String(r.id);
      const label = String(r.label);
      return { id, label, name: names.get(id) ?? id, rank: Number(r.rank) };
    })
    .filter((n) => n.id !== seedId) // the seed itself is not a "related" result
    .slice(0, lim);
}
