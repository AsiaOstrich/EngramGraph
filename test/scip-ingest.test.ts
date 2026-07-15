import { describe, expect, it } from "vitest";

import { ingestScipIndex } from "../src/code-graph/providers/scip/scip-ingest.js";
import { extractProject } from "../src/code-graph/extractor.js";
import { loadScipPocFixtureIndex, loadScipPocFixtureSources } from "./fixtures/scip-poc/load-fixture.js";

/**
 * XSPEC-333 R3 (SCIP PoC): SCIP index -> GraphFragment conversion, against
 * the real `scip-dotnet` output for the fixture project (see
 * test/fixtures/scip-poc/load-fixture.ts for how it was generated).
 *
 * This project deliberately reproduces the R4-documented failure mode: two
 * classes (OrderService, UserService) each define a `Validate` method, and
 * the only call sites are in a third file (Program.cs) that defines neither
 * — tree-sitter's cross-file bare-name resolver (`extractProject`) drops
 * both calls as ambiguous. `Calculator.Add` is a genuine same-class overload
 * pair, and `NotificationService.Notify` is a globally-unique-name control
 * case tree-sitter already resolves correctly on its own.
 */
describe("ingestScipIndex", () => {
  const index = loadScipPocFixtureIndex();
  const sources = loadScipPocFixtureSources();

  it("resolves both ambiguous Validate calls that tree-sitter drops", () => {
    // Ground truth: tree-sitter really does drop these two as ambiguous.
    const treeSitterResult = extractProject(sources.map((f) => ({ path: f.relativePath, source: f.source, language: "csharp" })));
    expect(treeSitterResult.ambiguous).toBe(2);
    const treeSitterCallTargets = treeSitterResult.fragment.edges
      .filter((e) => e.label === "CALLS")
      .map((e) => `${e.from} -> ${e.to}`);
    expect(treeSitterCallTargets).not.toContain("Program.cs#Program.Main -> Services/OrderService.cs#OrderService.Validate");
    expect(treeSitterCallTargets).not.toContain("Program.cs#Program.Main -> Services/UserService.cs#UserService.Validate");

    const { fragment, stats } = ingestScipIndex(index, sources);
    const scipCallTargets = fragment.edges.filter((e) => e.label === "CALLS").map((e) => `${e.from} -> ${e.to}`);

    expect(scipCallTargets).toContain("Program.cs#Program.Main -> Services/OrderService.cs#OrderService.Validate");
    expect(scipCallTargets).toContain("Program.cs#Program.Main -> Services/UserService.cs#UserService.Validate");
    expect(stats.callsSkippedNoEnclosingCaller).toBe(0);
  });

  it("collapses both Calculator.Add overloads onto ONE Function node and ONE aggregated CALLS edge (call_count 2), matching tree-sitter's own collapse", () => {
    const { fragment } = ingestScipIndex(index, sources);
    const calculatorAddNodes = fragment.nodes.filter(
      (n) => n.label === "Function" && n.id === "Services/Calculator.cs#Calculator.Add",
    );
    expect(calculatorAddNodes).toHaveLength(1);

    const callEdge = fragment.edges.find(
      (e) => e.label === "CALLS" && e.from === "Program.cs#Program.Main" && e.to === "Services/Calculator.cs#Calculator.Add",
    );
    expect(callEdge?.properties?.call_count).toBe(2);
  });

  it("resolves the unambiguous Notify control case too (SCIP is not just for the ambiguous case)", () => {
    const { fragment } = ingestScipIndex(index, sources);
    const callEdge = fragment.edges.find(
      (e) =>
        e.label === "CALLS" &&
        e.from === "Program.cs#Program.Main" &&
        e.to === "Services/NotificationService.cs#NotificationService.Notify",
    );
    expect(callEdge).toBeDefined();
    expect(callEdge?.properties?.call_count).toBe(2); // called twice in Program.cs
  });

  it("stamps provider=scip and confidence=0.9 on every Function node and CALLS edge", () => {
    const { fragment } = ingestScipIndex(index, sources);
    for (const n of fragment.nodes.filter((n) => n.label === "Function")) {
      expect(n.properties.provider).toBe("scip");
      expect(n.properties.confidence).toBe(0.9);
    }
    for (const e of fragment.edges.filter((e) => e.label === "CALLS")) {
      expect(e.properties?.provider).toBe("scip");
      expect(e.properties?.confidence).toBe(0.9);
    }
  });

  it("emits no duplicate Function node ids", () => {
    const { fragment } = ingestScipIndex(index, sources);
    const functionIds = fragment.nodes.filter((n) => n.label === "Function").map((n) => n.id);
    expect(new Set(functionIds).size).toBe(functionIds.length);
  });

  it("skips reference occurrences whose target is outside this project's source set (library calls)", () => {
    const { stats } = ingestScipIndex(index, sources);
    // Console.WriteLine / string.Trim / string.IsNullOrWhiteSpace are all
    // library methods never defined in this project's source files, so SCIP
    // ingest — like tree-sitter — cannot and should not resolve them.
    expect(stats.callsSkippedUnresolvedTarget).toBeGreaterThan(0);
  });

  it("resolves every function/class definition this fixture project contains (definitionsUnresolved is 0)", () => {
    const { stats } = ingestScipIndex(index, sources);
    expect(stats.definitionsUnresolved).toBe(0);
    // 6 methods (Process, Validate x2, Register, Notify, Main) + 2 Add
    // overloads collapsing to 1 + 7 classes.
    expect(stats.definitionsResolved).toBeGreaterThan(0);
  });
});
