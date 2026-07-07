---
source: README.md
source_version: 0.1.0
translation_version: 0.1.0
last_synced: 2026-05-30
status: complete
---

# EngramGraph

> **語言：** [English](../../README.md) · 繁體中文 · [简体中文](../zh-CN/README.md)

[![npm](https://img.shields.io/npm/v/engramgraph)](https://www.npmjs.com/package/engramgraph)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)

> 開源的**程式碼 + 知識圖譜記憶引擎**，融合
> [SAGE](https://arxiv.org/abs/2605.12061) 自演化圖譜記憶與
> CodeGraph 結構化程式碼理解。

**授權：** MIT · **執行環境：** Node.js ≥ 22 · **圖譜資料庫：** [Kuzu](https://kuzudb.com/)（嵌入式、Cypher）· **無需 LLM**（確定性）

EngramGraph 是通用引擎。預設行為（「單一 repo + 通用 markdown + git 訊號」）對任何專案
開箱即用；專案專屬行為則透過可插拔的 adapter 提供。

## 為什麼要用圖譜？

向量檢索（「找出相似的記憶」）與圖譜走訪（「找出結構相關的節點」）是互補的。
EngramGraph 補上圖譜這一半：

> 「我想改 `execute()` → 引擎會走訪：呼叫者 → 相關 spec → 背後的決策。」

## 安裝

```bash
npm install -g engramgraph
```

全域安裝會把 `egr` CLI 放上 `PATH`，下方快速上手的指令才能在任何目錄執行。或不做全域安裝、直接執行 CLI：

```bash
npx engramgraph index ./src
```

## 快速上手

```bash
# 1. 將 repo 索引進圖譜（程式碼 + 可選文件）
egr index ./src --docs

# 2.「改這個函式會牽動什麼？」
egr callers myFunction --depth 2

# 3.「這個 spec 背後有哪些決策？」
egr impact SPEC-001
```

圖譜資料庫位於 `ENGRAM_DB`（預設 `./.engram/graph.db`）。
完整命令參考：**[docs/CLI.md](./docs/CLI.md)**。

### 內嵌使用（同行程、零 HTTP）

> **函式庫用途**（下方 Embedded / REST）需要的是本地相依，而非全域 CLI——請用
> `npm install engramgraph`（不加 `-g`）安裝，`import ... from "engramgraph"` 才解析得到。

```ts
import { EmbeddedClient } from "engramgraph";

const client = new EmbeddedClient();   // 預設 SingleRepoIsolation
await client.init();                   // 開啟 graph.db 並確保 schema 存在
const rows = await client.query("MATCH (f:Function) RETURN f.name AS name");
await client.close();
```

### REST 使用

```ts
import { createServer, GraphConnection } from "engramgraph";

const conn = GraphConnection.open("./.engram/graph.db");
const app = createServer({ connection: conn });   // Hono app；路由在 /graph/* 下
// GET /health → { status: "ok" }
```

或直接 `egr serve --port 3000`。API 參考：**[docs/API.md](./docs/API.md)**。

## 三種模式

| 模式 | 進入點 | 使用情境 |
|------|--------|----------|
| **內嵌（Embedded）** | `EmbeddedClient` | 同行程、零 HTTP 開銷（如同行程整合）|
| **REST** | `createServer()`（Hono）/ `egr serve` | 獨立圖譜服務；路由在 `/graph/*` 下 |
| **MCP** | `egr-mcp`（stdio）/ `egr mcp` | 程式助理即插即用（Claude Code、Codex、Cursor……）|

## MCP — 在程式助理中使用 EngramGraph

EngramGraph 內附一個 MCP server（stdio），暴露 5 個工具——`index_code`、`index_docs`、
`call_chain`、`impact_analysis`、`ingest_feedback`——讓任何支援 MCP 的助理都能把它當成
程式碼 + 知識圖譜使用。無 LLM、確定性、**免 Docker**。

```bash
# Claude Code，使用已安裝的套件：
claude mcp add egr -- npx egr-mcp
```

完整設定（Claude Code / Codex / Cursor / Windsurf）、5 個工具與範例流程：
**[docs/MCP.md](./docs/MCP.md)**。

## Core 與 Adapter 邊界

| 層級 | 內容 | 對外可用性 |
|------|------|------------|
| **通用 Core** | CodeGraph（tree-sitter → 圖譜）、SAGE 演化、Kuzu 抽象、REST/MCP/Embedded 模式、node-sdk | 零專案專屬相依 |
| **可插拔 Adapter（介面）** |（1）知識來源（2）隔離模型（3）SAGE 訊號來源 | Core 提供介面 + 一個通用預設 |

### 三個 adapter

1. **知識來源** — `KnowledgeSource → { nodes, edges }`。
   預設：`MarkdownKnowledgeSource`，將任何帶 front-matter 的 markdown
   （`id` / `title` / `status` + `[[ref]]` 連結）解析為通用 `Doc` 節點。
2. **隔離模型** — `IsolationModel.dbPath(ctx) → string`。
   預設：`SingleRepoIsolation`（單一 `graph.db`，無 org 概念）。
   可選：`OrgProjectIsolation`（`org-{orgId}/project-{projectId}/graph.db`）。
3. **SAGE 訊號來源** — `SignalSource → FeedbackEvent[]`。
   預設：`GitHistorySignalSource`、`TestExitCodeSignalSource`。

## 圖譜 schema

6 個節點表——`Function`、`Class`、`Module`、`Spec`、`Decision`、`Doc`。
7 個關係表——`CALLS`、`IMPORTS`、`DEFINES`、`IMPLEMENTS`、`IMPACTS`、`SUPERSEDES`、
`REFERENCES`。完整 DDL 與驅動知識匯入的 front-matter schema 見 **[docs/API.md](./docs/API.md)**。

## 狀態

- [x] **Phase 1** — 骨架（MIT、Node 22、ESM+CJS、tsup、vitest）、Kuzu 抽象 +
      冪等 schema（6 NODE / 7 REL 表）、三個 adapter 介面 + 通用預設、Hono
      `GET /health`、`EmbeddedClient`
- [x] **Phase 2** — CodeGraph：tree-sitter 擷取/索引、跨檔 `CALLS` 解析、
      scope 限定的函式 id
- [x] **Phase 3** — KnowledgeGraph：front-matter markdown → `Spec` / `Decision`
      + `IMPACTS` / `SUPERSEDES` 邊
- [x] **Phase 4** — SAGE 演化層：信心度回饋（`STEP` 0.25、下限 0.1）、
      `topByConfidence`、`rankedImpact`
- [x] **Phase 5** — REST 路由（`/graph/call-chain`、`/graph/impact-analysis`、
      `/graph/ingest`）、MCP server（5 工具）、獨立 `egr` CLI

## 參與貢獻

開發環境設定、build/test/health 迴圈，以及 kuzu + tree-sitter 拆除注意事項見
**[CONTRIBUTING.md](./CONTRIBUTING.md)**。變更紀錄於 **[CHANGELOG.md](../../CHANGELOG.md)**。

## 授權

MIT — 見 [LICENSE](../../LICENSE)。
