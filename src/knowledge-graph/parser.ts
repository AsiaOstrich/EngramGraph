/**
 * spec/decision knowledge parser — a *reference* knowledge adapter.
 *
 * Each document becomes a Spec (XSPEC-NNN / SPEC-NNN) or Decision (DEC-NNN /
 * ADR-NNN) node, and every `[[ref]]` link / relationship front-matter field
 * becomes a typed edge:
 *   - Decision → Spec link  ⇒ IMPACTS (Decision → Spec)
 *   - Spec → Decision link  ⇒ IMPACTS (Decision → Spec)  (decision impacts spec)
 *   - Decision → Decision   ⇒ SUPERSEDES (source → referenced)
 *   - Spec → Spec           ⇒ RELATES (source → referenced; doc↔doc up/downstream)
 *
 * Referenced ids absent from the batch get a stub node so the edge still lands;
 * a later parse of the real document MERGE-updates it in place.
 */

import { extractRefs, parseFrontMatter } from "../adapters/knowledge-source.js";
import type { GraphConnection } from "../graph-db/connection.js";
import type { GraphEdge, GraphFragment, GraphNode } from "../graph-db/types.js";
import { writeFragment } from "../graph-db/writer.js";
import { classifyRef } from "./linker.js";
import type { KnowledgeDoc, KnowledgeNodeKind } from "./types.js";

export interface ParsedKnowledgeDoc {
  id: string;
  kind: KnowledgeNodeKind;
  title: string;
  /** Classified outbound references (self-references removed). */
  refs: Array<{ kind: KnowledgeNodeKind; id: string }>;
  node: GraphNode;
}

function firstHeading(body: string): string | null {
  const m = /^#\s+(.+)$/m.exec(body);
  return m ? (m[1] ?? "").trim() : null;
}

function makeNode(kind: KnowledgeNodeKind, id: string, title: string, fields: Record<string, string>): GraphNode {
  if (kind === "Spec") {
    return {
      label: "Spec",
      id,
      properties: { title, status: fields.status ?? "unknown", confidence: 1.0 },
    };
  }
  return {
    label: "Decision",
    id,
    properties: { title, date: fields.date ?? "", confidence: 1.0 },
  };
}

function stubNode(kind: KnowledgeNodeKind, id: string): GraphNode {
  return makeNode(kind, id, id, {});
}

/**
 * Parse a single knowledge document, or null when no spec/decision/ADR id can be
 * resolved (from front-matter `id`, the fallback id, or the body).
 */
export function parseKnowledgeDoc(doc: KnowledgeDoc): ParsedKnowledgeDoc | null {
  const { fields, body } = parseFrontMatter(doc.content);
  const rawId = fields.id ?? doc.fallbackId ?? doc.content;
  const classified = classifyRef(rawId);
  if (!classified) return null;

  const { kind, id } = classified;
  const title = fields.title ?? firstHeading(body) ?? id;

  // Refs come from two sources: inline [[ref]] links in the body, and the
  // relationship front-matter fields defined by the knowledge-graph-memory
  // standard. The kind-based edge rule in ingest() turns each typed ref into
  // the right directed edge, so listing a ref under any relationship field
  // yields the correct IMPACTS/SUPERSEDES edge.
  const seen = new Set<string>();
  const refs: Array<{ kind: KnowledgeNodeKind; id: string }> = [];
  const addRef = (raw: string): void => {
    const c = classifyRef(raw);
    if (!c || c.id === id) return;
    const key = `${c.kind}:${c.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(c);
  };

  for (const ref of extractRefs(body)) addRef(ref);

  for (const field of RELATIONSHIP_FIELDS) {
    const value = fields[field];
    if (!value) continue;
    // XSPEC- must be matched too (dev-platform specs); mirrors linker's ID_RE.
    for (const m of value.matchAll(/\b(?:XSPEC|SPEC|DEC|ADR)-\d+/gi)) addRef(m[0]);
  }

  return { id, kind, title, refs, node: makeNode(kind, id, title, fields) };
}

/** Front-matter relationship fields (knowledge-graph-memory standard §"Quick Reference"). */
const RELATIONSHIP_FIELDS = ["related", "depends_on", "impacts", "impacted_by", "supersedes", "implements"] as const;

/**
 * reference knowledge source: spec/decision markdown → graph fragment.
 */
export class SpecDecisionKnowledgeSource {
  constructor(private readonly docs: KnowledgeDoc[]) {}

  async ingest(): Promise<GraphFragment> {
    const parsed = this.docs
      .map(parseKnowledgeDoc)
      .filter((p): p is ParsedKnowledgeDoc => p !== null);

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const known = new Map<string, KnowledgeNodeKind>();

    for (const p of parsed) {
      nodes.push(p.node);
      known.set(p.id, p.kind);
    }

    const stubbed = new Set<string>();
    const ensureNode = (kind: KnowledgeNodeKind, id: string): void => {
      if (known.has(id) || stubbed.has(id)) return;
      stubbed.add(id);
      nodes.push(stubNode(kind, id));
    };

    for (const p of parsed) {
      for (const ref of p.refs) {
        ensureNode(ref.kind, ref.id);

        if (p.kind === "Decision" && ref.kind === "Spec") {
          edges.push(impacts(p.id, ref.id));
        } else if (p.kind === "Spec" && ref.kind === "Decision") {
          edges.push(impacts(ref.id, p.id));
        } else if (p.kind === "Decision" && ref.kind === "Decision") {
          edges.push(supersedes(p.id, ref.id));
        } else {
          // Spec → Spec: doc↔doc upstream/downstream (related / depends_on).
          edges.push(relates(p.id, ref.id));
        }
      }
    }

    return { nodes, edges };
  }
}

function impacts(decisionId: string, specId: string): GraphEdge {
  return { label: "IMPACTS", fromLabel: "Decision", from: decisionId, toLabel: "Spec", to: specId };
}

function supersedes(fromId: string, toId: string): GraphEdge {
  return { label: "SUPERSEDES", fromLabel: "Decision", from: fromId, toLabel: "Decision", to: toId };
}

function relates(fromId: string, toId: string): GraphEdge {
  return { label: "RELATES", fromLabel: "Spec", from: fromId, toLabel: "Spec", to: toId };
}

export interface KnowledgeIndexResult {
  specs: number;
  decisions: number;
  impacts: number;
  supersedes: number;
  relates: number;
}

/** Ingest spec/decision docs and write them to the graph. */
export async function indexKnowledgeDocs(
  conn: GraphConnection,
  docs: KnowledgeDoc[],
): Promise<KnowledgeIndexResult> {
  const fragment = await new SpecDecisionKnowledgeSource(docs).ingest();
  await writeFragment(conn, fragment);
  return {
    specs: fragment.nodes.filter((n) => n.label === "Spec").length,
    decisions: fragment.nodes.filter((n) => n.label === "Decision").length,
    impacts: fragment.edges.filter((e) => e.label === "IMPACTS").length,
    supersedes: fragment.edges.filter((e) => e.label === "SUPERSEDES").length,
    relates: fragment.edges.filter((e) => e.label === "RELATES").length,
  };
}
