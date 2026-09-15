/**
 * XSPEC-414 R1 Scenario (first half): `egr index` on a directory containing
 * an unsupported-language file must surface it, not silently drop it from
 * every count.
 *
 * "GIVEN a directory containing main.swift, build.sh, app.ts WHEN `egr index`
 * THEN app.ts is indexed, and the summary shows 2 unindexed files grouped by
 * .swift/.sh."
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdIndex } from "../src/cli/run.js";
import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";

describe("cmdIndex reports unindexed source files (XSPEC-414 R1)", () => {
  let dir: string;
  let src: string;
  let conn: GraphConnection;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "engram-unindexed-cmd-"));
    src = join(dir, "repo");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "main.swift"), 'print("hi")\n');
    writeFileSync(join(src, "build.sh"), "#!/bin/sh\necho hi\n");
    writeFileSync(join(src, "app.ts"), "export function hello(){ return 1; }\n");
    conn = GraphConnection.open(join(dir, "graph.db"));
    await initSchema(conn);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("indexes app.ts (the one recognized file)", async () => {
    const r = await cmdIndex(conn, { dir: src });
    expect(r.code.files).toBe(1);
    expect(r.code.functions).toBeGreaterThanOrEqual(1);
  });

  it("reports exactly 2 unindexed files, grouped by .swift and .sh", async () => {
    const r = await cmdIndex(conn, { dir: src });
    expect(r.unindexedCode.count).toBe(2);
    const byExt = new Map(r.unindexedCode.topExtensions.map((e) => [e.ext, e.count]));
    expect(byExt.get(".swift")).toBe(1);
    expect(byExt.get(".sh")).toBe(1);
  });

  it("`unindexedCode` is present even when nothing is unindexed (always-present field, not conditional like skippedSymlinkDirs)", async () => {
    const onlyTsDir = join(dir, "only-ts");
    mkdirSync(onlyTsDir, { recursive: true });
    writeFileSync(join(onlyTsDir, "a.ts"), "export const x = 1;\n");
    const r = await cmdIndex(conn, { dir: onlyTsDir, clean: true });
    expect(r.unindexedCode).toEqual({ count: 0, topExtensions: [] });
  });
});
