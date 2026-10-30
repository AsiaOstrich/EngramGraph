import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { parseKnowledgeDoc } from "../src/knowledge-graph/parser.js";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * Issue #19 — a decision that only MENTIONED another decision (under `related:`, or in its body)
 * was recorded as REPLACING it: every Decision → Decision reference became a SUPERSEDES edge, because
 * the parser merged the body links and every relationship field into one list and forgot where each
 * came from. "What does this decision replace?" then answered with plain mentions.
 *
 * Now only the `supersedes` field builds SUPERSEDES. Every other Decision → Decision reference is a
 * RELATES_TO edge, which says "mentioned / related" and nothing about replacement.
 *
 * The tests run the built CLI as a child process over real markdown files (the way a user does) and
 * read the graph back from disk. Each `it` makes its own tree and graph, so any one can run alone.
 */

let built: BuiltEgr;
let scratch: string;

beforeAll(() => {
  built = buildEgr();
  scratch = mkdtempSync(join(tmpdir(), "egr-i19-"));
});

afterAll(() => {
  built?.cleanup();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function decision(id: string, frontMatter: string, body = ""): string {
  return `---\nid: ${id}\n${frontMatter}---\n# ${id}\n${body}\n`;
}

/** A fresh tree + database under `scratch`, with `docs` written as markdown files. */
function setup(name: string, docs: Record<string, string>): { proj: string; db: string } {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  const proj = join(dir, "proj");
  mkdirSync(join(proj, "docs"), { recursive: true });
  for (const [file, content] of Object.entries(docs)) writeFileSync(join(proj, "docs", file), content);
  return { proj, db: join(dir, "graph.db") };
}

function index(s: { proj: string; db: string }): void {
  const r = runEgr(built.cli, ["index", s.proj, "--docs"], { env: { ...process.env, ENGRAM_DB: s.db }, cwd: s.proj });
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
}

/** `from->to` of every edge of `rel` between two decisions, read back from the file the CLI wrote. */
async function edges(db: string, rel: "SUPERSEDES" | "RELATES_TO"): Promise<string[]> {
  const conn = GraphConnection.open(db, { readOnly: true });
  try {
    const rows = await conn.query(`MATCH (a:Decision)-[:${rel}]->(b:Decision) RETURN a.id AS src, b.id AS dst ORDER BY src, dst`);
    return rows.map((r) => `${r.src}->${r.dst}`);
  } finally {
    await conn.close();
  }
}

describe("issue #19: only the `supersedes` field makes a SUPERSEDES edge", () => {
  it("A that only lists B under related: is not a replacement; C that lists D under supersedes: is", async () => {
    const s = setup("pair", {
      "DEC-901.md": decision("DEC-901", "related: [DEC-902]\n"),
      "DEC-902.md": decision("DEC-902", ""),
      "DEC-903.md": decision("DEC-903", "supersedes: [DEC-904]\n"),
      "DEC-904.md": decision("DEC-904", ""),
    });
    index(s);

    const superseding = await edges(s.db, "SUPERSEDES");
    expect(superseding, "related: must not build SUPERSEDES").not.toContain("DEC-901->DEC-902");
    expect(superseding, "supersedes: must").toContain("DEC-903->DEC-904");
    expect(superseding).toEqual(["DEC-903->DEC-904"]);

    // The mention is not lost: it is kept as a relation that does not say "replaces".
    expect(await edges(s.db, "RELATES_TO")).toEqual(["DEC-901->DEC-902"]);
  }, 60_000);

  it("a decision that mentions another only in its body, or under impacts/impacted_by/depends_on/implements, replaces nothing", async () => {
    const s = setup("sources", {
      "DEC-910.md": decision(
        "DEC-910",
        "depends_on: [DEC-911]\nimpacts: [DEC-912]\nimpacted_by: [DEC-913]\nimplements: [DEC-914]\n",
        "We build on [[DEC-915]], and this supersedes [[DEC-916]] in prose only.",
      ),
    });
    index(s);

    expect(await edges(s.db, "SUPERSEDES")).toEqual([]);
    expect(await edges(s.db, "RELATES_TO")).toEqual([
      "DEC-910->DEC-911",
      "DEC-910->DEC-912",
      "DEC-910->DEC-913",
      "DEC-910->DEC-914",
      "DEC-910->DEC-915",
      "DEC-910->DEC-916",
    ]);
  }, 60_000);

  it("the same decision named under related: AND supersedes: is a replacement, once", async () => {
    const s = setup("both", {
      "DEC-920.md": decision("DEC-920", "related: [DEC-921]\nsupersedes: [DEC-921]\n", "See [[DEC-921]]."),
    });
    index(s);

    expect(await edges(s.db, "SUPERSEDES")).toEqual(["DEC-920->DEC-921"]);
    expect(await edges(s.db, "RELATES_TO"), "one pair, one kind of edge").toEqual([]);
  }, 60_000);

  it("the summary line counts the two kinds apart", () => {
    const s = setup("summary", {
      "DEC-930.md": decision("DEC-930", "related: [DEC-931]\nsupersedes: [DEC-932]\n"),
    });
    const r = runEgr(built.cli, ["index", s.proj, "--docs", "--json"], { env: { ...process.env, ENGRAM_DB: s.db }, cwd: s.proj });
    expect(r.status, r.stderr).toBe(0);
    const json = JSON.parse(r.stdout) as { knowledge: { supersedes: number; relatesTo: number } };
    expect(json.knowledge.supersedes).toBe(1);
    expect(json.knowledge.relatesTo).toBe(1);
  }, 60_000);
});

describe("issue #19: a graph indexed before the fix heals on the next plain `egr index --docs`", () => {
  it("removes the SUPERSEDES edge an older egr wrote for a plain mention, keeps the declared one, and does not need --clean", async () => {
    const s = setup("old-graph", {
      "DEC-940.md": decision("DEC-940", "related: [DEC-941]\n"),
      "DEC-941.md": decision("DEC-941", ""),
      "DEC-942.md": decision("DEC-942", "supersedes: [DEC-943]\n"),
      "DEC-943.md": decision("DEC-943", ""),
    });

    // What an older egr left in the file: the mention recorded as a replacement (and a node
    // a newer egr would not touch — a Decision from a document that is not part of this tree).
    {
      const conn = GraphConnection.open(s.db);
      await initSchema(conn);
      for (const id of ["DEC-940", "DEC-941", "DEC-942", "DEC-943", "DEC-999"]) {
        await conn.execute(`CREATE (:Decision {id: '${id}', title: 'old', date: '', confidence: 1.0, origin: 'declared'})`);
      }
      for (const [a, b] of [
        ["DEC-940", "DEC-941"],
        ["DEC-942", "DEC-943"],
        ["DEC-999", "DEC-940"],
      ] as const) {
        await conn.execute(`MATCH (a:Decision {id: '${a}'}), (b:Decision {id: '${b}'}) CREATE (a)-[:SUPERSEDES]->(b)`);
      }
      await conn.execute("CHECKPOINT;");
      await conn.close();
    }
    expect(await edges(s.db, "SUPERSEDES")).toContain("DEC-940->DEC-941");

    index(s);

    const superseding = await edges(s.db, "SUPERSEDES");
    expect(superseding, "the mention-as-replacement left by the older egr").not.toContain("DEC-940->DEC-941");
    expect(superseding, "the declared replacement stays").toContain("DEC-942->DEC-943");
    // Only decisions whose own document was read are rewritten: DEC-999 has no document in this run.
    expect(superseding, "an edge from a decision this run did not read is not this run's to remove").toContain("DEC-999->DEC-940");
    expect(await edges(s.db, "RELATES_TO")).toEqual(["DEC-940->DEC-941"]);
  }, 60_000);
});

describe("issue #19: the parser keeps where each reference came from", () => {
  it("each reference lists every place it was written", () => {
    const parsed = parseKnowledgeDoc({
      content: "---\nid: DEC-950\nrelated: [DEC-951, DEC-952]\nsupersedes: [DEC-951]\n---\n# t\nsee [[DEC-952]] and [[DEC-953]]\n",
    });
    const via = Object.fromEntries((parsed?.refs ?? []).map((r) => [r.id, [...r.via].sort()]));
    expect(via).toEqual({
      "DEC-951": ["related", "supersedes"],
      "DEC-952": ["body", "related"],
      "DEC-953": ["body"],
    });
  });
});
