// implements XSPEC-457
/**
 * Start the EngramGraph MCP server over stdio. Shared by the `egr-mcp` bin
 * (src/mcp/stdio.ts) and the `egr mcp` CLI subcommand.
 *
 * The graph DB path is resolved ONCE at startup: a long-lived server binds to
 * one graph for its lifetime. To follow a `git checkout` onto another branch's
 * graph, reconnect/restart the server. The resolved path is logged to stderr
 * (stdout is reserved for the MCP protocol).
 *
 * ## The graph is NOT held open between queries (XSPEC-457 R1)
 *
 * This server is long-lived — it runs as long as the editor is open. It used
 * to open the graph at startup, read-only, and keep it. Read-only was right
 * (XSPEC-374: a writer here would corrupt the graph the moment a terminal
 * command also wrote), but the engine takes its lock when the file is opened,
 * not when something is written, so a reader held all day refused every
 * `egr index`, `egr feedback`, `egr god-nodes` and `egr related` typed in a
 * terminal. Measured on macOS and reported on Windows 11.
 *
 * Now each tool call opens the graph read-only, answers, and closes it (see
 * `graph-db/lease.ts`). Between queries nothing is held, so the terminal
 * writers work on every platform, and the next query sees what they wrote.
 * The four writing tools still say they cannot run here and name the command
 * that does the job — a command that now works while this server is open.
 *
 * Startup no longer requires the graph to exist: a server started before the
 * first `egr index` answers each query with "No graph at …, run `egr index`"
 * and starts working as soon as the graph appears, with no restart.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { resolveDbPath } from "../graph-db/open.js";
import { GraphLease } from "../graph-db/lease.js";
import { manifestPathForDb } from "../code-graph/parse-manifest.js";
import { createMcpServer } from "./server.js";

export async function startMcpStdio(dbPath?: string): Promise<void> {
  const path = resolveDbPath(dbPath ?? {});
  process.stderr.write(`egr-mcp: graph ${path}\n`);
  const lease = new GraphLease(path);
  // Parse-health manifest sibling (R2): lets code queries flag answers built
  // on partially-parsed files. Absent manifest → queries behave as pre-R2.
  const server = createMcpServer(lease, { manifestPath: manifestPathForDb(path) });
  await server.connect(new StdioServerTransport());
  // Stays alive on stdio. Nothing is held between tool calls.
}
