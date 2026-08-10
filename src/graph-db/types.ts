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

/**
 * How a knowledge node's id got into the graph (XSPEC-373 R5).
 *
 * A Spec node can arrive three ways, and until now they were indistinguishable
 * — same label, same `confidence: 1.0`, sometimes the same title:
 *   - `declared`   — a real document was parsed and named it
 *   - `annotated`  — code said `// implements <id>`; the code exists, the
 *                    document may not
 *   - `referenced` — some other document wrote `[[<id>]]`; nothing but a link
 *                    asserts this id exists at all
 *
 * Deliberately NOT folded into `confidence`. That field already carries two
 * meanings (SAGE's evolving score, and the tie-break in the provider overwrite
 * policy), and encoding origin as a low confidence would make a stub
 * permanently un-overwritable by the real document — the exact opposite of
 * what is wanted. Origin is a fact about provenance, confidence is an
 * evolving judgement; they are separate columns because they are separate
 * things.
 *
 * Set by the indexer only. A caller cannot declare it, or it becomes the
 * free-form annotation field this project has ruled out.
 */
export type KnowledgeOrigin = "declared" | "annotated" | "referenced";

/**
 * Overwrite precedence: a real document beats a code annotation, which beats a
 * bare link (XSPEC-373 R5).
 *
 * This is what stops dev-platform's own multi-root index from corrupting
 * itself. `index-all.sh` walks six roots into one DB; a `[[XSPEC-373]]` in any
 * of them used to mint a stub whose `title` was the id string, and — since
 * knowledge nodes carry no `provider` and so bypass the provider policy
 * entirely — last write won. Whether a spec had its real title depended on
 * directory ordering.
 */
export const KNOWLEDGE_ORIGIN_RANK: Record<KnowledgeOrigin, number> = {
  declared: 3,
  annotated: 2,
  referenced: 1,
};
