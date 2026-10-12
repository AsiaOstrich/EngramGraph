// implements XSPEC-476
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

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

describe("XSPEC-476 R5c: egr refs check asks the history in batches, not once per reference", () => {
  const N = 12;
  let repo: string;
  let db: string;

  /** The environment for fixture git commands: this process's, minus every variable git exports to a hook. */
  const cleanGitEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const names = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8", env: process.env }).split("\n");
    for (const name of names) if (name.trim()) delete env[name.trim()];
    return env;
  };
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test.com", ...args], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: cleanGitEnv(),
    });
  const put = (rel: string, content: string): void => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  };

  /** Run `egr refs check <note> --json` with every git process it starts recorded. */
  const check = (note: string): { status: number | null; items: Array<{ raw: string; status: string; reason?: string }>; gitCalls: string[][] } => {
    const callLog = join(work, `git-calls-${Math.random().toString(36).slice(2)}.log`);
    writeFileSync(callLog, "");
    const r = spawnSync(process.execPath, [built.cli, "refs", "check", note, "--json"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ENGRAM_DB: db,
        EGR_GIT_CALL_LOG: callLog,
        NODE_OPTIONS: `--import ${pathToFileURL(join(REPO_ROOT, "test", "helpers", "git-call-log.mjs")).href}`,
      },
      cwd: work,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    const gitCalls = readFileSync(callLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
    return { status: r.status, items: (JSON.parse(r.stdout) as { items: Array<{ raw: string; status: string; reason?: string }> }).items, gitCalls };
  };

  beforeAll(() => {
    repo = join(work, "r5c-repo");
    db = join(work, "r5c.db");
    mkdirSync(repo, { recursive: true });
    git("init", "-q");
    put("src/lib.ts", "export function realFn() { return 0; }\n");
    git("add", "-A");
    git("commit", "-q", "-m", "lib");
    // N functions, each in its own file, each deleted in its own later commit — so each has its own last commit.
    for (let i = 0; i < N; i++) {
      put(`src/gone${i}.ts`, `export function goneFn${i}() { return ${i}; }\n`);
    }
    git("add", "-A");
    git("commit", "-q", "-m", "add the functions that will go");
    for (let i = 0; i < N; i++) {
      git("rm", "-q", `src/gone${i}.ts`);
      git("commit", "-q", "-m", `drop ${i}`);
    }
    const r = egr(["index", repo], db);
    if (r.status !== 0) throw new Error(`fixture index failed: ${r.stderr}`);

    const many = [];
    for (let i = 0; i < N; i++) many.push(`- symbol: \`goneFn${i}()\``, `- path: \`src/gone${i}.ts\``);
    many.push("- never existed: `neverDefinedFn()`", "- here: `realFn()`", "");
    writeFileSync(join(work, "many.md"), many.join("\n"));
    writeFileSync(join(work, "few.md"), ["- symbol: `goneFn0()`", "- path: `src/gone0.ts`", ""].join("\n"));
  }, 180_000);

  it("a document with 12 deleted symbols and 12 deleted paths starts as many git processes as one with a single of each, and each symbol gets its own commit [xspec476-r5c-batched-history]", () => {
    const many = check(join(work, "many.md"));
    const few = check(join(work, "few.md"));
    expect(many.status).toBe(1); // missing references were found
    expect(few.status).toBe(1);

    // The number of git processes does not depend on the number of references...
    expect(many.gitCalls.length).toBe(few.gitCalls.length);
    // ...and is small in absolute terms: the toplevel, the renames, the path history, the symbol history.
    expect(many.gitCalls.length).toBeLessThanOrEqual(6);
    expect(many.gitCalls.filter((a) => a.includes("log")).length).toBeLessThanOrEqual(4);

    // Batching did not blur the answers: every symbol and every path got a commit that contains it.
    const byRaw = Object.fromEntries(many.items.map((i) => [i.raw, i]));
    const symbolCommits = new Set<string>();
    for (let i = 0; i < N; i++) {
      const sym = byRaw[`goneFn${i}()`]!;
      expect(sym.status, sym.reason).toBe("missing");
      const hash = /commit ([0-9a-f]{7,})/.exec(sym.reason ?? "")?.[1];
      expect(hash, sym.reason).toBeDefined();
      symbolCommits.add(hash!);
      const shown = git("show", hash!);
      expect(shown).toContain(`goneFn${i}`);
      expect(shown, `commit for goneFn${i} must not be another symbol's`).not.toContain(`goneFn${(i + 1) % N}`);
      // The NEWEST commit that changed it: the one that dropped it, not the one that added it.
      expect(git("show", "-s", "--format=%s", hash!).trim()).toBe(`drop ${i}`);

      const path = byRaw[`src/gone${i}.ts`]!;
      expect(path.status, path.reason).toBe("missing");
      const pathHash = /commit ([0-9a-f]{7,})/.exec(path.reason ?? "")?.[1];
      expect(pathHash, path.reason).toBeDefined();
      expect(git("show", "--stat", pathHash!)).toContain(`src/gone${i}.ts`);
      expect(git("show", "-s", "--format=%s", pathHash!).trim()).toBe(`drop ${i}`); // the newest, not the commit that added it
    }
    expect(symbolCommits.size).toBe(N); // twelve different commits, not one shared by all

    // A symbol that was never defined stays unresolvable with no commit, however many others matched.
    expect(byRaw["neverDefinedFn()"]!.status).toBe("unresolvable");
    expect(byRaw["neverDefinedFn()"]!.reason).not.toMatch(/commit/);
    expect(byRaw["realFn()"]!.status).toBe("present");
  });
});
