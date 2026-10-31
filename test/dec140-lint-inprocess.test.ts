// SPDX-License-Identifier: MIT
// implements DEC-140
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SUPERSEDED_STATUSES, formatLint, lintKnowledgeDocs, type LintReport } from "../src/knowledge-graph/lint.js";
import { readBodyStatus } from "../src/knowledge-graph/status.js";
import type { KnowledgeDoc } from "../src/knowledge-graph/types.js";
import { cmdLint, collectKnowledgeDocs } from "../src/cli/run.js";

/**
 * DEC-140 D1 `egr lint`, asked in this process.
 *
 * `kg-consistency-lint.test.ts` proves the feature through the built CLI and the stdio MCP server, as a user meets
 * it. A child process is not counted by the coverage gate, so this file gives the same functions the same kind of
 * documents here and reads the report back: `lintKnowledgeDocs` (the verdict), `formatLint` (the text a person
 * reads), `cmdLint` and `collectKnowledgeDocs` (what the CLI calls), and `readBodyStatus`.
 * It adds the cases a CLI run is slow or awkward for: duplicate ids, a status word that only starts like
 * "superseded", a stub decision nobody scanned, and a long list of documents that could not be judged.
 */

const work = mkdtempSync(join(tmpdir(), "egr-lint-inproc-"));
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** A document as `egr index --docs` hands it over: front matter, a title, optional body. */
function md(id: string | null, front: string, body = ""): KnowledgeDoc {
  const idLine = id === null ? "" : `id: ${id}\n`;
  return { content: `---\n${idLine}${front}\n---\n# ${id ?? "untitled"}\n${body}\n`, fallbackId: `${id ?? "untitled"}.md` };
}

const rules = (r: LintReport) => r.findings.map((f) => `${f.rule}:${f.id}${f.cites ? `->${f.cites}` : ""}`);

describe("DEC-140: lintKnowledgeDocs reads declarations, not edges", () => {
  it("a superseded document nobody declares is reported once, with the status it read and where [dec140-inproc-class1]", async () => {
    const r = await lintKnowledgeDocs([md("DEC-1", "status: Superseded"), md("DEC-2", "status: Accepted")]);
    expect(rules(r)).toEqual(["superseded-without-declaration:DEC-1"]);
    const f = r.findings[0]!;
    expect(f.status).toBe("Superseded");
    expect(f.statusSource).toBe("front-matter");
    expect(f.file).toBe("DEC-1.md");
    expect(f.reason).toContain('DEC-1 has status "Superseded"');
    expect(f.reason).toContain("supersedes: DEC-1");
    expect(f.reason).not.toContain("status line");
    expect(r.status).toBe("findings");
    expect(r.undeterminedReason).toBeUndefined();
    expect(r.counts).toEqual({ "superseded-without-declaration": 1, "live-cites-superseded": 0 });
  });

  it("a declaration by any document clears it, whether the declarer is a decision or a spec [dec140-inproc-declared]", async () => {
    const r = await lintKnowledgeDocs([
      md("DEC-1", "status: Superseded"),
      md("DEC-2", "status: Accepted\nsupersedes: [DEC-1]"),
      md("XSPEC-1", "status: Superseded"),
      md("XSPEC-2", "status: Implemented\nsupersedes: [XSPEC-1]"),
    ]);
    expect(r.findings).toEqual([]);
    expect(r.status).toBe("clean");
    expect(r.scanned).toEqual({ documents: 4, named: 4, unnamed: 0, setAside: 0 });
  });

  it("the status word is matched at a word boundary: 'Supersededly' is not superseded, 'Superseded（note）' and '已取代' are [dec140-inproc-boundary]", async () => {
    const r = await lintKnowledgeDocs([
      md("DEC-1", "status: Supersededly"),
      md("DEC-2", "status: Superseded（DevAP 已退場）"),
      md("DEC-3", "status: 已取代"),
      md("DEC-4", "status: Replaced"),
      md("DEC-5", "status: Deprecated"),
    ]);
    expect(rules(r).sort()).toEqual([
      "superseded-without-declaration:DEC-2",
      "superseded-without-declaration:DEC-3",
      "superseded-without-declaration:DEC-4",
    ]);
    expect(SUPERSEDED_STATUSES).toContain("被取代");
  });

  it("a live document that cites a superseded decision names the edge and why, by edge and by status [dec140-inproc-class2]", async () => {
    const r = await lintKnowledgeDocs([
      md("DEC-1", "status: Superseded"),
      md("DEC-2", "status: Accepted\nsupersedes: [DEC-1]"),
      md("XSPEC-1", "status: Draft\nimpacted_by: [DEC-1]"),
      md("DEC-3", "status: Accepted\nrelated: [DEC-1]"),
    ]);
    expect(rules(r)).toEqual(["live-cites-superseded:DEC-3->DEC-1", "live-cites-superseded:XSPEC-1->DEC-1"]);
    const spec = r.findings.find((f) => f.id === "XSPEC-1")!;
    expect(spec.edge).toBe("IMPACTS");
    expect(spec.supersededBecause).toEqual([
      { by: "SUPERSEDES edge", from: "DEC-2" },
      { by: "status", status: "Superseded" },
    ]);
    expect(spec.reason).toContain("DEC-2 declares `supersedes: DEC-1` and its status is \"Superseded\"");
    const dec = r.findings.find((f) => f.id === "DEC-3")!;
    expect(dec.edge).toBe("DECISION_RELATES");
  });

  it("a superseded document citing a superseded decision is not a live citer, and one decision cited twice is reported once [dec140-inproc-class2-once]", async () => {
    const r = await lintKnowledgeDocs([
      md("DEC-1", "status: Superseded"),
      md("DEC-2", "status: Accepted\nsupersedes: [DEC-1]"),
      md("DEC-3", "status: Superseded\nrelated: [DEC-1]"),
      md("XSPEC-1", "status: Draft\nimpacted_by: [DEC-1]", "See [[DEC-1]] again and [[DEC-1]]."),
    ]);
    const citers = r.findings.filter((f) => f.rule === "live-cites-superseded");
    expect(citers.map((f) => f.id)).toEqual(["XSPEC-1"]);
    // DEC-3 is itself superseded without a declaration: class 1, not class 2.
    expect(rules(r)).toContain("superseded-without-declaration:DEC-3");
  });

  it("a decision cited but never scanned has no status to read: it is not 'unreadable', and it is superseded only if a scanned document declares it [dec140-inproc-stub]", async () => {
    const stubOnly = await lintKnowledgeDocs([md("XSPEC-1", "status: Draft\nimpacted_by: [DEC-77]")]);
    expect(stubOnly.findings).toEqual([]);
    expect(stubOnly.undeterminable).toEqual({ count: 0, files: [] });
    expect(stubOnly.status).toBe("clean");

    const declared = await lintKnowledgeDocs([
      md("XSPEC-1", "status: Draft\nimpacted_by: [DEC-77]"),
      md("DEC-78", "status: Accepted\nsupersedes: [DEC-77]"),
    ]);
    const f = declared.findings.find((x) => x.rule === "live-cites-superseded")!;
    expect(f.cites).toBe("DEC-77");
    expect(f.supersededBecause).toEqual([{ by: "SUPERSEDES edge", from: "DEC-78" }]);
  });

  it("findings are ordered by rule, then file, then cited id, so two runs read the same [dec140-inproc-order]", async () => {
    const r = await lintKnowledgeDocs([
      md("DEC-9", "status: Superseded"),
      md("DEC-1", "status: Superseded"),
      md("DEC-2", "status: Accepted\nsupersedes: [DEC-5]"),
      md("DEC-5", "status: Superseded"),
      md("XSPEC-B", "status: Draft\nimpacted_by: [DEC-5, DEC-2]"),
      md("XSPEC-A", "status: Draft\nimpacted_by: [DEC-5]"),
    ]);
    expect(rules(r)).toEqual([
      "live-cites-superseded:XSPEC-A->DEC-5",
      "live-cites-superseded:XSPEC-B->DEC-5",
      "superseded-without-declaration:DEC-1",
      "superseded-without-declaration:DEC-9",
    ]);
  });
});

describe("DEC-140: a status it cannot read is not a pass", () => {
  it("no status in the front matter or the opening section is 無法判定; a report with any is undetermined, never clean [dec140-inproc-undeterminable]", async () => {
    const r = await lintKnowledgeDocs([md("DEC-1", ""), md("DEC-2", "status: unknown"), md("DEC-3", "status: Accepted")]);
    expect(r.undeterminable).toEqual({ count: 2, files: ["DEC-1.md", "DEC-2.md"] });
    expect(r.status).toBe("undetermined");
    expect(r.undeterminedReason).toBe("2 of 3 named document(s) have no status in their front matter or opening section and were not judged");
    expect(r.findings).toEqual([]);
  });

  it("findings and an unreadable document together are 'findings' with the incomplete reason still set [dec140-inproc-findings-and-undetermined]", async () => {
    const r = await lintKnowledgeDocs([md("DEC-1", "status: Superseded"), md("DEC-2", "")]);
    expect(r.status).toBe("findings");
    expect(r.undeterminedReason).toContain("1 of 2 named document(s)");
  });

  it("no document that names a spec or decision is undetermined with the denominator, however many files were scanned [dec140-inproc-empty]", async () => {
    const none = await lintKnowledgeDocs([]);
    expect(none.status).toBe("undetermined");
    expect(none.undeterminedReason).toContain("among the 0 Markdown file(s) scanned");
    const unnamed = await lintKnowledgeDocs([
      { content: "# Notes\nno id\n", fallbackId: "README.md" },
      { content: "# More\nnothing\n", fallbackId: "CHANGELOG.md" },
    ]);
    expect(unnamed.status).toBe("undetermined");
    expect(unnamed.scanned).toEqual({ documents: 2, named: 0, unnamed: 2, setAside: 0 });
    expect(unnamed.undeterminedReason).toContain("among the 2 Markdown file(s) scanned");
  });

  it("a status line in the opening section is read when the front matter has none, and says it came from the body [dec140-inproc-body-status]", async () => {
    const r = await lintKnowledgeDocs([
      md("DEC-1", "", "> **狀態**: Superseded（被 DEC-2 取代）"),
      md("DEC-2", "status: Accepted", "> **狀態**: Superseded"),
    ]);
    expect(rules(r)).toEqual(["superseded-without-declaration:DEC-1"]);
    const f = r.findings[0]!;
    expect(f.statusSource).toBe("body");
    expect(f.status).toBe("Superseded（被 DEC-2 取代）");
    expect(f.reason).toContain("(read from its status line)");
    expect(r.undeterminable.count).toBe(0);
  });

  it("a live citer whose status came from the body says so in its reason [dec140-inproc-body-citer]", async () => {
    const r = await lintKnowledgeDocs([
      md("DEC-1", "status: Superseded"),
      md("DEC-2", "status: Accepted\nsupersedes: [DEC-1]"),
      md("XSPEC-1", "impacted_by: [DEC-1]", "> **Status**: Draft"),
    ]);
    const f = r.findings.find((x) => x.rule === "live-cites-superseded")!;
    expect(f.statusSource).toBe("body");
    expect(f.reason).toContain('has status "Draft" (read from its status line)');
  });

  it("two documents with one id: one owns it, the other is counted as set aside and judged by nobody [dec140-inproc-duplicate-id]", async () => {
    const r = await lintKnowledgeDocs([
      { content: "---\nid: DEC-1\nstatus: Accepted\n---\n# a\n", fallbackId: "a/DEC-1.md" },
      { content: "---\nid: DEC-1\nstatus: Superseded\n---\n# b\n", fallbackId: "b/DEC-1.md" },
    ]);
    expect(r.scanned).toEqual({ documents: 2, named: 1, unnamed: 0, setAside: 1 });
    // The path that sorts first owns the id (Accepted); the Superseded copy contributes nothing.
    expect(r.findings).toEqual([]);
    expect(r.status).toBe("clean");
  });
});

describe("DEC-140: formatLint is the text a person reads", () => {
  it("states the denominator, the status words, each finding with file and reason, and the 0 of 無法判定 on a clean-looking run [dec140-inproc-format-findings]", async () => {
    const r = await lintKnowledgeDocs([md("DEC-1", "status: Superseded"), md("DEC-2", "status: Accepted")]);
    const text = formatLint(r, "docs");
    expect(text).toContain("lint: 2 Markdown file(s) in docs: 2 named spec/decision document(s), 0 without an id");
    expect(text).not.toContain("set aside");
    expect(text).toContain("status read as superseded: superseded | replaced | 已取代 | 被取代");
    expect(text).toContain("  [superseded-without-declaration] DEC-1.md - DEC-1 has status \"Superseded\"");
    expect(text).toContain("findings: 1 (1 superseded-without-declaration, 0 live-cites-superseded)");
    expect(text).toContain("無法判定 (cannot determine): 0");
    expect(text).toContain("result: findings (reported, nothing is blocked; exit 0)");
  });

  it("clean says clean, and a duplicate id is named as set aside [dec140-inproc-format-clean]", async () => {
    const r = await lintKnowledgeDocs([
      { content: "---\nid: DEC-1\nstatus: Accepted\n---\n# a\n", fallbackId: "a/DEC-1.md" },
      { content: "---\nid: DEC-1\nstatus: Accepted\n---\n# b\n", fallbackId: "b/DEC-1.md" },
    ]);
    const text = formatLint(r, "docs");
    expect(text).toContain("1 set aside (duplicate id)");
    expect(text.split("\n").at(-1)).toBe("result: clean");
  });

  it("undetermined says so and that the exit is 1; findings plus an unreadable document say the answer is incomplete [dec140-inproc-format-undetermined]", async () => {
    const und = formatLint(await lintKnowledgeDocs([md("DEC-1", "")]), "docs");
    expect(und).toContain("result: undetermined - 1 of 1 named document(s)");
    expect(und.split("\n").at(-1)).toMatch(/\(exit 1\)$/);

    const both = formatLint(await lintKnowledgeDocs([md("DEC-1", "status: Superseded"), md("DEC-2", "")]), "docs");
    expect(both).toContain("result: findings, and the answer is incomplete: 1 of 2 named document(s)");
    expect(both.split("\n").at(-1)).toMatch(/\(exit 1\)$/);
  });

  it("lists at most five unreadable files and says the rest are in --json; with exactly five it adds no ellipsis [dec140-inproc-format-undeterminable-list]", async () => {
    const many = await lintKnowledgeDocs(Array.from({ length: 7 }, (_, i) => md(`DEC-${i + 1}`, "")));
    const text = formatLint(many, "docs");
    expect(text).toContain("無法判定 (cannot determine): 7 document(s)");
    expect(text).toContain("e.g. DEC-1.md, DEC-2.md, DEC-3.md, DEC-4.md, DEC-5.md, ...; --json lists all");
    expect(text).not.toContain("DEC-6.md");

    const five = formatLint(await lintKnowledgeDocs(Array.from({ length: 5 }, (_, i) => md(`DEC-${i + 1}`, ""))), "docs");
    expect(five).toContain("e.g. DEC-1.md, DEC-2.md, DEC-3.md, DEC-4.md, DEC-5.md; --json lists all");
    expect(five).not.toContain("...");
  });
});

describe("DEC-140: cmdLint and collectKnowledgeDocs read the folder the way egr index --docs does", () => {
  function folder(name: string, files: Record<string, string>): string {
    const dir = join(work, name);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return dir;
  }
  const docText = (id: string, status: string) => `---\nid: ${id}\nstatus: ${status}\n---\n# ${id}\n`;

  it("cmdLint reads every Markdown file under the folder and reports what it found [dec140-inproc-cmd]", async () => {
    const dir = folder("cmd", {
      "DEC-1.md": docText("DEC-1", "Superseded"),
      "nested/XSPEC-1.md": docText("XSPEC-1", "Draft"),
      "README.md": "# Notes\n",
      "ignored.txt": docText("DEC-99", "Superseded"),
    });
    const r = await cmdLint({ dir });
    expect(r.scanned).toEqual({ documents: 3, named: 2, unnamed: 1, setAside: 0 });
    expect(rules(r)).toEqual(["superseded-without-declaration:DEC-1"]);
  });

  it("--exclude removes documents from the scan, and with no patterns nothing is excluded [dec140-inproc-cmd-exclude]", async () => {
    const dir = folder("cmd-exclude", {
      "DEC-1.md": docText("DEC-1", "Superseded"),
      "archive/DEC-2.md": docText("DEC-2", "Superseded"),
    });
    expect((await cmdLint({ dir })).scanned.documents).toBe(2);
    expect((await cmdLint({ dir, exclude: [] })).scanned.documents).toBe(2);
    const r = await cmdLint({ dir, exclude: ["archive/"] });
    expect(r.scanned.documents).toBe(1);
    expect(rules(r)).toEqual(["superseded-without-declaration:DEC-1"]);
  });

  it("a path that is not a directory, or does not exist, is an error and not an empty report [dec140-inproc-cmd-not-dir]", async () => {
    const dir = folder("cmd-file", { "DEC-1.md": docText("DEC-1", "Accepted") });
    await expect(cmdLint({ dir: join(dir, "DEC-1.md") })).rejects.toThrow(/is not a directory/);
    await expect(cmdLint({ dir: join(work, "no-such-folder") })).rejects.toThrow(/is not a directory/);
  });

  it("collectKnowledgeDocs hands over the content, a relative fallback id and an absolute source for each file [dec140-inproc-collect]", () => {
    const dir = folder("collect", { "adr/DEC-1.md": docText("DEC-1", "Accepted"), "top.md": "# top\n" });
    const { docs, files } = collectKnowledgeDocs(dir);
    expect(files.map((f) => f.path).sort()).toEqual(["adr/DEC-1.md", "top.md"]);
    const d = docs.find((x) => x.fallbackId === "adr/DEC-1.md")!;
    expect(d.content).toContain("id: DEC-1");
    expect(d.source).toMatch(/adr[\\/]DEC-1\.md$/);
    expect(d.source!.startsWith("/") || /^[A-Za-z]:/.test(d.source!)).toBe(true);
  });
});

describe("DEC-140: readBodyStatus, the shapes the lint reads", () => {
  it("a table row with a trailing pipe, a status the label has no value for, and a fence that swallows a heading [dec140-inproc-body-shapes]", () => {
    expect(readBodyStatus("| **狀態** | Draft | extra |")).toBe("Draft | extra");
    expect(readBodyStatus("| **Status** | Accepted")).toBe("Accepted");
    // A value that is only symbols is no value; the next line is looked at instead.
    expect(readBodyStatus("> **狀態**: ✅\n> **Status**: Draft")).toBe("Draft");
    // A `## ` inside a fence does not end the opening section.
    expect(readBodyStatus("```\n## not a heading\n```\n> **狀態**: Implemented")).toBe("Implemented");
    // ~~~ fences count too, and CRLF line endings are read.
    expect(readBodyStatus("~~~\n> **狀態**: Superseded\n~~~\r\n> **狀態**: Draft\r\n")).toBe("Draft");
    expect(readBodyStatus("")).toBeUndefined();
  });
});
