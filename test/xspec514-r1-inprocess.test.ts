// SPDX-License-Identifier: MIT
// implements XSPEC-514
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { indexProject } from "../src/code-graph/indexer.js";
import {
  DefinitionFileError,
  callChain,
  definitionFiles,
  definitionScope,
  describeDefinitionScope,
  functionDefinitions,
  resolveDefinitionFile,
  type DefinitionScope,
  type FunctionDefinition,
} from "../src/code-graph/query.js";
import { NotInGraphError } from "../src/code-graph/lookup.js";
import { cmdCallees, cmdCalleesAnswer, cmdCallers, cmdCallersAnswer } from "../src/cli/run.js";

/**
 * XSPEC-514 R1 in this process: a name that several functions share.
 *
 * `xspec514-r1-callers-same-name.test.ts` proves the feature through the built CLI and the stdio MCP server, as a user
 * meets it. A child process is not counted by the coverage gate, so this file asks the same questions of the same
 * functions in the test process, against a graph it indexes itself, and reads the answers back. It is the evidence
 * that the CLI's own functions (`cmdCallersAnswer` / `cmdCalleesAnswer`) and the query module behave as the CLI
 * prints them, not a replacement for those tests.
 *
 * Fixture (CALLS bind to a same-file definition first, so each `render` has its own callers):
 *   a/render.ts   helperA, render (calls helperA), pageA (calls render), entryA (calls pageA)
 *   b/render.ts   helperB, render (calls helperB), pageB (calls render)
 *   c/multi.ts    two classes that both define `paint`, called from drawW / drawG   (same file, two definitions)
 *   solo.ts       solo        useSolo.ts   useSolo (calls solo)
 */

// The Kuzu connection is never closed here, on purpose: closing it while tree-sitter is loaded in the same forks
// worker can deadlock (see code-graph.test.ts). The temp database is removed when the suite ends.
let dir: string;
let conn: GraphConnection;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "egr-514r1-inproc-"));
  conn = GraphConnection.open(join(dir, "graph.db"));
  await initSchema(conn);
  await indexProject(conn, [
    {
      path: "a/render.ts",
      source: [
        "export function helperA() { return 0; }",
        "export function render() { return helperA(); }",
        "export function pageA() { return render(); }",
        "export function entryA() { return pageA(); }",
        "",
      ].join("\n"),
    },
    {
      path: "b/render.ts",
      source: ["export function helperB() { return 0; }", "export function render() { return helperB(); }", "export function pageB() { return render(); }", ""].join("\n"),
    },
    {
      path: "c/multi.ts",
      source: [
        "export class Widget { paint() { return 1; } drawW() { return this.paint(); } }",
        "export class Gadget { paint() { return 2; } drawG() { return this.paint(); } }",
        "",
      ].join("\n"),
    },
    { path: "solo.ts", source: "export function solo() { return 1; }\n" },
    { path: "useSolo.ts", source: 'import { solo } from "./solo";\nexport function useSolo() { return solo(); }\n' },
  ]);
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const names = (rows: Array<{ name: string }>) => rows.map((r) => r.name).sort();
const def = (file: string, startLine: number | null = 1): FunctionDefinition => ({ id: `${file}#render`, file, startLine });

describe("XSPEC-514 R1: functionDefinitions and definitionFiles read the graph", () => {
  it("functionDefinitions lists every definition of a shared name, ordered by file, with its 1-based line [xspec514-r1-inproc-definitions]", async () => {
    const defs = await functionDefinitions(conn, "render");
    expect(defs.map((d) => [d.file, d.startLine])).toEqual([
      ["a/render.ts", 2],
      ["b/render.ts", 2],
    ]);
    expect(defs.map((d) => d.id)).toEqual(["a/render.ts#render", "b/render.ts#render"]);
  });

  it("a name with no definition has an empty list, and a name defined once has one entry [xspec514-r1-inproc-definitions-edge]", async () => {
    expect(await functionDefinitions(conn, "nobody")).toEqual([]);
    expect((await functionDefinitions(conn, "solo")).map((d) => d.file)).toEqual(["solo.ts"]);
  });

  it("definitionFiles lists the distinct files that define the name [xspec514-r1-inproc-definition-files]", async () => {
    expect((await definitionFiles(conn, "render")).sort()).toEqual(["a/render.ts", "b/render.ts"]);
    expect(await definitionFiles(conn, "nobody")).toEqual([]);
  });
});

describe("XSPEC-514 R1: resolveDefinitionFile turns a typed path into one stored file", () => {
  const two = [def("a/render.ts"), def("b/render.ts")];

  it("an exact stored id wins, even after ./, a leading slash or Windows separators are removed [xspec514-r1-inproc-resolve-exact]", () => {
    expect(resolveDefinitionFile(two, "render", "a/render.ts")).toBe("a/render.ts");
    expect(resolveDefinitionFile(two, "render", "./a/render.ts")).toBe("a/render.ts");
    expect(resolveDefinitionFile(two, "render", "/a/render.ts")).toBe("a/render.ts");
    expect(resolveDefinitionFile(two, "render", "b\\render.ts")).toBe("b/render.ts");
  });

  it("a unique trailing path segment matches in both directions: a longer absolute path, and a shorter ending [xspec514-r1-inproc-resolve-suffix]", () => {
    expect(resolveDefinitionFile(two, "render", "/home/me/proj/a/render.ts")).toBe("a/render.ts");
    expect(resolveDefinitionFile(two, "render", "b/render.ts")).toBe("b/render.ts");
    // A shorter ending that only one definition file ends with.
    expect(resolveDefinitionFile([def("src/a/render.ts"), def("src/b/other.ts")], "render", "a/render.ts")).toBe("src/a/render.ts");
  });

  it("a match must be on a whole path segment: render.ts never matches prerender.ts [xspec514-r1-inproc-resolve-boundary]", () => {
    const defs = [def("src/prerender.ts")];
    expect(() => resolveDefinitionFile(defs, "render", "render.ts")).toThrow(DefinitionFileError);
    try {
      resolveDefinitionFile(defs, "render", "render.ts");
    } catch (e) {
      expect((e as DefinitionFileError).kind).toBe("none");
    }
  });

  it("an ending that fits several files is ambiguous and names them, sorted [xspec514-r1-inproc-resolve-ambiguous]", () => {
    let caught: unknown;
    try {
      resolveDefinitionFile(two, "render", "render.ts");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DefinitionFileError);
    const err = caught as DefinitionFileError;
    expect(err.name).toBe("DefinitionFileError");
    expect(err.kind).toBe("ambiguous");
    expect(err.symbol).toBe("render");
    expect(err.wanted).toBe("render.ts");
    expect(err.candidates).toEqual(["a/render.ts", "b/render.ts"]);
    expect(err.message).toContain('"render.ts" is ambiguous for "render"');
    expect(err.message).toContain("2 definitions");
    expect(err.message).toContain("Give more of the path.");
  });

  it("a file with no such definition says where the symbol is defined and that this is not 'nothing calls it' [xspec514-r1-inproc-resolve-none]", () => {
    let caught: unknown;
    try {
      resolveDefinitionFile(two, "render", "nope/other.ts");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DefinitionFileError);
    const err = caught as DefinitionFileError;
    expect(err.kind).toBe("none");
    expect(err.candidates).toEqual(["a/render.ts", "b/render.ts"]);
    expect(err.message).toContain('"render" has no definition in "nope/other.ts"');
    expect(err.message).toContain('not the same as "nothing calls it"');
    expect(err.message).toContain("a/render.ts");
    expect(err.message).toContain("b/render.ts");
  });

  it("no definitions at all is still an error, never an empty answer [xspec514-r1-inproc-resolve-empty]", () => {
    expect(() => resolveDefinitionFile([], "ghost", "x.ts")).toThrow(/has no definition in "x.ts"/);
  });
});

describe("XSPEC-514 R1: definitionScope and callChain say which definitions an answer combines", () => {
  it("without a file the scope is every definition, and nothing is narrowed [xspec514-r1-inproc-scope-all]", async () => {
    const scope = await definitionScope(conn, "render");
    expect(scope.mergedDefinitions).toBe(2);
    expect(scope.definitions).toHaveLength(2);
    expect(scope.file).toBeUndefined();
  });

  it("with a file the scope names the stored file and counts only its definitions [xspec514-r1-inproc-scope-file]", async () => {
    const scope = await definitionScope(conn, "render", "/somewhere/else/b/render.ts");
    expect(scope.file).toBe("b/render.ts");
    expect(scope.mergedDefinitions).toBe(1);
    expect(scope.definitions).toHaveLength(2);
  });

  it("two definitions in ONE file count as 2 merged in that file, because a file cannot tell them apart [xspec514-r1-inproc-scope-same-file]", async () => {
    const scope = await definitionScope(conn, "paint", "c/multi.ts");
    expect(scope.file).toBe("c/multi.ts");
    expect(scope.mergedDefinitions).toBe(2);
  });

  it("a file that defines none of them is an error from definitionScope [xspec514-r1-inproc-scope-error]", async () => {
    await expect(definitionScope(conn, "render", "solo.ts")).rejects.toBeInstanceOf(DefinitionFileError);
  });

  it("callChain merges both definitions by default and narrows to one with file, for callers and callees alike [xspec514-r1-inproc-callchain]", async () => {
    const merged = await callChain(conn, "render", "both", 1);
    expect(merged.mergedDefinitions).toBe(2);
    expect(merged.file).toBeUndefined();
    expect(names(merged.callers)).toEqual(["pageA", "pageB"]);
    expect(names(merged.callees)).toEqual(["helperA", "helperB"]);

    const a = await callChain(conn, "render", "both", 1, "a/render.ts");
    expect(a.file).toBe("a/render.ts");
    expect(a.mergedDefinitions).toBe(1);
    expect(names(a.callers)).toEqual(["pageA"]);
    expect(names(a.callees)).toEqual(["helperA"]);
  });

  it("direction limits which side is asked: the other side stays empty and is not queried into the answer [xspec514-r1-inproc-callchain-direction]", async () => {
    const onlyCallers = await callChain(conn, "render", "callers", 1);
    expect(names(onlyCallers.callers)).toEqual(["pageA", "pageB"]);
    expect(onlyCallers.callees).toEqual([]);
    const onlyCallees = await callChain(conn, "render", "callees", 1, "b/render.ts");
    expect(onlyCallees.callers).toEqual([]);
    expect(names(onlyCallees.callees)).toEqual(["helperB"]);
  });

  it("depth follows CALLS transitively, and an absurd depth is clamped instead of rejected [xspec514-r1-inproc-callchain-depth]", async () => {
    const shallow = await callChain(conn, "render", "callers", 1, "a/render.ts");
    expect(names(shallow.callers)).toEqual(["pageA"]);
    expect(shallow.depth).toBe(1);
    const deep = await callChain(conn, "render", "callers", 2, "a/render.ts");
    expect(names(deep.callers)).toEqual(["entryA", "pageA"]);
    expect((await callChain(conn, "render", "callers", 999, "a/render.ts")).depth).toBe(10);
    expect((await callChain(conn, "render", "callers", 0, "a/render.ts")).depth).toBe(1);
    expect((await callChain(conn, "render", "callers", Number.NaN, "a/render.ts")).depth).toBe(1);
  });
});

describe("XSPEC-514 R1: describeDefinitionScope is the sentence a reader gets", () => {
  const scopeOf = (definitions: FunctionDefinition[], file?: string): DefinitionScope => ({
    definitions,
    mergedDefinitions: file === undefined ? definitions.length : definitions.filter((d) => d.file === file).length,
    ...(file !== undefined ? { file } : {}),
  });

  it("one definition that nothing narrowed has nothing to say [xspec514-r1-inproc-describe-silent]", () => {
    expect(describeDefinitionScope(scopeOf([def("a.ts", 3)]), "f")).toBe("");
    // Narrowed to the only definition there is: also nothing to say.
    expect(describeDefinitionScope(scopeOf([def("a.ts", 3)], "a.ts"), "f")).toBe("");
  });

  it("several definitions say merged, how many, where, and how to narrow [xspec514-r1-inproc-describe-merged]", () => {
    const text = describeDefinitionScope(scopeOf([def("a.ts", 3), def("b.ts", null)]), "f");
    expect(text).toContain('⚠ merged: "f" is defined 2 times');
    expect(text).toContain("a.ts:3");
    // A definition with no known line shows just its file, not "b.ts:null".
    expect(text).toContain("b.ts)");
    expect(text).not.toContain("null");
    expect(text).toContain("--file <path>");
  });

  it("narrowed to one of several says which one and out of how many [xspec514-r1-inproc-describe-narrowed]", () => {
    const text = describeDefinitionScope(scopeOf([def("a.ts", 3), def("b.ts", 9)], "b.ts"), "f");
    expect(text).toBe('narrowed to the definition at b.ts:9 (1 of 2 definitions of "f").');
  });

  it("two definitions in the narrowed file say merged and that a file cannot tell them apart [xspec514-r1-inproc-describe-same-file]", () => {
    const text = describeDefinitionScope(scopeOf([def("a.ts", 3), def("a.ts", 8), def("b.ts", 1)], "a.ts"), "f");
    expect(text).toContain('⚠ merged: "f" is defined 2 times in a.ts (a.ts:3, a.ts:8)');
    expect(text).toContain("a file cannot tell them apart");
  });
});

describe("XSPEC-514 R1: cmdCallersAnswer / cmdCalleesAnswer, the functions behind egr callers and egr callees", () => {
  it("callers: a shared name answers with both definitions and the rows of both [xspec514-r1-inproc-cmd-callers-merged]", async () => {
    const answer = await cmdCallersAnswer(conn, "render");
    expect(answer.symbol).toBe("render");
    expect(answer.mergedDefinitions).toBe(2);
    expect(answer.definitions.map((d) => d.file)).toEqual(["a/render.ts", "b/render.ts"]);
    expect(names(answer.rows)).toEqual(["pageA", "pageB"]);
    expect(answer.file).toBeUndefined();
  });

  it("callers: --file narrows the rows to that definition's callers and the depth is passed through [xspec514-r1-inproc-cmd-callers-file]", async () => {
    const one = await cmdCallersAnswer(conn, "render", 1, "b/render.ts");
    expect(one.file).toBe("b/render.ts");
    expect(names(one.rows)).toEqual(["pageB"]);
    const deep = await cmdCallersAnswer(conn, "render", 2, "a/render.ts");
    expect(names(deep.rows)).toEqual(["entryA", "pageA"]);
  });

  it("callees: same rules, merged by default and narrowed by file [xspec514-r1-inproc-cmd-callees]", async () => {
    const merged = await cmdCalleesAnswer(conn, "render");
    expect(merged.mergedDefinitions).toBe(2);
    expect(names(merged.rows)).toEqual(["helperA", "helperB"]);
    const one = await cmdCalleesAnswer(conn, "render", 1, "a/render.ts");
    expect(one.file).toBe("a/render.ts");
    expect(names(one.rows)).toEqual(["helperA"]);
  });

  it("a name with one definition answers with that one definition and an unchanged row list [xspec514-r1-inproc-cmd-single]", async () => {
    const answer = await cmdCallersAnswer(conn, "solo");
    expect(answer.mergedDefinitions).toBe(1);
    expect(names(answer.rows)).toEqual(["useSolo"]);
    expect(describeDefinitionScope(answer, "solo")).toBe("");
  });

  it("a known name that nothing calls is an empty answer, but a file with no definition or an unknown name is an error, never an empty answer [xspec514-r1-inproc-cmd-errors]", async () => {
    const none = await cmdCallersAnswer(conn, "useSolo");
    expect(none.rows).toEqual([]);
    expect(none.mergedDefinitions).toBe(1);

    await expect(cmdCallersAnswer(conn, "render", 1, "solo.ts")).rejects.toBeInstanceOf(DefinitionFileError);
    await expect(cmdCalleesAnswer(conn, "render", 1, "render.ts")).rejects.toMatchObject({ kind: "ambiguous" });
    await expect(cmdCallersAnswer(conn, "nobody")).rejects.toBeInstanceOf(NotInGraphError);
    await expect(cmdCalleesAnswer(conn, "nobody")).rejects.toBeInstanceOf(NotInGraphError);
  });

  it("cmdCallers and cmdCallees return just the rows of the answer [xspec514-r1-inproc-cmd-rows]", async () => {
    expect(names(await cmdCallers(conn, "render", 1, "a/render.ts"))).toEqual(["pageA"]);
    expect(names(await cmdCallers(conn, "render"))).toEqual(["pageA", "pageB"]);
    expect(names(await cmdCallees(conn, "render", 1, "b/render.ts"))).toEqual(["helperB"]);
    expect(names(await cmdCallees(conn, "render"))).toEqual(["helperA", "helperB"]);
  });
});
