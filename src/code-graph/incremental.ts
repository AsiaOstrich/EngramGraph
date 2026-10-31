/**
 * Incremental code index (XSPEC-508 R6): parse only the files that changed,
 * write only the difference, and end with the graph a full rebuild would give.
 *
 * ## Why this is more than "skip unchanged files"
 *
 * CALLS and IMPORTS are resolved ACROSS files from a name index of the whole
 * project (`extractor.ts`'s {@link resolveFacts}). So a file nobody touched can
 * still change its edges:
 *
 *  - `B` calls `foo`; `A` (changed) now also defines `foo` next to `C`'s `foo`
 *    -> the name turned ambiguous and B's edge to C must DISAPPEAR.
 *  - `B` calls `newFn`, which nothing defined; `A` (changed) now defines it
 *    -> B's edge to A must APPEAR.
 *  - `A` (changed) drops `bar`, which `B` called -> B's edge to A must go.
 *
 * Working out which untouched files are "affected" by hand is exactly the kind
 * of reasoning that is right for the three cases above and wrong for the fourth.
 * So this module does not reason about it. It keeps, for every file, the small
 * {@link FileFacts} the resolution reads (names, call records, import targets),
 * resolves the PREVIOUS facts and the NEW facts with the same pure function, and
 * applies the difference between the two edge sets. Whatever changed, in
 * whichever file, falls out of the diff.
 *
 * ## What it trusts, and what it does not
 *
 *  - "Changed" is decided by a sha256 of the source text, never by mtime
 *    (`parse-manifest.ts` records why mtime misses: a grammar upgrade leaves
 *    every mtime alone).
 *  - The state is used only while it provably describes the graph: the manifest
 *    section of this root carries the token the state was written with, the
 *    parser fingerprint (egr version + grammar versions) is the same, and the
 *    graph still holds a Module per remembered file. Anything else is a full
 *    index, and the summary says which reason.
 *  - The root's section of the state file is removed before the graph is touched
 *    and rewritten after the manifest, so a run that dies in the middle leaves no
 *    state for that root — the next run then indexes it in full instead of diffing
 *    against a graph it half-edited. Other roots' sections stay: they describe
 *    nodes this run does not edit.
 *
 * ## Known limits (documented, not hidden)
 *
 *  - The first `--incremental` run on a graph that was built by earlier plain
 *    `egr index` runs does not know what those left behind (a plain index never
 *    prunes). It is a full index and starts the state from there; start from an
 *    empty graph or add `--clean` for a state that is exact.
 *  - Two roots of one graph that hold the same relative path used to be one
 *    Module node. They are not any more: the second root's file gets a
 *    root-qualified id (`root-ids.ts`), recorded in the state as `moduleId`, so
 *    every node belongs to one file of one root and a delete cannot reach another
 *    root's. Only a graph an OLDER egr built can still hold such shared nodes;
 *    `--incremental` then indexes in full and says to rebuild.
 *  - SCIP overlay edges are not part of the tree-sitter facts; `--incremental`
 *    refuses `--scip`.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import type { GraphConnection } from "../graph-db/connection.js";
import type { GraphEdge, GraphFragment } from "../graph-db/types.js";
import { writeFragment } from "../graph-db/writer.js";
import { moduleIdOf, resolveFacts, type FileFacts } from "./extractor.js";
import { grammarVersions, type ParseManifest } from "./parse-manifest.js";

/** Bump when the shape of {@link FileFacts} or the resolution it feeds changes: an old state is then ignored, not misread. */
export const STATE_VERSION = 2;

/** One index root's remembered facts. */
export interface RootState {
  /** Equals the manifest section's `incrementalToken` while this state describes the graph. */
  token: string;
  /** The parser this state's facts came from. Must equal the running one. */
  egrVersion: string;
  grammarVersions: Record<string, string>;
  /** Path (POSIX, relative to the root) -> what resolution needs to know about that file. */
  files: Record<string, FileFacts>;
}

/** The persisted state beside the graph (`<graph>.incremental-state.json`). */
export interface IncrementalState {
  version: number;
  roots: Record<string, RootState>;
}

/** `<...>/<name>.parse-manifest.json` -> `<...>/<name>.incremental-state.json`. */
export function statePathForManifest(manifestPath: string): string {
  return manifestPath.replace(/\.parse-manifest\.json$/, "") + ".incremental-state.json";
}

/**
 * Why a state file could not be used, when there is one to speak of: absent (never written, or
 * removed), unreadable (not JSON, or not shaped like a state), or written by another egr's state
 * format. Kept apart because the user is told which one it was — "the state was lost" for a file
 * that is right there (0.14.0 wrote version 1, this egr reads 2) sends them looking for a mistake
 * they did not make (issue #17).
 */
export type StateProblem =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "older" | "newer"; version: number };

/** The state file as found: the state when usable, else why not. */
export type StateRead = { state: IncrementalState; problem?: undefined } | { state: null; problem: StateProblem };

/** Read the state and, when it cannot be used, say which way. */
export function inspectState(path: string): StateRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { state: null, problem: (err as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" } };
  }
  let parsed: Partial<IncrementalState> | null;
  try {
    parsed = JSON.parse(text) as Partial<IncrementalState> | null;
  } catch {
    return { state: null, problem: { kind: "unreadable" } };
  }
  if (typeof parsed !== "object" || parsed === null || typeof parsed.version !== "number") return { state: null, problem: { kind: "unreadable" } };
  if (parsed.version !== STATE_VERSION) {
    return { state: null, problem: { kind: parsed.version < STATE_VERSION ? "older" : "newer", version: parsed.version } };
  }
  if (typeof parsed.roots !== "object" || parsed.roots === null) return { state: null, problem: { kind: "unreadable" } };
  return { state: parsed as IncrementalState };
}

/** Read the state, or `null` when it is absent, unreadable or of another version ({@link inspectState} says which). */
export function readState(path: string): IncrementalState | null {
  return inspectState(path).state;
}

/** Atomic write (temp + rename), as the manifest does. */
export function writeState(path: string, state: IncrementalState): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Forget the whole state (best effort — a missing file is the goal). */
export function dropState(path: string): void {
  rmSync(path, { force: true });
}

/**
 * Forget ONE root's remembered facts, and keep every other root's: they describe nodes this run is
 * not about to edit. (Dropping the whole file made every other root of a shared graph index in full
 * the next time, which is most of what `--incremental` is for once there are two roots.) The file
 * goes when no root is left.
 */
export function dropRootState(path: string, root: string): void {
  const state = readState(path);
  if (!state || !(root in state.roots)) return;
  const { [root]: _gone, ...rest } = state.roots;
  if (Object.keys(rest).length === 0) {
    dropState(path);
    return;
  }
  writeState(path, { ...state, roots: rest });
}

/** A fresh token for a state/manifest pair. */
export function newToken(): string {
  return randomUUID();
}

/** The parser fingerprint a state section must match. */
export function fingerprint(egrVersion: string): { egrVersion: string; grammarVersions: Record<string, string> } {
  return { egrVersion, grammarVersions: grammarVersions() };
}

function sameFingerprint(
  a: { egrVersion: string; grammarVersions: Record<string, string> },
  b: { egrVersion: string; grammarVersions: Record<string, string> },
): boolean {
  if (a.egrVersion !== b.egrVersion) return false;
  const ak = Object.keys(a.grammarVersions).sort();
  const bk = Object.keys(b.grammarVersions).sort();
  if (ak.length !== bk.length) return false;
  return ak.every((k, i) => k === bk[i] && a.grammarVersions[k] === b.grammarVersions[k]);
}

/** Why an `--incremental` run had to index in full. */
export type FullReason = string;

/** The sentence for a state file that cannot be used. Each cause names itself: none is passed off as another. */
function stateProblemReason(problem: StateProblem | undefined): string {
  switch (problem?.kind) {
    case "older":
      return `incremental state was written by an older egr (state version ${problem.version}, now ${STATE_VERSION}), so every file is parsed again`;
    case "newer":
      return `incremental state was written by a newer egr (state version ${problem.version}, now ${STATE_VERSION}) and this egr cannot use it, so every file is parsed again`;
    case "unreadable":
      return "the incremental state file could not be read (it is damaged or is not a state file), so every file is parsed again";
    default:
      return "no incremental state yet (the graph was built without --incremental, or the state was lost)";
  }
}

/**
 * Decide whether the remembered facts can be used. Returns the section to diff
 * against, or the reason the run must index in full.
 */
export function usableState(args: {
  root: string;
  manifest: ParseManifest | null;
  state: IncrementalState | null;
  /** Why `state` is null, from {@link inspectState}. Left out, a null state reads as "absent". */
  stateProblem?: StateProblem;
  egrVersion: string;
}): { ok: true; prev: RootState } | { ok: false; reason: FullReason } {
  const { root, manifest, state, stateProblem, egrVersion } = args;
  if (!manifest) return { ok: false, reason: "no parse-health manifest yet (first index of this graph)" };
  const section = manifest.runs[root];
  if (!section) return { ok: false, reason: "this root has not been indexed into this graph before" };
  if (!state) return { ok: false, reason: stateProblemReason(stateProblem) };
  const prev = state.roots[root];
  if (!prev) return { ok: false, reason: "no incremental state for this root yet" };
  if (!section.incrementalToken || section.incrementalToken !== prev.token) {
    return { ok: false, reason: "the graph was indexed again after the incremental state was written (token mismatch), so the state no longer describes it" };
  }
  if (!sameFingerprint(fingerprint(egrVersion), prev)) {
    return { ok: false, reason: "egr or a tree-sitter grammar changed since the last index (parser fingerprint differs), so every file is parsed again" };
  }
  return { ok: true, prev };
}

// ---------------------------------------------------------------------------
// Which files did git say changed?
// ---------------------------------------------------------------------------

/** git variables that point a command at ANOTHER repository (`git rev-parse --local-env-vars`) — a hook runs us with them set. */
const GIT_LOCAL_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

export function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of GIT_LOCAL_ENV) delete env[k];
  return env;
}

/**
 * Paths (relative to `dir`, `/`-separated) git reports as different from `ref`:
 * tracked files that differ in the working tree, and untracked files that are not
 * ignored. A rename shows as its old path (gone) and its new path (there) — the
 * caller treats the first as removed and the second as new.
 *
 * `--changed-from` means "the graph describes `ref`; tell me what is different
 * now". It is a statement the caller makes, and it is trusted: a file git does
 * not list is not even hashed. That is its point (a CI job that restored the
 * base commit's graph) and its risk (a ref that is not what was indexed).
 */
export function gitChangedPaths(dir: string, ref: string): Set<string> {
  if (ref === "" || ref.startsWith("-")) throw new Error(`--changed-from needs a git ref (got "${ref}")`);
  const run = (args: string[]): string => {
    try {
      return execFileSync("git", ["-C", dir, ...args], {
        encoding: "utf8",
        env: cleanGitEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 256 * 1024 * 1024,
      });
    } catch (err) {
      const stderr = (err as { stderr?: Buffer | string }).stderr;
      const detail = (stderr ? String(stderr) : err instanceof Error ? err.message : String(err)).trim();
      throw new Error(`--changed-from ${ref}: git ${args[0]} failed in ${dir}: ${detail}`);
    }
  };
  const changed = run(["diff", "--name-only", "-z", "--no-renames", "--relative", ref, "--"]);
  const untracked = run(["ls-files", "--others", "--exclude-standard", "-z"]);
  return new Set([...changed.split("\0"), ...untracked.split("\0")].filter((p) => p !== ""));
}

// ---------------------------------------------------------------------------
// The graph a set of facts describes, and the difference between two of them
// ---------------------------------------------------------------------------

interface DerivedGraph {
  /** Function/Class/Module/Spec ids that exist. */
  functions: Set<string>;
  classes: Set<string>;
  modules: Set<string>;
  specs: Set<string>;
  /** `label|from|to` -> edge. */
  edges: Map<string, GraphEdge>;
}

const edgeKey = (e: GraphEdge): string => `${e.label}\u0000${e.from}\u0000${e.to}`;
/** An edge with its properties, for "did this edge's call_count/confidence change". */
const edgeFull = (e: GraphEdge): string => `${edgeKey(e)}\u0000${JSON.stringify(e.properties ?? {})}`;

/** The nodes and edges `facts` describe — what a full index of those files would write. */
export function deriveGraph(facts: readonly FileFacts[]): DerivedGraph {
  const g: DerivedGraph = { functions: new Set(), classes: new Set(), modules: new Set(), specs: new Set(), edges: new Map() };
  const add = (e: GraphEdge): void => void g.edges.set(edgeKey(e), e);
  for (const f of facts) {
    const moduleId = moduleIdOf(f);
    g.modules.add(moduleId);
    for (const id of f.fnIds) {
      g.functions.add(id);
      add({ label: "DEFINES", fromLabel: "Module", from: moduleId, toLabel: "Function", to: id });
    }
    for (const id of f.classIds) g.classes.add(id);
    for (const id of f.specIds) {
      g.specs.add(id);
      add({ label: "IMPLEMENTS", fromLabel: "Module", from: moduleId, toLabel: "Spec", to: id });
    }
  }
  const { calls, imports } = resolveFacts(facts);
  for (const e of calls) add(e);
  for (const e of imports) add(e);
  return g;
}

/** What applying a delta did, for the summary. */
export interface DeltaStats {
  nodesRemoved: number;
  edgesRemoved: number;
  edgesWritten: number;
}

const CHUNK = 200;

async function deleteNodes(conn: GraphConnection, label: "Function" | "Class" | "Module", ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += CHUNK) {
    await conn.execute(`MATCH (n:${label}) WHERE n.id IN $ids DETACH DELETE n`, { ids: ids.slice(i, i + CHUNK) });
  }
}

/** Drop a `// implements` stub nobody implements any more — and only a stub, and only when nothing else points at it. */
async function deleteOrphanSpecStub(conn: GraphConnection, id: string): Promise<boolean> {
  const rows = await conn.query(`MATCH (s:Spec {id: $id}) RETURN s.origin AS origin`, { id });
  if (rows.length === 0 || rows[0]!.origin !== "annotated") return false;
  const incident = [
    `MATCH (:Module)-[r:IMPLEMENTS]->(s:Spec {id: $id}) RETURN count(r) AS c`,
    `MATCH (:Decision)-[r:IMPACTS]->(s:Spec {id: $id}) RETURN count(r) AS c`,
    `MATCH (:Spec)-[r:RELATES]->(s:Spec {id: $id}) RETURN count(r) AS c`,
    `MATCH (s:Spec {id: $id})-[r:RELATES]->(:Spec) RETURN count(r) AS c`,
  ];
  for (const q of incident) {
    const c = await conn.query(q, { id });
    if (Number(c[0]?.c ?? 0) > 0) return false;
  }
  await conn.execute(`MATCH (s:Spec {id: $id}) DETACH DELETE s`, { id });
  return true;
}

/**
 * Bring the graph from "what `prev` describes" to "what `next` describes",
 * writing only the difference.
 *
 * `freshNodes` are the nodes of the files parsed in this run (all of them are
 * written, so a moved `start_line` lands); unchanged files' nodes are not
 * touched, which also leaves SAGE's accumulated `confidence` on them alone.
 * A function that still exists in a changed file is MERGEd in place, never
 * deleted and re-created, for the same reason.
 */
export async function applyDelta(
  conn: GraphConnection,
  prev: readonly FileFacts[],
  next: readonly FileFacts[],
  freshNodes: GraphFragment["nodes"],
): Promise<DeltaStats> {
  const before = deriveGraph(prev);
  const after = deriveGraph(next);
  const stats: DeltaStats = { nodesRemoved: 0, edgesRemoved: 0, edgesWritten: 0 };

  const gone = (a: Set<string>, b: Set<string>): string[] => [...a].filter((id) => !b.has(id));
  const goneFns = gone(before.functions, after.functions);
  const goneClasses = gone(before.classes, after.classes);
  const goneModules = gone(before.modules, after.modules);
  const goneSpecs = gone(before.specs, after.specs);

  // 1. Edges that stopped existing. Skipped when an end is about to be deleted:
  //    DETACH DELETE takes the edge with it, and the match would find nothing.
  const dying = {
    Function: new Set(goneFns),
    Module: new Set(goneModules),
  } as Record<string, Set<string>>;
  for (const [key, e] of before.edges) {
    if (after.edges.has(key)) continue;
    if (dying[e.fromLabel]?.has(e.from) || dying[e.toLabel]?.has(e.to)) continue;
    await conn.execute(
      `MATCH (a:${e.fromLabel} {id: $from})-[r:${e.label}]->(b:${e.toLabel} {id: $to}) DELETE r`,
      { from: e.from, to: e.to },
    );
    stats.edgesRemoved += 1;
  }

  // 2. Nodes that stopped existing.
  await deleteNodes(conn, "Function", goneFns);
  await deleteNodes(conn, "Class", goneClasses);
  await deleteNodes(conn, "Module", goneModules);
  stats.nodesRemoved += goneFns.length + goneClasses.length + goneModules.length;
  for (const id of goneSpecs) if (await deleteOrphanSpecStub(conn, id)) stats.nodesRemoved += 1;

  // 3. What is new or different: the fresh files' nodes, and every edge that is
  //    not exactly as it was (new, or same ends with another call_count/confidence).
  const beforeFull = new Set([...before.edges.values()].map(edgeFull));
  const edgesToWrite = [...after.edges.values()].filter((e) => !beforeFull.has(edgeFull(e)));
  await writeFragment(conn, { nodes: [...freshNodes], edges: edgesToWrite });
  stats.edgesWritten = edgesToWrite.length;
  return stats;
}
