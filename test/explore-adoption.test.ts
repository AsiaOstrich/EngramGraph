// SPDX-License-Identifier: MIT
// implements XSPEC-531
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { createMcpServer, ALWAYS_LOAD_ENV } from "../src/mcp/server.js";
import { isTestPath, isToolingPath, noiseOf } from "../src/code-graph/explore.js";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * Adopting `explore` (XSPEC-531 follow-up), after replaying real questions on gin and excalidraw:
 *
 *  - Ranking: the answer's room went to test functions (gin: 7 of 12) and to generic names / build config files
 *    (excalidraw: `has`, `save`, `error`, `config`) instead of the code the question was about.
 *  - Instructions: the server tells every client, at `initialize`, which tool to start with for which kind of question.
 *  - alwaysLoad: `explore` is loaded at the start of a conversation only when the user turns that on.
 *
 * Every case goes through the BUILT entry points (the stdio MCP server and the `egr` CLI, as child processes, on a
 * graph that `egr index` built from the fixture below), and reads the effect back from what they return. The helper
 * tables at the bottom pin the path rules but are not the proof of the feature.
 */

// A small router: the code the questions are about.
const SERVER_GO = `package srv

type Router struct {
	routes map[string]func(string) string
}

func (r *Router) ServeHTTP(path string) string {
	if !has(r.routes, path) {
		return notFound(path)
	}
	return r.handleRoute(path)
}

func (r *Router) handleRoute(path string) string {
	handler := r.lookupRoute(path)
	save(path)
	return handler(path)
}

func (r *Router) lookupRoute(path string) func(string) string {
	if has(r.routes, path) {
		return r.routes[path]
	}
	return nil
}

func notFound(path string) string {
	save(path)
	return "404"
}
`;

// The two generic helpers every function above calls: the "has" and "save" of the excalidraw replay.
const UTIL_GO = `package srv

func has(m map[string]func(string) string, k string) bool {
	_, ok := m[k]
	return ok
}

func save(path string) {
	_ = path
}
`;

// Test code that repeats the words of the feature it tests (the gin replay): the names carry MORE of the question's
// words than the code does.
const SERVER_TEST_GO = `package srv

import "testing"

func TestRouterHandleRouteRequest(t *testing.T) {
	r := &Router{}
	r.handleRoute("/x")
	r.ServeHTTP("/x")
}

func TestLookupRouteRequest(t *testing.T) {
	r := &Router{}
	r.lookupRoute("/x")
	testHelperRouteRequest()
}

func testHelperRouteRequest() {
	save("/x")
}
`;

const SPEC_JS = `export function handleRouteRequestSpec() {
  return 1;
}
`;

// Build tooling that is named after the topic: its names carry the question's words, its file is not the answer.
const VITE_CONFIG_JS = `export function routeRequestPlugin() {
  return handleRouteHook();
}

function handleRouteHook() {
  return 1;
}
`;

const QUESTION = "how does the router handle a request for a route";
const TEST_NAMES = ["TestRouterHandleRouteRequest", "TestLookupRouteRequest", "testHelperRouteRequest", "handleRouteRequestSpec"];
const NOISE_NAMES = ["has", "save", "routeRequestPlugin", "handleRouteHook"];
const CODE_NAMES = ["handleRoute", "lookupRoute", "ServeHTTP"];

let work: string;
let proj: string;
let db: string;
let built: BuiltEgr;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, ENGRAM_DB: db, ...extra };
  if (!("ENGRAM_MCP_ALWAYS_LOAD" in extra)) delete e.ENGRAM_MCP_ALWAYS_LOAD;
  return e;
}

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-adopt-"));
  proj = join(work, "srv");
  mkdirSync(join(proj, "__tests__"), { recursive: true });
  writeFileSync(join(proj, "server.go"), SERVER_GO);
  writeFileSync(join(proj, "util.go"), UTIL_GO);
  writeFileSync(join(proj, "server_test.go"), SERVER_TEST_GO);
  writeFileSync(join(proj, "__tests__", "router.js"), SPEC_JS);
  writeFileSync(join(proj, "vite.config.js"), VITE_CONFIG_JS);
  db = join(work, "g.db");
  const r = runEgr(built.cli, ["index", proj], { env: env(), cwd: work });
  if (r.status !== 0) throw new Error(`fixture index failed: ${r.stderr}`);
}, 120_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

async function connect(extraEnv: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [built.mcp],
      cwd: work,
      env: env(extraEnv) as Record<string, string>,
      stderr: "ignore",
    }),
  );
  return client;
}

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

interface Explored {
  status: string;
  truncated: boolean;
  note?: string;
  testsLeftOut?: number;
  symbols: Array<{ name: string; kind: string; file: string; role: string; rank: number; noise?: string }>;
  next: string[];
  notExpanded?: { symbols: string[]; symbolsTotal: number };
  message?: string;
}

async function exploreViaMcp(args: Record<string, unknown>): Promise<{ raw: string; data: Explored }> {
  const client = await connect();
  try {
    const res = (await client.callTool({ name: "explore", arguments: args })) as ToolResult;
    const raw = res.content[0]!.text;
    expect(res.isError, raw).not.toBe(true);
    return { raw, data: JSON.parse(raw) as Explored };
  } finally {
    await client.close();
  }
}

const names = (d: Explored): string[] => d.symbols.map((s) => s.name);

describe("explore ranking: test code is left out of the answer unless asked for", () => {
  it("leaves test functions out of the listed symbols, the call paths and `next`, and says how many it left out [explore-adopt-tests-left-out]", async () => {
    const { raw, data } = await exploreViaMcp({ topic: QUESTION, limit: 50, maxChars: 30000 });
    // The code the question is about is there...
    for (const n of CODE_NAMES) expect(names(data), raw).toContain(n);
    // ...and none of the test functions is, nor anything from a test file.
    for (const n of TEST_NAMES) expect(names(data), raw).not.toContain(n);
    for (const s of data.symbols) expect(isTestPath(s.file), `${s.name} is from ${s.file}`).toBe(false);
    expect(raw).not.toContain("server_test.go");
    for (const n of data.next) expect(TEST_NAMES.some((t) => n.includes(t)), n).toBe(false);
    // Not silent: the count is in the answer and the note names the switch.
    expect(data.testsLeftOut, raw).toBeGreaterThanOrEqual(3);
    expect(data.note).toMatch(/pass `includeTests: true` to list them/);
    // The note says what a snippet is, and that it is not the whole file.
    expect(data.note).toMatch(/starting at that line \(up to 40 lines/);
    expect(data.note).toMatch(/not the whole file/);
    expect(data.note).not.toMatch(/same as opening the file/);
  });

  it("lists the test functions again with includeTests, and `next` still never recommends one [explore-adopt-include-tests]", async () => {
    const { raw, data } = await exploreViaMcp({ topic: QUESTION, limit: 50, maxChars: 30000, includeTests: true });
    for (const n of [...TEST_NAMES, ...CODE_NAMES]) expect(names(data), raw).toContain(n);
    expect(data.testsLeftOut, raw).toBeUndefined();
    // The switch is exercised: a test function is among the top three, so `next` without the filter would have named it.
    const topThree = names(data).slice(0, 3);
    expect(topThree.some((n) => TEST_NAMES.includes(n)), `top three: ${topThree.join(", ")}`).toBe(true);
    expect(data.next.length).toBeGreaterThan(0);
    for (const n of data.next) {
      expect(TEST_NAMES.some((t) => n.includes(t)), n).toBe(false);
      expect(NOISE_NAMES.some((t) => new RegExp(`"symbol": "${t}"`).test(n)), n).toBe(false);
    }
  });

  it("says so when only test code matched, instead of answering no match as if nothing existed [explore-adopt-only-tests]", async () => {
    const { raw, data } = await exploreViaMcp({ topic: "spec helper", path: "__tests__" });
    expect(data.status, raw).toBe("no-match");
    expect(data.testsLeftOut, raw).toBeGreaterThanOrEqual(1);
    expect(data.message).toMatch(/includeTests/);
    const again = await exploreViaMcp({ topic: "route request spec", path: "__tests__", includeTests: true });
    expect(again.data.status).toBe("ok");
    expect(names(again.data)).toContain("handleRouteRequestSpec");
  });

  it("is reachable from the CLI as --include-tests, with the same effect [explore-adopt-cli-flag]", () => {
    const off = runEgr(built.cli, ["explore", QUESTION, "--limit", "50", "--max-chars", "30000", "--json"], { env: env(), cwd: work });
    expect(off.status, off.stderr).toBe(0);
    expect(names(JSON.parse(off.stdout) as Explored)).not.toContain("TestRouterHandleRouteRequest");
    const on = runEgr(built.cli, ["explore", QUESTION, "--limit", "50", "--max-chars", "30000", "--include-tests", "--json"], { env: env(), cwd: work });
    expect(on.status, on.stderr).toBe(0);
    expect(names(JSON.parse(on.stdout) as Explored)).toContain("TestRouterHandleRouteRequest");
    // The text form carries the reading note too, and its hint spells the switch the way the CLI takes it.
    const text = runEgr(built.cli, ["explore", QUESTION, "--limit", "50", "--max-chars", "30000"], { env: env(), cwd: work });
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/Each snippet is the file's own text starting at that line/);
    expect(text.stdout).toMatch(/pass `--include-tests` to list them/);
    expect(text.stdout).not.toMatch(/pass `?includeTests/);
    // So does the message of an answer where only test code matched.
    const onlyTests = runEgr(built.cli, ["explore", "spec helper", "--path", "__tests__"], { env: env(), cwd: work });
    expect(onlyTests.status, onlyTests.stderr).toBe(0);
    expect(onlyTests.stdout).toMatch(/unless `--include-tests` is set/);
    expect(onlyTests.stdout).not.toMatch(/`includeTests`/);
  });
});

describe("explore ranking: generic names and build config files rank below the code the question is about", () => {
  it("does not list `has`, `save` or the vite.config.js plugin when the code that matters fills the list [explore-adopt-noise-pushed-down]", async () => {
    const { raw, data } = await exploreViaMcp({ topic: QUESTION, limit: 4, maxChars: 30000 });
    for (const n of NOISE_NAMES) expect(names(data), raw).not.toContain(n);
    expect(names(data)).toEqual(expect.arrayContaining(["handleRoute", "lookupRoute"]));
  });

  it("still lists them when there is room, after every ordinary symbol, marked with why [explore-adopt-noise-marked]", async () => {
    const { raw, data } = await exploreViaMcp({ topic: QUESTION, limit: 50, maxChars: 30000 });
    const noisy = data.symbols.filter((s) => s.noise);
    expect(noisy.map((s) => s.name).sort(), raw).toEqual([...NOISE_NAMES].sort());
    expect(data.symbols.find((s) => s.name === "has")!.noise).toBe("generic-name");
    expect(data.symbols.find((s) => s.name === "routeRequestPlugin")!.noise).toBe("build-tooling");
    // (A class is listed after the functions by design, whatever its rank; the order that matters is among functions.)
    const fns = data.symbols.filter((s) => s.kind === "Function");
    const lastOrdinary = Math.max(...fns.map((s, i) => (s.noise ? -1 : i)));
    const firstNoise = Math.min(...fns.map((s, i) => (s.noise ? i : Infinity)));
    expect(firstNoise, `ordinary symbols end at ${lastOrdinary}, noise starts at ${firstNoise}`).toBeGreaterThan(lastOrdinary);
    for (const n of data.next) expect(NOISE_NAMES.some((t) => new RegExp(`"symbol": "${t}"`).test(n)), n).toBe(false);
  });

  it("does not push build files down when the question is about the build [explore-adopt-tooling-topic]", async () => {
    const { raw, data } = await exploreViaMcp({ topic: "vite config route request plugin", limit: 50, maxChars: 30000 });
    const plugin = data.symbols.find((s) => s.name === "routeRequestPlugin");
    expect(plugin, raw).toBeDefined();
    expect(plugin!.noise).toBeUndefined();
  });
});

describe("explore instructions: every server says at initialize which tool to start with", () => {
  const ROUTES: Array<[string, string]> = [
    ["explore", "how does X work"],
    ["call_chain", "Who calls"],
    ["implemented_specs", "Which spec constrains"],
    ["refs_check", "documents still match the code"],
  ];

  function expectRouting(text: string): void {
    // Each kind of question and its tool are on the same line: a table whose rows are shuffled would still contain every word.
    const lines = text.split("\n");
    for (const [tool, when] of ROUTES) {
      const row = lines.find((l) => l.toLowerCase().includes(when.toLowerCase()));
      expect(row, `no line for "${when}"`).toBeDefined();
      expect(row, `"${when}" does not point at ${tool}`).toContain(`\`${tool}\``);
    }
    // Out-of-date index: both self-checks are named.
    expect(text).toContain("doctor");
    expect(text).toContain("blindspots");
    expect(text.length).toBeLessThan(2500); // a few hundred words, not a manual
  }

  it("the read-only stdio server sends the question-to-tool table AND still names the terminal commands [explore-adopt-instructions-stdio]", async () => {
    const client = await connect();
    try {
      const text = client.getInstructions() ?? "";
      expectRouting(text);
      expect(text).toContain("egr index <dir>"); // the XSPEC-481 sentence is not replaced
      const tools = (await client.listTools()).tools.map((t) => t.name);
      // Every tool the table points at is one this server really lists.
      for (const [tool] of ROUTES) expect(tools, tool).toContain(tool);
      for (const tool of ["doctor", "blindspots", "implementers", "impact_analysis", "cochange"]) expect(tools, tool).toContain(tool);
    } finally {
      await client.close();
    }
  });

  it("a writable server sends the table too, without the read-only paragraph [explore-adopt-instructions-writable]", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egr-adopt-mem-"));
    const conn = GraphConnection.open(join(dir, "m.db"));
    try {
      await initSchema(conn);
      const server = createMcpServer(conn);
      const client = new Client({ name: "t", version: "0" });
      const [c, s] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(s), client.connect(c)]);
      const text = client.getInstructions() ?? "";
      expectRouting(text);
      expect(text).not.toContain("only reads the graph");
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("index_code");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("explore alwaysLoad: explore is loaded at the start of a conversation only when the setting says so", () => {
  type ListedTool = { name: string; _meta?: Record<string, unknown> };

  async function listed(extraEnv: Record<string, string>): Promise<ListedTool[]> {
    const client = await connect(extraEnv);
    try {
      return (await client.listTools()).tools as ListedTool[];
    } finally {
      await client.close();
    }
  }

  it("a default server lists explore with no alwaysLoad marker [explore-adopt-always-load-off]", async () => {
    const tools = await listed({});
    const explore = tools.find((t) => t.name === "explore")!;
    expect(explore).toBeDefined();
    expect(explore._meta?.["anthropic/alwaysLoad"]).toBeUndefined();
    expect(JSON.stringify(tools)).not.toContain("alwaysLoad");
  });

  it("with ENGRAM_MCP_ALWAYS_LOAD=explore, explore (and only explore) carries `anthropic/alwaysLoad: true` [explore-adopt-always-load-on]", async () => {
    expect(ALWAYS_LOAD_ENV).toBe("ENGRAM_MCP_ALWAYS_LOAD");
    const tools = await listed({ ENGRAM_MCP_ALWAYS_LOAD: "explore" });
    const explore = tools.find((t) => t.name === "explore")!;
    expect(explore._meta?.["anthropic/alwaysLoad"]).toBe(true);
    for (const t of tools.filter((x) => x.name !== "explore")) expect(t._meta?.["anthropic/alwaysLoad"], t.name).toBeUndefined();
  });

  it("an empty or unrelated value leaves it off, and a list or different case still turns it on [explore-adopt-always-load-parse]", async () => {
    for (const off of ["", "call_chain", "   "]) {
      const explore = (await listed({ ENGRAM_MCP_ALWAYS_LOAD: off })).find((t) => t.name === "explore")!;
      expect(explore._meta?.["anthropic/alwaysLoad"], `value "${off}"`).toBeUndefined();
    }
    const explore = (await listed({ ENGRAM_MCP_ALWAYS_LOAD: "call_chain, Explore" })).find((t) => t.name === "explore")!;
    expect(explore._meta?.["anthropic/alwaysLoad"]).toBe(true);
  });
});

describe("the path and name rules (what the cases above rely on)", () => {
  it("recognises test code by file name and by directory [explore-adopt-test-path-rules]", () => {
    for (const f of [
      "gin_test.go",
      "routes/handler_test.go",
      "src/a.test.ts",
      "src/a.spec.tsx",
      "src/__tests__/a.ts",
      "packages/x/tests/a.ts",
      "test/a.js",
      "pkg/test_util.py",
      "app/models_spec.rb",
      "src/main/FooTest.java",
    ]) expect(isTestPath(f), f).toBe(true);
    for (const f of ["gin.go", "src/latest/a.ts", "src/contest.go", "src/attest.ts", "src/testing.ts", "src/protest/x.go", "lib/spec.ts"]) {
      expect(isTestPath(f), f).toBe(false);
    }
  });

  it("recognises build/tool config files and not code that merely contains the word [explore-adopt-tooling-path-rules]", () => {
    for (const f of ["vite.config.ts", "scripts/woff2/woff2-vite-plugins.js", "eslint.config.mjs", "webpack.config.js", "app.config.json", "scripts/build.ts"]) {
      expect(isToolingPath(f), f).toBe(true);
    }
    for (const f of ["src/invite.ts", "src/descriptions/x.ts", "src/renderer/staticScene.ts", "src/configuration.ts"]) expect(isToolingPath(f), f).toBe(false);
  });

  it("calls a generic name noise unless the file path carries a word of the topic, and keeps `Use` and `Next` out of it [explore-adopt-noise-rules]", () => {
    expect(noiseOf("has", "data/EditorLocalStorage.ts", ["render", "scene"])).toBe("generic-name");
    expect(noiseOf("save", "data/LocalData.ts", ["render"])).toBe("generic-name");
    expect(noiseOf("save", "scene/save.ts", ["save", "scene"])).toBeUndefined();
    expect(noiseOf("Use", "gin.go", ["middlewar"])).toBeUndefined();
    expect(noiseOf("Next", "context.go", ["next"])).toBeUndefined();
    expect(noiseOf("config", "woff2-vite-plugins.js", ["render"])).toBe("build-tooling");
    expect(noiseOf("loadPlugin", "vite.config.ts", ["render"])).toBe("build-tooling");
    expect(noiseOf("loadPlugin", "vite.config.ts", ["vite", "plugin"])).toBeUndefined();
  });
});
