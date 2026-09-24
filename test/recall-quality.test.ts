import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { indexKnowledgeDocs } from "../src/knowledge-graph/parser.js";
import { ingestFeedback } from "../src/sage/evolution-loop.js";
import {
  compareRecallQuality,
  scoreConfidenceWeighted,
  scoreStaticBaseline,
} from "../src/sage/recall-ruler.js";

// implements DEC-078 D1

let dir: string;
let conn: GraphConnection;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "engram-recall-"));
  conn = GraphConnection.open(join(dir, "graph.db"));
  await initSchema(conn);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("recall quality ruler — DEC-078 H1 fixture (real evolution loop)", () => {
  // Fixture: a small, fixed graph with a known answer key.
  //
  //   Chain A: A1 --SUPERSEDES-- A2 --SUPERSEDES-- A3   (3 changes; A3 current)
  //   Chain B: B1 --SUPERSEDES-- B2                     (1 change;  B2 current)
  //   C1, C2: never changed, still current
  //   D1, D2: overturned directly (e.g. by a failing test / human correction),
  //           with no SUPERSEDES edge at all — the "推翻" case, not the
  //           "過期" case
  //
  // "A3 supersedes A2" is written as A3's doc linking to [[A2]] — parser.ts's
  // Decision→Decision rule turns that into SUPERSEDES(A3 -> A2), i.e. the
  // edge points from the newer decision to the one it replaces.
  const VALID_IDS = new Set(["DEC-A3", "DEC-B2", "DEC-C1", "DEC-C2"]);
  const STALE_OR_OVERTURNED_IDS = ["DEC-A1", "DEC-A2", "DEC-B1", "DEC-D1", "DEC-D2"];

  beforeAll(async () => {
    await indexKnowledgeDocs(conn, [
      { content: "---\nid: DEC-A1\n---\n# a1\nfirst cut" },
      { content: "---\nid: DEC-A2\n---\n# a2\nsupersedes [[DEC-A1]]" },
      { content: "---\nid: DEC-A3\n---\n# a3\nsupersedes [[DEC-A2]]" },
      { content: "---\nid: DEC-B1\n---\n# b1\nfirst cut" },
      { content: "---\nid: DEC-B2\n---\n# b2\nsupersedes [[DEC-B1]]" },
      { content: "---\nid: DEC-C1\n---\n# c1\nnever revisited" },
      { content: "---\nid: DEC-C2\n---\n# c2\nnever revisited" },
      { content: "---\nid: DEC-D1\n---\n# d1\nwill be overturned by a failing test" },
      { content: "---\nid: DEC-D2\n---\n# d2\nwill be overturned by a human correction" },
    ]);

    // Drive confidence the way the real evolution loop is designed to: three
    // negative feedback events per stale/overturned node (the same shape as
    // sage.test.ts's AC-4b — three test_fail-equivalent events push
    // confidence from 1.0 down to ~0.25, well under the untouched nodes'
    // 1.0). Nothing here hand-sets a `confidence` number; every value comes
    // out of `applyFeedback`, the real writer.
    for (const id of STALE_OR_OVERTURNED_IDS) {
      await ingestFeedback(
        conn,
        [
          { nodeId: id, signal: "negative", weight: 1 },
          { nodeId: id, signal: "negative", weight: 1 },
          { nodeId: id, signal: "negative", weight: 1 },
        ],
        "Decision",
      );
    }
    // VALID_IDS are left exactly as parser.ts created them (confidence 1.0) —
    // nothing ever contradicted them, so nothing ever fed the loop a signal.
  });

  it("confidence-weighted retrieval beats the static baseline on the same graph", async () => {
    const { weighted, staticBaseline } = await compareRecallQuality(
      conn,
      "Decision",
      { validIds: VALID_IDS },
      VALID_IDS.size,
    );

    // Report both numbers on failure, not just a boolean — the DEC-078 H1
    // row asks "vs baseline, by how much", not just "did it win".
    expect(
      weighted.ratio,
      `weighted top-${weighted.k}=${JSON.stringify(weighted.ids)} vs ` +
        `static top-${staticBaseline.k}=${JSON.stringify(staticBaseline.ids)}`,
    ).toBeGreaterThan(staticBaseline.ratio);

    // Not just "better than" — with three negative events driving every
    // stale/overturned node well under 1.0, confidence weighting should
    // recover the full valid set at k = |VALID_IDS|.
    expect(weighted.ratio).toBe(1);
  });

  it("static baseline is not already at ceiling on this fixture (the comparison is meaningful)", async () => {
    // If the baseline also scored 1.0, "weighted beats it" would be
    // vacuous — this guards against a fixture where id-ordering happens to
    // line up with validity by coincidence.
    const staticBaseline = await scoreStaticBaseline(conn, "Decision", { validIds: VALID_IDS }, VALID_IDS.size);
    expect(staticBaseline.ratio).toBeLessThan(1);
  });
});

describe("recall quality ruler — self-check on a synthetic control", () => {
  // A separate, hand-built graph where confidence is set directly (not via
  // feedback events) so the ruler's own arithmetic can be checked in
  // isolation from whether the evolution loop's feedback math is realistic.
  let controlDir: string;
  let controlConn: GraphConnection;

  beforeAll(async () => {
    controlDir = mkdtempSync(join(tmpdir(), "engram-recall-control-"));
    controlConn = GraphConnection.open(join(controlDir, "graph.db"));
    await initSchema(controlConn);

    // Ids deliberately chosen so alphabetical (static) order is the OPPOSITE
    // of confidence order, so the two methods cannot accidentally agree.
    const seed = async (id: string, confidence: number): Promise<void> => {
      await controlConn.query("MERGE (n:Function {id: $id}) SET n.name = $id, n.file = 'x.ts', n.start_line = 1, n.confidence = $c", {
        id,
        c: confidence,
      });
    };
    await seed("z-high-1", 0.95);
    await seed("y-high-2", 0.9);
    await seed("x-low-1", 0.1);
    await seed("w-low-2", 0.05);
  });

  afterAll(() => {
    rmSync(controlDir, { recursive: true, force: true });
  });

  it("distinguishes high- from low-confidence nodes when confidence actually differs", async () => {
    const validIds = new Set(["z-high-1", "y-high-2"]);
    const weighted = await scoreConfidenceWeighted(controlConn, "Function", { validIds }, 2);
    const staticBaseline = await scoreStaticBaseline(controlConn, "Function", { validIds }, 2);

    expect(weighted.ratio).toBe(1);
    // Static baseline picks the two alphabetically-first ids (w-, x-), both
    // low-confidence and both invalid by construction.
    expect(staticBaseline.ratio).toBe(0);
  });

  it("degenerates to no measurable advantage when every node ties at the same confidence", async () => {
    // This is the honesty check the task asked for: when confidence carries
    // no signal (e.g. everything is still parser.ts's hardcoded 1.0), the
    // ruler must report that truthfully, not manufacture a win.
    const tieDir = mkdtempSync(join(tmpdir(), "engram-recall-tie-"));
    const tieConn = GraphConnection.open(join(tieDir, "graph.db"));
    try {
      await initSchema(tieConn);
      for (const id of ["m1", "m2", "m3", "m4"]) {
        await tieConn.query("MERGE (n:Function {id: $id}) SET n.name = $id, n.file = 'x.ts', n.start_line = 1, n.confidence = 1.0", { id });
      }
      const validIds = new Set(["m1", "m2"]);
      const weighted = await scoreConfidenceWeighted(tieConn, "Function", { validIds }, 2);
      const staticBaseline = await scoreStaticBaseline(tieConn, "Function", { validIds }, 2);
      // Both orderings fall back to id ASC when confidence ties (reader.ts's
      // own tie-break), so they must agree — no fabricated advantage.
      expect(weighted.ids).toEqual(staticBaseline.ids);
      expect(weighted.ratio).toBe(staticBaseline.ratio);
    } finally {
      await tieConn.close();
      rmSync(tieDir, { recursive: true, force: true });
    }
  });
});
