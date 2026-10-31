// SPDX-License-Identifier: MIT
// implements DEC-140
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { GraphConnection } from "../src/graph-db/connection.js";
import { readBodyStatus } from "../src/knowledge-graph/status.js";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * DEC-140 D1 - `egr lint`: two ways the replacement relations of a document set disagree with themselves.
 *
 * Everything that proves the feature runs the built `egr` CLI as a child process, over a document folder this file
 * writes, and reads the report back (--json and the text). The child runs with a preload that records every network
 * connection and every `fetch`, so "without calling any model" is observed, not assumed; and with ENGRAM_DB pointing
 * at a path that must not exist afterwards, so "does not open the graph" is observed too.
 *
 * Fixture (`docs/`), each document's front matter written out below:
 *   DEC-1   Superseded, nobody declares it                      -> class 1
 *   DEC-2   Superseded, DEC-3 declares `supersedes: [DEC-2]`    -> not reported (declared)
 *   DEC-3   Accepted; supersedes DEC-2                          -> live, and a replacement is not a "citation"
 *   DEC-4   Accepted; related: [DEC-1]                          -> class 2 (DECISION_RELATES, DEC-1 by status)
 *   DEC-5   no status                                           -> 無法判定
 *   XSPEC-1 Draft; impacted_by: [DEC-2]                         -> class 2 (IMPACTS, DEC-2 by edge and by status)
 *   XSPEC-2 Draft; impacted_by: [DEC-3]                         -> nothing (DEC-3 is live)
 *   XSPEC-9 Superseded, nobody declares it                      -> class 1 (a spec)
 *   XSPEC-10 Superseded, XSPEC-11 `supersedes: [XSPEC-10]`      -> not reported (a spec's declaration counts)
 *   README.md  no id                                            -> counted as unnamed
 */

const SUPERSEDED = "superseded-without-declaration";
const CITES = "live-cites-superseded";

let built: BuiltEgr;
let work: string;
let counter = 0;

interface Report {
  status: "findings" | "undetermined" | "clean";
  undeterminedReason?: string;
  scanned: { documents: number; named: number; unnamed: number; setAside: number };
  supersededStatuses: string[];
  findings: Array<{ rule: string; file: string; id: string; status: string; statusSource: string; reason: string; cites?: string; edge?: string; supersededBecause?: unknown[] }>;
  counts: Record<string, number>;
  undeterminable: { count: number; files: string[] };
}

function doc(dir: string, name: string, front: string, body = ""): void {
  mkdirSync(join(dir, name, ".."), { recursive: true });
  writeFileSync(join(dir, name), `---\n${front}\n---\n# ${name.replace(/\.md$/, "")}\n${body}\n`);
}

/** A fresh folder under the work directory. */
function folder(): string {
  const d = join(work, `case-${++counter}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function writeFixture(dir: string): void {
  doc(dir, "DEC-1.md", "id: DEC-1\nstatus: Superseded");
  doc(dir, "DEC-2.md", "id: DEC-2\nstatus: Superseded (replaced by DEC-3)");
  doc(dir, "DEC-3.md", "id: DEC-3\nstatus: Accepted\nsupersedes: [DEC-2]");
  doc(dir, "DEC-4.md", "id: DEC-4\nstatus: Accepted\nrelated: [DEC-1]");
  doc(dir, "DEC-5.md", "id: DEC-5");
  doc(dir, "XSPEC-1.md", "id: XSPEC-1\nstatus: Draft\nimpacted_by: [DEC-2]");
  doc(dir, "XSPEC-2.md", "id: XSPEC-2\nstatus: Draft\nimpacted_by: [DEC-3]");
  doc(dir, "XSPEC-9.md", "id: XSPEC-9\nstatus: Superseded");
  doc(dir, "XSPEC-10.md", "id: XSPEC-10\nstatus: Superseded");
  doc(dir, "XSPEC-11.md", "id: XSPEC-11\nstatus: Implemented\nsupersedes: [XSPEC-10]");
  writeFileSync(join(dir, "README.md"), "# Notes\nno id here\n");
}

/** Every file under `dir` with its hash, to prove a run changed nothing. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p.slice(dir.length)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

let netLog: string;
let neverDb: string;

function lint(args: string[], env: NodeJS.ProcessEnv = {}) {
  return runEgr(built.cli, ["lint", ...args], {
    env: { ...process.env, ENGRAM_DB: neverDb, NODE_OPTIONS: `--require ${join(work, "no-network.cjs")}`, EGR_TEST_NETLOG: netLog, ...env },
    cwd: work,
  });
}

/** Run `egr lint --json` and read the report back; `exit` is the exit status the run must have (0 = every document judged). */
function lintJson(dir: string, extra: string[] = [], exit = 0): Report {
  const r = lint([dir, "--json", ...extra]);
  expect(r.status, r.stderr).toBe(exit);
  // The report is on stdout whether it exits 0 or 1; stderr says why when it exits 1.
  if (exit === 1) expect(r.stderr).toContain("無法判定 (cannot determine)");
  return JSON.parse(r.stdout) as Report;
}

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-lint-"));
  netLog = join(work, "net.log");
  neverDb = join(work, "must-not-exist", "graph.db");
  // Records, instead of performing, every way a process in this test could reach a model: fetch, and any socket connect.
  writeFileSync(
    join(work, "no-network.cjs"),
    [
      "const fs = require('node:fs');",
      "const log = (what) => fs.appendFileSync(process.env.EGR_TEST_NETLOG, what + '\\n');",
      "globalThis.fetch = (...a) => { log('fetch ' + String(a[0])); return Promise.reject(new Error('network blocked by test')); };",
      "const net = require('node:net');",
      "const connect = net.Socket.prototype.connect;",
      "net.Socket.prototype.connect = function (...a) { log('connect ' + JSON.stringify(a[0])); return connect.apply(this, a); };",
    ].join("\n"),
  );
}, 120_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

describe("DEC-140 D1: egr lint", () => {
  it("egr lint on a docs folder reports a document whose status says superseded but has no supersedes edge pointing at it, and reports a live document that still cites a superseded decision as its basis, without calling any model", () => {
    const dir = folder();
    writeFixture(dir);
    const before = snapshot(dir);

    // DEC-5 has no status, so the run is incomplete: the full report on stdout, and exit 1 (227甲), findings or not.
    const r = lint([dir, "--json"]);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("無法判定 (cannot determine)");
    const rep = JSON.parse(r.stdout) as Report;
    expect(rep.undeterminedReason).toContain("1 of 10 named document(s)");

    // Class 1: superseded, nobody declares it - a decision and a spec. DEC-2 and XSPEC-10 ARE declared and are not here.
    const class1 = rep.findings.filter((f) => f.rule === SUPERSEDED).map((f) => `${f.id}@${f.file}`);
    expect(class1).toEqual(["DEC-1@DEC-1.md", "XSPEC-9@XSPEC-9.md"]);

    // Class 2: a live document that cites a superseded decision as basis - with the edge it becomes and why.
    const class2 = rep.findings.filter((f) => f.rule === CITES);
    expect(class2.map((f) => `${f.id}->${f.cites}:${f.edge}`)).toEqual(["DEC-4->DEC-1:DECISION_RELATES", "XSPEC-1->DEC-2:IMPACTS"]);
    const viaEdge = class2.find((f) => f.id === "XSPEC-1")!;
    expect(viaEdge.supersededBecause).toEqual([
      { by: "SUPERSEDES edge", from: "DEC-3" },
      { by: "status", status: "Superseded (replaced by DEC-3)" },
    ]);
    expect(viaEdge.reason).toContain("XSPEC-1");
    expect(viaEdge.reason).toContain("DEC-2");
    expect(viaEdge.file).toBe("XSPEC-1.md");

    // The numbers carry their denominators, and the document that could not be judged is counted, not passed.
    expect(rep.counts).toEqual({ [SUPERSEDED]: 2, [CITES]: 2 });
    expect(rep.scanned).toEqual({ documents: 11, named: 10, unnamed: 1, setAside: 0 });
    expect(rep.undeterminable).toEqual({ count: 1, files: ["DEC-5.md"] });
    expect(rep.status).toBe("findings");
    expect(rep.findings.every((f) => f.statusSource === "front-matter")).toBe(true);
    expect(rep.supersededStatuses).toContain("superseded");

    // "Without calling any model": nothing reached for the network (the log would exist), and no graph was opened or
    // written, and the documents were not touched.
    expect(existsSync(netLog), existsSync(netLog) ? readFileSync(netLog, "utf8") : "").toBe(false);
    expect(existsSync(join(work, "must-not-exist"))).toBe(false);
    expect(existsSync(join(work, ".engram"))).toBe(false);
    expect(snapshot(dir)).toEqual(before);
  });

  it("the network detector is live: the same preload records a fetch and a socket connect made by a process that does reach for the network", () => {
    const log = join(work, "control-net.log");
    const r = spawnSync(
      process.execPath,
      ["-e", "fetch('http://127.0.0.1:9/').catch(()=>{}); require('node:net').connect(9,'127.0.0.1').on('error',()=>{});"],
      { env: { ...process.env, NODE_OPTIONS: `--require ${join(work, "no-network.cjs")}`, EGR_TEST_NETLOG: log }, encoding: "utf8", timeout: 30_000 },
    );
    expect(r.status, r.stderr).toBe(0);
    const seen = readFileSync(log, "utf8");
    expect(seen).toContain("fetch http://127.0.0.1:9/");
    expect(seen).toContain("connect ");
  });

  it("prints each finding with its file and reason in the text report, and the 無法判定 number, and exits 1 because one document could not be judged", () => {
    const dir = folder();
    writeFixture(dir);
    const r = lint([dir]);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stdout).toContain(`[${SUPERSEDED}] DEC-1.md - DEC-1 has status "Superseded", but no document declares \`supersedes: DEC-1\``);
    expect(r.stdout).toContain(`[${CITES}] XSPEC-1.md - XSPEC-1 has status "Draft" and still cites DEC-2 (IMPACTS), which is superseded`);
    expect(r.stdout).toContain("findings: 4 (2 superseded-without-declaration, 2 live-cites-superseded)");
    expect(r.stdout).toContain("無法判定 (cannot determine): 1 document(s)");
    expect(r.stdout).toContain("DEC-5.md");
    expect(r.stdout).toContain("result: findings, and the answer is incomplete");
    // Declared replacements and live citations are not in the report.
    expect(r.stdout).not.toContain("DEC-2.md -");
    expect(r.stdout).not.toContain("XSPEC-10.md -");
    expect(r.stdout).not.toContain("XSPEC-2.md -");
  });

  it("does not report a superseded document that another document declares with supersedes, whether it is a decision or a spec", () => {
    const dir = folder();
    doc(dir, "DEC-7.md", "id: DEC-7\nstatus: Superseded");
    doc(dir, "DEC-8.md", "id: DEC-8\nstatus: Accepted\nsupersedes: [DEC-7]");
    doc(dir, "XSPEC-7.md", "id: XSPEC-7\nstatus: Superseded");
    doc(dir, "XSPEC-8.md", "id: XSPEC-8\nstatus: Draft\nsupersedes: [XSPEC-7]");
    const rep = lintJson(dir);
    expect(rep.findings).toEqual([]);
    expect(rep.status).toBe("clean");
    expect(rep.scanned.named).toBe(4);
  });

  it("a mention is not a declaration: a document that only relates to the superseded one still leaves it reported", () => {
    const dir = folder();
    doc(dir, "DEC-7.md", "id: DEC-7\nstatus: Superseded");
    doc(dir, "DEC-8.md", "id: DEC-8\nstatus: Accepted\nrelated: [DEC-7]\ndepends_on: [DEC-7]", "See [[DEC-7]].");
    const rep = lintJson(dir);
    expect(rep.findings.map((f) => `${f.rule}:${f.id}`)).toEqual([`${CITES}:DEC-8`, `${SUPERSEDED}:DEC-7`]);
  });

  it("reads a status with a note after the word, a second synonym, and leaves a deprecated document alone", () => {
    const dir = folder();
    doc(dir, "DEC-7.md", "id: DEC-7\nstatus: Superseded（DevAP 已退場）");
    doc(dir, "DEC-8.md", "id: DEC-8\nstatus: Replaced by something");
    doc(dir, "DEC-9.md", "id: DEC-9\nstatus: Deprecated");
    doc(dir, "DEC-10.md", "id: DEC-10\nstatus: supersededness");
    const rep = lintJson(dir);
    expect(rep.findings.map((f) => f.id)).toEqual(["DEC-7", "DEC-8"]);
  });

  it("counts a document with no readable status as 無法判定: it is not judged, not passed, and a folder of only such documents is undetermined, not clean", () => {
    const dir = folder();
    doc(dir, "DEC-1.md", "id: DEC-1");
    doc(dir, "XSPEC-1.md", "id: XSPEC-1\nstatus: unknown\nimpacted_by: [DEC-1]");
    const rep = lintJson(dir, [], 1);
    expect(rep.findings).toEqual([]);
    expect(rep.status).toBe("undetermined");
    expect(rep.undeterminable).toEqual({ count: 2, files: ["DEC-1.md", "XSPEC-1.md"] });
    expect(rep.undeterminedReason).toContain("2 of 2 named document(s)");

    const text = lint([dir]);
    expect(text.status).toBe(1);
    expect(text.stdout).toContain("無法判定 (cannot determine): 2 document(s)");
    expect(text.stdout).toContain("result: undetermined");
    expect(text.stdout).not.toContain("result: clean");
  });

  it("a status it cannot read hides nothing it can: unreadable documents do not stop the readable ones from being judged", () => {
    const dir = folder();
    doc(dir, "DEC-1.md", "id: DEC-1\nstatus: Superseded");
    doc(dir, "DEC-2.md", "id: DEC-2");
    const rep = lintJson(dir, [], 1);
    expect(rep.findings.map((f) => f.id)).toEqual(["DEC-1"]);
    expect(rep.undeterminable.files).toEqual(["DEC-2.md"]);
    expect(rep.status).toBe("findings");
  });

  it("an empty folder, and a folder with only documents that name no spec or decision, are undetermined with their denominator, never clean", () => {
    const empty = folder();
    const e = lintJson(empty, [], 1);
    expect(e.status).toBe("undetermined");
    expect(e.scanned).toEqual({ documents: 0, named: 0, unnamed: 0, setAside: 0 });
    expect(e.undeterminedReason).toContain("0 Markdown file(s)");
    const t = lint([empty]);
    expect(t.status).toBe(1);
    expect(t.stdout).toContain("lint: 0 Markdown file(s)");
    expect(t.stdout).toContain("result: undetermined");

    const onlyReadme = folder();
    writeFileSync(join(onlyReadme, "README.md"), "# nothing\n");
    const o = lintJson(onlyReadme, [], 1);
    expect(o.status).toBe("undetermined");
    expect(o.scanned).toEqual({ documents: 1, named: 0, unnamed: 1, setAside: 0 });
  });

  it("reports clean only when something was judged: consistent documents with readable statuses", () => {
    const dir = folder();
    doc(dir, "DEC-1.md", "id: DEC-1\nstatus: Accepted");
    doc(dir, "XSPEC-1.md", "id: XSPEC-1\nstatus: Draft\nimpacted_by: [DEC-1]");
    const rep = lintJson(dir);
    expect(rep).toMatchObject({ status: "clean", findings: [], undeterminable: { count: 0, files: [] } });
    expect(lint([dir]).stdout).toContain("result: clean");
  });

  it("reads the same documents as `egr index --docs`, and honours --exclude the same way", () => {
    const dir = folder();
    writeFixture(dir);
    doc(dir, "archive/DEC-20.md", "id: DEC-20\nstatus: Superseded");
    const all = lintJson(dir, [], 1);
    expect(all.findings.some((f) => f.id === "DEC-20" && f.file === "archive/DEC-20.md")).toBe(true);

    const idx = runEgr(built.cli, ["index", dir, "--docs", "--json"], { env: { ...process.env, ENGRAM_DB: join(work, `idx-${counter}.db`) }, cwd: work });
    expect(idx.status, idx.stderr).toBe(0);
    const docsScanned = (JSON.parse(idx.stdout) as { knowledge: { docsScanned: number } }).knowledge.docsScanned;
    expect(all.scanned.documents).toBe(docsScanned);

    const excluded = lintJson(dir, ["--exclude", "archive/**"], 1);
    expect(excluded.findings.some((f) => f.id === "DEC-20")).toBe(false);
    expect(excluded.scanned.documents).toBe(all.scanned.documents - 1);
  });

  it("exits 1 with a message on stderr and no report when the tool cannot run - no <dir>, or not a directory - which is not the exit of a report with findings", () => {
    const none = lint([]);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("egr: lint requires a <dir>");
    expect(none.stdout).toBe("");

    const missing = lint([join(work, "no-such-folder")]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("is not a directory");
    expect(missing.stdout).toBe("");

    const aFile = join(work, "a-file.md");
    writeFileSync(aFile, "# x\n");
    const file = lint([aFile, "--json"]);
    expect(file.status).toBe(1);
    expect(file.stdout).toBe("");

    // The other side of the line: findings over documents that were ALL judged are exit 0 (it reports, it does not
    // block); the same findings next to a document that could not be judged are exit 1.
    const judged = folder();
    writeFixture(judged);
    rmSync(join(judged, "DEC-5.md"));
    const ok = lintJson(judged);
    expect(ok.findings).toHaveLength(4);
    expect(ok.status).toBe("findings");
    expect(ok.undeterminedReason).toBeUndefined();
    const text = lint([judged]);
    expect(text.status).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain("result: findings (reported, nothing is blocked; exit 0)");
    expect(statSync(work).isDirectory()).toBe(true);
  });
});

/** A document with no status in its front matter, whose status is written in the body (the dev-platform way). */
function bodyDoc(dir: string, name: string, front: string, body: string): void {
  mkdirSync(join(dir, name, ".."), { recursive: true });
  writeFileSync(join(dir, name), `---\n${front}\n---\n# ${name.replace(/\.md$/, "")}\n\n${body}\n`);
}

describe("DEC-140 226甲: the status line in a document's opening section", () => {
  function writeBodyFixture(dir: string): void {
    // class 1 from a body status, half-width colon, bold label, qualifier after the word
    bodyDoc(dir, "DEC-31.md", "id: DEC-31", "> **狀態**: Superseded（被 DEC-32 取代）\n> **建立日期**: 2026-01-01");
    // declared by DEC-34 -> not reported; list form, English label, emoji and bold around the word
    bodyDoc(dir, "DEC-33.md", "id: DEC-33", "- **Status**: ✅ **Superseded**");
    // live, full-width colon, no `>`
    bodyDoc(dir, "DEC-34.md", "id: DEC-34\nsupersedes: [DEC-33]", "**狀態**：Accepted");
    // live by a body status with a qualifier; cites DEC-31 (superseded by its body status)
    bodyDoc(dir, "XSPEC-31.md", "id: XSPEC-31\nimpacted_by: [DEC-31]", "> **Status**: Draft（下一版）");
    // front matter says Draft, the body says Superseded: the front matter wins -> live, so it is a citer, not a class 1
    bodyDoc(dir, "XSPEC-32.md", "id: XSPEC-32\nstatus: Draft\nimpacted_by: [DEC-31]", "> **狀態**: Superseded");
    // front matter says Superseded, the body says Draft: the front matter wins -> class 1
    bodyDoc(dir, "XSPEC-33.md", "id: XSPEC-33\nstatus: Superseded", "> **狀態**: Draft");
    // the only status line comes after a `## ` heading: not a status, the document cannot be judged
    bodyDoc(dir, "XSPEC-34.md", "id: XSPEC-34", "## Notes\n\n> **狀態**: Superseded");
    // table form, in the opening section -> class 1
    bodyDoc(dir, "XSPEC-35.md", "id: XSPEC-35", "| **狀態** | Superseded（2026-10-01）|");
    // a fenced example before the real line is skipped -> live
    bodyDoc(dir, "XSPEC-36.md", "id: XSPEC-36", "```\n> **狀態**: Superseded\n```\n\n> **狀態**: 🟢 **Implemented** v1");
  }

  it("reads superseded and live statuses from the body status line, lets the front matter win, ignores a line after the first `##`, and reports which source each finding used", () => {
    const dir = folder();
    writeBodyFixture(dir);
    const rep = lintJson(dir, [], 1); // XSPEC-34 cannot be judged
    const by = (rule: string) => rep.findings.filter((f) => f.rule === rule).map((f) => `${f.id}:${f.statusSource}`);
    expect(by(SUPERSEDED)).toEqual(["DEC-31:body", "XSPEC-33:front-matter", "XSPEC-35:body"]);
    // DEC-31 is superseded by its body status, so both live citers are reported - XSPEC-32 because its front matter (Draft) beat its body.
    expect(by(CITES)).toEqual(["XSPEC-31:body", "XSPEC-32:front-matter"]);
    const c = rep.findings.find((f) => f.rule === CITES && f.id === "XSPEC-31")!;
    expect(c.status).toBe("Draft（下一版）");
    expect(c.supersededBecause).toEqual([{ by: "status", status: "Superseded（被 DEC-32 取代）" }]);
    expect(c.reason).toContain("(read from its status line)");
    // DEC-33 is declared by DEC-34, XSPEC-36's fenced line did not count, XSPEC-34's line is after a `## `.
    expect(rep.findings.some((f) => f.id === "DEC-33" || f.id === "XSPEC-36")).toBe(false);
    expect(rep.undeterminable).toEqual({ count: 1, files: ["XSPEC-34.md"] });
    expect(rep.scanned.named).toBe(9);
  });

  it("does not change what `egr index --docs` stores: a Spec whose status is only in the body is still status unknown in the graph", async () => {
    const dir = folder();
    bodyDoc(dir, "XSPEC-41.md", "id: XSPEC-41", "> **狀態**: Superseded");
    const db = join(work, `status-${counter}.db`);
    const env = { ...process.env, ENGRAM_DB: db };
    expect(runEgr(built.cli, ["index", dir, "--docs"], { env, cwd: work }).status).toBe(0);
    const conn = GraphConnection.open(db, { readOnly: true });
    try {
      const rows = await conn.query(`MATCH (n:Spec {id: 'XSPEC-41'}) RETURN n.status AS status`);
      expect(rows).toEqual([{ status: "unknown" }]);
    } finally {
      await conn.close();
    }
  });

  it("readBodyStatus: the shapes dev-platform writes, with the value cleaned and the qualifier kept", () => {
    const cases: Array<[string, string | undefined]> = [
      ["> **狀態**: Implemented", "Implemented"],
      ["**狀態**：Partially Implemented", "Partially Implemented"],
      ["- **狀態**: ✅ Implemented ✅ (UDS `1572869`)", "Implemented ✅ (UDS `1572869`)"],
      ["> **狀態**: ⚠️ Partially Implemented", "Partially Implemented"],
      ["> **狀態**: 🟢 **Implemented v1** (done)", "Implemented v1 (done)"],
      ["- **狀態**：`✅ Implemented`", "Implemented`"],
      ["> **Status**: Accepted", "Accepted"],
      ["> - **状态**: Draft（下一版）", "Draft（下一版）"],
      ["| **狀態** | Superseded |", "Superseded"],
      ["# T\n\nintro\n\n> **狀態**: Draft\n> **狀態**: Superseded", "Draft"],
      ["# T\n\n## Background\n> **狀態**: Superseded", undefined],
      ["```\n> **狀態**: Superseded\n```\n> **Status**: Draft", "Draft"],
      ["status: Superseded\nStatus: Superseded", undefined],
      ["> **狀態**:", undefined],
    ];
    for (const [body, want] of cases) expect(readBodyStatus(body), body).toBe(want);
  });

  it("the MCP tool lint returns an error result with the report when a document could not be judged, and a plain result when every document was", async () => {
    const mixed = folder();
    writeFixture(mixed); // DEC-5 has no status
    const judged = folder();
    doc(judged, "DEC-1.md", "id: DEC-1\nstatus: Superseded");
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [built.mcp], cwd: work, env: { ...process.env, ENGRAM_DB: neverDb } as Record<string, string>, stderr: "ignore" }),
    );
    try {
      type Res = { isError?: boolean; content: Array<{ text: string }> };
      const bad = (await client.callTool({ name: "lint", arguments: { dir: mixed } })) as Res;
      expect(bad.isError).toBe(true);
      const text = bad.content[0]!.text;
      expect(text).toContain("無法判定 (cannot determine)");
      const rep = JSON.parse(text.slice(0, text.lastIndexOf("\n無法判定"))) as Report;
      expect(rep.findings).toHaveLength(4);
      expect(rep.undeterminable.files).toEqual(["DEC-5.md"]);

      const good = (await client.callTool({ name: "lint", arguments: { dir: judged } })) as Res;
      expect(good.isError).not.toBe(true);
      expect((JSON.parse(good.content[0]!.text) as Report).findings.map((f) => f.id)).toEqual(["DEC-1"]);
    } finally {
      await client.close();
    }
  });
});
