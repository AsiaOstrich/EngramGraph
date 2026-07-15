---
source: docs/CLI.md
source_version: 0.3.0
translation_version: 0.3.0
last_synced: 2026-07-15
status: complete
---

# EngramGraph CLI

> **語言：** [English](../../../docs/CLI.md) · 繁體中文 · [简体中文](../../zh-CN/docs/CLI.md)

`egr` CLI 會把一個 repo 索引進圖譜，並可從 shell 或 CI 查詢它。它是 library 與
MCP server 共用的同一批已測函式之上的薄層——無 LLM、確定性。

```
egr <command> [args] [options]
```

## 圖譜資料庫位置

每個命令都讀寫同一個 Kuzu 資料庫，路徑依以下優先序解析：

1. 環境變數 `ENGRAM_DB`（完整路徑，最高），否則
2. `--graph <name>` → `./.engram/<name>.db`，否則
3. `--isolation git-branch`（或環境變數 `ENGRAM_ISOLATION=git-branch`）→ 每分支一個
   `<git-common-dir>/engram/<branch>.db`，否則
4. 預設單一 `./.engram/graph.db`。

目錄會在需要時建立，且每次開啟都會確保 schema 存在（冪等），因此首次 `index` 也能在空 repo 上運作。
見下方[分支 / 專案隔離](#分支--專案隔離)。

## 全域選項

| 選項 | 說明 |
|------|------|
| `--json` | 輸出原始 JSON，而非人類可讀摘要 |
| `--graph <name>` | 使用 `./.engram/<name>.db`——顯式命名的專案圖譜 |
| `--isolation <mode>` | `single`（預設）或 `git-branch`（每分支一張圖）|
| `-h`、`--help` | 顯示用法 |
| `-v`、`--version` | 顯示套件版本 |

## 命令

### `index <dir> [--docs] [--clean] [--scip <path>]`

遞迴將 `<dir>` 下的原始碼索引進**程式碼圖譜**（tree-sitter → `Function` / `Class` /
`Module` 節點 + 跨檔 `CALLS`）。加上 `--docs` 時，也會把 `*.md` 索引進**知識圖譜**
（front-matter → `Spec` / `Decision` + `IMPACTS` / `SUPERSEDES`）。

- 程式碼副檔名：`.ts .tsx .js .jsx .mts .cts .mjs .cjs .cs .py .go .java
  .kt .kts .rs .cpp .cc .cxx .hpp .h .hh .rb .php .dart`（排除 `.d.ts`）。
- 略過的目錄：`node_modules`、`dist`、`.engram`、`.git`、`coverage`、`bin`、
  `obj`、`__pycache__`、`.venv`、`venv`、`vendor`、`target`、`build`。
- `--clean`：索引前先清空圖譜資料。索引本是 upsert（MERGE）從不刪除，程式裡被移除的節點
  會殘留；`--clean` 從頭重建以清掉它。

```bash
egr index ./src
egr index . --docs
egr index ./src --clean   # 重建，清掉已刪除的節點
```

輸出計數：`files`、`functions`、`classes`、`calls`，以及 `ambiguous`（被呼叫名稱比對到
> 1 個函式——略過）與 `unresolved`（比對不到——略過）；加上 `--docs` 時還有
`specs` / `decisions` / `impacts` / `supersedes`。

#### `--scip <path>` —— 疊加 SCIP 索引以提升 CALLS 精確度

tree-sitter 自身以名稱比對的 CALLS 解析刻意保守：當被呼叫的名稱在整個 repo
中比對到超過一個函式時，它會略過該呼叫而非用猜的（即上面輸出裡的
`ambiguous`）。[SCIP] 索引——由該語言真正基於編譯器/型別檢查器的索引工具產生
——帶有無歧義的符號參照，因此 `--scip` 會把它疊加在 tree-sitter pass 之上，
解析出 tree-sitter 單獨無法解析的呼叫，並提升它已解析呼叫的信心值。

[SCIP]: https://github.com/sourcegraph/scip

```bash
# 1. 自行用該語言的索引工具產生 .scip 檔。
#    egr 本身不會呼叫 dotnet/java/maven 或任何其他建置工具鏈——
#    這一步完全是你自己建置環境的責任。
dotnet tool install --global scip-dotnet   # 只需一次
scip-dotnet index MyProject.csproj --output index.scip

# 2. 讓 egr 讀它。--scip 一律先跑完整的 tree-sitter pass，再疊加 SCIP 資料
#    ——單一指令就是完整、從頭開始的索引；不需要先跑過一次普通的
#    `egr index`。
egr index . --scip index.scip
```

需求與失敗模式：

- **`<dir>` 必須是外部索引工具當初執行的同一個專案根目錄。** SCIP 索引裡
  occurrence 的路徑是相對於那個根目錄的；若跟 `<dir>` 自身的檔案路徑對不上，
  `egr` 會丟出「none of the N document path(s) ... matched any source file
  under `<dir>`」這類明確錯誤，而不是悄悄地什麼都沒 ingest 到。SCIP 路徑依
  規範一律用 `/` 分隔；`egr` 自身的路徑現在也一律正規化成 `/`，不受主機
  作業系統影響——設計上這個比對在 Windows 上也能對上、不只 POSIX，但只用
  模擬 Windows 風格路徑字串的單元測試驗證過（此專案自己的 CI 沒有真正的
  Windows 主機可測）。若 `--scip` 回報檔案有匹配到、但解析出的
  definitions/calls 數是零，此情況下會印出警告；可能成因之一是 `.scip`
  檔已過期——是在原始碼樹之後又被編輯過之前產生的，所以路徑對得上但內容
  已經對不上。
- `<path>` 指到不存在或非 SCIP 的檔案時，會丟出明確的「file not found」或
  「could not be parsed as a SCIP protobuf index」錯誤。
- 若圖譜資料庫的 `CALLS` 表是在此功能的 schema 變動（`provider`/`confidence`
  欄位）之前建立的，會丟出說明修法的錯誤：**`--clean` 無法解決這個問題**
  （它只透過 `DETACH DELETE` 清資料列，從不動資料表 schema——資料表一旦存在，
  `initSchema` 的 `CREATE TABLE` 就是空操作）。要修，得把圖譜資料庫檔案本身刪掉
  （預設是 `.engram/graph.db` 加它的 `.wal` 附屬檔，或
  `ENGRAM_DB`/`--graph`/`--isolation` 解出來的那個路徑——見上方
  [圖譜資料庫位置](#圖譜資料庫位置)），然後對著這個已清空的路徑重新執行
  `egr index`。
- 目前已對 `scip-dotnet`（C#）與 `scip-java`（Java）的輸出驗證過；理論上任何
  符合 SCIP 規範、對應到 tree-sitter 已支援語言的索引工具原理上都應該同樣可用
  （合併邏輯本身與語言無關），但實際上尚未對第三種索引工具實測過。

輸出會多一個 `scip` 區塊：`documentsInIndex`（`.scip` 檔裡的文件數）、
`filesMatched`（其中有多少與 `<dir>` 自身的檔案重疊——小於
`documentsInIndex` 是正常現象，例如索引工具看得到、但 `egr` 刻意略過的
編譯器產生檔）、`definitionsResolved` / `definitionsUnresolved`、
`callsEmitted`，以及兩個略過計數 `callsSkippedNoEnclosingCaller` /
`callsSkippedUnresolvedTarget`。若檔案有匹配到、但解析結果是零，人類可讀輸出
會多印一行 `WARNING`，而不是把全零結果悄悄當成成功回報。

### `callers <symbol> [--depth N]`

（可遞移，最多到 `--depth`，預設 1）呼叫 `<symbol>` 的函式。「改這個會牽動什麼？」

```bash
egr callers callChain --depth 2
```

### `callees <symbol> [--depth N]`

`<symbol>`（可遞移，最多到 `--depth`，預設 1）所呼叫的函式。

```bash
egr callees createMcpServer
```

> `--depth` 會被夾到 `1..10`。符號以**名稱**比對；若名稱在多個檔案重複使用，所有相符者都會被納入。

### `impact <spec-id> [--max-hops N]`

某個 spec 的影響鏈中的決策——哪些 `Decision` 節點透過直接的 `IMPACTS` 邊，加上多跳
`SUPERSEDES` 鏈（`--max-hops`，預設 3，夾到 `1..10`），影響此 `Spec`。

```bash
egr impact SPEC-001
egr impact SPEC-001 --max-hops 5 --json
```

每筆結果顯示決策 `id`、抵達方式（`direct` | `supersedes`）與其 `title`。

### `feedback <type> <node-id> [--label L]`

依一個回饋事件演化某節點的 SAGE 信心度。

- `<type>`：`test_fail`（負向、權重 1.0）、`test_pass`（正向、0.4）、
  `human_fix`（正向、0.6）、`status_change`（中性）。
- `--label`：`Function`（預設）| `Spec` | `Decision` | `Doc`。
- 節點以 **id** 比對（`Decision` / `Spec` 的 id 例如 `ADR-1` / `SPEC-1`；
  `Function` 則是 scope 限定的 id，如 `src/a.ts#a`）。

```bash
egr feedback test_fail "src/api/server.ts#createServer"
egr feedback human_fix ADR-002 --label Decision
```

印出 `before → after`，若 id/label 沒命中則印 "node not found"。

### `top <label> [--limit N]`

某標籤下信心度最高的節點，依信心度遞減。

- `<label>`：`Function` | `Spec` | `Decision` | `Doc`。
- `--limit`：預設 10，夾到 `1..1000`。

```bash
egr top Function --limit 20
egr top Decision --json
```

### `gc [--dry-run]`

回收已不存在分支的 per-branch 圖譜。檢查 `<git-common-dir>/engram/`；當沒有任何現存
本地分支對應到 `<name>` 時，`<name>.db` 即為孤兒。`--dry-run` 只列不刪。非 git repo 時為 no-op。

```bash
egr gc --dry-run
egr gc
```

### `serve [--port 3000]`

在圖譜資料庫上執行 REST server（Hono）。路由掛載於 `/graph/*` 加上 `GET /health`。
長時間執行——自行管理生命週期。路由介面見 [API.md](./API.md)。

```bash
egr serve --port 3000
```

### `mcp`

以 stdio 執行 MCP server 供程式助理使用，與 `egr-mcp` bin 相同。長時間執行。
助理設定見 [MCP.md](./MCP.md)。

```bash
egr mcp
```

## 分支 / 專案隔離

預設所有命令共用同一個 `./.engram/graph.db`。由於 `.engram/` 被 gitignore 且待在工作樹，
**`git checkout` 不會換掉它**——不同分支共用同一張圖。三種隔離方式：

1. **`--isolation git-branch`**（或在 shell 設一次 `ENGRAM_ISOLATION=git-branch`）：每個分支
   各自 `<git-common-dir>/engram/<branch>.db`，切分支後仍在、不污染工作樹。分支名會加 hash
   後綴消毒，故 `feature/x` 與 `feature-x` 永不碰撞。用 `egr gc` 回收已刪分支的圖。
2. **`--graph <name>`**：顯式、與 git 無關的專案圖——適合 detached HEAD 或分支命名隨意時。
3. **`git worktree`**：每個分支各自 checkout 到獨立目錄，天然各有 `./.engram/graph.db`——
   零旗標、最乾淨,當分支對應長期獨立專案時最合適。

> **MCP 注意**：MCP server 在啟動時綁定一張圖（路徑記到 stderr），**不會**跟著之後的
> `git checkout`——要切換需重連/重啟 server（或啟動時帶 `--graph` / `ENGRAM_ISOLATION`）。

## CI 範例

```bash
export ENGRAM_DB="$PWD/.engram/graph.db"
egr index ./src --docs
# 例如：當高風險符號出現新的呼叫者時讓 job 失敗，用 --json 查詢等。
egr callers paymentGateway --depth 3 --json > callers.json
```

## 結束碼

成功為 `0`；錯誤為 `1`（訊息以 `egr: <message>` 寫到 stderr）。
