// SPDX-License-Identifier: MIT
// implements XSPEC-514
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * XSPEC-514 R1 — `egr callers` (and `callees`) and the MCP tool `call_chain` when a name is shared by several
 * functions: the answer says how many definitions it combines and where they are, `--file` / `file` narrows it to
 * one definition, and a file with no such definition is an error rather than an empty list.
 *
 * Everything that proves it goes through the built entry points as a user meets them — the `egr` CLI as a child
 * process and the `egr-mcp` stdio server through a real MCP client — against a project this file writes and indexes
 * with `egr index`, and reads the printed answer back. No in-process shortcut is the proof.
 *
 * The child processes get a throw-away HOME, no global or system git config and none of the variables git exports to
 * a hook (`git rev-parse --local-env-vars`): the suite must not read the user's keychain-backed config or write into
 * the real repository when run from a hook.
 *
 * Fixture (CALLS bind to a same-file definition first, so each `render` has its own callers; `solo` is unique):
 *   a/render.ts   helperA, render (calls helperA), pageA (calls render), entryA (calls pageA)
 *   b/render.ts   helperB, render (calls helperB), pageB (calls render)
 *   c/multi.ts    two classes that both define `paint`, called from drawW / drawG   (same file, two definitions)
 *   solo.ts       solo        useSolo.ts   useSolo (calls solo)
 */

let built: BuiltEgr;
let work: string;
let proj: string;
let db: string;
let env: NodeJS.ProcessEnv;

function isolatedEnv(home: string): NodeJS.ProcessEnv {
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
    ENGRAM_DB: db,
  };
}

function put(rel: string, content: string): void {
  const full = join(proj, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const egr = (...args: string[]) => runEgr(built.cli, args, { env, cwd: work });

interface Row {
  id: string;
  name: string;
  file: string;
}
interface Merged {
  symbol: string;
  definitions: Array<{ id: string; file: string; startLine: number | null }>;
  mergedDefinitions: number;
  file?: string;
  callers?: Row[];
  callees?: Row[];
}
const names = (rows: Row[] | undefined) => (rows ?? []).map((r) => r.name).sort();

beforeAll(() => {
  built = buildEgr();
  work = realpathSync(mkdtempSync(join(tmpdir(), "egr-514r1-")));
  const home = join(work, "home");
  mkdirSync(home);
  proj = join(work, "proj");
  db = join(work, "g.db");
  env = isolatedEnv(home);

  put(
    "a/render.ts",
    [
      "export function helperA() { return 0; }",
      "export function render() { return helperA(); }",
      "export function pageA() { return render(); }",
      "export function entryA() { return pageA(); }",
      "",
    ].join("\n"),
  );
  put(
    "b/render.ts",
    ["export function helperB() { return 0; }", "export function render() { return helperB(); }", "export function pageB() { return render(); }", ""].join("\n"),
  );
  put(
    "c/multi.ts",
    [
      "export class Widget { paint() { return 1; } drawW() { return this.paint(); } }",
      "export class Gadget { paint() { return 2; } drawG() { return this.paint(); } }",
      "",
    ].join("\n"),
  );
  put("solo.ts", "export function solo() { return 1; }\n");
  put("useSolo.ts", 'import { solo } from "./solo";\nexport function useSolo() { return solo(); }\n');

  const r = egr("index", proj);
  if (r.status !== 0) throw new Error(`fixture index failed: ${r.stderr}`);
}, 180_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

describe("XSPEC-514 R1: egr callers on a name several functions share (CLI)", () => {
  it("lists both definitions and says the answer combines them, text and --json [xspec514-r1-ac1-cli]", () => {
    const text = egr("callers", "render");
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("merged");
    expect(text.stdout).toContain("defined 2 times");
    expect(text.stdout).toContain("a/render.ts:2");
    expect(text.stdout).toContain("b/render.ts:2");
    // both definitions' callers are in the one list — that is what the line above is a warning about
    expect(text.stdout).toContain("pageA (a/render.ts)");
    expect(text.stdout).toContain("pageB (b/render.ts)");

    // --json keeps the bare array every script already parses; the statement is on stderr, in the same words
    const json = egr("callers", "render", "--json");
    expect(json.status).toBe(0);
    const rows = JSON.parse(json.stdout) as Row[];
    expect(Array.isArray(rows)).toBe(true);
    expect(names(rows)).toEqual(["pageA", "pageB"]);
    expect(json.stderr).toContain("merged");
    expect(json.stderr).toContain("defined 2 times");
    expect(json.stderr).toContain("a/render.ts:2");
    expect(json.stderr).toContain("b/render.ts:2");
  });

  it("--file narrows the answer to that definition's callers, by exact id, by a unique ending, and by an absolute path [xspec514-r1-ac2-cli]", () => {
    for (const given of ["a/render.ts", "./a/render.ts", join(proj, "a", "render.ts")]) {
      const r = egr("callers", "render", "--file", given);
      expect(r.status, `--file ${given}: ${r.stderr}`).toBe(0);
      expect(r.stdout).toContain("pageA (a/render.ts)");
      expect(r.stdout).not.toContain("pageB");
      // an answer from one of several definitions says it is only that one
      expect(r.stdout).toContain('narrowed to the definition at a/render.ts:2 (1 of 2 definitions of "render")');
      expect(r.stdout).not.toContain("merged");
    }
    const b = egr("callers", "render", "--file", "b/render.ts");
    expect(b.stdout).toContain("pageB (b/render.ts)");
    expect(b.stdout).not.toContain("pageA");

    // --json: the bare array, holding only that definition's callers, and no merged statement on stderr
    const jr = egr("callers", "render", "--file", "a/render.ts", "--json");
    const j = JSON.parse(jr.stdout) as Row[];
    expect(Array.isArray(j)).toBe(true);
    expect(names(j)).toEqual(["pageA"]);
    expect(jr.stderr).toBe("");

    // --depth follows CALLS from that definition only: entryA reaches render through pageA; nothing of b's side does
    const deep = egr("callers", "render", "--file", "a/render.ts", "--depth", "2");
    expect(deep.stdout).toContain("entryA (a/render.ts)");
    expect(deep.stdout).toContain("pageA (a/render.ts)");
    expect(deep.stdout).not.toContain("pageB");
  });

  it("a --file with no such definition is an error that names where the symbol is defined, never (none) or an empty list [xspec514-r1-file-missing-cli]", () => {
    const r = egr("callers", "render", "--file", "nope/other.ts");
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain('"render" has no definition in "nope/other.ts"');
    expect(r.stderr).toContain("a/render.ts");
    expect(r.stderr).toContain("b/render.ts");

    // an existing file that does not define it is the same error
    const other = egr("callers", "render", "--file", "solo.ts");
    expect(other.status).toBe(1);
    expect(other.stdout).toBe("");
    expect(other.stderr).toContain('has no definition in "solo.ts"');

    const jsonMode = egr("callers", "render", "--file", "nope/other.ts", "--json");
    expect(jsonMode.status).toBe(1);
    expect(jsonMode.stdout).toBe("");
  });

  it("an ending that fits two definition files is refused and lists them; an unknown symbol is still not-in-graph [xspec514-r1-file-ambiguous-cli]", () => {
    const r = egr("callers", "render", "--file", "render.ts");
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain('"render.ts" is ambiguous for "render"');
    expect(r.stderr).toContain("a/render.ts");
    expect(r.stderr).toContain("b/render.ts");

    const unknown = egr("callers", "NoSuchFunctionXyz", "--file", "a/render.ts");
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/no function named "NoSuchFunctionXyz" is in the graph/);
  });

  it("a name with one definition prints exactly what it printed before: same text, same --json, nothing on stderr [xspec514-r1-single-compat-cli]", () => {
    const text = egr("callers", "solo");
    expect(text.status).toBe(0);
    expect(text.stdout).toBe("callers(solo):\n  useSolo (useSolo.ts)\n");
    expect(text.stderr).toBe("");

    const json = egr("callers", "solo", "--json");
    expect(JSON.parse(json.stdout)).toEqual([{ id: "useSolo.ts#useSolo", name: "useSolo", file: "useSolo.ts" }]);
    expect(json.stderr).toBe("");

    // --file on a name with one definition is accepted and changes nothing
    expect(egr("callers", "solo", "--file", "solo.ts").stdout).toBe(text.stdout);
  });

  it("two definitions in ONE file cannot be told apart by --file, and the answer says so [xspec514-r1-same-file-cli]", () => {
    const merged = egr("callers", "paint");
    expect(merged.stdout).toContain("defined 2 times");
    expect(merged.stdout).toContain("c/multi.ts:1");

    const r = egr("callers", "paint", "--file", "c/multi.ts");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"paint" is defined 2 times in c/multi.ts');
    expect(r.stdout).toContain("a file cannot tell them apart");
    expect(r.stdout).toContain("drawW");
    expect(r.stdout).toContain("drawG");

    const jr = egr("callers", "paint", "--file", "c/multi.ts", "--json");
    expect(names(JSON.parse(jr.stdout) as Row[])).toEqual(["drawG", "drawW"]);
    expect(jr.stderr).toContain("a file cannot tell them apart");
  });

  it("callees takes the same rules: merged says so, --file narrows [xspec514-r1-callees-cli]", () => {
    const merged = egr("callees", "render");
    expect(merged.stdout).toContain("defined 2 times");
    expect(merged.stdout).toContain("helperA (a/render.ts)");
    expect(merged.stdout).toContain("helperB (b/render.ts)");

    const one = egr("callees", "render", "--file", "b/render.ts");
    expect(one.stdout).toContain("helperB (b/render.ts)");
    expect(one.stdout).not.toContain("helperA");

    const jr = egr("callees", "render", "--json");
    expect(names(JSON.parse(jr.stdout) as Row[])).toEqual(["helperA", "helperB"]);
    expect(jr.stderr).toContain("defined 2 times");

    expect(egr("callees", "render", "--file", "nope.ts").status).toBe(1);
  });
});

describe("XSPEC-514 R1: MCP call_chain on a name several functions share", () => {
  async function call(args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [built.mcp],
        env: env as Record<string, string>,
        stderr: "ignore",
      }),
    );
    try {
      const res = (await client.callTool({ name: "call_chain", arguments: args })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      return { isError: res.isError === true, text: res.content.map((c) => c.text).join("\n") };
    } finally {
      await client.close();
    }
  }

  it("lists both definitions and mergedDefinitions 2 for a shared name [xspec514-r1-ac1-mcp]", async () => {
    const r = await call({ symbol: "render", direction: "callers" });
    expect(r.isError).toBe(false);
    const a = JSON.parse(r.text) as Merged & { symbolFound: boolean };
    expect(a.mergedDefinitions).toBe(2);
    expect(a.definitions.map((d) => d.file)).toEqual(["a/render.ts", "b/render.ts"]);
    expect(names(a.callers)).toEqual(["pageA", "pageB"]);
    expect(a.file).toBeUndefined();
    // fields only added: what the tool always returned is still there
    expect(a.symbolFound).toBe(true);
    expect(a.symbol).toBe("render");
  });

  it("file narrows to that definition's callers, and the result names the file and mergedDefinitions 1 [xspec514-r1-ac2-mcp]", async () => {
    const r = await call({ symbol: "render", direction: "callers", file: "a/render.ts" });
    expect(r.isError).toBe(false);
    const a = JSON.parse(r.text) as Merged;
    expect(names(a.callers)).toEqual(["pageA"]);
    expect(a.mergedDefinitions).toBe(1);
    expect(a.file).toBe("a/render.ts");
    expect(a.definitions).toHaveLength(2);

    const both = JSON.parse((await call({ symbol: "render", direction: "both", file: "b/render.ts" })).text) as Merged;
    expect(names(both.callers)).toEqual(["pageB"]);
    expect(names(both.callees)).toEqual(["helperB"]);
  });

  it("a file with no such definition, or an ambiguous ending, is an error result and not callers: [] [xspec514-r1-file-missing-mcp]", async () => {
    const none = await call({ symbol: "render", direction: "callers", file: "nope/other.ts" });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('"render" has no definition in "nope/other.ts"');
    expect(none.text).not.toContain('"callers"');

    const amb = await call({ symbol: "render", direction: "callers", file: "render.ts" });
    expect(amb.isError).toBe(true);
    expect(amb.text).toContain("is ambiguous");
  });

  it("a name with one definition keeps its result and only gains the definition fields [xspec514-r1-single-compat-mcp]", async () => {
    const a = JSON.parse((await call({ symbol: "solo", direction: "callers" })).text) as Merged & Record<string, unknown>;
    expect(a.callers).toEqual([{ id: "useSolo.ts#useSolo", name: "useSolo", file: "useSolo.ts" }]);
    expect(a.callees).toEqual([]);
    expect(a.symbolFound).toBe(true);
    expect(a.mergedDefinitions).toBe(1);
    expect(a.definitions).toEqual([{ id: "solo.ts#solo", file: "solo.ts", startLine: 1 }]);
    expect(a.file).toBeUndefined();
  });
});
