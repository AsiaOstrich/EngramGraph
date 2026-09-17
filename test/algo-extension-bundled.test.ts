/**
 * XSPEC-416 — the ALGO extension ships as per-platform packages and loads offline.
 *
 * Consumer feedback on 0.11.0 (Windows 11, corporate intranet): `god-nodes`,
 * `communities` and `related` failed because INSTALL ALGO downloads from
 * extension.ryugraph.io. Measured 2026-09-16/17 before any of this was written:
 *   - the extension loads from an arbitrary path with `LOAD EXTENSION`, no INSTALL,
 *     no network, nothing written to the home directory (Mac + Windows, control arms);
 *   - on Windows a backslash path is a parser error — only forward slashes load;
 *   - a path containing an apostrophe breaks a single-quoted statement.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";
import {
  ALGO_EXTENSION_VERSION,
  ALGO_PLATFORM_PACKAGES,
  algoLoadStatement,
  algoPackageFor,
  resolveBundledAlgo,
  setBundledAlgoResolver,
} from "../src/structural-memory/algo-extension.js";
import { godNodes, resetAlgoStateForTests } from "../src/structural-memory/query.js";

const ROOT = join(__dirname, "..");

describe("algoPackageFor", () => {
  it("maps each ryugraph prebuilt platform to its package", () => {
    expect(algoPackageFor("win32", "x64")).toBe("@asiaostrich/engramgraph-algo-win32-x64");
    expect(algoPackageFor("linux", "x64")).toBe("@asiaostrich/engramgraph-algo-linux-x64");
    expect(algoPackageFor("darwin", "arm64")).toBe("@asiaostrich/engramgraph-algo-darwin-arm64");
    expect(algoPackageFor("darwin", "x64")).toBe("@asiaostrich/engramgraph-algo-darwin-x64");
  });

  it("returns null for a platform nothing is built for", () => {
    expect(algoPackageFor("win32", "arm64")).toBeNull();
    expect(algoPackageFor("linux", "arm64")).toBeNull();
    expect(algoPackageFor("freebsd", "x64")).toBeNull();
  });
});

describe("linux-arm64 stays out only while ryugraph's arm64 engine is really x86-64", () => {
  it("the two prebuilt engine files are still identical — when this fails, add linux-arm64 back", () => {
    const arm = readFileSync(join(ROOT, "node_modules/ryugraph/prebuilt/ryujs-linux-arm64.node"));
    const x64 = readFileSync(join(ROOT, "node_modules/ryugraph/prebuilt/ryujs-linux-x64.node"));
    expect(
      arm.equals(x64),
      "ryugraph now ships a distinct linux-arm64 engine: add linux-arm64 to ALGO_PLATFORM_PACKAGES and the algo-packages.yml matrix (XSPEC-416)",
    ).toBe(true);
  });
});

describe("R4 — the extension version is pinned to the engine", () => {
  it("ALGO_EXTENSION_VERSION matches RYU_EXTENSION_VERSION in the ryugraph source", () => {
    const cmake = readFileSync(join(ROOT, "node_modules/ryugraph/ryu-source/CMakeLists.txt"), "utf8");
    const m = /RYU_EXTENSION_VERSION="([^"]+)"/.exec(cmake);
    expect(m, "RYU_EXTENSION_VERSION not found in ryugraph's CMakeLists.txt").toBeTruthy();
    expect(
      ALGO_EXTENSION_VERSION,
      "ryugraph's extension version changed: rebuild the platform packages (XSPEC-416 R2) before releasing",
    ).toBe(m?.[1]);
  });

  it("optionalDependencies pin either none or every platform package, at that version", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      optionalDependencies?: Record<string, string>;
    };
    const pinned = Object.entries(pkg.optionalDependencies ?? {}).filter(([n]) =>
      n.startsWith("@asiaostrich/engramgraph-algo-"),
    );
    if (pinned.length === 0) return; // before the first publish (XSPEC-416 R6)
    expect(pinned.map(([n]) => n).sort()).toEqual(Object.values(ALGO_PLATFORM_PACKAGES).sort());
    for (const [name, version] of pinned) {
      expect(version, name).toBe(ALGO_EXTENSION_VERSION);
    }
  });
});

describe("resolveBundledAlgo", () => {
  it("returns a forward-slash path when the package resolves (Windows backslashes are a parser error)", () => {
    const r = resolveBundledAlgo({
      platform: "win32",
      arch: "x64",
      resolve: () => "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@asiaostrich\\engramgraph-algo-win32-x64\\package.json",
      exists: () => true,
    });
    expect(r.pkg).toBe("@asiaostrich/engramgraph-algo-win32-x64");
    expect(r.path).toBe(
      "C:/Users/me/AppData/Roaming/npm/node_modules/@asiaostrich/engramgraph-algo-win32-x64/libalgo.ryu_extension",
    );
  });

  it("names the package it looked for when it is not installed", () => {
    const r = resolveBundledAlgo({
      platform: "linux",
      arch: "x64",
      resolve: () => {
        throw new Error("Cannot find module");
      },
      exists: () => true,
    });
    expect(r.pkg).toBe("@asiaostrich/engramgraph-algo-linux-x64");
    expect(r.path).toBeNull();
  });

  it("does not claim a package whose file is missing", () => {
    const r = resolveBundledAlgo({
      platform: "linux",
      arch: "x64",
      resolve: () => "/n/@asiaostrich/engramgraph-algo-linux-x64/package.json",
      exists: () => false,
    });
    expect(r.path).toBeNull();
  });
});

describe("algoLoadStatement", () => {
  it("survives an apostrophe in the path (a Windows user name can have one)", () => {
    expect(algoLoadStatement("C:/Users/o'brien/x/libalgo.ryu_extension")).toBe(
      'LOAD EXTENSION "C:/Users/o\'brien/x/libalgo.ryu_extension";',
    );
  });
});

describe("ensureAlgoExtension with a bundled package (real ryugraph)", () => {
  let dir: string;
  let conn: GraphConnection;
  const statements: string[] = [];
  let cached: string | undefined;

  beforeAll(async () => {
    // The file CI builds into ryugraph's cache (ci.yml), or a developer's own copy.
    const base = join(homedir(), ".ryu", "extension", ALGO_EXTENSION_VERSION);
    if (existsSync(base)) {
      for (const platform of readdirSync(base)) {
        const f = join(base, platform, "algo", "libalgo.ryu_extension");
        if (existsSync(f)) cached = f;
      }
    }
    dir = mkdtempSync(join(tmpdir(), "engram-test-algo-bundled-"));
    conn = GraphConnection.open(join(dir, "graph.db"));
    await initSchema(conn);
    await conn.execute(`CREATE (:Function {id: 'f.core', name: 'core', file: 'a.ts', start_line: 1, confidence: 1.0})`);
    await conn.execute(`CREATE (:Function {id: 'f.a', name: 'a', file: 'a.ts', start_line: 1, confidence: 1.0})`);
    await conn.execute(`MATCH (a:Function {id: 'f.a'}), (b:Function {id: 'f.core'}) CREATE (a)-[:CALLS {call_count: 1}]->(b)`);
    const original = conn.execute.bind(conn);
    conn.execute = async (cypher, params) => {
      statements.push(cypher);
      return original(cypher, params);
    };
  });

  afterEach(() => {
    setBundledAlgoResolver(null);
    resetAlgoStateForTests();
  });

  afterAll(async () => {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads from the package directory and never runs INSTALL", async () => {
    if (!cached) {
      if (process.env.CI) throw new Error(`no ALGO extension in ~/.ryu/extension/${ALGO_EXTENSION_VERSION} — ci.yml should have built one`);
      return; // local machine without a built extension: nothing real to load
    }
    // A package directory whose path has an apostrophe, like a real user's home might.
    const pkgDir = join(dir, "node_modules", "@asiaostrich", "o'brien-algo");
    mkdirSync(pkgDir, { recursive: true });
    copyFileSync(cached, join(pkgDir, "libalgo.ryu_extension"));
    setBundledAlgoResolver(() => ({ pkg: "@asiaostrich/engramgraph-algo-test", path: join(pkgDir, "libalgo.ryu_extension").replace(/\\/g, "/") }));
    statements.length = 0;

    const ranked = await godNodes(conn, 5);

    expect(ranked[0]?.id).toBe("f.core");
    expect(statements.some((s) => /INSTALL\s+ALGO/i.test(s)), `INSTALL ran: ${statements.join(" | ")}`).toBe(false);
    expect(statements.some((s) => s.startsWith("LOAD EXTENSION \"") && s.includes("o'brien-algo"))).toBe(true);
  });

  it("a graph still opens after the package that loaded ALGO is gone", async () => {
    if (!cached) {
      if (process.env.CI) throw new Error(`no ALGO extension in ~/.ryu/extension/${ALGO_EXTENSION_VERSION} — ci.yml should have built one`);
      return;
    }
    const pkgDir = join(dir, "node_modules", "@asiaostrich", "moved-algo");
    mkdirSync(pkgDir, { recursive: true });
    const extFile = join(pkgDir, "libalgo.ryu_extension");
    copyFileSync(cached, extFile);
    setBundledAlgoResolver(() => ({ pkg: "@asiaostrich/engramgraph-algo-test", path: extFile.replace(/\\/g, "/") }));

    await godNodes(conn, 5);

    // Copy the files while the connection is still open: that is what egr leaves
    // on disk when it exits. Closing first would checkpoint and hide the defect.
    const snap = join(dir, "snapshot");
    mkdirSync(snap);
    for (const f of readdirSync(dir).filter((n) => n.startsWith("graph.db"))) copyFileSync(join(dir, f), join(snap, f));
    // Remove every package this connection loaded from, not just this one: a
    // second LOAD of an already-loaded library writes no new record, so the WAL
    // may still name the previous test's directory.
    rmSync(join(dir, "node_modules"), { recursive: true, force: true });

    // Reopen in a fresh process. In this one the library is still loaded, so a
    // replayed load finds it in memory and the missing file never matters.
    const ryugraph = pathToFileURL(join(ROOT, "node_modules/ryugraph/index.mjs")).href;
    const script =
      `import ryu from ${JSON.stringify(ryugraph)};` +
      `const c = new ryu.Connection(new ryu.Database(${JSON.stringify(join(snap, "graph.db"))}));` +
      `const r = await c.query("MATCH (f:Function) RETURN count(f) AS n");` +
      `console.log(JSON.stringify(await r.getAll()));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    expect(child.status, `reopen failed:\n${child.stderr}`).toBe(0);
    expect(JSON.parse(child.stdout.trim())[0]?.n).toBe(2);
  });
});

describe("ensureAlgoExtension without a bundled package", () => {
  afterEach(() => {
    setBundledAlgoResolver(null);
    resetAlgoStateForTests();
  });

  it("an INSTALL failure names the platform package that was missing, first", async () => {
    setBundledAlgoResolver(() => ({ pkg: "@asiaostrich/engramgraph-algo-win32-x64", path: null }));
    const fake = {
      execute: async (cypher: string) => {
        if (/INSTALL\s+ALGO/i.test(cypher)) {
          throw new Error("IO exception: Failed to download extension: algo (ERROR: Could not establish connection)");
        }
      },
      query: async () => [],
    } as unknown as GraphConnection;

    const err = await godNodes(fake, 5).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).toBeInstanceOf(Error);
    const firstLine = (err?.message ?? "").split("\n")[0] ?? "";
    expect(firstLine).toContain("@asiaostrich/engramgraph-algo-win32-x64");
    expect(err?.message).toMatch(/mirror/i);
  });

  it("a platform nothing is built for says so instead of naming a package", async () => {
    setBundledAlgoResolver(() => ({ pkg: null, path: null }));
    const fake = {
      execute: async (cypher: string) => {
        if (/INSTALL\s+ALGO/i.test(cypher)) throw new Error("IO exception: Failed to download extension: algo");
      },
      query: async () => [],
    } as unknown as GraphConnection;

    const err = await godNodes(fake, 5).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err?.message).not.toContain("@asiaostrich/engramgraph-algo-");
    expect(err?.message).toMatch(/no prebuilt/i);
  });

  it("a load by name from ~/.ryu is checkpointed too — its WAL record names the cached file's absolute path", async () => {
    setBundledAlgoResolver(() => ({ pkg: null, path: null }));
    const statements: string[] = [];
    const fake = {
      execute: async (cypher: string) => {
        statements.push(cypher);
      },
      query: async () => [],
    } as unknown as GraphConnection;

    await godNodes(fake, 5);

    const load = statements.findIndex((s) => /^LOAD EXTENSION ALGO/i.test(s));
    expect(load, statements.join(" | ")).toBeGreaterThanOrEqual(0);
    expect(statements[load + 1]).toBe("CHECKPOINT;");
  });
});
