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

/** A git repo with commits that never touch the given path (used for a clean "no evidence" case). */
function emptyGitRepo(): string {
  const root = tmpDir("engram-refs-empty-repo-");
  git(root, "init", "-q");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "init", "--allow-empty");
  return root;
}

/** A git repo where `path` was committed, then deleted (not renamed) — evidence it once existed, without a git rename record. */
/** A→B (git mv), then B is deleted — the exact DEC-115 H1 R7 shape: moved once, then removed at the new location. */
function gitRepoWithRenameThenDelete(initFile: string, renamedTo: string): string {
  const root = gitRepoWithRename(initFile, renamedTo);
  git(root, "rm", "-q", renamedTo);
  git(root, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "delete after rename");
  return root;
}

/** A→B→C (two separate `git mv` commits) — C is left in place, so the chain must be chased to its real end. */
function gitRepoWithRenameChain(initFile: string, mid: string, final: string): string {
  const root = gitRepoWithRename(initFile, mid);
  git(root, "mv", mid, final);
  git(root, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "rename again");
  return root;
}

function gitRepoWithDeletedFile(path: string): string {
  const root = tmpDir("engram-refs-deleted-repo-");
  git(root, "init", "-q");
  mkdirSync(join(root, path.split("/").slice(0, -1).join("/") || "."), { recursive: true });
  writeFileSync(join(root, path), "// placeholder\n");
  git(root, "add", "-A");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "add");
  git(root, "rm", "-q", path);
  git(root, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "delete");
  return root;
}

/** A git repo where a file defining `symbolText` (e.g. `"export function foo() {}"`) was committed, then the file deleted — `git log -S<name>` evidence without any graph node. */
function gitRepoWithDeletedSymbol(path: string, symbolText: string): string {
  const root = tmpDir("engram-refs-deleted-symbol-repo-");
  git(root, "init", "-q");
  mkdirSync(join(root, path.split("/").slice(0, -1).join("/") || "."), { recursive: true });
  writeFileSync(join(root, path), `${symbolText}\n`);
  git(root, "add", "-A");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "add");
  git(root, "rm", "-q", path);
  git(root, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "delete");
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

  it("reports a path with no graph match and no evidence in git history as unresolvable, not missing (DEC-115 H1 R3)", async () => {
    // The round-3 rule: a plausible-looking path with NO evidence it ever
    // existed anywhere in the indexed root's history is `unresolvable`, not
    // a guessed `missing` — round 2's baseline rerun found most `missing`
    // guesses this shape were wrong.
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const repo = emptyGitRepo();
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `src/gone.ts` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [repo], cwd: repo });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("unresolvable");
    expect(result.items[0]!.reason).toContain("history");
  });

  it("reports a path once committed then deleted (no rename) as missing, with the last commit in the reason (DEC-115 H1 R3)", async () => {
    const repo = gitRepoWithDeletedFile("src/gone.ts");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `src/gone.ts` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [repo], cwd: repo });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("missing");
    expect(result.items[0]!.reason).toMatch(/commit [0-9a-f]+/);
  });

  it("finds a git-renamed plain file (not in the graph at all) via rename detection, not as missing", async () => {
    // The DEC-115 case this exists for: a config file or doc, never a Module
    // node, that git nonetheless knows was renamed. Nested (has a
    // directory) — a BARE filename goes through resolveBareFilename
    // instead, which deliberately never attempts a rename lookup; see the
    // next test.
    const repo = gitRepoWithRename("src/old.ts", "src/new.ts");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `src/old.ts` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [repo], cwd: repo });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: "moved", location: "src/new.ts" });
  });

  it("reports a bare filename with no directory as unresolvable, even one git could otherwise find a rename for", async () => {
    // DEC-115 H1: bare filenames (`App.tsx`, `graph.db`, no directory) were
    // the largest false-`missing` bucket in the real baseline run. There is
    // no grounded original directory to search git for, so this is
    // deliberately `unresolvable`, never `missing` and never a rename guess.
    const repo = gitRepoWithRename("old.ts", "new.ts");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `old.ts` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [repo], cwd: repo });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("unresolvable");
    expect(result.items[0]!.reason).toContain("no directory");
  });

  it("resolves a bare filename via the filesystem when it exists at the top level of exactly one indexed root", async () => {
    // DEC-115 H1: root-level files (README.md, package.json, CLAUDE.md) are
    // extremely common bare citations and DO exist — this is the bounded,
    // cheap slice of the "unique hit" refinement DEC-115 R2 left optional.
    const root = tmpDir("engram-refs-root-");
    writeFileSync(join(root, "README.md"), "# hi\n");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `README.md` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [root], cwd: root });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: "present", location: "README.md" });
  });

  it("does not guess between root-level files of the same bare name in two indexed roots", async () => {
    const rootA = tmpDir("engram-refs-rootA-");
    const rootB = tmpDir("engram-refs-rootB-");
    writeFileSync(join(rootA, "CHANGELOG.md"), "# a\n");
    writeFileSync(join(rootB, "CHANGELOG.md"), "# b\n");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `CHANGELOG.md` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [rootA, rootB], cwd: rootA });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("unresolvable");
    expect(result.items[0]!.candidates).toHaveLength(2);
  });

  it("finds a real, existing file on disk under an indexed root even when it was never a Module node (e.g. a doc)", async () => {
    // DEC-115 H1: most non-code files (.md/.sh/.yaml) are never walked into
    // a Module node, so a graph-only check reported them missing even
    // though they exist. This is the direct fix.
    const root = tmpDir("engram-refs-root-");
    mkdirSync(join(root, "cross-project", "ops"), { recursive: true });
    writeFileSync(join(root, "cross-project", "ops", "runbook.md"), "# runbook\n");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] }); // no Module node for it at all
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `cross-project/ops/runbook.md` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [root], cwd: root });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: "present", location: "cross-project/ops/runbook.md" });
  });

  it("reports a home-directory reference outside every indexed root as unresolvable, not missing", async () => {
    const root = tmpDir("engram-refs-root-");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `~/.claude/skills/` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [root], cwd: root });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("unresolvable");
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

/**
 * Extraction exclusions (DEC-115 H1). Each case is a pair by construction:
 * one line puts a noise token next to a real path in the SAME graph/root, so
 * a passing test proves both halves at once — the noise token contributes
 * no item (only `skippedTokens` grows) and the real path is still found.
 * Fixture content below is generic/synthetic, not copied from any real
 * memory file.
 */
describe("refs check extraction exclusions (DEC-115 H1)", () => {
  async function checkOneNoiseTokenNextToARealPath(noiseToken: string): Promise<{ items: number; skipped: number }> {
    const { conn } = await openFixtureGraph({
      nodes: [{ label: "Module", id: "src/real.ts", properties: { path: "src/real.ts" } }],
      edges: [],
    });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", `Noise: \`${noiseToken}\`. Real: \`src/real.ts\`.\n`);

    const result = await checkRefs(conn, [md], { roots: [], cwd: notesDir });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ kind: "path", status: "present", location: "src/real.ts" });
    return { items: result.items.length, skipped: result.skippedTokens };
  }

  it.each([
    ["glob/regex/placeholder syntax", "[^/]*"],
    ["a literal '...' placeholder", "cross-project/specs/XSPEC-316-...md"],
    ["a conventional-commit branch name", "feat/xspec-297-something"],
    ["a bare GitHub owner/repo", "AsiaOstrich/EngramGraph"],
    ["owner/repo#N", "AsiaOstrich/universal-dev-standards#165"],
    ["a bare npm package spec", "better-sqlite3@8.7.0"],
    ["a scoped npm package spec", "@asiaostrich/telemetry-client@0.1.0"],
    ["a key=value pair", "seccomp=runtime/default"],
    ["a slash-separated word list with no extension", "outDir/include/exclude/testDir"],
    ["a URL", "https://asiaostrich-telemetry.workers.dev"],
  ])("does not extract %s as a path (%s)", async (_label, noise) => {
    const { skipped } = await checkOneNoiseTokenNextToARealPath(noise);
    expect(skipped).toBeGreaterThanOrEqual(1);
  });
});

/** DEC-115 H1 R3 rules 3+4: cross-repo relative-path resolution. */
describe("refs check cross-repo relative path resolution (DEC-115 H1 R3)", () => {
  it("resolves a repo-name-prefixed path one level into that INDEXED root (rule 3)", async () => {
    const base = tmpDir("engram-refs-crossrepo-");
    const repoA = join(base, "RepoA");
    const repoB = join(base, "RepoB");
    mkdirSync(join(repoB, "src"), { recursive: true });
    writeFileSync(join(repoB, "src", "foo.ts"), "// real\n");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `RepoB/src/foo.ts` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [repoA, repoB], cwd: repoA });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: "present", location: "src/foo.ts" });
  });

  it("resolves a repo-name-prefixed path into an UN-indexed sibling as unresolvable (rule 3)", async () => {
    const base = tmpDir("engram-refs-crossrepo-");
    const indexedRoot = join(base, "IndexedRepo");
    const otherRepo = join(base, "machine-setup");
    mkdirSync(join(indexedRoot), { recursive: true });
    mkdirSync(join(otherRepo, "machines", "nb28-mac"), { recursive: true });
    writeFileSync(join(otherRepo, "machines", "nb28-mac", "README.md"), "# nb28\n");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `machine-setup/machines/nb28-mac/README.md` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [indexedRoot], cwd: indexedRoot });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("unresolvable");
  });

  it("finds an unqualified path (repo-name prefix dropped) inside an UN-indexed sibling as unresolvable, not missing (rule 4)", async () => {
    // The exact DEC-115 H1 R3 case: a note drops the `machine-setup/`
    // prefix its own context implied, citing just `machines/nb28-mac/…`.
    const base = tmpDir("engram-refs-crossrepo-");
    const indexedRoot = join(base, "IndexedRepo");
    const otherRepo = join(base, "machine-setup");
    mkdirSync(join(indexedRoot), { recursive: true });
    mkdirSync(join(otherRepo, "machines", "nb28-mac"), { recursive: true });
    writeFileSync(join(otherRepo, "machines", "nb28-mac", "README.md"), "# nb28\n");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `machines/nb28-mac/README.md` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [indexedRoot], cwd: indexedRoot });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("unresolvable");
    expect(result.items[0]!.reason).toContain("machine-setup");
  });

  it("an unqualified path that exists in NO sibling either still falls through to the evidence rule (missing/unresolvable by history)", async () => {
    const base = tmpDir("engram-refs-crossrepo-");
    const indexedRoot = join(base, "IndexedRepo");
    mkdirSync(indexedRoot, { recursive: true });
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `routes/interview.ts` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [indexedRoot], cwd: indexedRoot });

    expect(result.items).toHaveLength(1);
    // No sibling has it, and the indexed root's (empty) git history has no
    // evidence either — no rename lookup on a non-git dir is "unavailable",
    // which this checker also treats as missing (git absence must not read
    // as a confirmed deletion) OR unresolvable if git IS available but empty;
    // either way it must NOT silently become `present`.
    expect(["missing", "unresolvable"]).toContain(result.items[0]!.status);
  });
});

/** DEC-115 H1 R3 rule 1 (symbol half): missing requires git-history evidence. */
describe("refs check symbol evidence requirement (DEC-115 H1 R3)", () => {
  it("reports a symbol once defined (git evidence) but now gone from the graph as missing, with a commit in the reason", async () => {
    const repo = gitRepoWithDeletedSymbol("src/oldFn.ts", "export function myVanishedFunc() { return 1; }");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "`myVanishedFunc()` used to do the thing.\n");

    const result = await checkRefs(conn, [md], { roots: [repo], cwd: repo });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("missing");
    expect(result.items[0]!.reason).toMatch(/commit [0-9a-f]+/);
  });

  it("reports a symbol with no graph match and no git evidence anywhere as unresolvable, not missing", async () => {
    const repo = emptyGitRepo();
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "`totallyMadeUpFunctionName()` was called here.\n");

    const result = await checkRefs(conn, [md], { roots: [repo], cwd: repo });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("unresolvable");
    expect(result.items[0]!.reason).toContain("evidence");
  });
});

/** Symbol precision (DEC-115 H1). */
describe("refs check symbol precision (DEC-115 H1)", () => {
  it("reports a JS/Node built-in namespace call as unresolvable, not missing", async () => {
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "Uses `process.cwd()` internally.\n");

    const result = await checkRefs(conn, [md], { roots: [], cwd: notesDir });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("unresolvable");
    expect(result.items[0]!.reason).toContain("built-in");
  });

  it("does not guess a member call belongs to an unrelated same-named function (the useAuth.restore() case)", async () => {
    // The exact DEC-115 H1 regression: a Function named `restore` exists,
    // but in a file that has nothing to do with `useAuth`. The round-1
    // "match the last dot segment" fallback reported this as `moved` to
    // that unrelated file — a guess D2 forbids.
    const { conn } = await openFixtureGraph({
      nodes: [{ label: "Function", id: "src/unrelated.ts#restore", properties: { name: "restore", file: "src/unrelated.ts", start_line: 1, confidence: 0.8, provider: "tree-sitter" } }],
      edges: [],
    });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "Calls `useAuth.restore()` on mount.\n");

    const result = await checkRefs(conn, [md], { roots: [], cwd: notesDir });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("unresolvable");
    expect(result.items[0]!.status).not.toBe("moved");
  });

  it("resolves a confirmed Class.method dotted reference (base is a real Class, method is a Function in the same file)", async () => {
    const { conn } = await openFixtureGraph({
      nodes: [
        { label: "Class", id: "src/cache.ts#Cache", properties: { name: "Cache", file: "src/cache.ts", provider: "tree-sitter" } },
        { label: "Function", id: "src/cache.ts#get", properties: { name: "get", file: "src/cache.ts", start_line: 5, confidence: 0.8, provider: "tree-sitter" } },
      ],
      edges: [],
    });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "Calls `Cache.get()` to read.\n");

    const result = await checkRefs(conn, [md], { roots: [], cwd: notesDir });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: "present", location: "src/cache.ts" });
  });
});

/** Every `missing`/`unresolvable` item carries a `reason` (DEC-115 H1 R6). */
describe("refs check reason coverage (DEC-115 H1)", () => {
  it("sets a reason on both a missing path and an unresolvable path", async () => {
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const repo = emptyGitRepo();
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "Gone: `src/gone.ts`. Elsewhere: `~/.claude/skills/`.\n");

    const result = await checkRefs(conn, [md], { roots: [repo], cwd: repo });

    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      expect(["missing", "unresolvable"]).toContain(item.status);
      expect(item.reason, `${item.raw} (${item.status}) has no reason`).toBeTruthy();
    }
  });
});

/**
 * DEC-115 H1 acceptance: reproduce the baseline's category mix on one
 * fixture (a small multi-repo directory + one Markdown file), not copied
 * from any real memory content.
 */
describe("refs check reproduces the DEC-115 H1 baseline categories on one fixture", () => {
  it("classifies every category correctly in a single run", async () => {
    const base = tmpDir("engram-refs-baseline-");
    const repoA = join(base, "RepoA");
    const repoB = join(base, "RepoB");
    const siblingUnindexed = join(base, "SiblingRepo");
    mkdirSync(join(repoA, "cross-project", "ops"), { recursive: true });
    mkdirSync(repoB, { recursive: true });
    mkdirSync(siblingUnindexed, { recursive: true });
    writeFileSync(join(repoA, "README.md"), "# a\n");
    writeFileSync(join(repoA, "cross-project", "ops", "runbook.md"), "# runbook\n");

    const { conn } = await openFixtureGraph({
      nodes: [
        { label: "Module", id: "src/known.ts", properties: { path: "src/known.ts" } },
        { label: "Function", id: "src/cache.ts#get", properties: { name: "get", file: "src/cache.ts", start_line: 1, confidence: 0.8, provider: "tree-sitter" } },
        { label: "Class", id: "src/cache.ts#Cache", properties: { name: "Cache", file: "src/cache.ts", provider: "tree-sitter" } },
      ],
      edges: [],
    });

    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(
      notesDir,
      "note.md",
      [
        "- in-graph path: `src/known.ts`",
        "- real file, not a Module node: `cross-project/ops/runbook.md`",
        "- root-level bare filename, unique hit: `README.md`",
        "- bare filename, no hit anywhere: `some-random-file.ts`",
        "- outside every indexed root: `~/.claude/skills/`",
        "- sibling repo that exists but isn't indexed: `SiblingRepo/notes.md`",
        "- glob noise: `[^/]*`",
        "- branch-name noise: `feat/xspec-297-something`",
        "- owner/repo noise: `AsiaOstrich/EngramGraph`",
        "- built-in call: `process.cwd()`",
        "- confirmed Class.method: `Cache.get()`",
        "- member call on a non-class base: `useAuth.restore()`",
      ].join("\n") + "\n",
    );

    const result = await checkRefs(conn, [md], { roots: [repoA, repoB], cwd: repoA });
    const byRaw = new Map(result.items.map((it) => [it.raw, it]));

    expect(byRaw.get("src/known.ts")?.status).toBe("present");
    expect(byRaw.get("cross-project/ops/runbook.md")?.status).toBe("present");
    expect(byRaw.get("README.md")?.status).toBe("present");
    expect(byRaw.get("some-random-file.ts")?.status).toBe("unresolvable");
    expect(byRaw.get("~/.claude/skills/")?.status).toBe("unresolvable");
    expect(byRaw.get("SiblingRepo/notes.md")?.status).toBe("unresolvable");
    expect(byRaw.get("process.cwd()")?.status).toBe("unresolvable");
    expect(byRaw.get("Cache.get()")?.status).toBe("present");
    expect(byRaw.get("useAuth.restore()")?.status).toBe("unresolvable");
    // The three noise tokens never became items at all.
    expect(byRaw.has("[^/]*")).toBe(false);
    expect(byRaw.has("feat/xspec-297-something")).toBe(false);
    expect(byRaw.has("AsiaOstrich/EngramGraph")).toBe(false);
  });
});

/**
 * DEC-115 H1 R4 bug 1: dev-platform's real graph indexes SEVERAL git repos
 * under separate roots (each sub-project symlinked in, each with its own
 * `.git`) — round 3's `roots[0]`-only fallback silently missed every real
 * deletion that lived in any OTHER indexed repo. These fixtures mirror that
 * shape: a "primary" root with its own (empty, for this path) history, and
 * a separate sub-repo root with real history, referenced by a path that is
 * relative to the SUB-repo (no repo-name prefix — the shape a note written
 * from inside that sub-repo actually uses).
 */
describe("refs check multi-repo history (DEC-115 H1 R4 bug 1)", () => {
  it("finds a deleted file's evidence in a sub-repo root that is NOT the first indexed root", async () => {
    const primaryRoot = tmpDir("engram-refs-primary-");
    git(primaryRoot, "init", "-q");
    git(primaryRoot, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "init", "--allow-empty");
    const subRepo = gitRepoWithDeletedFile("src/license/index.ts");

    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `src/license/index.ts` for details.\n");

    // primaryRoot listed FIRST — round 3 only ever checked roots[0].
    const result = await checkRefs(conn, [md], { roots: [primaryRoot, subRepo], cwd: primaryRoot });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("missing");
    expect(result.items[0]!.reason).toMatch(/commit [0-9a-f]+/);
  });

  it("reports unresolvable when NO indexed root's history has evidence, even across several roots", async () => {
    const primaryRoot = emptyGitRepo();
    const subRepo = emptyGitRepo();
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `src/never/existed.ts` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [primaryRoot, subRepo], cwd: primaryRoot });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("unresolvable");
  });
});

/**
 * DEC-115 H1 R4 bug 2: `git log -S` (plain pickaxe) matched ANY text
 * containing the name — a mere mention in a memory note or doc, or a call
 * site, counted the same as a real definition. The fix restricts evidence
 * to a DEFINITION shape (`function NAME`, `NAME = (`, `NAME() {`, …) in
 * source-code files only.
 */
describe("refs check symbol definition evidence (DEC-115 H1 R4 bug 2)", () => {
  it("does not treat a mere mention in a Markdown file as definition evidence — unresolvable, not missing", async () => {
    const repo = tmpDir("engram-refs-mention-repo-");
    git(repo, "init", "-q");
    writeFileSync(join(repo, "notes.md"), "Some notes mentioning myMentionedOnlyFunc in prose, not code.\n");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "add notes");

    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "`myMentionedOnlyFunc()` was called here.\n");

    const result = await checkRefs(conn, [md], { roots: [repo], cwd: repo });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("unresolvable");
  });

  it("does not treat a mere call site (no definition shape) in code as definition evidence — unresolvable, not missing", async () => {
    const repo = tmpDir("engram-refs-call-only-repo-");
    git(repo, "init", "-q");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "caller.ts"), "myCalledOnlyFunc();\n");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "add");
    git(repo, "rm", "-q", "src/caller.ts");
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "delete");

    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "`myCalledOnlyFunc()` used to run here.\n");

    const result = await checkRefs(conn, [md], { roots: [repo], cwd: repo });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("unresolvable");
  });

  it("still finds a real code DEFINITION as evidence (positive control, unchanged from the -S era)", async () => {
    const repo = gitRepoWithDeletedSymbol("src/oldFn2.ts", "export function myOtherVanishedFunc() { return 2; }");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "`myOtherVanishedFunc()` used to do the other thing.\n");

    const result = await checkRefs(conn, [md], { roots: [repo], cwd: repo });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("missing");
    expect(result.items[0]!.reason).toMatch(/commit [0-9a-f]+/);
  });
});

/** DEC-115 H1 R4: extraction-side symbol-shape tightening. */
describe("refs check does not extract code-snippet-shaped tokens as symbols (DEC-115 H1 R4)", () => {
  it.each([
    ["shell command substitution", "$(dirname $0)"],
    ["an arrow-function literal", "filter(x => !x.done)"],
    ["a comparison expression", "fileURLToPath(import.meta.url) === path.resolve(process.argv[1])"],
    ["a string-literal argument", "createHash('sha256')"],
  ])("does not extract %s as a symbol call (%s)", async (_label, noise) => {
    const { conn } = await openFixtureGraph({
      nodes: [{ label: "Function", id: "src/real.ts#realFn", properties: { name: "realFn", file: "src/real.ts", start_line: 1, confidence: 0.8, provider: "tree-sitter" } }],
      edges: [],
    });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", `Noise: \`${noise}\`. Real: \`realFn()\`.\n`);

    const result = await checkRefs(conn, [md], { roots: [], cwd: notesDir });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ kind: "symbol", status: "present", location: "src/real.ts" });
  });
});

/**
 * DEC-115 H1 R5: the real shape. dev-platform's actual parse-manifest keys
 * are subdirectories of a repo (`vibeops/src`, `vibeops/scripts`, …), not
 * the repo root — each still has its own real `.git` one level up (or
 * more). A memory note is written as if standing at the REPO the citation
 * describes, so its paths (`src/license/index.ts`) are repo-root-relative,
 * not relative to whichever subdirectory happened to be indexed.
 */
describe("refs check subdirectory index roots (DEC-115 H1 R5)", () => {
  it("finds real deletions with a correct commit, with the index root a SUBDIRECTORY of the repo", async () => {
    const repoRoot = tmpDir("engram-refs-subrepo-");
    git(repoRoot, "init", "-q");
    mkdirSync(join(repoRoot, "src", "license"), { recursive: true });
    writeFileSync(join(repoRoot, "src", "license", "index.ts"), "// placeholder\n");
    // A file that stays — the index root ("src") must still exist ON DISK
    // after the delete commit below, or `git -C <indexRoot>` itself fails
    // (`cannot change to '<indexRoot>': No such file or directory`) — not
    // this fix's bug, just what happens when the ONLY file under a
    // directory is removed and nothing else lives there.
    writeFileSync(join(repoRoot, "src", "keep.ts"), "// stays\n");
    mkdirSync(join(repoRoot, "scripts"), { recursive: true });
    writeFileSync(join(repoRoot, "scripts", "setup-hooks.sh"), "#!/bin/sh\n");
    git(repoRoot, "add", "-A");
    git(repoRoot, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "add");
    git(repoRoot, "rm", "-q", "src/license/index.ts");
    git(repoRoot, "rm", "-q", "scripts/setup-hooks.sh");
    git(repoRoot, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "delete");

    const indexRoot = join(repoRoot, "src"); // the manifest's real shape: a subdirectory, not the repo root

    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(
      notesDir,
      "note.md",
      // `src/license/index.ts` is repo-root-relative (inside the indexed
      // subtree). `scripts/setup-hooks.sh` is ALSO repo-root-relative but
      // OUTSIDE the indexed subtree entirely — same repo, different subdir.
      "See `src/license/index.ts` and `scripts/setup-hooks.sh` for details.\n",
    );

    const result = await checkRefs(conn, [md], { roots: [indexRoot], cwd: indexRoot });

    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      expect(item.status, `${item.raw}: expected missing`).toBe("missing");
      expect(item.reason, `${item.raw}: expected a real commit`).toMatch(/commit [0-9a-f]+/);
      expect(item.reason).not.toContain("could not be determined");
    }
  });

  it("reports unresolvable for a path that never existed, even with a subdirectory index root", async () => {
    const repoRoot = tmpDir("engram-refs-subrepo-empty-");
    git(repoRoot, "init", "-q");
    git(repoRoot, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "init", "--allow-empty");
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    const indexRoot = join(repoRoot, "src");

    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `src/never/existed.ts` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [indexRoot], cwd: indexRoot });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("unresolvable");
  });
});

/** DEC-115 H1 R5 item 4: test-framework/platform globals treated like built-ins. */
describe("refs check test-framework globals are not treated as project symbols (DEC-115 H1 R5)", () => {
  it.each([
    ["expect", "expect(x)"],
    ["a mock* method", "mockImplementation(fn)"],
    ["describe", "describe(name)"],
    ["it", "it(name)"],
    ["vi (dotted)", "vi.fn()"],
    ["jest (dotted)", "jest.fn()"],
    ["fetch", "fetch(url)"],
  ])("does not treat %s as a project symbol (%s)", async (_label, tok) => {
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", `Uses \`${tok}\` here.\n`);

    const result = await checkRefs(conn, [md], { roots: [], cwd: notesDir });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("unresolvable");
  });
});

/**
 * DEC-115 H1 R6 item 1: directory references. Git only ever records file
 * renames/history, never a directory as such — "the directory once
 * existed" has to be read off the same file-path history set as a prefix
 * scan, and "moved" only when every renamed file under it lands under one
 * consistent new prefix. Fixture uses the real shape: index root is a
 * SUBDIRECTORY of the repo.
 */
describe("refs check directory references (DEC-115 H1 R6 item 1)", () => {
  it("reports a directory once populated, now gone, as missing with a real commit", async () => {
    const repoRoot = tmpDir("engram-refs-dirrepo-");
    git(repoRoot, "init", "-q");
    mkdirSync(join(repoRoot, "src", "orchestrator"), { recursive: true });
    writeFileSync(join(repoRoot, "src", "orchestrator", "a.ts"), "// a\n");
    writeFileSync(join(repoRoot, "src", "orchestrator", "b.ts"), "// b\n");
    writeFileSync(join(repoRoot, "src", "keep.ts"), "// stays\n"); // keeps the index root alive on disk
    git(repoRoot, "add", "-A");
    git(repoRoot, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "add");
    git(repoRoot, "rm", "-qr", "src/orchestrator");
    git(repoRoot, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "remove dir");

    const indexRoot = join(repoRoot, "src");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `src/orchestrator/` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [indexRoot], cwd: indexRoot });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ kind: "path", status: "missing" });
    expect(result.items[0]!.reason).toMatch(/commit [0-9a-f]+/);
  });

  it("reports a directory that never existed as unresolvable, not missing", async () => {
    const repoRoot = tmpDir("engram-refs-dirrepo-empty-");
    git(repoRoot, "init", "-q");
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    writeFileSync(join(repoRoot, "src", "keep.ts"), "// stays\n");
    git(repoRoot, "add", "-A");
    git(repoRoot, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "add");

    const indexRoot = join(repoRoot, "src");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `src/never-existed/` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [indexRoot], cwd: indexRoot });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("unresolvable");
  });

  it("reports a whole-directory rename as moved to the new directory", async () => {
    const repoRoot = tmpDir("engram-refs-dirrepo-moved-");
    git(repoRoot, "init", "-q");
    mkdirSync(join(repoRoot, "src", "oldname"), { recursive: true });
    writeFileSync(join(repoRoot, "src", "oldname", "a.ts"), "// a\n");
    writeFileSync(join(repoRoot, "src", "oldname", "b.ts"), "// b\n");
    writeFileSync(join(repoRoot, "src", "keep.ts"), "// stays\n");
    git(repoRoot, "add", "-A");
    git(repoRoot, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "add");
    git(repoRoot, "mv", "src/oldname", "src/newname");
    git(repoRoot, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "rename dir");

    const indexRoot = join(repoRoot, "src");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `src/oldname/` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [indexRoot], cwd: indexRoot });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: "moved", location: "src/newname/" });
  });
});

/** DEC-115 H1 R6 item 2: an indexed repo's own history/disk evidence must win over a coincidentally-named un-indexed sibling. */
describe("refs check evidence outranks the sibling-repo guess (DEC-115 H1 R6 item 2)", () => {
  it("resolves a path found in an INDEXED repo's history as missing, even though a sibling directory shares its first segment's name", async () => {
    const base = tmpDir("engram-refs-evidence-vs-sibling-");
    const repoRoot = join(base, "UDS");
    mkdirSync(repoRoot, { recursive: true });
    git(repoRoot, "init", "-q");
    mkdirSync(join(repoRoot, "scripts"), { recursive: true });
    writeFileSync(join(repoRoot, "scripts", "setup-hooks.sh"), "#!/bin/sh\n");
    writeFileSync(join(repoRoot, "README.md"), "# uds\n");
    git(repoRoot, "add", "-A");
    git(repoRoot, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "add");
    git(repoRoot, "rm", "-q", "scripts/setup-hooks.sh");
    git(repoRoot, "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-q", "-m", "remove");

    // A directory literally named "scripts" sitting as a SIBLING of the
    // indexed root itself (`join(dirname(root), firstSeg)` — exactly what
    // `siblingRepoExists` checks) — "scripts" is an extremely common
    // directory name, exactly the coincidence that used to win.
    mkdirSync(join(base, "scripts"), { recursive: true });
    const otherIndexed = join(base, "OtherIndexed");
    mkdirSync(otherIndexed, { recursive: true });

    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `scripts/setup-hooks.sh` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [repoRoot, otherIndexed], cwd: repoRoot });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: "missing" });
    expect(result.items[0]!.reason).toMatch(/commit [0-9a-f]+/);
    expect(result.items[0]!.reason).not.toContain("indexed roots");
  });
});

/**
 * DEC-115 H1 R7: a rename chain's END is not guaranteed to still exist — a
 * file can move once, then be deleted at its new location. `findRenameTarget`
 * (and its directory counterpart) always chased the chain, but never
 * verified the chain's last stop was still there before reporting `moved`.
 */
describe("refs check verifies a moved target still exists (DEC-115 H1 R7)", () => {
  it("reports moved when the renamed-to file still exists", async () => {
    const repo = gitRepoWithRename("src/old.ts", "src/new.ts");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `src/old.ts` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [repo], cwd: repo });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: "moved", location: "src/new.ts" });
  });

  it("reports missing (with the deletion commit) when the file moved once, then was removed at the new location", async () => {
    const repo = gitRepoWithRenameThenDelete("src/old.ts", "src/new.ts");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `src/old.ts` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [repo], cwd: repo });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: "missing" });
    expect(result.items[0]!.reason).toContain("src/new.ts");
    expect(result.items[0]!.reason).toMatch(/commit [0-9a-f]+/);
  });

  it("chases a two-hop rename chain (A→B→C) to its real end and reports C when C exists", async () => {
    const repo = gitRepoWithRenameChain("src/a.ts", "src/b.ts", "src/c.ts");
    const { conn } = await openFixtureGraph({ nodes: [], edges: [] });
    const notesDir = tmpDir("engram-refs-notes-");
    const md = writeMd(notesDir, "note.md", "See `src/a.ts` for details.\n");

    const result = await checkRefs(conn, [md], { roots: [repo], cwd: repo });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: "moved", location: "src/c.ts" });
  });
});
