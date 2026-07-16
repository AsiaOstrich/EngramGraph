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
import type { FileParseHealth } from "../src/code-graph/parse-health.js";

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
    expect(names).toEqual([
      "call_chain",
      "impact_analysis",
      "implemented_specs",
      "implementers",
      "index_code",
      "index_docs",
      "ingest_feedback",
      "related",
    ]);
  });

  it("implementers + implemented_specs answer doc↔code both ways (XSPEC-331 R4)", async () => {
    await callJson(client, "index_code", {
      files: [{ path: "svc.ts", source: "// implements XSPEC-7\nexport function run(){ return 1; }" }],
    });

    const impl = (await callJson(client, "implementers", { specId: "XSPEC-7" })) as {
      modules: Array<{ module: string; functions: string[] }>;
    };
    expect(impl.modules.map((m) => m.module)).toContain("svc.ts");

    const specs = (await callJson(client, "implemented_specs", { moduleId: "svc.ts" })) as {
      specs: Array<{ id: string }>;
    };
    expect(specs.specs.map((s) => s.id)).toEqual(["XSPEC-7"]);
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

// XSPEC-334 R2: a server given a manifestPath attaches indexHealth to code
// queries when a blindspot shares the result's subtree — the "nothing calls
// foo, safe to delete" answer must carry a warning when foo's neighborhood has
// unparsed files. A separate server/manifest, since the shared one above has
// no manifestPath (and must keep behaving exactly as pre-R2).
describe("MCP indexHealth surfacing (R2)", () => {
  let d: string;
  let manifestPath: string;
  let c: Client;

  const fph = (path: string, over: Partial<FileParseHealth> = {}): FileParseHealth => ({
    path, language: "typescript", errorNodes: 0, errorExtent: 0, sourceExtent: 40, functions: 1, classes: 0, ...over,
  });

  beforeAll(async () => {
    d = mkdtempSync(join(tmpdir(), "egr-mcp-r2-"));
    const conn2 = GraphConnection.open(join(d, "g.db"));
    await initSchema(conn2);
    // A manifest with a blindspot in pkg/ (dir shared by the indexed files).
    manifestPath = join(d, "graph.parse-manifest.json");
    const { upsertRun, writeManifest } = await import("../src/code-graph/parse-manifest.js");
    writeManifest(
      manifestPath,
      upsertRun(null, "/root", "t", [fph("pkg/a.ts"), fph("pkg/bad.ts", { errorNodes: 2, errorExtent: 9, functions: 0 })], "1.0.0"),
    );
    const s = createMcpServer(conn2, { manifestPath });
    c = new Client({ name: "test-client-r2", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([s.connect(st), c.connect(ct)]);
    await callJson(c, "index_code", {
      files: [
        { path: "pkg/a.ts", source: "export function target(){ return 1; }\nexport function lonely(){ return 2; }" },
        { path: "pkg/b.ts", source: "import {target} from './a.js';\nexport function caller(){ return target(); }" },
      ],
    });
  });

  afterAll(() => rmSync(d, { recursive: true, force: true }));

  it("call_chain flags possiblyIncomplete when a blindspot is near a NON-empty result", async () => {
    const res = (await callJson(c, "call_chain", { symbol: "target", direction: "callers" })) as {
      callers: Array<{ name: string }>;
      indexHealth?: { partial: number; possiblyIncomplete?: boolean; blindspots?: string[] };
    };
    expect(res.callers.map((n) => n.name)).toContain("caller");
    expect(res.indexHealth?.possiblyIncomplete).toBe(true);
    expect(res.indexHealth?.blindspots).toContain("pkg/bad.ts");
  });

  it("call_chain flags an EMPTY result via the symbol's own definition file (flagship case)", async () => {
    // `lonely` has no callers → empty result, no result files. The def-file
    // anchor (pkg/a.ts, sharing dir with pkg/bad.ts) is what makes the
    // highest-risk "nothing calls it, safe to delete" answer still warn.
    const res = (await callJson(c, "call_chain", { symbol: "lonely", direction: "callers" })) as {
      callers: Array<{ name: string }>;
      indexHealth?: { possiblyIncomplete?: boolean; blindspots?: string[] };
    };
    expect(res.callers).toHaveLength(0);
    expect(res.indexHealth?.possiblyIncomplete).toBe(true);
    expect(res.indexHealth?.blindspots).toContain("pkg/bad.ts");
  });

  it("index_code updates the manifest (so MCP-side indexing keeps health current)", async () => {
    const { readManifest } = await import("../src/code-graph/parse-manifest.js");
    const m = readManifest(manifestPath)!;
    expect(Object.keys(m.runs)).toContain("mcp:index_code");
    const mcpFiles = m.runs["mcp:index_code"]!.files.map((f) => f.path);
    expect(mcpFiles).toContain("pkg/a.ts");
  });
});

describe("MCP indexHealth on a healthy graph adds no field (R2 zero-noise)", () => {
  it("omits indexHealth when the manifest has no blindspots", async () => {
    const d2 = mkdtempSync(join(tmpdir(), "egr-mcp-r2-healthy-"));
    try {
      const conn3 = GraphConnection.open(join(d2, "g.db"));
      await initSchema(conn3);
      const mp = join(d2, "graph.parse-manifest.json");
      const { upsertRun, writeManifest } = await import("../src/code-graph/parse-manifest.js");
      const healthy: FileParseHealth = { path: "a.ts", language: "typescript", errorNodes: 0, errorExtent: 0, sourceExtent: 40, functions: 1, classes: 0 };
      writeManifest(mp, upsertRun(null, "/root", "t", [healthy], "1.0.0"));
      const s = createMcpServer(conn3, { manifestPath: mp });
      const cl = new Client({ name: "healthy", version: "0.0.0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([s.connect(st), cl.connect(ct)]);
      await callJson(cl, "index_code", { files: [{ path: "a.ts", source: "export function f(){ return f(); }" }] });
      const res = (await callJson(cl, "call_chain", { symbol: "f", direction: "both" })) as Record<string, unknown>;
      expect(res).not.toHaveProperty("indexHealth");
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }
  });
});
