// SPDX-License-Identifier: MIT
// implements XSPEC-531
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { createMcpServer } from "../src/mcp/server.js";
import { keywordsOf, keywordStems, nameStems, stemsMatch } from "../src/code-graph/explore.js";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * XSPEC-531 — `explore`: one call that takes a sentence and returns the area of code it is about.
 *
 * Why it exists: in the #91 trial an assistant asked "how does X work" used none of the EGR tools in 16 runs and
 * fell back to grep, because every tool needs a name (a function, a spec id, a seed id) the assistant does not have
 * yet. `explore` takes the sentence.
 *
 * Every case below goes through a BUILT entry point — the stdio MCP server as a child process with a real MCP client,
 * and the `egr` CLI as a child process — on a graph that `egr index` really built from a small Go project shaped like
 * gin's request path (ServeHTTP -> handleHTTPRequest -> Next). Nothing here calls the explore function directly except
 * the keyword unit cases at the bottom, which are not the proof of the feature.
 *
 * The three names are the ones the #91 method (appendix A) requires. In this indexer a Go method's name is the bare
 * method name (`ServeHTTP`, not `Engine.ServeHTTP`; the receiver is not part of the node id), so that is what is
 * asserted.
 */

const GIN_QUESTION = "how does it route requests through its middleware chain";
const UNRELATED_QUESTION = "how does it load configuration from environment variables";
const THE_THREE = ["ServeHTTP", "handleHTTPRequest", "Next"];

const GIN_GO = `package gin

import "net/http"

type HandlerFunc func(*Context)

type HandlersChain []HandlerFunc

type Engine struct {
	allNoRoute HandlersChain
}

func New() *Engine {
	return &Engine{}
}

func (engine *Engine) Use(middleware ...HandlerFunc) {
	engine.allNoRoute = append(engine.allNoRoute, middleware...)
}

func (engine *Engine) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	c := engine.allocateContext()
	c.reset()
	engine.handleHTTPRequest(c)
}

func (engine *Engine) handleHTTPRequest(c *Context) {
	handlers := engine.lookup(c.path)
	c.handlers = handlers
	c.Next()
}

func (engine *Engine) allocateContext() *Context {
	return &Context{}
}

func (engine *Engine) lookup(path string) HandlersChain {
	return engine.allNoRoute
}
`;

const CONTEXT_GO = `package gin

type Context struct {
	handlers HandlersChain
	index    int
	path     string
}

func (c *Context) Next() {
	c.index++
	for c.index < len(c.handlers) {
		c.handlers[c.index](c)
		c.index++
	}
}

func (c *Context) reset() {
	c.index = -1
}
`;

// A second cluster that shares no name with the first and is not called from it: the control for "does the answer
// follow the question, or does it always return the same functions".
const CONFIG_GO = `package gin

import "os"

func LoadConfig() map[string]string {
	raw := readEnvironment()
	return validateConfig(raw)
}

func readEnvironment() map[string]string {
	return map[string]string{"PORT": os.Getenv("PORT")}
}

func validateConfig(raw map[string]string) map[string]string {
	return raw
}
`;

let work: string;
let proj: string;
let db: string;
let built: BuiltEgr;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ENGRAM_DB: db, ...extra };
}

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-531-"));
  proj = join(work, "gin");
  mkdirSync(proj);
  writeFileSync(join(proj, "gin.go"), GIN_GO);
  writeFileSync(join(proj, "context.go"), CONTEXT_GO);
  writeFileSync(join(proj, "config.go"), CONFIG_GO);
  db = join(work, "g.db");
  const r = runEgr(built.cli, ["index", proj], { env: env(), cwd: work });
  if (r.status !== 0) throw new Error(`fixture index failed: ${r.stderr}`);
}, 120_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [built.mcp],
      cwd: work,
      env: env() as Record<string, string>,
      stderr: "ignore",
    }),
  );
  return client;
}

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

interface Explored {
  status: string;
  keywords: string[];
  truncated: boolean;
  maxChars: number;
  message?: string;
  symbols: Array<{ name: string; kind: string; file: string; line?: number; role: string; snippet?: string; snippetNote?: string }>;
  callPaths: string[];
  next: string[];
  notExpanded?: { symbols: string[]; symbolsTotal: number; snippets: string[]; snippetsTotal: number };
}

async function exploreViaMcp(args: Record<string, unknown>): Promise<{ raw: string; data: Explored; isError: boolean }> {
  const client = await connect();
  try {
    const res = (await client.callTool({ name: "explore", arguments: args })) as ToolResult;
    const raw = res.content[0]!.text;
    return { raw, data: res.isError ? ({} as Explored) : (JSON.parse(raw) as Explored), isError: res.isError === true };
  } finally {
    await client.close();
  }
}

function exploreViaCli(topic: string, extra: string[] = []): { stdout: string; stderr: string; status: number | null; data?: Explored } {
  const r = runEgr(built.cli, ["explore", topic, ...extra], { env: env(), cwd: work });
  const asJson = extra.includes("--json");
  return { ...r, data: asJson && r.status === 0 ? (JSON.parse(r.stdout) as Explored) : undefined };
}

describe("XSPEC-531 R1/R2: explore through the stdio MCP server", () => {
  it("is listed, with a description that says when to call it first, and the point queries point back to it [xspec531-mcp-listed]", async () => {
    const client = await connect();
    try {
      const tools = (await client.listTools()).tools;
      const explore = tools.find((t) => t.name === "explore");
      expect(explore, `tools: ${tools.map((t) => t.name).join(", ")}`).toBeDefined();
      expect(explore!.description).toMatch(/^When you don't have a symbol name yet \(how does X work \/ where is Y handled\), call this first, before grep/);
      expect(explore!.annotations?.readOnlyHint).toBe(true);
      for (const name of ["call_chain", "implementers"]) {
        expect(tools.find((t) => t.name === name)!.description, name).toMatch(/\bexplore\b/);
      }
    } finally {
      await client.close();
    }
  });

  it("answers a how-does-it-work question with the three symbols, their call path and their source [xspec531-mcp-gin]", async () => {
    const { raw, data, isError } = await exploreViaMcp({ topic: GIN_QUESTION });
    expect(isError, raw).toBe(false);
    expect(data.status).toBe("ok");
    const names = data.symbols.map((s) => s.name);
    for (const n of THE_THREE) expect(names, raw).toContain(n);
    // The path between them is returned, in call order.
    expect(data.callPaths.some((p) => p.includes("ServeHTTP → handleHTTPRequest → Next")), JSON.stringify(data.callPaths)).toBe(true);
    // Read back from the files: the snippet is the real source, taken at the line the graph recorded.
    const handle = data.symbols.find((s) => s.name === "handleHTTPRequest")!;
    expect(handle.file).toBe("gin.go");
    expect(handle.line).toBe(GIN_GO.split("\n").findIndex((l) => l.includes("handleHTTPRequest(c *Context)")) + 1);
    expect(handle.snippet).toContain("func (engine *Engine) handleHTTPRequest(c *Context)");
    expect(handle.snippet).toContain("c.Next()");
    // The next point query is named, using a tool this server offers.
    expect(data.next.some((n) => n.startsWith("call_chain") && n.includes("handleHTTPRequest"))).toBe(true);
    expect(raw.length).toBeLessThanOrEqual(6000);
  });

  it("returns none of the three for a question about something else [xspec531-mcp-control]", async () => {
    const { raw, data, isError } = await exploreViaMcp({ topic: UNRELATED_QUESTION });
    expect(isError, raw).toBe(false);
    const names = data.symbols.map((s) => s.name);
    expect(names).toContain("LoadConfig");
    for (const n of THE_THREE) expect(names, raw).not.toContain(n);
    expect(raw).not.toContain("handleHTTPRequest");
  });

  it("says NO MATCH, not an empty list, when no symbol or path fits the words [xspec531-mcp-no-match]", async () => {
    const { raw, data, isError } = await exploreViaMcp({ topic: "kubernetes operator reconciliation" });
    expect(isError).toBe(false);
    expect(data.status).toBe("no-match");
    expect(data.symbols).toEqual([]);
    expect(data.message).toMatch(/no symbol or file path matched/i);
    expect(data.message).toMatch(/not the same as/i);
    expect(raw).toContain("kubernetes");
  });

  it("refuses a topic with no searchable word instead of answering with everything [xspec531-mcp-empty-topic]", async () => {
    const { raw, isError } = await exploreViaMcp({ topic: "how does it work" });
    expect(isError).toBe(true);
    expect(raw).toMatch(/no searchable word/i);
  });

  it("keeps the whole answer within maxChars and lists what it did not expand [xspec531-mcp-budget]", async () => {
    const small = await exploreViaMcp({ topic: GIN_QUESTION, maxChars: 900 });
    expect(small.isError, small.raw).toBe(false);
    expect(small.raw.length).toBeLessThanOrEqual(900);
    expect(small.data.truncated).toBe(true);
    expect(small.data.notExpanded, small.raw).toBeDefined();
    // Nothing is dropped silently: what is not shown is counted and named.
    const ne = small.data.notExpanded!;
    expect(ne.symbolsTotal + ne.snippetsTotal).toBeGreaterThan(0);
    // The bigger budget shows more of the same answer.
    const big = await exploreViaMcp({ topic: GIN_QUESTION, maxChars: 20000 });
    expect(big.data.truncated).toBe(false);
    expect(big.data.symbols.filter((s) => s.snippet).length).toBeGreaterThan(small.data.symbols.filter((s) => s.snippet).length);
    // A budget below the floor is raised and said so, not obeyed into an unusable answer.
    const tiny = await exploreViaMcp({ topic: GIN_QUESTION, maxChars: 50 });
    expect(tiny.data.maxChars).toBeGreaterThanOrEqual(400);
    expect(tiny.raw.length).toBeLessThanOrEqual(tiny.data.maxChars);
  });

  it("writes nothing to the graph [xspec531-mcp-read-only]", async () => {
    const before = runEgr(built.cli, ["top", "Function", "--limit", "50"], { env: env(), cwd: work }).stdout;
    await exploreViaMcp({ topic: GIN_QUESTION });
    await exploreViaMcp({ topic: UNRELATED_QUESTION });
    const after = runEgr(built.cli, ["top", "Function", "--limit", "50"], { env: env(), cwd: work }).stdout;
    expect(after).toBe(before);
  });
});

describe("XSPEC-531 R1/R3: egr explore through the CLI", () => {
  it("prints the three symbols and the call path for the gin question [xspec531-cli-gin]", () => {
    const r = exploreViaCli(GIN_QUESTION, ["--json"]);
    expect(r.status, r.stderr).toBe(0);
    const names = r.data!.symbols.map((s) => s.name);
    for (const n of THE_THREE) expect(names, r.stdout).toContain(n);
    expect(r.data!.callPaths.some((p) => p.includes("ServeHTTP → handleHTTPRequest → Next"))).toBe(true);
    expect(r.data!.symbols.find((s) => s.name === "Next")!.snippet).toContain("c.handlers[c.index](c)");

    // The human format carries the same facts.
    const t = exploreViaCli(GIN_QUESTION);
    expect(t.status, t.stderr).toBe(0);
    for (const n of THE_THREE) expect(t.stdout).toContain(n);
    expect(t.stdout).toContain("ServeHTTP → handleHTTPRequest → Next");
    expect(t.stdout).toContain("gin.go:");
    expect(t.stdout).toMatch(/egr callers handleHTTPRequest/);
  });

  it("returns none of the three for an unrelated question [xspec531-cli-control]", () => {
    const r = exploreViaCli(UNRELATED_QUESTION, ["--json"]);
    expect(r.status, r.stderr).toBe(0);
    const names = r.data!.symbols.map((s) => s.name);
    expect(names).toContain("LoadConfig");
    for (const n of THE_THREE) expect(names, r.stdout).not.toContain(n);
  });

  it("keeps stdout within --max-chars in both formats and names what was left out [xspec531-cli-budget]", () => {
    for (const extra of [["--json"], []]) {
      const r = exploreViaCli(GIN_QUESTION, ["--max-chars", "800", ...extra]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.length, `${extra.join(" ")}\n${r.stdout}`).toBeLessThanOrEqual(800);
      expect(r.stdout).toMatch(/not expanded|notExpanded/i);
    }
  });

  it("never prints an empty list of names when the names do not fit, only how many are left out [xspec531-cli-empty-names]", () => {
    // 400 is the floor: the totals fit, the names do not. It used to print "symbols not listed:  (+5 more)".
    const r = exploreViaCli(GIN_QUESTION, ["--max-chars", "400"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.length, r.stdout).toBeLessThanOrEqual(400);
    expect(r.stdout, r.stdout).not.toMatch(/:\s+\(\+\d+ more\)/);
    expect(r.stdout, r.stdout).not.toMatch(/(listed|for|imports):\s*$/m);
    expect(r.stdout).toMatch(/\+\d+ more symbols not listed/);
  });

  it("scopes the seeds to --path, and says NO MATCH when nothing under it fits [xspec531-cli-path]", () => {
    const inScope = exploreViaCli("config environment", ["--json", "--path", "config.go"]);
    expect(inScope.status, inScope.stderr).toBe(0);
    expect(inScope.data!.symbols.map((s) => s.name)).toContain("readEnvironment");
    const outOfScope = exploreViaCli("config environment", ["--json", "--path", "context.go"]);
    expect(outOfScope.status, outOfScope.stderr).toBe(0);
    expect(outOfScope.data!.status).toBe("no-match");
  });

  it("rejects a bad --limit / --max-chars and a missing topic with a non-zero exit [xspec531-cli-bad-args]", () => {
    expect(exploreViaCli(GIN_QUESTION, ["--limit", "0"]).status).toBe(1);
    expect(exploreViaCli(GIN_QUESTION, ["--max-chars", "abc"]).status).toBe(1);
    const noTopic = runEgr(built.cli, ["explore"], { env: env(), cwd: work });
    expect(noTopic.status).toBe(1);
    expect(noTopic.stderr).toMatch(/explore requires a <topic>/);
  });
});

describe("XSPEC-531 R1: a snippet is only shown when the file still holds the symbol", () => {
  it("says the source is unavailable for a graph filled through index_code (no file on disk), instead of omitting it [xspec531-snippet-unavailable]", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egr-531-mem-"));
    const conn = GraphConnection.open(join(dir, "m.db"));
    try {
      await initSchema(conn);
      const server = createMcpServer(conn);
      const client = new Client({ name: "t", version: "0" });
      const [c, s] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(s), client.connect(c)]);
      await client.callTool({
        name: "index_code",
        arguments: { files: [{ path: "svc.ts", source: "export function renderInvoice(){ return formatTotal(); }\nexport function formatTotal(){ return 1; }" }] },
      });
      const res = (await client.callTool({ name: "explore", arguments: { topic: "where is the invoice rendered" } })) as ToolResult;
      expect(res.isError, res.content[0]!.text).not.toBe(true);
      const data = JSON.parse(res.content[0]!.text) as Explored;
      const sym = data.symbols.find((x) => x.name === "renderInvoice");
      expect(sym, res.content[0]!.text).toBeDefined();
      expect(sym!.snippet).toBeUndefined();
      expect(sym!.snippetNote).toMatch(/source file is not known|not available/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("withholds the snippet and says why when the file has changed since it was indexed [xspec531-stale-source]", () => {
    const stale = join(work, "stale");
    mkdirSync(stale);
    const file = join(stale, "billing.go");
    writeFileSync(file, "package billing\n\nfunc ChargeInvoice() int {\n\treturn 1\n}\n");
    const sdb = join(work, "stale.db");
    const e = env({ ENGRAM_DB: sdb });
    expect(runEgr(built.cli, ["index", stale], { env: e, cwd: work }).status).toBe(0);
    const fresh = runEgr(built.cli, ["explore", "charge invoice", "--json"], { env: e, cwd: work });
    expect((JSON.parse(fresh.stdout) as Explored).symbols[0]!.snippet).toContain("func ChargeInvoice()");
    // Twenty lines are inserted above: the line the graph recorded now holds something else.
    writeFileSync(file, "package billing\n" + "// note\n".repeat(20) + readFileSync(file, "utf8").split("\n").slice(1).join("\n"));
    const after = runEgr(built.cli, ["explore", "charge invoice", "--json"], { env: e, cwd: work });
    const sym = (JSON.parse(after.stdout) as Explored).symbols[0]!;
    expect(sym.snippet).toBeUndefined();
    expect(sym.snippetNote).toMatch(/changed since it was indexed/i);
  });
});

describe("XSPEC-531 R1: the sentence is cut into words the way names are written", () => {
  it("drops stop words and splits camelCase, snake_case and runs of capitals [xspec531-keywords]", () => {
    expect(keywordsOf(GIN_QUESTION)).toEqual(["route", "requests", "middleware", "chain"]);
    expect(keywordsOf("where is handleHTTPRequest called")).toEqual(["handle", "http", "request", "called"]);
    expect(keywordsOf("parse_user_name")).toEqual(["parse", "user", "name"]);
    // Plural / tense / trailing e must not stop a question word from meeting a name.
    expect(stemsMatch(keywordStems("routing")[0]!, nameStems("Router")[0]!)).toBe(true);
    expect(stemsMatch(keywordStems("configuration")[0]!, nameStems("LoadConfig")[1]!)).toBe(true);
    expect(stemsMatch("use", nameStems("because")[0]!)).toBe(false);
    expect(nameStems("handleHTTPRequest")).toEqual(["handl", "http", "request"]);
    expect(nameStems("ServeHTTP")).toEqual(["serv", "http"]);
    expect(keywordsOf("how does it work")).toEqual([]);
  });
});
