# CodeSage

> **Language:** English · [繁體中文](./locales/zh-TW/README.md) · [简体中文](./locales/zh-CN/README.md)

[![npm](https://img.shields.io/npm/v/@asiaostrich/codesage)](https://www.npmjs.com/package/@asiaostrich/codesage)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)

> Open-source **code + knowledge graph memory engine**, fusing
> [SAGE](https://arxiv.org/abs/2605.12061) self-evolving graph memory with
> CodeGraph structural code understanding.

**License:** MIT · **Runtime:** Node.js ≥ 22 · **Graph DB:** [Kuzu](https://kuzudb.com/) (embedded, Cypher) · **No LLM required** (deterministic)

CodeSage is a general-purpose engine. **AsiaOstrich (VibeOps / UDS / XSPEC / DEC)
is only a reference consumer** — none of those concepts are baked into the core.
The defaults ("single repo + generic markdown + git signals") work out of the
box for any project; AsiaOstrich-specific behaviour is supplied through
pluggable adapters.

## Why a graph?

Vector search ("find me similar memories") and graph traversal ("find me
structurally related nodes") are complementary. CodeSage adds the graph half:

> "I want to change `execute()` → the engine walks: callers → related specs →
> the decisions behind them."

## Install

```bash
npm install @asiaostrich/codesage
```

Or run the CLI without installing:

```bash
npx @asiaostrich/codesage index ./src
```

## Quickstart

```bash
# 1. Index a repo into the graph (code + optional docs)
codesage index ./src --docs

# 2. "What breaks if I change this function?"
codesage callers myFunction --depth 2

# 3. "Which decisions sit behind this spec?"
codesage impact XSPEC-237
```

The graph DB lives at `CODESAGE_DB` (default `./.codesage/graph.db`).
Full command reference: **[docs/CLI.md](./docs/CLI.md)**.

### Embedded usage (in-process, zero HTTP)

```ts
import { EmbeddedClient } from "@asiaostrich/codesage";

const client = new EmbeddedClient();   // SingleRepoIsolation by default
await client.init();                   // opens graph.db + ensures schema
const rows = await client.query("MATCH (f:Function) RETURN f.name AS name");
await client.close();
```

### REST usage

```ts
import { createServer, GraphConnection } from "@asiaostrich/codesage";

const conn = GraphConnection.open("./.codesage/graph.db");
const app = createServer({ connection: conn });   // Hono app; routes under /graph/*
// GET /health → { status: "ok" }
```

Or just `codesage serve --port 3000`. API reference: **[docs/API.md](./docs/API.md)**.

## Three modes

| Mode | Entry | Use case |
|------|-------|----------|
| **Embedded** | `EmbeddedClient` | Same-process, zero HTTP overhead (e.g. VibeOps integration) |
| **REST** | `createServer()` (Hono) / `codesage serve` | Standalone graph service; routes under `/graph/*` |
| **MCP** | `codesage-mcp` (stdio) / `codesage mcp` | Plug-and-play for coding assistants (Claude Code, Codex, Cursor, ...) |

## MCP — use CodeSage from a coding assistant

CodeSage ships an MCP server (stdio) exposing 5 tools — `index_code`,
`index_docs`, `call_chain`, `impact_analysis`, `ingest_feedback` — so any
MCP-capable assistant can use it as a code + knowledge graph. Zero LLM,
deterministic, **no Docker**.

```bash
# Claude Code, from an installed package:
claude mcp add codesage -- npx codesage-mcp
```

Full setup (Claude Code / Codex / Cursor / Windsurf), the 5 tools, and an
example flow: **[docs/MCP.md](./docs/MCP.md)**.

## Core vs Adapter boundary

| Layer | Contents | External usability |
|-------|----------|--------------------|
| **Generic Core** | CodeGraph (tree-sitter → graph), SAGE evolution, Kuzu abstraction, REST/MCP/Embedded modes, node-sdk | Zero AsiaOstrich dependency |
| **Pluggable Adapters (interfaces)** | (1) knowledge source (2) isolation model (3) SAGE signal source | Core ships interface + a generic default |
| **AsiaOstrich Reference Adapter** | XSPEC/DEC/ADR parser, org/project isolation, VibeOps test signals | Reference instances (not in core) |

### The three adapters

1. **Knowledge source** — `KnowledgeSource → { nodes, edges }`.
   Default: `MarkdownKnowledgeSource` parses any front-matter markdown
   (`id` / `title` / `status` + `[[ref]]` links) into generic `Doc` nodes.
2. **Isolation model** — `IsolationModel.dbPath(ctx) → string`.
   Default: `SingleRepoIsolation` (one `graph.db`, no org concept).
   Opt-in: `OrgProjectIsolation` (`org-{orgId}/project-{projectId}/graph.db`).
3. **SAGE signal source** — `SignalSource → FeedbackEvent[]`.
   Defaults: `GitHistorySignalSource`, `TestExitCodeSignalSource`.

## Graph schema

6 node tables — `Function`, `Class`, `Module`, `Spec`, `Decision`, `Doc`.
7 relationship tables — `CALLS`, `IMPORTS`, `DEFINES`, `IMPLEMENTS`, `IMPACTS`,
`SUPERSEDES`, `REFERENCES`. See **[docs/API.md](./docs/API.md)** for the full DDL
and the front-matter schema that drives knowledge ingestion.

## Status

- [x] **Phase 1** — scaffold (MIT, Node 22, ESM+CJS, tsup, vitest), Kuzu
      abstraction + idempotent schema (6 NODE / 7 REL tables), three adapter
      interfaces + generic defaults, Hono `GET /health`, `EmbeddedClient`
- [x] **Phase 2** — CodeGraph: tree-sitter extractor/indexer, cross-file `CALLS`
      resolution, scope-qualified function ids
- [x] **Phase 3** — KnowledgeGraph: front-matter markdown → `Spec` / `Decision`
      + `IMPACTS` / `SUPERSEDES` edges
- [x] **Phase 4** — SAGE evolution layer: confidence feedback (`STEP` 0.25,
      floor 0.1), `topByConfidence`, `rankedImpact`
- [x] **Phase 5** — REST routes (`/graph/call-chain`, `/graph/impact-analysis`,
      `/graph/ingest`), MCP server (5 tools), standalone `codesage` CLI

## Contributing

See **[CONTRIBUTING.md](./CONTRIBUTING.md)** for dev setup, the build/test/health
loop, and the kuzu + tree-sitter teardown caveat. Changes are tracked in
**[CHANGELOG.md](./CHANGELOG.md)**.

## License

MIT — see [LICENSE](./LICENSE).
