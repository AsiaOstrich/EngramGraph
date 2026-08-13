/**
 * Start the EngramGraph MCP server over stdio. Shared by the `egr-mcp` bin
 * (src/mcp/stdio.ts) and the `egr mcp` CLI subcommand.
 *
 * The graph DB is resolved ONCE at startup: a long-
 * lived server binds to one graph for its lifetime. To follow a `git checkout`
 * onto another branch's graph, reconnect/restart the server. The resolved path
 * is logged to stderr (stdout is reserved for the MCP protocol).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { openGraph, resolveDbPath } from "../graph-db/open.js";
import { manifestPathForDb } from "../code-graph/parse-manifest.js";
import { createMcpServer } from "./server.js";

export async function startMcpStdio(dbPath?: string): Promise<void> {
  const path = resolveDbPath(dbPath ?? {});
  process.stderr.write(`egr-mcp: graph ${path}\n`);
  // Read-only, deliberately (XSPEC-374). This server is long-lived: it holds
  // the graph for as long as the editor is open. Held for WRITING, it made
  // every `egr` command in a terminal fail — and worse, writer-vs-writer
  // corrupts the database rather than refusing cleanly. Held for READING, any
  // number of terminal queries work alongside it.
  //
  // The cost is that the four writing tools cannot run here; they say so
  // (see `createMcpServer`) and point at the CLI. Querying is what an
  // assistant needs a long-lived connection for; indexing is what the user
  // and the freshness hooks already do.
  const conn = await openGraph(path, { readOnly: true });
  // Parse-health manifest sibling (R2): lets code queries flag answers built
  // on partially-parsed files. Absent manifest → queries behave as pre-R2.
  const server = createMcpServer(conn, { manifestPath: manifestPathForDb(path) });
  await server.connect(new StdioServerTransport());
  // Stays alive on stdio; the connection is never closed (teardown caveat).
}
