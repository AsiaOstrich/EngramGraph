// implements XSPEC-457
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import { buildEgr, REPO_ROOT, type BuiltEgr } from "./helpers/build-cli.js";

/**
 * XSPEC-457 R3 — `egr doctor` says whether THIS machine will reach the network,
 * from what is on this machine, not from a fixed list.
 *
 * Reported on Windows 11 with 0.12.0: `~/.ryu/extension/25.9.0/win_amd64` was
 * empty and `god-nodes`, `communities` and `related` all produced results, while
 * `doctor` still said they "need network". 0.12.0 ships the ALGO extension in a
 * per-platform npm package (`@asiaostrich/engramgraph-algo-*`) and loads it by
 * path, so on a normal install nothing is downloaded.
 *
 * Two machines are exercised, both through the built CLI as a child process:
 *   - this one (the platform package is installed), with HOME pointing at an
 *     EMPTY directory so ryugraph's own cache cannot be what makes it work —
 *     `doctor` must say "none" AND the three commands must in fact run;
 *   - a machine without the platform package: the same build, in a directory
 *     whose node_modules has every dependency except `@asiaostrich/*`.
 *     `doctor` must then say the commands need network (empty cache), or say
 *     none (ryugraph's cache holds the extension), and must say "cannot be
 *     determined" on a platform whose cache directory name is not known.
 */

const require_ = createRequire(import.meta.url);
const RYU_PLATFORM_DIR: Record<string, string> = { "win32-x64": "win_amd64", "linux-x64": "linux_amd64", "darwin-arm64": "osx_arm64" };
const PLATFORM_PKG: Record<string, string> = {
  "win32-x64": "@asiaostrich/engramgraph-algo-win32-x64",
  "linux-x64": "@asiaostrich/engramgraph-algo-linux-x64",
  "darwin-arm64": "@asiaostrich/engramgraph-algo-darwin-arm64",
  "darwin-x64": "@asiaostrich/engramgraph-algo-darwin-x64",
};
const KEY = `${process.platform}-${process.arch}`;

interface DoctorJson {
  networkCommands: string[];
  networkStatus: "none" | "needed" | "undetermined";
  algo: { source: string; path: string | null; package: string | null; detail: string };
}

let built: BuiltEgr;
let work: string;
let emptyHome: string;
let projDb: string;

function envWithHome(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home };
}

function doctor(cli: string, home: string): DoctorJson {
  const r = spawnSync(process.execPath, [cli, "doctor", "--json"], { encoding: "utf8", env: envWithHome(home), cwd: work });
  if (r.status !== 0) throw new Error(`doctor exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout) as DoctorJson;
}

/** Is the platform package installed here, found without going through egr's own resolver? */
function packageFileOnDisk(): string | null {
  const pkg = PLATFORM_PKG[KEY];
  if (!pkg) return null;
  try {
    const file = join(dirname(require_.resolve(`${pkg}/package.json`)), "libalgo.ryu_extension");
    return existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-doctor-net-"));
  emptyHome = join(work, "empty-home");
  mkdirSync(emptyHome);
  const proj = join(work, "proj");
  mkdirSync(proj);
  writeFileSync(join(proj, "a.ts"), "export function alpha() { return beta(); }\nexport function beta() { return 1; }\n");
  projDb = join(work, "graph.db");
  const r = spawnSync(process.execPath, [built.cli, "index", proj], { env: { ...process.env, ENGRAM_DB: projDb }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
}, 120_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

describe("XSPEC-457 R3: egr doctor on a machine that has the platform package", () => {
  it("says no command needs network when the platform package is on disk, with an empty ryugraph cache, and the three commands then run", () => {
    const onDisk = packageFileOnDisk();
    if (!onDisk) {
      // A platform with no package (or an install that skipped optional dependencies): nothing to assert here;
      // the arm below covers the machine without the package.
      return;
    }
    const d = doctor(built.cli, emptyHome);
    expect(d.networkCommands).toEqual([]);
    expect(d.networkStatus).toBe("none");
    expect(d.algo.source).toBe("bundled-package");
    expect(d.algo.path).toBe(onDisk.replace(/\\/g, "/"));

    // The claim is only worth anything if it is true: run all three with an empty home.
    for (const argv of [["god-nodes"], ["communities"], ["related", "a.ts#beta"]]) {
      const r = spawnSync(process.execPath, [built.cli, ...argv], {
        encoding: "utf8",
        env: { ...envWithHome(emptyHome), ENGRAM_DB: projDb },
        cwd: work,
      });
      expect(r.status, `egr ${argv.join(" ")}: ${r.stderr}`).toBe(0);
    }
    expect(existsSync(join(emptyHome, ".ryu")), "the extension must have loaded from the package, writing nothing to the home directory").toBe(false);
  });

  it("prints the same answer in the human-readable line", () => {
    if (!packageFileOnDisk()) return;
    const r = spawnSync(process.execPath, [built.cli, "doctor"], { encoding: "utf8", env: envWithHome(emptyHome), cwd: work });
    expect(r.stdout).toMatch(/needs network: none — loaded from the installed package @asiaostrich\/engramgraph-algo-/);
    expect(r.stdout).not.toMatch(/needs network: god-nodes/);
  });
});

describe("XSPEC-457 R3: egr doctor on a machine without the platform package", () => {
  let bare: BuiltEgr | undefined;
  let bareDir: string;

  beforeAll(() => {
    // The same build, run from a directory whose node_modules has every dependency except @asiaostrich/*.
    bareDir = join(work, "bare");
    const nm = join(bareDir, "node_modules");
    mkdirSync(nm, { recursive: true });
    for (const name of readdirSync(join(REPO_ROOT, "node_modules"))) {
      if (name === "@asiaostrich") continue;
      symlinkSync(join(REPO_ROOT, "node_modules", name), join(nm, name), "junction");
    }
    // Copy the built entry (its dependencies resolve from bareDir/node_modules now).
    mkdirSync(join(bareDir, "dist"), { recursive: true });
    execFileSync(process.execPath, ["-e", `require("node:fs").cpSync(${JSON.stringify(dirname(dirname(built.cli)))}, ${JSON.stringify(join(bareDir, "dist"))}, {recursive:true})`]);
    writeFileSync(join(bareDir, "package.json"), JSON.stringify({ name: "bare", type: "module" }));
    bare = { ...built, cli: join(bareDir, "dist", "cli", "index.js") };
  });

  it("says god-nodes, communities and related need network when there is no package and ryugraph's cache is empty", () => {
    if (!RYU_PLATFORM_DIR[KEY]) return; // cache directory name unknown here: covered by the "cannot be determined" arm
    const d = doctor(bare!.cli, emptyHome);
    expect(d.algo.source).toBe("download");
    expect(d.networkStatus).toBe("needed");
    expect(d.networkCommands).toEqual(["god-nodes", "communities", "related"]);
  });

  it("says no command needs network when ryugraph's cache already holds the extension", () => {
    const dirName = RYU_PLATFORM_DIR[KEY];
    if (!dirName) return;
    const home = join(work, "cached-home");
    const dir = join(home, ".ryu", "extension", "25.9.0", dirName, "algo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "libalgo.ryu_extension"), "stand-in; doctor only looks for the file");
    const d = doctor(bare!.cli, home);
    expect(d.algo.source).toBe("user-cache");
    expect(d.networkCommands).toEqual([]);
    expect(d.networkStatus).toBe("none");
  });

  it("reports the status as undetermined, not a guess, where the cache directory name is not known", () => {
    if (RYU_PLATFORM_DIR[KEY]) return; // this platform's name is known; the unit tests in doctor.test.ts cover the unknown-platform arm
    const d = doctor(bare!.cli, emptyHome);
    expect(d.networkStatus).toBe("undetermined");
    expect(d.algo.detail).toMatch(/cannot be determined/);
  });
});
