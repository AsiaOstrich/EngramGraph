import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * What happens when a grammar's native binary isn't there. // implements XSPEC-365 R2
 *
 * This is the behaviour the whole change exists to produce, and it is
 * unobservable on a healthy machine: every grammar builds here, so nothing in
 * the normal test run ever walks this path. Simulating the failure is the only
 * way to know the degradation works — otherwise it would be verified for the
 * first time by a user, on the day it matters, in an environment nobody can see.
 *
 * The failure is injected at `grammar-registry`, the seam where a real missing
 * binary surfaces: `require()` of the grammar package throws, so
 * `isLanguageAvailable` reports false and `languageFor` throws
 * `GrammarUnavailableError`. Everything downstream is the real code.
 */

const DART_FILE = {
  path: "lib/main.dart",
  source: "void main() { greet(); }\nvoid greet() {}\n",
};
const TS_FILE = {
  path: "src/app.ts",
  source: "export function hello() { return world(); }\nexport function world() { return 1; }\n",
};

async function extractorWithDartUnavailable() {
  vi.doMock("../src/code-graph/grammar-registry.js", async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("../src/code-graph/grammar-registry.js")
    >();
    const REASON = "Cannot find module '@vokturz/tree-sitter-dart'";
    return {
      ...actual,
      isLanguageAvailable: (lang: string) =>
        lang === "dart" ? false : actual.isLanguageAvailable(lang as never),
      languageFor: (lang: string) => {
        if (lang === "dart") {
          throw new actual.GrammarUnavailableError(
            "dart",
            "@vokturz/tree-sitter-dart",
            REASON,
          );
        }
        return actual.languageFor(lang as never);
      },
    };
  });
  return import("../src/code-graph/extractor.js");
}

describe("a language whose grammar is unavailable", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock("../src/code-graph/grammar-registry.js");
    vi.resetModules();
  });

  it("does not stop the other languages from being indexed", async () => {
    const { extractProject } = await extractorWithDartUnavailable();
    const result = extractProject([TS_FILE, DART_FILE]);

    // The point of the whole exercise: TypeScript still lands in the graph.
    const functions = result.fragment.nodes.filter((n) => n.label === "Function");
    expect(functions.length).toBeGreaterThan(0);
    expect(functions.every((f) => String(f.id).startsWith("src/app.ts"))).toBe(true);
    expect(result.calls).toBeGreaterThan(0);
  });

  it("reports the skipped language, its package and the reason", async () => {
    const { extractProject } = await extractorWithDartUnavailable();
    const { skippedLanguages } = extractProject([TS_FILE, DART_FILE]);

    expect(skippedLanguages).toHaveLength(1);
    expect(skippedLanguages[0]).toMatchObject({
      language: "dart",
      label: "Dart",
      package: "@vokturz/tree-sitter-dart",
      files: 1,
    });
    // The reason has to survive to the surface — "unavailable" alone sends the
    // reader nowhere, "Cannot find module" tells them it was never built.
    expect(skippedLanguages[0]?.reason).toContain("Cannot find module");
  });

  it("counts files per language rather than emitting one entry per file", async () => {
    const { extractProject } = await extractorWithDartUnavailable();
    const { skippedLanguages } = extractProject([
      TS_FILE,
      DART_FILE,
      { path: "lib/other.dart", source: "void x() {}\n" },
      { path: "lib/third.dart", source: "void y() {}\n" },
    ]);

    expect(skippedLanguages).toHaveLength(1);
    expect(skippedLanguages[0]?.files).toBe(3);
  });

  it("keeps skipped files out of parse-health entirely", async () => {
    const { extractProject } = await extractorWithDartUnavailable();
    const { parseHealth, files } = extractProject([TS_FILE, DART_FILE]);

    // A skipped file is not a blindspot. Recording it as `failed` would tell
    // the reader their Dart source is malformed, which it isn't, and would
    // send them to read code when they need a compiler.
    expect(parseHealth.map((f) => f.path)).toEqual(["src/app.ts"]);
    expect(parseHealth.some((f) => f.failed !== undefined)).toBe(false);

    // `files` must not claim credit for a file that was never opened.
    expect(files).toBe(1);
  });

  it("indexes normally, with nothing skipped, when every grammar is present", async () => {
    // Control: without the mock the same input has no skips. Without this, a
    // bug that reported everything as skipped would still pass the assertions
    // above.
    const { extractProject } = await import("../src/code-graph/extractor.js");
    const result = extractProject([TS_FILE, DART_FILE]);

    expect(result.skippedLanguages).toEqual([]);
    expect(result.files).toBe(2);
    expect(
      result.fragment.nodes.some((n) => String(n.id).startsWith("lib/main.dart")),
    ).toBe(true);
  });
});
