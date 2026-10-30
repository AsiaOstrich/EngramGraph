/**
 * spec/decision knowledge parser — a *reference* knowledge adapter.
 *
 * Each document becomes a Spec (XSPEC-NNN / SPEC-NNN) or Decision (DEC-NNN /
 * ADR-NNN) node, and every `[[ref]]` link / relationship front-matter field
 * becomes a typed edge:
 *   - Decision → Spec link  ⇒ IMPACTS (Decision → Spec)
 *   - Spec → Decision link  ⇒ IMPACTS (Decision → Spec)  (decision impacts spec)
 *   - Decision → Decision   ⇒ SUPERSEDES (source → referenced) ONLY when the reference
 *                             is written under the `supersedes` front-matter field;
 *                             any other Decision → Decision reference (`related`,
 *                             `depends_on`, `impacts`, `impacted_by`, `implements`, or a
 *                             `[[ref]]` in the body) ⇒ DECISION_RELATES (issue #19)
 *   - Spec → Spec           ⇒ RELATES (source → referenced; doc↔doc up/downstream)
 *
 * Referenced ids absent from the batch get a stub node so the edge still lands;
 * a later parse of the real document MERGE-updates it in place.
 */

import { extractRefs, parseFrontMatter } from "../adapters/knowledge-source.js";
import type { GraphConnection } from "../graph-db/connection.js";
import type { GraphEdge, GraphFragment, GraphNode } from "../graph-db/types.js";
import { writeFragment } from "../graph-db/writer.js";
import { canonicalFilePath } from "../code-graph/path-utils.js";
import { classifyLeadingRef, classifyRef, extractRefIds, type ClassifiedRef } from "./linker.js";
import type { KnowledgeDoc, KnowledgeNodeKind } from "./types.js";

/**
 * Where a document's id came from (XSPEC-476 R2). The order is the priority when
 * several documents claim the same id: front-matter `id`, then the filename,
 * then the first heading.
 */
export type DocIdSource = "front-matter" | "filename" | "heading";

const SOURCE_RANK: Record<DocIdSource, number> = { "front-matter": 0, filename: 1, heading: 2 };

export interface ParsedKnowledgeDoc {
  id: string;
  kind: KnowledgeNodeKind;
  /** Which of the three places the id was taken from. */
  idSource: DocIdSource;
  /** The document's path (its `fallbackId`), or a placeholder when it had none. */
  path: string;
  /** Where the document was read from, when the caller said ({@link KnowledgeDoc.source}); stored on the node. */
  source?: string;
  title: string;
  /** Classified outbound references (self-references removed). */
  refs: KnowledgeRef[];
  node: GraphNode;
}

/** Where in a document a reference was written: its body (`[[ref]]`), or one relationship front-matter field. */
export type RefSource = "body" | (typeof RELATIONSHIP_FIELDS)[number];

/** One outbound reference of a document, with every place the document wrote it (issue #19). */
export interface KnowledgeRef {
  kind: KnowledgeNodeKind;
  id: string;
  /** Never empty. The same id written under `related` and `supersedes` lists both. */
  via: RefSource[];
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
 *
 * ## The heading must START with the id (XSPEC-476 R2)
 *
 * Front-matter `id` and the filename are set on purpose to name the document.
 * A heading is prose: "Unattended Deploy SOP (ADR-006)" is about ADR-006, it is
 * not ADR-006. The heading candidate therefore uses `classifyLeadingRef`; the
 * other two keep `classifyRef`. The returned `source` is what lets `ingest`
 * rank two documents that claim the same id.
 */
function resolveRef(
  fields: Record<string, string>,
  doc: KnowledgeDoc,
  body: string,
): { classified: ClassifiedRef; source: DocIdSource } | null {
  const candidates: Array<{ text: string | null | undefined; source: DocIdSource; classify: (t: string) => ClassifiedRef | null }> = [
    { text: fields.id, source: "front-matter", classify: classifyRef },
    { text: doc.fallbackId ? lastSegment(doc.fallbackId) : null, source: "filename", classify: classifyRef },
    { text: firstHeading(body), source: "heading", classify: classifyLeadingRef },
  ];
  for (const { text, source, classify } of candidates) {
    if (!text) continue;
    const classified = classify(text);
    if (classified) return { classified, source };
  }
  return null;
}

function makeNode(kind: KnowledgeNodeKind, id: string, title: string, fields: Record<string, string>, source?: string): GraphNode {
  // `path` only when the caller said where the document came from; a key with no value cannot be bound.
  const path: Record<string, string> = source !== undefined ? { path: source } : {};
  if (kind === "Spec") {
    return {
      label: "Spec",
      id,
      properties: { title, status: fields.status ?? "unknown", confidence: 1.0, origin: "declared", ...path },
    };
  }
  return {
    label: "Decision",
    id,
    properties: { title, date: fields.date ?? "", confidence: 1.0, origin: "declared", ...path },
  };
}

/**
 * A node minted only because some other document linked to this id
 * (XSPEC-373 R5).
 *
 * It used to be `makeNode(kind, id, id, {})` — the id echoed back as a title,
 * plus `confidence: 1.0`. That made a phantom indistinguishable from a real
 * document at a glance and, worse, actively wrong: `egr implementers SPEC-77`
 * answered `— SPEC-77` with full confidence for a spec that was never written.
 *
 * It now asserts only what is actually known: this id was referenced. No
 * title, because there is no document to take one from; no confidence,
 * because nothing has been judged. `origin` keeps it from overwriting the real
 * document if one is indexed later, in any order.
 */
function stubNode(kind: KnowledgeNodeKind, id: string): GraphNode {
  return { label: kind === "Spec" ? "Spec" : "Decision", id, properties: { origin: "referenced" } };
}

/**
 * Parse a single knowledge document, or null when no spec/decision/ADR id can be
 * resolved (from front-matter `id`, the fallback id, or the body).
 */
export function parseKnowledgeDoc(doc: KnowledgeDoc): ParsedKnowledgeDoc | null {
  const { fields, body } = parseFrontMatter(doc.content);
  const resolved = resolveRef(fields, doc, body);
  if (!resolved) return null;

  const { kind, id } = resolved.classified;
  const title = fields.title ?? firstHeading(body) ?? id;

  // Refs come from two sources: inline [[ref]] links in the body, and the
  // relationship front-matter fields defined by the knowledge-graph-memory
  // standard. Each ref remembers WHERE it was written (`via`): ingest() needs
  // it, because "this decision replaces that one" is something only the
  // `supersedes` field says. Before issue #19 the places were merged into one
  // list and forgotten, and every Decision → Decision link became SUPERSEDES.
  const byKey = new Map<string, KnowledgeRef>();
  const refs: KnowledgeRef[] = [];
  const addRef = (raw: string, via: RefSource): void => {
    const c = classifyRef(raw);
    if (!c || c.id === id) return;
    const key = `${c.kind}:${c.id}`;
    const seen = byKey.get(key);
    if (seen) {
      if (!seen.via.includes(via)) seen.via.push(via);
      return;
    }
    const ref: KnowledgeRef = { kind: c.kind, id: c.id, via: [via] };
    byKey.set(key, ref);
    refs.push(ref);
  };

  for (const ref of extractRefs(body)) addRef(ref, "body");

  for (const field of RELATIONSHIP_FIELDS) {
    const value = fields[field];
    if (!value) continue;
    // Pattern lives in linker.ts — this used to restate it, with a comment
    // saying so, which is exactly how the two drifted apart (XSPEC-373 R4a).
    for (const id of extractRefIds(value)) addRef(id, field);
  }

  return {
    id,
    kind,
    idSource: resolved.source,
    path: doc.fallbackId ?? "<unnamed document>",
    ...(doc.source !== undefined ? { source: doc.source } : {}),
    title,
    refs,
    node: makeNode(kind, id, title, fields, doc.source),
  };
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

  /**
   * Ids claimed by more than one document (XSPEC-476 R2), each with the
   * document that was kept and the ones set aside.
   *
   * Two documents resolving to the same id used to push two nodes for it into
   * one fragment: the writer MERGEd them in order, so the LAST document
   * silently replaced the first, and the summary counted both. A runbook titled
   * "ADR-008 時區重構：Runbook" overwrote the real ADR-008, and the summary said
   * 20 decisions where the graph held 12. Now one document owns each id,
   * chosen by a fixed rule, and every loss is recorded here.
   */
  readonly conflicts: DocIdConflict[] = [];

  /** The documents that own an id after {@link conflicts} were resolved — set by {@link ingest}. */
  readonly owners: ParsedKnowledgeDoc[] = [];

  constructor(private readonly docs: KnowledgeDoc[]) {}

  async ingest(): Promise<GraphFragment> {
    const named: ParsedKnowledgeDoc[] = [];
    for (const doc of this.docs) {
      const p = parseKnowledgeDoc(doc);
      if (p) named.push(p);
      else this.unresolved.push(doc.fallbackId ?? "<unnamed document>");
    }
    const parsed = this.chooseOwners(named);
    this.owners.push(...parsed);

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
          // Replacement is declared, not inferred from a mention (issue #19).
          edges.push(ref.via.includes("supersedes") ? supersedes(p.id, ref.id) : decisionRelates(p.id, ref.id));
        } else {
          // Spec → Spec: doc↔doc upstream/downstream (related / depends_on).
          edges.push(relates(p.id, ref.id));
        }
      }
    }

    return { nodes, edges };
  }

  /**
   * One document per id. Priority: front-matter `id` over filename over first
   * heading; within the same source the path decides (the lexicographically
   * smaller wins) so the outcome does not depend on the order the filesystem
   * listed the files in. A document set aside contributes nothing — no node and
   * no links: its `[[refs]]` were written about whatever it is, not about the
   * artifact that happens to share its id.
   */
  private chooseOwners(named: ParsedKnowledgeDoc[]): ParsedKnowledgeDoc[] {
    const byId = new Map<string, ParsedKnowledgeDoc[]>();
    for (const p of named) {
      const group = byId.get(p.id);
      if (group) group.push(p);
      else byId.set(p.id, [p]);
    }
    const owners: ParsedKnowledgeDoc[] = [];
    for (const [id, group] of byId) {
      const ranked = [...group].sort(
        (a, b) => SOURCE_RANK[a.idSource] - SOURCE_RANK[b.idSource] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      );
      owners.push(ranked[0]!);
      if (ranked.length > 1) {
        this.conflicts.push({
          id,
          kind: ranked[0]!.kind,
          reason: "duplicate-id",
          kept: { path: ranked[0]!.path, source: ranked[0]!.idSource },
          setAside: ranked.slice(1).map((d) => ({ path: d.path, source: d.idSource })),
        });
      }
    }
    return owners;
  }
}

function impacts(decisionId: string, specId: string): GraphEdge {
  return { label: "IMPACTS", fromLabel: "Decision", from: decisionId, toLabel: "Spec", to: specId };
}

function supersedes(fromId: string, toId: string): GraphEdge {
  return { label: "SUPERSEDES", fromLabel: "Decision", from: fromId, toLabel: "Decision", to: toId };
}

function decisionRelates(fromId: string, toId: string): GraphEdge {
  return { label: "DECISION_RELATES", fromLabel: "Decision", from: fromId, toLabel: "Decision", to: toId };
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
  /** Decision → Decision references that do not replace anything (issue #19). */
  decisionRelates: number;
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
  /**
   * Ids with more than one claimant (XSPEC-476 R2), and ids whose node an
   * earlier index wrote from a different file and this one has just replaced
   * (XSPEC-481 R4); told apart by `reason`. Empty when every id has one owner
   * and none was replaced. The counts above are taken after this resolution, so
   * they equal the nodes in the graph (plus none lost to a silent overwrite).
   */
  conflicts: KnowledgeConflict[];
}

/** One id claimed by several documents of the same run: who owns it, and who was set aside. */
export interface DocIdConflict {
  id: string;
  kind: KnowledgeNodeKind;
  reason: "duplicate-id";
  kept: { path: string; source: DocIdSource };
  setAside: Array<{ path: string; source: DocIdSource }>;
}

/**
 * An id whose node an EARLIER index wrote from another file, now overwritten by
 * this run's document (XSPEC-481 R4). Two runs over different directories used to
 * merge silently, the later one winning; the winning rule is unchanged, what is
 * new is that it is said. Paths are absolute (the CLI) — `dirA/adr/ADR-9.md` and
 * `dirB/adr/ADR-9.md` differ, which a path relative to the indexed directory
 * could not show.
 */
export interface ReplacedDocument {
  id: string;
  kind: KnowledgeNodeKind;
  reason: "replaced-from-earlier-index";
  /** Where the earlier index read the node from. */
  previous: { path: string };
  /** The document that owns the node now. */
  current: { path: string; source: DocIdSource };
}

export type KnowledgeConflict = DocIdConflict | ReplacedDocument;

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
 * ## Why the prefix must be UPPER CASE
 *
 * The first version clustered on any leading token, and on a real repository
 * that produced THIRTY-ONE warnings in one run: `language-options.md`,
 * `bdd-workflow.md`, `testing-pyramid.md`, `git-workflow.md` — a skills
 * library whose files are named topic-first. They share a prefix for the same
 * reason any documentation set does, and none of them was ever meant to be a
 * spec. The signal drowned in its own output, which is precisely the warning
 * fatigue this trigger was designed to avoid; the fixture that "proved" it
 * worked used `REQ-001.md`, an id shape, so the assumption was never tested
 * against prose filenames.
 *
 * Artifact id conventions are almost universally upper case — SPEC, ADR, RFC,
 * REQ, STORY, EPIC. Topic naming is lower case. Requiring upper case takes the
 * same repository from 31 warnings to one.
 *
 * The trade-off is on the record: a project naming specs `Spec-Login.md`
 * (capitalised, not upper) gets no warning. Under-reporting is the right
 * failure here — one missed hint costs a search, thirty-one spurious ones cost
 * the reader's attention permanently.
 *
 * Numeric leading tokens are excluded too, so date-stamped notes
 * (`2026-08-10-meeting.md`) never form a cluster.
 */
/** At most this many clusters are reported; see `unresolvedIdClusters`. */
const MAX_CLUSTERS_REPORTED = 3;

export function unresolvedIdClusters(unresolved: readonly string[], minCount = 3): UnresolvedCluster[] {
  const byPrefix = new Map<string, string[]>();
  for (const ref of unresolved) {
    const name = lastSegment(ref);
    // No `i` flag: the prefix must be upper case in the FILENAME ITSELF.
    const m = /^([A-Z][A-Z0-9_]*)-/.exec(name);
    if (!m?.[1]) continue;
    const files = byPrefix.get(m[1]) ?? [];
    files.push(name);
    byPrefix.set(m[1], files);
  }
  return [...byPrefix.entries()]
    .filter(([, files]) => files.length >= minCount)
    .map(([prefix, files]) => ({
      prefix,
      count: files.length,
      // De-duplicated: the same filename under several directories is one
      // piece of information, not three. A run of this reported
      // "create-methodology.md, create-methodology.md, create-methodology.md".
      samples: [...new Set(files)].slice(0, 3),
    }))
    .sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix))
    // Capped, and by size — a reader acts on the biggest one. Thirty-one
    // warnings is not thirty-one times as useful as three.
    .slice(0, MAX_CLUSTERS_REPORTED);
}

/**
 * Which of this run's owning documents are about to overwrite a node that an
 * earlier run wrote from a DIFFERENT file (XSPEC-481 R4). Asked before the write,
 * because after it the old path is gone.
 *
 * Silent when the node has no recorded path (indexed before the column existed, or
 * only ever a `[[ref]]` stub), when the new document has none (the caller did not
 * say), and when the path is the same — re-indexing one file is not a conflict.
 * The overwrite rule itself is not changed here.
 */
async function replacedFromEarlierIndex(conn: GraphConnection, owners: readonly ParsedKnowledgeDoc[]): Promise<ReplacedDocument[]> {
  const out: ReplacedDocument[] = [];
  for (const p of owners) {
    if (p.source === undefined) continue;
    const rows = await conn.query(`MATCH (n:${p.kind} {id: $id}) RETURN n.path AS path`, { id: p.id });
    const previous = rows[0]?.path;
    // Both sides by real location: a path stored by an earlier egr (or through a symlinked directory) and
    // the same file reached another way are one document, not a replacement.
    if (typeof previous === "string" && previous !== "" && canonicalFilePath(previous) !== canonicalFilePath(p.source)) {
      out.push({
        id: p.id,
        kind: p.kind,
        reason: "replaced-from-earlier-index",
        previous: { path: canonicalFilePath(previous) },
        current: { path: canonicalFilePath(p.source), source: p.idSource },
      });
    }
  }
  return out;
}

/**
 * Forget what an earlier index recorded as each owning Decision's own
 * Decision → Decision edges, so this run's document replaces it (issue #19).
 *
 * The writer only MERGEs, so the edges an older egr wrongly wrote — a plain
 * mention stored as SUPERSEDES — would otherwise survive every re-index; only
 * `--clean` removed them, and `--clean` also resets SAGE's accumulated
 * confidence. A document is the only source of its decision's outbound
 * Decision → Decision edges (nothing else writes SUPERSEDES or DECISION_RELATES), so
 * rewriting them from the document is the same rule as rewriting the node.
 * Scoped to the decisions whose document was read in THIS run: indexing one
 * directory leaves every other decision's edges alone, and a reference removed
 * from a document stops being an edge.
 */
async function forgetDecisionEdgesOf(conn: GraphConnection, owners: readonly ParsedKnowledgeDoc[]): Promise<void> {
  for (const p of owners) {
    if (p.kind !== "Decision") continue;
    for (const rel of ["SUPERSEDES", "DECISION_RELATES"] as const) {
      await conn.execute(`MATCH (:Decision {id: $id})-[r:${rel}]->(:Decision) DELETE r`, { id: p.id });
    }
  }
}

/** Ingest spec/decision docs and write them to the graph. */
export async function indexKnowledgeDocs(
  conn: GraphConnection,
  docs: KnowledgeDoc[],
): Promise<KnowledgeIndexResult> {
  const source = new SpecDecisionKnowledgeSource(docs);
  const fragment = await source.ingest();
  const replaced = await replacedFromEarlierIndex(conn, source.owners);
  await forgetDecisionEdgesOf(conn, source.owners);
  await writeFragment(conn, fragment);
  return {
    specs: fragment.nodes.filter((n) => n.label === "Spec").length,
    decisions: fragment.nodes.filter((n) => n.label === "Decision").length,
    impacts: fragment.edges.filter((e) => e.label === "IMPACTS").length,
    supersedes: fragment.edges.filter((e) => e.label === "SUPERSEDES").length,
    relates: fragment.edges.filter((e) => e.label === "RELATES").length,
    decisionRelates: fragment.edges.filter((e) => e.label === "DECISION_RELATES").length,
    docsScanned: docs.length,
    docsUnresolved: source.unresolved,
    conflicts: [...source.conflicts, ...replaced],
  };
}
