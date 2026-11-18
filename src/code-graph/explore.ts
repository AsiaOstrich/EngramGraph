// implements XSPEC-531
/**
 * `explore` — one call that takes a sentence ("how does X work", "where is Y handled") and returns the area of code
 * it is about: the symbols, how they call each other, and their source (XSPEC-531).
 *
 * ## Why it exists
 *
 * Every other query needs a name the asker does not have yet (`call_chain` a function, `impact_analysis` a spec id,
 * `related` a node id). In the #91 trial an assistant asked how something works used none of them in 16 runs and went
 * to grep. This takes the sentence.
 *
 * ## What it does, with no model
 *
 *  1. Cut the sentence into words the way names are written (camelCase, snake_case, runs of capitals, plurals and
 *     tenses folded), dropping question words. {@link keywordsOf}.
 *  2. Find SEEDS: the functions and classes whose name, or failing that whose file path, carries those words. A name
 *     hit weighs 3, a path-only hit 1, so a function called `handleHTTPRequest` beats everything in a folder called
 *     `request/`. At most {@link SEED_CAP} seeds. An empty seed set is answered "no match" (it is NOT padded with
 *     "important" nodes: an answer about nothing would read as an answer).
 *  3. Expand from the seeds along CALLS, both directions, {@link EXPAND_DEPTH} hops. DEFINES ties each function to its
 *     file and IMPORTS ties files to files; both feed the ranking and IMPORTS also names the files next door that
 *     were not expanded.
 *  4. Rank by seeded PageRank: random-walk-with-restart from the seeds over that small neighbourhood. This is the
 *     same idea as `related`, and it is computed here, in process, on purpose — see below.
 *  5. Read the source of each symbol from the file, between its recorded start line and the next definition in that
 *     file (at most {@link MAX_SNIPPET_LINES} lines).
 *
 * ## Why this does not call `related`
 *
 * `related` installs the algo extension and builds a projected graph — it WRITES (XSPEC-374; it is why the stdio
 * server does not offer it and why `READ_ONLY_COMMANDS` does not list it). `explore` is for the assistant on the
 * stdio server, which only reads. A tool that needed the extension would not be listed there at all, and the one place
 * it is meant to be used would not have it. So the neighbourhood is read with plain MATCH queries and ranked here.
 *
 * ## The size limit is on the whole answer
 *
 * `maxChars` bounds what the caller receives (measured with the same function that prints it), not just the source
 * text, because the point of the limit is what lands in an assistant's context. When the answer does not fit it is
 * cut in a fixed order — source snippets from the least relevant symbol first, then the least relevant symbols — and
 * what was cut is NAMED under `notExpanded`, never dropped silently.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import type { GraphConnection } from "../graph-db/connection.js";
import { readIndexHealth, type IndexHealth } from "./index-health.js";
import { MCP_INDEX_ROOT, readManifest, type ParseManifest } from "./parse-manifest.js";
import { toPosixPath } from "./path-utils.js";

export const DEFAULT_EXPLORE_LIMIT = 12;
export const MAX_EXPLORE_LIMIT = 50;
export const DEFAULT_EXPLORE_MAX_CHARS = 6000;
/** Below this the answer could not hold its own frame (status, words, a few names), so the budget is raised to it and the answer says so. */
export const MIN_EXPLORE_MAX_CHARS = 400;
export const MAX_EXPLORE_MAX_CHARS = 200_000;

const SEED_CAP = 8;
const EXPAND_DEPTH = 2;
/** Most functions the neighbourhood may hold; past it the walk stops widening and says so. */
const NEIGHBOURHOOD_CAP = 300;
const MAX_SNIPPET_LINES = 40;
/** A snippet shorter than this many lines is not worth showing cut (unless the function itself is shorter). */
const MIN_USEFUL_SNIPPET_LINES = 3;
/** What one snippet is worth, in characters, when deciding how many symbols get source at all. */
const TARGET_SNIPPET_CHARS = 500;
const MAX_CLASSES = 3;
const MAX_PATHS = 6;
const MAX_PATH_LENGTH = 8;
const LIST_CAP = 10;
const MAX_SOURCE_BYTES = 1_500_000;
const MAX_KEYWORDS = 10;

// ---------------------------------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------------------------------

/** Words of a question that say nothing about the code. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "how", "what", "where", "when", "why", "which", "who", "whom", "whose",
  "does", "do", "did", "doing", "done", "is", "are", "was", "were", "be", "been", "being", "am",
  "it", "its", "the", "an", "of", "in", "on", "at", "to", "for", "from", "with", "by", "as",
  "and", "or", "but", "not", "no", "so", "if", "then", "than", "such", "also", "just", "only", "very",
  "through", "into", "onto", "about", "over", "under", "between", "this", "that", "these", "those", "there", "here",
  "can", "could", "should", "would", "will", "shall", "may", "might", "must", "has", "have", "had", "having",
  "we", "you", "they", "he", "she", "them", "our", "your", "their", "my", "me", "us", "all", "any", "each",
  "work", "works", "worked", "working", "code", "function", "functions", "method", "methods", "file", "files",
  "tell", "show", "explain", "find", "get", "gets",
]);

/** Lower-cased words of `text`: split at non-letters, camelCase boundaries and the end of a run of capitals (`HTTPRequest` -> `http`, `request`). */
function splitWords(text: string): string[] {
  return text
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

/**
 * Fold plural, tense and a trailing `e` so `routing`, `routes` and `route` meet: all three become `rout`. Deliberately
 * crude and symmetric — it is applied to the question AND to names, so what matters is that both sides agree, not that
 * the result is a word.
 */
export function stemOf(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("es")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** A question stem meets a name stem when they are equal, or when one starts with the other and both are at least 4 long (`rout` ~ `router`, `config` ~ `configuration`; `use` ~ `because` never). */
export function stemsMatch(query: string, name: string): boolean {
  if (query === name) return true;
  if (query.length < 4 || name.length < 4) return false;
  return query.startsWith(name) || name.startsWith(query);
}

/** The searchable words of a question, lower-cased as written, in order, each once. Empty when nothing is left after the question words. */
export function keywordsOf(topic: string): string[] {
  const out: string[] = [];
  for (const w of splitWords(topic)) {
    if (w.length < 2 || STOP_WORDS.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

/** The stems of {@link keywordsOf}, each once. */
export function keywordStems(topic: string): string[] {
  return [...new Set(keywordsOf(topic).map(stemOf))];
}

/** The stems of the words a name or path is written in. */
export function nameStems(name: string): string[] {
  return splitWords(name).map(stemOf);
}

// ---------------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------------

export interface ExploreSymbol {
  name: string;
  kind: "Function" | "Class";
  /** The module id of the defining file, as stored. */
  file: string;
  /** 1-based line of the definition; absent for a class (the graph keeps none) or a function indexed without one. */
  line?: number;
  /** `seed`: matched the words. `neighbor`: reached by calls from a seed. */
  role: "seed" | "neighbor";
  /** Seeded-PageRank share of the neighbourhood, 0..1. Comparable within one answer only. */
  rank: number;
  /** The source, from the symbol's line to the next definition in its file (cut at {@link MAX_SNIPPET_LINES}, or at the size limit, saying so). */
  snippet?: string;
  /** Why there is no `snippet` when one could have been shown (file unknown, moved, changed since indexing). */
  snippetNote?: string;
}

export interface NotExpanded {
  /** Symbols found but not listed (`name (file:line)`), at most {@link LIST_CAP} of them. */
  symbols: string[];
  symbolsTotal: number;
  /** Listed symbols whose source was left out to stay within the size limit. */
  snippets: string[];
  snippetsTotal: number;
  /** Files imported by, or importing, a seed's file, that were not expanded. */
  files: string[];
  filesTotal: number;
}

export interface ExploreResult {
  status: "ok" | "no-match";
  topic: string;
  keywords: string[];
  /** How many functions/classes matched the words, and how many of them were used as seeds. */
  matches: { total: number; seeds: number };
  truncated: boolean;
  /** The limit in force (a request below {@link MIN_EXPLORE_MAX_CHARS} is raised to it). */
  maxChars: number;
  symbols: ExploreSymbol[];
  /** Call chains among the listed symbols, `A → B → C`, most relevant first. */
  callPaths: string[];
  /** Point queries that continue from here, written as MCP tool calls. */
  next: string[];
  notExpanded?: NotExpanded;
  /** Present when the parse-health manifest says the answer may rest on files that did not parse (same field as the point queries). */
  indexHealth?: IndexHealth;
  /** Only with `status: "no-match"`: what was looked for and what is not being claimed. */
  message?: string;
}

export interface ExploreOptions {
  topic: string;
  /** Restrict the seeds to files under this path (a directory or file, as a module id, or its trailing part). */
  path?: string;
  limit?: number;
  maxChars?: number;
  /** The graph's parse-health manifest: gives the index roots (where the source is) and the index health. Without it no source can be shown. */
  manifestPath?: string;
  /** How the caller will print the result; the size limit is checked with it. Default: pretty JSON, which is what the MCP tool returns. */
  measure?: (r: ExploreResult) => number;
}

// ---------------------------------------------------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------------------------------------------------

interface Found {
  id: string;
  name: string;
  kind: "Function" | "Class";
  file: string | null;
  line: number | null;
}

interface Seed extends Found {
  score: number;
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const int = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

function inScope(file: string | null, scope: string | undefined): boolean {
  if (scope === undefined) return true;
  if (file === null) return false;
  const p = toPosixPath(scope).replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (p === "") return true;
  return file === p || file.startsWith(`${p}/`) || file.includes(`/${p}/`) || file.endsWith(`/${p}`);
}

/**
 * The functions and classes the words point at, best first. Names are fetched with a cheap substring pre-filter on the
 * first four letters of each stem and then judged word by word in code, so `use` does not match `because`.
 *
 * THIS is the seam the whole tool hangs on: with no seed there is nothing to expand, rank or read.
 */
export async function findSeeds(conn: GraphConnection, stems: readonly string[], scope?: string): Promise<{ seeds: Seed[]; total: number }> {
  const byId = new Map<string, Found>();
  for (const stem of stems) {
    const needle = stem.slice(0, Math.min(stem.length, 4));
    const fns = await conn.query(
      `MATCH (n:Function) WHERE lower(n.name) CONTAINS $needle OR lower(n.file) CONTAINS $needle
       RETURN n.id AS id, n.name AS name, n.file AS file, n.start_line AS line`,
      { needle },
    );
    for (const r of fns) byId.set(String(r.id), { id: String(r.id), name: String(r.name), kind: "Function", file: str(r.file), line: int(r.line) });
    const classes = await conn.query(
      `MATCH (n:Class) WHERE lower(n.name) CONTAINS $needle OR lower(n.file) CONTAINS $needle
       RETURN n.id AS id, n.name AS name, n.file AS file`,
      { needle },
    );
    for (const r of classes) byId.set(String(r.id), { id: String(r.id), name: String(r.name), kind: "Class", file: str(r.file), line: null });
  }
  const scored: Seed[] = [];
  for (const c of byId.values()) {
    if (!inScope(c.file, scope)) continue;
    const nameT = nameStems(c.name);
    const fileT = c.file === null ? [] : nameStems(c.file);
    let nameHits = 0;
    let pathHits = 0;
    for (const q of stems) {
      if (nameT.some((n) => stemsMatch(q, n))) nameHits += 1;
      else if (fileT.some((n) => stemsMatch(q, n))) pathHits += 1;
    }
    const score = 3 * nameHits + pathHits;
    if (score > 0) scored.push({ ...c, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.kind === b.kind ? 0 : a.kind === "Function" ? -1 : 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { seeds: scored.slice(0, SEED_CAP), total: scored.length };
}

// ---------------------------------------------------------------------------------------------------------------------
// Neighbourhood and ranking
// ---------------------------------------------------------------------------------------------------------------------

interface Neighbourhood {
  fns: Map<string, Found>;
  /** Directed CALLS edges, both ends inside `fns`. */
  calls: Array<[string, string]>;
  capped: boolean;
}

async function expandCalls(conn: GraphConnection, seeds: readonly Seed[]): Promise<Neighbourhood> {
  const visited = new Set(seeds.filter((s) => s.kind === "Function").map((s) => s.id));
  const edges = new Map<string, [string, string]>();
  let frontier = [...visited];
  let capped = false;
  for (let level = 0; level < EXPAND_DEPTH && frontier.length > 0; level += 1) {
    const rows = await conn.query(
      `MATCH (a:Function)-[:CALLS]->(b:Function) WHERE a.id IN $ids OR b.id IN $ids RETURN DISTINCT a.id AS a, b.id AS b`,
      { ids: frontier },
    );
    const next: string[] = [];
    for (const r of rows) {
      const a = String(r.a);
      const b = String(r.b);
      edges.set(`${a}\u0000${b}`, [a, b]);
      for (const x of [a, b]) {
        if (visited.has(x)) continue;
        if (visited.size >= NEIGHBOURHOOD_CAP) {
          capped = true;
          continue;
        }
        visited.add(x);
        next.push(x);
      }
    }
    frontier = next;
  }
  const ids = [...visited];
  const fns = new Map<string, Found>();
  if (ids.length > 0) {
    const rows = await conn.query(
      `MATCH (n:Function) WHERE n.id IN $ids RETURN n.id AS id, n.name AS name, n.file AS file, n.start_line AS line`,
      { ids },
    );
    for (const r of rows) fns.set(String(r.id), { id: String(r.id), name: String(r.name), kind: "Function", file: str(r.file), line: int(r.line) });
  }
  const calls = [...edges.values()].filter(([a, b]) => fns.has(a) && fns.has(b));
  return { fns, calls, capped };
}

/**
 * Random walk with restart on an undirected weighted graph: the share of time a walker that jumps back to the seeds
 * with probability 1-d spends at each node. Mass sitting on a node with no edges goes back to the seeds, so the
 * result sums to 1.
 */
function seededPageRank(nodes: readonly string[], edges: ReadonlyArray<[string, string, number]>, restart: ReadonlyMap<string, number>, d = 0.85, iterations = 50): Map<string, number> {
  const adj = new Map<string, Array<[string, number]>>(nodes.map((n) => [n, []]));
  for (const [a, b, w] of edges) {
    if (a === b || !adj.has(a) || !adj.has(b)) continue;
    adj.get(a)!.push([b, w]);
    adj.get(b)!.push([a, w]);
  }
  const weight = new Map<string, number>();
  for (const [n, list] of adj) weight.set(n, list.reduce((s, [, w]) => s + w, 0));
  const total = [...restart.values()].reduce((s, v) => s + v, 0) || 1;
  const r = new Map<string, number>(nodes.map((n) => [n, (restart.get(n) ?? 0) / total]));
  let p = new Map(r);
  for (let i = 0; i < iterations; i += 1) {
    const q = new Map<string, number>(nodes.map((n) => [n, (1 - d) * (r.get(n) ?? 0)]));
    let dangling = 0;
    for (const n of nodes) {
      const pn = p.get(n) ?? 0;
      const w = weight.get(n) ?? 0;
      if (w === 0) {
        dangling += pn;
        continue;
      }
      for (const [m, wm] of adj.get(n)!) q.set(m, (q.get(m) ?? 0) + (d * pn * wm) / w);
    }
    if (dangling > 0) for (const n of nodes) q.set(n, (q.get(n) ?? 0) + d * dangling * (r.get(n) ?? 0));
    p = q;
  }
  return p;
}

// ---------------------------------------------------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------------------------------------------------

/** The file on disk behind a module id, from the roots the manifest recorded. `null` when it cannot be told (an `index_code`-only graph, no manifest). */
function sourcePathOf(manifest: ParseManifest | null, moduleId: string): string | null {
  if (!manifest) return null;
  for (const [root, section] of Object.entries(manifest.runs ?? {})) {
    if (root === MCP_INDEX_ROOT) continue;
    for (const f of section.files ?? []) {
      if ((f.id ?? f.path) !== moduleId) continue;
      const abs = join(root, ...f.path.split("/"));
      const rel = relative(root, abs);
      if (rel.startsWith("..") || isAbsolute(rel)) return null; // a manifest entry must not point outside its root
      return abs;
    }
  }
  return null;
}

type SourceFile = { lines: string[] } | { note: string };

function readSource(manifest: ParseManifest | null, moduleId: string, cache: Map<string, SourceFile>): SourceFile {
  const hit = cache.get(moduleId);
  if (hit) return hit;
  const abs = sourcePathOf(manifest, moduleId);
  let result: SourceFile;
  if (abs === null) result = { note: "the source file is not known: this graph has no index root for it (it was filled through index_code, or has no parse-health manifest)" };
  else if (!existsSync(abs)) result = { note: `the source file is no longer at ${abs} (moved or deleted since it was indexed)` };
  else {
    try {
      if (statSync(abs).size > MAX_SOURCE_BYTES) result = { note: `the source file is larger than ${MAX_SOURCE_BYTES} bytes, not read` };
      else result = { lines: readFileSync(abs, "utf8").split(/\r?\n/) };
    } catch (err) {
      result = { note: `the source file could not be read: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  cache.set(moduleId, result);
  return result;
}

/** The lines of one function, or why there are none. */
async function snippetLines(conn: GraphConnection, sym: Found, manifest: ParseManifest | null, cache: Map<string, SourceFile>, startsByFile: Map<string, number[]>): Promise<{ lines: string[] } | { note: string }> {
  if (sym.file === null || sym.line === null) return { note: "the graph records no file or line for this function" };
  const src = readSource(manifest, sym.file, cache);
  if ("note" in src) return src;
  const start = sym.line;
  // A definition can start a few lines below the line the graph recorded (a decorator, a doc comment is above, not below);
  // if the name is nowhere near that line the file is not the one that was indexed.
  const head = src.lines.slice(start - 1, start + 5).join("\n");
  if (start < 1 || start > src.lines.length || !head.includes(sym.name)) {
    return { note: `the file has changed since it was indexed: line ${start} of ${sym.file} no longer holds \`${sym.name}\` (re-run \`egr index\`)` };
  }
  let starts = startsByFile.get(sym.file);
  if (!starts) {
    const rows = await conn.query(`MATCH (f:Function) WHERE f.file = $file RETURN f.start_line AS line`, { file: sym.file });
    starts = rows.map((r) => int(r.line)).filter((n): n is number => n !== null).sort((a, b) => a - b);
    startsByFile.set(sym.file, starts);
  }
  const nextStart = starts.find((n) => n > start);
  let end = Math.min(src.lines.length, start + MAX_SNIPPET_LINES - 1, nextStart !== undefined ? nextStart - 1 : Infinity);
  while (end > start && (src.lines[end - 1] ?? "").trim() === "") end -= 1;
  return { lines: src.lines.slice(start - 1, end) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Call paths
// ---------------------------------------------------------------------------------------------------------------------

function callPathsOf(ids: readonly string[], calls: ReadonlyArray<[string, string]>, label: (id: string) => string, rank: ReadonlyMap<string, number>): string[] {
  const inSet = new Set(ids);
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const [a, b] of calls) {
    if (!inSet.has(a) || !inSet.has(b) || a === b) continue;
    out.set(a, [...(out.get(a) ?? []), b]);
    indeg.set(b, (indeg.get(b) ?? 0) + 1);
  }
  const byRank = (x: string, y: string) => (rank.get(y) ?? 0) - (rank.get(x) ?? 0) || (x < y ? -1 : 1);
  let starts = ids.filter((n) => out.has(n) && !indeg.has(n)).sort(byRank);
  if (starts.length === 0) starts = ids.filter((n) => out.has(n)).sort(byRank); // a cycle has no source
  const found: string[][] = [];
  let budget = 400;
  const walk = (path: string[]): void => {
    if (budget-- <= 0) return;
    const last = path[path.length - 1]!;
    const nexts = (out.get(last) ?? []).filter((n) => !path.includes(n)).sort(byRank);
    if (nexts.length === 0 || path.length >= MAX_PATH_LENGTH) {
      if (path.length >= 2) found.push(path);
      return;
    }
    for (const n of nexts) walk([...path, n]);
  };
  for (const s of starts) walk([s]);
  const weight = (p: string[]) => p.reduce((s, n) => s + (rank.get(n) ?? 0), 0);
  found.sort((a, b) => weight(b) - weight(a) || b.length - a.length);
  return found.slice(0, MAX_PATHS).map((p) => p.map(label).join(" → "));
}

// ---------------------------------------------------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------------------------------------------------

const where = (s: { name: string; file: string; line?: number | null }): string => `${s.name} (${s.file}${s.line ? `:${s.line}` : ""})`;

const jsonMeasure = (r: ExploreResult): number => JSON.stringify(r, null, 2).length;

/** The frame of an answer that has no room for anything else. */
function minimalResult(base: ExploreResult): ExploreResult {
  return {
    status: base.status,
    topic: base.topic.length > 60 ? `${base.topic.slice(0, 57)}...` : base.topic,
    keywords: [],
    matches: base.matches,
    truncated: true,
    maxChars: base.maxChars,
    symbols: [],
    callPaths: [],
    next: [],
    message: "maxChars is too small to show results; raise it (2000 or more) or lower limit",
  };
}

export function formatExplore(r: ExploreResult): string {
  const lines: string[] = [];
  lines.push(`explore "${r.topic}": ${r.status === "no-match" ? "NO MATCH" : `${r.symbols.length} symbol(s)`}${r.keywords.length ? ` — words: ${r.keywords.join(", ")}` : ""}`);
  if (r.message) lines.push(r.message);
  if (r.indexHealth?.unavailable) lines.push(`⚠ index health unknown: the parse-health manifest could not be read (${r.indexHealth.unavailable}) — this result is unannotated, not verified`);
  else if (r.indexHealth?.possiblyIncomplete) lines.push(`⚠ possibly incomplete: ${r.indexHealth.blindspotsTotal ?? r.indexHealth.blindspots?.length ?? 0} file(s) near this result parsed partially/failed (see \`egr blindspots\`)`);
  if (r.symbols.length > 0) {
    lines.push("", "Symbols (most relevant first):");
    for (const s of r.symbols) lines.push(`  ${s.name}  ${s.kind}  ${s.file}${s.line ? `:${s.line}` : ""}  ${s.role}`);
  }
  if (r.callPaths.length > 0) {
    lines.push("", "Call paths:");
    for (const p of r.callPaths) lines.push(`  ${p}`);
  }
  const withSource = r.symbols.filter((s) => s.snippet !== undefined || s.snippetNote !== undefined);
  if (withSource.length > 0) {
    lines.push("", "Source:");
    for (const s of withSource) {
      lines.push(`--- ${s.name} (${s.file}${s.line ? `:${s.line}` : ""})`);
      lines.push(s.snippet !== undefined ? s.snippet : `(no source shown: ${s.snippetNote})`);
    }
  }
  const ne = r.notExpanded;
  if (ne && (ne.symbolsTotal > 0 || ne.snippetsTotal > 0 || ne.filesTotal > 0)) {
    lines.push("", `Not expanded${r.truncated ? ` (to stay within ${r.maxChars} characters)` : ""}:`);
    if (ne.symbolsTotal > 0) lines.push(`  symbols not listed: ${ne.symbols.join(", ")}${ne.symbolsTotal > ne.symbols.length ? ` (+${ne.symbolsTotal - ne.symbols.length} more)` : ""}`);
    if (ne.snippetsTotal > 0) lines.push(`  source left out for: ${ne.snippets.join(", ")}${ne.snippetsTotal > ne.snippets.length ? ` (+${ne.snippetsTotal - ne.snippets.length} more)` : ""}`);
    if (ne.filesTotal > 0) lines.push(`  neighbouring files (imports): ${ne.files.join(", ")}${ne.filesTotal > ne.files.length ? ` (+${ne.filesTotal - ne.files.length} more)` : ""}`);
  }
  const fnSyms = r.symbols.filter((s) => s.kind === "Function").slice(0, 3);
  if (fnSyms.length > 0) {
    lines.push("", "Next:");
    for (const s of fnSyms) lines.push(`  egr callers ${s.name}  |  egr callees ${s.name}  (add --file ${s.file} if the name is shared)`);
  }
  return lines.join("\n");
}

/**
 * Explore the area of code a sentence is about. See the module doc. Read-only: plain MATCH queries and file reads.
 *
 * Throws when the graph holds no code at all (that is not "no match") — the CLI and MCP entry points turn it into an
 * error result.
 */
export async function explore(conn: GraphConnection, opts: ExploreOptions): Promise<ExploreResult> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_EXPLORE_LIMIT), 1), MAX_EXPLORE_LIMIT);
  const requested = Math.trunc(opts.maxChars ?? DEFAULT_EXPLORE_MAX_CHARS);
  const maxChars = Math.min(Math.max(Number.isFinite(requested) ? requested : DEFAULT_EXPLORE_MAX_CHARS, MIN_EXPLORE_MAX_CHARS), MAX_EXPLORE_MAX_CHARS);
  const measure = opts.measure ?? jsonMeasure;
  const topic = opts.topic.trim();
  const words = keywordsOf(topic);
  if (words.length === 0) {
    throw new Error(
      `the topic "${topic}" has no searchable word once question words ("how", "does", "where", ...) are removed. ` +
        `Name the thing: for example "how are requests routed through the middleware chain".`,
    );
  }
  const stems = [...new Set(words.map(stemOf))];

  const { seeds, total } = await findSeeds(conn, stems, opts.path);
  const frame = { topic, keywords: words, matches: { total, seeds: seeds.length }, maxChars } as const;

  if (seeds.length === 0) {
    const anyCode = await conn.query(`MATCH (f:Function) RETURN f.id AS id LIMIT 1`);
    if (anyCode.length === 0) {
      throw new Error("the graph has no indexed code, so there is nothing to explore. Run `egr index <dir>` first.");
    }
    const scope = opts.path ? ` under "${opts.path}"` : "";
    return {
      status: "no-match",
      ...frame,
      truncated: false,
      symbols: [],
      callPaths: [],
      next: [],
      message:
        `No symbol or file path matched the words (${words.join(", ")})${scope}. This is not the same as "the code does not do this": ` +
        `the name may use other words, or the code may not be indexed. Try synonyms or a name you saw in a file, or lower the scope.`,
    };
  }

  // --- neighbourhood, files, ranking
  const hood = await expandCalls(conn, seeds);
  const seedIds = new Set(seeds.map((s) => s.id));
  const classSeeds = seeds.filter((s) => s.kind === "Class").slice(0, MAX_CLASSES);
  const fnList = [...hood.fns.values()];
  const modules = [...new Set(fnList.map((f) => f.file).filter((f): f is string => f !== null))];
  let imports: Array<[string, string]> = [];
  let neighbourFiles: string[] = [];
  if (modules.length > 0) {
    const rows = await conn.query(`MATCH (a:Module)-[:IMPORTS]->(b:Module) WHERE a.id IN $m AND b.id IN $m RETURN a.id AS a, b.id AS b`, { m: modules });
    imports = rows.map((r) => [String(r.a), String(r.b)]);
  }
  const seedFiles = [...new Set(seeds.map((s) => s.file).filter((f): f is string => f !== null))];
  if (seedFiles.length > 0) {
    const rows = await conn.query(`MATCH (a:Module)-[:IMPORTS]-(b:Module) WHERE a.id IN $m RETURN DISTINCT b.id AS id`, { m: seedFiles });
    neighbourFiles = rows.map((r) => String(r.id)).filter((id) => !modules.includes(id)).sort();
  }
  const nodeIds = [...fnList.map((f) => `fn:${f.id}`), ...modules.map((m) => `mod:${m}`), ...classSeeds.map((c) => `cls:${c.id}`)];
  const edges: Array<[string, string, number]> = [
    ...hood.calls.map(([a, b]): [string, string, number] => [`fn:${a}`, `fn:${b}`, 1]),
    ...fnList.filter((f) => f.file !== null).map((f): [string, string, number] => [`mod:${f.file}`, `fn:${f.id}`, 0.3]),
    ...imports.map(([a, b]): [string, string, number] => [`mod:${a}`, `mod:${b}`, 0.3]),
  ];
  const restart = new Map<string, number>(seeds.map((s) => [`${s.kind === "Class" ? "cls" : "fn"}:${s.id}`, s.score]));
  const pr = seededPageRank(nodeIds, edges, restart);

  // --- symbols, most relevant first: functions by rank, then the classes the words named
  const idOfSymbol = new Map<ExploreSymbol, string>();
  const fnEntries = fnList.map((f) => ({
    id: f.id,
    sym: { name: f.name, kind: "Function", file: f.file ?? "(unknown)", ...(f.line !== null ? { line: f.line } : {}), role: seedIds.has(f.id) ? "seed" : "neighbor", rank: pr.get(`fn:${f.id}`) ?? 0 } as ExploreSymbol,
  }));
  fnEntries.sort((a, b) => b.sym.rank - a.sym.rank || (a.sym.role === b.sym.role ? 0 : a.sym.role === "seed" ? -1 : 1) || (a.sym.name < b.sym.name ? -1 : a.sym.name > b.sym.name ? 1 : 0) || (a.id < b.id ? -1 : 1));
  for (const e of fnEntries) idOfSymbol.set(e.sym, e.id);
  const fnSymbols = fnEntries.map((e) => e.sym);
  const classSymbols: ExploreSymbol[] = classSeeds.map((c): ExploreSymbol => ({ name: c.name, kind: "Class", file: c.file ?? "(unknown)", role: "seed", rank: pr.get(`cls:${c.id}`) ?? 0 }));
  const ranked = [...fnSymbols, ...classSymbols];

  // --- source, read once per symbol; which of it fits is decided below
  const manifest = opts.manifestPath ? readManifest(opts.manifestPath) : null;
  const sourceCache = new Map<string, SourceFile>();
  const startsByFile = new Map<string, number[]>();
  const candidate = new Map<ExploreSymbol, string[]>();
  const noted = new Map<ExploreSymbol, string>();
  for (const s of ranked.slice(0, limit)) {
    if (s.kind !== "Function") continue;
    const found = fnList.find((f) => f.id === idOfSymbol.get(s))!;
    const got = await snippetLines(conn, found, manifest, sourceCache, startsByFile);
    if ("note" in got) noted.set(s, got.note);
    else candidate.set(s, got.lines);
  }

  // --- fit
  const shown: ExploreSymbol[] = ranked.slice(0, limit);
  const dropped: ExploreSymbol[] = ranked.slice(limit);
  const skippedSnippets: ExploreSymbol[] = [];
  /** How many names each "not expanded" list spells out; the totals are always given. Lowered only when nothing else is left to cut. */
  let listCap = LIST_CAP;
  const snippetOf = new Map<ExploreSymbol, string>();
  const health = (): IndexHealth | null =>
    readIndexHealth(opts.manifestPath, [...new Set(shown.map((s) => s.file).filter((f) => f !== "(unknown)"))]);
  const idsShown = (): string[] => shown.filter((s) => s.kind === "Function").map((s) => idOfSymbol.get(s)!);
  const labels = (): ((id: string) => string) => {
    const fns = shown.filter((s) => s.kind === "Function");
    const count = new Map<string, number>();
    for (const s of fns) count.set(s.name, (count.get(s.name) ?? 0) + 1);
    const byId = new Map(fns.map((s) => [idOfSymbol.get(s)!, s] as const));
    return (id) => {
      const s = byId.get(id)!;
      return (count.get(s.name) ?? 0) > 1 ? `${s.name}@${s.file}` : s.name;
    };
  };
  const assemble = (): ExploreResult => {
    const rank = new Map(fnSymbols.map((s) => [idOfSymbol.get(s)!, s.rank] as const));
    const ne: NotExpanded = {
      symbols: dropped.slice(0, listCap).map(where),
      symbolsTotal: dropped.length,
      snippets: skippedSnippets.slice(0, listCap).map((s) => s.name),
      snippetsTotal: skippedSnippets.length,
      files: neighbourFiles.slice(0, listCap),
      filesTotal: neighbourFiles.length,
    };
    const h = health();
    const topFns = shown.filter((s) => s.kind === "Function").slice(0, 3);
    const symbols = shown.map((s): ExploreSymbol => {
      const out: ExploreSymbol = { ...s, rank: Math.round(s.rank * 1000) / 1000 };
      const sn = snippetOf.get(s);
      if (sn !== undefined) out.snippet = sn;
      else if (noted.has(s)) out.snippetNote = noted.get(s)!;
      return out;
    });
    return {
      status: "ok",
      ...frame,
      truncated: dropped.length > 0 || skippedSnippets.length > 0 || hood.capped,
      symbols,
      callPaths: callPathsOf(idsShown(), hood.calls.map(([a, b]) => [a, b] as [string, string]), labels(), rank),
      next: topFns.map((s) => (s.file === "(unknown)" ? `call_chain {"symbol": "${s.name}"}` : `call_chain {"symbol": "${s.name}", "file": "${s.file}"}`)),
      ...(ne.symbolsTotal + ne.snippetsTotal + ne.filesTotal > 0 ? { notExpanded: ne } : {}),
      ...(h ? { indexHealth: h } : {}),
    };
  };
  const fits = (): boolean => measure(assemble()) <= maxChars;

  // 1. every shown symbol must fit without source; the least relevant ones leave first
  const drop = (s: ExploreSymbol): void => {
    dropped.unshift(s);
    snippetOf.delete(s);
    const at = skippedSnippets.indexOf(s);
    if (at >= 0) skippedSnippets.splice(at, 1);
  };
  // What gives way first: the long lists of names (down to a few), then symbols from the least relevant (keeping one),
  // then the last names; the totals are never cut. Returns false when nothing is left to give.
  const shrink = (): boolean => {
    if (listCap > 5) {
      listCap = 5;
      return true;
    }
    if (shown.length > 1) {
      drop(shown.pop()!);
      return true;
    }
    if (listCap > 0) {
      listCap = 0;
      return true;
    }
    if (shown.length > 0) {
      drop(shown.pop()!);
      return true;
    }
    return false;
  };
  while (!fits()) if (!shrink()) return minimalResult(assemble());

  // 2. source. Few, whole-ish snippets beat many cut ones, and the most relevant symbols come first: aim for about
  //    TARGET_SNIPPET_CHARS per snippet, give source to as many symbols as that room allows (at least one), name the rest.
  const withSource = shown.filter((s) => candidate.has(s));
  const aimed = Math.max(1, Math.floor((maxChars - measure(assemble())) / TARGET_SNIPPET_CHARS));
  for (const s of withSource.slice(aimed)) skippedSnippets.push(s);
  const chosen = withSource.slice(0, aimed);
  for (let i = 0; i < chosen.length; i += 1) {
    const s = chosen[i]!;
    const lines = candidate.get(s)!;
    const base = measure(assemble());
    const share = Math.floor((maxChars - base) / (chosen.length - i)); // what is left, shared by the snippets still to place
    let accepted = 0;
    for (let k = lines.length; k >= 1; k -= 1) {
      const cut = lines.length - k;
      snippetOf.set(s, lines.slice(0, k).join("\n") + (cut > 0 ? `\n… (+${cut} more line${cut === 1 ? "" : "s"} not shown)` : ""));
      const size = measure(assemble());
      if (size <= maxChars && size - base <= share) {
        accepted = k;
        break;
      }
    }
    if (accepted < Math.min(MIN_USEFUL_SNIPPET_LINES, lines.length)) {
      snippetOf.delete(s);
      skippedSnippets.push(s);
    }
  }

  // 3. the list of what was left out grew while the loop ran; if the frame no longer fits, give up source from the back, then the rest
  while (!fits()) {
    const lastWithSnippet = [...shown].reverse().find((s) => snippetOf.has(s));
    if (lastWithSnippet) {
      snippetOf.delete(lastWithSnippet);
      skippedSnippets.push(lastWithSnippet);
    } else if (!shrink()) {
      return minimalResult(assemble());
    }
  }
  return assemble();
}
