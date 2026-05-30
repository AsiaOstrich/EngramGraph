import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/mcp/stdio.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
  // kuzu ships a native addon; keep it external so it is resolved at runtime.
  external: ["kuzu"],
});
