---
source: docs/API.md
source_version: 0.1.0
translation_version: 0.1.0
last_synced: 2026-05-30
status: complete
---

# CodeSage API

> **语言：** [English](../../../docs/API.md) · [繁體中文](../../zh-TW/docs/API.md) · 简体中文

`@asiaostrich/codesage` 的 library 参考。以下全部都从包根目录导出：

```ts
import { /* ... */ } from "@asiaostrich/codesage";
```

包以 ESM 为主并附 CJS build；类型已内置。运行环境：Node ≥ 22。

## graph-db — Kuzu 抽象

### `class GraphConnection`

- `static open(dbPath: string): GraphConnection` — 在 `dbPath` 打开（或创建）Kuzu 数据库。
- `query(cypher: string, params?: Record<string, KuzuValue>): Promise<GraphRow[]>`
- `close(): Promise<void>` — 销毁注意事项见 [CONTRIBUTING.md](../CONTRIBUTING.md)；
  建议使用长生命周期连接。

### `initSchema(conn): Promise<void>`

幂等创建 6 个节点表 + 7 个关系表。另外导出：`NODE_TABLE_DDL`、`REL_TABLE_DDL`、
`NODE_TABLES`、`REL_TABLES`。

### `writeFragment(conn, fragment: GraphFragment): Promise<void>`

持久化一个与供应商无关的 `{ nodes, edges }` 片段。

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

类型：`GraphRow`、`GraphNode`、`GraphEdge`、`GraphFragment`、`NodeLabel`、
`RelLabel`，以及各节点 `FunctionNode` / `ClassNode` / `ModuleNode` /
`SpecNode` / `DecisionNode` / `DocNode`。

## code-graph — 源代码 → 图谱

tree-sitter 将 `.ts` / `.tsx` / `.js` 解析为 `Function` / `Class` / `Module`
节点并解析 `CALLS` 边。函数 id 为**作用域限定**且在重新索引时稳定——
`file#outer.helper`、`file#Class.method`。

- `extractCodeGraph(source: string, opts: ExtractOptions): Extraction` — 将单文件
  解析为片段（不写入 DB）。`ExtractOptions = { filePath, language? }`。
- `extractProject(files: ProjectFile[]): ProjectExtraction` — 解析整个 repo，跨文件解析 CALLS。
- `indexFile(conn, source, opts: ExtractOptions): Promise<IndexResult>` —
  提取 + 写入单文件。`IndexResult = { module, functions, classes, calls }`。
- `indexProject(conn, files: ProjectFile[]): Promise<ProjectIndexResult>` —
  索引整个 repo（跨文件 CALLS）。`ProjectIndexResult = { files, functions,
  classes, calls, ambiguous, unresolved }`（ambiguous = 被调用名称匹配到 > 1 个函数；
  unresolved = 匹配不到——两者都跳过）。

`ProjectFile = { path, source, language? }`；省略 `language` 时由路径扩展名推断。

### 查询

- `callers(conn, name: string, depth = 1): Promise<CallNode[]>` — 可传递调用
  `name` 的函数（depth 夹到 `1..10`）。
- `callees(conn, name: string, depth = 1): Promise<CallNode[]>` — `name` 可传递调用的函数。
- `callChain(conn, symbol: string, direction: CallDirection = "both", depth = 1):
  Promise<CallChainResult>`。

`CallNode = { id, name, file }`。`CallDirection = "callers" | "callees" | "both"`。
`CallChainResult = { symbol, direction, depth, callers, callees }`。

## knowledge-graph — spec/decision markdown → 图谱

AsiaOstrich **参考** adapter：XSPEC → `Spec`、DEC/ADR → `Decision`、
关系 front-matter + `[[ref]]` 链接 → `IMPACTS` / `SUPERSEDES`。

- `indexKnowledgeDocs(conn, docs: KnowledgeDoc[]): Promise<KnowledgeIndexResult>`
  — `KnowledgeDoc = { content, fallbackId? }`；结果计数 `{ specs, decisions, impacts, supersedes }`。
- `parseKnowledgeDoc(doc): ParsedKnowledgeDoc | null` — 解析单一文档（不写入）；
  若无法解析出 id（来自 front-matter `id`、`fallbackId` 或正文）则返回 `null`。
- `classifyRef(id): ClassifiedRef` — 将 id 分类为 `Spec` 或 `Decision`。
- `impactAnalysis(conn, nodeId: string, maxHops = 3): Promise<ImpactAnalysisResult>`
  — 某 spec 影响链中的决策；`maxHops`（SUPERSEDES 深度）夹到 `1..10`。
  `ImpactAnalysisResult = { nodeId, decisions: ImpactNode[] }`，
  `ImpactNode = { id, title, via: "direct" | "supersedes" }`。
- `XspecDecKnowledgeSource` — 参考 `KnowledgeSource` 实例。

### Front-matter schema

知识导入会读取开头的 `---` YAML 式 front-matter 块：

| 字段 | 含义 |
|------|------|
| `id` | 节点 id（否则用 `fallbackId`，再否则从正文推断）|
| `title` | 节点标题 |
| `status` | 节点状态（默认 `unknown`）|
| `related`、`impacts`、`impacted_by`、`supersedes`、`implements` | 关系字段 → `IMPACTS` / `SUPERSEDES` 边 |

正文中的行内 `[[ref]]` 链接也会被提取为引用。

## sage — 自演化置信度

置信度落在 `[MIN_CONFIDENCE, MAX_CONFIDENCE]` = `[0.1, 1.0]`。一个信号以
`weight × STEP`（`STEP` = 0.25）移动之，并做夹值。

- `applyFeedback(conn, event: FeedbackEvent, label: ConfidenceLabel = "Function"):
  Promise<ConfidenceUpdate | null>` — 应用一个事件；节点不存在则返回 `null`。
  `ConfidenceUpdate = { nodeId, label, before, after }`。
- `feedbackForEventType(type: IngestEventType): { signal, weight }` — 对应
  `test_fail` → 负向/1.0、`test_pass` → 正向/0.4、`human_fix` → 正向/0.6、
  `status_change` → 中性/0。
- `ingestFeedback(...)`、`runEvolution(...)` — 批量反馈 / 演化循环。
- `topByConfidence(conn, label: ConfidenceLabel, limit = 10): Promise<RankedNode[]>`
  — 置信度最高者优先（`limit` 夹到 `1..1000`）。`RankedNode = { id, confidence }`。
- `rankedImpact(conn, nodeId, maxHops?)` — 按置信度排名的影响决策。

`ConfidenceLabel = "Function" | "Spec" | "Decision" | "Doc"`。
`FeedbackEvent = { nodeId, signal: "positive"|"negative"|"neutral", weight, source? }`。
另导出常量 `STEP`、`MIN_CONFIDENCE`、`MAX_CONFIDENCE`。

## adapters — 可插拔接口 + 默认

- **知识来源** — `KnowledgeSource`；默认 `MarkdownKnowledgeSource`
  （通用 front-matter markdown → `Doc` 节点）。辅助函数 `parseFrontMatter`、
  `extractRefs`；类型 `MarkdownDoc`。
- **隔离模型** — `IsolationModel.dbPath(ctx?: IsolationContext): string`。
  `SingleRepoIsolation`（默认，单一 `graph.db`）| `OrgProjectIsolation`
  （`org-{orgId}/project-{projectId}/graph.db`）。
- **信号来源** — `SignalSource → FeedbackEvent[]`；`GitHistorySignalSource`、
  `TestExitCodeSignalSource`。类型 `FeedbackEvent`、`FeedbackSignal`。

## api — REST（Hono）

- `createServer(options?: { connection?: GraphConnection }): Hono` — 始终挂载
  `GET /health`。提供 `connection` 时，挂载图谱路由：`/graph/impact-analysis`、
  `/graph/ingest`、`/graph/call-chain`。

## mcp — Model Context Protocol

- `createMcpServer(conn: GraphConnection): McpServer` — 注册 5 个工具
  （`index_code`、`index_docs`、`call_chain`、`impact_analysis`、
  `ingest_feedback`）。见 [MCP.md](./MCP.md)。

## embedded — 同进程客户端

```ts
class EmbeddedClient {
  constructor(isolation?: IsolationModel, ctx?: IsolationContext);
  init(): Promise<void>;                 // 打开 DB + 确保 schema（幂等）
  query(cypher, params?): Promise<GraphRow[]>;
  close(): Promise<void>;
}
```

默认 `SingleRepoIsolation`。零 HTTP 开销——直接包住 `GraphConnection` 供同进程使用者使用。
