# EngramGraph

> **Language:** English · [繁體中文](./locales/zh-TW/README.md) · [简体中文](./locales/zh-CN/README.md)

[![npm](https://img.shields.io/npm/v/engramgraph)](https://www.npmjs.com/package/engramgraph)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)

> Open-source **code + knowledge graph memory engine**, fusing
> [SAGE](https://arxiv.org/abs/2605.12061) self-evolving graph memory with
> CodeGraph structural code understanding.

**License:** MIT · **Runtime:** Node.js ≥ 22 · **Graph DB:** [Kuzu](https://kuzudb.com/) (embedded, Cypher) · **No LLM required** (deterministic)

EngramGraph is a general-purpose engine. The defaults ("single repo + generic
markdown + git signals") work out of the box for any project; project-specific
behaviour is supplied through pluggable adapters.

## Why a graph?

Vector search ("find me similar memories") and graph traversal ("find me
structurally related nodes") are complementary. EngramGraph adds the graph half:

> "I want to change `execute()` → the engine walks: callers → related specs →
> the decisions behind them."

## Install

```bash
npm install -g engramgraph
```

This puts the `egr` CLI on your `PATH` so the Quickstart commands below work from
any directory. Or run the CLI without a global install:

```bash
npx engramgraph index ./src
```

### Platform support matrix

EngramGraph depends on [`ryugraph`](https://github.com/predictable-labs/ryugraph) for
its embedded graph database, which ships prebuilt native binaries per platform. As of
`ryugraph@25.9.1`, verified support is:

| Platform | Status | Notes |
|---|---|---|
| macOS ARM64 (Apple Silicon) | ✅ Works | Verified via [Cross-Platform Compatibility Check](.github/workflows/release-compat-check.yml) (`macos-latest`) |
| macOS x64 (Intel) | ⚠️ Not CI-verified (known limitation, see below) | No known issue — `ryujs-darwin-x64.node` is a distinct, legitimately-built binary (unlike the Linux ARM64 case) — but not exercised by an automated release gate |
| Linux x64, glibc ≥ 2.38 (Ubuntu 24.04+, Debian 13+) | ✅ Works | Verified via CI glibc-compat matrix (`node:24-trixie`, glibc 2.41) |
| Linux x64, glibc < 2.38 (Ubuntu 22.04 LTS, Debian 12) | ❌ Broken | Upstream `ryugraph` binary requires a newer glibc than these still-common LTS distros ship. Verified via CI glibc-compat matrix (`node:24`, glibc 2.36) |
| Linux ARM64 (any glibc) | ❌ Broken | Upstream ships the x86-64 binary under the arm64 filename — tracked in [predictable-labs/ryugraph#48](https://github.com/predictable-labs/ryugraph/issues/48). Verified via CI (`ubuntu-24.04-arm`) |
| Windows x64 | ✅ Works | Verified via CI (`windows-latest`) |

This affects **Docker Desktop on Apple Silicon Macs** (defaults to `linux/arm64`) and
**AWS Graviton / other ARM64 Linux hosts** — if `egr` fails there, it's very likely
[#48](https://github.com/predictable-labs/ryugraph/issues/48), not a problem with your
setup. Forcing `--platform linux/amd64` on affected Docker hosts works around it (at
the cost of running under emulation on ARM64 hardware) until upstream is fixed.

Also note: npm ≥ 11 gates native install scripts (including `ryugraph`'s) behind an
approval prompt by default. If `npm install` prints `npm warn allow-scripts`, run
`npm approve-scripts --all` and reinstall — otherwise the native binary is never
copied into place.

**Why macOS Intel isn't in the automated release gate.** This isn't an oversight —
it's a deliberate call. Two independent facts point the same direction:

- **GitHub's own Intel Mac (`macos-13`) hosted runners currently have severe queue
  capacity constraints.** A real test run on 2026-07-10 sat in `queued` for ~50 minutes
  without ever starting. GitHub Actions' `timeout-minutes` cannot bound this — it only
  starts counting once a job actually begins executing, not while queued — so there is
  no reliable way to cap how long a release could be stuck waiting on this runner.
- **Apple's own support lifecycle is winding down.** macOS 26 "Tahoe" is the last major
  release with Intel Mac support; macOS 27 "Golden Gate" (expected September 2026) drops
  Intel entirely, with only security-only updates continuing on macOS 26 until roughly
  2029. Intel Mac is a sunsetting platform on both Apple's and GitHub's side.

Given that, blocking every release on a runner that may never become available — for a
platform winding down anyway — didn't make sense. Instead, `macos-x64-intel-manual` in
[`release-compat-check.yml`](.github/workflows/release-compat-check.yml) runs Intel Mac
verification as a **best-effort, non-blocking** job: triggerable manually via
`workflow_dispatch` whenever someone wants to check it, `continue-on-error: true` so it
never fails a release, and excluded from the `release: published` trigger so a real
release is never left waiting on it. If you specifically need Intel Mac support
confirmed, trigger that job manually and check its result — but the release process
itself doesn't depend on it.

### Troubleshooting: misleading native-binary errors

Native binary loading failures on Linux surface through Node's `dlopen`, whose error
text doesn't always describe the real cause:

| Error you see | What it usually means |
|---|---|
| `ryujs.node: cannot open shared object file: No such file or directory` (file *does* exist per `ls`) | Wrong CPU architecture — the binary at that path is for a different platform/arch than the one you're running on |
| `.../libc.so.6: version 'GLIBC_2.38' not found` | Your distro's glibc is older than what the prebuilt binary requires (see matrix above) |
| `npm warn allow-scripts ... not yet covered by allowScripts` | npm ≥ 11 blocked the install script that copies the native binary — run `npm approve-scripts --all` then reinstall/rebuild |

If you hit something not covered here, please check
[predictable-labs/ryugraph's issues](https://github.com/predictable-labs/ryugraph/issues)
before assuming it's an EngramGraph bug — most native-loading failures originate in the
`ryugraph` dependency, not this package.

## Quickstart

```bash
# 1. Index a repo into the graph (code + optional docs)
egr index ./src --docs

# 2. "What breaks if I change this function?"
egr callers myFunction --depth 2

# 3. "Which decisions sit behind this spec?"
egr impact SPEC-001
```

The graph DB lives at `ENGRAM_DB` (default `./.engram/graph.db`).
Full command reference: **[docs/CLI.md](./docs/CLI.md)**.

### Embedded usage (in-process, zero HTTP)

> **Library use** (Embedded / REST below) needs a local dependency, not the
> global CLI — install with `npm install engramgraph` (no `-g`) so
> `import ... from "engramgraph"` resolves.

```ts
import { EmbeddedClient } from "engramgraph";

const client = new EmbeddedClient();   // SingleRepoIsolation by default
await client.init();                   // opens graph.db + ensures schema
const rows = await client.query("MATCH (f:Function) RETURN f.name AS name");
await client.close();
```

### REST usage

```ts
import { createServer, GraphConnection } from "engramgraph";

const conn = GraphConnection.open("./.engram/graph.db");
const app = createServer({ connection: conn });   // Hono app; routes under /graph/*
// GET /health → { status: "ok" }
```

Or just `egr serve --port 3000`. API reference: **[docs/API.md](./docs/API.md)**.

## Three modes

| Mode | Entry | Use case |
|------|-------|----------|
| **Embedded** | `EmbeddedClient` | Same-process, zero HTTP overhead (e.g. same-process integration) |
| **REST** | `createServer()` (Hono) / `egr serve` | Standalone graph service; routes under `/graph/*` |
| **MCP** | `egr-mcp` (stdio) / `egr mcp` | Plug-and-play for coding assistants (Claude Code, Codex, Cursor, ...) |

## MCP — use EngramGraph from a coding assistant

EngramGraph ships an MCP server (stdio) exposing 5 tools — `index_code`,
`index_docs`, `call_chain`, `impact_analysis`, `ingest_feedback` — so any
MCP-capable assistant can use it as a code + knowledge graph. Zero LLM,
deterministic, **no Docker**.

```bash
# Claude Code, from an installed package:
claude mcp add egr -- npx egr-mcp
```

Full setup (Claude Code / Codex / Cursor / Windsurf), the 5 tools, and an
example flow: **[docs/MCP.md](./docs/MCP.md)**.

## Core vs Adapter boundary

| Layer | Contents | External usability |
|-------|----------|--------------------|
| **Generic Core** | CodeGraph (tree-sitter → graph), SAGE evolution, Kuzu abstraction, REST/MCP/Embedded modes, node-sdk | Zero project-specific dependency |
| **Pluggable Adapters (interfaces)** | (1) knowledge source (2) isolation model (3) SAGE signal source | Core ships interface + a generic default |

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
      `/graph/ingest`), MCP server (5 tools), standalone `egr` CLI

## Contributing

See **[CONTRIBUTING.md](./CONTRIBUTING.md)** for dev setup, the build/test/health
loop, and the kuzu + tree-sitter teardown caveat. Changes are tracked in
**[CHANGELOG.md](./CHANGELOG.md)**.

## License

MIT — see [LICENSE](./LICENSE).
