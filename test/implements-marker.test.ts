import { describe, it, expect } from "vitest";
import { extractImplementsSpecs } from "../src/knowledge-graph/linker.js";
import { extractCodeGraph } from "../src/code-graph/extractor.js";

/**
 * Implementation-declaration markers (XSPEC-373 R4b).
 *
 * `implements` was the only accepted marker, so `// @SPEC SPEC-EXTERNAL-AUTH`
 * produced no IMPLEMENTS edge — and no widening of the ID PATTERN could fix
 * that, because this gate runs first and returns early. A project can hit
 * `knowledge: N specs` and still get `implementers → (none)` for every one of
 * them.
 */
describe("implements markers (XSPEC-373 R4b)", () => {
  describe("accepted forms", () => {
    it.each([
      ["// @SPEC SPEC-EXTERNAL-AUTH", ["SPEC-EXTERNAL-AUTH"]],
      ["/// <summary>@SPEC SPEC-LOGIN</summary>", ["SPEC-LOGIN"]],
      ["// implements XSPEC-190", ["XSPEC-190"]],
      ["/* @implements SPEC-205 */", ["SPEC-205"]],
      ["// @spec spec-sms", ["SPEC-SMS"]],
      ["// implements SPEC-1 and SPEC-2", ["SPEC-1", "SPEC-2"]],
    ])("%s", (comment, expected) => {
      expect(extractImplementsSpecs(comment)).toEqual(expected);
    });
  });

  describe("the gate still holds — a mention is not a declaration", () => {
    it.each([
      ["// see SPEC-123 for rationale", "no marker at all"],
      ["// @SPECIAL handling for SPEC-9", "@SPEC must not match inside @SPECIAL"],
      ["// @specification note SPEC-9", "@spec must not match inside @specification"],
    ])("%s → [] (%s)", (comment) => {
      expect(extractImplementsSpecs(comment)).toEqual([]);
    });

    it("returns only Spec-kind ids — a file implements a spec, not a decision", () => {
      expect(extractImplementsSpecs("// implements DEC-060")).toEqual([]);
    });
  });

  it("`\\b` before `@` can never match — the trap this requirement exists to avoid", () => {
    // Documented here as an executable warning, not as a claim about src:
    // the natural "make the marker configurable" implementation builds
    // `new RegExp("\\b" + marker + "\\b")`, which compiles, runs, and silently
    // matches nothing for every `@`-prefixed marker. Anyone extending
    // IMPLEMENTS_MARKER must not reintroduce this.
    expect(/\b@SPEC\b/i.test("// @SPEC SPEC-EXTERNAL-AUTH")).toBe(false);
    expect(/@SPEC\b/i.test("// @SPEC SPEC-EXTERNAL-AUTH")).toBe(true);
  });

  it("end-to-end: a C# file declaring @SPEC yields an IMPLEMENTS edge", () => {
    // The user's actual shape: XML-doc comments in .cs. Exercises the whole
    // chain — tree-sitter C# parse, comment-node collection, marker gate, id
    // pattern — not just the linker in isolation.
    const source = `
namespace Auth;

/// <summary>@SPEC SPEC-EXTERNAL-AUTH</summary>
public class ExternalAuthService
{
    public bool Validate(string token) => token.Length > 0;
}
`;
    const { nodes, edges } = extractCodeGraph(source, { filePath: "Services/ExternalAuthService.cs" });
    const implementsEdges = edges.filter((e) => e.label === "IMPLEMENTS");

    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0]).toMatchObject({
      label: "IMPLEMENTS",
      fromLabel: "Module",
      from: "Services/ExternalAuthService.cs",
      toLabel: "Spec",
      to: "SPEC-EXTERNAL-AUTH",
    });

    const spec = nodes.find((n) => n.label === "Spec" && n.id === "SPEC-EXTERNAL-AUTH");
    expect(spec).toBeDefined();
  });
});
