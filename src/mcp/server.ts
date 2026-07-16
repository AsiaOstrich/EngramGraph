/**
 * EngramGraph MCP server.
 *
 * Exposes the graph-memory queries as MCP tools so any MCP-capable coding
 * assistant (Claude Code, Codex, Cursor, Windsurf, ...) can use EngramGraph as a
 * plug-and-play code + knowledge graph. A thin adapter over the existing,
 * tested query functions — zero LLM, deterministic.
 *
 * Tools: index_code, index_docs, call_chain, impact_analysis, ingest_feedback,
 * implementers, implemented_specs, related.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import pkg from "../../package.json" with { type: "json" };
import type { GraphConnection } from "../graph-db/connection.js";
import { indexProject, callChain, definitionFiles, implementers, implementedSpecs, readIndexHealth } from "../code-graph/index.js";
import { readManifest, upsertRun, writeManifest } from "../code-graph/parse-manifest.js";
import { indexKnowledgeDocs, impactAnalysis } from "../knowledge-graph/index.js";
import { applyFeedback, feedbackForEventType } from "../sage/index.js";
import { related } from "../structural-memory/index.js";

/** Sentinel manifest root for MCP-side `index_code` (R2). See its use below. */
const MCP_INDEX_ROOT = "mcp:index_code";
const EGR_VERSION = (pkg as { version: string }).version;

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (message: string) => ({
  content: [{ type: "text" as const, text: `error: ${message}` }],
  isError: true,
});

/**
 * Register EngramGraph's tools on an MCP server backed by a graph connection.
 * The connection is long-lived (caller owns its lifecycle); never closed
 * per-call (ryugraph+tree-sitter teardown caveat).
 *
 * `opts.manifestPath` (XSPEC-334 R2) is the graph's parse-health manifest
 * sibling — when given, code queries attach an `indexHealth` field warning the
 * querier that the answer may be built on partially-parsed files (see
 * `index-health.ts`). Omitting it disables the surfacing (queries behave
 * exactly as before R2).
 */
export function createMcpServer(conn: GraphConnection, opts: { manifestPath?: string } = {}): McpServer {
  const server = new McpServer({ name: "engramgraph", version: "0.1.0" });
  const manifestPath = opts.manifestPath;

  server.registerTool(
    "index_code",
    {
      title: "Index code",
      description:
        "Index source files into the code graph (tree-sitter → Function/Class/Module + cross-file CALLS). Pass file contents.",
      inputSchema: {
        files: z.array(z.object({ path: z.string(), source: z.string() })),
      },
    },
    async ({ files }) => {
      try {
        // The per-file `parseHealth` array is not returned in the tool result
        // (that stays the pre-R2 shape — health is surfaced on QUERY responses
        // as the compact `indexHealth`, not on index_code). But it IS written
        // to the manifest under a sentinel root (R2): otherwise a long-running
        // server would keep warning about blindspots the agent already fixed
        // via index_code (false positive → warning fatigue) and miss new
        // failures (false negative) — the served health would drift from the
        // graph it describes. Known limitation: successive index_code batches
        // replace this one section (one MCP "project" tracked at a time).
        // Best-effort — a manifest-write failure must not fail the index.
        const { parseHealth, ...res } = await indexProject(conn, files);
        if (manifestPath) {
          try {
            const next = upsertRun(readManifest(manifestPath), MCP_INDEX_ROOT, new Date().toISOString(), parseHealth, EGR_VERSION);
            writeManifest(manifestPath, next);
          } catch {
            // observability write failure must not undo a successful index
          }
        }
        return ok(res);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "index_docs",
    {
      title: "Index docs",
      description:
        "Index spec/decision markdown into the knowledge graph (front-matter related/impacts/supersedes + [[ref]] → Spec/Decision + IMPACTS/SUPERSEDES).",
      inputSchema: {
        docs: z.array(z.object({ content: z.string(), fallbackId: z.string().optional() })),
      },
    },
    async ({ docs }) => {
      try {
        return ok(await indexKnowledgeDocs(conn, docs));
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "call_chain",
    {
      title: "Call chain",
      description:
        "Who calls / is called by a function symbol — 'what breaks if I change X?'. direction: callers | callees | both.",
      inputSchema: {
        symbol: z.string(),
        direction: z.enum(["callers", "callees", "both"]).optional(),
        depth: z.number().int().optional(),
      },
    },
    async ({ symbol, direction, depth }) => {
      try {
        const result = await callChain(conn, symbol, direction ?? "both", depth ?? 1);
        // Coarse index-health (R2). The anchor set for the blindspot match is
        // the queried symbol's OWN definition file(s) PLUS the result files —
        // critically including the def file(s), because the flagship case is an
        // EMPTY result ("nothing calls foo, safe to delete") which has no
        // result files: without the def-file anchor that highest-risk answer
        // would carry no warning even when foo's neighborhood has unparsed
        // files. See `definitionFiles`' doc.
        const anchor = [
          ...(await definitionFiles(conn, symbol)),
          ...result.callers.map((n) => n.file),
          ...result.callees.map((n) => n.file),
        ];
        const health = readIndexHealth(manifestPath, anchor);
        return ok(health ? { ...result, indexHealth: health } : result);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "impact_analysis",
    {
      title: "Impact analysis",
      description:
        "Decisions in the impact chain of a spec (cross-domain: which decisions affect this spec), via IMPACTS + multi-hop SUPERSEDES.",
      inputSchema: {
        nodeId: z.string(),
        maxHops: z.number().int().optional(),
      },
    },
    async ({ nodeId, maxHops }) => {
      try {
        return ok(await impactAnalysis(conn, nodeId, maxHops ?? 3));
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "ingest_feedback",
    {
      title: "Ingest feedback (SAGE)",
      description:
        "Evolve a node's confidence from a feedback event (test_fail / test_pass / human_fix). nodeLabel: Function | Spec | Decision | Doc.",
      inputSchema: {
        nodeId: z.string(),
        type: z.string(),
        nodeLabel: z.enum(["Function", "Spec", "Decision", "Doc"]).optional(),
        weight: z.number().optional(),
      },
    },
    async ({ nodeId, type, nodeLabel, weight }) => {
      try {
        const mapped = feedbackForEventType(type);
        const update = await applyFeedback(
          conn,
          { nodeId, signal: mapped.signal, weight: weight ?? mapped.weight, source: "mcp" },
          nodeLabel ?? "Function",
        );
        return update ? ok(update) : fail(`node not found: ${nodeLabel ?? "Function"} ${nodeId}`);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "implementers",
    {
      title: "Implementers (spec → code)",
      description:
        "Files that declare `// implements <specId>` and the functions they define — 'which code implements this spec?'. Reads IMPLEMENTS(Module→Spec) + DEFINES.",
      inputSchema: {
        specId: z.string(),
      },
    },
    async ({ specId }) => {
      try {
        const result = await implementers(conn, specId);
        const health = readIndexHealth(manifestPath, result.modules.map((m) => m.module));
        return ok(health ? { ...result, indexHealth: health } : result);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "implemented_specs",
    {
      title: "Implemented specs (code → spec)",
      description:
        "Specs a file declares it implements — 'which spec governs this code?'. moduleId is the file's indexed path. Reads IMPLEMENTS(Module→Spec).",
      inputSchema: {
        moduleId: z.string(),
      },
    },
    async ({ moduleId }) => {
      try {
        const result = await implementedSpecs(conn, moduleId);
        // The queried file itself is the relevant "result file" here.
        const health = readIndexHealth(manifestPath, [result.module]);
        return ok(health ? { ...result, indexHealth: health } : result);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "related",
    {
      title: "Related nodes",
      description:
        "Nodes structurally important around a seed id (seeded PageRank over all edge types) — crosses Function/Spec/Module/Decision. 'what's connected to X?'.",
      inputSchema: {
        seedId: z.string(),
        depth: z.number().int().optional(),
        limit: z.number().int().optional(),
      },
    },
    async ({ seedId, depth, limit }) => {
      try {
        return ok(await related(conn, seedId, depth ?? 2, limit ?? 10));
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return server;
}
