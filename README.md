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

### Connect it to your coding assistant (MCP)

`egr` also ships an MCP server, so an assistant can query the graph — and update
it — without you running anything by hand. **This is not registered
automatically**, and deliberately so: a package that writes itself into your
assistant's tool configuration during `npm install` has granted itself tool
access without being asked.

One command for Claude Code:

```bash
claude mcp add egr -- npx egr-mcp
```

Confirm it took — the install is not the evidence, this is:

```bash
claude mcp list   # egr … ✓ Connected
```

For a project everyone on the team should get, use `--scope project` instead;
that writes a `.mcp.json` you can commit, and each person is prompted to approve
it once. Keep the entry portable — an absolute path to one machine's Node
install is the usual reason a checked-in `.mcp.json` silently does nothing on
someone else's laptop. `ENGRAM_DB` defaults to `./.engram/graph.db`, so it can
usually be omitted.

Codex / Cursor / Windsurf, all 8 tools, and an example flow:
**[docs/MCP.md](./docs/MCP.md)**.

> **Indexing from the assistant has one limit worth knowing.** The `index_code`
> tool takes file *contents*, not a directory — it does not walk the filesystem.
> That makes it a good fit for updating the files an assistant just edited, and
> a poor one for indexing a whole repository. For that, run `egr index ./src`.

### Native dependencies and platform support

EngramGraph has **two** independent native dependencies, and they fail in different
ways. Knowing which one you hit tells you whether the install is broken or merely
missing one language:

| | Package(s) | Required? | If no prebuilt binary exists for your platform |
|---|---|---|---|
| **Graph database** | [`ryugraph`](https://github.com/predictable-labs/ryugraph) | **Yes** | Built from source via `cmake-js`. If that fails you have no working `egr` at all. |
| **Language grammars** | `tree-sitter` + 12 grammar packages | Per language | Built from source via `node-gyp`. If that fails, **only that language** is unavailable — `egr` installs and indexes everything else. |

Prebuilt coverage as of `engramgraph@0.9.0`:

| Platform | Graph DB | Grammars | What you get |
|---|---|---|---|
| Linux x64, glibc ≥ 2.38 (Ubuntu 24.04+, Debian 13+) | ✅ prebuilt | ✅ all 13 prebuilt | Everything, no compiler needed |
| macOS ARM64 (Apple Silicon) | ✅ prebuilt | ⚠️ Dart compiles | Everything if you have a C/C++ toolchain; otherwise all languages **except Dart** |
| macOS x64 (Intel) | ✅ prebuilt | ⚠️ Dart compiles | Same as above |
| Windows x64 | ✅ prebuilt | ⚠️ Dart compiles | Same as above — see [Windows](#windows-enabling-the-dart-grammar) for the two traps that make this harder than it sounds |
| Windows ARM64 | ❌ **no prebuilt** | ⚠️ Dart compiles | Needs a toolchain even for the graph database; untested |
| Linux ARM64 (any glibc) | ❌ **broken upstream** | ⚠️ Dart compiles | Upstream ships the x86-64 binary under the arm64 filename — [predictable-labs/ryugraph#48](https://github.com/predictable-labs/ryugraph/issues/48) |
| Linux x64, glibc < 2.38 (Ubuntu 22.04 LTS, Debian 12) | ❌ **broken upstream** | ✅ all 13 prebuilt | `ryugraph`'s binary needs a newer glibc than these still-common LTS distros ship |

**Linux x64 is the only platform that installs with no compiler at all.** Everywhere
else, `npm install` compiles at least the Dart grammar
([`@vokturz/tree-sitter-dart`](https://www.npmjs.com/package/@vokturz/tree-sitter-dart)
publishes a prebuilt binary for `linux-x64` only). That grammar is an
**optional dependency**: if the build fails, npm continues, the install succeeds, and
`egr` tells you Dart is unavailable when you index. An install-time notice says so up
front, before the compiler output scrolls past.

> **Why Dart specifically.** Every other grammar in this project ships binaries for all
> six platform/arch pairs. Dart is the exception because it is the only npm Dart grammar
> that is ABI-compatible with this project's pinned `tree-sitter` core — the two
> alternatives that *do* ship full prebuilds load cleanly and then throw inside
> `Parser.setLanguage`. `src/code-graph/grammars.d.ts` records the four-candidate
> comparison. It is a known-bad trade, kept because the alternatives are worse, and
> worth revisiting if a better-maintained package appears.

The Linux ARM64 row affects **Docker Desktop on Apple Silicon Macs** (defaults to
`linux/arm64`) and **AWS Graviton / other ARM64 Linux hosts** — if `egr` fails there
it is very likely [#48](https://github.com/predictable-labs/ryugraph/issues/48), not
your setup. Forcing `--platform linux/amd64` works around it (at the cost of emulation)
until upstream is fixed.

Also note: npm ≥ 11 gates native install scripts (including `ryugraph`'s) behind an
approval prompt by default. If `npm install` prints `npm warn allow-scripts`, run
`npm approve-scripts --all` and reinstall — otherwise the native binary is never
copied into place.

> **How these rows were checked.** The `ryugraph` findings come from direct
> investigation on 2026-07-10; the Windows x64 row from a real install on Windows 11
> on 2026-08-04; the grammar coverage from reading the published packages' shipped
> `prebuilds/` directories, re-asserted on every test run by
> `test/language-support.test.ts`. Earlier revisions of this table cited
> [`release-compat-check.yml`](.github/workflows/release-compat-check.yml) as an
> automated release gate — **that citation was wrong**: the workflow raced the publish
> job and gave up before the package reached npm, so its matrix never once executed and
> no release has actually been gate-verified. Repairing that gate is tracked separately;
> until it runs, treat this table as manually checked, because that is what it is.

#### Windows: enabling the Dart grammar

Installing the C++ toolchain on Windows has two traps that produce the **same** error
message, `gyp ERR! find VS - missing any VC++ toolset`:

1. **`node-gyp` 11.x does not recognise Visual Studio 2026 (v18)** — and 11.x is what
   npm 11 bundles, so this is the common case. Its Visual Studio finder hard-codes
   version 15/16/17 → 2017/2019/2022 and discards anything else, reporting a machine with
   a complete VS 2026 MSVC install as `unknown version "undefined"`. Neither
   `VCINSTALLDIR` nor `msvs_version` gets around it on that version. Two ways out:
   **install the C++ workload into Build Tools 2022** (works regardless of node-gyp
   version), or **upgrade node-gyp** — 12.x does recognise VS 2026 (verified in CI: it
   reports `checking VS2026 (18.8.x)` and offers `2026` as a valid `msvs_version`). The
   exact 11.x→12.x version where support landed is unverified; check your own with
   `npx node-gyp --version`.
2. **Adding the `VCTools` workload does not install a compiler.** Inside that workload,
   `Microsoft.VisualStudio.Component.VC.Tools.x86.x64` is *Recommended*, not *Required* —
   so a machine can report "Visual Studio C++ core features" while having no compiler at
   all. Select it (and a Windows SDK) explicitly.

Via the Visual Studio Installer: pick **Visual Studio Build Tools 2022** → Modify →
check **Desktop development with C++** → confirm **MSVC v143 … build tools** and a
**Windows 11 SDK** are checked on the right. Or from an elevated shell, not run from the
installer's own directory:

```powershell
& "C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe" modify `
  --installPath "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools" `
  --channelId VisualStudio.17.Release `
  --productId Microsoft.VisualStudio.Product.BuildTools `
  --add Microsoft.VisualStudio.Workload.VCTools `
  --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  --add Microsoft.VisualStudio.Component.Windows11SDK.26100 `
  --passive --norestart
```

**Verify by what `node-gyp` prints, not by the installer's exit code.** The installer
returning 0 does not mean the compiler landed — that is exactly the state trap 2
produces. Re-run the install and look for this line:

```
gyp verb find VS - found VC++ toolset: v143
```

Its presence is the whole signal. Its absence is the failure, whichever trap caused it.

**Why macOS Intel isn't in the automated release gate.** (This is about the gate's
*design*; separately, the gate has not been executing at all — see the note above.)
Excluding Intel Mac isn't an oversight, it's a deliberate call. Two independent facts
point the same direction:

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
| `gyp ERR! find VS - missing any VC++ toolset` (Windows) | No usable MSVC compiler. Two different causes produce this identical line — see [Windows: enabling the Dart grammar](#windows-enabling-the-dart-grammar). Note this is **not fatal**: it only costs you Dart |
| `gyp ERR! find VS unknown version "undefined" found at ...\18\BuildTools` | **node-gyp 11.x** doesn't recognise Visual Studio 2026. Install the C++ workload into **Build Tools 2022**, or upgrade node-gyp to 12.x |
| A wall of `node-gyp` output ending in `npm error code 1`, on Windows/macOS | The Dart grammar failed to compile. Expected without a C/C++ toolchain, and survivable — every other language still works |
| `Dart support is not enabled in this installation` (at index time) | The above, seen from the other end. `egr` is working; the Dart grammar isn't built here |
| `IO exception: Failed to download extension: algo` | `god-nodes`, `communities` and `related` need ryugraph's ALGO extension, which `INSTALL ALGO` fetches from `extension.ryugraph.io` on first use. **This is the only part of egr that reaches the network** — every other command works offline. The error now prints the offline build steps; see also `docs/CLI.md` |

If you hit something not covered here, please check
[predictable-labs/ryugraph's issues](https://github.com/predictable-labs/ryugraph/issues)
before assuming it's an EngramGraph bug — most native-loading failures originate in the
`ryugraph` dependency, not this package.

### Dependency vulnerability warnings (`npm audit`, deprecated packages)

A plain `npm install` — global, `npx`, or as a project dependency — currently prints
warnings like this:

```
npm warn deprecated npmlog@6.0.2: This package is no longer supported.
npm warn deprecated are-we-there-yet@3.0.1: This package is no longer supported.
npm warn deprecated gauge@4.0.4: This package is no longer supported.
npm warn deprecated tar@6.2.1: ...widely publicized security vulnerabilities...
4 high severity vulnerabilities
```

All four trace back to a single chain: `ryugraph` (this package's embedded graph-DB
engine) pins `cmake-js@^7.3.0`, which depends on `tar@^6.2.0` (several high-severity
path-traversal CVEs, fixed in `tar@7.5.11`+) and the now-deprecated `npmlog`/`gauge`/
`are-we-there-yet` stack. `cmake-js@8.0.0` already dropped `npmlog` and bumped `tar` to
`^7.5.6` — the fix exists upstream, `ryugraph` just hasn't picked it up yet. Tracked at
[predictable-labs/ryugraph#49](https://github.com/predictable-labs/ryugraph/issues/49).

**Actual exposure is narrower than the warning count suggests.** `ryugraph`'s own
`install.js` only invokes `cmake-js` (and therefore `tar`) when no prebuilt native binary
exists for your platform — see the platform support matrix above. On every platform
listed there as `✅ Works`, the prebuilt binary is copied directly and `cmake-js`/`tar`
are fetched into `node_modules` but never executed. The declared vulnerability is real
(and shows up in `npm audit`/SBOM tooling regardless), but the live exploitation window is
effectively limited to build-from-source paths (unsupported platforms, or
`NPM_CONFIG_BUILD_FROM_SOURCE` set explicitly).

**If you consume `engramgraph` as a dependency inside your own project** (not a global
install), you can clear this yourself today — add the same override to *your own*
`package.json`:

```json
"overrides": {
  "cmake-js": "^8.0.0"
}
```

(npm-only syntax shown; pnpm/Yarn have equivalent `pnpm.overrides` / `resolutions`
fields.) This works because npm's `overrides` field only takes effect at the root of
whichever project runs `npm install` — it does **not** propagate from a dependency's own
`package.json` to yours, which is exactly why `engramgraph`'s own `overrides` entry (added
in an earlier fix) doesn't help you: it only cleans `npm audit` inside this repo's own
source checkout, not for anyone installing the published package. For a global install or
`npx engramgraph` there is no project root to attach an override to, so that path has no
workaround available yet — it depends on the linked upstream issue landing.

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

EngramGraph ships an MCP server (stdio) exposing 8 tools — `index_code`,
`index_docs`, `call_chain`, `impact_analysis`, `ingest_feedback`, `implementers`,
`implemented_specs`, `related` — so any MCP-capable assistant can use it as a
code + knowledge graph. Zero LLM, deterministic, **no Docker**.

```bash
# Claude Code, from an installed package:
claude mcp add egr -- npx egr-mcp
```

Full setup (Claude Code / Codex / Cursor / Windsurf), all 8 tools, and an
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
8 relationship tables — `CALLS`, `IMPORTS`, `DEFINES`, `IMPLEMENTS`, `IMPACTS`,
`SUPERSEDES`, `RELATES`, `REFERENCES`. See **[docs/API.md](./docs/API.md)** for the
full DDL and the front-matter schema that drives knowledge ingestion.

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
