---
source: README.md
source_version: 0.7.0
translation_version: 0.7.0
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

### 平台支持矩阵

EngramGraph 依赖 [`ryugraph`](https://github.com/predictable-labs/ryugraph) 作为嵌入式图数据库，该软件包按平台附带预编译的原生二进制文件。截至 `ryugraph@25.9.1`，已验证的支持情况为：

| 平台 | 状态 | 备注 |
|------|------|------|
| macOS ARM64（Apple Silicon）| ✅ 可用 | 已通过 [Cross-Platform Compatibility Check](.github/workflows/release-compat-check.yml)（`macos-latest`）验证 |
| macOS x64（Intel）| ⚠️ 未经 CI 验证（已知限制，见下文）| 目前无已知问题——`ryujs-darwin-x64.node` 是独立、正常构建的二进制文件（不同于 Linux ARM64 的情况）——但没有自动化发布关卡验证 |
| Linux x64，glibc ≥ 2.38（Ubuntu 24.04+、Debian 13+）| ✅ 可用 | 已通过 CI glibc 兼容性矩阵验证（`node:24-trixie`，glibc 2.41）|
| Linux x64，glibc < 2.38（Ubuntu 22.04 LTS、Debian 12）| ❌ 无法使用 | 上游 `ryugraph` 二进制文件所需的 glibc 版本比这些仍常见的 LTS 发行版自带的更新。已通过 CI glibc 兼容性矩阵验证（`node:24`，glibc 2.36）|
| Linux ARM64（任何 glibc）| ❌ 无法使用 | 上游把 x86-64 的二进制文件用 arm64 的文件名发布——追踪于 [predictable-labs/ryugraph#48](https://github.com/predictable-labs/ryugraph/issues/48)。已通过 CI（`ubuntu-24.04-arm`）验证 |
| Windows x64 | ✅ 可用 | 已通过 CI（`windows-latest`）验证 |

这会影响 **Apple Silicon Mac 上的 Docker Desktop**（默认使用 `linux/arm64`）与
**AWS Graviton／其他 ARM64 Linux 主机**——如果 `egr` 在这些环境上失败，很可能就是
[#48](https://github.com/predictable-labs/ryugraph/issues/48)，不是你的环境配置有问题。
在受影响的 Docker 主机上强制 `--platform linux/amd64` 可以绕过（代价是在 ARM64 硬件上以模拟方式运行），直到上游修复为止。

另外请注意：npm ≥ 11 默认会把原生安装脚本（包括 `ryugraph` 的）挡在批准提示之后。如果 `npm install`
打印出 `npm warn allow-scripts`，请执行 `npm approve-scripts --all` 后重新安装——否则原生二进制文件永远不会被复制到位。

**为什么 macOS Intel 没有纳入自动化发布关卡。** 这不是疏漏，是刻意的决定，有两个独立事实指向同一个方向：

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
