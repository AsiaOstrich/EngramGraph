import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { walkFiles } from "../src/cli/walk.js";

/**
 * Directory symlinks are skipped, and now say so (XSPEC-373 B3).
 *
 * `Dirent.isDirectory()` is false for a symlink even when it points at a
 * directory, so such a tree was neither walked nor recorded. The files were
 * not merely absent from the graph — they were absent from the DENOMINATOR,
 * so `egr blindspots` went on to report "all 1 indexed files parsed cleanly".
 */
describe("walkFiles and directory symlinks (XSPEC-373 B3)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-walk-symlink-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTree(root: string) {
    mkdirSync(join(root, "plain"), { recursive: true });
    writeFileSync(join(root, "plain", "p.ts"), "export function p(){return 0}\n");
  }

  it("records a skipped directory symlink instead of dropping it silently", () => {
    const real = join(dir, "real");
    mkdirSync(join(real, "inner"), { recursive: true });
    writeFileSync(join(real, "inner", "alpha.ts"), "export function alpha(){return 1}\n");

    const project = join(dir, "project");
    writeTree(project);
    symlinkSync(join(real, "inner"), join(project, "inner"));

    const { files, skippedSymlinkDirs, unreadable } = walkFiles(project, [".ts"]);

    expect(files.map((f) => f.path)).toEqual(["plain/p.ts"]);
    expect(skippedSymlinkDirs).toEqual(["inner"]);
    expect(unreadable).toEqual([]);
  });

  it("control: the same tree with a real directory is walked and reports no skips", () => {
    const project = join(dir, "project");
    writeTree(project);
    mkdirSync(join(project, "inner"), { recursive: true });
    writeFileSync(join(project, "inner", "alpha.ts"), "export function alpha(){return 1}\n");

    const { files, skippedSymlinkDirs } = walkFiles(project, [".ts"]);

    expect(files.map((f) => f.path).sort()).toEqual(["inner/alpha.ts", "plain/p.ts"]);
    expect(skippedSymlinkDirs).toEqual([]);
  });

  it("still follows symlinked FILES — only directories are skipped", () => {
    const project = join(dir, "project");
    writeTree(project);
    const target = join(dir, "elsewhere.ts");
    writeFileSync(target, "export function linked(){return 2}\n");
    symlinkSync(target, join(project, "linked.ts"));

    const { files, skippedSymlinkDirs } = walkFiles(project, [".ts"]);

    expect(files.map((f) => f.path).sort()).toEqual(["linked.ts", "plain/p.ts"]);
    expect(files.find((f) => f.path === "linked.ts")?.source).toContain("linked");
    expect(skippedSymlinkDirs).toEqual([]);
  });

  it("records an unreadable file instead of aborting the whole walk", () => {
    // Discovery runs before extractProject's per-file resilience, so one
    // permission-denied file used to take the entire index with it (B7).
    const project = join(dir, "project");
    writeTree(project);
    const locked = join(project, "locked.ts");
    writeFileSync(locked, "export function locked(){return 3}\n");
    chmodSync(locked, 0o000);

    try {
      const { files, unreadable } = walkFiles(project, [".ts"]);
      // Running as root defeats chmod; skip rather than assert a false pass.
      if (unreadable.length === 0) return;
      expect(files.map((f) => f.path)).toEqual(["plain/p.ts"]);
      expect(unreadable).toHaveLength(1);
      expect(unreadable[0]?.path).toBe("locked.ts");
      expect(unreadable[0]?.reason).toMatch(/EACCES|permission/i);
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  it("a broken symlink is neither a skipped directory nor a crash", () => {
    const project = join(dir, "project");
    writeTree(project);
    symlinkSync(join(dir, "does-not-exist"), join(project, "dangling"));

    const { files, skippedSymlinkDirs } = walkFiles(project, [".ts"]);

    expect(files.map((f) => f.path)).toEqual(["plain/p.ts"]);
    expect(skippedSymlinkDirs).toEqual([]);
  });
});
