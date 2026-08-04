import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/mcp/stdio.ts", "src/cli/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
  // kuzu ships a native addon; keep it external so it is resolved at runtime.
  external: ["kuzu"],
  /**
   * Required by the CommonJS build. Several modules call
   * `createRequire(import.meta.url)` — `grammar-registry.ts` to load grammars
   * lazily, `parse-manifest.ts` to read their versions. `import.meta.url` does
   * not exist in CJS, so without a shim it compiles to `undefined` and
   * `require('engramgraph')` throws on import:
   *
   *   TypeError [ERR_INVALID_ARG_VALUE]: The argument 'filename' must be a
   *   file URL object, file URL string, or absolute path string.
   *   Received undefined
   *
   * The ESM entry point is unaffected, which is exactly why this went
   * unnoticed — the CLI, the MCP server and the whole test suite are ESM, so
   * nothing anyone runs here touches the broken path. `test/entrypoints.test.ts`
   * now loads both builds so the CJS one cannot break silently again.
   */
  shims: true,
});
