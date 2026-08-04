import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * The paths inside the tarball npm would publish, with the leading `package/`
 * stripped.
 *
 * **Why this builds a real tarball instead of reading `npm pack --json`.** The
 * JSON route was tried twice and broke twice, each time in an environment it
 * had not been run in before: once under `npm test` (the outer npm exports
 * `npm_config_*`, and the inherited value beat the `--ignore-scripts` flag, so
 * `prepare` ran and printed build progress onto stdout), and once in CI, where
 * trailing output after the JSON array defeated a "find the array and slice"
 * workaround. Both times the check reported a packaging problem when packaging
 * was fine.
 *
 * The lesson is the one this file is about: a measurement whose result depends
 * on incidental properties of how it was invoked is not measuring the thing it
 * claims to. So this stops parsing a text stream that other tools are entitled
 * to write to, and inspects the artifact instead — which is also what the
 * requirement actually asks for.
 */
function packedFiles(): string[] {
  const dir = mkdtempSync(join(tmpdir(), "egr-pack-"));
  try {
    execFileSync("npm", ["pack", "--pack-destination", dir, "--ignore-scripts"], {
      cwd: ROOT,
      // stdout is deliberately ignored — nothing here reads it, so nothing here
      // can be broken by what npm or a lifecycle script decides to print.
      stdio: "ignore",
      env: { ...process.env, npm_config_ignore_scripts: "true" },
    });

    const tarball = readdirSync(dir).find((f) => f.endsWith(".tgz"));
    if (!tarball) {
      throw new Error(
        `npm pack produced no tarball in ${dir}; this check cannot run`,
      );
    }

    const listing = execFileSync("tar", ["-tzf", join(dir, tarball)], {
      encoding: "utf8",
    });
    return listing
      .split("\n")
      .filter(Boolean)
      // npm wraps everything in a top-level `package/` directory.
      .map((entry) => entry.replace(/^package\//, ""))
      // Directory entries end in a slash on some tar implementations.
      .filter((entry) => entry !== "" && !entry.endsWith("/"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
