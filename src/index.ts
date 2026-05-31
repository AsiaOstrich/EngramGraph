/**
 * EngramGraph — open-source code + knowledge graph memory engine.
 *
 * Library-mode entry point. The engine is general-purpose; project-specific
 * conventions live in pluggable adapters, not here.
 */

// --- graph-db (Kuzu abstraction) ---
export { GraphConnection } from "./graph-db/connection.js";
export {
  initSchema,
  clearGraph,
  NODE_TABLE_DDL,
  REL_TABLE_DDL,
  NODE_TABLES,
  REL_TABLES,
} from "./graph-db/schema.js";
export { resolveDbPath, openGraph } from "./graph-db/open.js";
export type { IsolationMode, GraphLocationOptions } from "./graph-db/open.js";
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
export { extractCodeGraph, extractProject, indexFile, indexProject } from "./code-graph/index.js";
export { callers, callees, callChain } from "./code-graph/index.js";
export type {
  ExtractOptions,
  IndexResult,
  ProjectFile,
  ProjectIndexResult,
  SupportedLanguage,
  CallDirection,
  CallNode,
  CallChainResult,
} from "./code-graph/index.js";

// --- knowledge-graph (spec/decision markdown → Spec/Decision + IMPACTS) ---
export {
  SpecDecisionKnowledgeSource,
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
  GitBranchIsolation,
  type SignalSource,
  type FeedbackEvent,
  type FeedbackSignal,
  GitHistorySignalSource,
  TestExitCodeSignalSource,
} from "./adapters/index.js";

// --- api (REST) ---
export { createServer } from "./api/server.js";

// --- mcp (Model Context Protocol server for coding assistants) ---
export { createMcpServer } from "./mcp/server.js";

// --- embedded mode (in-process, zero HTTP) ---
export { EmbeddedClient } from "../clients/node-sdk/embedded.js";
