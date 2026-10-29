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
 *                                                  [--package-dir <dir> [--dist <subdir>]]
 *
 * By default it uses the globally installed package (`npm root -g`), not this
 * checkout — the thing under test is what users install. Every check prints its
 * raw output; a failure names the step and what it saw.
 *
 * `--package-dir` / `--dist` point it at a package directory instead (default
 * `dist` inside it). They exist so `test/windows-release-verify.test.ts` can run
 * THIS script, every step, against a build of the current `src/` — nothing else
 * ever ran it before a release, so the strings it matches on product output
 * (the MCP refusal, `top`, `related`, `doctor`, `index` lines) went stale
 * unnoticed and the first run was the one on a Windows machine after publishing.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The refusal's wording is defined next to the server that says it, not copied
// here — see that file for the failure this replaced.
import { isReadOnlyRefusal } from "../src/mcp/read-only-refusal.mjs";

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

/**
 * A step that could not run here. It is neither a pass nor a failure: `ok` is `null`, the line says
 * NOT RUN, and the summary counts it. It exists so that "this machine cannot do X" (a version that
 * predates the feature, a filesystem that will not make a link) is written down instead of passing
 * for a check that happened. It never lets a step that COULD run off the hook.
 */
function recordNotRun(step, detail) {
  results.push({ step, ok: null, skipped: true, detail, raw: "" });
  console.log(`NOT RUN  ${step} — ${detail}`);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const globalRoot = args["package-dir"]
  ? resolve(args["package-dir"], "node_modules")
  : spawnSync(npm, ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32" }).stdout.trim();
const pkgDir = args["package-dir"] ? resolve(args["package-dir"]) : join(globalRoot, "engramgraph");
const distDir = join(pkgDir, args.dist ?? "dist");
const CLI = join(distDir, "cli", "index.js");
const MCP = join(distDir, "mcp", "stdio.js");

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

    // Step 6 — the MCP `related` tool must not work through the read-only server. It can fail in two ways, and
    // both are a pass: releases up to 0.13.0-beta.4 list the tool and REFUSE the call (isError + the refusal
    // phrase); from beta.5 (XSPEC-481 R3) the tool is not offered at all and calling it is an error. What is
    // never a pass: the tool is listed and answers, or it is not listed and the call still succeeds.
    // This script judges released packages too (`latest` is 0.12.x), so it has to understand both.
    const listed = await mcp.request("tools/list", {});
    const offers = (listed.result?.tools ?? []).some((t) => t.name === "related");
    const call = await mcp.request("tools/call", { name: "related", arguments: { seedId: seed } });
    const text = JSON.stringify(call.result ?? call.error ?? {});
    const refused = isReadOnlyRefusal(call.result);
    const failedUnoffered = !offers && (call.error !== undefined || call.result?.isError === true);
    record(
      "6 MCP related is not usable here (refused, or not offered)",
      offers ? refused : failedUnoffered,
      offers
        ? `listed in tools/list; read-only refusal expected (isError + the refusal phrase): ${refused ? "got it" : "did not get it"}`
        : `not listed in tools/list; calling it ${failedUnoffered ? "failed" : "SUCCEEDED"}`,
      text,
    );
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

  // Steps 9-11 — 0.14.0's incremental index and per-root ids (XSPEC-508 R6). Everything in them is a path
  // computation (relative paths, real paths, the state file's location), which is where Windows differs.
  incrementalSteps(v.stdout);
}

// ---------------------------------------------------------------------------------------------------
// Steps 9-11: `egr index --incremental` and root-qualified ids (XSPEC-508 R6).
//
// The graph is read back through the CLI a user has (`top`, `callees`, `implemented-by`), never from
// the engine's files: what is judged is what the product answers, on this machine's paths.
// ---------------------------------------------------------------------------------------------------

/** Run the egr under test against `db`, from `cwd`. */
function egrDb(cwd, db, argv) {
  const r = spawnSync(process.execPath, [CLI, ...argv], { cwd, encoding: "utf8", env: { ...process.env, ENGRAM_DB: db } });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`.trim(), stdout: r.stdout ?? "" };
}

function jsonOf(r) {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return undefined;
  }
}

/** Every Function id in the graph, sorted (`top` reads at most 1000; these fixtures hold a handful). */
function graphFunctionIds(cwd, db) {
  const rows = jsonOf(egrDb(cwd, db, ["top", "Function", "--limit", "1000", "--json"]));
  if (!Array.isArray(rows)) throw new Error("`egr top Function --json` did not print a JSON array");
  return rows.map((r) => r.id).sort();
}

/**
 * Every CALLS edge out of the given Functions, as "<caller name> -> <callee id>", sorted: one `callees` per
 * distinct name. `callees` takes a NAME, not an id, so two Functions of one name (the same name in two roots)
 * share one query and their targets are listed together; the fixtures give each root a function of its own
 * name that calls the shared one, which is what tells the roots' edges apart.
 */
function graphCallEdges(cwd, db, functionIds) {
  const edges = [];
  const names = [...new Set(functionIds.map((id) => id.slice(id.indexOf("#") + 1)))];
  for (const name of names) {
    const r = egrDb(cwd, db, ["callees", name, "--json"]);
    const rows = jsonOf(r);
    if (r.status !== 0 || !Array.isArray(rows)) throw new Error(`\`egr callees ${name} --json\` failed: ${r.out}`);
    for (const row of rows) edges.push(`${name} -> ${row.id}`);
  }
  return edges.sort();
}

/** Is there a Module whose id is exactly `id`? (`implemented-by` also resolves a suffix; that is not "exactly".) */
function graphHasModule(cwd, db, id) {
  const r = egrDb(cwd, db, ["implemented-by", id, "--json"]);
  const j = jsonOf(r);
  return r.status === 0 && j?.moduleFound === true && j.module === id && j.resolvedFrom === undefined;
}

const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const diffNote = (label, got, want) => (sameList(got, want) ? "" : `\n  ${label}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

function incrementalSteps(versionText) {
  const [major, minor] = (versionText.match(/(\d+)\.(\d+)\.\d+/) ?? []).slice(1).map(Number);
  const shouldHaveIt = major > 0 || minor >= 14;
  const hasIt = egr(["--help"]).stdout.includes("--incremental");
  if (!hasIt) {
    if (shouldHaveIt) {
      record("9 incremental index", false, `egr ${versionText.trim()} should have \`index --incremental\` (0.14.0) and its --help does not mention it`);
    } else {
      recordNotRun("9-11 incremental index", `egr ${versionText.trim()} predates \`index --incremental\` (0.14.0); nothing to verify`);
    }
    return;
  }

  const work = mkdtempSync(join(tmpdir(), "egr-inc-"));
  try {
    incrementalOneRoot(work);
    twoRootsSharingAPath(work);
  } catch (e) {
    record("9-11 incremental session", false, `threw before finishing: ${e.message}`);
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      // a temp dir that will not go away is not a verification result
    }
  }
}

/** Steps 9a-9c: one root, edited between two `--incremental` runs; compared with a full rebuild. */
function incrementalOneRoot(work) {
  const proj = join(work, "proj");
  mkdirSync(join(proj, "src"), { recursive: true });
  const db = join(work, "inc.db");
  const full = join(work, "full.db");
  const statePath = `${db.replace(/\.db$/, "")}.incremental-state.json`;
  const src = (name) => join(proj, "src", name);
  const fn = (file, name) => `src/${file}#${name}`;

  writeFileSync(src("a.ts"), "export function alpha() { return beta(); }\nexport function beta() { return 1; }\n");
  writeFileSync(src("b.ts"), "export function gone() { return alpha(); }\n");
  // keep() calls fresh(), which does not exist yet: the edge must appear when d.ts is added, though c.ts never changes.
  writeFileSync(src("c.ts"), "export function keep() { return fresh(); }\n");

  // 9a — the first --incremental run indexes in full and leaves the state the next run needs.
  const r1 = egrDb(proj, db, ["index", proj, "--incremental"]);
  const f1 = graphFunctionIds(proj, db);
  const want1 = [fn("a.ts", "alpha"), fn("a.ts", "beta"), fn("b.ts", "gone"), fn("c.ts", "keep")].sort();
  const e1 = graphCallEdges(proj, db, f1);
  const wantE1 = [`alpha -> ${fn("a.ts", "beta")}`, `gone -> ${fn("a.ts", "alpha")}`].sort();
  const full1 = /incremental: indexed in full/.test(r1.out);
  const state1 = existsSync(statePath);
  record(
    "9a incremental: first run indexes in full and saves state",
    r1.status === 0 && full1 && state1 && sameList(f1, want1) && sameList(e1, wantE1),
    `exit ${r1.status}; "incremental: indexed in full" printed=${full1}; state file exists=${state1}; read back ${f1.length} Function(s) and ${e1.length} CALLS edge(s)` +
      diffNote("Functions", f1, want1) + diffNote("edges", e1, wantE1),
    r1.out,
  );
  if (r1.status !== 0) return;

  // 9b — change one file, add one, delete one; the second run must not fall back to a full index.
  writeFileSync(src("a.ts"), "export function alpha() { return betaV2(); }\nexport function betaV2() { return 2; }\n");
  writeFileSync(src("d.ts"), "export function fresh() { return 4; }\n");
  rmSync(src("b.ts"));
  const r2 = egrDb(proj, db, ["index", proj, "--incremental"]);
  const m = r2.out.match(/incremental: (\d+) file\(s\) parsed \((\d+) changed, (\d+) new\), (\d+) reused unchanged, (\d+) removed/);
  const counts = m ? m.slice(1).map(Number) : [];
  const countsOk = Boolean(m) && !/indexed in full/.test(r2.out) && counts[0] === 2 && counts[1] === 1 && counts[2] === 1 && counts[3] === 1 && counts[4] === 1;
  const f2 = graphFunctionIds(proj, db);
  const want2 = [fn("a.ts", "alpha"), fn("a.ts", "betaV2"), fn("c.ts", "keep"), fn("d.ts", "fresh")].sort();
  const e2 = graphCallEdges(proj, db, f2);
  const wantE2 = [`alpha -> ${fn("a.ts", "betaV2")}`, `keep -> ${fn("d.ts", "fresh")}`].sort();
  const present = ["src/a.ts", "src/c.ts", "src/d.ts"].filter((id) => graphHasModule(proj, db, id));
  const bGone = !graphHasModule(proj, db, "src/b.ts");
  record(
    "9b incremental: edit + add + delete is applied without a full index",
    r2.status === 0 && countsOk && sameList(f2, want2) && sameList(e2, wantE2) && present.length === 3 && bGone,
    `exit ${r2.status}; summary ${m ? `parsed=${counts[0]} changed=${counts[1]} new=${counts[2]} reused=${counts[3]} removed=${counts[4]} (wanted 2/1/1/1/1)` : "line not found"}; ` +
      `Modules present ${present.join(",") || "(none)"} (wanted a,c,d), src/b.ts gone=${bGone}; read back ${f2.length} Function(s), ${e2.length} edge(s)` +
      diffNote("Functions", f2, want2) + diffNote("edges", e2, wantE2),
    r2.out,
  );

  // 9c — the incremental graph equals a plain full index of the same sources, in a throwaway DB.
  const rf = egrDb(proj, full, ["index", proj]);
  const ff = graphFunctionIds(proj, full);
  const ef = graphCallEdges(proj, full, ff);
  const modulesAgree = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"].every((id) => graphHasModule(proj, db, id) === graphHasModule(proj, full, id));
  record(
    "9c incremental graph equals a full rebuild",
    rf.status === 0 && sameList(f2, ff) && sameList(e2, ef) && modulesAgree,
    `compared Function ids (${f2.length} vs ${ff.length}), CALLS edges via callees of every Function (${e2.length} vs ${ef.length}) and presence of 4 Module ids; ` +
      `node properties, confidence and the other edge types are NOT compared` + diffNote("Functions", f2, ff) + diffNote("edges", e2, ef) +
      (modulesAgree ? "" : "\n  Module presence differs"),
    rf.out,
  );
}

/** Steps 10a-10b and 11: two roots with the same relative path in one graph, then the same root through a link. */
function twoRootsSharingAPath(work) {
  const db = join(work, "roots.db");
  const rootA = join(work, "root-a");
  const rootB = join(work, "root-b");
  for (const r of [rootA, rootB]) mkdirSync(join(r, "src"), { recursive: true });
  // entry and helper have the same name and path in both roots (the collision); onlyA / onlyB each call their own root's entry.
  const bodyOf = (only) => `export function entry() { return helper(); }\nexport function helper() { return 1; }\nexport function ${only}() { return entry(); }\n`;
  writeFileSync(join(rootA, "src", "index.ts"), bodyOf("onlyA"));
  writeFileSync(join(rootB, "src", "index.ts"), bodyOf("onlyB"));

  const ia = egrDb(work, db, ["index", rootA, "--incremental"]);
  const ib = egrDb(work, db, ["index", rootB, "--incremental"]);
  const ids = graphFunctionIds(work, db);
  const plain = ids.filter((id) => id.startsWith("src/index.ts#"));
  const other = ids.filter((id) => !id.startsWith("src/index.ts#"));
  const qualifiedModule = other[0]?.slice(0, other[0].indexOf("#"));
  const nameOf = (id) => id.slice(id.indexOf("#") + 1);
  const qualifiedOk = Boolean(qualifiedModule) && qualifiedModule.endsWith("/src/index.ts") && other.every((id) => id.startsWith(`${qualifiedModule}#`));
  const wantPlain = ["src/index.ts#entry", "src/index.ts#helper", "src/index.ts#onlyA"];
  const wantOther = qualifiedOk ? [`${qualifiedModule}#entry`, `${qualifiedModule}#helper`, `${qualifiedModule}#onlyB`] : [];
  const edges = graphCallEdges(work, db, ids);
  const wantEdges = qualifiedOk
    ? [
        "entry -> src/index.ts#helper",
        `entry -> ${qualifiedModule}#helper`,
        "onlyA -> src/index.ts#entry",
        `onlyB -> ${qualifiedModule}#entry`,
      ].sort()
    : [];
  const bothModules = graphHasModule(work, db, "src/index.ts") && qualifiedOk && graphHasModule(work, db, qualifiedModule);
  const saidSo = /root-qualified ids/.test(ib.out);
  record(
    "10a two roots with the same relative path keep two Modules, each with only its own functions",
    ia.status === 0 && ib.status === 0 && saidSo && qualifiedOk && bothModules && sameList(plain, wantPlain) && sameList(other.sort(), wantOther) && sameList(edges, wantEdges),
    `index prints the root-qualified ids line=${saidSo}; Module \`src/index.ts\` and \`${qualifiedModule ?? "(none)"}\` both exist=${bothModules}; ` +
      `first root has ${plain.map(nameOf).join(",")}, second root has ${other.map(nameOf).join(",")}; ${edges.length} CALLS edge(s), each calling its own root's function` +
      diffNote("first root", plain, wantPlain) + diffNote("second root", other, wantOther) + diffNote("edges", edges, wantEdges),
    `${ia.out}\n---\n${ib.out}`,
  );
  if (!qualifiedOk) return;

  // 10b — running either root again changes nothing it should not, and an edit reaches only its own root.
  const ra = egrDb(work, db, ["index", rootA, "--incremental"]);
  const rb = egrDb(work, db, ["index", rootB, "--incremental"]);
  const still = (r) => /incremental: 0 file\(s\) parsed \(0 changed, 0 new\)/.test(r.out) && !/indexed in full/.test(r.out);
  const idsAgain = graphFunctionIds(work, db);
  writeFileSync(join(rootB, "src", "index.ts"), `${bodyOf("onlyB")}export function onlyB2() { return 3; }\n`);
  const rb2 = egrDb(work, db, ["index", rootB, "--incremental"]);
  const idsEdited = graphFunctionIds(work, db);
  const wantEdited = [...wantPlain, ...wantOther, `${qualifiedModule}#onlyB2`].sort();
  const edit = rb2.out.match(/incremental: (\d+) file\(s\) parsed \((\d+) changed, (\d+) new\)/);
  record(
    "10b second root: re-run is a no-op, an edit stays in its own root",
    ra.status === 0 && rb.status === 0 && rb2.status === 0 && still(ra) && still(rb) && sameList(idsAgain, ids) &&
      Boolean(edit) && edit[1] === "1" && edit[2] === "1" && edit[3] === "0" && !/indexed in full/.test(rb2.out) && sameList(idsEdited, wantEdited),
    `unchanged re-run parsed 0 files in both roots=${still(ra) && still(rb)}; ids unchanged=${sameList(idsAgain, ids)}; ` +
      `after editing the second root: ${edit ? `${edit[1]} parsed (${edit[2]} changed, ${edit[3]} new)` : "summary line not found"}, ids ${idsEdited.length} (wanted ${wantEdited.length})` +
      diffNote("ids after edit", idsEdited, wantEdited),
    `${ra.out}\n---\n${rb.out}\n---\n${rb2.out}`,
  );

  // 11 — the first root again, reached through a directory link, is the same root: no second copy of it.
  const link = join(work, "root-a-link");
  try {
    // A "junction" is what Windows makes without administrator rights; on POSIX it is an ordinary directory symlink.
    symlinkSync(rootA, link, process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    recordNotRun("11 a link to an indexed root is the same root", `could not create a ${process.platform === "win32" ? "junction" : "symlink"} here (${e.code ?? e.message}); this was not checked`);
    return;
  }
  const il = egrDb(work, db, ["index", link, "--incremental"]);
  const idsLinked = graphFunctionIds(work, db);
  const noSecondCopy = !/root-qualified ids/.test(il.out) && !/WARNING/.test(il.out);
  record(
    "11 a link to an indexed root is the same root",
    il.status === 0 && noSecondCopy && sameList(idsLinked, idsEdited),
    `exit ${il.status}; no root-qualified ids / WARNING line=${noSecondCopy}; Function ids unchanged (${idsLinked.length} vs ${idsEdited.length})` +
      diffNote("ids after the link run", idsLinked, idsEdited),
    il.out,
  );
}

await main();

const failed = results.filter((r) => r.ok === false);
const notRun = results.filter((r) => r.skipped);
const md = [
  `## Release verification — ${process.platform}-${process.arch}`,
  "",
  "| step | result | detail |",
  "|---|---|---|",
  ...results.map((r) => `| ${r.step} | ${r.skipped ? "⏭️ NOT RUN" : r.ok ? "✅" : "❌"} | ${r.detail.replace(/\|/g, "\\|")} |`),
  "",
  failed.length ? `**${failed.length} step(s) failed.**` : notRun.length ? "**No step failed.**" : "**All steps passed.**",
  ...(notRun.length ? ["", `**${notRun.length} step(s) NOT RUN — not verified: ${notRun.map((r) => r.step).join("; ")}.**`] : []),
].join("\n");
if (args.summary) appendFileSync(args.summary, `${md}\n`);
if (args.json) writeFileSync(args.json, JSON.stringify({ platform: `${process.platform}-${process.arch}`, results }, null, 2));
console.log(`\n${md}`);
process.exit(failed.length ? 1 : 0);
