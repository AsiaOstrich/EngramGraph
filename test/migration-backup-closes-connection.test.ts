import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { migrateSchemaColumns } from "../src/graph-db/schema-migration.js";

/**
 * The pre-migration backup runs with the database closed (XSPEC-373 follow-up).
 *
 * A user upgrading to 0.10.0 on Windows — the release that adds `origin` to
 * three tables, so every existing graph migrates — got
 * `EBUSY: resource busy or locked, read` and two ZERO-BYTE backup files: the
 * destination was created, then the first `readSync` failed. Killing every
 * other node process changed nothing, so the lock was this process's own
 * database handle.
 *
 * `backup.ts` had already switched to `openSync` for its share flags after an
 * earlier `EBUSY … copyfile` report. Share flags decide who may OPEN a file;
 * they do not defeat a byte-range lock the engine holds. POSIX has no
 * equivalent, so none of this reproduces here — what these cases CAN pin is
 * that the connection is actually closed before the copy, that the caller gets
 * a working connection back, and that the backup is a real file rather than
 * the empty one the failure left behind.
 */
describe("pre-migration backup closes the connection first", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-migbackup-"));
    dbPath = join(dir, "graph.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A graph whose Spec table predates the `origin` column. */
  async function seedPreMigrationDb(): Promise<void> {
    const conn = GraphConnection.open(dbPath);
    await conn.query(
      `CREATE NODE TABLE Spec(id STRING, title STRING, status STRING, confidence DOUBLE, PRIMARY KEY(id))`,
    );
    await conn.query(`CREATE (s:Spec {id: 'SPEC-1', title: 'Real', status: 'draft', confidence: 1.0})`);
    await conn.close();
  }

  it("closes the passed-in connection and returns a new working one", async () => {
    await seedPreMigrationDb();
    const conn = GraphConnection.open(dbPath);

    const report = await migrateSchemaColumns(conn, () => GraphConnection.open(dbPath));

    expect(report.migrated.length).toBeGreaterThan(0);
    expect(report.conn).not.toBe(conn);
    // The old one is closed — using it must fail rather than silently work.
    await expect(conn.query(`MATCH (s:Spec) RETURN s.id`)).rejects.toThrow(/closed/i);
    // The new one works and the data survived the round trip.
    const rows = await report.conn.query(`MATCH (s:Spec) RETURN s.id AS id, s.title AS title`);
    expect(rows).toEqual([{ id: "SPEC-1", title: "Real" }]);
    await report.conn.close();
  });

  it("writes a backup that is not empty", async () => {
    // The Windows failure left two 0-byte files: destination created, first
    // read failed. A backup that exists but is empty is worse than none — it
    // looks like a safety net.
    await seedPreMigrationDb();
    const conn = GraphConnection.open(dbPath);

    const report = await migrateSchemaColumns(conn, () => GraphConnection.open(dbPath));

    expect(report.backupPath).toBeTruthy();
    expect(existsSync(report.backupPath as string)).toBe(true);
    expect(statSync(report.backupPath as string).size).toBeGreaterThan(0);
    expect(statSync(report.backupPath as string).size).toBe(statSync(dbPath).size);
    await report.conn.close();
  });

  it("without a reopen factory, keeps the old single-connection behaviour", async () => {
    // Direct API users and tests own their own connection object and cannot
    // have it swapped underneath them.
    await seedPreMigrationDb();
    const conn = GraphConnection.open(dbPath);

    const report = await migrateSchemaColumns(conn);

    expect(report.conn).toBe(conn);
    expect(report.migrated.length).toBeGreaterThan(0);
    await conn.close();
  });

  it("the migrated column is actually usable afterwards", async () => {
    await seedPreMigrationDb();
    const conn = GraphConnection.open(dbPath);
    const report = await migrateSchemaColumns(conn, () => GraphConnection.open(dbPath));

    await report.conn.query(`MATCH (s:Spec {id: 'SPEC-1'}) SET s.origin = 'declared'`);
    const rows = await report.conn.query(`MATCH (s:Spec) RETURN s.origin AS origin`);

    expect(rows).toEqual([{ origin: "declared" }]);
    await report.conn.close();
  });
});
