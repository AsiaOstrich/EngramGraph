import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { cmdDoctor } from "../src/cli/run.js";
import { GRAMMARS } from "../language-support.js";
import { assertDistIsFresh } from "./helpers/dist-freshness.js";

/**
 * `egr doctor` — the channel that actually reaches users.
 *
 * This command exists because the previous design did not reach them. The
 * platform preflight and the MCP registration hint lived in `preinstall` and
 * `postinstall` hooks, and on a real `npm install -g engramgraph` both appeared
 * **zero times** in 242 lines of output: npm suppresses lifecycle-script output
 * by default, and npm ≥ 11 holds those scripts behind an approval gate. Every
 * test of those hooks passed the whole time, because each invoked them the way
 * they were written — with `--foreground-scripts` — rather than the way anyone
 * installs.
 *
 * So the tests below run `egr doctor` **as a user runs it**: the built CLI, no
 * special flags, output read off stdout. A check that only passes under
 * conditions the user does not reproduce is the thing being corrected here,
 * and repeating it would be the same mistake with a different subject.
 */

const ROOT = join(__dirname, "..");
const CLI = join(ROOT, "dist", "cli", "index.js");
// dist/ 比 src/ 舊時,這個檔會啟動上一個版本然後全部通過。
// （這個檔一直是這樣寫的,只是在 2026-09-04 之前沒有人注意到那個性質。）
assertDistIsFresh(ROOT, CLI);

function runDoctor(args: string[] = []): string {
  return execFileSync(process.execPath, [CLI, "doctor", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

describe("cmdDoctor", () => {
  const result = cmdDoctor("/tmp/probe/.engram/graph.db");

  it("reports every language the registry knows about", () => {
    expect(result.languages).toHaveLength(GRAMMARS.length);
    expect(result.available + result.unavailable).toBe(GRAMMARS.length);
  });

  it("carries a reason for anything unavailable, and none for what works", () => {
    // "unavailable" without a reason sends the reader nowhere — the whole
    // point is to answer "why is my C# missing", not to restate that it is.
    for (const lang of result.languages) {
      if (lang.available) {
        expect(lang.reason, `${lang.label} is available but carries a reason`).toBeUndefined();
      } else {
        expect(lang.reason, `${lang.label} is unavailable with no reason`).toBeTruthy();
      }
    }
  });

  it("marks which languages this platform had to compile", () => {
    // On any platform but linux-x64 that is Dart, and it is the one users are
    // most likely to be missing.
    const dart = result.languages.find((l) => l.language === "dart");
    expect(dart).toBeTruthy();
    expect(typeof dart?.compilesFromSource).toBe("boolean");
    if (result.platform !== "linux-x64") {
      expect(dart?.compilesFromSource).toBe(true);
    }
  });

  // XSPEC-457 R3: the list used to be fixed. It now follows where the ALGO
  // extension actually comes from on the machine, so each arm is driven by an
  // injected description of a machine rather than by whichever one runs the suite.
  // The entry-level proof (the built CLI, a real package on disk) is in
  // test/doctor-network.test.ts.
  it("names the commands that need network only when the extension would be downloaded", () => {
    const download = cmdDoctor("/x/graph.db", {
      platform: "win32", arch: "x64", home: "/home/none",
      bundled: { pkg: "@asiaostrich/engramgraph-algo-win32-x64", path: null }, exists: () => false,
    });
    expect(download.networkCommands).toEqual(["god-nodes", "communities", "related"]);
    expect(download.networkStatus).toBe("needed");
    expect(download.algo.source).toBe("download");
  });

  it("names no command when the platform package is installed", () => {
    const bundled = cmdDoctor("/x/graph.db", {
      platform: "win32", arch: "x64",
      bundled: { pkg: "@asiaostrich/engramgraph-algo-win32-x64", path: "C:/n/libalgo.ryu_extension" },
    });
    expect(bundled.networkCommands).toEqual([]);
    expect(bundled.networkStatus).toBe("none");
    expect(bundled.algo).toMatchObject({ source: "bundled-package", path: "C:/n/libalgo.ryu_extension" });
  });

  it("names no command when ryugraph's own cache already holds the extension", () => {
    const cached = cmdDoctor("/x/graph.db", {
      platform: "linux", arch: "x64", home: "/home/u",
      bundled: { pkg: "@asiaostrich/engramgraph-algo-linux-x64", path: null },
      exists: (p) => p === "/home/u/.ryu/extension/25.9.0/linux_amd64/algo/libalgo.ryu_extension",
    });
    expect(cached.networkCommands).toEqual([]);
    expect(cached.algo.source).toBe("user-cache");
  });

  it("says it cannot tell, instead of guessing, on a platform whose cache directory is unknown", () => {
    const unknown = cmdDoctor("/x/graph.db", {
      platform: "linux", arch: "arm64", bundled: { pkg: null, path: null }, exists: () => true,
    });
    expect(unknown.networkStatus).toBe("undetermined");
    expect(unknown.algo.source).toBe("undetermined");
    expect(unknown.algo.detail).toMatch(/cannot be determined/);
  });

  it("does not need a readable graph to answer", () => {
    // Someone runs `doctor` precisely when things are broken; requiring a
    // working graph would make it useless in the case it exists for.
    expect(() => cmdDoctor("/definitely/not/a/real/path/graph.db")).not.toThrow();
  });
});

describe("egr doctor, invoked the way a user invokes it", () => {
  it("has a built CLI to run", () => {
    expect(
      existsSync(CLI),
      "dist/cli/index.js missing — run `npm run build`. Skipping would recreate " +
        "exactly the gap this file exists to close.",
    ).toBe(true);
  });

  it("prints the language table on stdout with no special flags", () => {
    const out = runDoctor();
    expect(out).toContain("languages:");
    // A language name a reader would look for, rendered rather than JSON.
    expect(out).toMatch(/C#/);
    expect(out).toMatch(/Dart/);
  });

  it("tells the reader whether anything needs network, in a `needs network:` line", () => {
    // What the line says depends on the machine (XSPEC-457 R3) — test/doctor-network.test.ts
    // pins that to the files actually on disk. Here: the line exists and is not the old fixed list unconditionally.
    expect(runDoctor()).toMatch(/needs network: (none —|god-nodes, communities, related —|cannot be determined —)/);
  });

  it("carries the MCP registration command", () => {
    // This is the line that used to live in a postinstall hook nobody saw.
    expect(runDoctor()).toContain("claude mcp add egr -- npx egr-mcp");
  });

  it("emits machine-readable output with --json", () => {
    const parsed = JSON.parse(runDoctor(["--json"])) as { languages: unknown[] };
    expect(Array.isArray(parsed.languages)).toBe(true);
    expect(parsed.languages).toHaveLength(GRAMMARS.length);
  });
});

describe("egr --help carries what the install hooks could not", () => {
  it("names the MCP registration command", () => {
    const out = execFileSync(process.execPath, [CLI, "--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(out).toContain("claude mcp add egr -- npx egr-mcp");
    expect(out).toContain("doctor");
  });
});
