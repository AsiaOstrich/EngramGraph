import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * What actually ends up in the published tarball. // implements XSPEC-365 AC-11
 *
 * The install hooks and the language registry are useless if they are not
 * shipped, and `package.json`'s `files` field being correct is not evidence
 * that they were: a typo, a `.npmignore`, or a path that only resolves in the
 * working tree all produce a `files` list that reads perfectly while the
 * tarball goes out without the file. From inside the repo those two situations
 * are indistinguishable — every local test passes either way, because locally
 * the file is right there.
 *
 * So this asks npm what it would actually pack, rather than asking the config
 * what it intends to.
 */

const ROOT = join(__dirname, "..");

interface PackEntry {
  path: string;
}
interface PackResult {
  files: PackEntry[];
}

function packedFiles(): string[] {
  // `prepare` (tsup) writes build progress to stdout and would corrupt the
  // JSON, so scripts are suppressed two ways. Both are needed:
  //
  //   - The CLI flag alone worked when this test was run directly and silently
  //     stopped working under `npm test`, because the outer npm exports its
  //     own `npm_config_*` into the child environment and the inherited value
  //     won. The failure was loud here (invalid JSON), but the same
  //     environment-dependent behaviour is exactly how a check ends up
  //     measuring something different from what it measured when it was
  //     written.
  //   - The explicit env var pins it regardless of what the parent exported.
  //
  // Suppressing scripts does not change which files npm reports — that comes
  // from `files` plus what is on disk.
  const stdout = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, npm_config_ignore_scripts: "true" },
    },
  );

  // Belt and braces: if anything still prints ahead of the payload, find the
  // JSON rather than failing on the first stray character. A parse error here
  // would read like a packaging regression when it is only noise on stdout.
  const start = stdout.indexOf("[");
  if (start === -1) {
    throw new Error(
      `npm pack --json produced no JSON array; this check cannot run. Output was: ${stdout.slice(0, 200)}`,
    );
  }
  const parsed = JSON.parse(stdout.slice(start)) as PackResult[];
  const first = parsed[0];
  if (!first || !Array.isArray(first.files)) {
    throw new Error(
      "npm pack --json did not return the expected shape; this check cannot run",
    );
  }
  return first.files.map((f) => f.path);
}

describe("the published tarball contains what the install hooks need", () => {
  const files = packedFiles();

  it("returned a plausible file list at all", () => {
    // Guard the query before trusting its result: an empty or tiny list means
    // the pack itself misbehaved, and every assertion below would then be
    // failing for the wrong reason — or, worse, a future refactor could make
    // this return [] and the `toContain` checks would fail in a way that reads
    // like a packaging regression.
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.startsWith("dist/"))).toBe(true);
  });

  for (const required of [
    // Runs before dependencies are installed — cannot come from dist/.
    "preinstall.js",
    // Runs after install to explain MCP registration.
    "postinstall.js",
    // Read by preinstall.js at install time. Bundled into dist/ as well, but
    // dist/ does not exist yet when preinstall runs, so the root copy ships.
    "language-support.js",
  ]) {
    it(`ships ${required}`, () => {
      expect(files).toContain(required);
    });
  }

  it("does not ship the dev-only type declarations", () => {
    // Nothing consumes these outside this repo — `dist/index.d.ts` inlines the
    // types. Shipping them is harmless but signals they are part of the public
    // surface, which they are not.
    expect(files).not.toContain("language-support.d.ts");
    expect(files).not.toContain("preinstall.d.ts");
    expect(files).not.toContain("postinstall.d.ts");
  });
});
