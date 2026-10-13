// SPDX-License-Identifier: MIT
// implements XSPEC-481
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";
import { isHistoryNoise } from "../src/cli/refs-check.js";
import { builtinLanguagesFor } from "../src/cli/builtin-functions.js";

/**
 * XSPEC-481 R1 — `egr refs check` must not call a reference `missing` on evidence that is not evidence.
 *
 * The 0.13.0-beta.4 Windows report: a document cited PHP's `date()`; `refs check` said `missing` and attached a commit
 * whose only link to `date` was `date:function(t){…}` inside a front-end bundle. Since beta.4 `missing` makes the
 * exit status 1, so a CI step failed on a function of the PHP language.
 *
 * Three independent causes, so three kinds of reference, each of which only ONE rule can save (a test that used `date()`
 * alone would stay green with either rule cut, because `date` is also a built-in name):
 *
 *   - `validateWidget()` — not a built-in; defined only in `dist/app.js`        -> the skip-directory rule
 *   - `minOnlyFn()`      — not a built-in; defined only in `web/lib.min.js`      -> the `*.min.*` rule
 *   - `oldOnly()`        — not a built-in; defined only under `old/`, which `egr index --exclude old/` left out
 *                                                                                -> the recorded `--exclude`
 *   - `trim()`           — a built-in name; really defined (and deleted) in `src/legacy.php` -> the built-in list
 *   - `date()`           — the report's own case: both of the first and the last
 *
 * and the two answers that must NOT change: `goneFn()` (really deleted from `src/gone.ts`) is still `missing`, and says
 * where; `count()` (a built-in name this project defines itself) is still found by the graph.
 *
 * Every test drives the built CLI as a child process against a real git repository and reads the report back.
 */

let built: BuiltEgr;
let work: string;

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-481-r1-"));
}, 120_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

/** This process's environment minus every variable git exports to a hook (see feedback_hook_git_env_leaks_into_temp_repos). */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8", env: process.env }).split("\n")) {
    if (name.trim()) delete env[name.trim()];
  }
  return env;
}

function gitIn(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test.com", ...args], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: cleanGitEnv(),
  });
}

function put(repo: string, rel: string, content: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), content);
}

interface Item {
  raw: string;
  status: string;
  reason?: string;
}

function refsCheck(db: string, note: string): { status: number | null; items: Item[] } {
  const r = runEgr(built.cli, ["refs", "check", note, "--json"], { env: { ...process.env, ENGRAM_DB: db }, cwd: work });
  return { status: r.status, items: (JSON.parse(r.stdout) as { items: Item[] }).items };
}

function byRaw(items: Item[]): Record<string, Item> {
  return Object.fromEntries(items.map((i) => [i.raw, i]));
}

describe("XSPEC-481 R1: refs check and evidence that is not evidence", () => {
  let repo: string;
  let db: string;
  let noiseNote: string;
  let realNote: string;

  beforeAll(() => {
    repo = join(work, "repo");
    db = join(work, "r1.db");
    mkdirSync(repo, { recursive: true });
    gitIn(repo, "init", "-q");

    put(repo, "src/lib.ts", "export function realFn() { return 0; }\n");
    // The project's own function that has a built-in's name: the graph must answer for it.
    put(repo, "src/util.ts", "export function count() { return 1; }\n");
    // A front-end bundle: a validation library with a method named like PHP's date(), and one named for nothing built-in.
    put(repo, "dist/app.js", "var v = { date: function (t) { return t; }, validateWidget: function (t) { return t; } };\n");
    put(repo, "web/lib.min.js", "var m = { minOnlyFn: function (t) { return t; } };\n");
    put(repo, "old/legacy.js", "function oldOnly() { return 1; }\n");
    put(repo, "src/legacy.php", "<?php\nfunction trim($s) { return $s; }\n");
    put(repo, "src/gone.ts", "export function goneFn() { return 1; }\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-q", "-m", "everything");
    // The deletions: all of these are history only.
    gitIn(repo, "rm", "-q", "dist/app.js", "web/lib.min.js", "old/legacy.js", "src/legacy.php", "src/gone.ts");
    gitIn(repo, "commit", "-q", "-m", "drop them");

    const idx = runEgr(built.cli, ["index", repo, "--exclude", "old/"], { env: { ...process.env, ENGRAM_DB: db }, cwd: work });
    if (idx.status !== 0) throw new Error(`fixture index failed: ${idx.stderr}`);

    noiseNote = join(work, "noise.md");
    writeFileSync(
      noiseNote,
      [
        "PHP uses `date()` and `trim()`.",
        "Widget: `validateWidget()`, minified: `minOnlyFn()`, legacy: `oldOnly()`.",
        "Ours: `count()` and `realFn()`.",
        "",
      ].join("\n"),
    );
    realNote = join(work, "real.md");
    writeFileSync(realNote, ["Dropped: `goneFn()`.", "Still here: `realFn()`.", "Bundle only: `validateWidget()`.", ""].join("\n"));
  }, 180_000);

  it("a name defined only in a bundle, a minified file or an excluded directory is not missing, and the exit status does not become 1 [xspec481-r1-noise-not-missing]", () => {
    const { status, items } = refsCheck(db, noiseNote);
    const r = byRaw(items);

    // The report's case: PHP's date(), whose only "definition" in history is dist/app.js.
    expect(r["date()"]!.status, r["date()"]!.reason).toBe("unresolvable");
    // One rule each — none of these three is a built-in name, so only the path rules can keep them out of `missing`.
    expect(r["validateWidget()"]!.status, r["validateWidget()"]!.reason).toBe("unresolvable");
    expect(r["minOnlyFn()"]!.status, r["minOnlyFn()"]!.reason).toBe("unresolvable");
    expect(r["oldOnly()"]!.status, r["oldOnly()"]!.reason).toBe("unresolvable");
    // A built-in name that really was defined and deleted in src/legacy.php: only the built-in list keeps it out.
    expect(r["trim()"]!.status, r["trim()"]!.reason).toBe("unresolvable");
    expect(r["trim()"]!.reason).toMatch(/built-in function of PHP/);
    // Nothing in this document is missing, so a CI step running `refs check` passes.
    expect(items.filter((i) => i.status === "missing")).toEqual([]);
    expect(status).toBe(0);
  });

  it("a built-in name the project defines itself is answered by the graph, not by the built-in list [xspec481-r1-graph-first]", () => {
    const { items } = refsCheck(db, noiseNote);
    const r = byRaw(items);
    expect(r["count()"]!.status).toBe("present");
    expect(r["count()"]!.reason).toBeUndefined();
    expect(r["realFn()"]!.status).toBe("present");
  });

  it("a symbol really deleted from the repository is still missing, the exit status is 1, and the message names the file and the commit [xspec481-r1-real-deletion-still-missing]", () => {
    const { status, items } = refsCheck(db, realNote);
    const r = byRaw(items);
    expect(status).toBe(1);

    const gone = r["goneFn()"]!;
    expect(gone.status, gone.reason).toBe("missing");
    expect(gone.reason).toContain("src/gone.ts"); // where it was defined
    const hash = /commit ([0-9a-f]{7,})/.exec(gone.reason ?? "")?.[1];
    expect(hash, gone.reason).toBeDefined();
    // Read back: that commit is the one that deleted it, and it touched the file the message names.
    expect(gitIn(repo, "show", "-s", "--format=%s", hash!).trim()).toBe("drop them");
    expect(gitIn(repo, "show", "--stat", "--format=", hash!)).toContain("src/gone.ts");

    // In the same document the bundle-only name is still not a finding.
    expect(r["validateWidget()"]!.status).toBe("unresolvable");
    expect(r["realFn()"]!.status).toBe("present");
  });

  it("from an index root below the repository top, the file is named and excluded relative to that root [xspec481-r1-subdirectory-root]", () => {
    const repo2 = join(work, "repo2");
    const db2 = join(work, "r1-sub.db");
    mkdirSync(repo2, { recursive: true });
    gitIn(repo2, "init", "-q");
    put(repo2, "pkg/keep.ts", "export function keepFn() { return 0; }\n");
    put(repo2, "pkg/src/x.ts", "export function subGone() { return 1; }\n");
    put(repo2, "pkg/gen/g.ts", "export function genOnly() { return 1; }\n");
    put(repo2, "other/z.ts", "export function outsideRoot() { return 1; }\n");
    gitIn(repo2, "add", "-A");
    gitIn(repo2, "commit", "-q", "-m", "all");
    gitIn(repo2, "rm", "-q", "pkg/src/x.ts", "pkg/gen/g.ts", "other/z.ts");
    gitIn(repo2, "commit", "-q", "-m", "drop");
    const idx = runEgr(built.cli, ["index", join(repo2, "pkg"), "--exclude", "gen/"], { env: { ...process.env, ENGRAM_DB: db2 }, cwd: work });
    expect(idx.status, idx.stderr).toBe(0);

    const note = join(work, "sub.md");
    writeFileSync(note, "`subGone()`, `genOnly()`.\n");
    const { items } = refsCheck(db2, note);
    const r = byRaw(items);
    expect(r["subGone()"]!.status, r["subGone()"]!.reason).toBe("missing");
    expect(r["subGone()"]!.reason).toMatch(/defined in src\/x\.ts\)/); // relative to the index root, not "pkg/src/x.ts"
    expect(r["genOnly()"]!.status, r["genOnly()"]!.reason).toBe("unresolvable"); // `gen/` was excluded from this root's index
  });
});

describe("XSPEC-481 R1: the lists", () => {
  it("the built-in names are kept in one module and cover PHP, JavaScript, C# and Python [xspec481-r1-builtin-list]", () => {
    expect(builtinLanguagesFor("date")).toEqual(["PHP"]);
    expect(builtinLanguagesFor("parseInt")).toEqual(["JavaScript"]);
    expect(builtinLanguagesFor("ToString")).toEqual(["C#"]);
    expect(builtinLanguagesFor("isinstance")).toEqual(["Python"]);
    expect(builtinLanguagesFor("someProjectFunction")).toEqual([]);
  });

  it("history paths under the skip list, minified files and user-excluded paths are noise; source paths are not [xspec481-r1-noise-paths]", () => {
    for (const p of ["dist/app.js", "pkg/build/out.js", "vendor/lib/x.php", "node_modules/a/b.js", "web/a.min.js", "web/jquery.min.map.js"]) {
      expect(isHistoryNoise(p), p).toBe(true);
    }
    for (const p of ["src/app.js", "src/distance.ts", "build.ts", "web/admin.js", "src/minimal.js"]) {
      expect(isHistoryNoise(p), p).toBe(false);
    }
  });
});
