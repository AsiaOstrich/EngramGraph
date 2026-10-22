// implements XSPEC-498 R2
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `scripts/stable-gate.mjs` stands between a GitHub Release and `npm publish`
 * for a stable version: HEAD must be the same content as the newest preview tag
 * of that X.Y.Z (only release bookkeeping may differ), and the Windows checklist
 * must have PASSED on that preview.
 *
 * Every case here runs the script as a command, against a throwaway git
 * repository that has real preview tags and a real release commit, and reads
 * back what it printed and what it asked GitHub. The GitHub side is a fake `gh`
 * executable (STABLE_GATE_GH) that serves canned JSON and writes every call it
 * receives to a log, so "the gate really asked" is something a test can read.
 *
 * Nothing touches the real repo, the user's git config or the keychain: git
 * runs with every hook-exported variable removed (the 2026-10-07 incident put 76
 * fixture commits on a real branch through exactly that leak), no global/system
 * config, and a throwaway HOME.
 */

const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/stable-gate.mjs");
const SLUG = "acme/widget";
const WORKFLOW_PATH = ".github/workflows/windows-release-verify.yml";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let home: string | undefined;
/** Environment for git and the script: minus every variable git exports to a hook, no global config, throwaway HOME. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  home ??= tmpDir("egr-gate-home-");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8", env: process.env }).split("\n")) {
    if (name.trim()) delete env[name.trim()];
  }
  delete env.GITHUB_REPOSITORY;
  delete env.STABLE_GATE_GH;
  return { ...env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...extra };
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    encoding: "utf8",
    env: cleanEnv(),
  });
}

function put(repo: string, file: string, content: string): void {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), content);
}

function pkgJson(version: string, deps: Record<string, string> = { left: "1.0.0" }): string {
  return JSON.stringify({ name: "widget", version, dependencies: deps }, null, 2) + "\n";
}

function lockJson(version: string, deps: Record<string, string> = { left: "1.0.0" }): string {
  return JSON.stringify({ name: "widget", version, lockfileVersion: 3, packages: { "": { name: "widget", version, dependencies: deps }, "node_modules/left": { version: "1.0.0" } } }, null, 2) + "\n";
}

interface Fixture {
  repo: string;
}

/**
 * History: beta.1 (src v1) -> beta.2 (src v2, the LATEST preview) -> release commit for 1.2.0.
 * Between beta.1 and beta.2 `src/a.ts` changes, so a gate that compared with the wrong preview
 * would refuse the allowed case. A tag of another X.Y.Z sits on beta.2's commit as a decoy.
 * `release` edits the working tree of the release commit before it is made.
 */
function buildRepo(release: (repo: string) => void = () => {}, opts: { previews?: boolean } = {}): Fixture {
  const repo = tmpDir("egr-gate-repo-");
  git(repo, "init", "-q", "-b", "main");
  put(repo, "package.json", pkgJson("1.2.0-beta.1"));
  put(repo, "package-lock.json", lockJson("1.2.0-beta.1"));
  put(repo, "CHANGELOG.md", "# Changelog\n\n## 1.2.0-beta.1\n- first\n");
  put(repo, "src/a.ts", "export const a = 1;\n");
  put(repo, "src/b.ts", "export const b = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "beta.1");
  if (opts.previews !== false) git(repo, "tag", "v1.2.0-beta.1");

  put(repo, "src/a.ts", "export const a = 2;\n");
  put(repo, "package.json", pkgJson("1.2.0-beta.2"));
  put(repo, "package-lock.json", lockJson("1.2.0-beta.2"));
  put(repo, "CHANGELOG.md", "# Changelog\n\n## 1.2.0-beta.2\n- second\n\n## 1.2.0-beta.1\n- first\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "beta.2");
  if (opts.previews !== false) {
    git(repo, "tag", "v1.2.0-beta.2");
    git(repo, "tag", "v1.3.0-beta.1");
  }

  // The release commit: version fields and CHANGELOG, as a real one does.
  put(repo, "package.json", pkgJson("1.2.0"));
  put(repo, "package-lock.json", lockJson("1.2.0"));
  put(repo, "CHANGELOG.md", "# Changelog\n\n## 1.2.0\n- stable\n\n## 1.2.0-beta.2\n- second\n");
  release(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "release 1.2.0");
  return { repo };
}

interface RunFixture {
  path: string;
  event?: string;
  head_branch?: string;
  status?: string;
  conclusion?: string | null;
}

/** What the fake GitHub knows: artifacts by name and runs by id. */
interface FakeGitHub {
  artifacts?: Record<string, number[]>;
  runs?: Record<number, Partial<RunFixture>>;
}

function goodRun(over: Partial<RunFixture> = {}): RunFixture {
  return { path: WORKFLOW_PATH, event: "workflow_dispatch", head_branch: "main", status: "completed", conclusion: "success", ...over };
}

/** `windows-release-verify-<version>` was uploaded by the given runs. */
function verifiedPreview(version: string, runOver: Partial<RunFixture> = {}): FakeGitHub {
  return { artifacts: { [`windows-release-verify-${version}`]: [4242] }, runs: { 4242: goodRun(runOver) } };
}

interface FakeGh {
  exe: string;
  log: string;
}

/** An executable standing in for `gh`: answers `api <path>` from `world`, appends each call to a log. */
function fakeGh(world: FakeGitHub): FakeGh {
  const dir = tmpDir("egr-gate-gh-");
  const log = join(dir, "calls.log");
  const exe = join(dir, "gh");
  const data = join(dir, "world.json");
  writeFileSync(data, JSON.stringify(world));
  writeFileSync(
    exe,
    `#!${process.execPath}
const fs = require("node:fs");
const world = JSON.parse(fs.readFileSync(${JSON.stringify(data)}, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const path = args[1] || "";
const prefix = "repos/${SLUG}/actions/";
if (args[0] !== "api" || !path.startsWith(prefix)) { console.error("fake gh: unexpected call " + args.join(" ")); process.exit(1); }
const rest = path.slice(prefix.length);
if (rest.startsWith("artifacts?name=")) {
  const name = decodeURIComponent(rest.slice("artifacts?name=".length).split("&")[0]);
  const ids = (world.artifacts || {})[name] || [];
  const artifacts = ids.map((id) => ({ id: id + 1, name, expired: false, workflow_run: { id } }));
  console.log(JSON.stringify({ total_count: artifacts.length, artifacts }));
  process.exit(0);
}
const m = /^runs\\/(\\d+)$/.exec(rest);
if (m && (world.runs || {})[m[1]]) { console.log(JSON.stringify({ id: Number(m[1]), ...world.runs[m[1]] })); process.exit(0); }
console.error("fake gh: 404 " + path);
process.exit(1);
`,
  );
  chmodSync(exe, 0o755);
  return { exe, log };
}

function callsOf(gh: FakeGh): string[][] {
  if (!existsSync(gh.log)) return [];
  return readFileSync(gh.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
}

function runGate(repo: string, version: string, gh: FakeGh | { exe: string }, extraArgs: string[] = ["--github-repo", SLUG]) {
  const r = spawnSync(process.execPath, [SCRIPT, version, "--repo", repo, ...extraArgs], {
    encoding: "utf8",
    env: cleanEnv({ STABLE_GATE_GH: gh.exe }),
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

describe("scripts/stable-gate.mjs, run as a command against a real git history", () => {
  it("allows a stable version whose only differences are release bookkeeping, when the Windows run on the latest preview passed", () => {
    const { repo } = buildRepo();
    const gh = fakeGh(verifiedPreview("1.2.0-beta.2"));
    const r = runGate(repo, "1.2.0", gh);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain("v1.2.0-beta.2");
    expect(r.out).toContain("OK");
    // It compared with beta.2, not beta.1 (src/a.ts differs between them) and asked about beta.2's artifact.
    const asked = callsOf(gh).map((c) => c[1] ?? "");
    expect(asked.some((p) => p.includes("artifacts?name=windows-release-verify-1.2.0-beta.2"))).toBe(true);
    expect(asked.some((p) => p === `repos/${SLUG}/actions/runs/4242`)).toBe(true);
  });

  it("refuses when a source file changed after the preview, and names that file", () => {
    const { repo } = buildRepo((dir) => put(dir, "src/b.ts", "export const b = 'changed after beta.2';\n"));
    const gh = fakeGh(verifiedPreview("1.2.0-beta.2"));
    const r = runGate(repo, "1.2.0", gh);
    expect(r.status).toBe(1);
    expect(r.err).toContain("src/b.ts");
    expect(r.err).toContain("v1.2.0-beta.2");
    // The release bookkeeping files are not blamed: the only listed file is src/b.ts.
    const listed = r.err.split("\n").filter((l) => /^ {6}\S/.test(l)).map((l) => l.trim().split(/\s+/)[0]);
    expect(listed).toEqual(["src/b.ts"]);
    // The Windows run was fine, so the content is the only reason.
    expect(r.err).not.toContain("Windows verification");
  });

  it("refuses a file added or deleted after the preview", () => {
    const added = buildRepo((dir) => put(dir, "src/new.ts", "export const n = 1;\n"));
    const a = runGate(added.repo, "1.2.0", fakeGh(verifiedPreview("1.2.0-beta.2")));
    expect(a.status).toBe(1);
    expect(a.err).toContain("src/new.ts");

    const deleted = buildRepo((dir) => rmSync(join(dir, "src/b.ts")));
    const d = runGate(deleted.repo, "1.2.0", fakeGh(verifiedPreview("1.2.0-beta.2")));
    expect(d.status).toBe(1);
    expect(d.err).toContain("src/b.ts");
  });

  it("refuses when package.json or package-lock.json changed beyond the version field", () => {
    const dep = buildRepo((dir) => put(dir, "package.json", pkgJson("1.2.0", { left: "1.0.0", right: "9.9.9" })));
    const p = runGate(dep.repo, "1.2.0", fakeGh(verifiedPreview("1.2.0-beta.2")));
    expect(p.status).toBe(1);
    expect(p.err).toContain("package.json");
    expect(p.err).toContain("beyond its version field");

    const lock = buildRepo((dir) => put(dir, "package-lock.json", lockJson("1.2.0", { left: "1.0.0", right: "9.9.9" })));
    const l = runGate(lock.repo, "1.2.0", fakeGh(verifiedPreview("1.2.0-beta.2")));
    expect(l.status).toBe(1);
    expect(l.err).toContain("package-lock.json");
  });

  it("refuses identical content when the Windows checklist never ran on that preview, and says it asked GitHub", () => {
    const { repo } = buildRepo();
    const gh = fakeGh({}); // GitHub knows no artifact at all
    const r = runGate(repo, "1.2.0", gh);
    expect(r.status).toBe(1);
    expect(r.err).toContain("Windows verification");
    expect(r.err).toContain("windows-release-verify-1.2.0-beta.2");
    expect(r.err).not.toContain("content differs");
    // Read back: the gate really made the query (this is what makes "remove the check" visible).
    expect(callsOf(gh).some((c) => (c[1] ?? "").includes("artifacts?name=windows-release-verify-1.2.0-beta.2"))).toBe(true);
  });

  it("refuses when the Windows checklist ran on an older preview only", () => {
    const { repo } = buildRepo();
    const r = runGate(repo, "1.2.0", fakeGh(verifiedPreview("1.2.0-beta.1")));
    expect(r.status).toBe(1);
    expect(r.err).toContain("windows-release-verify-1.2.0-beta.2");
  });

  it("refuses an artifact whose run FAILED (a failed run uploads its artifact too)", () => {
    const { repo } = buildRepo();
    const r = runGate(repo, "1.2.0", fakeGh(verifiedPreview("1.2.0-beta.2", { conclusion: "failure" })));
    expect(r.status).toBe(1);
    expect(r.err).toContain("conclusion is failure");
  });

  it("refuses a run that is not a main-branch dispatch of the verification workflow", () => {
    const { repo } = buildRepo();
    const branch = runGate(repo, "1.2.0", fakeGh(verifiedPreview("1.2.0-beta.2", { head_branch: "experiment" })));
    expect(branch.status).toBe(1);
    expect(branch.err).toContain("branch is experiment");

    const other = runGate(repo, "1.2.0", fakeGh(verifiedPreview("1.2.0-beta.2", { path: ".github/workflows/something-else.yml" })));
    expect(other.status).toBe(1);
    expect(other.err).toContain("workflow is .github/workflows/something-else.yml");

    const pending = runGate(repo, "1.2.0", fakeGh(verifiedPreview("1.2.0-beta.2", { status: "in_progress", conclusion: null })));
    expect(pending.status).toBe(1);
  });

  it("treats 'could not ask GitHub' as a refusal, not a pass", () => {
    const { repo } = buildRepo();
    const r = runGate(repo, "1.2.0", { exe: join(tmpdir(), "egr-gate-no-such-gh-executable") });
    expect(r.status).toBe(1);
    expect(r.err).toContain("not finding out is not a pass");
  });

  it("reports both reasons when the content differs and there is no Windows run", () => {
    const { repo } = buildRepo((dir) => put(dir, "src/a.ts", "export const a = 3;\n"));
    const r = runGate(repo, "1.2.0", fakeGh({}));
    expect(r.status).toBe(1);
    expect(r.err).toContain("src/a.ts");
    expect(r.err).toContain("Windows verification");
  });

  it("refuses a stable version that has no preview tag at all", () => {
    const { repo } = buildRepo(() => {}, { previews: false });
    const gh = fakeGh(verifiedPreview("1.2.0-beta.2"));
    const r = runGate(repo, "1.2.0", gh);
    expect(r.status).toBe(1);
    expect(r.err).toContain("no preview tag");
  });

  it("refuses when the version asked about is not the version at HEAD", () => {
    const { repo } = buildRepo();
    const r = runGate(repo, "1.2.1", fakeGh(verifiedPreview("1.2.0-beta.2")));
    expect(r.status).toBe(1);
    expect(r.err).toContain("package.json says version 1.2.0");
  });

  it("refuses to guess which GitHub repository to ask", () => {
    const { repo } = buildRepo();
    const gh = fakeGh(verifiedPreview("1.2.0-beta.2"));
    const r = runGate(repo, "1.2.0", gh, []);
    expect(r.status).toBe(1);
    expect(r.err).toContain("Cannot tell which GitHub repository");
    expect(callsOf(gh)).toEqual([]);
  });

  // Control arm: the gate must not be a wall in front of every version.
  it("does not manage a preview version: exit 0 and GitHub is never asked", () => {
    const { repo } = buildRepo((dir) => put(dir, "src/a.ts", "export const a = 'anything';\n"));
    const gh = fakeGh({});
    const r = runGate(repo, "1.2.0-beta.3", gh);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain("preview version");
    expect(callsOf(gh)).toEqual([]);
  });

  it("refuses a version of a shape publish.yml would send to 'latest' unchecked", () => {
    const { repo } = buildRepo();
    const r = runGate(repo, "1.2.0-foo.1", fakeGh({}));
    expect(r.status).toBe(1);
    expect(r.err).toContain("neither X.Y.Z nor");
  });

  it("exits 2 without a version", () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: cleanEnv() });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage");
  });
});

describe("scripts/stable-gate.mjs, preview ordering", () => {
  it("picks the newest preview of the same X.Y.Z: alpha < beta < rc, numbers compared as numbers", async () => {
    const mod = (await import(SCRIPT)) as { pickLatestPreview: (stable: string, tags: string[]) => string | null };
    expect(mod.pickLatestPreview("1.2.0", ["v1.2.0-beta.9", "v1.2.0-beta.10", "v1.2.0-beta.2"])).toBe("1.2.0-beta.10");
    expect(mod.pickLatestPreview("1.2.0", ["v1.2.0-rc.1", "v1.2.0-beta.12", "v1.2.0-alpha.30"])).toBe("1.2.0-rc.1");
    expect(mod.pickLatestPreview("1.2.0", ["v1.3.0-rc.9", "v1.1.0-rc.9", "v1.2.0-beta.1", "v1.2.0", "v1.2.0-foo.1", "1.2.0-rc.5"])).toBe("1.2.0-beta.1");
    expect(mod.pickLatestPreview("1.2.0", ["v1.3.0-rc.9"])).toBeNull();
  });
});

describe(".github/workflows/publish.yml wires the gate in front of npm publish", () => {
  const yml = readFileSync(join(ROOT, ".github/workflows/publish.yml"), "utf8");

  /** Lines of the top-level job `name`, up to the next job. */
  function job(name: string): string {
    const lines = yml.split("\n");
    const start = lines.findIndex((l) => l === `  ${name}:`);
    if (start < 0) return "";
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^ {0,2}\S/.test(lines[i] ?? "") && !(lines[i] ?? "").startsWith("   ")) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end).join("\n");
  }

  /** Non-comment lines only: a mention in a comment is not a step. */
  const code = (text: string) => text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

  it("runs scripts/stable-gate.mjs with the package.json version, with tags and Actions read access, on every release (no `if:`)", () => {
    const gate = code(job("stable-gate"));
    expect(gate, "publish.yml has no stable-gate job").not.toBe("");
    expect(gate).toContain("node scripts/stable-gate.mjs");
    expect(gate).toContain("require('./package.json').version");
    expect(gate).toMatch(/fetch-depth: 0/);
    expect(gate).toMatch(/fetch-tags: true/);
    expect(gate).toMatch(/actions: read/);
    expect(gate).toContain("GH_TOKEN: ${{ github.token }}");
    // Which versions are stable is decided in the script; a workflow-level `if:` would be a second, drifting opinion.
    expect(gate).not.toMatch(/^\s*if:/m);
  });

  it("makes publish wait for the gate, and npm publish lives in publish", () => {
    const publish = code(job("publish"));
    const needs = /^\s{4}needs:\s*(.+)$/m.exec(publish)?.[1] ?? "";
    expect(needs).toContain("stable-gate");
    expect(publish).toContain("npm publish");
    expect(code(job("stable-gate"))).not.toContain("npm publish");
    // No other job publishes: the gate cannot be bypassed by a sibling.
    expect(code(yml).match(/npm publish/g)?.length).toBe(1);
  });
});
