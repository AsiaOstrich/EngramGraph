---
source: README.md
source_version: 0.1.0
translation_version: 0.1.0
last_synced: 2026-05-30
status: complete
---

# EngramGraph

> **语言：** [English](../../README.md) · [繁體中文](../zh-TW/README.md) · 简体中文

[![npm](https://img.shields.io/npm/v/engramgraph)](https://www.npmjs.com/package/engramgraph)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)

> 开源的**代码 + 知识图谱记忆引擎**，融合
> [SAGE](https://arxiv.org/abs/2605.12061) 自演化图谱记忆与
> CodeGraph 结构化代码理解。

**许可：** MIT · **运行环境：** Node.js ≥ 22 · **图数据库：** [Kuzu](https://kuzudb.com/)（嵌入式、Cypher）· **无需 LLM**（确定性）

EngramGraph 是通用引擎。默认行为（“单一 repo + 通用 markdown + git 信号”）对任何项目
开箱即用；项目专属行为则通过可插拔的 adapter 提供。

## 为什么用图谱？

向量检索（“找出相似的记忆”）与图谱遍历（“找出结构相关的节点”）是互补的。
EngramGraph 补上图谱这一半：

> “我想改 `execute()` → 引擎会遍历：调用者 → 相关 spec → 背后的决策。”

## 安装

```bash
npm install -g engramgraph
```

全局安装会把 `egr` CLI 放上 `PATH`，下方快速上手的命令才能在任何目录运行。或不做全局安装、直接运行 CLI：

```bash
npx engramgraph index ./src
```

## 快速上手

```bash
# 1. 将 repo 索引进图谱（代码 + 可选文档）
egr index ./src --docs

# 2.“改这个函数会牵动什么？”
egr callers myFunction --depth 2

# 3.“这个 spec 背后有哪些决策？”
egr impact SPEC-001
```

图数据库位于 `ENGRAM_DB`（默认 `./.engram/graph.db`）。
完整命令参考：**[docs/CLI.md](./docs/CLI.md)**。

### 嵌入式使用（同进程、零 HTTP）

> **库用途**（下方 Embedded / REST）需要的是本地依赖，而非全局 CLI——请用
> `npm install engramgraph`（不加 `-g`）安装，`import ... from "engramgraph"` 才能解析。

```ts
import { EmbeddedClient } from "engramgraph";

const client = new EmbeddedClient();   // 默认 SingleRepoIsolation
await client.init();                   // 打开 graph.db 并确保 schema 存在
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

或直接 `egr serve --port 3000`。API 参考：**[docs/API.md](./docs/API.md)**。

## 三种模式

| 模式 | 入口 | 使用场景 |
|------|------|----------|
| **嵌入式（Embedded）** | `EmbeddedClient` | 同进程、零 HTTP 开销（如同进程集成）|
| **REST** | `createServer()`（Hono）/ `egr serve` | 独立图谱服务；路由在 `/graph/*` 下 |
| **MCP** | `egr-mcp`（stdio）/ `egr mcp` | 编程助手即插即用（Claude Code、Codex、Cursor……）|

## MCP — 在编程助手中使用 EngramGraph

EngramGraph 内置一个 MCP server（stdio），暴露 5 个工具——`index_code`、`index_docs`、
`call_chain`、`impact_analysis`、`ingest_feedback`——让任何支持 MCP 的助手都能把它当成
代码 + 知识图谱使用。无 LLM、确定性、**免 Docker**。

```bash
# Claude Code，使用已安装的包：
claude mcp add egr -- npx egr-mcp
```

完整配置（Claude Code / Codex / Cursor / Windsurf）、5 个工具与示例流程：
**[docs/MCP.md](./docs/MCP.md)**。

## Core 与 Adapter 边界

| 层级 | 内容 | 对外可用性 |
|------|------|------------|
| **通用 Core** | CodeGraph（tree-sitter → 图谱）、SAGE 演化、Kuzu 抽象、REST/MCP/Embedded 模式、node-sdk | 零项目专属依赖 |
| **可插拔 Adapter（接口）** |（1）知识来源（2）隔离模型（3）SAGE 信号来源 | Core 提供接口 + 一个通用默认 |

### 三个 adapter

1. **知识来源** — `KnowledgeSource → { nodes, edges }`。
   默认：`MarkdownKnowledgeSource`，将任何带 front-matter 的 markdown
   （`id` / `title` / `status` + `[[ref]]` 链接）解析为通用 `Doc` 节点。
2. **隔离模型** — `IsolationModel.dbPath(ctx) → string`。
   默认：`SingleRepoIsolation`（单一 `graph.db`，无 org 概念）。
   可选：`OrgProjectIsolation`（`org-{orgId}/project-{projectId}/graph.db`）。
3. **SAGE 信号来源** — `SignalSource → FeedbackEvent[]`。
   默认：`GitHistorySignalSource`、`TestExitCodeSignalSource`。

## 图谱 schema

6 个节点表——`Function`、`Class`、`Module`、`Spec`、`Decision`、`Doc`。
7 个关系表——`CALLS`、`IMPORTS`、`DEFINES`、`IMPLEMENTS`、`IMPACTS`、`SUPERSEDES`、
`REFERENCES`。完整 DDL 与驱动知识导入的 front-matter schema 见 **[docs/API.md](./docs/API.md)**。

## 状态

- [x] **Phase 1** — 骨架（MIT、Node 22、ESM+CJS、tsup、vitest）、Kuzu 抽象 +
      幂等 schema（6 NODE / 7 REL 表）、三个 adapter 接口 + 通用默认、Hono
      `GET /health`、`EmbeddedClient`
- [x] **Phase 2** — CodeGraph：tree-sitter 提取/索引、跨文件 `CALLS` 解析、
      作用域限定的函数 id
- [x] **Phase 3** — KnowledgeGraph：front-matter markdown → `Spec` / `Decision`
      + `IMPACTS` / `SUPERSEDES` 边
- [x] **Phase 4** — SAGE 演化层：置信度反馈（`STEP` 0.25、下限 0.1）、
      `topByConfidence`、`rankedImpact`
- [x] **Phase 5** — REST 路由（`/graph/call-chain`、`/graph/impact-analysis`、
      `/graph/ingest`）、MCP server（5 工具）、独立 `egr` CLI

## 参与贡献

开发环境配置、build/test/health 循环，以及 kuzu + tree-sitter 销毁注意事项见
**[CONTRIBUTING.md](./CONTRIBUTING.md)**。变更记录于 **[CHANGELOG.md](../../CHANGELOG.md)**。

## 许可

MIT — 见 [LICENSE](../../LICENSE)。
