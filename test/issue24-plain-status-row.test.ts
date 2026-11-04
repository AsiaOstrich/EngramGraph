// SPDX-License-Identifier: MIT
// implements DEC-140
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { readBodyStatus } from "../src/knowledge-graph/status.js";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * Issue #24 - `egr lint` reads a plain (not bold) status table row: `| 狀態 | Approved |`, `| Status | Approved |`.
 *
 * A spec template that writes the status as a "field | value" table row used to count every document as
 * `無法判定`, so `egr lint` exited 1 on a folder where every status was written down. The proof goes through the
 * built `egr lint` (text, `--json`, exit code) and the MCP tool `lint`, over folders this file writes:
 *
 *   plain/    the plain row, in the three labels, under a real "field | value" header     -> every document is judged
 *   inline/   the word "狀態" in prose and in table cells that are NOT the status field      -> still `無法判定`
 *
 * The second folder is what keeps the first change small: the old strictness (a bold label, or a table whose FIRST
 * cell is exactly the label) is what stops "the earlier plan was 狀態: Superseded" from being read as a status.
 */

let built: BuiltEgr;
let work: string;
let neverDb: string;

interface Report {
  status: "findings" | "undetermined" | "clean";
  undeterminedReason?: string;
  findings: Array<{ rule: string; id: string; status: string; statusSource: string }>;
  undeterminable: { count: number; files: string[] };
}

function doc(dir: string, name: string, front: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `---\n${front}\n---\n# ${name.replace(/\.md$/, "")}\n\n${body}\n`);
}

function isolatedEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const n of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8", env: process.env }).split("\n")) {
    if (n.trim()) delete e[n.trim()];
  }
  return { ...e, ENGRAM_DB: neverDb };
}

const lint = (...args: string[]) => runEgr(built.cli, ["lint", ...args], { env: isolatedEnv(), cwd: work });

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-24-"));
  neverDb = join(work, "must-not-exist", "graph.db");

  const plain = join(work, "plain");
  // A "field | value" template: the status is a plain row, the label is the whole first cell.
  doc(plain, "DEC-1.md", "id: DEC-1", "| 欄位 | 值 |\n|---|---|\n| 狀態 | Superseded（被 DEC-2 取代） |\n| 日期 | 2026-11-04 |");
  doc(plain, "DEC-2.md", "id: DEC-2", "| Field | Value |\n| --- | --- |\n| Status | Accepted |");
  doc(plain, "XSPEC-1.md", "id: XSPEC-1\nimpacted_by: [DEC-1]", "|字段|值|\n|:--|:--|\n|状态|Draft|");

  const inline = join(work, "inline");
  // Each of these mentions a status word, none of them is the status field.
  doc(inline, "XSPEC-2.md", "id: XSPEC-2", "The earlier plan was 狀態: Superseded and was dropped.");
  doc(inline, "XSPEC-3.md", "id: XSPEC-3", "| 專案狀態 | Superseded |\n| 狀態說明 | Superseded |\n| 舊狀態 | Superseded |");
  doc(inline, "XSPEC-4.md", "id: XSPEC-4", "| Status | Meaning |\n|---|---|\n| Draft | not final |");
  doc(inline, "XSPEC-5.md", "id: XSPEC-5", "See | 狀態 | Superseded | in the old template.");
}, 120_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

describe("issue #24: a plain status table row", () => {
  it("egr lint reads `| 狀態 | X |`, `| Status | X |` and `| 状态 | X |` as the status: every document is judged and the run exits 0 [issue24-plain-row]", () => {
    const r = lint(join(work, "plain"), "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    const rep = JSON.parse(r.stdout) as Report;
    expect(rep.undeterminable).toEqual({ count: 0, files: [] });
    expect(rep.undeterminedReason).toBeUndefined();
    // DEC-1's plain row says Superseded (the qualifier kept) and nobody declares it; XSPEC-1's plain row (Draft)
    // is live and cites it as its basis. Both findings exist only because the rows were read.
    const seen = rep.findings.map((f) => `${f.rule}:${f.id}:${f.status}:${f.statusSource}`).sort();
    expect(seen).toEqual([
      "live-cites-superseded:XSPEC-1:Draft:body",
      "superseded-without-declaration:DEC-1:Superseded（被 DEC-2 取代）:body",
    ]);
    // text output, same run
    const text = lint(join(work, "plain"));
    expect(text.status, text.stderr).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain("DEC-1");
  });

  it("a status word in prose, in a cell that only contains it, or under a header row is not read: the documents stay 無法判定 and the run exits 1 [issue24-not-inline]", () => {
    const r = lint(join(work, "inline"), "--json");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("無法判定 (cannot determine)");
    const rep = JSON.parse(r.stdout) as Report;
    expect(rep.status).toBe("undetermined");
    expect(rep.findings).toEqual([]);
    expect(rep.undeterminable.files.sort()).toEqual(["XSPEC-2.md", "XSPEC-3.md", "XSPEC-4.md", "XSPEC-5.md"]);
  });

  it("the MCP tool lint reads the plain row too, and still refuses the inline mentions", async () => {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [built.mcp], cwd: work, env: isolatedEnv() as Record<string, string>, stderr: "ignore" }),
    );
    try {
      type Res = { isError?: boolean; content: Array<{ text: string }> };
      const ok = (await client.callTool({ name: "lint", arguments: { dir: join(work, "plain") } })) as Res;
      expect(ok.isError).not.toBe(true);
      const rep = JSON.parse(ok.content[0]!.text) as Report;
      expect(rep.undeterminable.count).toBe(0);
      expect(rep.findings.map((f) => f.id).sort()).toEqual(["DEC-1", "XSPEC-1"]);

      const bad = (await client.callTool({ name: "lint", arguments: { dir: join(work, "inline") } })) as Res;
      expect(bad.isError).toBe(true);
      expect(bad.content[0]!.text).toContain("無法判定 (cannot determine)");
    } finally {
      await client.close();
    }
  });

  it("readBodyStatus: the plain row is read only as a table row whose first cell is exactly the label, first match in the opening section", () => {
    const cases: Array<[string, string | undefined]> = [
      ["| 狀態 | Approved |", "Approved"],
      ["| Status | Approved |", "Approved"],
      ["| 状态 | Approved |", "Approved"],
      ["|狀態|Approved|", "Approved"],
      ["  | 狀態 | ✅ Implemented v1 |  ", "Implemented v1"],
      ["| 欄位 | 值 |\n|---|---|\n| 狀態 | Draft |", "Draft"],
      // the bold row keeps working, and the first match wins whichever shape it is
      ["| **狀態** | Superseded |\n| 狀態 | Draft |", "Superseded"],
      ["| 狀態 | Draft |\n| **狀態** | Superseded |", "Draft"],
      // not read
      ["the earlier plan was 狀態: Superseded", undefined],
      ["> 狀態: Superseded", undefined],
      ["Status: Superseded", undefined],
      ["| 狀態說明 | Superseded |", undefined],
      ["| 專案狀態 | Superseded |", undefined],
      ["| 狀態碼 | 200 |", undefined],
      ["| 版本 | 狀態 | Draft |", undefined],
      ["| Status | Meaning |\n|---|---|\n| Draft | not final |", undefined],
      ["| 狀態 | 說明 |\n| :-- | :-- |\n| Draft | 未定稿 |", undefined],
      ["| 狀態 |", undefined],
      // the opening-section rule is unchanged: a fence does not count, and neither does anything after `## `
      ["```\n| 狀態 | Superseded |\n```\n| Status | Draft |", "Draft"],
      ["# T\n\n## Background\n| 狀態 | Superseded |", undefined],
    ];
    for (const [body, want] of cases) expect(readBodyStatus(body), body).toBe(want);
  });
});
