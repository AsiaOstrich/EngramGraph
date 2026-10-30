/**
 * Fold the write-ahead log into the database file.
 *
 * ## Why the graph must not live only in the log
 *
 * The engine writes to `graph.db.wal` first and moves the data into `graph.db` at a
 * CHECKPOINT. A process that exits without one leaves the data only in the log. Measured
 * 2026-08-13: `graph.db` was 4096 bytes (opened alone: "Table does not exist") and the
 * 11.9 MB `.wal` was the whole graph. Deleting the `.wal`, or backing up `graph.db` alone,
 * loses everything; every later open also replays the log (measured 245 ms against 49 ms
 * per query on a 4 MB log, which MCP pays on every query since it opens per call).
 *
 * Callers do not close the connection (the native close can deadlock with tree-sitter
 * loaded; see `open.ts`), so nothing checkpoints on close. This is the explicit step.
 *
 * ## A lock refusal is not a warning
 *
 * Several commands finish without touching the file (`related` on a seed with no
 * neighbours, `god-nodes` on an empty graph). Their CHECKPOINT is the first statement
 * that needs the write lock, so a lock refusal surfaces here and nowhere else
 * (XSPEC-457 R2, reported on Windows: exit status 0 while the engine printed the
 * refusal). That error is rethrown. Any other failure (disk full, I/O error) happens
 * AFTER the command did its work and printed its result, so it must not turn a
 * successful command into a failed one or hide what it printed: it is a warning, and
 * the data is still safe in the log.
 */

import type { GraphConnection } from "./connection.js";
import { isLockContention } from "./lease.js";

const stderrWrite = (message: string): void => void process.stderr.write(message);

/**
 * CHECKPOINT a writable connection. A read-only connection has nothing to fold and is not
 * asked to. Rethrows a lock refusal; warns (through `warn`, default stderr) for any other failure.
 */
export async function checkpointOrWarn(conn: GraphConnection, warn: (message: string) => void = stderrWrite): Promise<void> {
  if (conn.readOnly) return;
  try {
    await conn.execute("CHECKPOINT;");
  } catch (err) {
    if (isLockContention(err)) throw err;
    warn(
      `egr: warning: could not fold the write-ahead log into graph.db (${err instanceof Error ? err.message : String(err)}). ` +
        `The data is safe in graph.db.wal, but graph.db alone is incomplete until a later command checkpoints: keep the two files together.\n`,
    );
  }
}
