---
source: README.md
source_version: 0.7.0
translation_version: 0.7.0
last_synced: 2026-07-16
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

### 平台支援矩陣

EngramGraph 依賴 [`ryugraph`](https://github.com/predictable-labs/ryugraph) 作為嵌入式圖譜資料庫，該套件按平台附上預先編譯好的原生二進位檔。截至 `ryugraph@25.9.1`，已驗證的支援狀況為：

| 平台 | 狀態 | 備註 |
|------|------|------|
| macOS ARM64（Apple Silicon）| ✅ 可用 | 已透過 [Cross-Platform Compatibility Check](.github/workflows/release-compat-check.yml)（`macos-latest`）驗證 |
| macOS x64（Intel）| ⚠️ 未經 CI 驗證（已知限制，見下方）| 目前無已知問題——`ryujs-darwin-x64.node` 是獨立、正當建置的二進位檔（不同於 Linux ARM64 的情況）——但沒有自動化發布關卡驗證 |
| Linux x64，glibc ≥ 2.38（Ubuntu 24.04+、Debian 13+）| ✅ 可用 | 已透過 CI glibc 相容性矩陣驗證（`node:24-trixie`，glibc 2.41）|
| Linux x64，glibc < 2.38（Ubuntu 22.04 LTS、Debian 12）| ❌ 無法使用 | 上游 `ryugraph` 二進位檔需要比這些仍常見的 LTS 發行版所附更新的 glibc。已透過 CI glibc 相容性矩陣驗證（`node:24`，glibc 2.36）|
| Linux ARM64（任何 glibc）| ❌ 無法使用 | 上游把 x86-64 的二進位檔用 arm64 的檔名發布——追蹤於 [predictable-labs/ryugraph#48](https://github.com/predictable-labs/ryugraph/issues/48)。已透過 CI（`ubuntu-24.04-arm`）驗證 |
| Windows x64 | ✅ 可用 | 已透過 CI（`windows-latest`）驗證 |

這會影響 **Apple Silicon Mac 上的 Docker Desktop**（預設用 `linux/arm64`）與
**AWS Graviton／其他 ARM64 Linux 主機**——若 `egr` 在這些環境上失敗，很可能就是
[#48](https://github.com/predictable-labs/ryugraph/issues/48)，不是你的環境設定有問題。
在受影響的 Docker 主機上強制 `--platform linux/amd64` 可以繞過（代價是在 ARM64 硬體上以模擬方式執行），直到上游修正為止。

另外請注意：npm ≥ 11 預設會把原生安裝腳本（含 `ryugraph` 的）擋在核准提示之後。若 `npm install`
印出 `npm warn allow-scripts`，請執行 `npm approve-scripts --all` 後重新安裝——否則原生二進位檔永遠不會被複製到位。

**為什麼 macOS Intel 沒有納入自動化發布關卡。** 這不是疏漏，是刻意的決定，有兩個獨立事實指向同一個方向：

- **GitHub 自家的 Intel Mac（`macos-13`）代管 runner 目前有嚴重的排隊容量限制。** 2026-07-10 的一次實測執行在
  `queued` 狀態卡了約 50 分鐘都沒開始跑。GitHub Actions 的 `timeout-minutes` 無法限制這種情況——它只在
  job 真正開始執行後才開始計時，排隊期間不算——所以沒有可靠的方式能限制一個發布卡在等待這個 runner 上的時間。
- **Apple 自家的支援生命週期正在收尾。** macOS 26「Tahoe」是最後一個支援 Intel Mac 的主要版本；
  macOS 27「Golden Gate」（預計 2026 年 9 月）會完全移除 Intel 支援，macOS 26 大約只到 2029 年為止還有
  純安全性更新。Intel Mac 在 Apple 與 GitHub 兩邊都是正在淡出的平台。

既然如此，讓每次發布都卡在一個可能永遠排不到、而且是正在淡出的平台的 runner 上，並不合理。改為讓
[`release-compat-check.yml`](.github/workflows/release-compat-check.yml) 裡的 `macos-x64-intel-manual`
以**盡力而為、非阻斷**的方式跑 Intel Mac 驗證：可透過 `workflow_dispatch` 手動觸發、`continue-on-error: true`
所以永遠不會讓發布失敗，也不掛在 `release: published` 觸發條件上，確保真正的發布不會被它卡住。若你特別
需要確認 Intel Mac 支援狀況，可手動觸發該 job 查看結果——但發布流程本身不依賴它。

### 疑難排解：容易誤導人的原生二進位檔錯誤

Linux 上的原生二進位檔載入失敗，會透過 Node 的 `dlopen` 呈現，其錯誤文字不見得能反映真正的原因：

| 你看到的錯誤 | 通常代表的意思 |
|------|------|
| `ryujs.node: cannot open shared object file: No such file or directory`（用 `ls` 檢查檔案*確實存在*）| CPU 架構不對——該路徑上的二進位檔是給另一個平台/架構用的 |
| `.../libc.so.6: version 'GLIBC_2.38' not found` | 你的發行版 glibc 版本比預建二進位檔要求的舊（見上方矩陣）|
| `npm warn allow-scripts ... not yet covered by allowScripts` | npm ≥ 11 擋下了複製原生二進位檔的安裝腳本——執行 `npm approve-scripts --all` 後重新安裝/重建 |

若你遇到的問題不在上表範圍內，請先查
[predictable-labs/ryugraph 的 issues](https://github.com/predictable-labs/ryugraph/issues)，
再判斷是不是 EngramGraph 本身的問題——多數原生載入失敗都源自 `ryugraph` 這個相依套件，不是本套件。

### 相依套件安全性警告（`npm audit`、已棄用套件）

不論全域安裝、`npx`、或當成專案相依套件安裝，目前跑 `npm install` 都會印出這類警告：

```
npm warn deprecated npmlog@6.0.2: This package is no longer supported.
npm warn deprecated are-we-there-yet@3.0.1: This package is no longer supported.
npm warn deprecated gauge@4.0.4: This package is no longer supported.
npm warn deprecated tar@6.2.1: ...widely publicized security vulnerabilities...
4 high severity vulnerabilities
```

四項全部源自同一條依賴鏈：`ryugraph`（本套件的嵌入式圖譜資料庫引擎）鎖定
`cmake-js@^7.3.0`，而它依賴 `tar@^6.2.0`（多個高風險路徑穿越 CVE，已在 `tar@7.5.11`+
修復）與現已棄用的 `npmlog`/`gauge`/`are-we-there-yet` 堆疊。`cmake-js@8.0.0` 已經拿掉
`npmlog`、把 `tar` 升到 `^7.5.6`——修法在上游已經存在，只是 `ryugraph` 還沒採用。追蹤於
[predictable-labs/ryugraph#49](https://github.com/predictable-labs/ryugraph/issues/49)。

**實際風險範圍比警告數量看起來要窄。** `ryugraph` 自己的 `install.js` 只有在你的平台
沒有預建原生二進位檔時，才會呼叫 `cmake-js`（進而牽動 `tar`）——見上方平台支援矩陣。
在矩陣裡標示 `✅ 可用` 的每個平台上，預建二進位檔會直接被複製使用，`cmake-js`/`tar`
雖然會被抓進 `node_modules`，但完全不會被執行。這個宣告的漏洞是真實的（不管有沒有
被執行，`npm audit`／SBOM 工具照樣會回報），但實際能被利用的窗口，實質上僅限於
走 build-from-source 路徑的情境（不支援的平台，或明確設定 `NPM_CONFIG_BUILD_FROM_SOURCE`）。

**若你是把 `engramgraph`當成自己專案裡的一般相依套件安裝**（而非全域安裝），你今天
就能自行解決——把同樣的 override 加進**你自己的** `package.json`：

```json
"overrides": {
  "cmake-js": "^8.0.0"
}
```

（上面是 npm 語法；pnpm/Yarn 有對應的 `pnpm.overrides` / `resolutions` 欄位。）這之所以
有效，是因為 npm 的 `overrides` 欄位只在「執行 `npm install` 的那個專案本身」才會生效——
不會從相依套件自己的 `package.json` 傳遞到你的專案，這正是為什麼 `engramgraph` 自己
package.json 裡（先前修復時加的）那個 `overrides` 對你沒有幫助：它只清乾淨了本 repo
原始碼 checkout 裡的 `npm audit`，對裝了已發布套件的人完全沒用。若是全域安裝或
`npx engramgraph`，沒有專案根目錄可以掛 override，這條路目前還沒有解法——得等上面連結的
上游 issue 被處理。

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

EngramGraph 內附一個 MCP server（stdio），暴露 8 個工具——`index_code`、`index_docs`、
`call_chain`、`impact_analysis`、`ingest_feedback`、`implementers`、`implemented_specs`、
`related`——讓任何支援 MCP 的助理都能把它當成程式碼 + 知識圖譜使用。無 LLM、確定性、**免 Docker**。

```bash
# Claude Code，使用已安裝的套件：
claude mcp add egr -- npx egr-mcp
```

完整設定（Claude Code / Codex / Cursor / Windsurf）、全部 8 個工具與範例流程：
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
8 個關係表——`CALLS`、`IMPORTS`、`DEFINES`、`IMPLEMENTS`、`IMPACTS`、`SUPERSEDES`、
`RELATES`、`REFERENCES`。完整 DDL 與驅動知識匯入的 front-matter schema 見 **[docs/API.md](./docs/API.md)**。

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
