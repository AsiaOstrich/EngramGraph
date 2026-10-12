// implements XSPEC-476
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { buildEgr, REPO_ROOT, type BuiltEgr } from "./helpers/build-cli.js";

/**
 * XSPEC-476 R5 — three small things the 0.13.0-beta.3 Windows consumer report found.
 *
 *   (a) MCP `serverInfo.version` said 0.1.0 whatever the package version was.
 *   (b) `egr communities` had no `--limit` (1.3 MB of JSON on a real project).
 *   (c) `egr refs check` ran git once per reference (12 files, 75 s).
 *
 * Each test drives the built CLI or the built MCP stdio server as a child
 * process — the entry points a user has — and reads what comes back.
 */

let built: BuiltEgr;
let work: string;

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-476-r5-"));
}, 120_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

describe("XSPEC-476 R5a: MCP serverInfo.version", () => {
  it("the stdio server reports the package version in its initialize answer, not a constant [xspec476-r5a-mcp-version]", async () => {
    const pkgVersion = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [built.mcp],
        env: { ...process.env, ENGRAM_DB: join(work, "r5a.db") } as Record<string, string>,
        stderr: "ignore",
      }),
    );
    try {
      const info = client.getServerVersion();
      expect(info?.name).toBe("engramgraph");
      expect(info?.version).toBe(pkgVersion);
      expect(info?.version).not.toBe("0.1.0");
    } finally {
      await client.close();
    }
  });
});

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

describe("XSPEC-476 R5b: egr communities --limit", () => {
  type Member = { name: string; communityId: number };
  let db: string;

  beforeAll(() => {
    db = join(work, "r5b.db");
    const proj = join(work, "r5b-proj");
    mkdirSync(proj, { recursive: true });
    // Two groups that never call each other: four functions calling in a ring, and two calling each other.
    writeFileSync(
      join(proj, "big.ts"),
      [
        "export function bigOne() { bigTwo(); }",
        "export function bigTwo() { bigThree(); }",
        "export function bigThree() { bigFour(); }",
        "export function bigFour() { bigOne(); }",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(proj, "small.ts"),
      ["export function smallOne() { smallTwo(); }", "export function smallTwo() { smallOne(); }", ""].join("\n"),
    );
    const r = egr(["index", proj], db);
    if (r.status !== 0) throw new Error(`fixture index failed: ${r.stderr}`);
  }, 120_000);

  const members = (args: string[]): Member[] => {
    const r = egr(["communities", ...args, "--json"], db);
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as Member[];
  };

  it("--limit N keeps the N largest communities whole, and without it the answer is unchanged [xspec476-r5b-communities-limit]", () => {
    const all = members([]);
    const ids = [...new Set(all.map((m) => m.communityId))];
    expect(ids.length).toBeGreaterThanOrEqual(2); // fixture sanity: the two groups did not merge

    const size = (id: number) => all.filter((m) => m.communityId === id).length;
    const largest = ids.sort((a, b) => size(b) - size(a) || a - b)[0]!;
    const expected = all.filter((m) => m.communityId === largest).map((m) => m.name).sort();
    expect(expected.every((n) => n.startsWith("big"))).toBe(true); // the four-function group

    const limited = members(["--limit", "1"]);
    expect([...new Set(limited.map((m) => m.communityId))]).toEqual([largest]);
    expect(limited.map((m) => m.name).sort()).toEqual(expected); // every member of it, none of the other group
    expect(limited.length).toBeLessThan(all.length);

    // A limit at or above the number of communities changes nothing.
    expect(members(["--limit", String(ids.length)])).toEqual(all);
  });

  it("the text output says it cut something, and a limit that is not a positive whole number is an error [xspec476-r5b-communities-limit-text]", () => {
    const cut = egr(["communities", "--limit", "1"], db);
    expect(cut.status, cut.stderr).toBe(0);
    expect(cut.stdout).toMatch(/showing the 1 largest of \d+ communities/);

    const whole = egr(["communities"], db);
    expect(whole.stdout).not.toMatch(/showing the/);

    for (const bad of ["0", "-3", "abc", "1.5"]) {
      const r = egr(["communities", `--limit=${bad}`], db);
      expect(r.status, `--limit ${bad}`).toBe(1);
      expect(r.stderr).toMatch(/--limit must be a positive whole number/);
    }
  });
});
