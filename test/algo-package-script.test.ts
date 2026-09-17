/**
 * XSPEC-416 R1 — the package assembler reads the one platform list engramgraph uses.
 * If its parser drifts from algo-extension.ts, the packages it builds would not be the
 * ones engramgraph looks for, and nothing else would notice.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ALGO_EXTENSION_VERSION, ALGO_PLATFORM_PACKAGES } from "../src/structural-memory/algo-extension.js";

const ROOT = join(__dirname, "..");

describe("scripts/algo-package.mjs", () => {
  it("parses exactly the constants algo-extension.ts exports", async () => {
    const mod = (await import(join(ROOT, "scripts/algo-package.mjs"))) as {
      readAlgoConstants: () => { version: string; packages: Record<string, string> };
    };
    const c = mod.readAlgoConstants();
    expect(c.version).toBe(ALGO_EXTENSION_VERSION);
    expect(c.packages).toEqual({ ...ALGO_PLATFORM_PACKAGES });
  });

  it("assembles a package npm will install only on its own platform", () => {
    const work = mkdtempSync(join(tmpdir(), "engram-algo-pkg-"));
    try {
      const fakeExt = join(work, "libalgo.ryu_extension");
      writeFileSync(fakeExt, "not a real extension");
      const out = join(work, "out");
      const r = spawnSync(process.execPath, [join(ROOT, "scripts/algo-package.mjs"), "win32-x64", fakeExt, out, "https://example/run/1"], {
        encoding: "utf8",
      });
      expect(r.status, r.stderr).toBe(0);
      const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8")) as Record<string, unknown>;
      expect(pkg.name).toBe("@asiaostrich/engramgraph-algo-win32-x64");
      expect(pkg.version).toBe(ALGO_EXTENSION_VERSION);
      expect(pkg.os).toEqual(["win32"]);
      expect(pkg.cpu).toEqual(["x64"]);
      expect(readFileSync(join(out, "LICENSE"), "utf8")).toMatch(/MIT License/);
      expect(readFileSync(join(out, "libalgo.ryu_extension"), "utf8")).toBe("not a real extension");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("takes the LICENSE from the ryugraph the extension was built from, when told", () => {
    // In CI ryugraph is installed in a separate directory, not this repo's node_modules.
    const work = mkdtempSync(join(tmpdir(), "engram-algo-pkg-"));
    try {
      const fakeRyu = join(work, "ryu");
      mkdirSync(fakeRyu, { recursive: true });
      writeFileSync(join(fakeRyu, "LICENSE"), "MIT License\nfrom the build's own ryugraph\n");
      writeFileSync(join(work, "x"), "ext");
      const r = spawnSync(process.execPath, [join(ROOT, "scripts/algo-package.mjs"), "linux-x64", join(work, "x"), join(work, "o")], {
        encoding: "utf8",
        env: { ...process.env, ALGO_RYUGRAPH_DIR: fakeRyu },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(join(work, "o", "LICENSE"), "utf8")).toContain("from the build's own ryugraph");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("refuses a platform that is not in the list", () => {
    const work = mkdtempSync(join(tmpdir(), "engram-algo-pkg-"));
    try {
      writeFileSync(join(work, "x"), "");
      const r = spawnSync(process.execPath, [join(ROOT, "scripts/algo-package.mjs"), "win32-arm64", join(work, "x"), join(work, "o")], { encoding: "utf8" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("unknown platform");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
