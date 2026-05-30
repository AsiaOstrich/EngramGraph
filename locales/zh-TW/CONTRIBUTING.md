---
source: CONTRIBUTING.md
source_version: 0.1.0
translation_version: 0.1.0
last_synced: 2026-05-30
status: complete
---

# 參與貢獻 CodeSage

> **語言：** [English](../../CONTRIBUTING.md) · 繁體中文 · [简体中文](../zh-CN/CONTRIBUTING.md)

感謝你對 CodeSage 感興趣。它採 MIT 授權且為通用引擎——請**讓核心保持不含 AsiaOstrich
專屬概念**（XSPEC/DEC/org/VibeOps 屬於參考 adapter，不屬於核心）。

## 開發環境設定

需要 **Node.js ≥ 22**（原生 addon：kuzu + tree-sitter 會在安裝時編譯）。

```bash
git clone https://github.com/AsiaOstrich/CodeSage.git
cd CodeSage
npm install --legacy-peer-deps
```

## 開發迴圈

```bash
npm run build       # tsup → dist/（ESM + CJS、.d.ts、sourcemap）；也會作為 `prepare` 執行
npm run typecheck   # tsc --noEmit，0 錯誤
npm test            # vitest run
npm run health      # poc/health-check.mjs — 6 模組煙霧測試
```

不 build 直接從原始碼試 CLI：

```bash
npx tsx src/cli/index.ts --help
npx tsx src/cli/index.ts index ./src
```

## kuzu + tree-sitter 拆除注意事項

kuzu 與 tree-sitter 都是原生 addon。兩者在同一行程載入時，`GraphConnection.close()`
可能死結，行程中途拆除可能 segfault。因此：

- 每個行程使用**一條長生命連線**；不要每次呼叫就開/關。
- 在腳本與 CLI 中，結尾**不要 `await conn.close()`**——讓 `process.exit(0)` 回收它。
- 測試中於 `beforeAll` 開一條連線，並讓 `afterAll` 清掉暫存目錄而不 await close
  （見 `test/cli.test.ts`）。
- vitest 以 forked-worker pool 執行（這些 addon 在 threads 下可能 segfault）。

## 專案結構

```
src/graph-db/         Kuzu 抽象（connection、schema、writer、open helper）
src/code-graph/       tree-sitter → Function/Class/Module + CALLS
src/knowledge-graph/  front-matter markdown → Spec/Decision + IMPACTS/SUPERSEDES
src/sage/             信心度：writer / reader / evolution-loop
src/adapters/         可插拔介面 + 通用預設
src/api/              Hono REST server + 路由
src/mcp/              MCP server + stdio bin
src/cli/              codesage CLI（entry + run + walk）
clients/node-sdk/     EmbeddedClient
test/                 vitest 測試（每模組一套）
poc/                  實驗 + 健康檢查（不發布到 npm）
```

## 慣例

- **測試先行 / 並行** — 每個模組都有 `test/*.test.ts`。保持綠燈；新行為要補測試。
- 核心**不引入新的重量級相依**——CLI 用 `node:util parseArgs` 而非解析函式庫；優先用平台內建。
- **Commit 訊息**雙語（英文 + 繁體中文）：`<type>(<scope>): <English>. <中文>.`，
  body 中英文段落之間以空行分隔。
- 公開 API 變更要同步反映在 [docs/API.md](./docs/API.md) 與 [CHANGELOG.md](../../CHANGELOG.md)。

## Pull request

開 PR 前請跑 `build` + `typecheck` + `test` + `health`，並針對受影響的模組描述變更。
