/**
 * Ambient type declarations for the native tree-sitter grammar packages.
 *
 * `tree-sitter-typescript`, `tree-sitter-javascript` and `tree-sitter-c-sharp`
 * ship native bindings (`bindings/node`) without `.d.ts` files, so we declare
 * their shape here. Each grammar export is a tree-sitter `Language` object
 * accepted by `Parser.setLanguage`.
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
