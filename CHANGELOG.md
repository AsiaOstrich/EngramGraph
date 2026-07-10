# Changelog

All notable changes to `engramgraph` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-07-10

### Added

- `egr god-nodes [--limit N]` — importance ranking via ryugraph's native
  PageRank extension (DEC-027, structural-memory L3; concept borrowed from
  [graphify](https://github.com/safishamsi/graphify)'s `god_nodes`, but
  computed directly against ryugraph's built-in `algo` extension instead of
  a ported implementation).
- `egr communities` — clustering via ryugraph's native Louvain extension
  (DEC-027, L3). Scoped to `Function`/`CALLS` only — ryugraph's Louvain
  rejects heterogeneous projected graphs at runtime ("only supports
  operations on one node table"); PageRank has no such restriction.
- `egr related <node-id> [--depth N] [--limit N]` — seeded-neighborhood
  importance ranking (DEC-028, structural-memory L4a): a depth-bounded BFS
  around the seed id, projected to a filtered subgraph, ranked by PageRank.
  Approximates HippoRAG-style personalized PageRank ("what matters near
  this node") without a hand-written iterative algorithm, and correctly
  crosses node types (e.g. `Function` → `Spec` via `IMPLEMENTS`). Does not
  cover turning a free-text query into seed ids (HippoRAG's OpenIE +
  fact-reranking layer) — out of scope without a semantic/embedding layer.

### Fixed

- Native-addon crash on teardown: opening and closing more than ~6
  cumulative `GraphConnection`s in a single process (each loading the
  ryugraph `algo` extension) could segfault on worker exit, even though
  every individual test assertion passed. The test suite now shares one
  connection per file/describe block instead of one per test.
- Local install docs: `npm install engramgraph` (non-global) does not put
  `egr` on `PATH`. README now recommends `npm install -g engramgraph` for
  CLI use, with a separate note for library (`import ... from
  "engramgraph"`) use cases.

### Known Limitations

- **Linux ARM64**: `ryugraph@25.9.1` ships an incorrect native binary for
  this platform (byte-identical to the x86-64 build) — tracked upstream at
  [predictable-labs/ryugraph#48](https://github.com/predictable-labs/ryugraph/issues/48).
  Affects Docker Desktop on Apple Silicon Macs (defaults to `linux/arm64`),
  AWS Graviton, and other ARM64 Linux hosts.
- **Linux x64 with glibc < 2.38** (e.g. Ubuntu 22.04 LTS, Debian 12): the
  `ryugraph@25.9.1` native binary requires a newer glibc than these
  still-common LTS distros ship.
- See the README's [Platform support matrix](README.md#platform-support-matrix)
  for the full compatibility table, verification method, and workarounds.
  Both limitations pre-date this release (present since `ryugraph@25.9.1`
  was introduced in 0.3.0) — this release does not introduce or worsen
  either one.

## [0.3.0] — 2026-06-12

### Security

- Replaced abandoned `kuzu@0.11.3` with `ryugraph@25.9.1` (active Kuzu fork
  by Predictable Labs). Eliminates the high-severity vulnerabilities that
  were introduced via kuzu's deprecated transitive deps (`npmlog`, `gauge`,
  `are-we-there-yet`).
- Added an npm `overrides` entry forcing `cmake-js@^8.0.0`, lifting the
  transitive `tar` to a patched version (ryugraph pins `cmake-js@^7.3.0`,
  whose `tar@6.2.1` carries multiple high-severity path-traversal CVEs).
  `npm audit` is now clean (0 vulnerabilities) in this repo. Note that npm
  `overrides` do not propagate to downstream consumers — projects depending
  on `engramgraph` should add the same override until ryugraph bumps
  cmake-js upstream.

### Changed

- `KuzuValue` type renamed to `RyuValue` in all public APIs
  (`GraphConnection.query()`, `EmbeddedClient.query()`).
  Update imports: `import type { RyuValue } from "ryugraph"`.

## [0.2.0] — 2026-05-31

Positions EngramGraph as a standalone, general-purpose engine — docs and source
no longer reference any specific consuming project.

### Changed (BREAKING)

- Renamed export `XspecDecKnowledgeSource` → `SpecDecisionKnowledgeSource`
  (same behaviour, generic name).
- The reference knowledge adapter recognizes `SPEC-` / `DEC-` / `ADR-` id
  conventions; the project-specific `XSPEC-` alias is dropped (`SPEC-` covers the
  generic spec case). Generic spec/decision/ADR classification is unchanged.

### Docs

- Removed project-specific narrative (and example ids) from the README, docs,
  and source comments; the project now reads as a standalone OSS engine.

## [0.1.1] — 2026-05-31

First release via OIDC Trusted Publishing (no token). Renamed from CodeSage /
`@asiaostrich/codesage` to the unscoped `engramgraph`.

### Changed

- Package renamed `@asiaostrich/codesage` → `engramgraph`; CLI `codesage` → `egr`
  (plus `engramgraph` alias, MCP bin `egr-mcp`); env `CODESAGE_DB` → `ENGRAM_DB`
  (legacy honored as fallback); default dir `.codesage/` → `.engram/`.

### Fixed

- Bin paths drop the `./` prefix to silence npm's publish auto-correct warning.

## [0.1.0] — 2026-05-30

First public release. A code + knowledge graph memory engine (SAGE + CodeGraph)
on embedded Kuzu, usable as a library, REST service, MCP server, or CLI.

### Added

- **graph-db** — `GraphConnection` over embedded Kuzu; idempotent schema
  (6 node tables: `Function` / `Class` / `Module` / `Spec` / `Decision` / `Doc`;
  7 relationship tables: `CALLS` / `IMPORTS` / `DEFINES` / `IMPLEMENTS` /
  `IMPACTS` / `SUPERSEDES` / `REFERENCES`); `writeFragment`.
- **code-graph** — tree-sitter extractor/indexer for `.ts` / `.tsx` / `.js`;
  cross-file `CALLS` resolution; scope-qualified, stable function ids
  (`file#scope.name`); `callers` / `callees` / `callChain` queries.
- **knowledge-graph** — front-matter markdown → `Spec` / `Decision` nodes with
  `IMPACTS` / `SUPERSEDES` edges (reference adapter); `impactAnalysis`
  with multi-hop SUPERSEDES traversal.
- **sage** — self-evolving confidence (`STEP` 0.25, range `[0.1, 1.0]`);
  `applyFeedback`, `feedbackForEventType`, `ingestFeedback`, `runEvolution`,
  `topByConfidence`, `rankedImpact`.
- **adapters** — three pluggable interfaces with generic defaults: knowledge
  source (`MarkdownKnowledgeSource`), isolation model (`SingleRepoIsolation` /
  `OrgProjectIsolation`), SAGE signal source (`GitHistorySignalSource` /
  `TestExitCodeSignalSource`).
- **api** — Hono REST server (`createServer`) with `GET /health` and graph
  routes `/graph/call-chain`, `/graph/impact-analysis`, `/graph/ingest`.
- **mcp** — Model Context Protocol server (`createMcpServer`, stdio bin
  `egr-mcp`) exposing `index_code`, `index_docs`, `call_chain`,
  `impact_analysis`, `ingest_feedback`.
- **cli** — standalone `egr` CLI: `index`, `callers`, `callees`, `impact`,
  `feedback`, `top`, `gc`, `serve`, `mcp` (`--json` / `--help` / `--version`).
- **branch / project isolation** — `--isolation git-branch` (or env
  `ENGRAM_ISOLATION=git-branch`) keeps a per-branch graph under
  `<git-common-dir>/engram/<branch>.db`; `--graph <name>` selects an explicit
  named graph; `index --clean` rebuilds to prune deleted nodes; `gc` removes
  graphs of deleted branches. New `GitBranchIsolation` adapter + `clearGraph`,
  `resolveDbPath`, `openGraph` exports. Default stays single-graph (unchanged).
- **embedded** — `EmbeddedClient` for in-process, zero-HTTP use, with a
  high-level facade (`indexCode`, `indexDocs`, `callChain`, `callers`,
  `callees`, `impactAnalysis`, `ingestFeedback`, `topByConfidence`) mirroring
  the REST/MCP surfaces so consumers never need the raw `GraphConnection`.
- Tri-lingual documentation (English / 繁體中文 / 简体中文): README, CLI, MCP,
  API, CONTRIBUTING.

[0.4.0]: https://github.com/AsiaOstrich/EngramGraph/releases/tag/v0.4.0
[0.2.0]: https://github.com/AsiaOstrich/EngramGraph/releases/tag/v0.2.0
[0.1.1]: https://github.com/AsiaOstrich/EngramGraph/releases/tag/v0.1.1
[0.1.0]: https://github.com/AsiaOstrich/EngramGraph/releases/tag/v0.1.0
