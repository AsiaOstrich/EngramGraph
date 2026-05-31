/**
 * EngramGraph health check — end-to-end smoke across every module, against the
 * built package (dist). Complements the unit tests (`npm test`) by exercising
 * the public API the way a consumer would. Self-contained (no external corpus).
 *
 * Usage (from EngramGraph repo root):
 *   npm run build && node poc/health-check.mjs
 *
 * Exit 0 = all green; exit 1 = a check failed (CI-usable).
 */

import {
  GraphConnection, initSchema, NODE_TABLES, REL_TABLES,
  indexProject, callChain,
  indexKnowledgeDocs, impactAnalysis,
  applyFeedback, topByConfidence,
  createServer, createMcpServer,
} from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const dir = mkdtempSync(join(tmpdir(), "cs-health-"));
const conn = GraphConnection.open(join(dir, "g.db"));
await initSchema(conn);

// 1. graph-db schema (Kuzu)
check("graph-db: Kuzu schema", NODE_TABLES.length === 6 && REL_TABLES.length === 7,
  `${NODE_TABLES.length} NODE + ${REL_TABLES.length} REL`);

// 2. CodeGraph — cross-file CALLS + call-chain query (Phase 2 + P1)
await indexProject(conn, [
  { path: "a.ts", source: "import {b} from './b';\nexport function a(){ return b(); }" },
  { path: "b.ts", source: "export function b(){ return 1; }" },
]);
const cc = await callChain(conn, "b", "callers", 1);
check("code-graph: cross-file callers", cc.callers.some((x) => x.name === "a"),
  `callers(b)=[${cc.callers.map((x) => x.name).join(", ")}]`);

// 3. KnowledgeGraph — front-matter + [[ref]] → impact-analysis (Phase 3 + Phase 5)
await indexKnowledgeDocs(conn, [
  { content: "---\nid: SPEC-1\nimpacted_by: [DEC-1]\n---\n# s\nrefs [[DEC-2]]" },
  { content: "---\nid: DEC-1\n---\n# d" },
  { content: "---\nid: DEC-2\n---\n# d2" },
]);
const ia = await impactAnalysis(conn, "SPEC-1", 2);
check("knowledge-graph: impact-analysis", ia.decisions.length === 2,
  `SPEC-1 → [${ia.decisions.map((d) => d.id).join(", ")}]`);

// 4. SAGE — confidence evolution (Phase 4)
await applyFeedback(conn, { nodeId: "DEC-1", signal: "negative", weight: 1 }, "Decision");
const dec1 = (await topByConfidence(conn, "Decision", 10)).find((n) => n.id === "DEC-1");
check("sage: confidence evolution", !!dec1 && dec1.confidence < 1.0, `DEC-1 confidence=${dec1?.confidence}`);

// 5. API — Hono routes (health + graph data routes)
const app = createServer({ connection: conn });
const post = (path, body) => app.fetch(new Request(`http://x${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));
const health = await app.fetch(new Request("http://x/health"));
const impact = await post("/graph/impact-analysis", { nodeId: "SPEC-1", maxHops: 2 });
const chain = await post("/graph/call-chain", { symbol: "b", direction: "callers" });
const ingest = await post("/graph/ingest", { type: "test_fail", nodeId: "DEC-1", nodeLabel: "Decision" });
check("api: routes", health.status === 200 && impact.status === 200 && chain.status === 200 && ingest.status === 200,
  `/health=${health.status} /impact-analysis=${impact.status} /call-chain=${chain.status} /ingest=${ingest.status}`);

// 6. MCP — tools advertised + callable over the real MCP protocol
const mcp = createMcpServer(conn);
const mcpClient = new Client({ name: "health", version: "0" });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([mcp.connect(st), mcpClient.connect(ct)]);
const { tools } = await mcpClient.listTools();
const callRes = await mcpClient.callTool({ name: "call_chain", arguments: { symbol: "b", direction: "callers" } });
check("mcp: tools + protocol", tools.length === 5 && !callRes.isError,
  `${tools.length} tools (${tools.map((t) => t.name).join(", ")})`);

rmSync(dir, { recursive: true, force: true });
// NOTE: no conn.close() — Kuzu's native close can deadlock with tree-sitter
// co-loaded; the OS reclaims the temp DB on exit (documented caveat).
console.log(failures === 0 ? "\nEngramGraph: all modules healthy." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
