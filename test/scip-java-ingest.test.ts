import { describe, expect, it } from "vitest";

import { ingestScipIndex } from "../src/code-graph/providers/scip/scip-ingest.js";
import { extractProject } from "../src/code-graph/extractor.js";
import { isDefinitionOccurrence, isLocalSymbol } from "../src/code-graph/providers/scip/scip-reader.js";
import { parseSymbol, classifySymbol } from "../src/code-graph/providers/scip/scip-symbol.js";
import { loadScipJavaPocFixtureIndex, loadScipJavaPocFixtureSources } from "./fixtures/scip-java-poc/load-fixture.js";

/**
 * XSPEC-333 R3 Java PoC: does the C# SCIP PoC's ingest design (`scip-ingest.ts`,
 * `test/scip-ingest.test.ts`) generalize to a SECOND SCIP-backed language, or
 * did it only work because of something specific to C#/`scip-dotnet`? This
 * fixture reproduces the same shape of case the C# fixture does (two classes
 * defining a same-named method, resolved only via a third file that defines
 * neither) using Java/`scip-java` instead.
 *
 * ## What generalized, unchanged
 *
 * `scip-symbol.ts`'s symbol-string parser, `scip-reader.ts`'s
 * `isDefinitionOccurrence`/`isLocalSymbol`, and every pass of
 * `ingestScipIndex` (definition resolution, row-containment, CALLS
 * aggregation, overload collapse, provider/confidence stamping) — all
 * required ZERO changes for Java. `scip-java`'s symbol strings use the same
 * `<scheme> <manager> <package> <version> <descriptor-path>` shape SCIP's
 * spec defines (e.g. `scip-java maven maven/com.example/scip-java-poc 1.0.0
 * com/example/services/OrderService#validate().`), and `local N` locals are
 * the same convention.
 *
 * ## What did NOT generalize for free (see `scip_pb.ts`'s header comment,
 * `scip-reader.ts`'s module doc, and `extractor.ts`'s `parserFor`/
 * `languageFor`/`detectLanguage` exports for the full empirical findings)
 *
 *   1. **Position encoding**: `scip-java` 0.13.1 emits ONLY the current
 *      `typed_range`/`typed_enclosing_range` `oneof` fields (`SingleLineRange`
 *      / `MultiLineRange`), never the deprecated `repeated int32 range`/
 *      `enclosing_range` fields the C# PoC's pinned `@c4312/scip` reader
 *      (frozen at npm 0.1.0 since 2024-08, predating those new fields) only
 *      knew how to read. Without a fix, every Java occurrence's position
 *      would have silently parsed as an empty array, and row-containment
 *      resolution (this whole ingest module's design) would have resolved
 *      ZERO definitions and ZERO calls for Java — not a partial degradation,
 *      a hard, silent zero. Fixed by regenerating the protobuf bindings
 *      in-repo (`scip_pb.ts`) against the CURRENT `scip.proto` and adding a
 *      normalization layer (`occurrenceRange`/`occurrenceEnclosingRange` in
 *      `scip-reader.ts`) so both encodings map back to the same `number[]`
 *      shape every existing caller already expected.
 *   2. **Hardcoded C# parser**: this module's `buildFileScope` used to
 *      allocate and cache a SINGLE `tree-sitter-c-sharp` parser directly —
 *      there was no language parameter anywhere in `ScipSourceFile` or this
 *      function, so it could not have ingested a second language without
 *      this change regardless of the position-encoding issue above. Fixed by
 *      reusing `extractor.ts`'s own already-multi-language `parserFor`/
 *      `languageFor`/`detectLanguage` (newly exported) instead of a second,
 *      SCIP-only, single-language cache.
 *
 * Neither finding is a flaw in the row-containment/merge *design* itself —
 * both are "this PoC was only ever exercised against one (language,
 * indexer-version) pair, so latent single-instance assumptions never had a
 * chance to surface" — exactly the risk a second language was meant to test
 * for.
 */
describe("ingestScipIndex (Java, XSPEC-333 R3 Java PoC)", () => {
  const index = loadScipJavaPocFixtureIndex();
  const sources = loadScipJavaPocFixtureSources();

  it("resolves both ambiguous validate() calls that tree-sitter drops", () => {
    // Ground truth: tree-sitter really does drop these two as ambiguous,
    // same shape as the C# fixture's OrderService/UserService.Validate case.
    const treeSitterResult = extractProject(sources.map((f) => ({ path: f.relativePath, source: f.source, language: "java" })));
    expect(treeSitterResult.ambiguous).toBe(2);
    const treeSitterCallTargets = treeSitterResult.fragment.edges
      .filter((e) => e.label === "CALLS")
      .map((e) => `${e.from} -> ${e.to}`);
    expect(treeSitterCallTargets).not.toContain(
      "src/main/java/com/example/Program.java#Program.main -> src/main/java/com/example/services/OrderService.java#OrderService.validate",
    );
    expect(treeSitterCallTargets).not.toContain(
      "src/main/java/com/example/Program.java#Program.main -> src/main/java/com/example/services/UserService.java#UserService.validate",
    );

    const { fragment, stats } = ingestScipIndex(index, sources);
    const scipCallTargets = fragment.edges.filter((e) => e.label === "CALLS").map((e) => `${e.from} -> ${e.to}`);

    expect(scipCallTargets).toContain(
      "src/main/java/com/example/Program.java#Program.main -> src/main/java/com/example/services/OrderService.java#OrderService.validate",
    );
    expect(scipCallTargets).toContain(
      "src/main/java/com/example/Program.java#Program.main -> src/main/java/com/example/services/UserService.java#UserService.validate",
    );
    expect(stats.callsSkippedNoEnclosingCaller).toBe(0);
  });

  it("collapses both Calculator.add() overloads onto ONE Function node and ONE aggregated CALLS edge (call_count 2), matching tree-sitter's own collapse", () => {
    const { fragment } = ingestScipIndex(index, sources);
    const calculatorAddNodes = fragment.nodes.filter(
      (n) => n.label === "Function" && n.id === "src/main/java/com/example/services/Calculator.java#Calculator.add",
    );
    expect(calculatorAddNodes).toHaveLength(1);

    const callEdge = fragment.edges.find(
      (e) =>
        e.label === "CALLS" &&
        e.from === "src/main/java/com/example/Program.java#Program.main" &&
        e.to === "src/main/java/com/example/services/Calculator.java#Calculator.add",
    );
    expect(callEdge?.properties?.call_count).toBe(2);
  });

  it("resolves the unambiguous notify() control case too (SCIP is not just for the ambiguous case)", () => {
    const { fragment } = ingestScipIndex(index, sources);
    const callEdge = fragment.edges.find(
      (e) =>
        e.label === "CALLS" &&
        e.from === "src/main/java/com/example/Program.java#Program.main" &&
        e.to === "src/main/java/com/example/services/NotificationService.java#NotificationService.notify",
    );
    expect(callEdge).toBeDefined();
    expect(callEdge?.properties?.call_count).toBe(2); // called twice in Program.java
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

  it("skips reference occurrences whose target is outside this project's source set (JDK library calls)", () => {
    const { stats } = ingestScipIndex(index, sources);
    // String#trim()/String#isEmpty()/System.out.println() etc. are all JDK
    // methods never defined in this project's source files.
    expect(stats.callsSkippedUnresolvedTarget).toBeGreaterThan(0);
  });

  it("leaves exactly the implicit default constructors unresolved, tied to an independently-derived count (not a bare magic number) -- documented pre-existing gap, not a regression", () => {
    // None of the 7 fixture classes declare an explicit constructor, so javac
    // synthesizes an implicit `<init>()` for each -- scip-java still emits a
    // definition occurrence for it (a real symbol in the class file), but
    // there is no tree-sitter AST node for a constructor that doesn't appear
    // in the source text, so row-containment cannot resolve it. This is the
    // SAME "constructors" gap the original C# PoC's Open Questions already
    // flagged as unverified (nested classes, partial classes, local
    // functions, constructors) -- Java surfacing it concretely is expected
    // corroborating evidence, not a new problem introduced by this PoC.
    //
    // Asserting `toBe(7)` alone (an earlier draft of this test did exactly
    // that) is a real risk flagged by adversarial review: a DIFFERENT
    // regression that happens to also drop 7 definitions would pass the same
    // assertion silently. So this test instead independently re-derives,
    // straight from the raw SCIP index (bypassing ingestScipIndex entirely),
    // which symbols are function/class-kind definition occurrences whose
    // last descriptor segment is the synthesized `<init>` constructor name --
    // then asserts ingest's unresolved count equals exactly THAT count, not
    // a number this test merely observed once and hardcoded.
    const implicitConstructorSymbols = new Set<string>();
    for (const doc of index.documents) {
      for (const occ of doc.occurrences) {
        if (!isDefinitionOccurrence(occ) || isLocalSymbol(occ.symbol)) continue;
        const parsed = parseSymbol(occ.symbol);
        if (!parsed) continue;
        if (classifySymbol(parsed) !== "function") continue;
        const last = parsed.descriptors.at(-1);
        if (last?.kind === "method" && last.name === "<init>") implicitConstructorSymbols.add(occ.symbol);
      }
    }
    // Sanity-check the independent derivation itself: exactly one
    // constructor per fixture class (7 classes), none sharing a symbol
    // string (SCIP symbols are unique per definition).
    expect(implicitConstructorSymbols.size).toBe(7);

    const { stats } = ingestScipIndex(index, sources);
    expect(stats.definitionsUnresolved).toBe(implicitConstructorSymbols.size);
    expect(stats.definitionsResolved).toBeGreaterThan(0);
  });
});
