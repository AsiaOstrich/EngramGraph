import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { writeFragment } from "../src/graph-db/writer.js";
import { applyFeedback } from "../src/sage/writer.js";
import type { GraphFragment } from "../src/graph-db/types.js";

/**
 * SAGE confidence must survive a plain re-index (XSPEC-373 B1).
 *
 * `Function.confidence` is documented (`graph-db/types.ts`) as a SAGE score:
 * `sage/writer.ts`'s `applyFeedback` moves it from real usage-feedback events,
 * and `code-graph/extractor.ts`'s 23-line comment above the tree-sitter node
 * builder states outright that the `confidence: 1` it stamps is "only SAGE's
 * *starting* value, not a permanent claim of syntactic certainty".
 *
 * It was a starting value in intent only. In practice `extractor.ts` re-stamps
 * `confidence: 1` on every index, and `writer.ts`'s `shouldOverwrite` returns
 * true unconditionally for a same-provider write — so every ordinary
 * `egr index` reset the whole evolution loop's accumulated signal back to 1.0.
 * `test/schema-migration.test.ts` already recorded this as a known, separate
 * concern; this file is the test that closes it.
 *
 * NOT tested here, deliberately: the cross-provider policy (a different
 * provider may overwrite only with strictly higher confidence). That is
 * XSPEC-333 R1 and has its own suite in `writer-merge-policy.test.ts` — the
 * fix for this defect must leave those eight assertions untouched, which is
 * why it belongs in the extractor's stamp rather than in `shouldOverwrite`.
 */
describe("SAGE confidence survives re-index (XSPEC-373 B1)", () => {
  let dir: string;
  let conn: GraphConnection;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "engram-sage-reindex-"));
    conn = GraphConnection.open(join(dir, "graph.db"));
    await initSchema(conn);
  });

  afterEach(async () => {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function readConfidence(id: string): Promise<number | undefined> {
    const rows = await conn.query(
      `MATCH (n:Function {id: $id}) RETURN n.confidence AS confidence`,
      { id },
    );
    const raw = rows[0]?.confidence;
    return raw == null ? undefined : Number(raw);
  }

  /** What `extractor.ts` emits for a freshly parsed function, verbatim. */
  function extractorFragment(): GraphFragment {
    return {
      nodes: [
        {
          label: "Function",
          id: "src/a.ts#alpha",
          properties: {
            name: "alpha",
            file: "src/a.ts",
            start_line: 1,
            confidence: 1,
            provider: "tree-sitter",
          },
        },
      ],
      edges: [],
    };
  }

  it("keeps a lowered confidence when the same file is indexed again", async () => {
    await writeFragment(conn, extractorFragment());
    expect(await readConfidence("src/a.ts#alpha")).toBe(1);

    // One negative signal: 1.0 - (1.0 * STEP 0.25) = 0.75
    const update = await applyFeedback(conn, {
      nodeId: "src/a.ts#alpha",
      signal: "negative",
      weight: 1,
      source: "vitest",
    });
    expect(update?.after).toBe(0.75);
    expect(await readConfidence("src/a.ts#alpha")).toBe(0.75);

    // A plain `egr index` over an unchanged file: same provider, same stamp.
    await writeFragment(conn, extractorFragment());

    expect(await readConfidence("src/a.ts#alpha")).toBe(0.75);
  });

  it("keeps a raised confidence too — the reset is not direction-specific", async () => {
    await writeFragment(conn, extractorFragment());

    // Drive it down twice, then back up once: 1.0 → 0.75 → 0.5 → 0.75.
    for (const signal of ["negative", "negative", "positive"] as const) {
      await applyFeedback(conn, { nodeId: "src/a.ts#alpha", signal, weight: 1 });
    }
    expect(await readConfidence("src/a.ts#alpha")).toBe(0.75);

    await writeFragment(conn, extractorFragment());

    expect(await readConfidence("src/a.ts#alpha")).toBe(0.75);
  });

  it("still applies the extractor's starting value to a node it has never seen", async () => {
    // The guard must not turn into "never write confidence": a brand-new node
    // has no SAGE history to protect and must get its starting value, or the
    // evolution loop begins from NULL and `applyFeedback` silently falls back
    // to MAX_CONFIDENCE (`sage/writer.ts`'s `?? MAX_CONFIDENCE`).
    await writeFragment(conn, extractorFragment());
    expect(await readConfidence("src/a.ts#alpha")).toBe(1);
  });
});
