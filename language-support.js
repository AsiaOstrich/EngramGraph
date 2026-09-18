/**
 * Single source of truth for language support and native-dependency platform
 * coverage. // implements XSPEC-365 R4
 *
 * **Why this file is plain JavaScript at the package root, not TypeScript in
 * `src/`.** Three consumers need the same facts, and one of them runs before
 * anything is built:
 *
 *   1. `preinstall.js` — runs at install time, *before* dependencies are
 *      installed and long before `dist/` exists. It cannot import from `src/`
 *      (not compiled) or `dist/` (not built at the consumer's machine, and in
 *      a published tarball the preinstall hook fires before the package's own
 *      entry points are usable). Plain ESM at the root is the only thing it
 *      can read.
 *   2. `src/code-graph/*.ts` — the runtime language registry.
 *   3. `test/language-support.test.ts` and the docs table — the consistency
 *      assertions described below.
 *
 * The alternative was to state the same matrix in three places. That is the
 * failure mode this file exists to prevent: a hard-coded enumeration is a
 * reference site waiting to go stale, and the install-time copy would be the
 * one nobody notices has drifted, because nothing renders it on a machine
 * where the install succeeded.
 *
 * **`prebuilds` is a claim about the published package, and it is checked.**
 * The values below were read off the actual installed packages, not their
 * READMEs or peerDependency ranges. `test/language-support.test.ts` re-reads
 * each package's real `prebuilds/` directory and fails if this file's claim
 * has drifted — so this is a verified assertion, not documentation that
 * happens to have been true once.
 */

/**
 * The six platform-arch pairs the tree-sitter ecosystem publishes prebuilt
 * binaries for. Format matches `${process.platform}-${process.arch}`, which is
 * also the directory naming convention `node-gyp-build` looks up at runtime.
 */
export const ALL_PLATFORMS = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
]);

/**
 * Every language the extractor can parse, the grammar package that provides
 * it, and the platforms that package ships a prebuilt binary for.
 *
 * A platform absent from `prebuilds` means `npm install` will invoke
 * `node-gyp` and compile that grammar from source there, which requires a
 * working C/C++ toolchain and Python on the installing machine.
 *
 * `extensions` is the set `detectLanguage()` maps to this language. It is
 * asserted against `detectLanguage` by test rather than used to replace it:
 * that function has ordering subtleties (`.tsx` must be tested before `.ts`;
 * `.h` deliberately routes to the C++ grammar; anything unmatched falls back
 * to `javascript`) that a flat table lookup would quietly change.
 */
export const GRAMMARS = Object.freeze([
  {
    language: "typescript",
    label: "TypeScript",
    extensions: [".ts", ".mts", ".cts"],
    package: "tree-sitter-typescript",
    // One package, two grammars — `require()` returns `{ typescript, tsx }`.
    exportKey: "typescript",
    prebuilds: ALL_PLATFORMS,
  },
  {
    language: "tsx",
    label: "TSX",
    extensions: [".tsx"],
    package: "tree-sitter-typescript",
    exportKey: "tsx",
    prebuilds: ALL_PLATFORMS,
  },
  {
    language: "javascript",
    label: "JavaScript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    package: "tree-sitter-javascript",
    prebuilds: ALL_PLATFORMS,
  },
  {
    language: "csharp",
    label: "C#",
    extensions: [".cs"],
    package: "tree-sitter-c-sharp",
    prebuilds: ALL_PLATFORMS,
  },
  {
    language: "python",
    label: "Python",
    extensions: [".py"],
    package: "tree-sitter-python",
    prebuilds: ALL_PLATFORMS,
  },
  {
    language: "go",
    label: "Go",
    extensions: [".go"],
    package: "tree-sitter-go",
    prebuilds: ALL_PLATFORMS,
  },
  {
    language: "java",
    label: "Java",
    extensions: [".java"],
    package: "tree-sitter-java",
    prebuilds: ALL_PLATFORMS,
  },
  {
    language: "kotlin",
    label: "Kotlin",
    extensions: [".kt", ".kts"],
    package: "@tree-sitter-grammars/tree-sitter-kotlin",
    prebuilds: ALL_PLATFORMS,
  },
  {
    language: "rust",
    label: "Rust",
    extensions: [".rs"],
    package: "tree-sitter-rust",
    prebuilds: ALL_PLATFORMS,
  },
  {
    language: "cpp",
    label: "C / C++",
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".h", ".hh"],
    package: "tree-sitter-cpp",
    prebuilds: ALL_PLATFORMS,
  },
  {
    /**
     * Deliberately does NOT list `.h` (XSPEC-414 R2 OQ1) — `.h` stays under
     * "cpp" above, unchanged, so `detectLanguage()`'s default for an isolated
     * `.h` file (no project context) is still C++, exactly as before this
     * language existed. `extractProject` (`src/code-graph/extractor.ts`)
     * applies a *batch-level* override on top of that default: when the
     * files being indexed together contain no unambiguous C++ source
     * (`.cpp`/`.cc`/`.cxx`/`.hpp`/`.hh`), every `.h` in that same batch is
     * treated as C instead. That override lives in `extractProject`, not
     * here, because it needs the whole file set this table has no way to
     * see — see that function's doc comment for the exact rule and its
     * known MCP-batching caveat.
     *
     * `tree-sitter-c@0.23.6` (peer `^0.22.1`) was chosen the same way as
     * every grammar in this table — by actually requiring it and calling
     * `Parser.setLanguage()` under this repo's pinned `tree-sitter@0.22.4`,
     * not by trusting the peer range: 0.23.2 through 0.23.6 all loaded and
     * parsed a real snippet cleanly, 0.24.0 and 0.24.1 (peer `^0.22.4`,
     * despite being the closer-looking match on paper) both threw inside
     * `setLanguage` (`Cannot read properties of undefined (reading
     * 'length')`) — the same "peer declarations are not evidence" lesson
     * XSPEC-365 already recorded for Dart's candidates. 0.23.6 is the
     * newest version on the working side of that empirically-found line,
     * and ships all six platform prebuilds (verified from the installed
     * package's own `prebuilds/` directory, not assumed).
     */
    language: "c",
    label: "C",
    extensions: [".c"],
    package: "tree-sitter-c",
    prebuilds: ALL_PLATFORMS,
  },
  {
    language: "ruby",
    label: "Ruby",
    extensions: [".rb"],
    package: "tree-sitter-ruby",
    prebuilds: ALL_PLATFORMS,
  },
  {
    language: "php",
    label: "PHP",
    extensions: [".php"],
    package: "tree-sitter-php",
    /**
     * `require()` returns `{ php, php_only }`. This engine uses `php` — the
     * dialect that tolerates surrounding HTML and `<?php` tags, matching how
     * real `.php` files are written. See grammars.d.ts.
     */
    exportKey: "php",
    prebuilds: ALL_PLATFORMS,
  },
  {
    /**
     * The one grammar that is not prebuilt everywhere, and the reason this
     * whole file exists. `@vokturz/tree-sitter-dart@1.0.0` ships a binary for
     * `linux-x64` only; every other platform compiles it from source.
     *
     * It was chosen anyway because it is the only Dart grammar on npm that is
     * ABI-compatible with this repo's pinned `tree-sitter@0.22.4` core — see
     * `src/code-graph/grammars.d.ts` for the four-candidate comparison that
     * established that, including the two alternatives that ship full
     * six-platform prebuilds and still fail to load. Revisit if a
     * better-maintained, fully-prebuilt Dart grammar appears.
     */
    language: "dart",
    label: "Dart",
    extensions: [".dart"],
    package: "@vokturz/tree-sitter-dart",
    prebuilds: Object.freeze(["linux-x64"]),
  },
  {
    /**
     * `tree-sitter-swift@0.7.1` (peer `^0.22.1`) — actually loaded and used
     * to parse a real snippet against this repo's pinned `tree-sitter@0.22.4`
     * before being trusted, same discipline as every entry in this table.
     * Ships all six platform prebuilds (read off the installed package's own
     * `prebuilds/` directory, not assumed from its README).
     */
    language: "swift",
    label: "Swift",
    extensions: [".swift"],
    package: "tree-sitter-swift",
    prebuilds: ALL_PLATFORMS,
  },
  {
    /**
     * `tree-sitter-bash@0.23.3` (peer `^0.21.1`, the same proven line as
     * `tree-sitter-rust`/`tree-sitter-cpp` above) — actually loaded and used
     * to parse a real script against this repo's pinned `tree-sitter@0.22.4`
     * before being trusted. The newest release, 0.25.1, jumps its peer to
     * `^0.25.0` (the same kind of break-pattern jump XSPEC-333's grammars.d.ts
     * already documents for several other languages) and was not tried empty-
     * handed against a stated-incompatible peer range; 0.23.3 is the newest
     * version still on the working line. Ships all six platform prebuilds
     * (read off the installed package's own `prebuilds/` directory).
     *
     * Extension-less shebang scripts (`#!/bin/bash`, `#!/usr/bin/env sh`,
     * XSPEC-414 R4 OQ2) are matched at walk time (`src/cli/walk.ts`), not
     * through this table's `extensions` list — a shebang script by
     * definition has no extension for a table keyed on extensions to list.
     */
    language: "bash",
    label: "Bash",
    extensions: [".sh", ".bash"],
    package: "tree-sitter-bash",
    prebuilds: ALL_PLATFORMS,
  },
]);

/**
 * Native dependencies that are not language grammars. Listed here so the
 * platform matrix in the docs can cover every native dependency rather than
 * only the graph database — the omission that let "Windows x64 ✅ Works" sit
 * in the README while installing on Windows without a C++ toolchain failed.
 */
export const OTHER_NATIVE_DEPENDENCIES = Object.freeze([
  {
    package: "tree-sitter",
    role: "tree-sitter core runtime (every language depends on it)",
    prebuilds: ALL_PLATFORMS,
  },
  {
    package: "ryugraph",
    role: "embedded graph database",
    /**
     * Ships `prebuilt/ryujs-<platform>-<arch>.node` for five of the six
     * platforms — `win32-arm64` is absent, so Windows on ARM compiles it via
     * `cmake-js`. Note this is a different mechanism from the grammars'
     * `node-gyp-build`/`prebuilds/` convention; the platform consequence is
     * the same.
     */
    prebuilds: Object.freeze([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-x64",
    ]),
  },
]);

/**
 * Known problems with the native dependencies that are not currently breaking
 * anything, recorded so the next person to hit one does not diagnose it from
 * scratch. // implements XSPEC-365 R5
 *
 * Each entry carries the condition under which it stops being an observation
 * and becomes work — a note without one is just a note, and gets read as "we
 * know, and we have decided not to care" long after the situation has changed.
 */
export const KNOWN_ISSUES = Object.freeze([
  {
    id: "tree-sitter-c-sharp-dep0151",
    package: "tree-sitter-c-sharp",
    /**
     * The package's `main` field is `"bindings/node"` with no extension, so
     * Node has to guess — which is deprecated **for ES modules**. Up to and
     * including 0.8.0 this printed on every `egr` command and on the MCP
     * server's stderr, because the grammars were imported statically as ESM.
     *
     * It no longer appears: XSPEC-365 R2 moved grammar loading to
     * `createRequire`, and DEP0151 is an ESM-resolution warning that CommonJS
     * `require` does not trigger. Measured on 2026-08-04 by indexing the same
     * file with both versions — 1 occurrence on 0.8.0, 0 after — rather than
     * inferred from not having noticed it.
     *
     * Kept as an entry rather than deleted because the underlying package is
     * unchanged. If grammar loading ever moves back to ESM `import`, the
     * warning returns, and this is the note explaining why.
     */
    symptom:
      'DEP0151 — "main" resolves without an extension. No longer surfaced (grammars load via createRequire since 0.9.0); would return if loading moved back to ESM import',
    severity: "warning-only",
    /**
     * Not fixable here — it is the upstream package's `package.json`. Patching
     * it in `node_modules` would survive exactly until the next install.
     */
    action: "none — upstream package.json; masked by CJS loading since 0.9.0",
    resolveWhen:
      "upstream publishes a release with an extension on `main` (at which point this entry can go), OR grammar loading returns to ESM import (at which point the warning returns and this entry explains it)",
    firstSeen: "2026-08-04",
  },
]);

/** `${process.platform}-${process.arch}` for the running process. */
export function currentPlatform() {
  return `${process.platform}-${process.arch}`;
}

/**
 * Native dependencies (grammars and others) that have no prebuilt binary for
 * `platform` and will therefore be compiled from source when installed there.
 *
 * @param {string} [platform] Defaults to the running platform.
 */
export function compiledFromSourceOn(platform = currentPlatform()) {
  const grammars = GRAMMARS.filter((g) => !g.prebuilds.includes(platform));
  const others = OTHER_NATIVE_DEPENDENCIES.filter(
    (d) => !d.prebuilds.includes(platform),
  );
  // One package can back more than one language (tree-sitter-typescript backs
  // both `typescript` and `tsx`), so report unique packages, each carrying the
  // languages it would take down with it.
  const byPackage = new Map();
  for (const g of grammars) {
    const entry = byPackage.get(g.package) ?? {
      package: g.package,
      kind: "grammar",
      languages: [],
    };
    entry.languages.push(g.label);
    byPackage.set(g.package, entry);
  }
  for (const d of others) {
    byPackage.set(d.package, {
      package: d.package,
      kind: "runtime",
      role: d.role,
      languages: [],
    });
  }
  return [...byPackage.values()];
}
