import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EmbeddedClient } from "../clients/node-sdk/embedded.js";
import { SingleRepoIsolation } from "../src/adapters/isolation.js";

// Native (kuzu + tree-sitter via indexCode): one long-lived client, no close
// (teardown caveat — close can deadlock with tree-sitter co-loaded).
let dir: string;
let client: EmbeddedClient;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "codesage-embed-"));
  client = new EmbeddedClient(new SingleRepoIsolation(dir));
  await client.init();
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("EmbeddedClient facade (XSPEC-244)", () => {
  it("indexCode then callers / callChain (cross-file)", async () => {
    const r = await client.indexCode([
      { path: "a.ts", source: "import {b} from './b';\nexport function a(){ return b(); }" },
      { path: "b.ts", source: "export function b(){ return 1; }" },
    ]);
    expect(r.functions).toBe(2);

    const cs = await client.callers("b");
    expect(cs.map((n) => n.name)).toContain("a");

    const chain = await client.callChain("b", "callers");
    expect(chain.callers.map((n) => n.name)).toContain("a");
  });

  it("indexDocs then impactAnalysis", async () => {
    await client.indexDocs([
      { content: "---\nid: XSPEC-1\nimpacted_by: [DEC-1]\n---\n# spec", fallbackId: "XSPEC-1" },
      { content: "---\nid: DEC-1\n---\n# decision", fallbackId: "DEC-1" },
    ]);
    const r = await client.impactAnalysis("XSPEC-1");
    expect(r.decisions.map((d) => d.id)).toContain("DEC-1");
  });

  it("ingestFeedback lowers confidence; topByConfidence ranks", async () => {
    const u = await client.ingestFeedback("DEC-1", "test_fail", "Decision");
    expect(u).not.toBeNull();
    expect(u!.after).toBeLessThan(u!.before);

    const top = await client.topByConfidence("Function", 10);
    expect(top.length).toBeGreaterThanOrEqual(2);
  });

  it("raw query still works", async () => {
    const rows = await client.query("MATCH (f:Function) RETURN count(f) AS n");
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(2);
  });
});
