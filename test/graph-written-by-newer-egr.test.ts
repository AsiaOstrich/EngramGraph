import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { compareEgrVersions, graphVersionAfterWrite } from "../src/code-graph/egr-version.js";
import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * dev-platform #309 — the graph remembers which egr wrote it, and an OLDER egr does not quietly empty it.
 *
 * Before: nothing in the database said which egr built it. `egr index --clean` by an older egr over a graph a
 * newer one wrote emptied it and rebuilt it, resetting the SAGE confidence the newer one had kept (a re-index
 * does not bring it back), with no warning. And `--incremental` parsed everything again whenever the egr
 * version differed in EITHER direction, so two versions taking turns on one machine rebuilt every time.
 *
 * The record is `graphEgrVersion` in the graph's parse-health manifest. "A newer egr wrote this graph" is
 * simulated the way it would be found: by writing a version above this egr's into that manifest (and, for
 * the incremental case, into the remembered state). Every case runs the BUILT CLI as a child process and reads
 * the graph back from the database; nothing here calls the implementation directly except the pure
 * version-ordering table at the end.
 */

const NEWER = "99.0.0";
const PKG_VERSION = (JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string }).version;

let built: BuiltEgr;
let scratch: string;

beforeAll(() => {
  built = buildEgr();
  scratch = mkdtempSync(join(tmpdir(), "egr-newer-"));
});

afterAll(() => {
  built?.cleanup();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const SOURCES: Record<string, string> = {
  "a.ts": "export function alpha() { return beta(); }\nexport function beta() { return 1; }\n",
  "b.ts": "export function gamma() { return alpha(); }\n",
};

interface Env {
  dir: string;
  proj: string;
  db: string;
  manifest: string;
  state: string;
}

function egr(env: Env, args: string[]) {
  return runEgr(built.cli, args, { env: { ...process.env, ENGRAM_DB: env.db }, cwd: env.dir });
}

/** A graph indexed with `--incremental` (so there is a remembered state too), plus one SAGE feedback on `alpha`. */
function fresh(name: string): Env {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  const proj = join(dir, "proj");
  mkdirSync(proj, { recursive: true });
  for (const [f, text] of Object.entries(SOURCES)) writeFileSync(join(proj, f), text);
  const db = join(dir, "graph.db");
  const env: Env = { dir, proj, db, manifest: join(dir, "graph.parse-manifest.json"), state: join(dir, "graph.incremental-state.json") };
  const r = egr(env, ["index", proj, "--incremental"]);
  if (r.status !== 0) throw new Error(`fixture index failed: ${r.stderr}`);
  const fb = egr(env, ["feedback", "test_fail", "a.ts#alpha"]);
  if (fb.status !== 0) throw new Error(`fixture feedback failed: ${fb.stderr}`);
  return env;
}

async function snapshot(env: Env): Promise<{ functions: number; alphaConfidence: number | null }> {
  const conn = GraphConnection.open(env.db, { readOnly: true });
  try {
    const n = await conn.query("MATCH (f:Function) RETURN count(f) AS c");
    const a = await conn.query("MATCH (f:Function {id: 'a.ts#alpha'}) RETURN f.confidence AS c");
    return { functions: Number(n[0]?.c ?? 0), alphaConfidence: a.length ? Number(a[0]!.c) : null };
  } finally {
    await conn.close();
  }
}

const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p: string, v: unknown): void => writeFileSync(p, JSON.stringify(v));

/** What a newer egr would have left behind: its version in the manifest's record. */
function markWrittenByNewerEgr(env: Env, version = NEWER): void {
  const m = readJson(env.manifest);
  m.graphEgrVersion = version;
  writeJson(env.manifest, m);
}

const WARNING = /this graph was last written by egr 99\.0\.0, which is newer than this egr/;

describe("the graph records the egr that wrote it", () => {
  it("egr index writes graphEgrVersion = the running egr's version into the manifest", () => {
    const env = fresh("records");
    expect(readJson(env.manifest).graphEgrVersion).toBe(PKG_VERSION);
  });

  it("a graph with no record is never warned about and --clean is allowed (every graph built before this exists)", () => {
    const env = fresh("norecord");
    const m = readJson(env.manifest);
    delete m.graphEgrVersion;
    writeJson(env.manifest, m);
    const q = egr(env, ["callers", "alpha"]);
    expect(q.status).toBe(0);
    expect(q.stderr).not.toMatch(/newer than this egr/);
    const c = egr(env, ["index", env.proj, "--clean"]);
    expect(c.status).toBe(0);
    expect(readJson(env.manifest).graphEgrVersion).toBe(PKG_VERSION);
  });
});

describe("opening a graph a newer egr wrote warns", () => {
  it("a query on it prints the warning on stderr, exits 0 and still answers [graph-newer-warns]", () => {
    const env = fresh("warn");
    markWrittenByNewerEgr(env);
    const q = egr(env, ["callers", "alpha", "--json"]);
    expect(q.status).toBe(0);
    expect(q.stderr).toMatch(WARNING);
    expect(q.stderr).toContain("--allow-downgrade");
    expect(JSON.parse(q.stdout)).toBeInstanceOf(Array); // stdout stays the answer alone, parseable
  });

  it("an equal or older record is silent", () => {
    const env = fresh("silent");
    markWrittenByNewerEgr(env, PKG_VERSION);
    expect(egr(env, ["callers", "alpha"]).stderr).not.toMatch(/newer than this egr/);
    markWrittenByNewerEgr(env, "0.0.1");
    expect(egr(env, ["callers", "alpha"]).stderr).not.toMatch(/newer than this egr/);
  });
});

describe("egr index --clean on a graph a newer egr wrote", () => {
  it("is refused, and the nodes and the SAGE confidence read back unchanged [graph-newer-clean-refused]", async () => {
    const env = fresh("refused");
    const before = await snapshot(env);
    expect(before.functions).toBe(3);
    expect(before.alphaConfidence).not.toBeNull();
    expect(before.alphaConfidence!).toBeLessThan(1); // the feedback is really there

    markWrittenByNewerEgr(env);
    const r = egr(env, ["index", env.proj, "--clean"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--clean refused");
    expect(r.stderr).toContain(`egr ${NEWER}`);
    expect(r.stderr).toContain("--allow-downgrade");

    expect(await snapshot(env)).toEqual(before); // nothing emptied, confidence intact
    expect(readJson(env.manifest).graphEgrVersion).toBe(NEWER); // and the record was not lowered
  });

  it("goes ahead with --allow-downgrade: the graph is rebuilt, the confidence is reset, the record becomes this egr", async () => {
    const env = fresh("allowed");
    const before = await snapshot(env);
    markWrittenByNewerEgr(env);
    const r = egr(env, ["index", env.proj, "--clean", "--allow-downgrade"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/--allow-downgrade: rebuilding a graph egr 99\.0\.0 wrote/);

    const after = await snapshot(env);
    expect(after.functions).toBe(before.functions); // rebuilt from the sources
    expect(after.alphaConfidence).toBe(1); // what the refusal protected: back to the default
    expect(readJson(env.manifest).graphEgrVersion).toBe(PKG_VERSION);
  });

  it("without --clean a plain index still runs (with the warning) and does not lower the record", async () => {
    const env = fresh("plain");
    markWrittenByNewerEgr(env);
    const r = egr(env, ["index", env.proj]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(WARNING);
    // The newest egr that wrote this graph is still the newer one: an older egr's write does not erase that.
    expect(readJson(env.manifest).graphEgrVersion).toBe(NEWER);
  });
});

describe("egr index --incremental when the egr and the remembered state differ in version", () => {
  /** What a newer egr's incremental run left: its version on the graph's record and on the state's fingerprint. */
  function stateFrom(env: Env, version: string): void {
    markWrittenByNewerEgr(env, version);
    const s = readJson(env.state);
    for (const root of Object.values<any>(s.roots)) root.egrVersion = version;
    writeJson(env.state, s);
  }
  const run = (env: Env) => {
    const r = egr(env, ["index", env.proj, "--incremental", "--json"]);
    expect(r.status).toBe(0);
    return { json: JSON.parse(r.stdout) as { incremental: { mode: string; reason?: string; reparsed: number; reused: number; stateWrittenByNewerEgr?: string } }, stderr: r.stderr };
  };

  it("an OLDER egr than the state carries on from it: warns, parses nothing, rebuilds nothing, confidence survives [incremental-older-no-rebuild]", async () => {
    const env = fresh("inc-older");
    const before = await snapshot(env);
    stateFrom(env, NEWER);
    const { json, stderr } = run(env);
    expect(json.incremental.mode).toBe("incremental");
    expect(json.incremental.reparsed).toBe(0);
    expect(json.incremental.reused).toBe(2);
    expect(json.incremental.stateWrittenByNewerEgr).toBe(NEWER);
    expect(stderr).toMatch(WARNING);
    expect(await snapshot(env)).toEqual(before);
    expect(readJson(env.manifest).graphEgrVersion).toBe(NEWER);
  });

  it("a NEWER egr than the state parses everything again, naming the fingerprint", () => {
    const env = fresh("inc-newer");
    stateFrom(env, "0.0.1");
    markWrittenByNewerEgr(env, "0.0.1");
    const { json, stderr } = run(env);
    expect(json.incremental.mode).toBe("full");
    expect(json.incremental.reason).toContain("parser fingerprint differs");
    expect(json.incremental.reparsed).toBe(2);
    expect(stderr).not.toMatch(/newer than this egr/);
  });

  it("an older egr's run leaves a state the newer egr then reads as 'older' and parses in full once", () => {
    const env = fresh("inc-roundtrip");
    stateFrom(env, NEWER);
    expect(run(env).json.incremental.mode).toBe("incremental"); // the older egr, from the newer one's state
    // The state is now stamped with this (older) egr; a newer egr coming back must not trust it.
    expect(readJson(env.state).roots[Object.keys(readJson(env.state).roots)[0]!].egrVersion).toBe(PKG_VERSION);
  });
});

describe("version order (semver precedence, pre-release included)", () => {
  it.each([
    ["0.16.0-beta.2", "0.16.0", -1],
    ["0.16.0", "0.16.0-beta.2", 1],
    ["0.16.0-beta.1", "0.16.0-beta.2", -1],
    ["0.16.0-beta.2", "0.16.0-beta.10", -1], // numeric identifiers compare as numbers, not text
    ["0.16.0-alpha", "0.16.0-beta", -1],
    ["0.16.0-beta", "0.16.0-beta.1", -1], // a longer pre-release outranks its own prefix
    ["0.16.0-rc.1", "0.16.0-beta.9", 1],
    ["0.16.0-1", "0.16.0-alpha", -1], // numeric ranks below alphanumeric
    ["0.17.0", "0.16.9", 1],
    ["1.0.0", "0.99.99", 1],
    ["0.16.0", "0.16.0", 0],
    ["0.16.0+build.5", "0.16.0", 0], // build metadata is ignored
    ["v0.16.0", "0.16.0", 0],
  ] as const)("%s vs %s -> %i", (a, b, want) => {
    expect(compareEgrVersions(a, b)).toBe(want);
  });

  it("an unorderable version gives null, never a guess", () => {
    expect(compareEgrVersions("latest", "0.16.0")).toBeNull();
    expect(compareEgrVersions("0.16", "0.16.0")).toBeNull();
  });

  it("the record is never lowered by a write, only raised or kept", () => {
    expect(graphVersionAfterWrite(undefined, "0.16.0")).toBe("0.16.0"); // no record: this egr
    expect(graphVersionAfterWrite("0.15.0", "0.16.0")).toBe("0.16.0");
    expect(graphVersionAfterWrite("0.17.0", "0.16.0")).toBe("0.17.0"); // an older egr wrote: the newer record stays
    expect(graphVersionAfterWrite("0.16.0", "0.16.0-beta.2")).toBe("0.16.0"); // pre-release is older
    expect(graphVersionAfterWrite("garbage", "0.16.0")).toBe("0.16.0"); // unorderable record: replaced
  });
});
