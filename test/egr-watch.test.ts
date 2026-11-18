// SPDX-License-Identifier: MIT
/**
 * `egr watch <dir>` — the index follows the files — and `indexHealth.staleFiles`,
 * which says so when it does not (yet).
 *
 * Every case goes through the built entry points as a user does: `egr watch` as a child process, `egr callers` /
 * `egr explore` as child processes, the MCP server over stdio. The effect is READ BACK (the new function is returned by
 * a query; `staleFiles` appears and disappears in an answer), never inferred from a log line alone.
 *
 * Each case builds its own project and graph, so it runs alone.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";
import { isRelevantChange } from "../src/cli/watch.js";

const require_ = createRequire(import.meta.url);
const RYU = require_.resolve("ryugraph");

let built: BuiltEgr;
const cleanups: Array<() => void> = [];

beforeAll(() => {
  built = buildEgr();
}, 120_000);

afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  built?.cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A scratch project with its own graph file (outside the project, so nothing the index writes is a source change). */
function scratch(): { work: string; proj: string; db: string; env: NodeJS.ProcessEnv } {
  const work = mkdtempSync(join(tmpdir(), "egr-watch-"));
  cleanups.push(() => rmSync(work, { recursive: true, force: true }));
  const proj = join(work, "proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "a.ts"), "export function helper() { return 1; }\nexport function main() { return helper(); }\n");
  const db = join(work, "graph.db");
  return { work, proj, db, env: { ...process.env, ENGRAM_DB: db } };
}

/** Add a function that calls `helper`, a little after the last index finished (so its mtime is later than the index's start). */
async function addFunction(proj: string): Promise<void> {
  await sleep(60);
  appendFileSync(join(proj, "a.ts"), "export function freshlyAdded() { return helper(); }\n");
}

interface Watcher {
  child: ChildProcess;
  out(): string;
  err(): string;
  waitFor(re: RegExp, ms?: number): Promise<void>;
  stop(): Promise<number | null>;
}

function startWatch(s: { work: string; proj: string; env: NodeJS.ProcessEnv }, extra: string[] = []): Watcher {
  const child = spawn(process.execPath, [built.cli, "watch", s.proj, ...extra], { cwd: s.work, env: s.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout!.on("data", (d) => (out += String(d)));
  child.stderr!.on("data", (d) => (err += String(d)));
  cleanups.push(() => child.kill("SIGKILL"));
  const w: Watcher = {
    child,
    out: () => out,
    err: () => err,
    async waitFor(re, ms = 60_000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (re.test(out)) return;
        if (child.exitCode !== null) throw new Error(`egr watch exited ${child.exitCode} before ${re}\nstdout: ${out}\nstderr: ${err}`);
        await sleep(100);
      }
      throw new Error(`timed out waiting for ${re}\nstdout: ${out}\nstderr: ${err}`);
    },
    async stop() {
      if (child.exitCode !== null) return child.exitCode;
      child.kill("SIGTERM");
      const end = Date.now() + 30_000;
      while (child.exitCode === null && Date.now() < end) await sleep(100);
      return child.exitCode;
    },
  };
  return w;
}

/** Run a query until `pick` returns something; a refused open (the writer is in the way for a moment) is retried. */
async function until<T>(what: string, ms: number, pick: () => T | undefined): Promise<T> {
  const end = Date.now() + ms;
  let last = "";
  while (Date.now() < end) {
    try {
      const v = pick();
      if (v !== undefined) return v;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for: ${what} ${last}`);
}

/** Names of the functions that call `helper`, or undefined when the query was refused or answered nothing usable. */
function callersOfHelper(s: { work: string; env: NodeJS.ProcessEnv }): string[] | undefined {
  const r = runEgr(built.cli, ["callers", "helper", "--json"], { env: s.env, cwd: s.work });
  if (r.status !== 0) return undefined; // locked by the writer for a moment
  return (JSON.parse(r.stdout) as Array<{ name: string }>).map((n) => n.name);
}

interface ExploreOut {
  status: string;
  indexHealth?: { staleFiles?: number; staleSample?: string[] };
}
function exploreHelper(s: { work: string; env: NodeJS.ProcessEnv }): ExploreOut | undefined {
  const r = runEgr(built.cli, ["explore", "helper", "--json"], { env: s.env, cwd: s.work });
  if (r.status !== 0) return undefined;
  return JSON.parse(r.stdout) as ExploreOut;
}

describe("egr watch: the graph follows the files", () => {
  it("a function added while `egr watch` runs is returned by `egr callers`, with no `egr index` run by hand [egr-watch-follows-edit]", async () => {
    const s = scratch();
    const w = startWatch(s, ["--debounce", "200"]);
    await w.waitFor(/\[watch\] ready/);
    // The initial catch-up built the graph from nothing: the original callers are there already.
    expect(callersOfHelper(s)).toEqual(["main"]);

    await addFunction(s.proj);

    const names = await until("freshlyAdded among the callers of helper", 60_000, () => {
      const n = callersOfHelper(s);
      return n && n.includes("freshlyAdded") ? n : undefined;
    });
    expect(names.sort()).toEqual(["freshlyAdded", "main"]);
    expect(w.out()).toMatch(/\[watch\] index done/);
    await w.stop();
  }, 120_000);

  it("a path that is not source (notes.txt, node_modules, .engram) does not start an index run [egr-watch-ignores-noise]", async () => {
    const s = scratch();
    const w = startWatch(s, ["--debounce", "200"]);
    await w.waitFor(/\[watch\] ready/);
    const runs = (): number => (w.out().match(/\[watch\] index done/g) ?? []).length;
    expect(runs()).toBe(1); // the initial catch-up

    await sleep(60);
    writeFileSync(join(s.proj, "notes.txt"), "not code\n");
    mkdirSync(join(s.proj, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(s.proj, "node_modules", "pkg", "x.ts"), "export function vendored() { return 1; }\n");
    mkdirSync(join(s.proj, ".engram"), { recursive: true });
    writeFileSync(join(s.proj, ".engram", "y.ts"), "export function own() { return 1; }\n");
    await sleep(2_000); // ten times the debounce

    expect(runs()).toBe(1);
    // ...and a real source edit right after still gets through (the watcher is alive, it just ignored those).
    await addFunction(s.proj);
    await until("the second index run", 60_000, () => (runs() >= 2 ? true : undefined));
    await w.stop();
  }, 120_000);

  it("SIGTERM stops it with exit 0 and leaves the graph readable [egr-watch-stops-cleanly]", async () => {
    if (process.platform === "win32") return; // no SIGTERM to send
    const s = scratch();
    const w = startWatch(s, ["--debounce", "200"]);
    await w.waitFor(/\[watch\] ready/);
    expect(await w.stop()).toBe(0);
    expect(callersOfHelper(s)).toEqual(["main"]);
  }, 120_000);

  it("a second writer can run while `egr watch` is idle: it does not hold the graph between runs [egr-watch-short-hold]", async () => {
    const s = scratch();
    const w = startWatch(s, ["--debounce", "200"]);
    await w.waitFor(/\[watch\] ready/);
    const r = runEgr(built.cli, ["index", s.proj, "--incremental"], { env: s.env, cwd: s.work });
    expect(r.status, r.stderr).toBe(0);
    // ...and it still follows the files afterwards.
    await addFunction(s.proj);
    await until("freshlyAdded after the manual index", 60_000, () => (callersOfHelper(s)?.includes("freshlyAdded") ? true : undefined));
    await w.stop();
  }, 120_000);

  it("while another process holds the graph it logs, waits and retries, and the function appears once the lock is released [egr-watch-lock-backoff]", async () => {
    const s = scratch();
    const w = startWatch(s, ["--debounce", "200"]);
    await w.waitFor(/\[watch\] ready/);

    // Another writer takes the graph (the same hold `cli-exit-codes.test.ts` uses).
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `const {Database,Connection}=require(${JSON.stringify(RYU)});
         try {
           const db=new Database(${JSON.stringify(s.db)});
           const c=new Connection(db);
           c.query("RETURN 1").then(()=>process.stdout.write("held\\n")).catch((e)=>{console.error(String(e));process.exit(3);});
           setInterval(()=>{},1000);
         } catch(e){console.error(String(e));process.exit(3);}`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    cleanups.push(() => holder.kill("SIGKILL"));
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("lock holder did not start")), 20_000);
      holder.stdout!.on("data", (d) => {
        if (String(d).includes("held")) {
          clearTimeout(t);
          res();
        }
      });
      holder.on("exit", (c) => rej(new Error(`lock holder exited ${c}`)));
    });

    await addFunction(s.proj);
    await w.waitFor(/\[watch\] graph is locked by another writer; retry 1 in \d+ ms/);
    expect(w.child.exitCode, "the watcher must stay alive while the graph is locked").toBeNull();

    holder.kill("SIGKILL");
    await until("freshlyAdded once the lock is gone", 90_000, () => (callersOfHelper(s)?.includes("freshlyAdded") ? true : undefined));
    expect(w.child.exitCode).toBeNull();
    await w.stop();
  }, 180_000);
});

describe("indexHealth.staleFiles: files newer than the index", () => {
  it("explore says one file is newer than the index after an edit and says nothing once `egr watch` has indexed it [egr-watch-stale-hint]", async () => {
    const s = scratch();
    // A long debounce makes the window between the edit and the index run wide and certain.
    const w = startWatch(s, ["--debounce", "4000"]);
    await w.waitFor(/\[watch\] ready/);

    // Control: right after an index, nothing is newer than it and the answer carries no `indexHealth` at all.
    const before = await until("explore before the edit", 30_000, () => exploreHelper(s));
    expect(before.indexHealth).toBeUndefined();

    await addFunction(s.proj);

    // The watcher has not processed the edit (it is still inside its 4 s debounce).
    const stale = await until("staleFiles after the edit", 3_000, () => {
      const e = exploreHelper(s);
      return e?.indexHealth?.staleFiles ? e : undefined;
    });
    expect(stale.indexHealth!.staleFiles).toBe(1);
    expect(stale.indexHealth!.staleSample).toEqual(["a.ts"]);
    expect(w.out().match(/\[watch\] index done/g)).toHaveLength(1); // still only the initial run

    // The text output of a query says it too, in words.
    const text = runEgr(built.cli, ["callers", "helper"], { env: s.env, cwd: s.work });
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/1 file\(s\) changed since this graph was indexed/);

    // The watcher catches up: the new function is in the graph and the hint is gone.
    await until("the hint to disappear", 90_000, () => {
      const e = exploreHelper(s);
      return e && e.indexHealth?.staleFiles === undefined && callersOfHelper(s)?.includes("freshlyAdded") ? true : undefined;
    });
    await w.stop();
  }, 180_000);

  it("the MCP tool call_chain carries indexHealth.staleFiles for an edited file, and loses it after `egr index --incremental` [egr-watch-stale-mcp]", async () => {
    const s = scratch();
    const first = runEgr(built.cli, ["index", s.proj, "--incremental"], { env: s.env, cwd: s.work });
    expect(first.status, first.stderr).toBe(0);

    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [built.mcp], env: { ...s.env } as Record<string, string>, stderr: "ignore" }));
    try {
      const ask = async (): Promise<{ staleFiles?: number }> => {
        const res = (await client.callTool({ name: "call_chain", arguments: { symbol: "helper", direction: "callers" } })) as { content: Array<{ text: string }> };
        return (JSON.parse(res.content.map((c) => c.text).join("\n")) as { indexHealth?: { staleFiles?: number } }).indexHealth ?? {};
      };
      expect((await ask()).staleFiles).toBeUndefined();

      await addFunction(s.proj);
      let seen: number | undefined;
      for (const end = Date.now() + 15_000; Date.now() < end && seen === undefined; await sleep(300)) seen = (await ask()).staleFiles;
      expect(seen).toBe(1);

      const again = runEgr(built.cli, ["index", s.proj, "--incremental"], { env: s.env, cwd: s.work });
      expect(again.status, again.stderr).toBe(0);
      let gone = false;
      for (const end = Date.now() + 15_000; Date.now() < end && !gone; await sleep(300)) gone = (await ask()).staleFiles === undefined;
      expect(gone).toBe(true);
    } finally {
      await client.close();
    }
  }, 120_000);

  it("a file deleted after the index counts as newer than it: the graph still holds a file that is gone [egr-watch-stale-deleted]", async () => {
    const s = scratch();
    writeFileSync(join(s.proj, "b.ts"), "export function other() { return 2; }\n");
    const first = runEgr(built.cli, ["index", s.proj, "--incremental"], { env: s.env, cwd: s.work });
    expect(first.status, first.stderr).toBe(0);
    await sleep(60);
    rmSync(join(s.proj, "b.ts"));
    const e = await until("staleFiles after the delete", 15_000, () => {
      const x = exploreHelper(s);
      return x?.indexHealth?.staleFiles ? x : undefined;
    });
    expect(e.indexHealth!.staleSample).toEqual(["b.ts"]);
  }, 60_000);
});

describe("which changes start an index run", () => {
  const opts = { docs: false, exclude: undefined };
  it("source files do, and so do files with no extension (shell scripts); dependencies, build output and the graph's own directory do not", () => {
    expect(isRelevantChange("a.ts", opts)).toBe(true);
    expect(isRelevantChange("src/deep/b.py", opts)).toBe(true);
    expect(isRelevantChange("bin-script", opts)).toBe(true);
    expect(isRelevantChange("src\\win\\c.go", opts)).toBe(true); // a Windows event path
    expect(isRelevantChange("node_modules/pkg/x.ts", opts)).toBe(false);
    expect(isRelevantChange(".engram/graph.parse-manifest.json", opts)).toBe(false);
    expect(isRelevantChange(".git/index", opts)).toBe(false);
    expect(isRelevantChange("dist/out.js", opts)).toBe(false);
    expect(isRelevantChange("README.txt", opts)).toBe(false);
    expect(isRelevantChange("graph.db.wal", opts)).toBe(false);
  });

  it("markdown counts only with --docs, and --exclude patterns apply as they do for `egr index`", () => {
    expect(isRelevantChange("docs/a.md", opts)).toBe(false);
    expect(isRelevantChange("docs/a.md", { docs: true, exclude: undefined })).toBe(true);
    expect(isRelevantChange("gen/a.ts", { docs: false, exclude: ["gen/"] })).toBe(false);
    expect(isRelevantChange("src/gen/a.ts", { docs: false, exclude: ["gen/"] })).toBe(false); // an unanchored trailing-slash pattern, as in `index`
    expect(isRelevantChange("src/a.ts", { docs: false, exclude: ["gen/"] })).toBe(true);
    expect(isRelevantChange("a.generated.ts", { docs: false, exclude: ["*.generated.ts"] })).toBe(false);
  });
});

// Kept so the file can be read as "what is spawned": the CLI invocation `egr watch` with no directory is an error, not a hang.
describe("egr watch argument errors", () => {
  it("needs a directory, and says so with exit 1", () => {
    const s = scratch();
    const r = spawnSync(process.execPath, [built.cli, "watch"], { cwd: s.work, env: s.env, encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/watch requires a <dir>/);
  });

  it("refuses a directory that does not exist, and a --debounce that is not a whole number of milliseconds", () => {
    const s = scratch();
    const missing = spawnSync(process.execPath, [built.cli, "watch", join(s.work, "nope")], { cwd: s.work, env: s.env, encoding: "utf8", timeout: 30_000 });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/is not a directory/);
    const bad = spawnSync(process.execPath, [built.cli, "watch", s.proj, "--debounce", "soon"], { cwd: s.work, env: s.env, encoding: "utf8", timeout: 30_000 });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/--debounce must be a whole number/);
  });
});
