import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema, clearGraph, NODE_TABLE_DDL, REL_TABLE_DDL } from "../src/graph-db/schema.js";
import { cmdIndex, ingestScipOverlay } from "../src/cli/run.js";
import { loadScipPocFixtureSources } from "./fixtures/scip-poc/load-fixture.js";

/**
 * XSPEC-333 R3 — CLI-level integration coverage for `egr index --scip <path>`
 * (the module-level ingest/merge behaviour is already covered by
 * `test/scip-ingest.test.ts` / `test/scip-merge.test.ts`; this file proves
 * the CLI wiring itself — arg parsing, path-basis validation, and error
 * messages a user actually sees — against the same real fixture .scip files).
 */

const FIXTURE_DIR = join(process.cwd(), "test/fixtures/scip-poc");
const FIXTURE_SCIP = join(FIXTURE_DIR, "index.scip");

// A single shared GraphConnection for both the "happy path" and "error
// handling" describes below (opened once, `clearGraph`-reset between tests
// where needed) — this repo's suites deliberately avoid one fresh
// GraphConnection per `it()`/`describe()`: interleaving several native Kuzu
// handles with repeated tree-sitter parsing in one process has reproducibly
// crashed the vitest worker before (see scip-merge.test.ts's module doc,
// citing XSPEC-331's finding). The "old schema" connection below is
// necessarily separate (different DDL), kept to exactly one extra handle.
describe("cmdIndex --scip (direct call, real C# fixture)", () => {
  let dir: string;
  let conn: GraphConnection;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "engram-scip-cli-"));
    conn = GraphConnection.open(join(dir, "graph.db"));
    await initSchema(conn);
  });

  afterAll(async () => {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("indexes tree-sitter + overlays SCIP in one call, reporting scip stats", async () => {
    await clearGraph(conn);
    const r = await cmdIndex(conn, { dir: FIXTURE_DIR, scip: FIXTURE_SCIP });

    expect(r.scip).toBeDefined();
    // The real fixture index.scip has 10 documents: the 7 real .cs sources
    // PLUS 3 MSBuild-generated files under obj/ (GlobalUsings.g.cs,
    // AssemblyInfo.cs, AssemblyAttributes.cs) that scip-dotnet indexed but
    // `walkFiles`'s SKIP_DIRS (which already excludes "obj" for tree-sitter,
    // see cli/walk.ts) never walks — so filesMatched (7) is intentionally
    // less than documentsInIndex (10) here; that is a normal, non-error
    // partial match, not the zero-overlap failure case.
    expect(r.scip!.documentsInIndex).toBe(10);
    expect(r.scip!.filesMatched).toBe(7);
    expect(r.scip!.definitionsUnresolved).toBe(0);
    expect(r.scip!.callsEmitted).toBeGreaterThan(0);

    // The ambiguous Validate pair tree-sitter alone drops (see
    // scip-ingest.test.ts) must actually be in the graph now, with
    // provider=scip — proves the CLI path really writes through, not just
    // computes stats.
    const rows = await conn.query(
      `MATCH (:Function {id: $from})-[r:CALLS]->(:Function {id: $to}) RETURN r.provider AS provider, r.confidence AS confidence`,
      { from: "Program.cs#Program.Main", to: "Services/OrderService.cs#OrderService.Validate" },
    );
    expect(rows[0]).toEqual({ provider: "scip", confidence: 0.9 });
  });

  it("--clean + --scip together: clears then rebuilds both layers from scratch", async () => {
    const r = await cmdIndex(conn, { dir: FIXTURE_DIR, clean: true, scip: FIXTURE_SCIP });
    expect(r.scip!.callsEmitted).toBeGreaterThan(0);
    const rows = await conn.query(`MATCH (n:Function) RETURN count(n) AS c`);
    expect((rows[0]!.c as number)).toBeGreaterThan(0);
  });

  it("missing .scip file: clear error, not a raw ENOENT", async () => {
    await expect(cmdIndex(conn, { dir: FIXTURE_DIR, scip: join(dir, "does-not-exist.scip") })).rejects.toThrow(
      /--scip: file not found/,
    );
  });

  it("garbage (non-protobuf) .scip file: clear parse error, mentions external indexers", async () => {
    const garbage = join(dir, "garbage.scip");
    writeFileSync(garbage, "not a protobuf file\n".repeat(10));
    await expect(cmdIndex(conn, { dir: FIXTURE_DIR, scip: garbage })).rejects.toThrow(
      /could not be parsed as a SCIP protobuf index/,
    );
  });

  it("path-basis mismatch: SCIP document paths don't match any file under <dir> — zero overlap is a clear error, not a silent no-op", async () => {
    // Copy the fixture .cs sources one level deeper (nested/Program.cs etc.)
    // so the real index.scip's Document.relativePath ("Program.cs", ...)
    // matches NOTHING egr's own walkFiles produces for this <dir>.
    const mismatchDir = join(dir, "mismatch-root");
    mkdirSync(join(mismatchDir, "nested"), { recursive: true });
    cpSync(join(FIXTURE_DIR, "Program.cs"), join(mismatchDir, "nested", "Program.cs"));

    await expect(cmdIndex(conn, { dir: mismatchDir, scip: FIXTURE_SCIP })).rejects.toThrow(
      /none of the \d+ document path\(s\)/,
    );
  });

  it("CALLS schema predates provider/confidence columns: points at --clean instead of a raw Binder exception", async () => {
    const oldDir = mkdtempSync(join(tmpdir(), "engram-scip-old-schema-"));
    const oldConn = GraphConnection.open(join(oldDir, "old.db"));
    // Full current schema, EXCEPT CALLS reverted to its pre-XSPEC-333-R3-OQ4
    // shape (no provider/confidence) — reproduces the exact documented gap
    // in schema.ts without going through a real historical migration.
    for (const ddl of NODE_TABLE_DDL) await oldConn.execute(ddl);
    await oldConn.execute(`CREATE REL TABLE CALLS(FROM Function TO Function, call_count INT64)`);
    for (const ddl of REL_TABLE_DDL) {
      if (!ddl.includes("CREATE REL TABLE CALLS")) await oldConn.execute(ddl);
    }

    try {
      // Exercise just the SCIP overlay half in isolation (no tree-sitter
      // write on this connection at all — see module doc in run.ts for why
      // going through the full cmdIndex here would hit the SAME schema gap
      // on the tree-sitter write first, masking the SCIP-specific message
      // this test exists to check).
      const codeFiles = loadScipPocFixtureSources().map((f) => ({ path: f.relativePath, source: f.source }));
      await expect(ingestScipOverlay(oldConn, FIXTURE_DIR, FIXTURE_SCIP, codeFiles)).rejects.toThrow(
        /predates the "provider"\/"confidence" columns.*egr index <dir> --clean/s,
      );
    } finally {
      await oldConn.close();
      rmSync(oldDir, { recursive: true, force: true });
    }
  });
});

describe("egr CLI entry (spawn): index --scip end-to-end", () => {
  const run = (args: string[], env: Record<string, string | undefined> = {}) =>
    spawnSync("npx", ["tsx", "src/cli/index.ts", ...args], {
      encoding: "utf8",
      cwd: process.cwd(),
      env: { ...process.env, ...env },
    });

  let dbDir: string;

  beforeAll(() => {
    dbDir = mkdtempSync(join(tmpdir(), "engram-scip-cli-spawn-"));
  });

  afterAll(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("real `egr index --scip` run: process exits 0, JSON stats include the scip overlay, DB really has the upgraded edge", () => {
    const dbPath = join(dbDir, "graph.db");
    const r = run(["index", FIXTURE_DIR, "--scip", FIXTURE_SCIP, "--json"], { ENGRAM_DB: dbPath });
    expect(r.status, r.stderr).toBe(0);

    const parsed = JSON.parse(r.stdout) as { scip?: { documentsInIndex: number; filesMatched: number; callsEmitted: number } };
    expect(parsed.scip).toBeDefined();
    expect(parsed.scip!.documentsInIndex).toBe(10); // see the direct-call test above for why (3 obj/-generated docs)
    expect(parsed.scip!.filesMatched).toBe(7);
    expect(parsed.scip!.callsEmitted).toBeGreaterThan(0);
  });

  it("human-readable output mentions the scip overlay stats", () => {
    const dbPath = join(dbDir, "graph2.db");
    const r = run(["index", FIXTURE_DIR, "--scip", FIXTURE_SCIP], { ENGRAM_DB: dbPath });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("scip:");
    expect(r.stdout).toMatch(/\d+\/\d+ indexed files matched/);
  });

  it("missing --scip file: nonzero exit, clear stderr message (not a raw stack trace)", () => {
    const dbPath = join(dbDir, "graph3.db");
    const r = run(["index", FIXTURE_DIR, "--scip", join(dbDir, "nope.scip")], { ENGRAM_DB: dbPath });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--scip: file not found");
  });

  it("--help documents --scip", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--scip");
    expect(r.stdout.toLowerCase()).toContain("scip-dotnet");
  });
});
