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
import { cmdIndex, cmdCallers, cmdCallees, cmdImplementers, cmdImplementedSpecs, cmdImpact, cmdFeedback, cmdTop, cmdGodNodes, cmdCommunities, cmdRelated, cmdGc, type GcResult } from "./run.js";
import type { ConfidenceLabel } from "../sage/index.js";

const HELP = `egr — code + knowledge graph memory CLI

Usage: egr <command> [args] [options]

Commands:
  index <dir> [--docs] [--clean]  Index source (.ts/.js/.cs) into the code graph;
                                  --docs also indexes .md; --clean drops the
                                  graph first (prunes deleted nodes)
  callers <symbol> [--depth N]    Functions that (transitively) call <symbol>
  callees <symbol> [--depth N]    Functions that <symbol> (transitively) calls
  implementers <spec-id>          Files (+ functions) that implement a spec (spec→code)
  implemented-by <module-path>    Specs a file declares it implements (code→spec)
  impact <spec-id> [--max-hops N] Decisions in a spec's impact chain
  feedback <type> <node-id> [--label L]
                                  Evolve confidence (type: test_fail|test_pass|human_fix)
  top <label> [--limit N]         Highest-confidence nodes (label: Function|Spec|Decision|Doc)
  god-nodes [--limit N]           Highest-importance nodes across code + knowledge (PageRank)
  communities                     Function-call clusters (Louvain over CALLS edges)
  related <node-id> [--depth N] [--limit N]
                                  Nodes important *around* a seed (seeded PageRank approx.)
  gc [--dry-run]                  Remove per-branch graphs for deleted branches
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
Env ENGRAM_ISOLATION=git-branch enables per-branch isolation without the flag.`;

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
            r.communityId != null ? `community ${r.communityId}` : undefined,
          ].filter(Boolean);
          return `  ${r.name ?? r.id}${extras.length ? ` (${extras.join(", ")})` : ""}`;
        })
        .join("\n")
    : "  (none)";

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
      "dry-run": { type: "boolean" },
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

  // Long-running commands manage their own lifecycle (no exit).
  if (cmd === "mcp") return startMcpStdio(resolveDbPath(loc));
  if (cmd === "serve") {
    const conn = await openGraph(loc);
    const app = createServer({ connection: conn });
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
  const conn = await openGraph(loc);
  switch (cmd) {
    case "index": {
      if (!a1) throw new Error("index requires a <dir>");
      const r = await cmdIndex(conn, { dir: a1, docs: values.docs, clean: values.clean });
      out(r, values.json, (d) => {
        const s = d as Awaited<ReturnType<typeof cmdIndex>>;
        const k = s.knowledge ? `\nknowledge: ${s.knowledge.specs} specs, ${s.knowledge.decisions} decisions, ${s.knowledge.impacts} impacts, ${s.knowledge.supersedes} supersedes, ${s.knowledge.relates} relates` : "";
        return `code: ${s.code.files} files, ${s.code.functions} functions, ${s.code.classes} classes, ${s.code.calls} calls, ${s.code.implements} implements (ambiguous ${s.code.ambiguous}, unresolved ${s.code.unresolved})${k}`;
      });
      break;
    }
    case "callers":
    case "callees": {
      if (!a1) throw new Error(`${cmd} requires a <symbol>`);
      const rows = cmd === "callers" ? await cmdCallers(conn, a1, num(values.depth, 1)) : await cmdCallees(conn, a1, num(values.depth, 1));
      out(rows, values.json, (d) => `${cmd}(${a1}):\n${fmtNodes(d as Array<{ name: string; file: string }>)}`);
      break;
    }
    case "implementers": {
      if (!a1) throw new Error("implementers requires a <spec-id>");
      const r = await cmdImplementers(conn, a1);
      out(r, values.json, (d) => {
        const res = d as Awaited<ReturnType<typeof cmdImplementers>>;
        const head = `implementers(${res.spec})${res.title ? ` — ${res.title}` : ""}:`;
        const body = res.modules.length
          ? res.modules.map((m) => `  ${m.module}${m.functions.length ? ` (${m.functions.join(", ")})` : ""}`).join("\n")
          : "  (none)";
        return `${head}\n${body}`;
      });
      break;
    }
    case "implemented-by": {
      if (!a1) throw new Error("implemented-by requires a <module-path>");
      const r = await cmdImplementedSpecs(conn, a1);
      out(r, values.json, (d) => {
        const res = d as Awaited<ReturnType<typeof cmdImplementedSpecs>>;
        return `implemented-by(${res.module}):\n${res.specs.length ? res.specs.map((s) => `  ${s.id}${s.title ? ` — ${s.title}` : ""}`).join("\n") : "  (none)"}`;
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
      const label = (values.label as ConfidenceLabel) ?? "Function";
      const r = await cmdFeedback(conn, a1, a2, label);
      out(r, values.json, (d) => (d ? `${(d as { nodeId: string }).nodeId}: ${(d as { before: number }).before} → ${(d as { after: number }).after}` : `node not found: ${label} ${a2}`));
      break;
    }
    case "top": {
      if (!a1) throw new Error("top requires a <label> (Function|Spec|Decision|Doc)");
      const rows = await cmdTop(conn, a1 as ConfidenceLabel, num(values.limit, 10));
      out(rows, values.json, (d) => `top ${a1}:\n${fmtNodes(d as Array<{ name: string; confidence: number }>)}`);
      break;
    }
    case "god-nodes": {
      const rows = await cmdGodNodes(conn, num(values.limit, 10));
      out(rows, values.json, (d) => `god-nodes:\n${fmtNodes(d as Array<{ name: string; label: string; rank: number }>)}`);
      break;
    }
    case "communities": {
      const rows = await cmdCommunities(conn);
      out(rows, values.json, (d) => `communities:\n${fmtNodes(d as Array<{ name: string; communityId: number }>)}`);
      break;
    }
    case "related": {
      if (!a1) throw new Error("related requires a <node-id>");
      const rows = await cmdRelated(conn, a1, num(values.depth, 2), num(values.limit, 10));
      out(rows, values.json, (d) => `related(${a1}):\n${fmtNodes(d as Array<{ name: string; label: string; rank: number }>)}`);
      break;
    }
    default:
      throw new Error(`unknown command: ${cmd}\n\n${HELP}`);
  }
  process.exit(0); // do not await conn.close() (ryugraph+tree-sitter teardown caveat)
}

main().catch((err) => {
  process.stderr.write(`egr: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
