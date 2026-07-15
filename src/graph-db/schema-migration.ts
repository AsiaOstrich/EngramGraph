/**
 * Non-destructive schema column migration.
 *
 * `schema.ts`'s `initSchema` only ever runs `CREATE TABLE` (swallowing
 * "already exists"); it never alters a pre-existing table's columns. That was
 * fine while the schema never changed shape after a table was first created,
 * but XSPEC-333 R1/R3 added `provider`/`confidence` columns to tables that
 * already existed in the wild (`Function`, `Class`, `CALLS`) — an on-disk DB
 * created before those columns existed is left permanently missing them,
 * and the very next write that touches those columns hits a Kuzu Binder
 * exception (see `cli/run.ts`'s `assertCallsSchemaHasProvenanceColumns` /
 * `rethrowAsSchemaMigrationError`, added as a stopgap that told the user to
 * delete the whole DB file and re-index from scratch).
 *
 * That stopgap is real data loss for any project running SAGE's confidence
 * feedback loop (`sage/writer.ts`'s `applyFeedback`): a from-scratch rebuild
 * zeroes out every `confidence` adjustment SAGE accumulated from real usage.
 *
 * This module fixes it at the root: Kuzu's own `ALTER TABLE <name> ADD [IF
 * NOT EXISTS] <col> <type> [DEFAULT <expr>]` (verified empirically against
 * this project's pinned `ryugraph@25.9.1` Kuzu fork — see the module doc on
 * `schema.ts`'s `NODE_TABLE_DDL`/`REL_TABLE_DDL` for the experiment and its
 * results) can add a missing column to an EXISTING table in place, leaving
 * every existing row's other properties untouched and giving the new column
 * a `NULL` value on rows that predate it — which is exactly how
 * `writer.ts`'s `shouldOverwrite` already treats a missing/`null` existing
 * `confidence` ("no signal to compare against"), so no new semantics were
 * needed to consume these backfilled-NULL columns.
 *
 * `migrateSchemaColumns` is called by `open.ts`'s `openGraph` right after
 * `initSchema`, so every real CLI/MCP/REST caller (they all route through
 * `openGraph`) gets this automatically on every connection open — no user
 * action, no `egr migrate` command to remember to run. Before issuing any
 * `ALTER TABLE`, it backs up the on-disk DB file (`backup.ts`) as an extra
 * safety net on top of Kuzu's own WAL, given this is a data-loss-risk
 * operation running through a native binding with known process-exit
 * segfault quirks on this platform (see `test/structural-memory.test.ts`'s
 * module doc) — cheap insurance since a plain file copy is fast relative to
 * a full re-index.
 */

import type { GraphConnection } from "./connection.js";
import { NODE_TABLE_DDL, REL_TABLE_DDL } from "./schema.js";
import { backupDbFile } from "./backup.js";

/** A single column as declared in one of `schema.ts`'s `CREATE TABLE` DDL strings. */
export interface ColumnDef {
  readonly name: string;
  readonly type: string;
}

/** A table's name plus every column its current DDL declares. */
export interface DeclaredTable {
  readonly table: string;
  readonly columns: readonly ColumnDef[];
}

/** One column that exists in `schema.ts`'s DDL but is missing from the on-disk table. */
export interface ColumnMigration {
  readonly table: string;
  readonly column: string;
  readonly type: string;
}

export interface SchemaMigrationReport {
  /** Every column added this call, in the order the ALTERs were issued. Empty when the schema was already current. */
  readonly migrated: readonly ColumnMigration[];
  /** Path of the pre-migration backup, or `null` when nothing was migrated (no backup was needed). */
  readonly backupPath: string | null;
}

const CREATE_TABLE_HEAD = /^CREATE\s+(?:NODE|REL)\s+TABLE\s+(\w+)\s*\(/i;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Split a DDL's parenthesized column-list body on top-level commas (ignoring commas nested inside e.g. `PRIMARY KEY(a, b)`). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Parse a `CREATE NODE|REL TABLE Name(...)` DDL string (as declared in
 * `schema.ts`) into its table name and column list — the target state a
 * migration should converge an existing table towards.
 *
 * Deliberately parses the SAME DDL strings `initSchema` executes verbatim
 * (rather than a separate hand-maintained column list) so there is exactly
 * one place a future schema change needs editing; `test/schema-migration.test.ts`
 * asserts this against the real `NODE_TABLE_DDL`/`REL_TABLE_DDL` exports so a
 * DDL edit that this parser can't handle fails loudly in CI rather than
 * silently under-migrating.
 *
 * Skips the `FROM X TO Y` endpoint clause (rel tables) and any `PRIMARY
 * KEY(...)` clause — neither is a data column `ALTER TABLE ... ADD` could add.
 */
export function parseDeclaredColumns(ddl: string): DeclaredTable {
  const head = CREATE_TABLE_HEAD.exec(ddl);
  if (!head) {
    throw new Error(`parseDeclaredColumns: DDL does not match the expected "CREATE NODE|REL TABLE Name(...)" shape: ${ddl}`);
  }
  const table = head[1]!;
  const openIdx = head[0].length - 1; // index of the '(' the regex matched, inside `ddl`

  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < ddl.length; i += 1) {
    if (ddl[i] === "(") depth += 1;
    else if (ddl[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) {
    throw new Error(`parseDeclaredColumns: unbalanced parentheses in DDL: ${ddl}`);
  }

  const columns: ColumnDef[] = [];
  for (const segment of splitTopLevel(ddl.slice(openIdx + 1, closeIdx))) {
    if (/^PRIMARY\s+KEY/i.test(segment)) continue;
    if (/^FROM\s+/i.test(segment)) continue; // "FROM X TO Y" rel-table endpoint clause
    const [name, type] = segment.split(/\s+/);
    if (!name || !type) {
      throw new Error(`parseDeclaredColumns: could not parse a "name TYPE" column from segment "${segment}" in DDL: ${ddl}`);
    }
    columns.push({ name, type });
  }
  return { table, columns };
}

/** Every table `schema.ts` declares, parsed to its target column list. */
function declaredTables(): DeclaredTable[] {
  return [...NODE_TABLE_DDL, ...REL_TABLE_DDL].map(parseDeclaredColumns);
}

/**
 * The column names an on-disk table actually has (via Kuzu's `table_info`
 * introspection function), or `null` if the table does not exist at all —
 * distinct from "exists with zero extra columns", and not this module's
 * problem to fix: a missing table is `initSchema`'s `CREATE TABLE` job, which
 * always runs before this (see `open.ts`'s `openGraph`), and a from-scratch
 * `CREATE TABLE` always has every currently-declared column, so a table that
 * still doesn't exist by the time this runs is not something a column ALTER
 * could fix anyway.
 */
async function getExistingColumnNames(conn: GraphConnection, table: string): Promise<Set<string> | null> {
  if (!IDENTIFIER.test(table)) {
    throw new Error(`getExistingColumnNames: unsafe table name "${table}"`);
  }
  try {
    const rows = await conn.query(`CALL table_info('${table}') RETURN *`);
    return new Set(rows.map((r) => String(r.name)));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/does not exist/i.test(msg)) return null;
    throw err;
  }
}

/**
 * Read-only pass: compare `schema.ts`'s declared columns against what each
 * table on disk actually has, and report every gap. Never mutates anything —
 * safe to call to preview what {@link migrateSchemaColumns} would do.
 */
export async function detectPendingColumnMigrations(conn: GraphConnection): Promise<ColumnMigration[]> {
  const pending: ColumnMigration[] = [];
  for (const { table, columns } of declaredTables()) {
    const existing = await getExistingColumnNames(conn, table);
    if (existing === null) continue; // table doesn't exist yet; not this module's concern
    for (const col of columns) {
      if (!existing.has(col.name)) {
        pending.push({ table, column: col.name, type: col.type });
      }
    }
  }
  return pending;
}

/**
 * Detect + (if anything is pending) back up + apply every missing column as
 * a non-destructive `ALTER TABLE ... ADD IF NOT EXISTS` — existing rows keep
 * every property they already have and get `NULL` for the new column.
 *
 * Idempotent and cheap when the schema is already current: one
 * `table_info` read per declared table, zero writes, zero backup.
 */
export async function migrateSchemaColumns(conn: GraphConnection): Promise<SchemaMigrationReport> {
  const pending = await detectPendingColumnMigrations(conn);
  if (pending.length === 0) {
    return { migrated: [], backupPath: null };
  }

  const backupPath = backupDbFile(conn.path);

  for (const { table, column, type } of pending) {
    // `IF NOT EXISTS` makes this idempotent in its own right (belt-and-suspenders
    // on top of detectPendingColumnMigrations already having checked) — see
    // the module doc's experiment: a duplicate `ADD IF NOT EXISTS` is a no-op,
    // not an error, unlike a plain duplicate `ADD`.
    await conn.execute(`ALTER TABLE ${table} ADD IF NOT EXISTS ${column} ${type} DEFAULT NULL`);
  }

  return { migrated: pending, backupPath };
}
