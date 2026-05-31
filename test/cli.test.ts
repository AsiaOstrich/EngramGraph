import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { cmdIndex, cmdCallers, cmdImpact, cmdFeedback, cmdTop } from "../src/cli/run.js";

// kuzu + tree-sitter both load (cmdIndex → indexProject). Single shared conn,
// no awaited close (teardown caveat).
let dir: string;
let src: string;
let conn: GraphConnection;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "engram-cli-"));
  src = join(dir, "repo");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "a.ts"), "import {b} from './b';\nexport function a(){ return b(); }");
  writeFileSync(join(src, "b.ts"), "export function b(){ return 1; }");
  writeFileSync(join(src, "SPEC-1.md"), "---\nid: SPEC-1\nimpacted_by: [DEC-1]\n---\n# spec");
  writeFileSync(join(src, "DEC-1.md"), "---\nid: DEC-1\n---\n# decision");
  conn = GraphConnection.open(join(dir, "g.db"));
  await initSchema(conn);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("egr CLI commands", () => {
  it("index ingests code + docs", async () => {
    const r = await cmdIndex(conn, { dir: src, docs: true });
    expect(r.code.functions).toBe(2); // a, b
    expect(r.code.calls).toBeGreaterThanOrEqual(1);
    expect(r.knowledge?.specs).toBeGreaterThanOrEqual(1);
    expect(r.knowledge?.impacts).toBeGreaterThanOrEqual(1);
  });

  it("callers finds the cross-file caller", async () => {
    const rows = await cmdCallers(conn, "b", 1);
    expect(rows.map((n) => n.name)).toContain("a");
  });

  it("impact returns the decision chain", async () => {
    const r = await cmdImpact(conn, "SPEC-1", 2);
    expect(r.decisions.map((d) => d.id)).toContain("DEC-1");
  });

  it("feedback lowers confidence; top ranks", async () => {
    // feedback targets a node by id; for a Decision the id is the name (DEC-1).
    const u = await cmdFeedback(conn, "test_fail", "DEC-1", "Decision");
    expect(u).not.toBeNull();
    expect(u!.after).toBeLessThan(u!.before);
    const top = await cmdTop(conn, "Function", 10);
    expect(top.length).toBeGreaterThanOrEqual(2); // a, b
  });
});

describe("egr CLI entry (spawn)", () => {
  const run = (args: string[]) =>
    spawnSync("npx", ["tsx", "src/cli/index.ts", ...args], { encoding: "utf8", cwd: process.cwd() });

  it("--version prints the package version", () => {
    const r = run(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("--help shows usage", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: egr");
    expect(r.stdout).toContain("index");
  });
});
