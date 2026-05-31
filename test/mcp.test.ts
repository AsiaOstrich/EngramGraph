import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { createMcpServer } from "../src/mcp/server.js";

/** Call an MCP tool and parse its JSON text payload. */
async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  expect(res.isError).not.toBe(true);
  return JSON.parse(res.content[0]!.text);
}

// kuzu + tree-sitter both load via createMcpServer → single shared conn,
// no awaited close (teardown caveat). One MCP client/server pair for all tests.
let dir: string;
let conn: GraphConnection;
let client: Client;
let server: McpServer;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "egr-mcp-"));
  conn = GraphConnection.open(join(dir, "g.db"));
  await initSchema(conn);
  server = createMcpServer(conn);
  client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("EngramGraph MCP server", () => {
  it("advertises the expected tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["call_chain", "impact_analysis", "index_code", "index_docs", "ingest_feedback"]);
  });

  it("index_code + call_chain resolves a cross-file caller", async () => {
    const indexed = (await callJson(client, "index_code", {
      files: [
        { path: "a.ts", source: "import {b} from './b';\nexport function a(){ return b(); }" },
        { path: "b.ts", source: "export function b(){ return 1; }" },
      ],
    })) as { calls: number };
    expect(indexed.calls).toBeGreaterThanOrEqual(1);

    const chain = (await callJson(client, "call_chain", { symbol: "b", direction: "callers" })) as {
      callers: Array<{ name: string }>;
    };
    expect(chain.callers.map((c) => c.name)).toContain("a");
  });

  it("index_docs + impact_analysis returns the impact chain", async () => {
    await callJson(client, "index_docs", {
      docs: [
        { content: "---\nid: SPEC-1\nimpacted_by: [DEC-1]\n---\n# s" },
        { content: "---\nid: DEC-1\n---\n# d" },
      ],
    });
    const ia = (await callJson(client, "impact_analysis", { nodeId: "SPEC-1", maxHops: 2 })) as {
      decisions: Array<{ id: string }>;
    };
    expect(ia.decisions.map((d) => d.id)).toContain("DEC-1");
  });

  it("ingest_feedback evolves confidence", async () => {
    const update = (await callJson(client, "ingest_feedback", {
      nodeId: "DEC-1",
      type: "test_fail",
      nodeLabel: "Decision",
    })) as { before: number; after: number };
    expect(update.after).toBeLessThan(update.before);
  });

  it("returns an MCP error for a missing node", async () => {
    const res = (await client.callTool({
      name: "ingest_feedback",
      arguments: { nodeId: "DEC-nope", type: "test_fail", nodeLabel: "Decision" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("not found");
  });
});
