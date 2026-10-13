// SPDX-License-Identifier: MIT
// implements XSPEC-481
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema, NODE_TABLE_DDL, REL_TABLE_DDL } from "../src/graph-db/schema.js";
import { createMcpServer } from "../src/mcp/server.js";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * XSPEC-481 R4 — two `egr index --docs` runs over different directories that both hold ADR-903.
 *
 * Until now the second silently replaced the first (the CHANGELOG listed it as a known limitation): within ONE run
 * a duplicate id is detected (XSPEC-476 R2), across runs the graph only saw "the same id again" and MERGEd. The
 * node never recorded which file it came from, so there was nothing to compare. It does now (`Spec.path` /
 * `Decision.path`, the absolute path), and the run that takes an id over from another file says so. The overwrite
 * rule itself is unchanged — the later document wins.
 *
 * Every test runs the built CLI as a child process and reads back what the graph holds.
 */

let built: BuiltEgr;
let work: string;
let dirA: string;
let dirB: string;
let seq = 0;

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-481-r4-"));
  dirA = join(work, "dirA");
  dirB = join(work, "dirB");
  mkdirSync(join(dirA, "adr"), { recursive: true });
  mkdirSync(join(dirB, "adr"), { recursive: true });
  // The same relative path in both, on purpose: a comparison of paths relative to the indexed directory sees no difference.
  writeFileSync(join(dirA, "adr", "ADR-903.md"), "---\nid: ADR-903\ntitle: Title from A\n---\n# ADR-903\nbody A\n");
  writeFileSync(join(dirB, "adr", "ADR-903.md"), "---\nid: ADR-903\ntitle: Title from B\n---\n# ADR-903\nbody B\n");
  // Only in A: a spec that impacts-links to ADR-903, so `egr impact XSPEC-5` reads the Decision's title back.
  writeFileSync(join(dirA, "XSPEC-5.md"), "---\nid: XSPEC-5\ntitle: A spec\n---\n# XSPEC-5\nSee [[ADR-903]].\n");
}, 120_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

const newDb = (): string => join(work, `r4-${seq++}.db`);
const egr = (db: string, args: string[]) => runEgr(built.cli, args, { env: { ...process.env, ENGRAM_DB: db }, cwd: work });

interface Conflict {
  id: string;
  kind: string;
  reason: string;
  previous?: { path: string };
  current?: { path: string; source: string };
  setAside?: unknown[];
}
const indexJson = (db: string, dir: string, extra: string[] = []): { conflicts: Conflict[]; text: string } => {
  const j = egr(db, ["index", dir, "--docs", ...extra, "--json"]);
  expect(j.status, j.stderr).toBe(0);
  return { conflicts: (JSON.parse(j.stdout) as { knowledge: { conflicts: Conflict[] } }).knowledge.conflicts, text: "" };
};
const decisionTitle = (db: string): string => {
  const r = egr(db, ["impact", "XSPEC-5"]);
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
};

describe("XSPEC-481 R4: an id taken over from an earlier index", () => {
  it("index dirA then index dirB: the second run prints a WARNING naming both paths, and the graph holds the later document [xspec481-r4-warns-with-both-paths]", () => {
    const db = newDb();
    const first = egr(db, ["index", dirA, "--docs", "--clean"]);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).not.toMatch(/WARNING/); // nothing was replaced yet
    expect(decisionTitle(db)).toContain("Title from A");

    const second = egr(db, ["index", dirB, "--docs"]);
    expect(second.status, second.stderr).toBe(0);
    const pathA = join(realpathSync(dirA), "adr", "ADR-903.md");
    const pathB = join(realpathSync(dirB), "adr", "ADR-903.md");
    expect(second.stdout).toMatch(/knowledge: WARNING — ADR-903 was indexed from .* by an earlier index and is now overwritten by /);
    expect(second.stdout).toContain(pathA);
    expect(second.stdout).toContain(pathB);
    expect(second.stdout).toMatch(/1 replaced a copy from an earlier index/);
    // Read back: the overwrite rule is unchanged — the later document is what the graph holds now.
    const impact = decisionTitle(db);
    expect(impact).toContain("Title from B");
    expect(impact).not.toContain("Title from A");
  });

  it("--json lists it under knowledge.conflicts with reason replaced-from-earlier-index, the kind, and both absolute paths [xspec481-r4-json-conflict]", () => {
    const db = newDb();
    expect(egr(db, ["index", dirA, "--docs", "--clean"]).status).toBe(0);
    const { conflicts } = indexJson(db, dirB);
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0]!;
    expect(c.id).toBe("ADR-903");
    expect(c.kind).toBe("Decision");
    expect(c.reason).toBe("replaced-from-earlier-index");
    expect(c.previous!.path).toBe(join(realpathSync(dirA), "adr", "ADR-903.md"));
    expect(c.current!.path).toBe(join(realpathSync(dirB), "adr", "ADR-903.md"));
    expect(c.current!.source).toBe("front-matter");
    // And it works the other way round: the graph remembered dirB's path, so taking it back says so.
    const back = indexJson(db, dirA);
    const ids = back.conflicts.filter((x) => x.reason === "replaced-from-earlier-index").map((x) => [x.id, x.previous!.path]);
    expect(ids).toContainEqual(["ADR-903", join(realpathSync(dirB), "adr", "ADR-903.md")]);
  });

  it("indexing the same file again is not a conflict, however many times [xspec481-r4-same-file-silent]", () => {
    const db = newDb();
    expect(egr(db, ["index", dirB, "--docs", "--clean"]).status).toBe(0);
    for (let i = 0; i < 2; i++) {
      const again = egr(db, ["index", dirB, "--docs"]);
      expect(again.status, again.stderr).toBe(0);
      expect(again.stdout).not.toMatch(/WARNING/);
      expect(again.stdout).not.toMatch(/replaced a copy/);
    }
    expect(indexJson(db, dirB).conflicts).toEqual([]);
  });

  it("a node with no recorded path (written by index_docs without one) is overwritten silently, not accused [xspec481-r4-no-path-silent]", async () => {
    const db = newDb();
    // A writable MCP server over this very file: `index_docs` takes no path, so the node has none.
    const conn = GraphConnection.open(db);
    await initSchema(conn);
    const server = createMcpServer(conn);
    const client = new Client({ name: "t", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const res = (await client.callTool({
      name: "index_docs",
      arguments: { docs: [{ content: "---\nid: ADR-903\ntitle: Title via MCP\n---\n# ADR-903\n", fallbackId: "ADR-903.md" }] },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).not.toBe(true);
    expect((JSON.parse(res.content[0]!.text) as { conflicts: unknown[] }).conflicts).toEqual([]);
    await client.close();
    await conn.close();

    const r = egr(db, ["index", dirB, "--docs"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/WARNING/);
    // The node is still there (one ADR-903, now declared by dirB's file).
    const top = egr(db, ["top", "Decision"]);
    expect(top.stdout).toContain("ADR-903");
  });

  it("a graph written before the column existed is migrated on first use, then the new column carries paths [xspec481-r4-old-graph-upgrade]", async () => {
    const db = newDb();
    // The schema of 0.13.0-beta.4: Spec and Decision without `path`.
    const conn = GraphConnection.open(db);
    for (const ddl of [...NODE_TABLE_DDL, ...REL_TABLE_DDL]) {
      await conn.execute(ddl.replace(/(CREATE NODE TABLE (?:Spec|Decision)\(.*?origin STRING), path STRING/, "$1"));
    }
    await conn.query(`CREATE (d:Decision {id: 'ADR-903', title: 'Old title', date: '', confidence: 1.0, origin: 'declared'})`);
    await conn.close();

    const first = egr(db, ["index", dirB, "--docs"]);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toMatch(/schema migrated: added column\(s\) .*Decision\.path/);
    expect(existsSync(`${db}.pre-migration-backup`)).toBe(true);
    expect(first.stdout).not.toMatch(/WARNING/); // the old node had no path to compare with

    // The migrated column is writable and read back: dirB's index recorded its path, so dirA's run names it.
    const second = egr(db, ["index", dirA, "--docs"]);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain(join(realpathSync(dirB), "adr", "ADR-903.md"));
  });

  it("the same document reached through a symlinked directory and through its real path is one document: no warning either way, a different file still warns [xspec481-r4-symlink-same-file]", () => {
    // dev-platform's index-all.sh indexes sub-projects through symlinks; a sub-project's own post-commit re-index uses the real path.
    const link = join(work, `link-${seq++}`);
    symlinkSync(dirA, link, "dir");
    const db = newDb();
    expect(egr(db, ["index", link, "--docs", "--clean"]).status).toBe(0);
    const viaReal = egr(db, ["index", dirA, "--docs"]);
    expect(viaReal.status, viaReal.stderr).toBe(0);
    expect(viaReal.stdout).not.toMatch(/WARNING/);
    expect(indexJson(db, link).conflicts).toEqual([]); // and back through the link
    // A genuinely different file is still reported, and the path named is the real one, not the link.
    const other = indexJson(db, dirB);
    expect(other.conflicts).toHaveLength(1);
    expect(other.conflicts[0]!.previous!.path).toBe(join(realpathSync(dirA), "adr", "ADR-903.md"));
    expect(other.conflicts[0]!.previous!.path).not.toContain(link);
  });

  it("a path stored as written through a symlink (by an earlier egr) is compared by its real location too [xspec481-r4-symlink-stored-path]", async () => {
    const link = join(work, `link-${seq++}`);
    symlinkSync(dirA, link, "dir");
    const db = newDb();
    expect(egr(db, ["index", dirA, "--docs", "--clean"]).status).toBe(0);
    // Rewrite the stored path to the symlink spelling, as a graph made before paths were canonical would hold.
    const conn = GraphConnection.open(db);
    await conn.query(`MATCH (n:Decision {id: 'ADR-903'}) SET n.path = $p`, { p: join(link, "adr", "ADR-903.md") });
    await conn.close();
    const r = egr(db, ["index", dirA, "--docs"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/WARNING/);
  });
});
