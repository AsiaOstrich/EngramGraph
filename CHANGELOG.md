# Changelog

All notable changes to `engramgraph` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`egr callers` / `egr callees` and the MCP tool `call_chain` say when a name is shared by several functions, and `--file` / `file` asks about one of them** (XSPEC-514 R1, dev-platform#64). `callers` matches a function by name, so `render` defined in two files had the callers of both in one list that read like the callers of one function. The answer is not refused; it now says what it is made of. This labels the list, it does not make the list more accurate: the callers of both functions are still in it unless you ask for one with `--file`. **Text:** a line before the rows, `⚠ merged: "render" is defined 2 times (a/render.ts:2, b/render.ts:2); this answer combines all 2. Narrow it to one with --file <path>.` **`--file <path>` / MCP `file`** asks about the definition(s) in that file only (callers reached through `--depth` too); `./`, an absolute path or a trailing part is enough when it fits exactly one definition file, and the answer then says `narrowed to the definition at a/render.ts:2 (1 of 2 definitions of "render")`. **A file that holds no definition of the symbol is an error, never an empty list**: exit `1` (MCP `isError: true`) naming the files that do define it, `"render" has no definition in "x.ts" — this is not the same as "nothing calls it"`; a trailing part that fits several files is refused the same way and lists them. A file that defines the name more than once (two classes with a `paint` method) cannot be split by a file; the answer says `a file cannot tell them apart` and `mergedDefinitions` stays above 1. `callees` follows the same rules, and MCP `file` narrows `callers` and `callees` alike. **Compatibility:** a name with one definition prints exactly what it printed before, and MCP `call_chain` only gains fields (`definitions: [{ id, file, startLine }]`, `mergedDefinitions`, and `file` when asked); the REST `POST /graph/call-chain` and the embedded `callChain()` gain the same two fields and do not take `file` yet. **CLI `--json` is still the bare array, always**: an array cannot carry "this combines 2 functions", and scripts parse it (this repository's own release verifier does), so the merged statement is written to **stderr** in the same words as the text output; a script that discards stderr does not see it, and `call_chain` over MCP is the way to get `definitions` as data. Not in this change: ranking or tiering of the callers, and merging with `cochange`.

- **`egr lint <dir>` and the MCP tool `lint`: two ways the replacement relations of your spec/decision documents disagree with themselves** (dev-platform DEC-140). When a document says it was replaced but the graph does not know, an answer to "which decisions sit behind this spec?" treats the replaced one as live, and nothing notices. `egr lint docs/` reports (1) **`superseded-without-declaration`**: a document whose front-matter `status` begins with `Superseded` or `Replaced` (or `已取代` / `被取代`; `Deprecated` is not on the list) while **no document declares `supersedes: <its id>`** in its front matter (declarations are compared, not graph edges: between two specs there is no `SUPERSEDES` edge, so comparing edges would report every superseded spec); and (2) **`live-cites-superseded`**: a document whose status is live that still cites, as part of its basis (the `IMPACTS` or `DECISION_RELATES` edge `egr index --docs` would build for the reference), a decision that is superseded (a scanned document declares `supersedes` for it, or its own status says so). It reads the same Markdown documents `egr index <dir> --docs` reads (same walk, `--exclude`, id rules and parser), in memory: **no model, no network, the graph is not opened or written**, so it works with no `.engram/graph.db` and while another process holds it. **A status is the front-matter `status`, else the first status line before the first `## `** (`> **狀態**: X`, `**狀態**：X`, `- **Status**: X`, a table row `| **狀態** | X |`; full- or half-width colon; leading symbols such as `✅` dropped, a qualifier like `Superseded（被 DEC-9 取代）` kept; the front matter wins when both exist; a line inside a code fence or after the first `## ` is not a status), and each finding says which it read (`statusSource`). Only `lint` reads the body line: `egr index` and the graph still store the front-matter `status`. **Findings do not block: when every document was judged it exits 0, findings or not. A status it cannot read is not a pass:** a document with no status is counted as `無法判定 (cannot determine)` (not judged either way, listed in `--json` `undeterminable`), and when any document could not be judged, or no spec/decision document was found, `egr lint` prints the full report, says `無法判定` on stderr and **exits 1 (as `cochange` does), findings or not**; the MCP tool returns an error result with the report. Exit 1 with no report means it could not run (no `<dir>`, not a directory). `--json` carries `status` (`findings` | `undetermined` | `clean`), `undeterminedReason` whenever the answer is incomplete, the denominators (`scanned`), the status words read as superseded, and every finding with the file, the ids and the reason. The stdio MCP server now offers **10 tools** (14 on a writable connection). Internal: `parseKnowledgeDoc` now also returns the document's `status` and `bodyStatus`, and the edge a reference becomes is decided by one exported function, `edgeForRef`, used by both `ingest` and `lint`; no graph schema or `egr index` output changes.

- **`egr cochange <file>` and the MCP tool `cochange`: which files changed together with this one, from the local git history** (XSPEC-514 R2). The call graph cannot see a file that has to change with another for a reason no call expresses (a test, a document, a schema, a sibling module); the history can. It lists the files that were committed together with `<file>`, most often first, with how many commits it counted: `egr cochange src/model.py --limit 5`, or `egr cochange --json -- -odd-name.py` for a name that starts with a dash. It reads only `git` (no model, no network) and **does not open the graph**, so it works with no `.engram/graph.db` and while another process holds it. **The rules, all stated in the answer:** it looks at the last `--commits` (default 200) **non-merge** commits that touched the file and **skips a commit that changed more than `--max-files` (default 30) files** (a sweep says nothing about which files belong together; exactly 30 is used); the result carries `commitsExamined`, `commitsUsed` and `commitsSkippedLarge`. **Renames are not followed** (`renamesFollowed: false`): a rename is a delete and an add, so history before it stays under the old name. A shallow clone is reported (`shallow: true`, counts are lower bounds) and its boundary commit, which git shows as adding every file, is left out. **Cannot determine is an answer, an empty list is not:** outside a git work tree, with no commit that touches the file, with `git` missing, failing or not finishing within 60 s, or when every commit that touched the file was skipped, `egr cochange` prints `無法判定 (cannot determine) — <reason>` on stderr and exits 1 (with `--json`, stdout also carries `{ "status": "undetermined", … }`); the MCP tool returns an error result with the same text. `(none)` with exit 0 means the file has usable history and nothing else ever changed with it. **Each row says whether the path is still in `HEAD`** (`existsAtHead` in `--json`, `(not at HEAD)` in the text), from one `git ls-tree` for the whole answer: a deleted file and the old path of a renamed file are `false` (expected, since renames are not followed), they are still listed, counted and ranked; if the tree cannot be listed the field is `null` (not known), never a default. The git calls take the path after `--` and as a literal path (a name that starts with `-`, or holds `*`, is a file), ignore the `GIT_DIR`-style variables a hook exports, and are killed at the timeout. The stdio MCP server now offers **9 tools** (13 on a writable connection). `callers` is unchanged and its output does not include co-change; merging the two signals is a later step that waits for a validation on commits the experiment did not use. On one repository, the two files this ranks first, added to the call graph's answer, raised the F1 on 40 later commits from 0.20 to 0.23 (experiment 3): a signal to read next to the call graph, not yet a measured improvement across repositories.

### Changed

- **A decision that only mentions another decision no longer replaces it** ([#19](https://github.com/AsiaOstrich/EngramGraph/issues/19)). `egr index --docs` used to write a `SUPERSEDES` edge for every Decision → Decision reference, whatever it came from: a decision listed under `related:` of another, or linked with `[[DEC-x]]` in its body, was recorded as replacing it, so "what does this decision replace?" answered with plain mentions and impact chains that follow `SUPERSEDES` reached decisions that were never replaced. Now each reference remembers where it was written, and **only the `supersedes` front-matter field (exactly that spelling, lower case) builds `SUPERSEDES`**. Every other Decision → Decision reference (`related`, `depends_on`, `impacts`, `impacted_by`, `implements`, or a `[[ref]]` in the body) becomes a new **`DECISION_RELATES`** edge (`Decision` → `Decision`, 9th relationship table; an existing graph gets the table the next time a command opens it for writing). A decision named under both `related:` and `supersedes:` is a replacement, once. Spec → Spec (`RELATES`), Decision ↔ Spec (`IMPACTS`) are unchanged. `egr index --json` and the MCP `index_docs` result gain `decisionRelates` beside `supersedes`, and the summary line prints `N decision-relates`. **If your decision documents say "supersedes" only in prose, as in `supersedes [[DEC-1]]` in the body, they no longer produce a `SUPERSEDES` edge: put the id in the `supersedes:` field.** **Existing graphs heal on the next plain `egr index <dir> --docs`**, without `--clean` (which would also reset SAGE's learned confidence): re-indexing a decision now replaces that decision's own outgoing `SUPERSEDES` / `DECISION_RELATES` edges with what its document says today, which also removes an edge whose reference was deleted from the document. Only decisions whose document was read in that run are rewritten, so indexing one directory leaves the edges of decisions elsewhere alone; an old wrong edge from a decision whose document is not re-indexed stays until it is. Multi-line YAML lists under a field (`supersedes:` followed by `- DEC-1` lines) are still not read, as before: write the list on one line, `supersedes: [DEC-1, DEC-2]`.

### Fixed

- **What a command or `egr serve` wrote no longer stays only in `graph.db.wal`** (risk `egr-graph-lives-only-in-wal`: a 4096-byte `graph.db` that opened alone with `Table Function does not exist`, while the 11.9 MB `.wal` was the whole graph; deleting the `.wal`, or backing up `graph.db` alone, lost it). A command that finishes normally has folded the log into `graph.db` since 0.13.0 (a CHECKPOINT before exit) and still does. Three paths did not, and now do: (1) **a command that fails after it has written**, such as `egr index <dir> --scip missing.scip`, whose code pass is already in the graph when the missing file ends the command with exit 1; (2) **`egr serve`**, which writes through `POST /graph/ingest` and runs until it is stopped: on SIGINT or SIGTERM it now folds the log into `graph.db` and exits 0 (it used to be killed with the log unfolded); (3) **a CHECKPOINT that itself fails** (disk full, I/O error) after the command has done its work no longer turns a successful command into exit 1 or hides what it printed: it prints `egr: warning: could not fold the write-ahead log into graph.db (…)` on stderr and keeps the command's exit status. A **lock refusal** at that step still fails the command, as before (it is how a command that never touched the file learns it did not hold the write lock). **The MCP server is unchanged: it has nothing to fold.** It has opened the graph read-only for the length of one query since 0.13.0, a read-only connection cannot write, and a stopped server leaves no log and no lock; a test now pins this. To check a graph yourself: copy `graph.db` alone (without `graph.db.wal`) to another directory and run `egr top Function` on the copy with `ENGRAM_DB` pointing at it.

## [0.14.1] - 2026-10-30

> **Stable Release**: the same content as 0.14.1-beta.2 below, which passed the Windows release verification (run 40998498315) and the cross-platform compatibility check (run 40998237287). Skips git linked worktrees, keeps nested function names local, and names the real reason `--incremental` re-indexes after an upgrade; see 0.14.1-beta.1 and beta.2 for the details.

## [0.14.1-beta.2] - 2026-10-30

*Preview of the reason `--incremental` gives after an upgrade, found by the Windows verification of 0.14.1-beta.1 ([#17](https://github.com/AsiaOstrich/EngramGraph/issues/17), [#18](https://github.com/AsiaOstrich/EngramGraph/issues/18)). Published to the `next` dist-tag. Nothing else changes from 0.14.1-beta.1 below, and the incremental-state version stays 2.*

### Fixed

- **`egr index --incremental` says why when the incremental state file is there but cannot be used** ([#17](https://github.com/AsiaOstrich/EngramGraph/issues/17)). After upgrading from 0.14.0 the first run indexed in full, as it should, but printed "no incremental state yet (the graph was built without --incremental, or the state was lost)" although a valid version-1 state from 0.14.0 was present, which sends a user who did use `--incremental` looking for a mistake they did not make. The reason now names the cause: `incremental state was written by an older egr (state version 1, now 2)`, `… by a newer egr (state version 3, now 2) and this egr cannot use it` (after a downgrade), or `the incremental state file could not be read (it is damaged or is not a state file)`. The original sentence is kept for a state file that really is absent. The same text appears in the summary line and in `incremental.reason` of `--json`. What the run does is unchanged: it indexes in full and writes a fresh state.

### Documentation

- **Windows: upgrading while `egr-mcp` is running** ([#18](https://github.com/AsiaOstrich/EngramGraph/issues/18)). `docs/MCP.md` now says what happens (Windows cannot delete the loaded `ryujs.node`, so npm leaves `%APPDATA%\npm\node_modules\.engramgraph-*` behind with an EPERM warning, and the running server keeps serving the old version), and what to do: close Claude Code or the MCP client before upgrading, delete the leftover directory afterwards, and compare `egr --version` with the `serverInfo.version` and the `doctor` tool's `egrVersion` that the server reports about itself. Those two already existed; a test now pins them. No code changed for #18, so a server started before an upgrade is still not told to restart: that is the client's job, and the version it reports is how you see it. `docs/CLI.md` lists the new reasons.

## [0.14.1-beta.1] - 2026-10-30

*Preview of two index-correctness fixes (linked worktrees, nested function names) and the release-gate fixes below. Published to the `next` dist-tag for the Windows release verification. Upgrading resets the incremental-index state (STATE_VERSION 1 to 2), so the first `--incremental` run after it indexes in full.*

### Changed

- **`egr index` no longer walks into git linked worktrees under the index root.** A linked worktree (`git worktree add`, which Claude Code's agents leave behind as `.claude/worktrees/agent-*`) is a second full checkout of a repository that is already being indexed. Walked, every function in it exists twice, so a call to a name that now has two definitions is "ambiguous" and its edge is dropped. Measured on dev-platform's graph: 2,052 of 5,384 indexed code files (38%) were copies in three such worktrees; excluding them removed 11,722 duplicate nodes and wrote 2,884 call edges that had been lost. A directory is a linked worktree when its `.git` is a **file** whose `gitdir:` line points at `.git/worktrees/<name>`. The summary now says what it skipped (`skipped: 3 git worktrees not walked (…; N file(s)) — … absent from every count above`) and `--json` carries `skippedWorktrees: { paths, files }`; `--docs` skips the same directories. **Not affected:** an index root that is itself a linked worktree is indexed as before (the check is made only on subdirectories); a **submodule** (`.git` file pointing at `.git/modules/<name>`) is a different repository's code and is still walked, as before; a directory with a `.git` directory (a nested clone) is still walked. **If you indexed a worktree copy on purpose** from inside its parent, index that directory as its own root. `--incremental` treats the files of a directory that has become a worktree as removed. A user `--exclude` pattern that already names the directory keeps counting it under `excluded:` rather than `skipped:`.

### Fixed

- **A function declared inside another function no longer takes over its name for the whole file and for every other file** (JS/TS and every other language with nested function definitions). The file's bare-name table kept the last definition of a name, so a nested `foo` declared after a top-level `foo` replaced it: another file's `foo()` was bound to the nested one (`b.ts#caller -> a.ts#bar.foo`, measured), and so was a top-level caller in the same file. A nested function is now local: only calls made from inside its enclosing function (innermost scope first) bind to it. Methods of a class are unaffected. A nested function that nothing else defines is no longer reachable by its bare name from other files, so such calls are counted as unresolved rather than bound to it. `--incremental` state written by an earlier egr (it remembered the leaked names) is not used: the first `--incremental` run after upgrading indexes in full.
- **Python `self.run()` does not bind to `_run()` or `Run()`** was checked and **egr does not have this fault**: call names are matched exactly, case and underscores included. No code changed; the check is kept as regression tests (`test/call-binding-names.test.ts`).
- **The cross-platform compatibility check now starts after the publish succeeded, instead of racing it** (`.github/workflows/release-compat-check.yml`). It was triggered by the same `release: published` event as `publish.yml` and waited for the package with a 10-minute registry poll; `publish.yml` now runs the coverage suite before `npm publish` (11m50s measured on 0.14.0-beta.2), so the poll gave up first and v0.13.1 and v0.14.0-beta.2 were never platform-tested (every matrix job skipped, "Package never reached npm"). It is now triggered by `workflow_run` of "Publish to npm", proceeds only if that run succeeded, tests the tag that run shipped (never `latest`), and says in its own run when it was skipped because the publish failed. `workflow_dispatch` with a version is unchanged. Tooling only; the npm package is unchanged. Note that `workflow_run` is read from the default branch, so this takes effect from the first release cut after the merge.
- **`.husky/pre-commit` starts with a shebang** (`#!/usr/bin/env sh`). Husky 9 runs the hook with `sh -e` whatever its first line says, so commits behave as before; editors and shell linters no longer treat the file as having no interpreter. A test now requires every hook under `.husky/` to start with one.
- **`egr refs check` no longer answers confidently from a parse-health manifest it could not read.** The list of indexed roots comes from `<graph>.parse-manifest.json`. When that file existed but was cut off, was not JSON or had the wrong shape, the check took it as "no roots" and carried on: in a graph with several roots, a reference into another root could come out `missing`, and nothing in the output or the exit status said the list had never been read. A damaged manifest now puts an `INCOMPLETE` line first in the report, writes the reason to stderr (also under `--json`, whose stdout stays the JSON alone), adds `incompleteReasons` to the JSON result and to the MCP `refs_check` result, and makes the command exit 1. A graph with **no** manifest file is the ordinary single-repo case and is unchanged: no warning, exit 0.

## [0.14.0] - 2026-10-29

> **Stable Release**: the same content as 0.14.0-beta.3 below, which passed the Windows release verification including the new incremental-indexing steps (run 40886344099). Adds `egr index --incremental` and separate ids for index roots that share a relative path; see 0.14.0-beta.1 for the features.

## [0.14.0-beta.3] - 2026-10-29

*Same package content as 0.14.0-beta.2. The Windows release verification now exercises incremental indexing and roots that share a relative path ([#14](https://github.com/AsiaOstrich/EngramGraph/pull/14)); a stable 0.14.0 must match a preview verified with it, so this preview exists to be that one. Published to the `next` dist-tag.*

## [0.14.0-beta.2] - 2026-10-29

*Same features as 0.14.0-beta.1, which was never published to npm: its release run stopped at the coverage threshold, because the new tests ran the CLI as a child process that v8 coverage does not count. This version adds in-process unit tests for incremental indexing (`incremental.ts` 4.67% → 100% lines) and makes PR CI run `test:coverage` too ([#13](https://github.com/AsiaOstrich/EngramGraph/pull/13)). Published to the `next` dist-tag for the Windows release verification.*

## [0.14.0-beta.1] - 2026-10-29 [not published to npm]

*Preview of incremental indexing. Published to the `next` dist-tag for the Windows release verification; a stable 0.14.0 follows only after that verification passes.*

### Added

- **`egr index --incremental` parses only the files whose content changed and ends with the graph a full rebuild gives** (XSPEC-508 R6). On the egr repository itself (210 files) a full rebuild took about 26 s; an incremental index after editing 3 files took about 0.4 s, and its graph was identical to the `--clean` rebuild of the same sources (2,321 nodes and edges compared). "Changed" is a sha256 of the source text, not mtime. Calls are still resolved across the whole project from small per-file facts kept in `<graph>.incremental-state.json`, so an UNCHANGED file's edges follow a name that became ambiguous, was newly defined or was deleted in another file. Deleted, renamed-away and newly excluded files leave the graph; a function that still exists is updated in place, so SAGE confidence survives. The first run, a changed egr or tree-sitter grammar version, a graph indexed again without `--incremental`, or nodes an older egr wrote for one relative path of two roots (see Fixed) indexes in full and prints the reason. `--changed-from <git-ref>` takes the changed files from `git diff` instead of hashing every file. **Default behaviour is unchanged:** `egr index` without `--incremental` is exactly as before; `--incremental` is opt-in and refused with `--scip`. `egr index --json` gains an `incremental` object (`mode`, `reason`, `reparsed`, `reused`, `changed`, `added`, `removed`, …); the parse-health manifest section gains an optional `incrementalToken`. Library: `extractProjectDetailed` (per-file facts and a parsed/reused count) is exported beside `extractProject`, which behaves as before.

### Fixed

- **Two index roots of one graph that both hold the same relative path (`src/index.ts` of three of dev-platform's seven roots) were ONE Module node, and made `--incremental` index in full every time** (XSPEC-508 R6, decision 134乙). The Module id is the file's path relative to its root, so the second root's `index.ts` was merged onto the first one's node: the functions of both files sat under one Module, same-named functions were one Function node, and call edges of both roots attached to the same ids. Nothing refused it and nothing showed it. A file now keeps its plain path as its id **unless another root of the same graph already holds that id**; then it is indexed as `<last two segments of its root>/<path>` (`asiaostrich-telemetry-server/src/index.ts`). The summary prints an `ids:` line and `egr index --json` gains `rootQualifiedIds`. Calls and imports are still resolved within one root, as before: a call to a name only another root defines is not an edge, with or without the collision. **Migration:** none for a graph with one root, or roots that never share a path: every id is exactly as before, nothing is rebuilt, SAGE confidence stays. An id is recorded in the parse-health manifest (`files[].id`, only when it differs from the path; `rootLabel` per section) and kept for as long as its file stays in the index, so the root indexed first keeps the plain path and a graph rebuilt in another order can get other ids. A graph an **older** egr built from roots that share a path still holds one mixed node for it and egr cannot unmix it: `egr index` prints a `WARNING` (`--json`: `sharedNodes`), `--incremental` indexes in full and says so, and one rebuild (`egr index <dir> --clean`, or dev-platform's `index-all.sh --clean`) gives the roots separate ids. `egr blindspots` and the "possibly incomplete" note now name and match a qualified file by its graph id. The MCP `index_code` tool has no root: what it recorded is not counted as another root, so re-indexing a file through it still updates the node `egr index` wrote. `--scip` is refused, before anything is written, for a root that has qualified files: the overlay builds ids from the plain relative path and would attach edges to the other root's nodes.
- **`egr index --incremental` of one root no longer discards the other roots' incremental state.** The state file holds every root's remembered facts; an incremental run deleted the whole file before editing the graph, so after it every other root of the graph indexed in full once. It now drops only its own root's section (a crash in the middle still leaves that root, and only that root, without state).

## [0.13.1] - 2026-10-24

> **Stable Release**: the same content as 0.13.1-beta.1 below, which passed the Windows release verification. Security fixes only; `src/` is unchanged since 0.13.0.

## [0.13.1-beta.1] - 2026-10-24

*Security-only preview. `src/` is unchanged since 0.13.0; only dependency declarations, the lockfile, the READMEs and the release tooling changed.*

### Security

- **`@modelcontextprotocol/sdk` floor raised from `^1.30.0` to `^1.32.2`, and the lockfile refreshed** ([#10](https://github.com/AsiaOstrich/EngramGraph/pull/10)). `npm audit` on 0.13.0's lockfile reported 1 critical (proxy-addr) and 15 high (the SDK x3, body-parser, fast-uri x5, nanoid x2, postcss, source-map-js, vite, zod); after the change it reports 0 high or critical. Raising the floor means a project that already holds an older lockfile is pulled past the fixed SDK versions on its next update.
- **Installing engramgraph no longer installs `tar@6.2.1` (critical) or `cmake-js@7` (high).** `ryugraph@25.9.1` declares `cmake-js ^7.3.0`, every cmake-js 7.x depends on `tar ^6`, and no newer ryugraph exists. engramgraph now depends on [`@asiaostrich/ryugraph@25.9.1-asiaostrich.1`](https://github.com/AsiaOstrich/ryugraph/tree/asiaostrich/v25.9.1), a repack of upstream's own 25.9.1 tarball with the same engine binaries and `cmake-js ^8.0.0`, declared as the npm alias `"ryugraph": "npm:@asiaostrich/ryugraph@…"` so the install path and imports are unchanged. The `cmake-js` override in `package.json`, which only ever cleaned this repo's own tree, is removed, and so is the `tar` entry in `security/accepted-advisories.json`, so `npm run audit:ship` fails if tar comes back. engramgraph returns to upstream `ryugraph` once a fixed release exists.

## [0.13.0] - 2026-10-22

> **Stable Release**: everything in 0.13.0-beta.1 through beta.5 below, plus the changes since beta.5 listed in this section.

### Fixed

- **`egr index --scip` matches a `.scip` file written on Windows** ([#3](https://github.com/AsiaOstrich/EngramGraph/issues/3)). `scip-dotnet` run on Windows writes `\` into `Document.relativePath` although SCIP requires `/`, so no file under a subdirectory matched and the error told the user to change `<dir>`. Document paths are now normalized on the index itself, and the error says separators are not the cause.

### Documentation

- **The 0.13.0-beta.5 upgrade note said "the first command" migrates an old graph; only a command that opens it for writing does** (0.13.0-beta.5 Windows consumer retest, 2026-10-19). Read-only queries (`top`, `callers`, `blindspots`, `signatures`, …) and the MCP server open the graph read-only and never migrate — unchanged since beta.3 ("Read-only `openGraph` neither creates nor migrates"). The migration happens at the first `index`, `feedback`, `related`, `god-nodes` or other writing command. `docs/CLI.md` (and its zh-TW and zh-CN translations) now say so.
- **The `<graph>.pre-migration-backup.pending-columns` file next to the backup is documented.** It lists the columns the backup was taken to protect, so a retried migration reuses the backup instead of copying the database again (`src/graph-db/schema-migration.ts`). Delete it together with the backup.

## [0.13.0-beta.5] - 2026-10-13

*Fixes for the new findings in the 0.13.0-beta.4 Windows consumer report (XSPEC-481).*

### Fixed

- **`egr refs check` no longer calls a language's built-in function, or a definition found only in a bundle, `missing`** (R1; since beta.4 a `missing` fails the exit status, so this was a CI failure). The report: a document cited PHP's `date()`, and `refs check` said `missing` with a commit whose only link to `date` was `date:function(t){…}` inside a front-end bundle. Now:
  - history under the fixed skip directories (`dist`, `build`, `vendor`, `node_modules`, …), in minified files (`*.min.*`) and under the `--exclude` patterns the root was last indexed with is not evidence that a symbol once existed. The `--exclude` patterns are now recorded per root in the parse-health manifest (`runs[root].exclude`); a graph indexed before this release has none recorded until its next `egr index`, so only the fixed rules apply to it;
  - a name that belongs to PHP, JavaScript, C# or Python (`date`, `count`, `trim`, `parseInt`, `ToString`, `len`, …; one list, `src/cli/builtin-functions.ts`) and that the graph does not define is `unresolvable`, with the reason, and the history is not searched for it. A project that defines its own `count` is answered by the graph as before. **The price, on purpose:** a repository function that really was deleted and shares such a name is now `unresolvable`, not `missing`. Method names that projects commonly give their own functions (`get`, `add`, `remove`, `update`, `find`, `parse`, `Select`, `Count`, a list's `append`, …) are deliberately not on the list;
  - a `missing` symbol's reason ends with `(defined in <path>)`: the file (relative to the index root) whose diff in that commit holds the definition, so the reader can judge it. Not available when the history output was too large to read and git was asked one name at a time.
  Covered by `test/xspec481-r1-refs-check-noise.test.ts` (built CLI against a real git repository; the named commit is read back with `git show`).

### Added

- **`egr index --docs` says when it takes an id over from an earlier index** (R4). `egr index dirA --docs --clean` followed by `egr index dirB --docs`, both holding `ADR-903`, silently let the second replace the first (the beta.4 notes list it as a known limitation). The overwrite rule is unchanged — the later document wins — but the run now prints `knowledge: WARNING — ADR-903 was indexed from <path A> by an earlier index and is now overwritten by <path B> …`, counts it in the summary (`1 replaced a copy from an earlier index`), and lists it under `--json` `knowledge.conflicts` with `reason: "replaced-from-earlier-index"`, `kind`, `previous.path` and `current.path` (the entries for ids claimed twice within one run now carry `reason: "duplicate-id"`). To compare anything the node has to remember where it came from, so `Spec` and `Decision` have a new column `path` (the absolute path the document was read from). **What that means on upgrade:** the first command of this version that opens a graph made by an earlier one adds the two columns in place and keeps a one-time backup beside it (`<graph>.pre-migration-backup`), with a line on stderr — the same mechanism as every column added before; nothing needs re-indexing. A node indexed before that has no path, so the first re-index cannot warn about it. Indexing the same file again is not a conflict. MCP `index_docs` takes no path, so it neither records one nor warns. Paths are recorded and compared by real location (`realpath`; as written when the file no longer exists): the same file indexed once through a symlinked directory (as `cross-project/index-all.sh` does) and once through its real path is one document and does not warn, and the paths named in a warning are the real ones. A path stored before that is compared by its real location too. Covered by `test/xspec481-r4-replaced-docs.test.ts` (built CLI; the paths and the winning title are read back, including from a graph made with the beta.4 schema).
- **`egr index --exclude` says why a pattern that Git Bash rewrote matched nothing** (R5). On Windows, Git Bash turns an argument that starts with `/` into a path under the Git install: the beta.4 help's own example `--exclude "/logs/"` reached `egr` as `C:/Program Files/Git/logs/`, matched nothing, and the summary said only `nothing matched; check the pattern`. A pattern that starts with a drive-letter path through a `Git` directory and matched nothing now gets, on that line (and as `hint` in `excluded.byPattern` with `--json`), the reason and the way out: put `MSYS_NO_PATHCONV=1` in front of the command, write `//logs/`, or `logs/`. The help, `docs/CLI.md` and the READMEs say the same. **Not run on Windows:** this was written on macOS. egr's half is tested (the rewritten pattern given literally matches nothing and gets the hint; `//logs/` and `/logs/` exclude the same directory); that `MSYS_NO_PATHCONV=1` and a leading `//` stop Git Bash's rewriting is the consumer's report and Git for Windows' documented behaviour, to be confirmed on the next Windows run. Covered by `test/xspec481-r5-msys-hint.test.ts` (built CLI).

### Changed

- **Breaking for MCP clients that call them: the read-only stdio server no longer lists `index_code`, `index_docs`, `ingest_feedback` and `related`** (R3). `tools/list` returned 12 tools and these four answered every call with a read-only refusal, so an assistant's first try at indexing or ranking was a call that could not work. Over stdio — `egr-mcp` and `egr mcp` — `tools/list` now has the 8 tools that read (`call_chain`, `impact_analysis`, `implementers`, `implemented_specs`, `blindspots`, `signatures`, `doctor`, `refs_check`); calling one of the four by name is "not found"; and the server's `instructions` (sent at `initialize`) name the terminal command that does each job — `egr index <dir>`, `egr index <dir> --docs`, `egr feedback <type> <node-id>`, `egr related <seed-id>` — all of which work while the server is running. A server created on a writable connection (`createMcpServer(conn)`, embedding) still has all 12. The README and `docs/MCP.md` now say which mode has which tools. **Consequence for earlier notes:** the 0.13.0-beta.4 line "MCP `index_docs` returns `knowledge.conflicts`" holds only for a server that offers `index_docs`; the stdio server does not. `scripts/windows-release-verify.mjs` step 6 now passes both when `related` is refused (releases up to beta.4, and `latest`) and when it is not offered (this release), and still fails when it is offered and answers. Covered by `test/xspec481-r3-mcp-readonly-tools.test.ts` (built stdio server and a real MCP client: the list, then every listed tool called), `test/mcp-diagnostics.test.ts` and `test/windows-release-verify.test.ts`.
- **Breaking (`--json` only): `egr communities --json` prints a report object instead of a bare array** (R2). Functions that have no `CALLS` edge (1,813 of them on the reporting project) used to be labelled community `-1`, which was always the largest and filled every `--limit` — `--limit 3` still printed 2,486 lines (558 KB). They are not a community: `--limit` and the "N of M communities" count now leave them out, they are **not listed** unless `--include-unclustered` is given (then marked `unclustered`), and their number is always reported — the text output ends with `unclustered: N function(s) have no CALLS edge and belong to no community`, and `--json` is `{ communities, communityCount, shownCommunities, unclustered: { count, listed } }`, the rows being under `communities`. A script that read the array must read `.communities`. Covered by `test/xspec481-r2-communities-unclustered.test.ts` (built CLI; indexed fixture with two real communities and three isolated functions).

## [0.13.0-beta.4] - 2026-10-12

*Fixes for the new findings in the 0.13.0-beta.3 Windows consumer report (XSPEC-476).*

### Fixed

- **`egr refs check` could crash or never answer when it looked up a symbol that is in the graph** (affects earlier releases that have `refs check`; found by CI hanging twice before this beta was published). The lookup asked the graph two questions at once on one connection (`Promise.all` over "is it a Function" and "is it a Class"), and the engine does not survive two statements in flight on one connection: about one process in twenty died with SIGSEGV or stayed silent forever (measured on Linux: 21 of 480 runs; 0 of 960 when the same two queries ran one after the other). `GraphConnection.query` now runs statements one at a time in the order issued, whoever calls it, and `close()` waits for the statement that is running. Covered by `test/xspec476-refs-hang.test.ts`.
- **`CHANGELOG.md` is in the published package** (R1). 0.13.0-beta.3 went out without it while the README tells the reader to look there for what changed — which in this release included exit codes. `package.json` `files` now lists it. Covered by `test/packaging.test.ts`, which builds the tarball npm would publish and reads its file list.
- **The MCP server reports the package version** (R5a). `serverInfo.version` in the `initialize` answer was the constant `0.1.0`; it is now the installed `engramgraph` version, so a client's server list and a bug report name the real release. Covered by `test/xspec476-r5-small-fixes.test.ts` (built stdio server, real MCP client).
- **A document is a spec or decision only when its heading *starts with* the id; documents sharing an id no longer overwrite each other within one run** (R2; present since 0.12.0). The rule applies to the documents of a single `egr index --docs` run (or one `index_docs` call); two separate runs over different directories still MERGE into the same node, the later one winning (0.13.0-beta.5 keeps that rule but prints a warning, see R4 there). On a real project a runbook titled "ADR-008 時區重構：Runbook" replaced the genuine ADR-008, a document titled "Unattended Deploy SOP (ADR-006)" became ADR-006, and the `--docs` summary said 6 specs / 20 decisions while the graph held 4 / 12, because two documents with one id were both counted and the last one written won. Now:
  - the first `#` heading names a document only when it begins with the id (punctuation in front is ignored: `# [XSPEC-476] Fix`); the front-matter `id` and the filename are unchanged;
  - when several documents claim one id, the front-matter `id` wins over the filename, which wins over a heading; the smaller path decides a tie, so the result does not depend on directory order. The documents set aside add no node and no links;
  - the summary prints one `knowledge: WARNING — <id> is claimed by N documents; kept … set aside …` line per conflict, `--json` carries them as `knowledge.conflicts`, and MCP `index_docs` returns the same field (only on a server that offers `index_docs` — the stdio server does not, see 0.13.0-beta.5). The counts are taken after this resolution, so they equal the nodes in the graph.
  Covered by `test/xspec476-r2-doc-ids.test.ts` (built CLI `egr index --docs` and `egr top`, built MCP `impact_analysis` for the titles).
- **`egr index --exclude` reports each pattern on its own, and the help states the trailing-slash rule that is actually implemented** (R3). With `--exclude "zzz-nomatch-*" --exclude "docs/deployment/**"` the summary showed one total and the pattern that matched nothing was invisible. Now each pattern gets a line (`excluded: "zzz-nomatch-*" — nothing matched; check the pattern`), `--json` carries `excluded.byPattern` (`pattern`, `paths`, `files`, `nothingMatched`), and a path that two patterns both cover is counted for both — including files under a directory another pattern already excluded. The help said a pattern containing `/` is anchored and a trailing `/` "means directories only"; in fact a trailing `/` does **not** anchor, so `logs/` excluded `api/logs/` as well. The rule is now written as it behaves: `/` at the start or in the middle anchors, `logs/` matches at any depth, `/logs/` only `<dir>/logs`, and a leading `./` is dropped. Covered by `test/index-exclude.test.ts` (built CLI).
- **`egr refs check` no longer reports an expression as a missing reference** (R4). `` `Sum(SendCnt)` `` and `` `min(x, y)` `` came back `missing`, each with the hash of an unrelated commit, because the search for a *definition* of `Sum` found some line shaped like `Sum(…) {` in history. A call-shaped token now counts as a symbol only as `name()` or `a.b()`; one that contains whitespace, an operator character (`+ - * % < > = ! & | ^ ~ ? : , ;`) or anything between its parentheses is `unresolvable`, and neither the graph nor the history is searched for it. A genuinely deleted symbol is still `missing`, with the commit where its definition last changed. Covered by `test/xspec476-r4-refs-check.test.ts` (built CLI against a real repository; the commit is read back with `git show`).
- **`egr refs check` asks the history in batches** (R5c). It ran `git log` once per `missing` path (to name its last commit) and, per symbol and per index root, a `git log -G` scan of the whole history — 12 files, 213 references, 75 seconds on the reported project. The last commit of every path now comes out of the one `git log --name-only` the run already makes, and the definition search covers all of the run's symbols in one `git log -G` per root (split only to stay under the command-line length limit). The number of `git` processes a run starts no longer depends on the number of references: the test records every `git` call of a 24-reference run and of a 2-reference run and finds the same count (28 → 4 on that fixture). The commit named for a symbol is still the newest one whose diff has a line defining *that* symbol — attributed by testing the diff's lines against each symbol's own pattern, not by taking git's first hit for the joined pattern — and a symbol no line defines gets no commit. Covered by `test/xspec476-r5-small-fixes.test.ts` (built CLI with a preload that logs git calls).

### Added

- **`egr communities --limit N`** (R5b). The command printed every function in the graph with its community — 1.3 MB of `--json` on a real project. `--limit N` keeps the N **largest communities**, each with all its members (ties to the smaller community id). It counts communities, not rows, because half a cluster is not a cluster; the text output says `showing the N largest of M communities` when it cut something, and `N` must be a positive whole number. Without `--limit` nothing changes. Covered by `test/xspec476-r5-small-fixes.test.ts`.

### Changed

- **Breaking: `egr refs check` exits `1` when any reference is `missing`** (R4). It used to exit `0` whatever it found, so a script could not stop on it. The report is printed in full as before (and `--json` is unchanged); the exit status is the only difference, plus a one-line note on stderr. `unresolvable` does not fail the run. A script that ran `egr refs check` and only wanted the report must tolerate `1` (or add `|| true`). The MCP `refs_check` tool is not affected.
- **`egr refs check` no longer checks a call with arguments as a symbol** (R4). `` `checkRefs(conn, paths)` `` was looked up by its name and could come back `present` or `moved`; it is now `unresolvable` (an expression). Write `` `checkRefs()` `` to have the symbol checked.
- **A heading that only mentions an id no longer names the document** (R2). A document that was recognised only because its title *contained* an id further along (`# Deploy SOP (ADR-006)`, `# Notes on SPEC-5`) is now unnamed: it leaves the graph and is counted under `unnamed` in the summary. If it should be that artifact, give it a front-matter `id:` or name the file after it.

## [0.13.0-beta.3] — 2026-10-12

*Beta on npm `next`; `latest` stays 0.12.0 until the beta has been tested. Two output corrections found while trying beta.2 (XSPEC-457 R6, R7). Neither changes an exit code.*

### Fixed

- **"Did you mean" only offers names that resemble what you typed** (R6). `egr callers NoSuchFunctionXyz` on a real graph answered *"Did you mean: n, t, T, u, on?"*: a one-letter name is a substring of almost any query, so the hint matched on that and offered names with nothing in common with the input, which reads as a broken tool. A candidate now has to be at least half as long as the longer of the two names, and an edit-distance match may change fewer than half the characters of the shorter one. When no name is that close, the "Did you mean" sentence is left out and only the "not in the graph" explanation remains. One rule serves every symbol-, spec- and module-keyed query, in the CLI (`callers`, `callees`, `impact`, `implementers`, `implemented-by`) and over MCP (`call_chain`, `impact_analysis`). Covered by `test/xspec457-r6-r7.test.ts` (CLI and MCP stdio).
- **`egr index <dir> --docs` no longer lists the documents it indexed as "unindexed"** (R7). A directory holding one spec `.md` got the spec into the graph and, in the same summary, `unindexed: 1 source file(s) seen but not covered by any supported language — top extensions: .md (1)`, which reads as if the document had not been indexed. With `--docs`, a file the document pass took in no longer counts as unindexed (`unindexedCode` in `--json` follows); other unindexed files stay listed. Without `--docs` nothing indexes a `.md`, so it is still listed, as before.

## [0.13.0-beta.2] — 2026-10-09

*Beta on npm `next`; `latest` stays 0.12.0 until the beta has been tested. Replaces 0.13.0-beta.1, which overflowed the stack on any unexpected error inside an MCP tool (below). Windows: run `.github/workflows/windows-release-verify.yml` by hand.*

### Fixed

- **MCP: an unexpected error no longer loses its message** (affects `0.13.0-beta.1` only). The shared error handler of the MCP server (`failFrom`, added in beta.1 with R1) answered `NotInGraphError` and `GraphBusyError` but, for any other error, called itself. A corrupt graph file, an engine or SDK exception or a plain bug therefore overflowed the stack, and the agent read *"Right-hand side of 'instanceof' is not an object"* instead of the cause. Every such error now comes back as an error result (`isError`) carrying the original message. Releases before beta.1 did not have this handler and are not affected. Covered by `test/mcp-unexpected-error.test.ts`, which drives all nine graph-opening tools through a real MCP client with a graph source that throws.

## [0.13.0-beta.1] — 2026-10-09

*Beta on npm `next` (`npm install -g engramgraph@next`); `latest` stays 0.12.0 until this beta has been tested. Verified on Windows by `.github/workflows/windows-release-verify.yml` (run by hand; it does not start on publish): 14 of 14 steps passed on 2026-10-09 (run 37821840964), after the verifier itself was fixed to recognise the new MCP refusal wording.*

*Fixes for the five problems in the 0.12.0 Windows 11 report (XSPEC-457). Two of them change exit codes — read "Changed" before upgrading a script.*

**A running MCP server no longer stands between a terminal and the graph.**

The 0.12.0 entry below says that with the MCP server running, "a full `egr index` all work[s]". It did not, on any platform. The engine takes its lock when the file is **opened**, not when something is written, so a server that held the graph read-only for as long as the editor was open refused every writer for that whole time: `egr index`, `egr feedback`, `egr god-nodes`, `egr communities` and `egr related` all exited 1 with `Could not set lock on file` (reproduced on macOS, reported on Windows 11). Only read-only terminal queries ran alongside it.

### Fixed

- **MCP opens the graph per query, read-only, and closes it** (R1). Nothing is held between queries, so every terminal command works while the server is running, on every platform, and the server's next query sees what the command wrote — no restart. Overlapping tool calls share one open (eight overlapping opens of one file in a process died with `Mmap … failed`). A query that meets a writer retries for about 5 s (`ENGRAM_LOCK_WAIT_MS`) and then answers *"the graph … is being written by another process … this is not an empty result"* — never an empty result. Cost: one open and close per tool call, measured at 21 ms against 1.4 ms on a small graph and 49 ms against 24 ms on a 2,300-function graph.
- **A write command leaves nothing for the next open to replay** (R1). `egr index` and the other commands that open the graph for writing now checkpoint before exiting. The write-ahead log used to stay behind and be replayed on every open: with per-query opens that was 245 ms per query on a 4 MB log, against 49 ms once folded.
- **The MCP refusal for `index_code` / `index_docs` / `ingest_feedback` / `related` works on every platform** (R1): it names the terminal command and says that command works while the server is running, which is now true.
- **`related` no longer swallows the failure of its first write** (R2). A bare `catch` around dropping the previous projection hid any error that was not "no such projection".
- **`egr doctor` says whether *this machine* needs network** (R3), from where the ALGO extension would actually come from (`algo.source`: the platform package, ryugraph's cache, a download, or undetermined), not from a fixed list that named `god-nodes`, `communities` and `related` on machines where all three worked offline. Where it cannot tell, it says so.
- **`egr callers X` for an `X` the graph does not contain says so** (R4) instead of printing `(none)` — the same words as a real function nobody calls. The same for `callees`, `impact`, and MCP `call_chain` / `impact_analysis`. MCP `call_chain` results now carry `symbolFound: true`.
- **`egr index --exclude <glob>`** (R5), repeatable. A project root holding `.uds-backup-*` directories had every backup document counted into `--docs`. The summary reports how many files and paths the patterns kept out, and says `nothing matched` for a pattern that matched nothing. See `egr --help` and `docs/CLI.md` for the pattern language.

### Changed

- **Exit codes (R2, R4) — these were `0` and are now `1`:**
  - `egr callers <symbol>` and `egr callees <symbol>` for a symbol the graph does not contain (was: `(none)`, exit 0);
  - `egr impact <spec-id>` for a spec id the graph has not seen (was: `(none)`, exit 0);
  - `egr implementers <spec-id>` for a spec id the graph has not seen (was: a message, exit 0);
  - `egr implemented-by <path>` for a path that matches no indexed module, or several (was: a message, exit 0);
  - `egr feedback <type> <id>` for a node that is not there (was: `node not found`, exit 0);
  - `egr related <id>` for an id that is not in the graph (was: `(none)`, exit 0).
  
  `(none)` with exit `0` now always means "it is in the graph and has no results". With `--json` these cases print nothing on stdout and the error on stderr, like `egr top BogusLabel`. A script that relied on exit `0` for a missing name must handle `1`.
- **A write command's own lock failure now ends in exit 1 even when it had nothing to write** (R2): after its work, a command that opened the graph for writing checkpoints, which forces the lock to be taken and used. The lock error now also says who may hold it.
- MCP `doctor` / `egr doctor --json` gain `networkStatus` and `algo`; `networkCommands` is empty when nothing needs a download.
- The MCP server no longer requires the graph to exist at startup; each query says "No graph at …" until `egr index` has run.

## [0.12.0] — 2026-09-18

*Release candidates rc.1–rc.5 shipped on npm `next` between 2026-08-11 and 2026-09-18; entries below marked (rc.N) arrived in that candidate. Verified on Windows by `.github/workflows/windows-release-verify.yml` — hosted Windows, no C++ toolchain, the ALGO download host blocked.*

**Two `egr` processes touching one graph did not refuse each other — they destroyed it.**

Every command opened the graph for writing, even a pure query, because opening runs `initSchema`. The engine is single-writer, and writer-versus-writer is not a clean refusal: measured on a real graph, one process wins, the rest are refused, and the database is left answering `Trying to create a vector with ANY type` to everything afterwards. It is unrecoverable except by rebuilding, and the message says nothing about what happened.

This was reachable in ordinary use. An editor's MCP server holds the graph for as long as the editor is open; a `post-commit` hook or a shell-startup freshness check indexes in the background; you run `egr` in a terminal. Any two of those overlapping was enough.

### Added

- **C, Swift and Bash** (rc.5) (XSPEC-414 R2–R4). Functions, structs/unions/enums, and `#include`-derived module relationships for C; functions, classes/structs/enums/protocols and extensions (attributed to the type they extend, including across files) for Swift; function definitions, calls and `source`/`.`-derived module relationships for Bash, with external commands (`grep`, `echo`, ...) never entering the graph. `egr doctor` now lists all three. `.h` routes to C++ when the same indexing run has a C++ source file alongside it, and to C otherwise (previously always C++).
- **`egr index` follows an extension-less shebang script** (rc.5) (`#!/bin/bash`, `#!/usr/bin/env sh`, XSPEC-414 R4) and indexes it as Bash, instead of counting it as an unsupported file.
- **A new `IMPORTS` (Module → Module) relationship** (rc.5), resolved from C's `#include` and Bash's `source`/`.` against the files in the same indexing run; `egr index`'s summary and `--json` output report the count.

- **The algorithm extension installs with the package** (rc.4). `god-nodes`, `communities` and `related` need ryugraph's ALGO extension, which until now was downloaded from `extension.ryugraph.io` on first use — so on a network that cannot reach it they did not work at all. It now ships prebuilt as `@asiaostrich/engramgraph-algo-<platform>`, an optional dependency npm installs only on the matching platform, and loads from there with no network and nothing written to your home directory. Platforms: Windows x64, Linux x64, macOS arm64 and x64. Linux arm64 is not included: ryugraph's own `linux-arm64` engine file is currently an x86-64 binary (predictable-labs/ryugraph#48), so there is nothing correct to build against. Everywhere else, the download still works as before.
- **`egr index` names what it skipped** (rc.4). Files with an extension no grammar handles are counted and reported by extension in the summary and in `--json` (`unindexedCode`), instead of silently lowering the file count.
- **`egr index` says what to do next** (rc.4) when most calls did not resolve (points at `--scip`) and when documents were found but none were recognised as specs or none are implemented in code (states the naming rule and the `// implements` comment).

### Fixed

- **An existing graph could stop opening at all after the extension file moved** (rc.4). Loading the extension writes its absolute path into the graph's write-ahead log, which is replayed on every open; egr exits without a checkpoint, so the record stayed. After a Node version switch, a reinstall, or a cleared `~/.ryu`, every command on that graph — including ones that never use the extension — failed with `Failed to load library`. 0.11.0's download path had the same defect. egr now checkpoints right after loading. A graph already in that state opens again once the file is back at the path in the error.
- **MCP `index_code` parsed files with no grammar as JavaScript** (rc.4), producing plausible and wrong nodes. They are now skipped and reported.
- **Git-branch isolation followed the caller's `GIT_DIR`** (rc.4) instead of the directory it was given, whenever one was set in the environment — as it is inside every git hook.
- **`--help` and the CLI docs state that the skip list is fixed and `.gitignore` is not read** (rc.4); the help text is generated from the list itself.

### Changed

- **Query commands open read-only** — `callers`, `callees`, `implementers`, `implemented-by`, `impact`, `top`, `blindspots`, `signatures`. (`god-nodes`, `communities` and `related` were on this list in rc.2 and are not: they load the algorithm extension and build a projected graph first, and both are writes. Corrected in rc.3; this entry was not.) A read-only open can be refused; refusal is all it can do. Measured: five concurrent read-only opens all succeed and the graph is intact; a writer and a reader refuse each other cleanly with the graph intact; only writer-versus-writer corrupts.
- **The MCP stdio server holds the graph read-only.** Held for writing, it made every terminal `egr` command fail for as long as the editor was open. Verified end-to-end: with the server running, `top`, `implementers`, `blindspots` and a full `egr index` all work.
- **`index_code`, `index_docs` and `ingest_feedback` over MCP now refuse by name** and point at the CLI equivalent, rather than failing at a lower layer with a lock error an assistant cannot act on.
- **Read-only `openGraph` neither creates nor migrates.** Both are writes. A missing graph now says so and names `egr index`, instead of silently producing an empty one.

## [0.11.1] — 2026-08-11

**`XADR-` matched nothing, and the warning added two releases ago is what found it.**

### Fixed

- **`XADR-NNN` ids are now recognised**, classified as decisions alongside `ADR-NNN` — the same pairing `XSPEC`/`SPEC` already had. Alternation is leftmost-wins, so `ADR` appearing first meant `XADR-001` could only match its trailing `ADR-001` — and `\b` forbids a word boundary inside `XADR`, so it matched *nothing at all*. Three cross-project ADRs had been silently absent from the graph that indexes them.

  Found by `unresolvedIdClusters` (0.10.0), on the repository that wrote it: three upper-case files sharing a refused prefix is exactly the shape that trigger exists for, and this is its first real find.

## [0.11.0] — 2026-08-11

**An agent could be told the answer might be incomplete, and had no way to ask what was missing.**

`indexHealth.possiblyIncomplete` has been attached to MCP query results since 0.8.0, but the three commands that answer the follow-up question — `blindspots`, `signatures`, `doctor` — existed only in the CLI. So an assistant receiving that flag could relay it to a human and stop. Surfacing health to a machine consumer is pointless if the next question has no tool.

### Added

- **`blindspots`** (MCP) — files that parsed partially or failed, from the parse-health manifest. The natural follow-up to `indexHealth.possiblyIncomplete`. Carries `manifestPresent`, because `blindspots: []` alone cannot distinguish "nothing wrong" from "nothing was ever measured".
- **`signatures`** (MCP) — the same files grouped by root cause rather than listed one by one; turns "584 files" into "1 problem".
- **`doctor`** (MCP) — which languages are available and why any are not, what was compiled on this machine, which commands need network. Does not open the graph, so it still answers when indexing itself is what is broken.

Started without a `manifestPath`, `blindspots` and `signatures` return an explicit error saying so — not an empty success. A tool that cannot see must not return the same shape as a tool that looked and found nothing.

## [0.10.1] — 2026-08-11

**Both fixes here are for damage 0.10.0 did, and both were found by the person it was released for.**

### Fixed

- **`egr` was unusable on Windows for anyone with an existing graph.** 0.10.0 adds a column to three tables, so the first open migrates — and the migration backed up the database file while the engine still held it open, failing with `EBUSY: resource busy or locked, read` and leaving zero-byte backups. `backup.ts` had already switched to `openSync` for Windows share flags after an earlier `EBUSY … copyfile` report; that was necessary and insufficient, because share flags decide who may *open* a file and do not defeat a byte-range lock the engine holds. The migration now closes the connection before copying and reopens afterwards. If the backup fails for any other reason, the message names the database, the pending columns, the cause, and two ways out — instead of five words.

- **The warning built to prevent noise emitted thirty-one lines of it.** The unresolved-prefix warning fired against a skills library whose files are named topic-first (`language-options.md`, `bdd-workflow.md`, `testing-pyramid.md`) — none meant to be a spec, and the specs it exists to find were already indexed correctly. Artifact id conventions are near-universally upper case; topic naming is lower case. Matching the prefix case-sensitively took that repository from 31 warnings to 2, both of them real. Samples are de-duplicated (one run reported the same filename three times, being three directories deep), and at most three clusters are reported.

  Trade-off on the record: a project naming specs `Spec-Login.md` now gets no hint. Under-reporting is the right failure — one missed hint costs a search, thirty-one spurious ones cost the reader's attention permanently, including for the warning that would have mattered.

## [0.10.0] — 2026-08-11

**A user's 44 specs were dropped without a word, and every empty answer this tool gave looked exactly like every other one.**

`egr index . --docs --clean` printed `knowledge: 0 specs`. The specs were named `SPEC-EXTERNAL-AUTH`, `SPEC-LOGIN` — semantically, not numbered — and the id pattern required digits, so every document was discarded before becoming a node. No error, no count, nothing to distinguish "44 documents we could not name" from "this repo has no specs". Nine ADRs came through, because they happened to be numbered. Finding the cause took a long bisect.

Underneath it was the same shape in a dozen places: `(none)` meant four different things, a symlinked directory vanished from the file count *and* from the denominator so `blindspots` reported all-clear over it, and a corrupted parse-health manifest rendered identically to a clean bill of health. This release is mostly about making those answers different from each other.

### Added

- **Semantic spec ids.** `SPEC-EXTERNAL-AUTH`, `DEC-BOUNDARY` and similar are now recognised alongside numeric ones. Numeric ids are matched **first and stop at their digits**, so `XSPEC-373-index-result.md` still resolves to `XSPEC-373` and does not swallow the description — existing repos are unaffected.
- **`@SPEC` and `@implements` as implementation markers**, alongside the original `implements`. `@tag` is the Javadoc/JSDoc/XML-doc convention, and no widening of the id pattern helped while this gate only accepted one bare word.
- **A denominator on the knowledge summary** — `(45 doc(s) scanned, 44 unnamed)`. When a prefix is refused repeatedly, it is named with samples: a convention this tool does not know, as opposed to a README, which is simply not a spec.
- **`origin` on Spec/Decision/Doc nodes** — `declared`, `annotated` or `referenced`. A spec asserted only by a `[[ref]]` is no longer indistinguishable from one somebody wrote, and a real document now wins over a stub **in any index order** (it previously depended on which directory was walked last).
- **Skipped and unreadable inputs are reported**: directory symlinks are named and stated to be outside every count, and a file that cannot be read is recorded instead of aborting the whole index.

### Changed

- **`implementers` answers four situations differently**: the id is not in the graph; it exists only because something linked to it; it is known from code but its document was never indexed; or it is real and nobody implements it. Each sends you somewhere different.
- **`implemented-by` accepts the path you have** — absolute, `./`-prefixed, Windows-separated, or a bare filename resolved by unique suffix — and distinguishes "indexed, declares nothing" from "not in the graph". An ambiguous path reports the ambiguity rather than guessing.
- **Index health says when it cannot tell.** An unreadable manifest now prints `index health unknown … this result is unannotated, not verified` instead of the empty string it shared with a healthy graph.
- **`egr top <label>` validates its argument**, case-insensitively, instead of passing it to the database and surfacing a binder exception.

### Fixed

- **Every ordinary `egr index` reset SAGE's accumulated confidence to 1.0.** The extractor re-stamped its starting value on each run, and a same-provider write was unconditionally allowed to overwrite. No rename or migration needed — just re-indexing an unchanged file.
- **A directory symlink was neither walked nor recorded**, so its files were missing from the graph *and* from the file count; `egr blindspots` then reported everything it could see as clean, which it was.
- **A document could take its id from any prose inside it**, or from a directory above it. Resolution is now front-matter → filename → first heading, in that order, trying each until one classifies.
- **Feedback on a node that had never been judged started from maximum confidence** rather than neutral.
- **Comment capture is now asserted per grammar** rather than trusting one shared list of node-type names — the list had silently swallowed Dart's `///` once before.

## [0.9.1] — 2026-08-04

**The 0.9.0 install notices reached nobody, and the release gate that found that out had itself only just started working.**

0.9.0 added a platform preflight to `preinstall` and an MCP registration hint to `postinstall`. On a real `npm install -g engramgraph` — no `--foreground-scripts`, the command people actually type — both appeared **zero times** in 242 lines of output. npm suppresses lifecycle-script output by default, and npm ≥ 11 additionally holds those scripts behind an approval gate, so on a fresh machine they may not run at all. Every test of them passed throughout, because each invoked the hook the way it was written rather than the way anyone installs.

This is the same shape as the C# grammar bug 0.9.0 fixed, applied to 0.9.0's own new feature: the thing being measured was not the thing being shipped. It was caught by the cross-platform gate repaired in 0.9.0, on its first real run.

### Added

- **`egr doctor`** — what this installation can do on this machine: every language and whether its native module loaded (with the reason if not), what this platform had to compile from source, which commands need network access, and the MCP registration command. It does not open the graph, so it still answers when the graph is missing — which is when people run it.
- **`egr --help` now carries the MCP registration command**, the line that used to live in a `postinstall` hook nobody saw.

### Changed

- The skipped-language line at index time now points at `egr doctor` for setup steps, instead of stating the problem and stopping there.
- `preinstall.js` is kept but documented as best-effort: it surfaces in CI logs and under `--foreground-scripts`, and is the only thing that can speak before a compile, but it is no longer treated as the channel that informs users.
- The no-toolchain CI job asserts against `egr doctor` rather than install output. Its first version also never reached a compile at all — npm ≥ 11 had blocked the install scripts — so it was asserting against an install where node-gyp had not run. It now approves scripts and rebuilds first, then requires Dart to be reported unavailable *with a reason* and the other twelve languages to still be present.

### Removed

- `postinstall.js`. Rather than keep a mechanism that mostly does not deliver, its content moved to `egr --help` and `egr doctor`.

## [0.9.0] — 2026-08-04

One theme, arrived at from two directions: **what users installed was not what this project tested, and nothing was positioned to notice.**

*Installing was all-or-nothing.* On every platform except Linux x64, `npm install -g engramgraph` compiled the Dart grammar from source — it is the one grammar published without a prebuilt binary for your platform. Without a C/C++ toolchain that build failed, and because Dart was a hard dependency imported statically, the failure was not "Dart is unavailable" but "the install aborts, and `egr` indexes nothing at all". Thirteen languages held hostage by one.

*And the C# parser users received was never the one tested.* `"tree-sitter-c-sharp": "^0.23.1"` spans three published versions that do not share an API. npm resolves a caret to the newest, so every fresh install got 0.23.5 and **no C# file has ever parsed for anyone who installed from npm** — while `package-lock.json` pinned the working 0.23.1 here, keeping the entire test suite green about a version no user would receive.

*Nothing was positioned to notice either one.* `release-compat-check.yml` — the workflow whose whole job is to catch this class of problem — had never executed its matrix once, and the README cited it as proof that Windows worked.

### Added

- **Install-time preflight.** Before any compiler runs, the install says what is about to be built from source on this platform, what it needs, and what happens if it is missing. It judges by prebuilt-binary coverage rather than trying to detect a toolchain — toolchain detection is precisely what misleads here, as node-gyp's own Visual Studio finder demonstrates.
- **Post-install MCP notice.** Installing put `egr-mcp` on your PATH and said nothing about it, so half of what this package does was discoverable only by finding the right README section. Global installs now get the registration command and how to confirm it took. It is not registered automatically, and should not be: a package that writes itself into your assistant's tool configuration during `npm install` has granted itself tool access unasked.
- **`language-support.js`** — one source of truth for which languages exist, which package backs each, and which platforms ship binaries for it. The install hook, the runtime language set, and the docs table all read it, and its claims are re-checked against the installed packages on every test run rather than trusted.
- **A CI job that installs without a usable compiler**, which the existing Windows job could not be — GitHub's Windows runner ships Visual Studio, so it only ever proved the package installs on machines that already have a toolchain.
- **`test/entrypoints.test.ts`** — loads and parses through both published builds, ESM and CommonJS.

### Changed

- **A grammar that fails to load now costs you that language, not the whole tool.** Grammars load lazily, failures are recorded instead of propagated, and a grammar is only considered available once a real `Parser` accepts it — three packages on record `require()` cleanly and then throw inside `setLanguage`.
- **`@vokturz/tree-sitter-dart` is an optional dependency.** Its build can fail without aborting the install.
- **Files skipped for want of a grammar are reported separately from parse health.** A file that failed to parse is source worth inspecting; a file skipped here was never opened. Same symptom, different fix — merging them sends people to read code when they need a compiler.
- **`files` in an index summary counts files actually read**, not files handed in. The two differ only when a language was skipped, and reporting the input count there would claim credit for files never opened.
- **Platform documentation rewritten in all three languages.** The old matrix covered only the graph database, never mentioned the grammars as a second independent native dependency, and marked six rows "Verified via CI" citing a workflow that had never run.

### Fixed

- **C# never parsed for anyone who installed from npm.** `^0.23.1` resolved to 0.23.5, whose exports and peer range belong to a newer tree-sitter ABI; every `.cs` file failed. All thirteen tree-sitter dependencies are now exact versions, and a test fails if any becomes a range again, drifts from the lockfile, or stops binding to a real `Parser`. Two other grammars had the same gap without the same consequence — python resolved to 0.23.6 and rust to 0.23.3, both untested here, both shipping on luck.
- **`egr signatures` hid the failures it exists to group.** Signatures come from a parse tree and a file that threw has none, so hard failures carried none — and the message covering them fired only when there were *no* partial signatures at all, so a single partial file hid any number of failures behind it. One user saw "2 failure types across 2 partial-parse files" while 584 `.cs` files had failed outright. Failures are now bucketed by cause and reported first.
- **Windows could not back up before a schema migration.** `cpSync` goes through `CopyFileEx`, which opens the source without `FILE_SHARE_READ`, and the backup runs while the database is still open. Upgrading 0.7.0 → 0.8.0 hit `EBUSY`, and the only way forward was to move the database aside and rebuild — discarding exactly the data the backup exists to protect.
- **`require('engramgraph')` threw on import.** The CommonJS build compiled `createRequire(import.meta.url)` to `createRequire(undefined)`. Everything in this repo is ESM, so no test touched it.
- **The one command that reaches the network now says so.** `INSTALL ALGO` fetches ryugraph's extension on first use, and its failure was a bare IO exception. It now names the three affected commands (`god-nodes`, `communities`, `related`), states that everything else works offline, and gives the offline build steps.
- **GitHub issue #2 (C# base-list clause + range/index syntax silently zeroing a whole file) does not reproduce** and now has regression tests. The cause was not a C# parser bug: 0.7.0 shipped no C# grammar, so `.cs` fell through to the JavaScript one — which yields believable numbers for C# that resembles JS and nothing at all for syntax that does not. Pinned rather than closed, because a silent zero is what nobody notices coming back.
- **`release-compat-check.yml` never ran its matrix.** It and `publish.yml` both fire on `release: published` and start in the same second, but the package only reaches npm when publish finishes — measured at 3m31s–3m51s against a 2.5 minute wait. Every release since 0.5.0 came up 60–80s short and skipped every platform job at 0s. The wait is now sized against that measurement, and "the package never reached npm" is now reported distinctly from "a platform cannot install it" — previously both were just a red workflow, which is how a gate that had never run went unnoticed for four releases.
- The Intel Mac job no longer joins every manual run, where it dragged in a ~50-minute queue and left the run incomplete long after everything useful had finished.

## [0.8.0] — 2026-07-31

Two themes, both about the same thing: **the index used to be confidently wrong, and nothing said so.** A hand-written AST walker silently dropped what it could not parse, and a parse failure looked exactly like a file with nothing in it.

### Added

#### Language coverage — tag-query engine replaces the hand-written walker (XSPEC-333 R2)

- The AST walker is gone. Symbol extraction now runs on tree-sitter **tag queries**, so a new language is a query file rather than a new hand-written traversal.
- Languages added on that engine: **C#, Python, Go, Java, Kotlin, Rust, C++, Ruby, PHP, Dart**.

#### Semantic resolution — SCIP ingest (XSPEC-333 R3)

- `egr index --scip <path>` overlays a SCIP index on the tree-sitter graph. Where tree-sitter can only guess a call target, a real compiler-backed index resolves it: **SCIP upgrades existing edges rather than only filling gaps**, because tree-sitter now stamps an honest confidence on every CALLS edge it writes.
- Verified on two languages with different toolchains — C# (Roslyn) and Java (scip-java) — to show the design is not shaped around one of them.
- `Function` / `Class` gain a `provider` column; `CALLS` gains nullable `provider` / `confidence`. The writer applies a provenance-aware overwrite policy, so a lower-confidence edge never overwrites a higher-confidence one.

#### Parse-failure observability — you can now see what the index missed (XSPEC-334)

- **`egr blindspots`** — which files the parser failed on, and therefore which parts of your codebase the graph cannot answer questions about. Exposed to queriers as `indexHealth`, not buried in a log.
- **`egr signatures`** — groups parse failures by structural signature, so 200 failures that share one cause read as one problem rather than 200.
- **Per-file tolerance, a health manifest, and a healing diff** — an index run reports what it could not read and what recovered since last time.
- A Tier 1 parse-conformance corpus covering **all 13 grammars**.

### Changed

- **Schema changes now auto-migrate.** Missing columns are added via `ALTER TABLE` on open. 0.7.0 required deleting `.engram/graph.db*` and re-indexing to pick up a schema change; that is no longer necessary. The migration backs up the pre-migration database first, checkpoints before the backup, and is resumable.
- CI gains a coverage gate. The number it enforces is 9 points below the first figure measured — the first measurement was wrong, and the gate is set to the honest one.

### Fixed

- `QueryResult` handles are now closed, releasing native cursor resources.
- C#: `nameof` and named arguments no longer produce false CALLS edges; overload ids no longer collide; `bin/`/`obj/` no longer scanned.
- `walkFiles` paths are normalised to POSIX separators, so the SCIP overlay matches on Windows.
- Several fixes from adversarial review passes on the SCIP and graph-db work — including a stray NUL byte in extracted names, an unreachable schema error, and documentation claims that overstated what was verified.
- `docs/API.md` and `docs/MCP.md` had drifted from the real schema and tool list (a missing rel table, missing provider columns, 3 of 8 MCP tools undocumented in all three languages). Corrected, and the sync guards extended.

## [0.7.0] — 2026-07-13

### Added

- **doc↔doc upstream/downstream edges** (dev-platform XSPEC-331 R2). A spec that
  references another spec — via front-matter `related` / `depends_on` or an
  inline `[[XSPEC-NNN]]` — now produces a `RELATES(Spec→Spec)` edge (previously
  Spec→Spec links were dropped). These land on the **same** Spec nodes that
  `IMPLEMENTS` points at, so the doc graph and the code graph are one connected
  graph: `Function ← Module → IMPLEMENTS → Spec → RELATES → Spec`. `related`
  now traverses spec-to-spec links, and `index --docs` reports a `relates` count.
- `depends_on` is now a recognised relationship front-matter field, and
  relationship-field ids matching the `XSPEC-` prefix are captured (they were
  silently skipped by the old `\bSPEC` boundary).

### Changed

- Schema adds a `RELATES(FROM Spec TO Spec)` rel table. Existing `.engram`
  databases must be rebuilt (`rm .engram/graph.db*` + re-index) to gain it.

## [0.6.0] — 2026-07-13

### Added

- **doc↔code query surface** (dev-platform XSPEC-331 R4), as CLI commands and
  MCP tools:
  - `implementers <spec-id>` — files (and the functions they define) that
    declare `// implements <spec-id>` (spec→code).
  - `implemented-by <module-path>` — specs a file declares it implements
    (code→spec).
  - MCP tools `implementers`, `implemented_specs`, and `related` (the seeded
    structural-ranking query, previously CLI-only) are now exposed so an
    MCP client can answer "which code implements this spec?" / "which spec
    governs this file?" / "what's connected to X?" in-conversation. The MCP
    server now advertises 8 tools (was 5).

## [0.5.0] — 2026-07-13

### Added

- **Code↔spec linkage from `// implements` comments** (dev-platform XSPEC-331
  R1). The extractor now reads `// implements XSPEC-190` / `/* implements
  SPEC-75 */` comments and writes an `IMPLEMENTS` edge so the graph answers
  both "which files implement this spec?" (spec→code, via `Module→DEFINES→
  Function`) and "which spec governs this code?" (code→spec). A stub `Spec`
  target node is created with empty properties so a later `index --docs` pass
  never has its title/status/confidence clobbered. The `index` summary now
  reports an `implements` count.

### Changed

- **`IMPLEMENTS` is now `Module→Spec`** (was `Function→Spec`, which had zero
  writers). The `// implements XSPEC-NNN` convention annotates whole files —
  in a real codebase 233/275 usages sit at file top, including function-less
  type/config files — so the file/Module is the faithful grain; function-level
  queries route through the existing `DEFINES` edge. Existing databases created
  with the old rel-table definition must be rebuilt (drop `.engram/graph.db*`
  and re-index) to pick up the new endpoint types.
- **Artifact-id regex now matches the `XSPEC-` prefix** (dev-platform's
  cross-project specs), in addition to `SPEC-`/`DEC-`/`ADR-`. The `X` is
  preserved: `XSPEC-190` and `SPEC-190` are distinct id namespaces. This also
  means `index --docs` now indexes dev-platform XSPEC documents as `Spec`
  nodes, which the previous `\bSPEC` boundary silently skipped.

## [0.4.1] — 2026-07-12

### Fixed

- `callers()`/CALLS resolution missed a function passed **by reference** as
  a direct call argument (e.g. Fastify's `app.register(pluginFn, opts)`) —
  only literal `fn()` call-expression callees were captured. Found by
  comparing egr against an external tool (colbymchenry/codegraph) on a real
  codebase: `callers` returned nothing for a route-registration function
  invoked this way, across dozens of same-shaped files. The extractor now
  also records a CALLS edge when a known function's bare identifier appears
  as a direct (non-nested) argument in a call's argument list; an
  identifier buried inside an object/array literal argument (e.g.
  `foo({ handler: bar })`) is deliberately still not captured — materially
  weaker signal, out of scope for this fix. No schema change (reuses the
  existing `CALLS` edge; no new property, no migration). See dev-platform
  `cross-project/decisions/DEC-081-codegraph-evaluation.md` v1.1.0,
  `DEC-095-three-way-code-graph-tool-comparison.md`, and
  `cross-project/improvement-backlog.md` L11 for the comparison that found
  this and the design tradeoffs considered.

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
