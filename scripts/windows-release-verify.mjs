#!/usr/bin/env node
/**
 * Release verification against an installed engramgraph — the steps a person
 * used to run by hand on a company Windows machine before `latest` moved.
 *
 * Why this exists: 0.12.0's central fix (XSPEC-374) is that a read-only MCP
 * server and a writing terminal command can hold one graph at the same time
 * without destroying it. On Windows the engine's single-writer guard is a
 * byte-range lock, which POSIX has no equivalent of, so a macOS or Linux pass
 * says nothing about it. The hand-run checklist waited a month for a Windows
 * machine; this runs the same steps on any machine, and CI runs it on Windows.
 *
 * Usage:  node scripts/windows-release-verify.mjs --target <dir> --expect-version <x.y.z> [--summary <file>] [--json <file>]
 *
 * It uses the globally installed package (`npm root -g`), not this checkout —
 * the thing under test is what users install. Every check prints its raw
 * output; a failure names the step and what it saw.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const target = resolve(args.target ?? process.cwd());
const expectVersion = args["expect-version"];
const results = [];

function record(step, ok, detail, raw = "") {
  results.push({ step, ok, detail, raw: String(raw).slice(0, 6000) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step} — ${detail}`);
  if (raw) console.log(String(raw).replace(/^/gm, "      ").slice(0, 3000));
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const globalRoot = spawnSync(npm, ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32" }).stdout.trim();
const pkgDir = join(globalRoot, "engramgraph");
const CLI = join(pkgDir, "dist", "cli", "index.js");
const MCP = join(pkgDir, "dist", "mcp", "stdio.js");

function egr(argv, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...argv], { cwd: target, encoding: "utf8", env: { ...process.env, ...opts.env } });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`.trim(), stdout: r.stdout ?? "" };
}

function listDir(dir) {
  if (!existsSync(dir)) return "(does not exist)";
  return readdirSync(dir)
    .map((n) => {
      const s = statSync(join(dir, n));
      return `${s.isDirectory() ? "d" : "-"} ${String(s.size).padStart(10)}  ${n}`;
    })
    .join("\n");
}

function snapshot(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(`${p}:${statSync(p).mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort();
}

/** Minimal MCP stdio client: newline-delimited JSON-RPC. */
function startMcp() {
  const child = spawn(process.execPath, [MCP], { cwd: target, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let stderr = "";
  const waiters = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && waiters.has(msg.id)) {
          waiters.get(msg.id)(msg);
          waiters.delete(msg.id);
        }
      } catch {
        // not JSON — ignore (the server writes logs to stderr, not stdout)
      }
    }
  });
  child.stderr.on("data", (d) => (stderr += d.toString()));
  let nextId = 1;
  const request = (method, params, timeoutMs = 60000) =>
    new Promise((res, rej) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiters.delete(id);
        rej(new Error(`MCP ${method} timed out after ${timeoutMs} ms; stderr:\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, (msg) => {
        clearTimeout(timer);
        res(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  const stop = () =>
    new Promise((res) => {
      child.once("exit", () => res());
      child.stdin.end();
      setTimeout(() => child.kill(), 3000);
    });
  return { request, notify, stop, stderr: () => stderr, child };
}

const ALGO_PACKAGES = {
  "win32-x64": "@asiaostrich/engramgraph-algo-win32-x64",
  "linux-x64": "@asiaostrich/engramgraph-algo-linux-x64",
  "darwin-arm64": "@asiaostrich/engramgraph-algo-darwin-arm64",
  "darwin-x64": "@asiaostrich/engramgraph-algo-darwin-x64",
};

async function main() {
  console.log(`target: ${target}\npackage: ${pkgDir}\nplatform: ${process.platform}-${process.arch}\n`);

  // Step 0 — the version under test, and its platform algo package.
  const v = egr(["--version"]);
  const versionOk = v.status === 0 && (!expectVersion || v.stdout.includes(expectVersion));
  record("0a version", versionOk, expectVersion ? `expected ${expectVersion}` : "no expectation given", v.out);
  if (!versionOk) return;
  const algoPkg = ALGO_PACKAGES[`${process.platform}-${process.arch}`];
  if (algoPkg) {
    const present = existsSync(join(pkgDir, "node_modules", algoPkg, "libalgo.ryu_extension")) ||
      existsSync(join(globalRoot, algoPkg, "libalgo.ryu_extension"));
    record("0b algo package installed", present, algoPkg);
  } else {
    record("0b algo package installed", true, `no package exists for ${process.platform}-${process.arch}; skipped`);
  }

  // Step 1 — .engram before.
  record("1 .engram before", true, "listing", listDir(join(target, ".engram")));

  // Step 2 — first index.
  const i1 = egr(["index", target, "--docs"]);
  record("2 index", i1.status === 0, `exit ${i1.status}`, i1.out);
  if (i1.status !== 0) return;

  // Step 3 — a node id read from this graph, never a hard-coded example.
  const top = egr(["top", "Function", "--limit", "5"]);
  const seed = (top.stdout.match(/^\s+(\S+)\s+\(confidence/m) ?? [])[1];
  record("3 real seed id", top.status === 0 && Boolean(seed), seed ? `seed=${seed}` : "no Function id found", top.out);
  if (!seed) return;

  // Step 4 — MCP holds the graph read-only while the terminal writes.
  const mcp = startMcp();
  try {
    const init = await mcp.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "release-verify", version: "1" },
    });
    mcp.notify("notifications/initialized", {});
    record("4a MCP up (read-only)", !init.error, init.error ? JSON.stringify(init.error) : "initialized", mcp.stderr());

    // The next step only proves anything if the server is alive and holding
    // the graph while the terminal writes — a server that already exited
    // would make it pass for nothing.
    const aliveBefore = mcp.child.exitCode === null;
    const i2 = egr(["index", target, "--docs"]);
    const aliveAfter = mcp.child.exitCode === null;
    record("4a' MCP still running across the write", aliveBefore && aliveAfter, `before=${aliveBefore} after=${aliveAfter}`);
    const lockNoise = /lock|busy|EBUSY|could not set lock/i.test(i2.out);
    record("4b write while MCP holds the graph", i2.status === 0 && !lockNoise, `exit ${i2.status}${lockNoise ? ", lock text in output" : ""}`, i2.out);

    // Step 5 — a write-requiring query from the terminal returns real neighbours.
    const rel = egr(["related", seed, "--depth", "2", "--limit", "10"]);
    const neighbours = rel.stdout.split("\n").filter((l) => /^\s+\S/.test(l) && !/\(none\)/.test(l));
    record("5 related from the terminal", rel.status === 0 && neighbours.length > 0, `${neighbours.length} neighbour line(s)`, rel.out);

    // Step 5b — algorithm command with no network: nothing downloaded, nothing written to home.
    const ryu = join(homedir(), ".ryu");
    const before = snapshot(ryu);
    const gn = egr(["god-nodes", "--limit", "5"]);
    const after = snapshot(ryu);
    const newFiles = after.filter((f) => !before.includes(f));
    record("5b god-nodes offline", gn.status === 0 && /rank/.test(gn.stdout) && newFiles.length === 0,
      `exit ${gn.status}; new files under ~/.ryu: ${newFiles.length}`, `${gn.out}${newFiles.length ? `\n[new]\n${newFiles.join("\n")}` : ""}`);

    // Step 6 — the MCP `related` tool must REFUSE (refusal is the pass condition).
    const call = await mcp.request("tools/call", { name: "related", arguments: { seedId: seed } });
    const text = JSON.stringify(call.result ?? call.error ?? {});
    record("6 MCP related refuses", /needs write access/.test(text), "refusal text expected", text);
  } catch (e) {
    record("4-6 MCP session", false, e.message, mcp.stderr());
  } finally {
    await mcp.stop();
  }

  // Step 7 — graph health and the .engram listing after.
  const doc = egr(["doctor"]);
  const langLine = (doc.stdout.match(/languages:.*$/m) ?? [""])[0];
  const want = ["C", "Swift", "Bash"];
  const missing = want.filter((l) => !new RegExp(`✓ ${l}\\b`).test(doc.stdout));
  record("7a doctor", doc.status === 0 && missing.length === 0, `${langLine}${missing.length ? `; not available: ${missing.join(", ")}` : ""}`, doc.out);
  record("7b .engram after", true, "listing", listDir(join(target, ".engram")));

  // Step 8 — the three rc.5 languages index for real (separate graph, separate dir).
  const poly = mkdtempSync(join(tmpdir(), "egr-poly-"));
  mkdirSync(join(poly, "scripts"));
  writeFileSync(join(poly, "main.c"), '#include "util.h"\nint helper(int x){return x*2;}\nint main(void){return helper(1);}\n');
  writeFileSync(join(poly, "util.h"), "int helper(int x);\n");
  writeFileSync(join(poly, "Foo.swift"), "struct Foo { func a() {} }\nextension Foo { func b() { a() } }\n");
  writeFileSync(join(poly, "lib.sh"), 'log(){ echo "$1"; }\n');
  writeFileSync(join(poly, "scripts", "deploy"), "#!/usr/bin/env bash\nsource ./lib.sh\nlog hi\n");
  const env = { ENGRAM_DB: join(poly, "g.db") };
  const pi = spawnSync(process.execPath, [CLI, "index", poly], { cwd: poly, encoding: "utf8", env: { ...process.env, ...env } });
  const pt = spawnSync(process.execPath, [CLI, "top", "Function", "--limit", "10"], { cwd: poly, encoding: "utf8", env: { ...process.env, ...env } });
  const expect = ["main.c#helper", "Foo.swift#Foo.b", "lib.sh#log"];
  const absent = expect.filter((id) => !(pt.stdout ?? "").includes(id));
  const files = ((pi.stdout ?? "").match(/code: (\d+) files/) ?? [])[1];
  record("8 C / Swift / Bash index", pi.status === 0 && absent.length === 0 && files === "5",
    `files=${files} (expect 5, shebang script included)${absent.length ? `; missing: ${absent.join(", ")}` : ""}`, `${pi.stdout}\n${pt.stdout}`);
}

await main();

const failed = results.filter((r) => !r.ok);
const md = [
  `## Release verification — ${process.platform}-${process.arch}`,
  "",
  "| step | result | detail |",
  "|---|---|---|",
  ...results.map((r) => `| ${r.step} | ${r.ok ? "✅" : "❌"} | ${r.detail.replace(/\|/g, "\\|")} |`),
  "",
  failed.length ? `**${failed.length} step(s) failed.**` : "**All steps passed.**",
].join("\n");
if (args.summary) appendFileSync(args.summary, `${md}\n`);
if (args.json) writeFileSync(args.json, JSON.stringify({ platform: `${process.platform}-${process.arch}`, results }, null, 2));
console.log(`\n${md}`);
process.exit(failed.length ? 1 : 0);
