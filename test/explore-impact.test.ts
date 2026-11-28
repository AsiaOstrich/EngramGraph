// SPDX-License-Identifier: MIT
// implements XSPEC-531
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * `explore` carries "who is affected if you change this" (EGR 0.17, dev-platform #266 / decision 587丁).
 *
 * Why it is part of `explore` and not a tool of its own: in the 587丙 replay (16 runs) the assistant called `explore`
 * once per run and never went on to `call_chain`. What it needs to know before it edits a function therefore has to
 * be in the one answer it reads.
 *
 * Every case goes through a BUILT entry point (the stdio MCP server with a real client, the `egr` CLI as a child
 * process) on a graph `egr index` built from the same small Go project shaped like gin's request path that
 * `xspec531-explore.test.ts` uses, plus two test files. The test files are what makes the "affected tests" part
 * checkable: they are real files on disk and the test reads the answer's file and line back from them.
 */

const GIN_QUESTION = "how does it route requests through its middleware chain";

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

// Test files. `performRequest` is a helper that is itself in a test file: TestRoutingGoesThroughHelper reaches
// `Next` only through it (test -> helper -> ServeHTTP -> handleHTTPRequest -> Next), which is the "tests that
// the call chain can reach" part, not just direct callers.
const GIN_TEST_GO = `package gin

import "testing"

func performRequest(e *Engine) {
	e.ServeHTTP(nil, nil)
}

func TestEngineServeRunsMiddleware(t *testing.T) {
	e := New()
	e.Use(func(c *Context) {})
	e.ServeHTTP(nil, nil)
}

func TestRoutingGoesThroughHelper(t *testing.T) {
	performRequest(New())
}
`;

const CONTEXT_TEST_GO = `package gin

import "testing"

func TestContextNextWalksHandlers(t *testing.T) {
	c := &Context{}
	c.Next()
}
`;

// Seven tests that call `lookup` themselves: more than one section lists, so the list is cut and says where the full one is.
const LOOKUP_TEST_GO = `package gin

import "testing"

${[1, 2, 3, 4, 5, 6, 7].map((n) => `func TestLookupCase${n}(t *testing.T) {\n\te := New()\n\te.lookup("/case${n}")\n}\n`).join("\n")}`;

let work: string;
let proj: string;
let db: string;
let built: BuiltEgr;

function env(): NodeJS.ProcessEnv {
  return { ...process.env, ENGRAM_DB: db };
}

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-impact-"));
  proj = join(work, "gin");
  mkdirSync(proj);
  writeFileSync(join(proj, "gin.go"), GIN_GO);
  writeFileSync(join(proj, "context.go"), CONTEXT_GO);
  writeFileSync(join(proj, "gin_test.go"), GIN_TEST_GO);
  writeFileSync(join(proj, "context_test.go"), CONTEXT_TEST_GO);
  writeFileSync(join(proj, "lookup_test.go"), LOOKUP_TEST_GO);
  db = join(work, "g.db");
  const r = runEgr(built.cli, ["index", proj], { env: env(), cwd: work });
  if (r.status !== 0) throw new Error(`fixture index failed: ${r.stderr}`);
}, 120_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

interface Impact {
  callers: string[];
  callersTotal: number;
  tests: string[];
  testsTotal: number;
  fullList?: string;
}
interface Ref {
  name: string;
  file: string;
  line?: number;
}

/** An impact entry is written `name (file:line)`; this reads it back. */
function parseRef(entry: string): Ref {
  const m = /^(.+) \((.+?)(?::(\d+))?\)$/.exec(entry);
  expect(m, `not of the form "name (file:line)": ${entry}`).not.toBeNull();
  return { name: m![1]!, file: m![2]!, ...(m![3] ? { line: Number(m![3]) } : {}) };
}
interface Explored {
  status: string;
  truncated: boolean;
  maxChars: number;
  symbols: Array<{ name: string; kind: string; file: string; line?: number; role: string; snippet?: string; impact?: Impact }>;
  next: string[];
  notExpanded?: { symbols: string[]; symbolsTotal: number; snippets: string[]; snippetsTotal: number; impact?: string[]; impactTotal?: number; impactFullList?: string };
}

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

async function exploreViaMcp(args: Record<string, unknown>): Promise<{ raw: string; data: Explored }> {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [built.mcp], cwd: work, env: env() as Record<string, string>, stderr: "ignore" }),
  );
  try {
    const res = (await client.callTool({ name: "explore", arguments: args })) as ToolResult;
    const raw = res.content[0]!.text;
    expect(res.isError, raw).not.toBe(true);
    return { raw, data: JSON.parse(raw) as Explored };
  } finally {
    await client.close();
  }
}

function exploreViaCli(extra: string[] = []): { stdout: string; stderr: string; status: number | null; data?: Explored } {
  const r = runEgr(built.cli, ["explore", GIN_QUESTION, ...extra], { env: env(), cwd: work });
  return { ...r, data: extra.includes("--json") && r.status === 0 ? (JSON.parse(r.stdout) as Explored) : undefined };
}

/** The 1-based line on which `needle` first appears in a fixture file as it is on disk. */
function lineOnDisk(file: string, needle: string): number {
  const lines = readFileSync(join(proj, file), "utf8").split("\n");
  const at = lines.findIndex((l) => l.includes(needle));
  expect(at, `${needle} not in ${file}`).toBeGreaterThanOrEqual(0);
  return at + 1;
}

/**
 * What every case below needs from an answer: the impact of `handleHTTPRequest` (always among the first two symbols),
 * read back and checked against the files on disk. Its one caller is ServeHTTP; the tests reach it through ServeHTTP.
 */
function checkHandleImpact(data: Explored, context: string): void {
  expect(data.status, context).toBe("ok");
  const sym = data.symbols.find((s) => s.name === "handleHTTPRequest");
  expect(sym, `handleHTTPRequest is listed. ${context}`).toBeDefined();
  expect(sym!.impact, `handleHTTPRequest carries an impact section. ${context}`).toBeDefined();
  const callers = sym!.impact!.callers.map(parseRef);
  const tests = sym!.impact!.tests.map(parseRef);
  // Direct caller: ServeHTTP, at the file and line where it is defined (not a test).
  const serve = callers.find((c) => c.name === "ServeHTTP");
  expect(serve, `callers: ${JSON.stringify(callers)}`).toBeDefined();
  expect(serve!.file).toBe("gin.go");
  expect(serve!.line).toBe(lineOnDisk("gin.go", "func (engine *Engine) ServeHTTP"));
  expect(callers.every((c) => !c.file.endsWith("_test.go")), "tests are listed under tests, not callers").toBe(true);
  // Affected tests: real test functions in a real test file, each at the line the file holds it, reached through
  // ServeHTTP (one directly, one through a helper that is itself in a test file).
  for (const name of ["TestEngineServeRunsMiddleware", "TestRoutingGoesThroughHelper"]) {
    const t = tests.find((x) => x.name === name);
    expect(t, `tests: ${JSON.stringify(tests)}`).toBeDefined();
    expect(t!.file).toBe("gin_test.go");
    expect(t!.line).toBe(lineOnDisk("gin_test.go", `func ${name}(`));
  }
  // The count is the real count, not the length of what was shown.
  expect(sym!.impact!.testsTotal).toBeGreaterThanOrEqual(tests.length);
  expect(sym!.impact!.callersTotal).toBeGreaterThanOrEqual(callers.length);
  // Test code is still kept out of the SYMBOLS of the answer (includeTests is off): the impact section is the one
  // place tests appear, and that is the point.
  expect(data.symbols.filter((s) => s.file.endsWith("_test.go")), context).toEqual([]);
}

/** `Next`, the other symbol the task names: a direct test in another file plus the callers above. Only checked where the budget has room for five sections. */
function checkNextImpact(data: Explored, context: string): void {
  const next = data.symbols.find((s) => s.name === "Next");
  expect(next?.impact, `Next carries an impact section. ${context}`).toBeDefined();
  expect(next!.impact!.callers.map(parseRef).map((c) => c.name), context).toContain("handleHTTPRequest");
  const direct = next!.impact!.tests.map(parseRef).find((t) => t.name === "TestContextNextWalksHandlers");
  expect(direct, `tests: ${JSON.stringify(next!.impact!.tests)}`).toBeDefined();
  expect(direct!.file).toBe("context_test.go");
  expect(direct!.line).toBe(lineOnDisk("context_test.go", "func TestContextNextWalksHandlers"));
}

describe("explore carries 'who is affected if you change this' (#266)", () => {
  it("stdio MCP: a main symbol lists its callers with file and line and the tests that reach it, within maxChars [explore-impact-mcp]", async () => {
    const { raw, data } = await exploreViaMcp({ topic: GIN_QUESTION });
    checkHandleImpact(data, raw);
    expect(raw.length).toBeLessThanOrEqual(6000);
    expect(data.maxChars).toBe(6000);
    // The 2-hop reach: a test that only reaches ServeHTTP through a helper in a test file is listed for ServeHTTP too.
    const serve = data.symbols.find((s) => s.name === "ServeHTTP");
    expect(serve!.impact!.tests.map((t) => parseRef(t).name), raw).toContain("TestRoutingGoesThroughHelper");
  });

  it("CLI --json: the same impact, read back from a child process [explore-impact-cli-json]", () => {
    const r = exploreViaCli(["--json"]);
    expect(r.status, r.stderr).toBe(0);
    checkHandleImpact(r.data!, r.stdout);
    expect(r.stdout.length).toBeLessThanOrEqual(6000);
  });

  it("CLI text: the printed answer has an Impact block that names callers and tests with file:line [explore-impact-cli-text]", () => {
    const r = exploreViaCli();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Impact/);
    expect(r.stdout).toContain(`callers: ServeHTTP (gin.go:${lineOnDisk("gin.go", "func (engine *Engine) ServeHTTP")})`);
    expect(r.stdout).toContain(`TestEngineServeRunsMiddleware (gin_test.go:${lineOnDisk("gin_test.go", "func TestEngineServeRunsMiddleware")})`);
    expect(r.stdout.length).toBeLessThanOrEqual(6000);
  });

  it("a list longer than the cap is cut, says how many more there are, and names the point query with the full list [explore-impact-cut-list]", async () => {
    const { raw, data } = await exploreViaMcp({ topic: GIN_QUESTION, maxChars: 30000 });
    const lookup = data.symbols.find((s) => s.name === "lookup");
    expect(lookup?.impact, raw).toBeDefined();
    const im = lookup!.impact!;
    expect(im.testsTotal, raw).toBeGreaterThanOrEqual(8); // 7 direct + the two that go through ServeHTTP
    expect(im.tests.length, raw).toBeLessThan(im.testsTotal);
    // The tests that call it themselves are the ones kept when the list is cut.
    expect(im.tests.every((t) => parseRef(t).file === "lookup_test.go"), JSON.stringify(im.tests)).toBe(true);
    expect(im.fullList, raw).toBe('call_chain {"symbol": "lookup", "file": "gin.go", "direction": "callers", "depth": 3}');
    // Whole entries only, and the file really holds each one at the line given.
    for (const t of im.tests) expect(parseRef(t).line, t).toBe(lineOnDisk("lookup_test.go", `func ${parseRef(t).name}(`));
    // A list that was not cut carries no pointer.
    const handle = data.symbols.find((s) => s.name === "handleHTTPRequest")!;
    expect(handle.impact!.fullList).toBeUndefined();
    const text = exploreViaCli(["--max-chars", "30000"]).stdout;
    expect(text).toMatch(/TestLookupCase\d \(lookup_test\.go:\d+\)(, TestLookupCase\d \(lookup_test\.go:\d+\))* \(\+\d+ more\)/);
    expect(text).toContain("full list: egr callers lookup --depth 3 --file gin.go");
  });

  it("includeTests lists test code among the symbols and the impact still names the tests, once each [explore-impact-include-tests]", async () => {
    const { raw, data } = await exploreViaMcp({ topic: GIN_QUESTION, maxChars: 30000, includeTests: true });
    expect(data.symbols.some((s) => s.file.endsWith("_test.go")), raw).toBe(true);
    const handle = data.symbols.find((s) => s.name === "handleHTTPRequest")!;
    expect(handle.impact!.tests.map((t) => parseRef(t).name), raw).toContain("TestEngineServeRunsMiddleware");
    // A test function is a symbol of this answer, never given an impact section of its own.
    expect(data.symbols.filter((s) => s.file.endsWith("_test.go") && s.impact !== undefined), raw).toEqual([]);
  });

  it("when maxChars is small the impact goes to the 'not expanded' list with the tool that has the full list, never cut mid-entry [explore-impact-budget]", async () => {
    for (const via of ["mcp", "cli-json", "cli-text"] as const) {
      const max = 1500;
      let text: string;
      let data: Explored;
      if (via === "mcp") {
        const a = await exploreViaMcp({ topic: GIN_QUESTION, maxChars: max });
        text = a.raw;
        data = a.data;
      } else {
        const r = exploreViaCli(via === "cli-json" ? ["--json", "--max-chars", String(max)] : ["--max-chars", String(max)]);
        expect(r.status, r.stderr).toBe(0);
        text = r.stdout;
        data = via === "cli-json" ? r.data! : (JSON.parse(exploreViaCli(["--json", "--max-chars", String(max)]).stdout) as Explored);
      }
      const ctx = `${via}\n${text}`;
      expect(text.length, ctx).toBeLessThanOrEqual(max);
      // An impact section is either whole or absent; a section that is there is complete (all four fields).
      for (const s of data.symbols) {
        if (s.impact === undefined) continue;
        expect(s.impact.callers, ctx).toBeInstanceOf(Array);
        expect(s.impact.tests, ctx).toBeInstanceOf(Array);
        expect(typeof s.impact.callersTotal, ctx).toBe("number");
        expect(typeof s.impact.testsTotal, ctx).toBe("number");
      }
      // What was left out is named, and the way to the full list is stated.
      expect(data.notExpanded?.impactTotal ?? 0, ctx).toBeGreaterThan(0);
      expect(data.notExpanded!.impact!.length, ctx).toBeGreaterThan(0);
      expect(data.truncated, ctx).toBe(true);
      // ...and the way to the full list is in the answer an MCP client or a script reads, not only in the printed text.
      expect(data.notExpanded!.impact, ctx).toContain("handleHTTPRequest");
      expect(data.notExpanded!.impactFullList, ctx).toBe('call_chain {"symbol": "<name>", "direction": "callers", "depth": 3}');
      if (via === "cli-text") {
        expect(text, ctx).toMatch(/impact left out for: .*handleHTTPRequest/);
        expect(text, ctx).toMatch(/egr callers <name> --depth 3/);
      }
    }
  });

  it("with room to spare every main symbol has its impact and nothing about it is left out [explore-impact-roomy]", async () => {
    const { raw, data } = await exploreViaMcp({ topic: GIN_QUESTION, maxChars: 30000 });
    expect(data.notExpanded?.impactTotal ?? 0, raw).toBe(0);
    expect(data.symbols.filter((s) => s.impact).length, raw).toBeGreaterThanOrEqual(5);
    checkHandleImpact(data, raw);
    checkNextImpact(data, raw);
  });
});
