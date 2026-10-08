// implements XSPEC-457
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { isReadOnlyRefusal, READ_ONLY_REFUSAL_MARKER } from "../src/mcp/read-only-refusal.mjs";
import { buildEgr, REPO_ROOT, type BuiltEgr } from "./helpers/build-cli.js";

/**
 * `scripts/windows-release-verify.mjs` is the checklist that decides whether a
 * release may move to `latest`. It judges product output by matching on text,
 * and for as long as nothing ran it before a release, those matches went stale
 * in silence: XSPEC-457 R1 reworded the MCP refusal, the script kept looking
 * for the old words, and the first person to find out was the Windows workflow
 * run on the already-published 0.13.0-beta.1 (step 6 failed on a correct
 * refusal).
 *
 * Two things are pinned here.
 *
 * 1. What counts as "the MCP refused" is defined once (`src/mcp/read-only-refusal.mjs`,
 *    which the server builds its sentence from) and checked against the REAL
 *    server: the built `egr-mcp` over stdio, asked for `related`.
 * 2. The whole script runs, every step, against a build of the current `src/`.
 *    That is what catches the other strings it carries (`top`'s confidence
 *    line, `related`'s neighbour lines, `rank`, the doctor ticks, `code: N
 *    files`) the same way — one of them changing now fails here, not on a
 *    Windows machine after publishing.
 */

let built: BuiltEgr;
let work: string;
let target: string;
let scriptStatus: number | null;
let scriptOut: string;
let report: { results: Array<{ step: string; ok: boolean; detail: string; raw: string }> };

/** The environment for anything that runs the product: no inherited graph path, a throwaway home. */
function cleanEnv(home: string): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env.ENGRAM_DB;
  return { ...env, HOME: home, USERPROFILE: home };
}

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-verify-script-"));
  target = join(work, "project");
  mkdirSync(target);
  writeFileSync(join(target, "a.ts"), "export function alpha() { return beta(); }\nexport function beta() { return 1; }\n");
  writeFileSync(join(target, "spec.md"), "---\nid: XSPEC-1\ntitle: Verify spec\n---\n# XSPEC-1\nbody\n");
  const home = join(work, "home");
  mkdirSync(home);
  const jsonOut = join(work, "report.json");
  const run = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, "scripts", "windows-release-verify.mjs"),
      "--target", target,
      "--package-dir", REPO_ROOT,
      "--dist", built.distRel,
      "--json", jsonOut,
    ],
    { cwd: work, encoding: "utf8", env: cleanEnv(home), timeout: 240_000 },
  );
  scriptStatus = run.status;
  scriptOut = `${run.stdout}\n${run.stderr}`;
  report = JSON.parse(readFileSync(jsonOut, "utf8"));
}, 300_000);

afterAll(() => {
  built?.cleanup();
  if (work) rmSync(work, { recursive: true, force: true });
});

function step(prefix: string): { step: string; ok: boolean; detail: string; raw: string } {
  const r = report.results.find((x) => x.step.startsWith(prefix));
  if (!r) throw new Error(`the verify script did not report a step "${prefix}": ${JSON.stringify(report.results.map((x) => x.step))}`);
  return r;
}

/** What a real server answers for `related`, asked over stdio the way a client does. */
async function callOnRealServer<T>(fn: (call: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<T>): Promise<T> {
  const home = join(work, "home");
  const client = new Client({ name: "t", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [built.mcp], cwd: target, env: cleanEnv(home), stderr: "ignore" }),
  );
  try {
    return await fn((name, args) => client.callTool({ name, arguments: args }));
  } finally {
    await client.close();
  }
}

describe("XSPEC-457: the release verifier recognises the MCP's refusal", () => {
  it("the real MCP server's refusal of related is recognised, and the verifier's step 6 passes on it [verify-refusal-real-server]", async () => {
    const res = await callOnRealServer((call) => call("related", { seedId: "a.ts#alpha" }));
    // The server really refused — a server that answered would fail here, not slip through as "recognised".
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(isReadOnlyRefusal(res), JSON.stringify(res)).toBe(true);
    // And the verifier, which judged the same call in its own run, agrees.
    const s = step("6 MCP related refuses");
    expect(s.ok, `${s.detail}\n${s.raw}`).toBe(true);
  }, 60_000);

  it("a reply that is not the refusal is not recognised: a successful answer, and an error that is not a refusal [verify-refusal-negatives]", async () => {
    const { answer, notFound } = await callOnRealServer(async (call) => ({
      answer: await call("call_chain", { symbol: "beta", direction: "callers" }),
      notFound: await call("call_chain", { symbol: "NoSuchSymbolXYZ", direction: "callers" }),
    }));
    expect((answer as { isError?: boolean }).isError).not.toBe(true);
    expect(isReadOnlyRefusal(answer), JSON.stringify(answer)).toBe(false);
    // isError alone must not be enough: this is an error, and it is not the refusal.
    expect((notFound as { isError?: boolean }).isError).toBe(true);
    expect(isReadOnlyRefusal(notFound), JSON.stringify(notFound)).toBe(false);
  }, 60_000);

  it("samples of what servers actually said are recognised or not, independently of the current wording [verify-refusal-samples]", () => {
    const asResult = (text: string, isError = true) => ({ isError, content: [{ type: "text", text }] });
    // 0.13.0-beta.1, the reply the Windows run (37818731887) got — copied here
    // on purpose, not built from READ_ONLY_REFUSAL_MARKER: if the wording and
    // the judge are ever changed together, this still holds the old one.
    const beta1 =
      "error: related is not available through this MCP server: it only reads the graph, so a writer in a terminal " +
      "can never collide with it. Run `egr related <seed-id>` in a terminal — that works while this server is " +
      "running, because the server holds the graph only for the duration of a query. " +
      "This server sees the result on its next query; no restart is needed.";
    expect(isReadOnlyRefusal(asResult(beta1))).toBe(true);
    // 0.12.x (git 10e297b^), still what `latest` says until 0.13 is promoted.
    const v012 =
      "error: related needs write access, and this MCP server holds the graph read-only so that queries here " +
      "and `egr` commands in a terminal can run at the same time. Run `egr related <seed-id>` instead; " +
      "this server sees the result on its next query.";
    expect(isReadOnlyRefusal(asResult(v012))).toBe(true);
    // The marker the server builds from is the phrase in the beta.1 sample.
    expect(beta1).toContain(READ_ONLY_REFUSAL_MARKER);

    // Not refusals.
    expect(isReadOnlyRefusal(asResult(beta1, false)), "a success that quotes the sentence").toBe(false);
    expect(isReadOnlyRefusal(asResult("error: the graph is being written by another process"))).toBe(false);
    expect(isReadOnlyRefusal({ content: [] })).toBe(false);
    expect(isReadOnlyRefusal(undefined)).toBe(false);
    expect(isReadOnlyRefusal(null)).toBe(false);
    expect(isReadOnlyRefusal("error: related is not available through this MCP server")).toBe(false);
  });
});

describe("XSPEC-457: the release verifier's other matches on product output", () => {
  it("every step of the verifier passes against a build of the current source [verify-script-all-steps]", () => {
    const failed = report.results.filter((r) => !r.ok);
    expect(failed.map((r) => `${r.step}: ${r.detail}`), scriptOut.slice(-3000)).toEqual([]);
    expect(scriptStatus).toBe(0);
    // It ran to the end: step 8 is the last one, and steps are not silently skipped.
    expect(step("8 ").ok).toBe(true);
    expect(report.results.length).toBeGreaterThanOrEqual(12);
  });
});
