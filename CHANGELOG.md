# Changelog

All notable changes to `engramgraph` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
  `IMPACTS` / `SUPERSEDES` edges (AsiaOstrich reference adapter); `impactAnalysis`
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
- **branch / project isolation** (XSPEC-245) — `--isolation git-branch` (or env
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

[0.1.1]: https://github.com/AsiaOstrich/EngramGraph/releases/tag/v0.1.1
[0.1.0]: https://github.com/AsiaOstrich/EngramGraph/releases/tag/v0.1.0
