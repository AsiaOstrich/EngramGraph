import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import { writeFragment } from "../src/graph-db/writer.js";
import { implementedSpecs } from "../src/code-graph/query.js";
import type { GraphFragment } from "../src/graph-db/types.js";

/**
 * `implemented-by` path resolution and module existence (XSPEC-373 B4).
 *
 * `specs: []` meant two unrelated things — "indexed, declares nothing" and
 * "not in the graph at all" — and printed identically. Module ids are
 * repo-relative POSIX paths while users type absolute paths, `./`-prefixed
 * paths, or paths relative to wherever they are standing.
 */
describe("implemented-by path resolution (XSPEC-373 B4)", () => {
  let dir: string;
  let conn: GraphConnection;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "engram-implby-"));
    conn = GraphConnection.open(join(dir, "graph.db"));
    await initSchema(conn);
    await writeFragment(conn, fixture());
  });

  afterEach(async () => {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function fixture(): GraphFragment {
    return {
      nodes: [
        { label: "Module", id: "Services/Auth.cs", properties: { path: "Services/Auth.cs" } },
        { label: "Module", id: "Services/Silent.cs", properties: { path: "Services/Silent.cs" } },
        { label: "Module", id: "legacy/Services/Auth.cs", properties: { path: "legacy/Services/Auth.cs" } },
        { label: "Module", id: "src/oauth.ts", properties: { path: "src/oauth.ts" } },
        { label: "Spec", id: "SPEC-EXTERNAL-AUTH", properties: {} },
      ],
      edges: [
        {
          label: "IMPLEMENTS",
          fromLabel: "Module",
          from: "Services/Auth.cs",
          toLabel: "Spec",
          to: "SPEC-EXTERNAL-AUTH",
        },
      ],
    };
  }

  it("resolves an exact path", async () => {
    const r = await implementedSpecs(conn, "Services/Auth.cs");
    expect(r.moduleFound).toBe(true);
    expect(r.specs.map((s) => s.id)).toEqual(["SPEC-EXTERNAL-AUTH"]);
    expect(r.resolvedFrom).toBeUndefined();
  });

  it("distinguishes 'indexed but declares nothing' from 'not in the graph'", async () => {
    const silent = await implementedSpecs(conn, "Services/Silent.cs");
    const absent = await implementedSpecs(conn, "Services/Nope.cs");

    // Both have no specs — that was the whole ambiguity.
    expect(silent.specs).toEqual([]);
    expect(absent.specs).toEqual([]);
    // And this is what tells them apart.
    expect(silent.moduleFound).toBe(true);
    expect(absent.moduleFound).toBe(false);
  });

  it("strips a `./` prefix", async () => {
    const r = await implementedSpecs(conn, "./Services/Auth.cs");
    expect(r.moduleFound).toBe(true);
    expect(r.module).toBe("Services/Auth.cs");
  });

  it("resolves an absolute path by unique suffix", async () => {
    const r = await implementedSpecs(conn, "/Users/someone/project/src/oauth.ts");
    expect(r.moduleFound).toBe(true);
    expect(r.module).toBe("src/oauth.ts");
    expect(r.resolvedFrom).toBe("/Users/someone/project/src/oauth.ts");
  });

  it("normalises Windows separators", async () => {
    const r = await implementedSpecs(conn, "Services\\Auth.cs");
    expect(r.moduleFound).toBe(true);
    expect(r.module).toBe("Services/Auth.cs");
  });

  it("resolves an absolute path even when a similarly-named module exists deeper", async () => {
    // Long-path direction: only `Services/Auth.cs` is a trailing segment of
    // this, `legacy/Services/Auth.cs` is not.
    const r = await implementedSpecs(conn, "/home/me/project/Services/Auth.cs");
    expect(r.moduleFound).toBe(true);
    expect(r.module).toBe("Services/Auth.cs");
  });

  it("reports ambiguity instead of silently picking one", async () => {
    // Short-path direction: a bare filename that two modules end with.
    const r = await implementedSpecs(conn, "Auth.cs");
    expect(r.moduleFound).toBe(false);
    expect(r.ambiguousMatches).toEqual(["Services/Auth.cs", "legacy/Services/Auth.cs"]);
  });

  it("matches on a path boundary — `auth.ts` is not a suffix of `oauth.ts`", async () => {
    const r = await implementedSpecs(conn, "auth.ts");
    expect(r.moduleFound).toBe(false);
    expect(r.ambiguousMatches).toBeUndefined();
  });
});
