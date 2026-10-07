// implements XSPEC-457
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { related } from "../src/structural-memory/query.js";
import { buildEgr, REPO_ROOT, type BuiltEgr } from "./helpers/build-cli.js";

/**
 * XSPEC-457 R2 + R4 — the CLI's exit status says whether the command did what
 * was asked, and "the graph does not contain that" is not "there is nothing".
 *
 * Two defects, one class: a command printed that it could not do the thing and
 * then exited 0.
 *   R2  `related` printed an I/O exception (graph locked) and exited 0 on the
 *       reporter's Windows machine, where `god-nodes` / `communities` / `index`
 *       / `feedback` all exited 1.
 *   R4  `callers NoSuchSymbolXYZ` printed `(none)`, exit 0 — the same words and
 *       status as a real function nobody calls.
 *
 * Fixed as a class, so this file is a TABLE over every command rather than a
 * test per reported command, and a guard fails if the CLI gains a command the
 * table does not know. All runs are the built CLI as a child process.
 */

const require_ = createRequire(import.meta.url);
const RYU = require_.resolve("ryugraph");

let built: BuiltEgr;
let work: string;
let dbPath: string;
let proj: string;

function egr(args: string[], db = dbPath): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [built.cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ENGRAM_DB: db },
    cwd: work,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-exit-"));
  dbPath = join(work, "graph.db");
  proj = join(work, "proj");
  mkdirSync(join(proj, "docs"), { recursive: true });
  writeFileSync(
    join(proj, "a.ts"),
    "// implements SPEC-1\nexport function alpha() { return beta(); }\nexport function beta() { return 1; }\nexport function lonely() { return 2; }\n",
  );
  writeFileSync(join(proj, "docs", "spec-1.md"), "---\nid: SPEC-1\nimpacted_by: [DEC-1]\n---\n# SPEC-1\nbody\n");
  writeFileSync(join(proj, "docs", "dec-1.md"), "---\nid: DEC-1\n---\n# DEC-1\nbody\n");
  writeFileSync(join(proj, "docs", "note.md"), "See `a.ts` and `beta` for the details.\n");
  writeFileSync(join(proj, "docs", "spec-2.md"), "---\nid: SPEC-2\n---\n# SPEC-2\nno code implements this\n");
  const r = egr(["index", proj, "--docs"]);
  if (r.status !== 0) throw new Error(`fixture index failed: ${r.stderr}`);
}, 120_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

describe("XSPEC-457 R4: an input the graph does not contain is an error, not '(none)'", () => {
  it("callers of a symbol that is not in the graph exits 1 and says the graph has no such function [xspec457-r4-callers]", () => {
    const r = egr(["callers", "NoSuchSymbolXYZ"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no function named "NoSuchSymbolXYZ" is in the graph/);
    expect(r.stderr).toMatch(/not the same as "nothing calls it"/);
    expect(r.stdout).not.toMatch(/\(none\)/);
  });

  it("callers of a real function that nobody calls exits 0 and says there are none", () => {
    const r = egr(["callers", "lonely"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("callers(lonely):");
    expect(r.stdout).toContain("(none)");
  });

  it("callers of a misspelt symbol offers the near names", () => {
    const r = egr(["callers", "betta"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Did you mean: beta\?/);
  });

  it("callees of a symbol that is not in the graph exits 1; of a real leaf function exits 0 with (none)", () => {
    const missing = egr(["callees", "NoSuchSymbolXYZ"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/no function named "NoSuchSymbolXYZ" is in the graph/);
    const leaf = egr(["callees", "lonely"]);
    expect(leaf.status, leaf.stderr).toBe(0);
    expect(leaf.stdout).toContain("(none)");
  });

  it("callers --json for an unknown symbol prints nothing on stdout, like `top BogusLabel`", () => {
    const r = egr(["callers", "NoSuchSymbolXYZ", "--json"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    const top = egr(["top", "BogusLabel"]);
    expect(top.status).toBe(1);
    expect(top.stdout).toBe("");
  });

  it("impact of a spec id the graph has not seen exits 1; of an indexed spec exits 0", () => {
    const missing = egr(["impact", "SPEC-999"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/no spec with id "SPEC-999" is in the graph/);
    const real = egr(["impact", "SPEC-1"]);
    expect(real.status, real.stderr).toBe(0);
    expect(real.stdout).toContain("DEC-1");
  });
});

describe("XSPEC-457 R4: the same distinction over MCP stdio", () => {
  async function withServer<T>(fn: (call: (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>) => Promise<T>): Promise<T> {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [built.mcp], env: { ...process.env, ENGRAM_DB: dbPath } as Record<string, string>, stderr: "ignore" }),
    );
    try {
      return await fn(async (name, args) => {
        const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
        return { isError: res.isError === true, text: res.content.map((c) => c.text).join("\n") };
      });
    } finally {
      await client.close();
    }
  }

  it("call_chain for a symbol the graph does not contain is an error that says so, with near names — not callers: [] [xspec457-r4-mcp-call-chain]", async () => {
    await withServer(async (call) => {
      const missing = await call("call_chain", { symbol: "betta", direction: "callers" });
      expect(missing.isError).toBe(true);
      expect(missing.text).toMatch(/no function named "betta" is in the graph/);
      expect(missing.text).toMatch(/Did you mean: beta\?/);
      expect(missing.text).not.toMatch(/"callers"/);
    });
  });

  it("call_chain for a real function nobody calls answers callers: [] with symbolFound: true", async () => {
    await withServer(async (call) => {
      const lonely = await call("call_chain", { symbol: "lonely", direction: "callers" });
      expect(lonely.isError).toBe(false);
      const body = JSON.parse(lonely.text) as { callers: unknown[]; symbolFound: boolean };
      expect(body.callers).toEqual([]);
      expect(body.symbolFound).toBe(true);
    });
  });

  it("impact_analysis for a spec id the graph has not seen is an error; for an indexed spec it answers", async () => {
    await withServer(async (call) => {
      const missing = await call("impact_analysis", { nodeId: "SPEC-999" });
      expect(missing.isError).toBe(true);
      expect(missing.text).toMatch(/no spec with id "SPEC-999" is in the graph/);
      const real = await call("impact_analysis", { nodeId: "SPEC-1" });
      expect(real.isError).toBe(false);
      expect(real.text).toContain("DEC-1");
    });
  });
});

describe("XSPEC-457 R2: every command that said it could not do the thing now exits non-zero", () => {
  it("feedback on a node that is not there exits 1 (it printed 'node not found' and exited 0) [xspec457-r2-feedback]", () => {
    const r = egr(["feedback", "test_fail", "NoSuchNode"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no Function node with id "NoSuchNode" is in the graph/);
    const ok = egr(["feedback", "test_fail", "a.ts#beta"]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/a\.ts#beta: .* → /);
  });

  it("related on an id that is not in the graph exits 1 (it printed '(none)' and exited 0)", () => {
    const r = egr(["related", "no-such-id"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no node with id "no-such-id" is in the graph/);
  });

  it("related on a real node exits 0 and ranks its neighbours", () => {
    const r = egr(["related", "a.ts#beta"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("related(a.ts#beta):");
  });

  it("implementers of a spec id the graph has never seen exits 1; of a spec nobody implements exits 0 [xspec457-r2-implementers]", () => {
    const missing = egr(["implementers", "SPEC-999"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/no spec with id "SPEC-999" is in the graph/);
    const none = egr(["implementers", "SPEC-2"]);
    expect(none.status, none.stderr).toBe(0);
    expect(none.stdout).toContain("no file declares it implements it");
    const some = egr(["implementers", "SPEC-1"]);
    expect(some.status, some.stderr).toBe(0);
    expect(some.stdout).toContain("a.ts");
  });

  it("implemented-by a path that is not a module exits 1; an indexed module that declares nothing exits 0", () => {
    const missing = egr(["implemented-by", "src/never/indexed.ts"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/no module with path "src\/never\/indexed.ts" is in the graph/);
    const real = egr(["implemented-by", "a.ts"]);
    expect(real.status, real.stderr).toBe(0);
    expect(real.stdout).toContain("SPEC-1");
  });

  it("related does not swallow a failure of its first write (a fault at the projection drop propagates)", async () => {
    // The only place `related` could fail and carry on: a catch-all around DROP_PROJECTED_GRAPH.
    // Only "does not exist" is fine there. Driven in-process, with a connection whose DROP raises the
    // I/O error a lock refusal produces, because the reported exit-0 happened on Windows and cannot be
    // provoked on this OS from outside (the engine refuses at open here); the Windows workflow runs the
    // real-lock version of this in scripts/mcp-concurrency-verify.mjs.
    const dir = mkdtempSync(join(tmpdir(), "egr-drop-"));
    const real = GraphConnection.open(join(dir, "g.db"));
    try {
      await initSchema(real);
      await real.query(`CREATE (f:Function {id: 'x#f', name: 'f', confidence: 0.5})`);
      let dropSeen = false;
      const faulty = new Proxy(real, {
        get(target, prop, recv) {
          if (prop === "execute") {
            return async (cypher: string, params?: Record<string, never>) => {
              if (/DROP_PROJECTED_GRAPH/.test(cypher)) {
                dropSeen = true;
                throw new Error("IO exception: Could not set lock on file : /g.db");
              }
              return target.execute(cypher, params);
            };
          }
          const v = Reflect.get(target, prop, recv);
          return typeof v === "function" ? v.bind(target) : v;
        },
      }) as GraphConnection;
      await expect(related(faulty, "x#f")).rejects.toThrow(/Could not set lock/);
      expect(dropSeen).toBe(true);
    } finally {
      await real.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("XSPEC-457 R2: the lock — every command that opens the graph fails with a non-zero status when another process holds it", () => {
  let holder: ChildProcess | undefined;
  let lockedDb: string;

  beforeAll(async () => {
    // A separate copy: this one stays locked for the whole group.
    lockedDb = join(work, "locked.db");
    const seed = spawnSync(process.execPath, [built.cli, "index", proj, "--docs"], {
      env: { ...process.env, ENGRAM_DB: lockedDb },
      encoding: "utf8",
    });
    if (seed.status !== 0) throw new Error(seed.stderr);
    holder = spawn(
      process.execPath,
      [
        "-e",
        `const {Database,Connection}=require(${JSON.stringify(RYU)});
         try {
           const db=new Database(${JSON.stringify(lockedDb)});
           const c=new Connection(db);
           c.query("RETURN 1").then(()=>process.stdout.write("held\\n")).catch((e)=>{console.error(String(e));process.exit(3);});
           setInterval(()=>{},1000);
         } catch(e){console.error(String(e));process.exit(3);}`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("lock holder did not start")), 20_000);
      holder!.stdout!.on("data", (d) => {
        if (String(d).includes("held")) {
          clearTimeout(t);
          res();
        }
      });
      holder!.on("exit", (c) => rej(new Error(`lock holder exited ${c}`)));
    });
  }, 60_000);

  afterAll(() => {
    holder?.kill();
  });

  const LOCKED: Array<[string, string[]]> = [
    ["index", ["index", "PROJ"]],
    ["index --docs", ["index", "PROJ", "--docs"]],
    ["callers", ["callers", "beta"]],
    ["callees", ["callees", "alpha"]],
    ["implementers", ["implementers", "SPEC-1"]],
    ["implemented-by", ["implemented-by", "a.ts"]],
    ["impact", ["impact", "SPEC-1"]],
    ["feedback", ["feedback", "test_fail", "a.ts#beta"]],
    ["top", ["top", "Function"]],
    ["god-nodes", ["god-nodes"]],
    ["communities", ["communities"]],
    ["related", ["related", "a.ts#beta"]],
    ["related (id that is not in the graph)", ["related", "no-such-id"]],
    // The note cites `a.ts` and `beta`, so this command must reach the graph to answer.
    ["refs check", ["refs", "check", "PROJ/docs/note.md"]],
  ];

  it.each(LOCKED)("%s exits non-zero and names the lock, not an empty result", (_name, argv) => {
    const args = argv.map((a) => a.replace("PROJ", proj));
    const r = egr(args, lockedDb);
    expect(r.status, `${r.stdout}\n${r.stderr}`).not.toBe(0);
    expect(r.status).not.toBeNull();
    expect(r.stderr).toMatch(/Could not set lock|another process has this graph open/);
    expect(r.stdout).not.toMatch(/\(none\)/);
  });
});

describe("XSPEC-457 R2: the command table covers every command the CLI has", () => {
  it("no command in src/cli/index.ts is missing from the exit-status tables above", () => {
    const src = readFileSync(join(REPO_ROOT, "src", "cli", "index.ts"), "utf8");
    const found = new Set<string>();
    for (const m of src.matchAll(/case "([a-z-]+)":/g)) found.add(m[1]!);
    for (const m of src.matchAll(/cmd === "([a-z-]+)"/g)) found.add(m[1]!);
    // Commands whose failure behaviour is exercised in this file (by name in a test above or in LOCKED).
    const covered = new Set([
      "index", "callers", "callees", "implementers", "implemented-by", "impact", "feedback", "top",
      "god-nodes", "communities", "related", "refs",
    ]);
    // Not graph commands that can fail on a graph: they read files / report the install / run until killed.
    const exempt = new Set([
      "gc", // inspects <git-common-dir>/engram; outside a git repo it reports and exits 0 (nothing to remove)
      "blindspots", "signatures", // read the parse-health manifest; "no manifest yet" is a state, not an error
      "doctor", // reports the installation
      "mcp", "serve", // long-running servers
    ]);
    const unknown = [...found].filter((c) => !covered.has(c) && !exempt.has(c));
    expect(unknown, `commands with no exit-status case: ${unknown.join(", ")} — add each to the tables in this file`).toEqual([]);
    expect(found.size).toBeGreaterThanOrEqual(15);
  });
});
