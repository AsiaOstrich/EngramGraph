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

**Windows（PowerShell，非 WSL）。** 有使用者在 Windows 11 上以全域安裝
（`npm i -g engramgraph`）、透過 `cmd /c` 啟動 bin，實測可連線：

```powershell
claude mcp add egr --scope local -e "ENGRAM_DB=C:\abs\path\.engram\graph.db" -- cmd /c egr-mcp
```

上方 `npx egr-mcp` 的寫法**尚未**在原生 Windows 上驗證。若在那裡連不上，
請改用全域安裝與上面這道指令。

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
| `blindspots` | — | 解析不完全或失敗的檔案（來自 parse-health manifest）——圖可能缺少節點／邊的地方。當查詢回報 `indexHealth.possiblyIncomplete` 時用它查出**缺的是什麼**。`manifestPresent` 用來區分「沒有問題」與「從未量測過」。 |
| `signatures` | — | 同一批檔案改以**根本原因**分組而非逐一列出——把「584 個檔案」變成「1 個問題」。當 `blindspots` 回傳很長的清單時使用。 |
| `doctor` | — | 哪些語言可用、不可用的原因、這台機器上有哪些是自行編譯的、哪些指令需要網路。**不開啟圖**，所以在「索引本身壞掉」時仍然回答得出來。 |
| `refs_check` | `paths: string[]` | 檢查 Markdown 檔案／目錄中（反引號包住的）檔案路徑與符號引用，對照圖與 `git` 是否仍然正確。每個引用回報 `present`（仍存在）｜`moved`（附新位置）｜`missing`（找不到）｜`unresolvable`（資訊不足，例如引用的是這個圖沒有索引的另一個 repo——絕不回報成 `missing`）。唯讀，不會修改圖或被檢查的檔案。抽取規則見 [CLI.md](./CLI.md)。 |

每個工具都回傳一個 JSON 文字內容區塊；失敗時回傳 `error: <message>` 並帶 `isError: true`。

有兩種失敗是「答案」而不是當機，而且都不會被當成空結果回傳：

- **圖裡沒有這個名字。** 對圖裡沒有的函式呼叫 `call_chain`、對沒見過的 spec id 呼叫 `impact_analysis`，
  回傳錯誤（`no function named "X" is in the graph — this is not the same as "nothing calls it"`），
  有相近名稱時一併列出。在圖裡但沒有呼叫者的函式，回傳 `callers: []` 並帶 `symbolFound: true`。
- **另一個行程正在寫圖。** 查詢會重試約 5 秒（可用 `ENGRAM_LOCK_WAIT_MS` 調整），然後回傳
  `the graph … is being written by another process … This is not an empty result`。

### 透過 stdio 被拒絕的工具，以及原因

stdio server 只在**一次查詢的期間**把圖**唯讀**開啟，查完就關。這個引擎是單一寫入者，而 server 是
長生命的——它跟你的編輯器開多久就活多久。如果它握有寫入控制代碼，你在終端機同時執行的任何 `egr`
指令都會跟它搶，而這個引擎上兩個寫入者不是單純拒絕輸的那個，是**把資料庫毀掉**。如果它在查詢之間握著
唯讀控制代碼，一樣會擋住那些指令：引擎在開檔時就上鎖，任何平台都一樣。（0.12.0 就是這樣；在
Windows 11 上，編輯器開著的整段時間裡 `egr index`、`egr feedback`、`egr god-nodes`、`egr related`
都會失敗。）

所以 server 在查詢之間什麼都不握——每次工具呼叫付出一次開與關（小圖約 20 ms），終端機指令只會碰到
「此刻正在跑」的那一次查詢；同時重疊的工具呼叫共用同一次開啟。有四個工具在這裡被拒絕，每個都會指名該改跑
哪個指令——而那個指令在 server 執行時就能用：

| 工具 | 改跑 |
|------|------|
| `index_code` | `egr index <dir>` |
| `index_docs` | `egr index <dir> --docs` |
| `ingest_feedback` | `egr feedback <type> <node-id>` |
| `related` | `egr related <seed-id>` |

server 會在下一次查詢時看到結果——不需要重新啟動。在第一次 `egr index` 之前就啟動的 server，每次查詢都會回答
「No graph at …」，圖一出現就開始正常運作。

### 工具標註（DEC-115 L2）

每個工具都宣告了 MCP 規格的 `readOnlyHint`／`destructiveHint`／`idempotentHint`／
`openWorldHint`——這些是提示，不是保證，但完全不宣告就等於什麼線索都沒給用戶端。
每一格的值都是**讀過該工具的實作**才定的，不是照名字猜的：`related` 讀起來像查詢，
但排名前必須先安裝算法擴充、建立投影圖，兩者都是寫入，所以它的 `readOnly` 是 false。

| 工具 | readOnly | destructive | idempotent | openWorld |
|------|:--:|:--:|:--:|:--:|
| `index_code` | false | false | true | false |
| `index_docs` | false | false | true | false |
| `call_chain` | true | false | true | false |
| `impact_analysis` | true | false | true | false |
| `ingest_feedback` | false | false | **false** | false |
| `implementers` | true | false | true | false |
| `implemented_specs` | true | false | true | false |
| `related` | **false** | false | true | false |
| `blindspots` | true | false | true | false |
| `signatures` | true | false | true | false |
| `doctor` | true | false | true | false |
| `refs_check` | true | false | true | false |

全部都不連網（`openWorldHint: false`）——圖、檔案系統與 `git` 都是本機的。
只有 `ingest_feedback` 不是冪等的：它套用的是信心度的**增量**，同一組參數呼叫兩次
會改變分數兩次，不是一次。

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
