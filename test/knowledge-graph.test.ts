import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { classifyRef, extractImplementsSpecs } from "../src/knowledge-graph/linker.js";
import { parseKnowledgeDoc, indexKnowledgeDocs } from "../src/knowledge-graph/parser.js";
import { impactAnalysis } from "../src/knowledge-graph/query.js";
import { createServer } from "../src/api/server.js";

const SPEC_205 = `---
id: SPEC-205
title: Agent/Role Spec SDD Variant
status: Implemented
---
# SPEC-205
Builds on [[DEC-062]] harness engineering.
`;

const DEC_062 = `---
id: DEC-062
title: Harness Engineering 2026 Adoption
date: 2026-05-07
---
# DEC-062
Impacts [[SPEC-205]] and others.
`;

const DEC_069 = `---
id: DEC-069
title: EngramGraph Architecture
date: 2026-05-27
---
# DEC-069
Supersedes [[DEC-062]].
`;

const CORPUS = [{ content: SPEC_205 }, { content: DEC_062 }, { content: DEC_069 }];

describe("KnowledgeGraph parser/linker (Phase 3)", () => {
  it("classifies SPEC → Spec and DEC/ADR → Decision", () => {
    expect(classifyRef("SPEC-205")).toEqual({ kind: "Spec", id: "SPEC-205" });
    expect(classifyRef("[[DEC-062]]")).toEqual({ kind: "Decision", id: "DEC-062" });
    expect(classifyRef("ADR-001 something")).toEqual({ kind: "Decision", id: "ADR-001" });
    expect(classifyRef("no id here")).toBeNull();
  });

  it("classifies XSPEC → Spec, preserving the X (distinct id namespace)", () => {
    // XSPEC-190 (dev-platform) and SPEC-190 (a sub-project) are different ids.
    expect(classifyRef("XSPEC-190")).toEqual({ kind: "Spec", id: "XSPEC-190" });
    expect(classifyRef("[[XSPEC-331（doc↔code）]]")).toEqual({ kind: "Spec", id: "XSPEC-331" });
    // still avoids matching SPEC mid-word
    expect(classifyRef("MYSPEC-5")).toBeNull();
  });

  it("extractImplementsSpecs: only fires on the `implements` keyword, Spec-kind only, deduped", () => {
    expect(extractImplementsSpecs("// implements XSPEC-190 AC-3")).toEqual(["XSPEC-190"]);
    expect(extractImplementsSpecs("// implements XSPEC-190\n// implements XSPEC-190")).toEqual(["XSPEC-190"]);
    expect(extractImplementsSpecs("* implements SPEC-75 and DEC-060")).toEqual(["SPEC-75"]); // DEC excluded
    expect(extractImplementsSpecs("// see SPEC-123 for rationale")).toEqual([]); // no keyword
  });

  it("parses a spec doc with refs", () => {
    const parsed = parseKnowledgeDoc({ content: SPEC_205 });
    expect(parsed?.kind).toBe("Spec");
    expect(parsed?.id).toBe("SPEC-205");
    expect(parsed?.title).toBe("Agent/Role Spec SDD Variant");
    expect(parsed?.refs).toEqual([{ kind: "Decision", id: "DEC-062" }]);
  });

  it("derives id from fallbackId when front-matter omits it", () => {
    const parsed = parseKnowledgeDoc({ content: "# notes\nsee [[SPEC-1]]", fallbackId: "specs/DEC-099-foo.md" });
    expect(parsed?.kind).toBe("Decision");
    expect(parsed?.id).toBe("DEC-099");
  });

  it("reads relationship front-matter fields (related/impacts/impacted_by/supersedes)", () => {
    const spec = parseKnowledgeDoc({
      content: "---\nid: SPEC-555\nimpacted_by: [DEC-555, DEC-554]\nrelated: [SPEC-556]\n---\n# spec\n",
    });
    expect(spec?.refs.map((r) => r.id).sort()).toEqual(["DEC-554", "DEC-555", "SPEC-556"]);

    const dec = parseKnowledgeDoc({
      content: "---\nid: DEC-555\nsupersedes: [DEC-554]\nimpacts: [SPEC-555]\n---\n# dec\n",
    });
    expect(dec?.refs.map((r) => r.id).sort()).toEqual(["DEC-554", "SPEC-555"]);
  });
});

describe("KnowledgeGraph ingest + AC-3 impact analysis", () => {
  // Single shared connection (beforeAll/afterAll). Re-opening a Kuzu DB per
  // test under the forks pool can leave native handles that stall worker
  // teardown; all tests here use the same idempotent corpus so one DB is safe.
  let dir: string;
  let conn: GraphConnection;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "engram-kg-"));
    conn = GraphConnection.open(join(dir, "graph.db"));
    await initSchema(conn);
  });

  afterAll(() => {
    // Do not await conn.close(): Kuzu's native close can stall the forks worker
    // teardown (see code-graph.test). The temp DB is reclaimed on worker exit.
    rmSync(dir, { recursive: true, force: true });
  });

  it("indexes Spec/Decision nodes with IMPACTS + SUPERSEDES edges", async () => {
    const res = await indexKnowledgeDocs(conn, CORPUS);
    expect(res.specs).toBe(1);
    expect(res.decisions).toBe(2);
    expect(res.impacts).toBeGreaterThanOrEqual(1);
    expect(res.supersedes).toBe(1);
  });

  // AC-3: impact analysis on a spec returns an impact chain with ≥1 Decision.
  it("AC-3: impactAnalysis(SPEC-205, 3) returns the decision impact chain", async () => {
    await indexKnowledgeDocs(conn, CORPUS);
    const result = await impactAnalysis(conn, "SPEC-205", 3);

    expect(result.nodeId).toBe("SPEC-205");
    expect(result.decisions.length).toBeGreaterThanOrEqual(1);

    const ids = result.decisions.map((d) => d.id).sort();
    expect(ids).toContain("DEC-062"); // direct IMPACTS
    expect(ids).toContain("DEC-069"); // via SUPERSEDES → DEC-062 → SPEC-205

    const direct = result.decisions.find((d) => d.id === "DEC-062");
    expect(direct?.via).toBe("direct");
  });

  it("builds edges from front-matter relationship fields (no [[ref]] needed)", async () => {
    await indexKnowledgeDocs(conn, [
      { content: "---\nid: SPEC-557\nimpacted_by: [DEC-557]\n---\n# spec 557\n" },
      { content: "---\nid: DEC-557\ndate: 2026-05-30\n---\n# dec 557\n" },
    ]);
    const result = await impactAnalysis(conn, "SPEC-557", 1);
    expect(result.decisions.map((d) => d.id)).toContain("DEC-557");
  });

  // R2 (XSPEC-331): Spec→Spec doc↔doc up/downstream edges from front-matter
  // `related`/`depends_on` (incl. the XSPEC- prefix), on the same Spec nodes.
  it("builds RELATES(Spec→Spec) edges from related/depends_on (XSPEC prefix)", async () => {
    const res = await indexKnowledgeDocs(conn, [
      { content: "---\nid: XSPEC-331\ndepends_on: [XSPEC-237]\nrelated: [XSPEC-321]\n---\n# 331\n" },
      { content: "---\nid: XSPEC-237\n---\n# 237\n" },
      { content: "---\nid: XSPEC-321\n---\n# 321\n" },
    ]);
    expect(res.relates).toBeGreaterThanOrEqual(2);

    const rows = await conn.query(
      "MATCH (a:Spec {id: 'XSPEC-331'})-[:RELATES]->(b:Spec) RETURN b.id AS id ORDER BY id",
    );
    expect(rows.map((r) => String(r.id))).toEqual(["XSPEC-237", "XSPEC-321"]);
  });

  it("serves AC-3 over POST /graph/impact-analysis", async () => {
    await indexKnowledgeDocs(conn, CORPUS);
    const app = createServer({ connection: conn });

    const res = await app.fetch(
      new Request("http://localhost/graph/impact-analysis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: "SPEC-205", maxHops: 3 }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decisions: Array<{ id: string }> };
    expect(body.decisions.length).toBeGreaterThanOrEqual(1);
  });
});
