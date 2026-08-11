import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { indexKnowledgeDocs, unresolvedIdClusters } from "../src/knowledge-graph/parser.js";

/**
 * Dropped-document accounting (XSPEC-373 R1).
 *
 * `parseKnowledgeDoc` returns null for a document it cannot name, and the
 * document then vanishes: no node, no edge, no error. The summary counted only
 * what survived, so `0 specs` could not be told apart from "44 documents we
 * failed to name" — the failure a user spent significant time bisecting.
 */
describe("unresolved document accounting (XSPEC-373 R1)", () => {
  describe("counts carry their denominator", () => {
    let dir: string;

    async function index(docs: Array<{ content: string; fallbackId?: string }>) {
      dir = mkdtempSync(join(tmpdir(), "engram-unresolved-"));
      const conn = GraphConnection.open(join(dir, "graph.db"));
      await initSchema(conn);
      try {
        return await indexKnowledgeDocs(conn, docs);
      } finally {
        await conn.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("reports what was scanned, not only what survived", async () => {
      const r = await index([
        { content: "# a\n", fallbackId: "REQ-001.md" },
        { content: "# b\n", fallbackId: "REQ-002.md" },
        { content: "# c\n", fallbackId: "SPEC-42.md" },
      ]);

      expect(r.specs).toBe(1);
      expect(r.docsScanned).toBe(3);
      expect(r.docsUnresolved).toEqual(["REQ-001.md", "REQ-002.md"]);
    });

    it("distinguishes 'nothing scanned' from 'nothing could be named'", async () => {
      const nothing = await index([]);
      const unnamed = await index([
        { content: "# a\n", fallbackId: "REQ-001.md" },
        { content: "# b\n", fallbackId: "REQ-002.md" },
      ]);

      // Both report zero specs — that is precisely the ambiguity.
      expect(nothing.specs).toBe(0);
      expect(unnamed.specs).toBe(0);
      // And these are what tell them apart.
      expect(nothing.docsScanned).toBe(0);
      expect(unnamed.docsScanned).toBe(2);
    });

    it("docsScanned counts documents, while specs counts nodes including ref stubs", async () => {
      // One real file linking three absent ids reports 4 specs off 1 document.
      // Documented here so nobody later mistakes specs for a document count.
      const r = await index([
        { content: "# real\n\n[[SPEC-901]] [[SPEC-902]] [[SPEC-903]]\n", fallbackId: "SPEC-900.md" },
      ]);
      expect(r.specs).toBe(4);
      expect(r.docsScanned).toBe(1);
      expect(r.docsUnresolved).toEqual([]);
    });
  });

  describe("clustering — a consistent shape refused, not a count", () => {
    it("flags a prefix rejected repeatedly", () => {
      const clusters = unresolvedIdClusters(["docs/REQ-001.md", "docs/REQ-002.md", "docs/REQ-003.md"]);
      expect(clusters).toEqual([{ prefix: "REQ", count: 3, samples: ["REQ-001.md", "REQ-002.md", "REQ-003.md"] }]);
    });

    it("ignores lower-case topic naming — the 31-warning regression", () => {
      // A real run produced THIRTY-ONE warnings against a skills library whose
      // files are named topic-first. They share prefixes for the same reason
      // any documentation set does, and none was ever meant to be a spec.
      const skillsLibrary = [
        ...Array.from({ length: 15 }, (_, i) => `docs/language-${i}.md`),
        ...Array.from({ length: 13 }, (_, i) => `docs/requirement-${i}.md`),
        ...Array.from({ length: 10 }, (_, i) => `skills/bdd-${i}.md`),
        ...Array.from({ length: 10 }, (_, i) => `skills/testing-${i}.md`),
        ...Array.from({ length: 5 }, (_, i) => `docs/git-workflow-${i}.md`),
      ];
      expect(unresolvedIdClusters(skillsLibrary)).toEqual([]);
    });

    it("still catches an upper-case id convention in the same tree", () => {
      // The point is not to go quiet — it is to go quiet about prose.
      const mixed = [
        ...Array.from({ length: 10 }, (_, i) => `skills/bdd-${i}.md`),
        ...Array.from({ length: 4 }, (_, i) => `specs/REQ-00${i}.md`),
      ];
      expect(unresolvedIdClusters(mixed).map((c) => [c.prefix, c.count])).toEqual([["REQ", 4]]);
    });

    it("de-duplicates samples — the same filename in three directories is one fact", () => {
      const sameName = Array.from({ length: 8 }, (_, i) => `skills/${i}/CREATE-methodology.md`);
      expect(unresolvedIdClusters(sameName)[0]?.samples).toEqual(["CREATE-methodology.md"]);
    });

    it("caps the number of clusters reported", () => {
      const many = ["AA", "BB", "CC", "DD", "EE"].flatMap((p) =>
        Array.from({ length: 3 }, (_, i) => `${p}-${i}.md`),
      );
      expect(unresolvedIdClusters(many)).toHaveLength(3);
    });

    it("stays silent on an ordinary repo's non-spec documents", () => {
      // The trigger this replaces ("unresolved > 0") fired on EngramGraph's own
      // tree: 25 markdown files, zero specs, nothing wrong.
      expect(unresolvedIdClusters(["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "docs/guide.md"])).toEqual([]);
    });

    it("does not cluster date-stamped notes", () => {
      expect(
        unresolvedIdClusters(["2026-08-10-meeting.md", "2026-08-11-meeting.md", "2026-08-12-meeting.md"]),
      ).toEqual([]);
    });

    it("stays below the threshold for one or two stragglers", () => {
      expect(unresolvedIdClusters(["REQ-001.md", "REQ-002.md"])).toEqual([]);
    });

    it("reports several rejected prefixes, largest first", () => {
      const clusters = unresolvedIdClusters([
        "REQ-1.md", "REQ-2.md", "REQ-3.md", "REQ-4.md",
        "STORY-1.md", "STORY-2.md", "STORY-3.md",
        "README.md",
      ]);
      expect(clusters.map((c) => [c.prefix, c.count])).toEqual([
        ["REQ", 4],
        ["STORY", 3],
      ]);
    });

    it("caps samples at three so a 44-document cluster stays readable", () => {
      const many = Array.from({ length: 44 }, (_, i) => `REQ-${String(i).padStart(3, "0")}.md`);
      const [cluster] = unresolvedIdClusters(many);
      expect(cluster?.count).toBe(44);
      expect(cluster?.samples).toHaveLength(3);
    });

    it("is not fooled by a single success — the defect the first draft had", () => {
      // "yield === 0" would go quiet here: SPEC-001 resolved, so the count is
      // non-zero while 43 documents are still missing. Clustering sees the 43.
      const unresolved = Array.from({ length: 43 }, (_, i) => `REQ-${i}.md`);
      expect(unresolvedIdClusters(unresolved)[0]?.count).toBe(43);
    });
  });
});
