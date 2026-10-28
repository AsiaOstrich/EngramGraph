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

### `index <dir> [--docs] [--clean] [--scip <path>] [--incremental [--changed-from <git-ref>]]`

Recursively indexes source files under `<dir>` into the **code graph**
(tree-sitter → `Function` / `Class` / `Module` nodes + cross-file `CALLS`).
With `--docs`, also indexes `*.md` files into the **knowledge graph**
(front-matter → `Spec` / `Decision` + `IMPACTS` / `SUPERSEDES`).

- Which document is which id (`--docs`): a document is a spec or decision when
  its front-matter `id`, its filename, or its first `#` heading **starts with**
  `XSPEC-`, `SPEC-`, `DEC-`, `ADR-` (or `XADR-`) followed by a number or a name.
  Punctuation before the id in a heading is ignored (`# [XSPEC-476] Fix`), a word
  before it is not: `# Deploy SOP (ADR-006)` is about ADR-006, it is not ADR-006.
  When several documents claim one id, the front-matter `id` wins over the
  filename, which wins over a heading; the smaller path decides a tie. The others
  are left out of the graph (their links too) and each conflict is printed in the
  summary and listed under `knowledge.conflicts` with `--json`.
  That is within one run. Across runs — `egr index dirA --docs --clean`, then
  `egr index dirB --docs`, both holding `ADR-903` — the later document still
  overwrites the earlier one (the rule is unchanged), but the run says so: a
  `knowledge: WARNING — ADR-903 was indexed from <dirA path> by an earlier index
  and is now overwritten by <dirB path>` line, and an entry in
  `knowledge.conflicts` with `reason: "replaced-from-earlier-index"`, the `kind`
  (`Spec`/`Decision`), `previous.path` and `current.path` (absolute real paths — a symlinked directory and its target are the same file, so indexing through one and then the other does not warn). The
  graph remembers the path in `Spec.path` / `Decision.path`; indexing the same
  file again is not a conflict, and a node with no recorded path (indexed by an
  earlier egr, or only ever a `[[ref]]` stub, or written by MCP `index_docs`,
  which is given no path) is overwritten without a warning. The first `egr`
  command of this version that opens a graph made by an earlier one **for
  writing** (for example `index`, `feedback`, `related`, `god-nodes`; read-only
  queries and the MCP server never migrate) adds the two columns in place and
  keeps a one-time backup beside it (`<graph>.pre-migration-backup`), as with
  every column added before. Next to the backup sits a small
  `<graph>.pre-migration-backup.pending-columns` file listing the columns that
  backup was taken to protect, so a retried migration reuses it instead of
  copying the database again; delete both together once you no longer need the
  backup.
- Code extensions: `.ts .tsx .js .jsx .mts .cts .mjs .cjs .cs .py .go .java
  .kt .kts .rs .cpp .cc .cxx .hpp .h .hh .rb .php .dart` (`.d.ts` excluded).
- Skipped directories: `node_modules`, `dist`, `.engram`, `.git`, `coverage`,
  `bin`, `obj`, `__pycache__`, `.venv`, `venv`, `vendor`, `target`, `build`.
  This list is fixed: `.gitignore` is **not** read. A generated or vendored
  directory under another name (e.g. `packages/`) is indexed like any other.
- `--clean`: drop the graph's data before indexing. Indexing is otherwise an
  upsert (MERGE) that never deletes, so a node removed from the code lingers;
  `--clean` rebuilds from scratch to prune it.
- `--incremental`: parse only the files whose **content** changed since the last
  `--incremental` index, and write only the difference. Changed means a different
  sha256 of the source text — not mtime, which a grammar upgrade or a
  time-preserving checkout leaves untouched. The graph ends up the same as
  `egr index <dir> --clean` over the same sources (nodes and edges alike), and a
  deleted, renamed-away or newly `--exclude`d file leaves the graph. CALLS are
  resolved across files, so an **unchanged** file's edges can move too — `b.ts`
  calls `foo`, and `a.ts` (changed) now defines a second `foo`: the name is
  ambiguous and `b.ts`'s edge goes; or `a.ts` now defines `newFn` which `b.ts`
  calls: the edge appears. That is handled by keeping, per file, the few facts
  the resolution reads (function names, call records, import targets) in
  `<graph>.incremental-state.json` next to the graph, and running the same
  resolution over the old and the new facts; only the difference is written.
  Unchanged files are not parsed, and a function that still exists in a changed
  file is updated in place, so SAGE `confidence` survives. The summary says what
  was done: `incremental: 4 file(s) parsed (3 changed, 1 new), 5 reused
  unchanged, 1 removed; …` (`incremental.reparsed` etc. with `--json`). On the
  egr repository itself (210 files), a full rebuild took about 26 s and an
  incremental index after editing 3 files about 0.4 s.
  **It indexes in full instead — and prints the reason — when** it is the first
  `--incremental` run; egr or a tree-sitter grammar version differs from the one
  that wrote the state (so a grammar upgrade re-parses everything); the graph was
  indexed again without `--incremental` since (the state is tied to the
  manifest by a token); the graph holds fewer files than the state remembers; or
  another root of the same graph holds a file with the same relative path (the
  Module id is the relative path, so the node is shared). Plain `egr index`
  without `--incremental` behaves exactly as before. Not supported with `--scip`
  (refused); `--docs` still indexes every document. A graph built earlier by plain
  `egr index` runs may hold leftovers a plain index never prunes and the state
  cannot know about: start from an empty graph, or add `--clean` once
  (`egr index <dir> --incremental --clean` rebuilds and starts the state).
- `--changed-from <git-ref>` (with `--incremental`): take the list of changed
  files from `git diff <ref>` (tracked files that differ in the working tree)
  plus untracked, non-ignored files, instead of hashing every file. It states
  that the graph describes `<ref>`; files git lists are compared by hash, files
  it does not list are taken as unchanged. A ref that is not what was indexed
  gives a wrong graph — leave the flag out and every file is hashed, which is
  always correct. An unknown ref is an error (exit 1) that names it.
- `--exclude <glob>` (repeatable): keep matching paths out of the index, for
  code and for `--docs` alike. It exists because the skip list above is fixed
  and `.gitignore` is not read — a project root that holds `.uds-backup-*`
  directories would otherwise count every backup document. The summary always
  says what it kept out (`excluded: N file(s) in M path(s) matched --exclude …`),
  including `nothing matched` when a pattern is mistyped. With several patterns
  each is also reported on its own (`excluded: "zzz-*" — nothing matched; …`,
  and `excluded.byPattern` with `--json`: `pattern`, `paths`, `files`,
  `nothingMatched`), so a typo cannot hide behind a pattern that matched plenty;
  a path two patterns both cover counts for both. Patterns are matched
  against the path relative to `<dir>`, `/`-separated on every OS: `*` any
  characters except `/`, `**` any characters including `/`, `?` one character,
  `{a,b}` either, `[abc]` one of. A pattern with no `/` matches an entry's name
  at any depth (`.uds-backup-*`); a `/` at the start or in the middle anchors it
  at `<dir>` (`docs/archive/**`, `/logs`). A trailing `/` means directories only
  and does **not** anchor: `logs/` excludes every directory named `logs` at any
  depth (`api/logs` too); `/logs/` excludes only `<dir>/logs`. A leading `./` is
  dropped, so `./logs/` is not anchored either. Excluding a directory excludes
  everything under it. The patterns of the last run are recorded per root in
  the parse-health manifest, and `refs check` leaves those paths out when it
  searches the git history.
  **Windows Git Bash** rewrites an argument that starts with `/`:
  `--exclude "/logs/"` reaches `egr` as `C:/Program Files/Git/logs/`, which
  matches nothing. Put `MSYS_NO_PATHCONV=1` in front of the command
  (`MSYS_NO_PATHCONV=1 egr index . --exclude "/logs/"`), or write `//logs/`
  (Git Bash passes it on as `/logs/`), or `logs/` (no leading slash, any
  depth). A pattern that starts with a Git install path and matched nothing is
  reported with this reason on its `nothing matched` line (and as `hint` in
  `excluded.byPattern` with `--json`). *Not run on Windows by the author of this
  note:* egr's side is tested (a pattern given in the rewritten form matches
  nothing and gets the hint; `//logs/` and `/logs/` exclude the same directory);
  that `MSYS_NO_PATHCONV=1` and `//` stop Git Bash's rewriting is the consumer's
  report and Git for Windows' documented behaviour.

```bash
egr index ./src
egr index . --docs
egr index ./src --clean   # rebuild, pruning deleted nodes
egr index ./src --incremental   # re-parse only what changed since the last --incremental run
egr index ./src --incremental --changed-from origin/main   # CI: git says what changed
egr index . --docs --exclude ".uds-backup-*" --exclude "docs/archive/**"
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
- A graph DB whose `CALLS` (or `Function`/`Class`) table predates a schema
  change like this one's `provider`/`confidence` columns is migrated
  **automatically and non-destructively** the moment an `egr` command opens it
  for writing (read-only queries never migrate): missing columns are added in place via `ALTER TABLE ... ADD` (existing
  rows keep every other property they already have), after first checkpointing
  and backing up the DB file to a `.pre-migration-backup` sibling (never
  overwriting a prior backup). No `--clean`, no deleting the DB file required
  to stop hitting the schema error — `--clean` still only deletes row data via
  `DETACH DELETE`, never table schema, but that's no longer the mechanism that
  closes this gap. When a migration actually runs, `egr` prints a one-line
  notice on stderr naming the column(s) added and the backup path.
  `Function.provider`/`Class.provider`/`CALLS.provider` are backfilled to
  `"tree-sitter"` on migrated rows (a known historical fact, not a guess —
  tree-sitter was the only extraction provider before these columns existed),
  so a plain `egr index` re-index right afterwards fully un-freezes them; a
  `CALLS` edge's `confidence` is deliberately left `NULL` (we don't know which
  resolution tier a historical edge was), so a SCIP overlay's ability to
  *upgrade* that specific edge still needs one such plain re-index first. This
  does NOT change the separate, pre-existing fact that a plain re-index resets
  `Function.confidence` (SAGE's feedback-adjusted score) back to its `1.0`
  default regardless of migration — this feature only prevents that value
  from being destroyed by the migration itself, not by ordinary re-indexing
  after it. See `src/graph-db/schema-migration.ts` for the full mechanism and
  its documented limits.
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

A symbol the graph does not contain is an **error** — exit `1`, `no function
named "X" is in the graph`, with near names when there are any — not `(none)`.
`(none)` with exit `0` means the function is in the graph and nothing calls it.
(Through 0.12.0 both printed `(none)` and exited `0`.)

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

Prints `before → after`. An id/label the graph does not contain is an error
(exit `1`, `no Function node with id "X" is in the graph`).

### `top <label> [--limit N]`

Highest-confidence nodes of a label, confidence-descending.

- `<label>`: `Function` | `Spec` | `Decision` | `Doc`.
- `--limit`: default 10, clamped to `1..1000`.

```bash
egr top Function --limit 20
egr top Decision --json
```

### `communities [--limit N] [--include-unclustered] [--json]`

Function-call clusters (Louvain over `CALLS` edges), one row per member with
its `communityId`. On a real project that is every function in the graph —
megabytes of `--json`. `--limit N` keeps the **N largest communities**, each
with all of its members (largest first on ties, the smaller community id);
it counts communities, not rows, because half a cluster is not a cluster. The
text output says `showing the N largest of M communities` when it cut
something. `N` must be a positive whole number.

A function with no `CALLS` edge (nothing calls it, it calls nothing) belongs to
no community; the engine labels all of them `-1`. On a real project that was
1,813 functions, which came out as the largest "community" and filled every
`--limit`. They are therefore **not a community**: not counted by `--limit` or
in `M`, and **not listed** unless you pass `--include-unclustered` (then they
are marked `unclustered`, `communityId` `-1`). Their number is always reported:
the last line of the text output is `unclustered: N function(s) have no CALLS
edge and belong to no community`.

`--json` prints a report, not a bare array (changed in 0.13.0-beta.5):

```json
{
  "communities": [{ "id": "…", "label": "Function", "name": "ringOne", "communityId": 0 }],
  "communityCount": 2,
  "shownCommunities": 1,
  "unclustered": { "count": 3, "listed": false }
}
```

`communities` holds the rows as before (with `--include-unclustered`, the
`-1` rows too); `communityCount` is the real communities in the graph and
`shownCommunities` how many of them `communities` holds. Needs the ALGO
extension (see below).

```bash
egr communities --limit 5 --json
egr communities --limit 5 --include-unclustered
```

### `refs check <path...> [--json]`

Check file-path and symbol/function references (in backticks) inside
Markdown files or directories — memory notes, CLAUDE.md/AGENTS.md, any
`.md` — against the graph and `git`. Read-only: it does not modify the
graph or the files it checks (see EGR README, ["What EngramGraph does not
store"](../README.md#what-engramgraph-does-not-store) — this is a checker,
not a second memory store). Each reference gets one of four answers, never
guessed:

- `present` — still resolves.
- `moved` — the file/symbol is in the graph or on disk, at a different
  location. Rename detection uses `git log --diff-filter=R -M`; a plain
  file not in the graph at all (a config file, a doc) is still checked this
  way.
- `missing` — not found in the graph, and no rename was found either.
- `unresolvable` — not enough information to say present or missing (e.g.
  the reference names a repo this graph was never told to index — never
  reported as `missing`, which would be a false claim of certainty).

Extraction is deliberately conservative: only backtick-quoted tokens are
considered, a bare word with no path shape or `(...)` call shape is not
extracted at all, and same-named functions in different files are reported
as candidates rather than guessed at.

A call-shaped token is checked as a symbol only in the form `name()` or
`a.b()`. One that contains whitespace, an operator character
(`+ - * % < > = ! & | ^ ~ ? : , ;`) or anything between its parentheses —
`Sum(SendCnt)`, `min(x, y)`, `Count(a) + Count(b)` — is an expression quoted
from some other language, not a symbol of the repository: it is reported
`unresolvable` and nothing is searched for it. A `missing` symbol names the
commit where its definition last changed, and that commit contains the
definition text.

A symbol is `missing` only when its definition is found in the git history of
a place the index could have looked at. History under the fixed skip list
(`dist`, `build`, `vendor`, `node_modules`, …), in minified files (`*.min.*`)
and under the `--exclude` patterns the root was last indexed with (recorded in
the parse-health manifest) does not count: a front-end bundle's
`date:function(t){…}` is not evidence that PHP's `date()` was ever a function of
the repository. Names that belong to a language or its standard library (PHP
`date`, `count`, `trim`; JavaScript `parseInt`, `map`; C# `ToString`; Python
`len`; the list is `src/cli/builtin-functions.ts`) and that the graph does not
define are `unresolvable`, with the reason, and the history is not searched for
them — a project that defines its own `count` is answered by the graph as usual.
The price is stated, not hidden: a repository function that really was deleted
and shares such a name is reported `unresolvable`, not `missing`. A `missing`
symbol's reason ends with `(defined in <path>)` — the file, relative to the
index root, whose diff in that commit holds the definition — so the reader can
judge it.

**Exit status**: `1` when any reference is `missing` (the full report is still
printed), `0` otherwise — `unresolvable` never fails the run. Until 0.13.0 the
status was `0` either way.

```bash
egr refs check MEMORY.md
egr refs check ./notes --json
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

### `doctor`

What this installation can actually do on this machine — the first thing to run
when a language is missing from your graph.

```bash
egr doctor
egr doctor --json
```

Reports the egr/Node version and platform, the graph DB path, every language
with whether its native module loaded (and the reason if it did not), which
native dependencies this platform had to compile from source, whether any
command will need network access **on this machine**, and the MCP registration
command.

The network line is worked out from what is on disk, not from a fixed list.
`god-nodes`, `communities` and `related` need ryugraph's ALGO extension; it
normally comes from the `@asiaostrich/engramgraph-algo-<platform>` package that
`npm install` brings with `engramgraph`, and is loaded by path with no download.
`doctor --json` has `algo.source` (`bundled-package` | `user-cache` | `download`
| `undetermined`), `networkStatus` (`none` | `needed` | `undetermined`) and
`networkCommands` (empty unless a download is needed). On a platform where it
cannot tell, it says so rather than guessing.

It does not open the graph, so it still answers when the graph is missing or
unreadable — which is when people run it.

> **Why this is a command and not an install-time message.** It was one, and it
> reached nobody: npm suppresses lifecycle-script output by default and npm ≥ 11
> gates those scripts behind an approval prompt, so the notice appeared zero
> times on a real `npm install -g`. A command you type cannot be suppressed by
> a package manager.

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

> **MCP caveat**: the MCP server binds to one graph path at startup (it logs the
> path to stderr). It does **not** follow a later `git checkout` — reconnect/restart
> the server (or launch it with `--graph` / `ENGRAM_ISOLATION`) to switch. It does
> not hold the graph open between queries, so `egr index` and the other terminal
> commands work while it is running (see [MCP.md](./MCP.md)).

## CI example

```bash
export ENGRAM_DB="$PWD/.engram/graph.db"
egr index ./src --docs
# Fail the job if a high-risk symbol gained new callers, query with --json, etc.
egr callers paymentGateway --depth 3 --json > callers.json
```

## Exit codes

`0` on success; `1` on error (the message is written to stderr as
`egr: <message>`). Errors include a graph that another process holds locked and
an input the graph does not contain — a symbol (`callers`, `callees`), a spec id
(`impact`, `implementers`), a node id (`feedback`, `related`) or a module path
(`implemented-by`). Through 0.12.0 several of these printed a message and exited
`0`; scripts that relied on that must now handle exit `1`. `(none)` with exit `0`
always means "it is in the graph and has no results".
