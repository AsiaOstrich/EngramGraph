/**
 * EngramGraph MCP server.
 *
 * Exposes the graph-memory queries as MCP tools so any MCP-capable coding
 * assistant (Claude Code, Codex, Cursor, Windsurf, ...) can use EngramGraph as a
 * plug-and-play code + knowledge graph. A thin adapter over the existing,
 * tested query functions — zero LLM, deterministic.
 *
 * Tools: index_code, index_docs, call_chain, impact_analysis, ingest_feedback.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { GraphConnection } from "../graph-db/connection.js";
import { indexProject, callChain } from "../code-graph/index.js";
import { indexKnowledgeDocs, impactAnalysis } from "../knowledge-graph/index.js";
import { applyFeedback, feedbackForEventType } from "../sage/index.js";

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
 * per-call (kuzu+tree-sitter teardown caveat).
 */
export function createMcpServer(conn: GraphConnection): McpServer {
  const server = new McpServer({ name: "engramgraph", version: "0.1.0" });

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
        return ok(await indexProject(conn, files));
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
        return ok(await callChain(conn, symbol, direction ?? "both", depth ?? 1));
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

  return server;
}
