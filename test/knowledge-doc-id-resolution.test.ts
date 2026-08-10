import { describe, it, expect } from "vitest";
import { parseKnowledgeDoc } from "../src/knowledge-graph/parser.js";

/**
 * Document id resolution: front-matter → last path segment → first heading
 * (XSPEC-373 R3).
 *
 * The pre-existing chain ended in `?? doc.content`, offering the whole file as
 * an id candidate. These cases pin the three sources, their order, and the two
 * things that are deliberately NOT sources: the body at large, and any path
 * segment above the filename.
 */
describe("knowledge doc id resolution (XSPEC-373 R3)", () => {
  it("prefers front-matter id over filename and heading", () => {
    const parsed = parseKnowledgeDoc({
      content: "---\nid: SPEC-1\n---\n# SPEC-2\n",
      fallbackId: "docs/SPEC-3.md",
    });
    expect(parsed?.id).toBe("SPEC-1");
  });

  it("falls back to the filename when there is no front-matter id", () => {
    const parsed = parseKnowledgeDoc({
      content: "# Some human title\n\nbody\n",
      fallbackId: "docs/specs/SPEC-205.md",
    });
    expect(parsed?.id).toBe("SPEC-205");
  });

  it("falls back to the first heading when the filename carries no id", () => {
    const parsed = parseKnowledgeDoc({
      content: "# SPEC-205 — a spec\n\nbody\n",
      fallbackId: "docs/notes.md",
    });
    expect(parsed?.id).toBe("SPEC-205");
  });

  it("does NOT let a directory name the document", () => {
    // Matching the full path would file this as SPEC-42 — the directory
    // naming a file that is not itself a spec.
    const parsed = parseKnowledgeDoc({
      content: "# Design notes\n\nbody\n",
      fallbackId: "specs/SPEC-42/notes.md",
    });
    expect(parsed).toBeNull();
  });

  it("does NOT take an id from prose in the middle of the body", () => {
    // No fallbackId — this is the MCP / library shape, and the ONLY way to
    // reach the removed `?? doc.content` alternative. With a fallbackId
    // present the old chain short-circuited before it, so passing one here
    // would make this case pass against the defect too.
    const parsed = parseKnowledgeDoc({
      content: "# Design notes\n\nSee SPEC-42 for the rationale.\n",
    });
    expect(parsed).toBeNull();
  });

  it("tries every source rather than stopping at the first non-empty one", () => {
    // A non-conforming filename must not mask a conforming heading: picking
    // the first non-null candidate and classifying only that would drop this
    // document for having been named badly.
    const parsed = parseKnowledgeDoc({
      content: "# SPEC-205\n\nbody\n",
      fallbackId: "docs/2026-08-10-meeting.md",
    });
    expect(parsed?.id).toBe("SPEC-205");
  });

  it("treats a separator-free fallbackId as the id itself (MCP / library path)", () => {
    // MCP callers pass a bare identifier, not a path — taking the last
    // segment of a string with no separator returns it unchanged.
    const parsed = parseKnowledgeDoc({ content: "# whatever\n", fallbackId: "SPEC-205" });
    expect(parsed?.id).toBe("SPEC-205");
  });

  it("handles a Windows-style fallbackId path", () => {
    const parsed = parseKnowledgeDoc({ content: "# t\n", fallbackId: "docs\\specs\\SPEC-205.md" });
    expect(parsed?.id).toBe("SPEC-205");
  });
});
