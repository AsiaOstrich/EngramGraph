/**
 * CLI command logic — thin wrappers over the existing public API, kept
 * separate from arg parsing (src/cli/index.ts) so they are unit-testable.
 * Each function takes an open {@link GraphConnection} and returns plain data;
 * the entry point handles I/O, formatting and process lifecycle.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { GraphConnection } from "../graph-db/connection.js";
import { clearGraph } from "../graph-db/schema.js";
import { writeFragment } from "../graph-db/writer.js";
import { gitBranchEngramDir, listBranches, sanitizeBranch } from "../graph-db/git-branch.js";
import {
  indexProject,
  callers,
  callees,
  implementers,
  implementedSpecs,
  type CallNode,
  type ImplementersResult,
  type ImplementedSpecsResult,
} from "../code-graph/index.js";
import { readScipIndex } from "../code-graph/providers/scip/scip-reader.js";
import { ingestScipIndex, type ScipIngestStats, type ScipSourceFile } from "../code-graph/providers/scip/scip-ingest.js";
import { indexKnowledgeDocs, impactAnalysis } from "../knowledge-graph/index.js";
import { applyFeedback, feedbackForEventType, topByConfidence, type ConfidenceLabel } from "../sage/index.js";
import { godNodes, communities, related, type GodNode, type CommunityMember, type RelatedNode } from "../structural-memory/index.js";
import { walkFiles } from "./walk.js";

const CODE_EXTS = [
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".cs",
  ".py", ".go", ".java", ".kt", ".kts", ".rs",
  ".cpp", ".cc", ".cxx", ".hpp", ".h", ".hh",
  ".rb", ".php", ".dart",
] as const;

export interface IndexResultSummary {
  code: { files: number; functions: number; classes: number; calls: number; implements: number; ambiguous: number; unresolved: number };
  knowledge?: { specs: number; decisions: number; impacts: number; supersedes: number; relates: number };
  /** Present only when `--scip` was given. See {@link ingestScipOverlay}. */
  scip?: ScipIngestStats & { documentsInIndex: number; filesMatched: number };
}

/**
 * Read+parse a `.scip` (protobuf) index file, turning the low-level failure
 * modes a user can actually hit into a clear, actionable CLI error instead of
 * a bare filesystem/protobuf exception:
 *   - the path doesn't exist (typo, forgot to generate it, wrong cwd), or
 *   - the file exists but isn't a valid SCIP protobuf (wrong file entirely,
 *     truncated/corrupt, or a `.scip.gz`/other format `scip-dotnet`/`scip-java`
 *     didn't produce this way).
 *
 * Deliberately does NOT attempt to invoke `scip-dotnet`/`scip-java`/etc.
 * itself — egr only ever *reads* an already-generated `.scip` file; producing
 * one is the caller's own build toolchain's job (see docs).
 */
function readScipIndexOrThrow(path: string): ReturnType<typeof readScipIndex> {
  if (!existsSync(path)) {
    throw new Error(`--scip: file not found: ${path}`);
  }
  try {
    return readScipIndex(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `--scip: "${path}" could not be parsed as a SCIP protobuf index (${msg}). ` +
        `egr does not generate .scip files itself — produce one with an external SCIP indexer for the ` +
        `language in question (e.g. \`scip-dotnet index\` for C#, \`scip-java index\` for Java) and pass ` +
        `its output file here.`,
    );
  }
}

/**
 * Turn a Kuzu "Binder exception" naming a missing `provider`/`confidence`
 * column into a pointed, ACCURATE remediation message, regardless of which
 * write actually tripped it.
 *
 * Deliberately does NOT say "run `egr index <dir> --clean`" — verified
 * empirically that this does not work: `--clean` (`clearGraph`) only issues
 * `MATCH (n) DETACH DELETE n` (deletes row data), it never touches table
 * *schema*, and `initSchema`'s `CREATE TABLE` is a no-op on a table that
 * already exists (see `graph-db/schema.ts`'s `isAlreadyExistsError`) — so a
 * `CALLS` table that predates the `provider`/`confidence` columns is STILL
 * missing them after `--clean --scip`, and this same error fires again. The
 * columns only actually get created by deleting the on-disk `.db` file
 * itself so `initSchema`'s `CREATE TABLE` runs for real on a from-scratch
 * database. (This appears to also be a latent inaccuracy in `schema.ts`'s
 * own pre-existing module comment, which conflates dev-platform's separate
 * `index-all.sh --clean` wrapper — which DOES delete `.db` files before
 * re-indexing — with this CLI's own `--clean` flag, which does not; not
 * fixed here as out of scope for this change, but worth knowing.)
 */
function rethrowAsSchemaMigrationError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  throw new Error(
    `--scip: this graph's CALLS table predates the "provider"/"confidence" columns SCIP ingest needs ` +
      `(a pre-XSPEC-333-R3 schema, never auto-migrated). "egr index --clean" does NOT fix this (it only ` +
      `clears row data, not table schema — initSchema never ALTERs an existing table). Delete this ` +
      `project's graph DB file itself (see "Graph DB location" in docs/CLI.md — by default ` +
      `".engram/graph.db" plus its ".wal" sidecar, or wherever ENGRAM_DB/--graph/--isolation resolves it ` +
      `to), then re-run "egr index <dir> --scip <path>" against the now-empty path to rebuild the schema ` +
      `from scratch. (underlying error: ${msg})`,
  );
}

function isMissingProvenanceColumnError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /binder exception/i.test(msg) && /(provider|confidence)/i.test(msg);
}

/**
 * Pre-flight check, run BEFORE the tree-sitter pass whenever `--scip` is
 * requested: confirms the CALLS table actually has the `provider`/
 * `confidence` columns SCIP ingest's merge needs.
 *
 * Why this can't just be a try/catch around the SCIP write alone (an earlier
 * version of this file did exactly that, and it was wrong): `cmdIndex` always
 * runs the tree-sitter `indexProject` pass FIRST, and tree-sitter's own
 * `buildCallEdges` (XSPEC-333 R3 OQ-4) ALSO unconditionally stamps
 * `provider`/`confidence` on every CALLS edge it writes — so on a pre-
 * migration graph, the tree-sitter pass hits the exact same Kuzu Binder
 * exception first, before the SCIP overlay's own writeFragment call is ever
 * reached (unless tree-sitter happens to resolve zero CALLS edges for this
 * project, which is not the common case). Wrapping only the SCIP write left
 * the friendly migration message practically unreachable for any real
 * project — the user would hit tree-sitter's own raw Binder exception
 * instead. Checking the schema up front, before either pass runs, makes the
 * friendly message fire regardless of which write would have tripped it.
 *
 * A zero-row `MATCH` still triggers Kuzu's binder-time column check (it's a
 * static schema check, not a runtime one), so this is safe to run against an
 * empty graph too.
 */
async function assertCallsSchemaHasProvenanceColumns(conn: GraphConnection): Promise<void> {
  try {
    await conn.query(`MATCH (:Function)-[r:CALLS]->(:Function) RETURN r.provider AS provider, r.confidence AS confidence LIMIT 1`);
  } catch (err) {
    if (isMissingProvenanceColumnError(err)) rethrowAsSchemaMigrationError(err);
    throw err;
  }
}

/**
 * `--scip <path>` overlay: read an externally-generated SCIP index, resolve
 * it against the SAME source files `egr index` just walked, and merge the
 * result on top of whatever `indexProject` already wrote (XSPEC-333 R3).
 *
 * ## Path basis
 *
 * A SCIP index's `Document.relativePath` is relative to whatever project
 * root the external indexer was invoked from (verified against real
 * `scip-dotnet`/`scip-java` output — see `test/fixtures/scip-*-poc/load-fixture.ts`),
 * and is ALWAYS `/`-separated per the SCIP protobuf schema's own documented
 * convention ("the path must use '/' as the separator, including on
 * Windows" — see `scip_pb.ts`). `egr index <dir>`'s own paths come from
 * `walkFiles`, which now normalizes to the same `/`-separated convention at
 * its own source point (`code-graph/path-utils.ts`'s `toPosixPath`, XSPEC-333
 * R3 follow-up) regardless of the host OS's separator — this function's
 * overlap check, and the id scheme `ingestScipIndex` derives from
 * `relativePath`, both do plain string equality against these two path sets,
 * and both sides are now guaranteed `/`-separated on every platform, not
 * just POSIX. (Previously this was a real, unfixed gap: a `\`-separated
 * `walkFiles` path would not string-match a `/`-separated SCIP document path
 * on Windows, so this overlay could silently match nothing even when `<dir>`
 * WAS the right root. Verified via string-level unit tests against
 * manufactured Windows-style path strings, not a real Windows host — see
 * `test/scip-windows-path-normalization.test.ts`; this sandbox has none to
 * test against. See `code-graph/path-utils.ts`'s module doc for why
 * normalizing ONLY inside `walkFiles` — this function's original fix —
 * turned out to be an incomplete "single source of truth" claim, caught by
 * adversarial review: `mcp/server.ts`'s `index_code`/`index_docs` tools are
 * a SECOND id-generating entry point that bypasses `walkFiles` entirely, so
 * `extractor.ts`'s `collectExtraction` — the actual common choke point for
 * every id, called by both entry points — now ALSO normalizes, independent
 * of this function's own `walkFiles`-sourced comparison.)
 *
 * A non-empty but suspiciously small overlap (e.g. 1 of 50 files matching by
 * name coincidence) is also not specially detected here beyond the
 * `definitionsResolved === 0 && callsEmitted === 0` warning `cli/index.ts`'s
 * human-readable formatter prints — there is no overlap-ratio threshold,
 * since a normal, correct run can legitimately have a low ratio (e.g. a
 * `.scip` index covering many more compiler-generated documents than
 * `walkFiles` ever walks).
 *
 * ## Schema compatibility
 *
 * See {@link assertCallsSchemaHasProvenanceColumns}, called by `cmdIndex`
 * before this function runs.
 */
export async function ingestScipOverlay(
  conn: GraphConnection,
  dir: string,
  scipPath: string,
  codeFiles: Array<{ path: string; source: string }>,
): Promise<NonNullable<IndexResultSummary["scip"]>> {
  const index = readScipIndexOrThrow(scipPath);
  if (index.documents.length === 0) {
    throw new Error(`--scip: "${scipPath}" parsed as a valid SCIP index but contains no documents — is it empty?`);
  }

  const docPaths = new Set(index.documents.map((d) => d.relativePath));
  const scipFiles: ScipSourceFile[] = codeFiles
    .filter((f) => docPaths.has(f.path))
    .map((f) => ({ relativePath: f.path, source: f.source }));

  if (scipFiles.length === 0) {
    const sample = index.documents[0]?.relativePath;
    throw new Error(
      `--scip: none of the ${docPaths.size} document path(s) in "${scipPath}" (e.g. "${sample}") matched ` +
        `any source file under "${dir}". SCIP document paths are relative to the project root the external ` +
        `indexer (scip-dotnet/scip-java/etc.) was run against — pass that same root as <dir>, then retry.`,
    );
  }

  const { fragment, stats } = ingestScipIndex(index, scipFiles);
  try {
    await writeFragment(conn, fragment);
  } catch (err) {
    if (isMissingProvenanceColumnError(err)) rethrowAsSchemaMigrationError(err);
    throw err;
  }

  return { ...stats, documentsInIndex: docPaths.size, filesMatched: scipFiles.length };
}

/**
 * `egr index <dir> [--docs] [--clean] [--scip <path>]` — index code (always)
 * + knowledge docs (--docs) + an external SCIP index overlay (--scip).
 *
 * `--scip` always runs AFTER the tree-sitter pass above, but this ordering is
 * not load-bearing: `writeFragment`'s provenance-aware merge policy is
 * confidence-based, not arrival-order-based, so re-running either pass in
 * either order converges to the same graph (see `graph-db/writer.ts`'s
 * `shouldOverwrite` and `test/scip-merge.test.ts`'s "cross-provider upgrade"
 * case). This command still assumes NEITHER pass has to have run before —
 * a single `egr index <dir> --scip <path>` call is a complete, from-scratch
 * index (tree-sitter baseline + SCIP overlay in one shot); it does not require
 * a prior plain `egr index <dir>` run.
 *
 * When `opts.scip` is given, the CALLS-schema check runs BEFORE the
 * tree-sitter pass, not just around the SCIP write — see
 * {@link assertCallsSchemaHasProvenanceColumns}'s doc for why the schema
 * gap is actually hit by tree-sitter's own write first on a real project,
 * not only by SCIP's.
 */
export async function cmdIndex(
  conn: GraphConnection,
  opts: { dir: string; docs?: boolean; clean?: boolean; scip?: string },
): Promise<IndexResultSummary> {
  if (opts.clean) await clearGraph(conn); // drop existing data so deleted nodes are pruned
  if (opts.scip) await assertCallsSchemaHasProvenanceColumns(conn);
  const codeFiles = walkFiles(opts.dir, CODE_EXTS);
  const code = await indexProject(conn, codeFiles); // { files, functions, classes, calls, ambiguous, unresolved }
  const result: IndexResultSummary = { code };
  if (opts.docs) {
    const docs = walkFiles(opts.dir, [".md"]).map((f) => ({ content: f.source, fallbackId: f.path }));
    result.knowledge = await indexKnowledgeDocs(conn, docs);
  }
  if (opts.scip) {
    result.scip = await ingestScipOverlay(conn, opts.dir, opts.scip, codeFiles);
  }
  return result;
}

/** `egr callers <symbol> [--depth N]`. */
export function cmdCallers(conn: GraphConnection, symbol: string, depth = 1): Promise<CallNode[]> {
  return callers(conn, symbol, depth);
}

/** `egr callees <symbol> [--depth N]`. */
export function cmdCallees(conn: GraphConnection, symbol: string, depth = 1): Promise<CallNode[]> {
  return callees(conn, symbol, depth);
}

/** `egr implementers <spec-id>` — files (+ functions) that implement a spec. */
export function cmdImplementers(conn: GraphConnection, specId: string): Promise<ImplementersResult> {
  return implementers(conn, specId);
}

/** `egr implemented-by <module-path>` — specs a file declares it implements. */
export function cmdImplementedSpecs(
  conn: GraphConnection,
  moduleId: string,
): Promise<ImplementedSpecsResult> {
  return implementedSpecs(conn, moduleId);
}

/** `egr impact <spec-id> [--max-hops N]`. */
export function cmdImpact(conn: GraphConnection, nodeId: string, maxHops = 3) {
  return impactAnalysis(conn, nodeId, maxHops);
}

/** `egr feedback <type> <node-id> [--label L]`. */
export function cmdFeedback(
  conn: GraphConnection,
  type: string,
  nodeId: string,
  label: ConfidenceLabel = "Function",
  weight?: number,
) {
  const mapped = feedbackForEventType(type);
  return applyFeedback(
    conn,
    { nodeId, signal: mapped.signal, weight: weight ?? mapped.weight, source: "cli" },
    label,
  );
}

/** `egr top <label> [--limit N]`. */
export function cmdTop(conn: GraphConnection, label: ConfidenceLabel, limit = 10) {
  return topByConfidence(conn, label, limit);
}

/** `egr god-nodes [--limit N]` — highest-importance nodes across code + knowledge (DEC-027 L3). */
export function cmdGodNodes(conn: GraphConnection, limit = 10): Promise<GodNode[]> {
  return godNodes(conn, limit);
}

/** `egr communities` — Function-call clusters via Louvain (DEC-027 L3). */
export function cmdCommunities(conn: GraphConnection): Promise<CommunityMember[]> {
  return communities(conn);
}

/** `egr related <node-id> [--depth N] [--limit N]` — seed-anchored ranking (DEC-028 L4a). */
export function cmdRelated(conn: GraphConnection, seedId: string, depth = 2, limit = 10): Promise<RelatedNode[]> {
  return related(conn, seedId, depth, limit);
}

export interface GcResult {
  /** The branch-graph dir inspected, or null when not a git repo. */
  dir: string | null;
  /** Orphan graph files (branches that no longer exist). */
  orphans: string[];
  /** True when orphans were actually removed (i.e. not a dry run). */
  deleted: boolean;
}

/**
 * `egr gc [--dry-run]` — remove per-branch graphs whose branch no longer
 * exists. Inspects `<git-common-dir>/engram/`; a `<name>.db` is an
 * orphan when no current local branch sanitizes to `<name>`. Also clears the
 * sibling `<name>.db.wal` left by Kuzu.
 */
export function cmdGc(opts: { cwd?: string; dryRun?: boolean }): GcResult {
  const cwd = opts.cwd ?? process.cwd();
  const dir = gitBranchEngramDir(cwd);
  if (!dir || !existsSync(dir)) return { dir, orphans: [], deleted: false };

  const valid = new Set(listBranches(cwd).map((b) => `${sanitizeBranch(b)}.db`));
  const orphans = readdirSync(dir)
    .filter((f) => f.endsWith(".db"))
    .filter((f) => !valid.has(f));

  if (!opts.dryRun) {
    for (const f of orphans) {
      rmSync(join(dir, f), { recursive: true, force: true });
      rmSync(join(dir, `${f}.wal`), { recursive: true, force: true });
    }
  }
  return { dir, orphans, deleted: !opts.dryRun && orphans.length > 0 };
}
