import { Database, Connection } from "ryugraph";
import type { RyuValue, QueryResult } from "ryugraph";

import type { GraphRow } from "./types.js";

/** Normalise the `QueryResult | QueryResult[]` shape to a plain array (a single multi-statement `query`/`execute` call can return either). */
function asResultArray(result: QueryResult | QueryResult[]): QueryResult[] {
  return Array.isArray(result) ? result : [result];
}

/**
 * Thin wrapper around a Kuzu {@link Database} + {@link Connection} pair.
 *
 * Owns the lifecycle of both handles and exposes a small `query` helper that
 * always resolves to plain rows (`Record<string, unknown>[]`), so callers never
 * touch the raw QueryResult cursor API.
 *
 * Verified against ryugraph@25.9.1 (kuzu fork).
 */
export class GraphConnection {
  private readonly db: Database;
  private readonly conn: Connection;
  private readonly dbFilePath: string;
  private closed = false;
  private readonly readOnlyMode: boolean;

  private constructor(dbPath: string, readOnly: boolean) {
    // 4th positional arg is ryugraph's readOnly flag.
    this.db = new Database(dbPath, undefined, undefined, readOnly);
    this.conn = new Connection(this.db);
    this.dbFilePath = dbPath;
    this.readOnlyMode = readOnly;
  }

  /**
   * Open (or create) a graph database at `dbPath`.
   *
   * ## Read-only is not an optimisation, it is what makes concurrency safe
   *
   * The engine is single-writer, and every `egr` invocation used to open for
   * writing — even a pure query, because opening runs `initSchema`. Measured
   * on a real graph:
   *
   *   writer + writer   → one wins, the rest are refused, AND THE GRAPH IS
   *                       CORRUPTED (every later query fails with an
   *                       unintelligible binder error)
   *   reader + reader   → all succeed, graph intact
   *   writer + reader   → the reader is refused with "Could not set lock on
   *                       file", graph intact
   *   reader + writer   → the writer is refused the same way, graph intact
   *
   * So the damage is specific to writer-vs-writer. A query opened read-only
   * can be refused, but it cannot destroy anything — which is why every
   * read-only command now says so, rather than taking a write lock it never
   * needed (XSPEC-374).
   */
  static open(dbPath: string, opts: { readOnly?: boolean } = {}): GraphConnection {
    return new GraphConnection(dbPath, opts.readOnly === true);
  }

  /** Whether this connection was opened read-only. */
  get readOnly(): boolean {
    return this.readOnlyMode;
  }

  /**
   * Run a Cypher statement and return all rows.
   *
   * @param cypher A Cypher query or DDL statement.
   * @param params Optional parameters for a prepared/parameterised statement.
   */
  async query(
    cypher: string,
    params?: Record<string, RyuValue>,
  ): Promise<GraphRow[]> {
    if (this.closed) {
      throw new Error("GraphConnection is closed");
    }

    const result =
      params && Object.keys(params).length > 0
        ? await this.conn.execute(await this.conn.prepare(cypher), params)
        : await this.conn.query(cypher);

    // Every `QueryResult` (there can be more than one for a multi-statement
    // call) holds native-side cursor resources that are NOT freed by GC in
    // any bounded way — `ryugraph`'s own `QueryResult.close()` exists
    // specifically to release them promptly. Leaving this uncalled (as an
    // earlier version of this method did) leaks a native handle on every
    // single query; harmless in small numbers, but this project's native
    // binding has an empirically-observed finite budget of such
    // handles/cycles per process before an unrelated crash at worker
    // teardown (see `test/structural-memory.test.ts`'s and
    // `test/schema-migration.test.ts`'s module docs) — calling `close()`
    // here, unconditionally and for every result (not just the one whose
    // rows we return), is real, verified insurance against exhausting that
    // budget faster than necessary in any code path that issues many
    // queries against one long-lived connection.
    const results = asResultArray(result);
    try {
      return await results[results.length - 1]!.getAll();
    } finally {
      for (const r of results) {
        r.close();
      }
    }
  }

  /** Run a statement when the result set is irrelevant (DDL, writes). */
  async execute(
    cypher: string,
    params?: Record<string, RyuValue>,
  ): Promise<void> {
    await this.query(cypher, params);
  }

  /** Expose the raw Connection for advanced callers (prepare/execute). */
  get raw(): Connection {
    return this.conn;
  }

  /**
   * The on-disk path this connection was opened against (as passed to
   * {@link GraphConnection.open}). Used by tooling that needs filesystem
   * access alongside the connection, e.g. `schema-migration.ts`'s
   * pre-migration backup, which copies this file before altering table
   * schema.
   */
  get path(): string {
    return this.dbFilePath;
  }

  /** Close the connection and database. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.conn.close();
    await this.db.close();
  }
}
