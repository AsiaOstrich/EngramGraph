/**
 * `egr index` summary hints — consumer feedback on 0.11.0 (2026-09-15, Windows, C#).
 *
 * A C# repo indexed to `1076 calls ... (ambiguous 534, unresolved 5972)` and
 * `142 doc(s) scanned, 137 unnamed`, `0 implements`. Every number was accurate,
 * and none of them said what to do. `--scip` already existed and was documented
 * in docs/CLI.md; the naming and `// implements` conventions were documented
 * only as a row in docs/MCP.md. The reporter could not find either from the
 * output they were looking at.
 */
import { describe, expect, it } from "vitest";
import { callResolutionHint, knowledgeNamingHint } from "../src/cli/index-hints.js";

describe("callResolutionHint", () => {
  it("points at --scip when more call sites were dropped than linked", () => {
    const hint = callResolutionHint({ calls: 1076, ambiguous: 534, unresolved: 5972 }, false);
    expect(hint).toContain("--scip");
    expect(hint).toContain("6506");
  });

  it("says nothing when most call sites were linked", () => {
    expect(callResolutionHint({ calls: 900, ambiguous: 50, unresolved: 100 }, false)).toBe("");
  });

  it("says nothing once --scip was used — the advice would be circular", () => {
    expect(callResolutionHint({ calls: 10, ambiguous: 5, unresolved: 500 }, true)).toBe("");
  });

  it("does not claim the dropped calls are defects", () => {
    // Most unresolved calls on a real repo go to framework or library code that
    // is simply not in the graph. Saying "failed" would send people chasing it.
    const hint = callResolutionHint({ calls: 1, ambiguous: 0, unresolved: 10 }, false);
    expect(hint).not.toMatch(/fail|error|broken/i);
  });
});

describe("knowledgeNamingHint", () => {
  const base = { docsScanned: 142, docsUnresolved: [] as string[], specs: 3, decisions: 2 };

  it("explains the naming rule when documents were scanned but not named", () => {
    const hint = knowledgeNamingHint({ ...base, docsUnresolved: ["notes.md", "readme.md"] }, 5, false);
    expect(hint).toContain("XSPEC-");
    expect(hint).toContain("ADR-");
    expect(hint).toMatch(/front-matter|filename|heading/);
  });

  it("does not repeat itself when the prefix-cluster warning already fired", () => {
    const hint = knowledgeNamingHint({ ...base, docsUnresolved: ["REQ-1.md", "REQ-2.md", "REQ-3.md"] }, 5, true);
    expect(hint).not.toContain("recognised when");
  });

  it("explains how code declares what it implements when specs exist but nothing links to them", () => {
    const hint = knowledgeNamingHint(base, 0, false);
    expect(hint).toContain("// implements SPEC-42");
    // Only specs can be implemented; saying DEC/ADR would send people down a dead end.
    expect(hint).not.toMatch(/implements (DEC|ADR)-/);
  });

  it("says nothing about implements when there are no specs to implement", () => {
    expect(knowledgeNamingHint({ ...base, specs: 0 }, 0, false)).not.toContain("implements");
  });

  it("says nothing at all when --docs was not used", () => {
    expect(knowledgeNamingHint(undefined, 0, false)).toBe("");
  });
});
