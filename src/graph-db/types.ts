/**
 * Graph node & edge TypeScript types.
 *
 * Mirrors the Kuzu schema defined in {@link ./schema.ts}. These are the
 * structural contracts shared across CodeGraph, KnowledgeGraph and SAGE layers.
 */

import type { RyuValue } from "ryugraph";

/** A row returned by a graph query, after `getAll()`. */
export type GraphRow = Record<string, RyuValue>;

// --- CodeGraph nodes ---

export interface FunctionNode {
  id: string;
  name: string;
  file: string;
  start_line: number;
  /** SAGE confidence score in [0, 1]; defaults to 1.0 on creation. */
  confidence: number;
  /**
   * Which extraction pipeline produced this node (e.g. "tree-sitter"; future
   * providers add "scip", "lsif", ...). Drives the writer's overwrite policy
   * (XSPEC-333 R1) — see writer.ts.
   */
  provider: string;
}

export interface ClassNode {
  id: string;
  name: string;
  file: string;
  /** Which extraction pipeline produced this node. See {@link FunctionNode.provider}. */
  provider: string;
}

export interface ModuleNode {
  id: string;
  path: string;
}

// --- KnowledgeGraph (SAGE) nodes ---

export interface SpecNode {
  id: string;
  title: string;
  status: string;
  confidence: number;
}

export interface DecisionNode {
  id: string;
  title: string;
  date: string;
  confidence: number;
}

/**
 * Generic document node produced by the default knowledge
 * source. Any front-matter markdown maps to a `Doc` node.
 */
export interface DocNode {
  id: string;
  title: string;
  status: string;
  confidence: number;
}

// --- Edge / relationship label union ---

export type NodeLabel =
  | "Function"
  | "Class"
  | "Module"
  | "Spec"
  | "Decision"
  | "Doc";

export type RelLabel =
  | "CALLS"
  | "IMPORTS"
  | "DEFINES"
  | "IMPLEMENTS"
  | "IMPACTS"
  | "SUPERSEDES"
  | "RELATES"
  | "REFERENCES";

/**
 * Provider-agnostic graph fragment returned by knowledge/code sources.
 * `from`/`to` reference node ids; `fromLabel`/`toLabel` disambiguate the table.
 */
export interface GraphNode {
  label: NodeLabel;
  id: string;
  properties: Record<string, string | number>;
}

export interface GraphEdge {
  label: RelLabel;
  fromLabel: NodeLabel;
  from: string;
  toLabel: NodeLabel;
  to: string;
  properties?: Record<string, string | number>;
}

export interface GraphFragment {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
