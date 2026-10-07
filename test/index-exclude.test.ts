// implements XSPEC-457
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileExcludes } from "../src/cli/exclude.js";
import { buildEgr, REPO_ROOT, type BuiltEgr } from "./helpers/build-cli.js";

/**
 * XSPEC-457 R5 — `egr index --exclude <glob>`.
 *
 * The reported case: a project root holding `.uds-backup-*` directories (UDS
 * backups, about a hundred Markdown files) whose contents were counted into the
 * document total by `--docs`, with no way to say otherwise — the fixed skip list
 * names `.git` and `.engram` and no other dot-directory, and `.gitignore` is not
 * read. Run through the built CLI, read back from the graph.
 */

let built: BuiltEgr;
let work: string;

function makeProject(name: string): string {
  const root = join(work, name);
  mkdirSync(join(root, "docs", "archive"), { recursive: true });
  mkdirSync(join(root, ".uds-backup-20261001"), { recursive: true });
  mkdirSync(join(root, "pkg", ".uds-backup-nested"), { recursive: true });
  writeFileSync(join(root, "app.ts"), "export function appMain() { return 1; }\n");
  writeFileSync(join(root, "docs", "real.md"), "---\nid: SPEC-REAL\n---\n# SPEC-REAL\nreal\n");
  writeFileSync(join(root, "docs", "archive", "old.md"), "---\nid: SPEC-ARCHIVED\n---\n# SPEC-ARCHIVED\nold\n");
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(root, ".uds-backup-20261001", `b${i}.md`), `---\nid: SPEC-BACKUP-${i}\n---\n# SPEC-BACKUP-${i}\nbackup copy\n`);
  }
  writeFileSync(join(root, ".uds-backup-20261001", "backup.ts"), "export function backupOnly() { return 2; }\n");
  writeFileSync(join(root, "pkg", ".uds-backup-nested", "n.md"), "---\nid: SPEC-NESTED-BACKUP\n---\n# SPEC-NESTED-BACKUP\nnested\n");
  return root;
}

function egr(args: string[], db: string, cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [built.cli, ...args], { encoding: "utf8", env: { ...process.env, ENGRAM_DB: db }, cwd });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-exclude-"));
}, 120_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

describe("XSPEC-457 R5: egr index --exclude", () => {
  it("--exclude \".uds-backup-*\" keeps the backup documents out of the document count and the graph, and the summary says how many it excluded", () => {
    const root = makeProject("p1");
    const db = join(work, "p1.db");

    // Without it: every backup document is in the count and in the graph.
    const before = egr(["index", ".", "--docs"], join(work, "p1-before.db"), root);
    expect(before.status, before.stderr).toBe(0);
    expect(before.stdout).toMatch(/\(7 doc\(s\) scanned/); // real, archived, 4 backups, 1 nested backup

    const r = egr(["index", ".", "--docs", "--exclude", ".uds-backup-*"], db, root);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\(2 doc\(s\) scanned/); // real + archived only
    // 4 md + 1 ts under the root backup, 1 md under the nested one.
    expect(r.stdout).toMatch(/excluded: 6 file\(s\) in 2 path\(s\) matched --exclude ".uds-backup-\*"/);
    expect(r.stdout).toContain(".uds-backup-20261001/");
    expect(r.stdout).toContain("pkg/.uds-backup-nested/");

    // Read back from the graph: the backups' specs and function are not there; the real ones are.
    expect(egr(["implementers", "SPEC-BACKUP-0"], db, root).status).toBe(1);
    expect(egr(["implementers", "SPEC-NESTED-BACKUP"], db, root).status).toBe(1);
    expect(egr(["callers", "backupOnly"], db, root).status).toBe(1);
    expect(egr(["implementers", "SPEC-REAL"], db, root).status).toBe(0);
    expect(egr(["callers", "appMain"], db, root).status).toBe(0);
    // ...and without the flag they were all there.
    expect(egr(["implementers", "SPEC-BACKUP-0"], join(work, "p1-before.db"), root).status).toBe(0);
  });

  it("--exclude can be repeated, and an anchored pattern matches only from the root", () => {
    const root = makeProject("p2");
    const db = join(work, "p2.db");
    const r = egr(["index", ".", "--docs", "--exclude", ".uds-backup-*", "--exclude", "docs/archive/**"], db, root);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\(1 doc\(s\) scanned/); // only docs/real.md
    expect(r.stdout).toMatch(/--exclude ".uds-backup-\*" "docs\/archive\/\*\*"/);
    expect(egr(["implementers", "SPEC-ARCHIVED"], db, root).status).toBe(1);
    expect(egr(["implementers", "SPEC-REAL"], db, root).status).toBe(0);
  });

  it("a pattern that matches nothing says so instead of staying silent", () => {
    const root = makeProject("p3");
    const r = egr(["index", ".", "--docs", "--exclude", "no-such-dir-*"], join(work, "p3.db"), root);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/excluded: 0 file\(s\) in 0 path\(s\) matched --exclude "no-such-dir-\*" — nothing matched; check the pattern/);
  });

  it("without --exclude there is no excluded line", () => {
    const root = makeProject("p4");
    const r = egr(["index", ".", "--docs"], join(work, "p4.db"), root);
    expect(r.stdout).not.toMatch(/excluded:/);
  });

  it("--json carries the patterns, the excluded paths and the file count", () => {
    const root = makeProject("p5");
    const r = egr(["index", ".", "--docs", "--exclude", ".uds-backup-*", "--json"], join(work, "p5.db"), root);
    expect(r.status, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout) as { excluded: { patterns: string[]; paths: string[]; files: number } };
    expect(j.excluded.patterns).toEqual([".uds-backup-*"]);
    expect(j.excluded.paths.sort()).toEqual([".uds-backup-20261001/", "pkg/.uds-backup-nested/"]);
    expect(j.excluded.files).toBe(6);
  });

  it("an empty pattern is an error, not a pattern that matches everything or nothing", () => {
    const root = makeProject("p6");
    const r = egr(["index", ".", "--exclude", ""], join(work, "p6.db"), root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--exclude needs a non-empty glob/);
  });

  it("--help documents --exclude, and so does the README", () => {
    const help = egr(["--help"], join(work, "x.db"), work);
    expect(help.stdout).toContain("--exclude <glob>");
    expect(help.stdout).toMatch(/Excluding paths/);
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    expect(readme).toContain("--exclude");
  });
});

describe("XSPEC-457 R5: the glob language", () => {
  const m = (patterns: string[], rel: string, isDir = false) => compileExcludes(patterns).matches(rel, rel.split("/").pop()!, isDir);

  it("a pattern without a slash matches the entry name at any depth", () => {
    expect(m([".uds-backup-*"], ".uds-backup-1", true)).toBe(true);
    expect(m([".uds-backup-*"], "pkg/sub/.uds-backup-9", true)).toBe(true);
    expect(m([".uds-backup-*"], "uds-backup-1", true)).toBe(false);
    expect(m(["*.min.js"], "static/app.min.js")).toBe(true);
  });

  it("a pattern with a slash is anchored at the root; ** crosses directories, * does not", () => {
    expect(m(["docs/archive/**"], "docs/archive/old.md")).toBe(true);
    expect(m(["docs/archive/**"], "x/docs/archive/old.md")).toBe(false);
    expect(m(["docs/*.md"], "docs/a.md")).toBe(true);
    expect(m(["docs/*.md"], "docs/sub/a.md")).toBe(false);
    expect(m(["**/generated"], "generated", true)).toBe(true);
    expect(m(["**/generated"], "a/b/generated", true)).toBe(true);
  });

  it("a trailing slash restricts a pattern to directories", () => {
    expect(m(["build-*/"], "build-1", true)).toBe(true);
    expect(m(["build-*/"], "build-1", false)).toBe(false);
  });

  it("supports {a,b}, ? and [abc], and escapes regex characters in the rest", () => {
    expect(m(["*.{cs,vb}"], "x/Program.cs")).toBe(true);
    expect(m(["*.{cs,vb}"], "x/Program.js")).toBe(false);
    expect(m(["file?.md"], "file1.md")).toBe(true);
    expect(m(["file?.md"], "file10.md")).toBe(false);
    expect(m(["v[12].md"], "v2.md")).toBe(true);
    expect(m(["a+b.md"], "a+b.md")).toBe(true);
    expect(m(["a+b.md"], "aab.md")).toBe(false);
  });

  it("rejects an empty or unbalanced pattern", () => {
    expect(() => compileExcludes([""])).toThrow(/non-empty/);
    expect(() => compileExcludes(["{a,b"])).toThrow(/unclosed/);
  });
});
