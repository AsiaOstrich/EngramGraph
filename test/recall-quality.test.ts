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
  scoreExpectedBaseline,
  scoreStaticBaseline,
} from "../src/sage/recall-ruler.js";

// implements DEC-078 D1

/**
 * The fixture's logical shape, independent of what its nodes are named:
 *
 *   Chain A: a1 --SUPERSEDES-- a2 --SUPERSEDES-- a3   (3 changes; a3 current)
 *   Chain B: b1 --SUPERSEDES-- b2                     (1 change;  b2 current)
 *   c1, c2: never changed, still current
 *   d1, d2: overturned directly (e.g. by a failing test / human correction),
 *           with no SUPERSEDES edge at all — the "推翻" case, not the
 *           "過期" case
 *
 * "a3 supersedes a2" is written as a3's doc linking to [[a2]] — parser.ts's
 * Decision→Decision rule turns that into SUPERSEDES(a3 -> a2), i.e. the edge
 * points from the newer decision to the one it replaces.
 *
 * 4 valid (a3, b2, c1, c2) out of 9 total — this composition, not any
 * particular naming of it, is what the fixture's ground truth is about.
 */
interface FixtureNaming {
  a1: string;
  a2: string;
  a3: string;
  b1: string;
  b2: string;
  c1: string;
  c2: string;
  d1: string;
  d2: string;
}

/** Original naming — used by the main H1 test below. */
const ORIGINAL_NAMING: FixtureNaming = {
  a1: "DEC-A1",
  a2: "DEC-A2",
  a3: "DEC-A3",
  b1: "DEC-B1",
  b2: "DEC-B2",
  c1: "DEC-C1",
  c2: "DEC-C2",
  d1: "DEC-D1",
  d2: "DEC-D2",
};

/**
 * Same composition, renamed so the 4 valid ids sort alphabetically FIRST —
 * the naming-robustness check (2026-09-25 review) rebuilds the identical
 * fixture under this naming and asserts the landing conclusion doesn't move.
 */
// Uppercase throughout: classifyRef() canonicalises every id to upper case
// (linker.ts), so a lower/mixed-case id here would create the node under one
// spelling while this naming table's own strings — used to build validIds —
// stayed a different spelling, silently failing to match anything. Upper
// case is a no-op under that canonicalisation, which is the point.
const VALID_IDS_SORT_FIRST_NAMING: FixtureNaming = {
  c1: "DEC-A-VALID-1",
  c2: "DEC-A-VALID-2",
  a3: "DEC-A-VALID-3",
  b2: "DEC-A-VALID-4",
  a1: "DEC-Z-INVALID-1",
  a2: "DEC-Z-INVALID-2",
  b1: "DEC-Z-INVALID-3",
  d1: "DEC-Z-INVALID-4",
  d2: "DEC-Z-INVALID-5",
};

/**
 * Build the fixture graph under a given naming and return its ground truth.
 *
 * Confidence is never hand-set: every value comes out of `applyFeedback`
 * (via `ingestFeedback`), the real writer — three negative feedback events
 * per stale/overturned node (the same shape as sage.test.ts's AC-4b: three
 * test_fail-equivalent events push confidence from 1.0 down to ~0.25, well
 * under the untouched nodes' 1.0). The 4 valid nodes are left exactly as
 * parser.ts created them (confidence 1.0) — nothing ever contradicted them,
 * so nothing ever fed the loop a signal.
 */
async function buildFixture(conn: GraphConnection, naming: FixtureNaming): Promise<{ validIds: Set<string> }> {
  await indexKnowledgeDocs(conn, [
    { content: `---\nid: ${naming.a1}\n---\n# a1\nfirst cut` },
    { content: `---\nid: ${naming.a2}\n---\n# a2\nsupersedes [[${naming.a1}]]` },
    { content: `---\nid: ${naming.a3}\n---\n# a3\nsupersedes [[${naming.a2}]]` },
    { content: `---\nid: ${naming.b1}\n---\n# b1\nfirst cut` },
    { content: `---\nid: ${naming.b2}\n---\n# b2\nsupersedes [[${naming.b1}]]` },
    { content: `---\nid: ${naming.c1}\n---\n# c1\nnever revisited` },
    { content: `---\nid: ${naming.c2}\n---\n# c2\nnever revisited` },
    { content: `---\nid: ${naming.d1}\n---\n# d1\nwill be overturned by a failing test` },
    { content: `---\nid: ${naming.d2}\n---\n# d2\nwill be overturned by a human correction` },
  ]);

  const staleOrOverturned = [naming.a1, naming.a2, naming.b1, naming.d1, naming.d2];
  for (const id of staleOrOverturned) {
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

  return { validIds: new Set([naming.a3, naming.b2, naming.c1, naming.c2]) };
}

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
  let validIds: Set<string>;

  beforeAll(async () => {
    ({ validIds } = await buildFixture(conn, ORIGINAL_NAMING));
  });

  it("confidence-weighted retrieval beats the static baseline on the same graph", async () => {
    const { weighted, expectedBaseline } = await compareRecallQuality(conn, "Decision", { validIds }, validIds.size);

    // The comparison target is the order-independent expected baseline
    // (validCount / population = 4/9 on this fixture) — NOT the id-ordered
    // static read. An id-ordered read's score is sensitive to what the
    // fixture happened to name its nodes (see the naming-robustness test
    // below), so it cannot be the thing "did confidence weighting help" is
    // measured against.
    expect(
      weighted.ratio,
      `weighted top-${weighted.k}=${JSON.stringify(weighted.ids)} vs ` +
        `expected baseline ${expectedBaseline.validInPopulation}/${expectedBaseline.population}`,
    ).toBeGreaterThan(expectedBaseline.ratio);

    // Not just "better than" — with three negative events driving every
    // stale/overturned node well under 1.0, confidence weighting should
    // recover the full valid set at k = |validIds|.
    expect(weighted.ratio).toBe(1);
    expect(expectedBaseline.population).toBe(9);
    expect(expectedBaseline.validInPopulation).toBe(4);
    expect(expectedBaseline.ratio).toBeCloseTo(4 / 9, 10);
  });

  it("id-ordered static baseline is naming-dependent — informational only, not the comparison target", async () => {
    // On THIS naming, the invalid ids (DEC-A1/A2/B1/D1/D2) happen to sort
    // before the valid ones, so the id-ordered read scores low (1/4) largely
    // because of the fixture's naming, not because of anything confidence
    // weighting did. See the naming-robustness describe block below, where
    // renaming the identical composition flips this same read to 1.0.
    const staticBaseline = await scoreStaticBaseline(conn, "Decision", { validIds }, validIds.size);
    expect(staticBaseline.ratio).toBeCloseTo(0.25, 10);
  });
});

describe("recall quality ruler — naming robustness (2026-09-25 review)", () => {
  // A fresh graph, same composition as the main fixture above (4 valid /
  // 9 total), renamed so the valid ids sort alphabetically FIRST instead of
  // last. If the landing claim depended on id-ordering coincidences, this
  // would flip it; the order-independent expected baseline must not move,
  // and confidence weighting must still beat it.
  let robustDir: string;
  let robustConn: GraphConnection;
  let validIds: Set<string>;

  beforeAll(async () => {
    robustDir = mkdtempSync(join(tmpdir(), "engram-recall-robust-"));
    robustConn = GraphConnection.open(join(robustDir, "graph.db"));
    await initSchema(robustConn);
    ({ validIds } = await buildFixture(robustConn, VALID_IDS_SORT_FIRST_NAMING));
  });

  afterAll(() => {
    rmSync(robustDir, { recursive: true, force: true });
  });

  it("landing conclusion does not flip when the same composition is renamed so valid ids sort first", async () => {
    const { weighted, staticBaseline, expectedBaseline } = await compareRecallQuality(
      robustConn,
      "Decision",
      { validIds },
      validIds.size,
    );

    // Same composition (4 valid / 9 total) as ORIGINAL_NAMING → same
    // expected baseline value, unmoved by renaming.
    expect(expectedBaseline.ratio).toBeCloseTo(4 / 9, 10);
    expect(weighted.ratio).toBe(1);
    expect(weighted.ratio).toBeGreaterThan(expectedBaseline.ratio);

    // The id-ordered baseline, by contrast, DOES move: it was 1/4 under
    // ORIGINAL_NAMING and is 1.0 here — the exact same underlying situation,
    // scored differently purely because of naming. This is the demonstration
    // of why the landing test above does not use it as the comparison
    // target.
    expect(staticBaseline.ratio).toBe(1);
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

  it("scoreExpectedBaseline is validCount / population, regardless of ordering", async () => {
    const validIds = new Set(["z-high-1", "y-high-2"]);
    const expectedBaseline = await scoreExpectedBaseline(controlConn, "Function", { validIds });
    expect(expectedBaseline.population).toBe(4);
    expect(expectedBaseline.validInPopulation).toBe(2);
    expect(expectedBaseline.ratio).toBe(0.5);
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
