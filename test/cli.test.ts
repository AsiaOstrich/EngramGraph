import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { cmdIndex, cmdCallers, cmdImpact, cmdFeedback, cmdTop } from "../src/cli/run.js";
import { assertDistIsFresh } from "./helpers/dist-freshness.js";

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
  // 🔴 用 `node dist/cli/index.js`,不要用 `npx tsx src/cli/index.ts`。
  //    `tsx` **不在這個 repo 的相依裡**——本機的 `npx` 從快取拿得到,而 CI 上每次都要去
  //    registry 下載,加上 spawnSync 預設把 stdin 接成 pipe,npx 一旦要問就永遠等下去。
  //    症狀是「印一個版本號跑滿 120 秒」,讀起來像效能問題,實際是網路加一個沒人回答的提問。
  //    ⚠️ 這不是我推論出來的:同一個 repo 的 `doctor.test.ts` 用 `process.execPath` +
  //    `dist/` 且關掉 stdin,**它在同一次 CI 上是過的**——現成的對照組。
  //    `dist/` 由 `prepare` 的 tsup 產生,`npm install` 就有;而且那才是實際出貨的東西。
  const CLI = join(process.cwd(), "dist", "cli", "index.js");
  // dist/ 比 src/ 舊時,下面每一支都會啟動上一個版本然後通過。
  assertDistIsFresh(process.cwd(), CLI);

  const run = (args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

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

  // XSPEC-414 R1：使用者在終端機看到的那一行。`cmd-index-unindexed.test.ts` 只斷言
  // cmdIndex 回傳的物件——把 index.ts 摘要裡的 `${unindexed}` 拿掉，那支照樣全綠
  // （2026-09-15 主 session 突變實測：827/827 通過）。所以要從出貨的 dist 走一遍。
  it("index prints the unindexed source-file line grouped by extension", () => {
    const work = mkdtempSync(join(tmpdir(), "engram-cli-unindexed-"));
    try {
      const repo = join(work, "repo");
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "app.ts"), "export function add(a: number, b: number) { return a + b; }\n");
      writeFileSync(join(repo, "main.swift"), 'print("hi")\n');
      writeFileSync(join(repo, "build.sh"), "#!/bin/bash\necho hi\n");
      const r = spawnSync(process.execPath, [CLI, "index", repo], {
        encoding: "utf8",
        cwd: work,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ENGRAM_DB: join(work, "g.db") },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/unindexed: 2 source file\(s\)/);
      expect(r.stdout).toContain(".swift (1)");
      expect(r.stdout).toContain(".sh (1)");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
