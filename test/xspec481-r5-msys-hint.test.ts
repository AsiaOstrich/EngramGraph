// SPDX-License-Identifier: MIT
// implements XSPEC-481
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";
import { msysPathConversionHint } from "../src/cli/index-hints.js";

/**
 * XSPEC-481 R5 — Git Bash rewrites `--exclude "/logs/"` into `C:/Program Files/Git/logs/`.
 *
 * The beta.4 help's own example was the victim: on Windows 11 under Git Bash the pattern reached `egr` rewritten,
 * matched nothing, and the summary said only "nothing matched; check the pattern".
 *
 * **What is and is not verified here.** This runs on macOS, where MSYS does not exist, so nothing below runs
 * Git Bash. What is verified is egr's half, with the rewritten pattern passed literally as Git Bash would pass it:
 * it matches nothing, and the "nothing matched" line now says why and what to do. That `MSYS_NO_PATHCONV=1` turns
 * the conversion off is the consumer's report and Git for Windows' documented behaviour; that a leading `//`
 * reaches the program as a single `/` is likewise MSYS documentation — neither was run on Windows by this work. What
 * IS verified of that advice is the egr side of it: `//logs/` and `/logs/` exclude the same directory.
 */

let built: BuiltEgr;
let work: string;
let proj: string;
let seq = 0;

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-481-r5-"));
  proj = join(work, "proj");
  mkdirSync(join(proj, "logs"), { recursive: true });
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "logs", "a.ts"), "export function inLogs() { return 1; }\n");
  writeFileSync(join(proj, "src", "b.ts"), "export function inSrc() { return 2; }\n");
}, 120_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

const index = (extra: string[]) =>
  runEgr(built.cli, ["index", proj, "--clean", ...extra], { env: { ...process.env, ENGRAM_DB: join(work, `r5-${seq++}.db`) }, cwd: work });

interface ByPattern {
  pattern: string;
  nothingMatched: boolean;
  files: number;
  hint?: string;
}
const indexJson = (extra: string[]): { code: { files: number }; excluded: { files: number; byPattern: ByPattern[] } } => {
  const r = index([...extra, "--json"]);
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
};

describe("XSPEC-481 R5: a pattern that Git Bash rewrote", () => {
  it("a pattern that starts with a Git install path and matched nothing gets the reason and the way out on the nothing-matched line [xspec481-r5-hint-on-rewritten-pattern]", () => {
    for (const rewritten of ["C:/Program Files/Git/logs/", "C:/Program Files (x86)/Git/logs/", "D:/Tools/Git/logs/"]) {
      const r = index(["--exclude", rewritten]);
      expect(r.status, r.stderr).toBe(0);
      const line = r.stdout.split("\n").find((l) => l.startsWith("excluded:"))!;
      expect(line, rewritten).toContain("nothing matched; check the pattern");
      expect(line).toContain("Git Bash");
      expect(line).toContain("MSYS_NO_PATHCONV=1");
      expect(line).toContain("//logs/");
      // Read back: the rewritten pattern excluded nothing, so the directory it was meant for is still indexed.
      expect(r.stdout).toMatch(/code: 2 files/);
    }
    const j = indexJson(["--exclude", "C:/Program Files/Git/logs/"]);
    expect(j.excluded.byPattern[0]!.nothingMatched).toBe(true);
    expect(j.excluded.byPattern[0]!.hint).toContain("MSYS_NO_PATHCONV=1");
    expect(j.code.files).toBe(2);
  });

  it("with several patterns, only the rewritten one carries the hint, on its own line [xspec481-r5-hint-per-pattern]", () => {
    const r = index(["--exclude", "C:/Program Files/Git/logs/", "--exclude", "zzz-nomatch-*", "--exclude", "src/"]);
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.startsWith("excluded:"));
    const rewritten = lines.find((l) => l.includes('"C:/Program Files/Git/logs/" —'))!;
    const typo = lines.find((l) => l.includes('"zzz-nomatch-*" —'))!;
    const real = lines.find((l) => l.includes('"src/" —'))!;
    expect(rewritten).toContain("MSYS_NO_PATHCONV=1");
    expect(typo).toContain("nothing matched");
    expect(typo).not.toContain("MSYS_NO_PATHCONV");
    expect(real).not.toContain("nothing matched");
    expect(real).not.toContain("MSYS_NO_PATHCONV");
  });

  it("an ordinary typo gets no Git Bash hint, and neither does a pattern that matched [xspec481-r5-no-false-hint]", () => {
    const typo = index(["--exclude", "zzz-nomatch-*"]);
    expect(typo.stdout).toContain("nothing matched; check the pattern");
    expect(typo.stdout).not.toContain("MSYS");
    expect(indexJson(["--exclude", "zzz-nomatch-*"]).excluded.byPattern[0]!.hint).toBeUndefined();

    const hit = index(["--exclude", "logs/"]);
    expect(hit.stdout).not.toContain("nothing matched");
    expect(hit.stdout).not.toContain("MSYS");
    expect(hit.stdout).toMatch(/code: 1 files/);
  });

  it("the advice is true on egr's side: //logs/ and /logs/ exclude the same directory [xspec481-r5-double-slash-form]", () => {
    for (const form of ["/logs/", "//logs/"]) {
      const j = indexJson(["--exclude", form]);
      expect(j.excluded.files, form).toBe(1);
      expect(j.excluded.byPattern[0]!.nothingMatched, form).toBe(false);
      expect(j.code.files, form).toBe(1); // only src/b.ts is left
    }
  });

  it("the help says what Git Bash does and what to do about it [xspec481-r5-help]", () => {
    const r = runEgr(built.cli, ["--help"], { env: process.env, cwd: work });
    expect(r.stdout).toMatch(/Git Bash rewrites an argument that starts with "\/"/);
    expect(r.stdout).toContain("MSYS_NO_PATHCONV=1");
  });

  it("the detection is a plain string test: Git install paths in both slash styles, nothing else [xspec481-r5-detector]", () => {
    expect(msysPathConversionHint("C:/Program Files/Git/logs/")).toContain("MSYS_NO_PATHCONV=1");
    expect(msysPathConversionHint("C:\\Program Files\\Git\\logs\\")).toContain("MSYS_NO_PATHCONV=1");
    expect(msysPathConversionHint("c:/program files/git/logs/")).toContain("MSYS_NO_PATHCONV=1");
    for (const other of ["/logs/", "logs/", "C:/Users/me/logs/", "docs/Git/", "src/**", ".uds-backup-*", "C:/Gitlab/logs/"]) {
      expect(msysPathConversionHint(other), other).toBe("");
    }
  });
});
