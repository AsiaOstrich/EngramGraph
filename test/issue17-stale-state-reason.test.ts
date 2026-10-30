// implements XSPEC-508
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * Issue #17 — after upgrading from 0.14.0 the first `egr index . --incremental` indexed in full
 * (correct) but printed "no incremental state yet (the graph was built without --incremental, or
 * the state was lost)" (wrong): the 0.14.0 state file was there, readable, and of version 1; this
 * egr writes version 2. Told that the state was lost, a user who DID use --incremental looks for
 * what they did wrong.
 *
 * Every test runs the built CLI as a child process, the way a user does, and reads the state file
 * back from disk. Each `it` builds its own tree, graph and state, so any one can be run alone.
 */

let built: BuiltEgr;
let scratch: string;

beforeAll(() => {
  built = buildEgr();
  scratch = mkdtempSync(join(tmpdir(), "egr-i17-"));
});

afterAll(() => {
  built?.cleanup();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const TREE = "export function foo() { return 1 }\nexport function bar() { return foo() }\n";

interface Setup {
  dir: string;
  proj: string;
  db: string;
  statePath: string;
}

interface IncJson {
  code: { files: number };
  incremental: { mode: "incremental" | "full"; reason?: string; reparsed: number };
}

function run(s: Setup, args: string[]) {
  return runEgr(built.cli, args, { env: { ...process.env, ENGRAM_DB: s.db }, cwd: s.dir });
}

function indexJson(s: Setup): IncJson {
  const r = run(s, ["index", s.proj, "--incremental", "--json"]);
  if (r.status !== 0) throw new Error(`egr index --incremental exited ${r.status}\n${r.stderr}`);
  return JSON.parse(r.stdout) as IncJson;
}

/** A project indexed once with --incremental, so a real state file (version 2) exists beside the graph. */
function indexedOnce(label: string): Setup {
  const dir = mkdtempSync(join(scratch, `${label}-`));
  const proj = join(dir, "proj");
  mkdirSync(proj);
  writeFileSync(join(proj, "a.ts"), TREE);
  mkdirSync(join(dir, "g"));
  const s: Setup = { dir, proj, db: join(dir, "g", "graph.db"), statePath: join(dir, "g", "graph.incremental-state.json") };
  expect(indexJson(s).incremental.mode).toBe("full");
  expect(JSON.parse(readFileSync(s.statePath, "utf8")).version).toBe(2);
  return s;
}

/** Turn the state file into what another egr would have left: the same content under another `version`. */
function stateAsWrittenBy(s: Setup, version: number): void {
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  writeFileSync(s.statePath, JSON.stringify({ ...state, version }));
}

describe("issue #17: the reason --incremental gives when a state file exists but cannot be used", () => {
  it("a state written by an older egr (version 1) is named as such, not reported as missing; the run indexes in full and writes version 2", () => {
    const s = indexedOnce("older");
    stateAsWrittenBy(s, 1);

    const r = indexJson(s);
    expect(r.incremental.mode).toBe("full");
    expect(r.incremental.reason).toContain("written by an older egr");
    expect(r.incremental.reason).toContain("state version 1, now 2");
    expect(r.incremental.reason).not.toContain("no incremental state yet");
    expect(r.incremental.reason).not.toContain("the state was lost");
    expect(r.incremental.reparsed).toBe(r.code.files); // everything was parsed again

    // read back: the state on disk is version 2 now, and the next run uses it
    expect(JSON.parse(readFileSync(s.statePath, "utf8")).version).toBe(2);
    expect(indexJson(s).incremental).toMatchObject({ mode: "incremental", reparsed: 0 });
  });

  it("the text output (no --json) prints the same reason", () => {
    const s = indexedOnce("older-text");
    stateAsWrittenBy(s, 1);

    const r = run(s, ["index", s.proj, "--incremental"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("incremental: indexed in full — incremental state was written by an older egr (state version 1, now 2)");
    expect(r.stdout).not.toContain("no incremental state yet");
  });

  it("a state written by a NEWER egr (a downgrade) says so, with both versions", () => {
    const s = indexedOnce("newer");
    stateAsWrittenBy(s, 3);

    const r = indexJson(s);
    expect(r.incremental.mode).toBe("full");
    expect(r.incremental.reason).toContain("written by a newer egr");
    expect(r.incremental.reason).toContain("state version 3, now 2");
    expect(r.incremental.reason).not.toContain("no incremental state yet");
    expect(JSON.parse(readFileSync(s.statePath, "utf8")).version).toBe(2);
  });

  it("a damaged state file (not JSON) says it could not be read, not that it is missing", () => {
    const s = indexedOnce("damaged");
    writeFileSync(s.statePath, "{ this is not json");

    const r = indexJson(s);
    expect(r.incremental.mode).toBe("full");
    expect(r.incremental.reason).toContain("could not be read");
    expect(r.incremental.reason).not.toContain("no incremental state yet");
    expect(JSON.parse(readFileSync(s.statePath, "utf8")).version).toBe(2); // repaired
  });

  it("a state file of the right version whose roots are not an object is also 'could not be read'", () => {
    const s = indexedOnce("badroots");
    writeFileSync(s.statePath, JSON.stringify({ version: 2, roots: "nope" }));

    const r = indexJson(s);
    expect(r.incremental.mode).toBe("full");
    expect(r.incremental.reason).toContain("could not be read");
  });

  it("control: with no state file at all the original 'no incremental state yet' reason is still given", () => {
    const s = indexedOnce("absent");
    rmSync(s.statePath);
    expect(existsSync(s.statePath)).toBe(false);

    const r = indexJson(s);
    expect(r.incremental.mode).toBe("full");
    expect(r.incremental.reason).toContain("no incremental state yet");
    expect(r.incremental.reason).not.toContain("older egr");
    expect(r.incremental.reason).not.toContain("could not be read");
    expect(JSON.parse(readFileSync(s.statePath, "utf8")).version).toBe(2);
  });
});
