# Contributing to CodeSage

> **Language:** English · [繁體中文](./locales/zh-TW/CONTRIBUTING.md) · [简体中文](./locales/zh-CN/CONTRIBUTING.md)

Thanks for your interest in CodeSage. It is MIT-licensed and general-purpose —
keep the **core free of AsiaOstrich-specific concepts** (XSPEC/DEC/org/VibeOps
belong in reference adapters, not the core).

## Dev setup

Requires **Node.js ≥ 22** (native addons: kuzu + tree-sitter compile on install).

```bash
git clone https://github.com/AsiaOstrich/CodeSage.git
cd CodeSage
npm install --legacy-peer-deps
```

## The loop

```bash
npm run build       # tsup → dist/ (ESM + CJS, .d.ts, sourcemaps); also runs as `prepare`
npm run typecheck   # tsc --noEmit, 0 errors
npm test            # vitest run
npm run health      # poc/health-check.mjs — 6-module smoke
```

Try the CLI from source without building:

```bash
npx tsx src/cli/index.ts --help
npx tsx src/cli/index.ts index ./src
```

## kuzu + tree-sitter teardown caveat

Both kuzu and tree-sitter are native addons. When both are loaded in one
process, `GraphConnection.close()` can deadlock and tearing down mid-process can
segfault. Therefore:

- Use **one long-lived connection** per process; do not open/close per call.
- In scripts and the CLI, **do not `await conn.close()`** at the end — let
  `process.exit(0)` reclaim it.
- In tests, open one connection in `beforeAll` and let `afterAll` clean up the
  temp dir without awaiting a close (see `test/cli.test.ts`).
- vitest runs in the forked-worker pool (threads can segfault with these addons).

## Project layout

```
src/graph-db/         Kuzu abstraction (connection, schema, writer, open helper)
src/code-graph/       tree-sitter → Function/Class/Module + CALLS
src/knowledge-graph/  front-matter markdown → Spec/Decision + IMPACTS/SUPERSEDES
src/sage/             confidence: writer / reader / evolution-loop
src/adapters/         pluggable interfaces + generic defaults
src/api/              Hono REST server + routes
src/mcp/              MCP server + stdio bin
src/cli/              codesage CLI (entry + run + walk)
clients/node-sdk/     EmbeddedClient
test/                 vitest suites (one per module)
poc/                  experiments + health check (not published to npm)
```

## Conventions

- **Tests first / alongside** — every module has a `test/*.test.ts`. Keep them
  green; add coverage for new behaviour.
- **No new heavy deps** in the core — the CLI uses `node:util parseArgs`, not a
  parser library; prefer the platform.
- **Commit messages** are bilingual (English + 繁體中文):
  `<type>(<scope>): <English>. <中文>.` with a blank line between English and
  Chinese paragraphs in the body.
- Keep public API changes reflected in [docs/API.md](./docs/API.md) and
  [CHANGELOG.md](./CHANGELOG.md).

## Pull requests

Run `build` + `typecheck` + `test` + `health` before opening a PR, and describe
the change against the affected module(s).
