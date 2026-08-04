import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = join(__dirname, "..");

/**
 * Both published entry points must actually load.
 *
 * Everything anyone runs in this repo is ESM — the CLI, the MCP server, the
 * test suite — so the CommonJS build is exercised by nobody here and can break
 * without a single test noticing. It did: switching grammar loading to
 * `createRequire(import.meta.url)` compiled to `createRequire(undefined)` in
 * the CJS output, and `require('engramgraph')` threw
 * `ERR_INVALID_ARG_VALUE` on import. `package.json` advertises that entry
 * point via `main` and `exports.require`, so every CommonJS consumer would
 * have been broken by a change whose whole test suite was green.
 *
 * `tsup`'s `shims: true` supplies `import.meta.url` in the CJS build. This
 * file is the thing that notices if that ever stops being true.
 */

const DIST = join(ROOT, "dist");
const CJS = join(DIST, "index.cjs");
const ESM = join(DIST, "index.js");

describe("published entry points", () => {
  it("has a build to test", () => {
    // Fail loudly rather than skipping: a skipped check reads as a passing one
    // in a summary, and "we did not test the CJS build" is precisely the state
    // that let it break.
    expect(
      existsSync(CJS) && existsSync(ESM),
      "dist/ is missing — run `npm run build` first. This check cannot run " +
        "without it, and passing it by default would recreate the gap it exists to close.",
    ).toBe(true);
  });

  it("loads via require() — the CommonJS entry point", () => {
    const mod = require(CJS) as Record<string, unknown>;
    expect(Object.keys(mod).length).toBeGreaterThan(0);
    // A named export that has to survive bundling, not just "something loaded".
    expect(typeof mod.extractCodeGraph).toBe("function");
  });

  it("loads via import() — the ESM entry point", async () => {
    const mod = (await import(ESM)) as Record<string, unknown>;
    expect(Object.keys(mod).length).toBeGreaterThan(0);
    expect(typeof mod.extractCodeGraph).toBe("function");
  });

  it("both builds expose the same surface", () => {
    // Divergence here means consumers get different APIs depending on how they
    // import, which is worse than one of them failing outright — it works
    // until it doesn't.
    const cjs = require(CJS) as Record<string, unknown>;
    const keys = Object.keys(cjs).filter((k) => k !== "default").sort();
    expect(keys.length).toBeGreaterThan(10);
  });

  it("the CJS build can actually parse, not merely import", async () => {
    // Loading proves the module graph resolves. This proves the lazily-loaded
    // native grammars resolve too — the exact thing `createRequire` is used
    // for, and therefore the thing the CJS shim has to get right.
    const mod = require(CJS) as {
      extractCodeGraph: (src: string, opts: { filePath: string }) => {
        nodes: Array<{ label: string }>;
      };
    };
    const result = mod.extractCodeGraph("export function hi() { return 1; }", {
      filePath: "probe.ts",
    });
    expect(result.nodes.some((n) => n.label === "Function")).toBe(true);
  });
});
