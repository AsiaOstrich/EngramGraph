# EngramGraph MCP server

> **Language:** English · [繁體中文](../locales/zh-TW/docs/MCP.md) · [简体中文](../locales/zh-CN/docs/MCP.md)

EngramGraph ships a [Model Context Protocol](https://modelcontextprotocol.io)
server (stdio transport) so any MCP-capable coding assistant can use it as a
**code + knowledge graph memory**. It is a thin adapter over the existing,
tested query functions — **zero LLM, deterministic, no Docker**.

The server runs as a local subprocess the assistant spawns over stdio; there is
no network service, no container, no API key.

## Setup

The server binary is `egr-mcp` (equivalently `egr mcp`). It reads the
graph DB from `ENGRAM_DB` (default `./.engram/graph.db`).

### Claude Code

```bash
# From an installed package:
claude mcp add egr -- npx egr-mcp

# Or point at a local checkout's built bin:
claude mcp add egr -- node /abs/path/to/EngramGraph/dist/mcp/stdio.js
```

To pin the graph location, pass the env var:

```bash
claude mcp add egr --env ENGRAM_DB=/abs/path/.engram/graph.db -- npx egr-mcp
```

Verify with `claude mcp list` → `egr … ✓ Connected`.

### Codex / Cursor / Windsurf (and other MCP clients)

Add a stdio server to the client's MCP config. The shape varies per client, but
the command/args/env are the same:

```jsonc
{
  "mcpServers": {
    "egr": {
      "command": "npx",
      "args": ["egr-mcp"],
      "env": { "ENGRAM_DB": "/abs/path/.engram/graph.db" }
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
| `implementers` | `specId` | Files declaring `// implements <specId>` and the functions they define. "Which code implements this spec?" Reads `IMPLEMENTS(Module→Spec)` + `DEFINES`. |
| `implemented_specs` | `moduleId` | Specs a file declares it implements. "Which spec governs this code?" `moduleId` is the file's indexed path. Reads `IMPLEMENTS(Module→Spec)`. |
| `related` | `seedId`, `depth?`, `limit?` | Structurally important nodes around a seed id (seeded PageRank over all edge types, crosses `Function`/`Spec`/`Module`/`Decision`). "What's connected to X?" |

Every tool returns a text content block of JSON; on failure it returns
`error: <message>` with `isError: true`.

## Example assistant flow

1. **Index** the repo: the assistant calls `index_code` with the project's
   source files, and `index_docs` with its spec/decision markdown.
2. **Ask "what calls `execute`?"** → `call_chain` with
   `{ symbol: "execute", direction: "callers", depth: 2 }` returns the callers.
3. **Ask "which decisions sit behind SPEC-001?"** → `impact_analysis` with
   `{ nodeId: "SPEC-001" }` returns e.g. `[ADR-001, ADR-002]`.
4. **Record an outcome**: after a test fails for a function, `ingest_feedback`
   with `{ nodeId, type: "test_fail" }` lowers that node's confidence, so the
   next ranked query surfaces the more-reinforced nodes first.

## Notes

- The connection is **long-lived**; EngramGraph never closes it per call (a kuzu +
  tree-sitter teardown caveat — see [CONTRIBUTING.md](../CONTRIBUTING.md)).
- The graph is shared with the `egr` CLI and the REST server: index once
  via any mode, query from another.
- Confidence semantics (`STEP` 0.25, floor 0.1) and the full DDL are in
  [API.md](./API.md).
