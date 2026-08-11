---
source: README.md
source_version: 0.8.0
translation_version: 0.8.0
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

### 接上你的 coding assistant（MCP）

`egr` 同時附有 MCP server，讓助理可以查詢圖譜——也可以更新它——不必你手動跑任何東西。**它不會自動註冊**，而且是刻意的：一個套件若在 `npm install` 期間把自己寫進你助理的工具設定，等於未經詢問就自行取得了工具存取權。

Claude Code 只需一道指令：

```bash
claude mcp add egr -- npx egr-mcp
```

確認它真的生效——安裝本身不是證據，這個才是：

```bash
claude mcp list   # egr … ✓ Connected
```

若希望整個團隊都拿得到，改用 `--scope project`：它會寫出一份可以進版控的 `.mcp.json`，每個人首次使用時被提示核准一次。**設定內容要保持可攜**——把某台機器的 Node 絕對路徑寫死，正是一份進了版控的 `.mcp.json` 在別人電腦上靜靜失效的常見原因。`ENGRAM_DB` 預設是 `./.engram/graph.db`，通常可以整個省略。

Codex／Cursor／Windsurf、8 個工具的完整清單與範例流程：**[docs/MCP.md](./docs/MCP.md)**。

> **從助理端建索引有一個值得知道的限制。** `index_code` 工具收的是檔案**內容**而非目錄——它不會自己走檔案系統。因此它適合更新助理剛剛改過的那幾個檔，不適合索引整個 repo。整庫索引請用 `egr index ./src`。

### 原生相依與平台支援

EngramGraph 有**兩個**互相獨立的原生相依，而它們的失敗方式不同。分清楚你撞到的是哪一個，就知道是整個安裝壞了、還是只少了一種語言：

| | 套件 | 是否必要 | 該平台沒有預建二進位檔時 |
|---|---|---|---|
| **圖譜資料庫** | [`ryugraph`](https://github.com/predictable-labs/ryugraph) | **是** | 透過 `cmake-js` 從原始碼編譯。編不出來就完全沒有可用的 `egr`。 |
| **語言文法** | `tree-sitter` ＋ 12 個文法套件 | 逐語言而定 | 透過 `node-gyp` 從原始碼編譯。編不出來**只影響該語言**——`egr` 照樣安裝、照樣索引其他語言。 |

截至 `engramgraph@0.9.1` 的預建二進位檔涵蓋狀況：

| 平台 | 圖譜資料庫 | 語言文法 | 你會得到什麼 |
|------|-----------|---------|-------------|
| Linux x64，glibc ≥ 2.38（Ubuntu 24.04+、Debian 13+）| ✅ 已預建 | ✅ 13 個全部已預建 | 全部功能，完全不需要編譯器 |
| macOS ARM64（Apple Silicon）| ✅ 已預建 | ⚠️ Dart 需編譯 | 有 C/C++ 工具鏈就是全部；沒有的話是**除 Dart 以外**的所有語言 |
| macOS x64（Intel）| ✅ 已預建 | ⚠️ Dart 需編譯 | 同上 |
| Windows x64 | ✅ 已預建 | ⚠️ Dart 需編譯 | 同上——但請看 [Windows](#windows啟用-dart-文法)，那裡有兩個讓這件事比聽起來難的陷阱 |
| Windows ARM64 | ❌ **無預建** | ⚠️ Dart 需編譯 | 連圖譜資料庫都需要工具鏈；未經測試 |
| Linux ARM64（任何 glibc）| ❌ **上游有問題** | ⚠️ Dart 需編譯 | 上游把 x86-64 的二進位檔用 arm64 檔名發布——[predictable-labs/ryugraph#48](https://github.com/predictable-labs/ryugraph/issues/48) |
| Linux x64，glibc < 2.38（Ubuntu 22.04 LTS、Debian 12）| ❌ **上游有問題** | ✅ 13 個全部已預建 | `ryugraph` 的二進位檔需要比這些仍常見的 LTS 發行版更新的 glibc |

**Linux x64 是唯一完全不需要編譯器就能安裝的平台。** 其他每個平台上，`npm install` 至少會編譯 Dart 文法（[`@vokturz/tree-sitter-dart`](https://www.npmjs.com/package/@vokturz/tree-sitter-dart) 只發布 `linux-x64` 的預建二進位檔）。該文法是**選用相依（optional dependency）**：編譯失敗時 npm 會繼續、安裝會成功，而 `egr` 會在你索引時告訴你 Dart 不可用。安裝期也會有一則前置提示先講清楚這件事，不必等編譯器的錯誤刷過去才知道。

> **為什麼偏偏是 Dart。** 本專案其他每個文法都出貨六種平台/架構的二進位檔。Dart 是例外，因為它是 npm 上唯一與本專案鎖定的 `tree-sitter` 核心 ABI 相容的 Dart 文法——另外兩個**確實**出貨完整預建檔的候選，載入時正常，接著在 `Parser.setLanguage` 裡拋錯。四個候選的比較紀錄在 `src/code-graph/grammars.d.ts`。這是一個已知不理想的取捨，之所以保留是因為其他選項更糟；若日後出現維護較好的套件，值得重新評估。


上表的 Linux ARM64 那一列會影響 **Apple Silicon Mac 上的 Docker Desktop**（預設用 `linux/arm64`）與
**AWS Graviton／其他 ARM64 Linux 主機**——若 `egr` 在這些環境上失敗，很可能就是
[#48](https://github.com/predictable-labs/ryugraph/issues/48)，不是你的環境設定有問題。
在受影響的 Docker 主機上強制 `--platform linux/amd64` 可以繞過（代價是在 ARM64 硬體上以模擬方式執行），直到上游修正為止。

另外請注意：npm ≥ 11 預設會把原生安裝腳本（含 `ryugraph` 的）擋在核准提示之後。若 `npm install`
印出 `npm warn allow-scripts`，請執行 `npm approve-scripts --all` 後重新安裝——否則原生二進位檔永遠不會被複製到位。

> **上表這些列是怎麼查證的。** `ryugraph` 的部分來自 2026-07-10 的直接調查；Windows x64 那一列來自 2026-08-04 在一台 Windows 11 上的實際安裝；文法涵蓋範圍來自實際讀取已發布套件所附的 `prebuilds/` 目錄，並由 `test/language-support.test.ts` 在每次測試執行時重新斷言。本表先前的版本引用 [`release-compat-check.yml`](.github/workflows/release-compat-check.yml) 作為自動化發布關卡——**那個引證是錯的**：該 workflow 與發布 job 賽跑，在套件上架 npm 之前就放棄，因此它的矩陣一次都沒有執行過，沒有任何一次發布真的通過該關卡驗證。修復該關卡另案追蹤；在它真的會跑之前，請把本表當成人工查核的結果，因為它就是。

#### Windows：啟用 Dart 文法

在 Windows 上安裝 C++ 工具鏈有兩個陷阱，而它們會產生**同一句**錯誤訊息 `gyp ERR! find VS - missing any VC++ toolset`：

1. **`node-gyp` 11.x 不認得 Visual Studio 2026（v18）**——而 11.x 正是 npm 11 內建的版本，所以這是常見情況。它的 Visual Studio 搜尋器把版本 15/16/17 硬編碼對應到 2017/2019/2022，其餘一律丟棄，因此會把一台裝了完整 VS 2026 MSVC 的機器回報成 `unknown version "undefined"`。在該版本上 `VCINSTALLDIR` 與 `msvs_version` 都繞不過去。有兩條出路：**把 C++ 工作負載裝進 Build Tools 2022**（不受 node-gyp 版本影響），或**升級 node-gyp**——12.x 認得 VS 2026（CI 實測：它會印 `checking VS2026 (18.8.x)` 並把 `2026` 列為有效的 `msvs_version`）。支援是在 11.x→12.x 的哪一版落地的尚未查證；用 `npx node-gyp --version` 確認你自己的版本。
2. **加入 `VCTools` 工作負載並不會裝到編譯器。** 在該工作負載底下，`Microsoft.VisualStudio.Component.VC.Tools.x86.x64` 是 *Recommended* 而非 *Required*——所以一台機器可以回報「有 Visual Studio C++ 核心功能」卻根本沒有編譯器。請明確勾選它（以及一個 Windows SDK）。

用 Visual Studio Installer：選 **Visual Studio Build Tools 2022** → 修改 → 勾選**使用 C++ 的桌面開發** → 確認右側的 **MSVC v143 … 建置工具**與 **Windows 11 SDK** 有被勾到。或在提升權限的 shell 執行（且不要在 installer 自己的目錄下執行）：

```powershell
& "C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe" modify `
  --installPath "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools" `
  --channelId VisualStudio.17.Release `
  --productId Microsoft.VisualStudio.Product.BuildTools `
  --add Microsoft.VisualStudio.Workload.VCTools `
  --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  --add Microsoft.VisualStudio.Component.Windows11SDK.26100 `
  --passive --norestart
```

**驗收要看 `node-gyp` 印什麼，不是看安裝程式的 exit code。** 安裝程式回 0 不代表編譯器裝上了——那正是陷阱 2 會造成的狀態。重跑一次安裝，找這一行：

```
gyp verb find VS - found VC++ toolset: v143
```

它出現就是通過，它缺席就是失敗，無論成因是哪一個陷阱。

**為什麼 macOS Intel 沒有納入自動化發布關卡。**（這一段講的是該關卡的*設計*；至於該關卡根本沒在執行，見上方的查證說明。）排除 Intel Mac 不是疏漏，是刻意的決定，有兩個獨立事實指向同一個方向：

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
| `gyp ERR! find VS - missing any VC++ toolset`（Windows）| 沒有可用的 MSVC 編譯器。兩種不同成因會產生這一模一樣的行——見 [Windows：啟用 Dart 文法](#windows啟用-dart-文法)。注意這**不是致命錯誤**：它只讓你失去 Dart |
| `gyp ERR! find VS unknown version "undefined" found at ...\18\BuildTools` | **node-gyp 11.x** 不認得 Visual Studio 2026。請改把 C++ 工作負載裝進 **Build Tools 2022**，或把 node-gyp 升到 12.x |
| Windows/macOS 上一整面 `node-gyp` 輸出、最後是 `npm error code 1` | Dart 文法編譯失敗。沒有 C/C++ 工具鏈時這是預期結果，而且可以承受——其他語言全部照常運作 |
| 索引時出現 `Dart support is not enabled in this installation` | 同一件事的另一端。`egr` 是正常的，只是這台機器沒有建置 Dart 文法 |
| `IO exception: Failed to download extension: algo` | `god-nodes`、`communities`、`related` 需要 ryugraph 的 ALGO 擴充，`INSTALL ALGO` 會在首次使用時從 `extension.ryugraph.io` 下載。**這是 egr 唯一會連外的部分**——其餘指令全部可離線運作。該錯誤現在會印出離線建置步驟；另見 `docs/CLI.md` |

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

## EngramGraph 不儲存什麼

圖是**推導出來的產物**。`rm -rf .engram/graph.db && egr index` 必須能無損重建
它——這就是那條界線。任何「唯一的副本只存在於圖裡」的東西，都不屬於這裡。

因此 EngramGraph 不儲存個人經驗、環境或機器狀態，也不儲存關於人的事實。這裡
沒有 free-form 註記欄位，將來也不會有。那些東西是真實且值得保存的——它們只是
屬於你手寫的筆記，而 EngramGraph 的定位是與那些筆記**並存**，不是取代它們。

它儲存的，是解析器能從你的 repository 重新推導出來的東西：程式碼結構，以及你
的 repository 裡已經存在的 spec／decision 文件。

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
