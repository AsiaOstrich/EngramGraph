import type { GraphConnection } from "./connection.js";

/**
 * Kuzu schema for EngramGraph.
 *
 * NODE tables: Function, Class, Module, Spec, Decision (+ generic Doc).
 * REL  tables: CALLS, IMPORTS, DEFINES, IMPLEMENTS, IMPACTS, SUPERSEDES, RELATES
 *              (+ generic REFERENCES for the default markdown knowledge source).
 *
 * IMPLEMENTS is Module→Spec (not Function→Spec): the `// implements XSPEC-NNN`
 * convention annotates whole files (233/275 usages sit at file top, incl.
 * function-less type/config files), so the file/Module is the faithful grain.
 * Function-level queries route through the existing DEFINES (Module→Function).
 */

/** NODE TABLE DDL statements, in dependency order. */
export const NODE_TABLE_DDL: readonly string[] = [
  // `provider` (XSPEC-333 R1): which extraction pipeline produced this node
  // (e.g. "tree-sitter", future "scip"/"lsif"/...). Existing tree-sitter-only
  // rows have no provider column value until re-indexed post-migration; the
  // extractor always stamps a literal default so freshly-written rows are
  // never ambiguous. See writer.ts for how this feeds the overwrite policy.
  `CREATE NODE TABLE Function(id STRING, name STRING, file STRING, start_line INT64, confidence DOUBLE, provider STRING, PRIMARY KEY(id))`,
  `CREATE NODE TABLE Class(id STRING, name STRING, file STRING, provider STRING, PRIMARY KEY(id))`,
  `CREATE NODE TABLE Module(id STRING, path STRING, PRIMARY KEY(id))`,
  `CREATE NODE TABLE Spec(id STRING, title STRING, status STRING, confidence DOUBLE, PRIMARY KEY(id))`,
  `CREATE NODE TABLE Decision(id STRING, title STRING, date STRING, confidence DOUBLE, PRIMARY KEY(id))`,
  `CREATE NODE TABLE Doc(id STRING, title STRING, status STRING, confidence DOUBLE, PRIMARY KEY(id))`,
];

/** REL TABLE DDL statements. Must run after their endpoint NODE tables. */
export const REL_TABLE_DDL: readonly string[] = [
  // `provider`/`confidence` (XSPEC-333 R3 PoC, upgraded R3 OQ-4): added so a
  // second CALLS provider (e.g. SCIP) can stamp provenance on an edge the
  // way Function/Class nodes already could (R1) — writer.ts's mergeEdge
  // overwrite-policy logic was already generic enough to support this (see
  // its module doc and test/writer-merge-policy.test.ts's synthetic
  // TEST_CALLS case), it simply had no real columns to read/write against
  // until now. Nullable because the DDL itself never changes existing rows
  // (see the non-ALTER caveat below) — NOT because tree-sitter is still
  // expected to leave them NULL: `buildCallEdges()` (extractor.ts)
  // originally only ever set `call_count`, and that NULL silently defeated
  // the whole point of these two columns — `writer.ts`'s `shouldOverwrite`
  // treats a `null`/`undefined` existing `confidence` as "no signal to
  // compare against" and refuses to let ANY other provider overwrite that
  // edge's properties, so a second provider could only ever *fill a gap*
  // (write a CALLS edge tree-sitter never created), never upgrade one
  // tree-sitter already resolved — confirmed end-to-end against a real
  // second provider (SCIP) in an earlier version of
  // `test/scip-merge.test.ts`. R3 OQ-4 fixed this at the source instead of
  // in the merge policy: `buildCallEdges()` now stamps every CALLS edge it
  // writes with an honest, non-null, per-resolution-tier `confidence`
  // (`CALLS_CONFIDENCE` in extractor.ts — see its module doc for the
  // tiering/calibration rationale) and `provider: "tree-sitter"`, so a
  // higher-confidence provider (SCIP at 0.9) can now upgrade it through the
  // SAME, unmodified `shouldOverwrite` policy. See `test/scip-merge.test.ts`
  // for this verified end-to-end, and `test/writer-merge-policy.test.ts`'s
  // dedicated regression test proving a genuinely NULL existing confidence
  // still blocks the overwrite (that invariant is unchanged and load-bearing
  // — it protects rows that predate this fix and haven't been re-indexed).
  //
  // IMPORTANT, and now with a WIDER blast radius than the paragraph above
  // might suggest: `initSchema` only ever `CREATE`s tables (see below) —
  // Kuzu 0.11.x's `IF NOT EXISTS` handling means a pre-existing `CALLS`
  // table missing these two columns is silently left as-is (the "already
  // exists" error is swallowed), NOT altered by `initSchema` itself.
  // Function/Class nodes never had this "column exists but tree-sitter
  // leaves it NULL" window at all — R1 (ccd4974) added their `provider`
  // column AND made tree-sitter stamp it unconditionally in the same
  // change, so a Function/Class row either predates that column entirely or
  // has always had a real value since the moment the column existed. CALLS
  // is different: 85c0e56 added the columns WITHOUT changing
  // `buildCallEdges()`, so a real window exists where the columns exist but
  // every tree-sitter-written CALLS edge has genuinely NULL `provider`/
  // `confidence` — and an EXISTING CALLS edge in that state does NOT
  // self-heal on a later plain re-index: the next tree-sitter write's
  // `provider: "tree-sitter"` is not `=== null`, so `shouldOverwrite` takes
  // the "different provider" branch, sees the existing NULL confidence, and
  // refuses — the edge is stuck with NULL provenance until it's re-created
  // from scratch. That refusal is a correctness feature, not a bug: nothing
  // here recovers "what confidence SHOULD this old edge have had" any better
  // than NULL already expresses ("no signal"), so leaving it alone is the
  // faithful answer, not a gap to close.
  //
  // **The missing-column problem itself IS fixed as of the schema-migration
  // work below** (`schema-migration.ts`'s `migrateSchemaColumns`, called by
  // `open.ts`'s `openGraph` right after `initSchema` on every connection
  // open): Kuzu's own `ALTER TABLE <name> ADD IF NOT EXISTS <col> <type>
  // DEFAULT NULL` (verified empirically to work against a REL table with
  // existing rows, preserving every other property and leaving the new
  // column `NULL` on old rows — see `test/schema-migration.test.ts`) adds
  // the column to the EXISTING table in place, so a DB whose `CALLS` table
  // predates 85c0e56, or whose `Function`/`Class` table predates R1, no
  // longer needs `--clean` or a from-scratch rebuild to stop hitting the
  // Kuzu binder error described above — it self-heals the moment any
  // command opens the DB through `openGraph`.
  //
  // This ALSO closes the "stuck with NULL provenance forever" refusal
  // described two paragraphs up — but only for the migration case, not the
  // narrower, already-accepted 85c0e56-to-OQ-4 production window: a DB whose
  // `CALLS` table PREDATES 85c0e56 entirely (missing the columns, not just
  // NULL-valued) has every existing edge backfilled with
  // `provider = 'tree-sitter'` the moment those columns are added (see
  // `schema-migration.ts`'s `KNOWN_HISTORICAL_PROVIDER_BACKFILL` — a logical
  // certainty, not a guess, since tree-sitter was the only CLI-reachable
  // writer before these columns existed at all), so the very next plain
  // `egr index` re-index un-freezes it via the ordinary same-provider path —
  // no `--clean` needed even for this. `confidence` is deliberately left
  // `NULL` (we don't know which resolution tier a historical edge was, and
  // guessing would be fabricating data), so a SCIP upgrade still needs that
  // one plain re-index to happen first before it can compare confidences.
  // An edge that ALREADY had these columns with genuine NULL values (written
  // during the real, narrow 85c0e56-to-OQ-4 production window this
  // migration doesn't touch at all, since the column already existed) is
  // untouched by any of this and remains the accepted "stuck until re-created
  // from scratch" case described above. `cli/run.ts`'s
  // `rethrowAsSchemaMigrationError` / `assertCallsSchemaHasProvenanceColumns`
  // remain as a defense-in-depth check for callers that construct a
  // `GraphConnection` directly and skip `openGraph` (e.g. tests), not as the
  // primary remediation path any more.
  `CREATE REL TABLE CALLS(FROM Function TO Function, call_count INT64, confidence DOUBLE, provider STRING)`,
  `CREATE REL TABLE IMPORTS(FROM Module TO Module)`,
  `CREATE REL TABLE DEFINES(FROM Module TO Function)`,
  `CREATE REL TABLE IMPLEMENTS(FROM Module TO Spec)`,
  `CREATE REL TABLE IMPACTS(FROM Decision TO Spec)`,
  `CREATE REL TABLE SUPERSEDES(FROM Decision TO Decision)`,
  // Spec→Spec upstream/downstream (front-matter related/depends_on + [[ref]]),
  // so the doc↔doc graph joins the code graph on the same Spec nodes IMPLEMENTS
  // points at — one node per artifact, no parallel Doc nodes (XSPEC-331 R2).
  `CREATE REL TABLE RELATES(FROM Spec TO Spec)`,
  `CREATE REL TABLE REFERENCES(FROM Doc TO Doc)`,
];

/** Logical names of every table this schema creates (for assertions/tests). */
export const NODE_TABLES = [
  "Function",
  "Class",
  "Module",
  "Spec",
  "Decision",
  "Doc",
] as const;

export const REL_TABLES = [
  "CALLS",
  "IMPORTS",
  "DEFINES",
  "IMPLEMENTS",
  "IMPACTS",
  "SUPERSEDES",
  "RELATES",
  "REFERENCES",
] as const;

/**
 * Treat a DDL error as benign iff it is an "already exists" error.
 *
 * Kuzu 0.11.x does not support `IF NOT EXISTS` on every version, so we make
 * `initSchema` idempotent by swallowing duplicate-table errors instead.
 */
function isAlreadyExistsError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already exists/i.test(message);
}

/**
 * Idempotently create all NODE and REL tables.
 *
 * Safe to call repeatedly: existing tables are skipped. Satisfies AC-1
 * (schema can be created / re-confirmed on init).
 */
export async function initSchema(conn: GraphConnection): Promise<void> {
  for (const ddl of [...NODE_TABLE_DDL, ...REL_TABLE_DDL]) {
    try {
      await conn.execute(ddl);
    } catch (err) {
      if (!isAlreadyExistsError(err)) {
        throw err;
      }
    }
  }
}

/**
 * Delete all data while keeping the tables.
 *
 * `DETACH DELETE` removes each node together with its relationships, so a
 * subsequent re-index rebuilds the graph from scratch — pruning nodes that no
 * longer exist on the current branch (the MERGE-based writer never deletes).
 * Safe to call on a freshly-initialised (empty) DB.
 */
export async function clearGraph(conn: GraphConnection): Promise<void> {
  for (const label of NODE_TABLES) {
    await conn.execute(`MATCH (n:${label}) DETACH DELETE n`);
  }
}
