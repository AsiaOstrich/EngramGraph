/**
 * XSPEC-334 R2 — query-side index health.
 *
 * Covers `computeIndexHealth`'s global counts + coarse directory-subtree
 * `possiblyIncomplete` match, and `cmdBlindspots`' manifest view.
 */

import { afterAll, describe, it, expect } from "vitest";

import { computeIndexHealth } from "../src/code-graph/index-health.js";
import { upsertRun } from "../src/code-graph/parse-manifest.js";
import { cmdBlindspots } from "../src/cli/run.js";
import type { FileParseHealth } from "../src/code-graph/parse-health.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, writeManifest, type IndexAttempt, type ParseManifest } from "../src/code-graph/parse-manifest.js";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

const fph = (path: string, over: Partial<FileParseHealth> = {}): FileParseHealth => ({
  path,
  language: "typescript",
  errorNodes: 0,
  errorExtent: 0,
  sourceExtent: 10,
  functions: 1,
  classes: 0,
  ...over,
});

const manifestOf = (files: FileParseHealth[]) => upsertRun(null, "/root", "t", files, "1.0.0");

describe("computeIndexHealth (R2)", () => {
  it("returns null for a null manifest", () => {
    expect(computeIndexHealth(null, ["a.ts"])).toBeNull();
  });

  it("returns null for a fully healthy graph (no field, no noise)", () => {
    const m = manifestOf([fph("a.ts"), fph("b.ts")]);
    expect(computeIndexHealth(m, ["a.ts"])).toBeNull();
  });

  it("reports global counts without possiblyIncomplete when no result files given", () => {
    const m = manifestOf([fph("a.ts"), fph("bad.ts", { errorNodes: 2 }), fph("boom.ts", { failed: "x" })]);
    const h = computeIndexHealth(m, [])!;
    expect(h).toMatchObject({ filesIndexed: 3, partial: 1, failed: 1 });
    expect(h.possiblyIncomplete).toBeUndefined();
  });

  it("flags possiblyIncomplete when a blindspot shares the result's subtree", () => {
    const m = manifestOf([
      fph("domains/web/routes/foo.ts"),
      fph("domains/web/routes/__tests__/auth.test.ts", { errorNodes: 1 }),
    ]);
    const h = computeIndexHealth(m, ["domains/web/routes/foo.ts"])!;
    expect(h.possiblyIncomplete).toBe(true);
    expect(h.blindspots).toEqual(["domains/web/routes/__tests__/auth.test.ts"]);
  });

  it("does NOT flag when the blindspot is in an unrelated subtree", () => {
    const m = manifestOf([
      fph("domains/web/foo.ts"),
      fph("domains/discovery/bad.ts", { errorNodes: 1 }),
    ]);
    const h = computeIndexHealth(m, ["domains/web/foo.ts"])!;
    expect(h.partial).toBe(1); // still counted globally
    expect(h.possiblyIncomplete).toBeUndefined(); // but not flagged for THIS result
  });

  it("a top-level blindspot does not flag a nested result (conservative)", () => {
    const m = manifestOf([fph("domains/web/foo.ts"), fph("index.ts", { errorNodes: 1 })]);
    const h = computeIndexHealth(m, ["domains/web/foo.ts"])!;
    expect(h.possiblyIncomplete).toBeUndefined();
  });

  it("caps the blindspots list at 20 but reports the true total (never lies about count)", () => {
    const bad = Array.from({ length: 30 }, (_, i) => fph(`pkg/f${i}.ts`, { errorNodes: 1 }));
    const m = manifestOf([fph("pkg/ok.ts"), ...bad]);
    const h = computeIndexHealth(m, ["pkg/ok.ts"])!;
    expect(h.possiblyIncomplete).toBe(true);
    expect(h.blindspots).toHaveLength(20); // list truncated
    expect(h.blindspotsTotal).toBe(30); // but the count is honest
  });
});

describe("readManifest hardening (R2 [高] fix)", () => {
  it("returns null for a structurally-malformed manifest instead of crashing allFiles", async () => {
    const { readManifest } = await import("../src/code-graph/parse-manifest.js");
    const dir = mkdtempSync(join(tmpdir(), "engram-badmanifest-"));
    try {
      for (const bad of ["{}", "[]", '{"runs": null}', '{"runs": 42}', "not json at all"]) {
        const p = join(dir, "m.json");
        writeFileSync(p, bad);
        expect(readManifest(p)).toBeNull(); // no throw, treated as "no manifest"
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("computeIndexHealth over an all-empty manifest does not throw", () => {
    // A manifest whose runs exist but have no files (defensive `?? []`).
    const empty = manifestOf([]);
    expect(computeIndexHealth(empty, ["a.ts"])).toBeNull();
  });
});

describe("cmdBlindspots (R2b)", () => {
  it("returns empty for a missing manifest", () => {
    expect(cmdBlindspots(join(tmpdir(), "nope-xspec334-r2.json"))).toEqual({
      filesIndexed: 0,
      partial: 0,
      failed: 0,
      blindspots: [],
    });
  });

  it("lists unhealthy files worst-first (failed before partial)", () => {
    const dir = mkdtempSync(join(tmpdir(), "engram-blindspots-"));
    try {
      const path = join(dir, "graph.parse-manifest.json");
      writeManifest(
        path,
        manifestOf([
          fph("clean.ts"),
          fph("partial-lo.ts", { errorNodes: 1 }),
          fph("partial-hi.ts", { errorNodes: 5 }),
          fph("boom.ts", { failed: "threw" }),
        ]),
      );
      const r = cmdBlindspots(path);
      expect(r).toMatchObject({ filesIndexed: 4, partial: 2, failed: 1 });
      expect(r.blindspots.map((b) => b.path)).toEqual(["boom.ts", "partial-hi.ts", "partial-lo.ts"]);
      expect(r.blindspots[0]).toMatchObject({ path: "boom.ts", failed: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// DEC-108 D1 — the graph remembers how the last `egr index` run ended, and a query says so when it did not end well.
//
// Every case below runs the BUILT CLI as a child process, indexes a real directory, and reads the answer a query prints
// (or the manifest it left). Nothing calls `recordIndexAttempt` directly. The "never finished" case kills a real run.
// ---------------------------------------------------------------------------------------------------------------------

let builtEgr: BuiltEgr | undefined;
const scratchDirs: string[] = [];
/** Built lazily, from the current `src/`, so each test can run alone (the evidence checker runs one by name). */
function cli(): string {
  builtEgr ??= buildEgr();
  return builtEgr.cli;
}
afterAll(() => {
  builtEgr?.cleanup();
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});

interface Project {
  dir: string;
  proj: string;
  db: string;
  manifest: string;
}

const writeSources = (proj: string, count: number, prefix = "f"): void => {
  mkdirSync(proj, { recursive: true });
  for (let i = 0; i < count; i++) {
    const fns = Array.from({ length: 10 }, (_, j) => `export function ${prefix}${i}_${j}() { return ${prefix}${i}_${(j + 1) % 10}(); }`).join("\n");
    writeFileSync(join(proj, `${prefix}${i}.ts`), fns + "\n");
  }
};

/** A project holding `alpha()`, indexed once, successfully. */
function indexedProject(name: string): Project {
  const dir = mkdtempSync(join(tmpdir(), `egr-attempt-${name}-`));
  scratchDirs.push(dir);
  const proj = join(dir, "proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "a.ts"), "export function alpha() { return beta(); }\nexport function beta() { return 1; }\n");
  const p: Project = { dir, proj, db: join(dir, "graph.db"), manifest: join(dir, "graph.parse-manifest.json") };
  const r = egr(p, ["index", proj]);
  if (r.status !== 0) throw new Error(`fixture index failed: ${r.stderr}`);
  return p;
}

const egr = (p: Project, args: string[]) => runEgr(cli(), args, { env: { ...process.env, ENGRAM_DB: p.db }, cwd: p.dir });

const attemptOf = (p: Project): IndexAttempt => {
  const m = readManifest(p.manifest)!;
  const a = m.indexAttempts?.[p.proj];
  if (!a) throw new Error(`no attempt record for ${p.proj} in ${JSON.stringify(m.indexAttempts)}`);
  return a;
};

/** Start `egr index` and kill it the moment its `started` record is on disk; resolves with what the manifest said. */
async function indexAndKillAtStart(p: Project, args: string[]): Promise<void> {
  const child = spawn(process.execPath, [cli(), ...args], { env: { ...process.env, ENGRAM_DB: p.db }, cwd: p.dir, stdio: "ignore" });
  const exited = new Promise<void>((res) => child.on("exit", () => res()));
  const deadline = Date.now() + 60_000;
  try {
    for (;;) {
      let status: string | undefined;
      try {
        status = readManifest(p.manifest)?.indexAttempts?.[p.proj]?.status;
      } catch {
        /* the file is being replaced */
      }
      if (status === "started") break;
      if (child.exitCode !== null) throw new Error(`egr index ended (exit ${child.exitCode}) before it wrote a "started" record`);
      if (Date.now() > deadline) throw new Error("no \"started\" record appeared within 60 s");
      await new Promise((r) => setTimeout(r, 2));
    }
    // Killed with the first signal that cannot be handled: no `finally`, no `failed` record, nothing runs after it.
    child.kill("SIGKILL");
    await exited;
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

it("an index run that started but never finished is reported as interrupted, never as success", async () => {
  const p = indexedProject("interrupted");
  expect(attemptOf(p).status).toBe("succeeded"); // the first run ended and said so
  writeSources(p.proj, 12); // ~120 functions: writing them takes several seconds (about 30 ms each), so the kill lands mid-run

  await indexAndKillAtStart(p, ["index", p.proj]);

  // The manifest still says the run started, and nothing says it ended.
  const rec = attemptOf(p);
  expect(rec.status).toBe("started");
  expect(rec.finishedAt).toBeUndefined();

  // What a user sees from a query, from the real CLI.
  const q = egr(p, ["callers", "alpha"]);
  expect(q.status, q.stderr).toBe(0);
  expect(q.stdout).toContain(`the last index run of ${p.proj}`);
  expect(q.stdout).toContain("wrote no ending: it was stopped before it finished");
  expect(q.stdout).toContain(`run \`egr index ${p.proj}\` again`); // the fix, as a command that can be pasted
  expect(q.stdout).not.toMatch(/succeeded|completed|up to date|\bfresh\b/i);

  // Said the same way where an agent reads it: `explore --json` carries the structured outcome.
  const ex = egr(p, ["explore", "alpha", "--json"]);
  expect(ex.status, ex.stderr).toBe(0);
  const health = (JSON.parse(ex.stdout) as { indexHealth?: { lastIndexAttempts?: Array<{ root: string; outcome: string }> } }).indexHealth;
  expect(health?.lastIndexAttempts).toMatchObject([{ root: p.proj, outcome: "interrupted" }]);

  // Running it again ends the record, and the query stops saying so.
  const again = egr(p, ["index", p.proj]);
  expect(again.status, again.stderr).toBe(0);
  expect(attemptOf(p).status).toBe("succeeded");
  expect(egr(p, ["callers", "alpha"]).stdout).not.toContain("last index run");
}, 180_000);

it("an index run that failed is reported with its reason and the command to run again", () => {
  const p = indexedProject("failed");
  const missing = join(p.dir, "no-such-index.scip");
  const bad = egr(p, ["index", p.proj, "--scip", missing]);
  expect(bad.status).not.toBe(0);

  const rec = attemptOf(p);
  expect(rec.status).toBe("failed");
  expect(rec.error).toContain("no-such-index.scip");
  expect(rec.finishedAt).toBeDefined();

  const q = egr(p, ["callers", "alpha"]);
  expect(q.status, q.stderr).toBe(0);
  expect(q.stdout).toContain(`the last index run of ${p.proj}`);
  expect(q.stdout).toContain("failed: ");
  expect(q.stdout).toContain("no-such-index.scip");
  expect(q.stdout).toContain(`run \`egr index ${p.proj}\` again`);

  // `explore` that finds nothing says it too: an empty answer is when the reader most needs to know.
  const nothing = egr(p, ["explore", "zzzunknownthing"]);
  expect(nothing.stdout).toContain("NO MATCH");
  expect(nothing.stdout).toContain("failed: ");
});

it("a successful index run adds nothing to a query's answer, and an older manifest with no record says nothing either", () => {
  const p = indexedProject("success");
  expect(attemptOf(p).status).toBe("succeeded");
  const ok = egr(p, ["callers", "alpha"]);
  expect(ok.stdout).not.toContain("last index run");

  // A manifest an earlier egr wrote has no `indexAttempts`. "No record" is not reported as a failure.
  const m = JSON.parse(readFileSync(p.manifest, "utf8")) as ParseManifest;
  delete m.indexAttempts;
  writeFileSync(p.manifest, JSON.stringify(m));
  const old = egr(p, ["callers", "alpha"]);
  expect(old.status, old.stderr).toBe(0);
  expect(old.stdout).not.toContain("last index run");
});

it("a started record whose process is still running is not reported as interrupted", () => {
  const p = indexedProject("running");
  const m = JSON.parse(readFileSync(p.manifest, "utf8")) as ParseManifest;
  // This very test process stands for the run in progress: it is alive.
  m.indexAttempts![p.proj] = { status: "started", startedAt: new Date().toISOString(), pid: process.pid, egrVersion: m.egrVersion };
  writeFileSync(p.manifest, JSON.stringify(m));
  expect(egr(p, ["callers", "alpha"]).stdout).not.toContain("last index run");

  // The same record with a process that is gone is an interrupted run.
  m.indexAttempts![p.proj]!.pid = 2 ** 22 + 12345; // above any pid this machine hands out
  writeFileSync(p.manifest, JSON.stringify(m));
  expect(egr(p, ["callers", "alpha"]).stdout).toContain("wrote no ending");
});

it("writing the attempt record leaves the egr version record of a newer egr alone, and a failed run keeps the other roots' records", () => {
  const p = indexedProject("versions");
  const other = join(p.dir, "other");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "o.ts"), "export function omega() { return 1; }\n");
  expect(egr(p, ["index", other]).status).toBe(0);
  const m = JSON.parse(readFileSync(p.manifest, "utf8")) as ParseManifest;
  m.graphEgrVersion = "99.0.0";
  writeFileSync(p.manifest, JSON.stringify(m));

  const bad = egr(p, ["index", p.proj, "--scip", join(p.dir, "missing.scip")]);
  expect(bad.status).not.toBe(0);
  const after = readManifest(p.manifest)!;
  expect(after.graphEgrVersion).toBe("99.0.0");
  expect(after.indexAttempts![p.proj]!.status).toBe("failed");
  expect(after.indexAttempts![other]!.status).toBe("succeeded"); // another root's record is not touched
  expect(Object.keys(after.runs).sort()).toEqual([other, p.proj].sort());
});

describe("lastIndexAttempts in the health a query carries (DEC-108 D1)", () => {
  const attempt = (a: Partial<IndexAttempt>): IndexAttempt => ({ status: "failed", startedAt: "2026-11-24T00:00:00.000Z", egrVersion: "1.0.0", ...a });
  const withAttempts = (attempts: Record<string, IndexAttempt>) => ({ ...manifestOf([fph("a.ts")]), indexAttempts: attempts });

  it("a graph with clean files but a failed last run still carries a health object", () => {
    const h = computeIndexHealth(withAttempts({ "/r": attempt({ error: "boom" }) }), ["a.ts"]);
    expect(h?.lastIndexAttempts).toMatchObject([{ root: "/r", outcome: "failed", error: "boom" }]);
  });

  it("states a root with a space in its path as a command that can be pasted", () => {
    const h = computeIndexHealth(withAttempts({ "/my repo": attempt({ status: "started", pid: 2 ** 22 + 99 }) }), [])!;
    expect(h.lastIndexAttempts![0]!.fix).toContain('egr index "/my repo"');
  });

  it("all recorded runs succeeded: no field, as before", () => {
    expect(computeIndexHealth(withAttempts({ "/r": attempt({ status: "succeeded" }) }), ["a.ts"])).toBeNull();
  });
});
