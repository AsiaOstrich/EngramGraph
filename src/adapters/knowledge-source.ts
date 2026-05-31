import type { GraphFragment, GraphNode, GraphEdge } from "../graph-db/types.js";

/**
 * Pluggable knowledge-source adapter.
 *
 * A knowledge source ingests some external corpus (markdown docs, GitHub
 * issues, RFCs, ...) and yields a provider-agnostic {@link GraphFragment}.
 *
 * The spec/decision/ADR parser is a *reference* implementation living
 * outside core (Phase 3); core only ships the generic markdown default below.
 */
export interface KnowledgeSource {
  ingest(): Promise<GraphFragment>;
}

/** A single front-matter markdown document fed to {@link MarkdownKnowledgeSource}. */
export interface MarkdownDoc {
  /** Logical document content, including the leading front-matter block. */
  content: string;
  /** Optional fallback id when front-matter omits `id` (e.g. file path). */
  fallbackId?: string;
}

interface ParsedFrontMatter {
  fields: Record<string, string>;
  body: string;
}

/**
 * Parse a leading YAML-ish front-matter block delimited by `---` lines.
 *
 * Intentionally minimal (flat `key: value` pairs) to avoid a YAML dependency;
 * this is the generic default.
 */
export function parseFrontMatter(content: string): ParsedFrontMatter {
  const normalized = content.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized);
  if (!match) {
    return { fields: {}, body: normalized };
  }
  const [, raw, body] = match;
  const fields: Record<string, string> = {};
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) {
      const key = kv[1];
      const value = (kv[2] ?? "").trim().replace(/^["']|["']$/g, "");
      if (key) {
        fields[key] = value;
      }
    }
  }
  return { fields, body: body ?? "" };
}

/** Extract `[[ref]]` wiki-style links from a body of text. */
export function extractRefs(body: string): string[] {
  const refs = new Set<string>();
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const ref = (m[1] ?? "").trim();
    if (ref) {
      refs.add(ref);
    }
  }
  return [...refs];
}

/**
 * Generic default knowledge source: parses arbitrary front-matter markdown.
 *
 * Each document becomes a `Doc` node keyed by its `id` front-matter field
 * (or `fallbackId`). Every `[[ref]]` link becomes a `REFERENCES` edge to a
 * `Doc` node with that id. No project-specific semantics are baked in.
 */
export class MarkdownKnowledgeSource implements KnowledgeSource {
  constructor(private readonly docs: MarkdownDoc[]) {}

  async ingest(): Promise<GraphFragment> {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();

    for (const doc of this.docs) {
      const { fields, body } = parseFrontMatter(doc.content);
      const id = fields.id ?? doc.fallbackId;
      if (!id) {
        // No identity → cannot place in the graph; skip.
        continue;
      }

      if (!seen.has(id)) {
        seen.add(id);
        nodes.push({
          label: "Doc",
          id,
          properties: {
            title: fields.title ?? id,
            status: fields.status ?? "unknown",
            confidence: 1.0,
          },
        });
      }

      for (const ref of extractRefs(body)) {
        edges.push({
          label: "REFERENCES",
          fromLabel: "Doc",
          from: id,
          toLabel: "Doc",
          to: ref,
        });
      }
    }

    return { nodes, edges };
  }
}
