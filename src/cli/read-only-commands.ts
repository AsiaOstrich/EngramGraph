/**
 * Commands that only read the graph (XSPEC-374).
 *
 * Opening read-only is what makes concurrent use safe, not faster: the engine
 * is single-writer, and writer-vs-writer does not merely refuse the loser — it
 * corrupts the database. A read-only open can be refused, and that is all it
 * can do. Measured matrix in `test/read-only-concurrency.test.ts`.
 *
 * THE DEFAULT IS WRITE, and the two directions of error are not symmetric:
 *
 *   - Omitting a read-only command costs a concurrency opportunity. Nothing
 *     breaks; it opens for writing as it always did.
 *   - Listing a command that writes BREAKS IT, at runtime, in the user's hands.
 *
 * The first draft listed eleven and three of them wrote — `god-nodes`,
 * `communities` and `related` install the algo extension and build a projected
 * graph before they can rank anything. It shipped green because `related`
 * returns early when the seed id is absent, and every case written for it used
 * an absent id, so the write path was never reached. It failed the first time
 * a node that exists was passed to it.
 *
 * This lives in its own module for a dull but load-bearing reason: `cli/index`
 * calls `main()` at import time, so a test importing the list from there would
 * run the CLI and exit the test process.
 *
 * `test/read-only-command-list.test.ts` executes EVERY entry against a real
 * read-only connection on a populated graph. The list is still written by hand
 * — a command's arguments cannot be derived — but it is no longer asserted by
 * hand: adding an entry here that writes turns that test red.
 */
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "callers",
  "callees",
  "implementers",
  "implemented-by",
  "impact",
  "top",
  "blindspots",
  "signatures",
]);
