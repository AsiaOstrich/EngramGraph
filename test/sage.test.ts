import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { applyFeedback, MIN_CONFIDENCE } from "../src/sage/writer.js";
import { topByConfidence, rankedImpact } from "../src/sage/reader.js";
import { feedbackForEventType, ingestFeedback } from "../src/sage/evolution-loop.js";
import { indexKnowledgeDocs } from "../src/knowledge-graph/parser.js";
import { createServer } from "../src/api/server.js";

async function seedFunction(conn: GraphConnection, id: string, confidence = 1.0): Promise<void> {
  await conn.query(
    "MERGE (n:Function {id: $id}) SET n.name = $name, n.file = 'x.ts', n.start_line = 1, n.confidence = $c",
    { id, name: id, c: confidence },
  );
}

// kuzu-only: single shared connection, no awaited close (see code-graph.test).
let dir: string;
let conn: GraphConnection;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "codesage-sage-"));
  conn = GraphConnection.open(join(dir, "graph.db"));
  await initSchema(conn);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SAGE writer (Phase 4)", () => {
  it("maps ingest event types to signals", () => {
    expect(feedbackForEventType("test_fail")).toEqual({ signal: "negative", weight: 1 });
    expect(feedbackForEventType("test_pass").signal).toBe("positive");
    expect(feedbackForEventType("unknown")).toEqual({ signal: "neutral", weight: 0 });
  });

  // AC-4a: a test_fail lowers the Function's confidence.
  it("AC-4a: negative feedback decreases confidence", async () => {
    await seedFunction(conn, "f#ac4a");
    const update = await applyFeedback(conn, { nodeId: "f#ac4a", signal: "negative", weight: 1 });
    expect(update).not.toBeNull();
    expect(update!.after).toBeLessThan(update!.before);
    expect(update!.before).toBe(1.0);
  });

  // AC-4b: three test_fail events drive confidence to ≤ 0.5.
  it("AC-4b: three test_fail events push confidence ≤ 0.5", async () => {
    await seedFunction(conn, "f#ac4b");
    const fail = feedbackForEventType("test_fail");
    let after = 1.0;
    for (let i = 0; i < 3; i++) {
      const u = await applyFeedback(conn, { nodeId: "f#ac4b", ...fail });
      after = u!.after;
    }
    expect(after).toBeLessThanOrEqual(0.5);
  });

  it("never drops below the confidence floor", async () => {
    await seedFunction(conn, "f#floor");
    let after = 1.0;
    for (let i = 0; i < 8; i++) {
      const u = await applyFeedback(conn, { nodeId: "f#floor", signal: "negative", weight: 1 });
      after = u!.after;
    }
    expect(after).toBe(MIN_CONFIDENCE);
  });

  it("positive feedback recovers confidence, capped at 1.0", async () => {
    await seedFunction(conn, "f#pos", 0.5);
    const u = await applyFeedback(conn, { nodeId: "f#pos", signal: "positive", weight: 1 });
    expect(u!.after).toBeGreaterThan(0.5);
    const capped = await applyFeedback(conn, { nodeId: "f#cap", signal: "positive", weight: 1 });
    expect(capped).toBeNull(); // node not seeded → no-op
  });

  it("returns null for a missing node", async () => {
    const u = await applyFeedback(conn, { nodeId: "f#nope", signal: "negative", weight: 1 });
    expect(u).toBeNull();
  });
});

describe("SAGE reader (Phase 4)", () => {
  it("topByConfidence orders by confidence desc", async () => {
    await seedFunction(conn, "r#hi", 0.9);
    await seedFunction(conn, "r#lo", 0.2);
    const ranked = await topByConfidence(conn, "Function", 100);
    const hi = ranked.findIndex((n) => n.id === "r#hi");
    const lo = ranked.findIndex((n) => n.id === "r#lo");
    expect(hi).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThan(lo);
  });

  it("rankedImpact returns decisions ordered by confidence", async () => {
    await indexKnowledgeDocs(conn, [
      { content: "---\nid: XSPEC-900\n---\n# s\nsee [[DEC-900]] [[DEC-901]]" },
      { content: "---\nid: DEC-900\n---\n# d\nimpacts [[XSPEC-900]]" },
      { content: "---\nid: DEC-901\n---\n# d\nsupersedes [[DEC-900]]" },
    ]);
    // lower DEC-900 confidence so DEC-901 ranks first
    await applyFeedback(conn, { nodeId: "DEC-900", signal: "negative", weight: 1 }, "Decision");
    const ranked = await rankedImpact(conn, "XSPEC-900", 3);
    expect(ranked.length).toBeGreaterThanOrEqual(2);
    expect(ranked[0]!.confidence).toBeGreaterThanOrEqual(ranked[1]!.confidence);
  });
});

describe("SAGE ingest route (Phase 4)", () => {
  it("AC-4: POST /graph/ingest lowers confidence and returns before/after", async () => {
    await seedFunction(conn, "f#route");
    const app = createServer({ connection: conn });
    const res = await app.fetch(
      new Request("http://localhost/graph/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "test_fail", functionId: "f#route" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { before: number; after: number };
    expect(body.after).toBeLessThan(body.before);
  });

  it("returns 404 for an unknown node", async () => {
    const app = createServer({ connection: conn });
    const res = await app.fetch(
      new Request("http://localhost/graph/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "test_fail", functionId: "f#ghost" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("ingestFeedback applies a batch", async () => {
    await seedFunction(conn, "f#batch1");
    await seedFunction(conn, "f#batch2");
    const updates = await ingestFeedback(conn, [
      { nodeId: "f#batch1", signal: "negative", weight: 1 },
      { nodeId: "f#batch2", signal: "negative", weight: 1 },
      { nodeId: "f#missing", signal: "negative", weight: 1 },
    ]);
    expect(updates).toHaveLength(2); // missing node skipped
  });
});
