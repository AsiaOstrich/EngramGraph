# CodeSage MCP server

> **Language:** English · [繁體中文](../locales/zh-TW/docs/MCP.md) · [简体中文](../locales/zh-CN/docs/MCP.md)

CodeSage ships a [Model Context Protocol](https://modelcontextprotocol.io)
server (stdio transport) so any MCP-capable coding assistant can use it as a
**code + knowledge graph memory**. It is a thin adapter over the existing,
tested query functions — **zero LLM, deterministic, no Docker**.

The server runs as a local subprocess the assistant spawns over stdio; there is
no network service, no container, no API key.

## Setup

The server binary is `codesage-mcp` (equivalently `codesage mcp`). It reads the
graph DB from `CODESAGE_DB` (default `./.codesage/graph.db`).

### Claude Code

```bash
# From an installed package:
claude mcp add codesage -- npx codesage-mcp

# Or point at a local checkout's built bin:
claude mcp add codesage -- node /abs/path/to/CodeSage/dist/mcp/stdio.js
```

To pin the graph location, pass the env var:

```bash
claude mcp add codesage --env CODESAGE_DB=/abs/path/.codesage/graph.db -- npx codesage-mcp
```

Verify with `claude mcp list` → `codesage … ✓ Connected`.

### Codex / Cursor / Windsurf (and other MCP clients)

Add a stdio server to the client's MCP config. The shape varies per client, but
the command/args/env are the same:

```jsonc
{
  "mcpServers": {
    "codesage": {
      "command": "npx",
      "args": ["codesage-mcp"],
      "env": { "CODESAGE_DB": "/abs/path/.codesage/graph.db" }
    }
  }
}
```

## Tools

| Tool | Input | Returns |
|------|-------|---------|
| `index_code` | `files: { path, source }[]` | Indexes source into the code graph (cross-file `CALLS`). Counts of files/functions/classes/calls (+ ambiguous/unresolved). |
| `index_docs` | `docs: { content, fallbackId? }[]` | Indexes front-matter markdown into the knowledge graph. Counts of specs/decisions/impacts/supersedes. |
| `call_chain` | `symbol`, `direction?` (`callers`\|`callees`\|`both`), `depth?` | Who calls / is called by a function symbol. "What breaks if I change X?" |
| `impact_analysis` | `nodeId`, `maxHops?` | Decisions in a spec's impact chain (`IMPACTS` + multi-hop `SUPERSEDES`). |
| `ingest_feedback` | `nodeId`, `type`, `nodeLabel?` (`Function`\|`Spec`\|`Decision`\|`Doc`), `weight?` | Evolve a node's SAGE confidence from a feedback event (`test_fail`/`test_pass`/`human_fix`). |

Every tool returns a text content block of JSON; on failure it returns
`error: <message>` with `isError: true`.

## Example assistant flow

1. **Index** the repo: the assistant calls `index_code` with the project's
   source files, and `index_docs` with its spec/decision markdown.
2. **Ask "what calls `execute`?"** → `call_chain` with
   `{ symbol: "execute", direction: "callers", depth: 2 }` returns the callers.
3. **Ask "which decisions sit behind XSPEC-237?"** → `impact_analysis` with
   `{ nodeId: "XSPEC-237" }` returns e.g. `[DEC-069, DEC-070]`.
4. **Record an outcome**: after a test fails for a function, `ingest_feedback`
   with `{ nodeId, type: "test_fail" }` lowers that node's confidence, so the
   next ranked query surfaces the more-reinforced nodes first.

## Notes

- The connection is **long-lived**; CodeSage never closes it per call (a kuzu +
  tree-sitter teardown caveat — see [CONTRIBUTING.md](../CONTRIBUTING.md)).
- The graph is shared with the `codesage` CLI and the REST server: index once
  via any mode, query from another.
- Confidence semantics (`STEP` 0.25, floor 0.1) and the full DDL are in
  [API.md](./API.md).
