/**
 * EngramGraph MCP server.
 *
 * Exposes the graph-memory queries as MCP tools so any MCP-capable coding
 * assistant (Claude Code, Codex, Cursor, Windsurf, ...) can use EngramGraph as a
 * plug-and-play code + knowledge graph. A thin adapter over the existing,
 * tested query functions — zero LLM, deterministic.
 *
 * Tools: index_code, index_docs, call_chain, impact_analysis, ingest_feedback,
 * implementers, implemented_specs, related, blindspots, signatures, doctor,
 * refs_check.
 *
 * ## The graph is held per query, not per session (XSPEC-457 R1)
 *
 * The server asks a {@link GraphSource} for the graph each time a tool needs
 * it (`graph.use(...)`). Over stdio that source is a `GraphLease`: open
 * read-only, answer, close. A server that stays open all day therefore does
 * not keep the graph locked all day — `egr index` in a terminal succeeds while
 * the editor is open, on every platform, and the next query sees its result.
 * A query that meets a writer retries briefly and then says so; it never
 * answers with an empty result it could not actually look up.
 *
 * ## Tool annotations (DEC-115 L2)
 *
 * Every `registerTool` call below carries an `annotations` object (the MCP
 * spec's `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint` —
 * all four are HINTS, not guarantees a client may skip verifying, but a
 * server that omits them entirely gives a client nothing to go on). Each one
 * was set by reading the tool's own implementation, not by trusting its
 * name or description — `related` is the concrete reason this mattered:
 * despite reading like a query, it is NOT read-only (see its own comment
 * below and `read-only-commands.ts`'s module doc for the CLI-side version of
 * the same trap, XSPEC-374).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import pkg from "../../package.json" with { type: "json" };
import type { GraphConnection } from "../graph-db/connection.js";
import { fixedGraph, GraphBusyError, type GraphSource } from "../graph-db/lease.js";
import {
  indexProject,
  callChain,
  implementers,
  implementedSpecs,
  readIndexHealth,
  NotInGraphError,
  requireFunction,
  requireSpec,
} from "../code-graph/index.js";
import { cmdBlindspots, cmdSignatures, cmdDoctor } from "../cli/run.js";
import { existsSync } from "node:fs";
import { readManifest, upsertRun, writeManifest } from "../code-graph/parse-manifest.js";
import { indexKnowledgeDocs, impactAnalysis } from "../knowledge-graph/index.js";
import { applyFeedback, feedbackForEventType, CONFIDENCE_LABELS } from "../sage/index.js";
import { related } from "../structural-memory/index.js";
import { checkRefs } from "../cli/refs-check.js";
import { READ_ONLY_REFUSAL_MARKER } from "./read-only-refusal.mjs";

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
 * One place that turns a thrown error into a tool result. A lock held by a
 * writer and a name that is not in the graph are both ANSWERS, not crashes —
 * and neither may read as an empty result (XSPEC-457 R1, R4).
 */
const failFrom = (e: unknown) => {
  if (e instanceof NotInGraphError || e instanceof GraphBusyError) return fail(e.message);
  return failFrom(e);
};

/**
 * Register EngramGraph's tools on an MCP server backed by a graph.
 *
 * `graph` is either a {@link GraphSource} (the stdio server passes a
 * `GraphLease`, which holds the graph only while a tool runs) or a bare
 * {@link GraphConnection} the caller owns and keeps open (tests, embedding).
 * A bare connection is never closed here.
 *
 * `opts.manifestPath` (XSPEC-334 R2) is the graph's parse-health manifest
 * sibling — when given, code queries attach an `indexHealth` field warning the
 * querier that the answer may be built on partially-parsed files (see
 * `index-health.ts`). Omitting it disables the surfacing (queries behave
 * exactly as before R2).
 */
export function createMcpServer(graph: GraphConnection | GraphSource, opts: { manifestPath?: string } = {}): McpServer {
  const server = new McpServer({ name: "engramgraph", version: "0.1.0" });
  const manifestPath = opts.manifestPath;
  const source: GraphSource = "use" in graph ? graph : fixedGraph(graph);

  /**
   * Refusal for a tool that writes, on a read-only source (XSPEC-374). The
   * engine is single-writer and two writers corrupt the graph, so this server
   * never writes. Names the alternative, and that alternative has to work on
   * every platform: it used to say "run `egr ...`", which on Windows failed
   * for as long as this server was open (XSPEC-457 R1). It works now because
   * the server only holds the graph while a query is running.
   *
   * The phrase that identifies this as a refusal is NOT written here: it is
   * `READ_ONLY_REFUSAL_MARKER`, shared with the release verifier that has to
   * recognise it (see `read-only-refusal.mjs` for why that is one definition).
   */
  const readOnlyRefusal = (tool: string, cliEquivalent: string) =>
    fail(
      `${tool} ${READ_ONLY_REFUSAL_MARKER}: it only reads the graph, so a writer in a terminal ` +
        `can never collide with it. Run \`${cliEquivalent}\` in a terminal — that works while this server is ` +
        `running, because the server holds the graph only for the duration of a query. ` +
        `This server sees the result on its next query; no restart is needed.`,
    );

  server.registerTool(
    "index_code",
    {
      title: "Index code",
      description:
        "Index source files into the code graph (tree-sitter → Function/Class/Module + cross-file CALLS). Pass file contents.",
      inputSchema: {
        files: z.array(z.object({ path: z.string(), source: z.string() })),
      },
      // Writes the graph (indexProject → writer.ts's writeFragment). Not
      // destructive: writer.ts's own doc says it "idempotently MERGE"s a
      // fragment in — it never DELETEs nodes/edges outside what's passed, so
      // running it twice with the SAME files converges rather than
      // compounding (idempotentHint: true, verified by reading writer.ts,
      // not assumed from the tool's name).
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ files }) => {
      if (source.readOnly) return readOnlyRefusal("index_code", "egr index <dir>");
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
        const { parseHealth, ...res } = await source.use((conn) => indexProject(conn, files));
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
        return failFrom(e);
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
      // Same reasoning as index_code: writes via writer.ts's idempotent MERGE.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ docs }) => {
      if (source.readOnly) return readOnlyRefusal("index_docs", "egr index <dir> --docs");
      try {
        return ok(await source.use((conn) => indexKnowledgeDocs(conn, docs)));
      } catch (e) {
        return failFrom(e);
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
      // Pure MATCH query — no writeFragment call anywhere in callChain/query.ts.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ symbol, direction, depth }) => {
      try {
        // `requireFunction` answers "is this symbol in the graph at all" before the
        // query does: an unknown name used to come back as `callers: []`, which is
        // the same answer as "nothing calls it" (XSPEC-457 R4). It also returns the
        // symbol's own definition file(s), the anchor for the blindspot match.
        return await source.use(async (conn) => {
          const defFiles = await requireFunction(conn, symbol);
          const result = await callChain(conn, symbol, direction ?? "both", depth ?? 1);
          // Coarse index-health (R2). The anchor set for the blindspot match is
          // the queried symbol's OWN definition file(s) PLUS the result files —
          // critically including the def file(s), because the flagship case is an
          // EMPTY result ("nothing calls foo, safe to delete") which has no
          // result files: without the def-file anchor that highest-risk answer
          // would carry no warning even when foo's neighborhood has unparsed
          // files.
          const anchor = [...defFiles, ...result.callers.map((n) => n.file), ...result.callees.map((n) => n.file)];
          const health = readIndexHealth(manifestPath, anchor);
          // `symbolFound` is always true here (absence is an error above); it is in
          // the payload so a consumer reading `callers: []` can see which kind of
          // empty it is.
          const found = { ...result, symbolFound: true as const };
          return ok(health ? { ...found, indexHealth: health } : found);
        });
      } catch (e) {
        return failFrom(e);
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
      // Pure MATCH query (knowledge-graph/index.ts's impactAnalysis).
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ nodeId, maxHops }) => {
      try {
        // An id that is not a spec in the graph is "unknown", not "no decisions
        // affect it" — both used to come back as `decisions: []` (XSPEC-457 R4).
        return ok(
          await source.use(async (conn) => {
            await requireSpec(conn, nodeId);
            return impactAnalysis(conn, nodeId, maxHops ?? 3);
          }),
        );
      } catch (e) {
        return failFrom(e);
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
        nodeLabel: z.enum(CONFIDENCE_LABELS).optional(),
        weight: z.number().optional(),
      },
      // Writes a confidence delta (sage/writer.ts's applyFeedback: `after =
      // clamp(before + delta(event))`) — cumulative, so NOT idempotent:
      // calling it twice with identical args changes the score twice.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ nodeId, type, nodeLabel, weight }) => {
      if (source.readOnly) return readOnlyRefusal("ingest_feedback", "egr feedback <type> <node-id>");
      try {
        const mapped = feedbackForEventType(type);
        const update = await source.use((conn) =>
          applyFeedback(
            conn,
            { nodeId, signal: mapped.signal, weight: weight ?? mapped.weight, source: "mcp" },
            nodeLabel ?? "Function",
          ),
        );
        return update ? ok(update) : fail(`node not found: ${nodeLabel ?? "Function"} ${nodeId}`);
      } catch (e) {
        return failFrom(e);
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
      // Pure MATCH query (code-graph/query.ts's implementers).
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ specId }) => {
      try {
        const result = await source.use((conn) => implementers(conn, specId));
        const health = readIndexHealth(manifestPath, result.modules.map((m) => m.module));
        return ok(health ? { ...result, indexHealth: health } : result);
      } catch (e) {
        return failFrom(e);
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
      // Pure MATCH query (code-graph/query.ts's implementedSpecs).
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ moduleId }) => {
      try {
        const result = await source.use((conn) => implementedSpecs(conn, moduleId));
        // The queried file itself is the relevant "result file" here.
        const health = readIndexHealth(manifestPath, [result.module]);
        return ok(health ? { ...result, indexHealth: health } : result);
      } catch (e) {
        return failFrom(e);
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
      // readOnlyHint is FALSE, deliberately, despite this tool reading like a
      // query: ranking installs the algo extension and builds a projected
      // graph (both writes, see the comment in this tool's handler below and
      // `read-only-commands.ts`'s module doc, XSPEC-374). Getting this wrong
      // is exactly the trap DEC-115 called out annotations to guard against.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ seedId, depth, limit }) => {
      try {
        // `related` READS in the sense that matters to a caller and WRITES in
        // the sense that matters to the engine: ranking requires installing the
        // algo extension and building a projected graph. Both are writes, so it
        // cannot run here (XSPEC-374).
        //
        // The refusal has to come before the call, not after, because the
        // engine's own error arrives only when the seed exists — `related`
        // returns early on an unknown id, so without this an agent would see
        // this tool work on ids that are absent and fail on ids that are there.
        if (source.readOnly) return readOnlyRefusal("related", `egr related <seed-id>`);
        return ok(await source.use((conn) => related(conn, seedId, depth ?? 2, limit ?? 10)));
      } catch (e) {
        return failFrom(e);
      }
    },
  );

  // --- Diagnostics (XSPEC-373 B6) ---
  //
  // These three existed only as CLI commands, so an agent that received
  // `possiblyIncomplete: true` on a query had no way to ask what was missing.
  // The whole point of surfacing index health to a machine consumer is that it
  // can then act on it; without these it could only relay the warning to a
  // human and stop.

  server.registerTool(
    "blindspots",
    {
      title: "Blindspots (where the graph may be incomplete)",
      description:
        "Files that parsed partially or failed outright, from the parse-health manifest — the places the graph may be missing nodes/edges. Use this after a query returns `indexHealth.possiblyIncomplete` to find out WHAT is missing.",
      inputSchema: {},
      // Reads a JSON manifest file off disk; never opens the graph connection at all.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        if (!manifestPath) {
          return fail(
            "blindspots needs the parse-health manifest, and this server was started without a manifestPath. " +
              "Nothing is wrong with the graph — this tool simply cannot see it. Start the server with manifestPath set.",
          );
        }
        // `manifestPresent` separates "indexed, nothing wrong" from "never
        // indexed": cmdBlindspots returns all-zeros for both, and an agent
        // reading `blindspots: []` would otherwise conclude the graph is clean
        // when in fact nothing has ever been measured (XSPEC-373).
        return ok({ ...cmdBlindspots(manifestPath), manifestPresent: existsSync(manifestPath) });
      } catch (e) {
        return failFrom(e);
      }
    },
  );

  server.registerTool(
    "signatures",
    {
      title: "Unparsed files grouped by cause",
      description:
        "Files that failed or partially parsed, grouped by root cause rather than listed one by one — turns '584 files' into '1 problem'. Use after `blindspots` when the list is long.",
      inputSchema: {},
      // Same manifest-file read as blindspots; never opens the graph.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        if (!manifestPath) {
          return fail(
            "signatures needs the parse-health manifest, and this server was started without a manifestPath. " +
              "Nothing is wrong with the graph — this tool simply cannot see it. Start the server with manifestPath set.",
          );
        }
        return ok({ ...cmdSignatures(manifestPath), manifestPresent: existsSync(manifestPath) });
      } catch (e) {
        return failFrom(e);
      }
    },
  );

  server.registerTool(
    "doctor",
    {
      title: "What this installation can do on this machine",
      description:
        "Which languages are available and why any are not, what had to be compiled here, and which commands need network access. Answers WITHOUT opening the graph, so it still works when indexing is what is broken.",
      inputSchema: {},
      // cmdDoctor (run.ts) only inspects local module resolution/platform
      // info; it REPORTS which OTHER commands need network, it does not
      // itself make any network call — verified by reading run.ts's
      // cmdDoctor, not inferred from its description.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return ok(cmdDoctor(source.path));
      } catch (e) {
        return failFrom(e);
      }
    },
  );

  // --- Memory reference checking (DEC-115 L2) ---
  //
  // Only-query, same shape as `blindspots`/`signatures`/`doctor` above (a
  // filesystem/git read, not a graph write) — this is what makes it safe to
  // declare `readOnlyHint: true` without the `related`-style trap: nothing
  // in `checkRefs` calls `conn.query` with anything but MATCH, and it never
  // touches the filesystem it's given except to `readFileSync` (verified in
  // `test/refs-check.test.ts` by diffing node/edge counts before/after).

  server.registerTool(
    "refs_check",
    {
      title: "Check code references in Markdown",
      description:
        "Check file-path and symbol/function references (backtick-quoted) inside Markdown files/directories against the current graph and git. Reports each reference as present | moved (+ new location) | missing | unresolvable (e.g. a reference into a repo this graph does not index — never conflated with missing). Read-only: does not modify the graph or the files checked.",
      inputSchema: {
        paths: z.array(z.string()),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ paths }) => {
      try {
        return ok(await source.use((conn) => checkRefs(conn, paths)));
      } catch (e) {
        return failFrom(e);
      }
    },
  );

  return server;
}
