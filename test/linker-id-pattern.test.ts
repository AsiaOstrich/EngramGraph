import { describe, it, expect } from "vitest";
import { classifyRef, extractRefIds } from "../src/knowledge-graph/linker.js";

/**
 * Artifact id pattern: numeric-first, semantic-capable (XSPEC-373 R4a).
 *
 * Widened from `-\d+` so that projects naming their specs `SPEC-EXTERNAL-AUTH`
 * are indexable at all. The backward-compatibility half is the delicate one and
 * gets the most cases here: a numeric id must not absorb the description that
 * follows it in a filename.
 */
describe("artifact id pattern (XSPEC-373 R4a)", () => {
  describe("backward compatibility — numeric ids stop at their digits", () => {
    // The regression that this half exists to prevent: a single greedy
    // alternative turns `XSPEC-373-index-result.md` into
    // `XSPEC-373-INDEX-RESULT`, which no longer equals the `[[XSPEC-373]]`
    // the same corpus links to, and every edge silently detaches.
    it.each([
      ["XSPEC-373-index-result-trustworthiness.md", "XSPEC-373"],
      ["DEC-099-foo.md", "DEC-099"],
      ["XSPEC-190", "XSPEC-190"],
      ["SPEC-205", "SPEC-205"],
      ["ADR-001", "ADR-001"],
      ["DEC-062-harness.md", "DEC-062"],
    ])("%s → %s", (input, expected) => {
      expect(classifyRef(input)?.id).toBe(expected);
    });

    it("does not clip a suffix that merely starts with a digit", () => {
      // `\d+` alone would yield SPEC-2 here.
      expect(classifyRef("SPEC-2FA")?.id).toBe("SPEC-2FA");
    });
  });

  describe("semantic ids", () => {
    it.each([
      ["SPEC-EXTERNAL-AUTH.md", "SPEC-EXTERNAL-AUTH"],
      ["SPEC-LOGIN", "SPEC-LOGIN"],
      ["SPEC-SMS", "SPEC-SMS"],
      ["SPEC-ACCOUNT-MGMT", "SPEC-ACCOUNT-MGMT"],
      ["spec-login", "SPEC-LOGIN"],
      ["SPEC-EXTERNAL_AUTH", "SPEC-EXTERNAL_AUTH"],
    ])("%s → %s", (input, expected) => {
      expect(classifyRef(input)?.id).toBe(expected);
    });

    it("requires a hyphen after the prefix — an underscore is not a separator", () => {
      // `SPEC_FOO` is a different token, not a SPEC id with an odd separator.
      expect(classifyRef("SPEC_FOO")).toBeNull();
    });
  });

  describe("bounds — widening stops short of 'anything after a dash'", () => {
    it.each([
      ["MYSPEC-5", "prefix must be at a word boundary"],
      ["SPEC-", "suffix may not be empty"],
      ["SPEC--x", "suffix must start with an alphanumeric"],
      ["nothing here", "no id at all"],
    ])("%s → null (%s)", (input) => {
      expect(classifyRef(input)).toBeNull();
    });

    it("leaves a trailing separator out of the id", () => {
      expect(classifyRef("SPEC-LOGIN-")?.id).toBe("SPEC-LOGIN");
      expect(classifyRef("see SPEC-LOGIN - the auth one")?.id).toBe("SPEC-LOGIN");
    });

    it("stops at CJK punctuation", () => {
      expect(classifyRef("SPEC-240（dry-run）")?.id).toBe("SPEC-240");
    });
  });

  describe("kind classification is unchanged by the widening", () => {
    it.each([
      ["SPEC-LOGIN", "Spec"],
      ["XSPEC-EXTERNAL-AUTH", "Spec"],
      ["DEC-BOUNDARY", "Decision"],
      ["ADR-009", "Decision"],
    ])("%s → %s", (input, kind) => {
      expect(classifyRef(input)?.kind).toBe(kind);
    });

    it.each([
      ["XADR-001-license-isolation.md", "XADR-001", "Decision"],
      ["XADR-003", "XADR-003", "Decision"],
      ["ADR-009", "ADR-009", "Decision"],
    ])("%s → %s (%s)", (input, id, kind) => {
      // XADR must precede ADR in the alternation. With ADR first, `\b` forbids
      // a boundary inside XADR, so `XADR-001` would match NOTHING — which is
      // exactly what happened: dev-platform's three cross-project ADRs were
      // silently absent from its own graph until the unresolved-prefix warning
      // named them.
      expect(classifyRef(input)?.id).toBe(id);
      expect(classifyRef(input)?.kind).toBe(kind);
    });

    it("does not match a prefix that merely ends with a known one", () => {
      expect(classifyRef("MYADR-1")).toBeNull();
      expect(classifyRef("MYSPEC-1")).toBeNull();
    });

    it("keeps XSPEC and SPEC in separate namespaces", () => {
      // XSPEC must win the alternation — never normalised to SPEC-190.
      expect(classifyRef("XSPEC-190")?.id).toBe("XSPEC-190");
    });
  });

  describe("extractRefIds — one definition, several consumers", () => {
    it("pulls every id out of a relationship field, de-duplicated", () => {
      expect(extractRefIds("XSPEC-334, SPEC-LOGIN, XSPEC-334, DEC-060")).toEqual([
        "XSPEC-334",
        "SPEC-LOGIN",
        "DEC-060",
      ]);
    });

    it("returns an empty list rather than throwing on id-free text", () => {
      expect(extractRefIds("no artifact ids in this sentence")).toEqual([]);
    });

    it("applies the same numeric-first rule as classifyRef", () => {
      expect(extractRefIds("XSPEC-373-index-result.md")).toEqual(["XSPEC-373"]);
    });
  });
});
