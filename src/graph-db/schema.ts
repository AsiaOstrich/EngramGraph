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
  `CREATE NODE TABLE Function(id STRING, name STRING, file STRING, start_line INT64, confidence DOUBLE, PRIMARY KEY(id))`,
  `CREATE NODE TABLE Class(id STRING, name STRING, file STRING, PRIMARY KEY(id))`,
  `CREATE NODE TABLE Module(id STRING, path STRING, PRIMARY KEY(id))`,
  `CREATE NODE TABLE Spec(id STRING, title STRING, status STRING, confidence DOUBLE, PRIMARY KEY(id))`,
  `CREATE NODE TABLE Decision(id STRING, title STRING, date STRING, confidence DOUBLE, PRIMARY KEY(id))`,
  `CREATE NODE TABLE Doc(id STRING, title STRING, status STRING, confidence DOUBLE, PRIMARY KEY(id))`,
];

/** REL TABLE DDL statements. Must run after their endpoint NODE tables. */
export const REL_TABLE_DDL: readonly string[] = [
  `CREATE REL TABLE CALLS(FROM Function TO Function, call_count INT64)`,
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
