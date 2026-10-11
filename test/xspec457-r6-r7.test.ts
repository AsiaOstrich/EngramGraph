// implements XSPEC-457
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { rankSimilar } from "../src/code-graph/lookup.js";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";

/**
 * XSPEC-457 R6 + R7 (0.13.0-beta.3) — two things the beta.2 trial found.
 *
 *   R6  `egr callers NoSuchFunctionXyz` answered "Did you mean: n, t, T, u, on?".
 *       One-letter names are substrings of almost any query, so the hint was
 *       noise that read as a broken tool. Only genuinely near names are offered;
 *       when none is, there is no "Did you mean" at all.
 *   R7  `egr index <dir> --docs` put a spec into the graph and, in the same
 *       summary, listed that same file as "unindexed". With `--docs` a file the
 *       docs pass took in is not unindexed; without `--docs` it still is.
 *
 * Every test drives the built CLI (or the built MCP stdio server) as a child
 * process and reads the printed output — the same entry points a user has.
 */

let built: BuiltEgr;
let work: string;

function egr(args: string[], db: string, cwd = work): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [built.cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ENGRAM_DB: db },
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-r6r7-"));
}, 120_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

describe("XSPEC-457 R6: 'Did you mean' offers only names that resemble the input", () => {
  let db: string;

  beforeAll(() => {
    db = join(work, "r6.db");
    const proj = join(work, "r6-proj");
    mkdirSync(proj, { recursive: true });
    // One-letter and two-letter names, as a real graph has (minified code,
    // loop helpers, generics) — each is a substring of the query below.
    writeFileSync(
      join(proj, "short.ts"),
      [
        "export function n() { return 1; }",
        "export function t() { return 2; }",
        "export function T() { return 3; }",
        "export function u() { return 4; }",
        "export function on() { return 5; }",
        "export function parseConfig() { return n() + t() + on(); }",
        "",
      ].join("\n"),
    );
    const r = egr(["index", proj], db);
    if (r.status !== 0) throw new Error(`fixture index failed: ${r.stderr}`);
  }, 120_000);

  it("callers of a name resembling nothing in the graph says it is not there and lists no suggestion at all [xspec457-r6-cli-no-suggestion]", () => {
    const r = egr(["callers", "NoSuchFunctionXyz"], db);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no function named "NoSuchFunctionXyz" is in the graph/);
    expect(r.stderr).not.toMatch(/Did you mean/);
    for (const noise of ["n", "t", "T", "u", "on"]) {
      expect(r.stderr).not.toMatch(new RegExp(`[:,] ${noise}[,?]`));
    }
  });

  it("callers of a name one letter off a real function suggests that function [xspec457-r6-cli-suggests-near]", () => {
    const r = egr(["callers", "parseConfg"], db);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Did you mean: parseConfig\?/);
    expect(r.stderr).not.toMatch(/Did you mean: [^?]*\b(n|t|T|u|on)\b[,?]/);
  });

  it("callees takes the same suggestions as callers (one shared rule, not one per command)", () => {
    expect(egr(["callees", "NoSuchFunctionXyz"], db).stderr).not.toMatch(/Did you mean/);
    expect(egr(["callees", "parseConfg"], db).stderr).toMatch(/Did you mean: parseConfig\?/);
  });

  async function mcpCall(args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [built.mcp],
        env: { ...process.env, ENGRAM_DB: db } as Record<string, string>,
        stderr: "ignore",
      }),
    );
    try {
      const res = (await client.callTool({ name: "call_chain", arguments: args })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      return { isError: res.isError === true, text: res.content.map((c) => c.text).join("\n") };
    } finally {
      await client.close();
    }
  }

  it("MCP call_chain: a name resembling nothing is an error with no 'Did you mean'; a near miss names the real function [xspec457-r6-mcp]", async () => {
    const none = await mcpCall({ symbol: "NoSuchFunctionXyz", direction: "callers" });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/no function named "NoSuchFunctionXyz" is in the graph/);
    expect(none.text).not.toMatch(/Did you mean/);

    const near = await mcpCall({ symbol: "parseConfg", direction: "callers" });
    expect(near.isError).toBe(true);
    expect(near.text).toMatch(/Did you mean: parseConfig\?/);
  });
});

describe("XSPEC-457 R6: rankSimilar (the rule both entry points share)", () => {
  it("never offers a name far shorter than the input, however it matches", () => {
    expect(rankSimilar("NoSuchFunctionXyz", ["n", "t", "T", "u", "on", "no"])).toEqual([]);
    // A near-miss of a long name is still offered, and so is a longer name that extends the input.
    expect(rankSimilar("parseConfg", ["n", "on", "parseConfig"])).toEqual(["parseConfig"]);
    expect(rankSimilar("parseConfig", ["parseConfigFile", "p"])).toEqual(["parseConfigFile"]);
  });

  it("keeps offering what it offered for short inputs and spec ids", () => {
    expect(rankSimilar("betta", ["alpha", "beta", "lonely"])).toEqual(["beta"]);
    const specs = rankSimilar("XSPEC-45", ["XSPEC-457", "XSPEC-12", "n"]);
    expect(specs[0]).toBe("XSPEC-457");
    expect(specs).not.toContain("n");
  });
});

describe("XSPEC-457 R7: --docs does not list the documents it indexed as 'unindexed'", () => {
  let dir: string;
  let db: string;

  beforeAll(() => {
    dir = join(work, "r7-proj");
    db = join(work, "r7.db");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "XSPEC-9001-only-spec.md"), "---\nid: XSPEC-9001\n---\n# XSPEC-9001\nThe only file here.\n");
  });

  it("egr index <dir> --docs: the spec is in the graph and the summary does not call it unindexed [xspec457-r7-docs]", () => {
    const r = egr(["index", dir, "--docs"], db);
    expect(r.status, r.stderr).toBe(0);
    // Read back the effect: the document really is in the graph...
    const impact = egr(["impact", "XSPEC-9001"], db);
    expect(impact.status, impact.stderr).toBe(0);
    // ...and the summary agrees with the graph.
    expect(r.stdout).toMatch(/unindexed: 0 source file\(s\)/);
    expect(r.stdout).not.toMatch(/\.md \(/);
    expect(r.stdout).not.toMatch(/unindexed: [1-9]/);
  });

  it("egr index <dir> without --docs still lists the .md as unindexed, and the spec is not in the graph [xspec457-r7-no-docs]", () => {
    const own = join(work, "r7-nodocs.db");
    const r = egr(["index", dir], own);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/unindexed: 1 source file\(s\) seen but not covered by any supported language — top extensions: \.md \(1\)/);
    expect(egr(["impact", "XSPEC-9001"], own).status).toBe(1);
  });

  it("--json: unindexedCode.count is 0 with --docs and 1 without", () => {
    const withDocs = JSON.parse(egr(["index", dir, "--docs", "--json"], join(work, "r7-json-a.db")).stdout) as {
      unindexedCode: { count: number };
    };
    const without = JSON.parse(egr(["index", dir, "--json"], join(work, "r7-json-b.db")).stdout) as {
      unindexedCode: { count: number };
    };
    expect(withDocs.unindexedCode.count).toBe(0);
    expect(without.unindexedCode.count).toBe(1);
  });

  it("with --docs, only the files the docs pass took in leave the count: other unindexed files stay listed", () => {
    const mixed = join(work, "r7-mixed");
    mkdirSync(mixed, { recursive: true });
    writeFileSync(join(mixed, "XSPEC-9002-spec.md"), "---\nid: XSPEC-9002\n---\n# XSPEC-9002\nbody\n");
    writeFileSync(join(mixed, "tool.zig"), 'print("hi")\n');
    const r = egr(["index", mixed, "--docs", "--json"], join(work, "r7-mixed.db"));
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { unindexedCode: { count: number; topExtensions: Array<{ ext: string; count: number }> } };
    expect(out.unindexedCode.count).toBe(1);
    expect(out.unindexedCode.topExtensions).toEqual([{ ext: ".zig", count: 1 }]);
  });
});
