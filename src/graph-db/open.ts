/**
 * Shared graph-DB open helper used by the CLI and the MCP stdio bin.
 *
 * Resolves the DB path, ensures the parent dir exists, opens the connection,
 * creates any missing tables (`initSchema`), then non-destructively migrates
 * any missing COLUMNS on tables that already existed (`migrateSchemaColumns`
 * — see `schema-migration.ts`'s module doc for why this is needed: Kuzu's
 * `CREATE TABLE` is a no-op on a table that already exists, so a schema
 * change like XSPEC-333 R1/R3's `provider`/`confidence` columns never
 * reaches an on-disk DB created before that change without this step).
 * Since every real CLI/MCP/REST command opens its connection through this one
 * function, this makes schema migration fully automatic — no `egr migrate`
 * command for a user to remember to run. When a migration actually happens,
 * it is reported on stderr (not stdout, so `--json` output stays clean) with
 * the backup path `migrateSchemaColumns` made before altering anything.
 *
 * The connection is long-lived; callers do NOT close it
 * mid-process (Kuzu's native close can deadlock with tree-sitter co-loaded) —
 * the OS reclaims it on process exit.
 *
 * Path resolution priority:
 *   1. explicit `dbPath` (programmatic; caller knows best)
 *   2. env `ENGRAM_DB` (highest user-facing knob — a full path)
 *   3. `graph` name → `<cwd>/.engram/<name>.db`
 *   4. git-branch isolation (opt-in via `isolation: "git-branch"` or env
 *      `ENGRAM_ISOLATION=git-branch`) → `<git-common-dir>/engram/<branch>.db`
 *      (falls back to #5 when not a git repo / detached HEAD)
 *   5. single default → `<cwd>/.engram/graph.db`
 */

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { GraphConnection } from "./connection.js";
import { initSchema } from "./schema.js";
import { migrateSchemaColumns } from "./schema-migration.js";
import { gitBranchDbPath } from "./git-branch.js";

export type IsolationMode = "single" | "git-branch";

export interface GraphLocationOptions {
  /** Explicit DB path (wins over everything). */
  dbPath?: string;
  /** Explicit graph name → `<cwd>/.engram/<name>.db`. */
  graph?: string;
  /** Isolation mode; defaults to env `ENGRAM_ISOLATION` else `"single"`. */
  isolation?: IsolationMode;
  /** Working dir for git detection / relative paths (default `process.cwd()`). */
  cwd?: string;
}

/** Sanitize a user-supplied graph name to a safe single path segment. */
function sanitizeGraphName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "graph";
}

/** Resolve the graph DB path per the SPEC-245 priority order. */
export function resolveDbPath(loc: string | GraphLocationOptions = {}): string {
  const o: GraphLocationOptions = typeof loc === "string" ? { dbPath: loc } : loc;
  const cwd = o.cwd ?? process.cwd();

  // 1. explicit programmatic path
  if (o.dbPath) return resolve(o.dbPath);
  // 2. env ENGRAM_DB (legacy CODESAGE_DB still honored as a fallback)
  const envDb = process.env.ENGRAM_DB ?? process.env.CODESAGE_DB;
  if (envDb) return resolve(envDb);
  // 3. explicit graph name
  if (o.graph) return resolve(join(cwd, ".engram", `${sanitizeGraphName(o.graph)}.db`));
  // 4. git-branch isolation (opt-in; legacy CODESAGE_ISOLATION honored too)
  const isoEnv = process.env.ENGRAM_ISOLATION ?? process.env.CODESAGE_ISOLATION;
  const mode: IsolationMode = o.isolation ?? (isoEnv === "git-branch" ? "git-branch" : "single");
  if (mode === "git-branch") {
    const branchPath = gitBranchDbPath(cwd);
    if (branchPath) return branchPath; // else fall through to single default
  }
  // 5. single default
  return resolve(join(cwd, ".engram", "graph.db"));
}

/** Open (creating dirs) + schema-init (+ auto-migrate) a graph connection. */
export async function openGraph(loc?: string | GraphLocationOptions): Promise<GraphConnection> {
  const path = resolveDbPath(loc ?? {});
  mkdirSync(dirname(path), { recursive: true });
  const conn = GraphConnection.open(path);
  await initSchema(conn);

  const migration = await migrateSchemaColumns(conn);
  if (migration.migrated.length > 0) {
    const cols = migration.migrated.map((m) => `${m.table}.${m.column}`).join(", ");
    process.stderr.write(
      `[egr] graph DB schema migrated: added column(s) ${cols} (existing rows keep NULL for them — see ` +
        `graph-db/schema-migration.ts). Backup of the pre-migration DB saved to: ${migration.backupPath}\n`,
    );
  }

  return conn;
}
