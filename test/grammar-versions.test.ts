import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import Parser from "tree-sitter";
import { GRAMMARS, OTHER_NATIVE_DEPENDENCIES } from "../language-support.js";

const require = createRequire(import.meta.url);
const ROOT = join(__dirname, "..");

/**
 * The grammar versions users actually install must be the ones this repo
 * tests. Reported by a user on 2026-08-04; this file is the guard.
 *
 * ## What happened
 *
 * `package.json` declared `"tree-sitter-c-sharp": "^0.23.1"`. Three versions
 * satisfy that range — 0.23.0, 0.23.1 and 0.23.5 — and they do not share an
 * API. 0.23.1 declares `peer tree-sitter@^0.21.1` and exports
 * `{ name, language, nodeTypeInfo }`; 0.23.5 declares `peer
 * tree-sitter@^0.25.0` and exports a different shape with no `nodeTypeInfo`
 * at all. **The caret range spans a breaking change**, and npm resolves it to
 * the newest match, so every fresh `npm install -g engramgraph` got the
 * incompatible one and every single `.cs` file failed to parse.
 *
 * ## Why no test caught it
 *
 * `package-lock.json` pinned 0.23.1, so every test in this repo ran against
 * the working grammar. A published package does not carry its lockfile, so
 * consumers resolved the range fresh and got 0.23.5. **The test suite was
 * green about a version nobody would ever install.** That is the failure this
 * file exists to make impossible: not "is the grammar we have compatible",
 * which was always true, but "is the grammar we have the one users get".
 *
 * The repo even knew 0.23.5 was incompatible — `src/code-graph/grammars.d.ts`
 * documents the exact failure — and pinned `^0.23.1` as the fix. The caret
 * quietly re-admitted the version the comment warned about. A mitigation that
 * nothing verifies is indistinguishable from no mitigation.
 *
 * ## The rule
 *
 * Every tree-sitter dependency is declared as an **exact** version. Caret and
 * tilde ranges are banned for these packages specifically, because this
 * ecosystem has demonstrated it breaks ABI inside a minor range. This is not a
 * general policy about dependency hygiene; it is a response to measured
 * behaviour.
 */

interface PackageJson {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}
interface LockFile {
  packages: Record<string, { version?: string }>;
}

const pkg = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
) as PackageJson;
const lock = JSON.parse(
  readFileSync(join(ROOT, "package-lock.json"), "utf8"),
) as LockFile;

const declared: Array<[string, string]> = Object.entries({
  ...(pkg.dependencies ?? {}),
  ...(pkg.optionalDependencies ?? {}),
}).filter(([name]) => name.includes("tree-sitter"));

describe("grammar versions are pinned to what this repo tests", () => {
  it("found the dependencies at all", () => {
    // Guard before trusting: if the filter stopped matching (a rename, a move
    // to another section), every assertion below would vacuously pass over an
    // empty list — green, and measuring nothing.
    expect(declared.length).toBeGreaterThanOrEqual(13);
  });

  for (const [name, range] of declared) {
    describe(name, () => {
      it("is declared as an exact version, not a range", () => {
        expect(
          range,
          `"${name}": "${range}" — a range lets npm pick a version this repo ` +
            `has never run a test against. tree-sitter grammars have broken ` +
            `ABI inside a minor range before (see this file's header).`,
        ).toMatch(/^\d+\.\d+\.\d+$/);
      });

      it("matches the version in package-lock.json", () => {
        expect(lock.packages[`node_modules/${name}`]?.version).toBe(range);
      });

      it("matches the version actually installed", () => {
        // The declaration and the lockfile can agree with each other and both
        // disagree with what is on disk.
        const installed = require(`${name}/package.json`) as { version: string };
        expect(installed.version).toBe(range);
      });
    });
  }
});

describe("every grammar actually binds to the pinned tree-sitter core", () => {
  // The pin is only worth having if the pinned version works. This is the
  // check that would have caught 0.23.5 regardless of how it got installed:
  // it does not ask what version is present, it asks whether a real Parser
  // accepts it.
  for (const grammar of GRAMMARS) {
    it(`${grammar.label} loads and binds`, () => {
      const mod = require(grammar.package) as Record<string, unknown>;
      const raw = grammar.exportKey ? mod[grammar.exportKey] : mod;
      expect(raw, `${grammar.package} exported nothing usable`).toBeTruthy();

      const parser = new Parser();
      expect(() => parser.setLanguage(raw as Parser.Language)).not.toThrow();
    });
  }

  it("tree-sitter-c-sharp still exports nodeTypeInfo", () => {
    // The specific shape whose absence broke every .cs file. Asserted by name
    // rather than only through setLanguage, so a regression names itself
    // instead of surfacing as a generic bind failure.
    const csharp = require("tree-sitter-c-sharp") as { nodeTypeInfo?: unknown[] };
    expect(Array.isArray(csharp.nodeTypeInfo)).toBe(true);
    expect(csharp.nodeTypeInfo?.length).toBeGreaterThan(0);
  });

  it("the pinned core is the one the grammars were checked against", () => {
    const core = OTHER_NATIVE_DEPENDENCIES.find((d) => d.package === "tree-sitter");
    expect(core, "tree-sitter missing from the native dependency registry").toBeTruthy();
    const installed = require("tree-sitter/package.json") as { version: string };
    expect(installed.version).toBe(
      declared.find(([n]) => n === "tree-sitter")?.[1],
    );
  });
});
