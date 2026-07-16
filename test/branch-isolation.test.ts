import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { resolveDbPath } from "../src/graph-db/open.js";
import { sanitizeBranch } from "../src/graph-db/git-branch.js";
import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema, clearGraph } from "../src/graph-db/schema.js";
import { indexProject } from "../src/code-graph/index.js";
import { cmdGc } from "../src/cli/run.js";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "engram-iso-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t.dev"]);
  git(dir, ["config", "user.name", "t"]);
  return dir;
}

describe("sanitizeBranch", () => {
  it("is filesystem-safe and collision-free", () => {
    const a = sanitizeBranch("feature/x");
    const b = sanitizeBranch("feature-x");
    expect(a).not.toMatch(/[/\\]/); // no path separators
    expect(a).not.toBe(b); // distinct branches never collide (hash suffix)
    expect(sanitizeBranch("feature/x")).toBe(a); // deterministic
  });
});

describe("resolveDbPath priority (SPEC-245)", () => {
  const saved = { db: process.env.ENGRAM_DB, iso: process.env.ENGRAM_ISOLATION };
  beforeEach(() => {
    delete process.env.ENGRAM_DB;
    delete process.env.ENGRAM_ISOLATION;
  });
  afterAll(() => {
    if (saved.db != null) process.env.ENGRAM_DB = saved.db;
    if (saved.iso != null) process.env.ENGRAM_ISOLATION = saved.iso;
  });

  it("defaults to single ./.engram/graph.db", () => {
    expect(resolveDbPath({ cwd: "/tmp/proj" })).toBe("/tmp/proj/.engram/graph.db");
  });

  it("ENGRAM_DB env wins over everything", () => {
    process.env.ENGRAM_DB = "/abs/custom.db";
    expect(resolveDbPath({ cwd: "/tmp/proj", graph: "x", isolation: "git-branch" })).toBe("/abs/custom.db");
  });

  it("--graph names the file under .engram", () => {
    expect(resolveDbPath({ cwd: "/tmp/proj", graph: "clientX" })).toBe("/tmp/proj/.engram/clientX.db");
  });

  it("git-branch isolation maps to per-branch DB under the git dir", () => {
    const repo = initRepo();
    try {
      const onMain = resolveDbPath({ cwd: repo, isolation: "git-branch" });
      expect(onMain).toContain("/.git/engram/");
      expect(onMain).toContain(sanitizeBranch("main"));

      git(repo, ["checkout", "-b", "feature/x"]);
      const onFeature = resolveDbPath({ cwd: repo, isolation: "git-branch" });
      // AC-1: different branch → different DB file (no cross-pollution)
      expect(onFeature).not.toBe(onMain);
      expect(onFeature).toContain(sanitizeBranch("feature/x"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("git-branch falls back to single default outside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "engram-nogit-"));
    try {
      expect(resolveDbPath({ cwd: dir, isolation: "git-branch" })).toBe(join(dir, ".engram", "graph.db"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cmdGc (SPEC-245 AC-4)", () => {
  it("lists/removes orphan branch graphs, keeps live ones", () => {
    const repo = initRepo();
    try {
      git(repo, ["commit", "--allow-empty", "-m", "init"]); // main becomes a real ref
      const egrDir = join(repo, ".git", "engram");
      mkdirSync(egrDir, { recursive: true });
      const live = `${sanitizeBranch("main")}.db`;
      const orphan = `${sanitizeBranch("deleted-branch")}.db`;
      writeFileSync(join(egrDir, live), "x");
      writeFileSync(join(egrDir, orphan), "x");

      const dry = cmdGc({ cwd: repo, dryRun: true });
      expect(dry.orphans).toEqual([orphan]);
      expect(dry.deleted).toBe(false);

      const run = cmdGc({ cwd: repo, dryRun: false });
      expect(run.orphans).toEqual([orphan]);
      expect(run.deleted).toBe(true);

      const after = cmdGc({ cwd: repo, dryRun: true });
      expect(after.orphans).toEqual([]); // orphan gone, live kept
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("also removes an orphan branch's parse-health manifest sibling (XSPEC-334 R1b)", () => {
    const repo = initRepo();
    try {
      git(repo, ["commit", "--allow-empty", "-m", "init"]);
      const egrDir = join(repo, ".git", "engram");
      mkdirSync(egrDir, { recursive: true });
      const orphan = `${sanitizeBranch("deleted-branch")}.db`;
      const orphanManifest = `${sanitizeBranch("deleted-branch")}.parse-manifest.json`;
      writeFileSync(join(egrDir, orphan), "x");
      writeFileSync(join(egrDir, orphan + ".wal"), "x");
      writeFileSync(join(egrDir, orphanManifest), "{}");

      cmdGc({ cwd: repo, dryRun: false });

      expect(existsSync(join(egrDir, orphan))).toBe(false);
      expect(existsSync(join(egrDir, orphanManifest))).toBe(false); // manifest cleaned too
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports null dir outside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "engram-nogit-"));
    try {
      expect(cmdGc({ cwd: dir, dryRun: true }).dir).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Native (kuzu + tree-sitter): single shared conn, no awaited close (teardown caveat).
describe("clearGraph prune (SPEC-245 AC-2)", () => {
  let dir: string;
  let conn: GraphConnection;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "engram-clean-"));
    conn = GraphConnection.open(join(dir, "g.db"));
    await initSchema(conn);
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes all data so a re-index prunes deleted nodes", async () => {
    await indexProject(conn, [{ path: "a.ts", source: "export function a(){ return 1; }" }]);
    const before = await conn.query("MATCH (f:Function) RETURN count(f) AS n");
    expect(Number(before[0]!.n)).toBeGreaterThan(0);

    await clearGraph(conn);
    const after = await conn.query("MATCH (f:Function) RETURN count(f) AS n");
    expect(Number(after[0]!.n)).toBe(0);
  });
});
