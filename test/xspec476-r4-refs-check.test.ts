// implements XSPEC-476
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { isExternalExpression } from "../src/cli/refs-check.js";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * XSPEC-476 R4 — `egr refs check` and the things that are not references.
 *
 * The consumer report: `Sum(SendCnt)` and `min(...)` in a document came back
 * `missing`, each with the hash of a commit that had nothing to do with them,
 * and the run exited 0 although it had found "missing" references.
 *
 * What is under test, all through the built CLI against a real repository:
 *   - a call-shaped token that is an expression (whitespace, an operator, or an
 *     argument list) is `unresolvable` and no history is searched for it;
 *   - a `missing` symbol still names a commit, and that commit really contains
 *     the symbol's text;
 *   - the exit status is 1 when anything is `missing`, 0 when nothing is.
 */

let built: BuiltEgr;
let work: string;
let repo: string;
let db: string;

/** The environment for fixture git commands: this process's, minus every variable git exports to a hook. */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const names = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8", env: process.env }).split("\n");
  for (const name of names) if (name.trim()) delete env[name.trim()];
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: cleanGitEnv(),
  });
}

function put(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function egr(args: string[], cwd = work): { status: number | null; stdout: string; stderr: string } {
  return runEgr(built.cli, args, { env: { ...process.env, ENGRAM_DB: db }, cwd });
}

type Item = { raw: string; status: string; reason?: string; location?: string };
function refsCheck(note: string): { status: number | null; stdout: string; stderr: string; items: Item[] } {
  const r = egr(["refs", "check", note, "--json"]);
  // No `r.stdout ? … : []` here: empty output is a failure to explain, not "no items".
  return { ...r, items: (JSON.parse(r.stdout) as { items: Item[] }).items };
}
const byRaw = (items: Item[]): Record<string, Item> => Object.fromEntries(items.map((i) => [i.raw, i]));

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-476-r4-"));
  repo = join(work, "repo");
  db = join(work, "r4.db");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  // History: a function that later vanishes, and a LINQ-style line whose shape
  // (`Sum(...) {`) looks like a definition of `Sum` to a loose pattern.
  put(repo, "src/legacy.ts", "export function vanishedFn() { return 1; }\n");
  put(repo, "src/report.ts", "const total = rows.Sum(x => x.SendCnt) {\n}\n");
  put(repo, "src/lib.ts", "export function realFn() { return 2; }\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "add legacy, report and lib");
  git(repo, "rm", "-q", "src/legacy.ts", "src/report.ts");
  git(repo, "commit", "-q", "-m", "drop legacy and report");

  const r = egr(["index", repo]);
  if (r.status !== 0) throw new Error(`fixture index failed: ${r.stderr}`);

  put(
    work,
    "expressions.md",
    [
      "- aggregate: `Sum(SendCnt)`",
      "- formula: `Count(a) + Count(b)`",
      "- arguments: `min(x, y)`",
      "- blank inside: `reset( )`",
      "- a symbol of this repo: `realFn()`",
      "- a symbol that was deleted: `vanishedFn()`",
      "",
    ].join("\n"),
  );
  put(work, "only-fine.md", ["- aggregate: `Sum(SendCnt)`", "- a symbol of this repo: `realFn()`", ""].join("\n"));
}, 180_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

describe("XSPEC-476 R4: what counts as an external expression", () => {
  it("whitespace, an operator, or anything between the parentheses makes a call-shaped token an expression; name() and a.b() are symbols", () => {
    for (const tok of ["Sum(SendCnt)", "min(x, y)", "Count(a) + Count(b)", "reset( )", "f(a)", "a.b(c)", "x(1)", "g(a&&b)"]) {
      expect(isExternalExpression(tok), tok).toBe(true);
    }
    for (const tok of ["doThing()", "useAuth.restore()", "Cache.get()", "$init()"]) {
      expect(isExternalExpression(tok), tok).toBe(false);
    }
  });
});

describe("XSPEC-476 R4: egr refs check", () => {
  it("an expression is unresolvable with no commit attached, while a deleted symbol is still missing with a commit that contains its text [xspec476-r4-expression]", () => {
    const r = refsCheck(join(work, "expressions.md"));
    const items = byRaw(r.items);

    for (const raw of ["Sum(SendCnt)", "Count(a) + Count(b)", "min(x, y)", "reset( )"]) {
      expect(items[raw], raw).toBeDefined();
      expect(items[raw]!.status, raw).toBe("unresolvable");
      expect(items[raw]!.reason, raw).not.toMatch(/commit|[0-9a-f]{7}/);
    }

    expect(items["realFn()"]!.status).toBe("present");

    // The symbol that was really defined and deleted is still a finding, with its evidence.
    const gone = items["vanishedFn()"]!;
    expect(gone.status).toBe("missing");
    const hash = /commit ([0-9a-f]{7,})/.exec(gone.reason ?? "")?.[1];
    expect(hash, gone.reason).toBeDefined();
    // Read the commit back: it contains the text the reference is about.
    expect(git(repo, "show", hash!)).toContain("vanishedFn");
  });

  it("exits 1 when any reference is missing, and still prints the whole report [xspec476-r4-exit-missing]", () => {
    const r = egr(["refs", "check", join(work, "expressions.md")]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stdout).toContain("[missing] symbol `vanishedFn()`");
    expect(r.stdout).toContain("[unresolvable] symbol `Sum(SendCnt)`");
    expect(r.stderr).toMatch(/1 reference\(s\) are missing/);
  });

  it("exits 0 when nothing is missing, unresolvable references included [xspec476-r4-exit-clean]", () => {
    const r = egr(["refs", "check", join(work, "only-fine.md")]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("[unresolvable] symbol `Sum(SendCnt)`");
    expect(r.stdout).toContain("[present] symbol `realFn()`");
  });

  it("--help says refs check exits 1 on a missing reference", () => {
    const help = egr(["--help"]).stdout.replace(/\s+/g, " ");
    expect(help).toContain('"refs check" also exits 1 when any reference is "missing"');
  });
});
