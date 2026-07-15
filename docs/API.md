# EngramGraph API

> **Language:** English · [繁體中文](../locales/zh-TW/docs/API.md) · [简体中文](../locales/zh-CN/docs/API.md)

Library reference for `engramgraph`. Everything below is exported from
the package root:

```ts
import { /* ... */ } from "engramgraph";
```

The package is ESM-first with a CJS build; types are bundled. Runtime: Node ≥ 22.

## graph-db — Kuzu abstraction

### `class GraphConnection`

- `static open(dbPath: string): GraphConnection` — open (or create) a Kuzu
  database at `dbPath`.
- `query(cypher: string, params?: Record<string, KuzuValue>): Promise<GraphRow[]>`
- `close(): Promise<void>` — see the teardown caveat in
  [CONTRIBUTING.md](../CONTRIBUTING.md); prefer a long-lived connection.

### `initSchema(conn): Promise<void>`

Idempotently creates the 6 node + 7 relationship tables. Also exported:
`NODE_TABLE_DDL`, `REL_TABLE_DDL`, `NODE_TABLES`, `REL_TABLES`.

### `clearGraph(conn): Promise<void>`

Delete all data while keeping the tables (`DETACH DELETE` per node table), so a
re-index prunes nodes no longer present (the MERGE writer never deletes).

### `resolveDbPath(loc?)` / `openGraph(loc?)`

Resolve a graph DB path / open it (creating dirs + schema). `loc` is a string
path or `GraphLocationOptions = { dbPath?, graph?, isolation?, cwd? }`.
Priority: `dbPath` > env `ENGRAM_DB` > `graph` name → `.engram/<name>.db` >
`isolation: "git-branch"` (per current branch) > default `.engram/graph.db`.
`IsolationMode = "single" | "git-branch"`.

### `writeFragment(conn, fragment: GraphFragment): Promise<void>`

Persist a provider-agnostic `{ nodes, edges }` fragment.

### Schema (DDL)

```
NODE Function(id, name, file, start_line, confidence)   PK id
NODE Class(id, name, file)                               PK id
NODE Module(id, path)                                    PK id
NODE Spec(id, title, status, confidence)                PK id
NODE Decision(id, title, date, confidence)              PK id
NODE Doc(id, title, status, confidence)                 PK id

REL CALLS(Function → Function, call_count, confidence, provider)
REL IMPORTS(Module → Module)
REL DEFINES(Module → Function)
REL IMPLEMENTS(Function → Spec)
REL IMPACTS(Decision → Spec)
REL SUPERSEDES(Decision → Decision)
REL REFERENCES(Doc → Doc)
```

Types: `GraphRow`, `GraphNode`, `GraphEdge`, `GraphFragment`, `NodeLabel`,
`RelLabel`, and the per-node `FunctionNode` / `ClassNode` / `ModuleNode` /
`SpecNode` / `DecisionNode` / `DocNode`.

## code-graph — source → graph

tree-sitter parses `.ts` / `.tsx` / `.js` into `Function` / `Class` / `Module`
nodes and resolves `CALLS` edges. Function ids are **scope-qualified** and
stable across re-indexing — `file#outer.helper`, `file#Class.method`.

- `extractCodeGraph(source: string, opts: ExtractOptions): Extraction` — parse
  one file to a fragment (no DB write). `ExtractOptions = { filePath, language? }`.
- `extractProject(files: ProjectFile[]): ProjectExtraction` — parse a repo,
  resolving CALLS across files.
- `indexFile(conn, source, opts: ExtractOptions): Promise<IndexResult>` —
  extract + write one file. `IndexResult = { module, functions, classes, calls }`.
- `indexProject(conn, files: ProjectFile[]): Promise<ProjectIndexResult>` —
  index a whole repo (cross-file CALLS). `ProjectIndexResult = { files,
  functions, classes, calls, ambiguous, unresolved }` (ambiguous = callee name
  matched > 1 function; unresolved = matched none — both skipped).

`ProjectFile = { path, source, language? }`; `language` is inferred from the
path extension when omitted.

### Queries

- `callers(conn, name: string, depth = 1): Promise<CallNode[]>` — functions that
  transitively call `name` (depth clamped `1..10`).
- `callees(conn, name: string, depth = 1): Promise<CallNode[]>` — functions
  `name` transitively calls.
- `callChain(conn, symbol: string, direction: CallDirection = "both", depth = 1):
  Promise<CallChainResult>`.

`CallNode = { id, name, file }`. `CallDirection = "callers" | "callees" | "both"`.
`CallChainResult = { symbol, direction, depth, callers, callees }`.

## knowledge-graph — spec/decision markdown → graph

A **reference** knowledge adapter: spec documents → `Spec`, decision / ADR
documents → `Decision`, relationship front-matter + `[[ref]]` links →
`IMPACTS` / `SUPERSEDES`.

- `indexKnowledgeDocs(conn, docs: KnowledgeDoc[]): Promise<KnowledgeIndexResult>`
  — `KnowledgeDoc = { content, fallbackId? }`; result counts
  `{ specs, decisions, impacts, supersedes }`.
- `parseKnowledgeDoc(doc): ParsedKnowledgeDoc | null` — parse one doc (no write);
  `null` if no id can be resolved (from front-matter `id`, the `fallbackId`, or
  the body).
- `classifyRef(id): ClassifiedRef` — classify an id as `Spec` or `Decision`.
- `impactAnalysis(conn, nodeId: string, maxHops = 3): Promise<ImpactAnalysisResult>`
  — decisions in a spec's impact chain; `maxHops` (SUPERSEDES depth) clamped
  `1..10`. `ImpactAnalysisResult = { nodeId, decisions: ImpactNode[] }`,
  `ImpactNode = { id, title, via: "direct" | "supersedes" }`.
- `XspecDecKnowledgeSource` — the reference `KnowledgeSource` instance.

### Front-matter schema

Knowledge ingestion reads a leading `---` YAML-ish front-matter block:

| Field | Meaning |
|-------|---------|
| `id` | Node id (else `fallbackId`, else inferred from body) |
| `title` | Node title |
| `status` | Node status (default `unknown`) |
| `related`, `impacts`, `impacted_by`, `supersedes`, `implements` | Relationship fields → `IMPACTS` / `SUPERSEDES` edges |

Inline `[[ref]]` links in the body are also extracted as references.

## sage — self-evolving confidence

Confidence lives in `[MIN_CONFIDENCE, MAX_CONFIDENCE]` = `[0.1, 1.0]`. A signal
moves it by `weight × STEP` (`STEP` = 0.25), clamped.

- `applyFeedback(conn, event: FeedbackEvent, label: ConfidenceLabel = "Function"):
  Promise<ConfidenceUpdate | null>` — apply one event; `null` if the node is
  absent. `ConfidenceUpdate = { nodeId, label, before, after }`.
- `feedbackForEventType(type: IngestEventType): { signal, weight }` — maps
  `test_fail` → negative/1.0, `test_pass` → positive/0.4, `human_fix` →
  positive/0.6, `status_change` → neutral/0.
- `ingestFeedback(...)`, `runEvolution(...)` — batch feedback / evolution loop.
- `topByConfidence(conn, label: ConfidenceLabel, limit = 10): Promise<RankedNode[]>`
  — highest confidence first (`limit` clamped `1..1000`). `RankedNode = { id, confidence }`.
- `rankedImpact(conn, nodeId, maxHops?)` — impact decisions ranked by confidence.

`ConfidenceLabel = "Function" | "Spec" | "Decision" | "Doc"`.
`FeedbackEvent = { nodeId, signal: "positive"|"negative"|"neutral", weight, source? }`.
Constants `STEP`, `MIN_CONFIDENCE`, `MAX_CONFIDENCE` are exported.

## adapters — pluggable interfaces + defaults

- **Knowledge source** — `KnowledgeSource`; default `MarkdownKnowledgeSource`
  (generic front-matter markdown → `Doc` nodes). Helpers `parseFrontMatter`,
  `extractRefs`; type `MarkdownDoc`.
- **Isolation model** — `IsolationModel.dbPath(ctx?: IsolationContext): string`.
  `SingleRepoIsolation` (default, one `graph.db`) | `OrgProjectIsolation`
  (`org-{orgId}/project-{projectId}/graph.db`) | `GitBranchIsolation` (
  per-branch `<git-common-dir>/engram/<branch>.db`, with a fallback model).
- **Signal source** — `SignalSource → FeedbackEvent[]`; `GitHistorySignalSource`,
  `TestExitCodeSignalSource`. Types `FeedbackEvent`, `FeedbackSignal`.

## api — REST (Hono)

- `createServer(options?: { connection?: GraphConnection }): Hono` — always
  mounts `GET /health`. When `connection` is given, mounts the graph routes:
  `/graph/impact-analysis`, `/graph/ingest`, `/graph/call-chain`.

## mcp — Model Context Protocol

- `createMcpServer(conn: GraphConnection): McpServer` — registers the 5 tools
  (`index_code`, `index_docs`, `call_chain`, `impact_analysis`,
  `ingest_feedback`). See [MCP.md](./MCP.md).

## embedded — in-process client

```ts
class EmbeddedClient {
  constructor(isolation?: IsolationModel, ctx?: IsolationContext);
  init(): Promise<void>;                 // open DB + ensure schema (idempotent)
  query(cypher, params?): Promise<GraphRow[]>;
  // high-level facade — same ops as REST/MCP, no raw GraphConnection needed:
  indexCode(files: ProjectFile[]): Promise<ProjectIndexResult>;
  indexDocs(docs: KnowledgeDoc[]): Promise<KnowledgeIndexResult>;
  callChain(symbol, direction?, depth?): Promise<CallChainResult>;
  callers(name, depth?): Promise<CallNode[]>;
  callees(name, depth?): Promise<CallNode[]>;
  impactAnalysis(nodeId, maxHops?): Promise<ImpactAnalysisResult>;
  ingestFeedback(nodeId, type, nodeLabel?, weight?): Promise<ConfidenceUpdate | null>;
  topByConfidence(label, limit?): Promise<RankedNode[]>;
  close(): Promise<void>;                // shutdown only (teardown caveat)
}
```

Defaults to `SingleRepoIsolation`. Zero HTTP overhead — wraps `GraphConnection`
directly for same-process consumers. Beyond raw `query`, the high-level facade
exposes the same operations as the REST/MCP surfaces, so embedded consumers
(e.g. an in-process host application) never need to hold the raw `GraphConnection`. The
connection is long-lived — `init()` is idempotent; `close()` is shutdown-only.
