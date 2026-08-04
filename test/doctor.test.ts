import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { cmdDoctor } from "../src/cli/run.js";
import { GRAMMARS } from "../language-support.js";

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

  it("names the commands that need network, and nothing else", () => {
    expect(result.networkCommands).toEqual(["god-nodes", "communities", "related"]);
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

  it("tells the reader which commands need network", () => {
    expect(runDoctor()).toContain("needs network: god-nodes, communities, related");
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
