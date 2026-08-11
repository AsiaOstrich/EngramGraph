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

  it("a read-only server refuses the writing tools by name, and points at the CLI", async () => {
    // XSPEC-374: the stdio server holds the graph read-only so terminal
    // commands keep working alongside it. The three writing tools cannot run
    // there — they must say so and name the alternative, not fail at some
    // lower layer with a lock error the assistant cannot act on.
    const conn = GraphConnection.open(join(dir, "ro.db"));
    await initSchema(conn);
    await conn.close();
    const ro = GraphConnection.open(join(dir, "ro.db"), { readOnly: true });
    const server = createMcpServer(ro);
    const client = new Client({ name: "t", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    for (const [tool, args, cli] of [
      ["index_code", { files: [] }, "egr index"],
      ["index_docs", { docs: [] }, "egr index"],
      ["ingest_feedback", { nodeId: "x", type: "test_pass" }, "egr feedback"],
    ] as const) {
      const res = (await client.callTool({ name: tool, arguments: args })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain(tool);
      expect(res.content[0]!.text).toContain(cli);
    }
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
