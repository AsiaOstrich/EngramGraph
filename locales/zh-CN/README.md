---
source: README.md
source_version: 0.8.0
translation_version: 0.8.0
last_synced: 2026-07-16
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

### 接上你的 coding assistant（MCP）

`egr` 同时附带 MCP server，让助手可以查询图谱——也可以更新它——不必你手动运行任何东西。**它不会自动注册**，而且是刻意的：一个软件包若在 `npm install` 期间把自己写进你助手的工具配置，等于未经询问就自行获得了工具访问权。

Claude Code 只需一条命令：

```bash
claude mcp add egr -- npx egr-mcp
```

确认它真的生效——安装本身不是证据，这个才是：

```bash
claude mcp list   # egr … ✓ Connected
```

若希望整个团队都能拿到，改用 `--scope project`：它会写出一份可以进版本控制的 `.mcp.json`，每个人首次使用时被提示批准一次。**配置内容要保持可移植**——把某台机器的 Node 绝对路径写死，正是一份进了版本控制的 `.mcp.json` 在别人电脑上静静失效的常见原因。`ENGRAM_DB` 默认是 `./.engram/graph.db`，通常可以整个省略。

Codex／Cursor／Windsurf、8 个工具的完整清单与示例流程：**[docs/MCP.md](./docs/MCP.md)**。

> **从助手端建索引有一个值得知道的限制。** `index_code` 工具收的是文件**内容**而非目录——它不会自己遍历文件系统。因此它适合更新助手刚刚改过的那几个文件，不适合索引整个 repo。整库索引请用 `egr index ./src`。

### 原生依赖与平台支持

EngramGraph 有**两个**互相独立的原生依赖，而它们的失败方式不同。分清楚你撞到的是哪一个，就知道是整个安装坏了、还是只少了一种语言：

| | 软件包 | 是否必需 | 该平台没有预构建二进制文件时 |
|---|---|---|---|
| **图数据库** | [`ryugraph`](https://github.com/predictable-labs/ryugraph) | **是** | 通过 `cmake-js` 从源码编译。编不出来就完全没有可用的 `egr`。 |
| **语言语法** | `tree-sitter` ＋ 12 个语法软件包 | 逐语言而定 | 通过 `node-gyp` 从源码编译。编不出来**只影响该语言**——`egr` 照样安装、照样索引其他语言。 |

截至 `engramgraph@0.9.0` 的预构建二进制文件覆盖情况：

| 平台 | 图数据库 | 语言语法 | 你会得到什么 |
|------|---------|---------|-------------|
| Linux x64，glibc ≥ 2.38（Ubuntu 24.04+、Debian 13+）| ✅ 已预构建 | ✅ 13 个全部已预构建 | 全部功能，完全不需要编译器 |
| macOS ARM64（Apple Silicon）| ✅ 已预构建 | ⚠️ Dart 需编译 | 有 C/C++ 工具链就是全部；没有的话是**除 Dart 以外**的所有语言 |
| macOS x64（Intel）| ✅ 已预构建 | ⚠️ Dart 需编译 | 同上 |
| Windows x64 | ✅ 已预构建 | ⚠️ Dart 需编译 | 同上——但请看 [Windows](#windows启用-dart-语法)，那里有两个让这件事比听起来难的陷阱 |
| Windows ARM64 | ❌ **无预构建** | ⚠️ Dart 需编译 | 连图数据库都需要工具链；未经测试 |
| Linux ARM64（任何 glibc）| ❌ **上游有问题** | ⚠️ Dart 需编译 | 上游把 x86-64 的二进制文件用 arm64 文件名发布——[predictable-labs/ryugraph#48](https://github.com/predictable-labs/ryugraph/issues/48) |
| Linux x64，glibc < 2.38（Ubuntu 22.04 LTS、Debian 12）| ❌ **上游有问题** | ✅ 13 个全部已预构建 | `ryugraph` 的二进制文件所需的 glibc 比这些仍常见的 LTS 发行版更新 |

**Linux x64 是唯一完全不需要编译器就能安装的平台。** 其他每个平台上，`npm install` 至少会编译 Dart 语法（[`@vokturz/tree-sitter-dart`](https://www.npmjs.com/package/@vokturz/tree-sitter-dart) 只发布 `linux-x64` 的预构建二进制文件）。该语法是**可选依赖（optional dependency）**：编译失败时 npm 会继续、安装会成功，而 `egr` 会在你索引时告诉你 Dart 不可用。安装期也会有一条前置提示先讲清楚这件事，不必等编译器的错误刷过去才知道。

> **为什么偏偏是 Dart。** 本项目其他每个语法都提供六种平台/架构的二进制文件。Dart 是例外，因为它是 npm 上唯一与本项目锁定的 `tree-sitter` 核心 ABI 兼容的 Dart 语法——另外两个**确实**提供完整预构建文件的候选，加载时正常，接着在 `Parser.setLanguage` 里抛错。四个候选的比较记录在 `src/code-graph/grammars.d.ts`。这是一个已知不理想的取舍，之所以保留是因为其他选项更糟；若日后出现维护更好的软件包，值得重新评估。


上表的 Linux ARM64 那一行会影响 **Apple Silicon Mac 上的 Docker Desktop**（默认使用 `linux/arm64`）与
**AWS Graviton／其他 ARM64 Linux 主机**——如果 `egr` 在这些环境上失败，很可能就是
[#48](https://github.com/predictable-labs/ryugraph/issues/48)，不是你的环境配置有问题。
在受影响的 Docker 主机上强制 `--platform linux/amd64` 可以绕过（代价是在 ARM64 硬件上以模拟方式运行），直到上游修复为止。

另外请注意：npm ≥ 11 默认会把原生安装脚本（包括 `ryugraph` 的）挡在批准提示之后。如果 `npm install`
打印出 `npm warn allow-scripts`，请执行 `npm approve-scripts --all` 后重新安装——否则原生二进制文件永远不会被复制到位。

> **上表这些行是怎么查证的。** `ryugraph` 的部分来自 2026-07-10 的直接调查；Windows x64 那一行来自 2026-08-04 在一台 Windows 11 上的实际安装；语法覆盖范围来自实际读取已发布软件包所带的 `prebuilds/` 目录，并由 `test/language-support.test.ts` 在每次测试运行时重新断言。本表先前的版本引用 [`release-compat-check.yml`](.github/workflows/release-compat-check.yml) 作为自动化发布关卡——**那个引证是错的**：该 workflow 与发布 job 赛跑，在软件包上架 npm 之前就放弃，因此它的矩阵一次都没有执行过，没有任何一次发布真的通过该关卡验证。修复该关卡另案追踪；在它真的会运行之前，请把本表当成人工核查的结果，因为它就是。

#### Windows：启用 Dart 语法

在 Windows 上安装 C++ 工具链有两个陷阱，而它们会产生**同一句**错误信息 `gyp ERR! find VS - missing any VC++ toolset`：

1. **`node-gyp` 11.x 不认识 Visual Studio 2026（v18）**——而 11.x 正是 npm 11 内置的版本，所以这是常见情况。它的 Visual Studio 查找器把版本 15/16/17 硬编码对应到 2017/2019/2022，其余一律丢弃，因此会把一台装了完整 VS 2026 MSVC 的机器报告成 `unknown version "undefined"`。在该版本上 `VCINSTALLDIR` 与 `msvs_version` 都绕不过去。有两条出路：**把 C++ 工作负载装进 Build Tools 2022**（不受 node-gyp 版本影响），或**升级 node-gyp**——12.x 认识 VS 2026（CI 实测：它会打印 `checking VS2026 (18.8.x)` 并把 `2026` 列为有效的 `msvs_version`）。支持是在 11.x→12.x 的哪一版落地的尚未查证；用 `npx node-gyp --version` 确认你自己的版本。
2. **加入 `VCTools` 工作负载并不会装上编译器。** 在该工作负载底下，`Microsoft.VisualStudio.Component.VC.Tools.x86.x64` 是 *Recommended* 而非 *Required*——所以一台机器可以报告「有 Visual Studio C++ 核心功能」却根本没有编译器。请明确勾选它（以及一个 Windows SDK）。

用 Visual Studio Installer：选 **Visual Studio Build Tools 2022** → 修改 → 勾选**使用 C++ 的桌面开发** → 确认右侧的 **MSVC v143 … 生成工具**与 **Windows 11 SDK** 有被勾上。或在提升权限的 shell 执行（且不要在 installer 自己的目录下执行）：

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

**验收要看 `node-gyp` 打印什么，不是看安装程序的 exit code。** 安装程序返回 0 不代表编译器装上了——那正是陷阱 2 会造成的状态。重跑一次安装，找这一行：

```
gyp verb find VS - found VC++ toolset: v143
```

它出现就是通过，它缺席就是失败，无论成因是哪一个陷阱。

**为什么 macOS Intel 没有纳入自动化发布关卡。**（这一段讲的是该关卡的*设计*；至于该关卡根本没在运行，见上方的查证说明。）排除 Intel Mac 不是疏漏，是刻意的决定，有两个独立事实指向同一个方向：

- **GitHub 自家的 Intel Mac（`macos-13`）托管 runner 目前有严重的排队容量限制。** 2026-07-10 的一次实测运行在
  `queued` 状态卡了约 50 分钟都没开始运行。GitHub Actions 的 `timeout-minutes` 无法限制这种情况——它只在
  job 真正开始执行后才开始计时，排队期间不算——所以没有可靠的方式能限制一次发布卡在等待这个 runner 上的时长。
- **Apple 自家的支持生命周期正在收尾。** macOS 26「Tahoe」是最后一个支持 Intel Mac 的主要版本；
  macOS 27「Golden Gate」（预计 2026 年 9 月）会完全移除 Intel 支持，macOS 26 大约只到 2029 年前后还有
  纯安全更新。Intel Mac 在 Apple 与 GitHub 两边都是正在淡出的平台。

既然如此，让每次发布都卡在一个可能永远排不到、而且是正在淡出平台的 runner 上，并不合理。改为让
[`release-compat-check.yml`](.github/workflows/release-compat-check.yml) 里的 `macos-x64-intel-manual`
以**尽力而为、非阻断**的方式运行 Intel Mac 验证：可通过 `workflow_dispatch` 手动触发、`continue-on-error: true`
所以永远不会让发布失败，也不挂在 `release: published` 触发条件上，确保真正的发布不会被它卡住。如果你特别
需要确认 Intel Mac 支持情况，可手动触发该 job 查看结果——但发布流程本身不依赖它。

### 疑难排解：容易误导人的原生二进制文件错误

Linux 上的原生二进制文件加载失败，会通过 Node 的 `dlopen` 呈现，其错误文本不一定能反映真正的原因：

| 你看到的错误 | 通常代表的含义 |
|------|------|
| `ryujs.node: cannot open shared object file: No such file or directory`（用 `ls` 检查文件*确实存在*）| CPU 架构不对——该路径上的二进制文件是给另一个平台/架构用的 |
| `.../libc.so.6: version 'GLIBC_2.38' not found` | 你的发行版 glibc 版本比预构建二进制文件要求的旧（见上方矩阵）|
| `npm warn allow-scripts ... not yet covered by allowScripts` | npm ≥ 11 挡下了复制原生二进制文件的安装脚本——执行 `npm approve-scripts --all` 后重新安装/重建 |
| `gyp ERR! find VS - missing any VC++ toolset`（Windows）| 没有可用的 MSVC 编译器。两种不同成因会产生这一模一样的行——见 [Windows：启用 Dart 语法](#windows启用-dart-语法)。注意这**不是致命错误**：它只让你失去 Dart |
| `gyp ERR! find VS unknown version "undefined" found at ...\18\BuildTools` | **node-gyp 11.x** 不认识 Visual Studio 2026。请改把 C++ 工作负载装进 **Build Tools 2022**，或把 node-gyp 升到 12.x |
| Windows/macOS 上一整屏 `node-gyp` 输出、最后是 `npm error code 1` | Dart 语法编译失败。没有 C/C++ 工具链时这是预期结果，而且可以承受——其他语言全部照常运行 |
| 索引时出现 `Dart support is not enabled in this installation` | 同一件事的另一端。`egr` 是正常的，只是这台机器没有构建 Dart 语法 |
| `IO exception: Failed to download extension: algo` | `god-nodes`、`communities`、`related` 需要 ryugraph 的 ALGO 扩展，`INSTALL ALGO` 会在首次使用时从 `extension.ryugraph.io` 下载。**这是 egr 唯一会联网的部分**——其余命令全部可离线运行。该错误现在会打印离线构建步骤；另见 `docs/CLI.md` |

如果你遇到的问题不在上表范围内，请先查看
[predictable-labs/ryugraph 的 issues](https://github.com/predictable-labs/ryugraph/issues)，
再判断是不是 EngramGraph 本身的问题——多数原生加载失败都源自 `ryugraph` 这个依赖包，而非本软件包。

### 依赖包安全警告（`npm audit`、已弃用软件包）

不论全局安装、`npx`、还是当作项目依赖安装，目前运行 `npm install` 都会打印出这类警告：

```
npm warn deprecated npmlog@6.0.2: This package is no longer supported.
npm warn deprecated are-we-there-yet@3.0.1: This package is no longer supported.
npm warn deprecated gauge@4.0.4: This package is no longer supported.
npm warn deprecated tar@6.2.1: ...widely publicized security vulnerabilities...
4 high severity vulnerabilities
```

这四项全部源自同一条依赖链：`ryugraph`（本软件包的嵌入式图数据库引擎）锁定了
`cmake-js@^7.3.0`，而它依赖 `tar@^6.2.0`（多个高危路径穿越 CVE，已在 `tar@7.5.11`+
中修复）以及现已弃用的 `npmlog`/`gauge`/`are-we-there-yet` 组合。`cmake-js@8.0.0` 已经
去掉了 `npmlog`、把 `tar` 升级到 `^7.5.6`——修复方案在上游已经存在，只是 `ryugraph`
还没有采用。追踪于 [predictable-labs/ryugraph#49](https://github.com/predictable-labs/ryugraph/issues/49)。

**实际风险范围比警告数量看起来要窄。** `ryugraph` 自己的 `install.js` 只有在你的平台
没有预构建原生二进制文件时，才会调用 `cmake-js`（进而牵动 `tar`）——见上方平台支持矩阵。
在矩阵中标记为 `✅ 可用` 的每个平台上，预构建二进制文件会被直接复制使用，`cmake-js`/`tar`
虽然会被拉取进 `node_modules`，但完全不会被执行。这个已声明的漏洞是真实存在的（无论是否
被执行，`npm audit`／SBOM 工具照样会报告），但实际可被利用的窗口，实质上仅限于
走 build-from-source 路径的情况（不受支持的平台，或显式设置了 `NPM_CONFIG_BUILD_FROM_SOURCE`）。

**如果你是把 `engramgraph` 当作自己项目里的普通依赖包安装**（而非全局安装），你今天
就能自行解决——把同样的 override 加进**你自己的** `package.json`：

```json
"overrides": {
  "cmake-js": "^8.0.0"
}
```

（以上是 npm 语法；pnpm/Yarn 有对应的 `pnpm.overrides` / `resolutions` 字段。）这之所以
有效，是因为 npm 的 `overrides` 字段只在「运行 `npm install` 的那个项目本身」才会生效——
不会从依赖包自己的 `package.json` 传递到你的项目，这正是为什么 `engramgraph` 自己
package.json 里（此前修复时加的）那个 `overrides` 对你没有帮助：它只是让本仓库
源码 checkout 里的 `npm audit` 变干净，对安装了已发布软件包的人完全没用。如果是全局安装或
`npx engramgraph`，没有项目根目录可以挂载 override，这条路目前还没有解法——需要等上面链接的
上游 issue 被处理。

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

EngramGraph 内置一个 MCP server（stdio），暴露 8 个工具——`index_code`、`index_docs`、
`call_chain`、`impact_analysis`、`ingest_feedback`、`implementers`、`implemented_specs`、
`related`——让任何支持 MCP 的助手都能把它当成代码 + 知识图谱使用。无 LLM、确定性、**免 Docker**。

```bash
# Claude Code，使用已安装的包：
claude mcp add egr -- npx egr-mcp
```

完整配置（Claude Code / Codex / Cursor / Windsurf）、全部 8 个工具与示例流程：
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
8 个关系表——`CALLS`、`IMPORTS`、`DEFINES`、`IMPLEMENTS`、`IMPACTS`、`SUPERSEDES`、
`RELATES`、`REFERENCES`。完整 DDL 与驱动知识导入的 front-matter schema 见 **[docs/API.md](./docs/API.md)**。

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
