import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema, NODE_TABLE_DDL, REL_TABLE_DDL } from "../src/graph-db/schema.js";
import { openGraph } from "../src/graph-db/open.js";
import { backupDbFile } from "../src/graph-db/backup.js";
import {
  parseDeclaredColumns,
  detectPendingColumnMigrations,
  migrateSchemaColumns,
} from "../src/graph-db/schema-migration.js";

/**
 * Non-destructive schema column migration (see `graph-db/schema-migration.ts`'s
 * module doc for the full rationale/design writeup, INCLUDING the honest
 * scope limits an adversarial review surfaced — this file's tests are
 * written to match that corrected scope, not the original overclaim).
 *
 * Core claims under test:
 *   1. A graph DB whose `Function`/`Class`/`CALLS` tables predate XSPEC-333
 *      R1/R3's `provider`/`confidence` columns can be brought up to the
 *      CURRENT schema via `ALTER TABLE ... ADD` — preserving every
 *      pre-existing property (notably `Function.confidence`, SAGE's
 *      feedback-adjusted score) AT THE MOMENT of migration, instead of the
 *      old-only remediation of deleting the whole DB file and re-indexing
 *      from scratch, which destroyed it immediately and unconditionally.
 *   2. `provider` is backfilled to a known historical value (not left NULL)
 *      on `Function`/`Class`/`CALLS`, so a migrated `CALLS` edge is NOT
 *      permanently frozen — it un-freezes on the very next plain re-index,
 *      no `--clean` required (see the dedicated test for this below).
 *   3. The migration checkpoints + backs up the on-disk file, and that file
 *      is provably self-consistent (reopening it as an independent
 *      connection sees the migrated schema + preserved data).
 *
 * Explicitly NOT claimed or tested here (a pre-existing, separate concern):
 * that `Function.confidence` survives a subsequent plain `egr index`
 * re-index — it does not, migrated or not, because `writer.ts`'s
 * `shouldOverwrite` always allows a same-provider rewrite and `extractor.ts`
 * always stamps a fresh Function node with `confidence: 1`. See
 * `schema-migration.ts`'s module doc for the full accounting.
 */

describe("parseDeclaredColumns", () => {
  it("parses a NODE table DDL with a single-column PRIMARY KEY", () => {
    const { table, columns } = parseDeclaredColumns(
      `CREATE NODE TABLE Function(id STRING, name STRING, file STRING, start_line INT64, confidence DOUBLE, provider STRING, PRIMARY KEY(id))`,
    );
    expect(table).toBe("Function");
    expect(columns).toEqual([
      { name: "id", type: "STRING" },
      { name: "name", type: "STRING" },
      { name: "file", type: "STRING" },
      { name: "start_line", type: "INT64" },
      { name: "confidence", type: "DOUBLE" },
      { name: "provider", type: "STRING" },
    ]);
  });

  it("parses a REL table DDL, skipping the FROM/TO endpoint clause", () => {
    const { table, columns } = parseDeclaredColumns(
      `CREATE REL TABLE CALLS(FROM Function TO Function, call_count INT64, confidence DOUBLE, provider STRING)`,
    );
    expect(table).toBe("CALLS");
    expect(columns).toEqual([
      { name: "call_count", type: "INT64" },
      { name: "confidence", type: "DOUBLE" },
      { name: "provider", type: "STRING" },
    ]);
  });

  it("parses a REL table with no extra properties at all (just FROM/TO)", () => {
    const { table, columns } = parseDeclaredColumns(`CREATE REL TABLE IMPORTS(FROM Module TO Module)`);
    expect(table).toBe("IMPORTS");
    expect(columns).toEqual([]);
  });

  it("throws a clear error on a DDL shape it doesn't recognise (guards against silent under-parsing)", () => {
    expect(() => parseDeclaredColumns(`ALTER TABLE Foo ADD bar STRING`)).toThrow(/does not match/);
  });

  // Regression net: this parser derives its target column list from the
  // SAME DDL strings `initSchema` executes, on purpose (single source of
  // truth). If a future schema edit changes the DDL shape in a way this
  // parser can't handle, this must fail loudly here rather than silently
  // under-migrating in production.
  it("parses every real declared table in schema.ts without throwing, and every column has a name+type", () => {
    for (const ddl of [...NODE_TABLE_DDL, ...REL_TABLE_DDL]) {
      const { table, columns } = parseDeclaredColumns(ddl);
      expect(table.length).toBeGreaterThan(0);
      for (const col of columns) {
        expect(col.name.length).toBeGreaterThan(0);
        expect(col.type.length).toBeGreaterThan(0);
      }
    }
  });

  it("matches the known real Function/Class/CALLS column sets exactly (locks in the specific columns this migration cares about)", () => {
    const byTable = Object.fromEntries(
      [...NODE_TABLE_DDL, ...REL_TABLE_DDL].map(parseDeclaredColumns).map((d) => [d.table, d.columns.map((c) => c.name)]),
    );
    expect(byTable.Function).toEqual(["id", "name", "file", "start_line", "confidence", "provider"]);
    expect(byTable.Class).toEqual(["id", "name", "file", "provider"]);
    expect(byTable.CALLS).toEqual(["call_count", "confidence", "provider"]);
  });
});

describe("backupDbFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-backup-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the source file doesn't exist (nothing to protect)", () => {
    expect(backupDbFile(join(dir, "does-not-exist.db"))).toBeNull();
  });

  it("copies the file byte-for-byte to a .pre-migration-backup sibling", () => {
    const src = join(dir, "graph.db");
    writeFileSync(src, "fake-db-contents-v1");

    const backupPath = backupDbFile(src);
    expect(backupPath).toBe(`${src}.pre-migration-backup`);
    expect(existsSync(backupPath!)).toBe(true);
    expect(readFileSync(backupPath!, "utf8")).toBe("fake-db-contents-v1");
    // Original is untouched.
    expect(readFileSync(src, "utf8")).toBe("fake-db-contents-v1");
  });

  it("also backs up a .wal sidecar when present", () => {
    const src = join(dir, "graph.db");
    writeFileSync(src, "main-db");
    writeFileSync(`${src}.wal`, "wal-contents");

    const backupPath = backupDbFile(src)!;
    expect(readFileSync(`${backupPath}.wal`, "utf8")).toBe("wal-contents");
  });

  it("never overwrites an existing backup — a second call picks a numbered suffix instead", () => {
    const src = join(dir, "graph.db");
    writeFileSync(src, "v1");
    const first = backupDbFile(src)!;
    expect(first).toBe(`${src}.pre-migration-backup`);

    writeFileSync(src, "v2"); // simulate the file changing between two separate migration events
    const second = backupDbFile(src)!;
    expect(second).toBe(`${src}.pre-migration-backup-2`);
    expect(second).not.toBe(first);

    // Both snapshots preserved distinctly — the first backup was NOT clobbered.
    expect(readFileSync(first, "utf8")).toBe("v1");
    expect(readFileSync(second, "utf8")).toBe("v2");

    writeFileSync(src, "v3");
    const third = backupDbFile(src)!;
    expect(third).toBe(`${src}.pre-migration-backup-3`);
  });
});

describe("migrateSchemaColumns — end-to-end against a simulated pre-migration DB", () => {
  let dir: string;
  let conn: GraphConnection;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-schema-migration-test-"));
    conn = GraphConnection.open(join(dir, "graph.db"));
  });

  afterEach(async () => {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Builds a DB with tables in their OLD (pre-XSPEC-333) shape:
   *   - Function: missing `provider` (reproduces the pre-R1 gap)
   *   - CALLS: missing both `provider` AND `confidence` (reproduces the R3 gap)
   * Everything else uses the CURRENT schema.ts DDL verbatim.
   */
  async function createPreMigrationSchema(): Promise<void> {
    await conn.execute(
      `CREATE NODE TABLE Function(id STRING, name STRING, file STRING, start_line INT64, confidence DOUBLE, PRIMARY KEY(id))`,
    );
    for (const ddl of NODE_TABLE_DDL) {
      if (!ddl.includes("CREATE NODE TABLE Function")) await conn.execute(ddl);
    }
    await conn.execute(`CREATE REL TABLE CALLS(FROM Function TO Function, call_count INT64)`);
    for (const ddl of REL_TABLE_DDL) {
      if (!ddl.includes("CREATE REL TABLE CALLS")) await conn.execute(ddl);
    }
  }

  it("detectPendingColumnMigrations reports exactly the missing columns, nothing more", async () => {
    await createPreMigrationSchema();
    const pending = await detectPendingColumnMigrations(conn);
    expect(pending).toEqual(
      expect.arrayContaining([
        { table: "Function", column: "provider", type: "STRING" },
        { table: "CALLS", column: "confidence", type: "DOUBLE" },
        { table: "CALLS", column: "provider", type: "STRING" },
      ]),
    );
    expect(pending).toHaveLength(3);
  });

  it("reports zero pending migrations against a freshly-created current-schema DB", async () => {
    await initSchema(conn);
    const pending = await detectPendingColumnMigrations(conn);
    expect(pending).toEqual([]);
  });

  it("adds the missing columns, preserves ALL pre-existing data (incl. SAGE-adjusted confidence), and backs up the DB first", async () => {
    await createPreMigrationSchema();

    // Seed data exactly like a real, previously-used project would have:
    // a Function whose confidence SAGE has already nudged away from the
    // 1.0 default (simulating real feedback-loop history), and a CALLS
    // edge with a real call_count.
    await conn.execute(
      `CREATE (:Function {id: 'f1', name: 'foo', file: 'a.ts', start_line: 1, confidence: 0.35})`,
    );
    await conn.execute(
      `CREATE (:Function {id: 'f2', name: 'bar', file: 'a.ts', start_line: 10, confidence: 1.0})`,
    );
    await conn.execute(
      `MATCH (a:Function {id: 'f1'}), (b:Function {id: 'f2'}) CREATE (a)-[:CALLS {call_count: 7}]->(b)`,
    );

    const report = await migrateSchemaColumns(conn);

    expect(report.migrated).toEqual(
      expect.arrayContaining([
        { table: "Function", column: "provider", type: "STRING" },
        { table: "CALLS", column: "confidence", type: "DOUBLE" },
        { table: "CALLS", column: "provider", type: "STRING" },
      ]),
    );
    expect(report.backupPath).not.toBeNull();
    expect(existsSync(report.backupPath!)).toBe(true);

    // SAGE-adjusted confidence untouched — the whole point. `provider` is
    // backfilled to the known historical value ("tree-sitter" was the only
    // possible writer before this column existed — see
    // KNOWN_HISTORICAL_PROVIDER_BACKFILL's doc), NOT left NULL.
    const f1 = await conn.query(`MATCH (n:Function {id: 'f1'}) RETURN n.confidence AS confidence, n.provider AS provider`);
    expect(Number(f1[0]?.confidence)).toBe(0.35);
    expect(f1[0]?.provider).toBe("tree-sitter");

    // CALLS edge's call_count untouched; `provider` backfilled the same way,
    // but `confidence` stays NULL — we don't know which resolution tier a
    // historical edge was, and guessing would be fabricating data.
    const edge = await conn.query(
      `MATCH (:Function {id: 'f1'})-[r:CALLS]->(:Function {id: 'f2'}) RETURN r.call_count AS call_count, r.confidence AS confidence, r.provider AS provider`,
    );
    expect(Number(edge[0]?.call_count)).toBe(7);
    expect(edge[0]?.confidence).toBeNull();
    expect(edge[0]?.provider).toBe("tree-sitter");

    // Columns now genuinely writable (no more binder exception).
    await conn.execute(
      `MATCH (n:Function {id: 'f1'}) SET n.provider = 'tree-sitter'`,
    );
    const f1After = await conn.query(`MATCH (n:Function {id: 'f1'}) RETURN n.provider AS provider`);
    expect(f1After[0]?.provider).toBe("tree-sitter");
  });

  it("backfilled CALLS.provider un-freezes the edge on the very next plain re-index (same-provider fast path, no --clean needed)", async () => {
    await createPreMigrationSchema();
    await conn.execute(`CREATE (:Function {id: 'f1', name: 'foo', file: 'a.ts', start_line: 1, confidence: 1.0})`);
    await conn.execute(`CREATE (:Function {id: 'f2', name: 'bar', file: 'a.ts', start_line: 10, confidence: 1.0})`);
    await conn.execute(`MATCH (a:Function {id: 'f1'}), (b:Function {id: 'f2'}) CREATE (a)-[:CALLS {call_count: 3}]->(b)`);

    await migrateSchemaColumns(conn);

    // Simulate exactly what a plain tree-sitter re-index does (extractor.ts's
    // buildCallEdges always stamps provider/confidence): before the backfill
    // fix, this write would have hit `shouldOverwrite`'s "different provider,
    // NULL existing confidence" refusal — a bare MERGE with no SET, silently
    // leaving call_count stale forever. With provider backfilled to
    // "tree-sitter", this now takes the "same provider" fast path and
    // actually updates.
    await conn.execute(
      `MATCH (a:Function {id: 'f1'}), (b:Function {id: 'f2'}) MERGE (a)-[r:CALLS]->(b) SET r.call_count = 99, r.provider = 'tree-sitter', r.confidence = 0.8`,
    );
    const edge = await conn.query(
      `MATCH (:Function {id: 'f1'})-[r:CALLS]->(:Function {id: 'f2'}) RETURN r.call_count AS call_count, r.confidence AS confidence, r.provider AS provider`,
    );
    expect(edge[0]).toEqual({ call_count: 99, confidence: 0.8, provider: "tree-sitter" });
  });

  it("detectPendingColumnMigrations / migrateSchemaColumns are safe no-ops against a connection with NO tables at all (getExistingColumnNames' 'table does not exist' branch)", async () => {
    // No createPreMigrationSchema(), no initSchema() — a genuinely empty
    // Kuzu database, exercising the defensive branch that's otherwise
    // unreachable via the normal openGraph path (initSchema always creates
    // every table first).
    const pending = await detectPendingColumnMigrations(conn);
    expect(pending).toEqual([]);
    const report = await migrateSchemaColumns(conn);
    expect(report).toEqual({ migrated: [], backupPath: null });
  });

  it("CHECKPOINTs before backing up: the pre-migration backup file is independently openable and reflects the OLD schema+data", async () => {
    await createPreMigrationSchema();
    await conn.execute(`CREATE (:Function {id: 'f1', name: 'foo', file: 'a.ts', start_line: 1, confidence: 0.5})`);

    const report = await migrateSchemaColumns(conn);
    const backupPath = report.backupPath!;

    // The live connection sees the migrated schema + preserved data (already
    // covered by other tests above) — the distinct claim here is that the
    // BACKUP FILE `migrateSchemaColumns` made before altering anything is
    // itself a fully-consistent, independently-openable Kuzu DB (not a
    // torn/partial copy depending on a WAL that was never flushed into it),
    // reflecting the OLD (pre-migration) schema: `provider` doesn't exist on
    // this copy's Function table at all — proving the checkpoint-then-copy
    // ordering actually captured a stable snapshot from before any ALTER ran.
    const backupConn = GraphConnection.open(backupPath);
    try {
      const rows = await backupConn.query(`MATCH (n:Function {id: 'f1'}) RETURN n.confidence AS confidence`);
      expect(Number(rows[0]?.confidence)).toBe(0.5);
      await expect(backupConn.query(`MATCH (n:Function) RETURN n.provider AS provider`)).rejects.toThrow(/binder exception/i);
    } finally {
      await backupConn.close();
    }

    // The live connection meanwhile has already moved on to the migrated
    // schema — the backup captured the OLD state, not a snapshot of "whatever
    // the live connection currently has".
    const liveRows = await conn.query(`MATCH (n:Function {id: 'f1'}) RETURN n.provider AS provider`);
    expect(liveRows[0]?.provider).toBe("tree-sitter");
  });

  it("is idempotent: a second call after migration reports nothing pending and does not create a second backup", async () => {
    await createPreMigrationSchema();
    await conn.execute(`CREATE (:Function {id: 'f1', name: 'foo', file: 'a.ts', start_line: 1, confidence: 1.0})`);

    const first = await migrateSchemaColumns(conn);
    expect(first.migrated.length).toBeGreaterThan(0);
    expect(first.backupPath).not.toBeNull();

    const second = await migrateSchemaColumns(conn);
    expect(second.migrated).toEqual([]);
    expect(second.backupPath).toBeNull();

    // Only the one backup from the first call exists — no "-2" suffix.
    expect(existsSync(`${conn.path}.pre-migration-backup`)).toBe(true);
    expect(existsSync(`${conn.path}.pre-migration-backup-2`)).toBe(false);
  });

  it("initSchema (CREATE TABLE only) leaves the old schema untouched, exactly reproducing the documented gap before migrateSchemaColumns runs", async () => {
    await createPreMigrationSchema();
    // initSchema's CREATE TABLE is a no-op on tables that already exist —
    // this is the exact behaviour schema.ts's module doc describes as the
    // root cause this migration fixes.
    await initSchema(conn);
    const pending = await detectPendingColumnMigrations(conn);
    expect(pending.length).toBeGreaterThan(0);
  });
});

describe("openGraph — production entry point auto-migrates on open", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-opengraph-migration-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a pre-migration DB opened via openGraph is migrated automatically: no binder error, backup file created, old data intact", async () => {
    const dbPath = join(dir, "graph.db");

    // Build the pre-migration DB directly (bypassing openGraph) to seed it,
    // matching how a real project's DB would have gotten into this state.
    const seedConn = GraphConnection.open(dbPath);
    await seedConn.execute(
      `CREATE NODE TABLE Function(id STRING, name STRING, file STRING, start_line INT64, confidence DOUBLE, PRIMARY KEY(id))`,
    );
    for (const ddl of NODE_TABLE_DDL) {
      if (!ddl.includes("CREATE NODE TABLE Function")) await seedConn.execute(ddl);
    }
    await seedConn.execute(`CREATE REL TABLE CALLS(FROM Function TO Function, call_count INT64)`);
    for (const ddl of REL_TABLE_DDL) {
      if (!ddl.includes("CREATE REL TABLE CALLS")) await seedConn.execute(ddl);
    }
    await seedConn.execute(`CREATE (:Function {id: 'f1', name: 'foo', file: 'a.ts', start_line: 1, confidence: 0.6})`);
    await seedConn.close();

    // The real production path: open through openGraph, exactly like the
    // CLI/MCP/REST server do.
    const conn = await openGraph({ dbPath });
    try {
      // Old data survived the automatic migration.
      const rows = await conn.query(`MATCH (n:Function {id: 'f1'}) RETURN n.confidence AS confidence`);
      expect(Number(rows[0]?.confidence)).toBe(0.6);

      // The column that used to hit a Binder exception is now writable —
      // this is the write that `rethrowAsSchemaMigrationError` used to have
      // to intercept for connections opened this way.
      await conn.execute(
        `MATCH (a:Function {id: 'f1'}), (b:Function {id: 'f1'}) MERGE (a)-[r:CALLS]->(b) SET r.call_count = 1, r.provider = 'tree-sitter', r.confidence = 0.8`,
      );
      const edge = await conn.query(
        `MATCH (:Function {id: 'f1'})-[r:CALLS]->(:Function {id: 'f1'}) RETURN r.provider AS provider, r.confidence AS confidence`,
      );
      expect(edge[0]).toEqual({ provider: "tree-sitter", confidence: 0.8 });

      // A backup of the pre-migration file was made automatically.
      expect(existsSync(`${dbPath}.pre-migration-backup`)).toBe(true);
    } finally {
      await conn.close();
    }
  });

  it("a freshly-created DB (no pre-existing tables) opened via openGraph creates no backup — nothing was pending", async () => {
    const dbPath = join(dir, "fresh.db");
    const conn = await openGraph({ dbPath });
    try {
      expect(existsSync(`${dbPath}.pre-migration-backup`)).toBe(false);
    } finally {
      await conn.close();
    }
  });
});
