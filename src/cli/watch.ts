// SPDX-License-Identifier: MIT
/**
 * `egr watch <dir>` — keep the graph in step with the files.
 *
 * ## What it does
 *
 * Watches `<dir>`, waits until the changes stop coming (a debounce), then runs the incremental index that already
 * exists — `egr index <dir> --incremental` — and goes back to waiting. There is no second indexing path: the
 * incremental index hashes every file, parses only those whose content changed, and writes only the difference
 * (see `code-graph/incremental.ts`); what this module adds is the trigger.
 *
 * ## Why the index runs in a child process, not in this one
 *
 * 1. **The graph is held only while an index run is in flight.** The engine is single-writer and a writer refuses every
 *    reader (`graph-db/lease.ts`, XSPEC-457 R1). A watcher that opened the graph for writing and kept it would lock
 *    the MCP server and every terminal query out for as long as it ran — the very failure XSPEC-457 removed from the
 *    server. A child process holds the graph for its own lifetime, which is one index run (milliseconds to seconds),
 *    and its exit releases it.
 * 2. **It is exactly what a user would type.** The CHECKPOINT, the exit status and the lock refusal all come from
 *    the path `egr index` already has, so a manual `egr index` and the watcher cannot disagree about how a run ends.
 * 3. **A daemon should not accumulate native handles.** `graph-db/connection.ts` records that the engine's native
 *    close can deadlock beside tree-sitter and that a process has a finite budget of native handles; a process that
 *    lives for days and opens the graph over and over is the shape that meets that budget. A child per run never does.
 *
 * ## The lock
 *
 * `GraphLease` is the READER's way of holding the graph briefly (read-only, retried for a few seconds). The writer
 * here is the child, and it is refused with the engine's lock error whenever someone else holds the graph (another
 * `egr index`, `egr serve`, a query in flight). That refusal is recognised with `isLockContention` — the same test the
 * lease and the CLI use — and answered with a back-off and a log line, never an exit: the changes are not lost, the
 * next run indexes everything that changed since the last good one. Any other failure is logged and the watcher keeps
 * watching: the next change tries again.
 *
 * ## Known limits
 *
 * - `fs.watch` with `recursive` (macOS, Windows; Linux since Node 20). An editor that saves by writing a temp file
 *   and renaming it is seen as a change to the final name on all three.
 * - Every run hashes every file (that is what makes the incremental index correct). On a very large tree a run costs
 *   what reading the tree costs, not what the change costs.
 * - Documents are watched only with `--docs`, and `indexHealth.staleFiles` (which reads the parse-health manifest)
 *   counts code files only.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { statSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { basename, extname, resolve } from "node:path";

import { compileExcludes, type ExcludeMatcher } from "./exclude.js";
import { CODE_EXTS } from "./run.js";
import { SKIP_DIRS } from "./walk.js";
import { isLockContention } from "../graph-db/lease.js";

export const DEFAULT_DEBOUNCE_MS = 500;
/** Back-off after a refused index run: 0.5 s, doubling, never more than this. */
const MAX_LOCK_BACKOFF_MS = 15_000;
const FIRST_LOCK_BACKOFF_MS = 500;

/**
 * `--debounce <ms>`: a whole number of milliseconds (at most six digits), or the default when the flag is absent.
 * Lives here, not in the argument parser, so that the one rule is a function a test can call directly.
 */
export function parseDebounceMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_DEBOUNCE_MS;
  if (!/^[0-9]{1,6}$/.test(raw)) throw new Error(`--debounce must be a whole number of milliseconds (got "${raw}")`);
  return Number(raw);
}

export interface RelevanceOptions {
  /** `--docs`: Markdown files count too. */
  docs: boolean;
  /** `--exclude` globs, as `egr index` takes them. */
  exclude: readonly string[] | undefined;
}

/**
 * Whether a change at `relPath` (relative to the watched directory; either separator) can alter what `egr index` writes.
 *
 * Counts: a file with a source extension `egr index` parses, a file with no extension at all (a shell script with a
 * shebang is indexed by content), and — with `--docs` — Markdown. Does not count: anything under a directory the index
 * never walks (`node_modules`, `.git`, `.engram`, `dist`, … — `SKIP_DIRS`, so the graph's own files cannot start a
 * run of their own), anything `--exclude` leaves out, and every other extension (`.db`, `.wal`, `.json`, `.txt`).
 * Wrongly saying "yes" costs one run that finds nothing to do; wrongly saying "no" leaves the graph behind, so the
 * unsure case (no extension) says yes.
 */
export function isRelevantChange(relPath: string, opts: RelevanceOptions): boolean {
  const segments = relPath.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) return false;
  if (segments.some((s) => SKIP_DIRS.has(s))) return false;
  if (opts.exclude && opts.exclude.length > 0) {
    const matcher = compileExcludes(opts.exclude);
    if (isExcluded(matcher, segments)) return false;
  }
  const name = segments[segments.length - 1]!;
  const ext = extname(name).toLowerCase();
  if (ext === "") return true;
  if (CODE_EXTS.includes(ext)) return true;
  return opts.docs && ext === ".md";
}

/** The same question `egr index` asks while walking: is any directory on the way, or the file itself, excluded. */
function isExcluded(matcher: ExcludeMatcher, segments: readonly string[]): boolean {
  for (let i = 0; i < segments.length; i += 1) {
    const rel = segments.slice(0, i + 1).join("/");
    if (matcher.matches(rel, segments[i]!, i < segments.length - 1)) return true;
  }
  return false;
}

export interface WatchOptions {
  dir: string;
  /** Quiet time, in ms, to wait after the last change before indexing. */
  debounceMs: number;
  docs?: boolean;
  exclude?: string[];
  /** `--graph` / `--isolation`, passed on so the child opens the same graph this command would. */
  graph?: string;
  isolation?: string;
  /** Status lines (stdout). */
  log?: (line: string) => void;
  /** Failures (stderr). */
  logError?: (line: string) => void;
}

export interface Watcher {
  /** Resolves when the watcher has stopped (after `stop`, or when the initial index failed). */
  readonly done: Promise<number>;
  /** Stop watching; an index run in flight is allowed to finish first. A second call kills it. */
  stop(): void;
}

interface IndexRun {
  ok: boolean;
  /** The engine refused the graph because someone else holds it. */
  locked: boolean;
  /** The `incremental:` line of the summary, or the first stdout line. */
  summary: string;
  stderr: string;
}

/**
 * Start watching. Validates `dir` first (a directory that does not exist is an error, not a watcher that never fires),
 * starts listening BEFORE the first catch-up index so a change made during it is not lost, then runs that catch-up and
 * prints `[watch] ready`.
 */
export function startWatch(opts: WatchOptions): Watcher {
  const dir = resolve(opts.dir);
  try {
    if (!statSync(dir).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`${opts.dir} is not a directory`);
  }
  const log = opts.log ?? ((line: string) => void process.stdout.write(line + "\n"));
  const logError = opts.logError ?? ((line: string) => void process.stderr.write(line + "\n"));
  const relevance: RelevanceOptions = { docs: opts.docs === true, exclude: opts.exclude };
  // Fail now, with `--exclude`'s own message, on a malformed pattern rather than on the first change.
  if (opts.exclude?.length) compileExcludes(opts.exclude);
  // The longest a steady stream of saves can postpone an index run.
  const maxWaitMs = Math.max(5_000, opts.debounceMs * 4);

  const pending = new Set<string>();
  let firstPendingAt = 0;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopping = false;
  let child: ChildProcess | undefined;
  let wake: (() => void) | undefined; // ends a back-off sleep early (on stop)
  let finish!: (code: number) => void;
  const done = new Promise<number>((r) => (finish = r));

  // The command a user would type, run with the same node and the same arguments this process was started with.
  const indexArgs = (): string[] => [
    ...process.execArgv,
    process.argv[1]!,
    "index",
    dir,
    "--incremental",
    ...(opts.docs ? ["--docs"] : []),
    ...(opts.exclude ?? []).flatMap((e) => ["--exclude", e]),
    ...(opts.graph !== undefined ? ["--graph", opts.graph] : []),
    ...(opts.isolation !== undefined ? ["--isolation", opts.isolation] : []),
  ];

  const runIndexOnce = (): Promise<IndexRun> =>
    new Promise((res) => {
      let stdout = "";
      let stderr = "";
      // The one place an index run starts. Cutting this line leaves a watcher that sees changes and does nothing.
      child = spawn(process.execPath, indexArgs(), { stdio: ["ignore", "pipe", "pipe"], env: process.env }); // watch-spawn-index
      child.stdout!.on("data", (d) => (stdout += String(d)));
      child.stderr!.on("data", (d) => (stderr += String(d)));
      child.on("error", (err) => {
        child = undefined;
        res({ ok: false, locked: false, summary: "", stderr: err.message });
      });
      child.on("close", (code) => {
        child = undefined;
        const lines = stdout.split("\n");
        const summary = lines.find((l) => l.startsWith("incremental:")) ?? lines.find((l) => l.trim() !== "") ?? "";
        res({ ok: code === 0, locked: code !== 0 && isLockContention(stderr), summary, stderr });
      });
    });

  /** One index run, retried with a back-off while the graph is locked by someone else. */
  const runIndex = async (reason: string): Promise<IndexRun> => {
    let backoff = FIRST_LOCK_BACKOFF_MS;
    for (let attempt = 1; ; attempt += 1) {
      const r = await runIndexOnce();
      if (!r.locked || stopping) return r;
      log(`[watch] graph is locked by another writer; retry ${attempt} in ${backoff} ms (${reason})`);
      await new Promise<void>((resume) => {
        const t = setTimeout(resume, backoff);
        wake = () => {
          clearTimeout(t);
          resume();
        };
      });
      wake = undefined;
      if (stopping) return r;
      backoff = Math.min(backoff * 2, MAX_LOCK_BACKOFF_MS);
    }
  };

  const schedule = (): void => {
    if (stopping) return;
    if (timer) clearTimeout(timer);
    const waited = Date.now() - firstPendingAt;
    timer = setTimeout(() => void fire(), Math.max(0, Math.min(opts.debounceMs, maxWaitMs - waited)));
  };

  const fire = async (): Promise<void> => {
    timer = undefined;
    if (running || stopping || pending.size === 0) return; // a run in flight reschedules itself when it ends
    running = true;
    const batch = [...pending];
    pending.clear();
    firstPendingAt = 0;
    const reason = batch.length === 1 ? batch[0]! : `${batch.length} changed paths`;
    const r = await runIndex(reason);
    running = false;
    if (r.ok) log(`[watch] index done (${reason}): ${r.summary}`);
    else logError(`[watch] index failed (${reason}); watching on: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`);
    if (stopping) finish(0);
    else if (pending.size > 0) schedule(); // changes came in while it ran
  };

  const onEvent = (filename: string | null): void => {
    // A platform that cannot name the file gives no way to tell a source edit from the graph's own write; ignoring it
    // is what keeps the watcher from indexing its own output forever. (macOS, Windows and Linux all name it.)
    if (filename === null || filename === "") return;
    if (!isRelevantChange(filename, relevance)) return;
    if (pending.size === 0) firstPendingAt = Date.now();
    pending.add(filename.replace(/\\/g, "/"));
    schedule();
  };

  let fsw: FSWatcher;
  try {
    fsw = fsWatch(dir, { recursive: true }, (_event, filename) => onEvent(filename === null ? null : String(filename)));
  } catch (err) {
    throw new Error(`cannot watch ${opts.dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  fsw.on("error", (err) => logError(`[watch] the file watcher reported an error: ${err.message}`));

  let signals = 0;
  const stop = (): void => {
    signals += 1;
    stopping = true;
    fsw.close();
    if (timer) clearTimeout(timer);
    wake?.();
    if (signals > 1) {
      child?.kill("SIGKILL");
      finish(1);
      return;
    }
    if (running) log("[watch] stopping: letting the index run in progress finish (stop again to kill it)");
    else finish(0);
  };

  log(`[watch] watching ${dir} (debounce ${opts.debounceMs} ms); catching up first with: egr index ${basename(dir)} --incremental`);
  void (async () => {
    running = true;
    const first = await runIndex("initial");
    running = false;
    if (!first.ok) {
      logError(`[watch] the initial index failed, not watching: ${first.stderr.trim().split("\n").slice(-3).join(" | ")}`);
      fsw.close();
      finish(1);
      return;
    }
    log(`[watch] index done (initial): ${first.summary}`);
    log("[watch] ready");
    if (stopping) finish(0);
    else if (pending.size > 0) schedule(); // changes made while it caught up
  })();

  return { done, stop };
}
