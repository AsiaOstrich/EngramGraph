# CodeSage CLI

> **Language:** English · [繁體中文](../locales/zh-TW/docs/CLI.md) · [简体中文](../locales/zh-CN/docs/CLI.md)

The `codesage` CLI indexes a repository into the graph and queries it from the
shell or CI. It is a thin layer over the same tested functions the library and
MCP server use — zero LLM, deterministic.

```
codesage <command> [args] [options]
```

## Graph DB location

Every command reads/writes one Kuzu database. Its path is resolved from:

1. an explicit env var `CODESAGE_DB`, otherwise
2. `./.codesage/graph.db` under the current working directory.

The directory is created on demand and the schema is ensured on every open
(idempotent), so the first `index` works against an empty repo.

## Global options

| Option | Description |
|--------|-------------|
| `--json` | Emit raw JSON instead of the human-readable summary |
| `-h`, `--help` | Show usage |
| `-v`, `--version` | Show the package version |

## Commands

### `index <dir> [--docs]`

Recursively indexes source files under `<dir>` into the **code graph**
(tree-sitter → `Function` / `Class` / `Module` nodes + cross-file `CALLS`).
With `--docs`, also indexes `*.md` files into the **knowledge graph**
(front-matter → `Spec` / `Decision` + `IMPACTS` / `SUPERSEDES`).

- Code extensions: `.ts .tsx .js .jsx .mts .cts .mjs .cjs` (`.d.ts` excluded).
- Skipped directories: `node_modules`, `dist`, `.codesage`, `.git`, `coverage`.

```bash
codesage index ./src
codesage index . --docs
```

Output counts: `files`, `functions`, `classes`, `calls`, plus `ambiguous`
(callee name matched > 1 function — skipped) and `unresolved` (callee matched
none — skipped); with `--docs`, `specs` / `decisions` / `impacts` / `supersedes`.

### `callers <symbol> [--depth N]`

Functions that (transitively, up to `--depth`, default 1) call `<symbol>`.
"What breaks if I change this?"

```bash
codesage callers callChain --depth 2
```

### `callees <symbol> [--depth N]`

Functions that `<symbol>` (transitively, up to `--depth`, default 1) calls.

```bash
codesage callees createMcpServer
```

> `--depth` is clamped to `1..10`. A symbol is matched by **name**; if a name is
> reused across files, all matches are considered.

### `impact <spec-id> [--max-hops N]`

Decisions in the impact chain of a spec — which `Decision` nodes affect this
`Spec`, via the direct `IMPACTS` edge plus a multi-hop `SUPERSEDES` chain
(`--max-hops`, default 3, clamped to `1..10`).

```bash
codesage impact XSPEC-237
codesage impact XSPEC-237 --max-hops 5 --json
```

Each result row shows the decision `id`, how it was reached (`direct` |
`supersedes`), and its `title`.

### `feedback <type> <node-id> [--label L]`

Evolve a node's SAGE confidence from one feedback event.

- `<type>`: `test_fail` (negative, weight 1.0), `test_pass` (positive, 0.4),
  `human_fix` (positive, 0.6), `status_change` (neutral).
- `--label`: `Function` (default) | `Spec` | `Decision` | `Doc`.
- The node is matched by **id** (for `Decision` / `Spec` the id is e.g.
  `DEC-1` / `XSPEC-1`; for `Function` it is the scope-qualified id such as
  `src/a.ts#a`).

```bash
codesage feedback test_fail "src/api/server.ts#createServer"
codesage feedback human_fix DEC-070 --label Decision
```

Prints `before → after`, or "node not found" if the id/label miss.

### `top <label> [--limit N]`

Highest-confidence nodes of a label, confidence-descending.

- `<label>`: `Function` | `Spec` | `Decision` | `Doc`.
- `--limit`: default 10, clamped to `1..1000`.

```bash
codesage top Function --limit 20
codesage top Decision --json
```

### `serve [--port 3000]`

Run the REST server (Hono) over the graph DB. Routes are mounted under
`/graph/*` plus `GET /health`. Long-running — manages its own lifecycle.
See [API.md](./API.md) for the route surface.

```bash
codesage serve --port 3000
```

### `mcp`

Run the MCP server over stdio for coding assistants. Identical to the
`codesage-mcp` bin. Long-running. See [MCP.md](./MCP.md) for assistant setup.

```bash
codesage mcp
```

## CI example

```bash
export CODESAGE_DB="$PWD/.codesage/graph.db"
codesage index ./src --docs
# Fail the job if a high-risk symbol gained new callers, query with --json, etc.
codesage callers paymentGateway --depth 3 --json > callers.json
```

## Exit codes

`0` on success; `1` on error (the message is written to stderr as
`codesage: <message>`).
