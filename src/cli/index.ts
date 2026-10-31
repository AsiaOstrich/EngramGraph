#!/usr/bin/env node
/**
 * `egr` CLI — index a repo into the graph and query it from the shell/CI.
 * A thin arg-parsing layer (node:util parseArgs, zero new deps) over the
 * command logic in src/cli/run.ts. The graph DB path is `ENGRAM_DB`
 * (default `./.engram/graph.db`); see src/graph-db/open.ts.
 */

import { parseArgs } from "node:util";
import { createServer as createHttpServer } from "node:http";
import { Readable } from "node:stream";

import pkg from "../../package.json" with { type: "json" };
import { openGraph, resolveDbPath, type GraphLocationOptions, type IsolationMode } from "../graph-db/open.js";
import { createServer } from "../api/server.js";
import { startMcpStdio } from "../mcp/serve-stdio.js";
import { cmdIndex, cmdCallers, cmdCallees, cmdImplementers, cmdImplementedSpecs, cmdImpact, cmdFeedback, cmdTop, cmdGodNodes, cmdCommunities, shapeCommunities, type CommunitiesReport, cmdRelated, cmdGc, cmdBlindspots, cmdSignatures, cmdDoctor, cmdRefsCheck, cmdLint, type GcResult, type BlindspotsResult, type SignaturesResult, type DoctorResult } from "./run.js";
import type { RefCheckResult } from "./refs-check.js";
import { asConfidenceLabel } from "../sage/index.js";
import { toPosixPath } from "../code-graph/path-utils.js";
import { readIndexHealth, definitionFiles, type IndexHealth } from "../code-graph/index.js";
import { manifestPathForDb } from "../code-graph/parse-manifest.js";
import { formatLint } from "../knowledge-graph/lint.js";
import { unresolvedIdClusters, type DocIdConflict, type ReplacedDocument } from "../knowledge-graph/parser.js";
import { callResolutionHint, knowledgeNamingHint } from "./index-hints.js";
import { READ_ONLY_COMMANDS } from "./read-only-commands.js";
import { SKIP_DIRS } from "./walk.js";
import { isLockContention } from "../graph-db/lease.js";
import { coChange, formatCoChange, undeterminedMessage, DEFAULT_COCHANGE_COMMITS, DEFAULT_COCHANGE_MAX_FILES, DEFAULT_COCHANGE_LIMIT } from "../cochange/index.js";
import { checkpointOrWarn } from "../graph-db/checkpoint.js";
import type { GraphConnection } from "../graph-db/connection.js";

const HELP = `egr — code + knowledge graph memory CLI

Usage: egr <command> [args] [options]

Commands:
  index <dir> [--docs] [--clean] [--scip <path>] [--exclude <glob>]...
              [--incremental [--changed-from <git-ref>]]
                                  Index source (.ts/.js/.cs/.py/.go/.java/
                                  .kt/.rs/.cpp/.rb/.php/.dart) into the code
                                  graph;
                                  --docs also indexes .md; --clean drops the
                                  graph first (prunes deleted nodes); --scip
                                  <path> additionally overlays a pre-generated
                                  SCIP index (a .scip file YOU produce with an
                                  external indexer, e.g. 'scip-dotnet index'
                                  for C# or 'scip-java index' for Java — egr
                                  does not run those tools itself) to
                                  upgrade/fill CALLS edges tree-sitter alone
                                  can't resolve; <path>'s SCIP document paths
                                  must be relative to this same <dir>.
                                  --exclude <glob> skips matching paths
                                  (repeatable; see "Excluding paths" below);
                                  the summary says how many it kept out.
                                  --incremental parses only the files whose
                                  content changed since the last --incremental
                                  index and updates just their nodes and edges
                                  (the result equals a full rebuild; the first
                                  run, or a changed egr/grammar version, indexes
                                  in full and says why). Not with --scip.
                                  --changed-from <git-ref> takes the changed
                                  files from "git diff <ref>" instead of
                                  hashing every file (see "Incremental index").
                                  Skips a fixed list of directories (see
                                  below); .gitignore is NOT read
  callers <symbol> [--depth N]    Functions that (transitively) call <symbol>.
                                  A symbol the graph does not contain is an
                                  error (exit 1), not "(none)"
  callees <symbol> [--depth N]    Functions that <symbol> (transitively) calls
                                  (same rule for an unknown symbol)
  implementers <spec-id>          Files (+ functions) that implement a spec (spec→code)
  implemented-by <module-path>    Specs a file declares it implements (code→spec)
  impact <spec-id> [--max-hops N] Decisions in a spec's impact chain
  feedback <type> <node-id> [--label L]
                                  Evolve confidence (type: test_fail|test_pass|human_fix)
  top <label> [--limit N]         Highest-confidence nodes (label: Function|Spec|Decision|Doc)
  god-nodes [--limit N]           Highest-importance nodes across code + knowledge (PageRank)
  communities [--limit N] [--include-unclustered]
                                  Function-call clusters (Louvain over CALLS edges);
                                  --limit keeps the N largest communities (all
                                  their members), not N rows. Functions with no
                                  CALLS edge belong to no community: they are
                                  counted ("unclustered"), not listed, and not
                                  counted by --limit, unless
                                  --include-unclustered
  related <node-id> [--depth N] [--limit N]
                                  Nodes important *around* a seed (seeded PageRank approx.)
  refs check <path...>            Check file-path/symbol references (in
                                  backticks) inside Markdown files or
                                  directories against the graph + git —
                                  present | moved (+ new location) | missing |
                                  unresolvable (e.g. a reference into a repo
                                  this graph does not index). Read-only;
                                  never writes the graph or the files checked
  cochange <file> [--limit N] [--commits N] [--max-files N] [--repo <dir>]
                                  Files that changed together with <file> in
                                  the local git history, most often first
                                  (path relative to the current directory, or
                                  --repo <dir>; results are repository-root
                                  paths). Reads only git, never the graph, and
                                  uses no model. Looks at the last --commits
                                  (default 200) non-merge commits that touched
                                  the file and skips a commit that changed more
                                  than --max-files (default 30) files; merge
                                  commits are not counted and renames are NOT
                                  followed. No history, or not a git repository
                                  = 無法判定 (exit 1), never an empty list. A
                                  file name that starts with "-": egr cochange
                                  -- -name.py  (options go before the "--")
  lint <dir> [--exclude <glob>]... Two ways the replacement relations of the spec/decision
                                  documents under <dir> disagree with themselves
                                  (the same documents "index --docs" reads): (1) a
                                  document whose status says Superseded (or Replaced)
                                  while no document declares "supersedes: <its id>"
                                  in its front matter; (2) a document with a live
                                  status that still cites, through related/depends_on/
                                  impacts/impacted_by/implements or a [[ref]], a
                                  decision that is superseded. A status is the
                                  front-matter "status", else the first status line
                                  (e.g. "> **狀態**: Draft") before the first "## ".
                                  Reads the documents, never the graph, writes
                                  nothing, uses no model. Findings over documents
                                  that were all judged exit 0 (it reports, it does
                                  not block). A document with no status is 無法判定
                                  (cannot determine) - not judged, not a pass - and so
                                  is a folder with no spec/decision document: exit 1
                                  with the full report, findings or not. --json adds
                                  status: findings | undetermined | clean
  gc [--dry-run]                  Remove per-branch graphs for deleted branches
  blindspots                      Files that parsed partially or failed (from
                                  the parse-health manifest) — where the graph
                                  may be missing nodes/edges
  signatures                      Unparsed files grouped by cause — hard
                                  failures by error, partial parses by
                                  structural signature (turns "584 files" into
                                  "1 root cause")
  doctor                          What this installation can do on this machine
                                  — languages available, what had to be
                                  compiled, which commands need network
  serve [--port 3000]             Run the REST server (routes under /graph/*)
  mcp                             Run the MCP server over stdio (for coding assistants)

Options:
  --json                Output raw JSON
  --graph <name>        Use graph ./.engram/<name>.db (explicit project graph)
  --isolation <mode>    single (default) | git-branch (per-branch graph)
  -h, --help            Show this help
  -v, --version         Show version

Graph DB selection (highest first): ENGRAM_DB env > --graph > --isolation
git-branch (per current branch) > default ./.engram/graph.db.
Env ENGRAM_ISOLATION=git-branch enables per-branch isolation without the flag.

Directories index never walks (fixed; .gitignore is NOT read):
  ${[...SKIP_DIRS].join(", ")}

Excluding paths: egr index <dir> --exclude <glob> [--exclude <glob> ...]
  Matched against the path relative to <dir>, '/'-separated on every OS.
    *  any characters except '/'      **  any characters including '/'
    ?  one character                  {a,b}  either; [abc]  one of
  A pattern with no '/' matches an entry's name at any depth
  (".uds-backup-*" skips every such directory). A '/' at the start or in the
  middle anchors the pattern at <dir> ("docs/archive/**", "/logs"). A trailing
  '/' only means directories and does NOT anchor: "logs/" skips every
  directory named logs at any depth, api/logs included; "/logs/" skips only
  <dir>/logs (a leading "./" is dropped, so "./logs/" is not anchored either).
  Excluding a directory excludes everything under it. Applies to code and --docs.
  The summary and --json (excluded.byPattern) count each pattern on its own and
  say "nothing matched" for one that did not; a path two patterns both cover
  counts for both.
  Windows Git Bash rewrites an argument that starts with "/": --exclude "/logs/"
  arrives as "C:/Program Files/Git/logs/" and matches nothing. Run the command
  with MSYS_NO_PATHCONV=1 in front (MSYS_NO_PATHCONV=1 egr index . --exclude
  "/logs/"), or write "//logs/" or "logs/"; a pattern that starts with a Git
  install path and matched nothing is reported with this reason.

Incremental index: egr index <dir> --incremental [--changed-from <git-ref>]
  Parses only the files whose content (sha256, not mtime) changed since the last
  --incremental index, and writes only the difference: nodes and edges of changed
  files, plus the CALLS edges of UNCHANGED files that now resolve differently
  because a name they call was added, removed or became ambiguous elsewhere.
  Deleted, renamed-away and newly excluded files leave the graph. The result
  equals "egr index <dir> --clean" on the same sources. The summary line
  "incremental: N file(s) parsed ..." says what was really parsed.
  Indexed in full (with the reason printed): the first --incremental run, a
  changed egr or tree-sitter grammar version, a graph that was indexed again
  without --incremental, or nodes an older egr wrote for one relative path of two roots.
  A graph built earlier by plain "egr index" runs may hold leftovers a plain
  index never prunes; start from an empty graph or add --clean for an exact state.
  --changed-from <ref> says "the graph describes <ref>": files "git diff <ref>"
  lists (plus untracked, not ignored, files) are compared by hash, every other
  file is taken as unchanged without being read for comparison. A wrong ref gives
  a wrong graph; without it every file is hashed, which is always correct.
  --docs still indexes every document; --scip is refused.

Several roots in one graph: a file keeps its path relative to its root as its id
  (src/index.ts), unless another root of the same graph already holds that path.
  Then it is indexed as <last two segments of its root>/<path> (EngramGraph/src/index.ts),
  so two roots that both have src/index.ts are two Module nodes, not one. Ids of a
  graph with one root, or roots that never share a path, are exactly as before. An id
  is kept while its file stays in the index, so the root indexed first keeps the plain
  path. A graph an older egr built from roots that share a path holds one mixed node
  for it: egr prints a WARNING and the fix is one rebuild with --clean.

Exit status: 0 on success; 1 on any error, including a lock held by another
process and an input (symbol, spec id, node id, module path) the graph does not
contain. "(none)" with exit 0 means: it is in the graph and has no results.
"cochange" exits 1 with 無法判定 (cannot determine) when the directory is not a
git work tree, no commit touches the file, or every commit that did was skipped
as too large; "(none)" there means the file has usable history and nothing else
ever changed with it.
"lint" reads documents, not the graph. It exits 0 when every document was judged, with or
without findings (it reports, it does not block); it exits 1 with the full report when a
document has no status or no spec/decision document was found (無法判定, findings or not),
and 1 without a report when it could not run (no <dir>, not a directory).
"refs check" also exits 1 when any reference is "missing" (the full report is
still printed); "unresolvable" does not fail it.

Connect a coding assistant (MCP): claude mcp add egr -- npx egr-mcp
  then confirm with: claude mcp list   (Codex/Cursor/Windsurf, and Windows: see docs/MCP.md)
Run "egr doctor" if a language seems to be missing from your graph.`;

const VERSION = (pkg as { version: string }).version;

function out(data: unknown, json: boolean | undefined, human: (d: unknown) => string): void {
  process.stdout.write((json ? JSON.stringify(data, null, 2) : human(data)) + "\n");
}

const fmtNodes = (
  rows: Array<{ name?: string; id?: string; file?: string; label?: string; confidence?: number; rank?: number; communityId?: number }>,
): string =>
  rows.length
    ? rows
        .map((r) => {
          const extras = [
            r.file,
            r.label,
            r.confidence != null ? `confidence ${r.confidence}` : undefined,
            r.rank != null ? `rank ${r.rank.toFixed(4)}` : undefined,
            r.communityId != null ? (r.communityId === -1 ? "unclustered" : `community ${r.communityId}`) : undefined,
          ].filter(Boolean);
          return `  ${r.name ?? r.id}${extras.length ? ` (${extras.join(", ")})` : ""}`;
        })
        .join("\n")
    : "  (none)";

/**
 * A human-facing "⚠ possibly incomplete" line for a query whose result sits
 * near blindspot files (XSPEC-334 R2). Uses `blindspotsTotal` (the true count),
 * never the possibly-truncated `blindspots` list length. Empty when the graph
 * is healthy or the result touches no blindspot subtree.
 */
function healthNote(h: IndexHealth | null): string {
  // A manifest that exists but cannot be read is NOT a clean bill of health
  // (XSPEC-373 B8). Both used to render as "" — the mechanism for revealing
  // incomplete results could not report its own failure.
  if (h?.unavailable) {
    return `\n⚠ index health unknown: the parse-health manifest could not be read (${h.unavailable}) — this result is unannotated, not verified`;
  }
  if (!h?.possiblyIncomplete) return "";
  const n = h.blindspotsTotal ?? h.blindspots?.length ?? 0;
  return `\n⚠ possibly incomplete: ${n} file(s) near this result parsed partially/failed (see \`egr blindspots\`)`;
}

/**
 * The writable connection this process opened, once it has one. `main().catch` below uses it:
 * a command that fails after it has written (an `index` whose `--scip` file is missing, say)
 * must not leave what it wrote only in the write-ahead log.
 */
let openedForWriting: GraphConnection | null = null;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      json: { type: "boolean" },
      docs: { type: "boolean" },
      depth: { type: "string" },
      "max-hops": { type: "string" },
      limit: { type: "string" },
      label: { type: "string" },
      port: { type: "string" },
      graph: { type: "string" },
      isolation: { type: "string" },
      clean: { type: "boolean" },
      scip: { type: "string" },
      exclude: { type: "string", multiple: true },
      "dry-run": { type: "boolean" },
      "include-unclustered": { type: "boolean" },
      incremental: { type: "boolean" },
      "changed-from": { type: "string" },
      commits: { type: "string" },
      "max-files": { type: "string" },
      repo: { type: "string" },
    },
  });

  const [cmd, a1, a2] = positionals;

  if (values.version) return void process.stdout.write(VERSION + "\n");
  if (values.help || !cmd) return void process.stdout.write(HELP + "\n");

  const num = (v: string | undefined, d: number): number => (v != null ? Number(v) : d);

  // Graph location knobs shared by every command that opens a graph.
  if (values.isolation && values.isolation !== "single" && values.isolation !== "git-branch") {
    throw new Error(`--isolation must be "single" or "git-branch" (got "${values.isolation}")`);
  }
  const loc: GraphLocationOptions = {
    graph: values.graph,
    isolation: values.isolation as IsolationMode | undefined,
  };

  // gc inspects the filesystem, not a graph connection.
  if (cmd === "gc") {
    const r = cmdGc({ dryRun: values["dry-run"] });
    out(r, values.json, (d) => {
      const g = d as GcResult;
      if (g.dir == null) return "gc: not a git repository (per-branch graphs only)";
      const verb = g.deleted ? "removed" : g.orphans.length ? "orphans (dry-run)" : "orphans";
      return `${verb} in ${g.dir}:\n${g.orphans.length ? g.orphans.map((o) => `  ${o}`).join("\n") : "  (none)"}`;
    });
    return;
  }

  // cochange reads the git history, not a graph connection (XSPEC-514 R2). It must stay above `openGraph`:
  // a pure-git question must not create or lock .engram/graph.db, and must work where no graph exists.
  if (cmd === "cochange") {
    if (!a1) throw new Error("cochange requires a <file> (a file name that starts with \"-\" goes after \"--\")");
    const posInt = (flag: string, v: string | undefined, d: number): number => {
      if (v === undefined) return d;
      if (!/^[1-9][0-9]*$/.test(v)) throw new Error(`${flag} must be a positive integer (got "${v}")`);
      return Number(v);
    };
    const r = coChange({
      file: a1,
      repo: values.repo,
      commits: posInt("--commits", values.commits, DEFAULT_COCHANGE_COMMITS),
      maxFilesPerCommit: posInt("--max-files", values["max-files"], DEFAULT_COCHANGE_MAX_FILES),
      limit: posInt("--limit", values.limit, DEFAULT_COCHANGE_LIMIT),
    });
    if (r.status === "undetermined") {
      // "Cannot determine" is not an empty result: stderr + exit 1 in both modes. Under --json stdout also carries
      // the structured status, so a script that parses stdout sees `status: "undetermined"`, never `[]`.
      if (values.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      throw new Error(undeterminedMessage(r));
    }
    out(r, values.json, (d) => formatCoChange(d as typeof r));
    return;
  }

  // lint reads the documents, not a graph connection (DEC-140). Like cochange it stays above `openGraph`: it must
  // not create or lock .engram/graph.db, and it works where no graph exists. It does not block on findings
  // (exit 0 when every document was judged); it exits 1 when it could not judge everything, or could not run.
  if (cmd === "lint") {
    if (!a1) throw new Error("lint requires a <dir>");
    const r = await cmdLint({ dir: a1, exclude: values.exclude });
    out(r, values.json, (d) => formatLint(d as typeof r, a1));
    // The report is printed in full above. A report that could not judge everything (a document with no status, or no
    // spec/decision document at all) is not a pass - with or without findings next to it - so it exits 1, like
    // `cochange`'s 無法判定; stderr says why (also under --json, whose stdout is the JSON alone). Findings over
    // documents that were all judged exit 0: it reports, it does not block.
    if (r.undeterminedReason !== undefined) {
      process.stderr.write(`egr: lint: 無法判定 (cannot determine) — ${r.undeterminedReason}; the report is above (exit 1)\n`);
      process.exitCode = 1;
    }
    return;
  }

  // blindspots reads the parse-health manifest, not a graph connection.
  if (cmd === "blindspots") {
    const r = cmdBlindspots(manifestPathForDb(resolveDbPath(loc)));
    out(r, values.json, (d) => {
      const b = d as BlindspotsResult;
      if (b.blindspots.length === 0) {
        return b.filesIndexed === 0
          ? "blindspots: no parse-health manifest yet (run `egr index <dir>` first)"
          : `blindspots: none — all ${b.filesIndexed} indexed files parsed cleanly`;
      }
      const head = `blindspots: ${b.blindspots.length} of ${b.filesIndexed} files (${b.partial} partial, ${b.failed} failed) — the graph may be missing nodes/edges here:`;
      const body = b.blindspots
        .map((f) => `  ${f.path} [${f.language}] ${f.failed ? "FAILED" : `partial (${f.errorNodes} error node${f.errorNodes === 1 ? "" : "s"})`}`)
        .join("\n");
      return `${head}\n${body}`;
    });
    return;
  }

  // doctor reports on the installation itself — no graph connection needed, so
  // it still works when the graph is missing or unreadable, which is exactly
  // when someone is most likely to run it.
  if (cmd === "doctor") {
    const r = cmdDoctor(resolveDbPath(loc));
    out(r, values.json, (d) => {
      const t = d as DoctorResult;
      const lines = [
        `egr ${t.egrVersion}   node ${t.node}   ${t.platform}`,
        `graph: ${t.graphDb}`,
        "",
        `languages: ${t.available} available, ${t.unavailable} unavailable`,
      ];
      for (const l of t.languages) {
        const mark = l.available ? "✓" : "✗";
        const note = l.available
          ? l.compilesFromSource
            ? " (compiled from source on this platform)"
            : ""
          : ` — ${l.package}: ${l.reason}`;
        lines.push(`  ${mark} ${l.label}${note}`);
      }
      if (t.unavailable > 0) {
        lines.push(
          "",
          "An unavailable language means its native module could not be loaded here —",
          "usually because this platform has no prebuilt binary for it and the machine",
          "has no C/C++ toolchain to compile one. Files in that language are skipped at",
          "index time and reported there; everything else indexes normally.",
          "Setup steps: https://github.com/AsiaOstrich/EngramGraph#native-dependencies-and-platform-support",
        );
      }
      // Said from what this machine actually has (XSPEC-457 R3), not from a fixed list.
      const network =
        t.networkStatus === "none"
          ? `needs network: none — ${t.algo.detail}`
          : t.networkStatus === "needed"
            ? `needs network: ${t.networkCommands.join(", ")} — ${t.algo.detail} (every other command works offline)`
            : `needs network: cannot be determined — ${t.algo.detail}. ${t.networkCommands.join(", ")} are the commands affected.`;
      lines.push("", network, "connect an assistant: claude mcp add egr -- npx egr-mcp");
      return lines.join("\n");
    });
    return;
  }

  // signatures reads the parse-health manifest, not a graph connection.
  if (cmd === "signatures") {
    const mp = manifestPathForDb(resolveDbPath(loc));
    const r = cmdSignatures(mp);
    out(r, values.json, (d) => {
      const s = d as SignaturesResult;
      if (s.buckets.length === 0 && s.failureBuckets.length === 0) {
        // Nothing to group does NOT mean "all clean" — differentiate the cases
        // so the message never contradicts `egr blindspots` (an older-egr
        // manifest has partial files but no recorded signatures).
        const b = cmdBlindspots(mp);
        if (b.filesIndexed === 0) return "signatures: no parse-health manifest yet (run `egr index <dir>` first)";
        if (b.partial > 0) return `signatures: ${b.partial} partial file(s) but no signatures recorded — this manifest predates signature support; re-run \`egr index\` to populate them`;
        return `signatures: none — all ${b.filesIndexed} indexed files parsed cleanly`;
      }
      const sections: string[] = [];
      // Hard failures first, and unconditionally. They used to appear only
      // when there were no partial signatures at all, so one partial file was
      // enough to hide any number of outright failures — which is how 584
      // unparsed C# files sat behind a report about two jQuery files.
      if (s.failureBuckets.length > 0) {
        const head =
          `signatures: ${s.filesFailed} file(s) failed to parse entirely, ` +
          `in ${s.failureBuckets.length} distinct cause(s):`;
        const body = s.failureBuckets
          .map(
            (b) =>
              `  [${b.fileCount}x] ${b.languages.join(", ")}: ${b.reason}\n` +
              b.sampleFiles.map((f) => `      ${f}`).join("\n"),
          )
          .join("\n");
        sections.push(`${head}\n${body}`);
      }
      if (s.buckets.length > 0) {
        const head = `partial parses: ${s.buckets.length} distinct signature(s) across ${s.filesWithSignatures} file(s):`;
        const body = s.buckets
          .map((b) => `  [${b.fileCount}x] ${b.signature}\n${b.sampleFiles.map((f) => `      ${f}`).join("\n")}`)
          .join("\n");
        sections.push(`${head}\n${body}`);
      }
      return sections.join("\n\n");
    });
    return;
  }

  // Long-running commands manage their own lifecycle (no exit).
  if (cmd === "mcp") return startMcpStdio(resolveDbPath(loc));
  if (cmd === "serve") {
    const conn = await openGraph(loc);
    openedForWriting = conn;
    // `serve` runs until it is stopped, and `POST /graph/ingest` writes. Stopping it with Ctrl-C or
    // SIGTERM used to leave those writes only in graph.db.wal; fold them in before the process ends.
    // A second signal while that runs ends the process at once.
    let stopping = false;
    const stop = (): void => {
      if (stopping) process.exit(1);
      stopping = true;
      checkpointOrWarn(conn)
        .catch((err: unknown) => process.stderr.write(`egr: ${err instanceof Error ? err.message : String(err)}\n`))
        .finally(() => process.exit(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const app = createServer({ connection: conn, manifestPath: manifestPathForDb(resolveDbPath(loc)) });
    const port = num(values.port, 3000);
    createHttpServer(async (req, res) => {
      const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
      const method = req.method ?? "GET";
      const hasBody = method !== "GET" && method !== "HEAD";
      const init: RequestInit & { duplex?: "half" } = {
        method,
        headers: req.headers as Record<string, string>,
        body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
      };
      if (hasBody) init.duplex = "half";
      const response = await app.fetch(new Request(url, init));
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(await response.text());
    }).listen(port, () => {
      process.stdout.write(`EngramGraph REST on http://localhost:${port} (db: ${resolveDbPath(loc)})\n`);
    });
    return;
  }

  // Data commands: open graph, run, print, exit.
  const conn = await openGraph(loc, { readOnly: READ_ONLY_COMMANDS.has(cmd) });
  if (!conn.readOnly) openedForWriting = conn;
  // Set by a command whose RESULT is a failure verdict although it ran fine
  // (`refs check` found a missing reference). Applied at the single exit below.
  let exitCode = 0;
  switch (cmd) {
    case "index": {
      if (!a1) throw new Error("index requires a <dir>");
      // The parse-health manifest (XSPEC-334 R1b) lives beside this graph's DB
      // file; derive its path from the same resolution the connection used.
      const manifestPath = manifestPathForDb(resolveDbPath(loc));
      const r = await cmdIndex(conn, { dir: a1, docs: values.docs, clean: values.clean, scip: values.scip, manifestPath, exclude: values.exclude, incremental: values.incremental, changedFrom: values["changed-from"] });
      out(r, values.json, (d) => {
        const s = d as Awaited<ReturnType<typeof cmdIndex>>;
        // The counts carry their denominator (XSPEC-373 R1): `0 specs` alone
        // cannot distinguish "nothing was scanned" from "44 documents were
        // scanned and none could be named", and that ambiguity is the whole
        // defect this line used to have.
        const dupConflicts = (s.knowledge?.conflicts ?? []).filter((c): c is DocIdConflict => c.reason === "duplicate-id");
        const replacedConflicts = (s.knowledge?.conflicts ?? []).filter((c): c is ReplacedDocument => c.reason === "replaced-from-earlier-index");
        const k = s.knowledge
          ? `\nknowledge: ${s.knowledge.specs} specs, ${s.knowledge.decisions} decisions, ${s.knowledge.impacts} impacts, ${s.knowledge.supersedes} supersedes, ${s.knowledge.decisionRelates} decision-relates, ${s.knowledge.relates} relates` +
            ` (${s.knowledge.docsScanned} doc(s) scanned, ${s.knowledge.docsUnresolved.length} unnamed` +
            // Documents set aside because another document owns their id (XSPEC-476 R2).
            // Named in the count so scanned = nodes' sources + unnamed + set aside adds up.
            `${dupConflicts.length ? `, ${dupConflicts.reduce((n, c) => n + c.setAside.length, 0)} set aside: duplicate id` : ""}` +
            // Nodes that an earlier index wrote from another file and this run overwrote (XSPEC-481 R4).
            `${replacedConflicts.length ? `, ${replacedConflicts.length} replaced a copy from an earlier index` : ""})`
          : "";
        // One line per id claimed by more than one document (XSPEC-476 R2). Never
        // collapsed into a count: the reader has to be able to open both files.
        const idSourceLabel = { "front-matter": "front-matter id", filename: "filename", heading: "heading" } as const;
        const kConflicts = dupConflicts
          .map(
            (c) =>
              `\nknowledge: WARNING — ${c.id} is claimed by ${c.setAside.length + 1} documents; kept ${c.kept.path} (${idSourceLabel[c.kept.source]}), ` +
              `set aside ${c.setAside.map((d) => `${d.path} (${idSourceLabel[d.source]})`).join(", ")} — their links are not in the graph. ` +
              `An id goes to the front-matter \`id\` first, then the filename, then a heading that starts with it.`,
          )
          .join("");
        // One line per id this run took over from an earlier run (XSPEC-481 R4): both paths, because
        // the reader has to know which file's content the graph now holds and which one it was.
        const kReplaced = replacedConflicts
          .map(
            (c) =>
              `\nknowledge: WARNING — ${c.id} was indexed from ${c.previous.path} by an earlier index and is now overwritten by ${c.current.path} ` +
              `(${idSourceLabel[c.current.source]}); the graph holds the later document. If both are meant to exist, give one a different id; ` +
              `to rebuild from one directory only, re-run with --clean.`,
          )
          .join("");
        // A prefix rejected over and over is a naming convention this tool does
        // not know — as opposed to a README, which is simply not a spec. See
        // `unresolvedIdClusters` for why neither "unresolved > 0" nor
        // "yield === 0" is the right trigger.
        const clusters = s.knowledge ? unresolvedIdClusters(s.knowledge.docsUnresolved) : [];
        const kWarning = clusters
          .map(
            (c) =>
              `\nknowledge: WARNING — ${c.count} document(s) named \`${c.prefix}-…\` yielded no artifact id ` +
              `(e.g. ${c.samples.join(", ")}). Recognised prefixes are XSPEC/SPEC/DEC/ADR, ` +
              `each followed by a number or a name (e.g. SPEC-42, SPEC-EXTERNAL-AUTH).`,
          )
          .join("");
        // A matched-files-but-zero-resolution result is a real, silent-failure-
        // shaped signal worth surfacing even though it isn't a hard error.
        // The path-separator mismatch that used to be this warning's main
        // justification is fixed now (`code-graph/path-utils.ts`'s
        // `toPosixPath`, applied at both `walkFiles` and `collectExtraction`
        // — XSPEC-333 R3 follow-up — so every path-derived id is
        // `/`-separated on every OS). This has only been verified with
        // string-level unit tests against manufactured Windows-style input
        // (see `test/scip-windows-path-normalization.test.ts`), NOT a real
        // Windows end-to-end run — this sandbox has no Windows host to
        // confirm against. The warning is kept regardless: it's still a
        // useful catch-all for OTHER causes of the same zero-resolution
        // shape that a path-overlap check can't rule out — e.g. `<dir>`
        // happens to contain files whose NAMES coincidentally match the SCIP
        // index's document paths but whose CONTENT differs from what the
        // external indexer actually saw (one concrete way this can happen:
        // the `.scip` file is stale — generated before the source tree was
        // subsequently edited, so the symbols it recorded no longer line up
        // with what's on disk now) — `ingestScipOverlay`'s own path-overlap
        // check only compares path strings, never file content, so it cannot
        // detect this on its own.
        const scipWarning =
          s.scip && s.scip.filesMatched > 0 && s.scip.definitionsResolved === 0 && s.scip.callsEmitted === 0
            ? `\nscip: WARNING — ${s.scip.filesMatched} file(s) matched but 0 definitions/calls were resolved; ` +
              `double-check <dir> is the exact project root the external SCIP indexer ran against.`
            : "";
        const scip = s.scip
          ? `\nscip: ${s.scip.filesMatched}/${s.scip.documentsInIndex} indexed files matched, ` +
            `${s.scip.definitionsResolved} definitions resolved (${s.scip.definitionsUnresolved} unresolved), ` +
            `${s.scip.callsEmitted} calls emitted (${s.scip.callsSkippedNoEnclosingCaller} skipped: no enclosing caller, ` +
            `${s.scip.callsSkippedUnresolvedTarget} skipped: unresolved target)${scipWarning}`
          : "";
        // Parse-health line (XSPEC-334 R1b/R1d): the clean/partial/failed
        // rollup makes silent partial parses visible, and the healed/regressed
        // delta (present when a previous manifest existed) surfaces what a
        // grammar/egr upgrade fixed or broke since the last index.
        const ph = s.parseHealth;
        const delta =
          ph && (ph.healed.length > 0 || ph.regressed.length > 0)
            ? ` (healed ${ph.healed.length}, regressed ${ph.regressed.length} since last index)`
            : "";
        const parse = ph ? `\nparse: ${ph.clean} clean, ${ph.partial} partial, ${ph.failed} failed${delta}` : "";
        // Languages this installation has no grammar for (XSPEC-365 R2). Kept
        // off the `parse:` line on purpose: those counts describe files the
        // engine read and struggled with, and folding "you have no Dart
        // grammar" in there would send the reader to inspect source code when
        // the fix is a toolchain. Silence would be worse still — the files
        // simply wouldn't be in the graph, and `callers()` would answer
        // "nothing calls X" with no hint that a whole language was missing.
        const sk = s.code.skippedLanguages ?? [];
        const skipped = sk.length
          ? "\n" +
            sk
              .map(
                (l) =>
                  `skipped: ${l.files} ${l.label} file(s) — ${l.label} support is not enabled ` +
                  `in this installation (${l.package}: ${l.reason}). ` +
                  `Everything else was indexed normally; run "egr doctor" for setup steps.`,
              )
              .join("\n")
          : "";
        // Says explicitly that the counts above EXCLUDE these. Without that
        // clause the line reads as trivia, and the denominator stays wrong in
        // the reader's head — which is the whole failure mode (XSPEC-373 B3).
        const symlinked = s.skippedSymlinkDirs?.length
          ? `\nskipped: ${s.skippedSymlinkDirs.length} symlinked director${s.skippedSymlinkDirs.length === 1 ? "y" : "ies"} not walked ` +
            `(${s.skippedSymlinkDirs.slice(0, 3).join(", ")}${s.skippedSymlinkDirs.length > 3 ? ", …" : ""}) — ` +
            `contents are absent from every count above. Index such a directory as its own root to include it.`
          : "";
        // Linked git worktrees (copies of a repository already in the index, e.g. a Claude Code
        // agent's `.claude/worktrees/agent-*`) are not walked. Named, with the same "absent from
        // every count" clause as the symlinks above: silence here would put a whole checkout
        // outside the denominator.
        const sw = s.skippedWorktrees;
        const worktrees = sw
          ? `\nskipped: ${sw.paths.length} git worktree${sw.paths.length === 1 ? "" : "s"} not walked ` +
            `(${sw.paths.slice(0, 3).join(", ")}${sw.paths.length > 3 ? ", …" : ""}; ${sw.files} file(s)) — ` +
            `a worktree is a second copy of a repository already in the index, and its contents are absent from every count above. ` +
            `Index a worktree's directory as its own root to include it.`
          : "";
        // Unreadable files used to abort the whole index with a bare EACCES;
        // they are skipped now, so they must be named or the file count is
        // quietly short (XSPEC-373 B7).
        const unreadable = s.unreadableFiles?.length
          ? `\nunreadable: ${s.unreadableFiles.length} file(s) matched but could not be read — ` +
            s.unreadableFiles.slice(0, 3).map((f) => `${f.path} (${f.reason})`).join("; ") +
            (s.unreadableFiles.length > 3 ? "; …" : "") +
            `. Not included in any count above.`
          : "";
        // Seen-but-not-indexed source files (XSPEC-414 R1) — always printed
        // (even at 0), unlike the conditional lines above: this is a standing
        // denominator question ("how much of this tree did we not even try to
        // index?"), not an exceptional condition worth hiding on a clean run.
        const uc = s.unindexedCode;
        const unindexed =
          uc.count > 0
            ? `\nunindexed: ${uc.count} source file(s) seen but not covered by any supported language — ` +
              `top extensions: ${uc.topExtensions.map((e) => `${e.ext} (${e.count})`).join(", ")}`
            : `\nunindexed: 0 source file(s) seen but not covered by any supported language`;
        // Files whose extension `detectLanguage` doesn't recognize at all
        // (XSPEC-414 R1) — distinct from `skipped` above (a KNOWN language
        // whose grammar failed to load). Normally empty for `egr index`
        // itself (CODE_EXTS already filters to recognized extensions before
        // any file reaches this far); surfaced here anyway because `code` is
        // the same shape MCP's `index_code` returns, and there it is not
        // normally empty — an MCP client can hand `index_code` any path.
        const su = s.code.skippedUnrecognized ?? [];
        const skippedUnrecognized = su.length
          ? "\nskipped: " +
            su.map((u) => `${u.files} ${u.ext} file(s)`).join(", ") +
            " — unrecognized extension, not parsed as any language."
          : "";
        // What --exclude kept out (XSPEC-457 R5). Always printed when patterns were
        // given, including "0 matched": a pattern that matches nothing is a typo
        // the reader needs to see, and one that matches too much needs its size.
        const ex = s.excluded;
        const excludedLine = ex
          ? `\nexcluded: ${ex.files} file(s) in ${ex.paths.length} path(s) matched --exclude ${ex.patterns.map((p) => `"${p}"`).join(" ")}` +
            (ex.paths.length
              ? ` (${ex.paths.slice(0, 3).join(", ")}${ex.paths.length > 3 ? ", …" : ""}) — not in any count above`
              : ` — nothing matched; check the pattern${ex.byPattern.length === 1 ? (ex.byPattern[0]!.hint ?? "") : ""}`) +
            // With several patterns the total hides which one did nothing, so each is
            // listed on its own (XSPEC-476 R3). A pattern that overlaps another is
            // counted for both. One pattern: the line above already is its answer.
            (ex.byPattern.length > 1
              ? ex.byPattern
                  .map((b) => `
excluded: "${b.pattern}" — ${b.nothingMatched ? `nothing matched; check the pattern${b.hint ?? ""}` : `${b.files} file(s) in ${b.paths} path(s)`}`)
                  .join("")
              : "")
          : "";
        // Next steps, only when the counts above show they would change something
        // (consumer feedback on 0.11.0 — see index-hints.ts).
        const hints =
          callResolutionHint(s.code, Boolean(s.scip)) +
          knowledgeNamingHint(s.knowledge, s.code.implements, clusters.length > 0);
        // What --incremental did (XSPEC-508 R6): the line that says how many files were really parsed.
        const inc = s.incremental;
        const incLine = inc
          ? inc.mode === "full"
            ? `\nincremental: indexed in full — ${inc.reason}; ${inc.reparsed} file(s) parsed, state saved for the next run`
            : `\nincremental: ${inc.reparsed} file(s) parsed (${inc.changed} changed, ${inc.added} new), ${inc.reused} reused unchanged, ${inc.removed} removed; ` +
              `graph updated: ${inc.nodesRemoved} node(s) and ${inc.edgesRemoved} edge(s) removed, ${inc.edgesWritten} edge(s) written` +
              (inc.changedFrom !== undefined ? ` (changed files from git diff ${inc.changedFrom})` : "")
          : "";
        // Roots that share a relative path (XSPEC-508 R6): the second one's files carry a root-qualified id.
        const rq = s.rootQualifiedIds;
        const rootIdsLine = rq
          ? `\nids: ${rq.files} file(s) of this root share a relative path with another root of the graph and got root-qualified ids ` +
            `(${rq.examples.map((e) => `${e.path} -> ${e.id}`).join(", ")}${rq.files > rq.examples.length ? ", …" : ""}); the other root keeps the plain path`
          : "";
        const sn = s.sharedNodes;
        const sharedLine = sn
          ? `\nWARNING: ${sn.count} node(s) of this root (e.g. ${sn.examples[0]!.id}) are also held by another root (${sn.examples[0]!.otherRoot}) of this graph: ` +
            `an older egr wrote ONE node for the same relative path of both roots, so their functions and call edges are mixed. ` +
            `Rebuild the graph once (egr index <dir> --clean, or index-all.sh --clean) to separate them.`
          : "";
        return `code: ${s.code.files} files, ${s.code.functions} functions, ${s.code.classes} classes, ${s.code.calls} calls, ${s.code.implements} implements (ambiguous ${s.code.ambiguous}, unresolved ${s.code.unresolved})${k}${kConflicts}${kReplaced}${kWarning}${scip}${parse}${incLine}${rootIdsLine}${sharedLine}${skipped}${skippedUnrecognized}${symlinked}${worktrees}${unreadable}${excludedLine}${unindexed}${hints}`;
      });
      break;
    }
    case "callers":
    case "callees": {
      if (!a1) throw new Error(`${cmd} requires a <symbol>`);
      const rows = cmd === "callers" ? await cmdCallers(conn, a1, num(values.depth, 1)) : await cmdCallees(conn, a1, num(values.depth, 1));
      // Coarse index-health note (R2): warn a human reader when blindspot files
      // sit near this result — most pointed for `callers` ("nothing calls X,
      // safe to delete" is wrong if X's caller lives in an unparsed file). The
      // anchor includes X's OWN definition file(s) so an EMPTY result (the
      // highest-risk answer) still gets the check. --json stays a bare array
      // (its established shape); `egr blindspots` is the machine-readable surface.
      const anchor = [...(await definitionFiles(conn, a1)), ...rows.map((r) => r.file)];
      const health = readIndexHealth(manifestPathForDb(resolveDbPath(loc)), anchor);
      out(rows, values.json, (d) => `${cmd}(${a1}):\n${fmtNodes(d as Array<{ name: string; file: string }>)}${healthNote(health)}`);
      break;
    }
    case "implementers": {
      if (!a1) throw new Error("implementers requires a <spec-id>");
      // An id the graph has never seen throws inside cmdImplementers (exit 1); what is
      // left here is a spec that IS in the graph, with or without implementers.
      const r = await cmdImplementers(conn, a1);
      const health = readIndexHealth(manifestPathForDb(resolveDbPath(loc)), r.modules.map((m) => m.module));
      out(r, values.json, (d) => {
        const res = d as Awaited<ReturnType<typeof cmdImplementers>>;
        const provenance =
          res.origin === "referenced"
            ? "  ⚠ this id is only referenced by another document — no spec document and no code declares it"
            : res.origin === "annotated"
              ? "  ⚠ known only from a code annotation — its document has not been indexed (run `egr index <dir> --docs`)"
              : "";
        const head = `implementers(${res.spec})${res.title ? ` — ${res.title}` : ""}:`;
        const body = res.modules.length
          ? res.modules.map((m) => `  ${m.module}${m.functions.length ? ` (${m.functions.join(", ")})` : ""}`).join("\n")
          : "  (none — this spec is in the graph; no file declares it implements it)";
        return `${head}\n${provenance ? provenance + "\n" : ""}${body}${healthNote(health)}`;
      });
      break;
    }
    case "implemented-by": {
      if (!a1) throw new Error("implemented-by requires a <module-path>");
      // Module ids are always '/'-separated (walkFiles/collectExtraction
      // normalize at indexing time — XSPEC-333 R3 follow-up); normalize a
      // user-typed <module-path> the same way so `implemented-by src\foo.ts`
      // still matches on a Windows shell where that's the natural way to
      // type a path.
      // No module / an ambiguous path throws inside cmdImplementedSpecs (exit 1).
      const r = await cmdImplementedSpecs(conn, toPosixPath(a1));
      const health = readIndexHealth(manifestPathForDb(resolveDbPath(loc)), [r.module]);
      out(r, values.json, (d) => {
        const res = d as Awaited<ReturnType<typeof cmdImplementedSpecs>>;
        const via = res.resolvedFrom ? ` (resolved from ${res.resolvedFrom})` : "";
        const body = res.specs.length
          ? res.specs.map((s) => `  ${s.id}${s.title ? ` — ${s.title}` : ""}`).join("\n")
          : "  (none — this module is indexed but declares no spec)";
        return `implemented-by(${res.module})${via}:\n${body}${healthNote(health)}`;
      });
      break;
    }
    case "impact": {
      if (!a1) throw new Error("impact requires a <spec-id>");
      const r = await cmdImpact(conn, a1, num(values["max-hops"], 3));
      out(r, values.json, (d) => {
        const res = d as Awaited<ReturnType<typeof cmdImpact>>;
        return `impact(${res.nodeId}):\n${res.decisions.length ? res.decisions.map((x) => `  ${x.id} [${x.via}] ${x.title}`).join("\n") : "  (none)"}`;
      });
      break;
    }
    case "feedback": {
      if (!a1 || !a2) throw new Error("feedback requires <type> <node-id>");
      const label = values.label ? asConfidenceLabel(String(values.label), "feedback --label") : "Function";
      const r = await cmdFeedback(conn, a1, a2, label);
      // A node that is not there throws inside cmdFeedback (exit 1).
      out(r, values.json, (d) => `${(d as { nodeId: string }).nodeId}: ${(d as { before: number }).before} → ${(d as { after: number }).after}`);
      break;
    }
    case "top": {
      if (!a1) throw new Error("top requires a <label> (Function|Spec|Decision|Doc)");
      const rows = await cmdTop(conn, asConfidenceLabel(a1, "top"), num(values.limit, 10));
      out(rows, values.json, (d) => `top ${a1}:\n${fmtNodes(d as Array<{ name: string; confidence: number }>)}`);
      break;
    }
    case "god-nodes": {
      const rows = await cmdGodNodes(conn, num(values.limit, 10));
      out(rows, values.json, (d) => `god-nodes:\n${fmtNodes(d as Array<{ name: string; label: string; rank: number }>)}`);
      break;
    }
    case "communities": {
      // --limit counts communities (the N largest, whole), not rows — see limitCommunities.
      // Checked before the graph is queried so a bad value costs nothing.
      if (values.limit !== undefined && !/^[1-9]\d*$/.test(values.limit)) {
        throw new Error(`communities --limit must be a positive whole number (got "${values.limit}")`);
      }
      const all = await cmdCommunities(conn);
      const report = shapeCommunities(all, {
        limit: values.limit !== undefined ? Number(values.limit) : undefined,
        includeUnclustered: values["include-unclustered"],
      });
      out(report, values.json, (d) => {
        const r = d as CommunitiesReport;
        const cut =
          r.shownCommunities < r.communityCount
            ? `\n(showing the ${r.shownCommunities} largest of ${r.communityCount} communities; --limit counts communities, not rows)`
            : "";
        // Said whether or not any were listed: "not listed" must not read as "there are none".
        const u = r.unclustered;
        const unclustered = `\nunclustered: ${u.count} function(s) have no CALLS edge and belong to no community${
          u.count === 0 ? "" : u.listed ? " (listed above)" : " (not listed; --include-unclustered lists them)"
        }`;
        return `communities:\n${fmtNodes(r.communities)}${cut}${unclustered}`;
      });
      break;
    }
    case "related": {
      if (!a1) throw new Error("related requires a <node-id>");
      const rows = await cmdRelated(conn, a1, num(values.depth, 2), num(values.limit, 10));
      out(rows, values.json, (d) => `related(${a1}):\n${fmtNodes(d as Array<{ name: string; label: string; rank: number }>)}`);
      break;
    }
    case "refs": {
      if (a1 !== "check") throw new Error(`unknown refs subcommand: ${a1 ?? "(none)"} — only "refs check <path...>" is supported`);
      const paths = positionals.slice(2);
      if (paths.length === 0) throw new Error("refs check requires at least one <path>");
      const r = await cmdRefsCheck(conn, paths);
      out(r, values.json, (d) => {
        const res = d as RefCheckResult;
        // First line of the report, not a footnote: a reader who sees only the list must not take it for a complete one.
        const incomplete = (res.incompleteReasons ?? []).map((why) => `refs check: INCOMPLETE — ${why}\n`).join("");
        if (res.items.length === 0) {
          return `${incomplete}refs check: no references found in ${res.filesScanned.length} file(s)`;
        }
        const counts = res.items.reduce<Record<string, number>>((acc, it) => {
          acc[it.status] = (acc[it.status] ?? 0) + 1;
          return acc;
        }, {});
        const summary = Object.entries(counts)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ");
        const lines = res.items.map((it) => {
          const extra =
            it.status === "moved"
              ? ` → ${it.location}`
              : it.status === "present" && it.location
                ? ` (${it.location})`
                : it.candidates
                  ? ` [candidates: ${it.candidates.join(", ")}]`
                  : it.reason
                    ? ` — ${it.reason}`
                    : "";
          return `  [${it.status}] ${it.kind} \`${it.raw}\` (${it.sourceFile}:${it.sourceLine})${extra}`;
        });
        return `${incomplete}refs check: ${res.items.length} reference(s) in ${res.filesScanned.length} file(s) (${summary}):\n${lines.join("\n")}`;
      });
      // A result built on a list that could not be read is not a verdict (the same rule as `missing` above, from the
      // other side): the report is printed in full, stderr says what is unknown (also under --json, whose stdout is
      // the JSON alone) and the exit status refuses to call it a pass.
      if (r.incompleteReasons && r.incompleteReasons.length > 0) {
        exitCode = 1;
        for (const reason of r.incompleteReasons) {
          process.stderr.write(`egr: refs check: INCOMPLETE — ${reason}; the result may be wrong, not just partial (exit 1)\n`);
        }
      }
      // A `missing` reference is a finding a script must be able to stop on
      // (XSPEC-476 R4): the report is printed in full above, and the exit status
      // carries the verdict. `unresolvable` is "cannot tell" and does not fail.
      const missingCount = r.items.filter((it) => it.status === "missing").length;
      if (missingCount > 0) {
        exitCode = 1;
        process.stderr.write(`egr: refs check: ${missingCount} reference(s) are missing (exit 1) — the list is above\n`);
      }
      break;
    }
    default:
      throw new Error(`unknown command: ${cmd}\n\n${HELP}`);
  }
  // A command that opened the graph for writing has not proven it could write
  // until something is committed. Several of them (`related` on a seed with
  // no neighbours, `god-nodes` on an empty graph) finish without touching the
  // file, so a lock refusal could surface only in the engine's own exit
  // output — printed, with exit status 0 (XSPEC-457 R2, reported on Windows).
  // CHECKPOINT forces the engine to take and use the write lock now, turning
  // that case into an error; it also folds the write-ahead log into the
  // database file, so the next open (an MCP query, which now opens per call)
  // does not replay it — measured 245 ms vs 49 ms per query on a 4 MB log.
  //
  // A CHECKPOINT that fails for any other reason (disk full) comes after the command did its
  // work and printed its result: it is a warning, not a failure (see `checkpointOrWarn`).
  await checkpointOrWarn(conn);
  process.exit(exitCode); // do not await conn.close() (ryugraph+tree-sitter teardown caveat)
}

main().catch((err) => {
  process.stderr.write(`egr: ${err instanceof Error ? err.message : String(err)}\n`);
  // The engine's own text ("Could not set lock on file") does not say who holds
  // it or what to do. Another process has the graph open for writing — an
  // `egr` command still running, or `egr serve`. An MCP server no longer holds
  // it between queries (XSPEC-457 R1).
  if (isLockContention(err)) {
    process.stderr.write(
      "egr: another process has this graph open for writing (an egr command that has not finished, or `egr serve`). " +
        "Wait for it to finish and retry; an `egr mcp` server does not hold the graph between queries.\n",
    );
  }
  // What the command had written before it failed still belongs in graph.db, not only in the log.
  // Best effort and silent: the failure being reported is the one above, and if the graph is locked
  // by another process this cannot take the lock either.
  const writer = openedForWriting;
  const folded = writer ? checkpointOrWarn(writer, () => undefined).catch(() => undefined) : Promise.resolve();
  folded.finally(() => process.exit(1));
});
