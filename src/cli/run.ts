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
import { indexKnowledgeDocs, impactAnalysis } from "../knowledge-graph/index.js";
import { applyFeedback, feedbackForEventType, topByConfidence, type ConfidenceLabel } from "../sage/index.js";
import { godNodes, communities, related, type GodNode, type CommunityMember, type RelatedNode } from "../structural-memory/index.js";
import { walkFiles } from "./walk.js";

const CODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"] as const;

export interface IndexResultSummary {
  code: { files: number; functions: number; classes: number; calls: number; implements: number; ambiguous: number; unresolved: number };
  knowledge?: { specs: number; decisions: number; impacts: number; supersedes: number };
}

/** `egr index <dir> [--docs] [--clean]` — index code (always) + knowledge docs (--docs). */
export async function cmdIndex(
  conn: GraphConnection,
  opts: { dir: string; docs?: boolean; clean?: boolean },
): Promise<IndexResultSummary> {
  if (opts.clean) await clearGraph(conn); // drop existing data so deleted nodes are pruned
  const codeFiles = walkFiles(opts.dir, CODE_EXTS);
  const code = await indexProject(conn, codeFiles); // { files, functions, classes, calls, ambiguous, unresolved }
  const result: IndexResultSummary = { code };
  if (opts.docs) {
    const docs = walkFiles(opts.dir, [".md"]).map((f) => ({ content: f.source, fallbackId: f.path }));
    result.knowledge = await indexKnowledgeDocs(conn, docs);
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
