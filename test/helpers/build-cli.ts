// SPDX-License-Identifier: MIT
// implements XSPEC-457
/**
 * Build the CLI and the MCP stdio entry from the CURRENT `src/` into a private
 * directory, for tests that must run the real entry points as a user does.
 *
 * Why not just use `dist/`: `test/helpers/dist-freshness.ts` explains the trap —
 * a stale `dist/` makes these tests exercise the previous version and pass. This
 * helper removes the trap instead of guarding it: the build happens inside the
 * test run, from the same `src/` the assertions are about, so there is nothing
 * to forget. It also means a test is runnable on its own, in a fresh checkout
 * with no `dist/` (which is how the evidence checker runs it), and that cutting
 * a line out of `src/` changes what the test runs — no rebuild step in between.
 *
 * Cost: ~0.3 s (esbuild, no type declarations).
 *
 * The output directory lives inside the repository root on purpose: the bundle
 * leaves `ryugraph` and the tree-sitter grammars external, and Node finds them
 * by walking up to `<root>/node_modules`. It is gitignored (`dist-test-*`).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(__dirname, "..", "..");

export interface BuiltEgr {
  /** Absolute path of the built `egr` CLI entry. */
  cli: string;
  /** Absolute path of the built `egr-mcp` stdio entry. */
  mcp: string;
  /** The build directory relative to the repo root (what `--dist` takes). */
  distRel: string;
  cleanup(): void;
}

export function buildEgr(): BuiltEgr {
  const out = mkdtempSync(join(REPO_ROOT, "dist-test-"));
  const distRel = out.slice(REPO_ROOT.length + 1);
  execFileSync(
    process.execPath,
    [
      join(REPO_ROOT, "node_modules", "tsup", "dist", "cli-default.js"),
      "src/cli/index.ts",
      "src/mcp/stdio.ts",
      "--no-config",
      "--format",
      "esm",
      "--target",
      "node22",
      "--shims",
      "--out-dir",
      distRel,
    ],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
  );
  return {
    cli: join(out, "cli", "index.js"),
    mcp: join(out, "mcp", "stdio.js"),
    distRel,
    cleanup: () => rmSync(out, { recursive: true, force: true }),
  };
}
