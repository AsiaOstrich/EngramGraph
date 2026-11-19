// SPDX-License-Identifier: MIT
/**
 * A command whose reader has gone away still finishes its work.
 *
 * `egr index <dir> | head`, a terminal closed under a running command, and — the case that matters most — `egr watch`
 * being killed while the `egr index` it started is mid-run (that run's stdout and stderr are pipes to the watcher) all
 * leave a process whose next write to stdout or stderr fails with EPIPE. Node turns that into an `'error'` event on
 * the stream, and an `'error'` event nobody listens for is an uncaught exception: the process dies with exit 1 and a
 * stack trace nobody sees, at the line that prints the result — which is BEFORE the CHECKPOINT that folds the
 * write-ahead log into the graph and before the exit status is set. The work had been done; the ending was lost.
 *
 * The report is for a reader; with no reader there is nothing to lose by not delivering it. So a write error that
 * means "the other end is gone" is ignored, and the command goes on to its own ending.
 *
 * Only that error is ignored: any other write failure (a full disk behind a redirect, say) is still an uncaught
 * exception, as before — it means the output the user asked for was not delivered, which is not the same thing.
 *
 * Not for the commands that exist to talk to a client (`egr mcp`, `egr serve`) or to keep running for a reader
 * (`egr watch`): for those, a vanished reader is the signal to stop, and the default (die) is the right behaviour.
 * Windows: not tested there (a closed pipe may be reported differently).
 */

/** Errors that say the other end of the stream is gone. */
const GONE = new Set(["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"]);

export function isReaderGone(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && GONE.has(code);
}

/**
 * Give stdout and stderr an `'error'` listener that swallows the "reader gone" errors and re-throws the rest (so they stay
 * uncaught exceptions, as without a listener). Returns the stream-error handler it installed, for tests.
 */
export function ignoreClosedOutput(streams: readonly NodeJS.WriteStream[] = [process.stdout, process.stderr]): (err: Error) => void {
  const onError = (err: Error): void => {
    if (isReaderGone(err)) return;
    throw err;
  };
  for (const s of streams) s.on("error", onError);
  return onError;
}
