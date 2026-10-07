#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// implements XSPEC-457
//
// Does a running MCP server get in the way of terminal `egr` commands?
//
// This is the XSPEC-457 R1 scenario run end to end through the real entry
// points — the `egr-mcp` stdio server as a child process, the `egr` CLI as
// another — and read back through both. It is ONE script used by two callers,
// so there is no second copy to drift:
//
//   - test/mcp-releases-graph.test.ts   (vitest, every platform CI runs)
//   - .github/workflows/mcp-concurrency-windows.yml   (a GitHub-hosted Windows runner)
//
// Why it must run on Windows too: the report that started this was a Windows 11
// user whose `egr index` / `feedback` / `god-nodes` / `related` all failed after
// the assistant had used any egr tool. File locking differs by platform
// (flock on macOS/Linux, byte-range locks on Windows), and reasoning from one
// to the other is exactly what is not allowed here.
//
// Steps (each is a named check in the output; any failure → exit 1):
//   1. index a small project with the CLI
//   2. start the MCP server, ask it one question, LEAVE IT RUNNING
//   3. while it runs, from another process: index again (new function + docs),
//      feedback, god-nodes, related — each must succeed
//   4. ask the MCP server again: it must see the function added in step 3
//   5. a writer holds the graph (another process): the MCP server must answer
//      "busy", not an empty result; the CLI `related` must exit non-zero
//      5c/5d: a process that only READS holds it (the state the report was in):
//      every writing command must exit non-zero, readers still work
//   6. the holder leaves: the same MCP server answers again, no restart
//
// Usage:
//   node scripts/mcp-concurrency-verify.mjs [--root <repo-or-package-root>] [--dist <dir>] [--json <file>]
//   --root  where dist/ and node_modules/ live (default: this repo)
//   --dist  build output directory under --root (default: dist)

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const ROOT = resolve(opt("--root", join(HERE, "..")));
const DIST = join(ROOT, opt("--dist", "dist"));
const JSON_OUT = opt("--json", "");
const CLI = join(DIST, "cli", "index.js");
const MCP = join(DIST, "mcp", "stdio.js");
const RYU = createRequire(join(ROOT, "package.json")).resolve("ryugraph");

const work = mkdtempSync(join(tmpdir(), "egr-mcp-verify-"));
const proj = join(work, "proj");
const dbPath = join(work, "graph.db");
mkdirSync(proj, { recursive: true });
writeFileSync(join(proj, "a.ts"), "export function alpha() { return beta(); }\nexport function beta() { return 1; }\n");
writeFileSync(join(proj, "spec.md"), "---\nid: XSPEC-1\ntitle: Verify spec\n---\n# XSPEC-1\nbody\n");

// A short wait so the "writer is in the way" step is quick. The server's
// default is 5 s; the variable is the documented way to change it.
const env = { ...process.env, ENGRAM_DB: dbPath, ENGRAM_LOCK_WAIT_MS: "1500" };
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 400) });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${String(detail).slice(0, 300)}`}\n`);
};

const egr = (...a) => {
  const r = spawnSync(process.execPath, [CLI, ...a], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

const text = (res) => (res.content ?? []).map((c) => c.text ?? "").join("\n");
async function ask(client, name, a) {
  const res = await client.callTool({ name, arguments: a });
  return { isError: res.isError === true, text: text(res) };
}

let client;
let holder;
let fatal = null;

/** A separate process that holds the graph — for writing, or (readOnly) for reading only. */
async function startHolder(readOnly) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const {Database,Connection}=require(${JSON.stringify(RYU)});
       try {
         const db=new Database(${JSON.stringify(dbPath)},undefined,undefined,${readOnly});
         const c=new Connection(db);
         c.query("MATCH (f:Function) RETURN count(*) AS n").then(()=>{process.stdout.write("held\\n");}).catch((e)=>{console.error(String(e));process.exit(3);});
         setInterval(()=>{},1000);
       } catch (e) { console.error(String(e)); process.exit(3); }`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("lock holder did not start")), 20_000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("held")) {
        clearTimeout(t);
        res();
      }
    });
    child.on("exit", () => rej(new Error("lock holder exited early")));
  });
  return child;
}

async function stopHolder(child) {
  child.removeAllListeners("exit");
  const gone = new Promise((res) => child.once("exit", res));
  child.kill();
  await gone;
}
try {
  // 1
  const first = egr("index", proj, "--docs");
  check("1. egr index (before the server starts)", first.status === 0, first.out);

  // 2
  client = new Client({ name: "verify", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [MCP], env, stderr: "ignore" }));
  const q1 = await ask(client, "call_chain", { symbol: "beta", direction: "callers" });
  check("2. MCP call_chain answers (server now stays running)", !q1.isError && q1.text.includes("alpha"), q1.text);

  // 3 — the server is still running; every one of these used to fail
  writeFileSync(join(proj, "b.ts"), "export function gamma() { return beta(); }\n");
  const idx = egr("index", proj, "--docs");
  check("3a. egr index while the MCP server is running", idx.status === 0, idx.out);
  const fb = egr("feedback", "test_fail", "a.ts#beta");
  check("3b. egr feedback while the MCP server is running", fb.status === 0 && fb.out.includes("→"), fb.out);
  const gn = egr("god-nodes");
  check("3c. egr god-nodes while the MCP server is running", gn.status === 0 && gn.out.includes("god-nodes:"), gn.out);
  const rel = egr("related", "a.ts#beta");
  check("3d. egr related while the MCP server is running", rel.status === 0 && rel.out.includes("related(a.ts#beta)"), rel.out);

  // 4
  const q2 = await ask(client, "call_chain", { symbol: "beta", direction: "callers" });
  check("4. MCP sees the function the terminal just indexed", !q2.isError && q2.text.includes("gamma") && q2.text.includes("alpha"), q2.text);

  // 5 — a writer in another process holds the graph
  holder = await startHolder(false);
  const busy = await ask(client, "call_chain", { symbol: "beta", direction: "callers" });
  check(
    "5a. MCP answers 'graph is busy' while a writer holds it (not an empty result)",
    busy.isError && /being written|locked|busy/i.test(busy.text) && !/"callers"\s*:\s*\[\s*\]/.test(busy.text),
    busy.text,
  );
  const relBusy = egr("related", "a.ts#beta");
  check("5b. egr related exits non-zero when the graph is locked", relBusy.status !== 0 && relBusy.status !== null, `exit=${relBusy.status} ${relBusy.out}`);

  await stopHolder(holder);
  holder = undefined;

  // 5c — the state the Windows report was in: a process that only READS holds
  // the graph (that was the MCP server, before it stopped doing so). Every
  // command that writes must then FAIL — exit non-zero — none may report
  // success. `related` printed an I/O exception and exited 0 there.
  holder = await startHolder(true);
  const statuses = {};
  for (const argv of [["index", proj, "--docs"], ["feedback", "test_fail", "a.ts#beta"], ["god-nodes"], ["communities"], ["related", "a.ts#beta"]]) {
    const r = egr(...argv);
    statuses[argv[0]] = r.status;
  }
  check(
    "5c. with a read-only process holding the graph, egr index / feedback / god-nodes / communities / related all exit non-zero",
    Object.values(statuses).every((c) => c !== 0 && c !== null),
    `exit codes: ${JSON.stringify(statuses)}`,
  );
  const readerWhileReader = egr("callers", "beta");
  check("5d. a read-only egr command still works alongside a read-only holder", readerWhileReader.status === 0, readerWhileReader.out);
  await stopHolder(holder);
  holder = undefined;

  // 6
  const q3 = await ask(client, "call_chain", { symbol: "beta", direction: "callers" });
  check("6. same MCP server answers again once the writer is gone", !q3.isError && q3.text.includes("gamma"), q3.text);
} catch (err) {
  fatal = err instanceof Error ? err.stack ?? err.message : String(err);
  check("script ran to completion", false, fatal);
} finally {
  try {
    await client?.close();
  } catch {
    /* the server may already be gone */
  }
  holder?.kill();
  // Windows can hold a file for a moment after its process exits.
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(work, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

const failed = results.filter((r) => !r.ok);
const summary = { platform: `${process.platform}-${process.arch}`, node: process.version, total: results.length, failed: failed.length, results };
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(summary, null, 2));
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed on ${summary.platform} (node ${process.version})\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map((r) => `| ${r.ok ? "PASS" : "FAIL"} | ${r.name} | ${r.ok ? "" : r.detail.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
  try {
    const prev = (() => {
      try {
        return readFileSync(process.env.GITHUB_STEP_SUMMARY, "utf8");
      } catch {
        return "";
      }
    })();
    writeFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `${prev}\n### MCP vs terminal concurrency (${summary.platform}, node ${process.version})\n\n| result | check | detail |\n|---|---|---|\n${rows.join("\n")}\n`,
    );
  } catch {
    /* summary is a convenience */
  }
}
process.exit(failed.length === 0 && !fatal ? 0 : 1);
