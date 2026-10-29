// implements XSPEC-508
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileExcludes } from "../src/cli/exclude.js";
import { cmdIndex } from "../src/cli/run.js";
import { isLinkedWorktree, walkFiles } from "../src/cli/walk.js";
import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";

/**
 * Same behaviour as `index-skip-worktrees.test.ts`, run in this process (no git, no child
 * process): the `.git` file a linked worktree has is written by hand. The child-process test
 * proves the CLI wiring; this one is what the coverage threshold counts, and it pins the shapes
 * `isLinkedWorktree` must and must not recognise.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "egr-walk-worktrees-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function worktreeAt(path: string, gitdir = "/main/repo/.git/worktrees/agent-1") {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, ".git"), `gitdir: ${gitdir}\n`);
}

describe("isLinkedWorktree", () => {
  it("recognises a `.git` file pointing at <repo>/.git/worktrees/<name>, in POSIX, Windows and bare-repo spellings", () => {
    const cases = [
      "/main/repo/.git/worktrees/agent-1",
      "/main/repo/.git/worktrees/agent-1/",
      "C:\\work\\repo\\.git\\worktrees\\agent-1",
      "C:/work/repo/.git/worktrees/agent-1",
      "/srv/repo.git/worktrees/wt",
      "/main/repo/.git/modules/sub/worktrees/wt", // a worktree of a submodule is still a worktree
    ];
    for (const [i, c] of cases.entries()) {
      worktreeAt(join(dir, `w${i}`), c);
      expect(isLinkedWorktree(join(dir, `w${i}`)), c).toBe(true);
    }
  });

  it("does not recognise a submodule, an unrelated gitdir, a `.git` directory, garbage, or no `.git` at all", () => {
    worktreeAt(join(dir, "submodule"), "../.git/modules/sub");
    worktreeAt(join(dir, "elsewhere"), "/somewhere/else/.git");
    worktreeAt(join(dir, "worktrees-last"), "/main/repo/.git/worktrees"); // `worktrees` is the LAST segment: no name
    mkdirSync(join(dir, "nested-repo", ".git"), { recursive: true });
    mkdirSync(join(dir, "garbage"), { recursive: true });
    writeFileSync(join(dir, "garbage", ".git"), "not a gitdir line\n");
    mkdirSync(join(dir, "plain"), { recursive: true });
    for (const d of ["submodule", "elsewhere", "worktrees-last", "nested-repo", "garbage", "plain", "missing"]) {
      expect(isLinkedWorktree(join(dir, d)), d).toBe(false);
    }
  });
});

describe("walkFiles and linked worktrees", () => {
  function tree() {
    writeFileSync(join(dir, "real.ts"), "export function real() { return 1; }\n");
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "d.md"), "# d\n");
    worktreeAt(join(dir, ".claude", "worktrees", "agent-1"));
    writeFileSync(join(dir, ".claude", "worktrees", "agent-1", "real.ts"), "export function real() { return 2; }\n");
    writeFileSync(join(dir, ".claude", "worktrees", "agent-1", "copy.ts"), "export function copy() { return 3; }\n");
    writeFileSync(join(dir, ".claude", "worktrees", "agent-1", "notes.md"), "# copy\n");
  }

  it("does not descend into a linked worktree under the root, and reports it with a file count (code and docs walks alike)", () => {
    tree();
    const code = walkFiles(dir, [".ts"]);
    expect(code.files.map((f) => f.path)).toEqual(["real.ts"]);
    expect(code.skippedWorktrees).toEqual({ paths: [".claude/worktrees/agent-1/"], files: 3 }); // not counting the `.git` file
    const docs = walkFiles(dir, [".md"]);
    expect(docs.files.map((f) => f.path)).toEqual(["docs/d.md"]);
    expect(docs.skippedWorktrees.paths).toEqual([".claude/worktrees/agent-1/"]);
  });

  it("walks a root that is itself a linked worktree", () => {
    tree();
    const root = join(dir, ".claude", "worktrees", "agent-1");
    const r = walkFiles(root, [".ts"]);
    expect(r.files.map((f) => f.path).sort()).toEqual(["copy.ts", "real.ts"]);
    expect(r.skippedWorktrees).toEqual({ paths: [], files: 0 });
  });

  it("walks a submodule-shaped directory and a nested ordinary repository as before", () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", ".git"), "gitdir: ../.git/modules/sub\n");
    writeFileSync(join(dir, "sub", "s.ts"), "export function s() { return 1; }\n");
    mkdirSync(join(dir, "inner", ".git"), { recursive: true });
    writeFileSync(join(dir, "inner", "i.ts"), "export function i() { return 1; }\n");
    const r = walkFiles(dir, [".ts"]);
    expect(r.files.map((f) => f.path).sort()).toEqual(["inner/i.ts", "sub/s.ts"]);
    expect(r.skippedWorktrees.paths).toEqual([]);
  });

  it("a user --exclude that already names the worktree keeps counting it as excluded, not as a skipped worktree", () => {
    tree();
    const r = walkFiles(dir, [".ts"], { exclude: compileExcludes([".claude/**"]) });
    expect(r.skippedWorktrees.paths).toEqual([]);
    expect(r.excluded?.paths).toEqual([".claude/worktrees/"]);
  });

  it("the --exclude per-pattern accounting does not count files inside a worktree it would never have walked", () => {
    tree();
    // `docs` matches nothing in the worktree; `.claude` is matched, and what lies under it is counted
    // the way the walk sees it: the worktree is not entered, so only its own entries count.
    const r = walkFiles(dir, [".ts"], { exclude: compileExcludes([".claude"]) });
    expect(r.excluded?.paths).toEqual([".claude/"]);
    expect(r.excluded?.files).toBe(0);
    // The same excluded directory with the worktree replaced by an ordinary copy counts all of its files.
    rmSync(join(dir, ".claude", "worktrees", "agent-1", ".git"));
    const plain = walkFiles(dir, [".ts"], { exclude: compileExcludes([".claude"]) });
    expect(plain.excluded?.files).toBe(3);
  });

  it("per-pattern accounting looks into an excluded directory but not into a worktree inside it", () => {
    tree();
    mkdirSync(join(dir, "pkg", "keep"), { recursive: true });
    writeFileSync(join(dir, "pkg", "keep", "k.ts"), "export function k() {}\n");
    worktreeAt(join(dir, "pkg", "wt"));
    writeFileSync(join(dir, "pkg", "wt", "w.ts"), "export function w() {}\n");
    // `pkg` is covered by one pattern; the second only matches inside it, and only in the real subtree.
    const r = walkFiles(dir, [".ts"], { exclude: compileExcludes(["pkg", "pkg/keep/**", "pkg/wt/**"]) });
    const by = Object.fromEntries(r.excluded!.byPattern.map((b) => [b.pattern, b]));
    expect(by["pkg/keep/**"]!.nothingMatched).toBe(false);
    expect(by["pkg/wt/**"]!.nothingMatched).toBe(true); // the walk never sees into a worktree
  });
});

describe("cmdIndex and linked worktrees (in process)", () => {
  it("leaves the copy's functions out of the graph and reports the skip in the result", async () => {
    writeFileSync(join(dir, "lib.ts"), "export function helper() { return 1; }\n");
    writeFileSync(join(dir, "app.ts"), "export function appMain() { return helper(); }\n");
    worktreeAt(join(dir, ".claude", "worktrees", "agent-1"));
    writeFileSync(join(dir, ".claude", "worktrees", "agent-1", "lib.ts"), "export function helper() { return 1; }\n");
    writeFileSync(join(dir, ".claude", "worktrees", "agent-1", "app.ts"), "export function appMain() { return helper(); }\n");
    const conn = GraphConnection.open(join(dir, "graph.db"));
    await initSchema(conn);
    try {
      const r = await cmdIndex(conn, { dir });
      expect(r.code).toMatchObject({ files: 2, functions: 2, calls: 1, ambiguous: 0 });
      expect(r.skippedWorktrees).toEqual({ paths: [".claude/worktrees/agent-1/"], files: 2 });
      const rows = await conn.query("MATCH (f:Function) RETURN f.id AS id ORDER BY id");
      expect(rows.map((x) => x.id)).toEqual(["app.ts#appMain", "lib.ts#helper"]);
    } finally {
      await conn.close();
    }
  });

  it("--incremental: a directory that BECOMES a linked worktree leaves the graph as removed files", async () => {
    mkdirSync(join(dir, "proj", "copy"), { recursive: true });
    writeFileSync(join(dir, "proj", "real.ts"), "export function real() { return 1; }\n");
    writeFileSync(join(dir, "proj", "copy", "c1.ts"), "export function copyOne() { return 1; }\n");
    writeFileSync(join(dir, "proj", "copy", "c2.ts"), "export function copyTwo() { return 2; }\n");
    const conn = GraphConnection.open(join(dir, "graph.db"));
    await initSchema(conn);
    const manifestPath = join(dir, "graph.parse-manifest.json");
    try {
      const first = await cmdIndex(conn, { dir: join(dir, "proj"), incremental: true, manifestPath });
      expect(first.code.files).toBe(3);
      writeFileSync(join(dir, "proj", "copy", ".git"), "gitdir: /main/repo/.git/worktrees/copy\n");
      const second = await cmdIndex(conn, { dir: join(dir, "proj"), incremental: true, manifestPath });
      expect(second.incremental).toMatchObject({ mode: "incremental", removed: 2, added: 0 });
      expect(second.skippedWorktrees).toEqual({ paths: ["copy/"], files: 2 });
      const rows = await conn.query("MATCH (f:Function) RETURN f.id AS id ORDER BY id");
      expect(rows.map((x) => x.id)).toEqual(["real.ts#real"]);
    } finally {
      await conn.close();
    }
  });
});
