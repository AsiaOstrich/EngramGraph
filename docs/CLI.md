# EngramGraph CLI

> **Language:** English · [繁體中文](../locales/zh-TW/docs/CLI.md) · [简体中文](../locales/zh-CN/docs/CLI.md)

The `egr` CLI indexes a repository into the graph and queries it from the
shell or CI. It is a thin layer over the same tested functions the library and
MCP server use — zero LLM, deterministic.

```
egr <command> [args] [options]
```

## Graph DB location

Every command reads/writes one Kuzu database. Its path is resolved in this
priority order:

1. env `ENGRAM_DB` (a full path; highest), else
2. `--graph <name>` → `./.engram/<name>.db`, else
3. `--isolation git-branch` (or env `ENGRAM_ISOLATION=git-branch`) → a
   per-branch DB `<git-common-dir>/engram/<branch>.db`, else
4. the default single `./.engram/graph.db`.

The directory is created on demand and the schema is ensured on every open
(idempotent), so the first `index` works against an empty repo. See
[Branch / project isolation](#branch--project-isolation) below.

## Global options

| Option | Description |
|--------|-------------|
| `--json` | Emit raw JSON instead of the human-readable summary |
| `--graph <name>` | Use `./.engram/<name>.db` — an explicitly named project graph |
| `--isolation <mode>` | `single` (default) or `git-branch` (one graph per branch) |
| `-h`, `--help` | Show usage |
| `-v`, `--version` | Show the package version |

## Commands

### `index <dir> [--docs] [--clean] [--scip <path>]`

Recursively indexes source files under `<dir>` into the **code graph**
(tree-sitter → `Function` / `Class` / `Module` nodes + cross-file `CALLS`).
With `--docs`, also indexes `*.md` files into the **knowledge graph**
(front-matter → `Spec` / `Decision` + `IMPACTS` / `SUPERSEDES`).

- Code extensions: `.ts .tsx .js .jsx .mts .cts .mjs .cjs .cs .py .go .java
  .kt .kts .rs .cpp .cc .cxx .hpp .h .hh .rb .php .dart` (`.d.ts` excluded).
- Skipped directories: `node_modules`, `dist`, `.engram`, `.git`, `coverage`,
  `bin`, `obj`, `__pycache__`, `.venv`, `venv`, `vendor`, `target`, `build`.
- `--clean`: drop the graph's data before indexing. Indexing is otherwise an
  upsert (MERGE) that never deletes, so a node removed from the code lingers;
  `--clean` rebuilds from scratch to prune it.

```bash
egr index ./src
egr index . --docs
egr index ./src --clean   # rebuild, pruning deleted nodes
```

Output counts: `files`, `functions`, `classes`, `calls`, plus `ambiguous`
(callee name matched > 1 function — skipped) and `unresolved` (callee matched
none — skipped); with `--docs`, `specs` / `decisions` / `impacts` / `supersedes`.

#### `--scip <path>` — overlay a SCIP index for higher-precision CALLS

tree-sitter's own name-based CALLS resolution is deliberately conservative:
when a callee name matches more than one function across the repo it skips
the call rather than guessing (`ambiguous` in the output above). A [SCIP]
index — produced by a real compiler/type-checker-backed indexer for the
language in question — carries unambiguous symbol references, so `--scip`
overlays it on top of the tree-sitter pass to resolve calls tree-sitter alone
can't, and to upgrade the confidence of ones it already resolved.

[SCIP]: https://github.com/sourcegraph/scip

```bash
# 1. Produce the .scip file yourself, with an indexer for your language.
#    egr does NOT invoke dotnet/java/maven or any other build toolchain —
#    that step is entirely your own build environment's responsibility.
dotnet tool install --global scip-dotnet   # once
scip-dotnet index MyProject.csproj --output index.scip

# 2. Point egr at it. --scip always runs a full tree-sitter pass first, then
#    overlays the SCIP data — a single command is a complete, from-scratch
#    index; you do not need to have run a plain `egr index` before this.
egr index . --scip index.scip
```

Requirements and failure modes:

- **`<dir>` must be the SAME project root the external indexer was run
  against.** A SCIP index's occurrence paths are relative to that root; if
  they don't match `<dir>`'s own file paths, `egr` fails with a "none of the
  N document path(s) ... matched any source file under `<dir>`" error rather
  than silently ingesting nothing. SCIP paths are always `/`-separated by
  spec; `egr`'s own paths are normalized to `/` as well regardless of host
  OS, so this comparison is designed to line up on Windows too, not just
  POSIX — verified with string-level unit tests against simulated
  Windows-style paths (no real Windows host to test against in this
  project's own CI). If `--scip` reports 0 definitions/calls resolved
  despite matching files, a warning is printed; one possible cause is a
  stale `.scip` file — generated before the source tree was subsequently
  edited, so it no longer matches on content even though the paths agree.
- A missing or non-SCIP file at `<path>` fails with a clear "file not found"
  or "could not be parsed as a SCIP protobuf index" error.
- A graph DB whose `CALLS` table predates this feature's schema change
  (the `provider`/`confidence` columns) fails with an error explaining the
  fix: **`--clean` does NOT resolve this** (it only deletes row data via
  `DETACH DELETE`, never table schema — `initSchema`'s `CREATE TABLE` is a
  no-op once a table already exists). Delete the graph DB file itself (by
  default `.engram/graph.db` + its `.wal` sidecar, or wherever
  `ENGRAM_DB`/`--graph`/`--isolation` resolves it to — see
  [Graph DB location](#graph-db-location) above) and re-run `egr index`
  against the now-empty path.
- Currently verified against `scip-dotnet` (C#) and `scip-java` (Java)
  output; any SCIP-conformant indexer for a tree-sitter-supported language
  should work the same way in principle (the merge logic is language-generic),
  but this has not actually been tried against a third indexer.

Output adds a `scip` block: `documentsInIndex` (documents in the `.scip`
file), `filesMatched` (how many of those overlapped `<dir>`'s own files —
less than `documentsInIndex` is normal, e.g. compiler-generated files an
indexer sees but `egr` deliberately skips), `definitionsResolved` /
`definitionsUnresolved`, `callsEmitted`, and the two skip counters
`callsSkippedNoEnclosingCaller` / `callsSkippedUnresolvedTarget`. If files
matched but resolution came back at zero, the human-readable output adds a
`WARNING` line rather than silently reporting an all-zero result as success.

### `callers <symbol> [--depth N]`

Functions that (transitively, up to `--depth`, default 1) call `<symbol>`.
"What breaks if I change this?"

```bash
egr callers callChain --depth 2
```

### `callees <symbol> [--depth N]`

Functions that `<symbol>` (transitively, up to `--depth`, default 1) calls.

```bash
egr callees createMcpServer
```

> `--depth` is clamped to `1..10`. A symbol is matched by **name**; if a name is
> reused across files, all matches are considered.

### `impact <spec-id> [--max-hops N]`

Decisions in the impact chain of a spec — which `Decision` nodes affect this
`Spec`, via the direct `IMPACTS` edge plus a multi-hop `SUPERSEDES` chain
(`--max-hops`, default 3, clamped to `1..10`).

```bash
egr impact SPEC-001
egr impact SPEC-001 --max-hops 5 --json
```

Each result row shows the decision `id`, how it was reached (`direct` |
`supersedes`), and its `title`.

### `feedback <type> <node-id> [--label L]`

Evolve a node's SAGE confidence from one feedback event.

- `<type>`: `test_fail` (negative, weight 1.0), `test_pass` (positive, 0.4),
  `human_fix` (positive, 0.6), `status_change` (neutral).
- `--label`: `Function` (default) | `Spec` | `Decision` | `Doc`.
- The node is matched by **id** (for `Decision` / `Spec` the id is e.g.
  `ADR-1` / `SPEC-1`; for `Function` it is the scope-qualified id such as
  `src/a.ts#a`).

```bash
egr feedback test_fail "src/api/server.ts#createServer"
egr feedback human_fix ADR-002 --label Decision
```

Prints `before → after`, or "node not found" if the id/label miss.

### `top <label> [--limit N]`

Highest-confidence nodes of a label, confidence-descending.

- `<label>`: `Function` | `Spec` | `Decision` | `Doc`.
- `--limit`: default 10, clamped to `1..1000`.

```bash
egr top Function --limit 20
egr top Decision --json
```

### `gc [--dry-run]`

Garbage-collect per-branch graphs whose branch no longer exists. Inspects
`<git-common-dir>/engram/`; a `<name>.db` is an orphan when no current local
branch maps to `<name>`. `--dry-run` lists without deleting. No-op outside a git
repo.

```bash
egr gc --dry-run
egr gc
```

### `serve [--port 3000]`

Run the REST server (Hono) over the graph DB. Routes are mounted under
`/graph/*` plus `GET /health`. Long-running — manages its own lifecycle.
See [API.md](./API.md) for the route surface.

```bash
egr serve --port 3000
```

### `mcp`

Run the MCP server over stdio for coding assistants. Identical to the
`egr-mcp` bin. Long-running. See [MCP.md](./MCP.md) for assistant setup.

```bash
egr mcp
```

## Branch / project isolation

By default all commands share one `./.engram/graph.db`. Because `.engram/`
is gitignored and lives in the work tree, **`git checkout` does not swap it** —
different branches share the same graph. Three ways to isolate:

1. **`--isolation git-branch`** (or set `ENGRAM_ISOLATION=git-branch` once in
   your shell): each branch gets its own `<git-common-dir>/engram/<branch>.db`,
   which survives checkouts and never pollutes the work tree. Branch names are
   sanitized with a hash suffix so `feature/x` and `feature-x` never collide.
   Use `egr gc` to reclaim graphs of deleted branches.
2. **`--graph <name>`**: an explicit, git-independent project graph — handy for
   a detached HEAD or when branch names are ad-hoc.
3. **`git worktree`**: each branch checked out in its own directory naturally
   gets its own `./.engram/graph.db` — zero flags, the cleanest isolation when
   branches map to long-lived separate projects.

> **MCP caveat**: the MCP server binds to one graph at startup (it logs the path
> to stderr). It does **not** follow a later `git checkout` — reconnect/restart
> the server (or launch it with `--graph` / `ENGRAM_ISOLATION`) to switch.

## CI example

```bash
export ENGRAM_DB="$PWD/.engram/graph.db"
egr index ./src --docs
# Fail the job if a high-risk symbol gained new callers, query with --json, etc.
egr callers paymentGateway --depth 3 --json > callers.json
```

## Exit codes

`0` on success; `1` on error (the message is written to stderr as
`egr: <message>`).
