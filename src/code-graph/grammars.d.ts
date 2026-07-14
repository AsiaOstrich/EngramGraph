/**
 * Ambient type declarations for the native tree-sitter grammar packages.
 *
 * `tree-sitter-typescript`, `tree-sitter-javascript`, `tree-sitter-c-sharp`,
 * `tree-sitter-python`, `tree-sitter-go`, `tree-sitter-java`,
 * `@tree-sitter-grammars/tree-sitter-kotlin`, `tree-sitter-rust` and
 * `tree-sitter-cpp` ship native bindings (`bindings/node`) without `.d.ts`
 * files, so we declare their shape here. Each grammar export is accepted by
 * `Parser.setLanguage` — empirically, `tree-sitter@0.22.4`'s native
 * `setLanguage` accepts both the older bare `Language` object shape and the
 * newer `{ name, language, nodeTypeInfo, ... }` wrapper shape transparently
 * (confirmed by requiring and parsing with every grammar below, not
 * assumed), so `Parser.Language` is used as the declared type for all of
 * them even though the *runtime* shape actually varies — TypeScript's
 * structural typing tolerates the wrapper objects having extra properties
 * beyond what `Parser.Language` declares.
 *
 * `tree-sitter-c-sharp` is pinned to 0.23.1 — the same version line as this
 * repo's `tree-sitter-javascript@0.23.1` (same peerDependency:
 * `tree-sitter: ^0.21.1`), matching CJS export shape
 * (`module.exports = require("node-gyp-build")(root)`, a bare `Language`
 * object). The newer 0.23.5 is a *different, incompatible* architecture: its
 * package is ESM-only (`"type": "module"`, top-level `await` — breaks a CJS
 * `require()` with `ERR_REQUIRE_ASYNC_MODULE`) and its default export is a
 * `{ name, language, nodeTypeInfo }` wrapper object built for a newer native
 * language ABI (peerDependency `tree-sitter: ^0.25.0`) that this repo's
 * `tree-sitter@0.22.4` cannot read (`Parser.setLanguage` throws reading
 * `nodeTypeNamesById` — verified empirically, not assumed from the semver
 * range alone). See XSPEC-333 R2b task notes.
 *
 * `tree-sitter-python@0.23.4`, `tree-sitter-go@0.23.4` and
 * `tree-sitter-java@0.23.5` (XSPEC-333 R2c) were each independently
 * version-checked the same way, not assumed to "just work" because R2b's
 * choice worked: `npm view <pkg>@<version> peerDependencies` was checked
 * for every candidate version of all three packages, and the version
 * actually pinned here (the newest available release whose peerDependency
 * is still `tree-sitter: ^0.21.1`, the same line as the already-proven
 * JS/TS/C# grammars — `tree-sitter-python`/`tree-sitter-go`'s next release
 * after this one jumps to peerDependency `^0.22.1`, and their newest
 * (0.25.0/0.25.0) jumps to `^0.25.0`, mirroring the exact C# 0.23.1→0.23.5
 * break pattern) was chosen specifically to stay on the proven-compatible
 * line. Each was then still empirically `require()`'d and used to parse a
 * real snippet with this repo's pinned `tree-sitter@0.22.4` core before
 * being trusted (see `test/python.test.ts` / `test/go.test.ts` /
 * `test/java.test.ts`), not left as a semver-only assumption.
 *
 * `tree-sitter-rust@0.23.1` and `tree-sitter-cpp@0.23.4` (XSPEC-333 R2c batch
 * 2) follow the exact same `npm view <pkg>@<version> peerDependencies`
 * per-version check: both were the newest release on the `tree-sitter:
 * ^0.21.1` line (`tree-sitter-rust`'s next release, 0.23.2+, jumps to
 * `^0.22.1`; `tree-sitter-cpp` happens to stay on `^0.21.1` all the way to
 * its newest 0.23.4, so the newest release *is* the pinned one here — not
 * true of the other grammars in this file, checked per-package rather than
 * assumed to generalize). Both ship prebuilt native binaries for six
 * platforms (darwin/linux/win32 × x64/arm64, via `prebuildify`) — actually
 * `require()`'d and parsed against this repo's pinned `tree-sitter@0.22.4`
 * core before being trusted (see `test/rust.test.ts` / `test/cpp.test.ts`),
 * not left as a semver-only assumption. Both export the `{ name, language,
 * nodeTypeInfo }` wrapper shape (confirmed empirically), not the older bare
 * shape — tolerated the same way as every other grammar in this file.
 *
 * `@tree-sitter-grammars/tree-sitter-kotlin@1.1.0` (peerDependency
 * `tree-sitter: ^0.22.4`, satisfied exactly by this repo's pinned core) is
 * used here, **not** the older, more widely-referenced `tree-sitter-kotlin`
 * (fwcd's original grammar, latest 0.3.8, peerDependency `tree-sitter:
 * ^0.21.0`) — a deliberate substitution made *after* drafting this file's
 * queries against fwcd's grammar and then discovering a decisive operational
 * difference, not a preference asserted up front: fwcd's package ships **no
 * prebuilt binaries at all** (confirmed by inspecting its actual published
 * tarball — `files: ["prebuilds/**", ...]` in its own package.json promises
 * them, but the 0.3.8 tarball contains none), so its `"install":
 * "node-gyp-build"` script falls through to compiling the native addon from
 * source via `node-gyp` on every install — requiring a working C/C++
 * toolchain + Python on whatever machine runs `npm install`, unlike every
 * other grammar this repo depends on (all of which have prebuilds for the
 * common platforms). `@tree-sitter-grammars/tree-sitter-kotlin@1.1.0`'s
 * tarball, by contrast, does ship real prebuilds for all six platforms
 * (verified by inspecting its tarball directly, matching
 * `tree-sitter-rust`/`tree-sitter-cpp` above) — a materially safer
 * dependency for CI/portability, which is why it was chosen instead despite
 * being a different grammar (different maintainer, different node-type
 * names) from the one this file's queries were first verified against.
 * **This is a structurally different grammar from fwcd's** — no field names
 * at all in fwcd's `node-types.json` (pure positional matching required) vs.
 * proper `name:` fields here (`function_declaration`, `class_declaration`,
 * `object_declaration` all have a `name: (identifier)` field); different
 * comment node names (fwcd: `line_comment`/`multiline_comment`; this
 * package: `line_comment`/`block_comment` — the latter already covered by
 * `tag-query-engine.ts`'s `COMMENT_NODE_TYPES`, so no engine change was
 * needed for Kotlin, unlike Java's R2c-batch1 discovery); different call-site
 * shapes (fwcd wraps member calls in `call_suffix`; this package's
 * `call_expression` holds `value_arguments` directly, one less nesting
 * level). `queries/kotlin.ts`'s patterns were verified from scratch against
 * *this* package's actual `node-types.json` and real parses, not ported from
 * the fwcd-based draft.
 */

declare module "tree-sitter-typescript" {
  import type Parser from "tree-sitter";
  const grammars: { typescript: Parser.Language; tsx: Parser.Language };
  export = grammars;
}

declare module "tree-sitter-javascript" {
  import type Parser from "tree-sitter";
  const javascript: Parser.Language;
  export = javascript;
}

declare module "tree-sitter-c-sharp" {
  import type Parser from "tree-sitter";
  const csharp: Parser.Language;
  export = csharp;
}

declare module "tree-sitter-python" {
  import type Parser from "tree-sitter";
  const python: Parser.Language;
  export = python;
}

declare module "tree-sitter-go" {
  import type Parser from "tree-sitter";
  const go: Parser.Language;
  export = go;
}

declare module "tree-sitter-java" {
  import type Parser from "tree-sitter";
  const java: Parser.Language;
  export = java;
}

declare module "@tree-sitter-grammars/tree-sitter-kotlin" {
  import type Parser from "tree-sitter";
  const kotlin: Parser.Language;
  export = kotlin;
}

declare module "tree-sitter-rust" {
  import type Parser from "tree-sitter";
  const rust: Parser.Language;
  export = rust;
}

declare module "tree-sitter-cpp" {
  import type Parser from "tree-sitter";
  const cpp: Parser.Language;
  export = cpp;
}
