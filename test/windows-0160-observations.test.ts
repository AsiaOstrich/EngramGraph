// SPDX-License-Identifier: MIT
/**
 * Three small things the Windows run of 0.16.0-beta.1 found (dev-platform #280, observations O2, O3, O4). Each case runs
 * the BUILT CLI as a child process and reads what it printed; the node count is checked against the graph itself.
 *
 * - O2: a question in Chinese found nothing and did not say why. Now it says names in code are mostly English, and a
 *   question that mixes Chinese with an English name is cut where the scripts meet, so the name is searched.
 * - O3: `egr watch` / `egr index --incremental` said "1 edge(s) written" for a new file and nothing about its nodes.
 * - O4: `egr watch .` printed `egr index <folder name> --incremental`, which does not run from the directory it was
 *   started in.
 *
 * Each case builds its own project and graph, so it runs alone.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

let built: BuiltEgr | undefined;
const cleanups: Array<() => void> = [];
const cli = (): string => (built ??= buildEgr()).cli;
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  built?.cleanup();
});

interface Project {
  work: string;
  proj: string;
  db: string;
  env: NodeJS.ProcessEnv;
}

/** A project with `parseInvoice` and `total`, indexed. The graph file lives outside it. */
function project(name: string): Project {
  const work = mkdtempSync(join(tmpdir(), `egr-obs-${name}-`));
  cleanups.push(() => rmSync(work, { recursive: true, force: true }));
  const proj = join(work, "proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "billing.ts"), "export function parseInvoice() { return total(); }\nexport function total() { return 1; }\n");
  const db = join(work, "graph.db");
  const p: Project = { work, proj, db, env: { ...process.env, ENGRAM_DB: db } };
  const r = run(p, ["index", proj, "--incremental"], work);
  if (r.status !== 0) throw new Error(`fixture index failed: ${r.stderr}`);
  return p;
}

const run = (p: Project, args: string[], cwd: string) => runEgr(cli(), args, { env: p.env, cwd });

async function nodeCount(db: string): Promise<number> {
  const conn = GraphConnection.open(db, { readOnly: true });
  try {
    let n = 0;
    for (const label of ["Function", "Class", "Module"]) n += Number((await conn.query(`MATCH (n:${label}) RETURN count(n) AS c`))[0]?.c ?? 0);
    return n;
  } finally {
    await conn.close();
  }
}

describe("O2: a question in Chinese", () => {
  it("that matches nothing says code names are mostly English and to search with English keywords, in text and in --json", () => {
    const p = project("o2-hint");
    const text = run(p, ["explore", "這個專案怎麼處理登入"], p.work);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain("NO MATCH");
    expect(text.stdout).toContain("names in code are mostly English");
    expect(text.stdout).toContain("search again with English keywords");

    const json = run(p, ["explore", "這個專案怎麼處理登入", "--json"], p.work);
    const r = JSON.parse(json.stdout) as { status: string; message?: string };
    expect(r.status).toBe("no-match");
    expect(r.message).toContain("search again with English keywords");
  });

  it("that matches nothing in English does not carry the hint", () => {
    const p = project("o2-control");
    const r = run(p, ["explore", "how is the zzzunknownthing handled"], p.work);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("NO MATCH");
    expect(r.stdout).not.toContain("Chinese, Japanese or Korean");
  });

  it("with an English name inside it is cut where the scripts meet, so the name is found", () => {
    const p = project("o2-split");
    const r = run(p, ["explore", "解析parseInvoice流程", "--json"], p.work);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { status: string; keywords: string[]; symbols: Array<{ name: string }> };
    expect(out.status).toBe("ok");
    expect(out.keywords).toEqual(expect.arrayContaining(["parse", "invoice"]));
    expect(out.symbols.map((s) => s.name)).toContain("parseInvoice");
  });
});

describe("O3: the summary of an incremental run says how many nodes it added", () => {
  it("a new file's nodes are counted, and the number equals the growth of the graph", async () => {
    const p = project("o3-count");
    const before = await nodeCount(p.db);
    writeFileSync(join(p.proj, "extra.ts"), "export function extraOne() { return 1; }\nexport function extraTwo() { return extraOne(); }\n");

    const r = run(p, ["index", p.proj, "--incremental"], p.work);
    expect(r.status, r.stderr).toBe(0);
    const line = r.stdout.split("\n").find((l) => l.startsWith("incremental:"))!;
    const added = Number(/(\d+) node\(s\) added/.exec(line)?.[1]);
    const after = await nodeCount(p.db);
    expect(after - before).toBe(3); // extra.ts, extraOne, extraTwo
    expect(added).toBe(after - before); // what is printed is what the graph grew by
    expect(line).toMatch(/\d+ edge\(s\) written/);

    // An edit that adds nothing new says 0 nodes added, not the nodes it rewrote.
    appendFileSync(join(p.proj, "extra.ts"), "// a comment\n");
    const again = run(p, ["index", p.proj, "--incremental"], p.work);
    expect(again.stdout).toMatch(/0 node\(s\) added/);
  });
});

describe("O4: the command `egr watch` says it catches up with", () => {
  it("is the path as typed, and runs as printed from the directory the watcher was started in", async () => {
    const p = project("o4-path");
    // Started from inside the project with `.`: the folder's name (`proj`) would not exist from there.
    const child: ChildProcess = spawn(process.execPath, [cli(), "watch", ".", "--debounce", "200"], { cwd: p.proj, env: p.env, stdio: ["ignore", "pipe", "pipe"] });
    cleanups.push(() => child.kill("SIGKILL"));
    let out = "";
    child.stdout!.on("data", (d) => (out += String(d)));
    const end = Date.now() + 60_000;
    while (!/\[watch\] ready/.test(out)) {
      if (child.exitCode !== null) throw new Error(`egr watch exited ${child.exitCode} before ready: ${out}`);
      if (Date.now() > end) throw new Error(`egr watch was not ready in 60 s: ${out}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const first = out.split("\n")[0]!;
    const printed = /catching up first with: (egr index .*)$/.exec(first)?.[1];
    expect(printed, first).toBe("egr index . --incremental");

    // The printed command, run as printed from the same directory, works.
    const [, ...args] = printed!.split(" ");
    const r = runEgr(cli(), args, { env: p.env, cwd: p.proj });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("incremental:");

    child.kill("SIGTERM");
    await new Promise((res) => (child.exitCode !== null ? res(null) : child.on("exit", () => res(null))));
  }, 120_000);
});
