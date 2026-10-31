import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { createMcpServer } from "../src/mcp/server.js";

/**
 * Diagnostics over MCP (XSPEC-373 B6).
 *
 * `blindspots`, `signatures` and `doctor` were CLI-only, so an agent handed
 * `indexHealth.possiblyIncomplete` on a query could not ask what was missing —
 * it could relay the warning to a human and stop. Surfacing health to a machine
 * consumer is pointless if the follow-up question has no tool.
 */
describe("MCP diagnostics tools (XSPEC-373 B6)", () => {
  let dir: string;
  let withManifest: Client;
  let withoutManifest: Client;

  async function connect(manifestPath?: string): Promise<Client> {
    const conn = GraphConnection.open(join(dir, `${manifestPath ? "a" : "b"}.db`));
    await initSchema(conn);
    const server = createMcpServer(conn, manifestPath ? { manifestPath } : {});
    const client = new Client({ name: "t", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
  }

  async function call(client: Client, name: string) {
    return (await client.callTool({ name, arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "egr-mcp-diag-"));
    const manifestPath = join(dir, "a.parse-manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        runs: {
          "/x": {
            indexedAt: "2026-08-11T00:00:00.000Z",
            files: [
              { path: "src/ok.ts", language: "typescript", errorNodes: 0, errorExtent: 0, sourceExtent: 10, functions: 1, classes: 0 },
              { path: "src/bad.ts", language: "typescript", errorNodes: 3, errorExtent: 5, sourceExtent: 10, functions: 0, classes: 0, signatures: ["typescript@0.23.2:deadbeef"] },
            ],
          },
        },
      }),
    );
    withManifest = await connect(manifestPath);
    withoutManifest = await connect();
  });

  afterAll(() => {
    // No awaited close — ryugraph + tree-sitter teardown caveat (see mcp.test.ts).
    rmSync(dir, { recursive: true, force: true });
  });

  it("blindspots reports the partially-parsed file", async () => {
    const res = await call(withManifest, "blindspots");
    expect(res.isError).not.toBe(true);
    const data = JSON.parse(res.content[0]!.text) as {
      filesIndexed: number;
      partial: number;
      manifestPresent: boolean;
      blindspots: Array<{ path: string }>;
    };
    expect(data.filesIndexed).toBe(2);
    expect(data.partial).toBe(1);
    expect(data.blindspots.map((b) => b.path)).toEqual(["src/bad.ts"]);
  });

  it("blindspots says whether anything was ever measured", async () => {
    // `blindspots: []` alone cannot distinguish "clean" from "never indexed" —
    // the ambiguity this whole spec is about, one level up.
    const res = await call(withManifest, "blindspots");
    const data = JSON.parse(res.content[0]!.text) as { manifestPresent: boolean };
    expect(data.manifestPresent).toBe(true);
  });

  it("signatures groups the same files by cause", async () => {
    const res = await call(withManifest, "signatures");
    expect(res.isError).not.toBe(true);
    const data = JSON.parse(res.content[0]!.text) as { filesWithSignatures: number };
    expect(data.filesWithSignatures).toBe(1);
  });

  it("a read-only server does not offer the writing tools, calling one fails, and it says which egr command does each job", async () => {
    // XSPEC-374: the stdio server holds the graph read-only so terminal
    // commands keep working alongside it. The writing tools cannot run there.
    // Until 0.13.0-beta.4 they were listed and every call refused; since
    // XSPEC-481 R3 they are not listed at all (an assistant calls what it
    // finds in `tools/list`), and the server `instructions` name the CLI
    // command that does each job.
    //
    // `related` is in this list although it reads like a query: ranking
    // installs the algo extension and builds a projected graph. The graph below
    // has a real node, so a server that DID offer `related` would reach its
    // write path here instead of returning [] for an unknown id.
    const conn = GraphConnection.open(join(dir, "ro.db"));
    await initSchema(conn);
    await conn.query(`CREATE (s:Spec {id: 'SPEC-1', title: 'Real', confidence: 0.9})`);
    await conn.close();
    const ro = GraphConnection.open(join(dir, "ro.db"), { readOnly: true });
    const server = createMcpServer(ro);
    const client = new Client({ name: "t", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const offered = (await client.listTools()).tools.map((t) => t.name);
    const writing = [
      ["index_code", { files: [] }, "egr index <dir>"],
      ["index_docs", { docs: [] }, "egr index <dir> --docs"],
      ["ingest_feedback", { nodeId: "x", type: "test_pass" }, "egr feedback <type> <node-id>"],
      ["related", { seedId: "SPEC-1" }, "egr related <seed-id>"],
    ] as const;
    const instructions = client.getInstructions() ?? "";
    for (const [tool, args, cli] of writing) {
      expect(offered, `${tool} is listed by a read-only server`).not.toContain(tool);
      // The SDK answers an unlisted name with an error result, not a refusal and not a success.
      const res = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(res.isError, `${tool} answered`).toBe(true);
      expect(res.content[0]!.text).toMatch(/not found/i);
      expect(instructions, `the instructions do not name the command for ${tool}`).toContain(cli);
    }
    expect(offered).toHaveLength(9); // the eight that read the graph or its manifest, and `cochange` (XSPEC-514 R2), which reads git
  });

  it("doctor answers without a manifest, and without opening the graph", async () => {
    // The case that matters: indexing itself is what is broken.
    const res = await call(withoutManifest, "doctor");
    expect(res.isError).not.toBe(true);
    const data = JSON.parse(res.content[0]!.text) as { languages?: unknown[] };
    expect(Array.isArray(data.languages)).toBe(true);
    expect((data.languages as unknown[]).length).toBeGreaterThan(0);
  });

  describe("without a manifestPath, they explain themselves instead of reporting all-clear", () => {
    it.each(["blindspots", "signatures"])("%s", async (tool) => {
      const res = await call(withoutManifest, tool);
      // An error, NOT an empty success — a tool that cannot see must not
      // return the same shape as a tool that looked and found nothing.
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(/manifestPath/);
      expect(res.content[0]!.text).toMatch(/Nothing is wrong with the graph/);
    });
  });
});
