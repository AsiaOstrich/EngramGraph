import { describe, it, expect } from "vitest";
import { asConfidenceLabel, CONFIDENCE_LABELS } from "../src/sage/index.js";

/**
 * Runtime validation of `<label>` arguments (XSPEC-373 B10).
 *
 * `a1 as ConfidenceLabel` is a compile-time assertion and nothing more, so
 * `egr top Module` type-checked, reached Cypher, and handed the user
 * `Binder exception: Cannot find property confidence for n` — while the
 * correct message ("label: Function|Spec|Decision|Doc") was already written
 * three lines above, in a check that only tested whether an argument was
 * present at all.
 */
describe("confidence label validation (XSPEC-373 B10)", () => {
  it.each([...CONFIDENCE_LABELS])("accepts %s", (label) => {
    expect(asConfidenceLabel(label, "top")).toBe(label);
  });

  it("accepts a differently-cased label rather than being pedantic", () => {
    expect(asConfidenceLabel("spec", "top")).toBe("Spec");
    expect(asConfidenceLabel("FUNCTION", "top")).toBe("Function");
  });

  it("rejects a node label that has no confidence column, naming the valid set", () => {
    // Module and Class are real node labels — they simply have no confidence.
    // This is the case that used to reach the database.
    expect(() => asConfidenceLabel("Module", "top")).toThrow(/not a node label with confidence/);
    expect(() => asConfidenceLabel("Module", "top")).toThrow(/Function \| Spec \| Decision \| Doc/);
    expect(() => asConfidenceLabel("Class", "top")).toThrow();
  });

  it("names the command in the error, since two commands take a label", () => {
    expect(() => asConfidenceLabel("Module", "feedback --label")).toThrow(/^feedback --label:/);
  });

  it("rejects nonsense and injection-shaped input alike", () => {
    // The label is interpolated into Cypher (`MATCH (n:${label})`), so this
    // guard is also the boundary that keeps arbitrary text out of the query.
    expect(() => asConfidenceLabel("", "top")).toThrow();
    expect(() => asConfidenceLabel("Function) RETURN 1 //", "top")).toThrow();
  });

  it("keeps the runtime list and the type in one place", () => {
    // If a fifth label is added, it must appear here automatically — the point
    // of deriving the type from the array rather than maintaining both.
    expect([...CONFIDENCE_LABELS]).toEqual(["Function", "Spec", "Decision", "Doc"]);
  });
});
