---
source: docs/CLI.md
source_version: 0.1.0
translation_version: 0.1.0
last_synced: 2026-05-30
status: complete
---

# CodeSage CLI

> **語言：** [English](../../../docs/CLI.md) · 繁體中文 · [简体中文](../../zh-CN/docs/CLI.md)

`codesage` CLI 會把一個 repo 索引進圖譜，並可從 shell 或 CI 查詢它。它是 library 與
MCP server 共用的同一批已測函式之上的薄層——無 LLM、確定性。

```
codesage <command> [args] [options]
```

## 圖譜資料庫位置

每個命令都讀寫同一個 Kuzu 資料庫，路徑依序解析自：

1. 明確的環境變數 `CODESAGE_DB`，否則
2. 目前工作目錄下的 `./.codesage/graph.db`。

目錄會在需要時建立，且每次開啟都會確保 schema 存在（冪等），因此首次 `index` 也能在空 repo 上運作。

## 全域選項

| 選項 | 說明 |
|------|------|
| `--json` | 輸出原始 JSON，而非人類可讀摘要 |
| `-h`、`--help` | 顯示用法 |
| `-v`、`--version` | 顯示套件版本 |

## 命令

### `index <dir> [--docs]`

遞迴將 `<dir>` 下的原始碼索引進**程式碼圖譜**（tree-sitter → `Function` / `Class` /
`Module` 節點 + 跨檔 `CALLS`）。加上 `--docs` 時，也會把 `*.md` 索引進**知識圖譜**
（front-matter → `Spec` / `Decision` + `IMPACTS` / `SUPERSEDES`）。

- 程式碼副檔名：`.ts .tsx .js .jsx .mts .cts .mjs .cjs`（排除 `.d.ts`）。
- 略過的目錄：`node_modules`、`dist`、`.codesage`、`.git`、`coverage`。

```bash
codesage index ./src
codesage index . --docs
```

輸出計數：`files`、`functions`、`classes`、`calls`，以及 `ambiguous`（被呼叫名稱比對到
> 1 個函式——略過）與 `unresolved`（比對不到——略過）；加上 `--docs` 時還有
`specs` / `decisions` / `impacts` / `supersedes`。

### `callers <symbol> [--depth N]`

（可遞移，最多到 `--depth`，預設 1）呼叫 `<symbol>` 的函式。「改這個會牽動什麼？」

```bash
codesage callers callChain --depth 2
```

### `callees <symbol> [--depth N]`

`<symbol>`（可遞移，最多到 `--depth`，預設 1）所呼叫的函式。

```bash
codesage callees createMcpServer
```

> `--depth` 會被夾到 `1..10`。符號以**名稱**比對；若名稱在多個檔案重複使用，所有相符者都會被納入。

### `impact <spec-id> [--max-hops N]`

某個 spec 的影響鏈中的決策——哪些 `Decision` 節點透過直接的 `IMPACTS` 邊，加上多跳
`SUPERSEDES` 鏈（`--max-hops`，預設 3，夾到 `1..10`），影響此 `Spec`。

```bash
codesage impact XSPEC-237
codesage impact XSPEC-237 --max-hops 5 --json
```

每筆結果顯示決策 `id`、抵達方式（`direct` | `supersedes`）與其 `title`。

### `feedback <type> <node-id> [--label L]`

依一個回饋事件演化某節點的 SAGE 信心度。

- `<type>`：`test_fail`（負向、權重 1.0）、`test_pass`（正向、0.4）、
  `human_fix`（正向、0.6）、`status_change`（中性）。
- `--label`：`Function`（預設）| `Spec` | `Decision` | `Doc`。
- 節點以 **id** 比對（`Decision` / `Spec` 的 id 例如 `DEC-1` / `XSPEC-1`；
  `Function` 則是 scope 限定的 id，如 `src/a.ts#a`）。

```bash
codesage feedback test_fail "src/api/server.ts#createServer"
codesage feedback human_fix DEC-070 --label Decision
```

印出 `before → after`，若 id/label 沒命中則印 "node not found"。

### `top <label> [--limit N]`

某標籤下信心度最高的節點，依信心度遞減。

- `<label>`：`Function` | `Spec` | `Decision` | `Doc`。
- `--limit`：預設 10，夾到 `1..1000`。

```bash
codesage top Function --limit 20
codesage top Decision --json
```

### `serve [--port 3000]`

在圖譜資料庫上執行 REST server（Hono）。路由掛載於 `/graph/*` 加上 `GET /health`。
長時間執行——自行管理生命週期。路由介面見 [API.md](./API.md)。

```bash
codesage serve --port 3000
```

### `mcp`

以 stdio 執行 MCP server 供程式助理使用，與 `codesage-mcp` bin 相同。長時間執行。
助理設定見 [MCP.md](./MCP.md)。

```bash
codesage mcp
```

## CI 範例

```bash
export CODESAGE_DB="$PWD/.codesage/graph.db"
codesage index ./src --docs
# 例如：當高風險符號出現新的呼叫者時讓 job 失敗，用 --json 查詢等。
codesage callers paymentGateway --depth 3 --json > callers.json
```

## 結束碼

成功為 `0`；錯誤為 `1`（訊息以 `codesage: <message>` 寫到 stderr）。
