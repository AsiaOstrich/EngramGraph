// implements XSPEC-508
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MCP_INDEX_ROOT, type ManifestRun, type ParseManifest } from "../src/code-graph/parse-manifest.js";
import { assignIds, defaultRootLabel } from "../src/code-graph/root-ids.js";

/**
 * XSPEC-508 R6 (decision 134乙) — `assignIds` and `defaultRootLabel` called directly.
 *
 * `xspec508-r6-multiroot-ids.test.ts` proves the outcome through the built CLI; this file walks the
 * rule's branches with hand-made manifests, so that each sentence of root-ids.ts's header has a test
 * that fails when it stops being true.
 */

const section = (files: Array<{ path: string; id?: string }>, extra: Partial<ManifestRun> = {}): ManifestRun =>
  ({ indexedAt: "2026-01-01T00:00:00.000Z", files: files.map((f) => ({ language: "typescript", errorNodes: 0, functions: 0, classes: 0, ...f })), ...extra }) as unknown as ManifestRun;

const manifest = (runs: Record<string, ManifestRun>): ParseManifest => ({ egrVersion: "0.0.1", grammarVersions: {}, runs });

let scratch: string;
beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "egr-r6-ids-")));
});
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("defaultRootLabel", () => {
  it("is the last two segments of the root", () => {
    expect(defaultRootLabel("/work/dev-platform/EngramGraph/src")).toBe("EngramGraph/src");
    expect(defaultRootLabel("/work/vibeops")).toBe("work/vibeops");
  });

  it("reads a Windows path as POSIX and ignores a trailing separator", () => {
    expect(defaultRootLabel("C:\\work\\EngramGraph\\src\\")).toBe("EngramGraph/src");
  });

  it("drops '#', which separates a Module id from its Function", () => {
    expect(defaultRootLabel("/w/a#b/c#d")).toBe("a_b/c_d");
  });

  it("is 'root' when the path has no segment at all", () => {
    expect(defaultRootLabel("/")).toBe("root");
    expect(defaultRootLabel("")).toBe("root");
  });

  it("is the one segment when there is only one", () => {
    expect(defaultRootLabel("/solo")).toBe("solo");
  });
});

describe("assignIds (XSPEC-508 R6)", () => {
  it("gives every file its plain path when the graph has no manifest (a first index, or --clean)", () => {
    const r = assignIds({ root: "/w/one", manifest: null, relPaths: ["a.ts", "src/b.ts"] });
    expect([...r.ids]).toEqual([["a.ts", "a.ts"], ["src/b.ts", "src/b.ts"]]);
    expect(r.qualified).toBe(0);
    expect(r.rootLabel).toBeUndefined();
    expect(r.shared).toEqual([]);
  });

  it("keeps plain paths for roots whose paths never meet", () => {
    const m = manifest({ "/w/a": section([{ path: "x.ts" }]) });
    const r = assignIds({ root: "/w/b", manifest: m, relPaths: ["y.ts"] });
    expect(r.ids.get("y.ts")).toBe("y.ts");
    expect(r.qualified).toBe(0);
    expect(r.rootLabel).toBeUndefined();
  });

  it("qualifies a file whose path another root already holds, and only that file", () => {
    const m = manifest({ "/w/alpha/pkg": section([{ path: "src/index.ts" }]) });
    const r = assignIds({ root: "/w/beta/pkg", manifest: m, relPaths: ["src/index.ts", "src/own.ts"] });
    expect(r.ids.get("src/index.ts")).toBe("beta/pkg/src/index.ts");
    expect(r.ids.get("src/own.ts")).toBe("src/own.ts");
    expect(r.qualified).toBe(1);
    expect(r.rootLabel).toBe("beta/pkg");
    expect(r.shared).toEqual([]);
  });

  it("a root that is already in the manifest keeps the ids it was given, even if the other root's path is gone or has arrived since", () => {
    const m = manifest({
      "/w/alpha/pkg": section([{ path: "src/index.ts" }, { path: "src/late.ts" }]),
      "/w/beta/pkg": section([{ path: "src/index.ts", id: "beta/pkg/src/index.ts" }, { path: "src/late.ts" }], { rootLabel: "beta/pkg" }),
    });
    const r = assignIds({ root: "/w/beta/pkg", manifest: m, relPaths: ["src/index.ts", "src/late.ts"] });
    expect(r.ids.get("src/index.ts")).toBe("beta/pkg/src/index.ts"); // recorded
    expect(r.ids.get("src/late.ts")).toBe("src/late.ts"); // alpha gained it later; beta's plain id is not renamed
    // beta's `src/late.ts` and alpha's `src/late.ts` are one node: reported, not silently kept
    expect(r.shared).toEqual([{ id: "src/late.ts", otherRoot: "/w/alpha/pkg" }]);
    expect(r.qualified).toBe(1);
  });

  it("the root indexed first keeps the plain path: the order decides who is qualified", () => {
    const first = assignIds({ root: "/w/alpha/pkg", manifest: null, relPaths: ["src/index.ts"] });
    expect(first.ids.get("src/index.ts")).toBe("src/index.ts");
    const second = assignIds({ root: "/w/beta/pkg", manifest: manifest({ "/w/alpha/pkg": section([{ path: "src/index.ts" }]) }), relPaths: ["src/index.ts"] });
    expect(second.ids.get("src/index.ts")).toBe("beta/pkg/src/index.ts");
  });

  it("reads another root's qualified id as what it holds (not its path), so a path equal to it is not 'taken'", () => {
    const m = manifest({ "/w/alpha/pkg": section([{ path: "src/index.ts", id: "alpha/pkg/src/index.ts" }]) });
    const r = assignIds({ root: "/w/beta/pkg", manifest: m, relPaths: ["src/index.ts"] });
    expect(r.ids.get("src/index.ts")).toBe("src/index.ts"); // alpha holds `alpha/pkg/src/index.ts`, the plain one is free
    expect(r.qualified).toBe(0);
  });

  it("makes the label different from every other root's when the last two segments are the same", () => {
    const m = manifest({
      "/w/one/pkg": section([{ path: "a.ts" }]),
      "/w/x/one/pkg": section([{ path: "other.ts" }], { rootLabel: "one/pkg" }),
    });
    // `/y/one/pkg` would be `one/pkg`, which "/w/x/one/pkg" already uses
    const r = assignIds({ root: "/y/one/pkg", manifest: m, relPaths: ["a.ts"] });
    expect(r.rootLabel).toBe("one/pkg~2");
    expect(r.ids.get("a.ts")).toBe("one/pkg~2/a.ts");
  });

  it("counts up the label until it is free when several roots already took the earlier ones", () => {
    const m = manifest({
      "/p/one/pkg": section([{ path: "a.ts" }]),
      "/q/one/pkg": section([{ path: "a.ts", id: "one/pkg/a.ts" }], { rootLabel: "one/pkg" }),
      "/r/one/pkg": section([{ path: "a.ts", id: "one/pkg~2/a.ts" }], { rootLabel: "one/pkg~2" }),
    });
    const r = assignIds({ root: "/s/one/pkg", manifest: m, relPaths: ["a.ts"] });
    expect(r.rootLabel).toBe("one/pkg~3");
    expect(r.ids.get("a.ts")).toBe("one/pkg~3/a.ts");
  });

  it("keeps a qualified id distinct from a real path that already looks like it, with a counter on the label", () => {
    // beta/pkg has a real file `beta/pkg/src/index.ts`, and `src/index.ts` collides with alpha
    const m = manifest({ "/w/alpha/pkg": section([{ path: "src/index.ts" }]) });
    const r = assignIds({ root: "/w/beta/pkg", manifest: m, relPaths: ["src/index.ts", "beta/pkg/src/index.ts"] });
    expect(r.ids.get("src/index.ts")).toBe("beta/pkg~2/src/index.ts");
    expect(r.ids.get("beta/pkg/src/index.ts")).toBe("beta/pkg/src/index.ts");
    expect(new Set(r.ids.values()).size).toBe(2);
  });

  it("two new colliding files of one root get two distinct qualified ids", () => {
    const m = manifest({ "/w/alpha/pkg": section([{ path: "a.ts" }, { path: "b.ts" }]) });
    const r = assignIds({ root: "/w/beta/pkg", manifest: m, relPaths: ["a.ts", "b.ts"] });
    expect([...r.ids.values()].sort()).toEqual(["beta/pkg/a.ts", "beta/pkg/b.ts"]);
    expect(r.qualified).toBe(2);
  });

  it("the MCP index_code record is not a root: it neither takes an id from a root nor makes one 'shared'", () => {
    const m = manifest({ [MCP_INDEX_ROOT]: section([{ path: "src/index.ts" }]) });
    const r = assignIds({ root: "/w/alpha/pkg", manifest: m, relPaths: ["src/index.ts"] });
    expect(r.ids.get("src/index.ts")).toBe("src/index.ts");
    expect(r.qualified).toBe(0);
    expect(r.shared).toEqual([]);
  });

  it("the MCP record does not push a label either: a second root's label is not made different from it", () => {
    const m = manifest({ [MCP_INDEX_ROOT]: section([{ path: "q.ts" }], { rootLabel: "beta/pkg" }), "/w/alpha/pkg": section([{ path: "a.ts" }]) });
    const r = assignIds({ root: "/w/beta/pkg", manifest: m, relPaths: ["a.ts"] });
    expect(r.rootLabel).toBe("beta/pkg"); // no `~2`
  });

  it("an older egr's graph: two roots whose sections list the same plain id are reported as shared", () => {
    const m = manifest({
      "/w/alpha/pkg": section([{ path: "src/index.ts" }]),
      "/w/beta/pkg": section([{ path: "src/index.ts" }, { path: "src/own.ts" }]),
    });
    const r = assignIds({ root: "/w/beta/pkg", manifest: m, relPaths: ["src/index.ts", "src/own.ts"] });
    expect(r.shared).toEqual([{ id: "src/index.ts", otherRoot: "/w/alpha/pkg" }]);
    expect(r.ids.get("src/index.ts")).toBe("src/index.ts"); // not renamed under an existing graph
  });

  it("a section with no files array (a hand-edited manifest) is read as empty, not a crash", () => {
    const m = manifest({ "/w/alpha/pkg": { indexedAt: "t" } as unknown as ManifestRun });
    expect(() => assignIds({ root: "/w/beta/pkg", manifest: m, relPaths: ["a.ts"] })).not.toThrow();
  });

  describe("the same directory spelled two ways", () => {
    let real: string;
    let link: string;
    beforeAll(() => {
      real = join(scratch, "real", "pkg");
      mkdirSync(real, { recursive: true });
      mkdirSync(join(scratch, "links"), { recursive: true });
      link = join(scratch, "links", "pkg-link");
      symlinkSync(real, link, "dir");
    });

    it("a root reached through a symlink is the same root as its real path: it is not 'another root' for the ids", () => {
      const m = manifest({ [real]: section([{ path: "src/index.ts" }]) });
      const r = assignIds({ root: link, manifest: m, relPaths: ["src/index.ts"] });
      expect(r.ids.get("src/index.ts")).toBe("src/index.ts");
      expect(r.qualified).toBe(0);
      expect(r.shared).toEqual([]);
    });

    it("an id the real path's section recorded (qualified) is the one the symlink's run keeps", () => {
      const m = manifest({
        [join(scratch, "elsewhere", "pkg")]: section([{ path: "src/index.ts" }]),
        [real]: section([{ path: "src/index.ts", id: "real/pkg/src/index.ts" }], { rootLabel: "real/pkg" }),
      });
      const r = assignIds({ root: link, manifest: m, relPaths: ["src/index.ts", "src/new.ts"] });
      expect(r.ids.get("src/index.ts")).toBe("real/pkg/src/index.ts");
      expect(r.ids.get("src/new.ts")).toBe("src/new.ts");
      expect(r.shared).toEqual([]);
    });

    it("a new colliding file under the symlink takes the label the real path's section already stores", () => {
      const m = manifest({
        [join(scratch, "elsewhere", "pkg")]: section([{ path: "src/new.ts" }]),
        [real]: section([{ path: "src/old.ts", id: "real/pkg/src/old.ts" }], { rootLabel: "real/pkg" }),
      });
      const r = assignIds({ root: link, manifest: m, relPaths: ["src/old.ts", "src/new.ts"] });
      expect(r.ids.get("src/new.ts")).toBe("real/pkg/src/new.ts");
      expect(r.rootLabel).toBe("real/pkg");
    });

    it("a path that does not exist (any more) is still compared as written", () => {
      const gone = join(scratch, "gone", "pkg");
      const m = manifest({ [gone]: section([{ path: "src/index.ts" }]) });
      const same = assignIds({ root: gone, manifest: m, relPaths: ["src/index.ts"] });
      expect(same.ids.get("src/index.ts")).toBe("src/index.ts");
      const other = assignIds({ root: join(scratch, "gone2", "pkg"), manifest: m, relPaths: ["src/index.ts"] });
      expect(other.ids.get("src/index.ts")).toBe("gone2/pkg/src/index.ts");
    });
  });
});
