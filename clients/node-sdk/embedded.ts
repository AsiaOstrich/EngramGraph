import { GraphConnection } from "../../src/graph-db/connection.js";
import { initSchema } from "../../src/graph-db/schema.js";
import {
  SingleRepoIsolation,
  type IsolationModel,
  type IsolationContext,
} from "../../src/adapters/isolation.js";
import type { GraphRow } from "../../src/graph-db/types.js";
import type { KuzuValue } from "kuzu";

import {
  indexProject,
  callChain,
  callers,
  callees,
  type ProjectFile,
  type ProjectIndexResult,
  type CallDirection,
  type CallChainResult,
  type CallNode,
} from "../../src/code-graph/index.js";
import {
  indexKnowledgeDocs,
  impactAnalysis,
  type KnowledgeDoc,
  type ImpactAnalysisResult,
  type KnowledgeIndexResult,
} from "../../src/knowledge-graph/index.js";
import {
  applyFeedback,
  feedbackForEventType,
  topByConfidence,
  type ConfidenceLabel,
  type ConfidenceUpdate,
  type IngestEventType,
  type RankedNode,
} from "../../src/sage/index.js";

/**
 * In-process EngramGraph client: zero HTTP overhead.
 *
 * Wraps {@link GraphConnection} directly so a host application can embed the
 * graph engine in the same process. The isolation model decides the on-disk DB
 * path; the default is single-repo.
 *
 * Beyond raw {@link query}, it exposes the same high-level operations as the
 * REST/MCP surfaces (index, call-chain, impact-analysis, feedback) so embedded
 * consumers never need to hold the raw {@link GraphConnection}. The connection
 * is long-lived: `init()` is idempotent and `close()` is only for shutdown
 * (kuzu + tree-sitter teardown caveat — never close mid-process).
 */
export class EmbeddedClient {
  private conn: GraphConnection | null = null;

  constructor(
    private readonly isolation: IsolationModel = new SingleRepoIsolation(),
    private readonly ctx?: IsolationContext,
  ) {}

  /** Open the underlying DB and ensure the schema exists. Idempotent. */
  async init(): Promise<void> {
    if (this.conn) {
      return;
    }
    this.conn = GraphConnection.open(this.isolation.dbPath(this.ctx));
    await initSchema(this.conn);
  }

  /** Lazily init and return the live connection. */
  private async ready(): Promise<GraphConnection> {
    if (!this.conn) {
      await this.init();
    }
    return this.conn!;
  }

  /** Run a Cypher query against the embedded graph. */
  async query(
    cypher: string,
    params?: Record<string, KuzuValue>,
  ): Promise<GraphRow[]> {
    return (await this.ready()).query(cypher, params);
  }

  // ─── Code graph ──────────────────────────────────────────

  /** Index source files into the code graph (cross-file CALLS). */
  async indexCode(files: ProjectFile[]): Promise<ProjectIndexResult> {
    return indexProject(await this.ready(), files);
  }

  /** Who calls / is called by a symbol. */
  async callChain(
    symbol: string,
    direction?: CallDirection,
    depth?: number,
  ): Promise<CallChainResult> {
    return callChain(await this.ready(), symbol, direction, depth);
  }

  /** Functions that (transitively) call `name`. */
  async callers(name: string, depth?: number): Promise<CallNode[]> {
    return callers(await this.ready(), name, depth);
  }

  /** Functions that `name` (transitively) calls. */
  async callees(name: string, depth?: number): Promise<CallNode[]> {
    return callees(await this.ready(), name, depth);
  }

  // ─── Knowledge graph ─────────────────────────────────────

  /** Index front-matter markdown into the knowledge graph. */
  async indexDocs(docs: KnowledgeDoc[]): Promise<KnowledgeIndexResult> {
    return indexKnowledgeDocs(await this.ready(), docs);
  }

  /** Decisions in a spec's impact chain. */
  async impactAnalysis(nodeId: string, maxHops?: number): Promise<ImpactAnalysisResult> {
    return impactAnalysis(await this.ready(), nodeId, maxHops);
  }

  // ─── SAGE ────────────────────────────────────────────────

  /**
   * Evolve a node's confidence from a feedback event type
   * (`test_fail` / `test_pass` / `human_fix` / `status_change`).
   * Returns the before/after update, or null if the node is absent.
   */
  async ingestFeedback(
    nodeId: string,
    type: IngestEventType,
    nodeLabel: ConfidenceLabel = "Function",
    weight?: number,
  ): Promise<ConfidenceUpdate | null> {
    const mapped = feedbackForEventType(type);
    return applyFeedback(
      await this.ready(),
      { nodeId, signal: mapped.signal, weight: weight ?? mapped.weight, source: "embedded" },
      nodeLabel,
    );
  }

  /** Highest-confidence nodes of a label. */
  async topByConfidence(label: ConfidenceLabel, limit?: number): Promise<RankedNode[]> {
    return topByConfidence(await this.ready(), label, limit);
  }

  /** Close the embedded connection (shutdown only). */
  async close(): Promise<void> {
    if (this.conn) {
      await this.conn.close();
      this.conn = null;
    }
  }
}
