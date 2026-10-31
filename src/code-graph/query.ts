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
 *
 * Name reuse is answered, not refused, and not hidden (XSPEC-514 R1): the answer
 * says how many definitions it combined and where they are, and `file` narrows it
 * to the definition(s) in one file. A `file` that holds no such definition is an
 * error — an empty list would read as "nobody calls it".
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

/** One Function node that carries the queried name (XSPEC-514 R1). */
export interface FunctionDefinition {
  id: string;
  /** The module id of the defining file (a repo-relative path, root-qualified when two roots share it). */
  file: string;
  /** 1-based line of the definition, or null when the graph holds none. */
  startLine: number | null;
}

/**
 * Which definitions a callers/callees answer is made of (XSPEC-514 R1).
 *
 * The queries match `Function {name}`, so every function of that name answered
 * together and nothing in the result said so. These fields are the statement.
 */
export interface DefinitionScope {
  /** Every definition of the queried name in the graph, ordered by file and line. */
  definitions: FunctionDefinition[];
  /**
   * How many definitions this answer combines: all of them when no `file` was
   * given, otherwise the ones in that file (usually one; several when a file
   * defines the name more than once, which a file cannot tell apart).
   */
  mergedDefinitions: number;
  /** The file the answer was narrowed to, exactly as stored. Absent when none was asked. */
  file?: string;
}

export interface CallChainResult extends DefinitionScope {
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

/**
 * The pattern that names the definition(s) being asked about. With `file`, only
 * the Function nodes of that name stored under that file match; the parameters
 * are bound, never spliced into the query text.
 */
function targetPattern(file: string | undefined): { match: string; params: Record<string, unknown> } {
  return file === undefined
    ? { match: "{name: $name}", params: {} }
    : { match: "{name: $name, file: $file}", params: { file } };
}

/**
 * Functions that (transitively, up to `depth`) call `name`. `file` is the stored
 * file of the definition to ask about (see {@link resolveDefinitionFile}); without
 * it every definition of the name answers together.
 */
export async function callers(
  conn: GraphConnection,
  name: string,
  depth = 1,
  file?: string,
): Promise<CallNode[]> {
  const d = safeDepth(depth);
  const t = targetPattern(file);
  const rows = await conn.query(
    `MATCH (c:Function)-[:CALLS*1..${d}]->(f:Function ${t.match})
     RETURN DISTINCT c.id AS id, c.name AS name, c.file AS file
     ORDER BY file, name`,
    { name, ...t.params },
  );
  return toNodes(rows);
}

/** Functions that `name` (transitively, up to `depth`) calls. `file` as in {@link callers}. */
export async function callees(
  conn: GraphConnection,
  name: string,
  depth = 1,
  file?: string,
): Promise<CallNode[]> {
  const d = safeDepth(depth);
  const t = targetPattern(file);
  const rows = await conn.query(
    `MATCH (f:Function ${t.match})-[:CALLS*1..${d}]->(g:Function)
     RETURN DISTINCT g.id AS id, g.name AS name, g.file AS file
     ORDER BY file, name`,
    { name, ...t.params },
  );
  return toNodes(rows);
}

/** Every Function node named `name`, ordered by file and line (XSPEC-514 R1). */
export async function functionDefinitions(conn: GraphConnection, name: string): Promise<FunctionDefinition[]> {
  const rows = await conn.query(
    `MATCH (f:Function {name: $name})
     RETURN f.id AS id, f.file AS file, f.start_line AS line
     ORDER BY file, line, id`,
    { name },
  );
  return rows.map((r) => ({
    id: String(r.id),
    file: String(r.file),
    startLine: r.line == null ? null : Number(r.line),
  }));
}

/**
 * The `file` given for a symbol matched no definition, or matched several files
 * and so was not resolved. Mapped to a non-zero exit by the CLI, to `isError` by
 * MCP: an unmatched file must never come back as an empty caller list (XSPEC-514 R1).
 */
export class DefinitionFileError extends Error {
  readonly kind: "none" | "ambiguous";
  readonly symbol: string;
  readonly wanted: string;
  /** The files that do define the symbol (kind none), or the ones the path matched (kind ambiguous). */
  readonly candidates: string[];

  constructor(kind: "none" | "ambiguous", symbol: string, wanted: string, candidates: string[]) {
    const list = candidates.map((c) => `\n  ${c}`).join("");
    super(
      kind === "none"
        ? `"${symbol}" has no definition in "${wanted}" — this is not the same as "nothing calls it"; it is defined in:${list}\n` +
            `Check the path, or leave out the file to ask about every definition.`
        : `"${wanted}" is ambiguous for "${symbol}" — ${candidates.length} definitions are in files that end with this path:${list}\n` +
            `Give more of the path.`,
    );
    this.name = "DefinitionFileError";
    this.kind = kind;
    this.symbol = symbol;
    this.wanted = wanted;
    this.candidates = candidates;
  }
}

/**
 * Turn the path a user typed into the stored file of one of `definitions`.
 *
 * Same tolerance as `implemented-by`: POSIX separators, no `./`, no leading `/`,
 * and — when the exact id is not a definition file — a match on a whole trailing
 * path segment in either direction (an absolute path from an editor is longer than
 * the id; a bare file name is shorter). `render.ts` never matches `prerender.ts`.
 * An exact id wins over a suffix match. No match, or a suffix that fits several
 * files, throws {@link DefinitionFileError}; nothing is guessed.
 */
export function resolveDefinitionFile(
  definitions: readonly FunctionDefinition[],
  symbol: string,
  wanted: string,
): string {
  const w = normalizeModulePath(wanted);
  const files = [...new Set(definitions.map((d) => d.file))].sort();
  if (files.includes(w)) return w;
  const matches = files.filter((id) => id.endsWith(`/${w}`) || w.endsWith(`/${id}`));
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length > 1) throw new DefinitionFileError("ambiguous", symbol, wanted, matches);
  throw new DefinitionFileError("none", symbol, wanted, files);
}

/**
 * Which definitions a question about `name` covers: all of them, or — with `file`
 * — the ones in that file. Throws {@link DefinitionFileError} for a `file` that
 * names none of them. A name with no definition at all gives an empty scope; the
 * entry points that must refuse an unknown name ask `requireFunction` first.
 */
export async function definitionScope(conn: GraphConnection, name: string, file?: string): Promise<DefinitionScope> {
  const definitions = await functionDefinitions(conn, name);
  if (file === undefined) return { definitions, mergedDefinitions: definitions.length };
  const stored = resolveDefinitionFile(definitions, name, file);
  return { definitions, mergedDefinitions: definitions.filter((d) => d.file === stored).length, file: stored };
}

/**
 * One sentence for a human reader about what a callers/callees answer combines,
 * or `""` when it is the answer of exactly one definition that nothing narrowed
 * (then there is nothing to say and the output stays as it always was).
 */
export function describeDefinitionScope(scope: DefinitionScope, symbol: string): string {
  const where = (d: FunctionDefinition) => (d.startLine === null ? d.file : `${d.file}:${d.startLine}`);
  const { definitions, mergedDefinitions, file } = scope;
  if (file !== undefined) {
    const mine = definitions.filter((d) => d.file === file);
    const others = definitions.length - mine.length;
    if (mine.length > 1) {
      return (
        `⚠ merged: "${symbol}" is defined ${mine.length} times in ${file} (${mine.map(where).join(", ")}); ` +
        `a file cannot tell them apart, so this answer combines all ${mine.length}.`
      );
    }
    return others > 0 ? `narrowed to the definition at ${where(mine[0]!)} (1 of ${definitions.length} definitions of "${symbol}").` : "";
  }
  if (mergedDefinitions > 1) {
    return (
      `⚠ merged: "${symbol}" is defined ${mergedDefinitions} times (${definitions.map(where).join(", ")}); ` +
      `this answer combines all ${mergedDefinitions}. Narrow it to one with --file <path>.`
    );
  }
  return "";
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

/**
 * Combined call chain for a symbol. `file` narrows it to the definition(s) in that
 * file, for callers and callees alike (see {@link definitionScope}).
 */
export async function callChain(
  conn: GraphConnection,
  symbol: string,
  direction: CallDirection = "both",
  depth = 1,
  file?: string,
): Promise<CallChainResult> {
  const d = safeDepth(depth);
  const wantCallers = direction === "callers" || direction === "both";
  const wantCallees = direction === "callees" || direction === "both";
  const scope = await definitionScope(conn, symbol, file);
  return {
    symbol,
    direction,
    depth: d,
    ...scope,
    callers: wantCallers ? await callers(conn, symbol, d, scope.file) : [],
    callees: wantCallees ? await callees(conn, symbol, d, scope.file) : [],
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
