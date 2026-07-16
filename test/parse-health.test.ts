/**
 * XSPEC-334 R1 — parse-failure observability foundation.
 *
 * Covers: per-file measurement (`measureErrorSpan`), `extractProject`'s
 * per-file fault tolerance + raw health (R1a/R1b), the manifest pure functions
 * (summarize/diff/path/build/round-trip), and the end-to-end `cmdIndex`
 * manifest write + healing diff (R1b/R1d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractProject, parserFor } from "../src/code-graph/extractor.js";
import { measureErrorSpan, type FileParseHealth } from "../src/code-graph/parse-health.js";
import {
  summarize,
  diffRuns,
  manifestPathForDb,
  upsertRun,
  allFiles,
  readManifest,
  writeManifest,
  isHealthy,
} from "../src/code-graph/parse-manifest.js";
import { cmdIndex } from "../src/cli/run.js";
import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";

const CLEAN = "export function ok(){ return 1; }";
// Confirmed against a real parse: valid `ok` still extracts, tail is one ERROR.
const PARTIAL = "export function ok(){ return 1; }\nfunction ( { !!!";
// Confirmed: yields one MISSING node (a `}`), zero extent — a distinct signal.
const MISSING_ONLY = "class Foo {";

const fph = (path: string, over: Partial<FileParseHealth> = {}): FileParseHealth => ({
  path,
  language: "typescript",
  errorNodes: 0,
  errorExtent: 0,
  sourceExtent: 10,
  functions: 1,
  classes: 0,
  ...over,
});

describe("measureErrorSpan (R1b)", () => {
  it("reports zero for a clean parse", () => {
    const tree = parserFor("javascript").parse(CLEAN);
    expect(measureErrorSpan(tree.rootNode)).toEqual({ errorNodes: 0, errorExtent: 0 });
  });

  it("counts a MISSING node without adding extent (it is zero-width)", () => {
    const tree = parserFor("javascript").parse(MISSING_ONLY);
    const m = measureErrorSpan(tree.rootNode);
    expect(m.errorNodes).toBe(1);
    expect(m.errorExtent).toBe(0);
  });

  it("counts an ERROR node and the extent it covers", () => {
    const tree = parserFor("javascript").parse(PARTIAL);
    const m = measureErrorSpan(tree.rootNode);
    expect(m.errorNodes).toBeGreaterThanOrEqual(1);
    expect(m.errorExtent).toBeGreaterThan(0);
  });
});

describe("extractProject fault tolerance + health (R1a/R1b)", () => {
  it("records clean files with zero error nodes", () => {
    const res = extractProject([
      { path: "a.ts", source: CLEAN },
      { path: "b.ts", source: "export function two(){ return 2; }" },
    ]);
    expect(res.parseHealth).toHaveLength(2);
    expect(res.parseHealth.every((f) => f.errorNodes === 0 && f.failed === undefined)).toBe(true);
    expect(res.parseHealth.every((f) => f.functions === 1)).toBe(true);
  });

  it("flags a partial parse but still extracts the valid part", () => {
    const res = extractProject([{ path: "bad.ts", source: PARTIAL }]);
    const h = res.parseHealth[0]!;
    expect(h.errorNodes).toBeGreaterThanOrEqual(1);
    expect(h.failed).toBeUndefined();
    // The valid `ok` function is still in the graph despite the broken tail.
    expect(h.functions).toBeGreaterThanOrEqual(1);
    expect(res.fragment.nodes.some((n) => n.label === "Function" && n.properties?.name === "ok")).toBe(true);
  });

  it("isolates a throwing file and still indexes its siblings (R1a)", () => {
    // A non-string source makes tree-sitter's parse throw (TypeError) — this
    // stands in for ANY file whose extraction throws. Before R1a this aborted
    // the whole batch; now it is caught, recorded as `failed`, and the sibling
    // still indexes.
    const res = extractProject([
      { path: "boom.ts", source: 123 as unknown as string },
      { path: "good.ts", source: CLEAN },
    ]);
    const boom = res.parseHealth.find((f) => f.path === "boom.ts")!;
    const good = res.parseHealth.find((f) => f.path === "good.ts")!;
    expect(boom.failed).toBeTypeOf("string");
    expect(good.failed).toBeUndefined();
    expect(res.fragment.nodes.some((n) => n.label === "Function" && n.properties?.name === "ok")).toBe(true);
  });
});

describe("parse-manifest pure functions (R1b/R1d)", () => {
  it("summarize derives clean/partial/failed counts", () => {
    const files = [
      fph("clean.ts"),
      fph("partial.ts", { errorNodes: 2 }),
      fph("failed.ts", { failed: "boom" }),
      fph("clean2.ts"),
    ];
    expect(summarize(files)).toEqual({ total: 4, clean: 2, partial: 1, failed: 1 });
  });

  it("isHealthy is true only with no throw and no error nodes", () => {
    expect(isHealthy(fph("a.ts"))).toBe(true);
    expect(isHealthy(fph("a.ts", { errorNodes: 1 }))).toBe(false);
    expect(isHealthy(fph("a.ts", { failed: "x" }))).toBe(false);
  });

  it("manifestPathForDb derives the sibling path for default + named graphs", () => {
    expect(manifestPathForDb("/x/.engram/graph.db")).toBe("/x/.engram/graph.parse-manifest.json");
    expect(manifestPathForDb("/x/.engram/foo.db")).toBe("/x/.engram/foo.parse-manifest.json");
  });

  it("upsertRun fingerprints the parser and stores a root's section", () => {
    const m = upsertRun(null, "/root/a", "2026-07-16T00:00:00.000Z", [fph("a.ts")], "9.9.9");
    expect(m.egrVersion).toBe("9.9.9");
    expect(m.grammarVersions["tree-sitter"]).toBeTypeOf("string");
    expect(m.runs["/root/a"]!.indexedAt).toBe("2026-07-16T00:00:00.000Z");
    expect(m.runs["/root/a"]!.files).toHaveLength(1);
  });

  it("upsertRun replaces ONLY its own root's section (multi-dir shared DB)", () => {
    // The must-fix: index-all.sh indexes several dirs into one DB; each run may
    // only replace its own section, never clobber the others.
    let m = upsertRun(null, "/root/a", "t0", [fph("a.ts")], "1.0.0");
    m = upsertRun(m, "/root/b", "t1", [fph("b.ts"), fph("b2.ts")], "1.0.0");
    expect(Object.keys(m.runs).sort()).toEqual(["/root/a", "/root/b"]);

    // Re-index root a with a different file set: a replaced, b untouched.
    m = upsertRun(m, "/root/a", "t2", [fph("a.ts"), fph("a2.ts")], "1.0.0");
    expect(m.runs["/root/a"]!.files.map((f) => f.path)).toEqual(["a.ts", "a2.ts"]);
    expect(m.runs["/root/b"]!.files).toHaveLength(2);
    expect(allFiles(m)).toHaveLength(4);
  });

  it("diffRuns reports healed and regressed transitions only", () => {
    const prev = [fph("healed.ts", { errorNodes: 3 }), fph("regress.ts"), fph("stayfail.ts", { failed: "x" })];
    const next = [
      fph("healed.ts"), // 3 errors -> clean = healed
      fph("regress.ts", { errorNodes: 1 }), // clean -> error = regressed
      fph("stayfail.ts", { failed: "x" }), // still failed = no transition
      fph("brandnew.ts", { errorNodes: 1 }), // absent in prev = not a regression
    ];
    const d = diffRuns(prev, next);
    expect(d.healed).toEqual(["healed.ts"]);
    expect(d.regressed).toEqual(["regress.ts"]);
  });

  it("diffRuns is empty against a null previous section (first index of a root)", () => {
    expect(diffRuns(null, [fph("a.ts", { errorNodes: 1 })])).toEqual({ healed: [], regressed: [] });
  });

  it("write/read round-trips a manifest atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "engram-manifest-"));
    try {
      const path = join(dir, "graph.parse-manifest.json");
      const m = upsertRun(null, "/root/a", "t1", [fph("a.ts", { errorNodes: 1 })], "1.0.0");
      writeManifest(path, m);
      expect(existsSync(path)).toBe(true);
      expect(readManifest(path)).toEqual(m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readManifest returns null for an absent file", () => {
    expect(readManifest(join(tmpdir(), "does-not-exist-xspec334.json"))).toBeNull();
  });
});

describe("cmdIndex manifest write + healing diff (R1b/R1d)", () => {
  let dir: string;
  let src: string;
  let manifestPath: string;
  let conn: GraphConnection;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "engram-ph-cli-"));
    src = join(dir, "repo");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "a.ts"), CLEAN);
    writeFileSync(join(src, "bad.ts"), PARTIAL);
    manifestPath = join(dir, "graph.parse-manifest.json");
    conn = GraphConnection.open(join(dir, "graph.db"));
    await initSchema(conn);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("first index writes the manifest and reports the partial file", async () => {
    const r = await cmdIndex(conn, { dir: src, manifestPath });
    expect(r.parseHealth?.partial).toBeGreaterThanOrEqual(1);
    expect(r.parseHealth?.healed).toEqual([]);
    expect(existsSync(manifestPath)).toBe(true);
    const m = readManifest(manifestPath)!;
    expect(allFiles(m).some((f) => f.path === "bad.ts" && f.errorNodes > 0)).toBe(true);
    expect(m.egrVersion).toBeTypeOf("string");
  });

  it("re-index after a fix reports the file as healed", async () => {
    writeFileSync(join(src, "bad.ts"), "export function fixed(){ return 3; }");
    const r = await cmdIndex(conn, { dir: src, manifestPath });
    expect(r.parseHealth?.healed).toContain("bad.ts");
    expect(r.parseHealth?.partial).toBe(0);
  });

  it("indexing a second dir into the same DB preserves the first dir's section", async () => {
    // Directly exercises the multi-dir-into-one-DB shared-graph shape
    // (dev-platform's index-all.sh): a second `egr index` must add its own
    // section without clobbering the first dir's.
    const src2 = join(dir, "repo2");
    mkdirSync(src2, { recursive: true });
    writeFileSync(join(src2, "c.ts"), CLEAN);
    await cmdIndex(conn, { dir: src2, manifestPath });
    const m = readManifest(manifestPath)!;
    expect(Object.keys(m.runs).length).toBeGreaterThanOrEqual(2);
    expect(allFiles(m).some((f) => f.path === "c.ts")).toBe(true); // new dir indexed
    expect(allFiles(m).some((f) => f.path === "a.ts")).toBe(true); // first dir survived
  });
});
