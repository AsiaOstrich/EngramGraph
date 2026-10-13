// SPDX-License-Identifier: MIT
// implements XSPEC-481
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * XSPEC-481 R2 — `egr communities`: a function with no CALLS edge is not a community.
 *
 * The beta.4 report: 1,813 functions of the reporter's own project had no CALLS edge, the engine gave them all
 * `communityId: -1`, and that "community" was always the largest — so `--limit 3` still printed 2,486 lines (558 KB),
 * the very thing R5b of XSPEC-476 had set out to fix, and neither the output nor the help said what `-1` was.
 *
 * The fixture has 2 real communities (a ring of three, a pair) and 3 functions that call nothing and are called by
 * nothing. Every test runs the built CLI as a child process against an indexed graph and reads what it printed.
 */

let built: BuiltEgr;
let work: string;
let db: string;

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-481-r2-"));
  db = join(work, "r2.db");
  const proj = join(work, "proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "a.ts"),
    [
      "export function ringOne() { ringTwo(); }",
      "export function ringTwo() { ringThree(); }",
      "export function ringThree() { ringOne(); }",
      "export function pairA() { pairB(); }",
      "export function pairB() { pairA(); }",
      "export function lonely1() { return 1; }",
      "export function lonely2() { return 2; }",
      "export function lonely3() { return 3; }",
      "",
    ].join("\n"),
  );
  const r = egr(["index", proj], db);
  if (r.status !== 0) throw new Error(`fixture index failed: ${r.stderr}`);
}, 120_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

function egr(args: string[], dbPath: string): { status: number | null; stdout: string; stderr: string } {
  return runEgr(built.cli, args, { env: { ...process.env, ENGRAM_DB: dbPath }, cwd: work });
}

interface Report {
  communities: Array<{ name: string; communityId: number }>;
  communityCount: number;
  shownCommunities: number;
  unclustered: { count: number; listed: boolean };
}

const json = (args: string[], dbPath = db): Report => {
  const r = egr(["communities", ...args, "--json"], dbPath);
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Report;
};

describe("XSPEC-481 R2: communities and the functions that belong to none", () => {
  it("--limit 1 prints exactly one real community, names the unclustered functions by number and lists none of them [xspec481-r2-limit-excludes-unclustered]", () => {
    const r = egr(["communities", "--limit", "1"], db);
    expect(r.status, r.stderr).toBe(0);
    const memberLines = r.stdout.split("\n").filter((l) => /^ {2}\S/.test(l));
    // The ring of three — the larger real community — and nothing else.
    expect(memberLines.map((l) => l.trim().split(" ")[0]).sort()).toEqual(["ringOne", "ringThree", "ringTwo"]);
    expect(r.stdout).not.toMatch(/lonely/);
    expect(r.stdout).toMatch(/showing the 1 largest of 2 communities/); // 2, not 3: the unclustered are not a community
    expect(r.stdout).toMatch(/unclustered: 3 function\(s\) have no CALLS edge and belong to no community \(not listed; --include-unclustered lists them\)/);
  });

  it("--json is a report with the real communities, the counts, and the number of unclustered functions [xspec481-r2-json-report]", () => {
    const all = json([]);
    expect(all.communities.map((m) => m.name).sort()).toEqual(["pairA", "pairB", "ringOne", "ringThree", "ringTwo"]);
    expect(all.communities.every((m) => m.communityId >= 0)).toBe(true);
    expect(all.communityCount).toBe(2);
    expect(all.shownCommunities).toBe(2);
    expect(all.unclustered).toEqual({ count: 3, listed: false });

    // --limit counts the real communities only: 1 keeps the larger one, 2 keeps both and says nothing was cut.
    const one = json(["--limit", "1"]);
    expect(one.communities).toHaveLength(3);
    expect(one.communityCount).toBe(2);
    expect(one.shownCommunities).toBe(1);
    const two = egr(["communities", "--limit", "2"], db);
    expect(two.stdout).not.toMatch(/showing the/);
    expect(json(["--limit", "2"]).communities).toHaveLength(5);
  });

  it("--include-unclustered lists them, marked as unclustered, and --limit still does not count them [xspec481-r2-include-flag]", () => {
    const withThem = json(["--limit", "1", "--include-unclustered"]);
    const lonely = withThem.communities.filter((m) => m.communityId === -1).map((m) => m.name).sort();
    expect(lonely).toEqual(["lonely1", "lonely2", "lonely3"]);
    expect(withThem.communities.filter((m) => m.communityId !== -1)).toHaveLength(3); // one real community, whole
    expect(withThem.communityCount).toBe(2);
    expect(withThem.shownCommunities).toBe(1);
    expect(withThem.unclustered).toEqual({ count: 3, listed: true });

    const text = egr(["communities", "--include-unclustered"], db);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/lonely1 \(.*unclustered\)/);
    expect(text.stdout).not.toMatch(/community -1/);
    expect(text.stdout).toMatch(/unclustered: 3 function\(s\).*\(listed above\)/);
  });

  it("a graph without unclustered functions says 0, so a missing line never means 'none' [xspec481-r2-zero-is-stated]", () => {
    const proj = join(work, "proj-ring");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "b.ts"), "export function oneA() { oneB(); }\nexport function oneB() { oneA(); }\n");
    const db2 = join(work, "r2-ring.db");
    expect(egr(["index", proj], db2).status).toBe(0);
    const r = egr(["communities"], db2);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/unclustered: 0 function\(s\) have no CALLS edge/);
    expect(json([], db2).unclustered).toEqual({ count: 0, listed: false });
  });

  it("the help says what unclustered means [xspec481-r2-help]", () => {
    const r = egr(["--help"], db);
    expect(r.stdout).toMatch(/--include-unclustered/);
    expect(r.stdout).toMatch(/no\s+CALLS edge belong to no community/);
  });
});
