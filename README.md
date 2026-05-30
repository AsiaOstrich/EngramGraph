# CodeSage

> Open-source **code + knowledge graph memory engine**, fusing
> [SAGE](https://arxiv.org/abs/2605.12061) self-evolving graph memory with
> CodeGraph structural code understanding.

**License:** MIT · **Runtime:** Node.js ≥ 22 · **Graph DB:** [Kuzu](https://kuzudb.com/) (embedded, Cypher)

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
   Defaults: `GitHistorySignalSource`, `TestExitCodeSignalSource` (Phase 1 stubs).

## Three modes

| Mode | Entry | Use case |
|------|-------|----------|
| **Embedded** | `EmbeddedClient` | Same-process, zero HTTP overhead (e.g. VibeOps integration) |
| **REST** | `createServer()` (Hono) | Standalone graph service; routes under `/graph/*` |
| **MCP** | `codesage-mcp` (stdio bin) | Plug-and-play for coding assistants (Claude Code, Codex, Cursor, ...) |

## MCP — use CodeSage from a coding assistant

CodeSage ships an MCP server (stdio) exposing 5 tools — `index_code`,
`index_docs`, `call_chain`, `impact_analysis`, `ingest_feedback` — so any
MCP-capable assistant can use it as a code + knowledge graph. Zero LLM,
deterministic.

```bash
# Claude Code
claude mcp add codesage -- node /abs/path/to/codesage/dist/mcp/stdio.js
# or, once installed as a package, the bin:
claude mcp add codesage -- npx codesage-mcp
```

The graph DB path is `CODESAGE_DB` (default `./.codesage/graph.db`). Example
assistant flow: `index_code` your repo → ask "what calls `execute`?" →
`call_chain` returns the callers; `impact_analysis` returns the decisions
behind a spec. Any MCP client works (Cursor/Windsurf/Codex via their MCP config).

## Quickstart

```bash
npm install
npm run typecheck
npm test
```

### Embedded usage

```ts
import { EmbeddedClient } from "@asiaostrich/codesage";

const client = new EmbeddedClient();   // SingleRepoIsolation by default
await client.init();                   // opens graph.db + ensures schema
const rows = await client.query("MATCH (f:Function) RETURN f.name AS name");
await client.close();
```

### REST usage

```ts
import { createServer } from "@asiaostrich/codesage";

const app = createServer();
// GET /health → { status: "ok" } (200)
```

## Status

Phase 1 skeleton (XSPEC-237):

- [x] Project scaffold (MIT, Node 22, ESM, tsup, vitest)
- [x] Kuzu abstraction + idempotent schema (6 NODE / 7 REL tables)
- [x] Three adapter interfaces + generic defaults
- [x] Hono server + `GET /health` (AC-1)
- [x] EmbeddedClient skeleton
- [ ] Phase 2 CodeGraph (tree-sitter extractor/indexer)
- [ ] Phase 3 KnowledgeGraph (markdown + AsiaOstrich reference adapter)
- [ ] Phase 4 SAGE evolution layer

## License

MIT — see [LICENSE](./LICENSE).
