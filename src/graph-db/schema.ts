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
  // until now. Nullable for schema-migration safety (a pre-existing DB's
  // rows have no value until re-indexed), but NOT left NULL by design on any
  // freshly-written tree-sitter edge any more: `buildCallEdges()`
  // (extractor.ts) originally only ever set `call_count`, and that NULL
  // silently defeated the whole point of these two columns — `writer.ts`'s
  // `shouldOverwrite` treats a `null`/`undefined` existing `confidence` as
  // "no signal to compare against" and refuses to let ANY other provider
  // overwrite that edge's properties, so a second provider could only ever
  // *fill a gap* (write a CALLS edge tree-sitter never created), never
  // upgrade one tree-sitter already resolved — confirmed end-to-end against
  // a real second provider (SCIP) in an earlier version of
  // `test/scip-merge.test.ts`. R3 OQ-4 fixed this at the source instead of
  // in the merge policy: `buildCallEdges()` now stamps every CALLS edge it
  // writes with `confidence: CALLS_CONFIDENCE` (0.6, see extractor.ts's
  // module doc for the calibration rationale) and `provider: "tree-sitter"`,
  // an honest, non-null confidence for its bare-name resolution heuristic —
  // so a higher-confidence provider (SCIP at 0.9) can now upgrade it through
  // the SAME, unmodified `shouldOverwrite` policy. See
  // `test/scip-merge.test.ts` for this verified end-to-end.
  //
  // IMPORTANT for any already-existing on-disk Kuzu DB created before this
  // change: `initSchema` only ever `CREATE`s tables (see below) — Kuzu
  // 0.11.x's `IF NOT EXISTS` handling means a pre-existing `CALLS` table
  // missing these two columns is silently left as-is (the "already exists"
  // error is swallowed), NOT altered. A DB indexed before this migration
  // therefore needs a full `--clean` rebuild (this repo's own
  // `index-all.sh --clean` / `egr index --clean`, per dev-platform's
  // CLAUDE.md rule "egr schema 變動時必須 --clean") before any SCIP ingest can
  // write `provider`/`confidence` onto a CALLS edge — writing against a
  // stale schema throws a Kuzu binder error (`r.provider` / `r.confidence`
  // do not exist on that table), it does not silently no-op.
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
