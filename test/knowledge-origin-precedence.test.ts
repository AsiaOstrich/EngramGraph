import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { writeFragment } from "../src/graph-db/writer.js";
import { indexKnowledgeDocs } from "../src/knowledge-graph/parser.js";
import { implementers } from "../src/code-graph/query.js";
import type { GraphFragment } from "../src/graph-db/types.js";

/**
 * Knowledge node origin and its overwrite precedence (XSPEC-373 R5).
 *
 * A Spec id can arrive three ways and they used to be indistinguishable: a
 * parsed document, a `// implements` comment in code, and a bare `[[ref]]` in
 * some other document. All three produced a Spec node; two of them produced
 * `confidence: 1.0`; one of them invented a title by echoing the id back.
 *
 * Worse than confusing, it was order-dependent. Knowledge nodes carry no
 * `provider`, so they bypassed the provider overwrite policy entirely and last
 * write won — meaning whether a spec had its real title depended on the order
 * `index-all.sh` happened to walk six repositories.
 */
describe("knowledge origin precedence (XSPEC-373 R5)", () => {
  let dir: string;
  let conn: GraphConnection;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "engram-origin-"));
    conn = GraphConnection.open(join(dir, "graph.db"));
    await initSchema(conn);
  });

  afterEach(async () => {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function readSpec(id: string) {
    const rows = await conn.query(
      `MATCH (s:Spec {id: $id}) RETURN s.title AS title, s.origin AS origin, s.confidence AS confidence`,
      { id },
    );
    const r = rows[0];
    return r
      ? {
          title: r.title == null ? null : String(r.title),
          origin: r.origin == null ? null : String(r.origin),
          confidence: r.confidence == null ? null : Number(r.confidence),
        }
      : undefined;
  }

  const annotated = (id: string): GraphFragment => ({
    nodes: [{ label: "Spec", id, properties: { origin: "annotated" } }],
    edges: [],
  });

  const realDoc = (id: string, title: string) => [
    { content: `---\nid: ${id}\ntitle: ${title}\n---\n# ${title}\n`, fallbackId: `${id}.md` },
  ];

  const linkingDoc = (from: string, to: string) => [
    { content: `---\nid: ${from}\ntitle: Linker\n---\n# Linker\n\nsee [[${to}]]\n`, fallbackId: `${from}.md` },
  ];

  it("labels each of the three arrival routes", async () => {
    await indexKnowledgeDocs(conn, realDoc("SPEC-1", "Real one"));
    await indexKnowledgeDocs(conn, linkingDoc("SPEC-2", "SPEC-900"));
    await writeFragment(conn, annotated("SPEC-800"));

    expect((await readSpec("SPEC-1"))?.origin).toBe("declared");
    expect((await readSpec("SPEC-900"))?.origin).toBe("referenced");
    expect((await readSpec("SPEC-800"))?.origin).toBe("annotated");
  });

  it("a referenced phantom no longer invents a title or a confidence", async () => {
    await indexKnowledgeDocs(conn, linkingDoc("SPEC-2", "SPEC-900"));

    const phantom = await readSpec("SPEC-900");
    // It used to be `{ title: "SPEC-900", confidence: 1 }` — a spec nobody
    // wrote, reported with full confidence and its own id as a title.
    expect(phantom?.title).toBeNull();
    expect(phantom?.confidence).toBeNull();
    expect(phantom?.origin).toBe("referenced");
  });

  describe("a real document wins regardless of index order", () => {
    it("document first, then the link to it", async () => {
      await indexKnowledgeDocs(conn, realDoc("SPEC-900", "The real title"));
      await indexKnowledgeDocs(conn, linkingDoc("SPEC-2", "SPEC-900"));

      const s = await readSpec("SPEC-900");
      expect(s?.title).toBe("The real title");
      expect(s?.origin).toBe("declared");
    });

    it("link first, then the document — the order that used to lose", async () => {
      await indexKnowledgeDocs(conn, linkingDoc("SPEC-2", "SPEC-900"));
      await indexKnowledgeDocs(conn, realDoc("SPEC-900", "The real title"));

      const s = await readSpec("SPEC-900");
      expect(s?.title).toBe("The real title");
      expect(s?.origin).toBe("declared");
    });

    it("code annotation cannot overwrite a document either", async () => {
      await indexKnowledgeDocs(conn, realDoc("SPEC-800", "The real title"));
      await writeFragment(conn, annotated("SPEC-800"));

      const s = await readSpec("SPEC-800");
      expect(s?.title).toBe("The real title");
      expect(s?.origin).toBe("declared");
    });

    it("a link cannot overwrite a code annotation", async () => {
      await writeFragment(conn, annotated("SPEC-900"));
      await indexKnowledgeDocs(conn, linkingDoc("SPEC-2", "SPEC-900"));

      expect((await readSpec("SPEC-900"))?.origin).toBe("annotated");
    });
  });

  it("re-indexing the same document still updates it", async () => {
    // Equal rank must still write, or a spec could never be edited.
    await indexKnowledgeDocs(conn, realDoc("SPEC-1", "First title"));
    await indexKnowledgeDocs(conn, realDoc("SPEC-1", "Second title"));

    expect((await readSpec("SPEC-1"))?.title).toBe("Second title");
  });

  it("implementers can now tell a phantom from a real spec", async () => {
    // Both answer "no implementers", but for opposite reasons: one spec exists
    // and nobody implements it, the other was never written at all. `title`
    // could not distinguish them — the phantom's was the id, the real one's a
    // title, and a code-annotated spec's was null.
    await indexKnowledgeDocs(conn, realDoc("SPEC-1", "Real"));
    await indexKnowledgeDocs(conn, linkingDoc("SPEC-2", "SPEC-900"));

    expect((await implementers(conn, "SPEC-1")).modules).toEqual([]);
    expect((await implementers(conn, "SPEC-900")).modules).toEqual([]);
    expect((await readSpec("SPEC-1"))?.origin).toBe("declared");
    expect((await readSpec("SPEC-900"))?.origin).toBe("referenced");
  });
});
