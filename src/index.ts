/**
 * CodeSage — open-source code + knowledge graph memory engine.
 *
 * Library-mode entry point. AsiaOstrich (XSPEC/DEC/org/VibeOps) is only a
 * reference consumer; nothing here depends on it.
 */

// --- graph-db (Kuzu abstraction) ---
export { GraphConnection } from "./graph-db/connection.js";
export {
  initSchema,
  NODE_TABLE_DDL,
  REL_TABLE_DDL,
  NODE_TABLES,
  REL_TABLES,
} from "./graph-db/schema.js";
export { writeFragment } from "./graph-db/writer.js";
export type {
  GraphRow,
  GraphNode,
  GraphEdge,
  GraphFragment,
  NodeLabel,
  RelLabel,
  FunctionNode,
  ClassNode,
  ModuleNode,
  SpecNode,
  DecisionNode,
  DocNode,
} from "./graph-db/types.js";

// --- code-graph (tree-sitter → Function/Class/Module + CALLS) ---
export { extractCodeGraph, indexFile } from "./code-graph/index.js";
export type {
  ExtractOptions,
  IndexResult,
  SupportedLanguage,
} from "./code-graph/index.js";

// --- knowledge-graph (XSPEC/DEC markdown → Spec/Decision + IMPACTS) ---
export {
  XspecDecKnowledgeSource,
  parseKnowledgeDoc,
  classifyRef,
  indexKnowledgeDocs,
} from "./knowledge-graph/index.js";
export type {
  KnowledgeDoc,
  KnowledgeNodeKind,
  ImpactNode,
  ImpactAnalysisResult,
} from "./knowledge-graph/index.js";
export { impactAnalysis } from "./knowledge-graph/query.js";

// --- sage (self-evolving confidence: writer / reader / evolution loop) ---
export {
  applyFeedback,
  topByConfidence,
  rankedImpact,
  feedbackForEventType,
  ingestFeedback,
  runEvolution,
  STEP,
  MIN_CONFIDENCE,
  MAX_CONFIDENCE,
} from "./sage/index.js";
export type {
  ConfidenceLabel,
  ConfidenceUpdate,
  RankedNode,
  IngestEventType,
} from "./sage/index.js";

// --- adapters (pluggable interfaces + generic defaults) ---
export {
  type KnowledgeSource,
  type MarkdownDoc,
  MarkdownKnowledgeSource,
  parseFrontMatter,
  extractRefs,
  type IsolationModel,
  type IsolationContext,
  SingleRepoIsolation,
  OrgProjectIsolation,
  type SignalSource,
  type FeedbackEvent,
  type FeedbackSignal,
  GitHistorySignalSource,
  TestExitCodeSignalSource,
} from "./adapters/index.js";

// --- api (REST / MCP server) ---
export { createServer } from "./api/server.js";

// --- embedded mode (in-process, zero HTTP) ---
export { EmbeddedClient } from "../clients/node-sdk/embedded.js";
