# Contributing to EngramGraph

> **Language:** English · [繁體中文](./locales/zh-TW/CONTRIBUTING.md) · [简体中文](./locales/zh-CN/CONTRIBUTING.md)

Thanks for your interest in EngramGraph. It is MIT-licensed and general-purpose —
keep the **core generic**: project-specific conventions (custom id schemes,
multi-tenant isolation, bespoke signal sources) belong in adapters, not the core.

## Dev setup

Requires **Node.js ≥ 22** (native addons: kuzu + tree-sitter compile on install).

```bash
git clone https://github.com/AsiaOstrich/EngramGraph.git
cd EngramGraph
npm install --legacy-peer-deps
```

Then install the README locale-sync pre-commit hook (one-time, per clone — `.git/hooks`
isn't tracked by git, so this doesn't happen automatically):

```bash
ln -sf ../../scripts/hooks/pre-commit .git/hooks/pre-commit
```

It blocks a commit that adds/removes a `README.md` section without touching the
corresponding section in `locales/zh-TW/README.md` / `locales/zh-CN/README.md` — the two
locale READMEs sat stale for 7 minor versions before anyone noticed, because nothing ever
checked them. Bypass once with `git commit --no-verify` if a translation is intentionally
coming in a follow-up commit.

## The loop

```bash
npm run build       # tsup → dist/ (ESM + CJS, .d.ts, sourcemaps); also runs as `prepare`
npm run typecheck   # tsc --noEmit, 0 errors
npm test            # vitest run
npm run health      # scripts/health-check.mjs — 6-module smoke
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
src/cli/              egr CLI (entry + run + walk)
clients/node-sdk/     EmbeddedClient
test/                 vitest suites (one per module)
scripts/              health check + dev scripts (not published to npm)
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
