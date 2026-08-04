import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ALL_PLATFORMS,
  GRAMMARS,
  KNOWN_ISSUES,
  OTHER_NATIVE_DEPENDENCIES,
  compiledFromSourceOn,
} from "../language-support.js";
import { detectLanguage } from "../src/code-graph/extractor.js";
import type { SupportedLanguage } from "../src/code-graph/types.js";

/**
 * Binds `language-support.js` to the three things it claims to be the single
 * source of truth for. // implements XSPEC-365 R4
 *
 * The registry exists because the same facts were about to be stated in three
 * places — the install-time preflight, the runtime language set, and the docs
 * platform matrix — and the install-time copy is the one nobody would notice
 * had gone stale, because nothing renders it on a machine where the install
 * succeeded.
 *
 * A registry nobody checks is just a fourth place to be wrong, so every claim
 * in it is asserted against something independent here:
 *
 *   - `prebuilds` is re-read from each package's actual shipped directory,
 *     not trusted. This is the claim the whole feature turns on: it decides
 *     whether the preflight warns, and it was wrong-by-omission in the README
 *     for four releases.
 *   - The `SupportedLanguage` union is bound to the runtime array in *both*
 *     directions, so adding a language to one and forgetting the other fails
 *     rather than becoming a silent gap.
 *   - `extensions` is checked against `detectLanguage()` rather than used to
 *     replace it — that function has ordering subtleties a flat table lookup
 *     would quietly change.
 */

const ROOT = join(__dirname, "..");

/**
 * Platforms a package actually ships binaries for, read off the installed
 * package. Returns `null` when the package isn't installed, so a missing
 * dependency reads as "cannot verify" instead of silently as "ships nothing" —
 * an empty result and a broken lookup must not be indistinguishable.
 */
function actualPrebuilds(pkg: string): string[] | null {
  const pkgDir = join(ROOT, "node_modules", ...pkg.split("/"));
  if (!existsSync(pkgDir)) return null;

  // The tree-sitter convention: prebuilds/<platform>-<arch>/*.node
  const prebuildsDir = join(pkgDir, "prebuilds");
  if (existsSync(prebuildsDir)) {
    return readdirSync(prebuildsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }

  // ryugraph's convention: prebuilt/ryujs-<platform>-<arch>.node
  const prebuiltDir = join(pkgDir, "prebuilt");
  if (existsSync(prebuiltDir)) {
    return readdirSync(prebuiltDir)
      .map((f) => /^ryujs-(.+)\.node$/.exec(f)?.[1])
      .filter((p): p is string => typeof p === "string")
      .sort();
  }

  return null;
}

describe("language-support.js prebuild claims match what the packages ship", () => {
  const everyNativeDep = [
    ...GRAMMARS.map((g) => ({ package: g.package, prebuilds: g.prebuilds })),
    ...OTHER_NATIVE_DEPENDENCIES.map((d) => ({
      package: d.package,
      prebuilds: d.prebuilds,
    })),
  ];
  // tree-sitter-typescript backs two languages; assert its package once.
  const byPackage = new Map(everyNativeDep.map((d) => [d.package, d.prebuilds]));

  for (const [pkg, claimed] of byPackage) {
    it(`${pkg} ships exactly the platforms the registry claims`, () => {
      const actual = actualPrebuilds(pkg);
      // Guard the lookup before trusting its result: `null` means the package
      // or its prebuild directory wasn't found, which is a broken check, not
      // evidence that the package ships nothing.
      expect(
        actual,
        `could not read prebuilds for ${pkg} — package missing or layout changed; ` +
          `this assertion cannot run, so do not read a pass as verification`,
      ).not.toBeNull();
      expect(actual).toEqual([...claimed].sort());
    });
  }

  it("every claimed platform is one of the six known platform-arch pairs", () => {
    for (const [pkg, claimed] of byPackage) {
      for (const p of claimed) {
        expect(ALL_PLATFORMS, `${pkg} claims unknown platform ${p}`).toContain(p);
      }
    }
  });
});

describe("the SupportedLanguage union and the runtime registry agree", () => {
  /**
   * Exhaustive by construction: TypeScript fails to compile this object if a
   * member of `SupportedLanguage` is missing a key, so the union side of the
   * comparison cannot silently fall behind.
   */
  const EVERY_UNION_MEMBER: Record<SupportedLanguage, true> = {
    typescript: true,
    tsx: true,
    javascript: true,
    csharp: true,
    python: true,
    go: true,
    java: true,
    kotlin: true,
    rust: true,
    cpp: true,
    ruby: true,
    php: true,
    dart: true,
  };

  it("has no language in the union that is missing from the registry", () => {
    const inRegistry = new Set(GRAMMARS.map((g) => g.language));
    expect([...Object.keys(EVERY_UNION_MEMBER)].sort()).toEqual(
      [...inRegistry].sort(),
    );
  });

  it("gives every language exactly one registry entry", () => {
    const seen = new Set<string>();
    for (const g of GRAMMARS) {
      expect(seen.has(g.language), `duplicate registry entry: ${g.language}`).toBe(
        false,
      );
      seen.add(g.language);
    }
  });
});

describe("registry extensions agree with detectLanguage()", () => {
  for (const grammar of GRAMMARS) {
    // `javascript` is detectLanguage's fallback for anything unmatched, so
    // its listed extensions are asserted like every other language's, but an
    // unlisted extension landing on it is expected behaviour, not drift.
    it(`${grammar.label}: every listed extension detects as "${grammar.language}"`, () => {
      for (const ext of grammar.extensions) {
        expect(detectLanguage(`some/file${ext}`), `extension ${ext}`).toBe(
          grammar.language,
        );
        expect(
          detectLanguage(`some/FILE${ext.toUpperCase()}`),
          `extension ${ext} (uppercase)`,
        ).toBe(grammar.language);
      }
    });
  }

  it("lists every extension the CLI walks, and walks every extension it lists", () => {
    // src/cli/run.ts's CODE_EXTS decides which files reach the extractor at
    // all. A language in the registry whose extension the walker skips is
    // supported on paper and dead in practice.
    const runSource = readFileSync(join(ROOT, "src", "cli", "run.ts"), "utf8");
    const block = /const CODE_EXTS = \[([\s\S]*?)\] as const;/.exec(runSource);
    expect(block, "CODE_EXTS block not found in src/cli/run.ts").not.toBeNull();

    const walked = new Set(
      [...(block?.[1] ?? "").matchAll(/"(\.[a-z]+)"/g)].map((m) => m[1]),
    );
    const registered = new Set(GRAMMARS.flatMap((g) => [...g.extensions]));

    expect([...walked].sort()).toEqual([...registered].sort());
  });
});

describe("KNOWN_ISSUES", () => {
  it("every entry names a condition that ends it", () => {
    // A known-issue note without a resolve condition rots into "we know and
    // have decided not to care", read years after the situation changed. This
    // is the one property worth enforcing mechanically.
    expect(KNOWN_ISSUES.length).toBeGreaterThan(0);
    for (const issue of KNOWN_ISSUES) {
      expect(issue.resolveWhen, `${issue.id} has no resolve condition`).toBeTruthy();
      expect(issue.resolveWhen.length).toBeGreaterThan(20);
      expect(issue.package, `${issue.id} names no package`).toBeTruthy();
    }
  });

  it("only names packages this project actually depends on", () => {
    // An entry about a package we no longer use is worse than no entry: it
    // sends the reader looking for something that isn't there.
    const known = new Set([
      ...GRAMMARS.map((g) => g.package),
      ...OTHER_NATIVE_DEPENDENCIES.map((d) => d.package),
    ]);
    for (const issue of KNOWN_ISSUES) {
      expect(known, `${issue.id} names an unknown package`).toContain(issue.package);
    }
  });
});

describe("compiledFromSourceOn()", () => {
  it("reports Dart on every platform except linux-x64", () => {
    for (const platform of ALL_PLATFORMS) {
      const needed = compiledFromSourceOn(platform).map((d) => d.package);
      if (platform === "linux-x64") {
        expect(needed).not.toContain("@vokturz/tree-sitter-dart");
      } else {
        expect(needed, `platform ${platform}`).toContain(
          "@vokturz/tree-sitter-dart",
        );
      }
    }
  });

  it("reports ryugraph on win32-arm64 only", () => {
    // ryugraph ships five of six prebuilt binaries; Windows on ARM builds it
    // through cmake-js. Different mechanism from the grammars, same
    // consequence for someone without a toolchain.
    for (const platform of ALL_PLATFORMS) {
      const needed = compiledFromSourceOn(platform).map((d) => d.package);
      expect(needed.includes("ryugraph"), `platform ${platform}`).toBe(
        platform === "win32-arm64",
      );
    }
  });

  it("names the languages lost with each grammar, so a warning can be actionable", () => {
    const dart = compiledFromSourceOn("win32-x64").find(
      (d) => d.package === "@vokturz/tree-sitter-dart",
    );
    expect(dart?.languages).toEqual(["Dart"]);
  });

  it("returns nothing for linux-x64, the one fully-prebuilt platform", () => {
    expect(compiledFromSourceOn("linux-x64")).toEqual([]);
  });
});
