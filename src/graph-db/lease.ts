// implements XSPEC-457
/**
 * A graph connection that is held only while something is using it.
 *
 * ## Why this exists (XSPEC-457 R1)
 *
 * The MCP server used to open the graph once, read-only, and keep it for as
 * long as the editor was open. Read-only was chosen (XSPEC-374) so that
 * terminal *queries* could run alongside it. But the engine's lock is taken at
 * open, not at first write: a reader that stays open refuses every writer, on
 * every platform. Measured on macOS, 2026-10-07, with one MCP server holding a
 * graph read-only: `egr index`, `egr feedback`, `egr god-nodes` and
 * `egr related` all exit 1 with `Could not set lock on file`. On Windows the
 * report was the same. The design goal ("assistant queries and terminal
 * commands run at the same time") was reached for terminal reads only.
 *
 * The fix is to hold the graph for the length of a query rather than the
 * length of the session: open read-only, answer, close. A terminal writer then
 * only collides with a query that is in flight right now, which is milliseconds
 * (measured below), not with an editor window that has been open all day.
 *
 * ## Why one shared open, not one open per call
 *
 * Each open of the engine reserves a very large range of address space. Eight
 * overlapping opens of one file in a single process died with
 * `Buffer manager exception: Mmap for size 8796093022208 failed` (measured
 * 2026-10-07). MCP clients do issue overlapping tool calls, so calls that
 * overlap share ONE open, counted by `refs`; the last one out closes it. Calls
 * that arrive while the close is still running wait for it and then open anew,
 * so two opens never coexist in one process.
 *
 * ## When a writer is in the way
 *
 * A refused open is retried with a short back-off for up to `lockWaitMs`. If
 * the writer is still there, the caller gets a {@link GraphBusyError} — an
 * error that says what is happening, never an empty answer: "nothing calls X"
 * and "I could not look" must not read the same.
 */

import type { GraphConnection } from "./connection.js";
import { openGraph } from "./open.js";

/** The engine's refusal when another process holds the file (any platform). */
export function isLockContention(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /could not set lock|lock on file|being used by another process/i.test(message);
}

/** The graph is locked by another process and stayed locked for the whole wait. */
export class GraphBusyError extends Error {
  readonly waitedMs: number;
  constructor(path: string, waitedMs: number, cause: unknown) {
    super(
      `The graph at ${path} is being written by another process (for example \`egr index\`), ` +
        `and it was still locked after ${Math.round(waitedMs / 100) / 10}s. ` +
        `This is not an empty result — the graph could not be read. Retry in a moment.`,
      { cause },
    );
    this.name = "GraphBusyError";
    this.waitedMs = waitedMs;
  }
}

/**
 * What the MCP server asks for a graph: a path (for tools that never open it)
 * and a way to run something against it. Either a {@link GraphLease}
 * (long-running server) or {@link fixedGraph} (a connection the caller owns —
 * tests, the REST health check).
 */
export interface GraphSource {
  readonly path: string;
  readonly readOnly: boolean;
  use<T>(fn: (conn: GraphConnection) => Promise<T>): Promise<T>;
}

/** Wrap a connection the caller already owns; it is never closed here. */
export function fixedGraph(conn: GraphConnection): GraphSource {
  return {
    path: conn.path,
    readOnly: conn.readOnly,
    use: (fn) => fn(conn),
  };
}

export interface GraphLeaseOptions {
  /** How long to keep retrying a refused open. Default 5000 ms; env `ENGRAM_LOCK_WAIT_MS` overrides. */
  lockWaitMs?: number;
  /** Test seam: how a connection is opened. Defaults to a read-only {@link openGraph}. */
  open?: (path: string) => Promise<GraphConnection>;
  /** Test seam: wait between retries. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Open read-only AND make the engine take its lock now.
 *
 * Opening does not lock: `new Database(path, …, readOnly)` returns without
 * error even while another process holds the file, and the refusal
 * (`Could not set lock on file`) arrives at the first query — and again at
 * `close()`. Measured 2026-10-07. Retrying only around the open would
 * therefore never retry anything, and the refusal would surface later as an
 * ordinary query failure. A trivial query here moves the refusal to where the
 * retry loop can see it.
 */
async function openAndTakeLock(path: string): Promise<GraphConnection> {
  const conn = await openGraph(path, { readOnly: true });
  try {
    await conn.query("RETURN 1 AS ok");
  } catch (err) {
    // The failed open still has to be released; its own close() is refused too.
    await conn.close().catch(() => undefined);
    throw err;
  }
  return conn;
}

const BACKOFF_MS = [25, 50, 100, 200, 400];

function defaultLockWaitMs(): number {
  const fromEnv = Number(process.env.ENGRAM_LOCK_WAIT_MS);
  return Number.isFinite(fromEnv) && fromEnv >= 0 && process.env.ENGRAM_LOCK_WAIT_MS ? fromEnv : 5000;
}

export class GraphLease implements GraphSource {
  readonly path: string;
  /** Always true: a lease never writes (XSPEC-374 keeps writer-vs-writer impossible from here). */
  readonly readOnly = true;

  private conn: GraphConnection | null = null;
  private opening: Promise<GraphConnection> | null = null;
  private closing: Promise<void> | null = null;
  private refs = 0;
  private readonly lockWaitMs: number;
  private readonly openFn: (path: string) => Promise<GraphConnection>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(path: string, opts: GraphLeaseOptions = {}) {
    this.path = path;
    this.lockWaitMs = opts.lockWaitMs ?? defaultLockWaitMs();
    this.openFn = opts.open ?? openAndTakeLock;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Whether the graph is held open right now (for tests and diagnostics). */
  get isOpen(): boolean {
    return this.conn !== null || this.opening !== null;
  }

  /** Run `fn` against the graph, holding it only for as long as `fn` takes. */
  async use<T>(fn: (conn: GraphConnection) => Promise<T>): Promise<T> {
    const conn = await this.acquire();
    try {
      return await fn(conn);
    } finally {
      await this.release();
    }
  }

  private async acquire(): Promise<GraphConnection> {
    // A close in flight must finish first: two opens must never coexist.
    while (this.closing) await this.closing;
    this.refs += 1;
    try {
      if (this.conn) return this.conn;
      if (!this.opening) {
        this.opening = this.openWithRetry().then(
          (c) => {
            this.conn = c;
            this.opening = null;
            return c;
          },
          (err) => {
            this.opening = null;
            throw err;
          },
        );
      }
      return await this.opening;
    } catch (err) {
      this.refs -= 1;
      throw err;
    }
  }

  private async release(): Promise<void> {
    this.refs -= 1;
    if (this.refs > 0 || !this.conn) return;
    const conn = this.conn;
    this.conn = null;
    // A failed close must not turn a successful query into a failed one.
    this.closing = conn
      .close()
      .catch((err: unknown) => {
        process.stderr.write(`[egr] warning: closing the graph failed (${err instanceof Error ? err.message : String(err)})\n`);
      })
      .finally(() => {
        this.closing = null;
      });
    await this.closing;
  }

  private async openWithRetry(): Promise<GraphConnection> {
    const started = Date.now();
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.openFn(this.path);
      } catch (err) {
        if (!isLockContention(err)) throw err;
        const waited = Date.now() - started;
        if (waited >= this.lockWaitMs) throw new GraphBusyError(this.path, waited, err);
        const step = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
        await this.sleep(Math.min(step, Math.max(1, this.lockWaitMs - waited)));
      }
    }
  }
}
