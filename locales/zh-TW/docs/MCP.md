---
source: docs/MCP.md
source_version: 0.7.0
translation_version: 0.7.0
last_synced: 2026-07-16
status: complete
---

# EngramGraph MCP server

> **語言：** [English](../../../docs/MCP.md) · 繁體中文 · [简体中文](../../zh-CN/docs/MCP.md)

EngramGraph 內附一個 [Model Context Protocol](https://modelcontextprotocol.io)
server（stdio 傳輸），讓任何支援 MCP 的程式助理都能把它當成**程式碼 + 知識圖譜記憶**。
它是既有、已測查詢函式之上的薄 adapter——**無 LLM、確定性、免 Docker**。

server 以助理透過 stdio 啟動的本機子行程運行；沒有網路服務、沒有容器、沒有 API key。

## 設定

server 執行檔為 `egr-mcp`（等同 `egr mcp`）。它從 `ENGRAM_DB`
（預設 `./.engram/graph.db`）讀取圖譜資料庫。

### Claude Code

```bash
# 使用已安裝的套件：
claude mcp add egr -- npx egr-mcp

# 或指向本機 checkout 已 build 的 bin：
claude mcp add egr -- node /abs/path/to/EngramGraph/dist/mcp/stdio.js
```

要固定圖譜位置，傳入環境變數：

```bash
claude mcp add egr --env ENGRAM_DB=/abs/path/.engram/graph.db -- npx egr-mcp
```

以 `claude mcp list` 驗證 → `egr … ✓ Connected`。

### Codex / Cursor / Windsurf（及其他 MCP 用戶端）

在用戶端的 MCP 設定中加入一個 stdio server。各用戶端格式略有不同，但
command/args/env 都一樣：

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

| 工具 | 輸入 | 回傳 |
|------|------|------|
| `index_code` | `files: { path, source }[]` | 將原始碼索引進程式碼圖譜（跨檔 `CALLS`）。回傳 files/functions/classes/calls（+ ambiguous/unresolved）計數。 |
| `index_docs` | `docs: { content, fallbackId? }[]` | 將帶 front-matter 的 markdown 索引進知識圖譜。回傳 specs/decisions/impacts/supersedes 計數。 |
| `call_chain` | `symbol`、`direction?`（`callers`\|`callees`\|`both`）、`depth?` | 誰呼叫某函式符號 / 被它呼叫。「改 X 會壞掉什麼？」 |
| `impact_analysis` | `nodeId`、`maxHops?` | 某 spec 影響鏈中的決策（`IMPACTS` + 多跳 `SUPERSEDES`）。 |
| `ingest_feedback` | `nodeId`、`type`、`nodeLabel?`（`Function`\|`Spec`\|`Decision`\|`Doc`）、`weight?` | 依回饋事件（`test_fail`/`test_pass`/`human_fix`）演化節點的 SAGE 信心度。 |
| `implementers` | `specId` | 宣告 `// implements <specId>` 的檔案及其定義的函式。「哪些程式碼實作了這個 spec？」讀取 `IMPLEMENTS(Module→Spec)` + `DEFINES`。 |
| `implemented_specs` | `moduleId` | 一個檔案宣告自己實作了哪些 spec。「這段程式碼受哪個 spec 規範？」`moduleId` 是該檔案被索引時的路徑。讀取 `IMPLEMENTS(Module→Spec)`。 |
| `related` | `seedId`、`depth?`、`limit?` | 從某個種子 id 出發、結構上重要的節點（對所有邊型跑 seeded PageRank，橫跨 `Function`/`Spec`/`Module`/`Decision`）。「有什麼跟 X 相關？」 |

每個工具都回傳一個 JSON 文字內容區塊；失敗時回傳 `error: <message>` 並帶 `isError: true`。

## 助理流程範例

1. **索引** repo：助理以專案原始碼呼叫 `index_code`，以其 spec/decision markdown 呼叫 `index_docs`。
2. **問「誰呼叫 `execute`？」** → 以 `{ symbol: "execute", direction: "callers", depth: 2 }`
   呼叫 `call_chain`，回傳呼叫者。
3. **問「SPEC-001 背後有哪些決策？」** → 以 `{ nodeId: "SPEC-001" }` 呼叫
   `impact_analysis`，回傳如 `[ADR-001, ADR-002]`。
4. **記錄結果**：某函式測試失敗後，以 `{ nodeId, type: "test_fail" }` 呼叫
   `ingest_feedback` 降低該節點信心度，使下次的排名查詢優先浮現被更多次強化的節點。

## 備註

- 連線是**長生命**；EngramGraph 不會每次呼叫就關閉它（kuzu + tree-sitter 拆除注意事項——見
  [CONTRIBUTING.md](../CONTRIBUTING.md)）。
- 圖譜與 `egr` CLI 及 REST server 共用：用任一模式索引一次，從另一個查詢。
- 信心度語意（`STEP` 0.25、下限 0.1）與完整 DDL 見 [API.md](./API.md)。
