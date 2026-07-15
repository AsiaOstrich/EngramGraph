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
 * `ALTER TABLE`, it runs Kuzu's `CHECKPOINT` statement (flushes the WAL into
 * the main file — verified empirically to remove the `.wal` sidecar and
 * leave data queryable) and THEN backs up the on-disk DB file (`backup.ts`),
 * so the snapshot is a fully-flushed, self-consistent copy rather than one
 * that might depend on WAL entries not yet merged into it — an extra safety
 * net on top of Kuzu's own crash-recovery, given this is a data-loss-risk
 * operation running through a native binding with known process-exit
 * segfault quirks on this platform (see `test/structural-memory.test.ts`'s
 * module doc) — cheap insurance since a checkpoint + plain file copy is fast
 * relative to a full re-index.
 *
 * ## What "preserves existing data" actually means here (read before citing this elsewhere)
 *
 * An adversarial review of this feature correctly pushed back on an
 * overclaim in an earlier version of this module's/its callers' docs: this
 * migration NEVER destroys `Function.confidence` (SAGE's feedback-adjusted
 * score, `sage/writer.ts`'s `applyFeedback`) — unlike the old "delete the
 * whole DB" remediation, which destroyed it unconditionally and immediately.
 * But that is where this feature's guarantee ENDS. It does NOT make
 * `Function.confidence` durable across a subsequent plain `egr index`
 * re-index — that was ALREADY fragile before this feature existed, on any
 * schema version: `writer.ts`'s `shouldOverwrite` unconditionally allows a
 * same-provider rewrite (`newProvider === existing.provider` → `true`,
 * skipping the confidence comparison entirely), and `extractor.ts`
 * unconditionally stamps every Function node it (re-)writes with
 * `confidence: 1` — a deliberate, already-documented, out-of-scope-for-this-
 * feature design choice (see `extractor.ts`'s own module doc, "Function/Class
 * node confidence is explicitly NOT touched here": recalibrating that
 * interaction is called out there as "a SAGE-calibration decision... deserves
 * its own deliberation", not a CALLS-edge or schema-migration one). This
 * module's contribution is narrower and still real: it is the difference
 * between "SAGE's current value survives until the next `egr index`" (this
 * feature) and "SAGE's current value is gone the instant a stale-schema DB
 * needs migrating, full stop" (the old remediation) — not a general fix for
 * SAGE-confidence durability across repeated re-indexing, which remains a
 * separate, pre-existing, undecided question.
 *
 * ## Backfilling a known historical `provider` (narrow, explicit, NOT a general policy)
 *
 * Leaving a freshly-added `provider` column `NULL` on migrated rows has a
 * real cost the adversarial review also caught: `writer.ts`'s
 * `shouldOverwrite` treats a `NULL` existing `provider` as "different from
 * any incoming provider", forcing the confidence-comparison branch — and for
 * `CALLS` specifically, a `NULL` existing `confidence` on that branch means
 * "no signal", which PERMANENTLY blocks even a same-tool re-index from ever
 * refreshing the row (see `schema.ts`'s module doc on `REL_TABLE_DDL`). Before
 * this fix, EVERY CALLS edge in a migrated pre-R3 DB would have been frozen
 * that way forever, needing a full `--clean` rebuild to un-stick — precisely
 * the friction/rebuild this whole feature exists to avoid.
 *
 * `KNOWN_HISTORICAL_PROVIDER_BACKFILL` below closes this for the three
 * specific columns where the historical provider is not a guess but a
 * logical certainty: `Function.provider`/`Class.provider`/`CALLS.provider`
 * were all added by XSPEC-333 R1/R3, and tree-sitter was the ONLY
 * CLI-reachable extraction provider that existed before that (SCIP's CLI
 * wiring is R3, the SAME change/later than the provider columns themselves)
 * — so any pre-existing row missing that column can only ever have been
 * written by tree-sitter. Backfilling `provider = 'tree-sitter'` (via a
 * `WHERE ... IS NULL` `SET`, verified empirically to work on both a NODE
 * table and a REL table pattern) restores the "same provider always wins"
 * fast path, so the very next plain `egr index` re-index un-freezes the row
 * on its own — no `--clean` required. Deliberately NOT backfilling
 * `confidence` too: we do NOT know which resolution tier (`same-file` 0.8 vs
 * `cross-file-unique` 0.5, see `extractor.ts`'s `CALLS_CONFIDENCE`) a
 * historical CALLS edge was computed at, and guessing would be fabricating
 * data, not inferring it — leaving it `NULL` until the next real re-index
 * computes an honest value is the correct, non-hallucinated choice.
 *
 * This is intentionally a small, explicit, hand-reasoned allowlist, NOT a
 * generic "always backfill every migrated `provider` column" mechanism: a
 * future schema change adding `provider` to some other, non-code-extraction
 * table (e.g. a markdown-sourced node) would have no such historical
 * certainty, and blindly assuming `"tree-sitter"` there would be fabricating
 * provenance, not inferring it.
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
    // Require EXACTLY two whitespace-separated tokens ("name TYPE"). An
    // earlier version silently destructured `segment.split(/\s+/)` and only
    // checked the first two were non-empty — a THIRD token (e.g. a future
    // `DEFAULT ...` clause on a declared column, or a multi-word type like
    // `MAP(STRING, INT64)`) would have been silently dropped instead of
    // failing loudly, which an adversarial review flagged: a fresh DB never
    // exercises this path (nothing is ever pending against a table
    // `initSchema` just created from the same DDL), so this would only ever
    // misbehave in production, against a real user's pre-existing DB, not in
    // CI. Failing loudly here instead — even though no current DDL string
    // trips it — turns a silent-corruption risk into an immediate, obvious
    // error the moment a future DDL edit needs this parser updated too.
    const tokens = segment.split(/\s+/);
    if (tokens.length !== 2) {
      throw new Error(
        `parseDeclaredColumns: expected exactly a "name TYPE" column (2 tokens) but got ${tokens.length} in segment "${segment}" (DDL: ${ddl})`,
      );
    }
    const [name, type] = tokens as [string, string];
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
 * (table, column) pairs whose historical value is a logical certainty, not a
 * guess — see the module doc's "Backfilling a known historical `provider`"
 * section for the full reasoning. Each entry names the Cypher `MATCH` clause
 * that finds every row of that column still `NULL` (node vs. rel patterns
 * differ, so this is data, not a single generic template).
 */
const KNOWN_HISTORICAL_PROVIDER_BACKFILL: ReadonlyMap<string, string> = new Map([
  ["Function.provider", "MATCH (n:Function) WHERE n.provider IS NULL SET n.provider = 'tree-sitter'"],
  ["Class.provider", "MATCH (n:Class) WHERE n.provider IS NULL SET n.provider = 'tree-sitter'"],
  ["CALLS.provider", "MATCH (:Function)-[r:CALLS]->(:Function) WHERE r.provider IS NULL SET r.provider = 'tree-sitter'"],
]);

/**
 * Detect + (if anything is pending) checkpoint + back up + apply every
 * missing column as a non-destructive `ALTER TABLE ... ADD IF NOT EXISTS` —
 * existing rows keep every property they already have and get `NULL` for the
 * new column, except the narrow, explicit backfills in
 * {@link KNOWN_HISTORICAL_PROVIDER_BACKFILL} above.
 *
 * Idempotent and cheap when the schema is already current: one
 * `table_info` read per declared table, zero writes, zero checkpoint, zero
 * backup.
 *
 * Fails closed rather than silently migrating unprotected: if there IS a
 * pending migration but no backup could be made (the only way `backupDbFile`
 * returns `null` is a `dbPath` that doesn't exist on disk — which should be
 * impossible here, since a pending migration means some table on that exact
 * connection already has rows, so Kuzu must already have created the file),
 * this throws instead of proceeding, since something about that assumption
 * has been violated and altering table schema without a safety net is
 * exactly the risk this module exists to avoid.
 */
export async function migrateSchemaColumns(conn: GraphConnection): Promise<SchemaMigrationReport> {
  const pending = await detectPendingColumnMigrations(conn);
  if (pending.length === 0) {
    return { migrated: [], backupPath: null };
  }

  // Flush the WAL into the main file first so the backup below is a
  // fully-consistent snapshot, not one that might depend on WAL entries not
  // yet merged into it (verified empirically: `CHECKPOINT` removes the
  // `.wal` sidecar and leaves data queryable — see this module's doc).
  await conn.execute("CHECKPOINT");

  const backupPath = backupDbFile(conn.path);
  if (backupPath === null) {
    throw new Error(
      `migrateSchemaColumns: detected ${pending.length} pending column migration(s) on "${conn.path}" but the DB file does not exist on disk to back up — refusing to ALTER TABLE without a safety net. This should not be reachable in practice (a pending migration implies the table already has data, which implies the file already exists); if you're seeing this, something about that assumption doesn't hold for this connection.`,
    );
  }

  for (const { table, column, type } of pending) {
    // `IF NOT EXISTS` makes this idempotent in its own right (belt-and-suspenders
    // on top of detectPendingColumnMigrations already having checked) — see
    // the module doc's experiment: a duplicate `ADD IF NOT EXISTS` is a no-op,
    // not an error, unlike a plain duplicate `ADD`.
    await conn.execute(`ALTER TABLE ${table} ADD IF NOT EXISTS ${column} ${type} DEFAULT NULL`);

    const backfill = KNOWN_HISTORICAL_PROVIDER_BACKFILL.get(`${table}.${column}`);
    if (backfill !== undefined) {
      await conn.execute(backfill);
    }
  }

  return { migrated: pending, backupPath };
}
