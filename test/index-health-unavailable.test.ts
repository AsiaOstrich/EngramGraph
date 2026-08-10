import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readIndexHealth } from "../src/code-graph/index-health.js";

/**
 * A health signal that cannot report its own failure (XSPEC-373 B8).
 *
 * `readIndexHealth` returned null for three unrelated situations — no manifest
 * path, an unreadable manifest, and a perfectly healthy graph — and the CLI
 * renders null as the empty string. So a corrupted manifest produced output
 * byte-for-byte identical to a clean bill of health: the mechanism built to
 * reveal incomplete results was itself silent about being broken.
 */
describe("index health availability (XSPEC-373 B8)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-health-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a corrupt manifest as unknown, not as healthy", () => {
    const path = join(dir, "graph.parse-manifest.json");
    writeFileSync(path, "{ this is not json");

    const health = readIndexHealth(path, ["src/a.ts"]);

    expect(health).not.toBeNull();
    expect(health?.unavailable).toBeTruthy();
    // The distinction that matters: a healthy graph returns null, this does not.
    expect(health?.possiblyIncomplete).toBeUndefined();
  });

  it("a healthy graph still returns null — no noise added", () => {
    const path = join(dir, "graph.parse-manifest.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        runs: { "/x": { indexedAt: "2026-08-11T00:00:00.000Z", files: [{ path: "src/a.ts", language: "typescript", errorNodes: 0, errorExtent: 0, sourceExtent: 10, functions: 1, classes: 0 }] } },
      }),
    );

    expect(readIndexHealth(path, ["src/a.ts"])).toBeNull();
  });

  it("no manifest path is not a failure — the caller simply did not ask", () => {
    expect(readIndexHealth(undefined, ["src/a.ts"])).toBeNull();
  });

  it("a missing manifest file is not reported as a broken one", () => {
    // Absent is the normal pre-first-index state, not corruption.
    expect(readIndexHealth(join(dir, "nope.json"), ["src/a.ts"])?.unavailable).toBeUndefined();
  });
});
