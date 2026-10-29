// implements XSPEC-508
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";

/**
 * `egr index` does not walk into git LINKED WORKTREES under the root.
 *
 * The reported case: a Claude Code agent leaves `.claude/worktrees/agent-*`, each a full
 * checkout of the repo. Walked, every function exists twice, a call to a name that now has two
 * definitions is "ambiguous" and its edge is dropped (measured on dev-platform: 2,052 of 5,384
 * indexed files were worktree copies, and excluding them wrote 2,884 call edges that had been
 * lost). Run through the built CLI against a real `git worktree add`, read back from the graph.
 */

let built: BuiltEgr;
let work: string;

/** git with every repository-pointing variable cleared, so a fixture repo can never be mistaken for the real one. */
function git(cwd: string, args: string[]): string {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function egr(args: string[], db: string, cwd: string): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env, ENGRAM_DB: db };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  const r = spawnSync(process.execPath, [built.cli, ...args], { encoding: "utf8", env, cwd });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * A real repository (`lib.ts` defines `helper`, `app.ts` calls it, one document) plus one linked
 * worktree of it at `.claude/worktrees/agent-1` that holds a function only the copy has.
 */
function makeRepoWithWorktree(name: string): { repo: string; wt: string } {
  const repo = join(work, name);
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "lib.ts"), "export function helper() { return 1; }\n");
  writeFileSync(join(repo, "app.ts"), "export function appMain() { return helper(); }\n");
  writeFileSync(join(repo, "docs", "spec.md"), "---\nid: SPEC-WT-REAL\n---\n# SPEC-WT-REAL\nreal\n");
  git(repo, ["init", "-q"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  const wt = join(repo, ".claude", "worktrees", "agent-1");
  git(repo, ["worktree", "add", "-q", "-b", "agent-1", wt]);
  writeFileSync(join(wt, "extra.ts"), "export function onlyInWorktree() { return 2; }\n");
  return { repo, wt };
}

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-skip-worktrees-"));
}, 120_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

describe("egr index and git linked worktrees", () => {
  it("does not walk a linked worktree under the root: its functions and documents are not in the graph, the real call edge survives, and the summary says what it skipped", () => {
    const { repo, wt } = makeRepoWithWorktree("p1");
    // The fixture really is a linked worktree: `.git` is a file pointing at .git/worktrees/<name>.
    expect(git(wt, ["rev-parse", "--git-dir"])).toMatch(/\.git\/worktrees\/agent-1\s*$/);
    const db = join(work, "p1.db");

    const r = egr(["index", ".", "--docs"], db, repo);
    expect(r.status, r.stderr).toBe(0);
    // 2 code files of the real repo (lib.ts, app.ts); the copy's lib.ts/app.ts/extra.ts are not counted.
    expect(r.stdout).toMatch(/code: 2 files, 2 functions/);
    expect(r.stdout).toMatch(/\(1 doc\(s\) scanned/);
    // Named, not silent: which directory, how many files, and that the counts above exclude it.
    expect(r.stdout).toMatch(/skipped: 1 git worktree not walked \(\.claude\/worktrees\/agent-1\/; \d+ file\(s\)\)/);
    expect(r.stdout).toContain("absent from every count above");

    // Read back from the graph. The worktree's own function is not there...
    expect(egr(["callers", "onlyInWorktree"], db, repo).status).toBe(1);
    // ...and the call edge the duplicate definitions would have made ambiguous is.
    const callers = egr(["callers", "helper"], db, repo);
    expect(callers.status, callers.stderr).toBe(0);
    expect(callers.stdout).toContain("appMain");

    // `--json` carries the same account, and no call was dropped as ambiguous: `helper` has one definition.
    const json = JSON.parse(egr(["index", ".", "--json", "--clean"], db, repo).stdout);
    expect(json.skippedWorktrees.paths).toEqual([".claude/worktrees/agent-1/"]);
    expect(json.skippedWorktrees.files).toBeGreaterThanOrEqual(4);
    expect(json.code.ambiguous).toBe(0);
  });

  it("an index root that is itself a linked worktree is indexed normally", () => {
    const { wt } = makeRepoWithWorktree("p2");
    const db = join(work, "p2.db");

    const r = egr(["index", wt], db, wt);
    expect(r.status, r.stderr).toBe(0);
    // lib.ts, app.ts, extra.ts: all walked; nothing skipped.
    expect(r.stdout).toMatch(/code: 3 files, 3 functions/);
    expect(r.stdout).not.toContain("git worktree");
    expect(egr(["callers", "onlyInWorktree"], db, wt).status).toBe(0);
    const callers = egr(["callers", "helper"], db, wt);
    expect(callers.status, callers.stderr).toBe(0);
    expect(callers.stdout).toContain("appMain");
  });

  it("a submodule-shaped .git file (gitdir: .git/modules/...) is still walked", () => {
    const { repo } = makeRepoWithWorktree("p3");
    const sub = join(repo, "vendored-sub");
    mkdirSync(sub);
    writeFileSync(join(sub, ".git"), "gitdir: ../.git/modules/vendored-sub\n");
    writeFileSync(join(sub, "subonly.ts"), "export function onlyInSubmodule() { return 3; }\n");
    const db = join(work, "p3.db");

    const r = egr(["index", "."], db, repo);
    expect(r.status, r.stderr).toBe(0);
    expect(egr(["callers", "onlyInSubmodule"], db, repo).status).toBe(0);
    expect(r.stdout).toMatch(/skipped: 1 git worktree not walked/); // the real worktree only, not the submodule
    expect(r.stdout).not.toContain("vendored-sub");
  });
});
