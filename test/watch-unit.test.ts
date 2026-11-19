// SPDX-License-Identifier: MIT
/**
 * `startWatch` in this process: the debounce, the lock back-off, how a run ends, and how the watcher stops.
 *
 * `egr-watch.test.ts` runs `egr watch` as a child process and reads the effect back from a query. That is the proof
 * that the command works from its entry point, but a child process is invisible to the coverage tool and it can only
 * wait in real time, so it cannot walk the timing branches (a lock that stays locked for eight tries, a stream of saves
 * that never goes quiet). These cases do:
 *
 *  - the two things the watcher touches in the outside world are replaced, and nothing else: `fs.watch` (so the test
 *    decides when a file "changes") and `child_process.spawn` (so the test decides how an index run ends). Everything
 *    in `watch.ts`, `exclude.ts` and `lease.ts#isLockContention` is the real code.
 *  - time is fake, so a 15 s back-off is a line of test, not a wait.
 *
 * No source file was changed to make this possible (the mocks are at the module boundary).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const world = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    kill = vi.fn();
  }
  class FakeFsWatcher extends EventEmitter {
    close = vi.fn();
  }
  return {
    FakeChild,
    FakeFsWatcher,
    children: [] as Array<{ args: string[]; opts: unknown; child: InstanceType<typeof FakeChild> }>,
    fsw: undefined as InstanceType<typeof FakeFsWatcher> | undefined,
    fsCallback: undefined as ((event: string, filename: string | null) => void) | undefined,
    fsWatchOpts: undefined as unknown,
    fsWatchThrows: undefined as Error | undefined,
  };
});
type FakeChild = InstanceType<typeof world.FakeChild>;
type FakeFsWatcher = InstanceType<typeof world.FakeFsWatcher>;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((_cmd: string, args: string[], opts: unknown) => {
      const child = new world.FakeChild();
      world.children.push({ args, opts, child });
      return child;
    }),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: vi.fn((_dir: string, opts: unknown, cb: (event: string, filename: string | null) => void) => {
      if (world.fsWatchThrows) throw world.fsWatchThrows;
      world.fsCallback = cb;
      world.fsWatchOpts = opts;
      world.fsw = new world.FakeFsWatcher();
      return world.fsw;
    }),
  };
});

import { startWatch, parseDebounceMs, DEFAULT_DEBOUNCE_MS, type Watcher } from "../src/cli/watch.js";

let dir: string;
let lines: string[];
let errors: string[];
let started: Watcher[];

beforeEach(() => {
  vi.useFakeTimers();
  world.children.length = 0;
  world.fsw = undefined;
  world.fsCallback = undefined;
  world.fsWatchThrows = undefined;
  dir = mkdtempSync(join(tmpdir(), "egr-watch-unit-"));
  lines = [];
  errors = [];
  started = [];
});

afterEach(() => {
  for (const w of started) w.stop();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const LOCK_ERR = "Error: IO exception: Could not set lock on file /x/graph.db";

/** Start a watcher with the log sinks captured. */
function start(extra: Partial<Parameters<typeof startWatch>[0]> = {}): Watcher {
  const w = startWatch({ dir, debounceMs: 100, log: (l) => lines.push(l), logError: (l) => errors.push(l), ...extra });
  started.push(w);
  return w;
}

const spawned = (): number => world.children.length;
const lastChild = (): FakeChild => world.children[world.children.length - 1]!.child;
const fsEvent = (filename: string | null): void => world.fsCallback!("change", filename);
const flush = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

/** End the index run in flight the way the real `egr index` child would. */
async function endRun(code: number, stdout = "", stderr = ""): Promise<void> {
  const c = lastChild();
  if (stdout) c.stdout.emit("data", Buffer.from(stdout));
  if (stderr) c.stderr.emit("data", Buffer.from(stderr));
  c.emit("close", code);
  await flush();
}

/** Start, let the catch-up index succeed, so the watcher is idle and `[watch] ready` has been logged. */
async function startReady(extra: Partial<Parameters<typeof startWatch>[0]> = {}): Promise<Watcher> {
  const w = start(extra);
  await endRun(0, "incremental: 0 changed\n");
  expect(lines).toContain("[watch] ready");
  return w;
}

describe("argument rules", () => {
  it("--debounce absent gives the default; a whole number of up to six digits is taken as milliseconds", () => {
    expect(parseDebounceMs(undefined)).toBe(DEFAULT_DEBOUNCE_MS);
    expect(parseDebounceMs("0")).toBe(0);
    expect(parseDebounceMs("250")).toBe(250);
    expect(parseDebounceMs("999999")).toBe(999_999);
  });

  it.each(["", "abc", "1.5", "-5", "1e3", "12 ", "1000000"])("--debounce %j is refused, with the value in the message", (bad) => {
    expect(() => parseDebounceMs(bad)).toThrow(`--debounce must be a whole number of milliseconds (got "${bad}")`);
  });

  it("a directory that does not exist, and one that is a file, are errors, not a watcher that never fires", () => {
    expect(() => startWatch({ dir: join(dir, "nope"), debounceMs: 100 })).toThrow(/nope is not a directory/);
    const f = join(dir, "a-file");
    writeFileSync(f, "x");
    expect(() => startWatch({ dir: f, debounceMs: 100 })).toThrow(/a-file is not a directory/);
    expect(spawned()).toBe(0);
  });

  it("a malformed --exclude fails at start with --exclude's own message, before anything is watched or run", () => {
    expect(() => startWatch({ dir, debounceMs: 100, exclude: ["{unclosed"] })).toThrow(/unclosed "\{"/);
    expect(spawned()).toBe(0);
    expect(world.fsw).toBeUndefined();
  });

  it("a platform that cannot watch the directory is reported with the directory and the reason", () => {
    world.fsWatchThrows = new Error("ENOSPC: no watchers left");
    expect(() => startWatch({ dir, debounceMs: 100 })).toThrow(`cannot watch ${dir}: ENOSPC: no watchers left`);
  });
});

describe("the graph's own files", () => {
  it("a change to the graph file or the files written beside it starts no run, even when the graph lies inside the watched directory", async () => {
    const db = join(dir, "graphfile"); // no extension: it would count as a source file otherwise
    await startReady({ dbPath: db });
    for (const f of ["graphfile", "graphfile.wal", "graphfile.parse-manifest.json", "graphfile.incremental-state.json"]) fsEvent(f);
    await flush(30_000);
    expect(spawned()).toBe(1); // the catch-up only
    fsEvent("other-script"); // a file with no extension that is not the graph still starts one
    await flush(200);
    expect(spawned()).toBe(2);
  });
});

describe("start-up: the catch-up index", () => {
  it("watches recursively and runs `egr index <dir> --incremental` with every option passed on, then says ready", async () => {
    start({ docs: true, exclude: ["a/**", "b"], graph: "g.db", isolation: "strict" });
    expect(world.fsWatchOpts).toEqual({ recursive: true });
    expect(lines[0]).toContain(`[watch] watching ${dir} (debounce 100 ms)`);
    expect(spawned()).toBe(1);
    const { args, opts } = world.children[0]!;
    const i = args.indexOf("index");
    expect(args.slice(i)).toEqual(["index", dir, "--incremental", "--docs", "--exclude", "a/**", "--exclude", "b", "--graph", "g.db", "--isolation", "strict"]);
    // `detached`: its own process group, so a terminal's Ctrl-C does not reach the run (the entry-level proof is in egr-watch.test.ts).
    expect(opts).toMatchObject({ stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
    expect(lines).not.toContain("[watch] ready"); // not until the catch-up index is done

    await endRun(0, "indexed 3 files\nincremental: 1 changed, 2 unchanged\n");
    expect(lines).toContain("[watch] index done (initial): incremental: 1 changed, 2 unchanged");
    expect(lines.at(-1)).toBe("[watch] ready");
  });

  it("without options passes only the index command; a summary with no `incremental:` line falls back to the first line that has text", async () => {
    start();
    const args = world.children[0]!.args;
    expect(args.slice(args.indexOf("index"))).toEqual(["index", dir, "--incremental"]);
    await endRun(0, "\n  \nsomething else\nmore\n");
    expect(lines).toContain("[watch] index done (initial): something else");
  });

  it("a catch-up index that fails stops the watcher with exit 1 and releases the directory: it does not watch on a graph it could not bring up to date", async () => {
    const w = start();
    const fsw = world.fsw as FakeFsWatcher;
    await endRun(2, "", "boom 1\nboom 2\nboom 3\nboom 4\n");
    expect(await w.done).toBe(1);
    expect(fsw.close).toHaveBeenCalled();
    expect(errors).toEqual(["[watch] the initial index failed, not watching: boom 2 | boom 3 | boom 4"]);
    expect(lines).not.toContain("[watch] ready");
  });

  it("a child that cannot be started at all is a failed run carrying the reason", async () => {
    const w = start();
    lastChild().emit("error", new Error("spawn ENOENT"));
    await flush();
    expect(await w.done).toBe(1);
    expect(errors[0]).toContain("spawn ENOENT");
  });

  it("a change made while the catch-up runs is not lost: it is indexed once the catch-up is done", async () => {
    start();
    fsEvent("a.ts"); // during the catch-up
    await flush(1_000);
    expect(spawned()).toBe(1); // nothing yet: the catch-up is still the one run
    await endRun(0, "incremental: ok\n");
    await flush(100);
    expect(spawned()).toBe(2);
    expect(lastChild()).not.toBe(world.children[0]!.child);
  });
});

describe("the debounce", () => {
  it("many changes in a burst start one index run, after the quiet time, not one per change", async () => {
    await startReady({ debounceMs: 200 });
    fsEvent("a.ts");
    await flush(100);
    fsEvent("b.ts");
    await flush(100);
    fsEvent("a.ts");
    await flush(199);
    expect(spawned()).toBe(1); // still only the catch-up: the quiet time has not passed since the last change
    await flush(1);
    expect(spawned()).toBe(2);
    await endRun(0, "incremental: 2 changed\n");
    expect(lines.at(-1)).toBe("[watch] index done (2 changed paths): incremental: 2 changed");
  });

  it("one changed path is named in the log; the same path twice is still one, with its backslashes made slashes", async () => {
    await startReady();
    fsEvent("src\\a.ts");
    fsEvent("src/a.ts");
    await flush(100);
    await endRun(0, "incremental: 1 changed\n");
    expect(lines.at(-1)).toBe("[watch] index done (src/a.ts): incremental: 1 changed");
  });

  it("a stream of saves that never goes quiet still gets indexed, after at most max(5 s, 4 x debounce)", async () => {
    await startReady({ debounceMs: 1_000 });
    for (let t = 0; t < 4_800; t += 800) {
      fsEvent(`f${t}.ts`);
      await flush(800);
    }
    expect(spawned()).toBe(1); // t = 4 800: every change so far pushed the run back
    fsEvent("last.ts");
    await flush(199);
    expect(spawned()).toBe(1);
    await flush(1); // t = 5 000: the cap
    expect(spawned()).toBe(2);
  });

  it("with a long debounce the cap is four times it, not 5 s", async () => {
    await startReady({ debounceMs: 4_000 }); // cap = 16 s
    fsEvent("a.ts");
    await flush(3_000);
    fsEvent("b.ts");
    await flush(3_000);
    fsEvent("c.ts");
    await flush(3_000);
    fsEvent("d.ts");
    await flush(3_000);
    expect(spawned()).toBe(1); // t = 12 s, each change pushed the run back
    fsEvent("e.ts");
    await flush(3_999);
    expect(spawned()).toBe(1); // t = 15.999 s
    await flush(1);
    expect(spawned()).toBe(2); // t = 16 s
  });

  it("changes that arrive while a run is in flight wait for it, then get their own run: two runs never overlap", async () => {
    await startReady();
    fsEvent("a.ts");
    await flush(100);
    expect(spawned()).toBe(2);
    fsEvent("b.ts"); // while the second run is in flight
    await flush(5_000);
    expect(spawned()).toBe(2); // not started beside the one in flight
    await endRun(0, "incremental: a\n");
    expect(lines.at(-1)).toBe("[watch] index done (a.ts): incremental: a");
    await flush(100);
    expect(spawned()).toBe(3);
    await endRun(0, "incremental: b\n");
    expect(lines.at(-1)).toBe("[watch] index done (b.ts): incremental: b");
  });
});

describe("which events start a run", () => {
  it("source files do; dependency, build, graph and non-source paths do not; nor does an event that names no file", async () => {
    await startReady();
    for (const noise of ["node_modules/x/index.js", ".engram/graph.db", ".git/HEAD", "dist/out.js", "notes.txt", "graph.db.wal", null, ""]) fsEvent(noise);
    await flush(10_000);
    expect(spawned()).toBe(1); // only the catch-up
    fsEvent("src/real.ts");
    await flush(100);
    expect(spawned()).toBe(2);
  });

  it("--exclude and --docs reach the filter: an excluded path and (without --docs) a document start nothing; with --docs the document does", async () => {
    await startReady({ exclude: ["generated/**"] });
    fsEvent("generated/a.ts");
    fsEvent("README.md");
    await flush(10_000);
    expect(spawned()).toBe(1);
    stopAll();

    world.children.length = 0;
    await startReady({ docs: true });
    fsEvent("README.md");
    await flush(100);
    expect(spawned()).toBe(2); // the catch-up of this watcher, and the run for README.md
  });
});

function stopAll(): void {
  for (const w of started.splice(0)) w.stop();
}

describe("the lock: another process holds the graph", () => {
  it("is answered with a back-off that doubles from 0.5 s and stops at 15 s, never with an exit; then the run goes through", async () => {
    start();
    const waits = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000];
    for (let i = 0; i < waits.length; i += 1) {
      await endRun(1, "", LOCK_ERR);
      expect(lines.at(-1)).toBe(`[watch] graph is locked by another writer; retry ${i + 1} in ${waits[i]} ms (initial)`);
      expect(spawned()).toBe(i + 1); // nothing is spawned before the wait is over
      await flush(waits[i]! - 1);
      expect(spawned()).toBe(i + 1);
      await flush(1);
      expect(spawned()).toBe(i + 2);
    }
    expect(errors).toEqual([]); // a refusal is never an error
    await endRun(0, "incremental: caught up\n");
    expect(lines).toContain("[watch] index done (initial): incremental: caught up");
    expect(lines.at(-1)).toBe("[watch] ready");
  });

  it("holds for a change too, naming the path, and the change is indexed once the lock is gone", async () => {
    await startReady();
    fsEvent("a.ts");
    await flush(100);
    await endRun(1, "", LOCK_ERR);
    expect(lines.at(-1)).toBe("[watch] graph is locked by another writer; retry 1 in 500 ms (a.ts)");
    await flush(500);
    await endRun(0, "incremental: 1 changed\n");
    expect(lines.at(-1)).toBe("[watch] index done (a.ts): incremental: 1 changed");
    expect(errors).toEqual([]);
  });

  it("the Windows spelling of the refusal counts as the same lock", async () => {
    await startReady();
    fsEvent("a.ts");
    await flush(100);
    await endRun(1, "", "The process cannot access the file because it is being used by another process.");
    expect(lines.at(-1)).toContain("graph is locked by another writer");
  });

  it("a failed run whose message is not the lock is an error that is logged, and watching goes on", async () => {
    await startReady();
    fsEvent("a.ts");
    await flush(100);
    await endRun(1, "", "Error: parse exploded\nat x\nat y\nat z");
    expect(errors).toEqual(["[watch] index failed (a.ts); watching on: at x | at y | at z"]);
    expect(lines.some((l) => l.includes("locked"))).toBe(false);
    fsEvent("b.ts"); // the next change tries again
    await flush(100);
    expect(spawned()).toBe(3);
  });

  it("a lock message with a zero exit is not a refusal: the run succeeded", async () => {
    await startReady();
    fsEvent("a.ts");
    await flush(100);
    await endRun(0, "incremental: ok\n", LOCK_ERR);
    expect(lines.at(-1)).toBe("[watch] index done (a.ts): incremental: ok");
  });
});

describe("stopping", () => {
  it("while idle it ends at once with exit 0 and closes the file watcher", async () => {
    const w = await startReady();
    w.stop();
    expect(await w.done).toBe(0);
    expect(world.fsw!.close).toHaveBeenCalled();
  });

  it("changes after stop are ignored, even ones already waiting out their debounce", async () => {
    const w = await startReady();
    fsEvent("a.ts");
    w.stop();
    await flush(10_000);
    expect(spawned()).toBe(1);
    expect(await w.done).toBe(0);
  });

  it("while a run is in flight it says so and lets that run finish first; it does not start another", async () => {
    const w = await startReady();
    fsEvent("a.ts");
    await flush(100);
    fsEvent("b.ts"); // waiting behind the run
    w.stop();
    expect(lines.at(-1)).toBe("[watch] stopping: letting the index run in progress finish (stop again to kill it)");
    let finished = false;
    void w.done.then(() => (finished = true));
    await flush(1_000);
    expect(finished).toBe(false);
    await endRun(0, "incremental: a\n");
    expect(await w.done).toBe(0);
    expect(lines.at(-1)).toBe("[watch] index done (a.ts): incremental: a");
    expect(spawned()).toBe(2);
  });

  it("a second stop kills the run in flight and ends with exit 1", async () => {
    const w = await startReady();
    fsEvent("a.ts");
    await flush(100);
    const child = lastChild();
    w.stop();
    w.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(await w.done).toBe(1);
  });

  it("a stop during a lock back-off ends the wait at once; the run is not tried again", async () => {
    const w = await startReady();
    fsEvent("a.ts");
    await flush(100);
    await endRun(1, "", LOCK_ERR); // now asleep for 500 ms
    w.stop();
    await flush(0);
    expect(spawned()).toBe(2);
    expect(await w.done).toBe(0);
    await flush(60_000);
    expect(spawned()).toBe(2);
  });

  it("a stop before the catch-up has finished ends once it has", async () => {
    const w = start();
    w.stop();
    await endRun(0, "incremental: ok\n");
    expect(await w.done).toBe(0);
    expect(spawned()).toBe(1);
  });

  it("an error from the file watcher is logged and does not stop it", async () => {
    await startReady();
    world.fsw!.emit("error", new Error("EMFILE"));
    expect(errors).toEqual(["[watch] the file watcher reported an error: EMFILE"]);
    fsEvent("a.ts");
    await flush(100);
    expect(spawned()).toBe(2);
  });
});
