// implements XSPEC-457
import { describe, it, expect } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { GraphSource } from "../src/graph-db/lease.js";
import { createMcpServer } from "../src/mcp/server.js";

/**
 * 0.13.0-beta.1 shipped `failFrom` with a default branch that called itself:
 *
 *   if (e instanceof NotInGraphError || e instanceof GraphBusyError) return fail(e.message);
 *   return failFrom(e);            // <- every other error
 *
 * so any error that was not one of those two (a corrupt graph file, an engine
 * exception, a bug) ended in `RangeError: Maximum call stack size exceeded` and
 * the real message was gone. The other tests in this suite only ever throw the
 * two named errors, which is why nothing caught it.
 *
 * These tests drive the real server through a real MCP client (in-memory
 * transport), with a graph source whose `use` throws an arbitrary error, and
 * read what the caller receives.
 */

/** A source whose every `use` throws `thrown`. Not read-only, so the writing tools reach `use` too. */
function throwingSource(thrown: unknown): GraphSource {
  return {
    path: "/nonexistent/graph.db",
    readOnly: false,
    use: async () => {
      throw thrown;
    },
  };
}

async function connect(source: GraphSource): Promise<Client> {
  const server = createMcpServer(source);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

/** Every tool whose handler runs `source.use(...)`, with arguments that pass schema validation. */
const TOOLS_THAT_OPEN_THE_GRAPH: Array<[string, Record<string, unknown>]> = [
  ["index_code", { files: [{ path: "a.ts", source: "export function a(){}" }] }],
  ["index_docs", { docs: [{ content: "# doc", fallbackId: "D-1" }] }],
  ["call_chain", { symbol: "foo" }],
  ["impact_analysis", { nodeId: "XSPEC-1" }],
  ["ingest_feedback", { nodeId: "foo", type: "test_fail" }],
  ["implementers", { specId: "XSPEC-1" }],
  ["implemented_specs", { moduleId: "a.ts" }],
  ["related", { seedId: "foo" }],
  ["refs_check", { paths: ["README.md"] }],
];

describe("an error that is neither NotInGraph nor GraphBusy reaches the caller with its message", () => {
  it("every tool that opens the graph answers isError with the original message instead of overflowing the stack [mcp-failfrom-unexpected-error]", async () => {
    const message = "Kuzu: database file is corrupted (checksum mismatch at page 17)";
    const client = await connect(throwingSource(new Error(message)));

    const problems: string[] = [];
    for (const [name, args] of TOOLS_THAT_OPEN_THE_GRAPH) {
      const res = (await client.callTool({ name, arguments: args })) as ToolResult;
      const text = res.content?.[0]?.text ?? "";
      if (res.isError !== true) problems.push(`${name}: isError is ${String(res.isError)}, text=${text}`);
      if (!text.includes(message)) problems.push(`${name}: original message missing, text=${text}`);
      if (/Maximum call stack/i.test(text) || /RangeError/.test(text)) problems.push(`${name}: stack overflow leaked, text=${text}`);
      // never an empty or result-shaped answer
      if (text.trim() === "" || text.trim() === "[]" || text.includes("(none)")) problems.push(`${name}: read as an empty result, text=${text}`);
    }
    expect(problems).toEqual([]);
  });

  it("the text a caller reads starts with 'error:' like every other tool failure, and carries the cause [mcp-failfrom-error-prefix]", async () => {
    const client = await connect(throwingSource(new TypeError("cannot read properties of undefined (reading 'rows')")));
    const res = (await client.callTool({ name: "call_chain", arguments: { symbol: "foo" } })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe("error: cannot read properties of undefined (reading 'rows')");
  });

  it("a thrown value that is not an Error (a string) still reaches the caller as text [mcp-failfrom-non-error-value]", async () => {
    const client = await connect(throwingSource("engine said no"));
    const res = (await client.callTool({ name: "implementers", arguments: { specId: "XSPEC-1" } })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe("error: engine said no");
  });

  it("an Error with an empty message still says which kind of error it was [mcp-failfrom-empty-message]", async () => {
    const client = await connect(throwingSource(new RangeError("")));
    const res = (await client.callTool({ name: "implementers", arguments: { specId: "XSPEC-1" } })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe("error: RangeError");
  });
});
