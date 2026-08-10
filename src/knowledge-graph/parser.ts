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
import { classifyRef, extractRefIds, type ClassifiedRef } from "./linker.js";
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

/** Last path segment of `s`, or `s` itself when it carries no separator. */
function lastSegment(s: string): string {
  const parts = s.split(/[/\\]/);
  return parts[parts.length - 1] ?? s;
}

/**
 * Resolve the artifact id of a document, trying each source in turn and
 * keeping the first that actually classifies (XSPEC-373 R3).
 *
 * Three sources, narrowest first: front-matter `id`, the fallback id's LAST
 * PATH SEGMENT, then the body's first heading.
 *
 * ## Why not the whole document
 *
 * This used to end in `?? doc.content` — the entire file as an id candidate,
 * so any `SPEC-…` token anywhere in the prose could name the document. Under
 * the old `-\d+` pattern that was near-harmless and, via the CLI, dead code:
 * `cli/run.ts` always supplies `fallbackId`, so the third alternative was
 * never reached. It was reachable from MCP and the library API, where
 * `fallbackId` is optional — the agent-facing side. With a widened id pattern
 * it would become an active mis-attribution engine, so it is gone.
 *
 * ## Why the last segment, not the whole path
 *
 * `cli/run.ts` passes a repo-relative POSIX path, not a bare name. Matching
 * against the full path lets a DIRECTORY name a document: under a widened
 * pattern, `specs/SPEC-AUTH-V2/notes.md` would file `notes.md` as
 * `SPEC-AUTH-V2`. Taking the last segment fixes that at one point for both
 * entry paths — an MCP caller's bare id string has no separator, so it is
 * returned unchanged.
 *
 * ## Why "first that classifies", not "first that is non-empty"
 *
 * A document whose filename carries no id must still be able to fall through
 * to its heading. Picking the first non-null candidate and classifying only
 * that would let a non-conforming filename mask a perfectly good `# SPEC-X`
 * heading — the file would be dropped for having been named badly.
 */
function resolveRef(fields: Record<string, string>, doc: KnowledgeDoc, body: string): ClassifiedRef | null {
  const candidates = [fields.id, doc.fallbackId ? lastSegment(doc.fallbackId) : null, firstHeading(body)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const classified = classifyRef(candidate);
    if (classified) return classified;
  }
  return null;
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
  const classified = resolveRef(fields, doc, body);
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
    // Pattern lives in linker.ts — this used to restate it, with a comment
    // saying so, which is exactly how the two drifted apart (XSPEC-373 R4a).
    for (const id of extractRefIds(value)) addRef(id);
  }

  return { id, kind, title, refs, node: makeNode(kind, id, title, fields) };
}

/** Front-matter relationship fields (knowledge-graph-memory standard §"Quick Reference"). */
const RELATIONSHIP_FIELDS = ["related", "depends_on", "impacts", "impacted_by", "supersedes", "implements"] as const;

/**
 * reference knowledge source: spec/decision markdown → graph fragment.
 */
export class SpecDecisionKnowledgeSource {
  /**
   * Docs that were read but yielded no artifact id, by fallback id
   * (XSPEC-373 R1).
   *
   * `parseKnowledgeDoc` returns null for these and they vanish: no node, no
   * edge, no error, and nothing in the summary distinguishes "44 documents we
   * could not name" from "no spec documents here". Recording them is the
   * difference between those two.
   *
   * Raw paths only — no reason codes, no classification. XSPEC-334 R1b
   * (`parse-health.ts`'s module doc) rejected a stable diagnostic taxonomy on
   * the grounds that fixing one before observing the real distribution of
   * failures bakes in a wrong first cut, and that reasoning applies here
   * unchanged. Consumers derive whatever view they need at read time.
   */
  readonly unresolved: string[] = [];

  constructor(private readonly docs: KnowledgeDoc[]) {}

  async ingest(): Promise<GraphFragment> {
    const parsed: ParsedKnowledgeDoc[] = [];
    for (const doc of this.docs) {
      const p = parseKnowledgeDoc(doc);
      if (p) parsed.push(p);
      else this.unresolved.push(doc.fallbackId ?? "<unnamed document>");
    }

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
  /**
   * How many documents were read (XSPEC-373 R1).
   *
   * The counts above are a numerator with no denominator: `specs: 0` reads
   * identically whether nothing was scanned or 44 documents were scanned and
   * none could be named. Note it is NOT `specs + decisions`' denominator
   * either — those count graph NODES, which include stubs minted for
   * `[[ref]]`s to documents that do not exist, so a single real document that
   * links four absent ids reports `5 specs` off one file.
   */
  docsScanned: number;
  /** Fallback ids of the documents that yielded no artifact id — raw, unclassified. */
  docsUnresolved: string[];
}

/** A prefix that appears repeatedly among documents that could not be named. */
export interface UnresolvedCluster {
  /** The token before the first `-`, upper-cased (e.g. `REQ`). */
  prefix: string;
  count: number;
  /** Up to three filenames, for a message a human can act on. */
  samples: string[];
}

/**
 * Prefixes that were systematically rejected (XSPEC-373 R1).
 *
 * ## Why not "unresolved > 0"
 *
 * Because that fires on every healthy repo. A README, a CHANGELOG and a
 * CONTRIBUTING are all documents with no artifact id, and always will be —
 * measured across three of our own repos, a bare non-zero check flagged
 * EngramGraph's own tree (25 markdown files, 0 specs) while staying silent on
 * universal-dev-standards, where 2831 of 2850 files failed to resolve. Warning
 * on the count is loud where nothing is wrong and quiet where something is.
 *
 * ## Why not "yield === 0" either
 *
 * That was this spec's own first draft, and it is the same defect it set out
 * to fix: one document that happens to be named `SPEC-001.md` makes the count
 * non-zero and silences the warning for the other 43. A single success hiding
 * an arbitrary number of failures is exactly the shape `cli/run.ts`'s
 * `failureBuckets` comment describes ("a single partial file was enough to
 * hide any number of failures behind it", 584 .cs files).
 *
 * ## What is actually diagnostic
 *
 * A CONSISTENT SHAPE being refused. `README.md` contributes no prefix at all,
 * so a normal repo yields no clusters; 44 files named `REQ-…` yield one
 * cluster of 44, which is a naming convention this tool does not recognise.
 * Zero is a quantity; consistency is evidence of intent.
 *
 * Numeric leading tokens are excluded, so date-stamped notes
 * (`2026-08-10-meeting.md`) never form a cluster.
 */
export function unresolvedIdClusters(unresolved: readonly string[], minCount = 3): UnresolvedCluster[] {
  const byPrefix = new Map<string, string[]>();
  for (const ref of unresolved) {
    const name = lastSegment(ref);
    const m = /^([A-Za-z][A-Za-z0-9_]*)-/.exec(name);
    if (!m?.[1]) continue;
    const prefix = m[1].toUpperCase();
    const files = byPrefix.get(prefix) ?? [];
    files.push(name);
    byPrefix.set(prefix, files);
  }
  return [...byPrefix.entries()]
    .filter(([, files]) => files.length >= minCount)
    .map(([prefix, files]) => ({ prefix, count: files.length, samples: files.slice(0, 3) }))
    .sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix));
}

/** Ingest spec/decision docs and write them to the graph. */
export async function indexKnowledgeDocs(
  conn: GraphConnection,
  docs: KnowledgeDoc[],
): Promise<KnowledgeIndexResult> {
  const source = new SpecDecisionKnowledgeSource(docs);
  const fragment = await source.ingest();
  await writeFragment(conn, fragment);
  return {
    specs: fragment.nodes.filter((n) => n.label === "Spec").length,
    decisions: fragment.nodes.filter((n) => n.label === "Decision").length,
    impacts: fragment.edges.filter((e) => e.label === "IMPACTS").length,
    supersedes: fragment.edges.filter((e) => e.label === "SUPERSEDES").length,
    relates: fragment.edges.filter((e) => e.label === "RELATES").length,
    docsScanned: docs.length,
    docsUnresolved: source.unresolved,
  };
}
