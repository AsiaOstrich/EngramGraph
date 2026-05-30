#!/usr/bin/env node
/**
 * CodeSage MCP server — stdio entry (the bin a coding assistant launches).
 *
 * Opens a persistent graph DB (env CODESAGE_DB, default ./.codesage/graph.db),
 * ensures the schema, and serves the CodeSage tools over stdio. The connection
 * is long-lived for the whole session; it is not closed (kuzu+tree-sitter
 * native teardown caveat) — the OS reclaims it on process exit.
 *
 * Register with an assistant (example, Claude Code):
 *   claude mcp add codesage -- node /path/to/codesage/dist/mcp/stdio.js
 */

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { GraphConnection } from "../graph-db/connection.js";
import { initSchema } from "../graph-db/schema.js";
import { createMcpServer } from "./server.js";

async function main(): Promise<void> {
  const dbPath = resolve(process.env.CODESAGE_DB ?? join(process.cwd(), ".codesage", "graph.db"));
  mkdirSync(dirname(dbPath), { recursive: true });

  const conn = GraphConnection.open(dbPath);
  await initSchema(conn);

  const server = createMcpServer(conn);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stays alive on stdio; never closes the kuzu connection (teardown caveat).
}

main().catch((err) => {
  // stderr only — stdout is the MCP transport channel.
  process.stderr.write(`[codesage-mcp] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
