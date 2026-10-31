// SPDX-License-Identifier: MIT
// implements XSPEC-514
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { coChange, formatCoChange, type CoChangeOk, type CoChangeUndetermined } from "../src/cochange/index.js";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * XSPEC-514 R2 — `egr cochange <file>` and the MCP tool `cochange`: which files changed together with this one.
 *
 * Everything that proves the feature goes through the built entry points as a user meets them (the `egr` CLI as a
 * child process, the `egr-mcp` stdio server through a real MCP client), against a repository this file builds with
 * real commits, and reads the ranking and the counts back. The in-process cases at the end call `coChange` itself;
 * they are there for what a child process cannot show (v8 coverage, a git that hangs), not as the proof.
 *
 * The repository is made in a throw-away HOME with an empty global git config and no system config, and without any
 * variable git exports to a hook (`git rev-parse --local-env-vars`): a hook running the suite must not write the
 * fixture's commits into the real repository, and the user's own git config must not decide what the fixture is.
 * The same environment goes to the `egr` child, because the product runs git too.
 *
 * History of the fixture (committer dates increase by a second per commit so "most recent" is not a tie), `core.ts`
 * being the file asked about:
 *   c1  core a b                     root commit
 *   c2  core a
 *   c3  core a b
 *   c4  core c
 *   c5  core                         touches nothing else
 *   f1  core m            (branch feature)        g  other (main)      g2  core (main)
 *   M   merge of feature that resolves the conflict in core.ts by hand: a merge commit that is NOT identical to either
 *       parent, so `git log -- core.ts` lists it unless merges are excluded
 *   c6  core a b + 32 files big/*, decoy   36 files, over the limit of 30
 *   c8  core, `git mv a.ts a2.ts`    a rename
 *   w1  -weird.py sub/partner.ts         w2  -weird.py sub/partner.ts star*file.ts       w3  starXfile.ts decoy-partner.ts
 */

const IS_WINDOWS = process.platform === "win32";

let built: BuiltEgr;
let work: string;
let home: string;
let repo: string;
let gitEnv: NodeJS.ProcessEnv;
let tick = 0;

function isolatedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const n of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8", env: process.env }).split("\n")) {
    if (n.trim()) delete env[n.trim()];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, "empty-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CEILING_DIRECTORIES: dirname(work),
  };
}

function git(cwd: string, ...args: string[]): string {
  const date = `2026-01-01T00:00:${String(tick).padStart(2, "0")}Z`;
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function put(rel: string, content: string, root = repo): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Write each file with content unique to this commit, then commit them all. */
function commit(files: string[], label: string, extra: () => void = () => undefined): void {
  tick++;
  for (const f of files) put(f, `${label}\n`);
  extra();
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", label);
}

function egr(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { status: number | null; stdout: string; stderr: string } {
  return runEgr(built.cli, args, { env: { ...gitEnv, ...(opts.env ?? {}), ENGRAM_DB: join(work, "never-created", "graph.db") }, cwd: opts.cwd ?? repo });
}

function egrJson<T>(args: string[], opts: { cwd?: string } = {}): { r: ReturnType<typeof egr>; json: T } {
  const r = egr([...args, "--json"], opts);
  // No `r.stdout ? … : {}`: empty output is a failure to explain, not an empty result.
  return { r, json: JSON.parse(r.stdout) as T };
}

const CORE_EXPECTED = [
  { file: "a.ts", count: 4 }, // c1 c2 c3 and c8 (a rename is a delete of a.ts here); c6 is skipped
  { file: "b.ts", count: 2 }, // c1 c3
  { file: "a2.ts", count: 1 }, // the rename's new name: not linked to a.ts
  { file: "c.ts", count: 1 },
  { file: "m.ts", count: 1 }, // the feature branch commit; the merge itself is not a commit that counts
];

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(realpathSync(tmpdir()), "egr-514-r2-"));
  home = join(work, "home");
  mkdirSync(home);
  writeFileSync(join(home, "empty-gitconfig"), "");
  gitEnv = isolatedEnv();
  repo = join(work, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");

  commit(["core.ts", "a.ts", "b.ts"], "c1");
  commit(["core.ts", "a.ts"], "c2");
  commit(["core.ts", "a.ts", "b.ts"], "c3");
  commit(["core.ts", "c.ts"], "c4");
  commit(["core.ts"], "c5");
  tick++;
  git(repo, "switch", "-q", "-c", "feature");
  commit(["core.ts", "m.ts"], "f1");
  git(repo, "switch", "-q", "main");
  commit(["other.ts"], "g");
  commit(["core.ts"], "g2");
  tick++;
  try {
    git(repo, "merge", "--no-ff", "-m", "M", "feature");
  } catch {
    // Both sides changed core.ts: resolve it by hand, which makes M differ from both of its parents.
  }
  put("core.ts", "merged\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "M");
  commit(
    ["core.ts", "a.ts", "b.ts", "decoy.ts", ...Array.from({ length: 32 }, (_, i) => `big/f${String(i).padStart(2, "0")}.ts`)],
    "c6",
  );
  tick++;
  put("core.ts", "c8\n");
  git(repo, "mv", "a.ts", "a2.ts");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "c8");

  commit(["-weird.py", "sub/partner.ts"], "w1");
  commit(IS_WINDOWS ? ["-weird.py", "sub/partner.ts"] : ["-weird.py", "sub/partner.ts", "star*file.ts"], "w2");
  commit(IS_WINDOWS ? ["decoy-partner.ts"] : ["starXfile.ts", "decoy-partner.ts"], "w3");
}, 120_000);

afterAll(() => {
  built?.cleanup();
  if (work) rmSync(work, { recursive: true, force: true });
});

describe("XSPEC-514 R2: egr cochange, through the built CLI", () => {
  it("lists the files that changed with the asked-for one, most often first, with how many commits were used and skipped [xspec514-r2-ranking]", () => {
    const { r, json } = egrJson<CoChangeOk>(["cochange", "core.ts"]);
    expect(r.status, r.stderr).toBe(0);
    expect(json.status).toBe("ok");
    expect(json.file).toBe("core.ts");
    // Exact ordered pairs, not "non-empty": count descending, ties by path.
    expect(json.cochanged).toEqual(CORE_EXPECTED);
    // The denominators: 9 non-merge commits touched core.ts (c1-c5, f1, g2, c6, c8); c6 changed 36 files and is skipped.
    expect(json.commitsExamined).toBe(9);
    expect(json.commitsUsed).toBe(8);
    expect(json.commitsSkippedLarge).toBe(1);
    expect(json.maxCommits).toBe(200);
    expect(json.maxFilesPerCommit).toBe(30);
    expect(json.totalFiles).toBe(5);
    // The asked-for file is not its own co-change; the skipped commit's files are not counted at all.
    expect(json.cochanged.map((c) => c.file)).not.toContain("core.ts");
    expect(json.cochanged.map((c) => c.file)).not.toContain("decoy.ts");
    expect(json.renamesFollowed).toBe(false);
    expect(json.mergesIncluded).toBe(false);
  });

  it("prints the same answer for a person, denominators first, and says what it does not follow [xspec514-r2-human]", () => {
    const r = egr(["cochange", "core.ts"]);
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toContain("cochange(core.ts): 8 commit(s) used of the last 9 non-merge commit(s)");
    expect(lines[0]).toContain("1 skipped for changing more than 30 files");
    expect(lines.slice(1, 6).map((l) => l.trim())).toEqual(["4  a.ts", "2  b.ts", "1  a2.ts", "1  c.ts", "1  m.ts"]);
    expect(r.stdout).toContain("renames are not followed");
    expect(r.stdout).toContain("merge commits are not counted");
  });

  it("skips a commit that changed more than --max-files files, and --max-files moves the line [xspec514-r2-skip-big-commit]", () => {
    // Default 30: the 36-file commit is out, so its files and its extra counts for a.ts and b.ts are out.
    const def = egrJson<CoChangeOk>(["cochange", "core.ts", "--limit", "100"]).json;
    expect(def.cochanged.some((c) => c.file === "decoy.ts" || c.file.startsWith("big/"))).toBe(false);
    expect(def.cochanged.find((c) => c.file === "a.ts")?.count).toBe(4);
    // 40: the same commit is now used: 32 + decoy become co-changed once, a.ts and b.ts gain one.
    const wide = egrJson<CoChangeOk>(["cochange", "core.ts", "--max-files", "40", "--limit", "100"]).json;
    expect(wide.commitsSkippedLarge).toBe(0);
    expect(wide.commitsUsed).toBe(9);
    expect(wide.cochanged.find((c) => c.file === "decoy.ts")?.count).toBe(1);
    expect(wide.cochanged.filter((c) => c.file.startsWith("big/"))).toHaveLength(32);
    expect(wide.cochanged.find((c) => c.file === "a.ts")?.count).toBe(5);
    // 2: only commits of at most two files remain (c2, c4, c5, f1, g2): the threshold is "more than", and 2-file commits stay.
    const narrow = egrJson<CoChangeOk>(["cochange", "core.ts", "--max-files", "2"]).json;
    expect(narrow.commitsUsed).toBe(5);
    expect(narrow.commitsSkippedLarge).toBe(4);
    expect(narrow.cochanged).toEqual([
      { file: "a.ts", count: 1 },
      { file: "c.ts", count: 1 },
      { file: "m.ts", count: 1 },
    ]);
  });

  it("--commits looks only at the most recent commits that touched the file [xspec514-r2-commits]", () => {
    // Newest first: c8 (the rename) then c6 (skipped as too big).
    const { r, json } = egrJson<CoChangeOk>(["cochange", "core.ts", "--commits", "2"]);
    expect(r.status, r.stderr).toBe(0);
    expect(json.commitsExamined).toBe(2);
    expect(json.commitsUsed).toBe(1);
    expect(json.commitsSkippedLarge).toBe(1);
    expect(json.maxCommits).toBe(2);
    expect(json.cochanged).toEqual([
      { file: "a.ts", count: 1 },
      { file: "a2.ts", count: 1 },
    ]);
  });

  it("--limit keeps the top of the ranking and still reports how many files there were [xspec514-r2-limit]", () => {
    const { json } = egrJson<CoChangeOk>(["cochange", "core.ts", "--limit", "2"]);
    expect(json.cochanged).toEqual(CORE_EXPECTED.slice(0, 2));
    expect(json.totalFiles).toBe(5);
    expect(json.limit).toBe(2);
    const human = egr(["cochange", "core.ts", "--limit", "2"]);
    expect(human.stdout).toContain("… 3 more file(s)");
  });

  it("refuses a limit, commit count or max-files that is not a positive integer, with exit 1 and no output [xspec514-r2-bad-numbers]", () => {
    for (const args of [["--limit", "0"], ["--limit", "abc"], ["--commits=-3"], ["--max-files", "1.5"], ["--limit", ""]]) {
      const r = egr(["cochange", "core.ts", ...args]);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stdout, args.join(" ")).toBe("");
      expect(r.stderr, args.join(" ")).toContain("must be a positive integer");
    }
    const noFile = egr(["cochange"]);
    expect(noFile.status).toBe(1);
    expect(noFile.stderr).toContain("cochange requires a <file>");
  });

  it("a merge commit is not counted and a rename is not followed [xspec514-r2-merge-and-rename]", () => {
    const { json } = egrJson<CoChangeOk>(["cochange", "core.ts", "--limit", "100"]);
    // The merge M (which `git log -- core.ts` lists, since it differs from both parents) is not among them: 9, not 10.
    expect(json.commitsExamined).toBe(9);
    // The rename shows as a delete of a.ts and an add of a2.ts. With rename detection on, a.ts would stay at 3 and
    // a2.ts would not exist; here the old name keeps 4 and the new name starts at 1.
    expect(json.cochanged.find((c) => c.file === "a.ts")?.count).toBe(4);
    expect(json.cochanged.find((c) => c.file === "a2.ts")?.count).toBe(1);
    // Asked about the NEW name: its history starts at the rename, nothing of a.ts's three earlier commits.
    const renamed = egrJson<CoChangeOk>(["cochange", "a2.ts"]).json;
    expect(renamed.commitsExamined).toBe(1);
    expect(renamed.cochanged.map((c) => c.file).sort()).toEqual(["a.ts", "core.ts"]);
  });

  it("outside a git work tree it says 無法判定 and exits 1 — never an empty list, in both output modes [xspec514-r2-not-a-repo]", () => {
    const bare = mkdtempSync(join(work, "not-a-repo-"));
    writeFileSync(join(bare, "x.ts"), "x\n");
    const human = egr(["cochange", "x.ts"], { cwd: bare });
    expect(human.status).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("無法判定");
    expect(human.stderr).toContain("not inside a git work tree");
    const { r, json } = egrJson<CoChangeUndetermined & { cochanged?: unknown }>(["cochange", "x.ts"], { cwd: bare });
    expect(r.status).toBe(1);
    expect(json.status).toBe("undetermined");
    expect(json.cochanged).toBeUndefined(); // there is no `[]` to mistake for "nothing changed with it"
    expect(json.reason).toContain("not inside a git work tree");
    // --repo pointing at a directory that is not a repository is the same answer.
    const viaRepo = egr(["cochange", "x.ts", "--repo", bare], { cwd: repo });
    expect(viaRepo.status).toBe(1);
    expect(viaRepo.stderr).toContain("無法判定");
  });

  it("a file with no history, an untracked file, and a repository with no commits are all 無法判定 [xspec514-r2-no-history]", () => {
    const missing = egr(["cochange", "no-such-file.ts"]);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("無法判定");
    expect(missing.stderr).toContain("no commit reachable from HEAD touches no-such-file.ts");

    put("untracked.ts", "never committed\n");
    const untracked = egr(["cochange", "untracked.ts"]);
    expect(untracked.status).toBe(1);
    expect(untracked.stderr).toContain("無法判定");
    rmSync(join(repo, "untracked.ts"));

    const fresh = mkdtempSync(join(work, "no-commits-"));
    git(fresh, "init", "-q");
    writeFileSync(join(fresh, "new.ts"), "new\n");
    const empty = egr(["cochange", "new.ts"], { cwd: fresh });
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("無法判定");

    const { json } = egrJson<CoChangeUndetermined>(["cochange", "no-such-file.ts"]);
    expect(json.status).toBe("undetermined");
  });

  it("a file whose every commit was skipped as too big is 無法判定, not an empty list, and --max-files makes it answerable [xspec514-r2-all-skipped]", () => {
    const r = egr(["cochange", "big/f00.ts"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("無法判定");
    expect(r.stderr).toContain("all 1 commit(s) that touched big/f00.ts were set aside");
    expect(r.stderr).toContain("1 changed more than 30 files");
    const wide = egrJson<CoChangeOk>(["cochange", "big/f00.ts", "--max-files", "40"]);
    expect(wide.r.status).toBe(0);
    expect(wide.json.commitsUsed).toBe(1);
    expect(wide.json.totalFiles).toBe(35); // the other 35 files of that one commit
  });

  it("a file that is the only thing a commit touched has usable history: ok with an empty list, saying so [xspec514-r2-alone]", () => {
    // other.ts changed once, alone (commit g). That is history with nothing co-changed: an answer, not 無法判定.
    const { r, json } = egrJson<CoChangeOk>(["cochange", "other.ts"]);
    expect(r.status, r.stderr).toBe(0);
    expect(json.status).toBe("ok");
    expect(json.commitsUsed).toBe(1);
    expect(json.cochanged).toEqual([]);
    const human = egr(["cochange", "other.ts"]);
    expect(human.stdout).toContain("(none — in the commits used, no other file changed with it)");
  });

  it("a file name that starts with a dash is a file, not an option: options go before `--`, the name after it [xspec514-r2-dash-name]", () => {
    const r = egr(["cochange", "--json", "--", "-weird.py"]);
    expect(r.status, r.stderr).toBe(0);
    const json = JSON.parse(r.stdout) as CoChangeOk;
    expect(json.file).toBe("-weird.py");
    expect(json.commitsUsed).toBe(2);
    expect(json.cochanged).toEqual(
      IS_WINDOWS
        ? [{ file: "sub/partner.ts", count: 2 }]
        : [
            { file: "sub/partner.ts", count: 2 },
            { file: "star*file.ts", count: 1 },
          ],
    );
    // Written as ./-weird.py it is the same file (and `-weird.py` without `--` is parseArgs' problem, not git's).
    const dotted = egr(["cochange", "./-weird.py", "--json"]);
    expect(dotted.status, dotted.stderr).toBe(0);
    expect((JSON.parse(dotted.stdout) as CoChangeOk).file).toBe("-weird.py");
  });

  it.skipIf(IS_WINDOWS)("a name with glob characters is that file, not a pattern: `star*file.ts` must not match starXfile.ts [xspec514-r2-glob-name]", () => {
    const { r, json } = egrJson<CoChangeOk>(["cochange", "star*file.ts"]);
    expect(r.status, r.stderr).toBe(0);
    expect(json.commitsExamined).toBe(1); // only w2; as a pattern it would also match starXfile.ts (w3)
    expect(json.cochanged).toEqual([
      { file: "-weird.py", count: 1 },
      { file: "sub/partner.ts", count: 1 },
    ]);
    expect(json.cochanged.map((c) => c.file)).not.toContain("decoy-partner.ts");
  });

  it("finds the repository from a subdirectory and from outside it, and reports repository-root paths [xspec514-r2-where]", () => {
    // From repo/sub: `partner.ts` is sub/partner.ts.
    const fromSub = egrJson<CoChangeOk>(["cochange", "partner.ts"], { cwd: join(repo, "sub") });
    expect(fromSub.r.status, fromSub.r.stderr).toBe(0);
    expect(fromSub.json.file).toBe("sub/partner.ts");
    expect(fromSub.json.cochanged.map((c) => c.file)).toEqual(IS_WINDOWS ? ["-weird.py"] : ["-weird.py", "star*file.ts"]);
    // From a directory that is not in the repository: --repo names it; an absolute file path works too.
    const elsewhere = mkdtempSync(join(work, "elsewhere-"));
    const viaRepo = egrJson<CoChangeOk>(["cochange", "sub/partner.ts", "--repo", repo], { cwd: elsewhere });
    expect(viaRepo.r.status, viaRepo.r.stderr).toBe(0);
    expect(viaRepo.json.file).toBe("sub/partner.ts");
    const absolute = egrJson<CoChangeOk>(["cochange", join(repo, "sub", "partner.ts")], { cwd: repo });
    expect(absolute.r.status, absolute.r.stderr).toBe(0);
    expect(absolute.json.file).toBe("sub/partner.ts");
    // A path outside the repository, and a directory, are not files of this history.
    const outside = egr(["cochange", "../elsewhere.ts"], { cwd: repo });
    expect(outside.status).toBe(1);
    expect(outside.stderr).toContain("outside the repository");
    const dir = egr(["cochange", "sub"]);
    expect(dir.status).toBe(1);
    expect(dir.stderr).toContain("is a directory");
  });

  it("a shallow clone says so, and its boundary commit — which git shows as adding every file — is not counted [xspec514-r2-shallow]", () => {
    const clone = join(work, "shallow-clone");
    // Depth 3 of the history: w3, w2, w1. w1 is the boundary, so git shows it as adding the whole tree (all ~45 files).
    git(work, "clone", "-q", "--depth", "3", "--no-local", `file://${repo}`, clone);
    const { r, json } = egrJson<CoChangeOk>(["cochange", "sub/partner.ts", "--max-files", "100"], { cwd: clone });
    expect(r.status, r.stderr).toBe(0);
    expect(json.shallow).toBe(true);
    expect(json.commitsExamined).toBe(2); // w2 and the boundary w1
    expect(json.commitsUsed).toBe(1);
    expect(json.commitsSkippedShallowBoundary).toBe(1);
    // Only w2's real change. With the boundary counted, core.ts, big/*.ts … would all appear with a count of 1.
    expect(json.cochanged.map((c) => c.file)).toEqual(IS_WINDOWS ? ["-weird.py"] : ["-weird.py", "star*file.ts"]);
    const human = egr(["cochange", "sub/partner.ts", "--max-files", "100"], { cwd: clone });
    expect(human.stdout).toContain("shallow clone");
    expect(human.stdout).toContain("1 skipped as the shallow clone's boundary");
    // A file whose only commit is the boundary has no real history in this clone: 無法判定.
    const onlyBoundary = egr(["cochange", "core.ts", "--max-files", "100"], { cwd: clone });
    expect(onlyBoundary.status).toBe(1);
    expect(onlyBoundary.stderr).toContain("無法判定");
    expect(onlyBoundary.stderr).toContain("shallow clone's boundary");
    // The full repository is not shallow.
    expect(egrJson<CoChangeOk>(["cochange", "core.ts"]).json.shallow).toBe(false);
  });

  it("ignores the git variables a hook exports, which would point git at another repository [xspec514-r2-hook-env]", () => {
    // `GIT_DIR` / `GIT_INDEX_FILE` are what git sets for a hook (a pre-commit running the suite, a post-commit re-index).
    // Left in the child's environment they send every git call to THAT repository, whatever directory was asked about.
    const other = join(work, "other-repo");
    mkdirSync(other);
    git(other, "init", "-q");
    writeFileSync(join(other, "x.ts"), "x\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "x");
    const r = egr(["cochange", "core.ts", "--json"], { env: { GIT_DIR: join(other, ".git"), GIT_INDEX_FILE: join(other, ".git", "index") } });
    expect(r.status, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as CoChangeOk).cochanged).toEqual(CORE_EXPECTED);
  });

  it("answers without a graph and does not create one [xspec514-r2-no-graph]", () => {
    // `egr` here points ENGRAM_DB into a directory that does not exist. Any command that opened the graph would create it.
    const r = egr(["cochange", "core.ts"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(work, "never-created"))).toBe(false);
    expect(existsSync(join(repo, ".engram"))).toBe(false);
  });

  it("appears in --help with the rule about the first-dash file name and the exit status [xspec514-r2-help]", () => {
    const r = egr(["--help"]);
    expect(r.stdout).toContain("cochange <file>");
    expect(r.stdout).toContain("無法判定");
    expect(r.stdout).toContain("egr cochange");
  });
});

describe("XSPEC-514 R2: the MCP tool cochange, through the built stdio server", () => {
  async function connect(): Promise<Client> {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [built.mcp],
        cwd: work, // NOT a repository: the tool must be told where, or fail saying so
        env: { ...gitEnv, ENGRAM_DB: join(work, "never-created", "graph.db") } as Record<string, string>,
        stderr: "ignore",
      }),
    );
    return client;
  }
  type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

  it("is offered by the read-only server, flagged read-only, and describes what it does not follow [xspec514-r2-mcp-listed]", async () => {
    const client = await connect();
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === "cochange");
      expect(tool, "cochange is not offered").toBeDefined();
      expect(tool!.annotations?.readOnlyHint).toBe(true);
      expect(tool!.annotations?.openWorldHint).toBe(false);
      expect(tool!.description).toContain("renames are NOT followed");
      expect(tool!.description).toContain("無法判定");
    } finally {
      await client.close();
    }
  });

  it("returns the same ranking and counts as the CLI [xspec514-r2-mcp-ranking]", async () => {
    const client = await connect();
    try {
      const res = (await client.callTool({ name: "cochange", arguments: { file: "core.ts", repo } })) as ToolResult;
      expect(res.isError, JSON.stringify(res)).not.toBe(true);
      const json = JSON.parse(res.content[0]!.text) as CoChangeOk;
      expect(json.cochanged).toEqual(CORE_EXPECTED);
      expect(json.commitsExamined).toBe(9);
      expect(json.commitsSkippedLarge).toBe(1);
      const narrow = (await client.callTool({
        name: "cochange",
        arguments: { file: "core.ts", repo, maxFilesPerCommit: 2, commits: 200, limit: 1 },
      })) as ToolResult;
      const n = JSON.parse(narrow.content[0]!.text) as CoChangeOk;
      expect(n.commitsUsed).toBe(5);
      expect(n.cochanged).toEqual([{ file: "a.ts", count: 1 }]);
      expect(n.totalFiles).toBe(3); // a.ts, c.ts, m.ts
    } finally {
      await client.close();
    }
  });

  it("not a git work tree, no history and a bad number are errors the caller cannot read as an empty list [xspec514-r2-mcp-undetermined]", async () => {
    const client = await connect();
    try {
      const notRepo = (await client.callTool({ name: "cochange", arguments: { file: "x.ts", repo: mkdtempSync(join(work, "mcp-bare-")) } })) as ToolResult;
      expect(notRepo.isError).toBe(true);
      expect(notRepo.content[0]!.text).toContain("無法判定");
      const text = notRepo.content[0]!.text;
      expect((JSON.parse(text.slice(0, text.indexOf("\n}") + 2)) as { status: string }).status).toBe("undetermined");
      const noHistory = (await client.callTool({ name: "cochange", arguments: { file: "no-such-file.ts", repo } })) as ToolResult;
      expect(noHistory.isError).toBe(true);
      expect(noHistory.content[0]!.text).toContain("no commit reachable from HEAD touches no-such-file.ts");
      const bad = (await client.callTool({ name: "cochange", arguments: { file: "core.ts", repo, limit: 0 } })) as ToolResult;
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe("XSPEC-514 R2: coChange in this process (coverage, and what a child process cannot show)", () => {
  it("returns what the CLI printed, and formatCoChange renders it [xspec514-r2-inprocess]", () => {
    const r = coChange({ file: "core.ts", repo, limit: 100 });
    expect(r.status).toBe("ok");
    const ok = r as CoChangeOk;
    expect(ok.cochanged).toEqual(CORE_EXPECTED);
    expect(ok.repoRoot).toBe(realpathSync(repo));
    expect(formatCoChange(ok)).toContain("4  a.ts");
    // A hundred is plenty: nothing is hidden, so no "more file(s)" line.
    expect(formatCoChange(ok)).not.toContain("more file(s)");
  });

  it("rejects a limit that is not a positive integer instead of treating it as a default [xspec514-r2-inprocess-validation]", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => coChange({ file: "core.ts", repo, limit: bad })).toThrow(/limit must be a positive integer/);
      expect(() => coChange({ file: "core.ts", repo, commits: bad })).toThrow(/commits must be a positive integer/);
      expect(() => coChange({ file: "core.ts", repo, maxFilesPerCommit: bad })).toThrow(/max files per commit/);
    }
    expect(() => coChange({ file: "", repo })).toThrow(/non-empty/);
  });

  it("git that is not installed is 無法判定 with the reason, not an empty list [xspec514-r2-no-git]", () => {
    const r = coChange({ file: "core.ts", repo, gitBinary: join(work, "no-such-git") }) as CoChangeUndetermined;
    expect(r.status).toBe("undetermined");
    expect(r.reason).toContain("git could not be run");
  });

  it.skipIf(IS_WINDOWS)("a git that never finishes is killed at the timeout and reported as 無法判定, not as a partial list [xspec514-r2-git-timeout]", () => {
    const hang = join(work, "hanging-git");
    writeFileSync(hang, "#!/bin/sh\nsleep 20\n");
    chmodSync(hang, 0o755);
    const started = Date.now();
    const r = coChange({ file: "core.ts", repo, gitBinary: hang, timeoutMs: 300 }) as CoChangeUndetermined;
    const elapsed = Date.now() - started;
    expect(r.status).toBe("undetermined");
    expect(r.reason).toContain("did not finish within 300 ms");
    expect(elapsed).toBeLessThan(10_000); // killed, not waited for (the stand-in sleeps 20 s)
  });

  it.skipIf(IS_WINDOWS)("a git that answers with something other than a work tree description is 無法判定, not guessed at [xspec514-r2-garbled-git]", () => {
    const odd = join(work, "odd-git");
    writeFileSync(odd, "#!/bin/sh\necho nonsense\n");
    chmodSync(odd, 0o755);
    const r = coChange({ file: "core.ts", repo, gitBinary: odd }) as CoChangeUndetermined;
    expect(r.status).toBe("undetermined");
    expect(r.reason).toContain("unexpected output from git rev-parse");
  });

  it("a path that does not exist in a directory that does not exist is 無法判定 [xspec514-r2-no-such-repo-dir]", () => {
    const r = coChange({ file: "x.ts", repo: join(work, "does-not-exist") }) as CoChangeUndetermined;
    expect(r.status).toBe("undetermined");
    expect(r.reason).toContain("is not a directory");
  });
});
