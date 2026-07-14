import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { walkFiles } from "../src/cli/walk.js";

// XSPEC-333 R2b: `egr index` on a real .NET repo must not walk into
// MSBuild's generated-output dirs (`bin/`, `obj/`) — those contain
// compiler-generated .cs files (e.g. AssemblyInfo.cs, *.g.cs) that would
// duplicate real symbol names into the global name index, degrading CALLS
// resolution the same way indexing node_modules would for JS/TS.
describe("walkFiles", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-walk-"));
    writeFileSync(join(dir, "Program.cs"), "class Program {}");
    mkdirSync(join(dir, "obj", "Debug"), { recursive: true });
    writeFileSync(join(dir, "obj", "Debug", "Program.AssemblyInfo.cs"), "// generated");
    mkdirSync(join(dir, "bin", "Debug"), { recursive: true });
    writeFileSync(join(dir, "bin", "Debug", "Copy.cs"), "// generated");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips bin/ and obj/ when walking a directory for .cs files", () => {
    const files = walkFiles(dir, [".cs"]).map((f) => f.path);
    expect(files).toEqual(["Program.cs"]);
  });
});
