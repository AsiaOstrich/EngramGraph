---
source: docs/API.md
source_version: 0.1.0
translation_version: 0.1.0
last_synced: 2026-05-30
status: complete
---

# CodeSage API

> **語言：** [English](../../../docs/API.md) · 繁體中文 · [简体中文](../../zh-CN/docs/API.md)

`@asiaostrich/codesage` 的 library 參考。以下全部都從套件根目錄匯出：

```ts
import { /* ... */ } from "@asiaostrich/codesage";
```

套件以 ESM 為主並附 CJS build；型別已內附。執行環境：Node ≥ 22。

## graph-db — Kuzu 抽象

### `class GraphConnection`

- `static open(dbPath: string): GraphConnection` — 在 `dbPath` 開啟（或建立）Kuzu 資料庫。
- `query(cypher: string, params?: Record<string, KuzuValue>): Promise<GraphRow[]>`
- `close(): Promise<void>` — 拆除注意事項見 [CONTRIBUTING.md](../CONTRIBUTING.md)；
  建議使用長生命連線。

### `initSchema(conn): Promise<void>`

冪等建立 6 個節點表 + 7 個關係表。另外匯出：`NODE_TABLE_DDL`、`REL_TABLE_DDL`、
`NODE_TABLES`、`REL_TABLES`。

### `writeFragment(conn, fragment: GraphFragment): Promise<void>`

持久化一個與供應商無關的 `{ nodes, edges }` 片段。

### Schema（DDL）

```
NODE Function(id, name, file, start_line, confidence)   PK id
NODE Class(id, name, file)                               PK id
NODE Module(id, path)                                    PK id
NODE Spec(id, title, status, confidence)                PK id
NODE Decision(id, title, date, confidence)              PK id
NODE Doc(id, title, status, confidence)                 PK id

REL CALLS(Function → Function, call_count)
REL IMPORTS(Module → Module)
REL DEFINES(Module → Function)
REL IMPLEMENTS(Function → Spec)
REL IMPACTS(Decision → Spec)
REL SUPERSEDES(Decision → Decision)
REL REFERENCES(Doc → Doc)
```

型別：`GraphRow`、`GraphNode`、`GraphEdge`、`GraphFragment`、`NodeLabel`、
`RelLabel`，以及各節點 `FunctionNode` / `ClassNode` / `ModuleNode` /
`SpecNode` / `DecisionNode` / `DocNode`。

## code-graph — 原始碼 → 圖譜

tree-sitter 將 `.ts` / `.tsx` / `.js` 解析為 `Function` / `Class` / `Module`
節點並解析 `CALLS` 邊。函式 id 為 **scope 限定**且在重新索引時穩定——
`file#outer.helper`、`file#Class.method`。

- `extractCodeGraph(source: string, opts: ExtractOptions): Extraction` — 將單檔
  解析為片段（不寫入 DB）。`ExtractOptions = { filePath, language? }`。
- `extractProject(files: ProjectFile[]): ProjectExtraction` — 解析整個 repo，跨檔解析 CALLS。
- `indexFile(conn, source, opts: ExtractOptions): Promise<IndexResult>` —
  擷取 + 寫入單檔。`IndexResult = { module, functions, classes, calls }`。
- `indexProject(conn, files: ProjectFile[]): Promise<ProjectIndexResult>` —
  索引整個 repo（跨檔 CALLS）。`ProjectIndexResult = { files, functions,
  classes, calls, ambiguous, unresolved }`（ambiguous = 被呼叫名稱比對到 > 1 個函式；
  unresolved = 比對不到——兩者都略過）。

`ProjectFile = { path, source, language? }`；省略 `language` 時由路徑副檔名推斷。

### 查詢

- `callers(conn, name: string, depth = 1): Promise<CallNode[]>` — 可遞移呼叫
  `name` 的函式（depth 夾到 `1..10`）。
- `callees(conn, name: string, depth = 1): Promise<CallNode[]>` — `name` 可遞移呼叫的函式。
- `callChain(conn, symbol: string, direction: CallDirection = "both", depth = 1):
  Promise<CallChainResult>`。

`CallNode = { id, name, file }`。`CallDirection = "callers" | "callees" | "both"`。
`CallChainResult = { symbol, direction, depth, callers, callees }`。

## knowledge-graph — spec/decision markdown → 圖譜

AsiaOstrich **參考** adapter：XSPEC → `Spec`、DEC/ADR → `Decision`、
關係 front-matter + `[[ref]]` 連結 → `IMPACTS` / `SUPERSEDES`。

- `indexKnowledgeDocs(conn, docs: KnowledgeDoc[]): Promise<KnowledgeIndexResult>`
  — `KnowledgeDoc = { content, fallbackId? }`；結果計數 `{ specs, decisions, impacts, supersedes }`。
- `parseKnowledgeDoc(doc): ParsedKnowledgeDoc | null` — 解析單一文件（不寫入）；
  若無法解析出 id（來自 front-matter `id`、`fallbackId` 或內文）則回傳 `null`。
- `classifyRef(id): ClassifiedRef` — 將 id 分類為 `Spec` 或 `Decision`。
- `impactAnalysis(conn, nodeId: string, maxHops = 3): Promise<ImpactAnalysisResult>`
  — 某 spec 影響鏈中的決策；`maxHops`（SUPERSEDES 深度）夾到 `1..10`。
  `ImpactAnalysisResult = { nodeId, decisions: ImpactNode[] }`，
  `ImpactNode = { id, title, via: "direct" | "supersedes" }`。
- `XspecDecKnowledgeSource` — 參考 `KnowledgeSource` 實例。

### Front-matter schema

知識匯入會讀取開頭的 `---` YAML 式 front-matter 區塊：

| 欄位 | 意義 |
|------|------|
| `id` | 節點 id（否則用 `fallbackId`，再否則從內文推斷）|
| `title` | 節點標題 |
| `status` | 節點狀態（預設 `unknown`）|
| `related`、`impacts`、`impacted_by`、`supersedes`、`implements` | 關係欄位 → `IMPACTS` / `SUPERSEDES` 邊 |

內文中的行內 `[[ref]]` 連結也會被擷取為參考。

## sage — 自演化信心度

信心度落在 `[MIN_CONFIDENCE, MAX_CONFIDENCE]` = `[0.1, 1.0]`。一個訊號以
`weight × STEP`（`STEP` = 0.25）移動之，並做夾值。

- `applyFeedback(conn, event: FeedbackEvent, label: ConfidenceLabel = "Function"):
  Promise<ConfidenceUpdate | null>` — 套用一個事件；節點不存在則回傳 `null`。
  `ConfidenceUpdate = { nodeId, label, before, after }`。
- `feedbackForEventType(type: IngestEventType): { signal, weight }` — 對應
  `test_fail` → 負向/1.0、`test_pass` → 正向/0.4、`human_fix` → 正向/0.6、
  `status_change` → 中性/0。
- `ingestFeedback(...)`、`runEvolution(...)` — 批次回饋 / 演化迴圈。
- `topByConfidence(conn, label: ConfidenceLabel, limit = 10): Promise<RankedNode[]>`
  — 信心度最高者優先（`limit` 夾到 `1..1000`）。`RankedNode = { id, confidence }`。
- `rankedImpact(conn, nodeId, maxHops?)` — 依信心度排名的影響決策。

`ConfidenceLabel = "Function" | "Spec" | "Decision" | "Doc"`。
`FeedbackEvent = { nodeId, signal: "positive"|"negative"|"neutral", weight, source? }`。
另匯出常數 `STEP`、`MIN_CONFIDENCE`、`MAX_CONFIDENCE`。

## adapters — 可插拔介面 + 預設

- **知識來源** — `KnowledgeSource`；預設 `MarkdownKnowledgeSource`
  （通用 front-matter markdown → `Doc` 節點）。輔助函式 `parseFrontMatter`、
  `extractRefs`；型別 `MarkdownDoc`。
- **隔離模型** — `IsolationModel.dbPath(ctx?: IsolationContext): string`。
  `SingleRepoIsolation`（預設，單一 `graph.db`）| `OrgProjectIsolation`
  （`org-{orgId}/project-{projectId}/graph.db`）。
- **訊號來源** — `SignalSource → FeedbackEvent[]`；`GitHistorySignalSource`、
  `TestExitCodeSignalSource`。型別 `FeedbackEvent`、`FeedbackSignal`。

## api — REST（Hono）

- `createServer(options?: { connection?: GraphConnection }): Hono` — 一律掛載
  `GET /health`。提供 `connection` 時，掛載圖譜路由：`/graph/impact-analysis`、
  `/graph/ingest`、`/graph/call-chain`。

## mcp — Model Context Protocol

- `createMcpServer(conn: GraphConnection): McpServer` — 註冊 5 個工具
  （`index_code`、`index_docs`、`call_chain`、`impact_analysis`、
  `ingest_feedback`）。見 [MCP.md](./MCP.md)。

## embedded — 同行程用戶端

```ts
class EmbeddedClient {
  constructor(isolation?: IsolationModel, ctx?: IsolationContext);
  init(): Promise<void>;                 // 開啟 DB + 確保 schema（冪等）
  query(cypher, params?): Promise<GraphRow[]>;
  close(): Promise<void>;
}
```

預設 `SingleRepoIsolation`。零 HTTP 開銷——直接包住 `GraphConnection` 供同行程消費者使用。
