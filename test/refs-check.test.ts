import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { writeFragment } from "../src/graph-db/writer.js";
import type { GraphFragment } from "../src/graph-db/types.js";
import { checkRefs } from "../src/cli/refs-check.js";

/**
 * `egr refs check` (DEC-115 L2).
 *
 * Every fixture graph/repo lives under `mkdtempSync(join(tmpdir(), ...))` —
 * never inside this repo — and every `git`-touching case is pointed at an
 * explicit `roots`/`cwd` fixture directory, never left to default to
 * `process.cwd()`, so a run of this file can never shell out against
 * EngramGraph's own real git history.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function openFixtureGraph(fragment: GraphFragment): Promise<{ conn: GraphConnection; dir: string }> {
  const dir = tmpDir("engram-refs-graph-");
  const conn = GraphConnection.open(join(dir, "graph.db"));
  await initSchema(conn);
  await writeFragment(conn, fragment);
  cleanups.push(() => void conn.close());
  return { conn, dir };
}

function writeMd(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

/** A minimal real git repo: `initFile` committed, then renamed to `renamedTo` in a second commit. */
function gitRepoWithRename(initFile: string, renamedTo: string): string {
  const root = tmpDir("engram-refs-repo-");
  git(root, "init", "-q");
  mkdirSync(join(root, initFile.split("/").slice(0, -1).join("/") || "."), { recursive: true });
  writeFileSync(join(root, initFile), "// placeholder\n");
  git(root, "add", "-A");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "add");
  git(root, "mv", initFile, renamedTo);
  git(root, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "rename");
  return root;
}

/** A git repo with commits that never touch the given path (used for a clean "missing" case). */
function emptyGitRepo(): string {
  const root = tmpDir("engram-refs-empty-repo-");
  git(root, "init", "-q");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "init", "--allow-empty");
  return root;
}

describe("refs check", () => {
  it("reports a function moved to another file as moved with its new location, not as missing", async () => {
    const { conn } = await openFixtureGraph({
      nodes: [
        { label: "Module", id: "src/new.ts", properties: { path: "src/new.ts" } },
        { label: "Function", id: "src/new.ts#doThing", properties: { name: "doThing", file: "src/new.ts", start_line: 1, confidence: 0.8, provider: "tree-sitter" } },
      ],
      edges: [],
    });
    const notesDir = tmpDir("engram-refs-notes-");
    // Real memory-note style: a symbol reference immediately followed by the
    // file it was expected to live in (this project's own MEMORY.md uses
    // exactly this "`fn`（`path`）" shape).
    const md = writeMd(notesDir, "note.md", "`doThing()`（`src/old.ts`）does the thing.\n");

    const result = await checkRefs(conn, [md], { roots: [], cwd: notesDir });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: "symbol",
      raw: "doThing()",
      status: "moved",
      location: "src/new.ts",
    });
  });

  it("reports a cited path that still resolves in the graph as present", async () => {
    const { conn } = await openFixtureGraph({
      nodes: [{ label: "Module", id: "src/a.ts", properties: { path: "src/a.ts" } }],
      edges: [],
    });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `src/a.ts` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [], cwd: notesDir });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ kind: "path", status: "present", location: "src/a.ts" });
  });

  it("reports a cited path with no graph match and no git rename as missing", async () => {
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const repo = emptyGitRepo();
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `src/gone.ts` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [repo], cwd: repo });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("missing");
  });

  it("finds a git-renamed plain file (not in the graph at all) via rename detection, not as missing", async () => {
    // The DEC-115 case this exists for: a config file or doc, never a Module
    // node, that git nonetheless knows was renamed.
    const repo = gitRepoWithRename("old.ts", "new.ts");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `old.ts` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [repo], cwd: repo });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: "moved", location: "new.ts" });
  });

  it("reports a reference into an un-indexed sibling repo as unresolvable, not missing", async () => {
    const base = tmpDir("engram-refs-siblings-");
    const indexedRoot = join(base, "IndexedRepo");
    const otherRepo = join(base, "OtherRepo");
    mkdirSync(indexedRoot, { recursive: true });
    mkdirSync(otherRepo, { recursive: true });

    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `OtherRepo/src/foo.ts` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [indexedRoot], cwd: indexedRoot });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("unresolvable");
    expect(result.items[0]!.reason).toContain("OtherRepo");
  });

  it("reports an absolute path outside every indexed root as unresolvable, not missing", async () => {
    const indexedRoot = tmpDir("engram-refs-indexed-");
    const elsewhere = tmpDir("engram-refs-elsewhere-");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", `See \`${join(elsewhere, "src/foo.ts")}\` for details.\n`);

    const result = await checkRefs(conn, [md], { roots: [indexedRoot], cwd: indexedRoot });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("unresolvable");
  });

  it("does not guess between two same-named functions in different files", async () => {
    const { conn } = await openFixtureGraph({
      nodes: [
        { label: "Function", id: "src/a.ts#run", properties: { name: "run", file: "src/a.ts", start_line: 1, confidence: 0.8, provider: "tree-sitter" } },
        { label: "Function", id: "src/b.ts#run", properties: { name: "run", file: "src/b.ts", start_line: 1, confidence: 0.8, provider: "tree-sitter" } },
      ],
      edges: [],
    });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "`run()` does the run.\n");

    const result = await checkRefs(conn, [md], { roots: [], cwd: notesDir });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("unresolvable");
    expect(result.items[0]!.candidates?.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("confirms rather than guesses when the cited file is one of the same-named candidates", async () => {
    const { conn } = await openFixtureGraph({
      nodes: [
        { label: "Function", id: "src/a.ts#run", properties: { name: "run", file: "src/a.ts", start_line: 1, confidence: 0.8, provider: "tree-sitter" } },
        { label: "Function", id: "src/b.ts#run", properties: { name: "run", file: "src/b.ts", start_line: 1, confidence: 0.8, provider: "tree-sitter" } },
      ],
      edges: [],
    });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "`run()`（`src/a.ts`）does the run.\n");

    const result = await checkRefs(conn, [md], { roots: [], cwd: notesDir });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: "present", location: "src/a.ts" });
  });

  it("does not extract a bare identifier with no parentheses or path shape (conservative extraction)", async () => {
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "This is `true` and `main` and `npm test`, plain words.\n");

    const result = await checkRefs(conn, [md], { roots: [], cwd: notesDir });

    expect(result.items).toHaveLength(0);
    expect(result.skippedTokens).toBe(3);
  });

  it("never writes to the graph it checks", async () => {
    const { conn, dir } = await openFixtureGraph({
      nodes: [
        { label: "Module", id: "src/a.ts", properties: { path: "src/a.ts" } },
        { label: "Function", id: "src/a.ts#run", properties: { name: "run", file: "src/a.ts", start_line: 1, confidence: 0.8, provider: "tree-sitter" } },
      ],
      edges: [],
    });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(
      notesDir,
      "note.md",
      ["Mixed references:", "- present: `src/a.ts`", "- missing: `src/nope.ts`", "- symbol: `run()`（`src/elsewhere.ts`）", "- unresolvable: `true`"].join("\n") + "\n",
    );

    const before = await conn.query(`MATCH (n) RETURN count(n) AS c`);
    const beforeEdges = await conn.query(`MATCH ()-[r]->() RETURN count(r) AS c`);

    const result = await checkRefs(conn, [md], { roots: [], cwd: notesDir });
    expect(result.items.length).toBeGreaterThan(0); // sanity: the run actually did something

    const after = await conn.query(`MATCH (n) RETURN count(n) AS c`);
    const afterEdges = await conn.query(`MATCH ()-[r]->() RETURN count(r) AS c`);

    expect(after[0]?.c).toBe(before[0]?.c);
    expect(afterEdges[0]?.c).toBe(beforeEdges[0]?.c);

    void dir;
  });

  it("walks a directory of Markdown files, skipping non-.md files", async () => {
    const { conn } = await openFixtureGraph({
      nodes: [{ label: "Module", id: "src/a.ts", properties: { path: "src/a.ts" } }],
      edges: [],
    });
    const notesDir = tmpDir("engram-refs-notes-dir-");
    writeMd(notesDir, "one.md", "See `src/a.ts`.\n");
    writeFileSync(join(notesDir, "ignored.txt"), "See `src/a.ts` too.\n");
    mkdirSync(join(notesDir, "sub"), { recursive: true });
    writeMd(notesDir, join("sub", "two.md"), "Also `src/a.ts`.\n");

    const result = await checkRefs(conn, [notesDir], { roots: [], cwd: notesDir });

    expect(result.filesScanned.sort()).toEqual([join(notesDir, "one.md"), join(notesDir, "sub", "two.md")].sort());
    expect(result.items).toHaveLength(2);
    expect(result.items.every((it) => it.status === "present")).toBe(true);
  });
});
