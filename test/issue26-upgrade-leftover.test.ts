import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { findUpgradeLeftovers as findInstalledLeftovers } from "../src/mcp/installed-version.js";
import { buildEgr, REPO_ROOT, type BuiltEgr } from "./helpers/build-cli.js";

/**
 * Issue #26 — on Windows a second global upgrade without restarting `egr-mcp` fails with EBUSY,
 * because npm renames the installed copy to `.engramgraph-<hash>` (the SAME name every time: a hash
 * of the package path) and the first upgrade could not delete it while the running server held
 * `ryugraph\ryujs.node` open. Two places now say so: the package's `preinstall` (install time) and
 * the MCP `doctor` tool's `server` field (any time).
 *
 * Both are driven the way they are used. `preinstall.js` is run as a script, with the working
 * directory npm gives it (`<root>/node_modules/engramgraph`), and its stderr is read. `doctor` is
 * called on the built stdio server, which finds the installed package by walking up from where its
 * own code sits, inside a `<root>/node_modules/engramgraph` tree. The leftover is a real directory
 * named `.engramgraph-TEST` in the real parent; nothing is stubbed.
 *
 * What these do NOT establish: that npm shows `preinstall` output (it hides it by default; see the
 * header of `preinstall.js`), nor Windows behaviour. The timing of the hook relative to npm's
 * rename was measured separately in a scratch `--prefix` (see `findUpgradeLeftovers` in
 * `preinstall.js`).
 */

const PREINSTALL = join(REPO_ROOT, "preinstall.js");
const MARK = "left .engramgraph-TEST";

const roots: string[] = [];
const freshRoot = () => {
  const d = mkdtempSync(join(tmpdir(), "egr-i26-"));
  roots.push(d);
  return d;
};
afterAll(() => {
  for (const d of roots) {
    try {
      chmodSync(join(d, "node_modules"), 0o755);
    } catch {
      // not every root has one
    }
    rmSync(d, { recursive: true, force: true });
  }
});

/** `<root>/node_modules/engramgraph` and the directory npm would have left beside it. */
function layout(opts: { leftover?: "partial" | "retired-copy" | "none" }) {
  const root = freshRoot();
  const nm = join(root, "node_modules");
  const pkg = join(nm, "engramgraph");
  mkdirSync(pkg, { recursive: true });
  const kind = opts.leftover ?? "none";
  if (kind !== "none") {
    const left = join(nm, ".engramgraph-TEST");
    mkdirSync(join(left, "node_modules", "ryugraph"), { recursive: true });
    writeFileSync(join(left, "node_modules", "ryugraph", "ryujs.node"), "x");
    // What npm itself holds during a successful upgrade is the WHOLE previous tree.
    if (kind === "retired-copy") writeFileSync(join(left, "package.json"), JSON.stringify({ name: "engramgraph", version: "0.0.1" }));
  }
  return { root, nm, pkg };
}

/** Run the real hook the way npm does: `node preinstall.js`, cwd = the package directory. */
function runPreinstall(cwd: string) {
  const r = spawnSync(process.execPath, [PREINSTALL], { cwd, encoding: "utf8" });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

describe("issue #26: preinstall says when a previous upgrade left .engramgraph-*", () => {
  it("names the leftover, where it is and what to do, and still exits 0", () => {
    const { nm, pkg } = layout({ leftover: "partial" });
    const r = runPreinstall(pkg);
    expect(r.status, "a warning must never fail the install").toBe(0);
    expect(r.stderr).toContain(MARK);
    expect(r.stderr).toContain(join(nm, ".engramgraph-TEST"));
    expect(r.stderr).toMatch(/close every MCP client/);
    expect(r.stderr).toMatch(/delete /);
    expect(r.stderr).toContain("EBUSY");
    expect(r.stderr).toContain("This install carries on");
  });

  it("says nothing about leftovers, and exits 0, when there is none (control)", () => {
    const { pkg } = layout({ leftover: "none" });
    const r = runPreinstall(pkg);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("left .engramgraph");
    expect(r.stderr).not.toContain("EBUSY");
  });

  it("does not report npm's own copy of the previous version, seen on every ordinary upgrade", () => {
    // During `npm i -g` npm has already renamed the old, whole package to .engramgraph-<hash> when
    // preinstall runs (measured). That is not a leftover: warning about it would warn on every upgrade.
    const { pkg } = layout({ leftover: "retired-copy" });
    const r = runPreinstall(pkg);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("left .engramgraph");
  });

  it("does not look beside anything that is not an installed copy: a checkout or CI directory", () => {
    const root = freshRoot();
    // a checkout whose parent happens to hold such a directory
    mkdirSync(join(root, ".engramgraph-TEST"), { recursive: true });
    const checkout = join(root, "my-checkout");
    mkdirSync(checkout);
    expect(runPreinstall(checkout).stderr).not.toContain(MARK);
    // right name, but not inside a node_modules
    const bare = join(root, "engramgraph");
    mkdirSync(bare);
    const r = runPreinstall(bare);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain(MARK);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "exits 0 and keeps the platform notice when the directory cannot be listed",
    () => {
      const { nm, pkg } = layout({ leftover: "partial" });
      chmodSync(nm, 0o111); // can enter, cannot read
      const r = runPreinstall(pkg);
      chmodSync(nm, 0o755);
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("leftover check skipped");
      expect(r.stderr).not.toContain(MARK);
    },
  );

  it("is reached from the package.json install hook: `preinstall` runs preinstall.js", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string>; files: string[] };
    expect(pkg.scripts.preinstall).toBe("node preinstall.js");
    expect(pkg.files).toContain("preinstall.js");
  });
});

describe("issue #26: doctor says when a previous upgrade left .engramgraph-* beside the package", () => {
  let built: BuiltEgr;
  let nm: string; // <dist-test-XXX>/node_modules
  let pkgRoot: string; // <nm>/engramgraph
  let mcp: string;
  let work: string;

  interface Server {
    runningVersion: string;
    installedVersion: string | null;
    status: "current" | "stale" | "unknown";
    message: string;
    upgradeLeftovers: string[];
  }

  beforeAll(() => {
    built = buildEgr();
    // The bundle, placed where npm puts a package: <x>/node_modules/engramgraph/dist/... . The
    // directory is inside dist-test-* (gitignored), and the external modules are still found by
    // walking up to the repository's node_modules.
    const out = join(REPO_ROOT, built.distRel);
    nm = join(out, "node_modules");
    pkgRoot = join(nm, "engramgraph");
    const entries = readdirSync(out);
    for (const e of entries) cpSync(join(out, e), join(pkgRoot, "dist", e), { recursive: true });
    mcp = join(pkgRoot, "dist", "mcp", "stdio.js");
    work = mkdtempSync(join(tmpdir(), "egr-i26d-"));
  }, 120_000);

  afterAll(() => {
    built?.cleanup();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  const install = (version: string) => writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "engramgraph", version, type: "module" }));
  const leave = () => mkdirSync(join(nm, ".engramgraph-TEST", "node_modules", "ryugraph"), { recursive: true });
  const clear = () => rmSync(join(nm, ".engramgraph-TEST"), { recursive: true, force: true });

  async function withServer<T>(fn: (doctor: () => Promise<Server>) => Promise<T>): Promise<T> {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [mcp],
        env: { ...process.env, ENGRAM_DB: join(work, "g.db") } as Record<string, string>,
        stderr: "ignore",
      }),
    );
    try {
      return await fn(async () => {
        const res = (await client.callTool({ name: "doctor", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
        expect(res.isError).toBeFalsy();
        return (JSON.parse(res.content[0]!.text) as { server: Server }).server;
      });
    } finally {
      await client.close();
    }
  }

  it("lists the leftover and says to restart the clients, delete it and only then upgrade again", async () => {
    install("0.0.0-test"); // the version the server reports is this repository's; see the stale case below
    clear();
    leave();
    try {
      await withServer(async (doctor) => {
        const s = await doctor();
        expect(s.upgradeLeftovers).toEqual([".engramgraph-TEST"]);
        expect(s.message).toContain(".engramgraph-TEST");
        expect(s.message).toContain(join(nm, ".engramgraph-TEST"));
        expect(s.message).toMatch(/Close every MCP client/);
        expect(s.message).toMatch(/delete /);
        expect(s.message).toContain("EBUSY");
        // the version comparison is still there and still correct (installed 0.0.0-test is not what runs)
        expect(s.status).toBe("stale");
        expect(s.message).toContain("version 0.0.0-test is installed");
        expect(s.message).toMatch(/restart the MCP client/);
      });
    } finally {
      clear();
    }
  });

  it("adds the leftover to a 'current' answer too, and drops it when the directory is deleted, with the same server running", async () => {
    // Find out what version this build runs by asking an install that cannot match.
    install("0.0.0-probe");
    const running = await withServer(async (doctor) => (await doctor()).runningVersion);
    install(running);
    clear();
    await withServer(async (doctor) => {
      const before = await doctor();
      expect(before.status).toBe("current");
      expect(before.upgradeLeftovers).toEqual([]);
      leave();
      const during = await doctor();
      expect(during.status).toBe("current");
      expect(during.upgradeLeftovers).toEqual([".engramgraph-TEST"]);
      expect(during.message).toContain(`running version ${running}, the version that is installed.`);
      expect(during.message).toContain(".engramgraph-TEST");
      clear();
      const after = await doctor();
      expect(after.upgradeLeftovers).toEqual([]);
      expect(after.message).toBe(`this MCP server is running version ${running}, the version that is installed.`);
    });
  });

  it("says nothing about leftovers and keeps the old message exactly when there is none (control)", async () => {
    install("0.0.0-test");
    clear();
    await withServer(async (doctor) => {
      const s = await doctor();
      expect(s.upgradeLeftovers).toEqual([]);
      expect(s.status).toBe("stale");
      expect(s.message).not.toContain("engramgraph-");
      expect(s.message).not.toContain("EBUSY");
    });
  });
});

describe("issue #26: where doctor looks", () => {
  it("looks beside <node_modules>/engramgraph only", () => {
    const { pkg } = layout({ leftover: "partial" });
    expect(findInstalledLeftovers(pkg)).toEqual([".engramgraph-TEST"]);
  });

  it("reports nothing for a checkout or a package that does not sit in a node_modules", () => {
    const root = freshRoot();
    mkdirSync(join(root, ".engramgraph-TEST"));
    mkdirSync(join(root, "engramgraph"));
    expect(findInstalledLeftovers(join(root, "engramgraph"))).toEqual([]);
    expect(findInstalledLeftovers(join(root, "my-checkout"))).toEqual([]);
  });

  it("reports nothing, and does not throw, when the directory cannot be listed", () => {
    expect(findInstalledLeftovers(join(freshRoot(), "node_modules", "engramgraph"))).toEqual([]);
  });
});
