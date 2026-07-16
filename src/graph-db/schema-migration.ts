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
 * specific columns where the historical provider is, for every CLI/MCP-
 * reachable code path, a certain inference rather than a guess:
 * `Function.provider`/`Class.provider`/`CALLS.provider` were all added by
 * XSPEC-333 R1/R3, and tree-sitter was the ONLY CLI-reachable extraction
 * provider that existed before that (SCIP's CLI wiring is R3, the SAME
 * change/later than the provider columns themselves) — so any pre-existing
 * row created through the CLI/MCP/REST surface and missing that column can
 * only ever have been written by tree-sitter. Backfilling
 * `provider = 'tree-sitter'` (via a `WHERE ... IS NULL` `SET`, verified
 * empirically to work on both a NODE table and a REL table pattern) restores
 * the "same provider always wins" fast path, so the very next plain
 * `egr index` re-index un-freezes the row on its own — no `--clean`
 * required. Deliberately NOT backfilling `confidence` too: we do NOT know
 * which resolution tier (`same-file` 0.8 vs `cross-file-unique` 0.5, see
 * `extractor.ts`'s `CALLS_CONFIDENCE`) a historical CALLS edge was computed
 * at, and guessing would be fabricating data, not inferring it — leaving it
 * `NULL` until the next real re-index computes an honest value is the
 * correct, non-hallucinated choice.
 *
 * Honest scope of the "certainty" claim (an adversarial review correctly
 * pushed back on an earlier, unqualified version of this paragraph):
 * `GraphConnection`/the graph-db module are also an exported public npm
 * library API (`engramgraph`), not only a CLI/MCP implementation detail. A
 * programmatic consumer could, in principle, have called `GraphConnection`
 * directly to hand-write `Function`/`Class`/`CALLS` rows via raw Cypher
 * before these columns existed, without ever going through tree-sitter — the
 * backfill would mislabel those specific rows as `provider: 'tree-sitter'`
 * even though they weren't. This is a theoretical exception the backfill
 * cannot distinguish from the overwhelmingly common case, and it is
 * accepted as a safe DEFAULT, not advertised as a hard guarantee: the
 * practical blast radius is limited (a same-provider re-index still
 * self-heals the common case regardless of the label), and the alternative
 * — leaving every migrated row's `provider` `NULL` — has the strictly worse,
 * concretely-observed cost described above (permanently frozen CALLS edges).
 *
 * This is intentionally a small, explicit, hand-reasoned allowlist, NOT a
 * generic "always backfill every migrated `provider` column" mechanism: a
 * future schema change adding `provider` to some other, non-code-extraction
 * table (e.g. a markdown-sourced node) would have no such historical
 * certainty, and blindly assuming `"tree-sitter"` there would be fabricating
 * provenance, not inferring it.
 *
 * ## Resumability: a crash between the `ALTER` and its paired backfill must not orphan the backfill
 *
 * An adversarial review found a real bug in an earlier version of this
 * module: the `ALTER TABLE ... ADD` and its paired
 * `KNOWN_HISTORICAL_PROVIDER_BACKFILL` `SET` are two separate, independently
 * auto-committed statements, not one transaction. If the process dies
 * between them — a crash, OOM kill, power loss, or this platform's
 * documented native-addon segfault risk (see `test/structural-memory.test.ts`'s
 * module doc) — the column now exists (so a naive "does the column exist"
 * check reports zero pending work on the next run), but the backfill NEVER
 * ran and never will again: every affected row is left permanently
 * `provider: NULL`, silently, with nothing printed to stderr. That is
 * exactly the "frozen forever, needs `--clean`" failure this feature exists
 * to prevent.
 *
 * The fix is in *detection*, not in trying to make the two statements
 * atomic (Kuzu has no cross-DDL transaction to reach for here):
 * `detectPendingColumnMigrations` treats "column exists, but at least one
 * historically-backfillable row is still `NULL`" as pending work in its own
 * right, distinct from "column missing entirely" — see its own doc comment
 * and `KNOWN_HISTORICAL_PROVIDER_BACKFILL`'s `check` query. A resumed/retried
 * `migrateSchemaColumns` call therefore re-issues the backfill (never the
 * `ALTER`, which is already a no-op via `IF NOT EXISTS`) for any column that
 * has it pending, regardless of whether THIS call is the one that added the
 * column or a prior, crashed call already did. The backfill's own
 * `WHERE ... IS NULL` clause is what makes this safe to re-run any number of
 * times — it only ever touches rows still `NULL`, never re-writes a row a
 * prior partial run already fixed.
 *
 * ## Bounding backup accumulation across retries
 *
 * A second issue the same review found: `migrateSchemaColumns` backs up the
 * whole DB file EVERY time it's invoked with pending work outstanding —
 * including a retry after a previous attempt failed partway (e.g. `ENOSPC`,
 * plausibly the very reason the `ALTER` failed in the first place). Before
 * this fix, each retry made a fresh, fully-redundant full-DB copy via
 * `backup.ts`'s never-overwrite numbered-suffix scheme, so a repeatedly
 * failing migration on a disk approaching full accelerated itself towards
 * `ENOSPC` instead of leaving room to fix the underlying problem.
 *
 * The fix (see `ensureBackup` below): before making a new backup, check
 * whether the existing (unsuffixed) `<dbPath>.pre-migration-backup` already
 * protects everything currently pending, via a small sidecar file recording
 * exactly which `table.column` pairs that backup was taken to guard (written
 * alongside it, `<backupPath>.pending-columns`). If the current pending set
 * is a subset of what that snapshot already covers — the common shape of a
 * retry, where some items may have already succeeded and dropped off the
 * pending list, but nothing NEW has appeared — the existing backup is reused
 * and no new copy is made. A genuinely later, separate migration event
 * (e.g. a future schema version adding different columns) has a pending set
 * that is NOT a subset of any prior snapshot's coverage, so it still gets
 * its own fresh backup (falling through to `backup.ts`'s ordinary numbered
 * scheme). This intentionally only special-cases the base/unsuffixed
 * backup — the realistic failure this guards against is a tight
 * retry-vs-the-same-failure loop, which always retries against that same
 * base snapshot rather than against some already-superseded numbered one.
 *
 * (Out of scope, deliberately not addressed here: cross-process concurrency.
 * Verified empirically that Kuzu already takes an OS-level file lock on the
 * DB — a second process opening the same path fails cleanly with an `IO
 * exception: Could not set lock on file` rather than racing this migration,
 * so no additional locking was added for that case.)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

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
 * (table, column) pairs whose historical value is, for every CLI/MCP-
 * reachable code path, a certain inference rather than a guess — see the
 * module doc's "Backfilling a known historical `provider`" section for the
 * full reasoning, INCLUDING the one theoretical exception (a library
 * consumer hand-writing rows via `GraphConnection` directly) this backfill
 * cannot distinguish from the common case and accepts as a safe default
 * rather than a hard guarantee.
 *
 * Each entry carries:
 *   - `checkMatch` + `countVar`: the read-only `MATCH ... WHERE ... IS NULL`
 *     clause and the variable it binds, used to build a "how many rows still
 *     need this backfill?" count for this `(table,column)`. These are
 *     combined into ONE `UNION ALL` query per {@link detectPendingColumnMigrations}
 *     call (see `checkAllBackfillsPending` below) rather than issued as N
 *     separate round-trips — cheap in principle either way, but this native
 *     binding has a documented finite budget of DB open/query/close cycles
 *     per process before an unrelated native crash (see
 *     `test/structural-memory.test.ts`'s module doc), so minimising
 *     round-trips here is real, measured insurance against spending that
 *     budget faster than necessary — not just a micro-optimisation.
 *   - `apply`: the actual `WHERE ... IS NULL` `SET` that performs the
 *     backfill; safe to re-run any number of times since it only ever
 *     touches rows still `NULL`.
 * (Node vs. rel Cypher patterns differ, so this is hand-written data, not a
 * single generic template.)
 */
const KNOWN_HISTORICAL_PROVIDER_BACKFILL: ReadonlyMap<string, { checkMatch: string; countVar: string; apply: string }> = new Map([
  [
    "Function.provider",
    {
      checkMatch: "MATCH (n:Function) WHERE n.provider IS NULL",
      countVar: "n",
      apply: "MATCH (n:Function) WHERE n.provider IS NULL SET n.provider = 'tree-sitter'",
    },
  ],
  [
    "Class.provider",
    {
      checkMatch: "MATCH (n:Class) WHERE n.provider IS NULL",
      countVar: "n",
      apply: "MATCH (n:Class) WHERE n.provider IS NULL SET n.provider = 'tree-sitter'",
    },
  ],
  [
    "CALLS.provider",
    {
      checkMatch: "MATCH (:Function)-[r:CALLS]->(:Function) WHERE r.provider IS NULL",
      countVar: "r",
      apply: "MATCH (:Function)-[r:CALLS]->(:Function) WHERE r.provider IS NULL SET r.provider = 'tree-sitter'",
    },
  ],
]);

/**
 * Run every `key`'s `checkMatch` count in ONE combined `UNION ALL` query
 * (verified empirically to work against this project's pinned Kuzu fork:
 * each independent `MATCH ... RETURN 'key' AS key, count(x) AS c` branch
 * still aggregates correctly to exactly one row per branch, including when
 * a branch's `MATCH` has zero matches) instead of one native round-trip per
 * key — see {@link KNOWN_HISTORICAL_PROVIDER_BACKFILL}'s doc for why that
 * matters here. Returns the set of keys whose count was `> 0` (i.e. still
 * have at least one row pending that backfill). `keys` must be non-empty.
 */
async function checkAllBackfillsPending(conn: GraphConnection, keys: readonly string[]): Promise<Set<string>> {
  const branches = keys.map((key) => {
    const entry = KNOWN_HISTORICAL_PROVIDER_BACKFILL.get(key);
    if (entry === undefined) {
      throw new Error(`checkAllBackfillsPending: unknown key "${key}" — not in KNOWN_HISTORICAL_PROVIDER_BACKFILL`);
    }
    // `key` is always one of this module's own hardcoded map keys (never
    // user/DB-controlled input), so inlining it as a Cypher string literal
    // here is safe.
    return `${entry.checkMatch} RETURN '${key}' AS key, count(${entry.countVar}) AS c`;
  });
  const rows = await conn.query(branches.join("\nUNION ALL\n"));
  const pendingKeys = new Set<string>();
  for (const row of rows) {
    if (Number(row.c ?? 0) > 0) {
      pendingKeys.add(String(row.key));
    }
  }
  return pendingKeys;
}

/**
 * {@link ColumnMigration} plus whether the column is genuinely missing (and
 * so needs a real `ALTER TABLE ... ADD`) vs. already exists and is pending
 * ONLY because its {@link KNOWN_HISTORICAL_PROVIDER_BACKFILL} backfill
 * stalled on a prior run. Internal to this module: {@link migrateSchemaColumns}
 * uses `needsAlter` to skip re-issuing `ALTER TABLE` for a column that's
 * already there (not just because it's redundant — Kuzu's own
 * `ALTER ... ADD IF NOT EXISTS` is a documented no-op either way — but
 * because there is no reason to touch the catalog again for a column that
 * hasn't changed, so this module doesn't). The public
 * {@link detectPendingColumnMigrations} strips this field so external callers
 * keep seeing the same `{ table, column, type }` shape as before.
 */
interface PendingColumnMigration extends ColumnMigration {
  readonly needsAlter: boolean;
}

/**
 * Read-only pass: compare `schema.ts`'s declared columns against what each
 * table on disk actually has, and report every gap.
 *
 * Reports two DISTINCT shapes of pending work (see {@link PendingColumnMigration}):
 *   1. the column is missing from the on-disk table entirely; or
 *   2. the column already exists, but it's one of
 *      {@link KNOWN_HISTORICAL_PROVIDER_BACKFILL}'s targets AND that
 *      backfill hasn't finished (some rows are still `NULL`) — this is the
 *      resumability fix: it catches a prior run that crashed after its
 *      `ALTER` committed but before its paired backfill `SET` ran, which
 *      would otherwise silently and permanently orphan that backfill (see
 *      the module doc's "Resumability" section).
 */
async function detectPendingColumnMigrationsInternal(conn: GraphConnection): Promise<PendingColumnMigration[]> {
  const pending: PendingColumnMigration[] = [];
  // Columns that already exist and are registered KNOWN_HISTORICAL_PROVIDER_BACKFILL
  // targets — checked in one combined round-trip below (once this first pass
  // over every table's existing columns has finished) rather than per-column.
  const backfillCandidates: ColumnMigration[] = [];

  for (const { table, columns } of declaredTables()) {
    const existing = await getExistingColumnNames(conn, table);
    if (existing === null) continue; // table doesn't exist yet; not this module's concern
    for (const col of columns) {
      if (!existing.has(col.name)) {
        pending.push({ table, column: col.name, type: col.type, needsAlter: true });
        continue;
      }
      // Column already exists. It's a candidate for "backfill stalled on a
      // prior run" (see the module doc's "Resumability" section) only if
      // it's a known backfill target — deferred to a single combined check
      // below rather than queried here, one at a time.
      if (KNOWN_HISTORICAL_PROVIDER_BACKFILL.has(`${table}.${col.name}`)) {
        backfillCandidates.push({ table, column: col.name, type: col.type });
      }
    }
  }

  if (backfillCandidates.length > 0) {
    const stillPending = await checkAllBackfillsPending(
      conn,
      backfillCandidates.map((c) => `${c.table}.${c.column}`),
    );
    for (const candidate of backfillCandidates) {
      if (stillPending.has(`${candidate.table}.${candidate.column}`)) {
        pending.push({ ...candidate, needsAlter: false });
      }
    }
  }

  return pending;
}

/** Public, read-only preview of what {@link migrateSchemaColumns} would do — never mutates anything, safe to call any time. */
export async function detectPendingColumnMigrations(conn: GraphConnection): Promise<ColumnMigration[]> {
  return (await detectPendingColumnMigrationsInternal(conn)).map(({ table, column, type }) => ({ table, column, type }));
}

/** Sorted `"table.column"` identifiers for a pending set — used as the comparable "signature" of what a backup protects. */
function pendingSignature(pending: readonly ColumnMigration[]): string[] {
  return [...new Set(pending.map((p) => `${p.table}.${p.column}`))].sort();
}

/** Sidecar file recording exactly which `table.column` pairs a given backup was taken to protect (see `ensureBackup`). */
function pendingSignatureFile(backupPath: string): string {
  return `${backupPath}.pending-columns`;
}

/**
 * Ensure a pre-migration backup exists that protects the CURRENT `pending`
 * set, reusing an already-on-disk backup from an immediately-prior attempt
 * instead of blindly making another full-DB copy every retry — see the
 * module doc's "Bounding backup accumulation across retries" section for the
 * full rationale.
 *
 * Reuses the existing unsuffixed `<dbPath>.pre-migration-backup` when its
 * recorded signature (sidecar `.pending-columns` file) already covers
 * everything in `pending` (a retry of the same attempt, possibly with some
 * items already resolved and dropped off the list). Otherwise falls through
 * to `backupDbFile`'s ordinary never-overwrite numbered-suffix scheme (a
 * genuinely new, later migration event) and records the new backup's
 * signature alongside it.
 *
 * Fails closed rather than silently migrating unprotected: if there IS
 * pending work but no backup could be made or reused (the only way
 * `backupDbFile` returns `null` is a `dbPath` that doesn't exist on disk —
 * which should be impossible here, since pending work means some table on
 * that exact connection already has rows, so Kuzu must already have created
 * the file), this throws instead of proceeding, since something about that
 * assumption has been violated and altering table schema without a safety
 * net is exactly the risk this module exists to avoid.
 */
function ensureBackup(conn: GraphConnection, pending: readonly ColumnMigration[]): string {
  const currentSig = pendingSignature(pending);
  const basePath = `${conn.path}.pre-migration-backup`;
  const sigFile = pendingSignatureFile(basePath);

  if (existsSync(basePath) && existsSync(sigFile)) {
    const priorSig = new Set(
      readFileSync(sigFile, "utf8")
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    if (currentSig.every((s) => priorSig.has(s))) {
      return basePath;
    }
  }

  const backupPath = backupDbFile(conn.path);
  if (backupPath === null) {
    throw new Error(
      `migrateSchemaColumns: detected ${pending.length} pending column migration(s) on "${conn.path}" but the DB file does not exist on disk to back up — refusing to ALTER TABLE without a safety net. This should not be reachable in practice (a pending migration implies the table already has data, which implies the file already exists); if you're seeing this, something about that assumption doesn't hold for this connection.`,
    );
  }
  writeFileSync(pendingSignatureFile(backupPath), `${currentSig.join("\n")}\n`, "utf8");
  return backupPath;
}

/**
 * Detect + (if anything is pending) checkpoint + back up + apply every
 * missing column as a non-destructive `ALTER TABLE ... ADD IF NOT EXISTS` —
 * existing rows keep every property they already have and get `NULL` for the
 * new column, except the narrow, explicit backfills in
 * {@link KNOWN_HISTORICAL_PROVIDER_BACKFILL} above (which, per
 * {@link detectPendingColumnMigrations}'s doc, are also re-attempted on a
 * resumed run even when the column itself already existed from a prior,
 * crashed attempt).
 *
 * Idempotent and cheap when the schema is already current: one
 * `table_info` read per declared table (plus, only for tables/columns that
 * ARE current, one narrow "any NULL left to backfill?" read for the three
 * `KNOWN_HISTORICAL_PROVIDER_BACKFILL` targets), zero writes, zero
 * checkpoint, zero backup.
 */
export async function migrateSchemaColumns(conn: GraphConnection): Promise<SchemaMigrationReport> {
  const pendingInternal = await detectPendingColumnMigrationsInternal(conn);
  if (pendingInternal.length === 0) {
    return { migrated: [], backupPath: null };
  }
  const pending: ColumnMigration[] = pendingInternal.map(({ table, column, type }) => ({ table, column, type }));

  // Flush the WAL into the main file first so the backup below is a
  // fully-consistent snapshot, not one that might depend on WAL entries not
  // yet merged into it (verified empirically: `CHECKPOINT` removes the
  // `.wal` sidecar and leaves data queryable — see this module's doc).
  await conn.execute("CHECKPOINT");

  const backupPath = ensureBackup(conn, pending);

  for (const { table, column, type, needsAlter } of pendingInternal) {
    // Only issue the `ALTER TABLE ... ADD IF NOT EXISTS` when the column is
    // genuinely missing. `IF NOT EXISTS` is a documented no-op when it
    // already exists (see the module doc's experiment), but the resumability
    // case (this entry pending only because its backfill stalled last time —
    // `needsAlter: false`) has no reason to touch the catalog again for a
    // column that's already there: the backfill below is what actually does
    // the work in that case.
    if (needsAlter) {
      await conn.execute(`ALTER TABLE ${table} ADD IF NOT EXISTS ${column} ${type} DEFAULT NULL`);
    }

    const backfill = KNOWN_HISTORICAL_PROVIDER_BACKFILL.get(`${table}.${column}`);
    if (backfill !== undefined) {
      await conn.execute(backfill.apply);
    }
  }

  return { migrated: pending, backupPath };
}
