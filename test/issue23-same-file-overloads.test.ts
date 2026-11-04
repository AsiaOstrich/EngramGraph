// SPDX-License-Identifier: MIT
// implements XSPEC-514
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { GraphConnection } from "../src/graph-db/connection.js";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * Issue #23, step 1 - definitions that share a node id are reported as the several definitions they are.
 *
 * Two overloads in one file (`validate(A)` and `validate(B)` of one class) have the same node id
 * `<file>#<Class>.validate`, so the graph keeps ONE Function row for them. `egr callers validate` then said
 * `mergedDefinitions: 1`, no `⚠ merged` line, and listed the callers of both overloads as the callers of one
 * function. Now the row records every start line (`Function.definition_lines`) and the answer counts definitions.
 * The node ids are NOT changed (giving each overload its own node is step 2 and needs a migration).
 *
 * The proof goes through the built entry points as a user meets them: the `egr` CLI as a child process (text,
 * `--json`, exit code) and the `egr-mcp` stdio server through a real MCP client, over a C# project this file
 * writes and indexes with `egr index`, reading the printed answer back.
 *
 * Fixture (`proj/`, CALLS from other files bind to the one `validate` id):
 *   OrderRules.cs       static class OrderRules: validate(Create) at line 3, validate(Update) at line 6, and `once` (one definition)
 *   OrderController.cs  create() calls validate (the first overload), update() calls validate (the second), size() calls once
 */

let built: BuiltEgr;
let work: string;
let proj: string;
let db: string;
let env: NodeJS.ProcessEnv;

function isolatedEnv(home: string, dbPath: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const n of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8", env: process.env }).split("\n")) {
    if (n.trim()) delete e[n.trim()];
  }
  return {
    ...e,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, "empty-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CEILING_DIRECTORIES: dirname(work),
    ENGRAM_DB: dbPath,
  };
}

function put(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const RULES_TWO = [
  "public static class OrderRules {",
  "",
  "    public static int validate(CreateOrderRequest request) { return 1; }",
  "",
  "",
  "    public static int validate(UpdateOrderRequest request) { return 2; }",
  "",
  "    public static int once(Dto d) { return 3; }",
  "}",
  "",
].join("\n");

const RULES_ONE = RULES_TWO.replace("    public static int validate(UpdateOrderRequest request) { return 2; }\n", "");

const CONTROLLER = [
  "public class OrderController {",
  "    public int create() { return OrderRules.validate(null); }",
  "    public int update() { return OrderRules.validate(null); }",
  "    public int size() { return OrderRules.once(null); }",
  "}",
  "",
].join("\n");

function project(root: string, rules: string): void {
  put(root, "OrderRules.cs", rules);
  put(root, "OrderController.cs", CONTROLLER);
}

const egr = (e: NodeJS.ProcessEnv, ...args: string[]) => runEgr(built.cli, args, { env: e, cwd: work });

interface Row {
  id: string;
  name: string;
  file: string;
}
interface CallChain {
  symbol: string;
  definitions: Array<{ id: string; file: string; startLine: number | null }>;
  mergedDefinitions: number;
  file?: string;
  callers?: Row[];
}
const names = (rows: Row[] | undefined) => (rows ?? []).map((r) => r.name).sort();

async function withMcp<T>(e: NodeJS.ProcessEnv, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [built.mcp], cwd: work, env: e as Record<string, string>, stderr: "ignore" }));
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

async function callChain(client: Client, args: Record<string, unknown>): Promise<CallChain> {
  const res = (await client.callTool({ name: "call_chain", arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  expect(res.isError).not.toBe(true);
  return JSON.parse(res.content[0]!.text) as CallChain;
}

beforeAll(() => {
  built = buildEgr();
  work = realpathSync(mkdtempSync(join(tmpdir(), "egr-23-")));
  const home = join(work, "home");
  mkdirSync(home);
  proj = join(work, "proj");
  db = join(work, "g.db");
  env = isolatedEnv(home, db);
  project(proj, RULES_TWO);
  const r = egr(env, "index", proj);
  if (r.status !== 0) throw new Error(`fixture index failed: ${r.stderr}`);
}, 180_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

describe("issue #23: overloads in one file", () => {
  it("egr callers says the name is defined twice, with both lines, in the text and (on stderr) with --json [issue23-cli]", () => {
    const text = egr(env, "callers", "validate");
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain("⚠ merged");
    expect(text.stdout).toContain('"validate" is defined 2 times');
    expect(text.stdout).toContain("OrderRules.cs:3");
    expect(text.stdout).toContain("OrderRules.cs:6");
    // the one id cannot be split by a file, so the hint must not promise it can
    expect(text.stdout).toContain("definitions that share a file cannot be told apart");
    // both overloads' callers are in the one list: that is what the statement above is a warning about
    expect(text.stdout).toContain("create (OrderController.cs)");
    expect(text.stdout).toContain("update (OrderController.cs)");

    const json = egr(env, "callers", "validate", "--json");
    expect(json.status, json.stderr).toBe(0);
    const rows = JSON.parse(json.stdout) as Row[];
    expect(Array.isArray(rows)).toBe(true);
    expect(names(rows)).toEqual(["create", "update"]);
    expect(json.stderr).toContain("⚠ merged");
    expect(json.stderr).toContain('"validate" is defined 2 times');
    expect(json.stderr).toContain("OrderRules.cs:3");
    expect(json.stderr).toContain("OrderRules.cs:6");
  });

  it("--file on the overloaded file keeps the 'a file cannot tell them apart' statement; callees says the same [issue23-cli-file]", () => {
    const r = egr(env, "callers", "validate", "--file", "OrderRules.cs");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('"validate" is defined 2 times in OrderRules.cs (OrderRules.cs:3, OrderRules.cs:6)');
    expect(r.stdout).toContain("a file cannot tell them apart");
    const c = egr(env, "callees", "validate");
    expect(c.status, c.stderr).toBe(0);
    expect(c.stdout).toContain('"validate" is defined 2 times');
  });

  it("a name defined once in the same file prints no merged statement [issue23-single-control]", () => {
    const r = egr(env, "callers", "once");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain("merged");
    expect(r.stdout).toContain("size (OrderController.cs)");
    const j = egr(env, "callers", "once", "--json");
    expect(j.stderr).toBe("");
  });

  it("MCP call_chain returns mergedDefinitions 2 and both lines, for callers, callees and both [issue23-mcp]", async () => {
    await withMcp(env, async (client) => {
      const callers = await callChain(client, { symbol: "validate", direction: "callers" });
      expect(callers.mergedDefinitions).toBe(2);
      expect(callers.definitions.map((d) => d.startLine)).toEqual([3, 6]);
      expect(callers.definitions.every((d) => d.id === "OrderRules.cs#OrderRules.validate" && d.file === "OrderRules.cs")).toBe(true);
      expect(names(callers.callers)).toEqual(["create", "update"]);

      const both = await callChain(client, { symbol: "validate" });
      expect(both.mergedDefinitions).toBe(2);

      const narrowed = await callChain(client, { symbol: "validate", direction: "callers", file: "OrderRules.cs" });
      expect(narrowed.mergedDefinitions).toBe(2);
      expect(narrowed.file).toBe("OrderRules.cs");

      const once = await callChain(client, { symbol: "once", direction: "callers" });
      expect(once.mergedDefinitions).toBe(1);
      expect(once.definitions).toHaveLength(1);
    });
  });

  it("re-indexing a file after one overload is removed stops reporting it, plain and --incremental [issue23-reindex]", () => {
    const root = join(work, "proj-edit");
    const dbEdit = join(work, "edit.db");
    const e = isolatedEnv(join(work, "home"), dbEdit);
    project(root, RULES_TWO);
    expect(egr(e, "index", root).status).toBe(0);
    expect(egr(e, "callers", "validate").stdout).toContain("defined 2 times");

    project(root, RULES_ONE);
    const re = egr(e, "index", root);
    expect(re.status, re.stderr).toBe(0);
    const after = egr(e, "callers", "validate");
    expect(after.status, after.stderr).toBe(0);
    expect(after.stdout).not.toContain("merged");

    // and back to two, through the incremental path
    project(root, RULES_TWO);
    const inc = egr(e, "index", root, "--incremental");
    expect(inc.status, inc.stderr).toBe(0);
    expect(egr(e, "callers", "validate").stdout).toContain("defined 2 times");
    project(root, RULES_ONE);
    const inc2 = egr(e, "index", root, "--incremental");
    expect(inc2.status, inc2.stderr).toBe(0);
    expect(egr(e, "callers", "validate").stdout).not.toContain("merged");
  });

  it("a graph indexed before the column existed is still queried read-only (as before, one definition), and the next index adds the column [issue23-old-graph]", async () => {
    const oldDb = join(work, "old.db");
    const e = isolatedEnv(join(work, "home"), oldDb);
    const root = join(work, "proj-old");
    project(root, RULES_TWO);
    expect(egr(e, "index", root).status).toBe(0);
    // make it a graph from before this change: no `definition_lines` column
    const conn = GraphConnection.open(oldDb);
    await conn.execute("ALTER TABLE Function DROP definition_lines");
    await conn.execute("CHECKPOINT");
    await conn.close();

    const before = egr(e, "callers", "validate");
    expect(before.status, before.stderr).toBe(0);
    expect(before.stderr).not.toContain("Binder");
    expect(before.stdout).toContain("create (OrderController.cs)");
    expect(before.stdout).not.toContain("merged"); // it has no way to know; same as 0.14 / 0.15.0-beta.1
    await withMcp(e, async (client) => {
      const cc = await callChain(client, { symbol: "validate", direction: "callers" });
      expect(cc.mergedDefinitions).toBe(1);
      expect(names(cc.callers)).toEqual(["create", "update"]);
    });

    // the next write-open migrates the column in; the same index run fills it
    const re = egr(e, "index", root);
    expect(re.status, re.stderr).toBe(0);
    expect(re.stderr).toContain("Function.definition_lines");
    expect(egr(e, "callers", "validate").stdout).toContain("defined 2 times");
  });
});
