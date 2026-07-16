---
source: docs/MCP.md
source_version: 0.7.0
translation_version: 0.7.0
last_synced: 2026-07-16
status: complete
---

# EngramGraph MCP server

> **语言：** [English](../../../docs/MCP.md) · [繁體中文](../../zh-TW/docs/MCP.md) · 简体中文

EngramGraph 内置一个 [Model Context Protocol](https://modelcontextprotocol.io)
server（stdio 传输），让任何支持 MCP 的编程助手都能把它当成**代码 + 知识图谱记忆**。
它是既有、已测查询函数之上的薄 adapter——**无 LLM、确定性、免 Docker**。

server 以助手通过 stdio 启动的本地子进程运行；没有网络服务、没有容器、没有 API key。

## 配置

server 可执行文件为 `egr-mcp`（等同 `egr mcp`）。它从 `ENGRAM_DB`
（默认 `./.engram/graph.db`）读取图数据库。

### Claude Code

```bash
# 使用已安装的包：
claude mcp add egr -- npx egr-mcp

# 或指向本地 checkout 已 build 的 bin：
claude mcp add egr -- node /abs/path/to/EngramGraph/dist/mcp/stdio.js
```

要固定图谱位置，传入环境变量：

```bash
claude mcp add egr --env ENGRAM_DB=/abs/path/.engram/graph.db -- npx egr-mcp
```

用 `claude mcp list` 验证 → `egr … ✓ Connected`。

### Codex / Cursor / Windsurf（及其他 MCP 客户端）

在客户端的 MCP 配置中加入一个 stdio server。各客户端格式略有不同，但
command/args/env 都一样：

```jsonc
{
  "mcpServers": {
    "egr": {
      "command": "npx",
      "args": ["egr-mcp"],
      "env": { "ENGRAM_DB": "/abs/path/.engram/graph.db" }
    }
  }
}
```

## 工具

| 工具 | 输入 | 返回 |
|------|------|------|
| `index_code` | `files: { path, source }[]` | 将源代码索引进代码图谱（跨文件 `CALLS`）。返回 files/functions/classes/calls（+ ambiguous/unresolved）计数。 |
| `index_docs` | `docs: { content, fallbackId? }[]` | 将带 front-matter 的 markdown 索引进知识图谱。返回 specs/decisions/impacts/supersedes 计数。 |
| `call_chain` | `symbol`、`direction?`（`callers`\|`callees`\|`both`）、`depth?` | 谁调用某函数符号 / 被它调用。“改 X 会坏掉什么？” |
| `impact_analysis` | `nodeId`、`maxHops?` | 某 spec 影响链中的决策（`IMPACTS` + 多跳 `SUPERSEDES`）。 |
| `ingest_feedback` | `nodeId`、`type`、`nodeLabel?`（`Function`\|`Spec`\|`Decision`\|`Doc`）、`weight?` | 按反馈事件（`test_fail`/`test_pass`/`human_fix`）演化节点的 SAGE 置信度。 |
| `implementers` | `specId` | 声明 `// implements <specId>` 的文件及其定义的函数。「哪些代码实现了这个 spec？」读取 `IMPLEMENTS(Module→Spec)` + `DEFINES`。 |
| `implemented_specs` | `moduleId` | 一个文件声明自己实现了哪些 spec。「这段代码受哪个 spec 规范？」`moduleId` 是该文件被索引时的路径。读取 `IMPLEMENTS(Module→Spec)`。 |
| `related` | `seedId`、`depth?`、`limit?` | 从某个种子 id 出发、结构上重要的节点（对所有边类型跑 seeded PageRank，横跨 `Function`/`Spec`/`Module`/`Decision`）。「有什么跟 X 相关？」 |

每个工具都返回一个 JSON 文本内容块；失败时返回 `error: <message>` 并带 `isError: true`。

## 助手流程示例

1. **索引** repo：助手以项目源代码调用 `index_code`，以其 spec/decision markdown 调用 `index_docs`。
2. **问“谁调用 `execute`？”** → 以 `{ symbol: "execute", direction: "callers", depth: 2 }`
   调用 `call_chain`，返回调用者。
3. **问“SPEC-001 背后有哪些决策？”** → 以 `{ nodeId: "SPEC-001" }` 调用
   `impact_analysis`，返回如 `[ADR-001, ADR-002]`。
4. **记录结果**：某函数测试失败后，以 `{ nodeId, type: "test_fail" }` 调用
   `ingest_feedback` 降低该节点置信度，使下次的排名查询优先浮现被更多次强化的节点。

## 备注

- 连接是**长生命周期**；EngramGraph 不会每次调用就关闭它（kuzu + tree-sitter 销毁注意事项——见
  [CONTRIBUTING.md](../CONTRIBUTING.md)）。
- 图谱与 `egr` CLI 及 REST server 共用：用任一模式索引一次，从另一个查询。
- 置信度语义（`STEP` 0.25、下限 0.1）与完整 DDL 见 [API.md](./API.md)。
