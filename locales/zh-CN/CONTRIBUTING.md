---
source: CONTRIBUTING.md
source_version: 0.1.0
translation_version: 0.1.0
last_synced: 2026-05-30
status: complete
---

# 参与贡献 CodeSage

> **语言：** [English](../../CONTRIBUTING.md) · [繁體中文](../zh-TW/CONTRIBUTING.md) · 简体中文

感谢你对 CodeSage 感兴趣。它采用 MIT 许可且为通用引擎——请**让核心保持不含 AsiaOstrich
专属概念**（XSPEC/DEC/org/VibeOps 属于参考 adapter，不属于核心）。

## 开发环境配置

需要 **Node.js ≥ 22**（原生 addon：kuzu + tree-sitter 会在安装时编译）。

```bash
git clone https://github.com/AsiaOstrich/CodeSage.git
cd CodeSage
npm install --legacy-peer-deps
```

## 开发循环

```bash
npm run build       # tsup → dist/（ESM + CJS、.d.ts、sourcemap）；也会作为 `prepare` 运行
npm run typecheck   # tsc --noEmit，0 错误
npm test            # vitest run
npm run health      # poc/health-check.mjs — 6 模块冒烟测试
```

不 build 直接从源代码试 CLI：

```bash
npx tsx src/cli/index.ts --help
npx tsx src/cli/index.ts index ./src
```

## kuzu + tree-sitter 销毁注意事项

kuzu 与 tree-sitter 都是原生 addon。两者在同一进程加载时，`GraphConnection.close()`
可能死锁，进程中途销毁可能 segfault。因此：

- 每个进程使用**一条长生命周期连接**；不要每次调用就开/关。
- 在脚本与 CLI 中，结尾**不要 `await conn.close()`**——让 `process.exit(0)` 回收它。
- 测试中于 `beforeAll` 开一条连接，并让 `afterAll` 清掉临时目录而不 await close
  （见 `test/cli.test.ts`）。
- vitest 以 forked-worker pool 运行（这些 addon 在 threads 下可能 segfault）。

## 项目结构

```
src/graph-db/         Kuzu 抽象（connection、schema、writer、open helper）
src/code-graph/       tree-sitter → Function/Class/Module + CALLS
src/knowledge-graph/  front-matter markdown → Spec/Decision + IMPACTS/SUPERSEDES
src/sage/             置信度：writer / reader / evolution-loop
src/adapters/         可插拔接口 + 通用默认
src/api/              Hono REST server + 路由
src/mcp/              MCP server + stdio bin
src/cli/              codesage CLI（entry + run + walk）
clients/node-sdk/     EmbeddedClient
test/                 vitest 测试（每模块一套）
poc/                  实验 + 健康检查（不发布到 npm）
```

## 约定

- **测试先行 / 并行** — 每个模块都有 `test/*.test.ts`。保持绿灯；新行为要补测试。
- 核心**不引入新的重量级依赖**——CLI 用 `node:util parseArgs` 而非解析库；优先用平台内建。
- **Commit 消息**双语（英文 + 繁体中文）：`<type>(<scope>): <English>. <中文>.`，
  body 中英文段落之间以空行分隔。
- 公开 API 变更要同步反映在 [docs/API.md](./docs/API.md) 与 [CHANGELOG.md](../../CHANGELOG.md)。

## Pull request

开 PR 前请跑 `build` + `typecheck` + `test` + `health`，并针对受影响的模块描述变更。
