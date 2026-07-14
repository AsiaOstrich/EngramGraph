/**
 * Ambient type declarations for the native tree-sitter grammar packages.
 *
 * `tree-sitter-typescript`, `tree-sitter-javascript`, `tree-sitter-c-sharp`,
 * `tree-sitter-python`, `tree-sitter-go` and `tree-sitter-java` ship native
 * bindings (`bindings/node`) without `.d.ts` files, so we declare their
 * shape here. Each grammar export is accepted by `Parser.setLanguage` —
 * empirically, `tree-sitter@0.22.4`'s native `setLanguage` accepts both the
 * older bare `Language` object shape and the newer `{ name, language,
 * nodeTypeInfo, ... }` wrapper shape transparently (confirmed by requiring
 * and parsing with every grammar below, not assumed), so `Parser.Language`
 * is used as the declared type for all of them even though the *runtime*
 * shape actually varies — TypeScript's structural typing tolerates the
 * wrapper objects having extra properties beyond what `Parser.Language`
 * declares.
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
