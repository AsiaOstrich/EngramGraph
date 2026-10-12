// implements XSPEC-476
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { classifyLeadingRef } from "../src/knowledge-graph/linker.js";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";

/**
 * XSPEC-476 R2 — which document owns an id.
 *
 * The consumer report (Windows, portalite_enterprise): a runbook whose title was
 * "ADR-008 時區重構：Runbook" replaced the real ADR-008 in the graph, and a
 * document titled "Unattended Deploy SOP (ADR-006)" became ADR-006. The index
 * summary said 6 specs / 20 decisions where the graph held 4 / 12, because two
 * documents with one id were both counted and the last one written won.
 *
 * Rules under test:
 *   - a heading names a document only when it STARTS with the id;
 *   - several documents, one id: front-matter `id` > filename > heading, and the
 *     smaller path wins a tie, so the result does not depend on directory order;
 *   - the summary names every conflict, and its counts equal the graph's nodes.
 *
 * Everything runs through the built CLI (`egr index --docs`, `egr top`) and the
 * built MCP server (`impact_analysis`, which returns the node's title).
 */

let built: BuiltEgr;
let work: string;
let root: string;
let db: string;

function put(rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function egr(args: string[], dbPath: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [built.cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ENGRAM_DB: dbPath },
    cwd: work,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function topIds(label: "Spec" | "Decision", dbPath = db): string[] {
  const r = egr(["top", label, "--limit", "1000", "--json"], dbPath);
  expect(r.status, r.stderr).toBe(0);
  return (JSON.parse(r.stdout) as Array<{ id: string }>).map((n) => n.id).sort();
}

async function impactTitles(specId: string): Promise<Record<string, string>> {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [built.mcp],
      env: { ...process.env, ENGRAM_DB: db } as Record<string, string>,
      stderr: "ignore",
    }),
  );
  try {
    const res = (await client.callTool({ name: "impact_analysis", arguments: { nodeId: specId } })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(res.isError, res.content.map((c) => c.text).join("\n")).not.toBe(true);
    const parsed = JSON.parse(res.content[0]!.text) as { decisions: Array<{ id: string; title: string }> };
    return Object.fromEntries(parsed.decisions.map((d) => [d.id, d.title]));
  } finally {
    await client.close();
  }
}

type IndexJson = {
  knowledge: {
    specs: number;
    decisions: number;
    docsScanned: number;
    docsUnresolved: string[];
    conflicts: Array<{
      id: string;
      kept: { path: string; source: string };
      setAside: Array<{ path: string; source: string }>;
    }>;
  };
};
let indexJson: IndexJson;

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-476-r2-"));
  root = join(work, "proj");
  db = join(work, "r2.db");

  // The report's shape. The real ADR names itself by FILENAME (no front matter);
  // the runbook's title STARTS with the same id.
  put("docs/adr/ADR-008-time-zone.md", "# Time zone policy\n\nStore UTC, render local. Impacts [[SPEC-1]].\n");
  put("docs/runbooks/tz-runbook.md", "# ADR-008 時區重構：Runbook\n\nMigration steps. See [[SPEC-2]].\n");
  // Mentions an id in passing — it is about ADR-006, it is not ADR-006.
  put("docs/runbooks/deploy-sop.md", "# Unattended Deploy SOP (ADR-006)\n\nNothing links here.\n");
  put("docs/specs/SPEC-1-login.md", "# SPEC-1 Login\n\nThe login spec.\n");
  // This repo's own heading style: the id in square brackets, first.
  put("docs/specs/fix-notes.md", "# [XSPEC-476] Fix: consumer findings\n\nNotes.\n");
  // front-matter id (earlier path) against a filename (later path): front matter must win
  // even though the other document is written last.
  put("docs/p1/notes.md", "---\nid: ADR-009\n---\n# Named by front matter\n\nImpacts [[SPEC-1]].\n");
  put("docs/p2/ADR-009-by-name.md", "# Named by file\n\nImpacts [[SPEC-1]].\n");
  // Same source, same id: the smaller path wins.
  put("docs/t1/a.md", "# ADR-010 First\n\nImpacts [[SPEC-1]].\n");
  put("docs/t2/b.md", "# ADR-010 Second\n\nImpacts [[SPEC-1]].\n");

  const r = egr(["index", root, "--docs", "--json"], db);
  if (r.status !== 0) throw new Error(`fixture index failed: ${r.stderr}`);
  indexJson = JSON.parse(r.stdout) as IndexJson;
}, 180_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

describe("XSPEC-476 R2: a heading names a document only when it starts with the id", () => {
  it("a runbook titled 'ADR-008 …' does not replace the ADR whose filename is ADR-008 [xspec476-r2-adr-kept]", async () => {
    const titles = await impactTitles("SPEC-1");
    expect(titles["ADR-008"]).toBe("Time zone policy");
    expect(JSON.stringify(titles)).not.toContain("Runbook");
    // The runbook's own link did not reach the graph either: SPEC-2 exists nowhere else.
    expect(topIds("Spec")).not.toContain("SPEC-2");
  });

  it("a document that only mentions an id mid-title gets no node for it [xspec476-r2-mid-title]", () => {
    expect(topIds("Decision")).not.toContain("ADR-006");
    expect(indexJson.knowledge.docsUnresolved).toContain("docs/runbooks/deploy-sop.md");
  });

  it("a title with the id in square brackets first, as this repo's own specs write it, is still taken [xspec476-r2-bracketed]", () => {
    expect(topIds("Spec")).toContain("XSPEC-476");
  });

  it("classifyLeadingRef's boundary: decoration before the id is fine, any word before it is not", () => {
    expect(classifyLeadingRef("[XSPEC-476] Fix: x")?.id).toBe("XSPEC-476");
    expect(classifyLeadingRef("**ADR-5** decision")?.id).toBe("ADR-5");
    expect(classifyLeadingRef("ADR-008 時區重構")?.id).toBe("ADR-008");
    expect(classifyLeadingRef("Unattended Deploy SOP (ADR-006)")).toBeNull();
    expect(classifyLeadingRef("Re: ADR-008")).toBeNull();
    expect(classifyLeadingRef("2026 notes on SPEC-5")).toBeNull();
  });
});

describe("XSPEC-476 R2: one owner per id, a fixed priority, every conflict listed", () => {
  it("front-matter id beats filename, which beats heading, and a tie goes to the smaller path [xspec476-r2-priority]", async () => {
    const titles = await impactTitles("SPEC-1");
    expect(titles["ADR-009"]).toBe("Named by front matter"); // front matter, though written first
    expect(titles["ADR-010"]).toBe("ADR-010 First"); // same source: docs/t1 < docs/t2
    expect(titles["ADR-008"]).toBe("Time zone policy"); // filename beats heading
  });

  it("--json lists each conflict with the kept and the set-aside documents and their id sources [xspec476-r2-json-conflicts]", () => {
    const byId = Object.fromEntries(indexJson.knowledge.conflicts.map((c) => [c.id, c]));
    expect(Object.keys(byId).sort()).toEqual(["ADR-008", "ADR-009", "ADR-010"]);
    expect(byId["ADR-008"]!.kept).toEqual({ path: "docs/adr/ADR-008-time-zone.md", source: "filename" });
    expect(byId["ADR-008"]!.setAside).toEqual([{ path: "docs/runbooks/tz-runbook.md", source: "heading" }]);
    expect(byId["ADR-009"]!.kept).toEqual({ path: "docs/p1/notes.md", source: "front-matter" });
    expect(byId["ADR-009"]!.setAside).toEqual([{ path: "docs/p2/ADR-009-by-name.md", source: "filename" }]);
    expect(byId["ADR-010"]!.kept.path).toBe("docs/t1/a.md");
  });

  it("the summary's node counts equal the nodes the graph holds, and the text warning names both files [xspec476-r2-summary]", () => {
    // Counts: read back from the graph, not from the same object that printed them.
    const specs = topIds("Spec");
    const decisions = topIds("Decision");
    expect(decisions).toEqual(["ADR-008", "ADR-009", "ADR-010"]);
    expect(indexJson.knowledge.decisions).toBe(decisions.length);
    expect(indexJson.knowledge.specs).toBe(specs.length);

    // Human output, into a fresh graph.
    const text = egr(["index", root, "--docs"], join(work, "r2-text.db"));
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/knowledge: 2 specs, 3 decisions/);
    expect(text.stdout).toContain("9 doc(s) scanned, 1 unnamed, 3 set aside: duplicate id");
    const warning = text.stdout.split("\n").find((l) => l.includes("ADR-008") && l.includes("WARNING"));
    expect(warning, text.stdout).toBeDefined();
    expect(warning).toContain("kept docs/adr/ADR-008-time-zone.md (filename)");
    expect(warning).toContain("set aside docs/runbooks/tz-runbook.md (heading)");
  });
});

describe("XSPEC-476 R2: the winner does not depend on the order documents arrive in", () => {
  it("two headings claiming one id: the smaller path is kept whichever came first [xspec476-r2-tie-order]", async () => {
    // Library level on purpose: the CLI's directory walk hands documents over in
    // path order, so only a direct caller (the MCP `index_docs` tool, the library
    // API) can present them the other way round.
    const { SpecDecisionKnowledgeSource } = await import("../src/knowledge-graph/parser.js");
    const docs = [
      { content: "# ADR-010 Second\n", fallbackId: "docs/t2/b.md" },
      { content: "# ADR-010 First\n", fallbackId: "docs/t1/a.md" },
    ];
    for (const order of [docs, [...docs].reverse()]) {
      const src = new SpecDecisionKnowledgeSource(order);
      const fragment = await src.ingest();
      expect(fragment.nodes.filter((n) => n.id === "ADR-010")).toHaveLength(1);
      expect(src.conflicts).toHaveLength(1);
      expect(src.conflicts[0]!.kept.path).toBe("docs/t1/a.md");
      expect(fragment.nodes.find((n) => n.id === "ADR-010")!.properties.title).toBe("ADR-010 First");
    }
  });
});
