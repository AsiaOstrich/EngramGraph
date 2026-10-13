// SPDX-License-Identifier: MIT
// implements XSPEC-481
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { isReadOnlyRefusal } from "../src/mcp/read-only-refusal.mjs";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * XSPEC-481 R3 — the stdio MCP server lists only what it can do.
 *
 * The beta.4 report: `tools/list` returned 12 tools, and four of them — `index_code`, `index_docs`,
 * `ingest_feedback`, `related` — answered every call with a read-only refusal. An assistant calls what it
 * finds in the list, so the first thing it tried was a tool that could not work.
 *
 * Everything here goes through the built stdio server as a child process and a real MCP client: what
 * `tools/list` returns, and then every listed tool CALLED, with arguments that point at things that exist, so
 * that "not a refusal" is not satisfied by an error of another kind.
 */

const READ_ONLY_TOOLS = ["blindspots", "call_chain", "doctor", "impact_analysis", "implemented_specs", "implementers", "refs_check", "signatures"];
const WRITING_TOOLS = ["index_code", "index_docs", "ingest_feedback", "related"];

let built: BuiltEgr;
let work: string;
let db: string;
let note: string;

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-481-r3-"));
  db = join(work, "r3.db");
  const proj = join(work, "proj");
  mkdirSync(proj);
  writeFileSync(join(proj, "a.ts"), "// implements XSPEC-7\nexport function alpha() { return beta(); }\nexport function beta() { return 1; }\n");
  writeFileSync(join(proj, "XSPEC-7.md"), "---\nid: XSPEC-7\ntitle: The spec\n---\n# XSPEC-7\nbody\n");
  const r = runEgr(built.cli, ["index", proj, "--docs"], { env: { ...process.env, ENGRAM_DB: db }, cwd: work });
  if (r.status !== 0) throw new Error(`fixture index failed: ${r.stderr}`);
  note = join(work, "note.md");
  writeFileSync(note, "Calls `alpha()` in `a.ts`.\n");
}, 120_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

async function connect(args: string[]): Promise<Client> {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args, cwd: work, env: { ...process.env, ENGRAM_DB: db } as Record<string, string>, stderr: "ignore" }),
  );
  return client;
}

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

describe("XSPEC-481 R3: tools/list of the read-only stdio server", () => {
  it("lists the eight tools that work and none of the four that cannot, over egr-mcp and over egr mcp [xspec481-r3-list]", async () => {
    for (const args of [[built.mcp], [built.cli, "mcp"]]) {
      const client = await connect(args);
      try {
        const names = (await client.listTools()).tools.map((t) => t.name).sort();
        expect(names, args.join(" ")).toEqual(READ_ONLY_TOOLS);
        for (const w of WRITING_TOOLS) expect(names).not.toContain(w);
      } finally {
        await client.close();
      }
    }
  });

  it("every listed tool, called with arguments that exist in the graph, answers without a read-only refusal and without an error [xspec481-r3-every-listed-tool-works]", async () => {
    const calls: Record<string, Record<string, unknown>> = {
      blindspots: {},
      call_chain: { symbol: "alpha", direction: "callees" },
      doctor: {},
      impact_analysis: { nodeId: "XSPEC-7" },
      implemented_specs: { moduleId: "a.ts" },
      implementers: { specId: "XSPEC-7" },
      refs_check: { paths: [note] },
      signatures: {},
    };
    const client = await connect([built.mcp]);
    try {
      const listed = (await client.listTools()).tools.map((t) => t.name);
      expect([...listed].sort()).toEqual(Object.keys(calls).sort()); // the table above covers exactly what is listed
      for (const name of listed) {
        const res = (await client.callTool({ name, arguments: calls[name]! })) as ToolResult;
        expect(isReadOnlyRefusal(res), `${name}: ${JSON.stringify(res)}`).toBe(false);
        expect(res.isError, `${name}: ${JSON.stringify(res)}`).not.toBe(true);
        // Read back: the answer is about this graph, not an empty shell.
        if (name === "call_chain") expect(res.content[0]!.text).toContain("beta");
        if (name === "implementers") expect(res.content[0]!.text).toContain("a.ts");
      }
    } finally {
      await client.close();
    }
  });

  it("an unlisted writing tool is not found when called, writes nothing, and the server's instructions say which egr command does the job [xspec481-r3-unlisted-not-callable]", async () => {
    const client = await connect([built.mcp]);
    try {
      const instructions = client.getInstructions() ?? "";
      for (const cmd of ["egr index <dir>", "egr index <dir> --docs", "egr feedback <type> <node-id>", "egr related <seed-id>"]) {
        expect(instructions, cmd).toContain(cmd);
      }
      const res = (await client.callTool({
        name: "index_code",
        arguments: { files: [{ path: "injected.ts", source: "export function injectedByMcp() {}" }] },
      })) as ToolResult;
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(/not found/i);
    } finally {
      await client.close();
    }
    // Read back through the CLI: nothing was written.
    const top = runEgr(built.cli, ["top", "Function", "--limit", "50"], { env: { ...process.env, ENGRAM_DB: db }, cwd: work });
    expect(top.status, top.stderr).toBe(0);
    expect(top.stdout).toContain("alpha");
    expect(top.stdout).not.toContain("injectedByMcp");
  });
});
