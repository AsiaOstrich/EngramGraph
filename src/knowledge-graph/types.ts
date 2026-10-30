/**
 * KnowledgeGraph module types.
 *
 * A *reference* knowledge adapter: spec docs → Spec nodes; decision/ADR docs →
 * Decision nodes, `[[ref]]` links and relationship fields → IMPACTS / SUPERSEDES / RELATES_TO
 * edges (SUPERSEDES only from the `supersedes` field). The generic,
 * provider-agnostic default lives in adapters/knowledge-source (Doc nodes).
 */

/** Which graph node table an id maps to. */
export type KnowledgeNodeKind = "Spec" | "Decision";

/** A single spec/decision/ADR markdown document fed to the knowledge source. */
export interface KnowledgeDoc {
  /** Document content, optionally beginning with a `---` front-matter block. */
  content: string;
  /**
   * Fallback id (e.g. file path or `SPEC-205`) used when the content has no
   * `id` front-matter field and no recognisable id in its body.
   */
  fallbackId?: string;
  /**
   * Where the document was read from, for telling two indexing runs apart
   * (XSPEC-481 R4). `fallbackId` cannot do that job: the CLI makes it relative to
   * the directory being indexed, so `dirA/adr/ADR-9.md` and `dirB/adr/ADR-9.md`
   * both arrive as `adr/ADR-9.md`. The CLI passes the absolute path here; a
   * caller without a path (MCP `index_docs`) leaves it out and gets no
   * cross-run comparison.
   */
  source?: string;
}

/** One node in an impact chain returned by impact analysis. */
export interface ImpactNode {
  id: string;
  title: string;
  /** "direct" = impacts the spec directly; "supersedes" = reached via a chain. */
  via: "direct" | "supersedes";
}

export interface ImpactAnalysisResult {
  nodeId: string;
  /** Decisions in the impact chain of the queried spec. */
  decisions: ImpactNode[];
}
